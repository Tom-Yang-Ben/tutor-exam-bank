// eval/lib/pooling.js 單元測試 —— LIKE 基準欄的關鍵字規則與候選池
//
// 為什麼要測：LIKE 欄是 hybrid 的對照組。規則若能被悄悄調鬆（多取幾個關鍵字、
// 不去掉章節行），hybrid 的相對優勢就可以被憑空製造出來，而報表上完全看不出來。
// 這一支把規則的三個可爭議點釘死：取幾個、多長算數、「去章節」到底去掉什麼。
//
// 候選池的部分測的是**可重現性**：同一題重跑一定抽到同一批同章隨機題。
// 沒有這條，人工標好的 golden 在下次重建候選池時就對不上了。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    likeKeywords, stripMetaLine, buildPool, mulberry32,
    LIKE_KEYWORD_COUNT, LIKE_MIN_TOKEN_LEN, POOL_RANDOM_SAME_CHAPTER
} = require('../../eval/lib/pooling');

describe('stripMetaLine（「去章節」的落地定義）', () => {
    test('去掉的是第 1 行整行，不是只挖掉章節字串', () => {
        const embedText = '數學｜向量內積｜計算｜難度3\n設向量 a=(3,4)，求內積';
        assert.equal(stripMetaLine(embedText), '設向量 a=(3,4)，求內積');
    });

    test('只有一行（沒有題幹）時回空字串，不回那一行中繼資料', () => {
        // 若這裡回中繼行，每一題的關鍵字都會變成「數學」「填空」之類，彼此完全無法區辨
        assert.equal(stripMetaLine('數學｜向量內積｜計算｜難度3'), '');
    });

    test('null / undefined 不丟例外', () => {
        assert.equal(stripMetaLine(null), '');
        assert.equal(stripMetaLine(undefined), '');
    });

    test('題幹有多行時全部保留', () => {
        assert.equal(stripMetaLine('meta\n第一行\n第二行'), '第一行\n第二行');
    });
});

describe('likeKeywords（凍結規則）', () => {
    const q = {
        subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '設平面向量 $\\vec{a} = (3, 4)$、$\\vec{b} = (1, 2)$，求 $\\vec{a} \\cdot \\vec{b}$。'
    };

    test('最多取 3 個關鍵字', () => {
        assert.equal(LIKE_KEYWORD_COUNT, 3);
        assert.ok(likeKeywords(q).length <= 3);
    });

    test('每個關鍵字長度都 ≥ 2', () => {
        assert.equal(LIKE_MIN_TOKEN_LEN, 2);
        for (const kw of likeKeywords(q)) assert.ok(kw.length >= 2, `「${kw}」太短`);
    });

    test('關鍵字不重複（同一個詞 OR 兩次不會多召回任何一題）', () => {
        const kws = likeKeywords(q);
        assert.equal(kws.length, new Set(kws).size);
    });

    test('關鍵字只來自題幹，不會取到章節或題型', () => {
        // 「向量內積」是章節名、「計算」是題型，都在被去掉的第 1 行
        const kws = likeKeywords({ ...q, question_text: '甲乙丙丁戊己' });
        assert.ok(!kws.includes('計算'));
        assert.ok(!kws.includes('內積'));
    });

    test('沒有題幹時回空陣列（不硬湊關鍵字）', () => {
        assert.deepEqual(likeKeywords({ ...q, question_text: '' }), []);
    });

    test('同一題重跑結果相同（純函式）', () => {
        assert.deepEqual(likeKeywords(q), likeKeywords(q));
    });
});

describe('buildPool（候選池）', () => {
    const questions = [
        { id: 1, subject: '數學', chapter: '向量內積', question_text: 'a' },
        { id: 2, subject: '數學', chapter: '向量內積', question_text: 'b' },
        { id: 3, subject: '數學', chapter: '向量內積', question_text: 'c' },
        { id: 4, subject: '數學', chapter: '向量內積', question_text: 'd' },
        { id: 5, subject: '數學', chapter: '向量內積', question_text: 'e' },
        { id: 6, subject: '數學', chapter: '向量內積', question_text: 'f' },
        { id: 7, subject: '數學', chapter: '空間向量內積', question_text: 'g' },
        { id: 8, subject: '物理', chapter: '直線運動', question_text: 'h' }
    ];
    const query = questions[0];

    test('query 題本身永遠不進池（--exclude-self）', () => {
        const pool = buildPool({
            query, questions,
            vectorNeighbours: () => [1, 2, 3],
            keywordHits: () => [1, 4]
        });
        assert.ok(!pool.some(p => p.id === 1));
    });

    test('三個來源會合併並記錄在 sources 裡', () => {
        const pool = buildPool({ query, questions, vectorNeighbours: () => [2], keywordHits: () => [2, 7] });
        const two = pool.find(p => p.id === 2);
        assert.ok(two.sources.includes('vector'));
        assert.ok(two.sources.includes('keyword'));
        const seven = pool.find(p => p.id === 7);
        assert.deepEqual(seven.sources, ['keyword']);   // 跨章題只可能從關鍵字那一路進來
    });

    test('缺向量那一路時仍可建池，只是池子小一點', () => {
        const pool = buildPool({ query, questions, vectorNeighbours: null, keywordHits: () => [7] });
        assert.ok(pool.length > 0);
        assert.ok(!pool.some(p => p.sources.includes('vector')));
    });

    test('同章隨機最多取 5 題，且只取同學科同章', () => {
        const pool = buildPool({ query, questions });
        const randoms = pool.filter(p => p.sources.includes('same_chapter_random'));
        assert.ok(randoms.length <= POOL_RANDOM_SAME_CHAPTER);
        for (const r of randoms) {
            const q = questions.find(x => x.id === r.id);
            assert.equal(q.chapter, '向量內積');
        }
    });

    test('同一題重跑抽到同一批（種子固定，否則人工標註每次都對不上）', () => {
        const a = buildPool({ query, questions }).map(p => p.id);
        const b = buildPool({ query, questions }).map(p => p.id);
        assert.deepEqual(a, b);
    });

    test('不同 query 抽到的同章隨機不同（種子綁 query.id，不是全域同一批）', () => {
        const p1 = buildPool({ query: questions[0], questions }).map(p => p.id).join(',');
        const p2 = buildPool({ query: questions[1], questions }).map(p => p.id).join(',');
        assert.notEqual(p1, p2);
    });

    test('輸出依 id 升冪，方便人工逐筆看與 diff', () => {
        const ids = buildPool({ query, questions, keywordHits: () => [8, 7, 3] }).map(p => p.id);
        assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    });
});

describe('mulberry32', () => {
    test('同種子同序列、不同種子不同序列', () => {
        const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
        const seqA = [a(), a(), a()];
        const seqB = [b(), b(), b()];
        const seqC = [c(), c(), c()];
        assert.deepEqual(seqA, seqB);
        assert.notDeepEqual(seqA, seqC);
    });

    test('輸出落在 [0, 1)', () => {
        const r = mulberry32(7);
        for (let i = 0; i < 200; i++) {
            const v = r();
            assert.ok(v >= 0 && v < 1);
        }
    });
});
