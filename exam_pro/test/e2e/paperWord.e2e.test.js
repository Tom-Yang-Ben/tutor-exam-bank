// ─────────────────────────────────────────────────────────────
// test/e2e/paperWord.e2e.test.js — E-X15 ②：組卷 → 下載 Word，公式必須是 <m:oMath>
//
// 這一條走的是**真實的 HTTP 路徑**：POST /api/generate-paper → POST /api/download-word，
// 再把回來的 .docx 解壓開來看 word/document.xml。
//
// 為什麼是 e2e 而不是單元測試：utils/textFormatter.js 已經有非常完整的單元測試
// （test/unit/textFormatter.test.js 的四十幾項），但那些測的是「解析器把 LaTeX 變成什麼」。
// 這一條測的是**整條線有沒有接上**：組卷回來的 question_ids 進得了 download-word、
// wordService 有真的呼叫 parseLatexToMath、docx 套件有把 m:oMath 寫進 XML。
// 中間任何一段被改成「先轉純文字再塞進段落」，單元測試全綠、Word 打開來公式變一行亂碼。
//
// textFormatter 的降級是**靜默的**（解析失敗走 catch 剝成純文字，README「介面截圖」那節有寫）：
// 所以「沒有 m:oMath」不會噴任何錯，只會安靜地少掉。這條斷言就是那個缺口的補丁。
//
// 三道防線與 test/integration/ 完全一致：只讀 TEST_DATABASE_URL、庫名須 _test 結尾、
// 在 require config/db 之前覆寫 DATABASE_URL。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('組卷 → Word 匯出 e2e（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:e2e（本機需先 export TEST_DATABASE_URL）'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行 e2e');
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
    const { documentXml } = require('./lib/docx');

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';
    const STUDENT = 'E2E 測試學生-Word';
    // 兩個案例各用一位學生：組卷會寫 attempts(student_id, question_id) 的 UNIQUE，
    // 同一位學生抽第二次會因為「沒寫過的題目僅剩 0 題」而 400。
    const STUDENTS = [STUDENT, `${STUDENT}-2`];

    /** 清掉本檔造出來的學生、試卷與作答（attempts 先走，questions 是 ON DELETE RESTRICT）。 */
    async function cleanStudents() {
        await query(`DELETE FROM attempts WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [STUDENTS]);
        await query(`DELETE FROM exam_papers WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [STUDENTS]);
        await query(`DELETE FROM students WHERE name = ANY($1::text[])`, [STUDENTS]);
    }

    // 全部是自製題（不得把真實考卷寫進 repo，硬規則第 4 條）。
    // 刻意各挑一種會走到不同 OOXML 節點的公式：分數 m:f、上標 m:sSup、根號 m:rad。
    //
    // 題幹一律帶「E2E-WORD」這個記號。測試庫是共用的，裡面本來就有 seed 題與別支測試留下的題：
    // 不帶記號時 `ON CONFLICT DO NOTHING` 會命中既有的同題幹題目，於是這裡斷言的 answer_text
    // （$\frac{3}{2}$）根本沒被寫進去——症狀是「單獨跑會過、跟別人一起跑就說沒有 <m:f>」。
    const MARK = 'E2E-WORD';
    const QUESTIONS = [
        {
            question_type: '填空', difficulty: 3,
            question_text: `[${MARK}] 設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。`,
            answer_text: '$k = -\\frac{3}{2}$'
        },
        {
            question_type: '計算', difficulty: 2,
            question_text: `[${MARK}] 求 $\\vec{a}=(3,4)$ 的長度 $|\\vec{a}|$。`,
            answer_text: '$|\\vec{a}| = \\sqrt{3^2 + 4^2} = 5$'
        },
        {
            question_type: '證明', difficulty: 4,
            question_text: `[${MARK}] 試證：對任意平面向量恆有 $|\\vec{a}\\cdot\\vec{b}| \\leq |\\vec{a}||\\vec{b}|$。`,
            answer_text: '設夾角為 $\\theta$，由 $|\\cos\\theta| \\leq 1$ 即得。'
        }
    ];

    describe('E-X15 ② 組卷 → download-word（PostgreSQL）', () => {
        let questionIds = [];          // 這次組卷會用到的題（可能含既有的）
        let insertedIds = [];          // **本檔真的插進去的**題，只有這些可以刪

        before(async () => {
            // 只清掉這支測試自己造的東西：questions 是所有整合測試共用的表，
            // 全表 TRUNCATE 等於把別人的資料也一起殺掉（jobs.pg.test.js 的同一條線）。
            await cleanStudents();
            // 上一輪被中斷時可能留下同記號的題目；先清掉，這一輪才會真的重新插入
            // （斷言的是 answer_text 的解析結果，借用既有列會讓斷言對到別人的答案）。
            await query(
                `DELETE FROM questions WHERE question_text LIKE $1
                   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = questions.id)`,
                [`[${MARK}]%`]);

            questionIds = [];
            insertedIds = [];
            for (const q of QUESTIONS) {
                const { rows } = await query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin)
                     VALUES ($1, $2, $3, $4, $5, $6, 'manual')
                     ON CONFLICT DO NOTHING
                     RETURNING id`,
                    [SUBJECT, CHAPTER, q.question_type, q.difficulty, q.question_text, q.answer_text]
                );
                if (rows.length) { questionIds.push(rows[0].id); insertedIds.push(rows[0].id); continue; }
                // uq_questions_text_hash_active 命中（測試庫裡本來就有同一題，例如 seed 題）：
                // 撈既有那一列來用，但**不加進 insertedIds**——不是我們造的就不該由我們刪掉。
                const { rows: existing } = await query(
                    `SELECT id FROM questions WHERE question_text = $1 AND archived_at IS NULL LIMIT 1`,
                    [q.question_text]);
                assert.ok(existing.length, `題目已存在但撈不回來：${q.question_text.slice(0, 20)}`);
                questionIds.push(existing[0].id);
            }

            // ── 讓候選池剛好只剩本檔這三題 ──
            //
            // generatePaper 的候選池是「同學科同章、未封存、**且該生沒寫過**」，然後洗牌抽 N 題。
            // 測試庫是共用的：這一章裡本來就有 seed 題與別支測試留下的題，抽出來的三題
            // 很可能不是我們插的那三題，於是「有沒有 <m:f>」變成擲骰子——實際就是這樣間歇失敗的。
            //
            // 這裡不去封存別人的題（那會影響其他測試），改用**產品本身的排除機制**：
            // 先幫這兩位測試學生把「這一章裡不是我們的題」全部記成已指派。
            // 候選池因此剛好等於本檔的三題，抽誰都一樣。這些 attempts 由 cleanStudents() 清掉。
            for (const name of STUDENTS) {
                const { rows: [student] } = await query(
                    `INSERT INTO students (name) VALUES ($1)
                     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
                await query(
                    `INSERT INTO attempts (student_id, question_id, assigned_at)
                     SELECT $1::int, q.id, CURRENT_DATE
                       FROM questions q
                      WHERE q.subject = $2 AND q.chapter = $3 AND q.archived_at IS NULL
                        AND NOT (q.id = ANY($4::int[]))
                     ON CONFLICT (student_id, question_id) DO NOTHING`,
                    [student.id, SUBJECT, CHAPTER, questionIds]);
            }
        });

        after(async () => {
            await cleanStudents();
            // 只刪**本檔真的插進去的**題。測試庫是共用的：撞到既有題（seed 或別支測試留下的）
            // 時我們是「借來用」，不是擁有者，刪掉會讓下一支測試莫名其妙地少了資料。
            // attempts 在 cleanStudents() 已經先刪，所以 ON DELETE RESTRICT 不會擋。
            await query('DELETE FROM questions WHERE id = ANY($1::int[])', [insertedIds]);
            await pool.end();
        });

        test('組卷回 200，且回應帶 paper_id（前端「立即批改」靠它，interfaces.md 第 7 條）', async () => {
            // 裁決 S4-1：generate-paper 不再自動建學生，先走唯一合法入口（重跑時可能已存在 → 409 也接受）
            const created = await request(app).post('/api/students').send({ name: STUDENT });
            assert.ok([201, 409].includes(created.status), JSON.stringify(created.body));
            const res = await request(app)
                .post('/api/generate-paper')
                .send({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: QUESTIONS.length });

            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.ok(Number.isInteger(res.body.paper_id), `paper_id 不是整數：${res.body.paper_id}`);
            assert.equal(res.body.question_ids.length, QUESTIONS.length);
            assert.equal(res.body.questions.length, QUESTIONS.length);
            assert.ok(res.body.paper_title.includes(STUDENT), res.body.paper_title);

            // 組卷同時要把 attempts 寫出來（未批改＝result IS NULL），
            // 否則學生分頁的試卷列表會顯示 0/0，弱點面板也不會有分母。
            const { rows } = await query(
                `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE result IS NULL)::int AS ungraded
                   FROM attempts WHERE paper_id = $1`, [res.body.paper_id]);
            assert.equal(rows[0].n, QUESTIONS.length);
            assert.equal(rows[0].ungraded, QUESTIONS.length);
        });

        test('download-word 回真的 .docx，且公式是 <m:oMath> 不是純文字', async () => {
            const created2 = await request(app).post('/api/students').send({ name: `${STUDENT}-2` });
            assert.ok([201, 409].includes(created2.status), JSON.stringify(created2.body));
            const paper = await request(app)
                .post('/api/generate-paper')
                .send({ student_name: `${STUDENT}-2`, subject: SUBJECT, chapter: CHAPTER, count: QUESTIONS.length });
            assert.equal(paper.status, 200, JSON.stringify(paper.body));

            const res = await request(app)
                .post('/api/download-word')
                .send({
                    paper_title: paper.body.paper_title,
                    student_name: `${STUDENT}-2`,
                    question_ids: paper.body.question_ids,
                    // 前端的 currentPaperCache 階段 3 多存了 paper_id（interfaces-stage3.md 第 7.2 條
                    // 第 5 列），而 downloadWord 只解構三個鍵——多這個鍵不得讓匯出壞掉。
                    paper_id: paper.body.paper_id
                })
                .buffer(true)
                .parse((res, cb) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => cb(null, Buffer.concat(chunks)));
                });

            assert.equal(res.status, 200);
            assert.match(res.headers['content-type'],
                /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
            assert.ok(res.body.length > 5000, `.docx 只有 ${res.body.length} bytes，看起來不是完整檔案`);

            const xml = documentXml(res.body);
            // 這一行就是整條 e2e 的重點：公式必須是 OOXML 的數學節點。
            // 靜默降級的症狀是 xml 裡完全沒有 m:oMath，而 HTTP 200、檔案大小正常。
            assert.ok(xml.includes('<m:oMath'), 'word/document.xml 裡沒有任何 <m:oMath>：公式被降級成純文字了');

            // 三種結構各挑一個節點：分數、上標、根號。缺哪一個就知道是哪一類降級。
            assert.ok(xml.includes('<m:f>'), '沒有分數節點 <m:f>（$\\frac{3}{2}$ 沒被解析）');
            assert.ok(xml.includes('<m:sSup>'), '沒有上標節點 <m:sSup>（$3^2$ 沒被解析）');
            assert.ok(xml.includes('<m:rad>'), '沒有根號節點 <m:rad>（$\\sqrt{…}$ 沒被解析）');

            // 中文不得被吞進公式（README「中英混排」那條契約的 e2e 版本）：
            // 題號與標題的中文必須留在一般的 w:t 裡。
            assert.ok(xml.includes('<w:t'), '整份文件沒有任何一般文字節點');
            assert.ok(xml.includes(`${STUDENT}-2`) || xml.includes('特訓卷'), '文件裡找不到卷名或學生姓名');
        });

        test('question_ids 給空陣列回 400（凍結訊息）', async () => {
            const res = await request(app)
                .post('/api/download-word')
                .send({ paper_title: 'x', student_name: 'y', question_ids: [] });
            assert.equal(res.status, 400);
            assert.equal(res.body.message, '無效的題目資料，無法產生 Word');
        });
    });
}
