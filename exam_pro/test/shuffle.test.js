// shuffle 單元測試 —— 一萬次抽樣的分佈測試
//
// 為什麼特別測這支：智慧組卷的「隨機抽題」決定了題目對學生的曝光是否公平，
// 但**隨機性錯了不會噴錯、不會當機**——它只會讓某些題目長期抽不到。
// 這種靜默失效，功能測試（回 200 嗎？有 5 題嗎？）永遠測不出來，
// 只有統計檢定才釘得住：一萬次抽樣後，每個位置上每個元素的出現次數
// 必須接近理論值。
//
// 本檔的重點不是「有沒有改成 Fisher-Yates」，而是「改壞了會不會被抓到」。
// 最後一組測試刻意保留舊寫法 sort(() => 0.5 - Math.random())，
// 證明同一套檢定確實會把它判為不均勻——測試本身有沒有鑑別力，是可以被驗證的。
//
// 執行：npm test   （Node 內建測試執行器，無額外相依）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shuffle } = require('../utils/shuffle');

// ───────────────────────── 測試輔助 ─────────────────────────

const SAMPLES = 10000; // 抽樣次數

/**
 * mulberry32：32 位元種子 PRNG。
 * 分佈測試若用 Math.random，理論上有極小機率誤判而讓 CI 隨機轉紅；
 * 注入固定種子後結果完全可重現——CI 紅燈就一定是程式改壞了，不是運氣不好。
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 卡方統計量：Σ (觀察值 - 期望值)² / 期望值 */
function chiSquare(counts, expected) {
    return counts.reduce((sum, observed) => sum + ((observed - expected) ** 2) / expected, 0);
}

// 卡方分佈臨界值（顯著水準 p = 0.001，即均勻時誤判機率僅千分之一）
const CHI_CRIT_DF4 = 18.467;  // 自由度 4：5 個元素的位置分佈
const CHI_CRIT_DF23 = 49.728; // 自由度 23：4 個元素共 24 種排列

// 以 Math.random 執行時使用的寬鬆門檻（p ≈ 5e-7），確保不會偶發轉紅
const CHI_LOOSE_DF4 = 35;

// 固定種子：與專案時程無關，只是要一個不會變動的數字
const SEED = 20260801;

/** 舊寫法：常見但分佈不均勻的「隨機比較函式」排序 */
const naiveSortShuffle = (items, random = Math.random) => [...items].sort(() => 0.5 - random());

/**
 * 統計每個「位置 × 元素」的出現次數。
 * 回傳 matrix[position][value] = 次數。
 */
function positionMatrix(shuffleFn, size, samples, random) {
    const items = Array.from({ length: size }, (_, i) => i);
    const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
    for (let i = 0; i < samples; i++) {
        shuffleFn(items, random).forEach((value, position) => { matrix[position][value]++; });
    }
    return matrix;
}

/** 統計每一種完整排列出現的次數（key 為 '0123' 這樣的字串）*/
function permutationCounts(shuffleFn, size, samples, random) {
    const items = Array.from({ length: size }, (_, i) => i);
    const tally = new Map();
    for (let i = 0; i < samples; i++) {
        const key = shuffleFn(items, random).join('');
        tally.set(key, (tally.get(key) || 0) + 1);
    }
    return tally;
}

// ═════════════════════ 1. 基本契約 ═════════════════════
// 契約：shuffle 必須是純函式，且輸出永遠是輸入的一個排列。
// 抽題結果會直接寫進學生的作答歷史，少一題或多一題都會造成資料錯亂。

describe('shuffle — 基本契約', () => {
    test('不修改原陣列，回傳新陣列', () => {
        const source = [1, 2, 3, 4, 5];
        const copy = [...source];
        const result = shuffle(source);
        assert.deepEqual(source, copy, '原陣列不得被修改');
        assert.notEqual(result, source, '必須回傳新陣列而非同一個參考');
    });

    test('空陣列與單一元素不得出錯', () => {
        assert.deepEqual(shuffle([]), []);
        assert.deepEqual(shuffle([42]), [42]);
    });

    test('輸出永遠是輸入的排列（1000 次，不重複、不遺漏）', () => {
        const source = Array.from({ length: 20 }, (_, i) => i);
        for (let i = 0; i < 1000; i++) {
            const result = shuffle(source);
            assert.equal(result.length, source.length, '長度必須相同');
            assert.deepEqual([...result].sort((a, b) => a - b), source, '元素集合必須相同');
        }
    });

    test('物件陣列洗牌後保留原物件參考（抽題時要拿得回完整題目）', () => {
        const questions = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const result = shuffle(questions);
        assert.deepEqual(result.map(q => q.id).sort(), [1, 2, 3]);
        result.forEach(q => assert.ok(questions.includes(q), '必須是原物件本身'));
    });
});

// ═════════════════════ 2. 分佈均勻性（一萬次抽樣）═════════════════════
// 契約：每個元素落在每個位置的機率必須相等。
// 這是「公平抽題」的數學定義——若第 1 題總是比較容易被抽到，
// 學生的練習就會系統性偏斜，而且從畫面上完全看不出來。

