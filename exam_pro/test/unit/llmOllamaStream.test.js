// services/llm/ollama.js 的分段時間（usage.timing）與串流進度（〔看圖拆題逾時〕docs/local-mode.md 第 10.11 條）
//
// 證明三件事：
//   1. usage.timing：Ollama 回應帶 *_duration（奈秒）時換成毫秒；沒帶就與之前逐位元相同（不多一個鍵）。
//   2. 串流（OLLAMA_PROGRESS_MS／progressMs）：送 stream:true、邊收邊印進度，最後組回來的 data／usage／raw
//      與 stream:false **完全相同**；record 模式寫出的 cassette（鍵、request、response.data／usage）也相同。
//   3. 預設（沒設 OLLAMA_PROGRESS_MS）照舊 stream:false、不印任何進度。
// 全部用假的傳輸或 127.0.0.1 上的假伺服器：不連 Ollama。cassette 寫到系統暫存目錄。
//
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ollama = require('../../services/llm/ollama');
const throttle = require('../../services/llm/throttle');
const cassette = require('../../services/llm/cassette');
const fake = require('../../services/llm/fake');
const llm = require('../../services/llm');
const { buildSchema } = require('../../agents/schemas');

const ENV_KEYS = [
    'LLM_MODE', 'EMBED_MODE', 'EVAL_CASSETTE_DIR', 'MODEL_EXTRACT', 'MODEL_VERIFY', 'OLLAMA_HOST',
    'OLLAMA_CONCURRENCY', 'OLLAMA_RPM', 'OLLAMA_TIMEOUT_MS', 'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_PROGRESS_MS'
];
const envBackup = {};
let tmpDir;

before(() => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-ollama-stream-'));
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    ollama._resetForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');
    ollama._resetForTest();
    throttle._resetForTest();
    fake._resetForTest();
});

const SEC_NS = 1e9;
/** done:true 那一行（與 stream:false 的回應共用的欄位；時間是奈秒） */
const DONE_FIELDS = Object.freeze({
    model: 'qwen3-vl:8b', created_at: '2026-09-26T08:00:00.000Z', done: true, done_reason: 'stop',
    total_duration: 1_650.4 * SEC_NS, load_duration: 12.3456 * SEC_NS,
    prompt_eval_count: 1234, prompt_eval_duration: 612 * SEC_NS,
    eval_count: 45, eval_duration: 1_020.5 * SEC_NS
});
const THINKING = '先看第一題，再看第二題……';
const CONTENT = '{"questions":[{"subject":"數學","question_text":"求 $\\\\vec{a}\\\\cdot\\\\vec{b}$"}],"note":"中文與 emoji 🙂"}';

/** 把字串切成 n 字一段（模擬 Ollama 一個 token 一行） */
function pieces(s, n = 3) {
    const out = [];
    const chars = [...s];
    for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''));
    return out;
}

