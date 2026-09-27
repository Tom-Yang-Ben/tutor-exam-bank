// desktop/test/backend.test.js — 主行程 ↔ 後端子行程（lib/backendProtocol.js、lib/backendHost.js；DA-3＝2 utilityProcess）
// 不需要 Electron：utilityProcess.fork 換成假的子行程（EventEmitter＋stdout／stderr）。
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const Pr = require('../lib/backendProtocol');
const { createBackendHost, TAIL_MAX } = require('../lib/backendHost');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('子行程這一側（attachBackendAgent）', () => {
    function world({ inFlight = 0, runner = {} } = {}) {
        const port = new EventEmitter();
        const sent = [];
        port.postMessage = m => sent.push(m);
        const closes = [];
        let shuttingDown = false;
        const handle = {
            port: 5000, url: 'http://127.0.0.1:5000', runner,
            status: () => ({ pid: 1, in_flight: inFlight, shutting_down: shuttingDown }),
            close: o => { closes.push(o); shuttingDown = true; return Promise.resolve({ left: 0 }); }
        };
        Pr.attachBackendAgent({ parentPort: port, handle, defaultGraceMs: 120000, maxGraceMs: 21600000 });
        return { port, sent, closes };
    }

    test('狀態：回 launcherControl 的在途數；收的是 MessageEvent（內容在 data）也行', () => {
        const w = world({ inFlight: 3 });
        w.port.emit('message', { data: { type: 'status', id: 7 }, ports: [] });
        assert.deepEqual(w.sent, [{ type: 'status', id: 7, in_flight: 3, shutting_down: false, jobs_paused: false }]);
        w.port.emit('message', { type: 'status', id: 8 });
        assert.equal(w.sent[1].id, 8);
    });

    test('沒有 runner（JOB_RUNNER=off）：jobs_paused', () => {
        const w = world({ runner: null });
        w.port.emit('message', { data: { type: 'status', id: 1 } });
        assert.equal(w.sent[0].jobs_paused, true);
    });

    test('關閉：先回 ack，再呼叫 close；時限夾在 0～上限，沒給用預設', async () => {
        const w = world({ inFlight: 1 });
        w.port.emit('message', { data: { type: 'shutdown', grace_ms: 0 } });
        await tick();
        assert.deepEqual(w.sent[0], { type: 'shutdown-ack', grace_ms: 0, in_flight: 1, already: false });
        assert.deepEqual(w.closes, [{ graceMs: 0 }]);
        w.port.emit('message', { data: { type: 'shutdown', grace_ms: 1e12 } });
        await tick();
        assert.equal(w.sent[1].already, true);
        assert.deepEqual(w.closes[1], { graceMs: 21600000 });
        w.port.emit('message', { data: { type: 'shutdown' } });
        await tick();
        assert.deepEqual(w.closes[2], { graceMs: 120000 });
    });

    test('〔dec/r8-b1-abandon〕現在放棄：ack 帶 abandon、close({ graceMs:0, abandon:true })；已經在等處理完也照樣送（改成放棄）', async () => {
        const w = world({ inFlight: 2 });
        w.port.emit('message', { data: { type: 'shutdown', grace_ms: 21600000 } });
        await tick();
        assert.deepEqual(w.closes, [{ graceMs: 21600000 }], '先是等處理完');
        w.port.emit('message', { data: { type: 'shutdown', grace_ms: 999, abandon: true } });
        await tick();
        assert.deepEqual(w.sent[1], { type: 'shutdown-ack', grace_ms: 0, in_flight: 2, already: true, abandon: true });
        assert.deepEqual(w.closes[1], { graceMs: 0, abandon: true }, '已經在關閉中也要呼叫 close（讓正在等的那一輪改成放棄）');
        // abandon 只認 true：其他值照一般關閉
        w.port.emit('message', { data: { type: 'shutdown', grace_ms: 5, abandon: 'yes' } });
        await tick();
        assert.deepEqual(w.closes[2], { graceMs: 5 });
    });

    test('認不得的訊息不理', () => {
        const w = world();
        for (const m of [null, 'x', { data: 'x' }, { type: 'nope' }, { data: { type: 'nope' } }]) w.port.emit('message', m);
        assert.deepEqual(w.sent, []);
    });

    test('readyMessage／parseStatus', () => {
        assert.deepEqual(Pr.readyMessage({ port: 1, url: 'u', runner: null }), { type: 'ready', port: 1, url: 'u', jobs_paused: true });
        assert.deepEqual(Pr.parseStatus({ type: 'status', in_flight: 2, shutting_down: 1, jobs_paused: 0 }), { inFlight: 2, shuttingDown: true, jobsPaused: false });
        assert.equal(Pr.parseStatus({ type: 'status', in_flight: -1 }), null);
        assert.equal(Pr.parseStatus({ type: 'ready' }), null);
        assert.equal(Pr.clampGrace('abc', { defaultMs: 5, maxMs: 10 }), 5);
        assert.equal(Pr.clampGrace(-3, { defaultMs: 5, maxMs: 10 }), 0);
    });
});

