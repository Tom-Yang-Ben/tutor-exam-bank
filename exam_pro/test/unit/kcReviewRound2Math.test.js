// kcReviewRound2Math.test.js — 釘住〔知識點審定單 2026-09-26〕第二輪 Owner 對數學的決定
//
// 對應 docs/kc-review-數學.md 第 10 節；〔重練與收尾決策單 2026-09-26〕K8–K10 對應第 10.6 節。
// 只讀 config/kc/數學.json、code-maps 與 config/chapterAliases.js，
// 不連 DB、不連 LLM。之後 Owner 改變決定時，連同本檔的斷言與註記一起改。
// 執行：npm test
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const aliases = require('../../config/chapterAliases');

const KC_DIR = path.resolve(__dirname, '..', '..', 'config', 'kc');
const seed = JSON.parse(fs.readFileSync(path.join(KC_DIR, '數學.json'), 'utf8'));
const byCode = new Map(seed.components.map(c => [c.code, c]));
const mapR2 = JSON.parse(fs.readFileSync(path.join(KC_DIR, 'code-maps', 'code-map-數學-2026-09-26.json'), 'utf8'));
const allPrereqs = () => seed.components.flatMap(c => c.prereqs || []);

describe('〔知識點審定單 2026-09-26〕數學種子檔', () => {
    test('M3：勘根定理搬到「函數的極限」.07，以中間值定理為先備；中間值定理不再以勘根定理為先備', () => {
        assert.equal(byCode.has('MATH.多項式函數的圖形.06'), false);
        const k = byCode.get('MATH.函數的極限.07');
        assert.equal(k.name, '勘根定理');
        assert.equal(k.chapter, '函數的極限');
        assert.deepEqual(k.prereqs, ['MATH.函數的極限.06']);
        assert.ok(!byCode.get('MATH.函數的極限.06').prereqs.includes('MATH.函數的極限.07'));
        assert.equal(seed.components.filter(c => c.chapter === '多項式函數的圖形').length, 5);
    });

    test('M3 後續（Owner 補答）：勘根定理改寫成連續函數版本；中間值定理只寫一般敘述，勘根定理是它的特例', () => {
        const root = byCode.get('MATH.函數的極限.07');
        assert.ok(root.description.includes('連續'));
        assert.ok(root.description.includes('f(a)f(b)<0'));
        assert.ok(root.description.includes('二分法'));
        assert.ok(!root.description.includes('多項式'));
        assert.ok(root.spoken_text.includes('連續'));
        assert.ok(root.spoken_text.includes('二分法'));
        const ivt = byCode.get('MATH.函數的極限.06');
        assert.ok(!ivt.description.includes('f(a)f(b)<0'));
        assert.ok(ivt.description.includes('勘根定理是它的特例'));
        assert.ok(!ivt.spoken_text.includes('推廣'));
    });

    test('M15（Owner 補答）：「複數的幾何意涵」拆成 3 條，刪極式、棣美弗定理、n 次方根', () => {
        const ch = seed.components.filter(c => c.chapter === '複數的幾何意涵');
        assert.deepEqual(ch.map(c => [c.code, c.sort, c.name]), [
            ['MATH.複數的幾何意涵.01', 1, '複數平面與絕對值'],
            ['MATH.複數的幾何意涵.06', 2, '複數加減的幾何意義'],
            ['MATH.複數的幾何意涵.03', 3, '複數乘除的幾何意義']
        ]);
        for (const gone of ['MATH.複數的幾何意涵.02', 'MATH.複數的幾何意涵.04', 'MATH.複數的幾何意涵.05']) {
            assert.equal(byCode.has(gone), false, gone);
            assert.ok(!allPrereqs().includes(gone), gone);
        }
        for (const c of ch) {
            assert.ok(!/極式|棣美弗|次方根|cosθ\+i sinθ/.test(c.description + c.spoken_text), c.code);
        }
        assert.ok(byCode.get('MATH.複數的幾何意涵.06').description.includes('實軸的鏡射'));
        assert.ok(byCode.get('MATH.複數的幾何意涵.03').description.includes('逆時針旋轉 90°'));
    });

    test('M17（Owner 補答）：刪橢圓焦點三角形面積公式與配方後的退化情形，代碼不變', () => {
        const e4 = byCode.get('MATH.橢圓.04');
        assert.ok(!/tan\(θ\/2\)/.test(e4.description + e4.spoken_text));
        assert.ok(e4.description.includes('餘弦定理'));
        for (const code of ['MATH.橢圓.03', 'MATH.雙曲線.04']) {
            const c = byCode.get(code);
            assert.ok(!/只是一點|一個點|沒有圖形|相交直線/.test(c.description + c.spoken_text), code);
        }
    });

    test('M4：「集合與計數原理」新增命題與且或非、充分條件與必要條件', () => {
        const names = seed.components.filter(c => c.chapter === '集合與計數原理').map(c => c.name);
        assert.ok(names.includes('命題與且、或、非'));
        assert.ok(names.includes('充分條件與必要條件'));
    });

    test('M5：空間向量的坐標運算搬到「空間概念與座標系」.06，先備全部跟著改', () => {
        assert.equal(byCode.has('MATH.空間向量內積.01'), false);
        assert.equal(byCode.get('MATH.空間概念與座標系.06').name, '空間向量的坐標運算');
        assert.ok(!allPrereqs().includes('MATH.空間向量內積.01'));
    });

    test('M8：變異數與標準差只寫除以 n', () => {
        const v = byCode.get('MATH.一維數據分析.04');
        assert.ok(!/n−1|n-1/.test(v.description + v.spoken_text));
    });

    test('M10：刪除「二項分布中機率最大的次數」；幾何分布不寫 E(X)=1/p', () => {
        assert.equal(byCode.has('MATH.二項分布與幾何分布.04'), false);
        assert.ok(!allPrereqs().includes('MATH.二項分布與幾何分布.04'));
        assert.ok(!byCode.get('MATH.二項分布與幾何分布.05').description.includes('E(X)'));
    });

    test('M19：簡單三角方程式與疊合方程式寫到一般解', () => {
        for (const code of ['MATH.三角函數的圖形.03', 'MATH.三角函數的疊合.03']) {
            const c = byCode.get(code);
            assert.ok(c.description.includes('k 為整數'), code);
            assert.ok(c.spoken_text.includes('k 是整數'), code);
        }
    });

    test('M21：平面方程式.06 留在原章，先備改指係數積，不再指向後面的空間直線方程式', () => {
        const p = byCode.get('MATH.平面方程式.06').prereqs;
        assert.ok(p.includes('MATH.向量的加減與係數積.03'));
        assert.ok(!p.some(x => x.startsWith('MATH.空間直線方程式.')));
    });

    test('對照檔 code-map-數學-2026-09-26：值都在種子檔，刪除 4 筆，新增的 3 條不在鍵裡', () => {
        for (const [from, to] of Object.entries(mapR2)) {
            if (to === null) continue;
            assert.ok(byCode.has(to), `${from} → ${to} 不在種子檔`);
        }
        assert.deepEqual(Object.entries(mapR2).filter(([, v]) => v === null).map(([k]) => k), [
            'MATH.二項分布與幾何分布.04',
            'MATH.複數的幾何意涵.02', 'MATH.複數的幾何意涵.04', 'MATH.複數的幾何意涵.05'
        ]);
        assert.equal(mapR2['MATH.多項式函數的圖形.06'], 'MATH.函數的極限.07');
        assert.equal(mapR2['MATH.空間向量內積.01'], 'MATH.空間概念與座標系.06');
        assert.equal(mapR2['MATH.複數的幾何意涵.01'], 'MATH.複數的幾何意涵.01');
        assert.equal(mapR2['MATH.複數的幾何意涵.03'], 'MATH.複數的幾何意涵.03');
        const targets = new Set(Object.values(mapR2));
        const unmapped = seed.components.map(c => c.code).filter(c => !targets.has(c));
        assert.deepEqual(unmapped.sort(), ['MATH.集合與計數原理.06', 'MATH.集合與計數原理.07', 'MATH.複數的幾何意涵.06'].sort());
    });
});

