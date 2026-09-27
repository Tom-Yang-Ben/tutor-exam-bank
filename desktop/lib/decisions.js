// ─────────────────────────────────────────────────────────────
// desktop/lib/decisions.js — 關視窗、系統匣、結束、第二次開啟、後端異常結束：怎麼決定、畫面上寫什麼
// （docs/desktop-app-design.md 第 2.8 節；Owner 第六輪決策 DA-2＝3「看狀況」、DL-1＝1「每次問」）
//
// 規則（全部是純函式，desktop/test/decisions.test.js 逐條釘住；main.js 只負責照結果做）：
//   關視窗（右上角 X）：
//     - 還在啟動或啟動失敗（後端沒在跑）→ 直接結束；
//     - 問後端在途工作數（services/launcherControl.js 的同一份狀態機，經 utilityProcess 的訊息通道）：
//       有工作 → 縮到系統匣繼續跑並通知；問不到（後端正忙）→ 同樣縮到系統匣（寧可多留，不要誤關長時間的工作）；
//       沒有工作 → 直接結束（優雅關閉後端：停止認領 → 關 HTTP → 等剛認領到的最多 10 秒 → 關連線池）。
//     - 縮到系統匣之後，在途工作歸零並**持續 10 秒**才算「處理完」（runner 每 2 秒認領一次，單題的下一步要等下一輪；
//       只看一次歸零會在兩步之間誤判）→ 通知「處理完了」，幾秒後自動結束（視窗先前已經關了＝要結束的意思）。
//       期間從系統匣或再開一次捷徑把視窗叫回來，就取消這個「處理完就結束」。
//   系統匣的「結束」：
//     - 沒有工作 → 直接結束；有工作或問不到 → 對話框：「等處理完再結束／現在放棄／取消」，文字寫明重跑範圍。
//     - 等處理完：不再認領新工作，等在途的做完（最多 6 小時，與 A 的「是」相同），留在系統匣可以改成「現在放棄」。
//     - 現在放棄：後端馬上結束、**不關連線池、不寫結果**——與當機、A 的「時限到了直接結束」同一條既有的路：
//       不記成失敗、不動重試次數，租約（JOB_LEASE_MS，預設 3 分）到期後下次開啟重新認領。
//       重跑範圍照現行 workers/jobRunner.js（沿用 A 的 UNFINISHED_WORK_NOTE 那一句，A 或 DA-13 更新時這裡跟著變）。
//       設計稿 2.3 節的 shutdown({abandon}) 快速放租約（jobRunner 要改）不在 B1 這一版。
//   後端異常結束（不是我們叫它結束的）：10 分鐘內第一次 → 自動重開（畫面回到啟動畫面）；再一次 → 停下來顯示原因。
//     視窗已經關掉（在系統匣等處理完）時不重開，直接結束並通知。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { desktopPaths } = require('./paths');

const plan = require(path.join(desktopPaths().launcherLib, 'plan'));

/** 捷徑與視窗上的名稱（和桌面啟動器 A 的「出題系統」分開） */
const SHORTCUT_NAME = '出題系統（桌面版）';
/** Windows 的 AppUserModelID：工作列分組、釘選與捷徑都用同一個 */
const AUMID = 'TutorExamBank.Desktop';

