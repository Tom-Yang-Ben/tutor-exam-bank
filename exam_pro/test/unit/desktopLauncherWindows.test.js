// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherWindows.test.js — 桌面啟動器的 Windows 知識（scripts/desktop/lib/windows.js、lib/probes.js 的純函式）
//   安裝位置、app 視窗參數、netstat／tasklist／PowerShell 輸出的解析、錄製偵測、PowerShell 編碼、訊息框、捷徑、.env 與健康檢查的判讀。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const w = require('../../scripts/desktop/lib/windows');
const probes = require('../../scripts/desktop/lib/probes');

const ENV = { LOCALAPPDATA: 'C:\\Users\\ben\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };

describe('安裝位置與瀏覽器參數', () => {
    test('Edge／Chrome 的常見位置', () => {
        assert.deepEqual(w.browserCandidates('edge', ENV), [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Users\\ben\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'
        ]);
        assert.equal(w.browserCandidates('chrome', ENV)[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
        assert.deepEqual(w.browserCandidates('default', ENV), []);
    });

    test('環境變數大小寫不同也讀得到；沒有 LOCALAPPDATA 時由 USERPROFILE 推', () => {
        assert.equal(w.envGet({ localappdata: 'X' }, 'LOCALAPPDATA'), 'X');
        assert.equal(w.localAppData({ USERPROFILE: 'C:\\Users\\a' }), 'C:\\Users\\a\\AppData\\Local');
    });

    test('開視窗的順序：auto＝Edge → Chrome → 預設；指定的排第一，其他照樣當退路', () => {
        assert.deepEqual(w.browserOrder('auto'), ['edge', 'chrome', 'default']);
        assert.deepEqual(w.browserOrder('chrome'), ['chrome', 'edge', 'default']);
        assert.deepEqual(w.browserOrder('default'), ['default', 'edge', 'chrome']);
    });

    test('app 模式：--app、獨立設定檔、不跑首次設定；額外參數接在後面', () => {
        const profile = w.browserProfileDir('edge', {}, ENV);
        assert.equal(profile, 'C:\\Users\\ben\\AppData\\Local\\TutorExamBank\\browser-profile\\edge');
        assert.equal(w.browserProfileDir('chrome', { browserProfileDir: 'D:\\p' }, ENV), 'D:\\p\\chrome');
        assert.deepEqual(w.appWindowArgs({ url: 'http://localhost:3000/', profileDir: profile, extra: ['--start-maximized'] }), [
            '--app=http://localhost:3000/', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--start-maximized'
        ]);
    });

    test('Ollama：系統匣程式 → ollama.exe serve → PATH 的 ollama serve；設定了路徑就只用它', () => {
        const c = w.ollamaCandidates({}, ENV);
        assert.deepEqual(c.map(x => [x.method, x.file, x.args, x.checkExists]), [
            ['app', 'C:\\Users\\ben\\AppData\\Local\\Programs\\Ollama\\ollama app.exe', [], true],
            ['serve', 'C:\\Users\\ben\\AppData\\Local\\Programs\\Ollama\\ollama.exe', ['serve'], true],
            ['serve', 'ollama', ['serve'], false]
        ]);
        assert.deepEqual(w.ollamaCandidates({ ollamaAppPath: 'D:\\ai\\ollama.exe' }, ENV).map(x => x.method), ['serve']);
        assert.deepEqual(w.ollamaCandidates({ ollamaAppPath: 'D:\\ai\\ollama app.exe' }, ENV).map(x => x.method), ['app']);
    });

    test('docker CLI：PATH → Docker Desktop 旁的 resources\\bin；設定了就只用設定的', () => {
        assert.deepEqual(w.dockerCliCandidates({ dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' }).map(x => x.file),
            ['docker', 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']);
        assert.deepEqual(w.dockerCliCandidates({ dockerCliPath: 'D:\\docker.exe' }).map(x => x.file), ['D:\\docker.exe']);
    });
});

describe('解析輸出', () => {
    test('netstat -ano：只認聆聽中的 socket（遠端是萬用位址），不看被翻譯的狀態字；IPv4／IPv6 去重', () => {
        const text = [
            '',
            '使用中連線',
            '',
            '  協定   本機位址               外部位址               狀態           PID',
            '  TCP    0.0.0.0:3000           0.0.0.0:0              接聽           4321',
            '  TCP    127.0.0.1:3000         127.0.0.1:52100        ESTABLISHED     4321',
            '  TCP    127.0.0.1:52100        127.0.0.1:3000         ESTABLISHED     999',
            '  TCP    [::]:3000              [::]:0                 LISTENING       4321',
            '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       55',
            '  UDP    0.0.0.0:3000           *:*                                    66'
        ].join('\r\n');
        assert.deepEqual(w.parseNetstatListeners(text, 3000), [4321]);
        assert.deepEqual(w.parseNetstatListeners(text, 30000), [55]);
        assert.deepEqual(w.parseNetstatListeners('', 3000), []);
    });

    // 〔Owner 第六輪 DA-11＝1〕後端預設只聽 127.0.0.1：netstat 的本機位址是 127.0.0.1:3000（不是 0.0.0.0:3000）
    test('netstat -ano：後端只聽 127.0.0.1（或 [::1]）時一樣認得出來；同一埠上別的程式聽 0.0.0.0 也列出', () => {
        const text = [
            '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       7100',
            '  TCP    127.0.0.1:3000         127.0.0.1:52100        ESTABLISHED     7100',
            '  TCP    [::1]:3000             [::]:0                 LISTENING       7200',
            '  TCP    127.0.0.1:13000        0.0.0.0:0              LISTENING       55'
        ].join('\r\n');
        assert.deepEqual(w.parseNetstatListeners(text, 3000), [7100, 7200]);
        assert.deepEqual(w.parseNetstatListeners(`  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   4321\r\n${text}`, 3000), [4321, 7100, 7200]);
    });

    test('tasklist /FO CSV', () => {
        assert.equal(w.parseTasklistName('"node.exe","4321","Console","1","80,512 K"\r\n', 4321), 'node.exe');
        assert.equal(w.parseTasklistName('資訊: 沒有執行中的工作符合指定的準則。', 4321), null);
    });

    test('PowerShell ConvertTo-Json：一筆是物件、多筆是陣列、沒有是空字串，都接受（含 BOM）', () => {
        const one = JSON.stringify({ ProcessId: 5, Name: 'node.exe', CommandLine: 'node a.js' });
        assert.deepEqual(w.parseProcessJson(`\uFEFF${one}`), [{ pid: 5, name: 'node.exe', commandLine: 'node a.js' }]);
        assert.equal(w.parseProcessJson(`[${one},${one}]`).length, 2);
        assert.deepEqual(w.parseProcessJson(''), []);
        assert.deepEqual(w.parseProcessJson(JSON.stringify({ ProcessId: 6, Name: 'cmd.exe', CommandLine: null })), [{ pid: 6, name: 'cmd.exe', commandLine: '' }]);
    });

    test('ps（非 Windows 的開發機）', () => {
        assert.deepEqual(w.parsePsOutput('  12 node node eval/tools/rerecord_all.js\n 13 /usr/bin/bash bash'), [
            { pid: 12, name: 'node', commandLine: 'node eval/tools/rerecord_all.js' },
            { pid: 13, name: 'bash', commandLine: 'bash' }
        ]);
    });
});

describe('錄製偵測', () => {
    const P = (pid, name, commandLine) => ({ pid, name, commandLine });

    test('認得 record_local.bat、npm run cassettes:rerecord、rerecord_all.js、eval:record、record_embeddings.js、record_cassettes.js', () => {
        const list = [
            P(1, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /c ""D:\\期中專案\\exam_pro\\scripts\\windows\\record_local.bat" classify,nlq"'),
            P(2, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run cassettes:rerecord'),
            P(3, 'node.exe', 'node eval/tools/rerecord_all.js --suites classify'),
            P(4, 'node.exe', 'node npm-cli.js run eval:record'),
            P(5, 'node.exe', 'node eval/record_embeddings.js --only-missing'),
            P(6, 'node.exe', 'node scripts/record_cassettes.js')
        ];
        const found = w.findRecordingProcesses(list, 999);
        assert.equal(found.length, 6);
        assert.match(found[0], /^PID 1 cmd\.exe：/);
    });

    test('不算：自己、PowerShell（命令列裡有這些字）、無關的 node、很長的命令列會截斷', () => {
        const list = [
            P(10, 'node.exe', 'node eval/tools/rerecord_all.js'),
            P(11, 'powershell.exe', 'powershell -Command "rerecord_all.js"'),
            P(12, 'node.exe', 'node server.js'),
            P(13, 'node.exe', 'node eval/run.js --suite classify')
        ];
        assert.deepEqual(w.findRecordingProcesses(list, 10), []);
        const long = w.findRecordingProcesses([P(20, 'node.exe', `node rerecord_all.js ${'x'.repeat(400)}`)], 1)[0];
        assert.ok(long.length < 200);
        assert.ok(long.endsWith('…'));
    });
});

describe('PowerShell 與訊息框', () => {
    test('psQuote：單引號寫兩次，中文與反斜線原樣', () => {
        assert.equal(w.psQuote("Ben's 出題系統 C:\\x"), "'Ben''s 出題系統 C:\\x'");
    });

    test('-EncodedCommand 是 UTF-16LE 的 base64（中文不經主控台字碼頁）；不加 -WindowStyle Hidden', () => {
        const args = w.powershellArgs("Write-Output '出題系統'");
        assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
        assert.equal(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'), "Write-Output '出題系統'");
        assert.ok(!args.includes('-WindowStyle'));
    });

    test('Popup 腳本：輸出 UTF-8、文字與標題加引號、按鈕＋圖示＋最上層、秒數', () => {
        const s = w.popupScript({ text: "第一行\n第二行 it's", title: '出題系統', buttons: w.POPUP.YES_NO_CANCEL, icon: w.POPUP.ICON_QUESTION, seconds: 5 });
        assert.match(s, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
        assert.ok(s.includes("$ws.Popup('第一行\n第二行 it''s', 5, '出題系統', 4131)"));
        assert.equal(w.POPUP.YES_NO_CANCEL + w.POPUP.ICON_QUESTION + w.POPUP.TOPMOST, 4131);
    });

    test('Popup 的回傳值', () => {
        assert.equal(w.parsePopupResult('6\r\n'), 'yes');
        assert.equal(w.parsePopupResult('7'), 'no');
        assert.equal(w.parsePopupResult('2'), 'cancel');
        assert.equal(w.parsePopupResult('1'), 'ok');
        assert.equal(w.parsePopupResult('-1'), 'timeout');
        assert.equal(w.parsePopupResult(''), null);
    });

    test('程序清單的指令只列 node／cmd、輸出 JSON', () => {
        assert.match(w.PS_LIST_PROCESSES, /Win32_Process/);
        assert.match(w.PS_LIST_PROCESSES, /Name='node\.exe' OR Name='cmd\.exe'/);
        assert.match(w.PS_LIST_PROCESSES, /ConvertTo-Json/);
    });

    test('捷徑腳本：桌面用 GetFolderPath（OneDrive 也對）、每個捷徑的目標／參數／工作目錄／圖示；移除模式只刪檔', () => {
        const specs = [{ name: '出題系統', target: 'C:\\Windows\\System32\\wscript.exe', args: '"D:\\期中專案\\run_hidden.vbs" launch', workDir: 'D:\\期中專案', icon: 'D:\\a.ico', description: "Ben's" }];
        const s = w.shortcutScript({ shortcuts: specs });
        assert.match(s, /\[Environment\]::GetFolderPath\('Desktop'\)/);
        assert.ok(s.includes("Join-Path $desktop '出題系統.lnk'"));
        assert.ok(s.includes("$s.TargetPath = 'C:\\Windows\\System32\\wscript.exe'"));
        assert.ok(s.includes("$s.Arguments = '\"D:\\期中專案\\run_hidden.vbs\" launch'"));
        assert.ok(s.includes("$s.IconLocation = 'D:\\a.ico,0'"));
        assert.ok(s.includes("$s.Description = 'Ben''s'"));
        assert.ok(s.includes('$s.Save()'));
        const rm = w.shortcutScript({ shortcuts: specs, remove: true });
        assert.match(rm, /Remove-Item -LiteralPath \$p/);
        assert.doesNotMatch(rm, /CreateShortcut/);
    });
});

describe('其他', () => {
    test('日期與時間用本地時間', () => {
        const d = new Date(2026, 8, 7, 5, 3, 9);
        assert.equal(w.dateStamp(d), '2026-09-07');
        assert.equal(w.timeStamp(d), '2026-09-07 05:03:09');
    });

    test('EADDRINUSE、最後幾行', () => {
        assert.equal(w.isAddrInUse('Error: listen EADDRINUSE: address already in use :::3000'), true);
        assert.equal(w.isAddrInUse('fine'), false);
        assert.equal(w.tailLines('a\n\nb\r\nc\n', 2), 'b\nc');
    });
});

describe('probes 的純函式：.env、埠、健康檢查的判讀', () => {
    test('parseEnvText 與 dotenv 一致（引號、註解、export）', () => {
        const text = 'PORT=3100\nDATABASE_URL="postgres://a:b@h:5442/db"\n# 註解\nAPI_KEY=k # 尾註\n';
        assert.deepEqual(probes.parseEnvText(text), require('dotenv').parse(text));
        assert.deepEqual(probes.parseEnvText(null), {});
    });

    test('effectiveEnv：系統環境蓋過 .env（與 dotenv 預設不覆寫相同）', () => {
        assert.deepEqual(probes.effectiveEnv({ PORT: '3000', A: '1' }, { PORT: '4000', B: undefined }), { PORT: '4000', A: '1' });
    });

    test('portFromEnv：與 server.js 相同，非法值用 3000', () => {
        assert.equal(probes.portFromEnv({}), 3000);
        assert.equal(probes.portFromEnv({ PORT: '3100' }), 3100);
        assert.equal(probes.portFromEnv({ PORT: 'abc' }), 3000);
        assert.equal(probes.portFromEnv({ PORT: '70000' }), 3000);
    });

    // 〔Owner 第六輪 DA-11＝1〕與 server.js 同一支 config/listenHost.js
    test('listenFromEnv：HOST 沒寫＝127.0.0.1；本機與萬用位址都支援、從 127.0.0.1（或原本的本機位址）連；只聽區網位址不支援', () => {
        assert.deepEqual(probes.listenFromEnv({}), { host: '127.0.0.1', scope: 'loopback', probeHost: '127.0.0.1', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: '' }), { host: '127.0.0.1', scope: 'loopback', probeHost: '127.0.0.1', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: '0.0.0.0' }), { host: '0.0.0.0', scope: 'wildcard', probeHost: '127.0.0.1', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: '::' }), { host: '::', scope: 'wildcard', probeHost: '127.0.0.1', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: 'localhost' }), { host: 'localhost', scope: 'loopback', probeHost: 'localhost', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: '[::1]' }), { host: '::1', scope: 'loopback', probeHost: '::1', supported: true });
        assert.deepEqual(probes.listenFromEnv({ HOST: '192.168.1.10' }), { host: '192.168.1.10', scope: 'specific', probeHost: null, supported: false });
        // 〔審查 dec/r7-decisions-host〕127.0.0.1 以外的 127.x：app 視窗的 http://localhost 連不到 → 不支援
        assert.deepEqual(probes.listenFromEnv({ HOST: '127.0.0.2' }), { host: '127.0.0.2', scope: 'loopback', probeHost: null, supported: false });
        assert.deepEqual(probes.listenFromEnv({ HOST: '::ffff:127.0.0.1' }), { host: '::ffff:127.0.0.1', scope: 'loopback', probeHost: '127.0.0.1', supported: true });
        // 系統環境蓋過 .env（effectiveEnv），與後端的 dotenv 相同
        assert.equal(probes.listenFromEnv(probes.effectiveEnv({ HOST: '0.0.0.0' }, { HOST: '127.0.0.1' })).host, '127.0.0.1');
    });

    test('createProbes 的 base 跟著 HOST 走（健康檢查與關閉通道連這個位址）', () => {
        const mk = env => probes.createProbes({ sys: { platform: 'linux' }, config: {}, env, paths: { appDir: '/app' }, port: 3100 });
        assert.equal(mk({}).base, 'http://127.0.0.1:3100');
        assert.equal(mk({ HOST: '0.0.0.0' }).base, 'http://127.0.0.1:3100');
        assert.equal(mk({ HOST: 'localhost' }).base, 'http://localhost:3100');
        assert.equal(mk({ HOST: '::1' }).base, 'http://[::1]:3100');
        const lan = mk({ HOST: '192.168.1.10' });
        assert.equal(lan.listen.supported, false);
        assert.equal(lan.base, 'http://127.0.0.1:3100', '不支援時不留 undefined（啟動器與關閉捷徑一開始就停下，不會用到它）');
    });

    test('classifyHealth', () => {
        assert.deepEqual(probes.classifyHealth({ errorCode: 'ECONNREFUSED' }, 3000), { state: 'down' });
        assert.equal(probes.classifyHealth({ errorCode: 'ETIMEDOUT' }, 3000).state, 'other');
        assert.deepEqual(probes.classifyHealth({ status: 200, json: { service: 'tutor-exam-bank', status: 'ok', version: '1.0.0', db: { ok: true } }, errorCode: null }, 3000),
            { state: 'ours', dbOk: true, version: '1.0.0' });
        assert.equal(probes.classifyHealth({ status: 503, json: { service: 'tutor-exam-bank', status: 'degraded', db: { ok: false } }, errorCode: null }, 3000).dbOk, false);
        assert.deepEqual(probes.classifyHealth({ status: 404, json: { message: 'x' }, errorCode: null }, 3000), { state: 'maybe-legacy', status: 404 });
        assert.equal(probes.classifyHealth({ status: 200, json: { service: 'another-app' }, errorCode: null }, 3000).state, 'maybe-legacy');
    });

    test('looksLikeLegacyIndex：只認本系統首頁', () => {
        const fs = require('fs');
        const path = require('path');
        const index = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.equal(probes.looksLikeLegacyIndex(index), true);
        assert.equal(probes.looksLikeLegacyIndex('<html><title>Grafana</title></html>'), false);
    });

    test('appPaths：log、設定、權杖檔都在 exam_pro/data 底下（不進版控）', () => {
        const J = (...s) => require('node:path').join('/app', ...s);
        const p = probes.appPaths('/app');
        assert.equal(p.serverInfo, J('data', 'launcher', 'server.json'));
        assert.equal(p.configFile, J('data', 'launcher', 'config.json'));
        assert.equal(p.logsDir, J('data', 'logs'));
        assert.equal(p.statusHtml, J('scripts', 'desktop', 'status.html'));
    });
});
