// normalizeStem / textHash 單元測試（A-T5 / WS-C）
//
// 契約：docs/interfaces-stage2.md 第 4.1 條的七個步驟，順序凍結。
// 另外釘住「與 S0 在 scripts/backfill_text_hash.js 裡的自含版逐位元相同」——
// 開發庫 2026-08-21 已經用 S0 版回填過 text_hash，不相同就代表全庫要重算。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStem, textHash } = require('../../utils/normalizeStem');
const s0 = require('../fixtures/normalizeStem.s0');
const fixture = require('../../eval/fixtures/questions.public.json');

describe('normalizeStem — 七個步驟', () => {
    test('1. 非字串／空字串一律回 ""，不得拋例外', () => {
        for (const v of [null, undefined, '', 0, 123, {}, [], NaN]) {
            assert.doesNotThrow(() => normalizeStem(v));
            assert.equal(normalizeStem(v), '');
        }
    });

    test('2. 剝掉 [附圖描述：…]（全半形冒號、可跨行、可多段）', () => {
        assert.equal(normalizeStem('題幹[附圖描述：一個直角三角形]結尾'), '題幹結尾');
        assert.equal(normalizeStem('題幹[附圖描述:半形冒號]結尾'), '題幹結尾');
        assert.equal(normalizeStem('題幹[附圖描述：第一行\n第二行]結尾'), '題幹結尾');
        assert.equal(normalizeStem('a[附圖描述：甲]b[附圖描述：乙]c'), 'abc');
    });

    test('3. NFKC：全形英數、全形括號、全形標點 → 半形', () => {
        assert.equal(normalizeStem('正確？'), normalizeStem('正確?'));
        assert.equal(normalizeStem('ＡＢＣ１２３'), 'abc123');
    });

    test('4a. 括號型選項代號統一成 (A)', () => {
        const want = normalizeStem('(A)甲');
        for (const v of ['（A）甲', '[A]甲', '【A】甲', '( a )甲', '（ Ａ ）甲']) {
            assert.equal(normalizeStem(v), want, v);
        }
    });

    test('4b. 行首或空白後的「A.」「A、」「A：」也統一成 (A)', () => {
        assert.equal(normalizeStem('A. 甲'), normalizeStem('(A) 甲'));
        assert.equal(normalizeStem('A、甲'), normalizeStem('(A) 甲'));
        assert.equal(normalizeStem('第一行\nB：乙'), normalizeStem('第一行\n(B) 乙'));
    });

    test('4b. 句子中間的字母不會被誤認成代號', () => {
        // 「點 A.」前面有空白會被當代號（規則如此）；但「PA.」這種沒有空白的不會
        assert.ok(normalizeStem('線段PA.長度').includes('pa.'));
    });

    test('5+6+7. 去 $、去空白換行、轉小寫', () => {
        assert.equal(normalizeStem('$x$ = $1$'), 'x=1');
        assert.equal(normalizeStem('X = 1'), 'x=1');
        assert.equal(normalizeStem('a\n b\tc'), 'abc');
    });

    test('介面第 4.1 條列的四組「已知會收斂」的寫法', () => {
        assert.equal(normalizeStem('正確？'), normalizeStem('正確?'));
        assert.equal(normalizeStem('(A)'), normalizeStem('（Ａ）'));
        assert.equal(normalizeStem('A. 甲'), normalizeStem('(A) 甲'));
        assert.equal(normalizeStem('$x$=$1$'), normalizeStem('x=1'));
    });
});

describe('textHash', () => {
    test('是 sha256 的小寫 hex（64 字）', () => {
        const h = textHash('測試題目');
        assert.match(h, /^[0-9a-f]{64}$/);
    });

    test('正規化後為空一律回 null', () => {
        for (const v of [null, undefined, '', '   ', '\n\n', '[附圖描述：只有圖]']) {
            assert.equal(textHash(v), null, JSON.stringify(v));
        }
    });

    test('同一題的不同抄寫得到同一個雜湊', () => {
        assert.equal(textHash('$x$ = $1$ ？'), textHash('x = 1?'));
        assert.equal(textHash('(A) 甲　(B) 乙'), textHash('A. 甲  B、乙'));
    });

    test('不同題得到不同雜湊', () => {
        assert.notEqual(textHash('求 $x$ 之值'), textHash('求 $y$ 之值'));
    });
});

describe('與 S0 自含版（scripts/backfill_text_hash.js @ e1740ca）逐位元相同', () => {
    test('對公開 fixture 60 題的題幹與答案', () => {
        for (const q of fixture.questions) {
            for (const field of ['question_text', 'answer_text']) {
                assert.equal(normalizeStem(q[field]), s0.normalizeStem(q[field]), `#${q.id} ${field}`);
                assert.equal(textHash(q[field]), s0.textHash(q[field]), `#${q.id} ${field} 的雜湊`);
            }
        }
    });

    test('對邊界與各步驟的代表案例', () => {
        const cases = [
            null, undefined, '', '   ', 0, 123, {},
            '題幹[附圖描述：一個直角三角形]結尾',
            '（Ａ）甲　(b) 乙　C. 丙　D、丁',
            '$\\frac{1}{2}$ 與 $\\sqrt{2}$',
            '第一行\r\n第二行\t有 tab',
            '正確？', '正確?', 'ＡＢＣ１２３',
            '[附圖描述：只有圖]',
            'A.甲', 'A. 甲', ' A：甲',
        ];
        for (const c of cases) {
            assert.equal(normalizeStem(c), s0.normalizeStem(c), JSON.stringify(c));
            assert.equal(textHash(c), s0.textHash(c), JSON.stringify(c) + ' 的雜湊');
        }
    });
});
