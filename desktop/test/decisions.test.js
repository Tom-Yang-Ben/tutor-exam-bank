// desktop/test/decisions.test.js — 關視窗、系統匣、結束、第二次開啟、後端異常結束的規則（lib/decisions.js；DA-2＝3）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const D = require('../lib/decisions');

const APP_DIR = path.resolve(__dirname, '..', '..', 'exam_pro');
const busy = n => ({ inFlight: n, shuttingDown: false, jobsPaused: false });

describe('關視窗（右上角 X）', () => {
    test('還在啟動、啟動失敗：後端沒在跑，直接結束', () => {
        assert.deepEqual(D.decideWindowClose({ phase: 'starting', status: null }), { action: 'quit' });
        assert.deepEqual(D.decideWindowClose({ phase: 'failed', status: null }), { action: 'quit' });
    });

    test('有在途工作：縮到系統匣（busy，帶件數）', () => {
        assert.deepEqual(D.decideWindowClose({ phase: 'running', status: busy(2) }), { action: 'hide', reason: 'busy', inFlight: 2 });
    });

    test('問不到（後端正忙、逾時）：寧可縮到系統匣，不要誤關', () => {
        assert.deepEqual(D.decideWindowClose({ phase: 'running', status: null }), { action: 'hide', reason: 'unknown' });
    });

    test('沒有工作（包含背景工作被暫停）：直接結束', () => {
        assert.deepEqual(D.decideWindowClose({ phase: 'running', status: busy(0) }), { action: 'quit' });
        assert.deepEqual(D.decideWindowClose({ phase: 'running', status: { inFlight: 0, shuttingDown: false, jobsPaused: true } }), { action: 'quit' });
    });

    test('已經在結束中、Windows 登出或關機：不擋', () => {
        assert.deepEqual(D.decideWindowClose({ phase: 'running', quitting: true, status: busy(3) }), { action: 'close' });
        assert.deepEqual(D.decideWindowClose({ phase: 'running', sessionEnding: true, status: busy(3) }), { action: 'close' });
    });

    test('Windows 登出或關機：只有 session-end 才算；query-session-end 之後被取消，回來按 X 照常縮到系統匣（不直接放棄）', () => {
        // 關機被別的程式擋下、使用者按了「取消」：只收到 query-session-end，之後不會再有任何事件
        let s = D.sessionEndingAfter(false, 'query-session-end');
        assert.equal(s, false);
        assert.deepEqual(D.decideWindowClose({ phase: 'running', sessionEnding: s, status: busy(2) }), { action: 'hide', reason: 'busy', inFlight: 2 });
        assert.deepEqual(D.decideWindowClose({ phase: 'running', sessionEnding: s, status: null }), { action: 'hide', reason: 'unknown' });
        // 再問一次也一樣（連續兩次關機都被取消）
        s = D.sessionEndingAfter(s, 'query-session-end');
        assert.equal(s, false);
        // 確定要結束（WM_ENDSESSION）：之後不擋、不問
        s = D.sessionEndingAfter(s, 'session-end');
        assert.equal(s, true);
        assert.deepEqual(D.decideWindowClose({ phase: 'running', sessionEnding: s, status: busy(2) }), { action: 'close' });
        assert.equal(D.sessionEndingAfter(true, 'query-session-end'), true, 'session-end 之後不會被改回來');
    });
});

