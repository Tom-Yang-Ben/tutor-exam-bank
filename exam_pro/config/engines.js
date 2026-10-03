// config/engines.js — 拆題與助教「本機／Gemini」二選一（〔dec/r13-engine-choice〕docs/local-mode.md 10.26）
//
// Owner 2026-10-01：「AI 分析考卷可以選純本機的辨識或透過 Gemini 的 API；助教也一樣，可以本機分析思考給答案，也可以透過 Gemini 回答。」
//
// 這支只回答兩個問題，不連 DB、不呼叫模型：
//   1. 某個功能「照 .env」時是哪一種引擎（defaultEngine：看那個功能的 .env 模型的供應商）；
//   2. 指定另一種引擎時，各節點要用哪一支模型（modelsForEngine）。
//
// 規則（逐條對應 10.26 第 2 節）：
//   - engine 沒給、或等於 .env 的預設 → 呼叫端照舊用 .env（config/models.js 的 getter），送出的模型、cassette 的鍵逐字不變。
//     這一支只在「指定的引擎與 .env 不同」時才被用到。
//   - 指定 gemini：拆題＝GEMINI_MODEL_EXTRACT（沒寫就用 .env 的 MODEL_EXTRACT——如果它本來就是 gemini:——再沒有就是
//     config/models.js 的 GEMINI_DEFAULTS.MODEL_EXTRACT）；驗算＝GEMINI_MODEL_VERIFY（同上的退回順序，最後是 GEMINI_DEFAULTS.MODEL_VERIFY）。
//     其他節點（分類、公式重寫、知識點標註、出變式、家教、助教、查題）先看各自的 MODEL_* 是不是 gemini:，是就照它；
//     不是就照 Gemini 模式原本的退回規則（文字工作＝拆題模型、出變式與家教＝驗算模型）。
//   - 指定 local：同一套規則換成 LOCAL_MODEL_EXTRACT／LOCAL_MODEL_VERIFY 與 ollama:，最後退回 config/models.js 的
//     DEFAULT_EXTRACT／DEFAULT_VERIFY；文字工作＝驗算模型（LM-15：16 GB 的電腦不在兩個 8B 模型之間換載）。
//   - 向量（EMBED_MODEL）一律不跟著換：同一個向量空間，否則去重與相似度全部失準。這裡沒有 embed 的鍵。
//   - Gemini 要有 GEMINI_API_KEY 才算可用（engineAvailability；只回「有沒有設」，不回金鑰本身）。
//
// 純設定：只 require config/models.js 與 config/localExtractMode.js（兩支都是純設定）。

const ENGINES = Object.freeze(['local', 'gemini']);
const VENDOR_OF_ENGINE = Object.freeze({ local: 'ollama', gemini: 'gemini' });
/** 給人看的名稱（API 與畫面共用） */
const ENGINE_LABEL = Object.freeze({ local: '本機', gemini: 'Gemini' });
/** 沒有金鑰時的說明（前端停用選項時顯示、API 回 400 時也用這一句開頭） */
const NO_GEMINI_KEY = '尚未設定 Gemini 金鑰（.env 的 GEMINI_API_KEY），不能選 Gemini';

/** 四個「指定引擎」用的新設定（只在指定的引擎與 .env 不同時才讀） */
const ENGINE_ENV = Object.freeze({
    gemini: { extract: 'GEMINI_MODEL_EXTRACT', verify: 'GEMINI_MODEL_VERIFY' },
    local: { extract: 'LOCAL_MODEL_EXTRACT', verify: 'LOCAL_MODEL_VERIFY' }
});

/** 哪些功能可以選引擎；值＝「照 .env 時」那個功能用哪個 MODEL_*（決定預設引擎） */
const PURPOSES = Object.freeze(['extract', 'tutor', 'assistant']);

function models() { return require('./models'); }

/**
 * 'vendor:id' → 'local'｜'gemini'｜null（其他供應商或解析不了）。
 * @param {string} spec
 * @returns {'local'|'gemini'|null}
 */
function engineOfSpec(spec) {
    let vendor;
    try { vendor = models().parseModel(spec).vendor; } catch (_) { return null; }
    if (vendor === 'ollama') return 'local';
    if (vendor === 'gemini') return 'gemini';
    return null;
}

/**
 * 解析請求帶來的 engine。沒帶（undefined／null／空字串）＝照 .env（engine:null）。
 * @param {unknown} raw
 * @returns {{engine:'local'|'gemini'|null}|{error:string}}
 */
