// 解析器支援 \bullet、\textbf（Owner 第五輪 L-3 核准，2026-09-27，dec/r6-gates）
//
// 只加在 Word 匯出用的地方：\bullet 進 EXTRA_SYMBOLS（U+2219），\textbf 是 parseCommand 的特判（與 \mathbf 相同只取內容）。
// **不進 SYMBOLS**：SYMBOLS 匯出給 utils/embedText.js 的 latexToPlain，改了會讓既有題目的 embed_text 改變、向量被判過期。
// latexEscapeRepair 的「不支援清單」相應移出這兩個（修復表仍認得：supportedCommandNames() 涵蓋）。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const tf = require('../../utils/textFormatter');
const { formulaLint } = require('../../utils/formulaLint');
const { buildEmbedText } = require('../../utils/embedText');
const repair = require('../../services/llm/latexEscapeRepair');
const fixture = require('../../eval/fixtures/questions.public.json');

describe('解析器：\\bullet、\\textbf', () => {
    test('公式閘門不再發 unknown_command（題幹、上標、純文字裡）', () => {
        for (const s of ['$\\vec{a}\\bullet\\vec{b}=3$', '$30^\\bullet$', '$\\textbf{v}=(1,2)$', '設 $\\textbf{a} \\bullet \\textbf{b} = 0$']) {
            assert.deepEqual(tf.parseLatexStrict(s).events, [], s);
            assert.equal(formulaLint(s).ok, true, s);
        }
    });

    test('Word 輸出：\\bullet 排成 ∙（U+2219），\\textbf 只留內容（不印出指令名）', () => {
        const xml = JSON.stringify(tf.buildParagraphComponents('$\\vec{a}\\bullet\\textbf{v}$'));
        assert.ok(xml.includes('∙'));
        assert.ok(!xml.includes('bullet'));
        assert.ok(!xml.includes('textbf'));
    });

    test('只加在 Word 匯出的表：\\bullet 在 EXTRA_SYMBOLS、不在 SYMBOLS；\\textbf 在 PARSER_COMMANDS', () => {
        assert.equal(tf.EXTRA_SYMBOLS.bullet, '∙');
        assert.equal(tf.SYMBOLS.bullet, undefined);
        assert.equal(tf.SYMBOLS.textbf, undefined);
        assert.ok(tf.PARSER_COMMANDS.includes('textbf'));
        assert.ok(tf.supportedCommandNames().includes('bullet'));
        assert.ok(tf.supportedCommandNames().includes('textbf'));
    });

    test('latexEscapeRepair：兩個名字移出不支援清單，修復表照樣認得（退格＋ullet → \\bullet、定位＋extbf → \\textbf）', () => {
        assert.ok(!repair.UNSUPPORTED_LATEX_COMMANDS.includes('bullet'));
        assert.ok(!repair.UNSUPPORTED_LATEX_COMMANDS.includes('textbf'));
        assert.ok(repair.commandTable().has('bullet'));
        assert.ok(repair.commandTable().has('textbf'));
        assert.equal(repair.repairString('$\\vec{a}\bullet\\vec{b}$').text, '$\\vec{a}\\bullet\\vec{b}$');
        assert.equal(repair.repairString('$\textbf{v}$').text, '$\\textbf{v}$');
    });
});

describe('既有題目的 embed_text 不變', () => {
    test('含 \\bullet、\\textbf 的 embed_text 與改動前逐字相同（改動前在 a670783 算出、寫死）', () => {
        const q = (text) => buildEmbedText({ subject: '數學', chapter: 'x', question_type: '計算', difficulty: 2, question_text: text });
        assert.equal(q('$\\vec{a}\\bullet\\vec{b}=3$'), '數學｜x｜計算｜難度2\nabulletb=3');
        assert.equal(q('$\\textbf{v}=(1,2)$ 與 \\textbf{注意}'), '數學｜x｜計算｜難度2\ntextbfv=(1,2) 與 \\textbf{注意}');
        assert.equal(q('$30^\\bullet$ 的角'), '數學｜x｜計算｜難度2\n30bullet 的角');
    });

    test('fixture 62 題的 embed_text 仍全部查得到本機向量檔（sha256 對得上＝一個字都沒變）', () => {
        const emb = require(path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'embeddings.ollama-qwen3-embedding-0.6b.768.json'));
        assert.equal(fixture.questions.length, 62);
        for (const item of fixture.questions) {
            const h = crypto.createHash('sha256').update(buildEmbedText(item)).digest('hex');
            assert.ok(emb[h], item.id);
        }
    });
});
