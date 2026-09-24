// config/models.js — 模型路由（docs/interfaces-stage2.md 第 5.4 條）
//
// 全案只有這一支解析 'vendor:model-id'。目的有兩個：
//   1. 讓 services/llm 能依 vendor 挑 adapter，同時把「裸 ID」交給 SDK
//      （cassette 的鍵也只認裸 ID，第 5.2 條）。
//   2. 讓「用哪個模型」變成環境變數，程式碼裡一個字串都不寫死
//      （現況 services/aiService.js 把 'gemini-2.5-flash' 寫死在第 6 行，A-T8 一併拔掉）。
//
// MODEL_EXTRACT / MODEL_VERIFY 是 getter 而不是快照：測試會改 process.env 再讀，
// 若在 require 當下就取值，改了環境變數也不會生效。
//
// 〔本機模式 L1，docs/local-mode.md 第 2、3 條〕預設改走本機 Ollama（Owner 2026-09-25 裁決：預設本機、Gemini 保留）：
//   - VENDORS 加 'ollama'；Ollama 的模型名本身就有冒號（qwen3:8b），parseModel 只切**第一個**冒號。
//   - 沒設 MODEL_EXTRACT／MODEL_VERIFY／EMBED_MODEL 時一律是本機模型；要用 Gemini 就在 .env 明寫 gemini:…。
//     舊的 Gemini 預設（gemini:gemini-3.5-flash、gemini:gemini-3.1-pro-preview）留在 GEMINI_DEFAULTS 給文件與測試對照。
//   - CI 沒有 .env：cassette 的鍵含模型 ID，CI 用哪個模型寫在 .github/workflows/ci.yml（由 L4 改成本機預設）。

const VENDORS = ['gemini', 'anthropic', 'openai', 'ollama'];

const DEFAULT_EXTRACT = 'ollama:qwen3-vl:8b';   // 本機模式第 2 條：視覺＋文字（拆題看頁面圖片）
const DEFAULT_VERIFY = 'ollama:qwen3:8b';       // 本機模式第 2 條：純文字（驗算、出變式、OCR 結構化）
// embedding：有 vendor 前綴才走該供應商；沒有前綴的舊值（gemini-embedding-001）一律視為 Gemini（第 2 條）
const DEFAULT_EMBED = 'ollama:qwen3-embedding:0.6b';

/** 切回 Gemini 時的建議值（.env 範例與文件用；程式不會自己退回它們） */
const GEMINI_DEFAULTS = Object.freeze({
    MODEL_EXTRACT: 'gemini:gemini-3.5-flash',       // 裁決 S0-5
    MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview',  // 裁決 S2-29
    EMBED_MODEL: 'gemini-embedding-001'
});

// ── 階段 3（docs/interfaces-stage3.md 第 9 條，擁有者：WS-B）──
// MODEL_VARIANT 是變式生成用的模型，**未設時退回 MODEL_VERIFY**（推理強、與拆題不同家）。
// 「退回」這一步刻意**不寫進本檔的 getter**：第 9 條註明「MODEL_VARIANT 未設時退回
// MODEL_VERIFY 的解析在 config/models.js 之外做」。所以這裡只誠實回報「有沒有設」
// （沒設回 null），由 workers/jobRunner.js 組 ctx.config.models 時決定退回哪一個。
// 既有兩個 getter 與 warnIfSameModel() 的語意因此一個字都沒動。

/**
 * 解析 'vendor:model-id'；沒有冒號時 vendor 預設 'gemini'。
 * 只切第一個冒號：'ollama:qwen3:8b' → { vendor:'ollama', id:'qwen3:8b' }。
 * @param {string} spec
 * @returns {{vendor:string, id:string, spec:string}}
 * @throws  vendor 不在 VENDORS（gemini／anthropic／openai／ollama）內、或 id 為空時丟錯
 */
function parseModel(spec) {
    const raw = String(spec ?? '').trim();
    if (!raw) throw new Error('parseModel：模型字串是空的（請設 MODEL_EXTRACT／MODEL_VERIFY）。');

    const sep = raw.indexOf(':');
    const vendor = sep === -1 ? 'gemini' : raw.slice(0, sep).trim().toLowerCase();
    const id = sep === -1 ? raw : raw.slice(sep + 1).trim();

    if (!VENDORS.includes(vendor)) {
        throw new Error(`parseModel：未知的供應商「${vendor}」，只接受 ${VENDORS.join('／')}（收到「${raw}」）。`);
    }
    if (!id) throw new Error(`parseModel：「${raw}」缺少模型 ID。`);

    return { vendor, id, spec: `${vendor}:${id}` };
}

