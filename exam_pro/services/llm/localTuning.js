// ─────────────────────────────────────────────────────────────
// services/llm/localTuning.js — 本機模式（Ollama）的可選加速設定（docs/local-mode.md 第 10.12 條）
//
// 〔dec/local-thinking-speed〕三個設定，**預設全部不變**（不設＝與加這支檔案之前逐位元相同）：
//
//   OLLAMA_NO_THINK=lint,kc_tag          這些 agent 在本機模式不思考（Ollama 的 think:false）。
//                                        逗號分隔、不分大小寫；all 或 *＝每一個會思考的 agent。
//                                        寫基本名稱會連化學版一起：lint → lint、lint_chem；verify → verify、verify_chem。
//                                        只會「關掉」：agent 本來就不思考的（classify、variant…）寫了也沒有作用。
//   OLLAMA_MAX_OUTPUT_<AGENT>=3072       這個 agent 的輸出上限（Ollama 的 num_predict，含思考）只降不升：
//                                        取 min(agent 原本的 maxOutputTokens, 這個值)。<AGENT> 是 agent 名稱大寫，
//                                        例 OLLAMA_MAX_OUTPUT_VERIFY；寫基本名稱同樣連化學版一起（化學版可另寫 _CHEM 覆蓋）。
//   OLLAMA_NUM_CTX_<AGENT>=16384         這個 agent 的 num_ctx；沒寫就照 OLLAMA_NUM_CTX（預設 16384）。
//                                        用途：全域降到 8192、只讓讀得多的 agent（extract_vision、extract_ocr）保留 16384。
//                                        ⚠ 同一個模型換 num_ctx，Ollama 會重新載入模型（幾十秒）：同一個模型的 agent 盡量用同一個值。
//
// 只在 vendor 是 ollama、LLM_MODE 是 live／record 時由 services/llm/index.js 套用；Gemini 路徑與 replay 一個字都不讀。
// cassette 的鍵（agent／modelId／模板雜湊／schemaHash／cacheKeyParts，services/llm/cassette.js）**不含**
// thinkingBudget、maxOutputTokens、num_ctx，所以開關這些設定不會讓既有 cassette 失效（test/unit/localTuning.test.js 證明）。
// 錄製時有套用，services/llm/index.js 就在 cassette 的 request.ollamaOverrides 記下實際送出的值（沒套用時不寫這個欄位，
// 與之前逐位元相同）；npm run perf:local 據此把「不思考」的呼叫分開統計。
//
// 這支檔案只讀環境變數、不碰網路，全部是純函式（env 可注入）。
// ─────────────────────────────────────────────────────────────

/**
 * 程式裡會要求思考（thinkingBudget > 0）的 agent 與它們的兩個數字（npm run perf:local 與 npm run local:bench-text 用）。
 * 來源（test/unit/localTuning.test.js 逐一比對各模組匯出的常數，並掃描原始碼確認沒有漏列）：
 *   verify／verify_chem  agents/verify.js     THINKING_BUDGET 1024、MAX_OUTPUT_TOKENS 8192
 *   lint／lint_chem      agents/lint.js       THINKING_BUDGET 1024、MAX_OUTPUT_TOKENS 8192（只有第三層 LLM 重寫會呼叫）
 *   kc_tag               agents/tagKc.js      THINKING_BUDGET 512、MAX_OUTPUT_TOKENS 4096（FEATURE_KC_TAGGING、kc:backfill）
 *   tutor                services/tutorService.js  THINKING_BUDGET 2048、MAX_OUTPUT_TOKENS 8192（AI 家教，老師當場等）
 *   voice                services/voiceService.js  THINKING_BUDGET 1024、MAX_OUTPUT_TOKENS 4096（本機模式不提供語音）
 * Ollama 沒有「思考預算」：thinkingBudget > 0 只代表 think:true（services/llm/ollama.js），思考長度只受 num_predict 限制。
 */
const THINKING_AGENTS = Object.freeze({
    verify: Object.freeze({ thinkingBudget: 1024, maxOutputTokens: 8192 }),
    verify_chem: Object.freeze({ thinkingBudget: 1024, maxOutputTokens: 8192 }),
    lint: Object.freeze({ thinkingBudget: 1024, maxOutputTokens: 8192 }),
    lint_chem: Object.freeze({ thinkingBudget: 1024, maxOutputTokens: 8192 }),
    kc_tag: Object.freeze({ thinkingBudget: 512, maxOutputTokens: 4096 }),
    tutor: Object.freeze({ thinkingBudget: 2048, maxOutputTokens: 8192 }),
    voice: Object.freeze({ thinkingBudget: 1024, maxOutputTokens: 4096 })
});

/** OLLAMA_NO_THINK 裡代表「全部」的寫法 */
const ALL_WORDS = Object.freeze(['all', '*']);

/** 化學版 agent 的後綴（agents/*.js 的 AGENT_CHEM 慣例：<基本名稱>_chem） */
const CHEM_SUFFIX = '_chem';

/**
 * agent 名稱 → 環境變數的後綴：大寫，英數以外換成底線。'kc_tag' → 'KC_TAG'、'extract_ocr_chem' → 'EXTRACT_OCR_CHEM'。
 * @param {string} agent
 * @returns {string}
 */
