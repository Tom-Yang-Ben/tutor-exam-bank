// services/ocr/render.js — PDF 頁面 → PNG（給本機視覺模型看；docs/local-mode.md 第 4 條）
//
// 本機拆題的視覺版要「本塊每頁一張 PNG」。PaddleOCR 有開時直接用 ocr_pdf.py 轉好的那幾張
// （兩個引擎看的是同一批像素）；OCR_ENGINE=none、或 OCR 沒有回圖檔路徑時才走這一支。
// 用的是專案既有的 mupdf（WASM，services/mupdf.js），與 ocr_pdf.py 的 PyMuPDF 是同一個 MuPDF 核心，
// 所以不需要 Python 也畫得出同樣解析度的頁面。純程式步驟、零模型成本。

//
// 〔看圖拆題逾時〕選用的加速設定 VISION_MAX_EDGE_PX（docs/local-mode.md 第 10.11 條選項 b）：
// 送給視覺模型之前，把每頁 PNG 的長邊縮到這個像素（等比例、只縮不放）。**未設／0＝不縮**，送出的位元組與之前相同。
// Qwen-VL 系列讀圖的 token 數大致與像素數成正比，長邊縮小讀圖就快；代價是小字、上下標、分式可能看不清。
// 只影響視覺模型看到的圖：OCR 用自己的原圖（OCR_DPI），附圖裁切另外從 PDF 渲染；圖片也不在 cassette 的鍵裡，不必重錄。

const { loadMupdf } = require('../mupdf');

/** VISION_MAX_EDGE_PX 的合法範圍（小於下限的值幾乎一定看不清題目，當成打錯字不縮） */
const VISION_MAX_EDGE_MIN = 512;
const VISION_MAX_EDGE_MAX = 10000;

/**
 * VISION_MAX_EDGE_PX → 長邊上限（像素）；未設、0、非整數或超出範圍一律 0（不縮，與之前相同）。
 * @param {object} [env]
 * @returns {number}
 */
function visionMaxEdgeFromEnv(env = process.env) {
    const n = Number.parseInt(env.VISION_MAX_EDGE_PX, 10);
    return Number.isInteger(n) && n >= VISION_MAX_EDGE_MIN && n <= VISION_MAX_EDGE_MAX ? n : 0;
}

/**
 * 把每張 PNG 的長邊縮到 maxEdge 以內（sharp，等比例、只縮不放）。maxEdge ≤ 0 時原樣回傳（同一批 Buffer，連讀都不讀）；
 * 本來就不超過的那張也原樣回傳（不重新編碼）。
 * @param {Buffer[]} pngs
 * @param {number} maxEdge
 * @returns {Promise<Buffer[]>}
 */
async function fitLongEdge(pngs, maxEdge) {
    if (!(Number(maxEdge) > 0)) return pngs;
    const sharp = require('sharp');
    const out = [];
    for (const png of pngs) {
        const meta = await sharp(png).metadata();
        if (Math.max(meta.width || 0, meta.height || 0) <= maxEdge) { out.push(png); continue; }
        out.push(await sharp(png).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
    }
    return out;
}

/**
 * @param {{pdfBytes:Buffer, fromPage:number, toPage:number, dpi:number}} opts  頁碼 1 起算、兩端皆含
 * @returns {Promise<Buffer[]>} 依頁序排列的 PNG
 */
async function renderPages({ pdfBytes, fromPage, toPage, dpi }) {
    const mupdf = await loadMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    try {
        const total = doc.countPages();
        if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 1 || toPage < fromPage || toPage > total) {
            throw new Error(`renderPages：頁碼範圍不合法（${fromPage}～${toPage}，這份 PDF 共 ${total} 頁）。`);
        }
        const scale = (Number(dpi) > 0 ? Number(dpi) : 200) / 72;
        const out = [];
        for (let n = fromPage; n <= toPage; n++) {
            const page = doc.loadPage(n - 1);
            const pixmap = page.toPixmap(
                mupdf.Matrix.scale(scale, scale),
                mupdf.ColorSpace.DeviceRGB,
                false,   // 不要 alpha（與 ocr_pdf.py 的 alpha=False 一致）
                true
            );
            out.push(Buffer.from(pixmap.asPNG()));
            pixmap.destroy();
            page.destroy();
        }
        return out;
    } finally {
        doc.destroy();
    }
}

module.exports = { renderPages, visionMaxEdgeFromEnv, fitLongEdge, VISION_MAX_EDGE_MIN, VISION_MAX_EDGE_MAX };
