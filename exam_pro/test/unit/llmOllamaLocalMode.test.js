// 本機模式 L1 的設定面：預設模型、價格、語音掛載、家教不宣稱程式驗算
// （docs/local-mode.md 第 2 條、第 3 條第 1、7、9、10 點）
//
// 不連 Ollama、不連 Gemini、不連資料庫（routes/index.js 只看掛了哪些路由；DATABASE_URL 給一個不會被連的假值）。
//
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const models = require('../../config/models');
const pricing = require('../../config/pricing');
const tutor = require('../../services/tutorService');
const voice = require('../../services/voiceService');
const templates = require('../../services/llm/templates');

const MODEL_KEYS = ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_VARIANT', 'MODEL_TUTOR', 'MODEL_VOICE', 'MODEL_KC_TAG',
    'MODEL_OCR_STRUCTURE', 'EMBED_MODEL', 'MODEL_NLQ', 'MODEL_ASSISTANT'];
const ENV_KEYS = [...MODEL_KEYS, 'FEATURE_TUTOR', 'FEATURE_VOICE', 'DATABASE_URL', 'TUTOR_DAILY_BUDGET_USD'];
const envBackup = {};

before(() => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
});
after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});
beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
});

// ───────────────────────── config/models.js（第 3 條第 1 點、第 2 條）─────────────────────────

describe('config/models.js：ollama 供應商與本機預設', () => {
    test("VENDORS 含 ollama；parseModel 只切第一個冒號：'ollama:qwen3:8b' → {vendor:'ollama', id:'qwen3:8b'}", () => {
        assert.ok(models.VENDORS.includes('ollama'));
        assert.deepEqual(models.parseModel('ollama:qwen3:8b'), { vendor: 'ollama', id: 'qwen3:8b', spec: 'ollama:qwen3:8b' });
        assert.deepEqual(models.parseModel('ollama:qwen3-vl:8b'), { vendor: 'ollama', id: 'qwen3-vl:8b', spec: 'ollama:qwen3-vl:8b' });
        assert.deepEqual(models.parseModel(' OLLAMA:gemma3 '), { vendor: 'ollama', id: 'gemma3', spec: 'ollama:gemma3' });
        assert.throws(() => models.parseModel('ollama:'), /缺少模型 ID/);
    });

    test('什麼都沒設：每一個模型設定都是本機（ollama），沒有任何一個退回 Gemini', () => {
        assert.equal(models.MODEL_EXTRACT, 'ollama:qwen3-vl:8b');
        assert.equal(models.MODEL_VERIFY, 'ollama:qwen3:8b');
        assert.equal(models.EMBED_MODEL, 'ollama:qwen3-embedding:0.6b');
        assert.equal(models.MODEL_VARIANT, null, 'MODEL_VARIANT 的規則不變：未設回 null，由 runner 退回 MODEL_VERIFY');
        for (const key of ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TUTOR', 'MODEL_VOICE', 'MODEL_KC_TAG', 'MODEL_OCR_STRUCTURE', 'EMBED_MODEL']) {
            assert.equal(models.parseModel(models[key]).vendor, 'ollama', key);
        }
        assert.equal(models.DEFAULT_EXTRACT, 'ollama:qwen3-vl:8b');
        assert.equal(models.DEFAULT_VERIFY, 'ollama:qwen3:8b');
        assert.equal(models.DEFAULT_EMBED, 'ollama:qwen3-embedding:0.6b');
    });

    // 〔LM-15，Owner 2026-09-25 方案 A〕KC_TAG 改沿用 MODEL_TEXT：本機＝MODEL_VERIFY（純文字，不必換載視覺模型）；
    // Gemini 模式仍＝MODEL_EXTRACT（textModelLm15.test.js 驗）
    test('fallback 規則，終點是本機：TUTOR／OCR_STRUCTURE → MODEL_VERIFY；VOICE → MODEL_EXTRACT；KC_TAG → MODEL_TEXT（本機＝MODEL_VERIFY）', () => {
        assert.equal(models.MODEL_TUTOR, 'ollama:qwen3:8b');
        assert.equal(models.MODEL_OCR_STRUCTURE, 'ollama:qwen3:8b');
        assert.equal(models.MODEL_VOICE, 'ollama:qwen3-vl:8b');
        assert.equal(models.MODEL_KC_TAG, 'ollama:qwen3:8b');
        process.env.MODEL_VERIFY = 'ollama:gemma3:12b';
        assert.equal(models.MODEL_OCR_STRUCTURE, 'ollama:gemma3:12b', '即時跟著 MODEL_VERIFY');
        process.env.MODEL_OCR_STRUCTURE = ' ollama:qwen3:4b ';
        assert.equal(models.MODEL_OCR_STRUCTURE, 'ollama:qwen3:4b');
    });

    test('Gemini 保留：.env 明寫 gemini:… 就照用；EMBED_MODEL 沒有前綴的舊值原樣回傳（視為 Gemini）', () => {
        process.env.MODEL_EXTRACT = models.GEMINI_DEFAULTS.MODEL_EXTRACT;
        process.env.MODEL_VERIFY = models.GEMINI_DEFAULTS.MODEL_VERIFY;
        process.env.EMBED_MODEL = models.GEMINI_DEFAULTS.EMBED_MODEL;
        assert.equal(models.MODEL_EXTRACT, 'gemini:gemini-3.5-flash');
        assert.equal(models.MODEL_VERIFY, 'gemini:gemini-3.1-pro-preview');
        assert.equal(models.MODEL_TUTOR, 'gemini:gemini-3.1-pro-preview');
        assert.equal(models.EMBED_MODEL, 'gemini-embedding-001');
        assert.equal(models.parseModel(models.EMBED_MODEL).vendor, 'gemini');
    });

    test('warnIfSameModel 邏輯不變：本機兩個預設不同 → 不警告；同一個裸 ID → 警告', () => {
        const seen = [];
        const orig = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            assert.equal(models.warnIfSameModel(), false);
            process.env.MODEL_VERIFY = 'ollama:qwen3-vl:8b';
            assert.equal(models.warnIfSameModel(), true);
            assert.equal(seen[0], '[models] MODEL_VERIFY 與 MODEL_EXTRACT 是同一個模型（qwen3-vl:8b），驗證幾乎無效');
        } finally {
            console.warn = orig;
        }
    });
});

