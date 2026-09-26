// 〔看圖拆題逾時〕選項 b：送給視覺模型前把頁面圖片縮小（VISION_MAX_EDGE_PX；docs/local-mode.md 第 10.11 條）
//
// 證明：
//   1. 預設（沒設、0、亂填）不縮：送給視覺模型的位元組與之前完全相同，連縮圖的函式都不呼叫。
//   2. 開了才縮：長邊不超過上限、等比例、只縮不放；本來就夠小的那張原樣送。
//   3. 只動視覺模型看到的圖：cassette 的鍵（cacheKeyParts）、OCR 的呼叫、OCR 版的請求都不變；replay 不送圖也不縮。
// 不需要 Python、Ollama；圖片用 sharp 當場造。
//
// 執行：npm test

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const extract = require('../../agents/extract');
const render = require('../../services/ocr/render');

const MATH = {
    subject: '數學', chapter: '向量內積', chapter_confidence: 0.92, question_type: '計算', difficulty: 3,
    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。', answer_text: '$1$'
};
const USAGE = { tokenIn: 10, tokenOut: 20, tokenThinking: 0, tokenCached: 0 };
const CHUNK = { no: 2, fromPage: 3, toPage: 4 };

/** A4 在 200 DPI 的大小（1654×2339）與一張本來就小的圖 */
let bigPng;
let smallPng;
let pdf;
let tmp;
const savedEnv = process.env.VISION_MAX_EDGE_PX;

before(async () => {
    bigPng = await sharp({ create: { width: 1654, height: 2339, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    smallPng = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i++) doc.addPage([200, 200]);
    pdf = Buffer.from(await doc.save());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-max-edge-'));
    delete process.env.VISION_MAX_EDGE_PX;
});

after(() => {
    extract._setLocalDepsForTest({});
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.VISION_MAX_EDGE_PX; else process.env.VISION_MAX_EDGE_PX = savedEnv;
});

afterEach(() => {
    extract._setLocalDepsForTest({});
    delete process.env.VISION_MAX_EDGE_PX;
});

function fakeCtx(ocrConfig = {}) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data: { questions: [MATH] }, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
                }
            },
            db: null,
            job: { id: 1, kind: 'pdf', budget_usd: 1, cost_usd: 0 },
            jq: null,
            logger: { info() { }, warn() { }, error() { } },
            config: {
                models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b' },
                thresholds: { pdfChunkPages: 2, inlineMaxBytes: 15728640 },
                ocr: { engine: 'paddle', ...ocrConfig }
            },
            signal: undefined
        }
    };
}

/** 假 OCR：兩頁、各一張真的 PNG（第 3 頁大、第 4 頁小） */
function useDeps({ mode = 'live', fitLongEdge, visionMaxEdge } = {}) {
    const state = { ocrCalls: [], fitCalls: [] };
    extract._setLocalDepsForTest({
        ocrPdf: async (opts) => {
            state.ocrCalls.push(opts);
            const dir = fs.mkdtempSync(path.join(tmp, 'ocr-'));
            const p3 = path.join(dir, 'p3.png');
            const p4 = path.join(dir, 'p4.png');
            fs.writeFileSync(p3, bigPng);
            fs.writeFileSync(p4, smallPng);
            return {
                engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, replayed: mode === 'replay',
                pages: [
                    { page: 3, markdown: '第 3 頁', imagePath: mode === 'replay' ? null : p3 },
                    { page: 4, markdown: '第 4 頁', imagePath: mode === 'replay' ? null : p4 }
                ],
                dispose: () => fs.rmSync(dir, { recursive: true, force: true })
            };
        },
        renderPages: async () => { throw new Error('有 OCR 的圖就不該再渲染'); },
        llmMode: () => mode,
        ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
        ...(fitLongEdge ? { fitLongEdge: async (pngs, maxEdge) => { state.fitCalls.push(maxEdge); return fitLongEdge(pngs, maxEdge); } } : {}),
        ...(visionMaxEdge ? { visionMaxEdge } : {})
    });
    return state;
}

async function dims(b64) {
    const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
    return [meta.width, meta.height];
}

