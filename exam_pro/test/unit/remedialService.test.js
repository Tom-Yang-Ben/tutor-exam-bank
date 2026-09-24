// ─────────────────────────────────────────────────────────────
// remedialService 單元測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 2 項）
//
// 補救卷的「選題計畫」全是純函式：配額分配、目標單位、難度區間、併桶與 notes。
// 這一層錯了不會噴錯，只會讓草稿安靜地少幾題、或把強項當弱點補——所以逐條釘住。
// 真的送進 Postgres 的選題（已作答排除、家族互斥、承上題整組）由 test/integration/remedial.pg.test.js 驗；
// 這裡的 planRemedialPaper 用注入的假依賴驗「組裝」。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const r = require('../../services/remedialService');
const kc = require('../../services/kcWeaknessService');

/** 造一個已排序的單位清單（chapter 基底）。 */
function chapterUnits(list) {
    return kc.rankUnits(list.map(u => ({ name: u.chapter, avg_wrong_difficulty: null, avg_graded_difficulty: 3, ...u })), 5, u => u.chapter);
}

describe('契約預設值', () => {
    test('total 預設 20、區間 5–50；mix 預設 0.6／0.2／0.2；days 預設 90', () => {
        assert.equal(r.DEFAULT_TOTAL, 20);
        assert.equal(r.MIN_TOTAL, 5);
        assert.equal(r.MAX_TOTAL, 50);
        assert.deepEqual({ ...r.DEFAULT_MIX }, { remedial: 0.6, prerequisite: 0.2, extension: 0.2 });
        assert.equal(r.DEFAULT_DAYS, 90);
        assert.deepEqual([...r.BUCKETS], ['remedial', 'prerequisite', 'extension']);
    });
});

describe('allocateQuotas（最大餘數法）', () => {
    test('預設配比：20 → 12／4／4，5 → 3／1／1', () => {
        assert.deepEqual(r.allocateQuotas(20, r.DEFAULT_MIX), { remedial: 12, prerequisite: 4, extension: 4 });
        assert.deepEqual(r.allocateQuotas(5, r.DEFAULT_MIX), { remedial: 3, prerequisite: 1, extension: 1 });
    });

    test('餘數給小數部分最大的；同分依 remedial → prerequisite → extension', () => {
        // 7 × 0.6/0.2/0.2 = 4.2／1.4／1.4 → floor 4／1／1，剩 1 題給 .4 的第一個（prerequisite）
        assert.deepEqual(r.allocateQuotas(7, r.DEFAULT_MIX), { remedial: 4, prerequisite: 2, extension: 1 });
        // 10 × 三等分 = 3.33… → 3／3／3，剩 1 題給 remedial
        assert.deepEqual(r.allocateQuotas(10, { remedial: 1, prerequisite: 1, extension: 1 }), { remedial: 4, prerequisite: 3, extension: 3 });
    });

    test('mix 不必加總為 1（只看比例）；可以是 0', () => {
        assert.deepEqual(r.allocateQuotas(20, { remedial: 3, prerequisite: 1, extension: 1 }), { remedial: 12, prerequisite: 4, extension: 4 });
        assert.deepEqual(r.allocateQuotas(5, { remedial: 0, prerequisite: 0, extension: 2 }), { remedial: 0, prerequisite: 0, extension: 5 });
    });

    test('任何題數與配比下總和恰為 total', () => {
        const mixes = [r.DEFAULT_MIX, { remedial: 0.5, prerequisite: 0.3, extension: 0.2 }, { remedial: 0.1, prerequisite: 0.7, extension: 0.2 },
            { remedial: 1, prerequisite: 0, extension: 0 }, { remedial: 0.333, prerequisite: 0.333, extension: 0.334 }];
        for (let total = 5; total <= 50; total++) {
            for (const mix of mixes) {
                const q = r.allocateQuotas(total, mix);
                assert.equal(q.remedial + q.prerequisite + q.extension, total, JSON.stringify({ total, mix, q }));
                for (const b of r.BUCKETS) assert.ok(q[b] >= 0);
            }
        }
    });
});

