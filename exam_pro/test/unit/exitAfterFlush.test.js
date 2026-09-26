// eval/lib/exitAfterFlush.js：等 stdout／stderr 寫完再結束（prune_cassettes.js、rerecord_all.js 的 --json 大輸出）
//
// 重現 test/integration/cassetteTools.pg.test.js 偶發的「Unterminated string in JSON」：子行程 console.log 一大段、
// 讀的那一端還沒讀，直接 process.exit 會丟掉排在後面的輸出；改成 exitAfterFlush 之後一個位元組都不少。
// 不連網、不碰資料庫；子行程的腳本寫在系統暫存目錄。

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { exitAfterFlush } = require('../../eval/lib/exitAfterFlush');

const HELPER = path.resolve(__dirname, '..', '..', 'eval', 'lib', 'exitAfterFlush.js');

describe('exitAfterFlush', () => {
    test('每個串流都寫完（callback 回來）才結束，結束碼原樣；只結束一次', () => {
        const calls = [];
        const pending = [];
        const fake = name => ({ write: (chunk, cb) => { calls.push([name, chunk]); pending.push(cb); } });
        const exits = [];
        exitAfterFlush(3, { streams: [fake('out'), fake('err')], exit: c => exits.push(c) });
        assert.deepEqual(calls, [['out', ''], ['err', '']]);
        assert.deepEqual(exits, []);                       // 還沒寫完，不能結束
        pending[0]();
        assert.deepEqual(exits, []);
        pending[1]();
        assert.deepEqual(exits, [3]);
        pending[1]();                                      // 重複回呼也不會結束第二次
        assert.deepEqual(exits, [3]);
    });

    test('沒有串流、或串流寫入時丟錯：照常結束', () => {
        const exits = [];
        exitAfterFlush(0, { streams: [], exit: c => exits.push(c) });
        exitAfterFlush(1, { streams: [{ write: () => { throw new Error('EPIPE'); } }], exit: c => exits.push(c) });
        assert.deepEqual(exits, [0, 1]);
    });

    describe('真的子行程：讀的一端先暫停，輸出 1 MB', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-flush-'));
        after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        const SIZE = 1024 * 1024;

        /** 跑一支子行程，stdout 先暫停 300 ms 再讀；回傳讀到的位元組數與結束碼 */
        function runChild(body) {
            const file = path.join(tmp, `child-${Math.random().toString(36).slice(2)}.js`);
            fs.writeFileSync(file, `const big = 'x'.repeat(${SIZE});\nprocess.stdout.write(big);\n${body}\n`);
            return new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
                let bytes = 0;
                child.stdout.pause();
                setTimeout(() => { child.stdout.on('data', d => { bytes += d.length; }); child.stdout.resume(); }, 300);
                child.on('error', reject);
                child.on('close', code => resolve({ bytes, code }));
            });
        }

        test('exitAfterFlush：1 MB 一個位元組都不少，結束碼照給', async () => {
            const r = await runChild(`require(${JSON.stringify(HELPER)}).exitAfterFlush(7);`);
            assert.equal(r.bytes, SIZE);
            assert.equal(r.code, 7);
        });
    });
});
