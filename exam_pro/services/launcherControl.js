// ─────────────────────────────────────────────────────────────
// services/launcherControl.js — 桌面啟動器的「優雅關閉」通道（docs/desktop-launcher.md 第 7.3 節）
//
// 為什麼要一條 HTTP 通道：Windows 沒有 SIGTERM。啟動器以背景方式（沒有主控台視窗）開的 node server.js
// 收不到 Ctrl+C，別的程式要它「停止認領新工作、等在途工作收尾再結束」只能跟它講話。
//
// 只有由啟動器開的後端才有這條路：啟動器產生一次性的隨機權杖，放在子行程環境變數 LAUNCHER_CONTROL_TOKEN，
// 同一份寫進 exam_pro/data/launcher/server.json 給關閉捷徑讀。環境裡沒有這個變數（npm start、npm run dev、
// CI、測試）時 isEnabled() 為 false，app.js 不掛任何路由——既有行為逐位元不變（請求落到 404）。
//
//   GET  /api/launcher/status     → 200 { pid, in_flight, shutting_down }
//   POST /api/launcher/shutdown   → 202 { pid, in_flight, grace_ms, already }，回應送出後才開始關
//        body（可省）{ grace_ms }：最多等在途工作幾毫秒（0～MAX_GRACE_MS，預設 DEFAULT_GRACE_MS）
// 兩支都要標頭 x-launcher-token（timing-safe 比對，錯了回 403），而且掛在 apiKeyAuth 之後（設了 API_KEY 就還要 x-api-key）。
//
// 關閉順序（shutdown）：
//   1. runner.stop()：不再認領新工作（workers/jobRunner.js 的 stop 只清 interval，不打斷在途工作）；
//   2. server.close()：不再接新連線；
//   3. 每 pollMs 看一次 runner.inFlight，歸零（再等 settleMs 確認沒有剛認領到的）或到 grace_ms 為止；
//   4. 在途歸零：關連線池、exit(0)。
// 時限到了還有在途工作就**不關連線池**、直接結束：那一列的租約（JOB_LEASE_MS，預設 3 分）到期後，下次開機會被重新認領、
// 從那一格重跑——與當機、nodemon 重啟同一條既有的保證（jobRunner.js 檔頭），已記進 job_events 的用量不會遺失。
// 要等多久由關閉捷徑決定（scripts/desktop/stop.js：有在途工作時先問 Owner；待決事項 DL-1）。
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const express = require('express');

const TOKEN_ENV = 'LAUNCHER_CONTROL_TOKEN';
const TOKEN_HEADER = 'x-launcher-token';
/** 預設最多等在途工作 2 分鐘（Gemini 模式一個節點的逾時是 2 分；本機模式一個節點可能跑數十分鐘，見文件待決事項 DL-1） */
const DEFAULT_GRACE_MS = 120_000;
/** 上限 6 小時：關閉捷徑設成「等到跑完」時也不會無限期掛著 */
const MAX_GRACE_MS = 6 * 60 * 60 * 1000;
/** 權杖至少要這麼長才算數（啟動器產生的是 64 個十六進位字元） */
const MIN_TOKEN_LENGTH = 32;

/**
 * 定時安全比較（與 middleware/auth.js 同一個做法）。
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 讀環境裡的權杖；太短或沒設都當作沒有（不掛路由）。
 * @param {object} [env]
 * @returns {string|null}
 */
function tokenFromEnv(env = process.env) {
    const raw = String(env[TOKEN_ENV] || '').trim();
    return raw.length >= MIN_TOKEN_LENGTH ? raw : null;
}

/** @param {object} [env] */
function isEnabled(env = process.env) {
    return tokenFromEnv(env) !== null;
}

/**
 * grace_ms 的解讀：沒給或不是數字 → 預設；負數 → 0；超過上限 → 上限。純函式。
 * @param {unknown} raw
 * @param {{defaultMs?:number, maxMs?:number}} [opts]
 * @returns {number}
 */
function parseGraceMs(raw, { defaultMs = DEFAULT_GRACE_MS, maxMs = MAX_GRACE_MS } = {}) {
    if (raw === undefined || raw === null || raw === '') return defaultMs;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultMs;
    return Math.min(maxMs, Math.max(0, Math.round(n)));
}

/**
 * 伺服器生命週期（可注入時間與結束方式，單元測試不會真的結束行程）。
 * @param {object} [opts]
 * @param {(code:number) => void} [opts.exit]
 * @param {{info:Function, warn:Function, error:Function}} [opts.logger]
 * @param {() => Promise<void>} [opts.closePool]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.settleMs]
 * @param {number} [opts.pid]
 */
