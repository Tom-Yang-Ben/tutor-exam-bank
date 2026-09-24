// utils/answerCompare.js 的單位與化學式比對（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 4 點）
//
// 兩部分：
//   1. eval/golden/answer_chem.json（18 筆 × 5 = 90 個案例）全部符合 expect——golden 是裁判；
//   2. 介入條件的邊界：數學題（沒有 \ce、沒有 subject）絕不走化學式比對；單位只在兩邊都認得時介入。
// eval/golden/answer.json 的 250 個既有案例仍由 test/unit/answerGolden.test.js 硬斷言（結果不得改變）。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { answerCompare, extractFinalAnswer, locateFinalAnswer } = require('../../utils/answerCompare');
const g2 = require('../../eval/lib/golden2');
const units = require('../../utils/units');

const GOLDEN = path.resolve(__dirname, '..', '..', 'eval', 'golden', 'answer_chem.json');

describe('eval/golden/answer_chem.json（單位與化學式）', () => {
    const golden = g2.loadAnswerGolden({ file: GOLDEN });

    test('通過 answer golden 的硬閘門（3 種等價 + 2 種錯答、expect 合法）', () => {
        assert.ok(golden.entries.length >= 15);
    });

    test('每一個案例都符合 expect', () => {
        const fails = [];
        for (const entry of golden.entries) {
            for (const c of g2.expandAnswerCases(entry)) {
                const got = answerCompare({ question_type: c.question_type, claimed: c.claimed, model: c.model, subject: entry.subject });
                if (got !== c.expect) fails.push(`${c.id}「${c.model.final_answer}」：期望 ${c.expect}，得到 ${got}`);
            }
        }
        assert.deepEqual(fails, []);
    });
});

describe('單位（第 4.2 條第 4 點）', () => {
    const cmp = (claimed, finalAnswer, form = 'number') =>
        answerCompare({ question_type: '計算', claimed, model: { final_answer: finalAnswer, answer_form: form } });

    test('「5 cm」對「5 m」→ disagree（修正前是 agree）', () => {
        assert.equal(cmp('5 cm', '5 m'), 'disagree');
        assert.equal(cmp('$5\\text{ cm}$', '5 m'), 'disagree');
        assert.equal(cmp('$5\\ \\mathrm{cm}$', '$5\\ \\mathrm{m}$'), 'disagree');
        assert.equal(cmp('長度為 $5$ cm', '5 m'), 'disagree');
        assert.equal(cmp('$5\\text{ cm}$', '5 m', 'expression'), 'disagree');
    });

    test('常見的等價寫法（\\mathrm、\\text、純文字）視為同一個單位', () => {
        assert.equal(cmp('$5\\text{ cm}$', '5 cm'), 'agree');
        assert.equal(cmp('$5\\,\\mathrm{cm}$', '5 cm'), 'agree');
        assert.equal(cmp('$5$ cm', '$5\\ \\text{cm}$'), 'agree');
    });

    test('只有一邊有單位、或單位認不得：照原規則（只比數值）', () => {
        assert.equal(cmp('位移為 $5$ m', '5'), 'agree');
        assert.equal(cmp('$5$', '5 m'), 'agree');
        assert.equal(cmp('為 $16$ 位數', '16 位數'), 'agree');
        assert.equal(cmp('為 $16$ 位數', '15 位數'), 'disagree');
    });

    test('text 單位衝突只到 uncertain（裁決 S2-26：text 永遠不回 disagree）', () => {
        assert.equal(cmp('$5\\text{ cm}$', '5 m', 'text'), 'uncertain');
        assert.equal(cmp('$25\\text{ m}$', '25 m', 'text'), 'agree');
    });

    test('沒有 $ 也沒有等號的 claimed：只有在模型答案也帶單位時才當成答案', () => {
        assert.equal(cmp('5 cm', '5 cm'), 'agree');
        assert.equal(cmp('5 cm', '5'), 'uncertain', '模型沒帶單位時維持原本的 uncertain');
    });

    test('溫度：℃ 對 K 認高中慣用的 273，也認 273.15；同單位之間不經過位移', () => {
        assert.equal(cmp('$25$ ℃', '298 K'), 'agree', '審查回報：25 ℃ 對 298 K 曾被判 disagree');
        assert.equal(cmp('$27$ ℃', '300 K'), 'agree');
        assert.equal(cmp('$27$ ℃', '300.15 K'), 'agree');
        assert.equal(cmp('$T = 300$ K', '27 °C'), 'agree');
        assert.equal(cmp('$25$ ℃', '299 K'), 'disagree');
        assert.equal(cmp('$25$ ℃', '25.15 °C'), 'disagree', '兩邊都是 ℃：位移抵消，不能拿 0.15 當容差');
        assert.equal(cmp('$T = 298$ K', '298.15 K'), 'disagree', '兩邊都是 K：照原本的數值容差');
        assert.equal(cmp('$25$ ℃', '298 K', 'expression'), 'agree');
        assert.equal(cmp('$25$ ℃', '298 K', 'text'), 'agree');
    });

    test('度的符號寫在 \\mathrm 前面（^{\\circ}\\mathrm{C}）是攝氏，不是庫侖', () => {
        assert.equal(cmp('$T = 27^{\\circ}\\mathrm{C}$', '27 °C'), 'agree');
        assert.equal(cmp('$T = 27^{\\circ}\\mathrm{C}$', '300 K'), 'agree');
        assert.equal(cmp('$T = 27\\,^\\circ\\mathrm{C}$', '28 °C'), 'disagree');
        assert.equal(cmp('$q = 2\\,\\mathrm{C}$', '2 C'), 'agree', '沒有度的符號時 C 仍是庫侖');
    });

    test('單一個大寫字母後面接中文是點名、不是單位（「$2$ A 點」不是 2 安培）', () => {
        assert.equal(cmp('$2$ A 點', '2 m'), 'agree', '讀不到 claimed 的單位：照原規則只比數值');
        assert.equal(cmp('位於 $x = 3$ C 處', '3 m'), 'agree');
        assert.equal(cmp('$2$ A。', '2 m'), 'disagree', '後面是標點時仍是安培');
        assert.equal(cmp('$2$ A。', '2 A'), 'agree');
    });

    test('locateFinalAnswer 與 extractFinalAnswer 抽出同一個答案，end 指向該段 $ 之後', () => {
        const s = '由 $F = ma$，$a = 5$ m/s$^2$，方向向東。';
        const loc = locateFinalAnswer(s);
        assert.equal(loc.answer, extractFinalAnswer(s));
        assert.equal(s.slice(loc.end).startsWith(' m/s'), true);
    });
});

