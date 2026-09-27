// ─────────────────────────────────────────────────────────────
// desktop/lib/startup.js — 開啟時的檢查與啟動（沿用桌面啟動器 A 的 plan；docs/desktop-app-design.md 第 6.1 節）
//
// 檢查順序、每一步的做法與錯誤訊息都用 A 的 exam_pro/scripts/desktop/lib/{plan,actions,probes}.js：
//   基本檢查（.env、node_modules、DATABASE_URL）→ 錄製偵測 → 資料庫（連得上就不碰 Docker；否則開 Docker Desktop、
//   docker compose up -d --wait、等資料庫）→ Ollama（失敗只警告）→ migration（只讀、只提示）→ 後端 → 完成。
// 桌面版只換掉和「後端怎麼開」有關的五步（createDesktopActions）：
//   probe-health  ：不看 .env 的 PORT 上有沒有系統在跑——桌面版一律開自己的後端（空埠、只綁 127.0.0.1）；
//                   那個埠上有網頁版或 A 的後端，改成一條警告（other-backend，見 spawn-server）。
//   open-status-window：啟動畫面開在 Electron 的視窗裡（lib/statusUi.js）。
//   spawn-server  ：先查有沒有別的後端連著同一個庫（pg_stat_activity 的 application_name＝'tutor-exam-bank'，
//                   config/db.js 第 35 項；以及 .env 的 PORT 上的健康檢查）→ 挑一個空埠 → utilityProcess 開 backend-entry.js。
//   wait-server   ：等後端聽到埠（ready 訊息）→ 用 A 的健康檢查確認它回應、資料庫連得上。
//                   挑的埠在開起來之前被別人搶走（EADDRINUSE）時換一個埠重開，最多再試 2 次。
//   describe-port／stop-server：用不到（埠是自己挑的空埠）；保留成不做事的版本，A 的 plan 走到時照樣前進。
// 迴圈本身（runStartup）與 A 的 lib/launcher.js 的 runLaunch 相同，只多了「換成桌面版說法」與桌面版自己的警告。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { desktopPaths } = require('./paths');
const { backendEnv } = require('./config');
const { otherBackendWarning, adaptWarning, desktopFailure } = require('./wording');

const LIB = desktopPaths().launcherLib;
const plan = require(path.join(LIB, 'plan'));
const w = require(path.join(LIB, 'windows'));

/**
 * 桌面版的後端一律只聽這個位址（backend-entry.js，DA-11＝1），和 .env 的 HOST 無關。
 * 健康檢查自己的後端時把它交給 makeProbes：A 的 createProbes 在 DA-11 的網頁版那一半（dec/r7-decisions-host）合併後
 * 會照 env.HOST 決定連哪個位址；.env 寫了 HOST=localhost 之類時，不能拿它去問一個只聽 127.0.0.1 的後端。
 * 查「網頁版有沒有開著」（.env 的 PORT）則照 .env 的 HOST——網頁版聽的就是那裡。
 */
const OWN_BACKEND_HOST = '127.0.0.1';
/** 同一種步驟最多做幾次（與 A 相同） */
const MAX_REPEAT = 2;
/** 挑的空埠被搶走時最多再試幾次 */
const PORT_RETRIES = 2;
/** 查「有沒有別的後端連著同一個庫」的 SQL：只算同一個庫、不算自己這條連線 */
const OTHER_CONNECTIONS_SQL =
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'tutor-exam-bank' " +
    'AND datname = current_database() AND pid <> pg_backend_pid()';

/**
 * @param {object} deps
 * @param {Record<string, Function>} deps.base      A 的 createActions(...) 的結果
 * @param {ReturnType<import('./backendHost').createBackendHost>} deps.host
 * @param {object} deps.sys                          A 的 createSystem()
 * @param {(o:{port:number, host?:string}) => {probeHealth:Function}} deps.makeProbes
 *        port（與 host：有給就當成 env.HOST，見 OWN_BACKEND_HOST）→ A 的 createProbes(...)
 * @param {Record<string,string>} deps.dotenvVars
 * @param {Record<string,string>} deps.env           effectiveEnv（.env＋系統環境）
 * @param {object} deps.config                       A 的啟動設定（serverReadyTimeoutSec…）
 * @param {object} deps.ctx                          plan 的 context（port、appUrl 在後端開好後才知道，這裡會改它）
 * @param {{openStatusWindow:Function}} deps.ui
 * @param {() => Promise<number>} deps.pickPort
 * @param {string} deps.serverLog
 * @param {(line:string)=>void} [deps.log]
 * @param {() => Date} [deps.now]
 */
