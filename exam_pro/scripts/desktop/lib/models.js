// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/models.js — 「這份 .env 需不需要 Ollama、要哪幾個模型、OCR 在不在」（桌面啟動器第 6 步）
//
// 規則照伺服器實際的讀法（不另訂一套）：
//   - 模型的預設與退回鏈：config/models.js 的 getter（MODEL_EXTRACT／VERIFY／TEXT／KC_TAG／OCR_STRUCTURE／EMBED_MODEL）、
//     workers/jobRunner.js（MODEL_VARIANT 沒設＝MODEL_VERIFY）、services/nlqService.js（MODEL_NLQ 預設 ollama:qwen3:8b）、
//     services/assistantService.js（MODEL_ASSISTANT 沒設＝MODEL_TEXT）、MODEL_TUTOR（沒設＝MODEL_VERIFY）。
//     config/models.js 的 getter 直接讀 process.env，啟動器不能把 .env 灌進自己的 process.env（後端要拿到與 npm start
//     一模一樣的環境），所以這裡對「一個 env 物件」重算同一條鏈；test/unit/desktopLauncherModels.test.js 拿各種 env
//     逐一和 config/models.js 的 getter 比對，兩邊一改不一致就紅。
//   - OLLAMA_HOST：services/llm/ollama.js 的 resolveHost（同一支）。
//   - OCR：services/ocr 的 resolveOcrConfig（同一支）；拆題模型是 ollama 且 OCR_ENGINE=paddle 時才需要。
//   - LOCAL_EXTRACT_MODE：config/localExtractMode.js（同一支）；ocr 模式不呼叫看圖模型，所以不要求下載它。
// 純函式（exists 由呼叫端注入）。
// ─────────────────────────────────────────────────────────────
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const models = require(path.join(APP_DIR, 'config', 'models'));

/** services/nlqService.js 的 DEFAULT_MODEL_NLQ（該檔沒有匯出；單元測試掃原始碼比對） */
const DEFAULT_MODEL_NLQ = 'ollama:qwen3:8b';

const trim = v => String(v == null ? '' : v).trim();

/**
 * 供應商（只切第一個冒號；沒有冒號＝gemini），與 config/models.js 的 parseModel 同一條規則，但不丟錯。
 * @param {string} spec
 * @returns {string|null}
 */
function vendorOf(spec) {
    const raw = trim(spec);
    if (!raw) return null;
    const i = raw.indexOf(':');
    return i === -1 ? 'gemini' : raw.slice(0, i).trim().toLowerCase();
}

/** 'ollama:qwen3:8b' → 'qwen3:8b' */
function modelIdOf(spec) {
    const raw = trim(spec);
    const i = raw.indexOf(':');
    return i === -1 ? raw : raw.slice(i + 1).trim();
}

/**
 * 這份 env 實際生效的各角色模型。純函式。
 * @param {Record<string,string|undefined>} env
 */
function effectiveModelSpecs(env) {
    const e = env || {};
    // config/models.js：MODEL_EXTRACT／MODEL_VERIFY 用 ||（沒 trim），其餘用 envOr（trim）
    const extract = e.MODEL_EXTRACT || models.DEFAULT_EXTRACT;
    const verify = e.MODEL_VERIFY || models.DEFAULT_VERIFY;
    const text = trim(e.MODEL_TEXT) || (vendorOf(extract) === 'ollama' ? verify : extract);
    return {
        MODEL_EXTRACT: extract,
        MODEL_VERIFY: verify,
        MODEL_TEXT: text,
        MODEL_KC_TAG: trim(e.MODEL_KC_TAG) || text,
        MODEL_OCR_STRUCTURE: trim(e.MODEL_OCR_STRUCTURE) || verify,
        EMBED_MODEL: trim(e.EMBED_MODEL) || models.DEFAULT_EMBED,
        MODEL_VARIANT: trim(e.MODEL_VARIANT) || verify,
        MODEL_NLQ: e.MODEL_NLQ || DEFAULT_MODEL_NLQ,
        MODEL_ASSISTANT: trim(e.MODEL_ASSISTANT) || text,
        MODEL_TUTOR: trim(e.MODEL_TUTOR) || verify
    };
}

