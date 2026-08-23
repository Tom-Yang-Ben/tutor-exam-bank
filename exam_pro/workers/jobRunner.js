// ─────────────────────────────────────────────────────────────
// workers/jobRunner.js — DB-polling worker（A-T11，擁有者：WS-A）
//
// 介面凍結於 docs/interfaces-stage2.md 第 7 條（認領／啟動／預算／事件）、
// 第 3 條（agent 合約與 ctx）、第 2 條（狀態機）。
//
// 一句話：**這支是唯一會改 job_questions.state 與寫 job_events 的地方**。
// agent 只回 outcome，狀態機只算下一格，錢與租約與事件都在這裡結算。
//
// 兩種工作單位：
//   A. `jobs` 列（state queued／extracting）→ 逐 chunk 跑 extract → 建 job_questions → processing
//   B. `job_questions` 列（六個可推進狀態）→ 跑一個節點 → transition() → 寫回
//
// 為什麼認領要「同一交易兩句」而不是 UPDATE … RETURNING：
//   規劃 §3.3.1 的原始理由是要相容 MySQL；階段 1 已切 PG（interfaces.md 裁決 27），
//   但介面第 7.1 條把這個形狀凍結了，照寫。SKIP LOCKED 讓兩個槽不會搶到同一列。
//
// 崩潰／nodemon 重啟的重跑保證＝租約過期後該列會被重新認領；extract 重跑靠
// job_questions 的 UNIQUE (job_id, idx) + ON CONFLICT DO NOTHING 保證不會重複建列。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const { transition, NODE_FOR_STATE, DEFAULT_LIMITS, TERMINAL_STATES } = require('../pipeline/stateMachine');

/** exam_pro/ 的絕對路徑：jobs.pdf_path 存的是相對路徑，一律對這裡 resolve，不看 process.cwd()。 */
const APP_DIR = path.resolve(__dirname, '..');

/** @param {string} p jobs.pdf_path（相對於 exam_pro/，或絕對路徑） */
function resolveJobPath(p) {
    return path.isAbsolute(p) ? p : path.resolve(APP_DIR, p);
}

/** 六個可推進狀態（= 認領 SQL 的 WHERE state IN (...)）。終止上界見裁決 S2-3。 */
const ADVANCEABLE_STATES = Object.keys(NODE_FOR_STATE);

/**
 * 零成本節點：不呼叫任何模型，因此 DAILY_COST_BUDGET_USD 觸發後仍可繼續跑，
 * 讓已經在途的 job 至少把免費的那幾格走完，而不是整份卡死到隔天。
 */
const FREE_NODES = new Set(['dedup0', 'dedup1', 'save']);

/**
 * node → agent 檔名（裁決 S2-6，第 3.1 條）。
 *
 * `dedup0`／`dedup1` 兩個節點由 `agents/dedup.js` 一支服務，另有兩支三行的轉接檔
 * `agents/dedup0.js`／`dedup1.js`。因此 loadAgent 的解析順序是
 * ①`agents/<node>.js` → ②這張表，兩種寫法都接得上。
 * 層級只能靠凍結的 input 鍵判斷（見 buildInput），不看 state 或 payload。
 */
const AGENT_MODULE_FOR_NODE = {
    extract: 'extract', dedup0: 'dedup', classify: 'classify',
    lint: 'lint', verify: 'verify', dedup1: 'dedup'
};

/** job_events.error_class 的九個合法值（DDL CHECK）；不在其中的一律不寫進該欄。 */
const ERROR_CLASSES = new Set(['schema_invalid', 'chapter_invalid', 'formula_unparsable',
    'answer_mismatch', 'duplicate', 'provider_error', 'rate_limited', 'timeout', 'budget_exceeded']);

const RENEW_INTERVAL_MS = 30_000;   // 第 7.1 條：呼叫進行中每 30 秒續租
const BACKOFF_BASE_MS = 1_000;      // 第 2.3 條：1s → 2s → 4s…
const BACKOFF_MAX_MS = 60_000;      // 封頂 60 秒（與階段 1 gemini adapter 的退避上限一致）
const EXTRACT_MAX_RETRIES = 1;      // 規劃 §3.3.4：extract 整包重試 1 次

// ─────────────────────────── 純函式（可單元測試，不連 DB）───────────────────────────

/**
 * 讀環境變數組出 runner 的設定。全部給預設值，缺 .env 也跑得起來。
 * @param {object} [env] 預設 process.env
 */
function loadConfig(env = process.env) {
    const int = (name, dflt) => {
        const n = Number.parseInt(env[name], 10);
        return Number.isFinite(n) ? n : dflt;
    };
    const num = (name, dflt) => {
        const n = Number.parseFloat(env[name]);
        return Number.isFinite(n) ? n : dflt;
    };
    return {
        pollMs: int('JOB_POLL_MS', 2000),
        concurrency: Math.max(1, int('JOB_CONCURRENCY', 2)),
        leaseMs: int('JOB_LEASE_MS', 180000),
        nodeTimeoutMs: int('JOB_NODE_TIMEOUT_MS', 120000),
        costBudgetUsd: num('JOB_COST_BUDGET_USD', 0.5),
        dailyCostBudgetUsd: num('DAILY_COST_BUDGET_USD', 5),
        pdfChunkPages: Math.max(1, int('JOB_PDF_CHUNK_PAGES', 20)),
        inlineMaxBytes: int('GEMINI_INLINE_MAX_BYTES', 15728640),
        classifyMinConf: num('CLASSIFY_MIN_CONF', 0.8),
        dedupDup: num('DEDUP_DUP_THRESHOLD', 0.97),
        dedupVariant: num('DEDUP_VARIANT_THRESHOLD', 0.90)
    };
}

