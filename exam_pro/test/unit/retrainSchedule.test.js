// ─────────────────────────────────────────────────────────────
// retrainSchedule.test.js — services/retrainSchedule.js（錯題重練與間隔複習的排程純函式）
//
// 設計稿 docs/retrain-and-review.md 第 6.3 節 TC-038-1、TC-038-2（以及 TC-039-1 的附帶上限）：
//   - 第 4.5 節的例子逐列釘住（學生 A 的一題向量內積：10/1 錯 → … → 11/5 練到會）
//   - R2 全對才算對：部分給分沒滿分算錯、給 100% 算對、沒給分看對錯按鈕
//   - R1 選 2：新題（第一次）那一次的對錯不影響排程，起算日由老師勾選／加入決定
//   - R4：又錯回第一關、錯的次數加一，錯滿 3 次卡關但仍在清單、照樣到期
//   - 邊界：空歷史、同日多筆、未批改（已派出）、老師移出／判定已會、練到會後重新加入、
//     已練到會的承上組同組題被帶著出又答錯、跨月跨年與閏日、時區
//   - 參數化：K＝2／4、不同間隔表（Owner 改設定不需改程式）
//   - capForAttach：新題數的三成、無條件捨去、合計不超過 50 題
//
// 隨機作答歷史的決定性測試（TC-038-4）在 retrainScheduleProperty.test.js。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sched = require('../../services/retrainSchedule');
const { DEFAULTS, loadRetrainConfig } = require('../../config/retrain');

const { computeRetrainState, isCorrect, isGraded, correctnessOf, isDue, overdueDays, capForAttach, addDays, diffDays, isValidDate } = sched;

/** 新題（第一次）派題 */
const N = (id, date, result = null, score = null) => ({ assignment_id: id, assigned_at: date, purpose: 'new', result, score });
/** 重練／回測派題 */
const R = (id, date, result = null, score = null) => ({ assignment_id: id, assigned_at: date, purpose: 'retrain', result, score });

/** 只挑排程欄位來比（讀起來比整個物件短） */
function pick(state) {
    const { status, step, due_on, streak, lapses, stuck } = state;
    return { status, step, due_on, streak, lapses, stuck };
}

