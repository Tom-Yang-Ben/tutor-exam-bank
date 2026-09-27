// ─────────────────────────────────────────────────────────────
// test/unit/localTuning.test.js — 本機模式的可選加速設定（services/llm/localTuning.js；docs/local-mode.md 第 10.14 條）
//
// 驗證：
//   1. 什麼都沒寫：送給 Ollama 的參數與加這個功能之前逐位元相同（think、num_ctx、num_predict、沒有 num_thread）；
//   2. OLLAMA_NO_THINK：只關掉列出的 agent（基本名稱連化學版一起；all／*）；本來就不思考的不受影響；
//   3. OLLAMA_MAX_OUTPUT_<AGENT>：只降不升；OLLAMA_NUM_CTX_<AGENT>：蓋過全域的 OLLAMA_NUM_CTX；
//   4. Gemini 路徑一個字都不讀（thinkingConfig 照舊）；replay 不讀；
//   5. cassette 的鍵不含這三個設定：repo 裡本機錄的 verify cassette，思考開關、輸出上限怎麼改都照樣回放；
//      record 有套用才在 request.ollamaOverrides 記下來，沒套用就沒有這個欄位；
//   6. THINKING_AGENTS 與各模組匯出的常數一致，而且原始碼裡傳 thinkingBudget 的地方都列到了；
//   7. eval 重錄的子行程：回放時擋掉、錄製時放行（eval/lib/suiteProcess.js）。
// 〔Owner 第五輪 C-b、C-c 核准，dec/r6-local-tuning〕第 1 點改成：什麼都沒寫＝本機預設（kc_tag 不思考、verify／verify_chem
// 上限 3072），其他 agent 與加這個功能之前逐位元相同；OLLAMA_NO_THINK=none＋OLLAMA_MAX_OUTPUT_VERIFY=8192（NO_DEFAULTS）
// 取消預設後，全部 agent 與之前逐位元相同。原本測「明寫的設定」的幾則改在 NO_DEFAULTS 上疊加，斷言本身不變。
// 不連 Ollama、不連 Gemini（假的傳輸與假的 client）。
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
const sp = require('../../eval/lib/suiteProcess');
const { buildSchema } = require('../../agents/schemas');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENV_KEYS = [
    'LLM_MODE', 'EVAL_CASSETTE_DIR', 'OLLAMA_HOST', 'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_PROGRESS_MS', 'OLLAMA_NO_THINK',
    'OLLAMA_MAX_OUTPUT_VERIFY', 'OLLAMA_MAX_OUTPUT_LINT', 'OLLAMA_NUM_CTX_VERIFY', 'OLLAMA_NUM_CTX_EXTRACT_OCR', 'OLLAMA_NUM_CTX_TUTOR',
    'GEMINI_API_KEY'
];
const saved = {};
let tmp;

before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '本機調整-'));
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

function fakeOllama(content = '{"final_answer":"(A)","answer_form":"option","steps_summary":"s"}') {
    const calls = [];
    ollama._setTransportForTest(async (url, payload) => {
        calls.push(JSON.parse(JSON.stringify(payload)));
        return {
            status: 200,
            text: JSON.stringify({
                model: payload.model, done: true, done_reason: 'stop',
                message: { role: 'assistant', content }, prompt_eval_count: 300, eval_count: 500
            })
        };
    });
    return calls;
}

/** 〔C-b、C-c〕取消兩個本機預設的寫法（與 .env.example 說明的一致） */
const NO_DEFAULTS = Object.freeze({ OLLAMA_NO_THINK: 'none', OLLAMA_MAX_OUTPUT_VERIFY: '8192' });

const VERIFY_CALL = Object.freeze({
    model: 'ollama:qwen3:8b', system: '你是解題老師。', parts: [{ text: '請解 1+1' }], schema: buildSchema('verify'),
    maxOutputTokens: 8192, thinkingBudget: 1024, agent: 'verify', template: 'verify.v1',
    cacheKeyParts: { template: 'verify.v1', questionText: '1+1', questionType: '計算', sampleNo: 1 }
});

// ───────────────────────── 純函式 ─────────────────────────

