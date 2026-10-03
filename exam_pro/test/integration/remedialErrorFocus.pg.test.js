// ─────────────────────────────────────────────────────────────
// remedialErrorFocus.pg.test.js — 補救卷依錯因出題的整合測試（〔dec/r16-remedial〕；docs/remedial.md 第 9 節）
//
// 涵蓋 POST /api/students/:id/remedial-paper 的補救組：
//   主因套用（降難度上限＋偏好題型，連抽 6 次都成立）、同票不套用、沒標錯因時 error_focus 為 null 且 rationale 逐字同前、
//   R10（重練作答的錯因不算）、降了上限抽不滿退回原本的上限（notes）、退回也不夠時照實回報、知識點基底；草稿不寫庫。
//
// 題目內容全為自製。三道防線同 remedial.pg.test.js：只讀 TEST_DATABASE_URL、庫名須 _test 結尾、require config/db 前覆寫 DATABASE_URL。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('依錯因出題整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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

    /** routes/index.js 在 require 當下讀旗標：清快取、開旗標載入（同 remedial.pg.test.js）。 */
    function loadApp() {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_REMEDIAL;
        process.env.FEATURE_REMEDIAL = 'true';
        try {
            return require(APP_PATH);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_REMEDIAL;
            else process.env.FEATURE_REMEDIAL = saved;
        }
    }
    const app = loadApp();
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { insertAttempts } = require(path.join(APP_DIR, 'test', 'helpers', 'attempts'));

    // ─────────────────── fixture 輔助 ───────────────────
    let seq = 0;

    async function addQ({ subject = '數學', chapter = '向量內積', difficulty = 3, type = '計算', text = null } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ($1, $2, $3, $4, $5, '自製答案') RETURNING id`,
            [subject, chapter, type, difficulty, text ?? `自製錯因出題測試題 ${++seq}：設 $x=${seq}$，求 $3x$。`]
        );
        return r.id;
    }
    async function addMany(n, opts) {
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(await addQ(opts));
        return ids;
    }
    async function addStudent() {
        const { rows: [r] } = await query('INSERT INTO students (name) VALUES ($1) RETURNING id', [`錯因出題測試生${++seq}`]);
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

    const remedialPaper = (studentId, body) => request(app).post(`/api/students/${studentId}/remedial-paper`).send(body);
    const ONLY_REMEDIAL = { subject: '數學', total: 5, mix: { remedial: 1, prerequisite: 0, extension: 0 } };

    async function footprint() {
        const { rows: [c] } = await query(`SELECT (SELECT COUNT(*) FROM exam_papers)::int AS papers, (SELECT COUNT(*) FROM assignments)::int AS assignments`);
        return c;
    }

    describe('補救卷依錯因出題（〔dec/r16-remedial〕）', () => {
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

        // ───────────────────────── 依錯因出題 ─────────────────────────
        describe('POST /api/students/:id/remedial-paper × 錯因', () => {
            /** 向量內積的 4 題歷史錯題（難度 3：上限 ⌊3+1⌋ = 4）；錯因由呼叫端給。 */
            async function history(s, errorTypes) {
                await wrongHistory(s, await addMany(4, { difficulty: 3 }), errorTypes);
            }

            test('主因「觀念不清」：難度上限 4 → 3、單選先抽滿、上限外的題不抽；blueprint 的 error_focus、rationale、targets 快照', async () => {
                const s = await addStudent();
                await history(s, [['concept'], ['concept'], ['concept', 'calc'], []]);
                const choice = await addMany(3, { type: '單選', difficulty: 2 });
                const calc = await addMany(3, { type: '計算', difficulty: 3 });
                const hard = await addMany(3, { type: '填空', difficulty: 4 });
                for (let i = 0; i < 6; i++) {
                    const res = await remedialPaper(s, ONLY_REMEDIAL);
                    assert.equal(res.status, 200, JSON.stringify(res.body));
                    const ids = res.body.question_ids;
                    assert.equal(ids.length, 5);
                    assert.ok(choice.every(id => ids.includes(id)), `觀念檢查題先抽滿：${ids}`);
                    assert.equal(ids.filter(id => calc.includes(id)).length, 2);
                    assert.ok(!ids.some(id => hard.includes(id)), '降了上限，難度 4 不抽（硬條件）');
                    const b = res.body.blueprint[0];
                    assert.equal(b.difficulty_max, 3);
                    assert.deepEqual([b.error_focus.type, b.error_focus.label, b.error_focus.count, b.error_focus.share, b.error_focus.tagged_wrong, b.error_focus.applied, b.error_focus.reason],
                        ['concept', '觀念不清', 3, 0.75, 3, true, 'dominant']);
                    assert.equal(b.error_focus.strategy.summary, '難度上限降一級，優先單選／多選／填空');
                    assert.match(b.rationale, /錯因以「觀念不清」為主（有標錯因的錯題 3 題，標了 3 次，占 75%）→ 難度上限降一級/);
                    assert.deepEqual(res.body.shortfalls, []);
                    assert.deepEqual(res.body.targets, [{ unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial',
                        baseline: { graded: 4, wrong: 4, wrong_rate: 1, low_sample: true },
                        error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } }]);
                }
                assert.deepEqual(await footprint(), { papers: 0, assignments: 4 }, '草稿不寫庫');
            });

            test('同票不套用：難度上限照舊、error_focus.applied = false；完全沒標錯因：error_focus 為 null、rationale 不提錯因', async () => {
                const s = await addStudent();
                await history(s, [['concept'], ['calc'], ['concept'], ['calc']]);
                await addMany(6, { difficulty: 4 });
                const tie = await remedialPaper(s, ONLY_REMEDIAL);
                assert.equal(tie.status, 200, JSON.stringify(tie.body));
                const b = tie.body.blueprint[0];
                assert.equal(b.difficulty_max, 4);
                assert.deepEqual([b.error_focus.applied, b.error_focus.reason, b.error_focus.strategy], [false, 'tie', null]);
                assert.match(b.rationale, /看不出主因，選題不依錯因調整；選難度 ≤ 4 的題$/);
                assert.equal(tie.body.question_ids.length, 5);

                const u = await addStudent();
                await history(u, [[], [], [], []]);
                const plain = await remedialPaper(u, ONLY_REMEDIAL);
                const pb = plain.body.blueprint[0];
                assert.equal(pb.error_focus, null);
                assert.equal(pb.rationale, '掌握度下界 0%（批改 4 題、答對 0）；選難度 ≤ 4 的題');
                assert.ok(!('error_focus' in plain.body.targets[0]));
            });

            test('R10：重練作答的錯因不算——第一次作答只有 1 題標錯因 → 證據不夠，不套用', async () => {
                const s = await addStudent();
                const hist = await addMany(4, { difficulty: 3 });
                await wrongHistory(s, hist, [['concept'], [], [], []]);
                // 同一題重練了三次，都標「觀念不清」：若算進去就是 4 筆、全是 concept
                await insertAttempts(query, [hist[1], hist[2], hist[3]].map(q => ({
                    student_id: s, question_id: q, purpose: 'retrain', days_ago: 1, result: 0, graded_at: 'now', error_types: ['concept']
                })));
                await addMany(6, { difficulty: 4 });
                const res = await remedialPaper(s, ONLY_REMEDIAL);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                const ef = res.body.blueprint[0].error_focus;
                assert.deepEqual([ef.tagged_wrong, ef.count, ef.applied, ef.reason], [1, 1, false, 'insufficient_evidence']);
                assert.equal(res.body.blueprint[0].difficulty_max, 4);
            });

            test('降了上限抽不滿：退回原本的上限（偏好照舊）、notes 說明、blueprint 回報實際的上限', async () => {
                const s = await addStudent();
                await history(s, [['concept'], ['concept'], ['concept'], []]);
                const easy = await addQ({ type: '單選', difficulty: 3 });
                const hard = await addMany(4, { type: '計算', difficulty: 4 });
                const res = await remedialPaper(s, ONLY_REMEDIAL);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual([...res.body.question_ids].sort((a, b) => a - b), [easy, ...hard].sort((a, b) => a - b));
                const b = res.body.blueprint[0];
                assert.deepEqual([b.got, b.difficulty_max, b.error_focus.applied, b.error_focus.reason], [5, 4, true, 'dominant_difficulty_fallback']);
                assert.match(b.rationale, /難度 ≤ 3 的題不夠，改選難度 ≤ 4 的題$/);
                assert.ok(res.body.notes.includes('「向量內積」錯因以「觀念不清」為主，原本只選難度 ≤ 3 的題，但湊不到 5 題，已改回難度 ≤ 4（題型偏好照舊）。'),
                    res.body.notes.join('\n'));
                assert.deepEqual(res.body.shortfalls, []);
            });

            test('降了上限、退回也不夠：照實回報不足量（不會因策略少出題）', async () => {
                const s = await addStudent();
                await history(s, [['blank'], ['blank'], ['time'], []]);
                const pool = [await addQ({ difficulty: 3 }), await addQ({ difficulty: 4 })];
                const res = await remedialPaper(s, ONLY_REMEDIAL);
                assert.deepEqual([...res.body.question_ids].sort((a, b) => a - b), pool);
                assert.deepEqual(res.body.shortfalls.map(x => [x.wanted, x.got, x.reason]), [[5, 2, 'insufficient_stock']]);
                assert.equal(res.body.blueprint[0].error_focus.reason, 'dominant_difficulty_fallback');
            });

            test('知識點基底：錯因以知識點為單位計算，快照帶 kc_id', async () => {
                const s = await addStudent();
                const k1 = await addKc('MATH.向量內積.01', { name: '內積的意義' });
                const hist = await addMany(5, { difficulty: 2 });
                for (const q of hist) await tag(q, k1);
                await wrongHistory(s, hist, [['calc'], ['calc'], ['calc'], ['careless'], []]);
                const pool = await addMany(2, { type: '單選', difficulty: 2 });
                const calc = await addMany(2, { type: '計算', difficulty: 2 });
                for (const q of [...pool, ...calc]) await tag(q, k1);
                const res = await remedialPaper(s, { ...ONLY_REMEDIAL, total: 5 });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.basis, 'kc');
                const b = res.body.blueprint[0];
                assert.deepEqual([b.target.code, b.error_focus.type, b.error_focus.count, b.error_focus.applied], ['MATH.向量內積.01', 'calc', 3, true]);
                assert.deepEqual(res.body.targets[0], { unit_type: 'kc', subject: '數學', chapter: '向量內積', kc_id: k1, bucket: 'remedial',
                    baseline: { graded: 5, wrong: 5, wrong_rate: 1, low_sample: false }, error_focus: { type: 'calc', count: 3, share: 0.75, applied: true } });
            });
        });

    });
}
