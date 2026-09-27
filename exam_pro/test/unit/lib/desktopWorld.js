// ─────────────────────────────────────────────────────────────
// test/unit/lib/desktopWorld.js — 模擬 Owner 那台 Windows 筆電的「世界」，給桌面啟動器的測試用
//
// createWorld(opts) 回傳一個假的 sys（介面同 scripts/desktop/lib/system.js）：
//   - 時間是假的：sleep(ms) 只把時鐘往前撥，等 Docker 240 秒的測試瞬間跑完；
//   - Docker Desktop、資料庫容器、Ollama、node server.js、瀏覽器、PowerShell（訊息框、程序清單）、netstat、tasklist
//     都依 opts 的設定與目前時間回應；
//   - 每一次 exec／spawn／request 都記在 world.calls，測試可以斷言「有沒有碰 Docker」「開了幾個視窗」。
// 不連網、不開任何程序、不寫任何檔案。
//
// 〔審查 dec/desktop-launcher〕假後端的「聽不了埠」改照 Express 5 的真實行為（原本模擬的是 Express 4 的
// 「Unhandled 'error' event」當掉，給了錯誤的信心）：
//   exit-addrinuse／exit-eacces：修正後的 server.js——印 utils/listenFailure.js 的說明、以結束碼 1 結束；
//   listen-swallowed           ：修正前的 server.js——照印「成功啟動」、不結束、不聽任何埠（健康檢查一直 ECONNREFUSED）。
// 另外記下每次 exec／spawn 的選項（hide），並模擬 taskkill /PID 與 killPid。
// ─────────────────────────────────────────────────────────────
const path = require('path');
const { listMigrationFiles } = require('../../../utils/migrationStatus');
const { listenFailureText } = require('../../../utils/listenFailure');

/** 修正後的 server.js 聽不了埠時寫進 log 的內容（與真的一樣由 listenFailureText 產生） */
function listenLog(code, port = 3000) {
    const msg = code === 'EACCES' ? `listen EACCES: permission denied 0.0.0.0:${port}` : `listen EADDRINUSE: address already in use :::${port}`;
    return `${listenFailureText(Object.assign(new Error(msg), { code }), port)}\n`;
}

const NODE = 'C:\\node\\node.exe';
const DOCKER_DESKTOP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const LOCAL = 'C:\\Users\\ben\\AppData\\Local';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OLLAMA_APP = `${LOCAL}\\Programs\\Ollama\\ollama app.exe`;
const SERVER_PID = 7100;
const POPUP_CODE = { ok: 1, cancel: 2, yes: 6, no: 7, timeout: -1 };
/** 假時鐘的起點。log 檔名用本地日期：測試一律用 TODAY（依執行測試那台電腦的時區算），不寫死日期 */
const START = Date.parse('2026-09-27T12:00:00Z');
const TODAY = require('../../../scripts/desktop/lib/windows').dateStamp(new Date(START));

/** PowerShell -EncodedCommand 的內容 */
function decodePs(args) {
    const i = args.indexOf('-EncodedCommand');
    return i === -1 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf16le');
}

