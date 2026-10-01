// ─────────────────────────────────────────────────────────────
// config/listenHost.js — 後端（server.js）聽哪個網路位址：HOST 設定
//
// 〔Owner 第六輪 DA-11＝1，2026-09-27〕網頁版（npm start、npm run dev、桌面啟動器開的 node server.js）改用 HOST 設定，
// **沒寫時只聽 127.0.0.1**（只接受這台電腦自己的連線）。原本 app.listen(PORT) 沒指定位址、綁在所有網路介面，
// 同一個 Wi-Fi 裡的裝置打不打得開題庫，全看 Windows 防火牆當初的選擇（docs/desktop-app-design.md DA-11）。
//
//   HOST 沒寫／空白     → 127.0.0.1（預設）
//   HOST=0.0.0.0（或 ::）→ 所有網路介面：平板、手機可以從區網連進來。要一併處理三件事（exam_pro/README.md「區網存取」）：
//                          Windows 防火牆只允許「私人網路」、ALLOWED_ORIGINS 加上區網網址、API_KEY 不是存取控制（會注入首頁）。
//   其他值               → 照設定聽（例：只聽某一張網卡的位址）。
//
// 跟其他設定一樣，系統環境變數優先於 .env（dotenv 預設不覆寫已經存在的變數）；後端啟動時印出實際聽的位址。
//
// 桌面啟動器（scripts/desktop/lib/probes.js）用同一支判斷「從本機要連哪個位址才問得到後端」：
//   127.0.0.1、localhost、::1（與 ::ffff:127.0.0.1）、萬用位址（0.0.0.0、::）→ 啟動器照常運作；
//   其他（只聽某個區網位址，或 127.0.0.1 以外的 127.x 位址）→ app 視窗的網址 http://localhost:<埠>/ 連不到後端
//   （localhost 只對應 127.0.0.1 與 ::1），啟動器直接說明、不啟動（docs/desktop-launcher.md 6、7.3）。
//   〔審查 dec/r7-decisions-host〕原本整段 127.0.0.0/8 都當成支援：HOST=127.0.0.2 時健康檢查連 127.0.0.2 判定成功，app 視窗卻打不開。
// 純函式，不讀檔；除了 node:net 不依賴任何模組（啟動器在 node_modules 還沒裝時也會載入它）。
// ─────────────────────────────────────────────────────────────
'use strict';

const net = require('net');

/** HOST 沒寫時聽的位址 */
const DEFAULT_HOST = '127.0.0.1';

/** 「聽所有網路介面」的寫法 */
const WILDCARD_HOSTS = Object.freeze(['0.0.0.0', '::']);

/**
 * 萬用位址以外，app 視窗的網址 http://localhost:<埠>/ 連得到的聽法（小寫比對）。
 * localhost 只對應 127.0.0.1 與 ::1；只聽 127.0.0.2 這類位址時 localhost 連不到。
 */
const LOCALHOST_REACHABLE_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/**
 * 設定值 → server.listen 的 host。純函式。
 * 去掉前後空白；IPv6 常見的方括號寫法（[::1]）去掉括號（listen 不認得括號）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function resolveListenHost(env = process.env) {
    const raw = env && env.HOST !== undefined && env.HOST !== null ? String(env.HOST).trim() : '';
    if (!raw) return DEFAULT_HOST;
    const m = raw.match(/^\[(.+)\]$/);
    return m ? m[1] : raw;
}

/**
 * 位址的種類。純函式。
 *   loopback：只有本機連得到（127.x.x.x、::1、localhost、::ffff:127.x.x.x）
 *   wildcard：所有網路介面（0.0.0.0、::）
 *   specific：其他（某一張網卡的位址、主機名稱）
 * @param {string} host
 * @returns {'loopback'|'wildcard'|'specific'}
 */
function hostScope(host) {
    const h = String(host || '').trim().toLowerCase();
    if (WILDCARD_HOSTS.includes(h)) return 'wildcard';
    if (h === 'localhost' || h === '::1') return 'loopback';
    if (net.isIPv4(h) && h.startsWith('127.')) return 'loopback';
    if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(h)) return 'loopback';
    return 'specific';
}

/**
 * 從這台電腦自己要連哪個位址才問得到後端（桌面啟動器的健康檢查、關閉通道用）。純函式。
 *   沒寫、127.0.0.1、0.0.0.0、:: → 127.0.0.1（聽 :: 時 Node 預設雙堆疊，IPv4 的本機位址也收得到）
 *   localhost → localhost（Node 的 listen 只綁 localhost 解析出的第一個位址，可能是 ::1，所以照名稱連）
 *   ::1 → ::1；::ffff:127.0.0.1 → 127.0.0.1
 *   其他 → null：app 視窗的網址（http://localhost:<埠>/）與 ALLOWED_ORIGINS 的預設都是 localhost，連不到只聽這個位址的後端。
 *     包括只聽某個區網位址（specific），以及 127.0.0.1 以外的 127.x 位址（hostScope 雖然是 loopback，
 *     健康檢查連得到，但 app 視窗打不開——〔審查 dec/r7-decisions-host〕）。
 * @param {string} host  resolveListenHost 的結果
 * @returns {string|null}
 */
function localProbeHost(host) {
    const scope = hostScope(host);
    if (scope === 'wildcard') return DEFAULT_HOST;
    const h = String(host || '').trim().toLowerCase();
    if (!LOCALHOST_REACHABLE_HOSTS.includes(h)) return null;
    return h === '::ffff:127.0.0.1' ? DEFAULT_HOST : h;
}

/**
 * host 放進網址時的寫法（IPv6 加方括號）。純函式。
 * @param {string} host
 */
function urlHost(host) {
    return net.isIPv6(String(host)) ? `[${host}]` : String(host);
}

/**
 * 後端啟動成功時印的一行。純函式。
 * localhost 連得到的本機位址與萬用位址都印 http://localhost:<埠>（瀏覽器照這個網址開；ALLOWED_ORIGINS 的預設也是它）；
 * 127.0.0.1 以外的 127.x 位址印那個位址的網址，並說明 localhost 連不到。
 * @param {string} host
 * @param {number|string} port
 * @returns {string}
 */
function startupText(host, port) {
    const scope = hostScope(host);
    const head = '🚀 家教題庫後端系統已成功安全啟動：';
    if (scope === 'loopback') {
        if (localProbeHost(host) === null) {
            return `${head}http://${urlHost(host)}:${port}（只接受這台電腦的連線，但只聽 HOST=${host}；http://localhost:${port} 連不到）`;
        }
        return `${head}http://localhost:${port}（只接受這台電腦的連線；HOST=${host}）`;
    }
    if (scope === 'wildcard') {
        return `${head}http://localhost:${port}（HOST=${host}：同一個網路的其他裝置也連得到。` +
            '請確認 Windows 防火牆只允許私人網路、ALLOWED_ORIGINS 加了區網網址；API_KEY 會注入首頁，不是存取控制。見 exam_pro/README.md「區網存取」）';
    }
    return `${head}http://${urlHost(host)}:${port}（只聽 HOST=${host}；這台電腦的 localhost 連不到）`;
}

module.exports = { DEFAULT_HOST, WILDCARD_HOSTS, LOCALHOST_REACHABLE_HOSTS, resolveListenHost, hostScope, localProbeHost, urlHost, startupText };
