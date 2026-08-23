// agents/dedup.js — 去重節點（A-T10c / WS-C）
//
// 一個檔案服務兩個節點（介面 §10.1 的所有權表只給 WS-C 一支 agents/dedup.js）：
//
//   dedup0（state=extracted）：normalizeStem → sha256 → 比對 questions.text_hash
//                              與同 job 內較小 idx 的列。**在任何 LLM 呼叫之前**，
//                              重複題連一毛錢都不必花。
//   dedup1（state=verified）： 向量餘弦。≥ DEDUP_DUP_THRESHOLD → duplicate；
//                              ≥ DEDUP_VARIANT_THRESHOLD → variant（照常入庫、記候選）；
//                              來源題沒有向量或 FEATURE_SIMILAR 關掉 → skipped。
//
// runner 若用 `require('../agents/' + node)` 動態載入，agents/dedup0.js 與 agents/dedup1.js
// 是兩支三行的轉接檔；直接 require 本檔時 run() 會依 input 的形狀自己分辨。
//
// 合約：docs/interfaces-stage2.md 第 3.1／3.3 條，run(ctx, input) → Outcome，**不得 throw**。

const pgvector = require('pgvector');

const { textHash, normalizeStem } = require('../utils/normalizeStem');

const DEFAULT_DUP = 0.97;
const DEFAULT_VARIANT = 0.90;
const TOP_N = 5;

/** 供應商例外 → errorClass（介面第 2 條的九個值） */
function classifyError(err) {
    const msg = String((err && err.message) || err || '');
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return 'timeout';
    if (/abort|timeout|逾時/i.test(msg)) return 'timeout';
    if (/429|rate.?limit|quota|resource_exhausted/i.test(msg)) return 'rate_limited';
    return 'provider_error';
}

/**
 * FEATURE_SIMILAR 是否開啟。
 * 裁決 S2-8：`ctx.config.features = { similar, pipeline }` 由 runner 從 config/features.js 組出來，
 * **agent 要知道旗標只能從這裡讀**（第 3.1 條）——所以這裡不讀 process.env、不 require
 * services/retrievalService。runner 沒給就當關閉：dedup1 一律 skipped，是安全的那一邊
 * （不會誤判重複，最多是少擋一題，L0 的雜湊仍然擋得住逐字重複）。
 */
function similarEnabled(ctx) {
    const features = ctx && ctx.config && ctx.config.features;
    return Boolean(features && features.similar);
}

// ───────────────────────── L0：雜湊 ─────────────────────────

/**
 * @param {object} ctx
 * @param {{question_text:string}} input
 * @returns {Promise<object>}  Outcome
 */
async function runDedup0(ctx, input) {
    const questionText = input && typeof input.question_text === 'string' ? input.question_text : '';
    const hash = textHash(questionText);

    if (hash === null) {
        // 正規化後整個是空的：這題連題幹都沒有，交給人看而不是默默放行
        return {
            kind: 'fail',
            reason: 'schema_invalid',
            feedback: '題幹正規化後為空字串，無法計算 text_hash。',
            data: { text_hash: null, normalized_len: 0, hit: null },
        };
    }

    const normalizedLen = normalizeStem(questionText).length;
    const base = { text_hash: hash, normalized_len: normalizedLen };

    try {
        // ① 庫內：已封存的題也算——「新拆的這題和一年前封存的那題是同一題」仍然是重複
        const dbHit = await ctx.db.query(
            'SELECT id FROM questions WHERE text_hash = $1 ORDER BY id LIMIT 1',
            [hash]
        );
        if (dbHit.rows.length) {
            return {
                kind: 'fail',
                reason: 'duplicate',
                feedback: `與題庫既有的 #${dbHit.rows[0].id} 題幹完全相同。`,
                data: { ...base, hit: { scope: 'db', question_id: dbHit.rows[0].id } },
            };
        }

        // ② 同一份 PDF 內較早出現的題（同一份考卷把同一題印兩次也算重複）
        if (ctx.job && ctx.jq) {
            const jobHit = await ctx.db.query(
                `SELECT id, idx FROM job_questions
                  WHERE job_id = $1 AND idx < $2 AND payload -> 'dedup0' ->> 'text_hash' = $3
                  ORDER BY idx LIMIT 1`,
                [ctx.job.id, ctx.jq.idx, hash]
            );
            if (jobHit.rows.length) {
                return {
                    kind: 'fail',
                    reason: 'duplicate',
                    feedback: `與同一份任務中較早的第 ${jobHit.rows[0].idx} 題題幹完全相同。`,
                    data: { ...base, hit: { scope: 'job', jq_id: jobHit.rows[0].id } },
                };
            }
        }
    } catch (err) {
        return { kind: 'error', errorClass: classifyError(err), message: String((err && err.message) || err) };
    }

    return { kind: 'pass', data: { ...base, hit: null } };
}

// ───────────────────────── L1：向量 ─────────────────────────