/** stream:true 的整段本文（NDJSON）：思考片段 → 回覆片段 → done:true */
function ndjson({ thinking = THINKING, content = CONTENT, done = DONE_FIELDS } = {}) {
    const base = { model: done.model, created_at: done.created_at, done: false };
    const lines = [
        ...(thinking ? pieces(thinking).map(p => ({ ...base, message: { role: 'assistant', content: '', thinking: p } })) : []),
        ...pieces(content).map(p => ({ ...base, message: { role: 'assistant', content: p } })),
        { ...done, message: { role: 'assistant', content: '' } }
    ];
    return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

/** stream:false 的回應 */
function whole({ thinking = THINKING, content = CONTENT, done = DONE_FIELDS } = {}) {
    return { ...done, message: { role: 'assistant', content, ...(thinking ? { thinking } : {}) } };
}

/**
 * 假的傳輸：依 payload.stream 回整段 JSON 或 NDJSON；串流時把本文切成 7 字一段餵給 onData（會切在一行的中間）。
 * gap：每段之間等幾毫秒（測進度計時器用）。
 */
function fakeOllama({ thinking = THINKING, content = CONTENT, gap = 0, firstDelay = 0, override } = {}) {
    const calls = [];
    ollama._setTransportForTest(async (url, payload, opts) => {
        calls.push({ url, payload: JSON.parse(JSON.stringify(payload)), hasOnData: typeof opts.onData === 'function' });
        if (override) {
            const r = await override(url, payload, opts);
            if (r) return r;
        }
        if (payload.stream !== true) return { status: 200, text: JSON.stringify(whole({ thinking, content })) };
        const text = ndjson({ thinking, content });
        if (firstDelay) await new Promise(r => setTimeout(r, firstDelay));
        if (opts.onData) {
            for (let i = 0; i < text.length; i += 7) {
                opts.onData(text.slice(i, i + 7));
                if (gap) await new Promise(r => setTimeout(r, gap));
            }
        }
        return { status: 200, text };
    });
    return calls;
}

const quiet = () => {};

// ───────────────────────── usage.timing ─────────────────────────

describe('usage.timing（Ollama 的分段時間 → 毫秒）', () => {
    test('四段都有：奈秒換成毫秒、四捨五入；token 欄位照舊', () => {
        const u = ollama.usageOf(DONE_FIELDS);
        assert.deepEqual(u, {
            tokenIn: 1234, tokenOut: 45, tokenThinking: 0, tokenCached: 0,
            timing: { totalMs: 1_650_400, loadMs: 12_346, promptEvalMs: 612_000, evalMs: 1_020_500 }
        });
    });

    test('沒有任何 *_duration：不加 timing 鍵（與之前逐位元相同）；只有部分時，其餘是 null', () => {
        assert.deepEqual(ollama.usageOf({ prompt_eval_count: 1, eval_count: 2 }), { tokenIn: 1, tokenOut: 2, tokenThinking: 0, tokenCached: 0 });
        assert.equal(ollama.timingOf({}), null);
        assert.equal(ollama.timingOf(null), null);
        assert.deepEqual(ollama.timingOf({ eval_duration: 2_500_000 }), { totalMs: null, loadMs: null, promptEvalMs: null, evalMs: 3 });
        assert.deepEqual(ollama.timingOf({ load_duration: 0 }), { totalMs: null, loadMs: 0, promptEvalMs: null, evalMs: null }, '0 是量到的值，不是沒有');
    });

    test('generateJson／generateText 的 usage 帶 timing；JSON 壞掉時 err.usage 也帶（逾時前的分段時間照樣看得到）', async () => {
        fakeOllama();
        const j = await ollama.generateJson({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }] });
        assert.deepEqual(j.usage.timing, { totalMs: 1_650_400, loadMs: 12_346, promptEvalMs: 612_000, evalMs: 1_020_500 });
        const t = await ollama.generateText({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }] });
        assert.equal(t.usage.timing.promptEvalMs, 612_000);
        fakeOllama({ content: '{"questions": [' });
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'schema_invalid');
            assert.equal(err.usage.timing.evalMs, 1_020_500);
            return true;
        });
    });
});

// ───────────────────────── 串流＝非串流 ─────────────────────────

