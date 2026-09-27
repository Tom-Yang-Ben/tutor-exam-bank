// ─────────────────────────────────────────────────────────────
// desktop/lib/security.js — 視窗能去哪裡、能要什麼權限（docs/desktop-app-design.md 第 2.4 節、第 3 條第 6 項）
//
// 視窗載入的是本機迴路的 http（http://127.0.0.1:<後端埠>/，就是現在那一套 public/），不用自訂協定；
// 風險用三件事收小：
//   1. 後端只綁 127.0.0.1（startServer 的 host，DA-11＝1）。
//   2. 導覽只允許自己的來源（後端與啟動畫面）；開新視窗一律拒絕，外部 http(s) 網址交給預設瀏覽器。
//      現在的前端沒有任何外部連結，這一條是防呆。
//   3. 權限：Electron 預設**自動核准所有權限請求**，所以這裡只放行「自己的來源 ＋ media ＋ 只要聲音」
//      （家教的「按住說話」麥克風，public/js/tutor.js 的 getUserMedia({ audio: true })），其他一律拒絕。
//      前端沒有用到剪貼簿、通知、定位等其他需要權限的 API（B1 開工時查過 public/）。
//   4. 執行期零外連：Chromium 預設會從 Google 的 CDN 下載拼字字典，改指到本機迴路（SPELLCHECK_DICTIONARY_URL）。
// 純函式。
// ─────────────────────────────────────────────────────────────
'use strict';

/**
 * 拼字字典的下載網址（session.setSpellCheckerDictionaryDownloadURL）。
 * 執行期零外連（docs/local-mode.md 第 1 條；docs/desktop-app-design.md 1.1 第 2 點）：Chromium 預設會從 Google 的 CDN
 * （redirector.gvt1.com）下載 hunspell 拼字字典——就算視窗設了 spellcheck:false、session 也關了拼字檢查，照樣會連
 * （2026-09-27 在 Linux 實測；desktop/test/smoke 的外連陷阱抓得到）。改指到本機迴路上沒有人聽的 discard 埠（9），
 * 下載在本機就失敗，不會連出去。前端不需要拼字檢查（題目與公式本來就不適合）。
 */
const SPELLCHECK_DICTIONARY_URL = 'http://127.0.0.1:9/';

/**
 * 網址的來源（scheme://host:port）；不是合法網址或沒有來源（blob:、data:、about:）回 null。純函式。
 * @param {string} url
 * @returns {string|null}
 */
function originOf(url) {
    try {
        const u = new URL(String(url));
        return u.origin && u.origin !== 'null' ? u.origin : null;
    } catch (_) {
        return null;
    }
}

/** 本機迴路的主機名 */
function isLoopbackHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 視窗要導覽到 url 時怎麼辦。純函式。
 *   allow：自己的來源（後端、啟動畫面）
 *   external：外部的 http(s) 網址 → 交給預設瀏覽器
 *   deny：其他（file:、javascript:、本機其他埠、自訂協定…）
 * @param {string} url
 * @param {string[]} allowedOrigins
 * @returns {'allow'|'external'|'deny'}
 */
function navigationDecision(url, allowedOrigins) {
    const origin = originOf(url);
    if (origin && (allowedOrigins || []).includes(origin)) return 'allow';
    let u;
    try { u = new URL(String(url)); } catch (_) { return 'deny'; }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !isLoopbackHost(u.hostname)) return 'external';
    return 'deny';
}

/**
 * 前端要開新視窗（window.open、target=_blank）時怎麼辦：一律不開 Electron 視窗；外部網址交給預設瀏覽器。純函式。
 * @param {string} url
 * @returns {'external'|'deny'}
 */
function windowOpenDecision(url) {
    return navigationDecision(url, []) === 'external' ? 'external' : 'deny';
}

/**
 * setPermissionRequestHandler 的判斷。純函式。
 * @param {object} o
 * @param {string} o.permission
 * @param {string|null} o.appOrigin     後端的來源（http://127.0.0.1:<埠>）
 * @param {string} [o.requestingUrl]    details.requestingUrl
 * @param {string} [o.securityOrigin]   details.securityOrigin（media 才有）
 * @param {string[]} [o.mediaTypes]     details.mediaTypes（media 才有：'audio'／'video'）
 * @returns {boolean}
 */
function permissionRequestDecision({ permission, appOrigin, requestingUrl, securityOrigin, mediaTypes }) {
    if (permission !== 'media' || !appOrigin) return false;
    const origin = securityOrigin ? originOf(securityOrigin) || securityOrigin.replace(/\/$/, '') : originOf(requestingUrl);
    if (origin !== appOrigin) return false;
    // 至少要一種、而且只能是聲音（不給攝影機）
    return Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every(t => t === 'audio');
}

/**
 * setPermissionCheckHandler 的判斷（多數 Web API 先 check、被拒才 request）。純函式。
 * @param {object} o
 * @param {string} o.permission
 * @param {string|null} o.appOrigin
 * @param {string} [o.requestingOrigin]
 * @param {string} [o.securityOrigin]
 * @param {string} [o.mediaType]        'audio'／'video'／'unknown'
 * @returns {boolean}
 */
function permissionCheckDecision({ permission, appOrigin, requestingOrigin, securityOrigin, mediaType }) {
    if (permission !== 'media' || !appOrigin) return false;
    const origin = originOf(securityOrigin || requestingOrigin) || String(securityOrigin || requestingOrigin || '').replace(/\/$/, '');
    return origin === appOrigin && mediaType === 'audio';
}

module.exports = { SPELLCHECK_DICTIONARY_URL, originOf, isLoopbackHost, navigationDecision, windowOpenDecision, permissionRequestDecision, permissionCheckDecision };
