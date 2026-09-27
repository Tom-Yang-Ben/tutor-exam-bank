// ─────────────────────────────────────────────────────────────
// scripts/desktop/wsl_memory_check.js — WSL／Docker 記憶體與 Smart App Control 的檢查（**只讀取與記錄**）
//
// 〔Owner 第六輪 DA-14＝1、DA-9＝1，2026-09-27〕docs/desktop-app-design.md 第 10 節。
// 平常由 scripts\windows\wsl_memory_check.bat 呼叫（雙擊後選情況）：
//   node scripts\desktop\wsl_memory_check.js --scene idle|upload|rerecord
//
// 讀什麼（全部是讀取；沒有任何一步會改設定、開關程式或重啟 WSL）：
//   1. %UserProfile%\.wslconfig 的內容（原樣）與 [wsl2] memory、[experimental] autoMemoryReclaim 的判讀；
//   2. 總記憶體、可用、使用中、認可（Win32_OperatingSystem、Win32_PerfFormattedData_PerfOS_Memory）；
//   3. vmmem／VmmemWSL（WSL 虛擬機）、Docker Desktop、Ollama、node、python 各程序的記憶體（Get-Process）；
//   4. Docker 容器各自的記憶體（docker stats --no-stream；Docker 沒開就記「沒在執行」）；
//      Docker 看到的總記憶體（docker info --format {{.MemTotal}}＝WSL 虛擬機的記憶體；和 .wslconfig 的 memory 比，
//      是「上限生效了沒」的直接證據）；Ollama 已載入的模型（GET /api/ps）；
//   5. 有沒有本機重錄正在跑（與桌面啟動器同一套程序比對，lib/windows.js 的 RECORDING_PATTERNS）；
//   6. wsl --version、wsl -l -v（版本與各發行版是否在跑；這兩個指令不會啟動或停止 WSL）；
//   7. Smart App Control：Get-MpComputerStatus 的 SmartAppControlState，以及登錄
//      HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy 的 VerifiedAndReputablePolicyState；讀不到就寫讀不到。
// 結果附加到 exam_pro\data\logs\wsl_check-日期.log（同一天跑幾次都接在後面），畫面也印一份。
//
// 刻意不做：wsl --shutdown、改 .wslconfig、開關 Docker Desktop／Ollama、docker 的任何寫入指令。
// .wslconfig 怎麼改、什麼時候可以 wsl --shutdown，寫在 docs/desktop-app-design.md 第 10 節（Owner 手動做）。
// I/O 全部經注入的 sys（lib/system.js）；單元測試換成假的（test/unit/wslMemoryCheck.test.js），並斷言只執行白名單內的讀取指令。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const w = require('./lib/windows');

const APP_DIR = path.resolve(__dirname, '..', '..');

/** 三種情況（DA-14 的量測表）；other＝沒指定 */
const SCENES = Object.freeze({
    idle: '閒置（Docker 開著，沒有上傳、沒有重錄）',
    upload: '上傳（正在拆一份考卷）',
    rerecord: '重錄（record_local.bat 正在跑）',
    other: '沒有指定'
});

/** 要看記憶體的程序（Get-Process -Name；不分大小寫，不存在的名稱略過） */
const PROCESS_NAMES = Object.freeze([
    'vmmem', 'vmmemWSL',
    'Docker Desktop', 'com.docker.backend', 'com.docker.build',
    'ollama', 'ollama app', 'ollama_llama_server',
    'node', 'python'
]);

/**
 * 讀記憶體、程序與 Smart App Control 的 PowerShell（只有 Get-* 與讀屬性；輸出一段 JSON）。
 * 每一項各自 try／catch：某一項讀不到只記原因，不影響其他項。
 */