describe('第 4.5 節的例子（K＝3、間隔 1／7／14 天）逐列釘住', () => {
    // 學生 A 的一題向量內積：10/1 新題批改錯、老師在批改卡勾「要重練」→ 起算日＝那一筆派題日
    const entered_on = '2026-10-01';
    const H = [
        N(501, '2026-10-01', 0),
        R(630, '2026-10-05', 1),   // 重練卷，對
        R(702, '2026-10-12', 0),   // 附在新卷，錯
        R(741, '2026-10-15', 1),   // 附在新卷，對
        R(803, '2026-10-22', 1),   // 附在新卷，對
        R(911, '2026-11-05', 1)    // 附在新卷，對
    ];
    const ROWS = [
        { date: '10/1 新題錯、勾要重練', n: 1, want: { status: 'active', step: 1, due_on: '2026-10-02', streak: 0, lapses: 0, stuck: false } },
        { date: '10/5 重練對', n: 2, want: { status: 'active', step: 2, due_on: '2026-10-12', streak: 1, lapses: 0, stuck: false } },
        { date: '10/12 回測錯', n: 3, want: { status: 'active', step: 1, due_on: '2026-10-13', streak: 0, lapses: 1, stuck: false } },
        { date: '10/15 重練對', n: 4, want: { status: 'active', step: 2, due_on: '2026-10-22', streak: 1, lapses: 1, stuck: false } },
        { date: '10/22 回測對', n: 5, want: { status: 'active', step: 3, due_on: '2026-11-05', streak: 2, lapses: 1, stuck: false } },
        { date: '11/5 回測對＝練到會', n: 6, want: { status: 'mastered', step: 3, due_on: null, streak: 3, lapses: 1, stuck: false } }
    ];
    for (const row of ROWS) {
        test(row.date, () => {
            const s = computeRetrainState({ entered_on, history: H.slice(0, row.n) });
            assert.deepEqual(pick(s), row.want);
            assert.equal(s.in_flight, false);
        });
    }

    test('練到會的日期是 11/5；最後一次作答 11/5；不再到期', () => {
        const s = computeRetrainState({ entered_on, history: H });
        assert.equal(s.mastered_on, '2026-11-05');
        assert.equal(s.last_attempt_on, '2026-11-05');
        assert.equal(isDue(s, '2027-06-30'), false);
    });

    test('每一列的到期判斷：到期日當天起才算到期', () => {
        const after10_1 = computeRetrainState({ entered_on, history: H.slice(0, 1) });
        assert.equal(isDue(after10_1, '2026-10-01'), false);
        assert.equal(isDue(after10_1, '2026-10-02'), true);
        const after10_5 = computeRetrainState({ entered_on, history: H.slice(0, 2) });
        assert.equal(isDue(after10_5, '2026-10-11'), false);
        assert.equal(isDue(after10_5, '2026-10-12'), true);
        assert.equal(overdueDays(after10_5, '2026-10-12'), 0);
        assert.equal(overdueDays(after10_5, '2026-10-15'), 3);
        assert.equal(overdueDays(after10_5, '2026-10-11'), 0, '還沒到期時逾期天數是 0');
    });

    test('已派出、還沒批改時不算到期（10/5 的重練卷還沒批改）', () => {
        const s = computeRetrainState({ entered_on, history: [H[0], R(630, '2026-10-05', null)] });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-02', streak: 0, lapses: 0, stuck: false });
        assert.equal(s.in_flight, true);
        assert.equal(s.in_flight_since, '2026-10-05');
        assert.equal(isDue(s, '2026-10-20'), false);
    });
});

describe('R2 選 1：只有全對才算對', () => {
    test('沒給部分分：看對錯按鈕', () => {
        assert.equal(isCorrect({ result: 1, score: null }), true);
        assert.equal(isCorrect({ result: 0, score: null }), false);
        assert.equal(isCorrect({ result: 1 }), true);
    });

    test('部分給分：只有 100% 算對；80% 也算錯（即使按了「對」）', () => {
        assert.equal(isCorrect({ result: 1, score: 1 }), true);
        assert.equal(isCorrect({ result: 1, score: 0.8 }), false);
        assert.equal(isCorrect({ result: 1, score: 0.99 }), false);
        assert.equal(isCorrect({ result: 0, score: 0.5 }), false);
        assert.equal(isCorrect({ result: 0, score: 0 }), false);
    });

    test('正確度＝COALESCE(score, result)（同補救卷與知識點掌握度的算法）', () => {
        assert.equal(correctnessOf({ result: 1, score: null }), 1);
        assert.equal(correctnessOf({ result: 1, score: 0.8 }), 0.8);
        assert.equal(correctnessOf({ result: 0, score: 1 }), 1);
        assert.equal(isCorrect({ result: 0, score: 1 }), true, '給 100% 就算對');
        assert.equal(correctnessOf({ result: null, score: null }), null);
    });

    test('NUMERIC 沒轉型時是字串：「1.00」算對、「0.80」算錯', () => {
        assert.equal(isCorrect({ result: 1, score: '1.00' }), true);
        assert.equal(isCorrect({ result: 1, score: '0.80' }), false);
    });

    test('沒批改（result 為 NULL）不算對也不算錯', () => {
        assert.equal(isGraded({ result: null }), false);
        assert.equal(isGraded({}), false);
        assert.equal(isGraded(null), false);
        assert.equal(isGraded({ result: 0 }), true);
        assert.equal(isGraded({ result: 1 }), true);
        assert.equal(isGraded({ result: 2 }), false);
        assert.equal(isCorrect({ result: null, score: null }), false);
    });

    test('排程裡：部分給分 80% 的重練等於答錯（回第一關、錯的次數加一）', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1, 0.8)]
        });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-06', streak: 0, lapses: 1, stuck: false });
    });

    test('排程裡：給 100% 的重練算對（升一關）', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1, 1)]
        });
        assert.deepEqual(pick(s), { status: 'active', step: 2, due_on: '2026-10-12', streak: 1, lapses: 0, stuck: false });
    });
});

