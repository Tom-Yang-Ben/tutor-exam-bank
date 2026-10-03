// ─────────────────────────────────────────────────────────────
// studentReport.pg.test.js — 學習報告與助教的補救卷工具（〔dec/r16-remedial〕；docs/student-report.md、docs/remedial.md 第 12 節）
//
// 涵蓋：
//   GET /api/students/:id/report   老師版（批改量、最弱章節、錯因、趨勢、建議）、家長版（沒有內部代碼）、html、docx、
//                                  R10（重練作答不算）、重練與補救成效兩節跟著旗標、400／404、FEATURE_STUDENTS 關閉 404
//   助教工具（假 LLM，不讀寫 cassette）  plan_remedial_paper 真的跑補救卷草稿（只預覽、不寫庫）、get_remedial_effect；
//                                  送給 LLM 的 prompt 裡沒有學生姓名
//
// 三道防線同 remedial.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('學習報告整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;
    process.env.WEAKNESS_MIN_N = '5';

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');
    function loadApp(students) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_STUDENTS;
        process.env.FEATURE_STUDENTS = students ? 'true' : 'false';
        try { return require(APP_PATH); } finally {
            if (saved === undefined) delete process.env.FEATURE_STUDENTS; else process.env.FEATURE_STUDENTS = saved;
        }
    }
    const appOff = loadApp(false);
    const app = loadApp(true);
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const assistant = require(path.join(APP_DIR, 'services', 'assistantService'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));

    /** 旗標（報告的重練、補救兩節每次請求即時讀）。 */
    async function withFlags(flags, fn) {
        const saved = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
        for (const [k, v] of Object.entries(flags)) process.env[k] = v ? 'true' : 'false';
        try { return await fn(); } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    }

    let seq = 0;
    async function addQ(chapter, difficulty = 3) {
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ('數學', $1, '計算', $2, $3, '自製答案') RETURNING id`, [chapter, difficulty, `自製報告測試題 ${++seq}：求 $x+${seq}$。`]);
        return rows[0].id;
    }
    async function addStudent(name) {
        const { rows } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id', [name]);
        return rows[0].id;
    }

    /**
     * 王小明：向量內積 6 題錯 4（觀念不清 3、計算 1）、排列 6 題錯 1；
     * 另有一題重練作答（答錯、標觀念不清）——R10：不進報告。
     */
    async function seed() {
        const s = await addStudent('王小明');
        const { rows: [p] } = await query(`INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('王小明-向量內積特訓卷', $1, '{}') RETURNING id`, [s]);
        const vec = [];
        for (let i = 0; i < 6; i++) vec.push(await addQ('向量內積'));
        const perm = [];
        for (let i = 0; i < 6; i++) perm.push(await addQ('排列'));
        const rows = [];
        vec.forEach((q, i) => rows.push({ student_id: s, question_id: q, paper_id: p.id, days_ago: 5, graded_at: 'now',
            result: i < 4 ? 0 : 1, error_types: i < 3 ? ['concept'] : (i === 3 ? ['calc'] : []) }));
        perm.forEach((q, i) => rows.push({ student_id: s, question_id: q, paper_id: p.id, days_ago: 5, graded_at: 'now', result: i === 0 ? 0 : 1 }));
        await insertAttempts(query, rows);
        await insertAttempts(query, [{ student_id: s, question_id: perm[1], purpose: 'retrain', days_ago: 1, result: 0, graded_at: 'now', error_types: ['concept'] }]);
        return { s, paperId: p.id };
    }
    const report = (s, qs = '', a = app) => request(a).get(`/api/students/${s}/report${qs}`);

    describe('學習報告與助教的補救卷工具（〔dec/r16-remedial〕）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], { cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8' });
        });
        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
        });
        after(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
            await pool.end();
        });

        test('400／404；FEATURE_STUDENTS 關閉時路由不掛載', async () => {
            const { s } = await seed();
            assert.equal((await report(s, '', appOff)).status, 404);
            assert.equal((await report(999)).status, 404);
            assert.equal((await report('abc')).status, 404);
            const bad = await report(s, '?audience=student');
            assert.equal(bad.status, 400);
            assert.equal(bad.body.message, 'audience 只接受 teacher、parent。');
            assert.equal((await report(s, '?days=0')).status, 400);
        });

        test('老師版：批改量（R10：重練不算）、最弱章節、錯因、建議；重練與補救兩節跟著旗標（關閉為 null）', async () => {
            const { s } = await seed();
            const res = await withFlags({ FEATURE_RETRAIN: false, FEATURE_REMEDIAL: false }, () => report(s));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const r = res.body;
            assert.equal(r.audience, 'teacher');
            assert.deepEqual(r.student, { id: s, name: '王小明' });
            assert.deepEqual(r.summary, { papers: 1, assigned: 12, graded: 12, correct: 7, correct_rate: 0.5833 });
            assert.deepEqual(r.weakest_chapters.map(c => [c.chapter, c.graded, c.wrong, c.low_sample]), [['向量內積', 6, 4, false], ['排列', 6, 1, false]]);
            assert.deepEqual(r.error_types.map(e => [e.code, e.label, e.count]), [['concept', '觀念不清', 3], ['calc', '計算錯誤', 1]], 'R10：重練標的觀念不清不算');
            assert.deepEqual(r.suggestions.map(x => x.code), ['weak_chapter', 'error_focus:concept']);
            assert.equal(r.retrain, null);
            assert.equal(r.remedial_effect, null);
            assert.equal(r.period.days, 30);
        });

        test('家長版：白話、沒有內部代碼；html 與 docx', async () => {
            const { s } = await seed();
            const p = await withFlags({ FEATURE_RETRAIN: true, FEATURE_REMEDIAL: true }, () => report(s, '?audience=parent&days=60'));
            assert.equal(p.status, 200, JSON.stringify(p.body));
            const json = JSON.stringify(p.body);
            for (const banned of ['concept', '"code"', 'low_sample', 'wrong_rate', '"id"']) assert.ok(!json.includes(banned), banned);
            assert.deepEqual(p.body.suggestions.map(x => x.text), [
                '「向量內積」這個單元還不太穩（6 題錯 4 題），接下來會加強練習。',
                '有些觀念還不夠清楚，接下來會先用基本題把觀念講清楚。'
            ]);
            assert.deepEqual(p.body.retrain, { practicing: 1, mastered: 0 }, '重練旗標開啟：重練那一題的項目');

            const html = await withFlags({ FEATURE_RETRAIN: false, FEATURE_REMEDIAL: false }, () => report(s, '?audience=parent&format=html'));
            assert.equal(html.status, 200);
            assert.match(html.headers['content-type'], /text\/html/);
            assert.ok(html.text.includes('給家長的學習報告－王小明'));

            const docx = await report(s, '?format=docx').buffer(true)
                .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
            assert.equal(docx.status, 200);
            assert.match(docx.headers['content-type'], /wordprocessingml/);
            assert.match(docx.headers['content-disposition'], /filename\*=UTF-8''/);
            const xml = await documentXml(docx.body);
            assert.ok(xml.includes('學習報告（老師版）－王小明'));
        });

        test('補救成效一節（FEATURE_REMEDIAL）：補救卷的單位與狀態', async () => {
            const { s } = await seed();
            const q = await addQ('向量內積');
            const { rows: [rp] } = await query(
                `INSERT INTO exam_papers (title, student_id, question_ids, kind, targets) VALUES ('補救卷', $1, $2::int[], 'remedial', $3::jsonb) RETURNING id`,
                [s, [q], JSON.stringify([{ unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial', baseline: { graded: 6, wrong: 4, wrong_rate: 0.6667, low_sample: false } }])]);
            await insertAttempts(query, [{ student_id: s, question_id: q, paper_id: rp.id, days_ago: 0 }]);
            const res = await withFlags({ FEATURE_REMEDIAL: true }, () => report(s));
            assert.deepEqual(res.body.remedial_effect, { papers: 1, counts: { improved: 0, no_change: 0, worse: 0, insufficient_data: 0, pending: 1 },
                units: [{ name: '向量內積', status: 'pending', before_rate: 0.3333, after_rate: null, after_graded: 0, low_sample: true }] });
        });

        test('助教工具（假 LLM）：plan_remedial_paper 跑真的草稿、不寫庫；get_remedial_effect；prompt 沒有姓名', async () => {
            const { s } = await seed();
            for (let i = 0; i < 5; i++) await addQ('向量內積', 2);
            const before = (await query('SELECT (SELECT COUNT(*) FROM exam_papers)::int AS p, (SELECT COUNT(*) FROM assignments)::int AS a')).rows[0];
            const calls = [];
            const decisions = [
                { action: 'call_tool', tool: 'plan_remedial_paper', args_json: JSON.stringify({ student_name: `學生#${s}`, subject: '數學', total: 5 }) },
                { action: 'call_tool', tool: 'get_remedial_effect', args_json: JSON.stringify({ student_name: `學生#${s}` }) },
                { action: 'final', reply: `學生#${s} 的補救卷草稿已預覽。` }
            ];
            const llm = { async generateJson(opts) { calls.push(opts); return { data: decisions[calls.length - 1], usage: {}, latencyMs: 0 }; } };
            const out = await assistant.runAssistant({ message: '幫王小明出一份補救卷看看', deps: { llm, remedialTools: true } });
            assert.equal(out.reply, '王小明 的補救卷草稿已預覽。');
            const [plan, effect] = out.steps;
            assert.equal(plan.ok, true, JSON.stringify(plan.result));
            assert.equal(plan.args.student_name, '王小明');
            assert.equal(plan.result.basis, 'chapter');
            // 5 題＝補救 4（先備併入）＋延伸 1；排列的題他都寫過 → 延伸湊不到，草稿 4 題
            assert.equal(plan.result.question_count, 4);
            assert.deepEqual(plan.result.targets.map(t => [t.bucket, t.unit, t.wanted, t.got, t.error_focus?.label ?? null]),
                [['remedial', '向量內積', 4, 4, '觀念不清'], ['extension', '排列', 1, 0, null]]);
            assert.equal(plan.result.targets[0].error_focus.applied, true);
            assert.deepEqual(plan.result.shortfalls, [{ bucket: 'extension', unit: '排列', wanted: 1, got: 0, reason: 'insufficient_stock' }]);
            assert.match(plan.result.note, /僅預覽/);
            assert.equal(effect.ok, true);
            assert.deepEqual(effect.result.papers, []);
            const after = (await query('SELECT (SELECT COUNT(*) FROM exam_papers)::int AS p, (SELECT COUNT(*) FROM assignments)::int AS a')).rows[0];
            assert.deepEqual(after, before, '只預覽、不寫庫');
            assert.equal(calls.length, 3);
            for (const c of calls) {
                assert.equal(c.template, 'assistant.v2+remedial.v1');
                assert.ok(!c.parts[0].text.includes('王小明'), 'prompt 裡沒有姓名');
                assert.ok(!JSON.stringify(c.cacheKeyParts).includes('王小明'), '鍵裡沒有姓名');
            }
            assert.match(calls[1].parts[0].text, /plan_remedial_paper/);
        });
    });
}
