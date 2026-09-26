// ─────────────────────────────────────────────────────────────
// paperGroups.pg.test.js — 組卷的承上題整組抽取（FR-019 PR2，ACPT-019-5）
//
// 防線與 controllers.pg.test.js 一致：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// require config/db 之前覆寫 DATABASE_URL。題幹全為自製內容。
// 涵蓋 POST /api/generate-paper（dry_run 與真出卷）、POST /api/confirm-paper 的排序與
// 伺服器端承上題整組檢查（〔Owner 決策單 2026-09-25 B7〕）、
// selectPaperQuestions 的少出題政策切換，以及助教工具 preview_paper 走同一段選題。
// 〔Owner 決策單 2026-09-25 B10〕承上題整組湊不滿時預設改成回 400（請老師改題數），
// 環境變數 FOLLOW_UP_SHORTFALL_POLICY=note 切回少出題附註；單章與 blueprint 兩條路徑都驗。
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

    /** 跨章配額（blueprint）：不能帶 chapter／count。 */
    function genBlueprint(body) {
        return request(app).post('/api/generate-paper')
            .send({ student_name: STUDENT, subject: SUBJECT, ...body });
    }

    /**
     * 〔Owner 決策單 2026-09-25 B10〕暫時設定環境變數 FOLLOW_UP_SHORTFALL_POLICY（undefined＝不設，看預設），跑完還原。
     * 政策在每次組卷時才讀環境變數，所以不必重新 require app。
     */
    async function withPolicy(value, fn) {
        const saved = process.env.FOLLOW_UP_SHORTFALL_POLICY;
        if (value === undefined) delete process.env.FOLLOW_UP_SHORTFALL_POLICY;
        else process.env.FOLLOW_UP_SHORTFALL_POLICY = value;
        try {
            return await fn();
        } finally {
            if (saved === undefined) delete process.env.FOLLOW_UP_SHORTFALL_POLICY;
            else process.env.FOLLOW_UP_SHORTFALL_POLICY = saved;
        }
    }

    async function countRows(table) {
        const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        return n;
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

        // 〔Owner 決策單 2026-09-25 B10〕這一則原本驗「預設」少出題附註；Owner 決策後預設改成回 400，
        // 少出題附註改由 FOLLOW_UP_SHORTFALL_POLICY=note 切回——斷言逐字不變，只是在 note 政策下跑
        test('FOLLOW_UP_SHORTFALL_POLICY=note：剩 1 個名額但下一組有 2 題 → 少出題、200 附 shortfall／note，真出卷也照實際題數寫入', async () => {
            await createStudent();
            const chain1 = await addChain(1);
            const chain2 = await addChain(1);
            await addSingles(0);

            await withPolicy('note', async () => {
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
        });

        test('〔Owner 決策單 2026-09-25 B10〕預設（未設環境變數）：同一情境回 400，說出哪一章要幾題、最多湊到幾題、改成幾題；dry_run 與真出卷都不寫庫', async () => {
            await createStudent();
            await addChain(1);
            await addChain(1);

            await withPolicy(undefined, async () => {
                for (const body of [{ count: 3, dry_run: true }, { count: 3 }]) {
                    const res = await gen(body);
                    assert.equal(res.status, 400, JSON.stringify(res.body));
                    assert.deepEqual(res.body, {
                        message: '承上題須與前題整組出題，「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題或 4 題。'
                    });
                    assert.ok(!res.body.message.includes(STUDENT), '訊息不帶學生姓名');
                }
                assert.equal(await countRows('exam_papers'), 0);
                assert.equal(await countRows('attempts'), 0);

                // 照建議改題數就出得來，而且剛好湊滿（不帶附註鍵）
                for (const count of [2, 4]) {
                    const ok = await gen({ count, dry_run: true });
                    assert.equal(ok.status, 200, JSON.stringify(ok.body));
                    assert.equal(ok.body.question_ids.length, count);
                    assert.ok(!('shortfall' in ok.body) && !('note' in ok.body));
                }
            });
        });

        test('〔Owner 決策單 2026-09-25 B10〕建議題數是離原題數最近、剛好湊得滿的上下兩個（組大小 3＋2 要 4 → 3 或 5）', async () => {
            await createStudent();
            await addChain(2);
            await addChain(1);
            await withPolicy('error', async () => {
                const res = await gen({ count: 4, dry_run: true });
                assert.equal(res.status, 400, JSON.stringify(res.body));
                assert.equal(res.body.message,
                    '承上題須與前題整組出題，「向量內積」要 4 題無法剛好湊滿（4 題以內最多只能湊到 3 題），請把題數改成 3 題或 5 題。');
            });
        });

        test('〔Owner 決策單 2026-09-25 B10〕環境變數是非法值 → 退回 error（400），伺服器只警告一次', async () => {
            await createStudent();
            await addChain(1);
            await addChain(1);
            exam._resetShortfallPolicyWarningForTest();
            const original = console.warn;
            const warns = [];
            console.warn = (...args) => { warns.push(args.join(' ')); };
            try {
                await withPolicy('少出題', async () => {
                    for (let i = 0; i < 2; i++) {
                        const res = await gen({ count: 3, dry_run: true });
                        assert.equal(res.status, 400, JSON.stringify(res.body));
                        assert.match(res.body.message, /請把題數改成 2 題或 4 題。$/);
                    }
                });
            } finally {
                console.warn = original;
                exam._resetShortfallPolicyWarningForTest();
            }
            const policyWarns = warns.filter(w => w.includes('FOLLOW_UP_SHORTFALL_POLICY'));
            assert.equal(policyWarns.length, 1, JSON.stringify(warns));
            assert.match(policyWarns[0], /收到「少出題」，改用 error/);
            assert.ok(!policyWarns[0].includes(STUDENT), 'log 不帶學生姓名');
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

        test('政策切到 error：同一情境回 400（shortfallPolicy 參數明帶時覆寫環境變數）', async () => {
            const studentId = await createStudent();
            await withPolicy(undefined, async () => {
                // 〔Owner 決策單 2026-09-25 B10〕Owner 選「直接報錯，請老師改題數」：預設從 'note' 改成 'error'
                assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'error', '預設政策是直接報錯〔Owner 決策單 2026-09-25 B10〕');
            });
            await addChain(1);
            await addChain(1);
            const opts = { studentId, studentName: STUDENT, subject: SUBJECT, chapter: CHAPTER, limitCount: 3 };
            // 〔Owner 決策單 2026-09-25 B10〕訊息改成具體說出哪一章要幾題、最多湊到幾題、改成幾題
            const expected = {
                status: 400, message: '承上題須與前題整組出題，「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題或 4 題。'
            };
            await withPolicy('note', async () => {
                const picked = await exam.selectPaperQuestions({ ...opts, shortfallPolicy: 'error' });
                assert.deepEqual(picked.error, expected, '明帶 error 時不看環境變數');
            });
            await withPolicy(undefined, async () => {
                assert.deepEqual((await exam.selectPaperQuestions(opts)).error, expected, '不帶參數＝環境變數的預設 error');
                const noted = await exam.selectPaperQuestions({ ...opts, shortfallPolicy: 'note' });
                assert.ok(!noted.error, '明帶 note 時不看環境變數');
                assert.deepEqual(noted.shortfall, { requested: 3, actual: 2, reason: 'follow_up_group' });
            });
        });

        test('〔Owner 決策單 2026-09-25 B10〕blueprint 預設：承上組不足的列 → 400，逐列說出要幾題、最多湊到幾題、改成幾題；切回 note 照舊 200 附 note', async () => {
            await createStudent();
            await addChain(1);
            await addChain(1);
            await addSingles(2, { chapter: '排列' });
            const body = { dry_run: true, blueprint: [{ chapter: '排列', count: 2 }, { chapter: CHAPTER, count: 3 }] };
            const report = [
                { chapter: '排列', difficulty_min: null, difficulty_max: null, wanted: 2, got: 2 },
                { chapter: CHAPTER, difficulty_min: null, difficulty_max: null, wanted: 3, got: 2 }
            ];
            const shortfalls = [{ row: 2, chapter: CHAPTER, difficulty_min: null, difficulty_max: null, wanted: 3, got: 2, reason: 'follow_up_group' }];

            await withPolicy(undefined, async () => {
                for (const b of [body, { ...body, dry_run: false }]) {
                    const res = await genBlueprint(b);
                    assert.equal(res.status, 400, JSON.stringify(res.body));
                    assert.deepEqual(res.body, {
                        message: '承上題須與前題整組出題，blueprint 第 2 列「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題或 4 題。',
                        blueprint: report,
                        shortfalls
                    });
                }
                assert.equal(await countRows('exam_papers'), 0);
                assert.equal(await countRows('attempts'), 0);
            });

            await withPolicy('note', async () => {
                const res = await genBlueprint(body);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.question_ids.length, 4);
                assert.deepEqual(res.body.blueprint, report);
                assert.deepEqual(res.body.shortfalls, shortfalls);
                assert.equal(res.body.note,
                    '跨章配額有 1 列不足量：第 2 列「向量內積」要 3 題只抽到 2 題（承上題須整組出題）。本卷實際 4 題（要求 5 題）。');
            });
        });

        test('〔Owner 決策單 2026-09-25 B10〕blueprint：往上的建議不讓整張卷超過 50 題；每列都抽不到但原因是承上組塞不進時，說改幾題而不是「庫存不足」', async () => {
            await createStudent();
            await addChain(1);
            await addChain(1);
            await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 SELECT $1, '排列', '計算', 3, '自製排列單題 ' || g || '：求 $x$。', '測試答案' FROM generate_series(1, 47) g`,
                [SUBJECT]
            );

            await withPolicy(undefined, async () => {
                // 其他列合計 47 題：這一列往上改成 4 題會超過 50 題 → 只建議 2 題
                const capped = await genBlueprint({ dry_run: true, blueprint: [{ chapter: CHAPTER, count: 3 }, { chapter: '排列', count: 47 }] });
                assert.equal(capped.status, 400, JSON.stringify(capped.body));
                assert.equal(capped.body.message,
                    '承上題須與前題整組出題，blueprint 第 1 列「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題。');

                const none = await genBlueprint({ dry_run: true, blueprint: [{ chapter: CHAPTER, count: 1 }] });
                assert.equal(none.status, 400, JSON.stringify(none.body));
                assert.equal(none.body.message,
                    '承上題須與前題整組出題，blueprint 第 1 列「向量內積」要 1 題無法剛好湊滿（可用的題組每組至少 2 題，一題都湊不出來），請把題數改成 2 題。');
                assert.deepEqual(none.body.shortfalls.map(s => [s.row, s.got, s.reason]), [[1, 0, 'follow_up_group']]);
            });

            await withPolicy('note', async () => {
                // 決策前的行為：每一列都抽不到 → 400「庫存不足」
                const none = await genBlueprint({ dry_run: true, blueprint: [{ chapter: CHAPTER, count: 1 }] });
                assert.equal(none.status, 400, JSON.stringify(none.body));
                assert.match(none.body.message, /^新題目庫存不足！blueprint 每一列都抽不到/);
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

        // ── 〔Owner 決策單 2026-09-25 B7〕confirm-paper 伺服器端也檢查承上題是否整組（裁決 S5-28 原本只靠前端） ──

        const confirm = (studentId, questionIds) => request(app).post('/api/confirm-paper')
            .send({ student_id: studentId, question_ids: questionIds });
        const countRows = async (table) => (await query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
        const CONFIRM_KEYS = ['message', 'paper_id', 'paper_title', 'question_ids', 'questions'];

        test('confirm-paper 整組檢查：預覽→確認的正常流程整組都在，照常 200（鏈＋分岔＋單題）', async () => {
            await createStudent();
            const chain = await addChain(2);                                   // 前題 ← 承上 ← 承上
            const fork = [await addQ({ text: '自製分岔前題：設 $y=3$。' })];
            fork.push(await addQ({ follows: fork[0], text: '承上題，自製分岔甲。' }));
            fork.push(await addQ({ follows: fork[0], text: '承上題，自製分岔乙。' }));
            await addSingles(2);

            const dry = await gen({ count: 8, dry_run: true });
            assert.equal(dry.status, 200, JSON.stringify(dry.body));
            assert.equal(dry.body.question_ids.length, 8);

            const ok = await confirm(dry.body.student_id, dry.body.question_ids);
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            assert.deepEqual(Object.keys(ok.body).sort(), CONFIRM_KEYS, '回應形狀不變（不多 incomplete_groups）');
            assert.deepEqual(ok.body.question_ids, dry.body.question_ids, '確認後的出題順序同預覽');
            assert.ok(assertChainIntact(ok.body.question_ids, chain));
            assert.ok(assertChainIntact(ok.body.question_ids, fork), '分岔組依承接順序（同一前題的承上題依 id）相鄰');
            assert.equal(await countRows('attempts'), 8);
        });

        test('confirm-paper 整組檢查：缺一題（缺鏈尾、缺前題）→ 400 列出哪一組缺哪幾題，不寫卷、不寫 attempts、不含學生姓名', async () => {
            const studentId = await createStudent();
            const chain = await addChain(2);
            const [single] = await addSingles(1);
            const groupLabel = `承上題組（#${chain[0]}、#${chain[1]}、#${chain[2]}）`;

            const noTail = await confirm(studentId, [chain[0], chain[1], single]);
            assert.equal(noTail.status, 400, JSON.stringify(noTail.body));
            assert.equal(noTail.body.message,
                `承上題必須與前題整組出卷，以下題組不完整：${groupLabel}缺 #${chain[2]}。請把缺的題加回卷裡，或把整組刪掉後再確認。`);
            assert.deepEqual(noTail.body.incomplete_groups,
                [{ group_ids: chain, missing: [{ question_id: chain[2], reason: 'not_in_paper' }] }]);
            assert.ok(!noTail.body.message.includes(STUDENT), '訊息不得含學生姓名');

            // 孤兒承上題（前題不在卷裡）：前端 orphanFollowUps 擋的那一種，伺服器現在也擋
            const orphan = await confirm(studentId, [chain[2], chain[1]]);
            assert.equal(orphan.status, 400, JSON.stringify(orphan.body));
            assert.equal(orphan.body.message,
                `承上題必須與前題整組出卷，以下題組不完整：${groupLabel}缺 #${chain[0]}。請把缺的題加回卷裡，或把整組刪掉後再確認。`);

            assert.equal(await countRows('exam_papers'), 0, '400 不得留下半張卷');
            assert.equal(await countRows('attempts'), 0, '400 不得燒題');

            // 補齊之後同一批題照常出卷
            const fixed = await confirm(studentId, [chain[0], chain[1], single, chain[2]]);
            assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
            assert.ok(assertChainIntact(fixed.body.question_ids, chain));
        });

        test('confirm-paper 整組檢查：分岔組只放一個承上題、多組同時不完整 → 逐組列出（依組首 id）', async () => {
            const studentId = await createStudent();
            const chain = await addChain(1);
            const fork = [await addQ({ text: '自製分岔前題：設 $z=5$。' })];
            fork.push(await addQ({ follows: fork[0], text: '承上題，自製分岔甲。' }));
            fork.push(await addQ({ follows: fork[0], text: '承上題，自製分岔乙。' }));

            const res = await confirm(studentId, [fork[2], fork[0], chain[1]]);
            assert.equal(res.status, 400, JSON.stringify(res.body));
            assert.deepEqual(res.body.incomplete_groups, [
                { group_ids: chain, missing: [{ question_id: chain[0], reason: 'not_in_paper' }] },
                { group_ids: fork, missing: [{ question_id: fork[1], reason: 'not_in_paper' }] }
            ]);
            assert.equal(res.body.message, '承上題必須與前題整組出卷，以下題組不完整：'
                + `承上題組（#${chain[0]}、#${chain[1]}）缺 #${chain[0]}；`
                + `承上題組（#${fork[0]}、#${fork[1]}、#${fork[2]}）缺 #${fork[1]}。`
                + '請把缺的題加回卷裡，或把整組刪掉後再確認。');
            assert.equal(await countRows('exam_papers'), 0);
        });

        test('confirm-paper 整組檢查：組內有題已封存或該生已寫過 → 比照前端整組不能出，400 標原因', async () => {
            const studentId = await createStudent();
            // ① 承上題已封存：前題單獨確認也不行（前端 planManualAdd：組內有封存的題就不加）
            const archivedChain = await addChain(1);
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [archivedChain[1]]);
            // ② 前題該生已寫過：承上題單獨確認也不行（pickPaperUnits：前題已作答整組不抽）
            const answeredChain = await addChain(1);
            await insertAttempts(query, [{ student_id: studentId, question_id: answeredChain[0] }]);

            const res = await confirm(studentId, [archivedChain[0], answeredChain[1]]);
            assert.equal(res.status, 400, JSON.stringify(res.body));
            assert.deepEqual(res.body.incomplete_groups, [
                { group_ids: archivedChain, missing: [{ question_id: archivedChain[1], reason: 'archived' }] },
                { group_ids: answeredChain, missing: [{ question_id: answeredChain[0], reason: 'answered' }] }
            ]);
            assert.equal(res.body.message, '承上題必須與前題整組出卷，以下題組不完整：'
                + `承上題組（#${archivedChain[0]}、#${archivedChain[1]}）缺 #${archivedChain[1]}（已封存）；`
                + `承上題組（#${answeredChain[0]}、#${answeredChain[1]}）缺 #${answeredChain[0]}（該生已寫過）。`
                + '請把缺的題加回卷裡，或把整組刪掉後再確認；已封存或該生已寫過的題不能出，含這種題的組只能整組刪。');
            assert.ok(!res.body.message.includes(STUDENT), '訊息不得含學生姓名');
            assert.equal(await countRows('attempts'), 1, '只有事先寫入的那一筆');

            // 卷內本身有封存題：沿用既有訊息（封存檢查在整組檢查之前，逐字不變）
            const inPaper = await confirm(studentId, [archivedChain[0], archivedChain[1]]);
            assert.equal(inPaper.status, 400);
            assert.equal(inPaper.body.message, '部分題目已不存在或已封存，請重新預覽。');
        });

        test('confirm-paper 整組檢查：順序被拆開不擋——伺服器一律重排成相鄰且依承接順序', async () => {
            // 〔Owner 決策單 2026-09-25 B7〕規則是「整組都在卷裡」；出題順序由伺服器的 sortForPaper 決定，
            // 呼叫端給的順序本來就不影響結果（上面「不論呼叫端給的順序」那一題、補救卷草稿送的是草稿順序），
            // 所以整組都在但被拆開、倒序的 payload 照常 200，寫進 exam_papers 的是排好的順序。
            const studentId = await createStudent();
            const chain = [await addQ({ type: '計算', text: '自製前題（計算）：設 $w=4$。' })];
            chain.push(await addQ({ type: '單選', follows: chain[0], text: '承上題，自製單選小題。' }));
            chain.push(await addQ({ type: '證明', follows: chain[1], text: '承上一題，自製證明小題。' }));
            const [s1, s2] = await addSingles(2, { type: '填空' });

            const res = await confirm(studentId, [chain[2], s1, chain[0], s2, chain[1]]);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.question_ids.slice(0, 2).sort((a, b) => a - b), [s1, s2], '填空單題排在計算組首之前');
            assert.deepEqual(res.body.question_ids.slice(2), chain, '整組相鄰、依承接順序，題型權重不拆組');
            const { rows: [paper] } = await query('SELECT question_ids FROM exam_papers WHERE id = $1', [res.body.paper_id]);
            assert.deepEqual(paper.question_ids, res.body.question_ids);
        });

        test('confirm-paper 整組檢查：沒有承上題的卷不受影響（含題幹寫「承上題」但沒有綁定的舊題）', async () => {
            const studentId = await createStudent();
            const singles = await addSingles(3);
            // 缺前題的舊題：follows_question_id 為 NULL，自成一組（同 pickPaperUnits），伺服器不從題幹猜前題
            const legacy = await addQ({ text: '承上題，自製未綁定的舊題。' });

            const res = await confirm(studentId, [...singles, legacy]);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body).sort(), CONFIRM_KEYS);
            assert.deepEqual([...res.body.question_ids].sort((a, b) => a - b), [...singles, legacy]);
            assert.equal(await countRows('attempts'), 4);
        });

        test('助教 preview_paper 走同一段選題：整組相鄰、少出題時附註與 shortfall，且不寫庫', async () => {
            await createStudent();
            const chain1 = await addChain(1);
            const chain2 = await addChain(1);

            // 〔Owner 決策單 2026-09-25 B10〕少出題附註改在 FOLLOW_UP_SHORTFALL_POLICY=note 下驗（斷言逐字不變）
            await withPolicy('note', async () => {
                const out = await TOOLS.preview_paper.run({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.ok(!out.error, JSON.stringify(out));
                const ids = out.questions.map(q => q.id);
                assert.equal(ids.length, 2);
                assert.ok(assertChainIntact(ids, chain1) !== assertChainIntact(ids, chain2));
                assert.deepEqual(out.shortfall, { requested: 3, actual: 2, reason: 'follow_up_group' });
                assert.match(out.note, /僅預覽、尚未寫入/);
                assert.match(out.note, /本卷實際 2 題/);
                assert.equal(out.questions[1].follows_question_id, out.questions[0].id);
            });

            // 〔Owner 決策單 2026-09-25 B10〕預設：助教試算與組卷同一個政策，回錯誤訊息（含建議題數）
            await withPolicy(undefined, async () => {
                const out = await TOOLS.preview_paper.run({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: 3 });
                assert.deepEqual(out, {
                    error: '承上題須與前題整組出題，「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題或 4 題。'
                });
            });

            const tooFew = await TOOLS.preview_paper.run({ student_name: STUDENT, subject: SUBJECT, chapter: CHAPTER, count: 1 });
            assert.match(tooFew.error, /承上題須與前題整組出題/);

            for (const table of ['exam_papers', 'attempts']) {
                const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
                assert.equal(n, 0, `${table} 應為空`);
            }
        });
    });
}