describe('R1 選 2：進清單由老師決定，新題那一次的對錯不影響排程', () => {
    test('空歷史（清單上手動加入、還沒派過重練）：從起算日進第 1 關，隔天到期', () => {
        const s = computeRetrainState({ entered_on: '2026-10-08', history: [] });
        assert.deepEqual(s, {
            status: 'active', step: 1, due_on: '2026-10-09', streak: 0, lapses: 0,
            last_attempt_on: null, mastered_on: null, in_flight: false, in_flight_since: null, stuck: false
        });
        assert.deepEqual(computeRetrainState({ entered_on: '2026-10-08' }), s, '省略 history 等於空歷史');
    });

    test('新題答對、老師仍勾要重練（例如猜對）：同樣從第 1 關開始，不算連對', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [N(1, '2026-10-01', 1)] });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-02', streak: 0, lapses: 0, stuck: false });
    });

    test('新題答錯不算「錯的次數」（錯的次數只算重練與回測）', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [N(1, '2026-10-01', 0, 0.3)] });
        assert.equal(s.lapses, 0);
    });

    test('以前的錯題手動加入（R11 選 3 不補建）：起算日是加入當天，不是當年的派題日', () => {
        const s = computeRetrainState({ entered_on: '2026-10-20', history: [N(1, '2026-05-03', 0)] });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-21', streak: 0, lapses: 0, stuck: false });
        assert.equal(isDue(s, '2026-10-20'), false);
        assert.equal(isDue(s, '2026-10-21'), true);
    });

    test('新題那一張卷還沒批改（取消批改）：算已派出，不到期', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [N(1, '2026-10-01', null)] });
        assert.equal(s.in_flight, true);
        assert.equal(s.in_flight_since, '2026-10-01');
        assert.equal(isDue(s, '2026-10-10'), false);
    });
});

describe('R4 選 1：又錯回第一關；錯滿 3 次卡關，仍在清單', () => {
    test('錯滿 3 次：標卡關，但狀態仍是進行中、照樣到期', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-03', 0), R(3, '2026-10-06', 0), R(4, '2026-10-09', 0)]
        });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-10', streak: 0, lapses: 3, stuck: true });
        assert.equal(isDue(s, '2026-10-10'), true, '卡關只是提醒，不自動移出');
    });

    test('錯 2 次還不算卡關', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-03', 0), R(3, '2026-10-06', 0)]
        });
        assert.equal(s.lapses, 2);
        assert.equal(s.stuck, false);
    });

    test('卡關之後又答對：照常升關，錯的次數不歸零（仍標卡關）', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-03', 0), R(3, '2026-10-06', 0), R(4, '2026-10-09', 0), R(5, '2026-10-12', 1)]
        });
        assert.deepEqual(pick(s), { status: 'active', step: 2, due_on: '2026-10-19', streak: 1, lapses: 3, stuck: true });
    });

    test('卡關之後最後練到會：不再標卡關', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [
                N(1, '2026-10-01', 0), R(2, '2026-10-03', 0), R(3, '2026-10-06', 0), R(4, '2026-10-09', 0),
                R(5, '2026-10-12', 1), R(6, '2026-10-19', 1), R(7, '2026-11-02', 1)
            ]
        });
        assert.deepEqual(pick(s), { status: 'mastered', step: 3, due_on: null, streak: 3, lapses: 3, stuck: false });
        assert.equal(s.mastered_on, '2026-11-02');
    });

    test('卡關門檻可調（stuckLapses＝2）', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [R(2, '2026-10-03', 0), R(3, '2026-10-06', 0)]
        }, { ...DEFAULTS, stuckLapses: 2 });
        assert.equal(s.stuck, true);
    });
});

