// ─────────────────────────────────────────────────────────────
// desktop/lib/ui.js — 視窗本身的小事：記住大小與位置、選單、右鍵選單、桌面捷徑（純函式）
//
//   desktop-state.json（Chromium 設定檔旁邊，lib/paths.js 的 userDataDir）只記兩件事：
//     lastDownloadDir：上次存 Word 的資料夾（lib/downloads.js）；windowBounds：視窗的位置、大小、是否最大化。
//   選單：檢視（重新整理、縮放、全螢幕、開發人員工具）與編輯（複製貼上）；選單列預設隱藏（按 Alt 出現），快速鍵照常可用。
//   右鍵選單：輸入框裡可以剪下、複製、貼上、全選；選到文字時可以複製（Electron 預設沒有右鍵選單）。
//   桌面捷徑：「出題系統（桌面版）」→ repo 裡的 desktop\node_modules\electron\dist\electron.exe "<desktop 資料夾>"
//     （DA-6＝1：從 repo 啟動，U1）。帶 AppUserModelID，工作列分組與釘選都對得上；和 A 的「出題系統」捷徑並存。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { SHORTCUT_NAME, AUMID } = require('./decisions');

const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 860 });
const MIN_VISIBLE = 120;

/**
 * 讀 desktop-state.json（沒有或壞掉 → {}）。
 * @param {string} file
 * @param {{readFileSync:Function}} [fsImpl]
 */
function readState(file, fsImpl = require('fs')) {
    try {
        const j = JSON.parse(String(fsImpl.readFileSync(file, 'utf8')).replace(/^﻿/, ''));
        return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch (_) {
        return {};
    }
}

/**
 * 寫 desktop-state.json（先寫暫存檔再改名；寫不進去不擋任何事）。
 * @param {string} file
 * @param {object} state
 * @param {typeof import('fs')} [fsImpl]
 */
function writeState(file, state, fsImpl = require('fs')) {
    try {
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fsImpl.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fsImpl.renameSync(tmp, file);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * 記住的視窗位置還能用嗎（至少有一塊 MIN_VISIBLE×MIN_VISIBLE 落在某個螢幕的工作區裡）。
 * 能用回 {x,y,width,height}；不能用（螢幕拔掉了、解析度變了）回 null＝用預設大小置中。純函式。
 * @param {{x?:number,y?:number,width?:number,height?:number}|null|undefined} b
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas
 */
function usableBounds(b, workAreas) {
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    if (b.width < 400 || b.height < 300) return null;
    const ok = (workAreas || []).some(a => {
        const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
        const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
        return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
    });
    return ok ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
}

/** 應用程式選單（Menu.buildFromTemplate）。純函式。 */
function appMenuTemplate() {
    return [
        {
            label: '編輯',
            submenu: [
                { role: 'undo', label: '復原' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪下' },
                { role: 'copy', label: '複製' },
                { role: 'paste', label: '貼上' },
                { role: 'selectAll', label: '全選' }
            ]
        },
        {
            label: '檢視',
            submenu: [
                { role: 'reload', label: '重新整理' },
                { type: 'separator' },
                { role: 'resetZoom', label: '實際大小' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '縮小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全螢幕' },
                { type: 'separator' },
                { role: 'toggleDevTools', label: '開發人員工具' }
            ]
        }
    ];
}

/**
 * 右鍵選單（webContents 的 context-menu 事件的 params → 選單項目）；不需要選單時回 null。純函式。
 * @param {{isEditable?:boolean, selectionText?:string, editFlags?:{canCut?:boolean, canCopy?:boolean, canPaste?:boolean, canSelectAll?:boolean}}} params
 */
function contextMenuTemplate(params) {
    const f = (params && params.editFlags) || {};
    if (params && params.isEditable) {
        return [
            { role: 'cut', label: '剪下', enabled: Boolean(f.canCut) },
            { role: 'copy', label: '複製', enabled: Boolean(f.canCopy) },
            { role: 'paste', label: '貼上', enabled: Boolean(f.canPaste) },
            { type: 'separator' },
            { role: 'selectAll', label: '全選', enabled: f.canSelectAll !== false }
        ];
    }
    if (params && String(params.selectionText || '').trim()) {
        return [{ role: 'copy', label: '複製', enabled: f.canCopy !== false }];
    }
    return null;
}

/**
 * 桌面捷徑（shell.writeShortcutLink 的參數）。純函式；路徑一律用 Windows 的寫法。
 * @param {{desktopFolder:string, electronExe:string, desktopDir:string, icon:string}} o
 */
function shortcutSpec({ desktopFolder, electronExe, desktopDir, icon }) {
    const w = path.win32;
    return {
        file: w.join(desktopFolder, `${SHORTCUT_NAME}.lnk`),
        options: {
            target: electronExe,
            args: `"${desktopDir}"`,
            cwd: desktopDir,
            description: '開啟家教出題系統（桌面版：一個視窗；資料庫仍用 Docker）',
            icon,
            iconIndex: 0,
            appUserModelId: AUMID
        }
    };
}

module.exports = { DEFAULT_BOUNDS, readState, writeState, usableBounds, appMenuTemplate, contextMenuTemplate, shortcutSpec };
