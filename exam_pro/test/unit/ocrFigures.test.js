// services/ocr 與 ocr_service/ocr_pdf.py 的版面附圖（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// ocr_pdf.py 從 PP-StructureV3 的版面結果（parsing_res_list）帶出每頁的圖框：
//   pages[].figures = [{ label:'image'|'chart'|'seal', box:[ymin,xmin,ymax,xmax]（0–1000）|null }]
// 依閱讀順序、與 markdown 裡的「[圖]」一一對應；辨識結果（markdown）一個字都不變，所以 OCR cassette 的鍵（ocr.v1）不變。
// services/ocr 解析、錄進 cassette、回放時帶出來；舊版（沒有 figures）一律當作「不知道」（鍵不存在）。
// Python 那一段只在這台機器有 python3 時跑（不需要 PaddleOCR：用鴨子型別的假區塊）。
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ocr = require('../../services/ocr');

const APP_DIR = path.resolve(__dirname, '..', '..');
const FAKE_OCR = path.join(APP_DIR, 'test', 'fixtures', 'fakeOcr', 'fake_ocr_pdf.js');
const PDF = Buffer.from('%PDF-1.4 fake');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');

function fakeConfig(extra = {}) {
    return { engine: 'paddle', python: process.execPath, script: FAKE_OCR, dpi: 200, timeoutMs: 20000, ...extra };
}

async function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

describe('services/ocr — sanitizeFigures／parseOcrOutput', () => {
    test('合法的框原樣保留（四捨五入成整數、夾在 0～1000）；壞掉的框變 null（保留順序與張數）', () => {
        assert.deepEqual(ocr.sanitizeFigures([
            { label: 'image', box: [10, 20, 300, 400] },
            { label: 'Chart', box: [0.4, 1.6, 999.5, 1200] },
            { label: 'image', box: [300, 20, 10, 400] },
            { label: 'image', box: [1, 2, 3] },
            { label: 'image' },
            { box: [1, 2, 3, 4] },
            'x'
        ]), [
            { label: 'image', box: [10, 20, 300, 400] },
            { label: 'chart', box: [0, 2, 1000, 1000] },
            { label: 'image', box: null },
            { label: 'image', box: null },
            { label: 'image', box: null },
            { label: 'unknown', box: [1, 2, 3, 4] },
            { label: 'unknown', box: null }
        ]);
    });

    test('不是陣列 → undefined（＝不知道；與「這一頁沒有圖」的 [] 分開）', () => {
        assert.equal(ocr.sanitizeFigures(undefined), undefined);
        assert.equal(ocr.sanitizeFigures(null), undefined);
        assert.equal(ocr.sanitizeFigures({}), undefined);
        assert.deepEqual(ocr.sanitizeFigures([]), []);
    });

    test('parseOcrOutput：有 figures 才帶出 figures 鍵；沒有的頁照舊三個鍵', () => {
        const out = JSON.stringify({
            engine: 'paddleocr', engine_version: '3.7.0', dpi: 200,
            pages: [
                { page: 1, markdown: 'a [圖]', image: null, figures: [{ label: 'image', box: [1, 2, 3, 4] }] },
                { page: 2, markdown: 'b', image: null }
            ]
        });
        const r = ocr.parseOcrOutput(out, { fromPage: 1, toPage: 2 });
        assert.deepEqual(r.pages[0], { page: 1, markdown: 'a [圖]', imagePath: null, figures: [{ label: 'image', box: [1, 2, 3, 4] }] });
        assert.deepEqual(Object.keys(r.pages[1]).sort(), ['imagePath', 'markdown', 'page']);
    });

    test('pagesToText 不看 figures（ocrSha256 與 extract_ocr 的 cassette 鍵不變）', () => {
        const a = ocr.pagesToText([{ page: 1, markdown: 'x [圖]' }]);
        const b = ocr.pagesToText([{ page: 1, markdown: 'x [圖]', figures: [{ label: 'image', box: [1, 2, 3, 4] }] }]);
        assert.equal(a, b);
    });
});

