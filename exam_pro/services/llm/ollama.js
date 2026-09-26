// services/llm/ollama.js — Ollama adapter（本機推論；docs/local-mode.md 第 3 條，擁有者：L1）
//
// 只有 LLM_MODE=live|record（或 EMBED_MODE=live|record）且模型是 ollama:… 時才會走到這裡；
// CI 永遠走 replay／fixture，不需要裝 Ollama。
//
// 打本機 Ollama 的 REST API（不加任何 npm 依賴）：
//   POST {OLLAMA_HOST}/api/chat    generateJson（format＝JSON Schema）、generateText（不送 format）
//   POST {OLLAMA_HOST}/api/embed   embed
//
// ⚠ 傳輸用 Node 內建的 node:http／node:https，**不用內建 fetch**：
//   fetch（undici）的 headersTimeout／bodyTimeout 預設都是 300 秒（Node 22／24 內附 undici 的 3e5），
//   而 stream:false 時 Ollama 要整段生成完才送回應標頭——CPU 上一次拆題動輒十幾二十分鐘，
//   用 fetch 必定在第 5 分鐘以「fetch failed / Headers Timeout Error」失敗（違反本機模式原則 5）。
//   改掉這個預設要 undici 的 Agent，那得新增 npm 依賴；node:http 沒有這兩個逾時，逾時完全由
//   OLLAMA_TIMEOUT_MS 與呼叫端的 AbortSignal 決定。另外用 agent:false：Node 19 起 http.globalAgent
//   帶 5 秒的 socket timeout，不該拿來跑長連線。
//
// 與 gemini.js 對齊的地方（呼叫端的重試與記帳規則因此不必分兩套）：
//   - 回傳形狀相同：{ data, usage:{tokenIn,tokenOut,tokenThinking,tokenCached}, latencyMs, raw, schemaFallback }
//   - 模型輸出不是合法 JSON → errorClass='schema_invalid'；用量掛在 err.usage、finishReason 掛在 err.finishReason（S5-45）
//   - 被中止或超過 OLLAMA_TIMEOUT_MS → errorClass='timeout'，不重試
//   - 其餘 → 'provider_error'（連不上：「Ollama 沒有在執行…」；模型沒下載：附 `ollama pull <id>`）
//
// 與 gemini.js 不同的地方：
//   - 沒有 code execution：tools.codeExecution 直接忽略，codeRuns 恆為 []
//   - 不收 PDF 與音訊：丟 errorClass='unsupported_input'（PDF 由 L2 的本機 OCR＋視覺路徑處理；語音在本機模式關閉）
//   - 沒有「思考預算」：thinkingBudget > 0 只代表 think:true。思考內容不進 data／text；
//     usage.tokenOut＝eval_count（Ollama 把思考與回覆一起算，num_predict 也是兩者合計），tokenThinking 恆為 0。
//     模型不支援思考（Ollama 回 400「does not support thinking」）時，拿掉 think 重送一次——換模型不必改程式。
//   - 不做退避重試：本機失敗多半是服務沒開、模型沒下載或記憶體不足，重試只會再等一次；節點層級的重試由 runner 決定。
//   - schema：Gemini 專用的 propertyOrdering（依它重排 properties）與 OpenAPI 式的 nullable（轉成 type:[…,'null']）
//     在這裡轉成標準 JSON Schema，agents/schemas 本身不改。另外把欄位說明整理成一段附在 system 後面：
//     Ollama 的 format 只拿 schema 做語法約束，模型本身**看不到** description（Gemini 看得到）。
//     這一段只影響送給 Ollama 的內容，cassette 的鍵（agent／modelId／模板雜湊／schemaHash／cacheKeyParts）不受影響。
//
// 〔看圖拆題逾時，dec/local-vision-timeout〕長呼叫看得到進度、分得出「慢」還是「卡住」：
//   - usage.timing：Ollama 回應裡的 load_duration／prompt_eval_duration／eval_duration／total_duration（奈秒）
//     換成毫秒 { totalMs, loadMs, promptEvalMs, evalMs }。**只有回應帶了這幾個欄位才加**（沒有就與之前逐位元相同）。
//     record 模式下 services/llm/index.js 把 usage 原樣寫進 cassette 的 response.usage——鍵不含 usage，所以鍵不變；
//     replay（services/llm/fake.js）只取 usage 的四個 token 欄位，回放結果也不變。npm run perf:local 靠它算
//     「讀圖（prompt eval）幾秒、純輸出幾 token/秒」。
//   - 串流進度：OLLAMA_PROGRESS_MS（或呼叫端的 progressMs）> 0 時改送 stream:true，每隔這麼久印一行
//     「已輸出 N token」「還沒輸出第一個 token（載入模型＋讀圖中）」「N 秒沒有新 token」，結束時印分段時間。
//     串流的每一行在結束後組回與 stream:false 相同的回應物件（assembleStream），data／usage／raw 都相同，
//     cassette 內容也相同（test/unit/llmOllamaStream.test.js 證明）。**未設＝0＝照舊 stream:false**，逐位元不變。
//     讀 prompt（含看圖）那一段 Ollama 不回報進度，只能印「還沒輸出第一個 token」與經過時間；
//     那一段要多久用 npm run local:bench-vision 量（docs/local-mode.md 第 10.11 條）。
//   - 呼叫端可帶 timeoutMs 取代 OLLAMA_TIMEOUT_MS（只有本機量測工具用；agent 不帶）。

