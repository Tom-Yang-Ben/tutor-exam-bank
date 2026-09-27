// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/windows.js — 桌面啟動器用到的 Windows 知識（純函式，雲端 Linux 也能測）
//
//   - 常見安裝位置：Edge、Chrome、Ollama、Docker CLI；
//   - app 視窗的瀏覽器參數（--app、--user-data-dir）；
//   - 解析 netstat -ano、tasklist /FO CSV、PowerShell ConvertTo-Json 的輸出；
//   - 從程序清單認出「本機重錄正在跑」；
//   - PowerShell 指令的編碼（-EncodedCommand，中文不會因主控台字碼頁變亂碼）與訊息框（WScript.Shell.Popup）。
// 真的去執行這些指令的是 lib/system.js；這裡只產生參數、解讀輸出。
// ─────────────────────────────────────────────────────────────
const path = require('path');

const win = path.win32;

/**
 * 讀 Windows 環境變數（不分大小寫；測試傳一般物件）。
 * @param {Record<string,string|undefined>} env
 * @param {string} name
 * @param {string} [fallback]
 */
function envGet(env, name, fallback = '') {
    if (!env) return fallback;
    if (env[name] !== undefined && env[name] !== '') return String(env[name]);
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    return key && env[key] ? String(env[key]) : fallback;
}

function programFiles(env) { return envGet(env, 'ProgramFiles', 'C:\\Program Files'); }
function programFilesX86(env) { return envGet(env, 'ProgramFiles(x86)', 'C:\\Program Files (x86)'); }
function localAppData(env) {
    const v = envGet(env, 'LOCALAPPDATA');
    if (v) return v;
    const home = envGet(env, 'USERPROFILE', 'C:\\Users\\Default');
    return win.join(home, 'AppData', 'Local');
}

/**
 * 瀏覽器的常見安裝位置（依序找第一個存在的）。
 * @param {'edge'|'chrome'} kind
 * @param {Record<string,string|undefined>} env
 * @returns {string[]}
 */
