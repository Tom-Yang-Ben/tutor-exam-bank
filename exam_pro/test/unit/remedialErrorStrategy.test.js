// ─────────────────────────────────────────────────────────────
// test/unit/remedialErrorStrategy.test.js — 補救卷「依錯因出題」（〔dec/r16-remedial〕；docs/remedial.md 第 9 節）
//
// 四層：
//   1. config/remedialErrorStrategy.js 的對照表：每個錯因代碼都有一列、標籤與 config/errorTypes.js 相同、
//      預設策略照 Owner 審閱用的表（待 Owner 確認）。
//   2. 純函式：錯因統計、主因判斷（門檻、同票、不適用科目）、難度上限、偏好鍵、反應式偵測。
//   3. 選題順序：examController 的 preferenceOrderFn 交給真的 pickPaperUnits——偏好的題先抽、承上組與家族互斥照舊、
//      偏好永遠不讓題數變少、同鍵之間仍是隨機。
//   4. remedialService：buildPlan 套用主因（pool、fallbackPool、rankOf、error_focus、rationale）、沒標錯因時逐字不變、
//      buildTargets 的快照、planRemedialPaper 的退回難度上限（notes 與 blueprint）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// examController 在模組頂層 require config/db（缺 DATABASE_URL 會直接丟錯）；這裡只用純函式，不會連線
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';

const S = require('../../config/remedialErrorStrategy');
const { ERROR_TYPE_CODES, labelOf } = require('../../config/errorTypes');
const { pickPaperUnits } = require('../../utils/paperGroups');
const { shuffle } = require('../../utils/shuffle');
const r = require('../../services/remedialService');
const { _pickInternals: { preferenceOrderFn } } = require('../../controllers/examController');

