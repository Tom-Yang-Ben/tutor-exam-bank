// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/statusServer.js — 啟動畫面的小型本機伺服器（docs/desktop-launcher.md 第 7.2 節）
//
// 為什麼選「先開 app 視窗到本機啟動頁」：
//   - 不必安裝任何東西（Node 內建 http；畫面就是 Edge／Chrome 的 app 視窗），而且進度、警告、錯誤都能完整顯示；
//     PowerShell 通知（toast／氣球提示）一次只能講一兩句、可能被「專注輔助」擋掉，看不到完整的處置步驟。
//   - 啟動完成時同一個視窗直接轉到系統首頁：Owner 從頭到尾只看到一個視窗。
//   - 開不了瀏覽器時才退回系統訊息框（lib/ui.js）。
//
// 只聽 127.0.0.1、隨機埠；只有兩個 GET：
//   /       啟動頁（scripts/desktop/status.html）
//   /state  目前狀態（JSON）：步驟、警告、失敗訊息、完成後要轉去的網址
// Host 標頭必須是 127.0.0.1／localhost 加這個埠（擋 DNS rebinding）。內容只有啟動進度，不含題庫資料或金鑰。
// ─────────────────────────────────────────────────────────────
const http = require('http');

/**
 * @param {object} o
 * @param {string} o.html         啟動頁
 * @param {() => object} o.getState
 * @param {(version:number) => void} [o.onDelivered]  /state 送出時通知（版本號）
 * @returns {Promise<{url:string, port:number, close:() => Promise<void>}>}
 */
function startStatusServer({ html, getState, onDelivered = () => { } }) {
    return new Promise((resolve, reject) => {
        let port = 0;
        const server = http.createServer((req, res) => {
            const host = String(req.headers.host || '');
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
            }
            const url = String(req.url || '/').split('?')[0];
            if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(html);
                return;
            }
            if (req.method === 'GET' && url === '/state') {
                const state = getState();
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(state));
                onDelivered(state.version);
                return;
            }
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve({
                url: `http://127.0.0.1:${port}/`,
                port,
                close: () => new Promise(r => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close(() => r());
                })
            });
        });
    });
}

module.exports = { startStatusServer };
