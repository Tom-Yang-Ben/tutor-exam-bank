// desktop/test/config.test.js — 後端子行程的環境變數、路徑、記錄檔（lib/config.js、lib/paths.js、lib/logs.js）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/config');
const { desktopPaths, userDataDir } = require('../lib/paths');
const L = require('../lib/logs');

describe('後端的環境變數（backendEnv）', () => {
    const dotenvVars = { DATABASE_URL: 'postgres://exam:exam@localhost:5442/tutor_exam_bank', PORT: '3000', ALLOWED_ORIGINS: 'http://localhost:3000', API_KEY: 'k', MODEL_VERIFY: 'ollama:qwen3:8b' };

    test('.env 的值，被系統環境變數蓋過（與 npm start 的 dotenv 相同）', () => {
        const env = C.backendEnv({ systemEnv: { MODEL_VERIFY: 'gemini-2.5-flash', PATH: '/bin' }, dotenvVars, port: 53124 });
        assert.equal(env.DATABASE_URL, dotenvVars.DATABASE_URL);
        assert.equal(env.MODEL_VERIFY, 'gemini-2.5-flash');
        assert.equal(env.PATH, '/bin');
        assert.equal(env.API_KEY, 'k', '.env 的 API_KEY 照帶（首頁照樣注入）');
    });

    test('執行期的 PORT 與 ALLOWED_ORIGINS 蓋過 .env（同源 POST 才過得了 CORS）', () => {
        const env = C.backendEnv({ systemEnv: { PORT: '9999' }, dotenvVars, port: 53124 });
        assert.equal(env.PORT, '53124');
        assert.equal(env.ALLOWED_ORIGINS, 'http://127.0.0.1:53124,http://localhost:53124');
        assert.equal(C.allowedOriginsFor(1), 'http://127.0.0.1:1,http://localhost:1');
    });

    test('拿掉 A 的關閉通道權杖與 ELECTRON_RUN_AS_NODE', () => {
        const env = C.backendEnv({ systemEnv: { LAUNCHER_CONTROL_TOKEN: 'f'.repeat(64), ELECTRON_RUN_AS_NODE: '1' }, dotenvVars, port: 1 });
        assert.equal('LAUNCHER_CONTROL_TOKEN' in env, false);
        assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
    });

    test('錄製中要暫停才加 JOB_RUNNER=off；.env 自己寫的 JOB_RUNNER 照留', () => {
        assert.equal(C.backendEnv({ systemEnv: {}, dotenvVars, port: 1 }).JOB_RUNNER, undefined);
        assert.equal(C.backendEnv({ systemEnv: {}, dotenvVars, port: 1, jobsPaused: true }).JOB_RUNNER, 'off');
        assert.equal(C.backendEnv({ systemEnv: {}, dotenvVars: { ...dotenvVars, JOB_RUNNER: 'off' }, port: 1 }).JOB_RUNNER, 'off');
    });

    test('不改傳進來的物件', () => {
        const sys = { A: '1' };
        const dv = { ...dotenvVars };
        C.backendEnv({ systemEnv: sys, dotenvVars: dv, port: 1, jobsPaused: true });
        assert.deepEqual(sys, { A: '1' });
        assert.deepEqual(dv, dotenvVars);
    });

    test('租約與背景工作開關的讀法與 jobRunner 相同', () => {
        const { loadConfig } = require(path.join(desktopPaths().appDir, 'workers', 'jobRunner'));
        assert.equal(C.leaseMsOf({}), loadConfig({}).leaseMs);
        assert.equal(C.leaseMsOf({ JOB_LEASE_MS: '600000' }), 600000);
        assert.equal(C.leaseMsOf({ JOB_LEASE_MS: 'abc' }), 180000);
        assert.equal(C.runnerDisabled({}), false);
        assert.equal(C.runnerDisabled({ JOB_RUNNER: 'INLINE' }), false);
        assert.equal(C.runnerDisabled({ JOB_RUNNER: 'off' }), true);
    });
});

describe('路徑', () => {
    test('用到的檔案都在（A 的啟動頁、圖示、plan；後端進入點；exam_pro 的 startServer）', () => {
        const p = desktopPaths();
        for (const f of [p.statusHtml, p.icon, p.backendEntry, path.join(p.launcherLib, 'plan.js'), path.join(p.appDir, 'startServer.js'), path.join(p.appDir, 'server.js')]) {
            assert.ok(fs.existsSync(f), f);
        }
        assert.equal(p.logsDir, path.join(p.appDir, 'data', 'logs'), 'B1 的記錄檔和 A 放在一起（B2 一起搬）');
    });

    test('Chromium 設定檔：Windows 放 %LOCALAPPDATA%\\TutorExamBank\\electron；可用環境變數改；其他平台用預設', () => {
        assert.equal(userDataDir({ LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, 'win32'), 'C:\\Users\\A\\AppData\\Local\\TutorExamBank\\electron');
        assert.equal(userDataDir({ USERPROFILE: 'C:\\Users\\A' }, 'win32'), 'C:\\Users\\A\\AppData\\Local\\TutorExamBank\\electron');
        assert.equal(userDataDir({ TUTOR_DESKTOP_USER_DATA: '/tmp/x', LOCALAPPDATA: 'C:\\L' }, 'win32'), '/tmp/x');
        assert.equal(userDataDir({}, 'linux'), null);
        assert.match(userDataDir({ LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, 'win32'), /^[\x20-\x7e]+$/, '路徑只有英數字（DA-1）');
    });
});

describe('記錄檔', () => {
    test('檔名：desktop-日期.log、desktop-server-日期.log（和 A 的 launcher-／server- 分開）', () => {
        const f = L.logFiles('/logs', new Date(2026, 8, 7));
        assert.equal(f.main, path.join('/logs', 'desktop-2026-09-07.log'));
        assert.equal(f.server, path.join('/logs', 'desktop-server-2026-09-07.log'));
    });

    test('只刪 14 天以前的桌面版記錄檔，A 的不動', () => {
        const now = new Date(2026, 8, 27, 10, 0, 0);
        const names = ['desktop-2026-09-12.log', 'desktop-2026-09-13.log', 'desktop-server-2026-09-01.log', 'desktop-2026-09-27.log',
            'launcher-2026-01-01.log', 'server-2026-01-01.log', 'desktop-notes.log', 'desktop-2026-13-40.log'];
        assert.deepEqual(L.logsToPrune(names, now), ['desktop-2026-09-12.log', 'desktop-server-2026-09-01.log']);
    });

    test('pruneLogs 真的刪檔；createLogger 寫得進去、資料夾不在會建', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-logs-'));
        try {
            fs.writeFileSync(path.join(dir, 'desktop-2020-01-01.log'), 'x');
            fs.writeFileSync(path.join(dir, 'server-2020-01-01.log'), 'x');
            assert.deepEqual(L.pruneLogs(dir, { now: new Date(2026, 8, 27) }), ['desktop-2020-01-01.log']);
            assert.deepEqual(fs.readdirSync(dir), ['server-2020-01-01.log']);
            const file = path.join(dir, 'sub', 'desktop-2026-09-27.log');
            const log = L.createLogger({ file, now: () => new Date(2026, 8, 27, 8, 5, 9), pid: 42 });
            log('第一行');
            log('第二行');
            assert.equal(fs.readFileSync(file, 'utf8'), '2026-09-27 08:05:09 [desktop 42] 第一行\n2026-09-27 08:05:09 [desktop 42] 第二行\n');
            assert.deepEqual(L.pruneLogs(path.join(dir, 'nope')), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