describe('串流模式：最終結果與 stream:false 完全相同', () => {
    const schema = buildSchema('extract');
    const req = () => ({
        model: 'qwen3-vl:8b', system: '你是老師。',
        parts: [{ text: '拆題' }, { imageBase64: 'AAAA', mimeType: 'image/png' }],
        schema, maxOutputTokens: 8192, thinkingBudget: 1024
    });

    test('generateJson：data、usage（含 timing）、raw、schemaFallback 相同；送出的請求只差 stream 一個欄位', async () => {
        const calls = fakeOllama();
        const plain = await ollama.generateJson(req());
        const streamed = await ollama.generateJson({ ...req(), progressMs: 60_000, onProgress: quiet });
        assert.equal(calls.length, 2);
        assert.equal(calls[0].payload.stream, false);
        assert.equal(calls[1].payload.stream, true);
        assert.equal(calls[0].hasOnData, false, '非串流不帶 onData（傳給傳輸層的參數與之前相同）');
        assert.equal(calls[1].hasOnData, true);
        assert.deepEqual({ ...calls[1].payload, stream: false }, calls[0].payload, '除了 stream 以外逐欄相同');
        assert.deepEqual(Object.keys(calls[1].payload), Object.keys(calls[0].payload), '鍵的順序也相同');

        assert.deepEqual(streamed.data, plain.data);
        assert.deepEqual(streamed.usage, plain.usage);
        assert.deepEqual(streamed.raw, plain.raw, '組回來的回應物件與 stream:false 的一模一樣（含 thinking）');
        assert.equal(streamed.schemaFallback, plain.schemaFallback);
        assert.deepEqual(Object.keys(streamed).sort(), Object.keys(plain).sort());
        assert.equal(streamed.raw.message.thinking, THINKING);
        assert.equal(plain.data.note, '中文與 emoji 🙂');
    });

    test('generateText：text、finishReason、usage、codeRuns 相同；沒有思考時兩邊都沒有 thinking 鍵', async () => {
        fakeOllama({ thinking: '', content: '<think>內心戲</think>先列式，再代入。' });
        const a = await ollama.generateText({ model: 'qwen3:8b', parts: [{ text: 'x' }] });
        const b = await ollama.generateText({ model: 'qwen3:8b', parts: [{ text: 'x' }], progressMs: 60_000, onProgress: quiet });
        assert.equal(b.text, a.text);
        assert.equal(a.text, '先列式，再代入。');
        assert.equal(b.finishReason, a.finishReason);
        assert.deepEqual(b.usage, a.usage);
        assert.deepEqual(b.codeRuns, a.codeRuns);
        assert.deepEqual(b.raw, a.raw);
        assert.equal('thinking' in b.raw.message, false);
    });

    test('OLLAMA_PROGRESS_MS 也能開；progressMs:0 明寫關掉時不看環境變數；沒設就是 stream:false', async () => {
        const calls = fakeOllama();
        await ollama.generateJson({ model: 'm', parts: [{ text: 'x' }] });
        process.env.OLLAMA_PROGRESS_MS = '60000';
        const logs = [];
        const origLog = console.log;
        console.log = (m) => logs.push(String(m));
        try {
            await ollama.generateJson({ model: 'm', parts: [{ text: 'x' }] });
            await ollama.generateJson({ model: 'm', parts: [{ text: 'x' }], progressMs: 0 });
        } finally {
            console.log = origLog;
        }
        assert.deepEqual(calls.map(c => c.payload.stream), [false, true, false]);
        assert.equal(logs.length, 1, '串流那一次在完成時印一行分段時間（預設印到 console.log）');
        assert.match(logs[0], /^\[ollama\] \/api\/chat\(m\) 完成：載入模型 12 秒；讀 prompt 1234 token 用 10 分 12 秒（2\.0 token\/秒）；輸出 45 token 用 17 分 1 秒（0\.0 token\/秒）；牆鐘 /);
        for (const bad of ['0', '-1', 'abc', '']) {
            process.env.OLLAMA_PROGRESS_MS = bad;
            assert.equal(ollama.progressIntervalMs(), 0, bad);
        }
        assert.equal(ollama.DEFAULT_PROGRESS_MS, 0);
    });

    test('模型不支援思考（400）：串流模式同樣拿掉 think 重送一次，也是串流', async () => {
        const calls = fakeOllama({
            override: (url, payload) => (payload.think === true ? { status: 400, text: JSON.stringify({ error: '"gemma3" does not support thinking' }) } : null)
        });
        const res = await ollama.generateJson({ model: 'gemma3', parts: [{ text: 'x' }], thinkingBudget: 512, progressMs: 60_000, onProgress: quiet });
        assert.equal(res.data.note, '中文與 emoji 🙂');
        assert.equal(calls.length, 2);
        assert.equal(calls[1].payload.stream, true);
        assert.equal('think' in calls[1].payload, false);
    });

    test('錯誤：串流中途回報 error → provider_error；沒有 done:true → provider_error；非 2xx 照舊（404 附 ollama pull）', async () => {
        const opts = { model: 'qwen3-vl:8b', parts: [{ text: 'x' }], progressMs: 60_000, onProgress: quiet };
        fakeOllama({ override: () => ({ status: 200, text: '{"message":{"content":"{"}}\n{"error":"model runner has unexpectedly stopped"}\n' }) });
        await assert.rejects(() => ollama.generateJson(opts), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /串流中.*unexpectedly stopped/);
            return true;
        });
        fakeOllama({ override: () => ({ status: 200, text: '{"message":{"content":"{"}}\n' }) });
        await assert.rejects(() => ollama.generateJson(opts), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /完成之前就中斷/);
            return true;
        });
        fakeOllama({ override: () => ({ status: 200, text: 'not json\n' }) });
        await assert.rejects(() => ollama.generateJson(opts), /有一行不是 JSON/);
        fakeOllama({ override: () => ({ status: 404, text: JSON.stringify({ error: 'model "qwen3-vl:8b" not found, try pulling it first' }) }) });
        await assert.rejects(() => ollama.generateJson(opts), /ollama pull qwen3-vl:8b/);
    });

    test('逾時與中止：串流模式照舊是 timeout；呼叫端的 timeoutMs 取代 OLLAMA_TIMEOUT_MS', async () => {
        ollama._setTransportForTest((url, payload, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        await assert.rejects(() => ollama.generateJson({ model: 'm', parts: [{ text: 'x' }], progressMs: 60_000, onProgress: quiet, timeoutMs: 30 }), (err) => {
            assert.equal(err.errorClass, 'timeout');
            assert.match(err.message, /超過這次指定的逾時（30 ms）/);
            return true;
        });
        process.env.OLLAMA_TIMEOUT_MS = '25';
        await assert.rejects(() => ollama.generateJson({ model: 'm', parts: [{ text: 'x' }] }), /超過 OLLAMA_TIMEOUT_MS（25 ms）/);
    });

    test('assembleStream：content 與 thinking 依序接起來，其餘欄位取 done 那一行', () => {
        const r = ollama.assembleStream(ndjson());
        assert.deepEqual(r, whole());
        assert.deepEqual(ollama.assembleStream('\n' + ndjson({ thinking: '' }) + '\n\n'), whole({ thinking: '' }), '空行略過');
    });
});

