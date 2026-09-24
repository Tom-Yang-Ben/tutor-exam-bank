// ─────────────────────────────────────────────────────────────
// coverageService 單元測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 4 項；G10）
//
// 覆蓋率的重點是「看見空洞」：沒有題的章也要列出來（total = 0），順序要跟白名單一致，
// 沒給學生時 unseen_by_student 是 null（不是 0——0 會被讀成「全寫過了」）。
// 這三件事都在 JS 端的組裝，不在 SQL，所以在這裡釘。SQL 由整合測試驗。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cov = require('../../services/coverageService');
const { VOLUMES, CHAPTERS, SUBJECTS } = require('../../config/chapters');

const dbRow = (subject, chapter, total, ds = [0, 0, 0, 0, 0], unseen = null) => ({
    subject, chapter, total, d1: ds[0], d2: ds[1], d3: ds[2], d4: ds[3], d5: ds[4], unseen
});

describe('assembleChapterRows', () => {
    test('指定科目時列出該科白名單的每一章（沒有題也列），順序 = 冊 → 章', () => {
        const rows = cov.assembleChapterRows([dbRow('數學', '向量內積', 3, [1, 1, 1, 0, 0])], { subject: '數學' });
        assert.equal(rows.length, CHAPTERS['數學'].length);
        assert.deepEqual(rows.map(r => r.chapter), CHAPTERS['數學']);
        const vec = rows.find(r => r.chapter === '向量內積');
        assert.equal(vec.total, 3);
        assert.equal(vec.volume, VOLUMES['數學'].find(v => v.chapters.includes('向量內積')).name);
        assert.deepEqual(vec.by_difficulty, { 1: 1, 2: 1, 3: 1, 4: 0, 5: 0 });
        const empty = rows.find(r => r.chapter === '實數');
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.by_difficulty, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    });

    test('by_difficulty 的鍵固定是字串 "1"～"5"', () => {
        const [row] = cov.assembleChapterRows([], { subject: '物理' });
        assert.deepEqual(Object.keys(row.by_difficulty), ['1', '2', '3', '4', '5']);
    });

    test('沒給學生 → unseen_by_student 為 null；給了 → 數字（沒題的章為 0）', () => {
        const without = cov.assembleChapterRows([dbRow('數學', '向量內積', 3)], { subject: '數學', withStudent: false });
        assert.ok(without.every(r => r.unseen_by_student === null));
        const withS = cov.assembleChapterRows([dbRow('數學', '向量內積', 3, undefined, 2)], { subject: '數學', withStudent: true });
        assert.equal(withS.find(r => r.chapter === '向量內積').unseen_by_student, 2);
        assert.equal(withS.find(r => r.chapter === '實數').unseen_by_student, 0);
    });

    test('沒指定科目 → 依 SUBJECTS 順序列出全部科目', () => {
        const rows = cov.assembleChapterRows([], {});
        const total = SUBJECTS.reduce((s, subj) => s + CHAPTERS[subj].length, 0);
        assert.equal(rows.length, total);
        assert.deepEqual([...new Set(rows.map(r => r.subject))], SUBJECTS);
    });

    test('不在白名單的舊章節接在該科最後、volume = null', () => {
        const rows = cov.assembleChapterRows([dbRow('數學', '舊章名B', 2), dbRow('數學', '舊章名A', 1)], { subject: '數學' });
        const tail = rows.slice(-2);
        assert.deepEqual(tail.map(r => [r.chapter, r.volume, r.total]), [['舊章名A', null, 1], ['舊章名B', null, 2]]);
    });
});

describe('orderKcRows', () => {
    test('依科目 → 章節白名單順序 → sort → code 排序，只留 code／name／chapter／total', () => {
        const rows = [
            { code: 'MATH.向量內積.02', name: '坐標', subject: '數學', chapter: '向量內積', sort: 2, total: 0 },
            { code: 'PHYS.靜電學.01', name: '庫侖', subject: '物理', chapter: '靜電學', sort: 1, total: 4 },
            { code: 'MATH.實數.01', name: '實數', subject: '數學', chapter: '實數', sort: 1, total: 1 },
            { code: 'MATH.向量內積.01', name: '意義', subject: '數學', chapter: '向量內積', sort: 1, total: 2 }
        ];
        const out = cov.orderKcRows(rows);
        assert.deepEqual(out.map(r => r.code), ['MATH.實數.01', 'MATH.向量內積.01', 'MATH.向量內積.02', 'PHYS.靜電學.01']);
        assert.deepEqual(Object.keys(out[0]), ['code', 'name', 'chapter', 'total']);
        assert.equal(out[2].total, 0);
    });
});

describe('SQL builder', () => {
    test('buildChapterCoverage：[subject, studentId]、只算未封存題', () => {
        const { text, values } = cov.buildChapterCoverage({ subject: '數學', studentId: 7 });
        assert.deepEqual(values, ['數學', 7]);
        assert.match(text, /q\.archived_at IS NULL/);
        assert.match(text, /\$2::int IS NULL THEN NULL/);
        assert.deepEqual(cov.buildChapterCoverage({}).values, [null, null]);
    });

    test('buildKcCoverage：[subject]、封存題不計入', () => {
        const { text, values } = cov.buildKcCoverage({ subject: '物理' });
        assert.deepEqual(values, ['物理']);
        assert.match(text, /q\.archived_at IS NULL/);
        assert.match(text, /LEFT JOIN question_kcs/);
    });
});

describe('loadCoverage', () => {
    test('兩條查詢、回 { rows, kc_rows }', async () => {
        const calls = [];
        const out = await cov.loadCoverage({ subject: '物理', studentId: null }, {
            async query(text, values) {
                calls.push(values);
                if (/knowledge_components/.test(text)) return { rows: [{ code: 'PHYS.靜電學.01', name: '庫侖', subject: '物理', chapter: '靜電學', sort: 1, total: 0 }] };
                return { rows: [dbRow('物理', '靜電學', 1, [0, 0, 1, 0, 0])] };
            }
        });
        assert.equal(calls.length, 2);
        assert.deepEqual(Object.keys(out), ['rows', 'kc_rows']);
        assert.equal(out.rows.length, CHAPTERS['物理'].length);
        assert.equal(out.kc_rows.length, 1);
    });
});
