// ─────────────────────────────────────────────────────────────
// test/unit/retrainValidation.test.js — 錯題重練 API 的參數驗證（〔retrain PR-2〕docs/retrain-and-review.md 第 5.2 節；
// 第 6.3 節 TC-039-2 中 API-1～4 與 API-10 的部分）
//
// utils/retrainValidation.js 是純函式：不碰 DB、不讀 env、不看時鐘（今天由呼叫端傳入）。
// 嚴格驗證同裁決 S5-21：不認得的查詢參數與 body 鍵一律 400。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../utils/retrainValidation');

const today = '2026-10-12';

describe('路徑參數（不合法一律當作不存在：呼叫端回 404）', () => {
    test('學生 id：正整數、int4 以內、不接受 3abc／3.5／前後空白以外的寫法', () => {
        assert.equal(v.parseStudentId('3'), 3);
        assert.equal(v.parseStudentId(' 3 '), 3);
        for (const bad of ['0', '-1', '3abc', '3.5', 'abc', '', undefined, null, '2147483648', '1e3']) {
            assert.equal(v.parseStudentId(bad), null, String(bad));
        }
        assert.equal(v.parseStudentId('2147483647'), 2147483647);
    });

    test('項目 id（BIGINT）：安全整數以內的正整數', () => {
        assert.equal(v.parseItemId('31'), 31);
        assert.equal(v.parseItemId('2147483648'), 2147483648);
        for (const bad of ['0', '1.5', 'x', '', '9007199254740993']) assert.equal(v.parseItemId(bad), null, bad);
    });
});

describe('API-1 GET /api/students/:id/retrain-items', () => {
    test('預設：status=active、subject 不限、as_of＝今天；空字串等於沒給', () => {
        assert.deepEqual(v.parseListQuery({}, { today }), { status: 'active', subject: null, asOf: today });
        assert.deepEqual(v.parseListQuery({ status: '', subject: '', as_of: '' }, { today }), { status: 'active', subject: null, asOf: today });
        assert.deepEqual(v.parseListQuery(undefined, { today }), { status: 'active', subject: null, asOf: today });
    });

    test('合法值照用（status 七種、subject 在白名單、as_of 真的有這一天）', () => {
        for (const status of ['active', 'due', 'in_flight', 'stuck', 'mastered', 'retired', 'all']) {
            assert.equal(v.parseListQuery({ status }, { today }).status, status);
        }
        assert.deepEqual(v.parseListQuery({ status: 'due', subject: '化學', as_of: '2026-10-15' }, { today }),
            { status: 'due', subject: '化學', asOf: '2026-10-15' });
        assert.deepEqual(v.LIST_STATUSES, ['active', 'due', 'in_flight', 'stuck', 'mastered', 'retired', 'all']);
    });

    test('400 訊息', () => {
        const cases = [
            [{ status: 'late' }, 'status 只接受 active、due、in_flight、stuck、mastered、retired、all。'],
            [{ status: 'ACTIVE' }, 'status 只接受 active、due、in_flight、stuck、mastered、retired、all。'],
            [{ subject: '生物' }, 'subject 不在白名單內。'],
            [{ as_of: '2026-02-30' }, 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ as_of: '2026/10/12' }, 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ as_of: '20261012' }, 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ page: '2' }, '不認得的查詢參數：page（可用：status、subject、as_of）。'],
            [{ statuss: 'due', foo: '1' }, '不認得的查詢參數：statuss、foo（可用：status、subject、as_of）。'],
            [{ status: ['due', 'all'] }, 'status 只能給一個值。'],
            [{ as_of: ['2026-10-12'] }, 'as_of 只能給一個值。']
        ];
        for (const [q, message] of cases) assert.deepEqual(v.parseListQuery(q, { today }), { error: message }, JSON.stringify(q));
    });
});

describe('API-4 GET /api/retrain/summary', () => {
    test('只收 as_of；預設今天', () => {
        assert.deepEqual(v.parseSummaryQuery({}, { today }), { asOf: today });
        assert.deepEqual(v.parseSummaryQuery({ as_of: '2026-12-31' }, { today }), { asOf: '2026-12-31' });
        assert.deepEqual(v.parseSummaryQuery({ as_of: '2026-13-01' }, { today }), { error: 'as_of 必須是 YYYY-MM-DD 格式的日期。' });
        assert.deepEqual(v.parseSummaryQuery({ student_id: '3' }, { today }), { error: '不認得的查詢參數：student_id（可用：as_of）。' });
    });
});