const PS_MEMORY_SCRIPT = [
    w.PS_UTF8,
    "$ErrorActionPreference = 'Stop'",
    '$r = [ordered]@{}',
    'try { $os = Get-CimInstance Win32_OperatingSystem; $r.totalKB = [int64]$os.TotalVisibleMemorySize; $r.freeKB = [int64]$os.FreePhysicalMemory; ' +
        '$r.commitTotalKB = [int64]$os.TotalVirtualMemorySize; $r.commitFreeKB = [int64]$os.FreeVirtualMemory; $r.os = [string]$os.Caption; $r.osBuild = [string]$os.BuildNumber } ' +
        'catch { $r.osError = $_.Exception.Message }',
    'try { $pm = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $r.availableMB = [int64]$pm.AvailableMBytes } catch { $r.perfError = $_.Exception.Message }',
    `$names = @(${PROCESS_NAMES.map(n => w.psQuote(n)).join(', ')})`,
    "$r.processes = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object Name, Id, WorkingSet64, PrivateMemorySize64, " +
        "@{ n = 'StartTime'; e = { try { $_.StartTime.ToString('o') } catch { $null } } })",
    "try { $cfg = Get-Item -LiteralPath (Join-Path $env:USERPROFILE '.wslconfig'); $r.wslconfigWritten = $cfg.LastWriteTime.ToString('o') } catch { $r.wslconfigWritten = $null }",
    'try { $mp = Get-MpComputerStatus; $r.sacMp = [string]$mp.SmartAppControlState } catch { $r.sacMpError = $_.Exception.Message }',
    "try { $r.sacReg = Get-ItemPropertyValue -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -Name 'VerifiedAndReputablePolicyState' } " +
        'catch { $r.sacRegError = $_.Exception.Message }',
    '$r | ConvertTo-Json -Depth 4 -Compress'
].join('\n');

/** 登錄 VerifiedAndReputablePolicyState 的值 → 狀態 */
const SAC_REG_STATES = Object.freeze({ 0: '關閉', 1: '開啟', 2: '評估模式' });

/** docker info 只取這一個欄位（位元組；Docker Desktop 的 WSL 2 後端＝WSL 虛擬機的總記憶體） */
const DOCKER_MEM_ARGS = Object.freeze(['info', '--format', '{{.MemTotal}}']);

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 命令列參數。純函式。
 * @param {string[]} argv
 * @returns {{scene:keyof typeof SCENES, error?:string}}
 */
function parseArgs(argv) {
    const i = argv.indexOf('--scene');
    const raw = i >= 0 ? String(argv[i + 1] || '').trim().toLowerCase() : '';
    if (!raw) return { scene: 'other' };
    if (Object.prototype.hasOwnProperty.call(SCENES, raw)) return { scene: raw };
    return { scene: 'other', error: `--scene 只接受 idle／upload／rerecord（收到「${raw}」）` };
}

/**
 * .wslconfig（INI）→ { 區段: { 鍵: 值 } }。區段與鍵一律小寫；# 與 ; 開頭是註解。純函式。
 * @param {string|null} text
 */
function parseWslconfig(text) {
    const out = {};
    let section = '';
    for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const sec = line.match(/^\[([^\]]+)\]$/);
        if (sec) { section = sec[1].trim().toLowerCase(); continue; }
        const kv = line.match(/^([^=]+?)\s*=\s*(.*?)\s*(?:[#;].*)?$/);
        if (!kv) continue;
        (out[section] = out[section] || {})[kv[1].trim().toLowerCase()] = kv[2];
    }
    return out;
}

/**
 * .wslconfig 的大小寫法 → 位元組（1024 進位；沒寫單位＝位元組，WSL 的規則）。看不懂回 null。純函式。
 * 例：3GB、3 GB、3072MB、3G、3221225472
 * @param {string|undefined|null} value
 * @returns {number|null}
 */
function parseSizeBytes(value) {
    const m = String(value === undefined || value === null ? '' : value).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i);
    if (!m) return null;
    const pow = { '': 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase()];
    const n = Number(m[1]) * 1024 ** pow;
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** 位元組 → 「2.41 GB」 */
function gb(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n)) return '（不明）';
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * wsl.exe 的輸出：舊版以 UTF-16LE 輸出（被當成 UTF-8 讀會夾著 NUL），WSL_UTF8=1 時是 UTF-8。純函式。
 * @param {string} s
 */