/**
 * 依總頁數與每塊頁數切出 chunk 清單（第 0.2 條：切塊是為了「失敗重試的粒度」）。
 * @param {number|null} pageCount 為 null／0 時退成單一塊、toPage 給 null（交給 agent 自己判斷整份）
 * @param {number} chunkPages
 * @returns {Array<{no:number, fromPage:number, toPage:number|null}>}
 */
function planChunks(pageCount, chunkPages) {
    const total = Number.parseInt(pageCount, 10);
    const size = Math.max(1, Number.parseInt(chunkPages, 10) || 1);
    if (!Number.isFinite(total) || total <= 0) return [{ no: 1, fromPage: 1, toPage: null }];

    const chunks = [];
    for (let from = 1, no = 1; from <= total; from += size, no += 1) {
        chunks.push({ no, fromPage: from, toPage: Math.min(from + size - 1, total) });
    }
    return chunks;
}

/**
 * 供應商錯誤的退避毫秒數（第 2.3 條：睡眠由 runner 做，狀態機只計數）。
 * @param {number} attempt 這是第幾次退避（0 起算）
 */
function backoffMs(attempt) {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)), BACKOFF_MAX_MS);
}

/**
 * job_events.attempt：從 1 起算，等於「這個節點已經跑過幾次」+ 1。
 * fail 與 error 兩組計數器都要算進去，否則同一列會出現兩個 attempt=2 的事件。
 */
function attemptNo(retries, node) {
    const r = retries || {};
    return (r[node] ?? 0) + (r[`${node}:error`] ?? 0) + 1;
}

/**
 * 這次節點呼叫有沒有走 schema 退路（裁決 S2-4，第 5.1 條）。
 *
 * 兩個來源取 OR，任一為真就記：
 *   1. `generateJson` 的回傳（runner 的計量器直接看到，最權威——agent 忘了轉手也不會漏）
 *   2. `outcome.data.schema_fallback`（agent 自己記的，例如 `agents/extract.js`）
 *
 * 回 false 時呼叫端**不寫這個鍵**：絕大多數呼叫都沒走退路，
 * 逐列存一個 `false` 只是讓 job_events.detail 白白變大。
 *
 * @param {{schemaFallback?:boolean}} meter
 * @param {{data?:object}} outcome
 * @returns {boolean}
 */
function schemaFallbackOf(meter, outcome) {
    return meter?.schemaFallback === true || outcome?.data?.schema_fallback === true;
}

/** 不在 DDL 九個值內的 error_class 一律不寫（欄位可為 NULL），避免 CHECK 炸掉。 */
function normalizeErrorClass(value) {
    return ERROR_CLASSES.has(value) ? value : null;
}

/**
 * 由 payload 組出要寫進 questions 的欄位（save 節點，第 3.3 條表格最後一列）。
 *
 * 取值優先序（凍結）：章節用 classify 的最終值、題幹與答案用 lint 的修正後版本，
 * 兩者都沒跑過才回頭用 extract 的原始值；figure_desc 以 `[附圖描述：…]` 併回題幹末端，
 * 格式與 aiService.js 現行一致，wordService 與前端因此不用改。
 *
 * @param {object} payload job_questions.payload
 * @returns {{subject, chapter, question_type, difficulty, question_text, answer_text}}
 */
function buildSaveFields(payload) {
    const p = payload || {};
    const ex = p.extract || {};
    const lint = p.lint || {};
    const cls = p.classify || {};

    let question_text = lint.question_text ?? ex.question_text ?? '';
    const figure = ex.figure_desc;
    if (figure && String(figure).trim() && !question_text.includes('[附圖描述：')) {
        question_text = `${question_text}\n[附圖描述：${String(figure).trim()}]`;
    }

    return {
        subject: ex.subject,
        chapter: cls.chapter ?? ex.chapter,
        question_type: ex.question_type,
        difficulty: ex.difficulty,
        question_text,
        answer_text: lint.answer_text ?? ex.answer_text ?? ''
    };
}

/**
 * 組 `ctx.config.features`（裁決 S2-8，第 3.1 條）。
 *
 * 鍵名凍結為**小寫短名** `{ similar, pipeline }`，不是環境變數全名；
 * 值一律經 `config/features.js`（布林解讀規則凍結於 interfaces.md 第 9 條：
 * 只有字串 `1`／`true` 為真）。每次組 ctx 都重讀一次，`.env` 改了不必重啟 worker。
 *
 * @returns {{similar:boolean, pipeline:boolean}}
 */
function readFeatures() {
    const features = require('../config/features');
    return {
        similar: features.isEnabled('FEATURE_SIMILAR'),
        pipeline: features.isEnabled('FEATURE_PIPELINE')
    };
}

