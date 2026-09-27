// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherControl.test.js — 啟動器的「優雅關閉」通道（services/launcherControl.js；docs/desktop-launcher.md 第 7.3 節）
//
//   1. 純函式：權杖、grace_ms 的解讀。
//   2. 生命週期：停止認領 → 關 listener → 等在途工作 → 在途歸零才關連線池；時限到了還有在途就直接結束（不關池）。
//   3. 路由：x-launcher-token 錯了 403；status／shutdown 的回應；回應送出後才開始關。
//   4. 真的載入 app.js（本檔在 require 之前設了 LAUNCHER_CONTROL_TOKEN 與 API_KEY，模擬「由啟動器開的後端」）：
//      /api/launcher 掛在 apiKeyAuth 之後；/api/health 掛在它之前、不必金鑰。
// 不連資料庫（DATABASE_URL 指向不存在的埠；健康檢查回 503）。node --test 每個檔案各跑一個行程，這裡改的環境變數不影響別的測試檔。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const TOKEN = 'f'.repeat(64);
process.env.DATABASE_URL = 'postgres://nobody:none@127.0.0.1:1/never_used_test';
process.env.LAUNCHER_CONTROL_TOKEN = TOKEN;
process.env.API_KEY = 'unit-key';
process.env.JOB_RUNNER = 'off';

const lc = require('../../services/launcherControl');

describe('純函式', () => {
    test('tokenFromEnv／isEnabled：沒設、太短都當作沒有（不掛路由）', () => {
        assert.equal(lc.tokenFromEnv({}), null);
        assert.equal(lc.tokenFromEnv({ LAUNCHER_CONTROL_TOKEN: 'short' }), null);
        assert.equal(lc.tokenFromEnv({ LAUNCHER_CONTROL_TOKEN: ` ${TOKEN} ` }), TOKEN);
        assert.equal(lc.isEnabled({}), false);
        assert.equal(lc.isEnabled({ LAUNCHER_CONTROL_TOKEN: TOKEN }), true);
    });

    test('parseGraceMs：預設、夾在 0～上限、非數字退回預設', () => {
        assert.equal(lc.parseGraceMs(undefined), lc.DEFAULT_GRACE_MS);
        assert.equal(lc.parseGraceMs(''), lc.DEFAULT_GRACE_MS);
        assert.equal(lc.parseGraceMs('abc'), lc.DEFAULT_GRACE_MS);
        assert.equal(lc.parseGraceMs(-5), 0);
        assert.equal(lc.parseGraceMs(1e12), lc.MAX_GRACE_MS);
        assert.equal(lc.parseGraceMs('30000'), 30000);
        assert.equal(lc.MAX_GRACE_MS, 6 * 3600 * 1000);
    });
});

/** 假的時鐘＋runner＋server */
function rig({ inFlight = 0, finishAfterMs = Infinity } = {}) {
    let now = 0;
    const events = [];
    const runner = {
        _left: inFlight,
        stop() { events.push('runner.stop'); },
        get inFlight() { return now >= finishAfterMs ? 0 : this._left; }
    };
    const server = {
        close(cb) { events.push('server.close'); if (cb) cb(); },
        closeAllConnections() { events.push('server.closeAllConnections'); }
    };
    const exits = [];
    const lifecycle = lc.createLifecycle({
        exit: code => { events.push(`exit(${code})`); exits.push(code); },
        logger: { info: () => { }, warn: m => events.push(`warn:${m}`), error: m => events.push(`error:${m}`) },
        closePool: async () => { events.push('pool.end'); },
        sleep: async ms => { now += ms; },
        now: () => now,
        pollMs: 500,
        settleMs: 300,
        pid: 4321
    });
    lifecycle.attach({ server, runner });
    return { lifecycle, events, exits, get now() { return now; } };
}

describe('生命週期（shutdown）', () => {
    test('沒有在途工作：停止認領 → 關 listener → 關連線池 → exit(0)', async () => {
        const r = rig();
        await r.lifecycle.shutdown({ graceMs: 120_000 });
        assert.deepEqual(r.events, ['runner.stop', 'server.close', 'server.closeAllConnections', 'pool.end', 'exit(0)']);
    });

    test('在途工作在時限內做完 → 等到做完才關池、結束', async () => {
        const r = rig({ inFlight: 2, finishAfterMs: 10_000 });
        await r.lifecycle.shutdown({ graceMs: 120_000 });
        assert.ok(r.now >= 10_000 && r.now < 12_000, String(r.now));
        assert.deepEqual(r.events.slice(-2), ['pool.end', 'exit(0)']);
    });

    test('時限到了還有在途工作 → 不關連線池，直接結束（與當機同一條路：租約到期後下次開機重新認領）', async () => {
        const r = rig({ inFlight: 1 });
        const out = await r.lifecycle.shutdown({ graceMs: 5_000 });
        assert.equal(out.left, 1);
        assert.ok(r.now >= 5_000 && r.now < 6_000);
        assert.ok(!r.events.includes('pool.end'), '在途工作還在用連線池，不能先關');
        assert.equal(r.events[r.events.length - 1], 'exit(0)');
        assert.ok(r.events.some(e => e.startsWith('warn:')));
        // 〔dec/desktop-launcher-fix2〕log 照實說重新認領後從哪裡接著跑（單題接著做；拆題、變式整份從頭）
        const warn = r.events.find(e => e.startsWith('warn:'));
        assert.match(warn, /單題的檢查從中斷那一步接著做/);
        assert.match(warn, /整份卷的拆題、變式生成從頭再跑一次/);
    });

    test('冪等：第二次呼叫回同一個 promise；status 反映 shutting_down', async () => {
        const r = rig({ inFlight: 1, finishAfterMs: 1000 });
        assert.deepEqual(r.lifecycle.status(), { pid: 4321, in_flight: 1, shutting_down: false });
        const a = r.lifecycle.shutdown({ graceMs: 5000 });
        const b = r.lifecycle.shutdown({ graceMs: 1 });
        assert.equal(a, b);
        assert.equal(r.lifecycle.status().shutting_down, true);
        await a;
        assert.deepEqual(r.exits, [0]);
    });

    test('JOB_RUNNER=off（runner 是 null）也能關', async () => {
        const events = [];
        const l = lc.createLifecycle({ exit: c => events.push(`exit(${c})`), logger: { info() { }, warn() { }, error() { } }, closePool: async () => events.push('pool.end'), sleep: async () => { }, now: () => 0, settleMs: 0 });
        l.attach({ server: null, runner: null });
        await l.shutdown({ graceMs: 1000 });
        assert.deepEqual(events, ['pool.end', 'exit(0)']);
    });
});

