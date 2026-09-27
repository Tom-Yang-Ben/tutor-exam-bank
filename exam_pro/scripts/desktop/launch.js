// ─────────────────────────────────────────────────────────────
// scripts/desktop/launch.js — 桌面「出題系統」圖示執行的程式（docs/desktop-launcher.md）
//
// 捷徑：wscript.exe scripts\desktop\run_hidden.vbs launch <node.exe>（沒有黑色主控台視窗）。
// 也可以在命令提示字元直接跑：node scripts\desktop\launch.js（進度同時印在畫面上）。
//
// 依序：已在跑就直接開視窗 → 啟動畫面 → 基本檢查 → 錄製偵測 → Docker／資料庫 → Ollama（失敗只警告）
//       → migration（只提示、不升級）→ 背景啟動 node server.js（log 寫到 data\logs\server-日期.log）→ 轉到系統首頁。
// 決策在 lib/plan.js（純函式），每一步的 I/O 在 lib/actions.js，迴圈在 lib/launcher.js。
// 不改系統任何既有行為：npm start、npm run dev、CI、record_local.bat 照舊；後端就是同一支 server.js，
// 只多帶一個環境變數 LAUNCHER_CONTROL_TOKEN 給「關閉出題系統」用（services/launcherControl.js）。
// ─────────────────────────────────────────────────────────────
'use strict';

const { bootstrap, crash } = require('./lib/bootstrap');

/** 結束前讓啟動頁再拿一次狀態的緩衝 */
const CLOSE_DELAY_MS = 1500;

async function main() {
    const b = bootstrap('launch');
    const { sys, paths, log, config, configWarnings, env, port, appUrl, launcherLog, serverLog } = b;
    const { createUi } = require('./lib/ui');
    const { createProbes } = require('./lib/probes');
    const { createActions } = require('./lib/actions');
    const { runLaunch, acquireLock } = require('./lib/launcher');

    log(`==== 桌面啟動器開始（exam_pro：${paths.appDir}；埠 ${port}）====`);
    if (b.configFound) log(`設定檔：${paths.configFile}`);

    const statusHtml = sys.readText(paths.statusHtml) || '<!doctype html><meta charset="utf-8"><title>出題系統</title><p>啟動中…</p>';
    const ui = createUi({ sys, config, statusHtml, log, logs: { launcher: launcherLog, server: serverLog } });

    const lock = acquireLock(sys, paths.lockFile);
    if (!lock.acquired) {
        log(`另一個啟動器正在執行（${JSON.stringify(lock.other)}）`);
        if (lock.other && lock.other.statusUrl) await ui.openWindow(lock.other.statusUrl);
        else await ui.messageBox({ text: '出題系統正在啟動中，請稍候：啟動畫面會自己出現。', seconds: 8 });
        return 0;
    }

    try {
        const probes = createProbes({ sys, config, env, paths, port });
        const ctx = {
            port, appUrl, nodePath: process.execPath,
            dockerDesktopPath: config.dockerDesktopPath,
            dockerReadyTimeoutSec: config.dockerReadyTimeoutSec,
            ollamaReadyTimeoutSec: config.ollamaReadyTimeoutSec,
            serverReadyTimeoutSec: config.serverReadyTimeoutSec,
            serverLog, launcherLog
        };
        // 啟動畫面開好後把它的網址記進鎖檔：同時又點一次圖示時，第二個啟動器只把這個畫面再開一次
        const uiForActions = {
            ...ui,
            openStatusWindow: async () => {
                const r = await ui.openStatusWindow();
                if (r.url) lock.update({ statusUrl: r.url });
                return r;
            }
        };
        const actions = createActions({ sys, config, env, paths, ctx, ui: uiForActions, probes, log });
        const { action } = await runLaunch({ actions, ui, ctx, log, facts: configWarnings.length ? { configWarnings } : {} });
        log(`==== 桌面啟動器結束：${action.type}${action.code ? `（${action.code}）` : ''} ====`);
    } finally {
        lock.release();
        await sys.sleep(CLOSE_DELAY_MS);
        await ui.close();
    }
    return 0;
}

main().then(code => process.exit(code), err => crash('launch', err));