describe('縮到系統匣後：處理完了沒', () => {
    test('歸零要持續 settleMs 才算處理完；邊界剛好等於也算', () => {
        let s = D.nextDoneState({ zeroSince: null, now: 1000, status: busy(0), settleMs: 10_000 });
        assert.deepEqual(s, { zeroSince: 1000, done: false });
        s = D.nextDoneState({ zeroSince: s.zeroSince, now: 10_999, status: busy(0), settleMs: 10_000 });
        assert.equal(s.done, false);
        s = D.nextDoneState({ zeroSince: s.zeroSince, now: 11_000, status: busy(0), settleMs: 10_000 });
        assert.deepEqual(s, { zeroSince: 1000, done: true });
    });

    test('中途又有工作（單題的下一步被認領）或問不到：重新計時', () => {
        let s = D.nextDoneState({ zeroSince: 1000, now: 5000, status: busy(1) });
        assert.deepEqual(s, { zeroSince: null, done: false });
        s = D.nextDoneState({ zeroSince: 1000, now: 50_000, status: null });
        assert.deepEqual(s, { zeroSince: null, done: false });
    });

    test('預設的持續時間比 jobRunner 的認領間隔（JOB_POLL_MS 預設 2 秒）長好幾輪', () => {
        const { loadConfig } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
        assert.ok(D.DONE_SETTLE_MS >= 3 * loadConfig({}).pollMs);
    });
});

describe('系統匣的「結束」', () => {
    test('沒在跑或沒有工作：直接結束；有工作或問不到：先問', () => {
        assert.equal(D.decideTrayQuit({ phase: 'starting', status: null }), 'quit');
        assert.equal(D.decideTrayQuit({ phase: 'failed', status: null }), 'quit');
        assert.equal(D.decideTrayQuit({ phase: 'running', status: busy(0) }), 'quit');
        assert.equal(D.decideTrayQuit({ phase: 'running', status: busy(1) }), 'ask');
        assert.equal(D.decideTrayQuit({ phase: 'running', status: null }), 'ask');
    });

    test('對話框：三個選擇、預設「等處理完」、Esc＝取消', () => {
        const d = D.quitDialog({ inFlight: 2, leaseMs: 180000 });
        assert.deepEqual(d.buttons, ['等處理完再結束', '現在放棄', '取消']);
        assert.deepEqual(d.choices, ['wait', 'abandon', 'cancel']);
        assert.equal(d.defaultId, 0);
        assert.equal(d.cancelId, 2);
        assert.match(d.message, /背景還有 2 件工作在處理/);
    });

    test('寫明重跑範圍：照現行 jobRunner（沿用 A 的同一句），不記成失敗、不用掉重試次數；〔dec/r8-b1-abandon〕下次開啟馬上接手，被強制結束時才要等租約', () => {
        const d = D.quitDialog({ inFlight: 1, leaseMs: 180000 });
        const plan = require(path.join(APP_DIR, 'scripts', 'desktop', 'lib', 'plan'));
        assert.ok(d.detail.includes(plan.UNFINISHED_WORK_NOTE), '要和桌面啟動器 A 的說法一字不差（A 或 DA-13 更新時跟著變）');
        // 重跑範圍的內容以 A 的那一句為準（現行 jobRunner：單題接著做、拆題與變式整份重跑；DA-13 的檢查點
        // 合併後 A 改成「從中斷的那一塊／那一題」），這裡只釘住三種工作單位都有講到，不寫死其中一版的字句
        assert.match(d.detail, /單題的檢查從中斷那一步接著做/);
        assert.match(plan.UNFINISHED_WORK_NOTE, /拆題/);
        assert.match(plan.UNFINISHED_WORK_NOTE, /變式生成/);
        // 〔dec/r8-b1-abandon〕放棄改走 jobRunner 的 shutdown({ abandon })：中止在途節點、不記成逾時、只放掉自己的租約
        assert.match(d.detail, /「現在放棄」：中止正在跑的那一步（例如拆題的 OCR 或模型呼叫），幾秒內結束/);
        assert.match(d.detail, /不會記成失敗或逾時，也不會用掉重試次數/);
        assert.match(d.detail, /下次開啟馬上就會接手，不必等租約到期/);
        assert.match(d.detail, /萬一後端沒在 15 秒內結束而被強制結束，就要等租約到期才會接手（從現在算起最多 3 分鐘）/);
        assert.doesNotMatch(d.detail, /馬上重開的話會先等一下/, '放棄不再要等租約（舊說法）');
        assert.match(d.detail, /拆題是整份卷算一件：正在拆的卷會拆到完/);
        assert.match(d.detail, /最多 6 小時/);
        assert.match(d.detail, /還在排隊的工作留到下次開啟再做/);
    });

    test('「等處理完」講清楚單題只做完正在跑的那一步（runner.stop() 之後不再認領下一步）', () => {
        const wait = D.quitDialog({ inFlight: 2, leaseMs: 180000 }).detail.split('\n\n')[0];
        assert.match(wait, /^「等處理完再結束」/);
        assert.match(wait, /單題的檢查只做完正在跑的那一步，後面的步驟（例如 lint、驗算、入庫）下次開啟再接著做/);
        assert.match(wait, /剛拆出來或剛生成的題目也是下次開啟才開始檢查/);
        // 對照 jobRunner：單題一次只跑一個節點（runJobQuestion），stop() 只清掉認領的計時器
        const src = require('node:fs').readFileSync(path.join(APP_DIR, 'workers', 'jobRunner.js'), 'utf8');
        assert.match(src, /function stop\(\) \{\s*if \(timer\) \{ clearInterval\(timer\); timer = null; \}\s*\}/,
            'jobRunner 的 stop() 改了（例如加了 abandon 或讓單題跑完全部步驟）：「等處理完」的說法要跟著改');
    });

    test('租約照 .env 的 JOB_LEASE_MS；在途數不明時換一種說法', () => {
        assert.match(D.quitDialog({ inFlight: 1, leaseMs: 600000 }).detail, /從現在算起最多 10 分鐘/);
        const d = D.quitDialog({ inFlight: null, leaseMs: 180000 });
        assert.match(d.message, /後端正忙，無法確認/);
        assert.match(d.detail, /手上的工作做完/);
    });

    test('「等處理完」的上限與 launcherControl 的 MAX_GRACE_MS 相同（6 小時）', () => {
        const lc = require(path.join(APP_DIR, 'services', 'launcherControl'));
        assert.equal(D.WAIT_ALL_MS, lc.MAX_GRACE_MS);
    });

    test('〔dec/r8-b1-abandon〕放棄時等後端收尾的時間與 launcherControl 的 ABANDON_WAIT_MS 相同；對話框的「15 秒」＝它＋KILL_AFTER_MS', () => {
        const lc = require(path.join(APP_DIR, 'services', 'launcherControl'));
        assert.equal(D.ABANDON_WAIT_MS, lc.ABANDON_WAIT_MS);
        assert.equal(D.fmtDuration(D.ABANDON_WAIT_MS + D.KILL_AFTER_MS), '15 秒');
    });
});

