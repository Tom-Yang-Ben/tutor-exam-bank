// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/probes.js — 啟動與關閉共用的檢查（健康檢查、誰佔了埠、錄製偵測、docker CLI、讀 .env）
//
// 全部透過注入的 sys（lib/system.js）做 I/O；判斷規則是本檔的純函式（classifyHealth、looksLikeLegacyIndex、
// parseEnvText、portFromEnv），單元測試直接測。
// ─────────────────────────────────────────────────────────────
const path = require('path');
const w = require('./windows');
// 後端聽哪個位址（HOST）：與 server.js 同一支純函式（只依賴 node:net，node_modules 還沒裝時也載入得了）
const listenHost = require('../../../config/listenHost');

/** 與 controllers/healthController.js 的 SERVICE_NAME 相同（單元測試比對兩邊） */
const SERVICE_NAME = 'tutor-exam-bank';
const DEFAULT_PORT = 3000;

// ─────────────────────────── .env ───────────────────────────

/**
 * 讀 .env 的文字。優先用 dotenv.parse（與後端同一套規則）；node_modules 還沒裝時退回簡單的 KEY=VALUE 解析
 * （那種情況啟動器之後會停在「還沒安裝相依套件」，這裡只需要讀得出 PORT）。
 * @param {string|null} text
 * @returns {Record<string,string>}
 */
function parseEnvText(text) {
    if (!text) return {};
    try {
        return require('dotenv').parse(text);
    } catch (_) {
        const out = {};
        for (const raw of String(text).split(/\r?\n/)) {
            const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m) continue;
            let v = m[2];
            if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
            else v = v.replace(/\s+#.*$/, '');
            out[m[1]] = v;
        }
        return out;
    }
}

/**
 * 後端實際會看到的環境：.env 的值，被系統環境變數蓋過（與 dotenv 預設「不覆寫已存在的變數」相同）。
 * @param {Record<string,string>} dotenvVars
 * @param {Record<string,string|undefined>} processEnv
 */
