// agents/extract.js 本機路徑的單元測試（〔本機模式 L2〕docs/local-mode.md 第 4 條第 3 點）
//
// ctx.llm 用注入的假物件；OCR、頁面渲染、LLM_MODE 用 extract._setLocalDepsForTest 換掉——
// 不需要 Python、Ollama、mupdf，也不讀 cassette。
// config/models.js 的 parseModel 在 L1 合入前還不認得 'ollama:'，這裡暫時包一層（只多認 ollama，其餘原樣轉交）；
// L1 合入之後這層包裝等於原函式，不影響結果。
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument } = require('pdf-lib');

const extract = require('../../agents/extract');
const models = require('../../config/models');
const { buildSchema } = require('../../agents/schemas');
const { getTemplate, templateHash, sha256Hex } = require('../../services/llm/templates');
const ocrService = require('../../services/ocr');
const { isReplayMiss } = require('../../eval/lib/replayMiss');
const { CHAPTERS } = require('../../config/chapters');

const ORIGINAL_PARSE = models.parseModel;
function parseWithOllama(spec) {
    const raw = String(spec ?? '').trim();
    if (raw.toLowerCase().startsWith('ollama:')) {
        const id = raw.slice(raw.indexOf(':') + 1).trim();
        return { vendor: 'ollama', id, spec: `ollama:${id}` };
    }
    return ORIGINAL_PARSE(spec);
}

async function makePdf(pages) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
    return Buffer.from(await doc.save());
}

const MATH = {
    subject: '數學', chapter: '向量內積', chapter_confidence: 0.92, question_type: '計算', difficulty: 3,
    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。', answer_text: '$1$'
};
const MATH2 = {
    ...MATH, question_type: '單選',
    question_text: '若 $\\log_2 x = 3$，則 $x$ 為何？(A) $6$ (B) $8$ (C) $9$ (D) $12$', answer_text: '(B)'
};
const CHEM_Q = {
    subject: '化學', chapter: '化學平衡與平衡常數', chapter_confidence: 0.93, question_type: '計算', difficulty: 3,
    question_text: '定溫下 $\\ce{N2 + 3H2 <=> 2NH3}$ 達平衡，已知各物質濃度，求平衡常數 $K_c$。', answer_text: '$K_c = 0.50$'
};

const USAGE = { tokenIn: 10, tokenOut: 20, tokenThinking: 0, tokenCached: 0 };
const PNG1 = Buffer.from('fake-png-page-3');
const PNG2 = Buffer.from('fake-png-page-4');

/**
 * 假 ctx：依 agent 名回不同的資料。responses 的值可以是函式（拿到 opts 自己決定）或 Error（丟出去）。
 * @returns {{ctx, calls:Array<object>, events:string[]}}
 */
function fakeCtx({ vision = { questions: [MATH] }, ocr = { questions: [MATH] }, models: m, job = {}, config = {}, events = [] } = {}) {
    const calls = [];
    const answer = (spec, opts) => {
        const v = typeof spec === 'function' ? spec(opts) : spec;
        if (v instanceof Error) throw v;
        return { data: v, usage: USAGE, latencyMs: 7, raw: null, schemaFallback: false };
    };
    return {
        calls,
        events,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    events.push(`llm:${opts.agent}`);
                    if (/^extract_vision/.test(opts.agent)) return answer(vision, opts);
                    if (/^extract_ocr/.test(opts.agent)) return answer(ocr, opts);
                    if (opts.agent === 'extract' || opts.agent === 'extract_chem') return answer(vision, opts);   // Gemini 路徑
                    throw new Error(`沒預期的 agent ${opts.agent}`);
                }
            },
            db: null,
            job: { id: 1, kind: 'pdf', budget_usd: 1, cost_usd: 0, ...job },
            jq: null,
            logger: { info() { }, warn() { }, error() { } },
            config: {
                models: m || { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', ocrStructure: 'ollama:qwen3:8b-ocr' },
                thresholds: { pdfChunkPages: 2, inlineMaxBytes: 15728640 },
                ...config
            },
            signal: undefined
        }
    };
}

