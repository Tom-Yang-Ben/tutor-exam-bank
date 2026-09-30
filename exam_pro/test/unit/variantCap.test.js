// ─────────────────────────────────────────────────────────────
// test/unit/variantCap.test.js — 變式生成的本機輸出上限與截斷不重試（〔Owner 第七輪 R7-1＝4〕dec/r10-variant-cap；
// docs/local-mode.md 10.24）
//
// 驗證：
//   1. localTuning：variant／variant_chem 的本機預設上限 1024（只在 vendor 是 ollama 時由 services/llm 套用）；
//      OLLAMA_MAX_OUTPUT_VARIANT（或 _VARIANT_CHEM）可覆寫；寫 8192 以上＝取消預設（不送 num_predict，與 R7-1 之前相同）；
//      亂填＝沒寫；checkOverrides 的 defaults 列出它、取消時列在生效的裡面且不警告；textModelIsLocal 也看 MODEL_VARIANT；
//      沒有本機預設的 agent（classify）寫 8192 照舊送 8192（UNCAPPED_CEILING 只管有預設的）。
//   2. services/llm：ollama 送 num_predict 1024、Gemini 一個字都不讀（不帶 maxOutputTokens）；record 在 request.ollamaOverrides
//      記 {numPredict:1024}、鍵與沒套用時相同；replay 不讀（repo 裡本機錄的 variant.v2 回放檔照樣回放）。
//   3. agents/generateVariant.js：generateJson 丟的錯帶 finishReason 時放進 error outcome；沒帶時 outcome 與之前逐欄相同；
//      真的 agent＋services/llm＋假的 Ollama（done_reason=length）→ {kind:'error', errorClass:'schema_invalid', finishReason:'MAX_TOKENS'}。
//   4. workers/jobRunner.js：localOutputCapOf（事件記的輸出上限）與 variantTruncationNote；isLocalTruncation 認得變式的 outcome。
//   runGenerateOne 的「截斷不重試、寫事件、繼續下一題」與「非截斷的 error 仍重試」在 test/integration/variantTruncation.pg.test.js。
// 不連 Ollama、不連 Gemini、不連 DB。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tuning = require('../../services/llm/localTuning');
const ollama = require('../../services/llm/ollama');
const gemini = require('../../services/llm/gemini');
const throttle = require('../../services/llm/throttle');
const cassette = require('../../services/llm/cassette');
const fake = require('../../services/llm/fake');
const llm = require('../../services/llm');
const variantAgent = require('../../agents/generateVariant');
const { buildSchema } = require('../../agents/schemas');
const jobRunner = require('../../workers/jobRunner');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENV_KEYS = [
    'LLM_MODE', 'EVAL_CASSETTE_DIR', 'OLLAMA_HOST', 'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_PROGRESS_MS', 'OLLAMA_NO_THINK',
    'OLLAMA_MAX_OUTPUT_VARIANT', 'OLLAMA_MAX_OUTPUT_VARIANT_CHEM', 'OLLAMA_MAX_OUTPUT_VERIFY', 'OLLAMA_MAX_OUTPUT_CLASSIFY',
    'GEMINI_API_KEY', 'MODEL_VARIANT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG'
];
const saved = {};
let tmp;

before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '變式上限-'));
});
after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    ollama._resetForTest();
    gemini._setClientForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EVAL_CASSETTE_DIR = path.join(tmp, `cassettes-${Math.random().toString(36).slice(2)}`);
    ollama._resetForTest();
    throttle._resetForTest();
    fake._resetForTest();
    gemini._setClientForTest(null);
});

/** 一個看起來合格的變式輸出（與 test/unit/agentGenerateVariant.test.js 的 GOOD 同形） */
const GOOD = {
    chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
    question_text: '在平面上，甲船的位移為 $\\vec{p}=(6,8)$ 公里，乙船的位移為 $\\vec{q}=(5,-12)$ 公里。試求兩船位移方向之間夾角的餘弦值為何？',
    answer_text: '$-\\frac{27}{65}$'
};

/** 假的 Ollama 傳輸：doneReason='length' 時回一段寫到一半的 JSON（被截斷） */
function fakeOllama({ doneReason = 'stop', content = JSON.stringify(GOOD) } = {}) {
    const calls = [];
    ollama._setTransportForTest(async (url, payload) => {
        calls.push(JSON.parse(JSON.stringify(payload)));
        return {
            status: 200,
            text: JSON.stringify({
                model: payload.model, done: true, done_reason: doneReason,
                message: { role: 'assistant', content: doneReason === 'length' ? '{"chapter":"向量內積","question_text":"在平面上，甲船的位移為 $\\\\vec{p}=(6,8)$ 公里，乙船的位移為 $\\\\vec{q}=(6,8)$ 公里，乙船' : content },
                prompt_eval_count: 900, eval_count: doneReason === 'length' ? 1024 : 180
            })
        };
    });
    return calls;
}

