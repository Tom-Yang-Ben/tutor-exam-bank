// ─────────────────────────────────────────────────────────────
// eval/tools/tee_run.js — 跑一個指令，輸出同時印在畫面上並附加到 log 檔（Windows 沒有 tee）
//
// 給 exam_pro\scripts\windows\setup_local_ai.bat 與 record_local.bat 用（本機模式，docs/local-mode.md 第 6 條第 4 點）：
//   node eval\tools\tee_run.js <log 檔> <指令> [參數…]
//   echo yes| node eval\tools\tee_run.js <log 檔> npm run cassettes:rerecord
//
// 行為：
//   - stdin 原樣交給子行程（上面第二行的 yes 因此送得進去）；
//   - stdout／stderr 原樣印在畫面上，同時附加到 log（log 裡去掉 ANSI 色碼；前後各記一行指令與結束碼、時間）；
//   - 結束碼＝子行程的結束碼（被訊號終止或啟動失敗回 1），.bat 用 errorlevel 判斷成敗；
//   - Windows 上經 cmd.exe 啟動（npm 是 npm.cmd，Node 不經 shell 叫不起來），含空白的參數自動加引號。
// 只用 Node 內建模組：在 npm install 之前也能用。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/** 去掉 ANSI 控制碼（色碼、游標移動），log 才讀得懂。純函式。 */
function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Windows cmd.exe 的一個參數：有空白或特殊字元就加雙引號（裡面的雙引號重複一次）。純函式。
 * @param {string} arg
 * @returns {string}
 */
function quoteForCmd(arg) {
    const s = String(arg);
    if (s === '') return '""';
    return /[\s"&|<>^()%!,;=]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 現在時間（本地，YYYY-MM-DD HH:MM:SS） */
function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * @param {string[]} argv [log 檔, 指令, ...參數]
 * @param {{platform?:string, spawnImpl?:Function, stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream}} [io]
 * @returns {Promise<number>} 結束碼
 */
function run(argv, io = {}) {
    const [logFile, cmd, ...args] = argv;
    const out = io.stdout || process.stdout;
    const err = io.stderr || process.stderr;
    if (!logFile || !cmd) {
        err.write('用法：node eval/tools/tee_run.js <log 檔> <指令> [參數…]\n');
        return Promise.resolve(2);
    }
    const platform = io.platform || process.platform;
    const spawnImpl = io.spawnImpl || spawn;
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
    const log = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
    const t0 = Date.now();
    const shown = [cmd, ...args].map(quoteForCmd).join(' ');
    log.write(`\n[${stamp()}] > ${shown}\n`);

    return new Promise((resolve) => {
        let child;
        const finish = (code, why) => {
            log.write(`[${stamp()}] 結束碼 ${code}${why ? `（${why}）` : ''}，${Math.round((Date.now() - t0) / 1000)} 秒\n`);
            log.end(() => resolve(code));
        };
        try {
            child = platform === 'win32'
                ? spawnImpl(shown, [], { shell: true, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: false })
                : spawnImpl(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });
        } catch (e) {
            err.write(`無法啟動「${shown}」：${e.message}\n`);
            finish(1, e.message);
            return;
        }
        const decoders = [];
        const pipe = (stream, target) => {
            if (!stream) return;
            // 一個中文字的 UTF-8 位元組可能被切在兩個 chunk 之間：用 StringDecoder 接起來，log 才不會出現亂碼
            const decoder = new StringDecoder('utf8');
            decoders.push(decoder);
            stream.on('data', (chunk) => {
                target.write(chunk);
                log.write(stripAnsi(decoder.write(chunk)));
            });
        };
        pipe(child.stdout, out);
        pipe(child.stderr, err);
        let done = false;
        child.on('error', (e) => {
            if (done) return;
            done = true;
            err.write(`無法啟動「${shown}」：${e.message}\n`);
            finish(1, e.code || e.message);
        });
        child.on('close', (code, signal) => {
            if (done) return;
            done = true;
            for (const d of decoders) { const rest = d.end(); if (rest) log.write(stripAnsi(rest)); }
            finish(code === null ? 1 : code, signal ? `訊號 ${signal}` : null);
        });
    });
}

if (require.main === module) {
    run(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = { run, stripAnsi, quoteForCmd, stamp };
