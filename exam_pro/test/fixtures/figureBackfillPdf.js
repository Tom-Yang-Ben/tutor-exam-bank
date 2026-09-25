// test/fixtures/figureBackfillPdf.js — 舊題補附圖（scripts/backfill_figures.js）測試用的小 PDF
//
// 以公開樣卷 eval/fixtures/sample_exam.pdf（本專案自製，不涉及任何真實考卷）為底，用 pdf-lib 在指定位置畫上
// 圖形——不需要中文字型，CI 上產生得出來；每次產出都一樣（不寫時間戳）。座標一律是「頁面左上角為原點」的 PDF 點，
// 與 mupdf 讀出來的字行座標相同（樣卷的字行位置以 mupdf 實測：第 5 題題號行 y≈336、第 6 題 y≈383、第 8 題 y≈495、
// 第 9 題 y≈559、第 10 題 y≈623；題幹行最右到 x≈528）。
//
//   makeFigurePdf()   五種圖形：
//     ① 第 5 題右側的向量圖（三角形＋圓，頂點標 A、B）      → 應對到第 5 題，A、B 併進裁切範圍
//     ② 第 9 題右側的點陣圖                                    → 應對到第 9 題
//     ③ 第 10 題右側的向量圓                                   → 第 10 題不是候選題時不提議
//     ④ 卷首左上角的小點陣圖（校徽）                           → 卷首裝飾，不提議
//     ⑤ 第 8 題右側的 2×2 表格（橫豎線各三條、格內有數字）     → 表格，不算圖
//     ⑥ 第 7 題下方的一條底線                                  → 太小，不算圖
//   makeScannedPdf()  把樣卷第 1 頁渲染成點陣圖、整頁貼進新 PDF（沒有文字層，模擬掃描檔）

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');

/** 這幾個框（頁面座標）給測試比對用 */
const FIGURES = Object.freeze({
    q5Vector: [420, 338, 500, 378],
    q9Image: [520, 562, 585, 612],
    q10Vector: [450, 628, 520, 680],
    headerImage: [20, 20, 60, 50],
    q8Table: [490, 497, 580, 545]
});

async function solidPng(width, height, rgb) {
    const sharp = require('sharp');
    return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

/**
 * @returns {Promise<Buffer>} 帶圖的樣卷
 */
async function makeFigurePdf() {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(SAMPLE_PDF), { updateMetadata: false });
    const page = doc.getPage(0);
    const H = page.getHeight();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const at = (x, y) => ({ x, y: H - y });
    const black = rgb(0, 0, 0);

    // ① 第 5 題右側：三角形 A(424,374)–B(496,374)–頂點(460,342) ＋ 圓；A、B 兩個標註在線條外面
    page.drawLine({ start: at(424, 374), end: at(496, 374), thickness: 1, color: black });
    page.drawLine({ start: at(424, 374), end: at(460, 342), thickness: 1, color: black });
    page.drawLine({ start: at(460, 342), end: at(496, 374), thickness: 1, color: black });
    page.drawCircle({ ...at(460, 362), size: 6, borderWidth: 1, borderColor: black });
    page.drawText('A', { ...at(412, 382), size: 8, font, color: black });
    page.drawText('B', { ...at(500, 382), size: 8, font, color: black });

    // ② 第 9 題右側的點陣圖
    const img9 = await doc.embedPng(await solidPng(65, 50, [200, 120, 60]));
    page.drawImage(img9, { x: 520, y: H - 612, width: 65, height: 50 });

    // ③ 第 10 題右側的向量圓
    page.drawCircle({ ...at(485, 654), size: 26, borderWidth: 1, borderColor: black });

    // ④ 卷首左上角的小點陣圖
    const logo = await doc.embedPng(await solidPng(40, 30, [30, 60, 160]));
    page.drawImage(logo, { x: 20, y: H - 50, width: 40, height: 30 });

    // ⑤ 第 8 題右側的 2×2 表格
    for (const y of [497, 521, 545]) page.drawLine({ start: at(490, y), end: at(580, y), thickness: 0.8, color: black });
    for (const x of [490, 535, 580]) page.drawLine({ start: at(x, 497), end: at(x, 545), thickness: 0.8, color: black });
    [['1', 508, 512], ['2', 553, 512], ['3', 508, 536], ['4', 553, 536]].forEach(([t, x, y]) => {
        page.drawText(t, { ...at(x, y), size: 9, font, color: black });
    });

    // ⑥ 第 7 題下方的一條底線
    page.drawLine({ start: at(70, 486), end: at(200, 486), thickness: 0.5, color: black });

    return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * @returns {Promise<Buffer>} 樣卷第 1 頁的整頁點陣圖（沒有文字層）
 */
async function makeScannedPdf() {
    const { PDFDocument } = require('pdf-lib');
    const mupdf = await require('../../services/mupdf').loadMupdf();
    const src = mupdf.Document.openDocument(fs.readFileSync(SAMPLE_PDF), 'application/pdf');
    let png;
    let size;
    try {
        const page = src.loadPage(0);
        const b = page.getBounds();
        size = [b[2] - b[0], b[3] - b[1]];
        const pix = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true);
        png = Buffer.from(pix.asPNG());
        pix.destroy();
        page.destroy();
    } finally {
        src.destroy();
    }
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage(size);
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 0, y: 0, width: size[0], height: size[1] });
    return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { makeFigurePdf, makeScannedPdf, FIGURES, SAMPLE_PDF };
