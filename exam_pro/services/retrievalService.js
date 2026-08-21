// services/retrievalService.js — 相似題檢索與 GET /api/questions/:id/similar（WS-C / D-R1）
//
// 介面凍結於 docs/interfaces.md 第 6 條：
//   200 → { source_id, mode, results: [{ id, subject, chapter, question_type, difficulty, question_text, score, … }] }
//   404 → :id 不存在或已封存
//   409 → { message: '該題尚未建立向量，請執行 npm run embed:backfill' }
//   FEATURE_SIMILAR 未開啟時路由不掛載（回 404）
//
// 查詢向量**直接取來源題的 embedding，不呼叫 Gemini**，所以這個端點可離線、可進 CI。
// 檢索 SQL 一律走 queries/hybrid.js，與 eval 是同一段。

const { buildHybridQuery } = require('../queries/hybrid');
const { tokenize } = require('../utils/tokenize');

const DEFAULT_K = 10;
const MAX_K = 20;

/** interfaces.md 第 9 條凍結的布林解讀：字串 1 或 true（不分大小寫）為真，其餘皆為假 */
function parseBool(value) {
    const s = String(value ?? '').trim().toLowerCase();
    return s === '1' || s === 'true';
}

/**
 * FEATURE_SIMILAR 是否開啟。
 * 旗標集中在 config/features.js（WS-A 建立）；那支還沒合入前先讀環境變數，
 * 合入後自動以它為準（同時支援 {FEATURE_SIMILAR} 與 isEnabled('FEATURE_SIMILAR') 兩種形狀）。
 */
function isSimilarEnabled() {
    try {
        const features = require('../config/features');
        if (features) {
            if (typeof features.FEATURE_SIMILAR === 'boolean') return features.FEATURE_SIMILAR;
            if (typeof features.isEnabled === 'function') return Boolean(features.isEnabled('FEATURE_SIMILAR'));
            if (features.FEATURE_SIMILAR !== undefined) return parseBool(features.FEATURE_SIMILAR);
        }
    } catch (e) { /* config/features.js 尚未存在：退回環境變數 */ }
    return parseBool(process.env.FEATURE_SIMILAR);
}

/** 取得 pg 版的 { pool, query }（interfaces.md 第 8 條） */
function resolveDb(injected) {
    const db = injected || require('../config/db');
    if (!db || typeof db.query !== 'function' || !db.pool || typeof db.pool.connect !== 'function') {
        throw new Error('需要 pg 版的 { pool, query }（interfaces.md 第 8 條）。config/db.js 在 WS-A 的 D-D3 合入前仍是 mysql2。');
    }
    return db;
}

/** 夾在 [min, max] 之間 */
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * 解析 querystring。數值類一律夾進合法範圍（不另外發明 400 契約），
 * 列舉類（mode/scope）給錯才回 400——默默換成別的模式會讓 eval 量到不是它要的東西。
 * @returns {{ok:true, params:object} | {ok:false, message:string}}
 */
function parseSimilarQuery(query = {}) {
    const rawK = query.k ?? query.limit;          // k 為主，limit 是別名
    const k = Number.isFinite(Number(rawK)) && String(rawK).trim() !== ''
        ? clamp(Math.trunc(Number(rawK)), 1, MAX_K)
        : DEFAULT_K;

    const mode = String(query.mode ?? 'hybrid');
    if (!['hybrid', 'vector', 'keyword'].includes(mode)) {
        return { ok: false, message: 'mode 只接受 hybrid / vector / keyword。' };
    }

    // 裁決 19：拿掉 scope=all（跨學科相似題教學上無意義，也無法用同一段 SQL 表達）。
    // 給 all 一律 400，不悄悄降級成 subject——降級會讓呼叫端以為自己拿到的是跨科結果。
    const scope = String(query.scope ?? 'chapter');
    if (!['chapter', 'subject'].includes(scope)) {
        return { ok: false, message: 'scope 只接受 chapter / subject。' };
    }

    let difficultyDelta = null;
    if (query.difficulty_delta !== undefined && String(query.difficulty_delta).trim() !== '') {
        const d = Number(query.difficulty_delta);
        if (!Number.isFinite(d)) return { ok: false, message: 'difficulty_delta 必須是 -4 ~ 4 的整數。' };
        difficultyDelta = clamp(Math.trunc(d), -4, 4);
    }

    const rawStudent = query.student_id;
    const studentId = Number.isInteger(Number(rawStudent)) && String(rawStudent ?? '').trim() !== ''
        ? Number(rawStudent)
        : null;

    return { ok: true, params: { k, mode, scope, difficultyDelta, studentId } };
}

/** mode → buildHybridQuery 的 sides */
function sidesForMode(mode) {
    if (mode === 'vector') return ['vec'];
    if (mode === 'keyword') return ['kw'];
    return ['vec', 'kw'];
}

/**
 * 來源題的關鍵字側查詢詞。
 * 優先用 search_tsv 裡權重 A 的詞（＝寫入時的章節與 keywords，已經過 tokenize），
 * 沒有就退回章節＋keywords，再沒有就退回題幹——三條路都走同一支 tokenize()。
 */
