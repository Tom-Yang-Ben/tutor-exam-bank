// kcReviewChem.test.js — 釘住〔重練與收尾決策單 2026-09-26〕Owner 對化學種子檔的決定（K1、K11）
// 與〔Owner 決策單 2026-09-26 第四輪〕Q3（溶解度.05 的「鹼金屬與 Ba 的除外」）
//
// 對應 docs/kc-review-化學.md 第 9 節、第 10 節。只讀 config/kc/化學.json，不連 DB、不連 LLM。
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

    test('〔Owner 決策單 2026-09-26 第四輪 Q3〕溶解度.05 的 description 改成「鹼金屬與 Ba 的除外」，其餘一字不改；口語版不動', () => {
        const k = byCode.get('CHEM.溶解度.05');
        // 整段逐字釘住：只有「，但鹼金屬與 Ba 的可溶。」→「，鹼金屬與 Ba 的除外。」這一處與 K1 之後的版本不同
        assert.equal(k.description,
            '常見離子化合物只分可溶與難溶（微溶一律算難溶）：硝酸鹽、鹼金屬鹽與銨鹽皆可溶；' +
            '氯化物、硫酸鹽多可溶，但 AgCl、PbCl₂、BaSO₄、PbSO₄、CaSO₄ 難溶；碳酸鹽與磷酸鹽多難溶；' +
            '氫氧化物多難溶（含 Ca(OH)₂），鹼金屬與 Ba 的除外。兩溶液混合，陰陽離子交叉配對成難溶物即沉澱。' +
            '難溶不等於完全不溶，少量溶解仍會影響水質或反應（如硫酸鈣造成永久硬水、澄清石灰水即氫氧化鈣水溶液）。');
        assert.ok(!k.description.includes('但鹼金屬與 Ba 的可溶'));
        assert.ok([...k.description].length <= 200, `description ${[...k.description].length} 字`);
        // 口語版維持 K1 之後的版本（逐字）
        assert.equal(k.spoken_text,
            '要判斷兩個溶液混合會不會沉澱，你得記住溶解性規則，只分可溶和難溶：硝酸鹽、鹼金屬鹽和銨鹽都可溶；' +
            '氯化物、硫酸鹽大多可溶，但氯化銀、硫酸鋇、硫酸鈣難溶；碳酸鹽和氫氧化物大多難溶，氫氧化鈣也算難溶，但氫氧化鋇可溶。' +
            '陰陽離子交叉配對，有一組難溶就會沉澱。難溶不等於完全不溶，少量溶解仍會影響水質或反應：' +
            '硫酸鈣造成永久硬水，澄清石灰水就是氫氧化鈣的水溶液。別把氫氧化鈉、碳酸鈉也當成難溶，鹼金屬化合物都可溶。');
        // 其他欄位不動
        assert.equal(k.name, '沉澱反應與溶解性規則');
        assert.equal(k.sort, 5);
        assert.equal(k.status, 'draft');
        assert.deepEqual(k.prereqs, ['CHEM.化學式與化學反應式.05']);
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
