// ─────────────────────────────────────────────────────────────
// localExtract.pg.test.js — 本機拆題交叉驗證的管線整合測試（〔本機模式 L2〕docs/local-mode.md 第 4 條第 4 點）
//
// 三件事要在真的 PostgreSQL 上成立：
//   1. 0015 的 CHECK：review_reason 接受 'extract_disagree'、仍然拒絕亂寫的值。
//   2. cross_check.status ≠ 'agree' 的題照常走完後續節點，最後停在 needs_review('extract_disagree')，
//      不入庫；更嚴重的原因先發生時以那個原因為準；agree 的題照常入庫；複核 API 看得到它與 alt_question_text。
//   3. 長節點（遠超過租約）執行中持續續租，另一個 runner 不會把它重跑一次（S5-40）；
//      對照組：不續租時同一個節點真的會被重跑——證明這個測試量得到那個風險。
//
// 防線與 jobs.pg.test.js 相同：只讀 TEST_DATABASE_URL、庫名必須 _test 結尾、在 require config/db 之前覆寫 DATABASE_URL。
// agents 用 test/fixtures/fakeAgents（不呼叫 LLM）；長節點用測試當場寫的一支慢 classify。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('本機拆題交叉驗證整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;
    process.env.JOB_RUNNER = 'off';

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const QUIET = { info() { }, warn() { }, error() { } };
    const fakeLlm = {
        async generateJson() { return { data: {}, latencyMs: 1, usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 }, raw: null }; },
        async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
    };

    function makeRunner(overrides = {}, agentsDir = FAKE_AGENTS_DIR) {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir, logger: QUIET,
            sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { nodeTimeoutMs: 5000, leaseMs: 60000, concurrency: 2, ...overrides }
        });
    }

    let seq = 0;
    function payload(i, extra = {}) {
        seq += 1;
        return {
            idx: 1000 + i, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95,
            question_type: '計算', difficulty: 3,
            question_text: `本機交叉驗證測試題 ${seq}-${i}：設 $\\vec{a}=(1,${i})$，求 $|\\vec{a}|$。`,
            answer_text: `$\\sqrt{1+${i * i}}$`,
            chunk_no: 1, page_range: [1, 2], ...extra
        };
    }

    async function seedJob(questions, state = 'processing') {
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
             VALUES ('pdf', $1, $2, 0.5, 2) RETURNING id`,
            [crypto.randomBytes(32).toString('hex'), state]);
        const jobId = rows[0].id;
        const jqIds = [];
        for (const q of questions) {
            const { rows: r } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, $2, 'extracted', $3::jsonb) RETURNING id`,
                [jobId, q.idx, JSON.stringify({ extract: q })]);
            jqIds.push(r[0].id);
        }
        return { jobId, jqIds };
    }

    async function drain(runner, maxRounds = 80) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            const { rows } = await query(
                `SELECT COUNT(*)::int AS n FROM job_questions
                  WHERE state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped')`);
            if (rows[0].n === 0) return;
        }
        throw new Error('drain：超過上限仍有未推進的列');
    }

    async function truncateAll() {
        for (let i = 1; ; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempts, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= 10) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
            }
        }
    }

    describe('本機拆題交叉驗證（PostgreSQL）', () => {
        beforeEach(async () => {
            await truncateAll();
            fakeCommon.resetCounts();
        });

        after(async () => {
            await pool.end();
        });

        test('0015：review_reason 的 CHECK 接受 extract_disagree、仍拒絕亂寫的值', async () => {
            const { jqIds } = await seedJob([payload(1)]);
            await query(`UPDATE job_questions SET state = 'needs_review', review_reason = 'extract_disagree' WHERE id = $1`, [jqIds[0]]);
            await assert.rejects(
                query(`UPDATE job_questions SET review_reason = 'extract_disagreed' WHERE id = $1`, [jqIds[0]]),
                (err) => err.code === '23514');
            // 既有九個值都還在（以完整值域重建）
            for (const r of ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate', 'budget_exceeded',
                'provider_error', 'schema_invalid', 'awaiting_approval', 'transcription_mismatch']) {
                await query('UPDATE job_questions SET review_reason = $2 WHERE id = $1', [jqIds[0], r]);
            }
        });

        test('agree 入庫；disagree／vision_only 走完節點後停在 extract_disagree；更嚴重的原因優先', async () => {
            const cc = (status, extra = {}) => ({ cross_check: { status, similarity: status === 'vision_only' ? null : 0.6, alt_question_text: status === 'vision_only' ? null : 'OCR 版讀到的題幹', picked: 'vision', ...extra } });
            const agree = payload(1, cc('agree', { similarity: 0.97 }));
            const disagree = payload(2, cc('disagree'));
            const visionOnly = payload(3, cc('vision_only'));
            const severe = payload(4, { ...cc('disagree'), __fake: { classify: { kind: 'fail', reason: 'chapter_invalid' } } });
            const gemini = payload(5);   // 沒有 cross_check（Gemini 路徑）
            const { jobId, jqIds } = await seedJob([agree, disagree, visionOnly, severe, gemini]);

            await drain(makeRunner());

            const { rows } = await query(
                'SELECT id, state, review_reason, question_id, payload FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            assert.deepEqual(rows.map(r => [r.state, r.review_reason]), [
                ['saved', null],
                ['needs_review', 'extract_disagree'],
                ['needs_review', 'extract_disagree'],
                ['needs_review', 'chapter_invalid'],
                ['saved', null]
            ]);
            assert.equal(typeof rows[0].question_id, 'number');
            for (const r of rows.slice(1, 4)) assert.equal(r.question_id, null, '不一致的題不得入庫');
            assert.equal(rows[1].payload.extract.cross_check.alt_question_text, 'OCR 版讀到的題幹', 'alt_question_text 留給複核頁');

            const { rows: q } = await query(
                'SELECT q.id FROM questions q JOIN job_questions jq ON jq.question_id = q.id WHERE jq.job_id = $1', [jobId]);
            assert.equal(q.length, 2);

            // 不一致的題：前面六個節點各跑一次，save 那一格寫 skipped、error_class NULL
            const { rows: ev } = await query(
                `SELECT node, outcome, error_class, detail FROM job_events WHERE jq_id = $1 ORDER BY id`, [jqIds[1]]);
            assert.deepEqual(ev.map(e => e.node), ['dedup0', 'classify', 'lint', 'source_check', 'verify', 'dedup1', 'save']);
            const save = ev[ev.length - 1];
            assert.equal(save.outcome, 'skipped');
            assert.equal(save.error_class, null);
            assert.equal(save.detail.reason, 'extract_disagree');
            assert.deepEqual(save.detail.cross_check, { status: 'disagree', similarity: 0.6, picked: 'vision' });

            const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
            assert.equal(job[0].state, 'done', '停在複核也是終態，job 照樣收尾');
        });

        test('複核 API：reason=extract_disagree 可以篩；單題看得到 cross_check；亂寫的 reason 仍是 400', async () => {
            const { jqIds } = await seedJob([payload(1, { cross_check: { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' } })]);
            await drain(makeRunner());

            const list = await request(app).get('/api/review').query({ reason: 'extract_disagree' });
            assert.equal(list.status, 200, JSON.stringify(list.body));
            assert.deepEqual(list.body.items.map(i => [i.jq_id, i.review_reason]), [[jqIds[0], 'extract_disagree']]);

            const one = await request(app).get(`/api/review/${jqIds[0]}`);
            assert.equal(one.status, 200);
            assert.equal(one.body.payload.extract.cross_check.status, 'ocr_only');

            const bad = await request(app).get('/api/review').query({ reason: 'extract_disagreed' });
            assert.equal(bad.status, 400);
        });

        describe('長節點與租約（S5-40）', () => {
            let slowDir;
            before(() => {
                // 慢 classify（1 秒）＋其餘節點轉接到 fakeAgents
                slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-agents-pg-'));
                fs.writeFileSync(path.join(slowDir, 'classify.js'), `
                    module.exports = {
                        async run(ctx, input) {
                            globalThis.__pgSlowCalls = (globalThis.__pgSlowCalls || 0) + 1;
                            await new Promise(r => setTimeout(r, 1000));
                            return { kind: 'pass', data: { chapter: input.chapter, confidence: 1, rationale: '慢', source: 'gate' } };
                        }
                    };`);
                for (const name of ['dedup', 'lint', 'source_check', 'verify', 'extract']) {
                    fs.writeFileSync(path.join(slowDir, `${name}.js`),
                        `module.exports = require(${JSON.stringify(path.join(FAKE_AGENTS_DIR, `${name}.js`))});`);
                }
            });
            after(() => {
                fs.rmSync(slowDir, { recursive: true, force: true });
                delete globalThis.__pgSlowCalls;
            });

            /** A 認領並開始跑慢節點；B 在這段期間每 50ms tick 一次。回傳 classify 被執行的次數 */
            async function race(aConfig) {
                globalThis.__pgSlowCalls = 0;
                const { jqIds } = await seedJob([payload(1)]);
                await query(`UPDATE job_questions SET state = 'hashed' WHERE id = $1`, [jqIds[0]]);

                const a = makeRunner({ concurrency: 1, ...aConfig }, slowDir);
                const b = makeRunner({ concurrency: 1, leaseMs: 60000 }, slowDir);
                await a.tick();
                assert.equal(a.inFlight, 1, 'A 認領到那一列');
                const until = Date.now() + 1300;
                while (Date.now() < until) {
                    await b.tick();
                    await new Promise(r => setTimeout(r, 50));
                }
                while (a.inFlight > 0 || b.inFlight > 0) await new Promise(r => setTimeout(r, 20));
                const { rows } = await query(
                    `SELECT COUNT(*)::int AS n FROM job_events WHERE jq_id = $1 AND node = 'classify'`, [jqIds[0]]);
                return { calls: globalThis.__pgSlowCalls, events: rows[0].n };
            }

            test('節點（1 秒）遠長於租約（300ms）：執行中持續續租，B 認領不到，節點只跑一次', async () => {
                const r = await race({ leaseMs: 300, renewIntervalMs: 50 });
                assert.equal(r.calls, 1, '慢節點被重跑了');
                assert.equal(r.events, 1);
            });

            test('對照組：不續租（間隔設得比節點還長）→ 租約過期後 B 真的會把同一個節點再跑一次', async () => {
                const r = await race({ leaseMs: 300, renewIntervalMs: 60000 });
                assert.ok(r.calls >= 2, `預期被重跑，實際 ${r.calls} 次——這個對照組量不到風險，上一個測試就沒有意義`);
            });
        });
    });
}
