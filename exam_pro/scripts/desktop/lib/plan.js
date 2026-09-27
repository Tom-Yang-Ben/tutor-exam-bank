// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/plan.js — 桌面啟動器的決策邏輯（純函式，docs/desktop-launcher.md 第 7.1 節）
//
// launch.js 反覆做三件事：看目前知道的事實（facts）→ nextAction(facts) 決定下一步 → 執行、把結果併回 facts。
// 本檔只管第二步，而且**不碰任何 I/O**：各種狀態組合 → 下一步，全部由 test/unit/desktopLauncherPlan.test.js 釘住。
// 執行各一步的 I/O 在 lib/actions.js，迴圈在 lib/launcher.js。
//
// 順序（每一步只在它的前提成立時才做）：
//   1. 健康檢查：已在跑且資料庫正常 → 直接開 app 視窗、結束；埠被別的程式佔用 → 報錯。
//   2. 開啟動畫面（顯示進度與錯誤的本機頁面；開不了也不擋，最後改用系統訊息框報錯）。
//   3. 基本檢查：.env、node_modules、DATABASE_URL。
//   4. 偵測錄製（record_local／cassettes:rerecord）。
//   5. 資料庫：連得上就不碰 Docker；連不上時——錄製中 → 報錯、不動 Docker；否則 docker info →（需要時）開 Docker Desktop、
//      等就緒 → docker compose up -d --wait（＝npm run db:up）→ 等資料庫連得上。
//   6. 本機 AI：.env 的模型有 ollama: 才需要；沒在跑就試著開、等就緒。**失敗只警告、不擋開機**。
//   7. migration：只讀、只提示，不自動升級。
//   8. 後端：背景啟動 node server.js，等健康檢查。
//   9. 完成：啟動畫面轉到系統首頁（或直接開 app 視窗）。
//
// 〔續作 2026-09-27〕WIP 的修正：埠的佔用者改放在 facts.portOwner（原本 nextAction 看 facts、訊息讀 ctx，兩邊對不上）；
// describe-port 補進步驟對照；錄製偵測失敗（active:null）改成警告；補 DATABASE_URL 缺漏、Ollama 在別台電腦、
// 空資料庫、上一個後端還在收尾、設定檔有誤、啟動器內部錯誤等情況。
//
// 〔審查 dec/desktop-launcher，2026-09-27〕
//   - 後端聽不了埠：log 裡的 listen 錯誤分成 EADDRINUSE（被佔用）與 EACCES（沒有權限；多半是 Windows 保留的埠段 → port-reserved）。
//   - 自己開的後端逾時時還活著、而埠正被別的程式聽著 → 它聽不了埠（舊版 server.js 會把 listen 錯誤吞掉）：
//     先結束它（stop-server），再報埠被佔用，不留下沒有網頁、卻繼續跑背景拆題的孤兒。
//   - 健康檢查逾時、而聽著這個埠的正是上次由圖示開的後端（server.json 的 PID）→ server-busy（不再說「被其他程式佔用」）。
//   - 錄製中：依設定 jobsWhileRecording 決定後端要不要暫停背景工作；警告寫明佇列裡已有的工作也會開跑。
// ─────────────────────────────────────────────────────────────

/** Windows 保留連接埠範圍的查法（EACCES 時提示） */
const EXCLUDED_PORTS_CMD = 'netsh interface ipv4 show excludedportrange protocol=tcp';

/** 升級流程的出處（提示 migration 沒套時引用） */
const UPGRADE_DOC = 'engineering_docs/06_ops/deployment_and_operations.md §3.3、§3.6';
const LAUNCHER_DOC = 'docs/desktop-launcher.md';

/**
 * 後端被中途結束後，沒跑完的背景工作會怎樣（給 Owner 的一句話；關閉捷徑 lib/stopper.js 也用這一句）。
 * 〔dec/desktop-launcher-fix2〕更正：只有單題的節點（job_questions）是從中斷那一格接著跑；拆題（runExtractJob）與
 * 變式生成（runGenerateJob）是整份 job 一個工作單位，重新認領時不看哪幾塊／哪幾題已經做完，從第 1 塊／第 1 題整份重跑
 * （workers/jobRunner.js；docs/desktop-launcher.md 第 4 節、7.3、DL-1）。「1 小時以上」是本機 OCR 為主拆一份 4 頁卷的估計
 * （docs/local-mode.md 10.12 第 5 點）。
 */
const UNFINISHED_WORK_NOTE = '沒跑完的工作下次開啟時會自動接著做：單題的檢查從中斷那一步接著做；' +
    '整份卷的拆題、變式生成會從頭再跑一次（本機拆一份卷可能要 1 小時以上）';

