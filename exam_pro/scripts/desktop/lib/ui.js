// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/ui.js — Owner 看得到的部分：app 視窗、啟動畫面、系統訊息框（docs/desktop-launcher.md 第 7.2 節）
//
//   openWindow(url)     Edge 的 app 模式（--app＋獨立的 --user-data-dir）→ Chrome 的 app 模式 → 預設瀏覽器
//   openStatusWindow()  先起 lib/statusServer.js，再用 openWindow 開啟動頁；之後 set()／note() 更新畫面
//   finish／fail        告訴啟動頁結果，確認它收到了；啟動頁沒開成（或已被關掉）就改開 app 視窗／跳系統訊息框
//   messageBox          WScript.Shell.Popup（PowerShell -EncodedCommand；Windows 以外只寫 log）
// I/O 全部經注入的 sys。
//
// 〔審查 dec/desktop-launcher 第 1 件〕這裡開的都是「要讓 Owner 看到的視窗」，所以一律 hide:false（lib/system.js 檔頭）：
//   - Edge／Chrome（spawnDetached）與 rundll32（預設瀏覽器，它把自己的顯示狀態原樣交給 ShellExecute）；
//   - 訊息框的 PowerShell：訊息框是 PowerShell 這個程序的第一個視窗，同樣照 STARTUPINFO 決定顯示狀態。
//     hide:false 也不會多一個黑色視窗：exec 不是 detached，PowerShell 沿用啟動器自己的主控台
//     （捷徑經 run_hidden.vbs 開的 node，主控台本來就是隱藏的；在命令提示字元執行時就是那個視窗）。
// ─────────────────────────────────────────────────────────────
const w = require('./windows');
const { startStatusServer } = require('./statusServer');

/** 等啟動頁拿到最新狀態最多幾毫秒（它每 0.7 秒問一次；剛開的 Edge 第一次載入可能要幾秒） */
const DELIVER_TIMEOUT_MS = 12_000;

/**
 * 失敗訊息 → 訊息框的文字。純函式。
 * @param {{title:string, message:string, hint?:string[], detail?:string}} failure
 * @param {Array<{text:string}>} [warnings]
 */
function failureText(failure, warnings = []) {
    const parts = [failure.title, '', failure.message];
    if (failure.hint && failure.hint.length) parts.push('', '處理方式：', ...failure.hint.map(h => `・${h}`));
    if (failure.detail) {
        const d = String(failure.detail);
        parts.push('', '詳細訊息：', d.length > 800 ? `…${d.slice(-800)}` : d);
    }
    if (warnings.length) parts.push('', '另外：', ...warnings.map(x => `・${x.text}`));
    return parts.join('\n');
}

