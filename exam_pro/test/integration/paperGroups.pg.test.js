// ─────────────────────────────────────────────────────────────
// paperGroups.pg.test.js — 組卷的承上題整組抽取（FR-019 PR2，ACPT-019-5）
//
// 防線與 controllers.pg.test.js 一致：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// require config/db 之前覆寫 DATABASE_URL。題幹全為自製內容。
// 涵蓋 POST /api/generate-paper（dry_run 與真出卷）、POST /api/confirm-paper 的排序、
// selectPaperQuestions 的少出題政策切換，以及助教工具 preview_paper 走同一段選題。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('承上題整組組卷整合測試（需要 PostgreSQL）', {
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

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    // 〔retrain PR-1〕attempts 是唯讀檢視（migrations/0016），夾具改用 helper 寫派題＋作答
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const exam = require(path.join(APP_DIR, 'controllers', 'examController'));
    const { TOOLS } = require(path.join(APP_DIR, 'services', 'assistantService'));

    const SUBJECT = '數學';
    const CHAPTER = '向量內積';
    const STUDENT = '承上組卷測試生';

    /** 建一題，回傳 id。 */
    async function addQ({ type = '計算', difficulty = 3, chapter = CHAPTER, follows = null, text } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    follows_question_id, follows_src)
             VALUES ($1, $2, $3, $4, $5, '測試答案', $6, $7) RETURNING id`,
            [SUBJECT, chapter, type, difficulty, text || `自製組卷承上測試題 ${Math.random()}：求 $x$。`,
                follows, follows === null ? null : 'human']
        );
        return r.id;
    }

    /** 建一條鏈：前題＋n 題承上題，回傳 [前題, 承上1, 承上2…]。 */
    async function addChain(n, opts = {}) {
        const ids = [await addQ({ ...opts, text: `自製承上鏈前題：設 $x=1$。${Math.random()}` })];
        for (let i = 0; i < n; i++) {
            ids.push(await addQ({ ...opts, follows: ids[ids.length - 1], text: `承上題，自製第 ${i + 1} 小題。${Math.random()}` }));
        }
        return ids;
    }

    async function addSingles(n, opts = {}) {
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(await addQ(opts));
        return ids;
    }

    async function createStudent(name = STUDENT) {
        const res = await request(app).post('/api/students').send({ name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    }

    function gen(body) {
        return request(app).post('/api/generate-paper')
            .send({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, ...body });
    }

    /** 斷言：鏈的每一題要嘛全在、要嘛全不在；在的話相鄰且依序。 */
    function assertChainIntact(ids, chain, label = '') {
        const present = chain.filter(id => ids.includes(id));
        if (present.length === 0) return false;
        assert.equal(present.length, chain.length, `${label} 承上組必須整組出現：${JSON.stringify({ ids, chain })}`);
        const start = ids.indexOf(chain[0]);
        assert.deepEqual(ids.slice(start, start + chain.length), chain, `${label} 承上組必須相鄰且依承接順序`);
        return true;
    }

    describe('組卷 × 承上題整組抽取（FR-019 PR2）', () => {
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

        test('要全部題數時：承上組整組出現、相鄰且依承接順序，題型權重不拆組（dry_run 與真出卷一致）', async () => {
            await createStudent();
            // 鏈首是「計算」，承上題是「單選」——逐題排序會把承上題排到最前面
            const chain = [await addQ({ type: '計算', text: '自製前題（計算）：設 $x=2$。' })];
            chain.push(await addQ({ type: '單選', follows: chain[0], text: '承上題，自製單選小題。' }));
            chain.push(await addQ({ type: '填空', follows: chain[1], text: '承上一題，自製填空小題。' }));
            const singles = await addSingles(3, { type: '單選' });

            const dry = await gen({ count: 6, dry_run: true });
            assert.equal(dry.status, 200, JSON.stringify(dry.body));
            assert.equal(dry.body.question_ids.length, 6);
            assert.ok(assertChainIntact(dry.body.question_ids, chain));
            assert.ok(!('shortfall' in dry.body) && !('note' in dry.body), '剛好湊滿時不帶附註鍵');
            assert.deepEqual(dry.body.question_ids.slice(0, 3).sort(), [...singles].sort(), '單選單題排在計算組首之前');
            const child = dry.body.questions.find(q => q.id === chain[1]);
            assert.equal(child.follows_question_id, chain[0], '逐題帶 follows_question_id 供前端標示');

            const real = await gen({ count: 6 });
            assert.equal(real.status, 200, JSON.stringify(real.body));
            assert.deepEqual(Object.keys(real.body).sort(),
                ['message', 'paper_id', 'paper_title', 'question_ids', 'questions'], '湊滿時回應頂層鍵不變');
            assert.ok(assertChainIntact(real.body.question_ids, chain));
            const { rows: [paper] } = await query('SELECT question_ids FROM exam_papers WHERE id = $1', [real.body.paper_id]);
            assert.deepEqual(paper.question_ids, real.body.question_ids, 'exam_papers 存的出題順序同回應');
        });

        test('隨機抽多次：抽到前題或任一承上題都整組帶上，從不出現孤兒承上題', async () => {
            await createStudent();
            const chainA = await addChain(2);
            const chainB = await addChain(1);
            await addSingles(10);
            let sawGroup = 0;
            for (let i = 0; i < 25; i++) {
                const res = await gen({ count: 5, dry_run: true });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                const ids = res.body.question_ids;
                assert.ok(ids.length <= 5);
                if (assertChainIntact(ids, chainA, `第 ${i} 次`)) sawGroup++;
                if (assertChainIntact(ids, chainB, `第 ${i} 次`)) sawGroup++;
                if (ids.length < 5) {
                    assert.deepEqual(res.body.shortfall, { requested: 5, actual: ids.length, reason: 'follow_up_group' });
                    assert.match(res.body.note, /承上題須與前題整組出題/);
                }
            }
            assert.ok(sawGroup > 0, '25 次預覽裡應該至少抽到一次承上組');
        });

        test('組內任一題不可用 → 整組不抽：已作答、exclude_ids、封存、章節不符、source_types 不符', async () => {
            const studentId = await createStudent();
            const singles = await addSingles(4);

            // ① 前題已作答（承上題沒寫過）
            const answered = await addChain(1);
            await insertAttempts(query, [{ student_id: studentId, question_id: answered[0] }]);
            // ② 承上題在排除清單（換這題）
            const excluded = await addChain(1);
            // ③ 承上題已封存
            const archived = await addChain(1);
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [archived[1]]);
            // ④ 前題被分到別的章節
            const otherChapter = await addChain(1);
            await query(`UPDATE questions SET chapter = '直線運動' WHERE id = $1`, [otherChapter[0]]);
            // ⑤ 承上題題源是出版社，本次只收自寫
            const publisher = await addChain(1);
            await query(`UPDATE questions SET source_type = 'self' WHERE subject = $1`, [SUBJECT]);
            await query(`UPDATE questions SET source_type = 'publisher' WHERE id = $1`, [publisher[1]]);

            const res = await gen({ count: 4, dry_run: true, exclude_ids: [excluded[1]], source_types: ['self'] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual([...res.body.question_ids].sort((a, b) => a - b), singles, '只剩下 4 題單題可抽');

            // 可用只有 4 題：要 5 題就是真的庫存不足（不是少出題），訊息逐字沿用
            const short = await gen({ count: 5, dry_run: true, exclude_ids: [excluded[1]], source_types: ['self'] });
            assert.equal(short.status, 400);
            assert.equal(short.body.message, `新題目庫存不足！該章節 [${STUDENT}] 沒寫過的題目僅剩 4 題。`);
        });

        test('剩 1 個名額但下一組有 2 題：預設少出題、200 附 shortfall／note，真出卷也照實際題數寫入', async () => {
            await createStudent();
            const chain1 = await addChain(1);
            const chain2 = await addChain(1);
            await addSingles(0);

            const dry = await gen({ count: 3, dry_run: true });
            assert.equal(dry.status, 200, JSON.stringify(dry.body));
            assert.equal(dry.body.question_ids.length, 2);
            assert.deepEqual(dry.body.shortfall, { requested: 3, actual: 2, reason: 'follow_up_group' });
            assert.equal(dry.body.note, '承上題須與前題整組出題，無法剛好湊滿 3 題，本卷實際 2 題。');
            assert.ok(assertChainIntact(dry.body.question_ids, chain1) !== assertChainIntact(dry.body.question_ids, chain2));

            const real = await gen({ count: 3 });
            assert.equal(real.status, 200, JSON.stringify(real.body));
            assert.equal(real.body.question_ids.length, 2);
            assert.equal(real.body.shortfall.actual, 2);
            const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM attempts');
            assert.equal(n, 2, 'attempts 只寫實際出的題數');
        });

        test('名額小於任何一組（要 1 題、只有 2 題一組）：回 400 而不是出空卷', async () => {
            await createStudent();
            await addChain(1);
            const res = await gen({ count: 1, dry_run: true });
            assert.equal(res.status, 400);
            assert.equal(res.body.message, '承上題須與前題整組出題，可用的題組每組至少 2 題，無法湊出 1 題，請調高題數。');
            const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM exam_papers');
            assert.equal(n, 0);
        });

        test('政策切到 error：同一情境回 400（owner 若改選「回 400」只需改 FOLLOW_UP_SHORTFALL_POLICY）', async () => {
            const studentId = await createStudent();
            assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'note', '預設政策是少出題並附註');
            await addChain(1);
            await addChain(1);
            const picked = await exam.selectPaperQuestions({
                studentId, studentName: STUDENT, subject: SUBJECT, chapter: CHAPTER, limitCount: 3, shortfallPolicy: 'error'
            });
            assert.deepEqual(picked.error, {
                status: 400, message: '承上題須與前題整組出題，無法剛好湊滿 3 題（最多可出 2 題），請調整題數。'
            });
        });

        test('confirm-paper：不論呼叫端給的順序，承上組依承接順序相鄰寫入', async () => {
            const studentId = await createStudent();
            const chain = [await addQ({ type: '證明', text: '自製前題（證明）。' })];
            chain.push(await addQ({ type: '單選', follows: chain[0], text: '承上題，自製單選。' }));
            const [single] = await addSingles(1, { type: '填空' });

            const res = await request(app).post('/api/confirm-paper')
                .send({ student_id: studentId, question_ids: [chain[1], single, chain[0]] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.question_ids, [single, chain[0], chain[1]]);
            assert.equal(res.body.questions[2].follows_question_id, chain[0]);
        });

        test('助教 preview_paper 走同一段選題：整組相鄰、少出題時附註與 shortfall，且不寫庫', async () => {
            await createStudent();
            const chain1 = await addChain(1);
            const chain2 = await addChain(1);

            const out = await TOOLS.preview_paper.run({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: 3 });
            assert.ok(!out.error, JSON.stringify(out));
            const ids = out.questions.map(q => q.id);
            assert.equal(ids.length, 2);
            assert.ok(assertChainIntact(ids, chain1) !== assertChainIntact(ids, chain2));
            assert.deepEqual(out.shortfall, { requested: 3, actual: 2, reason: 'follow_up_group' });
            assert.match(out.note, /僅預覽、尚未寫入/);
            assert.match(out.note, /本卷實際 2 題/);
            assert.equal(out.questions[1].follows_question_id, out.questions[0].id);

            const tooFew = await TOOLS.preview_paper.run({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: 1 });
            assert.match(tooFew.error, /承上題須與前題整組出題/);

            for (const table of ['exam_papers', 'attempts']) {
                const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
                assert.equal(n, 0, `${table} 應為空`);
            }
        });
    });
}
