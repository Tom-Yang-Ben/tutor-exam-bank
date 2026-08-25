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

    /** 裁決 S4-1：generate-paper 不再自動建學生，測試先走唯一合法入口 POST /api/students。 */
    async function createStudent(name) {
        const res = await request(app).post('/api/students').send({ name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
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

        test('migrations 全部套用（以 migrations/ 目錄為準，之後新增的支數也會被涵蓋）', async () => {
            const files = require('node:fs')
                .readdirSync(path.join(APP_DIR, 'migrations'))
                .filter(f => f.endsWith('.sql')).sort();
            assert.ok(files.includes('0001_init.sql') && files.includes('0002_vector.sql'));
            const { rows } = await query('SELECT version FROM schema_migrations ORDER BY version');
            assert.deepEqual(rows.map(r => r.version), files);
        });

        // ── generate-paper ────────────────────────────────────────
        test('連抽兩次不重疊，且回應帶 paper_id', async () => {
            await seedQuestions(10);
            await createStudent('王小明');

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
            await createStudent('王小明');
            await createStudent('陳大文');
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
            await createStudent(name);
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
            await createStudent('王小明');
            try {
                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.equal(res.status, 409);
                assert.equal(res.body.message, '部分題目已被同時指派給該學生，請重試。');
            } finally { await drop(); }

            // 回滾後不得留下半張卷、半筆作答紀錄（學生是事先建立的，S4-1 之後不歸這筆交易管）
            for (const t of ['exam_papers', 'attempts']) {
                const { rows } = await query(`SELECT COUNT(*) AS n FROM ${t}`);
                assert.equal(rows[0].n, 0, `${t} 應在回滾後為空`);
            }
        });

        test('第二句 INSERT 直接拋錯時整筆交易回滾（試卷不會留下）', async () => {
            await seedQuestions(3);
            await createStudent('王小明');
            const drop = await withAttemptsTrigger(`RAISE EXCEPTION '故意讓 attempts 寫入失敗';`);
            try {
                const res = await request(app).post('/api/generate-paper')
                    .send({ student_name: '王小明', subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.equal(res.status, 500);
            } finally { await drop(); }

            for (const t of ['exam_papers', 'attempts']) {
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
            await createStudent('王小明');
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
            await createStudent('王小明');
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

        // ── §12.4 檢索欄位同步 ────────────────────────────────────
        test('新增的題目立刻就有 search_tsv（不依賴金鑰或 EMBED_MODE）', async () => {
            const res = await request(app).post('/api/questions').send({
                subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
                question_text: '自製測試題：質量 $m$ 的物體沿半徑 $r$ 的圓周運動，求向心力大小。',
                answer_text: '$F = \\frac{mv^2}{r}$'
            });
            assert.equal(res.status, 201);
            const id = res.body.questionId;

            const { rows } = await query(
                `SELECT search_tsv IS NOT NULL AS has_tsv, embedding IS NULL AS no_vec,
                        search_tsv::text AS tsv FROM questions WHERE id = $1`, [id]);
            assert.equal(rows[0].has_tsv, true, '新題必須立刻有 search_tsv（interfaces-stage1.md 12.4）');
            // 章節段權重 A、題幹段權重 B；兩段都要進得去
            assert.match(rows[0].tsv, /'向心力':\d+A/, '章節 token 必須是權重 A');
            assert.match(rows[0].tsv, /'圓周運動':\d+B/, '題幹 token 必須是權重 B');
            // embedding 尚未產生也沒關係：它是 NULL，backfill 的 --missing-only 撿得到
            assert.equal(rows[0].no_vec, true);

            // 分詞後的詞真的查得到（to_tsquery 走同一個 'simple' 字典）
            const { rows: hit } = await query(
                `SELECT id FROM questions WHERE search_tsv @@ to_tsquery('simple', $1)`, ['向心力']);
            assert.deepEqual(hit.map(r => r.id), [id]);
        });

        test('改過題目後 search_tsv 跟著更新，embed_hash 被設為 NULL 等 backfill', async () => {
            const [id] = await seedQuestions(1);
            // 先假裝這題已經被回填過：有向量、有 hash
            await query(
                `UPDATE questions SET embed_hash = repeat('a', 64), embedding_model = 'x',
                        embedding = $2::vector, embedded_at = now(),
                        search_tsv = to_tsvector('simple', '舊的內容')
                  WHERE id = $1`,
                [id, `[${Array.from({ length: 768 }, () => 0.001).join(',')}]`]);

            const res = await request(app).put(`/api/questions/${id}`).send({
                subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
                question_text: '自製測試題：改寫後的題幹，求向心加速度。', answer_text: '略'
            });
            assert.equal(res.status, 200);

            const { rows } = await query(
                `SELECT embed_hash, embedding IS NULL AS no_vec, search_tsv::text AS tsv
                   FROM questions WHERE id = $1`, [id]);
            assert.equal(rows[0].embed_hash, null, 'embed_text 的來源欄位變了就要清掉 hash');
            assert.equal(rows[0].no_vec, false, 'embedding 刻意保留，補上新向量前 /similar 仍找得到這題');
            assert.match(rows[0].tsv, /'向心加速度'|'向心力'/, 'search_tsv 必須換成新內容');
            assert.equal(/舊的內容/.test(rows[0].tsv), false);

            // backfill 的 --missing-only 條件（embed_hash IS NULL）撿得到它
            const { rows: pending } = await query(
                `SELECT id FROM questions
                  WHERE archived_at IS NULL AND (embedding IS NULL OR embed_hash IS NULL)`);
            assert.equal(pending.some(r => r.id === id), true);
        });

        test('內容沒變的更新不會白白清掉 embed_hash', async () => {
            const [id] = await seedQuestions(1);
            const { rows: before } = await query(
                `SELECT subject, chapter, question_type, difficulty, question_text FROM questions WHERE id = $1`, [id]);
            await query(`UPDATE questions SET embed_hash = repeat('b', 64) WHERE id = $1`, [id]);

            // 只改 answer_text（不屬於 embed_text 的來源欄位）
            const res = await request(app).put(`/api/questions/${id}`).send({ ...before[0], answer_text: '換一個答案' });
            assert.equal(res.status, 200);

            const { rows } = await query('SELECT embed_hash FROM questions WHERE id = $1', [id]);
            assert.equal(rows[0].embed_hash, 'b'.repeat(64), 'embed_text 沒變就不該觸發重算');
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

        // ── 階段 4：學生管理與出卷生命週期（docs/roadmap-plan.md §6.2）──
        test('S4-1：查無學生回 404（不再自動建學生），students 表保持乾淨', async () => {
            await seedQuestions(5);
            const res = await request(app).post('/api/generate-paper')
                .send({ student_name: '幽靈學生', subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(res.status, 404);
            assert.equal(res.body.message, '查無學生「幽靈學生」，請先新增學生。');
            const { rows } = await query('SELECT COUNT(*)::int AS n FROM students');
            assert.equal(rows[0].n, 0, '404 之後不得留下任何學生列');
        });

        test('學生 CRUD：建立 201、重名 409、改名、刪除連紀錄', async () => {
            const id = await createStudent('收斂測試生');
            const dup = await request(app).post('/api/students').send({ name: '收斂測試生' });
            assert.equal(dup.status, 409);

            const renamed = await request(app).patch(`/api/students/${id}`).send({ name: '收斂測試生二號' });
            assert.equal(renamed.status, 200);
            assert.equal(renamed.body.name, '收斂測試生二號');

            // 出一張卷讓刪除有東西可連動
            await seedQuestions(3);
            const paper = await request(app).post('/api/generate-paper')
                .send({ student_id: id, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(paper.status, 200, JSON.stringify(paper.body));

            const del = await request(app).delete(`/api/students/${id}`);
            assert.equal(del.status, 200);
            assert.deepEqual(del.body, { deleted: { attempts: 3, papers: 1 } });
            for (const t of ['attempts', 'exam_papers', 'students']) {
                const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${t}`);
                assert.equal(rows[0].n, 0, `${t} 應被連動刪除`);
            }
        });

        test('合併：衝突題保留目標側批改、其餘搬家、來源學生消失', async () => {
            const ids = await seedQuestions(4);
            const fromId = await createStudent('分身');
            const intoId = await createStudent('本尊');
            // 本尊寫過前兩題（其中一題已批改），分身寫過第 2~4 題
            await query(
                `INSERT INTO attempts (student_id, question_id, assigned_at, result, graded_at)
                 VALUES ($1,$3,CURRENT_DATE,1,now()), ($1,$4,CURRENT_DATE,NULL,NULL),
                        ($2,$4,CURRENT_DATE,0,now()), ($2,$5,CURRENT_DATE,NULL,NULL), ($2,$6,CURRENT_DATE,NULL,NULL)`,
                [intoId, fromId, ids[0], ids[1], ids[2], ids[3]]
            );
            const res = await request(app).post(`/api/students/${fromId}/merge`).send({ into_id: intoId });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body, { moved_attempts: 2, dropped_conflicts: 1, moved_papers: 0 });

            // 衝突題（ids[1]）保留目標側的 result（NULL，本尊還沒批），來源側的 0 被丟棄
            const { rows } = await query(
                'SELECT question_id, result FROM attempts WHERE student_id = $1 ORDER BY question_id', [intoId]);
            assert.deepEqual(rows.map(r => [r.question_id, r.result]),
                [[ids[0], 1], [ids[1], null], [ids[2], null], [ids[3], null]]);
            const { rows: gone } = await query('SELECT COUNT(*)::int AS n FROM students WHERE id = $1', [fromId]);
            assert.equal(gone[0].n, 0, '來源學生應被刪除');
        });

        test('dry_run：整段不寫庫，exclude_ids 真的排除（換一題的機制）', async () => {
            const ids = await seedQuestions(5);
            const sid = await createStudent('草稿生');
            const p1 = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3, dry_run: true });
            assert.equal(p1.status, 200, JSON.stringify(p1.body));
            assert.equal(p1.body.dry_run, true);
            assert.equal(p1.body.question_ids.length, 3);
            assert.ok(p1.body.paper_title_preview.includes('草稿生'));
            for (const t of ['exam_papers', 'attempts']) {
                const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${t}`);
                assert.equal(rows[0].n, 0, `dry_run 不得寫 ${t}`);
            }
            // 換一題：把第一題排除，重抽 3 題必不含它
            const excluded = p1.body.question_ids[0];
            const p2 = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3, dry_run: true, exclude_ids: [excluded] });
            assert.equal(p2.status, 200);
            assert.ok(!p2.body.question_ids.includes(excluded), 'exclude_ids 沒有生效');
        });

        test('confirm-paper：寫入與 generate 同閘門；預覽過期回 409；回應形狀一致', async () => {
            const ids = await seedQuestions(4);
            const sid = await createStudent('確認生');
            const ok = await request(app).post('/api/confirm-paper')
                .send({ student_id: sid, question_ids: ids.slice(0, 3) });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            assert.ok(Number.isInteger(ok.body.paper_id));
            assert.equal(ok.body.question_ids.length, 3);
            assert.equal(ok.body.questions.length, 3);
            assert.ok(ok.body.paper_title.includes('確認生'));

            // 同一批題再確認一次 ⇒ attempts 唯一鍵擋下、409、不留半張卷
            const stale = await request(app).post('/api/confirm-paper')
                .send({ student_id: sid, question_ids: ids.slice(0, 3) });
            assert.equal(stale.status, 409);
            const { rows } = await query('SELECT COUNT(*)::int AS n FROM exam_papers');
            assert.equal(rows[0].n, 1, '409 之後不得多出半張卷');

            // 封存的題直接 400
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [ids[3]]);
            const archived = await request(app).post('/api/confirm-paper')
                .send({ student_id: sid, question_ids: [ids[3]] });
            assert.equal(archived.status, 400);
            assert.equal(archived.body.message, '部分題目已不存在或已封存，請重新預覽。');
        });

        test('DELETE /papers/:id：題目回到候選池（裁決 S4-3）', async () => {
            await seedQuestions(3);
            const sid = await createStudent('後悔生');
            const paper = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(paper.status, 200);

            // 池已被燒光：再出一張同章卷會 400
            const empty = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(empty.status, 400);

            const del = await request(app).delete(`/api/papers/${paper.body.paper_id}`);
            assert.equal(del.status, 200);
            assert.equal(del.body.deleted_attempts, 3);

            // 題目回池：同一批題又抽得到了
            const again = await request(app).post('/api/generate-paper')
                .send({ student_id: sid, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.equal(again.status, 200, JSON.stringify(again.body));

            const missing = await request(app).delete('/api/papers/999999');
            assert.equal(missing.status, 404);
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
