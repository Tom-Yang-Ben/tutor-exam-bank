// ─────────────────────────────────────────────────────────────
// eval/lib/exitAfterFlush.js — 等 stdout／stderr 寫完再 process.exit
//
// stdout 接的是管線（子行程、`| more`、eval/tools/tee_run.js）時，寫入是非同步的：一次 console.log
// 十幾萬位元組，讀的那一端還沒讀完，程式就 process.exit(code)，排在後面的輸出會被直接丟掉。
// `npm run cassettes:prune -- --json`、`npm run cassettes:rerecord -- --dry-run --json` 的 JSON 約 19 萬位元組，
// test/integration/cassetteTools.pg.test.js 因此偶發「Unterminated string in JSON at position 146176」
// （local/integration 上同一支測試單獨跑會過、整批跑時紅；2026-09-26 在 dec/local-embed-thresholds 查到）。
//
// 作法：對每個串流寫一段空字串，它的 callback 在前面排隊的內容都寫出去之後才會被呼叫；全部回來再結束。
// 結束碼與原本 process.exit(code) 完全相同。
// ─────────────────────────────────────────────────────────────

/**
 * @param {number} code 結束碼
 * @param {{streams?:Array<{write:Function}>, exit?:(code:number)=>void}} [opts] 單元測試注入用
 */
function exitAfterFlush(code, { streams = [process.stdout, process.stderr], exit = (c) => process.exit(c) } = {}) {
    let pending = streams.length;
    if (pending === 0) { exit(code); return; }
    let done = false;
    const finish = () => {
        pending -= 1;
        if (pending === 0 && !done) { done = true; exit(code); }
    };
    for (const s of streams) {
        try {
            s.write('', finish);
        } catch {
            finish();              // 串流已關閉（例：讀的那一端先走了）：沒東西可等，照常結束
        }
    }
}

module.exports = { exitAfterFlush };
