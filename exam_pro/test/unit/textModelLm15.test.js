// ─────────────────────────────────────────────────────────────
// 〔本機模式 LM-15〕MODEL_TEXT：純文字工作（分類、公式重寫、知識點標註、主控助教）用哪個模型
//
// Owner 2026-09-25 選方案 A：16 GB 的電腦同時只放得下一個 8B 模型，文字工作不再沿用視覺的拆題模型，
// 改用純文字的 MODEL_VERIFY（qwen3:8b），拆完題就不必來回換載。
// Gemini 模式下 MODEL_TEXT＝MODEL_EXTRACT：cassette 的鍵、費用與之前一字不差（本檔也驗這一點）。
// 不連 Gemini、不連 Ollama、不連 DB。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const models = require('../../config/models');
const classify = require('../../agents/classify');
const lintAgent = require('../../agents/lint');
const tagKc = require('../../agents/tagKc');
const kcTagService = require('../../services/kcTagService');
const assistant = require('../../services/assistantService');
const local = require('../../eval/lib/localMode');
const sp = require('../../eval/lib/suiteProcess');

const APP = path.resolve(__dirname, '..', '..');
const KEYS = ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG', 'MODEL_VOICE', 'MODEL_ASSISTANT', 'MODEL_TUTOR'];
const saved = {};
before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
after(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

const GEMINI = { MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview' };
function useGemini() { Object.assign(process.env, GEMINI); }

// ───────────────────────── config/models.js ─────────────────────────

describe('config/models.js — MODEL_TEXT 的退回規則', () => {
    test('什麼都沒設（本機）：MODEL_TEXT＝MODEL_VERIFY（qwen3:8b），不是視覺模型', () => {
        assert.equal(models.MODEL_EXTRACT, 'ollama:qwen3-vl:8b');
        assert.equal(models.MODEL_TEXT, 'ollama:qwen3:8b');
        assert.equal(models.MODEL_TEXT, models.MODEL_VERIFY);
    });

    test('Gemini 模式：MODEL_TEXT＝MODEL_EXTRACT（與加這個設定之前相同）；沒有前綴的舊值也算 Gemini', () => {
        useGemini();
        assert.equal(models.MODEL_TEXT, 'gemini:gemini-3.5-flash');
        process.env.MODEL_EXTRACT = 'gemini-3.5-flash';
        assert.equal(models.MODEL_TEXT, 'gemini-3.5-flash');
    });

    test('即時跟著變：改 MODEL_VERIFY／MODEL_EXTRACT 後再讀就是新值（getter，不是快照）', () => {
        process.env.MODEL_VERIFY = 'ollama:gemma3:12b';
        assert.equal(models.MODEL_TEXT, 'ollama:gemma3:12b');
        process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
        assert.equal(models.MODEL_TEXT, 'gemini:gemini-3.5-flash', '拆題換成 Gemini → 文字工作也回到拆題模型');
    });

    test('明寫就照用；全空白視為沒設；拆題模型寫錯時不丟錯（退回 MODEL_EXTRACT，由 parseModel 的呼叫端報錯）', () => {
        process.env.MODEL_TEXT = ' ollama:qwen3:4b ';
        assert.equal(models.MODEL_TEXT, 'ollama:qwen3:4b');
        process.env.MODEL_TEXT = '   ';
        assert.equal(models.MODEL_TEXT, 'ollama:qwen3:8b');
        delete process.env.MODEL_TEXT;
        process.env.MODEL_EXTRACT = 'nope:x';
        assert.equal(models.MODEL_TEXT, 'nope:x');
    });

    test('MODEL_KC_TAG 未設沿用 MODEL_TEXT；MODEL_VOICE 仍沿用 MODEL_EXTRACT；MODEL_TUTOR 仍沿用 MODEL_VERIFY', () => {
        assert.equal(models.MODEL_KC_TAG, 'ollama:qwen3:8b');
        assert.equal(models.MODEL_VOICE, 'ollama:qwen3-vl:8b');
        assert.equal(models.MODEL_TUTOR, 'ollama:qwen3:8b');
        useGemini();
        assert.equal(models.MODEL_KC_TAG, 'gemini:gemini-3.5-flash', 'Gemini 模式：KC_TAG 仍＝MODEL_EXTRACT（第 5.2 條）');
        process.env.MODEL_KC_TAG = 'gemini:kc-x';
        assert.equal(models.MODEL_KC_TAG, 'gemini:kc-x');
    });

    test('本機預設下拆題與驗算仍是兩個不同的模型（MODEL_TEXT 不影響異級驗證）', () => {
        assert.notEqual(models.parseModel(models.MODEL_EXTRACT).id, models.parseModel(models.MODEL_VERIFY).id);
    });
});

// ───────────────────────── agents ─────────────────────────

function fakeLlm(data) {
    const calls = [];
    return {
        calls,
        llm: {
            generateJson: async (opts) => {
                calls.push(opts);
                return { data: typeof data === 'function' ? data(opts) : data, usage: {}, latencyMs: 1, raw: null };
            },
            embed: async () => { throw new Error('不該呼叫 embed'); }
        }
    };
}
function agentCtx(llm, modelsCfg) {
    return {
        llm, db: null,
        job: { id: 1, budget_usd: 1, cost_usd: 0 },
        jq: { id: 1, idx: 1001, payload: {}, retries: {} },
        logger: { info() {}, warn() {}, error() {} },
        config: {
            models: modelsCfg,
            limits: { maxRetries: { classify: 2, lint: 2, verify: 1 }, maxErrorRetries: 3, budgetLeft: Infinity },
            thresholds: { classifyMinConf: 0.8 },
            features: {}
        },
        signal: undefined
    };
}
const QUESTION = '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的夾角。';
const LINT_BROKEN = { question_text: '$\\vecc{a}$ 與 $\\vec{b}$ 的內積為 $0$。', answer_text: '互相垂直。' };
const LINT_FIXED = { question_text: '$\\vec{a}$ 與 $\\vec{b}$ 的內積為 $0$。', answer_text: '互相垂直。', notes: '' };

describe('agents：分類與公式重寫用 ctx.config.models.text', () => {
    test('classify：有 text 就用 text（本機＝qwen3:8b），不用視覺的 extract', async () => {
        const { llm, calls } = fakeLlm({ chapter: '向量內積', confidence: 0.95, rationale: 'r' });
        await classify.run(agentCtx(llm, { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' }),
            { subject: '數學', chapter: '向量內積', chapter_confidence: 0.5, question_text: QUESTION });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].model, 'ollama:qwen3:8b');
    });

    test('classify：沒給 text（舊的 ctx）→ 退回 extract，與之前相同', async () => {
        const { llm, calls } = fakeLlm({ chapter: '向量內積', confidence: 0.95, rationale: 'r' });
        await classify.run(agentCtx(llm, { extract: 'gemini:gemini-3.5-flash' }),
            { subject: '數學', chapter: '向量內積', chapter_confidence: 0.5, question_text: QUESTION });
        assert.equal(calls[0].model, 'gemini:gemini-3.5-flash');
    });

    test('classify：cassette 的鍵只含 template、題目、few-shot id——換模型只改 modelId 那一段，其他鍵不變', async () => {
        const a = fakeLlm({ chapter: '向量內積', confidence: 0.95, rationale: 'r' });
        const b = fakeLlm({ chapter: '向量內積', confidence: 0.95, rationale: 'r' });
        const input = { subject: '數學', chapter: '向量內積', chapter_confidence: 0.5, question_text: QUESTION };
        await classify.run(agentCtx(a.llm, { extract: 'gemini:gemini-3.5-flash', text: 'gemini:gemini-3.5-flash' }), input);
        await classify.run(agentCtx(b.llm, { extract: 'gemini:gemini-3.5-flash' }), input);
        assert.deepEqual(a.calls[0], b.calls[0], 'Gemini 模式下 text＝extract：送給 llm 的參數完全相同');
    });

    test('lint 第三層：有 text 就用 text；沒給退回 extract', async () => {
        const one = fakeLlm(LINT_FIXED);
        await lintAgent.run(agentCtx(one.llm, { extract: 'ollama:qwen3-vl:8b', text: 'ollama:qwen3:8b' }), LINT_BROKEN);
        assert.equal(one.calls[0].model, 'ollama:qwen3:8b');
        const two = fakeLlm(LINT_FIXED);
        await lintAgent.run(agentCtx(two.llm, { extract: 'gemini:gemini-3.5-flash' }), LINT_BROKEN);
        assert.equal(two.calls[0].model, 'gemini:gemini-3.5-flash');
    });

    test('tagKc.modelOf：kcTag → text → extract', () => {
        assert.equal(tagKc.modelOf({ config: { models: { kcTag: 'a', text: 'b', extract: 'c' } } }), 'a');
        assert.equal(tagKc.modelOf({ config: { models: { text: 'b', extract: 'c' } } }), 'b');
        assert.equal(tagKc.modelOf({ config: { models: { extract: 'c' } } }), 'c');
        assert.equal(tagKc.modelOf({ config: { models: {} } }), undefined);
    });
});

// ───────────────────────── services ─────────────────────────

describe('services：知識點標註與主控助教', () => {
    test('kcTagService.loadTagConfig：本機沒設 MODEL_KC_TAG → qwen3:8b；Gemini → MODEL_EXTRACT；明寫優先', () => {
        assert.equal(kcTagService.loadTagConfig({}).model, 'ollama:qwen3:8b');
        useGemini();
        assert.equal(kcTagService.loadTagConfig({}).model, 'gemini:gemini-3.5-flash');
        assert.equal(kcTagService.loadTagConfig({ MODEL_KC_TAG: ' ollama:qwen3:4b ' }).model, 'ollama:qwen3:4b');
    });

    function scripted() {
        const calls = [];
        return {
            calls,
            async generateJson(opts) { calls.push(opts); return { data: { action: 'final', reply: 'ok' }, usage: {}, latencyMs: 0 }; }
        };
    }

    test('assistantService：沒設 MODEL_ASSISTANT → 本機用 qwen3:8b、Gemini 用 MODEL_EXTRACT；明寫優先', async () => {
        let llm = scripted();
        await assistant.runAssistant({ message: '嗨', deps: { llm, students: [] } });
        assert.equal(llm.calls[0].model, 'ollama:qwen3:8b');

        useGemini();
        llm = scripted();
        await assistant.runAssistant({ message: '嗨', deps: { llm, students: [] } });
        assert.equal(llm.calls[0].model, 'gemini:gemini-3.5-flash');

        process.env.MODEL_ASSISTANT = 'gemini:assist-x';
        llm = scripted();
        await assistant.runAssistant({ message: '嗨', deps: { llm, students: [] } });
        assert.equal(llm.calls[0].model, 'gemini:assist-x');
    });
});

// ───────────────────────── runner 與 eval 的 ctx ─────────────────────────

describe('runner 與 eval 組的 ctx.config.models 都帶 text', () => {
    const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

    test('workers/jobRunner.js：models 有 text（取 MODEL_TEXT）；config/models 缺席時的退路也照同一條規則', () => {
        const src = read('workers/jobRunner.js');
        assert.match(src, /text: m\.MODEL_TEXT \|\| m\.MODEL_EXTRACT/);
        assert.match(src, /text: String\(process\.env\.MODEL_TEXT \|\| ''\)\.trim\(\) \|\| \(\/\^ollama:\/i\.test\(extract\.trim\(\)\) \? verify : extract\)/);
    });

    for (const rel of ['eval/lib/pipelineDriver.js', 'eval/lib/suiteClassify.js', 'eval/lib/suiteVariant.js',
        'eval/classify_chem.js', 'scripts/record_cassettes.js', 'services/aiService.js']) {
        test(`${rel}：ctx 的 models 帶 text（＝MODEL_TEXT），分類 eval 量到的就是實際上線的模型`, () => {
            assert.match(read(rel), /text: (require\('\.\.\/\.\.\/config\/models'\)|models)\.MODEL_TEXT/);
        });
    }
});

describe('eval/lib/localMode 與 suiteProcess', () => {
    test('effectiveModels：MODEL_TEXT 沒設時照 getter 的規則；明寫照用', () => {
        assert.equal(local.effectiveModels({}).MODEL_TEXT, 'ollama:qwen3:8b');
        assert.equal(local.effectiveModels(GEMINI).MODEL_TEXT, 'gemini:gemini-3.5-flash');
        assert.equal(local.effectiveModels({ ...GEMINI, MODEL_TEXT: 'ollama:qwen3:8b' }).MODEL_TEXT, 'ollama:qwen3:8b');
    });

    test('recordingPlan：預設（本機或 Gemini）不多列一列、要下載的模型不變；明寫第三個模型才另列', () => {
        const ALL = ['retrieval', 'classify', 'pipeline', 'nlq', 'variant', 'e2e'];
        const plain = local.recordingPlan({ models: {}, suites: ALL });
        assert.ok(!plain.uses.some(u => u.key === 'MODEL_TEXT'));
        assert.deepEqual(plain.ollama, ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b']);
        const gem = local.recordingPlan({ models: GEMINI, suites: ['classify'] });
        assert.deepEqual(gem.uses.map(u => u.key), ['MODEL_EXTRACT', 'MODEL_VERIFY']);

        const third = local.recordingPlan({ models: { ...GEMINI, MODEL_TEXT: 'ollama:qwen3:4b' }, suites: ['classify'] });
        assert.deepEqual(third.uses.find(u => u.key === 'MODEL_TEXT'), { key: 'MODEL_TEXT', spec: 'ollama:qwen3:4b' });
        assert.deepEqual(third.ollama, ['qwen3:4b']);
        assert.equal(local.isLocalRun({ ...GEMINI, MODEL_TEXT: 'ollama:qwen3:4b' }), true);
        assert.equal(local.localRecordEnv(third).JOB_NODE_TIMEOUT_MS, '2700000');
    });

    test('suiteProcess：ci.yml 寫了 MODEL_TEXT 才照它（CI_OPTIONAL_KEYS），沒寫就設空字串交給程式預設', () => {
        assert.ok(sp.CI_OPTIONAL_KEYS.includes('MODEL_TEXT'));
        const env = sp.ciEnv({ base: { MODEL_TEXT: 'gemini:from-dotenv' }, envFileKeys: [], models: { ...GEMINI, source: 'x' } });
        assert.equal(env.MODEL_TEXT, '', '.env 的 MODEL_TEXT 不得流進子行程（會改變 cassette 的鍵）');
        const env2 = sp.ciEnv({ base: {}, envFileKeys: [], models: { ...GEMINI, MODEL_TEXT: 'ollama:qwen3:8b', source: 'x' } });
        assert.equal(env2.MODEL_TEXT, 'ollama:qwen3:8b');
    });
});
