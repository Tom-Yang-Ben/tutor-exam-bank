// ─────────────────────────────────────────────────────────────
// students.pg.test.js — 五支學生／試卷／批改 API 與弱點聚合的整合測試（P-02／P-04，擁有者：WS-A）
//
// 為什麼弱點面板一定要有這一層（docs/interfaces-stage3.md 第 1.6 條）：
//   純文字單測看不出 SQL 是對是錯。`ORDER BY wrong::float / NULLIF(graded,0)`
//   在字串比對眼中完全正常，送進 Postgres 才會報 column "wrong" does not exist；
//   而參數對調、FILTER 條件寫反、時間窗差一天，這些連語法錯都不算——
//   面板只會安靜地回一組看起來很合理但錯的數字。所以這裡拿 1,000 筆 fixture
//   attempts 在 JS 端獨立算一次期望值，逐欄比對。
//
// 三道防線與 controllers.pg.test.js 相同：
//   1. **只讀 process.env.TEST_DATABASE_URL，本檔絕不 require('dotenv')**。
//      `npm test`（= node --test test/unit/**）不會預載 .env，因此這支整支被 skip。
//      要跑它：node -r dotenv/config --test "test/integration/**/*.test.js"
//      （Node 24 在 Windows 上 `--test <目錄>` 會把目錄當模組 require 而失敗，必須用 glob）
//   2. 資料庫名必須以 `_test` 結尾，否則直接失敗。
//   3. 連線在 require config/db.js **之前**就把 DATABASE_URL 覆寫成測試庫。
//
// 每個案例前都 TRUNCATE … RESTART IDENTITY，所以 id 從 1 開始、彼此不互相汙染。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('學生／試卷／弱點面板整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 node -r dotenv/config --test "test/integration/**/*.test.js"'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    // 必須在 require config/db.js 之前設定：連線池在 require 當下就建好了
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // app.js 的 apiKeyAuth 在有 API_KEY 時會擋掉沒帶標頭的請求；測試不驗金鑰
    delete process.env.API_KEY;

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /**
     * routes/index.js 在 **require 當下**讀 FEATURE_STUDENTS（旗標關閉時整組路由不掛載，
     * 與 FEATURE_SIMILAR 同一種做法）。要在同一個行程裡同時驗「開」與「關」兩種狀態，
     * 只能清掉 app.js 與 routes/index.js 的 require 快取再讀一次。
     * config/db.js 的快取**不清**——連線池必須只有一個。
     */
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

    // 先建「旗標關閉」那一份，再建正式用的「旗標開啟」版本，
    // 兩者共用同一個 config/db.js 連線池。
    const appDisabled = loadApp('false');
    const app = loadApp('true');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const weakness = require(path.join(APP_DIR, 'services', 'weaknessService'));

    // ─────────────────── 日期輔助（全部走 UTC 算術）───────────────────
    // config/db.js 已把 DATE 的 type parser 設成回 'YYYY-MM-DD' 字串，
    // 這裡也一律用字串進出，不碰本地時區——否則台灣早上 8 點前會整批差一天。

    /** 'YYYY-MM-DD' 往前 n 天。 */
    function minusDays(dateStr, n) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - n);
        return dt.toISOString().slice(0, 10);
    }

    /** 該日期所屬 ISO 週的週一（date_trunc('week', …) 的 JS 版）。 */
    function isoWeekStart(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // 週日(0) 要退 6 天
        return dt.toISOString().slice(0, 10);
    }

    // ─────────────────── 灌資料輔助 ───────────────────

    const MATH_CHAPTERS = ['向量內積', '排列', '組合'];
    const PHYS_CHAPTERS = ['牛頓運動定律', '靜電學'];
    const TYPES = ['單選', '多選', '填空', '計算', '證明'];

    /**
     * 灌 n 題自製題（題幹與答案全部是自編字串，不含任何真實考卷內容）。
     * @returns {Promise<object[]>} [{ id, subject, chapter, question_type, difficulty }]
     */
    async function seedQuestions(n) {
        const meta = Array.from({ length: n }, (_, i) => {
            const subject = (i % 5) < 3 ? '數學' : '物理';
            return {
                subject,
                chapter: subject === '數學' ? MATH_CHAPTERS[i % 3] : PHYS_CHAPTERS[i % 2],
                question_type: TYPES[i % 5],
                difficulty: (i % 5) + 1
            };
        });
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[])
             RETURNING id`,
            [
                meta.map(m => m.subject),
                meta.map(m => m.chapter),
                meta.map(m => m.question_type),
                meta.map(m => m.difficulty),
                meta.map((m, i) => `自製整合測試題 ${i}（${m.chapter}）：求 $\\vec{a} \\cdot \\vec{b}$。`),
                meta.map((m, i) => `測試答案 ${i}`)
            ]
        );
        return rows.map((r, i) => ({ id: r.id, ...meta[i] }));
    }

    /** 建學生，回傳 id 陣列（順序 = 傳入的名字順序）。 */
    async function seedStudents(names) {
        const { rows } = await query(
            `INSERT INTO students (name) SELECT * FROM unnest($1::text[]) RETURNING id`,
            [names]
        );
        return rows.map(r => r.id);
    }

    /**
     * 批次寫 attempts。`assigned_at` 一律用 `CURRENT_DATE - offset_days` 產生，
     * 這樣 JS 端只要記 offset 就能算出同樣的時間窗，完全不必猜資料庫的今天是哪天。
     * @param {Array<{studentId:number, questionId:number, offsetDays:number, result:number|null, paperId?:number|null}>} rows
     */
    async function seedAttempts(rows) {
        await query(
            `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at, result, graded_at)
             SELECT s, q, p, CURRENT_DATE - off, r,
                    CASE WHEN r IS NULL THEN NULL ELSE now() END
               FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::smallint[]) AS t(s, q, p, off, r)`,
            [
                rows.map(r => r.studentId),
                rows.map(r => r.questionId),
                rows.map(r => r.paperId ?? null),
                rows.map(r => r.offsetDays),
                rows.map(r => r.result)
            ]
        );
    }

    /** 建一張卷（question_ids 保留傳入順序）。 */
    async function seedPaper(studentId, questionIds, title = '整合測試卷') {
        const { rows: [paper] } = await query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
            [title, studentId, questionIds]
        );
        return paper.id;
    }

    // ─────────────────── 1,000 筆的弱點 fixture ───────────────────

    /** 4 位學生 × 250 題 = 1,000 筆 attempts；offset 0~119 天，跨得過 90 天的窗。 */
    const FIXTURE_STUDENTS = 4;
    const FIXTURE_QUESTIONS = 250;

    /**
     * 決定性的 fixture：沒有亂數、沒有時間，同一份程式碼每次跑出同一份資料，
     * CI 紅燈就一定是程式改壞了，不是運氣不好。
     */
    function fixtureAttempt(qIndex, sIndex) {
        return {
            offsetDays: (qIndex * 7 + sIndex * 3) % 120,
            // 約 1/4 未批改、其餘約 1/3 答錯
            result: ((qIndex + sIndex) % 4 === 0) ? null
                : (((qIndex * 2 + sIndex) % 3 === 0) ? 0 : 1)
        };
    }

    /** @returns {Promise<{students:number[], questions:object[], attempts:object[], today:string}>} */
    async function seedWeaknessFixture() {
        const questions = await seedQuestions(FIXTURE_QUESTIONS);
        const students = await seedStudents(
            Array.from({ length: FIXTURE_STUDENTS }, (_, i) => `測試學生${'ABCD'[i]}`)
        );
        const attempts = [];
        for (let s = 0; s < FIXTURE_STUDENTS; s++) {
            for (let q = 0; q < FIXTURE_QUESTIONS; q++) {
                const { offsetDays, result } = fixtureAttempt(q, s);
                attempts.push({
                    studentId: students[s], questionId: questions[q].id,
                    offsetDays, result, question: questions[q]
                });
            }
        }
        await seedAttempts(attempts);
        const { rows: [{ today }] } = await query('SELECT CURRENT_DATE AS today');
        return { students, questions, attempts, today };
    }

    /**
     * JS 端獨立算一次期望聚合——**刻意不重用 weaknessService 的 SQL**，
     * 否則兩邊一起錯就一起通過，測試等於沒有。
     */
    function expectAggregate(attempts, { studentId, subject, days, keyOf }) {
        const buckets = new Map();
        for (const a of attempts) {
            if (a.studentId !== studentId) continue;
            if (a.offsetDays > days) continue;                       // a.assigned_at >= CURRENT_DATE - days
            if (subject !== null && a.question.subject !== subject) continue;
            const key = keyOf(a.question);
            if (!buckets.has(key)) buckets.set(key, { assigned: 0, graded: 0, wrong: 0 });
            const b = buckets.get(key);
            b.assigned++;
            if (a.result !== null) b.graded++;
            if (a.result === 0) b.wrong++;
        }
        return buckets;
    }

    /** wrong / graded 四捨五入到小數第 4 位；graded = 0 時是 null（裁決 S3-3）。 */
    function expectWrongRate(wrong, graded) {
        if (graded === 0) return null;
        return Math.round((wrong / graded) * 1e4) / 1e4;
    }

    /**
     * 斷言回傳的列已依 `wrong_rate DESC NULLS LAST, graded DESC` 排好。
     *
     * 第三順位（分組欄 ASC）刻意**不比對**：中文字串的大小關係取決於資料庫的
     * collation（本機是 en_US.utf8，別台機器可能是 C 或 zh_TW），拿 JS 的
     * 字串比較去釘它只是把測試綁在某一台機器上。難度是數字，那一支另外釘。
     */
    function assertSortedByRateThenGraded(items, label) {
        for (let i = 1; i < items.length; i++) {
            const prev = items[i - 1], cur = items[i];
            const pr = prev.wrong_rate, cr = cur.wrong_rate;
            if (pr === null) {
                assert.equal(cr, null, `${label}：wrong_rate 為 null 的列必須全部排在最後（NULLS LAST）`);
                continue;
            }
            if (cr === null) continue;                                // null 排在後面，正確
            assert.ok(pr >= cr, `${label}：wrong_rate 未遞減（第 ${i - 1} 列 ${pr} < 第 ${i} 列 ${cr}）`);
            if (pr === cr) {
                assert.ok(prev.graded >= cur.graded,
                    `${label}：wrong_rate 相同時 graded 未遞減（${prev.graded} < ${cur.graded}）`);
            }
        }
    }

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('學生／試卷／批改／弱點面板 × PostgreSQL', () => {
        before(() => {
            const out = execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR,
                env: { ...process.env, TEST_DATABASE_URL },
                encoding: 'utf8'
            });
            assert.ok(out.length > 0, 'migrate.js 應有輸出');
        });

        beforeEach(async () => {
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });

        after(async () => {
            await pool.end();
        });

        // ───────── 旗標 ─────────

        describe('FEATURE_STUDENTS', () => {
            test('關閉時四條路由都不掛載，落到 Express 預設 404（不是 { message }）', async () => {
                // GET /api/students 依裁決 S4-2 搬到核心區（組卷下拉恆常需要），不在此列——
                // 旗標關閉時它仍應是 200，最後一段另行斷言。
                for (const [method, url] of [
                    ['get', '/api/students/1/papers'],
                    ['get', '/api/students/1/weakness'],
                    ['get', '/api/papers/1'],
                    ['patch', '/api/papers/1/results']
                ]) {
                    const res = await request(appDisabled)[method](url);
                    assert.equal(res.status, 404, `${method.toUpperCase()} ${url} 應為 404`);
                    // 沒掛載 ⇒ 走 Express 預設 404 頁，不會有我們自己的 JSON 訊息
                    assert.equal(res.body.message, undefined,
                        `${url} 不該回我們自己的 { message }——那代表路由其實掛上了`);
                }
                // S4-2：清單路由不吃旗標
                const list = await request(appDisabled).get('/api/students');
                assert.equal(list.status, 200, 'GET /api/students 應恆常掛載（裁決 S4-2）');
            });

            test('開啟時 GET /api/students 回 200', async () => {
                const res = await request(app).get('/api/students');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { items: [] });
            });
        });

        // ───────── 1.1 GET /api/students ─────────

        describe('GET /api/students（第 1.1 條）', () => {
            test('形狀、graded_ratio 四捨五入到 4 位、依 name 排序', async () => {
                const questions = await seedQuestions(10);
                const [idA, idB] = await seedStudents(['測試學生A', '測試學生B']);

                // B：8 筆 attempts，5 筆已批改 → 5/8 = 0.625（第 1.1 條的範例值）
                await seedAttempts(Array.from({ length: 8 }, (_, i) => ({
                    studentId: idB, questionId: questions[i].id, offsetDays: 1,
                    result: i < 5 ? (i % 2) : null
                })));
                await seedPaper(idB, questions.slice(0, 5).map(q => q.id));
                await seedPaper(idB, questions.slice(5, 8).map(q => q.id));

                const res = await request(app).get('/api/students');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.items, [
                    // A 完全沒有試卷也要出現（LEFT JOIN），papers: 0、graded_ratio: 0
                    { id: idA, name: '測試學生A', papers: 0, graded_ratio: 0 },
                    { id: idB, name: '測試學生B', papers: 2, graded_ratio: 0.625 }
                ]);
                // 型別：不得是字串、不得是 null／NaN
                for (const item of res.body.items) {
                    assert.equal(typeof item.papers, 'number');
                    assert.equal(typeof item.graded_ratio, 'number');
                    assert.ok(Number.isFinite(item.graded_ratio));
                }
            });

            test('有試卷但一題都沒批改時 graded_ratio 是 0，不是 null', async () => {
                const questions = await seedQuestions(3);
                const [id] = await seedStudents(['測試學生A']);
                await seedAttempts(questions.map(q => ({
                    studentId: id, questionId: q.id, offsetDays: 0, result: null
                })));
                await seedPaper(id, questions.map(q => q.id));

                const { body } = await request(app).get('/api/students');
                assert.deepEqual(body.items, [{ id, name: '測試學生A', papers: 1, graded_ratio: 0 }]);
            });

            test('papers 不會被 attempts 的列數放大（兩張表分別聚合再 LEFT JOIN）', async () => {
                // 這一則專門擋「直接把 exam_papers 與 attempts 一起 JOIN 上來」的笛卡兒積：
                // 2 張卷 × 6 筆 attempts 若未分開聚合，papers 會變成 12。
                const questions = await seedQuestions(6);
                const [id] = await seedStudents(['測試學生A']);
                await seedAttempts(questions.map(q => ({
                    studentId: id, questionId: q.id, offsetDays: 0, result: 1
                })));
                await seedPaper(id, questions.slice(0, 3).map(q => q.id));
                await seedPaper(id, questions.slice(3).map(q => q.id));

                const { body } = await request(app).get('/api/students');
                assert.equal(body.items[0].papers, 2);
                assert.equal(body.items[0].graded_ratio, 1);
            });
        });

        // ───────── 1.2 GET /api/students/:id/papers ─────────

        describe('GET /api/students/:id/papers（第 1.2 條）', () => {
            test('形狀、total／graded、依 created_at DESC 排序', async () => {
                const questions = await seedQuestions(6);
                const [id] = await seedStudents(['測試學生A']);

                const older = await seedPaper(id, questions.slice(0, 4).map(q => q.id), '舊卷');
                const newer = await seedPaper(id, questions.slice(4).map(q => q.id), '新卷');
                // 兩張卷同一個 now()；把舊卷往前推一天，讓排序有唯一解
                await query(`UPDATE exam_papers SET created_at = created_at - interval '1 day' WHERE id = $1`, [older]);

                await seedAttempts([
                    ...questions.slice(0, 4).map((q, i) => ({
                        studentId: id, questionId: q.id, offsetDays: 1,
                        result: i < 3 ? 1 : null, paperId: older      // 4 題中批了 3 題
                    })),
                    ...questions.slice(4).map(q => ({
                        studentId: id, questionId: q.id, offsetDays: 0, result: null, paperId: newer
                    }))
                ]);

                const res = await request(app).get(`/api/students/${id}/papers`);
                assert.equal(res.status, 200);
                assert.equal(res.body.items.length, 2);

                const [first, second] = res.body.items;
                assert.equal(first.paper_id, newer, '最近出的卷要在最上面（這是批改入口）');
                assert.deepEqual(
                    { paper_id: first.paper_id, title: first.title, total: first.total, graded: first.graded },
                    { paper_id: newer, title: '新卷', total: 2, graded: 0 }
                );
                assert.deepEqual(
                    { paper_id: second.paper_id, title: second.title, total: second.total, graded: second.graded },
                    { paper_id: older, title: '舊卷', total: 4, graded: 3 }
                );
                // created_at 是 TIMESTAMPTZ，序列化成 ISO 8601 字串
                assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
            });

            test('沒有任何試卷的學生回 200 與空 items（不是 404）', async () => {
                const [id] = await seedStudents(['測試學生A']);
                const res = await request(app).get(`/api/students/${id}/papers`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { items: [] });
            });

            test('學生不存在回 404 { message: 找不到該學生 }', async () => {
                const res = await request(app).get('/api/students/9999/papers');
                assert.equal(res.status, 404);
                assert.deepEqual(res.body, { message: '找不到該學生' });
            });

            test(':id 不是整數也回 404，不回 400（第 1.2 條）', async () => {
                for (const bad of ['abc', '1.5', '0', '-3', '1abc']) {
                    const res = await request(app).get(`/api/students/${bad}/papers`);
                    assert.equal(res.status, 404, `:id=${bad} 應回 404`);
                    assert.deepEqual(res.body, { message: '找不到該學生' });
                }
            });
        });

        // ───────── 1.3 GET /api/papers/:id ─────────

        describe('GET /api/papers/:id（第 1.3 條）', () => {
            test('questions 依 question_ids 的陣列順序（不是 id 大小序），result 取自 attempts', async () => {
                const questions = await seedQuestions(3);
                const [id] = await seedStudents(['測試學生A']);
                const ids = [questions[2].id, questions[0].id, questions[1].id]; // 刻意亂序
                const paperId = await seedPaper(id, ids, '順序測試卷');

                await seedAttempts([
                    { studentId: id, questionId: ids[0], offsetDays: 0, result: 1, paperId },
                    { studentId: id, questionId: ids[1], offsetDays: 0, result: 0, paperId },
                    { studentId: id, questionId: ids[2], offsetDays: 0, result: null, paperId }
                ]);

                const res = await request(app).get(`/api/papers/${paperId}`);
                assert.equal(res.status, 200);
                assert.equal(res.body.id, paperId);
                assert.equal(res.body.title, '順序測試卷');
                assert.equal(res.body.student_id, id);
                assert.match(res.body.created_at, /^\d{4}-\d{2}-\d{2}T/);

                assert.deepEqual(res.body.questions.map(q => q.question_id), ids, '必須是出題順序');
                assert.deepEqual(res.body.questions.map(q => q.result), [1, 0, null]);
                for (const q of res.body.questions) {
                    assert.equal(typeof q.question_text, 'string');
                    assert.ok(['單選', '多選', '填空', '計算', '證明'].includes(q.question_type));
                    assert.ok(Number.isInteger(q.difficulty));
                }
            });

            test('查不到對應 attempts 列時 result 是 null（不是漏掉那一題）', async () => {
                const questions = await seedQuestions(2);
                const [id] = await seedStudents(['測試學生A']);
                const ids = questions.map(q => q.id);
                const paperId = await seedPaper(id, ids);
                // 只寫一筆 attempts
                await seedAttempts([{ studentId: id, questionId: ids[0], offsetDays: 0, result: 1, paperId }]);

                const { body } = await request(app).get(`/api/papers/${paperId}`);
                assert.equal(body.questions.length, 2, '兩題都要在');
                assert.deepEqual(body.questions.map(q => q.result), [1, null]);
            });

            test('不排除已封存題（裁決 S3-2：舊卷必須顯示得出全部題目）', async () => {
                const questions = await seedQuestions(3);
                const [id] = await seedStudents(['測試學生A']);
                const ids = questions.map(q => q.id);
                const paperId = await seedPaper(id, ids);
                await seedAttempts(ids.map(qid => ({
                    studentId: id, questionId: qid, offsetDays: 0, result: 1, paperId
                })));
                await query('UPDATE questions SET archived_at = now() WHERE id = $1', [ids[1]]);

                const { body } = await request(app).get(`/api/papers/${paperId}`);
                assert.deepEqual(body.questions.map(q => q.question_id), ids,
                    '封存後那一題仍要出現在原本的位置');
            });

            test('試卷不存在或 :id 不是整數都回 404 { message: 找不到該試卷 }', async () => {
                for (const bad of ['9999', 'abc', '0', '2.5']) {
                    const res = await request(app).get(`/api/papers/${bad}`);
                    assert.equal(res.status, 404, `:id=${bad} 應回 404`);
                    assert.deepEqual(res.body, { message: '找不到該試卷' });
                }
            });
        });

        // ───────── 1.4 PATCH /api/papers/:id/results ─────────

        describe('PATCH /api/papers/:id/results（第 1.4 條）', () => {
            /** 建一張 4 題的卷並寫好 attempts，回傳 { studentId, paperId, ids }。 */
            async function seedGradableePaper() {
                const questions = await seedQuestions(4);
                const [studentId] = await seedStudents(['測試學生A']);
                const ids = questions.map(q => q.id);
                const paperId = await seedPaper(studentId, ids);
                await seedAttempts(ids.map(qid => ({
                    studentId, questionId: qid, offsetDays: 0, result: null, paperId
                })));
                return { studentId, paperId, ids };
            }

            test('200 { updated } 並寫入 result 與 graded_at', async () => {
                const { paperId, ids } = await seedGradableePaper();
                const res = await request(app).patch(`/api/papers/${paperId}/results`).send({
                    results: [
                        { question_id: ids[0], result: 1 },
                        { question_id: ids[1], result: 0 },
                        { question_id: ids[2], result: 1 }
                    ]
                });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { updated: 3 });

                const { rows } = await query(
                    'SELECT question_id, result, graded_at FROM attempts WHERE paper_id = $1 ORDER BY question_id',
                    [paperId]
                );
                assert.deepEqual(rows.map(r => r.result), [1, 0, 1, null]);
                assert.ok(rows[0].graded_at instanceof Date, '批改過的列要有 graded_at');
                assert.equal(rows[3].graded_at, null, '沒送到的列不動');
            });

            test('result: null 取消批改時把 graded_at 一起清掉', async () => {
                const { paperId, ids } = await seedGradableePaper();
                await request(app).patch(`/api/papers/${paperId}/results`)
                    .send({ results: [{ question_id: ids[0], result: 1 }] });

                const before = await query('SELECT graded_at FROM attempts WHERE question_id = $1', [ids[0]]);
                assert.ok(before.rows[0].graded_at instanceof Date);

                const res = await request(app).patch(`/api/papers/${paperId}/results`)
                    .send({ results: [{ question_id: ids[0], result: null }] });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { updated: 1 });

                const after = await query('SELECT result, graded_at FROM attempts WHERE question_id = $1', [ids[0]]);
                assert.equal(after.rows[0].result, null);
                assert.equal(after.rows[0].graded_at, null,
                    '取消批改沒清掉 graded_at 的話，面板會看到「批改過但沒有結果」');
            });

            test('重送同樣的值也算數（updated = 實際 UPDATE 到的列數）', async () => {
                const { paperId, ids } = await seedGradableePaper();
                const body = { results: [{ question_id: ids[0], result: 1 }, { question_id: ids[1], result: 0 }] };
                const first = await request(app).patch(`/api/papers/${paperId}/results`).send(body);
                const second = await request(app).patch(`/api/papers/${paperId}/results`).send(body);
                assert.deepEqual(first.body, { updated: 2 });
                assert.deepEqual(second.body, { updated: 2 });
            });

            test('題號在卷上但沒有 attempts 列時，只是沒 UPDATE 到（updated 較少），不算錯', async () => {
                const questions = await seedQuestions(2);
                const [studentId] = await seedStudents(['測試學生A']);
                const ids = questions.map(q => q.id);
                const paperId = await seedPaper(studentId, ids);
                await seedAttempts([{ studentId, questionId: ids[0], offsetDays: 0, result: null, paperId }]);

                const res = await request(app).patch(`/api/papers/${paperId}/results`).send({
                    results: [{ question_id: ids[0], result: 1 }, { question_id: ids[1], result: 1 }]
                });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { updated: 1 });
            });

            test('全有全無：任何一筆不在卷內就整包 400 並 ROLLBACK', async () => {
                const { paperId, ids } = await seedGradableePaper();
                const outsider = (await seedQuestions(1))[0];

                const res = await request(app).patch(`/api/papers/${paperId}/results`).send({
                    results: [
                        { question_id: ids[0], result: 1 },       // 這一筆本身合法
                        { question_id: outsider.id, result: 0 }   // 這一筆不在卷內
                    ]
                });
                assert.equal(res.status, 400);
                assert.deepEqual(res.body, { message: `題目 ${outsider.id} 不在這張試卷內。` });

                const { rows } = await query('SELECT result, graded_at FROM attempts WHERE paper_id = $1', [paperId]);
                assert.ok(rows.every(r => r.result === null && r.graded_at === null),
                    '整包 400 時前面那筆合法的也不得被寫進去');
            });

            test(`${'${question_id}'} 代入的是**第一個**不在卷內的題號`, async () => {
                const { paperId, ids } = await seedGradableePaper();
                const [outA, outB] = await seedQuestions(2);
                const res = await request(app).patch(`/api/papers/${paperId}/results`).send({
                    results: [
                        { question_id: ids[0], result: 1 },
                        { question_id: outA.id, result: 0 },
                        { question_id: outB.id, result: 0 }
                    ]
                });
                assert.deepEqual(res.body, { message: `題目 ${outA.id} 不在這張試卷內。` });
            });

            test('六個 400 訊息逐字凍結', async () => {
                const { paperId, ids } = await seedGradableePaper();
                const cases = [
                    [{ results: [] }, 'results 必須是非空陣列。'],
                    [{ results: 'nope' }, 'results 必須是非空陣列。'],
                    [{}, 'results 必須是非空陣列。'],
                    [{ results: Array.from({ length: 101 }, (_, i) => ({ question_id: i + 1, result: 1 })) },
                        'results 最多 100 筆。'],
                    [{ results: [{ question_id: ids[0], result: 1 }, { question_id: ids[0], result: 0 }] },
                        'results 內有重複的 question_id。'],
                    [{ results: [{ question_id: '12', result: 1 }] }, 'question_id 必須是正整數。'],
                    [{ results: [{ question_id: 0, result: 1 }] }, 'question_id 必須是正整數。'],
                    [{ results: [{ question_id: -1, result: 1 }] }, 'question_id 必須是正整數。'],
                    [{ results: [{ question_id: 1.5, result: 1 }] }, 'question_id 必須是正整數。'],
                    [{ results: [{ result: 1 }] }, 'question_id 必須是正整數。'],
                    [{ results: [{ question_id: ids[0], result: 2 }] }, 'result 只接受 0、1 或 null。'],
                    [{ results: [{ question_id: ids[0], result: '1' }] }, 'result 只接受 0、1 或 null。'],
                    [{ results: [{ question_id: ids[0] }] }, 'result 只接受 0、1 或 null。']
                ];
                for (const [body, message] of cases) {
                    const res = await request(app).patch(`/api/papers/${paperId}/results`).send(body);
                    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 60)} 應回 400`);
                    assert.deepEqual(res.body, { message });
                }
            });

            test('剛好 100 筆是合法的（上限是 100，不是 99）', async () => {
                const questions = await seedQuestions(100);
                const [studentId] = await seedStudents(['測試學生A']);
                const ids = questions.map(q => q.id);
                const paperId = await seedPaper(studentId, ids);
                await seedAttempts(ids.map(qid => ({
                    studentId, questionId: qid, offsetDays: 0, result: null, paperId
                })));

                const res = await request(app).patch(`/api/papers/${paperId}/results`)
                    .send({ results: ids.map(qid => ({ question_id: qid, result: 1 })) });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { updated: 100 });
            });

            test('試卷不存在或 :id 不是整數回 404 { message: 找不到該試卷 }', async () => {
                for (const bad of ['9999', 'abc']) {
                    const res = await request(app).patch(`/api/papers/${bad}/results`)
                        .send({ results: [{ question_id: 1, result: 1 }] });
                    assert.equal(res.status, 404, `:id=${bad} 應回 404`);
                    assert.deepEqual(res.body, { message: '找不到該試卷' });
                }
            });

            test('只動這張卷的 attempts，不碰其他卷的同一題', async () => {
                const questions = await seedQuestions(2);
                const [sA, sB] = await seedStudents(['測試學生A', '測試學生B']);
                const ids = questions.map(q => q.id);
                const paperA = await seedPaper(sA, ids);
                const paperB = await seedPaper(sB, ids);
                await seedAttempts([
                    ...ids.map(qid => ({ studentId: sA, questionId: qid, offsetDays: 0, result: null, paperId: paperA })),
                    ...ids.map(qid => ({ studentId: sB, questionId: qid, offsetDays: 0, result: null, paperId: paperB }))
                ]);

                const res = await request(app).patch(`/api/papers/${paperA}/results`)
                    .send({ results: ids.map(qid => ({ question_id: qid, result: 1 })) });
                assert.deepEqual(res.body, { updated: 2 });

                const { rows } = await query('SELECT result FROM attempts WHERE paper_id = $1', [paperB]);
                assert.ok(rows.every(r => r.result === null), 'B 的卷不得被連帶批改');
            });
        });

        // ───────── 1.5 GET /api/students/:id/weakness ─────────

        describe('GET /api/students/:id/weakness（第 1.5、1.6 條）', () => {
            let fixture;

            beforeEach(async () => {
                fixture = await seedWeaknessFixture();
            });

            test(`fixture 真的是 ${FIXTURE_STUDENTS * FIXTURE_QUESTIONS} 筆 attempts`, async () => {
                const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM attempts');
                assert.equal(n, FIXTURE_STUDENTS * FIXTURE_QUESTIONS);
            });

            test('by_chapter／by_type／by_difficulty 的四個數字逐欄等於 JS 端獨立算出的期望值', async () => {
                const studentId = fixture.students[0];
                const res = await request(app).get(`/api/students/${studentId}/weakness?days=90`);
                assert.equal(res.status, 200);

                const tables = [
                    ['by_chapter', 'chapter', q => q.chapter],
                    ['by_type', 'question_type', q => q.question_type],
                    ['by_difficulty', 'difficulty', q => q.difficulty]
                ];
                for (const [table, keyName, keyOf] of tables) {
                    const expected = expectAggregate(fixture.attempts,
                        { studentId, subject: null, days: 90, keyOf });
                    const actual = new Map(res.body[table].map(r => [r[keyName], r]));

                    assert.equal(actual.size, expected.size,
                        `${table} 的分組數不符（期望 ${expected.size}，實際 ${actual.size}）`);
                    assert.ok(expected.size > 0, `${table} 的期望值不該是空的，fixture 出問題了`);

                    for (const [key, want] of expected) {
                        const got = actual.get(key);
                        assert.ok(got, `${table} 缺少分組 ${key}`);
                        assert.equal(got.assigned, want.assigned, `${table}[${key}].assigned`);
                        assert.equal(got.graded, want.graded, `${table}[${key}].graded`);
                        assert.equal(got.wrong, want.wrong, `${table}[${key}].wrong`);

                        const wantRate = expectWrongRate(want.wrong, want.graded);
                        if (wantRate === null) {
                            assert.equal(got.wrong_rate, null, `${table}[${key}].wrong_rate 應為 null`);
                        } else {
                            assert.ok(Math.abs(got.wrong_rate - wantRate) < 1e-9,
                                `${table}[${key}].wrong_rate 期望 ${wantRate}，實際 ${got.wrong_rate}`);
                            assert.equal(Number(got.wrong_rate.toFixed(4)), got.wrong_rate,
                                `${table}[${key}].wrong_rate 未四捨五入到小數第 4 位`);
                        }
                    }
                    assertSortedByRateThenGraded(res.body[table], table);
                }
            });

            test('by_difficulty 的第三順位（difficulty ASC）也照排', async () => {
                const studentId = fixture.students[0];
                const { body } = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                const items = body.by_difficulty;
                for (let i = 1; i < items.length; i++) {
                    const prev = items[i - 1], cur = items[i];
                    if (prev.wrong_rate === cur.wrong_rate && prev.graded === cur.graded) {
                        assert.ok(prev.difficulty < cur.difficulty,
                            `difficulty 未遞增（${prev.difficulty} → ${cur.difficulty}）`);
                    }
                }
                assert.ok(items.every(r => Number.isInteger(r.difficulty) && r.difficulty >= 1 && r.difficulty <= 5));
            });

            test('days 真的會縮小時間窗（days=7 的 assigned 遠少於 days=365）', async () => {
                const studentId = fixture.students[0];
                const short = await request(app).get(`/api/students/${studentId}/weakness?days=7`);
                const long = await request(app).get(`/api/students/${studentId}/weakness?days=365`);

                const sum = body => body.by_chapter.reduce((n, r) => n + r.assigned, 0);
                const expectedShort = [...expectAggregate(fixture.attempts,
                    { studentId, subject: null, days: 7, keyOf: q => q.chapter }).values()]
                    .reduce((n, b) => n + b.assigned, 0);

                assert.equal(sum(short.body), expectedShort);
                assert.equal(sum(long.body), FIXTURE_QUESTIONS, 'days=365 應涵蓋全部 250 題');
                assert.ok(sum(short.body) < sum(long.body), 'days=7 必須比 days=365 少');
            });

            test('subject 白名單過濾：只算該科的題', async () => {
                const studentId = fixture.students[0];
                for (const subject of ['數學', '物理']) {
                    const { body } = await request(app)
                        .get(`/api/students/${studentId}/weakness?subject=${encodeURIComponent(subject)}&days=365`);
                    const expected = expectAggregate(fixture.attempts,
                        { studentId, subject, days: 365, keyOf: q => q.chapter });

                    assert.deepEqual(
                        body.by_chapter.map(r => r.chapter).sort(),
                        [...expected.keys()].sort(),
                        `${subject} 的章節集合不符`
                    );
                    const allowed = subject === '數學' ? MATH_CHAPTERS : PHYS_CHAPTERS;
                    assert.ok(body.by_chapter.every(r => allowed.includes(r.chapter)),
                        `${subject} 不該出現另一科的章節`);
                }
            });

            test('?subject= 空字串視為不分科（第 1.5 條的範例網址就是這樣寫的）', async () => {
                const studentId = fixture.students[0];
                const empty = await request(app).get(`/api/students/${studentId}/weakness?subject=&days=365`);
                const none = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                assert.equal(empty.status, 200);
                assert.deepEqual(empty.body.by_chapter, none.body.by_chapter);
            });

            test('days 預設 90', async () => {
                const studentId = fixture.students[0];
                const implicit = await request(app).get(`/api/students/${studentId}/weakness`);
                const explicit = await request(app).get(`/api/students/${studentId}/weakness?days=90`);
                assert.deepEqual(implicit.body, explicit.body);
            });

            test('low_sample = graded < WEAKNESS_MIN_N，且 graded = 0 也是 true（裁決 S3-3）', async () => {
                const studentId = fixture.students[0];
                const saved = process.env.WEAKNESS_MIN_N;
                try {
                    // 門檻拉到 999：所有分組都該是 low_sample
                    process.env.WEAKNESS_MIN_N = '999';
                    const high = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                    for (const table of ['by_chapter', 'by_type', 'by_difficulty']) {
                        assert.ok(high.body[table].length > 0);
                        assert.ok(high.body[table].every(r => r.low_sample === true),
                            `${table}：門檻 999 時全部都該是 low_sample`);
                    }

                    // 門檻壓到 0：graded 一定 >= 0，所以全部都不是 low_sample
                    process.env.WEAKNESS_MIN_N = '0';
                    const low = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                    for (const table of ['by_chapter', 'by_type', 'by_difficulty']) {
                        assert.ok(low.body[table].every(r => r.low_sample === false),
                            `${table}：門檻 0 時不該有 low_sample`);
                    }

                    // 預設 5：逐列驗算
                    delete process.env.WEAKNESS_MIN_N;
                    const def = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                    for (const table of ['by_chapter', 'by_type', 'by_difficulty']) {
                        for (const row of def.body[table]) {
                            assert.equal(row.low_sample, row.graded < 5, `${table} 的 low_sample 算錯`);
                        }
                    }
                } finally {
                    if (saved === undefined) delete process.env.WEAKNESS_MIN_N;
                    else process.env.WEAKNESS_MIN_N = saved;
                }
            });

            test('graded = 0 時 wrong_rate 是 null 且 low_sample 是 true（沒批改不等於全對）', async () => {
                // 另開一位學生，全部未批改
                const [lonely] = await seedStudents(['測試學生Z']);
                await seedAttempts(fixture.questions.slice(0, 5).map(q => ({
                    studentId: lonely, questionId: q.id, offsetDays: 1, result: null
                })));

                const { body } = await request(app).get(`/api/students/${lonely}/weakness?days=90`);
                assert.ok(body.by_chapter.length > 0);
                for (const row of body.by_chapter) {
                    assert.equal(row.graded, 0);
                    assert.equal(row.wrong_rate, null, 'graded = 0 時 wrong_rate 必須是 null，不是 0');
                    assert.equal(row.low_sample, true);
                }
            });

            test('trend_weekly：week_start 是 YYYY-MM-DD 字串、ISO 週、只列有資料的週、遞增', async () => {
                const studentId = fixture.students[0];
                const { body } = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                const trend = body.trend_weekly;
                assert.ok(trend.length > 0);

                // 形狀：只有三個鍵
                assert.deepEqual(Object.keys(trend[0]).sort(), ['graded', 'week_start', 'wrong']);
                for (const row of trend) {
                    assert.match(row.week_start, /^\d{4}-\d{2}-\d{2}$/,
                        'week_start 必須是字串——轉成 Date 會在台灣時區差一天');
                    // ISO 週、週一起算
                    assert.equal(isoWeekStart(row.week_start), row.week_start, `${row.week_start} 不是週一`);
                }
                for (let i = 1; i < trend.length; i++) {
                    assert.ok(trend[i - 1].week_start < trend[i].week_start, 'week_start 必須遞增');
                }

                // 與 JS 端獨立算的期望值逐週比對（同時證明「不補零」：只有有資料的週）
                const expected = new Map();
                for (const a of fixture.attempts) {
                    if (a.studentId !== studentId || a.offsetDays > 365) continue;
                    const wk = isoWeekStart(minusDays(fixture.today, a.offsetDays));
                    if (!expected.has(wk)) expected.set(wk, { graded: 0, wrong: 0 });
                    if (a.result !== null) expected.get(wk).graded++;
                    if (a.result === 0) expected.get(wk).wrong++;
                }
                assert.equal(trend.length, expected.size, '週數不符（不得補零）');
                for (const row of trend) {
                    const want = expected.get(row.week_start);
                    assert.ok(want, `多出一週 ${row.week_start}`);
                    assert.equal(row.graded, want.graded, `${row.week_start} 的 graded`);
                    assert.equal(row.wrong, want.wrong, `${row.week_start} 的 wrong`);
                }
            });

            test('recent_wrong：只取 result = 0、LIMIT 20、依 assigned_at DESC / question_id DESC', async () => {
                const studentId = fixture.students[0];
                const { body } = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                const recent = body.recent_wrong;

                assert.equal(recent.length, 20, 'LIMIT 凍結為 20');
                assert.deepEqual(Object.keys(recent[0]).sort(),
                    ['assigned_at', 'chapter', 'question_id', 'question_text']);
                for (const row of recent) {
                    assert.match(row.assigned_at, /^\d{4}-\d{2}-\d{2}$/, 'assigned_at 必須是字串');
                }
                for (let i = 1; i < recent.length; i++) {
                    const prev = recent[i - 1], cur = recent[i];
                    assert.ok(prev.assigned_at >= cur.assigned_at, 'assigned_at 必須遞減');
                    if (prev.assigned_at === cur.assigned_at) {
                        assert.ok(prev.question_id > cur.question_id, '同日時 question_id 必須遞減');
                    }
                }

                // 每一筆都真的是答錯的題
                const wrongIds = new Set(fixture.attempts
                    .filter(a => a.studentId === studentId && a.result === 0).map(a => a.questionId));
                assert.ok(recent.every(r => wrongIds.has(r.question_id)), 'recent_wrong 只能有 result = 0 的題');
            });

            test('五張表都不排除已封存題（裁決 S3-2）', async () => {
                const studentId = fixture.students[0];
                const before = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                await query('UPDATE questions SET archived_at = now()');
                const after = await request(app).get(`/api/students/${studentId}/weakness?days=365`);
                assert.deepEqual(after.body, before.body, '封存全部題目後，弱點面板應完全不變');
            });

            test('subject 不在白名單回 400，days 超出 1~365 或非整數回 400（訊息逐字凍結）', async () => {
                const studentId = fixture.students[0];
                const bad = [
                    ['?subject=化學', 'subject 不在白名單內。'],
                    ['?subject=math', 'subject 不在白名單內。'],
                    ['?days=0', 'days 必須是 1~365 的整數。'],
                    ['?days=366', 'days 必須是 1~365 的整數。'],
                    ['?days=-1', 'days 必須是 1~365 的整數。'],
                    ['?days=abc', 'days 必須是 1~365 的整數。'],
                    ['?days=1.5', 'days 必須是 1~365 的整數。']
                ];
                for (const [qs, message] of bad) {
                    const res = await request(app).get(`/api/students/${studentId}/weakness${qs}`);
                    assert.equal(res.status, 400, `${qs} 應回 400`);
                    assert.deepEqual(res.body, { message });
                }
                // 邊界值合法
                for (const qs of ['?days=1', '?days=365']) {
                    const res = await request(app).get(`/api/students/${studentId}/weakness${qs}`);
                    assert.equal(res.status, 200, `${qs} 應合法`);
                }
            });

            test('學生不存在或 :id 不是整數回 404 { message: 找不到該學生 }', async () => {
                for (const bad of ['99999', 'abc', '0']) {
                    const res = await request(app).get(`/api/students/${bad}/weakness`);
                    assert.equal(res.status, 404, `:id=${bad} 應回 404`);
                    assert.deepEqual(res.body, { message: '找不到該學生' });
                }
            });

            test('五個頂層鍵齊備，且只有這五個', async () => {
                const studentId = fixture.students[0];
                const { body } = await request(app).get(`/api/students/${studentId}/weakness`);
                assert.deepEqual(Object.keys(body).sort(),
                    ['by_chapter', 'by_difficulty', 'by_type', 'recent_wrong', 'trend_weekly']);
            });
        });

        // ───────── EXPLAIN：計畫要走得到 idx_attempts_student_date ─────────

        describe('查詢計畫（第 1.6 條）', () => {
            beforeEach(async () => {
                await seedWeaknessFixture();
                // 沒有統計值時 planner 只能亂猜，EXPLAIN 的結果沒有意義
                await query('ANALYZE attempts');
                await query('ANALYZE questions');
            });

            test('by_chapter 的計畫含 idx_attempts_student_date', async () => {
                const { rows: [{ id: studentId }] } = await query('SELECT MIN(id) AS id FROM students');
                const { text, values } = weakness.buildByChapter({ studentId, subject: null, days: 90 });

                // 為什麼要關 seqscan：1,000 列的 attempts 只有幾頁，planner 幾乎一定
                // 選 Seq Scan——那是**正確**的選擇，不是缺陷。這裡要驗的不是
                // 「小表上會不會用索引」，而是「這組謂詞**走得到** idx_attempts_student_date」。
                // 有人把 WHERE 改成 date(a.assigned_at) >= … 或改用別的欄位篩學生時，
                // 索引就再也搭不上，正式庫（十萬列以上）會從索引掃退化成全表掃，
                // 而功能測試完全看不出來。SET LOCAL 只在這個交易內有效。
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('SET LOCAL enable_seqscan = off');
                    const { rows } = await client.query({
                        text: `EXPLAIN (FORMAT JSON) ${text}`,
                        values
                    });
                    await client.query('ROLLBACK');

                    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
                    assert.ok(plan.includes('idx_attempts_student_date'),
                        `計畫未用到 idx_attempts_student_date：${plan}`);
                } finally {
                    client.release();
                }
            });

            test('五支查詢在真資料庫上都跑得起來（純文字單測擋不住語法錯）', async () => {
                const { rows: [{ id: studentId }] } = await query('SELECT MIN(id) AS id FROM students');
                for (const name of ['buildByChapter', 'buildByType', 'buildByDifficulty',
                    'buildTrendWeekly', 'buildRecentWrong']) {
                    const { text, values } = weakness[name]({ studentId, subject: '數學', days: 90 });
                    const res = await query(text, values);
                    assert.ok(Array.isArray(res.rows), `${name} 應回列`);
                }
            });
        });

        // ───────── P-06：家族互斥接進 generatePaper 之後的行為 ─────────

        describe('generatePaper 的家族互斥（第 2.2 條）', () => {
            /** 建一個章節內含變式家族的題庫，回傳 { rootIds, variantIds }。 */
            async function seedFamilies({ families, variantsPerFamily }) {
                await ensureStudentA();   // 裁決 S4-1：不再自動建學生
                const total = families * (1 + variantsPerFamily);
                const rows = Array.from({ length: total }, (_, i) => i);
                const { rows: inserted } = await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     SELECT '數學', '向量內積', '計算', 3,
                            '自製家族測試題 ' || x || '：求 $\\vec{a} \\cdot \\vec{b}$。', '測試答案 ' || x
                       FROM unnest($1::int[]) AS x
                     RETURNING id`,
                    [rows]
                );
                const ids = inserted.map(r => r.id);
                const rootIds = ids.slice(0, families);
                const variantIds = ids.slice(families);
                // 前 families 個當藍本，其餘平均掛到各藍本底下
                for (let i = 0; i < variantIds.length; i++) {
                    await query(`UPDATE questions SET variant_of = $1, origin = 'variant' WHERE id = $2`,
                        [rootIds[i % families], variantIds[i]]);
                }
                return { rootIds, variantIds };
            }

            /** 裁決 S4-1：generate-paper 不再自動建學生，家族互斥的案例先把學生插好。 */
            async function ensureStudentA() {
                await query("INSERT INTO students (name) VALUES ('測試學生A') ON CONFLICT (name) DO NOTHING");
            }

            test('同一家族在同一張卷只會出現一題', async () => {
                // 3 個家族 × (1 藍本 + 3 變式) = 12 題，但只抽得到 3 題
                const { rootIds } = await seedFamilies({ families: 3, variantsPerFamily: 3 });

                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '測試學生A', subject: '數學', chapter: '向量內積', count: 3 });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.question_ids.length, 3);

                const { rows } = await query(
                    'SELECT id, variant_of FROM questions WHERE id = ANY($1::int[])',
                    [res.body.question_ids]
                );
                const families = rows.map(r => r.variant_of ?? r.id);
                assert.equal(new Set(families).size, 3, '三題必須來自三個不同家族');
                assert.ok(families.every(f => rootIds.includes(f)));
            });

            test('庫存不足的 400 檢查在家族互斥之後，${n} 是家族數（裁決 S3-6）', async () => {
                // 8 題但全屬 2 個家族：舊順序（先檢查再收斂）會放行 count=4 然後只抽得到 2 題
                await seedFamilies({ families: 2, variantsPerFamily: 3 });

                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '測試學生A', subject: '數學', chapter: '向量內積', count: 4 });
                assert.equal(res.status, 400);
                assert.equal(res.body.message,
                    '新題目庫存不足！該章節 [測試學生A] 沒寫過的題目僅剩 2 題。');
            });

            test('回滾乾淨：庫存不足時不留下試卷或 attempts（學生為事先建立，S4-1 後不歸這筆請求管）', async () => {
                await seedFamilies({ families: 2, variantsPerFamily: 3 });
                await request(app).post('/api/generate-paper')
                    .send({ student_name: '測試學生A', subject: '數學', chapter: '向量內積', count: 4 });

                const { rows: [stu] } = await query('SELECT COUNT(*)::int AS n FROM students');
                assert.equal(stu.n, 1, '事先建立的學生應原封不動');
                for (const table of ['exam_papers', 'attempts']) {
                    const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
                    assert.equal(n, 0, `${table} 應為空`);
                }
            });

            test('沒有任何變式時行為與階段 1 相同（回應形狀不變，既有整合測試是契約）', async () => {
                await seedQuestions(0); // no-op，只是說明這裡刻意不建家族
                await ensureStudentA();   // 裁決 S4-1：不再自動建學生
                const { rows: inserted } = await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     SELECT '數學', '向量內積', '計算', 3,
                            '自製無變式題 ' || x || '：求 $\\vec{a} \\cdot \\vec{b}$。', '測試答案 ' || x
                       FROM generate_series(1, 10) AS x
                     RETURNING id`
                );
                assert.equal(inserted.length, 10);

                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '測試學生A', subject: '數學', chapter: '向量內積', count: 5 });
                assert.equal(res.status, 200);
                assert.deepEqual(Object.keys(res.body).sort(),
                    ['message', 'paper_id', 'paper_title', 'question_ids', 'questions']);
                assert.equal(res.body.question_ids.length, 5);
                assert.equal(new Set(res.body.question_ids).size, 5);
            });

            test('組卷 → 批改 → 弱點面板：整條路徑接得起來', async () => {
                await ensureStudentA();   // 裁決 S4-1：不再自動建學生
                await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     SELECT '數學', '向量內積', '計算', 3,
                            '自製串接測試題 ' || x || '：求 $\\vec{a} \\cdot \\vec{b}$。', '測試答案 ' || x
                       FROM generate_series(1, 6) AS x`
                );

                const paper = await request(app).post('/api/generate-paper')
                    .send({ student_name: '測試學生A', subject: '數學', chapter: '向量內積', count: 4 });
                assert.equal(paper.status, 200);
                const paperId = paper.body.paper_id;
                const qids = paper.body.question_ids;

                // 學生清單看得到這張卷、還沒批改
                const students = await request(app).get('/api/students');
                const me = students.body.items.find(s => s.name === '測試學生A');
                assert.deepEqual({ papers: me.papers, graded_ratio: me.graded_ratio }, { papers: 1, graded_ratio: 0 });

                // 試卷明細的順序 = 組卷回傳的順序
                const detail = await request(app).get(`/api/papers/${paperId}`);
                assert.deepEqual(detail.body.questions.map(q => q.question_id), qids);

                // 批改：兩對兩錯
                const patch = await request(app).patch(`/api/papers/${paperId}/results`).send({
                    results: qids.map((qid, i) => ({ question_id: qid, result: i < 2 ? 0 : 1 }))
                });
                assert.deepEqual(patch.body, { updated: 4 });

                // 弱點面板看得到 2/4
                const weak = await request(app).get(`/api/students/${me.id}/weakness`);
                const chapter = weak.body.by_chapter.find(r => r.chapter === '向量內積');
                assert.deepEqual(
                    { assigned: chapter.assigned, graded: chapter.graded, wrong: chapter.wrong, wrong_rate: chapter.wrong_rate },
                    { assigned: 4, graded: 4, wrong: 2, wrong_rate: 0.5 }
                );
                assert.equal(chapter.low_sample, true, 'graded = 4 < WEAKNESS_MIN_N（5）');
                assert.equal(weak.body.recent_wrong.length, 2);

                // 試卷清單的 graded 也跟著動
                const papers = await request(app).get(`/api/students/${me.id}/papers`);
                assert.deepEqual(
                    { total: papers.body.items[0].total, graded: papers.body.items[0].graded },
                    { total: 4, graded: 4 }
                );
            });
        });
    });
}
