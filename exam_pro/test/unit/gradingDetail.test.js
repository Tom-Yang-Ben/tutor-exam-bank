// ─────────────────────────────────────────────────────────────
// 批改細節的單元測試（階段 5 WS-A；docs/interfaces-stage5.md 第 4.1 條第 1、3 項；DEC-015）
//
// 三塊純函式：
//   1. paperController 的 parseResultsBody／parseDetail：PATCH /api/papers/:id/results 的
//      四個可選鍵。**既有六個 400 訊息與檢查順序不得被新規則搶先**——同一份舊 body
//      必須得到與階段 3 逐字相同的回應，這裡逐條釘住。
//   2. weaknessService.buildByErrorType：與另外五支同一套凍結規則（參數順序、CTE、不排除封存）。
//   3. studentController 的三個後處理：錯因標籤、最近錯題的批改細節。
//
// 真的送進 Postgres 的行為（UPDATE 的 CASE、jsonb_to_recordset、GIN 索引）由
// test/integration/grading.pg.test.js 負責；這一支擋的是不必連 DB 就看得出來的錯。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// controllers 在模組頂層 require('../config/db')：先塞一個假的 DATABASE_URL 讓 pg 只建物件、不連線
// （與 test/unit/variantPipeline.test.js 同一招）。本檔只呼叫純函式，不會真的發查詢。
const originalUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
const paper = require('../../controllers/paperController')._internals;
const student = require('../../controllers/studentController')._internals;
if (originalUrl === undefined) delete process.env.DATABASE_URL;

const weakness = require('../../services/weaknessService');

const { parseResultsBody, parseDetail, isValidScore, subjectConflict, toRecordset } = paper;

// ═════════════ 1. PATCH 的解析 ═════════════

describe('parseResultsBody — 既有的六個 400 訊息與順序不變（〔stage5 WS-A〕新規則排在後面）', () => {
    test('舊 body 的回應與階段 3 逐字相同', () => {
        const cases = [
            [{ results: [] }, 'results 必須是非空陣列。'],
            [{}, 'results 必須是非空陣列。'],
            [{ results: Array.from({ length: 101 }, (_, i) => ({ question_id: i + 1, result: 1 })) }, 'results 最多 100 筆。'],
            [{ results: [{ question_id: 1, result: 1 }, { question_id: 1, result: 0 }] }, 'results 內有重複的 question_id。'],
            [{ results: [{ question_id: '12', result: 1 }] }, 'question_id 必須是正整數。'],
            [{ results: [{ question_id: 1, result: 2 }] }, 'result 只接受 0、1 或 null。'],
            [{ results: [{ question_id: 1 }] }, 'result 只接受 0、1 或 null。']
        ];
        for (const [body, message] of cases) assert.deepEqual(parseResultsBody(body), { error: message });
    });

    test('同時違反舊規則與新規則時，回的是舊規則的訊息（新規則不得搶先）', () => {
        assert.deepEqual(parseResultsBody({ results: [{ question_id: 1, result: 7, score: 9, error_types: ['x'] }] }),
            { error: 'result 只接受 0、1 或 null。' });
        assert.deepEqual(parseResultsBody({ results: [{ question_id: 0, result: 1, note: 5 }] }),
            { error: 'question_id 必須是正整數。' });
    });

    test('只送 question_id 與 result 時，items 的形狀與階段 3 相同（沒有多出任何鍵）', () => {
        assert.deepEqual(parseResultsBody({ results: [{ question_id: 3, result: 1 }, { question_id: 4, result: null }] }),
            { items: [{ question_id: 3, result: 1 }, { question_id: 4, result: null }] });
    });
});

