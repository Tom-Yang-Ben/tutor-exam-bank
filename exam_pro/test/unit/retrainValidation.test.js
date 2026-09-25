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
