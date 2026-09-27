// ─────────────────────────────────────────────────────────────
// startServer.js — 可以被呼叫的後端（桌面版 B1，docs/desktop-app-design.md 第 2.3 節）
//
// 桌面版（repo 最上層的 desktop/）用 Electron 的 utilityProcess 開一個子行程，在裡面呼叫這裡的 startServer()
// （desktop/backend-entry.js）。它和 server.js 用的是同一個 app.js、同一個 jobRunner、同一份「優雅關閉」的狀態機
// （services/launcherControl.js 的 createLifecycle），只差在：
//   1. **不讀 .env**：環境變數由呼叫的人事先放好（config/db.js、routes/index.js 都在 require 的當下讀 process.env）。
//      桌面版的主行程讀 exam_pro/.env、疊上執行期的值（PORT、ALLOWED_ORIGINS…）後當成子行程的 env。
//   2. **綁定位址由呼叫的人指定，預設 127.0.0.1**（DA-11＝1：桌面版只綁本機）。
//   3. **聽到埠之後才啟動 jobRunner**：聽不了埠時直接回報錯誤（reject，err.code＝EADDRINUSE／EACCES…），
//      不會留下沒有網頁、卻在背景認領工作的行程。
//   4. 關閉交給同一份 createLifecycle：停止認領 → server.close() → 等在途工作到時限 → 在途歸零才關連線池 → 結束；
//      時限到了還有在途工作就不關連線池、直接結束（與當機同一條路：不寫結果、不動重試次數，租約到期後重新認領）。
//
// server.js（npm start、npm run dev、桌面啟動器 A）**沒有改**，行為逐位元不變。沒有把 server.js 改成呼叫這裡，
// 是為了不和同時進行中的 DA-11（網頁版改用 HOST 設定）的分支改同一支檔；兩邊之後要合成一份時，
// 讓 server.js 的 require.main 分支呼叫 startServer({ port: PORT, host: HOST }) 即可。
// ─────────────────────────────────────────────────────────────
'use strict';

/** 桌面版只綁本機（DA-11＝1） */
const DEFAULT_HOST = '127.0.0.1';

/**
 * app.listen 包成 Promise。Express 5 把 listen 的錯誤交給 callback（不會丟出來），這裡轉成 reject。
 * @param {import('express').Express} app
 * @param {number} port
 * @param {string} host
 * @returns {Promise<import('http').Server>}
 */
function listen(app, port, host) {
    return new Promise((resolve, reject) => {
        let server = null;
        server = app.listen(port, host, err => {
            if (err) { reject(err); return; }
            resolve(server);
        });
    });
}

/**
 * 網址裡的主機名：綁在所有介面時用 127.0.0.1 連（呼叫的人拿這個網址開視窗、做健康檢查）。純函式。
 * @param {string} host
 */
function urlHost(host) {
    if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1';
    return host.includes(':') ? `[${host}]` : host;
}

/**
 * 啟動後端。
 * @param {object} [opts]
 * @param {number} [opts.port]   0＝由系統挑一個空的埠（預設）
 * @param {string} [opts.host]   預設 127.0.0.1
 * @param {() => ({stop:Function, inFlight:number}|null)} [opts.startRunner]
 *        預設 workers/jobRunner.js 的 startInlineRunner（JOB_RUNNER=off 時回 null）；測試注入假的
 * @param {(code:number) => void} [opts.exit]  關閉流程最後一步（預設 process.exit）；測試注入
 * @param {{info:Function, warn:Function, error:Function}} [opts.logger]
 * @param {() => Promise<void>} [opts.closePool]  預設關 config/db.js 的連線池；測試注入
 * @returns {Promise<{url:string, port:number, host:string, server:import('http').Server,
 *   runner:object|null, status:() => {pid:number, in_flight:number, shutting_down:boolean},
 *   close:(o?:{graceMs?:number}) => Promise<{left:number}>}>}
 */
async function startServer({ port = 0, host = DEFAULT_HOST, startRunner, exit, logger, closePool } = {}) {
    const app = require('./app');
    const server = await listen(app, port, host);
    const actualPort = server.address().port;

    const runner = (startRunner || require('./workers/jobRunner').startInlineRunner)() || null;
    const { createLifecycle } = require('./services/launcherControl');
    const lifecycle = createLifecycle({
        ...(exit ? { exit } : {}),
        ...(logger ? { logger } : {}),
        ...(closePool ? { closePool } : {})
    });
    lifecycle.attach({ server, runner });

    return {
        url: `http://${urlHost(host)}:${actualPort}`,
        port: actualPort,
        host,
        server,
        runner,
        status: () => lifecycle.status(),
        /**
         * 優雅關閉（冪等：第二次呼叫回同一個 promise，graceMs 以第一次為準）。
         * graceMs：最多等在途工作幾毫秒；0＝不等（在途的工作停在原狀態，租約到期後重新認領）。
         */
        close: ({ graceMs } = {}) => lifecycle.shutdown(graceMs === undefined ? {} : { graceMs })
    };
}

module.exports = { startServer, urlHost, DEFAULT_HOST };
