// config/similarityThresholds.js — 五個餘弦門檻的預設值（〔Owner 第五輪 V5-1～V5-5、O-2 核准 2026-09-27〕docs/local-mode.md 10.16）
//
// 本機向量模型（qwen3-embedding:0.6b）的餘弦分布和 Gemini 不同（docs/local-embed-thresholds-report.md），
// 原本照 Gemini 定的門檻在本機模式下不合用。Owner 第五輪決定：
//   V5-1＝2  VARIANT_RETRIEVE_SIM_MIN  找現成相似題      0.80 → 0.72
//   V5-2＝2  VARIANT_OFFTOPIC_SIM_MIN  變式跑題          0.90 → 0.87（暫定：反斜線修好、variant 重錄後依 O-4 抽查再定案）
//   V5-3＝3  DEDUP_DUP_THRESHOLD       重複題            0.97 → 0.99
//   V5-4＝1  DEDUP_VARIANT_THRESHOLD   「是變式」標記    維持 0.90
//   O-2＝1   KNN_VOTE_SIM              kNN 投票短路      維持 0.90
//   V5-5＝1  **只改本機模式的預設**：向量模型（EMBED_MODEL）是 ollama: 時用上面的新值；Gemini 模式維持舊值
//            （0.80／0.90／0.97／0.90／0.90）。與「本機每塊 2 頁、Gemini 20 頁」同一種寫法，切換模型時不必記得改門檻。
//
// 判斷用的是**向量模型**（不是拆題模型）：這五個門檻比的全是 embedding 的餘弦。
// EMBED_MODEL 沒設＝本機預設 ollama:qwen3-embedding:0.6b（config/models.js 的 DEFAULT_EMBED）→ 本機值；
// 沒有前綴的舊值 gemini-embedding-001、或明寫 gemini:… → Gemini 值（與 services/llm 的分派規則相同）。
//
// 優先順序（每個門檻各自判斷）：
//   1. .env 明寫的值（解析得出數字）一律優先——環境變數仍可覆寫；
//   2. 兩個變式門檻另有舊名 VARIANT_SIM_MIN 當退路（裁決 S3-R9；只在新變數沒設時生效）；
//   3. 依向量模型取本檔的預設。
// 亂填的數字（解析不出來）與沒填一樣。
//
// 全案只有這一支決定這五個預設：workers/jobRunner.js（loadConfig／loadStage3Config）、services/variantService.js、
// eval（suiteVariant、pipelineDriver）、embed:thresholds 的「現行值」都從這裡讀。
// agents/dedup.js、agents/generateVariant.js、agents/classify.js 裡的 DEFAULT_* 只是「ctx 沒帶門檻時」的保底
// （agent 不讀 process.env；runner 一律會帶），不是產品預設，本次不動。
//
// 純設定：只 require config/models.js 的常數（不連 DB、不讀檔）。

const { DEFAULT_EMBED } = require('./models');

/** Gemini 向量時的預設（docs/variants.md 第 3 節、裁決 S3-R9／S3-R29 定的原值，一個都沒改） */
const GEMINI_SIMILARITY_DEFAULTS = Object.freeze({
    variantRetrieveSimMin: 0.80,
    variantOfftopicSimMin: 0.90,
    dedupDup: 0.97,
    dedupVariant: 0.90,
    knnVoteSim: 0.90
});

/** 本機向量（ollama:）時的預設（Owner 第五輪 V5-1＝2、V5-2＝2 暫定、V5-3＝3、V5-4＝1、O-2＝1） */
const LOCAL_SIMILARITY_DEFAULTS = Object.freeze({
    variantRetrieveSimMin: 0.72,
    variantOfftopicSimMin: 0.87,
    dedupDup: 0.99,
    dedupVariant: 0.90,
    knnVoteSim: 0.90
});

/** 門檻鍵 → 環境變數名 */
const ENV_NAMES = Object.freeze({
    variantRetrieveSimMin: 'VARIANT_RETRIEVE_SIM_MIN',
    variantOfftopicSimMin: 'VARIANT_OFFTOPIC_SIM_MIN',
    dedupDup: 'DEDUP_DUP_THRESHOLD',
    dedupVariant: 'DEDUP_VARIANT_THRESHOLD',
    knnVoteSim: 'KNN_VOTE_SIM'
});

