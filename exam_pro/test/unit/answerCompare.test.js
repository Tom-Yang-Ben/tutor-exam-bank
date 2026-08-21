// answerCompare 單元測試（A-T5 / WS-C）
//
// 契約：docs/interfaces-stage2.md 第 4.2 條。
// 最重要的一條是「任何比不出來的情況都回 uncertain，不回 disagree」——
// 誤報一次 answer_mismatch 只是老師白看一題，漏報則是錯題進了題庫。
//
// 規劃 §5.3.2 明講：等價形（$\frac{1}{2}$ / 0.5 / 1/2）與典型錯答是純函式的單元測試，
// 不另設 eval:verify suite。這支就是那份。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    answerCompare, extractOptionCodes, extractFinalAnswer, toNumber,
} = require('../../utils/answerCompare');

/** 比較一題的簡寫 */
const cmp = (question_type, claimed, final_answer, answer_form) =>
    answerCompare({ question_type, claimed, model: { final_answer, answer_form } });

// ═════════════════════ 零件 ═════════════════════

describe('extractOptionCodes — 選項代號集合', () => {
    test('括號型：(A)、（Ａ）、[A]、【A】', () => {
        for (const v of ['(A)', '（Ａ）', '[A]', '【A】', '( a )']) {
            assert.deepEqual([...extractOptionCodes(v)], ['A'], v);
        }
    });

    test('多選：抽出多個代號', () => {
        assert.deepEqual([...extractOptionCodes('(A)(C)(D)')].sort(), ['A', 'C', 'D']);
        assert.deepEqual([...extractOptionCodes('答案為 (B) 與 (D)')].sort(), ['B', 'D']);
    });

    test('標號型：A.、A、、A：', () => {
        assert.deepEqual([...extractOptionCodes('A. 互相垂直')], ['A']);
        assert.deepEqual([...extractOptionCodes('答案：B、')], ['B']);
    });

    test('裸字母：整串只剩字母時才算', () => {
        assert.deepEqual([...extractOptionCodes('AB')].sort(), ['A', 'B']);
        assert.deepEqual([...extractOptionCodes('答案：AC')].sort(), ['A', 'C']);
        assert.deepEqual([...extractOptionCodes('D')], ['D']);
    });

    test('「甲乙丙」不算代號', () => {
        assert.equal(extractOptionCodes('甲').size, 0);
        assert.equal(extractOptionCodes('答案為甲與丙').size, 0);
    });

    test('句子裡的大寫字母不會被誤認', () => {
        assert.equal(extractOptionCodes('設 A 為一個集合，B 為另一個集合，兩者交集為空').size, 0);
    });

    test('括號型優先於標號型（避免同一題抽出兩套）', () => {
        assert.deepEqual([...extractOptionCodes('(A) 甲　B. 乙')], ['A']);
    });
});

describe('extractFinalAnswer — 從 claimed 抽最終答案', () => {
    test('第一個 $…$ 優先', () => {
        assert.equal(extractFinalAnswer('經計算得 $5$，故選之。'), '5');
        assert.equal(extractFinalAnswer('$\\frac{1}{2}$ 是答案'), '\\frac{1}{2}');
    });

    test('沒有 $…$ 時取最後一個 = 之後', () => {
        assert.equal(extractFinalAnswer('x + 1 = 3，所以 x = 2'), '2');
        assert.equal(extractFinalAnswer('速度 = 10 m/s'), '10 m/s');
    });

    test('兩者都沒有時回 null', () => {
        assert.equal(extractFinalAnswer('這是一段沒有公式也沒有等號的說明'), null);
        assert.equal(extractFinalAnswer(''), null);
        assert.equal(extractFinalAnswer(null), null);
    });
});