/** 假 OCR：記下參數，回兩頁 markdown 與（可選）真的暫存 PNG */
function fakeOcr({ withImages = true, error = null, events = [] } = {}) {
    const state = { calls: [], disposed: 0, dir: null };
    state.ocrPdf = async (opts) => {
        state.calls.push(opts);
        events.push('ocr');
        if (error) throw error;
        let images = [null, null];
        if (withImages) {
            state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-local-'));
            images = [path.join(state.dir, 'p3.png'), path.join(state.dir, 'p4.png')];
            fs.writeFileSync(images[0], PNG1);
            fs.writeFileSync(images[1], PNG2);
        }
        const pages = [];
        for (let p = opts.fromPage, i = 0; p <= opts.toPage; p++, i++) {
            pages.push({ page: p, markdown: `第 ${p} 頁的 OCR 文字`, imagePath: images[i] ?? null });
        }
        return {
            engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, pages, replayed: false,
            dispose: () => {
                state.disposed += 1;
                if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
            }
        };
    };
    return state;
}

function fakeRender(events = []) {
    const state = { calls: [] };
    state.renderPages = async (opts) => {
        state.calls.push(opts);
        events.push('render');
        const out = [];
        for (let p = opts.fromPage; p <= opts.toPage; p++) out.push(Buffer.from(`rendered-${p}`));
        return out;
    };
    return state;
}

function useDeps({ ocr, render, mode = 'live', engine = 'paddle', dpi = 200 } = {}) {
    extract._setLocalDepsForTest({
        ...(ocr ? { ocrPdf: ocr.ocrPdf } : { ocrPdf: async () => { throw new Error('不該呼叫 OCR'); } }),
        ...(render ? { renderPages: render.renderPages } : { renderPages: async () => { throw new Error('不該呼叫 renderPages'); } }),
        llmMode: () => mode,
        ocrConfig: () => ({ engine, dpi })
    });
}

const CHUNK = { no: 2, fromPage: 3, toPage: 4 };

