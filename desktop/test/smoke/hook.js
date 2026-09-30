// ─────────────────────────────────────────────────────────────
// desktop/test/smoke/hook.js — 冒煙測試掛在主行程上的腳本（只有設了 TUTOR_DESKTOP_SMOKE 才會被 main.js 載入）
//
// 由 desktop/test/smoke/run.js 在 Linux 的 xvfb 上跑真的 Electron。每件事寫一行 JSON 到 TUTOR_DESKTOP_SMOKE 指的檔案，
// run.js 讀檔判斷。情境（TUTOR_DESKTOP_SMOKE_SCENARIO）：
//   basic  ：首頁 → 同源 POST 過 CORS、utilityProcess 裡載得起 sharp／jieba／mupdf（native-probe.js）、權限、Blob 下載、
//            導覽與開新視窗的防護 → 等外面開第二個實例 → 關視窗（沒有工作 → 結束）
//   busy   ：假裝後端有 2 件在途工作 → 假裝一次被取消的關機（只有 query-session-end）→ 關視窗（仍縮到系統匣）
//            → 工作歸零 → 10 秒後「處理完了」→ 自動結束
//   wait   ：假裝有 1 件在途 → 系統匣「結束」→ 對話框選「等處理完再結束」→ 後端處理完自己結束 → app 結束
//   abandon：假裝有 1 件在途 → 系統匣「結束」→ 對話框選「現在放棄」→ 馬上結束
//            〔dec/r8-b1-abandon〕記下主行程送給後端的是「放棄」（host.abandon 的 waitMs／killAfterMs），驗後端自己結束（結束碼 0）
//   crash  ：把後端子行程殺掉 → 自動重開一次 → 再殺一次 → 停下來顯示原因 → 關視窗結束
// 「假裝在途工作」只改主行程看到的數字（包一層 host.status），後端本身照常；對話框用假的 showMessageBox 代替 Owner 按鈕。
// 這支不是產品的一部分：B3 打包時不帶 test/。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { dialog, utilityProcess } = require('electron');

