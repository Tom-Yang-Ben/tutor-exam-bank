// ─────────────────────────────────────────────────────────────
// services/variantService.js — POST /api/questions/:id/variants（P-10／P-12）
//
// 介面凍結於 docs/interfaces-stage3.md 第 3 條：
//   200 → { mode:'retrieved', questions:[{…/similar 的 results 形狀…, cosine}] }   零 LLM 費用
//   202 → { mode:'generating', job_id, state, existing }
//   400 → { message:'無效的題目 ID' } 與四個參數的訊息字串（逐字凍結）
//   404 → { message:'找不到該題目' }（:id 不存在**或已封存**，與 /similar 同一條線）
//   409 → { message:'該題尚未建立向量，請執行 npm run embed:backfill' }（與 /similar 逐字相同）
//   FEATURE_VARIANTS 未開啟時路由不掛載（落到 404）
//
// 「先檢索、再生成」是這一支的全部重點（規劃 §4.3.2）：庫裡本來就有夠用的相似題時，
// 一次 LLM 都不要呼叫。retrieved 分支的查詢向量**直接取藍本的 embedding**，
// 所以連 embedding 服務都不必連，可離線、可進 CI。
//
// 為什麼這一支自己下一段帶 `<=>` 的 SQL，不共用 queries/hybrid.js（裁決 S3-7）：
// `VARIANT_SIM_MIN` 是**餘弦**門檻，而 buildHybridQuery 的 score 是 RRF 融合分數，
// 拿 RRF 分數去比餘弦門檻是量錯東西。本端點的 `score` 因此就等於 `cosine`（兩鍵同值）。
// ─────────────────────────────────────────────────────────────

const DEFAULT_COUNT = 1;
const DEFAULT_MAX_PER_REQUEST = 3;
const DEFAULT_SIM_MIN = 0.80;
const DEFAULT_TOKEN_BUDGET_USD = 0.30;

/** 一個變式 job 只要還沒收工，同一個藍本的新請求就合流到它身上（裁決 S3-8） */
const ACTIVE_JOB_STATES = ['queued', 'extracting', 'processing'];

const MSG = {
    invalidId: '無效的題目 ID',
    notFound: '找不到該題目',
    noVector: '該題尚未建立向量，請執行 npm run embed:backfill',
    rateLimit: '變式題請求過於頻繁，請稍候再試（每分鐘最多 10 次）。'
};

// ───────────────────────── 設定（service 層可以讀 env，agent 不行）─────────────────────────

function intEnv(name, dflt, env = process.env) {
    const n = Number.parseInt(env[name], 10);
    return Number.isFinite(n) ? n : dflt;
}

function numEnv(name, dflt, env = process.env) {
    const n = Number.parseFloat(env[name]);
    return Number.isFinite(n) ? n : dflt;
}

/** 單次請求最多生幾題（`count` 的上限，第 9 條） */
function maxPerRequest(env = process.env) {
    return Math.max(1, intEnv('VARIANT_MAX_PER_REQUEST', DEFAULT_MAX_PER_REQUEST, env));
}

/**
 * retrieved 分支的餘弦下限（裁決 S3-R9：`VARIANT_RETRIEVE_SIM_MIN`）。
 *
 * 原本這裡與 `agents/generateVariant.js` 的跑題閾值共用一個 `VARIANT_SIM_MIN`，
 * 但兩者的最佳值方向相反（`docs/variants.md` 第 3 節的實測）：
 *   - 當**檢索下限**用，低一點好——門檻越高，能直接推薦的題越少、越常要花錢生成；
 *   - 當**跑題閾值**用，高一點好——0.80 時跨章的題有 12% 過得了。
 * 所以拆成兩個變數，這一支只讀 `VARIANT_RETRIEVE_SIM_MIN`。
 *
 * 舊名 `VARIANT_SIM_MIN` 仍是**退路**（只在新變數沒設時生效），讓還沒更新 `.env` 的環境
 * 行為不變；`.env.example` 註明過渡期後移除。
 */
function simMin(env = process.env) {
    return numEnv('VARIANT_RETRIEVE_SIM_MIN', numEnv('VARIANT_SIM_MIN', DEFAULT_SIM_MIN, env), env);
}

/** 每個變式 job 的成本上限，建立時複製進 jobs.budget_usd */
function tokenBudgetUsd(env = process.env) {
    return numEnv('VARIANT_TOKEN_BUDGET_USD', DEFAULT_TOKEN_BUDGET_USD, env);
}

/**
 * FEATURE_VARIANTS 是否開啟（旗標一律經 config/features.js，interfaces.md 第 9 條）。
 * @returns {boolean}
 */
