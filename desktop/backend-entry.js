// ─────────────────────────────────────────────────────────────
// desktop/backend-entry.js — 後端子行程（Electron utilityProcess）的進入點（DA-3＝2；docs/desktop-app-design.md 第 2.1、2.3 節）
//
// 主行程（main.js → lib/backendHost.js）用 utilityProcess.fork 開這支，環境變數已經組好（lib/config.js 的 backendEnv：
// exam_pro\.env ＋ 系統環境 ＋ PORT、ALLOWED_ORIGINS），工作目錄是 exam_pro。這裡：
//   1. 呼叫 exam_pro/startServer.js 的 startServer({ port: PORT, host: '127.0.0.1' })（只綁本機，DA-11＝1）；
//   2. 聽到埠就回報 ready（lib/backendProtocol.js），之後回答狀態、照主行程的要求優雅關閉；
//   3. 聽不了埠：印出與 npm start 相同的說明（utils/listenFailure.js）並以結束碼 1 結束；
//      其他啟動錯誤（.env 設定矛盾、缺 DATABASE_URL…）印出錯誤並以結束碼 1 結束。
// 主行程把 stdout／stderr 寫進 exam_pro\data\logs\desktop-server-日期.log。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { attachBackendAgent, readyMessage } = require('./lib/backendProtocol');

const APP_DIR = path.resolve(__dirname, '..', 'exam_pro');
const HOST = '127.0.0.1';

async function main() {
    const parentPort = process.parentPort;
    const port = Number.parseInt(String(process.env.PORT || ''), 10) || 0;
    const { exitAfterFlush, listenFailureText } = require(path.join(APP_DIR, 'utils', 'listenFailure'));
    let handle;
    try {
        handle = await require(path.join(APP_DIR, 'startServer')).startServer({ port, host: HOST });
    } catch (err) {
        const text = err && err.syscall === 'listen'
            ? listenFailureText(err, port)
            : `✖ 後端無法啟動：${(err && err.stack) || err}`;
        exitAfterFlush(text, 1);
        return;
    }
    console.log(`🚀 家教題庫後端（桌面版）已啟動：${handle.url}（只聽本機）${handle.runner ? '' : '；背景工作沒有啟動（JOB_RUNNER 不是 inline）'}`);
    if (!parentPort) {
        // 不是由 Electron 開的（例如有人直接 node backend-entry.js）：照樣服務，只是沒有主行程可以回報
        console.log('（沒有 Electron 主行程：不回報狀態，按 Ctrl+C 結束）');
        return;
    }
    const { DEFAULT_GRACE_MS, MAX_GRACE_MS } = require(path.join(APP_DIR, 'services', 'launcherControl'));
    attachBackendAgent({ parentPort, handle, defaultGraceMs: DEFAULT_GRACE_MS, maxGraceMs: MAX_GRACE_MS, log: line => console.log(line) });
    parentPort.postMessage(readyMessage(handle));
}

main().catch(err => {
    process.stderr.write(`✖ 後端發生未預期的錯誤：${(err && err.stack) || err}\n`);
    process.exit(1);
});
