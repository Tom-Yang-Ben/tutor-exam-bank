// services/llm/throttle.js — 出口配額的令牌桶（docs/interfaces-stage2.md 第 5.3 條）
//
// 每個供應商兩個桶：
//   1. RPM —— 滑動 60 秒視窗；<VENDOR>_RPM（GEMINI_RPM / ANTHROPIC_RPM / OPENAI_RPM），預設 60
//   2. 併發 —— 同時在飛的呼叫數；JOB_CONCURRENCY，預設 2
//
// 這一層保護的是**出口**（供應商的配額，超了會 429），middleware/rateLimit.js 保護的是
// **入口**（別人打我的 API）。兩者不共用，也不應該互相參考。
//
// 為什麼要有併發桶：RPM 桶只管「一分鐘幾次」，但 JOB_CONCURRENCY 個 worker 槽同時醒來
// 可以在同一毫秒送出 N 個請求，供應商那端看到的是尖峰而不是均速。併發桶把尖峰壓平。
//
// 用法（呼叫端 finally 一定要 release，否則併發槽會漏光，整個行程卡死）：
//     const release = await acquire('gemini');
//     try { ... } finally { release(); }

const VENDOR_DEFAULT_RPM = 60;
const DEFAULT_CONCURRENCY = 2;

/** @type {Map<string, {stamps:number[], inFlight:number, waiters:Array<() => void>}>} */
const buckets = new Map();

function bucketFor(vendor) {
    const key = String(vendor || 'gemini').toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { stamps: [], inFlight: 0, waiters: [] });
    return buckets.get(key);
}

function positiveInt(raw, fallback) {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 該供應商的每分鐘上限；<= 0 或沒設就用預設 60 */
function rpmFor(vendor) {
    const envName = `${String(vendor || 'gemini').toUpperCase()}_RPM`;
    return positiveInt(process.env[envName], VENDOR_DEFAULT_RPM);
}

/** 併發上限；沿用 worker 的 JOB_CONCURRENCY（同一批槽在跑，沒必要再開一個變數） */
function concurrencyLimit() {
    return positiveInt(process.env.JOB_CONCURRENCY, DEFAULT_CONCURRENCY);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 併發槽釋出：先叫醒最早排隊的那一個（FIFO，避免飢餓） */
function releaseSlot(bucket) {
    bucket.inFlight -= 1;
    const next = bucket.waiters.shift();
    if (next) next();
}

/**
 * 取得一個呼叫許可。先排併發槽，再等 RPM 視窗。
 * @param {'gemini'|'anthropic'|'openai'|string} vendor
 * @returns {Promise<() => void>}  resolve 出來的是 release()，只會生效一次（重複呼叫無害）
 */
async function acquire(vendor) {
    const bucket = bucketFor(vendor);

    // ── 併發桶 ──
    if (bucket.inFlight >= concurrencyLimit()) {
        await new Promise(resolve => bucket.waiters.push(resolve));
    }
    bucket.inFlight += 1;

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        releaseSlot(bucket);
    };

    // ── RPM 桶（滑動 60 秒）──
    try {
        for (;;) {
            const now = Date.now();
            while (bucket.stamps.length && now - bucket.stamps[0] >= 60000) bucket.stamps.shift();
            const rpm = rpmFor(vendor);
            if (bucket.stamps.length < rpm) {
                bucket.stamps.push(now);
                return release;
            }
            // 等到最舊的那一筆滑出視窗（+50ms 餘裕，避免邊界上反覆空轉）
            await sleep(60000 - (now - bucket.stamps[0]) + 50);
        }
    } catch (err) {
        release();
        throw err;
    }
}

/** 測試用：清掉所有桶（單元測試之間不互相汙染）。正式流程不呼叫。 */
function _resetForTest() {
    buckets.clear();
}

module.exports = { acquire, _resetForTest, rpmFor, concurrencyLimit };
