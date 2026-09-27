// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherSystem.test.js — 桌面啟動器真正碰作業系統的那一層（scripts/desktop/lib/system.js）
//
// 其他啟動器測試都用假的 sys；這裡確認真的那一份在失敗時「回值、不丟錯」，回的值與假的一致：
// 結束碼、逾時（ETIMEDOUT）、找不到程式（ENOENT）、背景程式的 log 與結束狀態、HTTP 的 JSON／連不上／逾時、pg 連不上、鎖檔。
// 子程式一律用 node 自己（process.execPath -e …），Windows 與 Linux 都能跑。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createSystem } = require('../../scripts/desktop/lib/system');

const NODE = process.execPath;
let dir;
let sys;
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-sys-'));
    sys = createSystem();
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('exec', () => {
    test('結束碼與輸出（UTF-8）', async () => {
        const r = await sys.exec(NODE, ['-e', "process.stdout.write('出題');process.stderr.write('err');process.exit(3)"]);
        assert.deepEqual(r, { code: 3, stdout: '出題', stderr: 'err', errorCode: null });
        assert.equal((await sys.exec(NODE, ['-e', ''])).code, 0);
    });

    test('逾時 → ETIMEDOUT；找不到程式 → ENOENT（都不丟錯）', async () => {
        const t = await sys.exec(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
        assert.equal(t.code, null);
        assert.equal(t.errorCode, 'ETIMEDOUT');
        const n = await sys.exec('no-such-program-for-desktop-launcher', []);
        assert.equal(n.code, null);
        assert.equal(n.errorCode, 'ENOENT');
    });
});

describe('spawnDetached', () => {
    test('背景程式的輸出附加到 log；結束後 childStatus 看得到結束碼', async () => {
        const log = path.join(dir, 'logs', 'server.log');
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.writeFileSync(log, 'before\n');
        const r = await sys.spawnDetached(NODE, ['-e', "console.log('hi from child'); process.exit(4)"], { logFile: log });
        assert.equal(r.ok, true);
        assert.ok(Number.isInteger(r.pid));
        for (let i = 0; i < 100 && !(sys.childStatus(r.pid) || {}).exited; i++) await new Promise(res => setTimeout(res, 50));
        assert.deepEqual(sys.childStatus(r.pid), { exited: true, code: 4 });
        assert.equal(fs.readFileSync(log, 'utf8'), 'before\nhi from child\n');
        assert.equal(sys.readFrom(log, 'before\n'.length).trim(), 'hi from child');
        assert.equal(sys.childStatus(12345678), null);
    });

    test('開不成 → ok:false＋ENOENT，而且不留下空的 log 檔', async () => {
        const log = path.join(dir, 'never.log');
        const r = await sys.spawnDetached('no-such-program-for-desktop-launcher', [], { logFile: log });
        assert.equal(r.ok, false);
        assert.equal(r.errorCode, 'ENOENT');
        assert.equal(fs.existsSync(log), false);
    });
});

describe('request', () => {
    let server;
    let base;
    before(async () => {
        server = http.createServer((req, res) => {
            if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"a":"題"}'); return; }
            if (req.url === '/text') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>x</p>'); return; }
            if (req.url === '/echo') {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', () => { res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, token: req.headers['x-launcher-token'], body: JSON.parse(body) })); });
                return;
            }
            // /slow：不回應
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    });

    test('JSON 回應解析成物件；不是 JSON 的 json 是 null', async () => {
        assert.deepEqual(await sys.request({ url: `${base}/json` }), { status: 200, json: { a: '題' }, text: '{"a":"題"}', errorCode: null });
        const t = await sys.request({ url: `${base}/text` });
        assert.equal(t.status, 404);
        assert.equal(t.json, null);
        assert.equal(t.text, '<p>x</p>');
    });

    test('POST 帶 JSON 本文與標頭', async () => {
        const r = await sys.request({ url: `${base}/echo`, method: 'POST', headers: { 'x-launcher-token': 'tok' }, body: { grace_ms: 5 } });
        assert.deepEqual(r.json, { method: 'POST', token: 'tok', body: { grace_ms: 5 } });
    });

    test('逾時 → ETIMEDOUT；沒人在聽 → ECONNREFUSED', async () => {
        assert.equal((await sys.request({ url: `${base}/slow`, timeoutMs: 200 })).errorCode, 'ETIMEDOUT');
        const probe = http.createServer();
        await new Promise(r => probe.listen(0, '127.0.0.1', r));
        const freePort = probe.address().port;
        await new Promise(r => probe.close(r));
        assert.equal((await sys.request({ url: `http://127.0.0.1:${freePort}/api/health`, timeoutMs: 5000 })).errorCode, 'ECONNREFUSED');
    });
});

describe('其他', () => {
    test('pgQuery 連不上 → ok:false＋錯誤碼（不丟錯）', async () => {
        const r = await sys.pgQuery('postgres://x:y@127.0.0.1:1/z_test', 'SELECT 1', { timeoutMs: 3000 });
        assert.equal(r.ok, false);
        assert.ok(r.error);
    });

    test('pidAlive、createExclusive、readText／writeText／remove', () => {
        assert.equal(sys.pidAlive(process.pid), true);
        assert.equal(sys.pidAlive(0), false);
        const lock = path.join(dir, 'a', 'launch.lock');
        assert.equal(sys.createExclusive(lock, 'x'), true);
        assert.equal(sys.createExclusive(lock, 'y'), false);
        assert.equal(sys.readText(lock), 'x');
        sys.writeText(lock, 'z');
        assert.equal(sys.readText(lock), 'z');
        sys.remove(lock);
        assert.equal(sys.readText(lock), null);
        assert.equal(sys.exists(lock), false);
    });
});
