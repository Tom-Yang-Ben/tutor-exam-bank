// ─────────────────────────────────────────────────────────────
// desktop/lib/paths.js — 桌面版用到的路徑（B1：從 repo 啟動，資料仍在 exam_pro 底下；docs/desktop-app-design.md 第 6.2 節）
//
// B1 刻意**不搬任何資料**：題庫附圖、考卷 PDF、備份、.env 都還在 exam_pro 底下（搬到 %LOCALAPPDATA%／%APPDATA% 是 B2）。
// 桌面版自己新增的只有兩類：
//   - 記錄檔：exam_pro\data\logs\desktop-日期.log（主行程）、desktop-server-日期.log（後端的輸出）。
//     和桌面啟動器 A 的 launcher-／server-日期.log 放在同一個資料夾，B2 一起搬（第 3 條第 34 項）。
//   - Chromium 的設定檔（快取、Cookie…）與 desktop-state.json（上次存檔的資料夾、視窗大小）：
//     Windows 放 %LOCALAPPDATA%\TutorExamBank\electron（DA-1＝2：會變動的資料放 Local，不放 Roaming）。
// 純函式（env 由呼叫端傳入）。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');

/** desktop/ 的絕對路徑 */
const DESKTOP_DIR = path.resolve(__dirname, '..');

/**
 * @param {object} [o]
 * @param {string} [o.desktopDir]
 * @param {string} [o.appDir]   exam_pro 的位置（預設是 desktop/ 旁邊的 exam_pro/）
 */
function desktopPaths({ desktopDir = DESKTOP_DIR, appDir } = {}) {
    const exam = appDir || path.join(path.dirname(desktopDir), 'exam_pro');
    const launcherDir = path.join(exam, 'scripts', 'desktop');
    const data = path.join(exam, 'data');
    return {
        desktopDir,
        repoDir: path.dirname(desktopDir),
        appDir: exam,
        /** 桌面啟動器 A 的程式（決策、檢查、啟動頁都沿用它的） */
        launcherDir,
        launcherLib: path.join(launcherDir, 'lib'),
        statusHtml: path.join(launcherDir, 'status.html'),
        icon: path.join(launcherDir, 'assets', 'tutor-exam-bank.ico'),
        backendEntry: path.join(desktopDir, 'backend-entry.js'),
        envFile: path.join(exam, '.env'),
        dataDir: data,
        logsDir: path.join(data, 'logs'),
        backupsDir: path.join(exam, 'backups')
    };
}

/**
 * Chromium 設定檔與 desktop-state.json 的資料夾。純函式。
 *   - TUTOR_DESKTOP_USER_DATA 有設就用它（測試、冒煙測試用暫存資料夾）；
 *   - Windows：%LOCALAPPDATA%\TutorExamBank\electron（路徑只有英數字，DA-1）；
 *   - 其他平台：null＝用 Electron 的預設（只有開發與雲端測試會走到）。
 * @param {Record<string,string|undefined>} env
 * @param {string} platform
 * @returns {string|null}
 */
function userDataDir(env, platform) {
    const override = String((env && env.TUTOR_DESKTOP_USER_DATA) || '').trim();
    if (override) return override;
    if (platform !== 'win32') return null;
    const w = path.win32;
    const local = String((env && (env.LOCALAPPDATA || env.LocalAppData)) || '').trim()
        || w.join(String((env && env.USERPROFILE) || 'C:\\Users\\Default'), 'AppData', 'Local');
    return w.join(local, 'TutorExamBank', 'electron');
}

module.exports = { DESKTOP_DIR, desktopPaths, userDataDir };