describe('路由 /api/launcher', () => {
    function appWith(lifecycle) {
        const app = express();
        app.use(express.json());
        app.use('/api/launcher', lc.createRouter({ lifecycle, token: TOKEN }));
        return app;
    }
    const fakeLifecycle = () => {
        const calls = [];
        let shutting = false;
        return {
            calls,
            status: () => ({ pid: 99, in_flight: 2, shutting_down: shutting }),
            shutdown: o => { calls.push(o); shutting = true; return Promise.resolve(); },
            get shuttingDown() { return shutting; }
        };
    };

    test('沒帶或帶錯權杖 → 403（不洩漏任何狀態）', async () => {
        const app = appWith(fakeLifecycle());
        for (const headers of [{}, { 'x-launcher-token': 'wrong' }, { 'x-launcher-token': TOKEN.slice(1) }]) {
            const res = await request(app).get('/api/launcher/status').set(headers);
            assert.equal(res.status, 403);
            assert.deepEqual(Object.keys(res.body), ['message']);
        }
    });

    test('status → pid、在途件數、是否關閉中；no-store', async () => {
        const res = await request(appWith(fakeLifecycle())).get('/api/launcher/status').set('x-launcher-token', TOKEN);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { pid: 99, in_flight: 2, shutting_down: false });
        assert.equal(res.headers['cache-control'], 'no-store');
    });

    test('shutdown → 202，回應送出後才呼叫 lifecycle.shutdown（grace_ms 夾在範圍內）；第二次 already:true、不重複關', async () => {
        const l = fakeLifecycle();
        const app = appWith(l);
        const res = await request(app).post('/api/launcher/shutdown').set('x-launcher-token', TOKEN).send({ grace_ms: 99e9 });
        assert.equal(res.status, 202);
        assert.deepEqual(res.body, { pid: 99, in_flight: 2, grace_ms: lc.MAX_GRACE_MS, already: false });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(l.calls, [{ graceMs: lc.MAX_GRACE_MS }]);
        const again = await request(app).post('/api/launcher/shutdown').set('x-launcher-token', TOKEN).send({});
        assert.equal(again.body.already, true);
        await new Promise(r => setImmediate(r));
        assert.equal(l.calls.length, 1);
    });
});

describe('app.js（由啟動器開的後端：環境有 LAUNCHER_CONTROL_TOKEN）', () => {
    const app = require('../../app');

    test('/api/launcher 掛在 apiKeyAuth 之後：設了 API_KEY 時沒帶金鑰 → 401', async () => {
        const res = await request(app).get('/api/launcher/status').set('x-launcher-token', TOKEN);
        assert.equal(res.status, 401);
    });

    test('金鑰＋權杖都對 → 200（沒 attach runner 時在途 0）', async () => {
        const res = await request(app).get('/api/launcher/status').set('x-launcher-token', TOKEN).set('x-api-key', 'unit-key');
        assert.equal(res.status, 200);
        assert.equal(res.body.in_flight, 0);
        assert.equal(res.body.shutting_down, false);
        assert.equal(res.body.pid, process.pid);
    });

    test('金鑰對、權杖錯 → 403', async () => {
        const res = await request(app).get('/api/launcher/status').set('x-launcher-token', 'nope').set('x-api-key', 'unit-key');
        assert.equal(res.status, 403);
    });

    test('/api/health 掛在 apiKeyAuth 之前：不帶金鑰也回健康檢查（資料庫連不上 → 503，不是 401）', async () => {
        const res = await request(app).get('/api/health');
        assert.equal(res.status, 503);
        assert.deepEqual(res.body, { service: 'tutor-exam-bank', status: 'degraded', version: require('../../package.json').version, db: { ok: false }, migrations: null });
    });

    test('其他 /api 路由照舊要金鑰（掛 /api/health 沒有打開別的洞）', async () => {
        const res = await request(app).get('/api/chapters');
        assert.equal(res.status, 401);
        const health2 = await request(app).get('/api/health/extra');
        assert.equal(health2.status, 401);
    });
});
