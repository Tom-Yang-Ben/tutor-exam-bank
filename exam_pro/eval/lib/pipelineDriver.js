// ─────────────────────────────────────────────────────────────
// eval/lib/pipelineDriver.js — 在 eval 裡把一份 PDF 走完整條管線（A-T14 / E-X12a 的 --method pipeline）
//
// 這不是 workers/jobRunner.js 的複製品，也不打算變成。jobRunner 是 WS-A 的檔案，
// 要處理認領、租約、續租、交易、崩潰續跑；那些都跟「量數字」無關。
// 本檔只保留量數字需要的三件事：
//   1. 依 pipeline/stateMachine.js（或它的 shim）逐節點推進每一題；
//   2. 每次節點呼叫記一列**形狀與 job_events 相同**的事件（第 1.1 條）；
//   3. 全程不碰資料庫、不寫檔——questions 表用 fixture 的記憶體索引代替。
//
// agent 的來源逐一判斷（有真的就用真的），並把來源記進報表的 meta：
//   agents/extract.js / classify.js  WS-B
//   agents/lint.js / verify.js / dedup.js  WS-C
//
// ⚠️ **oracle stub 的紅線**：extract 還沒合入時，本檔會用答案卷的內容當作「拆題結果」，
//    好讓後面六個節點有東西可跑。那一輪的 extract_recall 與 chapter_acc **在定義上必然是 1.0**，
//    完全沒有意義。因此 runPipeline() 回傳的 agentSources 一定會標 'oracle-stub'，
//    呼叫端（run.js / compare_pipeline.js）**必須**把對應欄位印成 n/a 而不是 1.0，
//    且不得在這個狀態下寫 thresholds 初值。這條規矩寫在這裡，是因為忘記它的代價
//    是一個看起來很棒、而且會被抄進 README 的假數字。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { isValidChapter } = require('../../config/chapters');
const shims = require('./stage2Shims');
const sm = require('./stateMachineShim');
const replayMiss = require('./replayMiss');

const ROOT = path.resolve(__dirname, '..', '..');

const AGENT_FILES = {
    extract: 'agents/extract.js',
    classify: 'agents/classify.js',
    lint: 'agents/lint.js',
    verify: 'agents/verify.js',
    dedup: 'agents/dedup.js'
};

/** @param {string} rel @returns {object|null} */
function loadAgent(rel) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    const mod = require(abs);
    return typeof mod.run === 'function' ? mod : null;
}

/**
 * ctx.db：eval 不該自己開連線池。
 *   TEST_DATABASE_URL 有設 → 真的建一個 Pool（真 agent 需要撈 few-shot 與 text_hash 時用）。
 *   沒設 → 一個**會丟出明確錯誤**的假 db。不回空結果——回空結果會讓 classify 的 few-shot
 *          悄悄變成 0 筆，模型表現變差而報表上完全看不出原因。
 * @param {string[]} warnings
 * @returns {{pool:object|null, query:Function, source:string}}
 */
function buildDb(warnings) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
        const fail = async (sql) => {
            throw new Error(
                'pipeline eval 的 ctx.db 沒有連線：某個 agent 想下 SQL 但 TEST_DATABASE_URL 未設定。\n' +
                `  SQL 開頭：${String(sql).slice(0, 120)}\n` +
                '  要嘛設 TEST_DATABASE_URL（庫名須以 _test 結尾），要嘛確認該 agent 在 eval 情境下不該碰 DB。'
            );
        };
        return { pool: { query: fail }, query: fail, source: '（無：TEST_DATABASE_URL 未設定，任何 SQL 都會丟錯）' };
    }
    if (!/_test(\?|$)/.test(url.split('/').pop())) {
        throw new Error(`TEST_DATABASE_URL 的資料庫名必須以 _test 結尾（收到 ${url.split('/').pop()}）——eval 永遠不該打到真題庫。`);
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 2 });
    warnings.push('pipeline eval 對 TEST_DATABASE_URL 開了連線池：只有真 agent 需要 few-shot／text_hash 查詢時才會用到。');
    // close() 由 runPipeline 在 finally 裡叫。run.js 最後會 process.exit()，不關也不會卡住，
    // 但 compare_pipeline.js 一輪要跑十份 PDF，每份都留一條閒置連線就會撞到 PG 的連線上限。
    return { pool, query: (sql, params) => pool.query(sql, params), source: 'TEST_DATABASE_URL', close: () => pool.end() };
}

