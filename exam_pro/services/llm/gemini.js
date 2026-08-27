// services/llm/gemini.js — Gemini adapter（docs/interfaces-stage1.md 第 4 條、interfaces-stage2.md 第 5 條）
//
// 只有 EMBED_MODE=live|record（或 LLM_MODE=live|record）才會走到這裡；CI 永遠走 fixture／replay，
// 因此 GitHub Actions 不需要任何金鑰。
//
// embed 這一半：
//   1. 令牌桶限速（EMBED_RPM，滑動 60 秒視窗）
//   2. 429/503 指數退避 1s → 60s，最多 6 次；其餘錯誤直接往上丟
//   ⚠ 階段 2 不得改動 embed 的既有行為（test/unit/llmEmbed.test.js 是契約）。
//
// generateJson 這一半（A-T3）：
//   1. 出口配額改用 services/llm/throttle.js 的每供應商雙桶（RPM + 併發），與 embed 的桶分開
//   2. structured output 用 **responseJsonSchema**（裁決 S0-1／S0-2）：
//      responseSchema 的 SDK 轉換器會默默丟掉 additionalProperties，而 A-T0 spike 實測
//      「schema 不含 enum、白名單只寫在 prompt」三次全部回了白名單外的章節名
//   3. 退路（預設不啟用）：收到 400 且訊息含 enum／schema → 拆掉 enum 改用 prompt 列舉重試一次，
//      回傳物件帶 schemaFallback:true（runner 記進 job_events.detail）
//   4. usage 四欄；計費用 tokenOut + tokenThinking（裁決 S0-6：thinking 常常比 candidates 還大）
//   5. AbortSignal 一路傳到 SDK；被中止時丟 errorClass='timeout' 的錯，且**不重試**

const { GoogleGenAI } = require('@google/genai');
const throttle = require('./throttle');

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

// ───────────────────────── 令牌桶（embed 專用，滑動 60 秒視窗）─────────────────────────

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

// ───────────────────────── generateJson ─────────────────────────

/** 把 SDK／HTTP 的錯誤分類成 interfaces-stage2.md 第 2 條的 error_class */
function classifyError(err, signal) {
    if (signal && signal.aborted) return 'timeout';
    const name = String(err?.name || '');
    const msg = String(err?.message || '');
    if (name === 'AbortError' || /APIUserAbortError|APIConnectionTimeoutError/.test(name)) return 'timeout';
    const status = err?.status ?? err?.code ?? err?.response?.status;
    if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED/i.test(msg)) return 'rate_limited';
    return 'provider_error';
}

/** 標記錯誤的 error_class（agent 依它回 {kind:'error', errorClass}），並原樣往上丟 */
function tagError(err, signal) {
    if (!err.errorClass) err.errorClass = classifyError(err, signal);
    return err;
}

/** 400 且訊息提到 enum／schema／responseJsonSchema → 值得用「不含 enum」的 schema 再試一次 */
function isSchemaRejection(err) {
    const status = err?.status ?? err?.code ?? err?.response?.status;
    const msg = String(err?.message || '');
    const looks400 = status === 400 || /\b400\b|INVALID_ARGUMENT/i.test(msg);
    return looks400 && /enum|schema/i.test(msg);
}

/**
 * 深拷貝 schema 並拆掉所有 enum，同時把「哪個欄位有哪些合法值」收集起來，
 * 好讓退路把白名單寫進 prompt。
 * @returns {{schema:object, enums:Array<{path:string, values:string[]}>}}
 */
function stripEnums(schema) {
    const enums = [];
    const walk = (node, path) => {
        if (Array.isArray(node)) return node.map(v => walk(v, path));
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === 'enum' && Array.isArray(value)) {
                enums.push({ path: path.join('.') || '(root)', values: value.map(String) });
                continue;
            }
            // 只有 properties 的子鍵與 items 會加深「欄位路徑」，type／description 這些不會
            if (key === 'properties' && value && typeof value === 'object') {
                const props = {};
                for (const [field, sub] of Object.entries(value)) props[field] = walk(sub, path.concat(field));
                out.properties = props;
                continue;
            }
            if (key === 'items') {
                out.items = walk(value, path.concat('[]'));
                continue;
            }
            out[key] = walk(value, path);
        }
        return out;
    };
    return { schema: walk(schema, []), enums };
}

/** 退路用：把白名單寫成一段 prompt 文字 */
function whitelistText(enums) {
    const lines = enums.map(e => `- ${e.path}：只能是 ${e.values.map(v => `「${v}」`).join('、')}`);
    return `【欄位值白名單（必須完全相符，不得自創新詞）】\n${lines.join('\n')}`;
}

/** parts → SDK 的 contents */
function toContents(parts) {
    return (parts || []).map((p) => {
        if (p.text !== undefined) return { text: p.text };
        if (p.pdfBase64 !== undefined) return { inlineData: { mimeType: 'application/pdf', data: p.pdfBase64 } };
        if (p.fileUri !== undefined) return { fileData: { mimeType: 'application/pdf', fileUri: p.fileUri } };
        throw new Error('generateJson：parts 只接受 {text} / {pdfBase64} / {fileUri}');
    });
}

