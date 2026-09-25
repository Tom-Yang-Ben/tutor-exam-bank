// services/llm/ollama.js 與 services/llm 的 ollama 分派（本機模式 L1，docs/local-mode.md 第 3 條第 2～6、8 點）
//
// 全部用假的傳輸（ollama._setTransportForTest）或 127.0.0.1 上的假伺服器：不連 Ollama、不連 Gemini、不需要金鑰。
// cassette 與 embedding fixture 一律寫到系統暫存目錄，不碰 repo 的 eval/。
//
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ollama = require('../../services/llm/ollama');
const gemini = require('../../services/llm/gemini');
const throttle = require('../../services/llm/throttle');
const cassette = require('../../services/llm/cassette');
const fixture = require('../../services/llm/fixture');
const fake = require('../../services/llm/fake');
const llm = require('../../services/llm');
const { buildSchema } = require('../../agents/schemas');

const ENV_KEYS = [
    'LLM_MODE', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM', 'EMBED_FIXTURE_DIR', 'EVAL_CASSETTE_DIR',
    'MODEL_EXTRACT', 'MODEL_VERIFY', 'OLLAMA_HOST', 'OLLAMA_CONCURRENCY', 'OLLAMA_RPM', 'OLLAMA_TIMEOUT_MS',
    'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'JOB_CONCURRENCY', 'GEMINI_RPM', 'GEMINI_API_KEY'
];
const envBackup = {};
let tmpDir;

before(() => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-ollama-'));
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    ollama._resetForTest();
    gemini._setClientForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');
    process.env.EMBED_FIXTURE_DIR = path.join(tmpDir, 'fixtures');
    ollama._resetForTest();
    throttle._resetForTest();
    fake._resetForTest();
    gemini._setClientForTest(null);
});

/**
 * 假的傳輸：記下每一次 POST，依 handler 回應。
 * handler(url, payload) 回 { status, body }（body 會 JSON.stringify）或直接丟錯。
 */
