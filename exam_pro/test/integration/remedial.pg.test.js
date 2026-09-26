// ─────────────────────────────────────────────────────────────
// remedial.pg.test.js — 出題閉環的整合測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條；DEC-016）
//
// 涵蓋：
//   GET  /api/students/:id/weakness/kc   加權、COALESCE(score, result)、Wilson 排序、時間窗、科目、untagged_graded
//   POST /api/students/:id/remedial-paper  kc 基底、chapter 退回、各 bucket 配額、不足量、已作答排除、
//                                          家族互斥、承上題整組（items 帶 follows_question_id／group_ids）、
//                                          題源過濾、不寫庫、接 confirm-paper
//   GET  /api/students/:id/remedial-paper/items  手動加題前的查詢：承上組完整成員、封存與已寫過的旗標、missing
//   POST /api/generate-paper（blueprint）  跨章配額、難度區間、跨列家族互斥與不重複、不足量逐列回報、互斥 400；
//                                          單章路徑收到非字串 chapter 時與抽出候選池前相同（400 庫存不足，不是多章或 500）
//   GET  /api/coverage                    章 × 難度、封存不計、unseen_by_student、知識點題數
//   FEATURE_REMEDIAL 關閉 → 四支 404
//
// 契約第 2 條：本 WS 的測試**自己插入**知識點、question_kcs、kc_prerequisites、attempts fixture，
// 不假設 WS-C 已載入任何知識點。題幹全為自製內容。
//
// 三道防線同 students.pg.test.js：只讀 TEST_DATABASE_URL、庫名須 _test 結尾、require config/db 前覆寫 DATABASE_URL。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('出題閉環整合測試（需要 PostgreSQL）', {
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
    // low_sample 與 kc 基底的門檻：明確釘成預設值，不受開發機 .env 影響
    process.env.WEAKNESS_MIN_N = '5';

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /** routes/index.js 在 require 當下讀旗標：清快取重讀，才能在同一行程驗「開」與「關」（同 students.pg.test.js）。 */
    function loadApp(flag) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_REMEDIAL;
        process.env.FEATURE_REMEDIAL = flag;
        try {
            return require(APP_PATH);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_REMEDIAL;
            else process.env.FEATURE_REMEDIAL = saved;
        }
    }
    const appDisabled = loadApp('false');
    const app = loadApp('true');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    // 〔retrain PR-1〕attempts 是唯讀檢視（migrations/0016），夾具改用 helper 寫派題＋作答
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const { wilsonLowerBound, round4 } = require(path.join(APP_DIR, 'services', 'kcWeaknessService'));
    const { CHAPTERS, SUBJECTS } = require(path.join(APP_DIR, 'config', 'chapters'));

    // ─────────────────── fixture 輔助 ───────────────────
    let seq = 0;

    /** 建一題，回傳 id。 */
    async function addQ({ subject = '數學', chapter = '向量內積', difficulty = 3, type = '填空', variantOf = null,
        follows = null, archived = false, source = 'unknown' } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    variant_of, follows_question_id, follows_src, source_type, archived_at)
             VALUES ($1, $2, $3, $4, $5, '自製答案', $6, $7, $8, $9, CASE WHEN $10 THEN now() END) RETURNING id`,
            [subject, chapter, type, difficulty, `自製補救卷測試題 ${++seq}：設 $x=${seq}$，求 $2x$。`,
                variantOf, follows, follows === null ? null : 'human', source, archived]
        );
        return r.id;
    }

    /** 同章同難度建 n 題。 */
    async function addMany(n, opts) {
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(await addQ(opts));
        return ids;
    }

    async function addKc(code, { subject = '數學', chapter = '向量內積', name = code, sort = 1 } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO knowledge_components (code, subject, chapter, name, sort, status)
             VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING id`,
            [code, subject, chapter, name, sort]
        );
        return r.id;
    }

    async function tag(questionId, kcId, weight = 1) {
        await query(`INSERT INTO question_kcs (question_id, kc_id, weight, src) VALUES ($1, $2, $3, 'human')`, [questionId, kcId, weight]);
    }

    async function prereq(kcId, prereqId, strength = 1) {
        await query(`INSERT INTO kc_prerequisites (kc_id, prereq_kc_id, strength, src) VALUES ($1, $2, $3, 'human')`, [kcId, prereqId, strength]);
    }

    async function addStudent(name = `補救測試生${++seq}`) {
        const { rows: [r] } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id, name', [name]);
        return r;
    }

    /** 直接寫一筆作答（paper_id 為 NULL；assigned_at = 今天往前 daysAgo 天）。 */
    async function attempt(studentId, questionId, { result = null, score = null, daysAgo = 0 } = {}) {
        await insertAttempts(query, [{
            student_id: studentId, question_id: questionId, days_ago: daysAgo,
            result, score, graded_at: result === null ? null : 'now'
        }]);
    }

    async function count(table) {
        const { rows: [r] } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        return r.n;
    }

    async function questionRows(ids) {
        const { rows } = await query('SELECT * FROM questions WHERE id = ANY($1::int[])', [ids]);
        return new Map(rows.map(r => [r.id, r]));
    }

    async function kcIdsOf(questionId) {
        const { rows } = await query('SELECT kc_id FROM question_kcs WHERE question_id = $1', [questionId]);
        return rows.map(r => r.kc_id);
    }

    const remedialPaper = (studentId, body) => request(app).post(`/api/students/${studentId}/remedial-paper`).send(body);

    /** 斷言：鏈要嘛整組在、要嘛整組不在；在的話相鄰且依承接順序。回傳是否在。 */
    function chainState(ids, chain) {
        const present = chain.filter(id => ids.includes(id));
        if (present.length === 0) return false;
        assert.equal(present.length, chain.length, `承上組必須整組出現：${JSON.stringify({ ids, chain })}`);
        const start = ids.indexOf(chain[0]);
        assert.deepEqual(ids.slice(start, start + chain.length), chain, '承上組必須相鄰且依承接順序');
        return true;
    }

    describe('出題閉環（階段 5 WS-D）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });

        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
        });

        after(async () => {
            // 不把知識點 fixture 留給後面的測試檔（它們只 TRUNCATE 自己的表）
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
            await pool.end();
        });

        // ───────────────────────── 旗標 ─────────────────────────
        describe('FEATURE_REMEDIAL 關閉 → 路由不掛載（404）', () => {
            test('四支 API 都是 404', async () => {
                const s = await addStudent();
                const q = await addQ();
                const a = await request(appDisabled).get(`/api/students/${s.id}/weakness/kc`);
                const b = await request(appDisabled).post(`/api/students/${s.id}/remedial-paper`).send({ subject: '數學' });
                const c = await request(appDisabled).get('/api/coverage');
                const d = await request(appDisabled).get(`/api/students/${s.id}/remedial-paper/items?ids=${q}`);
                assert.equal(a.status, 404);
                assert.equal(b.status, 404);
                assert.equal(c.status, 404);
                assert.equal(d.status, 404);
            });

            test('blueprint 是既有 generate-paper 的擴充，不吃這個旗標', async () => {
                const s = await addStudent();
                await addMany(2, { chapter: '向量內積' });
                const res = await request(appDisabled).post('/api/generate-paper')
                    .send({ student_id: s.id, subject: '數學', blueprint: [{ chapter: '向量內積', count: 2 }], dry_run: true });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.question_ids.length, 2);
            });
        });

        // ───────────────────────── 知識點弱點 ─────────────────────────
        describe('GET /api/students/:id/weakness/kc', () => {
            test('404：:id 不是正整數或學生不存在；400：subject／days 不合法', async () => {
                assert.equal((await request(app).get('/api/students/abc/weakness/kc')).status, 404);
                assert.equal((await request(app).get('/api/students/999/weakness/kc')).status, 404);
                // 〔stage5 審查修正〕超過 int4 上限：404（以前是 PG out of range 的 500）
                assert.equal((await request(app).get('/api/students/3000000000/weakness/kc')).status, 404);
                assert.equal((await request(app).post('/api/students/3000000000/remedial-paper').send({ subject: '數學' })).status, 404);
                const s = await addStudent();
                const bad1 = await request(app).get(`/api/students/${s.id}/weakness/kc?subject=生物`);
                assert.equal(bad1.status, 400);
                assert.equal(bad1.body.message, 'subject 不在白名單內。');
                const bad2 = await request(app).get(`/api/students/${s.id}/weakness/kc?days=0`);
                assert.equal(bad2.status, 400);
                assert.equal(bad2.body.message, 'days 必須是 1~365 的整數。');
            });

            test('以 weight 加權、正確度 = COALESCE(score, result)、Wilson 下界排序、科目與時間窗、untagged_graded', async () => {
                const s = await addStudent();
                const k1 = await addKc('MATH.向量內積.01', { name: '內積的意義', sort: 1 });
                const k2 = await addKc('MATH.向量內積.02', { name: '內積的坐標算法', sort: 2 });
                const k3 = await addKc('MATH.向量內積.03', { name: '正射影', sort: 3 });
                const kp = await addKc('PHYS.靜電學.01', { subject: '物理', chapter: '靜電學', name: '庫侖定律' });

                const q1 = await addQ(); await tag(q1, k1, 1);
                const q2 = await addQ(); await tag(q2, k1, 0.5); await tag(q2, k2, 1);
                const q3 = await addQ();                                  // 沒有標註
                const q4 = await addQ(); await tag(q4, k3, 1);            // 只指派、沒批改
                const q5 = await addQ({ subject: '物理', chapter: '靜電學' }); await tag(q5, kp, 1);
                const q6 = await addQ(); await tag(q6, k1, 1);            // 200 天前的作答

                await attempt(s.id, q1, { result: 1 });
                await attempt(s.id, q2, { result: 0, score: 0.5 });       // 部分給分：正確度 0.5
                await attempt(s.id, q3, { result: 0 });
                await attempt(s.id, q4);
                await attempt(s.id, q5, { result: 1 });
                await attempt(s.id, q6, { result: 0, daysAgo: 200 });

                const res = await request(app).get(`/api/students/${s.id}/weakness/kc?subject=數學&days=90`);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['rows', 'untagged_graded']);
                assert.equal(res.body.untagged_graded, 1);
                const byCode = Object.fromEntries(res.body.rows.map(r => [r.code, r]));
                assert.deepEqual(Object.keys(byCode).sort(), ['MATH.向量內積.01', 'MATH.向量內積.02', 'MATH.向量內積.03'], '物理知識點不在數學篩選內');

                // K1：q1（w=1，對）＋ q2（w=0.5，0.5 分）→ graded 1.5、correct 1.25
                assert.deepEqual(byCode['MATH.向量內積.01'], {
                    kc_id: k1, code: 'MATH.向量內積.01', name: '內積的意義', subject: '數學', chapter: '向量內積',
                    graded: 1.5, correct: 1.25, correct_rate: round4(1.25 / 1.5),
                    mastery_lb: round4(wilsonLowerBound(1.25, 1.5)), low_sample: true
                });
                // K2：q2（w=1，0.5 分）
                assert.equal(byCode['MATH.向量內積.02'].graded, 1);
                assert.equal(byCode['MATH.向量內積.02'].correct, 0.5);
                assert.equal(byCode['MATH.向量內積.02'].mastery_lb, round4(wilsonLowerBound(0.5, 1)));
                // K3：只指派沒批改 → 沒資料
                assert.deepEqual([byCode['MATH.向量內積.03'].graded, byCode['MATH.向量內積.03'].correct_rate,
                    byCode['MATH.向量內積.03'].mastery_lb, byCode['MATH.向量內積.03'].low_sample], [0, null, null, true]);

                // 排序：mastery_lb 由低到高，沒有批改的排最後
                const expectOrder = [['MATH.向量內積.01', wilsonLowerBound(1.25, 1.5)], ['MATH.向量內積.02', wilsonLowerBound(0.5, 1)]]
                    .sort((a, b) => a[1] - b[1]).map(x => x[0]);
                assert.deepEqual(res.body.rows.map(r => r.code), [...expectOrder, 'MATH.向量內積.03']);

                // 不分科：物理知識點出現；時間窗 365：K1 多算 200 天前那一題
                const all = await request(app).get(`/api/students/${s.id}/weakness/kc?days=365`);
                const allBy = Object.fromEntries(all.body.rows.map(r => [r.code, r]));
                assert.equal(allBy['PHYS.靜電學.01'].correct_rate, 1);
                assert.equal(allBy['MATH.向量內積.01'].graded, 2.5);
                assert.equal(allBy['MATH.向量內積.01'].correct, 1.25);
            });

            test('沒有任何作答 → rows 為空、untagged_graded 為 0', async () => {
                const s = await addStudent();
                const res = await request(app).get(`/api/students/${s.id}/weakness/kc`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { rows: [], untagged_graded: 0 });
            });
        });

        // ───────────────────────── 補救卷 ─────────────────────────
        describe('POST /api/students/:id/remedial-paper', () => {
            test('400：參數驗證；404：學生不存在或 :id 不合法', async () => {
                const s = await addStudent();
                const cases = [
                    [{}, /subject/],
                    [{ subject: '生物' }, /subject/],
                    [{ subject: '數學', total: 4 }, /total/],
                    [{ subject: '數學', total: 51 }, /total/],
                    [{ subject: '數學', mix: { remedial: 0, prerequisite: 0, extension: 0 } }, /mix/],
                    [{ subject: '數學', mix: { remedial: 1 } }, /mix/],
                    [{ subject: '數學', mix: { remedial: 1e308, prerequisite: 1e308, extension: 0 } }, /mix/],   // 總和溢位成 Infinity
                    [{ subject: '數學', days: 400 }, /days/],
                    [{ subject: '數學', source_types: ['bogus'] }, /source_types/]
                ];
                for (const [body, re] of cases) {
                    const res = await remedialPaper(s.id, body);
                    assert.equal(res.status, 400, JSON.stringify(body));
                    assert.match(res.body.message, re);
                }
                assert.equal((await remedialPaper(999, { subject: '數學' })).status, 404);
                assert.equal((await remedialPaper('x1', { subject: '數學' })).status, 404);
            });

            test('chapter 退回：沒有知識點標註時以章節為單位；補救 ≤ 難度上限、延伸 ≥ 難度下限、先備併入補救、不足量回報、不寫庫', async () => {
                const s = await addStudent();
                // 批改紀錄：向量內積 4 題對 1（答錯題難度 2、2、3 → 上限 ⌊2.33+1⌋ = 3）；排列 4 題全對（難度 2 → 延伸下限 3）
                const graded = [];
                for (const [d, r] of [[2, 0], [2, 0], [3, 0], [3, 1]]) {
                    const q = await addQ({ chapter: '向量內積', difficulty: d }); graded.push(q);
                    await attempt(s.id, q, { result: r });
                }
                for (let i = 0; i < 4; i++) {
                    const q = await addQ({ chapter: '排列', difficulty: 2 }); graded.push(q);
                    await attempt(s.id, q, { result: 1 });
                }
                // 候選：兩章各難度 1–5 兩題；另有封存題、物理題（都不得出現）
                for (let d = 1; d <= 5; d++) {
                    await addMany(2, { chapter: '向量內積', difficulty: d });
                    await addMany(2, { chapter: '排列', difficulty: d });
                }
                const archived = await addQ({ chapter: '向量內積', difficulty: 1, archived: true });
                const physics = await addQ({ subject: '物理', chapter: '靜電學', difficulty: 1 });
                const papersBefore = await count('exam_papers');
                const attemptsBefore = await count('attempts');

                const res = await remedialPaper(s.id, { subject: '數學', total: 10 });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                const body = res.body;
                assert.deepEqual(Object.keys(body), ['student_id', 'subject', 'basis', 'question_ids', 'items', 'blueprint', 'shortfalls', 'notes']);
                assert.equal(body.student_id, s.id);
                assert.equal(body.subject, '數學');
                assert.equal(body.basis, 'chapter');

                // 10 題 → 6／2／2；先備併入補救 → 補救 8（向量內積 ≤ 3 只有 6 題）、延伸 2（排列 ≥ 3）
                assert.deepEqual(body.blueprint.map(b => [b.bucket, b.target, b.wanted, b.got, b.difficulty_min, b.difficulty_max]), [
                    ['remedial', { type: 'chapter', chapter: '向量內積', name: '向量內積' }, 8, 6, null, 3],
                    ['extension', { type: 'chapter', chapter: '排列', name: '排列' }, 2, 2, 3, null]
                ]);
                assert.deepEqual(body.shortfalls, [
                    { bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 8, got: 6, reason: 'insufficient_stock' }
                ]);
                assert.ok(body.notes.some(n => n.includes('先備配額 2 題併入補救')), body.notes.join('\n'));
                assert.ok(body.notes.some(n => n.includes('本草稿實際 8 題（要求 10 題）')), body.notes.join('\n'));

                assert.equal(body.question_ids.length, 8);
                assert.deepEqual([...body.question_ids].sort((a, b) => a - b), body.items.map(i => i.question_id).sort((a, b) => a - b));
                const rows = await questionRows(body.question_ids);
                for (const item of body.items) {
                    const q = rows.get(item.question_id);
                    assert.equal(item.chapter, q.chapter);
                    assert.equal(item.difficulty, q.difficulty);
                    assert.ok(item.question_text_preview.startsWith('自製補救卷測試題'));
                    assert.equal(q.subject, '數學');
                    assert.equal(q.archived_at, null);
                    if (item.bucket === 'remedial') { assert.equal(q.chapter, '向量內積'); assert.ok(q.difficulty <= 3); }
                    else { assert.equal(item.bucket, 'extension'); assert.equal(q.chapter, '排列'); assert.ok(q.difficulty >= 3); }
                }
                for (const id of [...graded, archived, physics]) assert.ok(!body.question_ids.includes(id), `不該出現 #${id}`);

                // 只產草稿：一個位元組都沒寫
                assert.equal(await count('exam_papers'), papersBefore);
                assert.equal(await count('attempts'), attemptsBefore);

                // 老師確認沿用既有 confirm-paper
                const ok = await request(app).post('/api/confirm-paper').send({ student_id: s.id, question_ids: body.question_ids });
                assert.equal(ok.status, 200, JSON.stringify(ok.body));
                assert.equal(await count('attempts'), attemptsBefore + 8);
                assert.deepEqual(ok.body.question_ids, body.question_ids, 'question_ids 已是確認後的出題順序');
            });

            test('kc 基底：有標註的已批改題 ≥ WEAKNESS_MIN_N；三個 bucket 各有配額，先備取弱知識點的先備、跨科先備不納入', async () => {
                const s = await addStudent();
                const ka = await addKc('MATH.向量內積.02', { name: '內積的坐標算法', sort: 2 });
                const kb = await addKc('MATH.向量內積.03', { name: '正射影', sort: 3 });
                const kpre = await addKc('MATH.向量的加減與係數積.01', { chapter: '向量的加減與係數積', name: '向量的坐標表示' });
                const kx = await addKc('PHYS.平面運動.01', { subject: '物理', chapter: '平面運動', name: '速度的分解' });
                await prereq(ka, kpre);
                await prereq(ka, kx);

                // 批改：KA 4 題全錯（難度 2）；KB 3 題全對（難度 2）→ 有標註的已批改 7 題 ≥ 5
                for (let i = 0; i < 4; i++) { const q = await addQ({ difficulty: 2 }); await tag(q, ka); await attempt(s.id, q, { result: 0 }); }
                for (let i = 0; i < 3; i++) { const q = await addQ({ difficulty: 2 }); await tag(q, kb); await attempt(s.id, q, { result: 1 }); }

                // 候選：KA 難度 1–3 各 2 題；KPre 難度 1–5 各 1 題；KB 難度 3–5 各 1 題；未標註題若干（不得出現）
                for (let d = 1; d <= 3; d++) for (const q of await addMany(2, { difficulty: d })) await tag(q, ka);
                for (let d = 1; d <= 5; d++) { const q = await addQ({ chapter: '向量的加減與係數積', difficulty: d }); await tag(q, kpre); }
                for (let d = 3; d <= 5; d++) { const q = await addQ({ difficulty: d }); await tag(q, kb); }
                const untagged = await addMany(3, { difficulty: 1 });

                const res = await remedialPaper(s.id, { subject: '數學', total: 10 });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                const body = res.body;
                assert.equal(body.basis, 'kc');
                assert.deepEqual(body.blueprint.map(b => [b.bucket, b.target.type, b.target.code, b.wanted, b.got]), [
                    ['remedial', 'kc', 'MATH.向量內積.02', 6, 6],
                    ['prerequisite', 'kc', 'MATH.向量的加減與係數積.01', 2, 2],
                    ['extension', 'kc', 'MATH.向量內積.03', 2, 2]
                ]);
                assert.deepEqual(body.blueprint[1].target, { type: 'kc', code: 'MATH.向量的加減與係數積.01', chapter: '向量的加減與係數積', name: '向量的坐標表示' });
                assert.deepEqual(body.shortfalls, []);
                assert.ok(body.notes.some(n => n.includes('速度的分解') && n.includes('物理')), body.notes.join('\n'));
                assert.equal(body.question_ids.length, 10);

                const rows = await questionRows(body.question_ids);
                const expectKc = { remedial: ka, prerequisite: kpre, extension: kb };
                for (const item of body.items) {
                    assert.ok((await kcIdsOf(item.question_id)).includes(expectKc[item.bucket]), `#${item.question_id} 應掛 ${item.bucket} 的知識點`);
                    const d = rows.get(item.question_id).difficulty;
                    if (item.bucket === 'remedial') assert.ok(d <= 3);
                    if (item.bucket === 'prerequisite') assert.ok(d <= 3, '先備取基礎題');
                    if (item.bucket === 'extension') assert.ok(d >= 3);
                }
                for (const id of untagged) assert.ok(!body.question_ids.includes(id));
                // items 依 bucket 分組：remedial → prerequisite → extension
                const order = body.items.map(i => i.bucket);
                assert.deepEqual(order, [...order].sort((a, b) => ['remedial', 'prerequisite', 'extension'].indexOf(a) - ['remedial', 'prerequisite', 'extension'].indexOf(b)));
            });

            test('有標註但不足 WEAKNESS_MIN_N → 退回章節並在 notes 說明', async () => {
                const s = await addStudent();
                const k = await addKc('MATH.向量內積.01');
                for (let i = 0; i < 2; i++) { const q = await addQ({ difficulty: 2 }); await tag(q, k); await attempt(s.id, q, { result: 0 }); }
                await addMany(5, { difficulty: 1 });
                const res = await remedialPaper(s.id, { subject: '數學', total: 5 });
                assert.equal(res.status, 200);
                assert.equal(res.body.basis, 'chapter');
                assert.match(res.body.notes[0], /有知識點標註的已批改題只有 2 題/);
            });

            test('mix 配額：只要延伸時 remedial／prerequisite 都是 0；家族互斥與承上題整組照 generate-paper 的規則', async () => {
                const s = await addStudent();
                // 兩章有批改：向量內積弱、排列強
                for (const r of [0, 0, 0]) { const q = await addQ({ chapter: '向量內積', difficulty: 3 }); await attempt(s.id, q, { result: r }); }
                for (const r of [1, 1, 1]) { const q = await addQ({ chapter: '排列', difficulty: 1 }); await attempt(s.id, q, { result: r }); }
                // 排列（延伸，難度 ≥ 2）：一個 4 題的變式家族、一條 2 題承上鏈、一條前題已寫過的承上鏈、3 題單題
                const root = await addQ({ chapter: '排列', difficulty: 2 });
                const family = [root];
                for (let i = 0; i < 3; i++) family.push(await addQ({ chapter: '排列', difficulty: 2, variantOf: root }));
                const chain = [await addQ({ chapter: '排列', difficulty: 2 })];
                chain.push(await addQ({ chapter: '排列', difficulty: 2, follows: chain[0] }));
                const burnt = [await addQ({ chapter: '排列', difficulty: 2 })];
                burnt.push(await addQ({ chapter: '排列', difficulty: 2, follows: burnt[0] }));
                await attempt(s.id, burnt[0]);                             // 前題已指派 → 承上題不得單獨出現
                const singles = await addMany(3, { chapter: '排列', difficulty: 2 });

                const res = await remedialPaper(s.id, { subject: '數學', total: 20, mix: { remedial: 0, prerequisite: 0, extension: 1 } });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                const body = res.body;
                assert.deepEqual(body.blueprint.map(b => [b.bucket, b.target.chapter, b.wanted, b.got]), [['extension', '排列', 20, 6]]);
                assert.equal(body.shortfalls[0].reason, 'insufficient_stock');
                const ids = body.question_ids;
                assert.equal(family.filter(id => ids.includes(id)).length, 1, '同一變式家族在一張卷只取一題');
                assert.ok(chainState(ids, chain), '承上鏈整組出現');
                assert.ok(!ids.includes(burnt[1]), '前題已作答的承上題不得單獨出現');
                for (const id of singles) assert.ok(ids.includes(id));

                // items 帶承上組資訊：前端據此標「承上 #x」並整組刪（confirm-paper 另有伺服器端整組檢查，〔Owner 決策單 2026-09-25 B7〕）
                const byId = Object.fromEntries(body.items.map(i => [i.question_id, i]));
                assert.deepEqual([byId[chain[0]].follows_question_id, byId[chain[0]].group_ids], [null, chain]);
                assert.deepEqual([byId[chain[1]].follows_question_id, byId[chain[1]].group_ids], [chain[0], chain]);
                for (const id of singles) assert.deepEqual([byId[id].follows_question_id, byId[id].group_ids], [null, [id]]);
            });

            test('source_types 過濾與 generate-paper 同規則', async () => {
                const s = await addStudent();
                for (const r of [0, 0]) { const q = await addQ({ difficulty: 2 }); await attempt(s.id, q, { result: r }); }
                const self = await addMany(2, { difficulty: 1, source: 'self' });
                await addMany(3, { difficulty: 1, source: 'publisher' });
                const res = await remedialPaper(s.id, { subject: '數學', total: 5, source_types: ['self'] });
                assert.equal(res.status, 200);
                assert.deepEqual([...res.body.question_ids].sort((a, b) => a - b), self);
            });

            test('沒有任何批改：200、空草稿、notes 說明原因', async () => {
                const s = await addStudent();
                await addMany(3);
                const res = await remedialPaper(s.id, { subject: '數學' });
                assert.equal(res.status, 200);
                assert.deepEqual([res.body.question_ids, res.body.items, res.body.blueprint, res.body.shortfalls], [[], [], [], []]);
                assert.match(res.body.notes[0], /沒有已批改的題/);
            });
        });

        // ───────────────────── 手動加題前的查詢 ─────────────────────
        describe('GET /api/students/:id/remedial-paper/items', () => {
            const items = (studentId, ids) => request(app).get(`/api/students/${studentId}/remedial-paper/items?ids=${ids}`);

            test('404：:id 不合法或學生不存在；400：ids 不合法', async () => {
                assert.equal((await items('abc', '1')).status, 404);
                assert.equal((await items(999, '1')).status, 404);
                assert.equal((await items(3000000000, '1')).status, 404, '〔審查修正〕超過 int4 上限');
                const s = await addStudent();
                for (const bad of ['', 'x', '0', '1,,2', '2147483648', Array.from({ length: 51 }, (_, i) => i + 1).join(',')]) {
                    const res = await items(s.id, bad);
                    assert.equal(res.status, 400, bad);
                    assert.match(res.body.message, /ids 必須是 1~50 個以逗號分隔的正整數/);
                }
                assert.equal((await request(app).get(`/api/students/${s.id}/remedial-paper/items`)).status, 400, '缺 ids');
            });

            test('回題目與所在承上組的全部成員（承接順序）、封存與已寫過的旗標、查不到的 id；不寫庫', async () => {
                const s = await addStudent();
                // 鏈 lead ← f1 ← f2；另一條鏈的前題他寫過；封存題；物理題
                const lead = await addQ({ chapter: '向量內積', difficulty: 2 });
                const f1 = await addQ({ chapter: '向量內積', difficulty: 3, follows: lead });
                const f2 = await addQ({ chapter: '向量內積', difficulty: 4, follows: f1 });
                const burnt = await addQ({ chapter: '排列' });
                const burntF = await addQ({ chapter: '排列', follows: burnt });
                await attempt(s.id, burnt, { result: 1 });
                const gone = await addQ({ archived: true });
                const phys = await addQ({ subject: '物理', chapter: '靜電學', difficulty: 1 });
                const attemptsBefore = await count('attempts');

                const res = await items(s.id, [f1, burntF, gone, phys, 99999, f2].join(','));
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['items', 'missing']);
                assert.deepEqual(res.body.missing, [99999]);
                assert.deepEqual(res.body.items.map(i => i.question_id), [lead, f1, f2, burnt, burntF, gone, phys],
                    '要 f1 → 整條鏈依承接順序；f2 已列過不重複');
                const by = Object.fromEntries(res.body.items.map(i => [i.question_id, i]));
                assert.deepEqual(Object.keys(by[f1]),
                    ['question_id', 'subject', 'chapter', 'difficulty', 'question_text_preview', 'follows_question_id', 'group_ids', 'archived', 'answered']);
                assert.deepEqual(by[f1], {
                    question_id: f1, subject: '數學', chapter: '向量內積', difficulty: 3,
                    question_text_preview: by[f1].question_text_preview, follows_question_id: lead,
                    group_ids: [lead, f1, f2], archived: false, answered: false
                });
                assert.ok(by[f1].question_text_preview.startsWith('自製補救卷測試題'));
                assert.deepEqual([by[lead].follows_question_id, by[lead].group_ids], [null, [lead, f1, f2]]);
                assert.deepEqual([by[burnt].answered, by[burntF].answered, by[burntF].group_ids], [true, false, [burnt, burntF]],
                    '前題他寫過：前端據此拒絕整組');
                assert.deepEqual([by[gone].archived, by[gone].group_ids], [true, [gone]]);
                assert.equal(by[phys].subject, '物理');
                assert.equal(await count('attempts'), attemptsBefore);
            });
        });

        // ───────────────────────── 跨章配額組卷 ─────────────────────────
        describe('POST /api/generate-paper 的 blueprint', () => {
            const gen = body => request(app).post('/api/generate-paper').send({ subject: '數學', ...body });

            test('400：與 chapter／count 互斥、列數、章節、count、難度、總和、必填', async () => {
                const s = await addStudent();
                const bp = [{ chapter: '向量內積', count: 1 }];
                const cases = [
                    [{ student_id: s.id, blueprint: bp, chapter: '向量內積' }, /不可同時使用/],
                    [{ student_id: s.id, blueprint: bp, count: 3 }, /不可同時使用/],
                    [{ student_id: s.id, blueprint: [] }, /1~10 列/],
                    [{ student_id: s.id, blueprint: [{ chapter: '靜電學', count: 1 }] }, /不在數學的章節白名單內/],
                    [{ student_id: s.id, blueprint: [{ chapter: '向量內積', count: 0 }] }, /count/],
                    [{ student_id: s.id, blueprint: [{ chapter: '向量內積', count: 1, difficulty_min: 5, difficulty_max: 1 }] }, /不得大於/],
                    [{ student_id: s.id, blueprint: [{ chapter: '向量內積', count: 30 }, { chapter: '排列', count: 21 }] }, /總和最多 50 題/],
                    [{ blueprint: bp }, /所有篩選欄位皆為必填/],
                    [{ student_id: s.id, subject: '生物', blueprint: bp }, /subject 不在白名單內/],
                    [{ student_id: s.id, blueprint: bp, exclude_ids: ['x'] }, /exclude_ids/]
                ];
                for (const [body, re] of cases) {
                    const res = await gen(body);
                    assert.equal(res.status, 400, JSON.stringify(body));
                    assert.match(res.body.message, re, JSON.stringify(body));
                }
                assert.equal((await gen({ student_id: 999, blueprint: bp })).status, 404);
            });

            test('dry_run：逐列依章節與難度區間抽題，回應形狀同既有＋blueprint／shortfalls，不寫庫', async () => {
                const s = await addStudent('藍圖生');
                for (let d = 1; d <= 5; d++) await addQ({ chapter: '向量內積', difficulty: d });
                await addQ({ chapter: '排列', difficulty: 1 });
                await addMany(2, { chapter: '排列', difficulty: 4 });
                await addQ({ chapter: '排列', difficulty: 5 });

                const res = await gen({ student_name: '藍圖生', dry_run: true,
                    blueprint: [{ chapter: '向量內積', count: 3 }, { chapter: '排列', count: 2, difficulty_min: 4 }] });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(),
                    ['blueprint', 'dry_run', 'message', 'paper_title_preview', 'question_ids', 'questions', 'shortfalls', 'student_id']);
                assert.equal(res.body.dry_run, true);
                assert.match(res.body.paper_title_preview, /^藍圖生-向量內積、排列特訓卷\(/);
                assert.deepEqual(res.body.blueprint, [
                    { chapter: '向量內積', difficulty_min: null, difficulty_max: null, wanted: 3, got: 3 },
                    { chapter: '排列', difficulty_min: 4, difficulty_max: null, wanted: 2, got: 2 }
                ]);
                assert.deepEqual(res.body.shortfalls, []);
                const rows = await questionRows(res.body.question_ids);
                assert.equal([...rows.values()].filter(q => q.chapter === '向量內積').length, 3);
                assert.ok([...rows.values()].filter(q => q.chapter === '排列').every(q => q.difficulty >= 4));
                assert.equal(res.body.questions.length, 5);
                assert.equal(await count('exam_papers'), 0);
                assert.equal(await count('attempts'), 0);
            });

            test('不足量不回 400：逐列回報 shortfalls＋note，照抽到的題出；全部列都抽不到才 400', async () => {
                const s = await addStudent();
                await addQ({ chapter: '向量內積', difficulty: 1 });
                await addMany(3, { chapter: '向量內積', difficulty: 4 });
                const res = await gen({ student_id: s.id, dry_run: true,
                    blueprint: [{ chapter: '向量內積', count: 2, difficulty_max: 1 }, { chapter: '向量內積', count: 1, difficulty_min: 4 }] });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.question_ids.length, 2);
                assert.deepEqual(res.body.shortfalls, [
                    { row: 1, chapter: '向量內積', difficulty_min: null, difficulty_max: 1, wanted: 2, got: 1, reason: 'insufficient_stock' }
                ]);
                assert.match(res.body.note, /第 1 列「向量內積」要 2 題只抽到 1 題（庫存不足）/);

                const none = await gen({ student_id: s.id, dry_run: true, blueprint: [{ chapter: '排列', count: 1 }] });
                assert.equal(none.status, 400);
                assert.match(none.body.message, /新題目庫存不足/);
                assert.deepEqual(none.body.shortfalls.map(x => x.row), [1]);
            });

            test('跨列：同一題不重複、同一變式家族至多一題', async () => {
                const s = await addStudent();
                const five = await addMany(5, { chapter: '向量內積', difficulty: 3 });
                const dup = await gen({ student_id: s.id, dry_run: true,
                    blueprint: [{ chapter: '向量內積', count: 3 }, { chapter: '向量內積', count: 3 }] });
                assert.equal(dup.status, 200);
                assert.equal(new Set(dup.body.question_ids).size, 5);
                assert.deepEqual([...dup.body.question_ids].sort((a, b) => a - b), five);
                assert.deepEqual(dup.body.blueprint.map(b => b.got), [3, 2]);

                const root = await addQ({ chapter: '組合', difficulty: 1 });
                const variant = await addQ({ chapter: '組合', difficulty: 5, variantOf: root });
                const fam = await gen({ student_id: s.id, dry_run: true,
                    blueprint: [{ chapter: '組合', count: 1, difficulty_max: 1 }, { chapter: '組合', count: 1, difficulty_min: 5 }] });
                assert.equal(fam.status, 200);
                assert.deepEqual(fam.body.question_ids, [root]);
                assert.ok(!fam.body.question_ids.includes(variant));
                assert.deepEqual(fam.body.shortfalls.map(x => [x.row, x.got]), [[2, 0]]);
            });

            test('承上題整組；真出卷寫入 exam_papers 與 attempts', async () => {
                const s = await addStudent();
                const chain = [await addQ({ chapter: '實數', type: '計算' })];
                chain.push(await addQ({ chapter: '實數', type: '計算', follows: chain[0] }));
                chain.push(await addQ({ chapter: '實數', type: '計算', follows: chain[1] }));
                await addMany(2, { chapter: '實數', type: '單選' });
                await addMany(2, { chapter: '排列' });

                const res = await gen({ student_id: s.id, blueprint: [{ chapter: '實數', count: 5 }, { chapter: '排列', count: 1 }] });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['blueprint', 'message', 'paper_id', 'paper_title', 'question_ids', 'questions', 'shortfalls']);
                assert.ok(chainState(res.body.question_ids, chain));
                assert.equal(res.body.question_ids.length, 6);
                const { rows: [paper] } = await query('SELECT question_ids FROM exam_papers WHERE id = $1', [res.body.paper_id]);
                assert.deepEqual(paper.question_ids, res.body.question_ids);
                assert.equal(await count('attempts'), 6);

                // 已作答排除：同一位學生再要一次實數，一題都沒有 → 400
                const again = await gen({ student_id: s.id, dry_run: true, blueprint: [{ chapter: '實數', count: 1 }] });
                assert.equal(again.status, 400);
            });
        });

        // ─────────── 單章路徑：候選池抽成共用函式後，非字串 chapter 的結果不變 ───────────
        describe('POST /api/generate-paper 的單章路徑（〔stage5 WS-D〕候選池抽出後逐字不變）', () => {
            test('chapter 是陣列或巢狀陣列：同抽出前的 `q.chapter = $2`，比不到任何章 → 400 庫存不足（不是多章卷、不是 500）', async () => {
                const s = await addStudent('探針生');
                await addMany(3, { chapter: '向量內積' });
                await addMany(3, { chapter: '排列' });
                for (const chapter of [['向量內積', '排列'], ['向量內積'], ['向量內積', ['排列']], { a: 1 }, 7]) {
                    const res = await request(app).post('/api/generate-paper')
                        .send({ student_id: s.id, subject: '數學', chapter, count: 2, dry_run: true });
                    assert.equal(res.status, 400, `${JSON.stringify(chapter)} → ${JSON.stringify(res.body)}`);
                    assert.equal(res.body.message, '新題目庫存不足！該章節 [探針生] 沒寫過的題目僅剩 0 題。');
                }
                // 字串照常
                const ok = await request(app).post('/api/generate-paper')
                    .send({ student_id: s.id, subject: '數學', chapter: '向量內積', count: 2, dry_run: true });
                assert.equal(ok.status, 200, JSON.stringify(ok.body));
                assert.equal(ok.body.question_ids.length, 2);
            });
        });

        // ───────────────────────── 題庫覆蓋率 ─────────────────────────
        describe('GET /api/coverage', () => {
            test('400／404', async () => {
                assert.equal((await request(app).get('/api/coverage?subject=生物')).status, 400);
                assert.equal((await request(app).get('/api/coverage?student_id=abc')).status, 400);
                assert.equal((await request(app).get('/api/coverage?student_id=3000000000')).status, 400, '〔審查修正〕超過 int4 上限');
                assert.equal((await request(app).get('/api/coverage?student_id=999')).status, 404);
            });

            test('章 × 難度、只算未封存題、白名單每一章都列、unseen_by_student、知識點題數', async () => {
                const s = await addStudent();
                const [a, b] = await addMany(2, { chapter: '向量內積', difficulty: 1 });
                const c = await addQ({ chapter: '向量內積', difficulty: 3 });
                const gone = await addQ({ chapter: '向量內積', difficulty: 5, archived: true });
                await addQ({ subject: '物理', chapter: '靜電學', difficulty: 2 });
                const k1 = await addKc('MATH.向量內積.01', { sort: 1 });
                await addKc('MATH.向量內積.02', { sort: 2 });
                await addKc('PHYS.靜電學.01', { subject: '物理', chapter: '靜電學' });
                for (const q of [a, c, gone]) await tag(q, k1);
                await attempt(s.id, b, { result: 1 });
                await attempt(s.id, gone, { result: 0 });

                const res = await request(app).get('/api/coverage?subject=數學');
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['kc_rows', 'rows']);
                assert.deepEqual(res.body.rows.map(r => r.chapter), CHAPTERS['數學']);
                const vec = res.body.rows.find(r => r.chapter === '向量內積');
                assert.deepEqual(vec, {
                    subject: '數學', volume: '第三冊(A/B)', chapter: '向量內積', total: 3,
                    by_difficulty: { 1: 2, 2: 0, 3: 1, 4: 0, 5: 0 }, unseen_by_student: null
                });
                assert.ok(res.body.rows.filter(r => r.chapter !== '向量內積').every(r => r.total === 0));
                assert.deepEqual(res.body.kc_rows, [
                    { code: 'MATH.向量內積.01', name: 'MATH.向量內積.01', chapter: '向量內積', total: 2 },
                    { code: 'MATH.向量內積.02', name: 'MATH.向量內積.02', chapter: '向量內積', total: 0 }
                ]);

                const withS = await request(app).get(`/api/coverage?subject=數學&student_id=${s.id}`);
                assert.equal(withS.body.rows.find(r => r.chapter === '向量內積').unseen_by_student, 2);
                assert.equal(withS.body.rows.find(r => r.chapter === '實數').unseen_by_student, 0);

                const all = await request(app).get('/api/coverage');
                assert.equal(all.body.rows.find(r => r.subject === '物理' && r.chapter === '靜電學').total, 1);
                // 科目一律讀白名單（化學併入後自動多 44 章，契約第 7 條）
                assert.equal(all.body.rows.length, SUBJECTS.reduce((n, subj) => n + CHAPTERS[subj].length, 0));
                assert.equal(all.body.kc_rows.length, 3);
            });
        });
    });
}