function parseEngine(raw) {
    if (raw === undefined || raw === null) return { engine: null };
    const s = String(raw).trim().toLowerCase();
    if (!s) return { engine: null };
    if (ENGINES.includes(s)) return { engine: s };
    return { error: `engine 只能是 ${ENGINES.join(' 或 ')}（不帶＝照 .env 的設定）。` };
}

/** 環境變數裡的模型字串（空白＝沒寫） */
function envSpec(env, name) {
    return String((env && env[name]) || '').trim();
}

/** 環境變數有寫、而且供應商是 vendor 才回它；否則 null */
function sameVendor(env, name, vendor) {
    const v = envSpec(env, name);
    if (!v) return null;
    try { return models().parseModel(v).vendor === vendor ? v : null; } catch (_) { return null; }
}

/**
 * 「照 .env」時三個功能各用哪一支模型（與各服務實際讀的相同）。
 *   extract：MODEL_EXTRACT；tutor：MODEL_TUTOR（沒寫＝MODEL_VERIFY）；assistant：MODEL_ASSISTANT（沒寫＝MODEL_TEXT）。
 * env 就是 process.env 時直接讀 config/models.js 的 getter（與服務本身同一個來源）；
 * 測試傳別的 env 時照 getter 的同一套退回規則算。
 * @param {object} [env]
 * @returns {{extract:string, tutor:string, assistant:string}}
 */
function envModels(env = process.env) {
    const m = models();
    if (env === process.env) {
        return {
            extract: m.MODEL_EXTRACT,
            tutor: m.MODEL_TUTOR,
            // 與 services/assistantService.js 的 runAssistant 同一行規則
            assistant: envSpec(env, 'MODEL_ASSISTANT') || m.MODEL_TEXT || m.MODEL_EXTRACT
        };
    }
    const extract = envSpec(env, 'MODEL_EXTRACT') || m.DEFAULT_EXTRACT;
    const verify = envSpec(env, 'MODEL_VERIFY') || m.DEFAULT_VERIFY;
    const text = envSpec(env, 'MODEL_TEXT') || (engineOfSpec(extract) === 'local' ? verify : extract);
    return { extract, tutor: envSpec(env, 'MODEL_TUTOR') || verify, assistant: envSpec(env, 'MODEL_ASSISTANT') || text };
}

/**
 * 「照 .env」時這個功能是哪一種引擎（看那個功能實際用的模型的供應商）。
 * @param {'extract'|'tutor'|'assistant'} purpose
 * @param {object} [env]
 * @returns {'local'|'gemini'|null}
 */
function defaultEngine(purpose = 'extract', env = process.env) {
    const spec = envModels(env)[purpose === 'tutor' || purpose === 'assistant' ? purpose : 'extract'];
    return engineOfSpec(spec);
}

/**
 * 這個請求要不要「換引擎」：engine 沒給、或等於這個功能照 .env 的引擎 → null（呼叫端照舊用 .env，逐字不變）；
 * 不同 → 回那個引擎（呼叫端改用 modelsForEngine）。
 * @param {'local'|'gemini'|null|undefined} engine
 * @param {'extract'|'tutor'|'assistant'} purpose
 * @param {object} [env]
 * @returns {'local'|'gemini'|null}
 */
function overrideEngine(engine, purpose = 'extract', env = process.env) {
    if (!engine || !ENGINES.includes(engine)) return null;
    return engine === defaultEngine(purpose, env) ? null : engine;
}

/**
 * 指定引擎時各節點的模型（只在 overrideEngine 回非 null 時用）。鍵與 workers/jobRunner.js 的 loadModels 相同，另加三個非管線的鍵。
 * @param {'local'|'gemini'} engine
 * @param {object} [env]
 * @returns {{engine:string, extract:string, verify:string, variant:string, ocrStructure:string, text:string,
 *            kcTag:string, tutor:string, assistant:string, nlq:string}}
 */
