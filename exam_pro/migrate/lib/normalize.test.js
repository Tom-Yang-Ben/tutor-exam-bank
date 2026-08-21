// migrate/lib/normalize.test.js — D-D5a 的純函式測試
//
// 不連 DB、不呼叫 Gemini、不需要任何 secrets；`npm test`（node --test）會自動收進來。
// 測試資料全部是自己編的假姓名，不含任何真實學生資料。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeName,
    pgNormalizeSql,
    suspectKey,
    parseHistory,
    flattenHistory,
    buildMergeReport,
    renderMergeReport
} = require('./normalize');

// ── normalizeName ────────────────────────────────────────────
test('normalizeName：只有 trim 的一般情況', () => {
    assert.equal(normalizeName('  王小明  '), '王小明');
    assert.equal(normalizeName('王小明'), '王小明');
});

test('normalizeName：去掉雙引號與反斜線（history 鍵與試卷姓名的差異來源）', () => {
    assert.equal(normalizeName('王"小明'), '王小明');
    assert.equal(normalizeName('王\\小明'), '王小明');
    assert.equal(normalizeName('"王\\小明"'), '王小明');
});

test('normalizeName：去字元後要再 trim 一次（外層 trim 削不到內縮的空白）', () => {
    assert.equal(normalizeName('" 王小明 "'), '王小明');
    assert.equal(normalizeName('  \\ 王小明 \\  '), '王小明');
});

test('normalizeName：正規化後可能為空', () => {
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName('   '), '');
    assert.equal(normalizeName('"""'), '');
    assert.equal(normalizeName('\\\\'), '');
    assert.equal(normalizeName(' " \\ "  '), '');
});

test('normalizeName：null／undefined／數字都不拋例外', () => {
    assert.equal(normalizeName(null), '');
    assert.equal(normalizeName(undefined), '');
    assert.equal(normalizeName(12345), '12345');
});

test('normalizeName：全形空白與異體字刻意不動（交給人判斷）', () => {
    assert.equal(normalizeName('王　小明'), '王　小明');   // U+3000 保留
    assert.equal(normalizeName(' 王　小明 '), '王　小明');
    assert.notEqual(normalizeName('王 小明'), normalizeName('王　小明'));
});

test('normalizeName：內部的半形空白保留（「王 小明」不等於「王小明」）', () => {
    assert.equal(normalizeName(' 王 小明 '), '王 小明');
});

// ── pgNormalizeSql ───────────────────────────────────────────
test('pgNormalizeSql：兩層 btrim + translate，且不含字面反斜線', () => {
    const sql = pgNormalizeSql('e.key');
    assert.equal(sql, `btrim(translate(btrim(e.key), '"' || chr(92), ''))`);
    assert.ok(!sql.includes('\\'), '不得出現字面反斜線，避免受 standard_conforming_strings 影響');
});

// ── suspectKey ───────────────────────────────────────────────
test('suspectKey：NFKC + 去所有空白，讓全半形差異被「提示」出來', () => {
    assert.equal(suspectKey('王　小明'), '王小明');
    assert.equal(suspectKey('王 小明'), '王小明');
    assert.equal(suspectKey('Ｗａｎｇ'), 'Wang');
});

// ── parseHistory / flattenHistory ────────────────────────────
test('parseHistory：物件、JSON 字串、壞資料', () => {
    assert.deepEqual(parseHistory({ 甲: '2026-01-01' }), { 甲: '2026-01-01' });
    assert.deepEqual(parseHistory('{"甲":"2026-01-01"}'), { 甲: '2026-01-01' });
    assert.deepEqual(parseHistory('{壞掉的 JSON'), {});
    assert.deepEqual(parseHistory(null), {});
    assert.deepEqual(parseHistory(''), {});
    assert.deepEqual(parseHistory('[1,2]'), {});
});

test('flattenHistory：一個鍵一筆，帶上 question_id 與日期', () => {
    const rows = [
        { id: 1, history_json: { 甲: '2026-01-01', 乙: '2026-01-02' } },
        { id: 2, history_json: '{}' }
    ];
    assert.deepEqual(flattenHistory(rows), [
        { name: '甲', questionId: 1, date: '2026-01-01' },
        { name: '乙', questionId: 1, date: '2026-01-02' }
    ]);
});

// ── buildMergeReport ─────────────────────────────────────────
test('buildMergeReport：空輸入的形狀正確', () => {
    const r = buildMergeReport({});
    assert.deepEqual(r.students, []);
    assert.deepEqual(r.merges, []);
    assert.deepEqual(r.collisions, []);
    assert.deepEqual(r.suspects, []);
    assert.equal(r.totals.attemptsExpected, 0);
});

test('buildMergeReport：兩邊規則不同造成的合併會被列出來', () => {
    const r = buildMergeReport({
        historyKeys: [{ name: '王小明', questionId: 1, date: '2026-01-01' }],
        paperNames: [{ name: '王"小明', paperId: 7 }]
    });
    assert.equal(r.students.length, 1);
    assert.equal(r.students[0].name, '王小明');
    assert.equal(r.merges.length, 1);
    assert.deepEqual(r.merges[0].rawForms, [
        { raw: '王"小明', history: 0, paper: 1 },
        { raw: '王小明', history: 1, paper: 0 }
    ]);
});

test('buildMergeReport：字串本來就一致時不產生合併項', () => {
    const r = buildMergeReport({
        historyKeys: [{ name: '陳大文', questionId: 1, date: '2026-01-01' }],
        paperNames: [{ name: '陳大文', paperId: 1 }]
    });
    assert.equal(r.merges.length, 0);
    assert.equal(r.students[0].rawForms.length, 1);
});

