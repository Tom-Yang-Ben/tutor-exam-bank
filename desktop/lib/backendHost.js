// ─────────────────────────────────────────────────────────────
// desktop/lib/backendHost.js — 主行程這一側：開後端子行程、問狀態、關閉、放棄（DA-3＝2 utilityProcess）
//
// 後端跑在 Electron 的 utilityProcess（完整的 Node 環境；sharp、@node-rs/jieba 是 Node-API 模組，不必重編）：
//   - 後端崩潰時主行程還在：視窗與系統匣照常，可以顯示原因、自動重開一次（lib/decisions.js 的 decideBackendExit）；
//   - 拆題時吃 CPU 的事（mupdf 同步渲染、jieba）不會卡住視窗、系統匣與對話框。
// 後端的 stdout／stderr 寫進 desktop-server-日期.log，最後 64 KB 另外留在記憶體（啟動失敗時顯示在啟動畫面）。
//
// fork 由呼叫的人注入（main.js 傳 electron 的 utilityProcess.fork；單元測試傳假的），本檔不載入 electron 模組。
// ─────────────────────────────────────────────────────────────
'use strict';

const { TYPES, unwrap, parseStatus } = require('./backendProtocol');

/** 記憶體裡留多少後端輸出（啟動失敗時給畫面看最後幾行） */
const TAIL_MAX = 64 * 1024;
/** exit 之後再等多久讓 stdout／stderr 的最後一段寫完 */
const DRAIN_MS = 150;

/**
 * @param {object} o
 * @param {(modulePath:string, args:string[], options:object) => any} o.fork   utilityProcess.fork
 * @param {string} o.entryPath   desktop/backend-entry.js
 * @param {string} o.cwd         exam_pro（app.js 的 uploads 以目前工作目錄為基準，第 3 條第 10 項）
 * @param {string} [o.serviceName]
 * @param {() => ({write:Function, end:Function}|null)} [o.openLog]  每次開後端時開一次記錄檔
 * @param {(line:string)=>void} [o.log]
 * @param {{setTimeout:Function, clearTimeout:Function}} [o.timers]
 */
