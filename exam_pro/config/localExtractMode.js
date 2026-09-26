// config/localExtractMode.js — 本機拆題的模式（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// Owner 2026-09-26 實測（純 CPU、16 GB）：qwen3-vl:8b 看 1 頁 200 DPI 的樣卷要 54 分鐘、輸出的 JSON 還不合法；
// PaddleOCR 整份樣卷約 4 分鐘、qwen3:8b 約每秒 2 個 token。決定「這台電腦的拆題改成 OCR 為主」。
//
//   LOCAL_EXTRACT_MODE
//     cross（預設）  PaddleOCR＋視覺模型各拆一次、交叉比對（docs/local-mode.md 第 4 條，原本的行為一個字都沒改）
//     ocr           只跑 PaddleOCR 與文字模型整理（extract_ocr），不呼叫視覺模型；沒有第二版可以比對，
//                   所以每一題都停在人工複核（needs_review('ocr_only')）；附圖依 OCR 的版面位置配，配不到的標提示
//
// 只在拆題模型（MODEL_EXTRACT）是 ollama 時有意義；Gemini 模式完全不讀它。
// 讀法照 repo 的慣例（services/ocr 的 OCR_ENGINE、workers/jobRunner.js 的 SOURCE_CHECK_MODE）：
// 未設或空字串＝預設；大小寫、前後空白不計；非法值退回預設並警告一次（同一個值只警告一次）。
//
// 矛盾設定：LOCAL_EXTRACT_MODE=ocr 需要 OCR，OCR_ENGINE=none 卻是「不做 OCR」。兩個擇一的規則都會讓 Owner
// 以為自己設的那一個生效了，所以不猜：拆題模型是 ollama 時，runner 建立時（伺服器啟動、node workers/jobRunner.js）
// 直接丟錯（assertLocalExtractConfig），agents/extract.js 在沒有經過 runner 的呼叫端（eval、舊的 /analyze-pdf）
// 回 {kind:'error'}，訊息同一句。
//
// 純設定：不 require 其他模組、不連 DB。

const LOCAL_EXTRACT_MODES = Object.freeze(['cross', 'ocr']);
const DEFAULT_LOCAL_EXTRACT_MODE = 'cross';

const warnedOnce = new Set();

/**
 * LOCAL_EXTRACT_MODE → 'cross' | 'ocr'。
 * @param {object} [env] 預設 process.env
 * @returns {'cross'|'ocr'}
 */
function resolveLocalExtractMode(env = process.env) {
    const raw = String((env && env.LOCAL_EXTRACT_MODE) ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_LOCAL_EXTRACT_MODE;
    if (LOCAL_EXTRACT_MODES.includes(raw)) return raw;
    if (!warnedOnce.has(raw)) {
        warnedOnce.add(raw);
        console.warn(`[config] LOCAL_EXTRACT_MODE 只接受 cross／ocr，收到「${env.LOCAL_EXTRACT_MODE}」，改用 ${DEFAULT_LOCAL_EXTRACT_MODE}（交叉驗證）。`);
    }
    return DEFAULT_LOCAL_EXTRACT_MODE;
}

/**
 * 矛盾設定的說明；不矛盾回 null。
 * @param {{localExtract:boolean, mode:string, ocrEngine:string}} c
 *        localExtract：拆題模型是不是 ollama（Gemini 模式一律不矛盾）
 * @returns {string|null}
 */
function localExtractConflict({ localExtract, mode, ocrEngine } = {}) {
    if (localExtract !== true || mode !== 'ocr' || ocrEngine !== 'none') return null;
    return '設定互相矛盾：LOCAL_EXTRACT_MODE=ocr（只用 OCR 拆題）需要 PaddleOCR，但 OCR_ENGINE=none（不做 OCR）。' +
        '請在 .env 擇一：要只用 OCR 拆題，把 OCR_ENGINE 那一行刪掉（或設成 paddle）；' +
        '要只用看圖模型、不做 OCR，把 LOCAL_EXTRACT_MODE 那一行刪掉（或設成 cross）。改完重啟伺服器。';
}

/**
 * 矛盾就丟錯（err.code = 'LOCAL_EXTRACT_CONFLICT'）。
 * @param {{localExtract:boolean, mode:string, ocrEngine:string}} c
 */
function assertLocalExtractConfig(c) {
    const msg = localExtractConflict(c);
    if (msg) throw Object.assign(new Error(msg), { code: 'LOCAL_EXTRACT_CONFLICT' });
}

/** 測試用：清掉「警告過了」的紀錄 */
function _resetForTest() {
    warnedOnce.clear();
}

module.exports = {
    LOCAL_EXTRACT_MODES, DEFAULT_LOCAL_EXTRACT_MODE,
    resolveLocalExtractMode, localExtractConflict, assertLocalExtractConfig,
    _resetForTest
};
