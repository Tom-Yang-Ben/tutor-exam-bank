// 舊流程 /analyze-pdf 補裁附圖的單元測試〔Owner 決策單 2026-09-25 B21〕
//
// roadmap 待決策第 20 項：Owner 選「保留舊流程＋補裁圖」。services/aiService.js 在 extract 之後
// 委託管線同一支 services/figureService.js 裁圖，裁出的題**多一個** question_img 鍵，其餘不變。
//
// 真的跑的：agents/extract.js（切塊、逐元素驗證、塊內頁碼換算）、services/figureService.js
// （mupdf 渲染＋sharp 裁切）、公開樣卷 eval/fixtures/sample_exam.pdf。
// 換掉的：llm（假物件，不呼叫任何模型、不讀 cassette）、附圖目錄（暫存目錄，不碰 data/figures/）、
// 本機路徑的 OCR（extract._setLocalDepsForTest）。
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

const aiService = require('../../services/aiService');
const extract = require('../../agents/extract');
const { cropFigures, boxToPixels, RENDER_SCALE } = require('../../services/figureService');
const { resolveFigurePath } = require('../../services/wordService');

const SAMPLE_PDF = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'sample_exam.pdf');
const LEGACY_KEYS = ['subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'answer_text'];
const RUN = '20260926000000-abcdef';
const GEMINI = { extract: 'gemini:gemini-3.5-flash', verify: 'gemini:gemini-3.1-pro-preview', text: 'gemini:gemini-3.5-flash' };
const USAGE = { tokenIn: 1, tokenOut: 2, tokenThinking: 0, tokenCached: 0 };

const WITH_FIG = {
    subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
    question_text: '如圖，$\\triangle ABC$ 中 $\\overline{AB}=3$，求 $\\overrightarrow{AB}\\cdot\\overrightarrow{AC}$。',
    answer_text: '$6$',
    figure_desc: '直角三角形 ABC，∠C=90°',
    figure_page: 1,
    figure_box: [100, 150, 400, 850]
};
const NO_FIG = {
    subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_type: '填空', difficulty: 2,
    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。',
    answer_text: '$1$'
};

/** 補裁圖之前 toLegacyShape 的輸出（逐字照搬舊實作）：沒有附圖的題必須與它逐位元相同 */
function oldLegacyShape(q) {
    const figure = String(q.figure_desc ?? '').trim();
    const text = String(q.question_text ?? '');
    return {
        subject: q.subject, chapter: q.chapter, question_type: q.question_type, difficulty: q.difficulty,
        question_text: figure ? `${text}\n[附圖描述：${figure}]` : text,
        answer_text: q.answer_text
    };
}

/** 假 llm：依塊號回題目（Gemini 路徑的 agent 是 extract；本機路徑分 vision／ocr 兩次） */
function fakeLlm(byChunk, { ocrByChunk = null } = {}) {
    const calls = [];
    return {
        calls,
        generateJson: async (opts) => {
            calls.push(opts);
            const no = opts.cacheKeyParts.chunkNo;
            const table = /^extract_ocr/.test(opts.agent) && ocrByChunk ? ocrByChunk : byChunk;
            return { data: { questions: table[no] || [] }, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
        }
    };
}

function captureLogger() {
    const infos = [];
    const warns = [];
    return { infos, warns, logger: { info: (o) => infos.push(o), warn: (o) => warns.push(o), error() { } } };
}

describe('services/aiService — 舊流程 /analyze-pdf 補裁附圖〔Owner 決策單 2026-09-25 B21〕', () => {
    let sampleBase64;
    let figuresDir;

    before(() => { sampleBase64 = fs.readFileSync(SAMPLE_PDF).toString('base64'); });
    beforeEach(() => { figuresDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-legacy-figures-')); });
    afterEach(() => {
        aiService._setDepsForTest();
        extract._setLocalDepsForTest({});
        fs.rmSync(figuresDir, { recursive: true, force: true });
    });

    /** 用真的 figureService 裁圖，只把附圖目錄換成暫存目錄 */
    const realCropInto = (dir) => (opts) => cropFigures({ ...opts, figuresDir: dir });

    test('有附圖的題多帶 question_img、圖真的裁在附圖目錄；沒附圖的題仍是那六個鍵、逐位元不變', async () => {
        const llm = fakeLlm({ 1: [WITH_FIG, NO_FIG] });
        const { infos, warns, logger } = captureLogger();
        aiService._setDepsForTest({ llm, models: GEMINI, logger, runId: () => RUN, cropFigures: realCropInto(figuresDir) });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.equal(out.length, 2);
        assert.equal(llm.calls.length, 1, '只呼叫一次拆題，裁圖不呼叫任何模型');
        // 有圖的題：六個鍵原樣、順序不變，最後多一個 question_img
        assert.deepEqual(Object.keys(out[0]), [...LEGACY_KEYS, 'question_img']);
        assert.deepEqual({ ...out[0], question_img: undefined }, { ...oldLegacyShape(WITH_FIG), question_img: undefined });
        assert.equal(out[0].question_img, `/figures/legacy-${RUN}-1001.png`);
        assert.match(out[0].question_text, /\n\[附圖描述：直角三角形 ABC，∠C=90°\]$/, 'figure_desc 併題幹的備援照舊');
        // 沒圖的題：與補裁圖之前逐位元相同
        assert.deepEqual(Object.keys(out[1]), LEGACY_KEYS);
        assert.deepEqual(out[1], oldLegacyShape(NO_FIG));

        // 檔案：在附圖目錄內、是 PNG、大小就是框（含 2.5% 邊距）換算成 144 DPI 的像素
        const file = path.join(figuresDir, `legacy-${RUN}-1001.png`);
        assert.ok(fs.existsSync(file), '裁圖檔要存在');
        const meta = await sharp(file).metadata();
        assert.equal(meta.format, 'png');
        const expected = boxToPixels(WITH_FIG.figure_box, Math.ceil(595.28 * RENDER_SCALE), Math.ceil(841.89 * RENDER_SCALE));
        assert.ok(Math.abs(meta.width - expected.width) <= 2, `寬 ${meta.width} ≈ ${expected.width}`);
        assert.ok(Math.abs(meta.height - expected.height) <= 2, `高 ${meta.height} ≈ ${expected.height}`);
        assert.deepEqual(fs.readdirSync(figuresDir), [`legacy-${RUN}-1001.png`], '沒有附圖的題不產生檔案');

        // Word 匯出與批次入庫都用 resolveFigurePath 判斷：舊流程的檔名過得了同一道白名單
        assert.equal(resolveFigurePath(out[0].question_img, figuresDir), file);

        assert.deepEqual(warns, []);
        assert.ok(infos.some(o => /已裁出 1 張附圖/.test(o.msg)), JSON.stringify(infos));
    });

    test('沒有任何一題帶框：不呼叫裁圖，整批回傳與補裁圖之前逐位元相同', async () => {
        const llm = fakeLlm({ 1: [NO_FIG, { ...NO_FIG, question_text: '求 $1+1$。', figure_desc: '只有描述、沒有框' }] });
        let cropCalls = 0;
        aiService._setDepsForTest({
            llm, models: GEMINI, logger: captureLogger().logger,
            cropFigures: async () => { cropCalls += 1; throw new Error('不該呼叫裁圖'); }
        });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.equal(cropCalls, 0);
        assert.deepEqual(out, [
            oldLegacyShape(NO_FIG),
            oldLegacyShape({ ...NO_FIG, question_text: '求 $1+1$。', figure_desc: '只有描述、沒有框' })
        ]);
        for (const q of out) assert.deepEqual(Object.keys(q), LEGACY_KEYS);
    });

    test('裁圖整批失敗（附圖目錄寫不進去）：題目照回、沒有 question_img、記 warn，不 throw', async () => {
        const blocker = path.join(figuresDir, '這是檔案不是目錄');
        fs.writeFileSync(blocker, 'x');
        const llm = fakeLlm({ 1: [WITH_FIG, NO_FIG] });
        const { warns, logger } = captureLogger();
        aiService._setDepsForTest({ llm, models: GEMINI, logger, runId: () => RUN, cropFigures: realCropInto(path.join(blocker, 'figures')) });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.deepEqual(out, [oldLegacyShape(WITH_FIG), oldLegacyShape(NO_FIG)], '題目一題不少、欄位不變，只是沒有圖');
        assert.equal(warns.length, 1);
        assert.match(warns[0].msg, /附圖裁切失敗（題目照常回傳，僅缺圖）/);
        assert.equal(warns[0].run, `legacy-${RUN}`);
        assert.ok(warns[0].error, '要記下錯誤原因');
    });

    test('裁圖服務直接丟例外（例如 mupdf 載不到）：同樣只少圖、不少題', async () => {
        const llm = fakeLlm({ 1: [WITH_FIG] });
        const { warns, logger } = captureLogger();
        aiService._setDepsForTest({
            llm, models: GEMINI, logger, runId: () => RUN,
            cropFigures: async () => { throw new Error('mupdf 載入失敗'); }
        });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.deepEqual(out, [oldLegacyShape(WITH_FIG)]);
        assert.equal(warns.length, 1);
        assert.equal(warns[0].error, 'mupdf 載入失敗');
    });

    test('單題裁不出來（框退化）只少那一張：同一批其他題的圖照裁', async () => {
        // 走真的 cropFigures，在同一批裡摻一張換算成像素後寬度為 0 的框（extract 的防呆會先擋掉這種框，
        // 所以直接加在交給裁圖的清單上）→ figureService 逐題略過並記 warn，其餘照裁
        const llm = fakeLlm({ 1: [WITH_FIG, NO_FIG] });
        const { warns, logger } = captureLogger();
        const degenerate = { idx: 1999, figure_page: 1, figure_box: [500, 0, 600, 0] };
        aiService._setDepsForTest({
            llm, models: GEMINI, logger, runId: () => RUN,
            cropFigures: (opts) => cropFigures({ ...opts, questions: [degenerate, ...opts.questions], figuresDir })
        });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.equal(out.length, 2, '摻進去的那筆只在裁圖清單上，不會變成一道題');
        assert.equal(out[0].question_img, `/figures/legacy-${RUN}-1001.png`);
        assert.ok(!('question_img' in out[1]));
        assert.ok(!('figure_img' in degenerate));
        assert.ok(warns.some(w => /附圖框退化/.test(w.msg) && w.idx === 1999), JSON.stringify(warns));
        assert.deepEqual(fs.readdirSync(figuresDir), [`legacy-${RUN}-1001.png`]);
    });

    test('多塊 PDF：figure_page 用整份的絕對頁碼、每塊各裁各的，檔名以 idx 區分不撞名', async () => {
        const src = await PDFDocument.load(fs.readFileSync(SAMPLE_PDF));
        const two = await PDFDocument.create();
        for (const p of await two.copyPages(src, [0, 0])) two.addPage(p);
        const twoBase64 = Buffer.from(await two.save()).toString('base64');

        const llm = fakeLlm({
            1: [WITH_FIG],
            2: [{ ...WITH_FIG, figure_box: [500, 100, 700, 500] }]   // 第 2 塊的「塊內第 1 頁」＝整份第 2 頁
        });
        const saved = process.env.JOB_PDF_CHUNK_PAGES;
        process.env.JOB_PDF_CHUNK_PAGES = '1';
        let seen = null;
        try {
            aiService._setDepsForTest({
                llm, models: GEMINI, logger: captureLogger().logger, runId: () => RUN,
                cropFigures: (opts) => {
                    seen = opts.questions.map(q => ({ idx: q.idx, page: q.figure_page }));
                    return cropFigures({ ...opts, figuresDir });
                }
            });
            const out = await aiService.analyzePdfContent(twoBase64);

            assert.equal(llm.calls.length, 2, '兩塊各呼叫一次');
            assert.deepEqual(seen, [{ idx: 1001, page: 1 }, { idx: 2001, page: 2 }], '整份一次交給裁圖，頁碼已換算');
            assert.deepEqual(out.map(q => q.question_img), [
                `/figures/legacy-${RUN}-1001.png`,
                `/figures/legacy-${RUN}-2001.png`
            ]);
            assert.deepEqual(fs.readdirSync(figuresDir).sort(), [`legacy-${RUN}-1001.png`, `legacy-${RUN}-2001.png`]);
        } finally {
            if (saved === undefined) delete process.env.JOB_PDF_CHUNK_PAGES; else process.env.JOB_PDF_CHUNK_PAGES = saved;
        }
    });

    test('預設請求編號：legacy-YYYYMMDDHHMMSS-6 碼十六進位；兩次分析不同名（不覆寫已入庫題目引用的圖）', async () => {
        const names = [];
        for (let i = 0; i < 2; i++) {
            aiService._setDepsForTest({
                llm: fakeLlm({ 1: [WITH_FIG] }), models: GEMINI, logger: captureLogger().logger,
                cropFigures: realCropInto(figuresDir)
            });
            const [q] = await aiService.analyzePdfContent(sampleBase64);
            assert.match(q.question_img, /^\/figures\/legacy-\d{14}-[0-9a-f]{6}-1001\.png$/);
            assert.ok(resolveFigurePath(q.question_img, figuresDir), 'Word 匯出與批次入庫的白名單要認得');
            names.push(q.question_img);
        }
        assert.notEqual(names[0], names[1]);
        assert.equal(fs.readdirSync(figuresDir).length, 2);
    });

    test('本機模式（MODEL_EXTRACT=ollama，預設值）：交叉驗證後的題帶視覺版的框，一樣會裁圖', async () => {
        // OCR 版不帶附圖欄位（本機模板要求它不輸出），合併時附圖欄位取視覺版的（extractLocalCrossCheck.test.js）
        const { figure_desc, figure_page, figure_box, ...ocrVersion } = WITH_FIG;
        const llm = fakeLlm({ 1: [WITH_FIG] }, { ocrByChunk: { 1: [ocrVersion] } });
        extract._setLocalDepsForTest({
            ocrPdf: async ({ fromPage, toPage }) => ({
                engine: 'paddleocr', engineVersion: 'test', dpi: 200, replayed: true, dispose() { },
                pages: Array.from({ length: toPage - fromPage + 1 }, (_, i) => ({ page: fromPage + i, markdown: '假 OCR 文字', imagePath: null }))
            }),
            renderPages: async () => { throw new Error('replay 不送圖片，不該渲染'); },
            llmMode: () => 'replay',
            ocrConfig: () => ({ engine: 'paddle', dpi: 200 })
        });
        aiService._setDepsForTest({
            llm, models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' },
            logger: captureLogger().logger, runId: () => RUN, cropFigures: realCropInto(figuresDir)
        });

        const out = await aiService.analyzePdfContent(sampleBase64);

        assert.deepEqual(llm.calls.map(c => c.agent).sort(), ['extract_ocr', 'extract_vision'].sort());
        assert.equal(out.length, 1);
        assert.deepEqual(Object.keys(out[0]), [...LEGACY_KEYS, 'question_img'], 'cross_check 等管線欄位不外漏到舊形狀');
        assert.equal(out[0].question_img, `/figures/legacy-${RUN}-1001.png`);
        assert.ok(fs.existsSync(path.join(figuresDir, `legacy-${RUN}-1001.png`)));
    });

    test('toLegacyShape：figure_img 不是非空字串就不加 question_img', () => {
        const base = { ...NO_FIG, idx: 1001 };
        for (const bad of [undefined, null, '', 0, ['/figures/x.png']]) {
            const shaped = aiService.toLegacyShape({ ...base, figure_img: bad });
            assert.deepEqual(Object.keys(shaped), LEGACY_KEYS, String(bad));
        }
        assert.equal(aiService.toLegacyShape({ ...base, figure_img: '/figures/legacy-x-1001.png' }).question_img,
            '/figures/legacy-x-1001.png');
        assert.equal(aiService.LEGACY_FIGURE_PREFIX, 'legacy');
    });
});

// ───────────────────────── 前端：上傳區預覽卡的附圖 ─────────────────────────

describe('public/index.html — /analyze-pdf 預覽卡顯示裁圖〔Owner 決策單 2026-09-25 B21〕', () => {
    const { install } = require('./lib/miniDom');
    const HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

    /** 從 inline script 取出一支具名函式的原始碼（大括號配對；這兩支函式內沒有字串裡的大括號） */
    function fnSource(name) {
        const start = HTML.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `index.html 找不到 function ${name}`);
        let depth = 0;
        for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
            if (HTML[i] === '{') depth += 1;
            else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
        }
        throw new Error(`function ${name} 的大括號沒有配對`);
    }

    let env;
    let legacyFigurePreview;
    beforeEach(() => {
        env = install();
        // eslint-disable-next-line no-new-func
        legacyFigurePreview = new Function(`${fnSource('el')}\n${fnSource('legacyFigurePreview')}\nreturn legacyFigurePreview;`)();
    });
    afterEach(() => env.restore());

    test('有 question_img 才在預覽卡加圖；「不要這張圖」把 question_img 從要入庫的那筆拿掉', () => {
        assert.match(HTML, /if \(q\.question_img\) card\.appendChild\(legacyFigurePreview\(q\)\);/);

        const q = { ...oldLegacyShape(NO_FIG), question_img: '/figures/legacy-x-1001.png' };
        const card = env.document.createElement('div');
        card.appendChild(legacyFigurePreview(q));
        const img = card.querySelector('img');
        assert.equal(img.src, '/figures/legacy-x-1001.png');
        const drop = card.querySelector('button');
        assert.equal(drop.textContent, '不要這張圖');

        drop.click();
        assert.ok(!('question_img' in q), '送 batch-save-questions 時不再帶圖');
        assert.equal(card.querySelector('img'), null);
        assert.deepEqual(Object.keys(q), LEGACY_KEYS, '其餘欄位不動');
    });

    test('圖載入失敗：換成一行提示，不留破圖', () => {
        const q = { ...oldLegacyShape(NO_FIG), question_img: '/figures/legacy-x-1001.png' };
        const card = env.document.createElement('div');
        card.appendChild(legacyFigurePreview(q));
        card.querySelector('img').dispatchEvent({ type: 'error' });
        assert.equal(card.querySelector('img'), null);
        assert.match(card.textContent, /附圖載入失敗/);
        assert.equal(q.question_img, '/figures/legacy-x-1001.png', '載入失敗不代替老師決定丟圖');
    });
});
