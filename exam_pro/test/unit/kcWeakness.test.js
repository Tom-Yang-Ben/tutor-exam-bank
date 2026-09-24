// ─────────────────────────────────────────────────────────────
// kcWeaknessService 單元測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 1 項）
//
// 釘三件事：
//   1. Wilson 下界的數值與邊界（n=0、全對、全錯、小數樣本量）。這支函式決定補救卷先補哪裡，
//      錯了不會噴錯，只會讓「1 題對 1 題」被當成精熟、或讓沒有資料的知識點被當成 0 分。
//   2. SQL builder 的參數順序沿用 weaknessService 凍結的 $1 studentId、$2 days、$3 subject（裁決 S3-4）。
//   3. rankUnits 的排序（mastery_lb 由低到高、沒有批改的排最後）與 low_sample 門檻。
// SQL 本身對不對由 test/integration/remedial.pg.test.js 送進 Postgres 驗。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const kc = require('../../services/kcWeaknessService');

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

describe('wilsonLowerBound（z = 1.96）', () => {
    test('z 凍結為 1.96', () => {
        assert.equal(kc.WILSON_Z, 1.96);
    });

    test('n = 0（沒有任何批改）回 null，不是 0：沒資料不等於不會', () => {
        assert.equal(kc.wilsonLowerBound(0, 0), null);
        assert.equal(kc.wilsonLowerBound(3, 0), null);
        assert.equal(kc.wilsonLowerBound(0, -1), null);
        assert.equal(kc.wilsonLowerBound(0, NaN), null);
        assert.equal(kc.wilsonLowerBound(0, undefined), null);
    });

    test('全錯 → 0（且不會因浮點誤差變成負數）', () => {
        assert.equal(kc.wilsonLowerBound(0, 1), 0);
        assert.equal(kc.wilsonLowerBound(0, 10), 0);
        assert.equal(kc.wilsonLowerBound(0, 1000), 0);
    });

    test('全對 → 小於 1 的下界，樣本越多越接近 1', () => {
        close(kc.wilsonLowerBound(1, 1), 0.2065);
        close(kc.wilsonLowerBound(10, 10), 0.7225);
        close(kc.wilsonLowerBound(100, 100), 0.9630);
        assert.ok(kc.wilsonLowerBound(1, 1) < kc.wilsonLowerBound(10, 10));
        assert.ok(kc.wilsonLowerBound(100, 100) < 1);
    });

    test('一般值：5/10 ≈ 0.2366、3/10 ≈ 0.1078', () => {
        close(kc.wilsonLowerBound(5, 10), 0.2366);
        close(kc.wilsonLowerBound(3, 10), 0.1078);
    });

    test('小數樣本量（知識點加權）照樣可算', () => {
        close(kc.wilsonLowerBound(2.5, 5), 0.1704);
        const lb = kc.wilsonLowerBound(0.5, 0.5);
        assert.ok(lb > 0 && lb < 1);
    });

    test('1 題對 1 題的下界低於 8 題對 10 題：樣本少不等於精熟', () => {
        assert.ok(kc.wilsonLowerBound(1, 1) < kc.wilsonLowerBound(8, 10));
    });

    test('correct 超出 [0, n] 先夾回區間', () => {
        assert.equal(kc.wilsonLowerBound(12, 10), kc.wilsonLowerBound(10, 10));
        assert.equal(kc.wilsonLowerBound(-3, 10), 0);
    });
});

describe('round4', () => {
    test('四捨五入到小數第 4 位；null／NaN 回 null', () => {
        assert.equal(kc.round4(0.123456), 0.1235);
        assert.equal(kc.round4(2), 2);
        assert.equal(kc.round4(null), null);
        assert.equal(kc.round4(undefined), null);
        assert.equal(kc.round4(NaN), null);
    });
});

describe('SQL builder 的參數順序（沿用裁決 S3-4：$1 studentId、$2 days、$3 subject）', () => {
    for (const name of ['buildKcAggregate', 'buildGradedTagCounts']) {
        test(`${name}：values = [studentId, days, subject]`, () => {
            const { text, values } = kc[name]({ studentId: 7, subject: '物理', days: 30 });
            assert.deepEqual(values, [7, 30, '物理']);
            assert.match(text, /a\.student_id = \$1/);
            assert.match(text, /CURRENT_DATE - \$2::int/);
            assert.match(text, /\(\$3::text IS NULL OR q\.subject = \$3\)/);
        });

        test(`${name}：空字串與 undefined 的 subject 一律正規化成 null（不分科）`, () => {
            assert.equal(kc[name]({ studentId: 1, subject: '', days: 90 }).values[2], null);
            assert.equal(kc[name]({ studentId: 1, days: 90 }).values[2], null);
        });
    }

    test('buildKcAggregate：以 weight 加權、正確度 = COALESCE(score, result)、已批改 = result IS NOT NULL', () => {
        const { text } = kc.buildKcAggregate({ studentId: 1, subject: null, days: 90 });
        assert.match(text, /COALESCE\(a\.score::float8, a\.result::float8\)/);
        assert.match(text, /a\.result IS NOT NULL/);
        assert.match(text, /qk\.weight::float8 \* w\.correctness/);
        // 不排除已封存題（裁決 S3-2）：歷史作答不因題目封存而消失
        assert.doesNotMatch(text, /archived_at/);
    });

    test('buildGradedTagCounts：只數已批改題', () => {
        const { text } = kc.buildGradedTagCounts({ studentId: 1, subject: null, days: 90 });
        assert.match(text, /a\.result IS NOT NULL/);
        assert.match(text, /tagged_graded/);
        assert.match(text, /untagged_graded/);
    });
});

