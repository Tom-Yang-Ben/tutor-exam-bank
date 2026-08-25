// queries/hybrid.js + services/embedService.js 的整合測試（WS-C / D-R1）
//
// 這一支**需要 PostgreSQL**，因此：
//   - 只讀 TEST_DATABASE_URL，且資料庫名必須以 _test 結尾（與 migrate.js 同一套防呆）
//   - 沒設 TEST_DATABASE_URL 就整組 skip，所以 `npm test` 仍然不連 DB、不需 secrets
//
// 本機執行（先 docker compose up -d --wait && npm run migrate:test）：
//   node --env-file=.env --test "test/integration/*.test.js"
// CI 由 WS-D 的 integration job 以環境變數提供 TEST_DATABASE_URL。
//
// 題目全部是為了測試自行編寫的教科書型例題，不取自任何考卷（見 NOTICE）。

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');

const { buildHybridQuery } = require('../../queries/hybrid');
const embedService = require('../../services/embedService');
const { buildEmbedText } = require('../../utils/embedText');
const { tokenize } = require('../../utils/tokenize');
const { saveToFixture, sha256Hex } = require('../../services/llm/fixture');

const DIM = 768;                       // migrations/0002_vector.sql 寫死 vector(768)
const MODEL = 'integration-test-model';
const URL = process.env.TEST_DATABASE_URL;

const skip = !URL
    ? '未設定 TEST_DATABASE_URL（npm test 本來就不連 DB；要跑這一支請用 node --env-file=.env --test）'
    : (!/_test(\?|$)/.test(URL) ? 'TEST_DATABASE_URL 的資料庫名必須以 _test 結尾' : false);

// ───────────────────────── 測試資料（自行編寫）─────────────────────────

/** 把幾個「概念軸」展開成 768 維單位向量：同概念的題彼此最近 */
function makeVector(components) {
    const v = new Array(DIM).fill(0);
    components.forEach(([i, x]) => { v[i] = x; });
    const norm = Math.hypot(...v);
    return v.map(x => x / norm);
}

const QUESTIONS = [
    {
        key: 'dot1', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的內積 $\\vec{a}\\cdot\\vec{b}$。',
        answer_text: '$1$', keywords: ['向量內積', '座標'], vec: [[0, 1]],
    },
    {
        // 與 dot1 同概念、只換數字：檢索的正樣本
        key: 'dot2', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(2,5)$、$\\vec{b}=(4,-3)$，求兩向量的內積 $\\vec{a}\\cdot\\vec{b}$。',
        answer_text: '$-7$', keywords: ['向量內積', '座標'], vec: [[0, 0.99], [1, 0.14]],
    },
    {
        key: 'angle', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '求向量 $\\vec{a}=(1,1)$ 與 $\\vec{b}=(0,2)$ 的夾角 $\\theta$。',
        answer_text: '$45^\\circ$', keywords: ['向量內積', '夾角'], vec: [[0, 0.9], [1, 0.43]],
    },
    {
        key: 'perp', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 4,
        question_text: '已知 $|\\vec{a}|=3$、$|\\vec{b}|=4$ 且兩向量互相垂直，求 $|\\vec{a}+\\vec{b}|$。',
        answer_text: '$5$', keywords: ['向量內積', '垂直'], vec: [[0, 0.8], [1, 0.6]],
    },
    {
        key: 'circle_tangent', subject: '數學', chapter: '圓方程式', question_type: '計算', difficulty: 3,
        question_text: '求圓 $x^2+y^2=25$ 上一點 $(3,4)$ 處的切線方程式。',
        answer_text: '$3x+4y=25$', keywords: ['圓方程式', '切線'], vec: [[2, 1]],
    },
    {
        key: 'circle_eq', subject: '數學', chapter: '圓方程式', question_type: '填空', difficulty: 2,
        question_text: '求圓心為 $(1,2)$、半徑為 $5$ 的圓方程式。',
        answer_text: '$(x-1)^2+(y-2)^2=25$', keywords: ['圓方程式', '圓心'], vec: [[2, 0.95], [3, 0.31]],
    },
    {
        key: 'centripetal', subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
        question_text: '質量 $2$ kg 的物體以等速率 $3$ m/s 作半徑 $0.5$ m 的圓周運動，求所需的向心力。',
        answer_text: '$36$ N', keywords: ['圓周運動', '向心力'], vec: [[4, 1]],
    },
    {
        // 已封存：向量比 dot2 更接近 dot1，但候選池一律排除已封存題
        key: 'archived', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$（此題已封存）。',
        answer_text: '$1$', keywords: ['向量內積'], vec: [[0, 0.995], [1, 0.1]], archived: true,
    },
];