describe('同一天多筆作答', () => {
    test('同一天的兩筆依派題編號排先後：先對後錯＝回第一關', () => {
        const h = [N(1, '2026-10-01', 0), R(11, '2026-10-05', 1), R(12, '2026-10-05', 0)];
        const s = computeRetrainState({ entered_on: '2026-10-01', history: h });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-10-06', streak: 0, lapses: 1, stuck: false });
    });

    test('同一天的兩筆：先錯後對＝升到第 2 關', () => {
        const h = [N(1, '2026-10-01', 0), R(11, '2026-10-05', 0), R(12, '2026-10-05', 1)];
        const s = computeRetrainState({ entered_on: '2026-10-01', history: h });
        assert.deepEqual(pick(s), { status: 'active', step: 2, due_on: '2026-10-12', streak: 1, lapses: 1, stuck: false });
    });

    test('輸入順序不影響結果（函式內依派題日、派題編號排序）', () => {
        const h = [N(1, '2026-10-01', 0), R(11, '2026-10-05', 0), R(12, '2026-10-05', 1), R(20, '2026-10-12', 1)];
        const want = computeRetrainState({ entered_on: '2026-10-01', history: h });
        const reversed = computeRetrainState({ entered_on: '2026-10-01', history: [...h].reverse() });
        const shuffled = computeRetrainState({ entered_on: '2026-10-01', history: [h[2], h[0], h[3], h[1]] });
        assert.deepEqual(reversed, want);
        assert.deepEqual(shuffled, want);
    });

    test('同一天兩筆都對：各算一次（手動提早出題時由老師負責；到期機制平常不會這樣排）', () => {
        const h = [R(11, '2026-10-05', 1), R(12, '2026-10-05', 1)];
        const s = computeRetrainState({ entered_on: '2026-10-01', history: h });
        assert.deepEqual(pick(s), { status: 'active', step: 3, due_on: '2026-10-19', streak: 2, lapses: 0, stuck: false });
    });

    test('與起算日同一天的重練派題算在這一輪', () => {
        const s = computeRetrainState({ entered_on: '2026-10-05', history: [R(11, '2026-10-05', 1)] });
        assert.equal(s.step, 2);
        assert.equal(s.due_on, '2026-10-12');
    });

    test('派題編號是字串（BIGINT 沒轉型）時照數字大小排，不照字典順序', () => {
        const h = [
            { assignment_id: '9', assigned_at: '2026-10-05', purpose: 'retrain', result: 1, score: null },
            { assignment_id: '10', assigned_at: '2026-10-05', purpose: 'retrain', result: 0, score: null }
        ];
        const s = computeRetrainState({ entered_on: '2026-10-01', history: h });
        assert.equal(s.step, 1, '9 在 10 之前：先對後錯＝回第一關');
    });
});

describe('未批改、取消批改（已派出）', () => {
    test('重練卷還沒批改：關卡不動、in_flight、不到期；批改後才前進', () => {
        const base = [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1)];
        const pending = computeRetrainState({ entered_on: '2026-10-01', history: [...base, R(3, '2026-10-12', null)] });
        assert.deepEqual(pick(pending), { status: 'active', step: 2, due_on: '2026-10-12', streak: 1, lapses: 0, stuck: false });
        assert.equal(pending.in_flight, true);
        assert.equal(pending.in_flight_since, '2026-10-12');
        assert.equal(isDue(pending, '2026-10-30'), false);

        const graded = computeRetrainState({ entered_on: '2026-10-01', history: [...base, R(3, '2026-10-12', 1)] });
        assert.equal(graded.step, 3);
        assert.equal(graded.in_flight, false);
    });

    test('中間有一張取消批改的卷：仍算已派出（最早那一張的派題日），其餘照算', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01',
            history: [N(1, '2026-10-01', 0), R(2, '2026-10-05', null), R(3, '2026-10-12', 1)]
        });
        assert.equal(s.in_flight, true);
        assert.equal(s.in_flight_since, '2026-10-05');
        assert.equal(s.step, 2);
        assert.equal(s.last_attempt_on, '2026-10-12');
    });
});