/**
 * @typedef {object} Facts
 * @property {string[]} [configWarnings]  data/launcher/config.json 讀不懂的地方（啟動前就放進來）
 * @property {{state:'ours', dbOk:boolean, legacy?:boolean, version?:string}|{state:'other', detail?:string}|{state:'down'}} [health]
 * @property {{ok:boolean, via?:string, error?:string}} [statusWindow]
 * @property {{pid?:number|null, name?:string|null, text:string|null, pids?:number[], ownServer?:boolean, logFile?:string}} [portOwner]
 *           埠被佔用時是誰（text 例：node.exe（PID 1234））；pids＝所有在聽這個埠的 PID；ownServer＝聽著的正是 server.json 記的後端
 *           （logFile＝那個後端的 log）
 * @property {{envFile:boolean, nodeModules:boolean, databaseUrl:boolean, draining?:{pid:number, untilMs:number}|null}} [setup]
 * @property {{active:boolean|null, matches?:string[], error?:string, pauseJobs?:boolean}} [recording]
 *           pauseJobs：設定 jobsWhileRecording 是 pause（錄製中開的後端暫停背景工作）
 * @property {{reachable:boolean, error?:string}} [db]
 * @property {{ready:boolean, cliFound?:boolean, error?:string}} [docker]
 * @property {{ok:boolean, reason?:'not-found'|'spawn-failed', path?:string, error?:string}} [dockerLaunch]
 * @property {{ready:boolean, waitedMs?:number}} [dockerWait]
 * @property {{ok:boolean, error?:string, outputTail?:string}} [compose]
 * @property {{reachable:boolean, error?:string}} [dbAfterCompose]
 * @property {{needed:boolean, models:string[], host?:string, local?:boolean, error?:string, ocrNeeded?:boolean, ocrFound?:boolean|null, ocrPython?:string}} [ollamaNeed]
 * @property {{reachable:boolean, missing?:string[], error?:string}} [ollama]
 * @property {{ok:boolean, method?:'app'|'serve', reason?:'not-found'|'spawn-failed'|'remote-host', path?:string, error?:string}} [ollamaLaunch]
 * @property {{ready:boolean, missing?:string[], waitedMs?:number}} [ollamaWait]
 * @property {{ok:boolean, pending?:string[], unknown?:string[], latest?:string|null, appliedCount?:number, error?:string}} [migrations]
 * @property {{spawned:boolean, pid?:number, logFile?:string, error?:string, jobsPaused?:boolean}} [server]
 * @property {{ready:boolean, reason?:'timeout'|'exited', exitCode?:number|null, logTail?:string, addrInUse?:boolean,
 *            listenError?:'EADDRINUSE'|'EACCES'|null, childAlive?:boolean, dbOk?:boolean}} [serverWait]
 * @property {{pid:number, stopped:boolean}} [serverStop]  啟動器結束了自己開、卻聽不了埠的後端
 */

/**
 * @typedef {object} PlanContext
 * @property {number} port
 * @property {string} appUrl
 * @property {string} [dockerDesktopPath]
 * @property {number} [dockerReadyTimeoutSec]
 * @property {number} [ollamaReadyTimeoutSec]
 * @property {number} [serverReadyTimeoutSec]
 * @property {string} [serverLog]
 * @property {string} [launcherLog]
 */

/**
 * 決定下一步。純函式。
 * @param {Facts} f
 * @param {PlanContext} ctx
 * @returns {{type:string, [k:string]:any}}
 */
