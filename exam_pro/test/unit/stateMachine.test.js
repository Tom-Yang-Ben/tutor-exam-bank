// ─────────────────────────────────────────────────────────────
// stateMachine.test.js — A-T2 的窮舉表 + 性質測試（擁有者：WS-A）
//
// 對照 docs/interfaces-stage2.md 第 2 條。三個層次：
//   1. **表格窮舉**：(state × outcome.kind × retries) 逐格斷言，含每個節點重試上限的邊界。
//   2. **對照表窮舉**：DDL CHECK 的八個 review_reason 與九個 error_class 全部走一遍，
//      再加「沒見過的字串」證明 transition() 是全函式。
//   3. **性質測試**：對整個可達狀態空間做 DFS，證明
//        (a) 任何 outcome 序列都在 Σ maxRetries + Σ maxErrorRetries + 6 = 29 步內達終態；
//        (b) 不存在迴圈——state 只會前進，留在原地時必定有某個 retries 計數 +1。
//
// 本檔不連 DB、不連 Gemini、不讀 process.env：狀態機是純函式，這是它存在的理由。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    transition, NODE_FOR_STATE, NEXT_STATE, TERMINAL_STATES, DEFAULT_LIMITS,
    OUTCOME_KINDS, REVIEW_REASON_FOR_FAIL, REVIEW_REASON_FOR_ERROR
} = require('../../pipeline/stateMachine');

// 六個可推進狀態的推進順序（= NEXT_STATE 串起來的鏈）
const ORDER = ['extracted', 'hashed', 'classified', 'linted', 'verified', 'deduped'];

// 手寫一份「狀態 → 該節點重試上限」的對照，刻意不從 DEFAULT_LIMITS 反推：
// 這份表就是介面第 2.2 條的內容，抄錯了測試就該紅。
const MAX_RETRIES_BY_STATE = {
    extracted: 0,   // dedup0：純雜湊，不重試
    hashed: 2,      // classify
    classified: 2,  // lint
    linted: 1,      // verify
    verified: 0,    // dedup1：純向量比對
    deduped: 0      // save：入庫失敗直接進複核
};
const MAX_ERROR_RETRIES = 3;

const LIMITS = { maxRetries: DEFAULT_LIMITS.maxRetries, maxErrorRetries: MAX_ERROR_RETRIES, budgetLeft: 1 };

describe('狀態機 — 表與常數本身', () => {
    test('NODE_FOR_STATE 與 NEXT_STATE 的鍵完全一致，且都是六個可推進狀態', () => {
        assert.deepEqual(Object.keys(NODE_FOR_STATE), ORDER);
        assert.deepEqual(Object.keys(NEXT_STATE), ORDER);
    });

    test('六個節點名逐字凍結', () => {
        assert.deepEqual({ ...NODE_FOR_STATE }, {
            extracted: 'dedup0', hashed: 'classify', classified: 'lint',
            linted: 'verify', verified: 'dedup1', deduped: 'save'
        });
    });

    test('從 extracted 一路 pass 六步就到 saved，中間不重複造訪', () => {
        const seen = [];
        let state = 'extracted';
        for (let i = 0; i < 6; i++) {
            seen.push(state);
            state = transition({ state, retries: {}, outcome: { kind: 'pass', data: {} }, limits: LIMITS }).state;
        }
        assert.deepEqual(seen, ORDER);
        assert.equal(state, 'saved');
        assert.equal(new Set(seen).size, 6);
    });

    test('三個終態的字串與順序凍結', () => {
        assert.deepEqual([...TERMINAL_STATES], ['saved', 'needs_review', 'rejected']);
    });

    test('DEFAULT_LIMITS 的值凍結，且 maxRetries 只列三個節點', () => {
        assert.deepEqual({ ...DEFAULT_LIMITS.maxRetries }, { classify: 2, lint: 2, verify: 1 });
        assert.equal(DEFAULT_LIMITS.maxErrorRetries, 3);
        assert.equal(DEFAULT_LIMITS.budgetLeft, Infinity);
    });

    test('OUTCOME_KINDS 就是四種', () => {
        assert.deepEqual([...OUTCOME_KINDS], ['pass', 'skipped', 'fail', 'error']);
    });
});

