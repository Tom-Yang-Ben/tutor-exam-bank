// ─────────────────────────────────────────────────────────────
// services/kcTagService.js — 題目的自動知識點標註（階段 5，擁有者：WS-C）
//
// 契約：docs/interfaces-stage5.md 第 4.3 條第 3 點。
//
//   tagQuestion(questionId, deps) → 結果物件（**不丟例外給呼叫端當流程控制**；DB 連線層的例外照常往上丟）
//     1. 題目不存在                 → status 'not_found'
//     2. 已有 human 標註            → status 'skipped', reason 'has_human'（人工標註一律不動）
//     3. 該章沒有知識點             → status 'skipped', reason 'no_kcs'（不呼叫 LLM）
//     4. agents/tagKc.js 失敗／出錯 → status 'failed'（不寫任何東西）
//     5. 信心 ≥ KC_TAG_MIN_CONFIDENCE（預設 0.6）的 code 才寫入 src='ai'
//        一個都沒達標                → status 'low_confidence'（既有標註維持原樣）
//        有達標                      → 先刪該題舊的 ai 標註、再寫新的 → status 'tagged'
//
// 呼叫點有兩個：
//   - workers/jobRunner.js 的 save 掛鉤（FEATURE_KC_TAGGING 開啟才呼叫；失敗只記 log，不影響 job）
//   - scripts/backfill_kc.js（npm run kc:backfill）
//
// 環境變數只在這一層讀（agent 不得讀 process.env）：
//   KC_TAG_MIN_CONFIDENCE  預設 0.6，非法值退回預設
//   MODEL_KC_TAG           預設沿用 MODEL_TEXT（Gemini 模式下＝MODEL_EXTRACT，第 5.2 條；本機模式＝MODEL_VERIFY，
//                          docs/local-mode.md LM-15）。config/models.js 的 getter 已含這條退回，這裡先讀 env 再讀 getter
//
// 權重：AI 寫入的每一列 weight 一律是 1（與 DB 預設、人工標註未給 weight 時相同）。
// 信心另存在 confidence 欄，不拿來當比重——「模型多有把握」與「這題有多少成分在考這個觀念」是兩回事。
// ─────────────────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * 預估費用用的每題 token 數（kc:backfill 執行前印出的預估）。
 * 來源：prompt 模板約 450 字＋一章 3–8 個知識點清單（每個約 60–180 字）＋題幹與答案，
 * 中文約 1 字 1 token；輸出是 1–3 個 code 加 100 字內的 rationale。往「不低估」的方向取整。
 * 思考 token 以 output 單價計費（config/pricing.js），這裡直接取 agent 的思考上限 THINKING_BUDGET——
 * 實際多半用不滿，但預估寧可偏高。
 */
const EST_TOKENS_PER_QUESTION = Object.freeze({
    tokenIn: 1600, tokenOut: 250, tokenThinking: require('../agents/tagKc').THINKING_BUDGET
});

/**
 * 讀設定（純函式，env 可注入）。
 * @param {object} [env] 預設 process.env
 * @returns {{minConfidence:number, model:string}}
 */
function loadTagConfig(env = process.env) {
    const raw = Number.parseFloat(env.KC_TAG_MIN_CONFIDENCE);
    const minConfidence = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_CONFIDENCE;
    return { minConfidence, model: resolveModel(env) };
}

/**
 * MODEL_KC_TAG → config/models 的 getter → MODEL_TEXT → MODEL_EXTRACT（〔LM-15〕文字工作模型）。
 * @param {object} [env]
 * @returns {string}
 */
function resolveModel(env = process.env) {
    const explicit = String(env.MODEL_KC_TAG || '').trim();
    if (explicit) return explicit;
    const models = require('../config/models');
    return models.MODEL_KC_TAG || models.MODEL_TEXT || models.MODEL_EXTRACT;
}

/**
 * agent 的輸出 → 要寫的列與被丟掉的列（純函式）。
 * 伺服器端再驗一次 code 屬於該章（agent 的 ajv 已擋過；這一道是縱深防禦，
 * 萬一有人把別章的清單傳進 agent，這裡仍然只認查詢到的那一章）。
 *
 * @param {Array<{code:string, confidence:number}>} codes
 * @param {Map<string, {id:number}>} kcByCode 該章的知識點
 * @param {number} minConfidence
 * @returns {{write:Array<{kc_id:number, code:string, confidence:number}>,
 *           dropped:Array<{code:string, confidence:number, reason:'low_confidence'|'unknown_code'}>}}
 */
function decideWrites(codes, kcByCode, minConfidence) {
    const write = [];
    const dropped = [];
    const seen = new Set();
    for (const item of codes || []) {
        const code = String(item && item.code);
        const confidence = Number(item && item.confidence);
        if (seen.has(code)) continue;
        seen.add(code);
        const kc = kcByCode.get(code);
        if (!kc) { dropped.push({ code, confidence, reason: 'unknown_code' }); continue; }
        if (!(Number.isFinite(confidence) && confidence >= minConfidence)) {
            dropped.push({ code, confidence, reason: 'low_confidence' });
            continue;
        }
        write.push({ kc_id: kc.id, code, confidence: Math.min(1, confidence) });
    }
    return { write, dropped };
}

