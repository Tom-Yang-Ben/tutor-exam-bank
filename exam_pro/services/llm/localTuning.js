// ─────────────────────────────────────────────────────────────
// services/llm/localTuning.js — 本機模式（Ollama）的可選加速設定（docs/local-mode.md 第 10.14 條）
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
// 〔審查修正〕啟動時（services/llm/index.js 載入、LLM_MODE 是 live／record）由 announceOverrides 印一行生效的本機調整；
// 名稱寫錯（例 OLLAMA_NO_THINK=verfy、OLLAMA_NUM_CTX_EXTRCT_OCR）、值不是正整數、寫了沒有作用的，各印一行警告（checkOverrides）。
// 本來寫錯只會被靜默忽略。
//
// 〔Owner 第五輪 C-b、C-c 核准，dec/r6-local-tuning〕本機模式的**程式預設**（LOCAL_DEFAULTS；只在 vendor 是 ollama 時套用）：
//   C-b＝2：知識點標註（kc_tag）不思考——OLLAMA_NO_THINK **沒寫或空字串**時等同 OLLAMA_NO_THINK=kc_tag。
//           OLLAMA_NO_THINK 有寫就整個取代預設：要 kc_tag 照舊思考寫 OLLAMA_NO_THINK=none；
//           要再多關 lint 寫 OLLAMA_NO_THINK=lint,kc_tag（只寫 lint 的話 kc_tag 會恢復思考）。
//   C-c＝2：驗算（verify、verify_chem）輸出上限 3072——OLLAMA_MAX_OUTPUT_VERIFY（或 _VERIFY_CHEM）沒寫時等同寫了 3072；
//           寫了就用寫的值（只降不升照舊）：寫 8192（原本的上限）＝取消這個預設。思考照舊（不在 NO_THINK 預設裡）。
//   Gemini 路徑與 replay 仍然一個字都不讀；這兩個數字不在 cassette 的鍵裡，改了不必重錄。
//
// 〔Owner 第七輪 R7-1＝4 核准，dec/r10-variant-cap〕變式生成（variant、variant_chem）也有本機預設輸出上限 1024
// （docs/local-mode.md 10.24）：OLLAMA_MAX_OUTPUT_VARIANT（或 _VARIANT_CHEM）沒寫時等同寫了 1024；寫了就用寫的值。
// 變式原本不帶 maxOutputTokens（agents/generateVariant.js；Ollama 不限長度），沒有「原本的上限」可比，
// 所以「寫原本的值＝取消預設」的規則照 C-c 的數字寫：寫 ≥ 8192（UNCAPPED_CEILING，驗算原本的上限）＝取消預設、
// 不送 num_predict（與 R7-1 之前逐位元相同）；寫 1025～8191＝照寫的值送 num_predict。
// 沒有本機預設的 agent（classify、nlq…）不受 UNCAPPED_CEILING 影響：照舊寫多少送多少。
// 被截斷時的處理（C-f 納入變式：不重試、放棄那一題並記事件）在 workers/jobRunner.js 的 runGenerateOne。
//
// 這支檔案只讀環境變數、不碰網路；除了 announceOverrides 會印字，全部是純函式（env 可注入）。
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
/** 〔Owner 第五輪 C-b〕OLLAMA_NO_THINK 裡代表「一個都不關」的寫法（用來取消本機預設） */
const NONE_WORDS = Object.freeze(['none']);

/**
 * 〔Owner 第五輪 C-b＝2、C-c＝2 核准〕本機模式（vendor 是 ollama）的程式預設。環境變數沒寫（或空字串）時才用它：
 *   noThink：OLLAMA_NO_THINK 沒寫時不思考的 agent（寫基本名稱，連化學版一起）；
 *   maxOutput：OLLAMA_MAX_OUTPUT_<AGENT> 沒寫時的輸出上限（基本名稱；化學版一起，化學版另寫 _CHEM 可單獨覆寫）。
 */