/** 沒有工作時結束：最多等剛認領到的工作幾毫秒（第 2.8 節結束順序第 2 步：在途節點最多等 10 秒） */
const QUIT_GRACE_MS = 10_000;
/** 送出關閉之後，時限再加這麼久後端還沒結束就強制結束（例如 mupdf 同步渲染卡住事件迴圈，收不到訊息） */
const KILL_AFTER_MS = 5_000;
/** 「等處理完」最多等多久：與 services/launcherControl.js 的 MAX_GRACE_MS（6 小時）相同 */
const WAIT_ALL_MS = 6 * 60 * 60 * 1000;
/** 問後端狀態的間隔與逾時 */
const STATUS_POLL_MS = 3_000;
const STATUS_TIMEOUT_MS = 3_000;
/** 在途工作歸零要持續多久才算「處理完」（jobRunner 的 JOB_POLL_MS 預設 2 秒，留足兩輪以上） */
const DONE_SETTLE_MS = 10_000;
/** 「處理完了」的通知跳出後，過幾毫秒才結束（通知跟著系統匣圖示消失前讓人看得到） */
const DONE_QUIT_DELAY_MS = 8_000;
/** 後端異常結束的自動重開：這段時間內最多重開幾次 */
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_AUTO_RESTARTS = 1;

/**
 * @typedef {object} BackendStatus
 * @property {number} inFlight       在途工作數（launcherControl 的 in_flight）
 * @property {boolean} shuttingDown
 * @property {boolean} jobsPaused    沒有 runner（JOB_RUNNER=off，或錄製中暫停）
 */