// ───────────────────────── record：cassette 內容相同 ─────────────────────────

describe('record 模式：串流與非串流寫出的 cassette 相同；timing 進 cassette、不進鍵、不進回放', () => {
    test('同一個鍵、同一支檔；request 與 response.data／usage 相同；replay 只回四個 token 欄位', async () => {
        fakeOllama();
        process.env.LLM_MODE = 'record';
        const opts = {
            model: 'ollama:qwen3-vl:8b', system: 'S', parts: [{ text: '題目' }, { imageBase64: 'AAAA', mimeType: 'image/png' }],
            schema: { type: 'object' }, agent: 'stream_rt', template: 'stream_rt.v1', cacheKeyParts: { chunkNo: 1, pdfSha256: 'p' }
        };
        const key = cassette.cassetteKey({ agent: 'stream_rt', modelId: 'qwen3-vl:8b', template: 'stream_rt.v1', schema: { type: 'object' }, cacheKeyParts: { chunkNo: 1, pdfSha256: 'p' } });
        const file = cassette.cassettePath('stream_rt', key);
        const origLog = console.log;
        console.log = quiet;
        let plain;
        let streamed;
        try {
            await llm.generateJson(opts);
            plain = JSON.parse(fs.readFileSync(file, 'utf8'));
            process.env.OLLAMA_PROGRESS_MS = '60000';
            await llm.generateJson(opts);
            streamed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } finally {
            console.log = origLog;
        }
        assert.deepEqual(streamed.request, plain.request);
        assert.deepEqual(streamed.response.data, plain.response.data);
        assert.deepEqual(streamed.response.usage, plain.response.usage);
        const { recorded_at: a, ...metaA } = plain.meta;
        const { recorded_at: b, ...metaB } = streamed.meta;
        assert.deepEqual(metaB, metaA);
        assert.deepEqual(Object.keys(streamed.response), ['data', 'usage', 'latencyMs']);
        assert.deepEqual(plain.response.usage.timing, { totalMs: 1_650_400, loadMs: 12_346, promptEvalMs: 612_000, evalMs: 1_020_500 },
            '分段時間寫進 cassette（npm run perf:local 讀它）');

        process.env.LLM_MODE = 'replay';
        const replayed = await llm.generateJson(opts);
        assert.equal(replayed.cassetteKey, key, '鍵與沒有 timing 時的公式相同');
        assert.deepEqual(replayed.usage, { tokenIn: 1234, tokenOut: 45, tokenThinking: 0, tokenCached: 0 }, '回放不帶 timing：CI 的結果不變');
        assert.deepEqual(replayed.data, plain.response.data);
    });
});

