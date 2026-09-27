// ─────────────────────────────────────────────────────────────
// test/unit/localBenchText.test.js — 文字模型的本機量測（eval/tools/local_bench_text.js，npm run local:bench-text；
// 〔dec/local-thinking-speed〕docs/local-mode.md 第 10.14 條）
//
// 驗證：
//   1. 參數（--agent 必填；--think／--no-think 只能選一個；範圍）與 package.json 的 script；
//   2. 挑題：lint 挑規則修不好的、verify 挑計算題、classify 第一題、kc_tag 有知識點清單的章；--id 的檢查；
//   3. 模型：與 config/models.js 的 getter 同一套規則（MODEL_TEXT／MODEL_VERIFY／MODEL_KC_TAG）；
//   4. 送出的請求與 agent 本身組的一模一樣（系統提示詞、提示詞、schema、輸出上限、thinkingBudget、agent 名稱）；
//   5. 參數的疊法：agent → .env 的本機調整 → 這次的參數；
//   6. 主流程：先卸載（--warm 不卸）、把 num_ctx／num_thread／think 帶給 adapter、報告；不寫 cassette、不碰資料庫；
//      錯誤（逾時）結束碼 1；真的 adapter（假的傳輸）送出 think:false、num_thread。
//   7. 「字數 → token」的常數與 repo 裡本機回放檔擬合的結果一致（npm run perf:local 第 1.4 段）。
// 不需要 Ollama。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bench = require('../../eval/tools/local_bench_text');
const perf = require('../../eval/tools/local_perf_report');
const ollama = require('../../services/llm/ollama');
const models = require('../../config/models');
const { buildSchema } = require('../../agents/schemas');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG', 'OLLAMA_HOST'];
const saved = {};
let tmp;

before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '文字量測-'));
});
after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    ollama._resetForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const questions = bench.loadFixtureQuestions();
const TIMING = Object.freeze({ totalMs: 305_000, loadMs: 5_000, promptEvalMs: 60_000, evalMs: 240_000 });

function fakes({ generate, env = {} } = {}) {
    const seen = { order: [], generate: [], unload: [], out: '' };
    let t = 0;
    return {
        seen,
        io: {
            env: { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', ...env },
            now: () => { t += 310_000; return t; },
            stdout: { write: (s) => { seen.out += s; } },
            unloadModel: async (o) => { seen.order.push('unload'); seen.unload.push(o); return { done_reason: 'unload' }; },
            generateJson: async (o) => {
                seen.order.push('generate');
                seen.generate.push(o);
                if (generate) return generate(o);
                return {
                    data: { final_answer: '4', answer_form: 'number', steps_summary: '由 $32=2^5$ 得 $x+1=5$。' },
                    usage: { tokenIn: 320, tokenOut: 480, tokenThinking: 0, tokenCached: 0, timing: TIMING },
                    latencyMs: 1, raw: { message: { thinking: 'Let me think. '.repeat(40) } }, schemaFallback: false
                };
            }
        }
    };
}

describe('parseArgs', () => {
    test('--agent 必填；預設：照 .env、先卸載、逾時 60 分、30 秒印一次進度', () => {
        assert.throws(() => bench.parseArgs([]), /--agent/);
        assert.deepEqual(bench.parseArgs(['--agent', 'LINT']), {
            agent: 'lint', id: null, think: null, numCtx: null, maxOutput: null, numThread: null, model: null,
            warm: false, timeoutMin: 60, progressSec: 30, help: false
        });
        assert.equal(bench.parseArgs(['-h']).help, true, '只要說明時不必給 --agent');
    });

    test('各參數與檢查', () => {
        const a = bench.parseArgs(['--agent', 'verify', '--id', '3', '--no-think', '--num-ctx', '8192', '--max-output', '3072', '--num-thread', '4',
            '--model', 'ollama:qwen3:4b', '--warm', '--timeout-min', '30', '--progress-sec', '0']);
        assert.deepEqual([a.id, a.think, a.numCtx, a.maxOutput, a.numThread, a.model, a.warm, a.timeoutMin, a.progressSec],
            [3, false, 8192, 3072, 4, 'ollama:qwen3:4b', true, 30, 0]);
        assert.equal(bench.parseArgs(['--agent', 'classify', '--think']).think, true);
        assert.throws(() => bench.parseArgs(['--agent', 'lint', '--think', '--no-think']), /只能選一個/);
        assert.throws(() => bench.parseArgs(['--agent', 'lint', '--no-think', '--think']), /只能選一個/);
        assert.throws(() => bench.parseArgs(['--agent', 'extract_vision']), /--agent 只能是/);
        assert.throws(() => bench.parseArgs(['--agent', 'lint', '--num-ctx', '1024']), /2048～262144/);
        assert.throws(() => bench.parseArgs(['--agent', 'lint', '--id']), /後面要接一個值/);
        assert.throws(() => bench.parseArgs(['--agent', 'lint', '--fast']), /未知的參數/);
    });

    test('package.json 的 local:bench-text', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['local:bench-text'], 'node eval/tools/local_bench_text.js');
    });
});

