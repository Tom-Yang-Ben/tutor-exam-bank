// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/actions.js — 桌面啟動器每一步的執行（I/O 全部經注入的 sys；docs/desktop-launcher.md 第 7.1 節）
//
// lib/plan.js 的 nextAction 說「下一步做什麼」，這裡的同名函式真的去做，回傳要併進 facts 的那一塊。
// 每一步都不丟錯：失敗寫進回傳的事實（例如 {db:{reachable:false, error}}），由 plan 決定是報錯還是警告。
// 終止的三種（open-app／finish／fail）由 lib/launcher.js 交給畫面處理，不在這裡。
// ─────────────────────────────────────────────────────────────
const path = require('path');
const crypto = require('crypto');
const w = require('./windows');
const { ollamaNeed, missingModels } = require('./models');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const { listMigrationFiles, compareMigrations } = require(path.join(APP_DIR, 'utils', 'migrationStatus'));

/** 等待迴圈的間隔 */
const POLL = Object.freeze({ dockerMs: 3000, dbMs: 2000, ollamaMs: 2000, serverMs: 1000 });

/** 從 server.json 判斷「上一次關閉的後端還在等背景工作收尾」 */
function drainingFrom(info, { now, alive }) {
    if (!info || !info.pid || !info.shutdownRequestedAt) return null;
    const started = Date.parse(info.shutdownRequestedAt);
    const graceMs = Number(info.graceMs) || 0;
    if (!Number.isFinite(started)) return null;
    const untilMs = started + graceMs + 60_000;
    if (now > untilMs || !alive(info.pid)) return null;
    return { pid: info.pid, untilMs };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./system').createSystem>} deps.sys
 * @param {object} deps.config
 * @param {Record<string,string>} deps.env         effectiveEnv（.env＋系統環境）
 * @param {ReturnType<import('./probes').appPaths>} deps.paths
 * @param {{port:number, appUrl:string, nodePath:string}} deps.ctx
 * @param {{openStatusWindow:Function, note:Function}} deps.ui
 * @param {ReturnType<import('./probes').createProbes>} deps.probes
 * @param {(line:string)=>void} [deps.log]
 */
function createActions({ sys, config, env, paths, ctx, ui, probes, log = () => { } }) {
    const databaseUrl = String(env.DATABASE_URL || '').trim();
    let need = null;

    const elapsedSec = started => Math.round((sys.now() - started) / 1000);

    async function probeDb() {
        if (!databaseUrl) return { reachable: false, error: '.env 沒有設定 DATABASE_URL' };
        const r = await sys.pgQuery(databaseUrl, 'SELECT 1', { timeoutMs: 4000 });
        return r.ok ? { reachable: true } : { reachable: false, error: r.error };
    }

    async function probeOllama() {
        const r = await sys.request({ url: `${need.host}/api/tags`, timeoutMs: 3000 });
        if (r.status === 200) return { reachable: true, missing: missingModels(r.json, need.models) };
        return { reachable: false, error: r.errorCode || `HTTP ${r.status}` };
    }

    return {
        'probe-health': async () => ({ health: await probes.probeHealth() }),

        'open-status-window': async () => ({ statusWindow: await ui.openStatusWindow() }),

        'describe-port': async () => ({ portOwner: await probes.describePort() }),

        'check-setup': async () => ({
            setup: {
                envFile: sys.exists(paths.envFile),
                nodeModules: sys.exists(paths.nodeModules),
                databaseUrl: Boolean(databaseUrl),
                draining: drainingFrom(probes.readServerInfo(paths.serverInfo), { now: sys.now(), alive: pid => sys.pidAlive(pid) })
            }
        }),

        'detect-recording': async () => ({ recording: await probes.detectRecording() }),

        'probe-db': async () => ({ db: await probeDb() }),

        'probe-docker': async () => ({ docker: await probes.dockerInfo() }),

        'launch-docker': async () => {
            const p = config.dockerDesktopPath;
            if (!sys.exists(p)) return { dockerLaunch: { ok: false, reason: 'not-found', path: p } };
            const r = await sys.spawnDetached(p, [], { cwd: path.win32.dirname(p) });
            return { dockerLaunch: r.ok ? { ok: true, path: p } : { ok: false, reason: 'spawn-failed', path: p, error: r.error } };
        },

        'wait-docker': async () => {
            const started = sys.now();
            const limitMs = config.dockerReadyTimeoutSec * 1000;
            for (;;) {
                const d = await probes.dockerInfo();
                if (d.ready) return { dockerWait: { ready: true, waitedMs: sys.now() - started } };
                if (sys.now() - started >= limitMs) return { dockerWait: { ready: false, waitedMs: sys.now() - started } };
                ui.note(`等 Docker Desktop 就緒…已等 ${elapsedSec(started)} 秒（最多 ${config.dockerReadyTimeoutSec} 秒）`);
                await sys.sleep(POLL.dockerMs);
            }
        },

        'compose-up': async () => {
            const cli = await probes.resolveDockerCli();
            if (!cli) return { compose: { ok: false, error: '找不到 docker 指令' } };
            ui.note('啟動資料庫容器（docker compose up -d --wait；第一次要下載映像，可能要幾分鐘）…');
            const r = await sys.exec(cli, ['compose', 'up', '-d', '--wait'], { cwd: paths.appDir, timeoutMs: config.composeTimeoutSec * 1000 });
            const outputTail = w.tailLines(`${r.stdout}\n${r.stderr}`, 15);
            if (r.code === 0) return { compose: { ok: true } };
            const why = r.errorCode === 'ETIMEDOUT' ? `超過 ${config.composeTimeoutSec} 秒` : (r.errorCode || `結束碼 ${r.code}`);
            const lastLine = outputTail.split('\n').pop() || '';
            return { compose: { ok: false, error: lastLine ? `${why}；${lastLine}` : why, outputTail } };
        },

        'wait-db': async () => {
            const started = sys.now();
            const limitMs = config.dbReadyTimeoutSec * 1000;
            for (;;) {
                const d = await probeDb();
                if (d.reachable || sys.now() - started >= limitMs) return { dbAfterCompose: d };
                ui.note(`等資料庫接受連線…已等 ${elapsedSec(started)} 秒`);
                await sys.sleep(POLL.dbMs);
            }
        },

        'resolve-ollama-need': async () => {
            need = ollamaNeed(env, { exists: p => sys.exists(p), platform: sys.platform });
            return { ollamaNeed: need };
        },

        'probe-ollama': async () => ({ ollama: await probeOllama() }),

        'launch-ollama': async () => {
            if (!need.local) return { ollamaLaunch: { ok: false, reason: 'remote-host' } };
            let hostPort = '127.0.0.1:11434';
            try { hostPort = new URL(need.host).host; } catch (_) { /* 用預設 */ }
            let lastError = null;
            for (const c of w.ollamaCandidates(config, sys.env)) {
                if (c.checkExists && !sys.exists(c.file)) continue;
                const serve = c.method === 'serve';
                const r = await sys.spawnDetached(c.file, c.args, {
                    // ollama serve 依 OLLAMA_HOST 決定聽哪裡：與 .env 的一致（系統匣程式讀使用者環境變數，不改）
                    env: serve ? { ...sys.env, OLLAMA_HOST: hostPort } : undefined,
                    logFile: serve ? path.join(paths.logsDir, `ollama-${w.dateStamp(new Date(sys.now()))}.log`) : undefined
                });
                if (r.ok) return { ollamaLaunch: { ok: true, method: c.method, path: c.file } };
                if (r.errorCode === 'ENOENT') continue;
                lastError = r.error;
            }
            return { ollamaLaunch: lastError ? { ok: false, reason: 'spawn-failed', error: lastError } : { ok: false, reason: 'not-found' } };
        },

        'wait-ollama': async () => {
            const started = sys.now();
            const limitMs = config.ollamaReadyTimeoutSec * 1000;
            for (;;) {
                const o = await probeOllama();
                if (o.reachable) return { ollamaWait: { ready: true, missing: o.missing, waitedMs: sys.now() - started } };
                if (sys.now() - started >= limitMs) return { ollamaWait: { ready: false, waitedMs: sys.now() - started } };
                ui.note(`等 Ollama 就緒…已等 ${elapsedSec(started)} 秒（最多 ${config.ollamaReadyTimeoutSec} 秒）`);
                await sys.sleep(POLL.ollamaMs);
            }
        },

        // 只讀：列出沒套的 migration，不執行 migrate（升級要停服務、備份、快照比對，deployment_and_operations.md §3.6）
        'check-migrations': async () => {
            let files;
            try {
                files = listMigrationFiles();
            } catch (err) {
                return { migrations: { ok: false, error: `讀不到 migrations 資料夾（${err.message}）` } };
            }
            const r = await sys.pgQuery(databaseUrl, 'SELECT version FROM schema_migrations ORDER BY version', { timeoutMs: 5000 });
            let applied;
            if (r.ok) applied = r.rows.map(x => x.version);
            else if (r.code === '42P01') applied = [];   // 還沒跑過 migrate（沒有 schema_migrations）
            else return { migrations: { ok: false, error: r.error } };
            const cmp = compareMigrations(files, applied);
            return { migrations: { ok: true, pending: cmp.pending, unknown: cmp.unknown, latest: cmp.latestApplied, appliedCount: applied.length } };
        },

        'spawn-server': async () => {
            const logFile = path.join(paths.logsDir, `server-${w.dateStamp(new Date(sys.now()))}.log`);
            sys.appendText(logFile, `\n===== ${w.timeStamp(new Date(sys.now()))} 桌面啟動器啟動後端（node server.js）=====\n`);
            const logOffset = sys.fileSize(logFile);
            // 一次性的權杖：只有這個後端認得，關閉捷徑從 server.json 讀（services/launcherControl.js）
            const token = crypto.randomBytes(32).toString('hex');
            const r = await sys.spawnDetached(ctx.nodePath, [paths.serverJs], {
                cwd: paths.appDir,
                // 與 npm start 相同：系統環境原樣帶過去（不帶啟動器讀到的 .env，後端自己讀），只多一個權杖
                env: { ...sys.env, LAUNCHER_CONTROL_TOKEN: token },
                logFile
            });
            if (!r.ok) return { server: { spawned: false, error: r.error, logFile } };
            sys.writeText(paths.serverInfo, `${JSON.stringify({
                pid: r.pid, port: ctx.port, token, logFile, startedAt: new Date(sys.now()).toISOString()
            }, null, 2)}\n`);
            log(`後端 PID ${r.pid}，log：${logFile}`);
            return { server: { spawned: true, pid: r.pid, logFile, logOffset } };
        },

        'wait-server': async (facts) => {
            const { pid, logFile, logOffset = 0 } = facts.server;
            const started = sys.now();
            const limitMs = config.serverReadyTimeoutSec * 1000;
            const tail = () => w.tailLines(sys.readFrom(logFile, logOffset), 25);
            for (;;) {
                const st = sys.childStatus(pid);
                if (st && st.exited) {
                    const logTail = tail();
                    return { serverWait: { ready: false, reason: 'exited', exitCode: st.code, logTail, addrInUse: w.isAddrInUse(logTail) } };
                }
                const h = await probes.probeHealth({ timeoutMs: 2000, retryOnTimeout: false });
                if (h.state === 'ours') return { serverWait: { ready: true, dbOk: h.dbOk } };
                if (sys.now() - started >= limitMs) return { serverWait: { ready: false, reason: 'timeout', logTail: tail() } };
                ui.note(`等後端就緒…已等 ${elapsedSec(started)} 秒（載入模組約需十幾秒）`);
                await sys.sleep(POLL.serverMs);
            }
        }
    };
}

module.exports = { createActions, drainingFrom, POLL };