test('buildMergeReport：同一題撞在一起的鍵只留最早日期，並列入 collisions', () => {
    const r = buildMergeReport({
        historyKeys: [
            { name: '王"小明', questionId: 3, date: '2026-03-05' },
            { name: '王小明', questionId: 3, date: '2026-01-09' }
        ]
    });
    assert.equal(r.totals.historyKeys, 2);
    assert.equal(r.totals.attemptsExpected, 1, '兩個鍵指向同一人同一題，attempts 只能有一列');
    assert.equal(r.collisions.length, 1);
    assert.equal(r.collisions[0].questionId, 3);
    assert.equal(r.collisions[0].kept, '2026-01-09');
});

test('buildMergeReport：不同題的同名鍵不算 collision', () => {
    const r = buildMergeReport({
        historyKeys: [
            { name: '王小明', questionId: 1, date: '2026-01-01' },
            { name: '王小明', questionId: 2, date: '2026-01-02' }
        ]
    });
    assert.equal(r.collisions.length, 0);
    assert.equal(r.totals.attemptsExpected, 2);
});

test('buildMergeReport：正規化後為空的鍵與試卷姓名分別落到 dropped', () => {
    const r = buildMergeReport({
        historyKeys: [{ name: '  ', questionId: 5, date: '2026-01-01' }],
        paperNames: [{ name: '"', paperId: 9 }]
    });
    assert.deepEqual(r.dropped.historyKeys, [{ raw: '  ', questionId: 5 }]);
    assert.deepEqual(r.dropped.paperNames, [{ raw: '"', paperId: 9 }]);
    assert.equal(r.totals.historyKeysDropped, 1);
    assert.equal(r.totals.papersDropped, 1);
    assert.equal(r.totals.attemptsExpected, 0);
    assert.equal(r.students.length, 0);
});

test('buildMergeReport：全形／半形空白只提示不合併', () => {
    const r = buildMergeReport({
        historyKeys: [
            { name: '王 小明', questionId: 1, date: '2026-01-01' },
            { name: '王　小明', questionId: 1, date: '2026-01-02' }
        ]
    });
    assert.equal(r.students.length, 2, '兩個名字仍各自建一列 students');
    assert.equal(r.merges.length, 0);
    assert.equal(r.suspects.length, 1);
    assert.deepEqual(r.suspects[0].names.slice().sort(), ['王 小明', '王　小明'].sort());
    assert.equal(r.totals.attemptsExpected, 2, '沒有自動合併，所以是兩列 attempts');
});

test('buildMergeReport：students 依姓名排序，rawForms 依原始字串排序（輸出必須可重現）', () => {
    const a = buildMergeReport({
        historyKeys: [
            { name: '乙', questionId: 1, date: '2026-01-01' },
            { name: '甲', questionId: 1, date: '2026-01-01' }
        ]
    });
    const b = buildMergeReport({
        historyKeys: [
            { name: '甲', questionId: 1, date: '2026-01-01' },
            { name: '乙', questionId: 1, date: '2026-01-01' }
        ]
    });
    assert.deepEqual(a.students.map(s => s.name), b.students.map(s => s.name));
    assert.deepEqual(a.students.map(s => s.name), ['乙', '甲'].sort((x, y) => (x < y ? -1 : 1)));
});

test('buildMergeReport：綜合情境的統計數字', () => {
    const r = buildMergeReport({
        historyKeys: [
            { name: '王小明', questionId: 1, date: '2026-01-01' },
            { name: '王"小明', questionId: 1, date: '2026-02-01' },  // 與上一筆撞在同一題
            { name: '王小明', questionId: 2, date: '2026-01-03' },
            { name: '林小美', questionId: 2, date: '2026-01-04' },
            { name: ' \\ ', questionId: 2, date: '2026-01-05' }        // 正規化後為空
        ],
        paperNames: [
            { name: '王小明', paperId: 1 },
            { name: '林小美', paperId: 2 }
        ]
    });
    assert.equal(r.totals.historyKeys, 5);
    assert.equal(r.totals.historyKeysDropped, 1);
    assert.equal(r.totals.attemptsExpected, 3);   // (王小明,1) (王小明,2) (林小美,2)
    assert.equal(r.totals.students, 2);
    assert.equal(r.totals.papers, 2);
    assert.equal(r.totals.papersDropped, 0);
    assert.equal(r.merges.length, 1);
    assert.equal(r.collisions.length, 1);
});

// ── renderMergeReport ────────────────────────────────────────
test('renderMergeReport：輸出 Markdown 且不碰時間（同輸入同輸出）', () => {
    const r = buildMergeReport({
        historyKeys: [{ name: '王"小明', questionId: 1, date: '2026-01-01' }],
        paperNames: [{ name: '王小明', paperId: 1 }]
    });
    const md1 = renderMergeReport(r);
    const md2 = renderMergeReport(r);
    assert.equal(md1, md2);
    assert.match(md1, /^# 姓名合併報告/);
    assert.match(md1, /王小明/);
    assert.match(md1, /## 需要人工確認：正規化後合併的姓名/);
});

test('renderMergeReport：空報告也要能印出來', () => {
    const md = renderMergeReport(buildMergeReport({}), { generatedAt: '2026-08-21T00:00:00+08:00' });
    assert.match(md, /2026-08-21T00:00:00\+08:00/);
    assert.match(md, /（無。/);
});