const http = require('http');
const https = require('https');

const throttle = require('./throttle');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_PORT = '11434';
const DEFAULT_TIMEOUT_MS = 1_800_000;     // 第 2 條：30 分
const DEFAULT_NUM_CTX = 16384;
const DEFAULT_KEEP_ALIVE = '10m';
/** 串流進度的間隔；0＝不串流（stream:false，與加這個功能之前逐位元相同） */
const DEFAULT_PROGRESS_MS = 0;
/** Ollama 的 *_duration 是奈秒 */
const NS_PER_MS = 1e6;
/** 第 2 條：OLLAMA_HOST 只允許這三個；其他主機名在啟動時警告（原則 1：執行期零外連） */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];
/** 欄位說明裡，enum 值不超過這個數就逐一列出；更多（例如 86 個章節）只寫「N 個合法值之一」——白名單已在 prompt 裡 */
const ENUM_INLINE_MAX = 12;

// ───────────────────────── 設定 ─────────────────────────

function positiveInt(raw, fallback) {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 解析 OLLAMA_HOST（寫法與 Ollama 自己的 CLI 相同）：
 *   未設 → http://127.0.0.1:11434
 *   '127.0.0.1'、'localhost:11434'、':11434' → 補 http:// 與預設埠 11434
 *   'http://host:port'、'https://…' → 原樣
 *   '0.0.0.0'／'::' 是 Ollama 伺服器「聽所有介面」的寫法（同一個變數常被設成這樣讓區網連得到）；
 *   拿來當連線目標時指的就是本機，改連 loopback（Windows 上直接連 0.0.0.0 會失敗），也不算外連。
 * @param {object} [env]
 * @returns {{url:string, hostname:string, local:boolean}}  url 不含結尾斜線
 * @throws  寫法無法解析時
 */
function resolveHost(env = process.env) {
    let raw = String(env.OLLAMA_HOST ?? '').trim() || DEFAULT_HOST;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    if (!hasScheme && raw.startsWith(':')) raw = `127.0.0.1${raw}`;
    let url;
    try {
        url = new URL(hasScheme ? raw : `http://${raw}`);
    } catch (err) {
        throw new Error(`OLLAMA_HOST「${raw}」不是合法的網址或 host:port（例：http://127.0.0.1:11434）。`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`OLLAMA_HOST「${raw}」只接受 http:// 或 https://。`);
    }
    if (!hasScheme && !url.port) url.port = DEFAULT_PORT;

    let hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === '0.0.0.0') {
        url.hostname = '127.0.0.1';
        hostname = '127.0.0.1';
    } else if (hostname === '::') {
        url.hostname = '[::1]';
        hostname = '::1';
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    return { url: `${url.origin}${pathname}`, hostname, local: LOCAL_HOSTNAMES.includes(hostname) };
}

let warnedHost = false;

/**
 * OLLAMA_HOST 不是本機時印一次警告（第 2 條、原則 1）。不中止：區網內另一台電腦跑 Ollama 是合理用法，
 * 只是那就不是「零外連」了，Owner 要知道。services/llm/index.js 載入時呼叫一次（伺服器與 worker 啟動時都會載入它），
 * 第一次真的呼叫 Ollama 前也會再檢查一次（同一行程只印一次）。
 * @param {object} [env]
 * @returns {boolean} 這次有沒有印警告
 */
function warnIfRemoteHost(env = process.env) {
    if (warnedHost) return false;
    const raw = String(env.OLLAMA_HOST ?? '').trim();
    if (!raw) return false;                 // 沒設＝預設的 127.0.0.1
    let info;
    try {
        info = resolveHost(env);
    } catch (err) {
        warnedHost = true;
        console.warn(`[ollama] ${err.message}`);
        return true;
    }
    if (info.local) return false;
    warnedHost = true;
    console.warn(
        `[ollama] OLLAMA_HOST=${raw} 不是本機（只允許 localhost／127.0.0.1／::1）：本機模式的推論會送到「${info.hostname}」，` +
        '不再是「執行期零外連」（docs/local-mode.md 第 1 條）。若是刻意的（例如區網內另一台電腦跑 Ollama）可忽略此警告。'
    );
    return true;
}

function timeoutMs(env = process.env) {
    return positiveInt(env.OLLAMA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function numCtx(env = process.env) {
    return positiveInt(env.OLLAMA_NUM_CTX, DEFAULT_NUM_CTX);
}

/**
 * 串流進度的間隔（毫秒）：OLLAMA_PROGRESS_MS 是正整數才開，否則 0（不串流，與之前相同）。
 * @param {object} [env]
 * @returns {number}
 */
function progressIntervalMs(env = process.env) {
    return positiveInt(env.OLLAMA_PROGRESS_MS, DEFAULT_PROGRESS_MS);
}

/**
 * keep_alive：'10m' 這類時間字串原樣送；純數字（'600'、'-1'、'0'）轉成數字（秒）——
 * Ollama 把字串一律當 Go 的 duration 解析，'600' 沒有單位會回 400。
 */
function keepAlive(env = process.env) {
    const raw = String(env.OLLAMA_KEEP_ALIVE ?? '').trim();
    if (!raw) return DEFAULT_KEEP_ALIVE;
    return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

// ───────────────────────── 錯誤 ─────────────────────────

function tagged(message, errorClass, extra = {}) {
    return Object.assign(new Error(message), { errorClass }, extra);
}

/** 連線層的失敗 → timeout（被中止或逾時）或 provider_error（連不上） */
function transportError(err, { signal, timer, limitMs, limitName = ' OLLAMA_TIMEOUT_MS', target, label }) {
    if (signal && signal.aborted) return tagged(`Ollama 呼叫已被中止（節點逾時）：${label}`, 'timeout', { cause: err });
    if (timer.aborted) {
        return tagged(`Ollama 呼叫超過${limitName}（${limitMs} ms）仍未完成：${label}`, 'timeout', { cause: err });
    }
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return tagged(`Ollama 呼叫已被中止：${label}`, 'timeout', { cause: err });
    const code = err?.code || err?.cause?.code;
    const detail = code ? `${code}` : String(err?.message || err);
    return tagged(`Ollama 沒有在執行，請先開啟 Ollama（連不上 ${target.url}：${detail}）。`, 'provider_error', { cause: err });
}

/** 非 2xx 的回應 → provider_error；模型沒下載時訊息附上 ollama pull 指令 */
function responseError(status, text, { model, pathname }) {
    let msg = String(text ?? '').trim();
    try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed.error === 'string') msg = parsed.error;
    } catch (err) {
        // 不是 JSON 就用原文
    }
    msg = msg.slice(0, 500);
    if (status === 404 && /model/i.test(msg) && /not found|pull/i.test(msg)) {
        return tagged(`Ollama 找不到模型「${model}」，請先執行：ollama pull ${model}（${msg}）`, 'provider_error', { status });
    }
    if (status === 404) {
        return tagged(`Ollama 不認得 ${pathname}（HTTP 404：${msg || '空的回應'}），請把 Ollama 更新到最新版。`, 'provider_error', { status });
    }
    return tagged(`Ollama 回報錯誤（HTTP ${status}）：${msg || '空的回應'}`, 'provider_error', { status });
}

// ───────────────────────── 傳輸 ─────────────────────────

/**
 * 一次 POST（node:http／node:https；見檔頭「不用 fetch」的理由）。
 * @param {string} urlString
 * @param {object} payload 會 JSON.stringify
 * @param {{signal?:AbortSignal, onData?:(chunk:string)=>void}} opts
 *        onData：〔串流進度〕每收到一段回應就呼叫一次（UTF-8 字串；一段不一定是完整的一行）。
 *        回傳值照舊是整段本文，呼叫端最後仍以整段組結果——onData 只拿來印進度。
 * @returns {Promise<{status:number, text:string}>}
 */
function httpPostJson(urlString, payload, { signal, onData } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const mod = url.protocol === 'https:' ? https : http;
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        let settled = false;
        const done = (fn, v) => {
            if (settled) return;
            settled = true;
            fn(v);
        };
        const req = mod.request(url, {
            method: 'POST',
            agent: false,
            signal,
            headers: { 'content-type': 'application/json', 'content-length': body.length }
        }, (res) => {
            const chunks = [];
            // 多位元組字元可能被切在兩段之間：進度用的字串走 StringDecoder，整段本文照舊最後一次解碼
            const decoder = onData ? new (require('string_decoder').StringDecoder)('utf8') : null;
            res.on('data', (c) => {
                chunks.push(c);
                if (decoder) {
                    try { onData(decoder.write(c)); } catch (_) { /* 進度只是 log，壞了不影響結果 */ }
                }
            });
            res.on('end', () => done(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', (err) => done(reject, err));
            res.on('close', () => done(reject, Object.assign(new Error('連線在回應傳完之前中斷'), { code: 'ECONNRESET' })));
        });
        req.on('error', (err) => done(reject, err));
        req.end(body);
    });
}

/** @type {(url:string, payload:object, opts:{signal?:AbortSignal, onData?:Function}) => Promise<{status:number, text:string}>} */
let transport = httpPostJson;

/**
 * 呼叫一個 API：排 throttle 的 ollama 桶 → POST → 檢查狀態碼 → 解析外層 JSON。
 * 逾時（OLLAMA_TIMEOUT_MS）從拿到併發槽之後起算：排隊等前一個呼叫跑完的時間不算在這一次頭上
 *（排隊本身仍受呼叫端的 signal 約束，見 throttle.acquire 的 signal）。
 * 〔串流進度〕opts.onStart：拿到併發槽、開始計時的那一刻呼叫；opts.onData：交給傳輸層；
 * opts.parse：取代 JSON.parse（串流時組回單一回應物件）；opts.timeoutMs：取代 OLLAMA_TIMEOUT_MS。
 */
async function callApi(pathname, payload, { signal, model, label, onStart, onData, parse, timeoutMs: limitOverride }) {
    let target;
    try {
        target = resolveHost();
    } catch (err) {
        throw tagged(err.message, 'provider_error');
    }
    warnIfRemoteHost();
    const override = positiveInt(limitOverride, 0);
    const limitMs = override || timeoutMs();
    // 訊息原文（「超過 OLLAMA_TIMEOUT_MS（…）」）被 npm run perf:local 的逾時計數與單元測試比對，前面的空白要保留
    const limitName = override ? '這次指定的逾時' : ' OLLAMA_TIMEOUT_MS';

    const release = await throttle.acquire('ollama', { signal });
    // 逾時用一般的 setTimeout（finally 一定清掉），不用 AbortSignal.timeout：後者的計時器是 unref 的，
    // 行程裡若沒有別的 handle 撐著，事件迴圈會在逾時之前就先結束
    const timerCtl = new AbortController();
    const handle = setTimeout(() => {
        timerCtl.abort(Object.assign(new Error(`超過${limitName}（${limitMs} ms）`), { name: 'TimeoutError' }));
    }, limitMs);
    try {
        if (onStart) {
            try { onStart(); } catch (_) { /* 進度只是 log */ }
        }
        const timer = timerCtl.signal;
        const combined = signal ? AbortSignal.any([signal, timer]) : timer;
        let res;
        try {
            res = await transport(`${target.url}${pathname}`, payload, onData ? { signal: combined, onData } : { signal: combined });
        } catch (err) {
            throw transportError(err, { signal, timer, limitMs, limitName, target, label });
        }
        if (!(res.status >= 200 && res.status < 300)) throw responseError(res.status, res.text, { model, pathname });
        if (parse) return parse(res.text);
        try {
            return JSON.parse(res.text);
        } catch (err) {
            throw tagged(`Ollama 的回應不是 JSON（${pathname}）：${String(res.text).slice(0, 200)}`, 'provider_error');
        }
    } finally {
        clearTimeout(handle);
        release();
    }
}

// ───────────────────────── parts → messages ─────────────────────────

function unsupported(kind) {
    return tagged(
        `Ollama adapter 不收${kind}（本機模式：PDF 由 OCR＋視覺模型的本機路徑處理、語音在本機模式關閉）。`,
        'unsupported_input'
    );
}

/**
 * parts → 一則 user 訊息：{text} 依序以空行串起來；圖片（{imageBase64, mimeType:'image/*'} 或
 * {inlineData:{mimeType:'image/*', data}}）放進 images（base64）。PDF 與音訊一律丟 unsupported_input。
 * @returns {{role:'user', content:string, images?:string[]}}
 */
function toUserMessage(parts) {
    const texts = [];
    const images = [];
    for (const p of parts || []) {
        if (p && p.text !== undefined) {
            texts.push(String(p.text));
            continue;
        }
        if (p && (p.pdfBase64 !== undefined || p.fileUri !== undefined)) throw unsupported(' PDF');
        if (p && p.audioBase64 !== undefined) throw unsupported('音訊');
        if (p && (p.imageBase64 !== undefined || p.inlineData !== undefined)) {
            const mime = String((p.inlineData ? p.inlineData.mimeType : p.mimeType) ?? '').trim().toLowerCase();
            const data = p.inlineData ? p.inlineData.data : p.imageBase64;
            if (mime === 'application/pdf') throw unsupported(' PDF');
            if (mime.startsWith('audio/')) throw unsupported('音訊');
            if (!mime.startsWith('image/')) {
                throw tagged(`Ollama adapter 只收 image/* 的圖片，收到 mimeType「${mime || '未提供'}」。`, 'unsupported_input');
            }
            images.push(String(data ?? ''));
            continue;
        }
        throw new Error('generateJson／generateText：parts 只接受 {text} / {imageBase64, mimeType} / {inlineData:{mimeType, data}}（Ollama 不收 PDF 與音訊）');
    }
    const msg = { role: 'user', content: texts.join('\n\n') };
    if (images.length) msg.images = images;
    return msg;
}

// ───────────────────────── schema ─────────────────────────

/**
 * Gemini 專用欄位 → 標準 JSON Schema（深拷貝，不動原物件——agents/schemas 回傳的是深凍結的實例）。
 *   propertyOrdering：依它重排 properties（沒列到的照原順序接在後面），然後拿掉這個鍵
 *   nullable:true    ：type 補上 'null'（enum 也補 null）；nullable:false 直接拿掉
 * 其餘關鍵字原樣保留。
 * @param {object} schema
 * @returns {object}
 */
function toOllamaSchema(schema) {
    const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object') return node;
        const order = Array.isArray(node.propertyOrdering) ? node.propertyOrdering.map(String) : null;
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === 'propertyOrdering' || key === 'nullable') continue;
            if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
                const keys = Object.keys(value);
                const ordered = order
                    ? [...order.filter(k => keys.includes(k)), ...keys.filter(k => !order.includes(k))]
                    : keys;
                out.properties = {};
                for (const k of ordered) out.properties[k] = walk(value[k]);
                continue;
            }
            out[key] = walk(value);
        }
        if (node.nullable === true) {
            if (typeof out.type === 'string') out.type = [out.type, 'null'];
            else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
            if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
        }
        return out;
    };
    return walk(schema);
}

