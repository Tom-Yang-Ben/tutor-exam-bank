// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/stopper.js — 「關閉出題系統」捷徑的流程（docs/desktop-launcher.md 第 4 節、第 7.3 節）
//
//   1. 健康檢查：沒在跑 → 說沒在跑；埠上是別的程式 → 說不是出題系統。
//   2. 讀 data/launcher/server.json（啟動器開後端時寫的權杖），GET /api/launcher/status 看有幾件背景工作在跑。
//      後端不是啟動器開的（npm start 等）→ 沒有這條通道，請 Owner 到那個視窗按 Ctrl+C（不強制結束別人開的程式）。
//   3. 有背景工作在跑時先問（設定 askBeforeStopWithJobs）：是＝等它們跑完；否＝最多等 stopGraceSec 秒；取消＝不關。
//   4. POST /api/launcher/shutdown：後端停止認領新工作、等在途工作收尾、關連線池、結束（services/launcherControl.js）。
//   5. 後端真的結束了，才依設定關 Docker／Ollama（預設都不關；偵測到本機重錄時一律不關）。
// 關掉 app 視窗本身**不會**關後端（背景拆題可能還在跑），這是預設行為，列為待 Owner 確認事項 DL-2。
// I/O 全部經注入的 sys 與 ui。
// ─────────────────────────────────────────────────────────────
const path = require('path');
const w = require('./windows');

/** 「等它們跑完」＝後端接受的上限（services/launcherControl.js 的 MAX_GRACE_MS，6 小時） */
const WAIT_ALL_MS = require(path.resolve(__dirname, '..', '..', '..', 'services', 'launcherControl')).MAX_GRACE_MS;

