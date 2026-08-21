// 階段 2 新增指標的單元測試（A-T14）
//
// accuracy／macro-F1／混淆對是 --suite classify 三個數字的唯一來源，
// percentile 是 pipeline suite 與 report:jobs 的 p50／p95 的來源。
// 算錯了整張表都是錯的，卻不會有任何症狀——所以在這裡把它們釘死。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../../eval/lib/metrics');

describe('accuracy', () => {
    test('全對、全錯、一半', () => {
        assert.equal(m.accuracy([{ gold: 'a', pred: 'a' }, { gold: 'b', pred: 'b' }]).accuracy, 1);
        assert.equal(m.accuracy([{ gold: 'a', pred: 'b' }, { gold: 'b', pred: 'a' }]).accuracy, 0);
        assert.equal(m.accuracy([{ gold: 'a', pred: 'a' }, { gold: 'b', pred: 'a' }]).accuracy, 0.5);
    });

    test('空陣列回 null 而不是 0', () => {
        // 「沒有題目」與「一題都沒對」是兩件事；混成同一個數字，
        // 「cassette 全部不見了」看起來就會像「模型全錯」。
        assert.equal(m.accuracy([]).accuracy, null);
        assert.equal(m.accuracy([]).n, 0);
    });

    test('pred 為 null（模型沒回應）算錯，不算跳過', () => {
        assert.equal(m.accuracy([{ gold: 'a', pred: null }, { gold: 'a', pred: 'a' }]).accuracy, 0.5);
    });
});

describe('macroF1', () => {
    test('全對時為 1', () => {
        const r = m.macroF1([{ gold: 'a', pred: 'a' }, { gold: 'b', pred: 'b' }]);
        assert.equal(r.macroF1, 1);
    });

    test('每個類別等重：大宗類全對、稀有類全錯 → 遠低於 accuracy', () => {
        const rows = [
            ...Array.from({ length: 9 }, () => ({ gold: 'big', pred: 'big' })),
            { gold: 'rare', pred: 'big' }
        ];
        assert.equal(m.accuracy(rows).accuracy, 0.9);
        // big: P=9/10, R=1 → F1=0.947…；rare: P=0, R=0 → F1=0 → macro ≈ 0.4737
        assert.ok(m.macroF1(rows).macroF1 < 0.5, `macro-F1 = ${m.macroF1(rows).macroF1}`);
    });

    test('只出現在 pred 的幻想類別不進平均的分母，但會壓低對應 gold 類的分數', () => {
        const rows = [{ gold: 'a', pred: '幻想章節' }, { gold: 'a', pred: 'a' }];
        const r = m.macroF1(rows);
        assert.deepEqual(Object.keys(r.perClass), ['a']);
        assert.equal(r.perClass.a.recall, 0.5);
    });

    test('perClass 帶 support（該類在 gold 裡出現幾次）', () => {
        const r = m.macroF1([{ gold: 'a', pred: 'a' }, { gold: 'a', pred: 'b' }, { gold: 'b', pred: 'b' }]);
        assert.equal(r.perClass.a.support, 2);
        assert.equal(r.perClass.b.support, 1);
    });

    test('空陣列回 null', () => {
        assert.equal(m.macroF1([]).macroF1, null);
    });
});

describe('confusionPairs', () => {
    test('只列不相等的組合，依次數由多到少', () => {
        const rows = [
            { gold: 'x', pred: 'y' }, { gold: 'x', pred: 'y' }, { gold: 'x', pred: 'y' },
            { gold: 'p', pred: 'q' },
            { gold: 'z', pred: 'z' }
        ];
        const pairs = m.confusionPairs(rows);
        assert.equal(pairs.length, 2);
        assert.deepEqual(pairs[0], { gold: 'x', pred: 'y', count: 3 });
        assert.deepEqual(pairs[1], { gold: 'p', pred: 'q', count: 1 });
    });

    test('取前 N 名', () => {
        const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(g => ({ gold: g, pred: 'X' }));
        assert.equal(m.confusionPairs(rows, 5).length, 5);
        assert.equal(m.confusionPairs(rows, 2).length, 2);
    });

    test('同次數時排序穩定（報表不能每次跑出不同順序）', () => {
        const rows = [{ gold: 'b', pred: 'z' }, { gold: 'a', pred: 'z' }];
        assert.deepEqual(m.confusionPairs(rows).map(p => p.gold), ['a', 'b']);
    });

    test('pred 為 null 顯示成「（無回應）」而不是被丟掉', () => {
        const pairs = m.confusionPairs([{ gold: 'a', pred: null }]);
        assert.equal(pairs[0].pred, '（無回應）');
    });
});

describe('percentile', () => {
    test('p50 / p95 / 邊界', () => {
        assert.equal(m.percentile([1, 2, 3, 4], 0.5), 2.5);
        assert.equal(m.percentile([10, 20, 30], 0), 10);
        assert.equal(m.percentile([10, 20, 30], 1), 30);
        assert.equal(m.percentile([10, 20, 30], 0.95), 29);
    });

    test('不改動入參（純函式）', () => {
        const input = [3, 1, 2];
        m.percentile(input, 0.5);
        assert.deepEqual(input, [3, 1, 2]);
    });

    test('空陣列回 null；p 超出 0~1 丟錯', () => {
        assert.equal(m.percentile([], 0.5), null);
        assert.throws(() => m.percentile([1], 1.5), /p 必須介於/);
    });

    test('略過非有限值（NaN／null 混進來時不該汙染結果）', () => {
        assert.equal(m.percentile([1, NaN, 3, null, undefined], 0.5), 2);
    });
});

describe('distribution', () => {
    test('由多到少，同數時依鍵的字典序', () => {
        assert.deepEqual(m.distribution(['a', 'b', 'a', 'c']), [
            { key: 'a', count: 2 }, { key: 'b', count: 1 }, { key: 'c', count: 1 }
        ]);
    });

    test('null 歸成「（無）」而不是被丟掉', () => {
        assert.deepEqual(m.distribution([null, null]), [{ key: '（無）', count: 2 }]);
    });
});