describe('第二次開啟', () => {
    test('平常把視窗叫到前面；結束中只通知', () => {
        assert.equal(D.decideSecondInstance({ quitting: false }), 'focus');
        assert.equal(D.decideSecondInstance({ quitting: true }), 'notify-quitting');
    });
});

describe('後端結束了', () => {
    const base = { phase: 'running', quitting: false, expected: false, closeRequested: false, crashes: [], now: 1_000_000 };

    test('桌面版要它結束的、正在結束、還在啟動、已經失敗：不另外處理', () => {
        for (const o of [{ expected: true }, { quitting: true }, { phase: 'starting' }, { phase: 'failed' }]) {
            assert.equal(D.decideBackendExit({ ...base, ...o }).action, 'ignore', JSON.stringify(o));
        }
    });

    test('第一次異常結束：自動重開；10 分鐘內第二次：停下來', () => {
        const first = D.decideBackendExit(base);
        assert.equal(first.action, 'restart');
        assert.deepEqual(first.crashes, [1_000_000]);
        const second = D.decideBackendExit({ ...base, crashes: first.crashes, now: 1_000_000 + 60_000 });
        assert.equal(second.action, 'give-up');
    });

    test('隔了 10 分鐘以上再當：當成第一次', () => {
        const r = D.decideBackendExit({ ...base, crashes: [1_000_000], now: 1_000_000 + D.CRASH_WINDOW_MS + 1 });
        assert.equal(r.action, 'restart');
        assert.equal(r.crashes.length, 1);
    });

    test('視窗已經關了（在系統匣等處理完）：不重開，直接結束', () => {
        assert.equal(D.decideBackendExit({ ...base, closeRequested: true }).action, 'quit');
    });
});

