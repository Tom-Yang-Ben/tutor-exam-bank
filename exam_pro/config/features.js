// ─────────────────────────────────────────────────────────────
// features.js — 功能旗標的唯一出入口（docs/interfaces.md 第 9 條）
//
// 規則：
//   1. 只放**新功能**的開關，預設全關；DB 驅動層（config/db.js）不放旗標。
//   2. 布林值的解讀凍結為：字串 '1' 或 'true'（不分大小寫）為真，其餘皆為假。
//      「false」「0」「off」「no」「」「未設定」全部視為關閉——不做「只要有值就是真」，
//      否則 .env 寫 FEATURE_SIMILAR=false 反而會把功能打開。
//   3. 一律用 getter 即時讀 process.env，不在 require 當下就固定住值：
//      require 的時機早於某些測試設定環境變數，先讀先錯。
// ─────────────────────────────────────────────────────────────

/**
 * 凍結的布林解讀規則（純函式，可單元測試）。
 * @param {any} value
 * @returns {boolean}
 */
function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/**
 * 讀取某個旗標的目前狀態。
 * @param {string} name 環境變數全名，例如 'FEATURE_SIMILAR'
 * @returns {boolean}
 */
function isEnabled(name) {
    return parseBool(process.env[name]);
}

module.exports = {
    parseBool,
    isEnabled,
    // GET /api/questions/:id/similar 是否掛載（WS-C）
    get FEATURE_SIMILAR() { return isEnabled('FEATURE_SIMILAR'); },
    // listQuestions 是否改走 hybrid 檢索（WS-A + WS-C）
    get FEATURE_HYBRID_SEARCH() { return isEnabled('FEATURE_HYBRID_SEARCH'); },
    // 上傳區是否改走 POST /api/jobs（階段 2，interfaces-stage2.md 第 9 條）。
    // 讀取點有兩個，都經這裡：app.js 的 serveIndex 注入給前端（裁決 S2-20）、
    // workers/jobRunner.js 組 ctx.config.features.pipeline（裁決 S2-8）。
    get FEATURE_PIPELINE() { return isEnabled('FEATURE_PIPELINE'); }
};
