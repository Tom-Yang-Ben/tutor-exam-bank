// ─────────────────────────────────────────────────────────────
// 表格（\begin{array} + \hline，跨行 $$…$$）、\mathbb、\triangle、\ell、\left\{ 的
// lint 與 Word 轉換——2026-09-15 依真實題庫的 8 題 error 補的回歸測試。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { formulaLint } = require('../../utils/formulaLint');
const { buildParagraphComponents, parseLatexStrict, foldDisplayMath, SYMBOLS } = require('../../utils/textFormatter');

const TABLE = [
    '下表為甲、乙、丙三顆衛星資料：',
    '$$\\begin{array}{|c|c|c|c|}',
    '\\hline',
    ' & \\text{甲} & \\text{乙} & \\text{丙} \\\\',
    '\\hline',
    '\\text{質量} & m & 4m & 6m \\\\',
    '\\hline',
    '\\end{array}$$',
    '試問何者受到的引力最大？'
].join('\n');

function xml(comps) { return JSON.stringify(comps); }

describe('表格：跨行 $$…$$ 的 \\begin{array} 與 \\hline', () => {
    test('foldDisplayMath 只把區塊公式內的換行換成空白，長度不變', () => {
        const folded = foldDisplayMath(TABLE);
        assert.equal(folded.length, TABLE.length);
        assert.equal(folded.split('\n').length, 3, '摺完只剩三行：說明／表格／問句');
        assert.ok(!/\$\$[^]*\n[^]*\$\$/.test(folded));
    });
    test('lint 通過（原本：missing_rbrace ＋ 每個 \\hline 一個 unknown_command）', () => {
        const r = formulaLint(TABLE);
        assert.deepEqual(r.issues.filter(i => i.sev === 'error'), [], JSON.stringify(r.issues));
    });
    test('Word 轉換出一個矩陣，\\hline 不出現、strict 無事件', () => {
        const strict = parseLatexStrict(TABLE);
        assert.deepEqual(strict.events, []);
        const s = xml(buildParagraphComponents(TABLE));
        assert.ok(s.includes('"m:m"') || s.includes('m:m'), '應有 OMML 矩陣');
        assert.ok(!s.includes('hline'));
        assert.ok(s.includes('甲') && s.includes('質') && s.includes('量'), '儲存格文字逐字成 m:t run');
    });
    test('矩陣列數：\\hline 略過後仍是兩列、四欄', () => {
        const comps = buildParagraphComponents('$$\\begin{array}{cc}\\hline a & b \\\\ \\hline c & d \\\\ \\hline\\end{array}$$');
        const s = xml(comps);
        assert.equal((s.match(/"m:mr"/g) || []).length, 2);
    });
});

describe('題庫實際出現過的指令', () => {
    test('\\triangle、\\ell、\\hbar 有對應符號', () => {
        assert.equal(SYMBOLS.triangle, '△');
        assert.equal(SYMBOLS.ell, 'ℓ');
        const r = formulaLint('在 $\\triangle ABC$ 中，$\\angle A = 30^\\circ$，擺長 $\\ell$');
        assert.deepEqual(r.issues.filter(i => i.sev === 'error'), []);
    });
    test('\\mathbb{R} → ℝ，多字母與 \\mathcal 照字面', () => {
        assert.deepEqual(parseLatexStrict('$a \\in \\mathbb{R}$').events, []);
        assert.ok(xml(buildParagraphComponents('$\\mathbb{R}$')).includes('ℝ'));
        assert.ok(xml(buildParagraphComponents('$\\mathbb{RZ}$')).includes('ℝℤ'));
        assert.ok(xml(buildParagraphComponents('$\\mathcal{L}$')).includes('L'));
    });
    test('\\left\\{ 方程組：逸出的大括號不算群組', () => {
        const r = formulaLint('已知方程組 $\\left\\{ \\matrix{ 5x - 8y + z = 1 \\cr 4x - y = 2 } \\right.$');
        assert.ok(!r.issues.some(i => i.rule === 'brace_unbalanced'), JSON.stringify(r.issues));
    });
    test('真的少一個右大括號仍會被抓到', () => {
        const r = formulaLint('$\\frac{1}{2$');
        assert.ok(r.issues.some(i => i.rule === 'brace_unbalanced'));
    });
});
