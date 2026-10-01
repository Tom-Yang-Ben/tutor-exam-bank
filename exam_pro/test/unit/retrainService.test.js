// ─────────────────────────────────────────────────────────────
// test/unit/retrainService.test.js — services/retrainService.js 的純函式、CLI 參數、0017 與 0018 的靜態檢查
// （〔retrain PR-2〕docs/retrain-and-review.md 第 4.4、4.7、5.2 節）
//
// I/O 的部分（鎖、交易、重算寫回）在 test/integration/retrain.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../../services/retrainService');
const { DEFAULTS } = require('../../config/retrain');
const cli = require('../../scripts/recompute_retrain');

const M2_RAW = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0017_retrain_items.sql'), 'utf8');
/** 去掉 -- 註解後的 SQL（計數時不算註解裡的字） */
const M2 = M2_RAW.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

describe('關卡名稱（stepLabel）', () => {
    test('Owner 的參數：錯題重練／一週回測／兩週回測', () => {
        assert.deepEqual([1, 2, 3].map(s => svc.stepLabel(s, DEFAULTS.stepDays)), ['錯題重練', '一週回測', '兩週回測']);
    });
    test('改過間隔時：整週寫週、否則寫天數；超出間隔表寫第 n 關', () => {
        assert.deepEqual([2, 3, 4].map(s => svc.stepLabel(s, [1, 7, 10, 28])), ['一週回測', '隔 10 天回測', '四週回測']);
        assert.equal(svc.stepLabel(5, [1, 7, 14]), '第 5 關');
        assert.equal(svc.stepLabel(2, [1, 0]), '隔 0 天回測');
    });
});

describe('已派出（pendingOf，照純函式 countsAsInFlight）', () => {
    const e = (id, purpose, assigned_at, result = null) => ({ assignment_id: id, purpose, assigned_at, result, score: null });
    test('重練派題沒批改一律算；新題派題只有派題日 ≥ 起算日才算；批改過的不算', () => {
        const hist = [
            e(1, 'new', '2025-01-01'),              // 手動加入以前的舊紀錄：不算
            e(2, 'retrain', '2026-09-20', 1),       // 批改過：不算
            e(3, 'retrain', '2026-09-01'),          // 上一輪沒批改的重練：算
            e(4, 'new', '2026-09-26')               // 起算日當天的新題：算
        ];
        assert.deepEqual(svc.pendingOf(hist, '2026-09-26').map(h => h.assignment_id), [3, 4]);
        assert.deepEqual(svc.pendingOf([e(1, 'new', '2025-01-01')], '2026-09-26'), []);
        assert.deepEqual(svc.pendingOf(null, '2026-09-26'), []);
    });
});

describe('排序（第 4.7 節）與承上組單位', () => {
    const v = (question_id, o = {}) => ({
        question_id, due: false, overdue_days: 0, status: 'active', due_on: '2026-10-20', step: 1, lapses: 0, group_ids: [question_id], ...o
    });

    test('到期的在前：逾期天數多 → 關卡小 → 錯次數多 → 題號小', () => {
        const items = [
            v(50, { due: true, overdue_days: 2, step: 2 }),
            v(40, { due: true, overdue_days: 2, step: 1 }),
            v(30, { due: true, overdue_days: 4, lapses: 0 }),
            v(20, { due: true, overdue_days: 4, lapses: 1 }),
            v(10, { due: true, overdue_days: 9 }),
            v(5, { due: true, overdue_days: 4, lapses: 1 })
        ];
        assert.deepEqual(svc.orderUnits(items).flatMap(u => u.items.map(i => i.question_id)), [10, 5, 20, 30, 40, 50]);
    });

    test('沒到期的在後：進行中依到期日 → 練到會 → 移出', () => {
        const items = [
            v(1, { status: 'retired', due_on: null }),
            v(2, { status: 'mastered', due_on: null }),
            v(3, { due_on: '2026-10-30' }),
            v(4, { due_on: '2026-10-13' }),
            v(5, { due: true, overdue_days: 0, due_on: '2026-10-12' })
        ];
        assert.deepEqual(svc.orderUnits(items).flatMap(u => u.items.map(i => i.question_id)), [5, 4, 3, 2, 1]);
    });

    test('承上組以組為單位、依組內最急的一題排序，組內依承接順序（group_ids）相鄰', () => {
        const g = [7, 8, 9];
        const items = [
            v(9, { group_ids: g, due: true, overdue_days: 1 }),
            v(3, { due: true, overdue_days: 5 }),
            v(8, { group_ids: g, due: true, overdue_days: 6 }),
            v(7, { group_ids: g }),
            v(1, { due: true, overdue_days: 3 })
        ];
        const units = svc.orderUnits(items);
        assert.deepEqual(units.map(u => u.items.map(i => i.question_id)), [[7, 8, 9], [3], [1]]);
        assert.deepEqual(units[0].group_ids, g);
    });

    test('priorityKey 的欄位順序', () => {
        assert.deepEqual(svc.priorityKey(v(4, { due: true, overdue_days: 3, step: 2, lapses: 1, due_on: '2026-10-09' })),
            [0, -3, 0, '2026-10-09', 2, -1, 4]);
        assert.deepEqual(svc.priorityKey(v(4, { status: 'mastered', due_on: null })), [1, -0, 1, '9999-12-31', 1, -0, 4]);
    });
});

