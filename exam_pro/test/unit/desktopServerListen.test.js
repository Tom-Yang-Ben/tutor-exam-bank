// ─────────────────────────────────────────────────────────────
// test/unit/desktopServerListen.test.js — 後端聽不了連接埠時（server.js＋utils/listenFailure.js）
//
// 〔審查 dec/desktop-launcher 第 2 件〕Express 5 的 app.listen 把 listen 錯誤交給 callback、不會丟出來；
// server.js 原本不看 callback 的參數，埠被佔用時照印「成功啟動」、不結束、不聽任何埠，卻繼續跑背景拆題。
//   1. listenFailureText：EADDRINUSE／EACCES／其他，都帶錯誤碼、Node 原本的訊息與處理方式；
//   2. exitAfterFlush：寫完才結束，寫入沒回應也會在時限內結束；
//   3. 桌面啟動器認得這份 log（scripts/desktop/lib/windows.js 的 listenErrorCode）；
//   4. **真的執行 server.js**：埠被佔用 → 印說明、以結束碼 1 結束；埠空著 → 照舊印「成功啟動」。
//      子行程用 JOB_RUNNER=off 與連不到的 DATABASE_URL（不連資料庫、不跑背景工作），cwd 是暫存資料夾（不讀任何 .env）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { listenFailureText, exitAfterFlush } = require('../../utils/listenFailure');
const w = require('../../scripts/desktop/lib/windows');

const APP_DIR = path.resolve(__dirname, '..', '..');
const err = (code, message) => Object.assign(new Error(message), { code });

describe('listenFailureText', () => {
    test('EADDRINUSE：錯誤碼、Node 原本的訊息、被佔用的處理方式', () => {
        const t = listenFailureText(err('EADDRINUSE', 'listen EADDRINUSE: address already in use :::3000'), 3000);
        assert.match(t, /聽不了連接埠 3000（EADDRINUSE）/);
        assert.match(t, /listen EADDRINUSE: address already in use :::3000/);
        assert.match(t, /npm start/);
        assert.match(t, /ALLOWED_ORIGINS/);
        assert.match(t, /後端已經結束/);
        assert.doesNotMatch(t, /成功/);
    });

    test('EACCES：提示 Windows 保留的埠段與 netsh 指令', () => {
        const t = listenFailureText(err('EACCES', 'listen EACCES: permission denied 0.0.0.0:3000'), 3000);
        assert.match(t, /（EACCES）/);
        assert.match(t, /netsh interface ipv4 show excludedportrange protocol=tcp/);
        assert.match(t, /PORT/);
    });

    test('其他錯誤：照樣帶錯誤碼與原文；沒有 code 也不出錯', () => {
        assert.match(listenFailureText(err('EADDRNOTAVAIL', 'listen EADDRNOTAVAIL x'), 3100), /3100（EADDRNOTAVAIL）[\s\S]*listen EADDRNOTAVAIL x/);
        assert.match(listenFailureText(new Error('weird'), 3000), /（UNKNOWN）[\s\S]*weird/);
    });

    test('桌面啟動器認得這份 log：EADDRINUSE → 被佔用、EACCES → 被保留；其他地方的 EACCES 不算', () => {
        assert.equal(w.listenErrorCode(listenFailureText(err('EADDRINUSE', 'listen EADDRINUSE: address already in use :::3000'), 3000)), 'EADDRINUSE');
        assert.equal(w.listenErrorCode(listenFailureText(err('EACCES', 'listen EACCES: permission denied 0.0.0.0:3000'), 3000)), 'EACCES');
        assert.equal(w.isAddrInUse(listenFailureText(err('EACCES', 'listen EACCES: permission denied 0.0.0.0:3000'), 3000)), false);
        assert.equal(w.listenErrorCode("Error: EACCES: permission denied, open 'data/x.json'"), null);
        assert.equal(w.listenErrorCode('🚀 家教題庫後端系統已成功安全啟動'), null);
    });
});

describe('exitAfterFlush', () => {
    test('寫完才結束（結束碼照傳）', async () => {
        const stderr = new PassThrough();
        let written = '';
        stderr.on('data', d => { written += d; });
        const code = await new Promise(resolve => exitAfterFlush('訊息', 1, { stderr, exit: resolve }));
        assert.equal(code, 1);
        assert.equal(written, '訊息\n');
    });

    test('寫入的 callback 一直沒回來 → 時限到也會結束；丟錯 → 立刻結束', async () => {
        const stuck = { write() { /* 永遠不呼叫 callback */ } };
        const t0 = Date.now();
        assert.equal(await new Promise(resolve => exitAfterFlush('x', 1, { stderr: stuck, exit: resolve, fallbackMs: 50 })), 1);
        assert.ok(Date.now() - t0 < 2000);
        const broken = { write() { throw new Error('EPIPE'); } };
        assert.equal(await new Promise(resolve => exitAfterFlush('x', 2, { stderr: broken, exit: resolve, fallbackMs: 60_000 })), 2);
    });
});

describe('真的執行 server.js', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-listen-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    /** 執行 server.js 直到它結束、或看到 until 那一行（看到就結束它）；最多等 timeoutMs */
    function runServer(port, { until = null, timeoutMs = 30_000 } = {}) {
        return new Promise(resolve => {
            const env = { ...process.env, PORT: String(port), DATABASE_URL: 'postgres://nobody:pw@127.0.0.1:1/never_used_test', JOB_RUNNER: 'off' };
            delete env.LAUNCHER_CONTROL_TOKEN;
            delete env.API_KEY;
            const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let sawUntil = false;
            const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
            child.stdout.on('data', d => {
                stdout += d;
                if (until && !sawUntil && until.test(stdout)) { sawUntil = true; child.kill('SIGKILL'); }
            });
            child.stderr.on('data', d => { stderr += d; });
            child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, sawUntil }); });
        });
    }

    test('埠被別的程式佔用 → 印出 EADDRINUSE 與處理方式、以結束碼 1 結束（不再照印「成功啟動」、不會變成孤兒）', async () => {
        const blocker = net.createServer();
        await new Promise(r => blocker.listen(0, r));
        const port = blocker.address().port;
        try {
            const r = await runServer(port);
            assert.equal(r.signal, null, `server.js 沒有自己結束（被時限殺掉）；stdout：${r.stdout}`);
            assert.equal(r.code, 1);
            assert.match(r.stderr, /EADDRINUSE/);
            assert.match(r.stderr, new RegExp(`聽不了連接埠 ${port}`));
            assert.doesNotMatch(r.stdout, /成功安全啟動/);
            assert.equal(w.listenErrorCode(r.stderr), 'EADDRINUSE');
        } finally {
            await new Promise(r => blocker.close(r));
        }
    });

    test('埠空著 → 照舊印「成功安全啟動」（正常啟動的行為不變）', async () => {
        const probe = net.createServer();
        await new Promise(r => probe.listen(0, r));
        const port = probe.address().port;
        await new Promise(r => probe.close(r));
        const r = await runServer(port, { until: /成功安全啟動/ });
        assert.equal(r.sawUntil, true, `沒看到啟動訊息；stderr：${r.stderr}`);
        assert.match(r.stdout, new RegExp(`http://localhost:${port}`));
        assert.doesNotMatch(r.stderr, /無法啟動/);
    });
});