/** Popup 腳本裡的文字（'…' 內，'' 還原成 '） */
function popupText(script) {
    const m = script.match(/\.Popup\('((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : '';
}

/**
 * @param {object} [o]
 */
function createWorld(o = {}) {
    let now = START;
    const files = new Map(Object.entries(o.files || {}));
    const existing = new Set(o.exists || [DOCKER_DESKTOP, EDGE, OLLAMA_APP]);
    const calls = [];
    const popups = [];
    const windows = [];
    const alive = new Set(o.alive || []);
    const popupAnswers = [...(o.popupAnswers || [])];

    const w = {
        platform: o.platform || 'win32',
        env: {
            LOCALAPPDATA: LOCAL, ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ben', ...(o.sysEnv || {})
        },
        // 已經在跑的後端：'down' | 'ours' | 'other' | 'legacy' | 'busy'（有程式在聽、健康檢查一直逾時）
        health: o.health || 'down',
        db: o.db ?? false,
        dockerCliOnPath: o.dockerCliOnPath ?? true,
        dockerEngine: o.dockerEngine ?? false,
        dockerStartsInMs: o.dockerStartsInMs ?? 30_000,
        composeCode: o.composeCode ?? 0,
        composeOutput: o.composeOutput || '',
        ollamaUp: o.ollamaUp ?? false,
        ollamaStartsInMs: o.ollamaStartsInMs ?? 5_000,
        ollamaOnPath: o.ollamaOnPath ?? false,
        ollamaModels: o.ollamaModels || ['qwen3:8b', 'qwen3-vl:8b', 'qwen3-embedding:0.6b'],
        applied: o.applied === undefined ? listMigrationFiles() : o.applied,   // null＝沒有 schema_migrations
        processes: o.processes || [],
        psFails: o.psFails ?? false,
        netstat: o.netstat || '',
        tasklist: o.tasklist || '',
        // 啟動器開的後端：'ok' | 'exit-addrinuse' | 'exit-eacces' | 'exit-crash' | 'hang' | 'listen-swallowed' | 'spawn-fail'
        server: o.server || 'ok',
        serverReadyInMs: o.serverReadyInMs ?? 8_000,
        launcherStatus: o.launcherStatus || null,     // stop 測試：(req) => HttpResult
        pidExitAfterMs: o.pidExitAfterMs ?? 2_000,    // stop 測試：送出 shutdown 之後幾毫秒行程結束（Infinity＝不結束）
        calls, popups, windows, files, existing, alive,
        dockerStartedAt: null, ollamaStartedAt: null, serverSpawnedAt: null, serverLog: null, shutdownAt: null, serverKilledAt: null,
        get now() { return now; }
    };

    const dockerReady = () => w.dockerEngine || (w.dockerStartedAt !== null && now - w.dockerStartedAt >= w.dockerStartsInMs);
    const ollamaReady = () => w.ollamaUp || (w.ollamaStartedAt !== null && now - w.ollamaStartedAt >= w.ollamaStartsInMs);
    function serverState() {
        if (w.serverSpawnedAt === null) return null;
        if (w.serverKilledAt !== null) return 'killed';
        const t = now - w.serverSpawnedAt;
        if (w.server === 'exit-addrinuse' || w.server === 'exit-eacces' || w.server === 'exit-crash') return t >= 1500 ? 'exited' : 'starting';
        if (w.server === 'hang' || w.server === 'listen-swallowed') return 'starting';
        return t >= w.serverReadyInMs ? 'ready' : 'starting';
    }
    function killServer(pid) {
        if (pid !== SERVER_PID || w.serverSpawnedAt === null || !alive.has(SERVER_PID)) return false;
        w.serverKilledAt = now;
        alive.delete(SERVER_PID);
        return true;
    }
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', errorCode: null });
    const enoent = () => ({ code: null, stdout: '', stderr: '', errorCode: 'ENOENT' });
    const refused = () => ({ status: null, json: null, text: '', errorCode: 'ECONNREFUSED' });
    const healthBody = () => ({ status: w.db ? 200 : 503, json: { service: 'tutor-exam-bank', status: w.db ? 'ok' : 'degraded', version: '1.0.0', db: { ok: w.db } }, text: '', errorCode: null });

    const sys = {
        platform: w.platform,
        env: w.env,
        pid: 4242,
        now: () => now,
        sleep: async ms => { now += ms; },
        exists: p => existing.has(p) || files.has(p),
        readText: p => (files.has(p) ? files.get(p) : null),
        writeText: (p, s) => { files.set(p, s); },
        appendText: (p, s) => { files.set(p, (files.get(p) || '') + s); },
        remove: p => { files.delete(p); },
        fileSize: p => Buffer.byteLength(files.get(p) || ''),
        readFrom: (p, from = 0) => Buffer.from(files.get(p) || '').subarray(from).toString('utf8'),
        createExclusive: (p, s) => { if (files.has(p)) return false; files.set(p, s); return true; },

        async exec(file, args = [], opts = {}) {
            calls.push({ kind: 'exec', file, args, opts });
            const base = path.win32.basename(file).toLowerCase();
            if (base === 'docker' || base === 'docker.exe') {
                if (base === 'docker' && !w.dockerCliOnPath) return enoent();
                if (args[0] === '--version') return ok('Docker version 29.0.0');
                if (args[0] === 'info') return dockerReady() ? ok('29.0.0\n') : { code: 1, stdout: '', stderr: 'error during connect: this error may indicate that the docker daemon is not running', errorCode: null };
                if (args[0] === 'compose' && args[1] === 'up') {
                    if (!dockerReady()) return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', errorCode: null };
                    if (w.composeCode === 0) w.db = true;
                    return { code: w.composeCode, stdout: '', stderr: w.composeOutput || (w.composeCode ? 'Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:5442' : ' Container exam_pg  Healthy'), errorCode: null };
                }
                if (args[0] === 'compose' && args[1] === 'stop') { w.db = false; return ok(); }
                if (args[0] === 'desktop' && args[1] === 'stop') return ok();
                return ok();
            }
            if (base === 'powershell.exe') {
                const script = decodePs(args);
                if (script.includes('Get-CimInstance')) {
                    if (w.psFails) return { code: 1, stdout: '', stderr: 'Get-CimInstance : Access denied', errorCode: null };
                    return ok(w.processes.length ? JSON.stringify(w.processes.length === 1 ? w.processes[0] : w.processes) : '');
                }
                if (script.includes('.Popup(')) {
                    popups.push({ text: popupText(script), script });
                    const ans = popupAnswers.length ? popupAnswers.shift() : 'ok';
                    return ok(`${POPUP_CODE[ans]}\r\n`);
                }
                if (script.includes('CreateShortcut')) return ok('CREATED x\r\n');
                return ok();
            }
            if (base === 'netstat') return ok(w.netstat);
            if (base === 'tasklist') return ok(w.tasklist);
            if (base === 'rundll32.exe') { windows.push({ via: 'default', url: args[1] }); return ok(); }
            if (base === 'xdg-open' || base === 'open') { windows.push({ via: 'default', url: args[0] }); return ok(); }
            if (base === 'taskkill') {
                const i = args.indexOf('/PID');
                if (i !== -1) return killServer(Number(args[i + 1])) ? ok() : { code: 128, stdout: '', stderr: 'ERROR: not found', errorCode: null };
                return ok();
            }
            if (base === 'ps') return ok(w.processes.map(p => `${p.ProcessId} ${p.Name} ${p.CommandLine}`).join('\n'));
            return enoent();
        },

        async spawnDetached(file, args = [], opts = {}) {
            calls.push({ kind: 'spawn', file, args, opts });
            const base = path.win32.basename(file).toLowerCase();
            if (file === DOCKER_DESKTOP) { w.dockerStartedAt = now; return { ok: true, pid: 9001 }; }
            if (base === 'msedge.exe' || base === 'chrome.exe') {
                const url = (args.find(a => a.startsWith('--app=')) || '').slice('--app='.length);
                windows.push({ via: base === 'msedge.exe' ? 'edge' : 'chrome', url, args });
                return { ok: true, pid: 9100 + windows.length };
            }
            if (base === 'ollama app.exe' || base === 'ollama.exe' || base === 'ollama') {
                if (base === 'ollama' && !w.ollamaOnPath) return { ok: false, error: 'spawn ollama ENOENT', errorCode: 'ENOENT' };
                w.ollamaStartedAt = now;
                return { ok: true, pid: 9200 };
            }
            if (file === NODE) {
                if (w.server === 'spawn-fail') return { ok: false, error: 'spawn EPERM', errorCode: 'EPERM' };
                w.serverSpawnedAt = now;
                w.serverLog = opts.logFile;
                w.serverEnv = opts.env;
                alive.add(SERVER_PID);
                if (w.server === 'listen-swallowed') {
                    // 修正前：Express 5 把 listen 錯誤交給 callback，callback 不看 err，照印成功
                    files.set(opts.logFile, `${files.get(opts.logFile) || ''}🚀 家教題庫後端系統已成功安全啟動：http://localhost:3000\n`);
                }
                return { ok: true, pid: SERVER_PID };
            }
            return { ok: false, error: `spawn ${file} ENOENT`, errorCode: 'ENOENT' };
        },

        childStatus(pid) {
            if (pid !== SERVER_PID || w.serverSpawnedAt === null) return null;
            if (serverState() === 'killed') return { exited: true, code: null };
            if (serverState() !== 'exited') return { exited: false, code: null };
            if (!w._logged) {
                w._logged = true;
                const text = w.server === 'exit-addrinuse' ? listenLog('EADDRINUSE')
                    : w.server === 'exit-eacces' ? listenLog('EACCES')
                        : 'Error: 缺少 DATABASE_URL。請在 exam_pro/.env 設定\n';
                files.set(w.serverLog, (files.get(w.serverLog) || '') + text);
                alive.delete(SERVER_PID);
            }
            return { exited: true, code: 1 };
        },

        async request(req) {
            calls.push({ kind: 'request', ...req });
            const u = new URL(req.url);
            if (u.port === '11434') {
                if (!ollamaReady()) return refused();
                return { status: 200, json: { models: w.ollamaModels.map(name => ({ name })) }, text: '', errorCode: null };
            }
            if (u.pathname.startsWith('/api/launcher/')) {
                if (!w.launcherStatus) return { status: 404, json: null, text: 'Cannot GET', errorCode: null };
                const r = w.launcherStatus(req, w);
                if (u.pathname === '/api/launcher/shutdown' && r.status === 202) w.shutdownAt = now;
                return r;
            }
            const st = serverState();
            if (st === 'ready') return healthBody();
            if (st === 'starting' || st === 'exited' || st === 'killed') return refused();
            if (w.health === 'down') return refused();
            if (w.health === 'busy') return { status: null, json: null, text: '', errorCode: 'ETIMEDOUT' };
            if (w.health === 'ours') {
                if (w.shutdownAt !== null && now - w.shutdownAt >= w.pidExitAfterMs) return refused();
                return healthBody();
            }
            if (w.health === 'legacy') {
                if (u.pathname === '/api/health') return { status: 404, json: { message: 'not found' }, text: '', errorCode: null };
                return { status: 200, json: null, text: '<meta name="feature-pipeline" content="true"><title>家教專用數學物理題庫系統</title>', errorCode: null };
            }
            return { status: 200, json: null, text: '<html>some other app</html>', errorCode: null };
        },

        async pgQuery(url, sql) {
            calls.push({ kind: 'pg', url, sql });
            if (!w.db) return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:5442', code: 'ECONNREFUSED' };
            if (/schema_migrations/.test(sql)) {
                if (w.applied === null) return { ok: false, error: 'relation "schema_migrations" does not exist', code: '42P01' };
                return { ok: true, rows: w.applied.map(version => ({ version })) };
            }
            return { ok: true, rows: [{ '?column?': 1 }] };
        },

        pidAlive(pid) {
            if (pid === SERVER_PID && w.health === 'ours' && w.shutdownAt !== null) return now - w.shutdownAt < w.pidExitAfterMs;
            return alive.has(pid);
        },

        killPid(pid) {
            calls.push({ kind: 'kill', pid });
            return killServer(pid);
        }
    };
    w.sys = sys;
    return w;
}

module.exports = { createWorld, decodePs, popupText, listenLog, START, TODAY, NODE, DOCKER_DESKTOP, EDGE, CHROME, OLLAMA_APP, LOCAL, SERVER_PID };
