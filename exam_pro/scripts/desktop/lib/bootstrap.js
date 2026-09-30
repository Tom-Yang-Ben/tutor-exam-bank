// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/bootstrap.js — launch.js 與 stop.js 共用的開頭：路徑、log、設定、.env、埠
//
// 刻意只在函式裡 require 其他模組：捷徑開的 node 沒有主控台，任何一個 require 在最外層失敗都看不到訊息；
// 包在 main() 的 try 裡，錯誤至少會寫進 launcher log，run_hidden.vbs 也會看到非 0 的結束碼而跳訊息框。
// ─────────────────────────────────────────────────────────────
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');

/**
 * @param {'launch'|'stop'} kind
 * @param {{sys?:object}} [o]  測試注入
 */
function bootstrap(kind, o = {}) {
    const { createSystem } = require('./system');
    const w = require('./windows');
    const { appPaths, parseEnvText, effectiveEnv, portFromEnv } = require('./probes');
    const { readConfigFile } = require('./config');

    const sys = o.sys || createSystem();
    const paths = appPaths(APP_DIR);
    const today = w.dateStamp(new Date(sys.now()));
    const launcherLog = path.join(paths.logsDir, `launcher-${today}.log`);
    const serverLog = path.join(paths.logsDir, `server-${today}.log`);
    const log = line => {
        const text = `${w.timeStamp(new Date(sys.now()))} [${kind} ${sys.pid}] ${line}`;
        sys.appendText(launcherLog, `${text}\n`);
        if (process.stdout.isTTY) console.log(text);
    };
    const { config, warnings: configWarnings, found } = readConfigFile(paths.configFile);
    const env = effectiveEnv(parseEnvText(sys.readText(paths.envFile)), sys.env);
    const port = portFromEnv(env);
    return {
        sys, paths, log, config, configWarnings, configFound: found, env, port,
        appUrl: `http://localhost:${port}/`,
        launcherLog, serverLog
    };
}

/**
 * 最後防線：寫 log、印到 stderr，結束碼 1（run_hidden.vbs 看到非 0 會跳訊息框指向 log）。
 * @param {'launch'|'stop'} kind
 * @param {unknown} err
 */
function crash(kind, err) {
    const text = `${new Date().toISOString()} [${kind} ${process.pid}] 未預期的錯誤：${(err && err.stack) || err}\n`;
    try {
        const fs = require('fs');
        const dir = path.join(APP_DIR, 'data', 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        fs.appendFileSync(path.join(dir, `launcher-${stamp}.log`), text, 'utf8');
    } catch (_) { /* 連 log 都寫不進去就只剩 stderr */ }
    process.stderr.write(text);
    process.exit(1);
}

module.exports = { bootstrap, crash, APP_DIR };
