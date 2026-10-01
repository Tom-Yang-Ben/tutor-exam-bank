// ─────────────────────────────────────────────────────────────
// features.js — 功能旗標的唯一出入口（docs/interfaces-stage1.md 第 9 條）
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
    get FEATURE_PIPELINE() { return isEnabled('FEATURE_PIPELINE'); },

    // ── 階段 3（docs/interfaces-stage3.md 第 9 條）──
    // 三支都是「路由掛不掛載 + 前端分頁渲不渲染」的開關，預設全關。
    // 後端由各自的 routes 區塊讀（關閉時整條路由不掛載，請求落到 Express 預設 404），
    // 前端由 app.js 的 serveIndex 注入 <meta> 之後讀（第 7.2、7.3 條）。
    get FEATURE_STUDENTS() { return isEnabled('FEATURE_STUDENTS'); },
    get FEATURE_NLQ() { return isEnabled('FEATURE_NLQ'); },
    get FEATURE_VARIANTS() { return isEnabled('FEATURE_VARIANTS'); },

    // ── 階段 4 A1（docs/roadmap-plan.md §6.5 → 已執行）──
    // 對話式助教：主控 LLM 用受限 JSON 調度五個只讀工具。同樣是「路由掛不掛載 +
    // 前端分頁渲不渲染」的開關，預設關（會呼叫 LLM＝會花錢，CI 也不開）。
    get FEATURE_ASSISTANT() { return isEnabled('FEATURE_ASSISTANT'); },
    // 階段 5（docs/interfaces-stage5.md 第 1.3 條）：預設全關，與既有旗標同一種讀法
    get FEATURE_KC() { return isEnabled('FEATURE_KC'); },                   // 知識點分頁與 API（WS-C）
    get FEATURE_KC_TAGGING() { return isEnabled('FEATURE_KC_TAGGING'); },   // 入庫後自動標知識點（WS-C；會呼叫 LLM）
    get FEATURE_REMEDIAL() { return isEnabled('FEATURE_REMEDIAL'); },       // 依弱點出補救卷與題庫覆蓋率（WS-D）
    get FEATURE_TUTOR() { return isEnabled('FEATURE_TUTOR'); },             // AI 家教（WS-E）
    get FEATURE_VOICE() { return isEnabled('FEATURE_VOICE'); },             // 按住說話（WS-E；需 FEATURE_TUTOR）

    // ── 錯題重練與間隔複習（docs/retrain-and-review.md 第 5.1 節；DEC-003 例外條款、DEC-016）──
    // 預設關。管：新 API 是否掛載、畫面是否顯示、批改 API 是否接受「要重練」勾選（〔R1 選 2〕老師勾才進清單）、
    // 試卷明細是否多帶重練欄位、出卷 API 是否接受重練參數（第二階段之後才有）。不管：派題／作答拆表（migrations/0016，
    // 核心資料層，旗標關也生效）、刪卷／刪學生／合併學生時對重練資料的處理與既有項目的重算（資料完整性，一律執行）。
    // 讀取點：routes/index.js 檔尾的錯題重練區塊（掛載）、controllers/paperController.js（每次請求即時讀）、
    // app.js 注入前端 <meta name="feature-retrain">（__FEATURE_RETRAIN__）。
    // 名稱避開 review：/api/review 與 reviewController 已是拆題的「人工複核佇列」（FR-006）。
    get FEATURE_RETRAIN() { return isEnabled('FEATURE_RETRAIN'); }
};
