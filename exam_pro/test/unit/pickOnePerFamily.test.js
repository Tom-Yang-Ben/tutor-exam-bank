// ─────────────────────────────────────────────────────────────
// pickOnePerFamily 單元測試 —— 契約 + 輕量分佈測試
//
// 這支的處境和 shuffle.test.js 完全一樣：家族互斥選錯了不會噴錯、不會當機，
// 只會讓某些變式長期抽不到，或讓同一張卷出現兩題同概念。功能測試
// （回 200 嗎？有 5 題嗎？）永遠測不出來。
//
// 但規模刻意比 shuffle.test.js 輕量（第 2.1 條說「比照但輕量」）：
// Fisher-Yates 本身的均勻性已經由那支的一萬次卡方檢定釘住了，
// 這裡只需要證明**這一層沒有把它弄歪**——
//   ① 每家族等機率（不是每題等機率，也不是「成員多的家族比較容易上」）
//   ② 家族代表在輸出中的位置是均勻的
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pickOnePerFamily } = require('../../utils/pickOnePerFamily');
const { shuffle } = require('../../utils/shuffle');

// ───────────────────────── 測試輔助 ─────────────────────────

const SAMPLES = 6000; // 比 shuffle.test.js 的 10000 輕量

/** mulberry32：與 shuffle.test.js 同一支 PRNG，固定種子讓 CI 不會隨機轉紅。 */
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

const CHI_CRIT_DF2 = 13.816; // 自由度 2（3 個家族），p = 0.001
const CHI_CRIT_DF3 = 16.266; // 自由度 3（4 個成員／4 個位置），p = 0.001

const SEED = 20260823;

/** 把固定種子的 PRNG 綁進 shuffle，當成注入用的 shuffleFn。 */
function seededShuffle(seed) {
    const random = mulberry32(seed);
    return items => shuffle(items, random);
}

/**
 * 一個「家族 → 成員 id」的題庫。
 * 家族 10：只有藍本自己；家族 20：藍本 + 3 題變式；家族 30：藍本 + 1 題變式。
 */
function makePool() {
    return [
        { id: 10, variant_of: null },
        { id: 20, variant_of: null },
        { id: 21, variant_of: 20 },
        { id: 22, variant_of: 20 },
        { id: 23, variant_of: 20 },
        { id: 30, variant_of: null },
        { id: 31, variant_of: 30 }
    ];
}

// ═════════════════════ 1. 基本契約 ═════════════════════

describe('pickOnePerFamily — 基本契約', () => {
    test('不修改原陣列，回傳新陣列，元素是原物件的參照', () => {
        const rows = makePool();
        const snapshot = JSON.stringify(rows);
        const result = pickOnePerFamily(rows);

        assert.equal(JSON.stringify(rows), snapshot, '原陣列不得被修改');
        assert.notEqual(result, rows, '必須回傳新陣列');
        result.forEach(r => assert.ok(rows.includes(r), '必須是原物件本身（後續要拿 id 去撈完整題目）'));
    });

    test('空陣列回空陣列', () => {
        assert.deepEqual(pickOnePerFamily([]), []);
    });

    test('每個家族恰好留一題，家族數 = 不重複的 COALESCE(variant_of, id) 個數', () => {
        const rows = makePool();
        const result = pickOnePerFamily(rows);
        assert.equal(result.length, 3, '三個家族（10／20／30）應留下三題');

        const familyKeys = result.map(r => r.variant_of ?? r.id).sort((a, b) => a - b);
        assert.deepEqual(familyKeys, [10, 20, 30], '三個家族各出現一次，不重不漏');
    });

    test('全部是孤題時等於單純洗牌（不會少題）', () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, variant_of: null }));
        const result = pickOnePerFamily(rows);
        assert.equal(result.length, 12);
        assert.deepEqual(result.map(r => r.id).sort((a, b) => a - b), rows.map(r => r.id));
    });

    test('缺 variant_of 鍵視同 null（SQL 沒撈那一欄時不該整池變成一個家族）', () => {
        const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const result = pickOnePerFamily(rows);
        assert.equal(result.length, 3, '三個孤題應留三題');
    });

    test('分組保留第一次出現的順序（決定性）', () => {
        // 注入 identity 當 shuffleFn：取代表永遠取組內第一個、最後也不打亂，
        // 這樣輸出順序就完全暴露「分組順序」本身。
        const identity = items => [...items];
        const rows = [
            { id: 23, variant_of: 20 },   // 家族 20 先出現（由變式先出現）
            { id: 10, variant_of: null }, // 家族 10 次之
            { id: 20, variant_of: null },
            { id: 30, variant_of: null }
        ];
        assert.deepEqual(pickOnePerFamily(rows, identity).map(r => r.id), [23, 10, 30],
            '家族順序應為 20 → 10 → 30（首次出現序），且家族 20 的代表是先出現的 23');
    });

    test('家族鍵是整數也不會被重排成 id 大小序（不得用普通物件當字典）', () => {
        const identity = items => [...items];
        const rows = [
            { id: 300, variant_of: null },
            { id: 100, variant_of: null },
            { id: 200, variant_of: null }
        ];
        assert.deepEqual(pickOnePerFamily(rows, identity).map(r => r.id), [300, 100, 200]);
    });

    test('預設參數就是 utils/shuffle.js 的 shuffle（不傳 shuffleFn 也要能跑）', () => {
        const result = pickOnePerFamily(makePool());
        assert.equal(result.length, 3);
    });

    test('shuffleFn 的呼叫次數固定為「家族數 + 1」（單題家族也照走一次）', () => {
        let calls = 0;
        const counting = items => { calls++; return [...items]; };
        pickOnePerFamily(makePool(), counting);
        assert.equal(calls, 4, '三個家族各一次，加上最後對代表洗牌一次');
    });
});