describe('splitCount', () => {
    test('平均分，餘數給前面的', () => {
        assert.deepEqual(r.splitCount(12, 3), [4, 4, 4]);
        assert.deepEqual(r.splitCount(13, 3), [5, 4, 4]);
        assert.deepEqual(r.splitCount(2, 3), [1, 1, 0]);
        assert.deepEqual(r.splitCount(5, 1), [5]);
        assert.deepEqual(r.splitCount(5, 0), []);
    });
});

describe('難度區間', () => {
    test('remedial：⌊答錯題平均難度 + 1⌋，沒有答錯題時改用已批改平均；夾在 1–5', () => {
        assert.equal(r.remedialDifficultyMax({ avg_wrong_difficulty: 2.5, avg_graded_difficulty: 4 }), 3);
        assert.equal(r.remedialDifficultyMax({ avg_wrong_difficulty: 3, avg_graded_difficulty: 1 }), 4);
        assert.equal(r.remedialDifficultyMax({ avg_wrong_difficulty: null, avg_graded_difficulty: 2 }), 3);
        assert.equal(r.remedialDifficultyMax({ avg_wrong_difficulty: 4.8, avg_graded_difficulty: 4 }), 5);
        assert.equal(r.remedialDifficultyMax({ avg_wrong_difficulty: null, avg_graded_difficulty: null }), null);
    });

    test('extension：⌊已批改平均難度⌋ + 1，上限 5', () => {
        assert.equal(r.extensionDifficultyMin({ avg_graded_difficulty: 2 }), 3);
        assert.equal(r.extensionDifficultyMin({ avg_graded_difficulty: 2.9 }), 3);
        assert.equal(r.extensionDifficultyMin({ avg_graded_difficulty: 4.5 }), 5);
        assert.equal(r.extensionDifficultyMin({ avg_graded_difficulty: 5 }), 5);
        assert.equal(r.extensionDifficultyMin({ avg_graded_difficulty: null }), null);
    });
});

describe('chooseUnits：remedial 取最弱的 min(3, ⌈n/2⌉) 個，extension 取其餘最強的最多 3 個', () => {
    const make = n => chapterUnits(Array.from({ length: n }, (_, i) => ({ chapter: `章${i}`, graded: 10, correct: i })));

    for (const [n, k, e] of [[1, 1, 0], [2, 1, 1], [3, 2, 1], [4, 2, 2], [5, 3, 2], [6, 3, 3], [8, 3, 3]]) {
        test(`n = ${n} → remedial ${k} 個、extension ${e} 個`, () => {
            const { remedial, extension } = r.chooseUnits(make(n));
            assert.equal(remedial.length, k);
            assert.equal(extension.length, e);
            // remedial 是最弱的（答對最少）；extension 是剩下裡最強的，且不與 remedial 重複
            assert.deepEqual(remedial.map(u => u.chapter), Array.from({ length: k }, (_, i) => `章${i}`));
            assert.deepEqual(extension.map(u => u.chapter), Array.from({ length: e }, (_, i) => `章${n - 1 - i}`));
        });
    }

    test('沒有批改的單位（graded = 0）不當弱點也不當強項', () => {
        const units = chapterUnits([{ chapter: '甲', graded: 0, correct: 0 }, { chapter: '乙', graded: 4, correct: 1 }]);
        const { remedial, extension } = r.chooseUnits(units);
        assert.deepEqual(remedial.map(u => u.chapter), ['乙']);
        assert.deepEqual(extension, []);
    });
});