function nextAction(f, ctx) {
    // 1. 健康檢查
    if (!f.health) return { type: 'probe-health' };
    if (f.health.state === 'ours' && f.health.dbOk) return { type: 'open-app', url: ctx.appUrl, reason: 'already-running' };

    // 2. 啟動畫面（其餘情況都先開：之後的進度與錯誤都顯示在這裡）
    if (!f.statusWindow) return { type: 'open-status-window' };
    if (f.health.state === 'other') {
        if (!f.portOwner) return { type: 'describe-port' };
        // 聽著這個埠的是上次由圖示開的後端，只是健康檢查沒有回應（例如忙到逾時）：不是「別的程式」
        return fail(f.portOwner.ownServer ? 'server-busy' : 'port-in-use', f, ctx);
    }

    // 3. 基本檢查（後端已經在跑時不必：它顯然有 .env 與 node_modules）
    if (f.health.state === 'down') {
        if (!f.setup) return { type: 'check-setup' };
        if (!f.setup.envFile) return fail('env-missing', f, ctx);
        if (!f.setup.nodeModules) return fail('modules-missing', f, ctx);
        if (!f.setup.databaseUrl) return fail('db-url-missing', f, ctx);
    }

    // 4. 錄製偵測
    if (!f.recording) return { type: 'detect-recording' };

    // 5. 資料庫
    if (!f.db) return { type: 'probe-db' };
    if (!f.db.reachable) {
        if (f.recording.active === true) return fail('recording-db-down', f, ctx);
        if (!f.docker) return { type: 'probe-docker' };
        if (!f.docker.ready) {
            if (!f.dockerLaunch) return { type: 'launch-docker' };
            if (!f.dockerLaunch.ok) {
                return fail(f.dockerLaunch.reason === 'not-found' ? 'docker-not-found' : 'docker-launch-failed', f, ctx);
            }
            if (!f.dockerWait) return { type: 'wait-docker' };
            if (!f.dockerWait.ready) return fail('docker-timeout', f, ctx);
        }
        if (!f.compose) return { type: 'compose-up' };
        if (!f.compose.ok) return fail('compose-failed', f, ctx);
        if (!f.dbAfterCompose) return { type: 'wait-db' };
        if (!f.dbAfterCompose.reachable) return fail('db-unreachable', f, ctx);
    }

    // 6. 本機 AI（失敗不擋開機）
    if (!f.ollamaNeed) return { type: 'resolve-ollama-need' };
    if (f.ollamaNeed.needed) {
        if (!f.ollama) return { type: 'probe-ollama' };
        if (!f.ollama.reachable) {
            if (!f.ollamaLaunch) return { type: 'launch-ollama' };
            if (f.ollamaLaunch.ok && !f.ollamaWait) return { type: 'wait-ollama' };
        }
    }

    // 7. migration（只提示）
    if (!f.migrations) return { type: 'check-migrations' };

    // 8. 後端
    if (f.health.state === 'ours') return { type: 'finish', url: ctx.appUrl, reason: 'db-restored' };
    if (!f.server) return { type: 'spawn-server' };
    if (!f.server.spawned) return fail('server-spawn-failed', f, ctx);
    if (!f.serverWait) return { type: 'wait-server' };
    if (!f.serverWait.ready) {
        const sw = f.serverWait;
        const listenError = sw.listenError || (sw.addrInUse ? 'EADDRINUSE' : null);
        if (sw.reason === 'exited' && listenError) {
            if (!f.portOwner) return { type: 'describe-port' };
            // EACCES 而查不到誰在聽 → 埠被 Windows 保留；查得到 → 別的程式以獨佔方式佔用，同「被佔用」
            return fail(listenError === 'EACCES' && !f.portOwner.pid ? 'port-reserved' : 'port-in-use', f, ctx);
        }
        // 自己開的後端逾時時還活著、而這個埠正被別的程式聽著 → 它不可能聽得到這個埠。
        // 結束它再報錯：留著它只會多一個沒有網頁、卻繼續跑背景拆題的程序（Owner 每照提示再點一次就多一個）。
        if (sw.reason === 'timeout' && sw.childAlive) {
            if (!f.portOwner) return { type: 'describe-port' };
            if (portHeldByOther(f)) {
                if (!f.serverStop) return { type: 'stop-server' };
                return fail('port-in-use', f, ctx);
            }
        }
        return fail(sw.reason === 'exited' ? 'server-exited' : 'server-timeout', f, ctx);
    }

    // 9. 完成
    return { type: 'finish', url: ctx.appUrl, reason: 'started' };
}

/**
 * 這個埠有程式在聽、但不是這一輪開的後端。純函式。
 * @param {Facts} f
 */
function portHeldByOther(f) {
    const o = f.portOwner || {};
    const pids = Array.isArray(o.pids) ? o.pids : (o.pid ? [o.pid] : []);
    return pids.length > 0 && !(f.server && pids.includes(f.server.pid));
}

/** 終止型的 action（執行完就不再問 nextAction） */
const TERMINAL = new Set(['open-app', 'finish', 'fail']);

/** @param {{type:string}} action */
function isTerminal(action) {
    return TERMINAL.has(action && action.type);
}

// ─────────────────────────── 失敗訊息 ───────────────────────────

/**
 * @param {string} code
 * @param {Facts} f
 * @param {PlanContext} ctx
 * @param {{detail?:string}} [extra]
 */
function fail(code, f, ctx, extra = {}) {
    return { type: 'fail', code, ...failureMessage(code, f, ctx, extra) };
}

/**
 * 給 Owner 看的錯誤：標題、原因、處置（每一條都要說「下一步做什麼」）。純函式。
 * @param {string} code
 * @param {Facts} [f]
 * @param {Partial<PlanContext>} [ctx]
 * @param {{detail?:string}} [extra]  internal 用：例外訊息
 * @returns {{title:string, message:string, hint:string[], detail?:string}}
 */