describe('toNumber — 有理數正規化', () => {
    test('整數、小數、負數', () => {
        assert.equal(toNumber('12'), 12);
        assert.equal(toNumber('-3.5'), -3.5);
        assert.equal(toNumber('−3.5'), -3.5, '全形減號也要認');
    });

    test('分數的三種寫法都等於 0.5', () => {
        assert.equal(toNumber('1/2'), 0.5);
        assert.equal(toNumber('\\frac{1}{2}'), 0.5);
        assert.equal(toNumber('$\\dfrac{1}{2}$'), 0.5);
        assert.equal(toNumber('0.5'), 0.5);
    });

    test('單位後綴會被剝掉', () => {
        assert.equal(toNumber('10 m/s'), 10);
        assert.equal(toNumber('5公分'), 5);
        assert.equal(toNumber('30°'), 30);
        assert.equal(toNumber('9.8 \\text{m/s}'), 9.8);
    });

    test('百分比', () => {
        assert.equal(toNumber('50%'), 0.5);
    });

    test('認不出來回 null', () => {
        assert.equal(toNumber('x + 1'), null);
        assert.equal(toNumber('互相垂直'), null);
        assert.equal(toNumber('1/0'), null, '除以零不是有理數');
    });
});

// ═════════════════════ 單選／多選 ═════════════════════

describe('answerCompare — 單選／多選比選項代號集合', () => {
    test('等價寫法：(A) / A / A. / A、 全部 agree', () => {
        for (const claimed of ['(A)', 'A', 'A. 互相垂直', '答案：A、']) {
            assert.equal(cmp('單選', claimed, '(A)', 'option'), 'agree', claimed);
        }
    });

    test('拆題模型抄的是整段解說，仍抽得出代號', () => {
        const claimed = '(A)。$\\log_{2} 8 = 3$、$\\log_{2} 4 = 2$，故兩者之和為 $5$。';
        assert.equal(cmp('單選', claimed, '(A)', 'option'), 'agree');
    });

    test('典型錯答：驗證模型算出 (B)、拆題模型抄 (C) → disagree', () => {
        assert.equal(cmp('單選', '(C)', '(B)', 'option'), 'disagree');
    });

    test('多選：集合相等就 agree（順序無關）', () => {
        assert.equal(cmp('多選', '(A)(C)', '(C)(A)', 'option'), 'agree');
        assert.equal(cmp('多選', 'AC', '(A)(C)', 'option'), 'agree');
    });

    test('多選：少選一個 → disagree', () => {
        assert.equal(cmp('多選', '(A)(C)', '(A)(C)(D)', 'option'), 'disagree');
    });

    test('任一邊抽不到代號 → uncertain', () => {
        assert.equal(cmp('單選', '甲', '(A)', 'option'), 'uncertain');
        assert.equal(cmp('單選', '(A)', '互相垂直', 'option'), 'uncertain');
        assert.equal(cmp('單選', '', '(A)', 'option'), 'uncertain');
    });
});

// ═════════════════════ 填空／計算 ═════════════════════

