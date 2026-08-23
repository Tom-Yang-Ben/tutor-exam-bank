// eval/lib/suiteNlq.js 的純粹部分（docs/interfaces-stage3.md 第 8.1／8.2 條）
//
// 這一支**不連 DB、不連 Gemini**：只驗 golden 的硬閘門與四欄比對。
// 真正要灌 fixture、跑 hybrid 的 Recall@10 只在 `eval:nlq` 與 integration 測得到。
//
// 為什麼把「golden 載得起來」放進 npm test：golden 是純檔案，沒有 DB 的 CHECK 幫忙擋。
// 一個手滑改錯的章節名只會讓那一句永遠算錯，卻不會有任何錯誤訊息——
// 症狀是 filters_exact 少了 1/50，看起來像解析退步，其實是標註爛掉。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const suite = require('../../eval/lib/suiteNlq');
const { loadFixture } = require('../../eval/lib/fixtures');

describe('eval/golden/nlq.json 的硬閘門', () => {
    test('載得起來，50 句，六類涵蓋面都有', () => {
        const fixture = loadFixture();
        const golden = suite.loadNlqGolden({ fixtureById: fixture.byId });
        assert.equal(golden.entries.length, 50);
        assert.equal(golden.version, 1);
        // 第 8.2 條：rules 欄與 llm 欄都要有樣本，不然那一欄永遠是 n/a
        assert.ok(golden.entries.filter(e => e.expect_path === 'rules').length >= 30);
        assert.ok(golden.entries.filter(e => e.expect_path === 'llm').length >= 5);
    });

    test('每一句都有非空的 relevant，且都指到 fixture 裡真的存在的題', () => {
        const fixture = loadFixture();
        const golden = suite.loadNlqGolden({ fixtureById: fixture.byId });
        for (const e of golden.entries) {
            assert.ok(e.relevant.length > 0, `${e.id} 沒有正樣本`);
            for (const id of e.relevant) assert.ok(fixture.byId.has(id), `${e.id} 的 relevant ${id} 不存在`);
        }
    });

    test('needs_human_confirm 的筆數會被回報（定案前不得 --write-baseline）', () => {
        const golden = suite.loadNlqGolden();
        assert.equal(typeof golden.pendingConfirm, 'number');
    });

    test('validateNlqGolden 真的抓得到違規', () => {
        const bad = (entry) => suite.validateNlqGolden([entry], null);
        const ok = {
            id: 'x-1', query: '向量內積',
            expect: {
                subject: '數學', chapters: ['向量內積'], question_types: [],
                difficulty_min: null, difficulty_max: null, exclude_student_name: null, semantic_text: '向量內積'
            },
            expect_path: 'rules', relevant: [9], needs_human_confirm: false
        };
        assert.deepEqual(bad(ok), []);

        // 章節不在白名單
        assert.ok(bad({ ...ok, expect: { ...ok.expect, chapters: ['不存在的章'] } }).some(p => p.includes('白名單')));
        // 跨科錯配
        assert.ok(bad({ ...ok, expect: { ...ok.expect, subject: '物理' } }).some(p => p.includes('白名單')));
        // expect_path 只能是兩個值
        assert.ok(bad({ ...ok, expect_path: 'both' }).some(p => p.includes('expect_path')));
        // relevant 不可為空
        assert.ok(bad({ ...ok, relevant: [] }).some(p => p.includes('relevant')));
        // 難度顛倒
        assert.ok(bad({ ...ok, expect: { ...ok.expect, difficulty_min: 4, difficulty_max: 2 } }).some(p => p.includes('difficulty_min')));
        // 章節超過 3 個（第 6.4 條會截斷，永遠對不上）
        assert.ok(bad({
            ...ok,
            expect: { ...ok.expect, chapters: ['向量內積', '空間向量內積', '外積', '平面方程式'] }
        }).some(p => p.includes('超過 3 個')));
        // query 超過 200 字
        assert.ok(bad({ ...ok, query: '向'.repeat(201) }).some(p => p.includes('200 字')));
    });

    test('id 不得重複', () => {
        const one = { id: 'dup', query: 'x', expect_path: 'rules', relevant: [1], needs_human_confirm: false,
            expect: { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, semantic_text: '' } };
        assert.ok(suite.validateNlqGolden([one, { ...one }], null).some(p => p.includes('重複')));
    });
});

describe('filtersExact：四欄 exact match（陣列先排序再比）', () => {
    const base = {
        subject: '數學', chapters: ['向量內積'], question_types: ['計算'],
        difficulty_min: 3, difficulty_max: 4
    };

    test('四欄全對才算對', () => {
        assert.equal(suite.filtersExact(base, { ...base }).ok, true);
    });

    test('陣列的語序不影響結果', () => {
        const a = { ...base, chapters: ['向量內積', '外積'], question_types: ['計算', '單選'] };
        const b = { ...base, chapters: ['外積', '向量內積'], question_types: ['單選', '計算'] };
        assert.equal(suite.filtersExact(a, b).ok, true);
    });

    test('任一欄不同就算錯，且 diff 指得出是哪一欄', () => {
        assert.deepEqual(suite.filtersExact(base, { ...base, subject: '物理' }).ok, false);
        assert.ok(suite.filtersExact(base, { ...base, subject: '物理' }).diff[0].startsWith('subject'));
        assert.ok(suite.filtersExact(base, { ...base, chapters: [] }).diff[0].startsWith('chapters'));
        assert.ok(suite.filtersExact(base, { ...base, question_types: [] }).diff[0].startsWith('question_types'));
        assert.ok(suite.filtersExact(base, { ...base, difficulty_max: 5 }).diff[0].startsWith('difficulty'));
    });

    test('semantic_text 與 keywords 不算在四欄裡', () => {
        assert.equal(suite.filtersExact(base, { ...base, semantic_text: '完全不同', keywords: ['x'] }).ok, true);
    });

    test('null 與 [] 不視為相等（沒抓到難度 ≠ 抓到 1~5）', () => {
        assert.equal(suite.filtersExact(
            { ...base, difficulty_min: null, difficulty_max: null },
            { ...base, difficulty_min: 1, difficulty_max: 5 }
        ).ok, false);
    });
});

describe('runNlqSuite 的匯出形狀（第 8.1 條）', () => {
    test('匯出 runSuite 形狀的函式', () => {
        assert.equal(typeof suite.runNlqSuite, 'function');
    });
});