function effectiveEnv(dotenvVars, processEnv) {
    const out = { ...dotenvVars };
    for (const [k, v] of Object.entries(processEnv || {})) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/** PORT（與 server.js 的 process.env.PORT || 3000 相同；不是合法埠號時用 3000） */
function portFromEnv(env) {
    const n = Number.parseInt(String((env && env.PORT) || ''), 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

/**
 * 後端聽的位址（HOST），以及從這台電腦要連哪個位址才問得到它。純函式。
 * 〔Owner 第六輪 DA-11＝1，2026-09-27〕後端改聽 HOST、預設 127.0.0.1；判斷規則與 server.js 同一支（config/listenHost.js）。
 *   supported:false＝HOST 只聽某個區網位址：本機的 localhost 連不到後端，app 視窗（http://localhost:<埠>/）也開不起來，
 *   啟動器與關閉捷徑直接說明（plan.js 的 host-unsupported、stopper.js），不去開一個自己連不到的後端。
 * @param {Record<string,string|undefined>} env  effectiveEnv()
 * @returns {{host:string, scope:'loopback'|'wildcard'|'specific', probeHost:string|null, supported:boolean}}
 */
function listenFromEnv(env) {
    const host = listenHost.resolveListenHost(env || {});
    const probeHost = listenHost.localProbeHost(host);
    return { host, scope: listenHost.hostScope(host), probeHost, supported: probeHost !== null };
}

// ─────────────────────────── 健康檢查 ───────────────────────────

/**
 * GET /api/health 的結果 → 狀態。純函式。
 *   ours：回應是本系統（service 名稱對得上）；dbOk＝status 'ok' 且 db.ok
 *   down：連不上（沒有程式在聽這個埠）
 *   other：有程式在聽，但不是本系統（或逾時、連線被切斷）
 *   maybe-legacy：有回應但不是健康檢查的格式（可能是沒有 /api/health 的舊版本系統，呼叫端再看首頁）
 * @param {{status:number|null, json:any, errorCode:string|null}} res
 * @param {number} port
 */
function classifyHealth(res, port) {
    if (res.errorCode === 'ECONNREFUSED' || res.errorCode === 'EADDRNOTAVAIL') return { state: 'down' };
    if (res.errorCode) return { state: 'other', detail: `${port} 埠有程式在聽，但沒有正常回應（${res.errorCode}）` };
    const j = res.json;
    if (j && j.service === SERVICE_NAME) {
        return { state: 'ours', dbOk: j.status === 'ok' && Boolean(j.db && j.db.ok === true), version: typeof j.version === 'string' ? j.version : undefined };
    }
    return { state: 'maybe-legacy', status: res.status };
}

/**
 * 首頁看起來是不是本系統（沒有 /api/health 的舊版本）。純函式。
 * @param {string} html
 */
function looksLikeLegacyIndex(html) {
    const s = String(html || '');
    return /<meta\s+name="feature-pipeline"/i.test(s) && /家教/.test(s);
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./system').createSystem>} deps.sys
 * @param {object} deps.config   lib/config.js 的設定
 * @param {Record<string,string>} deps.env  effectiveEnv()
 * @param {{appDir:string, serverInfo?:string}} deps.paths
 * @param {number} deps.port
 */
function createProbes({ sys, config, env, paths, port }) {
    // 健康檢查與關閉通道連的位址：HOST 沒寫（預設 127.0.0.1）、0.0.0.0、:: → 127.0.0.1；localhost、::1 照原值
    // （config/listenHost.js 的 localProbeHost）。HOST 只聽某個區網位址時 listen.supported 是 false，
    // 啟動器與關閉捷徑一開始就停下說明，不會走到這裡的檢查；base 仍給 127.0.0.1，只為了不留 undefined。
    const listen = listenFromEnv(env);
    const base = `http://${listenHost.urlHost(listen.probeHost || listenHost.DEFAULT_HOST)}:${port}`;

    /** @returns {Promise<{state:'ours',dbOk:boolean,legacy?:boolean,version?:string}|{state:'other',detail?:string}|{state:'down'}>} */
    async function probeHealth({ timeoutMs = 3000, retryOnTimeout = true } = {}) {
        let res = await sys.request({ url: `${base}/api/health`, timeoutMs });
        if (res.errorCode === 'ETIMEDOUT' && retryOnTimeout) {
            await sys.sleep(1000);
            res = await sys.request({ url: `${base}/api/health`, timeoutMs });
        }
        const h = classifyHealth(res, port);
        if (h.state !== 'maybe-legacy') return h;
        const index = await sys.request({ url: `${base}/`, timeoutMs, headers: { accept: 'text/html' } });
        if (index.status === 200 && looksLikeLegacyIndex(index.text)) return { state: 'ours', dbOk: true, legacy: true };
        return { state: 'other', detail: `${port} 埠上的程式回 HTTP ${h.status}，不是出題系統` };
    }

    /**
     * 誰在聽這個埠（只在 Windows 查：netstat -ano＋tasklist）。
     *   pids     ：所有在聽的 PID（啟動器用來判斷「自己開的後端有沒有聽到」）
     *   ownServer：聽著的正是 data/launcher/server.json 記的後端（上次由圖示開的）＝不是「別的程式」
     *              （健康檢查逾時時會被歸為 other；審查 dec/desktop-launcher 第 5 件）；logFile＝那個後端的 log
     * @returns {Promise<{pid:number|null, name:string|null, text:string|null, pids:number[], ownServer:boolean, logFile?:string}>}
     */
    async function describePort() {
        const none = { pid: null, name: null, text: null, pids: [], ownServer: false };
        if (sys.platform !== 'win32') return none;
        const ns = await sys.exec('netstat', ['-ano'], { timeoutMs: 20_000 });
        const pids = ns.code === 0 ? w.parseNetstatListeners(ns.stdout, port) : [];
        if (!pids.length) return none;
        const info = paths.serverInfo ? readServerInfo(paths.serverInfo) : null;
        const ownPid = info && Number.isInteger(info.pid) && pids.includes(info.pid) ? info.pid : null;
        const pid = ownPid || pids[0];
        const tl = await sys.exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 20_000 });
        const name = tl.code === 0 ? w.parseTasklistName(tl.stdout, pid) : null;
        // PID 可能被重複使用：名稱查得到時要是 node 才算
        const ownServer = ownPid !== null && (name === null || /^node(\.exe)?$/i.test(name));
        return {
            pid, name, text: name ? `${name}（PID ${pid}）` : `PID ${pid}`, pids, ownServer,
            // 那個後端實際寫的 log（以它啟動那天命名；跨夜執行的後端還在寫前一天的檔）
            ...(ownServer && info.logFile ? { logFile: String(info.logFile) } : {})
        };
    }

    /** @returns {Promise<{active:boolean|null, matches?:string[], error?:string}>} */
    async function detectRecording() {
        let list;
        try {
            if (sys.platform === 'win32') {
                const r = await sys.exec('powershell.exe', w.powershellArgs(w.PS_LIST_PROCESSES), { timeoutMs: 45_000 });
                if (r.code !== 0) return { active: null, error: r.errorCode || `PowerShell 結束碼 ${r.code}` };
                list = w.parseProcessJson(r.stdout);
            } else {
                const r = await sys.exec('ps', ['-eo', 'pid=,comm=,args='], { timeoutMs: 15_000 });
                if (r.code !== 0) return { active: null, error: r.errorCode || `ps 結束碼 ${r.code}` };
                list = w.parsePsOutput(r.stdout);
            }
        } catch (err) {
            return { active: null, error: err.message };
        }
        const matches = w.findRecordingProcesses(list, sys.pid);
        return { active: matches.length > 0, matches };
    }

    let dockerCli;   // undefined＝還沒找；null＝找不到
    /** docker CLI 的路徑（找不到回 null；找到了就記住） */
    async function resolveDockerCli({ refresh = false } = {}) {
        if (dockerCli && !refresh) return dockerCli;
        for (const c of w.dockerCliCandidates(config)) {
            if (c.checkExists && !sys.exists(c.file)) continue;
            const r = await sys.exec(c.file, ['--version'], { timeoutMs: 15_000 });
            if (r.errorCode === 'ENOENT') continue;
            dockerCli = c.file;
            return dockerCli;
        }
        dockerCli = null;
        return null;
    }

    /** docker info 成功＝Docker 引擎就緒 */
    async function dockerInfo() {
        const cli = await resolveDockerCli({ refresh: !dockerCli });
        if (!cli) return { ready: false, cliFound: false, error: '找不到 docker 指令' };
        const r = await sys.exec(cli, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 });
        if (r.code === 0) return { ready: true, cliFound: true, version: r.stdout.trim() };
        return { ready: false, cliFound: true, error: w.tailLines(r.stderr || r.stdout, 2) || r.errorCode || `結束碼 ${r.code}` };
    }

    /** 讀 data/launcher/server.json（啟動器開後端時寫的；沒有或壞掉回 null） */
    function readServerInfo(file) {
        const text = sys.readText(file);
        if (!text) return null;
        try {
            const j = JSON.parse(text);
            return j && typeof j === 'object' ? j : null;
        } catch (_) {
            return null;
        }
    }

    return { base, listen, probeHealth, describePort, detectRecording, resolveDockerCli, dockerInfo, readServerInfo, appDir: paths.appDir, env };
}

/**
 * 啟動器與關閉捷徑用到的路徑（都在 exam_pro 底下；data/ 不進版控）。
 * @param {string} appDir exam_pro 的絕對路徑
 */
function appPaths(appDir) {
    const data = path.join(appDir, 'data');
    return {
        appDir,
        envFile: path.join(appDir, '.env'),
        nodeModules: path.join(appDir, 'node_modules'),
        serverJs: path.join(appDir, 'server.js'),
        logsDir: path.join(data, 'logs'),
        launcherDir: path.join(data, 'launcher'),
        configFile: path.join(data, 'launcher', 'config.json'),
        serverInfo: path.join(data, 'launcher', 'server.json'),
        lockFile: path.join(data, 'launcher', 'launch.lock'),
        statusHtml: path.join(appDir, 'scripts', 'desktop', 'status.html')
    };
}

module.exports = {
    SERVICE_NAME, DEFAULT_PORT, parseEnvText, effectiveEnv, portFromEnv, listenFromEnv, classifyHealth, looksLikeLegacyIndex, createProbes, appPaths
};