// ───────────────────────── config/pricing.js（第 3 條第 7 點）─────────────────────────

describe('config/pricing.js：ollama 的任何模型單價一律 0', () => {
    const usage = { tokenIn: 5_000_000, tokenOut: 2_000_000, tokenThinking: 1_000_000, tokenCached: 10 };

    test('帶 tag 的裸 ID、ollama: 前綴、vendor 參數、設定裡沒帶 tag 的 ollama 模型 → {0, estimated:true}，不警告', () => {
        const seen = [];
        const orig = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            process.env.MODEL_VERIFY = 'ollama:gemma3';
            for (const args of [
                { modelId: 'qwen3:8b' }, { modelId: 'qwen3-vl:8b' }, { modelId: '沒聽過的模型:latest' },
                { modelId: 'ollama:qwen3:8b' }, { modelId: 'whatever', vendor: 'ollama' }, { modelId: 'gemma3' },
                { modelId: 'qwen3-embedding:0.6b' }
            ]) {
                assert.deepEqual(pricing.estimateCost({ ...args, ...usage }), { cost_usd: 0, cost_estimated: true }, JSON.stringify(args));
            }
            assert.equal(seen.length, 0);
        } finally {
            console.warn = orig;
        }
    });

    test('雲端模型的語意不變：查得到照價、查不到仍是 {0, false}、gemini:… 前綴字串仍是查不到', () => {
        assert.equal(pricing.estimateCost({ modelId: 'gemini-3.5-flash', tokenIn: 1_000_000 }).cost_usd, 1.5);
        assert.deepEqual(pricing.estimateCost({ modelId: '不存在的模型', ...usage }), { cost_usd: 0, cost_estimated: false });
        assert.deepEqual(pricing.estimateCost({ modelId: 'gemini:gemini-3.5-flash', ...usage }), { cost_usd: 0, cost_estimated: false });
        assert.deepEqual(pricing.estimateCost({ modelId: 'gemma3', ...usage }), { cost_usd: 0, cost_estimated: false }, '沒設成 ollama 的無 tag ID 不猜');
        assert.equal(pricing.isOllamaModel('gemini-3.5-flash', 'ollama'), true, 'vendor 參數優先');
        assert.equal(pricing.isOllamaModel('qwen3:8b', 'gemini'), false);
    });

    test('家教／語音的 estimateUsd：本機模型記 0（不會被「最貴單價」高估、每日預算不會誤擋）', () => {
        assert.equal(tutor.estimateUsd('qwen3:8b', usage), 0);
        assert.ok(tutor.estimateUsd('不存在的模型', usage) > 0, '雲端的未知模型仍以最貴單價估');
    });
});

