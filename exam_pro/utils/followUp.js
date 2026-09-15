// ─────────────────────────────────────────────────────────────
// utils/followUp.js — 承上題偵測與前題解析的純函式（DEC-012／FR-019）
//
// 不碰 DB、不讀 process.env：輸入是 job_questions 列（id、idx、state、payload、question_id），
// 輸出是「前題是哪一列」「那一列最後落在哪一題」。寫入由 services/followUpLinker.js 負責。
//
// 為什麼在伺服器端決定性偵測、不讓 extract 模型輸出題組欄位：
//   改 prompt 會讓 eval cassette 全數失效；而「承上題」這幾個字本身就足以決定性判斷。
//
// idx 的編碼（agents/extract.js validateElements）：chunk_no * 1000 + 陣列位置（1 起算）。
//   同一塊內連號；schema 驗證失敗的元素會被丟掉而留下空號——空號的前題無從得知，
//   回報 extract_gap 交給人，不猜。
// ─────────────────────────────────────────────────────────────

/** 「承上題」「承上一題」「承 上 題」與簡體「承上题」都算；「承第 3 題」不算。 */
const FOLLOW_UP_RE = /承\s*上\s*(一\s*)?[題题]/;

/** job_questions.idx 的塊寬（與 agents/extract.js 的 chunkNo * 1000 一致） */
const IDX_CHUNK = 1000;

/** resolveQuestionId 沿 dedup0 同 job 命中鏈遞迴的深度上限 */
const MAX_RESOLVE_DEPTH = 5;

/**
 * 題幹任何位置出現「承上題」即為承上題。
 * @param {unknown} text
 * @returns {boolean}
 */
function isFollowUp(text) {
    return typeof text === 'string' && FOLLOW_UP_RE.test(text);
}

/**
 * 每塊的「模型回傳元素總數」與「被 schema 驗證丟掉的筆數」，給 findPredecessorRow 判斷塊尾有沒有被丟的題。
 *
 * - `elements`：runner 在 insertJobQuestions 時替每題追加的 `payload.extract.chunk_elements`
 *   （該塊 questions + rejected 的總數；比照 figure_img 由 runner 追加，不動 extract 模板／schema／cassette）。
 * - `rejected`：舊資料沒有 chunk_elements 時的退路——該塊 extract 事件（pass／skipped 的最後一筆）
 *   `job_events.detail.rejected` 的筆數。
 *
 * @param {Array<{idx:number, payload?:object}>} rows
 * @param {Array<{chunk:number|string, rejected:number|string}>} [extractEvents] 依 id 遞增
 * @returns {Map<number, {elements:number|null, rejected:number|null}>}
 */
function buildChunkInfo(rows, extractEvents) {
    const info = new Map();
    const slot = (c) => {
        if (!info.has(c)) info.set(c, { elements: null, rejected: null });
        return info.get(c);
    };
    for (const r of Array.isArray(rows) ? rows : []) {
        const n = Number(r.payload && r.payload.extract && r.payload.extract.chunk_elements);
        if (Number.isInteger(n) && n >= 0) slot(Math.floor(Number(r.idx) / IDX_CHUNK)).elements = n;
    }
    for (const e of Array.isArray(extractEvents) ? extractEvents : []) {
        const c = Number(e.chunk);
        const n = Number(e.rejected);
        if (Number.isInteger(c) && Number.isInteger(n) && n >= 0) slot(c).rejected = n;   // 後面的事件蓋掉前面的
    }
    return info;
}

/**
 * 找本題在同一 job 中的前題列。**不猜**：前題可能被 extract 丟掉時一律回 extract_gap。
 *
 * - 本題不是塊內第一個位置 → 前題必須是 idx - 1；不存在代表前一個元素被丟掉 → extract_gap
 *   （含「整份第一題但位置 > 1」：位置 1 的元素被丟了）。
 * - 本題位置 = 1 → 往前逐塊找：
 *     · 該塊有 chunk_elements：存活的最大位置 < chunk_elements → 塊尾被丟 → extract_gap；
 *       相等 → 取該塊最後一題；chunk_elements = 0（空塊）→ 再往前一塊。
 *     · 沒有 chunk_elements（舊資料）：extract 事件的 rejected > 0 → extract_gap（分不出丟的是不是塊尾）；
 *       = 0 或查無事件 → 有題就取最後一題，沒題就再往前一塊。
 *   走到第一塊之前都沒有 → first_in_job。
 *
 * @param {Array<{idx:number}>} rows 同一 job 的全部 job_questions 列（順序不拘）
 * @param {{idx:number}} jq 本題
 * @param {Map<number, {elements:number|null, rejected:number|null}>} [chunkInfo] buildChunkInfo 的結果
 * @returns {{row:object}|{unresolved:'extract_gap'|'first_in_job'}}
 */
