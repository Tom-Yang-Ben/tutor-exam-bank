// agents/extractCrossCheck.js 的單元測試（〔本機模式 L2〕docs/local-mode.md 第 4 條第 3.4 點）
//
// 純函式：對齊（依順序＋題幹相似度）、四種 status、合併規則（parseLatexStrict 優先、同分取視覺版、
// 附圖欄位取視覺版、schema 不合格的版本不採用）、門檻常數。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cc = require('../../agents/extractCrossCheck');
const { normalizeStem } = require('../../utils/normalizeStem');

const BASE = {
    subject: '數學', chapter: '等差數列與等比數列', chapter_confidence: 0.9,
    question_type: '計算', difficulty: 2, answer_text: '$21$'
};
const q = (question_text, extra = {}) => ({ ...BASE, question_text, ...extra });

// 相似度（實測值寫在右邊，門檻邊界的案例靠它們）
const LONG = '已知等差數列的首項為 $3$，公差為 $2$，求第 $10$ 項的值。';
const LONG_ONE_WORD = '已知等差數列的首項為 $3$，公差為 $2$，求第 $10$ 項之值。';     // 0.8462：差一個字就掉到門檻下
const LONG_TWO_NUMBERS = '已知等差數列的首項為 $3$，公差為 $4$，求第 $12$ 項的值。';   // 0.7143
const FALL = '一物體自高處自由落下，經過 $2$ 秒後的速率為何？';
const CIRCLE = '已知圓 $x^2+y^2=25$ 與直線 $y=x+1$ 相交於兩點，求弦長。';
const LOG = '若 $\\log_2 x = 3$，求 $x$。';
const BAD_TEX = '已知等差數列的首項為 $3$，公差為 $\\frac{1}{2$，求第 $10$ 項的值。';   // missing_rbrace

describe('extractCrossCheck — 常數', () => {
    test('門檻：兩版一致 0.85（契約預設）、配對下限 0.5', () => {
        assert.equal(cc.AGREE_THRESHOLD, 0.85);
        assert.equal(cc.MATCH_MIN, 0.5);
        assert.ok(cc.MATCH_MIN < cc.AGREE_THRESHOLD);
    });

    test('status 只有四個值', () => {
        assert.deepEqual([...cc.STATUSES], ['agree', 'disagree', 'vision_only', 'ocr_only']);
        assert.ok(Object.isFrozen(cc.STATUSES));
    });

    test('檔頭說明了兩個門檻的意義', () => {
        const src = require('node:fs').readFileSync(require.resolve('../../agents/extractCrossCheck'), 'utf8');
        const head = src.slice(0, src.indexOf('const { normalizeStem }'));
        assert.match(head, /AGREE_THRESHOLD = 0\.85/);
        assert.match(head, /MATCH_MIN = 0\.5/);
    });
});

describe('extractCrossCheck — 相似度（normalizeStem 後的字元 bigram Jaccard）', () => {
    test('bigram 以 code point 切', () => {
        assert.deepEqual([...cc.bigrams('求值x')], ['求值', '值x']);
        assert.equal(cc.bigrams('a').size, 0);
    });

    test('完全相同＝1；只差空白、$、全形半形、選項括號的寫法也＝1（先經 normalizeStem）', () => {
        assert.equal(cc.stemSimilarity(LONG, LONG), 1);
        assert.equal(cc.stemSimilarity('設 $x + 2 = 5$，求 x', '設 x+2=5，求 x'), 1);
        assert.equal(cc.stemSimilarity('（Ａ）　求 x', '(A) 求x'), 1);
        assert.equal(normalizeStem('（Ａ）　求 x'), normalizeStem('(A) 求x'));
    });

    test('Jaccard 的值：|A∩B| / |A∪B|', () => {
        // 'abcd' → {ab,bc,cd}；'abce' → {ab,bc,ce}：交集 2、聯集 4
        assert.equal(cc.stemSimilarity('abcd', 'abce'), 0.5);
        assert.equal(cc.stemSimilarity('abcd', 'wxyz'), 0);
    });

    test('實測量級：差一個字 0.85 附近、差兩個數字 0.71、不同題 < 0.1', () => {
        assert.equal(Number(cc.stemSimilarity(LONG, LONG_ONE_WORD).toFixed(4)), 0.8462);
        assert.equal(Number(cc.stemSimilarity(LONG, LONG_TWO_NUMBERS).toFixed(4)), 0.7143);
        assert.ok(cc.stemSimilarity(LOG, CIRCLE) < 0.1);
    });

    test('空字串、非字串：0；單一字元相同：1', () => {
        assert.equal(cc.stemSimilarity('', ''), 0);
        assert.equal(cc.stemSimilarity(null, undefined), 0);
        assert.equal(cc.stemSimilarity('a', 'a'), 1);
        assert.equal(cc.stemSimilarity('a', 'b'), 0);
    });
});

