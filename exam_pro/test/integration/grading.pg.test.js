// ─────────────────────────────────────────────────────────────
// grading.pg.test.js — 批改細節與錯因分布的整合測試（階段 5 WS-A；DEC-015、缺口 G03）
//
// 契約：docs/interfaces-stage5.md 第 4.1 條第 1～3 項。
//   PATCH /api/papers/:id/results   score／error_types／response／note 四個可選鍵
//   GET   /api/papers/:id            questions[] 多帶科目、章節、答案、詳解與批改細節
//   GET   /api/students/:id/weakness by_error_type、recent_wrong 的 error_types／score
//   GET   /api/error-types           錯因白名單（跟著 FEATURE_STUDENTS）
//
// 純文字單測（test/unit/gradingDetail.test.js）看不到的都在這裡：jsonb_to_recordset 的
// 型別、CASE 讀的是舊值、全有全無的 ROLLBACK、錯因分布的分母與排序、NUMERIC 回來是不是數字。
//
// 三道防線與 students.pg.test.js 相同：只讀 TEST_DATABASE_URL、庫名須 _test 結尾、
// 在 require config/db 之前覆寫 DATABASE_URL。每個案例前 TRUNCATE … RESTART IDENTITY。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('批改細節整合測試（需要 PostgreSQL）', {
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

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /** routes/index.js 在 require 當下讀旗標：清掉 app 與 routes 的快取再讀一次（同 students.pg.test.js）。 */
    function loadApp(featureStudents) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_STUDENTS;
        process.env.FEATURE_STUDENTS = featureStudents;
        try {
            return require(APP_PATH);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_STUDENTS;
            else process.env.FEATURE_STUDENTS = saved;
        }
    }
    const appDisabled = loadApp('false');
    const app = loadApp('true');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    // 〔retrain PR-1〕attempts 是唯讀檢視（migrations/0016）：夾具寫派題＋作答走 helper，
    // 直接改批改細節的夾具改寫 attempt_records（經 assignments 對應卷與題）。斷言照舊讀 attempts。
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const { ERROR_TYPES } = require(path.join(APP_DIR, 'config', 'errorTypes'));

    // ─────────────────── 灌資料輔助 ───────────────────

    /**
     * 灌題（自製題幹）。subject 可以是化學：0011 起 DB CHECK 已放行，
     * 章節白名單由 controller 驗證，這裡直接 INSERT 不經過它。
     * @returns {Promise<number[]>}
     */
    async function seedQuestions(specs) {
        const ids = [];
        for (const [i, s] of specs.entries()) {
            const { rows } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                        solution_text, solution_src)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [s.subject || '數學', s.chapter || '向量內積', s.type || '計算', s.difficulty || 3,
                    `自製批改測試題 ${i}（${s.subject || '數學'}）：求 $x$。`, s.answer || `答案 ${i}`,
                    s.solution || null, s.solution ? 'verify' : null]
            );
            ids.push(rows[0].id);
        }
        return ids;
    }

    async function seedStudent(name = '批改測試生') {
        const { rows } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id', [name]);
        return rows[0].id;
    }

    /** 建卷並寫好未批改的 attempts（offsetDays 可逐題指定）。 */
    async function seedPaper(studentId, ids, offsets = []) {
        const { rows: [p] } = await query(
            'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
            ['批改細節測試卷', studentId, ids]);
        await insertAttempts(query, ids.map((q, i) => ({
            student_id: studentId, question_id: q, paper_id: p.id, days_ago: offsets[i] ?? 0
        })));
        return p.id;
    }

    const patch = (paperId, results) => request(app).patch(`/api/papers/${paperId}/results`).send({ results });

    async function attemptRows(paperId) {
        const { rows } = await query(
            `SELECT question_id, result, score::float8 AS score, error_types, response, teacher_note, graded_at
               FROM attempts WHERE paper_id = $1 ORDER BY question_id`, [paperId]);
        return rows;
    }

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('批改細節 × PostgreSQL（interfaces-stage5.md 第 4.1 條第 1～3 項）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });

        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });

        after(async () => {
            await pool.end();
        });

        // ───────── GET /api/error-types ─────────

        describe('GET /api/error-types', () => {
            test('回十個錯因與每題上限；與 config/errorTypes.js 逐字相同', async () => {
                const res = await request(app).get('/api/error-types');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { items: JSON.parse(JSON.stringify(ERROR_TYPES)), max_per_attempt: 5 });
                assert.equal(res.body.items.length, 10);
            });

            test('FEATURE_STUDENTS 關閉時不掛載，落到 Express 預設 404', async () => {
                const res = await request(appDisabled).get('/api/error-types');
                assert.equal(res.status, 404);
                assert.equal(res.body.message, undefined, '不該回我們自己的 { message }');
            });
        });

        // ───────── GET /api/papers/:id ─────────

        describe('GET /api/papers/:id 的新欄位（第 2 項）', () => {
            test('questions[] 多帶 subject、chapter、answer_text、solution_text 與四個批改細節；型別正確', async () => {
                const ids = await seedQuestions([
                    { subject: '數學', answer: '$5$', solution: '由畢氏定理得 5' },
                    { subject: '物理', chapter: '靜電學', type: '填空', answer: '3 N' }
                ]);
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids);
                await query(
                    `UPDATE attempt_records r SET result = 0, graded_at = now(), score = 0.25, error_types = '{calc,blank}',
                                                  response = '4', teacher_note = '少開根號'
                       FROM assignments s
                      WHERE s.id = r.assignment_id AND s.paper_id = $1 AND s.question_id = $2`, [paperId, ids[0]]);

                const res = await request(app).get(`/api/papers/${paperId}`);
                assert.equal(res.status, 200);
                const [a, b] = res.body.questions;
                assert.deepEqual(
                    { subject: a.subject, chapter: a.chapter, answer_text: a.answer_text, solution_text: a.solution_text,
                        solution_src: a.solution_src, score: a.score, error_types: a.error_types, response: a.response, teacher_note: a.teacher_note },
                    { subject: '數學', chapter: '向量內積', answer_text: '$5$', solution_text: '由畢氏定理得 5',
                        solution_src: 'verify', score: 0.25, error_types: ['calc', 'blank'], response: '4', teacher_note: '少開根號' });
                assert.equal(typeof a.score, 'number', 'NUMERIC 要轉成數字，不是字串 "0.25"');
                assert.deepEqual(
                    { subject: b.subject, solution_text: b.solution_text, score: b.score, error_types: b.error_types, response: b.response, teacher_note: b.teacher_note },
                    { subject: '物理', solution_text: null, score: null, error_types: [], response: null, teacher_note: null });
                // 既有欄位仍在
                for (const q of res.body.questions) {
                    for (const k of ['question_id', 'question_text', 'question_type', 'difficulty', 'result']) assert.ok(k in q, k);
                }
            });

            test('題號在卷上但沒有 attempts 列：error_types 是 [] 不是 null', async () => {
                const ids = await seedQuestions([{}, {}]);
                const sid = await seedStudent();
                const { rows: [p] } = await query(
                    'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                    ['缺 attempts 卷', sid, ids]);
                const { body } = await request(app).get(`/api/papers/${p.id}`);
                assert.deepEqual(body.questions.map(q => [q.result, q.score, q.error_types]), [[null, null, []], [null, null, []]]);
            });
        });

        // ───────── PATCH /api/papers/:id/results ─────────

        describe('PATCH /api/papers/:id/results 的四個可選鍵（第 1 項）', () => {
            async function setup() {
                const ids = await seedQuestions([{}, {}, { type: '填空' }]);
                const sid = await seedStudent();
                return { ids, paperId: await seedPaper(sid, ids), sid };
            }

            test('寫入四個欄位；GET 讀得回來；updated 語意不變', async () => {
                const { ids, paperId } = await setup();
                const res = await patch(paperId, [
                    { question_id: ids[0], result: 0, score: 0.4, error_types: ['blank', 'calc'], response: ' (B) ', note: '粗心' },
                    { question_id: ids[1], result: 1, score: 1 }
                ]);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(res.body, { updated: 2 });

                const rows = await attemptRows(paperId);
                assert.deepEqual(rows.map(r => [r.result, r.score, r.error_types, r.response, r.teacher_note]), [
                    [0, 0.4, ['calc', 'blank'], '(B)', '粗心'],       // 錯因存成白名單順序、答案 trim
                    [1, 1, [], null, null],
                    [null, null, [], null, null]                     // 沒送到的列不動
                ]);
                assert.ok(rows[0].graded_at instanceof Date);
            });

            test('沒送的鍵不動：只改 result 時，score、錯因、答案、註記保留', async () => {
                const { ids, paperId } = await setup();
                await patch(paperId, [{ question_id: ids[0], result: 0, score: 0.5, error_types: ['concept'], response: 'x', note: 'n' }]);
                const res = await patch(paperId, [{ question_id: ids[0], result: 0 }]);
                assert.deepEqual(res.body, { updated: 1 });
                const [r] = await attemptRows(paperId);
                assert.deepEqual([r.result, r.score, r.error_types, r.response, r.teacher_note], [0, 0.5, ['concept'], 'x', 'n']);
            });

            test('送 null 就清空（error_types: null 等於 []；空白字串等於 null）', async () => {
                const { ids, paperId } = await setup();
                await patch(paperId, [{ question_id: ids[0], result: 0, score: 0.5, error_types: ['concept'], response: 'x', note: 'n' }]);
                await patch(paperId, [{ question_id: ids[0], result: 0, score: null, error_types: null, response: '  ', note: null }]);
                const [r] = await attemptRows(paperId);
                assert.deepEqual([r.result, r.score, r.error_types, r.response, r.teacher_note], [0, null, [], null, null]);
            });

            test('錯 → 對：錯因自動清空（沒送 error_types 也一樣），score／答案／註記保留', async () => {
                const { ids, paperId } = await setup();
                await patch(paperId, [{ question_id: ids[0], result: 0, score: 0.5, error_types: ['calc'], response: 'x', note: 'n' }]);
                await patch(paperId, [{ question_id: ids[0], result: 1 }]);
                const [r] = await attemptRows(paperId);
                assert.deepEqual([r.result, r.score, r.error_types, r.response, r.teacher_note], [1, 0.5, [], 'x', 'n'],
                    '答對的題留著錯因，錯因分布就會把對的題算進去');
            });

            test('result: null（取消批改）：score、錯因一併清掉，graded_at 清掉，答案與註記保留', async () => {
                const { ids, paperId } = await setup();
                await patch(paperId, [{ question_id: ids[0], result: 0, score: 0.5, error_types: ['calc'], response: 'x', note: 'n' }]);
                const res = await patch(paperId, [{ question_id: ids[0], result: null }]);
                assert.deepEqual(res.body, { updated: 1 });
                const [r] = await attemptRows(paperId);
                assert.deepEqual([r.result, r.score, r.error_types, r.response, r.teacher_note, r.graded_at],
                    [null, null, [], 'x', 'n', null]);
            });

            test('未作答＝result 0 且錯因含 blank', async () => {
                const { ids, paperId } = await setup();
                const res = await patch(paperId, [{ question_id: ids[2], result: 0, error_types: ['blank'] }]);
                assert.equal(res.status, 200);
                const rows = await attemptRows(paperId);
                assert.deepEqual([rows[2].result, rows[2].error_types], [0, ['blank']]);
            });

            test('驗證失敗一律 400，且整包 ROLLBACK（前面合法的那筆也不寫）', async () => {
                const { ids, paperId } = await setup();
                const cases = [
                    [{ question_id: ids[1], result: null, score: 0.5 }, 'score 只能搭配 result 為 0 或 1。'],
                    [{ question_id: ids[1], result: 1, score: 1.5 }, 'score 必須是 0～1、最多兩位小數的數字，或 null。'],
                    [{ question_id: ids[1], result: 1, score: 0.123 }, 'score 必須是 0～1、最多兩位小數的數字，或 null。'],
                    [{ question_id: ids[1], result: 1, error_types: ['calc'] }, 'error_types 只能在 result 為 0（答錯）時填寫。'],
                    [{ question_id: ids[1], result: 0, error_types: ['nope'] }, 'error_types 含有不在白名單內的代碼：nope。'],
                    [{ question_id: ids[1], result: 0, error_types: ['calc', 'calc'] }, 'error_types 不可重複。'],
                    [{ question_id: ids[1], result: 0, error_types: ['concept', 'method', 'calc', 'reading', 'unit', 'time'] }, 'error_types 最多 5 個。'],
                    [{ question_id: ids[1], result: 0, error_types: 'calc' }, 'error_types 必須是陣列或 null。'],
                    [{ question_id: ids[1], result: 0, response: 'x'.repeat(501) }, 'response 必須是字串或 null，且不得超過 500 字。'],
                    [{ question_id: ids[1], result: 0, note: 42 }, 'note 必須是字串或 null，且不得超過 500 字。']
                ];
                for (const [bad, message] of cases) {
                    const res = await patch(paperId, [{ question_id: ids[0], result: 1, note: '合法的那一筆' }, bad]);
                    assert.equal(res.status, 400, JSON.stringify(bad));
                    assert.deepEqual(res.body, { message });
                }
                const rows = await attemptRows(paperId);
                assert.ok(rows.every(r => r.result === null && r.teacher_note === null && r.graded_at === null),
                    '400 時前面那筆合法的也不得被寫進去');
            });

            test('chem_equation 標在數學題 → 400 並 ROLLBACK；標在化學題 → 200', async () => {
                const ids = await seedQuestions([{ subject: '數學' }, { subject: '化學', chapter: '化學計量', type: '填空' }]);
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids);

                const bad = await patch(paperId, [
                    { question_id: ids[1], result: 0, error_types: ['chem_equation'] },
                    { question_id: ids[0], result: 0, error_types: ['calc', 'chem_equation'] }
                ]);
                assert.equal(bad.status, 400);
                assert.deepEqual(bad.body, { message: `題目 ${ids[0]} 是數學題，不能標記「化學式或係數」（chem_equation）。` });
                assert.ok((await attemptRows(paperId)).every(r => r.result === null), 'ROLLBACK：化學題那筆也不得寫入');

                const ok = await patch(paperId, [{ question_id: ids[1], result: 0, error_types: ['chem_equation', 'calc'] }]);
                assert.equal(ok.status, 200, JSON.stringify(ok.body));
                const rows = await attemptRows(paperId);
                assert.deepEqual(rows.find(r => r.question_id === ids[1]).error_types, ['calc', 'chem_equation']);
            });

            test('既有檢查仍然先於科目檢查：不在卷上的題號回既有訊息', async () => {
                const { ids, paperId } = await setup();
                const [outsider] = await seedQuestions([{}]);
                const res = await patch(paperId, [
                    { question_id: ids[0], result: 0, error_types: ['chem_equation'] },
                    { question_id: outsider, result: 0 }
                ]);
                assert.deepEqual(res.body, { message: `題目 ${outsider} 不在這張試卷內。` });
            });

            test('100 筆全帶細節也能一句 UPDATE 寫完', async () => {
                const ids = await seedQuestions(Array.from({ length: 100 }, () => ({})));
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids);
                const res = await patch(paperId, ids.map((id, i) => ({
                    question_id: id, result: i % 2, score: i % 2 === 0 ? 0.5 : null,
                    error_types: i % 2 === 0 ? ['calc'] : [], note: `第 ${i} 題`
                })));
                assert.deepEqual(res.body, { updated: 100 });
                const { rows } = await query(
                    `SELECT COUNT(*) FILTER (WHERE error_types = '{calc}')::int AS tagged,
                            COUNT(*) FILTER (WHERE teacher_note IS NOT NULL)::int AS noted
                       FROM attempts WHERE paper_id = $1`, [paperId]);
                assert.deepEqual(rows[0], { tagged: 50, noted: 100 });
            });
        });

        // ───────── weakness：by_error_type 與 recent_wrong ─────────

        describe('GET /api/students/:id/weakness 的錯因分布（第 3 項）', () => {
            /**
             * 8 題：6 題數學、2 題物理；offset 1 天，其中一題 200 天前（時間窗外）。
             * 數學錯 5 題：calc×3、concept×2、blank×1、1 題沒標；物理錯 1 題：unit。
             */
            async function seedDistribution() {
                const ids = await seedQuestions([
                    {}, {}, {}, {}, {}, {},
                    { subject: '物理', chapter: '靜電學' }, { subject: '物理', chapter: '靜電學' }
                ]);
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids, [1, 1, 1, 1, 1, 200, 1, 1]);
                const res = await patch(paperId, [
                    { question_id: ids[0], result: 0, error_types: ['calc', 'concept'], score: 0.3 },
                    { question_id: ids[1], result: 0, error_types: ['calc'] },
                    { question_id: ids[2], result: 0, error_types: ['concept', 'blank'] },
                    { question_id: ids[3], result: 0 },                                  // 錯但沒標錯因：仍算進分母
                    { question_id: ids[4], result: 1 },
                    { question_id: ids[5], result: 0, error_types: ['calc'] },           // 200 天前：時間窗外
                    { question_id: ids[6], result: 0, error_types: ['unit'] },
                    { question_id: ids[7], result: 1 }
                ]);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                return { sid, ids };
            }

            test('count、share（分母＝窗內錯題數）、標籤與排序 count DESC、error_type ASC', async () => {
                const { sid } = await seedDistribution();
                const res = await request(app).get(`/api/students/${sid}/weakness?days=90`);
                assert.equal(res.status, 200);
                // 窗內錯題 5 題（數學 4、物理 1）
                assert.deepEqual(res.body.by_error_type, [
                    { error_type: 'calc', label: '計算錯誤', count: 2, share: 0.4 },
                    { error_type: 'concept', label: '觀念不清', count: 2, share: 0.4 },
                    { error_type: 'blank', label: '未作答', count: 1, share: 0.2 },
                    { error_type: 'unit', label: '單位或有效數字', count: 1, share: 0.2 }
                ]);
                // 型別：count 是整數（COUNT 的 INT8 已由 config/db 轉數字）、share 是數字
                for (const r of res.body.by_error_type) {
                    assert.ok(Number.isInteger(r.count));
                    assert.equal(typeof r.share, 'number');
                }
            });

            test('科目篩選與時間窗沿用既有規則', async () => {
                const { sid } = await seedDistribution();
                const math = await request(app).get(`/api/students/${sid}/weakness?subject=${encodeURIComponent('數學')}&days=90`);
                // 窗內數學錯題 4 題
                assert.deepEqual(math.body.by_error_type.map(r => [r.error_type, r.count, r.share]),
                    [['calc', 2, 0.5], ['concept', 2, 0.5], ['blank', 1, 0.25]]);
                const all = await request(app).get(`/api/students/${sid}/weakness?days=365`);
                // 拉長到 365 天：200 天前那題進來，錯題 6 題、calc 3 題
                assert.deepEqual(all.body.by_error_type[0], { error_type: 'calc', label: '計算錯誤', count: 3, share: 0.5 });
            });

            test('share 四捨五入到小數第 4 位', async () => {
                const ids = await seedQuestions([{}, {}, {}]);
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids);
                await patch(paperId, ids.map((id, i) => ({ question_id: id, result: 0, error_types: i === 0 ? ['calc'] : [] })));
                const { body } = await request(app).get(`/api/students/${sid}/weakness?days=30`);
                assert.deepEqual(body.by_error_type, [{ error_type: 'calc', label: '計算錯誤', count: 1, share: 0.3333 }]);
            });

            test('只看答錯的列：直接寫進 DB 的「答對卻有錯因」不算', async () => {
                const ids = await seedQuestions([{}, {}]);
                const sid = await seedStudent();
                const paperId = await seedPaper(sid, ids);
                await query(`UPDATE attempt_records r SET result = 1, graded_at = now(), error_types = '{calc}'
                               FROM assignments s WHERE s.id = r.assignment_id AND s.question_id = $1`, [ids[0]]);
                await query(`UPDATE attempt_records r SET result = 0, graded_at = now(), error_types = '{reading}'
                               FROM assignments s WHERE s.id = r.assignment_id AND s.question_id = $1`, [ids[1]]);
                const { body } = await request(app).get(`/api/students/${sid}/weakness`);
                assert.deepEqual(body.by_error_type, [{ error_type: 'reading', label: '審題錯誤', count: 1, share: 1 }]);
                // 同一張卷的明細照樣讀得到那筆（弱點面板只是不把它算進錯因分布）
                const detail = await request(app).get(`/api/papers/${paperId}`);
                assert.deepEqual(detail.body.questions[0].error_types, ['calc']);
            });

            test('沒有錯題 → 空陣列；不認得的代碼 label 為 null', async () => {
                const ids = await seedQuestions([{}]);
                const sid = await seedStudent();
                await seedPaper(sid, ids);
                const empty = await request(app).get(`/api/students/${sid}/weakness`);
                assert.deepEqual(empty.body.by_error_type, []);

                await query(`UPDATE attempt_records SET result = 0, graded_at = now(), error_types = '{legacy_code}'`);
                const { body } = await request(app).get(`/api/students/${sid}/weakness`);
                assert.deepEqual(body.by_error_type, [{ error_type: 'legacy_code', label: null, count: 1, share: 1 }]);
            });

            test('recent_wrong 每列多 error_types 與 score；既有四欄不變', async () => {
                const { sid, ids } = await seedDistribution();
                const { body } = await request(app).get(`/api/students/${sid}/weakness?days=90`);
                const byId = new Map(body.recent_wrong.map(r => [r.question_id, r]));
                assert.equal(body.recent_wrong.length, 5, '窗內 5 題錯題');
                assert.deepEqual([byId.get(ids[0]).error_types, byId.get(ids[0]).score], [['concept', 'calc'], 0.3], '存成白名單順序');
                assert.deepEqual([byId.get(ids[3]).error_types, byId.get(ids[3]).score], [[], null]);
                assert.deepEqual(Object.keys(body.recent_wrong[0]),
                    ['question_id', 'chapter', 'question_text', 'assigned_at', 'error_types', 'score']);
            });

            test('頂層鍵：既有五個照原順序，by_error_type 接在最後', async () => {
                const { sid } = await seedDistribution();
                const { body } = await request(app).get(`/api/students/${sid}/weakness`);
                assert.deepEqual(Object.keys(body),
                    ['by_chapter', 'by_type', 'by_difficulty', 'trend_weekly', 'recent_wrong', 'by_error_type']);
            });

            test('錯因分布查詢在真資料庫上跑得起來，且不排除已封存題', async () => {
                const { sid } = await seedDistribution();
                const before = await request(app).get(`/api/students/${sid}/weakness?days=90`);
                await query('UPDATE questions SET archived_at = now()');
                const afterRes = await request(app).get(`/api/students/${sid}/weakness?days=90`);
                assert.deepEqual(afterRes.body.by_error_type, before.body.by_error_type);
            });
        });
    });
}