describe('API-2 POST /api/students/:id/retrain-items', () => {
    test('question_ids：1～50 個正整數、不重複', () => {
        assert.deepEqual(v.parseAddBody({ question_ids: [812, 640] }), { questionIds: [812, 640] });
        assert.deepEqual(v.parseAddBody({ question_ids: Array.from({ length: 50 }, (_, i) => i + 1) }).questionIds.length, 50);
        const ids = '1~50';
        for (const body of [{}, { question_ids: [] }, { question_ids: 'x' }, { question_ids: [1, '2'] }, { question_ids: [0] },
            { question_ids: [1.5] }, { question_ids: [2147483648] }, { question_ids: Array.from({ length: 51 }, (_, i) => i + 1) }]) {
            assert.deepEqual(v.parseAddBody(body), { error: `question_ids 必須是 ${ids} 個正整數。` }, JSON.stringify(body).slice(0, 60));
        }
        assert.deepEqual(v.parseAddBody({ question_ids: [3, 3] }), { error: 'question_ids 不得重複。' });
    });

    test('body 必須是物件，不認得的鍵 400', () => {
        for (const body of [null, undefined, [], 'x', 3]) {
            assert.deepEqual(v.parseAddBody(body), { error: 'body 必須是 JSON 物件。' });
        }
        assert.deepEqual(v.parseAddBody({ question_ids: [1], reason: 'manual' }),
            { error: '不接受的欄位：reason（可用的欄位：question_ids）。' });
    });
});

describe('API-3 PATCH /api/students/:id/retrain-items/:itemId', () => {
    test('三種 action；note 沒送＝不動、null／空白＝清空、trim', () => {
        assert.deepEqual(v.parseActionBody({ action: 'retire' }), { action: 'retire', hasNote: false, note: null });
        assert.deepEqual(v.parseActionBody({ action: 'mark_mastered', note: '  改講觀念 ' }),
            { action: 'mark_mastered', hasNote: true, note: '改講觀念' });
        assert.deepEqual(v.parseActionBody({ action: 'reactivate', note: null }), { action: 'reactivate', hasNote: true, note: null });
        assert.deepEqual(v.parseActionBody({ action: 'reactivate', note: '   ' }), { action: 'reactivate', hasNote: true, note: null });
        assert.deepEqual(v.ACTIONS, ['retire', 'mark_mastered', 'reactivate']);
    });

    test('note 上限 200 字（以 Unicode code point 計，同 PG char_length）', () => {
        assert.equal(v.parseActionBody({ action: 'retire', note: '字'.repeat(200) }).note.length, 200);
        assert.equal(v.parseActionBody({ action: 'retire', note: '𠀀'.repeat(200) }).hasNote, true, '罕用字算一個字');
        const tooLong = 'note 必須是字串或 null，且不得超過 200 字。';
        assert.deepEqual(v.parseActionBody({ action: 'retire', note: '字'.repeat(201) }), { error: tooLong });
        assert.deepEqual(v.parseActionBody({ action: 'retire', note: 3 }), { error: tooLong });
    });

    test('400：action 缺或不認得、不認得的鍵、body 不是物件', () => {
        const bad = 'action 必填，只接受 retire、mark_mastered、reactivate。';
        for (const body of [{}, { action: 'delete' }, { action: 'Retire' }, { action: null }, { note: 'x' }]) {
            assert.deepEqual(v.parseActionBody(body), { error: bad }, JSON.stringify(body));
        }
        assert.deepEqual(v.parseActionBody({ action: 'retire', status: 'retired' }),
            { error: '不接受的欄位：status（可用的欄位：action、note）。' });
        assert.deepEqual(v.parseActionBody([]), { error: 'body 必須是 JSON 物件。' });
    });
});

