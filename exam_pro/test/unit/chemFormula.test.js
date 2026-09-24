// utils/chemFormula.js 的單元測試（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 3、4 點）
//
// 三個消費端（textFormatter、source_check、answerCompare）共用這一支，所以這裡把 mhchem 子集的
// 每一種記法各釘一個案例：下標、電荷、係數、三種箭頭、物態、氣體／沉澱、水合物、錯離子、同位素。
// 執行：npm test（純函式，不連 DB、不連 LLM）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    ceToLatex, ceToComparable, parseChemAnswer, parseSpecies, findCe, replaceCe, splitArrows, toCeBody, ELEMENTS
} = require('../../utils/chemFormula');

describe('ceToLatex — mhchem 子集 → 一般 LaTeX（第 4.2 條第 3 點）', () => {
    const CASES = [
        ['化學式下標', 'H2SO4', '\\mathrm{H_{2}SO_{4}}'],
        ['底線下標也認', 'H_2O', '\\mathrm{H_{2}O}'],
        ['離子電荷（大括號）', 'SO4^{2-}', '\\mathrm{SO_{4}^{2-}}'],
        ['離子電荷（省略大括號）', 'SO4^2-', '\\mathrm{SO_{4}^{2-}}'],
        ['結尾的 + 是電荷', 'Na+', '\\mathrm{Na^{+}}'],
        ['結尾的 - 是電荷', 'Cl-', '\\mathrm{Cl^{-}}'],
        ['係數', '2H2O', '2\\mathrm{H_{2}O}'],
        ['分數係數', '1/2O2', '\\frac{1}{2}\\mathrm{O_{2}}'],
        ['小數係數', '0.5O2', '0.5\\mathrm{O_{2}}'],
        ['單向箭頭 ->', 'A -> B', '\\mathrm{A} \\rightarrow \\mathrm{B}'],
        ['逆向箭頭 <-', 'A <- B', '\\mathrm{A} \\leftarrow \\mathrm{B}'],
        ['可逆箭頭 <=>', 'N2 + 3H2 <=> 2NH3', '\\mathrm{N_{2}} + 3\\mathrm{H_{2}} \\rightleftharpoons 2\\mathrm{NH_{3}}'],
        ['物態 (s)(l)(g)(aq)', 'NaCl(s) + H2O(l)', '\\mathrm{NaCl}\\mathrm{(s)} + \\mathrm{H_{2}O}\\mathrm{(l)}'],
        ['獨立的物態', 'CO2 (g)', '\\mathrm{CO_{2}} \\mathrm{(g)}'],
        ['氣體 ^', 'CO2 ^', '\\mathrm{CO_{2}} \\uparrow'],
        ['沉澱 v', 'AgCl v', '\\mathrm{AgCl} \\downarrow'],
        ['水合物的句點', 'CuSO4.5H2O', '\\mathrm{CuSO_{4}}\\cdot 5\\mathrm{H_{2}O}'],
        ['水合物的星號', 'CuSO4*5H2O', '\\mathrm{CuSO_{4}}\\cdot 5\\mathrm{H_{2}O}'],
        ['括號與下標', 'Ca(OH)2', '\\mathrm{Ca(OH)_{2}}'],
        ['錯離子', '[Cu(NH3)4]^{2+}', '\\mathrm{[Cu(NH_{3})_{4}]^{2+}}'],
        ['同位素前標', '^{14}_{6}C', '\\prescript{14}{6}{\\mathrm{C}}'],
        ['電子', '5e-', '5\\mathrm{e^{-}}'],
        ['兩個大寫字母不是元素時各自一個', 'CO', '\\mathrm{CO}'],
        ['Co 是鈷', 'Co', '\\mathrm{Co}']
    ];
    for (const [name, input, expected] of CASES) {
        test(`${name}：${input}`, () => assert.equal(ceToLatex(input), expected));
    }

    test('箭頭條件：上方（化學式照樣轉）', () => {
        assert.equal(ceToLatex('A ->[MnO2] B'), '\\mathrm{A} \\xrightarrow{\\mathrm{MnO_{2}}} \\mathrm{B}');
    });
    test('箭頭條件：上方是 LaTeX 指令、下方是中文', () => {
        assert.equal(ceToLatex('A ->[\\Delta][加熱] B'), '\\mathrm{A} \\xrightarrow[\\text{加熱}]{\\Delta} \\mathrm{B}');
    });
    test('條件本身已是 LaTeX（\\text{…}、$…$）時原樣，不再包一層', () => {
        assert.equal(ceToLatex('A ->[\\text{加熱}] B'), '\\mathrm{A} \\xrightarrow{\\text{加熱}} \\mathrm{B}');
        assert.equal(ceToLatex('A ->[$T>500$] B'), '\\mathrm{A} \\xrightarrow{T>500} \\mathrm{B}');
        assert.equal(ceToLatex('A ->[{加熱}] B'), '\\mathrm{A} \\xrightarrow{\\text{加熱}} \\mathrm{B}');
    });
    test('可逆箭頭也能帶條件', () => {
        assert.equal(ceToLatex('A <=>[Fe] B'), '\\mathrm{A} \\xrightleftharpoons{\\mathrm{Fe}} \\mathrm{B}');
    });
    test('大括號內的 -> 不是箭頭（^{…} 裡）', () => {
        assert.equal(splitArrows('X^{->}').filter(s => s.type === 'arrow').length, 0);
    });
    test('中文詞包進 \\text', () => {
        assert.equal(ceToLatex('A ->[] B 沉澱'), '\\mathrm{A} \\rightarrow \\mathrm{B} \\text{沉澱}');
    });
    test('空字串回空字串，不丟例外', () => {
        assert.equal(ceToLatex(''), '');
        assert.equal(ceToLatex(null), '');
    });
});

