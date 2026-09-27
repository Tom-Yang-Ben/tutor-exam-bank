// desktop/test/package.test.js — 套件與檔案的約定：Electron 版本鎖死、只有 main.js 碰 electron、
// 一鍵腳本的格式、不影響 exam_pro 的 npm ci（docs/desktop-app-design.md 第 2.1、2.2 節）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.dirname(DESKTOP);
const APP = path.join(REPO, 'exam_pro');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('desktop/package.json', () => {
    const pkg = readJson(path.join(DESKTOP, 'package.json'));
    const lock = readJson(path.join(DESKTOP, 'package-lock.json'));

    test('electron 是 devDependency，鎖定設計稿查證的穩定版 44.4.5（不用 ^、~）', () => {
        assert.equal(pkg.devDependencies.electron, '44.4.5');
        assert.equal((pkg.dependencies || {}).electron, undefined);
        assert.equal(pkg.main, 'main.js');
        assert.equal(lock.packages[''].devDependencies.electron, '44.4.5');
        assert.equal(lock.packages['node_modules/electron'].version, '44.4.5');
    });

    test('exam_pro 的 package.json／lock 沒有 electron（CI 的 npm ci 不會多下載它）', () => {
        const exam = readJson(path.join(APP, 'package.json'));
        assert.equal({ ...exam.dependencies, ...exam.devDependencies }.electron, undefined);
        assert.doesNotMatch(fs.readFileSync(path.join(APP, 'package-lock.json'), 'utf8'), /"node_modules\/electron"/);
    });
});

