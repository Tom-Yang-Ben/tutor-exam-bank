// ─────────────────────────────────────────────────────────────
// retrainScheduleProperty.test.js — 排程純函式的隨機測試（設計稿第 6.3 節 TC-038-4）
//
// 固定種子產生 1,000 組隨機作答歷史（含新題、重練、未批改、部分給分、同日多筆、
// 重新加入之前那一輪、手動加入以前沒批改的題、老師的手動決定、K＝2／3／4），檢查：
//   1. 與一個寫法完全不同的參考實作（「最後一次答錯之後連對幾次」）結果相同
//   2. 輸入順序打亂，結果相同
//   3. 依隨機順序逐筆批改、改判、取消批改：每一個中間歷史（部分批改）也都與參考實作相同
//      （純函式每次從頭重算，「最後一次重算＝直接算最終歷史」必然成立，所以不拿它當檢查；
//       不變量 I7「排程快取＝作答歷史重算的結果」的風險在 PR-2 的 I/O 層，由整合測試
//       TC-038-3／TC-038-4 驗）
//   4. 已派出的判斷：全部未批改時，有重練派題、或起算日當天以後的新題派題才算
//   5. 不變量：只有進行中才有到期日（I5）；進行中時 關卡＝連對＋1 且連對 < K；卡關只出現在進行中
//
// 不呼叫 LLM、不連 DB。執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeRetrainState, isDue } = require('../../services/retrainSchedule');
const { DEFAULTS } = require('../../config/retrain');

const CASES = 1000;
const SEED = 20260926;

