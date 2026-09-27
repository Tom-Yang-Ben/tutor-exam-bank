#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// desktop/test/smoke/run.js — 在 Linux 的 xvfb 上跑真的桌面版（npm run smoke [-- 情境…]）
//
// 前提（跟平常開桌面版一樣）：exam_pro/.env 存在、exam_pro/node_modules 裝好、.env 的 DATABASE_URL 連得上、
// desktop/node_modules 裝好（npm ci；Electron 44 起第一次執行時才下載執行檔，這支會先確認）。
// 在雲端（root、沒有 GPU）要加 --no-sandbox 與 --disable-gpu，這兩個參數只在冒煙測試用。
//
// 驗的是只有真的 Electron 才驗得到的接線（情境見 hook.js）：utilityProcess 開後端、啟動畫面轉到首頁、同源 POST 過 CORS、
// utilityProcess 裡載得起 sharp／@node-rs/jieba／mupdf（native-probe.js）、
// 權限處理器、Blob 下載走 will-download、導覽與開新視窗的防護、單一實例、關視窗與系統匣的結束流程、
// 後端被殺掉時自動重開一次再停下、後端子行程沒有殘留、Chromium 沒有嘗試連到本機以外（執行期零外連，見 startEgressTrap）。
// Windows 專屬的部分（系統匣氣球、另存新檔對話框、捷徑、Docker Desktop、OCR 的 python）這裡驗不到，
// 列在 docs/desktop-app-design.md 第 6.2 節的 Owner 驗收步驟。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DESKTOP = path.resolve(__dirname, '..', '..');
// 對話框的重跑範圍沿用桌面啟動器 A 的那一句（現行 jobRunner 的行為；DA-13 的檢查點合併後 A 改寫，這裡跟著變）
const { UNFINISHED_WORK_NOTE } = require(path.join(DESKTOP, 'lib', 'decisions'));
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240_000;
const ALL = ['basic', 'busy', 'wait', 'abandon', 'crash'];

function electronPath() {
    // require('electron') 在沒有執行檔時會先下載（Electron 44 起不在 npm install 時下載）
    return require(path.join(DESKTOP, 'node_modules', 'electron'));
}

function readEvents(file) {
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (_) {
        return [];
    }
}

/**
 * 執行期零外連（docs/local-mode.md 第 1 條；docs/desktop-app-design.md 1.1 第 2 點）：Chromium 自己也可能往外連
 * （例如預設會從 Google 的 CDN 下載拼字字典，main.js 的 setupSession 已經擋掉）。冒煙測試把 Electron 的代理伺服器指到
 * 這個本機的「陷阱」：本機迴路（127.0.0.1、localhost）照 Chromium 的預設不走代理，所以後端與啟動畫面不受影響；
 * 任何要連到本機以外的請求都會先到這裡，記下來、回 403，檢查時必須一筆都沒有。
 * 只看得到 Chromium 那一層（主行程、畫面、網路服務）；後端（utilityProcess 的 Node）本來就只連本機的 Ollama 與資料庫。
 */
function startEgressTrap() {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(403); res.end(); });
    srv.on('connect', (req, socket) => { hits.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
    return new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, hits, close: () => new Promise(r => srv.close(() => r())) }));
    });
}

function launch(exe, env, trapPort) {
    // --use-fake-device-for-media-stream：xvfb 沒有麥克風與攝影機，沒有裝置時 getUserMedia 在問權限之前就失敗（NotFoundError），
    // 驗不到權限處理器；假裝置讓它真的走到 setPermissionRequestHandler（不用 --use-fake-ui-for-media-stream：那會跳過權限判斷）。
    // --proxy-server：往外的連線都送到本機的陷阱（startEgressTrap），驗「執行期零外連」。
    const args = ['-a', exe, DESKTOP, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream',
        `--proxy-server=http://127.0.0.1:${trapPort}`];
    const child = spawn('xvfb-run', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, output: () => output })));
    return { child, exited };
}

