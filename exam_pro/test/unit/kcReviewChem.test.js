// kcReviewChem.test.js — 釘住〔重練與收尾決策單 2026-09-26〕Owner 對化學種子檔的決定（K1、K11）
//
// 對應 docs/kc-review-化學.md 第 9 節。只讀 config/kc/化學.json，不連 DB、不連 LLM。
// 之後 Owner 改變決定時，連同本檔的斷言與文件註記一起改。
// 執行：npm test
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const KC_DIR = path.resolve(__dirname, '..', '..', 'config', 'kc');
const seed = JSON.parse(fs.readFileSync(path.join(KC_DIR, '化學.json'), 'utf8'));
const byCode = new Map(seed.components.map(c => [c.code, c]));

describe('〔重練與收尾決策單 2026-09-26〕化學種子檔', () => {
    test('K1：溶解度.05 的 description 與口語版都補「難溶不等於完全不溶」，舉永久硬水與澄清石灰水', () => {
        const k = byCode.get('CHEM.溶解度.05');
        assert.equal(k.name, '沉澱反應與溶解性規則');
        for (const field of ['description', 'spoken_text']) {
            const text = k[field];
            assert.ok(text.includes('難溶不等於完全不溶'), field);
            assert.ok(text.includes('少量溶解仍會影響水質或反應'), field);
            assert.ok(text.includes('永久硬水'), field);
            assert.ok(text.includes('澄清石灰水'), field);
            assert.ok(text.includes('硫酸鈣'), field);
            assert.ok(text.includes('氫氧化鈣'), field);
        }
        // C16 仍成立：只分可溶與難溶，CaSO₄、Ca(OH)₂ 算難溶
        assert.ok(k.description.includes('微溶一律算難溶'));
        assert.ok(k.description.includes('CaSO₄ 難溶'));
        assert.ok(k.description.includes('（含 Ca(OH)₂）'));
        assert.ok(k.spoken_text.includes('氫氧化鈣也算難溶'));
        // 口語版維持字數與風格：不超過化學口語版原本的上限 200 字、2–4 句、對學生說「你」，最後一句仍是常見錯誤
        assert.ok(k.spoken_text.length <= 200, `口語版 ${k.spoken_text.length} 字`);
        const sentences = k.spoken_text.split('。').filter(Boolean);
        assert.ok(sentences.length >= 2 && sentences.length <= 4, `口語版 ${sentences.length} 句`);
        assert.ok(k.spoken_text.includes('你'));
        assert.ok(sentences[sentences.length - 1].startsWith('別把氫氧化鈉、碳酸鈉也當成難溶'));
    });

    test('K11：「醛與酮」各條都不以錯離子新條目 常見的非金屬與金屬.08 為先備', () => {
        const ch = seed.components.filter(c => c.chapter === '醛與酮');
        assert.equal(ch.length, 5);
        for (const c of ch) {
            assert.ok(!(c.prereqs || []).includes('CHEM.常見的非金屬與金屬.08'), c.code);
        }
        assert.deepEqual(byCode.get('CHEM.醛與酮.03').prereqs, ['CHEM.醛與酮.01']);
    });
});