describe('API-10 PATCH /api/papers/:id/results 的 results[i].retrain（R1 選 2）', () => {
    const body = results => ({ results });

    test('旗標開啟：只收布林；沒送 retrain 的列不動（不在 flags 裡）', () => {
        assert.deepEqual(v.parseRetrainFlags(body([
            { question_id: 1, result: 0, retrain: true },
            { question_id: 2, result: 1 },
            { question_id: 3, result: null, retrain: false }
        ]), { enabled: true }), { flags: [{ question_id: 1, retrain: true }, { question_id: 3, retrain: false }] });
        assert.deepEqual(v.parseRetrainFlags(body([{ question_id: 1, result: 0 }]), { enabled: true }), { flags: [] });
        for (const bad of ['true', 1, 0, null, {}]) {
            assert.deepEqual(v.parseRetrainFlags(body([{ question_id: 1, result: 0, retrain: bad }]), { enabled: true }),
                { error: 'retrain 只接受 true 或 false。' }, JSON.stringify(bad));
        }
    });

    test('旗標關閉：帶了 retrain（不論值）→「retrain 需要開啟 FEATURE_RETRAIN。」；沒帶照舊', () => {
        for (const val of [true, false, 'x', null]) {
            assert.deepEqual(v.parseRetrainFlags(body([{ question_id: 1, result: 0, retrain: val }]), { enabled: false }),
                { error: 'retrain 需要開啟 FEATURE_RETRAIN。' });
        }
        assert.deepEqual(v.parseRetrainFlags(body([{ question_id: 1, result: 0 }]), { enabled: false }), { flags: [] });
    });

    test('PATCH 的既有檢查仍然先跑：paperController 在既有檢查全部通過之後才回報 retrain 的錯誤', () => {
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';
        const paper = require('../../controllers/paperController');
        // 既有的 body 檢查不認得 retrain：同一份 body 先回既有的錯誤訊息
        assert.deepEqual(paper._internals.parseResultsBody({ results: [{ question_id: 1, result: 2, retrain: 'x' }] }),
            { error: 'result 只接受 0、1 或 null。' });
        const ok = paper._internals.parseResultsBody({ results: [{ question_id: 1, result: 0, retrain: true }] });
        assert.deepEqual(ok, { items: [{ question_id: 1, result: 0 }] }, 'retrain 不進既有的 items（不影響 UPDATE）');
    });
});

// ───────────────────── 〔retrain PR-3〕出卷整合（API-5～8、API-12；TC-039-2）─────────────────────

describe('〔PR-3〕API-6 POST /api/generate-paper 的 retrain: { count, as_of? }', () => {
    const opts = { enabled: true, newCount: 20, today };

    test('沒帶或 null＝沒有這個功能（回應逐字不變）；旗標關閉時也一樣不擋', () => {
        assert.deepEqual(v.parseAttachParam(undefined, opts), { value: null });
        assert.deepEqual(v.parseAttachParam(null, opts), { value: null });
        assert.deepEqual(v.parseAttachParam(undefined, { ...opts, enabled: false }), { value: null });
    });

    test('合法值：count 0～50（新題＋重練 ≤ 50）、as_of 預設今天（空字串、null 都算沒給）', () => {
        assert.deepEqual(v.parseAttachParam({ count: 6 }, opts), { value: { count: 6, asOf: today } });
        assert.deepEqual(v.parseAttachParam({ count: 0, as_of: '' }, opts), { value: { count: 0, asOf: today } });
        assert.deepEqual(v.parseAttachParam({ count: 30, as_of: '2026-10-15' }, opts), { value: { count: 30, asOf: '2026-10-15' } });
        assert.deepEqual(v.parseAttachParam({ count: 3, as_of: null }, { ...opts, newCount: 47 }), { value: { count: 3, asOf: today } });
    });

    test('旗標關閉卻帶了（不論值）→ 400「retrain 需要開啟 FEATURE_RETRAIN。」', () => {
        for (const raw of [{ count: 1 }, { count: 0 }, {}, 'x', 0]) {
            assert.deepEqual(v.parseAttachParam(raw, { ...opts, enabled: false }), { error: v.RETRAIN_DISABLED_MESSAGE }, JSON.stringify(raw));
        }
        assert.equal(v.RETRAIN_DISABLED_MESSAGE, 'retrain 需要開啟 FEATURE_RETRAIN。');
    });

    test('400 訊息（不認得的鍵也 400，同裁決 S5-21）', () => {
        const cases = [
            [[3], 'retrain 必須是物件：{ count, as_of? }。'],
            ['3', 'retrain 必須是物件：{ count, as_of? }。'],
            [{}, 'retrain.count 必須是 0~50 的整數。'],
            [{ count: 51 }, 'retrain.count 必須是 0~50 的整數。'],
            [{ count: 1.5 }, 'retrain.count 必須是 0~50 的整數。'],
            [{ count: '2' }, 'retrain.count 必須是 0~50 的整數。'],
            [{ count: -1 }, 'retrain.count 必須是 0~50 的整數。'],
            [{ count: 2, as_of: '2026-02-30' }, 'retrain.as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ count: 2, as_of: 20261012 }, 'retrain.as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ count: 2, cnt: 1 }, 'retrain 不接受的欄位：cnt（可用的欄位：count、as_of）。'],
            [{ count: 31 }, '新題加重練題最多 50 題（新題 20 題＋重練 31 題）。']
        ];
        for (const [raw, message] of cases) assert.deepEqual(v.parseAttachParam(raw, opts), { error: message }, JSON.stringify(raw));
    });
});

