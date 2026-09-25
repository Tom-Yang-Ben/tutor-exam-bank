// ─────────────────────────────────────────────────────────────
// test/integration/retrainPaper.pg.test.js — 錯題重練第二階段之二 PR-3（出卷整合）的整合測試
//
// docs/retrain-and-review.md 第 4.7、5.2（API-5～8、API-12）、5.3 節；第 6.3 節：
//   TC-039-3  草稿不寫庫；混合卷確認後派題用途與關卡正確；純重練卷卷名；補救卷 retrain 組；
//             兩個確認同時送出後者 409；刪重練卷後重算（經 API 出的重練卷）
//   TC-039-4  （整合層）download-word：沒帶 paper_id 逐位元不變、帶了依 R7 標示
//   ACPT-039-1～5、ACPT-038-3（兩個確認同時送出）、風險 R-9（重練卷只放承上題 → 400）、R10（補救卷只看第一次作答）
//
// PR-2（retrain.pg.test.js）已經驗過排程本身與刪卷／刪學生／合併；這裡只驗出卷整合，另開一個檔案
// （PR-4 會在 retrain.pg.test.js 加 API-13，分開寫減少合併衝突）。
// 日期一律用本地時區的「今天」（與 writePaper 的派題日同一種算法）；PostgreSQL 的 CURRENT_DATE 在 UTC，夾具不依賴它。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('錯題重練出卷整合（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
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

    /** 依旗標載入一份 app（路由在載入當下決定掛不掛）。擴充的既有端點每次請求即時讀旗標，見 withRetrain。 */
    function loadApp(retrainOn) {
        const keys = ['FEATURE_STUDENTS', 'FEATURE_REMEDIAL', 'FEATURE_RETRAIN'];
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        process.env.FEATURE_STUDENTS = 'true';
        process.env.FEATURE_REMEDIAL = 'true';
        if (retrainOn) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        const app = require(APP_PATH);
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        return app;
    }
    const appOff = loadApp(false);
    const appOn = loadApp(true);

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const retrain = require(path.join(APP_DIR, 'services', 'retrainService'));
    const retrainSelect = require(path.join(APP_DIR, 'services', 'retrainSelect'));
    const schedule = require(path.join(APP_DIR, 'services', 'retrainSchedule'));
    const { loadRetrainConfig } = require(path.join(APP_DIR, 'config', 'retrain'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));

    const today = retrain.todayLocal();
    const day = n => schedule.addDays(today, n);
    const d = new Date();
    const titleDate = `${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`;
    const CONFLICT = qid => `題目 ${qid} 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`;
    const DISABLED = { message: 'retrain 需要開啟 FEATURE_RETRAIN。' };

    /** 旗標狀態（擴充的既有端點每次請求即時讀 process.env.FEATURE_RETRAIN）。 */
    async function withRetrain(on, fn) {
        const saved = process.env.FEATURE_RETRAIN;
        if (on) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        try { return await fn(on ? appOn : appOff); } finally {
            if (saved === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = saved;
        }
    }

    // ─────────── 夾具 ───────────

    let seq = 0;
    async function seedQuestions(n, { subject = '數學', chapter = '向量內積', type = '計算', difficulty = 3, variantOf = null } = {}) {
        const out = [];
        for (let i = 0; i < n; i++) {
            seq += 1;
            const { rows: [q] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, variant_of)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [subject, chapter, type, difficulty, `出卷整合測試題 ${seq}：求 $x^${seq}$。`, `答 ${seq}`, variantOf]);
            out.push(q.id);
        }
        return out;
    }

    /** 一組承上題：ids[0] 是前題，其後每一題承接前一題。 */
    async function seedGroup(n, opts) {
        const ids = await seedQuestions(n, opts);
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

    /**
     * 一張「以前的」新題卷（派題日可以在過去），全部批改成錯，再在批改卡勾「要重練」（預設全勾）：
     * 項目的起算日＝那一筆派題日，第 1 關到期日＝起算日＋1 天（逾期天數可以控制）。
     * 承上組只勾一題時，同組其他題（也在這張卷上）以 group 一起進清單。
     */
    async function flaggedPaper(studentId, qids, assignedAt, { flag = qids } = {}) {
        const { rows: [p] } = await query(
            'INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
            ['以前的卷', studentId, qids]);
        await insertAttempts(query, qids.map(q => ({ student_id: studentId, question_id: q, paper_id: p.id, assigned_at: assignedAt })));
        const res = await patch(p.id, qids.map(q => ({ question_id: q, result: 0, ...(flag.includes(q) ? { retrain: true } : {}) })));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return p.id;
    }

    const patch = (paperId, results, app = appOn) => request(app).patch(`/api/papers/${paperId}/results`).send({ results });
    const confirm = (body, app = appOn) => request(app).post('/api/confirm-paper').send(body);
    const generate = (body, app = appOn) => request(app).post('/api/generate-paper').send(body);
    const retrainPaper = (studentId, body = {}, app = appOn) => request(app).post(`/api/students/${studentId}/retrain-paper`).send(body);
    const remedialPaper = (studentId, body, app = appOn) => request(app).post(`/api/students/${studentId}/remedial-paper`).send(body);

    async function wordXml(body, app = appOn) {
        const res = await request(app).post('/api/download-word').send(body).buffer(true)
            .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        assert.equal(res.status, 200, String(res.body));
        return documentXml(res.body);
    }

    /** 資料庫裡的寫入量（草稿不寫庫的檢查）。 */
    async function footprint() {
        const { rows: [c] } = await query(
            `SELECT (SELECT COUNT(*) FROM exam_papers)::int AS papers, (SELECT COUNT(*) FROM assignments)::int AS assignments,
                    (SELECT COUNT(*) FROM attempt_records)::int AS records,
                    (SELECT md5(COALESCE(string_agg(i::text, '|' ORDER BY i.id), '')) FROM retrain_items i) AS items`);
        return c;
    }

    async function assignmentsOf(paperId) {
        const { rows } = await query(
            `SELECT question_id, purpose, retrain_item_id, retrain_step, to_char(assigned_at, 'YYYY-MM-DD') AS assigned_at
               FROM assignments WHERE paper_id = $1 ORDER BY question_id`, [paperId]);
        return rows.map(r => ({ ...r, retrain_item_id: r.retrain_item_id === null ? null : Number(r.retrain_item_id) }));
    }

    async function itemOf(studentId, questionId) {
        const { rows } = await query(
            `SELECT id, status, step, to_char(due_on, 'YYYY-MM-DD') AS due_on, streak, lapses
               FROM retrain_items WHERE student_id = $1 AND question_id = $2`, [studentId, questionId]);
        return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    }

    const GENERATE_KEYS = ['dry_run', 'message', 'student_id', 'paper_title_preview', 'question_ids', 'questions'];
    const QUESTION_KEYS = ['id', 'question_text', 'question_type', 'difficulty', 'answer_text', 'source_type', 'source_detail', 'follows_question_id'];

    describe('錯題重練出卷整合（PR-3）', () => {
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

        // ───────────────────── 旗標關閉（ACPT-039-4、第 5.1 節）─────────────────────

        test('旗標關閉：API-5 不掛載；帶 retrain／retrain_question_ids／retrain_count → 400 不寫；paper_id 照舊忽略；既有回應逐字不變', async () => {
            const [a, b, c, n1, n2] = await seedQuestions(5);
            const s = await createStudent('旗標關閉生');
            await flaggedPaper(s, [a, b], day(-5));
            const before0 = await footprint();

            await withRetrain(false, async app => {
                const r5 = await retrainPaper(s, {}, app);
                assert.equal(r5.status, 404);
                assert.match(r5.text, /Cannot POST/, 'Express 預設 404（路由沒有掛載）');

                for (const retrainParam of [{ count: 1 }, { count: 0 }, {}]) {
                    const g = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true, retrain: retrainParam }, app);
                    assert.deepEqual([g.status, g.body], [400, DISABLED], JSON.stringify(retrainParam));
                }
                const cf = await confirm({ student_id: s, question_ids: [n1], retrain_question_ids: [] }, app);
                assert.deepEqual([cf.status, cf.body], [400, DISABLED]);
                const rm = await remedialPaper(s, { subject: '數學', retrain_count: 0 }, app);
                assert.deepEqual([rm.status, rm.body], [400, DISABLED]);
                assert.deepEqual(await footprint(), before0, '400 時什麼都沒寫');

                // 沒帶新參數：回應的鍵與 PR-3 之前相同（null 等於沒帶）
                const g = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 2, dry_run: true, retrain: null }, app);
                assert.equal(g.status, 200, JSON.stringify(g.body));
                assert.deepEqual(Object.keys(g.body), GENERATE_KEYS);
                assert.deepEqual(Object.keys(g.body.questions[0]), QUESTION_KEYS);
                assert.ok(g.body.question_ids.every(id => [c, n1, n2].includes(id)), '只有新題（重練題不會被附上）');
                const ok = await confirm({ student_id: s, question_ids: [n1], retrain_question_ids: null }, app);
                assert.equal(ok.status, 200, JSON.stringify(ok.body));
                assert.deepEqual(Object.keys(ok.body), ['message', 'paper_id', 'paper_title', 'question_ids', 'questions']);
                const papers = await request(app).get(`/api/students/${s}/papers`);
                assert.ok(papers.body.items.every(p => !('retrain_count' in p)), '旗標關閉時試卷列表沒有 retrain_count');
            });
        });

        // ───────────────────── API-6 generate-paper 附帶重練題 ─────────────────────

        test('API-6 單章 dry_run：新題題數不變、重練題另外加；每題多 purpose／retrain_step；依第 4.7 節排序、上限；草稿不寫庫', async () => {
            const olds = await seedQuestions(4);                 // 以前錯過的題（同章）
            const fresh = await seedQuestions(3);                // 還沒寫過的新題
            const s = await createStudent('附帶生');
            await flaggedPaper(s, [olds[0]], day(-10));          // 到期日 day(-9)：逾期 9 天
            await flaggedPaper(s, [olds[1]], day(-3));           // 逾期 2 天
            await flaggedPaper(s, [olds[2]], day(-6));           // 逾期 5 天
            await flaggedPaper(s, [olds[3]], today);             // 明天才到期
            const before0 = await footprint();

            const res = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true, retrain: { count: 2 } });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body), [...GENERATE_KEYS, 'retrain']);
            assert.deepEqual(res.body.retrain, { wanted: 2, got: 2, due_total: 3 });
            const byId = new Map(res.body.questions.map(q => [q.id, q]));
            assert.deepEqual(res.body.question_ids, res.body.questions.map(q => q.id));
            assert.equal(res.body.question_ids.length, 5, '新題 3 題＋重練 2 題');
            assert.deepEqual(fresh.map(id => [byId.get(id).purpose, byId.get(id).retrain_step]), fresh.map(() => ['new', null]));
            // 逾期多的先：olds[0]（9 天）、olds[2]（5 天）；olds[1] 放不下（上限 2）、olds[3] 還沒到期
            assert.deepEqual([olds[0], olds[2]].map(id => [byId.get(id).purpose, byId.get(id).retrain_step]), [['retrain', 1], ['retrain', 1]]);
            assert.ok(!byId.has(olds[1]) && !byId.has(olds[3]));
            assert.deepEqual(Object.keys(byId.get(olds[0])), [...QUESTION_KEYS, 'purpose', 'retrain_step']);
            assert.deepEqual(await footprint(), before0, 'dry_run 一個位元組都沒寫');

            // as_of 指定預計作答日：明天的話 olds[3] 也到期
            const later = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true, retrain: { count: 10, as_of: day(1) } });
            assert.deepEqual(later.body.retrain, { wanted: 10, got: 4, due_total: 4 });
            // count 0：不附，但回應照樣帶 retrain（有帶才多）
            const zero = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true, retrain: { count: 0 } });
            assert.deepEqual(zero.body.retrain, { wanted: 0, got: 0, due_total: 3 });
            assert.ok(zero.body.questions.every(q => q.purpose === 'new'));
            // 別科的重練題不會被附上
            const phys = await seedQuestions(1, { subject: '物理', chapter: '靜電學' });
            await flaggedPaper(s, phys, day(-20));
            const again = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true, retrain: { count: 5 } });
            assert.ok(!again.body.question_ids.includes(phys[0]), '物理的重練題不附在數學卷');
        });

        test('API-6 參數：合計超過 50、格式錯誤、不認得的鍵 → 400（排在既有參數檢查之後）', async () => {
            await seedQuestions(2);
            const s = await createStudent('參數生');
            const base = { student_id: s, subject: '數學', chapter: '向量內積', count: 45, dry_run: true };
            const cases = [
                [{ count: 6 }, '新題加重練題最多 50 題（新題 45 題＋重練 6 題）。'],
                [{ count: -1 }, 'retrain.count 必須是 0~50 的整數。'],
                [{ count: '3' }, 'retrain.count 必須是 0~50 的整數。'],
                [{ count: 1, as_of: '2026/10/01' }, 'retrain.as_of 必須是 YYYY-MM-DD 格式的日期。'],
                [{ count: 1, subject: '數學' }, 'retrain 不接受的欄位：subject（可用的欄位：count、as_of）。'],
                [[1], 'retrain 必須是物件：{ count, as_of? }。']
            ];
            for (const [retrainParam, message] of cases) {
                const res = await generate({ ...base, retrain: retrainParam });
                assert.deepEqual([res.status, res.body], [400, { message }], JSON.stringify(retrainParam));
            }
            // 既有檢查先跑
            const bad = await generate({ ...base, count: 0, retrain: { count: 99 } });
            assert.deepEqual(bad.body, { message: '抽題數量必須為大於 0 的整數！' });
        });

        test('API-6 R12：到期的承上組整組放不下 → 400、不產生草稿，訊息列出那一組並提示可改成的題數', async () => {
            const single = await seedQuestions(1);
            const group = await seedGroup(3);
            await seedQuestions(2);                              // 新題
            const s = await createStudent('承上組生');
            await flaggedPaper(s, single, day(-10));             // 逾期 9 天，排第一
            await flaggedPaper(s, group, day(-5), { flag: [group[1]] });   // 勾一題，整組（group）一起進清單
            const before0 = await footprint();

            const res = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true, retrain: { count: 2 } });
            assert.equal(res.status, 400);
            assert.deepEqual(res.body, {
                message: `到期的承上題組（題 ${group.join('、')}）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 1 或 4。`
            });
            assert.deepEqual(await footprint(), before0);
            // 改成建議的題數就出得來；承上組整組出、相鄰、依承接順序
            const ok = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true, retrain: { count: 4 } });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            const ids = ok.body.question_ids;
            const at = group.map(id => ids.indexOf(id));
            assert.ok(at.every(i => i >= 0) && at[1] === at[0] + 1 && at[2] === at[1] + 1, `承上組要相鄰：${ids}`);
            // 剛好放滿時不報錯（沒挑到的留在清單）
            const exact = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true, retrain: { count: 1 } });
            assert.equal(exact.status, 200);
            assert.deepEqual(exact.body.retrain, { wanted: 1, got: 1, due_total: 4 });
            // exclude_ids 也排除重練題（整組）：組卷預覽上「移除這題」
            const ex = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true,
                exclude_ids: [single[0]], retrain: { count: 3 } });
            assert.equal(ex.status, 200, JSON.stringify(ex.body));
            assert.ok(!ex.body.question_ids.includes(single[0]));
            assert.deepEqual(ex.body.retrain, { wanted: 3, got: 3, due_total: 4 });
            const ex2 = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true,
                exclude_ids: [group[2]], retrain: { count: 3 } });
            assert.deepEqual(ex2.body.retrain, { wanted: 3, got: 1, due_total: 4 }, '移除承上組的任一題＝整組不出');
        });

        test('API-6 R8：重練題不佔變式家族名額，同家族的一題新變式可以同卷', async () => {
            const [orig] = await seedQuestions(1);
            const [variant] = await seedQuestions(1, { variantOf: orig });
            const s = await createStudent('家族生');
            await flaggedPaper(s, [orig], day(-3));
            const res = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 1, dry_run: true, retrain: { count: 1 } });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.questions.map(q => [q.id, q.purpose]).sort((x, y) => x[0] - y[0]), [[orig, 'retrain'], [variant, 'new']]);
        });

        test('API-6 blueprint：同樣接受 retrain；不足量附註只算新題；非 dry_run 直接寫入重練派題', async () => {
            const olds = await seedQuestions(2);
            await seedQuestions(3);
            const s = await createStudent('跨章生');
            await flaggedPaper(s, olds, day(-4));
            const body = { student_id: s, subject: '數學', blueprint: [{ chapter: '向量內積', count: 4 }], retrain: { count: 2 } };
            const dry = await generate({ ...body, dry_run: true });
            assert.equal(dry.status, 200, JSON.stringify(dry.body));
            assert.deepEqual(dry.body.retrain, { wanted: 2, got: 2, due_total: 2 });
            assert.match(dry.body.note, /本卷實際 3 題（要求 4 題）/, '附註只算新題');
            assert.deepEqual(Object.keys(dry.body).slice(-4), ['blueprint', 'shortfalls', 'note', 'retrain']);

            const res = await generate({ ...body, dry_run: false });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const rows = await assignmentsOf(res.body.paper_id);
            const byQ = new Map(rows.map(r => [r.question_id, r]));
            for (const q of olds) {
                const it = await itemOf(s, q);
                assert.deepEqual([byQ.get(q).purpose, byQ.get(q).retrain_item_id, byQ.get(q).retrain_step, byQ.get(q).assigned_at],
                    ['retrain', it.id, 1, today]);
            }
            assert.equal(rows.filter(r => r.purpose === 'new').length, 3);
            // 已派出：不再到期，下一份草稿不會再出現
            const next = await retrainPaper(s);
            assert.deepEqual([next.status, next.body.items, next.body.due_total], [200, [], 0]);
        });

        // ───────────────────── API-7 confirm-paper ─────────────────────

        test('API-7 混合卷：重練題寫成重練派題（項目＋當下關卡）、新題照舊；回應多 retrain_question_ids；卷名照舊', async () => {
            const [a, b] = await seedQuestions(2);
            const [n1, n2] = await seedQuestions(2);
            const s = await createStudent('混合生');
            await flaggedPaper(s, [a, b], day(-2));
            const draft = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 2, dry_run: true, retrain: { count: 2 } });
            assert.equal(draft.status, 200, JSON.stringify(draft.body));
            const retrainIds = draft.body.questions.filter(q => q.purpose === 'retrain').map(q => q.id);
            assert.deepEqual(retrainIds.sort((x, y) => x - y), [a, b]);

            const res = await confirm({ student_id: s, question_ids: draft.body.question_ids, retrain_question_ids: retrainIds });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body), ['message', 'paper_id', 'paper_title', 'question_ids', 'questions', 'retrain_question_ids']);
            assert.deepEqual(res.body.retrain_question_ids, res.body.question_ids.filter(q => q === a || q === b));
            assert.equal(res.body.paper_title, `混合生-向量內積特訓卷(${titleDate})`);
            const rows = await assignmentsOf(res.body.paper_id);
            const ia = await itemOf(s, a);
            const ib = await itemOf(s, b);
            assert.deepEqual(rows, [
                { question_id: a, purpose: 'retrain', retrain_item_id: ia.id, retrain_step: 1, assigned_at: today },
                { question_id: b, purpose: 'retrain', retrain_item_id: ib.id, retrain_step: 1, assigned_at: today },
                { question_id: n1, purpose: 'new', retrain_item_id: null, retrain_step: null, assigned_at: today },
                { question_id: n2, purpose: 'new', retrain_item_id: null, retrain_step: null, assigned_at: today }
            ]);
            const { rows: [rec] } = await query(
                'SELECT COUNT(*)::int AS n FROM attempt_records r JOIN assignments s ON s.id = r.assignment_id WHERE s.paper_id = $1', [res.body.paper_id]);
            assert.equal(rec.n, 4, '每一筆派題都有一筆空白作答');
            // 已派出：清單上 in_flight、不再到期；試卷列表標「含重練 2 題」
            const list = await request(appOn).get(`/api/students/${s}/retrain-items`);
            assert.deepEqual(list.body.items.map(i => [i.question_id, i.in_flight, i.due, i.in_flight_paper_id]),
                [[a, true, false, res.body.paper_id], [b, true, false, res.body.paper_id]]);
            const papers = await request(appOn).get(`/api/students/${s}/papers`);
            assert.deepEqual(papers.body.items.map(p => [p.paper_id, p.retrain_count]).find(p => p[0] === res.body.paper_id), [res.body.paper_id, 2]);
            assert.deepEqual(Object.keys(papers.body.items[0]), ['paper_id', 'title', 'created_at', 'total', 'graded', 'retrain_count']);
            // API-9：試卷明細的 purpose／retrain_step（PR-2 的欄位）對得上
            const detail = await request(appOn).get(`/api/papers/${res.body.paper_id}`);
            assert.deepEqual(detail.body.questions.filter(q => q.purpose === 'retrain').map(q => q.retrain_step), [1, 1]);
        });

        test('API-7 純重練卷：卷名「<姓名>-錯題重練卷(日期)」；批改後照排程升關；刪掉重練卷後重算（等於沒發生過）', async () => {
            const [a] = await seedQuestions(1);
            const s = await createStudent('純重練生');
            await flaggedPaper(s, [a], day(-2));
            const res = await confirm({ student_id: s, question_ids: [a], retrain_question_ids: [a] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.paper_title, `純重練生-錯題重練卷(${titleDate})`);
            const g = await patch(res.body.paper_id, [{ question_id: a, result: 1 }]);
            assert.deepEqual(g.body, { updated: 1, retrain: { entered: 0, advanced: 1, mastered: 0, reset: 0 } });
            const up = await itemOf(s, a);
            assert.deepEqual([up.status, up.step, up.due_on, up.streak], ['active', 2, day(7), 1], '派題日（今天）＋7 天');
            const del = await request(appOn).delete(`/api/papers/${res.body.paper_id}`);
            assert.deepEqual([del.status, del.body], [200, { deleted_attempts: 1 }]);
            const it = await itemOf(s, a);
            assert.deepEqual([it.status, it.step, it.due_on, it.streak], ['active', 1, day(-1), 0]);
        });

        test('API-7 409：重練題已派到別張卷（I6）、不在清單、已移出；當成新題送 → 既有 409；兩個確認同時送出後者 409', async () => {
            const [a, b, c] = await seedQuestions(3);
            const [n1] = await seedQuestions(1);
            const s = await createStudent('衝突生');
            await flaggedPaper(s, [a, b], day(-2));
            await insertAttempts(query, [{ student_id: s, question_id: c, assigned_at: day(-30) }]);   // 派過、沒進清單

            const first = await confirm({ student_id: s, question_ids: [a], retrain_question_ids: [a] });
            assert.equal(first.status, 200);
            const retire = await request(appOn).patch(`/api/students/${s}/retrain-items/${(await itemOf(s, b)).id}`).send({ action: 'retire' });
            assert.equal(retire.status, 200);
            const before0 = await footprint();
            const again = await confirm({ student_id: s, question_ids: [a, n1], retrain_question_ids: [a] });
            assert.deepEqual([again.status, again.body], [409, { message: CONFLICT(a) }]);
            const notIn = await confirm({ student_id: s, question_ids: [c], retrain_question_ids: [c] });
            assert.deepEqual([notIn.status, notIn.body], [409, { message: CONFLICT(c) }]);
            const retired = await confirm({ student_id: s, question_ids: [b], retrain_question_ids: [b] });
            assert.deepEqual([retired.status, retired.body], [409, { message: CONFLICT(b) }]);
            const asNew = await confirm({ student_id: s, question_ids: [b, n1], retrain_question_ids: [] });
            assert.deepEqual([asNew.status, asNew.body], [409, { message: '部分題目已被指派給該學生（可能是預覽已過期），請重新預覽。' }]);
            assert.deepEqual(await footprint(), before0, '409 時整筆回滾');

            // 兩個確認同時送出同一題重練：一個 200、一個 409（先鎖項目再檢查）
            const [d] = await seedQuestions(1);
            await flaggedPaper(s, [d], day(-3));
            const both = await Promise.all([
                confirm({ student_id: s, question_ids: [d], retrain_question_ids: [d] }),
                confirm({ student_id: s, question_ids: [d], retrain_question_ids: [d] })
            ]);
            assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
            assert.deepEqual(both.find(r => r.status === 409).body, { message: CONFLICT(d) });
            const { rows: [cnt] } = await query(`SELECT COUNT(*)::int AS n FROM assignments WHERE question_id = $1 AND purpose = 'retrain'`, [d]);
            assert.equal(cnt.n, 1);
        });

        test('API-7 參數：不是子集、重複、格式錯誤 → 400（排在既有檢查之後）；空陣列＝沒有重練題', async () => {
            const [n1, n2] = await seedQuestions(2);
            const s = await createStudent('確認參數生');
            const cases = [
                [[n2], `retrain_question_ids 的每一題都必須在 question_ids 裡（不在的：${n2}）。`],
                [[n1, n1], 'retrain_question_ids 不得重複。'],
                [['1'], 'retrain_question_ids 必須是正整數陣列。'],
                [n1, 'retrain_question_ids 必須是正整數陣列。']
            ];
            for (const [ids, message] of cases) {
                const res = await confirm({ student_id: s, question_ids: [n1], retrain_question_ids: ids });
                assert.deepEqual([res.status, res.body], [400, { message }], JSON.stringify(ids));
            }
            const missing = await confirm({ student_id: 999999, question_ids: [n1], retrain_question_ids: [n2] });
            assert.equal(missing.status, 404, '既有檢查（學生不存在）先回報');
            const empty = await confirm({ student_id: s, question_ids: [n1], retrain_question_ids: [] });
            assert.equal(empty.status, 200);
            assert.deepEqual(empty.body.retrain_question_ids, []);
            assert.equal(empty.body.paper_title, `確認參數生-向量內積特訓卷(${titleDate})`);
        });

        test('API-7 承上組與 B7 一視同仁（風險 R-9）：重練卷只放承上題 → 400；缺的前題還在清單上 → 標「加回來就好」', async () => {
            const group = await seedGroup(2);
            const s = await createStudent('承上重練生');
            await flaggedPaper(s, group, day(-3), { flag: [group[1]] });   // 勾承上題，前題以 group 一起進清單
            const res = await confirm({ student_id: s, question_ids: [group[1]], retrain_question_ids: [group[1]] });
            assert.equal(res.status, 400);
            assert.deepEqual(res.body.incomplete_groups, [{ group_ids: group, missing: [{ question_id: group[0], reason: 'not_in_paper' }] }]);
            assert.equal(res.body.message,
                `承上題必須與前題整組出卷，以下題組不完整：承上題組（#${group[0]}、#${group[1]}）缺 #${group[0]}。請把缺的題加回卷裡，或把整組刪掉後再確認。`);
            // 前題移出清單後就加不回來（該生已寫過），訊息照 B7 的原規則
            const it = await itemOf(s, group[0]);
            await request(appOn).patch(`/api/students/${s}/retrain-items/${it.id}`).send({ action: 'retire' });
            const res2 = await confirm({ student_id: s, question_ids: [group[1]], retrain_question_ids: [group[1]] });
            assert.equal(res2.status, 400);
            // retire 對整組生效：承上題本身也移出了，但 B7 先擋（缺題），不會走到重練檢查
            assert.deepEqual(res2.body.incomplete_groups[0].missing, [{ question_id: group[0], reason: 'answered' }]);
            // 整組一起出（重新加入之後）
            await request(appOn).patch(`/api/students/${s}/retrain-items/${it.id}`).send({ action: 'reactivate' });
            const ok = await confirm({ student_id: s, question_ids: group, retrain_question_ids: group });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            assert.deepEqual(ok.body.question_ids, group);
        });

        // ───────────────────── API-5 出一份重練卷 ─────────────────────

        test('API-5：草稿形狀、依第 4.7 節排序、題數上限、附註；不寫庫；確認後卷名與派題正確', async () => {
            const olds = await seedQuestions(4);
            const s = await createStudent('重練卷生');
            await flaggedPaper(s, [olds[0]], day(-3));           // 逾期 2 天
            await flaggedPaper(s, [olds[1]], day(-8));           // 逾期 7 天
            await flaggedPaper(s, [olds[2]], day(-5));           // 逾期 4 天
            await flaggedPaper(s, [olds[3]], today);             // 還沒到期
            const before0 = await footprint();

            const res = await retrainPaper(s, { count: 2 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(Object.keys(res.body), ['student_id', 'subject', 'as_of', 'question_ids', 'items', 'due_total', 'notes']);
            assert.deepEqual([res.body.student_id, res.body.subject, res.body.as_of, res.body.due_total], [s, null, today, 3]);
            assert.deepEqual(res.body.items.map(i => [i.question_id, i.overdue_days, i.step, i.step_label, i.due]),
                [[olds[1], 7, 1, '錯題重練', true], [olds[2], 4, 1, '錯題重練', true]]);
            assert.deepEqual(Object.keys(res.body.items[0]), ['question_id', 'item_id', 'step', 'step_label', 'due_on', 'overdue_days',
                'chapter', 'difficulty', 'question_text_preview', 'follows_question_id', 'group_ids', 'status', 'due']);
            assert.deepEqual(new Set(res.body.question_ids), new Set([olds[1], olds[2]]));
            assert.deepEqual(res.body.notes, ['到期 3 題，本草稿放 2 題（題數上限）；其餘留在清單，下次優先。']);
            assert.deepEqual(await footprint(), before0, '草稿不寫庫');

            // 預設 10 題：全部到期的都進來，沒有附註；include_not_due 把還沒到期的也放進來（排在到期的後面）
            const all = await retrainPaper(s);
            assert.deepEqual(all.body.items.map(i => i.question_id), [olds[1], olds[2], olds[0]]);
            assert.deepEqual(all.body.notes, []);
            const early = await retrainPaper(s, { include_not_due: true });
            assert.deepEqual(early.body.items.map(i => [i.question_id, i.due]), [[olds[1], true], [olds[2], true], [olds[0], true], [olds[3], false]]);
            // subject 篩選
            const phys = await retrainPaper(s, { subject: '物理' });
            assert.deepEqual([phys.body.items, phys.body.due_total, phys.body.notes], [[], 0, ['目前沒有到期的重練題。']]);

            // 確認：confirm-paper { question_ids, retrain_question_ids: question_ids }
            const ok = await confirm({ student_id: s, question_ids: all.body.question_ids, retrain_question_ids: all.body.question_ids });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            assert.equal(ok.body.paper_title, `重練卷生-錯題重練卷(${titleDate})`);
            assert.ok((await assignmentsOf(ok.body.paper_id)).every(r => r.purpose === 'retrain' && r.retrain_step === 1));
            // 已派出的不會再出現在下一份草稿
            const next = await retrainPaper(s, { include_not_due: true });
            assert.deepEqual(next.body.items.map(i => i.question_id), [olds[3]]);
        });

        test('API-5：R12 放不下 → 400；整組不能出的組寫進附註；參數驗證與 404；include_not_due=false 與 listDueUnits 一致', async () => {
            const group = await seedGroup(3);
            const [single] = await seedQuestions(1);
            const s = await createStudent('重練卷承上生');
            await flaggedPaper(s, [single], day(-9));
            await flaggedPaper(s, group, day(-4), { flag: [group[0]] });
            const r12 = await retrainPaper(s, { count: 2 });
            assert.deepEqual([r12.status, r12.body], [400, {
                message: `到期的承上題組（題 ${group.join('、')}）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 1 或 4。`
            }]);
            const r12b = await retrainPaper(s, { count: 1, as_of: day(-5) });   // 那一天只有 single 到期
            assert.equal(r12b.status, 200);
            assert.deepEqual(r12b.body.items.map(i => i.question_id), [single]);

            // 組內一題已派出（別張重練卷還沒批改）→ 整組不能出，附註說明
            const p = await confirm({ student_id: s, question_ids: [single], retrain_question_ids: [single] });
            assert.equal(p.status, 200);
            const it = await itemOf(s, group[2]);
            await request(appOn).patch(`/api/students/${s}/retrain-items/${it.id}`).send({ action: 'mark_mastered' });
            const draft = await retrainPaper(s);
            assert.deepEqual(draft.body.items.map(i => [i.question_id, i.status]), [[group[0], 'active'], [group[1], 'active'], [group[2], 'mastered']],
                '已練到會的組員被帶著出');
            // listDueUnits 與 unitsFromViews(listItems all) 一致（include_not_due 的實作與 PR-2 的到期規則同一條）
            const sameAsPr2 = async () => {
                const due = await retrain.listDueUnits(query, s, { today });
                const list = await retrain.listItems(query, s, { status: 'all', today });
                assert.deepEqual(retrainSelect.unitsFromViews(list.items), { due_total: due.due_total, units: due.units, blocked: due.blocked });
            };
            await sameAsPr2();
            // 組內一題封存 → 整組不能出（blocked），附註說明原因；到期題數照算
            await query('UPDATE questions SET archived_at = now() WHERE id = $1', [group[2]]);
            const blocked = await retrainPaper(s);
            assert.deepEqual([blocked.body.items, blocked.body.due_total], [[], 2]);
            assert.deepEqual(blocked.body.notes, [
                `承上題組（題 ${group.join('、')}）有題到期，但組內有題已封存，這次不能出（承上題要整組出）；請到錯題重練清單處理。`
            ]);
            await sameAsPr2();

            // 參數
            for (const [body, message] of [
                [{ count: 0 }, 'count 必須是 1~50 的整數。'],
                [{ count: 51 }, 'count 必須是 1~50 的整數。'],
                [{ subject: '生物' }, 'subject 不在白名單內。'],
                [{ as_of: '2026-02-30' }, 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
                [{ include_not_due: 'yes' }, 'include_not_due 只接受 true 或 false。'],
                [{ counts: 3 }, '不接受的欄位：counts（可用的欄位：subject、count、as_of、include_not_due）。']
            ]) {
                const res = await retrainPaper(s, body);
                assert.deepEqual([res.status, res.body], [400, { message }], JSON.stringify(body));
            }
            assert.equal((await retrainPaper(999999)).status, 404);
            assert.equal((await retrainPaper('abc')).status, 404);
        });

        // ───────────────────── API-8 補救卷 ─────────────────────

        test('API-8：retrain_count 多一組 bucket = retrain（blueprint、shortfalls、notes 照既有格式）；0 或沒帶逐字不變；確認時帶 retrain_question_ids', async () => {
            const olds = await seedQuestions(2);
            await seedQuestions(6);
            const s = await createStudent('補救重練生');
            // 以前的卷：兩題錯（勾要重練）＋兩題對 → 章節基底有批改資料
            const extra = await seedQuestions(2);
            await flaggedPaper(s, olds, day(-6));
            const { rows: [p] } = await query('INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id',
                ['舊卷二', s, extra]);
            await insertAttempts(query, extra.map(q => ({ student_id: s, question_id: q, paper_id: p.id, assigned_at: day(-6), result: 1, graded_at: 'now' })));

            const plain = await remedialPaper(s, { subject: '數學', total: 5 });
            assert.equal(plain.status, 200, JSON.stringify(plain.body));
            assert.ok(plain.body.items.every(i => i.bucket !== 'retrain'));
            const zero = await remedialPaper(s, { subject: '數學', total: 5, retrain_count: 0 });
            assert.deepEqual(Object.keys(zero.body), Object.keys(plain.body));
            assert.deepEqual([zero.body.basis, zero.body.blueprint, zero.body.notes], [plain.body.basis, plain.body.blueprint, plain.body.notes],
                'retrain_count: 0 等於沒帶');

            const before0 = await footprint();
            const res = await remedialPaper(s, { subject: '數學', total: 5, retrain_count: 3 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(await footprint(), before0, '草稿不寫庫');
            const rt = res.body.items.filter(i => i.bucket === 'retrain');
            assert.deepEqual(rt.map(i => i.question_id).sort((x, y) => x - y), olds);
            assert.deepEqual(Object.keys(rt[0]), ['question_id', 'bucket', 'target', 'chapter', 'difficulty', 'question_text_preview',
                'follows_question_id', 'group_ids', 'item_id', 'step', 'step_label', 'due_on', 'overdue_days']);
            assert.deepEqual(rt[0].target, { type: 'retrain', name: '到期重練' });
            const bp = res.body.blueprint.at(-1);
            assert.deepEqual([bp.bucket, bp.wanted, bp.got], ['retrain', 3, 2]);
            assert.deepEqual(res.body.shortfalls.at(-1), { bucket: 'retrain', target: { type: 'retrain', name: '到期重練' }, wanted: 3, got: 2, reason: 'not_enough_due' });
            assert.deepEqual(res.body.blueprint.slice(0, -1), plain.body.blueprint, '補救組的配額不受影響');
            assert.equal(res.body.basis, plain.body.basis);
            assert.deepEqual(new Set(res.body.question_ids), new Set(res.body.items.map(i => i.question_id)));

            // 參數
            for (const [body, message] of [
                [{ subject: '數學', total: 5, retrain_count: 21 }, 'retrain_count 必須是 0~20 的整數。'],
                [{ subject: '數學', total: 40, retrain_count: 11 }, 'total 加上 retrain_count 最多 50 題（補救 40 題＋重練 11 題）。'],
                [{ subject: '化學', total: 1, retrain_count: 1 }, 'total 必須是 5~50 的整數。']
            ]) {
                const bad = await remedialPaper(s, body);
                assert.deepEqual([bad.status, bad.body], [400, { message }], JSON.stringify(body));
            }

            // 確認：到期重練組的題放進 retrain_question_ids
            const ids = res.body.question_ids;
            const ok = await confirm({ student_id: s, question_ids: ids, retrain_question_ids: rt.map(i => i.question_id) });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            const rows = await assignmentsOf(ok.body.paper_id);
            assert.deepEqual(rows.filter(r => r.purpose === 'retrain').map(r => r.question_id), olds);
        });

        test('API-8 R12 與 R10：承上組放不下 → 400；補救卷的 basis 與弱點排序只看第一次作答（重練答對不改變）', async () => {
            const group = await seedGroup(2);
            const pool = await seedQuestions(6);
            const s = await createStudent('補救承上生');
            await flaggedPaper(s, group, day(-5), { flag: [group[1]] });
            const r12 = await remedialPaper(s, { subject: '數學', total: 5, retrain_count: 1 });
            assert.deepEqual([r12.status, r12.body], [400, {
                message: `到期的承上題組（題 ${group.join('、')}）共 2 題，放不進剩下的 1 個重練名額；請把重練題數改成 2。`
            }]);

            const firstOnly = await remedialPaper(s, { subject: '數學', total: 5 });
            // 重練卷批改全對：排程升關，但補救卷的 basis 與弱點（章節掌握度）照舊只看第一次作答
            const p = await confirm({ student_id: s, question_ids: group, retrain_question_ids: group });
            assert.equal(p.status, 200, JSON.stringify(p.body));
            const g = await patch(p.body.paper_id, group.map(q => ({ question_id: q, result: 1 })));
            assert.deepEqual(g.body.retrain, { entered: 0, advanced: 2, mastered: 0, reset: 0 });
            const after = await remedialPaper(s, { subject: '數學', total: 5 });
            assert.equal(after.body.basis, firstOnly.body.basis);
            assert.deepEqual(after.body.blueprint.map(b => [b.bucket, b.target, b.rationale]),
                firstOnly.body.blueprint.map(b => [b.bucket, b.target, b.rationale]), 'R10：重練答對不改變弱點排序與掌握度');
            assert.ok(after.body.items.every(i => pool.includes(i.question_id)), '新題候選池照舊排除寫過的題');
        });

        // ───────────────────── API-12 download-word（TC-039-4 的整合層）─────────────────────

        test('API-12：帶 paper_id 依 R7 標示（標準版答案區與詳解版標、題目區與學生版不標）；沒帶或旗標關閉逐位元不變', async () => {
            const [a] = await seedQuestions(1, { type: '填空', difficulty: 1 });
            const [n1] = await seedQuestions(1, { type: '計算', difficulty: 5 });
            const s = await createStudent('Word 生');
            await flaggedPaper(s, [a], day(-2));
            const p = await confirm({ student_id: s, question_ids: [a, n1], retrain_question_ids: [a] });
            assert.equal(p.status, 200, JSON.stringify(p.body));
            assert.deepEqual(p.body.question_ids, [a, n1], '填空在計算前面');
            const base = { paper_title: p.body.paper_title, student_name: 'Word 生', question_ids: p.body.question_ids };

            const plain = await wordXml(base);
            assert.ok(!plain.includes('（重練）'), '沒帶 paper_id 不標');
            const std = await wordXml({ ...base, paper_id: p.body.paper_id });
            assert.ok(std.includes('第 1 題（重練）答案：'), '標準版答案區標第 1 題');
            assert.ok(std.includes('第 2 題答案：') && !std.includes('第 2 題（重練）'), '新題不標');
            assert.equal(std.split('（重練）').length - 1, 1, '題目區不標（只有答案區一處）');
            assert.equal(std.replace('第 1 題（重練）答案：', '第 1 題答案：'), plain, '除了標示之外逐字相同');
            const sol = await wordXml({ ...base, paper_id: p.body.paper_id, edition: 'solution' });
            assert.ok(sol.includes('第 1 題（重練）答案：'));
            assert.equal(sol.split('（重練）').length - 1, 1);
            const stu = await wordXml({ ...base, paper_id: p.body.paper_id, edition: 'student' });
            assert.ok(!stu.includes('（重練）'), '學生版完全不標');
            // 卷上沒有重練題、卷不存在：不標，與沒帶一樣
            assert.equal(await wordXml({ ...base, paper_id: 999999 }), plain);
            // 旗標關閉：paper_id 照舊被忽略（組卷頁本來就會送），格式不對也不擋
            await withRetrain(false, async app => {
                assert.equal(await wordXml({ ...base, paper_id: p.body.paper_id }, app), plain);
                assert.equal(await wordXml({ ...base, paper_id: 'abc' }, app), plain);
            });
            // 旗標開啟：格式不對 → 400（排在既有檢查之後）
            const bad = await request(appOn).post('/api/download-word').send({ ...base, paper_id: 'abc' });
            assert.deepEqual([bad.status, bad.body], [400, { message: 'paper_id 必須是正整數。' }]);
            const bad2 = await request(appOn).post('/api/download-word').send({ ...base, question_ids: [], paper_id: 'abc' });
            assert.deepEqual(bad2.body, { message: '無效的題目資料，無法產生 Word' });
        });

        test('設定：RETRAIN_ATTACH_RATIO 由 app.js 注入 <meta name="retrain-attach-ratio">（組卷頁與補救卷的預設題數）', async () => {
            const res = await request(appOn).get('/');
            assert.equal(res.status, 200);
            assert.ok(res.text.includes(`<meta name="retrain-attach-ratio" content="${loadRetrainConfig().attachRatio}">`));
            assert.ok(!res.text.includes('__RETRAIN_ATTACH_RATIO__'), '佔位字串（含註解裡的）都要被換掉');
        });
    });
}