const TYPE_LABEL = { string: '字串', integer: '整數', number: '數字', boolean: '布林', object: '物件', null: 'null' };

function typeText(node) {
    if (!node || typeof node !== 'object') return '任意';
    const types = (Array.isArray(node.type) ? node.type : [node.type]).filter(Boolean);
    if (types.includes('array') || (!types.length && node.items)) {
        const inner = node.items && node.items.properties ? '物件' : typeText(node.items);
        return `${inner === '任意' ? '' : inner}陣列`;
    }
    return types.map(t => TYPE_LABEL[t] || t).join('或') || (node.properties ? '物件' : '任意');
}

function constraintTexts(node) {
    const bits = [];
    if (Array.isArray(node.enum)) {
        bits.push(node.enum.length <= ENUM_INLINE_MAX
            ? `只能是 ${node.enum.map(v => `「${v}」`).join('')}`
            : `${node.enum.length} 個合法值之一，必須完全相符`);
    }
    if (node.minimum !== undefined || node.maximum !== undefined) bits.push(`範圍 ${node.minimum ?? '−∞'}～${node.maximum ?? '∞'}`);
    if (node.minLength !== undefined) bits.push(`至少 ${node.minLength} 字`);
    if (node.maxLength !== undefined) bits.push(`最多 ${node.maxLength} 字`);
    if (node.minItems !== undefined || node.maxItems !== undefined) bits.push(`${node.minItems ?? 0}～${node.maxItems ?? '不限'} 個`);
    return bits;
}