describe('主行程這一側（createBackendHost）', () => {
    /** 假的 utilityProcess：回應 status／shutdown；可以手動 ready、exit */
    function fakeFork({ autoSpawn = true, respond = true, inFlight = 0, exitOnShutdown = true } = {}) {
        const calls = [];
        let child = null;
        const fork = (modulePath, args, options) => {
            child = new EventEmitter();
            child.pid = 4321;
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.posted = [];
            child.killed = 0;
            child.postMessage = m => {
                child.posted.push(m);
                if (!respond) return;
                if (m.type === 'status') setImmediate(() => child.emit('message', { type: 'status', id: m.id, in_flight: child.inFlight, shutting_down: false, jobs_paused: false }));
                if (m.type === 'shutdown' && exitOnShutdown) setImmediate(() => child.emit('exit', 0));
            };
            child.kill = () => { child.killed += 1; setImmediate(() => child.emit('exit', 1)); return true; };
            child.inFlight = inFlight;
            calls.push({ modulePath, args, options });
            if (autoSpawn) setImmediate(() => child.emit('spawn'));
            return child;
        };
        return { fork, calls, get child() { return child; } };
    }
    const newHost = (f, extra = {}) => createBackendHost({ fork: f.fork, entryPath: '/d/backend-entry.js', cwd: '/exam_pro', ...extra });

    test('開後端：utilityProcess.fork(進入點, [], { env, cwd, stdio:pipe })；spawn 後回 pid', async () => {
        const f = fakeFork();
        const lines = [];
        const host = newHost(f, { openLog: () => ({ write: d => lines.push(String(d)), end() { } }) });
        const r = await host.start({ env: { PORT: '5' }, banner: '== 開始 ==\n' });
        assert.deepEqual(r, { ok: true, pid: 4321 });
        assert.equal(f.calls[0].modulePath, '/d/backend-entry.js');
        assert.deepEqual(f.calls[0].args, []);
        assert.deepEqual({ env: f.calls[0].options.env, cwd: f.calls[0].options.cwd, stdio: f.calls[0].options.stdio }, { env: { PORT: '5' }, cwd: '/exam_pro', stdio: 'pipe' });
        f.child.stdout.write('hello\n');
        f.child.stderr.write('oops\n');
        await tick(5);
        assert.deepEqual(lines, ['== 開始 ==\n', 'hello\n', 'oops\n']);
        assert.match(host.tail, /hello\n[\s\S]*oops/);
        assert.equal(host.alive, true);
        const again = await host.start({ env: {} });
        assert.equal(again.ok, false, '前一個還在就不開第二個');
    });

    test('等 ready：收到 ready 訊息回埠與網址；還沒 ready 問狀態回 null', async () => {
        const f = fakeFork({ inFlight: 2 });
        const host = newHost(f);
        await host.start({ env: {} });
        assert.equal(await host.status(), null);
        const p = host.waitReady({ timeoutMs: 5000 });
        f.child.emit('message', { type: 'ready', port: 5555, url: 'http://127.0.0.1:5555', jobs_paused: false });
        assert.deepEqual(await p, { ready: true, port: 5555, url: 'http://127.0.0.1:5555', jobsPaused: false });
        assert.deepEqual(await host.status(), { inFlight: 2, shuttingDown: false, jobsPaused: false });
    });

    test('等 ready 的途中結束：reason exited、帶結束碼與輸出', async () => {
        const f = fakeFork();
        const host = newHost(f);
        await host.start({ env: {} });
        const p = host.waitReady({ timeoutMs: 5000 });
        f.child.stderr.write('listen EADDRINUSE: address already in use 127.0.0.1:5\n');
        await tick(5);
        f.child.emit('exit', 1);
        const r = await p;
        assert.equal(r.ready, false);
        assert.equal(r.reason, 'exited');
        assert.equal(r.exitCode, 1);
        assert.match(r.logTail, /EADDRINUSE/);
    });

    test('等 ready 逾時：reason timeout、子行程還活著', async () => {
        const f = fakeFork();
        const host = newHost(f);
        await host.start({ env: {} });
        const r = await host.waitReady({ timeoutMs: 30 });
        assert.deepEqual({ ready: r.ready, reason: r.reason, childAlive: r.childAlive }, { ready: false, reason: 'timeout', childAlive: true });
    });

    test('spawn 之前就結束：start 回失敗', async () => {
        const f = fakeFork({ autoSpawn: false });
        const host = newHost(f);
        const p = host.start({ env: {} });
        f.child.emit('exit', 5);
        const r = await p;
        assert.equal(r.ok, false);
        assert.match(r.error, /還沒開起來就結束了/);
    });

    test('fork 本身丟錯：start 回失敗', async () => {
        const host = createBackendHost({ fork: () => { throw new Error('boom'); }, entryPath: 'x', cwd: 'y' });
        assert.deepEqual(await host.start({ env: {} }), { ok: false, error: 'boom' });
    });

    test('狀態問不到（子行程不回）：逾時回 null', async () => {
        const f = fakeFork({ respond: false });
        const host = newHost(f);
        await host.start({ env: {} });
        f.child.emit('message', { data: { type: 'ready', port: 1, url: 'u' } });
        assert.equal(await host.status({ timeoutMs: 20 }), null);
    });

    test('優雅關閉：送 shutdown（帶時限），子行程結束後回來；exit 被標成 expected', async () => {
        const f = fakeFork();
        const host = newHost(f);
        const exits = [];
        host.onExit(e => exits.push(e));
        await host.start({ env: {} });
        f.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        const r = await host.shutdown({ graceMs: 10000, killAfterMs: 5000 });
        assert.deepEqual(f.child.posted, [{ type: 'shutdown', grace_ms: 10000 }]);
        assert.equal(r.code, 0);
        assert.equal(f.child.killed, 0);
        await tick(200);
        assert.deepEqual(exits, [{ code: 0, expected: true }]);
        assert.equal(host.alive, false);
    });

    test('時限加 killAfterMs 還沒結束：強制結束', async () => {
        const f = fakeFork({ exitOnShutdown: false });
        const host = newHost(f);
        await host.start({ env: {} });
        f.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        await host.shutdown({ graceMs: 10, killAfterMs: 10 });
        assert.equal(f.child.killed, 1);
    });

    test('還沒聽到埠就要關：直接強制結束（沒有工作可等）', async () => {
        const f = fakeFork();
        const host = newHost(f);
        await host.start({ env: {} });
        await host.shutdown({ graceMs: 10000 });
        assert.equal(f.child.killed, 1);
        assert.deepEqual(f.child.posted, []);
    });

    // 〔dec/r8-b1-abandon〕行為變更：原本送 shutdown 0（後端直接結束、租約等到期），已經在「等處理完」就直接強制結束；
    // 現在一律送「現在放棄」（後端中止在途節點、放掉自己的租約後結束），等處理完的途中也一樣，後端沒結束才強制結束
    test('現在放棄：送 { shutdown, grace_ms:0, abandon:true }，後端自己結束就不強制結束', async () => {
        const g = fakeFork();
        const h2 = newHost(g);
        await h2.start({ env: {} });
        g.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        const r = await h2.abandon();
        assert.deepEqual(g.child.posted, [{ type: 'shutdown', grace_ms: 0, abandon: true }]);
        assert.equal(g.child.killed, 0);
        assert.equal(r.code, 0);
        assert.equal(r.expected, true);
        assert.equal(h2.abandoning, true);
    });

    test('現在放棄：已經在「等處理完」也送放棄（不再直接強制結束）；後端收到後結束，兩邊都回來', async () => {
        const f = fakeFork({ exitOnShutdown: false });
        const host = newHost(f);
        await host.start({ env: {} });
        f.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        const waiting = host.shutdown({ graceMs: 6 * 3600 * 1000, killAfterMs: 5000 });
        await tick(5);
        assert.equal(host.shuttingDown, true);
        const abandoning = host.abandon({ waitMs: 10000, killAfterMs: 5000 });
        await tick(5);
        assert.deepEqual(f.child.posted, [{ type: 'shutdown', grace_ms: 6 * 3600 * 1000 }, { type: 'shutdown', grace_ms: 0, abandon: true }]);
        assert.equal(f.child.killed, 0, '不是直接強制結束');
        f.child.emit('exit', 0);   // 後端放掉租約、關好連線池後結束
        await abandoning;
        await waiting;
        assert.equal(f.child.killed, 0);
        // 重複按「現在放棄」只送一次
        assert.equal(f.child.posted.filter(m => m.abandon).length, 1);
    });

    test('現在放棄：後端在 waitMs＋killAfterMs 內沒結束（收不到訊息）才強制結束；還沒聽到埠就直接強制結束', async () => {
        const f = fakeFork({ exitOnShutdown: false });
        const host = newHost(f);
        await host.start({ env: {} });
        f.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        await host.abandon({ waitMs: 10, killAfterMs: 10 });
        assert.equal(f.child.killed, 1);

        const g = fakeFork();
        const h2 = newHost(g);
        await h2.start({ env: {} });
        await h2.abandon();
        assert.equal(g.child.killed, 1);
        assert.deepEqual(g.child.posted, []);
    });

    test('不是桌面版要它結束的（當掉、被殺）：exit 通知 expected:false；之後可以再開一個', async () => {
        const f = fakeFork();
        const host = newHost(f);
        const exits = [];
        host.onExit(e => exits.push(e));
        await host.start({ env: {} });
        f.child.emit('message', { type: 'ready', port: 1, url: 'u' });
        f.child.emit('exit', 9);
        await tick(200);
        assert.deepEqual(exits, [{ code: 9, expected: false }]);
        assert.equal(host.alive, false);
        assert.equal(await host.status(), null, '結束了就不再問');
        const again = await host.start({ env: {} });
        assert.equal(again.ok, true);
        assert.equal(host.ready, null, '新的一輪要重新等 ready');
    });

    test('記憶體裡的輸出最多留 64 KB', async () => {
        const f = fakeFork();
        const host = newHost(f);
        await host.start({ env: {} });
        f.child.stdout.write('a'.repeat(TAIL_MAX + 100));
        f.child.stdout.write('END');
        await tick(5);
        assert.equal(host.tail.length, TAIL_MAX);
        assert.ok(host.tail.endsWith('END'));
    });
});