/** 固定種子的 PRNG（mulberry32），讓「同鍵之間隨機」可重現。 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ───────────────────────── 1. 對照表 ─────────────────────────
describe('ERROR_STRATEGIES（預設，待 Owner 確認）', () => {
    test('每個錯因代碼都有一列，順序與標籤同 config/errorTypes.js', () => {
        assert.deepEqual(Object.keys(S.ERROR_STRATEGIES), [...ERROR_TYPE_CODES]);
        for (const code of ERROR_TYPE_CODES) {
            const s = S.ERROR_STRATEGIES[code];
            assert.equal(s.code, code);
            assert.equal(s.label, labelOf(code));
            assert.ok([0, -1].includes(s.difficulty_ceiling_delta), code);
            assert.ok(s.prefer_order === null || S.PREFER_ORDERS.includes(s.prefer_order), code);
            assert.ok(s.summary.length > 0 && s.rationale.length > 0, `${code} 要有給老師看的一句話`);
            assert.ok(Object.isFrozen(s));
        }
    });

    test('預設策略照審閱表', () => {
        const view = code => {
            const s = S.ERROR_STRATEGIES[code];
            return [s.difficulty_ceiling_delta, s.prefer_types ? [...s.prefer_types] : null, s.prefer_order];
        };
        assert.deepEqual(view('concept'), [-1, ['單選', '多選', '填空'], null]);
        assert.deepEqual(view('formula'), [-1, ['單選', '多選', '填空'], null]);
        assert.deepEqual(view('method'), [0, ['計算'], null]);
        for (const c of ['calc', 'unit', 'careless']) assert.deepEqual(view(c), [0, ['計算', '填空'], null], c);
        assert.deepEqual(view('reading'), [0, null, 'text_length_desc']);
        for (const c of ['blank', 'time']) assert.deepEqual(view(c), [-1, null, 'difficulty_asc'], c);
        assert.deepEqual(view('chem_equation'), [0, null, 'chem_equation']);
        assert.deepEqual(S.ERROR_STRATEGIES.chem_equation.subjects, ['化學']);
    });

    test('門檻是具名常數：至少 2 筆有標錯因的錯題、主因占 ≥ 40%', () => {
        assert.equal(S.MIN_TAGGED_WRONG, 2);
        assert.equal(S.MIN_DOMINANT_SHARE, 0.4);
    });
});

// ───────────────────────── 2. 純函式 ─────────────────────────
describe('errorProfileFromRows', () => {
    test('每個單位數錯題、有標錯因的錯題、每種錯因；同一筆重複的代碼只算一次；白名單外的代碼忽略', () => {
        const p = S.errorProfileFromRows([
            { unit: '向量內積', error_types: ['concept', 'calc'] },
            { unit: '向量內積', error_types: ['concept', 'concept'] },
            { unit: '向量內積', error_types: [] },
            { unit: '向量內積', error_types: ['not_a_code'] },
            { unit: '排列', error_types: null },
            { unit: 12, error_types: ['reading'] }
        ]);
        assert.deepEqual(p.get('向量內積'), { wrong: 4, tagged_wrong: 2, counts: { concept: 2, calc: 1 } });
        assert.deepEqual(p.get('排列'), { wrong: 1, tagged_wrong: 0, counts: {} });
        assert.deepEqual(p.get(12), { wrong: 1, tagged_wrong: 1, counts: { reading: 1 } });
        assert.equal(S.errorProfileFromRows([]).size, 0);
    });
});

describe('dominantErrorType', () => {
    const prof = (tagged, counts) => ({ wrong: tagged, tagged_wrong: tagged, counts });

    test('沒有任何錯因標記 → null（不提錯因）', () => {
        assert.equal(S.dominantErrorType(null, '數學'), null);
        assert.equal(S.dominantErrorType(undefined, '數學'), null);
        assert.equal(S.dominantErrorType({ wrong: 3, tagged_wrong: 0, counts: {} }, '數學'), null);
    });

    test('有標錯因的錯題只有 1 筆 → insufficient_evidence（不套用）', () => {
        const f = S.dominantErrorType(prof(1, { concept: 1 }), '數學');
        assert.deepEqual(f, { type: 'concept', label: '觀念不清', count: 1, share: 1, tagged_wrong: 1, applied: false, reason: 'insufficient_evidence' });
    });

    test('2 筆、同一個錯因 → 套用；share 的分母是全部錯因標記', () => {
        const f = S.dominantErrorType(prof(2, { concept: 2 }), '數學');
        assert.equal(f.applied, true);
        assert.equal(f.reason, 'dominant');
        assert.equal(f.share, 1);
        const g = S.dominantErrorType(prof(3, { calc: 3, careless: 1, unit: 1 }), '物理');
        assert.deepEqual([g.type, g.count, g.share, g.applied], ['calc', 3, 0.6, true]);
    });

    test('主因占比的邊界：剛好 40% 套用、低於 40% 不套用（no_dominant）', () => {
        const at = S.dominantErrorType(prof(5, { concept: 2, calc: 1, reading: 1, unit: 1 }), '數學');
        assert.deepEqual([at.type, at.share, at.applied], ['concept', 0.4, true]);
        const below = S.dominantErrorType(prof(7, { concept: 2, calc: 1, reading: 1, unit: 1, blank: 1, time: 1 }), '數學');
        assert.deepEqual([below.type, below.applied, below.reason], ['concept', false, 'no_dominant']);
    });

    test('第一名同票 → tie（不套用）；回報的 type 取白名單順序在前的', () => {
        const f = S.dominantErrorType(prof(4, { calc: 2, concept: 2 }), '數學');
        assert.deepEqual([f.type, f.applied, f.reason], ['concept', false, 'tie']);
    });

    test('chem_equation 只對化學：別科 not_applicable，化學套用', () => {
        const math = S.dominantErrorType(prof(3, { chem_equation: 3 }), '數學');
        assert.deepEqual([math.applied, math.reason], [false, 'not_applicable']);
        const chem = S.dominantErrorType(prof(3, { chem_equation: 3 }), '化學');
        assert.deepEqual([chem.applied, chem.reason, chem.label], [true, 'dominant', '化學式或係數']);
    });
});

describe('adjustedDifficultyMax、hasChemEquation、preferenceKey', () => {
    test('難度上限降一級，下限 1；不限（null）時不動；delta 0 不動', () => {
        const concept = S.ERROR_STRATEGIES.concept;
        assert.equal(S.adjustedDifficultyMax(4, concept), 3);
        assert.equal(S.adjustedDifficultyMax(1, concept), 1);
        assert.equal(S.adjustedDifficultyMax(null, concept), null);
        assert.equal(S.adjustedDifficultyMax(4, S.ERROR_STRATEGIES.calc), 4);
    });

    test('反應式：→、⟶、⇌、\\rightarrow、\\longrightarrow、\\xrightarrow、\\rightleftharpoons、\\ce{->}、「反應式」', () => {
        for (const t of ['$2H_2 + O_2 → 2H_2O$', 'A ⟶ B', 'N_2 + 3H_2 ⇌ 2NH_3', '$A \\rightarrow B$', '$A \\longrightarrow B$',
            '$A \\xrightarrow{\\Delta} B$', '$A \\rightleftharpoons B$', '\\ce{CH4 + 2O2 -> CO2 + 2H2O}', '寫出下列反應的反應式']) {
            assert.equal(S.hasChemEquation(t), true, t);
        }
        for (const t of ['求 $x$ 的值', '$f(x) = x^2$，$x \\to 0$', null, '']) assert.equal(S.hasChemEquation(t), false, String(t));
    });

    test('偏好鍵：題型在偏好裡排前；題幹長的先；簡單的先；有反應式的先', () => {
        const key = (code, q) => S.preferenceKey(S.ERROR_STRATEGIES[code], q);
        assert.deepEqual(key('concept', { question_type: '單選' }), [0, 0]);
        assert.deepEqual(key('concept', { question_type: '計算' }), [1, 0]);
        assert.deepEqual(key('method', { question_type: '計算' }), [0, 0]);
        assert.deepEqual(key('reading', { question_text: 'a b  c' }), [0, -3], '壓掉空白後的字數');
        assert.deepEqual(key('blank', { difficulty: 2 }), [0, 2]);
        assert.deepEqual(key('time', { difficulty: null }), [0, 3], '缺難度當 3');
        assert.deepEqual(key('chem_equation', { question_text: 'A → B' }), [0, 0]);
        assert.deepEqual(key('chem_equation', { question_text: '莫耳數' }), [0, 1]);
        assert.ok(S.compareKeys([0, -10], [0, -3]) < 0);
        assert.ok(S.compareKeys([1, -100], [0, 5]) > 0, '題型優先於順序');
        assert.equal(S.compareKeys([0, 1], [0, 1]), 0);
    });
});

// ───────────────────────── 3. 選題順序 ─────────────────────────
describe('偏好排序交給 pickPaperUnits（examController.preferenceOrderFn）', () => {
    /** 候選：id → [題型, 難度]；pref 是 concept（偏好單選／多選／填空）。 */
    function setup(spec, code = 'concept') {
        const rows = Object.entries(spec).map(([id, [type, difficulty, text = '']]) => ({
            id: Number(id), question_type: type, difficulty, question_text: text
        }));
        const strategy = S.ERROR_STRATEGIES[code];
        const keyOfId = new Map(rows.map(row => [row.id, S.preferenceKey(strategy, row)]));
        return { rows, keyOfId };
    }
    const cands = (ids, extra = {}) => ids.map(id => ({ id, variant_of: null, follows_question_id: null, ...(extra[id] || {}) }));

    test('偏好的題型先抽滿；不夠時才抽別的（不會因偏好少出題）', () => {
        const { keyOfId } = setup({ 1: ['計算', 3], 2: ['單選', 2], 3: ['計算', 3], 4: ['填空', 2], 5: ['計算', 3], 6: ['多選', 2] });
        for (let seed = 1; seed <= 20; seed++) {
            const sf = preferenceOrderFn(keyOfId, items => shuffle(items, mulberry32(seed)));
            const two = pickPaperUnits({ candidates: cands([1, 2, 3, 4, 5, 6]), limitCount: 3, shuffleFn: sf });
            assert.deepEqual([...two.ids].sort((a, b) => a - b), [2, 4, 6], `seed ${seed}：3 題剛好是三題觀念檢查題`);
            const five = pickPaperUnits({ candidates: cands([1, 2, 3, 4, 5, 6]), limitCount: 5, shuffleFn: sf });
            assert.equal(five.actual, 5, '偏好不影響題數');
            assert.ok([2, 4, 6].every(id => five.ids.includes(id)));
        }
    });

    test('同鍵之間仍是隨機：不同種子抽到不同的「計算」題', () => {
        const { keyOfId } = setup({ 1: ['計算', 3], 2: ['單選', 2], 3: ['計算', 3], 5: ['計算', 3], 7: ['計算', 3] });
        const seen = new Set();
        for (let seed = 1; seed <= 40; seed++) {
            const sf = preferenceOrderFn(keyOfId, items => shuffle(items, mulberry32(seed)));
            const out = pickPaperUnits({ candidates: cands([1, 2, 3, 5, 7]), limitCount: 2, shuffleFn: sf });
            assert.ok(out.ids.includes(2));
            seen.add(out.ids.find(id => id !== 2));
        }
        assert.ok(seen.size >= 3, `剩下一題應該在四題計算題之間隨機（看到 ${[...seen].join(',')}）`);
    });

    test('承上組整組抽，組的偏好鍵取組內最好的一題；家族互斥照舊', () => {
        // 10 ← 11（計算＋單選，組內最好的是單選）；20（計算）；30、31 同家族（都是填空）
        const { keyOfId } = setup({ 10: ['計算', 3], 11: ['單選', 3], 20: ['計算', 3], 30: ['填空', 2], 31: ['填空', 2] });
        const c = cands([10, 11, 20, 30, 31], { 11: { follows_question_id: 10 }, 31: { variant_of: 30 } });
        for (let seed = 1; seed <= 10; seed++) {
            const sf = preferenceOrderFn(keyOfId, items => shuffle(items, mulberry32(seed)));
            const out = pickPaperUnits({ candidates: c, related: [{ id: 11, follows_question_id: 10 }], limitCount: 3, shuffleFn: sf });
            assert.equal(out.actual, 3);
            assert.ok(out.ids.includes(10) && out.ids.includes(11), '承上組（有單選）優先、整組');
            assert.equal(out.ids.filter(id => id === 30 || id === 31).length, 1, '同家族至多一題');
            assert.ok(!out.ids.includes(20), '計算單題排最後');
        }
    });

    test('題幹長的先（reading）、簡單的先（blank）', () => {
        const long = setup({ 1: ['計算', 3, '短'], 2: ['計算', 3, '這是一個比較長的題幹，條件很多'], 3: ['計算', 3, '中等長度的題幹'] }, 'reading');
        const sf = preferenceOrderFn(long.keyOfId, items => shuffle(items, mulberry32(7)));
        assert.deepEqual(pickPaperUnits({ candidates: cands([1, 2, 3]), limitCount: 2, shuffleFn: sf }).ids.sort(), [2, 3]);
        const easy = setup({ 1: ['計算', 3], 2: ['計算', 1], 3: ['計算', 2] }, 'blank');
        const sf2 = preferenceOrderFn(easy.keyOfId, items => shuffle(items, mulberry32(7)));
        assert.deepEqual(pickPaperUnits({ candidates: cands([1, 2, 3]), limitCount: 2, shuffleFn: sf2 }).ids.sort(), [2, 3]);
    });
});

