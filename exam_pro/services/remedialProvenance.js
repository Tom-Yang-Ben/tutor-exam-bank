// ─────────────────────────────────────────────────────────────
// services/remedialProvenance.js — 補救卷補題的來源註記（〔dec/r16-remedial〕；migrations/0023；docs/remedial.md 第 11 節）
//
// 補題的變式 job 帶 jobs.target_student_id（為哪一位學生出）與 jobs.source_question_id（拿他的哪一題錯題當藍本）。
//   - stampQuestion   入庫（runner 的 save 節點、或複核 approve）同一個交易裡，把這兩個來源抄到 questions。
//   - remedialForJobs 複核佇列與明細的 remedial_for：{ student_id, student_name, source_question_id }。
//                     姓名只回給本機畫面，不進 LLM、不寫 log。
//   - mergeStudent    合併學生時把來源註記搬到目標學生（studentAdminController.mergeStudent）。
//
// 一律用 to_jsonb(j) ->> 'target_student_id' 讀，**沒套 0023 的庫**讀到 NULL＝當成一般的 job：
// 不寫、不多回任何鍵、不擋原本的流程（同 0021 的 jobs.engine）。只有 job 真的有 target_student_id 時
// 才寫 questions 的兩個新欄位，所以一般的變式與拆題入庫與之前逐字相同。
// ─────────────────────────────────────────────────────────────
'use strict';

/**
 * 入庫的題抄上補題來源（在呼叫端的交易裡）。
 * @param {{query:Function}} client
 * @param {number} jobId
 * @param {number} questionId
 * @returns {Promise<boolean>} 有沒有寫
 */
async function stampQuestion(client, jobId, questionId) {
    const { rows } = await client.query(
        `SELECT (to_jsonb(j) ->> 'target_student_id')::int AS target_student_id, j.source_question_id
           FROM jobs j WHERE j.id = $1 AND j.kind = 'variant'`, [jobId]);
    const t = rows[0];
    if (!t || t.target_student_id === null) return false;
    await client.query(
        `UPDATE questions SET target_student_id = $2, target_source_question_id = $3 WHERE id = $1`,
        [questionId, t.target_student_id, t.source_question_id]);
    return true;
}

/**
 * 一批 job 的補題來源（複核畫面用）。
 * @param {{query:Function}} db
 * @param {number[]} jobIds
 * @returns {Promise<Map<number, {student_id:number, student_name:string|null, source_question_id:number|null}>>}
 */
async function remedialForJobs(db, jobIds) {
    const ids = [...new Set((jobIds || []).filter(Number.isInteger))];
    const out = new Map();
    if (ids.length === 0) return out;
    const { rows } = await db.query(
        `SELECT j.id AS job_id, (to_jsonb(j) ->> 'target_student_id')::int AS student_id, j.source_question_id, s.name AS student_name
           FROM jobs j
           LEFT JOIN students s ON s.id = (to_jsonb(j) ->> 'target_student_id')::int
          WHERE j.id = ANY($1::int[]) AND j.kind = 'variant' AND (to_jsonb(j) ->> 'target_student_id') IS NOT NULL`, [ids]);
    for (const r of rows) {
        out.set(r.job_id, { student_id: r.student_id, student_name: r.student_name ?? null, source_question_id: r.source_question_id ?? null });
    }
    return out;
}

/**
 * 合併學生：來源學生的補題註記搬到目標學生（呼叫端的交易裡，刪來源學生之前）。
 * 沒套 0023 的庫（欄位不存在）什麼都不做。
 * @returns {Promise<void>}
 */
async function mergeStudent(client, from, into) {
    const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM pg_attribute
          WHERE attrelid IN ('jobs'::regclass, 'questions'::regclass) AND attname = 'target_student_id' AND NOT attisdropped`);
    if (rows[0].n < 2) return;
    await client.query('UPDATE jobs SET target_student_id = $2 WHERE target_student_id = $1', [from, into]);
    await client.query('UPDATE questions SET target_student_id = $2 WHERE target_student_id = $1', [from, into]);
}

module.exports = { stampQuestion, remedialForJobs, mergeStudent };
