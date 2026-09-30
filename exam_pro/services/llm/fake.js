// services/llm/fake.js — LLM_MODE=replay 的回放 adapter（docs/interfaces-stage2.md 第 5.2 條）
//
// CI 全靠這一支：`npm test` 與 `npm run test:integration` 都不連 Gemini、不需要金鑰。
//
// 兩條紀律：
//   1. **miss 一律丟錯**（訊息的前綴凍結），不得靜默回退成假資料。
//      〔dec/r8-b1-abandon〕前綴之後「怎麼重錄」依模式寫（replayMissMessage）：原本寫的
//      「npm run eval:record -- --suite <suite>」其實只錄向量（eval/record_embeddings.js），而且本機模式的重錄要在 Owner 的電腦
//      以 record_local.bat／npm run cassettes:rerecord 做（docs/local-mode.md 10.21）。只改訊息文字：cassette 鍵、回放行為都沒變；
//      eval/lib/replayMiss.js 照樣認得（新舊兩種標記都認）。
//      假資料會讓 eval 量到一個不存在的系統，紅燈變成噪音——與 fixture.js 對 embedding
//      的處置完全一致（interfaces-stage1.md 第 4 條）。
//      fork PR 要把 miss 降成 warning 是 **CI（WS-D）** 的判斷，不在這一層。
//   2. meta.fixtureHash 與現況不符時印 warning，**仍然回放**（規劃 §5.3.3）：
//      few-shot 的鍵只納入 id 清單，題幹改寫不會改鍵，這個欄位是唯一的提醒管道。
//   3. 〔dec/r9-record-tooling〕錯誤回放檔（response.error；docs/local-mode.md 10.23）：錄製當時的呼叫被截斷或單次逾時，
//      回放就丟出**與 live 相同形狀**的錯（同一個 message、name、errorClass、finishReason；被截斷的另帶 usage），
//      agent、狀態機與 eval 因此走到與錄製當時相同的結果（例：驗算被截斷 → runner 的 C-f output_truncated）。
//      這不是 miss：訊息沒有凍結前綴，eval/lib/replayMiss.js 不會把它當成 miss。錯誤物件另外帶
//      errorCassette:{agent,key,kind}、cassetteKey、replayed:true，給探針與 eval 報表辨認（agent 不讀這幾個欄位）。

const {
    cassetteKey, readCassette, cassettePath, fixtureHash, isErrorCassette, noteErrorCassette
} = require('./cassette');

/** 同一支 cassette 的 fixtureHash 警告只印一次 */
const warnedStale = new Set();

/** 凍結的前綴（docs/interfaces-stage2.md 第 5.2 條；eval/lib/replayMiss.js 的 REPLAY_MISS_PREFIX） */
const REPLAY_MISS_PREFIX = 'LLM_MODE=replay 找不到 cassette';
/** 兩種模式的說明都有這一段（eval/lib/replayMiss.js 的 REPLAY_MISS_SUITE_MARKER）；`<suite>` 保持字面（這一層不知道在跑哪個 suite） */
const RERECORD_CMD = 'npm run cassettes:rerecord -- --suites <suite>';

/**
 * 這一次回放是不是本機模式（決定訊息指向哪一種重錄）。
 * vendor 由 services/llm/index.js 傳進來（它剝掉 vendor 前綴之前就知道）；直接呼叫 fake（測試）沒有 vendor 時，
 * OCR 一律是本機，裸模型 ID 以 gemini 開頭的算 Gemini，其餘算本機（目前的預設模型都是本機，docs/local-mode.md 第 2 條）。
 * @param {{agent?:string, vendor?:string, model?:string}} o
 */
function isLocalReplay({ agent, vendor, model }) {
    if (vendor) return vendor === 'ollama';
    if (agent === 'ocr') return true;
    return !/^gemini/i.test(String(model || ''));
}