describe('answerCompare — 填空／計算：先抽 final_answer 再依 answer_form 比', () => {
    test('number：等價形 $\\frac{1}{2}$ / 0.5 / 1/2 互相 agree', () => {
        const forms = ['$\\frac{1}{2}$', '$0.5$', '$1/2$', '$\\dfrac{1}{2}$'];
        for (const a of forms) {
            for (const b of ['\\frac{1}{2}', '0.5', '1/2']) {
                assert.equal(cmp('填空', a, b, 'number'), 'agree', `${a} vs ${b}`);
            }
        }
    });

    test('number：容差 1e-9 之內算 agree', () => {
        assert.equal(cmp('計算', '$0.3333333333$', '0.3333333333', 'number'), 'agree');
        assert.equal(cmp('計算', '$1$', '1.0000000000001', 'number'), 'agree');
    });

    test('number：負號是數值的一部分，-1 與 1 是 disagree', () => {
        assert.equal(cmp('計算', '$-1$', '1', 'number'), 'disagree');
        assert.equal(cmp('計算', '$-1$', '-1', 'number'), 'agree');
    });

    test('number：單位不同但數值相同 → agree', () => {
        assert.equal(cmp('計算', '$9.8$ m/s^2', '9.8', 'number'), 'agree');
    });

    test('number：典型錯答（算錯一個數量級）→ disagree', () => {
        assert.equal(cmp('計算', '$50$', '5', 'number'), 'disagree');
    });

    test('number：± 只能跟 ± 比，對上單值一律 uncertain', () => {
        assert.equal(cmp('計算', '$\\pm 2$', '\\pm 2', 'number'), 'agree');
        assert.equal(cmp('計算', '$\\pm 2$', '2', 'number'), 'uncertain');
    });

    test('number：多解長度相同才比，長度不同回 uncertain', () => {
        assert.equal(cmp('計算', '$1, 4$', '4, 1', 'number'), 'agree');
        assert.equal(cmp('計算', '$1, 4$', '1', 'number'), 'uncertain');
        assert.equal(cmp('計算', '$1, 4$', '1, 5', 'number'), 'disagree');
    });

    test('number：抽不出數值 → uncertain', () => {
        assert.equal(cmp('計算', '$x + 1$', '2', 'number'), 'uncertain');
        assert.equal(cmp('計算', '沒有公式也沒有等號的說明', '2', 'number'), 'uncertain');
    });

    test('expression：去空白、去 $、去 \\left\\right 後相同即 agree', () => {
        assert.equal(cmp('計算', '$\\left( x+1 \\right)^2$', '(x+1)^2', 'expression'), 'agree');
        assert.equal(cmp('計算', '$x + 1$', 'x+1', 'expression'), 'agree');
        assert.equal(cmp('計算', '$x + 1$', 'x-1', 'expression'), 'disagree');
    });

    test('expression：兩邊都是數值時退回數值比較', () => {
        assert.equal(cmp('計算', '$\\frac{1}{2}$', '0.5', 'expression'), 'agree');
    });

    test('text：normalizeStem 後相同即 agree', () => {
        assert.equal(cmp('填空', '$互相垂直$', '互相 垂直', 'text'), 'agree');
        assert.equal(cmp('填空', '$互相垂直$', '互相平行', 'text'), 'disagree');
    });

    test('answer_form 不在四個值內 → uncertain', () => {
        assert.equal(cmp('計算', '$5$', '5', 'matrix'), 'uncertain');
        assert.equal(cmp('計算', '$5$', '5', undefined), 'uncertain');
    });
});

// ═════════════════════ 邊界 ═════════════════════

describe('answerCompare — 證明題與缺值', () => {
    test('證明題一律 uncertain', () => {
        assert.equal(cmp('證明', '(A)', '(A)', 'option'), 'uncertain');
        assert.equal(cmp('證明', '$1$', '1', 'number'), 'uncertain');
    });

    test('claimed 或 final_answer 為空 → uncertain', () => {
        assert.equal(cmp('計算', '', '5', 'number'), 'uncertain');
        assert.equal(cmp('計算', '$5$', '', 'number'), 'uncertain');
        assert.equal(cmp('計算', '$5$', null, 'number'), 'uncertain');
        assert.equal(cmp('計算', null, '5', 'number'), 'uncertain');
    });

    test('整包參數缺漏也不得拋例外', () => {
        assert.doesNotThrow(() => answerCompare());
        assert.doesNotThrow(() => answerCompare({}));
        assert.doesNotThrow(() => answerCompare({ question_type: '計算' }));
        assert.equal(answerCompare(), 'uncertain');
        assert.equal(answerCompare({}), 'uncertain');
    });

    test('回傳值永遠是三個字串之一', () => {
        const inputs = [
            ['單選', '(A)', '(A)', 'option'], ['多選', '甲', 'AB', 'option'],
            ['填空', '$1$', '1', 'number'], ['計算', 'x=2', '2', 'number'],
            ['證明', '略', '略', 'text'], ['計算', '$x$', 'x', 'expression'],
            [undefined, undefined, undefined, undefined],
        ];
        for (const [t, c, f, form] of inputs) {
            assert.ok(['agree', 'disagree', 'uncertain'].includes(cmp(t, c, f, form)));
        }
    });
});