describe('〔PR-3〕API-7 POST /api/confirm-paper 的 retrain_question_ids', () => {
    const on = { enabled: true };

    test('沒帶或 null → value: null（回應逐字不變）；空陣列＝沒有重練題；子集照用', () => {
        assert.deepEqual(v.parseConfirmRetrain({ question_ids: [1, 2] }, on), { value: null });
        assert.deepEqual(v.parseConfirmRetrain({ question_ids: [1, 2], retrain_question_ids: null }, on), { value: null });
        assert.deepEqual(v.parseConfirmRetrain({ question_ids: [1, 2], retrain_question_ids: [] }, on), { value: [] });
        assert.deepEqual(v.parseConfirmRetrain({ question_ids: [1, 2, 3], retrain_question_ids: [3, 1] }, on), { value: [3, 1] });
        assert.deepEqual(v.parseConfirmRetrain({ question_ids: [1] }, { enabled: false }), { value: null });
    });

    test('400：旗標關閉、不是正整數陣列、重複、不是子集', () => {
        const cases = [
            [{ question_ids: [1], retrain_question_ids: [] }, { enabled: false }, 'retrain 需要開啟 FEATURE_RETRAIN。'],
            [{ question_ids: [1], retrain_question_ids: 1 }, on, 'retrain_question_ids 必須是正整數陣列。'],
            [{ question_ids: [1], retrain_question_ids: ['1'] }, on, 'retrain_question_ids 必須是正整數陣列。'],
            [{ question_ids: [1], retrain_question_ids: [0] }, on, 'retrain_question_ids 必須是正整數陣列。'],
            [{ question_ids: [1], retrain_question_ids: [2147483648] }, on, 'retrain_question_ids 必須是正整數陣列。'],
            [{ question_ids: [1, 2], retrain_question_ids: [2, 2] }, on, 'retrain_question_ids 不得重複。'],
            [{ question_ids: [1, 2], retrain_question_ids: [2, 5, 7] }, on, 'retrain_question_ids 的每一題都必須在 question_ids 裡（不在的：5、7）。']
        ];
        for (const [body, o, message] of cases) assert.deepEqual(v.parseConfirmRetrain(body, o), { error: message }, JSON.stringify(body));
    });
});

describe('〔PR-3〕API-5 POST /api/students/:id/retrain-paper', () => {
    test('全部選填：沒有 body＝subject 不限、count 10、as_of 今天、include_not_due false', () => {
        const defaults = { subject: null, count: 10, asOf: today, includeNotDue: false };
        for (const body of [undefined, null, {}, { subject: '', as_of: '', count: null, include_not_due: null }]) {
            assert.deepEqual(v.parseRetrainPaperBody(body, { today }), defaults, JSON.stringify(body));
        }
        assert.equal(v.DEFAULT_RETRAIN_PAPER_COUNT, 10);
        assert.deepEqual(v.parseRetrainPaperBody({ subject: '物理', count: 50, as_of: '2026-10-15', include_not_due: true }, { today }),
            { subject: '物理', count: 50, asOf: '2026-10-15', includeNotDue: true });
    });

    test('400 訊息', () => {
        const cases = [
            [[1], 'body 必須是 JSON 物件。'],
            [{ subject: '生物' }, 'subject 不在白名單內。'],
            [{ subject: 3 }, 'subject 不在白名單內。'],
            [{ count: 0 }, 'count 必須是 1~50 的整數。'],
            [{ count: 51 }, 'count 必須是 1~50 的整數。'],
            [{ count: '5' }, 'count 必須是 1~50 的整數。'],
            [{ as_of: '10/12' }, 'as_of 必須是 YYYY-MM-DD 格式的日期。'],
            [{ include_not_due: 'true' }, 'include_not_due 只接受 true 或 false。'],
            [{ student_id: 3 }, '不接受的欄位：student_id（可用的欄位：subject、count、as_of、include_not_due）。']
        ];
        for (const [body, message] of cases) assert.deepEqual(v.parseRetrainPaperBody(body, { today }), { error: message }, JSON.stringify(body));
    });
});