const isTrue = v => /^(1|true|yes|on)$/i.test(trim(v));

/**
 * 需不需要 Ollama、要哪幾個模型、OCR 的 Python 在不在。純函式。
 * @param {Record<string,string|undefined>} env  .env 加上系統環境（系統環境優先，與 dotenv 相同）
 * @param {{exists:(p:string)=>boolean, platform?:string}} deps
 * @returns {{needed:boolean, models:string[], host:string, local:boolean, error?:string, ocrNeeded:boolean, ocrFound:boolean|null, ocrPython:string}}
 */
function ollamaNeed(env, { exists, platform = process.platform }) {
    const specs = effectiveModelSpecs(env);
    const errors = [];
    for (const [k, v] of Object.entries(specs)) {
        try { models.parseModel(v); } catch (err) { errors.push(`${k}：${err.message}`); }
    }
    const extractLocal = vendorOf(specs.MODEL_EXTRACT) === 'ollama';
    const mode = require(path.join(APP_DIR, 'config', 'localExtractMode')).resolveLocalExtractMode(env || {});

    // 真的會用到的角色（下載清單只列這些，免得 ocr 模式也要求下載看圖模型）
    const roles = ['MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG', 'MODEL_OCR_STRUCTURE', 'EMBED_MODEL', 'MODEL_VARIANT', 'MODEL_NLQ'];
    if (!(extractLocal && mode === 'ocr')) roles.push('MODEL_EXTRACT');
    if (isTrue(env && env.FEATURE_ASSISTANT)) roles.push('MODEL_ASSISTANT');
    if (isTrue(env && env.FEATURE_TUTOR)) roles.push('MODEL_TUTOR');

    const ids = [];
    for (const r of roles) {
        if (vendorOf(specs[r]) !== 'ollama') continue;
        const id = modelIdOf(specs[r]);
        if (id && !ids.includes(id)) ids.push(id);
    }
    // 會用到的角色裡有任何一個是 ollama: 才需要（Gemini 模式照 .env.example 改了五行時＝不需要）
    const needed = ids.length > 0;

    let host = 'http://127.0.0.1:11434';
    let local = true;
    try {
        const h = require(path.join(APP_DIR, 'services', 'llm', 'ollama')).resolveHost(env || {});
        host = h.url;
        local = h.local;
    } catch (err) {
        if (needed) errors.push(err.message);
    }

    const ocr = require(path.join(APP_DIR, 'services', 'ocr')).resolveOcrConfig(env || {}, platform);
    const ocrNeeded = extractLocal && ocr.engine === 'paddle';
    const p = platform === 'win32' ? path.win32 : path;
    // 只寫指令名（python）的交給作業系統找，這裡判斷不了 → null（不警告）
    const ocrFound = !ocrNeeded ? null : (p.isAbsolute(ocr.python) ? Boolean(exists(ocr.python)) : null);

    return {
        needed,
        models: ids,
        host,
        local,
        ...(errors.length ? { error: errors.join('；') } : {}),
        ocrNeeded,
        ocrFound,
        ocrPython: ocr.python
    };
}

/**
 * 已安裝的模型名單裡有沒有這個 ID（沒寫 tag＝:latest；不分大小寫）。與 eval/lib/localMode.js 的 hasModel 同一條規則。
 * @param {string[]} installed
 * @param {string} id
 */
function hasModel(installed, id) {
    const want = String(id).toLowerCase();
    const names = (installed || []).map(n => String(n).toLowerCase());
    return names.includes(want) || (!want.includes(':') && names.includes(`${want}:latest`));
}

/**
 * GET /api/tags 的回應 → 缺哪些模型。
 * @param {any} body
 * @param {string[]} wanted
 */
function missingModels(body, wanted) {
    const installed = (Array.isArray(body && body.models) ? body.models : []).map(m => m && (m.name || m.model)).filter(Boolean);
    return (wanted || []).filter(id => !hasModel(installed, id));
}

module.exports = { effectiveModelSpecs, ollamaNeed, hasModel, missingModels, vendorOf, modelIdOf, DEFAULT_MODEL_NLQ };
