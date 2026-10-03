// ─────────────────────────────────────────────────────────────
// test/unit/remedialEffect.test.js — 補救成效追蹤的純函式（〔dec/r16-remedial〕；docs/remedial.md 第 10 節）
//
//   utils/remedialTargets.js         confirm-paper 的 kind／targets 驗證（只收列出的鍵、白名單、數字範圍、單科、不重複）
//   services/remedialEffectService.js 狀態判斷（門檻邊界）、起算時間、目標成效的組裝、SQL 的參數順序與 R10
//   controllers/remedialController.js 查詢參數（limit、days）
//   migrations/0022                   檔案層級：只新增、可重複套用
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// controller 在模組頂層 require config/db（缺 DATABASE_URL 會直接丟錯）；這裡只用純函式，不會連線
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';

const { parseConfirmKind, MAX_TARGETS } = require('../../utils/remedialTargets');
const E = require('../../services/remedialEffectService');
const { _internals: { parseEffectQuery } } = require('../../controllers/remedialController');

const chapterTarget = (over = {}) => ({
    unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial',
    baseline: { graded: 6, wrong: 5, wrong_rate: 0.8333, low_sample: false }, ...over
});

describe('parseConfirmKind（confirm-paper 的 kind／targets）', () => {
    test('兩個都沒帶（或 null）→ value null（一般出卷，行為不變）', () => {
        assert.deepEqual(parseConfirmKind({}), { value: null });
        assert.deepEqual(parseConfirmKind({ kind: null, targets: null }), { value: null });
        assert.deepEqual(parseConfirmKind(undefined), { value: null });
    });

    test('合法：章節與知識點單位、各桶、error_focus；回傳重建過的物件', () => {
        const ts = [
            chapterTarget({ error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } }),
            { unit_type: 'kc', subject: '數學', chapter: '向量的加減與係數積', kc_id: 9, bucket: 'prerequisite',
                baseline: { graded: 0, wrong: 0, wrong_rate: null, low_sample: true } },
            chapterTarget({ chapter: '排列', bucket: 'extension', baseline: { graded: 1.5, wrong: 0.25, wrong_rate: 0.1667, low_sample: true } })
        ];
        const out = parseConfirmKind({ kind: 'remedial', targets: ts });
        assert.deepEqual(out, { value: { kind: 'remedial', targets: ts } });
        assert.notEqual(out.value.targets[0], ts[0], '不存呼叫端的參照');
        // error_focus: null 視同沒帶
        assert.deepEqual(parseConfirmKind({ kind: 'remedial', targets: [chapterTarget({ error_focus: null })] }).value.targets, [chapterTarget()]);
    });

    const bad = [
        ['只帶 targets', { targets: [chapterTarget()] }, /只能搭配 kind/],
        ['kind 不是 remedial', { kind: 'retrain', targets: [chapterTarget()] }, /kind 只接受/],
        ['kind 沒 targets', { kind: 'remedial' }, /targets 必填/],
        ['targets 空陣列', { kind: 'remedial', targets: [] }, /1~12 個目標/],
        ['targets 太多', { kind: 'remedial', targets: Array.from({ length: MAX_TARGETS + 1 }, () => chapterTarget()) }, /1~12 個目標/],
        ['targets 不是陣列', { kind: 'remedial', targets: { a: 1 } }, /陣列/],
        ['目標不是物件', { kind: 'remedial', targets: ['x'] }, /第 1 項 必須是物件/],
        ['多一個鍵', { kind: 'remedial', targets: [chapterTarget({ name: '向量內積' })] }, /不認得的鍵：name/],
        ['缺 baseline', { kind: 'remedial', targets: [{ unit_type: 'chapter', subject: '數學', chapter: '向量內積', bucket: 'remedial' }] }, /缺少：baseline/],
        ['unit_type 錯', { kind: 'remedial', targets: [chapterTarget({ unit_type: 'volume' })] }, /unit_type/],
        ['科目不在白名單', { kind: 'remedial', targets: [chapterTarget({ subject: '生物' })] }, /科目白名單/],
        ['章節不在白名單', { kind: 'remedial', targets: [chapterTarget({ chapter: '不存在的章' })] }, /章節白名單/],
        ['章節屬於別科', { kind: 'remedial', targets: [chapterTarget({ chapter: '靜電學' })] }, /章節白名單/],
        ['章節單位帶 kc_id', { kind: 'remedial', targets: [chapterTarget({ kc_id: 3 })] }, /不可帶 kc_id/],
        ['知識點單位沒 kc_id', { kind: 'remedial', targets: [chapterTarget({ unit_type: 'kc' })] }, /kc_id 必須是正整數/],
        ['kc_id 超過 int4', { kind: 'remedial', targets: [chapterTarget({ unit_type: 'kc', kc_id: 2147483648 })] }, /kc_id/],
        ['bucket 錯', { kind: 'remedial', targets: [chapterTarget({ bucket: 'prereq' })] }, /bucket/],
        ['baseline 多鍵', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 1, wrong: 1, wrong_rate: 1, low_sample: true, x: 1 } })] }, /baseline 不認得的鍵：x/],
        ['graded 負數', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: -1, wrong: 0, wrong_rate: 0, low_sample: true } })] }, /graded/],
        ['graded 不是數字', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: '6', wrong: 0, wrong_rate: 0, low_sample: true } })] }, /graded/],
        ['wrong > graded', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 2, wrong: 3, wrong_rate: 1, low_sample: true } })] }, /wrong 必須/],
        ['wrong_rate > 1', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 2, wrong: 2, wrong_rate: 1.5, low_sample: true } })] }, /wrong_rate/],
        ['graded 0 但 wrong_rate 有值', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 0, wrong: 0, wrong_rate: 0, low_sample: true } })] }, /必須是 null/],
        ['low_sample 不是布林', { kind: 'remedial', targets: [chapterTarget({ baseline: { graded: 1, wrong: 0, wrong_rate: 0, low_sample: 'no' } })] }, /low_sample/],
        ['error_focus 錯因不在白名單', { kind: 'remedial', targets: [chapterTarget({ error_focus: { type: 'lazy', count: 2, share: 1, applied: true } })] }, /錯因白名單/],
        ['error_focus 多鍵', { kind: 'remedial', targets: [chapterTarget({ error_focus: { type: 'calc', count: 2, share: 1, applied: true, label: 'x' } })] }, /不認得的鍵：label/],
        ['error_focus share > 1', { kind: 'remedial', targets: [chapterTarget({ error_focus: { type: 'calc', count: 2, share: 2, applied: true } })] }, /share/],
        ['延伸組帶 error_focus', { kind: 'remedial', targets: [chapterTarget({ bucket: 'extension', error_focus: { type: 'calc', count: 2, share: 1, applied: true } })] }, /不是補救組/],
        ['同組同單位重複', { kind: 'remedial', targets: [chapterTarget(), chapterTarget()] }, /重複/],
        ['混科', { kind: 'remedial', targets: [chapterTarget(), chapterTarget({ subject: '物理', chapter: '靜電學' })] }, /科目必須相同/]
    ];
    for (const [name, body, re] of bad) {
        test(`400：${name}`, () => {
            const out = parseConfirmKind(body);
            assert.ok(out.error, JSON.stringify(out));
            assert.match(out.error, re);
        });
    }
});