function createBackendHost({ fork, entryPath, cwd, serviceName = 'TutorExamBank backend', openLog = () => null, log = () => { }, timers = { setTimeout, clearTimeout } }) {
    let child = null;
    let generation = 0;
    let pid = null;
    let ready = null;          // { port, url, jobsPaused }
    let exited = null;         // { code, expected }
    let stopRequested = false; // 我們送了 shutdown 或 kill（之後的 exit 不算異常）
    let shutdownGraceMs = null;
    let abandonSent = false;   // 〔dec/r8-b1-abandon〕送過「現在放棄」
    let tail = '';
    let seq = 0;
    let logStream = null;
    const pending = new Map();         // status 請求 id → resolve
    const readyWaiters = new Set();
    const exitWaiters = new Set();
    const exitListeners = new Set();

    function appendTail(chunk) {
        tail += String(chunk);
        if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
    }

    function onMessage(raw) {
        const msg = unwrap(raw);
        if (!msg) return;
        if (msg.type === TYPES.READY) {
            ready = { port: Number(msg.port), url: String(msg.url), jobsPaused: Boolean(msg.jobs_paused) };
            for (const w of [...readyWaiters]) w();
            return;
        }
        if (msg.type === TYPES.STATUS) {
            const done = pending.get(msg.id);
            if (done) { pending.delete(msg.id); done(parseStatus(msg)); }
            return;
        }
        if (msg.type === TYPES.SHUTDOWN_ACK) {
            if (msg.abandon) log(`後端收到「現在放棄」：中止在途 ${msg.in_flight} 件、放掉自己的租約後結束${msg.already ? '（原本在等處理完）' : ''}`);
            else log(`後端收到關閉要求：最多等 ${Math.round(Number(msg.grace_ms) / 1000)} 秒、在途 ${msg.in_flight} 件${msg.already ? '（已經在關閉中）' : ''}`);
        }
    }

    function onExit(gen, code) {
        if (gen !== generation) return;
        exited = { code: Number.isInteger(code) ? code : null, expected: stopRequested };
        const finish = () => {
            for (const [, done] of pending) done(null);
            pending.clear();
            for (const w of [...readyWaiters]) w();
            for (const w of [...exitWaiters]) w();
            if (logStream) { try { logStream.end(); } catch (_) { /* 忽略 */ } logStream = null; }
            log(`後端結束（結束碼 ${exited.code}${exited.expected ? '' : '，不是桌面版要它結束的'}）`);
            for (const cb of [...exitListeners]) {
                try { cb({ ...exited }); } catch (err) { log(`處理後端結束時出錯：${err && err.message}`); }
            }
        };
        timers.setTimeout(finish, DRAIN_MS);
    }

    /**
     * 開後端。前一個還在時回錯（不會同時有兩個）。
     * @param {{env:Record<string,string>, banner?:string}} o
     * @returns {Promise<{ok:true, pid:number}|{ok:false, error:string}>}
     */
    function start({ env, banner }) {
        if (child && !exited) return Promise.resolve({ ok: false, error: '前一個後端還在執行' });
        generation += 1;
        const gen = generation;
        child = null; pid = null; ready = null; exited = null; stopRequested = false; shutdownGraceMs = null; abandonSent = false; tail = '';
        pending.clear();
        try { logStream = openLog(); } catch (_) { logStream = null; }
        if (banner) {
            appendTail(banner);
            if (logStream) { try { logStream.write(banner); } catch (_) { /* 忽略 */ } }
        }
        let c;
        try {
            c = fork(entryPath, [], { env, cwd, stdio: 'pipe', serviceName });
        } catch (err) {
            exited = { code: null, expected: false };
            return Promise.resolve({ ok: false, error: String((err && err.message) || err) });
        }
        child = c;
        const write = d => {
            appendTail(d);
            if (logStream) { try { logStream.write(d); } catch (_) { /* 忽略 */ } }
        };
        if (c.stdout) c.stdout.on('data', write);
        if (c.stderr) c.stderr.on('data', write);
        c.on('message', onMessage);
        c.once('exit', code => onExit(gen, code));
        return new Promise(resolve => {
            let settled = false;
            const settle = r => { if (!settled) { settled = true; exitWaiters.delete(onEarlyExit); resolve(r); } };
            const onEarlyExit = () => settle({ ok: false, error: `後端還沒開起來就結束了（結束碼 ${exited ? exited.code : '不明'}）` });
            exitWaiters.add(onEarlyExit);
            c.once('spawn', () => {
                pid = c.pid;
                settle({ ok: true, pid });
            });
        });
    }

    /**
     * 等後端聽到埠（ready 訊息）。
     * @param {{timeoutMs:number}} o
     * @returns {Promise<{ready:true, port:number, url:string, jobsPaused:boolean}|{ready:false, reason:'exited', exitCode:number|null, logTail:string}|{ready:false, reason:'timeout', childAlive:boolean, logTail:string}>}
     */
    function waitReady({ timeoutMs }) {
        const result = () => {
            // 先看有沒有結束：聽到埠之後才結束的也算「結束了」（呼叫的人要拿結束碼與記錄檔）
            if (exited || !child) return { ready: false, reason: 'exited', exitCode: exited ? exited.code : null, logTail: tail };
            if (ready) return { ready: true, ...ready };
            return { ready: false, reason: 'timeout', childAlive: true, logTail: tail };
        };
        if (ready || exited || !child) return Promise.resolve(result());
        return new Promise(resolve => {
            let timer = null;
            const done = () => {
                readyWaiters.delete(done);
                exitWaiters.delete(done);
                if (timer) timers.clearTimeout(timer);
                resolve(result());
            };
            readyWaiters.add(done);
            exitWaiters.add(done);
            timer = timers.setTimeout(done, timeoutMs);
        });
    }

    /**
     * 問後端的在途工作數。後端沒在跑、還沒聽到埠、或逾時沒回答 → null。
     * @param {{timeoutMs?:number}} [o]
     */
    function status({ timeoutMs = 3000 } = {}) {
        if (!child || exited || !ready) return Promise.resolve(null);
        seq += 1;
        const id = seq;
        return new Promise(resolve => {
            const timer = timers.setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
            pending.set(id, s => { timers.clearTimeout(timer); resolve(s); });
            try {
                child.postMessage({ type: TYPES.STATUS, id });
            } catch (_) {
                pending.delete(id);
                timers.clearTimeout(timer);
                resolve(null);
            }
        });
    }

    function waitExit() {
        if (!child || exited) return Promise.resolve(exited ? { ...exited } : { code: null, expected: true });
        return new Promise(resolve => {
            const done = () => { exitWaiters.delete(done); resolve({ ...exited }); };
            exitWaiters.add(done);
        });
    }

    /** 強制結束（Windows 上是 TerminateProcess）：與當機同一條路，不寫結果、不動重試次數 */
    function kill() {
        if (!child || exited) return false;
        stopRequested = true;
        try { return child.kill(); } catch (_) { return false; }
    }

    /**
     * 優雅關閉：送 shutdown，最多等 graceMs＋killAfterMs，還沒結束就強制結束。
     * 還沒聽到埠（沒有任何工作可等）時直接強制結束。
     * @param {{graceMs:number, killAfterMs?:number}} o
     */
    async function shutdown({ graceMs, killAfterMs = 5000 }) {
        if (!child || exited) return exited ? { ...exited } : { code: null, expected: true };
        stopRequested = true;
        if (!ready) { kill(); return waitExit(); }
        if (shutdownGraceMs === null) {
            shutdownGraceMs = graceMs;
            try { child.postMessage({ type: TYPES.SHUTDOWN, grace_ms: graceMs }); } catch (_) { kill(); }
        }
        const timer = timers.setTimeout(() => {
            log(`後端在 ${Math.round((graceMs + killAfterMs) / 1000)} 秒內沒有結束，強制結束`);
            kill();
        }, graceMs + killAfterMs);
        try {
            return await waitExit();
        } finally {
            timers.clearTimeout(timer);
        }
    }

    /**
     * 現在放棄（〔dec/r8-b1-abandon〕）：送 { type:'shutdown', grace_ms:0, abandon:true }，後端中止在途節點、不寫結果、不動重試次數、
     * 只放掉自己的租約，然後照常關連線池結束——下次開啟立刻重新認領，不必等租約到期（jobRunner 的 shutdown({ abandon })）。
     * 已經在「等處理完」的關閉中也一樣送（後端會讓正在等的那一輪提早改成放棄）。
     * 最多等 waitMs＋killAfterMs，後端還沒結束（例如同步運算卡住事件迴圈、收不到訊息）才強制結束——那樣就退回當機的那條路：
     * 不寫結果、不動重試次數，但租約要等到期（JOB_LEASE_MS，預設 3 分鐘）才會重新認領。
     * 還沒聽到埠（沒有任何工作可放棄）時直接強制結束。
     * @param {{waitMs?:number, killAfterMs?:number}} [o]  waitMs 與後端的 ABANDON_WAIT_MS（services/launcherControl.js）相同
     */
    async function abandon({ waitMs = 10_000, killAfterMs = 5000 } = {}) {
        if (!child || exited) return exited ? { ...exited } : { code: null, expected: true };
        stopRequested = true;
        if (!ready) { kill(); return waitExit(); }
        if (!abandonSent) {
            abandonSent = true;
            if (shutdownGraceMs === null) shutdownGraceMs = 0;
            try { child.postMessage({ type: TYPES.SHUTDOWN, grace_ms: 0, abandon: true }); } catch (_) { kill(); }
        }
        const timer = timers.setTimeout(() => {
            log(`後端在放棄後 ${Math.round((waitMs + killAfterMs) / 1000)} 秒內沒有結束，強制結束（被放棄的工作要等租約到期才會重新認領）`);
            kill();
        }, waitMs + killAfterMs);
        try {
            return await waitExit();
        } finally {
            timers.clearTimeout(timer);
        }
    }

    return {
        start, waitReady, status, shutdown, abandon, kill, waitExit,
        /** 後端結束時通知（{code, expected}；expected＝桌面版要它結束的） */
        onExit(cb) { exitListeners.add(cb); return () => exitListeners.delete(cb); },
        get alive() { return Boolean(child) && !exited; },
        get pid() { return pid; },
        get ready() { return ready ? { ...ready } : null; },
        get shuttingDown() { return shutdownGraceMs !== null; },
        /** 〔dec/r8-b1-abandon〕送過「現在放棄」 */
        get abandoning() { return abandonSent; },
        get tail() { return tail; }
    };
}

module.exports = { createBackendHost, TAIL_MAX, DRAIN_MS };