/** 一行一個 JSON 的預設 logger（第 7.5 條）。 */
function makeLogger(sink = console) {
    const line = (level, obj) => sink.log(JSON.stringify({ ts: new Date().toISOString(), level, ...obj }));
    return {
        info: (obj) => line('info', obj),
        warn: (obj) => line('warn', obj),
        error: (obj) => line('error', obj)
    };
}

// ─────────────────────────── runner 本體 ───────────────────────────

/**
 * 建一個 runner。所有外部相依都從參數進來，整合測試才好塞假的。
 *
 * @param {object}  [opts]
 * @param {{pool, query}} [opts.db]        預設 require('../config/db')
 * @param {object}  [opts.llm]             預設 require('../services/llm')
 * @param {string}  [opts.agentsDir]       預設 <repo>/agents；測試指到 test/fixtures/fakeAgents
 * @param {object}  [opts.config]          loadConfig() 的輸出，可逐欄覆寫
 * @param {object}  [opts.logger]
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 測試可換成不真的睡
 * @param {(meter)=>{cost_usd:number, cost_estimated:boolean}} [opts.estimateCost]
 *        預設查 config/pricing.js（WS-B）；整合測試塞一個假的才測得到預算累加
 * @returns {{tick, start, stop, runJobQuestion, runExtractJob, isBusy, inFlight}}
 */
