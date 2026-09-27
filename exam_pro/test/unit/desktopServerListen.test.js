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
//   5. 〔Owner 第六輪 DA-11＝1，2026-09-27〕server.js 改聽 HOST（config/listenHost.js）：**真的執行 server.js** 驗證
//      沒寫 HOST → 只聽 127.0.0.1（這台電腦的區網位址連不到）；HOST=0.0.0.0 → 區網位址也連得到；
//      HOST 是這台電腦沒有的位址 → 印出怎麼改、結束碼 1；.env 的 HOST 讀得到，系統環境變數優先。
//      子行程的環境一律先刪掉 HOST（跑測試的機器剛好設了 HOST 也不影響），要測的案例才明寫。
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

    // 〔Owner 第六輪 DA-11＝1〕HOST 寫成這台電腦沒有的位址／查不到的名稱：說明怎麼改 HOST
    test('HOST 相關：EADDRNOTAVAIL／ENOTFOUND 帶出 HOST 的值與改法（刪掉＝只給本機、區網寫 0.0.0.0）；其他錯誤也標出 HOST', () => {
        const t = listenFailureText(err('EADDRNOTAVAIL', 'listen EADDRNOTAVAIL: address not available 203.0.113.77:3000'), 3000, '203.0.113.77');
        assert.match(t, /聽不了連接埠 3000（HOST=203\.0\.113\.77）（EADDRNOTAVAIL）/);
        assert.match(t, /HOST 是「203\.0\.113\.77」/);
        assert.match(t, /刪掉 HOST/);
        assert.match(t, /HOST=0\.0\.0\.0/);
        assert.match(t, /區網存取/);
        assert.match(listenFailureText(err('ENOTFOUND', 'getaddrinfo ENOTFOUND nosuch'), 3000, 'nosuch'), /HOST 是「nosuch」/);
        const inUse = listenFailureText(err('EADDRINUSE', 'listen EADDRINUSE: address already in use 127.0.0.1:3000'), 3000, '127.0.0.1');
        assert.match(inUse, /（HOST=127\.0\.0\.1）（EADDRINUSE）/);
        assert.equal(w.listenErrorCode(inUse), 'EADDRINUSE');
        assert.doesNotMatch(inUse, /刪掉 HOST/);
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
            delete env.HOST;
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

// ─────────────────────────── HOST（Owner 第六輪 DA-11＝1）───────────────────────────

/** 這台電腦的一個區網 IPv4（不是 127.x）；沒有就回 null（那一段改成 skip） */
function lanIPv4() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !String(a.address).startsWith('127.')) return a.address;
        }
    }
    return null;
}

/** 空著的埠 */
async function freePort() {
    const probe = net.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise(r => probe.close(r));
    return port;
}

/** 連得上回 'connected'，連不上回錯誤碼（ECONNREFUSED…）；最多等 timeoutMs */
function tryConnect(host, port, timeoutMs = 3000) {
    return new Promise(resolve => {
        const sock = net.connect({ host, port });
        const done = r => { clearTimeout(timer); sock.destroy(); resolve(r); };
        const timer = setTimeout(() => done('TIMEOUT'), timeoutMs);
        sock.once('connect', () => done('connected'));
        sock.once('error', e => done(e.code || 'ERROR'));
    });
}

/**
 * 背景執行 server.js，等它印出啟動訊息（或結束）；回傳之後要自己 stop()。
 * @param {{port:number, cwd:string, env?:object}} o  env 是要加上的變數（HOST 預設刪掉）
 */
