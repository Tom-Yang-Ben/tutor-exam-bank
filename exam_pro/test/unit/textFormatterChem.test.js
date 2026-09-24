// utils/textFormatter.js 的化學排版單元測試（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 3 點）
//
// 每一種記法各一個案例，斷言兩件事：
//   1. 真的打包成 .docx 之後，word/document.xml 裡長出對的 OMML（下標 m:sSub、電荷 m:sSup、
//      正體 m:sty m:val="p"、箭頭字元、m:groupChr／m:limLow、m:sPre）；
//   2. parseLatexStrict 沒有任何事件 → utils/formulaLint.js 放行（不會被 lint 當成未知指令擋題）。
// 既有輸出不變由 test/unit/textFormatterStrict.test.js（對照凍結副本）與 textFormatter.test.js 負責。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Document, Packer, Paragraph } = require('docx');

const { buildParagraphComponents, parseLatexStrict, parseLatexToMath, EXTRA_SYMBOLS, SYMBOLS } = require('../../utils/textFormatter');
const { formulaLint } = require('../../utils/formulaLint');
const { documentXml } = require('../e2e/lib/docx');

/** 一段題目文字 → word/document.xml 的 <w:body> 內容 */
async function bodyXml(text) {
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: buildParagraphComponents(text) })] }] });
    const xml = documentXml(await Packer.toBuffer(doc));
    return xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:sectPr'));
}

const UPRIGHT = '<m:rPr><m:sty m:val="p"/></m:rPr>';

describe('化學記法 → Word OMML（逐一記法）', () => {
    const CASES = [
        ['化學式下標', '$\\ce{H2O}$', ['<m:sSub>', `${UPRIGHT}<m:t>H</m:t>`, `${UPRIGHT}<m:t>2</m:t>`]],
        ['離子電荷上標', '$\\ce{SO4^{2-}}$', ['<m:sSubSup>', '<m:t>2</m:t>', '<m:t>-</m:t>']],
        ['結尾電荷 Na+', '$\\ce{Na+}$', ['<m:sSup>', '<m:t>+</m:t>']],
        ['係數', '$\\ce{2H2O}$', ['<m:r><m:t>2</m:t></m:r>', '<m:sSub>']],
        ['單向箭頭', '$\\ce{A -> B}$', ['<m:t>→</m:t>']],
        ['逆向箭頭', '$\\ce{A <- B}$', ['<m:t>←</m:t>']],
        ['可逆箭頭', '$\\ce{A <=> B}$', ['<m:t>⇌</m:t>']],
        ['物態 (aq)', '$\\ce{NaCl(aq)}$', [`${UPRIGHT}<m:t>a</m:t>`, `${UPRIGHT}<m:t>q</m:t>`]],
        ['氣體 ^', '$\\ce{CO2 ^}$', ['<m:t>↑</m:t>']],
        ['沉澱 v', '$\\ce{AgCl v}$', ['<m:t>↓</m:t>']],
        ['水合物的點', '$\\ce{CuSO4.5H2O}$', ['<m:t>·</m:t>']],
        ['同位素前標（m:sPre，順序 sub、sup、e）', '$\\ce{^{14}_{6}C}$', ['<m:sPre><m:sub>', '</m:sub><m:sup>', '</m:sup><m:e>']],
        ['\\rightleftharpoons', '$A \\rightleftharpoons B$', ['<m:t>⇌</m:t>']],
        ['\\uparrow／\\downarrow', '$\\uparrow \\downarrow$', ['<m:t>↑</m:t>', '<m:t>↓</m:t>']],
        ['\\xrightarrow{上}：m:groupChr，箭頭在下、基線對齊', '$A \\xrightarrow{\\Delta} B$',
            ['<m:groupChr><m:groupChrPr><m:chr m:val="→"/><m:vertJc m:val="bot"/></m:groupChrPr><m:e>', '<m:t>Δ</m:t>']],
        ['\\xrightarrow[下]{上}：外層 m:limLow', '$A \\xrightarrow[\\text{加熱}]{MnO_2} B$',
            ['<m:limLow><m:e><m:groupChr>', '<m:lim>', '<m:t>加</m:t>']],
        ['\\xrightarrow[下]{}：只有下方文字', '$A \\xrightarrow[x]{} B$', ['<m:limLow><m:e><m:r><m:t>→</m:t></m:r></m:e><m:lim>']],
        ['\\mathrm 輸出正體', '$5\\ \\mathrm{cm}$', [`${UPRIGHT}<m:t>c</m:t>`, `${UPRIGHT}<m:t>m</m:t>`]],
        ['\\ce 寫在 $ 外面也轉', '生成 \\ce{H2} 氣體', ['<m:sSub>', '<w:t xml:space="preserve">生成 </w:t>']]
    ];

    for (const [name, input, fragments] of CASES) {
        test(`${name}：${input}`, async () => {
            const xml = await bodyXml(input);
            for (const f of fragments) assert.ok(xml.includes(f), `缺少 ${f}\n${xml}`);
            assert.ok(xml.includes('<m:oMath>'), '沒有轉成 Word 原生方程式');
            const strict = parseLatexStrict(input);
            assert.deepEqual(strict.events, [], `parseLatexStrict 有事件：${JSON.stringify(strict.events)}`);
            assert.equal(formulaLint(input).ok, true, 'formulaLint 應放行');
        });
    }

    test('化學式本體是正體，但 \\text 維持原樣（只有 \\mathrm 改正體）', async () => {
        const xml = await bodyXml('$\\text{m}$');
        assert.ok(!xml.includes('m:sty'), xml);
    });

    test('mhchem 子集以外的寫法不丟例外、不產生事件，照字面進 \\mathrm', () => {
        const r = parseLatexStrict('$\\ce{A-B=C#D}$');
        assert.equal(r.ok, true);
    });

    test('\\ce 沒關：記 missing_rbrace（lint 會擋），位置落在 \\ce 內', () => {
        const r = parseLatexStrict('$\\ce{H2O$');
        assert.deepEqual(r.events.map(e => e.kind), ['missing_rbrace']);
        assert.equal(formulaLint('$\\ce{H2O$').ok, false);
    });

    test('\\ce 本體裡的未知指令：事件位置記在 \\ce 本身', () => {
        const input = '反應 $\\ce{A ->[\\foobar] B}$';
        const r = parseLatexStrict(input);
        assert.deepEqual(r.events.map(e => e.kind), ['unknown_command']);
        assert.equal(r.events[0].at, input.indexOf('\\ce'));
    });
});

describe('既有對照表不動（embedText 共用 SYMBOLS）', () => {
    test('化學箭頭放在 EXTRA_SYMBOLS，沒有併進 SYMBOLS', () => {
        for (const k of ['rightleftharpoons', 'uparrow', 'downarrow']) {
            assert.ok(EXTRA_SYMBOLS[k], k);
            assert.equal(SYMBOLS[k], undefined, `${k} 不該出現在 SYMBOLS（會改變既有題目的 embed_text）`);
        }
    });

    test('\\text、\\mathbf 仍只是拆殼（元件形狀與階段 5 之前相同）', () => {
        const kinds = parseLatexToMath('\\text{ab}').map(n => n.rootKey);
        assert.deepEqual(kinds, ['m:r', 'm:r']);
    });
});