// ───────────────────────── 4. remedialService ─────────────────────────
describe('buildPlan × 錯因主因', () => {
    const ranked = [
        { chapter: '向量內積', name: '向量內積', graded: 6, correct: 1, mastery_lb: 0.03, low_sample: false, avg_wrong_difficulty: 3, avg_graded_difficulty: 3 },
        { chapter: '排列', name: '排列', graded: 6, correct: 6, mastery_lb: 0.6, low_sample: false, avg_wrong_difficulty: null, avg_graded_difficulty: 3 }
    ];
    const base = { basis: 'chapter', total: 10, mix: r.DEFAULT_MIX, ranked, subject: '數學' };
    const profiles = entries => new Map(entries);

    test('沒有錯因統計（或沒標）：pool、rationale 與之前相同，error_focus 為 null；延伸組沒有 error_focus', () => {
        const plain = r.buildPlan(base);
        const untagged = r.buildPlan({ ...base, errorProfiles: profiles([['向量內積', { wrong: 5, tagged_wrong: 0, counts: {} }]]) });
        for (const plan of [plain, untagged]) {
            const rem = plan.quotas[0];
            assert.deepEqual(rem.pool, { chapters: ['向量內積'], difficultyMax: 4 });
            assert.equal(rem.rationale, '掌握度下界 3%（批改 6 題、答對 1）；選難度 ≤ 4 的題');
            assert.equal(rem.error_focus, null);
            assert.ok(!('rankOf' in rem) && !('fallbackPool' in rem));
            assert.ok(!('error_focus' in plan.quotas.find(q => q.bucket === 'extension')));
        }
    });

    test('主因「觀念不清」：難度上限 4 → 3（fallbackPool 留原本的 4）、rankOf 偏好單選、rationale 說明', () => {
        const plan = r.buildPlan({ ...base, errorProfiles: profiles([['向量內積', { wrong: 5, tagged_wrong: 4, counts: { concept: 3, calc: 1 } }]]) });
        const rem = plan.quotas[0];
        assert.deepEqual(rem.pool, { chapters: ['向量內積'], difficultyMax: 3 });
        assert.deepEqual(rem.fallbackPool, { chapters: ['向量內積'], difficultyMax: 4 });
        assert.equal(rem.difficulty_max, 3);
        assert.equal(rem.original_difficulty_max, 4);
        assert.deepEqual(rem.rankOf({ question_type: '單選' }), [0, 0]);
        assert.deepEqual(rem.rankOf({ question_type: '計算' }), [1, 0]);
        assert.deepEqual(rem.error_focus, {
            type: 'concept', label: '觀念不清', count: 3, share: 0.75, tagged_wrong: 4,
            strategy: S.strategyView(S.ERROR_STRATEGIES.concept), applied: true, reason: 'dominant'
        });
        assert.match(rem.rationale, /^掌握度下界 3%（批改 6 題、答對 1）；錯因以「觀念不清」為主（有標錯因的錯題 4 題，標了 3 次，占 75%）→ 難度上限降一級，優先單選／多選／填空；選難度 ≤ 3 的題$/);
        assert.match(rem.fallback_rationale, /難度 ≤ 3 的題不夠，改選難度 ≤ 4 的題$/);
    });

    test('主因「計算錯誤」：難度不變（沒有 fallbackPool），只有偏好', () => {
        const rem = r.buildPlan({ ...base, errorProfiles: profiles([['向量內積', { wrong: 3, tagged_wrong: 3, counts: { calc: 3 } }]]) }).quotas[0];
        assert.deepEqual(rem.pool, { chapters: ['向量內積'], difficultyMax: 4 });
        assert.ok(!('fallbackPool' in rem));
        assert.equal(typeof rem.rankOf, 'function');
        assert.equal(rem.error_focus.applied, true);
    });

    test('證據不夠：不調整，rationale 說「選題不依錯因調整」，error_focus.applied = false、strategy = null', () => {
        const rem = r.buildPlan({ ...base, errorProfiles: profiles([['向量內積', { wrong: 3, tagged_wrong: 1, counts: { concept: 1 } }]]) }).quotas[0];
        assert.deepEqual(rem.pool, { chapters: ['向量內積'], difficultyMax: 4 });
        assert.ok(!('rankOf' in rem) && !('fallbackPool' in rem));
        assert.deepEqual([rem.error_focus.applied, rem.error_focus.reason, rem.error_focus.strategy], [false, 'insufficient_evidence', null]);
        assert.match(rem.rationale, /有標錯因的錯題只有 1 題，還看不出主因，選題不依錯因調整；選難度 ≤ 4 的題$/);
    });

    test('每段帶快照用的 unit、baseline（答錯＝批改 − 答對，部分給分按比例）', () => {
        const plan = r.buildPlan(base);
        assert.deepEqual(plan.quotas.map(q => [q.bucket, q.unit, q.baseline]), [
            ['remedial', { unit_type: 'chapter', subject: '數學', chapter: '向量內積' }, { graded: 6, wrong: 5, wrong_rate: 0.8333, low_sample: false }],
            ['extension', { unit_type: 'chapter', subject: '數學', chapter: '排列' }, { graded: 6, wrong: 0, wrong_rate: 0, low_sample: false }]
        ]);
        assert.deepEqual(r.baselineOf(undefined), { graded: 0, wrong: 0, wrong_rate: null, low_sample: true });
        assert.deepEqual(r.baselineOf({ graded: 1.5, correct: 1.25, low_sample: true }), { graded: 1.5, wrong: 0.25, wrong_rate: 0.1667, low_sample: true });
    });

    test('kc 基底：單位鍵是 kc_id，快照帶 kc_id；先備知識點沒有作答時 baseline 為 0／null', () => {
        const kcRanked = [
            { kc_id: 1, code: 'MATH.向量內積.01', name: '內積', chapter: '向量內積', graded: 5, correct: 1, mastery_lb: 0.03, low_sample: false, avg_wrong_difficulty: 2, avg_graded_difficulty: 2 }
        ];
        const plan = r.buildPlan({
            basis: 'kc', total: 5, mix: r.DEFAULT_MIX, ranked: kcRanked, subject: '數學',
            prereqRows: [{ kc_id: 1, prereq_kc_id: 9, code: 'MATH.向量的加減與係數積.01', name: '坐標', subject: '數學', chapter: '向量的加減與係數積', strength: 1 }],
            errorProfiles: new Map([[1, { wrong: 4, tagged_wrong: 2, counts: { method: 2 } }]])
        });
        const rem = plan.quotas.find(q => q.bucket === 'remedial');
        assert.deepEqual(rem.unit, { unit_type: 'kc', subject: '數學', chapter: '向量內積', kc_id: 1 });
        assert.equal(rem.error_focus.type, 'method');
        const pre = plan.quotas.find(q => q.bucket === 'prerequisite');
        assert.deepEqual([pre.unit, pre.baseline], [
            { unit_type: 'kc', subject: '數學', chapter: '向量的加減與係數積', kc_id: 9 },
            { graded: 0, wrong: 0, wrong_rate: null, low_sample: true }
        ]);
    });

    test('buildTargets：每段一列、只有補救組帶 error_focus 摘要；不在白名單的章節略過並回報', () => {
        const plan = r.buildPlan({ ...base, errorProfiles: profiles([['向量內積', { wrong: 5, tagged_wrong: 4, counts: { concept: 3, calc: 1 } }]]) });
        const { targets, skipped } = r.buildTargets(plan.quotas);
        assert.deepEqual(skipped, []);
        assert.deepEqual(targets, [
            { unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial',
                baseline: { graded: 6, wrong: 5, wrong_rate: 0.8333, low_sample: false },
                error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } },
            { unit_type: 'chapter', subject: '數學', chapter: '排列', bucket: 'extension',
                baseline: { graded: 6, wrong: 0, wrong_rate: 0, low_sample: false } }
        ]);
        const legacy = r.buildPlan({ ...base, ranked: [{ ...ranked[0], chapter: '舊章名', name: '舊章名' }, ranked[1]] });
        const out = r.buildTargets(legacy.quotas);
        assert.deepEqual(out.skipped, ['舊章名']);
        assert.deepEqual(out.targets.map(t => t.chapter), ['排列']);
    });

    test('錯因查詢：$1 studentId、$2 days、$3 subject、$4 單位鍵；只讀檢視 attempts（R10）、答錯或部分給分', () => {
        const ch = r.buildErrorProfileQuery({ basis: 'chapter', studentId: 3, days: 90, subject: '數學', keys: ['向量內積'] });
        assert.deepEqual(ch.values, [3, 90, '數學', ['向量內積']]);
        assert.match(ch.text, /FROM attempts a JOIN questions q/);
        assert.match(ch.text, /COALESCE\(a\.score::float8, a\.result::float8\) < 1/);
        assert.match(ch.text, /q\.chapter = ANY\(\$4::text\[\]\)/);
        assert.ok(!/assignment_attempts|assignments/.test(ch.text), '不讀含重練的表');
        const kc = r.buildErrorProfileQuery({ basis: 'kc', studentId: 3, days: 90, subject: '數學', keys: [1, 2] });
        assert.match(kc.text, /qk\.kc_id = ANY\(\$4::int\[\]\)/);
        assert.match(kc.text, /kx\.subject = q\.subject/, '只算同科標註（S5-42）');
    });
});

