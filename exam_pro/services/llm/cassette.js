// services/llm/cassette.js — cassette 的鍵、路徑與檔案格式（docs/interfaces-stage2.md 第 5.2 條）
//
// 鍵（逐字凍結）：
//     key = sha256( agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n'
//                 + JSON.stringify(cacheKeyParts) )
//   - modelId 是**去掉 vendor 前綴**的裸 ID（gemini-3.5-flash）
//   - promptTemplateHash = sha256(模板原文)，見 services/llm/templates.js
//   - schemaHash = sha256(JSON.stringify(schema))——章節白名單改了 cassette 就該失效，這是刻意的
//   - cacheKeyParts 由 agent 傳，逐節點的最小集合見第 5.2 條
//
// ⚠ JSON.stringify 依「插入順序」序列化，所以 agent 每次都要以**相同的鍵順序**組
//   cacheKeyParts（本檔不排序，因為第 5.2 條的公式凍結為 JSON.stringify 原樣）。
//
// 檔案：<EVAL_CASSETTE_DIR>/<agent>/<key>.json，預設 EVAL_CASSETTE_DIR=eval/cassettes。
// request 只存**摘要**（字數 + sha256），不存 PDF base64、不存試題全文——NOTICE 第 4 條。
//
// 〔dec/r9-record-tooling〕錯誤回放檔（docs/local-mode.md 10.23）：錄製時 live 呼叫「被截斷」或「單次逾時」，
// 照樣寫一支回放檔，response 只有 { error:{kind,name,message,errorClass,finishReason[,elapsedMs]}, usage?, latencyMs? }，
// 回放（services/llm/fake.js）丟出與 live 相同形狀的錯。鍵、檔名、meta、request 與一般回放檔完全相同（同一條公式）；
// 判斷準則見 errorCassetteKind。連不上、401 這類環境錯誤不錄。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { templateHash, sha256Hex } = require('./templates');

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', 'eval', 'cassettes');

/** cassette 根目錄（EVAL_CASSETTE_DIR 可覆寫；相對路徑以 exam_pro/ 為基準） */
function cassetteDir() {
    const raw = process.env.EVAL_CASSETTE_DIR;
    if (!raw || !String(raw).trim()) return DEFAULT_DIR;
    // 路徑可能含中文（期中專案-wsB），一律 path.resolve 成絕對路徑再用
    return path.resolve(__dirname, '..', '..', String(raw).trim());
}

/**
 * 算 cassette 鍵。
 * @param {{agent:string, modelId:string, template?:string, schema?:object, cacheKeyParts?:object}} opts
 * @returns {string} sha256 hex
 */
function cassetteKey({ agent, modelId, template, schema, cacheKeyParts }) {
    if (!agent || !String(agent).trim()) {
        throw new Error('cassette：record／replay 模式下 generateJson 的 agent 是必填（第 5.1 條）。');
    }
    const schemaHash = sha256Hex(schema ? JSON.stringify(schema) : '');
    const parts = [
        String(agent),
        String(modelId || ''),
        templateHash(template),
        schemaHash,
        JSON.stringify(cacheKeyParts ?? {})
    ].join('\n');
    return sha256Hex(parts);
}

/** <dir>/<agent>/<key>.json 的絕對路徑 */
function cassettePath(agent, key) {
    return path.join(cassetteDir(), String(agent), `${key}.json`);
}

/**
 * 公開 fixture 題庫的雜湊，寫進 meta.fixtureHash。
 * few-shot 的內容變了但 id 沒變時，鍵不會變（第 5.2 條刻意如此），
 * 靠這個欄位在回放時印 warning 提醒「cassette 可能過期」。
 * @returns {string|null} 找不到 fixture 檔時回 null（不是錯誤：不是每個 agent 都用 fixture）
 */