describe('畫面資料（buildItemView）與 counts', () => {
    const row = {
        id: 31, question_id: 812, subject: '數學', chapter: '向量內積', difficulty: 3, question_type: '填空',
        question_text: '設 $\\vec a=(1,2)$，求 $|\\vec a|$。', follows_question_id: null, archived: false,
        reason: 'flagged', entered_on: '2026-10-01', status: 'active', step: 2, due_on: '2026-10-12', streak: 1, lapses: 0,
        last_attempt_on: '2026-10-05', mastered_on: null, teacher_override: null, override_on: null, note: null
    };
    const hist = [
        { assignment_id: 5501, paper_id: 88, assigned_at: '2026-10-01', purpose: 'new', retrain_step: null, result: 0, score: null, error_types: ['calc'] },
        { assignment_id: 5630, paper_id: 91, assigned_at: '2026-10-05', purpose: 'retrain', retrain_step: 1, result: 1, score: null, error_types: [] }
    ];
    const ctx = { history: hist, groupIds: [812], params: DEFAULTS, asOf: '2026-10-12', today: '2026-10-10' };

    test('形狀同設計稿 API-1 的例子（另加 entered_on、in_flight_since、in_flight_warn、last_attempt_on、override_on、note）', () => {
        const out = svc.buildItemView(row, ctx);
        assert.deepEqual(out, {
            item_id: 31, question_id: 812, subject: '數學', chapter: '向量內積', difficulty: 3, question_type: '填空',
            question_text_preview: '設 $\\vec a=(1,2)$，求 $|\\vec a|$。', archived: false,
            reason: 'flagged', entered_on: '2026-10-01', status: 'active', step: 2, step_label: '一週回測',
            due_on: '2026-10-12', due: true, overdue_days: 0,
            in_flight: false, in_flight_paper_id: null, in_flight_since: null, in_flight_warn: false,
            streak: 1, lapses: 0, stuck: false, last_attempt_on: '2026-10-05', mastered_on: null,
            teacher_override: null, override_on: null, note: null,
            group_ids: [812], follows_question_id: null,
            history: hist
        });
    });

    test('已派出：不算到期、帶最早那張卷；超過 14 天未批改才提醒；封存不算到期；錯 3 次卡關', () => {
        const pending = { assignment_id: 5700, paper_id: 95, assigned_at: '2026-10-11', purpose: 'retrain', retrain_step: 2, result: null, score: null, error_types: [] };
        const a = svc.buildItemView(row, { ...ctx, history: [...hist, pending], today: '2026-10-25' });
        assert.deepEqual([a.in_flight, a.in_flight_paper_id, a.in_flight_since, a.in_flight_warn, a.due], [true, 95, '2026-10-11', false, false]);
        assert.equal(svc.buildItemView(row, { ...ctx, history: [...hist, pending], today: '2026-10-26' }).in_flight_warn, true);
        assert.equal(svc.IN_FLIGHT_WARN_DAYS, 14);
        assert.equal(svc.buildItemView({ ...row, archived: true }, ctx).due, false);
        const stuck = svc.buildItemView({ ...row, lapses: 3 }, ctx);
        assert.equal(stuck.stuck, true);
        assert.equal(svc.buildItemView({ ...row, lapses: 3, status: 'retired', due_on: null }, ctx).stuck, false, '移出的不算卡關');
        assert.deepEqual(svc.countViews([a, stuck, { ...stuck, status: 'mastered', stuck: false, due: false }]),
            { active: 2, due: 1, in_flight: 1, stuck: 1, mastered: 1, retired: 0 });
    });
});

