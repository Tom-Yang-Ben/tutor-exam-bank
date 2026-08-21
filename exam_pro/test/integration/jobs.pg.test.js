// ─────────────────────────────────────────────────────────────
// jobs.pg.test.js — 管線 runner 與六支 jobs／review API 的整合測試（A-T11 / A-T12，擁有者：WS-A）
//
// 三道防線與 controllers.pg.test.js 完全一致：
//   1. **只讀 process.env.TEST_DATABASE_URL，本檔絕不 require('dotenv')**——
//      `npm test` 不預載 .env，因此這整支會被 skip，單元測試永遠不連 DB。
//      要跑它：node -r dotenv/config --test "test/integration/**/*.test.js"
//   2. 資料庫名必須以 `_test` 結尾。
//   3. 在 require config/db.js **之前**覆寫 DATABASE_URL。
//
// LLM：runner 的 llm 由測試注入一支假的（回固定 usage），
//      agents 指到 test/fixtures/fakeAgents/——不連 Gemini、不需金鑰。
//
// ⚠ 跑這支之前，確認**沒有另一個 runner 行程正指著測試庫**
//   （例如另一個視窗開著 `node workers/jobRunner.js` 且 DATABASE_URL 指到 5433）。
//   認領是 SKIP LOCKED + 租約，兩個 runner 本來就會互相禮讓，但那個外部 runner 會用
//   真正的 agents/ 目錄去跑本檔建出來的列，於是本檔的斷言就對不上了。
//   本檔設 JOB_RUNNER=off 只能擋住「app 自己起 runner」，擋不住外部行程。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('管線整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 node -r dotenv/config --test "test/integration/**/*.test.js"'
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
    process.env.JOB_RUNNER = 'off';           // 測試自己驅動 tick，不要背景 runner 插隊
    process.env.JOB_COST_BUDGET_USD = '0.5';

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));

    /**
     * 重新建一個 app 實例。
     *
     * routes/index.js 的 aiRateLimit（每分鐘 10 次／每來源）是**模組層單例**，
     * supertest 的每一次呼叫都來自 127.0.0.1，因此整支測試共用同一個計數器：
     * POST /api/jobs 的案例把額度用完之後，後面的案例會全部收到 429。
     * 清掉 app 與 routes 的 require 快取即可拿到一個全新的限流器
     * （config/db 的快取刻意保留，連線池只有一個）。
     */
    function freshApp() {
        for (const key of Object.keys(require.cache)) {
            if (key === path.join(APP_DIR, 'app.js') || key === path.join(APP_DIR, 'routes', 'index.js')) {
                delete require.cache[key];
            }
        }
        return require(path.join(APP_DIR, 'app'));
    }
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const { textHash } = require(path.join(APP_DIR, 'utils', 'normalizeStem'));
    const fakeExtract = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', 'extract.js'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';

    /** 假 LLM：回固定 usage，讓成本累加與 job_events 的 token 欄位有東西可斷言。 */
    const fakeLlm = {
        calls: 0,
        schemaFallback: false,      // 裁決 S2-4：模擬「走了 schema 不含 enum 的退路」
        async generateJson({ model }) {
            fakeLlm.calls += 1;
            return {
                data: {}, latencyMs: 5,
                usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 400, tokenCached: 0 },
                raw: { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 400 } },
                schemaFallback: fakeLlm.schemaFallback
            };
        },
        async embed() { return { vectors: [], usage: { tokenIn: 10 } }; }
    };

    /** 每 1000 個 output token（含 thinking）算 0.1 美元——刻意訂得很貴，一次呼叫就吃掉一大塊預算。 */
    function fakeEstimateCost(meter) {
        if (meter.calls === 0) return { cost_usd: 0, cost_estimated: false };
        return { cost_usd: ((meter.tokenOut + meter.tokenThinking) / 1000) * 0.1, cost_estimated: true };
    }

    function makeRunner(overrides = {}) {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir: FAKE_AGENTS_DIR,
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },                 // 測試不真的睡退避的秒數
            estimateCost: fakeEstimateCost,
            config: { nodeTimeoutMs: 2000, leaseMs: 60000, concurrency: 2, ...overrides }
        });
    }

    /** 一題的 payload.extract（只放 extract 寫得出來的欄位）。 */
    function extractPayload(i, extra = {}) {
        return {
            idx: 1000 + i, subject: SUBJECT, chapter: CHAPTER, chapter_confidence: 0.95,
            question_type: '計算', difficulty: 3,
            question_text: `自製測試題 ${i}：設 $\\vec{a}=(1,${i})$，求 $|\\vec{a}|$。`,
            answer_text: `$\\sqrt{1+${i * i}}$`,
            chunk_no: 1, page_range: [1, 20], ...extra
        };
    }

    /** 直接建一個已經拆好題的 job（跳過 extract），回 {jobId, jqIds}。 */
    async function seedJob(questions, { state = 'processing', budget = 0.5 } = {}) {
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
             VALUES ('pdf', $1, $2, $3, 20) RETURNING id`,
            [require('node:crypto').randomBytes(32).toString('hex'), state, budget]);
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

    /**
     * 清空管線與題庫的所有表，**遇到死結就重試**。
     *
     * 為什麼需要重試：入庫成功後 runner 與 approve 都會 fire-and-forget 呼叫
     * `embedService.embedByIds()`（第 3.3 條、interfaces.md 12.4 都明訂如此），
     * 它是刻意不被 await 的，因此可能跨到下一個案例才跑完。那個交易在
     * `questions` 上持有列鎖並要做 FK 檢查（RowShareLock），而 TRUNCATE 要的是
     * AccessExclusiveLock——兩邊互等就是 40P01。
     *
     * 這不是產品缺陷（線上不會每隔幾秒 TRUNCATE 一次題庫），而是「測試想要一個
     * 乾淨起點」與「背景補向量」之間的競爭。死結一定有一邊被 PG 中止，殘留的
     * 那筆 embed 交易很短，退避幾十毫秒再試就會過。
     *
     * **刻意不加 `RESTART IDENTITY`**：同一個理由的另一半。identity 歸零會讓下一個
     * 案例的 job 又拿到 id=1，於是上一個案例殘留的 `UPDATE jobs SET token_in = token_in + …
     * WHERE id = 1` 會結結實實記到新案例頭上（實測就是這樣讓 token_in 變成兩倍的）。
     * 讓 id 在整輪測試裡單調遞增，殘留寫入就只會打在已經不存在的列上，影響 0 列。
     * 本檔所有斷言用的都是「插入時回傳的 id」，沒有任何一處假設 id 從 1 開始。
     */
    async function truncateAll(attempts = 10) {
        await waitForIdleBackends();
        for (let i = 1; ; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempts, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                // 40P01 死結、55P03 拿不到鎖；其餘錯誤是真問題，直接往上丟
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= attempts) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
                await waitForIdleBackends();
            }
        }
    }

    /**
     * 等到這個資料庫上沒有其他連線正在跑查詢為止（最多等 timeoutMs）。
     *
     * 比「死結了再重試」更早一步：殘留的 embed 交易通常只有幾毫秒，先讓它跑完，
     * TRUNCATE 就根本不會去跟它搶鎖。等不到也不丟錯——後面的重試還會兜底。
     */
    async function waitForIdleBackends(timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        for (; ;) {
            const { rows } = await query(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`);
            if (rows[0].n === 0 || Date.now() >= deadline) return;
            await new Promise(r => setTimeout(r, 20));
        }
    }

    /**
     * 這個 job 真的入庫的題目（依 job_questions.question_id 反查）。
     *
     * 刻意不用 `SELECT … FROM questions` 全表查：`questions` 是所有案例、
     * 甚至其他整合測試檔共用的表，全表斷言等於把「別人留下什麼」也算進來。
     * 每個案例只該對自己造出來的資料下斷言。
     *
     * @param {number} jobId
     * @param {string} [columns] 要取的欄位
     */
    async function savedQuestions(jobId, columns = '*') {
        const { rows } = await query(
            `SELECT ${columns} FROM questions q
               JOIN job_questions jq ON jq.question_id = q.id
              WHERE jq.job_id = $1 ORDER BY q.id`, [jobId]);
        return rows;
    }

    /** 一直 tick 到沒有可推進的列為止（每次 tick 之後等 in-flight 清空）。 */
    async function drain(runner, maxRounds = 60) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            const { rows } = await query(
                `SELECT COUNT(*)::int AS n FROM job_questions
                  WHERE state IN ('extracted','hashed','classified','linted','verified','deduped')`);
            const { rows: jobs } = await query(`SELECT COUNT(*)::int AS n FROM jobs WHERE state IN ('queued','extracting')`);
            if (rows[0].n === 0 && jobs[0].n === 0) return i + 1;
        }
        throw new Error('drain：超過上限仍有未推進的列');
    }

    describe('階段 2 管線（PostgreSQL）', () => {
        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
        });

        beforeEach(async () => {
            await truncateAll();
            fakeExtract.resetCounts();
            fakeCommon.resetCounts();
            fakeLlm.calls = 0;
            fakeLlm.schemaFallback = false;
            for (const f of fs.readdirSync(JOBS_DIR)) fs.unlinkSync(path.join(JOBS_DIR, f));
        });

        after(async () => {
            await pool.end();
        });

        // ─────────────────── runner：整條管線 ───────────────────

        describe('runner — 對假 agent 的完整流程', () => {
            test('三題全過 → 全部入庫、job 收成 done、每個節點各一列 job_events', async () => {
                const { jobId, jqIds } = await seedJob([1, 2, 3].map(i => extractPayload(i)));
                const runner = makeRunner();
                await drain(runner);

                const { rows } = await query(
                    'SELECT id, state, question_id, review_reason FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.equal(rows.length, 3);
                for (const r of rows) {
                    assert.equal(r.state, 'saved');
                    assert.equal(typeof r.question_id, 'number');
                    assert.equal(r.review_reason, null);
                }

                const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
                assert.equal(job[0].state, 'done', '所有列都到終態時 job 要變 done');

                // 六個節點 × 三題 = 18 列事件，且 outcome 全是 pass
                const { rows: ev } = await query(
                    `SELECT node, outcome, COUNT(*)::int AS n FROM job_events WHERE job_id = $1
                     GROUP BY node, outcome ORDER BY node`, [jobId]);
                assert.deepEqual(ev.map(e => [e.node, e.outcome, e.n]).sort(), [
                    ['classify', 'pass', 3], ['dedup0', 'pass', 3], ['dedup1', 'pass', 3],
                    ['lint', 'pass', 3], ['save', 'pass', 3], ['verify', 'pass', 3]
                ].sort());

                // 入庫的欄位：origin/chapter_src/text_hash 照第 3.3 條
                const q = await savedQuestions(jobId,
                     'origin, chapter_src, text_hash, search_tsv IS NOT NULL AS has_tsv');
                assert.equal(q.length, 3);
                for (const row of q) {
                    assert.equal(row.origin, 'pdf');
                    assert.equal(row.chapter_src, 'ai');
                    assert.match(row.text_hash, /^[0-9a-f]{64}$/, 'dedup0 算的 text_hash 要一起寫進 questions');
                    assert.equal(row.has_tsv, true, '新題必須立刻有 search_tsv（interfaces.md 12.4）');
                }
                assert.equal(jqIds.length, 3);
            });

            test('部分入庫：一題卡在 needs_review，其餘照樣進題庫', async () => {
                // 第 2 題的 verify 一律 answer_mismatch（上限 1 次重試，之後進複核）
                const { jobId } = await seedJob([
                    extractPayload(1),
                    extractPayload(2, { __fake: { verify: { kind: 'fail', reason: 'answer_mismatch' } } }),
                    extractPayload(3)
                ]);
                const runner = makeRunner();
                await drain(runner);

                const { rows } = await query(
                    'SELECT idx, state, review_reason, question_id FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.deepEqual(rows.map(r => r.state), ['saved', 'needs_review', 'saved']);
                assert.equal(rows[1].review_reason, 'answer_mismatch');
                assert.equal(rows[1].question_id, null, '沒過閘門的題目不得入庫');

                assert.equal((await savedQuestions(jobId)).length, 2, '整批退回是舊行為，管線要部分入庫');

                // verify 被試了 1 + 1 次（maxRetries.verify = 1）
                const { rows: ev } = await query(
                    `SELECT e.attempt FROM job_events e JOIN job_questions q ON q.id = e.jq_id
                      WHERE e.job_id = $1 AND e.node = 'verify' AND q.idx = 1002 ORDER BY e.attempt`, [jobId]);
                assert.deepEqual(ev.map(e => e.attempt), [1, 2]);
            });

            test('重試後成功：classify 前兩次失敗、第三次過，retries 記在 payload 之外的欄位', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { classify: { kind: 'fail', reason: 'chapter_invalid', times: 2 } } })
                ]);
                await drain(makeRunner());

                const { rows } = await query('SELECT state, retries FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'saved');
                assert.equal(rows[0].retries.classify, 2, 'maxRetries.classify = 2，用滿兩次後第三次成功');

                const { rows: ev } = await query(
                    `SELECT attempt, outcome FROM job_events WHERE job_id = $1 AND node = 'classify' ORDER BY attempt`, [jobId]);
                assert.deepEqual(ev, [
                    { attempt: 1, outcome: 'fail' }, { attempt: 2, outcome: 'fail' }, { attempt: 3, outcome: 'pass' }
                ]);
            });

            test('供應商錯誤：退避三次後 provider_error，fail 與 error 是兩組計數器', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { lint: { kind: 'error', errorClass: 'rate_limited' } } })
                ]);
                await drain(makeRunner());

                const { rows } = await query('SELECT state, review_reason, retries FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'needs_review');
                assert.equal(rows[0].review_reason, 'provider_error');
                assert.equal(rows[0].retries['lint:error'], 3, 'maxErrorRetries = 3');
                assert.equal(rows[0].retries.lint, undefined, 'error 不該吃掉 fail 的額度');

                const { rows: ev } = await query(
                    `SELECT attempt, outcome, error_class FROM job_events WHERE job_id = $1 AND node = 'lint' ORDER BY attempt`, [jobId]);
                assert.equal(ev.length, 4, '3 次退避 + 第 4 次用盡');
                assert.deepEqual([...new Set(ev.map(e => e.error_class))], ['rate_limited']);
            });

            test('agent 直接 throw 也被包成 error，不會拖垮整份 job', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { classify: { kind: 'throw', message: '假 agent 爆炸' } } }),
                    extractPayload(2)
                ]);
                await drain(makeRunner());

                const { rows } = await query(
                    'SELECT idx, state, review_reason FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.deepEqual(rows.map(r => r.state), ['needs_review', 'saved']);
                assert.equal(rows[0].review_reason, 'provider_error');
            });

            test('節點逾時：AbortController 中斷後記 timeout，review_reason 收斂成 provider_error', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { verify: { kind: 'hang' } } })
                ]);
                await drain(makeRunner({ nodeTimeoutMs: 120 }));

                const { rows } = await query('SELECT state, review_reason FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'needs_review');
                assert.equal(rows[0].review_reason, 'provider_error');

                const { rows: ev } = await query(
                    `SELECT DISTINCT error_class FROM job_events WHERE job_id = $1 AND node = 'verify'`, [jobId]);
                assert.deepEqual(ev.map(e => e.error_class), ['timeout']);
            });

            test('證明題的 verify 走 skipped，照樣入庫', async () => {
                const { jobId } = await seedJob([extractPayload(1, { question_type: '證明' })]);
                await drain(makeRunner());

                const { rows } = await query('SELECT state, payload FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'saved');
                assert.equal(rows[0].payload.verify.skipped, true);

                const { rows: ev } = await query(
                    `SELECT outcome FROM job_events WHERE job_id = $1 AND node = 'verify'`, [jobId]);
                assert.equal(ev[0].outcome, 'skipped');
            });

            test('figure_desc 以 [附圖描述：…] 併回題幹末端後才入庫', async () => {
                const { jobId } = await seedJob([extractPayload(1, { figure_desc: '一個單位圓' })]);
                await drain(makeRunner());
                const rows = await savedQuestions(jobId, 'question_text');
                assert.match(rows[0].question_text, /\n\[附圖描述：一個單位圓\]$/);
            });

            test('save 的閘門擋得住壞欄位：章節不在白名單 → schema_invalid', async () => {
                const { jobId } = await seedJob([extractPayload(1, { chapter: '這章不存在' })]);
                await drain(makeRunner());

                const { rows } = await query('SELECT state, review_reason FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'needs_review');
                assert.equal(rows[0].review_reason, 'schema_invalid');
                assert.equal((await savedQuestions(jobId)).length, 0);
            });
        });

        // ─────────────────── §12 第一輪裁決 ───────────────────

        describe('runner — §12 裁決 S2-4／S2-8', () => {
            test('S2-8：agent 從 ctx.config.features 拿得到 {similar, pipeline}（小寫短名）', async () => {
                const saved = { s: process.env.FEATURE_SIMILAR, p: process.env.FEATURE_PIPELINE };
                process.env.FEATURE_SIMILAR = 'true';
                process.env.FEATURE_PIPELINE = 'false';
                try {
                    const { jobId } = await seedJob([
                        extractPayload(1, { __fake: { classify: { kind: 'echoCtx' } } })
                    ]);
                    await drain(makeRunner());

                    const { rows } = await query('SELECT payload FROM job_questions WHERE job_id = $1', [jobId]);
                    assert.deepEqual(rows[0].payload.classify.__features, { similar: true, pipeline: false },
                        '鍵名必須是小寫短名，值來自 config/features.js');
                } finally {
                    if (saved.s === undefined) delete process.env.FEATURE_SIMILAR; else process.env.FEATURE_SIMILAR = saved.s;
                    if (saved.p === undefined) delete process.env.FEATURE_PIPELINE; else process.env.FEATURE_PIPELINE = saved.p;
                }
            });

            test('S2-4：generateJson 回 schemaFallback → job_events.detail.schema_fallback = true', async () => {
                fakeLlm.schemaFallback = true;
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { classify: { kind: 'spendThenPass' } } })
                ]);
                await drain(makeRunner());

                const { rows } = await query(
                    `SELECT detail->>'schema_fallback' AS sf FROM job_events
                      WHERE job_id = $1 AND node = 'classify'`, [jobId]);
                assert.equal(rows[0].sf, 'true');
            });

            test('S2-4：沒走退路時不寫這個鍵（detail 不必逐列存一個 false）', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { classify: { kind: 'spendThenPass' } } })
                ]);
                await drain(makeRunner());

                const { rows } = await query(
                    `SELECT detail ? 'schema_fallback' AS has_key FROM job_events
                      WHERE job_id = $1 AND node = 'classify'`, [jobId]);
                assert.equal(rows[0].has_key, false);
            });
        });

        // ─────────────────── runner：預算與租約 ───────────────────

        describe('runner — 預算三層與全域止血', () => {
            test('用量累加回 jobs（token_out 含 thinking），cost_usd 跟著長', async () => {
                const { jobId } = await seedJob([
                    extractPayload(1, { __fake: { classify: { kind: 'spendThenPass' } } })
                ]);
                await drain(makeRunner());

                const { rows } = await query('SELECT token_in, token_out, cost_usd::float8 AS cost FROM jobs WHERE id = $1', [jobId]);
                assert.equal(rows[0].token_in, 1000);
                assert.equal(rows[0].token_out, 500, 'token_out 必須是 candidates 100 + thinking 400（第 0.4 條）');
                assert.ok(rows[0].cost > 0);

                const { rows: ev } = await query(
                    `SELECT token_in, token_out, token_thinking, cost_estimated FROM job_events
                      WHERE job_id = $1 AND node = 'classify'`, [jobId]);
                assert.deepEqual(
                    { ti: ev[0].token_in, to: ev[0].token_out, tt: ev[0].token_thinking, est: ev[0].cost_estimated },
                    { ti: 1000, to: 100, tt: 400, est: true });
            });

            test('每份 PDF 的預算：呼叫前就擋下，剩餘的列全部 budget_exceeded 且不再呼叫 LLM', async () => {
                const { jobId } = await seedJob([1, 2, 3].map(i => extractPayload(i)), { budget: 0.05 });
                // 直接把已花費推到預算上，模擬「前面幾題已經把錢用光」
                await query('UPDATE jobs SET cost_usd = budget_usd WHERE id = $1', [jobId]);

                fakeLlm.calls = 0;
                await drain(makeRunner());

                const { rows } = await query(
                    'SELECT state, review_reason FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                for (const r of rows) {
                    assert.equal(r.state, 'needs_review');
                    assert.equal(r.review_reason, 'budget_exceeded');
                }
                assert.equal(fakeLlm.calls, 0, '預算用盡後一次 LLM 都不該叫（第 7.3.2 條）');

                // 零成本的 dedup0 仍然跑過（它不花錢），classify 才是被擋下的那一格
                const { rows: ev } = await query(
                    `SELECT node, outcome, error_class FROM job_events WHERE job_id = $1 ORDER BY id`, [jobId]);
                assert.ok(ev.some(e => e.node === 'dedup0' && e.outcome === 'pass'));
                assert.ok(ev.some(e => e.node === 'classify' && e.error_class === 'budget_exceeded'));
            });

            test('DAILY_COST_BUDGET_USD 超線後不再認領新 job，零成本節點仍可推進', async () => {
                const { jobId } = await seedJob([extractPayload(1)]);
                // 塞一列昂貴的當日事件，把全域額度用光
                await query(
                    `INSERT INTO job_events (job_id, node, attempt, latency_ms, outcome, cost_usd)
                     VALUES ($1, 'classify', 1, 10, 'pass', 99)`, [jobId]);

                const runner = makeRunner({ dailyCostBudgetUsd: 1 });
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT state FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'hashed', 'dedup0（零成本）照跑，但停在 classify 之前不再花錢');

                // 再 tick 幾次也不會前進（classify 對應的 hashed 不在放行清單內）
                for (let i = 0; i < 3; i++) {
                    await runner.tick();
                    while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
                }
                const { rows: after } = await query('SELECT state FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(after[0].state, 'hashed');
                assert.equal(fakeLlm.calls, 0);
            });

            test('租約：已被認領且未到期的列不會被第二個 runner 重認領', async () => {
                const { jobId, jqIds } = await seedJob([extractPayload(1)]);
                // 手動上一個還沒到期的租約（模擬另一個槽正在付費）
                await query(
                    `UPDATE job_questions SET locked_until = now() + interval '5 minutes' WHERE id = $1`, [jqIds[0]]);

                const runner = makeRunner();
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT state FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].state, 'extracted', '租約還在，這一列不該被動到');
                assert.equal(fakeLlm.calls, 0);

                // 租約過期後同一列會被重新認領——這就是崩潰重跑的保證
                await query(`UPDATE job_questions SET locked_until = now() - interval '1 second' WHERE id = $1`, [jqIds[0]]);
                await drain(runner);
                const { rows: after } = await query('SELECT state FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(after[0].state, 'saved');
            });
        });

        // ─────────────────── runner：extract ───────────────────

        describe('runner — 拆題（extract）', () => {
            /** 寫一份「假 PDF」：內容其實是給 fakeAgents/extract.js 讀的劇本。 */
            async function seedPdfJob(plan, { pageCount = 20, budget = 0.5 } = {}) {
                const sha = require('node:crypto').randomBytes(32).toString('hex');
                const { rows } = await query(
                    `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
                     VALUES ('pdf', $1, 'queued', $2, $3) RETURNING id`, [sha, budget, pageCount]);
                const jobId = rows[0].id;
                const rel = path.posix.join('data', 'jobs', `${jobId}.pdf`);
                fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), JSON.stringify(plan), 'utf8');
                await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, rel]);
                return jobId;
            }

            test('拆完建 job_questions、刪 PDF、pdf_path 清成 NULL、state 轉 processing', async () => {
                const jobId = await seedPdfJob({ questions: [extractPayload(1), extractPayload(2)] });
                const runner = makeRunner();
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT state, pdf_path FROM jobs WHERE id = $1', [jobId]);
                assert.equal(rows[0].pdf_path, null, '拆完就刪檔並清空 pdf_path（第 1.3 條）');
                assert.equal(fs.existsSync(path.join(JOBS_DIR, `${jobId}.pdf`)), false);
                assert.ok(['processing', 'done'].includes(rows[0].state));

                const { rows: jq } = await query('SELECT idx FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.deepEqual(jq.map(r => r.idx), [1001, 1002]);
            });

            test('多塊：40 頁切成兩塊，各呼叫一次、idx 帶 chunk 偏移', async () => {
                const jobId = await seedPdfJob({
                    chunks: { 1: [extractPayload(1)], 2: [{ ...extractPayload(2), idx: 2001, chunk_no: 2 }] }
                }, { pageCount: 40 });
                const runner = makeRunner();
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT idx FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.deepEqual(rows.map(r => r.idx), [1001, 2001]);

                const { rows: ev } = await query(
                    `SELECT detail->>'chunk' AS chunk FROM job_events WHERE job_id = $1 AND node = 'extract' ORDER BY id`, [jobId]);
                assert.deepEqual(ev.map(e => e.chunk), ['1', '2']);
            });

            test('拆題連續失敗 → job 變 failed 並寫 error', async () => {
                const jobId = await seedPdfJob({
                    questions: [extractPayload(1)],
                    perChunk: { 1: { kind: 'fail', reason: 'schema_invalid' } }
                });
                const runner = makeRunner();
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT state, error FROM jobs WHERE id = $1', [jobId]);
                assert.equal(rows[0].state, 'failed');
                assert.match(rows[0].error, /拆題失敗/);

                // 整包重試 1 次 → 共兩列 extract 事件
                const { rows: ev } = await query(
                    `SELECT attempt FROM job_events WHERE job_id = $1 AND node = 'extract' ORDER BY attempt`, [jobId]);
                assert.deepEqual(ev.map(e => e.attempt), [1, 2]);
            });

            test('拆題的 error 走退避重試，第 3 次成功就照常建列', async () => {
                const jobId = await seedPdfJob({
                    questions: [extractPayload(1)],
                    perChunk: { 1: { kind: 'error', errorClass: 'rate_limited', times: 2 } }
                });
                const runner = makeRunner();
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));

                const { rows } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
                assert.equal(rows[0].n, 1);
            });
        });

        // ─────────────────── 六支 API ───────────────────

        describe('API — POST /api/jobs（第 6.1 條）', () => {
            const PDF = Buffer.from('%PDF-1.4\n/Type /Pages /Count 3\n/Type /Page \n%%EOF');

            // 每個案例一個新的 app 實例：aiRateLimit 是模組層單例，共用會讓後面的案例吃到 429
            let api;
            beforeEach(() => { api = freshApp(); });

            test('202 建立新 job，PDF 落在 data/jobs/<id>.pdf、算得出 page_count', async () => {
                const res = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                assert.equal(res.status, 202);
                assert.equal(res.body.existing, false);
                assert.equal(typeof res.body.job_id, 'number');

                const { rows } = await query('SELECT pdf_path, state, page_count, budget_usd::float8 AS b, pdf_sha256 FROM jobs WHERE id = $1', [res.body.job_id]);
                assert.equal(rows[0].state, 'queued');
                assert.equal(rows[0].pdf_path, `data/jobs/${res.body.job_id}.pdf`);
                assert.equal(rows[0].page_count, 3);
                assert.equal(rows[0].b, 0.5, 'budget_usd 建立時從 JOB_COST_BUDGET_USD 複製');
                assert.match(rows[0].pdf_sha256, /^[0-9a-f]{64}$/);
                assert.equal(fs.existsSync(path.join(JOBS_DIR, `${res.body.job_id}.pdf`)), true);
            });

            test('同一份 PDF 再傳一次 → 冪等回既有 job 且 existing:true', async () => {
                const first = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                const second = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                assert.equal(second.status, 202);
                assert.deepEqual(second.body, { job_id: first.body.job_id, existing: true });

                const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs');
                assert.equal(rows[0].n, 1);
            });

            test('?force=1 一定建新 job', async () => {
                const first = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                const forced = await request(app).post('/api/jobs?force=1').attach('pdf', PDF, 'exam.pdf');
                assert.equal(forced.body.existing, false);
                assert.notEqual(forced.body.job_id, first.body.job_id);
            });

            test('已 failed 的 job 不擋冪等（可以重傳同一份）', async () => {
                const first = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                await query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [first.body.job_id]);
                const again = await request(api).post('/api/jobs').attach('pdf', PDF, 'exam.pdf');
                assert.equal(again.body.existing, false);
            });

            test('沒有檔案 → 400「沒有上傳檔案」', async () => {
                const res = await request(api).post('/api/jobs');
                assert.equal(res.status, 400);
                assert.equal(res.body.message, '沒有上傳檔案');
            });

            test('不是 PDF → 400「只接受 PDF 檔案！」，暫存檔要刪掉', async () => {
                const res = await request(api).post('/api/jobs')
                    .attach('pdf', Buffer.from('not a pdf'), { filename: 'x.txt', contentType: 'text/plain' });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, '只接受 PDF 檔案！');
                const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs');
                assert.equal(rows[0].n, 0);
            });

            test('每分鐘第 11 次 → 429，沿用 aiRateLimit 既有字串（第 6.1 條）', async () => {
                for (let i = 0; i < 10; i++) {
                    const ok = await request(api).post('/api/jobs?force=1').attach('pdf', PDF, 'exam.pdf');
                    assert.equal(ok.status, 202, `第 ${i + 1} 次應該還在額度內`);
                }
                const limited = await request(api).post('/api/jobs?force=1').attach('pdf', PDF, 'exam.pdf');
                assert.equal(limited.status, 429);
                assert.equal(limited.body.message, 'AI 解析請求過於頻繁，請稍候再試（每分鐘最多 10 次）。');
            });

            test('超過 15 MB → 413「PDF 檔案過大，單次最多 15 MB。」', async () => {
                const big = Buffer.alloc(16 * 1024 * 1024, 0x20);
                big.write('%PDF-1.4');
                const res = await request(api).post('/api/jobs').attach('pdf', big, 'big.pdf');
                assert.equal(res.status, 413);
                assert.equal(res.body.message, 'PDF 檔案過大，單次最多 15 MB。');
            });
        });

        describe('API — GET /api/jobs/:id（第 6.2 條）', () => {
            test('counts 四欄相加 = job_questions 總數，cost/budget 是 number', async () => {
                const { jobId } = await seedJob([1, 2, 3, 4].map(i => extractPayload(i)));
                await query(`UPDATE job_questions SET state='saved'        WHERE job_id=$1 AND idx=1001`, [jobId]);
                await query(`UPDATE job_questions SET state='needs_review', review_reason='duplicate' WHERE job_id=$1 AND idx=1002`, [jobId]);
                await query(`UPDATE job_questions SET state='rejected'     WHERE job_id=$1 AND idx=1003`, [jobId]);
                await query(`UPDATE jobs SET token_in=100, token_out=50, cost_usd=0.0412 WHERE id=$1`, [jobId]);

                const res = await request(app).get(`/api/jobs/${jobId}`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.counts, { saved: 1, needs_review: 1, pending: 1, rejected: 1 });
                assert.equal(res.body.state, 'processing');
                assert.equal(res.body.token_in, 100);
                assert.equal(res.body.token_out, 50);
                assert.equal(res.body.cost_usd, 0.0412);
                assert.equal(typeof res.body.cost_usd, 'number', 'NUMERIC 不可以回字串');
                assert.equal(res.body.budget_usd, 0.5);
                assert.equal(typeof res.body.budget_usd, 'number');
                assert.equal(typeof res.body.elapsed_ms, 'number');
                assert.ok(res.body.elapsed_ms >= 0);
            });

            test('還沒拆題的 job：四個 counts 都是 0（見 docs/questions2-wsA.md 第 5 條）', async () => {
                const { rows } = await query(
                    `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd) VALUES ('pdf', repeat('a',64), 'queued', 0.5) RETURNING id`);
                const res = await request(app).get(`/api/jobs/${rows[0].id}`);
                assert.deepEqual(res.body.counts, { saved: 0, needs_review: 0, pending: 0, rejected: 0 });
            });

            test('找不到 → 404「找不到該任務」', async () => {
                for (const p of ['999999', 'abc']) {
                    const res = await request(app).get(`/api/jobs/${p}`);
                    assert.equal(res.status, 404);
                    assert.equal(res.body.message, '找不到該任務');
                }
            });
        });

        describe('API — GET /api/jobs/:id/questions（第 6.3 條）', () => {
            test('分頁、ORDER BY idx、stem_preview 前 80 字且不加省略號', async () => {
                const long = 'あ'.repeat(50) + ' \n\n ' + 'い'.repeat(60);
                const { jobId } = await seedJob([
                    extractPayload(1, { question_text: long }),
                    extractPayload(2), extractPayload(3)
                ]);
                const res = await request(app).get(`/api/jobs/${jobId}/questions?page=1&limit=2`);
                assert.equal(res.status, 200);
                assert.equal(res.body.total, 3);
                assert.equal(res.body.page, 1);
                assert.equal(res.body.limit, 2);
                assert.deepEqual(res.body.items.map(i => i.idx), [1001, 1002]);
                assert.equal(res.body.items[0].stem_preview.length, 80);
                assert.equal(res.body.items[0].stem_preview.includes('\n'), false, '連續空白要換成單一空白');
                assert.equal(res.body.items[0].stem_preview.endsWith('…'), false);
                assert.deepEqual(Object.keys(res.body.items[0]).sort(),
                    ['idx', 'jq_id', 'question_id', 'review_reason', 'state', 'stem_preview']);
            });

            test('stem_preview 優先用 lint 修正後的題幹', async () => {
                const { jobId, jqIds } = await seedJob([extractPayload(1)]);
                await query(
                    `UPDATE job_questions SET payload = payload || '{"lint":{"question_text":"修好的題幹"}}'::jsonb WHERE id = $1`,
                    [jqIds[0]]);
                const res = await request(app).get(`/api/jobs/${jobId}/questions`);
                assert.equal(res.body.items[0].stem_preview, '修好的題幹');
            });

            test('page／limit 不是正整數 → 400', async () => {
                const { jobId } = await seedJob([extractPayload(1)]);
                for (const qs of ['page=0', 'page=-1', 'page=abc', 'limit=0', 'limit=x']) {
                    const res = await request(app).get(`/api/jobs/${jobId}/questions?${qs}`);
                    assert.equal(res.status, 400, qs);
                    assert.equal(res.body.message, 'page 與 limit 必須是正整數。');
                }
            });

            test('limit 超過 100 → 400「limit 最大 100。」', async () => {
                const { jobId } = await seedJob([extractPayload(1)]);
                const res = await request(app).get(`/api/jobs/${jobId}/questions?limit=101`);
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'limit 最大 100。');
            });

            test('job 不存在 → 404', async () => {
                const res = await request(app).get('/api/jobs/999999/questions');
                assert.equal(res.status, 404);
                assert.equal(res.body.message, '找不到該任務');
            });
        });

        describe('API — GET /api/review（第 6.4 條）', () => {
            async function seedReviewQueue() {
                const { jobId, jqIds } = await seedJob([1, 2, 3].map(i => extractPayload(i)));
                await query(`UPDATE job_questions SET state='needs_review', review_reason='answer_mismatch' WHERE id=$1`, [jqIds[0]]);
                await query(`UPDATE job_questions SET state='needs_review', review_reason='duplicate'       WHERE id=$1`, [jqIds[1]]);
                await query(`UPDATE job_questions SET state='saved'                                          WHERE id=$1`, [jqIds[2]]);
                return { jobId, jqIds };
            }

            test('跨 job 的 needs_review 佇列，ORDER BY id ASC（先進先審）', async () => {
                const { jobId, jqIds } = await seedReviewQueue();
                const res = await request(app).get('/api/review');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.items.map(i => i.jq_id), [jqIds[0], jqIds[1]]);
                assert.equal(res.body.items[0].job_id, jobId);
                assert.deepEqual(Object.keys(res.body.items[0]).sort(),
                    ['idx', 'job_id', 'jq_id', 'question_id', 'review_reason', 'state', 'stem_preview']);
            });

            test('reason 過濾', async () => {
                const { jqIds } = await seedReviewQueue();
                const res = await request(app).get('/api/review?reason=duplicate');
                assert.deepEqual(res.body.items.map(i => i.jq_id), [jqIds[1]]);
            });

            test('reason 不在八個值內 → 400', async () => {
                const res = await request(app).get('/api/review?reason=不存在的原因');
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'reason 不在合法的複核原因清單內。');
            });

            test('limit 超過 200 → 400「limit 最大 200。」', async () => {
                const res = await request(app).get('/api/review?limit=201');
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'limit 最大 200。');
            });
        });

        describe('API — GET /api/review/:jqId（第 6.5 條）', () => {
            test('回完整 payload 與 retries', async () => {
                const { jobId, jqIds } = await seedJob([extractPayload(1)]);
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason='answer_mismatch',
                            retries='{"verify":1}'::jsonb WHERE id=$1`, [jqIds[0]]);

                const res = await request(app).get(`/api/review/${jqIds[0]}`);
                assert.equal(res.status, 200);
                assert.equal(res.body.jq_id, jqIds[0]);
                assert.equal(res.body.job_id, jobId);
                assert.equal(res.body.idx, 1001);
                assert.equal(res.body.review_reason, 'answer_mismatch');
                assert.deepEqual(res.body.retries, { verify: 1 });
                assert.equal(res.body.payload.extract.subject, SUBJECT);
                assert.equal(res.body.question_id, null);
                assert.ok(res.body.created_at && res.body.updated_at);
            });

            test('找不到 → 404「找不到該待複核題目」', async () => {
                for (const p of ['999999', 'abc']) {
                    const res = await request(app).get(`/api/review/${p}`);
                    assert.equal(res.status, 404);
                    assert.equal(res.body.message, '找不到該待複核題目');
                }
            });
        });

        describe('API — approve / reject（第 6.6 條）', () => {
            const GOOD_BODY = {
                subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
                question_text: '老師修正後的題幹：求 $|\\vec{a}|$。', answer_text: '$\\sqrt{5}$'
            };

            async function seedNeedsReview(reason = 'answer_mismatch') {
                const { jobId, jqIds } = await seedJob([extractPayload(1)]);
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason=$2, payload = payload || $3::jsonb
                      WHERE id=$1`,
                    [jqIds[0], reason, JSON.stringify({ dedup0: { text_hash: 'c'.repeat(64) } })]);
                return { jobId, jqId: jqIds[0] };
            }

            test('approve 入庫：origin=pdf、chapter_src=human、text_hash 對修正後題幹重算（S2-23）', async () => {
                const { jobId, jqId } = await seedNeedsReview();
                const res = await request(app).post(`/api/review/${jqId}/approve`).send(GOOD_BODY);
                assert.equal(res.status, 200);
                assert.equal(typeof res.body.question_id, 'number');

                const { rows } = await query(
                    `SELECT origin, chapter_src, text_hash, question_text, search_tsv IS NOT NULL AS has_tsv
                       FROM questions WHERE id = $1`, [res.body.question_id]);
                assert.equal(rows[0].origin, 'pdf');
                assert.equal(rows[0].chapter_src, 'human', '人改過的章節要標 human');
                // 裁決 S2-23：人改過題幹，雜湊就該跟著變，不得沿用 payload.dedup0 那一個。
                // seedNeedsReview 把 payload 的 text_hash 塞成 'cccc…'，正好當對照組。
                assert.equal(rows[0].text_hash, textHash(GOOD_BODY.question_text));
                assert.notEqual(rows[0].text_hash, 'c'.repeat(64), '不可沿用 dedup0 當初算的舊雜湊');
                assert.match(rows[0].text_hash, /^[0-9a-f]{64}$/);
                assert.equal(rows[0].question_text, GOOD_BODY.question_text);
                assert.equal(rows[0].has_tsv, true);

                const { rows: jq } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE id = $1', [jqId]);
                assert.deepEqual(jq[0], { state: 'saved', review_reason: null, question_id: res.body.question_id });

                const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
                assert.equal(job[0].state, 'done', '最後一列處理完就把 job 收成 done');

                const { rows: ev } = await query(
                    `SELECT node, outcome, model, latency_ms FROM job_events WHERE jq_id = $1 AND node = 'approve'`, [jqId]);
                assert.equal(ev.length, 1, '人工動作也要留一列（第 7.4 條）');
                assert.equal(ev[0].outcome, 'pass');
                assert.equal(ev[0].model, null);
                assert.ok(ev[0].latency_ms >= 0);
            });

            test('人也要過閘門：章節不在白名單 → 400「欄位驗證失敗」+ errors 陣列', async () => {
                const { jobId, jqId } = await seedNeedsReview();
                const res = await request(app).post(`/api/review/${jqId}/approve`)
                    .send({ ...GOOD_BODY, chapter: '這章不存在' });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, '欄位驗證失敗');
                assert.ok(Array.isArray(res.body.errors));
                assert.match(res.body.errors[0], /不在 數學 的精細章節白名單中/);

                assert.equal((await savedQuestions(jobId)).length, 0, '驗證失敗不得留下半筆資料');
            });

            test('merge_into：不入新題，只把這一列指到既有題目並記 variant', async () => {
                const { rows: existing } = await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     VALUES ($1, $2, '計算', 3, '既有的題目', '答') RETURNING id`, [SUBJECT, CHAPTER]);
                const { jobId, jqId } = await seedNeedsReview('duplicate');

                const res = await request(app).post(`/api/review/${jqId}/approve`)
                    .send({ ...GOOD_BODY, merge_into: existing[0].id });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { question_id: existing[0].id, merged: true });

                const { rows: q } = await query(
                    'SELECT COUNT(*)::int AS n FROM questions WHERE id = $1', [existing[0].id]);
                assert.equal(q[0].n, 1, 'merge 不該多出一題');
                assert.equal((await savedQuestions(jobId)).length, 1, '只指到既有題目，沒有新增');

                const { rows: jq } = await query('SELECT state, question_id, payload FROM job_questions WHERE id = $1', [jqId]);
                assert.equal(jq[0].state, 'saved');
                assert.equal(jq[0].question_id, existing[0].id);
                assert.equal(jq[0].payload.dedup1.verdict, 'variant');
            });

            test('merge_into 指向不存在的題目 → 400', async () => {
                const { jobId, jqId } = await seedNeedsReview('duplicate');
                const res = await request(app).post(`/api/review/${jqId}/approve`).send({ ...GOOD_BODY, merge_into: 999999 });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'merge_into 指向的題目不存在。');
            });

            test('重複複核 → 409「該題目已處理完畢，不能重複複核。」', async () => {
                const { jobId, jqId } = await seedNeedsReview();
                await request(app).post(`/api/review/${jqId}/approve`).send(GOOD_BODY);

                const again = await request(app).post(`/api/review/${jqId}/approve`).send(GOOD_BODY);
                assert.equal(again.status, 409);
                assert.equal(again.body.message, '該題目已處理完畢，不能重複複核。');

                const rejectAfter = await request(app).post(`/api/review/${jqId}/reject`);
                assert.equal(rejectAfter.status, 409);
                assert.equal(rejectAfter.body.message, '該題目已處理完畢，不能重複複核。');
            });

            test('approve 找不到 → 404', async () => {
                const res = await request(app).post('/api/review/999999/approve').send(GOOD_BODY);
                assert.equal(res.status, 404);
                assert.equal(res.body.message, '找不到該待複核題目');
            });

            test('reject：state 變 rejected、review_reason 保留、不入庫', async () => {
                const { jobId, jqId } = await seedNeedsReview('duplicate');
                const res = await request(app).post(`/api/review/${jqId}/reject`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { message: '已標記為不採用。', jq_id: jqId });

                const { rows } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE id = $1', [jqId]);
                assert.deepEqual(rows[0], { state: 'rejected', review_reason: 'duplicate', question_id: null });

                assert.equal((await savedQuestions(jobId)).length, 0);

                const { rows: ev } = await query(`SELECT COUNT(*)::int AS n FROM job_events WHERE jq_id = $1 AND node = 'reject'`, [jqId]);
                assert.equal(ev[0].n, 1);
            });

            test('reject 找不到 → 404', async () => {
                const res = await request(app).post('/api/review/999999/reject');
                assert.equal(res.status, 404);
                assert.equal(res.body.message, '找不到該待複核題目');
            });
        });

        describe('API — POST /api/jobs/:id/retry（第 6.7 條）', () => {
            test('只退回 provider_error / budget_exceeded 的列，並回到「進複核前」那一格', async () => {
                const { jobId, jqIds } = await seedJob([1, 2, 3].map(i => extractPayload(i)));
                // 第 1 題卡在 classify（payload 有 dedup0、classify）→ 應退回 hashed
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason='provider_error',
                            retries='{"classify:error":3}'::jsonb,
                            payload = payload || '{"dedup0":{},"classify":{}}'::jsonb WHERE id=$1`, [jqIds[0]]);
                // 第 2 題卡在 verify → 應退回 linted
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason='budget_exceeded',
                            payload = payload || '{"dedup0":{},"classify":{},"lint":{},"verify":{}}'::jsonb WHERE id=$1`, [jqIds[1]]);
                // 第 3 題是章節錯，不該被 retry 動到
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason='chapter_invalid' WHERE id=$1`, [jqIds[2]]);
                await query(`UPDATE jobs SET state='done' WHERE id=$1`, [jobId]);

                const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({ budget_usd: 1.25 });
                assert.equal(res.status, 202);
                assert.deepEqual(res.body, { job_id: jobId, requeued: 2 });

                const { rows } = await query(
                    'SELECT id, state, review_reason, retries FROM job_questions WHERE job_id = $1 ORDER BY id', [jobId]);
                assert.equal(rows[0].state, 'hashed');
                assert.equal(rows[0].review_reason, null);
                assert.deepEqual(rows[0].retries, {}, '該節點的兩個計數要清掉，讓它從頭來過');
                assert.equal(rows[1].state, 'linted');
                assert.equal(rows[2].state, 'needs_review', 'chapter_invalid 不在可重跑清單內');

                const { rows: job } = await query('SELECT state, budget_usd::float8 AS b FROM jobs WHERE id = $1', [jobId]);
                assert.equal(job[0].state, 'processing');
                assert.equal(job[0].b, 1.25);

                const { rows: ev } = await query(`SELECT COUNT(*)::int AS n FROM job_events WHERE job_id=$1 AND node='retry'`, [jobId]);
                assert.equal(ev[0].n, 1);
            });

            test('退回去的列真的會被 runner 重新推進到終態', async () => {
                const { jobId, jqIds } = await seedJob([extractPayload(1)]);
                await query(
                    `UPDATE job_questions SET state='needs_review', review_reason='provider_error',
                            retries='{"classify:error":3}'::jsonb,
                            payload = payload || '{"dedup0":{},"classify":{}}'::jsonb WHERE id=$1`, [jqIds[0]]);

                await request(app).post(`/api/jobs/${jobId}/retry`).send({});
                await drain(makeRunner());

                const { rows } = await query('SELECT state FROM job_questions WHERE id = $1', [jqIds[0]]);
                assert.equal(rows[0].state, 'saved');
            });

            test('budget_usd 不合法 → 400', async () => {
                const { jobId } = await seedJob([extractPayload(1)]);
                for (const v of [0, -1, 'abc', '']) {
                    const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({ budget_usd: v });
                    assert.equal(res.status, 400, String(v));
                    assert.equal(res.body.message, 'budget_usd 必須是大於 0 的數字。');
                }
            });

            test('沒有可重跑的題目 → 409', async () => {
                const { jobId } = await seedJob([extractPayload(1)]);
                const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
                assert.equal(res.status, 409);
                assert.equal(res.body.message, '這份任務沒有可重跑的題目。');
            });

            test('job failed 且 PDF 已刪 → 409「PDF 原檔已刪除，無法重跑拆題。」', async () => {
                const { jobId } = await seedJob([], { state: 'failed' });
                const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
                assert.equal(res.status, 409);
                assert.equal(res.body.message, 'PDF 原檔已刪除，無法重跑拆題。');
            });

            test('job failed 但 PDF 還在 → 202 並把 job 排回 queued 重跑 extract', async () => {
                const { jobId } = await seedJob([], { state: 'failed' });
                await query(`UPDATE jobs SET pdf_path = $2 WHERE id = $1`, [jobId, `data/jobs/${jobId}.pdf`]);
                fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), JSON.stringify({ questions: [extractPayload(1)] }), 'utf8');

                const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
                assert.equal(res.status, 202);
                const { rows } = await query('SELECT state, error FROM jobs WHERE id = $1', [jobId]);
                assert.equal(rows[0].state, 'queued');
                assert.equal(rows[0].error, null);

                await drain(makeRunner());
                const { rows: jq } = await query('SELECT state FROM job_questions WHERE job_id = $1', [jobId]);
                assert.deepEqual(jq.map(r => r.state), ['saved']);
            });

            test('找不到 → 404', async () => {
                const res = await request(app).post('/api/jobs/999999/retry').send({});
                assert.equal(res.status, 404);
                assert.equal(res.body.message, '找不到該任務');
            });
        });

        describe('app.js — serveIndex 的旗標注入（裁決 S2-20）', () => {
            test('FEATURE_PIPELINE=true 時注入 true，__FEATURE_PIPELINE__ 不得殘留', async () => {
                const saved = process.env.FEATURE_PIPELINE;
                process.env.FEATURE_PIPELINE = 'true';
                try {
                    const res = await request(freshApp()).get('/');
                    assert.equal(res.status, 200);
                    assert.match(res.text, /<meta name="feature-pipeline" content="true">/);
                    assert.equal(res.text.includes('__FEATURE_PIPELINE__'), false);
                    assert.equal(res.text.includes('__API_KEY__'), false, '兩個佔位字串要在同一次替換裡處理掉');
                } finally {
                    if (saved === undefined) delete process.env.FEATURE_PIPELINE; else process.env.FEATURE_PIPELINE = saved;
                }
            });

            test('未設定時注入字面 false（旗標預設關）', async () => {
                const saved = process.env.FEATURE_PIPELINE;
                delete process.env.FEATURE_PIPELINE;
                try {
                    const res = await request(freshApp()).get('/');
                    assert.match(res.text, /<meta name="feature-pipeline" content="false">/);
                } finally {
                    if (saved !== undefined) process.env.FEATURE_PIPELINE = saved;
                }
            });

            test('/index.html 走同一支 serveIndex，注入結果一致', async () => {
                const saved = process.env.FEATURE_PIPELINE;
                process.env.FEATURE_PIPELINE = '1';
                try {
                    const res = await request(freshApp()).get('/index.html');
                    assert.match(res.text, /<meta name="feature-pipeline" content="1">/);
                } finally {
                    if (saved === undefined) delete process.env.FEATURE_PIPELINE; else process.env.FEATURE_PIPELINE = saved;
                }
            });
        });

        // ─────────────────── 端到端：上傳 → 拆題 → 部分入庫 → 複核 ───────────────────

        describe('端到端：POST /api/jobs → runner → GET /api/jobs/:id → approve', () => {
            test('一份 PDF 走完全程，counts 與題庫對得起來', async () => {
                const api = freshApp();
                const plan = {
                    questions: [
                        extractPayload(1),
                        extractPayload(2, { __fake: { verify: { kind: 'fail', reason: 'answer_mismatch' } } })
                    ]
                };
                // 用 API 建 job（走真正的 multer + sha256 + 寫檔路徑），再把檔案內容換成劇本
                const created = await request(api).post('/api/jobs')
                    .attach('pdf', Buffer.from('%PDF-1.4\n/Type /Pages /Count 2\n%%EOF'), 'exam.pdf');
                const jobId = created.body.job_id;
                fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), JSON.stringify(plan), 'utf8');

                await drain(makeRunner());

                const progress = await request(app).get(`/api/jobs/${jobId}`);
                // needs_review 也是終態（第 2.1 條），所以「還有題目等人複核」的 job 一樣是 done——
                // 前端要看的是 counts.needs_review，不是 state。
                assert.equal(progress.body.state, 'done');
                assert.deepEqual(progress.body.counts, { saved: 1, needs_review: 1, pending: 0, rejected: 0 });

                const queue = await request(app).get('/api/review?reason=answer_mismatch');
                assert.equal(queue.body.items.length, 1);
                const jqId = queue.body.items[0].jq_id;

                const detail = await request(app).get(`/api/review/${jqId}`);
                assert.equal(detail.body.payload.verify.compare, undefined, 'fail 的節點不會留下 compare');
                assert.equal(detail.body.retries.verify, 1);

                const approved = await request(app).post(`/api/review/${jqId}/approve`).send({
                    subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
                    question_text: '老師確認過的題幹', answer_text: '$1$'
                });
                assert.equal(approved.status, 200);

                const done = await request(app).get(`/api/jobs/${jobId}`);
                assert.equal(done.body.state, 'done');
                assert.deepEqual(done.body.counts, { saved: 2, needs_review: 0, pending: 0, rejected: 0 });

                const saved = await savedQuestions(jobId, 'chapter_src');
                assert.deepEqual(saved.map(r => r.chapter_src), ['ai', 'human'],
                    '第一題由管線入庫（ai），第二題經人複核（human）');
            });
        });
    });
}
