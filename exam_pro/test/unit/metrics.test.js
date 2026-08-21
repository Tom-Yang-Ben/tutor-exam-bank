// eval/lib/metrics.js 單元測試
//
// 為什麼要測：三欄對照（LIKE / 向量 / hybrid）的每一個數字都從這四個純函式出來，
// 而指標算錯**不會噴錯**——它只會讓 CI 門檻守著一個錯的基準線，
// 或讓「hybrid 比 LIKE 好」變成計算方式造成的假象。
// 邊界（relevant 為空、名次有重複 id、K 大於候選數）在這裡一次釘死。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { recallAtK, reciprocalRank, jaccard, summarize, mean, round4 } = require('../../eval/lib/metrics');

describe('recallAtK', () => {
    test('前 K 名全中時為 1', () => {
        assert.equal(recallAtK([1, 2, 3], [1, 2], 5), 1);
    });

    test('只算前 K 名，第 K+1 名之後的命中不計入', () => {
        // 相關題有 2 個，其中 id=9 落在第 6 名，Recall@5 只能拿到一半
        assert.equal(recallAtK([1, 2, 3, 4, 5, 9], [1, 9], 5), 0.5);
        assert.equal(recallAtK([1, 2, 3, 4, 5, 9], [1, 9], 10), 1);
    });

    test('完全沒命中為 0', () => {
        assert.equal(recallAtK([1, 2, 3], [7], 5), 0);
    });

    test('relevant 為空回 null 而非 0（沒有正確答案 ≠ 一題都沒找到）', () => {
        assert.equal(recallAtK([1, 2, 3], [], 5), null);
        assert.equal(recallAtK([1, 2, 3], undefined, 5), null);
    });

    test('排名裡出現重複 id 只算一次，Recall 不會超過 1', () => {
        assert.equal(recallAtK([1, 1, 1], [1, 2], 5), 0.5);
    });

    test('id 為字串時仍能與數字對上（golden 手寫容易寫成字串）', () => {
        assert.equal(recallAtK(['1', '2'], [1], 5), 1);
    });

    test('候選數少於 K 時不補零、不報錯', () => {
        assert.equal(recallAtK([1], [1], 10), 1);
        assert.equal(recallAtK([], [1], 10), 0);
    });

    test('k 不是正整數就丟錯', () => {
        assert.throws(() => recallAtK([1], [1], 0), /正整數/);
        assert.throws(() => recallAtK([1], [1], 2.5), /正整數/);
    });
});

describe('reciprocalRank', () => {
    test('第一名命中為 1，第三名命中為 1/3', () => {
        assert.equal(reciprocalRank([5, 1, 2], [5]), 1);
        assert.equal(reciprocalRank([1, 2, 5], [5]), 1 / 3);
    });

    test('取「第一個」命中的名次，不是最好的那一個', () => {
        assert.equal(reciprocalRank([9, 5], [5, 9]), 1);
    });

    test('完全沒命中為 0；relevant 為空為 null', () => {
        assert.equal(reciprocalRank([1, 2], [7]), 0);
        assert.equal(reciprocalRank([1, 2], []), null);
    });
});

describe('jaccard', () => {
    test('完全相同為 1、完全不相交為 0', () => {
        assert.equal(jaccard([1, 2, 3], [3, 2, 1]), 1);
        assert.equal(jaccard([1, 2], [3, 4]), 0);
    });

    test('前 10 名換掉 1 個時 ≈ 0.818，換掉 0 個才是 1', () => {
        // D-R2 的門檻是 ≥ 0.9：10 取 10 中換掉 1 個就已經低於門檻，
        // 也就是「SQL 與記憶體排序器最多只能差一名之內的抖動」。
        const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11];
        assert.equal(round4(jaccard(a, b)), 0.8182);
        assert.ok(jaccard(a, b) < 0.9);
    });

    test('兩邊都空定義為 1，不是 NaN', () => {
        assert.equal(jaccard([], []), 1);
    });

    test('順序不影響結果（比的是集合不是名次）', () => {
        assert.equal(jaccard([1, 2, 3], [2, 3, 1]), 1);
    });
});

describe('summarize / mean', () => {
    test('relevant 為空的題不進分母，並在 scored 反映出來', () => {
        const out = summarize([
            { ranked: [2], relevant: [2] },   // 全中
            { ranked: [3], relevant: [] },    // 沒有正確答案，整題跳過
            { ranked: [9], relevant: [8] }    // 全不中
        ]);
        assert.equal(out.n, 3);
        assert.equal(out.scored, 2);
        assert.equal(out.recall5, 0.5);
        assert.equal(out.mrr, 0.5);
    });

    test('全部沒有相關題時回 null，不是 0（避免報表印出假的 0.0000）', () => {
        const out = summarize([{ ranked: [1], relevant: [] }]);
        assert.equal(out.scored, 0);
        assert.equal(out.recall5, null);
        assert.equal(out.mrr, null);
    });

    test('mean 忽略 null', () => {
        assert.equal(mean([1, null, 0]), 0.5);
        assert.equal(mean([]), null);
    });
});

describe('round4', () => {
    test('四位小數，null 原樣傳回', () => {
        assert.equal(round4(1 / 3), 0.3333);
        assert.equal(round4(null), null);
    });
});