describe('系統匣選單', () => {
    const ids = items => items.filter(i => i.id).map(i => i.id);

    test('平常：開啟、狀態、三個資料夾、結束；「現在放棄」只在等處理完的時候出現', () => {
        const items = D.trayMenuModel({ phase: 'running', status: busy(1) });
        assert.deepEqual(ids(items), ['open', 'status', 'open-logs', 'open-data', 'open-backups', 'quit']);
        assert.equal(items.find(i => i.id === 'status').enabled, false);
        const draining = D.trayMenuModel({ phase: 'running', status: busy(1), quitting: true, draining: true });
        assert.deepEqual(ids(draining), ['open', 'status', 'open-logs', 'open-data', 'open-backups', 'abandon', 'quit']);
        assert.equal(draining.find(i => i.id === 'quit').enabled, false);
        assert.equal(draining.find(i => i.id === 'open').enabled, false);
    });

    test('狀態那一行', () => {
        assert.equal(D.statusLine({ phase: 'starting', status: null }), '啟動中…');
        assert.equal(D.statusLine({ phase: 'failed', status: null }), '啟動失敗（原因見視窗）');
        assert.equal(D.statusLine({ phase: 'running', status: null }), '背景工作：無法確認（後端正忙）');
        assert.equal(D.statusLine({ phase: 'running', status: busy(0) }), '背景工作：沒有');
        assert.equal(D.statusLine({ phase: 'running', status: busy(3) }), '背景工作：3 件處理中');
        assert.equal(D.statusLine({ phase: 'running', status: { inFlight: 0, jobsPaused: true } }), '背景工作：暫停中（沒有啟動背景處理）');
        assert.equal(D.statusLine({ phase: 'running', status: busy(2), quitting: true, draining: true }), '正在結束：等 2 件工作處理完');
        assert.equal(D.statusLine({ phase: 'running', status: busy(2), quitting: true }), '正在結束…');
    });

    test('提示文字不超過 Windows 的 127 個字元', () => {
        assert.ok(D.trayTooltip({ phase: 'running', status: busy(12345), quitting: true, draining: true }).length <= 127);
    });
});

describe('通知', () => {
    test('縮到系統匣：寫出件數、處理完會通知並自動結束', () => {
        const n = D.hideNotice({ reason: 'busy', inFlight: 2 });
        assert.equal(n.title, '出題系統仍在背景處理');
        assert.match(n.body, /還有 2 件工作在處理/);
        assert.match(n.body, /處理完會再通知你，然後自動結束/);
        assert.match(D.hideNotice({ reason: 'unknown' }).body, /無法確認/);
    });

    test('其他通知都有標題與內容', () => {
        for (const n of [D.doneNotice(), D.drainingNotice(2), D.drainingNotice(null), D.drainedNotice(), D.quittingNotice(true), D.quittingNotice(false),
            D.crashRestartNotice(180000), D.crashQuitNotice('x.log')]) {
            assert.ok(n.title && n.body, JSON.stringify(n));
        }
        assert.match(D.drainingNotice(2).body, /2 件工作/);
        assert.match(D.drainingNotice(2).body, /現在放棄/);
    });
});

test('fmtDuration', () => {
    assert.equal(D.fmtDuration(10_000), '10 秒');
    assert.equal(D.fmtDuration(180_000), '3 分鐘');
    assert.equal(D.fmtDuration(6 * 3600_000), '6 小時');
    assert.equal(D.fmtDuration(90 * 60_000), '1 小時 30 分');
});