function startServer({ port, cwd, env: extra = {} }) {
    const env = { ...process.env, PORT: String(port), DATABASE_URL: 'postgres://nobody:pw@127.0.0.1:1/never_used_test', JOB_RUNNER: 'off' };
    delete env.LAUNCHER_CONTROL_TOKEN;
    delete env.API_KEY;
    delete env.HOST;
    Object.assign(env, extra);
    const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '', code: undefined };
    let exited = false;
    const ready = new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 30_000);
        child.stdout.on('data', d => {
            out.stdout += d;
            if (/成功安全啟動/.test(out.stdout)) { clearTimeout(timer); resolve(true); }
        });
        child.stderr.on('data', d => { out.stderr += d; });
        child.on('exit', code => { exited = true; out.code = code; clearTimeout(timer); resolve(false); });
    });
    const stop = () => new Promise(resolve => {
        if (exited) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
    return { ready, out, stop };
}

describe('server.js 聽的位址（HOST；config/listenHost.js）', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-host-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('沒寫 HOST → 只聽 127.0.0.1：本機連得到、這台電腦的區網位址連不到；啟動訊息寫明只接受本機', async t => {
        const port = await freePort();
        const s = startServer({ port, cwd: dir });
        try {
            assert.equal(await s.ready, true, `沒看到啟動訊息；stderr：${s.out.stderr}`);
            assert.match(s.out.stdout, new RegExp(`成功安全啟動：http://localhost:${port}（只接受這台電腦的連線；HOST=127\\.0\\.0\\.1）`));
            assert.equal(await tryConnect('127.0.0.1', port), 'connected');
            const lan = lanIPv4();
            if (!lan) { t.diagnostic('這台機器沒有區網 IPv4，略過「區網連不到」那一段'); return; }
            assert.equal(await tryConnect(lan, port), 'ECONNREFUSED', `區網位址 ${lan} 不該連得到`);
        } finally {
            await s.stop();
        }
    });

    test('HOST=0.0.0.0 → 區網位址也連得到；啟動訊息提醒防火牆、ALLOWED_ORIGINS 與 API_KEY', async t => {
        const lan = lanIPv4();
        if (!lan) { t.skip('這台機器沒有區網 IPv4'); return; }
        const port = await freePort();
        const s = startServer({ port, cwd: dir, env: { HOST: '0.0.0.0' } });
        try {
            assert.equal(await s.ready, true, `沒看到啟動訊息；stderr：${s.out.stderr}`);
            assert.match(s.out.stdout, /HOST=0\.0\.0\.0：同一個網路的其他裝置也連得到/);
            assert.match(s.out.stdout, /防火牆/);
            assert.match(s.out.stdout, /ALLOWED_ORIGINS/);
            assert.match(s.out.stdout, /API_KEY/);
            assert.equal(await tryConnect('127.0.0.1', port), 'connected');
            assert.equal(await tryConnect(lan, port), 'connected');
        } finally {
            await s.stop();
        }
    });

    test('HOST 設成某一個位址 → 只聽那個位址（區網 IP 連得到、127.0.0.1 連不到）', async t => {
        const lan = lanIPv4();
        if (!lan) { t.skip('這台機器沒有區網 IPv4'); return; }
        const port = await freePort();
        const s = startServer({ port, cwd: dir, env: { HOST: lan } });
        try {
            assert.equal(await s.ready, true, `沒看到啟動訊息；stderr：${s.out.stderr}`);
            assert.match(s.out.stdout, new RegExp(`http://${lan.replace(/\./g, '\\.')}:${port}（只聽 HOST=`));
            assert.equal(await tryConnect(lan, port), 'connected');
            assert.equal(await tryConnect('127.0.0.1', port), 'ECONNREFUSED');
        } finally {
            await s.stop();
        }
    });

    test('HOST 是這台電腦沒有的位址 → 印出 EADDRNOTAVAIL 與怎麼改 HOST、以結束碼 1 結束（不會變成不聽埠的背景程序）', async () => {
        const port = await freePort();
        const s = startServer({ port, cwd: dir, env: { HOST: '203.0.113.77' } });
        try {
            assert.equal(await s.ready, false);
            assert.equal(s.out.code, 1);
            assert.match(s.out.stderr, /EADDRNOTAVAIL/);
            assert.match(s.out.stderr, /HOST 是「203\.0\.113\.77」/);
            assert.doesNotMatch(s.out.stdout, /成功安全啟動/);
        } finally {
            await s.stop();
        }
    });

    test('HOST 寫在 cwd 的 .env 也讀得到；系統環境變數優先於 .env（與其他設定相同）', async () => {
        const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-host-env-'));
        try {
            fs.writeFileSync(path.join(envDir, '.env'), 'HOST=0.0.0.0\n', 'utf8');
            const port = await freePort();
            const fromFile = startServer({ port, cwd: envDir });
            try {
                assert.equal(await fromFile.ready, true, `沒看到啟動訊息；stderr：${fromFile.out.stderr}`);
                assert.match(fromFile.out.stdout, /HOST=0\.0\.0\.0/);
            } finally {
                await fromFile.stop();
            }
            const port2 = await freePort();
            const fromEnv = startServer({ port: port2, cwd: envDir, env: { HOST: '127.0.0.1' } });
            try {
                assert.equal(await fromEnv.ready, true, `沒看到啟動訊息；stderr：${fromEnv.out.stderr}`);
                assert.match(fromEnv.out.stdout, /HOST=127\.0\.0\.1）/);
            } finally {
                await fromEnv.stop();
            }
        } finally {
            fs.rmSync(envDir, { recursive: true, force: true });
        }
    });
});
