// kcReviewRound2Math.test.js — 釘住〔知識點審定單 2026-09-26〕第二輪 Owner 對數學的決定
//
// 對應 docs/kc-review-數學.md 第 10 節。只讀 config/kc/數學.json、code-maps 與 config/chapterAliases.js，
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

    test('對照檔 code-map-數學-2026-09-26：值都在種子檔，刪除只有一筆，新增的兩條不在鍵裡', () => {
        for (const [from, to] of Object.entries(mapR2)) {
            if (to === null) continue;
            assert.ok(byCode.has(to), `${from} → ${to} 不在種子檔`);
        }
        assert.deepEqual(Object.entries(mapR2).filter(([, v]) => v === null).map(([k]) => k), ['MATH.二項分布與幾何分布.04']);
        assert.equal(mapR2['MATH.多項式函數的圖形.06'], 'MATH.函數的極限.07');
        assert.equal(mapR2['MATH.空間向量內積.01'], 'MATH.空間概念與座標系.06');
        const targets = new Set(Object.values(mapR2));
        const unmapped = seed.components.map(c => c.code).filter(c => !targets.has(c));
        assert.deepEqual(unmapped.sort(), ['MATH.集合與計數原理.06', 'MATH.集合與計數原理.07']);
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
