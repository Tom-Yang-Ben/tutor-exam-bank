// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/system.js — 桌面啟動器唯一碰作業系統的地方（可注入的 runner）
//
// lib/actions.js、lib/launcher.js、lib/stopper.js 只透過這個物件做 I/O：執行指令、開背景程式、HTTP、查資料庫、讀寫檔案。
// 單元測試換成假的（test/unit/desktopLauncherRun.test.js），雲端 Linux 上就能把 Windows 的整個流程跑一遍。
//
// 所有方法都不丟錯（除了程式錯誤）：失敗以回傳值表示，呼叫端照值決定下一步。
//
// 〔審查 dec/desktop-launcher 第 1 件〕exec／spawnDetached 的 hide（預設 true）對應 Node 的 windowsHide。
// windowsHide 在 libuv 是 UV_PROCESS_WINDOWS_HIDE：除了不開主控台，還會把 STARTUPINFO.wShowWindow 設成 SW_HIDE，
// 而 GUI 程式第一次顯示視窗時照 STARTUPINFO 決定（`start /min chrome` 開成最小化就是這個機制）。
// 所以**會出現視窗的程式一律傳 hide:false**：Edge／Chrome、rundll32（預設瀏覽器）、Docker Desktop.exe、ollama app.exe、
// 顯示訊息框的 PowerShell。主控台程式（node server.js、ollama serve、netstat、tasklist、docker CLI、不顯示視窗的 PowerShell）
// 維持 true。呼叫點與 hide 值由 test/unit/desktopLauncherRun.test.js 逐一斷言；傳給 child_process 的選項由
// test/unit/desktopLauncherSystem.test.js 斷言（Linux 會忽略 windowsHide，只能在這一層驗）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

/**
 * @typedef {object} ExecResult
 * @property {number|null} code       結束碼（沒跑起來是 null）
 * @property {string} stdout
 * @property {string} stderr
 * @property {string|null} errorCode  ENOENT（找不到程式）、ETIMEDOUT（逾時被停）…
 */

/**
 * @typedef {object} HttpResult
 * @property {number|null} status
 * @property {any} json               回應是 JSON 時的內容，否則 null
 * @property {string} text
 * @property {string|null} errorCode  ECONNREFUSED、ETIMEDOUT…（有回應時是 null）
 */

/**
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {NodeJS.ProcessEnv} [o.env]  系統環境（啟動器自己的 process.env；**不含** .env）
 * @param {{execFile:Function, spawn:Function}} [o.cp]  child_process（測試注入，斷言傳下去的選項）
 */