function createRunner(opts = {}) {
    const db = opts.db || require('../config/db');
    const llm = opts.llm || require('../services/llm');
    const agentsDir = opts.agentsDir || path.resolve(__dirname, '..', 'agents');
    const config = { ...loadConfig(), ...(opts.config || {}) };
    const logger = opts.logger || makeLogger();
    const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const estimateCost = opts.estimateCost || estimateCostFromPricing;

    const agentCache = new Map();
    const inFlight = new Set();      // 'jq:12' / 'job:3'
    let timer = null;
    let ticking = false;
    let dailyWarned = false;

    // ── agent 載入 ────────────────────────────────────────────
    function loadAgent(node) {
        if (agentCache.has(node)) return agentCache.get(node);
        for (const name of [node, AGENT_MODULE_FOR_NODE[node]]) {
            if (!name) continue;
            const file = path.resolve(agentsDir, `${name}.js`);
            if (!fs.existsSync(file)) continue;
            const mod = require(file);
            if (typeof mod.run !== 'function') {
                throw new Error(`agent ${file} 沒有匯出 run(ctx, input)`);
            }
            agentCache.set(node, mod);
            return mod;
        }
        throw new Error(`找不到節點 ${node} 的 agent（找過 ${agentsDir} 下的 ${node}.js 與 ${AGENT_MODULE_FOR_NODE[node]}.js）`);
    }

    // ── 用量計量：把 ctx.llm 包一層，runner 才知道這個節點實際花了多少 ──
    function meteredLlm(meter) {
        return {
            async generateJson(args = {}) {
                const res = await llm.generateJson(args);
                const u = res?.usage || {};
                meter.model = args.model || meter.model;
                meter.tokenIn += u.tokenIn ?? 0;
                meter.tokenOut += u.tokenOut ?? 0;
                meter.tokenThinking += u.tokenThinking ?? 0;
                meter.tokenCached += u.tokenCached ?? 0;
                meter.calls += 1;
                // 裁決 S2-4：走過「schema 不含 enum + prompt 列舉」退路的呼叫要留痕。
                // 由 runner 直接從 generateJson 的回傳讀，不倚賴 agent 有沒有轉手記下來。
                if (res?.schemaFallback === true) meter.schemaFallback = true;
                if (res?.raw?.usageMetadata) meter.usageMetadata.push(res.raw.usageMetadata);
                return res;
            },
            async embed(args = {}) {
                const res = await llm.embed(args);
                meter.tokenIn += res?.usage?.tokenIn ?? 0;
                meter.calls += 1;
                return res;
            }
        };
    }

    function newMeter() {
        return {
            model: null, tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0,
            calls: 0, usageMetadata: [], schemaFallback: false
        };
    }

    /** 用 config/pricing.js 估價；WS-B 還沒合入時記 0 且 cost_estimated=false（第 5.5 條）。 */
    function estimateCostFromPricing(meter) {
        if (!meter.model || meter.calls === 0) return { cost_usd: 0, cost_estimated: false };
        try {
            const pricing = require('../config/pricing');
            if (typeof pricing.estimateCost === 'function') {
                const modelId = String(meter.model).includes(':') ? String(meter.model).split(':').pop() : String(meter.model);
                const r = pricing.estimateCost({
                    modelId, tokenIn: meter.tokenIn, tokenOut: meter.tokenOut,
                    tokenThinking: meter.tokenThinking, tokenCached: meter.tokenCached
                });
                return { cost_usd: Number(r?.cost_usd ?? 0), cost_estimated: Boolean(r?.cost_estimated) };
            }
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw err;
        }
        return { cost_usd: 0, cost_estimated: false };
    }

    // ── job_events / 成本結算 ────────────────────────────────
    async function writeEvent(row) {
        await db.query(
            `INSERT INTO job_events
                (job_id, jq_id, node, attempt, model, token_in, token_out, token_thinking, token_cached,
                 cost_usd, cost_estimated, latency_ms, outcome, error_class, detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
            [row.job_id, row.jq_id ?? null, row.node, row.attempt, row.model ?? null,
            row.token_in ?? null, row.token_out ?? null, row.token_thinking ?? null, row.token_cached ?? null,
            row.cost_usd ?? null, row.cost_estimated ?? true, row.latency_ms, row.outcome,
                normalizeErrorClass(row.error_class), JSON.stringify(row.detail ?? {})]
        );
    }

    /** 把這一次呼叫的用量累加回 jobs（token_out 含 thinking，第 0.4 條）。 */
    async function chargeJob(jobId, meter, cost) {
        if (meter.calls === 0 && cost.cost_usd === 0) return;
        await db.query(
            `UPDATE jobs SET token_in = token_in + $2, token_out = token_out + $3,
                             cost_usd = cost_usd + $4, updated_at = now() WHERE id = $1`,
            [jobId, meter.tokenIn, meter.tokenOut + meter.tokenThinking, cost.cost_usd]
        );
    }

    /** 當日成本（第 7.3.4 條的全域止血）。 */
    async function dailySpentUsd() {
        const { rows } = await db.query(
            `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent FROM job_events
              WHERE created_at >= date_trunc('day', now())`
        );
        return Number(rows[0]?.spent ?? 0);
    }

    // ── 認領（第 7.1 條：同一交易兩句 + FOR UPDATE SKIP LOCKED + 租約）──
    async function claim(table, whereSql, params, extraSet = '') {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `SELECT id FROM ${table}
                  WHERE ${whereSql} AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, params);
            if (rows.length === 0) { await client.query('COMMIT'); return null; }
            const id = rows[0].id;
            await client.query(
                `UPDATE ${table} SET locked_until = now() + ($1 || ' milliseconds')::interval,
                        updated_at = now()${extraSet} WHERE id = $2`,
                [String(config.leaseMs), id]);
            await client.query('COMMIT');
            return id;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    }

    /** 租約續期：呼叫進行中每 30 秒延一次，避免另一個槽重新認領仍在付費的列。 */
    function startRenew(table, id) {
        const h = setInterval(() => {
            db.query(`UPDATE ${table} SET locked_until = now() + ($1 || ' milliseconds')::interval WHERE id = $2`,
                [String(config.leaseMs), id])
                .catch(err => logger.warn({ msg: '續租失敗', table, id, error: err.message }));
        }, RENEW_INTERVAL_MS);
        if (typeof h.unref === 'function') h.unref();
        return () => clearInterval(h);
    }

    // ── 跑一個節點：逾時、計量、事件、狀態機 ──────────────────
    /**
     * @returns {{outcome, meter, cost, latencyMs}}
     */
    async function invokeNode(node, ctxBase, input) {
        const controller = new AbortController();
        const meter = newMeter();
        const startedAt = Date.now();
        let timeoutHandle = null;

        const ctx = {
            ...ctxBase,
            llm: meteredLlm(meter),
            signal: controller.signal,
            config: {
                models: ctxBase.models,
                limits: ctxBase.limits,
                thresholds: {
                    classifyMinConf: config.classifyMinConf,
                    dedupDup: config.dedupDup,
                    dedupVariant: config.dedupVariant,
                    pdfChunkPages: config.pdfChunkPages,
                    inlineMaxBytes: config.inlineMaxBytes,
                    nodeTimeoutMs: config.nodeTimeoutMs
                },
                // 裁決 S2-8（第 3.1 條）：agent 不得自己讀 process.env，旗標只能從這裡拿。
                // 鍵名是小寫短名 similar／pipeline，值即時由 config/features.js 讀取。
                features: readFeatures()
            }
        };
        delete ctx.models; delete ctx.limits;

        let outcome;
        try {
            const timeout = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    controller.abort();
                    reject(Object.assign(new Error(`節點 ${node} 超過 ${config.nodeTimeoutMs} ms 未回應`), { errorClass: 'timeout' }));
                }, config.nodeTimeoutMs);
                if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
            });
            const run = node === 'save' ? saveNode(ctx, input) : loadAgent(node).run(ctx, input);
            outcome = await Promise.race([run, timeout]);
            if (!outcome || typeof outcome.kind !== 'string') {
                outcome = { kind: 'error', errorClass: 'provider_error', message: `節點 ${node} 回傳的不是合法 outcome` };
            }
        } catch (err) {
            // agent 合約寫「不得 throw」，真的丟了就由這裡分類（第 3.1 條）
            outcome = { kind: 'error', errorClass: classifyError(err), message: err.message };
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        return { outcome, meter, cost: estimateCost(meter), latencyMs: Date.now() - startedAt };
    }

    function classifyError(err) {
        if (err?.errorClass && ERROR_CLASSES.has(err.errorClass)) return err.errorClass;
        if (err?.name === 'AbortError') return 'timeout';
        const msg = String(err?.message || '');
        if (/\b429\b|rate.?limit|quota/i.test(msg)) return 'rate_limited';
        if (/timeout|timed out|abort/i.test(msg)) return 'timeout';
        return 'provider_error';
    }

    // ── save 節點（第 3.3 條最後一列；裁決 S2-7：歸 runner，不在 agents/）──
    //    理由（§12）：它要開交易、寫 job_events、回填 question_id，
    //    這三件事第 3.1 條都明文排除在 agent 合約之外。job_events.node 仍寫 'save'。
    /**
     * 最後一道閘門 + 入庫。validateQuestionFields 與 INSERT 在同一個交易裡，
     * 因此不會出現「questions 有了、job_questions.question_id 還是 NULL」的中間狀態。
     */
    async function saveNode(ctx, input) {
        const { validateQuestionFields } = require('../utils/questionValidation');
        const fields = buildSaveFields(input);
        const v = validateQuestionFields(fields);
        if (!v.ok) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: v.errors.join('；'), data: { errors: v.errors } };
        }

        const textHash = input?.dedup0?.text_hash ?? null;
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            // 新題的 keywords／concept_summary 一定是 NULL，所以 search_tsv 的三段 token
            // 直接由驗證過的欄位算得出來，可以與 INSERT 併成同一句（與 questionController 同一套規則）。
            const { buildTsvTokens } = require('../services/embedService');
            const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens({ ...v.value, keywords: null, concept_summary: null });

            const { rows } = await client.query(
                `INSERT INTO questions
                    (subject, chapter, question_type, difficulty, question_text, answer_text,
                     origin, chapter_src, text_hash, search_tsv)
                 VALUES ($1,$2,$3,$4,$5,$6,'pdf','ai',$7,
                         setweight(to_tsvector('simple', array_to_string($8::text[],  ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($9::text[],  ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($10::text[], ' ')), 'B'))
                 RETURNING id`,
                [v.value.subject, v.value.chapter, v.value.question_type, v.value.difficulty,
                v.value.question_text, v.value.answer_text || '略', textHash,
                    chapterTokens, keywordTokens, stemTokens]);

            const questionId = rows[0].id;
            await client.query('UPDATE job_questions SET question_id = $2 WHERE id = $1', [ctx.jq.id, questionId]);
            await client.query('COMMIT');

            scheduleEmbed(questionId, ctx.logger);
            return { kind: 'pass', data: { question_id: questionId, text_hash: textHash } };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    }

    /** 入庫後補向量：fire-and-forget，失敗只記 log（第 3.3 條、interfaces.md 12.4）。 */
    function scheduleEmbed(questionId, log) {
        Promise.resolve()
            .then(() => require('../services/embedService').embedByIds([questionId]))
            .then(r => {
                if (r.failed.length > 0) {
                    log.warn({ msg: '向量待 backfill 補', question_id: questionId, error: String(r.failed[0].error).split('\n')[0] });
                }
            })
            .catch(err => log.warn({ msg: '向量寫入失敗（不影響入庫）', question_id: questionId, error: String(err.message).split('\n')[0] }));
    }

    // ── 節點 input（第 3.3 條逐節點）─────────────────────────
    function buildInput(node, jq) {
        const p = jq.payload || {};
        const ex = p.extract || {};
        switch (node) {
            case 'dedup0':
                return { question_text: ex.question_text };
            case 'classify':
                return {
                    subject: ex.subject, chapter: ex.chapter,
                    chapter_confidence: ex.chapter_confidence, question_text: ex.question_text,
                    ...(p.classify?.feedback ? { feedback: p.classify.feedback } : {})
                };
            case 'lint':
                return {
                    question_text: p.lint?.question_text ?? ex.question_text,
                    answer_text: p.lint?.answer_text ?? ex.answer_text,
                    ...(p.lint?.feedback ? { feedback: p.lint.feedback } : {})
                };
            case 'verify': {
                const fields = buildSaveFields(p);
                return {
                    question_text: fields.question_text,       // figure_desc 已併入題幹
                    question_type: ex.question_type,
                    claimed_answer: fields.answer_text          // 只給比對器，agent 不得放進 prompt
                };
            }
            case 'dedup1': {
                const fields = buildSaveFields(p);
                return {
                    question_id: null,
                    embed_text: fields.question_text,
                    subject: fields.subject,
                    chapter: fields.chapter
                };
            }
            case 'save':
                return p;
            default:
                throw new Error(`buildInput：未知節點 ${node}`);
        }
    }

    // ── payload 的寫回規則（第 2.3 條規則 5：feedback 由 runner 寫）──
    function mergePayload(payload, node, outcome, stayed) {
        const next = { ...(payload || {}) };
        if (outcome.kind === 'pass') {
            next[node] = { ...(outcome.data || {}) };
        } else if (outcome.kind === 'skipped') {
            next[node] = { skipped: true, ...(outcome.data || {}) };
        } else if (outcome.kind === 'fail') {
            // 留在原狀態才需要 feedback（下一次的 prompt 要用）；進複核就只留判定結果
            next[node] = {
                ...(next[node] || {}), ...(outcome.data || {}),
                ...(stayed && outcome.feedback ? { feedback: outcome.feedback } : {})
            };
        }
        return next;
    }

    // ── 工作單位 B：推進一列 job_questions ────────────────────
    async function runJobQuestion(jqId) {
        const stopRenew = startRenew('job_questions', jqId);
        try {
            const { rows } = await db.query(
                `SELECT q.id, q.job_id, q.idx, q.state, q.payload, q.retries,
                        j.budget_usd::float8 AS budget_usd, j.cost_usd::float8 AS cost_usd
                   FROM job_questions q JOIN jobs j ON j.id = q.job_id
                  WHERE q.id = $1`, [jqId]);
            if (rows.length === 0) return;
            const jq = rows[0];
            if (!ADVANCEABLE_STATES.includes(jq.state)) return;   // 期間被人 approve／reject 了

            const node = NODE_FOR_STATE[jq.state];
            const budgetLeft = Number(jq.budget_usd) - Number(jq.cost_usd);
            const limits = { ...DEFAULT_LIMITS, budgetLeft };

            let outcome, meter = newMeter(), cost = { cost_usd: 0, cost_estimated: false }, latencyMs = 0;

            if (budgetLeft <= 0 && !FREE_NODES.has(node)) {
                // 第 7.3.2 條：呼叫「前」就檢查，錢不夠連叫都不叫。
                // 狀態機的規則 3 會把它變成 needs_review('budget_exceeded')。
                outcome = { kind: 'fail', reason: 'budget_exceeded' };
                logger.warn({ msg: '預算用盡，跳過呼叫', job_id: jq.job_id, jq_id: jq.id, node, budget_left: budgetLeft });
            } else {
                const ctxBase = {
                    db, job: { id: jq.job_id, budget_usd: Number(jq.budget_usd), cost_usd: Number(jq.cost_usd) },
                    jq: { id: jq.id, idx: jq.idx, payload: jq.payload, retries: jq.retries },
                    logger, models: loadModels(), limits
                };
                ({ outcome, meter, cost, latencyMs } = await invokeNode(node, ctxBase, buildInput(node, jq)));
                await chargeJob(jq.job_id, meter, cost);
            }

            const next = transition({ state: jq.state, retries: jq.retries, outcome, limits });
            const stayed = next.state === jq.state;
            const payload = mergePayload(jq.payload, node, outcome, stayed);

            await writeEvent({
                job_id: jq.job_id, jq_id: jq.id, node, attempt: attemptNo(jq.retries, node),
                model: meter.calls > 0 ? meter.model : null,
                token_in: meter.calls > 0 ? meter.tokenIn : null,
                token_out: meter.calls > 0 ? meter.tokenOut : null,
                token_thinking: meter.calls > 0 ? meter.tokenThinking : null,
                token_cached: meter.calls > 0 ? meter.tokenCached : null,
                cost_usd: cost.cost_usd, cost_estimated: cost.cost_estimated, latency_ms: latencyMs,
                outcome: outcome.kind === 'skipped' ? 'skipped' : outcome.kind,
                error_class: outcome.kind === 'fail' ? outcome.reason
                    : outcome.kind === 'error' ? outcome.errorClass : null,
                detail: {
                    ...(outcome.kind === 'fail' ? { reason: outcome.reason, feedback: outcome.feedback } : {}),
                    ...(outcome.kind === 'error' ? { message: outcome.message } : {}),
                    ...(meter.usageMetadata.length > 0 ? { usage_metadata: meter.usageMetadata } : {}),
                    ...(schemaFallbackOf(meter, outcome) ? { schema_fallback: true } : {}),
                    review_reason: next.review_reason
                }
            });

            await db.query(
                `UPDATE job_questions SET state = $2, retries = $3::jsonb, review_reason = $4,
                        payload = $5::jsonb, locked_until = NULL, updated_at = now() WHERE id = $1`,
                [jq.id, next.state, JSON.stringify(next.retries), next.review_reason, JSON.stringify(payload)]);

            logger.info({
                job_id: jq.job_id, jq_id: jq.id, node, attempt: attemptNo(jq.retries, node),
                outcome: outcome.kind, latency_ms: latencyMs, state: next.state, review_reason: next.review_reason
            });

            // error 的退避睡眠：狀態機只負責計數（第 2.3 條規則 6）
            if (outcome.kind === 'error' && stayed) {
                await sleep(backoffMs((jq.retries?.[`${node}:error`] ?? 0)));
            }

            if (TERMINAL_STATES.includes(next.state)) await maybeFinishJob(jq.job_id);
        } finally {
            stopRenew();
            await db.query('UPDATE job_questions SET locked_until = NULL WHERE id = $1', [jqId]).catch(() => { });
        }
    }

    /** 所有 job_questions 都在終態 → jobs.state = 'done'。 */
    async function maybeFinishJob(jobId) {
        await db.query(
            `UPDATE jobs SET state = 'done', locked_until = NULL, updated_at = now()
              WHERE id = $1 AND state = 'processing'
                AND NOT EXISTS (SELECT 1 FROM job_questions
                                 WHERE job_id = $1 AND state NOT IN ('saved','needs_review','rejected'))`,
            [jobId]);
    }

    // ── 工作單位 A：拆題 ─────────────────────────────────────
    async function runExtractJob(jobId) {
        const stopRenew = startRenew('jobs', jobId);
        try {
            const { rows } = await db.query(
                `SELECT id, pdf_path, page_count, budget_usd::float8 AS budget_usd, cost_usd::float8 AS cost_usd
                   FROM jobs WHERE id = $1`, [jobId]);
            if (rows.length === 0) return;
            const job = rows[0];

            if (!job.pdf_path || !fs.existsSync(resolveJobPath(job.pdf_path))) {
                await failJob(jobId, 'PDF 原檔不存在，無法拆題。');
                return;
            }

            const chunks = planChunks(job.page_count, config.pdfChunkPages);
            let created = 0;

            for (const chunk of chunks) {
                const r = await runExtractChunk(job, chunk);
                if (!r.ok) { await failJob(jobId, r.error); return; }
                created += r.created;
            }

            // 全部 chunk 都拆完才刪檔並清空 pdf_path（第 1.3 條的生命週期）
            try { fs.unlinkSync(resolveJobPath(job.pdf_path)); } catch (err) {
                logger.warn({ msg: '刪除 PDF 失敗', job_id: jobId, error: err.message });
            }
            await db.query(
                `UPDATE jobs SET pdf_path = NULL, state = 'processing', locked_until = NULL, updated_at = now()
                  WHERE id = $1`, [jobId]);
            logger.info({ job_id: jobId, node: 'extract', outcome: 'pass', questions: created, chunks: chunks.length });

            if (created === 0) await maybeFinishJob(jobId);
        } finally {
            stopRenew();
        }
    }

    /** 單一 chunk 的拆題（含 fail 重試 1 次與 error 退避），成功時建 job_questions。 */
    async function runExtractChunk(job, chunk) {
        let failRetries = 0;
        let errorRetries = 0;

        for (; ;) {
            const { rows } = await db.query('SELECT cost_usd::float8 AS cost_usd FROM jobs WHERE id = $1', [job.id]);
            const budgetLeft = Number(job.budget_usd) - Number(rows[0]?.cost_usd ?? 0);
            if (budgetLeft <= 0) {
                await writeEvent({
                    job_id: job.id, node: 'extract', attempt: failRetries + errorRetries + 1,
                    latency_ms: 0, outcome: 'fail', error_class: 'budget_exceeded', detail: { chunk: chunk.no }
                });
                return { ok: false, error: `拆題預算用盡（budget_usd=${job.budget_usd}）。` };
            }

            const ctxBase = {
                db, job: { id: job.id, budget_usd: Number(job.budget_usd), cost_usd: Number(rows[0]?.cost_usd ?? 0) },
                jq: null, logger, models: loadModels(), limits: { ...DEFAULT_LIMITS, budgetLeft }
            };
            const { outcome, meter, cost, latencyMs } =
                await invokeNode('extract', ctxBase, { jobId: job.id, pdfPath: resolveJobPath(job.pdf_path), chunk });
            await chargeJob(job.id, meter, cost);

            const attempt = failRetries + errorRetries + 1;
            let created = 0;
            if (outcome.kind === 'pass' || outcome.kind === 'skipped') {
                created = await insertJobQuestions(job.id, chunk, outcome.data || {});
            }

            await writeEvent({
                job_id: job.id, node: 'extract', attempt,
                model: meter.calls > 0 ? meter.model : null,
                token_in: meter.calls > 0 ? meter.tokenIn : null,
                token_out: meter.calls > 0 ? meter.tokenOut : null,
                token_thinking: meter.calls > 0 ? meter.tokenThinking : null,
                token_cached: meter.calls > 0 ? meter.tokenCached : null,
                cost_usd: cost.cost_usd, cost_estimated: cost.cost_estimated, latency_ms: latencyMs,
                outcome: outcome.kind === 'skipped' ? 'skipped' : outcome.kind,
                error_class: outcome.kind === 'fail' ? outcome.reason : outcome.kind === 'error' ? outcome.errorClass : null,
                detail: {
                    chunk: chunk.no, page_range: [chunk.fromPage, chunk.toPage], created,
                    rejected: (outcome.data?.rejected || []).length,
                    ...(outcome.kind === 'fail' ? { reason: outcome.reason } : {}),
                    ...(outcome.kind === 'error' ? { message: outcome.message } : {}),
                    ...(meter.usageMetadata.length > 0 ? { usage_metadata: meter.usageMetadata } : {}),
                    ...(schemaFallbackOf(meter, outcome) ? { schema_fallback: true } : {})
                }
            });
            logger.info({
                job_id: job.id, jq_id: null, node: 'extract', attempt, outcome: outcome.kind,
                latency_ms: latencyMs, chunk: chunk.no, created
            });

            if (outcome.kind === 'pass' || outcome.kind === 'skipped') return { ok: true, created };

            if (outcome.kind === 'fail') {
                if (failRetries < EXTRACT_MAX_RETRIES) { failRetries += 1; continue; }
                return { ok: false, error: `拆題失敗（chunk ${chunk.no}）：${outcome.reason}` };
            }
            // error：退避後重試，用盡就讓整份 job failed
            if (errorRetries < DEFAULT_LIMITS.maxErrorRetries) {
                await sleep(backoffMs(errorRetries));
                errorRetries += 1;
                continue;
            }
            return { ok: false, error: `拆題連續失敗（chunk ${chunk.no}）：${outcome.message || outcome.errorClass}` };
        }
    }

    /**
     * 把 extract 的結果建成 job_questions。
     * ON CONFLICT DO NOTHING：崩潰後重跑同一個 chunk 不會建出重複的列（UNIQUE (job_id, idx)）。
     */
    async function insertJobQuestions(jobId, chunk, data) {
        const list = Array.isArray(data.questions) ? data.questions : [];
        let created = 0;
        for (let i = 0; i < list.length; i++) {
            const q = list[i];
            const idx = Number.isInteger(q?.idx) ? q.idx : chunk.no * 1000 + (i + 1);
            const payload = {
                extract: {
                    ...q, idx,
                    chunk_no: q?.chunk_no ?? chunk.no,
                    page_range: q?.page_range ?? [chunk.fromPage, chunk.toPage]
                }
            };
            const { rowCount } = await db.query(
                `INSERT INTO job_questions (job_id, idx, state, payload)
                 VALUES ($1, $2, 'extracted', $3::jsonb)
                 ON CONFLICT (job_id, idx) DO NOTHING`,
                [jobId, idx, JSON.stringify(payload)]);
            created += rowCount;
        }
        return created;
    }

    async function failJob(jobId, message) {
        await db.query(
            `UPDATE jobs SET state = 'failed', error = $2, locked_until = NULL, updated_at = now() WHERE id = $1`,
            [jobId, message]);
        logger.error({ job_id: jobId, node: 'extract', outcome: 'error', latency_ms: 0, error: message });
    }

    // ── 模型設定（config/models.js 由 WS-B 提供，還沒合入時退回 .env）──
    let modelsCache = null;
    function loadModels() {
        if (modelsCache) return modelsCache;
        try {
            const m = require('../config/models');
            if (typeof m.warnIfSameModel === 'function') m.warnIfSameModel();
            modelsCache = { extract: m.MODEL_EXTRACT, verify: m.MODEL_VERIFY };
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw err;
            modelsCache = {
                extract: process.env.MODEL_EXTRACT || 'gemini:gemini-3.5-flash',
                verify: process.env.MODEL_VERIFY || 'gemini:gemini-3.1-pro-preview'   // 與 config/models.js 的 DEFAULT_VERIFY 一致（裁決 S2-29）
            };
        }
        return modelsCache;
    }

    // ── tick：認領到滿槽為止 ─────────────────────────────────
    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            const overDaily = await dailySpentUsd().then(s => s >= config.dailyCostBudgetUsd);
            if (overDaily && !dailyWarned) {
                logger.warn({ msg: `當日成本已達 DAILY_COST_BUDGET_USD=${config.dailyCostBudgetUsd}，停止認領需要付費的工作`, node: 'claim' });
                dailyWarned = true;
            }
            if (!overDaily) dailyWarned = false;

            // 止血時只放行零成本節點對應的狀態，讓在途的 job 至少把免費的格子走完
            const states = overDaily
                ? ADVANCEABLE_STATES.filter(s => FREE_NODES.has(NODE_FOR_STATE[s]))
                : ADVANCEABLE_STATES;

            while (inFlight.size < config.concurrency) {
                // 先清在途的列（讓已經花過錢的 job 早點結案），再開新的 PDF
                const jqId = await claim('job_questions', 'state = ANY($1::text[])', [states]);
                if (jqId !== null) { spawn(`jq:${jqId}`, () => runJobQuestion(jqId)); continue; }

                if (overDaily) break;
                const jobId = await claim('jobs', `kind = 'pdf' AND state IN ('queued','extracting')`, [], `, state = 'extracting'`);
                if (jobId === null) break;
                spawn(`job:${jobId}`, () => runExtractJob(jobId));
            }
        } catch (err) {
            logger.error({ msg: 'tick 失敗', node: 'claim', error: err.message });
        } finally {
            ticking = false;
        }
    }

    function spawn(key, fn) {
        inFlight.add(key);
        Promise.resolve()
            .then(fn)
            .catch(err => logger.error({ msg: '工作單位異常結束', unit: key, error: err.message, stack: err.stack }))
            .finally(() => inFlight.delete(key));
    }

    function start() {
        if (timer) return;
        logger.info({ msg: 'jobRunner 啟動', poll_ms: config.pollMs, concurrency: config.concurrency });
        timer = setInterval(() => { tick(); }, config.pollMs);
        if (typeof timer.unref === 'function') timer.unref();
        tick();
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    return {
        tick, start, stop, runJobQuestion, runExtractJob, config,
        get inFlight() { return inFlight.size; }
    };
}

/** server.js 用：JOB_RUNNER=inline（預設）才啟動。 */
function startInlineRunner(opts) {
    const mode = String(process.env.JOB_RUNNER || 'inline').toLowerCase();
    if (mode !== 'inline') return null;
    const runner = createRunner(opts);
    runner.start();
    return runner;
}

module.exports = {
    createRunner, startInlineRunner,
    // 純函式，供單元測試與 report_jobs 共用
    loadConfig, planChunks, backoffMs, attemptNo, buildSaveFields, normalizeErrorClass, makeLogger, resolveJobPath,
    readFeatures, schemaFallbackOf,
    ADVANCEABLE_STATES, FREE_NODES, AGENT_MODULE_FOR_NODE, ERROR_CLASSES,
    RENEW_INTERVAL_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, EXTRACT_MAX_RETRIES
};

// node workers/jobRunner.js 可獨立跑（第 7.2 條）
if (require.main === module) {
    require('dotenv').config();
    const runner = createRunner();
    runner.start();
    const shutdown = () => { runner.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
