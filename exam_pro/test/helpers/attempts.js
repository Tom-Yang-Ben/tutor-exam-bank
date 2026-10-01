// ─────────────────────────────────────────────────────────────
// test/helpers/attempts.js — 測試夾具寫作答紀錄的共用 helper（〔retrain PR-1〕docs/retrain-and-review.md 第 6.4 節）
//
// 為什麼要有這一支：migrations/0016 把 attempts 拆成 assignments（派題）＋attempt_records（作答），
// attempts 改成**唯讀**相容檢視（只含「新題」派題，每生每題最多一列＝拆表前的語意）。
// 測試夾具原本直接 `INSERT INTO attempts …`，對檢視寫入會立刻報錯，所以準備資料的程式一律改走這裡：
// 每一列寫一筆派題＋一筆作答（與 controllers/examController.js 的 writePaper 同一個形狀）。
//
// 只動「準備資料」的程式，不動任何斷言：讀取照舊 `SELECT … FROM attempts`（沒有重練資料時，
// 檢視的內容與拆表前的表完全相同）。清表改成 `TRUNCATE attempt_records, assignments, …`、
// 刪列改成 `DELETE FROM assignments …`（作答跟著 ON DELETE CASCADE），直接寫在各測試檔裡。
//
// 用法：
//   const { insertAttempts, insertAttempt } = require('../helpers/attempts');
//   await insertAttempts(query, [
//       { student_id: 1, question_id: 2, paper_id: 3, days_ago: 5, result: 0, graded_at: 'now',
//         score: 0.25, error_types: ['calc'], response: '…', teacher_note: '…' },
//       { student_id: 1, question_id: 2, purpose: 'retrain', paper_id: 4 }      // 重練派題（同一題再派一次）
//   ]);
//
// 欄位（全部是舊 attempts 的欄名，外加 purpose 與 days_ago；不認得的鍵直接丟錯，打錯字不會靜默變成 NULL）：
//   student_id、question_id  必填
//   paper_id                 預設 NULL
//   assigned_at              'YYYY-MM-DD'；沒給時＝CURRENT_DATE − days_ago（days_ago 預設 0）。
//                            用資料庫的 CURRENT_DATE 起算，JS 端不必猜資料庫的今天是哪天。
//   purpose                  'new'（預設）｜'retrain'
//   result、score、response、teacher_note  預設 NULL
//   graded_at                預設 NULL；可給 ISO 字串，或 PostgreSQL 的特殊輸入值 'now'（＝交易時間 now()）
//   error_types              字串陣列，預設 []
//
// 選項：
//   { skipExisting: true }   新題撞到同生同題已有的新題派題時略過（ON CONFLICT … DO NOTHING），
//                            相當於舊寫法的 `ON CONFLICT (student_id, question_id) DO NOTHING`。
//
// 回傳：實際寫進去的派題 id（依輸入順序）。拆表時 id 原樣保留，所以派題 id＝檢視 attempts 的 id。
//
// 〔retrain PR-2〕migrations/0017 之後重練派題必須屬於同生同題的排程項目（assignments_retrain_link_check、
// assignments_retrain_item_fk），多收兩個欄位：
//   retrain_item_id          重練派題所屬的項目；purpose = 'retrain' 而沒給時，自動找（或建一個 reason = 'manual'、
//                            起算日＝那一題新題派題日的）項目——同生同題的新題派題必須已經在資料庫裡（不變量 I1），
//                            否則直接丟錯。自動建的項目只填第 1 關的初值，不重算；要排程快取正確的測試
//                            請呼叫 services/retrainService.js 的 recompute。
//   retrain_step             重練派題當下的關卡；purpose = 'retrain' 而沒給時＝1
// 只有這一批有重練派題時，寫入語句才多這兩欄（buildInsertSql({ retrainLink: true })）；
// 沒有重練派題時語句與 0016 時完全相同。
// ─────────────────────────────────────────────────────────────
'use strict';

const COLUMNS = {
    student_id: 'int',
    question_id: 'int',
    paper_id: 'int',
    assigned_at: 'date',
    days_ago: 'int',
    purpose: 'text',
    result: 'smallint',
    graded_at: 'timestamptz',
    score: 'numeric',
    error_types: 'text[]',
    response: 'text',
    teacher_note: 'text',
    // 〔retrain PR-2〕0017
    retrain_item_id: 'bigint',
    retrain_step: 'smallint'
};

/** `db` 可以是 config/db.js 的 query 函式，也可以是 pool／client（有 .query 方法）。 */
function runnerOf(db) {
    if (typeof db === 'function') return db;
    if (db && typeof db.query === 'function') return (text, values) => db.query(text, values);
    throw new TypeError('insertAttempts：第一個參數要是 query 函式或 pool／client');
}

/**
 * 產生寫入語句（純函式）。$1 = rows 的 JSON。
 * 派題 id 先用 identity 序號發好（nextval），派題與作答同一句寫入，作答只建給「實際寫進去」的派題。
 * @param {{skipExisting?:boolean, retrainLink?:boolean}} [opts]
 *   retrainLink：〔retrain PR-2〕多寫 retrain_item_id、retrain_step 兩欄（這一批有重練派題時才用）
 * @returns {string}
 */