/** 與 agents/generateVariant.js 送出的呼叫同形（不帶 maxOutputTokens、不帶 thinkingBudget） */
const VARIANT_CALL = Object.freeze({
    model: 'ollama:qwen3:8b', system: variantAgent.SYSTEM, parts: [{ text: '請改寫藍本題' }], schema: buildSchema('variant'),
    agent: 'variant', template: variantAgent.TEMPLATE,
    cacheKeyParts: { template: variantAgent.TEMPLATE, sourceQuestionId: 12, difficultyDelta: 0, idx: 1, anchorIds: [], total: 2, siblings: [] }
});

// ───────────────────────── 1. localTuning ─────────────────────────

describe('localTuning：variant 的本機預設上限 1024', () => {
    const r = (agent, env = {}, maxOutputTokens) => tuning.resolveOllamaOverrides({ agent, maxOutputTokens }, env);

    test('什麼都沒寫：variant、variant_chem（不分大小寫）送 1024，來源是本機預設；思考與 num_ctx 不動', () => {
        for (const agent of ['variant', 'variant_chem', 'VARIANT']) {
            assert.deepEqual(r(agent), {
                thinkingBudget: undefined, maxOutputTokens: 1024, numCtx: undefined,
                applied: { numPredict: 1024 }, sources: { numPredict: 'default' }
            }, agent);
        }
        assert.equal(tuning.LOCAL_DEFAULTS.maxOutput.variant, 1024);
        assert.equal(tuning.defaultMaxOutputFor('variant_chem'), 1024);
        assert.equal(tuning.LOCAL_DEFAULT_SOURCES.variant, 'Owner 第七輪 R7-1');
        assert.equal(tuning.UNCAPPED_CEILING, 8192);
        // 空字串、只有空白、亂填＝沒寫＝本機預設
        for (const bad of ['', '  ', 'abc', '0', '-5', '3.5']) {
            assert.deepEqual(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: bad }).applied, { numPredict: 1024 }, `「${bad}」`);
        }
    });

    test('.env 覆寫：寫多少送多少（1～8191），來源是 env；寫 1024（Owner 電腦現在的 .env）與不寫送的一樣', () => {
        assert.deepEqual([r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '512' }).maxOutputTokens, r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '512' }).sources], [512, { numPredict: 'env' }]);
        assert.deepEqual([r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '2048' }).maxOutputTokens, r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '2048' }).applied], [2048, { numPredict: 2048 }]);
        assert.deepEqual(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '8191' }).applied, { numPredict: 8191 });
        assert.deepEqual(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '1024' }).applied, r('variant', {}).applied, '值相同：送出的一樣（只有來源標示不同）');
        assert.equal(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: '1024' }).sources.numPredict, 'env');
        // 寫基本名稱連化學版一起；化學版另寫 _CHEM 可單獨覆寫
        assert.equal(r('variant_chem', { OLLAMA_MAX_OUTPUT_VARIANT: '2048' }).maxOutputTokens, 2048);
        const chemOnly = { OLLAMA_MAX_OUTPUT_VARIANT_CHEM: '3000' };
        assert.equal(r('variant_chem', chemOnly).maxOutputTokens, 3000);
        assert.equal(r('variant', chemOnly).maxOutputTokens, 1024, '只寫 _CHEM：數學／物理版仍是本機預設');
    });

    test('寫 8192（或更大）＝取消預設：不送 num_predict、applied 是空的（與 R7-1 之前逐位元相同）', () => {
        for (const v of ['8192', '9000', '65536']) {
            assert.deepEqual(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT: v }), {
                thinkingBudget: undefined, maxOutputTokens: undefined, numCtx: undefined, applied: {}, sources: {}
            }, v);
            assert.deepEqual(r('variant_chem', { OLLAMA_MAX_OUTPUT_VARIANT: v }).applied, {}, `variant_chem ${v}`);
        }
        // 只取消化學版
        assert.deepEqual(r('variant_chem', { OLLAMA_MAX_OUTPUT_VARIANT_CHEM: '8192' }).applied, {});
        assert.deepEqual(r('variant', { OLLAMA_MAX_OUTPUT_VARIANT_CHEM: '8192' }).applied, { numPredict: 1024 });
    });

    test('沒有本機預設的 agent 不受影響：classify 不寫＝不送、寫 8192 照舊送 8192；verify 的 C-c 照舊', () => {
        assert.deepEqual(r('classify').applied, {});
        assert.deepEqual(r('classify', { OLLAMA_MAX_OUTPUT_CLASSIFY: '8192' }).applied, { numPredict: 8192 });
        assert.deepEqual(r('classify', { OLLAMA_MAX_OUTPUT_CLASSIFY: '256' }).applied, { numPredict: 256 });
        assert.deepEqual(r('verify', {}, 8192).applied, { numPredict: 3072 });
        assert.deepEqual(r('verify', { OLLAMA_MAX_OUTPUT_VERIFY: '8192' }, 8192).applied, {});
        // 變式如果哪天自己帶了上限，照「只降不升」：本機預設 1024 比它小才套用
        assert.deepEqual(r('variant', {}, 512).applied, {}, '不會調高');
        assert.deepEqual(r('variant', {}, 4096).applied, { numPredict: 1024 });
    });

    test('checkOverrides：defaults 多一行 variant；取消時列在生效的裡面、不警告；覆寫時不再列在 defaults', () => {
        const line = '輸出上限：variant、variant_chem 1024（本機預設，Owner 第七輪 R7-1；OLLAMA_MAX_OUTPUT_VARIANT 可覆寫）';
        assert.ok(tuning.checkOverrides({}).defaults.includes(line), JSON.stringify(tuning.checkOverrides({}).defaults));
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VARIANT: '8192' }).active, ['輸出上限：OLLAMA_MAX_OUTPUT_VARIANT=8192（不降：取消本機預設 1024）']);
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VARIANT: '8192' }).warnings, []);
        const owner = tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VARIANT: '1024' });
        assert.deepEqual([owner.active, owner.warnings], [['輸出上限：OLLAMA_MAX_OUTPUT_VARIANT=1024'], []], 'Owner 電腦現在的 .env：列在生效的');
        assert.equal(owner.defaults.some(l => l.includes('variant')), false);
        const chem = tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VARIANT_CHEM: '2048' });
        assert.ok(chem.defaults.includes('輸出上限：variant 1024（本機預設，Owner 第七輪 R7-1；OLLAMA_MAX_OUTPUT_VARIANT 可覆寫）'), JSON.stringify(chem.defaults));
        assert.match(tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VARIANT: 'abc' }).warnings[0], /OLLAMA_MAX_OUTPUT_VARIANT=abc 不是正整數，被忽略/);
    });

    test('textModelIsLocal：MODEL_VARIANT 是 ollama 也算（驗算是 Gemini、變式是本機時，啟動訊息照樣列本機預設）', () => {
        assert.equal(tuning.textModelIsLocal({ MODEL_VERIFY: 'gemini:x' }), false);
        assert.equal(tuning.textModelIsLocal({ MODEL_VERIFY: 'gemini:x', MODEL_VARIANT: 'ollama:qwen3:8b' }), true);
        assert.equal(tuning.textModelIsLocal({ MODEL_VERIFY: 'gemini:x', MODEL_VARIANT: 'gemini:y' }), false);
    });
});

