// queries/hybrid.js — API 與 eval 共用的同一段 hybrid 檢索 SQL（docs/interfaces.md 第 5 條）
//
// 兩邊都不得自己再寫一份：eval 量到的必須就是 prod 真正跑的那條查詢路徑，
// 唯一允許的差異是交易內的 SET LOCAL hnsw.ef_search（eval 調到不小於 fixture 題數以求等效精確）。
//
// 結果集欄位凍結為 id / score / vec_rank / kw_rank，順序 = ORDER BY score DESC, id ASC。

const pgvector = require('pgvector');

/** 兩側各自取前 N 名再 FULL OUTER JOIN；沒進前 N 名的那一側 rank 是 null */
const SIDE_LIMIT = 50;

/** RRF 的平滑常數（1/(60+rank)），業界慣用值 */
const RRF_K = 60;

/** 加權模式的權重（規劃 §2.3.7 與 §1.5 決策表：RRF 為預設，加權是備案） */
const WEIGHT_VEC = 0.7;
const WEIGHT_KW = 0.3;

function assertInt(value, name, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`buildHybridQuery：${name} 必須是 ${min}~${max} 的整數，收到「${value}」。`);
    }
    return n;
}

/**
 * 組出 hybrid 檢索的 SQL 與參數。
 *
 * @param {{
 *   subject: string,                 // 必填
 *   chapter: string|null,            // null = 不限章
 *   difficultyMin: number,           // 1..5
 *   difficultyMax: number,           // 1..5
 *   excludeStudentId: number|null,   // 非 null 時排除該生已在 attempts 的題
 *   excludeIds: number[],            // 排除的題目 id（來源題本身、eval 的 --exclude-self）；預設 []
 *   queryVector: number[],           // 長度必須 = EMBED_DIM(768)
 *   queryTokens: string[],           // tokenize() 的輸出
 *   mode: 'rrf'|'weighted',
 *   limit: number,                   // 1..50
 *   sides?: ('vec'|'kw')[]           // 選用擴充，預設 ['vec','kw']；/similar 的 mode=vector|keyword 用它
 *                                    // 關掉單側。見 docs/archive/questions-wsC.md 第 2 題。
 * }} opts
 * @returns {{text: string, values: any[]}}  直接餵給 config/db.js 的 query(text, values)
 */
