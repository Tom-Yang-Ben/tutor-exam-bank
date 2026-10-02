// ─────────────────────────────────────────────────────────────
// test/unit/engineChoice.test.js — 拆題與助教可選本機或 Gemini（〔dec/r13-engine-choice〕docs/local-mode.md 10.26）
//
// 驗證（不連 DB、不連 Ollama、不連 Gemini；假 LLM 只記下收到的 model）：
//   1. config/engines.js：engine 的解析、照 .env 的預設、換引擎時各節點的模型（GEMINI_MODEL_* 與 GEMINI_DEFAULTS 的退回）、
//      金鑰檢查（不回傳金鑰本身）。
//   2. runner（假 db）：jobs.engine＝gemini 的題每個節點拿到 Gemini、＝local 拿到 ollama、NULL 或等於 .env 時與 loadModels() 相同；
//      embed 一律不帶 model（＝EMBED_MODEL）；拆題的每塊頁數與節點逾時跟著引擎；知識點標註的模型跟著引擎。
//   3. 家教：engine 換模型（Gemini 有 code execution、本機沒有）、沒帶時與之前相同、沒金鑰 400。
//   4. 助教：engine 換主控與查題模型、沒帶時與之前相同、沒金鑰 400。
//   5. 前端三支 module 的 pickEngine 與家教的 buildRequestBody。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engines = require('../../config/engines');
const models = require('../../config/models');

const KEYS = ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_VARIANT', 'MODEL_OCR_STRUCTURE', 'MODEL_KC_TAG', 'MODEL_TUTOR',
    'MODEL_ASSISTANT', 'MODEL_NLQ', 'EMBED_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL_EXTRACT', 'GEMINI_MODEL_VERIFY',
    'LOCAL_MODEL_EXTRACT', 'LOCAL_MODEL_VERIFY', 'LOCAL_EXTRACT_MODE', 'OCR_ENGINE', 'JOB_PDF_CHUNK_PAGES', 'JOB_NODE_TIMEOUT_MS',
    'JOB_CONCURRENCY', 'FEATURE_KC_TAGGING', 'TUTOR_DAILY_BUDGET_USD'];
const saved = {};
/** 假的金鑰字串（只用來表示「有設」；從來沒有送出去） */
const FAKE_KEY = 'fake-key-for-tests-only';

before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
/** 每個案例從「本機預設、沒有金鑰」開始（Owner 目前的 .env） */
beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
    process.env.MODEL_VERIFY = 'ollama:qwen3:8b';
    process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
});

// ───────────────────────── 1. config/engines.js ─────────────────────────

