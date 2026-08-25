// services/llm/fake.js — LLM_MODE=replay 的回放 adapter（docs/interfaces-stage2.md 第 5.2 條）
//
// CI 全靠這一支：`npm test` 與 `npm run test:integration` 都不連 Gemini、不需要金鑰。
//
// 兩條紀律：
//   1. **miss 一律丟錯**（訊息逐字凍結），不得靜默回退成假資料。
//      假資料會讓 eval 量到一個不存在的系統，紅燈變成噪音——與 fixture.js 對 embedding
//      的處置完全一致（interfaces-stage1.md 第 4 條）。
//      fork PR 要把 miss 降成 warning 是 **CI（WS-D）** 的判斷，不在這一層。
//   2. meta.fixtureHash 與現況不符時印 warning，**仍然回放**（規劃 §5.3.3）：
//      few-shot 的鍵只納入 id 清單，題幹改寫不會改鍵，這個欄位是唯一的提醒管道。

const { cassetteKey, readCassette, cassettePath, fixtureHash } = require('./cassette');

/** 同一支 cassette 的 fixtureHash 警告只印一次 */
const warnedStale = new Set();

/**
 * 回放一次 generateJson。
 * @param {{model:string, parts?:Array<object>, schema?:object, agent:string,
 *          cacheKeyParts?:object, template?:string}} opts
 *        model 必須是**裸 ID**（vendor 前綴由 services/llm/index.js 剝掉）
 * @returns {{data:object, usage:{tokenIn:number,tokenOut:number,tokenThinking:number,tokenCached:number},
 *           latencyMs:number, raw:null, replayed:true, cassetteKey:string}}
 */
function generateJson({ model, schema, agent, cacheKeyParts, template }) {
    const key = cassetteKey({ agent, modelId: model, template, schema, cacheKeyParts });
    const cassette = readCassette(agent, key);

    if (!cassette) {
        throw new Error(
            `LLM_MODE=replay 找不到 cassette（agent=${agent} key=${key}）。請在本機執行 npm run eval:record -- --suite <suite>` +
            `\n（預期路徑：${cassettePath(agent, key)}）`
        );
    }

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

/** 測試用：清掉「已警告過」的記憶 */
function _resetForTest() {
    warnedStale.clear();
}

module.exports = { generateJson, _resetForTest };