describe('utils/units.js', () => {
    test('組合單位、指數與中文單位', () => {
        assert.deepEqual(units.parseUnit('m/s^2').dims, { L: 1, T: -2 });
        assert.deepEqual(units.parseUnit('m/s²').dims, { L: 1, T: -2 });
        assert.deepEqual(units.parseUnit('kg·m/s').dims, { M: 1, L: 1, T: -1 });
        assert.deepEqual(units.parseUnit('J/(mol·K)').dims, { M: 1, L: 2, T: -2, N: -1, K: -1 });
        assert.equal(units.parseUnit('cm^3').factor.toExponential(3), '1.000e-6');
        assert.equal(units.parseUnit('公尺').factor, 1);
    });
    test('M 等於 mol/L；℃ 換算有位移', () => {
        const M = units.parseUnit('M');
        const molL = units.parseUnit('mol/L');
        assert.ok(units.sameDims(M, molL));
        assert.equal(M.factor, molL.factor);
        assert.equal(units.toBase(25, units.parseUnit('°C')), 298.15);
    });
    test('認不得的單位回 null（位數、個、度）', () => {
        for (const s of ['位數', '個', '度', 'xyz', '', null]) assert.equal(units.parseUnit(s), null, String(s));
    });
    test('unitTextOfAnswer：科學記號的 e 不是單位、多解不介入', () => {
        assert.equal(units.unitTextOfAnswer('2.4e-4'), null);
        assert.equal(units.unitTextOfAnswer('2.4 \\times 10^{-4} J'), 'J');
        assert.equal(units.unitTextOfAnswer('1 或 4'), null);
        assert.equal(units.unitTextOfAnswer('$9.8\\,\\mathrm{m/s^2}$'), 'm/s^2');
    });
    test('trailingUnitText：中文單位後面必須是標點或結尾（「升高」不是「升」）', () => {
        assert.equal(units.trailingUnitText(' 秒。'), '秒');
        assert.equal(units.trailingUnitText(' 升高溫度'), null);
        assert.equal(units.trailingUnitText('，故選 A'), null);
    });
    test('trailingUnitText：單一大寫字母後面接中文 → null；小寫與多字母單位照讀', () => {
        for (const s of [' A 點', ' A點', ' C 處', ' N 極']) assert.equal(units.trailingUnitText(s), null, s);
        assert.equal(units.trailingUnitText(' A。'), 'A');
        assert.equal(units.trailingUnitText(' A'), 'A');
        assert.equal(units.trailingUnitText(' A，方向向右'), 'A');
        assert.equal(units.trailingUnitText(' m 處'), 'm');
        assert.equal(units.trailingUnitText(' mA 的電流'), 'mA');
    });
    test('conversionVariants：只有 ℃ 對 K 才多一組「273」的換算', () => {
        const C = units.parseUnit('°C');
        const K = units.parseUnit('K');
        const m = units.parseUnit('m');
        assert.equal(units.conversionVariants(m, units.parseUnit('cm')).length, 1);
        assert.equal(units.conversionVariants(C, C).length, 1);
        assert.equal(units.conversionVariants(K, K).length, 1);
        const v = units.conversionVariants(C, K);
        assert.equal(v.length, 2);
        assert.equal(units.toBase(25, v[0][0]), 298.15);
        assert.equal(units.toBase(25, v[1][0]), 25 + units.SCHOOL_CELSIUS_OFFSET);
        assert.equal(units.SCHOOL_CELSIUS_OFFSET, 273);
        assert.equal(C.offset, 273.15, '原本的單位物件不被改動');
    });
    test('unitTextOfAnswer：度的符號在單位巨集前面時一起帶走', () => {
        assert.equal(units.unitTextOfAnswer('$27^{\\circ}\\mathrm{C}$'), '°C');
        assert.equal(units.unitTextOfAnswer('27\\,^\\circ\\text{C}'), '°C');
        assert.equal(units.unitTextOfAnswer('$2\\,\\mathrm{C}$'), 'C');
        assert.deepEqual(units.parseUnit(units.unitTextOfAnswer('$27^{\\circ}\\mathrm{C}$')).dims, { K: 1 });
    });
});