describe('parseDetail — 四個可選鍵（第 4.1 條第 1 項）', () => {
    test('沒送就不出現；送了才出現（null 是清空）', () => {
        assert.deepEqual(parseDetail({ question_id: 1, result: 0 }, 0), { value: {} });
        assert.deepEqual(parseDetail({ score: null, error_types: null, response: null, note: null }, 0),
            { value: { score: null, error_types: [], response: null, note: null } });
    });

    test('score：0～1、最多兩位小數；只能搭配 result 0 或 1', () => {
        for (const ok of [0, 1, 0.5, 0.25, 0.29, 0.07, 0.99]) {
            assert.deepEqual(parseDetail({ score: ok }, 0), { value: { score: ok } }, String(ok));
            assert.deepEqual(parseDetail({ score: ok }, 1), { value: { score: ok } }, String(ok));
        }
        for (const bad of [-0.01, 1.01, 0.333, 0.005, '0.5', NaN, Infinity, true, [0.5]]) {
            assert.deepEqual(parseDetail({ score: bad }, 0),
                { error: 'score 必須是 0～1、最多兩位小數的數字，或 null。' }, String(bad));
        }
        assert.deepEqual(parseDetail({ score: 0.5 }, null), { error: 'score 只能搭配 result 為 0 或 1。' });
        // 取消批改時送 score: null 是合法的（本來就會被清掉）
        assert.deepEqual(parseDetail({ score: null }, null), { value: { score: null } });
    });

    test('isValidScore 的浮點邊界：0.29*100 不是整數也要算兩位小數', () => {
        assert.notEqual(0.29 * 100, 29);
        assert.equal(isValidScore(0.29), true);
        assert.equal(isValidScore(0.57), true);
        assert.equal(isValidScore(0.571), false);
    });

    test('error_types：白名單、不重複、最多 5 個、只能在 result = 0 時非空；存成白名單順序', () => {
        assert.deepEqual(parseDetail({ error_types: ['blank', 'calc'] }, 0), { value: { error_types: ['calc', 'blank'] } });
        assert.deepEqual(parseDetail({ error_types: [] }, 1), { value: { error_types: [] } }, '空陣列在答對時合法（等於清空）');
        assert.deepEqual(parseDetail({ error_types: [] }, null), { value: { error_types: [] } });

        const bad = [
            [{ error_types: 'calc' }, 0, 'error_types 必須是陣列或 null。'],
            [{ error_types: ['calc', 'oops'] }, 0, 'error_types 含有不在白名單內的代碼：oops。'],
            [{ error_types: [1] }, 0, 'error_types 含有不在白名單內的代碼：1。'],
            [{ error_types: ['calc', 'calc'] }, 0, 'error_types 不可重複。'],
            [{ error_types: ['concept', 'method', 'calc', 'reading', 'unit', 'formula'] }, 0, 'error_types 最多 5 個。'],
            [{ error_types: ['calc'] }, 1, 'error_types 只能在 result 為 0（答錯）時填寫。'],
            [{ error_types: ['blank'] }, null, 'error_types 只能在 result 為 0（答錯）時填寫。']
        ];
        for (const [row, result, message] of bad) {
            assert.deepEqual(parseDetail(row, result), { error: message }, JSON.stringify(row));
        }
        // 剛好 5 個合法
        assert.equal(parseDetail({ error_types: ['concept', 'method', 'calc', 'reading', 'unit'] }, 0).value.error_types.length, 5);
    });

    test('response／note：字串或 null、≤500 字、trim 後空字串視為 null', () => {
        assert.deepEqual(parseDetail({ response: ' (B) ', note: '  ' }, 0), { value: { response: '(B)', note: null } });
        assert.deepEqual(parseDetail({ response: 'x'.repeat(500) }, 1).value.response.length, 500);
        assert.deepEqual(parseDetail({ response: 'x'.repeat(501) }, 1),
            { error: 'response 必須是字串或 null，且不得超過 500 字。' });
        assert.deepEqual(parseDetail({ note: 12 }, 1), { error: 'note 必須是字串或 null，且不得超過 500 字。' });
        // code point 計數：500 個 BMP 以外的字元是合法的（PG char_length = 500）
        assert.equal(parseDetail({ note: '𠮷'.repeat(500) }, 1).value.note.length, 1000);
    });

    test('parseResultsBody 把可選鍵併進 items', () => {
        assert.deepEqual(parseResultsBody({
            results: [
                { question_id: 1, result: 0, score: 0.3, error_types: ['calc'], response: '8', note: '方向錯' },
                { question_id: 2, result: 1 }
            ]
        }), {
            items: [
                { question_id: 1, result: 0, score: 0.3, error_types: ['calc'], response: '8', note: '方向錯' },
                { question_id: 2, result: 1 }
            ]
        });
    });
});

describe('subjectConflict 與 toRecordset', () => {
    test('chem_equation 標在非化學題 → 回第一個衝突；化學題合法', () => {
        const subjects = new Map([[1, '數學'], [2, '化學'], [3, '物理']]);
        assert.equal(subjectConflict([{ question_id: 2, error_types: ['chem_equation'] }], subjects), null);
        assert.deepEqual(subjectConflict([
            { question_id: 2, error_types: ['chem_equation'] },
            { question_id: 3, error_types: ['calc', 'chem_equation'] },
            { question_id: 1, error_types: ['chem_equation'] }
        ], subjects), { question_id: 3, subject: '物理', code: 'chem_equation' });
        assert.equal(subjectConflict([{ question_id: 1, error_types: ['calc'] }, { question_id: 9 }], subjects), null);
    });

    test('toRecordset 用 has_* 分開「沒送」與「送 null」', () => {
        assert.deepEqual(toRecordset([{ question_id: 5, result: 1 }]), [{
            question_id: 5, result: 1,
            has_score: false, score: null, has_error_types: false, error_types: [],
            has_response: false, response: null, has_note: false, note: null
        }]);
        assert.deepEqual(toRecordset([{ question_id: 5, result: 0, score: null, error_types: ['calc'], note: null }]), [{
            question_id: 5, result: 0,
            has_score: true, score: null, has_error_types: true, error_types: ['calc'],
            has_response: false, response: null, has_note: true, note: null
        }]);
    });
});