/** 模型字串 → 裸 ID（pricing 只認裸 ID） */
function bareModelId(model) {
    try {
        return require('../config/models').parseModel(model).id;
    } catch {
        return String(model || '');
    }
}

/**
 * 預估 n 題的標註費用（kc:backfill 執行前印出）。
 * @param {number} n
 * @param {string} model 'vendor:id' 或裸 ID
 * @param {{tokenIn:number, tokenOut:number, tokenThinking?:number}} [perQuestion]
 * @returns {{perQuestionUsd:number, totalUsd:number, estimated:boolean, modelId:string, tokens:object}}
 *          estimated=false 表示價目表查不到這個模型（config/pricing.js 的規則：查不到記 0）
 */
function estimateTagCost(n, model, perQuestion = EST_TOKENS_PER_QUESTION) {
    const { estimateCost } = require('../config/pricing');
    const modelId = bareModelId(model);
    const one = estimateCost({
        modelId, tokenIn: perQuestion.tokenIn, tokenOut: perQuestion.tokenOut, tokenThinking: perQuestion.tokenThinking ?? 0
    });
    const count = Math.max(0, Number(n) || 0);
    return {
        perQuestionUsd: one.cost_usd,
        totalUsd: Number((one.cost_usd * count).toFixed(6)),
        estimated: one.cost_estimated,
        modelId,
        tokens: { ...perQuestion }
    };
}

/** 包一層 llm，記下這一題實際用了多少 token（回報與 kc:backfill 的實際費用用） */
function meteredLlm(llm, meter) {
    const record = (args, u) => {
        meter.calls += 1;
        meter.model = args.model || meter.model;
        meter.tokenIn += u.tokenIn ?? 0;
        meter.tokenOut += u.tokenOut ?? 0;
        meter.tokenThinking += u.tokenThinking ?? 0;
        meter.tokenCached += u.tokenCached ?? 0;
    };
    return {
        async generateJson(args = {}) {
            let res;
            try {
                res = await llm.generateJson(args);
            } catch (err) {
                // 〔stage5 審查修正 S5-45〕模型已回應、但 JSON 解析失敗：services/llm/gemini.js 把用量掛在
                // err.usage。這次的錢已經花了，照樣記進 meter（kc:backfill 印的實際費用才不會偏低）。
                if (err && err.usage) record(args, err.usage);
                throw err;
            }
            record(args, (res && res.usage) || {});
            return res;
        }
    };
}

function usageOf(meter) {
    if (meter.calls === 0) return { calls: 0, tokenIn: 0, tokenOut: 0, tokenThinking: 0, costUsd: 0, costEstimated: false };
    const { estimateCost } = require('../config/pricing');
    const cost = estimateCost({
        modelId: bareModelId(meter.model), tokenIn: meter.tokenIn, tokenOut: meter.tokenOut,
        tokenThinking: meter.tokenThinking, tokenCached: meter.tokenCached
    });
    return {
        calls: meter.calls, tokenIn: meter.tokenIn, tokenOut: meter.tokenOut, tokenThinking: meter.tokenThinking,
        costUsd: cost.cost_usd, costEstimated: cost.cost_estimated
    };
}

/**
 * 為一題標知識點（第 4.3 條第 3 點）。
 *
 * @param {number} questionId
 * @param {object} [deps]
 * @param {{query:Function, pool:{connect:Function}}} [deps.db]  預設 config/db
 * @param {{generateJson:Function}} [deps.llm]                   預設 services/llm
 * @param {{run:Function}} [deps.agent]                          預設 agents/tagKc（測試可換）
 * @param {{minConfidence?:number, model?:string}} [deps.config] 覆寫 loadTagConfig() 的結果
 * @param {object} [deps.env]                                    預設 process.env
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{question_id:number, status:'tagged'|'skipped'|'low_confidence'|'failed'|'not_found',
 *                    reason?:string, message?:string, written:object[], dropped:object[],
 *                    rationale?:string, usage:object}>}
 */