// ───────────────────── 各節點的暫用實作 ─────────────────────
// 共同規則：回傳的一律是第 2.2 條的 Outcome 形狀，**不得 throw**。

/** extract 的 oracle stub：直接把答案卷的題目當成拆題結果（見檔頭紅線） */
function oracleExtract(sheet) {
    const questions = sheet.doc.questions.map((q, i) => ({
        idx: 1000 + i + 1,                      // chunk_no(1) * 1000 + 題序
        subject: q.subject,
        chapter: q.chapter,
        chapter_confidence: 0.99,               // oracle：一定過零成本閘門
        question_type: q.question_type,
        difficulty: q.difficulty,
        question_text: q.question_text,
        answer_text: q.answer_text,
        chunk_no: 1,
        page_range: [1, sheet.doc.page_count || 1]
    }));
    return { kind: 'pass', data: { questions, rejected: [] } };
}

/** dedup0：完全確定性，任何情況下都是真的（不需要 agent） */
function runDedup0({ questionText, dbHashes, jobHashes, idx }) {
    const hash = shims.textHash(questionText);
    const normalized = shims.normalizeStem(questionText);
    if (!hash) {
        return { kind: 'fail', reason: 'schema_invalid', data: { text_hash: null, normalized_len: 0, hit: null } };
    }
    if (dbHashes.has(hash)) {
        return {
            kind: 'fail', reason: 'duplicate',
            data: { text_hash: hash, normalized_len: normalized.length, hit: { scope: 'db', question_id: dbHashes.get(hash) } }
        };
    }
    const prior = jobHashes.get(hash);
    if (prior !== undefined && prior < idx) {
        return {
            kind: 'fail', reason: 'duplicate',
            data: { text_hash: hash, normalized_len: normalized.length, hit: { scope: 'job', jq_id: prior } }
        };
    }
    jobHashes.set(hash, idx);
    return { kind: 'pass', data: { text_hash: hash, normalized_len: normalized.length, hit: null } };
}

/** classify 的暫用實作：**只做**第一層零成本閘門，不呼叫 LLM */
function gateClassify({ subject, chapter, chapter_confidence }, minConf) {
    if (isValidChapter(subject, chapter) && Number(chapter_confidence) >= minConf) {
        return {
            kind: 'pass',
            data: { chapter, confidence: Number(chapter_confidence), rationale: '零成本閘門通過', source: 'gate' }
        };
    }
    return {
        kind: 'fail',
        reason: 'chapter_invalid',
        feedback: `「${chapter}」不在白名單內或信心不足（${chapter_confidence} < ${minConf}）；第二層 LLM 需要 agents/classify.js（WS-B）`
    };
}

/** lint 的暫用實作：有 WS-C 的 formulaFix／formulaLint 就用，沒有就 skipped */
function stubLint({ question_text, answer_text }) {
    const fix = shims.tryRequire('utils/formulaFix.js');
    const lint = shims.tryRequire('utils/formulaLint.js');
    if (!fix || !lint || typeof fix.formulaFix !== 'function' || typeof lint.formulaLint !== 'function') {
        return { kind: 'skipped', data: { skipped_reason: 'utils/formulaFix.js／formulaLint.js 尚未合入（WS-C 的 A-T4）' } };
    }
    const q = fix.formulaFix(question_text);
    const a = fix.formulaFix(answer_text);
    const res = lint.formulaLint(q.text);
    const applied = [...q.applied, ...a.applied];
    if (res.ok) {
        return { kind: 'pass', data: { question_text: q.text, answer_text: a.text, applied, issues: res.issues, rewritten: false } };
    }
    // 第三層 LLM 重寫是 agents/lint.js 的事；暫用實作沒有它，所以照第 3.3 條的閘門判 fail。
    return { kind: 'fail', reason: 'formula_unparsable', data: { question_text: q.text, answer_text: a.text, applied, issues: res.issues, rewritten: false } };
}

/** verify 的暫用實作：證明題 skipped，其餘一律 skipped 並記原因（**不猜答案**） */
function stubVerify({ question_type }) {
    if (question_type === '證明') {
        return { kind: 'skipped', data: { skipped: true } };
    }
    return { kind: 'skipped', data: { skipped: true, skipped_reason: 'agents/verify.js 尚未合入（WS-C 的 A-T10b）；不以答案卷代打，否則 answer_agree_rate 恆為 1' } };
}

