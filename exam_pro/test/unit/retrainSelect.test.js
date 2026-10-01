// ─────────────────────────────────────────────────────────────
// test/unit/retrainSelect.test.js — 出卷時挑到期的重練題（〔retrain PR-3〕docs/retrain-and-review.md 第 4.7、5.2 節；
// 第 6.3 節 TC-039-1）
//
// services/retrainSelect.js 的純函式：到期挑選、排序、上限、承上組不拆且整組放不下時報錯與訊息（R12 選 2）、
// 封存排除、重練題不佔家族名額（R8 選 1）、合併排序（R7 選 1）、純重練卷卷名、草稿附註。
// 不碰 DB、不呼叫 LLM；I/O（selectRetrain、buildRetrainDraft、appendRetrainBucket）由 test/integration/retrainPaper.pg.test.js 驗。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sel = require('../../services/retrainSelect');
const retrainService = require('../../services/retrainService');
const { capForAttach } = require('../../services/retrainSchedule');
const { sortForPaperGrouped } = require('../../utils/paperGroups');

const asOf = '2026-10-12';

/**
 * API-1 一筆的畫面資料（只填挑選用得到的欄位）。
 * @param {number} qid
 * @param {object} [o]
 */
function view(qid, o = {}) {
    const status = o.status || 'active';
    const inFlight = Boolean(o.in_flight);
    const archived = Boolean(o.archived);
    const dueOn = status === 'active' ? (o.due_on || asOf) : null;
    const due = status === 'active' && !inFlight && !archived && dueOn <= asOf;
    return {
        item_id: 1000 + qid, question_id: qid, status, step: o.step || 1, step_label: '錯題重練', lapses: o.lapses || 0,
        due_on: dueOn, due, overdue_days: due ? Math.round((Date.parse(asOf) - Date.parse(dueOn)) / 86400000) : 0,
        in_flight: inFlight, archived, group_ids: o.group_ids || [qid], follows_question_id: o.follows ?? null,
        chapter: '向量內積', difficulty: 3, question_text_preview: `題 ${qid}`
    };
}

/** listDueUnits 的 units 形狀。 */
const unit = (ids, dueCount = ids.length) => ({ group_ids: ids, size: ids.length, due_count: dueCount, overdue_days: 0, items: ids.map(id => ({ question_id: id })) });

