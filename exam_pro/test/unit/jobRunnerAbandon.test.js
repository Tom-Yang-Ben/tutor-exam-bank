// ─────────────────────────────────────────────────────────────
// test/unit/jobRunnerAbandon.test.js — 〔dec/r8-b1-abandon〕jobRunner 的 shutdown({ abandon: true })（假 db，不連資料庫）
//
// 設計稿 docs/desktop-app-design.md 2.3 節第 3、4 點、第 3 條第 2 項、R-17：
//   陷阱：一般的 abort 會被 classifyError 歸成 timeout、寫進 job_events、累加重試次數，拆題與變式的迴圈還會立刻重試。
//   放棄走另一條路：被放棄的節點不寫 outcome、不動 retries、不寫 job_events、不記用量、迴圈不重試，只放掉**自己的**租約。
// 這裡用假 db 釘住細節（租約憑證、續租換值、lost、save 不中止、退避睡眠中放棄）；三種工作單位在真的 PostgreSQL 上的行為
// （重開後立刻被認領、沒有 timeout／failed、重試次數不變）在 test/integration/jobAbandon.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// saveNode 入庫後會 fire-and-forget 補向量（embedService 用 config/db）：指到不存在的庫，連不上只記 warn
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nobody:none@127.0.0.1:1/never_used_test';

const runner = require('../../workers/jobRunner');
const { createRunner, ABANDON_REASON } = runner;

const TOKEN = '2026-09-27 10:00:00.123456+08';

/** 記下每一句 SQL 的假 db。handlers：[regex, (params, text) => result]（第一個對上的） */
function fakeDb(handlers = [], pool = null) {
    const log = [];
    return {
        log,
        pool: pool || { connect: async () => { throw new Error('這個測試不該開交易'); } },
        async query(text, params) {
            log.push({ text, params });
            for (const [re, fn] of handlers) if (re.test(text)) return fn(params, text);
            return { rows: [], rowCount: 0 };
        }
    };
}

function jqRow(state, payload, extra = {}) {
    return {
        id: 77, job_id: 9, idx: 1001, state, payload, retries: { 'classify:error': 1 },
        kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics',
        budget_usd: 0.5, cost_usd: 0, ...extra
    };
}

function capture() {
    const lines = { info: [], warn: [], error: [] };
    return { lines, logger: { info: o => lines.info.push(o), warn: o => lines.warn.push(o), error: o => lines.error.push(o) } };
}

const lease = (extra = {}) => ({ table: 'job_questions', id: 77, until: TOKEN, okSentAt: performance.now(), lost: false, pending: null, ...extra });
const RELEASE_OWN = /UPDATE job_questions SET locked_until = NULL WHERE id = \$1 AND locked_until = \$2::timestamptz/;
const RELEASE_ANY = /^UPDATE job_questions SET locked_until = NULL WHERE id = \$1$/;
const WROTE_RESULT = /INSERT INTO job_events|UPDATE job_questions SET state|UPDATE jobs SET token_in|UPDATE jobs SET state = 'failed'/;
const until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
        if (pred()) { clearInterval(t); resolve(); } else if (Date.now() - started > ms) { clearInterval(t); reject(new Error('等不到')); }
    }, 5);
});

let agentsDir;
before(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-agents-'));
    // 會等 signal 的 classify：被 abort 時照真 agent 的習慣回 timeout（runner 若照單全收，就會記成逾時、吃掉重試次數）
    fs.writeFileSync(path.join(agentsDir, 'classify.js'), `
        module.exports = { async run(ctx) {
            const s = globalThis.__abandonTest;
            s.started += 1;
            await new Promise(resolve => {
                if (ctx.signal.aborted) return resolve();
                ctx.signal.addEventListener('abort', resolve, { once: true });
            });
            s.aborted = { aborted: ctx.signal.aborted, reason: ctx.signal.reason };
            return { kind: 'error', errorClass: 'timeout', message: '被 abort' };
        } };`);
    // 一律回供應商錯誤的 extract（測退避睡眠中放棄）
    fs.writeFileSync(path.join(agentsDir, 'extract.js'), `
        module.exports = { async run() { globalThis.__abandonTest.extract += 1; return { kind: 'error', errorClass: 'provider_error', message: '假：連線被拒' }; } };`);
});
after(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    delete globalThis.__abandonTest;
});
const reset = () => { globalThis.__abandonTest = { started: 0, aborted: null, extract: 0 }; };

