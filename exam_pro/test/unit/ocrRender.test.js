// services/ocr/render.js 的單元測試（〔本機模式 L2〕OCR_ENGINE=none 或 OCR 沒回圖檔時，視覺模型的頁面圖片從這裡來）
// 用專案既有的 mupdf（WASM）實際轉圖，不需要 Python。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

const { renderPages } = require('../../services/ocr/render');

async function makePdf(sizes) {
    const doc = await PDFDocument.create();
    for (const [w, h] of sizes) doc.addPage([w, h]);
    return Buffer.from(await doc.save());
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('services/ocr/render — renderPages', () => {
    test('只轉 fromPage～toPage（1 起算、兩端皆含），每頁一張 PNG，解析度依 DPI', async () => {
        const pdf = await makePdf([[72, 72], [144, 72], [72, 144]]);
        const pngs = await renderPages({ pdfBytes: pdf, fromPage: 2, toPage: 3, dpi: 144 });
        assert.equal(pngs.length, 2);
        for (const png of pngs) assert.ok(png.subarray(0, 8).equals(PNG_MAGIC));
        const m0 = await sharp(pngs[0]).metadata();
        const m1 = await sharp(pngs[1]).metadata();
        assert.deepEqual([m0.width, m0.height], [288, 144], '第 2 頁 144×72pt × (144/72)');
        assert.deepEqual([m1.width, m1.height], [144, 288]);
        assert.equal(m0.hasAlpha, false, '不帶 alpha（與 ocr_pdf.py 一致）');
    });

    test('頁碼範圍不合法 → 丟錯', async () => {
        const pdf = await makePdf([[72, 72]]);
        await assert.rejects(renderPages({ pdfBytes: pdf, fromPage: 1, toPage: 2, dpi: 72 }), /頁碼範圍不合法/);
        await assert.rejects(renderPages({ pdfBytes: pdf, fromPage: 0, toPage: 1, dpi: 72 }), /頁碼範圍不合法/);
        await assert.rejects(renderPages({ pdfBytes: pdf, fromPage: 2, toPage: 1, dpi: 72 }), /頁碼範圍不合法/);
    });

    test('DPI 沒給或不合法 → 200', async () => {
        const pdf = await makePdf([[72, 72]]);
        const [png] = await renderPages({ pdfBytes: pdf, fromPage: 1, toPage: 1 });
        const m = await sharp(png).metadata();
        assert.equal(m.width, 200);
    });
});