function fakeTransport(handler) {
    const calls = [];
    ollama._setTransportForTest(async (url, payload, opts) => {
        calls.push({ url, payload: JSON.parse(JSON.stringify(payload)), signal: opts.signal });
        const r = await handler(url, payload, opts);
        return { status: r.status ?? 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    });
    return calls;
}

/** Ollama /api/chat 的成功回應 */
function chatOk(content, extra = {}) {
    return {
        status: 200,
        body: {
            model: 'qwen3:8b', done: true, done_reason: 'stop',
            message: { role: 'assistant', content, thinking: '先想一想……' },
            prompt_eval_count: 120, eval_count: 45, ...extra
        }
    };
}

// ───────────────────────── /api/chat：generateJson ─────────────────────────

describe('ollama.generateJson — 送出的請求（第 3 條第 2 點）', () => {
    test('POST /api/chat：stream:false、format＝schema、options、keep_alive、think、system＋一則 user', async () => {
        const calls = fakeTransport(() => chatOk('{"final_answer":"(A)","answer_form":"option","steps_summary":"s"}'));
        const schema = buildSchema('verify');
        const res = await ollama.generateJson({
            model: 'qwen3:8b', system: '你是解題老師。',
            parts: [{ text: '第一段' }, { text: '第二段' }],
            schema, maxOutputTokens: 8192, thinkingBudget: 1024
        });

        assert.equal(calls.length, 1);
        const { url, payload } = calls[0];
        assert.equal(url, 'http://127.0.0.1:11434/api/chat');
        assert.equal(payload.model, 'qwen3:8b');
        assert.equal(payload.stream, false);
        assert.deepEqual(payload.options, { temperature: 0, num_ctx: 16384, num_predict: 8192 });
        assert.equal(payload.keep_alive, '10m');
        assert.equal(payload.think, true);
        assert.deepEqual(payload.format, ollama.toOllamaSchema(schema));
        assert.equal(payload.messages.length, 2);
        assert.equal(payload.messages[0].role, 'system');
        assert.ok(payload.messages[0].content.startsWith('你是解題老師。\n\n【輸出格式】'), payload.messages[0].content);
        assert.match(payload.messages[0].content, /final_answer（字串；必填；至少 1 字）：最終答案本身/);
        assert.deepEqual(payload.messages[1], { role: 'user', content: '第一段\n\n第二段' });

        // 回傳形狀與 gemini.generateJson 相同；thinking 不進 data
        assert.deepEqual(Object.keys(res).sort(), ['data', 'latencyMs', 'raw', 'schemaFallback', 'usage']);
        assert.deepEqual(res.data, { final_answer: '(A)', answer_form: 'option', steps_summary: 's' });
        assert.deepEqual(res.usage, { tokenIn: 120, tokenOut: 45, tokenThinking: 0, tokenCached: 0 });
        assert.equal(res.schemaFallback, false);
        assert.equal(typeof res.latencyMs, 'number');
        assert.equal(res.raw.message.thinking, '先想一想……');
    });

    test('thinkingBudget 為 0 或沒給 → think:false；沒給 maxOutputTokens 就不送 num_predict；沒有 schema → format:"json"', async () => {
        const calls = fakeTransport(() => chatOk('{"ok":true}'));
        await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }], thinkingBudget: 0 });
        await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] });
        for (const c of calls) {
            assert.equal(c.payload.think, false);
            assert.equal(c.payload.format, 'json');
            assert.equal('num_predict' in c.payload.options, false);
            assert.equal(c.payload.messages[0].role, 'system', '沒有 system 時仍送輸出格式說明');
            assert.match(c.payload.messages[0].content, /只輸出一個 JSON 物件/);
        }
    });

    test('OLLAMA_HOST／OLLAMA_NUM_CTX／OLLAMA_KEEP_ALIVE 覆寫；keep_alive 純數字轉成數字（秒）', async () => {
        process.env.OLLAMA_HOST = 'localhost:12345';
        process.env.OLLAMA_NUM_CTX = '8192';
        process.env.OLLAMA_KEEP_ALIVE = '600';
        const calls = fakeTransport(() => chatOk('{}'));
        await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] });
        assert.equal(calls[0].url, 'http://localhost:12345/api/chat');
        assert.equal(calls[0].payload.options.num_ctx, 8192);
        assert.equal(calls[0].payload.keep_alive, 600);
        process.env.OLLAMA_KEEP_ALIVE = '-1';
        assert.equal(ollama.keepAlive(), -1);
        process.env.OLLAMA_KEEP_ALIVE = '30m';
        assert.equal(ollama.keepAlive(), '30m');
    });

    test('圖片：{imageBase64, mimeType} 與 {inlineData:{mimeType:image/*, data}} 都放進 images（base64）', async () => {
        const calls = fakeTransport(() => chatOk('{}'));
        await ollama.generateJson({
            model: 'qwen3-vl:8b',
            parts: [{ text: '拆題' }, { imageBase64: 'AAAA', mimeType: 'image/png' }, { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }]
        });
        assert.deepEqual(calls[0].payload.messages[1], { role: 'user', content: '拆題', images: ['AAAA', 'BBBB'] });
    });

    test('PDF 與音訊 → errorClass=unsupported_input，不送出請求', async () => {
        const calls = fakeTransport(() => chatOk('{}'));
        const bad = [
            [{ pdfBase64: 'JVBERi0=' }],
            [{ fileUri: 'gs://x.pdf' }],
            [{ audioBase64: 'AAAA', mimeType: 'audio/webm' }],
            [{ inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } }],
            [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }],
            [{ imageBase64: 'AAAA', mimeType: 'application/pdf' }]
        ];
        for (const parts of bad) {
            await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts }), (err) => {
                assert.equal(err.errorClass, 'unsupported_input', JSON.stringify(parts));
                return true;
            });
        }
        assert.equal(calls.length, 0);
    });

    test('回應的 JSON 被 ``` 圍起、或 content 開頭有 <think>…</think> → 剝掉再 parse', async () => {
        fakeTransport(() => chatOk('<think>嗯</think>\n```json\n{"a":1}\n```'));
        const res = await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] });
        assert.deepEqual(res.data, { a: 1 });
    });

    test('模型輸出不是合法 JSON → errorClass=schema_invalid，用量與 finishReason 掛在錯誤上（與 gemini.js 同一個類別）', async () => {
        fakeTransport(() => chatOk('{"questions": [ {"subject": "數', { done_reason: 'length', prompt_eval_count: 900, eval_count: 4096 }));
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }], maxOutputTokens: 4096 }), (err) => {
            assert.equal(err.errorClass, 'schema_invalid');
            assert.deepEqual(err.usage, { tokenIn: 900, tokenOut: 4096, tokenThinking: 0, tokenCached: 0 });
            assert.equal(err.finishReason, 'MAX_TOKENS');
            return true;
        });
        fakeTransport(() => chatOk('   '));
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'schema_invalid');
            assert.match(err.message, /空字串/);
            return true;
        });
    });

    test('模型不支援思考（400 does not support thinking）→ 拿掉 think 重送一次', async () => {
        const calls = fakeTransport((url, payload) => (payload.think === true
            ? { status: 400, body: { error: '"gemma3" does not support thinking' } }
            : chatOk('{"ok":1}')));
        const res = await ollama.generateJson({ model: 'gemma3', parts: [{ text: 'x' }], thinkingBudget: 512 });
        assert.deepEqual(res.data, { ok: 1 });
        assert.equal(calls.length, 2);
        assert.equal(calls[0].payload.think, true);
        assert.equal('think' in calls[1].payload, false);
    });
});

