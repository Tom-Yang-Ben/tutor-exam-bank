// eval/lib/ranker.js 單元測試 —— 記憶體排序器
//
// 這支排序器有兩個角色：LIKE 欄的唯一算法，以及 D-R2 裡「SQL 有沒有算對」的對照組。
// 對照組自己算錯，是最糟的情況——兩邊一起錯的時候 Jaccard 反而會是 1。
// 所以融合公式照 docs/interfaces-stage1.md 第 5 條**逐項對數字**，不只測「有排序」。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { candidates, rankLike, rankVector, rankKeyword, queryTokensFor, fuse, cosine, RRF_K } = require('../../eval/lib/ranker');
const { likeKeywords } = require('../../eval/lib/pooling');
const { buildTsvTokens } = require('../../services/embedService');

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
        // 這個測試刻意**不寫死任何分詞結果**：關鍵字直接向 likeKeywords() 要，
        // 再拿真正被選中的詞去組候選題。分詞器換掉（bigram stub → jieba → 未來換詞典）
        // 都不影響它，而它要守的「命中多的排前面、同分看 id」完全沒有被放寬。
        const source = Q(1, '向量內積', '設平面向量的內積與夾角，並求其正射影長度');
        const kws = likeKeywords(source);
        assert.ok(kws.length >= 2, `題幹要能切出至少 2 個關鍵字才測得出排序，實際：${JSON.stringify(kws)}`);

        const docs = [
            Q(10, '向量內積', `只出現一個：${kws[0]}`),
            Q(11, '向量內積', `兩個都出現：${kws[0]}／${kws[1]}`),
            Q(12, '向量內積', `兩個都出現：${kws[0]}／${kws[1]}`)   // 與 11 同分，id 較大
        ];
        const out = rankLike(source, docs);
        assert.deepEqual(out.map(r => r.id), [11, 12, 10]);
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
        const out = rankKeyword(['橢圓錐線'], [Q(30, '向量內積', '自由落體')]);
        assert.deepEqual(out, []);
    });

    test('比對的是 embedService.buildTsvTokens() 的三段，章節段也算命中', () => {
        // 這是刻意的：search_tsv = 章節 A ‖ keywords A ‖ 題幹 B（interfaces 第 2 條、裁決 21），
        // 章節名本來就在索引裡，所以同章的題會因章節詞而互相命中。
        // 記憶體排序器必須跟著這個定義走，否則它就不是 SQL 的對照組。
        //
        // token 從 buildTsvTokens 現場取，不寫死「內積」之類的字串——
        // jieba 把「向量內積」當一個自訂詞，寫死子字串的斷言換分詞器就會假性失敗。
        const doc = Q(30, '向量內積', '自由落體');
        const { chapterTokens, stemTokens } = buildTsvTokens(doc);
        assert.ok(chapterTokens.length > 0);

        const byChapter = rankKeyword([chapterTokens[0]], [doc]);
        assert.deepEqual(byChapter.map(r => r.id), [30], '章節段的詞應該命中');

        const byStem = rankKeyword([stemTokens[0]], [doc]);
        assert.deepEqual(byStem.map(r => r.id), [30], '題幹段的詞也應該命中');
    });

    test('章節段（權重 A）的命中比題幹段（權重 B）分數高', () => {
        // ts_rank 的預設權重 A=1.0 > B=0.4。記憶體端若一視同仁，
        // 排序就會與 SQL 分歧，而分歧只會表現成 D-R2 的 Jaccard 掉下來。
        const doc = Q(30, '向量內積', '自由落體運動的加速度');
        const { chapterTokens, stemTokens } = buildTsvTokens(doc);
        const a = rankKeyword([chapterTokens[0]], [doc])[0].score;
        const b = rankKeyword([stemTokens[0]], [doc])[0].score;
        assert.ok(a > b, `章節段 ${a} 應該大於題幹段 ${b}`);
    });
});

describe('queryTokensFor（對齊 retrievalService 的查詢詞規則）', () => {
    test('優先取權重 A 的那兩段（章節 + keywords），不是整段題幹', () => {
        const q = { ...Q(1, '向量內積', '設平面向量的內積'), keywords: ['夾角', '正射影'] };
        const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(q);
        const tokens = queryTokensFor(q);
        assert.deepEqual(tokens, [...new Set([...chapterTokens, ...keywordTokens])]);
        // 題幹裡有、但權重 A 兩段沒有的詞，不該出現在查詢詞裡
        const onlyStem = stemTokens.filter(t => !tokens.includes(t));
        for (const t of onlyStem) assert.ok(!tokens.includes(t));
    });

    test('章節與 keywords 都切不出東西時才退回題幹', () => {
        const q = { subject: '數學', chapter: '', question_type: '計算', difficulty: 3, question_text: '自由落體' };
        const { stemTokens } = buildTsvTokens(q);
        assert.deepEqual(queryTokensFor(q), stemTokens);
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