describe('resolveOllamaOverrides', () => {
    test('〔C-b、C-c〕什麼都沒寫：kc_tag 不思考、verify／verify_chem 上限 3072（本機預設）；其他 agent 的 applied 是空的，數字原樣', () => {
        for (const agent of ['lint', 'lint_chem', 'tutor', 'classify', 'extract_ocr', undefined]) {
            const r = tuning.resolveOllamaOverrides({ agent, thinkingBudget: 1024, maxOutputTokens: 8192 }, {});
            assert.deepEqual(r, { thinkingBudget: 1024, maxOutputTokens: 8192, numCtx: undefined, applied: {}, sources: {} }, String(agent));
        }
        for (const agent of ['verify', 'verify_chem', 'VERIFY']) {
            const r = tuning.resolveOllamaOverrides({ agent, thinkingBudget: 1024, maxOutputTokens: 8192 }, {});
            assert.deepEqual(r, { thinkingBudget: 1024, maxOutputTokens: 3072, numCtx: undefined, applied: { numPredict: 3072 }, sources: { numPredict: 'default' } }, agent);
        }
        const kc = tuning.resolveOllamaOverrides({ agent: 'kc_tag', thinkingBudget: 512, maxOutputTokens: 4096 }, {});
        assert.deepEqual(kc, { thinkingBudget: 0, maxOutputTokens: 4096, numCtx: undefined, applied: { think: false }, sources: { think: 'default' } });
        const none = tuning.resolveOllamaOverrides({ agent: 'classify' }, {});
        assert.deepEqual(none, { thinkingBudget: undefined, maxOutputTokens: undefined, numCtx: undefined, applied: {}, sources: {} });
        // 空字串、只有空白＝沒寫＝本機預設（與 eval 回放時把這些變數擋成空字串一致）
        for (const blank of ['', '  ']) {
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'kc_tag', thinkingBudget: 512 }, { OLLAMA_NO_THINK: blank }).applied, { think: false }, `「${blank}」`);
        }
    });

    test('〔C-b、C-c〕取消本機預設（OLLAMA_NO_THINK=none、OLLAMA_MAX_OUTPUT_VERIFY=8192）：每個 agent 與加這個功能之前逐位元相同', () => {
        for (const agent of ['verify', 'verify_chem', 'lint', 'kc_tag', 'classify', 'extract_ocr', undefined]) {
            const r = tuning.resolveOllamaOverrides({ agent, thinkingBudget: 1024, maxOutputTokens: 8192 }, NO_DEFAULTS);
            assert.deepEqual(r, { thinkingBudget: 1024, maxOutputTokens: 8192, numCtx: undefined, applied: {}, sources: {} }, String(agent));
        }
        // none 不分大小寫；只寫 _CHEM 時數學／物理版仍是預設
        assert.equal(tuning.noThinkFor('kc_tag', { OLLAMA_NO_THINK: 'NONE' }), false);
        const chemOnly = { OLLAMA_MAX_OUTPUT_VERIFY_CHEM: '8192' };
        assert.equal(tuning.resolveOllamaOverrides({ agent: 'verify_chem', maxOutputTokens: 8192 }, chemOnly).maxOutputTokens, 8192);
        assert.equal(tuning.resolveOllamaOverrides({ agent: 'verify', maxOutputTokens: 8192 }, chemOnly).maxOutputTokens, 3072);
    });

    test('〔C-b〕OLLAMA_NO_THINK 有寫就整個取代預設：只寫 lint → kc_tag 恢復思考；lint,kc_tag → 兩個都關；sources 標 env', () => {
        const lintOnly = tuning.resolveOllamaOverrides({ agent: 'kc_tag', thinkingBudget: 512 }, { OLLAMA_NO_THINK: 'lint' });
        assert.deepEqual([lintOnly.thinkingBudget, lintOnly.applied], [512, {}]);
        for (const a of ['lint', 'kc_tag']) {
            const r = tuning.resolveOllamaOverrides({ agent: a, thinkingBudget: 512 }, { OLLAMA_NO_THINK: 'lint,kc_tag' });
            assert.deepEqual([r.thinkingBudget, r.applied, r.sources], [0, { think: false }, { think: 'env' }], a);
        }
        assert.deepEqual(tuning.noThinkSpec({}), { all: false, names: new Set(['kc_tag']), source: 'default' });
        assert.deepEqual(tuning.noThinkSpec({ OLLAMA_NO_THINK: 'none' }), { all: false, names: new Set(), source: 'env' });
    });

    test('〔C-c〕驗算的上限：只降不升照舊（寫更小的值照寫的、agent 本身更小時不動）；亂填＝沒寫＝本機預設', () => {
        const r = (env, maxOutputTokens = 8192) => tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024, maxOutputTokens }, env);
        assert.deepEqual([r({ OLLAMA_MAX_OUTPUT_VERIFY: '2048' }).maxOutputTokens, r({ OLLAMA_MAX_OUTPUT_VERIFY: '2048' }).sources], [2048, { numPredict: 'env' }]);
        assert.deepEqual([r({ OLLAMA_MAX_OUTPUT_VERIFY: '4096' }).maxOutputTokens, r({ OLLAMA_MAX_OUTPUT_VERIFY: '4096' }).sources], [4096, { numPredict: 'env' }], '寫比預設大、比原本小的值：照寫的');
        assert.deepEqual([r({}, 2048).maxOutputTokens, r({}, 2048).applied], [2048, {}], '不會調高');
        for (const bad of ['abc', '0', '-5', '3.5', '', ' ']) {
            assert.deepEqual(r({ OLLAMA_MAX_OUTPUT_VERIFY: bad }).applied, { numPredict: 3072 }, `「${bad}」`);
        }
        assert.equal(tuning.defaultMaxOutputFor('verify_chem'), 3072);
        assert.equal(tuning.defaultMaxOutputFor('lint'), null);
        assert.equal(tuning.defaultMaxOutputFor(undefined), null);
        assert.deepEqual(JSON.parse(JSON.stringify(tuning.LOCAL_DEFAULTS)), { noThink: ['kc_tag'], maxOutput: { verify: 3072 } });
    });

    test('OLLAMA_NO_THINK：列出的才關；基本名稱連化學版一起；不分大小寫；全形逗號、頓號、空白都能分隔', () => {
        const env = { ...NO_DEFAULTS, OLLAMA_NO_THINK: ' Lint，kc_tag、 tutor ' };
        // 〔C-c〕verify 帶正式流程的上限 8192：NO_DEFAULTS 的 8192 不降，applied 只看思考
        const off = (agent) => tuning.resolveOllamaOverrides({ agent, thinkingBudget: 512, maxOutputTokens: 8192 }, env);
        for (const a of ['lint', 'lint_chem', 'LINT', 'kc_tag', 'tutor']) {
            assert.deepEqual([off(a).thinkingBudget, off(a).applied], [0, { think: false }], a);
        }
        for (const a of ['verify', 'verify_chem', 'voice']) {
            assert.deepEqual([off(a).thinkingBudget, off(a).applied], [512, {}], a);
        }
        // 只寫化學版：數學／物理版不受影響
        const chemOnly = { OLLAMA_NO_THINK: 'verify_chem' };
        assert.equal(tuning.resolveOllamaOverrides({ agent: 'verify_chem', thinkingBudget: 1024 }, chemOnly).thinkingBudget, 0);
        assert.equal(tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024 }, chemOnly).thinkingBudget, 1024);
    });

    test('OLLAMA_NO_THINK=all／*：每個會思考的都關；本來就不思考的（budget 0 或沒給）不記 applied', () => {
        for (const w of ['all', '*', 'ALL']) {
            const env = { ...NO_DEFAULTS, OLLAMA_NO_THINK: w };
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024, maxOutputTokens: 8192 }, env).applied, { think: false });
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: undefined, thinkingBudget: 1024 }, env).applied, { think: false }, '沒給 agent 也關');
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'classify' }, env).applied, {});
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'classify', thinkingBudget: 0 }, env).applied, {});
        }
        assert.equal(tuning.noThinkFor('verify', { OLLAMA_NO_THINK: '' }), false);
        assert.equal(tuning.noThinkFor('kc_tag', { OLLAMA_NO_THINK: '' }), true, '〔C-b〕空字串＝沒寫＝本機預設');
        assert.equal(tuning.noThinkFor('', { OLLAMA_NO_THINK: 'verify' }), false);
    });

    test('OLLAMA_MAX_OUTPUT_<AGENT>：只降不升；化學版吃基本名稱、也可以另寫 _CHEM；沒給上限的 agent 就設成這個值；亂填＝沒寫', () => {
        const env = { OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_MAX_OUTPUT_LINT_CHEM: '2048', OLLAMA_MAX_OUTPUT_LINT: '4096', OLLAMA_MAX_OUTPUT_CLASSIFY: '256' };
        const r = (agent, maxOutputTokens) => tuning.resolveOllamaOverrides({ agent, thinkingBudget: 1024, maxOutputTokens }, env);
        assert.deepEqual([r('verify', 8192).maxOutputTokens, r('verify', 8192).applied], [3072, { numPredict: 3072 }]);
        assert.deepEqual([r('verify_chem', 8192).maxOutputTokens, r('verify_chem', 8192).applied], [3072, { numPredict: 3072 }]);
        assert.deepEqual([r('verify', 2048).maxOutputTokens, r('verify', 2048).applied], [2048, {}], '不會調高');
        assert.equal(r('lint_chem', 8192).maxOutputTokens, 2048, '_CHEM 的值優先於基本名稱');
        assert.equal(r('lint', 8192).maxOutputTokens, 4096);
        assert.deepEqual([r('classify', undefined).maxOutputTokens, r('classify', undefined).applied], [256, { numPredict: 256 }]);
        for (const bad of ['abc', '0', '-5', '3.5', '', ' ']) {
            assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'lint', maxOutputTokens: 8192 }, { OLLAMA_MAX_OUTPUT_LINT: bad }).applied, {}, `「${bad}」`);
        }
    });

    test('OLLAMA_NUM_CTX_<AGENT>：這個 agent 的 num_ctx；化學版吃基本名稱；沒寫就 undefined（adapter 照 OLLAMA_NUM_CTX）', () => {
        const env = { OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384', OLLAMA_NUM_CTX_EXTRACT_VISION: '16384' };
        for (const a of ['extract_ocr', 'extract_ocr_chem', 'extract_vision', 'extract_vision_chem']) {
            const r = tuning.resolveOllamaOverrides({ agent: a, maxOutputTokens: 8192 }, env);
            assert.deepEqual([r.numCtx, r.applied], [16384, { numCtx: 16384 }], a);
        }
        const v = tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024, maxOutputTokens: 8192 }, { ...NO_DEFAULTS, ...env });
        assert.deepEqual([v.numCtx, v.applied], [undefined, {}]);
    });

    test('三個一起：applied 全記下', () => {
        const env = { OLLAMA_NO_THINK: 'verify', OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_NUM_CTX_VERIFY: '8192' };
        const r = tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024, maxOutputTokens: 8192 }, env);
        assert.deepEqual(r, {
            thinkingBudget: 0, maxOutputTokens: 3072, numCtx: 8192, applied: { think: false, numPredict: 3072, numCtx: 8192 },
            sources: { think: 'env', numPredict: 'env', numCtx: 'env' }
        });
    });

    test('agentEnvSuffix／baseAgent／describeOverrides', () => {
        assert.equal(tuning.agentEnvSuffix('kc_tag'), 'KC_TAG');
        assert.equal(tuning.agentEnvSuffix('extract_ocr_chem'), 'EXTRACT_OCR_CHEM');
        assert.equal(tuning.agentEnvSuffix('a-b.c'), 'A_B_C');
        assert.equal(tuning.baseAgent('lint_chem'), 'lint');
        assert.equal(tuning.baseAgent('_chem'), '_chem');
        assert.equal(tuning.baseAgent('classify'), 'classify');
        assert.deepEqual(tuning.describeOverrides({ OLLAMA_NO_THINK: 'lint,all', OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_MAX_OUTPUT_X: 'no', OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384' }), {
            noThink: { all: true, names: ['lint'] }, maxOutput: { OLLAMA_MAX_OUTPUT_VERIFY: 3072 }, numCtx: { OLLAMA_NUM_CTX_EXTRACT_OCR: 16384 }
        });
        for (const k of ['OLLAMA_NO_THINK', 'OLLAMA_MAX_OUTPUT_VERIFY', 'OLLAMA_NUM_CTX_EXTRACT_OCR_CHEM']) assert.ok(tuning.OVERRIDE_ENV_PATTERN.test(k), k);
        for (const k of ['OLLAMA_NUM_CTX', 'OLLAMA_MAX_OUTPUT_', 'OLLAMA_HOST', 'OLLAMA_NO_THINKING']) assert.ok(!tuning.OVERRIDE_ENV_PATTERN.test(k), k);
    });
});

