// ─────────────────────────────────────────────────────────────
// kcRunnerHook.test.js — workers/jobRunner.js 的知識點標註掛鉤（〔stage5 WS-C〕；interfaces-stage5.md 第 4.3 條第 3 點）
//
// 兩層：
//   1. runKcTagHook 本身（純函式）：旗標關閉＝完全不呼叫；開啟時同步丟錯、rejected promise
//      都只記 warn，回傳的 promise 永遠 resolve。
//   2. 真的 createRunner().runJobQuestion() 跑 save 節點（DB 用腳本化的假物件，不連 PG）：
//      旗標關閉時 tagger 一次都沒被叫；開啟且 tagger 失敗時，job_questions 照樣推進到 saved、
//      job_events 照樣寫 pass——**掛鉤失敗不影響 job 狀態**。
//   3. 預算煞車：save 是零成本節點、預算用盡仍會跑，但標註要付錢——當日預算（DAILY_COST_BUDGET_USD）
//      或該 job 的 budget_usd 用盡時不呼叫 tagger，題目照常入庫。
//
// 真 PostgreSQL 的版本在 test/integration/kcTagging.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runKcTagHook, createRunner } = require('../../workers/jobRunner');

function recordingLogger() {
    const lines = { info: [], warn: [], error: [] };
    return {
        lines,
        info: (o) => lines.info.push(o),
        warn: (o) => lines.warn.push(o),
        error: (o) => lines.error.push(o)
    };
}

describe('runKcTagHook（純函式）', () => {
    test('旗標關閉：tagger 完全不被呼叫，回 null', async () => {
        let called = 0;
        const log = recordingLogger();
        const r = await runKcTagHook({ questionId: 1, enabled: false, tagger: () => { called++; }, logger: log });
        assert.equal(r, null);
        assert.equal(called, 0);
        assert.equal(log.lines.info.length + log.lines.warn.length, 0);
    });

    test('旗標開啟：呼叫 tagger 並記一行 info（含狀態與寫入的 code）', async () => {
        const log = recordingLogger();
        const seen = [];
        const r = await runKcTagHook({
            questionId: 42, enabled: true, logger: log,
            tagger: async (id) => {
                seen.push(id);
                return { status: 'tagged', written: [{ code: 'MATH.向量內積.02' }], usage: { calls: 1, costUsd: 0.0031 } };
            }
        });
        assert.deepEqual(seen, [42]);
        assert.equal(r.status, 'tagged');
        assert.equal(log.lines.info[0].question_id, 42);
        assert.deepEqual(log.lines.info[0].kc_codes, ['MATH.向量內積.02']);
        assert.equal(log.lines.info[0].cost_usd, 0.0031, '標註費用不進 job_events，只留在 log');
    });

    test('沒有呼叫 LLM（例如該章沒有知識點）時 log 不帶費用', async () => {
        const log = recordingLogger();
        await runKcTagHook({
            questionId: 3, enabled: true, logger: log,
            tagger: async () => ({ status: 'skipped', reason: 'no_kcs', written: [], usage: { calls: 0, costUsd: 0 } })
        });
        assert.equal(log.lines.info[0].reason, 'no_kcs');
        assert.equal('cost_usd' in log.lines.info[0], false);
    });

    test('tagger 同步丟錯 → 只記 warn，promise 仍然 resolve(null)', async () => {
        const log = recordingLogger();
        const r = await runKcTagHook({ questionId: 7, enabled: true, logger: log, tagger: () => { throw new Error('同步炸了'); } });
        assert.equal(r, null);
        assert.equal(log.lines.warn.length, 1);
        assert.ok(log.lines.warn[0].error.includes('同步炸了'));
    });

    test('budgetCheck 回略過原因 → tagger 不被呼叫，記一行 info（status skipped、reason），回 null', async () => {
        for (const reason of ['daily_budget', 'job_budget']) {
            const log = recordingLogger();
            let called = 0;
            const r = await runKcTagHook({
                questionId: 5, enabled: true, logger: log, budgetCheck: async () => reason,
                tagger: async () => { called++; return { status: 'tagged' }; }
            });
            assert.equal(r, null);
            assert.equal(called, 0, reason);
            assert.equal(log.lines.info.length, 1);
            assert.equal(log.lines.info[0].status, 'skipped');
            assert.equal(log.lines.info[0].reason, reason);
            assert.equal(log.lines.warn.length, 0);
        }
    });

    test('budgetCheck 回 null／沒給 → 照常呼叫 tagger', async () => {
        for (const budgetCheck of [async () => null, () => null, undefined]) {
            const seen = [];
            await runKcTagHook({
                questionId: 6, enabled: true, logger: recordingLogger(), budgetCheck,
                tagger: async (id) => { seen.push(id); return { status: 'tagged' }; }
            });
            assert.deepEqual(seen, [6]);
        }
    });

    test('budgetCheck 自己丟錯（查不到帳）→ 不花錢：tagger 不被呼叫，只記 warn，promise 仍然 resolve(null)', async () => {
        const log = recordingLogger();
        let called = 0;
        const r = await runKcTagHook({
            questionId: 8, enabled: true, logger: log,
            budgetCheck: async () => { throw new Error('connection terminated'); },
            tagger: async () => { called++; }
        });
        assert.equal(r, null);
        assert.equal(called, 0);
        assert.ok(log.lines.warn[0].error.includes('connection terminated'));
    });

    test('旗標關閉時連 budgetCheck 都不問', async () => {
        let asked = 0;
        await runKcTagHook({ questionId: 1, enabled: false, tagger: () => { }, budgetCheck: () => { asked++; return null; } });
        assert.equal(asked, 0);
    });

    test('tagger 回 rejected promise → 只記 warn，promise 仍然 resolve(null)', async () => {
        const log = recordingLogger();
        const r = await runKcTagHook({ questionId: 7, enabled: true, logger: log, tagger: async () => { throw new Error('LLM 掛了\n第二行不進 log'); } });
        assert.equal(r, null);
        assert.equal(log.lines.warn[0].error, 'LLM 掛了');
    });
});

