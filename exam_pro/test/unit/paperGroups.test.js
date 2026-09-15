// ─────────────────────────────────────────────────────────────
// paperGroups 單元測試（FR-019 PR2，ACPT-019-5）——承上題整組抽取的純函式。
// 不連 DB；隨機性以注入的 shuffleFn 控制。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { groupFollowUps, pickPaperUnits, packUnits, sortForPaperGrouped } = require('../../utils/paperGroups');
const { pickOnePerFamily } = require('../../utils/pickOnePerFamily');

const identity = (xs) => [...xs];
const reverse = (xs) => [...xs].reverse();

/** 固定種子 PRNG（mulberry32），產生可重現的 Fisher-Yates。 */
function seededShuffle(seed) {
    let a = seed >>> 0;
    const rand = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (xs) => {
        const out = [...xs];
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    };
}

const row = (id, follows = null, variant_of = null) => ({ id, follows_question_id: follows, variant_of });

describe('groupFollowUps — 依 follows_question_id 分組', () => {
    test('沒有綁定：每題自成一組，順序同輸入', () => {
        assert.deepEqual(groupFollowUps([row(3), row(1), row(2)]), [[3], [1], [2]]);
    });

    test('兩層鏈：前題 → 承上 → 承上，不論輸入順序都依承接順序排', () => {
        const groups = groupFollowUps([row(12, 11), row(5), row(11, 10), row(10)]);
        assert.deepEqual(groups, [[10, 11, 12], [5]]);
    });

    test('同一前題兩個承上題：依 id 由小到大，子鏈深度優先', () => {
        // 1 ← 4、1 ← 2 ← 3
        const groups = groupFollowUps([row(4, 1), row(3, 2), row(2, 1), row(1)]);
        assert.deepEqual(groups, [[1, 2, 3, 4]]);
    });

    test('指向批外的前題：忽略該邊，該題視為組首', () => {
        assert.deepEqual(groupFollowUps([row(7, 99), row(8, 7)]), [[7, 8]]);
    });

    test('資料有環也不會無窮迴圈，每題恰出現一次', () => {
        const groups = groupFollowUps([row(1, 3), row(2, 1), row(3, 2)]);
        assert.equal(groups.length, 1);
        assert.deepEqual([...groups[0]].sort(), [1, 2, 3]);
    });
});