describe('config/engines.js', () => {
    test('parseEngine：沒帶＝null（照 .env）；大小寫與空白不計；其他值是錯誤', () => {
        for (const v of [undefined, null, '', '  ']) assert.deepEqual(engines.parseEngine(v), { engine: null });
        assert.deepEqual(engines.parseEngine('local'), { engine: 'local' });
        assert.deepEqual(engines.parseEngine(' Gemini '), { engine: 'gemini' });
        for (const v of ['ollama', 'cloud', 'openai', 1]) assert.match(engines.parseEngine(v).error, /engine 只能是 local 或 gemini/);
    });

    test('defaultEngine：看各功能 .env 實際用的模型（拆題 MODEL_EXTRACT、家教 MODEL_TUTOR→MODEL_VERIFY、助教 MODEL_ASSISTANT→MODEL_TEXT）', () => {
        assert.equal(engines.defaultEngine('extract'), 'local');
        assert.equal(engines.defaultEngine('tutor'), 'local');
        assert.equal(engines.defaultEngine('assistant'), 'local');
        process.env.MODEL_TUTOR = 'gemini:gemini-3.1-pro-preview';
        assert.equal(engines.defaultEngine('tutor'), 'gemini');
        assert.equal(engines.defaultEngine('extract'), 'local');
        process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
        process.env.MODEL_VERIFY = 'gemini:gemini-3.1-pro-preview';
        assert.equal(engines.defaultEngine('extract'), 'gemini');
        assert.equal(engines.defaultEngine('assistant'), 'gemini', 'Gemini 模式下 MODEL_TEXT＝MODEL_EXTRACT');
        // 傳別的 env（測試用）與 getter 同一套退回規則
        assert.equal(engines.defaultEngine('tutor', { MODEL_EXTRACT: 'gemini:x', MODEL_VERIFY: 'ollama:qwen3:8b' }), 'local');
        assert.equal(engines.defaultEngine('assistant', { MODEL_EXTRACT: 'ollama:a', MODEL_VERIFY: 'gemini:b' }), 'gemini', '本機拆題時文字工作＝驗算模型');
    });

    test('overrideEngine：沒帶或等於 .env 的預設 → null（呼叫端照舊）；不同 → 那個引擎', () => {
        assert.equal(engines.overrideEngine(null, 'extract'), null);
        assert.equal(engines.overrideEngine('local', 'extract'), null);
        assert.equal(engines.overrideEngine('gemini', 'extract'), 'gemini');
        assert.equal(engines.overrideEngine('bogus', 'extract'), null);
    });

    test('modelsForEngine(gemini)：.env 是本機時用 GEMINI_DEFAULTS；GEMINI_MODEL_* 優先；ollama 的 MODEL_* 不會被帶過去', () => {
        process.env.MODEL_TEXT = 'ollama:qwen3:8b';
        process.env.MODEL_TUTOR = 'ollama:qwen3:8b';
        process.env.MODEL_NLQ = 'ollama:qwen3:8b';
        const g = engines.modelsForEngine('gemini');
        assert.equal(g.extract, models.GEMINI_DEFAULTS.MODEL_EXTRACT);
        assert.equal(g.verify, models.GEMINI_DEFAULTS.MODEL_VERIFY);
        assert.equal(g.text, g.extract, 'Gemini 的文字工作＝拆題模型（與 MODEL_TEXT getter 的 Gemini 規則相同）');
        assert.equal(g.variant, g.verify);
        assert.equal(g.tutor, g.verify);
        assert.equal(g.kcTag, g.text);
        assert.equal(g.assistant, g.text);
        assert.equal(g.nlq, g.text);
        for (const [k, v] of Object.entries(g)) if (k !== 'engine') assert.equal(models.parseModel(v).vendor, 'gemini', k);
        assert.equal('embed' in g, false, '向量不跟著換');

        process.env.GEMINI_MODEL_VERIFY = 'gemini:gemini-3.7-flash';   // 免費層用不了 Pro
        process.env.GEMINI_MODEL_EXTRACT = 'ollama:qwen3:8b';          // 寫錯供應商：不採用
        process.env.MODEL_TUTOR = 'gemini:gemini-tutor-x';
        const g2 = engines.modelsForEngine('gemini');
        assert.equal(g2.verify, 'gemini:gemini-3.7-flash');
        assert.equal(g2.extract, models.GEMINI_DEFAULTS.MODEL_EXTRACT);
        assert.equal(g2.tutor, 'gemini:gemini-tutor-x', '各功能自己的 MODEL_* 是 gemini: 就照它');
    });

    test('modelsForEngine(local)：.env 是 Gemini 時用本機預設；文字工作＝驗算模型（LM-15）；LOCAL_MODEL_* 優先', () => {
        process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
        process.env.MODEL_VERIFY = 'gemini:gemini-3.1-pro-preview';
        const l = engines.modelsForEngine('local');
        assert.equal(l.extract, models.DEFAULT_EXTRACT);
        assert.equal(l.verify, models.DEFAULT_VERIFY);
        assert.equal(l.text, l.verify);
        assert.equal(l.ocrStructure, l.verify);
        for (const [k, v] of Object.entries(l)) if (k !== 'engine') assert.equal(models.parseModel(v).vendor, 'ollama', k);
        process.env.LOCAL_MODEL_VERIFY = 'ollama:qwen3:14b';
        assert.equal(engines.modelsForEngine('local').verify, 'ollama:qwen3:14b');
        assert.throws(() => engines.modelsForEngine('cloud'), /engine 只能是/);
    });

    test('engineAvailability／engineProblem：Gemini 要 GEMINI_API_KEY；本機拆題在 OCR 設定矛盾時不能選；沒指定一律可以', () => {
        assert.deepEqual(engines.engineAvailability('extract').gemini, { available: false, reason: engines.NO_GEMINI_KEY });
        assert.equal(engines.engineProblem('gemini', 'extract'), engines.NO_GEMINI_KEY);
        assert.match(engines.NO_GEMINI_KEY, /尚未設定 Gemini 金鑰/);
        assert.equal(engines.engineProblem(null, 'extract'), null);
        assert.equal(engines.engineProblem('local', 'tutor'), null);
        process.env.GEMINI_API_KEY = FAKE_KEY;
        assert.equal(engines.engineProblem('gemini', 'extract'), null);
        process.env.GEMINI_API_KEY = '   ';
        assert.equal(engines.engineProblem('gemini', 'tutor'), engines.NO_GEMINI_KEY, '只有空白＝沒設');
        process.env.OCR_ENGINE = 'none';
        assert.match(engines.engineProblem('local', 'extract'), /設定互相矛盾/);
        assert.equal(engines.engineProblem('local', 'tutor'), null, '家教不需要 OCR');
        process.env.LOCAL_EXTRACT_MODE = 'cross';
        assert.equal(engines.engineProblem('local', 'extract'), null);
    });

    test('describeEngines（GET /api/engines 的回應）：三個功能各自的預設與模型；不含金鑰本身', () => {
        process.env.GEMINI_API_KEY = FAKE_KEY;
        const d = engines.describeEngines();
        assert.deepEqual(Object.keys(d.purposes), ['extract', 'tutor', 'assistant']);
        assert.deepEqual(d.engines.map(e => e.id), ['local', 'gemini']);
        assert.equal(d.purposes.extract.default, 'local');
        assert.equal(d.purposes.extract.options.local.model, 'ollama:qwen3-vl:8b', '等於預設＝.env 實際的模型');
        assert.equal(d.purposes.extract.options.gemini.model, models.GEMINI_DEFAULTS.MODEL_EXTRACT);
        assert.equal(d.purposes.tutor.options.gemini.model, models.GEMINI_DEFAULTS.MODEL_VERIFY);
        assert.equal(d.purposes.tutor.options.gemini.available, true);
        assert.ok(!JSON.stringify(d).includes(FAKE_KEY), '回應裡不得出現金鑰');
        delete process.env.GEMINI_API_KEY;
        assert.equal(engines.describeEngines().purposes.assistant.options.gemini.available, false);
    });
});

