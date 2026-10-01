// desktop/test/ui.test.js — 視窗的小事（lib/ui.js）與啟動畫面（lib/statusUi.js）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const U = require('../lib/ui');
const { createStatusUi } = require('../lib/statusUi');
const D = require('../lib/decisions');

describe('視窗位置', () => {
    const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];

    test('還在螢幕上：照用；沒記過、太小、跑到螢幕外（外接螢幕拔掉了）：null＝預設大小', () => {
        assert.deepEqual(U.usableBounds({ x: 100, y: 50, width: 1280, height: 860 }, screens), { x: 100, y: 50, width: 1280, height: 860 });
        assert.equal(U.usableBounds(null, screens), null);
        assert.equal(U.usableBounds({ x: 0, y: 0, width: 200, height: 200 }, screens), null);
        assert.equal(U.usableBounds({ x: 2500, y: 0, width: 1280, height: 860 }, screens), null);
        assert.equal(U.usableBounds({ x: 1850, y: 0, width: 1280, height: 860 }, screens), null, '只露出 70px：不算');
        assert.deepEqual(U.usableBounds({ x: 2500, y: 0, width: 1280, height: 860 }, [...screens, { x: 1920, y: 0, width: 2560, height: 1400 }]).x, 2500);
        assert.equal(U.usableBounds({ x: 'a', y: 0, width: 1, height: 1 }, screens), null);
    });

    test('desktop-state.json：寫了讀得回來；壞掉或沒有 → {}', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-state-'));
        try {
            const file = path.join(dir, 'sub', 'desktop-state.json');
            assert.deepEqual(U.readState(file), {});
            assert.equal(U.writeState(file, { lastDownloadDir: 'D:\\教材', windowBounds: { x: 1, y: 2, width: 3, height: 4, maximized: true } }), true);
            assert.deepEqual(U.readState(file), { lastDownloadDir: 'D:\\教材', windowBounds: { x: 1, y: 2, width: 3, height: 4, maximized: true } });
            fs.writeFileSync(file, '{壞掉');
            assert.deepEqual(U.readState(file), {});
            fs.writeFileSync(file, '\uFEFF{"a":1}');
            assert.deepEqual(U.readState(file), { a: 1 });
            fs.writeFileSync(file, '[1]');
            assert.deepEqual(U.readState(file), {});
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('選單', () => {
    test('應用程式選單：編輯與檢視（重新整理、縮放、全螢幕、開發人員工具），全部用 Electron 的 role', () => {
        const t = U.appMenuTemplate();
        assert.deepEqual(t.map(m => m.label), ['編輯', '檢視']);
        const roles = t.flatMap(m => m.submenu.filter(i => i.role).map(i => i.role));
        for (const r of ['copy', 'paste', 'reload', 'zoomIn', 'zoomOut', 'resetZoom', 'togglefullscreen', 'toggleDevTools']) assert.ok(roles.includes(r), r);
    });

    test('右鍵：輸入框有剪下／複製／貼上／全選（照 editFlags 開關）；選到文字只有複製；其他沒有選單', () => {
        const edit = U.contextMenuTemplate({ isEditable: true, editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } });
        assert.deepEqual(edit.filter(i => i.role).map(i => [i.role, i.enabled]), [['cut', false], ['copy', true], ['paste', true], ['selectAll', true]]);
        assert.deepEqual(U.contextMenuTemplate({ isEditable: false, selectionText: '畢氏定理', editFlags: { canCopy: true } }).map(i => i.role), ['copy']);
        assert.equal(U.contextMenuTemplate({ isEditable: false, selectionText: '  ' }), null);
        assert.equal(U.contextMenuTemplate({}), null);
    });
});

describe('桌面捷徑', () => {
    test('目標是 repo 裡的 electron.exe，參數是 desktop 資料夾（加引號），帶 AppUserModelID 與 A 的圖示', () => {
        const s = U.shortcutSpec({
            desktopFolder: 'C:\\Users\\Administrator\\OneDrive\\桌面',
            electronExe: 'C:\\Users\\Administrator\\Desktop\\tutor-exam-bank\\desktop\\node_modules\\electron\\dist\\electron.exe',
            desktopDir: 'C:\\Users\\Administrator\\Desktop\\tutor-exam-bank\\desktop',
            icon: 'C:\\Users\\Administrator\\Desktop\\tutor-exam-bank\\exam_pro\\scripts\\desktop\\assets\\tutor-exam-bank.ico'
        });
        assert.equal(s.file, 'C:\\Users\\Administrator\\OneDrive\\桌面\\出題系統（桌面版）.lnk');
        assert.equal(s.options.args, '"C:\\Users\\Administrator\\Desktop\\tutor-exam-bank\\desktop"');
        assert.equal(s.options.cwd, 'C:\\Users\\Administrator\\Desktop\\tutor-exam-bank\\desktop');
        assert.equal(s.options.appUserModelId, D.AUMID);
        assert.match(s.options.target, /electron\.exe$/);
        assert.match(s.options.icon, /tutor-exam-bank\.ico$/);
        assert.notEqual(path.win32.basename(s.file), '出題系統.lnk', '不能蓋掉桌面啟動器 A 的捷徑');
    });
});

describe('啟動畫面（createStatusUi）', () => {
    function fakes({ deliver = true } = {}) {
        const shown = [];
        let getState = null;
        let onDelivered = null;
        let closed = 0;
        let started = 0;
        const startStatusServer = async o => {
            started += 1;
            getState = o.getState;
            onDelivered = o.onDelivered;
            return { url: `http://127.0.0.1:4000${started}/`, close: async () => { closed += 1; } };
        };
        const showUrl = async url => {
            shown.push(url);
            // 啟動頁每 0.7 秒讀一次 /state：這裡在被問時直接回報「已送達」
            if (deliver && getState) setTimeout(() => onDelivered(getState().version), 5);
        };
        let t = 0;
        const ui = createStatusUi({ startStatusServer, html: '<html></html>', showUrl, now: () => t, sleep: async ms => { t += ms; if (deliver && getState) onDelivered(getState().version); } });
        return { ui, shown, get closed() { return closed; }, get started() { return started; }, state: () => getState() };
    }

    test('開啟動畫面：起小伺服器、視窗載入它；只起一次', async () => {
        const f = fakes();
        const r = await f.ui.openStatusWindow();
        assert.deepEqual(r, { ok: true, via: 'electron', url: 'http://127.0.0.1:40001/' });
        await f.ui.openStatusWindow();
        assert.equal(f.started, 1);
        assert.deepEqual(f.shown, ['http://127.0.0.1:40001/', 'http://127.0.0.1:40001/']);
    });

    test('完成：啟動頁收到最新狀態就交給它轉頁；沒收到就直接載入首頁', async () => {
        const f = fakes();
        await f.ui.openStatusWindow();
        assert.deepEqual(await f.ui.finish('http://127.0.0.1:5555/', []), { via: 'status-page' });
        assert.equal(f.state().phase, 'done');
        assert.equal(f.state().appUrl, 'http://127.0.0.1:5555/');

        const g = fakes({ deliver: false });
        await g.ui.openStatusWindow();
        assert.deepEqual(await g.ui.finish('http://127.0.0.1:5555/', []), { via: 'direct' });
        assert.equal(g.shown[g.shown.length - 1], 'http://127.0.0.1:5555/');
    });

    test('失敗：啟動畫面沒開就先開，再顯示原因', async () => {
        const f = fakes();
        await f.ui.fail({ title: 'T', message: 'M', hint: ['h'], detail: 'D' }, [{ code: 'x', text: 'w' }]);
        assert.equal(f.started, 1);
        const s = f.state();
        assert.equal(s.phase, 'failed');
        assert.deepEqual(s.failure, { title: 'T', message: 'M', hint: ['h'], detail: 'D' });
        assert.deepEqual(s.warnings, [{ code: 'x', text: 'w' }]);
    });

    test('reset：清掉上一輪（後端重開時不會一開頁就轉去舊的網址）；close 關掉小伺服器，之後會再起一個', async () => {
        const f = fakes();
        await f.ui.openStatusWindow();
        await f.ui.finish('http://127.0.0.1:5555/', []);
        f.ui.reset();
        assert.equal(f.state().phase, 'running');
        assert.equal(f.state().appUrl, null);
        await f.ui.close();
        assert.equal(f.closed, 1);
        assert.equal(f.ui.statusUrl, null);
        await f.ui.openStatusWindow();
        assert.equal(f.started, 2);
    });

    test('開不起來：回 ok:false，不丟錯', async () => {
        const ui = createStatusUi({ startStatusServer: async () => { throw new Error('EACCES'); }, html: '', showUrl: async () => { } });
        const r = await ui.openStatusWindow();
        assert.equal(r.ok, false);
        assert.match(r.error, /EACCES/);
    });
});