describe('老師的手動決定（重算時優先）', () => {
    const H = [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1)];

    test('移出（retired）：不到期、不卡關，保留作答統計', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', teacher_override: 'retired', override_on: '2026-10-07', history: H });
        assert.equal(s.status, 'retired');
        assert.equal(s.due_on, null);
        assert.equal(s.streak, 1);
        assert.equal(isDue(s, '2026-12-31'), false);
    });

    test('判定已會（mastered）：練到會日期＝判定那天', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', teacher_override: 'mastered', override_on: '2026-10-07', history: H });
        assert.equal(s.status, 'mastered');
        assert.equal(s.due_on, null);
        assert.equal(s.mastered_on, '2026-10-07');
        assert.equal(isDue(s, '2026-12-31'), false);
    });

    test('本來就練到會、老師又按判定已會：保留原本練到會的日期', () => {
        const done = [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1), R(3, '2026-10-12', 1), R(4, '2026-10-26', 1)];
        const s = computeRetrainState({ entered_on: '2026-10-01', teacher_override: 'mastered', override_on: '2026-11-01', history: done });
        assert.equal(s.mastered_on, '2026-10-26');
    });

    test('判定已會之後被承上組帶著出又答錯：老師的決定優先，仍是練到會', () => {
        const s = computeRetrainState({
            entered_on: '2026-10-01', teacher_override: 'mastered', override_on: '2026-10-07',
            history: [...H, R(9, '2026-10-20', 0)]
        });
        assert.equal(s.status, 'mastered');
        assert.equal(s.lapses, 1, '作答紀錄照樣累計');
        assert.equal(s.stuck, false);
    });

    test('teacher_override 為空字串或 undefined 等於沒有', () => {
        const a = computeRetrainState({ entered_on: '2026-10-01', teacher_override: '', history: H });
        const b = computeRetrainState({ entered_on: '2026-10-01', history: H });
        assert.deepEqual(a, b);
    });
});

describe('練到會之後', () => {
    const DONE = [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1), R(3, '2026-10-12', 0), R(4, '2026-10-15', 1), R(5, '2026-10-22', 1), R(6, '2026-11-05', 1)];

    test('承上組被帶著出又答對：維持練到會（日期不變）', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [...DONE, R(7, '2026-11-20', 1)] });
        assert.equal(s.status, 'mastered');
        assert.equal(s.mastered_on, '2026-11-05');
        assert.equal(s.streak, 3);
        assert.equal(s.last_attempt_on, '2026-11-20');
    });

    test('承上組被帶著出又答錯：重新進行中、回第一關', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [...DONE, R(7, '2026-11-20', 0)] });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-11-21', streak: 0, lapses: 2, stuck: false });
        assert.equal(s.mastered_on, null);
    });

    test('老師重新加入（起算日改成加入當天）：從第 1 關重來，連對歸零，錯的次數累計不歸零', () => {
        const s = computeRetrainState({ entered_on: '2026-12-01', history: DONE });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-12-02', streak: 0, lapses: 1, stuck: false });
        assert.equal(s.mastered_on, null);
        assert.equal(s.last_attempt_on, '2026-11-05', '上一輪的最後一次作答仍看得到');
        assert.equal(isDue(s, '2026-12-02'), true);
    });

    test('重新加入後的新一輪照常升關、練到會', () => {
        const again = [...DONE, R(21, '2026-12-03', 1), R(22, '2026-12-10', 1), R(23, '2026-12-24', 1)];
        const mid = computeRetrainState({ entered_on: '2026-12-01', history: again.slice(0, -1) });
        assert.deepEqual(pick(mid), { status: 'active', step: 3, due_on: '2026-12-24', streak: 2, lapses: 1, stuck: false });
        const s = computeRetrainState({ entered_on: '2026-12-01', history: again });
        assert.equal(s.status, 'mastered');
        assert.equal(s.mastered_on, '2026-12-24');
    });

    test('重新加入之前那一輪的錯也算進錯的次數（卡關看的是這一題總共錯幾次）', () => {
        const before = [R(2, '2026-10-05', 0), R(3, '2026-10-06', 0), R(4, '2026-10-07', 0), R(5, '2026-10-08', 1)];
        const s = computeRetrainState({ entered_on: '2026-12-01', history: before });
        assert.equal(s.lapses, 3);
        assert.equal(s.stuck, true);
        assert.equal(s.step, 1, '上一輪的對錯不影響這一輪的關卡');
    });

    test('移出之後重新加入（呼叫端清掉 override、起算日改成當天）', () => {
        const h = [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1)];
        const s = computeRetrainState({ entered_on: '2026-11-10', teacher_override: null, history: h });
        assert.deepEqual(pick(s), { status: 'active', step: 1, due_on: '2026-11-11', streak: 0, lapses: 0, stuck: false });
    });
});

