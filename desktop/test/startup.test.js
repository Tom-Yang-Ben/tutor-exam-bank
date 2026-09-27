// desktop/test/startup.test.js — 開啟時的檢查與啟動（lib/startup.js：沿用 A 的 plan，只換後端怎麼開）
// A 的 plan 是真的（exam_pro/scripts/desktop/lib/plan.js）；I/O 的部分（A 的 actions、後端子行程、資料庫、健康檢查）換成假的。
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createDesktopActions, runStartup, OTHER_CONNECTIONS_SQL, OWN_BACKEND_HOST, summarize } = require('../lib/startup');

const ENV_PORT = 3000;

function world({ recording = { active: false, matches: [], pauseJobs: false }, other = 0, webRunning = false, readySeq, healthSeq, timeoutSec = 120, base = {} } = {}) {
    const calls = { start: [], kill: 0, set: [], finish: null, fail: null, sql: [], logs: [], probes: [] };
    let now = 0;
    const readies = readySeq || [{ ready: true, port: 5555, url: 'http://127.0.0.1:5555', jobsPaused: false }];
    const healths = healthSeq || [{ state: 'ours', dbOk: true }];
    let alive = false;
    const host = {
        start: async o => { calls.start.push(o); alive = true; return { ok: true, pid: 100 + calls.start.length }; },
        waitReady: async () => { const r = readies.shift() || { ready: false, reason: 'timeout', logTail: '' }; if (!r.ready && r.reason === 'exited') alive = false; return r; },
        kill: () => { calls.kill += 1; alive = false; },
        get alive() { return alive; },
        tail: 'tail text'
    };
    const sys = {
        env: { PATH: '/bin' },
        now: () => now,
        sleep: async ms => { now += ms; },
        pgQuery: async (url, sql) => { calls.sql.push(sql); return { ok: true, rows: [{ n: other }] }; }
    };
    const makeProbes = ({ port, host }) => ({
        probeHealth: async () => {
            calls.probes.push({ port, host: host === undefined ? null : host });
            if (port === ENV_PORT) return webRunning ? { state: 'ours', dbOk: true } : { state: 'down' };
            now += 1000;
            return healths.length > 1 ? healths.shift() : healths[0];
        }
    });
    const ui = {
        set: p => calls.set.push(p),
        note: () => { },
        openStatusWindow: async () => ({ ok: true, via: 'electron', url: 'http://127.0.0.1:40000/' }),
        finish: async (url, warnings) => { calls.finish = { url, warnings }; },
        fail: async (failure, warnings) => { calls.fail = { failure, warnings }; }
    };
    const ctx = { port: 0, appUrl: null, serverReadyTimeoutSec: timeoutSec, serverLog: 'desktop-server.log', launcherLog: 'desktop.log' };
    const aBase = {
        'check-setup': async () => ({ setup: { envFile: true, nodeModules: true, databaseUrl: true, draining: null } }),
        'detect-recording': async () => ({ recording }),
        'probe-db': async () => ({ db: { reachable: true } }),
        'resolve-ollama-need': async () => ({ ollamaNeed: { needed: false, models: [] } }),
        'check-migrations': async () => ({ migrations: { ok: true, pending: [], unknown: [], latest: '0020_x.sql', appliedCount: 20 } }),
        ...base
    };
    let port = 5555;
    const actions = createDesktopActions({
        base: aBase, host, sys, makeProbes,
        dotenvVars: { DATABASE_URL: 'postgres://x/y', PORT: '3000' }, env: { DATABASE_URL: 'postgres://x/y', PORT: '3000' },
        config: { serverReadyTimeoutSec: timeoutSec }, ctx, ui, pickPort: async () => port++, serverLog: 'desktop-server.log',
        log: l => calls.logs.push(l)
    });
    return { calls, ctx, ui, actions, host };
}

