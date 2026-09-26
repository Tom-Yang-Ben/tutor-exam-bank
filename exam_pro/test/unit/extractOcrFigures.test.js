// agents/extractOcrFigures.js 的單元測試（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// LOCAL_EXTRACT_MODE=ocr 時沒有視覺模型回框，附圖改由 PaddleOCR 的版面偵測（ocr_pdf.py 回報的 figures）配到題目：
// 同頁、在題目範圍內（題號行或題幹起點 → 下一題的題號行或題幹起點）只有一張圖才配；配不準的寧可不配、只留提示。
// 純函式，不需要 Python、PDF 或模型。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const figs = require('../../agents/extractOcrFigures');

const Q1 = '設函數 $f(x)=x^2$，請問當自變數等於二的時候函數值為多少呢？(A) $1$ (B) $2$ (C) $4$ (D) $8$';
const Q2 = '如圖，一個質量為 $2$ 公斤的木塊放在光滑水平面上，受水平力拉動，求加速度的大小。';
const Q3 = '甲乙兩人同時從同一地點出發沿直線跑步，速率分別為每秒三公尺與四公尺，求十秒後兩人相距的距離。';
const Q4 = '如右圖所示，一個電路中有兩個電阻串聯接在電池兩端，已知電池電壓，求電路的總電阻。';
const Q5 = '下列關於等速圓周運動的敘述哪些正確？請選出所有正確的選項。(A) 速率不變 (B) 速度不變';

const BOX = (n) => [100 + n, 100, 300 + n, 500];

function page3(figures) {
    return {
        page: 3,
        markdown: [
            '# 第一次段考 高一數學與物理',
            '[圖]',
            '## 1. (數學·單選)',
            '設函數$f(x)=x^2$，請問當自變數等於二的時候函數值為多少呢?',
            '(A) 1 (B) 2 (C) 4 (D) 8',
            '## 2. (物理·計算)',
            '如圖，一個質量為2公斤的木塊放在光滑水平面上，受水平力拉動，求加速度的大小。',
            '[圖]',
            '## 3. (物理·計算)',
            '甲乙兩人同時從同一地點出發沿直線跑步，速率分別為每秒三公尺與四公尺，求十秒後兩人相距的距離。'
        ].join('\n\n'),
        ...(figures === undefined ? {} : { figures })
    };
}

function page4(figures) {
    return {
        page: 4,
        markdown: [
            '[圖]',
            '## 4. (物理·計算)',
            '如右圖所示，一個電路中有兩個電阻串聯接在電池兩端，已知電池電壓，求電路的總電阻。',
            '[圖]',
            '[圖]',
            '## 5. (物理·多選)',
            '下列關於等速圓周運動的敘述哪些正確？請選出所有正確的選項。(A)速率不變(B)速度不變'
        ].join('\n\n'),
        ...(figures === undefined ? {} : { figures })
    };
}

const FULL_P3 = [{ label: 'image', box: BOX(0) }, { label: 'image', box: BOX(10) }];
const FULL_P4 = [{ label: 'image', box: BOX(20) }, { label: 'chart', box: BOX(30) }, { label: 'image', box: BOX(40) }];
const QS = [Q1, Q2, Q3, Q4, Q5].map(question_text => ({ question_text }));

