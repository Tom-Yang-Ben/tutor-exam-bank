// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherScripts.test.js — 桌面啟動器的檔案本身（docs/desktop-launcher.md）
//
//   1. scripts/windows/install_desktop_shortcut.bat：與其他一鍵腳本同一套規矩（CRLF、UTF-8 無 BOM、chcp 65001、標籤、pause）。
//   2. scripts/desktop/run_hidden.vbs：只有 ASCII（wscript 以 ANSI 讀 .vbs）、CRLF、隱藏視窗執行 node 並等它結束；
//      U("…") 解出來的中文訊息正確。
//   3. 兩個 .ico：結構正確（16～256 各尺寸、256 用 PNG）。
//   4. 捷徑內容（install_shortcuts.js）：wscript.exe → run_hidden.vbs launch|stop "<node.exe>"、圖示、工作目錄。
//   5. status.html：不引用外部資源（本機模式的規則）、inline script 語法正確、不寫死系統網址。
//   6. 啟動頁的本機伺服器：只聽 127.0.0.1、Host 不對 403、/state 送出時通知版本。
//   7. .gitattributes、package.json（沒有新增相依套件）。
// 不跑 cmd.exe／wscript／PowerShell。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const DESKTOP = path.join(APP_DIR, 'scripts', 'desktop');

const { parseIco, buildIco } = require('../../scripts/desktop/lib/ico');
const { shortcutSpecs } = require('../../scripts/desktop/install_shortcuts');
const { startStatusServer } = require('../../scripts/desktop/lib/statusServer');
const offline = require('../../scripts/check_html_offline');
const checkHtml = require('../../eval/tools/check_html');

describe('install_desktop_shortcut.bat', () => {
    const buf = fs.readFileSync(path.join(APP_DIR, 'scripts', 'windows', 'install_desktop_shortcut.bat'));
    const text = buf.toString('utf8');

    test('CRLF、UTF-8 無 BOM、@echo off＋chcp 65001', () => {
        assert.notEqual(buf.subarray(0, 3).toString('hex'), 'efbbbf');
        assert.ok(Buffer.from(text, 'utf8').equals(buf));
        assert.ok(!/[^\r]\n/.test(text));
        assert.ok(text.endsWith('\r\n'));
        const lines = text.split('\r\n');
        assert.equal(lines[0], '@echo off');
        assert.equal(lines[1], 'chcp 65001 >nul');
    });

    test('標籤都存在、成功與失敗都 pause＋exit /b；先檢查 node 再呼叫 install_shortcuts.js（參數原樣轉交）', () => {
        const labels = new Set(text.split('\r\n').filter(l => /^:[A-Za-z_]\w*\s*$/.test(l)).map(l => l.trim().slice(1).toLowerCase()));
        for (const m of text.matchAll(/goto\s+:(\w+)/gi)) assert.ok(labels.has(m[1].toLowerCase()), m[1]);
        assert.ok((text.match(/\r\npause\r\nexit \/b [01]\r\n/g) || []).length >= 2);
        assert.ok(text.indexOf('where node') < text.indexOf('install_shortcuts.js" %*'));
    });

    test('echo 裡沒有會被 cmd 當成轉向或管線的字元', () => {
        for (const line of text.split('\r\n').map(l => l.trim())) {
            if (!/^echo/i.test(line)) continue;
            const bare = line.replace(/"[^"]*"/g, '').replace(/\^[|<>&]/g, '');
            assert.ok(!/[<>|&]/.test(bare), line);
        }
    });
});