function failureMessage(code, f = {}, ctx = {}, extra = {}) {
    const port = ctx.port || 3000;
    const retry = '處理好之後，再點一次桌面的「出題系統」圖示（已經啟動的部分不會重做）。';
    const serverLog = (f.server && f.server.logFile) || ctx.serverLog || 'exam_pro\\data\\logs\\server-日期.log';
    switch (code) {
        case 'port-in-use': {
            const who = f.portOwner && f.portOwner.text ? `：${f.portOwner.text}` : '';
            const detail = f.health && f.health.state === 'other' && f.health.detail ? f.health.detail : undefined;
            const stop = f.serverStop;
            const stopNote = !stop ? []
                : stop.stopped
                    ? [`啟動器剛開的後端（PID ${stop.pid}）用不到這個埠，已經由啟動器結束，不會留在背景。`]
                    : [`啟動器剛開的後端（PID ${stop.pid}）用不到這個埠，但沒能結束它：請到工作管理員 → 詳細資料，結束 PID ${stop.pid} 的 node.exe。`];
            return {
                title: `連接埠 ${port} 被其他程式佔用`,
                message: `出題系統要用 ${port} 埠，但它已經被另一個程式佔用${who}。`,
                hint: [
                    ...stopNote,
                    f.portOwner && /^node(\.exe)?$/i.test(String(f.portOwner.name || ''))
                        ? '佔用的是 Node.js：可能是另一個還開著的 npm start／npm run dev 視窗，或別的 Node 專案。關掉那個視窗再點一次圖示。'
                        : '關掉那個程式（工作管理員 → 詳細資料，依 PID 找），再點一次圖示。',
                    `若那個程式一定要用 ${port} 埠：在 exam_pro\\.env 把 PORT 改成別的數字，ALLOWED_ORIGINS 也要改成同一個埠。`
                ],
                ...(detail ? { detail } : {})
            };
        }
        case 'port-reserved':
            return {
                title: `連接埠 ${port} 無法使用`,
                message: `後端沒有權限使用 ${port} 埠（EACCES），而且查不到有別的程式在用它。Windows 上最常見的原因是這個埠落在系統保留的範圍裡（Hyper-V、WSL、Docker Desktop 會保留一段埠）。`,
                hint: [
                    `在命令提示字元執行 ${EXCLUDED_PORTS_CMD}，看 ${port} 在不在列出的範圍內。`,
                    `在的話：在 exam_pro\\.env 把 PORT 改成範圍外的數字（例如 3300），ALLOWED_ORIGINS 也要改成同一個埠；或重新開機後再試（保留的範圍可能在重開機後改變）。`,
                    `打開 log：${serverLog}`
                ],
                ...(f.serverWait && f.serverWait.logTail ? { detail: f.serverWait.logTail } : {})
            };
        case 'server-busy': {
            const pid = f.portOwner && f.portOwner.pid;
            const detail = f.health && f.health.detail ? f.health.detail : undefined;
            const ownLog = (f.portOwner && f.portOwner.logFile) || serverLog;
            return {
                title: '出題系統的後端沒有回應',
                message: `${port} 埠上是之前由桌面圖示開的出題系統後端${pid ? `（PID ${pid}）` : ''}，但它沒有回應健康檢查。通常是電腦正忙（例如本機 AI 正在拆題）。`,
                hint: [
                    '等一兩分鐘再點一次圖示：它一回應就會直接開畫面。',
                    `一直沒有回應：先點「關閉出題系統」；還是不行，到工作管理員 → 詳細資料，結束${pid ? ` PID ${pid} 的` : ''} node.exe，再點一次圖示。`,
                    `強制結束的話，${UNFINISHED_WORK_NOTE}。`,
                    `打開 log：${ownLog}`
                ],
                ...(detail ? { detail } : {})
            };
        }
        case 'env-missing':
            return {
                title: '找不到 exam_pro\\.env',
                message: '系統的設定檔 .env 不存在，後端無法啟動。',
                hint: ['把 exam_pro\\.env.example 複製成 .env（要改哪幾行見 docs\\local-mode.md 第 10 條）。', retry]
            };
        case 'modules-missing':
            return {
                title: '還沒安裝相依套件',
                message: '找不到 exam_pro\\node_modules。',
                hint: ['在 exam_pro 資料夾執行 npm install。', retry]
            };
        case 'db-url-missing':
            return {
                title: '.env 沒有設定 DATABASE_URL',
                message: '後端要靠 exam_pro\\.env 的 DATABASE_URL 連資料庫，現在這一行不存在或是空的。',
                hint: ['在 exam_pro\\.env 加上一行：DATABASE_URL=postgres://exam:exam@localhost:5442/tutor_exam_bank', retry]
            };
        case 'recording-db-down':
            return {
                title: '錄製進行中，而且資料庫連不上',
                message: '偵測到本機重錄（record_local.bat／cassettes:rerecord）正在執行，啟動器不動 Docker 與資料庫，以免打斷錄製。',
                hint: ['等錄製結束（看錄製視窗或 exam_pro\\data\\local_ai\\record_*.log）後再點一次圖示。',
                    '若確定沒有在錄：關掉殘留的錄製視窗，再點一次圖示。'],
                ...(f.recording && f.recording.matches && f.recording.matches.length ? { detail: f.recording.matches.join('\n') } : {})
            };
        case 'docker-not-found':
            return {
                title: '找不到 Docker Desktop',
                message: `Docker 沒有在執行，也找不到 Docker Desktop（${(f.dockerLaunch && f.dockerLaunch.path) || ctx.dockerDesktopPath || 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'}）。`,
                hint: ['從開始選單手動開 Docker Desktop，等鯨魚圖示不再轉動，再點一次圖示。',
                    `Docker Desktop 裝在別的位置：在 exam_pro\\data\\launcher\\config.json 設 dockerDesktopPath（見 ${LAUNCHER_DOC} 第 6 節）。`]
            };
        case 'docker-launch-failed':
            return {
                title: '無法啟動 Docker Desktop',
                message: `開啟 Docker Desktop 失敗：${(f.dockerLaunch && f.dockerLaunch.error) || '原因不明'}`,
                hint: ['從開始選單手動開 Docker Desktop，等鯨魚圖示不再轉動。', retry]
            };
        case 'docker-timeout':
            return {
                title: 'Docker Desktop 太久沒有就緒',
                message: `已經開啟 Docker Desktop，但 ${ctx.dockerReadyTimeoutSec || 240} 秒內 docker info 仍然失敗。`,
                hint: ['看工作列右下角的鯨魚圖示：還在轉就再等一下；有錯誤視窗就照它的指示處理（常見是 WSL 需要更新：在命令提示字元執行 wsl --update）。',
                    retry,
                    `等待時間可在 exam_pro\\data\\launcher\\config.json 的 dockerReadyTimeoutSec 調長（見 ${LAUNCHER_DOC} 第 6 節）。`]
            };
        case 'compose-failed':
            return {
                title: '資料庫容器啟動失敗',
                message: `docker compose up -d --wait（等同 npm run db:up）失敗：${(f.compose && f.compose.error) || '原因不明'}`,
                hint: ['常見原因：5442 或 5433 埠被本機的 PostgreSQL 佔用（命令提示字元執行 netstat -ano | findstr ":5442"）。',
                    '也可以雙擊 exam_pro\\啟動資料庫.bat 看完整訊息。', retry],
                ...(f.compose && f.compose.outputTail ? { detail: f.compose.outputTail } : {})
            };
        case 'db-unreachable':
            return {
                title: '連不上資料庫',
                message: `容器已經啟動，但用 .env 的 DATABASE_URL 連不上資料庫：${(f.dbAfterCompose && f.dbAfterCompose.error) || '原因不明'}`,
                hint: ['確認 exam_pro\\.env 的 DATABASE_URL 是 postgres://exam:exam@localhost:5442/tutor_exam_bank（埠是 5442）。', retry]
            };
        case 'server-spawn-failed':
            return {
                title: '無法啟動後端',
                message: `啟動 node server.js 失敗：${(f.server && f.server.error) || '原因不明'}`,
                hint: ['確認 Node.js 已安裝（命令提示字元執行 node --version）。', retry]
            };
        case 'server-exited':
            return {
                title: '後端啟動後立刻結束',
                message: `node server.js 結束了（結束碼 ${f.serverWait && f.serverWait.exitCode != null ? f.serverWait.exitCode : '不明'}）。原因通常寫在 log 最後幾行。`,
                hint: [`打開 log：${serverLog}`,
                    '常見原因：.env 設定矛盾（例如 LOCAL_EXTRACT_MODE 與 OCR_ENGINE）、DATABASE_URL 缺漏。照 log 的訊息改好，再點一次圖示。'],
                ...(f.serverWait && f.serverWait.logTail ? { detail: f.serverWait.logTail } : {})
            };
        case 'server-timeout':
            return {
                title: '後端太久沒有回應',
                message: `node server.js 已經啟動，但 ${ctx.serverReadyTimeoutSec || 120} 秒內健康檢查（/api/health）沒有回應。`,
                hint: [`打開 log：${serverLog}`,
                    '電腦剛開機、很忙時可能只是比較慢：等一分鐘再點一次圖示（已在跑就會直接開畫面）。'],
                ...(f.serverWait && f.serverWait.logTail ? { detail: f.serverWait.logTail } : {})
            };
        case 'internal':
            return {
                title: '啟動程式發生未預期的錯誤',
                message: '啟動程式本身出錯了（不是設定的問題）。已經啟動的部分維持原狀。',
                hint: [`把 ${ctx.launcherLog || 'exam_pro\\data\\logs\\launcher-日期.log'} 交給維護的人。`, retry],
                ...(extra.detail ? { detail: extra.detail } : {})
            };
        default:
            return {
                title: '啟動失敗',
                message: `未預期的狀況（${code}）。`,
                hint: [`把 ${ctx.launcherLog || 'exam_pro\\data\\logs\\launcher-日期.log'} 交給維護的人。`],
                ...(extra.detail ? { detail: extra.detail } : {})
            };
    }
}

