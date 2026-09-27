// ─────────────────────────────────────────────────────────────
// desktop/main.js — 出題系統桌面版（B1：Electron 殼＋內嵌後端，資料庫仍用 Docker）的主行程
//
// 設計：docs/desktop-app-design.md（第 2 節架構、第 6.2 節 B1）；Owner 第六輪決策 DA-2＝3、DA-3＝2、DA-6＝1、DA-11＝1。
//   - 單一實例：第二次開啟只把原本的視窗叫到前面（app.requestSingleInstanceLock）。
//   - 啟動：沿用桌面啟動器 A 的檢查（Docker／資料庫、Ollama、migration），進度顯示在同一個視窗的啟動畫面；
//     後端用 utilityProcess 開 desktop/backend-entry.js（exam_pro/startServer.js，只綁 127.0.0.1、空埠），
//     完成後視窗載入 http://127.0.0.1:<埠>/——就是現在那一套 public/，前端一行不改。
//   - 關視窗、系統匣、結束、後端異常結束：規則在 lib/decisions.js（純函式，有單元測試）；這裡只照結果做。
//   - Word 下載跳「另存新檔」（lib/downloads.js）；權限只放行自己的來源要麥克風（lib/security.js）。
//   - 記錄檔：exam_pro\data\logs\desktop-日期.log（這裡）與 desktop-server-日期.log（後端）。
// 本檔只做 Electron 的接線；能在沒有 Electron 的環境測的邏輯都在 lib/，由 desktop/test/ 測。
//
// 另外兩種執行方式（exam_pro\scripts\windows\install_desktop_app.bat 用）：
//   electron.exe <desktop 資料夾> --install-shortcut   在桌面建立「出題系統（桌面版）」捷徑後結束
//   electron.exe <desktop 資料夾> --remove-shortcut    移除那個捷徑後結束
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { app, BrowserWindow, Tray, Menu, dialog, shell, session, utilityProcess, nativeImage, Notification, screen } = require('electron');

const { desktopPaths, userDataDir } = require('./lib/paths');
const D = require('./lib/decisions');
const { logFiles, createLogger, pruneLogs } = require('./lib/logs');
const { parseEnvText, effectiveEnv, leaseMsOf, portFromEnv } = require('./lib/config');
const security = require('./lib/security');
const downloads = require('./lib/downloads');
const uiLib = require('./lib/ui');
const { adaptStatusHtml, desktopFailure } = require('./lib/wording');
const { createStatusUi } = require('./lib/statusUi');
const { createBackendHost } = require('./lib/backendHost');
const { createDesktopActions, runStartup } = require('./lib/startup');
const { pickFreePort } = require('./lib/net');

const P = desktopPaths();
/** 桌面啟動器 A 的模組（exam_pro/scripts/desktop/lib/*） */
const requireA = name => require(path.join(P.launcherLib, name));

/** 發生了什麼（冒煙測試 desktop/test/smoke 掛在這裡；平常沒有人聽） */
const events = new EventEmitter();

// Chromium 的設定檔放 %LOCALAPPDATA%\TutorExamBank\electron（DA-1＝2）；一定要在 ready 與單一實例鎖之前設
const ud = userDataDir(process.env, process.platform);
if (ud) app.setPath('userData', ud);

const argv = process.argv.slice(1);
const shortcutMode = argv.includes('--install-shortcut') ? 'install' : (argv.includes('--remove-shortcut') ? 'remove' : null);

if (shortcutMode) {
    app.whenReady()
        .then(() => runShortcutMode(shortcutMode))
        .then(code => app.exit(code), err => { console.error(err && err.stack ? err.stack : err); app.exit(1); });
} else if (!app.requestSingleInstanceLock()) {
    // 已經有一個在跑：它會收到 second-instance，把視窗叫到前面；這一個直接結束
    app.quit();
} else {
    startApp();
}

// ─────────────────────────── 捷徑 ───────────────────────────