/** 取查詢向量：有 question_id 就用它已存的向量，否則把 embed_text 送去算 */
async function queryVector(ctx, input) {
    if (input.question_id !== null && input.question_id !== undefined) {
        const { rows } = await ctx.db.query(
            'SELECT embedding FROM questions WHERE id = $1',
            [input.question_id]
        );
        const raw = rows.length ? rows[0].embedding : null;
        if (!raw) return null;                       // 來源題沒向量 → skipped
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    const text = typeof input.embed_text === 'string' ? input.embed_text.trim() : '';
    if (text === '') return null;
    const res = await ctx.llm.embed({ texts: [text] });
    const vec = res && Array.isArray(res.vectors) ? res.vectors[0] : null;
    return Array.isArray(vec) && vec.length ? vec : null;
}

/**
 * @param {object} ctx
 * @param {{question_id:number|null, embed_text:string, subject:string, chapter:string,
 *          exclude_family_root?:number|null}} input
 *        `exclude_family_root` 是階段 3 新增的**選用**鍵（裁決 S3-14）：非 null 時
 *        候選 SQL 多一條 `AND COALESCE(variant_of, id) <> $root`，排除藍本整個家族。
 * @returns {Promise<object>}  Outcome
 */
async function runDedup1(ctx, input) {
    const inp = input || {};
    const th = (ctx.config && ctx.config.thresholds) || {};
    const dupTh = Number.isFinite(th.dedupDup) ? th.dedupDup : DEFAULT_DUP;
    const variantTh = Number.isFinite(th.dedupVariant) ? th.dedupVariant : DEFAULT_VARIANT;

    if (!similarEnabled(ctx)) {
        return { kind: 'skipped', data: { verdict: 'skipped', threshold_used: dupTh, top: [] } };
    }

    let vector;
    try {
        vector = await queryVector(ctx, inp);
    } catch (err) {
        return { kind: 'error', errorClass: classifyError(err), message: String((err && err.message) || err) };
    }
    if (!vector) {
        return { kind: 'skipped', data: { verdict: 'skipped', threshold_used: dupTh, top: [] } };
    }

    // 候選只限同一個學科，**不限章節**：分類漂移的重複題正是最該抓到的那一種。
    // 向量在 services/llm 已做 L2 正規化，餘弦 = 1 - (<=> 距離)。
    //
    // 階段 3（interfaces-stage3.md 第 4.6 條、裁決 S3-14）：**選用**的第五個 input 鍵
    // `exclude_family_root`。給了就多一條 `AND COALESCE(q.variant_of, q.id) <> $4`——
    // 新生成的變式一定與自己的藍本極為相似，不排掉家族的話每一題都會被判 duplicate。
    // **沒給這個鍵時，SQL 與參數陣列與階段 2 逐位元相同**（PDF job 完全不受影響），
    // 所以這裡是「多接一段字串」而不是「加一個恆真的條件」。
    const familyRoot = Number.isInteger(inp.exclude_family_root) ? inp.exclude_family_root : null;
    let rows;
    try {
        const values = [pgvector.toSql(vector), inp.subject, inp.question_id ?? null];
        let familyClause = '';
        if (familyRoot !== null) {
            values.push(familyRoot);
            familyClause = `\n                AND COALESCE(variant_of, id) <> $${values.length}`;
        }
        const res = await ctx.db.query(
            `SELECT id, 1 - (embedding <=> $1::vector) AS cosine
               FROM questions
              WHERE embedding IS NOT NULL
                AND archived_at IS NULL
                AND subject = $2
                AND ($3::int IS NULL OR id <> $3)${familyClause}
              ORDER BY embedding <=> $1::vector
              LIMIT ${TOP_N}`,
            values
        );
        rows = res.rows;
    } catch (err) {
        return { kind: 'error', errorClass: classifyError(err), message: String((err && err.message) || err) };
    }

    const top = rows.map(r => ({ question_id: r.id, cosine: Number(r.cosine) }))
        .sort((a, b) => b.cosine - a.cosine);
    const best = top.length ? top[0] : null;

    if (best && best.cosine >= dupTh) {
        return {
            kind: 'fail',
            reason: 'duplicate',
            feedback: `與 #${best.question_id} 的語意相似度 ${best.cosine.toFixed(4)} ≥ ${dupTh}，視為重複。`,
            data: { verdict: 'duplicate', threshold_used: dupTh, top },
        };
    }
    if (best && best.cosine >= variantTh) {
        // 變式題照常入庫，只把候選記進 payload 供階段 3 的變式題生成使用
        return { kind: 'pass', data: { verdict: 'variant', threshold_used: variantTh, top } };
    }
    return { kind: 'pass', data: { verdict: 'unique', threshold_used: dupTh, top } };
}

// ───────────────────────── 分派 ─────────────────────────

/**
 * 依節點名或 input 的形狀決定要跑 L0 還是 L1。
 * runner 若能提供 ctx.node（'dedup0' / 'dedup1'）就以它為準，否則看 input：
 * dedup1 的 input 一定有 embed_text（介面第 3.3 條），dedup0 只有 question_text。
 */
async function run(ctx, input) {
    const node = ctx && ctx.node;
    if (node === 'dedup0') return runDedup0(ctx, input);
    if (node === 'dedup1') return runDedup1(ctx, input);
    if (input && Object.prototype.hasOwnProperty.call(input, 'embed_text')) return runDedup1(ctx, input);
    return runDedup0(ctx, input);
}

module.exports = { run, runDedup0, runDedup1, DEFAULT_DUP, DEFAULT_VARIANT, TOP_N };