/**
 * 啟動時呼叫一次：MODEL_VERIFY 與 MODEL_EXTRACT 的裸 ID 相同時 console.warn（不中止）。
 * 同一個模型自己驗自己幾乎沒有偵錯能力——它會用同一套先驗犯同一個錯。
 * 不同 ID（哪怕同一家）就不警告：A-T0 spike 證實免費金鑰用不了 Pro 系列，
 * 「同家不同級」是本專案目前唯一做得到的異級驗證（裁決 S0-5）。
 * @returns {boolean} 有沒有印出警告（給單元測試斷言用）
 */
function warnIfSameModel() {
    let extract, verify;
    try {
        extract = parseModel(module.exports.MODEL_EXTRACT);
        verify = parseModel(module.exports.MODEL_VERIFY);
    } catch (err) {
        console.warn(`[models] 模型設定無法解析：${err.message}`);
        return false;
    }
    if (extract.id === verify.id) {
        console.warn(`[models] MODEL_VERIFY 與 MODEL_EXTRACT 是同一個模型（${extract.id}），驗證幾乎無效`);
        return true;
    }
    return false;
}

module.exports = {
    parseModel, warnIfSameModel, VENDORS,
    // 本機模式 L1：預設值本身也匯出（eval／腳本要顯示「沒設時用哪個」時讀這裡，不要自己再寫一份字串）
    DEFAULT_EXTRACT, DEFAULT_VERIFY, DEFAULT_EMBED, GEMINI_DEFAULTS
};

// 兩個 getter：即時讀 process.env，語法上仍是 models.MODEL_EXTRACT 的屬性存取（第 5.4 條的匯出形狀）
Object.defineProperty(module.exports, 'MODEL_EXTRACT', {
    enumerable: true,
    get: () => process.env.MODEL_EXTRACT || DEFAULT_EXTRACT
});
Object.defineProperty(module.exports, 'MODEL_VERIFY', {
    enumerable: true,
    get: () => process.env.MODEL_VERIFY || DEFAULT_VERIFY
});
// 階段 3：沒設定就回 **null**（不是空字串），呼叫端寫成 `MODEL_VARIANT || MODEL_VERIFY` 退回
Object.defineProperty(module.exports, 'MODEL_VARIANT', {
    enumerable: true,
    get: () => (String(process.env.MODEL_VARIANT || '').trim() || null)
});

// ── 階段 5（docs/interfaces-stage5.md 第 5.2 條，擁有者：WS-E）──
// 三個新模型設定。與 MODEL_VARIANT 不同，第 5.2 條明訂「預設沿用」另一個模型，
// 所以退回直接寫在 getter 裡（呼叫端讀到的永遠是一個可用的模型字串，不會是 null）。
// 退回的目標也是 getter——MODEL_VERIFY 之後被改，MODEL_TUTOR 會跟著變。
/**
 * 讀環境變數；未設或全空白時回 fallback()（即時呼叫，不快照）。
 * @param {string} name
 * @param {() => string} fallback
 * @returns {string}
 */
function envOr(name, fallback) {
    return String(process.env[name] || '').trim() || fallback();
}
// AI 家教（POST /api/tutor）：解題與講解，要推理強 → 預設沿用 MODEL_VERIFY
Object.defineProperty(module.exports, 'MODEL_TUTOR', {
    enumerable: true,
    get: () => envOr('MODEL_TUTOR', () => module.exports.MODEL_VERIFY)
});
// 按住說話（POST /api/voice/transcribe）：音訊轉寫＋數學式，要便宜、快 → 預設沿用 MODEL_EXTRACT
Object.defineProperty(module.exports, 'MODEL_VOICE', {
    enumerable: true,
    get: () => envOr('MODEL_VOICE', () => module.exports.MODEL_EXTRACT)
});
// 知識點自動標註（WS-C 的 agents/tagKc.js 讀）：預設沿用 MODEL_EXTRACT
Object.defineProperty(module.exports, 'MODEL_KC_TAG', {
    enumerable: true,
    get: () => envOr('MODEL_KC_TAG', () => module.exports.MODEL_EXTRACT)
});

// ── 本機模式（docs/local-mode.md 第 2 條，擁有者：L1）──
// 把 PaddleOCR 的文字整理成拆題 JSON 的模型（L2 的 agents/extract.js 本機路徑讀）：未設時＝MODEL_VERIFY
Object.defineProperty(module.exports, 'MODEL_OCR_STRUCTURE', {
    enumerable: true,
    get: () => envOr('MODEL_OCR_STRUCTURE', () => module.exports.MODEL_VERIFY)
});
// embedding 模型：未設時是本機預設。services/llm 與 services/embedService 都讀這裡（單一真相）。
// 值原樣回傳（不補前綴）：questions.embedding_model 存的就是這個字串，換值＝全部重算（embedService 的 model_changed）。
Object.defineProperty(module.exports, 'EMBED_MODEL', {
    enumerable: true,
    get: () => envOr('EMBED_MODEL', () => DEFAULT_EMBED)
});
