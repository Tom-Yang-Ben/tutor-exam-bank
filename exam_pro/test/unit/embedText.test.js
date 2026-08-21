// utils/embedText.js 單元測試（WS-C / D-E3）
//
// buildEmbedText 是「該不該重算向量」的唯一依據（embed_hash = sha256(輸出)），
// 因此這裡測的是格式逐字元的穩定性：多一個空行、少一個全形分隔線，
// 全題庫的 embed_hash 都會變、所有向量作廢。
//
// 執行：npm test（不連 DB、不呼叫 Gemini）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildEmbedText } = require('../../utils/embedText');

const BASE = {
    subject: '數學',
    chapter: '向量內積',
    question_type: '計算',
    difficulty: 3,
    question_text: '設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。',
};

/** 取輸出的第 n 行（0-based） */
const line = (q, n) => buildEmbedText(q).split('\n')[n];

describe('buildEmbedText — 整體格式', () => {
    test('行 1 = 學科｜章節｜題型｜難度N', () => {
        assert.equal(line(BASE, 0), '數學｜向量內積｜計算｜難度3');
    });

    test('沒有 concept_summary／keywords 時只有兩行，尾端不留空行', () => {
        const out = buildEmbedText(BASE);
        assert.equal(out.split('\n').length, 2);
        assert.ok(!out.endsWith('\n'));
    });

    test('有 concept_summary 與 keywords 時是四行，順序固定', () => {
        const out = buildEmbedText({ ...BASE, concept_summary: '向量長度的計算', keywords: ['向量', '內積', '長度'] });
        const lines = out.split('\n');
        assert.equal(lines.length, 4);
        assert.equal(lines[2], '向量長度的計算');
        assert.equal(lines[3], '向量 內積 長度');
    });

    test('只有 keywords 沒有 concept_summary 時，keywords 上移成第三行（不留空行）', () => {
        const lines = buildEmbedText({ ...BASE, keywords: ['向量'] }).split('\n');
        assert.equal(lines.length, 3);
        assert.equal(lines[2], '向量');
    });

    test('keywords 是空陣列或全空白 → 整行不輸出', () => {
        assert.equal(buildEmbedText({ ...BASE, keywords: [] }).split('\n').length, 2);
        assert.equal(buildEmbedText({ ...BASE, keywords: ['', '  '] }).split('\n').length, 2);
    });

    test('concept_summary 是空字串或全空白 → 整行不輸出', () => {
        assert.equal(buildEmbedText({ ...BASE, concept_summary: '   ' }).split('\n').length, 2);
    });
});

describe('buildEmbedText — 缺欄位不得拋出例外', () => {
    test('缺 question_text → 第 2 行是空字串', () => {
        const out = buildEmbedText({ subject: '數學', chapter: '極限', question_type: '填空', difficulty: 4 });
        assert.equal(out, '數學｜極限｜填空｜難度4\n');
        assert.equal(out.split('\n')[1], '');
    });

    test('空物件 / null / undefined 都回字串而不是丟錯', () => {
        assert.equal(typeof buildEmbedText({}), 'string');
        assert.equal(typeof buildEmbedText(null), 'string');
        assert.equal(typeof buildEmbedText(undefined), 'string');
    });

    test('question_text 為 null 也照樣輸出兩行', () => {
        assert.equal(buildEmbedText({ ...BASE, question_text: null }).split('\n').length, 2);
    });
});

describe('latexToPlain（行 2）— $...$ 的轉換規則', () => {
    const plain = (t) => line({ ...BASE, question_text: t }, 1);

    test('$ 界定符被移除', () => {
        assert.ok(!plain('值為 $x+1$。').includes('$'));
    });

    test('\\frac{a}{b} → a/b', () => {
        assert.equal(plain('$\\frac{a}{b}$'), 'a/b');
        assert.equal(plain('$\\frac{16}{3}$'), '16/3');
        assert.equal(plain('$\\frac{\\pi}{2}$'), 'π/2');
    });

    test('分子分母含運算子時補上括號，避免 a+b/2 這種語意漂移', () => {
        assert.equal(plain('$\\frac{a+b}{2}$'), '(a+b)/2');
    });

    test('\\sqrt{x} → √x；\\sqrt[3]{8} → 3√8', () => {
        assert.equal(plain('$\\sqrt{x}$'), '√x');
        assert.equal(plain('$\\sqrt[3]{8}$'), '3√8');
    });

    test('希臘字母與符號用 textFormatter 的同一份對照表', () => {
        assert.equal(plain('$\\theta$'), 'θ');
        assert.equal(plain('$5\\times3$'), '5×3');
        assert.equal(plain('$a\\leq b$'), 'a≤b');
    });

    test('函數名保留（\\sin\\theta → sinθ）', () => {
        assert.equal(plain('$\\sin\\theta$'), 'sinθ');
    });

    test('去掉 {}、^、_，保留數字與字母', () => {
        assert.equal(plain('$x^2$'), 'x2');
        assert.equal(plain('$a_{n+1}$'), 'an+1');
        assert.ok(!plain('$x^{2}+y^{2}=r^{2}$').includes('{'));
    });

    test('\\vec{a} 去掉重音記號只留內容', () => {
        assert.equal(plain('$\\vec{a}\\cdot\\vec{b}$'), 'a·b');
    });

    test('$ 之外的中文敘述、[附圖描述：…] 與選項代號原樣保留', () => {
        const out = plain('若 $v$ 加倍則？(A) 2 (B) 4 [附圖描述：斜面上的木塊]');
        assert.ok(out.includes('[附圖描述：斜面上的木塊]'));
        assert.ok(out.includes('(A) 2'));
        assert.ok(out.includes('(B) 4'));
    });

    test('未閉合的 $ 與未閉合的 { 都不丟例外', () => {
        assert.doesNotThrow(() => plain('未閉合 $x^2'));
        assert.doesNotThrow(() => plain('$\\frac{1}{2'));
        assert.doesNotThrow(() => plain('$'));
    });

    test('換行與連續空白壓成單一空白（embed_text 的每一行就是一行）', () => {
        assert.equal(plain('第一段\n\n第二段   第三段'), '第一段 第二段 第三段');
    });
});

describe('buildEmbedText — 純函式性質', () => {
    test('同一輸入兩次，輸出與 sha256 完全相同', () => {
        const a = buildEmbedText(BASE);
        const b = buildEmbedText(BASE);
        assert.equal(a, b);
        const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
        assert.equal(h(a), h(b));
    });

    test('不修改傳入的物件', () => {
        const q = { ...BASE, keywords: ['向量'] };
        const snapshot = JSON.stringify(q);
        buildEmbedText(q);
        assert.equal(JSON.stringify(q), snapshot);
    });

    test('難度 0 或字串型別的難度也照原樣輸出（不做正規化，正規化是 controller 的事）', () => {
        assert.equal(line({ ...BASE, difficulty: '5' }, 0), '數學｜向量內積｜計算｜難度5');
    });
});
