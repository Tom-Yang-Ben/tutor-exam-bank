// services/ocr/render.js — PDF 頁面 → PNG（給本機視覺模型看；docs/local-mode.md 第 4 條）
//
// 本機拆題的視覺版要「本塊每頁一張 PNG」。PaddleOCR 有開時直接用 ocr_pdf.py 轉好的那幾張
// （兩個引擎看的是同一批像素）；OCR_ENGINE=none、或 OCR 沒有回圖檔路徑時才走這一支。
// 用的是專案既有的 mupdf（WASM，services/mupdf.js），與 ocr_pdf.py 的 PyMuPDF 是同一個 MuPDF 核心，
// 所以不需要 Python 也畫得出同樣解析度的頁面。純程式步驟、零模型成本。

const { loadMupdf } = require('../mupdf');

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

module.exports = { renderPages };