async function tagQuestion(questionId, deps = {}) {
    const db = deps.db || require('../config/db');
    const llm = deps.llm || require('./llm');
    const agent = deps.agent || require('../agents/tagKc');
    const cfg = { ...loadTagConfig(deps.env || process.env), ...(deps.config || {}) };
    const meter = { calls: 0, model: null, tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 };
    const done = (status, extra = {}) => ({
        question_id: questionId, status, written: [], dropped: [], ...extra, usage: usageOf(meter)
    });

    const { rows: [q] } = await db.query(
        'SELECT id, subject, chapter, question_text, answer_text FROM questions WHERE id = $1', [questionId]);
    if (!q) return done('not_found');

    const { rows: human } = await db.query(
        `SELECT 1 FROM question_kcs WHERE question_id = $1 AND src = 'human' LIMIT 1`, [questionId]);
    if (human.length) return done('skipped', { reason: 'has_human' });

    const { rows: kcs } = await db.query(
        `SELECT id, code, name, description FROM knowledge_components
          WHERE subject = $1 AND chapter = $2 ORDER BY sort, id`, [q.subject, q.chapter]);
    if (kcs.length === 0) return done('skipped', { reason: 'no_kcs' });

    const ctx = {
        llm: meteredLlm(llm, meter),
        config: { models: { kcTag: cfg.model } },
        signal: deps.signal,
        logger: deps.logger
    };
    const outcome = await agent.run(ctx, {
        question_text: q.question_text, subject: q.subject, chapter: q.chapter, answer_text: q.answer_text,
        kcs: kcs.map(k => ({ code: k.code, name: k.name, description: k.description }))
    });

    if (!outcome || outcome.kind === 'skipped') {
        return done('skipped', { reason: (outcome && outcome.data && outcome.data.reason) || 'no_kcs' });
    }
    if (outcome.kind !== 'pass') {
        return done('failed', {
            reason: outcome.reason || outcome.errorClass || 'provider_error',
            message: outcome.feedback || outcome.message || ''
        });
    }

    const byCode = new Map(kcs.map(k => [k.code, k]));
    const { write, dropped } = decideWrites(outcome.data.kc_codes, byCode, cfg.minConfidence);
    const rationale = outcome.data.rationale;
    if (write.length === 0) return done('low_confidence', { dropped, rationale });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        // 與 PUT /api/questions/:id/kcs 用同一把鎖（題目列），兩邊排隊寫
        const { rows: [locked] } = await client.query('SELECT id FROM questions WHERE id = $1 FOR UPDATE', [questionId]);
        if (!locked) {
            await client.query('ROLLBACK');
            return done('not_found');
        }
        const { rows: raced } = await client.query(
            `SELECT 1 FROM question_kcs WHERE question_id = $1 AND src = 'human' LIMIT 1`, [questionId]);
        if (raced.length) {
            // LLM 回來之前老師剛好手動標了：人工優先，AI 的結果丟掉
            await client.query('ROLLBACK');
            return done('skipped', { reason: 'has_human', dropped, rationale });
        }
        await client.query(`DELETE FROM question_kcs WHERE question_id = $1 AND src = 'ai'`, [questionId]);
        await client.query(
            `INSERT INTO question_kcs (question_id, kc_id, weight, src, confidence)
             SELECT $1, k, 1, 'ai', c FROM unnest($2::int[], $3::real[]) AS t(k, c)`,
            [questionId, write.map(w => w.kc_id), write.map(w => w.confidence)]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
    return done('tagged', { written: write, dropped, rationale });
}

// ─────────────────────────── kc:backfill 用 ───────────────────────────

/**
 * 回填的對象：未封存、**沒有任何**知識點標註、所在章節已有知識點的題，依 id 由小到大。
 * @param {{query:Function}} db
 * @param {{subject?:string|null, limit?:number|null}} [opts]
 * @returns {Promise<number[]>}
 */
async function selectBackfillIds(db, { subject = null, limit = null } = {}) {
    const { rows } = await db.query(
        `SELECT q.id FROM questions q
          WHERE q.archived_at IS NULL
            AND ($1::text IS NULL OR q.subject = $1)
            AND NOT EXISTS (SELECT 1 FROM question_kcs qk WHERE qk.question_id = q.id)
            AND EXISTS (SELECT 1 FROM knowledge_components kc
                         WHERE kc.subject = q.subject AND kc.chapter = q.chapter)
          ORDER BY q.id
          LIMIT $2`,
        [subject, limit]);
    return rows.map(r => r.id);
}

/**
 * 沒標註、但所在章節**還沒有知識點**的題數（回填會略過它們；印出來讓老師知道缺哪一塊）。
 * @returns {Promise<number>}
 */
async function countUntaggedWithoutKcs(db, { subject = null } = {}) {
    const { rows: [r] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM questions q
          WHERE q.archived_at IS NULL
            AND ($1::text IS NULL OR q.subject = $1)
            AND NOT EXISTS (SELECT 1 FROM question_kcs qk WHERE qk.question_id = q.id)
            AND NOT EXISTS (SELECT 1 FROM knowledge_components kc
                             WHERE kc.subject = q.subject AND kc.chapter = q.chapter)`,
        [subject]);
    return r.n;
}

module.exports = {
    tagQuestion, loadTagConfig, resolveModel, decideWrites, estimateTagCost,
    selectBackfillIds, countUntaggedWithoutKcs,
    DEFAULT_MIN_CONFIDENCE, EST_TOKENS_PER_QUESTION
};