describe('TC-038-2 參數化：Owner 改設定不需要改程式', () => {
    const P2 = { ...DEFAULTS, stepDays: [1, 7], masteryStreak: 2 };
    const P4 = { ...DEFAULTS, stepDays: [1, 7, 14, 28], masteryStreak: 4 };

    test('K＝2（重做、隔 1 週）：對兩次就練到會', () => {
        const h = [R(2, '2026-10-05', 1), R(3, '2026-10-12', 1)];
        assert.equal(computeRetrainState({ entered_on: '2026-10-01', history: h.slice(0, 1) }, P2).due_on, '2026-10-12');
        const s = computeRetrainState({ entered_on: '2026-10-01', history: h }, P2);
        assert.equal(s.status, 'mastered');
        assert.equal(s.step, 2);
    });

    test('K＝4（隔 1、2、4 週）：第 4 關隔 28 天，對四次才練到會', () => {
        const h = [R(2, '2026-10-05', 1), R(3, '2026-10-12', 1), R(4, '2026-10-26', 1), R(5, '2026-11-23', 1)];
        const third = computeRetrainState({ entered_on: '2026-10-01', history: h.slice(0, 3) }, P4);
        assert.deepEqual(pick(third), { status: 'active', step: 4, due_on: '2026-11-23', streak: 3, lapses: 0, stuck: false });
        assert.equal(computeRetrainState({ entered_on: '2026-10-01', history: h }, P4).status, 'mastered');
    });

    test('不同的間隔表：第 1 關 0 天（當天就能出）', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01' }, { ...DEFAULTS, stepDays: [0, 7, 14] });
        assert.equal(s.due_on, '2026-10-01');
        assert.equal(isDue(s, '2026-10-01'), true);
    });

    test('config/retrain.js 讀出來的參數可以直接傳入（環境變數覆寫後）', () => {
        const params = loadRetrainConfig({ RETRAIN_STEP_DAYS: '2,9,20', RETRAIN_MASTERY_STREAK: '3' });
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [R(2, '2026-10-05', 1)] }, params);
        assert.equal(s.due_on, '2026-10-14');
        assert.deepEqual(computeRetrainState({ entered_on: '2026-10-01' }, loadRetrainConfig({})),
            computeRetrainState({ entered_on: '2026-10-01' }));
    });

    test('不合法的參數丟 TypeError（呼叫端的程式錯誤）', () => {
        const input = { entered_on: '2026-10-01' };
        assert.throws(() => computeRetrainState(input, null), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, masteryStreak: 0 }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, masteryStreak: 10 }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, masteryStreak: 4 }), TypeError, '關數不足');
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, stepDays: [1, -7, 14] }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, stepDays: [1, 7.5, 14] }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, stuckLapses: 0 }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, correctThreshold: 0 }), TypeError);
        assert.throws(() => computeRetrainState(input, { ...DEFAULTS, correctThreshold: 1.2 }), TypeError);
    });
});

