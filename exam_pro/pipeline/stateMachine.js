// ─────────────────────────────────────────────────────────────
// pipeline/stateMachine.js — job_questions 的推進規則（A-T2，擁有者：WS-A）
//
// 介面凍結於 docs/interfaces-stage2.md 第 2 條：
//   transition({ state, retries, outcome, limits }) → { state, retries, review_reason }
//
// 三個不可打破的約束（單元測試會逐條斷言）：
//   1. **純函式**：無 I/O、無時間、無隨機。同樣的輸入永遠得到同樣的輸出，
//      因此 `node --test` 可以窮舉 (state × outcome.kind × retries)。
//   2. **不就地修改入參**：回傳的 `retries` 一律是新物件，呼叫端手上那份不會被動到。
//      runner 會把舊 retries 留著寫 job_events，被改掉就對不上帳。
//   3. **全函式**：任何 `reason`／`errorClass`（含沒見過的字串）都對應得到一個
//      DDL CHECK 允許的 `review_reason`，狀態機本身不會讓 UPDATE 炸掉。
//
// 不屬於這裡的事（都是 runner 的責任）：退避的睡眠、payload 的寫入、job_events、
// 預算的實際扣減、feedback 塞回 payload[node].feedback。
// ─────────────────────────────────────────────────────────────

/** 每個非終態恰好對應一個節點：這一格要跑哪一支 agent。 */
const NODE_FOR_STATE = Object.freeze({
    extracted: 'dedup0',
    hashed: 'classify',
    classified: 'lint',
    linted: 'verify',
    verified: 'dedup1',
    deduped: 'save'
});

/** pass / skipped 時前進到的下一個狀態。 */
const NEXT_STATE = Object.freeze({
    extracted: 'hashed',
    hashed: 'classified',
    classified: 'linted',
    linted: 'verified',
    verified: 'deduped',
    deduped: 'saved'
});

/** 三個終態：runner 不認領這些列，transition() 收到它們一律丟錯。 */
const TERMINAL_STATES = Object.freeze(['saved', 'needs_review', 'rejected']);

/**
 * limits 的預設值（docs/interfaces-stage2.md 第 2.2 條）。
 * maxRetries 沒列到的節點 = 0，也就是「不重試，失敗直接進複核」。
 */
const DEFAULT_LIMITS = Object.freeze({
    maxRetries: Object.freeze({ classify: 2, lint: 2, verify: 1 }),
    maxErrorRetries: 3,
    budgetLeft: Infinity
});

/** outcome.kind 的四個合法值。 */
const OUTCOME_KINDS = Object.freeze(['pass', 'skipped', 'fail', 'error']);

/**
 * fail 的 reason → review_reason。查不到一律落到 awaiting_approval，
 * 保證本函式是全函式（新節點回了新 reason 也不會讓 DDL 的 CHECK 炸掉）。
 * @param {string} reason
 * @returns {string} DDL 允許的八個 review_reason 之一
 */
function REVIEW_REASON_FOR_FAIL(reason) {
    const known = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch',
        'duplicate', 'schema_invalid', 'budget_exceeded', 'provider_error'];
    return known.includes(reason) ? reason : 'awaiting_approval';
}

/**
 * error 的 errorClass → review_reason。
 * 三種「供應商那邊的問題」收斂成同一個 provider_error，其餘沿用 fail 的對照表。
 * @param {string} errorClass
 * @returns {string}
 */
function REVIEW_REASON_FOR_ERROR(errorClass) {
    if (['rate_limited', 'timeout', 'provider_error'].includes(errorClass)) return 'provider_error';
    return REVIEW_REASON_FOR_FAIL(errorClass);
}

/** 進複核的統一出口：retries 原樣複製一份，state 換成終態。 */
function toReview(retries, reason) {
    return { state: 'needs_review', retries: { ...retries }, review_reason: reason };
}