/** 模型偶爾會用 ``` 圍起 JSON；把圍欄剝掉再 parse */
function parseJsonText(text) {
    let raw = String(text ?? '').trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    if (!raw) throw new Error('Gemini 回了空字串（多半是 maxOutputTokens 太小把 JSON 截斷了）。');
    return JSON.parse(raw);
}

/** 一次真呼叫（含出口配額與退避）；abort 一律不重試 */
async function callOnce({ ai, model, contents, config, signal, label }) {
    let delay = BASE_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) {
            const err = new Error(`generateJson 已被中止（節點逾時）：${label}`);
            err.errorClass = 'timeout';
            throw err;
        }
        const release = await throttle.acquire('gemini');
        try {
            return await ai.models.generateContent({ model, contents, config });
        } catch (err) {
            if (signal && signal.aborted) throw tagError(err, signal);
            if (attempt >= MAX_RETRY || !isRetryable(err)) throw tagError(err, signal);
            console.warn(`[gemini] ${label} 第 ${attempt + 1} 次失敗（${err.message}），${delay} ms 後重試`);
            await sleep(delay);
            delay = Math.min(delay * 2, MAX_DELAY_MS);
        } finally {
            release();
        }
    }
}

/**
 * 受限 JSON 生成。
 * @param {{model:string, system?:string, parts:Array<{text?:string,pdfBase64?:string,fileUri?:string}>,
 *          schema?:object, maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal}} opts
 *        model 必須是**裸 ID**（vendor 前綴由 services/llm/index.js 剝掉）
 * @returns {Promise<{data:object, usage:{tokenIn,tokenOut,tokenThinking,tokenCached},
 *                    latencyMs:number, raw:any, schemaFallback:boolean}>}
 */
async function generateJson({ model, system, parts, schema, maxOutputTokens, thinkingBudget, signal }) {
    const ai = getClient();
    const startedAt = Date.now();
    const contents = toContents(parts);

    const baseConfig = { responseMimeType: 'application/json' };
    if (system) baseConfig.systemInstruction = system;
    if (maxOutputTokens) baseConfig.maxOutputTokens = maxOutputTokens;
    // thinking token 計入 maxOutputTokens 的額度：不設上限時 Pro 系列會把額度想光，
    // JSON 寫到一半被截斷（0 = 關閉思考、-1 = 交回模型自動；範圍依模型而異）
    if (Number.isInteger(thinkingBudget)) baseConfig.thinkingConfig = { thinkingBudget };
    if (signal) baseConfig.abortSignal = signal;

    let schemaFallback = false;
    let res;
    try {
        const config = { ...baseConfig };
        if (schema) config.responseJsonSchema = schema;   // 裁決 S0-1：不是 responseSchema
        res = await callOnce({ ai, model, contents, config, signal, label: `generateContent(${model})` });
    } catch (err) {
        if (!schema || !isSchemaRejection(err)) throw tagError(err, signal);

        // ── 退路：拆掉 enum，把白名單改寫進 prompt，重試一次 ──
        // 伺服器端的 ajv 仍是最終閘門（A-T0 spike 的 A3：沒有 enum 時模型會自創章節名）
        console.warn(`[gemini] responseJsonSchema 被拒（${err.message}），改用「不含 enum 的 schema + prompt 列舉白名單」重試一次。`);
        const stripped = stripEnums(schema);
        const config = { ...baseConfig, responseJsonSchema: stripped.schema };
        const fallbackContents = stripped.enums.length
            ? contents.concat([{ text: whitelistText(stripped.enums) }])
            : contents;
        res = await callOnce({ ai, model, contents: fallbackContents, config, signal, label: `generateContent(${model}, 無 enum 退路)` });
        schemaFallback = true;
    }

    const usageMeta = res?.usageMetadata || {};
    let data;
    try {
        data = parseJsonText(res?.text);
    } catch (err) {
        // JSON 壞掉是「模型輸出」的問題，不是供應商掛掉；讓 agent 走 schema_invalid 而不是無謂退避
        err.errorClass = 'schema_invalid';
        throw err;
    }

    return {
        data,
        usage: {
            tokenIn: usageMeta.promptTokenCount ?? 0,
            tokenOut: usageMeta.candidatesTokenCount ?? 0,
            tokenThinking: usageMeta.thoughtsTokenCount ?? 0,
            // 沒有快取命中時整個鍵不存在（不是 0）——裁決 S0-6 第 2 點
            tokenCached: usageMeta.cachedContentTokenCount ?? 0
        },
        latencyMs: Date.now() - startedAt,
        raw: res,
        schemaFallback
    };
}

module.exports = { embed, generateJson, stripEnums, classifyError, isSchemaRejection };
