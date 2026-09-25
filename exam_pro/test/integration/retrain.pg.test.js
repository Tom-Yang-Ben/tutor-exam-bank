// ─────────────────────────────────────────────────────────────
// test/integration/retrain.pg.test.js — 錯題重練第二階段 PR-2（排程核心）的整合測試
//
// docs/retrain-and-review.md 第 3.4、3.9、4.4～4.7、5.2 節；第 6.3 節：
//   TC-037-1  旗標關閉 404、批改帶 retrain 回 400、不建項目；勾「要重練」建項目、答錯沒勾不建、取消勾選
//             （沒重練過刪、重練過移出）、改判成對不刪；手動加入（skipped 原因；R11 舊紀錄照常到期）；
//             移出／判定已會／重新加入；承上組一起進；開啟旗標後清單為空（不補建）
//   TC-037-2  npm run retrain:recompute：--dry-run 不寫、冪等、不建項目、改參數後到期日重排
//   TC-038-3  批改與重算同一交易（PATCH 失敗時項目不變）；逐筆批改、改判、取消批改、刪重練卷之後
//             快取＝對當下歷史直接呼叫純函式（不變量 I7）；已派出不再派；兩個交易同時操作同一項目
//   TC-039-3  （與刪卷、刪學生、合併學生有關的部分）刪原卷被擋 409、刪重練卷後重算、刪學生、合併學生
//   TC-040-1  （API-4 的部分）學生清單的到期數
//
// 重練派題的寫入（出卷整合）是 PR-3；這裡用 PR-2 交付給 PR-3 的 services/retrainService.js 的
// insertRetrainAssignments 在交易內直接寫「重練卷」，形狀與之後 confirm-paper 會寫出的相同。
// 日期一律用本地時區的「今天」（與 writePaper 的派題日同一種算法）；PostgreSQL 的 CURRENT_DATE 在 UTC，
// 夾具不依賴它。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('錯題重練排程核心（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
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

    /** 依旗標載入一份 app（路由在載入當下決定掛不掛）。批改與試卷明細每次請求即時讀旗標，見 withRetrain。 */
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
    const { loadRetrainConfig } = require(path.join(APP_DIR, 'config', 'retrain'));

    const today = retrain.todayLocal();
    const day = n => schedule.addDays(today, n);

    /** 旗標狀態（批改、試卷明細每次請求即時讀 process.env.FEATURE_RETRAIN）。 */
    async function withRetrain(on, fn) {
        const saved = process.env.FEATURE_RETRAIN;
        if (on) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        try { return await fn(on ? appOn : appOff); } finally {
            if (saved === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = saved;
        }
    }

    // ─────────── 夾具 ───────────

    let seq = 0;
    async function seedQuestions(n, { subject = '數學', chapter = '向量內積' } = {}) {
        const out = [];
        for (let i = 0; i < n; i++) {
            seq += 1;
            const { rows: [q] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ($1, $2, '計算', 3, $3, $4) RETURNING id`,
                [subject, chapter, `重練測試題 ${seq}：求 $x$ 的值。`, `答 ${seq}`]);
            out.push(q.id);
        }
        return out;
    }

    /** 一組承上題：ids[0] 是前題，其後每一題承接前一題。 */
    async function seedGroup(n) {
        const ids = await seedQuestions(n);
        for (let i = 1; i < ids.length; i++) {
            await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [ids[i - 1], ids[i]]);
        }
        return ids;
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

    /** 交易內寫一張重練卷（PR-2 交付給 PR-3 的 insertRetrainAssignments）。 */
    async function retrainPaper(studentId, questionIds, assignedAt, title = '錯題重練卷') {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [p] } = await client.query(
                'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                [title, studentId, questionIds]);
            const r = await retrain.insertRetrainAssignments(client, { studentId, paperId: p.id, assignedAt, questionIds });
            if (r.conflict) { await client.query('ROLLBACK'); return { conflict: r.conflict }; }
            await client.query('COMMIT');
            return { paperId: p.id, rows: r.rows };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    const patch = (app, paperId, results) => request(app).patch(`/api/papers/${paperId}/results`).send({ results });

    /** 某生某題的排程項目（日期是字串）。 */
    async function itemOf(studentId, questionId) {
        const { rows } = await query(
            `SELECT id, reason, to_char(entered_on, 'YYYY-MM-DD') AS entered_on, status, step,
                    to_char(due_on, 'YYYY-MM-DD') AS due_on, streak, lapses,
                    to_char(last_attempt_on, 'YYYY-MM-DD') AS last_attempt_on, to_char(mastered_on, 'YYYY-MM-DD') AS mastered_on,
                    teacher_override, to_char(override_on, 'YYYY-MM-DD') AS override_on, note, entered_after_assignment_id
               FROM retrain_items WHERE student_id = $1 AND question_id = $2`, [studentId, questionId]);
        return rows[0] || null;
    }

    async function itemCount(studentId = null) {
        const { rows: [c] } = await query(
            'SELECT COUNT(*)::int AS n FROM retrain_items WHERE $1::int IS NULL OR student_id = $1', [studentId]);
        return c.n;
    }

    /** 不變量 I7：表上的快取＝對當下作答歷史直接呼叫純函式的結果。 */
    async function assertCacheMatchesHistory(studentId, questionId, msg = '') {
        const it = await itemOf(studentId, questionId);
        assert.ok(it, `找不到項目（${questionId}）`);
        const hist = (await retrain.fetchHistories(query, [[studentId, questionId]])).get(`${studentId}:${questionId}`) || [];
        const expect = schedule.computeRetrainState({
            entered_on: it.entered_on, teacher_override: it.teacher_override, override_on: it.override_on,
            entered_after_assignment_id: it.entered_after_assignment_id === null ? null : Number(it.entered_after_assignment_id),
            history: hist
        }, loadRetrainConfig());
        const cache = {
            status: it.status, step: it.step, due_on: it.due_on, streak: it.streak, lapses: it.lapses,
            last_attempt_on: it.last_attempt_on, mastered_on: it.mastered_on
        };
        const fromHistory = {
            status: expect.status, step: expect.step, due_on: expect.due_on, streak: expect.streak, lapses: expect.lapses,
            last_attempt_on: expect.last_attempt_on, mastered_on: expect.mastered_on
        };
        assert.deepEqual(cache, fromHistory, `I7：快取與作答歷史重算不一致 ${msg}`);
        return it;
    }

    const list = (studentId, qs = '') => request(appOn).get(`/api/students/${studentId}/retrain-items${qs}`);
    const act = (studentId, itemId, body) => request(appOn).patch(`/api/students/${studentId}/retrain-items/${itemId}`).send(body);
    const EMPTY = { entered: 0, advanced: 0, mastered: 0, reset: 0 };

    describe('錯題重練排程核心（PR-2）', () => {
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

        // ───────────────────── TC-037-1／ACPT-037-4：旗標 ─────────────────────

        test('旗標關閉：四支 API 不掛載（404）、批改帶 retrain 回 400 且不建項目、既有回應逐字不變；開啟後清單是空的（不補建）', async () => {
            const [q1, q2] = await seedQuestions(2);
            const s = await createStudent('旗標生');
            const p1 = await confirmPaper(s, [q1, q2]);

            await withRetrain(false, async app => {
                for (const [method, url] of [['get', `/api/students/${s}/retrain-items`], ['post', `/api/students/${s}/retrain-items`],
                    ['patch', `/api/students/${s}/retrain-items/1`], ['get', '/api/retrain/summary']]) {
                    const req = request(app)[method](url);
                    const res = method === 'get' ? await req : await req.send({ question_ids: [q1] });
                    assert.equal(res.status, 404, `${method} ${url}`);
                    assert.match(res.text, /Cannot (GET|POST|PATCH)/, 'Express 預設 404（路由沒有掛載）');
                }
                // 帶 retrain（true 或 false 都一樣）→ 400，整筆不寫
                for (const v of [true, false]) {
                    const bad = await patch(app, p1, [{ question_id: q1, result: 0, retrain: v }]);
                    assert.deepEqual([bad.status, bad.body], [400, { message: 'retrain 需要開啟 FEATURE_RETRAIN。' }]);
                }
                const { rows: [r] } = await query('SELECT result FROM attempts WHERE question_id = $1', [q1]);
                assert.equal(r.result, null, '400 時批改也沒寫進去（全有全無）');
                assert.equal(await itemCount(), 0);
                // 沒帶 retrain：回應逐字不變
                const ok = await patch(app, p1, [{ question_id: q1, result: 0 }, { question_id: q2, result: 1 }]);
                assert.deepEqual([ok.status, ok.body], [200, { updated: 2 }]);
                // 試卷明細沒有新鍵
                const d = await request(app).get(`/api/papers/${p1}`);
                assert.equal(d.status, 200);
                for (const q of d.body.questions) {
                    for (const k of ['purpose', 'retrain_step', 'retrain_flagged']) assert.ok(!(k in q), `旗標關閉時不該有 ${k}`);
                }
                assert.deepEqual(Object.keys(d.body.questions[0]), ['question_id', 'question_text', 'question_type', 'difficulty',
                    'result', 'subject', 'chapter', 'answer_text', 'solution_text', 'solution_src', 'score', 'error_types',
                    'response', 'teacher_note']);
            });

            // 開啟旗標：答錯的 q1 不會自動進清單（R1 選 2），也不補建（R11 選 3）
            const res = await list(s, '?status=all');
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, {
                as_of: today,
                counts: { active: 0, due: 0, in_flight: 0, stuck: 0, mastered: 0, retired: 0 },
                items: []
            });
            // 以題號手動加入以前派過的題
            const add = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [q1] });
            assert.equal(add.status, 200, JSON.stringify(add.body));
            assert.deepEqual(add.body.skipped, []);
            assert.deepEqual(add.body.added.map(a => [a.question_id, a.reason]), [[q1, 'manual']]);
        });

        test('旗標關閉時，既有項目照樣在批改的同一交易內重算（資料完整性），回應仍只有 { updated }', async () => {
            const [q1] = await seedQuestions(1);
            const s = await createStudent('旗標關閉重算生');
            const p1 = await confirmPaper(s, [q1]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            await withRetrain(false, async app => {
                const res = await patch(app, r1, [{ question_id: q1, result: 1 }]);
                assert.deepEqual([res.status, res.body], [200, { updated: 1 }]);
            });
            const it = await assertCacheMatchesHistory(s, q1);
            assert.deepEqual([it.step, it.streak, it.due_on], [2, 1, day(7)]);
        });

        // ───────────────────── TC-037-1：批改卡「要重練」 ─────────────────────

        test('勾「要重練」同一次儲存就建項目（第 1 關、起算日＝派題日）；答錯沒勾不建；試卷明細帶 retrain_flagged', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const s = await createStudent('勾選生');
            const p1 = await confirmPaper(s, [q1, q2, q3]);

            const res = await patch(appOn, p1, [
                { question_id: q1, result: 0, error_types: ['calc'], retrain: true },
                { question_id: q2, result: 0 },
                { question_id: q3, result: 1, retrain: true }      // 答對的題也可以勾（設計稿第 5.3 節）
            ]);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body, { updated: 3, retrain: { entered: 2, advanced: 0, mastered: 0, reset: 0 } });

            const i1 = await itemOf(s, q1);
            assert.deepEqual(
                [i1.reason, i1.entered_on, i1.status, i1.step, i1.due_on, i1.streak, i1.lapses, i1.teacher_override],
                ['flagged', today, 'active', 1, day(1), 0, 0, null]);
            assert.equal((await itemOf(s, q3)).reason, 'flagged');
            assert.equal(await itemOf(s, q2), null, '答錯但沒勾不進清單（R1 選 2）');

            // API-9：旗標開啟時每題多 purpose、retrain_step、retrain_flagged（接在既有鍵之後）
            const d = await request(appOn).get(`/api/papers/${p1}`);
            assert.equal(d.status, 200);
            const byQ = new Map(d.body.questions.map(q => [q.question_id, q]));
            assert.deepEqual(Object.keys(byQ.get(q1)).slice(-3), ['purpose', 'retrain_step', 'retrain_flagged']);
            assert.deepEqual([q1, q2, q3].map(q => [byQ.get(q).purpose, byQ.get(q).retrain_step, byQ.get(q).retrain_flagged]),
                [['new', null, true], ['new', null, false], ['new', null, true]]);

            // 改判成對、改錯因：項目不會消失（進不進清單是老師勾的）
            const regrade = await patch(appOn, p1, [{ question_id: q1, result: 1 }]);
            assert.deepEqual(regrade.body, { updated: 1, retrain: EMPTY });
            assert.ok(await itemOf(s, q1), '改判成對不刪項目');
            // 已經在清單上的題再勾一次：不動（不重算起算日、不算 entered）
            const again = await patch(appOn, p1, [{ question_id: q1, result: 1, retrain: true }]);
            assert.deepEqual(again.body.retrain, EMPTY);
            assert.equal((await itemOf(s, q1)).id, i1.id);
        });

        test('取消勾選：還沒重練過就刪項目；重練過就移出（保留紀錄）；再勾回來＝重新加入（同一天批改過的那筆不算新一輪）', async () => {
            const [q1, q3] = await seedQuestions(2);
            const s = await createStudent('取消勾選生');
            const p1 = await confirmPaper(s, [q1, q3]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }, { question_id: q3, result: 0, retrain: true }]);

            // 沒重練過 → 刪項目
            const un3 = await patch(appOn, p1, [{ question_id: q3, result: 0, retrain: false }]);
            assert.deepEqual(un3.body, { updated: 1, retrain: EMPTY });
            assert.equal(await itemOf(s, q3), null);
            const d = await request(appOn).get(`/api/papers/${p1}`);
            assert.equal(d.body.questions.find(q => q.question_id === q3).retrain_flagged, false);

            // 重練過 → 移出
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            const g = await patch(appOn, r1, [{ question_id: q1, result: 1 }]);
            assert.deepEqual(g.body, { updated: 1, retrain: { entered: 0, advanced: 1, mastered: 0, reset: 0 } });
            const un1 = await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: false }]);
            assert.deepEqual(un1.body.retrain, EMPTY);
            const retired = await itemOf(s, q1);
            assert.deepEqual([retired.status, retired.teacher_override, retired.override_on, retired.due_on], ['retired', 'retired', today, null]);
            const d2 = await request(appOn).get(`/api/papers/${p1}`);
            assert.equal(d2.body.questions.find(q => q.question_id === q1).retrain_flagged, false, '移出的項目不算勾選');
            const dr = await request(appOn).get(`/api/papers/${r1}`);
            assert.deepEqual([dr.body.questions[0].purpose, dr.body.questions[0].retrain_step, dr.body.questions[0].retrain_flagged],
                ['retrain', 1, null], '重練題的 retrain_flagged 是 null');

            // 再勾回來：已移出的等同重新加入（起算日＝今天）；今天稍早批改過的重練（r1）屬於前一輪
            const re = await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            assert.deepEqual(re.body.retrain, { entered: 1, advanced: 0, mastered: 0, reset: 0 });
            const back = await assertCacheMatchesHistory(s, q1);
            assert.deepEqual([back.status, back.step, back.streak, back.entered_on, back.teacher_override, back.due_on],
                ['active', 1, 0, today, null, day(1)], '從第 1 關、連對 0 重來（設計稿第 4.4 節的已知邊界已處理）');
            assert.equal(back.id, retired.id, '同一個項目（保留紀錄）');
        });

        test('新規則的檢查排在既有檢查之後；任何一條 400 都整筆回滾，項目與批改都不變', async () => {
            const [q1, q2] = await seedQuestions(2);
            const [c1] = await seedQuestions(1, { subject: '化學', chapter: '化學反應' });
            const [g1, g2] = await seedGroup(2);
            const s = await createStudent('檢查順序生');
            const p1 = await confirmPaper(s, [q1, g1, g2, c1]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            const before = await itemOf(s, q1);

            const cases = [
                // 既有檢查優先：題目不在卷上
                [p1, [{ question_id: q2, result: 0, retrain: 'yes' }], `題目 ${q2} 不在這張試卷內。`],
                // 既有檢查優先：錯因的科目限制
                [p1, [{ question_id: q1, result: 0, error_types: ['chem_equation'], retrain: 'yes' }],
                    `題目 ${q1} 是數學題，不能標記「化學式或係數」（chem_equation）。`],
                [p1, [{ question_id: g1, result: 0, retrain: 'yes' }], 'retrain 只接受 true 或 false。'],
                [r1, [{ question_id: q1, result: 0, retrain: false }],
                    `題目 ${q1} 在這張卷上是重練題，「要重練」只能勾在新題上（要移出請到錯題重練清單）。`],
                // 同一筆請求裡的新規則錯誤也讓前面合法的勾選一起回滾
                [p1, [{ question_id: g1, result: 0, retrain: true }, { question_id: g2, result: 1, retrain: 1 }],
                    'retrain 只接受 true 或 false。']
            ];
            for (const [paperId, results, message] of cases) {
                const res = await patch(appOn, paperId, results);
                assert.deepEqual([res.status, res.body], [400, { message }], JSON.stringify(results));
            }
            // 全部回滾：批改沒寫、項目沒建也沒動
            const { rows } = await query(
                `SELECT question_id, purpose, result FROM assignment_attempts WHERE student_id = $1
                  ORDER BY question_id, purpose`, [s]);
            assert.deepEqual(rows.map(r => [r.question_id, r.purpose, r.result]),
                [[q1, 'new', 0], [q1, 'retrain', null], [c1, 'new', null], [g1, 'new', null], [g2, 'new', null]]);
            assert.deepEqual(await itemOf(s, q1), before);
            assert.equal(await itemCount(s), 1);
        });

        test('承上組：勾一題整組進清單（其餘 group）；retrain_flagged 只反映親手勾的題；取消勾選只動 flagged，全組沒有勾選才一起離開；manual 不受批改卡影響', async () => {
            const [g1, g2, g3] = await seedGroup(3);
            const [q4] = await seedQuestions(1);
            const s = await createStudent('承上組生');
            const p1 = await confirmPaper(s, [g1, g2, g3, q4]);
            const flagged = async () => {
                const d = await request(appOn).get(`/api/papers/${p1}`);
                const m = new Map(d.body.questions.map(q => [q.question_id, q.retrain_flagged]));
                return [g1, g2, g3].map(q => m.get(q));
            };
            const reasons = async () => (await Promise.all([g1, g2, g3].map(q => itemOf(s, q)))).map(i => i && i.reason);

            const res = await patch(appOn, p1, [{ question_id: g2, result: 0, retrain: true }, { question_id: q4, result: 0 }]);
            assert.deepEqual(res.body, { updated: 2, retrain: { entered: 3, advanced: 0, mastered: 0, reset: 0 } });
            const groupItems = await Promise.all([g1, g2, g3].map(q => itemOf(s, q)));
            assert.deepEqual(groupItems.map(i => [i.reason, i.entered_on, i.step]),
                [['group', today, 1], ['flagged', today, 1], ['group', today, 1]]);
            assert.equal(await itemOf(s, q4), null);
            assert.deepEqual(await flagged(), [false, true, false], '只有親手勾的那一題顯示已勾');

            // 清單：同組相鄰、依承接順序，group_ids 是整組
            const l = await list(s);
            assert.deepEqual(l.body.items.map(i => i.question_id), [g1, g2, g3]);
            assert.ok(l.body.items.every(i => JSON.stringify(i.group_ids) === JSON.stringify([g1, g2, g3])));
            assert.deepEqual(l.body.items.map(i => i.follows_question_id), [null, g1, g2]);

            // 取消 group 項目的勾選：不動（它本來就沒被勾）
            const noop = await patch(appOn, p1, [{ question_id: g3, result: 0, retrain: false }]);
            assert.deepEqual(noop.body.retrain, EMPTY);
            assert.deepEqual(await reasons(), ['group', 'flagged', 'group']);
            // 再勾 g3：改成 flagged，不重建、不算 entered
            const also = await patch(appOn, p1, [{ question_id: g3, result: 0, retrain: true }]);
            assert.deepEqual(also.body.retrain, EMPTY);
            assert.deepEqual(await reasons(), ['group', 'flagged', 'flagged']);
            // 取消 g2：同組還有 g3 勾著 → g2 改成 group，整組仍在清單上
            await patch(appOn, p1, [{ question_id: g2, result: 0, retrain: false }]);
            assert.deepEqual(await reasons(), ['group', 'group', 'flagged']);
            assert.deepEqual(await flagged(), [false, false, true]);
            // 取消 g3：全組沒有勾選了 → 連同 group 項目一起離開清單（都還沒重練過 → 刪）
            await patch(appOn, p1, [{ question_id: g3, result: 0, retrain: false }]);
            assert.equal(await itemCount(s), 0);

            // 手動加入其中一題 → 同組其他題以 group 一起加；批改卡取消勾選不影響 manual
            const add = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [g3] });
            assert.deepEqual(add.body.added.map(a => [a.question_id, a.reason]), [[g3, 'manual'], [g1, 'group'], [g2, 'group']]);
            assert.equal((await itemOf(s, g1)).entered_on, today);
            assert.deepEqual(await flagged(), [false, false, false], '手動加入的不算批改卡勾選');
            await patch(appOn, p1, [{ question_id: g3, result: 0, retrain: false }]);
            assert.deepEqual(await reasons(), ['group', 'group', 'manual']);
        });

        // ───────────────────── TC-037-1：API-2 手動加入 ─────────────────────

        test('API-2 手動加入：skipped 原因；以前沒批改、沒有卷號的舊紀錄加入後照常到期、可以出重練卷（R11 選 3）', async () => {
            const [q1, q2, q3, q4] = await seedQuestions(4);
            const s = await createStudent('手動加入生');
            const other = await createStudent('手動加入對照生');
            // q1：MySQL 時期匯入的舊紀錄（paper_id NULL、result NULL、很久以前）
            await insertAttempts(query, [
                { student_id: s, question_id: q1, assigned_at: day(-400) },
                { student_id: s, question_id: q2, assigned_at: day(-30), result: 0, graded_at: 'now' },
                { student_id: s, question_id: q4, assigned_at: day(-30), result: 0, graded_at: 'now' }
            ]);
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [q4]);

            const res = await request(appOn).post(`/api/students/${s}/retrain-items`)
                .send({ question_ids: [q1, q3, q4, 999999, q2] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.added.map(a => [a.question_id, a.reason]), [[q1, 'manual'], [q2, 'manual']]);
            assert.ok(res.body.added.every(a => Number.isInteger(a.item_id)));
            assert.deepEqual(res.body.skipped, [
                { question_id: q3, reason: 'not_assigned' },
                { question_id: q4, reason: 'archived' },
                { question_id: 999999, reason: 'missing' }
            ]);
            const again = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [q1] });
            assert.deepEqual(again.body, { added: [], skipped: [{ question_id: q1, reason: 'already_in_schedule' }] });
            const notMine = await request(appOn).post(`/api/students/${other}/retrain-items`).send({ question_ids: [q1] });
            assert.deepEqual(notMine.body.skipped, [{ question_id: q1, reason: 'not_assigned' }]);

            // 舊紀錄沒批改也不算已派出：加入當天起算，隔天到期、不會跳 14 天提醒
            const it = await itemOf(s, q1);
            assert.deepEqual([it.entered_on, it.due_on, it.status], [today, day(1), 'active']);
            const l = await list(s, `?as_of=${day(1)}`);
            const v = l.body.items.find(i => i.question_id === q1);
            assert.deepEqual([v.in_flight, v.in_flight_paper_id, v.in_flight_warn, v.due, v.overdue_days], [false, null, false, true, 0]);
            const r = await retrainPaper(s, [q1], day(1));
            assert.ok(!r.conflict, JSON.stringify(r.conflict));

            // 學生不存在 404；body 嚴格驗證 400
            assert.deepEqual((await request(appOn).post('/api/students/999999/retrain-items').send({ question_ids: [q1] })).status, 404);
            assert.deepEqual((await request(appOn).post('/api/students/abc/retrain-items').send({ question_ids: [q1] })).status, 404);
            const bad = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [q1], reason: 'x' });
            assert.deepEqual([bad.status, bad.body], [400, { message: '不接受的欄位：reason（可用的欄位：question_ids）。' }]);
        });

        // ───────────────────── TC-037-1：API-3 ─────────────────────

        test('API-3：移出、判定已會、重新加入（錯的次數不歸零）、備註；承上組整組移出與重新加入；404／409／400', async () => {
            const [q1] = await seedQuestions(1);
            const [g1, g2] = await seedGroup(2);
            const s = await createStudent('動作生');
            const other = await createStudent('動作對照生');
            const p1 = await confirmPaper(s, [q1, g1, g2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }, { question_id: g1, result: 0, retrain: true }]);
            // q1 重練一次答錯（lapses 1）
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            await patch(appOn, r1, [{ question_id: q1, result: 0 }]);
            const id1 = (await itemOf(s, q1)).id;

            const ret = await act(s, id1, { action: 'retire', note: '  改講觀念  ' });
            assert.equal(ret.status, 200, JSON.stringify(ret.body));
            assert.deepEqual(
                [ret.body.item_id, ret.body.question_id, ret.body.status, ret.body.teacher_override, ret.body.override_on,
                    ret.body.due_on, ret.body.due, ret.body.note, ret.body.lapses, ret.body.group_changed],
                [id1, q1, 'retired', 'retired', today, null, false, '改講觀念', 1, []]);
            assert.equal((await act(s, id1, { action: 'retire' })).body.override_on, today, '再移出一次：不變');

            const mm = await act(s, id1, { action: 'mark_mastered', note: null });
            assert.deepEqual([mm.body.status, mm.body.mastered_on, mm.body.teacher_override, mm.body.note], ['mastered', today, 'mastered', null]);

            const re = await act(s, id1, { action: 'reactivate' });
            assert.deepEqual([re.body.status, re.body.step, re.body.streak, re.body.lapses, re.body.entered_on, re.body.teacher_override],
                ['active', 1, 0, 1, today, null], '從第 1 關重來，錯的次數不歸零');
            await assertCacheMatchesHistory(s, q1);
            const dup = await act(s, id1, { action: 'reactivate' });
            assert.deepEqual([dup.status, dup.body], [409, { message: '這一題正在重練中，不需要重新加入。' }]);

            // 承上組：移出一題＝整組移出；重新加入一題＝整組回來
            const ig1 = (await itemOf(s, g1)).id;
            const ig2 = (await itemOf(s, g2)).id;
            const gr = await act(s, ig1, { action: 'retire' });
            assert.deepEqual(gr.body.group_changed, [{ item_id: ig2, question_id: g2 }]);
            assert.equal((await itemOf(s, g2)).status, 'retired');
            const gb = await act(s, ig2, { action: 'reactivate' });
            assert.deepEqual(gb.body.group_changed, [{ item_id: ig1, question_id: g1 }]);
            assert.deepEqual([(await itemOf(s, g1)).status, (await itemOf(s, g2)).status], ['active', 'active']);
            // 判定已會只動這一題
            const gm = await act(s, ig1, { action: 'mark_mastered' });
            assert.deepEqual(gm.body.group_changed, []);
            assert.equal((await itemOf(s, g2)).status, 'active');

            // 404：不屬於這位學生、學生不存在、id 格式不對
            assert.deepEqual([(await act(other, id1, { action: 'retire' })).status, (await act(other, id1, { action: 'retire' })).body],
                [404, { message: '找不到該重練項目' }]);
            assert.deepEqual((await act(999999, id1, { action: 'retire' })).body, { message: '找不到該學生' });
            assert.equal((await act(s, 'abc', { action: 'retire' })).status, 404);
            // 400：不認得的鍵、action
            assert.deepEqual((await act(s, id1, { action: 'retire', status: 'x' })).body,
                { message: '不接受的欄位：status（可用的欄位：action、note）。' });
            assert.deepEqual((await act(s, id1, { action: 'delete' })).body,
                { message: 'action 必填，只接受 retire、mark_mastered、reactivate。' });
            assert.equal((await itemOf(s, q1)).status, 'active', '400／404 不改任何東西');
        });

        // ───────────────────── TC-038-3／ACPT-038-1～4：排程由批改驅動 ─────────────────────

        test('逐筆批改、部分給分、取消批改、改判、刪重練卷：每一步快取＝作答歷史重算（I7）；已派出不算到期、不再派', async () => {
            const [q1] = await seedQuestions(1);
            const s = await createStudent('排程生');
            const p1 = await confirmPaper(s, [q1]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);

            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            // 已派出、還沒批改：不算到期（as_of 再晚都一樣）、不會再派
            const l = await list(s, `?as_of=${day(30)}`);
            assert.deepEqual([l.body.items[0].in_flight, l.body.items[0].in_flight_paper_id, l.body.items[0].in_flight_since,
                l.body.items[0].due], [true, r1, today, false]);
            assert.deepEqual(l.body.counts, { active: 1, due: 0, in_flight: 1, stuck: 0, mastered: 0, retired: 0 });
            assert.deepEqual((await retrainPaper(s, [q1], day(1))).conflict, { question_id: q1, reason: 'in_flight' });
            assert.equal(retrain.retrainConflictMessage(q1), `題目 ${q1} 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`);

            const steps = [
                // [派題日, 批改, 預期摘要, 預期 (status, step, streak, lapses, due_on)]
                [today, { result: 1 }, { advanced: 1 }, ['active', 2, 1, 0, day(7)]],
                [day(7), { result: 0 }, { reset: 1 }, ['active', 1, 0, 1, day(8)]],
                [day(8), { result: 1, score: 0.8 }, { reset: 1 }, ['active', 1, 0, 2, day(9)]],   // R2：80% 算錯
                [day(9), { result: 1, score: 1 }, { advanced: 1 }, ['active', 2, 1, 2, day(16)]],
                [day(16), { result: 1 }, { advanced: 1 }, ['active', 3, 2, 2, day(30)]],
                [day(30), { result: 1 }, { mastered: 1 }, ['mastered', 3, 3, 2, null]]
            ];
            const papers = [r1];
            for (const [i, [date, grade, summary, expect]] of steps.entries()) {
                const paperId = i === 0 ? r1 : (await retrainPaper(s, [q1], date)).paperId;
                if (i > 0) papers.push(paperId);
                const res = await patch(appOn, paperId, [{ question_id: q1, ...grade }]);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(res.body.retrain, { ...EMPTY, ...summary }, `第 ${i + 1} 次批改`);
                const it = await assertCacheMatchesHistory(s, q1, `第 ${i + 1} 次批改`);
                assert.deepEqual([it.status, it.step, it.streak, it.lapses, it.due_on], expect, `第 ${i + 1} 次批改`);
            }
            assert.equal((await itemOf(s, q1)).mastered_on, day(30));
            const d = await request(appOn).get(`/api/papers/${papers[5]}`);
            assert.equal(d.body.questions[0].retrain_step, 3, '派題當下的關卡');

            // 取消批改最後一筆 → 回到第 3 關、已派出
            await patch(appOn, papers[5], [{ question_id: q1, result: null }]);
            let it = await assertCacheMatchesHistory(s, q1, '取消批改');
            assert.deepEqual([it.status, it.step], ['active', 3]);
            // 改判：第 2 筆從錯改成對
            await patch(appOn, papers[1], [{ question_id: q1, result: 1 }]);
            it = await assertCacheMatchesHistory(s, q1, '改判');
            assert.equal(it.lapses, 1);
            // 刪重練卷（第 5 筆）：等於那次重練沒發生過
            const del = await request(appOn).delete(`/api/papers/${papers[4]}`);
            assert.deepEqual([del.status, del.body], [200, { deleted_attempts: 1 }]);
            await assertCacheMatchesHistory(s, q1, '刪重練卷');
        });

        test('卡關：錯滿 3 次標 stuck，仍在清單、照樣到期（R4 選 1）；API-4 學生清單的到期數（TC-040-1）', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const s = await createStudent('卡關生');
            const t = await createStudent('到期對照生');
            const n = await createStudent('沒有項目生');
            const p1 = await confirmPaper(s, [q1, q2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }, { question_id: q2, result: 0, retrain: true }]);
            for (const date of [today, day(1), day(2)]) {
                const { paperId } = await retrainPaper(s, [q1], date);
                await patch(appOn, paperId, [{ question_id: q1, result: 0 }]);
            }
            const it = await itemOf(s, q1);
            assert.deepEqual([it.status, it.lapses, it.due_on], ['active', 3, day(3)]);
            const pt = await confirmPaper(t, [q3]);
            await patch(appOn, pt, [{ question_id: q3, result: 0, retrain: true }]);
            await retrainPaper(t, [q3], today);            // 已派出
            await confirmPaper(n, [q2]);

            const stuck = await list(s, `?status=stuck&as_of=${day(3)}`);
            assert.deepEqual(stuck.body.items.map(i => [i.question_id, i.stuck, i.due, i.status]), [[q1, true, true, 'active']]);

            const sum = await request(appOn).get(`/api/retrain/summary?as_of=${day(3)}`);
            assert.equal(sum.status, 200);
            assert.deepEqual(sum.body, {
                as_of: day(3),
                items: [
                    { student_id: s, due: 2, in_flight: 0, stuck: 1, active: 2 },
                    { student_id: t, due: 0, in_flight: 1, stuck: 0, active: 1 }
                ]
            });
            const sumToday = await request(appOn).get('/api/retrain/summary');
            assert.deepEqual(sumToday.body.as_of, today);
            assert.deepEqual(sumToday.body.items.map(i => [i.student_id, i.due]), [[s, 0], [t, 0]], 'q2 明天才到期、q1 第 3 天');
            assert.ok(!JSON.stringify(sumToday.body).includes('卡關生'), '不回姓名');
            const bad = await request(appOn).get('/api/retrain/summary?asof=2026-01-01');
            assert.deepEqual([bad.status, bad.body], [400, { message: '不認得的查詢參數：asof（可用：as_of）。' }]);
        });

        test('API-1：排序（逾期多→關卡小→錯次數多→題號小；沒到期的在後）、counts、status 篩選、as_of、subject、history', async () => {
            const qs = await seedQuestions(10);
            const [phys] = await seedQuestions(1, { subject: '物理', chapter: '直線運動' });
            const [A, B, C, D, F, G, J, K, H, I] = qs;
            const s = await createStudent('排序生');
            // 很久以前以新題派過（已批改），再以題號手動加入，然後把起算日改到過去（夾具）
            await insertAttempts(query, [...qs, phys].map(q => ({
                student_id: s, question_id: q, assigned_at: day(-40), result: 0, graded_at: 'now'
            })));
            const add = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [...qs, phys] });
            assert.equal(add.body.added.length, 11);
            const enter = { [A]: -10, [B]: -10, [C]: -5, [D]: -5, [F]: -3, [G]: 0, [J]: -10, [K]: -10, [H]: -10, [I]: -10, [phys]: -10 };
            for (const [q, n] of Object.entries(enter)) {
                await query('UPDATE retrain_items SET entered_on = $3::date WHERE student_id = $1 AND question_id = $2', [s, Number(q), day(n)]);
            }
            const rp = async (q, date, result) => {
                const [p] = (await query('INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                    ['排序重練卷', s, [q]])).rows;
                await insertAttempts(query, [{ student_id: s, question_id: q, paper_id: p.id, purpose: 'retrain', assigned_at: date,
                    ...(result === null ? {} : { result, graded_at: 'now' }) }]);
                return p.id;
            };
            await rp(B, day(-9), 1);          // 第 2 關，到期 -2
            await rp(D, day(-5), 0);          // 錯一次，到期 -4
            const jPaper = await rp(J, day(-1), null);   // 已派出
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [K]);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await retrain.recompute(client, s);
                await client.query('COMMIT');
            } finally { client.release(); }
            await act(s, (await itemOf(s, H)).id, { action: 'mark_mastered' });
            await act(s, (await itemOf(s, I)).id, { action: 'retire' });

            const all = await list(s, '?status=all&subject=數學');
            assert.equal(all.status, 200, JSON.stringify(all.body));
            // 到期：A(逾期 9)、D(4，錯 1 次)、C(4)、F(2，第 1 關)、B(2，第 2 關)；沒到期的進行中依到期日：J、K(-9，題號小的先)、G(+1)；練到會；移出
            assert.deepEqual(all.body.items.map(i => i.question_id), [A, D, C, F, B, J, K, G, H, I]);
            assert.deepEqual(all.body.items.slice(0, 5).map(i => i.overdue_days), [9, 4, 4, 2, 2]);
            assert.deepEqual(all.body.counts, { active: 8, due: 5, in_flight: 1, stuck: 0, mastered: 1, retired: 1 });
            const vb = all.body.items.find(i => i.question_id === B);
            assert.deepEqual([vb.step, vb.step_label, vb.streak, vb.due_on], [2, '一週回測', 1, day(-2)]);
            assert.deepEqual(vb.history.map(h => [h.purpose, h.assigned_at, h.retrain_step, h.result, h.paper_id === null]),
                [['new', day(-40), null, 0, true], ['retrain', day(-9), 1, 1, false]]);
            const vk = all.body.items.find(i => i.question_id === K);
            assert.deepEqual([vk.archived, vk.due, vk.status], [true, false, 'active'], '封存的題不算到期');
            const vj = all.body.items.find(i => i.question_id === J);
            assert.deepEqual([vj.in_flight, vj.in_flight_paper_id, vj.in_flight_warn], [true, jPaper, false]);
            assert.equal(all.body.items[0].step_label, '錯題重練');
            assert.deepEqual(Object.keys(all.body.items[0]).slice(0, 8),
                ['item_id', 'question_id', 'subject', 'chapter', 'difficulty', 'question_type', 'question_text_preview', 'archived']);

            // 預設 status=active（含物理那一題）；各篩選
            const act8 = await list(s);
            assert.equal(act8.body.items.length, 9);
            assert.deepEqual(act8.body.counts.active, 9);
            assert.deepEqual((await list(s, '?status=due&subject=數學')).body.items.map(i => i.question_id), [A, D, C, F, B]);
            assert.deepEqual((await list(s, '?status=in_flight')).body.items.map(i => i.question_id), [J]);
            assert.deepEqual((await list(s, '?status=mastered')).body.items.map(i => i.question_id), [H]);
            assert.deepEqual((await list(s, '?status=retired')).body.items.map(i => i.question_id), [I]);
            // as_of 往前：只有到期日 ≤ 那天的算
            assert.deepEqual((await list(s, `?status=due&subject=數學&as_of=${day(-4)}`)).body.items.map(i => i.question_id), [A, D, C]);
            // 超過 14 天未批改另外提醒
            await query(`UPDATE assignments SET assigned_at = $2::date WHERE paper_id = $1`, [jPaper, day(-15)]);
            assert.equal((await list(s, '?status=in_flight')).body.items[0].in_flight_warn, true);

            // 參數驗證與 404
            for (const [qstr, message] of [
                ['?status=late', 'status 只接受 active、due、in_flight、stuck、mastered、retired、all。'],
                ['?subject=生物', 'subject 不在白名單內。'],
                ['?as_of=2026-02-30', 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
                ['?page=2', '不認得的查詢參數：page（可用：status、subject、as_of）。'],
                ['?status=due&status=all', 'status 只能給一個值。']
            ]) {
                const res = await list(s, qstr);
                assert.deepEqual([res.status, res.body], [400, { message }], qstr);
            }
            assert.deepEqual([(await list(999999)).status, (await list(999999)).body], [404, { message: '找不到該學生' }]);
            assert.equal((await list('1.5')).status, 404);
        });

        test('批改與排程在同一交易：重算或建立項目失敗時整筆回滾，批改與項目都不變（TC-038-3）', async () => {
            const [q1, q2] = await seedQuestions(2);
            const s = await createStudent('交易回滾生');
            const p1 = await confirmPaper(s, [q1, q2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            const before = await itemOf(s, q1);
            await query(`CREATE OR REPLACE FUNCTION test_retrain_sabotage() RETURNS trigger
                         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retrain sabotage'; END $$`);
            try {
                // 建立項目失敗（勾 q2）→ q2 的批改也沒寫進去
                await query(`CREATE TRIGGER test_retrain_sabotage BEFORE INSERT ON retrain_items
                             FOR EACH ROW EXECUTE FUNCTION test_retrain_sabotage()`);
                const a = await patch(appOn, p1, [{ question_id: q2, result: 0, retrain: true }]);
                assert.equal(a.status, 500);
                assert.equal(await itemOf(s, q2), null);
                const { rows: [r2] } = await query('SELECT result FROM attempts WHERE student_id = $1 AND question_id = $2', [s, q2]);
                assert.equal(r2.result, null, '批改跟著回滾');
                await query('DROP TRIGGER test_retrain_sabotage ON retrain_items');
                // 重算寫回快取失敗（批改重練卷）→ 重練卷的批改也沒寫進去，快取不變
                await query(`CREATE TRIGGER test_retrain_sabotage BEFORE UPDATE ON retrain_items
                             FOR EACH ROW EXECUTE FUNCTION test_retrain_sabotage()`);
                const b = await patch(appOn, r1, [{ question_id: q1, result: 1 }]);
                assert.equal(b.status, 500);
                const { rows: [rr] } = await query('SELECT result FROM assignment_attempts WHERE paper_id = $1', [r1]);
                assert.equal(rr.result, null);
                assert.deepEqual(await itemOf(s, q1), before);
            } finally {
                await query('DROP TRIGGER IF EXISTS test_retrain_sabotage ON retrain_items');
                await query('DROP FUNCTION IF EXISTS test_retrain_sabotage()');
            }
            // 恢復之後照常
            const ok = await patch(appOn, r1, [{ question_id: q1, result: 1 }]);
            assert.deepEqual(ok.body.retrain, { entered: 0, advanced: 1, mastered: 0, reset: 0 });
        });

        test('給 PR-3 的介面：listDueUnits 以承上組為單位排序、整組不能出的放 blocked；insertRetrainAssignments 的衝突原因', async () => {
            const [a1] = await seedQuestions(1);
            const [g1, g2] = await seedGroup(2);
            const [h1, h2] = await seedGroup(2);
            const [k1, k2] = await seedGroup(2);
            const [z1] = await seedQuestions(1);
            const s = await createStudent('到期單位生');
            const all = [a1, g1, g2, h1, h2, k1, k2, z1];
            await insertAttempts(query, all.map(q => ({ student_id: s, question_id: q, assigned_at: day(-30), result: 0, graded_at: 'now' })));
            const add = await request(appOn).post(`/api/students/${s}/retrain-items`).send({ question_ids: [a1, g2, h1, k1] });
            assert.equal(add.body.added.length, 7);
            // 起算日往前挪（夾具）：a1 逾期 4、g 組逾期 9（組內 g2 較急）、h 組有一題移出、k 組有一題封存
            for (const [q, n] of [[a1, -5], [g1, -5], [g2, -10], [h1, -10], [h2, -10], [k1, -10], [k2, -10]]) {
                await query('UPDATE retrain_items SET entered_on = $3::date WHERE student_id = $1 AND question_id = $2', [s, q, day(n)]);
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await retrain.recompute(client, s);
                await client.query('COMMIT');
            } finally { client.release(); }
            await query(`UPDATE retrain_items SET teacher_override = 'retired', override_on = $2::date
                          WHERE student_id = $1 AND question_id = $3`, [s, today, h2]);
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [k2]);
            const c2 = await pool.connect();
            try {
                await c2.query('BEGIN');
                await retrain.recompute(c2, s);
                await c2.query('COMMIT');
            } finally { c2.release(); }

            const due = await retrain.listDueUnits(query, s, { asOf: today });
            assert.deepEqual(due.units.map(u => u.group_ids), [[g1, g2], [a1]]);
            assert.deepEqual(due.units.map(u => [u.size, u.due_count, u.overdue_days]), [[2, 2, 9], [1, 1, 4]]);
            assert.deepEqual(due.units[0].items.map(i => [i.question_id, i.item_id > 0, i.step]), [[g1, true, 1], [g2, true, 1]]);
            assert.deepEqual(due.blocked, [
                { group_ids: [h1, h2], reasons: [{ question_id: h2, reason: 'retired' }] },
                { group_ids: [k1, k2], reasons: [{ question_id: k2, reason: 'archived' }] }
            ]);
            assert.equal(due.due_total, 5, 'a1、g1、g2、h1、k1 到期（k2 封存不算）');

            const conflictOf = async q => (await retrainPaper(s, [q], today)).conflict;
            assert.deepEqual(await conflictOf(z1), { question_id: z1, reason: 'not_in_schedule' });
            assert.deepEqual(await conflictOf(h2), { question_id: h2, reason: 'retired' });
            // 已練到會的組員可以被帶著出（設計稿第 4.4 節）
            await act(s, (await itemOf(s, g1)).id, { action: 'mark_mastered' });
            const carried = await retrainPaper(s, [g1, g2], today);
            assert.deepEqual(carried.rows.map(r => [r.question_id, r.retrain_step]), [[g1, 1], [g2, 1]]);
        });

        // ───────────────────── TC-038-3：兩個交易同時操作同一項目 ─────────────────────

        test('併發：兩個交易同時批改同一項目的兩張重練卷——後拿到鎖的讀得到先提交的那一筆，快取＝兩筆都算', async () => {
            const [q1] = await seedQuestions(1);
            const s = await createStudent('併發批改生');
            const p1 = await confirmPaper(s, [q1]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            // 夾具：兩張都還沒批改的重練卷（繞過出卷時的 I6 檢查，專測批改端的鎖）
            const mk = async () => {
                const [p] = (await query('INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                    ['併發重練卷', s, [q1]])).rows;
                const [aid] = await insertAttempts(query, [{ student_id: s, question_id: q1, paper_id: p.id, purpose: 'retrain', assigned_at: today }]);
                return { paperId: p.id, aid };
            };
            const a = await mk();
            const b = await mk();

            const c1 = await pool.connect();
            const c2 = await pool.connect();
            try {
                await c1.query('BEGIN');
                await c2.query('BEGIN');
                await c1.query('UPDATE attempt_records SET result = 1, graded_at = now() WHERE assignment_id = $1', [a.aid]);
                await retrain.recompute(c1, s, [q1]);                       // c1 拿到項目的鎖
                await c2.query('UPDATE attempt_records SET result = 1, graded_at = now() WHERE assignment_id = $1', [b.aid]);
                let done = false;
                const p2 = retrain.recompute(c2, s, [q1]).then(r => { done = true; return r; });
                await new Promise(r => setTimeout(r, 300));
                assert.equal(done, false, 'c2 要等 c1 放開項目的鎖');
                await c1.query('COMMIT');
                const changes = await p2;
                await c2.query('COMMIT');
                assert.deepEqual([changes[0].after.streak, changes[0].after.step], [2, 3], 'c2 重算時看得到 c1 已提交的那一筆');
            } finally {
                c1.release();
                c2.release();
            }
            const it = await assertCacheMatchesHistory(s, q1);
            assert.deepEqual([it.step, it.streak], [3, 2]);

            // 經 API 同時送兩個批改（兩張卷各一筆），結果與依序批改相同
            const c = await mk();
            const d = await mk();
            const [rc, rd] = await Promise.all([
                patch(appOn, c.paperId, [{ question_id: q1, result: 1 }]),
                patch(appOn, d.paperId, [{ question_id: q1, result: 0 }])
            ]);
            assert.deepEqual([rc.status, rd.status], [200, 200]);
            await assertCacheMatchesHistory(s, q1, '同時批改兩張卷');
        });

        test('併發：兩個出卷交易同時派同一個項目，後者看到前者已提交的派題而衝突（I6）；兩個批改同時勾同一題只建一個項目', async () => {
            const [q1, q2] = await seedQuestions(2);
            const s = await createStudent('併發出卷生');
            const p1 = await confirmPaper(s, [q1, q2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);

            const c1 = await pool.connect();
            const c2 = await pool.connect();
            try {
                const paper = async c => (await c.query(
                    'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id', ['併發卷', s, [q1]])).rows[0].id;
                await c1.query('BEGIN');
                await c2.query('BEGIN');
                const r1 = await retrain.insertRetrainAssignments(c1, { studentId: s, paperId: await paper(c1), assignedAt: day(1), questionIds: [q1] });
                assert.equal(r1.conflict, null);
                let done = false;
                const pending = paper(c2).then(pid => retrain.insertRetrainAssignments(c2, { studentId: s, paperId: pid, assignedAt: day(1), questionIds: [q1] }))
                    .then(r => { done = true; return r; });
                await new Promise(r => setTimeout(r, 300));
                assert.equal(done, false, '後者要等前者放開項目的鎖');
                await c1.query('COMMIT');
                const r2 = await pending;
                assert.deepEqual(r2.conflict, { question_id: q1, reason: 'in_flight' });
                await c2.query('ROLLBACK');
            } finally {
                c1.release();
                c2.release();
            }
            const { rows: [n] } = await query(`SELECT COUNT(*)::int AS n FROM assignments WHERE question_id = $1 AND purpose = 'retrain'`, [q1]);
            assert.equal(n.n, 1);

            // 兩個批改請求同時勾 q2：只建一個項目，entered 合計 1
            const [x, y] = await Promise.all([
                patch(appOn, p1, [{ question_id: q2, result: 0, retrain: true }]),
                patch(appOn, p1, [{ question_id: q2, result: 0, retrain: true }])
            ]);
            assert.deepEqual([x.status, y.status], [200, 200]);
            assert.equal(x.body.retrain.entered + y.body.retrain.entered, 1);
            const { rows: [m] } = await query('SELECT COUNT(*)::int AS n FROM retrain_items WHERE question_id = $1', [q2]);
            assert.equal(m.n, 1);
        });

        // ───────────────────── TC-039-3：刪卷、刪學生、合併學生（第 3.9 節）─────────────────────

        test('刪卷：原卷的題已在重練中 → 409（依排程項目判斷）；刪重練卷後重算；沒重練過的項目隨原卷一起刪', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const s = await createStudent('刪卷生');
            const p1 = await confirmPaper(s, [q1, q2]);
            const p2 = await confirmPaper(s, [q3]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }]);
            await patch(appOn, p2, [{ question_id: q3, result: 0, retrain: true }]);
            const { paperId: r1 } = await retrainPaper(s, [q1], today);
            await patch(appOn, r1, [{ question_id: q1, result: 1 }]);
            assert.equal((await itemOf(s, q1)).step, 2);

            const blocked = await request(appOn).delete(`/api/papers/${p1}`);
            assert.deepEqual([blocked.status, blocked.body], [409, {
                message: `這張卷有 1 題已經在錯題重練中（重練卷 #${r1}），請先刪除那些重練卷。`,
                question_ids: [q1],
                retrain_paper_ids: [r1]
            }]);
            assert.ok(await itemOf(s, q1));

            // 刪重練卷 → 項目依剩下的歷史重算（回第 1 關）
            const dr = await request(appOn).delete(`/api/papers/${r1}`);
            assert.deepEqual([dr.status, dr.body], [200, { deleted_attempts: 1 }]);
            const back = await assertCacheMatchesHistory(s, q1);
            assert.deepEqual([back.step, back.streak, back.due_on], [1, 0, day(1)]);

            // 原卷：項目沒重練過 → 連項目一起刪，題目回到候選池
            const d1 = await request(appOn).delete(`/api/papers/${p1}`);
            assert.deepEqual([d1.status, d1.body], [200, { deleted_attempts: 2 }]);
            assert.equal(await itemOf(s, q1), null);
            // 旗標關閉時照樣處理（資料完整性不受旗標管）
            await withRetrain(false, async app => {
                const d2 = await request(app).delete(`/api/papers/${p2}`);
                assert.deepEqual([d2.status, d2.body], [200, { deleted_attempts: 1 }]);
            });
            assert.equal(await itemCount(s), 0);
            const draft = await request(appOn).post('/api/generate-paper')
                .send({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true });
            assert.deepEqual([...draft.body.question_ids].sort((a, b) => a - b), [q1, q2, q3]);
        });

        test('刪學生：重練派題 → 排程項目 → 其餘派題 → 卷 → 學生；deleted.attempts 是派題筆數；別人的項目不動', async () => {
            const [q1, q2] = await seedQuestions(2);
            const s = await createStudent('刪學生重練生');
            const t = await createStudent('刪學生對照生');
            const p1 = await confirmPaper(s, [q1, q2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }, { question_id: q2, result: 0, retrain: true }]);
            await retrainPaper(s, [q1, q2], today);
            const pt = await confirmPaper(t, [q1]);
            await patch(appOn, pt, [{ question_id: q1, result: 0, retrain: true }]);

            const del = await request(appOn).delete(`/api/students/${s}`);
            assert.deepEqual([del.status, del.body], [200, { deleted: { attempts: 4, papers: 2 } }]);
            assert.equal(await itemCount(s), 0);
            assert.equal(await itemCount(t), 1);
            const { rows } = await query('SELECT student_id, purpose FROM assignment_attempts ORDER BY assignment_id');
            assert.deepEqual(rows, [{ student_id: t, purpose: 'new' }]);
        });

        test('合併學生：衝突題的來源側項目一起刪；其餘項目（含重練派題）搬到目標並重算；外鍵延後到 COMMIT 檢查', async () => {
            const [q1, q2, q3] = await seedQuestions(3);
            const from = await createStudent('分身（排程）');
            const into = await createStudent('本尊（排程）');
            const pf = await confirmPaper(from, [q1, q2, q3]);
            await patch(appOn, pf, [{ question_id: q1, result: 0, retrain: true }, { question_id: q2, result: 0, retrain: true }]);
            const { paperId: rf } = await retrainPaper(from, [q2], today);
            await patch(appOn, rf, [{ question_id: q2, result: 1 }]);
            const pt = await confirmPaper(into, [q1]);
            await patch(appOn, pt, [{ question_id: q1, result: 1, retrain: true }]);
            const intoItem = await itemOf(into, q1);
            const fromQ2 = await itemOf(from, q2);

            const res = await request(appOn).post(`/api/students/${from}/merge`).send({ into_id: into });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            // q1 衝突：來源側的新題派題（1 筆）與項目一起刪；q2 新題＋重練、q3 新題搬家；兩張卷搬家
            assert.deepEqual(res.body, { moved_attempts: 3, dropped_conflicts: 1, moved_papers: 2 });
            assert.deepEqual(await itemOf(into, q1), intoItem, '目標側的項目原封不動');
            const moved = await assertCacheMatchesHistory(into, q2);
            assert.deepEqual([moved.id, moved.step, moved.streak], [fromQ2.id, 2, 1], '項目搬到目標、重練紀錄跟著走');
            assert.equal(await itemCount(from), 0);
            const { rows: [link] } = await query(
                `SELECT s.student_id, i.student_id AS item_student FROM assignments s JOIN retrain_items i ON i.id = s.retrain_item_id
                  WHERE s.paper_id = $1`, [rf]);
            assert.deepEqual(link, { student_id: into, item_student: into });
        });

        // ───────────────────── TC-037-2：npm run retrain:recompute ─────────────────────

        test('retrain:recompute：--dry-run 不寫、正式執行冪等、不建立任何項目、改了參數後到期日照新參數重排', async () => {
            const [q1, q2] = await seedQuestions(2);
            const s = await createStudent('重算生');
            const p1 = await confirmPaper(s, [q1, q2]);
            await patch(appOn, p1, [{ question_id: q1, result: 0, retrain: true }, { question_id: q2, result: 0 }]);
            const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/recompute_retrain.js', '--test', ...args], {
                cwd: APP_DIR, encoding: 'utf8',
                env: { ...process.env, TEST_DATABASE_URL, RETRAIN_STEP_DAYS: '', RETRAIN_MASTERY_STREAK: '', ...env }
            });

            const same = run([]);
            assert.equal(same.status, 0, same.stderr);
            assert.match(same.stdout, /重算 1 個項目（1 位學生）；更新 0 個項目/);

            const dry = run(['--dry-run'], { RETRAIN_STEP_DAYS: '2,7,14' });
            assert.equal(dry.status, 0, dry.stderr);
            assert.match(dry.stdout, /每關間隔 2,7,14 天/);
            assert.match(dry.stdout, /會更新 1 個項目（dry-run，已 ROLLBACK，未寫入）/);
            assert.match(dry.stdout, /各狀態題數：進行中 1、練到會 0、移出 0/);
            assert.equal((await itemOf(s, q1)).due_on, day(1), 'dry-run 不寫');

            const real = run([], { RETRAIN_STEP_DAYS: '2,7,14' });
            assert.equal(real.status, 0, real.stderr);
            assert.match(real.stdout, /更新 1 個項目/);
            assert.equal((await itemOf(s, q1)).due_on, day(2), '照新參數重排');
            const again = run([], { RETRAIN_STEP_DAYS: '2,7,14' });
            assert.match(again.stdout, /更新 0 個項目/, '冪等');
            assert.equal(await itemCount(), 1, '不建立任何項目（答錯沒勾的 q2 不會被補建）');

            const other = run(['--student', String(s + 1000)], {});
            assert.match(other.stdout, /重算 0 個項目/);
            const back = run(['--student', String(s)], {});
            assert.match(back.stdout, /更新 1 個項目/);
            assert.equal((await itemOf(s, q1)).due_on, day(1));

            const bad = run(['--students', '1']);
            assert.equal(bad.status, 1);
            assert.match(bad.stderr, /未知的參數「--students」/);
        });
    });
}