/**
 * 依 (目前狀態, 節點回傳的 outcome, 已重試次數, 上限) 算出下一個狀態。
 *
 * @param {object}  args
 * @param {string}  args.state    job_questions.state；必須是六個可推進狀態之一
 * @param {object} [args.retries] {classify:1, 'classify:error':2, …}；未給視為 {}
 * @param {object}  args.outcome  {kind:'pass'|'skipped'|'fail'|'error', …}（第 2.2 條）
 * @param {object} [args.limits]  {maxRetries, maxErrorRetries, budgetLeft}；缺的欄位用 DEFAULT_LIMITS 補
 * @returns {{state:string, retries:object, review_reason:string|null}}
 *          review_reason 在不進 needs_review 時一律是 null（不是 undefined）
 * @throws  {Error} state 不可推進、或 outcome.kind 不是四種之一（兩者都是程式錯誤，不是資料狀態）
 */
function transition({ state, retries, outcome, limits } = {}) {
    // 規則 1：終態與未知狀態都不可推進。runner 的認領 SQL 只撈可推進的列，
    // 走到這裡代表呼叫端有 bug，寧可大聲丟錯也不要默默把資料改壞。
    if (!Object.prototype.hasOwnProperty.call(NODE_FOR_STATE, state)) {
        throw new Error(`transition：狀態 ${state} 不可推進`);
    }

    // 規則 2：outcome 形狀不對。agent 合約要求「不得 throw、只回四種形狀」，
    // 回了別的就是 agent 的 bug，同樣不吞。
    const kind = outcome === null || outcome === undefined ? undefined : outcome.kind;
    if (!OUTCOME_KINDS.includes(kind)) {
        throw new Error(`transition：未知的 outcome.kind ${kind}`);
    }

    const node = NODE_FOR_STATE[state];
    const prev = retries ?? {};
    const lim = limits ?? {};
    const maxRetries = lim.maxRetries ?? DEFAULT_LIMITS.maxRetries;
    const maxErrorRetries = lim.maxErrorRetries ?? DEFAULT_LIMITS.maxErrorRetries;
    const budgetLeft = lim.budgetLeft ?? DEFAULT_LIMITS.budgetLeft;

    // 規則 3：預算已用盡。pass／skipped 照常前進——那次呼叫的錢已經花掉了，
    // 把成果丟掉只是白花；其餘一律直接進複核，不再重試（重試就是再花一次錢）。
    if (budgetLeft <= 0 && kind !== 'pass' && kind !== 'skipped') {
        return toReview(prev, 'budget_exceeded');
    }

    // 規則 4：通過或跳過 → 前進一格。
    if (kind === 'pass' || kind === 'skipped') {
        return { state: NEXT_STATE[state], retries: { ...prev }, review_reason: null };
    }

    // 規則 5：閘門判定失敗 → 依節點的重試上限決定「原地重跑」還是「進複核」。
    if (kind === 'fail') {
        if (outcome.reason === 'budget_exceeded') return toReview(prev, 'budget_exceeded');

        const max = maxRetries[node] ?? 0;
        const used = prev[node] ?? 0;
        if (used < max) {
            return { state, retries: { ...prev, [node]: used + 1 }, review_reason: null };
        }
        return toReview(prev, REVIEW_REASON_FOR_FAIL(outcome.reason));
    }

    // 規則 6：供應商錯誤 → 另一組計數器（`<node>:error`），退避的睡眠由 runner 做。
    if (outcome.errorClass === 'budget_exceeded') return toReview(prev, 'budget_exceeded');

    const key = `${node}:error`;
    const usedError = prev[key] ?? 0;
    if (usedError < maxErrorRetries) {
        return { state, retries: { ...prev, [key]: usedError + 1 }, review_reason: null };
    }
    return toReview(prev, REVIEW_REASON_FOR_ERROR(outcome.errorClass));
}

module.exports = {
    transition,
    NODE_FOR_STATE,
    NEXT_STATE,
    TERMINAL_STATES,
    DEFAULT_LIMITS,
    OUTCOME_KINDS,
    REVIEW_REASON_FOR_FAIL,
    REVIEW_REASON_FOR_ERROR
};
