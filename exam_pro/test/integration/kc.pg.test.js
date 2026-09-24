// ─────────────────────────────────────────────────────────────
// kc.pg.test.js — 知識點四支 API 的整合測試（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 2 點）
//
// 三道防線與 students.pg.test.js 相同：
//   1. 只讀 process.env.TEST_DATABASE_URL，本檔絕不 require('dotenv')；npm test 不連 DB，整支 skip。
//   2. 資料庫名必須以 `_test` 結尾。
//   3. 在 require config/db.js **之前**覆寫 DATABASE_URL。
//
// 資料：test/fixtures/kc/ 的兩份小型種子檔（數學兩章、物理兩章），以 kcService.loadSeeds
// 限定白名單載入——不假設 KC 內容組的 config/kc/*.json 存在（第 2 條末：不假設別組已寫入資料）。
// 每個案例前 TRUNCATE … RESTART IDENTITY，id 從 1 開始。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('知識點 API 整合測試（需要 PostgreSQL）', {
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
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /**
     * routes/index.js 在 require 當下讀 FEATURE_KC（關閉時不掛載）。要同一個行程驗「開」與「關」，
     * 只能清掉 app.js 與 routes/index.js 的快取再讀一次；config/db.js 的快取不清（連線池只有一個）。
     * 每次重讀也順便拿到一個新的限流桶（120/min）。
     */
    function loadApp(flag) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_KC;
        process.env.FEATURE_KC = flag;
        try {
            return require(APP_PATH);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_KC; else process.env.FEATURE_KC = saved;
        }
    }

    const appOff = loadApp('false');
    let app = loadApp('true');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const kc = require(path.join(APP_DIR, 'services', 'kcService'));

    const FIX = path.join(APP_DIR, 'test', 'fixtures', 'kc');
    const readSeed = name => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
    const CHAPTERS = { '數學': ['向量的加減與係數積', '向量內積'], '物理': ['功與動能', '位能與能量守恆'] };
    const ITEM_KEYS = ['id', 'code', 'subject', 'chapter', 'name', 'curriculum_code', 'description',
        'spoken_text', 'status', 'sort', 'prereqs', 'question_count'].sort();
    const SPOKEN = '有坐標就不用管角度：x 跟 x 乘、y 跟 y 乘，全部加起來。三維就多加一個 z 乘 z。記得算出來是一個數字，不是向量。';

    /** 依 code 查 id（id 由載入順序決定，測試一律用 code 對照） */
    async function idOf(code) {
        const { rows: [r] } = await query('SELECT id FROM knowledge_components WHERE code = $1', [code]);
        return r.id;
    }

    /** 灌題目，回 id 陣列（題幹與答案皆為自編） */
    async function seedQuestions(list) {
        const ids = [];
        for (const q of list) {
            const { rows: [r] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, archived_at)
                 VALUES ($1, $2, '計算', 3, $3, '略', $4) RETURNING id`,
                [q.subject, q.chapter, q.text || `自製整合測試題（${q.chapter}）`, q.archived ? new Date() : null]);
            ids.push(r.id);
        }
        return ids;
    }

    async function tag(questionId, code, src = 'ai', confidence = 0.9, weight = 1) {
        await query(`INSERT INTO question_kcs (question_id, kc_id, weight, src, confidence) VALUES ($1, $2, $3, $4, $5)`,
            [questionId, await idOf(code), weight, src, src === 'ai' ? confidence : null]);
    }

    describe('知識點 API（FEATURE_KC）', () => {
        let Q;   // { vec, add, work, archived, real }

        before(async () => {
            await query('SELECT 1');
        });

        beforeEach(async () => {
            await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
            const res = await kc.loadSeeds({ pool, query }, [readSeed('數學'), readSeed('物理')], { chapters: CHAPTERS });
            assert.equal(res.ok, true, res.errors.join('\n'));
            const [vec, add, work, archived, real] = await seedQuestions([
                { subject: '數學', chapter: '向量內積' },
                { subject: '數學', chapter: '向量的加減與係數積' },
                { subject: '物理', chapter: '功與動能' },
                { subject: '數學', chapter: '向量內積', archived: true },
                { subject: '數學', chapter: '實數' }
            ]);
            Q = { vec, add, work, archived, real };
        });

        after(async () => {
            await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
            await pool.end();
        });

        // ───────────── 旗標 ─────────────
        test('FEATURE_KC 關閉：四支都不掛載（Express 預設 404）', async () => {
            await request(appOff).get('/api/kc').expect(404);
            await request(appOff).patch('/api/kc/1').send({ name: 'x' }).expect(404);
            await request(appOff).get(`/api/questions/${Q.vec}/kcs`).expect(404);
            await request(appOff).put(`/api/questions/${Q.vec}/kcs`).send({ items: [] }).expect(404);
        });

        // ───────────── GET /api/kc ─────────────
        test('GET /api/kc：欄位照契約，依白名單的科目、章節順序與 sort 排序', async () => {
            const res = await request(app).get('/api/kc').expect(200);
            const { items } = res.body;
            assert.equal(items.length, 15);
            assert.deepEqual(Object.keys(items[0]).sort(), ITEM_KEYS);
            // fixture 裡「向量內積」寫在前面，但白名單順序是「向量的加減與係數積」在前
            assert.deepEqual(items.map(i => i.code), [
                'MATH.向量的加減與係數積.01', 'MATH.向量的加減與係數積.02', 'MATH.向量的加減與係數積.03',
                'MATH.向量內積.01', 'MATH.向量內積.02', 'MATH.向量內積.03', 'MATH.向量內積.04', 'MATH.向量內積.05', 'MATH.向量內積.06',
                'PHYS.功與動能.01', 'PHYS.功與動能.02', 'PHYS.功與動能.03',
                'PHYS.位能與能量守恆.01', 'PHYS.位能與能量守恆.02', 'PHYS.位能與能量守恆.03'
            ]);
        });

        test('prereqs 帶 { id, code, name, subject, chapter }，跨科的也在', async () => {
            const { body } = await request(app).get('/api/kc?subject=物理').expect(200);
            const work = body.items.find(i => i.code === 'PHYS.功與動能.01');
            assert.deepEqual(work.prereqs, [{
                id: await idOf('MATH.向量內積.01'), code: 'MATH.向量內積.01', name: '內積的意義', subject: '數學', chapter: '向量內積'
            }]);
            const mech = body.items.find(i => i.code === 'PHYS.位能與能量守恆.02');
            assert.deepEqual(mech.prereqs.map(p => p.code), ['PHYS.功與動能.02', 'PHYS.位能與能量守恆.01']);
        });

        test('question_count 只數未封存的題', async () => {
            await tag(Q.vec, 'MATH.向量內積.02');
            await tag(Q.archived, 'MATH.向量內積.02');
            await tag(Q.add, 'MATH.向量內積.02', 'human');
            const { body } = await request(app).get('/api/kc?subject=數學&chapter=向量內積').expect(200);
            assert.equal(body.items.find(i => i.code === 'MATH.向量內積.02').question_count, 2);
            assert.equal(body.items.find(i => i.code === 'MATH.向量內積.01').question_count, 0);
        });

        test('篩選：subject、chapter、status，以及組合', async () => {
            const count = async (qs) => (await request(app).get(`/api/kc${qs}`).expect(200)).body.items.length;
            assert.equal(await count('?subject=物理'), 6);
            assert.equal(await count('?subject=數學&chapter=向量內積'), 6);
            assert.equal(await count('?chapter=功與動能'), 3);
            assert.equal(await count('?status=approved'), 4);
            assert.equal(await count('?subject=物理&status=approved'), 0);
            assert.equal(await count(`?subject=${encodeURIComponent('數學')}&status=draft`), 5);
        });

        test('GET /api/kc 參數不合法 → 400 { message }', async () => {
            for (const qs of ['?subject=生物', '?subject=數學&chapter=功與動能', '?chapter=不存在', '?status=published',
                '?subject=數學&subject=物理']) {
                const res = await request(app).get(`/api/kc${encodeURI(qs)}`).expect(400);
                assert.equal(typeof res.body.message, 'string', qs);
            }
        });

        // ───────────── PATCH /api/kc/:id ─────────────
        test('PATCH：更新口語版並審定，回更新後的列（同 GET 形狀），updated_at 前進', async () => {
            const id = await idOf('MATH.向量內積.01');
            const { rows: [before] } = await query('SELECT updated_at FROM knowledge_components WHERE id = $1', [id]);
            const spoken = `  ${SPOKEN}（老師改寫）  `;
            const res = await request(app).patch(`/api/kc/${id}`).send({ spoken_text: spoken, status: 'approved' }).expect(200);
            assert.deepEqual(Object.keys(res.body).sort(), ITEM_KEYS);
            assert.equal(res.body.spoken_text, spoken.trim());
            assert.equal(res.body.status, 'approved');
            assert.equal(res.body.prereqs.length, 1);
            const { rows: [row] } = await query('SELECT spoken_text, status, updated_at FROM knowledge_components WHERE id = $1', [id]);
            assert.equal(row.status, 'approved');
            assert.ok(row.updated_at > before.updated_at, 'updated_at 沒有更新');
        });

        test('PATCH：curriculum_code 可以設定、也可以清成 null；名稱與說明可改', async () => {
            const id = await idOf('MATH.向量內積.03');
            let res = await request(app).patch(`/api/kc/${id}`).send({ curriculum_code: 'N-11A-2', name: '夾角與垂直判定', description: '新說明' }).expect(200);
            assert.equal(res.body.curriculum_code, 'N-11A-2');
            assert.equal(res.body.name, '夾角與垂直判定');
            res = await request(app).patch(`/api/kc/${id}`).send({ curriculum_code: null }).expect(200);
            assert.equal(res.body.curriculum_code, null);
            assert.equal(res.body.name, '夾角與垂直判定', '沒送的欄位不動');
        });

        test('PATCH 驗證失敗 → 400；不存在 → 404；資料庫不變', async () => {
            const id = await idOf('MATH.向量內積.01');
            const bad = [
                { name: 'x'.repeat(31) }, { name: '' }, { description: 'x'.repeat(201) },
                { spoken_text: '太短' }, { spoken_text: `${SPOKEN}$\\vec a$` }, { status: 'published' },
                { spokenText: SPOKEN }, { code: 'MATH.向量內積.99' }, {}
            ];
            for (const body of bad) {
                const res = await request(app).patch(`/api/kc/${id}`).send(body).expect(400);
                assert.ok(res.body.message, JSON.stringify(body));
            }
            await request(app).patch('/api/kc/abc').send({ name: 'x' }).expect(400);
            await request(app).patch('/api/kc/0').send({ name: 'x' }).expect(400);
            const nf = await request(app).patch('/api/kc/99999').send({ name: 'x' }).expect(404);
            assert.equal(nf.body.message, '找不到該知識點。');
            const { rows: [row] } = await query('SELECT name, status FROM knowledge_components WHERE id = $1', [id]);
            assert.deepEqual(row, { name: '內積的意義', status: 'draft' });
        });

        test('PATCH：同一章改成已存在的名稱 → 400（UNIQUE (subject, chapter, name)）', async () => {
            const id = await idOf('MATH.向量內積.01');
            const res = await request(app).patch(`/api/kc/${id}`).send({ name: '正射影' }).expect(400);
            assert.ok(res.body.message.includes('同名'));
            // 別章同名是可以的
            await request(app).patch(`/api/kc/${await idOf('PHYS.功與動能.03')}`).send({ name: '正射影' }).expect(200);
        });

        // ───────────── GET /api/questions/:id/kcs ─────────────
        test('GET /api/questions/:id/kcs：沒標註是 []；有標註回 [{ kc_id, code, name, weight, src, confidence }]', async () => {
            let res = await request(app).get(`/api/questions/${Q.vec}/kcs`).expect(200);
            assert.deepEqual(res.body, []);
            await tag(Q.vec, 'MATH.向量內積.02', 'ai', 0.8);
            await tag(Q.vec, 'MATH.向量內積.05', 'ai', 0.7, 0.5);
            res = await request(app).get(`/api/questions/${Q.vec}/kcs`).expect(200);
            assert.deepEqual(res.body, [
                { kc_id: await idOf('MATH.向量內積.02'), code: 'MATH.向量內積.02', name: '內積的坐標算法', weight: 1, src: 'ai', confidence: 0.8 },
                { kc_id: await idOf('MATH.向量內積.05'), code: 'MATH.向量內積.05', name: '長度平方與展開', weight: 0.5, src: 'ai', confidence: 0.7 }
            ]);
        });

        test('GET …/kcs?detail=1：附上題目資訊（前端小工具用）；封存的題也查得到', async () => {
            const res = await request(app).get(`/api/questions/${Q.archived}/kcs?detail=1`).expect(200);
            assert.deepEqual(Object.keys(res.body).sort(), ['items', 'question']);
            assert.equal(res.body.question.id, Q.archived);
            assert.equal(res.body.question.subject, '數學');
            assert.equal(res.body.question.chapter, '向量內積');
            assert.equal(res.body.question.archived, true);
            assert.deepEqual(res.body.items, []);
        });

        test('GET …/kcs：id 不合法 → 400；題目不存在 → 404', async () => {
            await request(app).get('/api/questions/abc/kcs').expect(400);
            const res = await request(app).get('/api/questions/99999/kcs').expect(404);
            assert.equal(res.body.message, '找不到該題目。');
        });

        // ───────────── PUT /api/questions/:id/kcs ─────────────
        test('PUT：以 src=human 取代該題全部標註（含 AI 標的），weight 預設 1，可跨章（同科）', async () => {
            await tag(Q.vec, 'MATH.向量內積.02', 'ai', 0.9);
            await tag(Q.vec, 'MATH.向量內積.01', 'ai', 0.7);
            const a = await idOf('MATH.向量內積.05');
            const b = await idOf('MATH.向量的加減與係數積.01');
            const res = await request(app).put(`/api/questions/${Q.vec}/kcs`)
                .send({ items: [{ kc_id: a }, { kc_id: b, weight: 0.5 }] }).expect(200);
            assert.deepEqual(res.body, [
                { kc_id: a, code: 'MATH.向量內積.05', name: '長度平方與展開', weight: 1, src: 'human', confidence: null },
                { kc_id: b, code: 'MATH.向量的加減與係數積.01', name: '向量的加法與減法', weight: 0.5, src: 'human', confidence: null }
            ]);
            const { rows } = await query('SELECT kc_id, src FROM question_kcs WHERE question_id = $1 ORDER BY kc_id', [Q.vec]);
            assert.deepEqual(rows.map(r => r.src), ['human', 'human']);
            assert.equal(rows.length, 2);
            // 已標題數跟著變
            const { body } = await request(app).get('/api/kc?subject=數學').expect(200);
            assert.equal(body.items.find(i => i.code === 'MATH.向量內積.02').question_count, 0);
            assert.equal(body.items.find(i => i.code === 'MATH.向量內積.05').question_count, 1);
        });

        test('PUT：items 為空＝清掉該題全部標註', async () => {
            await tag(Q.vec, 'MATH.向量內積.02');
            await request(app).put(`/api/questions/${Q.vec}/kcs`).send({ items: [] }).expect(200).expect([]);
            const { rows } = await query('SELECT 1 FROM question_kcs WHERE question_id = $1', [Q.vec]);
            assert.equal(rows.length, 0);
        });

        test('PUT：知識點與題目不同科 → 400，原本的標註完全不動（伺服器端檢查科目一致性）', async () => {
            await tag(Q.vec, 'MATH.向量內積.02');
            const res = await request(app).put(`/api/questions/${Q.vec}/kcs`)
                .send({ items: [{ kc_id: await idOf('MATH.向量內積.01') }, { kc_id: await idOf('PHYS.功與動能.01') }] }).expect(400);
            assert.ok(res.body.message.includes('同科'), res.body.message);
            const { rows } = await query('SELECT kc_id, src FROM question_kcs WHERE question_id = $1', [Q.vec]);
            assert.deepEqual(rows, [{ kc_id: await idOf('MATH.向量內積.02'), src: 'ai' }]);
        });

        test('PUT 驗證失敗 → 400；題目不存在 → 404', async () => {
            const k = await idOf('MATH.向量內積.01');
            const bad = [
                {}, { items: 'x' }, { items: [1, 2, 3, 4, 5, 6].map(i => ({ kc_id: i })) },
                { items: [{ kc_id: k }, { kc_id: k }] }, { items: [{ kc_id: 'a' }] },
                { items: [{ kc_id: k, weight: 0 }] }, { items: [{ kc_id: k, weight: 1.5 }] },
                { items: [{ kc_id: 99999 }] },
                { items: [{ kc_id: 2147483648 }] }          // 超出 INT 範圍：要擋在 PG 之前（不是 500）
            ];
            for (const body of bad) {
                const res = await request(app).put(`/api/questions/${Q.vec}/kcs`).send(body).expect(400);
                assert.ok(res.body.message, JSON.stringify(body));
            }
            await request(app).put('/api/questions/abc/kcs').send({ items: [] }).expect(400);
            const nf = await request(app).put('/api/questions/99999/kcs').send({ items: [{ kc_id: k }] }).expect(404);
            assert.equal(nf.body.message, '找不到該題目。');
        });

        // ───────────── 〔stage5 審查修正 S5-42〕PUT /api/questions/:id 改科／改章 × 標註 ─────────────
        test('題目改章（同科）：AI 標註刪掉、人工標註保留；改科：別科的標註連 human 一起刪；沒改章科：不動', async () => {
            const body = (subject, chapter) => ({
                subject, chapter, question_type: '計算', difficulty: 3,
                question_text: '自製整合測試題（向量內積）', answer_text: '略'
            });
            const kcsOf = async id => (await query(
                `SELECT kc.code, qk.src FROM question_kcs qk JOIN knowledge_components kc ON kc.id = qk.kc_id
                  WHERE qk.question_id = $1 ORDER BY kc.code`, [id])).rows.map(r => `${r.code}:${r.src}`);

            await tag(Q.vec, 'MATH.向量內積.02', 'ai');
            await tag(Q.vec, 'MATH.向量的加減與係數積.01', 'human');

            // 只改難度（章節、科目沒變）→ 標註一條都不動
            let res = await request(app).put(`/api/questions/${Q.vec}`).send({ ...body('數學', '向量內積'), difficulty: 4 }).expect(200);
            assert.equal(res.body.kcs_removed, undefined);
            assert.deepEqual(await kcsOf(Q.vec), ['MATH.向量內積.02:ai', 'MATH.向量的加減與係數積.01:human']);

            // 同科改章 → AI 從舊章挑的標註刪掉；老師自己標的保留
            res = await request(app).put(`/api/questions/${Q.vec}`).send(body('數學', '向量的加減與係數積')).expect(200);
            assert.equal(res.body.kcs_removed, 1);
            assert.deepEqual(await kcsOf(Q.vec), ['MATH.向量的加減與係數積.01:human']);

            // 改科 → 與新科目不同科的標註一律刪（含 human），題目變成未標註，kc:backfill 會重標
            await tag(Q.vec, 'MATH.向量內積.03', 'ai');
            res = await request(app).put(`/api/questions/${Q.vec}`).send(body('物理', '功與動能')).expect(200);
            assert.equal(res.body.kcs_removed, 2);
            assert.deepEqual(await kcsOf(Q.vec), []);
            const { body: list } = await request(app).get('/api/kc?subject=數學').expect(200);
            assert.equal(list.items.find(i => i.code === 'MATH.向量的加減與係數積.01').question_count, 0,
                '改科之後不該再算進數學知識點的已標題數');
            const { selectBackfillIds } = require(path.join(APP_DIR, 'services', 'kcTagService'));
            assert.ok((await selectBackfillIds({ query }, { subject: '物理' })).includes(Q.vec), '改科後的題要能被 kc:backfill 挑中重標');
        });

        test('限流桶是獨立的：知識點 API 不吃 /api/jobs 的額度，超過 120/min 回 429', async () => {
            app = loadApp('true');                         // 新的限流桶
            const agent = request(app);
            let last;
            for (let i = 0; i < 121; i++) last = await agent.get('/api/kc?status=approved');
            assert.equal(last.status, 429);
            assert.ok(last.body.message.includes('知識點'));
            app = loadApp('true');                         // 還原一個乾淨的桶給其他案例
        });
    });
}