describe('挑題與模型', () => {
    test('預設挑題：lint＝第一題規則修不好的；verify＝第一題計算題；classify＝第一題；kc_tag＝第一題有知識點清單的章', () => {
        const lint = require('../../agents/lint');
        const l = bench.pickQuestion('lint', questions).question;
        assert.equal(lint.gate(l.question_text, l.answer_text || '').ok, false);
        assert.ok(questions.filter(q => q.id < l.id).every(q => lint.gate(q.question_text, q.answer_text || '').ok));
        assert.equal(bench.pickQuestion('verify', questions).question.question_type, '計算');
        assert.equal(bench.pickQuestion('classify', questions).question.id, questions[0].id);
        const k = bench.pickQuestion('kc_tag', questions).question;
        assert.ok(bench.kcsFor(k.subject, k.chapter).length > 0);
    });

    test('--id：不存在、lint 用規則就修得好、證明題、沒有知識點清單的章都擋下', () => {
        const lint = require('../../agents/lint');
        const clean = questions.find(q => lint.gate(q.question_text, q.answer_text || '').ok);
        assert.throws(() => bench.pickQuestion('verify', questions, { id: 99999 }), /沒有 id=99999/);
        assert.throws(() => bench.pickQuestion('lint', questions, { id: clean.id }), /規則就修得好/);
        const proof = questions.find(q => q.question_type === '證明');
        if (proof) assert.throws(() => bench.pickQuestion('verify', questions, { id: proof.id }), /證明題/);
        assert.throws(() => bench.pickQuestion('kc_tag', questions, { id: questions[0].id, kcsLookup: () => [] }), /沒有知識點清單/);
        assert.equal(bench.pickQuestion('classify', questions, { id: questions[1].id }).why, '--id 指定');
    });

    test('modelSpecFor 與 config/models.js 的 getter 相同（本機、Gemini、明寫 MODEL_TEXT／MODEL_KC_TAG）', () => {
        const cases = [
            {},
            { MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview' },
            { MODEL_TEXT: 'ollama:qwen3:4b' },
            { MODEL_KC_TAG: 'ollama:qwen3:1.7b', MODEL_VERIFY: 'ollama:gemma3:12b' }
        ];
        for (const env of cases) {
            for (const k of ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG']) { if (env[k]) process.env[k] = env[k]; else delete process.env[k]; }
            assert.equal(bench.modelSpecFor('lint', env), models.MODEL_TEXT, JSON.stringify(env));
            assert.equal(bench.modelSpecFor('classify', env), models.MODEL_TEXT);
            assert.equal(bench.modelSpecFor('verify', env), models.MODEL_VERIFY);
            assert.equal(bench.modelSpecFor('kc_tag', env), models.MODEL_KC_TAG);
        }
    });
});

describe('送出的請求與 agent 本身組的一模一樣', () => {
    test('verify：SYSTEM、提示詞含題目、schema、8192／1024、agent verify；沒有把 claimed_answer 放進 prompt', async () => {
        const verify = require('../../agents/verify');
        const q = bench.pickQuestion('verify', questions).question;
        const c = await bench.captureRequest('verify', bench.inputFor('verify', q), 'ollama:qwen3:8b');
        assert.equal(c.system, verify.SYSTEM);
        assert.ok(c.parts[0].text.includes(q.question_text));
        assert.ok(!c.parts[0].text.includes(q.answer_text), '驗算看不到拆題的答案');
        assert.deepEqual(c.schema, buildSchema('verify'));
        assert.deepEqual([c.maxOutputTokens, c.thinkingBudget, c.agent, c.model], [8192, 1024, 'verify', 'ollama:qwen3:8b']);
    });

    test('lint、classify、kc_tag 的 agent 名稱與兩個數字', async () => {
        const pick = (a) => bench.inputFor(a, bench.pickQuestion(a, questions).question);
        const l = await bench.captureRequest('lint', pick('lint'), 'ollama:qwen3:8b');
        assert.deepEqual([l.agent, l.template, l.maxOutputTokens, l.thinkingBudget], ['lint', 'lint.v3', 8192, 1024]);
        const c = await bench.captureRequest('classify', pick('classify'), 'ollama:qwen3:8b');
        assert.deepEqual([c.agent, c.maxOutputTokens, c.thinkingBudget], ['classify', undefined, undefined]);
        assert.deepEqual(c.cacheKeyParts.fewShotIds, [], '不接資料庫：few-shot 只用設定檔的例句（與錄 cassette 時相同）');
        const k = await bench.captureRequest('kc_tag', pick('kc_tag'), 'ollama:qwen3:8b');
        assert.deepEqual([k.agent, k.maxOutputTokens, k.thinkingBudget], ['kc_tag', 4096, 512]);
    });
});

describe('resolveCallParams：agent → .env 的本機調整 → 這次的參數', () => {
    const verifyReq = { agent: 'verify', thinkingBudget: 1024, maxOutputTokens: 8192 };
    const args = (o = {}) => ({ ...bench.parseArgs(['--agent', 'verify']), ...o });

    test('什麼都沒改＝正式上傳現在的樣子（〔Owner 第五輪 C-c〕驗算上限是本機預設 3072、照舊思考）', () => {
        assert.deepEqual(bench.resolveCallParams(verifyReq, args(), {}), {
            thinkingBudget: 1024, think: true, thinkWhy: '開（agent 預設）',
            maxOutputTokens: 3072, maxWhy: '本機預設（Owner 第五輪 C-c；OLLAMA_MAX_OUTPUT_VERIFY 可覆寫）',
            numCtx: 16384, ctxWhy: '預設', numThread: undefined
        });
        // 取消預設（OLLAMA_MAX_OUTPUT_VERIFY=8192）＝加預設之前的樣子
        const orig = bench.resolveCallParams(verifyReq, args(), { OLLAMA_MAX_OUTPUT_VERIFY: '8192' });
        assert.deepEqual([orig.maxOutputTokens, orig.maxWhy], [8192, 'agent 預設']);
    });

    test('〔Owner 第五輪 C-b〕kc_tag：本機預設不思考（標出來源）；OLLAMA_NO_THINK=none 恢復思考；--think 照樣蓋過', () => {
        const kc = { agent: 'kc_tag', thinkingBudget: 512, maxOutputTokens: 4096 };
        const kargs = (o = {}) => ({ ...bench.parseArgs(['--agent', 'kc_tag']), ...o });
        const d = bench.resolveCallParams(kc, kargs(), {});
        assert.deepEqual([d.think, d.thinkWhy, d.maxOutputTokens], [false, '關（本機預設，Owner 第五輪 C-b；OLLAMA_NO_THINK 可覆寫）', 4096]);
        const on = bench.resolveCallParams(kc, kargs(), { OLLAMA_NO_THINK: 'none' });
        assert.deepEqual([on.think, on.thinkWhy], [true, '開（agent 預設）']);
        assert.deepEqual(bench.resolveCallParams(kc, kargs({ think: true }), {}).thinkWhy, '開（--think）');
    });

    test('〔Owner 第五輪 C-e〕量測要用的參數都支援：--agent verify、--max-output、--no-think、--num-ctx', () => {
        const a = bench.parseArgs(['--agent', 'verify', '--max-output', '3072', '--no-think', '--num-ctx', '8192']);
        assert.deepEqual([a.agent, a.maxOutput, a.think, a.numCtx], ['verify', 3072, false, 8192]);
    });

    test('.env 的 OLLAMA_NO_THINK／OLLAMA_MAX_OUTPUT_VERIFY／OLLAMA_NUM_CTX_VERIFY 照套；這次的參數再蓋上去', () => {
        const env = { OLLAMA_NO_THINK: 'verify', OLLAMA_MAX_OUTPUT_VERIFY: '3072', OLLAMA_NUM_CTX_VERIFY: '8192', OLLAMA_NUM_CTX: '16384' };
        const p = bench.resolveCallParams(verifyReq, args(), env);
        assert.deepEqual([p.think, p.thinkWhy, p.maxOutputTokens, p.numCtx], [false, '關（.env 的 OLLAMA_NO_THINK）', 3072, 8192]);
        const q = bench.resolveCallParams(verifyReq, args({ think: true, maxOutput: 6000, numCtx: 12288, numThread: 3 }), env);
        assert.deepEqual([q.think, q.thinkingBudget, q.thinkWhy, q.maxOutputTokens, q.maxWhy, q.numCtx, q.ctxWhy, q.numThread],
            [true, 1024, '開（--think）', 6000, '--max-output', 12288, '--num-ctx', 3]);
        assert.equal(bench.resolveCallParams(verifyReq, args(), { OLLAMA_NUM_CTX: '8192' }).ctxWhy, '.env 的 OLLAMA_NUM_CTX');
    });

    test('--no-think；本來不思考的 agent 加 --think 用 THINK_ON_BUDGET', () => {
        assert.deepEqual(bench.resolveCallParams(verifyReq, args({ think: false }), {}).thinkWhy, '關（--no-think）');
        const cls = { agent: 'classify' };
        assert.equal(bench.resolveCallParams(cls, args(), {}).thinkWhy, '關（agent 本來就不思考）');
        assert.equal(bench.resolveCallParams(cls, args({ think: true }), {}).thinkingBudget, bench.THINK_ON_BUDGET);
        assert.deepEqual([bench.resolveCallParams(cls, args(), {}).maxOutputTokens, bench.resolveCallParams(cls, args(), {}).maxWhy], [undefined, 'agent 不設上限']);
    });
});

describe('main', () => {
    test('先卸載再呼叫一次；請求逐字轉交、帶上 num_ctx／num_thread／think；報告有思考與回答的比對', async () => {
        const { io, seen } = fakes({ env: { OLLAMA_NUM_CTX: '16384' } });
        const code = await bench.main(['--agent', 'verify', '--num-ctx', '8192', '--num-thread', '4', '--progress-sec', '0'], io);
        assert.equal(code, 0);
        assert.deepEqual(seen.order, ['unload', 'generate']);
        assert.deepEqual(seen.unload, [{ model: 'qwen3:8b' }]);
        const g = seen.generate[0];
        const verify = require('../../agents/verify');
        assert.equal(g.model, 'qwen3:8b', '裸 ID');
        assert.equal(g.system, verify.SYSTEM);
        // 〔Owner 第五輪 C-c〕驗算的輸出上限是本機預設 3072
        assert.deepEqual([g.thinkingBudget, g.maxOutputTokens, g.numCtx, g.numThread, g.progressMs, g.timeoutMs], [1024, 3072, 8192, 4, 0, 60 * 60_000]);
        const out = seen.out;
        assert.match(out, /══ 文字模型量測（npm run local:bench-text）/);
        assert.match(out, /思考：開（agent 預設）；num_ctx：8,192（--num-ctx）；輸出上限：3,072（本機預設（Owner 第五輪 C-c；OLLAMA_MAX_OUTPUT_VERIFY 可覆寫））；執行緒：4（--num-thread）/);
        assert.match(out, /\| 讀 prompt \| 1 分 \| 320 \| 5\.33 token\/秒 \|/);
        assert.match(out, /\| 輸出（含思考） \| 4 分 \| 480 \| 2\.00 token\/秒 \|/);
        assert.match(out, /\| 　其中思考（估） \|/);
        assert.match(out, /→ 一致/, 'fixture 第一題計算題的答案是 4');
        assert.match(out, /一份 10 題的卷：這一步大約 10～14\.3 次/);
    });

    test('--no-think --warm：不卸載、think 關、報告不列思考；lint 回報重寫後過不過閘門', async () => {
        const { io, seen } = fakes({
            generate: () => ({
                data: { question_text: '設 $\\frac{1}{2}$', answer_text: '$1$' },
                usage: { tokenIn: 900, tokenOut: 250, tokenThinking: 0, tokenCached: 0, timing: TIMING }, raw: { message: {} }
            })
        });
        assert.equal(await bench.main(['--agent', 'lint', '--no-think', '--warm', '--progress-sec', '0'], io), 0);
        assert.deepEqual(seen.order, ['generate']);
        assert.equal(seen.generate[0].thinkingBudget, 0);
        assert.ok(!/其中思考/.test(seen.out));
        assert.match(seen.out, /\| 輸出 \| 4 分 \| 250 \|/);
        assert.match(seen.out, /重寫後通過公式閘門/);
        assert.ok(!seen.out.includes(bench.CLASSIFY_NOTE), '不是分類就不印分類的注意事項');
    });

    test('〔審查修正〕classify：報告註明 few-shot 來自設定檔（沒有資料庫），與正式上傳不同', async () => {
        const { io, seen } = fakes({
            generate: () => ({
                data: { chapter: '數列', confidence: 0.9, rationale: '因為' },
                usage: { tokenIn: 3600, tokenOut: 60, tokenThinking: 0, tokenCached: 0, timing: TIMING }, raw: { message: {} }
            })
        });
        assert.equal(await bench.main(['--agent', 'classify', '--progress-sec', '0'], io), 0);
        assert.ok(seen.out.includes(bench.CLASSIFY_NOTE));
        assert.match(bench.CLASSIFY_NOTE, /few-shot 全部來自設定檔的自製例句/);
        assert.match(bench.CLASSIFY_NOTE, /FEATURE_SIMILAR/);
        // 前提：量測時 ctx.db＝null，few-shot 全部來自設定檔的自製例句（config/chapterExamples.js）
        const classify = require('../../agents/classify');
        const { getChapterExample } = require('../../config/chapterExamples');
        const q = bench.loadFixtureQuestions()[0];
        const text = seen.generate[0].parts[0].text;
        assert.ok(text.includes(classify.fewShotText([{ question_text: 'x', chapter: 'y' }]).split('\n')[0]), '有 few-shot 段');
        const other = require('../../config/chapters').CHAPTERS[q.subject].find(c => c !== q.chapter);
        assert.ok(text.includes(String(getChapterExample(q.subject, other)).trim().slice(0, 20)), '例句來自設定檔');
    });

    test('逾時：結束碼 1、講明怎麼辦；不是 ollama 的模型直接擋下', async () => {
        const { io, seen } = fakes({ generate: () => { throw Object.assign(new Error('Ollama 呼叫超過這次指定的逾時'), { errorClass: 'timeout' }); } });
        assert.equal(await bench.main(['--agent', 'classify', '--progress-sec', '0'], io), 1);
        assert.match(seen.out, /❌ 沒有量到：Ollama 呼叫超過這次指定的逾時/);
        assert.match(seen.out, /加大 --timeout-min/);
        await assert.rejects(() => bench.main(['--agent', 'verify', '--model', 'gemini:gemini-3.1-pro-preview'], fakes().io), /只量本機模型/);
    });

    test('JSON 不合法（寫到上限）：時間照樣報、提醒思考把額度用光', async () => {
        const { io, seen } = fakes({
            generate: () => { throw Object.assign(new Error('Unexpected end of JSON input'), { errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS', usage: { tokenIn: 300, tokenOut: 8192, tokenThinking: 0, timing: TIMING } }); }
        });
        assert.equal(await bench.main(['--agent', 'verify', '--progress-sec', '0'], io), 0);
        assert.match(seen.out, /finishReason MAX_TOKENS：寫到輸出上限被截斷——思考把額度用光了/);
        assert.match(seen.out, /JSON 不合法，沒有回答可以比/);
    });

    test('不寫 cassette、不碰資料庫：LLM_MODE=record 也一樣（直接呼叫 adapter；真的 adapter＋假的傳輸）', async () => {
        const dir = path.join(tmp, 'cassettes');
        process.env.LLM_MODE = 'record';
        process.env.EVAL_CASSETTE_DIR = dir;
        const calls = [];
        ollama._setTransportForTest(async (url, payload) => {
            calls.push({ url, payload: JSON.parse(JSON.stringify(payload)) });
            if (url.endsWith('/api/generate')) return { status: 200, text: JSON.stringify({ done_reason: 'unload' }) };
            return {
                status: 200,
                text: JSON.stringify({
                    done: true, done_reason: 'stop', message: { role: 'assistant', content: '{"chapter":"指數函數與對數函數","confidence":0.9,"rationale":"r"}' },
                    prompt_eval_count: 3000, eval_count: 60, total_duration: 3e11, load_duration: 5e9, prompt_eval_duration: 2e11, eval_duration: 3e10
                })
            };
        });
        try {
            const out = [];
            const code = await bench.main(['--agent', 'classify', '--no-think', '--num-thread', '2', '--progress-sec', '0'],
                { env: {}, stdout: { write: (s) => out.push(s) } });
            assert.equal(code, 0, out.join(''));
            assert.deepEqual(calls.map(c => c.url.replace(/^.*\/api/, '/api')), ['/api/generate', '/api/chat']);
            const chat = calls[1].payload;
            assert.equal(chat.think, false);
            assert.deepEqual(chat.options, { temperature: 0, num_ctx: 16384, num_thread: 2 });
            assert.equal(fs.existsSync(dir), false, '沒有寫任何 cassette');
            assert.match(out.join(''), /分到「指數函數與對數函數」.*→ 相同/);
        } finally {
            ollama._resetForTest();
            delete process.env.LLM_MODE;
            delete process.env.EVAL_CASSETTE_DIR;
        }
    });
});

describe('推估的常數', () => {
    test('TOKENS_PER_CHAR 與 repo 裡本機回放檔擬合的結果相差不到 0.05（npm run perf:local 第 1.4 段同一個方法）', () => {
        const inv = perf.readCassettes(perf.DEFAULT_CASSETTE_DIR);
        const local = perf.selectEntries(inv.entries).selected;
        const [t] = perf.estimateThinking(local);
        if (!t) return;   // 本機 cassette 被清掉時不適用
        assert.ok(Math.abs(t.coef.a - bench.TOKENS_PER_CHAR.cjk) < 0.05, `中文 ${t.coef.a}`);
        assert.ok(Math.abs(t.coef.b - bench.TOKENS_PER_CHAR.other) < 0.05, `其他 ${t.coef.b}`);
        assert.equal(Math.round(bench.estimateTokens('一二三abcd')), Math.round(3 * 0.88 + 4 * 0.5));
    });

    test('callsPerPaper 與 perf:local 的 PAPER_ASSUMPTIONS 一致', () => {
        const A = perf.PAPER_ASSUMPTIONS;
        assert.deepEqual([bench.callsPerPaper('lint').low, bench.callsPerPaper('lint').high], [10 * A.LINT_LLM_RATE.low, 10 * A.LINT_LLM_RATE.high]);
        assert.deepEqual([bench.callsPerPaper('classify').low, bench.callsPerPaper('classify').high], [0, 10]);
        assert.equal(bench.callsPerPaper('kc_tag').low, 10);
        assert.ok(Math.abs(bench.callsPerPaper('verify').high - 10 * (1 + A.VERIFY_UNCERTAIN_RATE_FALLBACK) * (1 + A.VERIFY_FAIL_RATE.high)) < 1e-9);
    });
});