/**
 * 把 schema 的欄位整理成一段給模型看的說明（見檔頭：Ollama 的模型看不到 schema 的 description）。
 * @param {object|undefined} schema  已轉換過的標準 JSON Schema
 * @returns {string}
 */
function schemaGuide(schema) {
    const head = '【輸出格式】只輸出一個 JSON 物件，不要 Markdown 圍欄、不要任何其他文字。';
    if (!schema || typeof schema !== 'object') return head;
    const lines = [];
    const walk = (node, prefix, depth) => {
        if (!node || typeof node !== 'object' || !node.properties) return;
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        for (const [key, child] of Object.entries(node.properties)) {
            if (!child || typeof child !== 'object') continue;
            const where = prefix ? `${prefix}.${key}` : key;
            const bits = [typeText(child), required.has(key) ? '必填' : '選填', ...constraintTexts(child)];
            const desc = typeof child.description === 'string' && child.description.trim() ? `：${child.description.trim()}` : '';
            lines.push(`${'  '.repeat(depth)}- ${where}（${bits.join('；')}）${desc}`);
            if (child.properties) walk(child, where, depth + 1);
            if (child.items && typeof child.items === 'object') {
                if (child.items.properties) {
                    walk(child.items, `${where}[]`, depth + 1);
                } else if (Array.isArray(child.items.enum) || child.items.description) {
                    const itemBits = [typeText(child.items), ...constraintTexts(child.items)];
                    const itemDesc = child.items.description ? `：${String(child.items.description).trim()}` : '';
                    lines.push(`${'  '.repeat(depth + 1)}- ${where}[] 的每個元素（${itemBits.join('；')}）${itemDesc}`);
                }
            }
        }
    };
    walk(schema, '', 0);
    if (!lines.length) return head;
    return `${head}欄位如下：\n${lines.join('\n')}`;
}