describe('services/ocr — figures 的錄製與回放（假 ocr_pdf.py）', () => {
    let cassetteDir;
    before(() => { cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fig-cassette-')); });
    after(() => { fs.rmSync(cassetteDir, { recursive: true, force: true }); });

    test('live：figures 帶出來（第 1 頁一張圖、第 2 頁一個壞框）', async () => {
        await withEnv({ FAKE_OCR_MODE: 'figures' }, async () => {
            const r = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, mode: 'live', config: fakeConfig() });
            try {
                assert.deepEqual(r.pages.map(p => p.figures), [
                    [{ label: 'image', box: [100, 150, 400, 850] }],
                    [{ label: 'image', box: null }]
                ]);
            } finally {
                r.dispose();
            }
        });
    });

    test('record 把 figures 寫進 cassette 的 response（鍵不變）；replay 帶回來、imagePath 仍是 null', async () => {
        await withEnv({ FAKE_OCR_MODE: 'figures', EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            const log = console.log;
            console.log = () => { };
            let rec;
            try {
                rec = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, mode: 'record', config: fakeConfig() });
            } finally {
                console.log = log;
            }
            rec.dispose();
            const key = ocr.ocrCassetteKey({ engineVersion: '3.7.0', pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, dpi: 200 });
            assert.equal(rec.cassetteKey, key, 'figures 不進鍵');
            const tape = JSON.parse(fs.readFileSync(path.join(cassetteDir, 'ocr', `${key}.json`), 'utf8'));
            assert.deepEqual(tape.response.pages.map(p => Object.keys(p).sort()), [['figures', 'markdown', 'page'], ['figures', 'markdown', 'page']]);

            const rep = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, mode: 'replay', config: fakeConfig({ python: '/不會被呼叫' }) });
            assert.deepEqual(rep.pages.map(p => p.figures), rec.pages.map(p => p.figures));
            assert.deepEqual(rep.pages.map(p => p.imagePath), [null, null]);
        });
    });

    test('舊 cassette（沒有 figures）回放：頁物件沒有 figures 鍵', async () => {
        await withEnv({ FAKE_OCR_MODE: 'ok', EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            const log = console.log;
            console.log = () => { };
            try {
                (await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 3, toPage: 3, mode: 'record', config: fakeConfig() })).dispose();
            } finally {
                console.log = log;
            }
            const rep = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 3, toPage: 3, mode: 'replay', config: fakeConfig() });
            assert.ok(!('figures' in rep.pages[0]));
        });
    });
});

describe('ocr_service/ocr_pdf.py — page_figures（PaddleX 3.7 的 LayoutBlock 鴨子型別）', () => {
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    const skip = probe.error || probe.status !== 0 ? '這台機器沒有 python3（CI 與 Owner 的 Windows 不一定有）；ocr_pdf.py 的其餘部分由錄製驗證' : false;

    function runPy(body) {
        const script = [
            'import sys, json',
            `sys.path.insert(0, ${JSON.stringify(path.join(APP_DIR, 'ocr_service'))})`,
            'import ocr_pdf',
            'class B:',
            '    def __init__(self, label, bbox, image=True):',
            '        self.label = label',
            '        self.bbox = bbox',
            '        self.image = {"path": "imgs/x.jpg"} if image else None',
            body
        ].join('\n');
        const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop());
    }

    test('只收會變成「[圖]」的區塊（image／chart／seal 且有裁圖），依閱讀順序；像素框 → [ymin,xmin,ymax,xmax] 0–1000', { skip }, () => {
        const out = runPy([
            'res = {"parsing_res_list": [',
            '    B("text", [0, 0, 10, 10]),',
            '    B("image", [100, 200, 300, 400]),',
            '    B("header_image", [0, 0, 50, 50], image=False),',
            '    B("chart", [0, 0, 1654, 2339]),',
            '    B("image", [10, 10, 20, 20], image=False),',
            '    B("seal", [10, 20, 30, 40]),',
            '    B("image", [5, 5, 5, 5]),',
            ']}',
            'print(json.dumps(ocr_pdf.page_figures([res], 1654, 2339)))'
        ].join('\n'));
        assert.deepEqual(out, [
            { label: 'image', box: [86, 60, 171, 181] },
            { label: 'chart', box: [0, 0, 1000, 1000] },
            { label: 'seal', box: [9, 6, 17, 18] },
            { label: 'image', box: null }
        ]);
    });

    test('JSON 形狀（block_label／block_bbox）也認得；讀不到版面 → None（交給 JS 當作「不知道」）', { skip }, () => {
        const out = runPy([
            'a = ocr_pdf.page_figures([{"parsing_res_list": [{"block_label": "image", "block_bbox": [0, 0, 827, 1169.5]}]}], 1654, 2339)',
            'b = ocr_pdf.page_figures([{"no_layout": 1}], 1654, 2339)',
            'c = ocr_pdf.page_figures([], 1654, 2339)',
            'print(json.dumps([a, b, c]))'
        ].join('\n'));
        assert.deepEqual(out, [[{ label: 'image', box: [0, 0, 500, 500] }], null, []]);
    });

    test('FIGURE_LABELS 與 PaddleX 3.7.2 產生 markdown 圖片的標籤一致（image、chart、seal）', { skip }, () => {
        assert.deepEqual(runPy('print(json.dumps(list(ocr_pdf.FIGURE_LABELS)))'), ['image', 'chart', 'seal']);
    });
});
