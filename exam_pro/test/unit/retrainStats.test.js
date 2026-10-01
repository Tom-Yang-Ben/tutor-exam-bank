// ─────────────────────────────────────────────────────────────
// 重練成效（API-13）的純函式與參數驗證（錯題重練第二階段之三 PR-4；docs/retrain-and-review.md 第 5.2 節）
//
//   services/retrainStatsService.js  rateOf、tallyAttempts、byChapter、summarizeStats
//   utils/retrainValidation.js       parseStatsQuery（days 1～365、預設 90；subject 白名單；不認得的參數 400）
// 資料庫那一半（計數、答對率、時間窗、404）在 test/integration/retrainStats.pg.test.js（TC-040-1）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../../services/retrainStatsService');
const { parseStatsQuery, STATS_DEFAULT_DAYS } = require('../../utils/retrainValidation');
const { DEFAULTS } = require('../../config/retrain');

describe('retrainStatsService 的純函式', () => {
    test('rateOf：四捨五入到小數第 4 位；分母 0 回 null（沒批改不等於全錯）', () => {
        assert.equal(stats.rateOf(12, 18), 0.6667);
        assert.equal(stats.rateOf(17, 20), 0.85);
        assert.equal(stats.rateOf(2, 3), 0.6667);
        assert.equal(stats.rateOf(1, 3), 0.3333);
        assert.equal(stats.rateOf(3, 3), 1);
        assert.equal(stats.rateOf(0, 4), 0);
        assert.equal(stats.rateOf(0, 0), null);
    });

    test('tallyAttempts：第 1 關＝第一次重練、第 2 關以後＝隔週回測；全對才算對（R2：部分給分沒滿分算錯）', () => {
        // 第 4.5 節的例子：第 1 關 10/5 對、10/15 對；第 2 關以後 10/12 錯、10/22 對、11/5 對
        const rows = [
            { retrain_step: 1, result: 1, score: null },
            { retrain_step: 2, result: 0, score: null },
            { retrain_step: 1, result: 1, score: null },
            { retrain_step: 2, result: 1, score: null },
            { retrain_step: 3, result: 1, score: null }
        ];
        assert.deepEqual(stats.tallyAttempts(rows, DEFAULTS.correctThreshold), {
            first_retrain: { graded: 2, correct: 2, rate: 1 },
            spaced: { graded: 3, correct: 2, rate: 0.6667 }
        });
        const partial = [
            { retrain_step: 1, result: 1, score: 0.8 },   // 按對但給 80% → 算錯
            { retrain_step: 1, result: 0, score: 1 },     // 給 100% → 算對（COALESCE(score, result)）
            { retrain_step: 2, result: null, score: null } // 沒批改不算
        ];
        assert.deepEqual(stats.tallyAttempts(partial, DEFAULTS.correctThreshold), {
            first_retrain: { graded: 2, correct: 1, rate: 0.5 },
            spaced: { graded: 0, correct: 0, rate: null }
        });
    });

    test('byChapter：進過清單多的在前 → 進行中多的在前 → 章節名；沒有章節的排最後', () => {
        const items = [
            { chapter: '實數', status: 'active', stuck: false },
            { chapter: '向量內積', status: 'active', stuck: true },
            { chapter: '向量內積', status: 'mastered', stuck: false },
            { chapter: null, status: 'retired', stuck: false },
            { chapter: '直線運動', status: 'mastered', stuck: false }
        ];
        assert.deepEqual(stats.byChapter(items), [
            { chapter: '向量內積', entered: 2, mastered: 1, active: 1, stuck: 1 },
            { chapter: '實數', entered: 1, mastered: 0, active: 1, stuck: 0 },
            { chapter: '直線運動', entered: 1, mastered: 1, active: 0, stuck: 0 },
            { chapter: null, entered: 1, mastered: 0, active: 0, stuck: 0 }
        ]);
    });

    test('summarizeStats：第 5.2 節的形狀；題數是清單現況，backlog 只算到期（已派出、封存的不算）', () => {
        const items = [
            { chapter: '向量內積', status: 'active', stuck: true, due: true, overdue_days: 9 },
            { chapter: '向量內積', status: 'active', stuck: false, due: true, overdue_days: 7 },
            { chapter: '向量內積', status: 'active', stuck: false, due: true, overdue_days: 6 },
            { chapter: '向量內積', status: 'active', stuck: false, due: false, overdue_days: 0 },   // 已派出或還沒到
            { chapter: '實數', status: 'mastered', stuck: false, due: false, overdue_days: 0 },
            { chapter: '實數', status: 'retired', stuck: false, due: false, overdue_days: 0 }
        ];
        const out = stats.summarizeStats({
            items,
            attempts: [{ retrain_step: 1, result: 1, score: null }, { retrain_step: 2, result: 0, score: null }],
            params: DEFAULTS,
            since: '2026-06-28'
        });
        assert.deepEqual(Object.keys(out), ['entered', 'active', 'mastered', 'retired', 'stuck', 'first_retrain', 'spaced', 'backlog', 'by_chapter', 'since']);
        assert.deepEqual(out, {
            entered: 6, active: 4, mastered: 1, retired: 1, stuck: 1,
            first_retrain: { graded: 1, correct: 1, rate: 1 },
            spaced: { graded: 1, correct: 0, rate: 0 },
            backlog: { due_now: 3, overdue_7d: 2 },
            by_chapter: [
                { chapter: '向量內積', entered: 4, mastered: 0, active: 4, stuck: 1 },
                { chapter: '實數', entered: 2, mastered: 1, active: 0, stuck: 0 }
            ],
            since: '2026-06-28'
        });
        assert.equal(out.entered, out.active + out.mastered + out.retired);
        assert.equal(stats.OVERDUE_BACKLOG_DAYS, 7);
    });

    test('summarizeStats：空清單、沒有作答 → 全 0，答對率 null', () => {
        assert.deepEqual(stats.summarizeStats({ items: [], attempts: [], params: DEFAULTS, since: '2026-06-28' }), {
            entered: 0, active: 0, mastered: 0, retired: 0, stuck: 0,
            first_retrain: { graded: 0, correct: 0, rate: null },
            spaced: { graded: 0, correct: 0, rate: null },
            backlog: { due_now: 0, overdue_7d: 0 },
            by_chapter: [],
            since: '2026-06-28'
        });
    });
});