function install({ app, events, getWindow, getHost, log }) {
    const out = process.env.TUTOR_DESKTOP_SMOKE;
    const scenario = process.env.TUTOR_DESKTOP_SMOKE_SCENARIO || 'basic';
    // 下載的檔放在這個情境的暫存資料夾裡（事件檔的旁邊），run.js 跑完會整個刪掉
    const downloadDir = fs.mkdtempSync(path.join(path.dirname(out), 'downloads-'));
    const rec = (type, data = {}) => {
        try { fs.appendFileSync(out, `${JSON.stringify({ t: Date.now(), type, ...data })}\n`); } catch (_) { /* 忽略 */ }
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = (name, ms) => new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        events.once(name, v => { clearTimeout(timer); resolve(v === undefined ? true : v); });
    });
    const js = code => getWindow().webContents.executeJavaScript(code, true).catch(err => `error:${err && err.message}`);
    let loadedCount = 0;
    let fakeInFlight = null;

    /** 主行程看到的在途工作數改成 fakeInFlight（null＝照後端回報的） */
    function fakeStatus() {
        const host = getHost();
        const real = host.status;
        host.status = async o => {
            const s = await real(o);
            return s && fakeInFlight !== null ? { ...s, inFlight: fakeInFlight } : s;
        };
    }

    /** 另開一個 utilityProcess 載入後端的 sharp、@node-rs/jieba、mupdf（與後端同一個執行環境；native-probe.js） */
    function probeNative() {
        return new Promise(resolve => {
            let result = null;
            let output = '';
            const child = utilityProcess.fork(path.join(__dirname, 'native-probe.js'), [], { stdio: 'pipe', serviceName: 'TutorExamBank smoke native probe' });
            if (child.stdout) child.stdout.on('data', d => { output += d; });
            if (child.stderr) child.stderr.on('data', d => { output += d; });
            const timer = setTimeout(() => child.kill(), 60000);
            child.on('message', m => { result = m; });
            child.once('exit', code => {
                clearTimeout(timer);
                resolve({ ...(result || {}), code, ...(result ? {} : { output: output.slice(-2000) }) });
            });
        });
    }

    rec('scenario', { name: scenario });
    events.on('ready', () => {
        rec('ready');
        // 啟動畫面有注意事項時（例如雲端沒有 Ollama），替 Owner 按「我知道了，進入出題系統」
        setInterval(async () => {
            const win = getWindow();
            if (!win || win.isDestroyed()) return;
            // 只在啟動畫面（標題有「出題系統」；系統首頁的標題不是）按
            const clicked = await js("(() => { const b = document.getElementById('enter'); if (b && !b.hidden && /出題系統/.test(document.title)) { b.click(); return true; } return false; })()");
            if (clicked === true) rec('clicked-enter');
        }, 1000);
    });
    events.on('startup', s => rec('startup', {
        ok: s.ok, appUrl: s.appUrl, warnings: (s.warnings || []).map(x => x.code), failure: s.failure ? s.failure.code : null
    }));
    events.on('notify', n => rec('notify', n));
    events.on('window-close', d => rec('window-close', d));
    events.on('backend-exit', e => rec('backend-exit', e));
    events.on('second-instance', d => rec('second-instance', { decision: d }));
    events.on('permission-request', p => rec('permission-request', p));
    events.on('done', () => rec('done'));
    events.on('download-start', ({ filename, options, item }) => {
        rec('download-start', { filename, defaultPath: options.defaultPath, filters: options.filters, title: options.title });
        // 冒煙測試沒有人按對話框：直接指定存檔路徑（只有這裡這樣做；產品一律跳另存新檔）
        item.setSavePath(path.join(downloadDir, filename));
    });
    events.on('download-done', d => rec('download-done', d));
    events.on('quit', q => rec('quit', q));
    app.on('will-quit', () => rec('will-quit'));

    events.on('app-loaded', url => {
        loadedCount += 1;
        rec('app-loaded', { url, n: loadedCount });
        const run = SCENARIOS[scenario];
        if (!run) { rec('scenario-error', { message: `沒有這個情境：${scenario}` }); app.exit(3); return; }
        run(loadedCount).catch(err => {
            rec('scenario-error', { message: String((err && err.stack) || err) });
            log(`冒煙測試出錯：${(err && err.stack) || err}`);
            app.exit(3);
        });
    });

    const SCENARIOS = {
        async basic(n) {
            if (n > 1) return;
            const wc = getWindow().webContents;
            await sleep(1500);
            rec('page', { title: await js('document.title'), origin: await js('location.origin'), secure: await js('window.isSecureContext') });
            // 同源的 POST 會帶 Origin 標頭：ALLOWED_ORIGINS 沒放行的話 cors() 丟錯 → 500
            rec('post', {
                status: await js("fetch('/api/confirm-paper', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status, e => 'err:' + e.message)"),
                health: await js("fetch('/api/health').then(r => r.json()).then(j => j.service + '/' + j.status, e => 'err:' + e.message)")
            });
            rec('native', await probeNative());
            rec('perm', {
                microphone: await js("navigator.permissions.query({ name: 'microphone' }).then(p => p.state, e => 'err:' + e.message)"),
                camera: await js("navigator.permissions.query({ name: 'camera' }).then(p => p.state, e => 'err:' + e.message)"),
                geolocation: await js("navigator.permissions.query({ name: 'geolocation' }).then(p => p.state, e => 'err:' + e.message)"),
                notifications: await js("navigator.permissions.query({ name: 'notifications' }).then(p => p.state, e => 'err:' + e.message)")
            });
            rec('gum', {
                video: await js("navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ok'; }, e => e.name)"),
                audio: await js("navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ok'; }, e => e.name)")
            });
            // 和 public/index.html 的 Word 下載同一個寫法：Blob → <a download> → click → 立刻 revoke
            const done = waitFor('download-done', 15000);
            await js(`(() => {
                const blob = new Blob(['PK smoke'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '冒煙測試段考（學生版）.docx';
                document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
                return true; })()`);
            const d = await done;
            rec('download-file', { exists: Boolean(d && d.savePath && fs.existsSync(d.savePath)), size: d && d.savePath && fs.existsSync(d.savePath) ? fs.statSync(d.savePath).size : 0 });
            // 導覽與開新視窗的防護
            await js("location.href = 'file:///etc/hostname'");
            await sleep(800);
            await js("location.href = 'http://127.0.0.1:9/'");
            await sleep(800);
            rec('nav', { url: wc.getURL(), popup: await js("window.open('http://127.0.0.1:9/') === null") });
            rec('scenario-done');
            // 等外面開第二個實例（run.js 看到 scenario-done 才開）
            const second = await waitFor('second-instance', 30000);
            rec('second-seen', { ok: Boolean(second) });
            await sleep(500);
            rec('closing');
            getWindow().close();   // 沒有工作 → 直接結束（DA-2＝3）
        },

        async busy(n) {
            if (n > 1) return;
            await sleep(1000);
            fakeStatus();
            fakeInFlight = 2;
            const win = getWindow();
            // 先假裝一次「關機被取消」：Windows 問了要不要登出或關機（query-session-end），之後被取消（不會再有 session-end）。
            // 回來按 X 還是要照 DA-2＝3 縮到系統匣，不能當成關機直接放棄
            const seen = waitFor('query-session-end', 2000);
            win.emit('query-session-end', { preventDefault() { }, reasons: ['shutdown'] });
            rec('query-session-end', { handled: Boolean(await seen) });
            win.close();   // 有工作 → 縮到系統匣
            await sleep(4000);
            rec('after-close', { visible: win.isVisible(), destroyed: win.isDestroyed() });
            fakeInFlight = 0;
            rec('busy-cleared');
        },

        async wait(n) {
            if (n > 1) return;
            await sleep(1000);
            fakeStatus();
            fakeInFlight = 1;
            dialog.showMessageBox = async (...args) => {
                const o = args.length > 1 ? args[1] : args[0];
                rec('dialog', { title: o.title, message: o.message, detail: o.detail, buttons: o.buttons });
                return { response: 0, checkboxChecked: false };   // 等處理完再結束
            };
            events.emit('smoke:tray', 'quit');
        },

        async abandon(n) {
            if (n > 1) return;
            await sleep(1000);
            fakeStatus();
            fakeInFlight = 1;
            // 〔dec/r8-b1-abandon〕主行程的「現在放棄」要走 host.abandon（送 { shutdown, abandon:true }），不是直接強制結束
            const host = getHost();
            const realAbandon = host.abandon;
            host.abandon = async o => {
                rec('abandon-called', { waitMs: o && o.waitMs, killAfterMs: o && o.killAfterMs });
                return realAbandon(o);
            };
            dialog.showMessageBox = async (...args) => {
                const o = args.length > 1 ? args[1] : args[0];
                rec('dialog', { title: o.title, message: o.message, detail: o.detail, buttons: o.buttons });
                return { response: 1, checkboxChecked: false };   // 現在放棄
            };
            events.emit('smoke:tray', 'quit');
        },

        async crash(n) {
            await sleep(1000);
            if (n <= 2) {
                const pid = getHost().pid;
                rec('kill-backend', { n, pid });
                process.kill(pid, 'SIGKILL');
            }
            if (n === 2) {
                // 第二次：不再重開，視窗回到啟動畫面顯示原因
                await sleep(4000);
                rec('failure-page', { title: await js('document.title'), heading: await js("(document.getElementById('failure-title') || {}).textContent || ''") });
                getWindow().close();
            }
        }
    };
}

module.exports = { install };