describe('run_hidden.vbs', () => {
    const buf = fs.readFileSync(path.join(DESKTOP, 'run_hidden.vbs'));
    const text = buf.toString('latin1');

    test('只有 ASCII、CRLF', () => {
        assert.ok([...buf].every(b => b < 0x80), '有非 ASCII 的位元組：wscript 會用系統字碼頁讀壞');
        assert.ok(!/[^\r]\n/.test(text));
    });

    test('隱藏視窗（0）執行 node 並等它結束（True）；stop 參數改跑 stop.js；第二個參數是 node.exe 的完整路徑', () => {
        assert.match(text, /sh\.Run\("""" & nodeExe & """ """ & script & """", 0, True\)/);
        assert.match(text, /If mode = "stop" Then\r\n\s+script = fso\.BuildPath\(here, "stop\.js"\)/);
        assert.match(text, /script = fso\.BuildPath\(here, "launch\.js"\)/);
        assert.match(text, /If fso\.FileExists\(WScript\.Arguments\(1\)\) Then nodeExe = WScript\.Arguments\(1\)/);
        assert.match(text, /If rc <> 0 Then/);
    });

    test('U("…") 解出來的訊息', () => {
        const consts = Object.fromEntries([...text.matchAll(/Const (MSG_\w+) = "([0-9A-F]+)"/g)].map(m => [m[1], m[2]]));
        const decode = hex => hex.match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
        for (const [k, v] of Object.entries(consts)) assert.equal(v.length % 4, 0, k);
        assert.equal(decode(consts.MSG_TITLE), '出題系統');
        assert.equal(decode(consts.MSG_NO_NODE), '找不到 Node.js，出題系統無法啟動。請重新雙擊 exam_pro\\scripts\\windows\\install_desktop_shortcut.bat 建立捷徑；還沒安裝 Node.js 的話，先到 nodejs.org 安裝 LTS 版。');
        assert.equal(decode(consts.MSG_CRASH_1), '出題系統的程式異常結束（結束碼 ');
        assert.equal(decode(consts.MSG_CRASH_2), '）。請把這個資料夾裡今天的 launcher-日期.log 交給維護的人：');
        // VBScript 的 &H…& 是 Long：0x8000 以上的字（例如「題」0x984C、全形逗號 0xFF0C）不會被當成負的 Integer
        assert.match(text, /ChrW\(CLng\("&H" & Mid\(hex, i, 4\) & "&"\)\)/);
    });
});

describe('圖示', () => {
    for (const name of ['tutor-exam-bank.ico', 'tutor-exam-bank-stop.ico']) {
        test(`${name}：16～256 各尺寸，256 用 PNG、其餘 32 位元 DIB`, () => {
            const buf = fs.readFileSync(path.join(DESKTOP, 'assets', name));
            const entries = parseIco(buf);
            assert.deepEqual(entries.map(e => e.size), [16, 20, 24, 32, 40, 48, 64, 256]);
            for (const e of entries) {
                if (e.size === 256) { assert.equal(e.kind, 'png'); continue; }
                assert.equal(e.kind, 'dib');
                assert.equal(buf.readUInt32LE(e.offset), 40);
                assert.equal(buf.readInt32LE(e.offset + 4), e.size);
                assert.equal(buf.readInt32LE(e.offset + 8), e.size * 2);
                assert.equal(buf.readUInt16LE(e.offset + 14), 32);
            }
            assert.ok(buf.length < 80_000, '圖示不該太大');
        });
    }

    test('buildIco：讀回來的目錄對得上、透明像素進 AND 遮罩', () => {
        const rgba = Buffer.alloc(16 * 16 * 4);
        rgba.fill(255, 0, 4);   // 左上角一個不透明像素，其餘透明
        const ico = buildIco([{ size: 16, rgba }, { size: 256, png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) }]);
        const e = parseIco(ico);
        assert.deepEqual(e.map(x => [x.size, x.kind]), [[16, 'dib'], [256, 'png']]);
        const maskStart = e[0].offset + 40 + 16 * 16 * 4;
        // 左上角在 DIB 的最後一列（由下往上）：那一列第一個位元組的最高位是 0（不透明），其他位是 1
        assert.equal(ico[maskStart + 15 * 4], 0x7f);
        assert.equal(ico[maskStart], 0xff);
        assert.throws(() => buildIco([{ size: 16, rgba: Buffer.alloc(3) }]), /需要/);
    });
});

describe('install_shortcuts.js', () => {
    test('兩個捷徑：wscript.exe → run_hidden.vbs launch|stop "<node.exe>"，各自的圖示；工作目錄是 exam_pro', () => {
        const specs = shortcutSpecs({ appDir: 'D:\\期中專案\\exam_pro', nodePath: 'C:\\Program Files\\nodejs\\node.exe', systemRoot: 'C:\\WINDOWS' });
        assert.deepEqual(specs.map(s => s.name), ['出題系統', '關閉出題系統']);
        const [open, close] = specs;
        assert.equal(open.target, 'C:\\WINDOWS\\System32\\wscript.exe');
        assert.equal(open.args, '"D:\\期中專案\\exam_pro\\scripts\\desktop\\run_hidden.vbs" launch "C:\\Program Files\\nodejs\\node.exe"');
        assert.equal(close.args, '"D:\\期中專案\\exam_pro\\scripts\\desktop\\run_hidden.vbs" stop "C:\\Program Files\\nodejs\\node.exe"');
        assert.equal(open.workDir, 'D:\\期中專案\\exam_pro');
        assert.equal(open.icon, 'D:\\期中專案\\exam_pro\\scripts\\desktop\\assets\\tutor-exam-bank.ico');
        assert.equal(close.icon, 'D:\\期中專案\\exam_pro\\scripts\\desktop\\assets\\tutor-exam-bank-stop.ico');
        for (const s of specs) {
            assert.ok(fs.existsSync(path.join(DESKTOP, 'assets', path.win32.basename(s.icon))), s.icon);
            assert.ok(s.args.length < 1024, '捷徑參數上限 1024 字');
        }
    });

    test('捷徑指到的檔案都在', () => {
        for (const f of ['run_hidden.vbs', 'launch.js', 'stop.js', 'status.html']) assert.ok(fs.existsSync(path.join(DESKTOP, f)), f);
    });
});

describe('status.html', () => {
    const html = fs.readFileSync(path.join(DESKTOP, 'status.html'), 'utf8');

    test('不引用任何外部資源（與 public/ 同一套規則）', () => {
        assert.deepEqual(offline.checkText('scripts/desktop/status.html', html), []);
        assert.deepEqual(offline.localResourceRefs(html), []);
    });

    test('inline script 語法正確', () => {
        const scripts = checkHtml.extractInlineScripts(html);
        assert.equal(scripts.length, 1);
        for (const s of scripts) {
            const r = checkHtml.checkSyntax(s.code, s.isModule, 'status.html');
            assert.equal(r.ok, true, r.message);
        }
    });

    test('只讀相對路徑 state、系統網址來自狀態（不寫死 3000）；完成沒警告就轉頁、有警告要按鈕', () => {
        assert.match(html, /fetch\('state'/);
        assert.doesNotMatch(offline.blankHtmlComments(html), /localhost:3000|127\.0\.0\.1/);
        assert.match(html, /window\.location\.replace\(url\)/);
        assert.match(html, /warnings\.length === 0/);
        assert.match(html, /id="enter"/);
    });
});

describe('status.html 的行為（在 vm 裡真的執行頁面的 script）', () => {
    const vm = require('node:vm');
    const html = fs.readFileSync(path.join(DESKTOP, 'status.html'), 'utf8');
    const code = checkHtml.extractInlineScripts(html)[0].code;
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

    class El {
        constructor(tag, id) { this.tagName = tag; this.id = id; this.children = []; this.attrs = {}; this._text = ''; this.hidden = /\bhidden\b/.test((html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`)) || [''])[0]); this.className = ''; this.onclick = null; this.focused = false; }
        get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
        set textContent(v) { this._text = String(v); this.children = []; }
        appendChild(c) { this.children.push(c); return c; }
        setAttribute(k, v) { this.attrs[k] = String(v); }
        focus() { this.focused = true; }
    }

    /**
     * @param {Array<object|Error>} responses  依序給 /state 的回應（Error＝連線失敗）
     */
    function run(responses) {
        const els = Object.fromEntries(ids.map(id => [id, new El('x', id)]));
        const timers = [];
        const replaced = [];
        const fetched = [];
        const document = {
            title: '',
            getElementById: id => els[id] || null,
            createElement: tag => new El(tag, null)
        };
        const sandbox = {
            document,
            window: { location: { replace: u => replaced.push(u) } },
            fetch: (url, opts) => {
                fetched.push({ url, opts });
                const r = responses.length ? responses.shift() : new Error('no more');
                if (r instanceof Error) return Promise.reject(r);
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r) });
            },
            setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }
        };
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox);
        const flush = () => new Promise(r => setImmediate(r));
        return {
            els, timers, replaced, fetched, document,
            /** 跑完目前這一次輪詢，再觸發下一次（有的話） */
            async tick() { await flush(); await flush(); const t = timers.shift(); if (t) t.fn(); await flush(); await flush(); }
        };
    }

    const steps = [
        { id: 'check', label: '檢查系統狀態', state: 'done', detail: '' },
        { id: 'database', label: '資料庫（Docker）', state: 'running', detail: '開啟 Docker Desktop…' },
        { id: 'ai', label: '本機 AI（Ollama）', state: 'pending', detail: '' }
    ];

    test('執行中：畫出每個步驟（狀態、名稱、說明；等待中的秒數蓋過說明）、每 0.7 秒再讀一次 state', async () => {
        const p = run([{ version: 1, phase: 'running', steps, warnings: [], note: '已等 12 秒', logs: { launcher: 'L.log' } }]);
        await p.tick();
        const lis = p.els.steps.children;
        assert.equal(lis.length, 3);
        assert.equal(lis[0].attrs['data-state'], 'done');
        assert.equal(lis[0].children[0].textContent, '✓');
        assert.equal(lis[1].children[2].textContent, '已等 12 秒');
        assert.equal(p.fetched[0].url, 'state');
        assert.equal(p.els.warnings.hidden, true);
        assert.equal(p.els.failure.hidden, true);
        assert.match(p.els.foot.textContent, /L\.log/);
        assert.equal(p.fetched.length, 2, '又讀了一次');
    });

    test('完成、沒有注意事項 → 同一個視窗直接轉到系統首頁，之後不再輪詢', async () => {
        const p = run([
            { version: 1, phase: 'running', steps, warnings: [] },
            { version: 2, phase: 'done', steps, warnings: [], appUrl: 'http://localhost:3000/' }
        ]);
        await p.tick();
        await p.tick();
        assert.deepEqual(p.replaced, ['http://localhost:3000/']);
        assert.equal(p.timers.length, 0);
    });

    test('完成、有注意事項 → 不自動轉頁，列出注意事項；按「進入出題系統」才轉', async () => {
        const p = run([{ version: 3, phase: 'done', steps, warnings: [{ code: 'ollama-not-found', text: 'Ollama 沒有在執行…拆題會失敗' }], appUrl: 'http://localhost:3000/' }]);
        await p.tick();
        assert.deepEqual(p.replaced, []);
        assert.equal(p.els.warnings.hidden, false);
        assert.equal(p.els['warning-list'].children[0].textContent, 'Ollama 沒有在執行…拆題會失敗');
        assert.equal(p.els.enter.hidden, false);
        assert.equal(p.els.enter.focused, true);
        p.els.enter.onclick();
        assert.deepEqual(p.replaced, ['http://localhost:3000/']);
        assert.equal(p.timers.length, 0);
    });

    test('失敗 → 紅框顯示標題、原因、處置、詳細訊息；不轉頁、不再輪詢', async () => {
        const p = run([{
            version: 4, phase: 'failed', steps, warnings: [],
            failure: { title: '找不到 Docker Desktop', message: 'Docker 沒有在執行', hint: ['從開始選單開', '再點一次圖示'], detail: 'docker: not found' }
        }]);
        await p.tick();
        assert.equal(p.els.failure.hidden, false);
        assert.equal(p.els['failure-title'].textContent, '找不到 Docker Desktop');
        assert.equal(p.els['failure-hints'].children.length, 2);
        assert.equal(p.els['failure-detail'].hidden, false);
        assert.equal(p.els['failure-detail'].textContent, 'docker: not found');
        assert.equal(p.els.title.textContent, '出題系統無法啟動');
        assert.deepEqual(p.replaced, []);
        assert.equal(p.timers.length, 0);
    });

    test('啟動程式結束了（連續讀不到 state）→ 說明畫面不會再更新', async () => {
        const p = run([new Error('x'), new Error('x'), new Error('x'), new Error('x'), new Error('x')]);
        for (let i = 0; i < 5; i++) await p.tick();
        assert.match(p.els.sub.textContent, /啟動程式已經結束/);
        assert.equal(p.timers.length, 0);
    });
});

describe('啟動頁的本機伺服器', () => {
    function get(port, pathname, host) {
        return new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: host ? { host } : {} }, res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            });
            req.on('error', reject);
            req.end();
        });
    }

    test('/ 給頁面、/state 給 JSON 並通知送出的版本；Host 不對 403；其他 404', async () => {
        const delivered = [];
        const srv = await startStatusServer({ html: '<p>hi</p>', getState: () => ({ version: 7, phase: 'running' }), onDelivered: v => delivered.push(v) });
        try {
            assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
            const page = await get(srv.port, '/');
            assert.equal(page.status, 200);
            assert.equal(page.body, '<p>hi</p>');
            assert.match(page.headers['content-type'], /text\/html; charset=utf-8/);
            const state = await get(srv.port, '/state?t=1');
            assert.equal(state.status, 200);
            assert.deepEqual(JSON.parse(state.body), { version: 7, phase: 'running' });
            assert.equal(state.headers['cache-control'], 'no-store');
            assert.deepEqual(delivered, [7]);
            const local = await get(srv.port, '/state', `localhost:${srv.port}`);
            assert.equal(local.status, 200);
            assert.equal((await get(srv.port, '/state', 'evil.example:80')).status, 403);
            assert.equal((await get(srv.port, '/nope')).status, 404);
        } finally {
            await srv.close();
        }
    });
});

describe('版控設定與相依套件', () => {
    test('.gitattributes：.vbs 原樣進版控（CRLF）、.ico 是二進位', () => {
        const ga = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
        assert.match(ga, /^exam_pro\/scripts\/desktop\/\*\.vbs -text$/m);
        assert.match(ga, /^exam_pro\/scripts\/desktop\/assets\/\*\.ico binary$/m);
        assert.match(ga, /^exam_pro\/scripts\/windows\/\*\.bat -text$/m);
    });

    test('啟動器只用 Node 內建模組與既有相依套件（pg、dotenv、express、sharp 只在產生圖示時用）', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        const deps = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
        const builtins = new Set(require('node:module').builtinModules);
        const files = [];
        const walk = dir => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (p.endsWith('.js')) files.push(p);
            }
        };
        walk(DESKTOP);
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(/require\('([^'./][^']*)'\)/g)) {
                const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
                assert.ok(builtins.has(name.replace(/^node:/, '')) || deps.has(name), `${path.relative(APP_DIR, f)} 用了 ${name}`);
            }
        }
    });
});
