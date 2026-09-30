// ─────────────────────────────────────────────────────────────
// desktop/test/smoke/native-probe.js — 冒煙測試用：在 utilityProcess 裡載入後端的三個「不是純 JS」的相依（R-6）
//
// 後端（backend-entry.js）跑在 Electron 的 utilityProcess：Node 是 Electron 內建的那一版（44.4.5 → Node 24.21），
// 不是系統的 node。平常開啟時只有拆題、Word 附圖、查題才會載入這三個，冒煙測試的 basic 情境碰不到，
// 所以由 hook.js 用同一個 utilityProcess.fork 另開一個行程，照後端的載入方式各跑一次：
//   - sharp（Node-API）：產生 2×2 的 PNG 再讀回尺寸（services/wordService.js 的用法）；
//   - @node-rs/jieba（Node-API）：經 utils/tokenize.js 切一句中文（查題、寫 search_tsv 的路徑）；
//   - mupdf（ESM＋WASM）：經 services/mupdf.js 的 loadMupdf 打開自製樣卷、數頁數（附圖裁切、拆題的路徑）。
// 結果用 parentPort 回傳給主行程（hook.js 記成 native 事件）。只驗 Linux 版的二進位；Windows 版在 Owner 驗收第 4 步。
// 這支不是產品的一部分：B3 打包時不帶 test/。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const APP = path.resolve(__dirname, '..', '..', '..', 'exam_pro');
const appRequire = createRequire(path.join(APP, 'package.json'));

async function probe() {
    const out = { node: process.versions.node, electron: process.versions.electron || null };
    try {
        const sharp = appRequire('sharp');
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
        const meta = await sharp(png).metadata();
        out.sharp = meta.width === 2 && meta.height === 2 ? 'ok' : `bad:${meta.width}x${meta.height}`;
    } catch (err) {
        out.sharp = `err:${err && err.message}`;
    }
    try {
        const { tokenize } = require(path.join(APP, 'utils', 'tokenize'));
        const tokens = tokenize('二次函數的圖形與頂點');
        out.jieba = tokens.length > 0 ? 'ok' : 'bad:empty';
        out.jiebaTokens = tokens;
    } catch (err) {
        out.jieba = `err:${err && err.message}`;
    }
    try {
        const mupdf = await require(path.join(APP, 'services', 'mupdf')).loadMupdf();
        const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(APP, 'eval', 'fixtures', 'sample_exam.pdf')), 'application/pdf');
        const pages = doc.countPages();
        out.mupdf = pages > 0 ? 'ok' : 'bad:0';
        out.mupdfPages = pages;
    } catch (err) {
        out.mupdf = `err:${err && err.message}`;
    }
    return out;
}

probe().then(out => {
    if (process.parentPort) process.parentPort.postMessage(out);
    else console.log(JSON.stringify(out));
    process.exit(0);
}, err => {
    if (process.parentPort) process.parentPort.postMessage({ error: String((err && err.stack) || err) });
    process.exit(1);
});
