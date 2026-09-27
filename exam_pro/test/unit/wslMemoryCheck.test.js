// ─────────────────────────────────────────────────────────────
// test/unit/wslMemoryCheck.test.js — WSL 記憶體與 Smart App Control 的檢查（〔Owner 第六輪 DA-14＝1、DA-9＝1，2026-09-27〕）
//
//   scripts/windows/wsl_memory_check.bat → scripts/desktop/wsl_memory_check.js；說明在 docs/desktop-app-design.md 第 10 節。
//   1. .bat：與其他一鍵腳本同一套規矩（CRLF、UTF-8 無 BOM、chcp 65001、標籤、pause＋exit /b）；只呼叫這支 js，
//      不含 wsl --shutdown 等會改狀態的指令（註解除外）。
//   2. **只讀取**：PowerShell 只用 Get-* 與讀屬性；collect() 用假的 Windows 跑一遍，執行的指令全部在白名單裡。
//   3. 判讀與 log 的內容：.wslconfig 原樣與判讀、記憶體、vmmem、Docker、Ollama、錄製、WSL、Smart App Control（讀不到時寫讀不到）。
//   4. main：寫到 data/logs/wsl_check-日期.log；不是 Windows 時不執行任何指令。
// 不跑 cmd.exe／PowerShell／wsl.exe。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chk = require('../../scripts/desktop/wsl_memory_check');
const w = require('../../scripts/desktop/lib/windows');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const START = Date.parse('2026-09-27T12:00:00Z');
const SELF_PID = 4242;
const WSLCONFIG = 'C:\\Users\\ben\\.wslconfig';

/** Get-Process／CIM 的假輸出（PowerShell ConvertTo-Json） */
function psJson(over = {}) {
    return JSON.stringify({
        totalKB: 16 * 1024 * 1024, freeKB: 5 * 1024 * 1024, commitTotalKB: 24 * 1024 * 1024, commitFreeKB: 8 * 1024 * 1024,
        os: 'Microsoft Windows 11 家用版', osBuild: '26100', availableMB: 6 * 1024,
        processes: [
            { Name: 'vmmemWSL', Id: 5555, WorkingSet64: 2.5 * 1024 ** 3, PrivateMemorySize64: 0.1 * 1024 ** 3, StartTime: '2026-09-27T08:00:00.0000000+08:00' },
            { Name: 'Docker Desktop', Id: 6000, WorkingSet64: 0.2 * 1024 ** 3, PrivateMemorySize64: 0.1 * 1024 ** 3, StartTime: null },
            { Name: 'com.docker.backend', Id: 6001, WorkingSet64: 0.1 * 1024 ** 3, PrivateMemorySize64: 0.1 * 1024 ** 3, StartTime: null },
            { Name: 'ollama app', Id: 7000, WorkingSet64: 0.05 * 1024 ** 3, PrivateMemorySize64: 0.01 * 1024 ** 3, StartTime: null },
            { Name: 'ollama', Id: 7001, WorkingSet64: 5.5 * 1024 ** 3, PrivateMemorySize64: 5.4 * 1024 ** 3, StartTime: null },
            { Name: 'node', Id: SELF_PID, WorkingSet64: 0.05 * 1024 ** 3, PrivateMemorySize64: 0.05 * 1024 ** 3, StartTime: null },
            { Name: 'node', Id: 8000, WorkingSet64: 0.3 * 1024 ** 3, PrivateMemorySize64: 0.3 * 1024 ** 3, StartTime: null },
            { Name: 'python', Id: 9000, WorkingSet64: 1.2 * 1024 ** 3, PrivateMemorySize64: 1.1 * 1024 ** 3, StartTime: null }
        ],
        wslconfigWritten: '2026-09-27T07:30:00.0000000+08:00',
        sacMp: 'Off', sacReg: 0,
        ...over
    });
}

/**
 * 假的 Windows 筆電（介面同 lib/system.js 用到的那幾個方法）。
 * @param {object} [o]
 */