// ─────────────────────────────────────────────────────────────
// 真的 runner 跑 save 節點
// ─────────────────────────────────────────────────────────────

/** 一列在 deduped 狀態、下一步就是 save 的 job_questions（payload 形狀同 jobs.pg.test.js） */
const JQ = {
    id: 31, job_id: 8, idx: 1, state: 'deduped',
    payload: {
        extract: {
            idx: 1, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
            question_text: '自製測試題：設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,4)$，求 $\\vec{a}\\cdot\\vec{b}$。',
            answer_text: '$11$', chunk_no: 1, page_range: [1, 1]
        },
        dedup0: { text_hash: 'abc123' },
        classify: { chapter: '向量內積', confidence: 0.95, source: 'gate' }
    },
    retries: {}, kind: 'pdf', pdf_sha256: 'f'.repeat(64), source_type: 'self', source_detail: null,
    budget_usd: 0.5, cost_usd: 0
};

/**
 * 腳本化的假 DB：只回 runJobQuestion 與 save 節點真的需要讀的列，其餘一律空結果。
 * @param {{jq?:object, dailySpent?:number}} [opts] jq 覆寫 JQ 的欄位；dailySpent 是當日 job_events 的花費
 */
function fakeDb({ jq = {}, dailySpent = 0 } = {}) {
    const log = [];
    const client = {
        async query(sql, params) {
            log.push({ sql, params, tx: true });
            if (/INSERT INTO questions/.test(sql)) return { rows: [{ id: 77 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release() { }
    };
    return {
        log,
        pool: { connect: async () => client },
        async query(sql, params) {
            log.push({ sql, params });
            if (/FROM job_questions q JOIN jobs j/.test(sql)) return { rows: [{ ...JQ, ...jq }], rowCount: 1 };
            if (/SUM\(cost_usd\)[\s\S]*FROM job_events/.test(sql)) return { rows: [{ spent: dailySpent }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        }
    };
}

function makeRunner(db, logger, kcTagger, config = {}) {
    return createRunner({
        db, llm: { async generateJson() { throw new Error('save 節點不該呼叫 LLM'); }, async embed() { return { vectors: [] }; } },
        logger, sleep: async () => { }, kcTagger,
        estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
        config: { nodeTimeoutMs: 20000, leaseMs: 60000, dailyCostBudgetUsd: 5, ...config }
    });
}

/** 讓 fire-and-forget 的掛鉤跑完（它排在 microtask 裡） */
const settle = () => new Promise(r => setTimeout(r, 20));

function stateUpdates(db) {
    return db.log.filter(l => /UPDATE job_questions SET state = \$2/.test(l.sql)).map(l => l.params[1]);
}

describe('createRunner 的 save 節點與掛鉤（假 DB）', () => {
    const saved = process.env.FEATURE_KC_TAGGING;
    afterEach(() => {
        if (saved === undefined) delete process.env.FEATURE_KC_TAGGING; else process.env.FEATURE_KC_TAGGING = saved;
    });

    test('FEATURE_KC_TAGGING 關閉（未設定／false）：tagger 一次都沒被叫，題目照常入庫', async () => {
        for (const v of [undefined, 'false', '0', 'yes']) {
            if (v === undefined) delete process.env.FEATURE_KC_TAGGING; else process.env.FEATURE_KC_TAGGING = v;
            const db = fakeDb();
            let called = 0;
            await makeRunner(db, recordingLogger(), async () => { called++; return { status: 'tagged' }; }).runJobQuestion(JQ.id);
            await settle();
            assert.equal(called, 0, `FEATURE_KC_TAGGING=${v}`);
            assert.deepEqual(stateUpdates(db), ['saved']);
        }
    });

    test('開啟且成功：save COMMIT 之後以新題號呼叫 tagger 一次', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const db = fakeDb();
        const seen = [];
        const log = recordingLogger();
        await makeRunner(db, log, async (id) => {
            // 呼叫時入庫交易已經 COMMIT（掛鉤在 save 成功之後）
            assert.ok(db.log.some(l => l.tx && l.sql === 'COMMIT'), '掛鉤在 COMMIT 之前就被呼叫了');
            seen.push(id);
            return { status: 'tagged', written: [{ code: 'MATH.向量內積.02' }] };
        }).runJobQuestion(JQ.id);
        await settle();
        assert.deepEqual(seen, [77]);
        assert.deepEqual(stateUpdates(db), ['saved']);
        assert.ok(log.lines.info.some(l => l.msg === '知識點自動標註' && l.question_id === 77));
    });

    test('開啟但 tagger 失敗（同步丟錯或 reject）：job_questions 仍推進到 saved，事件仍是 pass', async () => {
        process.env.FEATURE_KC_TAGGING = '1';
        for (const tagger of [
            () => { throw new Error('同步失敗'); },
            async () => { throw new Error('LLM_MODE=replay 找不到 cassette'); }
        ]) {
            const db = fakeDb();
            const log = recordingLogger();
            await makeRunner(db, log, tagger).runJobQuestion(JQ.id);
            await settle();
            assert.deepEqual(stateUpdates(db), ['saved']);
            const ev = db.log.find(l => /INSERT INTO job_events/.test(l.sql));
            assert.equal(ev.params[2], 'save');
            assert.equal(ev.params[12], 'pass');
            assert.ok(log.lines.warn.some(w => w.msg === '知識點自動標註失敗（不影響入庫）' && w.question_id === 77));
        }
    });

    test('當日花費已達 DAILY_COST_BUDGET_USD：save 照常入庫（零成本節點），但不呼叫 tagger', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const db = fakeDb({ dailySpent: 5 });
        const log = recordingLogger();
        let called = 0;
        await makeRunner(db, log, async () => { called++; return { status: 'tagged' }; }, { dailyCostBudgetUsd: 5 }).runJobQuestion(JQ.id);
        await settle();
        assert.equal(called, 0);
        assert.deepEqual(stateUpdates(db), ['saved']);
        assert.ok(log.lines.info.some(l => l.question_id === 77 && l.status === 'skipped' && l.reason === 'daily_budget'));
    });

    test('該 job 的 budget_usd 已用盡：save 照常入庫，但不呼叫 tagger', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const db = fakeDb({ jq: { budget_usd: 0.5, cost_usd: 0.5 } });
        const log = recordingLogger();
        let called = 0;
        await makeRunner(db, log, async () => { called++; return { status: 'tagged' }; }).runJobQuestion(JQ.id);
        await settle();
        assert.equal(called, 0);
        assert.deepEqual(stateUpdates(db), ['saved']);
        assert.ok(log.lines.info.some(l => l.question_id === 77 && l.status === 'skipped' && l.reason === 'job_budget'));
    });

    test('當日花費未達上限、job 預算還有：照常呼叫 tagger', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const db = fakeDb({ dailySpent: 4.99 });
        const seen = [];
        await makeRunner(db, recordingLogger(), async (id) => { seen.push(id); return { status: 'tagged' }; }, { dailyCostBudgetUsd: 5 }).runJobQuestion(JQ.id);
        await settle();
        assert.deepEqual(seen, [77]);
    });

    test('save 失敗（欄位不合法）時不會呼叫 tagger', async () => {
        process.env.FEATURE_KC_TAGGING = 'true';
        const db = fakeDb();
        const bad = { ...JQ, payload: { ...JQ.payload, extract: { ...JQ.payload.extract, subject: '生物' } } };
        db.query = async (sql, params) => {
            db.log.push({ sql, params });
            if (/FROM job_questions q JOIN jobs j/.test(sql)) return { rows: [bad], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        };
        let called = 0;
        await makeRunner(db, recordingLogger(), async () => { called++; }).runJobQuestion(JQ.id);
        await settle();
        assert.equal(called, 0);
        assert.ok(!db.log.some(l => /INSERT INTO questions/.test(l.sql)));
    });
});