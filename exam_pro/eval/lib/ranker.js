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
// 融合公式照 docs/interfaces-stage1.md 第 5 條逐字實作，不自己發明：
//   mode='rrf'      score = 1/(60+vec_rank) + 1/(60+kw_rank)（缺席側以 0 計）
//   mode='weighted' score = 0.7×向量側 + 0.3×關鍵字側（兩側各自在候選集內 min-max 正規化）
//   排序 ORDER BY score DESC, id ASC
// ─────────────────────────────────────────────────────────────

const { likeKeywords } = require('./pooling');
// 分詞與 embed_text 不在本檔直接呼叫：關鍵字側的 token 一律經 embedService.buildTsvTokens()
// （裁決 21），LIKE 欄的關鍵字一律經 pooling.likeKeywords()（凍結規則）。
const { buildTsvTokens } = require('../../services/embedService');

const RRF_K = 60;        // interfaces 第 5 條寫死的 RRF 常數
const SIDE_LIMIT = 50;   // 兩側各自 ORDER BY r LIMIT 50 之後才 FULL OUTER JOIN

// ts_rank 的預設權重 {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}。
// embedService 的 search_tsv 是 章節 A ‖ keywords A ‖ 題幹 B（interfaces 第 2 條、裁決 21），
// 記憶體端要對得上 SQL 的排序，就得用同一組權重，不能一視同仁。
const TS_WEIGHT_A = 1.0;
const TS_WEIGHT_B = 0.4;

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
 * 一題的 search_tsv token → 權重表。
 *
 * token 的來源**必須**是 services/embedService.js 的 buildTsvTokens()（interfaces 裁決 21：
 * 寫入、回填、eval 三處只能呼叫同一支純函式）。自己在這裡 tokenize(buildEmbedText(q))
 * 會漏掉章節段的兩種切法與 keywords 段，記憶體排序器就不再是 SQL 的對照組。
 *
 * @param {object} q
 * @returns {Map<string, number>} token → 權重（同一個 token 出現在多段時取最大者，同 ts_rank）
 */
function tsvWeights(q) {
    const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(q);
    const w = new Map();
    const put = (tokens, weight) => {
        for (const t of tokens) {
            if (!t) continue;
            if (!w.has(t) || w.get(t) < weight) w.set(t, weight);
        }
    };
    put(stemTokens, TS_WEIGHT_B);
    put(chapterTokens, TS_WEIGHT_A);
    put(keywordTokens, TS_WEIGHT_A);
    return w;
}

/**
 * 來源題的關鍵字側查詢詞。
 *
 * 對齊 services/retrievalService.js 的 queryTokensForSource()：prod 取的是來源題
 * search_tsv 裡**權重 A** 的詞（＝寫入時的章節段與 keywords 段），沒有才退回題幹。
 * 這裡不查 DB，直接從 buildTsvTokens() 拿同樣那兩段——seedFixture 寫進去的權重 A
 * 就是它們，所以兩邊等價，而且記憶體 engine 不需要 DB 也能算。
 *
 * 為什麼不沿用「對整段 embed_text 分詞」：那不是 prod 會送出的查詢詞。
 * eval 若用一組 prod 不會用的查詢詞，量到的 hybrid 分數就不是 /similar 的分數。
 *
 * @param {object} source
 * @returns {string[]}
 */
function queryTokensFor(source) {
    const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(source);
    const weightA = [...new Set([...chapterTokens, ...keywordTokens])];
    return weightA.length ? weightA : stemTokens;
}

/**
 * hybrid 的關鍵字側：對應 SQL 的 to_tsquery('simple', 'tok1 | tok2 | …') + ts_rank。
 *
 * 這裡是**近似**：ts_rank 的詞頻與文件長度正規化細節不在 Node 端重現，
 * 改用「命中的相異查詢詞的權重和 ÷ √文件詞數」——命中越多越前、命中權重 A 的段更前、
 * 文件越長越吃虧，三個方向都與 ts_rank 一致。它唯一的職責是讓前 10 名的**集合**
 * 跟 SQL 對得起來（Jaccard ≥ 0.9），不是重寫一份 PostgreSQL。
 * D-R2 的 Jaccard 若掉下來，第一個該懷疑的就是這個近似。
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
        const weights = tsvWeights(q);
        if (weights.size === 0) continue;
        let score = 0;
        for (const t of qset) if (weights.has(t)) score += weights.get(t);
        if (score === 0) continue;
        rows.push({ id: q.id, score: score / Math.sqrt(weights.size) });
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
    const keywordRows = rankKeyword(queryTokensFor(opts.source), cands);
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

module.exports = {
    candidates, rankLike, rankVector, rankKeyword, queryTokensFor, tsvWeights,
    fuse, rankAll, cosine, RRF_K, SIDE_LIMIT, TS_WEIGHT_A, TS_WEIGHT_B
};
