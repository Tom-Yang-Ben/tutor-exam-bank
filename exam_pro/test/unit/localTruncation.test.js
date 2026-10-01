// ─────────────────────────────────────────────────────────────
// test/unit/localTruncation.test.js — 本機模式被截斷的回應不重試、直接進複核
//（〔Owner 第五輪 C-f＝2 核准〕dec/r6-local-tuning；migration 0020 的 output_truncated）
//
// 驗證：
//   1. 狀態機規則 6a：error 且 finishReason='MAX_TOKENS'、limits.retryTruncated === false → needs_review('output_truncated')，
//      計數器不動；retryTruncated 沒給（Gemini）→ 照舊重試；finishReason 不是 MAX_TOKENS → 照舊重試；
//      預算用盡仍先是 budget_exceeded；DEFAULT_LIMITS 不變。
//   2. 節點（verify、lint、classify；kc_tag 只記下）把供應商的 finishReason 帶在 error outcome 上；沒有時 outcome 形狀與之前相同。
//   3. Ollama adapter：done_reason=length 且 JSON 不完整 → schema_invalid＋finishReason 'MAX_TOKENS'；
//      經 services/llm 時驗算帶的是本機預設上限 3072（C-c）。
//   4. runner（假 db）：本機模型被截斷 → 一次就 needs_review('output_truncated')、事件記 finish_reason、不退避；
//      Gemini 模型被截斷 → 照舊重試（verify:error 計數＋1）；資料庫還沒套 0020 → 退回 schema_invalid、錯誤只印一次。
// 不連 Ollama、不連 Gemini、不連 PG。真 PG 的版本在 test/integration/localTruncation.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../../pipeline/stateMachine');
const runner = require('../../workers/jobRunner');

const TRUNCATED = Object.freeze({ kind: 'error', errorClass: 'schema_invalid', message: 'Unterminated string in JSON', finishReason: 'MAX_TOKENS' });
const QUIET = { info() { }, warn() { }, error() { } };

/** services/llm 丟出來的截斷錯誤（與 services/llm/ollama.js、gemini.js 的形狀相同） */
function truncErr(finishReason = 'MAX_TOKENS') {
    return Object.assign(new SyntaxError('Unterminated string in JSON at position 3071'), { errorClass: 'schema_invalid', finishReason });
}

describe('狀態機規則 6a（C-f）', () => {
    for (const state of ['hashed', 'classified', 'source_checked']) {
        test(`${state}：本機被截斷 → needs_review('output_truncated')，計數器不動`, () => {
            const retries = { lint: 1 };
            const r = sm.transition({ state, retries, outcome: TRUNCATED, limits: { ...sm.DEFAULT_LIMITS, retryTruncated: false } });
            assert.deepEqual(r, { state: 'needs_review', retries: { lint: 1 }, review_reason: 'output_truncated' });
            assert.notEqual(r.retries, retries, '不就地修改');
        });
    }

    test('retryTruncated 沒給（Gemini）：照舊重試到 maxErrorRetries，最後是 schema_invalid', () => {
        let retries = {};
        for (let i = 1; i <= 3; i++) {
            const r = sm.transition({ state: 'source_checked', retries, outcome: TRUNCATED });
            assert.deepEqual([r.state, r.review_reason, r.retries['verify:error']], ['source_checked', null, i]);
            retries = r.retries;
        }
        assert.deepEqual(sm.transition({ state: 'source_checked', retries, outcome: TRUNCATED }),
            { state: 'needs_review', retries, review_reason: 'schema_invalid' });
        assert.equal(sm.transition({ state: 'source_checked', retries: {}, outcome: TRUNCATED, limits: { retryTruncated: true } }).state, 'source_checked');
    });

    test('本機但不是截斷（finishReason 是 STOP、null、沒有）：照舊重試', () => {
        for (const finishReason of ['STOP', null, undefined]) {
            const outcome = { ...TRUNCATED, finishReason };
            const r = sm.transition({ state: 'source_checked', retries: {}, outcome, limits: { retryTruncated: false } });
            assert.deepEqual([r.state, r.retries], ['source_checked', { 'verify:error': 1 }], String(finishReason));
        }
    });

    test('預算用盡仍是 budget_exceeded（規則 3 在前）；DEFAULT_LIMITS 沒有多欄位；REVIEW_REASON_FOR_FAIL 認得 output_truncated', () => {
        const r = sm.transition({ state: 'source_checked', retries: {}, outcome: TRUNCATED, limits: { retryTruncated: false, budgetLeft: 0 } });
        assert.equal(r.review_reason, 'budget_exceeded');
        assert.deepEqual(Object.keys(sm.DEFAULT_LIMITS).sort(), ['budgetLeft', 'maxErrorRetries', 'maxRetries']);
        assert.equal(sm.REVIEW_REASON_FOR_FAIL('output_truncated'), 'output_truncated');
        assert.equal(sm.REVIEW_REASON_FOR_ERROR('schema_invalid'), 'schema_invalid');
    });

    test('pass／fail 不受 finishReason 影響', () => {
        const pass = sm.transition({ state: 'source_checked', outcome: { kind: 'pass', finishReason: 'MAX_TOKENS' }, limits: { retryTruncated: false } });
        assert.equal(pass.state, 'verified');
        const fail = sm.transition({ state: 'source_checked', outcome: { kind: 'fail', reason: 'answer_mismatch', finishReason: 'MAX_TOKENS' }, limits: { retryTruncated: false } });
        assert.deepEqual([fail.state, fail.retries], ['source_checked', { verify: 1 }]);
    });
});