function fakeSys(o = {}) {
    const calls = [];
    const appended = [];
    const files = new Map(Object.entries(o.files || { [WSLCONFIG]: '[wsl2]\r\nmemory=3GB   # DA-14\r\n\r\n[experimental]\r\nautoMemoryReclaim=dropCache\r\n' }));
    const recording = o.recording ? [{ ProcessId: 501, Name: 'cmd.exe', CommandLine: 'cmd.exe /c "D:\\x\\exam_pro\\scripts\\windows\\record_local.bat"' }] : [];
    const sys = {
        platform: o.platform || 'win32',
        env: { USERPROFILE: 'C:\\Users\\ben', PATH: 'C:\\Windows' },
        pid: SELF_PID,
        now: () => START,
        readText: p => (files.has(p) ? files.get(p) : null),
        exists: () => false,
        appendText: (p, s) => appended.push({ p, s }),
        writeText: () => { throw new Error('不應該寫檔'); },
        remove: () => { throw new Error('不應該刪檔'); },
        spawnDetached: async () => { throw new Error('不應該開背景程式'); },
        killPid: () => { throw new Error('不應該結束程序'); },
        async exec(file, args = [], opts = {}) {
            calls.push({ kind: 'exec', file, args, opts });
            if (/powershell/i.test(file)) {
                const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
                if (script === chk.PS_MEMORY_SCRIPT) return o.psFails ? { code: 1, stdout: '', stderr: 'boom', errorCode: null } : { code: 0, stdout: o.ps || psJson(), stderr: '', errorCode: null };
                if (script === w.PS_LIST_PROCESSES) return { code: 0, stdout: JSON.stringify([...recording, { ProcessId: SELF_PID, Name: 'node.exe', CommandLine: 'node scripts\\desktop\\wsl_memory_check.js --scene idle' }]), stderr: '', errorCode: null };
                return { code: 1, stdout: '', stderr: 'unknown script', errorCode: null };
            }
            if (file === 'wsl.exe') {
                if (o.noWsl) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
                const text = args[0] === '--version' ? 'WSL 版本: 2.5.10.0\r\n核心版本: 6.6.87.2-1' : '  NAME              STATE           VERSION\r\n* docker-desktop    Running         2';
                return { code: 0, stdout: text, stderr: '', errorCode: null };
            }
            if (file === 'docker') {
                if (o.noDocker) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
                if (args[0] === '--version') return { code: 0, stdout: 'Docker version 28.0.1', stderr: '', errorCode: null };
                if (o.dockerDown) return { code: 1, stdout: '', stderr: 'error during connect: this error may indicate that the docker daemon is not running', errorCode: null };
                return { code: 0, stdout: 'exam_pg  記憶體 85.3MiB / 2.9GiB（2.87%）  CPU 0.01%\nexam_pg_test  記憶體 40.1MiB / 2.9GiB（1.35%）  CPU 0.00%\n', stderr: '', errorCode: null };
            }
            return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
        },
        async request(req) {
            calls.push({ kind: 'request', ...req });
            if (o.ollamaDown) return { status: null, json: null, text: '', errorCode: 'ECONNREFUSED' };
            return { status: 200, json: { models: [{ name: 'qwen3:8b', size: 6.1 * 1024 ** 3 }] }, text: '', errorCode: null };
        }
    };
    return { sys, calls, appended, files };
}