// ───────────────────────── 回應 ─────────────────────────

/** 有些模型（或舊版 Ollama）把思考過程寫在 content 開頭的 <think>…</think>；那不是回覆 */
function stripThink(text) {
    return String(text ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

/** 模型偶爾會用 ``` 圍起 JSON；剝掉再 parse（與 gemini.js 同一個規則） */
function parseJsonText(text) {
    let raw = stripThink(text).trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    if (!raw) throw new Error('Ollama 回了空字串（多半是 maxOutputTokens（num_predict）太小，思考把額度用完了）。');
    return JSON.parse(raw);
}

/** done_reason → 與 Gemini 同一套字：'length' → 'MAX_TOKENS'、'stop' → 'STOP'；沒有時 null */
function finishReasonOf(res) {
    const r = res?.done_reason;
    if (r === undefined || r === null || r === '') return null;
    if (r === 'length') return 'MAX_TOKENS';
    if (r === 'stop') return 'STOP';
    return String(r).toUpperCase();
}

/**
 * Ollama 回應的分段時間（奈秒）→ 毫秒（四捨五入到整數）。四個欄位都沒有時回 null。
 *   loadMs        載入模型（已在記憶體裡時接近 0）
 *   promptEvalMs  讀 prompt：系統提示詞、題目文字，**視覺模型的圖片也在這一段**（本機看圖拆題最慢的一段）
 *   evalMs        生成（含思考）；tokenOut ÷ evalMs 才是「純輸出速度」
 *   totalMs       Ollama 自己量的整段；latencyMs 比它多出來的是排隊與傳輸
 * @param {object} res
 * @returns {{totalMs:number|null, loadMs:number|null, promptEvalMs:number|null, evalMs:number|null}|null}
 */
function timingOf(res) {
    const ms = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n / NS_PER_MS) : null;
    };
    const t = {
        totalMs: ms(res?.total_duration),
        loadMs: ms(res?.load_duration),
        promptEvalMs: ms(res?.prompt_eval_duration),
        evalMs: ms(res?.eval_duration)
    };
    return Object.values(t).some(v => v !== null) ? t : null;
}

/**
 * 第 3 條第 2 點：tokenIn＝prompt_eval_count、tokenOut＝eval_count（含思考）、其餘恆 0。
 * 〔看圖拆題逾時〕回應帶分段時間時多一個 timing（見 timingOf）；沒帶就與之前逐位元相同。
 */
function usageOf(res) {
    const usage = {
        tokenIn: Number(res?.prompt_eval_count) || 0,
        tokenOut: Number(res?.eval_count) || 0,
        tokenThinking: 0,
        tokenCached: 0
    };
    const timing = timingOf(res);
    if (timing) usage.timing = timing;
    return usage;
}