function browserCandidates(kind, env) {
    if (kind === 'edge') {
        return [
            win.join(programFilesX86(env), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            win.join(programFiles(env), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            win.join(localAppData(env), 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ];
    }
    if (kind === 'chrome') {
        return [
            win.join(programFiles(env), 'Google', 'Chrome', 'Application', 'chrome.exe'),
            win.join(programFilesX86(env), 'Google', 'Chrome', 'Application', 'chrome.exe'),
            win.join(localAppData(env), 'Google', 'Chrome', 'Application', 'chrome.exe')
        ];
    }
    return [];
}

/**
 * 依設定決定依序嘗試哪幾種開法。指定了 edge／chrome 但找不到時仍會退回其他的（啟動器一定要開得出畫面）。
 * @param {'auto'|'edge'|'chrome'|'default'} pref
 * @returns {Array<'edge'|'chrome'|'default'>}
 */
function browserOrder(pref) {
    const auto = ['edge', 'chrome', 'default'];
    if (!pref || pref === 'auto') return auto;
    return [pref, ...auto.filter(k => k !== pref)];
}

/**
 * app 視窗獨立設定檔的資料夾。
 * @param {'edge'|'chrome'} kind
 * @param {{browserProfileDir?:string}} config
 * @param {Record<string,string|undefined>} env
 */
function browserProfileDir(kind, config, env) {
    if (config && config.browserProfileDir) return win.join(config.browserProfileDir, kind);
    return win.join(localAppData(env), 'TutorExamBank', 'browser-profile', kind);
}

/**
 * Edge／Chrome 的 app 模式參數：沒有網址列與分頁、像獨立程式；獨立設定檔不會動到 Owner 平常用的瀏覽器
 * （書籤、登入、擴充功能都分開；平常的瀏覽器開著也不影響）。
 * @param {{url:string, profileDir:string, extra?:string[]}} o
 * @returns {string[]}
 */
function appWindowArgs({ url, profileDir, extra = [] }) {
    return [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...extra
    ];
}

/**
 * Ollama 的常見開法，依序嘗試。
 *   app  ：ollama app.exe（官方安裝檔裝的系統匣程式，會在背景起 ollama serve）
 *   serve：ollama.exe serve（沒有系統匣程式時；輸出寫進 data/logs/ollama-日期.log）
 * @param {{ollamaAppPath?:string}} config
 * @param {Record<string,string|undefined>} env
 * @returns {Array<{method:'app'|'serve', file:string, args:string[], checkExists:boolean}>}
 */
function ollamaCandidates(config, env) {
    const out = [];
    const custom = config && config.ollamaAppPath;
    if (custom) {
        const isServe = /(^|[\\/])ollama(\.exe)?$/i.test(custom);
        out.push({ method: isServe ? 'serve' : 'app', file: custom, args: isServe ? ['serve'] : [], checkExists: true });
        return out;
    }
    const dir = win.join(localAppData(env), 'Programs', 'Ollama');
    out.push({ method: 'app', file: win.join(dir, 'ollama app.exe'), args: [], checkExists: true });
    out.push({ method: 'serve', file: win.join(dir, 'ollama.exe'), args: ['serve'], checkExists: true });
    out.push({ method: 'serve', file: 'ollama', args: ['serve'], checkExists: false });
    return out;
}

/**
 * docker CLI 的候選：設定 → PATH 的 docker → Docker Desktop 旁的 resources\bin\docker.exe。
 * @param {{dockerCliPath?:string, dockerDesktopPath?:string}} config
 * @returns {Array<{file:string, checkExists:boolean}>}
 */
function dockerCliCandidates(config) {
    if (config && config.dockerCliPath) return [{ file: config.dockerCliPath, checkExists: true }];
    const out = [{ file: 'docker', checkExists: false }];
    if (config && config.dockerDesktopPath) {
        out.push({ file: win.join(win.dirname(config.dockerDesktopPath), 'resources', 'bin', 'docker.exe'), checkExists: true });
    }
    return out;
}

// ─────────────────────────── 解析輸出 ───────────────────────────

/**
 * netstat -ano 的輸出 → 在這個埠 LISTEN 的 PID。
 * 不看「LISTENING」這個字（部分語系的 Windows 會翻譯），改看「遠端位址是萬用位址（0.0.0.0:0／[::]:0／*:*）」——只有聆聽中的 socket 是這樣。
 * @param {string} text
 * @param {number} port
 * @returns {number[]} 去重後的 PID
 */
function parseNetstatListeners(text, port) {
    const pids = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const cols = raw.trim().split(/\s+/);
        if (cols.length < 4 || !/^TCP/i.test(cols[0])) continue;
        const local = cols[1];
        const remote = cols[2];
        const pid = Number.parseInt(cols[cols.length - 1], 10);
        const m = local.match(/:(\d+)$/);
        if (!m || Number(m[1]) !== Number(port)) continue;
        if (!/^(0\.0\.0\.0:0|\[::\]:0|\*:\*)$/.test(remote)) continue;
        if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
    }
    return pids;
}

/**
 * tasklist /FI "PID eq n" /FO CSV /NH 的輸出 → 程式名稱（找不到回 null）。
 * @param {string} text
 * @param {number} pid
 */
function parseTasklistName(text, pid) {
    for (const raw of String(text || '').split(/\r?\n/)) {
        const cells = [...raw.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        if (cells.length >= 2 && Number(cells[1]) === Number(pid)) return cells[0];
    }
    return null;
}

/**
 * PowerShell ConvertTo-Json 的程序清單 → [{pid, name, commandLine}]。只有一筆時 PowerShell 回物件而不是陣列，一併處理。
 * @param {string} text
 * @returns {Array<{pid:number, name:string, commandLine:string}>}
 */
function parseProcessJson(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!s) return [];
    const data = JSON.parse(s);
    const list = Array.isArray(data) ? data : [data];
    return list.filter(Boolean).map(p => ({
        pid: Number(p.ProcessId ?? p.pid),
        name: String(p.Name ?? p.name ?? ''),
        commandLine: String(p.CommandLine ?? p.commandLine ?? '')
    }));
}

/**
 * 認得的錄製工具（docs/local-mode.md 第 6 條、10.7）。命中任何一個就算「錄製進行中」。
 *   record_local.bat（cmd.exe /c …\record_local.bat）、npm run cassettes:rerecord、node eval/tools/rerecord_all.js、
 *   npm run eval:record（eval/record_embeddings.js）、scripts/record_cassettes.js。
 */
const RECORDING_PATTERNS = Object.freeze([
    /record_local\.bat/i,
    /cassettes:rerecord/i,
    /rerecord_all\.js/i,
    /record_embeddings\.js/i,
    /eval:record\b/i,
    /record_cassettes\.js/i
]);

/** 只看這幾種程序（PowerShell 自己的命令列裡也有這些字，不能算） */
const RECORDING_PROCESS_NAMES = ['node', 'node.exe', 'cmd', 'cmd.exe', 'npm', 'npm.cmd'];

/**
 * 程序清單裡正在跑的錄製工具。純函式。
 * @param {Array<{pid:number, name:string, commandLine:string}>} list
 * @param {number} [selfPid]
 * @returns {string[]} 命中的程序（「PID 1234 node.exe：命令列前 160 字」）
 */
function findRecordingProcesses(list, selfPid) {
    const out = [];
    for (const p of list || []) {
        if (!p || p.pid === selfPid) continue;
        if (!RECORDING_PROCESS_NAMES.includes(String(p.name || '').toLowerCase())) continue;
        const cmd = String(p.commandLine || '');
        if (!RECORDING_PATTERNS.some(re => re.test(cmd))) continue;
        const short = cmd.length > 160 ? `${cmd.slice(0, 157)}…` : cmd;
        out.push(`PID ${p.pid} ${p.name}：${short}`);
    }
    return out;
}

/**
 * `ps -eo pid=,comm=,args=` 的輸出（非 Windows，給開發機用）→ 程序清單。
 * @param {string} text
 */
function parsePsOutput(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const m = raw.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), name: path.basename(m[2]), commandLine: m[3] });
    }
    return out;
}

