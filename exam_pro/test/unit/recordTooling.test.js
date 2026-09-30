// ─────────────────────────────────────────────────────────────
// test/unit/recordTooling.test.js — 重錄工具補強（〔dec/r9-record-tooling〕docs/local-mode.md 10.23）
//
// 兩個新功能：
//   1. 只補錄缺的：LLM_MODE=record＋LLM_RECORD_ONLY_MISSING=1（向量：EMBED_MODE=record＋EMBED_RECORD_ONLY_MISSING=1）——
//      回放檔在就走 replay 的同一條路（不呼叫模型、不覆寫），不在才 live 呼叫並寫入；
//      npm run cassettes:rerecord -- --only-missing／record_local.bat <suite> --only-missing。
//   2. 錯誤回放檔：錄製時 live 呼叫被截斷（finishReason MAX_TOKENS）或單次逾時（ollama 的 OLLAMA_TIMEOUT_MS），
//      照樣寫一支回放檔；回放丟出與 live 相同形狀的錯。連不上、401、呼叫端中止之類的環境錯誤不錄。
// 另外釘住：盤點（探針、summarize、formatSummary、rerecord 的說明與回放驗證表）與 cassettes:prune 把錯誤回放檔分開算、
// 不當成孤兒；variant eval 讀到錯誤回放檔時記成那一題沒通過、不進 failures；錄製環境變數的放行。
//
// 端到端的情境照 Owner 2026-09-27～28 的 variant 重錄：var-008#1 的變式生成逾時、var-015#1 的驗算（推測）被截斷，
// 兩支都沒有回放檔 → 回放永遠是 miss。這裡用同一個形狀（一個藍本、兩題）重現，再用只補缺的補錄、回放驗證。
//
// 不連 Ollama：模型與向量都走 services/llm/ollama.js 的測試注入點（_setTransportForTest）；
// cassette 與向量檔一律寫到系統暫存目錄，不碰 repo 的 eval/。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');

const ENV_KEYS = [
    'LLM_MODE', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM', 'EMBED_FIXTURE_DIR', 'EVAL_CASSETTE_DIR',
    'MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_VARIANT', 'MODEL_TEXT', 'OLLAMA_HOST', 'OLLAMA_RPM', 'OLLAMA_CONCURRENCY',
    'OLLAMA_TIMEOUT_MS', 'OLLAMA_PROGRESS_MS', 'OLLAMA_NO_THINK', 'OLLAMA_MAX_OUTPUT_VERIFY', 'OLLAMA_NUM_CTX',
    'CLASSIFY_MIN_CONF', 'DEDUP_DUP_THRESHOLD', 'LLM_RECORD_ONLY_MISSING', 'EMBED_RECORD_ONLY_MISSING', 'GEMINI_API_KEY'
];
const envBackup = {};
for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-rectool-'));
process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
process.env.EMBED_DIM = '768';
process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
process.env.MODEL_VERIFY = 'ollama:qwen3:8b';
process.env.EMBED_FIXTURE_DIR = path.join(tmpDir, 'fixtures');
process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');
process.env.LLM_MODE = 'replay';
process.env.EMBED_MODE = 'fixture';

const ollama = require('../../services/llm/ollama');
const throttle = require('../../services/llm/throttle');
const cassette = require('../../services/llm/cassette');
const fake = require('../../services/llm/fake');
const llmFixture = require('../../services/llm/fixture');
const llm = require('../../services/llm');
const templates = require('../../services/llm/templates');
const replayMiss = require('../../eval/lib/replayMiss');
const { buildSchema } = require('../../agents/schemas');

templates.registerTemplate('rectool.v1', '重錄工具測試用模板');
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

after(() => {
    ollama._resetForTest();
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    throttle._resetForTest();
    fake._resetForTest();
    cassette._resetErrorCassettesForTest();
    process.env.LLM_MODE = 'replay';
    process.env.EMBED_MODE = 'fixture';
    delete process.env.LLM_RECORD_ONLY_MISSING;
    delete process.env.EMBED_RECORD_ONLY_MISSING;
    delete process.env.OLLAMA_TIMEOUT_MS;
});

/** 確定性的假向量（sha256 展開成 dim 維）：只給單元測試的假 Ollama 用 */
function fakeVector(text, dim = 768) {
    const out = [];
    for (let k = 0; out.length < dim; k++) {
        const buf = crypto.createHash('sha256').update(`${k}:${text}`, 'utf8').digest();
        for (const b of buf) { if (out.length < dim) out.push(b / 127.5 - 1); }
    }
    return out;
}

/** /api/chat 的 stream:false 回應 */
function chatReply(payload, content, doneReason = 'stop') {
    return {
        status: 200,
        text: JSON.stringify({
            model: payload.model, done: true, done_reason: doneReason,
            message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) },
            prompt_eval_count: 120, eval_count: doneReason === 'length' ? 3072 : 40,
            total_duration: 5e9, load_duration: 1e8, prompt_eval_duration: 1e9, eval_duration: 3.9e9
        })
    };
}

/** 一直不回、直到被中止（呼叫端的 signal 或 OLLAMA_TIMEOUT_MS）：模型陷入重複迴圈的樣子 */
function hang(opts) {
    return new Promise((_, reject) => {
        const s = opts && opts.signal;
        const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (!s) return;
        if (s.aborted) fail(); else s.addEventListener('abort', fail, { once: true });
    });
}

/** 注入假 Ollama；handler(url, payload, opts) 回 {status,text}；記下每一次呼叫 */
function installOllama(handler) {
    const calls = [];
    ollama._setTransportForTest(async (url, payload, opts) => {
        calls.push({ url, payload });
        return handler(url, payload, opts);
    });
    return calls;
}

function forbidOllama() {
    ollama._setTransportForTest(async (url) => { throw new Error(`回放／只補缺的已有檔時不得呼叫模型：${url}`); });
}

/** 一次 generateJson 的參數（驗算的形狀；schema 用真的 verify schema，鍵才與 agent 一致） */
function jsonOpts(extra = {}) {
    return {
        model: 'ollama:qwen3:8b', system: 's', parts: [{ text: '題幹全文不該進 cassette：求 1+1' }],
        schema: SCHEMA, agent: 'rectool', template: 'rectool.v1', cacheKeyParts: { template: 'rectool.v1', n: 1 }, ...extra
    };
}

function keyOf(o, schema = o.schema) {
    return cassette.cassetteKey({ agent: o.agent, modelId: String(o.model).replace(/^ollama:/, ''), template: o.template, schema, cacheKeyParts: o.cacheKeyParts });
}

function readSaved(agent, key) {
    return JSON.parse(fs.readFileSync(cassette.cassettePath(agent, key), 'utf8'));
}

/** 靜音 console.log（[llm:record] 那幾行），回傳收到的字串 */
function quiet(t) {
    const logs = [];
    t.mock.method(console, 'log', (m) => logs.push(String(m)));
    return logs;
}

// ───────────────────────── 1. 判斷準則（純函式） ─────────────────────────