describe('effectStatus（門檻邊界）', () => {
    const st = (o) => E.effectStatus({ paperGraded: true, beforeRate: 0.2, afterGraded: 5, delta: 0, ...o });
    test('門檻是具名常數', () => {
        assert.deepEqual([E.IMPROVED_DELTA, E.WORSE_DELTA, E.MIN_AFTER_GRADED], [0.1, -0.1, 2]);
    });
    test('補救卷還沒批改完 → pending（不管其他數字）', () => {
        assert.equal(st({ paperGraded: false, delta: 0.5 }), 'pending');
    });
    test('補救前沒資料、之後沒資料、之後批改不到 2 題 → insufficient_data', () => {
        assert.equal(st({ beforeRate: null, delta: null }), 'insufficient_data');
        assert.equal(st({ afterGraded: 0, delta: null }), 'insufficient_data');
        assert.equal(st({ afterGraded: 1, delta: 0.8 }), 'insufficient_data');
        assert.equal(st({ afterGraded: 1.5, delta: 0.8 }), 'insufficient_data', '加權題數同樣比');
        assert.equal(st({ afterGraded: 2, delta: 0.8 }), 'improved');
    });
    test('進步、持平、退步的邊界（±0.10 算達標）', () => {
        assert.equal(st({ delta: 0.1 }), 'improved');
        assert.equal(st({ delta: 0.0999 }), 'no_change');
        assert.equal(st({ delta: 0 }), 'no_change');
        assert.equal(st({ delta: -0.0999 }), 'no_change');
        assert.equal(st({ delta: -0.1 }), 'worse');
        assert.equal(st({ delta: -0.6 }), 'worse');
    });
});

