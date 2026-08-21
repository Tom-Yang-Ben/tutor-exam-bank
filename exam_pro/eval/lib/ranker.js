// ─────────────────────────────────────────────────────────────
// eval/lib/ranker.js — 記憶體排序器（LIKE / 向量 / hybrid）
//
// 兩個用途：
//   1. LIKE 欄**永遠**由這裡算。對 fixture 這種短字串，JS 的 String.includes 與
//      SQL 的 question_text LIKE '%詞%' 是同一件事（都是無萬用字元的子字串比對），
//      所以 LIKE 欄不需要 DB，也就不會因為「今天有沒有 PG」而變成兩個數字。
//   2. 向量／hybrid 欄的**對照組**。D-R2 要斷言「同一份 fixture 下，
//      SQL（queries/hybrid.js）與本檔的前 10 名 Jaccard ≥ 0.9」——
//      兩邊算出不同的東西，就代表 eval 量到的不是 prod 的查詢路徑。
//
// 融合公式照 docs/interfaces.md 第 5 條逐字實作，不自己發明：
//   mode='rrf'      score = 1/(60+vec_rank) + 1/(60+kw_rank)（缺席側以 0 計）
//   mode='weighted' score = 0.7×向量側 + 0.3×關鍵字側（兩側各自在候選集內 min-max 正規化）
//   排序 ORDER BY score DESC, id ASC
// ─────────────────────────────────────────────────────────────

const { likeKeywords } = require('./pooling');
const { tokenize } = require('./tokenize');
const { buildEmbedText } = require('./embedText');

const RRF_K = 60;        // interfaces 第 5 條寫死的 RRF 常數
const SIDE_LIMIT = 50;   // 兩側各自 ORDER BY r LIMIT 50 之後才 FULL OUTER JOIN

/**
 * 候選集：與 queries/hybrid.js 的候選 CTE 對齊（同學科、依 scope 限章、排除指定 id）。
 * fixture 沒有 archived_at 與 attempts，所以那兩個條件在記憶體端是恆真。
 *
 * @param {object} opts
 * @param {object} opts.source        來源題
 * @param {Array<object>} opts.questions
 * @param {'chapter'|'subject'|'all'} [opts.scope='subject']
 * @param {number[]} [opts.excludeIds=[]]
 * @returns {Array<object>}
 */
function candidates(opts) {
    const { source, questions } = opts;
    const scope = opts.scope || 'subject';
    const exclude = new Set(opts.excludeIds || []);
    return questions.filter(q => {
        if (exclude.has(q.id)) return false;
        if (scope === 'all') return true;
        if (q.subject !== source.subject) return false;
        if (scope === 'chapter') return q.chapter === source.chapter;
        return true;
    });
}

/**
 * LIKE 欄：關鍵字取 pooling.likeKeywords()（凍結規則），命中任一即入選。
 * 排序 = 命中的關鍵字個數 desc、id asc——與 SQL 端的寫法一致，
 * 也讓「三個關鍵字都中」的題排在「只中一個」的前面。
 *
 * @param {object} source
 * @param {Array<object>} cands
 * @returns {Array<{id:number, score:number}>}
 */
function rankLike(source, cands) {
    const kws = likeKeywords(source);
    if (kws.length === 0) return [];
    const hits = [];
    for (const q of cands) {
        const text = q.question_text || '';
        let n = 0;
        for (const kw of kws) if (text.includes(kw)) n++;
        if (n > 0) hits.push({ id: q.id, score: n });
    }
    hits.sort((a, b) => b.score - a.score || a.id - b.id);
    return hits;
}

/**
 * 餘弦相似度。interfaces 第 4 條保證向量已 L2 正規化，這裡仍算完整餘弦——
 * 多算一個開根號換「拿到沒正規化的向量也不會靜默算錯」。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 向量欄：對候選集算餘弦，由大到小。
 * @param {number[]} queryVec
 * @param {Array<object>} cands
 * @param {(q:object)=>number[]|null} vectorOf
 * @returns {Array<{id:number, score:number}>}
 */
function rankVector(queryVec, cands, vectorOf) {
    const rows = [];
    for (const q of cands) {
        const v = vectorOf(q);
        if (!v) continue;                      // 沒向量的題不進向量側（等同 SQL 的 embedding IS NOT NULL）
        rows.push({ id: q.id, score: cosine(queryVec, v) });
    }
    rows.sort((a, b) => b.score - a.score || a.id - b.id);
    return rows;
}

/**
 * hybrid 的關鍵字側：對應 SQL 的 to_tsquery('simple', 'tok1 | tok2 | …') + ts_rank。
 *
 * 這裡是**近似**：ts_rank 的權重細節（詞頻、文件長度正規化）不在 Node 端重現，
 * 改用「命中的相異查詢詞數 ÷ √文件詞數」——命中越多越前、文件越長越吃虧，
 * 與 ts_rank 的方向一致。它唯一的職責是讓前 10 名的**集合**跟 SQL 對得起來（Jaccard ≥ 0.9），
 * 不是重寫一份 PostgreSQL。D-R2 的 Jaccard 若掉下來，第一個該懷疑的就是這個近似。
 *
 * @param {string[]} queryTokens
 * @param {Array<object>} cands
 * @returns {Array<{id:number, score:number}>}
 */