function findPredecessorRow(rows, jq, chunkInfo) {
    const idx = Number(jq.idx);
    const position = idx % IDX_CHUNK;
    const chunk = Math.floor(idx / IDX_CHUNK);
    const list = Array.isArray(rows) ? rows : [];
    const info = chunkInfo instanceof Map ? chunkInfo : new Map();

    if (position > 1) {
        const prev = list.find(r => Number(r.idx) === idx - 1);
        return prev ? { row: prev } : { unresolved: 'extract_gap' };
    }

    for (let c = chunk - 1; c >= 1; c--) {
        let last = null;
        for (const r of list) {
            const n = Number(r.idx);
            if (Math.floor(n / IDX_CHUNK) === c && (last === null || n > Number(last.idx))) last = r;
        }
        const maxPos = last ? Number(last.idx) % IDX_CHUNK : 0;
        const ci = info.get(c) || {};

        if (Number.isInteger(ci.elements)) {
            if (maxPos < ci.elements) return { unresolved: 'extract_gap' };
            if (last) return { row: last };
            continue;
        }
        if (Number.isInteger(ci.rejected) && ci.rejected > 0) return { unresolved: 'extract_gap' };
        if (last) return { row: last };
    }
    return { unresolved: 'first_in_job' };
}

/**
 * 一列 job_questions 最後落在題庫的哪一題。
 *
 * 判斷順序（先到先贏）：
 *   1. state='saved' → row.question_id（新題入庫、merge_into 都在這裡）
 *   2. payload.dedup0.hit.scope='db'  → hit.question_id（題幹與庫內題相同）
 *   3. payload.dedup0.hit.scope='job' → 對 hit.jq_id 那一列遞迴（同 job 較早的重複題）
 *   4. payload.dedup1.verdict='duplicate' → top[0].question_id（語意重複，top 已依 cosine 降冪）
 *   5. 其餘 needs_review（或仍在管線中）→ predecessor_pending；rejected → predecessor_rejected
 *
 * 重複題即使被按「不採用」（rejected），2～4 仍成立：它的前情就是被命中的那一題。
 *
 * @param {object} row
 * @param {Map<number, object>} byJqId 同 job 的列，以 job_questions.id 為鍵
 * @param {number} [depth]
 * @returns {{question_id:number}|{unresolved:string}}
 */
function resolveQuestionId(row, byJqId, depth = 0) {
    if (!row) return { unresolved: 'predecessor_missing' };
    if (depth > MAX_RESOLVE_DEPTH) return { unresolved: 'resolve_depth_exceeded' };

    if (row.state === 'saved' && Number.isInteger(row.question_id)) {
        return { question_id: row.question_id };
    }

    const p = row.payload || {};
    const hit = p.dedup0 && p.dedup0.hit;
    if (hit && hit.scope === 'db' && Number.isInteger(hit.question_id)) {
        return { question_id: hit.question_id };
    }
    if (hit && hit.scope === 'job' && hit.jq_id !== undefined && hit.jq_id !== null) {
        const target = byJqId instanceof Map ? byJqId.get(Number(hit.jq_id)) : undefined;
        if (!target) return { unresolved: 'predecessor_missing' };
        return resolveQuestionId(target, byJqId, depth + 1);
    }

    const d1 = p.dedup1;
    if (d1 && d1.verdict === 'duplicate' && Array.isArray(d1.top) && d1.top.length > 0
        && Number.isInteger(d1.top[0].question_id)) {
        return { question_id: d1.top[0].question_id };
    }

    if (row.state === 'rejected') return { unresolved: 'predecessor_rejected' };
    return { unresolved: 'predecessor_pending' };
}

module.exports = {
    isFollowUp, findPredecessorRow, resolveQuestionId, buildChunkInfo,
    FOLLOW_UP_RE, IDX_CHUNK, MAX_RESOLVE_DEPTH
};
