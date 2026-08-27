// services/llm/index.js — LLM 與 embedding 的唯一出入口（docs/interfaces-stage1.md 第 4 條）
//
//   embed({ model, texts, dim })
//     → { vectors: number[][], usage: { tokenIn } }      vectors[i] 對應 texts[i]，已 L2 正規化
//   generateJson({ model, system, parts, schema, maxOutputTokens, signal })
//     → { data, usage: { tokenIn, tokenOut, tokenThinking, tokenCached }, latencyMs, raw }
//
// 模式旗標（.env）：
//   EMBED_MODE = live | record | fixture      CI 恆為 fixture
//   LLM_MODE   = live | record | replay       CI 恆為 replay
//
// 階段 1 只要求 embed() 可用；generateJson() 留簽名與 gemini 骨架，階段 2 才接上五個 sub-agent。

const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_DIM = 768;

/** 讀取模式；未設定時走最安全的那一個（不會產生費用、不需金鑰） */
function embedMode() {
    const m = String(process.env.EMBED_MODE || 'fixture').toLowerCase();
    if (m !== 'live' && m !== 'record' && m !== 'fixture') {
        throw new Error(`EMBED_MODE 只能是 live / record / fixture，收到「${process.env.EMBED_MODE}」。`);
    }
    return m;
}

function llmMode() {
    const m = String(process.env.LLM_MODE || 'replay').toLowerCase();
    if (m !== 'live' && m !== 'record' && m !== 'replay') {
        throw new Error(`LLM_MODE 只能是 live / record / replay，收到「${process.env.LLM_MODE}」。`);
    }
    return m;
}

/** L2 正規化。cosine 距離與內積因此等價，pgvector 的 <=> 也才穩定 */
function l2Normalize(vec) {
    let sum = 0;
    for (const v of vec) sum += v * v;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) {
        throw new Error('向量的 L2 範數為 0 或非有限值，無法正規化（多半代表上游回了空向量）。');
    }
    return vec.map(v => v / norm);
}

/**
 * 取得一批文本的向量。
 * @param {{model?:string, texts:string[], dim?:number, taskType?:string}} opts
 *        taskType 為選用擴充：寫入用 'RETRIEVAL_DOCUMENT'（預設），
 *        階段 3 的自然語言查詢用 'RETRIEVAL_QUERY'；fixture 模式不受影響。
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embed({ model, texts, dim, taskType } = {}) {
    const useModel = model || process.env.EMBED_MODEL || DEFAULT_MODEL;
    const useDim = Number.parseInt(dim || process.env.EMBED_DIM || DEFAULT_DIM, 10);

    if (!Array.isArray(texts)) throw new Error('embed({ texts }) 的 texts 必須是字串陣列。');
    if (!Number.isInteger(useDim) || useDim <= 0) throw new Error(`EMBED_DIM 無效：${dim ?? process.env.EMBED_DIM}`);
    if (texts.length === 0) return { vectors: [], usage: { tokenIn: 0 } };

    const mode = embedMode();

    if (mode === 'fixture') {
        const { embedFromFixture } = require('./fixture');
        const res = embedFromFixture({ model: useModel, texts, dim: useDim });
        return { vectors: res.vectors.map(l2Normalize), usage: res.usage };
    }

    const gemini = require('./gemini');
    const res = await gemini.embed({ model: useModel, texts, dim: useDim, taskType });
    const vectors = res.vectors.map(l2Normalize);

    if (mode === 'record') {
        // 錄成 eval/fixtures/embeddings.<model>.<dim>.json，之後 CI 就只讀這個檔
        const { saveToFixture, sha256Hex } = require('./fixture');
        const entries = texts.map((text, i) => [sha256Hex(text), vectors[i]]);
        const file = saveToFixture({ model: useModel, dim: useDim, entries });
        console.log(`[embed:record] 已寫入 ${entries.length} 筆向量 → ${file}`);
    }

    return { vectors, usage: res.usage };
}

/**
 * 受限 JSON 生成（docs/interfaces-stage2.md 第 5.1 條）。
 *
 * 三個模式：
 *   live   —— 真的呼叫供應商，不留 cassette
 *   record —— 真的呼叫，把回應寫成 cassette（同鍵覆寫並印一行 log）
 *   replay —— 只讀 cassette；miss 一律丟錯（訊息逐字凍結於第 5.2 條），CI 恆為這個模式
 *
 * @param {{model?:string, system?:string, parts:Array<object>, schema?:object,
 *          maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal,
 *          agent?:string, cacheKeyParts?:object, template?:string}} opts
 *        agent／cacheKeyParts／template 是階段 2 新增的三個選用欄位；
 *        record／replay 模式下 **agent 必填**（它是 cassette 的第一段鍵與子目錄名）。
 * @returns {Promise<{data:object, usage:{tokenIn,tokenOut,tokenThinking,tokenCached},
 *                    latencyMs:number, raw:any}>}
 */
async function generateJson(opts = {}) {
    const mode = llmMode();
    const { parseModel } = require('../../config/models');
    const models = require('../../config/models');
    const { vendor, id } = parseModel(opts.model || models.MODEL_EXTRACT);

    if (mode === 'replay') {
        const fake = require('./fake');
        return fake.generateJson({ ...opts, model: id });
    }

    if (vendor !== 'gemini') {
        throw new Error(`services/llm：第一版只有 gemini adapter，收到 vendor=「${vendor}」（anthropic／openai 留給 A-T17）。`);
    }

    const gemini = require('./gemini');
    const res = await gemini.generateJson({ ...opts, model: id });

    if (mode === 'record') {
        const cassette = require('./cassette');
        const key = cassette.cassetteKey({
            agent: opts.agent, modelId: id, template: opts.template,
            schema: opts.schema, cacheKeyParts: opts.cacheKeyParts
        });
        const { file, overwritten } = cassette.writeCassette({
            agent: opts.agent,
            key,
            meta: {
                agent: opts.agent,
                model: id,
                template: opts.template ?? null,
                recorded_at: new Date().toISOString(),
                fixtureHash: cassette.fixtureHash()
            },
            // 只存摘要：PDF base64 與逐字試題絕不進版控（NOTICE 第 4 條）
            request: {
                parts: cassette.summarizeParts(opts.parts),
                cacheKeyParts: opts.cacheKeyParts ?? {}
            },
            response: { data: res.data, usage: res.usage, latencyMs: res.latencyMs }
        });
        console.log(`[llm:record] ${overwritten ? '覆寫' : '寫入'} cassette → ${file}`);
    }

    return res;
}

module.exports = { embed, generateJson, l2Normalize, embedMode, llmMode };