// ───────────────────────── 串流（〔看圖拆題逾時〕進度） ─────────────────────────

/**
 * stream:true 的整段本文（NDJSON，一行一個物件）→ 與 stream:false 相同形狀的回應物件。
 * 規則：各行 message.content 依序接起來、message.thinking 依序接起來（有思考才留這個鍵），
 * 其餘欄位（done_reason、*_count、*_duration、model、created_at）取 done:true 那一行。
 * @param {string} text
 * @param {{pathname?:string}} [opts]
 * @returns {object}
 * @throws  provider_error：某一行不是 JSON、串流中途回報 error、沒有 done:true 那一行（連線提早結束）
 */
function assembleStream(text, { pathname = '/api/chat' } = {}) {
    let content = '';
    let thinking = '';
    let done = null;
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch (err) {
            throw tagged(`Ollama 的串流回應有一行不是 JSON（${pathname}）：${line.slice(0, 200)}`, 'provider_error');
        }
        if (obj && typeof obj.error === 'string') {
            throw tagged(`Ollama 回報錯誤（串流中）：${obj.error.slice(0, 500)}`, 'provider_error');
        }
        const m = obj && obj.message;
        if (m && typeof m.content === 'string') content += m.content;
        if (m && typeof m.thinking === 'string') thinking += m.thinking;
        if (obj && obj.done === true) done = obj;
    }
    if (!done) throw tagged(`Ollama 的串流在完成之前就中斷了（${pathname}，沒有 done:true）`, 'provider_error');
    const message = { ...(done.message || {}), role: (done.message && done.message.role) || 'assistant', content };
    if (thinking) message.thinking = thinking; else delete message.thinking;
    return { ...done, message };
}

/** 毫秒 → 「12 秒」「3 分 5 秒」「1 小時 20 分」（進度 log 用） */
function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    if (s < 60) return `${s} 秒`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
    return sec ? `${m} 分 ${sec} 秒` : `${m} 分`;
}

/** token／秒（一位小數）；分母是 0 時回 '—' */
function fmtRate(tokens, ms) {
    return ms > 0 ? (tokens / (ms / 1000)).toFixed(1) : '—';
}

/**
 * 串流進度的記帳與文字（純邏輯；計時器由 chatStream 負責，時間可注入，單元測試不必真的等）。
 * 一個串流片段（一行、帶非空的 content 或 thinking）大約就是一個 token；最後的精確數字以 eval_count 為準。
 * @param {{label:string, log:(line:string)=>void, now?:()=>number}} opts
 */