function createDesktopActions({ base, host, sys, makeProbes, dotenvVars, env, config, ctx, ui, pickPort, serverLog, log = () => { }, now = () => new Date() }) {
    const databaseUrl = String(env.DATABASE_URL || '').trim();
    const envPort = require(path.join(LIB, 'probes')).portFromEnv(env);
    let jobsPaused = false;
    let attempts = 0;

    /** 有沒有別的後端（網頁版、A 的後端、維護工具）連著同一個庫 */
    async function detectOtherBackend() {
        const q = databaseUrl ? await sys.pgQuery(databaseUrl, OTHER_CONNECTIONS_SQL, { timeoutMs: 4000 }) : { ok: false };
        const connections = q.ok && q.rows && q.rows[0] ? Number(q.rows[0].n) : null;
        const h = await makeProbes({ port: envPort }).probeHealth({ timeoutMs: 1500, retryOnTimeout: false });
        return { connections, webRunning: h.state === 'ours', webPort: envPort };
    }

    async function fork() {
        const port = await pickPort();
        ctx.port = port;
        const banner = `\n===== ${w.timeStamp(now())} 桌面版啟動後端（utilityProcess，只聽 127.0.0.1:${port}）` +
            `${jobsPaused ? '；錄製中，暫停背景工作（JOB_RUNNER=off）' : ''} =====\n`;
        const r = await host.start({ env: backendEnv({ systemEnv: sys.env, dotenvVars, port, jobsPaused }), banner });
        return { ...r, port };
    }

    return {
        ...base,

        'probe-health': async () => ({ health: { state: 'down' } }),

        'open-status-window': async () => ({ statusWindow: await ui.openStatusWindow() }),

        'describe-port': async () => ({ portOwner: { pid: null, name: null, text: null, pids: [], ownServer: false } }),

        'spawn-server': async (facts = {}) => {
            jobsPaused = Boolean(facts.recording && facts.recording.active === true && facts.recording.pauseJobs);
            let otherBackend = null;
            try { otherBackend = await detectOtherBackend(); } catch (err) { log(`查不到有沒有別的後端：${err && err.message}`); }
            attempts = 0;
            const r = await fork();
            if (!r.ok) return { server: { spawned: false, error: r.error, logFile: serverLog }, otherBackend };
            log(`後端 PID ${r.pid}，埠 ${r.port}，記錄檔：${serverLog}${jobsPaused ? '（錄製中，背景工作暫停）' : ''}`);
            return { server: { spawned: true, pid: r.pid, logFile: serverLog, port: r.port, ...(jobsPaused ? { jobsPaused: true } : {}) }, otherBackend };
        },

        'wait-server': async () => {
            const started = sys.now();
            const limitMs = config.serverReadyTimeoutSec * 1000;
            for (;;) {
                const left = Math.max(1000, limitMs - (sys.now() - started));
                const r = await host.waitReady({ timeoutMs: left });
                if (!r.ready) {
                    const listenError = w.listenErrorCode(r.logTail);
                    // 挑的空埠在後端聽之前被別人搶走：換一個埠重開
                    if (r.reason === 'exited' && listenError === 'EADDRINUSE' && attempts < PORT_RETRIES) {
                        attempts += 1;
                        log(`埠 ${ctx.port} 被搶走了，換一個埠重開後端（第 ${attempts} 次）`);
                        const again = await fork();
                        if (again.ok) continue;
                    }
                    if (r.reason === 'timeout') host.kill();   // 不留一個沒有回應的後端
                    return {
                        serverWait: {
                            ready: false, reason: r.reason, exitCode: r.exitCode, logTail: w.tailLines(r.logTail, 25),
                            addrInUse: listenError === 'EADDRINUSE', listenError, childAlive: false
                        }
                    };
                }
                ctx.port = r.port;
                ctx.appUrl = `${r.url}/`;
                const probes = makeProbes({ port: r.port, host: OWN_BACKEND_HOST });
                for (;;) {
                    const h = await probes.probeHealth({ timeoutMs: 2000, retryOnTimeout: false });
                    if (h.state === 'ours') return { serverWait: { ready: true, dbOk: h.dbOk } };
                    if (!host.alive) break;
                    if (sys.now() - started >= limitMs) {
                        host.kill();
                        return { serverWait: { ready: false, reason: 'timeout', logTail: w.tailLines(host.tail, 25), childAlive: false } };
                    }
                    await sys.sleep(1000);
                }
                // 健康檢查的途中後端結束了：回頭讓 waitReady 回報結束碼與記錄檔
            }
        },

        'stop-server': async (facts = {}) => {
            host.kill();
            return { serverStop: { pid: facts.server && facts.server.pid, stopped: true } };
        }
    };
}