describe('狀態機 — 不可推進的輸入一律丟錯', () => {
    for (const state of ['saved', 'needs_review', 'rejected']) {
        test(`終態 ${state} 丟錯（runner 不會認領終態的列，走到這裡就是程式錯誤）`, () => {
            assert.throws(
                () => transition({ state, retries: {}, outcome: { kind: 'pass' }, limits: LIMITS }),
                new Error(`transition：狀態 ${state} 不可推進`)
            );
        });
    }

    test('沒見過的狀態字串丟錯', () => {
        assert.throws(() => transition({ state: 'flying', retries: {}, outcome: { kind: 'pass' }, limits: LIMITS }),
            new Error('transition：狀態 flying 不可推進'));
    });

    test('完全不給參數也是丟「狀態 undefined 不可推進」，不是 TypeError', () => {
        assert.throws(() => transition(), new Error('transition：狀態 undefined 不可推進'));
    });

    test('繼承自 Object.prototype 的鍵不算合法狀態（用 hasOwnProperty 而非 in）', () => {
        assert.throws(() => transition({ state: 'toString', retries: {}, outcome: { kind: 'pass' }, limits: LIMITS }),
            new Error('transition：狀態 toString 不可推進'));
    });
});

describe('狀態機 — outcome.kind 不合法一律丟錯', () => {
    for (const bad of ['ok', 'PASS', '', 'failed']) {
        test(`kind「${bad}」丟錯`, () => {
            assert.throws(() => transition({ state: 'hashed', retries: {}, outcome: { kind: bad }, limits: LIMITS }),
                new Error(`transition：未知的 outcome.kind ${bad}`));
        });
    }

    test('outcome 為 null', () => {
        assert.throws(() => transition({ state: 'hashed', retries: {}, outcome: null, limits: LIMITS }),
            new Error('transition：未知的 outcome.kind undefined'));
    });

    test('outcome 為 undefined', () => {
        assert.throws(() => transition({ state: 'hashed', retries: {}, outcome: undefined, limits: LIMITS }),
            new Error('transition：未知的 outcome.kind undefined'));
    });

    test('outcome 是空物件（沒有 kind）', () => {
        assert.throws(() => transition({ state: 'hashed', retries: {}, outcome: {}, limits: LIMITS }),
            new Error('transition：未知的 outcome.kind undefined'));
    });

    test('狀態不合法時「先」丟狀態的錯（規則依序判斷）', () => {
        assert.throws(() => transition({ state: 'saved', retries: {}, outcome: { kind: 'nope' }, limits: LIMITS }),
            new Error('transition：狀態 saved 不可推進'));
    });
});

describe('狀態機 — pass / skipped 逐格窮舉', () => {
    for (const state of ORDER) {
        for (const kind of ['pass', 'skipped']) {
            test(`${state} + ${kind} → ${NEXT_STATE[state]}，retries 原樣、review_reason 為 null`, () => {
                const retries = { classify: 1, 'lint:error': 2 };
                const r = transition({ state, retries, outcome: { kind, data: { x: 1 } }, limits: LIMITS });
                assert.equal(r.state, NEXT_STATE[state]);
                assert.deepEqual(r.retries, { classify: 1, 'lint:error': 2 });
                assert.equal(r.review_reason, null);
            });
        }
    }

    test('預算用盡時 pass 照樣前進（那次呼叫的錢已經花掉了）', () => {
        const r = transition({
            state: 'hashed', retries: {}, outcome: { kind: 'pass', data: {} },
            limits: { ...LIMITS, budgetLeft: 0 }
        });
        assert.equal(r.state, 'classified');
        assert.equal(r.review_reason, null);
    });

    test('預算用盡時 skipped 也照樣前進', () => {
        const r = transition({
            state: 'linted', retries: {}, outcome: { kind: 'skipped' },
            limits: { ...LIMITS, budgetLeft: -0.5 }
        });
        assert.equal(r.state, 'verified');
        assert.equal(r.review_reason, null);
    });
});