describe('services/ocr/render：VISION_MAX_EDGE_PX 與 fitLongEdge', () => {
    test('visionMaxEdgeFromEnv：未設、空白、0、非整數、太小、太大一律 0（不縮）；合法值原樣', () => {
        for (const bad of [undefined, '', '  ', '0', '-1', 'abc', '100', '511', '10001']) {
            assert.equal(render.visionMaxEdgeFromEnv(bad === undefined ? {} : { VISION_MAX_EDGE_PX: bad }), 0, String(bad));
        }
        assert.equal(render.visionMaxEdgeFromEnv({ VISION_MAX_EDGE_PX: '1600' }), 1600);
        assert.equal(render.visionMaxEdgeFromEnv({ VISION_MAX_EDGE_PX: '512' }), render.VISION_MAX_EDGE_MIN);
        assert.equal(render.visionMaxEdgeFromEnv({}), 0, '預設：不縮');
    });

    test('fitLongEdge：上限 ≤ 0 時原樣回傳同一個陣列；長邊超過才縮（等比例、PNG）；本來就夠小的那張是同一個 Buffer', async () => {
        const input = [bigPng, smallPng];
        assert.equal(await render.fitLongEdge(input, 0), input);
        assert.equal(await render.fitLongEdge(input, undefined), input);
        const out = await render.fitLongEdge(input, 1600);
        const m = await sharp(out[0]).metadata();
        assert.equal(m.format, 'png');
        assert.equal(Math.max(m.width, m.height), 1600);
        assert.ok(Math.abs(m.width / m.height - 1654 / 2339) < 0.005, `比例不變：${m.width}×${m.height}`);
        assert.equal(out[1], smallPng, '800×600 不超過 1600：不重新編碼');
        assert.ok(out[0].length < bigPng.length || m.width < 1654);
    });
});

describe('agents/extract 本機路徑：預設不縮，開了才縮，鍵不變', () => {
    test('預設（沒設 VISION_MAX_EDGE_PX、ctx 沒帶）：送出的 PNG 位元組與 OCR 的原圖相同，縮圖函式一次都不呼叫', async () => {
        const st = useDeps({ fitLongEdge: () => { throw new Error('預設不該縮圖'); } });
        const { ctx, calls } = fakeCtx();
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome));
        const v = calls.find(c => c.agent === 'extract_vision');
        assert.deepEqual(v.parts.slice(1), [
            { imageBase64: bigPng.toString('base64'), mimeType: 'image/png' },
            { imageBase64: smallPng.toString('base64'), mimeType: 'image/png' }
        ]);
        assert.deepEqual(st.fitCalls, []);
    });

    test('ctx.config.ocr.visionMaxEdge＝800：長邊縮到 800 以內；cacheKeyParts、OCR 呼叫、OCR 版的請求與不縮時完全相同', async () => {
        useDeps();
        const plain = fakeCtx();
        await extract.run(plain.ctx, { pdfBytes: pdf, chunk: CHUNK });

        const st = useDeps({ fitLongEdge: render.fitLongEdge });
        const small = fakeCtx({ visionMaxEdge: 800 });
        const outcome = await extract.run(small.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(st.fitCalls, [800]);

        const v0 = plain.calls.find(c => c.agent === 'extract_vision');
        const v1 = small.calls.find(c => c.agent === 'extract_vision');
        assert.deepEqual(await dims(v1.parts[1].imageBase64), [566, 800], '1654×2339 → 長邊 800、等比例');
        assert.deepEqual(await dims(v1.parts[2].imageBase64), [800, 600], '800×600 本來就不超過');
        assert.equal(v1.parts[2].imageBase64, smallPng.toString('base64'));
        assert.deepEqual(v1.cacheKeyParts, v0.cacheKeyParts, 'cassette 的鍵不含圖片：不必重錄');
        assert.equal(v1.template, v0.template);
        assert.equal(v1.parts[0].text, v0.parts[0].text, '提示詞一字不差');
        assert.deepEqual(small.calls.find(c => c.agent === 'extract_ocr'), plain.calls.find(c => c.agent === 'extract_ocr'), 'OCR 版不受影響');
        assert.deepEqual(st.ocrCalls[0].fromPage, 3);
    });

    test('沒帶 ctx 設定時讀 VISION_MAX_EDGE_PX（services/ocr/render 讀，agent 不碰 process.env）', async () => {
        process.env.VISION_MAX_EDGE_PX = '1000';
        const st = useDeps({ fitLongEdge: render.fitLongEdge });
        const { ctx, calls } = fakeCtx();
        await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.deepEqual(st.fitCalls, [1000]);
        const v = calls.find(c => c.agent === 'extract_vision');
        const [w, h] = await dims(v.parts[1].imageBase64);
        assert.equal(Math.max(w, h), 1000);
    });

    test('ctx 明寫 0：不縮（即使環境變數有設）', async () => {
        process.env.VISION_MAX_EDGE_PX = '1000';
        const st = useDeps({ fitLongEdge: () => { throw new Error('ctx 明寫 0 不該縮'); } });
        const { ctx } = fakeCtx({ visionMaxEdge: 0 });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(st.fitCalls, []);
    });

    test('replay：不送圖片，也不縮（CI 的回放不受影響）', async () => {
        const st = useDeps({ mode: 'replay', fitLongEdge: () => { throw new Error('replay 不該縮圖'); }, visionMaxEdge: () => 800 });
        const { ctx, calls } = fakeCtx({ visionMaxEdge: 800 });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.equal(calls.find(c => c.agent === 'extract_vision').parts.length, 1, '只有文字');
        assert.deepEqual(st.fitCalls, []);
    });
});