function fixtureHash() {
    const file = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json');
    try {
        return sha256Hex(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return null;
    }
}

/**
 * 把 parts 壓成不含內容的摘要。
 * text → {kind:'text', chars, sha256}；PDF → {kind:'pdf', bytes, sha256}（sha256 算在 base64 解碼後的原始位元組上）
 * 音訊／圖片（階段 5）→ {kind:'audio'|'image', mimeType, bytes, sha256}
 */
function summarizeParts(parts) {
    return (parts || []).map((p) => {
        if (p.text !== undefined) {
            const text = String(p.text);
            return { kind: 'text', chars: text.length, sha256: sha256Hex(text) };
        }
        if (p.pdfBase64 !== undefined) {
            const buf = Buffer.from(String(p.pdfBase64), 'base64');
            return { kind: 'pdf', bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
        }
        if (p.fileUri !== undefined) return { kind: 'fileUri', uri: String(p.fileUri) };
        // 階段 5 WS-E：音訊與圖片同樣只留位元組數與 sha256（錄音內容絕不進版控）
        if (p.audioBase64 !== undefined || p.imageBase64 !== undefined) {
            const isAudio = p.audioBase64 !== undefined;
            const buf = Buffer.from(String(isAudio ? p.audioBase64 : p.imageBase64), 'base64');
            return {
                kind: isAudio ? 'audio' : 'image',
                mimeType: String(p.mimeType ?? ''),
                bytes: buf.length,
                sha256: crypto.createHash('sha256').update(buf).digest('hex')
            };
        }
        return { kind: 'unknown' };
    });
}

/**
 * 讀一支 cassette。
 * @returns {object|null} 檔案不存在回 null；格式壞掉丟錯（壞檔要修，不能當成 miss 靜默重錄）
 */
function readCassette(agent, key) {
    const file = cassettePath(agent, key);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`cassette 格式錯誤（不是合法 JSON）：${file}\n${err.message}`);
    }
}

/**
 * 寫一支 cassette（record 模式）。已存在同鍵檔案時覆寫並回傳 { file, overwritten }。
 * 一律由 Node 寫檔、UTF-8、結尾一個換行（PowerShell 的 > 會寫成 UTF-16LE + BOM）。
 */
function writeCassette({ agent, key, meta, request, response }) {
    const file = cassettePath(agent, key);
    const overwritten = fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { meta, request, response };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    return { file, overwritten };
}

// ───────────────────────── 錯誤回放檔（〔dec/r9-record-tooling〕docs/local-mode.md 10.23）─────────────────────────

/** 會錄成錯誤回放檔的兩種錯誤 */
const ERROR_CASSETTE_KINDS = Object.freeze(['truncated', 'timeout']);
/** 錯誤訊息最多存幾個字（回放時丟出的訊息就是這一段；實際的訊息都遠短於此） */
const ERROR_MESSAGE_MAX = 2000;

/**
 * 錄製時 live 呼叫丟出的錯誤，要不要錄成錯誤回放檔。純函式。
 *
 * 錄（模型本身的結果：同樣的輸入、同樣的設定再跑一次，多半還是一樣）：
 *   'truncated'：錯誤帶 finishReason === 'MAX_TOKENS'——回應寫到輸出上限被截斷（Ollama 的 done_reason=length、
 *                Gemini 的 MAX_TOKENS），adapter 因此解析不出 JSON（寫到一半、或思考把額度用光只剩空字串）。
 *                兩個 adapter 只在「模型已經回應、JSON 解析失敗」時把 finishReason 掛在錯誤上（services/llm/ollama.js、gemini.js）。
 *   'timeout'  ：errorClass === 'timeout'、timedOut === true、呼叫端的 signal 沒有被中止、vendor 是 ollama——
 *                也就是 adapter 自己的單次逾時（OLLAMA_TIMEOUT_MS 或呼叫端帶的 timeoutMs）到了，模型一直在生成、沒寫完。
 *                〔審查 dec/r9-record-tooling〕timedOut 由 services/llm/ollama.js 的 transportError 只在「自己的計時器已中止」
 *                那一支掛上；同樣是 'timeout' 但計時器沒到的（AbortError／TimeoutError、兩個 signal 都沒中止）不錄。
 *                注意：計時器到了也可能是環境造成的（錄製期間電腦睡眠、Ollama 卡住沒斷線），程式分不出來，
 *                所以錄完要照 docs/local-mode.md 10.23 第 5 點第 4 步人工確認。
 * 不錄（環境錯誤，換個時間或修好環境再跑就會不同）：
 *   - errorClass 'provider_error'（Ollama 沒開、連線被切斷、HTTP 4xx／5xx、401／403、找不到模型、串流中斷）、
 *     'rate_limited'、'unsupported_input'、沒有 errorClass 的錯；
 *   - 呼叫端 signal 中止的 timeout（節點逾時 JOB_NODE_TIMEOUT_MS、「現在放棄」、關機）——那是流程的決定，不是這一次呼叫的結果；
 *   - Gemini 的 timeout（SDK 的連線逾時或中止，屬網路狀況）；
 *   - schema_invalid 但 finishReason 不是 MAX_TOKENS（模型寫壞了 JSON 卻沒被截斷；不在這一版的範圍，照舊是 miss）。
 * @param {Error|any} err
 * @param {{signal?:AbortSignal|null, vendor?:string}} [opts] signal：呼叫端傳給 generateJson／generateText 的那一個
 * @returns {'truncated'|'timeout'|null}
 */