function cleanWslOutput(s) {
    return String(s || '').replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r/g, '').trim();
}

/**
 * Smart App Control 的判讀。純函式。
 * @param {{sacMp?:string, sacMpError?:string, sacReg?:number|string, sacRegError?:string}} ps
 * @returns {string[]}
 */
function describeSac(ps) {
    const lines = [];
    if (ps.sacMpError) lines.push(`Get-MpComputerStatus：讀不到（${ps.sacMpError}）`);
    else if (ps.sacMp === undefined || ps.sacMp === null || ps.sacMp === '') lines.push('Get-MpComputerStatus：讀不到（這台電腦的 Defender 沒有 SmartAppControlState 這個欄位）');
    else lines.push(`Get-MpComputerStatus：SmartAppControlState = ${ps.sacMp}`);
    if (ps.sacRegError) lines.push(`登錄 VerifiedAndReputablePolicyState：讀不到（${ps.sacRegError}）`);
    else if (ps.sacReg === undefined || ps.sacReg === null || ps.sacReg === '') lines.push('登錄 VerifiedAndReputablePolicyState：讀不到');
    else lines.push(`登錄 VerifiedAndReputablePolicyState = ${ps.sacReg}（${SAC_REG_STATES[Number(ps.sacReg)] || '不認得的值'}；0＝關閉、1＝開啟、2＝評估模式）`);
    return lines;
}

/**
 * 把收集到的資料排成 log 的一段。純函式（時間由 report.at 帶進來）。
 * @param {object} report  collect() 的結果
 * @returns {string}
 */