describe('ollama：錯誤分類（第 3 條第 2 點）', () => {
    test('模型沒下載（404 model not found）→ provider_error，訊息附 ollama pull <id>；不重試', async () => {
        const calls = fakeTransport(() => ({ status: 404, body: { error: 'model "qwen3:8b" not found, try pulling it first' } }));
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /ollama pull qwen3:8b/);
            return true;
        });
        assert.equal(calls.length, 1);
    });

    test('其他 HTTP 錯誤 → provider_error（帶 status）；不重試', async () => {
        const calls = fakeTransport(() => ({ status: 500, body: { error: 'model requires more system memory (9.1 GiB) than is available (6.0 GiB)' } }));
        await assert.rejects(() => ollama.generateText({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.equal(err.status, 500);
            assert.match(err.message, /more system memory/);
            return true;
        });
        assert.equal(calls.length, 1);
    });

    test('連不上 → provider_error，訊息「Ollama 沒有在執行，請先開啟 Ollama」', async () => {
        fakeTransport(() => { throw Object.assign(new TypeError('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }); });
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /Ollama 沒有在執行，請先開啟 Ollama/);
            assert.match(err.message, /ECONNREFUSED/);
            return true;
        });
    });

    test('呼叫端的 signal 中止 → timeout；已中止的 signal 連佇列都不排、傳輸不會被呼叫', async () => {
        const calls = fakeTransport((url, payload, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const ac = new AbortController();
        const p = ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }], signal: ac.signal });
        setTimeout(() => ac.abort(), 10);
        await assert.rejects(p, (err) => {
            assert.equal(err.errorClass, 'timeout');
            assert.match(err.message, /中止/);
            return true;
        });
        assert.equal(calls.length, 1, '逾時不重試');

        const done = new AbortController();
        done.abort();
        await assert.rejects(() => ollama.generateText({ model: 'qwen3:8b', parts: [{ text: 'x' }], signal: done.signal }), (err) => {
            assert.equal(err.errorClass, 'timeout');
            return true;
        });
        assert.equal(calls.length, 1);
    });

    test('超過 OLLAMA_TIMEOUT_MS → timeout，不重試', async () => {
        process.env.OLLAMA_TIMEOUT_MS = '30';
        const calls = fakeTransport((url, payload, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'timeout');
            assert.match(err.message, /OLLAMA_TIMEOUT_MS（30 ms）/);
            return true;
        });
        assert.equal(calls.length, 1);
    });

    test('OLLAMA_HOST 寫錯 → provider_error，不送出請求', async () => {
        process.env.OLLAMA_HOST = 'ftp://127.0.0.1';
        const calls = fakeTransport(() => chatOk('{}'));
        const orig = console.warn;
        console.warn = () => {};
        try {
            await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
                assert.equal(err.errorClass, 'provider_error');
                assert.match(err.message, /OLLAMA_HOST/);
                return true;
            });
        } finally {
            console.warn = orig;
        }
        assert.equal(calls.length, 0);
    });

    test('逾時預設 30 分、num_ctx 16384、keep_alive 10m（第 2 條）', () => {
        assert.equal(ollama.DEFAULT_TIMEOUT_MS, 1_800_000);
        assert.equal(ollama.DEFAULT_NUM_CTX, 16384);
        assert.equal(ollama.DEFAULT_KEEP_ALIVE, '10m');
        assert.equal(ollama.DEFAULT_HOST, 'http://127.0.0.1:11434');
    });
});

// ───────────────────────── schema 轉換 ─────────────────────────