describe('scripts/windows/wsl_memory_check.bat', () => {
    const buf = fs.readFileSync(path.join(APP_DIR, 'scripts', 'windows', 'wsl_memory_check.bat'));
    const text = buf.toString('utf8');
    const lines = text.split('\r\n');
    const code = lines.filter(l => !/^\s*REM\b/i.test(l));

    test('CRLF、UTF-8 無 BOM、@echo off＋chcp 65001', () => {
        assert.notEqual(buf.subarray(0, 3).toString('hex'), 'efbbbf');
        assert.ok(Buffer.from(text, 'utf8').equals(buf));
        assert.ok(!/[^\r]\n/.test(text), '要 CRLF');
        assert.ok(text.endsWith('\r\n'));
        assert.equal(lines[0], '@echo off');
        assert.equal(lines[1], 'chcp 65001 >nul');
    });

    test('標籤都存在、成功與失敗都 pause＋exit /b；先檢查 node，再以 --scene 呼叫 wsl_memory_check.js', () => {
        const labels = new Set(lines.filter(l => /^:[A-Za-z_]\w*\s*$/.test(l)).map(l => l.trim().slice(1).toLowerCase()));
        for (const m of text.matchAll(/goto\s+:(\w+)/gi)) assert.ok(labels.has(m[1].toLowerCase()), m[1]);
        assert.ok((text.match(/\r\npause\r\nexit \/b [01]\r\n/g) || []).length >= 2);
        assert.ok(text.indexOf('where node') < text.indexOf('wsl_memory_check.js" --scene %SCENE%'));
        assert.match(text, /choice \/c 123 \/n/);
        for (const s of ['idle', 'upload', 'rerecord']) assert.ok(text.includes(`set "SCENE=${s}"`), s);
    });

    test('只讀取：指令行（不含 REM 註解與 echo 的說明文字）沒有 wsl --shutdown、--terminate、taskkill、docker、reg add、寫 .wslconfig', () => {
        const body = code.filter(l => !/^\s*echo\b/i.test(l)).join('\n');
        assert.match(body, /node "%APP%\\scripts\\desktop\\wsl_memory_check\.js"/, '要真的有指令行');
        for (const bad of [/wsl(\.exe)?\s+--(shutdown|terminate|unregister|set)/i, /taskkill/i, /\bdocker\b/i, /\breg\s+(add|delete)/i, /\.wslconfig/i, /\bdel\b/i, /\bnet\s+stop/i]) {
            assert.doesNotMatch(body, bad);
        }
    });

    test('echo 裡沒有會被 cmd 當成轉向或管線的字元', () => {
        for (const line of lines.map(l => l.trim())) {
            if (!/^echo/i.test(line)) continue;
            const bare = line.replace(/"[^"]*"/g, '').replace(/\^[|<>&]/g, '');
            assert.ok(!/[<>|&]/.test(bare), line);
        }
    });

    test('.gitattributes：scripts/windows/*.bat 原樣（-text）進版控', () => {
        assert.match(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8'), /^exam_pro\/scripts\/windows\/\*\.bat -text$/m);
    });
});

describe('只讀取', () => {
    test('PowerShell 只用讀取的 cmdlet（Get-*、Select-Object、Join-Path、ConvertTo-Json），不改設定、不開關程式', () => {
        const cmdlets = new Set([...chk.PS_MEMORY_SCRIPT.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map(m => m[1]));
        const allowed = new Set(['Get-CimInstance', 'Get-Process', 'Select-Object', 'Get-Item', 'Join-Path', 'Get-MpComputerStatus', 'Get-ItemPropertyValue', 'ConvertTo-Json']);
        for (const c of cmdlets) assert.ok(allowed.has(c), `不在白名單：${c}`);
        assert.doesNotMatch(chk.PS_MEMORY_SCRIPT, /\b(Set|New|Remove|Stop|Start|Restart|Invoke|Clear|Add|Rename|Move|Copy|Out)-\w+/);
        assert.doesNotMatch(chk.PS_MEMORY_SCRIPT, /shutdown|terminate|\.Kill\(|Start-Process/i);
        for (const needle of ['vmmemWSL', 'SmartAppControlState', 'VerifiedAndReputablePolicyState', 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', 'Win32_OperatingSystem', '.wslconfig']) {
            assert.ok(chk.PS_MEMORY_SCRIPT.includes(needle), needle);
        }
    });

    test('collect：執行的指令全部在白名單裡（兩段 PowerShell、wsl --version、wsl -l -v、docker --version、docker stats --no-stream、GET /api/ps）', async () => {
        const { sys, calls, appended } = fakeSys();
        await chk.collect({ sys, scene: 'idle' });
        const execs = calls.filter(c => c.kind === 'exec');
        for (const c of execs) {
            const ok = (/powershell/i.test(c.file))
                || (c.file === 'wsl.exe' && (JSON.stringify(c.args) === '["--version"]' || JSON.stringify(c.args) === '["-l","-v"]'))
                || (c.file === 'docker' && (JSON.stringify(c.args) === '["--version"]' || (c.args[0] === 'stats' && c.args[1] === '--no-stream')));
            assert.ok(ok, `不在白名單：${c.file} ${c.args.join(' ')}`);
        }
        const scripts = execs.filter(c => /powershell/i.test(c.file)).map(c => Buffer.from(c.args[c.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'));
        assert.deepEqual(scripts.sort(), [chk.PS_MEMORY_SCRIPT, w.PS_LIST_PROCESSES].sort());
        const reqs = calls.filter(c => c.kind === 'request');
        assert.deepEqual(reqs.map(r => [r.method || 'GET', r.url]), [['GET', 'http://127.0.0.1:11434/api/ps']]);
        assert.equal(appended.length, 0, 'collect 本身不寫檔');
        // wsl.exe 以 UTF-8 輸出（新版認 WSL_UTF8）
        assert.equal(execs.find(c => c.file === 'wsl.exe').opts.env.WSL_UTF8, '1');
    });
});

describe('判讀與 log', () => {
    test('全部讀得到：.wslconfig 原樣＋判讀、記憶體、vmmem、Docker 容器、Ollama 模型、Node／Python（不含自己）、WSL、Smart App Control', async () => {
        const { sys } = fakeSys();
        const text = chk.formatReport(await chk.collect({ sys, scene: 'idle' }));
        assert.match(text, /WSL 記憶體檢查（情況：閒置/);
        assert.match(text, /只讀取與記錄/);
        assert.match(text, /\[\.wslconfig\] C:\\Users\\ben\\\.wslconfig/);
        assert.match(text, /\| memory=3GB {3}# DA-14/);
        assert.match(text, /判讀：\[wsl2\] memory = 3GB；\[experimental\] autoMemoryReclaim = dropCache/);
        assert.match(text, /總計 16\.00 GB；可用 6\.00 GB；使用中 10\.00 GB（63%/);
        assert.match(text, /認可 16\.00 GB ／ 24\.00 GB/);
        assert.match(text, /vmmemWSL（PID 5555）工作集 2\.50 GB/);
        assert.match(text, /虛擬機啟動時間：2026-09-27T08:00:00/);
        assert.doesNotMatch(text, /新設定還沒生效/, '.wslconfig 在虛擬機啟動之前改的：已生效');
        assert.match(text, /\[Docker Desktop\] 在執行/);
        assert.match(text, /exam_pg {2}記憶體 85\.3MiB/);
        assert.match(text, /\[Ollama\] 在執行/);
        assert.match(text, /已載入的模型（http:\/\/127\.0\.0\.1:11434\/api\/ps）：qwen3:8b（6\.10 GB）/);
        assert.match(text, /\[Node\.js\] 1 個，工作集合計 0\.30 GB/);
        assert.doesNotMatch(text, new RegExp(`PID ${SELF_PID}`));
        assert.match(text, /\[Python（OCR）\] 1 個，工作集合計 1\.20 GB/);
        assert.match(text, /\[本機重錄\]\n {2}沒有偵測到/);
        assert.match(text, /WSL 版本: 2\.5\.10\.0/);
        assert.match(text, /docker-desktop {4}Running/);
        assert.match(text, /SmartAppControlState = Off/);
        assert.match(text, /VerifiedAndReputablePolicyState = 0（關閉；0＝關閉、1＝開啟、2＝評估模式）/);
    });

    test('.wslconfig 不存在、改過但還沒生效、沒設上限', async () => {
        const none = chk.formatReport(await chk.collect({ sys: fakeSys({ files: {} }).sys, scene: 'idle' }));
        assert.match(none, /檔案不存在：WSL 用預設值（記憶體上限＝總記憶體的一半/);
        const later = chk.formatReport(await chk.collect({ sys: fakeSys({ ps: psJson({ wslconfigWritten: '2026-09-27T10:00:00.0000000+08:00' }) }).sys, scene: 'idle' }));
        assert.match(later, /\.wslconfig 在虛擬機啟動之後才改過，新設定還沒生效/);
        assert.match(later, /沒有重錄、沒有上傳時 wsl --shutdown/);
        const noLimit = chk.formatReport(await chk.collect({ sys: fakeSys({ files: { [WSLCONFIG]: '[wsl2]\nprocessors=4\n' } }).sys, scene: 'idle' }));
        assert.match(noLimit, /memory = 沒設（預設＝總記憶體的一半）；\[experimental\] autoMemoryReclaim = 沒設/);
    });

    test('Smart App Control：開啟、評估模式；兩種來源都讀不到時寫讀不到', () => {
        assert.match(chk.describeSac({ sacMp: 'On', sacReg: 1 }).join('\n'), /= On[\s\S]*= 1（開啟/);
        assert.match(chk.describeSac({ sacMp: 'Eval', sacReg: 2 }).join('\n'), /= 2（評估模式/);
        const none = chk.describeSac({ sacMpError: '無法辨識 Get-MpComputerStatus', sacRegError: '找不到路徑' }).join('\n');
        assert.match(none, /Get-MpComputerStatus：讀不到（無法辨識 Get-MpComputerStatus）/);
        assert.match(none, /VerifiedAndReputablePolicyState：讀不到（找不到路徑）/);
        assert.match(chk.describeSac({ sacMp: '' }).join('\n'), /沒有 SmartAppControlState 這個欄位[\s\S]*VerifiedAndReputablePolicyState：讀不到/);
    });

    test('Docker、Ollama、wsl 沒在跑或找不到；PowerShell 整段失敗 → 各自寫讀不到，不中斷', async () => {
        const text = chk.formatReport(await chk.collect({ sys: fakeSys({ dockerDown: true, ollamaDown: true, noWsl: true, psFails: true }).sys, scene: 'upload' }));
        assert.match(text, /情況：上傳/);
        assert.match(text, /\[記憶體\]\n {2}讀不到（結束碼 1：boom）/);
        assert.match(text, /\[WSL 虛擬機（vmmem／VmmemWSL）\]\n {2}沒有在執行/);
        assert.match(text, /容器：讀不到（error during connect/);
        assert.match(text, /已載入的模型：讀不到（Ollama 沒有在執行）/);
        assert.match(text, /wsl --version：讀不到（找不到 wsl\.exe）/);
        assert.match(text, /Get-MpComputerStatus：讀不到/);
        assert.match(text, /\[PowerShell\] 讀取失敗/);
        const noDocker = chk.formatReport(await chk.collect({ sys: fakeSys({ noDocker: true }).sys, scene: 'idle' }));
        assert.match(noDocker, /容器：讀不到（找不到 docker 指令）/);
    });

    test('錄製：選「重錄」卻沒偵測到、或偵測到卻不是選「重錄」，都加一句注意', async () => {
        const rec = chk.formatReport(await chk.collect({ sys: fakeSys({ recording: true }).sys, scene: 'rerecord' }));
        assert.match(rec, /偵測到正在執行：\n {4}PID 501 cmd\.exe/);
        assert.doesNotMatch(rec, /注意：/);
        assert.match(chk.formatReport(await chk.collect({ sys: fakeSys().sys, scene: 'rerecord' })), /情況選了「重錄」，但沒有偵測到重錄程序/);
        assert.match(chk.formatReport(await chk.collect({ sys: fakeSys({ recording: true }).sys, scene: 'idle' })), /偵測到重錄正在跑，但情況不是選「重錄」/);
    });

    test('parseArgs、parseWslconfig、cleanWslOutput', () => {
        assert.deepEqual(chk.parseArgs(['--scene', 'Idle']), { scene: 'idle' });
        assert.deepEqual(chk.parseArgs([]), { scene: 'other' });
        assert.equal(chk.parseArgs(['--scene', 'x']).scene, 'other');
        assert.match(chk.parseArgs(['--scene', 'x']).error, /只接受 idle／upload／rerecord/);
        assert.deepEqual(chk.parseWslconfig('\uFEFF# c\n[WSL2]\nMemory = 3GB ; 註解\n[experimental]\nautoMemoryReclaim=dropCache\n'),
            { wsl2: { memory: '3GB' }, experimental: { automemoryreclaim: 'dropCache' } });
        assert.deepEqual(chk.parseWslconfig(null), {});
        assert.equal(chk.cleanWslOutput('W\u0000S\u0000L\u0000\r\n'), 'WSL');
    });
});

describe('main', () => {
    test('寫到 exam_pro/data/logs/wsl_check-日期.log（附加），結束碼 0', async () => {
        const { sys, appended } = fakeSys();
        const saved = console.log;
        const out = [];
        console.log = s => out.push(String(s));
        let code;
        try {
            code = await chk.main(['--scene', 'rerecord'], { sys });
        } finally {
            console.log = saved;
        }
        assert.equal(code, 0);
        assert.equal(appended.length, 1);
        assert.equal(appended[0].p, path.join(APP_DIR, 'data', 'logs', `wsl_check-${w.dateStamp(new Date(START))}.log`));
        assert.match(appended[0].s, /情況：重錄/);
        assert.ok(out.some(s => s.includes('已寫入：')));
    });

    test('不是 Windows → 說明後結束碼 1，不執行任何指令、不寫檔', async () => {
        const { sys, calls, appended } = fakeSys({ platform: 'linux' });
        const saved = console.log;
        console.log = () => { };
        try {
            assert.equal(await chk.main([], { sys }), 1);
        } finally {
            console.log = saved;
        }
        assert.deepEqual(calls, []);
        assert.deepEqual(appended, []);
    });
});