describe('化學式比對的介入條件', () => {
    const cmp = (claimed, finalAnswer, form = 'expression', subject) =>
        answerCompare({ question_type: '填空', claimed, model: { final_answer: finalAnswer, answer_form: form }, subject });

    test('有 \\ce{…} 就介入：相同 agree、不同 disagree（不再一律 uncertain）', () => {
        assert.equal(cmp('$\\ce{H2O}$', 'H2O'), 'agree');
        assert.equal(cmp('$\\ce{H2O}$', 'H2O2'), 'disagree');
    });

    test('數學題（沒有 \\ce、沒有 subject）絕不走化學式：BC 對 CB 維持原規則', () => {
        assert.equal(cmp('線段 $BC$', 'CB'), 'uncertain');
        assert.equal(cmp('$\\mathrm{H_2O}$', 'H2O'), 'uncertain', '沒有 \\ce 又不是化學題：照 expression 原規則');
    });

    test('化學題（subject=化學）沒有 \\ce 也比化學式', () => {
        assert.equal(cmp('$\\mathrm{H_2O}$', 'H2O', 'expression', '化學'), 'agree');
        assert.equal(cmp('$\\mathrm{H_2O}$', 'CO2', 'expression', '化學'), 'disagree');
    });

    test('化學題的數值答案（answer_form=number）不走化學式，照數值＋單位比', () => {
        assert.equal(cmp('$n = 0.50$ mol', '0.50 mol', 'number', '化學'), 'agree');
        assert.equal(cmp('$n = 0.50$ mol', '0.50 M', 'number', '化學'), 'disagree');
    });

    test('反應式左右對調、係數整體加倍 → uncertain（判不出是不是出題者要的寫法）', () => {
        assert.equal(cmp('$\\ce{2H2 + O2 -> 2H2O}$', '$\\ce{2H2O -> 2H2 + O2}$'), 'uncertain');
        assert.equal(cmp('$\\ce{2H2 + O2 -> 2H2O}$', '$\\ce{4H2 + 2O2 -> 4H2O}$'), 'uncertain');
    });

    test('一邊是反應式、一邊是單一物種 → uncertain', () => {
        assert.equal(cmp('$\\ce{2H2 + O2 -> 2H2O}$', '$\\ce{H2O}$'), 'uncertain');
    });

    test('單選／多選不受影響（先走選項代號）', () => {
        assert.equal(answerCompare({ question_type: '單選', claimed: '(B)。$\\ce{H2O}$', model: { final_answer: '(B)', answer_form: 'option' }, subject: '化學' }), 'agree');
    });
});