/** mulberry32：小而決定性的 PRNG */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const intIn = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pickOne = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
function shuffle(rnd, arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** 參考實作用的日期加法：與被測程式不同的寫法（Date.parse＋ISO 字串） */
function plusDays(date, n) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** 一組隨機情境 */
function makeCase(rnd) {
    const K = pickOne(rnd, [2, 3, 3, 3, 4]);
    const stepDays = pickOne(rnd, [[1, 7, 14, 28], [0, 3, 10, 21], [2, 5, 9, 30]]).slice(0, K);
    const params = { ...DEFAULTS, stepDays, masteryStreak: K, stuckLapses: pickOne(rnd, [1, 2, 3, 3]) };

    const firstDay = plusDays('2026-09-01', intIn(rnd, 0, 20));
    const history = [{
        assignment_id: 1, assigned_at: firstDay, purpose: 'new',
        result: rnd() < 0.9 ? pickOne(rnd, [0, 0, 1]) : null, score: null
    }];
    let day = firstDay;
    let id = 1;
    const n = intIn(rnd, 0, 14);
    for (let i = 0; i < n; i++) {
        day = plusDays(day, pickOne(rnd, [0, 1, 3, 7, 7, 14]));   // 0＝同一天多筆
        id += intIn(rnd, 1, 5);
        const r = rnd();
        const result = r < 0.1 ? null : (r < 0.6 ? 1 : 0);
        const score = result === null ? null : pickOne(rnd, [null, null, null, 1, 0.8, 0.5, 0]);
        history.push({ assignment_id: id, assigned_at: day, purpose: 'retrain', result, score });
    }
    // 起算日：多半是新題那一天（批改卡勾選）；有時落在中間（練到會或移出之後重新加入）
    const entered_on = rnd() < 0.7 ? firstDay : plusDays(firstDay, intIn(rnd, 0, 60));
    const o = rnd();
    const teacher_override = o < 0.08 ? 'retired' : (o < 0.16 ? 'mastered' : null);
    const override_on = teacher_override ? plusDays(entered_on, intIn(rnd, 0, 40)) : null;
    return { input: { entered_on, teacher_override, override_on, history }, params };
}

/**
 * 參考實作：不逐筆模擬，而是看「這一輪最後一次答錯之後連對了幾次」。
 *   - 連對 ≥ K：練到會，日期＝那之後第 K 次答對的派題日
 *   - 否則進行中：連對 t 次＝第 t＋1 關，到期日＝最後一筆（或起算日）＋該關間隔
 */
function reference({ entered_on, teacher_override, override_on, history }, { stepDays, masteryStreak: K, stuckLapses }) {
    const graded = e => e.result === 0 || e.result === 1;
    const correct = e => Number(e.score === null || e.score === undefined ? e.result : e.score) >= 1;
    const sorted = [...history].sort((a, b) => (a.assigned_at === b.assigned_at
        ? a.assignment_id - b.assignment_id : (a.assigned_at < b.assigned_at ? -1 : 1)));

    const retrains = sorted.filter(e => e.purpose === 'retrain' && graded(e));
    const lapses = retrains.filter(e => !correct(e)).length;
    // 已派出：還沒批改的重練派題，或起算日當天以後還沒批改的新題派題
    // （起算日之前的新題派題可能是批改不了的舊紀錄，不算；設計稿第 4.4 節）
    const pending = sorted.filter(e => !graded(e) && (e.purpose === 'retrain' || e.assigned_at >= entered_on));
    const cycle = retrains.filter(e => e.assigned_at >= entered_on);
    let lastWrong = -1;
    cycle.forEach((e, i) => { if (!correct(e)) lastWrong = i; });
    const tail = cycle.slice(lastWrong + 1);

    let state;
    if (tail.length >= K) {
        state = { status: 'mastered', step: K, due_on: null, streak: K, mastered_on: tail[K - 1].assigned_at };
    } else {
        const t = tail.length;
        const anchor = t > 0 ? tail[t - 1].assigned_at : (lastWrong >= 0 ? cycle[lastWrong].assigned_at : entered_on);
        state = { status: 'active', step: t + 1, due_on: plusDays(anchor, stepDays[t]), streak: t, mastered_on: null };
    }
    if (teacher_override === 'retired') {
        state = { ...state, status: 'retired', due_on: null };
    } else if (teacher_override === 'mastered') {
        state = { ...state, status: 'mastered', due_on: null, mastered_on: state.mastered_on ?? override_on };
    }
    return {
        ...state,
        lapses,
        last_attempt_on: retrains.length ? retrains[retrains.length - 1].assigned_at : null,
        in_flight: pending.length > 0,
        in_flight_since: pending.length ? pending[0].assigned_at : null,
        stuck: state.status === 'active' && lapses >= stuckLapses
    };
}

describe(`TC-038-4：隨機作答歷史（種子 ${SEED}，${CASES} 組）`, () => {
    const rnd = prng(SEED);
    const cases = Array.from({ length: CASES }, () => makeCase(rnd));

    test('情境涵蓋：練到會、卡關、已派出、移出、同日多筆、重新加入都有出現', () => {
        const states = cases.map(c => computeRetrainState(c.input, c.params));
        const count = pred => states.filter(pred).length;
        assert.ok(count(s => s.status === 'mastered') > 20);
        assert.ok(count(s => s.status === 'retired') > 20);
        assert.ok(count(s => s.stuck) > 20);
        assert.ok(count(s => s.in_flight) > 20);
        assert.ok(count(s => s.status === 'active' && !s.in_flight) > 100);
        assert.ok(cases.filter(c => {
            const days = c.input.history.filter(e => e.purpose === 'retrain').map(e => e.assigned_at);
            return new Set(days).size < days.length;
        }).length > 50, '同一天多筆');
        assert.ok(cases.filter(c => c.input.history.some(e => e.purpose === 'retrain' && e.assigned_at < c.input.entered_on)).length > 50,
            '重新加入之前那一輪的作答');
    });

    test('與參考實作逐欄相同', () => {
        cases.forEach((c, i) => {
            assert.deepEqual(computeRetrainState(c.input, c.params), reference(c.input, c.params), `第 ${i} 組：${JSON.stringify(c)}`);
        });
    });

    test('輸入順序打亂，結果相同', () => {
        const r2 = prng(SEED + 1);
        cases.forEach((c, i) => {
            const shuffled = { ...c.input, history: shuffle(r2, c.input.history) };
            assert.deepEqual(computeRetrainState(shuffled, c.params), computeRetrainState(c.input, c.params), `第 ${i} 組`);
        });
    });

    test('情境涵蓋：手動加入以前的題、那一筆舊的新題派題一直沒批改（審查 major 的情境）', () => {
        const legacy = cases.filter(c => c.input.history.some(e => e.purpose === 'new' && e.result === null &&
            e.assigned_at < c.input.entered_on));
        assert.ok(legacy.length > 10, `只有 ${legacy.length} 組`);
        const notBlocked = legacy.filter(c => !computeRetrainState(c.input, c.params).in_flight);
        assert.ok(notBlocked.length > 5, '其中沒有其他未批改派題的，不算已派出');
    });

    test('逐筆批改（隨機先後、中途改判與取消批改）：每一個中間狀態都與參考實作相同', () => {
        // 純函式每次都從頭重算，「最後一次重算＝直接算最終歷史」本身必然成立，驗不到東西；
        // 這裡改驗「部分批改、改判到一半、取消批改」這些中間歷史，每一個都與參考實作逐欄相同，
        // 等於在 1,000 組之外再多驗上萬組半批改的歷史。
        // 排程快取與作答歷史一致（不變量 I7）的風險在 PR-2 的 I/O 層（同一交易內更新快取），
        // 由 retrain.pg.test.js 的 TC-038-3／TC-038-4 整合測試驗，不在這支單元測試。
        const r3 = prng(SEED + 2);
        let checked = 0;
        cases.forEach((c, i) => {
            const final = c.input.history;
            const check = (live, when) => {
                const input = { ...c.input, history: live.map(e => ({ ...e })) };
                assert.deepEqual(computeRetrainState(input, c.params), reference(input, c.params), `第 ${i} 組（${when}）`);
                checked += 1;
            };
            // 從「全部派出、都還沒批改」開始
            const live = final.map(e => ({ ...e, result: null, score: null }));
            check(live, '全部未批改');
            for (const idx of shuffle(r3, final.map((_, k) => k))) {
                // 三成的機會先批成別的結果（之後改判）或先取消批改一次
                if (r3() < 0.3) {
                    live[idx] = { ...live[idx], result: pickOne(r3, [0, 1]), score: pickOne(r3, [null, 0.5, 1]) };
                    check(live, `先批第 ${idx} 筆`);
                    if (r3() < 0.5) {
                        live[idx] = { ...live[idx], result: null, score: null };
                        check(live, `取消批改第 ${idx} 筆`);
                    }
                }
                live[idx] = { ...final[idx] };
                check(live, `第 ${idx} 筆改成最終結果`);
            }
        });
        assert.ok(checked > 5000, `中間狀態只有 ${checked} 個`);
    });

    test('全部未批改時：有重練派題、或起算日當天以後的新題派題，才算已派出', () => {
        cases.forEach((c, i) => {
            const live = c.input.history.map(e => ({ ...e, result: null, score: null }));
            const s = computeRetrainState({ ...c.input, history: live }, c.params);
            const expected = live.some(e => e.purpose === 'retrain' || e.assigned_at >= c.input.entered_on);
            assert.equal(s.in_flight, expected, `第 ${i} 組`);
        });
    });

    test('不變量：只有進行中有到期日；進行中時 關卡＝連對＋1、連對 < K；卡關只在進行中；已派出不到期', () => {
        cases.forEach((c, i) => {
            const s = computeRetrainState(c.input, c.params);
            const K = c.params.masteryStreak;
            assert.equal(s.status === 'active', s.due_on !== null, `第 ${i} 組 I5`);
            assert.ok(s.step >= 1 && s.step <= K, `第 ${i} 組 step`);
            assert.ok(s.lapses >= 0);
            if (s.status === 'active') {
                assert.equal(s.step, s.streak + 1, `第 ${i} 組`);
                assert.ok(s.streak < K, `第 ${i} 組`);
                assert.ok(s.due_on >= c.input.entered_on, `第 ${i} 組：到期日不早於起算日`);
                assert.equal(s.mastered_on, null);
            }
            if (s.status === 'mastered') assert.ok(s.mastered_on !== null, `第 ${i} 組`);
            if (s.stuck) assert.equal(s.status, 'active');
            if (s.in_flight) assert.equal(isDue(s, '2099-12-31'), false);
        });
    });
});
