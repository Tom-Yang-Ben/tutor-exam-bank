// services/llm 的 generateText、音訊／圖片 parts 與三個新模型設定（階段 5 WS-E）
//
// 契約：docs/interfaces-stage5.md 第 5.1、5.2 條。
// 全部不連 Gemini：gemini.js 以 _setClientForTest 注入假 client，record 模式則把 gemini.generateText
// 換成假函式；cassette 一律寫進暫存目錄（EVAL_CASSETTE_DIR），不碰 repo 的 eval/cassettes。
//
// 兩件事是回歸保護，不是新功能：
//   - toContents 既有三種 part（text／pdfBase64／fileUri）的輸出逐字不變；
//   - gemini.generateJson 送出的 config 形狀不變（responseMimeType + responseJsonSchema）。
//
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const gemini = require('../../services/llm/gemini');
const cassette = require('../../services/llm/cassette');
const fake = require('../../services/llm/fake');
const throttle = require('../../services/llm/throttle');
const llm = require('../../services/llm');
const models = require('../../config/models');
const templates = require('../../services/llm/templates');

// 本檔的假 agent 也照第 1.2 條註冊模板原文（不然 templateHash 會印「沒有註冊原文」的警告）
templates.registerTemplate('gentext.v1', 'SYSTEM\n---\nPROMPT');
templates.registerTemplate('gentext_rec.v1', 'SYSTEM\n---\nPROMPT {{x}}');

let tmpDir;
const envBackup = {};
const ENV_KEYS = ['EVAL_CASSETTE_DIR', 'LLM_MODE', 'MODEL_EXTRACT', 'MODEL_VERIFY',
    'MODEL_TUTOR', 'MODEL_VOICE', 'MODEL_KC_TAG', 'MODEL_VARIANT'];

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-gentext-'));
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
    process.env.EVAL_CASSETTE_DIR = tmpDir;
    process.env.LLM_MODE = 'replay';
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    gemini._setClientForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    fake._resetForTest();
    throttle._resetForTest();
});

/** 假 SDK client：記下 generateContent 收到的參數，回傳排好的回應 */
function fakeClient(response) {
    const calls = [];
    return {
        calls,
        models: {
            async generateContent(req) {
                calls.push(req);
                return typeof response === 'function' ? response(req) : response;
            }
        }
    };
}

// ───────────────────────── toContents ─────────────────────────

describe('gemini.toContents — 既有三種 part 逐字不變，新增音訊與圖片（第 5.1 條）', () => {
    test('text／pdfBase64／fileUri 的輸出與階段 2 完全相同', () => {
        assert.deepEqual(gemini.toContents([
            { text: '題目' },
            { pdfBase64: 'JVBERi0=' },
            { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' }
        ]), [
            { text: '題目' },
            { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
            { fileData: { mimeType: 'application/pdf', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } }
        ]);
    });

    test('音訊與圖片走 inlineData，mimeType 原樣帶上', () => {
        assert.deepEqual(gemini.toContents([
            { audioBase64: 'AAAA', mimeType: 'audio/webm' },
            { imageBase64: 'iVBORw0K', mimeType: 'image/png' }
        ]), [
            { inlineData: { mimeType: 'audio/webm', data: 'AAAA' } },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } }
        ]);
    });

    test('音訊／圖片沒給 mimeType → 丟錯（不猜格式）', () => {
        assert.throws(() => gemini.toContents([{ audioBase64: 'AAAA' }]), /mimeType/);
        assert.throws(() => gemini.toContents([{ imageBase64: 'AAAA', mimeType: '  ' }]), /mimeType/);
    });

    test('不認得的 part 仍然丟錯', () => {
        assert.throws(() => gemini.toContents([{ videoBase64: 'x' }]), /parts 只接受/);
    });

    test('空或沒給 parts → 空陣列（與階段 2 相同）', () => {
        assert.deepEqual(gemini.toContents(undefined), []);
        assert.deepEqual(gemini.toContents([]), []);
    });
});

// ───────────────────────── parseTextResponse ─────────────────────────

