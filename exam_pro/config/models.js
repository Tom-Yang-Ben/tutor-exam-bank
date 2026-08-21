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

const VENDORS = ['gemini', 'anthropic', 'openai'];

const DEFAULT_EXTRACT = 'gemini:gemini-3.5-flash';   // 裁決 S0-5
const DEFAULT_VERIFY = 'gemini:gemini-3.7-flash';   // 裁決 S0-5

/**
 * 解析 'vendor:model-id'；沒有冒號時 vendor 預設 'gemini'。
 * @param {string} spec
 * @returns {{vendor:string, id:string, spec:string}}
 * @throws  vendor 不在 ('gemini','anthropic','openai') 內、或 id 為空時丟錯
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

module.exports = { parseModel, warnIfSameModel, VENDORS };

// 兩個 getter：即時讀 process.env，語法上仍是 models.MODEL_EXTRACT 的屬性存取（第 5.4 條的匯出形狀）
Object.defineProperty(module.exports, 'MODEL_EXTRACT', {
    enumerable: true,
    get: () => process.env.MODEL_EXTRACT || DEFAULT_EXTRACT
});
Object.defineProperty(module.exports, 'MODEL_VERIFY', {
    enumerable: true,
    get: () => process.env.MODEL_VERIFY || DEFAULT_VERIFY
});