describe('extractOcrFigures — 依 OCR 版面把附圖配到題目', () => {
    test('同頁、題目範圍內只有一張圖 → 配；題首之前的圖（校徽、標題圖）不配也不提示', () => {
        const r = figs.matchOcrFigures(QS, [page3(FULL_P3), page4(FULL_P4)]);
        assert.deepEqual(r.results[0], {}, '第 1 題：範圍內沒有圖、題幹也沒提到圖');
        assert.deepEqual(r.results[1], { figure_page: 3, figure_box: BOX(10) }, '第 2 題：第 3 頁、緊接在題幹之後的那一張');
    });

    test('跨頁（圖在下一頁頁首、題目從上一頁開始）→ 不配，標「附近有圖」', () => {
        const r = figs.matchOcrFigures(QS, [page3(FULL_P3), page4(FULL_P4)]);
        assert.equal(r.results[2].figure_box, undefined);
        assert.deepEqual(r.results[2].figure_hint, { reason: 'nearby', count: 1 });
    });

    test('同一題範圍內有兩張以上 → 不配（寧可不配），標張數', () => {
        const r = figs.matchOcrFigures(QS, [page3(FULL_P3), page4(FULL_P4)]);
        assert.equal(r.results[3].figure_box, undefined);
        assert.deepEqual(r.results[3].figure_hint, { reason: 'multiple', count: 2 });
        assert.deepEqual(r.results[4], {});
    });

    test('摘要：版面齊全、偵測到的圖 5 張（印章以外都算，校徽也算）、配到 1 張、2 題有提示', () => {
        const r = figs.matchOcrFigures(QS, [page3(FULL_P3), page4(FULL_P4)]);
        assert.deepEqual(r.summary, { layout: 'ok', detected: 5, assigned: 1, hinted: 2 });
    });

    test('OCR 沒回報版面（舊 cassette、舊版 ocr_pdf.py）→ 一張都不配；題幹提到「如圖／如右圖」的標提示', () => {
        const r = figs.matchOcrFigures(QS, [page3(), page4()]);
        assert.deepEqual(r.results.map(x => x.figure_box), [undefined, undefined, undefined, undefined, undefined]);
        assert.deepEqual(r.results.map(x => x.figure_hint || null), [
            null, { reason: 'mentions' }, null, { reason: 'mentions' }, null
        ]);
        assert.equal(r.summary.layout, 'none');
        assert.equal(r.summary.assigned, 0);
    });

    test('某一頁的圖數與「[圖]」數對不上 → 那一頁整頁不配（只剩題幹提示）；另一頁照常', () => {
        const r = figs.matchOcrFigures(QS, [page3([{ label: 'image', box: BOX(10) }]), page4(FULL_P4)]);
        assert.equal(r.results[1].figure_box, undefined);
        assert.deepEqual(r.results[1].figure_hint, { reason: 'mentions' });
        assert.deepEqual(r.results[2].figure_hint, { reason: 'nearby', count: 1 });
        assert.equal(r.summary.layout, 'mismatch');
    });

    test('印章（seal）不配也不提示；框壞掉（null）的圖不配、標「附近有圖」', () => {
        const r = figs.matchOcrFigures(QS, [page3([{ label: 'image', box: BOX(0) }, { label: 'seal', box: BOX(10) }]), page4()]);
        assert.deepEqual(r.results[1], { figure_hint: { reason: 'mentions' } }, '印章不是附圖；題幹提到圖所以仍有提示');
        const bad = figs.matchOcrFigures(QS, [page3([{ label: 'image', box: BOX(0) }, { label: 'image', box: null }]), page4()]);
        assert.deepEqual(bad.results[1], { figure_hint: { reason: 'nearby', count: 1 } });
    });

    test('中間有一題定位不到 → 夾在兩題之間的圖不知道屬於誰：不配，兩題都標提示', () => {
        const lost = [Q1, Q2, '這一題的題幹與原卷完全不同所以定位不到任何位置的題目文字內容', Q4, Q5].map(question_text => ({ question_text }));
        const md = page3(FULL_P3);
        const r = figs.matchOcrFigures(lost, [md, page4()]);
        assert.equal(r.results[1].figure_box, undefined, '第 2 題與第 3 題（定位不到）之間的圖不配');
        assert.deepEqual(r.results[1].figure_hint, { reason: 'nearby', count: 1 });
        assert.deepEqual(r.results[2].figure_hint, { reason: 'nearby', count: 1 });
    });

    test('圖落在題號行與題幹之間 → 屬於那一題（範圍從題號行起算）', () => {
        const md = {
            page: 1,
            markdown: ['## 1. (物理·計算)', '[圖]', Q3.replace(/\$/g, ''), '## 2. (物理·計算)', Q4].join('\n\n'),
            figures: [{ label: 'image', box: BOX(5) }]
        };
        const r = figs.matchOcrFigures([{ question_text: Q3 }, { question_text: Q4 }], [md]);
        assert.deepEqual(r.results[0], { figure_page: 1, figure_box: BOX(5) });
        assert.deepEqual(r.results[1], { figure_hint: { reason: 'mentions' } });
    });

    test('前一題沒提到圖、下一題提到圖，圖在兩題之間 → 說不準屬於誰：不配；提到圖的那一題標提示', () => {
        const md = {
            page: 1,
            markdown: [Q3, '[圖]', Q4].join('\n\n'),
            figures: [{ label: 'image', box: BOX(5) }]
        };
        const r = figs.matchOcrFigures([{ question_text: Q3 }, { question_text: Q4 }], [md]);
        assert.deepEqual(r.results[0], {});
        assert.deepEqual(r.results[1], { figure_hint: { reason: 'mentions' } });
    });

    test('提到圖的題、圖在題幹之後 → 照配（「緊接其後」）', () => {
        const md = { page: 2, markdown: [Q4, '[圖]', Q5].join('\n\n'), figures: [{ label: 'chart', box: BOX(7) }] };
        const r = figs.matchOcrFigures([{ question_text: Q4 }, { question_text: Q5 }], [md]);
        assert.deepEqual(r.results[0], { figure_page: 2, figure_box: BOX(7) });
        assert.deepEqual(r.results[1], {});
    });

    test('全形與相容字（NFKC）不影響定位；題號行認得「1 ．」這種 OCR 的寫法', () => {
        // U+FF0E（全形句點）與 U+F9EA（相容漢字「離」）：NFKC 之後才對得上題幹
        const md = { page: 1, markdown: ['## 1 ． (數學·單選)', '[圖]', Q3.replace('離', '離')].join('\n\n'), figures: [{ label: 'image', box: BOX(1) }] };
        const r = figs.matchOcrFigures([{ question_text: Q3 }], [md]);
        assert.deepEqual(r.results[0], { figure_page: 1, figure_box: BOX(1) });
    });

    test('mentionsFigure：如圖／附圖／下圖／右圖／圖中，以及沒清掉的「[圖]」', () => {
        for (const s of ['如圖所示', '附圖為', '下圖中', '如右圖', '圖中的', '見下方[圖]']) assert.equal(figs.mentionsFigure(s), true, s);
        for (const s of ['函數的圖形', '試求 $x$', '', null]) assert.equal(figs.mentionsFigure(s), false, String(s));
    });

    test('沒有題目、沒有頁：不丟錯', () => {
        assert.deepEqual(figs.matchOcrFigures([], []).results, []);
        assert.deepEqual(figs.matchOcrFigures([{ question_text: Q2 }], []).results, [{ figure_hint: { reason: 'mentions' } }]);
        assert.deepEqual(figs.matchOcrFigures(null, null).results, []);
    });

    test('輸入不被改動（純函式）', () => {
        const pages = [page3(FULL_P3), page4(FULL_P4)];
        const before = JSON.stringify(pages);
        const qs = QS.map(q => ({ ...q }));
        figs.matchOcrFigures(qs, pages);
        assert.equal(JSON.stringify(pages), before);
        assert.deepEqual(qs, QS);
    });
});
