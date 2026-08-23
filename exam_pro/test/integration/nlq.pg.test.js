// ─────────────────────────────────────────────────────────────
// nlq.pg.test.js — POST /api/questions/search-nl 的整合測試（P-08，擁有者 WS-C）
//
// 這一支**需要 PostgreSQL**，因此：
//   - 只讀 TEST_DATABASE_URL，且資料庫名必須以 _test 結尾（與 migrate.js 同一套防呆）
//   - 沒設 TEST_DATABASE_URL 就整組 skip，所以 `npm test` 仍然不連 DB、不需 secrets
//
// 本機執行（先 docker compose up -d --wait && npm run migrate:test）：
//   npm run test:integration
//
// 它量兩件事：
//   ① 端點的形狀（八個 filters 鍵、results 的欄位、400 的訊息字串）；
//   ② **回退階梯每一級都真的能被觸發**（第 6.6 條）——
//      level 3 關掉 embed（查詢向量不在 fixture 裡）、
//      level 2 讓 hybrid 第一段回 0 筆、
//      level 1 讓 LLM 逾時（LLM_MODE=replay 且沒有 cassette）。
//      光有單元測試不夠：回退階梯錯在哪一級，只有真的跑過一次 SQL 才看得出來。
//
// 題目全部是為了測試自行編寫的教科書型例題，不取自任何考卷（見 NOTICE）。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('自然語言查題整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    const DIM = 768;                        // migrations/0002_vector.sql 寫死 vector(768)
    const MODEL = 'nlq-integration-model';

    // 必須在 require config/db.js 與 routes/index.js 之前設定
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;             // app.js 的 apiKeyAuth 在沒有 API_KEY 時放行
    process.env.FEATURE_NLQ = 'true';       // routes 在 require 當下才決定掛不掛載
    process.env.LLM_MODE = 'replay';        // 不連 Gemini；沒有 cassette 就是 replay miss
    process.env.EMBED_MODE = 'fixture';
    process.env.EMBED_MODEL = MODEL;
    process.env.EMBED_DIM = String(DIM);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlq-embed-'));
    process.env.EMBED_FIXTURE_DIR = tmpDir;

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { saveToFixture, sha256Hex } = require(path.join(APP_DIR, 'services', 'llm', 'fixture'));
    const { buildTsvTokens } = require(path.join(APP_DIR, 'services', 'embedService'));
    const nlqService = require(path.join(APP_DIR, 'services', 'nlqService'));

    /** 把幾個「概念軸」展開成單位向量：同概念的題彼此最近 */
    function makeVector(components) {
        const v = new Array(DIM).fill(0);
        components.forEach(([i, x]) => { v[i] = x; });
        const norm = Math.hypot(...v);
        return v.map(x => x / norm);
    }

    const AXIS_DOT = makeVector([[0, 1]]);          // 向量內積
    const AXIS_FRICTION = makeVector([[1, 1]]);     // 摩擦力

    // 自製測試題。question_text 刻意**不含**章節名，這樣 level 3 的 LIKE
    // 與 level 0 的 hybrid 才會給出不同的答案（不然兩條路看起來一樣好）。
    const QUESTIONS = [
        { key: 'dot-easy', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 2,
            question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩者的乘積和。', vec: AXIS_DOT },
        { key: 'dot-mid', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
            question_text: '設 $\\vec{a}=(2,5)$、$\\vec{b}=(4,-3)$，求兩者的乘積和。', vec: AXIS_DOT },
        { key: 'dot-fill', subject: '數學', chapter: '向量內積', question_type: '填空', difficulty: 3,
            question_text: '設 $\\vec{a}=(2,k)$ 與 $\\vec{b}=(3,-1)$ 互相垂直，求 $k$。', vec: AXIS_DOT },
        { key: 'fric', subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
            question_text: '質量 $10$ kg 的物體置於傾角 $30^\\circ$ 的斜面上，求它會不會下滑。', vec: AXIS_FRICTION },
        { key: 'fric2', subject: '物理', chapter: '摩擦力與向心力', question_type: '單選', difficulty: 2,
            question_text: '物體靜置於水平地面時，下列敘述何者正確？', vec: AXIS_FRICTION }
    ];

    /** 查詢字串 → 向量。只有寫進 fixture 的字串，embed() 才查得到；其餘一律丟錯 = level 3。 */
    const QUERY_VECTORS = {
        '向量內積': AXIS_DOT,
        '摩擦力': AXIS_FRICTION,
        '兩個向量互相垂直時未知數是多少': AXIS_DOT
    };

    const idByKey = new Map();

    async function seed() {
        await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        idByKey.clear();
        for (const q of QUESTIONS) {
            const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(q);
            const { rows } = await query(
                `INSERT INTO questions
                   (subject, chapter, question_type, difficulty, question_text, answer_text,
                    origin, chapter_src, embedding, embedding_model, embedded_at, search_tsv)
                 VALUES ($1,$2,$3,$4,$5,$6,'seed','human',$7::vector,$8,now(),
                         setweight(to_tsvector('simple', array_to_string($9::text[],  ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($10::text[], ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($11::text[], ' ')), 'B'))
                 RETURNING id`,
                [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, '測試答案',
                    `[${q.vec.join(',')}]`, MODEL, chapterTokens, keywordTokens, stemTokens]
            );
            idByKey.set(q.key, rows[0].id);
        }
    }

    const post = (body) => request(app).post('/api/questions/search-nl').send(body);

    describe('POST /api/questions/search-nl × PostgreSQL', () => {
        before(async () => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
            // 只有這幾個查詢字串查得到向量；其它一律讓 embed() 丟錯（= 沒有 embedding 服務）
            saveToFixture({
                model: MODEL, dim: DIM,
                entries: Object.entries(QUERY_VECTORS).map(([text, vec]) => [sha256Hex(text), vec])
            });
            await seed();
        });

        after(async () => {
            await pool.end().catch(() => {});
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        beforeEach(() => nlqService._resetCacheForTest());

        // ── 400（訊息字串凍結於第 6 條的表）────────────────────
        describe('400', () => {
            test('query 必須是非空字串。', async () => {
                for (const body of [{}, { query: '' }, { query: '   ' }, { query: 42 }]) {
                    const res = await post(body);
                    assert.equal(res.status, 400);
                    assert.equal(res.body.message, 'query 必須是非空字串。');
                }
            });

            test('query 最多 200 字。', async () => {
                const res = await post({ query: '向'.repeat(201) });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'query 最多 200 字。');
            });

            test('student_id 必須是正整數。', async () => {
                const res = await post({ query: '向量內積', student_id: 0 });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'student_id 必須是正整數。');
            });

            test('limit 必須是 1~50 的整數。', async () => {
                const res = await post({ query: '向量內積', limit: 51 });
                assert.equal(res.status, 400);
                assert.equal(res.body.message, 'limit 必須是 1~50 的整數。');
            });
        });

        // ── 200 的形狀 ─────────────────────────────────────────
        describe('200 的回應形狀（第 6 條）', () => {
            test('filters 的八個鍵一律出現，順序固定', async () => {
                const res = await post({ query: '向量內積' });
                assert.equal(res.status, 200);
                assert.deepEqual(Object.keys(res.body.filters), [
                    'subject', 'chapters', 'question_types', 'difficulty_min',
                    'difficulty_max', 'exclude_student_name', 'semantic_text', 'keywords'
                ]);
                assert.deepEqual(Object.keys(res.body).sort(),
                    ['fallback_level', 'filters', 'parse_path', 'results', 'warnings']);
            });

            test('results 的形狀與 /similar 相同', async () => {
                const res = await post({ query: '向量內積' });
                assert.ok(res.body.results.length > 0);
                for (const row of res.body.results) {
                    for (const key of ['id', 'subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'score']) {
                        assert.ok(key in row, `results 少了 ${key}`);
                    }
                }
            });

            test('沒抓到的欄位填 null／[]／\'\'，不是消失', async () => {
                const res = await post({ query: '向量內積' });
                assert.equal(res.body.filters.difficulty_min, null);
                assert.equal(res.body.filters.exclude_student_name, null);
                assert.deepEqual(res.body.filters.question_types, []);
                assert.equal(typeof res.body.filters.semantic_text, 'string');
            });
        });

        // ── 條件真的有作用 ──────────────────────────────────────
        describe('filters 真的會影響候選集', () => {
            test('章節條件把另一科的題擋在外面', async () => {
                const res = await post({ query: '向量內積' });
                assert.equal(res.body.filters.subject, '數學');
                assert.deepEqual(res.body.filters.chapters, ['向量內積']);
                for (const row of res.body.results) assert.equal(row.chapter, '向量內積');
            });

            test('題型條件（buildHybridQuery 沒有這個參數，靠候選排除集）', async () => {
                const res = await post({ query: '向量內積的填空題' });
                assert.equal(res.body.fallback_level, 0);
                assert.deepEqual(res.body.filters.question_types, ['填空']);
                assert.deepEqual(res.body.results.map(r => r.id), [idByKey.get('dot-fill')]);
            });

            test('難度區間', async () => {
                const res = await post({ query: '向量內積難度 2 以下' });
                assert.equal(res.body.filters.difficulty_min, 1);
                assert.equal(res.body.filters.difficulty_max, 2);
                assert.deepEqual(res.body.results.map(r => r.id), [idByKey.get('dot-easy')]);
            });

            test('「某某沒寫過」會排除該生已作答的題', async () => {
                try {
                    const { rows: sRows } = await query(
                        `INSERT INTO students (name) VALUES ('小明') RETURNING id`);
                    const studentId = sRows[0].id;
                    const written = idByKey.get('dot-easy');
                    const { rows: pRows } = await query(
                        `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('測試卷', $1, $2::int[]) RETURNING id`,
                        [studentId, [written]]);
                    await query(
                        `INSERT INTO attempts (student_id, question_id, paper_id) VALUES ($1, $2, $3)`,
                        [studentId, written, pRows[0].id]);

                    const res = await post({ query: '向量內積，小明沒寫過' });
                    assert.equal(res.body.filters.exclude_student_name, '小明');
                    assert.deepEqual(res.body.warnings, []);
                    assert.ok(!res.body.results.some(r => r.id === idByKey.get('dot-easy')),
                        '小明寫過的那一題不該出現');
                    assert.ok(res.body.results.length > 0);
                } finally {
                    await seed();
                }
            });

            test('查無此學生 → 只警告，不自動建學生，results 照常', async () => {
                const res = await post({ query: '向量內積，查無此人沒寫過' });
                assert.ok(res.body.warnings.includes('找不到學生「查無此人」，已忽略「沒寫過」的條件。'));
                assert.ok(res.body.results.length > 0);
                const { rows } = await query('SELECT count(*)::int AS n FROM students');
                assert.equal(rows[0].n, 0, '不得自動建立學生');
            });

            test('limit 真的會截斷', async () => {
                const res = await post({ query: '向量內積', limit: 1 });
                assert.equal(res.body.results.length, 1);
            });
        });

        // ── 回退階梯（第 6.6 條）每一級都能觸發 ────────────────
        describe('回退階梯', () => {
            test('level 0：規則命中 + hybrid 有結果 → 沒有 warning', async () => {
                const res = await post({ query: '向量內積' });
                assert.equal(res.body.fallback_level, 0);
                assert.equal(res.body.parse_path, 'rules');
                assert.deepEqual(res.body.warnings, []);
                assert.ok(res.body.results.every(r => typeof r.score === 'number'));
            });

            test('level 1：LLM 逾時／沒有 cassette → parse_path=llm_failed', async () => {
                // 規則抓不到章節、剩餘有實詞 → 必定呼叫 generateJson；
                // LLM_MODE=replay 且 eval/cassettes/nlq/ 沒有這一句 → replay miss → 不 throw，退到規則結果。
                // 這一句的 semantic_text 有寫進 fixture，所以檢索本身是正常的（不會變成 level 3）。
                const res = await post({ query: '兩個向量互相垂直時未知數是多少' });
                assert.equal(res.status, 200);
                assert.equal(res.body.parse_path, 'llm_failed');
                assert.equal(res.body.fallback_level, 1);
                assert.ok(res.body.warnings.includes('LLM 解析逾時或不合 schema，只用規則解析的結果。'));
                assert.ok(res.body.results.length > 0, 'level 1 只是解析降級，檢索照樣要有結果');
                assert.ok(res.body.results.every(r => typeof r.score === 'number'));
            });

            test('level 2：hybrid 第一段 0 筆 → 放寬條件重查', async () => {
                // 題庫裡沒有難度 5 的向量內積題 → 第一段（帶章節＋難度 5）必定 0 筆
                const res = await post({ query: '向量內積 5 星' });
                assert.equal(res.body.filters.difficulty_min, 5);
                assert.equal(res.body.fallback_level, 2);
                assert.ok(res.body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
                assert.ok(res.body.results.length > 0, '放寬之後應該找得到東西');
            });

            test('level 2 走完仍是 0 筆 → results:[] 且 fallback_level:2（不是 3）', async () => {
                await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
                try {
                    const res = await post({ query: '向量內積' });
                    assert.deepEqual(res.body.results, []);
                    assert.equal(res.body.fallback_level, 2, '沒東西可找不等於 embedding 壞了');
                    assert.ok(!res.body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
                } finally {
                    await seed();
                }
            });

            test('level 3：查詢向量不在 fixture 裡（embed() 丟錯）→ LIKE，score 一律 null', async () => {
                // 只有 QUERY_VECTORS 裡那三句查得到向量；這一句查不到 → embed() 丟錯。
                // ILIKE '%會不會下滑%' 在第一段就比得到 fric 那一題，所以不會再放寬。
                const res = await post({ query: '會不會下滑的題目' });
                assert.equal(res.status, 200);
                assert.equal(res.body.fallback_level, 3);
                assert.ok(res.body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
                assert.ok(!res.body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
                assert.deepEqual(res.body.results.map(r => r.id), [idByKey.get('fric')]);
                assert.ok(res.body.results.every(r => r.score === null), 'LIKE 沒有分數，一律 null');
            });

            test('level 3：ILIKE 一題都比不到時退回「這一章的清單」而不是空白', async () => {
                // 別名「平面向量內積」→ 章節「向量內積」，但這個 semantic_text 不在 fixture 裡
                // （embed 丟錯 = level 3），而題幹裡也不會逐字出現「平面向量內積」，
                // 所以第一段 ILIKE 必定 0 筆；第二段丟掉 ILIKE、留下 metadata 篩選
                // ＝ listQuestions 的那張清單。
                const res = await post({ query: '平面向量內積的填空題' });
                assert.equal(res.body.fallback_level, 3);
                assert.ok(res.body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
                assert.ok(res.body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
                assert.deepEqual(res.body.results.map(r => r.id), [idByKey.get('dot-fill')],
                    '章節與題型的 metadata 篩選必須還在');
            });

            test('level 3 + level 2 同時成立 → 回較高的 3，warnings 兩句都有', async () => {
                // 「宇宙膨脹」是章節別名（宇宙學簡介）→ 規則命中、不呼叫 LLM；
                // 但題庫裡沒有這一章的題，而且它的向量不在 fixture 裡 → 先 3 後 2。
                const res = await post({ query: '宇宙膨脹的計算題' });
                assert.equal(res.body.fallback_level, 3);
                assert.ok(res.body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
                assert.ok(res.body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
            });
        });

        // ── 解析快取（第 6.7 條）──────────────────────────────
        describe('解析快取', () => {
            test('同一句話問兩次，回應一致', async () => {
                const a = await post({ query: '向量內積的填空題' });
                const b = await post({ query: '向量內積的填空題' });
                assert.deepEqual(a.body.filters, b.body.filters);
                assert.deepEqual(a.body.results.map(r => r.id), b.body.results.map(r => r.id));
            });

            test('快取的是解析而不是檢索：題庫變了，同一句話的結果要跟著變', async () => {
                const before = await post({ query: '向量內積' });
                assert.ok(before.body.results.length >= 3);
                await query('DELETE FROM questions WHERE chapter = $1', ['向量內積']);
                try {
                    const after = await post({ query: '向量內積' });
                    assert.equal(after.body.results.length, 0, '檢索結果不得進快取（裁決 S3-18）');
                } finally {
                    await seed();
                }
            });
        });

        // ── FEATURE_NLQ ───────────────────────────────────────
        test('FEATURE_NLQ 開啟時路由確實掛載（關閉時整條不掛載，落到 404）', async () => {
            assert.equal(nlqService.isNlqEnabled(), true);
            const res = await post({ query: '向量內積' });
            assert.equal(res.status, 200);
        });
    });
}
