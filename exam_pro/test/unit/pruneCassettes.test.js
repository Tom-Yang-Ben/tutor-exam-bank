// ─────────────────────────────────────────────────────────────
// test/unit/pruneCassettes.test.js — 過期 cassette 清除工具（eval/tools/prune_cassettes.js）
//
// 不跑任何 suite：只驗參數、--apply 的保護條件，以及「只刪範圍內 agent 的 cassette 檔」。
// 真的以回放探針跑 e2e、再照清單刪除的端到端流程在 test/integration/cassetteTools.pg.test.js。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prune = require('../../eval/tools/prune_cassettes');
const audit = require('../../eval/lib/cassetteAudit');
const { ALL_SUITES } = require('../../eval/lib/suiteProcess');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 造一份「每個 suite 都跑過」的摘要，再依參數弄壞某一處 */
function summaryOf({ misses = {}, llmCalls = {}, ran = {}, errors = {} } = {}) {
    const events = [];
    for (const s of ALL_SUITES) {
        if (ran[s] !== false) events.push({ suite: s, kind: 'start' });
        const calls = llmCalls[s] ?? (s === 'retrieval' ? 0 : 2);
        for (let i = 0; i < calls; i++) events.push({ suite: s, kind: 'llm', agent: 'classify', model: 'm', key: `${s}${i}`, hit: true });
        for (let i = 0; i < (misses[s] || 0); i++) events.push({ suite: s, kind: 'llm', agent: 'classify', model: 'm', key: `${s}miss${i}`, hit: false });
        if (errors[s]) events.push({ suite: s, kind: 'llm', agent: 'classify', model: 'm', key: null, hit: false, error: errors[s] });
    }
    return audit.summarize({ events, entries: [], suites: ALL_SUITES });
}

describe('parseArgs', () => {
    test('預設只預覽；--apply／--allow-misses／--suites／--json', () => {
        assert.deepEqual(prune.parseArgs([]), { apply: false, allowMisses: false, suites: ALL_SUITES.slice(), json: false, help: false });
        assert.equal(prune.parseArgs(['--apply']).apply, true);
        assert.equal(prune.parseArgs(['--apply', '--allow-misses']).allowMisses, true);
        assert.deepEqual(prune.parseArgs(['--suites', 'e2e,retrieval']).suites, ['retrieval', 'e2e']);
        assert.throws(() => prune.parseArgs(['--json', '--apply']), /預覽/);
        assert.throws(() => prune.parseArgs(['--suites', 'x']), /不存在/);
        assert.throws(() => prune.parseArgs(['--force']), /未知的參數/);
    });
});

describe('pruneGuard：--apply 的保護條件', () => {
    test('全部 suite 都跑過、沒有 miss、沒有錯誤 → 可以刪', () => {
        assert.deepEqual(prune.pruneGuard({ summary: summaryOf(), suites: ALL_SUITES }), []);
    });

    test('還有 replay miss（重錄還沒做完）→ 拒絕；--allow-misses 才放行', () => {
        const summary = summaryOf({ misses: { classify: 3 } });
        const reasons = prune.pruneGuard({ summary, suites: ALL_SUITES });
        assert.equal(reasons.length, 1);
        assert.match(reasons[0], /還有 3 筆 replay miss/);
        assert.deepEqual(prune.pruneGuard({ summary, suites: ALL_SUITES, allowMisses: true }), []);
    });

    test('只跑了部分 suite → 拒絕（沒跑到的 suite 讀的 cassette 會被誤判成過期）；--allow-misses 也不放行', () => {
        const reasons = prune.pruneGuard({ summary: summaryOf(), suites: ['classify', 'e2e'], allowMisses: true });
        assert.ok(reasons.some(r => r.includes('只回放了部分 suite')), reasons.join('\n'));
    });

    test('e2e 一筆回放紀錄都沒有（多半是沒設 TEST_DATABASE_URL）→ 拒絕；retrieval 本來就不呼叫 LLM，不算', () => {
        const reasons = prune.pruneGuard({ summary: summaryOf({ llmCalls: { e2e: 0 } }), suites: ALL_SUITES });
        assert.equal(reasons.length, 1);
        assert.match(reasons[0], /^e2e：一筆回放紀錄都沒有.*TEST_DATABASE_URL/);
    });

    test('子行程沒跑起來、或有 miss 以外的錯誤 → 拒絕', () => {
        const notRun = prune.pruneGuard({ summary: summaryOf({ ran: { nlq: false } }), suites: ALL_SUITES });
        assert.ok(notRun.some(r => r.startsWith('nlq：子行程沒有跑起來')), notRun.join('\n'));
        const broken = prune.pruneGuard({ summary: summaryOf({ errors: { variant: 'cassette 格式錯誤' } }), suites: ALL_SUITES, allowMisses: true });
        assert.ok(broken.some(r => r.startsWith('variant：回放時有 1 筆 miss 以外的錯誤')), broken.join('\n'));
    });
});

describe('applyPrune：只刪範圍內 agent 的 cassette 檔', () => {
    test('清單上的刪掉；清單外、化學、tutor、不像鍵的名字、跳出目錄的一律不碰', () => {
        const dir = path.join(tmp, 'cassettes');
        const k = (c) => c.repeat(64);
        const make = (agent, key) => {
            const file = path.join(dir, agent, `${key}.json`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '{}', 'utf8');
            return file;
        };
        const gone = make('classify', k('a'));
        const keep = make('classify', k('b'));
        const chem = make('classify_chem', k('c'));
        const tutor = make('tutor', k('d'));
        const outside = path.join(tmp, `${k('e')}.json`);
        fs.writeFileSync(outside, '{}', 'utf8');

        const res = prune.applyPrune({
            dir,
            items: [
                { agent: 'classify', key: k('a') },
                { agent: 'classify_chem', key: k('c') },
                { agent: 'tutor', key: k('d') },
                { agent: 'classify', key: '../../x' },
                { agent: '..', key: k('e') },
                { agent: 'verify', key: k('f') }        // 不存在：回報略過，不丟錯
            ]
        });
        assert.deepEqual(res.deleted, [gone]);
        assert.equal(res.skipped.length, 5, res.skipped.join('\n'));
        assert.ok(!fs.existsSync(gone));
        for (const f of [keep, chem, tutor, outside]) assert.ok(fs.existsSync(f), f);
    });
});