// ───────────────────────── 2. runner（假 db、假 agent、假 llm）─────────────────────────

describe('runner：jobs.engine 決定這份卷每個節點的模型', () => {
    const runner = require('../../workers/jobRunner');
    const QUIET = { info() { }, warn() { }, error() { } };
    let agentsDir;
    const seen = [];   // 假 agent 記下 { node, models, thresholds }

    before(() => {
        // 假 agent：照真 agent 讀 ctx.config.models 的那個鍵呼叫 generateJson；dedup 呼叫 embed（不帶 model，與 agents/dedup.js 相同）
        agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-agents-'));
        const pick = {
            extract: 'models.extract', classify: 'models.text || models.extract', lint: 'models.text || models.extract',
            verify: 'models.verify', source_check: null, dedup: null
        };
        for (const [node, expr] of Object.entries(pick)) {
            fs.writeFileSync(path.join(agentsDir, `${node}.js`), `
module.exports.run = async (ctx, input) => {
    const models = ctx.config.models;
    globalThis.__engineSeen.push({ node: ${JSON.stringify(node)}, models, thresholds: ctx.config.thresholds });
    ${expr ? `await ctx.llm.generateJson({ model: ${expr}, agent: ${JSON.stringify(node)}, parts: [{ text: 'x' }], schema: {} });`
        : `await ctx.llm.embed({ texts: ['x'] });`}
    return { kind: 'pass', data: ${node === 'extract' ? '{ questions: [] }' : '{}'} };
};`);
        }
        globalThis.__engineSeen = seen;
    });
    after(() => { fs.rmSync(agentsDir, { recursive: true, force: true }); delete globalThis.__engineSeen; });
    beforeEach(() => { seen.length = 0; });

    function fakeLlm() {
        const calls = [];
        return {
            calls,
            async generateJson(args) { calls.push({ kind: 'json', model: args.model }); return { data: {}, usage: { tokenIn: 1, tokenOut: 1 }, latencyMs: 1 }; },
            async embed(args) { calls.push({ kind: 'embed', model: args.model }); return { vectors: [[1, 0]], usage: { tokenIn: 1 } }; }
        };
    }

    function jqRow(state, engine) {
        return {
            id: 77, job_id: 9, idx: 1001, state, retries: {},
            payload: { extract: { subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_text: '求 1+1', answer_text: '2', question_type: '計算' } },
            kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics',
            budget_usd: 0.5, cost_usd: 0, engine
        };
    }

    function fakeDb(rowFor) {
        const log = [];
        return {
            log,
            pool: { connect: async () => { throw new Error('不該開交易'); } },
            async query(text, params) {
                log.push({ text, params });
                if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: [rowFor()], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }
        };
    }

    /** 從 hashed 一路跑到 deduped（classify、lint、source_check、verify、dedup1），每一步一個節點 */
    async function runQuestionNodes(engine) {
        const states = ['hashed', 'classified', 'linted', 'source_checked', 'verified'];
        const llm = fakeLlm();
        let i = 0;
        const db = fakeDb(() => jqRow(states[i], engine));
        const r = runner.createRunner({ db, llm, agentsDir, logger: QUIET, sleep: async () => { }, config: { renewIntervalMs: 60000 } });
        for (; i < states.length; i++) await r.runJobQuestion(77);
        return { llm, nodes: seen.map(s => s.node) };
    }

    test('engine＝gemini（.env 是本機）：classify、lint、verify 都拿到 Gemini；embed 不帶 model（＝EMBED_MODEL）', async () => {
        const { llm, nodes } = await runQuestionNodes('gemini');
        assert.deepEqual(nodes, ['classify', 'lint', 'source_check', 'verify', 'dedup']);
        const json = llm.calls.filter(c => c.kind === 'json');
        assert.equal(json.length, 3);
        for (const c of json) assert.equal(models.parseModel(c.model).vendor, 'gemini', c.model);
        assert.deepEqual(json.map(c => c.model), [models.GEMINI_DEFAULTS.MODEL_EXTRACT, models.GEMINI_DEFAULTS.MODEL_EXTRACT, models.GEMINI_DEFAULTS.MODEL_VERIFY]);
        const emb = llm.calls.filter(c => c.kind === 'embed');
        assert.ok(emb.length >= 2);
        for (const c of emb) assert.equal(c.model, undefined, 'embed 不帶 model：services/llm 一律用 EMBED_MODEL');
        // 每個節點的逾時與每塊頁數是 Gemini 的預設（.env 沒明寫）
        for (const s of seen) {
            assert.equal(s.thresholds.nodeTimeoutMs, runner.loadConfig({}).nodeTimeoutMs);
            assert.equal(s.thresholds.pdfChunkPages, runner.loadConfig({}).pdfChunkPages);
        }
    });

    test('engine＝local 或 NULL（.env 是本機）：與 loadModels() 相同（ollama，文字工作＝qwen3:8b）', async () => {
        for (const engine of ['local', null]) {
            seen.length = 0;
            const { llm } = await runQuestionNodes(engine);
            assert.deepEqual(llm.calls.filter(c => c.kind === 'json').map(c => c.model), ['ollama:qwen3:8b', 'ollama:qwen3:8b', 'ollama:qwen3:8b'], String(engine));
            for (const s of seen) assert.equal(s.thresholds.nodeTimeoutMs, runner.LOCAL_NODE_TIMEOUT_MS, '本機的長節點預設');
        }
    });

    test('engine＝local（.env 是 Gemini）：全部換成 ollama；engine＝gemini 或 NULL 與 .env 相同', async () => {
        process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
        process.env.MODEL_VERIFY = 'gemini:gemini-3.1-pro-preview';
        const local = await runQuestionNodes('local');
        assert.deepEqual(local.llm.calls.filter(c => c.kind === 'json').map(c => c.model), [models.DEFAULT_VERIFY, models.DEFAULT_VERIFY, models.DEFAULT_VERIFY]);
        for (const s of seen) assert.equal(s.thresholds.nodeTimeoutMs, runner.LOCAL_NODE_TIMEOUT_MS);
        for (const engine of ['gemini', null]) {
            seen.length = 0;
            const { llm } = await runQuestionNodes(engine);
            assert.deepEqual(llm.calls.filter(c => c.kind === 'json').map(c => c.model),
                ['gemini:gemini-3.5-flash', 'gemini:gemini-3.5-flash', 'gemini:gemini-3.1-pro-preview'], String(engine));
        }
    });

    test('ctx 的形狀不變：agent 看不到 runtime（只在 runner 內部用）', async () => {
        const db = fakeDb(() => jqRow('source_checked', 'gemini'));
        let ctxKeys = null;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ctx-'));
        globalThis.__ctxKeys = (k) => { ctxKeys = k; };
        fs.writeFileSync(path.join(dir, 'verify.js'), 'module.exports.run = async (ctx) => { globalThis.__ctxKeys(Object.keys(ctx).sort()); return { kind: "pass", data: {} }; };');
        try {
            const r = runner.createRunner({ db, llm: fakeLlm(), agentsDir: dir, logger: QUIET, config: { renewIntervalMs: 60000 } });
            await r.runJobQuestion(77);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__ctxKeys; }
        assert.deepEqual(ctxKeys, ['config', 'db', 'job', 'jq', 'llm', 'logger', 'signal']);
    });

    test('拆題：engine＝gemini 用 Gemini 的拆題模型、每塊 20 頁、節點逾時 120 秒；本機逾時只重試 1 次的上限不套用', async () => {
        const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pdf-'));
        const pdf = path.join(pdfDir, 'x.pdf');
        fs.writeFileSync(pdf, '{}');
        try {
            for (const [engine, wantModel, wantPages, wantTimeout] of [
                ['gemini', models.GEMINI_DEFAULTS.MODEL_EXTRACT, 20, 120000],
                [null, 'ollama:qwen3-vl:8b', runner.LOCAL_PDF_CHUNK_PAGES, runner.LOCAL_NODE_TIMEOUT_MS]
            ]) {
                seen.length = 0;
                fs.writeFileSync(pdf, '{}');   // 拆完一份 runner 會刪 PDF：每一輪重寫一份
                const llm = fakeLlm();
                const db = {
                    pool: { connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() { } }) },
                    async query(text) {
                        if (/FROM jobs WHERE id = \$1/.test(text) && /pdf_path/.test(text)) {
                            return { rows: [{ id: 5, pdf_path: pdf, pdf_sha256: 'b'.repeat(64), page_count: 30, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0, engine }], rowCount: 1 };
                        }
                        if (/SELECT cost_usd::float8 AS cost_usd FROM jobs/.test(text)) return { rows: [{ cost_usd: 0 }], rowCount: 1 };
                        return { rows: [], rowCount: 0 };
                    }
                };
                const r = runner.createRunner({ db, llm, agentsDir, logger: QUIET, config: { renewIntervalMs: 60000 } });
                await r.runExtractJob(5);
                const ex = seen.filter(s => s.node === 'extract');
                assert.equal(ex.length, Math.ceil(30 / wantPages), String(engine));
                assert.equal(ex[0].models.extract, wantModel);
                assert.equal(ex[0].thresholds.pdfChunkPages, wantPages);
                assert.equal(ex[0].thresholds.nodeTimeoutMs, wantTimeout);
                assert.equal(llm.calls[0].model, wantModel);
            }
        } finally { fs.rmSync(pdfDir, { recursive: true, force: true }); }
    });

    test('.env 明寫的 JOB_PDF_CHUNK_PAGES／JOB_NODE_TIMEOUT_MS 與 createRunner({config}) 給的值照樣優先', async () => {
        process.env.JOB_PDF_CHUNK_PAGES = '7';
        const db = fakeDb(() => jqRow('source_checked', 'gemini'));
        const r = runner.createRunner({ db, llm: fakeLlm(), agentsDir, logger: QUIET, config: { renewIntervalMs: 60000, nodeTimeoutMs: 4321 } });
        await r.runJobQuestion(77);
        assert.equal(seen[0].thresholds.pdfChunkPages, 7);
        assert.equal(seen[0].thresholds.nodeTimeoutMs, 4321);
    });

    test('知識點標註（入庫後的掛鉤）：engine＝gemini 時 kcTagger 收到 Gemini 的標註模型；照 .env 時呼叫方式與之前相同（只有題號）', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const calls = [];
        const kcTagger = async (...args) => { calls.push(args); return { status: 'skipped' }; };
        const payload = {
            extract: { subject: '數學', chapter: '向量內積', question_text: '求 1+1', answer_text: '2', question_type: '計算', difficulty: 2 },
            dedup0: { text_hash: 'c'.repeat(64) }, classify: { chapter: '向量內積' }, lint: { question_text: '求 1+1', answer_text: '2' },
            verify: { compare: 'agree' }, dedup1: { verdict: 'unique' }
        };
        for (const engine of ['gemini', null]) {
            calls.length = 0;
            const client = { query: async (text) => (/INSERT INTO questions/.test(text) ? { rows: [{ id: 501 }], rowCount: 1 } : { rows: [], rowCount: 0 }), release() { } };
            const db = {
                pool: { connect: async () => client },
                async query(text) {
                    if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: [{ ...jqRow('deduped', engine), payload }], rowCount: 1 };
                    if (/SUM\(cost_usd\)/.test(text)) return { rows: [{ spent: 0 }], rowCount: 1 };
                    return { rows: [], rowCount: 0 };
                }
            };
            const r = runner.createRunner({ db, llm: fakeLlm(), agentsDir, logger: QUIET, kcTagger, config: { renewIntervalMs: 60000 } });
            await r.runJobQuestion(77);
            for (let k = 0; k < 20 && calls.length === 0; k++) await new Promise(res => setImmediate(res));
            assert.equal(calls.length, 1, String(engine));
            if (engine === 'gemini') assert.deepEqual(calls[0], [501, { model: models.GEMINI_DEFAULTS.MODEL_EXTRACT }]);
            else assert.deepEqual(calls[0], [501]);
        }
    });
});

