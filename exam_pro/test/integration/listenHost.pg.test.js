// ─────────────────────────────────────────────────────────────
// listenHost.pg.test.js — 後端聽的位址 HOST，真的執行 server.js、連真的資料庫（〔Owner 第六輪 DA-11＝1，2026-09-27〕）
//
// 與 health.pg.test.js 同一套防呆：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾。子行程的 DATABASE_URL 指向它，
// JOB_RUNNER=off（不跑背景工作），cwd 是暫存資料夾（不讀任何 .env），環境一律先刪掉 HOST 再依案例設定。
// 本檔**不寫資料庫**（只打 GET /api/health）。
//   1. 沒寫 HOST：127.0.0.1 的 /api/health 回 200、資料庫正常；桌面啟動器的健康檢查（真的 lib/system.js＋probes.js）
//      認得出「本系統、資料庫正常」；這台電腦的區網位址連不到。
//   2. HOST=0.0.0.0：區網位址也拿得到 200（本機以外的來源，走健康檢查的限流器也放行第一次）；啟動器照樣從 127.0.0.1 問。
// 區網位址取 os.networkInterfaces() 的第一個非 127.x 的 IPv4；沒有就略過那一段。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('HOST 整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 node -r dotenv/config --test "test/integration/**/*.test.js"'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function lanIPv4() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !String(a.address).startsWith('127.')) return a.address;
        }
    }
    return null;
}

async function freePort() {
    const probe = net.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise(r => probe.close(r));
    return port;
}

/** GET http://host:port/api/health → {status, body} 或 {error: 錯誤碼} */
function getHealth(host, port, timeoutMs = 5000) {
    const http = require('node:http');
    return new Promise(resolve => {
        const req = http.get({ host, port, path: '/api/health', timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(text); } catch (_) { body = null; }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', e => resolve({ error: e.code || 'ERROR' }));
    });
}

function runSuite() {
    const { createSystem } = require(path.join(APP_DIR, 'scripts', 'desktop', 'lib', 'system'));
    const probes = require(path.join(APP_DIR, 'scripts', 'desktop', 'lib', 'probes'));

    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-host-pg-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    /** 背景執行 server.js（真的資料庫），等到啟動訊息；回傳 stop() */
    function startServer(port, extra = {}) {
        const env = { ...process.env, PORT: String(port), DATABASE_URL: TEST_DATABASE_URL, JOB_RUNNER: 'off' };
        delete env.LAUNCHER_CONTROL_TOKEN;
        delete env.API_KEY;
        delete env.HOST;
        Object.assign(env, extra);
        const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = { stdout: '', stderr: '' };
        let exited = false;
        const ready = new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), 30_000);
            child.stdout.on('data', d => {
                out.stdout += d;
                if (/成功安全啟動/.test(out.stdout)) { clearTimeout(timer); resolve(true); }
            });
            child.stderr.on('data', d => { out.stderr += d; });
            child.on('exit', () => { exited = true; clearTimeout(timer); resolve(false); });
        });
        const stop = () => new Promise(resolve => {
            if (exited) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGKILL');
        });
        return { ready, out, stop };
    }

    describe('server.js 的 HOST（真的資料庫）', () => {
        test('沒寫 HOST → 127.0.0.1 的健康檢查 200、資料庫正常；啟動器認得出本系統；區網位址連不到', async t => {
            const port = await freePort();
            const s = startServer(port);
            try {
                assert.equal(await s.ready, true, `沒看到啟動訊息；stderr：${s.out.stderr}`);
                assert.match(s.out.stdout, /HOST=127\.0\.0\.1）/);
                const local = await getHealth('127.0.0.1', port);
                assert.equal(local.status, 200, JSON.stringify(local));
                assert.equal(local.body.service, 'tutor-exam-bank');
                assert.deepEqual(local.body.db, { ok: true });

                // 桌面啟動器（真的 lib/system.js）照 .env 沒寫 HOST 的情況去問
                const p = probes.createProbes({ sys: createSystem(), config: {}, env: {}, paths: probes.appPaths(APP_DIR), port });
                assert.equal(p.base, `http://127.0.0.1:${port}`);
                const h = await p.probeHealth({ timeoutMs: 5000 });
                assert.equal(h.state, 'ours', JSON.stringify(h));
                assert.equal(h.dbOk, true);

                const lan = lanIPv4();
                if (!lan) { t.diagnostic('這台機器沒有區網 IPv4，略過「區網連不到」那一段'); return; }
                const remote = await getHealth(lan, port);
                assert.equal(remote.error, 'ECONNREFUSED', `區網位址 ${lan} 不該連得到：${JSON.stringify(remote)}`);
            } finally {
                await s.stop();
            }
        });

        test('HOST=0.0.0.0 → 區網位址也拿得到 200；啟動器仍從 127.0.0.1 問', async t => {
            const lan = lanIPv4();
            if (!lan) { t.skip('這台機器沒有區網 IPv4'); return; }
            const port = await freePort();
            const s = startServer(port, { HOST: '0.0.0.0' });
            try {
                assert.equal(await s.ready, true, `沒看到啟動訊息；stderr：${s.out.stderr}`);
                assert.match(s.out.stdout, /HOST=0\.0\.0\.0：同一個網路的其他裝置也連得到/);
                const remote = await getHealth(lan, port);
                assert.equal(remote.status, 200, JSON.stringify(remote));
                assert.deepEqual(remote.body.db, { ok: true });
                const p = probes.createProbes({ sys: createSystem(), config: {}, env: { HOST: '0.0.0.0' }, paths: probes.appPaths(APP_DIR), port });
                assert.equal(p.base, `http://127.0.0.1:${port}`);
                assert.equal((await p.probeHealth({ timeoutMs: 5000 })).state, 'ours');
            } finally {
                await s.stop();
            }
        });
    });
}