// ═════════════ 2. weaknessService.buildByErrorType ═════════════

describe('weaknessService.buildByErrorType — 沿用凍結規則（只在檔尾新增）', () => {
    const OPTS = { studentId: 7, subject: '物理', days: 30 };

    test('參數順序 [studentId, days, subject]；不分科時 subject 收斂成 null', () => {
        assert.deepEqual(weakness.buildByErrorType(OPTS).values, [7, 30, '物理']);
        for (const subject of [undefined, null, '']) {
            assert.equal(weakness.buildByErrorType({ studentId: 7, days: 90, subject }).values[2], null);
        }
    });

    test('占位符 $1..$3 恰好用滿、沒有洞', () => {
        const { text, values } = weakness.buildByErrorType(OPTS);
        const used = [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
        assert.equal(Math.max(...used), values.length);
        for (let i = 1; i <= values.length; i++) assert.ok(used.includes(i), `缺少 $${i}`);
    });

    test('同一組時間窗、學科與學生條件；只算 result = 0；不排除封存；不讀門檻', () => {
        const { text } = weakness.buildByErrorType(OPTS);
        assert.match(text, /a\.student_id = \$1/);
        assert.match(text, /a\.assigned_at >= CURRENT_DATE - \$2::int/);
        assert.match(text, /\(\$3::text IS NULL OR q\.subject = \$3\)/);
        assert.match(text, /a\.result = 0/);
        assert.ok(!/archived_at/.test(text));
        assert.ok(!/low_sample|WEAKNESS_MIN_N/.test(text));
    });

    test('CTE 外包；share 四捨五入到 4 位、分母為 0 時 NULL；排序 count DESC、error_type ASC（C collation）', () => {
        const { text } = weakness.buildByErrorType(OPTS);
        assert.match(text, /^WITH wrong AS \(/);
        assert.match(text, /round\(\(agg\.count::numeric \/ NULLIF\(total\.wrong, 0\)\), 4\)::float8 AS share/);
        assert.match(text, /ORDER BY agg\.count DESC, agg\.error_type COLLATE "C" ASC$/);
        assert.match(text, /unnest\(w\.error_types\)/);
    });

    test('純函式：同輸入同輸出、不改 opts；既有五支的 SQL 沒被動到', () => {
        const opts = { ...OPTS };
        const snapshot = JSON.stringify(opts);
        assert.deepEqual(weakness.buildByErrorType(opts), weakness.buildByErrorType(opts));
        assert.equal(JSON.stringify(opts), snapshot);
        // 檔尾新增的一支不得改變模組原本匯出的五支與常數
        for (const name of ['buildByChapter', 'buildByType', 'buildByDifficulty', 'buildTrendWeekly', 'buildRecentWrong']) {
            assert.equal(typeof weakness[name], 'function', name);
        }
        assert.equal(weakness.DEFAULT_RECENT_LIMIT, 20);
    });
});

// ═════════════ 3. studentController 的後處理 ═════════════

describe('studentController — by_error_type 與 recent_wrong 的後處理', () => {
    test('withErrorTypeLabels：補中文標籤，欄位順序 error_type、label、count、share；不認得的代碼 label 為 null', () => {
        const out = student.withErrorTypeLabels([
            { error_type: 'calc', count: 3, share: 0.6 },
            { error_type: 'mystery', count: 1, share: 0.2 }
        ]);
        assert.deepEqual(out, [
            { error_type: 'calc', label: '計算錯誤', count: 3, share: 0.6 },
            { error_type: 'mystery', label: null, count: 1, share: 0.2 }
        ]);
        assert.deepEqual(Object.keys(out[0]), ['error_type', 'label', 'count', 'share']);
    });

    test('buildRecentWrongDetail：以 (student_id, question_id) 查，score 轉 float8', () => {
        const { text, values } = student.buildRecentWrongDetail(3, [9, 8]);
        assert.deepEqual(values, [3, [9, 8]]);
        assert.match(text, /student_id = \$1 AND question_id = ANY\(\$2::int\[\]\)/);
        assert.match(text, /score::float8 AS score/);
    });

    test('withAttemptDetail：既有四欄順序不動、新欄接在後面；查不到時是 [] 與 null', () => {
        const rows = [
            { question_id: 9, chapter: '向量內積', question_text: 'x', assigned_at: '2026-09-01' },
            { question_id: 8, chapter: '向量內積', question_text: 'y', assigned_at: '2026-09-01' }
        ];
        const out = student.withAttemptDetail(rows, new Map([[9, { error_types: ['calc'], score: 0.5 }]]));
        assert.deepEqual(Object.keys(out[0]), ['question_id', 'chapter', 'question_text', 'assigned_at', 'error_types', 'score']);
        assert.deepEqual(out.map(r => [r.error_types, r.score]), [[['calc'], 0.5], [[], null]]);
    });
});