// ───────────────────────── 3. 家教 ─────────────────────────

describe('家教（services/tutorService.js）：engine 決定模型', () => {
    const tutor = require('../../services/tutorService');
    const db = {
        getQuestion: async () => null, listQuestionKcs: async () => [], listChapterKcs: async () => [],
        getStudent: async () => null, listStudents: async () => [], chapterWeakness: async () => [], errorTypeCounts: async () => []
    };
    function fakeLlm() {
        const calls = [];
        return { calls, async generateText(o) { calls.push(o); return { text: '好。', codeRuns: [], usage: { tokenIn: 1, tokenOut: 1 }, latencyMs: 1 }; } };
    }
    const budget = () => tutor.createBudget({ env: { TUTOR_DAILY_BUDGET_USD: '1' } });

    test('沒帶 engine：MODEL_TUTOR（＝MODEL_VERIFY），validateTutorInput 的回傳形狀與之前相同', async () => {
        const v = tutor.validateTutorInput({ message: 'a', mode: 'direct' }, { subjects: ['數學'] });
        assert.equal('engine' in v.value, false);
        const llm = fakeLlm();
        await tutor.runTutor({ message: 'a', mode: 'direct' }, { llm, db, budget: budget() });
        assert.equal(llm.calls[0].model, 'ollama:qwen3:8b');
        assert.equal(llm.calls[0].tools.codeExecution, false);
        assert.equal(llm.calls[0].template, tutor.TEMPLATES_LOCAL.direct);
    });

    test('engine＝gemini（有金鑰）：Gemini 的家教模型、開 code execution、Gemini 的模板；engine＝local：與沒帶相同', async () => {
        process.env.GEMINI_API_KEY = FAKE_KEY;
        const llm = fakeLlm();
        await tutor.runTutor({ message: 'a', mode: 'direct', engine: 'gemini' }, { llm, db, budget: budget() });
        assert.equal(llm.calls[0].model, models.GEMINI_DEFAULTS.MODEL_VERIFY);
        assert.equal(llm.calls[0].tools.codeExecution, true);
        assert.equal(llm.calls[0].template, tutor.TEMPLATES.direct);
        const llm2 = fakeLlm();
        await tutor.runTutor({ message: 'a', mode: 'direct', engine: 'local' }, { llm: llm2, db, budget: budget() });
        const llm3 = fakeLlm();
        await tutor.runTutor({ message: 'a', mode: 'direct' }, { llm: llm3, db, budget: budget() });
        assert.deepEqual(llm2.calls[0], llm3.calls[0], '選了與 .env 相同的引擎＝送出的參數逐字相同（cassette 的鍵不變）');
    });

    test('engine＝gemini 但沒有 GEMINI_API_KEY → 400（不查 DB、不呼叫模型）；engine 不合法 → 400', async () => {
        const llm = fakeLlm();
        const boom = new Proxy({}, { get: () => () => { throw new Error('不該查 DB'); } });
        await assert.rejects(() => tutor.runTutor({ message: 'a', mode: 'direct', engine: 'gemini' }, { llm, db: boom, budget: budget() }),
            (err) => err.status === 400 && /尚未設定 Gemini 金鑰/.test(err.message));
        await assert.rejects(() => tutor.runTutor({ message: 'a', mode: 'direct', engine: 'cloud' }, { llm, db: boom, budget: budget() }),
            (err) => err.status === 400 && /engine 只能是/.test(err.message));
        assert.equal(llm.calls.length, 0);
    });
});