describe('ollama.toOllamaSchema — Gemini 專用欄位轉成標準 JSON Schema', () => {
    test('propertyOrdering：依它重排 properties 並拿掉；nullable:true → type 補 null；原物件不動（深凍結也行）', () => {
        const src = Object.freeze({
            type: 'object',
            propertyOrdering: Object.freeze(['b', 'a']),
            properties: Object.freeze({
                a: Object.freeze({ type: 'string', nullable: true }),
                b: Object.freeze({ type: 'integer', nullable: false }),
                c: Object.freeze({ type: 'string', enum: Object.freeze(['x', 'y']), nullable: true }),
                nullable: Object.freeze({ type: 'boolean' })          // 欄位名剛好叫 nullable 也不該被刪
            })
        });
        const out = ollama.toOllamaSchema(src);
        assert.deepEqual(Object.keys(out.properties), ['b', 'a', 'c', 'nullable']);
        assert.equal('propertyOrdering' in out, false);
        assert.deepEqual(out.properties.a, { type: ['string', 'null'] });
        assert.deepEqual(out.properties.b, { type: 'integer' });
        assert.deepEqual(out.properties.c, { type: ['string', 'null'], enum: ['x', 'y', null] });
        assert.deepEqual(out.properties.nullable, { type: 'boolean' });
        assert.deepEqual(src.propertyOrdering, ['b', 'a'], '原 schema 不得被改');
    });

    test('agents/schemas 的真 schema：轉完不剩 propertyOrdering／nullable，其餘關鍵字與 enum 原樣保留', () => {
        for (const name of ['extract', 'classify', 'verify', 'lint', 'variant', 'nlq']) {
            const src = buildSchema(name);
            const out = ollama.toOllamaSchema(src);
            const text = JSON.stringify(out);
            assert.equal(/"propertyOrdering"\s*:/.test(text), false, name);
            assert.equal(/"nullable"\s*:\s*(true|false)/.test(text), false, name);
            assert.equal((text.match(/"enum"/g) || []).length, (JSON.stringify(src).match(/"enum"/g) || []).length, name);
        }
        const extract = ollama.toOllamaSchema(buildSchema('extract'));
        assert.deepEqual(Object.keys(extract.properties.questions.items.properties).slice(0, 4),
            ['idx', 'subject', 'chapter', 'chapter_confidence'], '依 propertyOrdering 排');
    });

    test('schemaGuide：列出欄位、必填／選填、說明；enum 少的逐一列出，多的（章節）只寫幾個合法值之一', () => {
        const guide = ollama.schemaGuide(ollama.toOllamaSchema(buildSchema('extract')));
        assert.match(guide, /^【輸出格式】只輸出一個 JSON 物件/);
        assert.match(guide, /- questions（物件陣列；必填）：/);
        assert.match(guide, /questions\[\]\.chapter（字串；必填；\d+ 個合法值之一，必須完全相符）/);
        assert.match(guide, /questions\[\]\.difficulty（整數；必填；範圍 1～5）/);
        assert.match(guide, /questions\[\]\.figure_desc（字串；選填）/);
        const verify = ollama.schemaGuide(ollama.toOllamaSchema(buildSchema('verify')));
        assert.match(verify, /answer_form（字串；必填；只能是 「option」「number」「expression」「text」）/);
    });
});

// ───────────────────────── generateText ─────────────────────────

describe('ollama.generateText（第 3 條第 3 點）', () => {
    test('不送 format；tools.codeExecution 直接忽略、codeRuns 恆為 []；thinking 不進 text', async () => {
        const calls = fakeTransport(() => chatOk('<think>內心戲</think>先列式。'));
        const res = await ollama.generateText({
            model: 'qwen3:8b', system: '你是家教', parts: [{ text: '1+1=?' }],
            tools: { codeExecution: true }, maxOutputTokens: 8192, thinkingBudget: 2048
        });
        assert.equal('format' in calls[0].payload, false);
        assert.equal('tools' in calls[0].payload, false);
        assert.deepEqual(calls[0].payload.messages[0], { role: 'system', content: '你是家教' });
        assert.equal(calls[0].payload.think, true);
        assert.equal(res.text, '先列式。');
        assert.deepEqual(res.codeRuns, []);
        assert.equal(res.finishReason, 'STOP');
        assert.deepEqual(res.usage, { tokenIn: 120, tokenOut: 45, tokenThinking: 0, tokenCached: 0 });
    });

    test("done_reason:'length' → finishReason 'MAX_TOKENS'；沒有 done_reason → null", () => {
        assert.equal(ollama.finishReasonOf({ done_reason: 'length' }), 'MAX_TOKENS');
        assert.equal(ollama.finishReasonOf({ done_reason: 'stop' }), 'STOP');
        assert.equal(ollama.finishReasonOf({ done_reason: 'unload' }), 'UNLOAD');
        assert.equal(ollama.finishReasonOf({}), null);
    });
});

// ───────────────────────── embed ─────────────────────────

