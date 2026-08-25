// queries/hybrid.js 單元測試（WS-C / D-R1）
//
// 這裡只測「組出來的 SQL 與參數」——不連 DB。真的跑在 PG 上的行為在
// test/integration/hybrid.pg.test.js（沒設 TEST_DATABASE_URL 就整組 skip）。
//
// 為什麼要把 SQL 字串當契約測：interfaces-stage1.md 第 5 條列了幾條「否則 eval 與 API 會量到不同東西」
// 的實作約束（先 ORDER BY 再 LIMIT、NOT EXISTS 而非 NOT IN、SQL 端 quote_literal），
// 這些一旦被改掉，功能測試不會紅，但量測結果會悄悄失真。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildHybridQuery, SIDE_LIMIT, RRF_K } = require('../../queries/hybrid');

const DIM = Number.parseInt(process.env.EMBED_DIM || '768', 10);
const VEC = new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0));

const BASE = {
    subject: '數學',
    chapter: '向量內積',
    difficultyMin: 2,
    difficultyMax: 4,
    excludeStudentId: null,
    excludeIds: [],
    queryVector: VEC,
    queryTokens: ['向量', '內積'],
    mode: 'rrf',
    limit: 10,
};

describe('buildHybridQuery — 回傳形狀', () => {
    test('回 { text, values }，text 是字串、values 是陣列', () => {
        const q = buildHybridQuery(BASE);
        assert.equal(typeof q.text, 'string');
        assert.ok(Array.isArray(q.values));
    });

    test('SQL 裡的最大 $n 等於 values 的長度（沒有多給也沒有少給參數）', () => {
        const q = buildHybridQuery({ ...BASE, mode: 'weighted', excludeIds: [1, 2], excludeStudentId: 7 });
        const max = Math.max(...[...q.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
        assert.equal(max, q.values.length);
    });

    test('向量以 pgvector.toSql 轉成字串傳入，不把 JS 陣列丟給 pg', () => {
        const q = buildHybridQuery(BASE);
        const vecParam = q.values.find(v => typeof v === 'string' && v.startsWith('['));
        assert.ok(vecParam, '找不到序列化後的向量參數');
        assert.ok(!q.values.some(v => Array.isArray(v) && typeof v[0] === 'number' && v.length === DIM));
    });
});

describe('buildHybridQuery — interfaces-stage1.md 第 5 條的實作約束', () => {
    const sql = buildHybridQuery(BASE).text;

    test('候選 CTE 含 archived_at IS NULL', () => {
        assert.match(sql, /archived_at IS NULL/);
    });

    test('排除某生已作答用 NOT EXISTS，不是 NOT IN', () => {
        assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM attempts/);
        assert.ok(!/NOT IN \(\s*SELECT/.test(sql));
    });

    test('excludeIds 以 = ANY($n::int[]) 排除', () => {
        assert.match(sql, /NOT \(q\.id = ANY\(\$\d+::int\[\]\)\)/);
    });

    test(`兩側都先 ORDER BY 再 LIMIT ${SIDE_LIMIT}`, () => {
        const vecSide = sql.slice(sql.indexOf('vec AS'), sql.indexOf('tq AS'));
        const kwSide = sql.slice(sql.indexOf('kw AS'));
        assert.match(vecSide, /ORDER BY q\.embedding <=>[\s\S]*LIMIT 50/);
        assert.match(kwSide, /ORDER BY ts_rank_cd[\s\S]*LIMIT 50/);
    });

    test('關鍵字查詢詞在 SQL 端以 quote_literal 組裝', () => {
        assert.match(sql, /to_tsquery\('simple', string_agg\(quote_literal\(t\), ' \| '\)\)/);
        assert.match(sql, /FROM unnest\(\$\d+::text\[\]\) t/);
    });

    test('兩側 FULL OUTER JOIN，最後 ORDER BY score DESC, id ASC', () => {
        assert.match(sql, /FULL OUTER JOIN/);
        assert.match(sql, /ORDER BY score DESC, id ASC/);
    });

    test('rank 轉成 int、score 轉成 float8（避免 pg 把 int8/numeric 回成字串）', () => {
        assert.match(sql, /vec\.r::int AS vec_rank/);
        assert.match(sql, /kw\.r::int\s+AS kw_rank/);
        assert.match(sql, /::float8 AS score/);
    });

    test(`RRF 的分數是 1/(${RRF_K}+rank) 兩側相加，缺席側以 0 計`, () => {
        assert.match(sql, /COALESCE\(1\.0 \/ \(60 \+ vec\.r\), 0\) \+ COALESCE\(1\.0 \/ \(60 \+ kw\.r\), 0\)/);
    });

    test('weighted 模式是 0.7 向量 + 0.3 關鍵字，兩側各自 min-max 正規化', () => {
        const w = buildHybridQuery({ ...BASE, mode: 'weighted' }).text;
        assert.match(w, /0\.7 \* COALESCE\(vec_n\.n, 0\) \+ 0\.3 \* COALESCE\(kw_n\.n, 0\)/);
        assert.match(w, /min\(raw\) OVER \(\)/);
        assert.match(w, /max\(raw\) OVER \(\)/);
    });
});

describe('buildHybridQuery — sides（/similar 的 mode=vector|keyword）', () => {
    test('sides=[vec] 時關鍵字側是空集合，且不需要 queryTokens', () => {
        const q = buildHybridQuery({ ...BASE, sides: ['vec'], queryTokens: [] });
        assert.match(q.text, /kw AS \(SELECT NULL::int AS id/);
    });

    test('sides=[kw] 時不需要 queryVector', () => {
        const q = buildHybridQuery({ ...BASE, sides: ['kw'], queryVector: null });
        assert.match(q.text, /vec AS \(SELECT NULL::int AS id/);
        assert.ok(!q.values.some(v => typeof v === 'string' && v.startsWith('[')));
    });

    test('兩側都關掉 → 丟錯', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, sides: [] }), /至少要有一側/);
    });
});

