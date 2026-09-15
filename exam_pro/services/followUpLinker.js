// ─────────────────────────────────────────────────────────────
// services/followUpLinker.js — 承上題綁定的寫入端（DEC-012／FR-019）
//
// linkJob(executor, jobId, {src})：對一個 job 重算所有承上題的前題並寫進
// questions.follows_question_id／follows_src。**可重複執行、冪等**——
// 呼叫端（runner 終態後、人工複核 approve／reject 後、回填腳本）不必知道「這次該綁哪一題」，
// 每次都整個 job 重算一遍；期望值與現值相同就不寫。
//
// 為什麼每次重算整個 job 而不是只算剛到終態的那一列：
//   兩題並行時子題可能先入庫，那時前題還在管線中（predecessor_pending）；
//   等前題到終態再跑一次，子題自然補綁。前題被人核准成新題、merge 到既有題時也一樣。
//
// 兩條規則：
//   A. 本 job 自己入庫的承上題（state='saved' 且不是 merge_into）→ 綁到前題解析出的題；
//      follows_src='human' 一律不覆寫。
//   B. 補強（只補空不覆寫）：子題本身被判重複、沒有入新題（dedup 命中或 merge_into）時，
//      對它命中的既有題 Y 做同樣判斷；只有 Y 是承上題且 follows_question_id IS NULL 才綁。
//      舊題（legacy）就是靠這條透過重拆紀錄回填前題。
//
// 寫入一律 compare-and-set（WHERE follows_question_id IS NOT DISTINCT FROM <讀到的舊值>）：
// runner 兩個槽、複核請求可能同時對同一 job 重算，讀到舊值之後別人已改過就不寫（0 列不是錯誤），
// 下一次重算會以新現值為準。
//
// executor 只需要 query(text, values)：pool、{pool, query} 或交易中的 client 都可以。
// ─────────────────────────────────────────────────────────────
const { isFollowUp, findPredecessorRow, resolveQuestionId, buildChunkInfo } = require('../utils/followUp');

const FOLLOW_SRCS = ['pipeline', 'review', 'backfill', 'human'];

/** 沿 follows 鏈檢查成環的深度上限 */
const MAX_CHAIN_DEPTH = 20;

/**
 * 從 target 沿 follows_question_id 往前走，是否會走回 child（綁上去就成環）。
 * @returns {Promise<boolean>}
 */
