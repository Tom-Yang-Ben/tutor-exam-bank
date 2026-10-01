// ─────────────────────────────────────────────────────────────
// 承上題整組湊不滿題數時的政策（FR-019；〔Owner 決策單 2026-09-25 B10〕）
//
// Owner 決策：「承上題整組湊不滿題數時：直接報錯，請老師改題數」——預設從 'note'（少出題附註）改成 'error'。
// 保留切回 'note' 的能力：環境變數 FOLLOW_UP_SHORTFALL_POLICY（note／error），
// 未設／空白＝error，非法值退回 error 並 console.warn 一次。
//
// examController 在模組頂層 require config/db（缺 DATABASE_URL 會直接丟錯）；
// node --test 每個測試檔各自一個子行程，這裡只在本檔的行程塞一個假的連線字串，本檔從不 query。
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';

const exam = require('../../controllers/examController');

/** 暫時換掉 console.warn，收集訊息。 */
function captureWarn() {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => { calls.push(args.join(' ')); };
    return { calls, restore: () => { console.warn = original; } };
}

describe('FOLLOW_UP_SHORTFALL_POLICY（〔Owner 決策單 2026-09-25 B10〕）', () => {
    let saved;
    beforeEach(() => {
        saved = process.env.FOLLOW_UP_SHORTFALL_POLICY;
        delete process.env.FOLLOW_UP_SHORTFALL_POLICY;
        exam._resetShortfallPolicyWarningForTest();
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.FOLLOW_UP_SHORTFALL_POLICY;
        else process.env.FOLLOW_UP_SHORTFALL_POLICY = saved;
        exam._resetShortfallPolicyWarningForTest();
    });

    test('預設是 error（直接報錯請老師改題數）：未設與空白都是', () => {
        assert.equal(exam.DEFAULT_FOLLOW_UP_SHORTFALL_POLICY, 'error');
        const w = captureWarn();
        try {
            assert.equal(exam.resolveFollowUpShortfallPolicy({}), 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: '' }), 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: '   ' }), 'error');
            assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'error', '沒設環境變數時舊的常數名讀到的也是 error');
        } finally { w.restore(); }
        assert.deepEqual(w.calls, [], '未設不是設錯，不該警告');
    });

    test('note／error 照設定；不分大小寫、去頭尾空白', () => {
        assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'note' }), 'note');
        assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: ' NOTE ' }), 'note');
        assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'error' }), 'error');
        assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'Error' }), 'error');
    });

    test('每次讀都看當下的 process.env（測試與 .env 改值都不必重新 require 模組）', () => {
        process.env.FOLLOW_UP_SHORTFALL_POLICY = 'note';
        assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'note');
        assert.equal(exam.resolveFollowUpShortfallPolicy(), 'note');
        process.env.FOLLOW_UP_SHORTFALL_POLICY = 'error';
        assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'error');
        delete process.env.FOLLOW_UP_SHORTFALL_POLICY;
        assert.equal(exam.resolveFollowUpShortfallPolicy(), 'error');
    });

    test('非法值退回 error，並且只警告一次（同一個錯值讀幾次都一樣）', () => {
        const w = captureWarn();
        try {
            process.env.FOLLOW_UP_SHORTFALL_POLICY = 'notes';
            assert.equal(exam.resolveFollowUpShortfallPolicy(), 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy(), 'error');
            assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'notes' }), 'error');
        } finally { w.restore(); }
        assert.equal(w.calls.length, 1, JSON.stringify(w.calls));
        assert.match(w.calls[0], /FOLLOW_UP_SHORTFALL_POLICY 只接受 note／error，收到「notes」，改用 error/);
    });

    test('換成另一個錯值會再警告那一次；_resetShortfallPolicyWarningForTest 之後同一個錯值會重新警告', () => {
        const w = captureWarn();
        try {
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'warn' }), 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: '400' }), 'error');
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'warn' }), 'error');
            assert.equal(w.calls.length, 2);
            exam._resetShortfallPolicyWarningForTest();
            assert.equal(exam.resolveFollowUpShortfallPolicy({ FOLLOW_UP_SHORTFALL_POLICY: 'warn' }), 'error');
            assert.equal(w.calls.length, 3);
        } finally { w.restore(); }
    });

    test('FOLLOW_UP_SHORTFALL_POLICY 是唯讀屬性（改政策要改環境變數，不是改模組）', () => {
        assert.throws(() => { 'use strict'; exam.FOLLOW_UP_SHORTFALL_POLICY = 'note'; }, TypeError);
        assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'error');
    });
});