// ───────────────────────── 2. services/llm ─────────────────────────

describe('services/llm：只在 vendor 是 ollama 時套用', () => {
    test('live、ollama：什麼都沒寫送 num_predict 1024（不思考照舊）；寫 8192 不送；寫 2048 送 2048', async () => {
        process.env.LLM_MODE = 'live';
        const calls = fakeOllama();
        await llm.generateJson({ ...VARIANT_CALL });
        process.env.OLLAMA_MAX_OUTPUT_VARIANT = '8192';
        await llm.generateJson({ ...VARIANT_CALL });
        process.env.OLLAMA_MAX_OUTPUT_VARIANT = '2048';
        await llm.generateJson({ ...VARIANT_CALL, agent: 'variant_chem' });
        assert.deepEqual(calls.map(c => c.options), [
            { temperature: 0, num_ctx: 16384, num_predict: 1024 },
            { temperature: 0, num_ctx: 16384 },
            { temperature: 0, num_ctx: 16384, num_predict: 2048 }
        ]);
        assert.equal(calls[0].think, false, '變式本來就不思考');
    });

    test('Gemini 路徑一個字都不讀：不帶 maxOutputTokens（與 R7-1 之前相同），寫了 OLLAMA_MAX_OUTPUT_VARIANT 也一樣', async () => {
        process.env.LLM_MODE = 'live';
        process.env.GEMINI_API_KEY = 'test-key';
        const seen = [];
        gemini._setClientForTest({
            models: {
                generateContent: async (req) => {
                    seen.push(req.config);
                    return { text: JSON.stringify(GOOD), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
                }
            }
        });
        const calls = fakeOllama();
        await llm.generateJson({ ...VARIANT_CALL, model: 'gemini:gemini-3.1-pro-preview' });
        process.env.OLLAMA_MAX_OUTPUT_VARIANT = '100';
        await llm.generateJson({ ...VARIANT_CALL, model: 'gemini:gemini-3.1-pro-preview' });
        assert.equal(seen.length, 2);
        for (const c of seen) assert.equal('maxOutputTokens' in c, false, JSON.stringify(c));
        assert.equal(calls.length, 0);
    });

    test('record：request.ollamaOverrides 記 {numPredict:1024}；取消預設時沒有這個欄位；鍵相同（只有一支）', async () => {
        process.env.LLM_MODE = 'record';
        fakeOllama();
        const origLog = console.log;
        console.log = () => { };
        const key = cassette.cassetteKey({ agent: 'variant', modelId: 'qwen3:8b', template: VARIANT_CALL.template, schema: VARIANT_CALL.schema, cacheKeyParts: VARIANT_CALL.cacheKeyParts });
        try {
            await llm.generateJson({ ...VARIANT_CALL });
            assert.deepEqual(cassette.readCassette('variant', key).request.ollamaOverrides, { numPredict: 1024 });
            process.env.OLLAMA_MAX_OUTPUT_VARIANT = '8192';
            await llm.generateJson({ ...VARIANT_CALL });
            assert.deepEqual(Object.keys(cassette.readCassette('variant', key).request), ['parts', 'cacheKeyParts']);
            assert.equal(fs.readdirSync(path.join(process.env.EVAL_CASSETTE_DIR, 'variant')).length, 1, '鍵沒變');
        } finally {
            console.log = origLog;
        }
    });

    test('record 時被截斷（done_reason=length）→ 錯誤回放檔（被截斷）、丟出的錯帶 finishReason；回放丟出同形的錯', async () => {
        process.env.LLM_MODE = 'record';
        const calls = fakeOllama({ doneReason: 'length' });
        const origLog = console.log;
        console.log = () => { };
        let recorded;
        try {
            await assert.rejects(llm.generateJson({ ...VARIANT_CALL }), (err) => { recorded = err; return true; });
        } finally {
            console.log = origLog;
        }
        assert.equal(calls[0].options.num_predict, 1024);
        assert.deepEqual([recorded.errorClass, recorded.finishReason, recorded.errorCassette.kind], ['schema_invalid', 'MAX_TOKENS', 'truncated']);
        process.env.LLM_MODE = 'replay';
        await assert.rejects(llm.generateJson({ ...VARIANT_CALL }), (err) => {
            assert.deepEqual([err.errorClass, err.finishReason, err.message], [recorded.errorClass, recorded.finishReason, recorded.message]);
            return true;
        });
    });

    test('replay 不讀：repo 裡本機錄的 variant.v2 回放檔，OLLAMA_MAX_OUTPUT_VARIANT 怎麼寫都照樣回放（鍵不含它）', async (t) => {
        delete process.env.EVAL_CASSETTE_DIR;   // 讀 repo 的 eval/cassettes
        process.env.LLM_MODE = 'replay';
        const dir = path.join(APP_DIR, 'eval', 'cassettes', 'variant');
        const doc = fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
            .find(d => d.meta.model === 'qwen3:8b' && d.meta.template === 'variant.v2' && d.response && d.response.data);
        if (!doc) {
            t.skip('repo 的 eval/cassettes/variant/ 沒有本機（qwen3:8b）錄的 variant.v2 回放檔——以本機模型重錄後自動恢復執行');
            return;
        }
        const base = { ...VARIANT_CALL, cacheKeyParts: doc.request.cacheKeyParts };
        const calls = fakeOllama();
        for (const v of [undefined, '1024', '8192', '10']) {
            if (v === undefined) delete process.env.OLLAMA_MAX_OUTPUT_VARIANT; else process.env.OLLAMA_MAX_OUTPUT_VARIANT = v;
            const res = await llm.generateJson({ ...base });
            assert.equal(res.replayed, true, String(v));
            assert.deepEqual(res.data, doc.response.data);
        }
        assert.equal(calls.length, 0, 'replay 不呼叫 Ollama');
    });
});

// ───────────────────────── 3. agents/generateVariant.js ─────────────────────────

describe('generateVariant：error outcome 帶 finishReason（C-f 納入變式）', () => {
    const SOURCE = {
        id: 12, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(3,4)$、$\\vec{b}=(1,2)$，求兩向量的夾角餘弦值。', answer_text: '$\\frac{11}{5\\sqrt{5}}$', variant_of: null
    };
    const ctxWith = (generateJson) => ({
        llm: { generateJson, embed: async () => { throw new Error('不該算向量'); } },
        db: null, job: { id: 1, kind: 'variant', pdf_sha256: null, budget_usd: 0.3, cost_usd: 0 }, jq: null,
        logger: { info() { }, warn() { }, error() { } },
        config: { models: { variant: 'ollama:qwen3:8b' }, limits: {}, thresholds: { variantOfftopicSimMin: 0.92, variantMinEdit: 0.08 } }
    });
    const INPUT = { source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 1, total: 2, siblings: [] };

    test('錯帶 finishReason → outcome.finishReason（字串）；沒帶（逾時、連不上）→ outcome 與之前逐欄相同', async () => {
        const truncated = await variantAgent.run(ctxWith(async () => {
            throw Object.assign(new SyntaxError('Unterminated string in JSON at position 1023'), { errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' });
        }), INPUT);
        assert.deepEqual(truncated, { kind: 'error', errorClass: 'schema_invalid', message: 'Unterminated string in JSON at position 1023', finishReason: 'MAX_TOKENS' });
        const timeout = await variantAgent.run(ctxWith(async () => {
            throw Object.assign(new Error('Ollama 逾時'), { errorClass: 'timeout', finishReason: null });
        }), INPUT);
        assert.deepEqual(timeout, { kind: 'error', errorClass: 'timeout', message: 'Ollama 逾時' });
        const plain = await variantAgent.run(ctxWith(async () => { throw new Error('ECONNREFUSED'); }), INPUT);
        assert.deepEqual(plain, { kind: 'error', errorClass: 'provider_error', message: 'ECONNREFUSED' });
    });

    test('真的 agent＋services/llm（live）＋假的 Ollama 寫到 1024 被截斷 → {error, schema_invalid, MAX_TOKENS}；runner 判成本機截斷', async () => {
        process.env.LLM_MODE = 'live';
        const calls = fakeOllama({ doneReason: 'length' });
        const outcome = await variantAgent.run(ctxWith((args) => llm.generateJson(args)), INPUT);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.num_predict, 1024);
        assert.deepEqual([outcome.kind, outcome.errorClass, outcome.finishReason], ['error', 'schema_invalid', 'MAX_TOKENS']);
        assert.equal(jobRunner.isLocalTruncation(outcome, 'ollama:qwen3:8b'), true);
        assert.equal(jobRunner.isLocalTruncation(outcome, 'gemini:gemini-3.1-pro-preview'), false, 'Gemini 的截斷照舊重試');
        assert.equal(jobRunner.isLocalTruncation({ kind: 'error', errorClass: 'timeout' }, 'ollama:qwen3:8b'), false, '逾時不是截斷');
    });
});

// ───────────────────────── 4. workers/jobRunner.js 的兩個小工具 ─────────────────────────

describe('jobRunner：事件記的輸出上限與說明', () => {
    test('localOutputCapOf：與 services/llm 同一條公式（預設 1024、覆寫、取消＝null）；沒有 agent＝null', () => {
        assert.equal(jobRunner.localOutputCapOf('variant', null, {}), 1024);
        assert.equal(jobRunner.localOutputCapOf('variant_chem', undefined, {}), 1024);
        assert.equal(jobRunner.localOutputCapOf('variant', null, { OLLAMA_MAX_OUTPUT_VARIANT: '2048' }), 2048);
        assert.equal(jobRunner.localOutputCapOf('variant', null, { OLLAMA_MAX_OUTPUT_VARIANT: '8192' }), null);
        assert.equal(jobRunner.localOutputCapOf('verify', 8192, {}), 3072);
        assert.equal(jobRunner.localOutputCapOf(null, null, {}), null);
        assert.equal(jobRunner.localOutputCapOf('classify', null, {}), null);
    });

    test('variantTruncationNote：說明被截斷、上限多少、不重試放棄這一題', () => {
        assert.equal(jobRunner.variantTruncationNote(1024),
            '本機模型的回應寫到輸出上限（1024 token）被截斷：不重試，放棄這一題（Owner 第七輪 R7-1＝4；docs/local-mode.md 10.24）。');
        assert.equal(jobRunner.variantTruncationNote(null),
            '本機模型的回應寫到輸出上限被截斷：不重試，放棄這一題（Owner 第七輪 R7-1＝4；docs/local-mode.md 10.24）。');
    });
});
