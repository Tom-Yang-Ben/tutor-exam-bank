// public/js/review.js 的 ocr_only 標籤與說明句（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// LOCAL_EXTRACT_MODE=ocr 時每一題都停在人工複核，原因與「兩版不一致」分開：
//   標籤「只用 OCR 拆題」、說明句「只用 OCR 拆題，請核對題目與公式。」；
//   附圖是依版面位置自動配的 → 提醒確認裁切；配不到（figure_hint）→「疑似有圖未配到，可用 figures:backfill 補」。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js'), 'utf8');

let cached = null;
function load() {
    if (!cached) cached = import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE));
    return cached;
}

const OCR_CC = { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' };
const payload = (extra = {}) => ({ extract: { question_text: '題幹', cross_check: OCR_CC, extract_mode: 'ocr', ...extra } });

describe('review.js — ocr_only', () => {
    test('標籤與顏色（下拉選單也從這張表產生）', () => {
        assert.match(SOURCE, /ocr_only: '只用 OCR 拆題'/);
        assert.match(SOURCE, /ocr_only: 'amber'/);
    });

    test('說明句：只用 OCR 拆題，請核對題目與公式', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('ocr_only', payload());
        assert.match(s, /^只用 OCR 拆題，請核對題目與公式。/);
        assert.ok(!/figures:backfill/.test(s), '沒有提示時不提補圖');
        assert.ok(!/交叉驗證/.test(s), '與 extract_disagree 的句子分開');
    });

    test('配不到的附圖：加「疑似有圖未配到，可用 figures:backfill 補」，並說明依據', async () => {
        const { reasonSentence } = await load();
        const m = reasonSentence('ocr_only', payload({ figure_hint: { reason: 'mentions' } }));
        assert.match(m, /疑似有圖未配到，可用 figures:backfill 補/);
        assert.match(m, /題幹提到圖/);
        const n = reasonSentence('ocr_only', payload({ figure_hint: { reason: 'nearby', count: 1 } }));
        assert.match(n, /疑似有圖未配到，可用 figures:backfill 補/);
        assert.match(n, /附近/);
        const k = reasonSentence('ocr_only', payload({ figure_hint: { reason: 'multiple', count: 3 } }));
        assert.match(k, /3 張/);
    });

    test('自動配到的附圖：提醒確認裁切的是不是這一題的圖', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('ocr_only', payload({ figure_page: 3, figure_box: [1, 2, 3, 4], figure_img: '/figures/9-2001.png' }));
        assert.match(s, /版面位置/);
        assert.ok(!/figures:backfill/.test(s));
    });

    test('figureHintNote：其他原因的卡片也看得到補圖提示；沒有提示回空字串', async () => {
        const { figureHintNote } = await load();
        assert.match(figureHintNote(payload({ figure_hint: { reason: 'mentions' } })), /疑似有圖未配到，可用 figures:backfill 補/);
        assert.equal(figureHintNote(payload()), '');
        assert.equal(figureHintNote({}), '');
        assert.equal(figureHintNote(null), '');
    });

    test('payload 缺東西也回得出一句話（不會顯示 undefined）', async () => {
        const { reasonSentence } = await load();
        for (const p of [{}, null, { extract: {} }, { extract: { figure_hint: 'x' } }]) {
            const s = reasonSentence('ocr_only', p);
            assert.match(s, /只用 OCR 拆題/);
            assert.ok(!s.includes('undefined'));
        }
    });

    test('extract_disagree 的句子不受影響（交叉驗證模式的 ocr_only 狀態仍是那一句）', async () => {
        const { reasonSentence } = await load();
        assert.match(reasonSentence('extract_disagree', { extract: { cross_check: OCR_CC } }), /只有 OCR 版拆出這一題，視覺模型沒有對應的題/);
    });
});