function formatReport(report) {
    const L = [];
    const ps = report.ps || {};
    L.push(`===== ${report.at} WSL 記憶體檢查（情況：${SCENES[report.scene] || report.scene}）=====`);
    L.push('（只讀取與記錄：沒有改任何設定、沒有執行 wsl --shutdown、沒有開關任何程式）');

    // 1. .wslconfig
    L.push('', `[.wslconfig] ${report.wslconfig.path}`);
    if (report.wslconfig.text === null) {
        L.push('  檔案不存在：WSL 用預設值（記憶體上限＝總記憶體的一半；autoMemoryReclaim 依 WSL 版本的預設）');
    } else {
        L.push('  ---- 內容（原樣）----');
        for (const line of report.wslconfig.text.replace(/^\uFEFF/, '').split(/\r?\n/)) L.push(`  | ${line}`);
        L.push('  ---- 內容結束 ----');
        const cfg = parseWslconfig(report.wslconfig.text);
        const mem = cfg.wsl2 && cfg.wsl2.memory;
        const reclaim = cfg.experimental && cfg.experimental.automemoryreclaim;
        L.push(`  判讀：[wsl2] memory = ${mem || '沒設（預設＝總記憶體的一半）'}；[experimental] autoMemoryReclaim = ${reclaim || '沒設（依 WSL 版本的預設）'}`);
        if (ps.wslconfigWritten) L.push(`  最後修改：${ps.wslconfigWritten}`);
    }

    // 2. 記憶體
    L.push('', '[記憶體]');
    if (!Number(ps.totalKB)) {
        L.push(`  讀不到（${ps.osError || report.psError || '沒有資料'}）`);
    } else {
        const total = Number(ps.totalKB) * 1024;
        const avail = ps.availableMB !== undefined && ps.availableMB !== null && Number.isFinite(Number(ps.availableMB))
            ? Number(ps.availableMB) * 1024 ** 2 : Number(ps.freeKB) * 1024;
        const used = total - avail;
        const pct = total > 0 ? Math.round((used / total) * 100) : NaN;
        L.push(`  總計 ${gb(total)}；可用 ${gb(avail)}；使用中 ${gb(used)}（${Number.isFinite(pct) ? `${pct}%` : '不明'}；≈ 工作管理員「效能 → 記憶體 → 使用中」）`);
        if (ps.commitTotalKB) L.push(`  認可 ${gb((Number(ps.commitTotalKB) - Number(ps.commitFreeKB)) * 1024)} ／ ${gb(Number(ps.commitTotalKB) * 1024)}`);
        if (ps.os) L.push(`  作業系統：${ps.os}（組建 ${ps.osBuild || '不明'}）`);
    }

    // 3. 程序
    const procs = (Array.isArray(ps.processes) ? ps.processes : (ps.processes ? [ps.processes] : []))
        .filter(p => p && Number(p.Id) !== Number(report.selfPid));
    const pick = re => procs.filter(p => re.test(String(p.Name || '')));
    const describe = list => list.map(p => `${p.Name}（PID ${p.Id}）工作集 ${gb(p.WorkingSet64)}、私有 ${gb(p.PrivateMemorySize64)}`);
    const sum = list => list.reduce((a, p) => a + (Number(p.WorkingSet64) || 0), 0);

    const vm = pick(/^vmmem(wsl)?$/i);
    L.push('', '[WSL 虛擬機（vmmem／VmmemWSL）]');
    if (vm.length) {
        L.push(...describe(vm).map(s => `  ${s}`));
        // 〔審查 dec/r7-decisions-host〕讀不到啟動時間（一般權限可能打不開 vmmem 這類程序）時要明寫無法判斷，
        // 不可以什麼都不印：10.2 第 9 步原本把「沒出現『還沒生效』」當成生效的證據。直接證據改看下面 docker info 的 MemTotal。
        const startedList = vm.map(p => ({ raw: p.StartTime, ms: Date.parse(p.StartTime) })).filter(x => x.raw && Number.isFinite(x.ms));
        startedList.sort((a, b) => a.ms - b.ms);
        const started = startedList[0];
        const writtenMs = ps.wslconfigWritten ? Date.parse(ps.wslconfigWritten) : NaN;
        if (started) L.push(`  虛擬機啟動時間：${started.raw}`);
        if (report.wslconfig.text !== null) {
            if (!started) {
                L.push('  讀不到虛擬機的啟動時間，無法用時間判斷 .wslconfig 是否已生效（改看下面「[.wslconfig 是否生效]」的 Docker 記憶體）');
            } else if (!Number.isFinite(writtenMs)) {
                L.push('  讀不到 .wslconfig 的修改時間，無法用時間判斷 .wslconfig 是否已生效（改看下面「[.wslconfig 是否生效]」的 Docker 記憶體）');
            } else if (writtenMs > started.ms) {
                L.push('  注意：.wslconfig 在虛擬機啟動之後才改過，新設定還沒生效（要在沒有重錄、沒有上傳時 wsl --shutdown 再開 Docker，見 docs/desktop-app-design.md 第 10 節）');
            } else {
                L.push('  依時間判斷：.wslconfig 在虛擬機啟動之前就改好了，新設定應已生效（直接證據看下面「[.wslconfig 是否生效]」）');
            }
        }
    } else {
        L.push('  沒有在執行（Docker Desktop 沒開，或 WSL 虛擬機已經停了）');
    }

    // .wslconfig 的 memory 生效了沒：Docker 看到的總記憶體（docker info 的 MemTotal）＝WSL 虛擬機的記憶體，
    // 上限生效時不會超過 memory（核心會先保留一部分，所以略小一點）。
    L.push('', '[.wslconfig 是否生效（docker info 的 MemTotal＝Docker 看到的 WSL 虛擬機記憶體）]');
    const dm = report.dockerMem;
    if (!dm || !dm.ok) {
        L.push(`  讀不到（${(dm && dm.error) || '沒有執行'}）：無法用這個方法判斷（Docker Desktop 開著、引擎在跑時再量一次）`);
    } else {
        L.push(`  Docker 看到的記憶體：${gb(dm.bytes)}`);
        const cfg = report.wslconfig.text === null ? {} : parseWslconfig(report.wslconfig.text);
        const memRaw = cfg.wsl2 && cfg.wsl2.memory;
        const limit = parseSizeBytes(memRaw);
        if (!memRaw) {
            const total = Number(ps.totalKB) * 1024;
            L.push(`  判讀：.wslconfig 沒設 memory，WSL 的預設上限是總記憶體的一半${total > 0 ? `（約 ${gb(total / 2)}）` : ''}`);
        } else if (limit === null) {
            L.push(`  判讀：看不懂 .wslconfig 的 memory＝「${memRaw}」，無法比對（寫法例：memory=3GB）`);
        } else if (dm.bytes <= limit) {
            L.push(`  判讀：不超過 .wslconfig 的 memory＝${memRaw}（${gb(limit)}）→ 上限已生效（略小於上限是正常的，核心會先保留一部分）`);
        } else {
            L.push(`  判讀：比 .wslconfig 的 memory＝${memRaw}（${gb(limit)}）大 → 上限還沒生效（要在沒有重錄、沒有上傳時 wsl --shutdown 再開 Docker，見 docs/desktop-app-design.md 第 10 節）`);
        }
    }

    const docker = pick(/^(docker desktop|com\.docker\.)/i);
    L.push('', `[Docker Desktop] ${docker.length ? '在執行' : '沒有在執行'}`);
    L.push(...describe(docker).map(s => `  ${s}`));
    if (report.dockerStats) {
        if (report.dockerStats.ok) {
            L.push('  容器（docker stats --no-stream）：');
            L.push(...(report.dockerStats.lines.length ? report.dockerStats.lines.map(s => `    ${s}`) : ['    （沒有執行中的容器）']));
        } else {
            L.push(`  容器：讀不到（${report.dockerStats.error}）`);
        }
    }

    const ollama = pick(/^ollama/i);
    L.push('', `[Ollama] ${ollama.length ? '在執行' : '沒有在執行'}`);
    L.push(...describe(ollama).map(s => `  ${s}`));
    if (report.ollamaPs) {
        if (report.ollamaPs.ok) {
            const models = report.ollamaPs.models;
            L.push(`  已載入的模型（${report.ollamaPs.url}/api/ps）：${models.length ? models.map(m => `${m.name}（${gb(m.size)}）`).join('、') : '沒有'}`);
        } else {
            L.push(`  已載入的模型：讀不到（${report.ollamaPs.error}）`);
        }
    }

    const nodes = pick(/^node$/i);
    const pys = pick(/^python/i);
    L.push('', `[Node.js] ${nodes.length} 個，工作集合計 ${gb(sum(nodes))}（不含這支檢查本身）`);
    L.push(...describe(nodes).map(s => `  ${s}`));
    L.push(`[Python（OCR）] ${pys.length} 個，工作集合計 ${gb(sum(pys))}`);
    L.push(...describe(pys).map(s => `  ${s}`));

    // 5. 錄製
    L.push('', '[本機重錄]');
    const rec = report.recording || {};
    if (rec.active === null) L.push(`  無法確認（${rec.error || '讀不到程序清單'}）`);
    else if (rec.active) L.push('  偵測到正在執行：', ...rec.matches.map(m => `    ${m}`));
    else L.push('  沒有偵測到');
    if (report.scene === 'rerecord' && rec.active === false) L.push('  注意：情況選了「重錄」，但沒有偵測到重錄程序');
    if (report.scene !== 'rerecord' && rec.active === true) L.push('  注意：偵測到重錄正在跑，但情況不是選「重錄」');

    // 6. WSL
    L.push('', '[WSL]');
    for (const [label, r] of [['wsl --version', report.wslVersion], ['wsl -l -v', report.wslList]]) {
        if (!r) continue;
        if (r.ok) {
            L.push(`  ${label}：`);
            L.push(...(r.text ? r.text.split('\n').map(s => `    ${s}`) : ['    （沒有輸出）']));
        } else {
            L.push(`  ${label}：讀不到（${r.error}）`);
        }
    }

    // 7. Smart App Control
    L.push('', '[Smart App Control]（DA-9 的前提：要是關閉）');
    L.push(...describeSac(ps).map(s => `  ${s}`));
    if (report.psError) L.push('', `[PowerShell] 讀取失敗：${report.psError}`);
    if (report.argError) L.push('', `[參數] ${report.argError}`);
    L.push('');
    return L.join('\n');
}