/** dedup1 的暫用實作：沒有向量就 skipped（第 3.3 條就是這麼寫的） */
function stubDedup1() {
    return { kind: 'skipped', data: { verdict: 'skipped', threshold_used: null, top: [] } };
}

/** save 的暫用實作：跑 validateQuestionFields（有的話），沒有就做最小欄位檢查 */
function stubSave(fields) {
    const v = shims.tryRequire('utils/questionValidation.js');
    if (v && typeof v.validateQuestionFields === 'function') {
        const res = v.validateQuestionFields(fields);
        return res.ok
            ? { kind: 'pass', data: { validated_by: 'utils/questionValidation.js' } }
            : { kind: 'fail', reason: 'schema_invalid', data: { errors: res.errors } };
    }
    const errors = [];
    if (!isValidChapter(fields.subject, fields.chapter)) errors.push(`章節「${fields.chapter}」不在「${fields.subject}」的白名單`);
    if (!fields.question_text || !String(fields.question_text).trim()) errors.push('question_text 不可為空');
    if (!fields.answer_text || !String(fields.answer_text).trim()) errors.push('answer_text 不可為空');
    return errors.length === 0
        ? { kind: 'pass', data: { validated_by: 'eval/lib/pipelineDriver.js（暫用最小檢查）' } }
        : { kind: 'fail', reason: 'schema_invalid', data: { errors } };
}

// ───────────────────── 主流程 ─────────────────────

/**
 * 把一份 PDF 走完整條管線。
 *
 * @param {object} opts
 * @param {string} opts.pdfPath
 * @param {object} opts.sheet            eval/lib/pdfGolden.js 的 loadSheet() 回傳
 * @param {object} [opts.llm]            services/llm（真 agent 才用得到）；未給時由本檔 require
 * @param {Map<string,number>} [opts.dbHashes]  已入庫題的 text_hash → question_id（模擬 questions 表）
 * @param {object} [opts.config]         覆寫 thresholds／limits
 * @returns {Promise<object>} 見檔頭
 */
