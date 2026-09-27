// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherPlan.test.js — 桌面啟動器的決策邏輯（scripts/desktop/lib/plan.js；docs/desktop-launcher.md 第 7.1 節）
//
// 各種狀態組合 → 下一步。純函式，不碰任何 I/O。整個流程（真的執行每一步）另見 desktopLauncherRun.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const plan = require('../../scripts/desktop/lib/plan');

const ctx = { port: 3000, appUrl: 'http://localhost:3000/', dockerReadyTimeoutSec: 240, serverReadyTimeoutSec: 120 };
const next = f => plan.nextAction(f, ctx);

/** 一路順利走到「要啟動後端」之前的事實（每個測試再改自己關心的那一塊） */
function healthyUntilServer(over = {}) {
    return {
        health: { state: 'down' },
        statusWindow: { ok: true, via: 'edge' },
        setup: { envFile: true, nodeModules: true, databaseUrl: true, draining: null },
        recording: { active: false, matches: [] },
        db: { reachable: true },
        ollamaNeed: { needed: true, models: ['qwen3:8b'], host: 'http://127.0.0.1:11434', local: true, ocrNeeded: false, ocrFound: null },
        ollama: { reachable: true, missing: [] },
        migrations: { ok: true, pending: [], unknown: [], latest: '0020_output_truncated_review.sql', appliedCount: 20 },
        ...over
    };
}