let pool;
let idOf = {};        // key -> questions.id
let studentId;
let tmpDir;
const envBackup = {};

before(async (t) => {
    if (skip) return;

    pool = new Pool({ connectionString: URL, max: 4 });
    const db = { pool, query: (text, values) => pool.query(text, values) };

    // 沒套過 migrations 就直接說清楚，不要讓後面每一項都爆一次
    const { rows } = await pool.query(
        `SELECT to_regclass('public.questions') AS q, to_regclass('public.attempts') AS a`
    );
    assert.ok(rows[0].q && rows[0].a, '測試庫尚未套用 migrations，請先執行 npm run migrate:test');

    // 這是 _test 庫（上面已檢查後綴），可以放心清空
    await pool.query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');

    for (const q of QUESTIONS) {
        const res = await pool.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, keywords, origin, chapter_src, archived_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'seed','human',$8) RETURNING id`,
            [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, q.answer_text, q.keywords,
             q.archived ? new Date() : null]
        );
        idOf[q.key] = res.rows[0].id;
    }

    // 以 fixture 模式餵入預先設計好的向量：整合測試同樣不呼叫 Gemini
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-hybrid-pg-'));
    for (const k of ['EMBED_FIXTURE_DIR', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM']) envBackup[k] = process.env[k];
    process.env.EMBED_FIXTURE_DIR = tmpDir;
    process.env.EMBED_MODE = 'fixture';

    const { rows: dbRows } = await pool.query(
        `SELECT ${embedService.SELECT_COLUMNS} FROM questions ORDER BY id`
    );
    const entries = dbRows.map((row) => {
        const q = QUESTIONS.find(x => idOf[x.key] === row.id);
        return [sha256Hex(buildEmbedText(row)), makeVector(q.vec)];
    });
    saveToFixture({ model: MODEL, dim: DIM, entries });

    const res = await embedService.embedByIds(dbRows.map(r => r.id), { db, model: MODEL, dim: DIM });
    assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
    assert.equal(res.embedded, QUESTIONS.length);

    // 一位測試學生：寫過 dot2，用來驗證 excludeStudentId
    // 姓名刻意加上 WS-C 前綴：students.name 是 UNIQUE，用通用名字會跟別支整合測試的
    // 固定測試學生撞在一起（那支若沒有先 TRUNCATE，就會在插入時就先炸掉）。
    studentId = (await pool.query(`INSERT INTO students (name) VALUES ('WS-C 檢索整合測試學生') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO attempts (student_id, question_id) VALUES ($1, $2)`, [studentId, idOf.dot2]);
});

after(async () => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (pool) {
        // 跑完把測試庫清乾淨：留著資料會讓後面跑的整合測試檔（它們共用同一個
        // postgres_test）撞到 students.name / questions 的既有列。
        await pool.query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE').catch(() => {});
        await pool.end();
    }
});

// ───────────────────────── 輔助 ─────────────────────────

/** 取得來源題的向量與 token，然後跑一次 buildHybridQuery */
async function search(sourceKey, overrides = {}) {
    const { rows } = await pool.query(
        `SELECT id, subject, chapter, difficulty, embedding, question_text, keywords FROM questions WHERE id = $1`,
        [idOf[sourceKey]]
    );
    const src = rows[0];
    const queryVector = JSON.parse(src.embedding);          // vector 讀回來是字串
    const queryTokens = tokenize(`${src.chapter} ${(src.keywords || []).join(' ')} ${src.question_text}`);

    const opts = {
        subject: src.subject,
        chapter: src.chapter,
        difficultyMin: Math.max(1, src.difficulty - 1),
        difficultyMax: Math.min(5, src.difficulty + 1),
        excludeStudentId: null,
        excludeIds: [src.id],
        queryVector,
        queryTokens,
        mode: 'rrf',
        limit: 10,
        ...overrides,
    };
    const { text, values } = buildHybridQuery(opts);

    // 呼叫端負責在同一交易內調 hnsw.ef_search（interfaces-stage1.md 第 5 條）
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL hnsw.ef_search = 100');
        const res = await client.query(text, values);
        await client.query('COMMIT');
        return res.rows;
    } finally {
        client.release();
    }
}

// ───────────────────────── 測試 ─────────────────────────

describe('queries/hybrid.js 對真 PostgreSQL', { skip }, () => {
    test('回傳欄位凍結為 id / score / vec_rank / kw_rank，且型別是數字或 null', async () => {
        const rows = await search('dot1');
        assert.ok(rows.length > 0);
        for (const r of rows) {
            assert.deepEqual(Object.keys(r).sort(), ['id', 'kw_rank', 'score', 'vec_rank']);
            assert.equal(typeof r.id, 'number');
            assert.equal(typeof r.score, 'number');           // float8，不是 numeric 的字串
            assert.ok(r.vec_rank === null || typeof r.vec_rank === 'number');
            assert.ok(r.kw_rank === null || typeof r.kw_rank === 'number');
        }
    });

    test('依 score 由大到小；同分時 id 由小到大', async () => {
        const rows = await search('dot1');
        for (let i = 1; i < rows.length; i++) {
            assert.ok(rows[i - 1].score > rows[i].score
                || (rows[i - 1].score === rows[i].score && rows[i - 1].id < rows[i].id));
        }
    });

    test('「換數字的同一題」排第一', async () => {
        const rows = await search('dot1');
        assert.equal(rows[0].id, idOf.dot2);
    });

    test('excludeIds 排除來源題本身', async () => {
        const rows = await search('dot1');
        assert.ok(!rows.some(r => r.id === idOf.dot1));
    });

    test('候選池一律排除已封存題（archived_at IS NOT NULL）', async () => {
        const rows = await search('dot1');
        assert.ok(!rows.some(r => r.id === idOf.archived), '已封存題不得出現在候選池');
    });

    test('excludeStudentId 排除該生已作答的題（NOT EXISTS，不是 NOT IN）', async () => {
        const rows = await search('dot1', { excludeStudentId: studentId });
        assert.ok(!rows.some(r => r.id === idOf.dot2));
        assert.ok(rows.some(r => r.id === idOf.angle));
    });

    test('查無此學生 → 空排除集，照樣回結果', async () => {
        const rows = await search('dot1', { excludeStudentId: 999999 });
        assert.ok(rows.some(r => r.id === idOf.dot2));
    });

    test('chapter=null 時跨章找（同學科）', async () => {
        const rows = await search('dot1', { chapter: null, difficultyMin: 1, difficultyMax: 5 });
        assert.ok(rows.some(r => r.id === idOf.circle_tangent), '不限章時應該看得到其他章的題');
    });

    test('difficulty 區間會過濾候選', async () => {
        const rows = await search('dot1', { difficultyMin: 4, difficultyMax: 4 });
        assert.deepEqual(rows.map(r => r.id), [idOf.perp]);
    });

    test('limit 生效', async () => {
        const rows = await search('dot1', { chapter: null, difficultyMin: 1, difficultyMax: 5, limit: 2 });
        assert.equal(rows.length, 2);
    });
});

describe('關鍵字側的安全性', { skip }, () => {
    test('queryTokens 為空陣列 → 關鍵字側是空集合，不會讓 to_tsquery 報錯', async () => {
        const rows = await search('dot1', { queryTokens: [] });
        assert.ok(rows.length > 0);
        assert.ok(rows.every(r => r.kw_rank === null));
    });

    test('含符號的 token（f(x)、a:b、單引號）由 quote_literal 處理，不會 syntax error', async () => {
        const rows = await search('dot1', { queryTokens: ['f(x)', 'a:b', "it's", '向量', 'x2', '&', '|'] });
        assert.ok(Array.isArray(rows));
    });

    test('關鍵字命中時 kw_rank 有值', async () => {
        const rows = await search('dot1', { queryTokens: tokenize('向量內積 夾角') });
        assert.ok(rows.some(r => r.kw_rank !== null), JSON.stringify(rows));
    });
});

describe('三種 side 組合與兩種 mode', { skip }, () => {
    test('sides=[vec] → 只有向量側（kw_rank 全為 null）', async () => {
        const rows = await search('dot1', { sides: ['vec'] });
        assert.ok(rows.length > 0);
        assert.ok(rows.every(r => r.kw_rank === null));
        assert.equal(rows[0].id, idOf.dot2);
    });

    test('sides=[kw] → 只有關鍵字側（vec_rank 全為 null）', async () => {
        const rows = await search('dot1', { sides: ['kw'] });
        assert.ok(rows.length > 0);
        assert.ok(rows.every(r => r.vec_rank === null));
    });

    test('mode=weighted：score 落在 0~1，且仍以「換數字的同一題」為首', async () => {
        const rows = await search('dot1', { mode: 'weighted' });
        assert.equal(rows[0].id, idOf.dot2);
        for (const r of rows) {
            assert.ok(r.score >= 0 && r.score <= 1, `score=${r.score}`);
        }
    });

    test('mode=rrf 的 score 等於 1/(60+vec_rank) + 1/(60+kw_rank)', async () => {
        const rows = await search('dot1');
        for (const r of rows) {
            const expected = (r.vec_rank ? 1 / (60 + r.vec_rank) : 0) + (r.kw_rank ? 1 / (60 + r.kw_rank) : 0);
            assert.ok(Math.abs(r.score - expected) < 1e-9, `${r.score} vs ${expected}`);
        }
    });
});

describe('embedService 對真 PostgreSQL', { skip }, () => {
    test('回填後 embedding / embed_hash / embedding_model / embedded_at / search_tsv 都有值', async () => {
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM questions
              WHERE embedding IS NULL OR embed_hash IS NULL OR embedding_model IS NULL
                 OR embedded_at IS NULL OR search_tsv IS NULL`
        );
        assert.equal(rows[0].n, 0);
    });

    test('search_tsv 的章節與關鍵詞是權重 A、題幹是權重 B', async () => {
        const { rows } = await pool.query(
            `SELECT search_tsv::text AS tsv FROM questions WHERE id = $1`, [idOf.centripetal]
        );
        assert.match(rows[0].tsv, /'向心力':\d+A/);        // 章節段
        assert.match(rows[0].tsv, /:\d+B/);                 // 題幹段
    });

    test('第二次跑 embedByIds 全部略過（embed_hash 沒變就不重算）', async () => {
        const db = { pool, query: (t, v) => pool.query(t, v) };
        const ids = Object.values(idOf);
        const res = await embedService.embedByIds(ids, { db, model: MODEL, dim: DIM });
        assert.equal(res.embedded, 0);
        assert.equal(res.skipped, ids.length);
    });

    test('題目內容改過 → embed_hash 對不上 → 會重算', async () => {
        const db = { pool, query: (t, v) => pool.query(t, v) };
        await pool.query(`UPDATE questions SET question_text = question_text || '（補充說明）' WHERE id = $1`, [idOf.perp]);

        // 改過內容的那一題還沒有新向量可查，fixture 會查不到 → 記進 failed 而不是靜默塞假向量
        const res = await embedService.embedByIds([idOf.perp], { db, model: MODEL, dim: DIM });
        assert.equal(res.skipped, 0);
        assert.equal(res.failed.length, 1);
        assert.match(res.failed[0].error, /查無此文本/);

        // 錄進 fixture 後就能算完
        const { rows } = await pool.query(`SELECT ${embedService.SELECT_COLUMNS} FROM questions WHERE id = $1`, [idOf.perp]);
        saveToFixture({ model: MODEL, dim: DIM, entries: [[sha256Hex(buildEmbedText(rows[0])), makeVector([[0, 0.8], [1, 0.6]])]] });
        const res2 = await embedService.embedByIds([idOf.perp], { db, model: MODEL, dim: DIM });
        assert.equal(res2.embedded, 1);
    });

    test('countMissingEmbeddings 回 0（回填完整度的收尾檢查）', async () => {
        const db = { pool, query: (t, v) => pool.query(t, v) };
        assert.equal(await embedService.countMissingEmbeddings(db), 0);
    });
});