function errorCassetteKind(err, { signal, vendor } = {}) {
    if (!err || typeof err !== 'object') return null;
    if (String(err.finishReason ?? '') === 'MAX_TOKENS') return 'truncated';
    if (err.errorClass === 'timeout' && err.timedOut === true && !(signal && signal.aborted) && vendor === 'ollama') return 'timeout';
    return null;
}

/**
 * 錯誤回放檔的 response。只存 agent／狀態機／eval 會讀的欄位，不存任何新的試題內容：
 *   error.name／message（前 ERROR_MESSAGE_MAX 字）／errorClass／finishReason——agent 依 message 與 errorClass 分類、
 *   runner 依 finishReason 決定 C-f 的 output_truncated；
 *   truncated：usage（adapter 掛在錯誤上的用量，含 Ollama 的 timing）與 latencyMs——這一次呼叫真的跑完了，速度資料有效；
 *   timeout  ：沒有 usage；花掉的時間記在 error.elapsedMs 而**不是** latencyMs（npm run perf:local 讀 latencyMs 算速度，
 *              逾時的時間只代表上限，不是速度）。
 * @param {Error|any} err
 * @param {'truncated'|'timeout'} kind
 * @param {{elapsedMs?:number}} [opts]
 * @returns {object}
 */
function errorResponse(err, kind, { elapsedMs } = {}) {
    if (!ERROR_CASSETTE_KINDS.includes(kind)) throw new Error(`cassette：錯誤回放檔的 kind 只能是 ${ERROR_CASSETTE_KINDS.join('／')}，收到「${kind}」`);
    const error = {
        kind,
        name: String((err && err.name) || 'Error'),
        message: String((err && err.message) ?? '').slice(0, ERROR_MESSAGE_MAX),
        errorClass: err && err.errorClass !== undefined ? err.errorClass : null,
        finishReason: err && err.finishReason !== undefined && err.finishReason !== null ? String(err.finishReason) : null
    };
    const ms = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null;
    if (kind === 'timeout') {
        if (ms !== null) error.elapsedMs = ms;
        return { error };
    }
    return { error, usage: (err && err.usage) || null, latencyMs: ms };
}

/**
 * 這支回放檔是不是錯誤回放檔（response.error 是物件）。
 * @param {object|null} doc readCassette() 的回傳
 * @returns {boolean}
 */
function isErrorCassette(doc) {
    const e = doc && doc.response && doc.response.error;
    return Boolean(e && typeof e === 'object' && !Array.isArray(e));
}

/**
 * 這個行程裡讀到（回放）或寫下（錄製）的錯誤回放檔，給 eval 報表列出來（eval/lib/report2.js）。
 * 同一支（agent/key）只記一次。
 */
const errorCassetteLog = new Map();

/**
 * @param {{agent:string, key:string, kind:string, errorClass?:string|null, finishReason?:string|null, source:'replay'|'record'}} entry
 */
function noteErrorCassette(entry) {
    const id = `${entry.agent}/${entry.key}`;
    if (!errorCassetteLog.has(id)) {
        errorCassetteLog.set(id, {
            agent: String(entry.agent), key: String(entry.key), kind: entry.kind ?? null,
            errorClass: entry.errorClass ?? null, finishReason: entry.finishReason ?? null, source: entry.source
        });
    }
}

/** @returns {Array<{agent:string, key:string, kind:string, errorClass:string|null, finishReason:string|null, source:string}>} 依 agent、key 排序 */
function errorCassettesSeen() {
    return [...errorCassetteLog.values()].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}

/** 測試用：清掉這個行程的紀錄 */
function _resetErrorCassettesForTest() {
    errorCassetteLog.clear();
}

module.exports = {
    cassetteKey, cassettePath, cassetteDir, readCassette, writeCassette,
    summarizeParts, fixtureHash, sha256Hex,
    // 〔dec/r9-record-tooling〕錯誤回放檔
    ERROR_CASSETTE_KINDS, ERROR_MESSAGE_MAX, errorCassetteKind, errorResponse, isErrorCassette,
    noteErrorCassette, errorCassettesSeen, _resetErrorCassettesForTest
};