describe('ollama.embed（第 3 條第 4 點）', () => {
    test('POST /api/embed {model, input, dimensions, truncate:true}；維度比 dim 長就截前 dim 維', async () => {
        const calls = fakeTransport(() => ({ status: 200, body: { embeddings: [[1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]], prompt_eval_count: 17 } }));
        const res = await ollama.embed({ model: 'qwen3-embedding:0.6b', texts: ['甲', '乙'], dim: 4 });
        assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/embed');
        assert.deepEqual(calls[0].payload, { model: 'qwen3-embedding:0.6b', input: ['甲', '乙'], dimensions: 4, truncate: true });
        assert.deepEqual(res.vectors, [[1, 2, 3, 4], [6, 5, 4, 3]]);
        assert.deepEqual(res.usage, { tokenIn: 17 });
    });

    test('筆數不符、維度不足 → provider_error（不補零、不假造）', async () => {
        fakeTransport(() => ({ status: 200, body: { embeddings: [[1, 2, 3, 4]] } }));
        await assert.rejects(() => ollama.embed({ model: 'm', texts: ['a', 'b'], dim: 4 }), /與送出的 2 筆不符/);
        fakeTransport(() => ({ status: 200, body: { embeddings: [[1, 2]] } }));
        await assert.rejects(() => ollama.embed({ model: 'm', texts: ['a'], dim: 4 }), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /只有 2 維，少於 EMBED_DIM=4/);
            return true;
        });
    });
});

// ───────────────────────── services/llm 的分派（第 3 條第 5 點）─────────────────────────

describe('services/llm：依 vendor 分派', () => {
    function fakeGeminiClient() {
        const seen = { generateContent: 0, embedContent: [] };
        gemini._setClientForTest({
            models: {
                generateContent: async () => {
                    seen.generateContent += 1;
                    return { text: '{"from":"gemini"}', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'g' }] } }], usageMetadata: {} };
                },
                embedContent: async (req) => {
                    seen.embedContent.push(req);
                    return { embeddings: req.contents.map(() => ({ values: [0, 0, 3, 4] })) };
                }
            }
        });
        return seen;
    }

    test('live：ollama:qwen3:8b → ollama adapter（裸 ID qwen3:8b）；gemini:… → gemini adapter；兩邊互不呼叫', async () => {
        process.env.LLM_MODE = 'live';
        const g = fakeGeminiClient();
        const calls = fakeTransport(() => chatOk('{"from":"ollama"}'));

        const a = await llm.generateJson({ model: 'ollama:qwen3:8b', parts: [{ text: 'x' }] });
        assert.deepEqual(a.data, { from: 'ollama' });
        assert.equal(calls[0].payload.model, 'qwen3:8b');
        assert.equal(g.generateContent, 0);

        const b = await llm.generateJson({ model: 'gemini:gemini-3.5-flash', parts: [{ text: 'x' }] });
        assert.deepEqual(b.data, { from: 'gemini' });
        assert.equal(calls.length, 1);
        assert.equal(g.generateContent, 1);

        const t = await llm.generateText({ model: 'ollama:qwen3:8b', parts: [{ text: 'x' }], tools: { codeExecution: true } });
        assert.deepEqual(t.codeRuns, []);
        assert.equal(g.generateContent, 1);
    });

    test('沒設 MODEL_EXTRACT、也沒給 model → 走本機預設 ollama:qwen3-vl:8b，不會悄悄呼叫 Gemini', async () => {
        process.env.LLM_MODE = 'live';
        const g = fakeGeminiClient();
        const calls = fakeTransport(() => chatOk('{}'));
        await llm.generateJson({ parts: [{ text: 'x' }] });
        await llm.generateText({ parts: [{ text: 'x' }] });
        assert.deepEqual(calls.map(c => c.payload.model), ['qwen3-vl:8b', 'qwen3-vl:8b']);
        assert.equal(g.generateContent, 0);
    });

    test('anthropic／openai 仍丟「只有 gemini 與 ollama adapter」', async () => {
        process.env.LLM_MODE = 'live';
        await assert.rejects(() => llm.generateJson({ model: 'anthropic:claude-x', parts: [{ text: 'x' }] }), /只有 gemini 與 ollama adapter/);
        await assert.rejects(() => llm.generateText({ model: 'openai:gpt-x', parts: [{ text: 'x' }] }), /只有 gemini 與 ollama adapter/);
    });

    test('record → replay：cassette 鍵與 meta 用裸 ID（qwen3:8b），公式不變；replay 不連 Ollama', async () => {
        process.env.LLM_MODE = 'record';
        const calls = fakeTransport(() => chatOk('{"answer":42}'));
        const opts = {
            model: 'ollama:qwen3:8b', system: 'S', parts: [{ text: '題目' }], schema: { type: 'object' },
            agent: 'ollama_rt', template: 'ollama_rt.v1', cacheKeyParts: { q: 1 }
        };
        const logs = [];
        const origLog = console.log;
        console.log = (m) => logs.push(String(m));
        try {
            await llm.generateJson(opts);
            await llm.generateText({ ...opts, schema: undefined, agent: 'ollama_rt_text' });
        } finally {
            console.log = origLog;
        }
        const key = cassette.cassetteKey({ agent: 'ollama_rt', modelId: 'qwen3:8b', template: 'ollama_rt.v1', schema: { type: 'object' }, cacheKeyParts: { q: 1 } });
        const body = cassette.readCassette('ollama_rt', key);
        assert.ok(body, logs.join('\n'));
        assert.equal(body.meta.model, 'qwen3:8b');
        assert.deepEqual(body.response.data, { answer: 42 });
        assert.deepEqual(body.response.usage, { tokenIn: 120, tokenOut: 45, tokenThinking: 0, tokenCached: 0 });
        const textKey = cassette.cassetteKey({ agent: 'ollama_rt_text', modelId: 'qwen3:8b', template: 'ollama_rt.v1', schema: undefined, cacheKeyParts: { q: 1 } });
        assert.equal(cassette.readCassette('ollama_rt_text', textKey).response.text, '{"answer":42}');

        process.env.LLM_MODE = 'replay';
        const replayed = await llm.generateJson(opts);
        assert.deepEqual(replayed.data, { answer: 42 });
        assert.equal(replayed.cassetteKey, key);
        assert.equal(calls.length, 2, 'replay 不呼叫 Ollama');
    });
});

