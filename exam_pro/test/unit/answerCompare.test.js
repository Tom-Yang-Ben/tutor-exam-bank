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

describe('extractFinalAnswer — 從 claimed 抽最終答案（裁決 S2-12 的新規則）', () => {
    // 案例全部取自 docs/questions2-wsD.md Q3：WS-D 對 fixture 的 45 題填空／計算實測，
    // 舊規則「第一個 $…$」只抽對 4 題，新規則「最後一個 $…$ + 跳過單位上下標」抽對 39 題。
    const fixture = require('../../eval/fixtures/questions.public.json');
    const answerOf = (id) => fixture.questions.find(q => q.id === id).answer_text;

    test('#9 一整串算式：取最後一個 = 之後（舊規則會抽到整串算式）', () => {
        // "$\vec{a} \cdot \vec{b} = 3 \times 1 + 4 \times 2 = 3 + 8 = 11$。"
        assert.equal(extractFinalAnswer(answerOf(9)), '11');
    });

    test('#13 「垂直即內積為 $0$」：不能抽到題目條件裡的 0（舊規則會抽到，造成假 disagree）', () => {
        // "垂直即內積為 $0$：$2 \times 3 + k \times 6 = 0$，得 $6k = -6$，$k = -1$。"
        assert.equal(extractFinalAnswer(answerOf(13)), '-1');
        assert.equal(extractFinalAnswer(answerOf(14)), '-2');
        assert.equal(extractFinalAnswer(answerOf(21)), '0');
    });

    test('#32 單位的 $^2$ 要跳過，往前找上一段 $…$', () => {
        // "由 $F = ma$，$a = \frac{F}{m} = \frac{10}{2} = 5$ m/s$^2$，方向與合力同向。"
        assert.equal(extractFinalAnswer(answerOf(32)), '5');
        assert.equal(extractFinalAnswer(answerOf(33)), '4.5');
    });

    test('#45 切割符含 \\approx 而不只是 =', () => {
        // "…$v_{max} = \sqrt{\mu g r} = \sqrt{0.4 \times 10 \times 50} = \sqrt{200} \approx 14.1$ m/s。"
        assert.equal(extractFinalAnswer(answerOf(45)), '14.1');
        assert.equal(extractFinalAnswer(answerOf(41)), '6.36');
    });

    test('#45／#40 同時有 = 與 \\approx 時取「位置最後」的那一個', () => {
        // #40 的 \approx 在中間、= 在後面 → 應取最後的 =
        assert.equal(extractFinalAnswer(answerOf(40)), '3.27');
    });

    test('#22 答案是文字敘述：抽到的 $x$ 不是數值，但比對器只會回 uncertain 不會誤判', () => {
        // "…此內積即 $\vec{OA}$ 在 $x$ 軸正向上的分量長度，也就是 $A$ 點的 $x$ 座標。"
        assert.equal(extractFinalAnswer(answerOf(22)), 'x');
        assert.equal(
            answerCompare({ question_type: '計算', claimed: answerOf(22), model: { final_answer: '1', answer_form: 'number' } }),
            'uncertain',
            '抽到的不是數值時必須回 uncertain，不得回 disagree'
        );
    });

    test('只有一段 $…$ 且不含等號時，整段就是答案', () => {
        assert.equal(extractFinalAnswer('經計算得 $5$，故選之。'), '5');
        assert.equal(extractFinalAnswer('$\\frac{1}{2}$ 是答案'), '\\frac{1}{2}');
    });

    test('完全沒有 $…$ 時對整段文字取最後一個 =／\\approx 之後', () => {
        assert.equal(extractFinalAnswer('x + 1 = 3，所以 x = 2'), '2');
        assert.equal(extractFinalAnswer('速度 = 10 m/s'), '10 m/s');
        assert.equal(extractFinalAnswer('根號 200 \\approx 14.1'), '14.1');
    });

    test('$…$ 全都是單位上下標時，退回整段文字的等號規則', () => {
        assert.equal(extractFinalAnswer('加速度 a = 5 m/s$^2$'), '5 m/s$^2$');
    });

    test('切出來是空字串時往前再找一段', () => {
        assert.equal(extractFinalAnswer('先寫 $k = -1$，再補一個空的 $x =$'), '-1');
    });

    test('兩者都沒有時回 null', () => {
        assert.equal(extractFinalAnswer('這是一段沒有公式也沒有等號的說明'), null);
        assert.equal(extractFinalAnswer(''), null);
        assert.equal(extractFinalAnswer(null), null);
    });

    test('對 fixture 的 45 題填空／計算，抽出後可解析成數值的達 44 題', () => {
        const qs = fixture.questions.filter(q => ['填空', '計算'].includes(q.question_type));
        assert.equal(qs.length, 45);
        const numeric = qs.filter(q => toNumber(extractFinalAnswer(q.answer_text)) !== null);
        // 只剩 #22：它的答案是一句文字敘述（answer_form 應為 text），本來就不走數值路徑。
        // 科學記號的 #56/57/58/60 已由裁決 S2-26 收進 toNumber。
        assert.equal(numeric.length, 44, '抽出後可解析成數值的題數退步了');
        assert.deepEqual(
            qs.filter(q => toNumber(extractFinalAnswer(q.answer_text)) === null).map(q => q.id),
            [22]
        );
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

    test('分數前面的負號不得被吃掉（裁決 S2-11：漏掉負號是最典型的錯答）', () => {
        assert.equal(toNumber('-\\frac{1}{2}'), -0.5);
        assert.equal(toNumber('$-\\dfrac{1}{2}$'), -0.5);
        assert.equal(toNumber('-1/2'), -0.5);
        assert.equal(toNumber('-0.5'), -0.5);
    });

    test('角度的 ^\\circ 是單位不是指數', () => {
        assert.equal(toNumber('45^\\circ'), 45);
        assert.equal(toNumber('45^{\\circ}'), 45);
        assert.equal(toNumber('$60^\\circ$'), 60);
    });

    // ── 以下三組是裁決 S2-26 補的 ──

    test('S2-26：科學記號的三種寫法收斂到同一個數', () => {
        assert.equal(toNumber('2.4 \\times 10^{-4}'), 0.00024);
        assert.equal(toNumber('$2.4 \\times 10^{-4}$'), 0.00024);
        assert.equal(toNumber('2.4e-4'), 0.00024);
        assert.equal(toNumber('0.00024'), 0.00024);
        assert.equal(toNumber('6.0 \\times 10^{2}'), 600);
        assert.equal(toNumber('6.0×10^2'), 600);
        assert.equal(toNumber('-2.4 \\times 10^{-4}'), -0.00024);
    });

    test('S2-26：\\mathrm{…}／\\text{…}／\\,／\\ 與其後的單位整段去掉', () => {
        assert.equal(toNumber('$5\\ \\mathrm{m/s^2}$'), 5);
        assert.equal(toNumber('$9.8\\,\\mathrm{m/s^2}$'), 9.8);
        assert.equal(toNumber('$600\\ \\text{N}$'), 600);
        assert.equal(toNumber('2.4 \\times 10^{-4}\\ \\mathrm{J}'), 0.00024);
    });

    test('S2-26：可數值化的式子算出數值再比', () => {
        assert.ok(Math.abs(toNumber('\\sqrt{3}') - Math.sqrt(3)) < 1e-12);
        assert.ok(Math.abs(toNumber('\\frac{\\sqrt{3}}{2}') - Math.sqrt(3) / 2) < 1e-12);
        assert.ok(Math.abs(toNumber('-\\frac{\\sqrt{3}}{2}') + Math.sqrt(3) / 2) < 1e-12);
        assert.ok(Math.abs(toNumber('2\\pi') - 2 * Math.PI) < 1e-12);
        assert.equal(toNumber('2^5'), 32);
        assert.equal(toNumber('\\sqrt{200}') > 14.1 && toNumber('\\sqrt{200}') < 14.2, true);
    });

    test('S2-26：求值器對看不懂的東西一律回 null（不猜數值）', () => {
        for (const s of ['x + 1', '\\vec{a}', '\\sin 30', '\\sqrt[3]{8}', '1/0', '(1+2', '互相垂直', '']) {
            assert.equal(toNumber(s), null, JSON.stringify(s));
        }
    });

    test('S2-26：兩邊都算得出且不等 → disagree（根式對小數）', () => {
        assert.equal(cmp('填空', '$\\frac{1}{2}$', '$\\frac{\\sqrt{3}}{2}$', 'number'), 'disagree');
        assert.equal(cmp('填空', '$-\\frac{1}{2}$', '$-\\frac{\\sqrt{3}}{2}$', 'number'), 'disagree');
        assert.equal(cmp('計算', '$\\sqrt{200}$', '14.142135623730951', 'number'), 'agree');
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
    });

    test('expression：字串不同時兩邊都能數值化才比，否則 uncertain（裁決 S2-26）', () => {
        // 兩邊都是數值 → 照 number 比
        assert.equal(cmp('計算', '$\\frac{1}{2}$', '0.5', 'expression'), 'agree');
        assert.equal(cmp('計算', '$\\frac{3}{1}$', '3', 'expression'), 'agree');
        assert.equal(cmp('計算', '$\\frac{1}{3}$', '3', 'expression'), 'disagree');
        // 有一邊算不出數值 → uncertain，不得把「看不懂」當成「不一樣」
        assert.equal(cmp('計算', '$x + 1$', 'x-1', 'expression'), 'uncertain');
        assert.equal(cmp('計算', '$x + 1$', '2', 'expression'), 'uncertain');
    });

    test('text：claimed 包含模型答案 → agree，否則一律 uncertain（裁決 S2-26／S2-27）', () => {
        assert.equal(cmp('填空', '$互相垂直$', '互相 垂直', 'text'), 'agree');
        assert.equal(cmp('填空', '互相垂直', '互相垂直', 'text'), 'agree');
        // 文字答案的「不同」分不出是答錯還是換句話說，永遠不回 disagree
        assert.equal(cmp('填空', '$互相垂直$', '互相平行', 'text'), 'uncertain');
        assert.equal(cmp('填空', '兩向量的內積為零，故兩者互相垂直。', '互相垂直', 'text'), 'agree');   // S2-27：包含即 agree
        assert.equal(cmp('填空', '兩向量的內積為零，故兩者互相垂直。', '長度相等', 'text'), 'uncertain');
    });

    test('text 比的是整段 claimed，不走 $…$ 抽取（裁決 S2-26）', () => {
        // 沒有 $…$、也沒有等號的純文字答案，抽取器會回 null；text 不受影響
        assert.equal(cmp('填空', '互相垂直', '互相垂直', 'text'), 'agree');
        assert.equal(extractFinalAnswer('互相垂直'), null);
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

// 2026-08-23 FEATURE_PIPELINE 冒煙在真實管線抓到的假警報：
// claimed「$5\text{ m/s}^2$」對驗證模型的「5 m/s^2」被判 disagree——\text{ m/s} 被去掉後 ^2 黏在 5 後面變成 25。
// 單位巨集後面緊接的指數屬於單位，不是數字的平方。
describe('單位巨集後的指數（\\text{ m/s}^2 的 ^2 屬於單位）', () => {
    const c = (claimed, fa) => answerCompare({ question_type: '計算', claimed, model: { final_answer: fa, answer_form: 'number' } });
    test('$5\\text{ m/s}^2$ 對 5 m/s^2 → agree', () => assert.equal(c('$5\\text{ m/s}^2$', '5 m/s^2'), 'agree'));
    test('$5\\text{ m/s}^2$ 對 6 → disagree（不是 uncertain：兩邊都抽得出數字）', () => assert.equal(c('$5\\text{ m/s}^2$', '6'), 'disagree'));
    test('$5\\mathrm{m/s^2}$ 對 5 → agree', () => assert.equal(c('$5\\mathrm{m/s^2}$', '5'), 'agree'));
    test('$3^2$ 對 9 → agree（沒有單位巨集時 ^2 仍是平方）', () => assert.equal(c('$3^2$', '9'), 'agree'));
});
