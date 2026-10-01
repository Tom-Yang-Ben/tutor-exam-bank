// ─────────────────────────────────────────────────────────────
// followUp.pg.test.js — 承上題綁定的整合測試（DEC-012／FR-019）
//
// 防線與 jobs.pg.test.js 一致：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// require config/db 之前覆寫 DATABASE_URL；agents 指到 test/fixtures/fakeAgents（不連 Gemini）。
// 題幹全為自製內容（repo 公開，NOTICE 規定不得放真實考卷文字）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('承上題綁定整合測試（需要 PostgreSQL）', {
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
    process.env.JOB_COST_BUDGET_USD = '0.5';

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    // 〔retrain PR-1〕attempts 是唯讀檢視（migrations/0016），夾具改用 helper 寫派題＋作答
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const { linkJob } = require(path.join(APP_DIR, 'services', 'followUpLinker'));
    const { backfill } = require(path.join(APP_DIR, 'scripts', 'backfill_follow_ups'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));
    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';

    const fakeLlm = {
        async generateJson() {
            return { data: {}, latencyMs: 1, usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 }, raw: {} };
        },
        async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
    };

    const linker = require(path.join(APP_DIR, 'services', 'followUpLinker'));
    const fakeExtract = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', 'extract.js'));
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');

    function makeRunner(logger = { info() { }, warn() { }, error() { } }) {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir: FAKE_AGENTS_DIR,
            logger,
            sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { nodeTimeoutMs: 2000, leaseMs: 60000, concurrency: 2 }
        });
    }

    /** 一般題（前題） */
    function plainQ(i, fake) {
        return {
            idx: 1000 + i, subject: SUBJECT, chapter: CHAPTER, chapter_confidence: 0.95,
            question_type: '計算', difficulty: 3,
            question_text: `自製承上測試前題 ${i}：設 $x=${i}$，求 $2x$。`,
            answer_text: `$${2 * i}$`, chunk_no: 1, page_range: [1, 20],
            ...(fake ? { __fake: fake } : {})
        };
    }

    /** 承上題（子題） */
    function followQ(i, fake) {
        return {
            ...plainQ(i, fake),
            question_text: `承上題，自製承上測試子題 ${i}：再求 $3x$。`,
            answer_text: `$${3 * i}$`
        };
    }

    async function seedJob(questions) {
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
             VALUES ('pdf', $1, 'processing', 0.5, 20) RETURNING id`,
            [require('node:crypto').randomBytes(32).toString('hex')]);
        const jobId = Number(rows[0].id);
        const jqIds = [];
        for (const q of questions) {
            const { rows: r } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, $2, 'extracted', $3::jsonb) RETURNING id`,
                [jobId, q.idx, JSON.stringify({ extract: q })]);
            jqIds.push(Number(r[0].id));
        }
        return { jobId, jqIds };
    }

    async function insertQuestion(text, { subject = SUBJECT, origin = 'pdf' } = {}) {
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin)
             VALUES ($1, $2, '計算', 3, $3, '略', $4) RETURNING id`, [subject, CHAPTER, text, origin]);
        return rows[0].id;
    }

    async function jqRow(jqId) {
        const { rows } = await query('SELECT id, state, review_reason, question_id FROM job_questions WHERE id = $1', [jqId]);
        return rows[0];
    }

    async function follows(questionId) {
        const { rows } = await query('SELECT follows_question_id, follows_src FROM questions WHERE id = $1', [questionId]);
        return rows[0];
    }

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

    /** 同 jobs.pg.test.js：入庫後的 fire-and-forget 補向量可能與 TRUNCATE 搶鎖，死結就重試 */
    async function truncateAll(attempts = 10) {
        await waitForIdleBackends();
        for (let i = 1; ; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= attempts) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
                await waitForIdleBackends();
            }
        }
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

    /**
     * 逐輪推進（〔整合〕把「兩題並行」的先後改成確定的）：每一輪把目前可推進的列**各推一格**、
     * 同一輪內並行（Promise.all），等這一輪的工作單位全部結束才進下一輪。
     *
     * 為什麼不用 drain()：tick() 的認領迴圈在某個單位提早結束時會把空槽補滿，同一輪裡同一列
     * 可能連推兩格；而 id 小的前題總是先被認領，DB 來回一慢（CPU 忙），前題就可能追過子題。
     * 「子題先入庫」這個前提因此取決於時序。這裡等的是「這一輪都跑完」這個條件，不靠時間：
     * 子題 7 格、前題 7 格＋verify 退避 3 次，子題一定在第 7 輪入庫、前題在第 10 輪。
     * 走的仍是 runner 的 runJobQuestion（寫回、終態重算綁定都是正式程式碼），只是不經認領。
     */
    async function drainLockstep(runner, maxRounds = 80) {
        for (let i = 0; i < maxRounds; i++) {
            const { rows } = await query(
                `SELECT id FROM job_questions
                  WHERE state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped')
                  ORDER BY id`);
            if (rows.length === 0) return i;
            await Promise.all(rows.map(r => runner.runJobQuestion(Number(r.id))));
        }
        throw new Error('drainLockstep：超過上限仍有未推進的列');
    }

    const GOOD_BODY = {
        subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
        question_text: '老師修正後的自製前題：設 $y=5$，求 $2y$。', answer_text: '$10$'
    };

    /** classify 一直判不通過 → 重試用完進 needs_review('chapter_invalid') */
    const STUCK = { classify: { kind: 'fail', reason: 'chapter_invalid' } };
    const dbHit = (questionId) => ({ dedup0: { kind: 'fail', reason: 'duplicate', data: { text_hash: 'f'.repeat(64), normalized_len: 10, hit: { scope: 'db', question_id: questionId } } } });

    describe('承上題綁定（PostgreSQL）', () => {
        beforeEach(async () => {
            await truncateAll();
            fakeCommon.resetCounts();
        });
        after(async () => { await pool.end(); });

        describe('runner 終態後重算', () => {
            test('前題正常入庫 → 子題綁到前題，follows_src=pipeline', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                await drain(makeRunner());

                const pred = await jqRow(jqIds[0]);
                const child = await jqRow(jqIds[1]);
                assert.equal(pred.state, 'saved');
                assert.equal(child.state, 'saved');
                assert.deepEqual(await follows(child.question_id), { follows_question_id: pred.question_id, follows_src: 'pipeline' });
                assert.deepEqual(await follows(pred.question_id), { follows_question_id: null, follows_src: null }, '前題本身不是承上題');

                const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
                assert.equal(job[0].state, 'done', '掛點不影響 job 收尾');
            });

            test('兩題並行、子題先入庫 → 前題到終態後仍補綁', async () => {
                const { jqIds } = await seedJob([
                    plainQ(1, { verify: { kind: 'error', errorClass: 'rate_limited', times: 3 } }),
                    followQ(2)
                ]);
                assert.equal(await drainLockstep(makeRunner()), 10, '前題 7 格＋退避 3 次');

                const { rows: saves } = await query(
                    `SELECT jq_id FROM job_events WHERE node = 'save' AND jq_id = ANY($1::bigint[]) ORDER BY id`, [jqIds]);
                assert.deepEqual(saves.map(r => Number(r.jq_id)), [jqIds[1], jqIds[0]], '前提：子題先入庫');

                const pred = await jqRow(jqIds[0]);
                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: pred.question_id, follows_src: 'pipeline' });
            });

            test('前題 dedup0 撞庫內題 → 子題綁既有題', async () => {
                const existing = await insertQuestion('自製既有題甲：設 $x=1$，求 $2x$。');
                const { jqIds } = await seedJob([plainQ(1, dbHit(existing)), followQ(2)]);
                await drain(makeRunner());

                assert.equal((await jqRow(jqIds[0])).review_reason, 'duplicate');
                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: existing, follows_src: 'pipeline' });
            });

            test('前題 dedup0 撞同 job 較早的題 → 解析到那一題的 question_id', async () => {
                const { jqIds } = await seedJob([plainQ(1), plainQ(2), followQ(3)]);
                await query(
                    `UPDATE job_questions SET payload = jsonb_set(payload, '{extract,__fake}', $2::jsonb) WHERE id = $1`,
                    [jqIds[1], JSON.stringify({ dedup0: { kind: 'fail', reason: 'duplicate', data: { text_hash: 'e'.repeat(64), normalized_len: 10, hit: { scope: 'job', jq_id: jqIds[0] } } } })]);
                await drain(makeRunner());

                const first = await jqRow(jqIds[0]);
                assert.equal((await jqRow(jqIds[1])).state, 'needs_review');
                const child = await jqRow(jqIds[2]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: first.question_id, follows_src: 'pipeline' });
            });

            test('前題 dedup1 判重複 → 子題綁 top[0]', async () => {
                const existing = await insertQuestion('自製既有題乙：設 $x=1$，求 $2x$。');
                const other = await insertQuestion('自製既有題丙：設 $x=2$，求 $2x$。');
                const { jqIds } = await seedJob([
                    plainQ(1, { dedup1: { kind: 'fail', reason: 'duplicate', data: { verdict: 'duplicate', threshold_used: 0.97, top: [{ question_id: existing, cosine: 0.99 }, { question_id: other, cosine: 0.93 }] } } }),
                    followQ(2)
                ]);
                await drain(makeRunner());

                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: existing, follows_src: 'pipeline' });
            });

            test('兩題學科不同 → 不綁，回報 subject_mismatch', async () => {
                const physics = await insertQuestion('自製物理既有題：一物體由靜止釋放。', { subject: '物理' });
                const { jobId, jqIds } = await seedJob([plainQ(1, dbHit(physics)), followQ(2)]);
                await drain(makeRunner());

                const child = await jqRow(jqIds[1]);
                assert.equal((await follows(child.question_id)).follows_question_id, null);
                const r = await linkJob({ query }, jobId, { src: 'pipeline' });
                assert.deepEqual(r, { bound: [], unresolved: [{ jq_id: jqIds[1], reason: 'subject_mismatch' }] });
            });

            test('變式 job → linkJob 直接 no-op', async () => {
                const source = await insertQuestion('自製藍本題：設 $x=1$，求 $2x$。');
                const { rows } = await query(
                    `INSERT INTO jobs (kind, source_question_id, state, budget_usd) VALUES ('variant', $1, 'processing', 0.5) RETURNING id`, [source]);
                assert.deepEqual(await linkJob({ query }, Number(rows[0].id), { src: 'pipeline' }), { bound: [], unresolved: [] });
            });
        });

        describe('人工複核後重算', () => {
            test('前題 needs_review → 子題先不綁（GET 顯示 pending）；approve 前題後補綁 src=review', async () => {
                const { jqIds } = await seedJob([plainQ(1, STUCK), followQ(2)]);
                await drain(makeRunner());

                assert.equal((await jqRow(jqIds[0])).state, 'needs_review');
                const child = await jqRow(jqIds[1]);
                assert.equal(child.state, 'saved');
                assert.equal((await follows(child.question_id)).follows_question_id, null);

                const detail = await request(app).get(`/api/review/${jqIds[1]}`);
                assert.equal(detail.status, 200);
                assert.equal(detail.body.follow_up.is_follow_up, true);
                assert.equal(detail.body.follow_up.predecessor.jq_id, jqIds[0]);
                assert.equal(detail.body.follow_up.predecessor.state, 'needs_review');
                assert.equal(detail.body.follow_up.predecessor.question_id, null);
                assert.match(detail.body.follow_up.predecessor.stem_preview, /自製承上測試前題 1/);
                assert.equal(detail.body.follow_up.unresolved_reason, 'predecessor_pending');

                const predDetail = await request(app).get(`/api/review/${jqIds[0]}`);
                assert.deepEqual(predDetail.body.follow_up, { is_follow_up: false, predecessor: null, unresolved_reason: null });

                const res = await request(app).post(`/api/review/${jqIds[0]}/approve`).send(GOOD_BODY);
                assert.equal(res.status, 200);
                assert.equal(res.body.follows_question_id, null, '前題本身不是承上題');
                assert.deepEqual(await follows(child.question_id), { follows_question_id: res.body.question_id, follows_src: 'review' });
            });

            test('前題 duplicate 暫綁既有題 → approve 成新題 → 子題改綁新題', async () => {
                const existing = await insertQuestion('自製既有題丁：設 $x=1$，求 $2x$。');
                const { jqIds } = await seedJob([plainQ(1, dbHit(existing)), followQ(2)]);
                await drain(makeRunner());

                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: existing, follows_src: 'pipeline' });

                const res = await request(app).post(`/api/review/${jqIds[0]}/approve`).send(GOOD_BODY);
                assert.equal(res.status, 200);
                assert.notEqual(res.body.question_id, existing);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: res.body.question_id, follows_src: 'review' });
            });

            test('approve 承上題本身 → 回應帶 follows_question_id', async () => {
                const { jqIds } = await seedJob([plainQ(1), followQ(2, STUCK)]);
                await drain(makeRunner());
                const pred = await jqRow(jqIds[0]);

                const res = await request(app).post(`/api/review/${jqIds[1]}/approve`)
                    .send({ ...GOOD_BODY, question_text: '承上題，老師修正後的自製子題：再求 $3y$。', answer_text: '$15$' });
                assert.equal(res.status, 200);
                assert.equal(res.body.follows_question_id, pred.question_id);
                assert.deepEqual(await follows(res.body.question_id), { follows_question_id: pred.question_id, follows_src: 'review' });
            });

            test('前題 merge_into 既有題 → 子題綁 merge 目標', async () => {
                const target = await insertQuestion('自製既有題戊：設 $x=1$，求 $2x$。');
                const { jqIds } = await seedJob([plainQ(1, STUCK), followQ(2)]);
                await drain(makeRunner());

                const res = await request(app).post(`/api/review/${jqIds[0]}/approve`).send({ ...GOOD_BODY, merge_into: target });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { question_id: target, merged: true, follows_question_id: null });
                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: target, follows_src: 'review' });
            });

            test('reject 非重複的前題 → 子題不綁，回報 predecessor_rejected', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1, STUCK), followQ(2)]);
                await drain(makeRunner());

                const res = await request(app).post(`/api/review/${jqIds[0]}/reject`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { message: '已標記為不採用。', jq_id: jqIds[0] });

                const child = await jqRow(jqIds[1]);
                assert.deepEqual(await follows(child.question_id), { follows_question_id: null, follows_src: null });
                const r = await linkJob({ query }, jobId, { src: 'pipeline' });
                assert.deepEqual(r.unresolved, [{ jq_id: jqIds[1], reason: 'predecessor_rejected' }]);
            });
        });

        describe('保護與補強', () => {
            test('follows_src=human 不被自動流程覆寫', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                await drain(makeRunner());
                const manual = await insertQuestion('自製人工指定前題：設 $z=1$，求 $2z$。');
                const child = await jqRow(jqIds[1]);
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [manual, child.question_id]);

                for (const src of ['pipeline', 'review', 'backfill']) {
                    const r = await linkJob({ query }, jobId, { src });
                    assert.deepEqual(r.bound, [], src);
                }
                assert.deepEqual(await follows(child.question_id), { follows_question_id: manual, follows_src: 'human' });
            });

            test('會成環的綁定被擋，回報 cycle', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                await drain(makeRunner());
                const pred = await jqRow(jqIds[0]);
                const child = await jqRow(jqIds[1]);

                await query('UPDATE questions SET follows_question_id = NULL, follows_src = NULL WHERE id = $1', [child.question_id]);
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [child.question_id, pred.question_id]);

                const r = await linkJob({ query }, jobId, { src: 'pipeline' });
                assert.deepEqual(r, { bound: [], unresolved: [{ jq_id: jqIds[1], reason: 'cycle' }] });
                assert.equal((await follows(child.question_id)).follows_question_id, null);
            });

            test('重跑冪等：第二次 bound 為空、資料不變', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                await drain(makeRunner());
                const child = await jqRow(jqIds[1]);
                const before = await follows(child.question_id);

                assert.deepEqual(await linkJob({ query }, jobId, { src: 'backfill' }), { bound: [], unresolved: [] });
                assert.deepEqual(await follows(child.question_id), before, '已是期望值就不改寫 follows_src');
            });

            test('補強規則：子題被判重複未入庫 → 對命中的既有承上題補綁（只補空）', async () => {
                const legacyPred = await insertQuestion('自製舊題前題：設 $x=4$，求 $2x$。', { origin: 'legacy' });
                const legacyChild = await insertQuestion('承上題，自製舊題子題：再求 $3x$。', { origin: 'legacy' });
                const { jqIds } = await seedJob([plainQ(1, dbHit(legacyPred)), followQ(2, dbHit(legacyChild))]);
                await drain(makeRunner());

                assert.equal((await jqRow(jqIds[0])).review_reason, 'duplicate');
                assert.equal((await jqRow(jqIds[1])).review_reason, 'duplicate');
                assert.deepEqual(await follows(legacyChild), { follows_question_id: legacyPred, follows_src: 'pipeline' });
            });

            test('補強規則不覆寫既有綁定（即使不是 human）', async () => {
                const legacyPred = await insertQuestion('自製舊題前題二：設 $x=6$，求 $2x$。', { origin: 'legacy' });
                const legacyChild = await insertQuestion('承上題，自製舊題子題二：再求 $3x$。', { origin: 'legacy' });
                const elsewhere = await insertQuestion('自製另一前題：設 $x=7$，求 $2x$。', { origin: 'legacy' });
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'backfill' WHERE id = $2`, [elsewhere, legacyChild]);

                await seedJob([plainQ(1, dbHit(legacyPred)), followQ(2, dbHit(legacyChild))]);
                await drain(makeRunner());
                assert.deepEqual(await follows(legacyChild), { follows_question_id: elsewhere, follows_src: 'backfill' });
            });
        });

        describe('跨塊前題被 extract 丟掉（M1）', () => {
            /** seedJob 後補上 chunk_elements（模擬 runner 寫入的形狀） */
            async function setChunkElements(jobId, chunkNo, n) {
                await query(
                    `UPDATE job_questions SET payload = jsonb_set(payload, '{extract,chunk_elements}', to_jsonb($3::int))
                      WHERE job_id = $1 AND idx / 1000 = $2`, [jobId, chunkNo, n]);
            }

            test('上一塊塊尾被丟 → 子題不綁、回報 extract_gap；複核 API 也顯示 extract_gap', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), plainQ(2), { ...followQ(1001), idx: 2001, chunk_no: 2 }]);
                await setChunkElements(jobId, 1, 3);          // 第 1 塊模型回了 3 題，1003 被丟
                await setChunkElements(jobId, 2, 1);
                await drain(makeRunner());

                const child = await jqRow(jqIds[2]);
                assert.equal(child.state, 'saved');
                assert.deepEqual(await follows(child.question_id), { follows_question_id: null, follows_src: null },
                    '不得綁到上一塊倒數第二題 1002');
                assert.deepEqual(await linkJob({ query }, jobId, { src: 'pipeline' }),
                    { bound: [], unresolved: [{ jq_id: jqIds[2], reason: 'extract_gap' }] });

                const detail = await request(app).get(`/api/review/${jqIds[2]}`);
                assert.equal(detail.body.follow_up.unresolved_reason, 'extract_gap');
                assert.equal(detail.body.follow_up.predecessor, null);
            });

            test('舊資料沒有 chunk_elements：上一塊 extract 事件 rejected > 0 → extract_gap；= 0 → 照常綁', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), plainQ(2), { ...followQ(1001), idx: 2001, chunk_no: 2 }]);
                const { rows: ev } = await query(
                    `INSERT INTO job_events (job_id, node, attempt, latency_ms, outcome, detail)
                     VALUES ($1, 'extract', 1, 1, 'pass', '{"chunk":1,"created":2,"rejected":1}'::jsonb) RETURNING id`, [jobId]);
                await drain(makeRunner());

                const child = await jqRow(jqIds[2]);
                assert.equal((await follows(child.question_id)).follows_question_id, null);
                assert.deepEqual((await linkJob({ query }, jobId, { src: 'pipeline' })).unresolved,
                    [{ jq_id: jqIds[2], reason: 'extract_gap' }]);

                await query(`UPDATE job_events SET detail = '{"chunk":1,"created":2,"rejected":0}'::jsonb WHERE id = $1`, [ev[0].id]);
                const r = await linkJob({ query }, jobId, { src: 'pipeline' });
                const pred = await jqRow(jqIds[1]);
                assert.deepEqual(r, { bound: [{ question_id: child.question_id, follows_question_id: pred.question_id }], unresolved: [] });
            });

            test('runner 拆題時替每題寫 chunk_elements（含被丟的元素）', async () => {
                fs.mkdirSync(JOBS_DIR, { recursive: true });
                fakeExtract.resetCounts();
                const sha = require('node:crypto').randomBytes(32).toString('hex');
                const { rows } = await query(
                    `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
                     VALUES ('pdf', $1, 'queued', 0.5, 40) RETURNING id`, [sha]);
                const jobId = Number(rows[0].id);
                const plan = {
                    chunks: { 1: [plainQ(1), plainQ(2)], 2: [{ ...followQ(1001), idx: 2001, chunk_no: 2 }] },
                    rejected: [{ chunk: 1, idx: 1003, errors: ['假：schema 驗證失敗'] }]
                };
                fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), JSON.stringify(plan), 'utf8');
                await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, path.posix.join('data', 'jobs', `${jobId}.pdf`)]);

                await drain(makeRunner());

                const { rows: jq } = await query(
                    `SELECT idx, (payload->'extract'->>'chunk_elements')::int AS n, question_id FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
                assert.deepEqual(jq.map(r => [r.idx, r.n]), [[1001, 3], [1002, 3], [2001, 1]]);
                assert.equal((await follows(jq[2].question_id)).follows_question_id, null, '塊尾被丟 → 子題不綁');
            });
        });

        describe('刪除前題（M2）', () => {
            test('刪被承上的題 → 409 帶 children；先刪承上題再刪前題 → 成功', async () => {
                const pred = await insertQuestion('自製刪除測試前題：設 $x=9$，求 $2x$。', { origin: 'legacy' });
                const child = await insertQuestion('承上題，自製刪除測試子題：再求 $3x$。', { origin: 'legacy' });
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [pred, child]);

                const blocked = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(blocked.status, 409, '以前這裡是 500');
                assert.deepEqual(blocked.body.children, [child]);
                assert.equal(blocked.body.message, `此題是承上題 #${child} 的前題，請先刪除或解除綁定該承上題。`);
                assert.equal((await query('SELECT COUNT(*)::int AS n FROM questions WHERE id = $1', [pred])).rows[0].n, 1, '交易已回滾');

                assert.equal((await request(app).delete(`/api/questions/${child}`)).status, 200);
                const ok = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(ok.status, 200);
                assert.deepEqual(ok.body, { message: '題目已刪除！', id: pred });
            });

            test('匯入任務產生的題（job_questions 參照）→ 409 請改用封存', async () => {
                const { jqIds } = await seedJob([plainQ(1)]);
                await drain(makeRunner());
                const { question_id } = await jqRow(jqIds[0]);

                const res = await request(app).delete(`/api/questions/${question_id}`);
                assert.equal(res.status, 409, '以前這裡是 500');
                assert.deepEqual(res.body, { message: '此題由匯入任務產生，無法直接刪除，請改用封存。' });
                assert.equal((await query('SELECT COUNT(*)::int AS n FROM questions WHERE id = $1', [question_id])).rows[0].n, 1);
            });
        });

        describe('刪除／封存保護與整組處理（PR3）', () => {
            /** 建 pred ← child ← grandchild 三層鏈（follows_src='human'） */
            async function seedChain(tag) {
                const pred = await insertQuestion(`自製整組測試前題 ${tag}：設 $x=4$，求 $2x$。`, { origin: 'legacy' });
                const child = await insertQuestion(`承上題，自製整組測試子題 ${tag}：再求 $3x$。`, { origin: 'legacy' });
                const grand = await insertQuestion(`承上題，自製整組測試孫題 ${tag}：再求 $4x$。`, { origin: 'legacy' });
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [pred, child]);
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [child, grand]);
                return { pred, child, grand };
            }

            /** 替某題寫一筆作答紀錄（attempts ON DELETE RESTRICT） */
            async function addAttempt(questionId) {
                const { rows: s } = await query(`INSERT INTO students (name) VALUES ($1) RETURNING id`,
                    [`整組測試學生-${questionId}`]);
                await insertAttempts(query, [{ student_id: s[0].id, question_id: questionId }]);
            }

            async function seedVariantJob(sourceId, state = 'done') {
                const { rows } = await query(
                    `INSERT INTO jobs (kind, source_question_id, state, budget_usd)
                     VALUES ('variant', $1, $2, 0.3) RETURNING id`, [sourceId, state]);
                return Number(rows[0].id);
            }

            async function stateOf(ids) {
                const { rows } = await query(
                    'SELECT id, archived_at IS NOT NULL AS archived FROM questions WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
                return rows;
            }

            test('變式題藍本（jobs.source_question_id）→ 409 附 job_ids，不再落 500', async () => {
                const id = await insertQuestion('自製變式藍本測試題：設 $x=2$，求 $5x$。', { origin: 'legacy' });
                const jobA = await seedVariantJob(id, 'done');
                const jobB = await seedVariantJob(id, 'failed');

                const res = await request(app).delete(`/api/questions/${id}`);
                assert.equal(res.status, 409, '修前這裡是 500（jobs_source_question_id_fkey 未處理）');
                assert.deepEqual(res.body, { message: '此題是變式題藍本，請改用封存。', job_ids: [jobA, jobB] });
                assert.equal((await stateOf([id])).length, 1, '交易已回滾');
            });

            test('?group=1：三層鏈都沒有引用 → 單一交易整組硬刪', async () => {
                const { pred, child, grand } = await seedChain('A');
                const res = await request(app).delete(`/api/questions/${pred}?group=1`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, {
                    message: `已刪除整組 3 題（#${pred}、#${child}、#${grand}）。`,
                    id: pred, ids: [pred, child, grand], archived: false
                });
                assert.equal((await stateOf([pred, child, grand])).length, 0);
            });

            test('?group=1：組內孫題有作答紀錄 → 整組改封存，一題都不硬刪', async () => {
                const { pred, child, grand } = await seedChain('B');
                await addAttempt(grand);
                const res = await request(app).delete(`/api/questions/${pred}?group=1`);
                assert.equal(res.status, 200);
                assert.equal(res.body.archived, true);
                assert.deepEqual(res.body.ids, [pred, child, grand]);
                assert.match(res.body.message, /整組 3 題改為封存/);
                assert.deepEqual((await stateOf([pred, child, grand])).map(r => r.archived), [true, true, true]);
            });

            test('?group=1：組內有匯入任務或變式藍本引用 → 整組改封存', async () => {
                const { pred, child, grand } = await seedChain('C');
                await seedVariantJob(child);
                const res = await request(app).delete(`/api/questions/${pred}?group=1`);
                assert.equal(res.status, 200);
                assert.equal(res.body.archived, true);
                assert.deepEqual((await stateOf([pred, child, grand])).map(r => r.archived), [true, true, true]);

                // 匯入任務產生的單題（job_questions 參照）也能經 group 封存，不必另開封存端點
                const { jqIds } = await seedJob([plainQ(7)]);
                await drain(makeRunner());
                const { question_id } = await jqRow(jqIds[0]);
                const solo = await request(app).delete(`/api/questions/${question_id}?group=1`);
                assert.equal(solo.status, 200);
                assert.deepEqual(solo.body.ids, [question_id]);
                assert.equal(solo.body.archived, true);
            });

            test('未帶 group：前題有作答紀錄且承上題仍在庫 → 409 列出承上題，不封存', async () => {
                const { pred, child, grand } = await seedChain('D');
                await addAttempt(pred);
                const res = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(res.status, 409);
                assert.deepEqual(res.body, {
                    message: `此題是承上題 #${child} 的前題，請先刪除或解除綁定該承上題。`,
                    children: [child]
                });
                assert.deepEqual((await stateOf([pred, child, grand])).map(r => r.archived), [false, false, false]);

                // 承上題已封存（不在庫）時，單封前題照舊
                await query('UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[])', [[child, grand]]);
                const ok = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(ok.status, 200);
                assert.equal(ok.body.archived, true);
            });

            test('?group=1 從中間題開始：只處理它與它之後的承上題，前題不動', async () => {
                const { pred, child, grand } = await seedChain('E');
                const res = await request(app).delete(`/api/questions/${child}?group=1`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.ids, [child, grand]);
                assert.deepEqual((await stateOf([pred, child, grand])).map(r => r.id), [pred]);
            });

            test('?group=1：已封存的承上題也一併處理（否則 FK 會擋硬刪）；找不到 → 404', async () => {
                const { pred, child, grand } = await seedChain('F');
                await query('UPDATE questions SET archived_at = now() WHERE id = $1', [grand]);
                const res = await request(app).delete(`/api/questions/${pred}?group=1`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.ids, [pred, child, grand]);
                assert.equal(res.body.archived, false);
                assert.equal((await stateOf([pred, child, grand])).length, 0);

                const missing = await request(app).delete(`/api/questions/${pred}?group=1`);
                assert.equal(missing.status, 404);
                assert.deepEqual(missing.body, { message: '找不到該題目' });
            });

            test('未帶 group：匯入任務產生的前題仍有在庫承上題 → 409 列出承上題（不受 FK 檢查順序影響）', async () => {
                // review 發現：job_questions 的 FK（0003）先於 follows 的 FK（0008）檢查，
                // 修前這裡回的是「請改用封存」且沒有 children，前端會把「整組封存」說成「封存此題」
                const { jqIds } = await seedJob([plainQ(3)]);
                await drain(makeRunner());
                const { question_id: pred } = await jqRow(jqIds[0]);
                const child = await insertQuestion('承上題，自製匯入前題的子題：再求 $3x$。', { origin: 'legacy' });
                const grand = await insertQuestion('承上題，自製匯入前題的孫題：再求 $4x$。', { origin: 'legacy' });
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [pred, child]);
                await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [child, grand]);

                const res = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(res.status, 409);
                assert.deepEqual(res.body, {
                    message: `此題是承上題 #${child} 的前題，請先刪除或解除綁定該承上題。`,
                    children: [child]
                });
                assert.deepEqual((await stateOf([pred, child, grand])).map(r => r.archived), [false, false, false]);

                // 承上題都已封存時，照舊落到 job_questions 的「請改用封存」
                await query('UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[])', [[child, grand]]);
                const archivedKids = await request(app).delete(`/api/questions/${pred}`);
                assert.equal(archivedKids.status, 409);
                assert.deepEqual(archivedKids.body, { message: '此題由匯入任務產生，無法直接刪除，請改用封存。' });
            });

            test('?group=1：鎖組員期間有新承上題綁到較深組員 → 一併納入，不留下缺前題的在庫承上題', async () => {
                const { pred, child, grand } = await seedChain('R');
                await addAttempt(pred);                 // 走封存分支（該分支不會撞 FK）
                const late = await insertQuestion('承上題，自製競態測試新子題：再求 $5x$。', { origin: 'legacy' });

                // 另一個交易把 late 綁到 grand 但先不提交：它持有 grand 的 FOR KEY SHARE
                const other = await pool.connect();
                try {
                    await other.query('BEGIN');
                    await other.query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [grand, late]);

                    const pending = request(app).delete(`/api/questions/${pred}?group=1`).then(r => r);
                    // 等整組處理卡在鎖上（修前：已讀完組員 [pred, child, grand]、正在鎖 grand）
                    const deadline = Date.now() + 5000;
                    for (; ;) {
                        const { rows } = await query(
                            `SELECT count(*)::int AS n FROM pg_stat_activity
                              WHERE datname = current_database() AND wait_event_type = 'Lock'`);
                        if (rows[0].n > 0) break;
                        if (Date.now() >= deadline) throw new Error('整組處理沒有等在鎖上');
                        await new Promise(r => setTimeout(r, 20));
                    }
                    await other.query('COMMIT');

                    const res = await pending;
                    assert.equal(res.status, 200);
                    assert.equal(res.body.archived, true);
                    assert.deepEqual(res.body.ids, [pred, child, grand, late]);
                    assert.deepEqual((await stateOf([pred, child, grand, late])).map(r => r.archived), [true, true, true, true]);
                } finally {
                    other.release();
                }
            });

            test('GET /api/questions 回 follows_question_id 與 has_follow_ups（已封存的承上題不算）', async () => {
                const { pred, child, grand } = await seedChain('G');
                const res = await request(app).get('/api/questions');
                assert.equal(res.status, 200);
                const byId = new Map(res.body.questions.map(q => [q.id, q]));
                assert.equal(byId.get(pred).follows_question_id, null);
                assert.equal(byId.get(pred).has_follow_ups, true);
                assert.equal(byId.get(child).follows_question_id, pred);
                assert.equal(byId.get(child).has_follow_ups, true);
                assert.equal(byId.get(grand).follows_question_id, child);
                assert.equal(byId.get(grand).has_follow_ups, false);

                await query('UPDATE questions SET archived_at = now() WHERE id = $1', [grand]);
                const after = await request(app).get('/api/questions');
                assert.equal(after.body.questions.find(q => q.id === child).has_follow_ups, false);
            });
        });

        describe('補測（L2／L3）', () => {
            test('同 job 撞題時跳過補強：命中本 job 自己入庫的承上題，不以重複列的位置補綁', async () => {
                // 1001 前題卡在複核（規則 A 對 1002 回 pending）；1004 與 1002 同題（同 job 命中）。
                // 若補強規則沒排除本 job 自己入庫的題，1002 會被以 1004 的位置補綁到 1003。
                const { jqIds } = await seedJob([plainQ(1, STUCK), followQ(2), plainQ(3), plainQ(4)]);
                await query(
                    `UPDATE job_questions SET payload = jsonb_set(payload, '{extract,__fake}', $2::jsonb) WHERE id = $1`,
                    [jqIds[3], JSON.stringify({ dedup0: { kind: 'fail', reason: 'duplicate', data: { text_hash: 'd'.repeat(64), normalized_len: 10, hit: { scope: 'job', jq_id: jqIds[1] } } } })]);
                await drain(makeRunner());

                const child = await jqRow(jqIds[1]);
                assert.equal(child.state, 'saved');
                assert.equal((await jqRow(jqIds[3])).review_reason, 'duplicate');
                assert.deepEqual(await follows(child.question_id), { follows_question_id: null, follows_src: null });
            });

            test('approve 時 linkJob 在 SAVEPOINT 內丟錯 → approve 仍 200、state=saved', async () => {
                const { jqIds } = await seedJob([plainQ(1, STUCK), followQ(2)]);
                await drain(makeRunner());

                const original = linker.linkJob;
                const originalWarn = console.warn;
                const warned = [];
                linker.linkJob = async () => { throw new Error('測試注入：綁定失敗'); };
                console.warn = (msg) => warned.push(String(msg));
                let res;
                try {
                    res = await request(app).post(`/api/review/${jqIds[0]}/approve`).send(GOOD_BODY);
                } finally {
                    linker.linkJob = original;
                    console.warn = originalWarn;
                }
                assert.equal(res.status, 200);
                assert.equal(typeof res.body.question_id, 'number');
                assert.equal(res.body.follows_question_id, null);
                const pred = await jqRow(jqIds[0]);
                assert.equal(pred.state, 'saved');
                assert.equal(pred.question_id, res.body.question_id);
                assert.ok(warned.some(w => /承上題綁定失敗/.test(w)), '失敗要留 log');
                const child = await jqRow(jqIds[1]);
                assert.equal((await follows(child.question_id)).follows_question_id, null, '綁定那一段已回滾');
            });

            test('runner 的 linkFollowUps 丟錯只 warn，狀態照常推進、job 收成 done', async () => {
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                const warns = [];
                const original = linker.linkJob;
                linker.linkJob = async () => { throw new Error('測試注入：runner 綁定失敗'); };
                try {
                    await drain(makeRunner({ info() { }, warn(o) { warns.push(o); }, error() { } }));
                } finally {
                    linker.linkJob = original;
                }
                for (const id of jqIds) assert.equal((await jqRow(id)).state, 'saved');
                const { rows: job } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
                assert.equal(job[0].state, 'done');
                assert.ok(warns.some(w => w.msg === '承上題綁定失敗（不影響狀態推進）' && w.job_id === jobId));
            });

            test('變式 job 的複核資訊 → unresolved_reason=variant_job（變式題不做綁定）', async () => {
                const source = await insertQuestion('自製變式藍本：設 $x=1$，求 $2x$。');
                const { rows } = await query(
                    `INSERT INTO jobs (kind, source_question_id, state, budget_usd) VALUES ('variant', $1, 'processing', 0.5) RETURNING id`, [source]);
                const { rows: jq } = await query(
                    `INSERT INTO job_questions (job_id, idx, state, review_reason, payload)
                     VALUES ($1, 1, 'needs_review', 'awaiting_approval', $2::jsonb) RETURNING id`,
                    [rows[0].id, JSON.stringify({ extract: { ...followQ(1), idx: 1, chunk_no: 0 } })]);
                const res = await request(app).get(`/api/review/${jq[0].id}`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.follow_up, { is_follow_up: true, predecessor: null, unresolved_reason: 'variant_job' });
            });
        });

        describe('回填腳本', () => {
            /** 直接造出「舊資料」：兩列重複題已在終態、綁定尚未發生；另有一題沒有任何拆題紀錄的承上題 */
            async function seedLegacy() {
                const legacyPred = await insertQuestion('自製回填前題：設 $x=8$，求 $2x$。', { origin: 'legacy' });
                const legacyChild = await insertQuestion('承上題，自製回填子題：再求 $3x$。', { origin: 'legacy' });
                const orphan = await insertQuestion('承上一題，自製孤兒題：再求 $4x$。', { origin: 'legacy' });
                const { jobId, jqIds } = await seedJob([plainQ(1), followQ(2)]);
                await query(
                    `UPDATE job_questions SET state = 'needs_review', review_reason = 'duplicate',
                            payload = payload || jsonb_build_object('dedup0', jsonb_build_object('hit', jsonb_build_object('scope', 'db', 'question_id', $2::int)))
                      WHERE id = $1`, [jqIds[0], legacyPred]);
                await query(
                    `UPDATE job_questions SET state = 'rejected', review_reason = 'duplicate',
                            payload = payload || jsonb_build_object('dedup0', jsonb_build_object('hit', jsonb_build_object('scope', 'db', 'question_id', $2::int)))
                      WHERE id = $1`, [jqIds[1], legacyChild]);
                return { jobId, legacyPred, legacyChild, orphan };
            }

            test('dry-run 不寫入、重跑報告相同；正式跑寫入 src=backfill、再跑 bound 為空', async () => {
                const { jobId, legacyPred, legacyChild, orphan } = await seedLegacy();

                const dry1 = await backfill({ pool }, { dryRun: true });
                assert.equal(dry1.dryRun, true);
                assert.deepEqual(dry1.bound, [{ job_id: jobId, question_id: legacyChild, follows_question_id: legacyPred }]);
                assert.deepEqual(dry1.unresolved, []);
                assert.deepEqual(dry1.orphans.map(o => o.question_id), [orphan], '孤兒只列沒有拆題紀錄且未綁的承上題');
                assert.deepEqual(await follows(legacyChild), { follows_question_id: null, follows_src: null }, 'dry-run 不得寫入');

                const dry2 = await backfill({ pool }, { dryRun: true });
                assert.deepEqual(dry2, dry1, 'dry-run 重跑結果相同');

                const real = await backfill({ pool }, { dryRun: false });
                assert.deepEqual(real.bound, dry1.bound);
                assert.deepEqual(real.orphans, dry1.orphans);
                assert.deepEqual(await follows(legacyChild), { follows_question_id: legacyPred, follows_src: 'backfill' });

                const again = await backfill({ pool }, { dryRun: false });
                assert.deepEqual(again.bound, [], '冪等：已綁好的不再寫');
                assert.deepEqual(again.orphans, dry1.orphans);
                assert.deepEqual(await follows(legacyChild), { follows_question_id: legacyPred, follows_src: 'backfill' });
            });
        });
    });
}
