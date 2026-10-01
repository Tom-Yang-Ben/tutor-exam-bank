// ─────────────────────────────────────────────────────────────
// services/retrainStatsService.js — 重練成效（API-13；錯題重練第二階段之三 PR-4）
//
// docs/retrain-and-review.md 第 5.2 節 API-13、第 4.5 節的例子、R10 選 1（Owner 決策單 2026-09-26）：
// 弱點面板與補救卷只算每題第一次作答，重練的表現另外看這張「重練成效」表。
//
// 回應（第 5.2 節的形狀，最後多一個 since）：
//   entered / active / mastered / retired / stuck   目前清單上的題數（依科目篩選；**不受 days 影響**）
//                                                   entered＝進過清單而且還在表上的項目（進行中＋練到會＋移出）；
//                                                   卡關＝進行中而且錯的次數 ≥ RETRAIN_STUCK_LAPSES（R4）
//   first_retrain                                  第 1 關（錯題重練）的作答：{ graded, correct, rate }
//   spaced                                         第 2 關以後（隔週回測）的作答：{ graded, correct, rate }
//                                                  只算 days 天內派出（assigned_at ≥ since）、已批改的重練派題；
//                                                  對錯依 R2（全對才算對：COALESCE(score, result) ≥ 1）；
//                                                  rate 四捨五入到小數第 4 位，graded = 0 時 null
//   backlog                                        { due_now：今天到期（同 API-1 的 due）, overdue_7d：其中逾期 ≥ 7 天 }
//   by_chapter                                     依章節分組的 entered／mastered／active／stuck
//                                                  （進過清單多的在前 → 進行中多的在前 → 章節名）
//   since                                          答對率時間窗的起日（'YYYY-MM-DD'，含當天）＝今天 − days，
//                                                  與弱點面板的 `assigned_at >= CURRENT_DATE - days` 同一種算法
//
// 題數讀排程項目的快取（不變量 I7 由 PR-2 保證）；到期與逾期直接用 retrainService.listItems（與 API-1 同一套判斷：
// 已派出不算到期、封存的不算到期）。答對率讀檢視 assignment_attempts 的重練派題（retrain_step 記派題當下的關卡）。
//
// 個資：不讀、不回學生姓名，不寫 log。不呼叫任何 LLM。
// ─────────────────────────────────────────────────────────────
'use strict';

const { loadRetrainConfig } = require('../config/retrain');
const schedule = require('./retrainSchedule');
const retrain = require('./retrainService');

/** backlog.overdue_7d 的門檻：逾期幾天以上（第 5.2 節 API-13）。 */
const OVERDUE_BACKLOG_DAYS = 7;

/** `db` 可以是 query 函式，也可以是 pool／client（有 .query）。 */
function runnerOf(db) {
    if (typeof db === 'function') return db;
    if (db && typeof db.query === 'function') return (text, values) => db.query(text, values);
    throw new TypeError('retrainStatsService：db 必須是 query 函式或 pool／client。');
}

/**
 * 答對率：四捨五入到小數第 4 位；沒有批改過的作答（分母 0）回 null——沒批改不等於全錯。
 * @param {number} correct
 * @param {number} graded
 * @returns {number|null}
 */
function rateOf(correct, graded) {
    if (!(graded > 0)) return null;
    return Math.round((correct / graded) * 10000) / 10000;
}

/**
 * 重練派題的作答 → 第一次重練（第 1 關）與隔週回測（第 2 關以後）的答對數。
 * 沒批改的略過（保險：SQL 已經只取 result IS NOT NULL）。
 * @param {Array<{retrain_step:number, result:0|1|null, score:number|null}>} rows
 * @param {number} [threshold] config/retrain.js 的 correctThreshold（R2：1）
 * @returns {{first_retrain:{graded:number, correct:number, rate:number|null}, spaced:{graded:number, correct:number, rate:number|null}}}
 */