// ───────────────────────── 語音（第 3 條第 9 點）─────────────────────────

describe('語音：MODEL_VOICE 不是 gemini 時不掛載', () => {
    test('voiceStatus：旗標沒開 off；開了但 MODEL_VOICE 是本機 local；是 gemini 才 on', () => {
        assert.deepEqual(voice.voiceStatus(), { status: 'off', available: false, message: null });
        process.env.FEATURE_VOICE = 'true';
        assert.equal(voice.voiceStatus().status, 'off', 'FEATURE_VOICE 需同時開 FEATURE_TUTOR');
        process.env.FEATURE_TUTOR = 'true';
        const local = voice.voiceStatus();
        assert.equal(local.status, 'local');
        assert.equal(local.available, false);
        assert.ok(local.message.startsWith('本機模式不提供語音'), local.message);
        process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';          // MODEL_VOICE 沿用 MODEL_EXTRACT
        assert.deepEqual(voice.voiceStatus(), { status: 'on', available: true, message: null });
        process.env.MODEL_VOICE = 'ollama:qwen3:8b';
        assert.equal(voice.voiceStatus().status, 'local', 'MODEL_VOICE 明設本機也一樣');
        process.env.MODEL_VOICE = 'cohere:x';
        assert.equal(voice.voiceStatus().status, 'local', '寫錯無法解析：不掛載');
    });

    /** 重新載入 routes/index.js，回傳它掛了哪些路徑與啟動時印的警告 */
    function loadRoutes(env) {
        Object.assign(process.env, { DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/never_used_test' }, env);
        const file = require.resolve('../../routes');
        delete require.cache[file];
        const warns = [];
        const orig = console.warn;
        console.warn = (m) => warns.push(String(m));
        let router;
        try {
            router = require(file);
        } finally {
            console.warn = orig;
        }
        const paths = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
        return { paths, warns };
    }

    test('routes/index.js：FEATURE_VOICE=true＋本機模型 → 不掛 /voice/transcribe、印「本機模式不提供語音」；家教照常掛', () => {
        const { paths, warns } = loadRoutes({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true' });
        assert.ok(paths.includes('POST /tutor'), paths.join('\n'));
        assert.equal(paths.includes('POST /voice/transcribe'), false);
        assert.equal(warns.filter(w => w.startsWith('[voice] 本機模式不提供語音')).length, 1, warns.join('\n'));
    });

    test('routes/index.js：MODEL_VOICE 是 gemini → 照舊掛載、不警告；FEATURE_VOICE 關 → 不掛、也不警告', () => {
        const on = loadRoutes({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true', MODEL_VOICE: 'gemini:gemini-3.5-flash' });
        assert.ok(on.paths.includes('POST /voice/transcribe'));
        assert.equal(on.warns.filter(w => w.startsWith('[voice]')).length, 0);
        delete process.env.MODEL_VOICE;
        const off = loadRoutes({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'false' });
        assert.equal(off.paths.includes('POST /voice/transcribe'), false);
        assert.equal(off.warns.filter(w => w.startsWith('[voice]')).length, 0);
    });

    test('transcribe 直接呼叫（繞過路由）：本機模型 → 502「本機模式不提供語音」，錄音不送進 LLM', async () => {
        let called = 0;
        const llm = { generateJson: async () => { called += 1; return { data: {} }; } };
        const budget = tutor.createBudget();
        await assert.rejects(
            () => voice.transcribe({ file: { buffer: Buffer.from('abc'), mimetype: 'audio/webm' } }, { llm, budget }),
            (err) => {
                assert.equal(err.status, 502);
                assert.match(err.message, /本機模式不提供語音/);
                return true;
            }
        );
        assert.equal(called, 0);
    });
});

// ───────────────────────── 家教（第 3 條第 10 點）─────────────────────────

describe('家教：沒有 code execution 時不宣稱「已用程式驗算」', () => {
    const noStudentsDb = { listStudents: async () => [] };
    const input = (mode) => ({ message: '解 x^2-5x+6=0', mode, subject: null, studentId: null, questionId: null, history: [] });
    const fakeLlm = (res) => {
        const calls = [];
        return { calls, generateText: async (opts) => { calls.push(opts); return { usage: { tokenIn: 100, tokenOut: 50 }, ...res }; } };
    };

    test('本機模型：用本機版系統提示與模板（tutor.*.local.v1）、tools.codeExecution=false', async () => {
        for (const mode of ['direct', 'socratic']) {
            const { llmOpts, codeExecution, modelId } = await tutor.prepareTutorRequest(input(mode), { db: noStudentsDb });
            assert.equal(codeExecution, false);
            assert.equal(modelId, 'qwen3:8b');
            assert.equal(llmOpts.model, 'ollama:qwen3:8b');
            assert.equal(llmOpts.system, tutor.SYSTEM_LOCAL[mode]);
            assert.equal(llmOpts.template, `tutor.${mode}.local.v1`);
            assert.equal(templates.getTemplate(llmOpts.template), `${tutor.SYSTEM_LOCAL[mode]}\n---\n${tutor.PROMPT_TEMPLATE}`);
            assert.deepEqual(llmOpts.tools, { codeExecution: false });
        }
    });

    test('本機版系統提示：拿掉「必須用 code execution／Python 驗算」，明令不得宣稱執行過程式；其餘段落與 Gemini 版逐字相同', () => {
        for (const mode of ['direct', 'socratic']) {
            const local = tutor.SYSTEM_LOCAL[mode];
            assert.equal(local.includes('code execution'), false, mode);
            assert.equal(local.includes('以 sympy 解得'), false, mode);
            assert.match(local, /不得聲稱執行過程式、用過 Python 或 sympy、或「已用程式驗算」/);
            assert.match(local, /回覆的最後一段以「\*\*驗算\*\*：」開頭/, '最後一段的名稱不變（截斷提醒沿用）');
            // 【計算驗證】之前（講法）與【安全】之後的內容和 Gemini 版逐字相同
            const g = tutor.SYSTEM[mode];
            assert.equal(local.slice(0, local.indexOf('【計算檢查】')), g.slice(0, g.indexOf('【計算驗證】')));
            assert.equal(local.slice(local.indexOf('【安全】'), local.indexOf('【模式：')), g.slice(g.indexOf('【安全】'), g.indexOf('【模式：')));
        }
        assert.match(tutor.SYSTEM_LOCAL.socratic, /先自己重算一次、確認對不對再回應/);
    });

    test('Gemini 模型：系統提示、模板、tools 與之前相同', async () => {
        process.env.MODEL_TUTOR = 'gemini:gemini-3.1-pro-preview';
        const { llmOpts, codeExecution } = await tutor.prepareTutorRequest(input('direct'), { db: noStudentsDb });
        assert.equal(codeExecution, true);
        assert.equal(llmOpts.system, tutor.SYSTEM.direct);
        assert.equal(llmOpts.template, 'tutor.direct.v1');
        assert.deepEqual(llmOpts.tools, { codeExecution: true });
    });

    test('本機回覆宣稱「以 sympy／用程式驗算」而 codeRuns 為空 → 回覆後附更正；verification.used=false；費用 0', async () => {
        const llm = fakeLlm({ text: '因式分解得 x=2 或 x=3。\n\n**驗算**：以 sympy 解得 x = 2, 3，與推導一致。', codeRuns: [], finishReason: 'STOP' });
        const out = await tutor.runTutor({ message: '解 x^2-5x+6=0', mode: 'direct' }, { llm, db: noStudentsDb, budget: tutor.createBudget() });
        assert.ok(out.reply.endsWith(`\n\n${tutor.UNVERIFIED_CLAIM_NOTE}`), out.reply);
        assert.deepEqual(out.verification, { used: false, runs: [] });
        assert.equal(out.usage.costUsd, 0);
        assert.equal(llm.calls[0].tools.codeExecution, false);
    });

    test('本機回覆只寫手算檢查（沒宣稱跑程式）→ 不附更正；截斷時照舊附截斷提醒', async () => {
        const plain = fakeLlm({ text: '因式分解得 x=2 或 x=3。\n\n**驗算**：把 x=2 代回，4-10+6=0。', codeRuns: [] });
        const a = await tutor.runTutor({ message: 'q', mode: 'direct' }, { llm: plain, db: noStudentsDb, budget: tutor.createBudget() });
        assert.equal(a.reply, '因式分解得 x=2 或 x=3。\n\n**驗算**：把 x=2 代回，4-10+6=0。');
        const cut = fakeLlm({ text: '先列式', codeRuns: [], finishReason: 'MAX_TOKENS' });
        const b = await tutor.runTutor({ message: 'q', mode: 'direct' }, { llm: cut, db: noStudentsDb, budget: tutor.createBudget() });
        assert.ok(b.reply.endsWith(tutor.TRUNCATED_NOTE), b.reply);
    });

    test('Gemini 的回覆處理不變：同一段宣稱不附更正（有 code execution 的路徑一個字都沒改）', async () => {
        process.env.MODEL_TUTOR = 'gemini:gemini-3.1-pro-preview';
        const text = '**驗算**：以 sympy 解得 x = 3。';
        const llm = fakeLlm({ text, codeRuns: [] });
        const out = await tutor.runTutor({ message: 'q', mode: 'direct' }, { llm, db: noStudentsDb, budget: tutor.createBudget() });
        assert.equal(out.reply, text);
    });

    test('claimsProgramRun：抓得到常見說法，手算檢查不算', () => {
        for (const s of ['以 sympy 解得', '用 Python 算得 11', '已用程式驗算', '經程式驗證無誤', '透過程式計算', '執行程式碼後得到', 'code execution 的結果']) {
            assert.equal(tutor.claimsProgramRun(s), true, s);
        }
        for (const s of ['**驗算**：把 x=3 代回原式', '**驗算**：本題不涉及數值計算', '反向運算檢查：3×4=12', '']) {
            assert.equal(tutor.claimsProgramRun(s), false, s);
        }
    });
});

// ───────────────────────── services/llm.capabilitiesOf ─────────────────────────

describe('services/llm.capabilitiesOf', () => {
    test('gemini：code execution／音訊／PDF 都有；ollama：都沒有；裸 ID 視為 gemini', () => {
        const { capabilitiesOf } = require('../../services/llm');
        assert.deepEqual(capabilitiesOf('gemini:gemini-3.5-flash'), { vendor: 'gemini', codeExecution: true, audioInput: true, pdfInput: true });
        assert.deepEqual(capabilitiesOf('ollama:qwen3:8b'), { vendor: 'ollama', codeExecution: false, audioInput: false, pdfInput: false });
        assert.equal(capabilitiesOf('gemini-3.7-flash').vendor, 'gemini');
        assert.equal(path.basename(require.resolve('../../services/llm/ollama')), 'ollama.js');
    });
});
