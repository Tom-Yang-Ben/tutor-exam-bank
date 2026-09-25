// public/js/review.js 的 extract_disagree 標籤與說明句（〔本機模式 L2〕docs/local-mode.md 第 4 條第 4 點）
//
// 複核頁要看得出「這題為什麼停下來」：標籤＝「拆題交叉驗證不一致」，說明句帶相似度、採用哪一版、
// 以及另一版的題幹（payload.extract.cross_check.alt_question_text）。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REVIEW_JS = path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js');
const SOURCE = fs.readFileSync(REVIEW_JS, 'utf8');

let cached = null;
function load() {
    // review.js 是 ES module、本專案是 commonjs：與 test/unit/publicAssets.test.js 同一個載入法（data: URL）
    if (!cached) cached = import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE));
    return cached;
}

const payload = (cross_check) => ({ extract: { question_text: '視覺版題幹', cross_check } });

describe('review.js — extract_disagree', () => {
    test('標籤對照有「拆題交叉驗證不一致」（下拉選單也從這張表產生）', () => {
        assert.match(SOURCE, /extract_disagree: '拆題交叉驗證不一致'/);
        assert.match(SOURCE, /extract_disagree: 'amber'/);
    });

    test('disagree：說明句帶相似度、採用哪一版、另一版題幹', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('extract_disagree', payload({
            status: 'disagree', similarity: 0.6234, alt_question_text: 'OCR 讀到的題幹 $x=2$', picked: 'vision'
        }));
        assert.match(s, /相似度 0\.62/);
        assert.match(s, /採用視覺版/);
        assert.match(s, /另一版題幹：「OCR 讀到的題幹 \$x=2\$」/);
        const t = reasonSentence('extract_disagree', payload({ status: 'disagree', similarity: 0.7, alt_question_text: 'v', picked: 'ocr' }));
        assert.match(t, /採用OCR 版/);
    });

    test('另一版題幹太長時截斷（複核卡片的原因列是一行字）', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('extract_disagree', payload({ status: 'disagree', similarity: 0.5, alt_question_text: '甲'.repeat(400), picked: 'vision' }));
        assert.ok(s.length < 260, `長度 ${s.length}`);
        assert.match(s, /…」/);
    });

    test('vision_only／ocr_only 各有一句；沒有 cross_check 也回得出一句話', async () => {
        const { reasonSentence } = await load();
        assert.match(reasonSentence('extract_disagree', payload({ status: 'vision_only' })), /只有視覺模型拆出這一題/);
        assert.match(reasonSentence('extract_disagree', payload({ status: 'ocr_only' })), /只有 OCR 版拆出這一題/);
        const bare = reasonSentence('extract_disagree', {});
        assert.equal(typeof bare, 'string');
        assert.ok(bare.includes('不一致'));
        assert.ok(!bare.includes('undefined'));
        assert.ok(!reasonSentence('extract_disagree', null).includes('undefined'));
    });
});
