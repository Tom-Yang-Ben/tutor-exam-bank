// ─────────────────────────────────────────────────────────────
// test/unit/retrainScheduleCutoff.test.js — computeRetrainState 的可選輸入 entered_after_assignment_id（規則 8）
// （〔retrain PR-2〕docs/retrain-and-review.md 第 4.4 節「起算日當天的重練派題」的已知邊界）
//
// 同一天先批改當天的重練、再按「重新加入」：只收日期的話那一筆會算進新一輪（不是從第 1 關、連對 0 開始）。
// PR-2 在項目上記「重新加入當下最大的派題編號」，純函式把「派題日＝起算日、編號 ≤ 它」的重練派題算成前一輪。
// 已交付的 retrainSchedule.test.js／retrainScheduleProperty.test.js 一條都沒改；這裡只驗新增的輸入。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sched = require('../../services/retrainSchedule');

const N = (id, d, result = 0) => ({ assignment_id: id, assigned_at: d, purpose: 'new', result, score: null });
const R = (id, d, result, score = null) => ({ assignment_id: id, assigned_at: d, purpose: 'retrain', result, score });

describe('entered_after_assignment_id（起算切點）', () => {
    const history = [N(1, '2026-10-01'), R(5, '2026-10-12', 1), R(6, '2026-10-12', 0)];

    test('沒給（undefined／null）：行為與加這個輸入之前完全相同', () => {
        const base = sched.computeRetrainState({ entered_on: '2026-10-12', history });
        assert.deepEqual(sched.computeRetrainState({ entered_on: '2026-10-12', history, entered_after_assignment_id: null }), base);
        // 當天的兩筆都算這一輪：對→第 2 關、錯→回第 1 關，錯 1 次
        assert.deepEqual([base.status, base.step, base.streak, base.lapses, base.due_on], ['active', 1, 0, 1, '2026-10-13']);
    });

    test('給了：起算日當天、編號 ≤ 切點的重練派題算前一輪（只累計錯的次數），之後的照常算', () => {
        const s = sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: 6,
            history: [...history, R(9, '2026-10-12', 1)] });
        // 5、6 是重新加入之前的；9 是之後當天就出的重練卷：對 → 第 2 關
        assert.deepEqual([s.status, s.step, s.streak, s.lapses, s.due_on, s.last_attempt_on],
            ['active', 2, 1, 1, '2026-10-19', '2026-10-12']);
        const only = sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: 6, history });
        assert.deepEqual([only.status, only.step, only.streak, only.lapses, only.due_on], ['active', 1, 0, 1, '2026-10-13'],
            '從第 1 關、連對 0 重來，錯的次數不歸零');
    });

    test('起算日之前的照舊（日期就排除了）；起算日之後的不受切點影響', () => {
        const s = sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: 100,
            history: [N(1, '2026-10-01'), R(2, '2026-10-05', 1), R(3, '2026-10-13', 1)] });
        assert.deepEqual([s.step, s.streak, s.lapses], [2, 1, 0], '10/13 的那一筆編號小於切點也照常算（不同一天）');
    });

    test('切點不影響「已派出」的判斷（countsAsInFlight）', () => {
        const s = sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: 6,
            history: [N(1, '2026-10-01'), R(6, '2026-10-12', null)] });
        assert.deepEqual([s.in_flight, s.in_flight_since], [true, '2026-10-12']);
    });

    test('輸入驗證：非負整數或 null', () => {
        for (const bad of [-1, 1.5, 'x', {}]) {
            assert.throws(() => sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: bad }),
                /entered_after_assignment_id 必須是非負整數或 null/, JSON.stringify(bad));
        }
        assert.doesNotThrow(() => sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: 0 }));
        assert.doesNotThrow(() => sched.computeRetrainState({ entered_on: '2026-10-12', entered_after_assignment_id: '42' }),
            'pg 讀出來的 BIGINT 可能是字串');
    });
});