describe('paperAnchor、targetEffect', () => {
    test('全部批改完 → 以最後一題的批改時間起算；還有沒批改的（或卷上沒有題）→ 以建卷時間起算、graded = false', () => {
        const created = new Date('2026-10-01T02:00:00Z');
        const last = new Date('2026-10-02T09:00:00Z');
        assert.deepEqual(E.paperAnchor({ assigned: 5, graded: 5, created_at: created, last_graded_at: last }), { graded: true, anchor: last });
        assert.deepEqual(E.paperAnchor({ assigned: 5, graded: 4, created_at: created, last_graded_at: last }), { graded: false, anchor: created });
        assert.deepEqual(E.paperAnchor({ assigned: 0, graded: 0, created_at: created, last_graded_at: null }), { graded: false, anchor: created });
    });

    test('組裝：補救前答對率＝1 − 錯誤率、delta、low_sample（之後 < WEAKNESS_MIN_N）、知識點名稱', () => {
        const names = new Map([[9, { code: 'MATH.向量內積.01', name: '內積的意義' }]]);
        const t = E.targetEffect(chapterTarget({ error_focus: { type: 'concept', count: 3, share: 0.75, applied: true } }), {
            onPaper: { assigned: 5, graded: 5, correct: 3, papers: 1 },
            after: { assigned: 4, graded: 4, correct: 3, papers: 2 },
            paperGraded: true, minN: 5, names
        });
        assert.deepEqual(t, {
            unit_type: 'chapter', subject: '數學', chapter: '向量內積', name: '向量內積', bucket: 'remedial',
            error_focus: { type: 'concept', count: 3, share: 0.75, applied: true, label: '觀念不清' },
            before: { graded: 6, wrong: 5, wrong_rate: 0.8333, correct_rate: 0.1667, low_sample: false },
            on_paper: { assigned: 5, graded: 5, correct: 3, rate: 0.6 },
            after: { graded: 4, correct: 3, rate: 0.75, papers: 2 },
            delta: 0.5833, low_sample: true, status: 'improved'
        });
        const kc = E.targetEffect({ unit_type: 'kc', subject: '數學', chapter: '向量內積', kc_id: 9, bucket: 'remedial',
            baseline: { graded: 0, wrong: 0, wrong_rate: null, low_sample: true } },
        { onPaper: null, after: null, paperGraded: true, minN: 5, names });
        assert.deepEqual([kc.name, kc.code, kc.before.correct_rate, kc.after.rate, kc.delta, kc.status, kc.error_focus],
            ['內積的意義', 'MATH.向量內積.01', null, null, null, 'insufficient_data', null]);
        const gone = E.targetEffect({ unit_type: 'kc', subject: '數學', chapter: '向量內積', kc_id: 77, bucket: 'remedial',
            baseline: { graded: 1, wrong: 1, wrong_rate: 1, low_sample: true } }, { onPaper: null, after: null, paperGraded: false, minN: 5, names });
        assert.deepEqual([gone.name, gone.code, gone.status], ['知識點 #77', null, 'pending']);
    });
});