describe('planRemedialPaper × 錯因（注入假依賴）', () => {
    function deps({ usedFallback, errorRows }) {
        const seen = {};
        return {
            seen,
            async query(text, values) {
                if (/tagged_graded/.test(text)) return { rows: [{ tagged_graded: 0, untagged_graded: 6 }] };
                if (/question_kcs qk ON qk\.question_id = w\.question_id/.test(text)) return { rows: [] };
                if (/AS unit, a\.error_types/.test(text)) { seen.errorQuery = values; return { rows: errorRows }; }
                if (/GROUP BY q\.chapter/.test(text)) {
                    return { rows: [{ chapter: '向量內積', graded: 6, correct: 1, avg_wrong_difficulty: 3, avg_graded_difficulty: 3 }] };
                }
                if (/FROM questions WHERE id = ANY/.test(text)) {
                    return { rows: values[0].map(id => ({ id, question_text: `題 ${id}`, question_type: '單選', difficulty: 3, chapter: '向量內積', follows_question_id: null })) };
                }
                throw new Error(`沒預期的查詢：${text.slice(0, 60)}`);
            },
            async pickByQuotas({ quotas }) {
                seen.quotas = quotas;
                return quotas.map(q => ({ ids: [1, 2, 3, 4, 5].slice(0, q.count), got: Math.min(5, q.count), availableCount: 5, unitSizes: [],
                    ...(q.fallbackPool ? { usedFallback } : {}) }));
            },
            sortForPaper: rows => rows,
            shortfallReason: () => 'insufficient_stock'
        };
    }
    const run = d => r.planRemedialPaper({ studentId: 5, subject: '數學', total: 5, mix: { remedial: 1, prerequisite: 0, extension: 0 }, days: 90, sourceTypes: null, minN: 5 }, d);
    const conceptRows = [
        { unit: '向量內積', error_types: ['concept'] }, { unit: '向量內積', error_types: ['concept'] },
        { unit: '向量內積', error_types: ['concept', 'calc'] }, { unit: '向量內積', error_types: [] }
    ];

    test('主因套用：pickByQuotas 收到 rankOf 與 fallbackPool；blueprint 的 error_focus；targets 快照', async () => {
        const d = deps({ usedFallback: false, errorRows: conceptRows });
        const out = await run(d);
        assert.deepEqual(d.seen.errorQuery, [5, 90, '數學', ['向量內積']]);
        const q = d.seen.quotas[0];
        assert.deepEqual(q.pool, { chapters: ['向量內積'], difficultyMax: 3 });
        assert.deepEqual(q.fallbackPool, { chapters: ['向量內積'], difficultyMax: 4 });
        assert.equal(typeof q.rankOf, 'function');
        const b = out.blueprint[0];
        assert.equal(b.difficulty_max, 3);
        assert.deepEqual([b.error_focus.type, b.error_focus.count, b.error_focus.share, b.error_focus.tagged_wrong, b.error_focus.reason],
            ['concept', 3, 0.75, 3, 'dominant']);
        assert.deepEqual(out.targets, [{ unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial',
            baseline: { graded: 6, wrong: 5, wrong_rate: 0.8333, low_sample: false },
            error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } }]);
        assert.ok(!out.notes.some(n => n.includes('改回難度')));
    });

    test('降難度抽不滿而退回：blueprint 回報原本的上限、reason 改成 dominant_difficulty_fallback、notes 說明', async () => {
        const out = await run(deps({ usedFallback: true, errorRows: conceptRows }));
        const b = out.blueprint[0];
        assert.equal(b.difficulty_max, 4);
        assert.equal(b.error_focus.reason, 'dominant_difficulty_fallback');
        assert.equal(b.error_focus.applied, true);
        assert.match(b.rationale, /難度 ≤ 3 的題不夠，改選難度 ≤ 4 的題$/);
        assert.ok(out.notes.some(n => n === '「向量內積」錯因以「觀念不清」為主，原本只選難度 ≤ 3 的題，但湊不到 5 題，已改回難度 ≤ 4（題型偏好照舊）。'), out.notes.join('\n'));
    });

    test('沒有錯因標記：pickByQuotas 收到的與之前相同（只有 count、pool），blueprint 的 error_focus 為 null', async () => {
        const d = deps({ usedFallback: false, errorRows: [{ unit: '向量內積', error_types: [] }] });
        const out = await run(d);
        assert.deepEqual(d.seen.quotas, [{ count: 5, pool: { chapters: ['向量內積'], difficultyMax: 4 } }]);
        assert.equal(out.blueprint[0].error_focus, null);
        assert.equal(out.blueprint[0].rationale, '掌握度下界 3%（批改 6 題、答對 1）；選難度 ≤ 4 的題');
        assert.ok(!('error_focus' in out.targets[0]));
    });
});
