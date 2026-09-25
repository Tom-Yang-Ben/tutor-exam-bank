// ─────────────────────────────────────────────────────────────
// services/retrainSchedule.js — 錯題重練與間隔複習的排程（純函式）
//
// 設計：docs/retrain-and-review.md 第 4.3～4.7 節（已凍結，Owner 2026-09-26 決策單第三輪）；
// 決策紀錄：ADR-019（固定關卡、排程是作答歷史的純函式）。
//
// **純函式**：不碰 DB、不讀 env、不看時鐘。
//   - 「今天」由呼叫端以 asOf 傳入；參數由呼叫端從 config/retrain.js 的 loadRetrainConfig() 取來傳入，
//     省略時用 config/retrain.js 的 DEFAULTS（常數，不是 env）。
//   - 日期一律是 'YYYY-MM-DD' 字串（config/db.js 把 DATE 解析成字串）；加減以 UTC 計算，
//     不經本地時區，伺服器在哪個時區結果都一樣。
//   - 同一份輸入永遠得到同一份輸出，也不改動輸入：改判、取消批改、刪卷之後重算即可（設計稿不變量 I7）。
//
// 規則（〔R*〕＝Owner 決策單 2026-09-26 第三輪的題號）：
//   〔R1 選 2〕項目是老師勾「要重練」（或在清單上手動加入）才有的；本檔不決定「進不進清單」，
//             只從起算日（entered_on）算排程。新題（第一次）那一次作答的對錯**不影響**排程。
//   〔R2 選 1〕只有全對才算對：COALESCE(score, result) ≥ 1（沒給部分分且按「對」，或給 100%）。
//   〔R3 選 2〕第 1 關＝下一份卷（派題日＋1 天）、第 2 關 7 天、第 3 關 14 天；連對 3 次＝練到會。
//   〔R4 選 1〕重練或回測又錯 → 回第 1 關、連對歸零、錯的次數＋1；錯的次數 ≥ 3 標「卡關」，
//             只是提醒：狀態仍是進行中、照樣會到期，不自動移出。
//   〔R5 選 1〕固定關卡（Leitner 式）。
//   〔R6 選 1〕附在新卷時的預設上限＝新題數 × 0.3（capForAttach）。
// ─────────────────────────────────────────────────────────────
const { DEFAULTS, MAX_PAPER_QUESTIONS, MAX_STEPS } = require('../config/retrain');

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PURPOSES = Object.freeze(['new', 'retrain']);
const OVERRIDES = Object.freeze(['retired', 'mastered']);

// ───────────────────────── 日期（'YYYY-MM-DD' 字串）─────────────────────────

/** 'YYYY-MM-DD' → UTC 毫秒；格式不對或不是真的日期（2026-02-30）回 NaN。 */
function toUtcMs(date) {
    if (typeof date !== 'string') return NaN;
    const m = DATE_RE.exec(date);
    if (!m) return NaN;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
    return ms;
}

/**
 * 是否為合法的 'YYYY-MM-DD'（含「真的有這一天」）。
 * @param {any} date
 * @returns {boolean}
 */
function isValidDate(date) {
    return Number.isFinite(toUtcMs(date));
}

function assertDate(date, label) {
    if (!isValidDate(date)) throw new TypeError(`retrainSchedule：${label} 必須是 'YYYY-MM-DD'，收到 ${JSON.stringify(date)}。`);
}

/**
 * 日期加 n 天（n 可為負）。
 * @param {string} date 'YYYY-MM-DD'
 * @param {number} n 整數
 * @returns {string} 'YYYY-MM-DD'
 */