// ─────────────────────────── PowerShell ───────────────────────────

/**
 * PowerShell 單引號字串（' 寫兩次；其他字元原樣，包括中文與反斜線）。
 * @param {string} s
 */
function psQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * -EncodedCommand 的參數（UTF-16LE 的 base64）。整段指令不經主控台字碼頁，中文路徑與訊息不會變亂碼。
 * @param {string} script
 */
function encodePowerShell(script) {
    return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 執行 PowerShell 的共同參數（不載入使用者設定檔、不互動）。
 * 刻意**不加** -WindowStyle Hidden：PowerShell 與呼叫它的 node 共用主控台，捷徑開的 node 主控台本來就是隱藏的；
 * 從命令提示字元執行時（install_desktop_shortcut.bat、開發者手動跑）加了反而會把那個視窗藏起來。
 */
function powershellArgs(script) {
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)];
}

/** 輸出一律 UTF-8（管線接到 Node 時，預設會是系統字碼頁） */
const PS_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

/** 列出 node／cmd 程序與命令列（錄製偵測用） */
const PS_LIST_PROCESSES = [
    PS_UTF8,
    "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,Name,CommandLine",
    'if ($p) { $p | ConvertTo-Json -Compress -Depth 2 }'
].join('\n');

/** WScript.Shell.Popup 的按鈕與圖示代碼 */
const POPUP = Object.freeze({
    OK: 0, OK_CANCEL: 1, YES_NO_CANCEL: 3, YES_NO: 4,
    ICON_ERROR: 16, ICON_QUESTION: 32, ICON_WARNING: 48, ICON_INFO: 64,
    TOPMOST: 4096
});
/** Popup 的回傳值 */
const POPUP_RESULT = Object.freeze({ 1: 'ok', 2: 'cancel', 6: 'yes', 7: 'no', '-1': 'timeout' });