describe('THINKING_AGENTS 與程式一致', () => {
    test('數字與各模組匯出的常數相同；化學版的 agent 名稱與模組的 AGENT_CHEM 相同', () => {
        const verify = require('../../agents/verify');
        const lint = require('../../agents/lint');
        const tagKc = require('../../agents/tagKc');
        const tutor = require('../../services/tutorService');
        const voice = require('../../services/voiceService');
        const T = tuning.THINKING_AGENTS;
        assert.deepEqual({ ...T.verify }, { thinkingBudget: verify.THINKING_BUDGET, maxOutputTokens: verify.MAX_OUTPUT_TOKENS });
        assert.deepEqual({ ...T[verify.AGENT_CHEM] }, { ...T.verify });
        assert.deepEqual({ ...T.lint }, { thinkingBudget: lint.THINKING_BUDGET, maxOutputTokens: lint.MAX_OUTPUT_TOKENS });
        assert.deepEqual({ ...T[lint.AGENT_CHEM] }, { ...T.lint });
        assert.deepEqual({ ...T[tagKc.AGENT] }, { thinkingBudget: tagKc.THINKING_BUDGET, maxOutputTokens: tagKc.MAX_OUTPUT_TOKENS });
        assert.deepEqual({ ...T.tutor }, { thinkingBudget: tutor.THINKING_BUDGET, maxOutputTokens: tutor.MAX_OUTPUT_TOKENS });
        assert.deepEqual({ ...T.voice }, { thinkingBudget: voice.THINKING_BUDGET, maxOutputTokens: voice.MAX_OUTPUT_TOKENS });
        assert.deepEqual([verify.AGENT_CHEM, lint.AGENT_CHEM, tagKc.AGENT], ['verify_chem', 'lint_chem', 'kc_tag']);
    });

    test('原始碼裡傳 thinkingBudget 給模型的只有這五支（新增的話要補進 THINKING_AGENTS）', () => {
        const files = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) { if (name !== 'llm' && name !== 'schemas') walk(p); continue; }
                if (!name.endsWith('.js')) continue;
                if (/thinkingBudget:\s*[A-Z_a-z0-9]/.test(fs.readFileSync(p, 'utf8'))) files.push(path.relative(APP_DIR, p).split(path.sep).join('/'));
            }
        };
        walk(path.join(APP_DIR, 'agents'));
        walk(path.join(APP_DIR, 'services'));
        assert.deepEqual(files.sort(), ['agents/lint.js', 'agents/tagKc.js', 'agents/verify.js', 'services/tutorService.js', 'services/voiceService.js']);
    });
});

