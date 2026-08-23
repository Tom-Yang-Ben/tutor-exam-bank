// ─────────────────────────────────────────────────────────────
// variants.pg.test.js — 變式題端點與變式 job 的整合測試（P-10／P-12，擁有者：WS-B）
//
// 三道防線與 jobs.pg.test.js 完全一致：
//   1. **只讀 process.env.TEST_DATABASE_URL，本檔絕不 require('dotenv')**——
//      `npm test` 不預載 .env，因此這整支會被 skip，單元測試永遠不連 DB。
//   2. 資料庫名必須以 `_test` 結尾。
//   3. 在 require config/db.js **之前**覆寫 DATABASE_URL。
//
// LLM：runner 的 llm 由測試注入一支假的；agents 指到 test/fixtures/fakeVariantAgents/
//      （只有 generate.js 是自己的，其餘四支轉接到 WS-A 的 fakeAgents）——不連 Gemini。
//
// 這一支要證明的三件事：
//   ① retrieved 分支那段帶 `<=>` 的 SQL 真的跑得起來、八個條件真的有效
//      （純文字單測只擋得住參數錯位，擋不了 SQL 語法錯）；
//   ② 變式 job 走的是**階段 2 那條一模一樣的狀態機**，只是 extract 換成 generate；
//   ③ VARIANT_AUTO_APPROVE=false 的政策停等與 approve 的三個欄位。
//
// ⚠ 跑這支之前，確認沒有另一個 runner 行程正指著測試庫（同 jobs.pg.test.js 的提醒）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('變式題整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
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
    process.env.JOB_RUNNER = 'off';              // 測試自己驅動 tick，不要背景 runner 插隊
    process.env.FEATURE_VARIANTS = 'true';       // 旗標關閉時路由不掛載（第 3 條）
    // 裁決 S3-R9：兩個門檻分家，整合測試兩個都明寫（不靠舊名的退路）
    process.env.VARIANT_RETRIEVE_SIM_MIN = '0.80';
    process.env.VARIANT_OFFTOPIC_SIM_MIN = '0.92';
    delete process.env.VARIANT_SIM_MIN;
    process.env.VARIANT_MAX_PER_REQUEST = '3';
    process.env.VARIANT_TOKEN_BUDGET_USD = '0.30';

    const request = require('supertest');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const variantService = require(path.join(APP_DIR, 'services', 'variantService'));
    const dedup = require(path.join(APP_DIR, 'agents', 'dedup'));
    const fakeGenerate = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeVariantAgents', 'generate.js'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeVariantAgents');
    const SUBJECT = '數學';
    const CHAPTER = '向量內積';
    const DIM = 768;

    /** 每次呼叫都建一個全新的 app（限流器是模組層單例，同 jobs.pg.test.js 的理由）。 */
    function freshApp() {
        for (const key of Object.keys(require.cache)) {
            if (key === path.join(APP_DIR, 'app.js') || key === path.join(APP_DIR, 'routes', 'index.js')) {
                delete require.cache[key];
            }
        }
        return require(path.join(APP_DIR, 'app'));
    }

    const fakeLlm = {
        async generateJson() {
            return {
                data: {}, latencyMs: 5,
                usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 400, tokenCached: 0 },
                raw: {}, schemaFallback: false
            };
        },
        async embed() { return { vectors: [unitVector(0)], usage: { tokenIn: 10 } }; }
    };

    function fakeEstimateCost(meter) {
        if (meter.calls === 0) return { cost_usd: 0, cost_estimated: false };
        return { cost_usd: ((meter.tokenOut + meter.tokenThinking) / 1000) * 0.001, cost_estimated: true };
    }

    function makeRunner(overrides = {}) {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir: FAKE_AGENTS_DIR,
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },
            estimateCost: fakeEstimateCost,
            config: { nodeTimeoutMs: 2000, leaseMs: 60000, concurrency: 2, ...overrides }
        });
    }

    /**
     * 一個可控餘弦的單位向量：與 unitVector(0) 的內積 = cos(theta)。
     * 用真的 768 維向量而不是造假的相似度，pgvector 的 `<=>` 才真的被算到。
     */
    function unitVector(theta) {
        const v = new Array(DIM).fill(0);
        v[0] = Math.cos(theta);
        v[1] = Math.sin(theta);
        return v;
    }

    function toVectorLiteral(v) {
        return `[${v.join(',')}]`;
    }

    /**
     * 插一題進題庫。
     * @param {{theta?:number, difficulty?:number, subject?:string, chapter?:string,
     *          variantOf?:number|null, archived?:boolean, withVector?:boolean, text?:string}} opts
     */
    async function insertQuestion(opts = {}) {
        const {
            theta = 0, difficulty = 3, subject = SUBJECT, chapter = CHAPTER,
            variantOf = null, archived = false, withVector = true,
            text = `自製測試題（theta=${theta}）：設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。`
        } = opts;
        const { rows } = await query(
            `INSERT INTO questions
                (subject, chapter, question_type, difficulty, question_text, answer_text,
                 origin, chapter_src, variant_of, archived_at, embedding)
             VALUES ($1,$2,'計算',$3,$4,'$\\sqrt{5}$','seed','human',$5,$6,$7::vector)
             RETURNING id`,
            [subject, chapter, difficulty, text, variantOf,
                archived ? new Date() : null, withVector ? toVectorLiteral(unitVector(theta)) : null]);
        return rows[0].id;
    }

    /** 清空四張管線表與題庫（順序照 FK；不 RESTART IDENTITY，理由同 jobs.pg.test.js）。 */
    async function truncateAll() {
        for (let attempt = 0; ; attempt++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs, attempts, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if (err.code !== '40P01' || attempt >= 4) throw err;
                await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
            }
        }
    }

    before(async () => { await truncateAll(); });
    beforeEach(async () => { await truncateAll(); fakeGenerate.resetCounts(); });
    after(async () => { await truncateAll(); await pool.end(); });

    // ─────────────────── ① POST /api/questions/:id/variants ───────────────────

    describe('POST /api/questions/:id/variants — 參數與四個狀態碼（第 3 條）', () => {
        test('400：:id 不是整數', async () => {
            const res = await request(freshApp()).post('/api/questions/abc/variants').send({});
            assert.equal(res.status, 400);
            assert.deepEqual(res.body, { message: '無效的題目 ID' });
        });

        test('404：題目不存在', async () => {
            const res = await request(freshApp()).post('/api/questions/999999/variants').send({});
            assert.equal(res.status, 404);
            assert.deepEqual(res.body, { message: '找不到該題目' });
        });

        test('404：題目已封存（與 /similar 同一條線）', async () => {
            const id = await insertQuestion({ archived: true });
            const res = await request(freshApp()).post(`/api/questions/${id}/variants`).send({});
            assert.equal(res.status, 404);
        });

        test('409：藍本沒有向量，訊息與 /similar 逐字相同', async () => {
            const id = await insertQuestion({ withVector: false });
            const res = await request(freshApp()).post(`/api/questions/${id}/variants`).send({});
            assert.equal(res.status, 409);
            assert.equal(res.body.message, '該題尚未建立向量，請執行 npm run embed:backfill');
        });

        test('400：四個參數的訊息字串逐字凍結', async () => {
            const id = await insertQuestion();
            const app = freshApp();
            const cases = [
                [{ count: 4 }, 'count 必須是 1~3 的整數。'],
                [{ difficulty_delta: 2 }, 'difficulty_delta 只接受 -1、0、1。'],
                [{ student_id: 0 }, 'student_id 必須是正整數。'],
                [{ force_generate: 'yes' }, 'force_generate 必須是布林值。']
            ];
            for (const [body, message] of cases) {
                const res = await request(app).post(`/api/questions/${id}/variants`).send(body);
                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.message, message);
            }
        });
    });

    describe('retrieved 分支的八個條件（真的下 SQL）', () => {
        test('池夠用 → 200，score 就是 cosine，且依 cosine 由大到小', async () => {
            const source = await insertQuestion({ theta: 0 });
            const near = await insertQuestion({ theta: 0.10 });     // cos ≈ 0.995
            const mid = await insertQuestion({ theta: 0.30 });      // cos ≈ 0.955
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 2 });

            assert.equal(res.status, 200);
            assert.equal(res.body.mode, 'retrieved');
            assert.deepEqual(res.body.questions.map(q => q.id), [near, mid]);
            for (const q of res.body.questions) {
                assert.equal(q.score, q.cosine);
                assert.ok(q.cosine >= 0.8);
                assert.equal(q.subject, SUBJECT);
            }
        });

        test('餘弦低於 VARIANT_RETRIEVE_SIM_MIN 的不算數 → 池不足就走 202', async () => {
            const source = await insertQuestion({ theta: 0 });
            await insertQuestion({ theta: 1.2 });                   // cos ≈ 0.362，遠低於 0.80
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202);
            assert.equal(res.body.mode, 'generating');
        });

        test('難度是「字面語意」：delta=0 時只收同難度的題', async () => {
            const source = await insertQuestion({ theta: 0, difficulty: 3 });
            await insertQuestion({ theta: 0.1, difficulty: 4 });
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202, '難度不同的題不該被算進池子');
        });

        test('delta=+1 時鎖定 difficulty+1（不是 ±1 的區間）', async () => {
            const source = await insertQuestion({ theta: 0, difficulty: 3 });
            const harder = await insertQuestion({ theta: 0.1, difficulty: 4 });
            await insertQuestion({ theta: 0.05, difficulty: 3 });
            const res = await request(freshApp())
                .post(`/api/questions/${source}/variants`).send({ count: 1, difficulty_delta: 1 });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.questions.map(q => q.id), [harder]);
        });

        test('排除藍本整個家族（COALESCE(variant_of, id)）', async () => {
            const source = await insertQuestion({ theta: 0 });
            await insertQuestion({ theta: 0.05, variantOf: source });   // 同家族的變式
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202, '同家族的題不得被推薦回來');
        });

        test('藍本本身是變式時，排的是整個家族（不是只排它自己）', async () => {
            const root = await insertQuestion({ theta: 0 });
            const sibling = await insertQuestion({ theta: 0.05, variantOf: root });
            const source = await insertQuestion({ theta: 0.06, variantOf: root });
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202, `根節點 ${root} 與手足 ${sibling} 都該被排掉`);
        });

        test('已封存與沒有向量的題不進候選', async () => {
            const source = await insertQuestion({ theta: 0 });
            await insertQuestion({ theta: 0.05, archived: true });
            await insertQuestion({ theta: 0.05, withVector: false });
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202);
        });

        test('跨學科的題不進候選', async () => {
            const source = await insertQuestion({ theta: 0 });
            await insertQuestion({ theta: 0.05, subject: '物理', chapter: '直線運動' });
            const res = await request(freshApp()).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(res.status, 202);
        });

        test('給了 student_id → 排除該生寫過的題', async () => {
            const source = await insertQuestion({ theta: 0 });
            const near = await insertQuestion({ theta: 0.05 });
            const { rows } = await query(`INSERT INTO students (name) VALUES ('測試學生') RETURNING id`);
            const studentId = rows[0].id;
            const { rows: paper } = await query(
                `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('測試卷', $1, $2::int[]) RETURNING id`,
                [studentId, [near]]);
            await query(
                `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at) VALUES ($1, $2, $3, CURRENT_DATE)`,
                [studentId, near, paper[0].id]);

            const app = freshApp();
            const withStudent = await request(app).post(`/api/questions/${source}/variants`).send({ count: 1, student_id: studentId });
            assert.equal(withStudent.status, 202, '該生寫過的題不該再推薦給他');

            const without = await request(app).post(`/api/questions/${source}/variants`).send({ count: 1 });
            assert.equal(without.status, 200, '不給 student_id 時同一題仍在池子裡');
            assert.equal(without.body.questions[0].id, near);
        });
    });

    describe('generating 分支與冪等（裁決 S3-8、S3-9）', () => {
        test('202 建了一個 kind=variant 的 job，並把請求參數寫進 job_events.detail.requested', async () => {
            const source = await insertQuestion({ theta: 0 });
            const res = await request(freshApp())
                .post(`/api/questions/${source}/variants`).send({ count: 2, difficulty_delta: -1 });

            assert.equal(res.status, 202);
            assert.deepEqual(Object.keys(res.body).sort(), ['existing', 'job_id', 'mode', 'state']);
            assert.equal(res.body.existing, false);
            assert.equal(res.body.state, 'queued');

            const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [res.body.job_id]);
            assert.equal(rows[0].kind, 'variant');
            assert.equal(rows[0].source_question_id, source);
            assert.equal(rows[0].pdf_sha256, null);
            assert.equal(rows[0].pdf_path, null);
            assert.equal(Number(rows[0].budget_usd), 0.3);

            // **不建 job_questions**（那是 generate 節點的事，第 3.2 條）
            const { rows: jq } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [res.body.job_id]);
            assert.equal(jq[0].n, 0);

            const requested = await variantService.readRequested({ query }, res.body.job_id);
            assert.deepEqual(requested, { count: 2, difficulty_delta: -1, student_id: null });
        });

        test('同一藍本重複請求 → 合流回既有 job_id，不建第二個 job', async () => {
            const source = await insertQuestion({ theta: 0 });
            const app = freshApp();
            const first = await request(app).post(`/api/questions/${source}/variants`).send({ force_generate: true });
            const second = await request(app).post(`/api/questions/${source}/variants`).send({ force_generate: true });

            assert.equal(second.body.job_id, first.body.job_id);
            assert.equal(second.body.existing, true);
            const { rows } = await query(`SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'variant'`);
            assert.equal(rows[0].n, 1);
        });

        test('job 收工（done／failed）之後同一藍本可以再開新的', async () => {
            const source = await insertQuestion({ theta: 0 });
            const app = freshApp();
            const first = await request(app).post(`/api/questions/${source}/variants`).send({ force_generate: true });
            await query(`UPDATE jobs SET state = 'done' WHERE id = $1`, [first.body.job_id]);
            const second = await request(app).post(`/api/questions/${source}/variants`).send({ force_generate: true });
            assert.notEqual(second.body.job_id, first.body.job_id);
            assert.equal(second.body.existing, false);
        });

        test('FEATURE_VARIANTS 關閉時整條路由不掛載（落到 Express 預設 404）', async () => {
            const original = process.env.FEATURE_VARIANTS;
            try {
                process.env.FEATURE_VARIANTS = 'false';
                const id = await insertQuestion();
                const res = await request(freshApp()).post(`/api/questions/${id}/variants`).send({});
                assert.equal(res.status, 404);
                assert.ok(!res.body || res.body.message !== '找不到該題目', '應該是路由不存在，不是端點回的 404');
            } finally {
                process.env.FEATURE_VARIANTS = original;
                freshApp();     // 把旗標打開的 routes 放回 require 快取，不影響後面的案例
            }
        });
    });

    // ─────────────────── ② 變式 job 走同一條狀態機 ───────────────────

    describe('generate 節點（第 4.1 條）', () => {
        /** 建一個 queued 的變式 job，回 {jobId, sourceId} */
        async function seedVariantJob({ count = 2, delta = 0, sourceExtra = {} } = {}) {
            const sourceId = await insertQuestion({ theta: 0, ...sourceExtra });
            if (sourceExtra.__fake) {
                await query(`UPDATE questions SET answer_text = answer_text WHERE id = $1`, [sourceId]);
            }
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count, difficultyDelta: delta, studentId: null }, 0.3);
            return { jobId: created.job_id, sourceId };
        }

        test('tick 的第二條認領分支真的認得 kind=variant（第 4.1 條）', async () => {
            const { jobId } = await seedVariantJob({ count: 1 });
            const runner = makeRunner({ concurrency: 1 });

            await runner.tick();                       // 認領 → spawn(runGenerateJob)
            // spawn 是 fire-and-forget，等它把 job 推到 processing 為止（最多 5 秒）
            for (let i = 0; i < 50 && runner.inFlight > 0; i++) {
                await new Promise(r => setTimeout(r, 100));
            }

            const { rows } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
            assert.equal(rows[0].state, 'processing', 'tick 沒認領到變式 job');
            const { rows: jq } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
            assert.equal(jq[0].n, 1);
        });

        test('runGenerateJob 建 count 列 job_questions → jobs.state=processing', async () => {
            const { jobId, sourceId } = await seedVariantJob({ count: 2 });
            const runner = makeRunner();
            await runner.runGenerateJob(jobId);

            const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
            assert.equal(job[0].state, 'processing');

            const { rows } = await query('SELECT idx, state, payload FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            assert.equal(rows.length, 2);
            // 裁決 S3-10：chunk_no = 0、idx = i（1-based）
            assert.deepEqual(rows.map(r => r.idx), [1, 2]);
            for (const r of rows) {
                assert.equal(r.state, 'extracted');
                assert.equal(r.payload.extract.chunk_no, 0);
                assert.equal(r.payload.extract.page_range, null);
                assert.equal(r.payload.extract.variant_of_root, sourceId);
            }
        });

        test('payload 的第七個鍵 variant 由 generate 節點寫（第 4.5 條）', async () => {
            const { jobId, sourceId } = await seedVariantJob({ count: 1, delta: -1 });
            await makeRunner().runGenerateJob(jobId);

            const { rows } = await query('SELECT payload FROM job_questions WHERE job_id = $1', [jobId]);
            assert.deepEqual(Object.keys(rows[0].payload).sort(), ['extract', 'variant']);
            assert.deepEqual(rows[0].payload.variant, {
                source_question_id: sourceId,
                difficulty_delta: -1,
                anchor_ids: [],
                text_gate: { ok: true, reason: null, edit_ratio: 0.5123 },
                sim: 0.8817,
                attempt: 1
            });
        });

        test('每次呼叫寫一列 job_events(node=generate)，jq_id 為 NULL', async () => {
            const { jobId } = await seedVariantJob({ count: 2 });
            await makeRunner().runGenerateJob(jobId);

            const { rows } = await query(
                `SELECT node, jq_id, outcome, attempt, detail FROM job_events
                  WHERE job_id = $1 AND node = 'generate' ORDER BY id`, [jobId]);
            assert.equal(rows.length, 3, '建 job 時那一列 + 兩次生成');
            assert.equal(rows[0].outcome, 'skipped');           // 建 job 時寫的 requested
            assert.equal(rows[1].outcome, 'pass');
            assert.equal(rows[1].jq_id, null);
            assert.equal(rows[1].detail.idx, 1);
            assert.equal(rows[1].detail.sim, 0.8817);
        });

        test('runner 把第 4.5 條的兩處新欄位組進 ctx（kind／pdf_sha256／三個門檻／MODEL_VARIANT）', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            await query(`UPDATE questions SET question_text = question_text WHERE id = $1`, [sourceId]);
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);

            // 用 __fake 指令讓假 agent 把 ctx 回報出來
            const { rows: src } = await query('SELECT question_text FROM questions WHERE id = $1', [sourceId]);
            assert.ok(src[0].question_text);
            const runner = makeRunner();
            const original = require(path.join(FAKE_AGENTS_DIR, 'generate.js'));
            const spy = [];
            const patched = {
                run: async (ctx, input) => {
                    spy.push({ job: ctx.job, thresholds: ctx.config.thresholds, models: ctx.config.models });
                    return original.run(ctx, input);
                }
            };
            require.cache[require.resolve(path.join(FAKE_AGENTS_DIR, 'generate.js'))].exports = patched;
            try {
                await runner.runGenerateJob(created.job_id);
            } finally {
                require.cache[require.resolve(path.join(FAKE_AGENTS_DIR, 'generate.js'))].exports = original;
            }

            assert.equal(spy.length, 1);
            assert.equal(spy[0].job.kind, 'variant');
            assert.equal(spy[0].job.pdf_sha256, null);
            assert.equal(spy[0].thresholds.variantOfftopicSimMin, 0.92, '跑題閾值走 OFFTOPIC（裁決 S3-R9）');
            assert.equal(spy[0].thresholds.variantRetrieveSimMin, undefined,
                '檢索下限是 services/variantService.js 的事，不進 ctx');
            assert.equal(spy[0].thresholds.variantMinEdit, 0.08);
            assert.equal(spy[0].thresholds.knnVoteSim, 0.90);
            assert.ok(spy[0].models.variant, 'MODEL_VARIANT 未設時要退回 MODEL_VERIFY');
        });

        test('一列都沒建出來 → jobs.state=failed，error 是第 4.1 條凍結的那句', async () => {
            const sourceId = await insertQuestion({
                theta: 0,
                text: '自製測試題（會被假 agent 判定不過閘門）：設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。'
            });
            // 藍本的 __fake 指令：讓假 generate 一直 fail
            await query(`UPDATE questions SET answer_text = $2 WHERE id = $1`, [sourceId, '$\\sqrt{5}$']);
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);

            const runner = makeRunner();
            const modPath = require.resolve(path.join(FAKE_AGENTS_DIR, 'generate.js'));
            const original = require.cache[modPath].exports;
            require.cache[modPath].exports = {
                run: async () => ({ kind: 'fail', reason: 'text_gate', feedback: '只改字閘門未通過（identical）' })
            };
            try {
                await runner.runGenerateJob(created.job_id);
            } finally {
                require.cache[modPath].exports = original;
            }

            const { rows } = await query('SELECT state, error FROM jobs WHERE id = $1', [created.job_id]);
            assert.equal(rows[0].state, 'failed');
            assert.equal(rows[0].error, '變式生成全部未通過文字閘門或跑題檢查。');

            // 沒過閘門的那幾題只留在事件裡（第 4.1 條）
            const { rows: ev } = await query(
                `SELECT detail, error_class FROM job_events WHERE job_id = $1 AND node = 'generate' AND outcome = 'fail' ORDER BY id`,
                [created.job_id]);
            assert.equal(ev.length, 2, 'fail 重試 1 次＝兩列事件');
            assert.equal(ev[0].detail.rejected[0].reason, 'text_gate');
            assert.equal(ev[0].error_class, null, 'text_gate 不在九個合法 error_class 內，必須寫 NULL');
        });
    });

    describe('六個節點與政策停等（第 4.6、4.7 條）', () => {
        /** 建 job → 跑 generate → 逐列推到終態 */
        async function runWholePipeline(runner, jobId) {
            await runner.runGenerateJob(jobId);
            for (let i = 0; i < 40; i++) {
                const { rows } = await query(
                    `SELECT id FROM job_questions
                      WHERE job_id = $1 AND state NOT IN ('saved','needs_review','rejected')
                      ORDER BY id LIMIT 1`, [jobId]);
                if (rows.length === 0) break;
                await runner.runJobQuestion(rows[0].id);
            }
        }

        test('VARIANT_AUTO_APPROVE=false → 停在 needs_review(awaiting_approval)，不入庫', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);
            const runner = makeRunner({ variantAutoApprove: false });
            await runWholePipeline(runner, created.job_id);

            const { rows } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE job_id = $1', [created.job_id]);
            assert.equal(rows[0].state, 'needs_review');
            assert.equal(rows[0].review_reason, 'awaiting_approval');
            assert.equal(rows[0].question_id, null, '停等就是不入庫');

            // 事件：node='save'、outcome='skipped'、error_class=NULL（裁決 S3-11）
            const { rows: ev } = await query(
                `SELECT outcome, error_class, detail FROM job_events WHERE job_id = $1 AND node = 'save'`, [created.job_id]);
            assert.equal(ev.length, 1);
            assert.equal(ev[0].outcome, 'skipped');
            assert.equal(ev[0].error_class, null);
            assert.deepEqual(ev[0].detail, { reason: 'awaiting_approval', auto_approve: false });

            // 全部列都在終態 → job 收成 done
            const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [created.job_id]);
            assert.equal(job[0].state, 'done');
        });

        test('VARIANT_AUTO_APPROVE=true → 照常 save，入庫欄位是 origin=variant／variant_of／chapter_src', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);
            const runner = makeRunner({ variantAutoApprove: true });
            await runWholePipeline(runner, created.job_id);

            const { rows } = await query('SELECT state, question_id FROM job_questions WHERE job_id = $1', [created.job_id]);
            assert.equal(rows[0].state, 'saved');
            assert.ok(rows[0].question_id);

            const { rows: q } = await query('SELECT origin, variant_of, chapter_src FROM questions WHERE id = $1', [rows[0].question_id]);
            assert.equal(q[0].origin, 'variant');
            assert.equal(q[0].variant_of, sourceId);
            assert.equal(q[0].chapter_src, 'ai', '假 classify 回 source=gate → ai');
        });

        test('dedup1 收到 exclude_family_root（PDF job 不會有這個鍵）', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);
            const runner = makeRunner({ variantAutoApprove: true });

            const modPath = require.resolve(path.join(FAKE_AGENTS_DIR, 'dedup.js'));
            const original = require.cache[modPath].exports;
            const seen = [];
            require.cache[modPath].exports = {
                run: (ctx, input) => { seen.push(input); return original.run(ctx, input); }
            };
            try {
                await runWholePipeline(runner, created.job_id);
            } finally {
                require.cache[modPath].exports = original;
            }

            const dedup1Input = seen.find(i => Object.prototype.hasOwnProperty.call(i, 'embed_text'));
            assert.equal(dedup1Input.exclude_family_root, sourceId);
            const dedup0Input = seen.find(i => !Object.prototype.hasOwnProperty.call(i, 'embed_text'));
            assert.ok(!('exclude_family_root' in dedup0Input), 'dedup0 的 input 形狀不變');
        });

        test('變式 job 的 lint 重試上限吃 VARIANT_LINT_RETRIES（其他節點不變）', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);
            const runner = makeRunner({ variantLintRetries: 0, variantAutoApprove: true });

            const modPath = require.resolve(path.join(FAKE_AGENTS_DIR, 'lint.js'));
            const original = require.cache[modPath].exports;
            require.cache[modPath].exports = {
                run: async () => ({ kind: 'fail', reason: 'formula_unparsable', feedback: '假 lint：不過' })
            };
            try {
                await runWholePipeline(runner, created.job_id);
            } finally {
                require.cache[modPath].exports = original;
            }

            const { rows } = await query('SELECT state, review_reason, retries FROM job_questions WHERE job_id = $1', [created.job_id]);
            assert.equal(rows[0].state, 'needs_review');
            assert.equal(rows[0].review_reason, 'formula_unparsable');
            assert.deepEqual(rows[0].retries, {}, 'maxRetries.lint=0 → 一次都不重試');
        });
    });

    // ─────────────────── ③ approve 的變式分支（第 4.7 條） ───────────────────

    describe('POST /api/review/:jqId/approve 對 kind=variant 的分支', () => {
        async function seedAwaitingApproval() {
            const sourceId = await insertQuestion({ theta: 0 });
            const created = await variantService.createVariantJob(
                { pool, query }, sourceId, { count: 1, difficultyDelta: 0, studentId: null }, 0.3);
            const runner = makeRunner({ variantAutoApprove: false });
            await runner.runGenerateJob(created.job_id);
            for (let i = 0; i < 40; i++) {
                const { rows } = await query(
                    `SELECT id FROM job_questions WHERE job_id = $1
                      AND state NOT IN ('saved','needs_review','rejected') ORDER BY id LIMIT 1`, [created.job_id]);
                if (rows.length === 0) break;
                await runner.runJobQuestion(rows[0].id);
            }
            const { rows } = await query('SELECT id, payload FROM job_questions WHERE job_id = $1', [created.job_id]);
            return { sourceId, jqId: rows[0].id, payload: rows[0].payload };
        }

        const APPROVE_BODY = {
            subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
            question_text: '核准後的變式題：甲船位移 $\\vec{p}=(6,8)$ 公里，求位移量大小。',
            answer_text: '$10$ 公里。'
        };

        test('章節沒被改過 → origin=variant、variant_of=根節點、chapter_src=ai（裁決 S3-12）', async () => {
            const { sourceId, jqId } = await seedAwaitingApproval();
            const res = await request(freshApp()).post(`/api/review/${jqId}/approve`).send(APPROVE_BODY);
            assert.equal(res.status, 200);

            const { rows } = await query('SELECT origin, variant_of, chapter_src FROM questions WHERE id = $1', [res.body.question_id]);
            assert.equal(rows[0].origin, 'variant');
            assert.equal(rows[0].variant_of, sourceId);
            assert.equal(rows[0].chapter_src, 'ai',
                '每題變式都會進複核，一律寫 human 等於量產沒人逐題驗過的人工標籤');
        });

        test('章節被改過 → chapter_src=human（真的有人看過並改了）', async () => {
            const { jqId } = await seedAwaitingApproval();
            const res = await request(freshApp())
                .post(`/api/review/${jqId}/approve`).send({ ...APPROVE_BODY, chapter: '空間向量內積' });
            assert.equal(res.status, 200);
            const { rows } = await query('SELECT chapter, chapter_src FROM questions WHERE id = $1', [res.body.question_id]);
            assert.equal(rows[0].chapter, '空間向量內積');
            assert.equal(rows[0].chapter_src, 'human');
        });

        test('kind=pdf 的 approve 行為完全不變（第 6.6 條是契約）', async () => {
            const { rows: job } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd) VALUES ('pdf', $1, 'processing', 0.5) RETURNING id`,
                [require('node:crypto').randomBytes(32).toString('hex')]);
            const { rows: jq } = await query(
                `INSERT INTO job_questions (job_id, idx, state, review_reason, payload)
                 VALUES ($1, 1001, 'needs_review', 'answer_mismatch', $2::jsonb) RETURNING id`,
                [job[0].id, JSON.stringify({
                    extract: { subject: SUBJECT, chapter: CHAPTER, question_text: 'x', answer_text: 'y' },
                    classify: { chapter: CHAPTER, source: 'gate' }
                })]);

            const res = await request(freshApp()).post(`/api/review/${jq[0].id}/approve`).send(APPROVE_BODY);
            assert.equal(res.status, 200);
            const { rows } = await query('SELECT origin, variant_of, chapter_src FROM questions WHERE id = $1', [res.body.question_id]);
            assert.equal(rows[0].origin, 'pdf');
            assert.equal(rows[0].variant_of, null);
            assert.equal(rows[0].chapter_src, 'human', 'PDF 路徑維持一律 human');
        });
    });

    // ─────────────────── ④ dedup1 的家族排除真的下得了 SQL ───────────────────

    describe('agents/dedup.js 的 exclude_family_root（真的下 SQL）', () => {
        function realDedupCtx() {
            return {
                db: { query: (text, values) => query(text, values) },
                llm: { embed: async () => ({ vectors: [unitVector(0)], usage: { tokenIn: 1 } }) },
                config: { thresholds: { dedupDup: 0.97, dedupVariant: 0.90 }, features: { similar: true } },
                logger: { info() { }, warn() { }, error() { } }
            };
        }

        test('沒給鍵 → 撞到藍本，判 duplicate（這就是為什麼變式需要這個鍵）', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const outcome = await dedup.runDedup1(realDedupCtx(), {
                question_id: null, embed_text: '一段題幹', subject: SUBJECT, chapter: CHAPTER
            });
            assert.equal(outcome.kind, 'fail');
            assert.equal(outcome.reason, 'duplicate');
            assert.equal(outcome.data.top[0].question_id, sourceId);
        });

        test('給了根節點 → 整個家族被排掉，判 unique', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            await insertQuestion({ theta: 0.01, variantOf: sourceId });
            const outcome = await dedup.runDedup1(realDedupCtx(), {
                question_id: null, embed_text: '一段題幹', subject: SUBJECT, chapter: CHAPTER,
                exclude_family_root: sourceId
            });
            assert.equal(outcome.kind, 'pass');
            assert.equal(outcome.data.verdict, 'unique');
            assert.deepEqual(outcome.data.top, []);
        });

        test('排掉家族之後，別人的題還是照原本的門檻判', async () => {
            const sourceId = await insertQuestion({ theta: 0 });
            const other = await insertQuestion({ theta: 0.01 });      // cos ≈ 0.99995，不同家族
            const outcome = await dedup.runDedup1(realDedupCtx(), {
                question_id: null, embed_text: '一段題幹', subject: SUBJECT, chapter: CHAPTER,
                exclude_family_root: sourceId
            });
            assert.equal(outcome.reason, 'duplicate');
            assert.equal(outcome.data.top[0].question_id, other);
        });
    });
}