async function runPipeline(opts) {
    const warnings = [];
    const t0 = Date.now();

    const sheet = opts.sheet;
    const dbHashes = opts.dbHashes || new Map();
    const jobHashes = new Map();

    const thresholds = Object.assign({
        classifyMinConf: Number(process.env.CLASSIFY_MIN_CONF || 0.8),
        dedupDup: Number(process.env.DEDUP_DUP_THRESHOLD || 0.97),
        dedupVariant: Number(process.env.DEDUP_VARIANT_THRESHOLD || 0.90),
        pdfChunkPages: Number(process.env.JOB_PDF_CHUNK_PAGES || 20),
        inlineMaxBytes: Number(process.env.GEMINI_INLINE_MAX_BYTES || 15728640),
        nodeTimeoutMs: Number(process.env.JOB_NODE_TIMEOUT_MS || 120000)
    }, (opts.config && opts.config.thresholds) || {});

    const budgetUsd = Number((opts.config && opts.config.budgetUsd) ?? process.env.JOB_COST_BUDGET_USD ?? 0.5);

    const agents = {};
    const agentSources = {};
    for (const [name, rel] of Object.entries(AGENT_FILES)) {
        const mod = loadAgent(rel);
        agents[name] = mod;
        agentSources[name] = mod ? rel : null;
    }
    if (!agents.extract) agentSources.extract = 'oracle-stub';
    if (!agents.classify) agentSources.classify = 'gate-only-stub';
    if (!agents.lint) agentSources.lint = 'stub';
    if (!agents.verify) agentSources.verify = 'stub';
    if (!agents.dedup) agentSources.dedup = 'stub';

    const db = buildDb(warnings);
    // 本函式從這裡開始的每一條 return 路徑都要關掉連線池，所以主體包在 runInner 裡，
    // 由外層的 try/finally 統一收尾——比在四個 return 前面各補一次 close() 可靠。
    try {
        return await runInner();
    } finally {
        if (typeof db.close === 'function') await db.close().catch(() => {});
    }

    async function runInner() {
    const llm = opts.llm || require('../../services/llm');
    const events = [];
    const replayMisses = [];
    let costUsd = 0;
    let tokenIn = 0, tokenOut = 0, tokenThinking = 0;

    const logger = { info() {}, warn() {}, error() {} };

    /**
     * 呼叫一個節點並記一列事件。
     * @returns {Promise<object>} Outcome
     */
    async function callNode({ node, jqId, run }) {
        const started = Date.now();
        let outcome;
        try {
            outcome = await run();
        } catch (err) {
            // 第 3.1 條：agent 不得 throw；真的 throw 了就由呼叫端包成 error（runner 的行為）。
            outcome = { kind: 'error', errorClass: 'provider_error', message: err.message };
        }
        const latency = Date.now() - started;
        const usage = (outcome && outcome._usage) || null;
        let cost = { cost_usd: 0, cost_estimated: false };
        if (usage) {
            tokenIn += usage.tokenIn || 0;
            tokenOut += usage.tokenOut || 0;
            tokenThinking += usage.tokenThinking || 0;
            cost = shims.estimateCost({
                modelId: usage.modelId, tokenIn: usage.tokenIn, tokenOut: usage.tokenOut,
                tokenThinking: usage.tokenThinking, tokenCached: usage.tokenCached || 0
            });
            costUsd += cost.cost_usd;
        }
        if (outcome.kind === 'error' && replayMiss.isReplayMiss(outcome.message)) {
            // 分辨「模型真的掛了」與「這一輪根本沒有對應的 cassette」。
            // 兩者都是 provider_error，但前者重跑會好、後者重跑一萬次都一樣。
            const { agent: missAgent, key } = replayMiss.parseReplayMiss(outcome.message);
            replayMisses.push({ node, agent: missAgent, key, message: outcome.message });
        }
        events.push({
            jq_id: jqId,
            node,
            attempt: 1,
            model: usage ? usage.modelId : null,
            token_in: usage ? usage.tokenIn : null,
            token_out: usage ? usage.tokenOut : null,
            token_thinking: usage ? usage.tokenThinking : null,
            token_cached: usage ? (usage.tokenCached || 0) : null,
            cost_usd: cost.cost_usd,
            cost_estimated: cost.cost_estimated,
            latency_ms: latency,
            outcome: outcome.kind === 'fail' ? 'fail' : outcome.kind === 'error' ? 'error' : outcome.kind === 'skipped' ? 'skipped' : 'pass',
            error_class: outcome.kind === 'error' ? outcome.errorClass : (outcome.kind === 'fail' ? outcome.reason : null),
            detail: outcome.data || null
        });
        return outcome;
    }

    /** 給真 agent 用的 ctx（第 3.1 條） */
    function makeCtx(jq) {
        return {
            llm,
            db,
            job: { id: 0, budget_usd: budgetUsd, cost_usd: costUsd },
            jq,
            logger,
            config: {
                models: {
                    extract: process.env.MODEL_EXTRACT || 'gemini:gemini-3.5-flash',
                    verify: process.env.MODEL_VERIFY || 'gemini:gemini-3.7-flash'
                },
                limits: sm.tables().DEFAULT_LIMITS,
                thresholds
            },
            signal: undefined
        };
    }

    // ── extract（job 層節點，jq 為 null）──
    const extractOutcome = await callNode({
        node: 'extract', jqId: null,
        run: async () => {
            if (!agents.extract) return oracleExtract(sheet);
            return agents.extract.run(makeCtx(null), {
                jobId: 0,
                pdfPath: path.resolve(opts.pdfPath),
                chunk: { no: 1, fromPage: 1, toPage: thresholds.pdfChunkPages }
            });
        }
    });

    if (extractOutcome.kind !== 'pass') {
        const missNote = replayMisses.length
            ? `extract 未通過：replay 找不到 cassette（agent=${replayMisses[0].agent} key=${(replayMisses[0].key || '').slice(0, 12)}…）。` +
              '本輪的樣卷是 eval/fixtures/sample_exam.pdf；cassette 必須對「這一份」樣卷錄製（裁決 S2-15）。'
            : `extract 未通過：${extractOutcome.reason || extractOutcome.errorClass}`;
        return {
            ok: false,
            reason: missNote,
            replayMisses,
            jq: [], events, agentSources,
            stateMachine: sm.source(),
            totals: { tokenIn, tokenOut, tokenThinking, costUsd, latencyMs: Date.now() - t0 },
            warnings, thresholds
        };
    }

    // ── 逐題推進 ──
    const jq = (extractOutcome.data.questions || []).map((q, i) => ({
        id: i + 1,
        idx: q.idx,
        state: 'extracted',
        retries: {},
        review_reason: null,
        payload: { extract: q }
    }));

    const NODE_FOR_STATE = sm.tables().NODE_FOR_STATE;
    const TERMINAL = sm.tables().TERMINAL_STATES;
    const limits = { ...sm.tables().DEFAULT_LIMITS };

    for (const row of jq) {
        // 上限：每題最多 Σ maxRetries + Σ maxErrorRetries + 6 步（第 2.4 條的「會停」性質）。
        // 這裡多留一倍當保險絲——真的跑到就是狀態機壞了，不是資料問題。
        let guard = 0;
        const guardMax = 2 * (6 + 5 + 3 * 6);

        while (!TERMINAL.includes(row.state)) {
            if (++guard > guardMax) {
                throw new Error(`idx=${row.idx} 在 ${guardMax} 步內沒有落到終態：狀態機（${sm.source()}）可能有迴圈。`);
            }
            const node = NODE_FOR_STATE[row.state];
            limits.budgetLeft = budgetUsd - costUsd;

            const ex = row.payload.extract;
            const lintText = row.payload.lint || {};
            const outcome = await callNode({
                node, jqId: row.id,
                run: async () => {
                    switch (node) {
                        case 'dedup0':
                            if (agents.dedup && typeof agents.dedup.runL0 === 'function') {
                                return agents.dedup.runL0(makeCtx(row), { question_text: ex.question_text });
                            }
                            return runDedup0({ questionText: ex.question_text, dbHashes, jobHashes, idx: row.id });
                        case 'classify':
                            if (agents.classify) {
                                return agents.classify.run(makeCtx(row), {
                                    subject: ex.subject, chapter: ex.chapter,
                                    chapter_confidence: ex.chapter_confidence, question_text: ex.question_text
                                });
                            }
                            return gateClassify(ex, thresholds.classifyMinConf);
                        case 'lint':
                            if (agents.lint) {
                                return agents.lint.run(makeCtx(row), {
                                    question_text: ex.question_text, answer_text: ex.answer_text,
                                    feedback: lintText.feedback
                                });
                            }
                            return stubLint({ question_text: ex.question_text, answer_text: ex.answer_text });
                        case 'verify':
                            if (agents.verify) {
                                return agents.verify.run(makeCtx(row), {
                                    question_text: (row.payload.lint && row.payload.lint.question_text) || ex.question_text,
                                    question_type: ex.question_type,
                                    claimed_answer: (row.payload.lint && row.payload.lint.answer_text) || ex.answer_text
                                });
                            }
                            return stubVerify({ question_type: ex.question_type });
                        case 'dedup1':
                            if (agents.dedup && typeof agents.dedup.runL1 === 'function') {
                                return agents.dedup.runL1(makeCtx(row), {
                                    question_id: null,
                                    embed_text: ex.question_text,
                                    subject: ex.subject, chapter: ex.chapter
                                });
                            }
                            return stubDedup1();
                        case 'save':
                            return stubSave({
                                subject: ex.subject,
                                chapter: (row.payload.classify && row.payload.classify.chapter) || ex.chapter,
                                question_type: ex.question_type,
                                difficulty: ex.difficulty,
                                question_text: (row.payload.lint && row.payload.lint.question_text) || ex.question_text,
                                answer_text: (row.payload.lint && row.payload.lint.answer_text) || ex.answer_text
                            });
                        default:
                            throw new Error(`未知的節點「${node}」`);
                    }
                }
            });

            // runner 的職責：把 data 寫進 payload[node]、把 feedback 塞進 payload[node].feedback（第 2.3 條規則 5）
            const payloadKey = node === 'save' ? 'save' : node;
            if (outcome.data) row.payload[payloadKey] = { ...(row.payload[payloadKey] || {}), ...outcome.data };
            if (outcome.kind === 'fail' && outcome.feedback) {
                row.payload[payloadKey] = { ...(row.payload[payloadKey] || {}), feedback: outcome.feedback };
            }

            const next = sm.transition({ state: row.state, retries: row.retries, outcome, limits });
            row.state = next.state;
            row.retries = next.retries;
            row.review_reason = next.review_reason;
        }

        if (row.state === 'saved') {
            const h = shims.textHash(row.payload.extract.question_text);
            if (h && !dbHashes.has(h)) dbHashes.set(h, 10000 + row.id);
        }
    }

    // 部分 cassette 也算 miss：只要有任一節點 replay 找不到，整輪就不是可信的量測
    //（第 5.2 條／裁決 S2-14：main 上的 replay miss 是錯誤，不是警告）。
    if (replayMisses.length) {
        const m = replayMisses[0];
        return {
            ok: false,
            reason: `有 ${replayMisses.length} 個節點 replay 找不到 cassette（第一個：agent=${m.agent} key=${(m.key || '').slice(0, 12)}…）。` +
                `請在本機以 LLM_MODE=record 重跑 --suite pipeline 補錄。`,
            jq, events, agentSources, replayMisses,
            stateMachine: sm.source(),
            totals: { tokenIn, tokenOut, tokenThinking, costUsd, latencyMs: Date.now() - t0 },
            db: db.source,
            warnings, thresholds
        };
    }

    return {
        ok: true,
        jq, events, agentSources, replayMisses,
        stateMachine: sm.source(),
        totals: { tokenIn, tokenOut, tokenThinking, costUsd, latencyMs: Date.now() - t0 },
        db: db.source,
        warnings, thresholds
    };
    }   // ← runInner
}