async function wouldCycle(executor, childId, targetId) {
    const { rows } = await executor.query(
        `WITH RECURSIVE chain(id, depth) AS (
             SELECT $1::int, 0
             UNION ALL
             SELECT q.follows_question_id, c.depth + 1
               FROM questions q JOIN chain c ON q.id = c.id
              WHERE q.follows_question_id IS NOT NULL AND c.depth < $3
         )
         SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
        [targetId, childId, MAX_CHAIN_DEPTH]);
    return rows.length > 0;
}

/** 撈一批題目的綁定判斷所需欄位，回 Map<id, row> */
async function loadQuestions(executor, ids) {
    const unique = [...new Set(ids.filter(Number.isInteger))];
    if (unique.length === 0) return new Map();
    const { rows } = await executor.query(
        `SELECT id, subject, question_text, follows_question_id, follows_src
           FROM questions WHERE id = ANY($1::int[])`, [unique]);
    return new Map(rows.map(r => [r.id, r]));
}

/** 撈一個 job 的全部 job_questions（id／idx 轉 number） */
async function loadJobRows(executor, jobId) {
    const { rows } = await executor.query(
        `SELECT id, idx, state, payload, question_id FROM job_questions WHERE job_id = $1 ORDER BY idx`,
        [jobId]);
    return rows.map(r => ({ ...r, id: Number(r.id), idx: Number(r.idx) }));
}

/**
 * 每塊的元素總數／被丟筆數（buildChunkInfo）。舊資料沒有 payload.extract.chunk_elements 時，
 * 退回讀該塊 extract 事件 detail.rejected（pass／skipped 的最後一筆為準）。
 */
async function loadChunkInfo(executor, jobId, rows) {
    const { rows: events } = await executor.query(
        `SELECT detail->>'chunk' AS chunk, detail->>'rejected' AS rejected
           FROM job_events
          WHERE job_id = $1 AND node = 'extract' AND outcome IN ('pass', 'skipped')
          ORDER BY id`, [jobId]);
    return buildChunkInfo(rows, events);
}

/** 這一列是否「本 job 自己入庫的新題」（而不是 merge_into 指到既有題） */
function isOwnSaved(row) {
    return row.state === 'saved' && Number.isInteger(row.question_id)
        && !(row.payload && row.payload.dedup1 && row.payload.dedup1.merge_into !== undefined
            && row.payload.dedup1.merge_into !== null);
}

/**
 * 算出一列的前題（解析到題庫題號）。
 * @returns {{question_id:number}|{unresolved:string}}
 */
function expectedPredecessor(rows, byJqId, row, chunkInfo) {
    const pred = findPredecessorRow(rows, row, chunkInfo);
    if (pred.unresolved) return { unresolved: pred.unresolved };
    return resolveQuestionId(pred.row, byJqId);
}

/**
 * @param {{query:Function}} executor
 * @param {number} jobId
 * @param {{src:'pipeline'|'review'|'backfill'|'human'}} opts
 * @returns {Promise<{bound:Array<{question_id:number, follows_question_id:number}>,
 *                    unresolved:Array<{jq_id:number, reason:string}>}>}
 */
async function linkJob(executor, jobId, { src } = {}) {
    if (!FOLLOW_SRCS.includes(src)) throw new Error(`linkJob：follows_src「${src}」不在合法值內`);
    const result = { bound: [], unresolved: [] };

    const { rows: job } = await executor.query('SELECT kind FROM jobs WHERE id = $1', [jobId]);
    if (job.length === 0 || job[0].kind !== 'pdf') return result;     // 變式 job 沒有「上一題」

    const rows = await loadJobRows(executor, jobId);
    const byJqId = new Map(rows.map(r => [r.id, r]));
    const chunkInfo = await loadChunkInfo(executor, jobId, rows);

    // 每列「落在題庫哪一題」：自己入庫的題（規則 A）或命中的既有題 Y（規則 B）
    const plans = [];
    const ownIds = new Set(rows.filter(isOwnSaved).map(r => r.question_id));
    for (const row of rows) {
        if (isOwnSaved(row)) {
            plans.push({ row, childId: row.question_id, fillOnly: false });
        } else if (row.state === 'saved' || row.state === 'needs_review' || row.state === 'rejected') {
            const y = resolveQuestionId(row, byJqId);
            // 命中的是本 job 自己入庫的題（同 job 重複）→ 那一題已由規則 A 依它自己的位置處理
            if (y.question_id !== undefined && !ownIds.has(y.question_id)) {
                plans.push({ row, childId: y.question_id, fillOnly: true });
            }
        }
    }
    const questions = await loadQuestions(executor, plans.map(p => p.childId));

    for (const { row, childId, fillOnly } of plans) {
        const child = questions.get(childId);
        if (!child || !isFollowUp(child.question_text)) continue;
        if (fillOnly && child.follows_question_id !== null) continue;       // 規則 B：只補空
        if (child.follows_src === 'human') continue;                         // 人工指定一律不覆寫

        const expected = expectedPredecessor(rows, byJqId, row, chunkInfo);
        if (expected.unresolved) { result.unresolved.push({ jq_id: row.id, reason: expected.unresolved }); continue; }
        const targetId = expected.question_id;
        if (targetId === childId) { result.unresolved.push({ jq_id: row.id, reason: 'self_reference' }); continue; }
        if (child.follows_question_id === targetId) continue;                // 已是期望值（冪等）

        const target = (await loadQuestions(executor, [targetId])).get(targetId);
        if (!target) { result.unresolved.push({ jq_id: row.id, reason: 'predecessor_missing' }); continue; }
        if (target.subject !== child.subject) { result.unresolved.push({ jq_id: row.id, reason: 'subject_mismatch' }); continue; }
        if (await wouldCycle(executor, childId, targetId)) { result.unresolved.push({ jq_id: row.id, reason: 'cycle' }); continue; }

        // compare-and-set：讀到的舊值在寫入前被別人改掉就不寫（0 列不視為錯誤）
        const { rowCount } = await executor.query(
            fillOnly
                ? `UPDATE questions SET follows_question_id = $1, follows_src = $2
                    WHERE id = $3 AND follows_question_id IS NULL
                      AND follows_question_id IS NOT DISTINCT FROM $4::int`
                : `UPDATE questions SET follows_question_id = $1, follows_src = $2
                    WHERE id = $3 AND follows_src IS DISTINCT FROM 'human'
                      AND follows_question_id IS NOT DISTINCT FROM $4::int`,
            [targetId, src, childId, child.follows_question_id]);
        if (rowCount > 0) {
            child.follows_question_id = targetId;   // 同一輪後面的列（同一個 Y）看到新值，不重複寫
            child.follows_src = src;
            result.bound.push({ question_id: childId, follows_question_id: targetId });
        }
    }
    return result;
}

/**
 * 在交易內呼叫 linkJob，失敗只回滾這一段（SAVEPOINT），不拖垮外層的複核交易。
 * 綁定是衍生資料，下一次任何終態或回填都會重算，不值得為它讓老師的核准失敗。
 *
 * 經 module.exports.linkJob 呼叫（而不是區域綁定），整合測試才能替換它來驗證「綁定丟錯時複核照常成功」。
 *
 * @param {{query:Function}} client 已 BEGIN 的連線
 * @returns {Promise<object|null>} linkJob 的結果；失敗回 null
 */
async function linkJobInTransaction(client, jobId, opts, log = console) {
    await client.query('SAVEPOINT follow_up_link');
    try {
        const r = await module.exports.linkJob(client, jobId, opts);
        await client.query('RELEASE SAVEPOINT follow_up_link');
        return r;
    } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT follow_up_link');
        log.warn(`[follow-up] job ${jobId} 承上題綁定失敗（不影響複核結果）：${String(err && err.message).split('\n')[0]}`);
        return null;
    }
}

/**
 * GET /api/review/:jqId 的 follow_up 區塊：這一列是不是承上題、前題是哪一列、為何還綁不上。
 * 題幹取 lint 修正後、否則 extract 原文（與 stemPreview 同一優先序）。
 * 變式 job 不做承上題綁定（沒有「上一題」），一律回 unresolved_reason='variant_job'。
 *
 * @param {{query:Function}} executor
 * @param {{jq_id:number, job_id:number, idx:number, payload:object}} item
 */
async function describeFollowUp(executor, item) {
    const p = item.payload || {};
    const text = (p.lint && p.lint.question_text) ?? (p.extract && p.extract.question_text) ?? '';
    const out = { is_follow_up: isFollowUp(text), predecessor: null, unresolved_reason: null };

    const { rows: job } = await executor.query('SELECT kind FROM jobs WHERE id = $1', [item.job_id]);
    if (job.length > 0 && job[0].kind !== 'pdf') { out.unresolved_reason = 'variant_job'; return out; }
    if (!out.is_follow_up || job.length === 0) return out;

    const rows = await loadJobRows(executor, item.job_id);
    const chunkInfo = await loadChunkInfo(executor, item.job_id, rows);
    const pred = findPredecessorRow(rows, { idx: Number(item.idx) }, chunkInfo);
    if (pred.unresolved) { out.unresolved_reason = pred.unresolved; return out; }

    const pp = pred.row.payload || {};
    const predText = (pp.lint && pp.lint.question_text) ?? (pp.extract && pp.extract.question_text) ?? '';
    out.predecessor = {
        jq_id: pred.row.id, idx: pred.row.idx, state: pred.row.state, question_id: pred.row.question_id,
        stem_preview: String(predText).replace(/\s+/g, ' ').trim().slice(0, 80)
    };
    const resolved = resolveQuestionId(pred.row, new Map(rows.map(r => [r.id, r])));
    if (resolved.unresolved) out.unresolved_reason = resolved.unresolved;
    return out;
}

module.exports = { linkJob, linkJobInTransaction, describeFollowUp, FOLLOW_SRCS, MAX_CHAIN_DEPTH };