describe('choosePrereqTargets', () => {
    const rem = [
        { kc_id: 1, code: 'MATH.向量內積.02', name: '坐標算法' },
        { kc_id: 2, code: 'MATH.向量內積.03', name: '正射影' }
    ];
    const pre = (kc_id, prereq_kc_id, extra = {}) => ({
        kc_id, prereq_kc_id, code: `MATH.X.${String(prereq_kc_id).padStart(2, '0')}`, name: `先備${prereq_kc_id}`,
        subject: '數學', chapter: '向量的加減與係數積', strength: 1, ...extra
    });

    test('依 remedial 順序、strength 由高到低；跳過本身已是 remedial 的與重複的', () => {
        const rows = [pre(2, 12), pre(1, 11, { strength: 0.5 }), pre(1, 10), pre(1, 2), pre(2, 10)];
        const { targets } = r.choosePrereqTargets(rem, rows, '數學');
        assert.deepEqual(targets.map(t => t.kc_id), [10, 11, 12]);
        assert.equal(targets[0].for_name, '坐標算法');
        assert.equal(targets[2].for_name, '正射影');
    });

    test('跨科的先備不納入，回報在 skipped（補救卷限單科）', () => {
        const rows = [pre(1, 20, { subject: '物理', name: '力的合成' }), pre(1, 10)];
        const { targets, skipped } = r.choosePrereqTargets(rem, rows, '數學');
        assert.deepEqual(targets.map(t => t.kc_id), [10]);
        assert.deepEqual(skipped.map(s => s.name), ['力的合成']);
    });

    test('最多 3 個', () => {
        const rows = [pre(1, 10), pre(1, 11), pre(1, 12), pre(1, 13)];
        assert.equal(r.choosePrereqTargets(rem, rows, '數學').targets.length, r.MAX_PREREQ_TARGETS);
    });
});

