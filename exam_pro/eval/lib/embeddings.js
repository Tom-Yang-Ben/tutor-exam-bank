// ─────────────────────────────────────────────────────────────
// eval/lib/embeddings.js — 讀 fixture 向量檔
//
// docs/interfaces-stage1.md 第 4 條把檔名與格式一起凍結了：
//   eval/fixtures/embeddings.<model>.<dim>.json
//   { "<sha256(embed_text)>": [ … dim 個小數 6 位的數字 … ], … }
// 查不到就丟錯並印「請在本機執行 npm run eval:record」，**不得靜默回退成假向量**。
//
// 這一條在 eval 這邊尤其要守：一份靜默造假的向量會讓向量欄與 hybrid 欄長出漂亮的數字，
// 而那些數字只是隨機噪音的排序——CI 全綠、基準線寫進 thresholds.json，
// 之後所有人都在守一個沒有意義的門檻。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { buildEmbedText, embedHash } = require('./embedText');
const { embedModelFromEnv } = require('./localMode');

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
// 〔本機模式 L4〕沒設 EMBED_MODEL 時是本機預設 ollama:qwen3-embedding:0.6b（docs/local-mode.md 第 2 條），
// 與 services/llm 的預設一致；要讀 repo 裡既有的 Gemini 向量檔請明寫 EMBED_MODEL=gemini-embedding-001。
const DEFAULT_MODEL = embedModelFromEnv();
const DEFAULT_DIM = Number(process.env.EMBED_DIM || 768);

/**
 * 檔名裡的模型段：`:`、`/`、`\` 一律換成 `-`（docs/local-mode.md 第 3 條第 6 點：Windows 檔名不能有冒號）。
 * Gemini 的舊值（gemini-embedding-001）沒有這三個字元，檔名與之前逐字相同。純函式。
 * @param {string} model 例：'ollama:qwen3-embedding:0.6b' → 'ollama-qwen3-embedding-0.6b'
 * @returns {string}
 */
function safeModelName(model) {
    return String(model).replace(/[:/\\]/g, '-');
}

/**
 * @param {string} model EMBED_MODEL 的完整字串（含 vendor 前綴，與 services/llm/index.js 交給 fixture 的相同）
 * @param {number} dim
 * @returns {string} 絕對路徑
 */
function fixturePath(model, dim) {
    return path.join(FIXTURE_DIR, `embeddings.${safeModelName(model)}.${dim}.json`);
}

/**
 * 載入向量檔並綁到 fixture 題目上。
 *
 * @param {object} opts
 * @param {Array<object>} opts.questions
 * @param {string} [opts.model=EMBED_MODEL]
 * @param {number} [opts.dim=EMBED_DIM]
 * @param {boolean} [opts.optional=false] true = 檔案不存在時回 {available:false}，不丟錯
 * @returns {{available:boolean, file:string, model:string, dim:number,
 *            vectorOf:(q:object)=>number[]|null, missing:number[], reason?:string}}
 */
function loadEmbeddings(opts) {
    // 〔本機模式 L4〕預設在呼叫當下讀 EMBED_MODEL（不是載入本檔時的快照）：測試與工具先設環境變數再跑 suite 也生效
    const model = opts.model || embedModelFromEnv();
    const dim = opts.dim || Number(process.env.EMBED_DIM || DEFAULT_DIM);
    const file = fixturePath(model, dim);

    if (!fs.existsSync(file)) {
        const reason = `找不到向量 fixture：${file}\n   請在本機執行 npm run eval:record（ollama: 模型要 Ollama 在跑、Gemini 要 GEMINI_API_KEY；CI 永遠只讀這個檔，不呼叫任何模型）。`;
        if (opts.optional) return { available: false, file, model, dim, vectorOf: () => null, missing: [], reason };
        throw new Error(reason);
    }

    const table = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cache = new Map();
    const missing = [];

    for (const q of opts.questions || []) {
        const hash = embedHash(buildEmbedText(q));
        const vec = table[hash];
        if (!vec) { missing.push(q.id); continue; }
        if (vec.length !== dim) {
            throw new Error(`向量維度不符：id=${q.id} 取到 ${vec.length} 維，EMBED_DIM=${dim}。改維度＝換模型，必須重錄整份 fixture。`);
        }
        cache.set(q.id, vec);
    }

    return {
        available: true,
        file,
        model,
        dim,
        missing,
        /** @param {object} q @returns {number[]|null} */
        vectorOf: (q) => cache.get(q.id) || null
    };
}

/**
 * 缺向量時的處理：一題都不能少。少一題就代表 fixture 題幹改過而向量沒重錄，
 * 這種狀態下算出來的三欄對照是錯的，所以直接丟錯而不是跳過那幾題。
 * @param {{missing:number[], file:string}} emb
 */
function assertComplete(emb) {
    if (emb.missing.length > 0) {
        throw new Error(
            `有 ${emb.missing.length} 題在 ${path.basename(emb.file)} 裡查不到向量（id：${emb.missing.join(', ')}）。\n` +
            '   代表 fixture 題幹或 buildEmbedText() 的規則改過了——embed_hash 一變，舊向量全部作廢。\n' +
            '   請在本機執行 npm run eval:record 重錄，並在 PR 說明是什麼改動造成的。'
        );
    }
}

module.exports = { loadEmbeddings, assertComplete, fixturePath, safeModelName, DEFAULT_MODEL, DEFAULT_DIM };
