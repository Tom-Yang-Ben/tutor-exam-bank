// ─────────────────────────────────────────────────────────────
// desktop/lib/net.js — 挑一個 127.0.0.1 上的空埠給後端
//
// 為什麼不直接讓後端 listen(0)：後端的 ALLOWED_ORIGINS（app.js 在 require 當下讀）要寫進實際的埠
// （lib/config.js），所以主行程先挑好埠、放進子行程的環境變數。挑完到後端聽之間埠被別人搶走的機率很低；
// 真的發生時後端會以 EADDRINUSE 結束，lib/startup.js 換一個埠重開。
// ─────────────────────────────────────────────────────────────
'use strict';

const net = require('net');

/**
 * @param {string} [host]
 * @returns {Promise<number>}
 */
function pickFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, host, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

module.exports = { pickFreePort };