/**
 * 訊息框的 PowerShell 指令（WScript.Shell.Popup：Windows 內建、不必安裝任何東西；可設秒數自動關閉；永遠在最上層）。
 * @param {{text:string, title?:string, buttons?:number, icon?:number, seconds?:number}} o
 * @returns {string}
 */
function popupScript({ text, title = '出題系統', buttons = POPUP.OK, icon = POPUP.ICON_INFO, seconds = 0 }) {
    return [
        PS_UTF8,
        '$ws = New-Object -ComObject WScript.Shell',
        `$r = $ws.Popup(${psQuote(text)}, ${Math.max(0, Math.round(seconds))}, ${psQuote(title)}, ${buttons + icon + POPUP.TOPMOST})`,
        'Write-Output $r'
    ].join('\n');
}

/**
 * Popup 的輸出 → 'ok'|'cancel'|'yes'|'no'|'timeout'|null
 * @param {string} stdout
 */
function parsePopupResult(stdout) {
    const m = String(stdout || '').match(/-?\d+/);
    if (!m) return null;
    return POPUP_RESULT[m[0]] || null;
}

/**
 * 在桌面建立（或移除）兩個捷徑的 PowerShell 指令。WScript.Shell 的 CreateShortcut 是 Windows 內建的 COM 元件。
 * 桌面位置用 [Environment]::GetFolderPath('Desktop')：桌面被 OneDrive 接管時也找得到。
 * @param {{shortcuts: Array<{name:string, target:string, args:string, workDir:string, icon:string, description:string}>, remove?: boolean}} o
 * @returns {string}
 */
function shortcutScript({ shortcuts, remove = false }) {
    const lines = [
        PS_UTF8,
        "$ErrorActionPreference = 'Stop'",
        "$desktop = [Environment]::GetFolderPath('Desktop')",
        '$ws = New-Object -ComObject WScript.Shell'
    ];
    for (const s of shortcuts) {
        lines.push(`$p = Join-Path $desktop ${psQuote(`${s.name}.lnk`)}`);
        if (remove) {
            lines.push('if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Output ("REMOVED " + $p) } else { Write-Output ("ABSENT " + $p) }');
            continue;
        }
        lines.push(
            '$s = $ws.CreateShortcut($p)',
            `$s.TargetPath = ${psQuote(s.target)}`,
            `$s.Arguments = ${psQuote(s.args)}`,
            `$s.WorkingDirectory = ${psQuote(s.workDir)}`,
            `$s.IconLocation = ${psQuote(`${s.icon},0`)}`,
            `$s.Description = ${psQuote(s.description)}`,
            '$s.WindowStyle = 1',
            '$s.Save()',
            'Write-Output ("CREATED " + $p)'
        );
    }
    return lines.join('\n');
}

// ─────────────────────────── 其他 ───────────────────────────

const pad = n => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（log 檔名用） */
function dateStamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地時間 YYYY-MM-DD HH:mm:ss（log 每一行開頭） */
function timeStamp(d = new Date()) {
    return `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 後端的 log 裡看得出「埠被佔用」 */
function isAddrInUse(text) {
    return /EADDRINUSE/.test(String(text || ''));
}

/**
 * 文字的最後 n 行（去掉空白行）。
 * @param {string} text
 * @param {number} [n]
 */
function tailLines(text, n = 20) {
    return String(text || '').split(/\r?\n/).filter(l => l.trim()).slice(-n).join('\n');
}

module.exports = {
    envGet, localAppData, browserCandidates, browserOrder, browserProfileDir, appWindowArgs,
    ollamaCandidates, dockerCliCandidates,
    parseNetstatListeners, parseTasklistName, parseProcessJson, parsePsOutput,
    RECORDING_PATTERNS, RECORDING_PROCESS_NAMES, findRecordingProcesses,
    psQuote, encodePowerShell, powershellArgs, PS_UTF8, PS_LIST_PROCESSES,
    POPUP, POPUP_RESULT, popupScript, parsePopupResult, shortcutScript,
    dateStamp, timeStamp, isAddrInUse, tailLines
};