function buildInsertSql({ skipExisting = false, retrainLink = false } = {}) {
    const cols = Object.entries(COLUMNS).map(([k, t]) => `${k} ${t}`).join(', ');
    return `WITH src AS MATERIALIZED (
    SELECT nextval(pg_get_serial_sequence('assignments', 'id')) AS aid, r.*
      FROM jsonb_to_recordset($1::jsonb) AS r(${cols})
), ins AS (
    INSERT INTO assignments (id, student_id, question_id, paper_id, assigned_at, purpose${retrainLink ? ', retrain_item_id, retrain_step' : ''})
    OVERRIDING SYSTEM VALUE
    SELECT aid, student_id, question_id, paper_id,
           COALESCE(assigned_at, CURRENT_DATE - COALESCE(days_ago, 0)), COALESCE(purpose, 'new')${retrainLink ? ', retrain_item_id, retrain_step' : ''}
      FROM src
    ${skipExisting ? `ON CONFLICT (student_id, question_id) WHERE purpose = 'new' DO NOTHING` : ''}
    RETURNING id
)
INSERT INTO attempt_records (assignment_id, result, graded_at, score, error_types, response, teacher_note)
SELECT src.aid, src.result, src.graded_at, src.score, COALESCE(src.error_types, '{}'::text[]),
       src.response, src.teacher_note
  FROM src JOIN ins ON ins.id = src.aid
RETURNING assignment_id`;
}

/**
 * 批次寫派題＋作答（一句 SQL）。
 * @param {Function|{query:Function}} db
 * @param {Array<object>} rows
 * @param {{skipExisting?:boolean}} [opts]
 * @returns {Promise<number[]>} 實際寫進去的派題 id（依輸入順序）
 */
async function insertAttempts(db, rows, opts = {}) {
    if (!Array.isArray(rows)) throw new TypeError('insertAttempts：rows 必須是陣列');
    if (rows.length === 0) return [];
    for (const row of rows) {
        const unknown = Object.keys(row).filter(k => !Object.prototype.hasOwnProperty.call(COLUMNS, k));
        if (unknown.length > 0) throw new Error(`insertAttempts：不認得的欄位 ${unknown.join('、')}`);
        if (!Number.isInteger(row.student_id) || !Number.isInteger(row.question_id)) {
            throw new Error('insertAttempts：student_id 與 question_id 必填且為整數');
        }
    }
    const run = runnerOf(db);
    // 〔retrain PR-2〕有重練派題時補上所屬項目與關卡（見檔頭）
    const retrainLink = rows.some(r => r.purpose === 'retrain');
    const payload = retrainLink ? await linkRetrainRows(run, rows) : rows;
    const res = await run(buildInsertSql({ ...opts, retrainLink }), [JSON.stringify(payload)]);
    // 序號依輸入順序發號，排序後即輸入順序
    return res.rows.map(r => Number(r.assignment_id)).sort((a, b) => a - b);
}

/**
 * 〔retrain PR-2〕重練派題沒給 retrain_item_id 時，找（或建）同生同題的排程項目；retrain_step 預設 1。
 * @returns {Promise<Array<object>>} 補好欄位的 rows（不改動輸入）
 */
async function linkRetrainRows(run, rows) {
    const need = rows.filter(r => r.purpose === 'retrain' && (r.retrain_item_id === undefined || r.retrain_item_id === null));
    const itemOf = new Map();
    if (need.length) {
        const pairs = JSON.stringify(need.map(r => ({ student_id: r.student_id, question_id: r.question_id })));
        await run(
            `INSERT INTO retrain_items (student_id, question_id, source_assignment_id, reason, entered_on, due_on)
             SELECT a.student_id, a.question_id, a.id, 'manual', a.assigned_at, a.assigned_at + 1
               FROM (SELECT DISTINCT student_id, question_id
                       FROM jsonb_to_recordset($1::jsonb) AS w(student_id int, question_id int)) w
               JOIN assignments a ON a.student_id = w.student_id AND a.question_id = w.question_id AND a.purpose = 'new'
             ON CONFLICT (student_id, question_id) DO NOTHING`, [pairs]);
        const { rows: items } = await run(
            `SELECT i.id, i.student_id, i.question_id FROM retrain_items i
               JOIN jsonb_to_recordset($1::jsonb) AS w(student_id int, question_id int)
                 ON w.student_id = i.student_id AND w.question_id = i.question_id`, [pairs]);
        for (const it of items) itemOf.set(`${it.student_id}:${it.question_id}`, Number(it.id));
        const orphan = need.find(r => !itemOf.has(`${r.student_id}:${r.question_id}`));
        if (orphan) {
            throw new Error(`insertAttempts：重練派題（學生 ${orphan.student_id}、題目 ${orphan.question_id}）`
                + '需要同生同題先有一筆新題派題（不變量 I1）');
        }
    }
    return rows.map(r => {
        if (r.purpose !== 'retrain') return r;
        return {
            ...r,
            retrain_item_id: r.retrain_item_id ?? itemOf.get(`${r.student_id}:${r.question_id}`),
            retrain_step: r.retrain_step ?? 1
        };
    });
}

/**
 * 寫一筆派題＋作答。
 * @returns {Promise<number|null>} 派題 id；skipExisting 且撞到時為 null
 */
async function insertAttempt(db, row, opts = {}) {
    const [id] = await insertAttempts(db, [row], opts);
    return id ?? null;
}

module.exports = { insertAttempts, insertAttempt, buildInsertSql, linkRetrainRows, COLUMNS };
