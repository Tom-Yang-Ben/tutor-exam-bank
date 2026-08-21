// agents/dedup.js 對真 PostgreSQL 的整合測試（A-T10c / WS-C）
//
// 單元測試（test/unit/agentsGates.test.js）用假的 db 釘住分支邏輯；
// 這一支要驗的是「SQL 真的跑得起來、真的用到索引欄位」——
// questions.text_hash、job_questions.payload->'dedup0'->>'text_hash'、pgvector 的 <=>。
//
// 這一支**需要 PostgreSQL**，因此：
//   - 只讀 TEST_DATABASE_URL，且資料庫名必須以 _test 結尾（與 migrate.js 同一套防呆）
//   - 沒設 TEST_DATABASE_URL 就整組 skip，所以 `npm test` 仍然不連 DB、不需 secrets
//
// 本機執行（先 docker compose up -d --wait && npm run migrate:test）：
//   npm run test:integration
//
// 題目全部是為了測試自行編寫的教科書型例題，不取自任何考卷（見 NOTICE）。

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');

const dedupAgent = require('../../agents/dedup');
const embedService = require('../../services/embedService');
const llm = require('../../services/llm');
const { buildEmbedText } = require('../../utils/embedText');
const { textHash } = require('../../utils/normalizeStem');
const { saveToFixture, sha256Hex } = require('../../services/llm/fixture');

const DIM = 768;                       // migrations/0002_vector.sql 寫死 vector(768)
const MODEL = 'dedup-integration-model';
const URL = process.env.TEST_DATABASE_URL;

const skip = !URL
    ? '未設定 TEST_DATABASE_URL（npm test 本來就不連 DB；要跑這一支請用 npm run test:integration）'
    : (!/_test(\?|$)/.test(URL) ? 'TEST_DATABASE_URL 的資料庫名必須以 _test 結尾' : false);

// ───────────────────────── 測試資料（自行編寫）─────────────────────────

/** 把幾個「概念軸」展開成 768 維單位向量 */
function makeVector(components) {
    const v = new Array(DIM).fill(0);
    components.forEach(([i, x]) => { v[i] = x; });
    const norm = Math.hypot(...v);
    return v.map(x => x / norm);
}

const QUESTIONS = [
    {
        key: 'dot', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的內積。',
        answer_text: '$1$', keywords: ['向量內積'], vec: [[0, 1]],
    },
    {
        // 與 dot 幾乎同向：L1 的 duplicate 候選
        key: 'dot_near', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{u}=(1,2)$、$\\vec{v}=(3,-1)$，求 $\\vec{u}\\cdot\\vec{v}$ 之值。',
        answer_text: '$1$', keywords: ['向量內積'], vec: [[0, 0.999], [1, 0.0447]],
    },
    {
        // 中等接近：L1 的 variant 候選（餘弦約 0.93）
        key: 'dot_variant', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設 $\\vec{a}=(2,5)$、$\\vec{b}=(4,-3)$，求兩向量的內積。',
        answer_text: '$-7$', keywords: ['向量內積'], vec: [[0, 0.93], [1, 0.3676]],
    },
    {
        key: 'circle', subject: '數學', chapter: '圓方程式', question_type: '填空', difficulty: 2,
        question_text: '求圓心為 $(1,2)$、半徑為 $5$ 的圓方程式。',
        answer_text: '$(x-1)^2+(y-2)^2=25$', keywords: ['圓方程式'], vec: [[2, 1]],
    },
    {
        // 物理題：向量與 dot 完全同向，用來證明 L1 的候選限定在同一學科
        key: 'phys', subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
        question_text: '質量 $2$ kg 的物體以等速率 $3$ m/s 作半徑 $0.5$ m 的圓周運動，求向心力。',
        answer_text: '$36$ N', keywords: ['向心力'], vec: [[0, 1]],
    },
    {
        // 已封存：L0 仍要抓到（一年前封存的同一題還是同一題），L1 的候選則排除它
        key: 'archived', subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '此題已封存：求 $\\vec{p}=(7,7)$ 與 $\\vec{q}=(1,-1)$ 的內積。',
        answer_text: '$0$', keywords: ['向量內積'], vec: [[0, 0.998], [3, 0.0632]], archived: true,
    },
];