/**
 * replay miss 的訊息。前綴「LLM_MODE=replay 找不到 cassette（agent=… key=…）。」不變，之後依模式寫怎麼重錄：
 *   本機模式：在 Owner 的電腦執行 scripts\windows\record_local.bat <suite>（它跑的就是 npm run cassettes:rerecord -- --suites <suite>，
 *            模型、OCR、測試庫照 ci.yml；docs/local-mode.md 10.21）；
 *   Gemini 模式：npm run cassettes:rerecord -- --suites <suite>（ci.yml 的模型要是 Gemini；要 GEMINI_API_KEY，會產生費用）。
 *   〔審查 dec/r8-b1-abandon-fix〕eval/tools/rerecord_all.js 一律照 .github/workflows/ci.yml 的模型錄（.env 的 MODEL_* 不帶進去），
 *   所以只有 ci.yml 的模型也是 Gemini 時，照做才錄得到這一支；開發者自己在 .env 設了 Gemini 模型回放、ci.yml 卻是 ollama 時
 *   錄不到（cassette 的鍵含模型 ID）。本機那一句同理（照 ci.yml 的本機模型錄），目前 ci.yml 就是本機模型。
 * 最後一行是預期路徑。services/ocr 的回放 miss 也用這一支（同一串前綴與標記）。
 * @param {{agent:string, key:string, vendor?:string, model?:string, path?:string}} o
 */
function replayMissMessage({ agent, key, vendor, model, path }) {
    const how = isLocalReplay({ agent, vendor, model })
        ? `本機模式：請在 Owner 的電腦（exam_pro 資料夾）執行 scripts\\windows\\record_local.bat <suite> 重錄（它跑的就是 ${RERECORD_CMD}；步驟見 docs/local-mode.md 10.21）`
        : `Gemini 模式：請在本機執行 ${RERECORD_CMD} 重錄（ci.yml 的模型要是 Gemini；要 GEMINI_API_KEY，會產生費用）`;
    return `${REPLAY_MISS_PREFIX}（agent=${agent} key=${key}）。${how}` + (path ? `\n（預期路徑：${path}）` : '');
}

/** 錯誤回放檔的 name → 建構子（name 不在表上的用 Error，再把 name 設回去，例：'AbortError'） */
const ERROR_CTORS = Object.freeze({ Error, SyntaxError, TypeError, RangeError });

/**
 * 〔dec/r9-record-tooling〕錯誤回放檔 → 與錄製當時 live 丟出的錯同形狀的 Error。純函式。
 * @param {{agent:string, key:string, response:{error:object, usage?:object}}} o
 * @returns {Error}
 */
function errorFromCassette({ agent, key, response }) {
    const e = response.error || {};
    const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
    const Ctor = Object.prototype.hasOwnProperty.call(ERROR_CTORS, name) ? ERROR_CTORS[name] : Error;
    const err = new Ctor(String(e.message ?? ''));
    if (err.name !== name) err.name = name;
    if (e.errorClass !== undefined && e.errorClass !== null) err.errorClass = e.errorClass;
    if (e.finishReason !== undefined && e.finishReason !== null) err.finishReason = String(e.finishReason);
    // 被截斷的呼叫有用量（adapter 掛在 err.usage，有自己預算閘門的呼叫端會記帳）；回放與一般回放一樣只給四個 token 欄位
    const u = response.usage;
    if (u && typeof u === 'object') {
        err.usage = { tokenIn: u.tokenIn ?? 0, tokenOut: u.tokenOut ?? 0, tokenThinking: u.tokenThinking ?? 0, tokenCached: u.tokenCached ?? 0 };
    }
    err.errorCassette = { agent, key, kind: e.kind ?? null };
    err.cassetteKey = key;
    err.replayed = true;
    return err;
}

/** 讀到錯誤回放檔就記下來（eval 報表列出）並丟出錄製當時的錯；一般回放檔什麼都不做 */
function throwIfErrorCassette(cassette, { agent, key }) {
    if (!isErrorCassette(cassette)) return;
    const e = cassette.response.error;
    noteErrorCassette({ agent, key, kind: e.kind ?? null, errorClass: e.errorClass ?? null, finishReason: e.finishReason ?? null, source: 'replay' });
    throw errorFromCassette({ agent, key, response: cassette.response });
}

/**
 * 回放一次 generateJson。
 * @param {{model:string, parts?:Array<object>, schema?:object, agent:string,
 *          cacheKeyParts?:object, template?:string}} opts
 *        model 必須是**裸 ID**（vendor 前綴由 services/llm/index.js 剝掉）
 * @returns {{data:object, usage:{tokenIn:number,tokenOut:number,tokenThinking:number,tokenCached:number},
 *           latencyMs:number, raw:null, replayed:true, cassetteKey:string}}
 */