// ─────────────────────────── 警告（不擋開機）───────────────────────────

/** 本機 AI 相關的警告代碼（啟動畫面把它們歸在「本機 AI」那一步） */
const AI_WARNING_CODES = ['model-config', 'ollama-not-found', 'ollama-launch-failed', 'ollama-remote', 'ollama-timeout', 'ollama-models', 'ocr-missing'];
/** migration 相關的警告代碼 */
const MIGRATION_WARNING_CODES = ['migrations-unknown', 'migrations-empty', 'migrations-pending', 'migrations-ahead'];

/**
 * 目前事實推得出的警告。純函式；順序固定（畫面與 log 照這個順序列）。
 * @param {Facts} f
 * @returns {Array<{code:string, text:string}>}
 */
function collectWarnings(f) {
    const out = [];
    for (const w of f.configWarnings || []) {
        out.push({ code: 'config', text: `啟動器設定檔 exam_pro\\data\\launcher\\config.json：${w}（這一項改用預設值）` });
    }
    if (f.recording && f.recording.active === true && f.db && f.db.reachable) {
        out.push({
            code: 'recording',
            text: f.recording.pauseJobs
                ? '偵測到本機重錄正在執行：啟動器沒有動 Docker 與資料庫，而且這次開的後端暫停背景工作（設定 jobsWhileRecording 是 pause）：' +
                    '上傳的考卷會先排隊，佇列裡原有的工作也不會開跑。錄完後點「關閉出題系統」、再點「出題系統」，排隊的工作就會開始。'
                : '偵測到本機重錄正在執行：啟動器沒有動 Docker 與資料庫。後端一起來，佇列裡已有的背景工作（之前上傳、還沒拆完的考卷）就會自己開跑，' +
                    '和錄製搶 CPU 與記憶體，可能讓錄製逾時；新的考卷也建議錄完再上傳。' +
                    `要在錄製期間暫停背景工作，見 ${LAUNCHER_DOC} 第 8 節 DL-4。`
        });
    }
    if (f.recording && f.recording.active === null) {
        out.push({ code: 'recording-unknown', text: `無法確認是否有本機重錄正在執行（${f.recording.error || '讀不到程序清單'}）。若正在錄製，請留意不要在錄製期間關閉 Docker。` });
    }
    if (f.setup && f.setup.draining && f.setup.draining.pid) {
        out.push({ code: 'previous-draining', text: `上一次關閉的後端（PID ${f.setup.draining.pid}）還在等背景工作收尾；新的後端照常啟動，舊的做完手上那一件就會自己結束。` });
    }
    const n = f.ollamaNeed;
    if (n && n.error) {
        out.push({ code: 'model-config', text: `看不懂 .env 的模型設定（${n.error}）；後端啟動時會印出同一個錯誤。` });
    }
    if (n && n.needed) {
        const ai = '上傳考卷拆題、驗算、分類、向量檢索等本機 AI 功能會失敗；其他功能（題庫、組卷、Word、批改）照常。';
        const launch = f.ollamaLaunch;
        const reachable = (f.ollama && f.ollama.reachable) || (f.ollamaWait && f.ollamaWait.ready);
        if (!reachable) {
            if (launch && !launch.ok && launch.reason === 'not-found') {
                out.push({ code: 'ollama-not-found', text: `Ollama 沒有在執行，也找不到 Ollama 的程式。${ai}請從開始選單開 Ollama，或到 https://ollama.com/download 安裝。` });
            } else if (launch && !launch.ok && launch.reason === 'remote-host') {
                out.push({ code: 'ollama-remote', text: `.env 的 OLLAMA_HOST 指向別台電腦（${n.host || '不明'}），而那台現在連不上；啟動器不會去開別台電腦的 Ollama。${ai}` });
            } else if (launch && !launch.ok) {
                out.push({ code: 'ollama-launch-failed', text: `Ollama 沒有在執行，而且開不起來（${launch.error || '原因不明'}）。${ai}請從開始選單開 Ollama。` });
            } else if (f.ollamaWait && !f.ollamaWait.ready) {
                out.push({ code: 'ollama-timeout', text: `已經開啟 Ollama，但它還沒有回應（${n.host || 'http://127.0.0.1:11434'}）。${ai}等右下角出現羊駝圖示後，拆題就會恢復，不必重開系統。` });
            }
        } else {
            const missing = (f.ollamaWait && f.ollamaWait.ready ? f.ollamaWait.missing : f.ollama && f.ollama.missing) || [];
            if (missing.length) {
                out.push({ code: 'ollama-models', text: `Ollama 還沒下載這些模型：${missing.join('、')}。用到它們的拆題與 AI 功能會失敗。請雙擊 exam_pro\\scripts\\windows\\setup_local_ai.bat。` });
            }
        }
    }
    if (n && n.ocrNeeded && n.ocrFound === false) {
        out.push({ code: 'ocr-missing', text: `找不到 PaddleOCR 的 Python（${n.ocrPython || 'ocr_service\\.venv'}）：本機拆題會失敗。請雙擊 exam_pro\\scripts\\windows\\setup_local_ai.bat。` });
    }
    const m = f.migrations;
    if (m && m.error) {
        out.push({ code: 'migrations-unknown', text: `無法檢查資料庫版本（${m.error}）。` });
    }
    if (m && !m.error && m.appliedCount === 0 && m.pending && m.pending.length) {
        out.push({
            code: 'migrations-empty',
            text: `資料庫是空的（還沒套過任何 migration），系統無法正常使用。啟動器不會自動建表：請在 exam_pro 資料夾執行 npm run migrate（或雙擊 exam_pro\\啟動資料庫.bat），再重新整理頁面。`
        });
    } else if (m && m.pending && m.pending.length) {
        out.push({
            code: 'migrations-pending',
            text: `資料庫有 ${m.pending.length} 支 migration 還沒套用（${m.pending.join('、')}）。啟動器不會自動升級，部分功能可能出錯。` +
                `請照 ${UPGRADE_DOC} 的升級流程處理：停服務 → 備份 → npm run migrate → 快照比對。`
        });
    }
    if (m && m.unknown && m.unknown.length) {
        out.push({ code: 'migrations-ahead', text: `資料庫套過程式裡沒有的 migration（${m.unknown.join('、')}），可能是切回了舊版程式。請先確認目前的程式版本。` });
    }
    if (f.serverWait && f.serverWait.ready && f.serverWait.dbOk === false) {
        out.push({ code: 'server-db-degraded', text: '後端已經啟動，但它回報連不上資料庫；畫面上的操作可能會失敗。請用「關閉出題系統」關掉後再開一次。' });
    }
    return out;
}