function addDays(date, n) {
    assertDate(date, 'addDays 的日期');
    if (!Number.isInteger(n)) throw new TypeError(`retrainSchedule：addDays 的天數必須是整數，收到 ${JSON.stringify(n)}。`);
    return new Date(toUtcMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * to − from 的天數（to 比較晚時為正）。
 * @param {string} from 'YYYY-MM-DD'
 * @param {string} to   'YYYY-MM-DD'
 * @returns {number}
 */
function diffDays(from, to) {
    assertDate(from, 'diffDays 的起日');
    assertDate(to, 'diffDays 的迄日');
    return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

// ───────────────────────── 對錯（R2）─────────────────────────

/** null／undefined／'' 視為「沒有值」。 */
function isBlank(v) {
    return v === null || v === undefined || v === '';
}

/**
 * 批改過了沒：result 是 0 或 1。result 為 NULL＝還沒批改（或取消批改）。
 * @param {{result?:any}} attempt
 * @returns {boolean}
 */
function isGraded(attempt) {
    if (!attempt || isBlank(attempt.result)) return false;
    const r = Number(attempt.result);
    return r === 0 || r === 1;
}

/**
 * 正確度＝COALESCE(score, result)：有部分給分就看分數，沒有才看對／錯按鈕
 * （同 services/remedialService.js、kcWeaknessService.js 的算法）。沒批改回 null。
 * score 可能是數字，也可能是 NUMERIC 沒轉型時的字串（'0.80'）。
 * @param {{result?:any, score?:any}} attempt
 * @returns {number|null}
 */
function correctnessOf(attempt) {
    if (!isGraded(attempt)) return null;
    const c = isBlank(attempt.score) ? Number(attempt.result) : Number(attempt.score);
    return Number.isFinite(c) ? c : null;
}

/**
 * 〔R2 選 1〕只有全對才算對：沒給部分分且按「對」，或部分給分給 100%。
 * 沒批改一律 false（要分辨「沒批改」與「錯」請先用 isGraded）。
 *
 * @param {{result?:any, score?:any}} attempt
 * @param {number} [threshold] 預設 config/retrain.js 的 CORRECT_THRESHOLD（1）
 * @returns {boolean}
 */
function isCorrect(attempt, threshold = DEFAULTS.correctThreshold) {
    const c = correctnessOf(attempt);
    // 容差：score 是 NUMERIC(3,2)，轉成浮點數後 1.00 仍是 1；容差只是保險
    return c !== null && c >= threshold - 1e-9;
}

// ───────────────────────── 參數 ─────────────────────────

/**
 * 檢查參數；不合法丟 TypeError（這是呼叫端的程式錯誤，不是使用者輸入）。
 * config/retrain.js 的 loadRetrainConfig() 產出的參數一定通過。
 */
function assertParams(params) {
    if (!params || typeof params !== 'object') throw new TypeError('retrainSchedule：params 必須是物件。');
    const { stepDays, masteryStreak, stuckLapses, correctThreshold } = params;
    if (!Number.isInteger(masteryStreak) || masteryStreak < 1 || masteryStreak > MAX_STEPS) {
        throw new TypeError(`retrainSchedule：masteryStreak 必須是 1～${MAX_STEPS} 的整數。`);
    }
    if (!Array.isArray(stepDays) || stepDays.length < masteryStreak ||
        !stepDays.every(d => Number.isInteger(d) && d >= 0)) {
        throw new TypeError('retrainSchedule：stepDays 必須是非負整數陣列，而且關數 ≥ masteryStreak。');
    }
    if (!Number.isInteger(stuckLapses) || stuckLapses < 1) {
        throw new TypeError('retrainSchedule：stuckLapses 必須是正整數。');
    }
    if (typeof correctThreshold !== 'number' || !(correctThreshold > 0 && correctThreshold <= 1)) {
        throw new TypeError('retrainSchedule：correctThreshold 必須是 (0, 1] 的數字。');
    }
}

// ───────────────────────── 排程 ─────────────────────────

/**
 * @typedef {object} HistoryEntry  這位學生這一題的一筆派題（含作答）
 * @property {number} assignment_id 派題編號（同一天多筆時依它排先後）
 * @property {string} assigned_at   派題日 'YYYY-MM-DD'
 * @property {'new'|'retrain'} purpose 新題（第一次）或重練／回測
 * @property {0|1|null} result      對錯；null＝還沒批改
 * @property {number|string|null} [score] 部分給分 0～1；null＝沒給
 */

/**
 * @typedef {object} RetrainState  排程快取（設計稿第 3.4 節 retrain_items 的排程欄位）
 * @property {'active'|'mastered'|'retired'} status
 * @property {number} step          目前關卡（1～K；練到會時為 K）
 * @property {string|null} due_on   下次到期日；只有進行中才有（不變量 I5）
 * @property {number} streak        目前連對次數
 * @property {number} lapses        錯的次數（全部已批改的重練／回測派題中答錯的筆數，重新加入也不歸零）
 * @property {string|null} last_attempt_on 最後一筆已批改的重練／回測派題的派題日
 * @property {string|null} mastered_on     練到會的那一次派題日，或老師判定已會的日期
 * @property {boolean} in_flight    這一題有派題還沒批改（不算到期、不再派，不變量 I6）
 * @property {string|null} in_flight_since 最早一筆還沒批改的派題日（超過 14 天未批改另外提醒用）
 * @property {boolean} stuck        卡關：進行中而且錯的次數 ≥ stuckLapses（只提醒）
 */

/**
 * 由這位學生這一題的作答歷史，算出排程狀態（設計稿第 4.6 節）。
 *
 * 規則：
 *   1. 從起算日 entered_on 進入第 1 關，到期日＝entered_on＋第 1 關間隔。
 *      起算日：批改卡勾「要重練」＝那一筆新題派題的派題日；承上組同組題＝同那一題；
 *      清單上手動加入、重新加入＝加入當天（由呼叫端決定，本函式只收日期）。
 *   2. history 依（派題日, 派題編號）排序後逐筆看；輸入的順序不影響結果。
 *   3. 還沒批改的派題（不論新題或重練）→ in_flight；跳過，不影響關卡。
 *   4. 新題（第一次）的作答不影響關卡：進不進清單是老師勾的（R1 選 2）。
 *   5. 重練／回測派題：
 *        - 答錯一律讓錯的次數＋1（包含重新加入之前那一輪的，錯的次數不歸零）。
 *        - 派題日早於 entered_on 的（重新加入之前那一輪）只累計錯的次數，不影響關卡。
 *        - 答對：進行中 → 連對＋1；連對 ≥ K → 練到會（不再到期）；否則升到第「連對＋1」關，
 *                到期日＝這一筆的派題日＋該關間隔。已練到會 → 維持練到會。
 *        - 答錯：回第 1 關、連對歸零，到期日＝這一筆的派題日＋第 1 關間隔；
 *                已練到會的題（承上組被帶著出）答錯也一樣重新進行中。
 *   6. 最後套老師的手動決定（優先於作答歷史）：retired＝移出；mastered＝判定已會
 *      （本來就已練到會時保留原本的 mastered_on）。
 *   7. 卡關＝進行中而且錯的次數 ≥ stuckLapses；只是提醒，狀態、關卡、到期日都不變。
 *
 * @param {{entered_on:string, teacher_override?:('retired'|'mastered'|null),
 *          override_on?:(string|null), history?:HistoryEntry[]}} input
 * @param {{stepDays:ReadonlyArray<number>, masteryStreak:number, stuckLapses:number,
 *          correctThreshold:number}} [params] 預設 config/retrain.js 的 DEFAULTS
 * @returns {RetrainState}
 */
function computeRetrainState(input, params = DEFAULTS) {
    assertParams(params);
    if (!input || typeof input !== 'object') throw new TypeError('retrainSchedule：input 必須是物件。');
    const { entered_on: enteredOn } = input;
    assertDate(enteredOn, 'entered_on');

    const override = isBlank(input.teacher_override) ? null : input.teacher_override;
    if (override !== null && !OVERRIDES.includes(override)) {
        throw new TypeError(`retrainSchedule：teacher_override 只能是 retired、mastered 或 null，收到 ${JSON.stringify(override)}。`);
    }
    if (override !== null) assertDate(input.override_on, 'override_on');

    const history = input.history === undefined || input.history === null ? [] : input.history;
    if (!Array.isArray(history)) throw new TypeError('retrainSchedule：history 必須是陣列。');
    history.forEach((e, i) => {
        if (!e || typeof e !== 'object') throw new TypeError(`retrainSchedule：history[${i}] 必須是物件。`);
        assertDate(e.assigned_at, `history[${i}].assigned_at`);
        if (!PURPOSES.includes(e.purpose)) {
            throw new TypeError(`retrainSchedule：history[${i}].purpose 只能是 new 或 retrain，收到 ${JSON.stringify(e.purpose)}。`);
        }
        if (!Number.isFinite(Number(e.assignment_id))) {
            throw new TypeError(`retrainSchedule：history[${i}].assignment_id 必須是數字。`);
        }
    });

    const sorted = [...history].sort((a, b) => {
        if (a.assigned_at !== b.assigned_at) return a.assigned_at < b.assigned_at ? -1 : 1;
        return Number(a.assignment_id) - Number(b.assignment_id);
    });

    const { stepDays, masteryStreak: K, stuckLapses, correctThreshold } = params;
    let status = 'active';
    let step = 1;
    let streak = 0;
    let lapses = 0;
    let dueOn = addDays(enteredOn, stepDays[0]);
    let masteredOn = null;
    let lastAttemptOn = null;
    let inFlightSince = null;

    for (const e of sorted) {
        if (!isGraded(e)) {
            if (inFlightSince === null) inFlightSince = e.assigned_at;
            continue;
        }
        if (e.purpose !== 'retrain') continue;   // 新題那一次不影響排程（R1 選 2）

        const ok = isCorrect(e, correctThreshold);
        if (!ok) lapses += 1;
        lastAttemptOn = e.assigned_at;
        if (e.assigned_at < enteredOn) continue;  // 重新加入之前那一輪：只累計錯的次數

        if (ok) {
            if (status === 'mastered') continue;  // 已練到會又答對：維持
            streak += 1;
            if (streak >= K) {
                status = 'mastered';
                step = K;
                dueOn = null;
                masteredOn = e.assigned_at;
            } else {
                step = streak + 1;
                dueOn = addDays(e.assigned_at, stepDays[step - 1]);
            }
        } else {
            status = 'active';
            step = 1;
            streak = 0;
            masteredOn = null;
            dueOn = addDays(e.assigned_at, stepDays[0]);
        }
    }

    if (override === 'retired') {
        status = 'retired';
        dueOn = null;
    } else if (override === 'mastered') {
        if (status !== 'mastered') masteredOn = input.override_on;
        status = 'mastered';
        dueOn = null;
    }

    return {
        status,
        step,
        due_on: dueOn,
        streak,
        lapses,
        last_attempt_on: lastAttemptOn,
        mastered_on: masteredOn,
        in_flight: inFlightSince !== null,
        in_flight_since: inFlightSince,
        stuck: status === 'active' && lapses >= stuckLapses
    };
}

/**
 * 到期了沒：進行中、沒有還沒批改的派題、到期日 ≤ 預計作答日（設計稿第 4.7 節）。
 * 題目封存與否要查 DB，由呼叫端另外排除。
 *
 * @param {Pick<RetrainState,'status'|'due_on'|'in_flight'>} state
 * @param {string} asOf 預計作答日 'YYYY-MM-DD'（出卷時可指定，預設今天——「今天」由呼叫端給）
 * @returns {boolean}
 */
function isDue(state, asOf) {
    assertDate(asOf, 'asOf');
    if (!state || state.status !== 'active' || state.in_flight || isBlank(state.due_on)) return false;
    assertDate(state.due_on, 'state.due_on');
    return state.due_on <= asOf;
}

/**
 * 逾期天數：到期的題回 asOf − due_on（當天到期＝0）；沒到期回 0。排序「逾期多的先」用。
 * @param {Pick<RetrainState,'status'|'due_on'|'in_flight'>} state
 * @param {string} asOf
 * @returns {number}
 */
function overdueDays(state, asOf) {
    return isDue(state, asOf) ? diffDays(state.due_on, asOf) : 0;
}

/**
 * 〔R6 選 1〕附在新卷時，重練題的預設上限（出卷畫面預先帶入，老師可改）。
 *
 *   上限＝floor(新題數 × 比例)，而且新題＋重練合計不超過一份卷的上限（maxTotal，預設 50）：
 *   設計稿 API-6 規定合計超過 50 回 400，預設值不該一帶入就超過。
 *   「上限為新題數的三成」取無條件捨去：新題 7 題 → 2 題、新題 3 題 → 0 題。
 *   乘法的浮點誤差（0.29 × 100 = 28.999…）以容差吸收，不會少算一題。
 *
 * @param {number} newCount 新題數（非負整數）
 * @param {number} [ratio]  預設 config/retrain.js 的 DEFAULTS.attachRatio（0.3）；
 *                          要用環境變數覆寫後的值，呼叫端傳 loadRetrainConfig().attachRatio
 * @param {{maxTotal?:number}} [opts]
 * @returns {number}
 */
function capForAttach(newCount, ratio = DEFAULTS.attachRatio, { maxTotal = MAX_PAPER_QUESTIONS } = {}) {
    if (!Number.isInteger(newCount) || newCount < 0) {
        throw new RangeError(`retrainSchedule：新題數必須是非負整數，收到 ${JSON.stringify(newCount)}。`);
    }
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
        throw new RangeError(`retrainSchedule：附帶比例必須是非負數字，收到 ${JSON.stringify(ratio)}。`);
    }
    if (!Number.isInteger(maxTotal) || maxTotal < 0) {
        throw new RangeError(`retrainSchedule：maxTotal 必須是非負整數，收到 ${JSON.stringify(maxTotal)}。`);
    }
    const byRatio = Math.floor(newCount * ratio + 1e-9);
    return Math.max(0, Math.min(byRatio, maxTotal - newCount));
}

module.exports = {
    computeRetrainState,
    isGraded,
    isCorrect,
    correctnessOf,
    isDue,
    overdueDays,
    capForAttach,
    addDays,
    diffDays,
    isValidDate
};