describe('errorCassetteKind：哪些錯誤錄成錯誤回放檔', () => {
    const { errorCassetteKind } = cassette;
    test('被截斷（finishReason MAX_TOKENS）：兩個供應商都錄', () => {
        assert.equal(errorCassetteKind({ errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' }, { vendor: 'ollama' }), 'truncated');
        assert.equal(errorCassetteKind({ errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' }, { vendor: 'gemini' }), 'truncated');
    });
    test('單次逾時：只有 ollama、adapter 自己的計時器到了（timedOut）、而且呼叫端的 signal 沒有被中止', () => {
        const to = { errorClass: 'timeout', timedOut: true };
        assert.equal(errorCassetteKind(to, { vendor: 'ollama' }), 'timeout');
        const ac = new AbortController();
        assert.equal(errorCassetteKind(to, { vendor: 'ollama', signal: ac.signal }), 'timeout');
        ac.abort();
        assert.equal(errorCassetteKind(to, { vendor: 'ollama', signal: ac.signal }), null, '節點逾時／現在放棄不錄');
        assert.equal(errorCassetteKind(to, { vendor: 'gemini' }), null, 'Gemini 的逾時是網路狀況，不錄');
        // 〔審查 dec/r9-record-tooling〕errorClass 是 timeout、但不是計時器造成的（transportError 的第三支）：不錄
        assert.equal(errorCassetteKind({ errorClass: 'timeout' }, { vendor: 'ollama' }), null, '沒有 timedOut 不錄');
        assert.equal(errorCassetteKind({ errorClass: 'timeout', timedOut: 'yes' }, { vendor: 'ollama' }), null, 'timedOut 只認 true');
    });
    test('環境錯誤與其他模型輸出錯誤不錄', () => {
        for (const err of [
            { errorClass: 'provider_error' }, { errorClass: 'rate_limited' }, { errorClass: 'unsupported_input' },
            { errorClass: 'schema_invalid', finishReason: 'STOP' }, { errorClass: 'schema_invalid', finishReason: null },
            new Error('沒有 errorClass'), null, undefined, 'x'
        ]) {
            assert.equal(errorCassetteKind(err, { vendor: 'ollama' }), null, JSON.stringify(err));
        }
    });
    test('errorResponse：被截斷的存用量與 latencyMs；逾時的只存 elapsedMs（perf:local 不會把它當速度）；kind 以外的值丟錯', () => {
        const trunc = cassette.errorResponse(Object.assign(new SyntaxError('Unterminated string in JSON at position 9'),
            { errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS', usage: { tokenIn: 1, tokenOut: 3072, tokenThinking: 0, tokenCached: 0 } }), 'truncated', { elapsedMs: 1234.4 });
        assert.deepEqual(trunc, {
            error: { kind: 'truncated', name: 'SyntaxError', message: 'Unterminated string in JSON at position 9', errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' },
            usage: { tokenIn: 1, tokenOut: 3072, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1234
        });
        const to = cassette.errorResponse(Object.assign(new Error('超過'), { errorClass: 'timeout' }), 'timeout', { elapsedMs: 50 });
        assert.deepEqual(to, { error: { kind: 'timeout', name: 'Error', message: '超過', errorClass: 'timeout', finishReason: null, elapsedMs: 50 } });
        assert.equal(to.latencyMs, undefined);
        assert.throws(() => cassette.errorResponse(new Error('x'), 'provider_error'), /kind 只能是/);
        const long = cassette.errorResponse(Object.assign(new Error('字'.repeat(5000)), { errorClass: 'timeout' }), 'timeout');
        assert.equal(long.error.message.length, cassette.ERROR_MESSAGE_MAX);
    });
});

// ───────────────────────── 2. 錯誤回放檔：寫入與回放 ─────────────────────────

describe('錯誤回放檔：錄製時寫下、回放丟出同形狀的錯', () => {
    test('被截斷（done_reason=length、JSON 寫到一半）：寫錯誤回放檔，request 只存摘要；回放丟同一個錯，不是 replay miss', async (t) => {
        const logs = quiet(t);
        process.env.LLM_MODE = 'record';
        installOllama((url, payload) => chatReply(payload, '{"answer":"很長很長', 'length'));
        const opts = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'trunc' } });
        let live;
        await assert.rejects(llm.generateJson(opts), (err) => { live = err; return true; });
        assert.equal(live.errorClass, 'schema_invalid');
        assert.equal(live.finishReason, 'MAX_TOKENS');
        const key = keyOf(opts);
        assert.deepEqual(live.errorCassette, { agent: 'rectool', key, kind: 'truncated' }, 'record 時錯誤物件標記寫下的那一支');
        assert.ok(logs.some(l => l.startsWith('[llm:record] 寫入錯誤回放檔（被截斷）')), logs.join('\n'));

        const saved = readSaved('rectool', key);
        assert.deepEqual(Object.keys(saved), ['meta', 'request', 'response']);
        assert.deepEqual(Object.keys(saved.meta), ['agent', 'model', 'template', 'recorded_at', 'fixtureHash'], 'meta 與一般回放檔同欄');
        assert.equal(saved.meta.model, 'qwen3:8b');
        assert.deepEqual(saved.request.cacheKeyParts, opts.cacheKeyParts);
        assert.ok(!JSON.stringify(saved).includes('題幹全文不該進 cassette'), 'request 只存摘要');
        assert.equal(saved.response.error.kind, 'truncated');
        assert.equal(saved.response.error.message, live.message);
        assert.equal(saved.response.error.name, 'SyntaxError');
        assert.equal(saved.response.error.finishReason, 'MAX_TOKENS');
        assert.equal(saved.response.usage.tokenOut, 3072);
        assert.ok(Number.isInteger(saved.response.latencyMs));
        assert.equal(saved.response.data, undefined);

        process.env.LLM_MODE = 'replay';
        forbidOllama();
        let replayed;
        await assert.rejects(llm.generateJson(opts), (err) => { replayed = err; return true; });
        assert.ok(replayed instanceof SyntaxError);
        assert.equal(replayed.message, live.message);
        assert.equal(replayed.errorClass, live.errorClass);
        assert.equal(replayed.finishReason, live.finishReason);
        assert.deepEqual(replayed.usage, { tokenIn: 120, tokenOut: 3072, tokenThinking: 0, tokenCached: 0 });
        assert.deepEqual(replayed.errorCassette, { agent: 'rectool', key, kind: 'truncated' });
        assert.equal(replayed.replayed, true);
        assert.equal(replayMiss.isReplayMiss(replayed), false, '不是 replay miss');
        assert.deepEqual(cassette.errorCassettesSeen().map(e => [e.agent, e.key, e.kind]), [['rectool', key, 'truncated']]);
    });

    test('驗算被截斷：agent 的 outcome 回放與錄製當時逐欄相同；runner 照 C-f 判成本機截斷（output_truncated）', async (t) => {
        quiet(t);
        const verify = require('../../agents/verify');
        const runner = require('../../workers/jobRunner');
        const ctx = () => ({
            llm, db: null, logger: { warn() {}, info() {}, error() {} }, signal: undefined,
            job: { id: 0, kind: 'pdf', subject_group: 'math_physics' },
            config: { models: { verify: 'ollama:qwen3:8b' }, thresholds: {}, features: {} }
        });
        const input = { question_text: '重錄工具：驗算被截斷的題', question_type: '計算', claimed_answer: '2' };
        process.env.LLM_MODE = 'record';
        const calls = installOllama((url, payload) => chatReply(payload, '{"final_answer":"2","answer_form":"number","steps_summary":"很長', 'length'));
        const live = await verify.run(ctx(), input);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].payload.options.num_predict, 3072, '照本機預設上限（C-c）');
        assert.equal(live.kind, 'error');
        assert.equal(live.finishReason, 'MAX_TOKENS');

        process.env.LLM_MODE = 'replay';
        forbidOllama();
        const replayed = await verify.run(ctx(), input);
        assert.deepEqual(replayed, live);
        assert.equal(runner.isLocalTruncation(replayed, 'ollama:qwen3:8b'), true, 'runner 的 C-f：不重試、直接 needs_review(output_truncated)');
    });

    test('單次逾時（OLLAMA_TIMEOUT_MS）：寫錯誤回放檔（沒有 latencyMs、有 elapsedMs）；回放丟同一個錯；變式生成的 outcome 相同', async (t) => {
        quiet(t);
        const gv = require('../../agents/generateVariant');
        const { loadFixture } = require('../../eval/lib/fixtures');
        const source = loadFixture().byId.get(16);   // var-008 的藍本（向量內積、證明、難度 5）
        const ctx = () => ({
            llm, db: null, logger: { warn() {}, info() {}, error() {} }, signal: undefined,
            job: { id: 0, kind: 'variant', pdf_sha256: null },
            config: { models: { variant: 'ollama:qwen3:8b', verify: 'ollama:qwen3:8b' }, thresholds: { variantOfftopicSimMin: -1 }, features: {} }
        });
        const input = { source, neighbors: [], difficulty_delta: 0, idx: 1, total: 2, siblings: [] };
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '40';
        installOllama((url, payload, opts) => hang(opts));
        const live = await gv.run(ctx(), input);
        assert.equal(live.kind, 'error');
        assert.equal(live.errorClass, 'timeout');
        assert.match(live.message, /^Ollama 呼叫超過 OLLAMA_TIMEOUT_MS（40 ms）仍未完成/);

        const key = cassette.cassetteKey({
            agent: 'variant', modelId: 'qwen3:8b', template: gv.TEMPLATE, schema: buildSchema('variant'),
            cacheKeyParts: { template: gv.TEMPLATE, sourceQuestionId: 16, difficultyDelta: 0, idx: 1, anchorIds: [], total: 2, siblings: [] }
        });
        const saved = readSaved('variant', key);
        assert.equal(saved.response.error.kind, 'timeout');
        assert.equal(saved.response.error.errorClass, 'timeout');
        assert.equal(saved.response.latencyMs, undefined, '逾時的時間不是速度資料');
        assert.equal(saved.response.usage, undefined);
        assert.ok(saved.response.error.elapsedMs >= 0);

        process.env.LLM_MODE = 'replay';
        forbidOllama();
        const replayed = await gv.run(ctx(), input);
        assert.deepEqual(replayed, live);
    });

    test('generateText：單次逾時也錄；被截斷不丟錯，照一般回放檔錄 finishReason', async (t) => {
        quiet(t);
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '40';
        const base = { model: 'ollama:qwen3:8b', system: 's', parts: [{ text: 'q' }], agent: 'rectool', template: 'rectool.v1' };
        installOllama((url, payload, opts) => hang(opts));
        const o1 = { ...base, cacheKeyParts: { template: 'rectool.v1', text: 'timeout' } };
        let live;
        await assert.rejects(llm.generateText(o1), (err) => { live = err; return true; });
        const k1 = keyOf(o1, undefined);
        const s1 = readSaved('rectool', k1);
        assert.equal(s1.meta.kind, 'text');
        assert.deepEqual(s1.request.tools, { codeExecution: false });
        assert.equal(s1.response.error.kind, 'timeout');

        installOllama((url, payload) => chatReply(payload, '寫到一半', 'length'));
        const o2 = { ...base, cacheKeyParts: { template: 'rectool.v1', text: 'length' } };
        const res2 = await llm.generateText(o2);
        assert.equal(res2.finishReason, 'MAX_TOKENS');
        assert.equal(readSaved('rectool', keyOf(o2, undefined)).response.error, undefined, '被截斷的 generateText 是一般回放檔');

        process.env.LLM_MODE = 'replay';
        forbidOllama();
        await assert.rejects(llm.generateText(o1), (err) => err.message === live.message && err.errorClass === 'timeout');
        assert.equal((await llm.generateText(o2)).finishReason, 'MAX_TOKENS');
    });

    test('環境錯誤不錄：連不上、HTTP 401、呼叫端中止、JSON 壞了但沒被截斷；錯誤原樣往上丟', async (t) => {
        const logs = quiet(t);
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '1000';
        const cases = [
            ['conn', async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }); }, /Ollama 沒有在執行/],
            ['401', async () => ({ status: 401, text: JSON.stringify({ error: 'unauthorized' }) }), /HTTP 401/],
            ['badjson', async (url, payload) => chatReply(payload, '不是 JSON', 'stop'), /JSON/]
        ];
        for (const [name, handler, re] of cases) {
            installOllama(handler);
            const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', env: name } });
            await assert.rejects(llm.generateJson(o), (err) => re.test(err.message) && !err.errorCassette, name);
            assert.equal(fs.existsSync(cassette.cassettePath('rectool', keyOf(o))), false, `${name} 不得留下回放檔`);
        }
        // 呼叫端中止（節點逾時、現在放棄）：timeout，但不是這一次呼叫的結果
        const ac = new AbortController();
        installOllama((url, payload, opts) => { setTimeout(() => ac.abort(), 5); return hang(opts); });
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', env: 'abort' }, signal: ac.signal });
        await assert.rejects(llm.generateJson(o), (err) => err.errorClass === 'timeout' && !err.errorCassette);
        assert.equal(fs.existsSync(cassette.cassettePath('rectool', keyOf(o))), false);
        assert.ok(logs.filter(l => l.includes('不錄回放檔')).length >= 4, logs.join('\n'));
        assert.deepEqual(cassette.errorCassettesSeen(), []);
    });

    test('〔審查〕AbortError 但兩個 signal 都沒中止（transportError 的第三支）：errorClass 仍是 timeout、不帶 timedOut、不錄', async (t) => {
        const logs = quiet(t);
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '60000';
        installOllama(async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); });
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', env: 'stray-abort' } });
        let live;
        await assert.rejects(llm.generateJson(o), (err) => { live = err; return true; });
        assert.equal(live.errorClass, 'timeout');
        assert.match(live.message, /^Ollama 呼叫已被中止：/);
        assert.equal(live.timedOut, undefined);
        assert.equal(live.errorCassette, undefined);
        assert.equal(fs.existsSync(cassette.cassettePath('rectool', keyOf(o))), false);
        assert.ok(logs.some(l => l.includes('不錄回放檔')), logs.join('\n'));
    });

    test('〔審查〕計時器到了的那一支帶 timedOut:true（message、errorClass 不變）；回放的錯同樣帶 timedOut', async (t) => {
        quiet(t);
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '30';
        installOllama((url, payload, opts) => hang(opts));
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', env: 'timer' } });
        let live;
        await assert.rejects(llm.generateJson(o), (err) => { live = err; return true; });
        assert.equal(live.timedOut, true);
        assert.equal(live.errorClass, 'timeout');
        assert.match(live.message, /^Ollama 呼叫超過 OLLAMA_TIMEOUT_MS（30 ms）仍未完成：/);
        assert.equal(readSaved('rectool', keyOf(o)).response.error.timedOut, undefined, '回放檔不另存旗標（kind:timeout 就是它）');
        process.env.LLM_MODE = 'replay';
        forbidOllama();
        await assert.rejects(llm.generateJson(o), (err) => err.timedOut === true && err.message === live.message && err.errorClass === 'timeout');
    });

    test('〔審查〕完整重錄時錯誤回放檔蓋掉「正常回放檔」：印醒目警告；原本沒有檔或原本就是錯誤回放檔時不印', async (t) => {
        const logs = quiet(t);
        const warns = [];
        t.mock.method(console, 'warn', (m) => warns.push(String(m)));
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '30';
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'replace-normal' } });
        const file = cassette.cassettePath('rectool', keyOf(o));
        installOllama((url, payload) => chatReply(payload, { answer: '正常' }));
        await llm.generateJson(o);
        assert.equal(readSaved('rectool', keyOf(o)).response.data.answer, '正常');
        assert.deepEqual(warns, []);

        installOllama((url, payload, opts) => hang(opts));
        await assert.rejects(llm.generateJson(o), (err) => err.errorClass === 'timeout');
        assert.equal(readSaved('rectool', keyOf(o)).response.error.kind, 'timeout', '照實錄下這一次的結果');
        assert.equal(warns.length, 1, warns.join('\n'));
        assert.equal(warns[0], llm.replacedNormalWarning({ agent: 'rectool', key: keyOf(o), what: '單次逾時', file }));
        assert.ok(warns[0].startsWith('⚠️ [llm:record] 注意：原本是正常回放檔，這次單次逾時，已覆寫成錯誤回放檔'));
        assert.ok(warns[0].includes('git checkout -- ') && warns[0].includes('10.23 第 5 點第 4 步'));
        assert.ok(logs.some(l => l.startsWith('[llm:record] 覆寫錯誤回放檔（單次逾時）')), logs.join('\n'));

        // 再錄一次：原本就是錯誤回放檔 → 不再警告
        installOllama((url, payload) => chatReply(payload, '{"answer":"寫到一半', 'length'));
        await assert.rejects(llm.generateJson(o), (err) => err.finishReason === 'MAX_TOKENS');
        assert.equal(warns.length, 1, '錯誤回放檔蓋錯誤回放檔不警告');
        // 原本沒有檔：不警告
        const o2 = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'replace-none' } });
        await assert.rejects(llm.generateJson(o2), (err) => err.finishReason === 'MAX_TOKENS');
        assert.equal(warns.length, 1);
        // 正常回放檔被「被截斷」蓋掉：說法是被截斷
        const o3 = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'replace-trunc' } });
        installOllama((url, payload) => chatReply(payload, { answer: '正常' }));
        await llm.generateJson(o3);
        installOllama((url, payload) => chatReply(payload, '{"answer":"寫到一半', 'length'));
        await assert.rejects(llm.generateJson(o3), (err) => err.finishReason === 'MAX_TOKENS');
        assert.equal(warns.length, 2);
        assert.ok(warns[1].includes('這次被截斷，已覆寫成錯誤回放檔'));
    });

    test('完整重錄（沒開只補缺的）：已有的一般回放檔照舊重新呼叫並覆寫', async (t) => {
        const logs = quiet(t);
        process.env.LLM_MODE = 'record';
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'overwrite' } });
        installOllama((url, payload) => chatReply(payload, { answer: '第一次' }));
        await llm.generateJson(o);
        const calls = installOllama((url, payload) => chatReply(payload, { answer: '第二次' }));
        const res = await llm.generateJson(o);
        assert.equal(calls.length, 1);
        assert.equal(res.data.answer, '第二次');
        assert.equal(readSaved('rectool', keyOf(o)).response.data.answer, '第二次');
        assert.ok(logs.some(l => l.startsWith('[llm:record] 覆寫 cassette')), logs.join('\n'));
    });
});

