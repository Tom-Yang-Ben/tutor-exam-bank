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
//
// 〔本機模式 L1，docs/local-mode.md 第 2 條、第 3 條第 8 點〕vendor 'ollama' 的兩個桶另有預設：
//   - 併發讀 OLLAMA_CONCURRENCY，預設 1（CPU 一次只跑得動一個模型；不吃 JOB_CONCURRENCY——
//     worker 槽可以有兩個，但送進 Ollama 的呼叫一次一個，其餘排隊）
//   - RPM 讀 OLLAMA_RPM，**未設＝不限**（本機沒有配額；慢是因為 CPU，不是因為限流）
//   - acquire 可帶 { signal }：排隊中被中止（節點逾時）就離開佇列並丟 errorClass='timeout'。
//     本機一次呼叫可能跑二十分鐘，排在後面的呼叫不該等到前面跑完才發現自己早就逾時了。
//   gemini／anthropic／openai 的行為一個字都沒改（不帶 signal 時與之前逐位元相同）。

const VENDOR_DEFAULT_RPM = 60;
const DEFAULT_CONCURRENCY = 2;
const OLLAMA_DEFAULT_CONCURRENCY = 1;

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

function isOllama(vendor) {
    return String(vendor || '').toLowerCase() === 'ollama';
}

/**
 * 該供應商的每分鐘上限；<= 0 或沒設就用預設 60。
 * ollama 例外：沒設（或 <= 0）回 Infinity＝不限（本機模式第 2 條）。
 */
function rpmFor(vendor) {
    const envName = `${String(vendor || 'gemini').toUpperCase()}_RPM`;
    return positiveInt(process.env[envName], isOllama(vendor) ? Infinity : VENDOR_DEFAULT_RPM);
}

/**
 * 併發上限。雲端供應商沿用 worker 的 JOB_CONCURRENCY（同一批槽在跑，沒必要再開一個變數）；
 * ollama 讀 OLLAMA_CONCURRENCY，預設 1（本機模式第 3 條第 8 點）。不帶參數時與之前相同（JOB_CONCURRENCY）。
 * @param {string} [vendor]
 */
function concurrencyLimit(vendor) {
    if (isOllama(vendor)) return positiveInt(process.env.OLLAMA_CONCURRENCY, OLLAMA_DEFAULT_CONCURRENCY);
    return positiveInt(process.env.JOB_CONCURRENCY, DEFAULT_CONCURRENCY);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 併發槽釋出：先叫醒最早排隊的那一個（FIFO，避免飢餓） */
function releaseSlot(bucket) {
    bucket.inFlight -= 1;
    const next = bucket.waiters.shift();
    if (next) next();
}

/** 排隊中被中止時丟的錯（與 gemini.js 的中止同一個 errorClass；呼叫端不重試） */
function abortedError(vendor) {
    const err = new Error(`${vendor} 的呼叫在排隊等候時已被中止（節點逾時）。`);
    err.errorClass = 'timeout';
    return err;
}

/**
 * 在併發桶排隊。帶 signal 時可中止：中止就把自己從佇列拿掉並丟 timeout。
 * 叫醒與中止同時發生時（極少見），已經被 releaseSlot 叫醒的那一個照常取得槽位，
 * 由 acquire 之後的 signal 檢查負責還槽——槽位帳不會因此多算或少算。
 */
function waitForSlot(bucket, vendor, signal) {
    if (!signal) return new Promise(resolve => bucket.waiters.push(resolve));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            const i = bucket.waiters.indexOf(wake);
            if (i === -1) return;                     // 已被叫醒：交給 acquire 之後的檢查處理
            bucket.waiters.splice(i, 1);
            reject(abortedError(vendor));
        };
        const wake = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        bucket.waiters.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 取得一個呼叫許可。先排併發槽，再等 RPM 視窗。
 * @param {'gemini'|'anthropic'|'openai'|'ollama'|string} vendor
 * @param {{signal?:AbortSignal}} [opts]  signal：排隊中被中止就離開佇列並丟 errorClass='timeout'
 * @returns {Promise<() => void>}  resolve 出來的是 release()，只會生效一次（重複呼叫無害）
 */
async function acquire(vendor, opts = {}) {
    const bucket = bucketFor(vendor);
    const signal = opts && opts.signal;

    if (signal && signal.aborted) throw abortedError(vendor);

    // ── 併發桶 ──
    if (bucket.inFlight >= concurrencyLimit(vendor)) {
        await waitForSlot(bucket, vendor, signal);
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
            // 帶 signal 時：排到了槽、或 RPM 等待醒來時已被中止 → 還槽並丟 timeout（不帶 signal 時永遠不會走到）
            if (signal && signal.aborted) throw abortedError(vendor);
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