/** 毫秒 → 「2 分鐘」「6 小時」 */
function fmtDuration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} 分鐘`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/**
 * 有背景工作時要問的話。純函式。
 * @param {number} inFlight
 * @param {number} graceMs
 */
function askText(inFlight, graceMs) {
    return [
        `背景有 ${inFlight} 件工作正在跑（上傳考卷的拆題、驗算等）。`,
        '',
        `「是」：等它們跑完再關閉後端（最多 ${fmtDuration(WAIT_ALL_MS)}；本機 AI 一步可能要數十分鐘）。`,
        `「否」：最多等 ${fmtDuration(graceMs)}；沒跑完的那一步，下次開啟時會自動從那一步重跑（已完成的不會重做）。`,
        '「取消」：不要關閉。'
    ].join('\n');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./system').createSystem>} deps.sys
 * @param {object} deps.config
 * @param {Record<string,string>} deps.env
 * @param {ReturnType<import('./probes').appPaths>} deps.paths
 * @param {ReturnType<import('./probes').createProbes>} deps.probes
 * @param {{messageBox:Function}} deps.ui
 * @param {(line:string)=>void} [deps.log]
 * @param {number} [deps.pollMs]
 * @returns {Promise<{result:string}>}
 */
async function runStop({ sys, config, env, paths, probes, ui, log = () => { }, pollMs = 1000 }) {
    const info = w.POPUP;
    const apiKey = String(env.API_KEY || '').trim();

    const health = await probes.probeHealth();
    log(`健康檢查：${JSON.stringify(health)}`);
    if (health.state === 'down') {
        const extras = await stopExtras();
        await ui.messageBox({ text: `出題系統的後端沒有在執行，不需要關閉。${extras}`, icon: info.ICON_INFO, seconds: 10 });
        return { result: 'not-running' };
    }
    if (health.state === 'other') {
        await ui.messageBox({ text: `${health.detail || '這個埠上的程式不是出題系統'}。\n關閉捷徑只會關出題系統，這個程式請自己關閉。`, icon: info.ICON_WARNING });
        return { result: 'other' };
    }

    const notLauncher = '這個後端不是由桌面「出題系統」圖示開的（例如在命令提示字元執行 npm start）。\n' +
        '請到執行它的那個視窗按 Ctrl+C 關閉。關閉捷徑不會強制結束別的方式開的程式。';
    const server = probes.readServerInfo(paths.serverInfo);
    if (!server || !server.token) {
        await ui.messageBox({ text: notLauncher, icon: info.ICON_WARNING });
        return { result: 'not-launcher' };
    }
    const headers = { 'x-launcher-token': server.token, ...(apiKey ? { 'x-api-key': apiKey } : {}) };
    const st = await sys.request({ url: `${probes.base}/api/launcher/status`, headers, timeoutMs: 5000 });
    log(`status：HTTP ${st.status} ${st.errorCode || ''}`);
    if (st.status === 404 || st.status === 403) {
        // 404：這個後端沒有關閉通道（不是啟動器開的）；403：權杖對不上（server.json 是更早那一次留下的）
        await ui.messageBox({ text: notLauncher, icon: info.ICON_WARNING });
        return { result: 'not-launcher' };
    }
    if (st.status === 401) {
        await ui.messageBox({
            text: 'exam_pro\\.env 的 API_KEY 和後端啟動時的不一樣（後端啟動後改過？），關閉要求被拒絕。\n請把 API_KEY 改回原本的值再按一次，或重新開機。',
            icon: info.ICON_ERROR
        });
        return { result: 'api-key' };
    }
    if (st.status !== 200 || !st.json) {
        await ui.messageBox({ text: `無法和後端溝通（${st.errorCode || `HTTP ${st.status}`}）。請稍後再按一次「關閉出題系統」。`, icon: info.ICON_ERROR });
        return { result: 'error' };
    }
    if (st.json.shutting_down) {
        await ui.messageBox({ text: '後端已經在關閉中（在等背景工作收尾），不必再按。', icon: info.ICON_INFO, seconds: 10 });
        return { result: 'already' };
    }

    const inFlight = Number(st.json.in_flight) || 0;
    let graceMs = config.stopGraceSec * 1000;
    if (inFlight > 0 && config.askBeforeStopWithJobs) {
        const ans = await ui.messageBox({ text: askText(inFlight, graceMs), title: '關閉出題系統', buttons: info.YES_NO_CANCEL, icon: info.ICON_QUESTION });
        log(`有 ${inFlight} 件背景工作，Owner 選：${ans}`);
        if (ans === 'cancel') return { result: 'cancelled' };
        if (ans === 'yes') graceMs = WAIT_ALL_MS;
    }

    const r = await sys.request({ url: `${probes.base}/api/launcher/shutdown`, method: 'POST', headers, body: { grace_ms: graceMs }, timeoutMs: 5000 });
    log(`shutdown：HTTP ${r.status} ${r.errorCode || ''} ${r.json ? JSON.stringify(r.json) : ''}`);
    if (r.status !== 202) {
        await ui.messageBox({ text: `關閉要求沒有成功（${r.errorCode || `HTTP ${r.status}`}）。請稍後再按一次。`, icon: info.ICON_ERROR });
        return { result: 'error' };
    }
    const pid = Number((r.json && r.json.pid) || server.pid);
    sys.writeText(paths.serverInfo, `${JSON.stringify({ ...server, shutdownRequestedAt: new Date(sys.now()).toISOString(), graceMs }, null, 2)}\n`);

    // 等後端真的結束：沒有在途工作時很快；有的話最多等到時限（上限 45 秒，之後就讓它自己收尾）
    const waitMs = inFlight > 0 ? Math.min(graceMs, 30_000) + 15_000 : 20_000;
    const started = sys.now();
    while (sys.pidAlive(pid) && sys.now() - started < waitMs) await sys.sleep(pollMs);
    if (!sys.pidAlive(pid)) {
        sys.remove(paths.serverInfo);
        log(`後端（PID ${pid}）已結束`);
        const extras = await stopExtras();
        await ui.messageBox({ text: `出題系統已關閉。${extras}`, icon: info.ICON_INFO, seconds: 6 });
        return { result: 'stopped' };
    }
    const extrasNote = config.stopDocker !== 'no' || config.stopOllama ? '\nDocker／Ollama 這次沒有關（後端還在用）。' : '';
    await ui.messageBox({
        text: `已送出關閉要求。背景還有工作在收尾，後端會在它們結束後自己關閉（最多 ${fmtDuration(graceMs)}）。${extrasNote}\n` +
            '在那之前關機或重新開機也可以：沒跑完的那一步下次開啟時會自動重跑。',
        icon: info.ICON_INFO, seconds: 20
    });
    return { result: 'draining' };

    /** 依設定關 Docker／Ollama；回傳要附在訊息後面的說明（沒設定就是空字串） */
    async function stopExtras() {
        if (config.stopDocker === 'no' && !config.stopOllama) return '';
        const rec = await probes.detectRecording();
        if (rec.active !== false) {
            log(`錄製偵測：${JSON.stringify(rec)}，不關 Docker／Ollama`);
            return rec.active
                ? '\n偵測到本機重錄正在執行，Docker 與 Ollama 維持開著。'
                : '\n無法確認是否有本機重錄在執行，為了保險 Docker 與 Ollama 維持開著。';
        }
        const notes = [];
        if (config.stopDocker !== 'no') {
            const cli = await probes.resolveDockerCli();
            if (!cli) {
                notes.push('找不到 docker 指令，資料庫容器沒有關。');
            } else {
                const c = await sys.exec(cli, ['compose', 'stop'], { cwd: paths.appDir, timeoutMs: 180_000 });
                notes.push(c.code === 0 ? '資料庫容器已停止（資料都還在）。' : `資料庫容器沒有停下來（${c.errorCode || `結束碼 ${c.code}`}）。`);
                if (config.stopDocker === 'desktop') {
                    const d = await sys.exec(cli, ['desktop', 'stop'], { timeoutMs: 180_000 });
                    notes.push(d.code === 0 ? 'Docker Desktop 已結束。' : 'Docker Desktop 沒有自動結束（這個版本不支援 docker desktop stop），請從右下角的鯨魚圖示選 Quit。');
                }
            }
        }
        if (config.stopOllama) {
            if (sys.platform === 'win32') {
                const a = await sys.exec('taskkill', ['/IM', 'ollama app.exe', '/F'], { timeoutMs: 30_000 });
                const b = await sys.exec('taskkill', ['/IM', 'ollama.exe', '/F'], { timeoutMs: 30_000 });
                notes.push(a.code === 0 || b.code === 0 ? 'Ollama 已結束。' : 'Ollama 本來就沒有在執行。');
            } else {
                notes.push('Ollama 只在 Windows 上由關閉捷徑結束。');
            }
        }
        for (const n of notes) log(n);
        return notes.length ? `\n${notes.join('\n')}` : '';
    }
}

module.exports = { runStop, askText, fmtDuration, WAIT_ALL_MS };