// ───────────────────────── /similar（services/retrievalService.js）─────────────────────────

const express = require('express');
const createRateLimiter = require('../../middleware/rateLimit');
const retrievalService = require('../../services/retrievalService');

/** 依 routes/index.js 的 WS-C 區塊同一套規則掛一個最小 app（app.locals.db 注入測試庫） */
function startApp(db) {
    const app = express();
    app.locals.db = db;
    const router = express.Router();
    if (retrievalService.isSimilarEnabled()) {
        router.get('/questions/:id/similar', createRateLimiter({ windowMs: 60 * 1000, max: 60 }), retrievalService.similarQuestionsHandler);
    }
    app.use('/api', router);
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

describe('GET /api/questions/:id/similar', { skip }, () => {
    let db;
    before(() => { db = { pool, query: (t, v) => pool.query(t, v) }; });

    test('200 的回應形狀凍結為 { source_id, mode, results:[…] }', async () => {
        const { status, body } = await retrievalService.findSimilar(idOf.dot1, { db, k: 3 });
        assert.equal(status, 200);
        assert.deepEqual(Object.keys(body).sort(), ['mode', 'results', 'source_id']);
        assert.equal(body.source_id, idOf.dot1);
        assert.equal(body.mode, 'hybrid');
        assert.ok(body.results.length > 0);

        const first = body.results[0];
        for (const key of ['id', 'subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'score']) {
            assert.ok(key in first, `results[0] 缺少 ${key}`);
        }
        assert.equal(typeof first.score, 'number');
        assert.equal(first.id, idOf.dot2);                        // 換數字的同一題
        assert.ok(!body.results.some(r => r.id === idOf.dot1));    // 不含來源題本身
        assert.ok(!body.results.some(r => r.id === idOf.archived));
    });

    test('results 依 score 由大到小，且筆數不超過 k', async () => {
        const { body } = await retrievalService.findSimilar(idOf.dot1, { db, k: 2 });
        assert.ok(body.results.length <= 2);
        for (let i = 1; i < body.results.length; i++) {
            assert.ok(body.results[i - 1].score >= body.results[i].score);
        }
    });

    test('404：:id 不存在', async () => {
        const { status, body } = await retrievalService.findSimilar(999999, { db });
        assert.equal(status, 404);
        assert.equal(body.message, '找不到該題目');
    });

    test('404：已封存的題視同不存在', async () => {
        const { status } = await retrievalService.findSimilar(idOf.archived, { db });
        assert.equal(status, 404);
    });

    test('409：來源題尚未建立向量，訊息逐字凍結', async () => {
        const { rows } = await pool.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ('數學','向量內積','填空',3,'尚未回填向量的題目','$0$') RETURNING id`
        );
        try {
            const { status, body } = await retrievalService.findSimilar(rows[0].id, { db });
            assert.equal(status, 409);
            assert.equal(body.message, '該題尚未建立向量，請執行 npm run embed:backfill');
        } finally {
            await pool.query('DELETE FROM questions WHERE id = $1', [rows[0].id]);
        }
    });

    test('student_id 查無此人 = 空排除集，正常回結果（不回 404）', async () => {
        const { status, body } = await retrievalService.findSimilar(idOf.dot1, { db, studentId: 999999 });
        assert.equal(status, 200);
        assert.ok(body.results.some(r => r.id === idOf.dot2));
    });

    test('student_id 有效時排除該生已作答的題', async () => {
        const { body } = await retrievalService.findSimilar(idOf.dot1, { db, studentId });
        assert.ok(!body.results.some(r => r.id === idOf.dot2));
    });

    test('scope=chapter（預設）只在同章找；scope=subject 跨章但不跨學科', async () => {
        const inChapter = await retrievalService.findSimilar(idOf.dot1, { db, k: 20 });
        assert.ok(inChapter.body.results.every(r => r.chapter === '向量內積'));

        const inSubject = await retrievalService.findSimilar(idOf.circle_tangent, { db, scope: 'subject', k: 20 });
        assert.ok(inSubject.body.results.every(r => r.subject === '數學'));
        assert.ok(inSubject.body.results.some(r => r.chapter !== '圓方程式'), '跨章時應該看得到其他章的題');

        // 物理題不論怎麼查都不會撈到數學題（裁決 19 之後沒有跨學科這條路）
        const physics = await retrievalService.findSimilar(idOf.centripetal, { db, scope: 'subject', k: 20 });
        assert.ok(physics.body.results.every(r => r.subject === '物理'));
    });

    test('scope=all 已於裁決 19 移除 → 400（不悄悄降級成 subject）', async () => {
        const { status, body } = await retrievalService.findSimilar(idOf.dot1, { db, scope: 'all' });
        assert.equal(status, 400);
        assert.equal(body.message, 'scope 只接受 chapter / subject。');
    });

    test('difficulty_delta 給了就鎖定「來源難度 + delta」', async () => {
        const { body } = await retrievalService.findSimilar(idOf.dot1, { db, difficultyDelta: 1, k: 20 });
        assert.ok(body.results.length > 0);
        assert.ok(body.results.every(r => r.difficulty === 4), JSON.stringify(body.results.map(r => r.difficulty)));
    });

    test('mode=vector 時 kw_rank 全為 null；mode=keyword 時 vec_rank 全為 null', async () => {
        const v = await retrievalService.findSimilar(idOf.dot1, { db, mode: 'vector' });
        assert.equal(v.body.mode, 'vector');
        assert.ok(v.body.results.every(r => r.kw_rank === null));

        const k = await retrievalService.findSimilar(idOf.dot1, { db, mode: 'keyword' });
        assert.ok(k.body.results.every(r => r.vec_rank === null));
    });

    test('mode=keyword 時，來源題沒有向量也照樣可以查（不回 409）', async () => {
        const { rows } = await pool.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ('數學','向量內積','填空',3,'尚未回填向量的題目','$0$') RETURNING id`
        );
        try {
            const { status } = await retrievalService.findSimilar(rows[0].id, { db, mode: 'keyword' });
            assert.equal(status, 200);
        } finally {
            await pool.query('DELETE FROM questions WHERE id = $1', [rows[0].id]);
        }
    });
});

describe('GET /api/questions/:id/similar — 走真的 HTTP', { skip }, () => {
    let db;
    let ctx;
    const flagBackup = process.env.FEATURE_SIMILAR;

    before(async () => {
        db = { pool, query: (t, v) => pool.query(t, v) };
        process.env.FEATURE_SIMILAR = 'true';
        ctx = await startApp(db);
    });

    after(async () => {
        if (flagBackup === undefined) delete process.env.FEATURE_SIMILAR; else process.env.FEATURE_SIMILAR = flagBackup;
        if (ctx) await new Promise(resolve => ctx.server.close(resolve));
    });

    test('200 + 回應形狀，且帶 X-RateLimit 標頭（每分鐘 60 次）', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/${idOf.dot1}/similar?k=3`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-ratelimit-limit'), '60');
        const body = await res.json();
        assert.equal(body.source_id, idOf.dot1);
        assert.equal(body.results[0].id, idOf.dot2);
        assert.ok(body.results.length <= 3);
    });

    test('limit 是 k 的別名；超過 20 會夾到 20', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/${idOf.dot1}/similar?limit=999`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.results.length <= 20);
    });

    test('mode 給錯 → 400（不會默默換成 hybrid）', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/${idOf.dot1}/similar?mode=magic`);
        assert.equal(res.status, 400);
        assert.match((await res.json()).message, /mode 只接受/);
    });

    test('scope=all → 400（裁決 19 已移除跨學科）', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/${idOf.dot1}/similar?scope=all`);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).message, 'scope 只接受 chapter / subject。');
    });

    test('scope=subject → 200（合法值不受影響）', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/${idOf.dot1}/similar?scope=subject`);
        assert.equal(res.status, 200);
    });

    test('404：不存在的 id', async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/questions/999999/similar`);
        assert.equal(res.status, 404);
    });

    test('FEATURE_SIMILAR 關閉時路由不掛載 → 404', async () => {
        process.env.FEATURE_SIMILAR = 'false';
        const off = await startApp(db);
        try {
            const res = await fetch(`http://127.0.0.1:${off.port}/api/questions/${idOf.dot1}/similar`);
            assert.equal(res.status, 404);
        } finally {
            await new Promise(resolve => off.server.close(resolve));
            process.env.FEATURE_SIMILAR = 'true';
        }
    });
});
