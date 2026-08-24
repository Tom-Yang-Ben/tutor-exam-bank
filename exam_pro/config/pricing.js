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
// 價格於 2026-08-24 自 https://ai.google.dev/gemini-api/docs/pricing 人工查證（付費層）。
// 兩個本表刻意簡化的地方（都往「不低估」的方向靠）：
//   1. gemini-3.1-pro-preview 官方分兩級（≤200k／>200k tokens 上下文），本專案單次呼叫
//      遠小於 200k，一律取 ≤200k 級距（input 2／output 12／cached 0.20）。
//   2. gemini-3.7-flash 與 3.6-flash 是促銷價（2026-12-31 止；2027-01-01 起 input 1.50／
//      output 7.50／cached 0.15）——到期後要回來改，verified_on 就是提醒。
//   context caching 的**儲存費**（$/1M tokens/hour）不在 token 計價模型內，本表不含。

/** @type {Record<string, {input:number, output:number, cached:number, verified_on:string|null}>} */
const PRICING = {
    // 拆題／分類／公式重寫（MODEL_EXTRACT 預設）
    'gemini-3.5-flash': { input: 1.50, output: 9.00, cached: 0.15, verified_on: '2026-08-24' },
    // 解題驗證（MODEL_VERIFY 預設）；促銷價至 2026-12-31（見檔頭第 2 點）
    'gemini-3.7-flash': { input: 0.75, output: 3.75, cached: 0.075, verified_on: '2026-08-24' },
    // spike 當日也可用，換模型時的備位；促銷價至 2026-12-31（見檔頭第 2 點）
    'gemini-3.6-flash': { input: 0.75, output: 3.75, cached: 0.075, verified_on: '2026-08-24' },
    'gemini-2.5-flash': { input: 0.30, output: 2.50, cached: 0.03, verified_on: '2026-08-24' },
    // 開通付費後 MODEL_VERIFY 會換成它（免費層配額為 0，見裁決 S0-5）；取 ≤200k 級距（見檔頭第 1 點）
    'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cached: 0.20, verified_on: '2026-08-24' },
    // embedding（成本報表的完整性；embed 目前不寫 job_events，先列著）。無 output／cached 計價
    'gemini-embedding-001': { input: 0.15, output: 0, cached: 0, verified_on: '2026-08-24' }
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