/** 後端子行程（或這次的 utility process）還在不在 */
function leftovers(userData) {
    const ps = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout || '';
    return ps.split('\n').filter(l => l.includes(path.join(DESKTOP, 'backend-entry.js')) || (l.includes(userData) && /--type=utility/.test(l)));
}

async function runScenario(exe, name) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `desktop-smoke-${name}-`));
    const eventsFile = path.join(work, 'events.jsonl');
    const userData = path.join(work, 'user-data');
    const env = {
        ...process.env,
        // Linux 的 Chromium 用 locale 的編碼當檔名編碼：C locale 下中文檔名表示不了，下載的檔名會退回「download」
        // （2026-09-27 實測；Windows 的路徑是 UTF-16，不受影響〔推論〕，仍列在 Owner 驗收）。冒煙測試一律用 UTF-8 locale。
        LANG: process.env.LANG && /utf-?8/i.test(process.env.LANG) ? process.env.LANG : 'C.UTF-8',
        LC_ALL: process.env.LC_ALL && /utf-?8/i.test(process.env.LC_ALL) ? process.env.LC_ALL : 'C.UTF-8',
        TUTOR_DESKTOP_SMOKE: eventsFile,
        TUTOR_DESKTOP_SMOKE_SCENARIO: name,
        TUTOR_DESKTOP_USER_DATA: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const trap = await startEgressTrap();
    const first = launch(exe, env, trap.port);
    const started = Date.now();
    let second = null;
    let result = null;
    first.exited.then(r => { result = r; });
    while (!result && Date.now() - started < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 500));
        if (name === 'basic' && !second && readEvents(eventsFile).some(e => e.type === 'scenario-done')) second = launch(exe, env, trap.port);
    }
    if (!result) {
        first.child.kill('SIGKILL');
        result = await first.exited;
        result.timedOut = true;
    }
    const secondResult = second ? await second.exited : null;
    await new Promise(r => setTimeout(r, 500));
    const left = leftovers(userData);
    if (left.length) spawnSync('pkill', ['-9', '-f', path.join(DESKTOP, 'backend-entry.js')]);
    await trap.close();
    return { name, events: readEvents(eventsFile), result, secondResult, left, egress: [...trap.hits], elapsedMs: Date.now() - started, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** 每個情境要成立的事 */
function checksFor(r) {
    const ev = r.events;
    const get = (type, pred = () => true) => ev.find(e => e.type === type && pred(e)) || null;
    const all = type => ev.filter(e => e.type === type);
    const out = [];
    const check = (name, ok, detail) => out.push({ name, ok: Boolean(ok), detail });
    const startup = get('startup');
    const exitOk = r.result.code === 0 && !r.result.timedOut;
    check('啟動成功、視窗載入系統首頁（http://127.0.0.1:<埠>/）', startup && startup.ok && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(startup.appUrl) && get('app-loaded'), startup);
    check('沒有情境內的錯誤', !get('scenario-error'), get('scenario-error'));

    if (r.name === 'basic') {
        const page = get('page');
        check('首頁的來源是 127.0.0.1、是安全來源（麥克風按鈕才會出現）', page && /^http:\/\/127\.0\.0\.1:\d+$/.test(page.origin) && page.secure === true, page);
        const post = get('post');
        check('同源 POST 沒有被 CORS 擋成 500（ALLOWED_ORIGINS 放行了執行期的埠）', post && typeof post.status === 'number' && post.status !== 500, post);
        check('健康檢查回 tutor-exam-bank/ok（資料庫連得上）', post && post.health === 'tutor-exam-bank/ok', post);
        const native = get('native');
        check('utilityProcess 裡載得起後端的 sharp、@node-rs/jieba、mupdf（Linux 版二進位；R-6）', native && native.sharp === 'ok' && native.jieba === 'ok' && native.mupdf === 'ok' && native.code === 0, native);
        const perm = get('perm');
        check('權限：麥克風 granted；攝影機、定位、通知 denied', perm && perm.microphone === 'granted' && perm.camera === 'denied' && perm.geolocation === 'denied' && perm.notifications === 'denied', perm);
        const gum = get('gum');
        check('getUserMedia（假裝置）：攝影機被權限處理器拒絕（NotAllowedError），麥克風拿得到', gum && gum.video === 'NotAllowedError' && gum.audio === 'ok', gum);
        const permReq = all('permission-request');
        check('權限請求：只有聲音被放行', permReq.length > 0 && permReq.every(p => p.ok === (p.permission === 'media' && Array.isArray(p.mediaTypes) && p.mediaTypes.every(t => t === 'audio'))), permReq);
        const dl = get('download-start');
        check('Blob 下載走 will-download：檔名是 download 屬性、預設資料夾是「文件/出卷」、類型列 Word 文件', dl && dl.filename === '冒煙測試段考（學生版）.docx' &&
            /[/\\]出卷[/\\]冒煙測試段考（學生版）\.docx$/.test(dl.defaultPath) && dl.filters && dl.filters[0] && dl.filters[0].name === 'Word 文件' && dl.title === '另存新檔', dl);
        const dd = get('download-done');
        const df = get('download-file');
        check('下載完成、檔案寫出來了', dd && dd.state === 'completed' && df && df.exists && df.size > 0, { dd, df });
        const nav = get('nav');
        check('導覽到 file: 與本機別的埠被擋下、window.open 不開新視窗', nav && startup && nav.url === startup.appUrl && nav.popup === true, nav);
        const si = get('second-instance');
        check('第二個實例：自己馬上結束（結束碼 0），第一個收到 second-instance 並把視窗叫到前面', r.secondResult && r.secondResult.code === 0 && si && si.decision === 'focus', { second: r.secondResult && r.secondResult.code, si });
        const wc = get('window-close');
        check('沒有背景工作時關視窗：直接結束（DA-2＝3）', wc && wc.action === 'quit', wc);
        const be = all('backend-exit');
        check('後端是被要求結束的（expected），結束碼 0', be.length === 1 && be[0].expected === true && be[0].code === 0, be);
        const q = get('quit');
        check('結束方式 graceful，Electron 結束碼 0', q && q.mode === 'graceful' && exitOk, { q, code: r.result.code, timedOut: r.result.timedOut });
    }

    if (r.name === 'busy') {
        const qse = get('query-session-end');
        check('主行程收到 query-session-end（假裝關機被取消，之後沒有 session-end）', qse && qse.handled === true, qse);
        const wc = get('window-close');
        check('有 2 件在途工作時關視窗（就算剛才問過要不要關機）：縮到系統匣（hide／busy），不是直接放棄', wc && wc.action === 'hide' && wc.reason === 'busy' && wc.inFlight === 2, wc);
        check('跳通知「出題系統仍在背景處理」', get('notify', n => n.title === '出題系統仍在背景處理'), all('notify'));
        const ac = get('after-close');
        check('視窗藏起來了（沒有被關掉）', ac && ac.visible === false && ac.destroyed === false, ac);
        const cleared = get('busy-cleared');
        const done = get('done');
        check('工作歸零後，持續 10 秒以上才算處理完', cleared && done && done.t - cleared.t >= 10_000 && done.t - cleared.t < 30_000, { cleared, done });
        check('跳通知「背景工作都處理完了」', get('notify', n => n.title === '背景工作都處理完了'), all('notify'));
        const q = get('quit');
        check('處理完後自動結束（graceful），Electron 結束碼 0', q && q.mode === 'graceful' && exitOk && q.t - done.t >= 7_000, { q, code: r.result.code });
        const be = all('backend-exit');
        check('後端是被要求結束的（expected）', be.length === 1 && be[0].expected === true, be);
    }

    if (r.name === 'wait' || r.name === 'abandon') {
        const dlg = get('dialog');
        check('系統匣「結束」有工作 → 跳對話框：三個按鈕、寫明重跑範圍與租約', dlg && dlg.title === '結束出題系統' && JSON.stringify(dlg.buttons) === JSON.stringify(['等處理完再結束', '現在放棄', '取消']) &&
            /背景還有 1 件工作在處理/.test(dlg.message) && dlg.detail.includes(UNFINISHED_WORK_NOTE) && /租約/.test(dlg.detail) && /不會用掉重試次數/.test(dlg.detail), dlg);
        const q = get('quit');
        check(`結束方式是 ${r.name}，Electron 結束碼 0`, q && q.mode === r.name && exitOk, { q, code: r.result.code });
        const be = all('backend-exit');
        check('後端是被要求結束的（expected）', be.length === 1 && be[0].expected === true, be);
        if (r.name === 'wait') {
            check('通知「正在結束出題系統」與「背景工作處理完了」', get('notify', n => n.title === '正在結束出題系統') && get('notify', n => n.title === '背景工作處理完了'), all('notify'));
        } else {
            check('放棄時不跳「處理完了」', !get('notify', n => n.title === '背景工作處理完了'), all('notify'));
        }
    }

    if (r.name === 'crash') {
        const be = all('backend-exit');
        check('後端被殺掉兩次，兩次都不是桌面版要它結束的', be.filter(e => e.expected === false).length === 2, be);
        check('第一次：通知「後端異常結束，正在重新啟動」並重開（第二次載入首頁，換了埠）', get('notify', n => n.title === '後端異常結束，正在重新啟動') &&
            all('app-loaded').length === 2 && all('app-loaded')[0].url !== all('app-loaded')[1].url, { notify: all('notify'), loaded: all('app-loaded') });
        const fp = get('failure-page');
        check('第二次：不再重開，視窗顯示「後端一直異常結束」', fp && fp.heading === '後端一直異常結束', fp);
        const wc = get('window-close');
        check('失敗之後關視窗：直接結束，Electron 結束碼 0', wc && wc.action === 'quit' && exitOk, { wc, code: r.result.code });
    }

    check('沒有殘留的後端子行程', r.left.length === 0, r.left);
    check('Chromium 沒有嘗試連到本機以外（執行期零外連；例如拼字字典的下載）', r.egress.length === 0, r.egress);
    return out;
}

async function main() {
    const exe = electronPath();
    const names = process.argv.slice(2).filter(a => ALL.includes(a));
    const scenarios = names.length ? names : ALL;
    console.log(`Electron：${exe}\n情境：${scenarios.join('、')}`);
    let failed = 0;
    let total = 0;
    for (const name of scenarios) {
        const r = await runScenario(exe, name);
        const checks = checksFor(r);
        console.log(`\n── ${name}（${Math.round(r.elapsedMs / 1000)} 秒）──`);
        for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n      ${JSON.stringify(c.detail)}`}`);
        const bad = checks.filter(c => !c.ok).length;
        failed += bad;
        total += checks.length;
        if (bad) {
            console.log('\n  Electron 輸出（最後 40 行，已濾掉 dbus 訊息）：');
            console.log(String(r.result.output()).split('\n').filter(l => !/dbus/.test(l)).slice(-40).map(l => `    ${l}`).join('\n'));
            console.log('\n  事件：');
            for (const e of r.events) console.log(`    ${JSON.stringify(e)}`);
        }
        if (process.env.SMOKE_PRINT_WARNINGS) {
            const s = r.events.find(e => e.type === 'startup');
            console.log(`  啟動時的警告：${JSON.stringify(s ? s.warnings : null)}`);
        }
        r.cleanup();
    }
    console.log(`\n${total - failed}/${total} 通過`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