describe('題目層（runJobQuestion）被放棄', () => {
    test('節點被中止：不寫事件、不經 transition（retries 不變）、不記用量；只放自己的租約（值要對得上）', async () => {
        reset();
        const db = fakeDb([
            [/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x', subject: '數學', chapter: '向量內積', chapter_confidence: 0.9 } })], rowCount: 1 })],
            [RELEASE_OWN, () => ({ rows: [], rowCount: 1 })]
        ]);
        const { lines, logger } = capture();
        const r = createRunner({ db, llm: {}, logger, agentsDir, config: { renewIntervalMs: 60000, nodeTimeoutMs: 60000 } });
        const L = lease();
        const running = r.runJobQuestion(77, L);
        await until(() => globalThis.__abandonTest.started === 1);

        await r.shutdown({ abandon: true, waitMs: 1000 });
        await running;
        // 直接呼叫的工作單位不在 inFlight 裡（tick 的 spawn 才算），統計要等它結束再問一次（可以重複呼叫）
        const out = await r.shutdown({ abandon: true });
        assert.equal(r.abandoning, true);
        assert.deepEqual(globalThis.__abandonTest.aborted, { aborted: true, reason: ABANDON_REASON }, 'agent 收到的 signal 是被放棄的那一種');
        assert.ok(!db.log.some(q => WROTE_RESULT.test(q.text)), `不得寫任何結果：${db.log.map(q => q.text.split('\n')[0]).join(' | ')}`);
        const rel = db.log.filter(q => RELEASE_OWN.test(q.text));
        assert.equal(rel.length, 1);
        assert.deepEqual(rel[0].params, [77, TOKEN]);
        assert.ok(!db.log.some(q => RELEASE_ANY.test(q.text.trim())), '不走無條件放租約的那一句');
        const w = lines.warn.find(o => /放棄在途工作：不寫結果、不動重試次數/.test(o.msg));
        assert.ok(w, JSON.stringify(lines.warn));
        assert.deepEqual([w.lease, w.unit, w.jq_id, w.node, w.state], ['released', 'job_question', 77, 'classify', 'hashed']);
        assert.equal(lines.warn.filter(o => o.node === 'shutdown').length, 1, 'shutdown 記一行（中止幾個節點）');
        assert.deepEqual(out, { left: 0, abandoned: 1, released: 1, kept: 0 });
    });

    test('放棄之後才要開始的節點不開始（agent 一次都不叫）', async () => {
        reset();
        const db = fakeDb([
            [/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x' } })], rowCount: 1 })],
            [RELEASE_OWN, () => ({ rows: [], rowCount: 1 })]
        ]);
        const r = createRunner({ db, llm: {}, logger: capture().logger, agentsDir, config: { renewIntervalMs: 60000 } });
        await r.shutdown({ abandon: true });
        await r.runJobQuestion(77, lease());
        assert.equal(globalThis.__abandonTest.started, 0);
        assert.ok(!db.log.some(q => WROTE_RESULT.test(q.text)));
        assert.equal(db.log.filter(q => RELEASE_OWN.test(q.text)).length, 1);
    });

    test('多個後端：租約已經不是自己寫的那一個（別人接手）→ 清不到（rowCount 0），記成 kept', async () => {
        reset();
        const db = fakeDb([
            [/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x' } })], rowCount: 1 })],
            [RELEASE_OWN, () => ({ rows: [], rowCount: 0 })]
        ]);
        const { lines, logger } = capture();
        const r = createRunner({ db, llm: {}, logger, agentsDir, config: { renewIntervalMs: 60000 } });
        const running = r.runJobQuestion(77, lease());
        await until(() => globalThis.__abandonTest.started === 1);
        await r.shutdown({ abandon: true });
        await running;
        const out = await r.shutdown({ abandon: true });
        assert.equal(lines.warn.find(o => o.unit).lease, 'not-ours');
        assert.deepEqual(out, { left: 0, abandoned: 1, released: 0, kept: 1 });
    });

    test('沒有租約憑證（直接呼叫、不是 tick 認領的）→ 不放租約（留給它自己到期），也不寫結果', async () => {
        reset();
        const db = fakeDb([[/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x' } })], rowCount: 1 })]]);
        const { lines, logger } = capture();
        const r = createRunner({ db, llm: {}, logger, agentsDir, config: { renewIntervalMs: 60000 } });
        const running = r.runJobQuestion(77);
        await until(() => globalThis.__abandonTest.started === 1);
        await r.shutdown({ abandon: true });
        await running;
        assert.ok(!db.log.some(q => /SET locked_until = NULL/.test(q.text)), '一句放租約都沒有');
        assert.ok(!db.log.some(q => WROTE_RESULT.test(q.text)));
        assert.equal(lines.warn.find(o => o.unit).lease, 'no-lease');
    });

    test('續租：憑證換成續租回傳的新值，放租約用新值', async () => {
        reset();
        let n = 0;
        const db = fakeDb([
            [/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x' } })], rowCount: 1 })],
            [/SET locked_until = now\(\) \+[\s\S]*RETURNING locked_until::text AS lease_until/, () => { n += 1; return { rows: [{ lease_until: `V${n}` }], rowCount: 1 }; }],
            [RELEASE_OWN, () => ({ rows: [], rowCount: 1 })]
        ]);
        const r = createRunner({ db, llm: {}, logger: capture().logger, agentsDir, config: { leaseMs: 60000, renewIntervalMs: 20 } });
        const L = lease();
        const running = r.runJobQuestion(77, L);
        await until(() => n >= 3);
        await r.shutdown({ abandon: true });
        await running;
        const rel = db.log.filter(q => RELEASE_OWN.test(q.text));
        assert.equal(rel.length, 1);
        assert.deepEqual(rel[0].params, [77, `V${n}`], '最後一次續租的值');
        const at = db.log.indexOf(rel[0]);
        assert.ok(!db.log.slice(at + 1).some(q => /SET locked_until = now\(\)/.test(q.text)), '放租約之後不再續租');
    });

    test('續租曾經中斷超過一個租約長度（可能被別人接手、又被自己的續租蓋過）→ lost，不放租約', async () => {
        reset();
        const db = fakeDb([
            [/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('hashed', { extract: { question_text: 'x' } })], rowCount: 1 })],
            [/RETURNING locked_until::text AS lease_until/, () => ({ rows: [{ lease_until: 'V-after-gap' }], rowCount: 1 })],
            [RELEASE_OWN, () => ({ rows: [], rowCount: 1 })]
        ]);
        const { lines, logger } = capture();
        const r = createRunner({ db, llm: {}, logger, agentsDir, config: { leaseMs: 1000, renewIntervalMs: 20 } });
        // 上一次成功寫入租約是 5 秒前（租約只有 1 秒）：中間有一段租約已經到期
        const L = lease({ okSentAt: performance.now() - 5000 });
        const running = r.runJobQuestion(77, L);
        await until(() => L.until === 'V-after-gap');
        await r.shutdown({ abandon: true });
        await running;
        assert.equal(L.lost, true);
        assert.ok(!db.log.some(q => RELEASE_OWN.test(q.text)), '不放');
        assert.equal(lines.warn.find(o => o.unit).lease, 'lost');
    });

    test('save 一旦開始就讓它做完（不被中止），結果照常寫回', async () => {
        reset();
        let openGate;
        const gate = new Promise(r => { openGate = r; });
        const clientLog = [];
        const pool = {
            async connect() {
                return {
                    async query(text) {
                        clientLog.push(text.split('\n')[0].trim());
                        if (text === 'BEGIN') await gate;
                        if (/INSERT INTO questions/.test(text)) return { rows: [{ id: 555 }], rowCount: 1 };
                        return { rows: [], rowCount: 1 };
                    },
                    release() { }
                };
            }
        };
        const payload = {
            extract: { subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '設 $x=1$，求 $x$。', answer_text: '$1$' },
            dedup0: { text_hash: 'h' }, classify: { chapter: '向量內積', confidence: 0.9, source: 'gate' }
        };
        const db = fakeDb([[/FROM job_questions q JOIN jobs j/, () => ({ rows: [jqRow('deduped', payload)], rowCount: 1 })]], pool);
        const r = createRunner({ db, llm: {}, logger: capture().logger, agentsDir, config: { renewIntervalMs: 60000 } });
        const running = r.runJobQuestion(77, lease());
        await until(() => clientLog.includes('BEGIN'));
        const out = r.shutdown({ abandon: true });
        await new Promise(res => setTimeout(res, 30));
        assert.ok(!clientLog.includes('COMMIT'), '前提：save 還卡在交易裡');
        openGate();
        await running;
        await out;
        assert.ok(clientLog.includes('COMMIT'), 'save 做完');
        const upd = db.log.find(q => /UPDATE job_questions SET state = \$2/.test(q.text));
        assert.ok(upd, '照常寫回（真的結果）');
        assert.equal(upd.params[1], 'saved');
        assert.ok(db.log.some(q => /INSERT INTO job_events/.test(q.text) && q.params[2] === 'save' && q.params[12] === 'pass'));
        assert.ok(!db.log.some(q => RELEASE_OWN.test(q.text)), '寫回時已經放掉租約，不必再放');
    });
});

describe('拆題迴圈（runExtractChunk）', () => {
    test('錯誤後的退避睡眠中放棄：馬上醒來、不再呼叫第二次、job 不 failed；之前那一筆真的錯誤照舊留著', async () => {
        reset();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-pdf-'));
        const pdf = path.join(tmp, 'x.pdf');
        fs.writeFileSync(pdf, '%PDF-1.4 假');
        try {
            const db = fakeDb([
                [/FROM jobs WHERE id = \$1/, (p, text) => /pdf_path/.test(text)
                    ? { rows: [{ id: 9, pdf_path: pdf, pdf_sha256: 'a'.repeat(64), page_count: 1, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0 }], rowCount: 1 }
                    : { rows: [{ cost_usd: 0 }], rowCount: 1 }],
                [/UPDATE jobs SET locked_until = NULL WHERE id = \$1 AND locked_until = \$2::timestamptz/, () => ({ rows: [], rowCount: 1 })]
            ]);
            let sleeping = 0;
            const r = createRunner({
                db, llm: {}, logger: capture().logger, agentsDir,
                sleep: () => { sleeping += 1; return new Promise(() => { }); },   // 退避睡眠永遠不會自己醒
                config: { renewIntervalMs: 60000, pdfChunkPages: 20, localExtract: false }
            });
            const running = r.runExtractJob(9, { ...lease(), table: 'jobs', id: 9 });
            await until(() => sleeping === 1);
            assert.equal(globalThis.__abandonTest.extract, 1);
            await r.shutdown({ abandon: true });
            await running;
            assert.equal(globalThis.__abandonTest.extract, 1, '不再重試');
            const events = db.log.filter(q => /INSERT INTO job_events/.test(q.text));
            assert.equal(events.length, 1, '只有放棄之前那一次真的錯誤');
            assert.equal(events[0].params[13], 'provider_error');
            assert.ok(!db.log.some(q => /UPDATE jobs SET state = 'failed'/.test(q.text)), '不 failed');
            assert.ok(!db.log.some(q => /state = 'processing'/.test(q.text)));
            const rel = db.log.filter(q => /UPDATE jobs SET locked_until = NULL/.test(q.text));
            assert.equal(rel.length, 1);
            assert.deepEqual(rel[0].params, [9, TOKEN]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('shutdown 本身', () => {
    test('沒有 abandon：只 stop()，不標記放棄；可以重複呼叫', async () => {
        const r = createRunner({ db: fakeDb(), llm: {}, logger: capture().logger, agentsDir });
        assert.deepEqual(await r.shutdown(), { left: 0, abandoned: 0, released: 0, kept: 0 });
        assert.equal(r.abandoning, false);
        await r.shutdown({ abandon: true });
        await r.shutdown({ abandon: true });
        assert.equal(r.abandoning, true);
    });

    test('放棄之後 tick 不再認領', async () => {
        let claims = 0;
        const db = fakeDb([[/SUM\(cost_usd\)/, () => ({ rows: [{ spent: 0 }], rowCount: 1 })]], {
            connect: async () => ({ async query(text) { if (/FOR UPDATE SKIP LOCKED/.test(text)) claims += 1; return { rows: [], rowCount: 0 }; }, release() { } })
        });
        const r = createRunner({ db, llm: {}, logger: capture().logger, agentsDir, config: { renewIntervalMs: 60000 } });
        await r.tick();
        assert.ok(claims > 0);
        const before = claims;
        await r.shutdown({ abandon: true });
        await r.tick();
        assert.equal(claims, before);
    });
});