// ───────────────────────── 進度的文字 ─────────────────────────

describe('createProgressReporter：分得出排隊、讀圖、輸出中、卡住', () => {
    function clock(start = 0) {
        const c = { t: start };
        c.now = () => c.t;
        return c;
    }
    const line = (obj) => `${JSON.stringify(obj)}\n`;

    test('排隊 → 還沒輸出第一個 token → 已輸出 N token（速度）→ 沒有新 token → 完成／失敗', () => {
        const c = clock(1_000);
        const logs = [];
        const r = ollama.createProgressReporter({ label: '/api/chat(qwen3-vl:8b)', log: (s) => logs.push(s), now: c.now });
        c.t += 30_000;
        assert.match(r.tick(), /^\[ollama\] \/api\/chat\(qwen3-vl:8b\) 排隊中：等前一個 Ollama 呼叫跑完（OLLAMA_CONCURRENCY），已等 30 秒$/);
        r.start();
        c.t += 5 * 60_000;
        assert.match(r.tick(), /已 5 分：還沒輸出第一個 token——載入模型、讀 prompt（看圖）中；這一段 Ollama 不回報進度，要多久可用 npm run local:bench-vision 先量$/);
        c.t += 60_000;
        // 一行被切成兩段送進來也數得對；content 與 thinking 都算；空的 content 不算
        const two = line({ message: { content: '{"q' } }) + line({ message: { content: '', thinking: '想' } });
        r.onData(two.slice(0, 10));
        r.onData(two.slice(10));
        r.onData(line({ message: { content: '' } }) + line({ done: true, eval_count: 99 }));
        c.t += 60_000;
        assert.match(r.tick(), /已 7 分：已輸出 2 token（第一個 token 在第 6 分）；最近 2 分 多了 2 token，約 0\.0 token\/秒$/);
        for (let i = 0; i < 30; i++) r.onData(line({ message: { content: 'x' } }));
        c.t += 60_000;
        assert.match(r.tick(), /已 8 分：已輸出 32 token（第一個 token 在第 6 分）；最近 1 分 多了 30 token，約 0\.5 token\/秒$/);
        c.t += 90_000;
        assert.match(r.tick(), /已 9 分 30 秒：已輸出 32 token（第一個 token 在第 6 分）；已經 2 分 30 秒 沒有新 token——持續不動的話可能卡住/);
        assert.match(r.finish(DONE_FIELDS), /完成：載入模型 12 秒；讀 prompt 1234 token 用 10 分 12 秒（2\.0 token\/秒）；輸出 45 token 用 17 分 1 秒（0\.0 token\/秒）；牆鐘 9 分 30 秒$/);
        assert.match(r.fail(Object.assign(new Error('Ollama 呼叫超過 OLLAMA_TIMEOUT_MS（1800000 ms）仍未完成'), { errorClass: 'timeout' })),
            /失敗（timeout）：已 9 分 30 秒、已輸出 32 token——Ollama 呼叫超過 OLLAMA_TIMEOUT_MS/);
        assert.equal(logs.length, 7, "5 次 tick＋完成＋失敗");
        assert.equal(r.state.tokens, 32);
    });

    test('log 函式丟錯不影響呼叫；分段時間沒有時印 —', () => {
        const r = ollama.createProgressReporter({ label: 'x', log: () => { throw new Error('寫不進去'); } });
        r.start();
        assert.match(r.tick(), /還沒輸出第一個 token/);
        assert.match(r.finish({ prompt_eval_count: 1 }), /載入模型 —；讀 prompt 1 token 用 —（— token\/秒）/);
    });

    test('計時器真的會印：先是「還沒輸出第一個 token」，之後是「已輸出」，最後是「完成」', async () => {
        fakeOllama({ firstDelay: 80, gap: 5 });
        const logs = [];
        const res = await ollama.generateJson({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }], progressMs: 20, onProgress: (s) => logs.push(s) });
        assert.equal(res.data.note, '中文與 emoji 🙂');
        assert.ok(logs.some(l => /還沒輸出第一個 token/.test(l)), logs.join('\n'));
        assert.ok(logs.some(l => /已輸出 \d+ token/.test(l)), logs.join('\n'));
        assert.match(logs.at(-1), /完成：/);
        const before = logs.length;
        await new Promise(r => setTimeout(r, 60));
        assert.equal(logs.length, before, '結束後計時器已清掉，不再印');
    });

    test('失敗時也印一行、計時器清掉', async () => {
        fakeOllama({ override: () => ({ status: 500, text: JSON.stringify({ error: 'model requires more system memory' }) }) });
        const logs = [];
        await assert.rejects(() => ollama.generateJson({ model: 'm', parts: [{ text: 'x' }], progressMs: 10, onProgress: (s) => logs.push(s) }), /more system memory/);
        assert.match(logs.at(-1), /失敗（provider_error）/);
        const n = logs.length;
        await new Promise(r => setTimeout(r, 40));
        assert.equal(logs.length, n);
    });
});