// ─────────────────────────── 進度（啟動畫面）───────────────────────────

const STEP_DEFS = [
    { id: 'check', label: '檢查系統狀態' },
    { id: 'database', label: '資料庫（Docker）' },
    { id: 'ai', label: '本機 AI（Ollama）' },
    { id: 'migrations', label: '資料庫版本' },
    { id: 'server', label: '啟動後端' },
    { id: 'window', label: '開啟操作畫面' }
];

/** action → 它屬於哪一步 */
const STEP_OF_ACTION = {
    'probe-health': 'check', 'open-status-window': 'check', 'describe-port': 'check', 'check-setup': 'check', 'detect-recording': 'check',
    'probe-db': 'database', 'probe-docker': 'database', 'launch-docker': 'database', 'wait-docker': 'database',
    'compose-up': 'database', 'wait-db': 'database',
    'resolve-ollama-need': 'ai', 'probe-ollama': 'ai', 'launch-ollama': 'ai', 'wait-ollama': 'ai',
    'check-migrations': 'migrations',
    'spawn-server': 'server', 'wait-server': 'server', 'stop-server': 'server',
    'finish': 'window', 'open-app': 'window'
};

/** 每個 action 執行中時畫面上的說明 */
const RUNNING_TEXT = {
    'probe-health': '檢查系統是否已在執行…',
    'open-status-window': '開啟啟動畫面…',
    'describe-port': '查詢是哪個程式佔用連接埠…',
    'check-setup': '檢查設定檔…',
    'detect-recording': '檢查是否有錄製正在進行…',
    'probe-db': '檢查資料庫…',
    'probe-docker': '檢查 Docker…',
    'launch-docker': '開啟 Docker Desktop…',
    'wait-docker': '等 Docker Desktop 就緒（第一次開機可能要一兩分鐘）…',
    'compose-up': '啟動資料庫容器（docker compose up -d --wait）…',
    'wait-db': '等資料庫接受連線…',
    'resolve-ollama-need': '讀取模型設定…',
    'probe-ollama': '檢查 Ollama…',
    'launch-ollama': '開啟 Ollama…',
    'wait-ollama': '等 Ollama 就緒…',
    'check-migrations': '檢查資料庫版本（只讀）…',
    'spawn-server': '啟動後端…',
    'wait-server': '等後端就緒（載入模組約需十幾秒）…',
    'stop-server': '結束這次開的後端（它用不到連接埠）…'
};