// ═════════════════════ 2. 每家族等機率 ═════════════════════
// 這是 P-06 唯一真正的語意改變：抽題從「每題等機率」變成「每家族等機率」。

describe('pickOnePerFamily — 分佈（固定種子，可重現）', () => {
    test(`家族 20 的四個成員被選為代表的機率相等（${SAMPLES} 次，卡方 < ${CHI_CRIT_DF3}）`, () => {
        const rows = [
            { id: 20, variant_of: null },
            { id: 21, variant_of: 20 },
            { id: 22, variant_of: 20 },
            { id: 23, variant_of: 20 }
        ];
        const shuffleFn = seededShuffle(SEED);
        const tally = new Map([[20, 0], [21, 0], [22, 0], [23, 0]]);
        for (let i = 0; i < SAMPLES; i++) {
            const [picked] = pickOnePerFamily(rows, shuffleFn);
            tally.set(picked.id, tally.get(picked.id) + 1);
        }

        const chi = chiSquare([...tally.values()], SAMPLES / 4);
        assert.ok(chi < CHI_CRIT_DF3,
            `組內代表分佈偏離均勻：卡方 ${chi.toFixed(2)}（各成員 ${[...tally.values()].join(', ')}）`);
    });

    test('「每家族等機率」而非「每題等機率」：孤題與 4 題家族的中選率相同', () => {
        // 這一則是本檔的重點：若有人把家族互斥實作成「先洗牌整池、再去重家族」，
        // 成員多的家族就會系統性地比較常上——這裡會抓到。
        //
        // 只取 1 題（模擬 slice(0, 1)），看被取到的是哪個家族。
        const rows = makePool(); // 家族 10（1 題）／20（4 題）／30（2 題）
        const shuffleFn = seededShuffle(SEED);
        const tally = new Map([[10, 0], [20, 0], [30, 0]]);
        for (let i = 0; i < SAMPLES; i++) {
            const [first] = pickOnePerFamily(rows, shuffleFn);
            const family = first.variant_of ?? first.id;
            tally.set(family, tally.get(family) + 1);
        }

        const chi = chiSquare([...tally.values()], SAMPLES / 3);
        assert.ok(chi < CHI_CRIT_DF2,
            `家族中選率偏離均勻：卡方 ${chi.toFixed(2)}（家族 10／20／30 各 ${[...tally.values()].join(', ')}）——` +
            `若家族 20（成員最多）明顯偏高，代表家族互斥被實作成「先洗牌再去重」`);
    });

    test(`家族代表在輸出中的位置均勻（${SAMPLES} 次，每個位置的卡方 < ${CHI_CRIT_DF2}）`, () => {
        const rows = makePool();
        const shuffleFn = seededShuffle(SEED);
        const families = [10, 20, 30];
        // matrix[position][familyIndex]
        const matrix = families.map(() => new Array(families.length).fill(0));

        for (let i = 0; i < SAMPLES; i++) {
            pickOnePerFamily(rows, shuffleFn).forEach((row, position) => {
                matrix[position][families.indexOf(row.variant_of ?? row.id)]++;
            });
        }

        matrix.forEach((row, position) => {
            const chi = chiSquare(row, SAMPLES / families.length);
            assert.ok(chi < CHI_CRIT_DF2,
                `位置 ${position} 的家族分佈偏離均勻：卡方 ${chi.toFixed(2)}（${row.join(', ')}）`);
        });
    });

    test('改用真實 Math.random（不注入 shuffleFn）仍不偏斜：三個家族都出現在第一個位置過', () => {
        // 防止有人把亂數來源寫死，或讓預設參數失效。門檻寬鬆，只求不會偶發轉紅。
        const rows = makePool();
        const seenFirst = new Set();
        for (let i = 0; i < 300; i++) {
            const [first] = pickOnePerFamily(rows);
            seenFirst.add(first.variant_of ?? first.id);
        }
        assert.equal(seenFirst.size, 3, `三個家族都應有機會排第一，實際只看到 ${[...seenFirst].join(', ')}`);
    });
});