// ───────────────────────── embed 的前綴規則與 fixture 檔名（第 2 條、第 3 條第 5、6 點）─────────────────────────

describe('services/llm.embed：EMBED_MODEL 的前綴規則', () => {
    test('未設 → 本機預設 ollama:qwen3-embedding:0.6b（送裸 ID）；回來的向量截到 EMBED_DIM 後再 L2 正規化', async () => {
        process.env.EMBED_MODE = 'live';
        const calls = fakeTransport(() => ({ status: 200, body: { embeddings: [[3, 4, 99, 99]] } }));
        const res = await llm.embed({ texts: ['題幹'], dim: 2 });
        assert.equal(calls[0].payload.model, 'qwen3-embedding:0.6b');
        assert.deepEqual(res.vectors, [[0.6, 0.8]]);
    });

    test('沒有前綴的舊值 gemini-embedding-001 → Gemini（參數與之前相同），不呼叫 Ollama', async () => {
        process.env.EMBED_MODE = 'live';
        process.env.EMBED_MODEL = 'gemini-embedding-001';
        process.env.EMBED_RPM = '1000';
        const calls = fakeTransport(() => ({ status: 200, body: { embeddings: [[1]] } }));
        const seen = [];
        gemini._setClientForTest({
            models: { embedContent: async (req) => { seen.push(req); return { embeddings: req.contents.map(() => ({ values: [0, 0, 3, 4] })) }; } }
        });
        try {
            const res = await llm.embed({ texts: ['題幹'], dim: 4, taskType: 'RETRIEVAL_QUERY' });
            assert.deepEqual(seen, [{ model: 'gemini-embedding-001', contents: ['題幹'], config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 4 } }]);
            assert.deepEqual(res.vectors, [[0, 0, 0.6, 0.8]]);
            assert.equal(calls.length, 0);
        } finally {
            delete process.env.EMBED_RPM;
        }
    });

    test('record：ollama 的向量寫進 embeddings.ollama-qwen3-embedding-0.6b.<dim>.json；fixture 模式讀同一支檔、不連線', async () => {
        process.env.EMBED_MODE = 'record';
        process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
        const calls = fakeTransport(() => ({ status: 200, body: { embeddings: [[0, 5, 0, 12]] } }));
        const origLog = console.log;
        console.log = () => {};
        try {
            await llm.embed({ texts: ['向量內積'], dim: 4 });
        } finally {
            console.log = origLog;
        }
        const file = path.join(process.env.EMBED_FIXTURE_DIR, 'embeddings.ollama-qwen3-embedding-0.6b.4.json');
        assert.ok(fs.existsSync(file), '檔名不得含冒號（Windows 不能用）');
        assert.equal(fixture.fixturePath('ollama:qwen3-embedding:0.6b', 4), file);

        process.env.EMBED_MODE = 'fixture';
        const res = await llm.embed({ texts: ['向量內積'], dim: 4 });
        assert.equal(calls.length, 1, 'fixture 模式不連 Ollama');
        assert.ok(Math.abs(res.vectors[0][1] - 5 / 13) < 1e-6);
    });

    test('fixtureModelSlug：: / \\ 換成 -；Gemini 的檔名不變', () => {
        assert.equal(fixture.fixtureModelSlug('ollama:qwen3-embedding:0.6b'), 'ollama-qwen3-embedding-0.6b');
        assert.equal(fixture.fixtureModelSlug('ollama:library/model:tag'), 'ollama-library-model-tag');
        assert.equal(fixture.fixtureModelSlug('a\\b'), 'a-b');
        assert.equal(fixture.fixtureModelSlug('gemini-embedding-001'), 'gemini-embedding-001');
        assert.equal(path.basename(fixture.fixturePath('gemini-embedding-001', 768)), 'embeddings.gemini-embedding-001.768.json');
    });

    test('anthropic 之類沒有 embed adapter 的 vendor → 丟錯', async () => {
        process.env.EMBED_MODE = 'live';
        await assert.rejects(() => llm.embed({ model: 'anthropic:x', texts: ['a'], dim: 4 }), /embed 目前只支援 gemini 與 ollama/);
    });
});