// ───────────────────────── 3. 只補錄缺的 ─────────────────────────

describe('只補錄缺的（LLM_RECORD_ONLY_MISSING=1）', () => {
    test('generateJson：已有 → 不呼叫、不覆寫、照 replay 回傳（含 LaTeX 反斜線修復）；沒有 → 呼叫並寫入', async (t) => {
        const logs = quiet(t);
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'om-json' } });
        // 先錄一支：模型的原始回應裡 \frac 的 \f 被 JSON 吃成換頁字元（latexEscapeRepair 要補回）
        process.env.LLM_MODE = 'record';
        installOllama((url, payload) => chatReply(payload, '{"answer":"$\\frac{1}{2}$"}'));
        const first = await llm.generateJson(o);
        assert.equal(first.data.answer, '$\\frac{1}{2}$');
        const file = cassette.cassettePath('rectool', keyOf(o));
        const before = fs.readFileSync(file);
        const beforeStat = fs.statSync(file);

        process.env.LLM_RECORD_ONLY_MISSING = '1';
        forbidOllama();
        const again = await llm.generateJson(o);
        assert.deepEqual(again.data, first.data, '照回放路徑，修復結果相同');
        assert.equal(again.replayed, true);
        assert.ok(fs.readFileSync(file).equals(before), '不覆寫');
        assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs);
        assert.ok(logs.some(l => l.startsWith('[llm:record] 只補缺的：已有回放檔')), logs.join('\n'));

        const o2 = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'om-json-new' } });
        const calls = installOllama((url, payload) => chatReply(payload, { answer: '新的' }));
        const fresh = await llm.generateJson(o2);
        assert.equal(calls.length, 1);
        assert.equal(fresh.data.answer, '新的');
        assert.equal(readSaved('rectool', keyOf(o2)).response.data.answer, '新的');
    });

    test('錯誤回放檔也算「已有」：照回放丟錯、不重打', async (t) => {
        quiet(t);
        const o = jsonOpts({ cacheKeyParts: { template: 'rectool.v1', n: 'om-err' } });
        process.env.LLM_MODE = 'record';
        installOllama((url, payload) => chatReply(payload, '{"answer":"寫到', 'length'));
        await assert.rejects(llm.generateJson(o));
        const before = fs.readFileSync(cassette.cassettePath('rectool', keyOf(o)));
        process.env.LLM_RECORD_ONLY_MISSING = 'true';
        forbidOllama();
        await assert.rejects(llm.generateJson(o), (err) => err.finishReason === 'MAX_TOKENS' && err.replayed === true);
        assert.ok(fs.readFileSync(cassette.cassettePath('rectool', keyOf(o))).equals(before));
    });

    test('generateText：已有 → 不呼叫；沒有 → 呼叫並寫入', async (t) => {
        quiet(t);
        const base = { model: 'ollama:qwen3:8b', system: 's', parts: [{ text: 'q' }], agent: 'rectool', template: 'rectool.v1' };
        const o = { ...base, cacheKeyParts: { template: 'rectool.v1', text: 'om' } };
        process.env.LLM_MODE = 'record';
        installOllama((url, payload) => chatReply(payload, '答案'));
        await llm.generateText(o);
        process.env.LLM_RECORD_ONLY_MISSING = '1';
        forbidOllama();
        assert.equal((await llm.generateText(o)).text, '答案');
        const o2 = { ...base, cacheKeyParts: { template: 'rectool.v1', text: 'om-new' } };
        const calls = installOllama((url, payload) => chatReply(payload, '新答案'));
        assert.equal((await llm.generateText(o2)).text, '新答案');
        assert.equal(calls.length, 1);
        assert.equal(readSaved('rectool', keyOf(o2, undefined)).response.text, '新答案');
    });

    test('向量（EMBED_RECORD_ONLY_MISSING=1）：向量檔已有的照 fixture 回傳、只把缺的送去算並併入；全部都有就不呼叫', async (t) => {
        quiet(t);
        const dim = 768;
        const model = process.env.EMBED_MODEL;
        const file = llmFixture.fixturePath(model, dim);
        llmFixture.saveToFixture({ model, dim, entries: [[llmFixture.sha256Hex('已有的一段'), fakeVector('已有的一段')]] });
        process.env.EMBED_MODE = 'record';
        process.env.EMBED_RECORD_ONLY_MISSING = '1';
        const calls = installOllama((url, payload) => ({ status: 200, text: JSON.stringify({ embeddings: payload.input.map(s => fakeVector(s, payload.dimensions)) }) }));
        const res = await llm.embed({ texts: ['已有的一段', '缺的一段'], dim });
        assert.deepEqual(calls.map(c => c.payload.input), [['缺的一段']], '只送缺的');
        const table = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(table[llmFixture.sha256Hex('缺的一段')], '缺的那一段併進向量檔');
        // 已有的那一段：與 EMBED_MODE=fixture 回放時拿到的向量相同
        process.env.EMBED_MODE = 'fixture';
        const fromFixture = await llm.embed({ texts: ['已有的一段', '缺的一段'], dim });
        assert.deepEqual(res.vectors[0], fromFixture.vectors[0]);
        assert.equal(res.vectors[1].length, dim);

        process.env.EMBED_MODE = 'record';
        forbidOllama();
        const all = await llm.embed({ texts: ['缺的一段', '已有的一段'], dim });
        assert.deepEqual(all.usage, { tokenIn: 0 });
        assert.deepEqual(all.vectors[1], fromFixture.vectors[0]);
    });

    test('只認 1／true；其他模式不讀這兩個變數', () => {
        assert.equal(llm.llmRecordOnlyMissing({ LLM_RECORD_ONLY_MISSING: '1' }), true);
        assert.equal(llm.llmRecordOnlyMissing({ LLM_RECORD_ONLY_MISSING: 'TRUE' }), true);
        assert.equal(llm.llmRecordOnlyMissing({ LLM_RECORD_ONLY_MISSING: 'yes' }), false);
        assert.equal(llm.llmRecordOnlyMissing({}), false);
        assert.equal(llm.embedRecordOnlyMissing({ EMBED_RECORD_ONLY_MISSING: '1' }), true);
        assert.equal(llm.embedRecordOnlyMissing({ EMBED_RECORD_ONLY_MISSING: '' }), false);
    });
});

