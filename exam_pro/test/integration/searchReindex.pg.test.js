// ─────────────────────────────────────────────────────────────
// searchReindex.pg.test.js — scripts/reindex_search_tsv.js（npm run search:reindex）的整合測試
// （階段 5 WS-B；docs/chemistry.md 第 4.3 節）
//
// 釘住三件事：
//   ① 用舊詞典切的 search_tsv（「質量數」被切成「質量／數為」），新的查詢 token 查不到；
//      重算後查得到。dry-run 不寫入、重跑第二次寫入 0 題、已封存與 search_tsv 為 NULL 的題也會補上。
//   ② 重算出來的值與 controllers/questionController.js 寫入端（POST 的 INSERT、PUT 的 SEARCH_TSV_ASSIGN）
//      **逐字相同**——腳本的 SQL 是另外組的（interfaces-stage1.md 第 2 條不提供 toTsvSql()），這裡是等價性的證據。
//   ③ 不呼叫 LLM：整支測試沒有注入 LLM，也沒有 cassette。
//
// 三道防線與其他整合測試相同：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// 在 require config/db.js 之前覆寫 DATABASE_URL。題目全部是為測試自行編寫（NOTICE）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('search_tsv 重算整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
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
    const { tokenize } = require(path.join(APP_DIR, 'utils', 'tokenize'));
    const { buildTsvTokens } = require(path.join(APP_DIR, 'services', 'embedService'));
    const { reindexSearchTsv, lexemesOf } = require(path.join(APP_DIR, 'scripts', 'reindex_search_tsv'));

    const db = { pool, query };

    /** 與 queries/hybrid.js 相同的組法：查詢 token 以 | 串成 to_tsquery */
    async function keywordHit(id, text) {
        const { rows } = await query(
            `SELECT q.search_tsv @@ to_tsquery('simple', (SELECT string_agg(quote_literal(t), ' | ') FROM unnest($2::text[]) AS t)) AS hit
               FROM questions q WHERE q.id = $1`, [id, tokenize(text)]);
        return rows[0].hit === true;
    }

    const tsvOf = async (id) => (await query('SELECT search_tsv::text AS t FROM questions WHERE id = $1', [id])).rows[0].t;

    async function insertRaw(q, tsvSql, tsvParams = []) {
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    origin, chapter_src, archived_at, search_tsv)
             VALUES ($1, $2, $3, $4, $5, '測試答案', 'seed', 'human', $6, ${tsvSql})
             RETURNING id`,
            [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, q.archived ? new Date() : null, ...tsvParams]);
        return rows[0].id;
    }

    /** 用目前的詞典切好（＝已經是最新的列） */
    async function insertCurrent(q) {
        const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(q);
        return insertRaw(q,
            `setweight(to_tsvector('simple', array_to_string($7::text[], ' ')), 'A')
          || setweight(to_tsvector('simple', array_to_string($8::text[], ' ')), 'A')
          || setweight(to_tsvector('simple', array_to_string($9::text[], ' ')), 'B')`,
            [chapterTokens, keywordTokens, stemTokens]);
    }

    const NUCLEAR = {
        subject: '物理', chapter: '核物理與基本粒子', question_type: '計算', difficulty: 3,
        question_text: '自製題：質量數為 238 的鈾原子核經過一次 α 衰變後，新原子核的質量數為多少？'
    };
    const VECTOR = {
        subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 2,
        question_text: '自製題：設兩向量坐標為 (1,2) 與 (3,-1)，求其內積。'
    };
    const ARCHIVED = {
        subject: '物理', chapter: '核物理與基本粒子', question_type: '填空', difficulty: 2,
        question_text: '自製題：兩種同位素的質量數不同，原子序相同。', archived: true
    };

    describe('scripts/reindex_search_tsv.js × PostgreSQL', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });
        beforeEach(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });
        after(async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
            await pool.end();
        });

        test('舊詞典切的 search_tsv 查不到新 token；dry-run 不寫、重算後查得到、重跑寫入 0 題', async () => {
            // 階段 5 之前的詞典把「質量數」切成「質量／數為」（審查時以 stage5/base 的 tokenize 實測）
            assert.ok(tokenize('質量數為 238').includes('質量數'), '前提：目前的詞典把「質量數」切成一個詞');
            const stale = await insertRaw(NUCLEAR,
                `setweight(to_tsvector('simple', '核物理與基本粒子 核物理 基本粒子'), 'A')
              || setweight(to_tsvector('simple', '自製 題 質量 數為 238 鈾 原子核 經過 一次 α 衰變 後 新 原子核 質量 數為 多少'), 'B')`);
            const current = await insertCurrent(VECTOR);
            const missing = await insertRaw(ARCHIVED, 'NULL');

            assert.equal(await keywordHit(stale, '質量數'), false, '重算前：新的查詢 token 對不上舊題');
            const currentBefore = await tsvOf(current);

            const dry = await reindexSearchTsv({ db, dryRun: true });
            assert.deepEqual({ total: dry.total, changed: dry.changed, unchanged: dry.unchanged, written: dry.written },
                { total: 3, changed: 2, unchanged: 1, written: 0 });
            const sample = dry.samples.find(s => s.id === stale);
            assert.ok(sample.removed.includes('數為') && sample.added.includes('質量數'), JSON.stringify(sample));
            assert.equal(await keywordHit(stale, '質量數'), false, 'dry-run 不得寫入');
            assert.equal(await tsvOf(missing), null, 'dry-run 不得寫入');

            const real = await reindexSearchTsv({ db, batchSize: 2 });   // 小批次：跨批也要正確
            assert.deepEqual({ total: real.total, changed: real.changed, written: real.written }, { total: 3, changed: 2, written: 2 });
            assert.equal(await keywordHit(stale, '質量數'), true, '重算後：新的查詢 token 查得到舊題');
            assert.equal(await keywordHit(missing, '同位素'), true, '已封存、search_tsv 為 NULL 的題也補上');
            assert.equal(await tsvOf(current), currentBefore, '本來就是最新的列一個字不動');

            const again = await reindexSearchTsv({ db });
            assert.deepEqual({ changed: again.changed, written: again.written, unchanged: again.unchanged }, { changed: 0, written: 0, unchanged: 3 });
        });

        test('--limit 只處理前 N 題（依 id）', async () => {
            const a = await insertRaw(NUCLEAR, 'NULL');
            const b = await insertRaw(VECTOR, 'NULL');
            const r = await reindexSearchTsv({ db, limit: 1 });
            assert.deepEqual({ total: r.total, written: r.written }, { total: 1, written: 1 });
            assert.notEqual(await tsvOf(a), null);
            assert.equal(await tsvOf(b), null);
        });

        test('重算結果與題目 API 寫入端逐字相同（POST 的 INSERT、PUT 的 SEARCH_TSV_ASSIGN，含 keywords 段）', async () => {
            const created = await request(app).post('/api/questions').send({
                subject: '化學', chapter: '氣體性質與理想氣體', question_type: '計算', difficulty: 3,
                question_text: '自製題：定溫下理想氣體的壓力加倍，體積變為原來的幾倍？反應速率與此無關。',
                answer_text: '$\\frac{1}{2}$ 倍'
            });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            const id = created.body.questionId;
            const fromPost = await tsvOf(id);

            await query(`UPDATE questions SET search_tsv = to_tsvector('simple', '舊 的 切法') WHERE id = $1`, [id]);
            await reindexSearchTsv({ db });
            assert.equal(await tsvOf(id), fromPost, '與 POST /api/questions 的 INSERT 相同');

            // keywords／concept_summary 只有 DB 知道；PUT 以 RETURNING 的值走 writeSearchTsv（SEARCH_TSV_ASSIGN）
            await query(`UPDATE questions SET keywords = ARRAY['亞佛加厥數','理想氣體'], concept_summary = '定溫下壓力與體積成反比' WHERE id = $1`, [id]);
            const put = await request(app).put(`/api/questions/${id}`).send({
                subject: '化學', chapter: '氣體性質與理想氣體', question_type: '計算', difficulty: 3,
                question_text: '自製題：定溫下理想氣體的壓力變為三倍，體積變為原來的幾倍？',
                answer_text: '$\\frac{1}{3}$ 倍'
            });
            assert.equal(put.status, 200, JSON.stringify(put.body));
            const fromPut = await tsvOf(id);
            assert.ok(lexemesOf(fromPut).includes('亞佛加厥數'), 'keywords 段有寫進去（題幹沒有這個詞）');

            await query(`UPDATE questions SET search_tsv = NULL WHERE id = $1`, [id]);
            const r = await reindexSearchTsv({ db });
            assert.equal(r.written, 1);
            assert.equal(await tsvOf(id), fromPut, '與 PUT /api/questions/:id 的 SEARCH_TSV_ASSIGN 相同');
        });
    });
}