describe('pickPaperUnits — 整組抽取', () => {
    test('抽到承上組就整組納入、組內相鄰且依承接順序，整組算多題', () => {
        const candidates = [row(1), row(2, 1), row(3, 2), row(4), row(5)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 4, shuffleFn: identity });
        // identity：單位順序 [1,2,3]、[4]、[5] → 先收 3 題的組，再收 4
        assert.deepEqual(out.ids, [1, 2, 3, 4]);
        assert.equal(out.actual, 4);
        assert.equal(out.availableCount, 5);
    });

    test('組內有題不在候選池（已作答／排除／封存／題源／章節不符）→ 整組不抽，也不留孤兒承上題', () => {
        // 前題 1 不在候選池，承上題 2 在：2 不得單獨出現
        const candidates = [row(2, 1), row(4), row(5)];
        const related = [row(1), row(2, 1)];
        const out = pickPaperUnits({ candidates, related, limitCount: 2, shuffleFn: identity });
        assert.deepEqual(out.ids, [4, 5]);
        assert.equal(out.availableCount, 2);
        assert.equal(out.droppedGroups, 1);

        // 反過來：承上題 2 不在候選池，前題 1 也不抽（整組一致）
        const out2 = pickPaperUnits({
            candidates: [row(1), row(4), row(5)], related: [row(1), row(2, 1)], limitCount: 2, shuffleFn: identity
        });
        assert.deepEqual(out2.ids, [4, 5]);
    });

    test('多層鏈中間一題不可用：整條鏈都不抽', () => {
        const related = [row(1), row(2, 1), row(3, 2)];
        const out = pickPaperUnits({ candidates: [row(1), row(3, 2), row(9)], related, limitCount: 1, shuffleFn: identity });
        assert.deepEqual(out.ids, [9]);
        assert.equal(out.droppedGroups, 1);
    });

    test('剩 1 個名額但下一組有 2 題：跳過該組找塞得下的；都塞不下就少出（actual < limitCount）', () => {
        const candidates = [row(1), row(2, 1), row(3), row(4, 3)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 3, shuffleFn: identity });
        assert.deepEqual(out.ids, [1, 2]);
        assert.equal(out.actual, 2);
        assert.equal(out.availableCount, 4);
        assert.equal(out.minUnitSize, 2);

        const out2 = pickPaperUnits({ candidates: [...candidates, row(9)], related: candidates, limitCount: 3, shuffleFn: identity });
        assert.deepEqual(out2.ids, [1, 2, 9], '塞不下 [3,4] 時要繼續往後找單題補滿');
    });

    test('有組合能剛好湊滿時一定湊滿，不因洗牌順序先收到大組而少出（組大小 [3,2,2]、要 4 題）', () => {
        const candidates = [row(1), row(2, 1), row(3, 2), row(10), row(11, 10), row(20), row(21, 20)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 4, shuffleFn: identity });
        assert.equal(out.actual, 4);
        assert.deepEqual(out.ids, [10, 11, 20, 21]);

        // 真洗牌多次：永不少出
        for (let seed = 1; seed <= 300; seed++) {
            const r = pickPaperUnits({ candidates, related: candidates, limitCount: 4, shuffleFn: seededShuffle(seed) });
            assert.equal(r.actual, 4, `seed ${seed}`);
        }
    });

    test('湊不滿時取最接近 N 的組合，同樣多時依洗牌順序優先（大小 [2,3,3]、要 5 → 5；[4,4]、要 7 → 4）', () => {
        const candidates = [row(1), row(2, 1), row(10), row(11, 10), row(12, 11), row(20), row(21, 20), row(22, 21)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 5, shuffleFn: identity });
        assert.deepEqual(out.ids, [1, 2, 10, 11, 12], '先收的組能湊滿就收先收的');

        const big = [row(1), row(2, 1), row(3, 2), row(4, 3), row(5), row(6, 5), row(7, 6), row(8, 7)];
        const out2 = pickPaperUnits({ candidates: big, related: big, limitCount: 7, shuffleFn: identity });
        assert.deepEqual(out2.ids, [1, 2, 3, 4]);
        assert.equal(out2.actual, 4);

        // 大小 [3,2]、要 4：貪婪只收 3，但最大可達仍是 3（2 更少）→ 取 3
        const c3 = [row(1), row(2, 1), row(3, 2), row(10), row(11, 10)];
        const out3 = pickPaperUnits({ candidates: c3, related: c3, limitCount: 4, shuffleFn: identity });
        assert.deepEqual(out3.ids, [1, 2, 3]);
    });

    test('packUnits：貪婪能湊滿時選法與貪婪相同；總和恆為 ≤ limit 的最大可達值（隨機 2000 例對照暴力解）', () => {
        let a = 7;
        const rand = (k) => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return (a >>> 8) % k; };
        for (let t = 0; t < 2000; t++) {
            const sizes = Array.from({ length: 1 + rand(7) }, () => 1 + rand(4));
            const limit = rand(12);
            const chosen = packUnits(sizes, limit);
            const sum = chosen.reduce((s, i) => s + sizes[i], 0);

            let best = 0;
            for (let mask = 0; mask < (1 << sizes.length); mask++) {
                let s = 0;
                for (let i = 0; i < sizes.length; i++) if (mask & (1 << i)) s += sizes[i];
                if (s <= limit && s > best) best = s;
            }
            assert.equal(sum, best, `sizes ${sizes} limit ${limit}`);

            const greedy = [];
            let g = 0;
            sizes.forEach((sz, i) => { if (g < limit && g + sz <= limit) { greedy.push(i); g += sz; } });
            if (g === limit) assert.deepEqual(chosen, greedy, `sizes ${sizes} limit ${limit}`);
        }
    });

    test('名額比最小的組還小：actual = 0', () => {
        const candidates = [row(1), row(2, 1)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 1, shuffleFn: identity });
        assert.deepEqual(out.ids, []);
        assert.equal(out.availableCount, 2);
        assert.equal(out.minUnitSize, 2);
    });

    test('家族互斥：組首的變式與組只取其一；組內非組首題的變式與組相撞時先到先得', () => {
        // 組 [1,2]；10 是 1 的變式（同家族 1）；20 是 2 的變式（家族 2）
        const candidates = [row(1), row(2, 1), row(10, null, 1), row(20, null, 2)];
        const out = pickPaperUnits({ candidates, related: candidates, limitCount: 10, shuffleFn: identity });
        // 家族 1：[組, 10] 取組（identity 取第一個）；家族 20 的鍵是 2 → 與組內 2 相撞 → 丟
        assert.deepEqual(out.ids, [1, 2]);
        assert.equal(out.availableCount, 2);

        const out2 = pickPaperUnits({ candidates, related: candidates, limitCount: 10, shuffleFn: reverse });
        const ids = new Set(out2.ids);
        assert.ok(!(ids.has(1) && ids.has(10)), '同家族不得同卷');
        assert.ok(!(ids.has(2) && ids.has(20)), '同家族不得同卷');
        assert.ok(!ids.has(2) || ids.has(1), '不得有孤兒承上題');
    });

    test('沒有任何綁定時與舊版 pickOnePerFamily → slice 結果完全相同（含變式家族、固定種子）', () => {
        const candidates = Array.from({ length: 30 }, (_, i) => row(i + 1, null, i % 4 === 0 ? null : (i % 7 === 0 ? 1 : null)));
        for (const seed of [1, 7, 42, 2026]) {
            const legacy = pickOnePerFamily(candidates, seededShuffle(seed)).slice(0, 8).map(q => q.id);
            const out = pickPaperUnits({ candidates, related: [], limitCount: 8, shuffleFn: seededShuffle(seed) });
            assert.deepEqual(out.ids, legacy, `seed ${seed}`);
        }
    });

    test('隨機抽很多次：承上題永遠跟著前題、且緊接在前題之後', () => {
        const candidates = [row(1), row(2, 1), row(3, 2), ...Array.from({ length: 12 }, (_, i) => row(100 + i)), row(50), row(51, 50)];
        const shuffleFn = seededShuffle(99);
        for (let i = 0; i < 300; i++) {
            const { ids } = pickPaperUnits({ candidates, related: candidates, limitCount: 6, shuffleFn });
            for (const [child, parent] of [[2, 1], [3, 2], [51, 50]]) {
                const ci = ids.indexOf(child);
                if (ci !== -1) assert.equal(ids[ci - 1], parent, `第 ${i} 次：${child} 應緊接在 ${parent} 後`);
                const pi = ids.indexOf(parent);
                if (pi !== -1) assert.ok(ids.includes(child), `第 ${i} 次：抽到 ${parent} 必須帶 ${child}`);
            }
            assert.ok(ids.length <= 6);
        }
    });
});

describe('sortForPaperGrouped — 考卷排序', () => {
    const q = (id, type, difficulty, follows = null) => ({ id, question_type: type, difficulty, follows_question_id: follows });

    test('沒有綁定時與舊版逐題排序相同（題型權重 → 難度，穩定）', () => {
        const qs = [q(1, '計算', 3), q(2, '單選', 5), q(3, '填空', 1), q(4, '單選', 2), q(5, '計算', 3)];
        assert.deepEqual(sortForPaperGrouped(qs).map(x => x.id), [4, 2, 3, 1, 5]);
    });

    test('承上組以組首排序、組內依承接順序相鄰，不被題型權重拆開', () => {
        // 組 [10(計算), 11(單選)]；另有單選 1、填空 2
        const qs = [q(11, '單選', 1, 10), q(1, '單選', 3), q(10, '計算', 2), q(2, '填空', 3)];
        assert.deepEqual(sortForPaperGrouped(qs).map(x => x.id), [1, 2, 10, 11]);
    });

    test('不修改輸入陣列', () => {
        const qs = [q(2, '計算', 3), q(1, '單選', 1)];
        const copy = qs.map(x => x.id);
        sortForPaperGrouped(qs);
        assert.deepEqual(qs.map(x => x.id), copy);
    });
});