function createSystem({ platform = process.platform, env = process.env, cp = childProcess } = {}) {
    /** @type {Map<number, {exited:boolean, code:number|null}>} */
    const children = new Map();

    /**
     * 執行一個程式並等它結束。
     * @param {string} file
     * @param {string[]} [args]
     * @param {{cwd?:string, timeoutMs?:number, env?:object, hide?:boolean}} [o]
     *        hide：預設 true（不開主控台、視窗隱藏）；**會顯示視窗的程式要傳 false**（檔頭）
     * @returns {Promise<ExecResult>}
     */
    function exec(file, args = [], { cwd, timeoutMs = 30_000, env: childEnv, hide = true } = {}) {
        return new Promise(resolve => {
            let child;
            try {
                child = cp.execFile(file, args, {
                    cwd, env: childEnv || env, timeout: timeoutMs, windowsHide: hide !== false,
                    encoding: 'buffer', maxBuffer: 32 * 1024 * 1024
                }, (err, stdout, stderr) => {
                    const out = { stdout: Buffer.from(stdout || '').toString('utf8'), stderr: Buffer.from(stderr || '').toString('utf8') };
                    if (!err) return resolve({ code: 0, ...out, errorCode: null });
                    if (typeof err.code === 'number') return resolve({ code: err.code, ...out, errorCode: err.killed ? 'ETIMEDOUT' : null });
                    return resolve({ code: null, ...out, errorCode: err.killed ? 'ETIMEDOUT' : (err.code || 'EUNKNOWN') });
                });
            } catch (err) {
                resolve({ code: null, stdout: '', stderr: String(err.message), errorCode: err.code || 'EUNKNOWN' });
                return;
            }
            if (child && child.stdin) child.stdin.end();
        });
    }

    /**
     * 開一個與啟動器脫鉤的背景程式（啟動器結束後它繼續跑；DETACHED_PROCESS，主控台程式不會開主控台視窗）。
     * @param {string} file
     * @param {string[]} args
     * @param {{cwd?:string, env?:object, logFile?:string, hide?:boolean}} [o]
     *        hide：預設 true；**GUI 程式（瀏覽器、Docker Desktop、Ollama 系統匣程式）要傳 false**，否則第一個視窗會是隱藏的（檔頭）。
     *        GUI 程式本來就不開主控台，DETACHED_PROCESS 也不會多開一個，所以 false 不會冒出黑色視窗。
     * @returns {Promise<{ok:boolean, pid?:number, error?:string, errorCode?:string}>}
     */
    function spawnDetached(file, args = [], { cwd, env: childEnv, logFile, hide = true } = {}) {
        return new Promise(resolve => {
            let out = 'ignore';
            if (logFile) {
                try {
                    fs.mkdirSync(path.dirname(logFile), { recursive: true });
                    out = fs.openSync(logFile, 'a');
                } catch (err) {
                    resolve({ ok: false, error: `無法寫入 log（${logFile}）：${err.message}`, errorCode: err.code || 'EUNKNOWN' });
                    return;
                }
            }
            let settled = false;
            const done = r => {
                if (settled) return;
                settled = true;
                if (typeof out === 'number') { try { fs.closeSync(out); } catch (_) { /* 子行程有自己的一份 */ } }
                // 沒開成（例如 PATH 上沒有 ollama）時，不留下剛建立的空 log 檔
                if (!r.ok && logFile) { try { if (fs.statSync(logFile).size === 0) fs.unlinkSync(logFile); } catch (_) { /* 忽略 */ } }
                resolve(r);
            };
            let child;
            try {
                child = cp.spawn(file, args, { cwd, env: childEnv || env, detached: true, windowsHide: hide !== false, stdio: ['ignore', out, out] });
            } catch (err) {
                done({ ok: false, error: err.message, errorCode: err.code || 'EUNKNOWN' });
                return;
            }
            child.once('error', err => done({ ok: false, error: err.message, errorCode: err.code || 'EUNKNOWN' }));
            child.once('spawn', () => {
                const pid = child.pid;
                children.set(pid, { exited: false, code: null });
                child.once('exit', code => children.set(pid, { exited: true, code }));
                child.unref();
                done({ ok: true, pid });
            });
        });
    }

    /**
     * 這一輪啟動器開的背景程式結束了沒（不是這輪開的回 null）。
     * @param {number} pid
     * @returns {{exited:boolean, code:number|null}|null}
     */
    function childStatus(pid) {
        return children.get(pid) || null;
    }

    /**
     * @param {{url:string, method?:string, headers?:object, body?:any, timeoutMs?:number}} o
     * @returns {Promise<HttpResult>}
     */
    function request({ url, method = 'GET', headers = {}, body, timeoutMs = 3000 }) {
        return new Promise(resolve => {
            let settled = false;
            const done = r => { if (!settled) { settled = true; resolve(r); } };
            const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
            let req;
            try {
                req = http.request(url, {
                    method,
                    headers: {
                        accept: 'application/json',
                        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
                        ...headers
                    },
                    timeout: timeoutMs
                }, res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json = null;
                        if (/json/i.test(String(res.headers['content-type'] || ''))) {
                            try { json = JSON.parse(text); } catch (_) { json = null; }
                        }
                        done({ status: res.statusCode, json, text, errorCode: null });
                    });
                    res.on('error', err => done({ status: null, json: null, text: '', errorCode: err.code || 'EUNKNOWN' }));
                });
            } catch (err) {
                done({ status: null, json: null, text: '', errorCode: err.code || 'EINVAL' });
                return;
            }
            req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
            req.on('error', err => done({ status: null, json: null, text: '', errorCode: err.code || 'EUNKNOWN' }));
            if (payload) req.write(payload);
            req.end();
        });
    }

    /**
     * 對資料庫下一句唯讀查詢（每次開一條新連線、用完就關；不經後端的連線池）。
     * 錯誤只回訊息（pg 的錯誤訊息不含密碼），不丟錯。
     * @param {string} connectionString
     * @param {string} sql
     * @param {{timeoutMs?:number}} [o]
     * @returns {Promise<{ok:true, rows:any[]}|{ok:false, error:string, code?:string}>}
     */
    async function pgQuery(connectionString, sql, { timeoutMs = 4000 } = {}) {
        let Client;
        try {
            ({ Client } = require('pg'));
        } catch (err) {
            return { ok: false, error: '找不到 pg 套件（exam_pro 還沒 npm install？）', code: 'MODULE_NOT_FOUND' };
        }
        const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs });
        client.on('error', () => { /* 連線中途被切斷：由下面的 await 回報 */ });
        try {
            await client.connect();
            const res = await client.query(sql);
            return { ok: true, rows: res.rows };
        } catch (err) {
            return { ok: false, error: String((err && err.message) || err), code: err && err.code };
        } finally {
            try { await client.end(); } catch (_) { /* 忽略 */ }
        }
    }

    /**
     * 結束一個程序（Windows 上是 TerminateProcess）。回傳是否送出成功（程序已經不在也回 false）。
     * @param {number} pid
     */
    function killPid(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 'SIGTERM');
            return true;
        } catch (_) {
            return false;
        }
    }

    /** 程序還在不在（Windows 也能用 signal 0 查） */
    function pidAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            return err && err.code === 'EPERM';
        }
    }

    return {
        platform,
        env,
        now: () => Date.now(),
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        exists: p => { try { fs.accessSync(p); return true; } catch (_) { return false; } },
        readText: p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } },
        writeText: (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); },
        appendText: (p, s) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, s, 'utf8'); } catch (_) { /* log 寫不進去不擋啟動 */ } },
        remove: p => { try { fs.rmSync(p, { force: true }); } catch (_) { /* 忽略 */ } },
        fileSize: p => { try { return fs.statSync(p).size; } catch (_) { return 0; } },
        /** 檔案從 fromByte 起的內容（讀後端 log 最後幾行用；最多讀 64 KB） */
        readFrom: (p, fromByte = 0) => {
            try {
                const size = fs.statSync(p).size;
                const start = Math.max(fromByte, size - 65536);
                const fd = fs.openSync(p, 'r');
                try {
                    const buf = Buffer.alloc(Math.max(0, size - start));
                    fs.readSync(fd, buf, 0, buf.length, start);
                    return buf.toString('utf8');
                } finally { fs.closeSync(fd); }
            } catch (_) { return ''; }
        },
        /** 建檔（已存在就失敗）：單一執行個體的鎖用 */
        createExclusive: (p, s) => {
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, s, { encoding: 'utf8', flag: 'wx' });
                return true;
            } catch (_) { return false; }
        },
        exec,
        spawnDetached,
        childStatus,
        request,
        pgQuery,
        pidAlive,
        killPid,
        pid: process.pid
    };
}

module.exports = { createSystem };
