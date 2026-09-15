// utils/pdfSniff.js — 上傳檔「真的是 PDF」的最小判定
//
// multer 只看得到瀏覽器宣告的 mimetype 與檔名，兩者都是客戶端說了算；把 .txt 改名成 .pdf
// 就能通過。PDF 規範要求檔案開頭（規範允許前面有少量垃圾位元組，實務上取前 1024 bytes）
// 出現 `%PDF-` 檔頭，這裡只認這一件事——不解析整份 PDF，壞檔交給後面的 pdf-lib／mupdf 報錯。
const HEADER = Buffer.from('%PDF-', 'latin1');
const WINDOW = 1024;

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {boolean} 前 1024 bytes 內含 `%PDF-` 即 true
 */
function isPdfBuffer(buf) {
    if (!buf || typeof buf.length !== 'number' || buf.length < HEADER.length) return false;
    const head = Buffer.isBuffer(buf) ? buf.subarray(0, WINDOW) : Buffer.from(buf.subarray(0, WINDOW));
    return head.indexOf(HEADER) !== -1;
}

module.exports = { isPdfBuffer, PDF_HEADER: '%PDF-', SNIFF_WINDOW: WINDOW };