describe('批改回應的 retrain 摘要（summarizeChanges）', () => {
    const c = (item_id, before, after) => ({ item_id, before, after });
    const s = (status, step, lapses) => ({ status, step, lapses });
    test('entered／advanced／mastered／reset；這次才進清單的只算 entered', () => {
        const out = svc.summarizeChanges([
            c(1, s('active', 1, 0), s('active', 2, 0)),      // 升關
            c(2, s('active', 3, 0), s('mastered', 3, 0)),    // 練到會
            c(3, s('active', 2, 0), s('active', 1, 1)),      // 答錯回第一關
            c(4, s('active', 1, 1), s('active', 1, 2)),      // 第 1 關又錯：也算回第一關
            c(5, s('active', 1, 0), s('active', 1, 0)),      // 沒變
            c(6, s('retired', 1, 0), s('active', 1, 0)),     // 重新加入（entered）
            c(7, s('mastered', 3, 0), s('active', 1, 1))     // 已會的同組題被帶著出又錯
        ], new Set([6, 99]));
        assert.deepEqual(out, { entered: 2, advanced: 1, mastered: 1, reset: 3 });
    });
});

describe('scripts/recompute_retrain.js', () => {
    test('參數', () => {
        assert.deepEqual(cli.parseArgs([]), { dryRun: false, test: false, studentId: null, help: false });
        assert.deepEqual(cli.parseArgs(['--dry-run', '--student', '3', '--test']), { dryRun: true, test: true, studentId: 3, help: false });
        assert.throws(() => cli.parseArgs(['--student']), /--student 後面要接學生 id/);
        assert.throws(() => cli.parseArgs(['--student', 'x']), /--student 後面要接學生 id/);
        assert.throws(() => cli.parseArgs(['--rebuild']), /未知的參數「--rebuild」/);
    });
    test('報告只有題數與學生數（不印姓名）', () => {
        const lines = cli.formatReport({ total: 5, updated: 2, students: 2, dryRun: true, statuses: { active: 3, mastered: 1, retired: 1 } }, DEFAULTS);
        assert.deepEqual(lines, [
            '排程參數：每關間隔 1,7,14 天、連對 3 次練到會、錯 3 次標卡關',
            '重算 5 個項目（2 位學生）；會更新 2 個項目（dry-run，已 ROLLBACK，未寫入）',
            '各狀態題數：進行中 3、練到會 1、移出 1'
        ]);
    });
    test('package.json 有 retrain:recompute', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['retrain:recompute'], 'node scripts/recompute_retrain.js');
    });
});

describe('migrations/0017 的靜態檢查（冪等寫法）', () => {
    test('CREATE … IF NOT EXISTS、ADD COLUMN IF NOT EXISTS、約束先判斷再加、檢視 CREATE OR REPLACE', () => {
        assert.match(M2, /CREATE TABLE IF NOT EXISTS retrain_items/);
        assert.match(M2, /ALTER TABLE assignments ADD COLUMN IF NOT EXISTS retrain_item_id BIGINT;/);
        assert.match(M2, /ALTER TABLE assignments ADD COLUMN IF NOT EXISTS retrain_step\s+SMALLINT;/);
        for (const n of ['assignments_retrain_step_check', 'assignments_retrain_link_check', 'assignments_retrain_item_fk']) {
            assert.match(M2, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint\\s+WHERE conrelid = 'assignments'::regclass AND conname = '${n}'\\)`), n);
        }
        assert.match(M2, /CREATE OR REPLACE VIEW assignment_attempts AS/);
        assert.equal((M2.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 3);
        assert.doesNotMatch(M2, /INSERT INTO retrain_items/, '不補建任何項目（R11 選 3）');
    });
    test('兩個複合外鍵是 DEFERRABLE INITIALLY IMMEDIATE（合併學生時延後檢查）', () => {
        assert.equal((M2.match(/DEFERRABLE INITIALLY IMMEDIATE/g) || []).length, 2);
        assert.deepEqual(svc.DEFERRABLE_CONSTRAINTS, ['assignments_retrain_item_fk', 'retrain_items_source_fk']);
    });
});

describe('migrations/0018 的靜態檢查（審查修正：移出的來源；冪等寫法）', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0018_retrain_unflag_marker.sql'), 'utf8');
    const sql = raw.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    test('ADD COLUMN IF NOT EXISTS（預設 false：既有項目照舊保留）、約束先判斷再加；不搬資料、不動 0017', () => {
        assert.match(sql, /ALTER TABLE retrain_items ADD COLUMN IF NOT EXISTS retired_by_unflag BOOLEAN NOT NULL DEFAULT false;/);
        assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint\s+WHERE conrelid = 'retrain_items'::regclass AND conname = 'retrain_items_unflag_check'\)/);
        assert.match(sql, /CHECK \(NOT retired_by_unflag OR teacher_override IS NOT DISTINCT FROM 'retired'\)/, 'teacher_override 是 NULL 時也要擋（CHECK 遇到 NULL 會放行）');
        assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/, '只加欄位與約束');
        assert.doesNotMatch(M2, /retired_by_unflag/, '0017 已凍結，沒被改動');
    });
});
