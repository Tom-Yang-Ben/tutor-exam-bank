// eval/lib/ranker.js 單元測試 —— 記憶體排序器
//
// 這支排序器有兩個角色：LIKE 欄的唯一算法，以及 D-R2 裡「SQL 有沒有算對」的對照組。
// 對照組自己算錯，是最糟的情況——兩邊一起錯的時候 Jaccard 反而會是 1。
// 所以融合公式照 docs/interfaces.md 第 5 條**逐項對數字**，不只測「有排序」。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { candidates, rankLike, rankVector, rankKeyword, fuse, cosine, RRF_K } = require('../../eval/lib/ranker');

const Q = (id, chapter, text, subject = '數學') => ({
    id, subject, chapter, question_type: '計算', difficulty: 3, question_text: text, answer_text: 'a'
});

const QUESTIONS = [
    Q(1, '向量內積', '設平面向量 a=(3,4)，求內積'),
    Q(2, '向量內積', '設平面向量 a=(5,2)，求內積'),
    Q(3, '向量內積', '試證柯西不等式'),
    Q(4, '空間向量內積', '設空間向量 a=(1,2,3)，求內積'),
    Q(5, '直線運動', '自由落體落地時間', '物理')
];

describe('candidates（候選集，對齊 queries/hybrid.js 的候選 CTE）', () => {
    const source = QUESTIONS[0];

    test('scope=chapter 只留同章', () => {
        const ids = candidates({ source, questions: QUESTIONS, scope: 'chapter' }).map(q => q.id);
        assert.deepEqual(ids, [1, 2, 3]);
    });

    test('scope=subject 留同學科的全部章節（跨章干擾題才進得來）', () => {
        const ids = candidates({ source, questions: QUESTIONS, scope: 'subject' }).map(q => q.id);
        assert.deepEqual(ids, [1, 2, 3, 4]);
    });

    test('scope=all 連別的學科都留', () => {
        const ids = candidates({ source, questions: QUESTIONS, scope: 'all' }).map(q => q.id);
        assert.deepEqual(ids, [1, 2, 3, 4, 5]);
    });

    test('excludeIds 會被排除（--exclude-self 就是靠它）', () => {
        const ids = candidates({ source, questions: QUESTIONS, scope: 'subject', excludeIds: [1, 3] }).map(q => q.id);
        assert.deepEqual(ids, [2, 4]);
    });

    test('預設 scope 是 subject', () => {
        const ids = candidates({ source, questions: QUESTIONS }).map(q => q.id);
        assert.deepEqual(ids, [1, 2, 3, 4]);
    });
});

describe('rankLike', () => {
    test('命中越多關鍵字排越前，同分時 id 小的在前', () => {
        const source = Q(1, '向量內積', '甲乙丙丁');
        const docs = [
            Q(10, '向量內積', '甲乙'),          // 中 1 個
            Q(11, '向量內積', '甲乙丙丁'),      // 中 2 個（甲乙、丙丁）
            Q(12, '向量內積', '甲乙丙丁')       // 同上，id 較大
        ];
        // stub 分詞器對「甲乙丙丁」會切出「甲乙」「丙丁」兩個 bigram
        const out = rankLike(source, docs);
        assert.equal(out[0].id, 11);
        assert.equal(out[1].id, 12);
        assert.equal(out[out.length - 1].id, 10);
    });

    test('一個關鍵字都沒中的題不進結果（不是排在最後）', () => {
        const source = Q(1, '向量內積', '甲乙丙丁');
        const out = rankLike(source, [Q(20, '向量內積', '完全無關的字')]);
        assert.deepEqual(out, []);
    });

    test('題幹為空時關鍵字為空，直接回空陣列而不是回全部候選', () => {
        const out = rankLike(Q(1, '向量內積', ''), QUESTIONS);
        assert.deepEqual(out, []);
    });
});

describe('cosine / rankVector', () => {
    test('同向為 1、正交為 0、反向為 -1', () => {
        assert.equal(cosine([1, 0], [1, 0]), 1);
        assert.equal(cosine([1, 0], [0, 1]), 0);
        assert.equal(cosine([1, 0], [-1, 0]), -1);
    });

    test('未正規化的向量也算得出正確餘弦（不假設輸入已 L2 正規化）', () => {
        assert.equal(cosine([3, 0], [10, 0]), 1);
    });

    test('零向量回 0 而不是 NaN', () => {
        assert.equal(cosine([0, 0], [1, 1]), 0);
    });

    test('rankVector 依餘弦由大到小，沒有向量的題不進向量側', () => {
        const vecs = new Map([[1, [1, 0]], [2, [0.9, 0.1]], [4, [0, 1]]]);
        const out = rankVector([1, 0], QUESTIONS.slice(0, 4), q => vecs.get(q.id) || null);
        assert.deepEqual(out.map(r => r.id), [1, 2, 4]);
        assert.ok(!out.some(r => r.id === 3));   // id=3 沒有向量
    });
});

