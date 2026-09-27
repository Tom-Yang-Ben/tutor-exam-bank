// ─────────────────────────────────────────────────────────────
// desktop/lib/wording.js — 啟動畫面上的文字：沿用桌面啟動器 A，只改「怎麼重來」那幾句（docs/desktop-app-design.md 第 6.1 節）
//
// 設計稿要求 B1「沿用同一套檢查邏輯和錯誤訊息」，才不會出現兩份說法不一致的提示。所以：
//   - 檢查順序、錯誤與警告的內容都直接用 A 的 lib/plan.js（failureMessage、collectWarnings）；
//   - A 的文字是寫給「出題系統」「關閉出題系統」兩個捷徑的，桌面版只把那幾句換掉（REPLACEMENTS）：
//     再點一次捷徑 → 再開一次「出題系統（桌面版）」；「關閉出題系統」→ 系統匣的「結束」；「啟動器」→ 桌面版。
//     desktop/test/wording.test.js 把 A 的每一種失敗與警告都跑一遍，確認換完之後沒有留下 A 專用的說法
//     （A 改了文字、這裡沒跟上時會紅）。
//   - 後端怎麼開不一樣（utilityProcess，不是 node server.js），那三種失敗（開不了、立刻結束、太久沒回應）與
//     「後端一直異常結束」由這裡自己寫。
//   - 桌面版自己的警告：另一個後端正連著同一個資料庫（第 2.8 節、R-14）。
// 純函式。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { desktopPaths } = require('./paths');
const { SHORTCUT_NAME } = require('./decisions');

const plan = require(path.join(desktopPaths().launcherLib, 'plan'));

const REOPEN = `再開一次桌面的「${SHORTCUT_NAME}」`;

/** 依序替換（長的、特定的放前面） */
const REPLACEMENTS = Object.freeze([
    ['錄完後點「關閉出題系統」、再點「出題系統」', `錄完後從系統匣選「結束」，${REOPEN}`],
    ['請用「關閉出題系統」關掉後再開一次', `請從系統匣選「結束」，${REOPEN}`],
    ['先點「關閉出題系統」', '先從系統匣選「結束」'],
    ['再點一次桌面的「出題系統」圖示', REOPEN],
    ['再點一次圖示', REOPEN],
    ['「關閉出題系統」', '系統匣的「結束」'],
    ['之前由桌面圖示開的', '之前開的'],
    ['啟動器設定檔', '啟動設定檔（與桌面啟動器 A 共用）'],
    ['啟動器', '桌面版']
]);

/**
 * 把 A 的一段文字換成桌面版的說法。純函式。
 * 「桌面啟動器 A」這幾個字是上面刻意寫進去的，不再換。
 * @param {string} text
 */
function adaptText(text) {
    let s = String(text == null ? '' : text);
    for (const [from, to] of REPLACEMENTS) {
        if (from === '啟動器') {
            s = s.replace(/(?<!桌面)啟動器/g, to);
        } else {
            s = s.split(from).join(to);
        }
    }
    return s;
}

/** A 的警告 → 桌面版 */
function adaptWarning(w) {
    return { ...w, text: adaptText(w.text) };
}

/** 處理好之後怎麼重來（桌面版） */
const RETRY = `處理好之後，關掉這個視窗，${REOPEN}（已經啟動的部分不會重做）。`;

/** 由桌面版自己寫的失敗 */
const DESKTOP_FAILURES = new Set(['server-spawn-failed', 'server-exited', 'server-timeout', 'backend-crashed', 'internal']);

/**
 * 失敗訊息：A 的（換過說法）或桌面版自己的。純函式。
 * @param {{code:string, title?:string, message?:string, hint?:string[], detail?:string}} action  plan.fail() 的結果
 * @param {object} facts
 * @param {{serverLog?:string, launcherLog?:string, serverReadyTimeoutSec?:number}} ctx
 * @param {{crashCount?:number, exitCode?:number|null, logTail?:string}} [extra]  backend-crashed 用
 * @returns {{code:string, title:string, message:string, hint:string[], detail?:string}}
 */