function tallyAttempts(rows, threshold) {
    const first = { graded: 0, correct: 0 };
    const spaced = { graded: 0, correct: 0 };
    for (const r of rows || []) {
        if (!schedule.isGraded(r)) continue;
        const bucket = Number(r.retrain_step) === 1 ? first : spaced;
        bucket.graded += 1;
        if (schedule.isCorrect(r, threshold)) bucket.correct += 1;
    }
    return {
        first_retrain: { ...first, rate: rateOf(first.correct, first.graded) },
        spaced: { ...spaced, rate: rateOf(spaced.correct, spaced.graded) }
    };
}

/**
 * 依章節分組（沒有章節的題歸在 null）。
 * @param {Array<{chapter:string|null, status:string, stuck:boolean}>} items
 * @returns {Array<{chapter:string|null, entered:number, mastered:number, active:number, stuck:number}>}
 */
function byChapter(items) {
    const map = new Map();
    for (const v of items || []) {
        const key = v.chapter ?? null;
        if (!map.has(key)) map.set(key, { chapter: key, entered: 0, mastered: 0, active: 0, stuck: 0 });
        const c = map.get(key);
        c.entered += 1;
        if (v.status === 'mastered') c.mastered += 1;
        if (v.status === 'active') c.active += 1;
        if (v.stuck) c.stuck += 1;
    }
    const name = c => (c.chapter === null ? '￿' : c.chapter);
    return [...map.values()].sort((a, b) =>
        (b.entered - a.entered) || (b.active - a.active) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
}

/**
 * 組出 API-13 的回應（純函式）。
 * @param {{items:object[], attempts:object[], params:object, since:string}} p
 *   items：retrainService.listItems(status = 'all', asOf = 今天) 的 items（API-1 一筆的形狀）
 *   attempts：時間窗內、已批改的重練派題（retrain_step、result、score）
 * @returns {object}
 */
function summarizeStats({ items, attempts, params, since }) {
    const list = items || [];
    const count = pred => list.filter(pred).length;
    const { first_retrain, spaced } = tallyAttempts(attempts, params.correctThreshold);
    return {
        entered: list.length,
        active: count(v => v.status === 'active'),
        mastered: count(v => v.status === 'mastered'),
        retired: count(v => v.status === 'retired'),
        stuck: count(v => v.stuck),
        first_retrain,
        spaced,
        backlog: {
            due_now: count(v => v.due),
            overdue_7d: count(v => v.due && v.overdue_days >= OVERDUE_BACKLOG_DAYS)
        },
        by_chapter: byChapter(list),
        since
    };
}

/**
 * API-13：某生的重練成效。
 * @param {Function|{query:Function}} db
 * @param {number} studentId
 * @param {{days?:number, subject?:string|null, today?:string, params?:object}} [opts]
 *   days：答對率的時間窗（utils/retrainValidation.js 的 parseStatsQuery 已驗證 1～365）
 * @returns {Promise<object|null>} 學生不存在回 null
 */
async function stats(db, studentId, { days = 90, subject = null, today = retrain.todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(db);
    const list = await retrain.listItems(run, studentId, { status: 'all', subject, asOf: today, today, params });
    if (!list) return null;
    const since = schedule.addDays(today, -days);
    const { rows } = await run(
        `SELECT a.retrain_step, a.result, a.score::float8 AS score
           FROM assignment_attempts a
           JOIN questions q ON q.id = a.question_id
          WHERE a.student_id = $1
            AND a.purpose = 'retrain'
            AND a.result IS NOT NULL
            AND a.assigned_at >= $2::date
            AND ($3::text IS NULL OR q.subject = $3)`,
        [studentId, since, subject]);
    return summarizeStats({ items: list.items, attempts: rows, params, since });
}

module.exports = {
    OVERDUE_BACKLOG_DAYS,
    rateOf,
    tallyAttempts,
    byChapter,
    summarizeStats,
    stats
};