/**
 * 啟動畫面上六個步驟各自的狀態。純函式。
 * @param {Facts} f
 * @param {{type:string, code?:string, title?:string}|null} action 目前正在做（或最後決定）的 action
 * @returns {Array<{id:string, label:string, state:'pending'|'running'|'done'|'skipped'|'warn'|'error', detail:string}>}
 */
function describeSteps(f, action) {
    const current = action ? (action.type === 'fail' ? stepOfFailure(action.code, f) : STEP_OF_ACTION[action.type]) : null;
    const warnings = collectWarnings(f);
    const warnCodes = new Set(warnings.map(w => w.code));
    const steps = STEP_DEFS.map(d => ({ id: d.id, label: d.label, state: 'pending', detail: '' }));
    const set = (id, state, detail = '') => {
        const s = steps.find(x => x.id === id);
        s.state = state;
        s.detail = detail;
    };

    // check
    if (f.health && (f.health.state !== 'other' || f.portOwner)) {
        set('check', warnCodes.has('recording-unknown') || warnCodes.has('config') ? 'warn' : 'done',
            f.health.state === 'ours' ? '後端已在執行' : '');
    }
    // database
    const dbOk = (f.db && f.db.reachable) || (f.dbAfterCompose && f.dbAfterCompose.reachable);
    if (dbOk) {
        const how = f.compose && f.compose.ok ? (f.dockerLaunch && f.dockerLaunch.ok ? '已開啟 Docker Desktop 並啟動容器' : '已啟動容器') : '已在執行';
        set('database', warnCodes.has('recording') ? 'warn' : 'done', how);
    }
    // ai
    if (f.ollamaNeed) {
        const aiWarn = AI_WARNING_CODES.some(c => warnCodes.has(c));
        if (!f.ollamaNeed.needed) {
            set('ai', aiWarn ? 'warn' : 'skipped', aiWarn ? '有警告，見下方' : '目前的模型設定不需要 Ollama');
        } else if (f.ollamaWait || (f.ollamaLaunch && !f.ollamaLaunch.ok) || (f.ollama && f.ollama.reachable)) {
            set('ai', aiWarn ? 'warn' : 'done', aiWarn ? '有警告，見下方' : (f.ollamaLaunch && f.ollamaLaunch.ok ? '已開啟 Ollama' : '已在執行'));
        }
    }
    // migrations
    if (f.migrations) {
        const mWarn = MIGRATION_WARNING_CODES.some(c => warnCodes.has(c));
        set('migrations', mWarn ? 'warn' : 'done', mWarn ? '有警告，見下方' : (f.migrations.latest ? `最新（${f.migrations.latest}）` : '最新'));
    }
    // server
    if (f.health && f.health.state === 'ours') {
        set('server', 'done', '已在執行');
    } else if (f.serverWait && f.serverWait.ready) {
        set('server', warnCodes.has('server-db-degraded') ? 'warn' : 'done', f.server && f.server.pid ? `PID ${f.server.pid}` : '');
    }
    // window
    if (action && (action.type === 'finish' || action.type === 'open-app')) set('window', 'running', '轉到系統首頁…');

    if (current) {
        const s = steps.find(x => x.id === current);
        if (action.type === 'fail') {
            s.state = 'error';
            s.detail = action.title || '';
        } else if (s.state === 'pending') {
            s.state = 'running';
            s.detail = RUNNING_TEXT[action.type] || '';
        } else if (s.state !== 'warn' && action.type !== 'finish' && action.type !== 'open-app') {
            s.state = 'running';
            s.detail = RUNNING_TEXT[action.type] || s.detail;
        }
    }
    return steps;
}

/**
 * 失敗代碼 → 它屬於哪一步。
 * @param {string} code
 * @param {Facts} [f] port-in-use 在後端那一步才發現（EADDRINUSE）時歸「啟動後端」
 */
function stepOfFailure(code, f = {}) {
    switch (code) {
        case 'port-in-use': return f.serverWait ? 'server' : 'check';
        case 'port-reserved': return 'server';
        case 'server-busy': case 'env-missing': case 'modules-missing': case 'db-url-missing': return 'check';
        case 'recording-db-down': case 'docker-not-found': case 'docker-launch-failed':
        case 'docker-timeout': case 'compose-failed': case 'db-unreachable': return 'database';
        case 'server-spawn-failed': case 'server-exited': case 'server-timeout': return 'server';
        default: return 'check';
    }
}

module.exports = {
    nextAction, isTerminal, fail, failureMessage, collectWarnings, describeSteps, stepOfFailure, portHeldByOther,
    STEP_DEFS, STEP_OF_ACTION, RUNNING_TEXT, TERMINAL, AI_WARNING_CODES, MIGRATION_WARNING_CODES, UPGRADE_DOC, LAUNCHER_DOC, EXCLUDED_PORTS_CMD,
    UNFINISHED_WORK_NOTE
};
