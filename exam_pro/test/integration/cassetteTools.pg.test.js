// ─────────────────────────────────────────────────────────────
// cassetteTools.pg.test.js — 重錄盤點與過期 cassette 清除的整合測試（〔章節重整 CH-B〕）
//
// 真的以子行程跑 e2e（node --test test/e2e，**需要 PostgreSQL**），透過回放探針記下它讀了哪些 cassette，
// 再照清單刪除——兩支工具（eval/tools/prune_cassettes.js、eval/tools/rerecord_all.js --dry-run）
// 從頭到尾走一遍：CI 的環境、--require 探針傳進 node --test 的子行程、盤點、清單、刪除。
//
// 只動暫存目錄：先把 eval/cassettes/ 整份複製到暫存目錄，EVAL_CASSETTE_DIR 指過去；repo 的 cassette 一支都不碰。
// 斷言只用「不管 CH-A 合入沒有都成立」的性質：
//   CH-A 合入前，e2e 讀得到 extract／lint／verify 的 cassette；合入後 extract 會 miss、下游被擋。
//   兩種狀態下，「命中的檔都在、miss 的檔都不在、沒被讀到的＝全部減掉命中的」都成立。
//
// e2e 會清空並重灌 jobs／questions 等表，與其他整合測試一樣只對 TEST_DATABASE_URL 的 _test 庫動手，
// 而且 npm run test:integration 是 --test-concurrency=1，不會與別支整合測試同時跑。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');

if (!TEST_DATABASE_URL) {
    test('重錄盤點與 cassette 清除（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
} else if (!fs.existsSync(SAMPLE_PDF)) {
    test('重錄盤點與 cassette 清除（需要自製樣卷）', { skip: `找不到 ${SAMPLE_PDF}` }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    const { applyPrune } = require(path.join(APP_DIR, 'eval', 'tools', 'prune_cassettes'));

    let tmp;
    let cassettes;

    /** 在 exam_pro/ 底下跑一支工具，回傳結束碼與輸出 */
    function tool(script, args) {
        const res = spawnSync(process.execPath, [path.join('eval', 'tools', script), ...args], {
            cwd: APP_DIR,
            encoding: 'utf8',
            env: { ...process.env, TEST_DATABASE_URL, EVAL_CASSETTE_DIR: cassettes },
            maxBuffer: 64 * 1024 * 1024
        });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    }

    /** 暫存目錄裡還在的 cassette（agent/key） */
    function onDisk() {
        const out = new Set();
        for (const agent of fs.readdirSync(cassettes)) {
            const dir = path.join(cassettes, agent);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) out.add(`${agent}/${f.slice(0, -5)}`);
        }
        return out;
    }

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cassette-tools-'));
        cassettes = path.join(tmp, 'cassettes');
        fs.cpSync(path.join(APP_DIR, 'eval', 'cassettes'), cassettes, { recursive: true });
    });

    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe('prune_cassettes.js × e2e（CI 的設定、回放探針）', () => {
        let first;

        test('預覽：e2e 真的跑過、每一次回放都被記下；命中的檔都在、miss 的檔都不在', () => {
            const res = tool('prune_cassettes.js', ['--suites', 'e2e', '--json']);
            assert.equal(res.status, 0, res.stderr);
            first = JSON.parse(res.stdout);
            const e2e = first.summary.suites.e2e;
            assert.equal(e2e.ran, true, 'e2e 子行程沒有跑起來');
            assert.ok(e2e.llmCalls > 0, 'e2e 至少會回放一次 extract（樣卷第 1 塊）');
            assert.ok([...e2e.hitKeys, ...e2e.missKeys].some(k => k.startsWith('extract/')), '沒有 extract 的紀錄');
            const disk = onDisk();
            for (const k of e2e.hitKeys) assert.ok(disk.has(k), `命中的 ${k} 不在暫存目錄`);
            for (const k of e2e.missKeys) assert.ok(!disk.has(k), `miss 的 ${k} 竟然在暫存目錄`);
            assert.equal(first.dir, cassettes, '盤點的是 EVAL_CASSETTE_DIR 指的暫存目錄');
        });

        test('清單＝範圍內的全部減掉這一輪命中的；化學／tutor／voice 不在清單', () => {
            const { summary } = first;
            assert.equal(summary.unhit.length, summary.cassettes.total - summary.cassettes.hit);
            const hit = new Set(summary.suites.e2e.hitKeys);
            for (const u of summary.unhit) {
                assert.ok(!hit.has(`${u.agent}/${u.key}`));
                assert.ok(['extract', 'classify', 'lint', 'verify', 'nlq', 'variant'].includes(u.agent), u.agent);
            }
        });

        test('只回放部分 suite 時，--apply 被擋下（結束碼 1），暫存目錄一支都沒少', () => {
            const before = onDisk();
            const res = tool('prune_cassettes.js', ['--suites', 'e2e', '--apply']);
            assert.equal(res.status, 1, res.stdout);
            assert.match(res.stderr, /拒絕刪除/);
            assert.match(res.stderr, /只回放了部分 suite/);
            assert.deepEqual(onDisk(), before);
        });

        test('照清單刪除之後再盤點：沒被讀到的＝0，命中的一支都沒少', () => {
            const out = applyPrune({ dir: cassettes, items: first.summary.unhit });
            assert.equal(out.deleted.length, first.summary.unhit.length);
            assert.deepEqual(out.skipped, []);

            const res = tool('prune_cassettes.js', ['--suites', 'e2e', '--json']);
            assert.equal(res.status, 0, res.stderr);
            const again = JSON.parse(res.stdout);
            assert.equal(again.summary.unhit.length, 0);
            assert.deepEqual(again.summary.suites.e2e.hitKeys, first.summary.suites.e2e.hitKeys);
            assert.deepEqual(again.summary.suites.e2e.missKeys, first.summary.suites.e2e.missKeys);
        });
    });

    describe('rerecord_all.js --dry-run × e2e', () => {
        test('不連網、不寫 cassette；計數與清除工具看到的同一輪一致；e2e 由 pipeline 那一步錄', () => {
            const before = onDisk();
            const res = tool('rerecord_all.js', ['--dry-run', '--suites', 'e2e', '--json']);
            assert.equal(res.status, 0, res.stderr);
            const out = JSON.parse(res.stdout);
            assert.deepEqual(out.steps, ['pipeline', 'e2e-similar']);
            const e2e = out.summary.suites.e2e;
            assert.equal(e2e.ran, true);
            assert.ok(e2e.llmCalls > 0);
            assert.equal(out.summary.cassettes.unhit, 0, '上一段已經照清單清過');
            assert.deepEqual(onDisk(), before, 'dry-run 不得新增或刪除任何 cassette');
            assert.equal(out.summary.estimate.callsLower, 0, 'e2e 自己不錄（LLM_MODE 不是 replay 時它拒絕執行）');
        });
    });
}