describe('parseStatsQuery（API-13 的查詢參數）', () => {
    test('預設 days = 90、不分科；空字串等於沒給', () => {
        assert.equal(STATS_DEFAULT_DAYS, 90);
        assert.deepEqual(parseStatsQuery({}), { days: 90, subject: null });
        assert.deepEqual(parseStatsQuery({ days: '', subject: '' }), { days: 90, subject: null });
        assert.deepEqual(parseStatsQuery({ days: '365', subject: '數學' }), { days: 365, subject: '數學' });
        assert.deepEqual(parseStatsQuery({ days: ' 30 ', subject: ' 化學 ' }), { days: 30, subject: '化學' });
        assert.deepEqual(parseStatsQuery(undefined), { days: 90, subject: null });
    });

    test('days 不是 1～365 的整數、subject 不在白名單、不認得或重複的參數 → 400 訊息', () => {
        for (const bad of ['0', '366', '1.5', 'abc', '-3', '1e2', '030']) {
            assert.deepEqual(parseStatsQuery({ days: bad }), { error: 'days 必須是 1~365 的整數。' }, bad);
        }
        assert.deepEqual(parseStatsQuery({ subject: '國文' }), { error: 'subject 不在白名單內。' });
        assert.deepEqual(parseStatsQuery({ day: '30' }), { error: '不認得的查詢參數：day（可用：days、subject）。' });
        assert.deepEqual(parseStatsQuery({ days: ['30', '60'] }), { error: 'days 只能給一個值。' });
    });
});