async function queryTokensForSource(db, source) {
    const { rows } = await db.query(
        `SELECT array_agg(lexeme ORDER BY lexeme) AS tokens
           FROM unnest((SELECT search_tsv FROM questions WHERE id = $1))
          WHERE 'A' = ANY(weights)`,
        [source.id]
    );
    const weightA = rows[0]?.tokens || [];
    if (weightA.length) return weightA;

    const fallback = [...new Set([
        ...tokenize(source.chapter),
        ...tokenize(Array.isArray(source.keywords) ? source.keywords.join(' ') : ''),
    ])];
    if (fallback.length) return fallback;
    return tokenize(source.question_text);
}

/**
 * 找出與來源題相似的題目。
 *
 * @param {number} sourceId
 * @param {{k?:number, mode?:string, scope?:string, difficultyDelta?:number|null, studentId?:number|null, db?:object}} opts
 * @returns {Promise<{status:number, body:object}>}  直接對應 HTTP 狀態與回應主體
 */
async function findSimilar(sourceId, opts = {}) {
    const db = resolveDb(opts.db);
    const k = clamp(Math.trunc(opts.k ?? DEFAULT_K), 1, MAX_K);
    const mode = opts.mode ?? 'hybrid';
    const scope = opts.scope ?? 'chapter';
    const difficultyDelta = opts.difficultyDelta ?? null;
    const studentId = opts.studentId ?? null;

    if (!Number.isInteger(sourceId)) {
        return { status: 400, body: { message: '無效的題目 ID' } };
    }
    // 直接呼叫 findSimilar（不經 HTTP）的呼叫端也要擋：裁決 19 之後沒有 scope=all
    if (!['chapter', 'subject'].includes(scope)) {
        return { status: 400, body: { message: 'scope 只接受 chapter / subject。' } };
    }

    // 已封存題視同不存在（與候選池「一律排除已封存」同一條線）
    const { rows: srcRows } = await db.query(
        `SELECT id, subject, chapter, difficulty, question_text, keywords, embedding
           FROM questions WHERE id = $1 AND archived_at IS NULL`,
        [sourceId]
    );
    const source = srcRows[0];
    if (!source) return { status: 404, body: { message: '找不到該題目' } };
    if (!source.embedding && mode !== 'keyword') {
        return { status: 409, body: { message: '該題尚未建立向量，請執行 npm run embed:backfill' } };
    }

    // vector 欄位讀回來是字串（'[0.1,0.2,…]'）
    const queryVector = source.embedding ? JSON.parse(source.embedding) : null;
    const queryTokens = mode === 'vector' ? [] : await queryTokensForSource(db, source);

    // 難度：給了 delta 就鎖定「來源難度 + delta」，沒給就 ±1（interfaces.md 第 6 條）
    const difficultyMin = difficultyDelta === null ? clamp(source.difficulty - 1, 1, 5) : clamp(source.difficulty + difficultyDelta, 1, 5);
    const difficultyMax = difficultyDelta === null ? clamp(source.difficulty + 1, 1, 5) : clamp(source.difficulty + difficultyDelta, 1, 5);

    // scope 只有 chapter 與 subject（裁決 19 拿掉了 all）：候選一律限定在來源題的學科內，
    // 因此永遠是同一段 SQL 跑一次，排序直接就是最終順序。
    const chapter = scope === 'chapter' ? source.chapter : null;

    const { text, values } = buildHybridQuery({
        subject: source.subject,
        chapter,
        difficultyMin,
        difficultyMax,
        excludeStudentId: studentId,
        excludeIds: [source.id],          // /similar 必須排除來源題本身
        queryVector,
        queryTokens,
        mode: 'rrf',
        limit: k,
        sides: sidesForMode(mode),
    });

    const client = await db.pool.connect();
    let ranked;
    try {
        await client.query('BEGIN');
        // 召回深度：交易內設定，eval 為求等效精確會調得更高（interfaces.md 第 5 條）
        await client.query('SET LOCAL hnsw.ef_search = 100');
        ranked = (await client.query(text, values)).rows;
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    if (ranked.length === 0) return { status: 200, body: { source_id: source.id, mode, results: [] } };

    // 顯示欄位另外撈：hybrid SQL 的結果集只回 id/score/vec_rank/kw_rank（凍結）
    const { rows: detailRows } = await db.query(
        `SELECT id, subject, chapter, question_type, difficulty, question_text
           FROM questions WHERE id = ANY($1::int[])`,
        [ranked.map(r => r.id)]
    );
    const detailById = new Map(detailRows.map(r => [r.id, r]));

    const results = ranked.map(r => ({
        ...detailById.get(r.id),
        score: r.score,
        vec_rank: r.vec_rank,      // 除錯欄位；消費端必須忽略未知鍵
        kw_rank: r.kw_rank,
    }));

    return { status: 200, body: { source_id: source.id, mode, results } };
}

/**
 * Express handler：GET /api/questions/:id/similar
 * 掛在 routes/index.js 的 WS-C 區塊，位置在 apiKeyAuth 之後並套 createRateLimiter。
 */
async function similarQuestionsHandler(req, res, next) {
    try {
        const parsed = parseSimilarQuery(req.query);
        if (!parsed.ok) return res.status(400).json({ message: parsed.message });

        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });

        const { status, body } = await findSimilar(id, { ...parsed.params, db: req.app?.locals?.db });
        return res.status(status).json(body);
    } catch (err) {
        return next(err);
    }
}

module.exports = { findSimilar, similarQuestionsHandler, parseSimilarQuery, isSimilarEnabled, sidesForMode, DEFAULT_K, MAX_K };
