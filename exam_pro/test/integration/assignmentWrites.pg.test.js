// ─────────────────────────────────────────────────────────────
// test/integration/assignmentWrites.pg.test.js — 派題與作答拆表之後的寫入路徑（〔retrain PR-1〕）
//
// docs/retrain-and-review.md 第 2.5、3.5、3.9 節；第 6.2 節 ACPT-036-2～4。
// 資料層已經允許「同一題以重練派題再出給同一位學生、每次作答各自記錄」（DEC-003 例外條款）；
// 但第一階段還沒有任何 API 會寫重練派題（排程項目與出卷整合是第二、三階段），
// 所以本檔的重練派題一律用 test/helpers/attempts.js 直接寫進 assignments（purpose = 'retrain'）。
//
// 驗什麼（全部經由既有 API，回應形狀與拆表前相同）：
//   1. 出卷（confirm-paper／generate-paper）：先寫派題、再替每一筆派題建一筆空白作答；重複派新題照舊 409、不留半張卷。
//   2. 新題組卷仍排除已作答：同一題就算已經有重練派題與多次作答，新題候選池照樣排除它、新題閘門照樣擋。
//   3. 批改（PATCH）寫的是那張卷上那一筆派題的作答：重練卷的批改不會蓋掉第一次的紀錄；
//      試卷明細、試卷列表、學生清單、助教的 list_students 是卷層數字（讀全部派題）。
//   4. 刪卷、刪學生、合併學生、刪題對新表的影響（第 3.9 節）。
//   5. 相容檢視是唯讀的：寫錯地方會立刻報錯，不會靜默。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('派題與作答拆表的寫入路徑（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
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
    // 試卷明細與批改掛在 FEATURE_STUDENTS 區塊；FEATURE_RETRAIN 不設（預設關）——第一階段的一切都不看它
    delete require.cache[require.resolve(APP_PATH)];
    delete require.cache[require.resolve(ROUTES_PATH)];
    const savedStudents = process.env.FEATURE_STUDENTS;
    process.env.FEATURE_STUDENTS = 'true';
    const app = require(APP_PATH);
    if (savedStudents === undefined) delete process.env.FEATURE_STUDENTS; else process.env.FEATURE_STUDENTS = savedStudents;

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const { TOOLS } = require(path.join(APP_DIR, 'services', 'assistantService'));

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';

    async function seedQuestions(n, { chapter = CHAPTER } = {}) {
        const idx = Array.from({ length: n }, (_, i) => i);
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             SELECT $1, $2, '計算', 3, '拆表寫入測試題 ' || $2 || ' ' || x || '：求 $a$。', '答 ' || x
               FROM unnest($3::int[]) AS x RETURNING id`,
            [SUBJECT, chapter, idx]);
        return rows.map(r => r.id).sort((a, b) => a - b);
    }

    async function createStudent(name) {
        const res = await request(app).post('/api/students').send({ name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    }

    /** 走正式的 confirm-paper（examController.writePaper）出一張新題卷。 */
    async function confirmPaper(studentId, questionIds) {
        const res = await request(app).post('/api/confirm-paper').send({ student_id: studentId, question_ids: questionIds });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.paper_id;
    }

    /**
     * 資料層直接寫一張「重練卷」：exam_papers 一列＋每題一筆 purpose = 'retrain' 的派題與空白作答。
     * 第一階段沒有 API 會寫重練派題（出卷整合是第三階段），這裡模擬的是之後 confirm-paper 會寫出的形狀。
     */
    async function retrainPaper(studentId, questionIds, title = '錯題重練卷') {
        const { rows: [p] } = await query(
            'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
            [title, studentId, questionIds]);
        await insertAttempts(query, questionIds.map(q => ({
            student_id: studentId, question_id: q, paper_id: p.id, purpose: 'retrain'
        })));
        return p.id;
    }

    const patch = (paperId, results) => request(app).patch(`/api/papers/${paperId}/results`).send({ results });

    async function counts() {
        const { rows: [c] } = await query(
            `SELECT (SELECT COUNT(*) FROM exam_papers)::int AS papers,
                    (SELECT COUNT(*) FROM assignments)::int AS assignments,
                    (SELECT COUNT(*) FROM attempt_records)::int AS records,
                    (SELECT COUNT(*) FROM attempts)::int AS first_exposures`);
        return c;
    }

    /** 某生某題的全部派題與作答（依派題 id）。 */
    async function history(studentId, questionId) {
        const { rows } = await query(
            `SELECT paper_id, purpose, result, error_types FROM assignment_attempts
              WHERE student_id = $1 AND question_id = $2 ORDER BY assignment_id`, [studentId, questionId]);
        return rows;
    }

    describe('派題與作答拆表之後的寫入路徑', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });
        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });
        after(async () => { await pool.end(); });

        test('出卷：先寫派題、作答掛在派題下；回應形狀不變；重複派新題 409 且不留半張卷', async () => {
            const ids = await seedQuestions(6);
            const sid = await createStudent('拆表出卷生');

            const res = await request(app).post('/api/confirm-paper').send({ student_id: sid, question_ids: ids.slice(0, 3) });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body).sort(), ['message', 'paper_id', 'paper_title', 'question_ids', 'questions']);
            assert.equal(res.body.message, '出卷完成！已記錄作答歷史，避免下次重複。');

            const { rows: asg } = await query(
                `SELECT s.id, s.student_id, s.question_id, s.paper_id, s.purpose, s.assigned_at,
                        r.id AS record_id, r.result, r.graded_at, r.score, r.error_types, r.response, r.teacher_note
                   FROM assignments s LEFT JOIN attempt_records r ON r.assignment_id = s.id ORDER BY s.question_id`);
            assert.equal(asg.length, 3);
            // 派題日＝出卷當天（writePaper 用本地時區的日期，同 examController 的 localDates）
            const d = new Date();
            const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            for (const [i, a] of asg.entries()) {
                assert.deepEqual(
                    [a.student_id, a.question_id, a.paper_id, a.purpose, a.assigned_at],
                    [sid, ids[i], res.body.paper_id, 'new', today]);
                assert.ok(a.record_id !== null, '每一筆派題都要有一筆作答');
                assert.deepEqual([a.result, a.graded_at, a.score, a.error_types, a.response, a.teacher_note],
                    [null, null, null, [], null, null], '新派的題是空白作答（未批改）');
            }
            // 相容檢視：每生每題一列、id＝派題 id
            const { rows: view } = await query('SELECT id, assignment_id, question_id FROM attempts ORDER BY question_id');
            assert.deepEqual(view.map(v => v.question_id), ids.slice(0, 3));
            assert.ok(view.every(v => v.id === v.assignment_id));

            // generate-paper（非 dry_run）走同一個 writePaper：只剩另外三題可抽
            const gen = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(gen.status, 200, JSON.stringify(gen.body));
            assert.deepEqual([...gen.body.question_ids].sort((a, b) => a - b), ids.slice(3));
            assert.deepEqual(await counts(), { papers: 2, assignments: 6, records: 6, first_exposures: 6 });

            // 同一批題再確認一次 ⇒ 新題閘門擋下、409 訊息不變、整筆回滾
            const again = await request(app).post('/api/confirm-paper').send({ student_id: sid, question_ids: ids.slice(0, 2) });
            assert.equal(again.status, 409);
            assert.equal(again.body.message, '部分題目已被指派給該學生（可能是預覽已過期），請重新預覽。');
            assert.deepEqual(await counts(), { papers: 2, assignments: 6, records: 6, first_exposures: 6 });
        });

        test('新題組卷仍排除已作答：同一題已有重練派題與多次作答，候選池照樣排除、新題閘門照樣擋', async () => {
            const [q1, q2, q3, q4] = await seedQuestions(4);
            const a = await createStudent('重練甲');
            const b = await createStudent('對照乙');
            const p1 = await confirmPaper(a, [q1, q2]);
            assert.equal((await patch(p1, [{ question_id: q1, result: 0, error_types: ['calc'] }])).status, 200);
            // 同一題再出兩次（資料層允許：部分唯一索引只管新題）
            await retrainPaper(a, [q1], '重練卷一');
            await retrainPaper(a, [q1], '重練卷二');
            assert.deepEqual((await history(a, q1)).map(h => h.purpose), ['new', 'retrain', 'retrain']);

            // 新題草稿只抽得到沒寫過的 q3、q4；要 3 題就是庫存不足
            const draft = await request(app).post('/api/generate-paper')
                .send({ student_id: a, subject: SUBJECT, chapter: CHAPTER, count: 2, dry_run: true });
            assert.equal(draft.status, 200, JSON.stringify(draft.body));
            assert.deepEqual([...draft.body.question_ids].sort((x, y) => x - y), [q3, q4]);
            const short = await request(app).post('/api/generate-paper')
                .send({ student_id: a, subject: SUBJECT, chapter: CHAPTER, count: 3, dry_run: true });
            assert.equal(short.status, 400);
            assert.equal(short.body.message, `新題目庫存不足！該章節 [重練甲] 沒寫過的題目僅剩 2 題。`);

            // 以新題身分再派 q1 → 硬閘門擋下（409），一筆都不寫
            const before = await counts();
            const dup = await request(app).post('/api/confirm-paper').send({ student_id: a, question_ids: [q1, q3] });
            assert.equal(dup.status, 409);
            assert.deepEqual(await counts(), before);

            // 別的學生照樣抽得到 q1
            const other = await request(app).post('/api/generate-paper')
                .send({ student_id: b, subject: SUBJECT, chapter: CHAPTER, count: 4, dry_run: true });
            assert.equal(other.status, 200);
            assert.ok(other.body.question_ids.includes(q1));
        });

        test('批改：重練卷的作答各自一列，不會蓋掉第一次的紀錄；卷層數字讀全部派題；回應形狀不變', async () => {
            const [q1, q2] = await seedQuestions(2);
            const a = await createStudent('批改重練生');
            const p1 = await confirmPaper(a, [q1, q2]);
            const graded = await patch(p1, [{ question_id: q1, result: 0, error_types: ['calc'], response: '4' }]);
            assert.deepEqual(graded.body, { updated: 1 });
            const r1 = await retrainPaper(a, [q1], '重練卷一');
            const r2 = await retrainPaper(a, [q1], '重練卷二');

            // 批改重練卷一：只動那一筆派題的作答
            const res = await patch(r1, [{ question_id: q1, result: 1, response: '5' }]);
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { updated: 1 });
            assert.deepEqual((await history(a, q1)).map(h => [h.paper_id, h.purpose, h.result, h.error_types]), [
                [p1, 'new', 0, ['calc']],
                [r1, 'retrain', 1, []],
                [r2, 'retrain', null, []]
            ]);
            // 相容檢視 attempts 只含新題派題（每生每題一列＝拆表前的語意），內容是第一次的那筆
            const { rows: first } = await query(
                'SELECT paper_id, result, error_types, response FROM attempts WHERE student_id = $1 AND question_id = $2', [a, q1]);
            assert.deepEqual(first, [{ paper_id: p1, result: 0, error_types: ['calc'], response: '4' }]);

            // 試卷明細：各卷讀各卷的那一筆；回應的鍵與一般卷相同（第一階段不多帶任何欄位）
            const d1 = await request(app).get(`/api/papers/${p1}`);
            const dr = await request(app).get(`/api/papers/${r1}`);
            assert.equal(dr.status, 200);
            assert.deepEqual(Object.keys(dr.body).sort(), Object.keys(d1.body).sort());
            assert.deepEqual(Object.keys(dr.body.questions[0]).sort(), Object.keys(d1.body.questions[0]).sort());
            assert.deepEqual([dr.body.questions[0].result, dr.body.questions[0].response], [1, '5']);
            const q1OnP1 = d1.body.questions.find(q => q.question_id === q1);
            assert.deepEqual([q1OnP1.result, q1OnP1.error_types, q1OnP1.response], [0, ['calc'], '4']);

            // 取消批改重練卷一：graded_at 一起清掉，第一次的紀錄不動
            await patch(r1, [{ question_id: q1, result: null }]);
            assert.deepEqual((await history(a, q1)).map(h => h.result), [0, null, null]);
            await patch(r1, [{ question_id: q1, result: 1 }]);

            // 不在卷上的題 → 400，全有全無（重練卷一的那筆不變）
            const stray = await patch(r1, [{ question_id: q1, result: 0 }, { question_id: q2, result: 0 }]);
            assert.equal(stray.status, 400);
            assert.equal(stray.body.message, `題目 ${q2} 不在這張試卷內。`);
            assert.deepEqual((await history(a, q1)).map(h => h.result), [0, 1, null]);

            // 卷層數字：試卷列表的已批改數、學生清單的批改完成率、助教的 list_students 都算這張卷／這位學生的全部派題
            const papers = await request(app).get(`/api/students/${a}/papers`);
            const byId = new Map(papers.body.items.map(p => [p.paper_id, [p.graded, p.total]]));
            assert.deepEqual([byId.get(p1), byId.get(r1), byId.get(r2)], [[1, 2], [1, 1], [0, 1]]);
            const list = await request(app).get('/api/students');
            const me = list.body.items.find(s => s.id === a);
            assert.equal(me.graded_ratio, 0.5, '四筆派題批了兩筆');
            const tool = await TOOLS.list_students.run();
            const t = tool.students.find(s => s.id === a);
            assert.deepEqual([t.papers, t.graded, t.attempts], [3, 2, 4]);
        });

        test('刪卷：沒有重練時照舊；原卷的題已在重練中 → 409，先刪重練卷才能刪原卷（第 3.9 節）', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const a = await createStudent('刪卷重練生');
            const p1 = await confirmPaper(a, [q1, q2]);
            const p2 = await confirmPaper(a, [q3]);
            const r1 = await retrainPaper(a, [q1], '重練卷一');
            const r2 = await retrainPaper(a, [q1], '重練卷二');
            await patch(r1, [{ question_id: q1, result: 1 }]);

            // 沒有重練的卷：照舊刪派題與作答，題目回到候選池
            const d2 = await request(app).delete(`/api/papers/${p2}`);
            assert.deepEqual([d2.status, d2.body], [200, { deleted_attempts: 1 }]);
            const { rows: [z] } = await query(
                `SELECT COUNT(*)::int AS n FROM assignments WHERE question_id = $1`, [q3]);
            assert.equal(z.n, 0);

            // 原卷上的 q1 已有兩張重練卷 → 409，列出重練卷，一筆都不刪
            const before = await counts();
            const blocked = await request(app).delete(`/api/papers/${p1}`);
            assert.equal(blocked.status, 409);
            assert.deepEqual(blocked.body, {
                message: `這張卷有 1 題已經在錯題重練中（重練卷 #${r1}、#${r2}），請先刪除那些重練卷。`,
                question_ids: [q1],
                retrain_paper_ids: [r1, r2]
            });
            assert.deepEqual(await counts(), before);

            // 刪重練卷：只刪那一筆重練派題與它的作答（已批改的那次重練紀錄一起消失）
            const dr1 = await request(app).delete(`/api/papers/${r1}`);
            assert.deepEqual([dr1.status, dr1.body], [200, { deleted_attempts: 1 }]);
            assert.deepEqual((await history(a, q1)).map(h => [h.paper_id, h.purpose]), [[p1, 'new'], [r2, 'retrain']]);
            const stillBlocked = await request(app).delete(`/api/papers/${p1}`);
            assert.equal(stillBlocked.status, 409);
            assert.equal(stillBlocked.body.message, `這張卷有 1 題已經在錯題重練中（重練卷 #${r2}），請先刪除那些重練卷。`);
            assert.equal((await request(app).delete(`/api/papers/${r2}`)).status, 200);

            // 重練卷都刪完 → 原卷照舊可刪，題目回到候選池
            const d1 = await request(app).delete(`/api/papers/${p1}`);
            assert.deepEqual([d1.status, d1.body], [200, { deleted_attempts: 2 }]);
            assert.deepEqual(await counts(), { papers: 0, assignments: 0, records: 0, first_exposures: 0 });
            const draft = await request(app).post('/api/generate-paper')
                .send({ student_id: a, subject: SUBJECT, chapter: CHAPTER, count: 3, dry_run: true });
            assert.equal(draft.status, 200);
            assert.deepEqual([...draft.body.question_ids].sort((x, y) => x - y), [q1, q2, q3]);

            // 不存在的卷照舊 404
            const gone = await request(app).delete(`/api/papers/${p1}`);
            assert.deepEqual([gone.status, gone.body], [404, { message: '找不到該試卷' }]);
        });

        test('刪學生：新題與重練派題、作答一起刪；deleted.attempts 是派題筆數（第 3.9 節）', async () => {
            const [q1, q2] = await seedQuestions(2);
            const a = await createStudent('刪學生重練生');
            const b = await createStudent('刪學生對照生');
            await confirmPaper(a, [q1, q2]);
            await retrainPaper(a, [q1]);
            await confirmPaper(b, [q1]);

            const del = await request(app).delete(`/api/students/${a}`);
            assert.equal(del.status, 200);
            assert.deepEqual(del.body, { deleted: { attempts: 3, papers: 2 } });
            const { rows } = await query('SELECT student_id, question_id, purpose FROM assignment_attempts ORDER BY assignment_id');
            assert.deepEqual(rows, [{ student_id: b, question_id: q1, purpose: 'new' }], '只剩對照生的紀錄');
            assert.deepEqual(await counts(), { papers: 1, assignments: 1, records: 1, first_exposures: 1 });
        });

        test('合併學生：衝突看新題派題；衝突題在來源側的新題與重練一起刪，其餘（含重練）搬到目標（第 3.9 節）', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const from = await createStudent('分身（重練）');
            const into = await createStudent('本尊（重練）');
            const pf = await confirmPaper(from, [q1, q2, q3]);
            await patch(pf, [{ question_id: q1, result: 0 }, { question_id: q3, result: 0 }]);
            const rf = await retrainPaper(from, [q1, q3]);
            await patch(rf, [{ question_id: q3, result: 1 }]);
            const pt = await confirmPaper(into, [q1]);
            await patch(pt, [{ question_id: q1, result: 1 }]);

            const res = await request(app).post(`/api/students/${from}/merge`).send({ into_id: into });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            // q1 衝突：來源側的新題與重練兩筆一起刪；q2 新題、q3 新題＋重練三筆搬家；兩張卷搬家
            assert.deepEqual(res.body, { moved_attempts: 3, dropped_conflicts: 2, moved_papers: 2 });

            assert.deepEqual((await history(into, q1)).map(h => [h.paper_id, h.purpose, h.result]), [[pt, 'new', 1]],
                'q1 只留目標側的紀錄');
            assert.deepEqual((await history(into, q2)).map(h => [h.paper_id, h.purpose, h.result]), [[pf, 'new', null]]);
            assert.deepEqual((await history(into, q3)).map(h => [h.paper_id, h.purpose, h.result]),
                [[pf, 'new', 0], [rf, 'retrain', 1]], 'q3 的第一次與重練都搬到目標');
            const { rows: first } = await query(
                'SELECT question_id FROM attempts WHERE student_id = $1 ORDER BY question_id', [into]);
            assert.deepEqual(first.map(r => r.question_id), [q1, q2, q3], '相容檢視照舊每生每題一列');
            assert.deepEqual(await counts(), { papers: 3, assignments: 4, records: 4, first_exposures: 3 });
            const { rows: gone } = await query('SELECT COUNT(*)::int AS n FROM students WHERE id = $1', [from]);
            assert.equal(gone[0].n, 0);
        });

        test('刪題：有任何派題（含重練）就只能封存；沒有派題照舊硬刪（第 3.9 節）', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const a = await createStudent('刪題重練生');
            await confirmPaper(a, [q1, q2]);
            await retrainPaper(a, [q1, q2]);

            const soft = await request(app).delete(`/api/questions/${q1}`);
            assert.equal(soft.status, 200);
            assert.equal(soft.body.archived, true);
            const group = await request(app).delete(`/api/questions/${q2}?group=1`);
            assert.equal(group.status, 200);
            assert.equal(group.body.archived, true);
            const { rows } = await query(
                `SELECT q.id, q.archived_at IS NOT NULL AS archived,
                        (SELECT COUNT(*)::int FROM assignments s WHERE s.question_id = q.id) AS n
                   FROM questions q WHERE q.id = ANY($1::int[]) ORDER BY q.id`, [[q1, q2]]);
            assert.deepEqual(rows.map(r => [r.id, r.archived, r.n]), [[q1, true, 2], [q2, true, 2]],
                '封存不刪列，派題與作答都留著');

            const hard = await request(app).delete(`/api/questions/${q3}`);
            assert.equal(hard.status, 200);
            assert.equal(hard.body.archived, undefined);
            const { rows: left } = await query('SELECT COUNT(*)::int AS n FROM questions WHERE id = $1', [q3]);
            assert.equal(left[0].n, 0);

            // 資料庫這一層：題目被派題以 RESTRICT 參照，直接刪會被擋
            await assert.rejects(query('DELETE FROM questions WHERE id = $1', [q1]), /foreign key/i);
        });

        test('相容檢視是唯讀的：對 attempts／assignment_attempts 寫入會立刻報錯（不會靜默）', async () => {
            const [q1] = await seedQuestions(1);
            const a = await createStudent('唯讀檢視生');
            await confirmPaper(a, [q1]);
            for (const view of ['attempts', 'assignment_attempts']) {
                await assert.rejects(query(`INSERT INTO ${view} (student_id, question_id) VALUES ($1, $2)`, [a, q1]),
                    /cannot insert into view/i, view);
                await assert.rejects(query(`UPDATE ${view} SET result = 1`), /cannot update view/i, view);
                await assert.rejects(query(`DELETE FROM ${view}`), /cannot delete from view/i, view);
                await assert.rejects(query(`TRUNCATE ${view}`), /is not a table/i, view);
            }
            assert.deepEqual(await counts(), { papers: 1, assignments: 1, records: 1, first_exposures: 1 });
        });
    });
}