describe('〔PR-3〕API-8 POST /api/students/:id/remedial-paper 的 retrain_count', () => {
    test('沒帶、null＝0（回應逐字不變）；0～20、total＋retrain_count ≤ 50', () => {
        assert.deepEqual(v.parseRemedialRetrain({}, { enabled: true, total: 20 }), { count: 0 });
        assert.deepEqual(v.parseRemedialRetrain({ retrain_count: null }, { enabled: false, total: 20 }), { count: 0 });
        assert.deepEqual(v.parseRemedialRetrain(undefined, { enabled: true, total: 20 }), { count: 0 });
        assert.deepEqual(v.parseRemedialRetrain({ retrain_count: 0 }, { enabled: true, total: 20 }), { count: 0 });
        assert.deepEqual(v.parseRemedialRetrain({ retrain_count: 20 }, { enabled: true, total: 30 }), { count: 20 });
        assert.equal(v.MAX_REMEDIAL_RETRAIN, 20);
    });

    test('400 訊息（旗標關閉時帶了就擋，0 也一樣）', () => {
        const cases = [
            [{ retrain_count: 0 }, false, 20, 'retrain 需要開啟 FEATURE_RETRAIN。'],
            [{ retrain_count: 21 }, true, 20, 'retrain_count 必須是 0~20 的整數。'],
            [{ retrain_count: -1 }, true, 20, 'retrain_count 必須是 0~20 的整數。'],
            [{ retrain_count: '3' }, true, 20, 'retrain_count 必須是 0~20 的整數。'],
            [{ retrain_count: 11 }, true, 40, 'total 加上 retrain_count 最多 50 題（補救 40 題＋重練 11 題）。']
        ];
        for (const [body, enabled, total, message] of cases) {
            assert.deepEqual(v.parseRemedialRetrain(body, { enabled, total }), { error: message }, JSON.stringify(body));
        }
    });

    test('既有的補救卷 body 檢查先跑，而且不認得 retrain_count（不影響既有的解析結果）', () => {
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';
        const { parseRemedialBody } = require('../../controllers/remedialController')._internals;
        assert.deepEqual(parseRemedialBody({ subject: '數學', retrain_count: 3 }), parseRemedialBody({ subject: '數學' }));
        assert.deepEqual(parseRemedialBody({ subject: '數學', total: 1, retrain_count: 99 }), { error: 'total 必須是 5~50 的整數。' });
    });
});

describe('〔PR-3〕API-12 POST /api/download-word 的 paper_id', () => {
    test('旗標關閉：一律忽略（組卷頁本來就會送 paper_id；Word 必須逐位元不變），格式不對也不擋', () => {
        for (const paper_id of [3, 'abc', -1, null, undefined]) {
            assert.deepEqual(v.parseWordPaperId({ paper_id }, { enabled: false }), { paperId: null }, String(paper_id));
        }
    });

    test('旗標開啟：沒帶或 null＝不標；正整數照用；其他 400', () => {
        assert.deepEqual(v.parseWordPaperId({}, { enabled: true }), { paperId: null });
        assert.deepEqual(v.parseWordPaperId({ paper_id: null }, { enabled: true }), { paperId: null });
        assert.deepEqual(v.parseWordPaperId({ paper_id: 41 }, { enabled: true }), { paperId: 41 });
        for (const bad of ['41', 0, -3, 1.5, 2147483648, [41]]) {
            assert.deepEqual(v.parseWordPaperId({ paper_id: bad }, { enabled: true }), { error: 'paper_id 必須是正整數。' }, JSON.stringify(bad));
        }
    });
});