function rankKeyword(queryTokens, cands) {
    const qset = new Set(queryTokens.filter(t => t && t.length >= 2));
    if (qset.size === 0) return [];            // queryTokens 為空時安全回空集合（interfaces 第 5 條）
    const rows = [];
    for (const q of cands) {
        const docTokens = tokenize(buildEmbedText(q));
        if (docTokens.length === 0) continue;
        const docSet = new Set(docTokens);
        let matched = 0;
        for (const t of qset) if (docSet.has(t)) matched++;
        if (matched === 0) continue;
        rows.push({ id: q.id, score: matched / Math.sqrt(docTokens.length) });
    }
    rows.sort((a, b) => b.score - a.score || a.id - b.id);
    return rows;
}

/** @param {Array<{id:number}>} rows @returns {Map<number,number>} id → 名次（1 起算） */
function toRankMap(rows) {
    const m = new Map();
    rows.slice(0, SIDE_LIMIT).forEach((r, i) => m.set(r.id, i + 1));
    return m;
}

/** min-max 正規化到 0~1；全等時一律給 1（避免除以 0 把整側歸零） */
function minMax(rows) {
    const m = new Map();
    if (rows.length === 0) return m;
    const vals = rows.slice(0, SIDE_LIMIT);
    const lo = Math.min(...vals.map(r => r.score));
    const hi = Math.max(...vals.map(r => r.score));
    for (const r of vals) m.set(r.id, hi === lo ? 1 : (r.score - lo) / (hi - lo));
    return m;
}

/**
 * hybrid 欄：兩側各取前 50 後融合，輸出欄位與 interfaces 第 5 條的結果集一致。
 * @param {object} opts
 * @param {Array<{id:number,score:number}>} opts.vectorRows
 * @param {Array<{id:number,score:number}>} opts.keywordRows
 * @param {'rrf'|'weighted'} [opts.mode='rrf']
 * @param {number} [opts.limit=10]
 * @returns {Array<{id:number, score:number, vec_rank:number|null, kw_rank:number|null}>}
 */
function fuse(opts) {
    const mode = opts.mode || 'rrf';
    const limit = opts.limit || 10;
    const vecRank = toRankMap(opts.vectorRows);
    const kwRank = toRankMap(opts.keywordRows);
    const ids = new Set([...vecRank.keys(), ...kwRank.keys()]);

    let vecNorm = null, kwNorm = null;
    if (mode === 'weighted') {
        vecNorm = minMax(opts.vectorRows);
        kwNorm = minMax(opts.keywordRows);
    }

    const rows = [...ids].map(id => {
        const vr = vecRank.has(id) ? vecRank.get(id) : null;
        const kr = kwRank.has(id) ? kwRank.get(id) : null;
        let score;
        if (mode === 'rrf') {
            score = (vr === null ? 0 : 1 / (RRF_K + vr)) + (kr === null ? 0 : 1 / (RRF_K + kr));
        } else {
            score = 0.7 * (vecNorm.get(id) || 0) + 0.3 * (kwNorm.get(id) || 0);
        }
        return { id, score, vec_rank: vr, kw_rank: kr };
    });
    rows.sort((a, b) => b.score - a.score || a.id - b.id);
    return rows.slice(0, limit);
}

/**
 * 一次算完三欄。沒有向量時 vector / hybrid 回 null（呼叫端負責顯示 n/a），
 * **不**退回成「只有關鍵字的 hybrid」——那會讓報表上的 hybrid 欄是假的。
 *
 * @param {object} opts
 * @param {object} opts.source
 * @param {Array<object>} opts.questions
 * @param {(q:object)=>number[]|null} [opts.vectorOf]
 * @param {'chapter'|'subject'|'all'} [opts.scope]
 * @param {number[]} [opts.excludeIds]
 * @param {'rrf'|'weighted'} [opts.fuseMode]
 * @param {number} [opts.limit=10]
 * @returns {{like:number[], vector:number[]|null, hybrid:number[]|null, keywords:string[], candidateCount:number}}
 */
function rankAll(opts) {
    const cands = candidates(opts);
    const limit = opts.limit || 10;
    const like = rankLike(opts.source, cands).slice(0, limit).map(r => r.id);

    const vectorOf = opts.vectorOf;
    const queryVec = vectorOf ? vectorOf(opts.source) : null;
    if (!vectorOf || !queryVec) {
        return { like, vector: null, hybrid: null, keywords: likeKeywords(opts.source), candidateCount: cands.length };
    }

    const vectorRows = rankVector(queryVec, cands, vectorOf);
    const keywordRows = rankKeyword(tokenize(buildEmbedText(opts.source)), cands);
    const hybridRows = fuse({ vectorRows, keywordRows, mode: opts.fuseMode, limit });

    return {
        like,
        vector: vectorRows.slice(0, limit).map(r => r.id),
        hybrid: hybridRows.map(r => r.id),
        hybridRows,
        keywords: likeKeywords(opts.source),
        candidateCount: cands.length
    };
}

module.exports = { candidates, rankLike, rankVector, rankKeyword, fuse, rankAll, cosine, RRF_K, SIDE_LIMIT };