// ───────────────────────── 4. 助教 ─────────────────────────

describe('助教（services/assistantService.js）：engine 決定主控與查題的模型', () => {
    const assistant = require('../../services/assistantService');
    function scripted() {
        const calls = [];
        return { calls, async generateJson(o) { calls.push(o); return { data: { action: 'final', reply: '好' }, usage: {}, latencyMs: 0 }; } };
    }

    test('沒帶或等於 .env：原本的模型（本機＝MODEL_TEXT 退回的 qwen3:8b）；engine＝gemini：Gemini 的文字模型', async () => {
        const a = scripted();
        await assistant.runAssistant({ message: '哈囉', deps: { llm: a, students: [] } });
        const b = scripted();
        await assistant.runAssistant({ message: '哈囉', engine: 'local', deps: { llm: b, students: [] } });
        assert.equal(a.calls[0].model, 'ollama:qwen3:8b');
        assert.deepEqual(b.calls[0], a.calls[0], '選了與 .env 相同＝送出的參數逐字相同');
        process.env.GEMINI_API_KEY = FAKE_KEY;
        const c = scripted();
        await assistant.runAssistant({ message: '哈囉', engine: 'gemini', deps: { llm: c, students: [] } });
        assert.equal(c.calls[0].model, models.GEMINI_DEFAULTS.MODEL_EXTRACT);
    });

    test('engine＝gemini 但沒有金鑰、或 engine 不合法 → status 400，不呼叫模型', async () => {
        const a = scripted();
        await assert.rejects(() => assistant.runAssistant({ message: '哈囉', engine: 'gemini', deps: { llm: a, students: [] } }),
            (err) => err.status === 400 && /尚未設定 Gemini 金鑰/.test(err.message));
        await assert.rejects(() => assistant.runAssistant({ message: '哈囉', engine: 'x', deps: { llm: a, students: [] } }),
            (err) => err.status === 400);
        assert.equal(a.calls.length, 0);
    });

    test('查題工具（search_questions → nlq）：選了另一個引擎時帶那個引擎的模型（nlqService 的 model 參數）', async () => {
        const nlq = require('../../services/nlqService');
        const saved = nlq.searchNl;
        const seenDeps = [];
        nlq.searchNl = async (input, deps) => { seenDeps.push(deps); return { filters: {}, fallback_level: 0, results: [] }; };
        try {
            await assistant.TOOLS.search_questions.run({ query: '向量' }, { llm: {}, nlqModel: 'gemini:gemini-3.5-flash' });
            await assistant.TOOLS.search_questions.run({ query: '向量' }, { llm: {} });
        } finally { nlq.searchNl = saved; }
        assert.equal(seenDeps[0].model, 'gemini:gemini-3.5-flash');
        assert.equal('model' in seenDeps[1], false, '沒選＝與之前相同（MODEL_NLQ）');
    });
});