describe('程式的分工', () => {
    test('只有 main.js 與冒煙測試 require("electron")：lib/ 與 backend-entry.js 都能在沒有 Electron 的 Node 裡測', () => {
        const files = ['backend-entry.js', ...fs.readdirSync(path.join(DESKTOP, 'lib')).map(f => path.join('lib', f))];
        for (const f of files) {
            assert.doesNotMatch(fs.readFileSync(path.join(DESKTOP, f), 'utf8'), /require\(['"]electron['"]\)/, f);
        }
        assert.match(fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8'), /require\('electron'\)/);
    });

    test('視窗的安全設定：contextIsolation、sandbox、不開 nodeIntegration；後端用 utilityProcess.fork', () => {
        const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
        assert.match(main, /webPreferences: \{ contextIsolation: true, nodeIntegration: false, sandbox: true/);
        assert.match(main, /utilityProcess\.fork\(/);
        assert.match(main, /requestSingleInstanceLock\(\)/);
        assert.match(main, /setPermissionRequestHandler/);
        assert.match(main, /setPermissionCheckHandler/);
        assert.match(main, /'will-download'/);
        assert.doesNotMatch(main, /setSavePath/, '產品一律跳另存新檔（只有冒煙測試指定存檔路徑）');
        // 執行期零外連：拼字檢查關掉、字典不從 Google 的 CDN 下載（冒煙測試的外連陷阱驗實際行為）
        assert.match(main, /setSpellCheckerEnabled\(false\)/);
        assert.match(main, /setSpellCheckerDictionaryDownloadURL\(security\.SPELLCHECK_DICTIONARY_URL\)/);
    });

    test('冒煙測試的掛勾只在從 repo 執行時載入（安裝版不帶 test/），載入失敗不擋啟動', () => {
        const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
        assert.match(main, /if \(process\.env\.TUTOR_DESKTOP_SMOKE && !app\.isPackaged\) \{/);
        assert.match(main, /try \{\s*require\('\.\/test\/smoke\/hook'\)/);
        assert.equal((main.match(/require\('\.\/test\//g) || []).length, 1, '產品主程式只有這一處碰 test/');
    });

    test('Windows 登出或關機：旗標只照 lib/decisions.js 的 sessionEndingAfter 改（query-session-end 不直接設 true）', () => {
        const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
        assert.match(main, /sessionEnding = D\.sessionEndingAfter\(sessionEnding, 'query-session-end'\)/);
        assert.match(main, /sessionEnding = D\.sessionEndingAfter\(sessionEnding, 'session-end'\)/);
        assert.doesNotMatch(main, /sessionEnding = true/);
    });

    test('後端只綁 127.0.0.1（DA-11＝1）', () => {
        assert.match(fs.readFileSync(path.join(DESKTOP, 'backend-entry.js'), 'utf8'), /const HOST = '127\.0\.0\.1';/);
    });

    test('.gitignore 排除 desktop 的建置輸出（第 3 條第 32 項）', () => {
        const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
        assert.match(gi, /^desktop\/dist\/$/m);
        assert.match(gi, /^desktop\/out\/$/m);
    });
});

describe('exam_pro/scripts/windows/install_desktop_app.bat', () => {
    const buf = fs.readFileSync(path.join(APP, 'scripts', 'windows', 'install_desktop_app.bat'));
    const text = buf.toString('utf8');
    const lines = text.split('\r\n');

    test('與其他一鍵腳本同一套規矩：CRLF、UTF-8 無 BOM、@echo off＋chcp 65001', () => {
        assert.notEqual(buf.subarray(0, 3).toString('hex'), 'efbbbf');
        assert.ok(Buffer.from(text, 'utf8').equals(buf));
        assert.ok(!/[^\r]\n/.test(text));
        assert.ok(text.endsWith('\r\n'));
        assert.equal(lines[0], '@echo off');
        assert.equal(lines[1], 'chcp 65001 >nul');
    });

    test('標籤都存在；成功與失敗的出口都 pause＋exit /b', () => {
        const labels = new Set(lines.filter(l => /^:[A-Za-z_]\w*\s*$/.test(l)).map(l => l.trim().slice(1).toLowerCase()));
        for (const m of text.matchAll(/goto\s+:(\w+)/gi)) assert.ok(labels.has(m[1].toLowerCase()), m[1]);
        assert.ok((text.match(/\r\npause\r\nexit \/b [01]\r\n/g) || []).length >= 3);
    });

    test('npm 用 call（npm 是 .cmd：不 call 的話批次檔不會回來）；npm ci 之後另外下載 Electron 的執行檔', () => {
        assert.ok(lines.includes('call npm ci --no-audit --no-fund'));
        assert.ok(lines.includes('node "%DESKTOP%\\node_modules\\electron\\install.js"'));
        assert.ok(lines.indexOf('call npm ci --no-audit --no-fund') < lines.indexOf('node "%DESKTOP%\\node_modules\\electron\\install.js"'));
    });

    test('捷徑由 Electron 自己建（--install-shortcut，帶 AppUserModelID）；--remove、--reinstall', () => {
        assert.ok(lines.includes('"%ELECTRON%" "%DESKTOP%" --install-shortcut'));
        assert.ok(lines.includes('"%ELECTRON%" "%DESKTOP%" --remove-shortcut'));
        assert.ok(lines.includes('set "ELECTRON=%DESKTOP%\\node_modules\\electron\\dist\\electron.exe"'));
        assert.ok(lines.includes('if /i "%~1"=="--remove" set "MODE=remove"'));
        assert.ok(lines.includes('if /i "%~1"=="--reinstall" set "MODE=reinstall"'));
        assert.ok(lines.includes('cd /d "%~dp0..\\..\\.."'), '從 exam_pro\\scripts\\windows 回到 repo 最上層');
        const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
        assert.match(main, /--install-shortcut/);
        assert.match(main, /--remove-shortcut/);
    });

    test('安裝失敗的訊息：先提桌面版還開著（--reinstall 時 electron.exe 被鎖住，npm ci 會 EBUSY），再提網路', () => {
        const at = lines.indexOf(':npm_failed');
        assert.ok(at > 0);
        const msg = lines.slice(at, lines.indexOf('goto :end_fail', at)).join('\n');
        assert.match(msg, /EBUSY/);
        assert.match(msg, /系統匣[^\n]*選「結束」/);
        assert.match(msg, /github\.com/);
    });

    test('echo 裡沒有會被 cmd 當成轉向或管線的字元', () => {
        for (const line of lines.map(l => l.trim())) {
            if (!/^echo/i.test(line)) continue;
            const bare = line.replace(/"[^"]*"/g, '').replace(/\^[|<>&]/g, '');
            assert.ok(!/[<>|&]/.test(bare), line);
        }
    });

    test('桌面啟動器 A 的捷徑腳本還在（兩個並存）', () => {
        assert.ok(fs.existsSync(path.join(APP, 'scripts', 'windows', 'install_desktop_shortcut.bat')));
    });
});
