// Word 考卷題目區一題的順序：題號 → 題目敘述 → [題型] (難度)（services/wordService.js）
//
// 題號是「1. 」，題型與難度接在題目敘述同一段的最後面。答案區的題號（「第 1 題答案：」）不變。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wordService = require('../../services/wordService');
const { documentXml } = require('../e2e/lib/docx');

/** document.xml 裡所有 <w:t> 的文字，依出現順序接起來 */
function textOf(xml) {
    return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
}

const QUESTIONS = [
    { id: 1, question_type: '單選', difficulty: 3, question_text: '甲敘述，下列何者正確？(A) 一 (B) 二', answer_text: 'A' },
    { id: 2, question_type: '計算', difficulty: 2, question_text: '乙敘述，求其值。', answer_text: '5' }
];

describe('Word 考卷：一題的順序', () => {
    test('questionNumber／questionTags（純函式）', () => {
        assert.equal(wordService.questionNumber(1), '1. ');
        assert.equal(wordService.questionNumber(12), '12. ');
        assert.equal(wordService.questionTags({ question_type: '多選', difficulty: 4 }), ' [多選] (難度: ★★★★)');
        assert.equal(wordService.questionTags({ question_type: '填空', difficulty: null }), ' [填空] (難度: )');
    });

    test('題目區：題號 → 題目敘述 → [題型] (難度)，同一段；不再出現「第 N 題.」', async () => {
        const buf = await wordService.generateExamPaperDocx('順序測試卷', '測試生', QUESTIONS, { edition: 'student' });
        const xml = documentXml(buf);
        const text = textOf(xml);
        assert.ok(text.includes('1. 甲敘述，下列何者正確？(A) 一 (B) 二 [單選] (難度: ★★★)'), text);
        assert.ok(text.includes('2. 乙敘述，求其值。 [計算] (難度: ★★)'), text);
        assert.ok(!/第 \d+ 題\./.test(text), '舊的題號寫法不該再出現');

        // 同一段：題號與標籤之間沒有段落邊界
        const para = xml.split('</w:p>').find(p => p.includes('甲敘述'));
        assert.ok(para.includes('>1. <') && para.includes('[單選] (難度: ★★★)'), '題號、敘述、標籤在同一個段落');
    });

    test('答案區的題號維持「第 N 題答案：」', async () => {
        const buf = await wordService.generateExamPaperDocx('順序測試卷', '測試生', QUESTIONS, {});
        const text = textOf(documentXml(buf));
        assert.ok(text.includes('第 1 題答案：') && text.includes('第 2 題答案：'), text);
    });
});
