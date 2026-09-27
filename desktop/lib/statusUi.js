// ─────────────────────────────────────────────────────────────
// desktop/lib/statusUi.js — 啟動畫面（沿用桌面啟動器 A 的 status.html 與 lib/statusServer.js；docs/desktop-launcher.md 7.2）
//
// A 的做法：一個只聽 127.0.0.1 隨機埠的小伺服器供應啟動頁（GET /）與目前狀態（GET /state），啟動頁每 0.7 秒讀一次；
// 完成且沒有注意事項 → 同一個視窗 location.replace 到系統首頁；有注意事項 → 按「我知道了，進入出題系統」；失敗 → 紅框。
// 桌面版照用：啟動頁改在 Electron 的視窗裡顯示（showUrl），文字換成桌面版的說法（lib/wording.js 的 adaptStatusHtml）。
// 介面與 A 的 lib/ui.js 相同（set、note、openStatusWindow、finish、fail），A 的 lib/actions.js 可以直接拿去用。
// ─────────────────────────────────────────────────────────────
'use strict';

/** 等啟動頁拿到最新狀態最多幾毫秒 */
const DELIVER_TIMEOUT_MS = 12_000;

/**
 * @param {object} deps
 * @param {(o:{html:string, getState:Function, onDelivered:Function}) => Promise<{url:string, close:Function}>} deps.startStatusServer
 * @param {string} deps.html                  啟動頁（已換成桌面版說法）
 * @param {(url:string) => Promise<void>} deps.showUrl   讓視窗載入這個網址
 * @param {{launcher?:string, server?:string}} [deps.logs]
 * @param {(line:string)=>void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 */
function createStatusUi({ startStatusServer, html, showUrl, logs = {}, log = () => { }, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    let state = null;
    let server = null;
    let deliveredVersion = -1;

    function reset() {
        state = { version: 0, phase: 'running', steps: [], warnings: [], failure: null, appUrl: null, note: '', logs };
        deliveredVersion = -1;
    }
    reset();

    function set(patch) {
        Object.assign(state, patch);
        state.version += 1;
    }

    function note(text) {
        set({ note: text });
    }

    function getState() {
        return JSON.parse(JSON.stringify(state));
    }

    /** 開啟動畫面：起本機的小伺服器（只起一次），視窗載入它 */
    async function openStatusWindow() {
        try {
            if (!server) {
                server = await startStatusServer({
                    html,
                    getState,
                    onDelivered: v => { deliveredVersion = Math.max(deliveredVersion, v); }
                });
            }
            await showUrl(server.url);
            log(`啟動畫面：${server.url}`);
            return { ok: true, via: 'electron', url: server.url };
        } catch (err) {
            log(`開不了啟動畫面：${(err && err.message) || err}`);
            return { ok: false, error: String((err && err.message) || err) };
        }
    }

    async function waitDelivered(timeoutMs = DELIVER_TIMEOUT_MS) {
        const target = state.version;
        const started = now();
        while (deliveredVersion < target && now() - started < timeoutMs) await sleep(200);
        return deliveredVersion >= target;
    }

    /** 啟動完成：啟動頁自己轉到系統首頁（有注意事項時等 Owner 按按鈕）；啟動頁沒回應就直接載入首頁 */
    async function finish(url, warnings) {
        set({ phase: 'done', appUrl: url, warnings, note: '' });
        if (server && await waitDelivered()) return { via: 'status-page' };
        await showUrl(url);
        return { via: 'direct' };
    }

    /** 啟動失敗：啟動頁顯示原因與處理方式 */
    async function fail(failure, warnings) {
        set({
            phase: 'failed',
            failure: { title: failure.title, message: failure.message, hint: failure.hint || [], ...(failure.detail ? { detail: failure.detail } : {}) },
            warnings,
            note: ''
        });
        if (!server) await openStatusWindow();
        await waitDelivered();
        return { via: 'status-page' };
    }

    async function close() {
        const s = server;
        server = null;
        if (s) await s.close();
    }

    return {
        /** 重新開始一輪（後端異常結束後重開）：清掉上一輪的狀態；下一次 openStatusWindow 時視窗回到啟動畫面 */
        reset,
        set, note, getState, openStatusWindow, waitDelivered, finish, fail, close,
        get statusUrl() { return server ? server.url : null; }
    };
}

module.exports = { createStatusUi, DELIVER_TIMEOUT_MS };