describe('pickUnits：依排序逐組放入（第 4.7 節；R12 選 2）', () => {
    test('依給定順序放、數量不超過上限；剛好放滿就停（沒挑到的留在清單，不報錯）', () => {
        const units = [unit([5]), unit([3]), unit([9]), unit([1])];
        assert.deepEqual(sel.pickUnits(units, 2), { picked: units.slice(0, 2), ids: [5, 3], got: 2 });
        assert.deepEqual(sel.pickUnits(units, 10).ids, [5, 3, 9, 1]);
        assert.deepEqual(sel.pickUnits(units, 0), { picked: [], ids: [], got: 0 });
        assert.deepEqual(sel.pickUnits([], 5), { picked: [], ids: [], got: 0 });
        // 剛好放滿：後面的承上組就算放不下也不報錯
        assert.deepEqual(sel.pickUnits([unit([5]), unit([7, 8, 9])], 1).ids, [5]);
    });

    test('承上組不拆開：放得下整組才放；組內依承接順序', () => {
        const units = [unit([11, 12]), unit([5]), unit([20, 21, 22])];
        assert.deepEqual(sel.pickUnits(units, 6).ids, [11, 12, 5, 20, 21, 22]);
        assert.deepEqual(sel.pickUnits(units, 3).ids, [11, 12, 5]);
    });

    test('R12：剩下的名額不夠整組 → error（訊息列出那一組、提示「放到前一組為止」或「含這一組」的題數）', () => {
        const units = [unit([1]), unit([2]), unit([3]), unit([4]), unit([5]), unit([812, 813, 814])];
        const r = sel.pickUnits(units, 6);
        assert.deepEqual(r, {
            error: {
                message: '到期的承上題組（題 812、813、814）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 5 或 8。',
                group_ids: [812, 813, 814], remaining: 1, suggest: [5, 8]
            }
        });
        // 第一組就放不下：「放到前一組為止」是 0，不列
        assert.equal(sel.pickUnits([unit([7, 8])], 1).error.message,
            '到期的承上題組（題 7、8）共 2 題，放不進剩下的 1 個重練名額；請把重練題數改成 2。');
        // 「含這一組」超過上限（新題＋重練 ≤ 50）時不列；兩個都不能用 → 請調整
        assert.deepEqual(sel.pickUnits([unit([1]), unit([7, 8, 9])], 2, { maxCount: 3 }).error.suggest, [1]);
        assert.equal(sel.pickUnits([unit([7, 8, 9])], 2, { maxCount: 2 }).error.message,
            '到期的承上題組（題 7、8、9）共 3 題，放不進剩下的 2 個重練名額；請調整重練題數。');
    });

    test('excludeIds：含其中任一題的組整組略過（預覽上移除的重練題），不報錯、不佔名額', () => {
        const units = [unit([1]), unit([7, 8, 9]), unit([2])];
        assert.deepEqual(sel.pickUnits(units, 2, { excludeIds: [8] }).ids, [1, 2]);
        assert.deepEqual(sel.pickUnits(units, 1, { excludeIds: [1] }).error.group_ids, [7, 8, 9]);
        assert.deepEqual(sel.pickUnits(units, 5, { excludeIds: [1, 2, 99] }).ids, [7, 8, 9]);
    });

    test('上限：放入的題數永遠不超過要求的題數（前端預先帶入 capForAttach(新題數)）', () => {
        const units = [unit([1]), unit([2, 3]), unit([4]), unit([5, 6, 7]), unit([8])];
        for (let count = 0; count <= 10; count++) {
            const r = sel.pickUnits(units, count);
            if (r.error) continue;
            assert.ok(r.got <= count, `count=${count}`);
            assert.equal(r.got, r.ids.length);
        }
        // 預設上限就是 capForAttach(新題數)：新題 20 題 → 6 題、7 題 → 2 題、新題 45 題 → 5 題（合計 ≤ 50）
        assert.deepEqual([20, 7, 3, 45].map(n => capForAttach(n)), [6, 2, 0, 5]);
    });
});

describe('r12Message', () => {
    test('第 4.7 節的例子逐字', () => {
        assert.deepEqual(sel.r12Message({ groupIds: [812, 813, 814], placed: 5, remaining: 1, maxCount: 50 }), {
            message: '到期的承上題組（題 812、813、814）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 5 或 8。',
            suggest: [5, 8]
        });
    });
});