describe('extractCrossCheck — 對齊（依順序＋相似度）', () => {
    test('兩版一樣長、一一對應 → 依序配對', () => {
        const ops = cc.alignQuestions([LONG, FALL, LOG], [LONG, FALL, LOG]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[0, 0], [1, 1], [2, 2]]);
        assert.deepEqual(ops.map(o => o.similarity), [1, 1, 1]);
    });

    test('OCR 漏了中間那題 → 那題單獨一格（o=null），其餘照樣配對、位置不亂', () => {
        const ops = cc.alignQuestions([LONG, FALL, LOG], [LONG, LOG]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[0, 0], [1, null], [2, 1]]);
    });

    test('OCR 多拆一題 → 那題單獨一格（v=null）', () => {
        const ops = cc.alignQuestions([LONG, LOG], [LONG, CIRCLE, LOG]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[0, 0], [null, 1], [1, 2]]);
    });

    test('同一個空隙裡兩版各有一題配不上 → 視覺版的排在前面', () => {
        const ops = cc.alignQuestions([LONG, FALL, LOG], [LONG, CIRCLE, LOG]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[0, 0], [1, null], [null, 1], [2, 2]]);
    });

    test('低於 MATCH_MIN 的兩題不配對', () => {
        const ops = cc.alignQuestions([LOG], [CIRCLE]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[0, null], [null, 0]]);
        assert.deepEqual(cc.alignQuestions(['abcd'], ['abce'], { matchMin: 0.6 }).map(o => [o.v, o.o]), [[0, null], [null, 0]]);
        assert.deepEqual(cc.alignQuestions(['abcd'], ['abce'], { matchMin: 0.5 }).map(o => [o.v, o.o]), [[0, 0]]);
    });

    test('不交叉配對：OCR 的順序顛倒時只能保住一對', () => {
        const ops = cc.alignQuestions([LONG, FALL], [FALL, LONG]);
        const pairs = ops.filter(o => o.v !== null && o.o !== null);
        assert.equal(pairs.length, 1);
        assert.equal(ops.length, 3);
    });

    test('總相似度最大：視覺版的一題同時像 OCR 的兩題時，配給最像的那一題', () => {
        // OCR 只有 LONG_TWO_NUMBERS（0.7143 像 LONG）與 LONG（1.0）；視覺版只有 LONG
        const ops = cc.alignQuestions([LONG], [LONG_TWO_NUMBERS, LONG]);
        assert.deepEqual(ops.map(o => [o.v, o.o]), [[null, 0], [0, 1]]);
    });

    test('空清單', () => {
        assert.deepEqual(cc.alignQuestions([], []), []);
        assert.deepEqual(cc.alignQuestions([LONG], []).map(o => [o.v, o.o]), [[0, null]]);
        assert.deepEqual(cc.alignQuestions([], [LONG]).map(o => [o.v, o.o]), [[null, 0]]);
    });
});