// ───────────────────────── 4. variant eval 端到端（Owner 2026-09-27～28 的兩筆） ─────────────────────────

describe('variant eval：逾時與截斷錄成錯誤回放檔 → 回放記成失敗、不是 miss；只補缺的只重打那兩筆', () => {
    const suite = require('../../eval/lib/suiteVariant');
    const { loadFixture } = require('../../eval/lib/fixtures');
    const { buildEmbedText } = require('../../utils/embedText');
    const fixture = loadFixture();
    const emb = { vectorOf: (q) => fakeVector(buildEmbedText(q)) };
    const GOLDEN = {
        entries: [{
            id: 'var-006', source_question_id: 11, subject: '數學', chapter: '向量內積', difficulty: 3,
            question_type: '計算', expect: { min_retrieved: 2 }, needs_human_confirm: false
        }]
    };
    // 第 2 題：零成本閘門直接過的一般變式（與 evalVariantEmbedRecord.test.js 相同）
    const VARIANT_PLAIN = {
        chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
        question_text: '一艘船的航行向量為 $\\vec{u} = (4, 3)$，海流向量為 $\\vec{w} = (0, 5)$，求兩向量夾角的餘弦值 $\\cos \\phi$。',
        answer_text: '$\\cos \\phi = \\frac{15}{5 \\times 5} = \\frac{3}{5}$'
    };
    const isVariant = (p) => p.messages[0].content.startsWith('你是一位資深的台灣高中數學與物理家教老師');
    const isVerify = (p) => p.messages[0].content.startsWith('你是高中數學與物理的解題老師');

    /** 錄製時的模型：第 1 題的變式生成卡住到逾時（var-008#1）、第 2 題的驗算寫到上限被截斷（var-015#1） */
    function owners(url, payload, opts) {
        if (url.endsWith('/api/embed')) {
            return { status: 200, text: JSON.stringify({ embeddings: payload.input.map(s => fakeVector(s, payload.dimensions)) }) };
        }
        if (isVariant(payload)) {
            if (payload.messages[1].content.includes('第 1 題（共 2 題）')) return hang(opts);
            return chatReply(payload, VARIANT_PLAIN);
        }
        if (isVerify(payload)) return chatReply(payload, '{"final_answer":"$\\\\frac{3}{5}$","answer_form":"expression","steps_summary":"先算內積', 'length');
        throw new Error(`假 Ollama：沒預期的 /api/chat（${payload.messages[0].content.slice(0, 20)}）`);
    }

    async function runOnce() {
        const failures = [];
        const warnings = [];
        const res = await suite.runGeneration({ golden: GOLDEN, fixture, emb, offtopicSimMin: -1, generateFn: null, failures, warnings, agentOverrides: {} });
        return { ...res, failures, warnings };
    }

    /** 第 idx 題變式生成的回放檔（鍵含錨點鄰居，照檔案裡記的 cacheKeyParts 找） */
    const variantFile = (idx) => {
        const d = path.join(process.env.EVAL_CASSETTE_DIR, 'variant');
        const hit = fs.readdirSync(d).filter(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).request.cacheKeyParts.idx === idx);
        assert.equal(hit.length, 1, `第 ${idx} 題的變式回放檔應該恰好一支：${hit.join('、')}`);
        return path.join(d, hit[0]);
    };

    let recorded;
    let verifyFile;
    before(async () => {
        // 這一組用自己的目錄（前面幾組的 rectool 回放檔不影響，但 variant 的鍵要乾淨）
        process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'variant-cassettes');
        process.env.EMBED_FIXTURE_DIR = path.join(tmpDir, 'variant-fixtures');
    });
    after(() => {
        process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');
        process.env.EMBED_FIXTURE_DIR = path.join(tmpDir, 'fixtures');
    });

    test('錄製（完整重錄）：第 1 題生成逾時、第 2 題驗算被截斷 → 兩支錯誤回放檔；suite 不當掉、不進 failures，分數照算', async (t) => {
        quiet(t);
        process.env.LLM_MODE = 'record';
        process.env.EMBED_MODE = 'record';
        process.env.OLLAMA_TIMEOUT_MS = '60';
        installOllama(owners);
        recorded = await runOnce();
        assert.deepEqual(recorded.failures, [], recorded.failures.join('\n'));
        assert.equal(recorded.generations, 2);
        assert.equal(recorded.rate, 0, '兩題都沒通過：第 1 題沒生出來、第 2 題驗算被截斷');
        assert.deepEqual(recorded.counts, { text_gate: 1, off_topic: 1, classify: 1, lint: 1, verify: 0, dedup1: 0 });
        assert.deepEqual(recorded.recordedErrors.map(r => [r.at, r.node, r.agent, r.kind]), [
            ['var-006#1', 'generate', 'variant', 'timeout'],
            ['var-006#2', 'verify', 'verify', 'truncated']
        ]);
        assert.equal(recorded.byEntry.get('var-006').stoppedAt, 'generate');
        assert.ok(recorded.warnings.some(w => w.startsWith('var-006#1：變式生成的呼叫單次逾時')), recorded.warnings.join('\n'));

        const v1 = JSON.parse(fs.readFileSync(variantFile(1), 'utf8'));
        assert.equal(v1.response.error.kind, 'timeout');
        const v2 = JSON.parse(fs.readFileSync(variantFile(2), 'utf8'));
        assert.equal(v2.response.error, undefined, '第 2 題是一般回放檔');
        assert.deepEqual(v2.request.cacheKeyParts.siblings, [], '第 1 題沒生出來，第 2 題的兄弟是空的（與 Owner 那一次相同）');
        const verifyDir = path.join(process.env.EVAL_CASSETTE_DIR, 'verify');
        const vf = fs.readdirSync(verifyDir);
        assert.equal(vf.length, 1);
        verifyFile = path.join(verifyDir, vf[0]);
        assert.equal(JSON.parse(fs.readFileSync(verifyFile, 'utf8')).response.error.kind, 'truncated');
    });

    test('回放（CI 的設定）：不呼叫模型、零 miss、數字與錄製時相同', async () => {
        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'fixture';
        forbidOllama();
        const replayed = await runOnce();
        assert.deepEqual(replayed.failures, []);
        assert.equal(replayed.rate, recorded.rate);
        assert.deepEqual(replayed.counts, recorded.counts);
        assert.deepEqual(replayed.recordedErrors, recorded.recordedErrors);
    });

    test('對照（改之前的狀況）：兩支錯誤回放檔不在 → 回放是 2 筆 replay miss、gate_pass_rate n/a', async () => {
        const v1 = variantFile(1);
        const saved = { [v1]: fs.readFileSync(v1), [verifyFile]: fs.readFileSync(verifyFile) };
        fs.unlinkSync(v1);
        fs.unlinkSync(verifyFile);
        try {
            process.env.LLM_MODE = 'replay';
            process.env.EMBED_MODE = 'fixture';
            forbidOllama();
            const res = await runOnce();
            assert.equal(res.rate, null);
            assert.equal(res.failures.filter(f => replayMiss.isReplayMiss(f)).length, 2);
        } finally {
            for (const [f, b] of Object.entries(saved)) fs.writeFileSync(f, b);
        }
    });

    test('只補錄缺的：刪掉那兩支再補錄 → 只重打那 2 次（生成、驗算），其他回放檔一個位元都沒動、向量不重算', async (t) => {
        const logs = quiet(t);
        const dir = process.env.EVAL_CASSETTE_DIR;
        const snapshot = () => {
            const out = {};
            for (const a of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, a))) out[`${a}/${f}`] = fs.readFileSync(path.join(dir, a, f), 'utf8');
            return out;
        };
        const v1 = variantFile(1);
        fs.unlinkSync(v1);
        fs.unlinkSync(verifyFile);
        const others = snapshot();
        const embedFile = llmFixture.fixturePath(process.env.EMBED_MODEL, 768);
        const embedBefore = fs.readFileSync(embedFile);

        process.env.LLM_MODE = 'record';
        process.env.EMBED_MODE = 'record';
        process.env.LLM_RECORD_ONLY_MISSING = '1';
        process.env.EMBED_RECORD_ONLY_MISSING = '1';
        process.env.OLLAMA_TIMEOUT_MS = '60';
        const calls = installOllama(owners);
        const filled = await runOnce();
        assert.deepEqual(calls.map(c => (c.url.endsWith('/api/embed') ? 'embed' : isVariant(c.payload) ? 'variant' : isVerify(c.payload) ? 'verify' : '?')),
            ['variant', 'verify'], '只打缺的兩次');
        assert.deepEqual(filled.failures, []);
        assert.equal(filled.rate, recorded.rate);
        const after = snapshot();
        for (const [k, v] of Object.entries(others)) assert.equal(after[k], v, `${k} 不得被覆寫`);
        assert.equal(Object.keys(after).length, Object.keys(others).length + 2, '多出來的就是補錄的兩支');
        assert.ok(fs.readFileSync(embedFile).equals(embedBefore), '向量檔沒有變');
        assert.ok(logs.some(l => l.startsWith('[llm:record] 寫入錯誤回放檔（單次逾時）')), logs.join('\n'));
        assert.ok(logs.some(l => l.startsWith('[llm:record] 寫入錯誤回放檔（被截斷）')), logs.join('\n'));

        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'fixture';
        forbidOllama();
        const replayed = await runOnce();
        assert.deepEqual(replayed.failures, []);
        assert.equal(replayed.rate, recorded.rate);
        assert.deepEqual(replayed.counts, recorded.counts);
    });

    test('連不上這類錯誤照舊進 failures（不是錯誤回放檔、不是 miss）', async () => {
        const failures = [];
        const warnings = [];
        await suite.runGeneration({
            golden: GOLDEN, fixture, emb, offtopicSimMin: -1, failures, warnings, agentOverrides: {},
            generateFn: async () => ({ kind: 'error', errorClass: 'provider_error', message: 'Ollama 沒有在執行' })
        });
        assert.deepEqual(failures, ['var-006#1：Ollama 沒有在執行', 'var-006#2：Ollama 沒有在執行']);
    });
});