function desktopFailure(action, facts = {}, ctx = {}, extra = {}) {
    const code = action.code;
    const serverLog = ctx.serverLog || 'exam_pro\\data\\logs\\desktop-server-日期.log';
    const mainLog = ctx.launcherLog || 'exam_pro\\data\\logs\\desktop-日期.log';
    const sw = facts.serverWait || {};
    const withDetail = (o, detail) => (detail ? { ...o, detail } : o);
    if (!DESKTOP_FAILURES.has(code)) {
        const out = {
            code,
            title: adaptText(action.title),
            message: adaptText(action.message),
            hint: (action.hint || []).map(adaptText)
        };
        return withDetail(out, action.detail);
    }
    switch (code) {
        case 'server-spawn-failed':
            return {
                code,
                title: '無法啟動後端',
                message: `開不了後端的子行程：${(facts.server && facts.server.error) || '原因不明'}`,
                hint: [
                    '確認 exam_pro 的程式完整（在 exam_pro 資料夾執行 npm ci 可以重裝相依套件）。',
                    `打開記錄檔：${serverLog}`,
                    RETRY
                ]
            };
        case 'server-exited':
            return withDetail({
                code,
                title: '後端啟動後立刻結束',
                message: `後端結束了（結束碼 ${sw.exitCode != null ? sw.exitCode : '不明'}）。原因通常寫在記錄檔的最後幾行（下方也有）。`,
                hint: [
                    `打開記錄檔：${serverLog}`,
                    '常見原因：exam_pro\\.env 設定矛盾（例如 LOCAL_EXTRACT_MODE 與 OCR_ENGINE）、DATABASE_URL 缺漏。照訊息改好 .env。',
                    RETRY
                ]
            }, sw.logTail);
        case 'server-timeout':
            return withDetail({
                code,
                title: '後端太久沒有回應',
                message: `後端已經開了，但 ${ctx.serverReadyTimeoutSec || 120} 秒內健康檢查（/api/health）沒有回應。這次開的後端已經結束，不會留在背景。`,
                hint: [
                    `打開記錄檔：${serverLog}`,
                    `電腦剛開機、很忙時可能只是比較慢：關掉這個視窗，等一分鐘${REOPEN}。`
                ]
            }, sw.logTail);
        case 'backend-crashed':
            return withDetail({
                code,
                title: '後端一直異常結束',
                message: `後端在 10 分鐘內異常結束了 ${extra.crashCount || 2} 次（最後一次結束碼 ${extra.exitCode != null ? extra.exitCode : '不明'}），已經不再自動重開。`,
                hint: [
                    `打開記錄檔：${serverLog}`,
                    `關掉這個視窗，${REOPEN}；還是一樣的話，把記錄檔交給維護的人。`,
                    `${plan.UNFINISHED_WORK_NOTE}。`
                ]
            }, extra.logTail);
        case 'internal':
        default:
            return withDetail({
                code,
                title: '桌面版發生未預期的錯誤',
                message: '桌面版本身出錯了（不是設定的問題）。已經啟動的部分維持原狀。',
                hint: [`把 ${mainLog} 交給維護的人。`, RETRY]
            }, action.detail);
    }
}

/**
 * 另一個後端正連著同一個資料庫的警告（第 2.8 節）。沒有就回 null。純函式。
 * @param {{connections:number|null, webRunning:boolean, webPort:number}|null|undefined} other
 * @returns {{code:string, text:string}|null}
 */
function otherBackendWarning(other) {
    if (!other) return null;
    const n = Number.isInteger(other.connections) ? other.connections : 0;
    if (!other.webRunning && n <= 0) return null;
    const who = other.webRunning
        ? `網頁版（npm start）或桌面啟動器 A 的後端正在 http://localhost:${other.webPort} 執行`
        : `資料庫裡有 ${n} 條來自這套系統的連線（網頁版、桌面啟動器 A 的後端，或正在跑的維護工具）`;
    return {
        code: 'other-backend',
        text: `${who}，和桌面版連著同一個資料庫。兩邊的背景工作會一起認領：資料不會壞（租約防止重複處理），` +
            '但同時處理的件數加倍、記憶體吃緊。建議只留一個：網頁版到它的命令提示字元視窗按 Ctrl+C；' +
            '桌面啟動器 A 開的後端用桌面的「關閉出題系統」。維護工具跑完就不會再出現這一條。'
    };
}

/**
 * 啟動畫面（A 的 status.html）改成桌面版的說法。純函式。
 * @param {string} html
 */
function adaptStatusHtml(html) {
    return adaptText(html).replace('<title>出題系統・啟動中</title>', `<title>${SHORTCUT_NAME}・啟動中</title>`);
}

module.exports = { REPLACEMENTS, RETRY, DESKTOP_FAILURES, adaptText, adaptWarning, desktopFailure, otherBackendWarning, adaptStatusHtml };