function createLifecycle(opts = {}) {
    const exit = opts.exit || (code => process.exit(code));
    const logger = opts.logger || console;
    const closePool = opts.closePool || (async () => { await require('../config/db').pool.end(); });
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const now = opts.now || Date.now;
    const pollMs = opts.pollMs ?? 500;
    const settleMs = opts.settleMs ?? 300;
    const pid = opts.pid ?? process.pid;

    let server = null;
    let runner = null;
    let pending = null;

    function inFlight() {
        return runner && Number.isFinite(runner.inFlight) ? runner.inFlight : 0;
    }

    /** server.js 啟動後呼叫一次。runner 可以是 null（JOB_RUNNER=off）。 */
    function attach(refs = {}) {
        server = refs.server || null;
        runner = refs.runner || null;
    }

    function status() {
        return { pid, in_flight: inFlight(), shutting_down: pending !== null };
    }

    async function run(graceMs) {
        const started = now();
        const initial = inFlight();
        logger.info(`[launcher] 收到關閉要求：停止認領新工作${initial ? `，等 ${initial} 件在途工作收尾（最多 ${Math.round(graceMs / 1000)} 秒）` : ''}。`);
        try { if (runner && typeof runner.stop === 'function') runner.stop(); } catch (err) { logger.error(`[launcher] runner.stop 失敗：${err.message}`); }
        try { if (server && typeof server.close === 'function') server.close(() => { }); } catch (err) { logger.error(`[launcher] server.close 失敗：${err.message}`); }

        // 在途工作歸零後再等 settleMs 看一次：tick 可能剛好在 stop 之前認領到一列、還沒登記進 inFlight
        for (;;) {
            if (inFlight() === 0) {
                if (settleMs > 0) await sleep(settleMs);
                if (inFlight() === 0) break;
            }
            if (now() - started >= graceMs) break;
            await sleep(Math.max(1, Math.min(pollMs, graceMs - (now() - started))));
        }
        const left = inFlight();
        try { if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) { /* 忽略 */ }
        if (left > 0) {
            // 〔續作 2026-09-27〕時限到了還有在途工作：**不關連線池**，直接結束——與當機同一條路。
            // 先關池的話，在途工作接下來的查詢會失敗、走進 jobRunner 的錯誤處理路徑；那條路在「池已關閉」下的行為
            // 沒有被驗證過（可能印一串錯誤，也可能在等關池的最後幾秒寫進半套狀態）。直接結束則那一列停在原狀態，
            // 租約到期後下次開機重新認領、從那一格重跑——這是 jobRunner.js 檔頭已有、已測過的保證。
            logger.warn(`[launcher] 還有 ${left} 件工作沒在時限內結束，直接關閉；租約到期後下次開機會重新認領那一格（已記錄的用量不會遺失）。`);
            exit(0);
            return { left };
        }
        try {
            let timer;
            await Promise.race([
                Promise.resolve().then(closePool),
                new Promise(r => { timer = setTimeout(r, 5000); if (timer.unref) timer.unref(); })
            ]).finally(() => clearTimeout(timer));
        } catch (err) {
            logger.error(`[launcher] 關閉連線池失敗：${err.message}`);
        }
        logger.info(`[launcher] 後端已關閉（等了 ${Math.round((now() - started) / 1000)} 秒）。`);
        exit(0);
        return { left };
    }

    /**
     * 開始關閉（冪等：第二次呼叫回同一個 promise）。
     * @param {{graceMs?:number}} [o]
     */
    function shutdown({ graceMs = DEFAULT_GRACE_MS } = {}) {
        if (!pending) pending = run(graceMs);
        return pending;
    }

    return { attach, status, shutdown, get shuttingDown() { return pending !== null; } };
}

/**
 * /api/launcher 的 router。token 在建立時就固定（環境變數只在啟動時讀一次）。
 * @param {{lifecycle: ReturnType<typeof createLifecycle>, token: string, defaultGraceMs?: number, maxGraceMs?: number}} deps
 */
function createRouter({ lifecycle, token, defaultGraceMs = DEFAULT_GRACE_MS, maxGraceMs = MAX_GRACE_MS }) {
    const router = express.Router();
    router.use((req, res, next) => {
        const provided = req.get(TOKEN_HEADER) || '';
        if (!provided || !safeEqual(provided, token)) {
            return res.status(403).json({ message: '啟動器權杖錯誤' });
        }
        res.set('Cache-Control', 'no-store');
        return next();
    });
    router.get('/status', (req, res) => {
        res.json(lifecycle.status());
    });
    router.post('/shutdown', (req, res) => {
        const graceMs = parseGraceMs(req.body && req.body.grace_ms, { defaultMs: defaultGraceMs, maxMs: maxGraceMs });
        const already = lifecycle.shuttingDown;
        const { pid, in_flight: inFlight } = lifecycle.status();
        res.status(202).json({ pid, in_flight: inFlight, grace_ms: graceMs, already });
        // 回應送出之後才開始關：server.close() 不會把這一個回應切斷
        if (!already) res.on('finish', () => { lifecycle.shutdown({ graceMs }); });
    });
    return router;
}

/** server.js 與 app.js 共用的那一份 */
const lifecycle = createLifecycle();

/**
 * app.js 用：環境有權杖才回 router，否則回 null（不掛）。
 * @param {object} [env]
 */
function routerFromEnv(env = process.env) {
    const token = tokenFromEnv(env);
    return token ? createRouter({ lifecycle, token }) : null;
}

/** server.js 用 */
function attach(refs) {
    lifecycle.attach(refs);
}

module.exports = {
    attach, routerFromEnv, isEnabled, tokenFromEnv, parseGraceMs,
    createLifecycle, createRouter, safeEqual,
    TOKEN_ENV, TOKEN_HEADER, DEFAULT_GRACE_MS, MAX_GRACE_MS, MIN_TOKEN_LENGTH
};