describe('extract 本機路徑', () => {
    let pdf;
    let pdfSha;
    before(async () => {
        models.parseModel = parseWithOllama;
        pdf = await makePdf(5);
        pdfSha = crypto.createHash('sha256').update(pdf).digest('hex');
    });
    after(() => {
        models.parseModel = ORIGINAL_PARSE;
        extract._setLocalDepsForTest({});
    });
    afterEach(() => extract._setLocalDepsForTest({}));

    describe('分流', () => {
        test('isLocalExtract：只有 vendor=ollama 才走本機路徑；解析失敗一律走原路徑', () => {
            const ctxOf = (extractModel) => ({ config: { models: { extract: extractModel } } });
            assert.equal(extract.isLocalExtract(ctxOf('ollama:qwen3-vl:8b')), true);
            assert.equal(extract.isLocalExtract(ctxOf('gemini:gemini-3.5-flash')), false);
            assert.equal(extract.isLocalExtract(ctxOf('gemini-3.5-flash')), false);
            assert.equal(extract.isLocalExtract(ctxOf('nosuchvendor:x')), false);
        });

        test('isLocalExtract：ctx 沒帶模型時看 config/models.js 的 MODEL_EXTRACT', () => {
            const saved = process.env.MODEL_EXTRACT;
            try {
                process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
                assert.equal(extract.isLocalExtract({ config: { models: {} } }), true);
                process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
                assert.equal(extract.isLocalExtract({ config: {} }), false);
            } finally {
                if (saved === undefined) delete process.env.MODEL_EXTRACT; else process.env.MODEL_EXTRACT = saved;
            }
        });

        test('Gemini 路徑逐位元不變：一次呼叫、PDF inlineData、agent extract、沒有 maxOutputTokens，OCR 與渲染都不碰', async () => {
            useDeps({});   // 兩個假相依一被呼叫就丟錯
            const { ctx, calls } = fakeCtx({ models: { extract: 'gemini:gemini-3.5-flash' } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(calls.length, 1);
            const c = calls[0];
            assert.deepEqual(Object.keys(c), ['model', 'system', 'parts', 'schema', 'signal', 'agent', 'template', 'cacheKeyParts']);
            assert.equal(c.model, 'gemini:gemini-3.5-flash');
            assert.equal(c.system, extract.SYSTEM);
            assert.equal(c.parts.length, 2);
            assert.ok(c.parts[0].pdfBase64);
            assert.equal(c.parts[1].text, extract.buildPrompt());
            assert.equal(c.schema, buildSchema('extract'));
            assert.equal(c.agent, 'extract');
            assert.equal(c.template, 'extract.v2');
            assert.deepEqual(c.cacheKeyParts, { template: 'extract.v2', chunkNo: 2, pdfSha256: pdfSha });
            assert.ok(!('cross_check' in outcome.data.questions[0]));
            assert.ok(!('cross_check_summary' in outcome.data));
        });

        test('Gemini 的模板註冊內容不變（本機模板是另外四個識別名）', () => {
            assert.equal(getTemplate('extract.v2'), extract.PROMPT_TEMPLATE);
            assert.equal(getTemplate('extract_chem.v1'), `${extract.SYSTEM_CHEM}\n---\n${extract.PROMPT_TEMPLATE_CHEM}`);
        });
    });

    describe('三步驟（live）', () => {
        test('順序：OCR → 視覺版 → OCR 版；OCR 收到契約的五個欄位', async () => {
            const events = [];
            const ocr = fakeOcr({ events });
            useDeps({ ocr });
            const { ctx } = fakeCtx({ events });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass', JSON.stringify(outcome));
            assert.deepEqual(events, ['ocr', 'llm:extract_vision', 'llm:extract_ocr']);
            assert.deepEqual(Object.keys(ocr.calls[0]).sort(), ['fromPage', 'pdfBytes', 'pdfSha256', 'signal', 'toPage']);
            assert.equal(ocr.calls[0].fromPage, 3);
            assert.equal(ocr.calls[0].toPage, 4);
            assert.equal(ocr.calls[0].pdfSha256, pdfSha);
            assert.equal(ocr.calls[0].pdfBytes, pdf, '整份 PDF＋頁碼範圍（ocr_pdf.py 自己取頁）');
        });

        test('視覺版的請求：模板文字＋本塊每頁一張 PNG（inlineData image/png，用 OCR 轉好的那幾張）', async () => {
            const ocr = fakeOcr();
            useDeps({ ocr });
            const { ctx, calls } = fakeCtx();
            await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            const v = calls[0];
            assert.equal(v.model, 'ollama:qwen3-vl:8b');
            assert.equal(v.system, extract.SYSTEM);
            assert.equal(v.agent, 'extract_vision');
            assert.equal(v.template, 'extract_vision.v1');
            assert.deepEqual(v.cacheKeyParts, { template: 'extract_vision.v1', chunkNo: 2, pdfSha256: pdfSha });
            assert.equal(v.schema, buildSchema('extract'), '同一份 schema');
            assert.equal(v.maxOutputTokens, extract.LOCAL_MAX_OUTPUT_TOKENS);
            assert.equal(v.parts.length, 3);
            assert.equal(v.parts[0].text, extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 3, toPage: 4 }));
            assert.deepEqual(v.parts[1], { inlineData: { mimeType: 'image/png', data: PNG1.toString('base64') } });
            assert.deepEqual(v.parts[2], { inlineData: { mimeType: 'image/png', data: PNG2.toString('base64') } });
        });

        test('OCR 版的請求：MODEL_OCR_STRUCTURE、模板＋OCR 文字、cacheKeyParts 多一個 ocrSha256', async () => {
            const ocr = fakeOcr();
            useDeps({ ocr });
            const { ctx, calls } = fakeCtx();
            await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            const o = calls[1];
            assert.equal(o.model, 'ollama:qwen3:8b-ocr');
            assert.equal(o.agent, 'extract_ocr');
            assert.equal(o.template, 'extract_ocr.v1');
            assert.equal(o.schema, buildSchema('extract'));
            const text = ocrService.pagesToText([
                { page: 3, markdown: '第 3 頁的 OCR 文字' }, { page: 4, markdown: '第 4 頁的 OCR 文字' }
            ]);
            assert.deepEqual(o.cacheKeyParts, {
                template: 'extract_ocr.v1', chunkNo: 2, pdfSha256: pdfSha, ocrSha256: sha256Hex(text)
            });
            assert.equal(o.parts.length, 1, '一個 text part（不依賴 adapter 怎麼串接多個 text）');
            assert.equal(o.parts[0].text,
                `${extract.buildLocalPrompt('math_physics', 'ocr', { fromPage: 3, toPage: 4 })}\n\n${extract.wrapOcrText(text)}`);
            assert.ok(!o.parts.some(p => p.inlineData), 'OCR 版不送圖片');
        });

        test('MODEL_OCR_STRUCTURE 未設 → MODEL_VERIFY；兩個都沒有 → config/models.js 的 MODEL_VERIFY', async () => {
            useDeps({ ocr: fakeOcr() });
            const a = fakeCtx({ models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b' } });
            await extract.run(a.ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(a.calls[1].model, 'ollama:qwen3:8b');

            useDeps({ ocr: fakeOcr() });
            const b = fakeCtx({ models: { extract: 'ollama:qwen3-vl:8b' } });
            await extract.run(b.ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(b.calls[1].model, models.MODEL_VERIFY);
        });

        test('outcome 形狀與原路徑相同，每題多一個 cross_check；用完呼叫 dispose()', async () => {
            const ocr = fakeOcr();
            useDeps({ ocr });
            const { ctx } = fakeCtx({ vision: { questions: [MATH, MATH2] }, ocr: { questions: [MATH, MATH2] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            const d = outcome.data;
            for (const k of ['questions', 'rejected', 'chunk_no', 'page_range', 'pdf_sha256', 'page_count', 'schema_fallback', 'usage', 'latency_ms']) {
                assert.ok(k in d, `少了 ${k}`);
            }
            assert.equal(d.chunk_no, 2);
            assert.deepEqual(d.page_range, [3, 4]);
            assert.equal(d.pdf_sha256, pdfSha);
            assert.equal(d.page_count, 5);
            assert.deepEqual(d.rejected, []);
            assert.deepEqual(d.questions.map(q => q.idx), [2001, 2002]);
            assert.deepEqual(Object.keys(d.questions[0]).sort(), [
                'answer_text', 'chapter', 'chapter_confidence', 'chunk_no', 'cross_check', 'difficulty',
                'idx', 'page_range', 'question_text', 'question_type', 'subject'
            ]);
            assert.deepEqual(d.questions[0].cross_check, { status: 'agree', similarity: 1, alt_question_text: MATH.question_text, picked: 'vision' });
            assert.deepEqual(d.usage, { tokenIn: 20, tokenOut: 40, tokenThinking: 0, tokenCached: 0 }, '兩次呼叫的用量加總');
            assert.equal(d.latency_ms, 14);
            assert.equal(d.schema_fallback, false);
            assert.deepEqual(d.cross_check_summary.counts, { agree: 2, disagree: 0, vision_only: 0, ocr_only: 0 });
            assert.equal(d.cross_check_summary.engine, 'paddle');
            assert.equal(d.cross_check_summary.engine_version, '3.7.0');
            assert.equal(ocr.disposed, 1);
            assert.ok(!fs.existsSync(ocr.dir), '暫存 PNG 已刪');
        });

        test('附圖頁碼：視覺版回的是「第幾張圖片」，換算成整份 PDF 的絕對頁碼（與原路徑同一個規則）', async () => {
            useDeps({ ocr: fakeOcr() });
            const withFig = { ...MATH, figure_desc: '直角三角形', figure_page: 2, figure_box: [100, 100, 500, 500] };
            const { ctx } = fakeCtx({ vision: { questions: [withFig] }, ocr: { questions: [MATH] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            const q0 = outcome.data.questions[0];
            assert.equal(q0.figure_page, 4, '塊內第 2 張 → 整份第 4 頁');
            assert.deepEqual(q0.figure_box, [100, 100, 500, 500]);
            assert.equal(q0.figure_desc, '直角三角形');
        });

        test('一致／不一致／只有一版：各題標上對應的 status，順序依紙上順序', async () => {
            useDeps({ ocr: fakeOcr() });
            const changed = { ...MATH2, question_text: '若 $\\log_2 x = 4$，則 $x$ 為何？(A) $6$ (B) $8$ (C) $16$ (D) $12$' };
            const onlyOcr = { ...MATH, question_text: '已知圓 $x^2+y^2=25$ 與直線 $y=x+1$ 相交於兩點，求弦長。' };
            const { ctx } = fakeCtx({ vision: { questions: [MATH, MATH2] }, ocr: { questions: [MATH, changed, onlyOcr] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.deepEqual(outcome.data.questions.map(q => q.cross_check.status), ['agree', 'disagree', 'ocr_only']);
            assert.deepEqual(outcome.data.questions.map(q => q.idx), [2001, 2002, 2003]);
            assert.equal(outcome.data.questions[1].cross_check.alt_question_text, changed.question_text);
            assert.equal(outcome.data.questions[2].question_text, onlyOcr.question_text);
        });

        test('OCR 沒回圖檔路徑 → 改用 renderPages 轉圖（DPI 用 OCR_DPI）', async () => {
            const render = fakeRender();
            useDeps({ ocr: fakeOcr({ withImages: false }), render, dpi: 150 });
            const { ctx, calls } = fakeCtx();
            await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(render.calls.length, 1);
            assert.deepEqual({ ...render.calls[0], pdfBytes: undefined }, { pdfBytes: undefined, fromPage: 3, toPage: 4, dpi: 150 });
            assert.equal(calls[0].parts[1].inlineData.data, Buffer.from('rendered-3').toString('base64'));
        });

        test('化學卷：extract_vision_chem／extract_ocr_chem、化學模板與 SYSTEM、化學值域的 schema', async () => {
            useDeps({ ocr: fakeOcr() });
            const { ctx, calls } = fakeCtx({ vision: { questions: [CHEM_Q] }, ocr: { questions: [CHEM_Q] }, job: { subject_group: 'chemistry' } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(outcome.data.questions[0].subject, '化學');
            assert.equal(calls[0].agent, 'extract_vision_chem');
            assert.equal(calls[0].template, 'extract_vision_chem.v1');
            assert.equal(calls[1].agent, 'extract_ocr_chem');
            assert.equal(calls[1].template, 'extract_ocr_chem.v1');
            for (const c of calls) {
                assert.equal(c.system, extract.SYSTEM_CHEM);
                assert.equal(c.schema, buildSchema('extract', { group: 'chemistry' }));
            }
            assert.equal(calls[0].parts[0].text, extract.buildLocalPrompt('chemistry', 'vision', { fromPage: 3, toPage: 4 }));
        });
    });

    describe('replay 與 OCR_ENGINE=none', () => {
        test('replay：不轉圖、不送圖片（parts 只剩文字），OCR 照樣經 ocrPdf（它自己讀 cassette）', async () => {
            const ocr = fakeOcr({ withImages: false });
            useDeps({ ocr, mode: 'replay' });   // renderPages 沒給：被呼叫就丟錯
            const { ctx, calls } = fakeCtx();
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(ocr.calls.length, 1);
            assert.deepEqual(calls[0].parts.map(p => Object.keys(p)), [['text']]);
            assert.deepEqual(calls[0].cacheKeyParts, { template: 'extract_vision.v1', chunkNo: 2, pdfSha256: pdfSha }, '鍵不含圖片');
        });

        test('OCR_ENGINE=none（ctx.config.ocr.engine）：不跑 OCR、只有一次視覺呼叫、每題都是 vision_only', async () => {
            const render = fakeRender();
            useDeps({ render });   // ocrPdf 沒給：被呼叫就丟錯
            const { ctx, calls } = fakeCtx({ vision: { questions: [MATH, MATH2] }, config: { ocr: { engine: 'none' } } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].agent, 'extract_vision');
            assert.equal(render.calls.length, 1);
            assert.deepEqual(outcome.data.questions.map(q => q.cross_check.status), ['vision_only', 'vision_only']);
            assert.equal(outcome.data.cross_check_summary.engine, 'none');
            assert.equal(outcome.data.cross_check_summary.engine_version, null);
        });

        test('ctx 沒帶 OCR 設定（eval、相容包裝）→ 問 services/ocr（OCR_ENGINE）', async () => {
            useDeps({ render: fakeRender(), engine: 'none' });
            const { ctx, calls } = fakeCtx();
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(calls.length, 1);
        });
    });

    describe('逐元素驗證與失敗', () => {
        test('視覺版那一題不合格、OCR 版合格 → 用 OCR 版，不算 rejected', async () => {
            useDeps({ ocr: fakeOcr() });
            const { ctx } = fakeCtx({ vision: { questions: [{ ...MATH, chapter: '亂寫的章' }] }, ocr: { questions: [MATH] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.equal(outcome.data.questions.length, 1);
            assert.equal(outcome.data.questions[0].chapter, '向量內積');
            assert.equal(outcome.data.questions[0].cross_check.picked, 'ocr');
            assert.deepEqual(outcome.data.rejected, []);
        });

        test('兩版都不合格的那一格 → rejected（錯誤標出是哪一版），idx 留缺號', async () => {
            useDeps({ ocr: fakeOcr() });
            const bad = { ...MATH2, subject: '化學' };
            const { ctx } = fakeCtx({ vision: { questions: [MATH, bad, MATH2] }, ocr: { questions: [MATH, bad, MATH2] } });
            // MATH2 與 bad 的題幹相同：兩版各有兩題同文，對齊後 [MATH][bad][MATH2] 一一配對
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.deepEqual(outcome.data.questions.map(q => q.idx), [2001, 2003]);
            assert.equal(outcome.data.rejected.length, 1);
            assert.equal(outcome.data.rejected[0].idx, 2002);
            assert.equal(outcome.data.rejected[0].source, 'both');
            assert.ok(outcome.data.rejected[0].errors.some(e => e.startsWith('視覺版：')));
            assert.ok(outcome.data.rejected[0].errors.some(e => e.startsWith('OCR 版：')));
        });

        test('整包都不合格 → fail(schema_invalid)', async () => {
            useDeps({ ocr: fakeOcr() });
            const bad = { ...MATH, chapter: '亂寫的章' };
            const { ctx } = fakeCtx({ vision: { questions: [bad] }, ocr: { questions: [bad] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'fail');
            assert.equal(outcome.reason, 'schema_invalid');
            assert.equal(outcome.data.rejected.length, 1);
        });

        test('一題都沒有（封面頁）→ pass 空陣列', async () => {
            useDeps({ ocr: fakeOcr() });
            const { ctx } = fakeCtx({ vision: { questions: [] }, ocr: { questions: [] } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
            assert.deepEqual(outcome.data.questions, []);
        });

        test('OCR 失敗 → {kind:error}，保留 errorClass；視覺模型沒被叫（先失敗、不白跑二十分鐘）', async () => {
            const err = Object.assign(new Error('PaddleOCR 還沒準備好'), { errorClass: 'provider_error' });
            useDeps({ ocr: fakeOcr({ error: err }) });
            const { ctx, calls } = fakeCtx();
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'error');
            assert.equal(outcome.errorClass, 'provider_error');
            assert.match(outcome.message, /PaddleOCR/);
            assert.equal(calls.length, 0);
        });

        test('OCR 逾時 → errorClass timeout', async () => {
            useDeps({ ocr: fakeOcr({ error: Object.assign(new Error('逾時'), { errorClass: 'timeout' }) }) });
            const { ctx } = fakeCtx();
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.errorClass, 'timeout');
        });

        test('OCR 的 replay miss 原樣往上傳（eval 靠訊息辨識，不得吞掉或改寫）', async () => {
            useDeps({ ocr: fakeOcr({ error: ocrService.replayMissError('f'.repeat(64)) }), mode: 'replay' });
            const { ctx } = fakeCtx();
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'error');
            assert.ok(isReplayMiss(outcome.message), outcome.message);
        });

        test('視覺模型失敗 → {kind:error}；OCR 的暫存檔照樣刪', async () => {
            const ocr = fakeOcr();
            useDeps({ ocr });
            const boom = Object.assign(new Error('Ollama 沒有在執行'), { errorClass: 'provider_error' });
            const { ctx, calls } = fakeCtx({ vision: boom });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'error');
            assert.equal(outcome.errorClass, 'provider_error');
            assert.equal(calls.length, 1, 'OCR 版沒被叫');
            assert.equal(ocr.disposed, 1);
        });

        test('OCR 結構化失敗 → {kind:error}；暫存檔照樣刪', async () => {
            const ocr = fakeOcr();
            useDeps({ ocr });
            const { ctx } = fakeCtx({ ocr: Object.assign(new Error('JSON 壞了'), { errorClass: 'schema_invalid' }) });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'error');
            assert.equal(outcome.errorClass, 'schema_invalid');
            assert.equal(ocr.disposed, 1);
        });

        test('節點已被中止（signal.aborted）→ OCR 之後不再叫模型，errorClass timeout', async () => {
            const ac = new AbortController();
            const ocr = fakeOcr();
            const origOcr = ocr.ocrPdf;
            ocr.ocrPdf = async (opts) => { const r = await origOcr(opts); ac.abort(); return r; };
            useDeps({ ocr });
            const { ctx, calls } = fakeCtx();
            ctx.signal = ac.signal;
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'error');
            assert.equal(outcome.errorClass, 'timeout');
            assert.equal(calls.length, 0);
            assert.equal(ocr.disposed, 1);
            assert.equal(ocr.calls[0].signal, ac.signal, 'signal 要傳給 OCR（逾時時才砍得掉子行程）');
        });

        test('inlineData 門檻是 Gemini 的限制：本機路徑不受 GEMINI_INLINE_MAX_BYTES 影響', async () => {
            useDeps({ ocr: fakeOcr() });
            const { ctx } = fakeCtx({ config: { thresholds: { pdfChunkPages: 2, inlineMaxBytes: 10 } } });
            const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
            assert.equal(outcome.kind, 'pass');
        });
    });

    describe('本機模板', () => {
        test('四個識別名都已註冊（SYSTEM + "\\n---\\n" + 模板），彼此不同也與 Gemini 的不同', () => {
            const pairs = [
                ['extract_vision.v1', extract.SYSTEM, extract.LOCAL_VISION_TEMPLATE],
                ['extract_vision_chem.v1', extract.SYSTEM_CHEM, extract.LOCAL_VISION_TEMPLATE_CHEM],
                ['extract_ocr.v1', extract.SYSTEM, extract.LOCAL_OCR_TEMPLATE],
                ['extract_ocr_chem.v1', extract.SYSTEM_CHEM, extract.LOCAL_OCR_TEMPLATE_CHEM]
            ];
            const hashes = new Set([templateHash('extract.v2'), templateHash('extract_chem.v1')]);
            for (const [name, system, body] of pairs) {
                assert.equal(getTemplate(name), `${system}\n---\n${body}`, name);
                hashes.add(templateHash(name));
            }
            assert.equal(hashes.size, 6);
            assert.deepEqual([extract.AGENT_VISION, extract.AGENT_VISION_CHEM, extract.AGENT_OCR, extract.AGENT_OCR_CHEM],
                ['extract_vision', 'extract_vision_chem', 'extract_ocr', 'extract_ocr_chem']);
        });

        test('視覺模板：頁碼範圍與圖片張數填好、附圖頁碼改成「第幾張圖片」、提醒先 y 後 x', () => {
            const p = extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 3, toPage: 4 });
            assert.match(p, /第 3～4 頁的頁面圖片，每頁一張、共 2 張/);
            assert.match(p, /從你收到的第 1 張圖片數起/);
            assert.match(p, /先 y 後 x/);
            assert.ok(!p.includes('PDF 的第 1 頁'));
            assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), '挖空欄位都填好了');
        });

        test('OCR 模板：附圖三欄一律不要輸出、提醒修正 OCR 錯誤但不要補內容', () => {
            const p = extract.buildLocalPrompt('math_physics', 'ocr', { fromPage: 1, toPage: 2 });
            assert.match(p, /figure_desc、figure_page、figure_box 三個欄位一律不要輸出/);
            assert.match(p, /不要補出原卷沒有的內容/);
            assert.ok(!/\{\{[A-Z_]+\}\}/.test(p));
        });

        test('本機模板沿用 Gemini 模板的白名單、題型、公式與表格規範（逐字）', () => {
            const vision = extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 1, toPage: 2 });
            const gemini = extract.buildPrompt();
            for (const para of gemini.split('\n\n').filter(x => !x.startsWith('請細心閱讀') && !x.startsWith('【附圖'))) {
                assert.ok(vision.includes(para), `少了段落：${para.slice(0, 30)}`);
            }
            const chem = extract.buildLocalPrompt('chemistry', 'ocr', { fromPage: 1, toPage: 2 });
            for (const c of CHAPTERS['化學']) assert.ok(chem.includes(`「${c}」`), c);
            assert.match(chem, /週期表/);
            assert.match(chem, /subject 一律填「化學」/);
        });

        test('頁數只有一頁時張數是 1', () => {
            assert.match(extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 5, toPage: 5 }), /第 5～5 頁的頁面圖片，每頁一張、共 1 張/);
        });

        test('OCR 文字用分隔線包起來', () => {
            assert.equal(extract.wrapOcrText('X'), '----- OCR 辨識結果開始 -----\nX\n----- OCR 辨識結果結束 -----');
        });
    });
});