function isVariantsEnabled() {
    return require('../config/features').isEnabled('FEATURE_VARIANTS');
}

/** 取得 pg 版的 { pool, query }（interfaces.md 第 8 條） */
function resolveDb(injected) {
    return injected || require('../config/db');
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// ───────────────────────── 純函式：body 解析 ─────────────────────────

/**
 * 解析 body。四個欄位全部選填，型別不合一律 400（訊息逐字凍結於第 3 條）。
 *
 * 刻意**不**做「不合法就默默用預設值」：`count: 99` 靜靜變成 1 的話，
 * 呼叫端會以為自己拿到了 99 題的結果。
 *
 * @param {object} body
 * @param {number} [max] VARIANT_MAX_PER_REQUEST，預設讀環境變數
 * @returns {{ok:true, params:{count:number, difficultyDelta:number, studentId:number|null, forceGenerate:boolean}}
 *          |{ok:false, message:string}}
 */
function parseVariantBody(body = {}, max = maxPerRequest()) {
    const b = body || {};

    let count = DEFAULT_COUNT;
    if (b.count !== undefined && b.count !== null) {
        const n = Number(b.count);
        if (!Number.isInteger(n) || n < 1 || n > max) {
            return { ok: false, message: `count 必須是 1~${max} 的整數。` };
        }
        count = n;
    }

    let difficultyDelta = 0;
    if (b.difficulty_delta !== undefined && b.difficulty_delta !== null) {
        const d = Number(b.difficulty_delta);
        if (![-1, 0, 1].includes(d)) return { ok: false, message: 'difficulty_delta 只接受 -1、0、1。' };
        difficultyDelta = d;
    }

    let studentId = null;
    if (b.student_id !== undefined && b.student_id !== null) {
        const s = Number(b.student_id);
        if (!Number.isInteger(s) || s <= 0) return { ok: false, message: 'student_id 必須是正整數。' };
        studentId = s;
    }

    let forceGenerate = false;
    if (b.force_generate !== undefined && b.force_generate !== null) {
        if (typeof b.force_generate !== 'boolean') return { ok: false, message: 'force_generate 必須是布林值。' };
        forceGenerate = b.force_generate;
    }

    return { ok: true, params: { count, difficultyDelta, studentId, forceGenerate } };
}

// ───────────────────────── 純函式：retrieved 分支的 SQL ─────────────────────────

/**
 * 第 3.1 條的八個條件，逐條寫在同一段 SQL 裡。純函式：只組字串與參數，不連 DB。
 *
 * 參數順序凍結為 `$1=vec、$2=subject、$3=sourceId、$4=familyRoot、$5=difficulty、
 * $6=studentId、$7=simMin、$8=limit`——純文字單測擋不了 SQL 語法錯，只擋得住參數錯位，
 * 那是它唯一的職責（同 weaknessService 的 S3-4）。
 *
 * `ORDER BY cosine DESC` 用的是**輸出別名單獨出現**，PostgreSQL 允許；
 * 會炸的是 `ORDER BY 1 - (embedding <=> …)` 這種運算式裡引用別名（規劃 §4.3.5）。
 *
 * @param {{vectorLiteral:string, subject:string, sourceId:number, familyRoot:number,
 *          difficulty:number, studentId:number|null, simMin:number, limit:number}} opts
 * @returns {{text:string, values:any[]}}
 */
function buildRetrievedQuery(opts) {
    const text = `
        SELECT q.id, q.subject, q.chapter, q.question_type, q.difficulty, q.question_text,
               1 - (q.embedding <=> $1::vector) AS cosine
          FROM questions q
         WHERE q.subject = $2
           AND q.archived_at IS NULL
           AND q.id <> $3
           AND q.embedding IS NOT NULL
           AND COALESCE(q.variant_of, q.id) <> $4
           AND q.difficulty = $5
           AND ($6::int IS NULL OR NOT EXISTS (
                   SELECT 1 FROM attempts a
                    WHERE a.question_id = q.id AND a.student_id = $6::int))
           AND 1 - (q.embedding <=> $1::vector) >= $7::float8
         ORDER BY cosine DESC, id ASC
         LIMIT $8`;
    return {
        text,
        values: [opts.vectorLiteral, opts.subject, opts.sourceId, opts.familyRoot,
            opts.difficulty, opts.studentId, opts.simMin, opts.limit]
    };
}

/**
 * 把 SQL 的一列轉成回應形狀：`/similar` 的 results 形狀 + `cosine`，
 * 且 `score` **就是** `cosine`（裁決 S3-7，兩個鍵同值）。
 * @param {object} row
 * @returns {object}
 */
function toResultRow(row) {
    const cosine = Number(row.cosine);
    return {
        id: row.id,
        subject: row.subject,
        chapter: row.chapter,
        question_type: row.question_type,
        difficulty: row.difficulty,
        question_text: row.question_text,
        score: cosine,
        cosine
    };
}

// ───────────────────────── DB 存取 ─────────────────────────

/**
 * 載入藍本題。已封存視同不存在（與 /similar 同一條線）。
 * @returns {Promise<object|null>}
 */
async function loadSource(db, sourceId) {
    const { rows } = await db.query(
        `SELECT id, subject, chapter, question_type, difficulty, question_text, answer_text,
                variant_of, embedding
           FROM questions
          WHERE id = $1 AND archived_at IS NULL`,
        [sourceId]);
    return rows[0] || null;
}

/**
 * 純檢索：庫裡有沒有夠用的相似題。
 *
 * `SET LOCAL hnsw.ef_search = 100` 與 /similar 相同：候選條件收得很緊
 * （鎖定單一難度、排除整個家族、排除該生寫過的），近似索引的預設召回深度會漏掉合格的題。
 *
 * @param {object} db
 * @param {object} source           loadSource 的輸出（embedding 不可為 null）
 * @param {{count:number, difficultyDelta:number, studentId:number|null}} params
 * @param {number} [threshold]      預設讀 VARIANT_SIM_MIN
 * @returns {Promise<Array<object>>} 已是回應形狀
 */
async function findRetrieved(db, source, params, threshold = simMin()) {
    const built = buildRetrievedQuery({
        // vector 欄位讀回來是字串（'[0.1,0.2,…]'），本來就是 ::vector 吃得下的字面值
        vectorLiteral: typeof source.embedding === 'string' ? source.embedding : JSON.stringify(source.embedding),
        subject: source.subject,
        sourceId: source.id,
        familyRoot: source.variant_of ?? source.id,
        // 第 3.1 條第 7 點：字面語意——給了 delta 就鎖定單一難度（同裁決 20）
        difficulty: clamp(Number(source.difficulty) + params.difficultyDelta, 1, 5),
        studentId: params.studentId,
        simMin: threshold,
        limit: params.count
    });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL hnsw.ef_search = 100');
        const { rows } = await client.query(built.text, built.values);
        await client.query('COMMIT');
        return rows.map(toResultRow);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * 同一藍本已經在跑的變式 job（裁決 S3-8：雙擊不該付兩次錢）。
 * @returns {Promise<{id:number, state:string}|null>}
 */
async function findActiveJob(db, sourceId) {
    const { rows } = await db.query(
        `SELECT id, state FROM jobs
          WHERE kind = 'variant' AND source_question_id = $1 AND state = ANY($2::text[])
          ORDER BY id DESC LIMIT 1`,
        [sourceId, ACTIVE_JOB_STATES]);
    return rows[0] || null;
}

/**
 * 建一個變式 job（第 3.2 條）。
 *
 * **不建 job_questions**——那是 generate 節點的事（第 4 條）。
 *
 * `count` 與 `difficulty_delta` 存在同一交易內插入的那一列
 * `job_events(node='generate', outcome='skipped').detail.requested`（裁決 S3-9）：
 * 不必為兩個參數改 `0003` 的 DDL，也不必把參數塞進 `pdf_path` 這種語意不符的欄位。
 * generate 節點認領時讀「該 job 最早一列 node='generate' 的 detail.requested」。
 *
 * @returns {Promise<{job_id:number, state:string}>}
 */
async function createVariantJob(db, sourceId, params, budgetUsd = tokenBudgetUsd()) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO jobs (kind, source_question_id, pdf_sha256, pdf_path, page_count, state, budget_usd)
             VALUES ('variant', $1, NULL, NULL, NULL, 'queued', $2)
             RETURNING id, state`,
            [sourceId, budgetUsd]);
        const job = rows[0];

        await client.query(
            `INSERT INTO job_events (job_id, jq_id, node, attempt, latency_ms, outcome, cost_usd, cost_estimated, detail)
             VALUES ($1, NULL, 'generate', 1, 0, 'skipped', 0, false, $2::jsonb)`,
            [job.id, JSON.stringify({
                requested: {
                    count: params.count,
                    difficulty_delta: params.difficultyDelta,
                    student_id: params.studentId
                }
            })]);

        await client.query('COMMIT');
        return { job_id: job.id, state: job.state };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * 讀回建 job 時寫進去的請求參數（generate 節點用）。
 * 讀「最早」那一列：之後每次生成都會再寫 node='generate' 的事件，只有第一列帶 requested。
 *
 * @returns {Promise<{count:number, difficulty_delta:number, student_id:number|null}>}
 *          查不到時回預設值（count 1、delta 0），不丟錯——job 已經在跑了，不該因為
 *          少一列事件就整份失敗。
 */
async function readRequested(db, jobId) {
    const { rows } = await db.query(
        `SELECT detail FROM job_events
          WHERE job_id = $1 AND node = 'generate' AND detail ? 'requested'
          ORDER BY id ASC LIMIT 1`,
        [jobId]);
    const requested = rows[0]?.detail?.requested || {};
    const count = Number.parseInt(requested.count, 10);
    const delta = Number.parseInt(requested.difficulty_delta, 10);
    return {
        count: Number.isInteger(count) && count > 0 ? count : DEFAULT_COUNT,
        difficulty_delta: [-1, 0, 1].includes(delta) ? delta : 0,
        student_id: Number.isInteger(requested.student_id) ? requested.student_id : null
    };
}

/**
 * 變式生成的錨點鄰居（第 4.2 條）：與藍本最近的 5 題，**排除藍本整個家族**（避免近親繁殖）、
 * 排除已封存題。由 runner 查好放進 agent 的 input——agent 不得自己連 DB（第 3.1 條）。
 *
 * @param {object} db
 * @param {object} source
 * @param {number} [limit=5]
 * @returns {Promise<Array<{id:number, chapter:string, question_text:string}>>}
 */
async function findNeighbors(db, source, limit = 5) {
    if (!source || !source.embedding) return [];
    const vec = typeof source.embedding === 'string' ? source.embedding : JSON.stringify(source.embedding);
    const { rows } = await db.query(
        `SELECT q.id, q.chapter, q.question_text
           FROM questions q
          WHERE q.subject = $1
            AND q.archived_at IS NULL
            AND q.embedding IS NOT NULL
            AND COALESCE(q.variant_of, q.id) <> $2
          ORDER BY q.embedding <=> $3::vector, q.id
          LIMIT $4`,
        [source.subject, source.variant_of ?? source.id, vec, limit]);
    return rows;
}

// ───────────────────────── 端點主體 ─────────────────────────

/**
 * POST /api/questions/:id/variants 的全部邏輯（不碰 req／res，整合測試好呼叫）。
 *
 * @param {number} sourceId
 * @param {object} body
 * @param {{db?:object}} [opts]
 * @returns {Promise<{status:number, body:object}>}
 */
async function requestVariants(sourceId, body, opts = {}) {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return { status: 400, body: { message: MSG.invalidId } };
    }
    const parsed = parseVariantBody(body, maxPerRequest());
    if (!parsed.ok) return { status: 400, body: { message: parsed.message } };
    const params = parsed.params;

    const db = resolveDb(opts.db);
    const source = await loadSource(db, sourceId);
    if (!source) return { status: 404, body: { message: MSG.notFound } };
    if (!source.embedding) return { status: 409, body: { message: MSG.noVector } };

    // ── 先檢索（零 LLM 費用）──
    if (!params.forceGenerate) {
        const questions = await findRetrieved(db, source, params);
        if (questions.length >= params.count) {
            return { status: 200, body: { mode: 'retrieved', questions } };
        }
    }

    // ── 再生成：同一藍本已經在跑就合流，force_generate 不繞過（裁決 S3-8）──
    const active = await findActiveJob(db, sourceId);
    if (active) {
        return { status: 202, body: { mode: 'generating', job_id: active.id, state: active.state, existing: true } };
    }

    const created = await createVariantJob(db, sourceId, params);
    return { status: 202, body: { mode: 'generating', job_id: created.job_id, state: created.state, existing: false } };
}

/**
 * Express handler：POST /api/questions/:id/variants
 * 掛在 routes/index.js 的 [WS3-B: variants] 區塊，位置在 apiKeyAuth 之後並套 10/min 限流。
 */
async function variantsHandler(req, res, next) {
    try {
        const raw = String(req.params.id ?? '');
        const id = /^\d+$/.test(raw) ? Number(raw) : null;
        if (id === null) return res.status(400).json({ message: MSG.invalidId });

        const { status, body } = await requestVariants(id, req.body, { db: req.app?.locals?.db });
        return res.status(status).json(body);
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    variantsHandler, requestVariants,
    parseVariantBody, buildRetrievedQuery, toResultRow,
    loadSource, findRetrieved, findActiveJob, createVariantJob, readRequested, findNeighbors,
    isVariantsEnabled, maxPerRequest, simMin, tokenBudgetUsd,
    MSG, ACTIVE_JOB_STATES, DEFAULT_COUNT
};
