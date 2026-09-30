// desktop/test/wording.test.js — 啟動畫面的文字沿用 A、只換「怎麼重來」（lib/wording.js）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Wd = require('../lib/wording');
const { desktopPaths } = require('../lib/paths');

const P = desktopPaths();
const plan = require(path.join(P.launcherLib, 'plan'));

/** A 專用、桌面版不該出現的說法 */
const A_ONLY = [/關閉出題系統/, /「出題系統」圖示/, /點一次圖示/, /node server\.js/, /(?<!桌面)啟動器/];
const assertDesktopWording = (text, label) => {
    for (const re of A_ONLY) assert.doesNotMatch(String(text), re, `${label}：${text}`);
};

/** 讓 A 的每一種失敗都組得出訊息的事實 */
const FACTS = {
    health: { state: 'other', detail: '3000 埠上的程式回 HTTP 404' },
    portOwner: { pid: 1234, name: 'node.exe', text: 'node.exe（PID 1234）', pids: [1234], ownServer: true },
    serverStop: { pid: 99, stopped: true },
    server: { spawned: false, error: 'spawn EPERM', logFile: 'x.log' },
    serverWait: { ready: false, reason: 'exited', exitCode: 1, logTail: '✖ 後端無法啟動' },
    dockerLaunch: { ok: false, reason: 'not-found', path: 'C:\\Docker.exe', error: 'EPERM' },
    compose: { ok: false, error: 'exit 1', outputTail: 'x' },
    dbAfterCompose: { reachable: false, error: 'ECONNREFUSED' },
    recording: { active: true, matches: ['node rerecord_all.js'] }
};
const CODES = ['port-in-use', 'port-reserved', 'server-busy', 'env-missing', 'modules-missing', 'db-url-missing', 'recording-db-down',
    'docker-not-found', 'docker-launch-failed', 'docker-timeout', 'compose-failed', 'db-unreachable', 'server-spawn-failed',
    'server-exited', 'server-timeout', 'internal', 'something-new'];
const CTX = { port: 53124, serverLog: 'exam_pro\\data\\logs\\desktop-server-2026-09-27.log', launcherLog: 'exam_pro\\data\\logs\\desktop-2026-09-27.log', serverReadyTimeoutSec: 120 };

describe('A 的失敗訊息換成桌面版的說法', () => {
    test('每一種失敗：沒有留下 A 專用的說法；標題、訊息、處理方式都有', () => {
        for (const code of CODES) {
            const action = plan.fail(code, FACTS, CTX, { detail: 'd' });
            const f = Wd.desktopFailure(action, FACTS, CTX);
            assert.equal(f.code, code);
            assert.ok(f.title && f.message && f.hint.length, code);
            assertDesktopWording([f.title, f.message, ...f.hint].join('\n'), code);
        }
    });

    test('怎麼重來：再開一次「出題系統（桌面版）」', () => {
        const f = Wd.desktopFailure(plan.fail('env-missing', FACTS, CTX), FACTS, CTX);
        assert.ok(f.hint.some(h => h.includes('再開一次桌面的「出題系統（桌面版）」')), f.hint.join('\n'));
    });

    test('後端的三種失敗由桌面版自己寫：記錄檔是 desktop-server-日期.log、立刻結束時附上最後幾行', () => {
        const exited = Wd.desktopFailure(plan.fail('server-exited', FACTS, CTX), FACTS, CTX);
        assert.equal(exited.title, '後端啟動後立刻結束');
        assert.match(exited.message, /結束碼 1/);
        assert.equal(exited.detail, '✖ 後端無法啟動');
        assert.ok(exited.hint.some(h => h.includes(CTX.serverLog)));
        const timeout = Wd.desktopFailure(plan.fail('server-timeout', FACTS, CTX), { serverWait: { ready: false, reason: 'timeout' } }, CTX);
        assert.match(timeout.message, /120 秒內/);
        assert.match(timeout.message, /不會留在背景/);
        const spawn = Wd.desktopFailure(plan.fail('server-spawn-failed', FACTS, CTX), FACTS, CTX);
        assert.match(spawn.message, /spawn EPERM/);
    });

    test('後端一直異常結束：次數、結束碼、重跑範圍', () => {
        const f = Wd.desktopFailure({ code: 'backend-crashed' }, {}, CTX, { crashCount: 2, exitCode: 3221225477, logTail: 'boom' });
        assert.equal(f.title, '後端一直異常結束');
        assert.match(f.message, /2 次/);
        assert.match(f.message, /3221225477/);
        assert.equal(f.detail, 'boom');
        assert.ok(f.hint.some(h => h.includes(plan.UNFINISHED_WORK_NOTE)));
    });
});