describe('狀態機 — fail 的重試上限逐格窮舉', () => {
    for (const state of ORDER) {
        const node = NODE_FOR_STATE[state];
        const max = MAX_RETRIES_BY_STATE[state];

        for (let used = 0; used <= max + 1; used++) {
            const shouldRetry = used < max;
            test(`${state}（${node}）retries=${used}／上限 ${max} → ${shouldRetry ? '原地重試' : '進複核'}`, () => {
                // used=0 時刻意不放該節點的鍵，走 `prev[node] ?? 0` 的 undefined 分支
                const retries = used === 0 ? { 其他節點: 9 } : { 其他節點: 9, [node]: used };
                const r = transition({
                    state, retries,
                    outcome: { kind: 'fail', reason: 'answer_mismatch', feedback: '不一致' },
                    limits: LIMITS
                });
                if (shouldRetry) {
                    assert.equal(r.state, state, '沒用完重試就留在原狀態');
                    assert.equal(r.retries[node], used + 1);
                    assert.equal(r.review_reason, null);
                } else {
                    assert.equal(r.state, 'needs_review');
                    assert.deepEqual(r.retries, retries, '進複核時 retries 不再累加');
                    assert.equal(r.review_reason, 'answer_mismatch');
                }
                assert.equal(r.retries['其他節點'], 9, '別的節點的計數不受影響');
            });
        }
    }

    test('fail 帶 budget_exceeded → 直接進複核，不吃重試額度', () => {
        const r = transition({
            state: 'hashed', retries: {}, outcome: { kind: 'fail', reason: 'budget_exceeded' }, limits: LIMITS
        });
        assert.deepEqual(r, { state: 'needs_review', retries: {}, review_reason: 'budget_exceeded' });
    });

    test('預算已用盡時的 fail → budget_exceeded，蓋過原本的 reason', () => {
        const r = transition({
            state: 'hashed', retries: { classify: 0 }, outcome: { kind: 'fail', reason: 'chapter_invalid' },
            limits: { ...LIMITS, budgetLeft: 0 }
        });
        assert.equal(r.state, 'needs_review');
        assert.equal(r.review_reason, 'budget_exceeded');
    });

    test('budgetLeft 為負數同樣算用盡', () => {
        const r = transition({
            state: 'classified', retries: {}, outcome: { kind: 'error', errorClass: 'timeout' },
            limits: { ...LIMITS, budgetLeft: -1e-9 }
        });
        assert.equal(r.review_reason, 'budget_exceeded');
    });
});

describe('狀態機 — error 的退避計數逐格窮舉', () => {
    for (const state of ORDER) {
        const key = `${NODE_FOR_STATE[state]}:error`;

        for (let used = 0; used <= MAX_ERROR_RETRIES + 1; used++) {
            const shouldRetry = used < MAX_ERROR_RETRIES;
            test(`${state} ${key}=${used}／上限 ${MAX_ERROR_RETRIES} → ${shouldRetry ? '退避重試' : 'provider_error'}`, () => {
                const retries = used === 0 ? {} : { [key]: used };
                const r = transition({
                    state, retries, outcome: { kind: 'error', errorClass: 'rate_limited', message: '429' }, limits: LIMITS
                });
                if (shouldRetry) {
                    assert.equal(r.state, state);
                    assert.equal(r.retries[key], used + 1);
                    assert.equal(r.review_reason, null);
                } else {
                    assert.equal(r.state, 'needs_review');
                    assert.equal(r.review_reason, 'provider_error');
                }
            });
        }
    }

    test('error 與 fail 是兩組獨立計數器', () => {
        const r = transition({
            state: 'hashed', retries: { classify: 2 }, outcome: { kind: 'error', errorClass: 'timeout' }, limits: LIMITS
        });
        assert.equal(r.state, 'hashed', 'fail 額度用完不影響 error 的退避');
        assert.deepEqual(r.retries, { classify: 2, 'classify:error': 1 });
    });

    test('error 帶 budget_exceeded → 直接進複核，不退避', () => {
        const r = transition({
            state: 'linted', retries: {}, outcome: { kind: 'error', errorClass: 'budget_exceeded' }, limits: LIMITS
        });
        assert.deepEqual(r, { state: 'needs_review', retries: {}, review_reason: 'budget_exceeded' });
    });
});