function generateJson({ model, schema, agent, cacheKeyParts, template, vendor }) {
    const key = cassetteKey({ agent, modelId: model, template, schema, cacheKeyParts });
    const cassette = readCassette(agent, key);

    if (!cassette) {
        throw new Error(replayMissMessage({ agent, key, vendor, model, path: cassettePath(agent, key) }));
    }
    // 〔dec/r9-record-tooling〕錄製當時被截斷或單次逾時：照樣丟那個錯（檔頭第 3 點）
    throwIfErrorCassette(cassette, { agent, key });

    const response = cassette.response || {};
    if (response.data === undefined) {
        throw new Error(`cassette 缺少 response.data：${cassettePath(agent, key)}`);
    }

    const recorded = cassette.meta && cassette.meta.fixtureHash;
    const current = fixtureHash();
    if (recorded && current && recorded !== current && !warnedStale.has(key)) {
        warnedStale.add(key);
        console.warn(`[llm:replay] few-shot 內容已變，cassette 可能過期（agent=${agent} key=${key}）`);
    }

    const usage = response.usage || {};
    return {
        data: response.data,
        usage: {
            tokenIn: usage.tokenIn ?? 0,
            tokenOut: usage.tokenOut ?? 0,
            tokenThinking: usage.tokenThinking ?? 0,
            tokenCached: usage.tokenCached ?? 0
        },
        latencyMs: usage.latencyMs ?? response.latencyMs ?? 0,
        raw: null,              // 回放沒有 SDK 原始回應；agent 不得依賴 raw
        replayed: true,
        cassetteKey: key
    };
}

/**
 * 回放一次 generateText（階段 5 WS-E，docs/interfaces-stage5.md 第 5.1 條）。
 *
 * 鍵與 generateJson 同一條公式（schema 欄恆為空）；cassette 的 response 存 { text, codeRuns, finishReason, usage }
 *（finishReason 是後加的欄位，沒有時回 null——舊 cassette 照樣回放）。
 * miss 的訊息與 generateJson **同一串**（eval/lib/replayMiss.js 靠前綴辨識，不得分叉）。
 *
 * @param {{model:string, agent:string, cacheKeyParts?:object, template?:string}} opts
 *        model 必須是**裸 ID**
 * @returns {{text:string, codeRuns:Array<{language:string,code:string,outcome:string|null,output:string}>,
 *           finishReason:string|null, usage:{tokenIn:number,tokenOut:number,tokenThinking:number,tokenCached:number},
 *           latencyMs:number, raw:null, replayed:true, cassetteKey:string}}
 */
function generateText({ model, agent, cacheKeyParts, template, vendor }) {
    const key = cassetteKey({ agent, modelId: model, template, schema: undefined, cacheKeyParts });
    const cassette = readCassette(agent, key);

    if (!cassette) {
        throw new Error(replayMissMessage({ agent, key, vendor, model, path: cassettePath(agent, key) }));
    }
    // 〔dec/r9-record-tooling〕錄製當時單次逾時（generateText 被截斷不會丟錯，照一般回放檔回 finishReason）
    throwIfErrorCassette(cassette, { agent, key });

    const response = cassette.response || {};
    if (typeof response.text !== 'string') {
        throw new Error(`cassette 缺少 response.text：${cassettePath(agent, key)}`);
    }

    const usage = response.usage || {};
    const codeRuns = Array.isArray(response.codeRuns) ? response.codeRuns : [];
    return {
        text: response.text,
        codeRuns: codeRuns.map(r => ({
            language: String(r?.language ?? 'PYTHON'),
            code: String(r?.code ?? ''),
            outcome: r?.outcome === undefined || r?.outcome === null ? null : String(r.outcome),
            output: String(r?.output ?? '')
        })),
        finishReason: response.finishReason === undefined || response.finishReason === null
            ? null : String(response.finishReason),
        usage: {
            tokenIn: usage.tokenIn ?? 0,
            tokenOut: usage.tokenOut ?? 0,
            tokenThinking: usage.tokenThinking ?? 0,
            tokenCached: usage.tokenCached ?? 0
        },
        latencyMs: usage.latencyMs ?? response.latencyMs ?? 0,
        raw: null,
        replayed: true,
        cassetteKey: key
    };
}

/** 測試用：清掉「已警告過」的記憶 */
function _resetForTest() {
    warnedStale.clear();
}

module.exports = {
    generateJson, generateText, replayMissMessage, isLocalReplay, REPLAY_MISS_PREFIX, RERECORD_CMD, _resetForTest,
    errorFromCassette   // 〔dec/r9-record-tooling〕
};