describe('gemini.parseTextResponse — text 與 code execution 的 parts 拆解', () => {
    test('text 串接、thought 跳過、executableCode 與 codeExecutionResult 依序配對', () => {
        const res = {
            candidates: [{
                content: {
                    parts: [
                        { text: '（思考中）', thought: true },
                        { text: '先列式。' },
                        { executableCode: { language: 'PYTHON', code: 'print(1+2)' } },
                        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '3\n' } },
                        { text: '所以答案是 $3$。' },
                        { executableCode: { language: 'PYTHON', code: 'raise ValueError' } },
                        { codeExecutionResult: { outcome: 'OUTCOME_FAILED', output: 'ValueError' } }
                    ]
                }
            }]
        };
        const out = gemini.parseTextResponse(res);
        assert.equal(out.text, '先列式。所以答案是 $3$。');
        assert.deepEqual(out.codeRuns, [
            { language: 'PYTHON', code: 'print(1+2)', outcome: 'OUTCOME_OK', output: '3\n' },
            { language: 'PYTHON', code: 'raise ValueError', outcome: 'OUTCOME_FAILED', output: 'ValueError' }
        ]);
    });

    test('有 id 時以 id 對應（結果不按順序回來也配得對）', () => {
        const out = gemini.parseTextResponse({
            candidates: [{
                content: {
                    parts: [
                        { executableCode: { language: 'PYTHON', code: 'a', id: 'c1' } },
                        { executableCode: { language: 'PYTHON', code: 'b', id: 'c2' } },
                        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: 'B', id: 'c2' } },
                        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: 'A', id: 'c1' } }
                    ]
                }
            }]
        });
        assert.deepEqual(out.codeRuns.map(r => [r.code, r.output]), [['a', 'A'], ['b', 'B']]);
    });

    test('沒有程式碼的結果也保留（寧可多呈現，不可默默丟掉）；沒有結果的程式碼 outcome 為 null', () => {
        const out = gemini.parseTextResponse({
            candidates: [{
                content: {
                    parts: [
                        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: 'orphan' } },
                        { executableCode: { language: 'PYTHON', code: 'x = 1' } }
                    ]
                }
            }]
        });
        assert.deepEqual(out.codeRuns, [
            { language: 'PYTHON', code: '', outcome: 'OUTCOME_OK', output: 'orphan' },
            { language: 'PYTHON', code: 'x = 1', outcome: null, output: '' }
        ]);
    });

    test('空回應 → 空字串與空陣列（不丟錯，由呼叫端決定怎麼呈現）', () => {
        assert.deepEqual(gemini.parseTextResponse({}), { text: '', codeRuns: [] });
        assert.deepEqual(gemini.parseTextResponse(null), { text: '', codeRuns: [] });
    });
});

// ───────────────────────── gemini.generateText／generateJson（假 client）─────────────────────────

