// ─────────────────────────────────────────────────────────────
// scripts/desktop/install_shortcuts.js — 在桌面建立「出題系統」「關閉出題系統」兩個捷徑（docs/desktop-launcher.md 第 2 節）
//
// 平常由 scripts\windows\install_desktop_shortcut.bat 呼叫：
//   node scripts\desktop\install_shortcuts.js            建立（已存在就覆蓋）
//   node scripts\desktop\install_shortcuts.js --remove   移除
//   node scripts\desktop\install_shortcuts.js --dry-run  只印出要執行的 PowerShell，不建立（任何平台都能跑）
//
// 捷徑的目標是 Windows 內建的 wscript.exe → scripts\desktop\run_hidden.vbs（隱藏視窗啟動 node，不留黑色主控台）；
// node.exe 用「建立捷徑時的那一支」的完整路徑（process.execPath），之後 PATH 變了也找得到。
// 建立捷徑靠 PowerShell 的 WScript.Shell COM 元件（Windows 內建，不必安裝任何東西）；
// 指令以 -EncodedCommand 傳（UTF-16），中文的捷徑名稱與含中文的專案路徑不會變亂碼。
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const w = require('./lib/windows');

const APP_DIR = path.resolve(__dirname, '..', '..');

/**
 * 兩個捷徑的內容。純函式。
 * @param {{appDir:string, nodePath:string, systemRoot?:string}} o
 */
function shortcutSpecs({ appDir, nodePath, systemRoot = 'C:\\Windows' }) {
    const p = path.win32;
    const desktopDir = p.join(appDir, 'scripts', 'desktop');
    const vbs = p.join(desktopDir, 'run_hidden.vbs');
    const target = p.join(systemRoot, 'System32', 'wscript.exe');
    return [
        {
            name: '出題系統',
            target,
            args: `"${vbs}" launch "${nodePath}"`,
            workDir: appDir,
            icon: p.join(desktopDir, 'assets', 'tutor-exam-bank.ico'),
            description: '開啟家教出題系統（依序準備資料庫、本機 AI、後端，再開操作畫面）'
        },
        {
            name: '關閉出題系統',
            target,
            args: `"${vbs}" stop "${nodePath}"`,
            workDir: appDir,
            icon: p.join(desktopDir, 'assets', 'tutor-exam-bank-stop.ico'),
            description: '關閉出題系統的後端（背景工作先收尾；Docker 與 Ollama 預設不關）'
        }
    ];
}

async function main(argv) {
    const remove = argv.includes('--remove');
    const dryRun = argv.includes('--dry-run');
    const appDir = process.platform === 'win32' ? APP_DIR : 'C:\\path\\to\\exam_pro';
    const specs = shortcutSpecs({
        appDir,
        nodePath: process.platform === 'win32' ? process.execPath : 'C:\\Program Files\\nodejs\\node.exe',
        systemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    });
    const script = w.shortcutScript({ shortcuts: specs, remove });

    if (dryRun || process.platform !== 'win32') {
        if (process.platform !== 'win32') console.log('（不是 Windows：只印出會執行的 PowerShell，不建立捷徑。）\n');
        console.log(script);
        return process.platform === 'win32' || dryRun ? 0 : 1;
    }

    const { createSystem } = require('./lib/system');
    const sys = createSystem();
    const r = await sys.exec('powershell.exe', w.powershellArgs(script), { timeoutMs: 60_000 });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code !== 0) {
        console.error(`建立捷徑失敗（${r.errorCode || `結束碼 ${r.code}`}）：\n${out}`);
        return 1;
    }
    for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
        const m = line.match(/^(CREATED|REMOVED|ABSENT) (.*)$/);
        if (!m) continue;
        const verb = { CREATED: '已建立', REMOVED: '已移除', ABSENT: '本來就沒有' }[m[1]];
        console.log(`${verb}：${m[2]}`);
    }
    if (!remove) {
        console.log(`\n捷徑用的 Node.js：${process.execPath}`);
        console.log('之後點桌面的「出題系統」就會開起整套系統；用完點「關閉出題系統」。說明：docs\\desktop-launcher.md');
    }
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = { shortcutSpecs };