// ───────────────────────── throttle（第 3 條第 8 點）─────────────────────────

describe('throttle：ollama 的桶', () => {
    test('併發讀 OLLAMA_CONCURRENCY（預設 1，不吃 JOB_CONCURRENCY）；RPM 讀 OLLAMA_RPM（未設＝不限）；gemini 不變', () => {
        process.env.JOB_CONCURRENCY = '4';
        assert.equal(throttle.concurrencyLimit('ollama'), 1);
        process.env.OLLAMA_CONCURRENCY = '2';
        assert.equal(throttle.concurrencyLimit('ollama'), 2);
        assert.equal(throttle.concurrencyLimit('gemini'), 4);
        assert.equal(throttle.concurrencyLimit(), 4, '不帶參數時與之前相同');
        assert.equal(throttle.rpmFor('ollama'), Infinity);
        process.env.OLLAMA_RPM = '5';
        assert.equal(throttle.rpmFor('ollama'), 5);
        assert.equal(throttle.rpmFor('gemini'), 60);
    });

    test('兩個呼叫同時進來：預設一次只有一個在 Ollama 裡跑', async () => {
        let inFlight = 0;
        let peak = 0;
        const release = [];
        fakeTransport(() => new Promise((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            release.push(() => { inFlight -= 1; resolve(chatOk('{}')); });
        }));
        const p1 = ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: '1' }] });
        const p2 = ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: '2' }] });
        await new Promise(r => setImmediate(r));
        assert.equal(release.length, 1, '第二個要排隊');
        release.shift()();
        await p1;
        await new Promise(r => setImmediate(r));
        assert.equal(release.length, 1);
        release.shift()();
        await p2;
        assert.equal(peak, 1);
    });

    test('排隊中被中止：離開佇列並丟 timeout；槽位帳不亂（之後照常取得）', async () => {
        const r1 = await throttle.acquire('ollama');
        const ac = new AbortController();
        const waiting = throttle.acquire('ollama', { signal: ac.signal });
        ac.abort();
        await assert.rejects(waiting, (err) => {
            assert.equal(err.errorClass, 'timeout');
            return true;
        });
        r1();
        const r2 = await throttle.acquire('ollama');
        r2();
        const pre = new AbortController();
        pre.abort();
        await assert.rejects(() => throttle.acquire('gemini', { signal: pre.signal }), /已被中止/);
    });
});

// ───────────────────────── OLLAMA_HOST（第 2 條）─────────────────────────

describe('OLLAMA_HOST：解析與非本機警告', () => {
    test('resolveHost：未設、host、host:port、:port、完整網址、IPv6、0.0.0.0', () => {
        const r = (v) => ollama.resolveHost(v === undefined ? {} : { OLLAMA_HOST: v });
        assert.deepEqual(r(), { url: 'http://127.0.0.1:11434', hostname: '127.0.0.1', local: true });
        assert.deepEqual(r('localhost'), { url: 'http://localhost:11434', hostname: 'localhost', local: true });
        assert.deepEqual(r('127.0.0.1:9000'), { url: 'http://127.0.0.1:9000', hostname: '127.0.0.1', local: true });
        assert.deepEqual(r(':9000'), { url: 'http://127.0.0.1:9000', hostname: '127.0.0.1', local: true });
        assert.deepEqual(r('http://[::1]:11434/'), { url: 'http://[::1]:11434', hostname: '::1', local: true });
        assert.deepEqual(r('0.0.0.0'), { url: 'http://127.0.0.1:11434', hostname: '127.0.0.1', local: true });
        assert.deepEqual(r('https://ollama.example.com'), { url: 'https://ollama.example.com', hostname: 'ollama.example.com', local: false });
        assert.equal(r('192.168.1.20:11434').local, false);
        assert.throws(() => r('ftp://x'), /只接受 http/);
    });

    test('warnIfRemoteHost：非本機才警告、同一行程只印一次；本機與未設都不印', () => {
        const seen = [];
        const orig = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            for (const v of [undefined, 'localhost', '127.0.0.1:11434', 'http://[::1]:11434', '0.0.0.0']) {
                assert.equal(ollama.warnIfRemoteHost(v === undefined ? {} : { OLLAMA_HOST: v }), false, String(v));
            }
            assert.equal(seen.length, 0);
            assert.equal(ollama.warnIfRemoteHost({ OLLAMA_HOST: 'http://192.168.1.20:11434' }), true);
            assert.match(seen[0], /OLLAMA_HOST=http:\/\/192\.168\.1\.20:11434 不是本機/);
            assert.match(seen[0], /零外連/);
            assert.equal(ollama.warnIfRemoteHost({ OLLAMA_HOST: 'gpu-box' }), false, '同一行程只警告一次');
            assert.equal(seen.length, 1);
        } finally {
            console.warn = orig;
        }
    });

    test('第一次真的呼叫 Ollama 時也會檢查（獨立跑的 worker 也看得到警告）', async () => {
        process.env.OLLAMA_HOST = 'http://10.0.0.8:11434';
        const calls = fakeTransport(() => chatOk('{}'));
        const seen = [];
        const orig = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            await ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] });
        } finally {
            console.warn = orig;
        }
        assert.equal(calls[0].url, 'http://10.0.0.8:11434/api/chat');
        assert.equal(seen.length, 1);
    });
});