function modelsForEngine(engine, env = process.env) {
    if (!ENGINES.includes(engine)) throw new Error(`modelsForEngine：engine 只能是 ${ENGINES.join('／')}，收到「${engine}」`);
    const m = models();
    const vendor = VENDOR_OF_ENGINE[engine];
    const own = ENGINE_ENV[engine];
    const pick = (name, fallback) => sameVendor(env, name, vendor) || fallback;
    const extract = sameVendor(env, own.extract, vendor) || sameVendor(env, 'MODEL_EXTRACT', vendor)
        || (engine === 'gemini' ? m.GEMINI_DEFAULTS.MODEL_EXTRACT : m.DEFAULT_EXTRACT);
    const verify = sameVendor(env, own.verify, vendor) || sameVendor(env, 'MODEL_VERIFY', vendor)
        || (engine === 'gemini' ? m.GEMINI_DEFAULTS.MODEL_VERIFY : m.DEFAULT_VERIFY);
    // 文字工作的退回規則與 config/models.js 的 MODEL_TEXT getter 相同：本機＝驗算模型（LM-15）、Gemini＝拆題模型
    const text = pick('MODEL_TEXT', engine === 'local' ? verify : extract);
    return {
        engine,
        extract,
        verify,
        variant: pick('MODEL_VARIANT', verify),
        ocrStructure: pick('MODEL_OCR_STRUCTURE', verify),
        text,
        kcTag: pick('MODEL_KC_TAG', text),
        tutor: pick('MODEL_TUTOR', verify),
        assistant: pick('MODEL_ASSISTANT', text),
        nlq: pick('MODEL_NLQ', text)
    };
}

/**
 * 兩種引擎現在能不能用（GET /api/engines 與 API 的 400 檢查共用）。不回金鑰本身，只回「有沒有設」。
 *   gemini：要有 GEMINI_API_KEY。
 *   local（拆題）：.env 的 LOCAL_EXTRACT_MODE 與 OCR_ENGINE 互相矛盾時不能用（config/localExtractMode.js 的同一句說明）。
 *   local（家教、助教）：一律可用（Ollama 有沒有開，送出才知道；送出失敗會照舊回 502）。
 * @param {'extract'|'tutor'|'assistant'} [purpose]
 * @param {object} [env]
 * @returns {{local:{available:boolean, reason:string|null}, gemini:{available:boolean, reason:string|null}}}
 */
function engineAvailability(purpose = 'extract', env = process.env) {
    const hasKey = envSpec(env, 'GEMINI_API_KEY') !== '';
    let localReason = null;
    if (purpose === 'extract') {
        const lem = require('./localExtractMode');
        const raw = String((env && env.OCR_ENGINE) ?? '').trim().toLowerCase();
        const ocrEngine = raw === 'none' ? 'none' : 'paddle';
        localReason = lem.localExtractConflict({
            localExtract: true, mode: lem.resolveLocalExtractMode(env), ocrEngine,
            explicit: lem.isLocalExtractModeExplicit(env)
        });
    }
    return {
        local: { available: localReason === null, reason: localReason },
        gemini: { available: hasKey, reason: hasKey ? null : NO_GEMINI_KEY }
    };
}

/**
 * 這個請求的 engine 能不能用；不能用時回 400 要給的訊息（null＝可以）。
 * 沒指定（照 .env）一律可以——.env 本身的問題由原本的路徑回報，不在這裡多擋。
 * @param {'local'|'gemini'|null} engine
 * @param {'extract'|'tutor'|'assistant'} purpose
 * @param {object} [env]
 * @returns {string|null}
 */
function engineProblem(engine, purpose = 'extract', env = process.env) {
    if (!engine) return null;
    const a = engineAvailability(purpose, env)[engine];
    return a.available ? null : a.reason;
}

/**
 * GET /api/engines 的回應：每個功能的預設引擎、兩種引擎能不能用、各用哪一支模型（給畫面顯示，不含金鑰）。
 * @param {object} [env]
 */
function describeEngines(env = process.env) {
    const out = { engines: ENGINES.map(e => ({ id: e, label: ENGINE_LABEL[e] })), purposes: {} };
    const current = envModels(env);
    for (const purpose of PURPOSES) {
        const def = defaultEngine(purpose, env);
        const avail = engineAvailability(purpose, env);
        const options = {};
        for (const e of ENGINES) {
            // 等於預設＝照 .env：顯示 .env 實際的模型；不等於＝指定引擎時會用的模型
            let model;
            if (e === def) {
                model = current[purpose];
            } else {
                const set = modelsForEngine(e, env);
                model = purpose === 'tutor' ? set.tutor : purpose === 'assistant' ? set.assistant : set.extract;
            }
            options[e] = { ...avail[e], model };
        }
        out.purposes[purpose] = { default: def, options };
    }
    return out;
}

module.exports = {
    ENGINES, VENDOR_OF_ENGINE, ENGINE_LABEL, ENGINE_ENV, PURPOSES, NO_GEMINI_KEY,
    engineOfSpec, parseEngine, envModels, defaultEngine, overrideEngine, modelsForEngine,
    engineAvailability, engineProblem, describeEngines
};