describe('nextAction：開頭（健康檢查、啟動畫面、埠）', () => {
    test('什麼都不知道 → 先健康檢查', () => {
        assert.deepEqual(next({}), { type: 'probe-health' });
    });

    test('已在跑、資料庫正常 → 直接開 app 視窗（不開啟動畫面、不檢查任何東西）', () => {
        assert.deepEqual(next({ health: { state: 'ours', dbOk: true } }), { type: 'open-app', url: ctx.appUrl, reason: 'already-running' });
        assert.equal(next({ health: { state: 'ours', dbOk: true, legacy: true } }).type, 'open-app');
    });

    test('沒在跑、埠被佔、已在跑但資料庫斷線 → 先開啟動畫面', () => {
        for (const health of [{ state: 'down' }, { state: 'other' }, { state: 'ours', dbOk: false }]) {
            assert.equal(next({ health }).type, 'open-status-window', JSON.stringify(health));
        }
    });

    // 〔Owner 第六輪 DA-11＝1，2026-09-27〕後端改聽 HOST（預設 127.0.0.1）
    test('HOST 只聽某個區網位址（facts.listen.supported:false）→ 先開啟動畫面、再報 host-unsupported；不做健康檢查', () => {
        const listen = { host: '192.168.1.10', scope: 'specific', supported: false };
        assert.deepEqual(next({ listen }), { type: 'open-status-window' });
        for (const statusWindow of [{ ok: true, via: 'edge' }, { ok: false, error: 'x' }]) {
            const a = next({ listen, statusWindow });
            assert.equal(a.type, 'fail');
            assert.equal(a.code, 'host-unsupported');
            assert.match(a.message, /HOST 是「192\.168\.1\.10」/);
            assert.match(a.message, /http:\/\/localhost:3000\//);
            assert.match(a.hint.join('\n'), /支援的 HOST：不寫、127\.0\.0\.1、localhost、::1、0\.0\.0\.0、::/);
            assert.match(a.hint.join('\n'), /刪掉 \.env 的 HOST/);
            assert.match(a.hint.join('\n'), /HOST=0\.0\.0\.0/);
        }
        assert.equal(plan.stepOfFailure('host-unsupported'), 'check');
        // 支援的 HOST 不放進 facts（launcher.initialFacts），放了 supported:true 也不影響流程
        assert.deepEqual(next({ listen: { host: '0.0.0.0', supported: true } }), { type: 'probe-health' });
        const { initialFacts } = require('../../scripts/desktop/lib/launcher');
        assert.deepEqual(initialFacts({ configWarnings: [], listen: { host: '127.0.0.1', scope: 'loopback', probeHost: '127.0.0.1', supported: true } }), {});
        assert.deepEqual(initialFacts({ configWarnings: ['x'], listen: { host: '10.0.0.5', scope: 'specific', probeHost: null, supported: false } }),
            { configWarnings: ['x'], listen: { host: '10.0.0.5', scope: 'specific', supported: false } });
        assert.deepEqual(initialFacts(), {});
    });

    test('啟動畫面開不成也照樣往下走（最後改用系統訊息框）', () => {
        assert.equal(next({ health: { state: 'down' }, statusWindow: { ok: false, error: 'x' } }).type, 'check-setup');
    });

    test('埠被其他程式佔用 → 先查是誰，再報錯（訊息帶出程式名稱與 PID）', () => {
        const f = { health: { state: 'other', detail: '3000 埠上的程式回 HTTP 200，不是出題系統' }, statusWindow: { ok: true } };
        assert.equal(next(f).type, 'describe-port');
        const a = next({ ...f, portOwner: { pid: 1234, name: 'java.exe', text: 'java.exe（PID 1234）' } });
        assert.equal(a.type, 'fail');
        assert.equal(a.code, 'port-in-use');
        assert.match(a.message, /java\.exe（PID 1234）/);
        assert.equal(a.detail, '3000 埠上的程式回 HTTP 200，不是出題系統');
        assert.match(a.hint.join('\n'), /ALLOWED_ORIGINS/);
    });

    test('查不出是誰佔的也照樣報錯（不會卡住）', () => {
        const a = next({ health: { state: 'other' }, statusWindow: { ok: true }, portOwner: { pid: null, name: null, text: null } });
        assert.equal(a.code, 'port-in-use');
        assert.doesNotMatch(a.message, /null/);
    });

    test('佔用的是 node.exe → 提示可能是另一個 npm start 視窗', () => {
        const a = next({ health: { state: 'other' }, statusWindow: { ok: true }, portOwner: { pid: 9, name: 'node.exe', text: 'node.exe（PID 9）' } });
        assert.match(a.hint[0], /npm start/);
    });
});

describe('nextAction：基本檢查', () => {
    const base = { health: { state: 'down' }, statusWindow: { ok: true } };
    test('.env、node_modules、DATABASE_URL 依序檢查，缺哪個就報哪個', () => {
        assert.equal(next(base).type, 'check-setup');
        assert.equal(next({ ...base, setup: { envFile: false, nodeModules: false, databaseUrl: false } }).code, 'env-missing');
        assert.equal(next({ ...base, setup: { envFile: true, nodeModules: false, databaseUrl: false } }).code, 'modules-missing');
        assert.equal(next({ ...base, setup: { envFile: true, nodeModules: true, databaseUrl: false } }).code, 'db-url-missing');
        assert.equal(next({ ...base, setup: { envFile: true, nodeModules: true, databaseUrl: true } }).type, 'detect-recording');
    });

    test('後端已在跑（只是資料庫斷線）時不做基本檢查', () => {
        assert.equal(next({ health: { state: 'ours', dbOk: false }, statusWindow: { ok: true } }).type, 'detect-recording');
    });
});

describe('nextAction：資料庫與 Docker', () => {
    const upTo = over => ({ ...healthyUntilServer(), db: undefined, ollamaNeed: undefined, ollama: undefined, migrations: undefined, ...over });

    test('資料庫連得上 → 完全不碰 Docker', () => {
        assert.equal(next(upTo({ db: { reachable: true } })).type, 'resolve-ollama-need');
    });

    test('資料庫連不上＋錄製中 → 報錯、不動 Docker', () => {
        const a = next(upTo({ recording: { active: true, matches: ['PID 5 cmd.exe：record_local.bat'] }, db: { reachable: false } }));
        assert.equal(a.code, 'recording-db-down');
        assert.equal(a.detail, 'PID 5 cmd.exe：record_local.bat');
    });

    test('錄製偵測失敗（active:null）不當成錄製中：照常處理 Docker', () => {
        assert.equal(next(upTo({ recording: { active: null, error: 'x' }, db: { reachable: false } })).type, 'probe-docker');
    });

    test('Docker 沒在跑 → 開 Docker Desktop → 等就緒 → compose up → 等資料庫', () => {
        const f = upTo({ db: { reachable: false } });
        assert.equal(next(f).type, 'probe-docker');
        f.docker = { ready: false, cliFound: true };
        assert.equal(next(f).type, 'launch-docker');
        f.dockerLaunch = { ok: true };
        assert.equal(next(f).type, 'wait-docker');
        f.dockerWait = { ready: true };
        assert.equal(next(f).type, 'compose-up');
        f.compose = { ok: true };
        assert.equal(next(f).type, 'wait-db');
        f.dbAfterCompose = { reachable: true };
        assert.equal(next(f).type, 'resolve-ollama-need');
    });

    test('Docker 已在跑、只是容器沒起 → 不開 Docker Desktop，直接 compose up', () => {
        assert.equal(next(upTo({ db: { reachable: false }, docker: { ready: true } })).type, 'compose-up');
    });

    test('Docker 各種失敗 → 各自的訊息', () => {
        const f = upTo({ db: { reachable: false }, docker: { ready: false } });
        assert.equal(next({ ...f, dockerLaunch: { ok: false, reason: 'not-found', path: 'D:\\Docker.exe' } }).code, 'docker-not-found');
        assert.match(next({ ...f, dockerLaunch: { ok: false, reason: 'not-found', path: 'D:\\Docker.exe' } }).message, /D:\\Docker\.exe/);
        assert.equal(next({ ...f, dockerLaunch: { ok: false, reason: 'spawn-failed', error: 'EPERM' } }).code, 'docker-launch-failed');
        const t = next({ ...f, dockerLaunch: { ok: true }, dockerWait: { ready: false } });
        assert.equal(t.code, 'docker-timeout');
        assert.match(t.message, /240 秒/);
        const g = upTo({ db: { reachable: false }, docker: { ready: true } });
        const c = next({ ...g, compose: { ok: false, error: '結束碼 1', outputTail: 'Ports are not available' } });
        assert.equal(c.code, 'compose-failed');
        assert.equal(c.detail, 'Ports are not available');
        assert.equal(next({ ...g, compose: { ok: true }, dbAfterCompose: { reachable: false, error: 'password authentication failed' } }).code, 'db-unreachable');
    });
});

describe('nextAction：本機 AI（失敗不擋開機）', () => {
    const f = over => ({ ...healthyUntilServer(), ollama: undefined, migrations: undefined, ...over });

    test('不需要 Ollama → 不檢查、直接看 migration', () => {
        assert.equal(next(f({ ollamaNeed: { needed: false, models: [] } })).type, 'check-migrations');
    });

    test('需要、沒在跑 → 試著開、等就緒；開不成或等不到都照樣往下', () => {
        assert.equal(next(f({})).type, 'probe-ollama');
        assert.equal(next(f({ ollama: { reachable: false } })).type, 'launch-ollama');
        assert.equal(next(f({ ollama: { reachable: false }, ollamaLaunch: { ok: true } })).type, 'wait-ollama');
        for (const tail of [
            { ollamaLaunch: { ok: false, reason: 'not-found' } },
            { ollamaLaunch: { ok: false, reason: 'spawn-failed', error: 'x' } },
            { ollamaLaunch: { ok: false, reason: 'remote-host' } },
            { ollamaLaunch: { ok: true }, ollamaWait: { ready: false } }
        ]) {
            assert.equal(next(f({ ollama: { reachable: false }, ...tail })).type, 'check-migrations', JSON.stringify(tail));
        }
    });
});

describe('nextAction：migration、後端、完成', () => {
    test('migration 有沒套的也照樣啟動（只提示，不自動升級）', () => {
        const a = next(healthyUntilServer({ migrations: { ok: true, pending: ['0021_x.sql'], unknown: [], appliedCount: 20 } }));
        assert.equal(a.type, 'spawn-server');
    });

    test('啟動後端 → 等健康檢查 → 完成', () => {
        const f = healthyUntilServer();
        assert.equal(next(f).type, 'spawn-server');
        f.server = { spawned: true, pid: 7100, logFile: 'C:\\app\\data\\logs\\server-2026-09-27.log' };
        assert.equal(next(f).type, 'wait-server');
        f.serverWait = { ready: true, dbOk: true };
        assert.deepEqual(next(f), { type: 'finish', url: ctx.appUrl, reason: 'started' });
    });

    test('後端各種失敗', () => {
        const f = healthyUntilServer();
        assert.equal(next({ ...f, server: { spawned: false, error: 'EPERM' } }).code, 'server-spawn-failed');
        const s = { ...f, server: { spawned: true, pid: 1, logFile: 'L.log' } };
        const exited = next({ ...s, serverWait: { ready: false, reason: 'exited', exitCode: 1, logTail: 'Error: 缺少 DATABASE_URL' } });
        assert.equal(exited.code, 'server-exited');
        assert.match(exited.message, /結束碼 1/);
        assert.match(exited.hint[0], /L\.log/);
        assert.equal(exited.detail, 'Error: 缺少 DATABASE_URL');
        assert.equal(next({ ...s, serverWait: { ready: false, reason: 'timeout' } }).code, 'server-timeout');
    });

    test('後端因為 EADDRINUSE 結束 → 查是誰佔的 → 報埠被佔用（歸在「啟動後端」那一步）', () => {
        const f = { ...healthyUntilServer(), server: { spawned: true, pid: 1 }, serverWait: { ready: false, reason: 'exited', addrInUse: true } };
        assert.equal(next(f).type, 'describe-port');
        const a = next({ ...f, portOwner: { pid: 2, name: 'x.exe', text: 'x.exe（PID 2）' } });
        assert.equal(a.code, 'port-in-use');
        assert.equal(plan.stepOfFailure(a.code, f), 'server');
        assert.equal(plan.stepOfFailure('port-in-use', {}), 'check');
    });

    // 〔審查 dec/desktop-launcher 第 2 件〕
    test('後端因為 EACCES 結束：查不到誰在聽 → 埠被 Windows 保留（提示 netsh）；查得到 → 同「被佔用」', () => {
        const f = { ...healthyUntilServer(), server: { spawned: true, pid: 1, logFile: 'S.log' }, serverWait: { ready: false, reason: 'exited', addrInUse: false, listenError: 'EACCES', logTail: 'listen EACCES' } };
        assert.equal(next(f).type, 'describe-port');
        const reserved = next({ ...f, portOwner: { pid: null, name: null, text: null, pids: [] } });
        assert.equal(reserved.code, 'port-reserved');
        assert.match(reserved.hint.join('\n'), /netsh interface ipv4 show excludedportrange protocol=tcp/);
        assert.match(reserved.hint.join('\n'), /PORT/);
        assert.match(reserved.hint.join('\n'), /S\.log/);
        assert.equal(reserved.detail, 'listen EACCES');
        assert.equal(plan.stepOfFailure('port-reserved', f), 'server');
        const held = next({ ...f, portOwner: { pid: 9, name: 'svc.exe', text: 'svc.exe（PID 9）', pids: [9] } });
        assert.equal(held.code, 'port-in-use');
    });

    test('後端逾時時還活著、而埠被別的程式聽著 → 先結束自己開的後端，再報埠被佔用（不留孤兒）', () => {
        const f = { ...healthyUntilServer(), server: { spawned: true, pid: 7100 }, serverWait: { ready: false, reason: 'timeout', childAlive: true } };
        assert.equal(next(f).type, 'describe-port');
        const other = { ...f, portOwner: { pid: 77, name: 'python.exe', text: 'python.exe（PID 77）', pids: [77] } };
        assert.equal(next(other).type, 'stop-server');
        const stopped = next({ ...other, serverStop: { pid: 7100, stopped: true } });
        assert.equal(stopped.code, 'port-in-use');
        assert.match(stopped.hint[0], /PID 7100.*已經由啟動器結束/);
        const notStopped = next({ ...other, serverStop: { pid: 7100, stopped: false } });
        assert.match(notStopped.hint[0], /工作管理員.*PID 7100/);
    });

    test('後端逾時但埠上聽著的是它自己、或沒人在聽（只是慢）→ 不結束它，報逾時', () => {
        const f = { ...healthyUntilServer(), server: { spawned: true, pid: 7100 }, serverWait: { ready: false, reason: 'timeout', childAlive: true } };
        assert.equal(next({ ...f, portOwner: { pid: 7100, name: 'node.exe', text: 'node.exe（PID 7100）', pids: [7100], ownServer: true } }).code, 'server-timeout');
        assert.equal(next({ ...f, portOwner: { pid: null, name: null, text: null, pids: [] } }).code, 'server-timeout');
        // 自己開的後端已經不在（childAlive:false）→ 不查埠、直接報逾時
        assert.equal(next({ ...f, serverWait: { ready: false, reason: 'timeout', childAlive: false } }).code, 'server-timeout');
        assert.equal(plan.portHeldByOther({ server: { pid: 1 }, portOwner: { pid: 2 } }), true);
        assert.equal(plan.portHeldByOther({ server: { pid: 1 }, portOwner: { pid: 2, pids: [2, 1] } }), false);
    });

    // 〔審查 dec/desktop-launcher 第 5 件〕
    test('健康檢查逾時、而聽著這個埠的是 server.json 記的後端 → 報「後端沒有回應」，不說被其他程式佔用', () => {
        const f = { health: { state: 'other', detail: '3000 埠有程式在聽，但沒有正常回應（ETIMEDOUT）' }, statusWindow: { ok: true } };
        const a = next({ ...f, portOwner: { pid: 7100, name: 'node.exe', text: 'node.exe（PID 7100）', pids: [7100], ownServer: true, logFile: 'C:\\app\\data\\logs\\server-2026-09-26.log' } });
        assert.equal(a.code, 'server-busy');
        assert.doesNotMatch(`${a.title}${a.message}`, /其他程式/);
        assert.match(a.message, /PID 7100/);
        assert.match(a.hint.join('\n'), /關閉出題系統/);
        assert.match(a.hint.join('\n'), /server-2026-09-26\.log/, '指向那個後端實際寫的 log（跨夜的後端還在寫前一天的檔）');
        // 〔dec/desktop-launcher-fix2〕強制結束的後果照實說（與關閉捷徑同一句 UNFINISHED_WORK_NOTE）
        assert.ok(a.hint.some(h => h.includes(plan.UNFINISHED_WORK_NOTE)), '提示要說清楚強制結束後沒跑完的工作會怎樣');
        assert.match(plan.UNFINISHED_WORK_NOTE, /單題的檢查從中斷那一步接著做/);
        // 〔DA-13，dec/r7-checkpoints〕拆題與變式從中斷的那一塊／那一題重做（原本整份從頭再跑一次）
        // 〔dec/r7-checkpoints-fix，依審查〕變式不是只重做中斷的那一題：還沒建成的題（含之前沒過閘門的）都會再生成
        assert.match(plan.UNFINISHED_WORK_NOTE, /整份卷的拆題從中斷的那一塊重拆，已經拆完的塊不會重拆（本機拆一塊約 30～45 分鐘）/);
        assert.match(plan.UNFINISHED_WORK_NOTE, /變式生成只補還沒建成的題，已經建好的題不會重做（中斷的那一題與之前沒通過檢查的題會再生成一次）/);
        assert.doesNotMatch(plan.UNFINISHED_WORK_NOTE, /變式生成從中斷的那一題重做/);
        assert.doesNotMatch(plan.UNFINISHED_WORK_NOTE, /從頭再跑一次/);
        assert.doesNotMatch(a.hint.join('\n'), /沒跑完的那一步下次開啟時會自動重跑/);
        assert.equal(a.detail, f.health.detail);
        assert.equal(plan.stepOfFailure('server-busy', f), 'check');
        assert.equal(next({ ...f, portOwner: { pid: 7100, name: 'node.exe', text: 'node.exe（PID 7100）', pids: [7100], ownServer: false } }).code, 'port-in-use');
    });

    test('已在跑但資料庫斷線：把資料庫開起來之後就完成，不另起後端', () => {
        const f = healthyUntilServer({ health: { state: 'ours', dbOk: false }, setup: undefined, db: { reachable: false }, docker: { ready: true }, compose: { ok: true }, dbAfterCompose: { reachable: true } });
        assert.deepEqual(next(f), { type: 'finish', url: ctx.appUrl, reason: 'db-restored' });
    });

    test('isTerminal 只認 open-app／finish／fail', () => {
        assert.deepEqual([...plan.TERMINAL].sort(), ['fail', 'finish', 'open-app']);
        assert.equal(plan.isTerminal({ type: 'probe-db' }), false);
        assert.equal(plan.isTerminal(null), false);
    });

    test('每一種非終止的 action 都有對應的步驟與說明文字', () => {
        const all = new Set();
        const walk = f => { const a = next(f); all.add(a.type); };
        walk({});
        for (const t of Object.keys(plan.STEP_OF_ACTION)) all.add(t);
        for (const t of all) {
            if (plan.isTerminal({ type: t })) continue;
            assert.ok(plan.STEP_OF_ACTION[t], `${t} 沒有對應的步驟`);
            assert.ok(plan.RUNNING_TEXT[t], `${t} 沒有執行中的說明`);
        }
    });
});

describe('failureMessage：每一種失敗都說得出「下一步做什麼」', () => {
    const codes = ['port-in-use', 'port-reserved', 'server-busy', 'env-missing', 'modules-missing', 'db-url-missing', 'recording-db-down', 'docker-not-found',
        'docker-launch-failed', 'docker-timeout', 'compose-failed', 'db-unreachable', 'server-spawn-failed', 'server-exited',
        'server-timeout', 'internal', 'something-new'];
    test('標題、原因、至少一條處置；不出現 undefined／null', () => {
        for (const code of codes) {
            const m = plan.failureMessage(code, {}, ctx, { detail: 'stack' });
            assert.ok(m.title && m.message && m.hint.length >= 1, code);
            assert.doesNotMatch(JSON.stringify(m), /undefined|null/, code);
        }
    });
    test('internal 帶出例外訊息與 launcher log 的位置', () => {
        const m = plan.failureMessage('internal', {}, { ...ctx, launcherLog: 'C:\\app\\data\\logs\\launcher-2026-09-27.log' }, { detail: 'TypeError: x' });
        assert.equal(m.detail, 'TypeError: x');
        assert.match(m.hint[0], /launcher-2026-09-27\.log/);
    });
});

describe('collectWarnings', () => {
    const codes = f => plan.collectWarnings(f).map(w => w.code);

    test('一切正常 → 沒有警告', () => {
        assert.deepEqual(codes(healthyUntilServer({ serverWait: { ready: true, dbOk: true } })), []);
    });

    test('Ollama 各種狀況都說清楚「拆題會失敗、其他功能照常」', () => {
        const base = healthyUntilServer({ ollama: { reachable: false } });
        const cases = [
            [{ ollamaLaunch: { ok: false, reason: 'not-found' } }, 'ollama-not-found'],
            [{ ollamaLaunch: { ok: false, reason: 'spawn-failed', error: 'EPERM' } }, 'ollama-launch-failed'],
            [{ ollamaLaunch: { ok: false, reason: 'remote-host' } }, 'ollama-remote'],
            [{ ollamaLaunch: { ok: true }, ollamaWait: { ready: false } }, 'ollama-timeout']
        ];
        for (const [over, code] of cases) {
            const ws = plan.collectWarnings({ ...base, ...over });
            assert.deepEqual(ws.map(w => w.code), [code]);
            assert.match(ws[0].text, /拆題/);
            assert.match(ws[0].text, /照常/);
        }
    });

    test('Ollama 在跑但缺模型 → 列出缺哪些；開了之後才發現缺的也算', () => {
        const a = plan.collectWarnings(healthyUntilServer({ ollama: { reachable: true, missing: ['qwen3:8b'] } }));
        assert.deepEqual(a.map(w => w.code), ['ollama-models']);
        assert.match(a[0].text, /qwen3:8b/);
        const b = codes(healthyUntilServer({ ollama: { reachable: false }, ollamaLaunch: { ok: true }, ollamaWait: { ready: true, missing: ['x:1b'] } }));
        assert.deepEqual(b, ['ollama-models']);
    });

    test('OCR 的 Python 不在 → 警告；判斷不了（null）不警告', () => {
        const n = healthyUntilServer().ollamaNeed;
        assert.deepEqual(codes(healthyUntilServer({ ollamaNeed: { ...n, ocrNeeded: true, ocrFound: false, ocrPython: 'C:\\x\\python.exe' } })), ['ocr-missing']);
        assert.deepEqual(codes(healthyUntilServer({ ollamaNeed: { ...n, ocrNeeded: true, ocrFound: null } })), []);
    });

    test('migration：沒套（提示升級流程，不自動升級）、空資料庫、資料庫比程式新、查不到', () => {
        const pending = plan.collectWarnings(healthyUntilServer({ migrations: { ok: true, pending: ['0021_a.sql', '0022_b.sql'], unknown: [], appliedCount: 20 } }));
        assert.deepEqual(pending.map(w => w.code), ['migrations-pending']);
        assert.match(pending[0].text, /2 支/);
        assert.match(pending[0].text, /不會自動升級/);
        assert.match(pending[0].text, /備份/);
        assert.match(pending[0].text, /deployment_and_operations\.md/);
        assert.deepEqual(codes(healthyUntilServer({ migrations: { ok: true, pending: ['0001_init.sql'], unknown: [], appliedCount: 0 } })), ['migrations-empty']);
        assert.deepEqual(codes(healthyUntilServer({ migrations: { ok: true, pending: [], unknown: ['0099_future.sql'], appliedCount: 21 } })), ['migrations-ahead']);
        assert.deepEqual(codes(healthyUntilServer({ migrations: { ok: false, error: 'timeout' } })), ['migrations-unknown']);
    });

    test('錄製中（資料庫本來就開著）、錄製偵測失敗、上一個後端還在收尾、設定檔有誤、後端回報資料庫斷線', () => {
        assert.deepEqual(codes(healthyUntilServer({ recording: { active: true, matches: ['x'] } })), ['recording']);
        assert.deepEqual(codes(healthyUntilServer({ recording: { active: null, error: 'Access denied' } })), ['recording-unknown']);
        assert.deepEqual(codes(healthyUntilServer({ setup: { envFile: true, nodeModules: true, databaseUrl: true, draining: { pid: 88, untilMs: 1 } } })), ['previous-draining']);
        assert.deepEqual(codes({ configWarnings: ['browser 只接受 …'] }), ['config']);
        assert.deepEqual(codes(healthyUntilServer({ serverWait: { ready: true, dbOk: false } })), ['server-db-degraded']);
    });

    // 〔審查 dec/desktop-launcher 第 4 件〕
    test('錄製中的警告寫明「佇列裡已有的工作也會開跑」；設了 jobsWhileRecording:pause 時改說暫停與怎麼恢復', () => {
        const run = plan.collectWarnings(healthyUntilServer({ recording: { active: true, matches: ['x'], pauseJobs: false } }));
        assert.match(run[0].text, /佇列裡已有的背景工作/);
        assert.match(run[0].text, /自己開跑/);
        assert.match(run[0].text, /DL-4/);
        // 〔Owner 第六輪 DL-4＝2〕pause 是預設：run 是 Owner 自己改的，警告寫明怎麼改回
        assert.match(run[0].text, /jobsWhileRecording 是 run/);
        assert.match(run[0].text, /改回 pause（預設/);
        const pause = plan.collectWarnings(healthyUntilServer({ recording: { active: true, matches: ['x'], pauseJobs: true } }));
        assert.equal(pause[0].code, 'recording');
        assert.match(pause[0].text, /暫停背景工作/);
        assert.match(pause[0].text, /pause，預設/);
        assert.match(pause[0].text, /關閉出題系統.*出題系統/);
        assert.doesNotMatch(pause[0].text, /\*\*/, '啟動頁不解析 Markdown');
    });
});

describe('describeSteps（啟動畫面的六個步驟）', () => {
    const byId = steps => Object.fromEntries(steps.map(s => [s.id, s]));

    test('一開始：檢查中，其他等待', () => {
        const s = byId(plan.describeSteps({}, { type: 'probe-health' }));
        assert.equal(s.check.state, 'running');
        assert.equal(s.check.detail, plan.RUNNING_TEXT['probe-health']);
        for (const id of ['database', 'ai', 'migrations', 'server', 'window']) assert.equal(s[id].state, 'pending');
    });

    test('等 Docker 時：資料庫那一步在跑', () => {
        const f = { ...healthyUntilServer(), db: { reachable: false }, docker: { ready: false }, dockerLaunch: { ok: true }, ollamaNeed: undefined, ollama: undefined, migrations: undefined };
        const s = byId(plan.describeSteps(f, { type: 'wait-docker' }));
        assert.equal(s.check.state, 'done');
        assert.equal(s.database.state, 'running');
    });

    test('完成：前五步都有結果、最後一步在轉頁；不需要 Ollama 時顯示略過', () => {
        const f = healthyUntilServer({ ollamaNeed: { needed: false, models: [] }, ollama: undefined, server: { spawned: true, pid: 7100 }, serverWait: { ready: true, dbOk: true } });
        const s = byId(plan.describeSteps(f, { type: 'finish' }));
        assert.equal(s.check.state, 'done');
        assert.equal(s.database.state, 'done');
        assert.equal(s.ai.state, 'skipped');
        assert.equal(s.migrations.state, 'done');
        assert.match(s.migrations.detail, /0020_output_truncated_review\.sql/);
        assert.equal(s.server.state, 'done');
        assert.equal(s.server.detail, 'PID 7100');
        assert.equal(s.window.state, 'running');
    });

    test('有警告的步驟標成 warn；失敗的步驟標成 error 並帶標題', () => {
        const f = healthyUntilServer({ ollama: { reachable: false }, ollamaLaunch: { ok: false, reason: 'not-found' }, migrations: { ok: true, pending: ['x.sql'], unknown: [], appliedCount: 3 } });
        const s = byId(plan.describeSteps(f, { type: 'spawn-server' }));
        assert.equal(s.ai.state, 'warn');
        assert.equal(s.migrations.state, 'warn');
        assert.equal(s.server.state, 'running');
        const failed = plan.nextAction({ ...healthyUntilServer(), db: { reachable: false }, docker: { ready: false }, dockerLaunch: { ok: false, reason: 'not-found' } }, ctx);
        const s2 = byId(plan.describeSteps({ ...healthyUntilServer(), db: { reachable: false } }, failed));
        assert.equal(s2.database.state, 'error');
        assert.equal(s2.database.detail, failed.title);
    });
});