// ───────────────────────── 真的傳輸（node:http）對 127.0.0.1 的假伺服器 ─────────────────────────

describe('node:http 傳輸（127.0.0.1 上的假 Ollama）', () => {
    let server;
    let port;
    const hits = [];

    before(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                const body = raw ? JSON.parse(raw) : null;
                hits.push({ url: req.url, method: req.method, contentType: req.headers['content-type'], body });
                if (body && body.model === 'hang') return;            // 永遠不回：測中止
                if (body && body.model === 'missing') {
                    res.writeHead(404, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'model "missing" not found, try pulling it first' }));
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                if (req.url === '/api/embed') return res.end(JSON.stringify({ embeddings: [[1, 0]], prompt_eval_count: 2 }));
                return res.end(JSON.stringify({ message: { role: 'assistant', content: '{"中文":"可以"}' }, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 }));
            });
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    });

    beforeEach(() => {
        process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
    });

    test('成功路徑：POST JSON、UTF-8 正確、回傳解析', async () => {
        const res = await ollama.generateJson({ model: 'qwen3:8b', system: '系統', parts: [{ text: '中文題目' }] });
        assert.deepEqual(res.data, { 中文: '可以' });
        const hit = hits.at(-1);
        assert.equal(hit.method, 'POST');
        assert.equal(hit.url, '/api/chat');
        assert.equal(hit.contentType, 'application/json');
        assert.equal(hit.body.messages[1].content, '中文題目');
        const e = await ollama.embed({ model: 'qwen3-embedding:0.6b', texts: ['x'], dim: 2 });
        assert.deepEqual(e.vectors, [[1, 0]]);
    });

    test('404 模型不存在 → provider_error 附 ollama pull', async () => {
        await assert.rejects(() => ollama.generateJson({ model: 'missing', parts: [{ text: 'x' }] }), /ollama pull missing/);
    });

    test('伺服器遲遲不回：signal 中止 → timeout；OLLAMA_TIMEOUT_MS 到 → timeout', async () => {
        const ac = new AbortController();
        const p = ollama.generateText({ model: 'hang', parts: [{ text: 'x' }], signal: ac.signal });
        setTimeout(() => ac.abort(), 30);
        await assert.rejects(p, (err) => err.errorClass === 'timeout');
        process.env.OLLAMA_TIMEOUT_MS = '40';
        await assert.rejects(() => ollama.generateText({ model: 'hang', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'timeout');
            assert.match(err.message, /OLLAMA_TIMEOUT_MS/);
            return true;
        });
    });

    test('沒有東西在聽（Ollama 沒開）→ provider_error「Ollama 沒有在執行，請先開啟 Ollama」', async () => {
        const closed = http.createServer();
        await new Promise(r => closed.listen(0, '127.0.0.1', r));
        const deadPort = closed.address().port;
        await new Promise(r => closed.close(r));
        process.env.OLLAMA_HOST = `127.0.0.1:${deadPort}`;
        await assert.rejects(() => ollama.generateJson({ model: 'qwen3:8b', parts: [{ text: 'x' }] }), (err) => {
            assert.equal(err.errorClass, 'provider_error');
            assert.match(err.message, /Ollama 沒有在執行，請先開啟 Ollama/);
            assert.match(err.message, /ECONNREFUSED/);
            return true;
        });
    });
});