function buildHybridQuery(opts = {}) {
    const {
        subject, chapter = null, difficultyMin, difficultyMax,
        excludeStudentId = null, excludeIds = [], queryVector, queryTokens = [],
        mode = 'rrf', limit, sides = ['vec', 'kw'],
    } = opts;

    // ── 參數檢查（組錯 SQL 的錯誤訊息會很難懂，寧可在這裡就擋下來）──
    if (typeof subject !== 'string' || subject.trim() === '') {
        throw new Error('buildHybridQuery：subject 為必填。');
    }
    if (chapter !== null && typeof chapter !== 'string') {
        throw new Error('buildHybridQuery：chapter 必須是字串或 null（null = 不限章）。');
    }
    if (mode !== 'rrf' && mode !== 'weighted') {
        throw new Error(`buildHybridQuery：mode 只能是 'rrf' 或 'weighted'，收到「${mode}」。`);
    }
    const dMin = assertInt(difficultyMin, 'difficultyMin', 1, 5);
    const dMax = assertInt(difficultyMax, 'difficultyMax', 1, 5);
    if (dMin > dMax) throw new Error(`buildHybridQuery：difficultyMin(${dMin}) 不得大於 difficultyMax(${dMax})。`);
    const useLimit = assertInt(limit, 'limit', 1, SIDE_LIMIT);

    if (excludeStudentId !== null && excludeStudentId !== undefined && !Number.isInteger(Number(excludeStudentId))) {
        throw new Error(`buildHybridQuery：excludeStudentId 必須是整數或 null，收到「${excludeStudentId}」。`);
    }
    if (!Array.isArray(excludeIds)) throw new Error('buildHybridQuery：excludeIds 必須是陣列。');
    if (!Array.isArray(queryTokens)) throw new Error('buildHybridQuery：queryTokens 必須是字串陣列（tokenize() 的輸出）。');

    const useVec = sides.includes('vec');
    const useKw = sides.includes('kw');
    if (!useVec && !useKw) throw new Error('buildHybridQuery：sides 至少要有一側。');

    const dim = Number.parseInt(process.env.EMBED_DIM || '768', 10);
    if (useVec) {
        if (!Array.isArray(queryVector) || queryVector.length !== dim) {
            throw new Error(`buildHybridQuery：queryVector 長度必須等於 EMBED_DIM(${dim})，收到 ${Array.isArray(queryVector) ? queryVector.length : typeof queryVector}。`);
        }
    }

    // ── 參數化（值一律走 $n，不做任何字串拼接）──
    const values = [];
    const p = (v) => { values.push(v); return `$${values.length}`; };

    const pSubject = p(subject);
    const pChapter = p(chapter);
    const pDMin = p(dMin);
    const pDMax = p(dMax);
    const pExcludeIds = p(excludeIds.map(Number).filter(Number.isInteger));
    const pStudent = p(excludeStudentId === undefined ? null : excludeStudentId);

    const cte = [`
    cand AS (
        SELECT q.id
          FROM questions q
         WHERE q.subject = ${pSubject}
           AND (${pChapter}::text IS NULL OR q.chapter = ${pChapter}::text)
           AND q.difficulty BETWEEN ${pDMin}::int AND ${pDMax}::int
           AND q.archived_at IS NULL
           AND NOT (q.id = ANY(${pExcludeIds}::int[]))
           AND (${pStudent}::int IS NULL OR NOT EXISTS (
                   SELECT 1 FROM attempts a
                    WHERE a.question_id = q.id AND a.student_id = ${pStudent}::int))
    )`];

    if (useVec) {
        const pVec = p(pgvector.toSql(queryVector));   // 不把 JS 陣列直接丟給 pg
        cte.push(`
    vec AS (
        SELECT q.id,
               row_number() OVER (ORDER BY q.embedding <=> ${pVec}::vector, q.id) AS r,
               (1 - (q.embedding <=> ${pVec}::vector)) AS raw
          FROM questions q JOIN cand USING (id)
         WHERE q.embedding IS NOT NULL
         ORDER BY q.embedding <=> ${pVec}::vector, q.id
         LIMIT ${SIDE_LIMIT}
    )`);
    } else {
        cte.push(`
    vec AS (SELECT NULL::int AS id, NULL::bigint AS r, NULL::float8 AS raw WHERE false)`);
    }

    if (useKw) {
        // 查詢詞在 SQL 端組裝：jieba 吐出的 f(x)、a:b 這類殘留符號若在 JS 端拼成
        // to_tsquery 的輸入會直接 syntax error；quote_literal 讓每個 token 都是字面值。
        // queryTokens 為空時 string_agg 回 NULL、to_tsquery 也回 NULL，關鍵字側自然是空集合。
        const pTokens = p(queryTokens.map(String).filter(t => t.trim() !== ''));
        cte.push(`
    tq AS (
        SELECT to_tsquery('simple', string_agg(quote_literal(t), ' | ')) AS q
          FROM unnest(${pTokens}::text[]) t
    ),
    kw AS (
        SELECT q.id,
               row_number() OVER (ORDER BY ts_rank_cd(q.search_tsv, tq.q) DESC, q.id) AS r,
               ts_rank_cd(q.search_tsv, tq.q)::float8 AS raw
          FROM questions q JOIN cand USING (id) CROSS JOIN tq
         WHERE tq.q IS NOT NULL AND q.search_tsv @@ tq.q
         ORDER BY ts_rank_cd(q.search_tsv, tq.q) DESC, q.id
         LIMIT ${SIDE_LIMIT}
    )`);
    } else {
        cte.push(`
    kw AS (SELECT NULL::int AS id, NULL::bigint AS r, NULL::float8 AS raw WHERE false)`);
    }

    let finalSelect;
    if (mode === 'rrf') {
        finalSelect = `
    SELECT id,
           (COALESCE(1.0 / (${RRF_K} + vec.r), 0) + COALESCE(1.0 / (${RRF_K} + kw.r), 0))::float8 AS score,
           vec.r::int AS vec_rank,
           kw.r::int  AS kw_rank
      FROM vec FULL OUTER JOIN kw USING (id)`;
    } else {
        // 加權：兩側各自在候選集（自己那 50 名）內 min-max 正規化到 0~1；缺席側以 0 計。
        // 整側同分（max = min，例如只有一筆）時一律給 1，不做 0/0。
        cte.push(`
    vec_n AS (
        SELECT id, r,
               CASE WHEN max(raw) OVER () = min(raw) OVER () THEN 1.0::float8
                    ELSE ((raw - min(raw) OVER ()) / (max(raw) OVER () - min(raw) OVER ()))::float8 END AS n
          FROM vec
    ),
    kw_n AS (
        SELECT id, r,
               CASE WHEN max(raw) OVER () = min(raw) OVER () THEN 1.0::float8
                    ELSE ((raw - min(raw) OVER ()) / (max(raw) OVER () - min(raw) OVER ()))::float8 END AS n
          FROM kw
    )`);
        finalSelect = `
    SELECT id,
           (${WEIGHT_VEC} * COALESCE(vec_n.n, 0) + ${WEIGHT_KW} * COALESCE(kw_n.n, 0))::float8 AS score,
           vec_n.r::int AS vec_rank,
           kw_n.r::int  AS kw_rank
      FROM vec_n FULL OUTER JOIN kw_n USING (id)`;
    }

    const text = `WITH${cte.join(',')}${finalSelect}
     ORDER BY score DESC, id ASC
     LIMIT ${p(useLimit)}`;

    return { text, values };
}

module.exports = { buildHybridQuery, SIDE_LIMIT, RRF_K, WEIGHT_VEC, WEIGHT_KW };
