// ─────────────────────────────────────────────────────────────
// desktop/lib/downloads.js — Word 下載：跳「另存新檔」對話框（docs/desktop-app-design.md 第 3 條第 5 項）
//
// 前端不改：組卷、補救卷、重練卷的 Word 都是 fetch 回 Blob 再用 <a download="XX 段考（學生版）.docx"> 下載
// （public/index.html、public/js/remedial.js、public/js/retrain.js）。瀏覽器會直接存進「下載」資料夾；
// 桌面版在 session 的 will-download 不指定存檔路徑（不呼叫 setSavePath），Electron 就照一般流程跳出「另存新檔」，
// 這裡只用 setSaveDialogOptions 給預設值：
//   - 資料夾：上次存檔的資料夾（記在 desktop-state.json）；第一次是「文件\出卷」（沒有就建立）；
//   - 檔名：前端 download 屬性給的檔名（item.getFilename()），把 Windows 不能用的字元換成「_」；
//   - 類型：.docx 列「Word 文件」，其他列「所有檔案」。
// 純函式（路徑模組可注入：Windows 上是 path.win32）。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');

/** 第一次下載的預設資料夾（在「文件」底下） */
const DEFAULT_SUBDIR = '出卷';
const WORD_FILTER = Object.freeze({ name: 'Word 文件', extensions: ['docx'] });
const ALL_FILTER = Object.freeze({ name: '所有檔案', extensions: ['*'] });
const FALLBACK_NAME = '下載的檔案';
/** Windows 保留的裝置名稱（不能當檔名） */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * 檔名裡 Windows 不能用的字元換成「_」，去掉結尾的點與空白。純函式。
 * @param {string} name
 */
function sanitizeFileName(name) {
    let s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!s || /^_+$/.test(s)) s = FALLBACK_NAME;
    if (RESERVED.test(s)) s = `_${s}`;
    return s;
}

/**
 * 另存新檔對話框要從哪個資料夾開始：上次的資料夾（還在的話），否則「文件\出卷」。純函式。
 * @param {{lastDir?:string|null, documentsDir:string, exists?:(p:string)=>boolean, pathImpl?:typeof path}} o
 */
function defaultDownloadDir({ lastDir, documentsDir, exists = () => true, pathImpl = path }) {
    const last = String(lastDir || '').trim();
    return last && exists(last) ? last : pathImpl.join(documentsDir, DEFAULT_SUBDIR);
}

/**
 * setSaveDialogOptions 的內容。純函式。
 * @param {{filename:string, lastDir?:string|null, documentsDir:string, exists?:(p:string)=>boolean, pathImpl?:typeof path}} o
 */
function saveDialogOptions({ filename, lastDir, documentsDir, exists, pathImpl = path }) {
    const name = sanitizeFileName(filename);
    const dir = defaultDownloadDir({ lastDir, documentsDir, exists, pathImpl });
    const isWord = /\.docx$/i.test(name);
    return {
        title: '另存新檔',
        defaultPath: pathImpl.join(dir, name),
        buttonLabel: '儲存',
        filters: isWord ? [WORD_FILTER, ALL_FILTER] : [ALL_FILTER]
    };
}

/**
 * 下載完成後要記住的資料夾（存檔路徑的上一層）；沒有存檔路徑回 null。純函式。
 * @param {string} savePath
 * @param {typeof path} [pathImpl]
 */
function rememberedDir(savePath, pathImpl = path) {
    const p = String(savePath || '').trim();
    return p ? pathImpl.dirname(p) : null;
}

module.exports = { DEFAULT_SUBDIR, WORD_FILTER, ALL_FILTER, sanitizeFileName, defaultDownloadDir, saveDialogOptions, rememberedDir };
