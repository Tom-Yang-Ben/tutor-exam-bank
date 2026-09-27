// ─────────────────────────────────────────────────────────────
// utils/listenFailure.js — 後端聽不了連接埠時要印什麼、怎麼結束（server.js 用）
//
// 〔審查 dec/desktop-launcher 第 2 件，2026-09-27〕Express 5 的 app.listen 用 server.once('error', callback)
// 把 listen 的錯誤交給 callback，**不會丟出來**。server.js 原本的 callback 不看參數，結果是：
//   - 照印「已成功安全啟動」，不印 EADDRINUSE／EACCES；
//   - 不結束（連線池與 jobRunner 讓行程一直活著），不聽任何埠，卻繼續認領、執行背景拆題；
//   - 桌面啟動器等不到健康檢查、報「後端太久沒有回應」，關閉捷徑也找不到它。
// 現在 callback 收到錯誤就印出錯誤碼與處理方式，然後以結束碼 1 結束（npm start 也一樣受益）。
//
// log 裡一定有 Node 原本的錯誤訊息（例：listen EADDRINUSE: address already in use 127.0.0.1:3000）：
// 桌面啟動器靠這幾個字認出「埠被佔用」與「埠被保留」（scripts/desktop/lib/windows.js 的 listenErrorCode）。
// ─────────────────────────────────────────────────────────────

/**
 * listen 失敗的說明文字。純函式。
 * 〔Owner 第六輪 DA-11，2026-09-27〕後端改聽 HOST（預設 127.0.0.1，config/listenHost.js）：
 * HOST 寫成這台電腦沒有的位址（EADDRNOTAVAIL）或查不到的名稱（ENOTFOUND、EAI_AGAIN）時，說明怎麼改。
 * @param {Error & {code?:string}} err
 * @param {number|string} port
 * @param {string} [host]  server.js 實際傳給 listen 的位址（舊的呼叫端不傳）
 * @returns {string}
 */
function listenFailureText(err, port, host) {
    const code = (err && err.code) || 'UNKNOWN';
    const raw = String((err && err.message) || err);
    const where = host ? `（HOST=${host}）` : '';
    const lines = [`✖ 後端無法啟動：聽不了連接埠 ${port}${where}（${code}）。`, `  Node.js 的訊息：${raw}`];
    if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        lines.push(
            `  原因：exam_pro/.env（或系統環境變數）的 HOST 是「${host || '（不明）'}」，這台電腦沒有這個網路位址。`,
            '  處理：刪掉 HOST 這一行（只給這台電腦用，預設 127.0.0.1）；要讓區網的平板連進來就寫 HOST=0.0.0.0（見 exam_pro/README.md「區網存取」）。'
        );
    } else if (code === 'EADDRINUSE') {
        lines.push(
            `  原因：${port} 埠已經被別的程式佔用。常見的是另一個還開著的 npm start／npm run dev 視窗，或是別的 Node 專案。`,
            `  處理：關掉那個程式再啟動（Windows 可用 netstat -ano | findstr ":${port}" 查 PID）；`,
            `        或在 exam_pro/.env 把 PORT 改成別的數字，ALLOWED_ORIGINS 也要改成同一個埠。`
        );
    } else if (code === 'EACCES') {
        lines.push(
            `  原因：沒有權限使用 ${port} 埠。Windows 上最常見的是這個埠落在系統保留的範圍裡（Hyper-V、WSL、Docker Desktop 會保留一段埠）。`,
            '  處理：在命令提示字元執行 netsh interface ipv4 show excludedportrange protocol=tcp，看這個埠在不在列出的範圍內；',
            `        在的話，在 exam_pro/.env 把 PORT 改成範圍外的數字（ALLOWED_ORIGINS 也要跟著改），或重新開機後再試。`
        );
    } else {
        lines.push('  處理：照上面的訊息排除後再啟動。');
    }
    lines.push('  後端已經結束（不會在沒有網頁的情況下繼續跑背景拆題）。');
    return lines.join('\n');
}

/**
 * 把訊息寫進 stderr，確定寫完再結束（Windows 主控台的 stderr 是非同步的，直接 process.exit 可能把訊息截掉）。
 * @param {string} text
 * @param {number} [code]
 * @param {{stderr?: NodeJS.WritableStream, exit?: (code:number)=>void, fallbackMs?: number}} [deps]  測試注入
 */
function exitAfterFlush(text, code = 1, { stderr = process.stderr, exit = c => process.exit(c), fallbackMs = 2000 } = {}) {
    let done = false;
    let timer = null;
    const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        exit(code);
    };
    // 萬一寫入的 callback 一直沒回來，最多等 fallbackMs 也要結束（不 unref：它就是要把行程收掉）
    timer = setTimeout(finish, fallbackMs);
    try {
        stderr.write(`${text}\n`, finish);
    } catch (_) {
        finish();
    }
}

module.exports = { listenFailureText, exitAfterFlush };
