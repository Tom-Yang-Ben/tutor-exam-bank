// ─────────────────────────────────────────────────────────────
// remedialFill.pg.test.js — 補救卷「題庫不夠時自動補題」的整合測試（〔dec/r16-remedial〕；docs/remedial.md 第 11 節）
//
// 涵蓋：
//   migrations/0023                       jobs.target_student_id、questions.target_student_id／target_source_question_id；再套一次不動；
//                                         刪學生 SET NULL、合併學生搬註記
//   POST /api/students/:id/remedial-paper/fill-shortfall
//                                         藍本＝該生第一次作答的錯題（R10：重練才錯的不算）、最近的先；建變式 job 帶 target_student_id
//                                         與 requested.student_id；先檢索（庫裡有夠用的相似題就不生成）；同藍本合流；
//                                         整個請求最多生成 5 題；承上題／沒有向量跳過；400／404；FEATURE_VARIANTS 關閉 404
//   變式 job 跑完（假 agent，不連 LLM）  agent 的 input 不含學生資料；停在待複核時 GET /api/review 與明細多 remedial_for；
//                                         approve 與自動入庫（VARIANT_AUTO_APPROVE=true）都把來源抄到 questions；一般的變式 job 不抄
//
// LLM：runner 的 llm 是假的，agents 指到 test/fixtures/fakeVariantAgents/（同 variants.pg.test.js），不讀不寫 cassette。
// 三道防線同 variants.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('補救卷補題整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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
    process.env.VARIANT_RETRIEVE_SIM_MIN = '0.80';
    process.env.VARIANT_OFFTOPIC_SIM_MIN = '0.92';
    delete process.env.VARIANT_SIM_MIN;
    process.env.VARIANT_MAX_PER_REQUEST = '3';

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    function loadApp({ variants }) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const keys = ['FEATURE_REMEDIAL', 'FEATURE_VARIANTS'];
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
        process.env.FEATURE_REMEDIAL = 'true';
        process.env.FEATURE_VARIANTS = variants ? 'true' : 'false';
        try {
            return require(APP_PATH);
        } finally {
            for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        }
    }
    const appNoVariants = loadApp({ variants: false });
    const app = loadApp({ variants: true });
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const variantService = require(path.join(APP_DIR, 'services', 'variantService'));
    const MIGRATION = fs.readFileSync(path.join(APP_DIR, 'migrations', '0023_remedial_variant_provenance.sql'), 'utf8');
    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeVariantAgents');
    const DIM = 768;

    const fakeLlm = {
        async generateJson() { return { data: {}, latencyMs: 5, usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 0, tokenCached: 0 }, raw: {}, schemaFallback: false }; },
        async embed() { return { vectors: [unitVector(0)], usage: { tokenIn: 10 } }; }
    };
    function makeRunner(overrides = {}) {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir: FAKE_AGENTS_DIR,
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { nodeTimeoutMs: 2000, leaseMs: 60000, concurrency: 2, ...overrides }
        });
    }
    async function runWholePipeline(runner, jobId) {
        await runner.runGenerateJob(jobId);
        for (let i = 0; i < 40; i++) {
            const { rows } = await query(
                `SELECT id FROM job_questions WHERE job_id = $1 AND state NOT IN ('saved','needs_review','rejected') ORDER BY id LIMIT 1`, [jobId]);
            if (rows.length === 0) break;
            await runner.runJobQuestion(rows[0].id);
        }
    }

    function unitVector(theta) {
        const v = new Array(DIM).fill(0);
        v[0] = Math.cos(theta);
        v[1] = Math.sin(theta);
        return v;
    }
    let seq = 0;
    async function addQ({ theta = 0, difficulty = 3, chapter = '向量內積', withVector = true, follows = null } = {}) {
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin, chapter_src, embedding, follows_question_id, follows_src)
             VALUES ('數學', $1, '計算', $2, $3, '$\\sqrt{5}$', 'seed', 'human', $4::vector, $5, $6) RETURNING id`,
            [chapter, difficulty, `自製補題測試題 ${++seq}：設 $\\vec{a}=(1,${seq})$，求 $|\\vec{a}|$。`,
                withVector ? `[${unitVector(theta).join(',')}]` : null, follows, follows === null ? null : 'human']);
        return rows[0].id;
    }
    async function addStudent(name = `補題測試生${++seq}`) {
        const { rows } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id', [name]);
        return rows[0].id;
    }
    /** 錯題（第一次作答答錯），daysAgo 越小越新。 */
    async function wrong(studentId, questionId, daysAgo, errorTypes = []) {
        await insertAttempts(query, [{ student_id: studentId, question_id: questionId, days_ago: daysAgo, result: 0, graded_at: 'now', error_types: errorTypes }]);
    }
    const fill = (studentId, body, a = app) => request(a).post(`/api/students/${studentId}/remedial-paper/fill-shortfall`).send(body);
    const chapterUnit = (needed, over = {}) => ({ unit_type: 'chapter', chapter: '向量內積', needed, ...over });

    async function truncateAll() {
        await query('TRUNCATE job_events, job_questions, jobs, attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
    }

    describe('補救卷補題（〔dec/r16-remedial〕）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], { cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8' });
        });
        beforeEach(truncateAll);
        after(async () => { await truncateAll(); await pool.end(); });

        test('migration 0023：三個欄位與外鍵（ON DELETE SET NULL）；再套一次不動', async () => {
            const { rows } = await query(
                `SELECT table_name, column_name, is_nullable FROM information_schema.columns
                  WHERE table_schema = current_schema() AND column_name IN ('target_student_id', 'target_source_question_id')
                  ORDER BY table_name, column_name`);
            assert.deepEqual(rows.map(r => [r.table_name, r.column_name, r.is_nullable]),
                [['jobs', 'target_student_id', 'YES'], ['questions', 'target_source_question_id', 'YES'], ['questions', 'target_student_id', 'YES']]);
            await query(MIGRATION);
            await query(MIGRATION);
            const { rows: fk } = await query(
                `SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('jobs'::regclass, 'questions'::regclass)
                    AND pg_get_constraintdef(oid) ~ '^FOREIGN KEY \\((target_student_id|target_source_question_id)\\)' ORDER BY conname`);
            assert.equal(fk.length, 3, '再套一次不會多出外鍵');
            assert.ok(fk.every(r => r.confdeltype === 'n'), 'ON DELETE SET NULL');
        });

        test('400／404；FEATURE_VARIANTS 關閉時路由不掛載', async () => {
            const s = await addStudent();
            assert.equal((await fill(s, { subject: '數學', units: [chapterUnit(2)] }, appNoVariants)).status, 404);
            assert.equal((await fill(999, { subject: '數學', units: [chapterUnit(2)] })).status, 404);
            assert.equal((await fill('abc', { subject: '數學', units: [chapterUnit(2)] })).status, 404);
            const bad = await fill(s, { subject: '數學', units: [chapterUnit(2, { chapter: '不存在的章' })] });
            assert.equal(bad.status, 400);
            assert.match(bad.body.message, /章節白名單/);
        });

        test('藍本：第一次作答的錯題、最近的先、主因錯因優先；R10（重練才錯的不算）；建 job 帶 target_student_id 與 requested.student_id', async () => {
            const s = await addStudent();
            const old = await addQ({ theta: 0.0 });
            const recent = await addQ({ theta: 0.6 });
            const tagged = await addQ({ theta: 1.2 });
            const retrainOnly = await addQ({ theta: 1.8 });
            await wrong(s, old, 20);
            await wrong(s, recent, 2);
            await wrong(s, tagged, 10, ['concept']);
            // 第一次答對、重練才錯：不是藍本（R10）
            await insertAttempts(query, [{ student_id: s, question_id: retrainOnly, days_ago: 30, result: 1, graded_at: 'now' }]);
            await insertAttempts(query, [{ student_id: s, question_id: retrainOnly, purpose: 'retrain', days_ago: 1, result: 0, graded_at: 'now', error_types: ['concept'] }]);

            const res = await fill(s, { subject: '數學', units: [chapterUnit(3, { error_type: 'concept' })] });
            assert.equal(res.status, 202, JSON.stringify(res.body));
            assert.deepEqual(res.body.units[0].items.map(i => [i.source_question_id, i.mode, i.count]),
                [[tagged, 'generating', 1], [recent, 'generating', 1], [old, 'generating', 1]]);
            assert.equal(res.body.units[0].sources_found, 3);
            const { rows: jobs } = await query(
                `SELECT j.id, j.kind, j.state, j.source_question_id, j.target_student_id, e.detail->'requested' AS requested
                   FROM jobs j JOIN job_events e ON e.job_id = j.id AND e.node = 'generate' ORDER BY j.id`);
            assert.deepEqual(jobs.map(j => [j.kind, j.state, j.source_question_id, j.target_student_id]),
                [['variant', 'queued', tagged, s], ['variant', 'queued', recent, s], ['variant', 'queued', old, s]]);
            assert.deepEqual(jobs[0].requested, { count: 1, difficulty_delta: 0, student_id: s });
            assert.deepEqual(res.body.jobs.map(j => j.job_id), jobs.map(j => j.id));
        });

        test('先檢索：庫裡已經有他沒寫過的相似題就不生成，回報題號；不夠才生成差額', async () => {
            const s = await addStudent();
            const src = await addQ({ theta: 0 });
            await wrong(s, src, 3);
            const similar = await addQ({ theta: 0.1, chapter: '向量內積' });    // cos 0.995：檢索得到
            const seen = await addQ({ theta: 0.05 });                        // 他寫過：檢索排除
            await insertAttempts(query, [{ student_id: s, question_id: seen, days_ago: 1, result: 1, graded_at: 'now' }]);
            const one = await fill(s, { subject: '數學', units: [chapterUnit(1)] });
            assert.equal(one.status, 200, '沒有建任何 job');
            assert.deepEqual(one.body.units[0].items.map(i => [i.mode, i.retrieved.map(r => r.id)]), [['retrieved', [similar]]]);
            assert.deepEqual(one.body.retrieved_ids, [similar]);
            assert.equal((await query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n, 0);

            const two = await fill(s, { subject: '數學', units: [chapterUnit(3)] });
            assert.equal(two.status, 202);
            assert.deepEqual(two.body.units[0].items.map(i => [i.mode, i.count]), [['generating', 2]], '要 3 題、庫裡有 1 題 → 生成 2 題');
        });

        test('同藍本已經在跑就合流；整個請求最多生成 5 題；承上題與沒有向量的錯題跳過', async () => {
            const s = await addStudent();
            const ids = [];
            for (let i = 0; i < 4; i++) { ids.push(await addQ({ theta: 0.5 * i })); await wrong(s, ids[i], 10 - i); }
            const followUp = await addQ({ theta: 2.5, follows: ids[0] });
            await wrong(s, followUp, 1);
            const noVec = await addQ({ withVector: false });
            await wrong(s, noVec, 0);
            const active = await variantService.createVariantJob({ pool, query }, ids[3], { count: 1, difficultyDelta: 0, studentId: null }, 0.3);

            const res = await fill(s, { subject: '數學', units: [chapterUnit(12)] });
            assert.equal(res.status, 202, JSON.stringify(res.body));
            const items = res.body.units[0].items;
            assert.deepEqual(items.filter(i => i.mode === 'skipped').map(i => [i.source_question_id, i.reason]),
                [[noVec, 'no_vector'], [followUp, 'follow_up']]);
            const merged = items.find(i => i.existing);
            assert.deepEqual([merged.source_question_id, merged.job_id], [ids[3], active.job_id]);
            assert.ok(res.body.generating <= 5);
            assert.equal(res.body.capped, true);
            const { rows } = await query(`SELECT COALESCE(SUM((e.detail->'requested'->>'count')::int), 0)::int AS n
                                            FROM jobs j JOIN job_events e ON e.job_id = j.id AND e.node = 'generate'
                                           WHERE j.target_student_id = $1`, [s]);
            assert.equal(rows[0].n, res.body.generating);
            assert.ok(res.body.notes.some(n => n.includes('一次最多生成 5 題')));
        });

        test('跑完生成（假 agent）：agent 的 input 不含學生資料；待複核帶 remedial_for；approve 把來源抄到題目', async () => {
            const s = await addStudent('王小明');
            const src = await addQ({ theta: 0 });
            await wrong(s, src, 2, ['calc']);
            const res = await fill(s, { subject: '數學', units: [chapterUnit(1)] });
            const jobId = res.body.jobs[0].job_id;

            const modPath = require.resolve(path.join(FAKE_AGENTS_DIR, 'generate.js'));
            const original = require(modPath);
            const inputs = [];
            require.cache[modPath].exports = { ...original, run: (ctx, input) => { inputs.push({ ctxJob: ctx.job, input }); return original.run(ctx, input); } };
            try {
                await runWholePipeline(makeRunner({ variantAutoApprove: false }), jobId);
            } finally {
                require.cache[modPath].exports = original;
            }
            assert.equal(inputs.length, 1);
            const sent = JSON.stringify(inputs[0].input);
            assert.ok(!sent.includes('王小明') && !/student/i.test(sent), 'agent 的 input（會進 prompt）沒有任何學生資料');
            assert.ok(!('target_student_id' in inputs[0].ctxJob), 'ctx.job 的形狀不變');

            const list = await request(app).get('/api/review');
            const item = list.body.items.find(i => i.job_id === jobId);
            assert.deepEqual(item.remedial_for, { student_id: s, student_name: '王小明', source_question_id: src });
            const detail = await request(app).get(`/api/review/${item.jq_id}`);
            assert.deepEqual(detail.body.remedial_for, item.remedial_for);

            const ex = detail.body.payload.extract;
            const ok = await request(app).post(`/api/review/${item.jq_id}/approve`).send({
                subject: ex.subject, chapter: ex.chapter, question_type: ex.question_type, difficulty: ex.difficulty,
                question_text: ex.question_text, answer_text: ex.answer_text
            });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            const { rows: [q] } = await query('SELECT origin, variant_of, target_student_id, target_source_question_id FROM questions WHERE id = $1', [ok.body.question_id]);
            assert.deepEqual(q, { origin: 'variant', variant_of: src, target_student_id: s, target_source_question_id: src });
        });

        test('自動入庫（VARIANT_AUTO_APPROVE=true）也抄來源；一般的變式 job 不抄、複核列沒有 remedial_for', async () => {
            const s = await addStudent();
            const src = await addQ({ theta: 0 });
            await wrong(s, src, 2);
            const res = await fill(s, { subject: '數學', units: [chapterUnit(1)] });
            await runWholePipeline(makeRunner({ variantAutoApprove: true }), res.body.jobs[0].job_id);
            const { rows: [saved] } = await query(
                `SELECT q.target_student_id, q.target_source_question_id FROM job_questions jq JOIN questions q ON q.id = jq.question_id WHERE jq.job_id = $1`,
                [res.body.jobs[0].job_id]);
            assert.deepEqual(saved, { target_student_id: s, target_source_question_id: src });

            const plainSrc = await addQ({ theta: 2.0 });
            const plain = await variantService.createVariantJob({ pool, query }, plainSrc, { count: 1, difficultyDelta: 0, studentId: s }, 0.3);
            await runWholePipeline(makeRunner({ variantAutoApprove: false }), plain.job_id);
            const list = await request(app).get('/api/review');
            const item = list.body.items.find(i => i.job_id === plain.job_id);
            assert.ok(item && !('remedial_for' in item), '一般的變式（即使有 student_id）不是補題');
        });

        test('刪學生：來源註記變 NULL；合併學生：來源註記搬到目標學生', async () => {
            const a = await addStudent();
            const b = await addStudent();
            const src = await addQ({ theta: 0 });
            await wrong(a, src, 2);
            const res = await fill(a, { subject: '數學', units: [chapterUnit(1)] });
            const jobId = res.body.jobs[0].job_id;
            const q = await addQ({ theta: 1 });
            await query('UPDATE questions SET target_student_id = $2, target_source_question_id = $3 WHERE id = $1', [q, a, src]);

            const merged = await request(app).post(`/api/students/${a}/merge`).send({ into_id: b });
            assert.equal(merged.status, 200, JSON.stringify(merged.body));
            assert.equal((await query('SELECT target_student_id FROM jobs WHERE id = $1', [jobId])).rows[0].target_student_id, b);
            assert.equal((await query('SELECT target_student_id FROM questions WHERE id = $1', [q])).rows[0].target_student_id, b);

            const del = await request(app).delete(`/api/students/${b}`);
            assert.equal(del.status, 200, JSON.stringify(del.body));
            assert.equal((await query('SELECT target_student_id FROM jobs WHERE id = $1', [jobId])).rows[0].target_student_id, null);
            assert.equal((await query('SELECT target_student_id FROM questions WHERE id = $1', [q])).rows[0].target_student_id, null);
        });
    });
}