/**
 * 由 runPipeline 的結果算出 A-T14 要的指標。
 * @param {object} res runPipeline 的回傳
 * @returns {{nodePass:Object, reviewReasons:Array, saved:number, needsReview:number, rejected:number, pending:number}}
 */
function summarizePipeline(res) {
    const nodePass = {};
    for (const e of res.events) {
        const s = nodePass[e.node] || (nodePass[e.node] = { pass: 0, fail: 0, error: 0, skipped: 0, total: 0, latencies: [] });
        s[e.outcome]++;
        s.total++;
        s.latencies.push(e.latency_ms);
    }
    const jq = res.jq || [];
    return {
        nodePass,
        reviewReasons: jq.filter(r => r.state === 'needs_review').map(r => r.review_reason),
        saved: jq.filter(r => r.state === 'saved').length,
        needsReview: jq.filter(r => r.state === 'needs_review').length,
        rejected: jq.filter(r => r.state === 'rejected').length,
        pending: jq.filter(r => !['saved', 'needs_review', 'rejected'].includes(r.state)).length
    };
}

/**
 * 這一輪的結果裡，有哪些欄位因為用了 stub 而**不可以當成數字報出去**。
 * @param {object} res
 * @returns {{fakeExtract:boolean, fakeVerify:boolean, anyStub:boolean, notes:string[]}}
 */