/** 警告 → 訊息框的文字。純函式。 */
function warningsText(warnings) {
    return ['出題系統已經開啟，但有以下注意事項：', '', ...warnings.map(x => `・${x.text}`)].join('\n');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./system').createSystem>} deps.sys
 * @param {object} deps.config
 * @param {string} deps.statusHtml
 * @param {(line:string)=>void} [deps.log]
 * @param {{launcher?:string, server?:string}} [deps.logs]  顯示在啟動頁底部的 log 位置
 * @param {typeof startStatusServer} [deps.startServer]   測試注入
 */
function createUi({ sys, config, statusHtml, log = () => { }, logs = {}, startServer = startStatusServer }) {
    const state = {
        version: 0, phase: 'running', steps: [], warnings: [], failure: null, appUrl: null, note: '', logs
    };
    let server = null;
    let statusOpened = false;
    let deliveredVersion = -1;

    function set(patch) {
        Object.assign(state, patch);
        state.version += 1;
    }

    /** 目前那一步的補充說明（等待時的秒數） */
    function note(text) {
        set({ note: text });
    }

    function getState() {
        return JSON.parse(JSON.stringify(state));
    }

    /**
     * 依設定的順序開視窗。
     * @param {string} url
     * @returns {Promise<{ok:boolean, via?:string, path?:string, error?:string}>}
     */
    async function openWindow(url) {
        const errors = [];
        for (const kind of w.browserOrder(config.browser)) {
            if (kind === 'default') {
                const r = sys.platform === 'win32'
                    ? await sys.exec('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeoutMs: 20_000, hide: false })
                    : await sys.exec(sys.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeoutMs: 20_000, hide: false });
                if (r.code === 0) return { ok: true, via: 'default' };
                errors.push(`預設瀏覽器：${r.errorCode || `結束碼 ${r.code}`}`);
                continue;
            }
            const custom = config.browserPath && config.browser === kind ? [config.browserPath] : [];
            const exe = [...custom, ...w.browserCandidates(kind, sys.env)].find(p => sys.exists(p));
            if (!exe) continue;
            const args = w.appWindowArgs({ url, profileDir: w.browserProfileDir(kind, config, sys.env), extra: config.browserArgs });
            const r = await sys.spawnDetached(exe, args, { hide: false });
            if (r.ok) return { ok: true, via: kind, path: exe };
            errors.push(`${kind}：${r.error}`);
        }
        return { ok: false, error: errors.join('；') || '找不到可以用的瀏覽器' };
    }

    async function openStatusWindow() {
        try {
            server = await startServer({
                html: statusHtml,
                getState,
                onDelivered: v => { deliveredVersion = Math.max(deliveredVersion, v); }
            });
        } catch (err) {
            return { ok: false, error: `啟動畫面的本機伺服器開不起來：${err.message}` };
        }
        const r = await openWindow(server.url);
        statusOpened = r.ok;
        log(r.ok ? `啟動畫面：${server.url}（${r.via}）` : `開不了啟動畫面：${r.error}`);
        return { ...r, url: server.url };
    }

    /** 啟動頁拿到目前（最新）狀態了沒；最多等 timeoutMs */
    async function waitDelivered(timeoutMs = DELIVER_TIMEOUT_MS) {
        const target = state.version;
        const started = sys.now();
        while (deliveredVersion < target && sys.now() - started < timeoutMs) await sys.sleep(200);
        return deliveredVersion >= target;
    }

    /**
     * @param {{text:string, title?:string, buttons?:number, icon?:number, seconds?:number}} o
     * @returns {Promise<'ok'|'cancel'|'yes'|'no'|'timeout'|null>}
     */
    async function messageBox({ text, title = '出題系統', buttons = w.POPUP.OK, icon = w.POPUP.ICON_INFO, seconds = 0 }) {
        log(`[訊息框] ${title}：${text.replace(/\n+/g, ' ／ ')}`);
        if (sys.platform !== 'win32') return null;
        const r = await sys.exec('powershell.exe', w.powershellArgs(w.popupScript({ text, title, buttons, icon, seconds })), {
            timeoutMs: seconds > 0 ? (seconds + 60) * 1000 : 24 * 3600 * 1000,
            hide: false   // 訊息框要看得到（檔頭）
        });
        return w.parsePopupResult(r.stdout);
    }

    /** 已經在跑：直接開 app 視窗 */
    async function openApp(url) {
        const r = await openWindow(url);
        log(r.ok ? `開啟 app 視窗（${r.via}）` : `開不了 app 視窗：${r.error}`);
        if (!r.ok) {
            await messageBox({ text: `出題系統已經在執行，但開不了瀏覽器視窗（${r.error}）。\n請自己用瀏覽器打開：${url}`, icon: w.POPUP.ICON_WARNING });
        }
        return r;
    }

    /** 啟動完成 */
    async function finish(url, warnings) {
        set({ phase: 'done', appUrl: url, warnings, note: '' });
        if (statusOpened && await waitDelivered()) {
            log(warnings.length ? '啟動畫面顯示注意事項，等 Owner 按「進入出題系統」。' : '啟動畫面自動轉到系統首頁。');
            return { via: 'status-page' };
        }
        const r = await openWindow(url);
        log(r.ok ? `啟動畫面沒有回應，直接開 app 視窗（${r.via}）` : `開不了 app 視窗：${r.error}`);
        if (!r.ok) {
            const extra = warnings.length ? `\n\n${warningsText(warnings)}` : '';
            await messageBox({ text: `出題系統已經啟動，但開不了瀏覽器視窗（${r.error}）。\n請自己用瀏覽器打開：${url}${extra}`, icon: w.POPUP.ICON_WARNING });
            return { via: 'none' };
        }
        if (warnings.length) await messageBox({ text: warningsText(warnings), icon: w.POPUP.ICON_WARNING });
        return { via: r.via };
    }

    /** 啟動失敗 */
    async function fail(failure, warnings) {
        set({
            phase: 'failed',
            failure: { title: failure.title, message: failure.message, hint: failure.hint || [], ...(failure.detail ? { detail: failure.detail } : {}) },
            warnings,
            note: ''
        });
        if (statusOpened && await waitDelivered()) return { via: 'status-page' };
        await messageBox({ text: failureText(failure, warnings), title: '出題系統無法啟動', icon: w.POPUP.ICON_ERROR });
        return { via: 'message-box' };
    }

    async function close() {
        if (server) await server.close();
        server = null;
    }

    return {
        set, note, getState, openWindow, openStatusWindow, waitDelivered, messageBox, openApp, finish, fail, close,
        get statusUrl() { return server ? server.url : null; }
    };
}

module.exports = { createUi, failureText, warningsText, DELIVER_TIMEOUT_MS };