describe('〔重練與收尾決策單 2026-09-26〕數學種子檔', () => {
    test('K8：邏輯 2 條維持在集合運算之後、計數原理之前', () => {
        const ch = seed.components.filter(c => c.chapter === '集合與計數原理');
        assert.deepEqual(ch.map(c => [c.code, c.sort]), [
            ['MATH.集合與計數原理.01', 1],
            ['MATH.集合與計數原理.02', 2],
            ['MATH.集合與計數原理.06', 3],
            ['MATH.集合與計數原理.07', 4],
            ['MATH.集合與計數原理.03', 5],
            ['MATH.集合與計數原理.04', 6],
            ['MATH.集合與計數原理.05', 7]
        ]);
    });

    test('K9：幾何分布的口語版也不講期望值，改用「第 3 次才出現 6」當例子', () => {
        const g = byCode.get('MATH.二項分布與幾何分布.05');
        assert.ok(!/期望值|p 分之 1|平均要擲/.test(g.spoken_text));
        assert.ok(g.spoken_text.includes('第 3 次才出現'));
    });

    test('K10：複數乘除的幾何意義拿掉「和角與差角公式」這個先備，其他先備保留', () => {
        assert.deepEqual(byCode.get('MATH.複數的幾何意涵.03').prereqs, [
            'MATH.複數的幾何意涵.01',
            'MATH.廣義角與極坐標.04'
        ]);
    });
});

describe('〔知識點審定單 2026-09-26〕查題別名', () => {
    test('M3：「勘根定理」改指「函數的極限」', () => {
        assert.equal(aliases.CHAPTER_ALIASES['勘根定理'], '函數的極限');
        assert.ok(!aliases.ALIASES_BY_CHAPTER['多項式函數的圖形'].includes('勘根定理'));
    });

    test('M4：邏輯相關別名指向「集合與計數原理」', () => {
        for (const a of ['邏輯', '命題', '充分條件', '必要條件', '充分必要條件']) {
            assert.equal(aliases.CHAPTER_ALIASES[a], '集合與計數原理', a);
        }
    });
});