describe('rankKeyword', () => {
    test('queryTokens 為空時安全回空集合（interfaces 第 5 條的硬性要求）', () => {
        assert.deepEqual(rankKeyword([], QUESTIONS), []);
        assert.deepEqual(rankKeyword(['a'], QUESTIONS), []);   // 長度 < 2 的 token 一律不算
    });

    test('完全沒命中的題不進關鍵字側', () => {
        const out = rankKeyword(['橢圓'], [Q(30, '向量內積', '自由落體')]);
        assert.deepEqual(out, []);
    });

    test('關鍵字側比對的是整段 embed_text（含章節那一行），不是只有題幹', () => {
        // 這是刻意的：search_tsv 由 embed_text 分詞後寫入（interfaces 第 2、5 條），
        // 章節名本來就在索引裡，所以同章的題會因章節詞而互相命中。
        // 記憶體排序器必須跟著這個定義走，否則它就不是 SQL 的對照組。
        const out = rankKeyword(['內積'], [Q(30, '向量內積', '自由落體')]);
        assert.equal(out.length, 1);
        assert.equal(out[0].id, 30);
    });
});

describe('fuse（融合公式逐項對數字）', () => {
    const vectorRows = [{ id: 1, score: 0.9 }, { id: 2, score: 0.8 }, { id: 3, score: 0.1 }];
    const keywordRows = [{ id: 3, score: 5 }, { id: 1, score: 1 }];

    test('rrf：score = 1/(60+vec_rank) + 1/(60+kw_rank)，缺席側以 0 計', () => {
        assert.equal(RRF_K, 60);
        const out = fuse({ vectorRows, keywordRows, mode: 'rrf', limit: 10 });
        const byId = new Map(out.map(r => [r.id, r]));
        assert.ok(Math.abs(byId.get(1).score - (1 / 61 + 1 / 62)) < 1e-12);   // 向量第 1、關鍵字第 2
        assert.ok(Math.abs(byId.get(2).score - (1 / 62)) < 1e-12);            // 只有向量側
        assert.ok(Math.abs(byId.get(3).score - (1 / 63 + 1 / 61)) < 1e-12);   // 向量第 3、關鍵字第 1
    });

    test('rrf 的 vec_rank / kw_rank 缺席時是 null 而不是 0', () => {
        const out = fuse({ vectorRows, keywordRows, mode: 'rrf' });
        const two = out.find(r => r.id === 2);
        assert.equal(two.vec_rank, 2);
        assert.equal(two.kw_rank, null);
    });

    test('排序是 score DESC, id ASC——分數相同時由 id 決定，不是由輸入順序決定', () => {
        // id=7 只在向量側第 1 名、id=3 只在關鍵字側第 1 名 → 兩者 RRF 分數都是 1/61
        const out = fuse({
            vectorRows: [{ id: 7, score: 1 }],
            keywordRows: [{ id: 3, score: 1 }],
            mode: 'rrf'
        });
        assert.equal(out[0].score, out[1].score);
        assert.deepEqual(out.map(r => r.id), [3, 7]);
    });

    test('fuse 不會替兩側重排——名次就是傳進來的順序（重排是 rankVector/rankKeyword 的責任）', () => {
        const out = fuse({ vectorRows: [{ id: 5, score: 1 }, { id: 2, score: 1 }], keywordRows: [], mode: 'rrf' });
        assert.deepEqual(out.map(r => r.id), [5, 2]);
    });

    test('weighted：0.7×向量側 + 0.3×關鍵字側，兩側各自 min-max 正規化', () => {
        const out = fuse({ vectorRows, keywordRows, mode: 'weighted', limit: 10 });
        const byId = new Map(out.map(r => [r.id, r]));
        // 向量側 min-max：0.9→1、0.8→0.875、0.1→0；關鍵字側：5→1、1→0
        assert.ok(Math.abs(byId.get(1).score - (0.7 * 1 + 0.3 * 0)) < 1e-12);
        assert.ok(Math.abs(byId.get(2).score - (0.7 * 0.875)) < 1e-12);
        assert.ok(Math.abs(byId.get(3).score - (0.7 * 0 + 0.3 * 1)) < 1e-12);
    });

    test('weighted 遇到單一元素的側（min=max）不會除以 0', () => {
        const out = fuse({ vectorRows: [{ id: 1, score: 0.5 }], keywordRows: [], mode: 'weighted' });
        assert.equal(out[0].score, 0.7);
    });

    test('limit 生效', () => {
        assert.equal(fuse({ vectorRows, keywordRows, mode: 'rrf', limit: 2 }).length, 2);
    });
});