describe('輸入驗證與純度', () => {
    test('不合法的輸入丟 TypeError', () => {
        assert.throws(() => computeRetrainState(null), TypeError);
        assert.throws(() => computeRetrainState({}), TypeError, '缺起算日');
        assert.throws(() => computeRetrainState({ entered_on: '2026/10/01' }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-02-30' }), TypeError, '不存在的日期');
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', history: 'x' }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', history: [null] }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', history: [R(1, '10/5', 1)] }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', history: [{ ...R(1, '2026-10-05', 1), purpose: 'review' }] }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', history: [{ ...R(1, '2026-10-05', 1), assignment_id: 'abc' }] }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', teacher_override: 'paused', override_on: '2026-10-02' }), TypeError);
        assert.throws(() => computeRetrainState({ entered_on: '2026-10-01', teacher_override: 'retired' }), TypeError, 'override 要有日期');
    });

    test('不改動輸入（凍結的輸入也能算）', () => {
        const history = Object.freeze([R(3, '2026-10-12', 1), N(1, '2026-10-01', 0), R(2, '2026-10-05', 1)].map(e => Object.freeze(e)));
        const input = Object.freeze({ entered_on: '2026-10-01', history });
        const s = computeRetrainState(input);
        assert.equal(s.step, 3);
        assert.equal(history[0].assignment_id, 3, '原陣列順序不變');
    });

    test('同一份輸入算兩次結果相同', () => {
        const input = { entered_on: '2026-10-01', history: [N(1, '2026-10-01', 0), R(2, '2026-10-05', 1), R(3, '2026-10-12', null)] };
        assert.deepEqual(computeRetrainState(input), computeRetrainState(input));
    });

    test('原始碼不讀 env、不看時鐘、不碰 DB（設計稿第 4.6 節）', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'retrainSchedule.js'), 'utf8')
            .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.doesNotMatch(src, /process\.env/);
        assert.doesNotMatch(src, /Date\.now\s*\(/);
        assert.doesNotMatch(src, /new Date\(\s*\)/);
        assert.doesNotMatch(src, /require\(['"][^'"]*(config\/db|\bpg)['"]\)/);
    });
});