describe('A 的警告換成桌面版的說法', () => {
    test('錄製中暫停背景工作：錄完後從系統匣結束、再開一次桌面版', () => {
        const ws = plan.collectWarnings({ recording: { active: true, pauseJobs: true }, db: { reachable: true } }).map(Wd.adaptWarning);
        const w = ws.find(x => x.code === 'recording');
        assert.match(w.text, /錄完後從系統匣選「結束」，再開一次桌面的「出題系統（桌面版）」/);
        assertDesktopWording(w.text, 'recording');
    });

    test('各種警告都沒有 A 專用的說法', () => {
        const facts = {
            configWarnings: ['x 不認得'],
            recording: { active: true, pauseJobs: false },
            db: { reachable: true },
            setup: { draining: { pid: 5 } },
            ollamaNeed: { needed: true, models: ['qwen3:8b'], host: 'http://x', ocrNeeded: true, ocrFound: false },
            ollamaLaunch: { ok: false, reason: 'remote-host' },
            migrations: { ok: true, pending: ['0021_x.sql'], unknown: ['0099_y.sql'], appliedCount: 3 },
            serverWait: { ready: true, dbOk: false }
        };
        const ws = plan.collectWarnings(facts).map(Wd.adaptWarning);
        assert.ok(ws.length >= 6);
        for (const w of ws) assertDesktopWording(w.text, w.code);
        assert.match(ws.find(w => w.code === 'config').text, /啟動設定檔（與桌面啟動器 A 共用）/);
        assert.match(ws.find(w => w.code === 'server-db-degraded').text, /請從系統匣選「結束」/);
    });
});

describe('另一個後端連著同一個庫', () => {
    test('沒有：null', () => {
        assert.equal(Wd.otherBackendWarning(null), null);
        assert.equal(Wd.otherBackendWarning({ connections: 0, webRunning: false, webPort: 3000 }), null);
        assert.equal(Wd.otherBackendWarning({ connections: null, webRunning: false, webPort: 3000 }), null);
    });

    test('網頁版在 .env 的埠上、或資料庫有這套系統的連線：警告', () => {
        const a = Wd.otherBackendWarning({ connections: 3, webRunning: true, webPort: 3000 });
        assert.equal(a.code, 'other-backend');
        assert.match(a.text, /http:\/\/localhost:3000/);
        assert.match(a.text, /Ctrl\+C/);
        const b = Wd.otherBackendWarning({ connections: 2, webRunning: false, webPort: 3000 });
        assert.match(b.text, /2 條來自這套系統的連線/);
    });
});

describe('啟動畫面（A 的 status.html）', () => {
    const html = Wd.adaptStatusHtml(fs.readFileSync(P.statusHtml, 'utf8'));

    test('換成桌面版的說法與標題；其他不動', () => {
        assert.doesNotMatch(html, /「出題系統」圖示/);
        assert.match(html, /<title>出題系統（桌面版）・啟動中<\/title>/);
        assert.match(html, /再開一次桌面的「出題系統（桌面版）」/);
        assert.match(html, /fetch\('state'/, '啟動頁照樣每 0.7 秒讀 /state');
        assert.match(html, /location\.replace\(url\)/);
    });

    test('仍然不引用任何外部資源（本機模式執行期零外連；與 A 的啟動頁同一套檢查）', () => {
        const offline = require(path.join(P.appDir, 'scripts', 'check_html_offline'));
        assert.deepEqual(offline.checkText('scripts/desktop/status.html', html), []);
        assert.deepEqual(offline.localResourceRefs(html), []);
    });
});
