// ─────────────────────────────────────────────────────────────
// remedialEffect.pg.test.js — 補救成效追蹤的整合測試（〔dec/r16-remedial〕；docs/remedial.md 第 10 節）
//
// 涵蓋（依錯因出題在 remedialErrorFocus.pg.test.js）：
//   migrations/0022                       exam_papers.kind（預設 normal、CHECK）、targets（只有 remedial 能有）；再套一次不動
//   POST /api/confirm-paper                kind: 'remedial'＋targets 存進資料庫；不合法的 targets 400 且什麼都不寫；
//                                          一般卷 kind = normal；純重練卷 kind = retrain
//   GET  /api/students/:id/remedial-effect improved／worse／insufficient_data／pending、只算補救卷批改完之後建立的卷、
//                                          R10（重練作答不算）、知識點單位加權、days 時間窗、從草稿一路到成效、404／400、旗標關閉 404
//
// 題目內容全為自製。三道防線同 remedial.pg.test.js：只讀 TEST_DATABASE_URL、庫名須 _test 結尾、require config/db 前覆寫 DATABASE_URL。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('補救成效整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));
    const MIGRATION = fs.readFileSync(path.join(APP_DIR, 'migrations', '0022_paper_kind_targets.sql'), 'utf8');

    // ─────────────────── fixture 輔助 ───────────────────
    let seq = 0;

    async function addQ({ subject = '數學', chapter = '向量內積', difficulty = 3, type = '計算', text = null } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ($1, $2, $3, $4, $5, '自製答案') RETURNING id`,
            [subject, chapter, type, difficulty, text ?? `自製補救成效測試題 ${++seq}：設 $x=${seq}$，求 $3x$。`]
        );
        return r.id;
    }
    async function addMany(n, opts) {
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(await addQ(opts));
        return ids;
    }
    async function addStudent() {
        const { rows: [r] } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id', [`補救成效測試生${++seq}`]);
        return r.id;
    }
    async function addKc(code, { chapter = '向量內積', name = code } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO knowledge_components (code, subject, chapter, name, sort, status) VALUES ($1, '數學', $2, $3, 1, 'draft') RETURNING id`,
            [code, chapter, name]);
        return r.id;
    }
    const tag = (q, kc, weight = 1) => query(`INSERT INTO question_kcs (question_id, kc_id, weight, src) VALUES ($1, $2, $3, 'human')`, [q, kc, weight]);

    /** 歷史錯題：每題一筆第一次作答（沒有卷號），答錯、標 error_types。 */
    async function wrongHistory(studentId, questionIds, errorTypes) {
        await insertAttempts(query, questionIds.map((q, i) => ({
            student_id: studentId, question_id: q, days_ago: 3, result: 0, graded_at: 'now', error_types: errorTypes[i] || []
        })));
    }

    /** 直接建一張卷（可指定種類、快照、建立時間）＋每題一筆新題派題（未批改）。回傳卷號。 */
    async function paper(studentId, qids, { kind = 'normal', targets = null, createdAgo = '0 days' } = {}) {
        const { rows: [p] } = await query(
            `INSERT INTO exam_papers (title, student_id, question_ids, kind, targets, created_at)
             VALUES ('測試卷', $1, $2::int[], $3, $4::jsonb, now() - $5::interval) RETURNING id`,
            [studentId, qids, kind, targets === null ? null : JSON.stringify(targets), createdAgo]);
        await insertAttempts(query, qids.map(q => ({ student_id: studentId, question_id: q, paper_id: p.id, days_ago: 0 })));
        return p.id;
    }

    /** 批改某張卷上的某題（新題派題的作答）：result、score、批改時間（多久以前）。 */
    async function grade(paperId, questionId, result, { score = null, gradedAgo = '0 days', errorTypes = [] } = {}) {
        const r = await query(
            `UPDATE attempt_records r SET result = $3, score = $4, graded_at = now() - $5::interval, error_types = $6::text[]
               FROM assignments a
              WHERE r.assignment_id = a.id AND a.paper_id = $1 AND a.question_id = $2 AND a.purpose = 'new'`,
            [paperId, questionId, result, score, gradedAgo, errorTypes]);
        assert.equal(r.rowCount, 1);
    }

    const chapterTarget = (over = {}) => ({
        unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial',
        baseline: { graded: 6, wrong: 5, wrong_rate: 0.8333, low_sample: false }, ...over
    });

    const remedialPaper = (studentId, body) => request(app).post(`/api/students/${studentId}/remedial-paper`).send(body);
    const effect = (studentId, qs = '') => request(app).get(`/api/students/${studentId}/remedial-effect${qs}`);
    const ONLY_REMEDIAL = { subject: '數學', total: 5, mix: { remedial: 1, prerequisite: 0, extension: 0 } };

    async function footprint() {
        const { rows: [c] } = await query(`SELECT (SELECT COUNT(*) FROM exam_papers)::int AS papers, (SELECT COUNT(*) FROM assignments)::int AS assignments`);
        return c;
    }

    describe('補救成效追蹤（〔dec/r16-remedial〕）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });
        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
        });
        after(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions, knowledge_components RESTART IDENTITY CASCADE');
            await pool.end();
        });

        // ───────────────────────── migration ─────────────────────────
        test('migration 0022：kind 預設 normal、CHECK 擋其他值；targets 只有 remedial 能有、必須是陣列；再套一次不動', async () => {
            const { rows } = await query(
                `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                  WHERE table_name = 'exam_papers' AND column_name IN ('kind', 'targets') AND table_schema = current_schema()
                  ORDER BY column_name`);
            assert.deepEqual(rows.map(r => [r.column_name, r.data_type, r.is_nullable]), [['kind', 'text', 'NO'], ['targets', 'jsonb', 'YES']]);
            assert.match(rows[0].column_default, /'normal'/);
            const s = await addStudent();
            const { rows: [old] } = await query(`INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('舊寫法', $1, '{}') RETURNING kind, targets`, [s]);
            assert.deepEqual(old, { kind: 'normal', targets: null }, '沒帶 kind 的 INSERT（一般組卷）照舊是 normal');
            await query(MIGRATION);
            await query(MIGRATION);
            assert.equal((await query('SELECT COUNT(*)::int AS n FROM exam_papers')).rows[0].n, 1, '再套一次不動資料');
            const bad = [
                [`'other'`, 'NULL', /exam_papers_kind_check/],
                [`'normal'`, `'[]'::jsonb`, /exam_papers_targets_kind_check/],
                [`'remedial'`, `'{}'::jsonb`, /exam_papers_targets_kind_check/]
            ];
            for (const [kind, targets, re] of bad) {
                await assert.rejects(() => query(`INSERT INTO exam_papers (title, student_id, question_ids, kind, targets) VALUES ('x', $1, '{}', ${kind}, ${targets})`, [s]),
                    err => err.code === '23514' && re.test(err.message));
            }
            for (const kind of ['remedial', 'retrain']) {
                await query(`INSERT INTO exam_papers (title, student_id, question_ids, kind) VALUES ('x', $1, '{}', $2)`, [s, kind]);
            }
        });

        // ───────────────────────── confirm-paper ─────────────────────────
        describe('POST /api/confirm-paper × kind／targets', () => {
            test('補救卷：草稿的 targets 原樣存進 exam_papers（kind = remedial）；回應形狀不變', async () => {
                const s = await addStudent();
                await wrongHistory(s, await addMany(4, { difficulty: 3 }), [['concept'], ['concept'], ['concept'], []]);
                await addMany(5, { type: '單選', difficulty: 2 });
                const draft = await remedialPaper(s, ONLY_REMEDIAL);
                const res = await request(app).post('/api/confirm-paper')
                    .send({ student_id: s, question_ids: draft.body.question_ids, kind: 'remedial', targets: draft.body.targets });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['message', 'paper_id', 'paper_title', 'question_ids', 'questions']);
                const { rows: [p] } = await query('SELECT kind, targets FROM exam_papers WHERE id = $1', [res.body.paper_id]);
                assert.equal(p.kind, 'remedial');
                assert.deepEqual(p.targets, draft.body.targets);
            });

            test('不合法的 targets → 400，卷與派題都沒寫', async () => {
                const s = await addStudent();
                const qs = await addMany(2);
                const before = await footprint();
                const bad = [
                    [{ kind: 'remedial', targets: [chapterTarget({ name: '向量內積' })] }, /不認得的鍵：name/],
                    [{ kind: 'remedial', targets: [chapterTarget({ chapter: '不存在的章' })] }, /章節白名單/],
                    [{ kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 1, wrong: 2, wrong_rate: 1, low_sample: true } })] }, /baseline\.wrong/],
                    [{ kind: 'remedial' }, /targets 必填/],
                    [{ targets: [chapterTarget()] }, /只能搭配 kind/],
                    [{ kind: 'retrain', targets: [chapterTarget()] }, /kind 只接受/],
                    [{ kind: 'remedial', targets: 'all' }, /targets 必須是/]
                ];
                for (const [extra, re] of bad) {
                    const res = await request(app).post('/api/confirm-paper').send({ student_id: s, question_ids: qs, ...extra });
                    assert.equal(res.status, 400, JSON.stringify(extra));
                    assert.match(res.body.message, re);
                }
                assert.deepEqual(await footprint(), before);
            });

            test('一般卷：kind = normal、targets 為 NULL；純重練卷：kind = retrain', async () => {
                const s = await addStudent();
                const [q1] = await addMany(1);
                const normal = await request(app).post('/api/confirm-paper').send({ student_id: s, question_ids: [q1] });
                assert.equal(normal.status, 200, JSON.stringify(normal.body));
                assert.deepEqual((await query('SELECT kind, targets FROM exam_papers WHERE id = $1', [normal.body.paper_id])).rows[0], { kind: 'normal', targets: null });

                // q1 已寫過且答錯；放進錯題重練清單（到期），再出一張只有它的卷
                await grade(normal.body.paper_id, q1, 0);
                const { rows: [a] } = await query(`SELECT id FROM assignments WHERE student_id = $1 AND question_id = $2 AND purpose = 'new'`, [s, q1]);
                await query(`INSERT INTO retrain_items (student_id, question_id, source_assignment_id, reason, entered_on, due_on)
                             VALUES ($1, $2, $3, 'manual', CURRENT_DATE - 3, CURRENT_DATE - 1)`, [s, q1, a.id]);
                const saved = process.env.FEATURE_RETRAIN;
                process.env.FEATURE_RETRAIN = 'true';
                try {
                    const pure = await request(app).post('/api/confirm-paper').send({ student_id: s, question_ids: [q1], retrain_question_ids: [q1] });
                    assert.equal(pure.status, 200, JSON.stringify(pure.body));
                    assert.match(pure.body.paper_title, /錯題重練卷/);
                    assert.equal((await query('SELECT kind FROM exam_papers WHERE id = $1', [pure.body.paper_id])).rows[0].kind, 'retrain');
                } finally {
                    if (saved === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = saved;
                }
            });
        });

        // ───────────────────────── 補救成效 ─────────────────────────
        describe('GET /api/students/:id/remedial-effect', () => {
            test('旗標關閉 404；:id 不合法或學生不存在 404；limit／days 不合法 400', async () => {
                const s = await addStudent();
                assert.equal((await request(appDisabled).get(`/api/students/${s}/remedial-effect`)).status, 404);
                assert.equal((await effect('abc')).status, 404);
                assert.equal((await effect(999)).status, 404);
                const bad = await effect(s, '?limit=0');
                assert.equal(bad.status, 400);
                assert.equal(bad.body.message, 'limit 必須是 1~50 的整數。');
                assert.equal((await effect(s, '?days=400')).status, 400);
                const empty = await effect(s);
                assert.equal(empty.status, 200);
                assert.deepEqual(empty.body, { student_id: s, limit: 10, days: null, papers: [],
                    thresholds: { improved_delta: 0.1, worse_delta: -0.1, min_after_graded: 2, min_n: 5 } });
            });

            /**
             * 進步的情境：補救卷 10 天前建、9 天前批改完（1 對 1 錯）；
             *   9.5 天前另一張卷（補救卷批改完之前建的）兩題都錯 → 不算 after；
             *   5 天前的卷：向量內積 3 題全對（算 after）、排列 1 題錯（別的單位，不算）、一題重練作答錯（R10，不算）。
             */
            async function improvedScenario() {
                const s = await addStudent();
                const k1 = await addKc('MATH.向量內積.02', { name: '內積的坐標算法' });
                const [r1, r2] = await addMany(2);
                await tag(r1, k1);
                const p1 = await paper(s, [r1, r2], { kind: 'remedial', createdAgo: '10 days',
                    targets: [chapterTarget({ error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } }),
                        { unit_type: 'kc', subject: '數學', chapter: '向量內積', kc_id: k1, bucket: 'remedial', baseline: { graded: 2, wrong: 2, wrong_rate: 1, low_sample: true } },
                        chapterTarget({ chapter: '排列', bucket: 'extension', baseline: { graded: 3, wrong: 0, wrong_rate: 0, low_sample: true } })] });
                await grade(p1, r1, 1, { gradedAgo: '9 days' });
                await grade(p1, r2, 0, { gradedAgo: '9 days' });

                const [m1, m2] = await addMany(2);
                const p0 = await paper(s, [m1, m2], { createdAgo: '9 days 12 hours' });
                await grade(p0, m1, 0, { gradedAgo: '8 days' });
                await grade(p0, m2, 0, { gradedAgo: '8 days' });

                const later = await addMany(3);
                await tag(later[0], k1, 0.5);
                const perm = await addQ({ chapter: '排列' });
                const p2 = await paper(s, [...later, perm], { createdAgo: '5 days' });
                for (const q of later) await grade(p2, q, 1, { gradedAgo: '4 days' });
                await grade(p2, perm, 0, { gradedAgo: '4 days' });
                // 重練作答（R10）：m1 在 5 天前的另一張卷上重練、又錯
                const p3 = await paper(s, [], { createdAgo: '5 days' });
                await insertAttempts(query, [{ student_id: s, question_id: m1, paper_id: p3, purpose: 'retrain', result: 0, graded_at: 'now' }]);
                return { s, p1, k1 };
            }

            test('improved：補救前 → 之後、這張卷、只算補救卷批改完之後建立的卷、R10、知識點加權；延伸組不列', async () => {
                const { s, p1, k1 } = await improvedScenario();
                const res = await effect(s);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.papers.length, 1, '只列補救卷');
                const p = res.body.papers[0];
                assert.deepEqual([p.paper_id, p.graded, p.assigned_count, p.graded_count], [p1, true, 2, 2]);
                assert.deepEqual(p.targets.map(t => [t.unit_type, t.name, t.bucket]), [['chapter', '向量內積', 'remedial'], ['kc', '內積的坐標算法', 'remedial']]);
                const [ch, kc] = p.targets;
                assert.deepEqual(ch, {
                    unit_type: 'chapter', subject: '數學', chapter: '向量內積', name: '向量內積', bucket: 'remedial',
                    error_focus: { type: 'concept', count: 3, share: 0.75, applied: true, label: '觀念不清' },
                    before: { graded: 6, wrong: 5, wrong_rate: 0.8333, correct_rate: 0.1667, low_sample: false },
                    on_paper: { assigned: 2, graded: 2, correct: 1, rate: 0.5 },
                    after: { graded: 3, correct: 3, rate: 1, papers: 1 },
                    delta: 0.8333, low_sample: true, status: 'improved'
                });
                // 知識點：這張卷上 r1（權重 1、對）；之後 later[0]（權重 0.5、對）——加權後之後只有 0.5 題 → 資料不足
                assert.equal(kc.kc_id, k1);
                assert.equal(kc.code, 'MATH.向量內積.02');
                assert.deepEqual([kc.on_paper, kc.after, kc.before.correct_rate, kc.delta, kc.status],
                    [{ assigned: 1, graded: 1, correct: 1, rate: 1 }, { graded: 0.5, correct: 0.5, rate: 1, papers: 1 }, 0, 1, 'insufficient_data']);
            });

            test('days 時間窗：只看補救卷批改完之後 3 天內建立的卷 → 5 天前那張不算 → insufficient_data', async () => {
                const { s } = await improvedScenario();
                const res = await effect(s, '?days=3');
                assert.equal(res.status, 200);
                assert.equal(res.body.days, 3);
                const ch = res.body.papers[0].targets[0];
                assert.deepEqual([ch.after, ch.delta, ch.status], [{ graded: 0, correct: 0, rate: null, papers: 0 }, null, 'insufficient_data']);
            });

            test('worse、insufficient_data（之後只批改 1 題）、pending（補救卷還沒批改完）；新到舊、limit', async () => {
                const s = await addStudent();
                // 最舊：退步——補救前答對率 0.8，之後 3 題全錯（部分給分 0.5 一題）
                const [a1] = await addMany(1);
                const pw = await paper(s, [a1], { kind: 'remedial', createdAgo: '20 days',
                    targets: [chapterTarget({ baseline: { graded: 5, wrong: 1, wrong_rate: 0.2, low_sample: false } })] });
                await grade(pw, a1, 1, { gradedAgo: '19 days' });
                const after1 = await addMany(3);
                const pa = await paper(s, after1, { createdAgo: '18 days' });
                await grade(pa, after1[0], 0, { gradedAgo: '17 days' });
                await grade(pa, after1[1], 0, { gradedAgo: '17 days' });
                await grade(pa, after1[2], 0, { score: 0.5, gradedAgo: '17 days' });

                // 中間：資料不足——排列，之後只批改 1 題（另一題沒批改）
                const [b1] = await addMany(1, { chapter: '排列' });
                const pi = await paper(s, [b1], { kind: 'remedial', createdAgo: '15 days',
                    targets: [chapterTarget({ chapter: '排列', baseline: { graded: 4, wrong: 4, wrong_rate: 1, low_sample: true } })] });
                await grade(pi, b1, 0, { gradedAgo: '14 days' });
                const after2 = await addMany(2, { chapter: '排列' });
                const pb = await paper(s, after2, { createdAgo: '13 days' });
                await grade(pb, after2[0], 1, { gradedAgo: '12 days' });

                // 最新：還沒批改完（兩題只批了一題）
                const c = await addMany(2, { chapter: '實數' });
                const pp = await paper(s, c, { kind: 'remedial', createdAgo: '2 days',
                    targets: [chapterTarget({ chapter: '實數', baseline: { graded: 3, wrong: 2, wrong_rate: 0.6667, low_sample: true } })] });
                await grade(pp, c[0], 1, { gradedAgo: '1 day' });

                const res = await effect(s);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(res.body.papers.map(p => p.paper_id), [pp, pi, pw], '新到舊');
                const [pend, insuf, worse] = res.body.papers.map(p => p.targets[0]);
                assert.equal(res.body.papers[0].graded, false);
                assert.deepEqual([pend.status, pend.on_paper], ['pending', { assigned: 2, graded: 1, correct: 1, rate: 1 }]);
                assert.deepEqual([insuf.status, insuf.after.graded, insuf.after.rate, insuf.delta, insuf.low_sample], ['insufficient_data', 1, 1, 1, true]);
                assert.deepEqual([worse.status, worse.before.correct_rate, worse.after, worse.delta],
                    ['worse', 0.8, { graded: 3, correct: 0.5, rate: 0.1667, papers: 1 }, -0.6333]);

                const one = await effect(s, '?limit=1');
                assert.deepEqual(one.body.papers.map(p => p.paper_id), [pp]);
            });

            test('從草稿一路到成效：依錯因出的補救卷確認 → 批改 → 之後的卷 → 補救成效看得到錯因與狀態', async () => {
                const s = await addStudent();
                await wrongHistory(s, await addMany(4, { difficulty: 3 }), [['concept'], ['concept'], ['concept'], []]);
                await addMany(5, { type: '單選', difficulty: 2 });
                const draft = await remedialPaper(s, ONLY_REMEDIAL);
                const conf = await request(app).post('/api/confirm-paper')
                    .send({ student_id: s, question_ids: draft.body.question_ids, kind: 'remedial', targets: draft.body.targets });
                assert.equal(conf.status, 200, JSON.stringify(conf.body));
                let res = await effect(s);
                assert.deepEqual(res.body.papers[0].targets.map(t => t.status), ['pending']);

                for (const q of conf.body.question_ids) await grade(conf.body.paper_id, q, 1, { gradedAgo: '1 hour' });
                const later = await addMany(2, { difficulty: 2 });
                const pl = await paper(s, later, { createdAgo: '10 minutes' });
                for (const q of later) await grade(pl, q, 1);
                res = await effect(s);
                const t = res.body.papers[0].targets[0];
                assert.deepEqual([t.status, t.before.correct_rate, t.on_paper.rate, t.after.rate, t.after.graded, t.low_sample, t.error_focus.label],
                    ['improved', 0, 1, 1, 2, true, '觀念不清']);
            });
        });
    });
}