// ─────────────────────────── 讀取（經注入的 sys）───────────────────────────

/**
 * 收集所有資料。只呼叫讀取類指令（單元測試斷言白名單）。
 * @param {object} o
 * @param {ReturnType<import('./lib/system').createSystem>} o.sys
 * @param {keyof typeof SCENES} o.scene
 * @param {object} [o.config]  lib/config.js 的設定（找 docker CLI 用）
 * @param {Record<string,string>} [o.env]  effectiveEnv()（OLLAMA_HOST）
 */
async function collect({ sys, scene, config = {}, env = {} }) {
    const report = { at: w.timeStamp(new Date(sys.now())), scene, selfPid: sys.pid };

    const profile = w.envGet(sys.env, 'USERPROFILE', 'C:\\Users\\Default');
    const cfgPath = path.win32.join(profile, '.wslconfig');
    report.wslconfig = { path: cfgPath, text: sys.readText(cfgPath) };

    const ps = await sys.exec('powershell.exe', w.powershellArgs(PS_MEMORY_SCRIPT), { timeoutMs: 90_000 });
    if (ps.code === 0) {
        try {
            report.ps = JSON.parse(String(ps.stdout).replace(/^\uFEFF/, '').trim() || '{}');
        } catch (err) {
            report.ps = {};
            report.psError = `輸出不是 JSON（${err.message}）`;
        }
    } else {
        report.ps = {};
        report.psError = ps.errorCode || `結束碼 ${ps.code}：${w.tailLines(ps.stderr, 3)}`;
    }

    // 錄製偵測：與桌面啟動器同一套（lib/windows.js）
    const pl = await sys.exec('powershell.exe', w.powershellArgs(w.PS_LIST_PROCESSES), { timeoutMs: 45_000 });
    if (pl.code === 0) {
        try {
            const matches = w.findRecordingProcesses(w.parseProcessJson(pl.stdout), sys.pid);
            report.recording = { active: matches.length > 0, matches };
        } catch (err) {
            report.recording = { active: null, error: err.message };
        }
    } else {
        report.recording = { active: null, error: pl.errorCode || `PowerShell 結束碼 ${pl.code}` };
    }

    // wsl.exe：--version、-l -v（都不會啟動或停止 WSL）。WSL_UTF8=1 讓新版輸出 UTF-8。
    const wslEnv = { ...sys.env, WSL_UTF8: '1' };
    for (const [key, args] of [['wslVersion', ['--version']], ['wslList', ['-l', '-v']]]) {
        const r = await sys.exec('wsl.exe', args, { timeoutMs: 30_000, env: wslEnv });
        report[key] = r.code === 0
            ? { ok: true, text: cleanWslOutput(r.stdout) }
            : { ok: false, error: r.errorCode === 'ENOENT' ? '找不到 wsl.exe' : `${r.errorCode || `結束碼 ${r.code}`} ${cleanWslOutput(r.stdout || r.stderr).split('\n')[0] || ''}`.trim() };
    }

    // docker stats --no-stream（只讀）：找得到 docker CLI 才跑。找法與啟動器相同（PATH → Docker Desktop 旁的 resources\bin）
    let dockerCli = null;
    for (const c of w.dockerCliCandidates({ dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', ...config })) {
        if (c.checkExists && !sys.exists(c.file)) continue;
        const v = await sys.exec(c.file, ['--version'], { timeoutMs: 15_000 });
        if (v.errorCode === 'ENOENT') continue;
        dockerCli = c.file;
        break;
    }
    if (dockerCli) {
        // Docker 看到的總記憶體（只讀）：.wslconfig 的 memory 生效了沒的直接證據
        const mi = await sys.exec(dockerCli, [...DOCKER_MEM_ARGS], { timeoutMs: 45_000 });
        const memText = String(mi.stdout || '').trim();
        report.dockerMem = mi.code === 0 && /^\d+$/.test(memText)
            ? { ok: true, bytes: Number(memText) }
            : { ok: false, error: mi.errorCode === 'ENOENT' ? '找不到 docker 指令' : (mi.code === 0 ? `輸出不是數字：${memText.slice(0, 80)}` : (w.tailLines(mi.stderr || mi.stdout, 1) || `結束碼 ${mi.code}`)) };
        const r = await sys.exec(dockerCli, ['stats', '--no-stream', '--format', '{{.Name}}  記憶體 {{.MemUsage}}（{{.MemPerc}}）  CPU {{.CPUPerc}}'], { timeoutMs: 45_000 });
        report.dockerStats = r.code === 0
            ? { ok: true, lines: String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
            : { ok: false, error: r.errorCode === 'ENOENT' ? '找不到 docker 指令' : (w.tailLines(r.stderr || r.stdout, 1) || `結束碼 ${r.code}`) };
    } else {
        report.dockerStats = { ok: false, error: '找不到 docker 指令' };
        report.dockerMem = { ok: false, error: '找不到 docker 指令' };
    }

    // Ollama 已載入的模型（GET /api/ps，只讀）
    let url = 'http://127.0.0.1:11434';
    try { url = require(path.join(APP_DIR, 'services', 'llm', 'ollama')).resolveHost(env || {}).url; } catch (_) { /* 用預設 */ }
    const r = await sys.request({ url: `${url}/api/ps`, timeoutMs: 5000 });
    report.ollamaPs = r.status === 200 && r.json
        ? { ok: true, url, models: (Array.isArray(r.json.models) ? r.json.models : []).map(m => ({ name: String(m.name || m.model || '?'), size: m.size })) }
        : { ok: false, url, error: r.errorCode === 'ECONNREFUSED' ? 'Ollama 沒有在執行' : (r.errorCode || `HTTP ${r.status}`) };

    return report;
}

/**
 * @param {string[]} argv
 * @param {{sys?:object}} [o]  測試注入
 * @returns {Promise<number>} 結束碼
 */
async function main(argv, o = {}) {
    const { scene, error: argError } = parseArgs(argv);
    const { createSystem } = require('./lib/system');
    const sys = o.sys || createSystem();
    if (sys.platform !== 'win32') {
        console.log('這支檢查只在 Windows 上執行（要讀 WSL、Docker Desktop 與 Smart App Control）。');
        return 1;
    }
    const { appPaths, parseEnvText, effectiveEnv } = require('./lib/probes');
    const { readConfigFile } = require('./lib/config');
    const paths = appPaths(APP_DIR);
    const { config } = readConfigFile(paths.configFile);
    const env = effectiveEnv(parseEnvText(sys.readText(paths.envFile)), sys.env);

    console.log('讀取中（大約 10～60 秒；只讀取，不會改任何設定）…');
    const report = await collect({ sys, scene, config, env });
    if (argError) report.argError = argError;
    const text = formatReport(report);
    const logFile = path.join(paths.logsDir, `wsl_check-${w.dateStamp(new Date(sys.now()))}.log`);
    sys.appendText(logFile, `${text}\n`);
    console.log(text);
    console.log(`已寫入：${logFile}`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = {
    SCENES, PROCESS_NAMES, PS_MEMORY_SCRIPT, SAC_REG_STATES, DOCKER_MEM_ARGS,
    parseArgs, parseWslconfig, parseSizeBytes, cleanWslOutput, describeSac, formatReport, collect, main
};
