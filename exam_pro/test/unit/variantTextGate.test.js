// utils/variantTextGate.js 的單元測試（WS-B / P-11a）
//
// 純函式：不連 DB、不連 Gemini、不讀 process.env。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { textGate, levenshtein, editRatio, maskNumbers } = require('../../utils/variantTextGate');

describe('levenshtein／editRatio', () => {
    test('相同字串距離 0、比例 0', () => {
        assert.equal(levenshtein('abc', 'abc'), 0);
        assert.equal(editRatio('abc', 'abc'), 0);
    });

    test('空字串的距離就是另一邊的長度', () => {
        assert.equal(levenshtein('', 'abcd'), 4);
        assert.equal(levenshtein('abcd', ''), 4);
    });

    test('兩邊都空 → 比例 0（不得 NaN，除以 0 是這支最容易漏的坑）', () => {
        assert.equal(editRatio('', ''), 0);
        assert.ok(Number.isFinite(editRatio('', '')));
    });

    test('經典案例：kitten → sitting 距離 3', () => {
        assert.equal(levenshtein('kitten', 'sitting'), 3);
    });

    test('比例的分母是較長的那一邊', () => {
        // 'abc' → 'abcdef'：插入 3 個字元，分母 6
        assert.equal(editRatio('abc', 'abcdef'), 0.5);
    });
});

describe('maskNumbers', () => {
    test('一段連續數字換成一個 #（不是一位一個）', () => {
        assert.equal(maskNumbers('12x34'), '#x#');
        assert.equal(maskNumbers('a1b22c333'), 'a#b#c#');
    });

    test('位數不同的數字遮罩後相同——裁決 S3-R8 靠的就是這一點', () => {
        assert.equal(maskNumbers('速率 3 公尺'), maskNumbers('速率 120 公尺'));
    });

    test('沒有數字時原樣回傳', () => {
        assert.equal(maskNumbers('求證兩向量垂直'), '求證兩向量垂直');
    });

    test('小數與負號不是數字的一部分（兩邊規則一致即可比較）', () => {
        assert.equal(maskNumbers('3.5'), '#.#');
        assert.equal(maskNumbers('-7'), '-#');
    });
});

describe('textGate 的四條規則（第 4.3 條，順序凍結）', () => {
    test('① 正規化後完全相同 → identical，edit_ratio 恆為 0', () => {
        const r = textGate({
            source_text: '設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。',
            variant_text: '設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。'
        });
        assert.deepEqual(r, { ok: false, reason: 'identical', edit_ratio: 0 });
    });

    test('① 只差空白與 $ 也算相同（normalizeStem 會把它們吃掉）', () => {
        const r = textGate({
            source_text: '設 $x$ = $1$，求 $x^2$。',
            variant_text: '設 x=1，求 x^2。'
        });
        assert.equal(r.reason, 'identical');
    });

    test('② 數字對調 → numbers_only', () => {
        const r = textGate({
            source_text: '設 $\\vec{a}=(3,4)$，求 $|\\vec{a}|$。',
            variant_text: '設 $\\vec{a}=(4,3)$，求 $|\\vec{a}|$。'
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'numbers_only');
        assert.ok(r.edit_ratio > 0, '數字對調的編輯距離不是 0');
    });

    test('② 換成別的數字 → 也是 numbers_only（裁決 S3-R8 拿掉了「多重集合相同」的 AND）', () => {
        const r = textGate({
            source_text: '設 $\\vec{a}=(3,4)$，求 $|\\vec{a}|$。',
            variant_text: '設 $\\vec{a}=(6,8)$，求 $|\\vec{a}|$。'
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'numbers_only');
    });

    test('② 位數也變了照樣抓得到（舊規則會漏，這是 S3-R8 的主因）', () => {
        const r = textGate({
            source_text: '一物體以 $3$ 公尺每秒等速前進 $7$ 秒，求位移為多少公尺？',
            variant_text: '一物體以 $120$ 公尺每秒等速前進 $45$ 秒，求位移為多少公尺？'
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'numbers_only');
        assert.ok(r.edit_ratio > 0.08, `這一題的 edit_ratio 是 ${r.edit_ratio}，規則 3 擋不住它`);
    });

    test('③ 改得太少 → too_close', () => {
        const source = '一物體質量 $2$ 公斤，受 $10$ 牛頓的力，求其加速度為多少 $m/s^2$？';
        const r = textGate({ source_text: source, variant_text: source.replace('求其加速度', '求它的加速度') });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'too_close');
    });

    test('④ 換了情境與數字 → 過關', () => {
        const r = textGate({
            source_text: '一物體質量 $2$ 公斤，受 $10$ 牛頓的水平力，求其加速度。',
            variant_text: '一台質量 $1200$ 公斤的汽車，引擎提供 $3600$ 牛頓的推力，若不計阻力，求汽車的加速度。'
        });
        assert.equal(r.ok, true);
        assert.equal(r.reason, null);
        assert.ok(r.edit_ratio >= 0.08);
    });

    test('minEdit 由呼叫端傳入，門檻拉高會擋下更多（本檔不讀 process.env）', () => {
        const opts = {
            source_text: '求 $\\log_{2} 8 + \\log_{2} 4$ 之值。',
            variant_text: '試求 $\\log_{3} 9 + \\log_{3} 27$ 的值為何？'
        };
        const loose = textGate({ ...opts, minEdit: 0.05 });
        const strict = textGate({ ...opts, minEdit: 0.99 });
        assert.equal(loose.ok, true);
        assert.equal(strict.ok, false);
        assert.equal(strict.reason, 'too_close');
        assert.equal(loose.edit_ratio, strict.edit_ratio, 'edit_ratio 與門檻無關，只跟兩段文字有關');
    });

    test('minEdit 沒給時預設 0.08', () => {
        // 編輯距離比例落在 0 與 0.08 之間的字串：預設門檻要擋、把門檻降到 0.001 就放行
        const source = '甲乙兩人同時由 $A$ 點出發，甲的速率為 $3$ 公尺每秒，乙的速率為 $5$ 公尺每秒，求兩人相距 $40$ 公尺所需的時間。';
        const variant = source.replace('所需的時間', '所花的時間');
        const dflt = textGate({ source_text: source, variant_text: variant });
        const loose = textGate({ source_text: source, variant_text: variant, minEdit: 0.001 });
        assert.ok(dflt.edit_ratio > 0 && dflt.edit_ratio < 0.08, `這個案例的 edit_ratio 應落在 0~0.08，實際 ${dflt.edit_ratio}`);
        assert.equal(dflt.reason, 'too_close');
        assert.equal(loose.ok, true);
    });

    test('缺參數不丟例外（normalizeStem 對非字串回空字串）', () => {
        assert.equal(textGate({}).reason, 'identical');
        assert.equal(textGate({ source_text: null, variant_text: undefined }).reason, 'identical');
        assert.equal(textGate({ source_text: '', variant_text: '有內容的題幹' }).ok, true);
    });

    test('回傳形狀固定為三個鍵', () => {
        const r = textGate({ source_text: 'a', variant_text: 'bcdefg' });
        assert.deepEqual(Object.keys(r).sort(), ['edit_ratio', 'ok', 'reason']);
        assert.equal(typeof r.edit_ratio, 'number');
    });
});