describe('狀態機 — review_reason 對照表是全函式', () => {
    // DDL（0003_jobs.sql）允許的八個值，逐字對照
    const DDL_REVIEW_REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch',
        'duplicate', 'budget_exceeded', 'provider_error', 'schema_invalid', 'awaiting_approval'];

    for (const reason of ['chapter_invalid', 'formula_unparsable', 'answer_mismatch',
        'duplicate', 'schema_invalid', 'budget_exceeded', 'provider_error']) {
        test(`REVIEW_REASON_FOR_FAIL('${reason}') 原樣回傳`, () => {
            assert.equal(REVIEW_REASON_FOR_FAIL(reason), reason);
        });
    }

    for (const weird of ['merge_needed', '', undefined, null, 'AWAITING_APPROVAL', 'rate_limited', 'timeout']) {
        test(`REVIEW_REASON_FOR_FAIL(${JSON.stringify(weird)}) → awaiting_approval`, () => {
            assert.equal(REVIEW_REASON_FOR_FAIL(weird), 'awaiting_approval');
        });
    }

    // job_events.error_class 的九個值（DDL CHECK）全部要對應得到合法的 review_reason
    const ERROR_CLASS_TO_REVIEW = {
        schema_invalid: 'schema_invalid',
        chapter_invalid: 'chapter_invalid',
        formula_unparsable: 'formula_unparsable',
        answer_mismatch: 'answer_mismatch',
        duplicate: 'duplicate',
        provider_error: 'provider_error',
        rate_limited: 'provider_error',
        timeout: 'provider_error',
        budget_exceeded: 'budget_exceeded'
    };
    for (const [errorClass, expected] of Object.entries(ERROR_CLASS_TO_REVIEW)) {
        test(`REVIEW_REASON_FOR_ERROR('${errorClass}') → ${expected}`, () => {
            assert.equal(REVIEW_REASON_FOR_ERROR(errorClass), expected);
            assert.ok(DDL_REVIEW_REASONS.includes(REVIEW_REASON_FOR_ERROR(errorClass)));
        });
    }

    test('沒見過的 errorClass → awaiting_approval（DDL 的 CHECK 不會炸）', () => {
        assert.equal(REVIEW_REASON_FOR_ERROR('quota_of_the_moon'), 'awaiting_approval');
    });

    test('任何 reason／errorClass 走完 transition() 都落在 DDL 的八個值內', () => {
        const inputs = [...DDL_REVIEW_REASONS, ...Object.keys(ERROR_CLASS_TO_REVIEW), 'x', '', '中文原因'];
        for (const s of inputs) {
            for (const state of ORDER) {
                const failed = transition({
                    state, retries: { [NODE_FOR_STATE[state]]: 99 },
                    outcome: { kind: 'fail', reason: s }, limits: LIMITS
                });
                if (failed.state === 'needs_review') {
                    assert.ok(DDL_REVIEW_REASONS.includes(failed.review_reason), `fail(${s}) → ${failed.review_reason}`);
                }
                const errored = transition({
                    state, retries: { [`${NODE_FOR_STATE[state]}:error`]: 99 },
                    outcome: { kind: 'error', errorClass: s }, limits: LIMITS
                });
                if (errored.state === 'needs_review') {
                    assert.ok(DDL_REVIEW_REASONS.includes(errored.review_reason), `error(${s}) → ${errored.review_reason}`);
                }
            }
        }
    });
});

describe('狀態機 — 純函式契約', () => {
    test('回傳的 retries 一律是新物件，入參不被就地修改', () => {
        for (const outcome of [
            { kind: 'pass', data: {} }, { kind: 'skipped' },
            { kind: 'fail', reason: 'chapter_invalid' }, { kind: 'error', errorClass: 'timeout' },
            { kind: 'fail', reason: 'budget_exceeded' }, { kind: 'error', errorClass: 'budget_exceeded' }
        ]) {
            const retries = { classify: 1 };
            const snapshot = JSON.stringify(retries);
            const r = transition({ state: 'hashed', retries, outcome, limits: LIMITS });
            assert.notEqual(r.retries, retries, `${outcome.kind} 必須回新物件`);
            assert.equal(JSON.stringify(retries), snapshot, `${outcome.kind} 不得就地修改入參`);
        }
    });

    test('同樣的輸入呼叫兩次得到相同結果（無時間、無隨機）', () => {
        const args = {
            state: 'classified', retries: { lint: 1 },
            outcome: { kind: 'fail', reason: 'formula_unparsable' }, limits: LIMITS
        };
        assert.deepEqual(transition(args), transition(args));
    });

    test('review_reason 在不進複核時是 null，不是 undefined', () => {
        for (const outcome of [{ kind: 'pass', data: {} }, { kind: 'skipped' },
        { kind: 'fail', reason: 'x' }, { kind: 'error', errorClass: 'timeout' }]) {
            const r = transition({ state: 'hashed', retries: {}, outcome, limits: LIMITS });
            if (r.state !== 'needs_review') {
                assert.equal(r.review_reason, null);
                assert.ok('review_reason' in r);
            }
        }
    });

    test('limits 省略時用 DEFAULT_LIMITS（budgetLeft 為 Infinity，不會誤判成用盡）', () => {
        const r = transition({ state: 'hashed', outcome: { kind: 'fail', reason: 'chapter_invalid' } });
        assert.deepEqual(r, { state: 'hashed', retries: { classify: 1 }, review_reason: null });
    });

    test('limits 給了但缺欄位時逐欄回填預設', () => {
        const onlyBudget = transition({
            state: 'hashed', retries: {}, outcome: { kind: 'error', errorClass: 'timeout' }, limits: { budgetLeft: 5 }
        });
        assert.deepEqual(onlyBudget.retries, { 'classify:error': 1 }, 'maxErrorRetries 用預設 3');

        const onlyMax = transition({
            state: 'hashed', retries: { classify: 2 }, outcome: { kind: 'fail', reason: 'chapter_invalid' },
            limits: { maxRetries: { classify: 2 } }
        });
        assert.equal(onlyMax.state, 'needs_review', 'budgetLeft 用預設 Infinity，不該被當成用盡');
    });

    test('maxRetries 傳空物件 → 所有節點都不重試', () => {
        const r = transition({
            state: 'hashed', retries: {}, outcome: { kind: 'fail', reason: 'chapter_invalid' },
            limits: { maxRetries: {}, maxErrorRetries: 3, budgetLeft: 1 }
        });
        assert.equal(r.state, 'needs_review');
        assert.equal(r.review_reason, 'chapter_invalid');
    });

    test('retries 省略時視為 {}', () => {
        const r = transition({ state: 'hashed', outcome: { kind: 'error', errorClass: 'provider_error' }, limits: LIMITS });
        assert.deepEqual(r.retries, { 'classify:error': 1 });
    });
});