describe('unitsFromViews：到期的單位（與 retrainService.listDueUnits 同一條規則）', () => {
    test('只有到期的組才列入；依第 4.7 節排序（逾期多的先 → 關卡小的先 → 錯次數多的先 → 題號小的先）', () => {
        const views = [
            view(10, { due_on: '2026-10-10' }),                 // 逾期 2 天
            view(11, { due_on: '2026-10-05' }),                 // 逾期 7 天
            view(12, { due_on: '2026-10-10', step: 2 }),        // 逾期 2 天、第 2 關
            view(13, { due_on: '2026-10-10', lapses: 2 }),      // 逾期 2 天、錯 2 次
            view(14, { due_on: '2026-10-20' }),                 // 還沒到期
            view(15, { status: 'mastered' })
        ];
        const r = sel.unitsFromViews(views);
        assert.deepEqual(r.units.map(u => u.group_ids), [[11], [13], [10], [12]]);
        assert.equal(r.due_total, 4);
        assert.deepEqual(r.blocked, []);
        assert.deepEqual(r.units[0], { group_ids: [11], size: 1, due_count: 1, overdue_days: 7, items: [views[1]] });
    });

    test('承上組：組內任一題到期就整組列入；已練到會的組員照樣帶著出；依組內最急的一題排序', () => {
        const g = [20, 21, 22];
        const views = [
            view(20, { group_ids: g, due_on: '2026-10-20' }),
            view(21, { group_ids: g, due_on: '2026-10-01', follows: 20 }),
            view(22, { group_ids: g, status: 'mastered', follows: 21 }),
            view(5, { due_on: '2026-10-11' })
        ];
        const r = sel.unitsFromViews(views);
        assert.deepEqual(r.units.map(u => [u.group_ids, u.size, u.due_count, u.overdue_days]), [[g, 3, 1, 11], [[5], 1, 1, 1]]);
        assert.deepEqual(r.units[0].items.map(v => v.question_id), g, '組內依承接順序');
    });

    test('整組不能出 → blocked（封存、移出、已派出、組員不在清單）；封存的題不會被挑到', () => {
        const g1 = [30, 31];
        const g2 = [40, 41];
        const g3 = [50, 51];
        const g4 = [60, 61];
        const views = [
            view(30, { group_ids: g1, due_on: '2026-10-01' }), view(31, { group_ids: g1, archived: true }),
            view(40, { group_ids: g2, due_on: '2026-10-01' }), view(41, { group_ids: g2, status: 'retired' }),
            view(50, { group_ids: g3, due_on: '2026-10-01' }), view(51, { group_ids: g3, in_flight: true }),
            view(60, { group_ids: g4, due_on: '2026-10-01' }),                          // 61 沒有項目
            view(70, { archived: true, due_on: '2026-10-01' })                          // 自己封存：不算到期
        ];
        const r = sel.unitsFromViews(views);
        assert.deepEqual(r.units, []);
        assert.deepEqual(r.blocked, [
            { group_ids: g1, reasons: [{ question_id: 31, reason: 'archived' }] },
            { group_ids: g2, reasons: [{ question_id: 41, reason: 'retired' }] },
            { group_ids: g3, reasons: [{ question_id: 51, reason: 'in_flight' }] },
            { group_ids: g4, reasons: [{ question_id: 61, reason: 'not_in_schedule' }] }
        ]);
        assert.equal(r.due_total, 4, '到期題數照算（blocked 的也算），封存的 70 不算');
    });

    test('includeNotDue（API-5）：還沒到期、進行中、沒派出、沒封存的也列入，排在到期的後面', () => {
        const views = [
            view(1, { due_on: '2026-10-30' }),
            view(2, { due_on: '2026-10-01' }),
            view(3, { due_on: '2026-10-20' }),
            view(4, { status: 'mastered' }),
            view(5, { due_on: '2026-10-15', in_flight: true })
        ];
        assert.deepEqual(sel.unitsFromViews(views).units.map(u => u.group_ids[0]), [2]);
        const r = sel.unitsFromViews(views, { includeNotDue: true });
        assert.deepEqual(r.units.map(u => [u.group_ids[0], u.due_count, u.overdue_days]), [[2, 1, 11], [3, 0, 0], [1, 0, 0]]);
        assert.equal(r.due_total, 1);
    });

    test('排序用的就是 PR-2 的 orderUnits（同一個函式，不另寫一套）', () => {
        const views = [view(3, { due_on: '2026-10-11' }), view(1, { due_on: '2026-10-11' }), view(2, { due_on: '2026-10-02' })];
        assert.deepEqual(sel.unitsFromViews(views).units.map(u => u.group_ids),
            retrainService.orderUnits(views).map(u => u.group_ids));
    });
});

