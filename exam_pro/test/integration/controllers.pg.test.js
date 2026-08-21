// ─────────────────────────────────────────────────────────────
// controllers.pg.test.js — controller 層的整合測試（E-X9b，擁有者 WS-A）
//
// 這是唯一會連真資料庫的一層。三道防線讓 `npm test` 永遠不會誤打到題庫：
//   1. **只讀 process.env.TEST_DATABASE_URL，本檔絕不 require('dotenv')**。
//      `npm test`（= node --test）不會預載 .env，因此這支整支被 skip。
//      要跑它請自己把變數帶進來，例如：
//          node -r dotenv/config --test "test/integration/**/*.test.js"
//      （Node 24 在 Windows 上 `--test <目錄>` 會把目錄當成模組去 require 而失敗，
//        必須用上面的 glob 形式——這一點也適用於 WS-D 之後要改的 npm test）
//      CI 則由 workflow 的 env 直接給（WS-D 的 D-C1）。
//   2. 資料庫名必須以 `_test` 結尾，否則直接讓測試失敗（與 migrate.js 同一條防呆）。
//   3. 連線在 require config/db.js **之前**就把 DATABASE_URL 覆寫成測試庫，
//      app 底下所有 controller 因此一定連在測試庫上。
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
    test('controller 整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 node -r dotenv/config --test "test/integration/**/*.test.js"'
    }, () => { });
} else {
    // 防呆與 migrate.js 一致：整合測試絕不能打到真題庫
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
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';

    /** 灌 n 題進同一章，回傳 id 陣列（順序 = id 由小到大）。 */
    async function seedQuestions(n, { subject = SUBJECT, chapter = CHAPTER } = {}) {
        const idx = Array.from({ length: n }, (_, i) => i + 1);
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[])
             RETURNING id`,
            [
                idx.map(() => subject),
                idx.map(() => chapter),
                idx.map(i => (i % 2 === 0 ? '計算' : '填空')),
                idx.map(i => (i % 5) + 1),
                idx.map(i => `自製測試題 ${chapter} 第 ${i} 題：求 $a \\cdot b$。`),
                idx.map(i => `測試答案 ${i}`)
            ]
        );
        return rows.map(r => r.id).sort((a, b) => a - b);
    }

    /** 在 attempts 上裝一個「故意搞破壞」的 BEFORE INSERT 觸發器，回傳拆除函式。 */
    async function withAttemptsTrigger(bodySql) {
        await query(`CREATE OR REPLACE FUNCTION test_attempts_sabotage() RETURNS trigger
                     LANGUAGE plpgsql AS $fn$ BEGIN ${bodySql} END $fn$`);
        await query(`CREATE TRIGGER test_attempts_sabotage BEFORE INSERT ON attempts
                     FOR EACH ROW EXECUTE FUNCTION test_attempts_sabotage()`);
        return async () => {
            await query('DROP TRIGGER IF EXISTS test_attempts_sabotage ON attempts');
            await query('DROP FUNCTION IF EXISTS test_attempts_sabotage()');
        };
    }

    describe('controller × PostgreSQL 整合測試', () => {
        before(() => {
            // 先跑 migrate（只前進、重跑是 no-op），確保測試庫的 schema 與 migrations 一致
            const out = execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR,
                env: { ...process.env, TEST_DATABASE_URL },
                encoding: 'utf8'
            });
            assert.ok(out.length > 0, 'migrate.js 應有輸出');
        });

        beforeEach(async () => {
            await query('DROP TRIGGER IF EXISTS test_attempts_sabotage ON attempts');
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });

        after(async () => {
            await query('DROP TRIGGER IF EXISTS test_attempts_sabotage ON attempts');
            await query('DROP FUNCTION IF EXISTS test_attempts_sabotage()');
            await pool.end();
        });

        test('migrations 兩支都已套用', async () => {
            const { rows } = await query('SELECT version FROM schema_migrations ORDER BY version');
            assert.deepEqual(rows.map(r => r.version), ['0001_init.sql', '0002_vector.sql']);
        });

        // ── generate-paper ────────────────────────────────────────
        test('連抽兩次不重疊，且回應帶 paper_id', async () => {
            await seedQuestions(10);

            const first = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(first.status, 200);
            assert.equal(typeof first.body.paper_id, 'number');
            assert.equal(first.body.question_ids.length, 5);

            const second = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(second.status, 200);
            assert.equal(second.body.question_ids.length, 5);

            const overlap = first.body.question_ids.filter(id => second.body.question_ids.includes(id));
            assert.deepEqual(overlap, [], '同一位學生兩次抽到的題目不得重疊');

            // exam_papers 的 question_ids 是 INT[]，順序即出題順序
            const { rows } = await query('SELECT id, student_id, question_ids FROM exam_papers ORDER BY id');
            assert.equal(rows.length, 2);
            assert.deepEqual(rows[0].question_ids, first.body.question_ids);
            assert.equal(rows[0].id, first.body.paper_id);

            // attempts 共 10 筆、都掛在同一位學生底下
            const { rows: cnt } = await query('SELECT COUNT(*) AS n, COUNT(DISTINCT student_id) AS s FROM attempts');
            assert.equal(cnt[0].n, 10);
            assert.equal(cnt[0].s, 1);
        });

        test('另一位學生不受影響，同一批題目照樣抽得到', async () => {
            await seedQuestions(5);
            const a = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            const b = await request(app).post('/api/generate-paper')
                .send({ student_name: '陳大文', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(a.status, 200);
            assert.equal(b.status, 200);
            assert.deepEqual([...a.body.question_ids].sort(), [...b.body.question_ids].sort());
        });

        test('庫存不足回 400，訊息逐字不變（含未削字的姓名）', async () => {
            await seedQuestions(6);
            const name = '王"小\\明';   // 新設計不再削除 " 與 \，訊息裡用的是 trim 後的原名
            const ok = await request(app).post('/api/generate-paper')
                .send({ student_name: name, subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(ok.status, 200);

            const short = await request(app).post('/api/generate-paper')
                .send({ student_name: name, subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(short.status, 400);
            assert.equal(short.body.message, `新題目庫存不足！該章節 [${name}] 沒寫過的題目僅剩 1 題。`);

            const { rows } = await query('SELECT name FROM students');
            assert.deepEqual(rows.map(r => r.name), [name]);
        });

        test('必填與數量的 400 訊息逐字不變', async () => {
            const cases = [
                [{ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER }, '所有篩選欄位皆為必填！'],
                [{ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 0 }, '抽題數量必須為大於 0 的整數！'],
                [{ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 51 }, '抽題數量過大，單次最多 50 題。'],
                [{ student_name: '   ', subject: SUBJECT, chapter: CHAPTER, count: 5 }, '學生姓名無效！']
            ];
            for (const [body, message] of cases) {
                const res = await request(app).post('/api/generate-paper').send(body);
                assert.equal(res.status, 400);
                assert.equal(res.body.message, message);
            }
        });

        test('attempts 寫入筆數短少時回 409，訊息逐字不變且整筆交易回滾', async () => {
            const ids = await seedQuestions(3);
            // 讓其中一題的 attempts 靜默地寫不進去（BEFORE INSERT 回 NULL 會跳過該列，
            // rowCount 因此少 1）——等同「該題在我們選完之後被別人搶走」的情境。
            const drop = await withAttemptsTrigger(
                `IF NEW.question_id = ${ids[0]} THEN RETURN NULL; END IF; RETURN NEW;`
            );
            try {
                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.equal(res.status, 409);
                assert.equal(res.body.message, '部分題目已被同時指派給該學生，請重試。');
            } finally { await drop(); }

            // 回滾後不得留下半張卷、半筆作答紀錄，連學生列也不該留下
            for (const t of ['exam_papers', 'attempts', 'students']) {
                const { rows } = await query(`SELECT COUNT(*) AS n FROM ${t}`);
                assert.equal(rows[0].n, 0, `${t} 應在回滾後為空`);
            }
        });

        test('第二句 INSERT 直接拋錯時整筆交易回滾（試卷不會留下）', async () => {
            await seedQuestions(3);
            const drop = await withAttemptsTrigger(`RAISE EXCEPTION '故意讓 attempts 寫入失敗';`);
            try {
                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.equal(res.status, 500);
            } finally { await drop(); }

            for (const t of ['exam_papers', 'attempts', 'students']) {
                const { rows } = await query(`SELECT COUNT(*) AS n FROM ${t}`);
                assert.equal(rows[0].n, 0, `${t} 應在回滾後為空`);
            }

            // 連線池沒有被壞掉的交易汙染，後續請求仍正常
            const ok = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(ok.status, 200);
        });

        // ── listQuestions ─────────────────────────────────────────
        test('listQuestions 的 total 是 number（不是 COUNT(*) 的字串）', async () => {
            await seedQuestions(3);
            const res = await request(app).get('/api/questions');
            assert.equal(res.status, 200);
            assert.equal(typeof res.body.total, 'number', 'total 必須是 number');
            assert.equal(res.body.total, 3);
            assert.equal(res.body.totalPages, 1);
            assert.equal(res.body.questions.length, 3);
        });

        test('listQuestions 的關鍵字搜尋走 ILIKE，且分頁參數安全', async () => {
            await seedQuestions(3);
            const hit = await request(app).get('/api/questions').query({ q: '自製測試題' });
            assert.equal(hit.body.total, 3);
            const miss = await request(app).get('/api/questions').query({ q: '不存在的關鍵字' });
            assert.equal(miss.body.total, 0);
            const paged = await request(app).get('/api/questions').query({ subject: SUBJECT, limit: 2, page: 2 });
            assert.equal(paged.body.total, 3);
            assert.equal(paged.body.questions.length, 1);
        });

        // ── deleteQuestion ────────────────────────────────────────
        test('出過的題改為封存並回 archived:true，未出過的題硬刪', async () => {
            const ids = await seedQuestions(5);
            const paper = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(paper.status, 200);

            const used = ids[0];
            const soft = await request(app).delete(`/api/questions/${used}`);
            assert.equal(soft.status, 200);
            assert.equal(soft.body.archived, true);
            assert.equal(soft.body.id, used);

            const { rows } = await query('SELECT archived_at FROM questions WHERE id = $1', [used]);
            assert.equal(rows.length, 1, '封存不得真的刪掉列');
            assert.notEqual(rows[0].archived_at, null);

            // attempts 沒有跟著消失（ON DELETE RESTRICT 的用意）
            const { rows: att } = await query('SELECT COUNT(*) AS n FROM attempts WHERE question_id = $1', [used]);
            assert.equal(att[0].n, 1);

            // 封存後不再出現在題庫列表與章節清單的候選池中
            const list = await request(app).get('/api/questions');
            assert.equal(list.body.total, 4);
            assert.equal(list.body.questions.some(q => q.id === used), false);

            // 沒有作答紀錄的題目照舊硬刪
            const [fresh] = await seedQuestions(1, { chapter: '外積' });
            const hard = await request(app).delete(`/api/questions/${fresh}`);
            assert.equal(hard.status, 200);
            assert.equal(hard.body.archived, undefined);
            const { rows: gone } = await query('SELECT 1 FROM questions WHERE id = $1', [fresh]);
            assert.equal(gone.length, 0);

            // 已封存的題目再刪一次回 404（對使用者而言它已經不存在）
            const again = await request(app).delete(`/api/questions/${used}`);
            assert.equal(again.status, 404);
            assert.equal(again.body.message, '找不到該題目');
        });

        test('封存後的題目不再進入組卷候選池', async () => {
            const ids = await seedQuestions(5);
            await query('UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[])', [ids.slice(0, 2)]);
            const res = await request(app).post('/api/generate-paper')
                .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 5 });
            assert.equal(res.status, 400);
            assert.equal(res.body.message, `新題目庫存不足！該章節 [王小明] 沒寫過的題目僅剩 3 題。`);
        });

        // ── createQuestion / updateQuestion / batchSave ────────────
        test('手動新增回 RETURNING 的 id，並標成 manual/human', async () => {
            const res = await request(app).post('/api/questions').send({
                subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 3,
                question_text: '自製測試題：求向量夾角。', answer_text: '$60^\\circ$'
            });
            assert.equal(res.status, 201);
            assert.equal(typeof res.body.questionId, 'number');
            const { rows } = await query('SELECT origin, chapter_src FROM questions WHERE id = $1', [res.body.questionId]);
            assert.deepEqual(rows[0], { origin: 'manual', chapter_src: 'human' });
        });

        test('改章節才寫 chapter_src=human；只改難度不動它', async () => {
            const ids = await seedQuestions(1);
            const base = {
                subject: SUBJECT, chapter: CHAPTER, question_type: '填空', difficulty: 4,
                question_text: '自製測試題：內積定義。', answer_text: '略'
            };
            let res = await request(app).put(`/api/questions/${ids[0]}`).send(base);
            assert.equal(res.status, 200);
            let { rows } = await query('SELECT chapter_src FROM questions WHERE id = $1', [ids[0]]);
            assert.equal(rows[0].chapter_src, 'ai', '章節沒變就不該改來源');

            res = await request(app).put(`/api/questions/${ids[0]}`).send({ ...base, chapter: '外積' });
            assert.equal(res.status, 200);
            ({ rows } = await query('SELECT chapter, chapter_src FROM questions WHERE id = $1', [ids[0]]));
            assert.deepEqual(rows[0], { chapter: '外積', chapter_src: 'human' });
        });

        test('批次入庫走 unnest，部分入庫的回應形狀不變', async () => {
            const res = await request(app).post('/api/batch-save-questions').send({
                questions: [
                    { subject: SUBJECT, chapter: CHAPTER, question_type: '填空', difficulty: 2, question_text: '自製測試題 A', answer_text: 'a' },
                    { subject: SUBJECT, chapter: '這章不存在', question_type: '填空', difficulty: 2, question_text: '自製測試題 B', answer_text: 'b' },
                    { subject: SUBJECT, chapter: CHAPTER, question_type: '計算', difficulty: 5, question_text: '自製測試題 C', answer_text: 'c' }
                ]
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.saved_count, 2);
            assert.deepEqual(res.body.rejected.map(r => r.idx), [1]);
            const { rows } = await query('SELECT origin, chapter_src FROM questions ORDER BY id');
            assert.equal(rows.length, 2);
            assert.deepEqual(rows[0], { origin: 'pdf', chapter_src: 'ai' });
        });

        test('getChapters 排除已封存的題目，且不會撞上 PG 的識別字引號', async () => {
            const ids = await seedQuestions(2);
            await seedQuestions(1, { chapter: '外積' });
            await query('UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[])', [ids]);
            const res = await request(app).get('/api/chapters');
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, [{ subject: SUBJECT, chapter: '外積' }]);
        });

        // ── wordController ────────────────────────────────────────
        test('Word 匯出以 = ANY($1::int[]) 取題，且封存過的題仍印得出來', async () => {
            const ids = await seedQuestions(3);
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [ids[0]]);
            const res = await request(app).post('/api/download-word')
                .send({ paper_title: '測試卷', student_name: '王小明', question_ids: ids });
            assert.equal(res.status, 200);
            assert.match(res.headers['content-type'], /wordprocessingml\.document/);
            assert.ok(Number(res.headers['content-length']) > 0);
        });
    });
}
