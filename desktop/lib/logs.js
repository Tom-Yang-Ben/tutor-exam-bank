// ─────────────────────────────────────────────────────────────
// desktop/lib/logs.js — 桌面版的記錄檔（docs/desktop-app-design.md 第 2.8 節「日誌」）
//
// 桌面版沒有伺服器視窗，後端印的字（以前在 npm start 視窗裡看到的）改寫進檔案：
//   exam_pro\data\logs\desktop-日期.log         主行程：每一步、每個判斷、關閉與系統匣的動作
//   exam_pro\data\logs\desktop-server-日期.log  後端（utilityProcess）的 stdout／stderr
// 檔名的日期是那次開啟的日期（與桌面啟動器 A 相同：之後不換檔）。只保留 14 天：每次開啟時刪掉更舊的 desktop-*.log
// （只刪桌面版自己的檔，A 的 launcher-／server-日期.log 不動）。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');

/** 保留幾天（第 2.8 節） */
const KEEP_DAYS = 14;
const LOG_NAME = /^desktop(?:-server)?-(\d{4})-(\d{2})-(\d{2})\.log$/;

const pad = n => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（與 A 的 windows.dateStamp 相同） */
function dateStamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地時間 YYYY-MM-DD HH:mm:ss */
function timeStamp(d = new Date()) {
    return `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @param {string} logsDir
 * @param {Date} [d]
 */
function logFiles(logsDir, d = new Date()) {
    const stamp = dateStamp(d);
    return {
        main: path.join(logsDir, `desktop-${stamp}.log`),
        server: path.join(logsDir, `desktop-server-${stamp}.log`)
    };
}

/**
 * 要刪掉的舊記錄檔（檔名的日期比 now 早超過 keepDays 天）。純函式。
 * @param {string[]} names  資料夾裡的檔名
 * @param {Date} now
 * @param {number} [keepDays]
 * @returns {string[]}
 */
function logsToPrune(names, now, keepDays = KEEP_DAYS) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const limit = today - keepDays * 24 * 3600 * 1000;
    return (names || []).filter(name => {
        const m = LOG_NAME.exec(name);
        if (!m) return false;
        const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
        return Number.isFinite(t) && t < limit;
    });
}

/**
 * 寫一行一行的記錄檔。寫不進去不擋任何事（記錄檔不是必要的）。
 * @param {{file:string, fs?:typeof import('fs'), now?:()=>Date, echo?:boolean, pid?:number}} o
 * @returns {(line:string)=>void}
 */
function createLogger({ file, fs = require('fs'), now = () => new Date(), echo = false, pid = process.pid }) {
    let dirReady = false;
    return line => {
        const text = `${timeStamp(now())} [desktop ${pid}] ${line}\n`;
        try {
            if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirReady = true; }
            fs.appendFileSync(file, text, 'utf8');
        } catch (_) { /* 忽略 */ }
        if (echo) process.stdout.write(text);
    };
}

/**
 * 刪掉舊記錄檔；回傳刪了哪些。
 * @param {string} logsDir
 * @param {{fs?:typeof import('fs'), now?:Date, keepDays?:number}} [o]
 */
function pruneLogs(logsDir, { fs = require('fs'), now = new Date(), keepDays = KEEP_DAYS } = {}) {
    let names = [];
    try { names = fs.readdirSync(logsDir); } catch (_) { return []; }
    const removed = [];
    for (const name of logsToPrune(names, now, keepDays)) {
        try { fs.rmSync(path.join(logsDir, name), { force: true }); removed.push(name); } catch (_) { /* 忽略 */ }
    }
    return removed;
}

module.exports = { KEEP_DAYS, dateStamp, timeStamp, logFiles, logsToPrune, createLogger, pruneLogs };
