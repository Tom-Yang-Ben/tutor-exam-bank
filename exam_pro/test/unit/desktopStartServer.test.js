// ─────────────────────────────────────────────────────────────
// test/unit/desktopStartServer.test.js — 可以被呼叫的後端（startServer.js；桌面版 B1，docs/desktop-app-design.md 第 2.3、6.2 節）
//
//   1. startServer({ port: 0 })：回傳實際的埠，連得上（/api/health 認得出是這套系統）；預設只綁 127.0.0.1。
//   2. close()：停止認領（runner.stop）→ 埠放掉 → 關連線池 → 結束（exit 注入，不會真的結束測試行程）。
//      close({ graceMs: 0 })：在途工作還在、runner 沒有 shutdown（舊版、假 runner）→ 不關連線池、直接結束（與當機同一條路）。
//      〔dec/r8-b1-abandon〕close({ abandon: true })＝「現在放棄」：runner.shutdown({ abandon: true }) 中止在途節點、只放掉自己的租約，
//      都收尾了就照常關連線池、結束（jobRunner 本身的行為在 jobRunnerAbandon／jobAbandon.pg 測）。
//   3. 聽不了埠：reject（err.code＝EADDRINUSE），而且**不啟動 runner**（不留下沒有網頁、卻在背景認領工作的行程）。
//   4. 不讀 .env（環境變數由呼叫的人放好）；server.js（npm start）一個字都沒改。
// 不連資料庫（DATABASE_URL 指向不存在的埠；健康檢查回 503）。node --test 每個檔案各跑一個行程，這裡改的環境變數不影響別的測試檔。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

process.env.DATABASE_URL = 'postgres://nobody:none@127.0.0.1:1/never_used_test';
process.env.JOB_RUNNER = 'off';
delete process.env.LAUNCHER_CONTROL_TOKEN;
delete process.env.API_KEY;

const { startServer, urlHost, DEFAULT_HOST } = require('../../startServer');

const APP_DIR = path.resolve(__dirname, '..', '..');

function get(url) {
    return new Promise(resolve => {
        const req = http.get(url, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch (_) { /* 不是 JSON */ }
                resolve({ status: res.statusCode, json, body });
            });
        });
        req.on('error', err => resolve({ status: null, error: err.code }));
    });
}

function fakeRunner(inFlight = 0) {
    return { inFlight, stopped: 0, stop() { this.stopped += 1; } };
}

function harness({ inFlight = 0 } = {}) {
    const runner = fakeRunner(inFlight);
    const exits = [];
    const pools = [];
    const opts = {
        startRunner: () => runner,
        exit: code => exits.push(code),
        closePool: async () => { pools.push('closed'); },
        logger: { info() { }, warn() { }, error() { } }
    };
    return { runner, exits, pools, opts };
}