function createProgressReporter({ label, log, now = Date.now }) {
    const prefix = `[ollama] ${label}`;
    const createdAt = now();
    const st = { startedAt: null, firstAt: null, lastAt: null, tokens: 0, buf: '', lastTickAt: null, lastTickTokens: 0 };
    const emit = (line) => { try { log(line); } catch (_) { /* 進度只是 log */ } };

    function start() {
        if (st.startedAt === null) st.startedAt = now();
        st.lastTickAt = st.startedAt;
    }

    function onData(chunk) {
        st.buf += String(chunk ?? '');
        let idx;
        while ((idx = st.buf.indexOf('\n')) !== -1) {
            const line = st.buf.slice(0, idx).trim();
            st.buf = st.buf.slice(idx + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch (_) { continue; }   // 壞行由 assembleStream 處理
            const m = obj && obj.message;
            if (m && ((typeof m.content === 'string' && m.content) || (typeof m.thinking === 'string' && m.thinking))) {
                const t = now();
                st.tokens += 1;
                st.lastAt = t;
                if (st.firstAt === null) st.firstAt = t;
            }
        }
    }

    /** 每隔一段時間印一行；回傳印出的那一行（測試用） */
    function tick() {
        const t = now();
        let line;
        if (st.startedAt === null) {
            line = `${prefix} 排隊中：等前一個 Ollama 呼叫跑完（OLLAMA_CONCURRENCY），已等 ${fmtElapsed(t - createdAt)}`;
        } else if (st.tokens === 0) {
            line = `${prefix} 已 ${fmtElapsed(t - st.startedAt)}：還沒輸出第一個 token——載入模型、讀 prompt（看圖）中；` +
                '這一段 Ollama 不回報進度，要多久可用 npm run local:bench-vision 先量';
        } else {
            const since = t - (st.lastTickAt ?? st.startedAt);
            const gained = st.tokens - st.lastTickTokens;
            const head = `${prefix} 已 ${fmtElapsed(t - st.startedAt)}：已輸出 ${st.tokens} token（第一個 token 在第 ${fmtElapsed(st.firstAt - st.startedAt)}）`;
            line = gained > 0
                ? `${head}；最近 ${fmtElapsed(since)} 多了 ${gained} token，約 ${fmtRate(gained, since)} token/秒`
                : `${head}；已經 ${fmtElapsed(t - st.lastAt)} 沒有新 token——持續不動的話可能卡住（看工作管理員裡 Ollama 的 CPU 使用率）`;
        }
        st.lastTickAt = t;
        st.lastTickTokens = st.tokens;
        emit(line);
        return line;
    }

    /** 成功：印分段時間（Ollama 自己量的）與牆鐘 */
    function finish(res) {
        const t = now();
        const tm = timingOf(res) || {};
        const u = usageOf(res);
        const sec = (ms) => (ms === null || ms === undefined ? '—' : fmtElapsed(ms));
        const line = `${prefix} 完成：載入模型 ${sec(tm.loadMs)}；讀 prompt ${u.tokenIn} token 用 ${sec(tm.promptEvalMs)}` +
            `（${fmtRate(u.tokenIn, tm.promptEvalMs)} token/秒）；輸出 ${u.tokenOut} token 用 ${sec(tm.evalMs)}` +
            `（${fmtRate(u.tokenOut, tm.evalMs)} token/秒）；牆鐘 ${fmtElapsed(t - (st.startedAt ?? createdAt))}`;
        emit(line);
        return line;
    }

    function fail(err) {
        const t = now();
        const line = `${prefix} 失敗（${(err && err.errorClass) || 'error'}）：已 ${fmtElapsed(t - (st.startedAt ?? createdAt))}、` +
            `已輸出 ${st.tokens} token——${String((err && err.message) || err).split('\n')[0].slice(0, 200)}`;
        emit(line);
        return line;
    }

    return { start, onData, tick, finish, fail, state: st };
}

/**
 * 串流版的 /api/chat：送 stream:true，邊收邊記進度，每 intervalMs 印一行；收完用 assembleStream 組回與 stream:false 相同的物件。
 * @param {object} body  chatBody() 的結果（stream:false 會被換成 true，其餘逐位元相同）
 * @param {{signal?:AbortSignal, label:string, timeoutMs?:number, progress:{intervalMs:number, log:Function}}} opts
 */
async function chatStream(body, { signal, label, timeoutMs: limit, progress }) {
    const reporter = createProgressReporter({ label, log: progress.log });
    const handle = setInterval(() => reporter.tick(), progress.intervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    try {
        const res = await callApi('/api/chat', { ...body, stream: true }, {
            signal, model: body.model, label, timeoutMs: limit,
            onStart: () => reporter.start(),
            onData: (chunk) => reporter.onData(chunk),
            parse: (text) => assembleStream(text, { pathname: '/api/chat' })
        });
        reporter.finish(res);
        return res;
    } catch (err) {
        reporter.fail(err);
        throw err;
    } finally {
        clearInterval(handle);
    }
}

/**
 * 這一次呼叫要不要串流進度：呼叫端帶了 progressMs 就照它（0＝不要），沒帶就看 OLLAMA_PROGRESS_MS。
 * @returns {{intervalMs:number, log:Function}|null}
 */
function resolveProgress(progressMs, onProgress) {
    const intervalMs = progressMs === undefined || progressMs === null
        ? progressIntervalMs()
        : positiveInt(progressMs, 0);
    if (!(intervalMs > 0)) return null;
    return { intervalMs, log: typeof onProgress === 'function' ? onProgress : (line) => console.log(line) };
}

// ───────────────────────── /api/chat ─────────────────────────

function chatBody({ model, system, parts, maxOutputTokens, thinkingBudget }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push(toUserMessage(parts));
    const options = { temperature: 0, num_ctx: numCtx() };
    if (maxOutputTokens) options.num_predict = maxOutputTokens;
    return {
        model,
        messages,
        stream: false,
        options,
        keep_alive: keepAlive(),
        think: Number(thinkingBudget) > 0
    };
}

/**
 * POST /api/chat；模型不支援思考（400）時拿掉 think 重送一次。
 * 〔看圖拆題逾時〕progress 不是 null 時走串流（chatStream），組回來的物件與 stream:false 相同。
 */
async function chat(body, { signal, label, timeoutMs: limit, progress = null }) {
    const send = (b, l) => (progress
        ? chatStream(b, { signal, label: l, timeoutMs: limit, progress })
        : callApi('/api/chat', b, { signal, model: b.model, label: l, timeoutMs: limit }));
    try {
        return await send(body, label);
    } catch (err) {
        if (body.think === true && err.status === 400 && /does not support thinking/i.test(err.message)) {
            const { think, ...rest } = body;
            return send(rest, `${label}（不思考）`);
        }
        throw err;
    }
}

/**
 * 受限 JSON 生成（第 3 條第 2 點）。
 * @param {{model:string, system?:string, parts:Array<object>, schema?:object,
 *          maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal,
 *          progressMs?:number, onProgress?:(line:string)=>void, timeoutMs?:number}} opts
 *        model 必須是**裸 ID**（qwen3:8b；vendor 前綴由 services/llm/index.js 剝掉）
 *        progressMs／onProgress／timeoutMs：〔看圖拆題逾時〕見檔頭；agent 不帶（progressMs 沒帶時看 OLLAMA_PROGRESS_MS）
 * @returns {Promise<{data:object, usage:{tokenIn,tokenOut,tokenThinking,tokenCached,timing?},
 *                    latencyMs:number, raw:any, schemaFallback:false}>}
 */
async function generateJson({ model, system, parts, schema, maxOutputTokens, thinkingBudget, signal, progressMs, onProgress, timeoutMs: limit }) {
    const startedAt = Date.now();
    const format = schema ? toOllamaSchema(schema) : 'json';
    const guide = schemaGuide(schema ? format : undefined);
    const body = chatBody({
        model,
        system: system ? `${system}\n\n${guide}` : guide,
        parts, maxOutputTokens, thinkingBudget
    });
    body.format = format;

    const res = await chat(body, { signal, label: `/api/chat(${model})`, timeoutMs: limit, progress: resolveProgress(progressMs, onProgress) });
    const usage = usageOf(res);
    let data;
    try {
        data = parseJsonText(res?.message?.content);
    } catch (err) {
        // 與 gemini.js 相同：JSON 壞掉是模型輸出的問題（schema_invalid），用量照樣帶出去讓呼叫端記帳
        err.errorClass = 'schema_invalid';
        err.usage = usage;
        err.finishReason = finishReasonOf(res);
        throw err;
    }
    return { data, usage, latencyMs: Date.now() - startedAt, raw: res, schemaFallback: false };
}

/**
 * 自由文字生成（第 3 條第 3 點）。tools.codeExecution 直接忽略（Ollama 沒有程式執行環境），codeRuns 恆為 []。
 * @param {{model:string, system?:string, parts:Array<object>, tools?:{codeExecution?:boolean},
 *          maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal,
 *          progressMs?:number, onProgress?:(line:string)=>void, timeoutMs?:number}} opts
 * @returns {Promise<{text:string, codeRuns:[], finishReason:string|null,
 *                    usage:{tokenIn,tokenOut,tokenThinking,tokenCached,timing?}, latencyMs:number, raw:any}>}
 */
async function generateText({ model, system, parts, maxOutputTokens, thinkingBudget, signal, progressMs, onProgress, timeoutMs: limit }) {
    const startedAt = Date.now();
    const body = chatBody({ model, system, parts, maxOutputTokens, thinkingBudget });
    const res = await chat(body, { signal, label: `/api/chat(${model}, text)`, timeoutMs: limit, progress: resolveProgress(progressMs, onProgress) });
    return {
        text: stripThink(res?.message?.content),
        codeRuns: [],
        finishReason: finishReasonOf(res),
        usage: usageOf(res),
        latencyMs: Date.now() - startedAt,
        raw: res
    };
}

// ───────────────────────── /api/embed ─────────────────────────

/**
 * 取得向量（第 3 條第 4 點；未正規化，L2 正規化由 services/llm/index.js 統一做）。
 * 送 dimensions:dim（Qwen3-Embedding 支援 MRL 自訂維度）；回傳維度比 dim 長就截前 dim 維（舊版 Ollama 不認 dimensions 時），
 * 比 dim 短就丟錯（補零會做出一個不存在的向量）。
 * @param {{model:string, texts:string[], dim:number}} opts  model 是裸 ID
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embed({ model, texts, dim }) {
    const res = await callApi('/api/embed', { model, input: texts, dimensions: dim, truncate: true },
        { model, label: `/api/embed(${model}, ${texts.length} 筆)` });
    const embeddings = res?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw tagged(`Ollama 回傳 ${Array.isArray(embeddings) ? embeddings.length : 0} 個向量，與送出的 ${texts.length} 筆不符。`, 'provider_error');
    }
    const vectors = embeddings.map((v, i) => {
        if (!Array.isArray(v)) throw tagged(`Ollama 回傳第 ${i} 個向量不是陣列。`, 'provider_error');
        if (v.length < dim) {
            throw tagged(`Ollama 回傳第 ${i} 個向量只有 ${v.length} 維，少於 EMBED_DIM=${dim}（請換輸出維度夠大的 embedding 模型；資料庫欄位是 vector(${dim})）。`, 'provider_error');
        }
        return v.length === dim ? v : v.slice(0, dim);
    });
    return { vectors, usage: { tokenIn: Number(res?.prompt_eval_count) || 0 } };
}

/**
 * 〔看圖拆題逾時〕把模型從 Ollama 的記憶體卸載（POST /api/generate {model, keep_alive:0}；Ollama 官方的卸載寫法）。
 * 只給本機量測工具（eval/tools/local_bench_vision.js）用：先卸載，量到的時間才含模型載入、也不會用到上一次的快取，
 * 與正式拆題時每一塊都要重新載入視覺模型的情況相同。
 * @param {{model:string, timeoutMs?:number}} opts  model 是裸 ID
 * @returns {Promise<object>} Ollama 的回應（done_reason:'unload'）
 */
async function unloadModel({ model, timeoutMs: limit } = {}) {
    return callApi('/api/generate', { model, keep_alive: 0 }, { model, label: `/api/generate(${model}, 卸載)`, timeoutMs: limit });
}

// ───────────────────────── 測試用 ─────────────────────────

/** 測試用：注入假的傳輸（(url, payload, {signal, onData?}) => Promise<{status, text}>）。傳 null 換回 node:http。 */
function _setTransportForTest(fn) {
    transport = fn || httpPostJson;
}

/** 測試用：清掉「OLLAMA_HOST 已警告過」的記憶 */
function _resetForTest() {
    warnedHost = false;
    transport = httpPostJson;
}

module.exports = {
    generateJson, generateText, embed, unloadModel,
    resolveHost, warnIfRemoteHost, toOllamaSchema, schemaGuide, toUserMessage, parseJsonText,
    finishReasonOf, usageOf, timingOf, keepAlive, httpPostJson, timeoutMs, numCtx,
    assembleStream, createProgressReporter, progressIntervalMs, fmtElapsed,
    DEFAULT_HOST, DEFAULT_TIMEOUT_MS, DEFAULT_NUM_CTX, DEFAULT_KEEP_ALIVE, DEFAULT_PROGRESS_MS, LOCAL_HOSTNAMES,
    _setTransportForTest, _resetForTest
};