const LOCAL_DEFAULTS = Object.freeze({
    noThink: Object.freeze(['kc_tag']),
    // 〔Owner 第七輪 R7-1＝4〕variant 1024：實錄 59 支變式生成的輸出中位 175、最多 358 token（docs/local-mode.md 10.24）
    maxOutput: Object.freeze({ verify: 3072, variant: 1024 })
});

/** 本機預設輸出上限各自是哪一輪哪一題核准的（啟動訊息與 checkOverrides 的 defaults 用） */
const LOCAL_DEFAULT_SOURCES = Object.freeze({ verify: 'Owner 第五輪 C-c', variant: 'Owner 第七輪 R7-1' });

/**
 * 〔Owner 第七輪 R7-1＝4〕有本機預設、但 agent 自己不帶 maxOutputTokens（Ollama 不限長度）的 agent（variant）：
 * 環境變數寫 ≥ 這個值＝取消本機預設、不送 num_predict（與 C-c 寫 8192 取消 verify 預設同一個數字）。
 */
const UNCAPPED_CEILING = 8192;

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
    for (const w of NONE_WORDS) names.delete(w);   // 〔C-b〕none＝一個都不關（只用來取消本機預設）
    return { all, names };
}

/**
 * 〔Owner 第五輪 C-b〕實際生效的「不思考」清單：OLLAMA_NO_THINK 沒寫（或空白）→ 本機預設（LOCAL_DEFAULTS.noThink）；
 * 有寫 → 整個照寫的（none＝一個都不關）。純函式。
 * @param {object} [env]
 * @returns {{all:boolean, names:Set<string>, source:'default'|'env'}}
 */
function noThinkSpec(env = process.env) {
    const raw = String(env.OLLAMA_NO_THINK ?? '').trim();
    if (!raw) return { all: false, names: new Set(LOCAL_DEFAULTS.noThink), source: 'default' };
    return { ...parseAgentList(raw), source: 'env' };
}

/**
 * 〔Owner 第五輪 C-c〕這個 agent 的本機預設輸出上限（LOCAL_DEFAULTS.maxOutput；化學版吃基本名稱）；沒有時 null。
 * @param {string|undefined} agent
 * @returns {number|null}
 */
function defaultMaxOutputFor(agent) {
    const a = String(agent ?? '').trim().toLowerCase();
    if (!a) return null;
    const own = Object.prototype.hasOwnProperty.call(LOCAL_DEFAULTS.maxOutput, a) ? LOCAL_DEFAULTS.maxOutput[a] : null;
    if (own) return own;
    const base = baseAgent(a);
    return Object.prototype.hasOwnProperty.call(LOCAL_DEFAULTS.maxOutput, base) ? LOCAL_DEFAULTS.maxOutput[base] : null;
}

/**
 * 這個 agent 在不在生效的不思考清單裡（寫基本名稱會連化學版一起）。
 * 〔Owner 第五輪 C-b〕OLLAMA_NO_THINK 沒寫時用本機預設（kc_tag）。
 * @param {string|undefined} agent
 * @param {object} [env]
 * @returns {boolean}
 */
function noThinkFor(agent, env = process.env) {
    const { all, names } = noThinkSpec(env);
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
 *            applied:{think?:false, numPredict?:number, numCtx?:number},
 *            sources:{think?:'default'|'env', numPredict?:'default'|'env', numCtx?:'env'}}}
 *          applied 是「和 agent 原本要的不一樣」的部分；空物件＝這次什麼都沒改（services/llm 就原封不動地轉交）。
 *          sources〔Owner 第五輪 C-b／C-c〕：applied 的每一項來自本機預設（default）還是環境變數（env）；給量測工具與報告標示來源，
 *          不寫進 cassette。
 */