/**
 * 桌面版自己的警告（放在 A 的警告後面）。純函式。
 * @param {object} facts
 */
function desktopWarnings(facts) {
    const out = [];
    const other = otherBackendWarning(facts.otherBackend);
    if (other) out.push(other);
    return out;
}

/**
 * 全部警告：A 的（換成桌面版說法）＋桌面版的。純函式。
 * @param {object} facts
 */
function collectAllWarnings(facts) {
    return [...plan.collectWarnings(facts).map(adaptWarning), ...desktopWarnings(facts)];
}

/**
 * facts → plan.nextAction → actions[type]() → 併回 facts → …，直到 finish／fail（與 A 的 runLaunch 相同的迴圈）。
 * @param {object} o
 * @param {Record<string, Function>} o.actions
 * @param {ReturnType<import('./statusUi').createStatusUi>} o.ui
 * @param {object} o.ctx
 * @param {(line:string)=>void} [o.log]
 * @param {object} [o.facts]
 * @returns {Promise<{ok:boolean, action:object, facts:object, warnings:Array<{code:string,text:string}>, failure?:object}>}
 */
async function runStartup({ actions, ui, ctx, log = () => { }, facts: initial = {} }) {
    const facts = { ...initial };
    const counts = new Map();
    let action = null;
    const shown = a => (a && a.type === 'fail' ? { ...a, ...desktopFailure(a, facts, ctx) } : a);
    const publish = a => ui.set({ steps: plan.describeSteps(facts, shown(a)), warnings: collectAllWarnings(facts), note: '' });
    try {
        for (;;) {
            action = plan.nextAction(facts, ctx);
            if (action.type === 'open-app') action = { type: 'finish', url: ctx.appUrl, reason: 'already-running' };
            publish(action);
            if (plan.isTerminal(action)) break;
            const n = (counts.get(action.type) || 0) + 1;
            counts.set(action.type, n);
            if (n > MAX_REPEAT) throw new Error(`決策迴圈沒有前進（${action.type} 做了第 ${n} 次）`);
            const fn = actions[action.type];
            if (typeof fn !== 'function') throw new Error(`沒有實作的步驟：${action.type}`);
            log(`→ ${action.type}`);
            const patch = await fn(facts, action);
            Object.assign(facts, patch);
            log(`  ${summarize(patch)}`);
        }
    } catch (err) {
        log(`！桌面版內部錯誤：${(err && err.stack) || err}`);
        action = plan.fail('internal', facts, ctx, { detail: String((err && err.message) || err) });
        publish(action);
    }

    const warnings = collectAllWarnings(facts);
    for (const x of warnings) log(`⚠ ${x.text}`);
    if (action.type === 'fail') {
        const failure = desktopFailure(action, facts, ctx);
        log(`✕ ${failure.title}：${failure.message}`);
        await ui.fail(failure, warnings);
        return { ok: false, action, facts, warnings, failure };
    }
    log(`啟動完成（${action.reason}）：${action.url}`);
    await ui.finish(action.url, warnings);
    return { ok: true, action, facts, warnings };
}

/** 一步的結果縮成一行給記錄檔（不印權杖；長字串截短）。純函式。 */
function summarize(patch) {
    return Object.entries(patch || {}).map(([k, v]) => {
        const safe = v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).filter(([kk]) => !/token|key/i.test(kk)).map(([kk, vv]) => [kk, typeof vv === 'string' && vv.length > 300 ? `${vv.slice(0, 300)}…` : vv]))
            : v;
        return `${k}=${JSON.stringify(safe)}`;
    }).join(' ');
}

module.exports = { createDesktopActions, runStartup, desktopWarnings, collectAllWarnings, summarize, OTHER_CONNECTIONS_SQL, OWN_BACKEND_HOST, PORT_RETRIES, MAX_REPEAT };