/** 舊名 VARIANT_SIM_MIN 只當這兩個的退路 */
const LEGACY_KEYS = Object.freeze(['variantRetrieveSimMin', 'variantOfftopicSimMin']);

/**
 * 實際生效的向量模型字串（EMBED_MODEL；沒設或全空白＝本機預設）。
 * @param {object} [env]
 * @returns {string}
 */
function embedModelOf(env = process.env) {
    return String((env && env.EMBED_MODEL) ?? '').trim() || DEFAULT_EMBED;
}

/**
 * 向量模型是不是本機（ollama:）。沒有前綴的舊值（gemini-embedding-001）是 Gemini。
 * @param {object|string} [envOrModel] env 物件，或直接給模型字串
 * @returns {boolean}
 */
function isLocalEmbed(envOrModel = process.env) {
    const spec = typeof envOrModel === 'string' ? (envOrModel.trim() || DEFAULT_EMBED) : embedModelOf(envOrModel);
    return spec.toLowerCase().startsWith('ollama:');
}

/**
 * 某個向量模型沒寫 .env 時的預設（embed:thresholds 的「現行值」、文件用）。
 * @param {object|string} [envOrModel]
 * @returns {{mode:'local'|'gemini', variantRetrieveSimMin:number, variantOfftopicSimMin:number,
 *            dedupDup:number, dedupVariant:number, knnVoteSim:number}}
 */
function similarityDefaultsFor(envOrModel = process.env) {
    const local = isLocalEmbed(envOrModel);
    return { mode: local ? 'local' : 'gemini', ...(local ? LOCAL_SIMILARITY_DEFAULTS : GEMINI_SIMILARITY_DEFAULTS) };
}

/**
 * 五個門檻的實際值（.env 明寫 > 舊名 VARIANT_SIM_MIN（只給兩個變式門檻）> 依向量模型的預設）。
 * @param {object} [env] 預設 process.env
 * @returns {{mode:'local'|'gemini', embedModel:string, variantRetrieveSimMin:number, variantOfftopicSimMin:number,
 *            dedupDup:number, dedupVariant:number, knnVoteSim:number,
 *            source:Record<string,'env'|'legacy'|'default'>}}
 */
function resolveSimilarityThresholds(env = process.env) {
    const e = env || {};
    const num = (name) => {
        const n = Number.parseFloat(e[name]);
        return Number.isFinite(n) ? n : null;
    };
    const defaults = similarityDefaultsFor(e);
    const legacy = num('VARIANT_SIM_MIN');
    const out = { mode: defaults.mode, embedModel: embedModelOf(e), source: {} };
    for (const [key, name] of Object.entries(ENV_NAMES)) {
        const explicit = num(name);
        if (explicit !== null) {
            out[key] = explicit; out.source[key] = 'env';
        } else if (legacy !== null && LEGACY_KEYS.includes(key)) {
            out[key] = legacy; out.source[key] = 'legacy';
        } else {
            out[key] = defaults[key]; out.source[key] = 'default';
        }
    }
    return out;
}

/**
 * 啟動訊息用的一行摘要（workers/jobRunner.js 的「jobRunner 啟動」）。
 * @param {ReturnType<typeof resolveSimilarityThresholds>} r
 * @returns {string}
 */
function describeSimilarityThresholds(r) {
    const parts = Object.entries(ENV_NAMES).map(([key, name]) =>
        `${name}=${r[key]}${r.source[key] === 'env' ? '（.env）' : r.source[key] === 'legacy' ? '（舊名 VARIANT_SIM_MIN）' : ''}`);
    return `${r.mode === 'local' ? '本機向量' : 'Gemini 向量'}的門檻：${parts.join('、')}`;
}

module.exports = {
    GEMINI_SIMILARITY_DEFAULTS, LOCAL_SIMILARITY_DEFAULTS, ENV_NAMES,
    embedModelOf, isLocalEmbed, similarityDefaultsFor, resolveSimilarityThresholds, describeSimilarityThresholds
};