function resolveOllamaOverrides({ agent, thinkingBudget, maxOutputTokens } = {}, env = process.env) {
    const applied = {};
    const sources = {};
    let budget = thinkingBudget;
    let maxOut = maxOutputTokens;
    let numCtx;

    if (Number(thinkingBudget) > 0 && noThinkFor(agent, env)) {
        budget = 0;
        applied.think = false;
        sources.think = noThinkSpec(env).source;
    }
    // 〔Owner 第五輪 C-c〕沒寫 OLLAMA_MAX_OUTPUT_<AGENT>（或亂填）時用本機預設（verify 3072、〔R7-1〕variant 1024）；寫了就照寫的
    let cap = perAgentInt('OLLAMA_MAX_OUTPUT_', agent, env);
    let capSource = 'env';
    const d = defaultMaxOutputFor(agent);
    if (!cap && d) { cap = { value: d, name: null }; capSource = 'default'; }
    if (cap) {
        // 〔R7-1〕有本機預設、自己不帶上限的（variant）：以 UNCAPPED_CEILING 當「原本的上限」，寫 ≥ 8192＝取消預設（不送 num_predict）
        const current = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : (d ? UNCAPPED_CEILING : null);
        if (current === null || cap.value < current) {
            maxOut = cap.value;
            applied.numPredict = cap.value;
            sources.numPredict = capSource;
        }
    }
    const ctx = perAgentInt('OLLAMA_NUM_CTX_', agent, env);
    if (ctx) {
        numCtx = ctx.value;
        applied.numCtx = ctx.value;
        sources.numCtx = 'env';
    }
    return { thinkingBudget: budget, maxOutputTokens: maxOut, numCtx, applied, sources };
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

// ───────────────────────── 〔審查修正〕啟動時印出生效的本機調整、名稱寫錯時警告 ─────────────────────────

/**
 * 會經 services/llm 呼叫模型的 agent 名稱（cassette 的子目錄名；test/unit/localTuning.test.js 掃原始碼確認沒有漏列）。
 * OLLAMA_NO_THINK 的名稱與 OLLAMA_MAX_OUTPUT_／OLLAMA_NUM_CTX_ 的後綴拿它對照：不在這裡的＝寫錯了，會被靜默忽略，啟動時警告。
 */
const KNOWN_AGENTS = Object.freeze([
    'extract', 'extract_chem', 'extract_vision', 'extract_vision_chem', 'extract_ocr', 'extract_ocr_chem',
    'classify', 'classify_chem', 'lint', 'lint_chem', 'verify', 'verify_chem', 'variant', 'variant_chem',
    'nlq', 'assistant', 'kc_tag', 'tutor', 'voice'
]);

/** 會思考的基本名稱（OLLAMA_NO_THINK 只對它們有作用；化學版寫基本名稱即可） */
function thinkingBaseNames() {
    return [...new Set(Object.keys(THINKING_AGENTS).map(baseAgent))];
}

/**
 * 目前環境裡的本機調整：生效的（給人看的一段話）與寫錯、沒有作用的（警告）。純函式。
 *   OLLAMA_NO_THINK：不認得的名稱（例 verfy）→ 警告；認得但本來就不思考的（例 classify）→ 警告「沒有作用」。
 *   OLLAMA_MAX_OUTPUT_<X>／OLLAMA_NUM_CTX_<X>：<X> 不是認得的 agent → 警告；值不是正整數 → 警告「被忽略」；
 *   輸出上限不比 agent 原本的小（只降不升）→ 警告「沒有作用」；〔C-c〕例外是有本機預設的 agent（verify）：
 *   寫原本的上限（8192）＝取消預設，列在生效的裡面。〔R7-1〕variant 自己不帶上限：寫 ≥ UNCAPPED_CEILING（8192）＝取消預設。
 * 〔Owner 第五輪 C-b、C-c〕defaults：沒被環境變數取代、仍然生效的本機預設（只在模型是 ollama 時套用）。
 * @param {object} [env]
 * @returns {{active:string[], warnings:string[], defaults:string[]}}
 */
function checkOverrides(env = process.env) {
    const active = [];
    const warnings = [];
    const defaults = [];
    const knownSuffix = new Map(KNOWN_AGENTS.map(a => [agentEnvSuffix(a), a]));
    const thinkers = thinkingBaseNames();

    const rawNoThink = String(env.OLLAMA_NO_THINK ?? '').trim();
    if (rawNoThink) {
        const { all, names } = describeOverrides(env).noThink;
        const effective = [];
        for (const name of names) {
            const known = KNOWN_AGENTS.includes(name) || KNOWN_AGENTS.includes(baseAgent(name));
            if (!known) {
                warnings.push(`OLLAMA_NO_THINK 裡的「${name}」不是認得的 agent（寫錯了？這個名字會被忽略）。會思考的 agent：${thinkers.join('、')}（化學版寫基本名稱即可）。`);
            } else if (!Object.prototype.hasOwnProperty.call(THINKING_AGENTS, name) && !thinkers.includes(baseAgent(name))) {
                warnings.push(`OLLAMA_NO_THINK 裡的「${name}」本來就不思考，寫了沒有作用。會思考的 agent：${thinkers.join('、')}。`);
            } else {
                effective.push(name);
            }
        }
        if (all) active.push(`不思考：全部會思考的 agent（${thinkers.join('、')}）`);
        else if (effective.length) active.push(`不思考：${effective.join('、')}（寫基本名稱的連化學版一起）`);
        else if (!names.size) active.push(`不思考：無（OLLAMA_NO_THINK=${rawNoThink}，取消本機預設 ${LOCAL_DEFAULTS.noThink.join('、')}）`);
    } else {
        defaults.push(`不思考：${LOCAL_DEFAULTS.noThink.join('、')}（本機預設，Owner 第五輪 C-b；OLLAMA_NO_THINK 有寫就整個取代）`);
    }

    for (const [prefix, what] of [['OLLAMA_MAX_OUTPUT_', '輸出上限'], ['OLLAMA_NUM_CTX_', 'num_ctx']]) {
        const items = [];
        for (const key of Object.keys(env).filter(k => k.startsWith(prefix) && k.length > prefix.length).sort()) {
            const raw = String(env[key] ?? '').trim();
            if (!raw) continue;
            const agent = knownSuffix.get(key.slice(prefix.length));
            if (!agent) {
                warnings.push(`${key}：「${key.slice(prefix.length)}」不是認得的 agent（寫錯了？這個設定會被忽略）。agent 名稱大寫，例 ${prefix}${agentEnvSuffix('verify')}、${prefix}${agentEnvSuffix('extract_ocr')}。`);
                continue;
            }
            const n = positiveIntOrNull(raw);
            if (n === null) {
                warnings.push(`${key}=${raw} 不是正整數，被忽略。`);
                continue;
            }
            const own = THINKING_AGENTS[agent] || THINKING_AGENTS[baseAgent(agent)];
            const d = defaultMaxOutputFor(agent);
            // 〔R7-1〕自己不帶上限、但有本機預設的（variant）：UNCAPPED_CEILING 當原本的上限
            const ceiling = own ? own.maxOutputTokens : (d ? UNCAPPED_CEILING : null);
            if (prefix === 'OLLAMA_MAX_OUTPUT_' && ceiling && n >= ceiling) {
                if (d) {
                    items.push(`${key}=${n}（不降：取消本機預設 ${d}）`);
                    continue;
                }
                warnings.push(`${key}=${n} 不比 ${agent} 原本的輸出上限 ${own.maxOutputTokens} 小（只降不升），沒有作用。`);
                continue;
            }
            items.push(`${key}=${n}`);
        }
        if (items.length) active.push(`${what}：${items.join('、')}`);
    }

    // 〔C-c〕還在用本機預設輸出上限的 agent（環境變數沒寫、或亂填被忽略）
    // 〔R7-1〕每個基本名稱一行（verify 一行、variant 一行），各自標是哪一輪核准的
    for (const base of Object.keys(LOCAL_DEFAULTS.maxOutput)) {
        const byValue = new Map();
        for (const agent of [base, `${base}${CHEM_SUFFIX}`]) {
            if (!KNOWN_AGENTS.includes(agent) || perAgentInt('OLLAMA_MAX_OUTPUT_', agent, env)) continue;
            const d = defaultMaxOutputFor(agent);
            if (!byValue.has(d)) byValue.set(d, []);
            byValue.get(d).push(agent);
        }
        for (const [d, agents] of byValue) {
            defaults.push(`輸出上限：${agents.join('、')} ${d}（本機預設，${LOCAL_DEFAULT_SOURCES[base] || 'Owner 核准'}；OLLAMA_MAX_OUTPUT_${agentEnvSuffix(base)} 可覆寫）`);
        }
    }
    return { active, warnings, defaults };
}

/**
 * 〔Owner 第五輪 C-b、C-c〕文字模型是不是本機（ollama）：本機預設只在這時候印出來（Gemini 模式印了只會誤導）。純函式。
 * 看 MODEL_VERIFY（沒寫＝config/models.js 的預設 ollama:qwen3:8b）、MODEL_TEXT、MODEL_KC_TAG、〔R7-1〕MODEL_VARIANT 任一個是 ollama。
 * @param {object} [env]
 * @returns {boolean}
 */
function textModelIsLocal(env = process.env) {
    const models = require('../../config/models');
    // 〔R7-1〕MODEL_VARIANT（沒寫時照 MODEL_VERIFY）也算：變式的本機預設上限只在它是 ollama 時套用
    const specs = [String(env.MODEL_VERIFY ?? '').trim() || models.DEFAULT_VERIFY,
        String(env.MODEL_TEXT ?? '').trim(), String(env.MODEL_KC_TAG ?? '').trim(),
        String(env.MODEL_VARIANT ?? '').trim()].filter(Boolean);
    return specs.some((spec) => {
        try { return models.parseModel(spec).vendor === 'ollama'; } catch (_) { return false; }
    });
}

let announced = false;

/**
 * 啟動時印一次（同一行程只印一次）：LLM_MODE 是 live／record 時，把生效的本機調整印成一行，寫錯或沒有作用的各印一行警告。
 * 〔Owner 第五輪 C-b、C-c〕文字模型是 ollama 時，生效的本機預設（kc_tag 不思考、verify 上限 3072、〔R7-1〕variant 上限 1024）也列在同一行。
 * 什麼都沒寫而且不是本機、或 replay（這些設定不會套用）時什麼都不印。services/llm/index.js 載入時呼叫（伺服器與 worker 啟動時都會載入它）。
 * @param {object} [env]
 * @param {{log?:Function, warn?:Function}} [out]  測試注入點（預設 console）
 * @returns {boolean} 這次有沒有印東西
 */
function announceOverrides(env = process.env, { log = (s) => console.log(s), warn = (s) => console.warn(s) } = {}) {
    if (announced) return false;
    // 與 services/llm/index.js 的 llmMode() 同一個讀法：沒設或空字串＝replay
    const mode = String(env.LLM_MODE ?? '').trim().toLowerCase() || 'replay';
    if (mode !== 'live' && mode !== 'record') return false;
    const { active, warnings, defaults } = checkOverrides(env);
    const lines = [...active, ...(textModelIsLocal(env) ? defaults : [])];
    if (!lines.length && !warnings.length) return false;
    announced = true;
    if (lines.length) log(`[ollama] 本機調整（docs/local-mode.md 第 10.14 條；只在模型是 ollama:… 時套用）：${lines.join('；')}`);
    for (const w of warnings) warn(`[ollama] ⚠ ${w}`);
    return true;
}

/** 測試用：讓 announceOverrides 可以再印一次 */
function _resetAnnounceForTest() { announced = false; }

module.exports = {
    resolveOllamaOverrides, noThinkFor, perAgentInt, parseAgentList, agentEnvSuffix, baseAgent, describeOverrides,
    THINKING_AGENTS, OVERRIDE_ENV_PATTERN, ALL_WORDS,
    // 〔審查修正〕
    KNOWN_AGENTS, checkOverrides, announceOverrides, _resetAnnounceForTest,
    // 〔Owner 第五輪 C-b、C-c〕本機預設
    LOCAL_DEFAULTS, NONE_WORDS, noThinkSpec, defaultMaxOutputFor, textModelIsLocal,
    // 〔Owner 第七輪 R7-1〕
    LOCAL_DEFAULT_SOURCES, UNCAPPED_CEILING
};