describe('extractCrossCheck — status', () => {
    test('agree：相似度 ≥ 0.85；alt_question_text 是 OCR 版題幹', () => {
        const [slot] = cc.crossCheck([q(LONG)], [q(LONG)]);
        assert.equal(slot.status, 'agree');
        assert.deepEqual(slot.question.cross_check, { status: 'agree', similarity: 1, alt_question_text: LONG, picked: 'vision' });
    });

    test('門檻邊界：相似度「等於」門檻算 agree；0.8462 < 0.85 算 disagree', () => {
        // 構造剛好 0.85：A 有 18 個 bigram，B 有 19 個，交集 17 → 17 / (18 + 19 - 17) = 0.85
        const A = 'abcdefghijklmnopqrs';
        const B = 'abcdefghijklmnopqrXY';
        assert.equal(cc.stemSimilarity(A, B), 0.85);
        assert.equal(cc.crossCheck([q(A)], [q(B)])[0].status, 'agree');
        // 用 agreeThreshold 參數把邊界搬到實測值 0.8462 上，驗證判定是「≥」而不是「>」
        const [slot] = cc.crossCheck([q(LONG)], [q(LONG_ONE_WORD)], { agreeThreshold: 0.8462 });
        assert.equal(slot.status, 'agree');
        const [slot2] = cc.crossCheck([q(LONG)], [q(LONG_ONE_WORD)]);
        assert.equal(slot2.status, 'disagree');
        assert.equal(slot2.similarity, 0.8462);
        assert.equal(slot2.question.cross_check.similarity, 0.8462, '寫進 payload 的值與判定用的值是同一個（四位小數）');
    });

    test('disagree：0.5 ≤ 相似度 < 0.85（例如兩版讀出的數字不同）', () => {
        const [slot] = cc.crossCheck([q(LONG)], [q(LONG_TWO_NUMBERS)]);
        assert.equal(slot.status, 'disagree');
        assert.equal(slot.question.question_text, LONG, '兩版公式都合法 → 採視覺版');
        assert.equal(slot.question.cross_check.alt_question_text, LONG_TWO_NUMBERS);
    });

    test('vision_only／ocr_only：similarity 與 alt_question_text 都是 null', () => {
        const slots = cc.crossCheck([q(LONG), q(FALL)], [q(LONG), q(CIRCLE)]);
        const byStatus = Object.fromEntries(slots.map(s => [s.status, s]));
        assert.deepEqual(byStatus.vision_only.question.cross_check, { status: 'vision_only', similarity: null, alt_question_text: null, picked: 'vision' });
        assert.deepEqual(byStatus.ocr_only.question.cross_check, { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' });
        assert.equal(byStatus.ocr_only.question.question_text, CIRCLE);
    });

    test('OCR 沒跑（null／undefined）→ 每題都是 vision_only，順序不變', () => {
        for (const off of [null, undefined]) {
            const slots = cc.crossCheck([q(LONG), q(FALL)], off);
            assert.deepEqual(slots.map(s => s.status), ['vision_only', 'vision_only']);
            assert.deepEqual(slots.map(s => s.question.question_text), [LONG, FALL]);
            assert.equal(slots[0].question.cross_check.similarity, null);
        }
    });

    test('OCR 跑了但一題都沒拆到（空陣列）→ 視覺版每題都是 vision_only', () => {
        assert.deepEqual(cc.crossCheck([q(LONG)], []).map(s => s.status), ['vision_only']);
    });

    test('兩版都空 → 空陣列', () => {
        assert.deepEqual(cc.crossCheck([], []), []);
        assert.deepEqual(cc.crossCheck(undefined, undefined), []);
    });
});

describe('extractCrossCheck — 合併規則', () => {
    test('視覺版公式不能通過 parseLatexStrict、OCR 版可以 → 採 OCR 版，alt 是視覺版題幹', () => {
        const [slot] = cc.crossCheck([q(BAD_TEX)], [q(LONG)]);
        assert.equal(cc.formulaOk(q(BAD_TEX)), false);
        assert.equal(cc.formulaOk(q(LONG)), true);
        assert.equal(slot.picked, 'ocr');
        assert.equal(slot.question.question_text, LONG);
        assert.equal(slot.question.cross_check.picked, 'ocr');
        assert.equal(slot.question.cross_check.alt_question_text, BAD_TEX);
    });

    test('答案的公式也算：視覺版答案壞掉 → 採 OCR 版', () => {
        const [slot] = cc.crossCheck([q(LONG, { answer_text: '$\\frac{1}{2$' })], [q(LONG)]);
        assert.equal(slot.picked, 'ocr');
        assert.equal(slot.question.answer_text, '$21$');
    });

    test('兩版公式都能通過 → 採視覺版；兩版都通不過 → 也採視覺版', () => {
        assert.equal(cc.crossCheck([q(LONG)], [q(LONG)])[0].picked, 'vision');
        const bad2 = BAD_TEX.replace('$3$', '$\\vecc{3}$');
        assert.equal(cc.formulaOk(q(bad2)), false);
        assert.equal(cc.crossCheck([q(BAD_TEX)], [q(bad2)])[0].picked, 'vision');
    });

    test('採 OCR 版時，附圖欄位（figure_desc／figure_page／figure_box）仍取視覺版的', () => {
        const vision = q(BAD_TEX, { figure_desc: '直角三角形 ABC，∠C=90°', figure_page: 1, figure_box: [100, 200, 300, 400] });
        const ocrQ = q(LONG, { figure_desc: 'OCR 亂寫的描述' });
        const [slot] = cc.crossCheck([vision], [ocrQ]);
        assert.equal(slot.picked, 'ocr');
        assert.equal(slot.question.figure_desc, '直角三角形 ABC，∠C=90°');
        assert.equal(slot.question.figure_page, 1);
        assert.deepEqual(slot.question.figure_box, [100, 200, 300, 400]);
        assert.notEqual(slot.question.figure_box, vision.figure_box, '陣列要複製，不共用參考');
    });

    test('採 OCR 版、視覺版沒有附圖 → OCR 版自己的欄位原樣保留', () => {
        const [slot] = cc.crossCheck([q(BAD_TEX)], [q(LONG, { figure_desc: '有一張圖' })]);
        assert.equal(slot.question.figure_desc, '有一張圖');
    });

    test('isValid：只有一版合格就用那一版（不看公式）', () => {
        const isValid = (x, source) => source === 'ocr';
        const [slot] = cc.crossCheck([q(LONG)], [q(LONG_TWO_NUMBERS)], { isValid });
        assert.equal(slot.picked, 'ocr');
        assert.equal(slot.status, 'disagree', 'status 仍依相似度決定');
        assert.equal(slot.question.cross_check.alt_question_text, LONG, 'alt 是不合格那一版的題幹');

        const [slot2] = cc.crossCheck([q(BAD_TEX)], [q(LONG)], { isValid: (x, s) => s === 'vision' });
        assert.equal(slot2.picked, 'vision', 'OCR 版不合格，就算視覺版公式壞了也只能用視覺版');
    });

    test('isValid：兩版都不合格 → question=null、picked=null（呼叫端記進 rejected）', () => {
        const [slot] = cc.crossCheck([q(LONG)], [q(LONG)], { isValid: () => false });
        assert.equal(slot.question, null);
        assert.equal(slot.picked, null);
        assert.equal(slot.status, 'agree');
        assert.ok(slot.vision && slot.ocr, '兩版原件都交回給呼叫端，才印得出錯誤');

        const [only] = cc.crossCheck([q(LONG)], null, { isValid: () => false });
        assert.equal(only.question, null);
        assert.equal(only.status, 'vision_only');
    });

    test('輸入不會被改動', () => {
        const vision = [q(BAD_TEX, { figure_page: 1, figure_box: [1, 2, 3, 4] })];
        const ocrQs = [q(LONG)];
        const snapshot = JSON.stringify([vision, ocrQs]);
        cc.crossCheck(vision, ocrQs);
        assert.equal(JSON.stringify([vision, ocrQs]), snapshot);
        assert.equal('cross_check' in vision[0], false);
    });

    test('合併後的題保留採用那一版的所有欄位，外加 cross_check', () => {
        const [slot] = cc.crossCheck([q(LONG, { chapter_confidence: 0.4 })], [q(LONG, { chapter_confidence: 0.99 })]);
        const { cross_check, ...fields } = slot.question;
        assert.deepEqual(fields, q(LONG, { chapter_confidence: 0.4 }));
        assert.deepEqual(Object.keys(cross_check), ['status', 'similarity', 'alt_question_text', 'picked']);
    });
});

describe('extractCrossCheck — summarize', () => {
    test('只數有題目的格', () => {
        const slots = cc.crossCheck([q(LONG), q(FALL), q(LOG)], [q(LONG_TWO_NUMBERS), q(CIRCLE), q(LOG)],
            { isValid: (x) => x.question_text !== FALL });
        assert.deepEqual(cc.summarize(slots), { agree: 1, disagree: 1, vision_only: 0, ocr_only: 1 });
        assert.deepEqual(cc.summarize([]), { agree: 0, disagree: 0, vision_only: 0, ocr_only: 0 });
    });
});