/** 毫秒 → 「10 秒」「3 分鐘」「6 小時」。純函式。 */
function fmtDuration(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} 分鐘`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/** 租約長度 → 「約 3 分鐘」 */
function leaseText(leaseMs) {
    return `約 ${fmtDuration(leaseMs)}`;
}

/**
 * 關視窗（右上角 X）時怎麼辦。純函式。
 * @param {{phase:'starting'|'running'|'failed', quitting?:boolean, sessionEnding?:boolean, status:BackendStatus|null}} o
 * @returns {{action:'close'}|{action:'quit'}|{action:'hide', reason:'busy'|'unknown', inFlight?:number}}
 */
function decideWindowClose({ phase, quitting = false, sessionEnding = false, status }) {
    if (quitting || sessionEnding) return { action: 'close' };
    if (phase !== 'running') return { action: 'quit' };
    if (!status) return { action: 'hide', reason: 'unknown' };
    if (status.inFlight > 0) return { action: 'hide', reason: 'busy', inFlight: status.inFlight };
    return { action: 'quit' };
}

/**
 * 縮到系統匣之後，每問一次後端就算一次「處理完了沒」。純函式。
 * 在途歸零要持續 settleMs 才算數；問不到（null）或又有工作就重新計時。
 * @param {{zeroSince:number|null, now:number, status:BackendStatus|null, settleMs?:number}} o
 * @returns {{zeroSince:number|null, done:boolean}}
 */
function nextDoneState({ zeroSince, now, status, settleMs = DONE_SETTLE_MS }) {
    if (!status || status.inFlight > 0) return { zeroSince: null, done: false };
    const since = zeroSince == null ? now : zeroSince;
    return { zeroSince: since, done: now - since >= settleMs };
}

/**
 * 系統匣選「結束」時：直接結束，還是要先問。純函式。
 * @param {{phase:string, status:BackendStatus|null}} o
 * @returns {'quit'|'ask'}
 */
function decideTrayQuit({ phase, status }) {
    if (phase !== 'running') return 'quit';
    if (!status) return 'ask';
    return status.inFlight > 0 ? 'ask' : 'quit';
}

/**
 * 「結束」的對話框（dialog.showMessageBox 的參數）。純函式。
 * @param {{inFlight:number|null, leaseMs:number}} o
 */
function quitDialog({ inFlight, leaseMs }) {
    const known = Number.isInteger(inFlight) && inFlight > 0;
    const head = known ? `背景還有 ${inFlight} 件工作在處理` : '後端正忙，無法確認背景還有沒有工作在處理';
    return {
        type: 'question',
        title: '結束出題系統',
        message: `${head}（上傳考卷的拆題、檢查、變式生成等）。要怎麼結束？`,
        detail: [
            `「等處理完再結束」：不再開始新的工作，等手上${known ? `這 ${inFlight} 件` : '的工作'}做完就自動結束（最多 ${fmtDuration(WAIT_ALL_MS)}）。` +
                '拆題是整份卷算一件：正在拆的卷會拆到完（本機拆一份卷可能要 1 小時以上）；還在排隊的工作留到下次開啟再做。' +
                '等的時候出題系統留在右下角的系統匣，隨時可以從那裡改選「現在放棄」。',
            '',
            '「現在放棄」：馬上結束。放棄的工作不會記成失敗，也不會用掉重試次數。' +
                `${plan.UNFINISHED_WORK_NOTE}；要等租約到期才會重新接手（從現在算起最多${leaseText(leaseMs).replace(/^約/, '')}，馬上重開的話會先等一下）。` +
                '用 Gemini 時，重跑的部分會再計一次費用；本機模式只花時間。',
            '',
            '「取消」：不結束，繼續處理。'
        ].join('\n'),
        buttons: ['等處理完再結束', '現在放棄', '取消'],
        /** buttons 的索引 → 選擇 */
        choices: ['wait', 'abandon', 'cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
    };
}

/**
 * 第二次開啟（再點一次捷徑）時。純函式。
 * @param {{quitting:boolean}} o
 * @returns {'focus'|'notify-quitting'}
 */
function decideSecondInstance({ quitting }) {
    return quitting ? 'notify-quitting' : 'focus';
}

/**
 * 後端結束了（exit 事件）怎麼辦。純函式。
 * @param {{phase:string, quitting:boolean, expected:boolean, closeRequested:boolean, crashes:number[], now:number}} o
 * @returns {{action:'ignore'|'quit'|'restart'|'give-up', crashes:number[]}}
 */
function decideBackendExit({ phase, quitting, expected, closeRequested, crashes = [], now }) {
    // 我們叫它結束的、正在結束 app、或還在啟動（啟動流程自己會報錯）、已經失敗：都不另外處理
    if (expected || quitting || phase !== 'running') return { action: 'ignore', crashes };
    const recent = crashes.filter(t => now - t < CRASH_WINDOW_MS);
    const next = [...recent, now];
    if (closeRequested) return { action: 'quit', crashes: next };
    return { action: recent.length < MAX_AUTO_RESTARTS ? 'restart' : 'give-up', crashes: next };
}

// ─────────────────────────── 系統匣 ───────────────────────────

/**
 * 系統匣選單裡的狀態那一行。純函式。
 * @param {{phase:string, status:BackendStatus|null, quitting?:boolean, draining?:boolean}} o
 */
function statusLine({ phase, status, quitting = false, draining = false }) {
    if (quitting && draining) return status && status.inFlight > 0 ? `正在結束：等 ${status.inFlight} 件工作處理完` : '正在結束：等背景工作處理完';
    if (quitting) return '正在結束…';
    if (phase === 'starting') return '啟動中…';
    if (phase === 'failed') return '啟動失敗（原因見視窗）';
    if (!status) return '背景工作：無法確認（後端正忙）';
    if (status.jobsPaused) return '背景工作：暫停中（沒有啟動背景處理）';
    return status.inFlight > 0 ? `背景工作：${status.inFlight} 件處理中` : '背景工作：沒有';
}

/**
 * 系統匣的選單。純函式；main.js 依 id 接上動作。
 * @param {{phase:string, status:BackendStatus|null, quitting?:boolean, draining?:boolean}} o
 * @returns {Array<{id?:string, label?:string, enabled?:boolean, type?:'separator'}>}
 */
function trayMenuModel({ phase, status, quitting = false, draining = false }) {
    const items = [
        { id: 'open', label: '開啟出題系統', enabled: !quitting },
        { type: 'separator' },
        { id: 'status', label: statusLine({ phase, status, quitting, draining }), enabled: false },
        { type: 'separator' },
        { id: 'open-logs', label: '開啟記錄檔資料夾', enabled: true },
        { id: 'open-data', label: '開啟資料資料夾（附圖、考卷）', enabled: true },
        { id: 'open-backups', label: '開啟備份資料夾', enabled: true },
        { type: 'separator' }
    ];
    if (quitting && draining) items.push({ id: 'abandon', label: '現在放棄（不等了，馬上結束）', enabled: true });
    items.push({ id: 'quit', label: quitting ? '正在結束…' : '結束', enabled: !quitting });
    return items;
}

/** 系統匣圖示的提示文字（Windows 最多 127 個字元） */
function trayTooltip(o) {
    return `出題系統（桌面版）｜${statusLine(o)}`.slice(0, 127);
}

// ─────────────────────────── 通知 ───────────────────────────

/** @param {{reason:'busy'|'unknown', inFlight?:number}} d  decideWindowClose 的 hide 結果 */
function hideNotice(d) {
    const what = d.reason === 'busy' ? `還有 ${d.inFlight} 件工作在處理` : '後端正忙，無法確認還有沒有工作在處理';
    return {
        title: '出題系統仍在背景處理',
        body: `${what}，出題系統縮到右下角的系統匣繼續跑；全部處理完會再通知你，然後自動結束。要繼續用，點系統匣的出題系統圖示。`
    };
}

function doneNotice() {
    return {
        title: '背景工作都處理完了',
        body: '出題系統幾秒後自動結束（視窗先前已經關閉）。下次開啟就能看到結果。'
    };
}

/** 選了「等處理完再結束」之後 */
function drainingNotice(inFlight) {
    const what = Number.isInteger(inFlight) && inFlight > 0 ? `${inFlight} 件工作` : '手上的工作';
    return {
        title: '正在結束出題系統',
        body: `等 ${what}處理完就會自動結束（最多 ${fmtDuration(WAIT_ALL_MS)}）。要馬上結束，從右下角系統匣的出題系統圖示選「現在放棄」。`
    };
}

/** 等處理完之後，後端自己結束了 */
function drainedNotice() {
    return { title: '背景工作處理完了', body: '出題系統已經結束。' };
}

/** 結束中又點了一次捷徑 */
function quittingNotice(draining) {
    return draining
        ? { title: '出題系統正在結束', body: '正在等背景工作處理完，處理完就會自動結束；要馬上結束，從系統匣選「現在放棄」。結束之後再開一次就好。' }
        : { title: '出題系統正在結束', body: '請稍候幾秒再開啟。' };
}

/** 後端異常結束、自動重開 */
function crashRestartNotice(leaseMs) {
    return {
        title: '後端異常結束，正在重新啟動',
        body: `畫面會先回到啟動畫面。${plan.UNFINISHED_WORK_NOTE}（要等租約到期，${leaseText(leaseMs)}）。`
    };
}

/** 後端異常結束，而視窗先前已經關掉（在系統匣等處理完） */
function crashQuitNotice(logFile) {
    return {
        title: '出題系統的後端異常結束',
        body: `出題系統已經結束（視窗先前已經關閉）。${plan.UNFINISHED_WORK_NOTE}。記錄檔：${logFile}`
    };
}

module.exports = {
    SHORTCUT_NAME, AUMID,
    QUIT_GRACE_MS, KILL_AFTER_MS, WAIT_ALL_MS, STATUS_POLL_MS, STATUS_TIMEOUT_MS, DONE_SETTLE_MS, DONE_QUIT_DELAY_MS,
    CRASH_WINDOW_MS, MAX_AUTO_RESTARTS,
    fmtDuration, leaseText,
    decideWindowClose, nextDoneState, decideTrayQuit, quitDialog, decideSecondInstance, decideBackendExit,
    statusLine, trayMenuModel, trayTooltip,
    hideNotice, doneNotice, drainingNotice, drainedNotice, quittingNotice, crashRestartNotice, crashQuitNotice,
    UNFINISHED_WORK_NOTE: plan.UNFINISHED_WORK_NOTE
};
