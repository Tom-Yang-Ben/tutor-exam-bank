// ─────────────────────────────────────────────────────────────
// solutions.pg.test.js — 文字詳解與 Word 匯出版本的整合測試（階段 5 WS-A；DEC-017、缺口 G05）
//
// 契約：docs/interfaces-stage5.md 第 4.1 條第 5、6 項。
//   GET  /api/questions、GET /api/questions/:id   帶 solution_text、solution_src
//   POST /api/questions、PUT /api/questions/:id    接受 solution_text；老師寫入＝teacher，清空＝兩欄 NULL
//   管線 save 節點                                  verify 判定一致且 steps_summary 非空 → verify
//   scripts/backfill_solutions.js                   從 job_questions.payload 回填，不呼叫 LLM、不覆寫
//   POST /api/download-word                         edition：standard／student／solution，其他 400
//
// 管線那一段直接對 state='deduped' 的列呼叫 runner.runJobQuestion（下一個節點就是 save），
// 不從 extract 跑起：前面六個節點的行為由 jobs.pg.test.js 負責，這裡只驗 save 寫不寫詳解。
// LLM 一律是假的（save 節點本來就不呼叫 LLM）。
//
// 三道防線與其他整合測試相同。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('文字詳解整合測試（需要 PostgreSQL）', {
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
    process.env.JOB_RUNNER = 'off';

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const { backfill } = require(path.join(APP_DIR, 'scripts', 'backfill_solutions'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';

    // ─────────────────── 清表（入庫會 fire-and-forget 補向量，TRUNCATE 可能撞死結）───────────────────

    /** 與 jobs.pg.test.js 同一個理由：背景補向量的交易可能還沒結束，先等、撞到死結就退避重試。 */
    async function truncateAll(attempts = 10) {
        for (let i = 1; ; i++) {
            await waitForIdleBackends();
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= attempts) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
            }
        }
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

    // ─────────────────── 灌資料輔助 ───────────────────

    let seq = 0;
    /** 直接 INSERT 一題（可指定詳解與來源），回 id。 */
    async function seedQuestion({ solution = null, src = null, answer = '5', stem } = {}) {
        seq += 1;
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, solution_text, solution_src)
             VALUES ($1, $2, '計算', 3, $3, $4, $5, $6) RETURNING id`,
            [SUBJECT, CHAPTER, stem || `自製詳解測試題 ${seq}：求 $|(3,4)|$。`, answer, solution, solution === null ? null : (src || 'teacher')]);
        return rows[0].id;
    }

    /** agents/verify.js pass 時存進 payload.verify 的形狀。 */
    function verified(extra = {}) {
        return {
            skipped: false, final_answer: '5', answer_form: 'number',
            steps_summary: '由畢氏定理 $\\sqrt{3^2+4^2}=5$。', claimed_answer: '5', compare: 'agree', samples: 1, ...extra
        };
    }

    /** payload.extract：入庫欄位的來源（buildSaveFields）。 */
    function extractOf(i, extra = {}) {
        return {
            idx: i, subject: SUBJECT, chapter: CHAPTER, chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
            question_text: `自製管線詳解題 ${i}：求 $|(3,${i})|$。`, answer_text: `$\\sqrt{${9 + i * i}}$`, ...extra
        };
    }

    /** 建一個 job 與若干列 job_questions（state、payload 自訂），回 { jobId, jqIds }。 */
    async function seedJob(rows) {
        const { rows: [job] } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
             VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`, [crypto.randomBytes(32).toString('hex')]);
        const jqIds = [];
        for (const [i, r] of rows.entries()) {
            const { rows: [jq] } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload, question_id) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
                [job.id, i + 1, r.state || 'deduped', JSON.stringify(r.payload), r.question_id ?? null]);
            jqIds.push(jq.id);
        }
        return { jobId: job.id, jqIds };
    }

    function makeRunner() {
        return createRunner({
            db: { pool, query },
            llm: { async generateJson() { throw new Error('save 節點不該呼叫 LLM'); }, async embed() { return { vectors: [], usage: {} }; } },
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },
            config: { nodeTimeoutMs: 2000, leaseMs: 60000, concurrency: 1 }
        });
    }

    async function solutionOf(id) {
        const { rows } = await query('SELECT solution_text, solution_src FROM questions WHERE id = $1', [id]);
        return rows[0];
    }

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('文字詳解與 Word 匯出版本 × PostgreSQL（interfaces-stage5.md 第 4.1 條第 5、6 項）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });

        beforeEach(async () => {
            await truncateAll();
        });

        after(async () => {
            await waitForIdleBackends();
            await pool.end();
        });

        // ───────── 題目 API ─────────

        describe('POST／PUT／GET /api/questions 的詳解欄位', () => {
            const base = { subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3, answer_text: '5' };

            test('POST 帶詳解 → teacher；不帶 → 兩欄 NULL；列表帶得出兩欄', async () => {
                const a = await request(app).post('/api/questions').send({ ...base, question_text: '自製 POST 詳解題 A', solution_text: '  $3^2+4^2=25$ ' });
                const b = await request(app).post('/api/questions').send({ ...base, question_text: '自製 POST 詳解題 B' });
                assert.equal(a.status, 201, JSON.stringify(a.body));
                assert.equal(b.status, 201);
                assert.deepEqual(await solutionOf(a.body.questionId), { solution_text: '$3^2+4^2=25$', solution_src: 'teacher' });
                assert.deepEqual(await solutionOf(b.body.questionId), { solution_text: null, solution_src: null });

                const list = await request(app).get('/api/questions?limit=10');
                const byId = new Map(list.body.questions.map(q => [q.id, q]));
                assert.deepEqual([byId.get(a.body.questionId).solution_text, byId.get(a.body.questionId).solution_src], ['$3^2+4^2=25$', 'teacher']);
                assert.ok('solution_text' in byId.get(b.body.questionId) && 'solution_src' in byId.get(b.body.questionId));
            });

            test('POST 詳解不合法 → 400 且不建題', async () => {
                const long = await request(app).post('/api/questions').send({ ...base, question_text: '自製超長詳解題', solution_text: '解'.repeat(4001) });
                assert.equal(long.status, 400);
                assert.deepEqual(long.body, { message: '詳解最多 4000 字。' });
                const wrongType = await request(app).post('/api/questions').send({ ...base, question_text: '自製型別錯誤題', solution_text: 42 });
                assert.deepEqual(wrongType.body, { message: '詳解必須是文字或 null。' });
                const { rows } = await query('SELECT COUNT(*)::int AS n FROM questions');
                assert.equal(rows[0].n, 0);
            });

            // 〔stage5 整合〕原本這一條是「PUT 沒帶 solution_text → 不動（改了題幹，verify 來源維持 verify）」。
            // WS-A 審查（low）：那份驗算摘要解的是改之前的題目，列表與 Word 詳解版卻會把它接在新答案後面。
            // 整合階段刻意改成：沒帶 solution_text、來源是 verify、題幹或答案真的改了 ⇒ 兩欄清成 NULL
            // （docs/grading-and-profile.md 第 3.6 條）。題幹與答案沒變時「不動」的斷言照舊保留。
            test('PUT 沒帶 solution_text：題幹與答案沒變 → 不動；verify 來源而題幹或答案改了 → 兩欄清空；teacher 一律不動', async () => {
                const stemOf = async id => (await query('SELECT question_text FROM questions WHERE id = $1', [id])).rows[0].question_text;

                // 只改難度，題幹與答案原樣送回（前後空白會被 trim 掉，不算改）
                const same = await seedQuestion({ solution: '驗算摘要', src: 'verify' });
                const r1 = await request(app).put(`/api/questions/${same}`).send({ ...base, difficulty: 4, question_text: ` ${await stemOf(same)} ` });
                assert.equal(r1.status, 200, JSON.stringify(r1.body));
                assert.deepEqual(await solutionOf(same), { solution_text: '驗算摘要', solution_src: 'verify' });

                // 改題幹
                const stem = await seedQuestion({ solution: '驗算摘要', src: 'verify' });
                assert.equal((await request(app).put(`/api/questions/${stem}`).send({ ...base, question_text: '自製改題幹' })).status, 200);
                assert.deepEqual(await solutionOf(stem), { solution_text: null, solution_src: null }, '舊題目的驗算摘要要清掉');

                // 只改答案
                const answer = await seedQuestion({ solution: '驗算摘要', src: 'verify' });
                assert.equal((await request(app).put(`/api/questions/${answer}`).send({ ...base, question_text: await stemOf(answer), answer_text: '6' })).status, 200);
                assert.deepEqual(await solutionOf(answer), { solution_text: null, solution_src: null }, '答案改了，與舊答案比對一致的摘要不再可信');

                // 老師寫的詳解：改題幹也不動（老師自己決定要不要改詳解）
                const teacher = await seedQuestion({ solution: '老師寫的', src: 'teacher' });
                assert.equal((await request(app).put(`/api/questions/${teacher}`).send({ ...base, question_text: '自製改題幹二' })).status, 200);
                assert.deepEqual(await solutionOf(teacher), { solution_text: '老師寫的', solution_src: 'teacher' });
            });

            test('PUT 帶一樣的詳解 → 保留原來源；改寫 → teacher；清空 → 兩欄 NULL', async () => {
                const id = await seedQuestion({ solution: '驗算摘要', src: 'verify' });
                const put = body => request(app).put(`/api/questions/${id}`).send({ ...base, question_text: '自製改題幹', ...body });

                assert.equal((await put({ solution_text: ' 驗算摘要 ' })).status, 200);
                assert.deepEqual(await solutionOf(id), { solution_text: '驗算摘要', solution_src: 'verify' },
                    '只是改別的欄位按儲存，詳解不該被標成老師寫的');

                await put({ solution_text: '老師重寫的詳解' });
                assert.deepEqual(await solutionOf(id), { solution_text: '老師重寫的詳解', solution_src: 'teacher' });

                await put({ solution_text: '' });
                assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null });

                await put({ solution_text: '新寫的' });
                assert.deepEqual(await solutionOf(id), { solution_text: '新寫的', solution_src: 'teacher' });
                await put({ solution_text: null });
                assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null });
            });

            test('PUT 詳解不合法 → 400，題目與詳解都不動', async () => {
                const id = await seedQuestion({ solution: '原本的', src: 'teacher' });
                const res = await request(app).put(`/api/questions/${id}`).send({ ...base, question_text: '不該寫進去', solution_text: '解'.repeat(4001) });
                assert.equal(res.status, 400);
                assert.deepEqual(res.body, { message: '詳解最多 4000 字。' });
                const { rows } = await query('SELECT question_text, solution_text FROM questions WHERE id = $1', [id]);
                assert.equal(rows[0].solution_text, '原本的');
                assert.notEqual(rows[0].question_text, '不該寫進去');
            });

            test('GET /api/questions/:id：題目詳情含詳解；已封存的題也查得到；404／400', async () => {
                const id = await seedQuestion({ solution: '詳情詳解', src: 'verify' });
                await query('UPDATE questions SET archived_at = now() WHERE id = $1', [id]);
                const res = await request(app).get(`/api/questions/${id}`);
                assert.equal(res.status, 200);
                assert.equal(res.body.id, id);
                assert.equal(res.body.solution_text, '詳情詳解');
                assert.equal(res.body.solution_src, 'verify');
                assert.ok(res.body.archived_at, '封存的題要帶 archived_at');
                for (const k of ['subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'answer_text', 'source_type', 'follows_question_id']) {
                    assert.ok(k in res.body, k);
                }
                assert.ok(!('embedding' in res.body) && !('search_tsv' in res.body), '不回檢索欄位');

                const missing = await request(app).get('/api/questions/999999');
                assert.equal(missing.status, 404);
                assert.deepEqual(missing.body, { message: '找不到該題目' });
                // 〔stage5 審查修正〕超過 int4 上限：404，不是 PG out of range 的 500
                for (const [method, body] of [['get'], ['put', { subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3, question_text: 'x', answer_text: '1' }], ['delete']]) {
                    const r = await request(app)[method]('/api/questions/3000000000').send(body);
                    assert.equal(r.status, 404, method);
                    assert.deepEqual(r.body, { message: '找不到該題目' });
                }
                assert.equal((await request(app).patch('/api/students/3000000000').send({ name: 'x' })).status, 400);
                for (const bad of ['abc', '0', '1.5', '-2']) {
                    const r = await request(app).get(`/api/questions/${bad}`);
                    assert.equal(r.status, 400, bad);
                    assert.deepEqual(r.body, { message: '無效的題目 ID' });
                }
            });
        });

        // ───────── 管線 save 節點 ─────────

        describe('管線 save 節點寫詳解', () => {
            test('verify 一致且摘要非空 → verify；證明題（skipped）與空摘要 → NULL', async () => {
                const { jqIds } = await seedJob([
                    { payload: { extract: extractOf(1), dedup0: { text_hash: null }, verify: verified({ steps_summary: '  第一題的解法 $a^2$ ' }) } },
                    { payload: { extract: extractOf(2, { question_type: '證明' }), verify: { skipped: true } } },
                    { payload: { extract: extractOf(3), verify: verified({ steps_summary: '' }) } }
                ]);
                const runner = makeRunner();
                for (const id of jqIds) await runner.runJobQuestion(id);

                const { rows } = await query(
                    `SELECT jq.idx, jq.state, q.solution_text, q.solution_src
                       FROM job_questions jq JOIN questions q ON q.id = jq.question_id
                      WHERE jq.id = ANY($1::bigint[]) ORDER BY jq.idx`, [jqIds]);
                assert.deepEqual(rows.map(r => [r.idx, r.state, r.solution_text, r.solution_src]), [
                    [1, 'saved', '第一題的解法 $a^2$', 'verify'],
                    [2, 'saved', null, null],
                    [3, 'saved', null, null]
                ]);
            });
        });

        // ───────── 回填腳本 ─────────

        describe('scripts/backfill_solutions.js', () => {
            /** 模擬「save 節點上線前」入庫的題：questions 沒有詳解，job_questions 留著 payload。 */
            async function legacySaved(i, { verify = verified(), current = {} } = {}) {
                const ex = extractOf(i);
                const { rows: [q] } = await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, solution_text, solution_src)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                    [ex.subject, ex.chapter, ex.question_type, ex.difficulty,
                        current.question_text ?? ex.question_text, current.answer_text ?? ex.answer_text,
                        current.solution_text ?? null, current.solution_src ?? null]);
                await seedJob([{ state: 'saved', question_id: q.id, payload: { extract: ex, ...(verify ? { verify } : {}) } }]);
                return q.id;
            }

            test('dry-run 不寫；正式跑寫入 verify；teacher 不覆寫、改過的題與不一致的題略過；可重複跑', async () => {
                const ok1 = await legacySaved(1, { verify: verified({ steps_summary: '摘要一' }) });
                const ok2 = await legacySaved(2, { verify: verified({ steps_summary: '摘要二' }) });
                const teacher = await legacySaved(3, { current: { solution_text: '老師的詳解', solution_src: 'teacher' } });
                const edited = await legacySaved(4, { current: { answer_text: '老師改過的答案' } });
                const disagree = await legacySaved(5, { verify: verified({ compare: 'disagree' }) });
                const proof = await legacySaved(6, { verify: { skipped: true } });

                const db = { pool, query };
                const dry = await backfill(db, { dryRun: true });
                assert.equal(dry.updated, 2);
                assert.deepEqual(dry.question_ids, [ok1, ok2]);
                assert.equal(dry.scanned, 6);
                assert.deepEqual(await solutionOf(ok1), { solution_text: null, solution_src: null }, 'dry-run 不得寫入');

                const real = await backfill(db, {});
                assert.equal(real.updated, 2);
                assert.equal(real.skipped.has_teacher, 1);
                assert.equal(real.skipped.edited, 1);
                assert.equal(real.skipped.not_agree, 1);
                assert.equal(real.skipped.verify_skipped, 1);
                assert.deepEqual(await solutionOf(ok1), { solution_text: '摘要一', solution_src: 'verify' });
                assert.deepEqual(await solutionOf(ok2), { solution_text: '摘要二', solution_src: 'verify' });
                assert.deepEqual(await solutionOf(teacher), { solution_text: '老師的詳解', solution_src: 'teacher' });
                for (const id of [edited, disagree, proof]) {
                    assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null }, `#${id}`);
                }

                const again = await backfill(db, {});
                assert.equal(again.updated, 0, '重跑是 no-op');
                assert.equal(again.skipped.has_verify, 2);
            });

            // 〔stage5 審查修正 S5-41〕老師清空的詳解，重跑回填不得寫回
            test('老師在編輯視窗清空回填的詳解 → 重跑回填維持 NULL（列為 cleared）；之後老師再寫 → 標記清掉', async () => {
                const id = await legacySaved(1, { verify: verified({ steps_summary: '驗算步驟：1+6=7' }) });
                const other = await legacySaved(2, { verify: verified({ steps_summary: '另一題的摘要' }) });
                const db = { pool, query };
                const first = await backfill(db, {});
                assert.deepEqual(first.question_ids, [id, other]);
                assert.deepEqual(await solutionOf(id), { solution_text: '驗算步驟：1+6=7', solution_src: 'verify' });

                const { rows: [cur] } = await query('SELECT question_text, answer_text FROM questions WHERE id = $1', [id]);
                const put = body => request(app).put(`/api/questions/${id}`).send({
                    subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
                    question_text: cur.question_text, answer_text: cur.answer_text, ...body
                });
                assert.equal((await put({ solution_text: null })).status, 200);
                assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null });
                const marked = (await query('SELECT solution_cleared_at FROM questions WHERE id = $1', [id])).rows[0];
                assert.ok(marked.solution_cleared_at, '清空既有詳解要留下標記');

                const again = await backfill(db, {});
                assert.equal(again.updated, 0, '清空過的詳解不得寫回');
                assert.deepEqual(again.question_ids, []);
                assert.equal(again.skipped.cleared, 1);
                assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null });

                // 沒有既有詳解時送 null（例如老師在空白欄位打了字又刪掉）不算「清空」，回填照補
                const never = await legacySaved(3, { verify: verified({ steps_summary: '第三題' }) });
                const { rows: [cur3] } = await query('SELECT question_text, answer_text FROM questions WHERE id = $1', [never]);
                assert.equal((await request(app).put(`/api/questions/${never}`).send({
                    subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
                    question_text: cur3.question_text, answer_text: cur3.answer_text, solution_text: ''
                })).status, 200);
                assert.equal((await query('SELECT solution_cleared_at FROM questions WHERE id = $1', [never])).rows[0].solution_cleared_at, null);
                assert.deepEqual((await backfill(db, {})).question_ids, [never]);

                // 老師之後自己寫了詳解 → 標記清掉（有詳解就不需要它）
                assert.equal((await put({ solution_text: '老師後來寫的' })).status, 200);
                const after = (await query('SELECT solution_text, solution_src, solution_cleared_at FROM questions WHERE id = $1', [id])).rows[0];
                assert.deepEqual(after, { solution_text: '老師後來寫的', solution_src: 'teacher', solution_cleared_at: null });
            });

            test('--limit：一輪只寫 N 題，其餘列為 remaining', async () => {
                const ids = [];
                for (let i = 1; i <= 4; i++) ids.push(await legacySaved(i));
                const r = await backfill({ pool, query }, { limit: 3 });
                assert.equal(r.updated, 3);
                assert.equal(r.remaining, 1);
                const { rows } = await query('SELECT COUNT(*)::int AS n FROM questions WHERE solution_src = $1', ['verify']);
                assert.equal(rows[0].n, 3);
            });

            test('CLI：--test --dry-run 印出回填與略過的數量，不寫庫', async () => {
                const id = await legacySaved(1);
                await legacySaved(2, { verify: verified({ compare: 'uncertain' }) });
                const out = execFileSync(process.execPath, ['scripts/backfill_solutions.js', '--test', '--dry-run'], {
                    cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
                });
                assert.match(out, /不呼叫 LLM/);
                assert.match(out, /掃描 2 題.*將回填 1 題；略過 1 題/);
                assert.match(out, /verify 與答案不一致或無法判定/);
                assert.deepEqual(await solutionOf(id), { solution_text: null, solution_src: null });
            });

            test('npm run solution:backfill 存在於 package.json', () => {
                const pkg = require(path.join(APP_DIR, 'package.json'));
                assert.equal(pkg.scripts['solution:backfill'], 'node scripts/backfill_solutions.js');
            });
        });

        // ───────── Word 匯出版本 ─────────

        describe('POST /api/download-word 的 edition（第 6 項）', () => {
            async function download(body) {
                return request(app).post('/api/download-word').send(body)
                    .buffer(true)
                    .parse((res, cb) => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => cb(null, Buffer.concat(chunks)));
                    });
            }

            test('standard（預設）／student／solution 三種版本', async () => {
                const withSol = await seedQuestion({ solution: '由 $\\sqrt{25}=5$ 可知', src: 'verify' });
                const without = await seedQuestion();
                const body = { paper_title: '詳解測試卷', student_name: '學生', question_ids: [withSol, without] };

                const standard = await download(body);
                assert.equal(standard.status, 200);
                const xmlStd = documentXml(standard.body);
                assert.ok(xmlStd.includes('參考答案區') && !xmlStd.includes('詳解：'));
                const explicit = documentXml((await download({ ...body, edition: 'standard' })).body);
                assert.ok(explicit.includes('參考答案區') && !explicit.includes('詳解：'));

                const xmlStu = documentXml((await download({ ...body, edition: 'student' })).body);
                assert.ok(xmlStu.includes('自製詳解測試題'));
                assert.ok(!xmlStu.includes('參考答案') && !xmlStu.includes('題答案：'), '學生版不附答案');

                const xmlSol = documentXml((await download({ ...body, edition: 'solution' })).body);
                assert.ok(xmlSol.includes('參考答案與詳解'));
                assert.ok(xmlSol.includes('詳解：') && xmlSol.includes('可知'));
                assert.ok(xmlSol.includes('<m:rad>'), '詳解的公式要轉成 Word 原生方程式');
                assert.ok(xmlSol.includes('（本題尚無文字詳解）'));
            });

            // 〔stage5 整合〕controller 要多查 solution_src，詳解版才分得出哪些是模型寫、沒人看過的
            test('solution：verify 來源的詳解加註「（AI 驗算摘要，未經老師審閱）」，teacher 的不加', async () => {
                const byVerify = await seedQuestion({ solution: '驗算寫的摘要', src: 'verify' });
                const byTeacher = await seedQuestion({ solution: '老師寫的詳解', src: 'teacher' });
                const res = await download({ paper_title: '來源標示卷', student_name: '學生', question_ids: [byVerify, byTeacher], edition: 'solution' });
                assert.equal(res.status, 200);
                const xml = documentXml(res.body);
                const note = '（AI 驗算摘要，未經老師審閱）';
                assert.equal(xml.split(note).length - 1, 1);
                assert.ok(xml.indexOf(note) < xml.indexOf('驗算寫的摘要'));
                assert.ok(!xml.slice(xml.indexOf('第 2 題答案：'), xml.indexOf('老師寫的詳解')).includes(note));
            });

            test('其他 edition 值回 400；既有的 question_ids 檢查仍然優先', async () => {
                const id = await seedQuestion();
                for (const edition of ['teacher', '', 'SOLUTION', 1]) {
                    const res = await request(app).post('/api/download-word')
                        .send({ paper_title: 'x', student_name: 'y', question_ids: [id], edition });
                    assert.equal(res.status, 400, JSON.stringify(edition));
                    assert.deepEqual(res.body, { message: 'edition 只接受 standard、student、solution。' });
                }
                const empty = await request(app).post('/api/download-word')
                    .send({ paper_title: 'x', student_name: 'y', question_ids: [], edition: 'nope' });
                assert.deepEqual(empty.body, { message: '無效的題目資料，無法產生 Word' });
            });
        });
    });
}