function agentEnvSuffix(agent) {
    return String(agent ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * 化學版的基本名稱：'lint_chem' → 'lint'；其他原樣。
 * @param {string} agent
 * @returns {string}
 */
function baseAgent(agent) {
    const a = String(agent ?? '').trim().toLowerCase();
    return a.endsWith(CHEM_SUFFIX) && a.length > CHEM_SUFFIX.length ? a.slice(0, -CHEM_SUFFIX.length) : a;
}

/**
 * OLLAMA_NO_THINK 的值 → { all, names }。分隔字元：半形／全形逗號、頓號、空白。
 * @param {string|undefined} raw
 * @returns {{all:boolean, names:Set<string>}}
 */
function parseAgentList(raw) {
    const names = new Set(String(raw ?? '').split(/[,，、\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
    const all = ALL_WORDS.some(w => names.has(w));
    for (const w of ALL_WORDS) names.delete(w);
    return { all, names };
}

/**
 * 這個 agent 在不在 OLLAMA_NO_THINK 裡（寫基本名稱會連化學版一起）。
 * @param {string|undefined} agent
 * @param {object} [env]
 * @returns {boolean}
 */
function noThinkFor(agent, env = process.env) {
    const { all, names } = parseAgentList(env.OLLAMA_NO_THINK);
    if (all) return true;
    const a = String(agent ?? '').trim().toLowerCase();
    if (!a) return false;
    return names.has(a) || names.has(baseAgent(a));
}

function positiveIntOrNull(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 每個 agent 各自的整數設定：先找 <PREFIX><AGENT>（例 OLLAMA_NUM_CTX_EXTRACT_OCR_CHEM），
 * 沒有再找基本名稱（OLLAMA_NUM_CTX_EXTRACT_OCR）。不是正整數＝沒寫。
 * @param {string} prefix  例 'OLLAMA_NUM_CTX_'
 * @param {string|undefined} agent
 * @param {object} [env]
 * @returns {{value:number, name:string}|null}
 */
function perAgentInt(prefix, agent, env = process.env) {
    const a = String(agent ?? '').trim();
    if (!a) return null;
    const names = [...new Set([`${prefix}${agentEnvSuffix(a)}`, `${prefix}${agentEnvSuffix(baseAgent(a))}`])];
    for (const name of names) {
        const v = positiveIntOrNull(env[name]);
        if (v !== null) return { value: v, name };
    }
    return null;
}

/**
 * 一次 Ollama 呼叫要套用哪些本機調整。純函式。
 * @param {{agent?:string, thinkingBudget?:number, maxOutputTokens?:number}} opts  services/llm 收到的呼叫參數
 * @param {object} [env]
 * @returns {{thinkingBudget:number|undefined, maxOutputTokens:number|undefined, numCtx:number|undefined,
 *            applied:{think?:false, numPredict?:number, numCtx?:number}}}
 *          applied 是「和 agent 原本要的不一樣」的部分；空物件＝這次什麼都沒改（services/llm 就原封不動地轉交）。
 */
function resolveOllamaOverrides({ agent, thinkingBudget, maxOutputTokens } = {}, env = process.env) {
    const applied = {};
    let budget = thinkingBudget;
    let maxOut = maxOutputTokens;
    let numCtx;

    if (Number(thinkingBudget) > 0 && noThinkFor(agent, env)) {
        budget = 0;
        applied.think = false;
    }
    const cap = perAgentInt('OLLAMA_MAX_OUTPUT_', agent, env);
    if (cap) {
        const current = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : null;
        if (current === null || cap.value < current) {
            maxOut = cap.value;
            applied.numPredict = cap.value;
        }
    }
    const ctx = perAgentInt('OLLAMA_NUM_CTX_', agent, env);
    if (ctx) {
        numCtx = ctx.value;
        applied.numCtx = ctx.value;
    }
    return { thinkingBudget: budget, maxOutputTokens: maxOut, numCtx, applied };
}

/**
 * 目前環境裡有寫的本機調整（給文件、量測工具與啟動訊息看；不含沒寫的）。純函式。
 * @param {object} [env]
 * @returns {{noThink:{all:boolean, names:string[]}, maxOutput:Record<string,number>, numCtx:Record<string,number>}}
 */
function describeOverrides(env = process.env) {
    const { all, names } = parseAgentList(env.OLLAMA_NO_THINK);
    const pick = (prefix) => {
        const out = {};
        for (const [k, v] of Object.entries(env)) {
            if (!k.startsWith(prefix) || k.length === prefix.length) continue;
            const n = positiveIntOrNull(v);
            if (n !== null) out[k] = n;
        }
        return out;
    };
    return { noThink: { all, names: [...names].sort() }, maxOutput: pick('OLLAMA_MAX_OUTPUT_'), numCtx: pick('OLLAMA_NUM_CTX_') };
}

/** 本分支新增、會進 eval 重錄子行程的環境變數名稱（eval/lib/suiteProcess.js 錄製時放行、回放時擋掉） */
const OVERRIDE_ENV_PATTERN = /^OLLAMA_(NO_THINK|MAX_OUTPUT_[A-Z0-9_]+|NUM_CTX_[A-Z0-9_]+)$/;

module.exports = {
    resolveOllamaOverrides, noThinkFor, perAgentInt, parseAgentList, agentEnvSuffix, baseAgent, describeOverrides,
    THINKING_AGENTS, OVERRIDE_ENV_PATTERN, ALL_WORDS
};
