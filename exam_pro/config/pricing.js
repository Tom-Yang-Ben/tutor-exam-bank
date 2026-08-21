// config/pricing.js — 每個模型的單價與成本估算（docs/interfaces-stage2.md 第 5.5 條）
//
// 單位：USD / 1M token。
//   input   —— promptTokenCount
//   output  —— candidatesTokenCount **與** thoughtsTokenCount 同價（裁決 S0-6 第 1 點：
//              thinking 經常大於 candidates，漏算會系統性低估兩到五倍）
//   cached  —— cachedContentTokenCount（沒有快取命中時該鍵不存在，一律 ?? 0）
//
// verified_on 是「人去官網查證的日期」（YYYY-MM-DD），**不是**寫這個檔的日期。
// null = 還沒查證 → estimateCost 回 { cost_usd: 0, cost_estimated: false }，
// report:jobs 會把 cost_estimated=false 的列另外標示。
//
// 為什麼「查不到就記 0」而不是猜一個數字：一個猜出來的成本會混進報表的加總，
// 之後沒有人分得出哪些是量到的、哪些是掰的。記 0 + 一個旗標，至少誠實。
//
// ⚠ 目前四支 Flash 全部 verified_on: null。要讓成本報表有意義，請人工到
//   https://ai.google.dev/gemini-api/docs/pricing 查證後把數字與日期一起填上
//   （這是 WS-B 交給人工 lane 的待辦，見 docs/llm.md）。

/** @type {Record<string, {input:number, output:number, cached:number, verified_on:string|null}>} */
const PRICING = {
    // 拆題／分類／公式重寫（MODEL_EXTRACT 預設）
    'gemini-3.5-flash': { input: 0, output: 0, cached: 0, verified_on: null },
    // 解題驗證（MODEL_VERIFY 預設）
    'gemini-3.7-flash': { input: 0, output: 0, cached: 0, verified_on: null },
    // spike 當日也可用，換模型時的備位
    'gemini-3.6-flash': { input: 0, output: 0, cached: 0, verified_on: null },
    'gemini-2.5-flash': { input: 0, output: 0, cached: 0, verified_on: null },
    // 開通付費後 MODEL_VERIFY 會換成它（免費層配額為 0，見裁決 S0-5）
    'gemini-3.1-pro-preview': { input: 0, output: 0, cached: 0, verified_on: null },
    // embedding（成本報表的完整性；embed 目前不寫 job_events，先列著）
    'gemini-embedding-001': { input: 0, output: 0, cached: 0, verified_on: null }
};

const PER_MILLION = 1_000_000;

/**
 * 估算單次呼叫的成本。
 * @param {{modelId:string, tokenIn?:number, tokenOut?:number, tokenThinking?:number, tokenCached?:number}} opts
 *        modelId 必須是**裸 ID**（不含 vendor 前綴），與 job_events.model 去前綴後一致。
 * @returns {{cost_usd:number, cost_estimated:boolean}}
 *          查不到模型或 verified_on 為 null → { cost_usd: 0, cost_estimated: false }
 */
function estimateCost({ modelId, tokenIn = 0, tokenOut = 0, tokenThinking = 0, tokenCached = 0 } = {}) {
    const row = PRICING[String(modelId || '').trim()];
    if (!row || !row.verified_on) return { cost_usd: 0, cost_estimated: false };

    // cached 的 token 已含在 promptTokenCount 內，所以先扣掉再以 cached 單價計
    const billableIn = Math.max(0, num(tokenIn) - num(tokenCached));
    const cost =
        (billableIn * row.input +
            (num(tokenOut) + num(tokenThinking)) * row.output +
            num(tokenCached) * row.cached) / PER_MILLION;

    // NUMERIC(10,6)：小數第 6 位以下沒有意義，先在這裡收斂，報表加總才不會飄
    return { cost_usd: Number(cost.toFixed(6)), cost_estimated: true };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// 第 5.5 條寫的匯出形狀是「一個模型一個鍵」，另外掛上 PRICING 與 estimateCost：
// 要走訪價目表請用 PRICING，不要 Object.keys(module.exports)（會混進兩個非模型的鍵）。
module.exports = { ...PRICING, PRICING, estimateCost };
