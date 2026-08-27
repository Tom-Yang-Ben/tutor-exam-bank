// services/figureService.js 的單元測試（docs/figures.md）
//
// 只測純函式 boxToPixels：0–1000 正規化框 → 像素矩形的換算、邊距與夾邊。
// cropFigures 走 mupdf WASM 與 sharp，屬整合行為，由實卷跑管線時以複核畫面驗證。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { boxToPixels, MARGIN_RATIO } = require('../../services/figureService');

describe('figureService — boxToPixels', () => {
    test('整頁框（0,0,1000,1000）→ 蓋滿整張圖，邊距被夾在頁面內', () => {
        const r = boxToPixels([0, 0, 1000, 1000], 800, 1200);
        assert.deepEqual(r, { left: 0, top: 0, width: 800, height: 1200 });
    });

    test('框中央、邊距外擴：邊界值 = (座標 ± 框寬高×邊距)/1000 × 圖寬高', () => {
        // 框 [250, 250, 750, 750]，寬高各 500，邊距 500×0.025=12.5
        const r = boxToPixels([250, 250, 750, 750], 1000, 1000, 0.025);
        assert.deepEqual(r, { left: 237, top: 237, width: 526, height: 526 });
    });

    test('框貼著頁緣時外擴不出界（left/top 不為負、right/bottom 不超過圖寬高）', () => {
        const r = boxToPixels([0, 0, 100, 100], 1000, 1000);
        assert.equal(r.left, 0);
        assert.equal(r.top, 0);
        const r2 = boxToPixels([900, 900, 1000, 1000], 1000, 1000);
        assert.equal(r2.left + r2.width, 1000);
        assert.equal(r2.top + r2.height, 1000);
    });

    test('退化框（寬或高不足 1px）回 null，呼叫端略過該圖', () => {
        assert.equal(boxToPixels([500, 500, 500, 500], 10, 10, 0), null);
    });

    test('預設邊距是 2.5%（與 docs/figures.md 一致）', () => {
        assert.equal(MARGIN_RATIO, 0.025);
    });
});