describe('buildHybridQuery — 參數檢查', () => {
    test('subject 必填', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, subject: '' }), /subject 為必填/);
        assert.throws(() => buildHybridQuery({ ...BASE, subject: undefined }), /subject 為必填/);
    });

    test('chapter 可以是 null（不限章），但不能是數字', () => {
        assert.doesNotThrow(() => buildHybridQuery({ ...BASE, chapter: null }));
        assert.throws(() => buildHybridQuery({ ...BASE, chapter: 3 }), /chapter 必須是字串或 null/);
    });

    test('mode 只能是 rrf 或 weighted', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, mode: 'hybrid' }), /mode 只能是/);
    });

    test('difficulty 必須是 1~5 且 min ≤ max', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, difficultyMin: 0 }), /difficultyMin/);
        assert.throws(() => buildHybridQuery({ ...BASE, difficultyMax: 6 }), /difficultyMax/);
        assert.throws(() => buildHybridQuery({ ...BASE, difficultyMin: 4, difficultyMax: 2 }), /不得大於/);
    });

    test('limit 必須是 1~50 的整數', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, limit: 0 }), /limit/);
        assert.throws(() => buildHybridQuery({ ...BASE, limit: 51 }), /limit/);
        assert.throws(() => buildHybridQuery({ ...BASE, limit: 2.5 }), /limit/);
    });

    test('queryVector 長度必須等於 EMBED_DIM', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, queryVector: [1, 2, 3] }), new RegExp(`EMBED_DIM\\(${DIM}\\)`));
        assert.throws(() => buildHybridQuery({ ...BASE, queryVector: null }), /queryVector/);
    });

    test('queryTokens 必須是陣列；空陣列合法（關鍵字側自然空集合）', () => {
        assert.throws(() => buildHybridQuery({ ...BASE, queryTokens: '向量' }), /queryTokens/);
        assert.doesNotThrow(() => buildHybridQuery({ ...BASE, queryTokens: [] }));
    });

    test('excludeIds 預設 []，非陣列則丟錯', () => {
        const q = buildHybridQuery({ ...BASE, excludeIds: undefined });
        assert.ok(q.values.some(v => Array.isArray(v) && v.length === 0));
        assert.throws(() => buildHybridQuery({ ...BASE, excludeIds: 5 }), /excludeIds/);
    });

    test('excludeStudentId 可為 null 或整數', () => {
        assert.doesNotThrow(() => buildHybridQuery({ ...BASE, excludeStudentId: 3 }));
        assert.throws(() => buildHybridQuery({ ...BASE, excludeStudentId: 'abc' }), /excludeStudentId/);
    });

    test('空白 token 會被濾掉，不會送出空字串給 to_tsquery', () => {
        const q = buildHybridQuery({ ...BASE, queryTokens: ['向量', '  ', ''] });
        const tokens = q.values.find(v => Array.isArray(v) && typeof v[0] === 'string');
        assert.deepEqual(tokens, ['向量']);
    });
});