// ───────────────────────── 卸載模型（量測工具用） ─────────────────────────

describe('unloadModel', () => {
    test('POST /api/generate {model, keep_alive:0}', async () => {
        const calls = [];
        ollama._setTransportForTest(async (url, payload) => {
            calls.push({ url, payload });
            return { status: 200, text: JSON.stringify({ model: 'qwen3-vl:8b', done: true, done_reason: 'unload' }) };
        });
        const r = await ollama.unloadModel({ model: 'qwen3-vl:8b' });
        assert.equal(r.done_reason, 'unload');
        assert.deepEqual(calls, [{ url: 'http://127.0.0.1:11434/api/generate', payload: { model: 'qwen3-vl:8b', keep_alive: 0 } }]);
    });
});

// ───────────────────────── 真的 node:http 串流 ─────────────────────────

describe('node:http 傳輸的串流（127.0.0.1 上的假 Ollama，分段送、中文字切在兩段之間）', () => {
    let server;
    let port;

    before(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', async () => {
                const body = JSON.parse(raw);
                res.writeHead(200, { 'content-type': body.stream ? 'application/x-ndjson' : 'application/json' });
                if (!body.stream) return res.end(JSON.stringify(whole()));
                const buf = Buffer.from(ndjson(), 'utf8');
                // 每段 5 位元組：中文（3 位元組）與 emoji（4 位元組）一定會被切開
                for (let i = 0; i < buf.length; i += 5) {
                    res.write(buf.subarray(i, i + 5));
                    await new Promise(r => setImmediate(r));
                }
                res.end();
            });
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    });

    test('onData 一段一段收到、解碼正確；最後結果與 stream:false 相同', async () => {
        process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
        const seen = [];
        const r = await ollama.httpPostJson(`http://127.0.0.1:${port}/api/chat`, { stream: true }, { onData: (s) => seen.push(s) });
        assert.ok(seen.length > 10, `收到 ${seen.length} 段`);
        assert.equal(seen.join(''), r.text, '逐段解碼接起來＝整段本文（多位元組字元沒有被切壞）');
        assert.ok(!seen.join('').includes('�'));

        const logs = [];
        const streamed = await ollama.generateJson({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }], thinkingBudget: 1, progressMs: 60_000, onProgress: (s) => logs.push(s) });
        const plain = await ollama.generateJson({ model: 'qwen3-vl:8b', parts: [{ text: 'x' }], thinkingBudget: 1 });
        assert.deepEqual(streamed.data, plain.data);
        assert.deepEqual(streamed.usage, plain.usage);
        assert.deepEqual(streamed.raw, plain.raw);
        assert.match(logs.at(-1), /完成：/);
    });
});
