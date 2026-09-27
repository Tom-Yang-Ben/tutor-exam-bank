// agents/extract.js 的 LOCAL_EXTRACT_MODE=ocr 路徑（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// 每一塊只做 OCR → extract_ocr，不呼叫視覺模型；每題 cross_check＝{ status:'ocr_only', similarity:null,
// alt_question_text:null, picked:'ocr' }、帶 extract_mode:'ocr'（runner 據此停在 needs_review('ocr_only')）；
// 附圖由 OCR 的版面位置配（agents/extractOcrFigures.js），配不到的標 figure_hint。
// OCR 與 LLM 都用假的（extract._setLocalDepsForTest），不需要 Python、Ollama、mupdf、cassette。
// 執行：npm test

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PDFDocument } = require('pdf-lib');

const extract = require('../../agents/extract');
const models = require('../../config/models');
const { buildSchema } = require('../../agents/schemas');
const ocrService = require('../../services/ocr');
const { sha256Hex } = require('../../services/llm/templates');

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
    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩個向量的內積 $\\vec{a}\\cdot\\vec{b}$ 等於多少。', answer_text: '$1$'
};
const PHYS_FIG = {
    subject: '物理', chapter: '牛頓運動定律', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
    question_text: '如圖，一個質量為 $2$ 公斤的木塊放在光滑水平面上，受水平力拉動，求加速度的大小。', answer_text: '$5$'
};
const CHEM_Q = {
    subject: '化學', chapter: '化學平衡與平衡常數', chapter_confidence: 0.93, question_type: '計算', difficulty: 3,
    question_text: '定溫下 $\\ce{N2 + 3H2 <=> 2NH3}$ 達平衡，已知各物質濃度，求平衡常數 $K_c$。', answer_text: '$K_c = 0.50$'
};
const USAGE = { tokenIn: 10, tokenOut: 20, tokenThinking: 0, tokenCached: 0 };
const OCR_CC = { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' };
const CHUNK = { no: 2, fromPage: 3, toPage: 4 };

function fakeCtx({ ocr = { questions: [MATH] }, mode = 'ocr', job = {}, models: m, logger } = {}) {
    const calls = [];
    const logs = { info: [], warn: [] };
    return {
        calls,
        logs,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    if (/^extract_vision/.test(opts.agent)) throw new Error('ocr 模式不該呼叫視覺模型');
                    if (!/^extract_ocr/.test(opts.agent)) throw new Error(`沒預期的 agent ${opts.agent}`);
                    const v = typeof ocr === 'function' ? ocr(opts) : ocr;
                    if (v instanceof Error) throw v;
                    return { data: v, usage: USAGE, latencyMs: 9, raw: null, schemaFallback: false };
                }
            },
            db: null,
            job: { id: 1, kind: 'pdf', budget_usd: 1, cost_usd: 0, ...job },
            jq: null,
            logger: logger || { info: (o) => logs.info.push(o), warn: (o) => logs.warn.push(o), error() { } },
            config: {
                models: m || { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', ocrStructure: 'ollama:qwen3:8b' },
                thresholds: { pdfChunkPages: 2, inlineMaxBytes: 15728640 },
                ...(mode === undefined ? {} : { localExtract: { mode } })
            },
            signal: undefined
        }
    };
}

function fakeOcr({ pages, error = null } = {}) {
    const state = { calls: [], disposed: 0 };
    state.ocrPdf = async (opts) => {
        state.calls.push(opts);
        if (error) throw error;
        const out = pages ? pages(opts) : [];
        if (!pages) for (let p = opts.fromPage; p <= opts.toPage; p++) out.push({ page: p, markdown: `第 ${p} 頁的 OCR 文字`, imagePath: null });
        return { engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, pages: out, replayed: false, dispose: () => { state.disposed += 1; } };
    };
    return state;
}