describe('mergeForPaper：新題與重練題合併成一張卷（R7 選 1、R8 選 1）', () => {
    const q = (id, type, difficulty, extra = {}) => ({ id, question_type: type, difficulty, follows_question_id: null, ...extra });

    test('每題多 purpose、retrain_step；用 sortForPaper 一起依題型、難度排（卷面不另分區）', () => {
        const merged = sel.mergeForPaper(
            [q(1, '計算', 2), q(2, '單選', 3)],
            [q(9, '單選', 1), q(8, '計算', 5)],
            new Map([[9, 2], [8, 1]]));
        assert.deepEqual(merged.map(x => [x.id, x.purpose, x.retrain_step]),
            [[9, 'retrain', 2], [2, 'new', null], [1, 'new', null], [8, 'retrain', 1]]);
        assert.deepEqual(merged.map(x => x.id), sortForPaperGrouped(merged).map(x => x.id));
    });

    test('承上組相鄰、依承接順序；同分時新題在前', () => {
        const merged = sel.mergeForPaper(
            [q(1, '計算', 3)],
            [q(21, '計算', 3, { follows_question_id: 20 }), q(20, '計算', 3)],
            new Map([[20, 1], [21, 1]]));
        assert.deepEqual(merged.map(x => x.id), [1, 20, 21]);
    });

    test('R8：不看變式家族——同家族的新變式與重練題同卷，兩題都留著', () => {
        const merged = sel.mergeForPaper([q(2, '計算', 3, { variant_of: 1 })], [q(1, '計算', 3)], new Map([[1, 1]]));
        assert.deepEqual(merged.map(x => [x.id, x.purpose]), [[2, 'new'], [1, 'retrain']]);
    });

    test('不改動輸入', () => {
        const a = [q(1, '計算', 3)];
        const b = [q(2, '計算', 3)];
        sel.mergeForPaper(a, b, new Map([[2, 1]]));
        assert.deepEqual([a[0].purpose, b[0].purpose], [undefined, undefined]);
    });
});

describe('純重練卷與附註', () => {
    test('卷名「<姓名>-錯題重練卷(日期)」；每一題都是重練題才算純重練卷', () => {
        assert.equal(sel.retrainPaperTitle('王小明', '2026_10_12'), '王小明-錯題重練卷(2026_10_12)');
        assert.equal(sel.isPureRetrain([1, 2], [2, 1]), true);
        assert.equal(sel.isPureRetrain([1, 2], [1]), false);
        assert.equal(sel.isPureRetrain([1], []), false);
        assert.equal(sel.isPureRetrain([1], null), false);
    });

    test('draftNotes：沒有到期、題數上限、blocked 的組逐組說明（補救卷加前綴）', () => {
        assert.deepEqual(sel.draftNotes({ dueTotal: 0, got: 0, pickedDue: 0, dueAvailable: 0 }), ['目前沒有到期的重練題。']);
        assert.deepEqual(sel.draftNotes({ dueTotal: 6, got: 3, pickedDue: 3, dueAvailable: 6 }),
            ['到期 6 題，本草稿放 3 題（題數上限）；其餘留在清單，下次優先。']);
        assert.deepEqual(sel.draftNotes({ dueTotal: 3, got: 3, pickedDue: 3, dueAvailable: 3 }), []);
        assert.deepEqual(sel.draftNotes({
            dueTotal: 2, got: 0, pickedDue: 0, dueAvailable: 0, label: '到期重練：',
            blocked: [{ group_ids: [7, 8], reasons: [{ question_id: 8, reason: 'in_flight' }] }]
        }), ['到期重練：承上題組（題 7、8）有題到期，但組內有題已派到還沒批改的卷，這次不能出（承上題要整組出）；請到錯題重練清單處理。']);
    });

    test('常數：API-5 預設 10 題、API-8 上限 20 題；「到期重練」的 target', () => {
        assert.equal(sel.DEFAULT_PAPER_COUNT, 10);
        assert.equal(sel.MAX_REMEDIAL_RETRAIN, 20);
        assert.deepEqual(sel.RETRAIN_TARGET, { type: 'retrain', name: '到期重練' });
    });

    test('本檔不呼叫任何 LLM、不讀學生姓名', () => {
        const src = require('node:fs').readFileSync(require.resolve('../../services/retrainSelect'), 'utf8');
        assert.ok(!/require\(['"][^'"]*services\/llm/.test(src) && !/generateJson|generateText/.test(src));
        assert.ok(!/students\s+(s\s+)?WHERE|FROM students/.test(src), '不查 students（卷名在 examController 產生）');
    });
});