describe('buildPlan', () => {
    const ranked4 = chapterUnits([
        { chapter: '向量內積', graded: 10, correct: 2, avg_wrong_difficulty: 2.4, avg_graded_difficulty: 2.5 },
        { chapter: '排列', graded: 10, correct: 5, avg_wrong_difficulty: 3, avg_graded_difficulty: 3 },
        { chapter: '組合', graded: 10, correct: 8, avg_graded_difficulty: 2 },
        { chapter: '實數', graded: 10, correct: 9, avg_graded_difficulty: 3.5 }
    ]);

    test('chapter 基底：先備配額併入補救並寫 notes；補救分給最弱的 2 章、延伸給最強的 2 章', () => {
        const plan = r.buildPlan({ basis: 'chapter', total: 20, mix: r.DEFAULT_MIX, ranked: ranked4, subject: '數學' });
        assert.ok(plan.notes.some(n => n.includes('先備配額 4 題併入補救')), plan.notes.join('\n'));
        const rem = plan.quotas.filter(q => q.bucket === 'remedial');
        const ext = plan.quotas.filter(q => q.bucket === 'extension');
        assert.equal(plan.quotas.filter(q => q.bucket === 'prerequisite').length, 0);
        assert.deepEqual(rem.map(q => [q.target.chapter, q.wanted]), [['向量內積', 8], ['排列', 8]]);
        assert.deepEqual(ext.map(q => [q.target.chapter, q.wanted]), [['實數', 2], ['組合', 2]]);
        assert.equal(plan.quotas.reduce((s, q) => s + q.wanted, 0), 20);
    });

    test('target 形狀：chapter 基底 { type, chapter, name }；pool 帶章與難度區間', () => {
        const plan = r.buildPlan({ basis: 'chapter', total: 20, mix: r.DEFAULT_MIX, ranked: ranked4, subject: '數學' });
        const first = plan.quotas[0];
        assert.deepEqual(first.target, { type: 'chapter', chapter: '向量內積', name: '向量內積' });
        assert.deepEqual(first.pool, { chapters: ['向量內積'], difficultyMax: 3 });
        assert.equal(first.difficulty_max, 3);
        assert.match(first.rationale, /掌握度下界/);
        const ext = plan.quotas.find(q => q.bucket === 'extension' && q.target.chapter === '實數');
        assert.deepEqual(ext.pool, { chapters: ['實數'], difficultyMin: 4 });
    });

    test('只有一個單位有批改：延伸配額也併回補救', () => {
        const ranked = chapterUnits([{ chapter: '向量內積', graded: 6, correct: 2 }]);
        const plan = r.buildPlan({ basis: 'chapter', total: 10, mix: r.DEFAULT_MIX, ranked, subject: '數學' });
        assert.deepEqual(plan.quotas.map(q => [q.bucket, q.wanted]), [['remedial', 10]]);
        assert.equal(plan.notes.length, 2);
        assert.ok(plan.notes.some(n => n.includes('延伸配額 2 題併入補救')));
    });

    test('完全沒有批改：不出任何配額，notes 說明原因', () => {
        const plan = r.buildPlan({ basis: 'chapter', total: 20, mix: r.DEFAULT_MIX, ranked: [], subject: '物理' });
        assert.deepEqual(plan.quotas, []);
        assert.match(plan.notes[0], /沒有已批改的題/);
    });

    test('kc 基底：先備目標吃 prerequisite 配額、難度 ≤ 3；target 帶 code', () => {
        const ranked = kc.rankUnits([
            { kc_id: 1, code: 'MATH.向量內積.02', name: '坐標算法', chapter: '向量內積', subject: '數學', graded: 6, correct: 1, avg_wrong_difficulty: 3, avg_graded_difficulty: 3 },
            { kc_id: 2, code: 'MATH.向量內積.03', name: '正射影', chapter: '向量內積', subject: '數學', graded: 6, correct: 5, avg_graded_difficulty: 2 }
        ], 5, u => u.code);
        const prereqRows = [{ kc_id: 1, prereq_kc_id: 9, code: 'MATH.向量的加減與係數積.01', name: '向量的坐標表示', subject: '數學', chapter: '向量的加減與係數積', strength: 1 }];
        const plan = r.buildPlan({ basis: 'kc', total: 10, mix: r.DEFAULT_MIX, ranked, prereqRows, subject: '數學' });
        assert.deepEqual(plan.quotas.map(q => [q.bucket, q.target.code, q.wanted]), [
            ['remedial', 'MATH.向量內積.02', 6],
            ['prerequisite', 'MATH.向量的加減與係數積.01', 2],
            ['extension', 'MATH.向量內積.03', 2]
        ]);
        const pre = plan.quotas[1];
        assert.deepEqual(pre.target, { type: 'kc', code: 'MATH.向量的加減與係數積.01', chapter: '向量的加減與係數積', name: '向量的坐標表示' });
        assert.deepEqual(pre.pool, { kcIds: [9], difficultyMax: 3 });
        assert.match(pre.rationale, /坐標算法/);
        assert.deepEqual(plan.quotas[0].pool, { kcIds: [1], difficultyMax: 4 });
        assert.deepEqual(plan.notes, []);
    });

    test('kc 基底但沒有先備資料：先備配額併入補救並寫 notes', () => {
        const ranked = kc.rankUnits([
            { kc_id: 1, code: 'A', name: '甲', chapter: '向量內積', subject: '數學', graded: 6, correct: 1, avg_graded_difficulty: 3 },
            { kc_id: 2, code: 'B', name: '乙', chapter: '向量內積', subject: '數學', graded: 6, correct: 5, avg_graded_difficulty: 3 }
        ], 5, u => u.code);
        const plan = r.buildPlan({ basis: 'kc', total: 10, mix: r.DEFAULT_MIX, ranked, prereqRows: [], subject: '數學' });
        assert.deepEqual(plan.quotas.map(q => [q.bucket, q.wanted]), [['remedial', 8], ['extension', 2]]);
        assert.ok(plan.notes.some(n => n.includes('沒有登錄同科的先備知識點')));
    });

    test('mix 某桶為 0：該桶不出配額也不寫併桶 notes', () => {
        const plan = r.buildPlan({ basis: 'chapter', total: 10, mix: { remedial: 1, prerequisite: 0, extension: 0 }, ranked: ranked4, subject: '數學' });
        assert.deepEqual(plan.quotas.map(q => q.bucket), ['remedial', 'remedial']);
        assert.deepEqual(plan.notes, []);
    });

    test('題數少於目標數時，分到 0 題的目標不列出', () => {
        const ranked = chapterUnits(Array.from({ length: 6 }, (_, i) => ({ chapter: `章${i}`, graded: 10, correct: i })));
        const plan = r.buildPlan({ basis: 'chapter', total: 5, mix: { remedial: 0.4, prerequisite: 0, extension: 0.6 }, ranked, subject: '數學' });
        // remedial 2 題分給 3 章 → [1,1,0]；extension 3 題分給 3 章 → [1,1,1]
        assert.equal(plan.quotas.filter(q => q.bucket === 'remedial').length, 2);
        assert.equal(plan.quotas.filter(q => q.bucket === 'extension').length, 3);
        assert.ok(plan.quotas.every(q => q.wanted > 0));
    });
});