function useDeps({ ocr, mode, engine = 'paddle', llmMode = 'live', numCtx = 16384 } = {}) {
    extract._setLocalDepsForTest({
        ocrPdf: ocr ? ocr.ocrPdf : async () => { throw new Error('不該呼叫 OCR'); },
        renderPages: async () => { throw new Error('ocr 模式不該轉圖給視覺模型'); },
        fitLongEdge: async () => { throw new Error('ocr 模式不該縮圖'); },
        llmMode: () => llmMode,
        ocrConfig: () => ({ engine, dpi: 200 }),
        // numCtx: null＝不替換，用真的 services/llm/ollama.numCtx()（讀 OLLAMA_NUM_CTX）與 localTuning 的逐步驟設定；
        // 其餘情況兩者都固定（shell 裡設了 OLLAMA_NUM_CTX_EXTRACT_OCR 等也不影響這些測試）
        ...(numCtx === null ? {} : { numCtx: () => numCtx, ollamaOverrides: () => ({ applied: {} }) }),
        ...(mode ? { localExtractMode: () => mode } : {})
    });
}

describe('extract — LOCAL_EXTRACT_MODE=ocr', () => {
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

    test('只跑 OCR 與 extract_ocr：一次模型呼叫、不轉圖、不呼叫視覺模型；用完 dispose()', async () => {
        const ocr = fakeOcr();
        useDeps({ ocr });
        const { ctx, calls } = fakeCtx();
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome));
        assert.equal(ocr.calls.length, 1);
        assert.deepEqual(Object.keys(ocr.calls[0]).sort(), ['fromPage', 'pdfBytes', 'pdfSha256', 'signal', 'toPage']);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].agent, 'extract_ocr');
        assert.equal(ocr.disposed, 1);
    });

    test('extract_ocr 的請求與交叉驗證模式逐位元相同（同一支 cassette 兩種模式都讀得到）；不開 thinking、輸出上限 8192', async () => {
        useDeps({ ocr: fakeOcr() });
        const o = fakeCtx();
        await extract.run(o.ctx, { pdfBytes: pdf, chunk: CHUNK });

        extract._setLocalDepsForTest({
            ocrPdf: fakeOcr().ocrPdf, renderPages: async ({ fromPage, toPage }) => Array.from({ length: toPage - fromPage + 1 }, () => Buffer.from('png')),
            llmMode: () => 'live', ocrConfig: () => ({ engine: 'paddle', dpi: 200 })
        });
        const crossCalls = [];
        const c = fakeCtx({ mode: 'cross' });
        c.ctx.llm.generateJson = async (opts) => {
            crossCalls.push(opts);
            return { data: { questions: [MATH] }, usage: USAGE, latencyMs: 1, raw: null };
        };
        await extract.run(c.ctx, { pdfBytes: pdf, chunk: CHUNK });
        const crossOcr = crossCalls.find(x => x.agent === 'extract_ocr');
        assert.ok(crossOcr, 'cross 模式也有 extract_ocr');

        const ocrOnly = o.calls[0];
        assert.deepEqual(Object.keys(ocrOnly), Object.keys(crossOcr), '鍵與順序相同');
        for (const k of ['model', 'system', 'parts', 'schema', 'maxOutputTokens', 'agent', 'template', 'cacheKeyParts']) {
            assert.deepEqual(ocrOnly[k], crossOcr[k], k);
        }
        const text = ocrService.pagesToText([{ page: 3, markdown: '第 3 頁的 OCR 文字' }, { page: 4, markdown: '第 4 頁的 OCR 文字' }]);
        assert.deepEqual(ocrOnly.cacheKeyParts, { template: 'extract_ocr.v2', chunkNo: 2, pdfSha256: pdfSha, ocrSha256: sha256Hex(text) });
        assert.equal(ocrOnly.maxOutputTokens, extract.LOCAL_MAX_OUTPUT_TOKENS);
        assert.equal(ocrOnly.maxOutputTokens, 8192);
        assert.ok(!('thinkingBudget' in ocrOnly), 'services/llm/ollama.js：沒有 thinkingBudget＝think:false');
        assert.equal(require('../../services/llm/ollama').numCtx({}), 16384);
    });

    test('每題：cross_check 沿用既有形狀（ocr_only／null／null／ocr）、extract_mode:"ocr"；idx 與原路徑同一個規則', async () => {
        useDeps({ ocr: fakeOcr() });
        const { ctx } = fakeCtx({ ocr: { questions: [MATH, { ...MATH, question_text: MATH.question_text.replace('內積', '夾角的餘弦') }] } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        const d = outcome.data;
        assert.deepEqual(d.questions.map(q => q.idx), [2001, 2002]);
        for (const q of d.questions) {
            assert.deepEqual(q.cross_check, OCR_CC);
            assert.equal(q.extract_mode, 'ocr');
        }
        assert.deepEqual(Object.keys(d.questions[0]).sort(), [
            'answer_text', 'chapter', 'chapter_confidence', 'chunk_no', 'cross_check', 'difficulty',
            'extract_mode', 'idx', 'page_range', 'question_text', 'question_type', 'subject'
        ]);
        for (const k of ['questions', 'rejected', 'chunk_no', 'page_range', 'pdf_sha256', 'page_count', 'schema_fallback', 'usage', 'latency_ms']) {
            assert.ok(k in d, `少了 ${k}`);
        }
        assert.deepEqual(d.page_range, [3, 4]);
        assert.deepEqual(d.usage, USAGE);
        assert.equal(d.latency_ms, 9);
        assert.equal(d.cross_check_summary.mode, 'ocr');
        assert.deepEqual(d.cross_check_summary.counts, { agree: 0, disagree: 0, vision_only: 0, ocr_only: 2 });
        assert.equal(d.cross_check_summary.vision_elements, null);
        assert.equal(d.cross_check_summary.ocr_elements, 2);
        assert.equal(d.cross_check_summary.engine_version, '3.7.0');
    });

    test('文字模型自己回的附圖欄位一律拿掉（它看不到圖）；附圖只來自 OCR 的版面位置', async () => {
        const pages = ({ fromPage }) => [
            { page: fromPage, markdown: `## 1. (物理·計算)\n\n${PHYS_FIG.question_text.replace(/\$/g, '')}\n\n[圖]`, imagePath: null, figures: [{ label: 'image', box: [120, 200, 400, 800] }] },
            { page: fromPage + 1, markdown: '', imagePath: null, figures: [] }
        ];
        useDeps({ ocr: fakeOcr({ pages }) });
        const fake = { ...PHYS_FIG, figure_desc: '模型亂寫的圖', figure_page: 2, figure_box: [1, 2, 3, 4] };
        const { ctx } = fakeCtx({ ocr: { questions: [fake] } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        const q = outcome.data.questions[0];
        assert.equal(q.figure_desc, undefined);
        assert.equal(q.figure_page, 3, '絕對頁碼（OCR 回的就是整份 PDF 的頁碼）');
        assert.deepEqual(q.figure_box, [120, 200, 400, 800]);
        assert.equal(q.figure_hint, undefined);
        assert.deepEqual(outcome.data.cross_check_summary.figures, { layout: 'ok', detected: 1, assigned: 1, hinted: 0 });
    });

    test('版面拿不到（舊 cassette、舊 ocr_pdf.py）：題幹提到「如圖」的題標 figure_hint，不配圖', async () => {
        const pages = ({ fromPage, toPage }) => [fromPage, toPage].map(p => ({ page: p, markdown: `第 ${p} 頁 [圖]`, imagePath: null }));
        useDeps({ ocr: fakeOcr({ pages }) });
        const { ctx } = fakeCtx({ ocr: { questions: [MATH, PHYS_FIG] } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        const [a, b] = outcome.data.questions;
        assert.equal(a.figure_hint, undefined);
        assert.deepEqual(b.figure_hint, { reason: 'mentions' });
        assert.equal(b.figure_box, undefined);
        assert.equal(outcome.data.cross_check_summary.figures.layout, 'none');
    });

    test('不合格的元素進 rejected（標「OCR 版」）、留 idx 缺號；整包不合格 → fail(schema_invalid)', async () => {
        useDeps({ ocr: fakeOcr() });
        const { ctx } = fakeCtx({ ocr: { questions: [{ ...MATH, chapter: '亂寫的章' }, MATH] } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data.questions.map(q => q.idx), [2002]);
        assert.equal(outcome.data.rejected.length, 1);
        assert.equal(outcome.data.rejected[0].idx, 2001);
        assert.equal(outcome.data.rejected[0].source, 'ocr');
        assert.match(outcome.data.rejected[0].errors[0], /^OCR 版：/);

        useDeps({ ocr: fakeOcr() });
        const bad = fakeCtx({ ocr: { questions: [{ ...MATH, chapter: '亂寫的章' }] } });
        const failed = await extract.run(bad.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(failed.kind, 'fail');
        assert.equal(failed.reason, 'schema_invalid');
    });

    test('一題都沒有（封面頁）→ pass 空陣列', async () => {
        useDeps({ ocr: fakeOcr() });
        const { ctx } = fakeCtx({ ocr: { questions: [] } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data.questions, []);
    });

    test('OCR_ENGINE=none 與 ocr 模式矛盾：不跑任何東西，回 error（訊息說清楚兩個設定怎麼改）', async () => {
        useDeps({ engine: 'none' });
        const { ctx, calls } = fakeCtx();
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'provider_error');
        assert.match(outcome.message, /LOCAL_EXTRACT_MODE=ocr/);
        assert.match(outcome.message, /OCR_ENGINE=none/);
        assert.equal(calls.length, 0);
        const viaCtx = fakeCtx();
        viaCtx.ctx.config.ocr = { engine: 'none' };
        useDeps({});
        assert.equal((await extract.run(viaCtx.ctx, { pdfBytes: pdf, chunk: CHUNK })).kind, 'error');
    });

    test('ctx 沒帶 localExtract（eval、相容包裝）→ 問 config/localExtractMode（LOCAL_EXTRACT_MODE）', async () => {
        useDeps({ ocr: fakeOcr(), mode: 'ocr' });
        const { ctx, calls } = fakeCtx({ mode: undefined });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(calls.map(c => c.agent), ['extract_ocr']);
        assert.equal(outcome.data.questions[0].extract_mode, 'ocr');
    });

    test('ctx.config.localExtract 優先於環境（cross 就走交叉驗證）', async () => {
        extract._setLocalDepsForTest({
            ocrPdf: fakeOcr().ocrPdf, renderPages: async () => [Buffer.from('a'), Buffer.from('b')],
            llmMode: () => 'live', ocrConfig: () => ({ engine: 'paddle', dpi: 200 }), localExtractMode: () => 'ocr'
        });
        const seen = [];
        const { ctx } = fakeCtx({ mode: 'cross' });
        ctx.llm.generateJson = async (opts) => { seen.push(opts.agent); return { data: { questions: [MATH] }, usage: USAGE, latencyMs: 1 }; };
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.deepEqual(seen, ['extract_vision', 'extract_ocr']);
        assert.equal(outcome.data.questions[0].extract_mode, undefined, 'cross 模式的 payload 逐位元不變');
    });

    test('Gemini 路徑完全不受影響（ocr 模式設了也一樣）', async () => {
        useDeps({ mode: 'ocr' });
        const calls = [];
        const { ctx } = fakeCtx({ models: { extract: 'gemini:gemini-3.5-flash' } });
        ctx.llm.generateJson = async (opts) => { calls.push(opts); return { data: { questions: [MATH] }, usage: USAGE, latencyMs: 1 }; };
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(calls.map(c => c.agent), ['extract']);
        assert.equal(outcome.data.questions[0].cross_check, undefined);
        assert.equal(outcome.data.questions[0].extract_mode, undefined);
    });

    test('化學卷：extract_ocr_chem、化學 SYSTEM 與 schema', async () => {
        useDeps({ ocr: fakeOcr() });
        const { ctx, calls } = fakeCtx({ ocr: { questions: [CHEM_Q] }, job: { subject_group: 'chemistry' } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome));
        assert.equal(calls[0].agent, 'extract_ocr_chem');
        assert.equal(calls[0].template, 'extract_ocr_chem.v2');
        assert.equal(calls[0].system, extract.SYSTEM_CHEM);
        assert.equal(calls[0].schema, buildSchema('extract', { group: 'chemistry' }));
        assert.deepEqual(outcome.data.questions[0].cross_check, OCR_CC);
    });

    test('replay：照樣只經 ocrPdf（它自己讀 cassette）與 extract_ocr', async () => {
        useDeps({ ocr: fakeOcr(), llmMode: 'replay' });
        const { ctx, calls } = fakeCtx();
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(calls.map(c => c.agent), ['extract_ocr']);
    });

    test('OCR 失敗 → {kind:error} 保留 errorClass；extract_ocr 失敗 → {kind:error}、暫存檔照樣刪', async () => {
        useDeps({ ocr: fakeOcr({ error: Object.assign(new Error('PaddleOCR 逾時'), { errorClass: 'timeout' }) }) });
        const a = fakeCtx();
        const o1 = await extract.run(a.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(o1.kind, 'error');
        assert.equal(o1.errorClass, 'timeout');
        assert.equal(a.calls.length, 0);

        const ocr = fakeOcr();
        useDeps({ ocr });
        const b = fakeCtx({ ocr: Object.assign(new Error('Ollama 逾時'), { errorClass: 'timeout' }) });
        const o2 = await extract.run(b.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(o2.kind, 'error');
        assert.equal(o2.errorClass, 'timeout');
        assert.equal(ocr.disposed, 1);
    });

    test('節點已被中止（signal.aborted）→ OCR 之後不再叫模型，errorClass timeout', async () => {
        const controller = new AbortController();
        const ocr = fakeOcr({ pages: ({ fromPage, toPage }) => { controller.abort(); return [fromPage, toPage].map(p => ({ page: p, markdown: 'x', imagePath: null })); } });
        useDeps({ ocr });
        const { ctx, calls } = fakeCtx();
        ctx.signal = controller.signal;
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'timeout');
        assert.equal(calls.length, 0);
        assert.equal(ocr.disposed, 1);
    });

    test('OLLAMA_NUM_CTX：估計的 prompt＋輸出上限放不下時記一行 warn（摘要也記），照常送出', async () => {
        const huge = ({ fromPage, toPage }) => [fromPage, toPage].map(p => ({ page: p, markdown: '甲'.repeat(9000), imagePath: null }));
        useDeps({ ocr: fakeOcr({ pages: huge }) });
        const { ctx, calls, logs } = fakeCtx();
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        assert.equal(calls.length, 1, '照常送出（由 Ollama 決定；警告讓 Owner 知道要調）');
        const w = logs.warn.find(x => /OLLAMA_NUM_CTX/.test(x.msg || ''));
        assert.ok(w, '要有一行 warn');
        assert.match(w.msg, /JOB_PDF_CHUNK_PAGES/);
        const b = outcome.data.cross_check_summary.ctx_budget;
        assert.equal(b.num_ctx, 16384);
        assert.equal(b.max_output_tokens, 8192);
        assert.ok(b.prompt_tokens_est > 16384 - 8192);
        assert.equal(b.over, true);

        useDeps({ ocr: fakeOcr() });
        const small = fakeCtx();
        const ok = await extract.run(small.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(ok.data.cross_check_summary.ctx_budget.over, false);
        assert.ok(!small.logs.warn.some(x => /OLLAMA_NUM_CTX/.test(x.msg || '')));
    });

    test('〔審查 2026-09-26〕這一塊可能被截斷（粗估放不下 num_ctx，或輸出用滿上限）→ 附圖一張都不自動配，只標提示', async () => {
        const pages = ({ fromPage }) => [
            { page: fromPage, markdown: `## 1. (物理·計算)\n\n${PHYS_FIG.question_text.replace(/\$/g, '')}\n\n[圖]`, imagePath: null, figures: [{ label: 'image', box: [120, 200, 400, 800] }] },
            { page: fromPage + 1, markdown: '', imagePath: null, figures: [] }
        ];
        // ① 粗估放不下（num_ctx 故意設很小）
        useDeps({ ocr: fakeOcr({ pages }), numCtx: 1000 });
        const over = fakeCtx({ ocr: { questions: [PHYS_FIG] } });
        const a = await extract.run(over.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(a.data.cross_check_summary.ctx_budget.over, true);
        assert.equal(a.data.questions[0].figure_box, undefined);
        assert.deepEqual(a.data.questions[0].figure_hint, { reason: 'nearby', count: 1 });
        assert.deepEqual(a.data.cross_check_summary.figures, { layout: 'ok', detected: 1, assigned: 0, hinted: 1, truncated: true });

        // ② 放得下，但輸出用滿上限（LOCAL_MAX_OUTPUT_TOKENS）
        useDeps({ ocr: fakeOcr({ pages }) });
        const full = fakeCtx({ ocr: { questions: [PHYS_FIG] } });
        full.ctx.llm.generateJson = async () => ({
            data: { questions: [PHYS_FIG] }, usage: { ...USAGE, tokenOut: extract.LOCAL_MAX_OUTPUT_TOKENS }, latencyMs: 9, raw: null, schemaFallback: false
        });
        const b = await extract.run(full.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(b.data.cross_check_summary.ctx_budget.over, false);
        assert.equal(b.data.questions[0].figure_box, undefined);
        assert.equal(b.data.cross_check_summary.figures.truncated, true);

        // 對照：沒截斷時照配（同一份版面）
        useDeps({ ocr: fakeOcr({ pages }) });
        const ok = fakeCtx({ ocr: { questions: [PHYS_FIG] } });
        const c = await extract.run(ok.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.deepEqual(c.data.questions[0].figure_box, [120, 200, 400, 800]);
        assert.equal('truncated' in c.data.cross_check_summary.figures, false);
    });

    test('estimatePromptTokens：中文字一字一個 token，其餘每 3 個字元一個（保守）', () => {
        assert.equal(extract.estimatePromptTokens(''), 0);
        assert.equal(extract.estimatePromptTokens('甲乙丙'), 3);
        assert.equal(extract.estimatePromptTokens('abcdef'), 2);
        assert.equal(extract.estimatePromptTokens('甲 abc'), 1 + 2);
    });
});

// 〔整合 r5 審查〕OCR 分支的「放不放得下／有沒有被截斷」與加速分支的逐步驟設定（OLLAMA_NUM_CTX_EXTRACT_OCR、
// OLLAMA_MAX_OUTPUT_EXTRACT_OCR）合起來要對得上：判斷用的必須是實際送給 Ollama 的值（services/llm/index.js 的 adapterOpts
// 用 localTuning.resolveOllamaOverrides 算），不是全域 OLLAMA_NUM_CTX 與固定的 8192。
// 這裡不替換 numCtx／ollamaOverrides 兩個相依，走真的 services/llm/ollama 與 localTuning（讀 process.env）。
describe('extract — OCR 整理的預算與截斷判斷認得逐步驟設定（整合 r5）', () => {
    const KEYS = ['OLLAMA_NUM_CTX', 'OLLAMA_NUM_CTX_EXTRACT_OCR', 'OLLAMA_NUM_CTX_EXTRACT_OCR_CHEM',
        'OLLAMA_MAX_OUTPUT_EXTRACT_OCR', 'OLLAMA_MAX_OUTPUT_EXTRACT_OCR_CHEM'];
    const saved = {};
    let pdf;
    const tuning = require('../../services/llm/localTuning');

    function setEnv(vars) {
        for (const k of KEYS) delete process.env[k];
        for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    }
    // 第 1 頁有一題帶圖（版面配得到），第 2 頁只有填充文字（控制這一塊讀多少）
    function pagesWith(padChars) {
        return ({ fromPage }) => [
            { page: fromPage, markdown: `## 1. (物理·計算)\n\n${PHYS_FIG.question_text.replace(/\$/g, '')}\n\n[圖]`, imagePath: null, figures: [{ label: 'image', box: [120, 200, 400, 800] }] },
            { page: fromPage + 1, markdown: '甲'.repeat(padChars), imagePath: null, figures: [] }
        ];
    }
    async function runOnce({ padChars = 0, tokenOut = 20 } = {}) {
        useDeps({ ocr: fakeOcr({ pages: pagesWith(padChars) }), numCtx: null });
        const f = fakeCtx({ ocr: { questions: [PHYS_FIG] } });
        f.ctx.llm.generateJson = async (opts) => {
            f.calls.push(opts);
            return { data: { questions: [PHYS_FIG] }, usage: { ...USAGE, tokenOut }, latencyMs: 9, raw: null, schemaFallback: false };
        };
        const outcome = await extract.run(f.ctx, { pdfBytes: pdf, chunk: CHUNK });
        assert.equal(outcome.kind, 'pass');
        const sent = tuning.resolveOllamaOverrides(f.calls[0]);
        return { outcome, logs: f.logs, sent, budget: outcome.data.cross_check_summary.ctx_budget, q: outcome.data.questions[0] };
    }

    before(async () => {
        for (const k of KEYS) saved[k] = process.env[k];
        models.parseModel = parseWithOllama;
        pdf = await makePdf(5);
    });
    after(() => {
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        models.parseModel = ORIGINAL_PARSE;
        extract._setLocalDepsForTest({});
    });
    afterEach(() => extract._setLocalDepsForTest({}));

    test('什麼都沒寫：與整合前相同（全域 16384、輸出上限 8192，摘要不多鍵）', async () => {
        setEnv({});
        const { budget, q } = await runOnce();
        assert.deepEqual(Object.keys(budget), ['prompt_tokens_est', 'max_output_tokens', 'num_ctx', 'over']);
        assert.equal(budget.num_ctx, 16384);
        assert.equal(budget.max_output_tokens, extract.LOCAL_MAX_OUTPUT_TOKENS);
        assert.equal(budget.over, false);
        assert.deepEqual(q.figure_box, [120, 200, 400, 800]);
    });

    test('OLLAMA_NUM_CTX=8192＋OLLAMA_NUM_CTX_EXTRACT_OCR=16384：用 16384 判斷，不算截斷、附圖照配、不警告', async () => {
        setEnv({ OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384' });
        const { budget, q, logs, sent } = await runOnce();
        assert.equal(sent.numCtx, 16384, '實際送出的 num_ctx');
        assert.equal(budget.num_ctx, sent.numCtx, '判斷用的＝實際送出的');
        assert.equal(budget.num_ctx_env, 'OLLAMA_NUM_CTX_EXTRACT_OCR');
        assert.equal(budget.over, false);
        assert.deepEqual(q.figure_box, [120, 200, 400, 800]);
        assert.equal(q.figure_hint, undefined);
        assert.ok(!logs.warn.some(x => /num_ctx|OLLAMA_NUM_CTX/i.test(x.msg || '')));

        // 對照：只有全域 8192（沒有逐步驟設定）時照舊用 8192——輸出上限 8192 本身就放不下，整塊標截斷
        setEnv({ OLLAMA_NUM_CTX: '8192' });
        const g = await runOnce();
        assert.equal(g.budget.num_ctx, 8192);
        assert.equal(g.budget.over, true);
        assert.equal(g.q.figure_box, undefined);
        assert.ok(g.logs.warn.some(x => /超過 OLLAMA_NUM_CTX=8192/.test(x.msg || '')));
    });

    test('OLLAMA_NUM_CTX_EXTRACT_OCR=20480：介於 16384 與 20480 之間的塊用 20480 判斷，不算截斷', async () => {
        const PAD = 9000;
        setEnv({});
        const base = await runOnce({ padChars: PAD });
        const need = base.budget.prompt_tokens_est + extract.LOCAL_MAX_OUTPUT_TOKENS;
        assert.ok(need > 16384 && need <= 20480, `這一塊要 ${need}，應介於 16384 與 20480 之間`);
        assert.equal(base.budget.over, true, '全域 16384 放不下');

        setEnv({ OLLAMA_NUM_CTX_EXTRACT_OCR: '20480' });
        const { budget, q, logs } = await runOnce({ padChars: PAD });
        assert.equal(budget.num_ctx, 20480);
        assert.equal(budget.over, false);
        assert.deepEqual(q.figure_box, [120, 200, 400, 800]);
        assert.ok(!logs.warn.some(x => /num_ctx|OLLAMA_NUM_CTX/i.test(x.msg || '')));

        // 設了 20480 仍放不下時，警告叫人調的是實際生效的 OLLAMA_NUM_CTX_EXTRACT_OCR
        setEnv({ OLLAMA_NUM_CTX_EXTRACT_OCR: '12288' });
        const small = await runOnce({ padChars: PAD });
        assert.equal(small.budget.over, true);
        const w = small.logs.warn.find(x => /OLLAMA_NUM_CTX_EXTRACT_OCR=12288/.test(x.msg || ''));
        assert.ok(w, '警告要寫出生效的變數');
        assert.match(w.msg, /調高 OLLAMA_NUM_CTX_EXTRACT_OCR/);
    });

    test('OLLAMA_MAX_OUTPUT_EXTRACT_OCR=3072：tokenOut 到 3072 算截斷（附圖不自動配），3071 不算', async () => {
        setEnv({ OLLAMA_MAX_OUTPUT_EXTRACT_OCR: '3072' });
        const full = await runOnce({ tokenOut: 3072 });
        assert.equal(full.sent.maxOutputTokens, 3072, '實際送出的輸出上限');
        assert.equal(full.budget.max_output_tokens, 3072);
        assert.equal(full.budget.max_output_env, 'OLLAMA_MAX_OUTPUT_EXTRACT_OCR');
        assert.equal(full.budget.over, false);
        assert.equal(full.q.figure_box, undefined);
        assert.equal(full.outcome.data.cross_check_summary.figures.truncated, true);

        const ok = await runOnce({ tokenOut: 3071 });
        assert.deepEqual(ok.q.figure_box, [120, 200, 400, 800]);
        assert.equal('truncated' in ok.outcome.data.cross_check_summary.figures, false);
    });

    test('化學版 extract_ocr_chem：寫基本名稱 OLLAMA_NUM_CTX_EXTRACT_OCR 一樣認得；_CHEM 另寫時以它為準', () => {
        const req = { model: 'ollama:qwen3:8b', agent: 'extract_ocr_chem', maxOutputTokens: 8192 };
        setEnv({ OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384' });
        const deps = { numCtx: () => require('../../services/llm/ollama').numCtx(), ollamaOverrides: (r) => ({ ...tuning.resolveOllamaOverrides(r), numCtxEnv: 'OLLAMA_NUM_CTX_EXTRACT_OCR' }) };
        assert.equal(extract.ocrCallLimits(req, deps).numCtx, 16384);
        setEnv({ OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_CTX_EXTRACT_OCR: '16384', OLLAMA_NUM_CTX_EXTRACT_OCR_CHEM: '20480' });
        assert.equal(extract.ocrCallLimits(req, deps).numCtx, 20480);
        // 模型不是 ollama（adapterOpts 不套逐步驟設定）：照舊全域
        assert.equal(extract.ocrCallLimits({ ...req, model: 'gemini-2.5-flash' }, deps).numCtx, 8192);
    });
});
