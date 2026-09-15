// services/mupdf.js — mupdf 的共用載入器
//
// mupdf 的 npm 套件是 ESM-only 的 WASM；CommonJS 這邊只能動態 import，且整個行程只載一次
// （WASM 初始化約數百毫秒）。附圖裁切（services/figureService.js）與原卷文字層
// （services/sourceTextService.js）共用這一份。

let mupdfPromise = null;

/** @returns {Promise<object>} mupdf 模組（default export 優先） */
function loadMupdf() {
    if (!mupdfPromise) {
        mupdfPromise = import('mupdf').then(ns => ns.default ?? ns);
    }
    return mupdfPromise;
}

module.exports = { loadMupdf };
