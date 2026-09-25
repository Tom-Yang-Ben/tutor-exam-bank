// ─────────────────────────────────────────────────────────────
// followUpPaperCheck 單元測試（〔Owner 決策單 2026-09-25 B7〕確認出卷時伺服器端檢查承上題是否整組）。
// 純函式、不連 DB；整合行為（POST /api/confirm-paper）見 test/integration/paperGroups.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    findIncompleteFollowUpGroups, incompleteFollowUpGroupsMessage, missingReason, MISSING_REASON_LABEL
} = require('../../utils/followUpPaperCheck');

const row = (id, follows = null, extra = {}) => ({ id, follows_question_id: follows, archived: false, answered: false, ...extra });

describe('findIncompleteFollowUpGroups — 卷裡只放了一部分的承上組', () => {
    // 鏈 10 ← 11 ← 12；分岔 20 ← 21、20 ← 22；單題 30、31
    const rows = [row(12, 11), row(10), row(11, 10), row(22, 20), row(21, 20), row(20), row(30), row(31)];

    test('整組都在（順序隨意）→ 空陣列', () => {
        assert.deepEqual(findIncompleteFollowUpGroups([12, 30, 10, 11], rows), []);
        assert.deepEqual(findIncompleteFollowUpGroups([22, 20, 21], rows), []);
        assert.deepEqual(findIncompleteFollowUpGroups([10, 11, 12, 20, 21, 22, 30, 31], rows), []);
    });

    test('沒有任何承上組的卷不受影響', () => {
        assert.deepEqual(findIncompleteFollowUpGroups([30, 31], rows), []);
        assert.deepEqual(findIncompleteFollowUpGroups([30], [row(30)]), []);
        assert.deepEqual(findIncompleteFollowUpGroups([1, 2, 3], []), [], 'rows 為空也不丟錯');
    });

    test('缺鏈尾、缺鏈首、缺中間：列出整組（承接順序）與缺的題', () => {
        assert.deepEqual(findIncompleteFollowUpGroups([10, 11, 30], rows),
            [{ group_ids: [10, 11, 12], missing: [{ question_id: 12, reason: 'not_in_paper' }] }]);
        assert.deepEqual(findIncompleteFollowUpGroups([11, 12], rows),
            [{ group_ids: [10, 11, 12], missing: [{ question_id: 10, reason: 'not_in_paper' }] }]);
        assert.deepEqual(findIncompleteFollowUpGroups([10, 12], rows),
            [{ group_ids: [10, 11, 12], missing: [{ question_id: 11, reason: 'not_in_paper' }] }]);
        assert.deepEqual(findIncompleteFollowUpGroups([12], rows),
            [{ group_ids: [10, 11, 12], missing: [{ question_id: 10, reason: 'not_in_paper' }, { question_id: 11, reason: 'not_in_paper' }] }]);
    });

    test('分岔：前題＋其中一個承上題不算整組', () => {
        assert.deepEqual(findIncompleteFollowUpGroups([20, 21], rows),
            [{ group_ids: [20, 21, 22], missing: [{ question_id: 22, reason: 'not_in_paper' }] }]);
    });

    test('多組不完整：依組首 id 排序，不受 rows 順序影響', () => {
        const expected = [
            { group_ids: [10, 11, 12], missing: [{ question_id: 12, reason: 'not_in_paper' }] },
            { group_ids: [20, 21, 22], missing: [{ question_id: 21, reason: 'not_in_paper' }] }
        ];
        assert.deepEqual(findIncompleteFollowUpGroups([22, 20, 10, 11], rows), expected);
        assert.deepEqual(findIncompleteFollowUpGroups([22, 20, 10, 11], [...rows].reverse()), expected);
    });

    test('原因：已封存 > 該生已寫過 > 沒放進卷（與前端 planManualAdd 同一組旗標）', () => {
        const r = [row(1), row(2, 1, { archived: true }), row(3, 2, { answered: true }), row(4, 3, { archived: true, answered: true })];
        assert.deepEqual(findIncompleteFollowUpGroups([1], r), [{
            group_ids: [1, 2, 3, 4],
            missing: [
                { question_id: 2, reason: 'archived' },
                { question_id: 3, reason: 'answered' },
                { question_id: 4, reason: 'archived' }
            ]
        }]);
        assert.equal(missingReason(undefined), 'not_in_paper');
        assert.equal(missingReason({ archived: false, answered: false }), 'not_in_paper');
    });

    test('資料有環（DB 只擋自指）也不會無窮迴圈，仍判得出缺題', () => {
        const cyc = [row(5, 7), row(6, 5), row(7, 6)];
        assert.deepEqual(findIncompleteFollowUpGroups([5, 6, 7], cyc), []);
        const out = findIncompleteFollowUpGroups([5], cyc);
        assert.equal(out.length, 1);
        assert.deepEqual([...out[0].group_ids].sort(), [5, 6, 7]);
        assert.deepEqual(out[0].missing.map(m => m.question_id).sort(), [6, 7]);
    });

    test('「缺前題」的承上題（follows_question_id 為 NULL）自成一組，照常可出', () => {
        assert.deepEqual(findIncompleteFollowUpGroups([40], [row(40)]), []);
    });
});

describe('incompleteFollowUpGroupsMessage — 400 的繁體中文訊息', () => {
    test('只缺可以加回的題：列組與缺題，建議加回或整組刪', () => {
        const msg = incompleteFollowUpGroupsMessage([
            { group_ids: [10, 11, 12], missing: [{ question_id: 12, reason: 'not_in_paper' }] }
        ]);
        assert.equal(msg, '承上題必須與前題整組出卷，以下題組不完整：承上題組（#10、#11、#12）缺 #12。'
            + '請把缺的題加回卷裡，或把整組刪掉後再確認。');
    });

    test('缺的題已封存或該生已寫過：逐題標原因，多提醒只能整組刪；多組以「；」分隔', () => {
        const msg = incompleteFollowUpGroupsMessage([
            { group_ids: [1, 2, 3], missing: [{ question_id: 2, reason: 'archived' }, { question_id: 3, reason: 'not_in_paper' }] },
            { group_ids: [8, 9], missing: [{ question_id: 8, reason: 'answered' }] }
        ]);
        assert.equal(msg, '承上題必須與前題整組出卷，以下題組不完整：'
            + '承上題組（#1、#2、#3）缺 #2（已封存）、#3；承上題組（#8、#9）缺 #8（該生已寫過）。'
            + '請把缺的題加回卷裡，或把整組刪掉後再確認；已封存或該生已寫過的題不能出，含這種題的組只能整組刪。');
    });

    test('原因標籤凍結（not_in_paper 不加註記）', () => {
        assert.deepEqual({ ...MISSING_REASON_LABEL }, { archived: '已封存', answered: '該生已寫過', not_in_paper: null });
        assert.ok(Object.isFrozen(MISSING_REASON_LABEL));
    });
});