describe('開啟的流程（A 的 plan＋桌面版的後端）', () => {
    test('一路順利：開自己的後端（空埠、執行期的 ALLOWED_ORIGINS）→ 健康檢查 → 完成，網址是 http://127.0.0.1:<埠>/', async () => {
        const w = world();
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, true);
        assert.equal(w.ctx.appUrl, 'http://127.0.0.1:5555/');
        assert.deepEqual(w.calls.finish, { url: 'http://127.0.0.1:5555/', warnings: [] });
        assert.equal(w.calls.start.length, 1);
        const env = w.calls.start[0].env;
        assert.equal(env.PORT, '5555');
        assert.equal(env.ALLOWED_ORIGINS, 'http://127.0.0.1:5555,http://localhost:5555');
        assert.equal(env.JOB_RUNNER, undefined);
        assert.equal(env.DATABASE_URL, 'postgres://x/y');
        assert.match(w.calls.start[0].banner, /桌面版啟動後端（utilityProcess，只聽 127\.0\.0\.1:5555）/);
        // 啟動畫面：最後一次的步驟全部完成
        const last = w.calls.set[w.calls.set.length - 1];
        assert.equal(last.steps.find(s => s.id === 'server').state, 'done');
        assert.equal(last.steps.find(s => s.id === 'check').state, 'done');
    });

    test('不看 .env 的 PORT 上有沒有系統在跑（一律開自己的）；那裡有網頁版 → 警告，不是直接用它', async () => {
        const w = world({ webRunning: true });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, true);
        assert.equal(w.calls.start.length, 1);
        assert.deepEqual(w.calls.finish.warnings.map(x => x.code), ['other-backend']);
        assert.match(w.calls.finish.warnings[0].text, /http:\/\/localhost:3000/);
    });

    test('健康檢查自己的後端一律問 127.0.0.1（不照 .env 的 HOST）；查網頁版照 .env（不指定 host）', async () => {
        const w = world({ webRunning: true });
        await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(OWN_BACKEND_HOST, '127.0.0.1');
        const own = w.calls.probes.filter(p => p.port === 5555);
        const web = w.calls.probes.filter(p => p.port === ENV_PORT);
        assert.ok(own.length >= 1 && own.every(p => p.host === '127.0.0.1'), JSON.stringify(own));
        assert.ok(web.length >= 1 && web.every(p => p.host === null), JSON.stringify(web));
    });

    test('資料庫裡有這套系統的其他連線（application_name）→ 警告', async () => {
        const w = world({ other: 2 });
        await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(w.calls.sql[0], OTHER_CONNECTIONS_SQL);
        assert.match(OTHER_CONNECTIONS_SQL, /application_name = 'tutor-exam-bank'/);
        assert.match(OTHER_CONNECTIONS_SQL, /pid <> pg_backend_pid\(\)/);
        assert.match(w.calls.finish.warnings[0].text, /2 條來自這套系統的連線/);
    });

    test('錄製中、設定要暫停（DL-4）：後端帶 JOB_RUNNER=off，警告換成桌面版的說法', async () => {
        const w = world({ recording: { active: true, matches: ['node rerecord_all.js'], pauseJobs: true } });
        await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(w.calls.start[0].env.JOB_RUNNER, 'off');
        assert.match(w.calls.start[0].banner, /錄製中，暫停背景工作/);
        const rec = w.calls.finish.warnings.find(x => x.code === 'recording');
        assert.match(rec.text, /錄完後從系統匣選「結束」/);
    });

    test('挑的埠被搶走（EADDRINUSE）：換一個埠重開', async () => {
        const w = world({
            readySeq: [
                { ready: false, reason: 'exited', exitCode: 1, logTail: '✖ 後端無法啟動：聽不了連接埠 5555（EADDRINUSE）。\n  Node.js 的訊息：listen EADDRINUSE: address already in use 127.0.0.1:5555' },
                { ready: true, port: 5556, url: 'http://127.0.0.1:5556', jobsPaused: false }
            ]
        });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, true);
        assert.deepEqual(w.calls.start.map(s => s.env.PORT), ['5555', '5556']);
        assert.equal(w.ctx.appUrl, 'http://127.0.0.1:5556/');
    });

    test('後端立刻結束（例如 .env 設定矛盾）：啟動畫面顯示桌面版的訊息、附上最後幾行', async () => {
        const w = world({ readySeq: [{ ready: false, reason: 'exited', exitCode: 1, logTail: '✖ 後端無法啟動：Error: 缺少 DATABASE_URL' }] });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, false);
        assert.equal(w.calls.fail.failure.code, 'server-exited');
        assert.equal(w.calls.fail.failure.title, '後端啟動後立刻結束');
        assert.match(w.calls.fail.failure.detail, /缺少 DATABASE_URL/);
        assert.ok(w.calls.fail.failure.hint.some(h => h.includes('desktop-server.log')));
        const last = w.calls.set[w.calls.set.length - 1];
        const step = last.steps.find(s => s.id === 'server');
        assert.deepEqual({ state: step.state, detail: step.detail }, { state: 'error', detail: '後端啟動後立刻結束' });
    });

    test('一直沒有 ready：逾時、結束這次開的後端（不留在背景）', async () => {
        const w = world({ readySeq: [{ ready: false, reason: 'timeout', childAlive: true, logTail: '' }] });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, false);
        assert.equal(w.calls.fail.failure.code, 'server-timeout');
        assert.equal(w.calls.kill, 1);
    });

    test('ready 了但健康檢查一直沒回應：到時限就結束它、報逾時', async () => {
        const w = world({ healthSeq: [{ state: 'other' }], timeoutSec: 10 });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, false);
        assert.equal(w.calls.fail.failure.code, 'server-timeout');
        assert.ok(w.calls.kill >= 1);
    });

    test('健康檢查回報資料庫連不上：照樣完成，但有警告（換成桌面版的說法）', async () => {
        const w = world({ healthSeq: [{ state: 'ours', dbOk: false }] });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, true);
        const wn = w.calls.finish.warnings.find(x => x.code === 'server-db-degraded');
        assert.match(wn.text, /請從系統匣選「結束」/);
    });

    test('A 的前幾步失敗（例：沒有 .env）：照 A 的判斷停下，訊息換成桌面版的說法，不開後端', async () => {
        const w = world({ base: { 'check-setup': async () => ({ setup: { envFile: false, nodeModules: true, databaseUrl: true } }) } });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, false);
        assert.equal(w.calls.fail.failure.code, 'env-missing');
        assert.ok(w.calls.fail.failure.hint.some(h => h.includes('「出題系統（桌面版）」')));
        assert.equal(w.calls.start.length, 0);
    });

    test('某一步丟錯：桌面版內部錯誤，不會卡住', async () => {
        const w = world({ base: { 'probe-db': async () => { throw new Error('爆了'); } } });
        const r = await runStartup({ actions: w.actions, ui: w.ui, ctx: w.ctx });
        assert.equal(r.ok, false);
        assert.equal(w.calls.fail.failure.code, 'internal');
        assert.equal(w.calls.fail.failure.title, '桌面版發生未預期的錯誤');
        assert.equal(w.calls.fail.failure.detail, '爆了');
    });

    test('記錄檔的一行不印權杖與金鑰', () => {
        assert.equal(summarize({ server: { token: 'secret', apiKey: 'k', pid: 1 } }), 'server={"pid":1}');
    });
});