describe('ceToComparable — 原卷比對用的純文字', () => {
    test('箭頭、氣體與沉澱記號拿掉（原卷上是 → ↑ ↓，不是負號）', () => {
        const s = ceToComparable('CaCO3 -> CaO + CO2 ^');
        assert.ok(!s.includes('-'), s);
        assert.ok(!s.includes('^'), s);
        assert.equal(s, 'CaCO3 CaO + CO2');
    });
    test('電荷的正負號與數字保留（原卷文字層 SO₄²⁻ 經 NFKC 後也是 SO42-）', () => {
        assert.equal(ceToComparable('SO4^{2-}'), 'SO42-');
    });
    test('箭頭條件的文字保留（原卷上印在箭頭上下）', () => {
        assert.ok(ceToComparable('A ->[加熱] B').includes('加熱'));
    });
});

describe('findCe／replaceCe', () => {
    test('找出每一個 \\ce{…}，大括號可巢狀', () => {
        const found = findCe('先 $\\ce{Fe^{3+}}$ 再 $\\ce{SO4^{2-}}$');
        assert.deepEqual(found.map(f => f.body), ['Fe^{3+}', 'SO4^{2-}']);
        assert.ok(found.every(f => f.closed));
    });
    test('沒關的 \\ce 吃到結尾並標 closed=false', () => {
        const [f] = findCe('$\\ce{H2O$');
        assert.equal(f.closed, false);
    });
    test('replaceCe 沒有 \\ce 時原樣回傳', () => {
        assert.equal(replaceCe('設 $x=1$', () => 'X'), '設 $x=1$');
        assert.equal(replaceCe('得 $\\ce{H2}$ 氣', b => `[${b}]`), '得 $[H2]$ 氣');
    });
});

describe('parseChemAnswer — 答案比對用的結構化解析（第 4.2 條第 4 點）', () => {
    test('\\ce、LaTeX 下標、Unicode 上下標三種寫法解析成同一個正規化式', () => {
        for (const s of ['$\\ce{H2SO4}$', 'H_2SO_4', '$\\mathrm{H_2SO_4}$', 'H₂SO₄']) {
            const r = parseChemAnswer(s);
            assert.equal(r.kind, 'species', s);
            assert.equal(r.items[0].canonical, 'H2SO4', s);
        }
        assert.equal(parseChemAnswer('SO₄²⁻').items[0].canonical, 'SO4^2-');
        assert.equal(parseChemAnswer('$\\ce{SO4^{2-}}$').items[0].canonical, 'SO4^2-');
    });
    test('元素計數含括號與水合物', () => {
        assert.deepEqual(parseSpecies('Ca(OH)2').elements, { Ca: 1, O: 2, H: 2 });
        assert.deepEqual(parseSpecies('CuSO4.5H2O').elements, { Cu: 1, S: 1, O: 9, H: 10 });
    });
    test('反應式拆成左右兩側與係數', () => {
        const r = parseChemAnswer('$\\ce{2H2 + O2 -> 2H2O}$');
        assert.equal(r.kind, 'equation');
        assert.deepEqual(r.left.map(x => [x.coef, x.canonical]), [[2, 'H2'], [1, 'O2']]);
        assert.deepEqual(r.right.map(x => [x.coef, x.canonical]), [[2, 'H2O']]);
    });
    test('半反應的電子是合法物種', () => {
        const r = parseChemAnswer('$\\ce{MnO4^- + 8H+ + 5e- -> Mn^{2+} + 4H2O}$');
        assert.equal(r.left[2].canonical, 'e^-');
        assert.equal(r.left[2].coef, 5);
    });
    test('不像化學式的一律回 null（呼叫端退回原規則）', () => {
        for (const s of ['5', 'x^2', '0.25 M', '互相垂直', 'Xy2', '$\\frac{1}{2}$']) {
            assert.equal(parseChemAnswer(s), null, s);
        }
    });
    test('toCeBody：多個 \\ce 以逗號串成物種清單', () => {
        assert.equal(toCeBody('$\\ce{Na+}$ 與 $\\ce{Cl-}$'), 'Na+ , Cl-');
    });
    test('週期表 118 個元素都在', () => {
        assert.ok(ELEMENTS.size >= 118);
        for (const el of ['H', 'He', 'Og', 'Cl', 'Fe']) assert.ok(ELEMENTS.has(el), el);
    });
});