function runShortcutMode(mode) {
    if (process.platform !== 'win32') {
        console.log('只有 Windows 需要建立桌面捷徑。');
        return 1;
    }
    const spec = uiLib.shortcutSpec({
        desktopFolder: app.getPath('desktop'),
        electronExe: process.execPath,
        desktopDir: P.desktopDir,
        icon: P.icon
    });
    if (mode === 'remove') {
        const existed = fs.existsSync(spec.file);
        fs.rmSync(spec.file, { force: true });
        console.log(existed ? `已移除：${spec.file}` : `本來就沒有：${spec.file}`);
        return 0;
    }
    const ok = shell.writeShortcutLink(spec.file, 'create', spec.options);
    console.log(ok ? `已建立：${spec.file}` : `建立失敗：${spec.file}`);
    return ok ? 0 : 1;
}

// ─────────────────────────── 主程式 ───────────────────────────

function startApp() {
    const files = logFiles(P.logsDir, new Date());
    const log = createLogger({ file: files.main, echo: Boolean(process.env.TUTOR_DESKTOP_ECHO_LOG) });
    const stateFile = () => path.join(app.getPath('userData'), 'desktop-state.json');
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /** starting：啟動中；running：後端開好了；failed：啟動失敗或後端一直異常結束 */
    let phase = 'starting';
    let quitting = false;
    let draining = false;       // 選了「等處理完再結束」
    let abandoned = false;
    let sessionEnding = false;
    let allowClose = false;
    let closeRequested = false; // 關了視窗、縮到系統匣等工作處理完
    let checkingClose = false;
    let lastStatus = null;
    let zeroSince = null;
    let crashes = [];
    let pollTimer = null;
    let polling = false;
    let doneQuitTimer = null;
    let leaseMs = 180000;
    let run = 0;
    let saved = {};
    let lastTrayText = '';
    /** 這一輪啟動的 plan context（appUrl 在後端開好時填上） */
    let currentCtx = null;
    let win = null;
    let tray = null;
    let ui = null;
    let host = null;

    if (process.env.TUTOR_DESKTOP_SMOKE) {
        // 冒煙測試（desktop/test/smoke）：看事件、代替 Owner 點系統匣選單。平常不會載入
        require('./test/smoke/hook').install({ app, events, getWindow: () => win, getHost: () => host, log });
        events.on('smoke:tray', id => onTrayItem(id));
    }

    process.on('uncaughtException', err => {
        log(`！未預期的錯誤：${(err && err.stack) || err}`);
        try { dialog.showErrorBox('出題系統（桌面版）發生錯誤', `${(err && err.message) || err}\n\n記錄檔：${files.main}`); } catch (_) { /* 忽略 */ }
    });

    app.on('second-instance', () => {
        if (!app.isReady()) return;
        const d = D.decideSecondInstance({ quitting });
        log(`第二次開啟 → ${d}`);
        events.emit('second-instance', d);
        if (d === 'focus') showWindow();
        else notify(D.quittingNotice(draining));
    });

    // 視窗全部關掉不等於結束（有工作時縮在系統匣）；什麼時候結束由 quitApp 決定
    app.on('window-all-closed', () => { });

    app.on('before-quit', e => {
        if (!quitting && host && host.alive) {
            e.preventDefault();
            quitApp('graceful');
        }
    });

    app.whenReady().then(async () => {
        if (process.platform === 'win32') app.setAppUserModelId(D.AUMID);
        saved = uiLib.readState(stateFile());
        log(`==== 桌面版開始（Electron ${process.versions.electron}、Node ${process.versions.node}；exam_pro：${P.appDir}）====`);
        const pruned = pruneLogs(P.logsDir);
        if (pruned.length) log(`刪掉超過 14 天的記錄檔：${pruned.join('、')}`);

        Menu.setApplicationMenu(Menu.buildFromTemplate(uiLib.appMenuTemplate()));
        setupSession(session.defaultSession);
        createTray();
        createWindow();

        host = createBackendHost({
            fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
            entryPath: P.backendEntry,
            cwd: P.appDir,
            serviceName: 'TutorExamBank backend',
            openLog: () => {
                fs.mkdirSync(P.logsDir, { recursive: true });
                return fs.createWriteStream(files.server, { flags: 'a' });
            },
            log
        });
        host.onExit(onBackendExit);

        const { startStatusServer } = requireA('statusServer');
        ui = createStatusUi({
            startStatusServer,
            html: adaptStatusHtml(fs.readFileSync(P.statusHtml, 'utf8')),
            showUrl: loadInWindow,
            logs: { launcher: files.main, server: files.server },
            log
        });
        events.emit('ready');
        await startup();
    }).catch(err => {
        log(`！啟動時發生未預期的錯誤：${(err && err.stack) || err}`);
        dialog.showErrorBox('出題系統（桌面版）無法啟動', `${(err && err.message) || err}\n\n記錄檔：${files.main}`);
        app.exit(1);
    });

    // ─────────── 啟動（沿用 A 的 plan）───────────

    async function startup() {
        const mine = ++run;
        phase = 'starting';
        lastStatus = null;
        updateTray();
        ui.reset();

        const { createSystem } = requireA('system');
        const { appPaths, createProbes } = requireA('probes');
        const { readConfigFile } = requireA('config');
        const { createActions } = requireA('actions');

        const sys = createSystem();
        const paths = appPaths(P.appDir);
        const dotenvVars = parseEnvText(sys.readText(paths.envFile));
        const env = effectiveEnv(dotenvVars, sys.env);
        leaseMs = leaseMsOf(env);
        const { config, warnings: configWarnings, found } = readConfigFile(paths.configFile);
        if (found) log(`啟動設定（與桌面啟動器 A 共用）：${paths.configFile}`);
        const ctx = {
            port: 0,
            appUrl: null,
            nodePath: process.execPath,
            dockerDesktopPath: config.dockerDesktopPath,
            dockerReadyTimeoutSec: config.dockerReadyTimeoutSec,
            ollamaReadyTimeoutSec: config.ollamaReadyTimeoutSec,
            serverReadyTimeoutSec: config.serverReadyTimeoutSec,
            serverLog: files.server,
            launcherLog: files.main
        };
        currentCtx = ctx;
        // host：問桌面版自己的後端時給 127.0.0.1（lib/startup.js 的 OWN_BACKEND_HOST），蓋掉 .env 的 HOST
        const makeProbes = ({ port, host }) => createProbes({ sys, config, env: host ? { ...env, HOST: host } : env, paths, port });
        const base = createActions({ sys, config, env, paths, ctx, ui, probes: makeProbes({ port: portFromEnv(env) }), log });
        const actions = createDesktopActions({
            base, host, sys, makeProbes, dotenvVars, env, config, ctx, ui,
            pickPort: () => pickFreePort(), serverLog: files.server, log
        });
        const r = await runStartup({ actions, ui, ctx, log, facts: configWarnings.length ? { configWarnings } : {} });
        if (mine !== run || quitting) return;
        if (r.ok) {
            phase = 'running';
            startPolling();
        } else {
            phase = 'failed';
            if (host.alive) host.kill();
        }
        updateTray();
        events.emit('startup', { ok: r.ok, appUrl: ctx.appUrl, warnings: r.warnings, failure: r.failure || null });
    }

    // ─────────── 視窗 ───────────

    function allowedOrigins() {
        return [security.originOf(ui && ui.statusUrl), security.originOf(currentCtx && currentCtx.appUrl)].filter(Boolean);
    }

    function currentAppOrigin() {
        return security.originOf(currentCtx && currentCtx.appUrl);
    }

    function createWindow() {
        const areas = screen.getAllDisplays().map(d => d.workArea);
        const b = uiLib.usableBounds(saved.windowBounds, areas);
        win = new BrowserWindow({
            ...(b || uiLib.DEFAULT_BOUNDS),
            minWidth: 900,
            minHeight: 600,
            show: false,
            title: D.SHORTCUT_NAME,
            autoHideMenuBar: true,
            backgroundColor: '#f5f6fa',
            ...(process.platform === 'win32' ? { icon: P.icon } : {}),
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
        });
        if (saved.windowBounds && saved.windowBounds.maximized) win.maximize();
        let shown = false;
        const showOnce = () => { if (!shown && win && !win.isDestroyed() && !closeRequested && !quitting) { shown = true; win.show(); } };
        win.once('ready-to-show', showOnce);
        setTimeout(showOnce, 5000);   // 萬一第一頁一直載不完，也要看得到視窗

        win.on('close', onWindowClose);
        win.on('closed', () => { win = null; });
        // Windows 登出、關機：不擋、不問；後端直接結束（與當機同一條路：不寫結果、不動重試次數）
        win.on('query-session-end', () => { sessionEnding = true; log('Windows 要登出或關機'); });
        win.on('session-end', () => {
            sessionEnding = true; quitting = true; allowClose = true;
            log('Windows 登出或關機：直接結束後端');
            if (host) host.kill();
        });

        const wc = win.webContents;
        wc.on('will-navigate', guardNavigation);
        wc.on('will-redirect', guardNavigation);
        wc.setWindowOpenHandler(({ url }) => {
            if (security.windowOpenDecision(url) === 'external') shell.openExternal(url);
            else log(`擋下開新視窗：${url}`);
            return { action: 'deny' };
        });
        wc.on('did-navigate', (e, url) => {
            if (security.originOf(url) === currentAppOrigin()) {
                log(`視窗載入系統首頁：${url}`);
                events.emit('app-loaded', url);
                // 啟動畫面用完了：關掉它的小伺服器（重開後端時會再起一個）
                if (ui) ui.close().catch(() => { });
            }
        });
        wc.on('context-menu', (e, params) => {
            const t = uiLib.contextMenuTemplate(params);
            if (t && win) Menu.buildFromTemplate(t).popup({ window: win });
        });
        wc.on('render-process-gone', (e, details) => {
            log(`畫面行程結束：${details.reason}（結束碼 ${details.exitCode}）`);
            if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) wc.reload();
        });
    }

    async function loadInWindow(url) {
        if (!win) createWindow();
        try {
            await win.loadURL(url);
        } catch (err) {
            // 載入途中被頁面自己導走（啟動頁完成就轉到首頁）會是 ERR_ABORTED，不算錯
            if (!/ERR_ABORTED/.test(String(err && err.message))) log(`載入 ${url} 失敗：${err && err.message}`);
        }
    }

    /** will-navigate／will-redirect：Electron 44 的網址在 details.url（第二個參數是已棄用的舊寫法，留著當退路） */
    function guardNavigation(e, legacyUrl) {
        const url = (e && typeof e.url === 'string' && e.url) || legacyUrl;
        const d = security.navigationDecision(url, allowedOrigins());
        if (d === 'allow') return;
        e.preventDefault();
        log(`擋下導覽：${url}（${d === 'external' ? '外部網址，改用預設瀏覽器開' : '不是自己的來源'}）`);
        if (d === 'external') shell.openExternal(url);
    }

    function saveBounds() {
        if (!win || win.isDestroyed()) return;
        const maximized = win.isMaximized();
        const b = maximized ? win.getNormalBounds() : win.getBounds();
        saved.windowBounds = { ...b, maximized };
        uiLib.writeState(stateFile(), saved);
    }

    function showWindow() {
        if (quitting) { notify(D.quittingNotice(draining)); return; }
        closeRequested = false;
        zeroSince = null;
        if (doneQuitTimer) { clearTimeout(doneQuitTimer); doneQuitTimer = null; }
        if (!win) {
            createWindow();
            const url = phase === 'running' && currentCtx && currentCtx.appUrl ? currentCtx.appUrl : ui && ui.statusUrl;
            if (url) loadInWindow(url);
        }
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        updateTray();
    }

    /** 右上角 X（DA-2＝3） */
    function onWindowClose(e) {
        saveBounds();
        if (allowClose) return;
        e.preventDefault();
        if (checkingClose) return;
        checkingClose = true;
        (async () => {
            const status = phase === 'running' && host && host.alive ? await host.status({ timeoutMs: D.STATUS_TIMEOUT_MS }) : null;
            const d = D.decideWindowClose({ phase, quitting, sessionEnding, status });
            log(`關視窗：${JSON.stringify(d)}（在途工作 ${status ? status.inFlight : '不明'}）`);
            events.emit('window-close', d);
            if (d.action === 'close') {
                // 已經在結束中（quitApp 會自己收尾），或 Windows 正在登出／關機（不等、不問，與當機同一條路）
                await quitApp(sessionEnding ? 'abandon' : 'graceful');
            } else if (d.action === 'hide') {
                closeRequested = true;
                zeroSince = null;
                if (win) win.hide();
                notify(D.hideNotice(d));
            } else {
                await quitApp('graceful');
            }
        })().catch(err => log(`關視窗時出錯：${(err && err.stack) || err}`)).finally(() => {
            checkingClose = false;
            updateTray();
        });
    }

    // ─────────── 結束 ───────────

    /**
     * @param {'graceful'|'wait'|'abandon'} mode
     *   graceful：沒有工作時（最多等剛認領到的 10 秒）；wait：等處理完再結束（最多 6 小時）；abandon：現在放棄
     */
    async function quitApp(mode) {
        if (quitting) {
            if (mode === 'abandon' && host) {
                abandoned = true;
                log('改成「現在放棄」');
                await host.abandon({ killAfterMs: D.KILL_AFTER_MS });
            }
            return;
        }
        quitting = true;
        draining = mode === 'wait';
        abandoned = mode === 'abandon';
        if (doneQuitTimer) { clearTimeout(doneQuitTimer); doneQuitTimer = null; }
        if (win && !win.isDestroyed()) { saveBounds(); win.hide(); }
        updateTray();
        log(`結束（${mode}）`);
        try {
            if (host && host.alive) {
                if (mode === 'wait') {
                    const r = await host.shutdown({ graceMs: D.WAIT_ALL_MS, killAfterMs: D.KILL_AFTER_MS });
                    log(`等處理完：後端已結束（結束碼 ${r.code}）`);
                    if (!abandoned) {
                        notify(D.drainedNotice());
                        await sleep(D.DONE_QUIT_DELAY_MS);
                    }
                } else if (mode === 'abandon') {
                    await host.abandon({ killAfterMs: D.KILL_AFTER_MS });
                } else {
                    await host.shutdown({ graceMs: D.QUIT_GRACE_MS, killAfterMs: D.KILL_AFTER_MS });
                }
            }
        } catch (err) {
            log(`結束後端時出錯：${(err && err.stack) || err}`);
            if (host) host.kill();
        } finally {
            stopPolling();
            if (ui) await ui.close().catch(() => { });
            allowClose = true;
            log('==== 桌面版結束 ====');
            events.emit('quit', { mode });
            app.quit();
        }
    }

    /** 系統匣的「結束」（DA-2＝3：有工作就問） */
    async function onTrayQuit() {
        if (quitting) return;
        const status = phase === 'running' && host && host.alive ? await host.status({ timeoutMs: D.STATUS_TIMEOUT_MS }) : null;
        if (D.decideTrayQuit({ phase, status }) === 'quit') { await quitApp('graceful'); return; }
        const dlg = D.quitDialog({ inFlight: status ? status.inFlight : null, leaseMs });
        const opts = { type: dlg.type, title: dlg.title, message: dlg.message, detail: dlg.detail, buttons: dlg.buttons, defaultId: dlg.defaultId, cancelId: dlg.cancelId, noLink: dlg.noLink };
        const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
        const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        const choice = dlg.choices[response] || 'cancel';
        log(`系統匣「結束」：在途工作 ${status ? status.inFlight : '不明'}，選「${dlg.buttons[response] || '取消'}」`);
        if (choice === 'wait') {
            notify(D.drainingNotice(status ? status.inFlight : null));
            await quitApp('wait');
        } else if (choice === 'abandon') {
            await quitApp('abandon');
        }
    }

    // ─────────── 後端狀態、異常結束 ───────────

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(pollOnce, D.STATUS_POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function pollOnce() {
        if (polling || !host || !host.alive) return;
        if (phase !== 'running' && !(quitting && draining)) return;
        polling = true;
        try {
            const s = await host.status({ timeoutMs: D.STATUS_TIMEOUT_MS });
            lastStatus = s;
            updateTray();
            if (closeRequested && !quitting) {
                const r = D.nextDoneState({ zeroSince, now: Date.now(), status: s });
                zeroSince = r.zeroSince;
                if (r.done && !doneQuitTimer) {
                    log('縮在系統匣的背景工作都處理完了，稍後自動結束');
                    notify(D.doneNotice());
                    events.emit('done');
                    doneQuitTimer = setTimeout(async () => {
                        doneQuitTimer = null;
                        if (!closeRequested || quitting) return;
                        // 通知跳出之後這幾秒又認領到工作（佇列裡還有排隊的）：不結束，繼續在系統匣等
                        const again = host && host.alive ? await host.status({ timeoutMs: D.STATUS_TIMEOUT_MS }) : null;
                        if (again && again.inFlight > 0) {
                            log(`又有 ${again.inFlight} 件工作開始處理，繼續在系統匣等`);
                            zeroSince = null;
                            return;
                        }
                        quitApp('graceful');
                    }, D.DONE_QUIT_DELAY_MS);
                }
            }
        } finally {
            polling = false;
        }
    }

    function onBackendExit({ code, expected }) {
        events.emit('backend-exit', { code, expected });
        const d = D.decideBackendExit({ phase, quitting, expected, closeRequested, crashes, now: Date.now() });
        crashes = d.crashes;
        if (d.action === 'ignore') return;
        log(`後端異常結束（結束碼 ${code}）→ ${d.action}`);
        stopPolling();
        lastStatus = null;
        if (d.action === 'quit') {
            notify(D.crashQuitNotice(files.server));
            quitApp('graceful');
            return;
        }
        if (d.action === 'restart') {
            notify(D.crashRestartNotice(leaseMs));
            showWindow();
            startup().catch(err => log(`重開後端時出錯：${(err && err.stack) || err}`));
            return;
        }
        // give-up：顯示原因，不再重開
        phase = 'failed';
        updateTray();
        const failure = desktopFailure({ code: 'backend-crashed' }, {}, currentCtx || {}, {
            crashCount: crashes.length, exitCode: code, logTail: host.tail.split(/\r?\n/).filter(l => l.trim()).slice(-25).join('\n')
        });
        (async () => {
            ui.reset();
            await ui.openStatusWindow();
            await ui.fail(failure, []);
        })().catch(err => log(`顯示後端錯誤時出錯：${err && err.message}`));
        showWindow();
    }

    // ─────────── 系統匣、通知 ───────────

    function createTray() {
        let image = nativeImage.createEmpty();
        if (process.platform === 'win32') {
            const ico = nativeImage.createFromPath(P.icon);
            if (!ico.isEmpty()) image = ico;
        }
        try {
            tray = new Tray(image);
        } catch (err) {
            log(`系統匣圖示建立失敗：${err && err.message}`);
            tray = null;
            return;
        }
        tray.on('click', () => showWindow());
        tray.on('balloon-click', () => showWindow());
        updateTray(true);
    }

    function updateTray(force = false) {
        if (!tray) return;
        const o = { phase, status: lastStatus, quitting, draining };
        const tip = D.trayTooltip(o);
        if (!force && tip === lastTrayText) return;
        lastTrayText = tip;
        tray.setToolTip(tip);
        const template = D.trayMenuModel(o).map(item => (item.type === 'separator'
            ? { type: 'separator' }
            : { label: item.label, enabled: item.enabled, click: () => onTrayItem(item.id) }));
        tray.setContextMenu(Menu.buildFromTemplate(template));
    }

    function onTrayItem(id) {
        log(`系統匣：${id}`);
        switch (id) {
            case 'open': showWindow(); break;
            case 'open-logs': shell.openPath(P.logsDir); break;
            case 'open-data': shell.openPath(P.dataDir); break;
            case 'open-backups':
                if (fs.existsSync(P.backupsDir)) shell.openPath(P.backupsDir);
                else notify({ title: '還沒有備份資料夾', body: `${P.backupsDir} 還不存在（還沒有執行過備份）。` });
                break;
            case 'abandon': quitApp('abandon'); break;
            case 'quit': onTrayQuit().catch(err => log(`結束時出錯：${(err && err.stack) || err}`)); break;
            default: break;
        }
    }

    function notify({ title, body }) {
        log(`[通知] ${title}：${body}`);
        events.emit('notify', { title, body });
        try {
            if (process.platform === 'win32' && tray) {
                // 系統匣氣球（Windows 10/11 會顯示成通知）：不需要開始功能表捷徑或 AppUserModelID 就能跳
                tray.displayBalloon({ title, content: body, iconType: 'info' });
            } else if (Notification.isSupported()) {
                new Notification({ title, body }).show();
            }
        } catch (err) {
            log(`通知跳不出來：${err && err.message}`);
        }
    }

    // ─────────── 權限、下載 ───────────

    function setupSession(ses) {
        // 執行期零外連：不做拼字檢查，拼字字典也不從 Google 的 CDN 下載（lib/security.js 的 SPELLCHECK_DICTIONARY_URL）
        ses.setSpellCheckerEnabled(false);
        ses.setSpellCheckerDictionaryDownloadURL(security.SPELLCHECK_DICTIONARY_URL);
        ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
            const ok = security.permissionRequestDecision({
                permission, appOrigin: currentAppOrigin(),
                requestingUrl: details.requestingUrl, securityOrigin: details.securityOrigin, mediaTypes: details.mediaTypes
            });
            if (!ok) log(`拒絕權限請求：${permission}（${details.requestingUrl || ''}）`);
            events.emit('permission-request', { permission, ok, mediaTypes: details.mediaTypes || null });
            callback(ok);
        });
        ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => security.permissionCheckDecision({
            permission, appOrigin: currentAppOrigin(), requestingOrigin,
            securityOrigin: details.securityOrigin, mediaType: details.mediaType
        }));
        ses.on('will-download', (event, item) => onWillDownload(item));
    }

    function onWillDownload(item) {
        const filename = item.getFilename();
        const opts = downloads.saveDialogOptions({
            filename,
            lastDir: saved.lastDownloadDir,
            documentsDir: app.getPath('documents'),
            exists: p => fs.existsSync(p)
        });
        // 第一次用的「文件\出卷」先建好，對話框才會停在那裡
        try { fs.mkdirSync(path.dirname(opts.defaultPath), { recursive: true }); } catch (_) { /* 忽略 */ }
        item.setSaveDialogOptions(opts);
        log(`下載「${filename}」：跳另存新檔（預設 ${opts.defaultPath}）`);
        events.emit('download-start', { filename, options: opts, item });
        item.once('done', (e, state) => {
            const savePath = item.getSavePath();
            log(state === 'completed' ? `已存檔：${savePath}` : `下載沒有完成（${state}）${savePath ? `：${savePath}` : ''}`);
            if (state === 'completed') {
                const dir = downloads.rememberedDir(savePath);
                if (dir) { saved.lastDownloadDir = dir; uiLib.writeState(stateFile(), saved); }
            }
            events.emit('download-done', { state, savePath });
        });
    }
}