describe('日期加減（YYYY-MM-DD 字串，不受時區影響）', () => {
    test('跨月、跨年、閏日', () => {
        assert.equal(addDays('2026-10-22', 14), '2026-11-05');
        assert.equal(addDays('2026-12-25', 7), '2027-01-01');
        assert.equal(addDays('2028-02-22', 7), '2028-02-29');
        assert.equal(addDays('2027-02-22', 7), '2027-03-01');
        assert.equal(addDays('2026-10-01', 0), '2026-10-01');
        assert.equal(addDays('2026-10-01', -1), '2026-09-30');
        assert.equal(diffDays('2026-10-12', '2026-10-15'), 3);
        assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
        assert.equal(diffDays('2026-10-15', '2026-10-12'), -3);
    });

    test('日期格式驗證', () => {
        assert.equal(isValidDate('2026-10-01'), true);
        assert.equal(isValidDate('2028-02-29'), true);
        assert.equal(isValidDate('2027-02-29'), false);
        assert.equal(isValidDate('2026-13-01'), false);
        assert.equal(isValidDate('2026-1-1'), false);
        assert.equal(isValidDate(new Date()), false, 'Date 物件不收（config/db.js 把 DATE 解析成字串）');
        assert.throws(() => addDays('2026-10-01', 1.5), TypeError);
        assert.throws(() => isDue({ status: 'active', due_on: '2026-10-01', in_flight: false }, 'today'), TypeError);
    });

    test('伺服器時區不同，結果相同（夏令時間切換日也一樣）', () => {
        const saved = process.env.TZ;
        const input = { entered_on: '2026-10-31', history: [R(2, '2026-11-01', 1), R(3, '2026-11-08', 1)] };
        const results = [];
        try {
            for (const tz of ['UTC', 'Asia/Taipei', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
                process.env.TZ = tz;
                results.push([addDays('2026-03-07', 1), addDays('2026-11-01', 7), computeRetrainState(input)]);
            }
        } finally {
            if (saved === undefined) delete process.env.TZ;
            else process.env.TZ = saved;
        }
        for (const r of results) assert.deepEqual(r, results[0]);
        assert.equal(results[0][0], '2026-03-08');
        assert.equal(results[0][2].due_on, '2026-11-22');
    });
});

describe('isDue：到期的判斷', () => {
    test('只有進行中、沒有已派出、到期日 ≤ 預計作答日才算到期', () => {
        const base = { status: 'active', due_on: '2026-10-12', in_flight: false };
        assert.equal(isDue(base, '2026-10-12'), true);
        assert.equal(isDue(base, '2026-10-11'), false);
        assert.equal(isDue({ ...base, in_flight: true }, '2026-10-30'), false);
        assert.equal(isDue({ ...base, status: 'mastered', due_on: null }, '2026-10-30'), false);
        assert.equal(isDue({ ...base, status: 'retired', due_on: null }, '2026-10-30'), false);
        assert.equal(isDue(null, '2026-10-30'), false);
    });

    test('預計作答日（週日備週三的課時選週三）', () => {
        const s = computeRetrainState({ entered_on: '2026-10-01', history: [R(2, '2026-10-05', 1)] });   // 10/12 到期
        assert.equal(isDue(s, '2026-10-11'), false, '週日備課、以今天判斷還沒到期');
        assert.equal(isDue(s, '2026-10-14'), true, '預計作答日選週三就到期');
        assert.equal(overdueDays(s, '2026-10-14'), 2);
    });
});

describe('capForAttach：附在新卷的預設上限（R6 選 1：新題數的三成）', () => {
    test('預設比例 0.3，無條件捨去', () => {
        assert.equal(capForAttach(20), 6);
        assert.equal(capForAttach(10), 3);
        assert.equal(capForAttach(7), 2);
        assert.equal(capForAttach(3), 0);
        assert.equal(capForAttach(0), 0);
        assert.equal(capForAttach(33), 9);
    });

    test('比例可改（出卷時老師改、或環境變數覆寫後由呼叫端傳入）', () => {
        assert.equal(capForAttach(20, 0.5), 10);
        assert.equal(capForAttach(20, 0), 0);
        assert.equal(capForAttach(10, 1), 10);
        assert.equal(capForAttach(20, loadRetrainConfig({ RETRAIN_ATTACH_RATIO: '0.25' }).attachRatio), 5);
    });

    test('浮點誤差不會少算一題（0.29 × 100 = 28.999…）', () => {
        assert.equal(capForAttach(100, 0.29, { maxTotal: 1000 }), 29);
        assert.equal(capForAttach(10, 0.7), 7);
        assert.equal(capForAttach(30, 0.1), 3);
    });

    test('新題＋重練合計不超過一份卷的上限 50 題', () => {
        assert.equal(capForAttach(40, 0.3), 10, '12 題會讓合計 52 題，壓到 10');
        assert.equal(capForAttach(45, 0.3), 5);
        assert.equal(capForAttach(50, 0.3), 0);
        assert.equal(capForAttach(40, 2), 10);
        assert.equal(capForAttach(60, 0.3), 0, '新題已超過上限時不再附帶（超過的新題本來就會被擋）');
        assert.equal(capForAttach(10, 0.3, { maxTotal: 12 }), 2);
    });

    test('不合法的輸入丟 RangeError', () => {
        assert.throws(() => capForAttach(-1), RangeError);
        assert.throws(() => capForAttach(2.5), RangeError);
        assert.throws(() => capForAttach('20'), RangeError);
        assert.throws(() => capForAttach(20, -0.1), RangeError);
        assert.throws(() => capForAttach(20, NaN), RangeError);
        assert.throws(() => capForAttach(20, '0.3'), RangeError);
        assert.throws(() => capForAttach(20, 0.3, { maxTotal: -1 }), RangeError);
    });
});