function stubCaveats(res) {
    const s = res.agentSources || {};
    const fakeExtract = s.extract === 'oracle-stub';
    const fakeVerify = s.verify === 'stub';
    const notes = [];
    if (fakeExtract) {
        notes.push('agents/extract.js 尚未合入：拆題結果直接取自答案卷（oracle stub），' +
            'extract_recall 與 chapter_acc 在定義上必為 1.0，**一律印 n/a**。');
    }
    if (s.classify === 'gate-only-stub') {
        notes.push('agents/classify.js 尚未合入：classify 只跑第一層零成本閘門，沒有第二層 LLM。' +
            '閘門通過率是真的，整體分類正確率不是。');
    }
    if (s.lint === 'stub') notes.push('agents/lint.js 尚未合入：lint 只跑 utils/formulaFix + formulaLint（有的話），沒有第三層 LLM 重寫。');
    if (fakeVerify) notes.push('agents/verify.js 尚未合入：verify 一律 skipped，answer_agree_rate 印 n/a。');
    if (s.dedup === 'stub') notes.push('agents/dedup.js 尚未合入：L0 用 eval 自己的確定性實作（真的），L1 一律 skipped。');
    const anyStub = Object.values(s).some(v => v && String(v).includes('stub'));
    return { fakeExtract, fakeVerify, anyStub, notes };
}

module.exports = {
    runPipeline, summarizePipeline, stubCaveats,
    runDedup0, gateClassify, oracleExtract, AGENT_FILES
};