// ───────────────────────── 5. 前端 ─────────────────────────

describe('前端：pickEngine（三支 module 各一份，規則相同）與家教的 buildRequestBody', () => {
    const load = (file) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', file), 'utf8') + `\n// ${file}`));
    const INFO = { default: 'local', options: { local: { available: true }, gemini: { available: false, reason: '尚未設定 Gemini 金鑰' } } };

    for (const file of ['review.js', 'tutor.js', 'assistant.js']) {
        test(`${file}：上次選的（還能用）→ .env 預設 → 第一個能用的`, async () => {
            const { pickEngine } = await load(file);
            assert.equal(pickEngine(INFO, null), 'local');
            assert.equal(pickEngine(INFO, 'gemini'), 'local', 'Gemini 停用時不選它');
            const both = { default: 'local', options: { local: { available: true }, gemini: { available: true } } };
            assert.equal(pickEngine(both, 'gemini'), 'gemini', '記住上次的選擇');
            assert.equal(pickEngine(both, 'bogus'), 'local');
            assert.equal(pickEngine({ default: 'gemini', options: { local: { available: true }, gemini: { available: false } } }, null), 'local');
            assert.equal(pickEngine({ default: null, options: {} }, null), null);
            assert.equal(pickEngine(null, null), null);
        });
    }

    test('review.js：上傳帶 engine 欄位；選項文字說明費用與速度', async () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js'), 'utf8');
        assert.match(src, /formData\.append\('engine', engine\)/);
        const { engineOptionText } = await load('review.js');
        assert.equal(engineOptionText('local', { available: true }, true), '本機（免費、較慢）・.env 預設');
        assert.equal(engineOptionText('gemini', { available: false }, false), 'Gemini（需要 API 費用、較快）・尚未設定 Gemini 金鑰');
        const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.match(html, /id="pdf_engine_box" class="[^"]*\bhidden\b/, '讀到 /api/engines 之前先藏著（舊流程看不到）');
    });

    test('tutor.js buildRequestBody：engine 有選才帶；沒選時與之前逐字相同', async () => {
        const { buildRequestBody } = await load('tutor.js');
        const base = { message: 'q', mode: 'direct', subject: null, studentId: null, questionId: null, history: [] };
        assert.deepEqual(buildRequestBody(base), { message: 'q', mode: 'direct' });
        assert.deepEqual(buildRequestBody({ ...base, engine: null }), { message: 'q', mode: 'direct' });
        assert.deepEqual(buildRequestBody({ ...base, engine: 'gemini' }), { message: 'q', mode: 'direct', engine: 'gemini' });
        assert.deepEqual(buildRequestBody({ ...base, engine: 'cloud' }), { message: 'q', mode: 'direct' });
    });
});