// ───────────────────────── 〔審查修正〕啟動時印出生效的本機調整、名稱寫錯時警告 ─────────────────────────

describe('checkOverrides／announceOverrides', () => {
    const DEFAULT_LINES = [
        '不思考：kc_tag（本機預設，Owner 第五輪 C-b；OLLAMA_NO_THINK 有寫就整個取代）',
        '輸出上限：verify、verify_chem 3072（本機預設，Owner 第五輪 C-c；OLLAMA_MAX_OUTPUT_VERIFY 可覆寫）'
    ];

    test('什麼都沒寫：沒有生效的、沒有警告；〔C-b、C-c〕本機預設另列在 defaults', () => {
        assert.deepEqual(tuning.checkOverrides({}), { active: [], warnings: [], defaults: DEFAULT_LINES });
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_NO_THINK: '  ', OLLAMA_NUM_CTX: '8192', OLLAMA_MAX_OUTPUT_VERIFY: '' }), { active: [], warnings: [], defaults: DEFAULT_LINES },
            '空字串＝沒寫；全域的 OLLAMA_NUM_CTX 不是本分支的設定');
    });

    test('〔C-b、C-c〕取消預設列在生效的裡面、不警告；只寫 _CHEM 時數學／物理版仍列在預設', () => {
        assert.deepEqual(tuning.checkOverrides(NO_DEFAULTS), {
            active: ['不思考：無（OLLAMA_NO_THINK=none，取消本機預設 kc_tag）', '輸出上限：OLLAMA_MAX_OUTPUT_VERIFY=8192（不降：取消本機預設 3072）'],
            warnings: [], defaults: []
        });
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_NO_THINK: 'lint', OLLAMA_MAX_OUTPUT_VERIFY_CHEM: '2048' }), {
            active: ['不思考：lint（寫基本名稱的連化學版一起）', '輸出上限：OLLAMA_MAX_OUTPUT_VERIFY_CHEM=2048'],
            warnings: [], defaults: ['輸出上限：verify 3072（本機預設，Owner 第五輪 C-c；OLLAMA_MAX_OUTPUT_VERIFY 可覆寫）']
        });
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_MAX_OUTPUT_VERIFY: 'abc' }).defaults, DEFAULT_LINES, '亂填＝沒寫：仍用預設（另有警告）');
    });

    test('生效的列成一段；寫錯的 agent（verfy）、本來就不思考的（classify）、後綴拼錯、值不是正整數、輸出上限沒有比較小，各一行警告', () => {
        const { active, warnings, defaults } = tuning.checkOverrides({
            OLLAMA_NO_THINK: 'verfy, classify，lint、kc_tag',
            OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_MAX_OUTPUT_LINT: '9000', OLLAMA_MAX_OUTPUT_VARIANT: '2048',
            OLLAMA_NUM_CTX_EXTRCT_OCR: '16384', OLLAMA_NUM_CTX_EXTRACT_OCR: 'abc', OLLAMA_NUM_CTX_EXTRACT_VISION_CHEM: '16384'
        });
        assert.deepEqual(active, [
            '不思考：kc_tag、lint（寫基本名稱的連化學版一起）',
            '輸出上限：OLLAMA_MAX_OUTPUT_VARIANT=2048、OLLAMA_MAX_OUTPUT_VERIFY=3072',
            'num_ctx：OLLAMA_NUM_CTX_EXTRACT_VISION_CHEM=16384'
        ]);
        assert.equal(warnings.length, 5, warnings.join('\n'));
        assert.deepEqual(defaults, [], '兩個預設都被明寫的取代');
        assert.match(warnings.find(w => w.includes('verfy')), /不是認得的 agent（寫錯了？這個名字會被忽略）.*會思考的 agent：verify、lint、kc_tag、tutor、voice/);
        assert.match(warnings.find(w => w.includes('classify')), /本來就不思考，寫了沒有作用/);
        assert.match(warnings.find(w => w.includes('OLLAMA_MAX_OUTPUT_LINT')), /9000 不比 lint 原本的輸出上限 8192 小（只降不升），沒有作用/);
        assert.match(warnings.find(w => w.includes('EXTRCT_OCR')), /「EXTRCT_OCR」不是認得的 agent/);
        assert.match(warnings.find(w => w.includes('=abc')), /OLLAMA_NUM_CTX_EXTRACT_OCR=abc 不是正整數，被忽略/);
        // 警告的名稱真的被忽略（與 resolveOllamaOverrides 一致）
        assert.deepEqual(tuning.resolveOllamaOverrides({ agent: 'verify', thinkingBudget: 1024, maxOutputTokens: 8192 }, { ...NO_DEFAULTS, OLLAMA_NO_THINK: 'verfy' }).applied, {});
    });

    test('all／*：全部會思考的；化學版寫全名也認得', () => {
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_NO_THINK: 'all' }).active, ['不思考：全部會思考的 agent（verify、lint、kc_tag、tutor、voice）']);
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_NO_THINK: 'verify_chem' }), { active: ['不思考：verify_chem（寫基本名稱的連化學版一起）'], warnings: [], defaults: [DEFAULT_LINES[1]] });
        assert.deepEqual(tuning.checkOverrides({ OLLAMA_NUM_CTX_CLASSIFY_CHEM: '8192' }).warnings, []);
    });

    test('announceOverrides：live／record 才印、同一行程只印一次；replay 或什麼都沒寫（文字模型是 Gemini）不印', () => {
        // 〔C-b、C-c〕文字模型是 Gemini：本機預設不印（這一則測明寫的設定；本機預設的印法見下一則）
        const GEM = { MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview' };
        const logs = [];
        const warns = [];
        const out = { log: (s) => logs.push(s), warn: (s) => warns.push(s) };
        tuning._resetAnnounceForTest();
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'replay', OLLAMA_NO_THINK: 'verify' }, out), false, 'replay 不套用，不印');
        assert.equal(tuning.announceOverrides({ OLLAMA_NO_THINK: 'verify' }, out), false, '沒設 LLM_MODE＝replay');
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'live', ...GEM }, out), false, '什麼都沒寫');
        assert.deepEqual([logs, warns], [[], []]);
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'LIVE', OLLAMA_NO_THINK: 'verify,verfy', ...GEM }, out), true);
        assert.deepEqual(logs, ['[ollama] 本機調整（docs/local-mode.md 第 10.14 條；只在模型是 ollama:… 時套用）：不思考：verify（寫基本名稱的連化學版一起）']);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /^\[ollama\] ⚠ OLLAMA_NO_THINK 裡的「verfy」/);
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'record', OLLAMA_NO_THINK: 'lint' }, out), false, '同一行程只印一次');
        tuning._resetAnnounceForTest();
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'record', OLLAMA_NUM_CTX_VERFY: '8192', ...GEM }, out), true, '只有警告也印');
        assert.equal(logs.length, 1);
        assert.match(warns[1], /OLLAMA_NUM_CTX_VERFY/);
        tuning._resetAnnounceForTest();
    });

    test('〔C-b、C-c〕文字模型是 ollama（含沒寫 MODEL_VERIFY 的預設）：什麼都沒寫也印一行本機預設；replay 不印', () => {
        const logs = [];
        const out = { log: (s) => logs.push(s), warn: () => assert.fail('不該警告') };
        tuning._resetAnnounceForTest();
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'replay' }, out), false);
        assert.equal(tuning.announceOverrides({ LLM_MODE: 'live' }, out), true);
        assert.deepEqual(logs, [`[ollama] 本機調整（docs/local-mode.md 第 10.14 條；只在模型是 ollama:… 時套用）：${DEFAULT_LINES.join('；')}`]);
        tuning._resetAnnounceForTest();
        assert.equal(tuning.textModelIsLocal({}), true, 'MODEL_VERIFY 沒寫＝ollama:qwen3:8b');
        assert.equal(tuning.textModelIsLocal({ MODEL_VERIFY: 'gemini:x' }), false);
        assert.equal(tuning.textModelIsLocal({ MODEL_VERIFY: 'gemini:x', MODEL_KC_TAG: 'ollama:qwen3:8b' }), true);
        tuning._resetAnnounceForTest();
    });

    test('services/llm 載入時呼叫 announceOverrides（在 OLLAMA_HOST 的檢查之後）', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'services', 'llm', 'index.js'), 'utf8');
        const host = src.indexOf("require('./ollama').warnIfRemoteHost();");
        const ann = src.indexOf("require('./localTuning').announceOverrides();");
        assert.ok(host > 0 && ann > host, '兩個啟動檢查都在、順序固定');
    });

    test('KNOWN_AGENTS：原始碼裡傳給 services/llm 的 agent 名稱都列到了（寫錯的名稱才警告得出來）', () => {
        const names = new Set();
        const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) { if (!['llm', 'schemas'].includes(ent.name)) walk(p); continue; }
                if (!ent.name.endsWith('.js')) continue;
                const src = fs.readFileSync(p, 'utf8');
                for (const m of src.matchAll(/\bagent:\s*'([a-z_]+)'/g)) names.add(m[1]);
                for (const m of src.matchAll(/\bAGENT(?:_[A-Z]+)*\s*=\s*'([a-z_]+)'/g)) names.add(m[1]);
            }
        };
        walk(path.join(APP_DIR, 'agents'));
        walk(path.join(APP_DIR, 'services'));
        names.delete('ocr');   // PaddleOCR（services/ocr）不經 services/llm，沒有這三個設定
        const missing = [...names].filter(n => !tuning.KNOWN_AGENTS.includes(n)).sort();
        assert.deepEqual(missing, [], '新的 agent 名稱要補進 KNOWN_AGENTS');
        for (const a of Object.keys(tuning.THINKING_AGENTS)) assert.ok(tuning.KNOWN_AGENTS.includes(a), a);
        assert.ok(names.has('classify') && names.has('extract_vision') && names.has('kc_tag'), '掃描有效');
    });
});