describe('節點把 finishReason 帶給 runner（C-f）', () => {
    function ctxWith(err) {
        return {
            llm: { generateJson: async () => { throw err; }, embed: async () => { throw new Error('不該算向量'); } },
            db: null, job: { id: 1, kind: 'pdf', subject_group: 'math_physics' }, logger: QUIET, signal: undefined,
            config: { models: { verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b', extract: 'ollama:qwen3-vl:8b' }, thresholds: {}, features: {} }
        };
    }

    test('verify：截斷 → error＋finishReason；沒有 finishReason 時 outcome 與之前相同', async () => {
        const verify = require('../../agents/verify');
        const input = { question_text: '求 1+1', question_type: '計算', claimed_answer: '2' };
        assert.deepEqual(await verify.run(ctxWith(truncErr()), input), { ...TRUNCATED, message: truncErr().message });
        const plain = await verify.run(ctxWith(Object.assign(new Error('boom'), { errorClass: 'provider_error' })), input);
        assert.deepEqual(plain, { kind: 'error', errorClass: 'provider_error', message: 'boom' });
    });

    test('lint（第三層 LLM 重寫）：截斷 → error＋finishReason', async () => {
        const lint = require('../../agents/lint');
        // 規則修不好的公式：未閉合的 $（與 test/unit 的 lint 測試同一種寫法）
        const input = { question_text: '設 $\\frac{1}{2 為一數，求其值。', answer_text: '$\\frac{1}{2$' };
        const out = await lint.run(ctxWith(truncErr()), input);
        assert.equal(out.kind, 'error');
        assert.equal(out.finishReason, 'MAX_TOKENS');
        assert.equal(out.errorClass, 'schema_invalid');
    });

    test('classify（LLM 那一層）：截斷 → error＋finishReason', async () => {
        const classify = require('../../agents/classify');
        const input = { subject: '數學', chapter: null, chapter_confidence: 0, question_text: '求 1+1 的值。' };
        const out = await classify.run(ctxWith(truncErr()), input);
        assert.deepEqual([out.kind, out.errorClass, out.finishReason], ['error', 'schema_invalid', 'MAX_TOKENS']);
    });

    test('kc_tag：截斷 → error＋finishReason（不在狀態機裡，只記下）', async () => {
        const tagKc = require('../../agents/tagKc');
        const ctx = { ...ctxWith(truncErr()), config: { models: { kcTag: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' } } };
        const out = await tagKc.run(ctx, {
            question_text: '求 1+1', subject: '數學', chapter: '向量',
            kcs: [{ code: 'MATH.向量.01', name: '向量加法', description: '兩向量相加' }]
        });
        assert.deepEqual([out.kind, out.errorClass, out.finishReason], ['error', 'schema_invalid', 'MAX_TOKENS']);
    });
});

describe('Ollama adapter 與 services/llm（C-c＋C-f）', () => {
    const ollama = require('../../services/llm/ollama');
    const throttle = require('../../services/llm/throttle');
    const KEYS = ['LLM_MODE', 'OLLAMA_NO_THINK', 'OLLAMA_MAX_OUTPUT_VERIFY', 'OLLAMA_NUM_CTX'];
    const saved = {};
    before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    after(() => {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        ollama._resetForTest();
    });
    beforeEach(() => { for (const k of KEYS) delete process.env[k]; ollama._resetForTest(); throttle._resetForTest(); });

    test('done_reason=length、JSON 寫到一半 → schema_invalid＋finishReason MAX_TOKENS；驗算送的是本機預設 3072', async () => {
        process.env.LLM_MODE = 'live';
        const sent = [];
        ollama._setTransportForTest(async (url, payload) => {
            sent.push(payload);
            return {
                status: 200,
                text: JSON.stringify({
                    model: payload.model, done: true, done_reason: 'length',
                    message: { role: 'assistant', content: '{"final_answer":"(A)","steps_summary":"很長很長' }, prompt_eval_count: 300, eval_count: 3072
                })
            };
        });
        const llm = require('../../services/llm');
        const { buildSchema } = require('../../agents/schemas');
        await assert.rejects(llm.generateJson({
            model: 'ollama:qwen3:8b', system: 's', parts: [{ text: 'x' }], schema: buildSchema('verify'),
            maxOutputTokens: 8192, thinkingBudget: 1024, agent: 'verify', template: 'verify.v1', cacheKeyParts: { sampleNo: 1 }
        }), (err) => err.errorClass === 'schema_invalid' && err.finishReason === 'MAX_TOKENS');
        assert.equal(sent[0].options.num_predict, 3072);
        assert.equal(sent[0].think, true, '驗算照舊思考（C-c 只降上限）');
    });
});

describe('runner（假 db）：本機被截斷不重試（C-f）', () => {
    const KEYS = ['MODEL_VERIFY', 'MODEL_EXTRACT', 'MODEL_TEXT'];
    const saved = {};
    before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    const DEF_0019 = "CHECK (review_reason = ANY (ARRAY['ocr_only'::text]))";
    const DEF_0020 = "CHECK (review_reason = ANY (ARRAY['ocr_only'::text, 'output_truncated'::text]))";

    function row(id) {
        return {
            id, job_id: 9, idx: 1001, state: 'source_checked', retries: {},
            payload: { extract: { subject: '數學', chapter: '向量', question_text: '求 1+1', answer_text: '2', question_type: '計算' } },
            kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics',
            budget_usd: 0.5, cost_usd: 0
        };
    }

    function fakeDb(jq, { def = DEF_0020 } = {}) {
        const log = [];
        return {
            log,
            pool: { connect: async () => { throw new Error('不該開交易'); } },
            async query(text, params) {
                log.push({ text, params });
                if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: [jq], rowCount: 1 };
                if (/job_questions_review_reason_check/.test(text)) return { rows: def === null ? [] : [{ def }], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }
        };
    }

    async function runOnce({ model, def = DEF_0020, finishReason = 'MAX_TOKENS', logger = QUIET } = {}) {
        process.env.MODEL_VERIFY = model;
        process.env.MODEL_EXTRACT = model.startsWith('ollama:') ? 'ollama:qwen3-vl:8b' : 'gemini:gemini-3.5-flash';
        const jq = row(77);
        const db = fakeDb(jq, { def });
        const sleeps = [];
        const llm = { generateJson: async () => { throw truncErr(finishReason); }, embed: async () => ({ vectors: [], usage: { tokenIn: 0 } }) };
        const r = runner.createRunner({ db, llm, logger, sleep: async (ms) => { sleeps.push(ms); }, config: { renewIntervalMs: 60000 } });
        await r.runJobQuestion(jq.id);
        const upd = db.log.find(q => /UPDATE job_questions SET state = \$2/.test(q.text));
        const ev = db.log.find(q => /INSERT INTO job_events/.test(q.text));
        return { db, upd, ev, sleeps, detail: JSON.parse(ev.params[14]) };
    }

    test('本機（ollama）：一次就 needs_review(output_truncated)、不退避；事件照實記 schema_invalid＋finish_reason', async () => {
        const { upd, ev, sleeps, detail } = await runOnce({ model: 'ollama:qwen3:8b' });
        assert.deepEqual([upd.params[1], JSON.parse(upd.params[2]), upd.params[3]], ['needs_review', {}, 'output_truncated']);
        assert.equal(ev.params[2], 'verify');
        assert.deepEqual([ev.params[12], ev.params[13]], ['error', 'schema_invalid']);
        assert.equal(detail.finish_reason, 'MAX_TOKENS');
        assert.equal(detail.review_reason, 'output_truncated');
        assert.deepEqual(sleeps, [], '沒有退避睡眠（不重試）');
    });

    test('Gemini：照舊重試（verify:error＋1、退避一次），事件 detail 不多 finish_reason（Gemini 路徑與之前相同）', async () => {
        const { upd, sleeps, detail } = await runOnce({ model: 'gemini:gemini-3.1-pro-preview' });
        assert.deepEqual([upd.params[1], JSON.parse(upd.params[2]), upd.params[3]], ['source_checked', { 'verify:error': 1 }, null]);
        assert.equal(sleeps.length, 1);
        assert.equal('finish_reason' in detail, false, 'Gemini 的 error 事件不記 finish_reason');
        assert.deepEqual(Object.keys(detail).sort(), ['message', 'review_reason'], 'Gemini 的 error 事件 detail 只有原本的鍵');
    });

    test('本機但沒被截斷（finishReason STOP）：照舊重試；事件 detail 的 finish_reason 照實記', async () => {
        const { upd, detail } = await runOnce({ model: 'ollama:qwen3:8b', finishReason: 'STOP' });
        assert.deepEqual([upd.params[1], upd.params[3]], ['source_checked', null]);
        assert.equal(detail.finish_reason, 'STOP');
    });

    test('資料庫還沒套 0020：退回 schema_invalid（不撞 CHECK）、仍然不重試；錯誤只印一次、叫 Owner npm run migrate', async () => {
        const errors = [];
        const logger = { ...QUIET, error: (o) => errors.push(o) };
        const { upd, detail } = await runOnce({ model: 'ollama:qwen3:8b', def: DEF_0019, logger });
        assert.deepEqual([upd.params[1], upd.params[3]], ['needs_review', 'schema_invalid']);
        assert.equal(detail.review_reason, 'schema_invalid');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].msg, runner.OUTPUT_TRUNCATED_SCHEMA_MESSAGE);
        assert.match(errors[0].msg, /npm run migrate/);
        assert.match(errors[0].msg, /0020/);
    });

    test('outputTruncatedAccepted／isLocalTruncation（純函式）', async () => {
        const q = (def) => ({ query: async () => ({ rows: def === null ? [] : [{ def }] }) });
        assert.equal(await runner.outputTruncatedAccepted(q(DEF_0020)), true);
        assert.equal(await runner.outputTruncatedAccepted(q(DEF_0019)), false);
        assert.equal(await runner.outputTruncatedAccepted(q(null)), true, '約束不存在＝不會被擋');
        assert.equal(runner.isLocalTruncation(TRUNCATED, 'ollama:qwen3:8b'), true);
        assert.equal(runner.isLocalTruncation(TRUNCATED, 'gemini:gemini-3.1-pro-preview'), false);
        assert.equal(runner.isLocalTruncation(TRUNCATED, 'gemini-3.5-flash'), false, '裸 ID＝Gemini');
        assert.equal(runner.isLocalTruncation({ ...TRUNCATED, kind: 'fail' }, 'ollama:qwen3:8b'), false);
        assert.equal(runner.isLocalTruncation({ ...TRUNCATED, finishReason: 'STOP' }, 'ollama:qwen3:8b'), false);
    });
});

describe('複核頁（public/js/review.js）：output_truncated 的標籤與說明句（C-f）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js'), 'utf8');

    test('標籤、顏色（下拉選單也從這張表產生）與說明句', async () => {
        assert.match(SOURCE, /output_truncated: '本機模型回應被截斷'/);
        assert.match(SOURCE, /output_truncated: 'slate'/);
        const { reasonSentence } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE));
        const s = reasonSentence('output_truncated', { extract: { question_text: '題幹' } });
        assert.match(s, /^本機模型寫到這一步的輸出上限被截斷/);
        assert.match(s, /不重試/);
        assert.match(s, /OLLAMA_MAX_OUTPUT_VERIFY/);
        // classify、lint 被截斷也進這個原因：說明句不能把「驗算上限 3072」當成這一步的上限，也要給這兩步的調整方向
        assert.doesNotMatch(s, /（驗算上限 3072 token）/);
        assert.match(s, /OLLAMA_NUM_CTX_CLASSIFY/);
        assert.match(s, /_LINT/);
    });
});