describe('rankUnits：排序、正確率與 low_sample', () => {
    const rows = [
        { code: 'MATH.向量內積.03', graded: 10, correct: 8 },   // lb ≈ 0.49
        { code: 'MATH.向量內積.01', graded: 1, correct: 1 },    // lb ≈ 0.21
        { code: 'MATH.向量內積.02', graded: 10, correct: 3 },   // lb ≈ 0.11
        { code: 'MATH.向量內積.04', graded: 0, correct: 0 },    // 只指派、沒批改
        { code: 'MATH.向量內積.05', graded: 10, correct: 3 }    // 與 .02 同分：code 小的在前
    ];

    test('依 mastery_lb 由低到高；沒有批改（null）排最後；同分依 graded DESC、key ASC', () => {
        const out = kc.rankUnits(rows, 5, r => r.code);
        assert.deepEqual(out.map(r => r.code),
            ['MATH.向量內積.02', 'MATH.向量內積.05', 'MATH.向量內積.01', 'MATH.向量內積.03', 'MATH.向量內積.04']);
    });

    test('correct_rate 與 mastery_lb 四捨五入到 4 位；graded = 0 時兩者都是 null', () => {
        const out = kc.rankUnits(rows, 5, r => r.code);
        const byCode = Object.fromEntries(out.map(r => [r.code, r]));
        assert.equal(byCode['MATH.向量內積.03'].correct_rate, 0.8);
        assert.equal(byCode['MATH.向量內積.03'].mastery_lb, kc.round4(kc.wilsonLowerBound(8, 10)));
        assert.equal(byCode['MATH.向量內積.04'].correct_rate, null);
        assert.equal(byCode['MATH.向量內積.04'].mastery_lb, null);
    });

    test('low_sample = graded < WEAKNESS_MIN_N（含 graded = 0）', () => {
        const out = kc.rankUnits(rows, 5, r => r.code);
        const byCode = Object.fromEntries(out.map(r => [r.code, r]));
        assert.equal(byCode['MATH.向量內積.01'].low_sample, true);
        assert.equal(byCode['MATH.向量內積.04'].low_sample, true);
        assert.equal(byCode['MATH.向量內積.03'].low_sample, false);
        // 門檻設成 0：沒有任何一列是樣本不足
        assert.ok(kc.rankUnits(rows, 0, r => r.code).every(r => r.low_sample === false));
    });

    test('加權後的小數樣本量照樣可比較（graded 2.5 < 5 → low_sample）', () => {
        const [u] = kc.rankUnits([{ code: 'X', graded: 2.5, correct: 1.25 }], 5, r => r.code);
        assert.equal(u.graded, 2.5);
        assert.equal(u.correct_rate, 0.5);
        assert.equal(u.low_sample, true);
    });

    test('不改動輸入陣列', () => {
        const copy = JSON.parse(JSON.stringify(rows));
        kc.rankUnits(rows, 5, r => r.code);
        assert.deepEqual(rows, copy);
    });
});

describe('toApiRow：只輸出契約的十個鍵', () => {
    test('鍵與順序同契約第 4.4 條第 1 項', () => {
        const row = kc.toApiRow({
            kc_id: 1, code: 'C', name: 'N', subject: '數學', chapter: '向量內積', sort: 2,
            graded: 3, correct: 2, correct_rate: 0.6667, mastery_lb: 0.2, low_sample: true,
            avg_wrong_difficulty: 3, avg_graded_difficulty: 2.5
        });
        assert.deepEqual(Object.keys(row),
            ['kc_id', 'code', 'name', 'subject', 'chapter', 'graded', 'correct', 'correct_rate', 'mastery_lb', 'low_sample']);
    });
});

describe('loadKcWeakness：兩條查詢、組裝', () => {
    test('用注入的 query 跑兩條查詢並回排序後的單位與兩個計數', async () => {
        const calls = [];
        const deps = {
            async query(text, values) {
                calls.push({ text, values });
                if (/tagged_graded/.test(text)) return { rows: [{ tagged_graded: 6, untagged_graded: 2 }] };
                return { rows: [
                    { kc_id: 1, code: 'B', graded: 4, correct: 4 },
                    { kc_id: 2, code: 'A', graded: 4, correct: 0 }
                ] };
            }
        };
        const out = await kc.loadKcWeakness({ studentId: 9, subject: '數學', days: 30, minN: 5 }, deps);
        assert.equal(calls.length, 2);
        for (const c of calls) assert.deepEqual(c.values, [9, 30, '數學']);
        assert.equal(out.taggedGraded, 6);
        assert.equal(out.untaggedGraded, 2);
        assert.deepEqual(out.units.map(u => u.code), ['A', 'B']);
    });
});
