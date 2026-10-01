// ─────────────────────────────────────────────────────────────
// desktop/lib/config.js — 後端子行程的環境變數（docs/desktop-app-design.md 第 2.3 節、第 3 條第 3、13 項）
//
// exam_pro/startServer.js **不讀 .env**：環境變數由這裡組好，當成 utilityProcess 的 env 傳過去。
//   1. 基底＝exam_pro\.env 的值，被系統環境變數蓋過——與 npm start（dotenv 預設不覆寫已存在的變數）看到的一模一樣
//      （沿用桌面啟動器 A 的 effectiveEnv）。B1 仍用 repo 的 .env（搬到 %APPDATA% 是 B2，DA-8）。
//   2. 執行期的值：
//      - PORT：桌面版開的空埠（不用 .env 的 PORT，和同時開著的網頁版不會搶同一個埠）；
//      - ALLOWED_ORIGINS：http://127.0.0.1:<埠>,http://localhost:<埠>。瀏覽器對同源的 POST 也會帶 Origin 標頭，
//        不在清單裡的話 cors() 丟錯、每個 POST 都變 500（第 3 條第 3 項）；
//      - JOB_RUNNER=off：只有「偵測到本機重錄正在跑、而且設定要暫停」時（DL-4，沿用 A 的 jobsWhileRecording）。
//   3. 拿掉 LAUNCHER_CONTROL_TOKEN：桌面版的主行程直接握著後端（utilityProcess 的訊息通道），不開 A 的 HTTP 關閉通道。
// 綁定位址不經環境變數：backend-entry.js 一律傳 host '127.0.0.1' 給 startServer（DA-11＝1）。
// 純函式。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { desktopPaths } = require('./paths');

const probes = require(path.join(desktopPaths().launcherLib, 'probes'));

/** workers/jobRunner.js 的 JOB_LEASE_MS 預設（租約到期才會被重新認領） */
const DEFAULT_LEASE_MS = 180000;

/**
 * 桌面版後端要放行的來源（視窗載入 http://127.0.0.1:<埠>/）。純函式。
 * @param {number} port
 */
function allowedOriginsFor(port) {
    return `http://127.0.0.1:${port},http://localhost:${port}`;
}

/**
 * 後端子行程的環境變數。純函式。
 * @param {object} o
 * @param {Record<string,string|undefined>} o.systemEnv   主行程自己的 process.env
 * @param {Record<string,string>} o.dotenvVars            exam_pro\.env 解析後的值
 * @param {number} o.port
 * @param {boolean} [o.jobsPaused]
 * @returns {Record<string,string>}
 */
function backendEnv({ systemEnv, dotenvVars, port, jobsPaused = false }) {
    const env = probes.effectiveEnv(dotenvVars || {}, systemEnv || {});
    delete env.LAUNCHER_CONTROL_TOKEN;
    // 主行程若是用 ELECTRON_RUN_AS_NODE 之類的方式被叫起來，這個變數不能帶給後端（它是一般的 Node 環境）
    delete env.ELECTRON_RUN_AS_NODE;
    env.PORT = String(port);
    env.ALLOWED_ORIGINS = allowedOriginsFor(port);
    if (jobsPaused) env.JOB_RUNNER = 'off';
    return env;
}

/**
 * 租約長度（毫秒）：與 workers/jobRunner.js 的 loadConfig 同一條讀法（整數，讀不懂用預設）。純函式。
 * @param {Record<string,string|undefined>} env
 */
function leaseMsOf(env) {
    const n = Number.parseInt(String((env && env.JOB_LEASE_MS) || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEASE_MS;
}

/**
 * 背景工作是不是整個關掉（.env 寫了 JOB_RUNNER=off 以外的值，startInlineRunner 就不啟動）。純函式。
 * @param {Record<string,string|undefined>} env
 */
function runnerDisabled(env) {
    return String((env && env.JOB_RUNNER) || 'inline').toLowerCase() !== 'inline';
}

module.exports = {
    DEFAULT_LEASE_MS, allowedOriginsFor, backendEnv, leaseMsOf, runnerDisabled,
    parseEnvText: probes.parseEnvText, effectiveEnv: probes.effectiveEnv, portFromEnv: probes.portFromEnv
};
