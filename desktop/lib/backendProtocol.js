// ─────────────────────────────────────────────────────────────
// desktop/lib/backendProtocol.js — 主行程 ↔ 後端子行程（utilityProcess）之間的訊息（DA-3＝2）
//
// 桌面啟動器 A 的關閉捷徑要走 HTTP（/api/launcher/*，要權杖），因為它和後端是兩個不相干的程式。
// 桌面版的主行程直接握著子行程，改走 utilityProcess 的訊息通道（process.parentPort），不必開 HTTP 通道、也不必權杖：
//   子 → 主  { type:'ready', port, url, jobs_paused }                          後端聽到埠了（startServer 回來）
//   主 → 子  { type:'status', id }
//   子 → 主  { type:'status', id, in_flight, shutting_down, jobs_paused }       launcherControl 的同一份狀態
//   主 → 子  { type:'shutdown', grace_ms }                                        開始優雅關閉（冪等；時限以第一次為準）
//   主 → 子  { type:'shutdown', grace_ms:0, abandon:true }                        〔dec/r8-b1-abandon〕現在放棄：中止在途節點、
//            只放掉自己的租約後結束（jobRunner 的 shutdown({ abandon })）；已經在「等處理完」的關閉中也照樣改成放棄
//   子 → 主  { type:'shutdown-ack', grace_ms, in_flight, already }                 （放棄時多 abandon:true）
// 子行程這一側（attachBackendAgent）在 backend-entry.js 裡用；主行程那一側在 lib/backendHost.js。
// ─────────────────────────────────────────────────────────────
'use strict';

const TYPES = Object.freeze({
    READY: 'ready',
    STATUS: 'status',
    SHUTDOWN: 'shutdown',
    SHUTDOWN_ACK: 'shutdown-ack'
});

/**
 * parentPort 的 'message' 事件在子行程裡是 MessageEvent（內容在 .data）；主行程收到的是內容本身。兩種都接受。純函式。
 * @param {any} e
 */
function unwrap(e) {
    // 我們的訊息一定有 type（TYPES 之一）；外面包了一層、data 才是我們的訊息的，就是 MessageEvent
    const ours = m => Boolean(m && typeof m === 'object' && Object.values(TYPES).includes(m.type));
    if (ours(e)) return e;
    if (e && typeof e === 'object' && ours(e.data)) return e.data;
    return null;
}

/**
 * grace_ms 的解讀：沒給或不是數字 → defaultMs；負數 → 0；超過上限 → 上限（與 launcherControl.parseGraceMs 同規則）。純函式。
 * @param {unknown} raw
 * @param {{defaultMs:number, maxMs:number}} o
 */
function clampGrace(raw, { defaultMs, maxMs }) {
    if (raw === undefined || raw === null || raw === '') return defaultMs;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultMs;
    return Math.min(maxMs, Math.max(0, Math.round(n)));
}

/**
 * 子行程：聽主行程的訊息，回報狀態、開始關閉。
 * @param {object} o
 * @param {{on:Function, postMessage:Function}} o.parentPort  process.parentPort（測試換成假的）
 * @param {{status:()=>{in_flight:number, shutting_down:boolean}, close:(o:{graceMs:number, abandon?:boolean})=>Promise<any>, runner:object|null}} o.handle
 *        startServer() 的回傳值
 * @param {number} o.defaultGraceMs
 * @param {number} o.maxGraceMs
 * @param {(line:string)=>void} [o.log]
 */
function attachBackendAgent({ parentPort, handle, defaultGraceMs, maxGraceMs, log = () => { } }) {
    const jobsPaused = handle.runner === null || handle.runner === undefined;
    parentPort.on('message', e => {
        const msg = unwrap(e);
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === TYPES.STATUS) {
            const s = handle.status();
            parentPort.postMessage({ type: TYPES.STATUS, id: msg.id, in_flight: s.in_flight, shutting_down: s.shutting_down, jobs_paused: jobsPaused });
            return;
        }
        if (msg.type === TYPES.SHUTDOWN) {
            // 〔dec/r8-b1-abandon〕abandon：不等，馬上放棄在途工作（已經在等處理完時，close 會讓那一輪提早改成放棄）
            const abandon = msg.abandon === true;
            const graceMs = abandon ? 0 : clampGrace(msg.grace_ms, { defaultMs: defaultGraceMs, maxMs: maxGraceMs });
            const s = handle.status();
            parentPort.postMessage({ type: TYPES.SHUTDOWN_ACK, grace_ms: graceMs, in_flight: s.in_flight, already: s.shutting_down, ...(abandon ? { abandon: true } : {}) });
            if (abandon) log(`[desktop] 主行程要求現在放棄：中止 ${s.in_flight} 件在途工作（不寫結果、不動重試次數），放掉自己的租約後結束`);
            else if (!s.shutting_down) log(`[desktop] 主行程要求關閉：最多等在途工作 ${Math.round(graceMs / 1000)} 秒（目前 ${s.in_flight} 件）`);
            Promise.resolve(handle.close(abandon ? { graceMs, abandon: true } : { graceMs })).catch(err => log(`[desktop] 關閉時發生錯誤：${err && err.message}`));
        }
    });
}

/**
 * 子行程聽到埠之後送出的第一個訊息。純函式。
 * @param {{port:number, url:string, runner:object|null}} handle
 */
function readyMessage(handle) {
    return { type: TYPES.READY, port: handle.port, url: handle.url, jobs_paused: handle.runner === null || handle.runner === undefined };
}

/**
 * 主行程：狀態回覆 → BackendStatus。格式不對回 null。純函式。
 * @param {any} msg
 * @returns {{inFlight:number, shuttingDown:boolean, jobsPaused:boolean}|null}
 */
function parseStatus(msg) {
    if (!msg || msg.type !== TYPES.STATUS) return null;
    const n = Number(msg.in_flight);
    if (!Number.isFinite(n) || n < 0) return null;
    return { inFlight: Math.round(n), shuttingDown: Boolean(msg.shutting_down), jobsPaused: Boolean(msg.jobs_paused) };
}

module.exports = { TYPES, unwrap, clampGrace, attachBackendAgent, readyMessage, parseStatus };
