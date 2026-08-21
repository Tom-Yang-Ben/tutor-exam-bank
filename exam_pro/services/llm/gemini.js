// services/llm/gemini.js — Gemini adapter（docs/interfaces.md 第 4 條）
//
// 只有 EMBED_MODE=live|record（或 LLM_MODE=live|record）才會走到這裡；CI 永遠走 fixture／replay，
// 因此 GitHub Actions 不需要任何金鑰。
//
// 兩件事在這一層做完，呼叫端不必再操心：
//   1. 令牌桶限速（EMBED_RPM，滑動 60 秒視窗）
//   2. 429/503 指數退避 1s → 60s，最多 6 次；其餘錯誤直接往上丟

const { GoogleGenAI } = require('@google/genai');

const MAX_RETRY = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;

let client = null;

function getClient() {
    if (client) return client;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        throw new Error('缺少 GEMINI_API_KEY：EMBED_MODE/LLM_MODE 設為 live 或 record 時必須提供金鑰（CI 請維持 fixture／replay）。');
    }
    client = new GoogleGenAI({ apiKey });
    return client;
}

// ───────────────────────── 令牌桶（滑動 60 秒視窗）─────────────────────────

const requestTimestamps = [];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function acquireSlot() {
    const rpm = Number.parseInt(process.env.EMBED_RPM || '60', 10);
    if (!Number.isFinite(rpm) || rpm <= 0) return;

    for (;;) {
        const now = Date.now();
        while (requestTimestamps.length && now - requestTimestamps[0] >= 60000) requestTimestamps.shift();
        if (requestTimestamps.length < rpm) {
            requestTimestamps.push(now);
            return;
        }
        await sleep(60000 - (now - requestTimestamps[0]) + 50);
    }
}

// ───────────────────────── 退避 ─────────────────────────

/** 429（配額）與 5xx（服務暫時不可用）才重試；其餘（400、401）重試沒有意義 */
function isRetryable(err) {
    const status = err?.status ?? err?.code ?? err?.response?.status;
    if (status === 429 || status === 503 || status === 500 || status === 502 || status === 504) return true;
    const msg = String(err?.message || '');
    return /\b(429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|rate limit)\b/i.test(msg);
}

async function withRetry(label, fn) {
    let delay = BASE_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            await acquireSlot();
            return await fn();
        } catch (err) {
            if (attempt >= MAX_RETRY || !isRetryable(err)) throw err;
            console.warn(`[gemini] ${label} 第 ${attempt + 1} 次失敗（${err.message}），${delay} ms 後重試`);
            await sleep(delay);
            delay = Math.min(delay * 2, MAX_DELAY_MS);
        }
    }
}

// ───────────────────────── embed ─────────────────────────

/**
 * 真的呼叫 Gemini 取得向量（未正規化，正規化由 services/llm/index.js 統一做）。
 * @param {{model:string, texts:string[], dim:number, taskType?:string}} opts
 *        taskType：寫入用 'RETRIEVAL_DOCUMENT'（預設），階段 3 的自然語言查詢用 'RETRIEVAL_QUERY'
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embed({ model, texts, dim, taskType = 'RETRIEVAL_DOCUMENT' }) {
    const ai = getClient();

    const res = await withRetry(`embedContent(${texts.length} 筆)`, () => ai.models.embedContent({
        model,
        contents: texts,
        config: { taskType, outputDimensionality: dim }
    }));

    const embeddings = res?.embeddings || [];
    if (embeddings.length !== texts.length) {
        throw new Error(`Gemini 回傳 ${embeddings.length} 個向量，與送出的 ${texts.length} 筆不符。`);
    }

    const vectors = embeddings.map((e, i) => {
        const values = e?.values;
        if (!Array.isArray(values) || values.length !== dim) {
            throw new Error(`Gemini 回傳第 ${i} 個向量維度為 ${Array.isArray(values) ? values.length : '非陣列'}，期望 ${dim}（EMBED_DIM）。`);
        }
        return values;
    });

    // embedContent 不一定帶 usage；有 statistics.tokenCount 就加總，沒有就記 0（只影響成本報表）
    const tokenIn = embeddings.reduce((sum, e) => sum + (e?.statistics?.tokenCount || 0), 0);
    return { vectors, usage: { tokenIn } };
}

// ───────────────────────── generateJson（骨架，階段 2 才填）─────────────────────────

/**
 * 受限 JSON 生成。階段 1 只留簽名與最小可用實作，五個 sub-agent 的節點合約在階段 2 才接上。
 * @param {{model:string, system?:string, parts:Array<{text?:string,pdfBase64?:string,fileUri?:string}>,
 *          schema?:object, maxOutputTokens?:number, signal?:AbortSignal}} opts
 */
async function generateJson({ model, system, parts, schema, maxOutputTokens, signal }) {
    const ai = getClient();
    const startedAt = Date.now();

    const contents = (parts || []).map((p) => {
        if (p.text !== undefined) return { text: p.text };
        if (p.pdfBase64 !== undefined) return { inlineData: { mimeType: 'application/pdf', data: p.pdfBase64 } };
        if (p.fileUri !== undefined) return { fileData: { mimeType: 'application/pdf', fileUri: p.fileUri } };
        throw new Error('generateJson：parts 只接受 {text} / {pdfBase64} / {fileUri}');
    });

    const config = { responseMimeType: 'application/json' };
    if (schema) config.responseSchema = schema;
    if (system) config.systemInstruction = system;
    if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
    if (signal) config.abortSignal = signal;

    const res = await withRetry('generateContent', () => ai.models.generateContent({ model, contents, config }));

    let raw = String(res?.text ?? '').trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    const usageMeta = res?.usageMetadata || {};
    return {
        data: JSON.parse(raw),
        usage: {
            tokenIn: usageMeta.promptTokenCount || 0,
            tokenOut: usageMeta.candidatesTokenCount || 0,
            tokenThinking: usageMeta.thoughtsTokenCount || 0,
            tokenCached: usageMeta.cachedContentTokenCount || 0
        },
        latencyMs: Date.now() - startedAt,
        raw: res
    };
}

module.exports = { embed, generateJson };