describe('SQL builder（參數順序、R10）', () => {
    test('補救卷清單：$1 studentId、$2 limit；只看 kind = remedial；批改進度看卷上全部派題', () => {
        const q = E.buildPapersQuery({ studentId: 3, limit: 10 });
        assert.deepEqual(q.values, [3, 10]);
        assert.match(q.text, /p\.kind = 'remedial'/);
        assert.match(q.text, /ORDER BY p\.created_at DESC, p\.id DESC/);
        assert.match(q.text, /assignment_attempts/);
    });
    test('成效聚合：$1 studentId、$2 目標 JSON、$3 paperId、$4 起算、$5 days；作答只讀檢視 attempts（第一次作答，R10）', () => {
        const anchor = new Date('2026-10-02T09:00:00Z');
        const q = E.buildEffectQuery({ studentId: 3, units: [{ idx: 0, unit_type: 'chapter', subject: '數學', chapter: '向量內積', kc_id: null }], paperId: 8, anchor, days: null });
        assert.deepEqual(q.values, [3, JSON.stringify([{ idx: 0, unit_type: 'chapter', subject: '數學', chapter: '向量內積', kc_id: null }]), 8, anchor, null]);
        assert.match(q.text, /FROM attempts a\b/);
        assert.ok(!/assignment_attempts|FROM assignments/.test(q.text), '不讀含重練的表');
        assert.match(q.text, /COALESCE\(a\.score::float8, a\.result::float8\)/);
        assert.match(q.text, /ep\.created_at > \$4::timestamptz/);
        assert.match(q.text, /kx\.subject = w\.subject/, '知識點只算同科標註');
        assert.equal(E.buildEffectQuery({ studentId: 3, units: [], paperId: 8, anchor, days: 30 }).values[4], 30);
    });
});

describe('parseEffectQuery', () => {
    test('預設 limit 10、days 不限；範圍外或不是整數 → 400', () => {
        assert.deepEqual(parseEffectQuery({}), { limit: 10, days: null });
        assert.deepEqual(parseEffectQuery({ limit: '3', days: '30' }), { limit: 3, days: 30 });
        assert.deepEqual(parseEffectQuery({ limit: '', days: '' }), { limit: 10, days: null });
        for (const q of [{ limit: '0' }, { limit: '51' }, { limit: '1.5' }, { limit: 'abc' }, { limit: ['1', '2'] }, { days: '0' }, { days: '366' }, { days: '-1' }]) {
            assert.ok(parseEffectQuery(q).error, JSON.stringify(q));
        }
    });
});

describe('migrations/0022（檔案層級）', () => {
    const SQL = fs.readFileSync(path.resolve(__dirname, '..', '..', 'migrations', '0022_paper_kind_targets.sql'), 'utf8');
    const body = SQL.replace(/--.*$/gm, '');
    test('只新增欄位與約束，可重複套用', () => {
        assert.match(body, /ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'normal'/);
        assert.match(body, /ADD COLUMN IF NOT EXISTS targets JSONB/);
        assert.match(body, /DROP CONSTRAINT IF EXISTS exam_papers_kind_check;/);
        assert.match(body, /CHECK \(kind IN \('normal', 'remedial', 'retrain'\)\)/);
        assert.match(body, /CREATE INDEX IF NOT EXISTS/);
        assert.ok(!/\bDROP (TABLE|COLUMN)\b|\bUPDATE\b|\bDELETE\b/i.test(body), '不刪不改既有資料');
    });
});