describe('shuffle — 分佈均勻性（固定種子，可重現）', () => {
    test(`位置分佈：5 個元素抽 ${SAMPLES} 次，每個位置的卡方值 < ${CHI_CRIT_DF4}`, () => {
        const size = 5;
        const matrix = positionMatrix(shuffle, size, SAMPLES, mulberry32(SEED));
        const expected = SAMPLES / size; // 每格理論值 2000

        matrix.forEach((row, position) => {
            const chi = chiSquare(row, expected);
            assert.ok(
                chi < CHI_CRIT_DF4,
                `位置 ${position} 的分佈偏離均勻：卡方 ${chi.toFixed(2)} ≥ ${CHI_CRIT_DF4}（各元素次數 ${row.join(', ')}，理論值 ${expected}）`
            );
        });
    });

    test(`位置分佈：每一格的偏差都在理論值的 ±10% 以內（人眼可讀的版本）`, () => {
        const size = 5;
        const matrix = positionMatrix(shuffle, size, SAMPLES, mulberry32(SEED));
        const expected = SAMPLES / size;

        matrix.forEach((row, position) => {
            row.forEach((count, value) => {
                const deviation = Math.abs(count - expected) / expected;
                assert.ok(
                    deviation < 0.10,
                    `元素 ${value} 出現在位置 ${position} 共 ${count} 次，偏離理論值 ${expected} 達 ${(deviation * 100).toFixed(1)}%`
                );
            });
        });
    });

    test(`完整排列分佈：4 個元素的 24 種排列全部出現，且卡方值 < ${CHI_CRIT_DF23}`, () => {
        // 只看「位置邊際分佈」可能漏掉某些偏差，因此再檢查完整排列的分佈。
        const size = 4;
        const tally = permutationCounts(shuffle, size, SAMPLES, mulberry32(SEED));

        assert.equal(tally.size, 24, `24 種排列應全部出現，實際只出現 ${tally.size} 種`);

        const chi = chiSquare([...tally.values()], SAMPLES / 24);
        assert.ok(
            chi < CHI_CRIT_DF23,
            `排列分佈偏離均勻：卡方 ${chi.toFixed(2)} ≥ ${CHI_CRIT_DF23}`
        );
    });

    test(`改用真實 Math.random 仍通過寬鬆門檻（卡方 < ${CHI_LOOSE_DF4}）`, () => {
        // 防止有人把亂數來源寫死成種子，或讓預設參數失效。
        // 門檻放寬到 p ≈ 5e-7，均勻時幾乎不可能偶發轉紅。
        const size = 5;
        const matrix = positionMatrix(shuffle, size, SAMPLES, undefined);
        const expected = SAMPLES / size;

        matrix.forEach((row, position) => {
            const chi = chiSquare(row, expected);
            assert.ok(chi < CHI_LOOSE_DF4, `位置 ${position} 卡方 ${chi.toFixed(2)} 過高`);
        });
    });
});

// ═════════════════════ 3. 測試本身的鑑別力 ═════════════════════
// 一個永遠會過的測試等於沒有測試。
// 這組測試證明：上面那套檢定確實抓得出「看起來能跑、實際分佈偏斜」的舊寫法。

describe('分佈檢定的鑑別力 — 舊寫法必須被抓出來', () => {
    test('sort(() => 0.5 - random()) 的位置分佈會被卡方檢定判為不均勻', () => {
        const size = 5;
        const matrix = positionMatrix(naiveSortShuffle, size, SAMPLES, mulberry32(SEED));
        const expected = SAMPLES / size;
        const worst = Math.max(...matrix.map(row => chiSquare(row, expected)));

        // 實測約 1300~1500，是臨界值 18.467 的數十倍；門檻取 100 保留充裕餘裕
        assert.ok(
            worst > 100,
            `舊寫法應被判為不均勻，但最大卡方僅 ${worst.toFixed(2)}——` +
            `若這裡失敗，代表分佈測試已失去鑑別力，需重新檢視`
        );
    });

    test('sort(() => 0.5 - random()) 的完整排列分佈同樣被抓出來', () => {
        const size = 4;
        const tally = permutationCounts(naiveSortShuffle, size, SAMPLES, mulberry32(SEED));
        const chi = chiSquare([...tally.values()], SAMPLES / 24);

        // 實測約 11000，臨界值僅 49.728
        assert.ok(chi > 500, `舊寫法的排列分佈卡方僅 ${chi.toFixed(2)}，鑑別力不足`);
    });

    test('舊寫法的偏斜具體長什麼樣：最常見與最罕見的排列差距超過 3 倍', () => {
        // 讓「不均勻」不只是一個卡方數字——實際差距大到會影響學生看到的題目。
        const tally = permutationCounts(naiveSortShuffle, 4, SAMPLES, mulberry32(SEED));
        const counts = [...tally.values()];
        const ratio = Math.max(...counts) / Math.min(...counts);

        assert.ok(ratio > 3, `最常見/最罕見排列的比值僅 ${ratio.toFixed(2)}`);

        // 對照組：Fisher-Yates 的同一比值應該很接近 1
        const fair = permutationCounts(shuffle, 4, SAMPLES, mulberry32(SEED));
        const fairCounts = [...fair.values()];
        const fairRatio = Math.max(...fairCounts) / Math.min(...fairCounts);
        assert.ok(fairRatio < 1.5, `Fisher-Yates 的比值應接近 1，實際為 ${fairRatio.toFixed(2)}`);
    });
});
