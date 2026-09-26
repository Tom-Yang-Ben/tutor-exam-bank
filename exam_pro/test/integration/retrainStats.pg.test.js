// ─────────────────────────────────────────────────────────────
// test/integration/retrainStats.pg.test.js — API-13 重練成效（錯題重練第二階段之三 PR-4）
//
// docs/retrain-and-review.md 第 5.2 節 API-13、第 4.5 節的例子、第 6.3 節 TC-040-1（stats 的部分；API-4 的部分在
// retrain.pg.test.js）：
//   - 旗標關閉不掛載（404）；學生不存在 404；參數不合法 400（同裁決 S5-21 的嚴格驗證）
//   - 第 4.5 節的例子：第 1 關的作答算「第一次重練」（兩次都對），第 2 關以後算「隔週回測」（三次對兩次）
//   - 題數（進過清單、進行中、練到會、移出、卡關）＝API-1 的 counts；到期與逾期 7 天以上；依章節；依科目篩選
//   - 答對率只算 days 天內派出、已批改的重練派題（含 since 當天）；全對才算對（R2）；分母 0 時 null
//
// 重練派題的寫入沿用 retrain.pg.test.js 的做法：services/retrainService.js 的 insertRetrainAssignments（出卷整合 PR-3
// 之後 confirm-paper 也走它），或 test/helpers/attempts.js 直接寫過去的派題再重算。日期用本地時區的「今天」。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('重練成效 API-13（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /** 依旗標載入一份 app（路由在載入當下決定掛不掛）。 */
    function loadApp(retrainOn) {
        const saved = { s: process.env.FEATURE_STUDENTS, r: process.env.FEATURE_RETRAIN };
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        process.env.FEATURE_STUDENTS = 'true';
        if (retrainOn) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        const app = require(APP_PATH);
        for (const [k, v] of [['FEATURE_STUDENTS', saved.s], ['FEATURE_RETRAIN', saved.r]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        return app;
    }
    const appOff = loadApp(false);
    const appOn = loadApp(true);

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const retrain = require(path.join(APP_DIR, 'services', 'retrainService'));
    const schedule = require(path.join(APP_DIR, 'services', 'retrainSchedule'));

    const today = retrain.todayLocal();
    const day = n => schedule.addDays(today, n);

    // ─────────── 夾具 ───────────

    let seq = 0;
    async function seedQuestions(n, { subject = '數學', chapter = '向量內積' } = {}) {
        const out = [];
        for (let i = 0; i < n; i++) {
            seq += 1;
            const { rows: [q] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ($1, $2, '計算', 3, $3, $4) RETURNING id`,
                [subject, chapter, `重練成效測試題 ${seq}：求 $x$。`, `答 ${seq}`]);
            out.push(q.id);
        }
        return out;
    }

    async function createStudent(name) {
        const res = await request(appOn).post('/api/students').send({ name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    }

    async function confirmPaper(studentId, questionIds) {
        const res = await request(appOn).post('/api/confirm-paper').send({ student_id: studentId, question_ids: questionIds });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.paper_id;
    }

    /** 交易內寫一張重練卷（PR-2 交付給 PR-3 的 insertRetrainAssignments；retrain_step＝當下關卡）。 */
    async function retrainPaper(studentId, questionIds, assignedAt) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [p] } = await client.query(
                'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                ['錯題重練卷', studentId, questionIds]);
            const r = await retrain.insertRetrainAssignments(client, { studentId, paperId: p.id, assignedAt, questionIds });
            assert.equal(r.conflict, null, JSON.stringify(r.conflict));
            await client.query('COMMIT');
            return p.id;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async function recomputeStudent(studentId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await retrain.recompute(client, studentId);
            await client.query('COMMIT');
        } finally {
            client.release();
        }
    }

    const patch = (paperId, results) => request(appOn).patch(`/api/papers/${paperId}/results`).send({ results });
    const stats = (studentId, qs = '') => request(appOn).get(`/api/students/${studentId}/retrain-stats${qs}`);
    const itemId = async (studentId, questionId) =>
        (await query('SELECT id FROM retrain_items WHERE student_id = $1 AND question_id = $2', [studentId, questionId])).rows[0].id;

    describe('重練成效 API-13（PR-4）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });
        beforeEach(async () => {
            process.env.FEATURE_RETRAIN = 'true';
            await query('TRUNCATE retrain_items, attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });
        after(async () => {
            delete process.env.FEATURE_RETRAIN;
            await pool.end();
        });

        test('旗標關閉不掛載（404）；學生不存在 404；參數不合法 400；沒有任何項目時全 0、答對率 null', async () => {
            const s = await createStudent('空白生');
            const off = await request(appOff).get(`/api/students/${s}/retrain-stats`);
            assert.equal(off.status, 404);
            assert.notDeepEqual(off.body, { message: '找不到該學生' }, '是路由沒掛載的 Express 預設 404，不是 controller 的 404');

            const empty = await stats(s);
            assert.equal(empty.status, 200, JSON.stringify(empty.body));
            assert.deepEqual(empty.body, {
                entered: 0, active: 0, mastered: 0, retired: 0, stuck: 0,
                first_retrain: { graded: 0, correct: 0, rate: null },
                spaced: { graded: 0, correct: 0, rate: null },
                backlog: { due_now: 0, overdue_7d: 0 },
                by_chapter: [],
                since: day(-90)
            });

            assert.deepEqual([(await stats(999999)).status, (await stats(999999)).body], [404, { message: '找不到該學生' }]);
            assert.equal((await stats('1.5')).status, 404);
            assert.equal((await stats('abc')).status, 404);
            for (const [qs, message] of [
                ['?days=0', 'days 必須是 1~365 的整數。'],
                ['?days=366', 'days 必須是 1~365 的整數。'],
                ['?days=7.5', 'days 必須是 1~365 的整數。'],
                ['?subject=生物', 'subject 不在白名單內。'],
                ['?day=30', '不認得的查詢參數：day（可用：days、subject）。'],
                ['?days=30&days=60', 'days 只能給一個值。']
            ]) {
                const res = await stats(s, qs);
                assert.deepEqual([res.status, res.body], [400, { message }], qs);
            }
        });

        test('第 4.5 節的例子：第 1 關算「第一次重練」（2 次都對）、第 2 關以後算「隔週回測」（3 次對 2 次）；練到會', async () => {
            const [q1] = await seedQuestions(1);
            const s = await createStudent('例子生');
            const p1 = await confirmPaper(s, [q1]);
            // 10/1 新題答錯、老師勾「要重練」（新題那一次不算進重練成效）
            assert.equal((await patch(p1, [{ question_id: q1, result: 0, retrain: true }])).status, 200);
            // 10/5 對（第 1 關）、10/12 錯（第 2 關）、10/15 對（第 1 關）、10/22 對（第 2 關）、11/5 對（第 3 關）
            const steps = [[day(4), 1], [day(11), 0], [day(14), 1], [day(21), 1], [day(35), 1]];
            for (const [date, result] of steps) {
                const paperId = await retrainPaper(s, [q1], date);
                const res = await patch(paperId, [{ question_id: q1, result }]);
                assert.equal(res.status, 200, JSON.stringify(res.body));
            }
            const { rows: steps2 } = await query(
                `SELECT retrain_step FROM assignments WHERE student_id = $1 AND purpose = 'retrain' ORDER BY assigned_at`, [s]);
            assert.deepEqual(steps2.map(r => r.retrain_step), [1, 2, 1, 2, 3], '派題當下的關卡');

            const res = await stats(s);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body),
                ['entered', 'active', 'mastered', 'retired', 'stuck', 'first_retrain', 'spaced', 'backlog', 'by_chapter', 'since']);
            assert.deepEqual(res.body, {
                entered: 1, active: 0, mastered: 1, retired: 0, stuck: 0,
                first_retrain: { graded: 2, correct: 2, rate: 1 },
                spaced: { graded: 3, correct: 2, rate: 0.6667 },
                backlog: { due_now: 0, overdue_7d: 0 },
                by_chapter: [{ chapter: '向量內積', entered: 1, mastered: 1, active: 0, stuck: 0 }],
                since: day(-90)
            });
            assert.ok(!JSON.stringify(res.body).includes('例子生'), '不回姓名');
        });

        test('題數＝API-1 的 counts；到期與逾期 7 天以上；卡關；時間窗（含 since 當天）；全對才算對；沒批改不算；依科目篩選', async () => {
            const [A, B, C, D] = await seedQuestions(4);
            const [E] = await seedQuestions(1, { chapter: '實數' });
            const [P] = await seedQuestions(1, { subject: '物理', chapter: '直線運動' });
            const t = await createStudent('成效生');
            const other = await createStudent('對照生');
            const all = [A, B, C, D, E, P];

            // 很久以前以新題派過（已批改），再以題號手動加入，然後把起算日改到過去（夾具）
            await insertAttempts(query, all.map(q => ({ student_id: t, question_id: q, assigned_at: day(-200), result: 0, graded_at: 'now' })));
            const add = await request(appOn).post(`/api/students/${t}/retrain-items`).send({ question_ids: all });
            assert.equal(add.body.added.length, 6, JSON.stringify(add.body));
            for (const [q, n] of [[A, -20], [B, -3], [C, -30], [D, -3], [E, -3], [P, -5]]) {
                await query('UPDATE retrain_items SET entered_on = $3::date WHERE student_id = $1 AND question_id = $2', [t, q, day(n)]);
            }
            const rp = async (q, date, step, grade) => {
                const [p] = (await query('INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                    ['成效重練卷', t, [q]])).rows;
                await insertAttempts(query, [{ student_id: t, question_id: q, paper_id: p.id, purpose: 'retrain', assigned_at: date,
                    retrain_step: step, ...(grade ? { ...grade, graded_at: 'now' } : {}) }]);
            };
            for (const n of [-29, -28, -27]) await rp(C, day(n), 1, { result: 0 });   // 錯滿 3 次 → 卡關
            await rp(A, day(-90), 2, { result: 1 });                                  // 時間窗的第一天（含）
            await rp(A, day(-91), 1, { result: 1 });                                  // 時間窗外
            await rp(B, day(-2), 1, { result: 1, score: 0.8 });                       // 按對但 80%：R2 算錯
            await rp(P, day(-6), 1, { result: 1 });                                   // 物理
            await rp(E, day(-10), 1, null);                                           // 沒批改：不算
            await recomputeStudent(t);
            assert.equal((await request(appOn).patch(`/api/students/${t}/retrain-items/${await itemId(t, D)}`)
                .send({ action: 'mark_mastered' })).status, 200);
            assert.equal((await request(appOn).patch(`/api/students/${t}/retrain-items/${await itemId(t, E)}`)
                .send({ action: 'retire' })).status, 200);
            // 對照生的資料不能混進來
            const [Z] = await seedQuestions(1);
            const pz = await confirmPaper(other, [Z]);
            await patch(pz, [{ question_id: Z, result: 0, retrain: true }]);
            const rz = await retrainPaper(other, [Z], today);
            await patch(rz, [{ question_id: Z, result: 1 }]);

            const res = await stats(t);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body, {
                entered: 6, active: 4, mastered: 1, retired: 1, stuck: 1,
                // 第 1 關：C 三次錯、B 80%（算錯）、P 對；A 在 day(-91) 的那一次在時間窗外；E 沒批改
                first_retrain: { graded: 5, correct: 1, rate: 0.2 },
                spaced: { graded: 1, correct: 1, rate: 1 },
                // 到期：A（逾期 19）、B（1）、C（26）、P（4）；D 練到會、E 移出
                backlog: { due_now: 4, overdue_7d: 2 },
                by_chapter: [
                    { chapter: '向量內積', entered: 4, mastered: 1, active: 3, stuck: 1 },
                    { chapter: '直線運動', entered: 1, mastered: 0, active: 1, stuck: 0 },
                    { chapter: '實數', entered: 1, mastered: 0, active: 0, stuck: 0 }
                ],
                since: day(-90)
            });
            // 題數與 API-1 的 counts 同一套判斷
            const list = await request(appOn).get(`/api/students/${t}/retrain-items?status=all`);
            assert.deepEqual(
                [res.body.active, res.body.mastered, res.body.retired, res.body.stuck, res.body.backlog.due_now],
                [list.body.counts.active, list.body.counts.mastered, list.body.counts.retired, list.body.counts.stuck, list.body.counts.due]);

            // 時間窗：days 只影響答對率，題數與到期是清單現況
            const y = await stats(t, '?days=365');
            assert.deepEqual([y.body.first_retrain, y.body.spaced, y.body.since],
                [{ graded: 6, correct: 2, rate: 0.3333 }, { graded: 1, correct: 1, rate: 1 }, day(-365)]);
            assert.deepEqual([y.body.entered, y.body.active, y.body.backlog], [6, 4, { due_now: 4, overdue_7d: 2 }]);
            const d89 = await stats(t, '?days=89');
            assert.deepEqual(d89.body.spaced, { graded: 0, correct: 0, rate: null }, 'since 之前的不算');

            // 依科目：題數、到期與答對率都只算數學
            const m = await stats(t, '?subject=數學');
            assert.deepEqual(m.body, {
                entered: 5, active: 3, mastered: 1, retired: 1, stuck: 1,
                first_retrain: { graded: 4, correct: 0, rate: 0 },
                spaced: { graded: 1, correct: 1, rate: 1 },
                backlog: { due_now: 3, overdue_7d: 2 },
                by_chapter: [
                    { chapter: '向量內積', entered: 4, mastered: 1, active: 3, stuck: 1 },
                    { chapter: '實數', entered: 1, mastered: 0, active: 0, stuck: 0 }
                ],
                since: day(-90)
            });
            const phys = await stats(t, '?subject=物理&days=30');
            assert.deepEqual([phys.body.entered, phys.body.first_retrain, phys.body.backlog],
                [1, { graded: 1, correct: 1, rate: 1 }, { due_now: 1, overdue_7d: 0 }]);

            // 對照生：只有自己的一題、一次第一次重練（對）
            const o = await stats(other);
            assert.deepEqual([o.body.entered, o.body.active, o.body.first_retrain], [1, 1, { graded: 1, correct: 1, rate: 1 }]);
        });
    });
}