describe('previewText', () => {
    test('壓空白、超過 80 字截斷加「…」', () => {
        assert.equal(r.previewText('  a\n\n b  '), 'a b');
        assert.equal(r.previewText(null), '');
        const long = 'x'.repeat(100);
        assert.equal(r.previewText(long), `${'x'.repeat(80)}…`);
        assert.equal(r.previewText('y'.repeat(80)), 'y'.repeat(80));
    });
});

describe('SQL builder 的參數順序', () => {
    test('buildChapterMastery：[studentId, days, subject]，正確度 = COALESCE(score, result)', () => {
        const { text, values } = r.buildChapterMastery({ studentId: 3, days: 60, subject: '數學' });
        assert.deepEqual(values, [3, 60, '數學']);
        assert.match(text, /a\.student_id = \$1/);
        assert.match(text, /CURRENT_DATE - \$2::int/);
        assert.match(text, /q\.subject = \$3/);
        assert.match(text, /COALESCE\(a\.score::float8, a\.result::float8\)/);
    });

    test('buildPrereqQuery：[kcIds]', () => {
        const { text, values } = r.buildPrereqQuery([1, 2]);
        assert.deepEqual(values, [[1, 2]]);
        assert.match(text, /kc_prerequisites/);
    });
});

describe('planRemedialPaper（注入假依賴，只驗組裝）', () => {
    /**
     * 假資料庫：知識點標註不足 → chapter 基底；兩章有批改。
     * pickByQuotas 依配額回固定的題；sortForPaper 反轉順序（驗 question_ids 用的是它的結果）。
     */
    function fakeDeps({ tagged = 1 } = {}) {
        const seen = { quotas: null };
        return {
            seen,
            async query(text, values) {
                if (/tagged_graded/.test(text)) return { rows: [{ tagged_graded: tagged, untagged_graded: 9 }] };
                if (/question_kcs qk ON qk\.question_id = w\.question_id/.test(text)) return { rows: [] };
                if (/GROUP BY q\.chapter/.test(text)) {
                    return { rows: [
                        { chapter: '向量內積', graded: 5, correct: 1, avg_wrong_difficulty: 2, avg_graded_difficulty: 2 },
                        { chapter: '排列', graded: 5, correct: 5, avg_wrong_difficulty: null, avg_graded_difficulty: 3 }
                    ] };
                }
                if (/FROM questions WHERE id = ANY/.test(text)) {
                    return { rows: values[0].map(id => ({ id, question_text: `題 ${id}\n內容`, question_type: '填空', difficulty: 2,
                        chapter: id < 100 ? '向量內積' : '排列', follows_question_id: null })) };
                }
                throw new Error(`沒預期的查詢：${text.slice(0, 60)}`);
            },
            async pickByQuotas({ quotas }) {
                seen.quotas = quotas;
                return quotas.map((q, i) => i === 0
                    ? { ids: [1, 2, 3], got: 3, availableCount: 3 }        // 要 8 題只有 3 題：庫存不足
                    : { ids: [101, 102], got: 2, availableCount: 5 });
            },
            sortForPaper: rows => [...rows].reverse(),
            shortfallReason: (res, wanted) => (res.availableCount < wanted ? 'insufficient_stock' : 'follow_up_group')
        };
    }

    test('chapter 基底：回應形狀、items 依桶分組、question_ids 用 sortForPaper 的順序、shortfalls 與 notes', async () => {
        const deps = fakeDeps();
        const out = await r.planRemedialPaper({ studentId: 5, subject: '數學', total: 10, mix: r.DEFAULT_MIX, days: 90, sourceTypes: null, minN: 5 }, deps);
        assert.deepEqual(Object.keys(out), ['student_id', 'subject', 'basis', 'question_ids', 'items', 'blueprint', 'shortfalls', 'notes']);
        assert.equal(out.student_id, 5);
        assert.equal(out.basis, 'chapter');
        assert.deepEqual(deps.seen.quotas.map(q => q.count), [8, 2]);
        assert.deepEqual(deps.seen.quotas[0].pool, { chapters: ['向量內積'], difficultyMax: 3 });
        assert.deepEqual(out.question_ids, [102, 101, 3, 2, 1]);
        assert.deepEqual(out.items.map(i => [i.question_id, i.bucket]), [[1, 'remedial'], [2, 'remedial'], [3, 'remedial'], [101, 'extension'], [102, 'extension']]);
        assert.deepEqual(Object.keys(out.items[0]), ['question_id', 'bucket', 'target', 'chapter', 'difficulty', 'question_text_preview']);
        assert.equal(out.items[0].question_text_preview, '題 1 內容');
        assert.deepEqual(out.blueprint.map(b => [b.bucket, b.target.chapter, b.wanted, b.got]), [['remedial', '向量內積', 8, 3], ['extension', '排列', 2, 2]]);
        for (const b of out.blueprint) for (const k of ['bucket', 'target', 'wanted', 'got']) assert.ok(k in b);
        assert.deepEqual(out.shortfalls, [{ bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 8, got: 3, reason: 'insufficient_stock' }]);
        // 有標註但不夠 → 說明為何退回章節；先備併入補救；最後一句說實際題數
        assert.match(out.notes[0], /有知識點標註的已批改題只有 1 題/);
        assert.ok(out.notes.some(n => n.includes('先備配額')));
        assert.match(out.notes[out.notes.length - 1], /本草稿實際 5 題（要求 10 題）/);
    });

    test('沒有任何標註時不寫「只有 0 題」那句；沒有配額時不呼叫 pickByQuotas', async () => {
        const deps = fakeDeps({ tagged: 0 });
        deps.query = async (text) => {
            if (/tagged_graded/.test(text)) return { rows: [{ tagged_graded: 0, untagged_graded: 0 }] };
            return { rows: [] };
        };
        deps.pickByQuotas = async () => { throw new Error('不該被呼叫'); };
        const out = await r.planRemedialPaper({ studentId: 5, subject: '數學', total: 10, mix: r.DEFAULT_MIX, days: 90, sourceTypes: null, minN: 5 }, deps);
        assert.equal(out.basis, 'chapter');
        assert.deepEqual(out.question_ids, []);
        assert.deepEqual(out.items, []);
        assert.deepEqual(out.blueprint, []);
        assert.equal(out.notes.length, 1);
        assert.match(out.notes[0], /沒有已批改的題/);
    });

    test('WEAKNESS_MIN_N = 0 時，0 題有標註仍退回章節（至少要 1 題）', async () => {
        const deps = fakeDeps({ tagged: 0 });
        const out = await r.planRemedialPaper({ studentId: 5, subject: '數學', total: 10, mix: r.DEFAULT_MIX, days: 90, sourceTypes: null, minN: 0 }, deps);
        assert.equal(out.basis, 'chapter');
    });
});