// ─────────────────────────────────────────────────────────────
// 性質測試：對整個可達狀態空間做 DFS。
// 六種代表性 outcome 就足以涵蓋所有「會改變 (state, retries)」的分支——
// 具體的 reason／errorClass 只影響 review_reason 的字串，不影響推進與計數。
// ─────────────────────────────────────────────────────────────
const OUTCOME_VARIANTS = [
    { kind: 'pass', data: {} },
    { kind: 'skipped' },
    { kind: 'fail', reason: 'chapter_invalid' },
    { kind: 'fail', reason: 'budget_exceeded' },
    { kind: 'error', errorClass: 'rate_limited' },
    { kind: 'error', errorClass: 'budget_exceeded' }
];

const SUM_MAX_RETRIES = Object.values(MAX_RETRIES_BY_STATE).reduce((a, b) => a + b, 0);   // 0+2+2+1+0+0 = 5
const SUM_MAX_ERROR_RETRIES = ORDER.length * MAX_ERROR_RETRIES;                          // 6 × 3 = 18
const STEP_BOUND = SUM_MAX_RETRIES + SUM_MAX_ERROR_RETRIES + ORDER.length;               // = 29

/** 把 (state, retries) 壓成一個可比較的鍵；retries 的鍵排序後才穩定。用於路徑上的迴圈偵測。 */
function stateKey(state, retries) {
    const entries = Object.entries(retries).filter(([, v]) => v > 0).sort(([a], [b]) => (a < b ? -1 : 1));
    return `${state}|${JSON.stringify(entries)}`;
}

/**
 * memo 的鍵只取「目前節點」的兩個計數器：transition() 只讀 NODE_FOR_STATE[state]
 * 對應的那兩個鍵，已走過的節點計數對後續完全沒有影響（上面「別的節點的計數不受影響」
 * 那幾格就是在釘這件事）。少了這一層，可達組態是六個節點計數的笛卡兒積（約 15 萬），
 * DFS 會慢上兩個數量級。
 */
function memoKey(state, retries) {
    const node = NODE_FOR_STATE[state];
    return `${state}|${retries[node] ?? 0}|${retries[`${node}:error`] ?? 0}`;
}

const sumRetries = (r) => Object.values(r).reduce((a, b) => a + b, 0);