// ───────────────────────── services/llm 的套用 ─────────────────────────

describe('services/llm：vendor 是 ollama 時套用', () => {
    test('〔C-b、C-c〕什麼都沒寫：verify 送 num_predict 3072（照舊思考）、kc_tag 送 think:false；其他（家教、lint）與之前逐位元相同（沒有 num_thread）', async () => {
        process.env.LLM_MODE = 'live';
        const calls = fakeOllama();
        await llm.generateJson({ ...VERIFY_CALL });
        assert.equal(calls[0].think, true);
        assert.deepEqual(calls[0].options, { temperature: 0, num_ctx: 16384, num_predict: 3072 });
        await llm.generateText({ ...VERIFY_CALL, schema: undefined, agent: 'tutor', thinkingBudget: 2048 });
        assert.equal(calls[1].think, true);
        assert.deepEqual(calls[1].options, { temperature: 0, num_ctx: 16384, num_predict: 8192 });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'kc_tag', thinkingBudget: 512, maxOutputTokens: 4096 });
        assert.equal(calls[2].think, false);
        assert.deepEqual(calls[2].options, { temperature: 0, num_ctx: 16384, num_predict: 4096 });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'lint' });
        assert.equal(calls[3].think, true);
        assert.deepEqual(calls[3].options, { temperature: 0, num_ctx: 16384, num_predict: 8192 });
    });

    test('〔C-b、C-c〕取消本機預設（OLLAMA_NO_THINK=none、OLLAMA_MAX_OUTPUT_VERIFY=8192）：送出的 think、options 與之前逐位元相同', async () => {
        process.env.LLM_MODE = 'live';
        Object.assign(process.env, NO_DEFAULTS);
        const calls = fakeOllama();
        await llm.generateJson({ ...VERIFY_CALL });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'kc_tag', thinkingBudget: 512, maxOutputTokens: 4096 });
        assert.deepEqual(calls.map(c => [c.think, c.options]), [
            [true, { temperature: 0, num_ctx: 16384, num_predict: 8192 }],
            [true, { temperature: 0, num_ctx: 16384, num_predict: 4096 }]
        ]);
    });

    test('OLLAMA_NO_THINK=verify：verify 送 think:false，lint 照樣思考；generateText（家教）同一套規則', async () => {
        process.env.LLM_MODE = 'live';
        process.env.OLLAMA_NO_THINK = 'verify,tutor';
        process.env.OLLAMA_MAX_OUTPUT_VERIFY = '8192';   // 〔C-c〕取消驗算的本機預設上限：這一則只看思考
        const calls = fakeOllama();
        await llm.generateJson({ ...VERIFY_CALL });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'verify_chem' });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'lint' });
        await llm.generateText({ ...VERIFY_CALL, schema: undefined, agent: 'tutor', thinkingBudget: 2048 });
        assert.deepEqual(calls.map(c => c.think), [false, false, true, false]);
        for (const c of calls) assert.equal(c.options.num_predict, 8192, '輸出上限不動');
    });

    test('OLLAMA_MAX_OUTPUT_VERIFY／OLLAMA_NUM_CTX_<AGENT>：num_predict 只降不升；每個 agent 的 num_ctx 蓋過全域', async () => {
        process.env.LLM_MODE = 'live';
        process.env.OLLAMA_NUM_CTX = '8192';
        process.env.OLLAMA_NUM_CTX_EXTRACT_OCR = '16384';
        process.env.OLLAMA_MAX_OUTPUT_VERIFY = '3072';
        const calls = fakeOllama('{"questions":[]}');
        await llm.generateJson({ ...VERIFY_CALL });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'extract_ocr', thinkingBudget: undefined });
        await llm.generateJson({ ...VERIFY_CALL, agent: 'classify', thinkingBudget: undefined, maxOutputTokens: undefined });
        assert.deepEqual(calls[0].options, { temperature: 0, num_ctx: 8192, num_predict: 3072 });
        assert.deepEqual(calls[1].options, { temperature: 0, num_ctx: 16384, num_predict: 8192 });
        assert.deepEqual(calls[2].options, { temperature: 0, num_ctx: 8192 });
    });

    test('Gemini 路徑一個字都不讀：OLLAMA_NO_THINK=all 時 thinkingConfig、maxOutputTokens 照舊', async () => {
        process.env.LLM_MODE = 'live';
        process.env.GEMINI_API_KEY = 'test-key';
        process.env.OLLAMA_NO_THINK = 'all';
        process.env.OLLAMA_MAX_OUTPUT_VERIFY = '100';
        const seen = [];
        gemini._setClientForTest({
            models: {
                generateContent: async (req) => {
                    seen.push(req.config);
                    return { text: '{"final_answer":"1","answer_form":"number","steps_summary":"s"}', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
                }
            }
        });
        const calls = fakeOllama();
        await llm.generateJson({ ...VERIFY_CALL, model: 'gemini:gemini-3.1-pro-preview' });
        assert.deepEqual(seen[0].thinkingConfig, { thinkingBudget: 1024 });
        assert.equal(seen[0].maxOutputTokens, 8192);
        assert.equal(calls.length, 0);
    });

    test('replay 不讀這些設定：repo 裡本機錄的 verify cassette，思考與輸出上限怎麼改都照樣回放（鍵不含它們）', async () => {
        delete process.env.EVAL_CASSETTE_DIR;   // 讀 repo 的 eval/cassettes
        process.env.LLM_MODE = 'replay';
        const dir = path.join(APP_DIR, 'eval', 'cassettes', 'verify');
        const doc = fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
            .find(d => d.meta.model === 'qwen3:8b' && d.meta.template === 'verify.v1');
        if (!doc) return;   // 本機 cassette 被清掉時不適用
        const base = { model: 'ollama:qwen3:8b', system: 'x', parts: [{ text: 'x' }], schema: buildSchema('verify'), agent: 'verify', template: 'verify.v1', cacheKeyParts: doc.request.cacheKeyParts };
        const calls = fakeOllama();
        for (const [env, extra] of [
            [{}, { thinkingBudget: 1024, maxOutputTokens: 8192 }],
            [{ OLLAMA_NO_THINK: 'all', OLLAMA_MAX_OUTPUT_VERIFY: '100', OLLAMA_NUM_CTX_VERIFY: '4096' }, { thinkingBudget: 0, maxOutputTokens: 1 }]
        ]) {
            Object.assign(process.env, env);
            const res = await llm.generateJson({ ...base, ...extra });
            assert.deepEqual(res.data, doc.response.data);
            assert.equal(res.replayed, true);
        }
        assert.equal(calls.length, 0, 'replay 不呼叫 Ollama');
    });

    test('record：有套用才在 request.ollamaOverrides 記下；沒套用時 request 只有 parts 與 cacheKeyParts；兩種錄出來的鍵相同', async () => {
        process.env.LLM_MODE = 'record';
        fakeOllama();
        const logs = [];
        const origLog = console.log;
        console.log = (m) => logs.push(String(m));
        const key = cassette.cassetteKey({ agent: 'verify', modelId: 'qwen3:8b', template: 'verify.v1', schema: VERIFY_CALL.schema, cacheKeyParts: VERIFY_CALL.cacheKeyParts });
        try {
            Object.assign(process.env, NO_DEFAULTS);   // 〔C-b、C-c〕取消本機預設：什麼都沒套用
            await llm.generateJson({ ...VERIFY_CALL });
            const plain = cassette.readCassette('verify', key);
            assert.deepEqual(Object.keys(plain.request), ['parts', 'cacheKeyParts']);

            // 〔C-c〕本機預設（沒寫 OLLAMA_MAX_OUTPUT_VERIFY）照樣記在 ollamaOverrides；鍵不變
            delete process.env.OLLAMA_MAX_OUTPUT_VERIFY;
            await llm.generateJson({ ...VERIFY_CALL });
            assert.deepEqual(cassette.readCassette('verify', key).request.ollamaOverrides, { numPredict: 3072 });

            process.env.OLLAMA_NO_THINK = 'verify';
            process.env.OLLAMA_MAX_OUTPUT_VERIFY = '3072';
            process.env.OLLAMA_NUM_CTX_VERIFY = '8192';
            await llm.generateJson({ ...VERIFY_CALL });
            const tuned = cassette.readCassette('verify', key);
            assert.ok(tuned, '同一個鍵（覆寫）');
            assert.deepEqual(tuned.request.ollamaOverrides, { think: false, numPredict: 3072, numCtx: 8192 });
            assert.deepEqual(tuned.request.cacheKeyParts, VERIFY_CALL.cacheKeyParts);
            assert.equal(fs.readdirSync(path.join(process.env.EVAL_CASSETTE_DIR, 'verify')).length, 1, '只有一支：鍵沒變');

            await llm.generateText({ ...VERIFY_CALL, schema: undefined, agent: 'tutor_rt', thinkingBudget: 2048 });
            const textKey = cassette.cassetteKey({ agent: 'tutor_rt', modelId: 'qwen3:8b', template: 'verify.v1', schema: undefined, cacheKeyParts: VERIFY_CALL.cacheKeyParts });
            assert.deepEqual(Object.keys(cassette.readCassette('tutor_rt', textKey).request), ['parts', 'tools', 'cacheKeyParts'], 'tutor_rt 沒被列：不記');
        } finally {
            console.log = origLog;
        }
    });
});