describe('startServer', () => {
    test('port 0：回傳系統挑的埠、網址是 http://127.0.0.1:<埠>，而且連得上（健康檢查認得出是這套系統）', async () => {
        const h = harness();
        const s = await startServer({ port: 0, ...h.opts });
        try {
            assert.ok(Number.isInteger(s.port) && s.port > 0);
            assert.equal(s.url, `http://127.0.0.1:${s.port}`);
            assert.equal(s.host, '127.0.0.1');
            assert.equal(s.server.address().address, '127.0.0.1', '預設只綁本機（DA-11＝1）');
            const r = await get(`${s.url}/api/health`);
            assert.equal(r.json && r.json.service, 'tutor-exam-bank');
            assert.equal(r.status, 503, '資料庫連不上時回 503（這支測試不連資料庫）');
            const index = await get(`${s.url}/`);
            assert.equal(index.status, 200);
            assert.match(index.body, /<meta\s+name="feature-pipeline"/);
            assert.deepEqual(s.status(), { pid: process.pid, in_flight: 0, shutting_down: false });
        } finally {
            await s.close({ graceMs: 0 });
        }
    });

    test('close()：停止認領 → 埠放掉 → 關連線池 → 結束（exit 0）', async () => {
        const h = harness();
        const s = await startServer({ port: 0, ...h.opts });
        const port = s.port;
        const r = await s.close({ graceMs: 1000 });
        assert.deepEqual(r, { left: 0 });
        assert.equal(h.runner.stopped, 1);
        assert.deepEqual(h.pools, ['closed']);
        assert.deepEqual(h.exits, [0]);
        await new Promise(resolve => setTimeout(resolve, 50));
        const after = await get(`http://127.0.0.1:${port}/api/health`);
        assert.equal(after.error, 'ECONNREFUSED', '埠已經放掉');
        assert.equal(s.status().shutting_down, true);
    });

    test('close({ graceMs: 0 })＝現在放棄：在途工作還在就不關連線池、直接結束（不寫結果、不動重試次數）', async () => {
        const h = harness({ inFlight: 2 });
        const s = await startServer({ port: 0, ...h.opts });
        const r = await s.close({ graceMs: 0 });
        assert.deepEqual(r, { left: 2 });
        assert.equal(h.runner.stopped, 1);
        assert.deepEqual(h.pools, [], '不關連線池');
        assert.deepEqual(h.exits, [0]);
    });

    test('〔dec/r8-b1-abandon〕close({ abandon: true })：把 abandon 交給 runner.shutdown，收尾後照常關連線池、結束', async () => {
        const h = harness({ inFlight: 2 });
        const calls = [];
        h.runner.shutdown = async o => { calls.push(o); h.runner.inFlight = 0; return { left: 0, abandoned: 2, released: 2, kept: 0 }; };
        const s = await startServer({ port: 0, ...h.opts });
        const r = await s.close({ abandon: true });
        assert.deepEqual(calls, [{ abandon: true, waitMs: 10_000 }]);
        assert.equal(r.left, 0);
        assert.deepEqual(h.pools, ['closed'], '都收尾了就關連線池');
        assert.deepEqual(h.exits, [0]);
    });

    test('close 冪等：第二次回同一個 promise', async () => {
        const h = harness();
        const s = await startServer({ port: 0, ...h.opts });
        const a = s.close({ graceMs: 0 });
        const b = s.close({ graceMs: 999999 });
        assert.equal(a, b);
        await a;
        assert.deepEqual(h.exits, [0]);
    });

    test('聽不了埠（被佔用）：reject，err.code＝EADDRINUSE，而且沒有啟動 runner', async () => {
        const blocker = net.createServer();
        await new Promise(r => blocker.listen(0, '127.0.0.1', r));
        const h = harness();
        let started = 0;
        try {
            await assert.rejects(
                startServer({ port: blocker.address().port, ...h.opts, startRunner: () => { started += 1; return h.runner; } }),
                err => err.code === 'EADDRINUSE' && err.syscall === 'listen'
            );
            assert.equal(started, 0);
        } finally {
            await new Promise(r => blocker.close(r));
        }
    });

    test('JOB_RUNNER=off（預設的 startInlineRunner 回 null）：runner 是 null、狀態照樣回得出來', async () => {
        const exits = [];
        const s = await startServer({ port: 0, exit: c => exits.push(c), closePool: async () => { }, logger: { info() { }, warn() { }, error() { } } });
        assert.equal(s.runner, null);
        assert.equal(s.status().in_flight, 0);
        await s.close({ graceMs: 0 });
        assert.deepEqual(exits, [0]);
    });

    test('urlHost：綁所有介面時用 127.0.0.1 連；IPv6 加中括號', () => {
        assert.equal(DEFAULT_HOST, '127.0.0.1');
        assert.equal(urlHost('0.0.0.0'), '127.0.0.1');
        assert.equal(urlHost('::'), '127.0.0.1');
        assert.equal(urlHost(''), '127.0.0.1');
        assert.equal(urlHost('::1'), '[::1]');
        assert.equal(urlHost('127.0.0.1'), '127.0.0.1');
    });
});

describe('不影響 npm start', () => {
    test('startServer.js 不讀 .env；server.js 仍然自己讀 .env、聽 PORT', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'startServer.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(src, /dotenv/);
        const server = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
        assert.match(server, /^require\('dotenv'\)\.config\(\);/);
        // 聽 PORT（綁定位址另由 DA-11 的分支改成 HOST：app.listen(PORT, HOST, …)；兩種寫法都算）
        assert.match(server, /app\.listen\(PORT[,)]/);
    });

    test('config/db.js 的連線帶 application_name＝tutor-exam-bank（桌面版據此偵測另一個後端；與健康檢查的服務名稱相同）', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'config', 'db.js'), 'utf8');
        assert.match(src, /const APPLICATION_NAME = 'tutor-exam-bank';/);
        assert.match(src, /new Pool\(\{ connectionString: process\.env\.DATABASE_URL, max: 10, application_name: APPLICATION_NAME \}\)/);
        assert.equal(require('../../controllers/healthController').SERVICE_NAME, 'tutor-exam-bank');
        const db = require('../../config/db');
        assert.equal(db.pool.options.application_name, 'tutor-exam-bank');
        assert.deepEqual(Object.keys(db).sort(), ['pool', 'query'], '介面不變（interfaces-stage1.md 第 8 條）');
    });
});