// ───────────────────────── 5. 盤點、清除與報表 ─────────────────────────

describe('盤點與清除：錯誤回放檔分開算、不當成孤兒', () => {
    const probe = require('../../eval/lib/cassetteProbe');
    const audit = require('../../eval/lib/cassetteAudit');
    const prune = require('../../eval/tools/prune_cassettes');
    const { formatSummary } = require('../../eval/lib/cassettePlan');
    const { ALL_SUITES } = require('../../eval/lib/suiteProcess');
    // 探針在行程結束時還會寫一行（process.on('exit')），所以紀錄目錄不放在 tmpDir（after 會先刪掉它），
    // 另開一個，並在探針的 exit 之後才刪（同一個事件的監聽依註冊順序執行）
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-rectool-probe-'));
    const dir = path.join(tmpDir, 'audit-cassettes');

    let normalKey;
    let errorKey;
    let orphanErrorKey;
    before(() => {
        process.env.EVAL_CASSETTE_DIR = dir;
        const write = (key, response, parts) => {
            fs.mkdirSync(path.join(dir, 'verify'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'verify', `${key}.json`), JSON.stringify({
                meta: { agent: 'verify', model: 'qwen3:8b', template: 'verify.v1' },
                request: { parts: [], cacheKeyParts: parts }, response
            }), 'utf8');
        };
        require('../../agents/verify');
        const k = (parts) => cassette.cassetteKey({ agent: 'verify', modelId: 'qwen3:8b', template: 'verify.v1', schema: buildSchema('verify'), cacheKeyParts: parts });
        normalKey = k({ n: 1 });
        errorKey = k({ n: 2 });
        orphanErrorKey = k({ n: 3 });
        write(normalKey, { data: { final_answer: '1', answer_form: 'number', steps_summary: 's' }, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 } }, { n: 1 });
        write(errorKey, { error: { kind: 'truncated', name: 'SyntaxError', message: 'Unexpected end of JSON input', errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' }, usage: null, latencyMs: 5 }, { n: 2 });
        write(orphanErrorKey, { error: { kind: 'timeout', name: 'Error', message: '逾時', errorClass: 'timeout', finishReason: null, elapsedMs: 9 } }, { n: 3 });
        probe.install(probeDir);
        process.on('exit', () => fs.rmSync(probeDir, { recursive: true, force: true }));
    });
    after(() => { process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes'); });

    test('探針：錯誤回放檔記成「有被讀到」＋errorCassette；summarize 另外算，不算進命中，也不在沒被讀到的清單', async () => {
        process.env.EVAL_PROBE_SUITE = 'classify';
        const base = { model: 'ollama:qwen3:8b', agent: 'verify', template: 'verify.v1', schema: buildSchema('verify'), parts: [{ text: 'x' }] };
        try {
            await llm.generateJson({ ...base, cacheKeyParts: { n: 1 } });
            await assert.rejects(llm.generateJson({ ...base, cacheKeyParts: { n: 2 } }), (err) => err.finishReason === 'MAX_TOKENS');
            await assert.rejects(llm.generateJson({ ...base, cacheKeyParts: { n: 4 } }), (err) => replayMiss.isReplayMiss(err));
        } finally {
            delete process.env.EVAL_PROBE_SUITE;
        }
        const events = probe.readProbeDir(probeDir).filter(e => e.kind === 'llm');
        assert.deepEqual(events.map(e => [e.key === errorKey, e.hit, e.errorCassette || null]), [[false, true, null], [true, true, 'truncated'], [false, false, null]]);

        const inv = audit.inventory(dir);
        assert.deepEqual(inv.entries.map(e => e.errorCassette || null).sort(), [null, 'timeout', 'truncated']);
        const entries = audit.auditKeys(inv.entries);
        assert.ok(entries.every(e => e.keyValid), '錯誤回放檔的鍵照同一條公式重算得出來');
        const suites = ALL_SUITES;
        const all = [...ALL_SUITES.map(s => ({ suite: s, kind: 'start' })),
            ...events,
            // 其他 suite 各讀一次正常的那一支，pruneGuard 才不會因「一筆回放紀錄都沒有」擋下來
            ...['pipeline', 'nlq', 'variant', 'e2e'].map(s => ({ suite: s, kind: 'llm', agent: 'verify', model: 'qwen3:8b', key: normalKey, hit: true }))];
        const s = audit.summarize({ events: all, entries, suites, runs: {} });
        const c = s.suites.classify;
        assert.equal(c.hits, 1, '命中只算正常的');
        assert.equal(c.errorHits, 1);
        assert.equal(c.misses, 1);
        assert.equal(c.llmCalls, 3);
        assert.deepEqual(c.errorKeys, [`verify/${errorKey}`]);
        assert.equal(c.byAgent.verify.errorHits, 1);
        assert.deepEqual(c.errors, [], '不是 miss 以外的錯誤');
        assert.deepEqual(s.errorCassettes.total, 2);
        assert.deepEqual(s.errorCassettes.hit, 1);
        assert.deepEqual(s.unhit.map(u => [u.key === orphanErrorKey, u.errorCassette || null]), [[true, 'timeout']],
            '被讀到的錯誤回放檔不是孤兒；這一輪沒讀到的那一支照一般規則列出、標出是錯誤回放檔');

        // prune 的保護條件：只剩「還有 replay miss」這一條（錯誤回放檔不算錯誤）
        const guard = prune.pruneGuard({ summary: s, suites });
        assert.equal(guard.length, 1, guard.join('\n'));
        assert.match(guard[0], /還有 1 筆 replay miss/);
        assert.deepEqual(prune.pruneGuard({ summary: s, suites, allowMisses: true }), []);

        const text = formatSummary({ summary: s, inventory: inv, models: { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', source: 'test' } }, { env: {} });
        assert.match(text, /\| suite \| 有跑 \| 命中 \| 錯誤回放檔 \| 缺 cassette \|/);
        assert.ok(text.split('\n').some(l => l.startsWith('| classify | 是 | 1 | 1 | 1 |')), text);
        assert.match(text, /錯誤回放檔（錄製當時被截斷或單次逾時；回放照樣丟那個錯、記成失敗，不是正常命中）：範圍內 2 支，這一輪被讀到 1 支/);
        assert.match(text, /verify 命中 \d+／缺 1／錯誤回放檔 1/);
    });

    test('只補缺的粗估：只算缺的與它們擋住的閘門；完整重錄連命中與錯誤回放檔一起算', () => {
        const local = require('../../eval/lib/localMode');
        const summary = {
            suites: {
                variant: {
                    byAgent: { variant: { hits: 58, misses: 1 }, verify: { hits: 30, misses: 1, errorHits: 1 } },
                    missKeys: ['variant/a', 'verify/b'], embed: { hits: 100, misses: 0 }
                }
            },
            embeddings: { missing: 0 }, unhit: [{ agent: 'classify', previousVersion: false }]
        };
        const env = {};
        const S = local.SEC_PER_CALL;
        const om = local.estimateLocalTime(summary, { env, onlyMissing: true });
        assert.equal(om.lowerSec, S.variant + S.verify);
        assert.equal(om.upperSec, om.lowerSec + S.classify + S.lint + S.verify, '生成 miss 之後的分類、lint、驗算');
        const full = local.estimateLocalTime(summary, { env });
        assert.equal(full.lowerSec, 59 * S.variant + 32 * S.verify + 100 * local.DEFAULT_SEC_PER_EMBED);
        assert.equal(full.upperSec, full.lowerSec + S.classify);
    });

    test('npm run perf:local：逾時的錯誤回放檔沒有 latencyMs，不算進速度；被截斷的有用量與時間，照一般呼叫算', () => {
        const perf = require('../../eval/tools/local_perf_report');
        const doc = (response) => ({ meta: { agent: 'verify', model: 'qwen3:8b', recorded_at: '2026-10-01T00:00:00Z' }, request: { parts: [], cacheKeyParts: {} }, response });
        const timeout = perf.toEntry(doc(cassette.errorResponse(Object.assign(new Error('逾時'), { errorClass: 'timeout' }), 'timeout', { elapsedMs: 5400000 })));
        const trunc = perf.toEntry(doc(cassette.errorResponse(Object.assign(new SyntaxError('x'), {
            errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS', usage: { tokenIn: 300, tokenOut: 3072, tokenThinking: 0, tokenCached: 0 }
        }), 'truncated', { elapsedMs: 1500000 })));
        assert.equal(timeout.latencyMs, null);
        assert.equal(timeout.usage, null);
        assert.equal(trunc.latencyMs, 1500000);
        assert.equal(trunc.usage.tokenOut, 3072);
        const { selected, skipped } = perf.selectEntries([timeout, trunc], { vendor: 'ollama' });
        assert.deepEqual(selected, [trunc]);
        assert.equal(skipped.noLatency, 1);
    });

    test('eval 報表：讀到錯誤回放檔才多一欄 error_cassettes 與一行 ⚠️；沒有時與之前相同', (t) => {
        const report2 = require('../../eval/lib/report2');
        const out = [];
        t.mock.method(console, 'log', (m) => out.push(String(m)));
        const res = { suite: 'variant', measured: { variant: { retrieved_coverage: 0.5, gate_pass_rate: 0 } }, warnings: [], meta: { sources: {}, cassetteDir: 'x' } };
        const repDir = path.join(tmpDir, 'reports');
        cassette._resetErrorCassettesForTest();
        const plain = report2.emit({ res, dir: repDir });
        assert.equal('error_cassettes' in plain.doc, false);
        cassette.noteErrorCassette({ agent: 'variant', key: 'a'.repeat(64), kind: 'timeout', errorClass: 'timeout', finishReason: null, source: 'replay' });
        cassette.noteErrorCassette({ agent: 'variant', key: 'a'.repeat(64), kind: 'timeout', errorClass: 'timeout', finishReason: null, source: 'replay' });
        const withErr = report2.emit({ res, dir: repDir });
        assert.equal(withErr.doc.error_cassettes.count, 1, '同一支只記一次');
        assert.equal(withErr.doc.error_cassettes.items[0].kind, 'timeout');
        assert.ok(out.join('\n').includes('⚠️ 錯誤回放檔 1 支'), out.join('\n'));
        assert.deepEqual(JSON.parse(fs.readFileSync(withErr.file, 'utf8')).error_cassettes, withErr.doc.error_cassettes);
    });
});

// ───────────────────────── 6. 重錄工具的參數、子行程環境與說明 ─────────────────────────

describe('npm run cassettes:rerecord -- --only-missing', () => {
    const rerecord = require('../../eval/tools/rerecord_all');
    const sp = require('../../eval/lib/suiteProcess');
    const local = require('../../eval/lib/localMode');
    const LOCAL_CI = { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', EMBED_MODEL: 'ollama:qwen3-embedding:0.6b', source: 'test' };

    test('parseArgs：--only-missing；預設是完整重錄', () => {
        assert.equal(rerecord.parseArgs([]).onlyMissing, false);
        assert.equal(rerecord.parseArgs(['--suites', 'variant', '--only-missing']).onlyMissing, true);
        assert.deepEqual(rerecord.parseArgs(['--suites', 'variant', '--only-missing']).suites, ['variant']);
        assert.equal(rerecord.parseArgs(['--only-missing', '--dry-run', '--json']).onlyMissing, true);
        assert.match(rerecord.USAGE, /--only-missing {5}只補錄缺的/);
    });

    test('stepExtraEnv：main 一律明寫兩個開關（有 --only-missing＝1，沒有＝空字串），不看 .env', () => {
        const plan = local.recordingPlan({ models: LOCAL_CI, suites: ['variant'] });
        const step = rerecord.recordSteps({ suites: ['variant'] }).find(s => s.name === 'variant');
        assert.deepEqual(
            [rerecord.stepExtraEnv(step, plan, {}, { onlyMissing: true }).LLM_RECORD_ONLY_MISSING, rerecord.stepExtraEnv(step, plan, {}, { onlyMissing: true }).EMBED_RECORD_ONLY_MISSING],
            ['1', '1']);
        assert.deepEqual(
            [rerecord.stepExtraEnv(step, plan, {}, { onlyMissing: false }).LLM_RECORD_ONLY_MISSING, rerecord.stepExtraEnv(step, plan, {}, { onlyMissing: false }).EMBED_RECORD_ONLY_MISSING],
            ['', '']);
        assert.equal('LLM_RECORD_ONLY_MISSING' in rerecord.stepExtraEnv(step, plan, {}), false, '沒給 opts 時與之前相同');
    });

    test('suiteProcess：錄製時放行（RECORD_PASS_THROUGH），回放時擋成空字串', () => {
        assert.ok(sp.RECORD_MODE_KEYS.every(k => sp.RECORD_PASS_THROUGH.includes(k)));
        const base = { LLM_RECORD_ONLY_MISSING: '1', EMBED_RECORD_ONLY_MISSING: '1' };
        const rec = sp.ciEnv({ llmMode: 'record', embedMode: 'record', base, envFileKeys: [], models: LOCAL_CI });
        assert.equal(rec.LLM_RECORD_ONLY_MISSING, '1');
        assert.equal(rec.EMBED_RECORD_ONLY_MISSING, '1');
        const rep = sp.ciEnv({ llmMode: 'replay', embedMode: 'fixture', base, envFileKeys: [], models: LOCAL_CI });
        assert.equal(rep.LLM_RECORD_ONLY_MISSING, '');
        assert.equal(rep.EMBED_RECORD_ONLY_MISSING, '');
        // rerecord 的 extra 最後蓋：.env 寫了 1，沒加 --only-missing 仍是完整重錄
        const plan = local.recordingPlan({ models: LOCAL_CI, suites: ['variant'] });
        const step = rerecord.recordSteps({ suites: ['variant'] }).find(s => s.name === 'variant');
        const full = sp.ciEnv({ llmMode: 'record', embedMode: 'record', base, envFileKeys: Object.keys(base), models: LOCAL_CI, extra: rerecord.stepExtraEnv(step, plan, {}, { onlyMissing: false }) });
        assert.equal(full.LLM_RECORD_ONLY_MISSING, '');
    });

    test('main：--only-missing 時每一個錄製子行程都帶 1；沒加時都是空字串（即使 shell 設了 1）；問 yes 前印錄製方式', async (t) => {
        const out = [];
        t.mock.method(console, 'log', (m) => out.push(String(m)));
        const audit = require('../../eval/lib/cassetteAudit');
        const events = [{ suite: 'variant', kind: 'start' },
            { suite: 'variant', kind: 'llm', agent: 'variant', model: 'qwen3:8b', key: 'k1', hit: true },
            { suite: 'variant', kind: 'llm', agent: 'variant', model: 'qwen3:8b', key: 'k2', hit: false },
            { suite: 'variant', kind: 'llm', agent: 'verify', model: 'qwen3:8b', key: 'k3', hit: true, errorCassette: 'truncated' }];
        const analysis = () => ({
            runs: { variant: { exitCode: 0, tail: [], reportFiles: [] } }, events,
            inventory: { dir: path.join(tmpDir, 'x'), entries: [], skipped: [] },
            summary: audit.summarize({ events, entries: [], suites: ['variant'], runs: { variant: { exitCode: 0 } } }),
            models: LOCAL_CI
        });
        const runs = [];
        const deps = {
            readCiModels: () => LOCAL_CI, analyze: async () => analysis(), askYes: async () => true,
            checkOllama: async () => ({ ok: true }), checkOcr: async () => ({ ok: true }), checkTestDbSchema: async () => ({ ok: true }),
            runNode: async (o) => { runs.push(o); return { exitCode: 0, ms: 1, tail: [], reportFiles: [] }; }
        };
        const saved = { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, LLM_RECORD_ONLY_MISSING: process.env.LLM_RECORD_ONLY_MISSING };
        process.env.TEST_DATABASE_URL = 'postgres://x/y_test';
        process.env.LLM_RECORD_ONLY_MISSING = '1';
        try {
            assert.equal(await rerecord.main(['--suites', 'variant', '--only-missing', '--skip-verify'], deps), 0);
            assert.ok(runs.length >= 2);
            assert.ok(runs.every(r => r.env.LLM_RECORD_ONLY_MISSING === '1' && r.env.EMBED_RECORD_ONLY_MISSING === '1'));
            const text = out.join('\n');
            assert.match(text, /錄製方式：只補錄缺的（--only-missing）——命中 1 次與錯誤回放檔 1 次照回放、不呼叫模型、不覆寫；只呼叫「缺 cassette」那 1 次/);
            assert.match(text, /只補缺的粗估：約/);
            assert.match(text, /；只補錄缺的（--only-missing）/);

            runs.length = 0;
            out.length = 0;
            assert.equal(await rerecord.main(['--suites', 'variant', '--skip-verify'], deps), 0);
            assert.ok(runs.every(r => r.env.LLM_RECORD_ONLY_MISSING === '' && r.env.EMBED_RECORD_ONLY_MISSING === ''), 'shell 的 1 不會把完整重錄變成只補缺的');
            assert.match(out.join('\n'), /錄製方式：完整重錄（沒加 --only-missing）——上表的每一次呼叫（命中 1、錯誤回放檔 1、缺 1）都重新呼叫模型並覆寫回放檔/);
        } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    });

    test('--dry-run --json：帶 onlyMissing 與只補缺的粗估；回放驗證表最後一欄是錯誤回放檔（不算 miss）', async (t) => {
        const out = [];
        t.mock.method(console, 'log', (m) => out.push(String(m)));
        const audit = require('../../eval/lib/cassetteAudit');
        const events = [{ suite: 'variant', kind: 'start' }, { suite: 'variant', kind: 'llm', agent: 'verify', model: 'qwen3:8b', key: 'k3', hit: true, errorCassette: 'truncated' }];
        const analysis = {
            runs: { variant: { exitCode: 0, tail: [], reportFiles: [] } }, events,
            inventory: { dir: path.join(tmpDir, 'x'), entries: [], skipped: [] },
            summary: audit.summarize({ events, entries: [], suites: ['variant'], runs: { variant: { exitCode: 0 } } }), models: LOCAL_CI
        };
        const deps = { readCiModels: () => LOCAL_CI, analyze: async () => analysis };
        assert.equal(await rerecord.main(['--dry-run', '--json', '--suites', 'variant', '--only-missing'], deps), 0);
        const doc = JSON.parse(out.join('\n'));
        assert.equal(doc.onlyMissing, true);
        assert.ok(doc.local.estimateSecOnlyMissing.upper >= doc.local.estimateSecOnlyMissing.lower);
        assert.equal(doc.summary.suites.variant.errorHits, 1);

        const v = rerecord.verifyReport(analysis);
        assert.equal(v.lines[0], '| suite | 結束碼 | replay miss | 缺向量 | 門檻 | 錯誤回放檔 |');
        assert.ok(v.lines.some(l => l.startsWith('| variant | 0 | 0 | 0 |') && l.endsWith('| 1 |')), v.lines.join('\n'));
        assert.equal(v.missTotal, 0);
        assert.equal(v.errorCassetteTotal, 1);
    });
});

// ───────────────────────── 7. record_local.bat ─────────────────────────

describe('scripts/windows/record_local.bat 把 --only-missing 傳下去', () => {
    const text = fs.readFileSync(path.join(APP_DIR, 'scripts', 'windows', 'record_local.bat'), 'utf8');
    const lines = text.split('\r\n');

    test('suite 後面接 --only-missing：原本那一行照舊把 %* 接成 --suites（rerecord 會把 --only-missing 當旗標）', () => {
        assert.ok(lines.includes('if not "%~1"=="" set "SUITES=-- --suites %*"'));
        assert.deepEqual(rerecord().parseArgs(['--suites', 'variant', '--only-missing']).suites, ['variant']);
        assert.equal(rerecord().parseArgs(['--suites', 'classify,nlq', '--only-missing']).onlyMissing, true);
    });

    test('只寫 --only-missing（全部 suite）：不接成 --suites', () => {
        const at = lines.indexOf('if /i "%~1"=="--only-missing" set "SUITES=-- %*"');
        assert.ok(at > lines.indexOf('if not "%~1"=="" set "SUITES=-- --suites %*"'), '要在原本那一行之後蓋過去');
        assert.ok(at < lines.indexOf('echo yes| %TEE% npm run cassettes:rerecord %SUITES%'));
        assert.equal(rerecord().parseArgs(['--only-missing']).onlyMissing, true);
    });

    test('〔審查〕--only-missing 寫在 suite 前面：在動資料庫之前擋下、印出正確寫法（不會組成 -- --only-missing variant）', () => {
        const guard = 'if /i "%~1"=="--only-missing" if not "%~2"=="" goto :bad_order';
        const at = lines.indexOf(guard);
        assert.ok(at > 0, '要有這一行');
        assert.ok(at < lines.indexOf('cd /d "%~dp0..\\.."'), '在最前面（還沒寫 log、還沒 db:up）');
        assert.ok(at < lines.indexOf('%TEE% npm run db:up'));
        const label = lines.indexOf(':bad_order');
        assert.ok(label > lines.indexOf('echo yes| %TEE% npm run cassettes:rerecord %SUITES%'), '標籤在子程序區');
        const body = lines.slice(label, lines.indexOf('exit /b 1', label) + 1);
        assert.ok(body.some(l => l.startsWith('echo') && l.includes('record_local.bat variant --only-missing')), body.join('\n'));
        assert.ok(body.some(l => l.startsWith('echo') && l.includes('record_local.bat classify,nlq --only-missing')));
        assert.ok(!body.some(l => l.includes('%LOG%')), '這時還沒有 log 檔');
        assert.equal(body[body.length - 1], 'exit /b 1');
        // 沒有這一道時 rerecord_all.js 收到的就是這樣：會被當成未知的參數（這一道擋的就是它）
        assert.throws(() => rerecord().parseArgs(['--only-missing', 'variant']), /未知的參數「variant」/);
    });

    test('說明與失敗提示寫到 --only-missing 與錯誤回放檔', () => {
        assert.ok(lines.includes('REM  只補錄缺的：suite 後面加 --only-missing，例  record_local.bat variant --only-missing'));
        assert.ok(lines.some(l => l.startsWith('echo') && l.includes('record_local.bat variant --only-missing')));
        assert.ok(lines.some(l => l.startsWith('echo') && l.includes('錯誤回放檔')));
    });

    function rerecord() { return require('../../eval/tools/rerecord_all'); }
});