describe('狀態機 — 性質：會停、不迴圈', () => {
    test(`任何 outcome 序列都在 ${STEP_BOUND} 步（Σ maxRetries ${SUM_MAX_RETRIES} + Σ maxErrorRetries ${SUM_MAX_ERROR_RETRIES} + 6）內達終態`, () => {
        // 對「所有可能的 outcome 序列」做 DFS，memo 存「從這個組態出發最多還要幾步」。
        const memo = new Map();
        const path = new Set();
        let visited = 0;

        function longestToTerminal(state, retries) {
            if (TERMINAL_STATES.includes(state)) return 0;
            const k = stateKey(state, retries);
            // 同一條路徑上重複出現同一組態 = 迴圈，狀態機保證不會發生
            assert.equal(path.has(k), false, `偵測到迴圈：${k}`);
            const mk = memoKey(state, retries);
            if (memo.has(mk)) return memo.get(mk);

            path.add(k);
            visited++;
            let worst = 0;
            for (const outcome of OUTCOME_VARIANTS) {
                const next = transition({ state, retries, outcome, limits: LIMITS });

                // 不迴圈的結構性證明：要嘛前進，要嘛原地且某個計數 +1
                const here = ORDER.indexOf(state);
                const there = TERMINAL_STATES.includes(next.state) ? ORDER.length : ORDER.indexOf(next.state);
                if (there === here) {
                    assert.equal(sumRetries(next.retries), sumRetries(retries) + 1,
                        '留在原狀態時必定有且只有一個 retries 計數 +1');
                } else {
                    assert.ok(there > here, `state 只能前進：${state} → ${next.state}`);
                    assert.equal(sumRetries(next.retries), sumRetries(retries), '前進時不動計數');
                }

                worst = Math.max(worst, 1 + longestToTerminal(next.state, next.retries));
            }
            path.delete(k);
            memo.set(mk, worst);
            return worst;
        }

        const worst = longestToTerminal('extracted', {});
        assert.ok(worst <= STEP_BOUND, `最壞情況 ${worst} 步，超過上界 ${STEP_BOUND}`);
        assert.equal(worst, STEP_BOUND, '最壞情況應剛好等於上界（每一格都用滿 fail 與 error 額度再 pass）');
        assert.ok(visited >= 20, `可達組態只有 ${visited} 個，DFS 沒有真的展開`);
    });

    test('最壞路徑可以被具體構造出來：每格用滿 fail + error 額度再 pass，剛好 29 步', () => {
        let state = 'extracted';
        let retries = {};
        let steps = 0;
        for (const s of ORDER) {
            assert.equal(state, s);
            const node = NODE_FOR_STATE[s];
            for (let i = 0; i < MAX_RETRIES_BY_STATE[s]; i++) {
                ({ state, retries } = transition({ state, retries, outcome: { kind: 'fail', reason: 'duplicate' }, limits: LIMITS }));
                steps++;
                assert.equal(state, s);
                assert.equal(retries[node], i + 1);
            }
            for (let i = 0; i < MAX_ERROR_RETRIES; i++) {
                ({ state, retries } = transition({ state, retries, outcome: { kind: 'error', errorClass: 'timeout' }, limits: LIMITS }));
                steps++;
                assert.equal(state, s);
                assert.equal(retries[`${node}:error`], i + 1);
            }
            ({ state, retries } = transition({ state, retries, outcome: { kind: 'pass', data: {} }, limits: LIMITS }));
            steps++;
        }
        assert.equal(state, 'saved');
        assert.equal(steps, STEP_BOUND);
    });

    test('隨機序列（固定種子，1000 條）一律在上界內達終態，且終態合法', () => {
        // 自帶 LCG：不用 Math.random，測試失敗時才重現得出來
        let seed = 20260822;
        const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

        for (let trial = 0; trial < 1000; trial++) {
            let state = 'extracted';
            let retries = {};
            let steps = 0;
            while (!TERMINAL_STATES.includes(state)) {
                const outcome = OUTCOME_VARIANTS[rnd(OUTCOME_VARIANTS.length)];
                const r = transition({ state, retries, outcome, limits: LIMITS });
                state = r.state; retries = r.retries; steps++;
                assert.ok(steps <= STEP_BOUND, `第 ${trial} 條序列超過 ${STEP_BOUND} 步`);
            }
            assert.ok(state === 'saved' || state === 'needs_review', `終態 ${state} 不該由 transition 產生`);
        }
    });

    test('rejected 只能由人（reject API）寫入，transition() 永遠不會回它', () => {
        const heavy = {
            classify: 9, lint: 9, verify: 9,
            'dedup0:error': 9, 'classify:error': 9, 'lint:error': 9,
            'verify:error': 9, 'dedup1:error': 9, 'save:error': 9
        };
        const seen = new Set();
        for (const state of ORDER) {
            for (const outcome of OUTCOME_VARIANTS) {
                for (const retries of [{}, heavy]) {
                    seen.add(transition({ state, retries, outcome, limits: LIMITS }).state);
                }
            }
        }
        assert.equal(seen.has('rejected'), false);
    });
});