let pool;
let db;
const idOf = {};
let jobId;
const jqIdOf = {};
let tmpDir;
const envBackup = {};

/** 介面第 3.1 條的 Ctx，llm 走 fixture 模式（不連外） */
function makeCtx(overrides = {}) {
    return {
        llm: { generateJson: async () => { throw new Error('dedup 不該呼叫 generateJson'); }, embed: llm.embed },
        db,
        job: { id: jobId, budget_usd: 0.5, cost_usd: 0 },
        jq: { id: jqIdOf.later, idx: 1002, payload: {}, retries: {} },
        logger: { info() {}, warn() {}, error() {} },
        config: {
            models: { extract: 'x', verify: 'y' },
            limits: {},
            thresholds: { dedupDup: 0.97, dedupVariant: 0.90 },
            features: { similar: true },
        },
        signal: undefined,
        ...overrides,
    };
}

before(async () => {
    if (skip) return;

    pool = new Pool({ connectionString: URL, max: 4 });
    db = { pool, query: (text, values) => pool.query(text, values) };

    const { rows } = await pool.query(
        `SELECT to_regclass('public.questions') AS q, to_regclass('public.job_questions') AS jq`
    );
    assert.ok(rows[0].q, '測試庫尚未套用 migrations，請先執行 npm run migrate:test');
    assert.ok(rows[0].jq, '測試庫缺少 job_questions（migrations/0003_jobs.sql 尚未套用）');

    await pool.query('TRUNCATE job_events, job_questions, jobs, attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');

    for (const q of QUESTIONS) {
        const res = await pool.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    keywords, origin, chapter_src, archived_at, text_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'seed','human',$8,$9) RETURNING id`,
            [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, q.answer_text, q.keywords,
             q.archived ? new Date() : null, textHash(q.question_text)]
        );
        idOf[q.key] = res.rows[0].id;
    }

    // fixture 模式的向量：整合測試同樣不呼叫 Gemini
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-dedup-pg-'));
    for (const k of ['EMBED_FIXTURE_DIR', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM']) envBackup[k] = process.env[k];
    process.env.EMBED_FIXTURE_DIR = tmpDir;
    process.env.EMBED_MODE = 'fixture';
    process.env.EMBED_MODEL = MODEL;
    process.env.EMBED_DIM = String(DIM);

    const { rows: dbRows } = await pool.query(`SELECT ${embedService.SELECT_COLUMNS} FROM questions ORDER BY id`);
    const entries = dbRows.map((row) => {
        const q = QUESTIONS.find(x => idOf[x.key] === row.id);
        return [sha256Hex(buildEmbedText(row)), makeVector(q.vec)];
    });
    // dedup1 對「還沒入庫的新題」是拿 embed_text 現算向量，所以查詢用的文字也要進 fixture
    entries.push([sha256Hex(QUERY_TEXT.dupLike), makeVector([[0, 0.9995], [1, 0.0316]])]);
    entries.push([sha256Hex(QUERY_TEXT.variantLike), makeVector([[0, 0.94], [3, 0.3412]])]);
    entries.push([sha256Hex(QUERY_TEXT.unique), makeVector([[5, 1]])]);
    saveToFixture({ model: MODEL, dim: DIM, entries });

    const res = await embedService.embedByIds(dbRows.map(r => r.id), { db, model: MODEL, dim: DIM });
    assert.equal(res.failed.length, 0, JSON.stringify(res.failed));

    // 一份任務 + 兩列 job_questions：idx 1000 已經寫過 dedup0，1002 是「現在這一題」
    jobId = (await pool.query(
        `INSERT INTO jobs (kind, pdf_sha256, page_count, state, budget_usd)
         VALUES ('pdf', $1, 1, 'processing', 0.5) RETURNING id`,
        ['a'.repeat(64)]
    )).rows[0].id;

    const earlierHash = textHash('同一份考卷裡重複印了兩次的題目：求 $2+2$ 之值。');
    jqIdOf.earlier = (await pool.query(
        `INSERT INTO job_questions (job_id, idx, state, payload)
         VALUES ($1, 1000, 'hashed', $2::jsonb) RETURNING id`,
        [jobId, JSON.stringify({ dedup0: { text_hash: earlierHash, normalized_len: 20, hit: null } })]
    )).rows[0].id;
    jqIdOf.later = (await pool.query(
        `INSERT INTO job_questions (job_id, idx, state) VALUES ($1, 1002, 'extracted') RETURNING id`,
        [jobId]
    )).rows[0].id;
});

after(async () => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (pool) {
        await pool.query('TRUNCATE job_events, job_questions, jobs, attempts, exam_papers, students, questions RESTART IDENTITY CASCADE').catch(() => {});
        await pool.end();
    }
});

/** dedup1 查詢用的 embed_text（要與 fixture 的鍵一致） */
const QUERY_TEXT = {
    dupLike: '數學\n向量內積\n計算\n設 a=(1,2)、b=(3,-1)，求兩向量的內積。',
    variantLike: '數學\n向量內積\n計算\n設 a=(2,5)、b=(4,-3)，求兩向量的內積。',
    unique: '數學\n排列\n計算\n五本不同的書排成一列，有幾種排法？',
};

// ───────────────────────── L0 ─────────────────────────

describe('dedup L0 — 對真 questions.text_hash 與 job_questions', { skip }, () => {
    test('題幹與庫內既有題逐字相同 → fail(duplicate)，scope=db', async () => {
        const out = await dedupAgent.runDedup0(makeCtx(), { question_text: QUESTIONS[0].question_text });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'duplicate');
        assert.equal(out.data.hit.scope, 'db');
        assert.equal(out.data.hit.question_id, idOf.dot);
    });

    test('抄寫方式不同（$、空白、全形括號、A. 選項）仍算重複', async () => {
        const rewritten = '設 $\\vec{a}$=(1,2)、  $\\vec{b}$=(3,-1)，求兩向量的內積。'
            .replace('$\\vec{a}$=(1,2)', '$\\vec{a}=(1,2)$')
            .replace('$\\vec{b}$=(3,-1)', '$\\vec{b}=(3,-1)$');
        const out = await dedupAgent.runDedup0(makeCtx(), { question_text: rewritten });
        assert.equal(out.kind, 'fail', '正規化之後應該收斂成同一個雜湊');
        assert.equal(out.data.hit.question_id, idOf.dot);
    });

    test('已封存的題也算重複（封存不代表可以再收一次）', async () => {
        const out = await dedupAgent.runDedup0(makeCtx(), { question_text: QUESTIONS[5].question_text });
        assert.equal(out.kind, 'fail');
        assert.equal(out.data.hit.question_id, idOf.archived);
    });

    test('撞到同一份任務中 idx 較小的題 → scope=job', async () => {
        const out = await dedupAgent.runDedup0(makeCtx(), {
            question_text: '同一份考卷裡重複印了兩次的題目：求 $2+2$ 之值。',
        });
        assert.equal(out.kind, 'fail');
        assert.equal(out.data.hit.scope, 'job');
        assert.equal(out.data.hit.jq_id, jqIdOf.earlier);
    });

    test('idx 比自己大的列不算（同一份任務只往前看）', async () => {
        const ctx = makeCtx({ jq: { id: jqIdOf.earlier, idx: 1000, payload: {}, retries: {} } });
        const out = await dedupAgent.runDedup0(ctx, {
            question_text: '同一份考卷裡重複印了兩次的題目：求 $2+2$ 之值。',
        });
        assert.equal(out.kind, 'pass', '自己就是最早那一列，不該把自己判成重複');
        assert.equal(out.data.hit, null);
    });

    test('全新的題 → pass，text_hash 寫進 payload', async () => {
        const out = await dedupAgent.runDedup0(makeCtx(), { question_text: '求 $\\log_{3} 81$ 之值。' });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.text_hash, textHash('求 $\\log_{3} 81$ 之值。'));
        assert.equal(out.data.hit, null);
    });
});

// ───────────────────────── L1 ─────────────────────────

describe('dedup L1 — 對真 pgvector', { skip }, () => {
    const inputFor = (embed_text) => ({ question_id: null, embed_text, subject: '數學', chapter: '向量內積' });

    test('餘弦 ≥ 0.97 → fail(duplicate)，top 由大到小', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), inputFor(QUERY_TEXT.dupLike));
        assert.equal(out.kind, 'fail', JSON.stringify(out));
        assert.equal(out.reason, 'duplicate');
        assert.equal(out.data.verdict, 'duplicate');
        assert.ok(out.data.top.length > 0 && out.data.top.length <= 5);
        assert.ok(out.data.top[0].cosine >= 0.97, `最相近的餘弦 ${out.data.top[0].cosine}`);
        for (let i = 1; i < out.data.top.length; i++) {
            assert.ok(out.data.top[i - 1].cosine >= out.data.top[i].cosine, 'top 必須由大到小');
        }
    });

    test('0.90 ≤ 餘弦 < 0.97 → pass(variant)，照常入庫', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), inputFor(QUERY_TEXT.variantLike));
        assert.equal(out.kind, 'pass', JSON.stringify(out));
        assert.equal(out.data.verdict, 'variant');
        assert.equal(out.data.threshold_used, 0.90);
        assert.ok(out.data.top[0].cosine >= 0.90 && out.data.top[0].cosine < 0.97);
    });

    test('都不到門檻 → pass(unique)', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), inputFor(QUERY_TEXT.unique));
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.verdict, 'unique');
    });

    test('候選限定同一學科：物理那題向量同向也不會出現在數學的候選裡', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), inputFor(QUERY_TEXT.dupLike));
        assert.ok(!out.data.top.some(t => t.question_id === idOf.phys), '跨學科的題不該進候選');
    });

    test('候選排除已封存題', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), inputFor(QUERY_TEXT.dupLike));
        assert.ok(!out.data.top.some(t => t.question_id === idOf.archived), '已封存的題不該進候選');
    });

    test('FEATURE_SIMILAR 關掉 → skipped（不查庫、不算向量）', async () => {
        const ctx = makeCtx();
        ctx.config = { ...ctx.config, features: { similar: false } };
        const out = await dedupAgent.runDedup1(ctx, inputFor(QUERY_TEXT.dupLike));
        assert.equal(out.kind, 'skipped');
        assert.equal(out.data.verdict, 'skipped');
    });

    test('來源題有 id 但沒有向量 → skipped', async () => {
        const noVec = (await pool.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin, chapter_src)
             VALUES ('數學','排列','計算',2,'尚未建立向量的題目：$3!$ 之值為何？','$6$','seed','human') RETURNING id`
        )).rows[0].id;
        const out = await dedupAgent.runDedup1(makeCtx(), {
            question_id: noVec, embed_text: QUERY_TEXT.unique, subject: '數學', chapter: '排列',
        });
        assert.equal(out.kind, 'skipped');
        await pool.query('DELETE FROM questions WHERE id = $1', [noVec]);
    });

    test('question_id 給了且該題有向量 → 用它的向量，且結果排除自己', async () => {
        const out = await dedupAgent.runDedup1(makeCtx(), {
            question_id: idOf.dot, embed_text: '', subject: '數學', chapter: '向量內積',
        });
        assert.ok(['pass', 'fail'].includes(out.kind), JSON.stringify(out));
        assert.ok(!out.data.top.some(t => t.question_id === idOf.dot), '不該把來源題自己列為候選');
        assert.equal(out.data.top[0].question_id, idOf.dot_near, '最相近的應該是 dot_near');
    });
});