describe('ollama adapter：numCtx／numThread 參數', () => {
    test('numCtx 蓋過 OLLAMA_NUM_CTX；numThread 有給才送 num_thread；亂填忽略', async () => {
        process.env.OLLAMA_NUM_CTX = '16384';
        const calls = fakeOllama('{}');
        await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }], numCtx: 8192, numThread: 4 });
        await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }], numCtx: 'abc', numThread: 0 });
        await ollama.generateText({ model: 'qwen3:8b', parts: [{ text: 'x' }], numCtx: 4096, numThread: 3 });
        assert.deepEqual(calls[0].options, { temperature: 0, num_ctx: 8192, num_thread: 4 });
        assert.deepEqual(calls[1].options, { temperature: 0, num_ctx: 16384 });
        assert.deepEqual(calls[2].options, { temperature: 0, num_ctx: 4096, num_thread: 3 });
    });
});

describe('eval 重錄的子行程（eval/lib/suiteProcess.js）', () => {
    const ciLocal = { MODEL_EXTRACT: 'ollama:ci-vl', MODEL_VERIFY: 'ollama:ci-text' };
    const dotenv = { OLLAMA_NO_THINK: 'lint,verify', OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384' };

    test('回放：.env 或 shell 裡的都擋成空字串（CI 與錄完的驗證不受影響）', () => {
        const fromDotenv = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv) });
        const fromShell = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: [] });
        for (const env of [fromDotenv, fromShell]) {
            for (const k of Object.keys(dotenv)) assert.equal(env[k], '', k);
        }
    });

    test('錄製：放行（錄的就是 Owner 平常用的設定；鍵不變，有套用的呼叫在 request.ollamaOverrides 看得到）', () => {
        const rec = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv), llmMode: 'record' });
        for (const [k, v] of Object.entries(dotenv)) assert.equal(rec[k], v, k);
        const embedOnly = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: [], llmMode: 'replay', embedMode: 'record' });
        assert.equal(embedOnly.OLLAMA_NO_THINK, 'lint,verify');
        assert.equal(sp.LOCAL_TUNING_PATTERN, tuning.OVERRIDE_ENV_PATTERN);
    });
});