describe('gemini.generateText — 送出的 config（假 client）', () => {
    afterEach(() => gemini._setClientForTest(null));

    test('codeExecution:true → tools=[{codeExecution:{}}]；systemInstruction；不設 responseMimeType', async () => {
        const client = fakeClient({
            candidates: [{ content: { parts: [{ text: '好' }] } }],
            usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 5 }
        });
        gemini._setClientForTest(client);
        const out = await gemini.generateText({
            model: 'gemini-3.1-pro-preview', system: '你是家教', parts: [{ text: '1+1=?' }],
            tools: { codeExecution: true }, maxOutputTokens: 512
        });
        const req = client.calls[0];
        assert.equal(req.model, 'gemini-3.1-pro-preview');
        assert.deepEqual(req.contents, [{ text: '1+1=?' }]);
        assert.deepEqual(req.config.tools, [{ codeExecution: {} }]);
        assert.equal(req.config.systemInstruction, '你是家教');
        assert.equal(req.config.maxOutputTokens, 512);
        assert.equal(req.config.responseMimeType, undefined);
        assert.equal(req.config.responseJsonSchema, undefined);
        assert.equal(out.text, '好');
        // code execution 的結果回灌（toolUsePromptTokenCount）以 input 計價，要算進 tokenIn
        assert.deepEqual(out.usage, { tokenIn: 130, tokenOut: 20, tokenThinking: 5, tokenCached: 0 });
    });

    test('沒開 codeExecution → 不帶 tools', async () => {
        const client = fakeClient({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
        gemini._setClientForTest(client);
        await gemini.generateText({ model: 'm', parts: [{ text: 'q' }] });
        assert.equal(client.calls[0].config.tools, undefined);
        assert.equal(client.calls[0].config.systemInstruction, undefined);
    });

    test('音訊 part 經 generateJson 送出時是 inlineData；generateJson 的 config 形狀不變', async () => {
        const client = fakeClient({ text: '{"ok":true}', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
        gemini._setClientForTest(client);
        const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
        const out = await gemini.generateJson({
            model: 'gemini-3.5-flash', system: 'S', schema,
            parts: [{ text: 'T' }, { audioBase64: 'AAAA', mimeType: 'audio/ogg' }]
        });
        const req = client.calls[0];
        assert.deepEqual(req.contents, [{ text: 'T' }, { inlineData: { mimeType: 'audio/ogg', data: 'AAAA' } }]);
        assert.deepEqual(req.config, { responseMimeType: 'application/json', systemInstruction: 'S', responseJsonSchema: schema });
        assert.deepEqual(out.data, { ok: true });
        assert.deepEqual(out.usage, { tokenIn: 7, tokenOut: 3, tokenThinking: 0, tokenCached: 0 });
    });
});

// ───────────────────────── replay（fake.generateText）─────────────────────────

function writeTextCassette({ agent, modelId, template, cacheKeyParts, response }) {
    const key = cassette.cassetteKey({ agent, modelId, template, schema: undefined, cacheKeyParts });
    cassette.writeCassette({ agent, key, meta: { agent, model: modelId }, request: {}, response });
    return key;
}

describe('LLM_MODE=replay 的 generateText（services/llm/fake.js）', () => {
    test('命中：回 text／codeRuns／usage 四欄，並經 services/llm 剝掉 vendor 前綴', async () => {
        const key = writeTextCassette({
            agent: 'gentext_hit', modelId: 'gemini-3.1-pro-preview', template: 'gentext.v1',
            cacheKeyParts: { q: 1 },
            response: {
                text: '答案是 $2$。',
                codeRuns: [{ language: 'PYTHON', code: 'print(1+1)', outcome: 'OUTCOME_OK', output: '2' }],
                usage: { tokenIn: 10, tokenOut: 5 }
            }
        });
        const out = await llm.generateText({
            model: 'gemini:gemini-3.1-pro-preview', agent: 'gentext_hit', template: 'gentext.v1',
            cacheKeyParts: { q: 1 }, parts: [{ text: '1+1' }], tools: { codeExecution: true }
        });
        assert.equal(out.text, '答案是 $2$。');
        assert.deepEqual(out.codeRuns, [{ language: 'PYTHON', code: 'print(1+1)', outcome: 'OUTCOME_OK', output: '2' }]);
        assert.deepEqual(out.usage, { tokenIn: 10, tokenOut: 5, tokenThinking: 0, tokenCached: 0 });
        assert.equal(out.replayed, true);
        assert.equal(out.cassetteKey, key);
    });

    test('cassette 沒有 codeRuns → 空陣列（舊格式或沒有驗算的回覆）', async () => {
        writeTextCassette({ agent: 'gentext_noruns', modelId: 'm1', cacheKeyParts: {}, response: { text: 'hi' } });
        const out = fake.generateText({ model: 'm1', agent: 'gentext_noruns', cacheKeyParts: {} });
        assert.deepEqual(out.codeRuns, []);
    });

    test('miss：丟錯，訊息開頭與 generateJson 的 miss 同一串（eval/lib/replayMiss 認得出來）', () => {
        const rm = require('../../eval/lib/replayMiss');
        let err = null;
        try { fake.generateText({ model: 'm', agent: 'gentext_miss', cacheKeyParts: { x: 1 } }); } catch (e) { err = e; }
        assert.ok(err, '應該丟錯');
        assert.ok(err.message.startsWith('LLM_MODE=replay 找不到 cassette（agent=gentext_miss key='), err.message);
        assert.equal(rm.isReplayMiss(err), true);
    });

    test('cassette 缺 response.text → 丟錯（不回假資料）', () => {
        writeTextCassette({ agent: 'gentext_bad', modelId: 'm', cacheKeyParts: {}, response: { data: { a: 1 } } });
        assert.throws(() => fake.generateText({ model: 'm', agent: 'gentext_bad', cacheKeyParts: {} }), /缺少 response\.text/);
    });

    test('沒給 agent → 丟錯（同 generateJson）', () => {
        assert.throws(() => fake.generateText({ model: 'm', cacheKeyParts: {} }), /agent 是必填/);
    });
});

// ───────────────────────── record → replay 一輪 ─────────────────────────

describe('LLM_MODE=record 的 generateText：寫 cassette、之後 replay 讀得回來', () => {
    let original;
    beforeEach(() => { original = gemini.generateText; });
    afterEach(() => { gemini.generateText = original; process.env.LLM_MODE = 'replay'; });

    test('response 存 {text, codeRuns, usage}；request 只存摘要（音訊只留位元組數與 sha256）', async () => {
        const audio = Buffer.from('fake-audio-bytes');
        gemini.generateText = async (opts) => {
            assert.equal(opts.model, 'gemini-3.5-flash', 'vendor 前綴要先剝掉');
            return {
                text: '錄到了', codeRuns: [{ language: 'PYTHON', code: 'print(2)', outcome: 'OUTCOME_OK', output: '2' }],
                usage: { tokenIn: 3, tokenOut: 4, tokenThinking: 0, tokenCached: 0 }, latencyMs: 12, raw: {}
            };
        };
        process.env.LLM_MODE = 'record';
        const logs = [];
        const realLog = console.log;
        console.log = (m) => logs.push(String(m));
        const opts = {
            model: 'gemini:gemini-3.5-flash', agent: 'gentext_rec', template: 'gentext_rec.v1',
            cacheKeyParts: { k: 'v' }, tools: { codeExecution: true },
            parts: [{ text: '題幹全文不該進 cassette' }, { audioBase64: audio.toString('base64'), mimeType: 'audio/webm' }]
        };
        try {
            await llm.generateText(opts);
        } finally {
            console.log = realLog;
        }
        assert.ok(logs.some(l => l.startsWith('[llm:record] 寫入 cassette')), logs.join('\n'));

        const key = cassette.cassetteKey({ agent: 'gentext_rec', modelId: 'gemini-3.5-flash', template: 'gentext_rec.v1', cacheKeyParts: { k: 'v' } });
        const saved = JSON.parse(fs.readFileSync(cassette.cassettePath('gentext_rec', key), 'utf8'));
        assert.equal(saved.response.text, '錄到了');
        assert.equal(saved.response.codeRuns.length, 1);
        assert.deepEqual(saved.request.tools, { codeExecution: true });
        const raw = JSON.stringify(saved);
        assert.ok(!raw.includes('題幹全文不該進 cassette'), 'request 不得存 prompt 原文');
        assert.ok(!raw.includes(audio.toString('base64')), 'request 不得存音訊 base64');
        assert.deepEqual(saved.request.parts[1], {
            kind: 'audio', mimeType: 'audio/webm', bytes: audio.length,
            sha256: crypto.createHash('sha256').update(audio).digest('hex')
        });

        // 同一組參數改用 replay：讀回同一支
        process.env.LLM_MODE = 'replay';
        const replayed = await llm.generateText(opts);
        assert.equal(replayed.text, '錄到了');
        assert.equal(replayed.codeRuns[0].output, '2');
    });
});

// ───────────────────────── cassette.summarizeParts ─────────────────────────

describe('cassette.summarizeParts — 音訊與圖片', () => {
    test('圖片：kind=image、mimeType、bytes、sha256；既有三種不變', () => {
        const img = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const out = cassette.summarizeParts([
            { imageBase64: img.toString('base64'), mimeType: 'image/png' },
            { fileUri: 'u' },
            { somethingElse: 1 }
        ]);
        assert.deepEqual(out[0], {
            kind: 'image', mimeType: 'image/png', bytes: 4,
            sha256: crypto.createHash('sha256').update(img).digest('hex')
        });
        assert.deepEqual(out[1], { kind: 'fileUri', uri: 'u' });
        assert.deepEqual(out[2], { kind: 'unknown' });
    });
});

// ───────────────────────── config/models.js 的三個新 getter ─────────────────────────

describe('config/models.js — MODEL_TUTOR／MODEL_VOICE／MODEL_KC_TAG（第 5.2 條）', () => {
    afterEach(() => {
        for (const k of ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TUTOR', 'MODEL_VOICE', 'MODEL_KC_TAG']) delete process.env[k];
    });

    test('未設時：TUTOR 沿用 MODEL_VERIFY、VOICE 與 KC_TAG 沿用 MODEL_EXTRACT（即時跟著變）', () => {
        process.env.MODEL_VERIFY = 'gemini:verify-x';
        process.env.MODEL_EXTRACT = 'gemini:extract-y';
        assert.equal(models.MODEL_TUTOR, 'gemini:verify-x');
        assert.equal(models.MODEL_VOICE, 'gemini:extract-y');
        assert.equal(models.MODEL_KC_TAG, 'gemini:extract-y');
        process.env.MODEL_VERIFY = 'gemini:verify-z';
        assert.equal(models.MODEL_TUTOR, 'gemini:verify-z');
    });

    test('有設就用設的值；空白視為未設', () => {
        process.env.MODEL_TUTOR = 'gemini:tutor-a';
        process.env.MODEL_VOICE = 'gemini:voice-b';
        process.env.MODEL_KC_TAG = '   ';
        assert.equal(models.MODEL_TUTOR, 'gemini:tutor-a');
        assert.equal(models.MODEL_VOICE, 'gemini:voice-b');
        assert.equal(models.MODEL_KC_TAG, models.MODEL_EXTRACT);
    });

    test('既有 getter 行為不變（MODEL_VARIANT 未設仍回 null）', () => {
        for (const k of ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_VARIANT']) delete process.env[k];
        assert.equal(models.MODEL_VARIANT, null);
        assert.equal(models.MODEL_EXTRACT, 'gemini:gemini-3.5-flash');
        assert.equal(models.MODEL_VERIFY, 'gemini:gemini-3.1-pro-preview');
    });
});
