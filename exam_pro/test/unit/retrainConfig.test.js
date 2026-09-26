// ─────────────────────────────────────────────────────────────
// retrainConfig.test.js — config/retrain.js（錯題重練與間隔複習的排程參數）
//
// 釘住的規則（docs/retrain-and-review.md 第 4.3、5.1 節；Owner 決策單 2026-09-26 第三輪）：
//   - 預設值逐字：間隔 1／7／14 天（R3 選 2）、連對 3 次練到會（R3 選 2）、錯 3 次卡關（R4 選 1）、
//     附帶上限三成（R6 選 1）、全對才算對（R2 選 1，固定不開放覆寫）
//   - 環境變數覆寫：合法照用；未設或空字串＝預設且不警告；非法值退回預設並只警告一次
//   - 關數與畢業次數的關係：關數多於 K 只用前 K 個；少於 K 兩者一起退回預設
//   - 一律即時讀 process.env（getter），不在 require 當下固定
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cfg = require('../../config/retrain');

beforeEach(() => cfg._resetForTest());

/** 攔下 console.warn，回傳收到的訊息 */
function captureWarn(t) {
    const messages = [];
    t.mock.method(console, 'warn', (m) => { messages.push(String(m)); });
    return messages;
}

describe('config/retrain — Owner 決策單 2026-09-26 的預設值', () => {
    test('預設：間隔 1／7／14 天、連對 3 次、錯 3 次卡關、附帶三成、全對才算對', () => {
        assert.deepEqual([...cfg.DEFAULTS.stepDays], [1, 7, 14]);
        assert.equal(cfg.DEFAULTS.masteryStreak, 3);
        assert.equal(cfg.DEFAULTS.stuckLapses, 3);
        assert.equal(cfg.DEFAULTS.attachRatio, 0.3);
        assert.equal(cfg.DEFAULTS.correctThreshold, 1);
        assert.equal(cfg.CORRECT_THRESHOLD, 1);
        assert.ok(Object.isFrozen(cfg.DEFAULTS) && Object.isFrozen(cfg.DEFAULTS.stepDays), '預設值不得被改動');
    });

    test('環境變數名稱', () => {
        assert.deepEqual({ ...cfg.ENV_KEYS }, {
            stepDays: 'RETRAIN_STEP_DAYS',
            masteryStreak: 'RETRAIN_MASTERY_STREAK',
            stuckLapses: 'RETRAIN_STUCK_LAPSES',
            attachRatio: 'RETRAIN_ATTACH_RATIO'
        });
    });

    test('沒有任何環境變數時＝預設，不警告', (t) => {
        const warns = captureWarn(t);
        const c = cfg.loadRetrainConfig({});
        assert.deepEqual([...c.stepDays], [1, 7, 14]);
        assert.equal(c.masteryStreak, 3);
        assert.equal(c.stuckLapses, 3);
        assert.equal(c.attachRatio, 0.3);
        assert.equal(c.correctThreshold, 1);
        assert.ok(Object.isFrozen(c) && Object.isFrozen(c.stepDays));
        assert.deepEqual(warns, []);
    });

    test('空字串與空白＝沒設：用預設，不警告（eval 子行程會把沒設的變數設成空字串）', (t) => {
        const warns = captureWarn(t);
        const c = cfg.loadRetrainConfig({
            RETRAIN_STEP_DAYS: '', RETRAIN_MASTERY_STREAK: '  ', RETRAIN_STUCK_LAPSES: '', RETRAIN_ATTACH_RATIO: ''
        });
        assert.deepEqual([...c.stepDays], [1, 7, 14]);
        assert.equal(c.masteryStreak, 3);
        assert.equal(c.stuckLapses, 3);
        assert.equal(c.attachRatio, 0.3);
        assert.deepEqual(warns, []);
    });

    test('一份卷最多 50 題，與 confirm-paper 的上限同一個數字', () => {
        // 不 require examController（它在模組頂層連 config/db）；直接讀原始碼的常數
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'controllers', 'examController.js'), 'utf8');
        const m = /^const MAX_QUESTIONS = (\d+);/m.exec(src);
        assert.ok(m, 'examController.js 應該有 const MAX_QUESTIONS = <數字>;（改寫法時這一則要跟著改）');
        assert.equal(cfg.MAX_PAPER_QUESTIONS, 50);
        assert.equal(cfg.MAX_PAPER_QUESTIONS, Number(m[1]));
    });
});

describe('config/retrain — 環境變數覆寫', () => {
    test('合法值照用（R3 選 3 的「對 4 次：1、7、14、28」要兩個變數一起改）', (t) => {
        const warns = captureWarn(t);
        const c = cfg.loadRetrainConfig({
            RETRAIN_STEP_DAYS: '1, 7, 14, 28', RETRAIN_MASTERY_STREAK: '4', RETRAIN_STUCK_LAPSES: '5', RETRAIN_ATTACH_RATIO: '0.5'
        });
        assert.deepEqual([...c.stepDays], [1, 7, 14, 28]);
        assert.equal(c.masteryStreak, 4);
        assert.equal(c.stuckLapses, 5);
        assert.equal(c.attachRatio, 0.5);
        assert.deepEqual(warns, []);
    });

    test('全形逗號也收', () => {
        assert.deepEqual([...cfg.loadRetrainConfig({ RETRAIN_STEP_DAYS: '1，7，14' }).stepDays], [1, 7, 14]);
    });

    test('關數多於連對次數時只用前 K 個（K＝2 就是 R3 選 1 的「重做、隔 1 週」）', (t) => {
        const warns = captureWarn(t);
        const c = cfg.loadRetrainConfig({ RETRAIN_MASTERY_STREAK: '2' });
        assert.deepEqual([...c.stepDays], [1, 7]);
        assert.equal(c.masteryStreak, 2);
        assert.deepEqual(warns, []);
    });

    test('關數少於連對次數：兩者一起退回預設，只警告一次', (t) => {
        const warns = captureWarn(t);
        const env = { RETRAIN_MASTERY_STREAK: '4' };   // 預設間隔只有 3 關
        const c = cfg.loadRetrainConfig(env);
        assert.deepEqual([...c.stepDays], [1, 7, 14]);
        assert.equal(c.masteryStreak, 3);
        cfg.loadRetrainConfig(env);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /^\[retrain\] /);
        assert.match(warns[0], /RETRAIN_STEP_DAYS/);
    });

    test('邊界值：0 天間隔、9 關、比例 0 與 2 都收', () => {
        const c = cfg.loadRetrainConfig({
            RETRAIN_STEP_DAYS: '0,1,2,3,4,5,6,7,365', RETRAIN_MASTERY_STREAK: '9', RETRAIN_STUCK_LAPSES: '99', RETRAIN_ATTACH_RATIO: '0'
        });
        assert.deepEqual([...c.stepDays], [0, 1, 2, 3, 4, 5, 6, 7, 365]);
        assert.equal(c.masteryStreak, 9);
        assert.equal(c.stuckLapses, 99);
        assert.equal(c.attachRatio, 0);
        assert.equal(cfg.loadRetrainConfig({ RETRAIN_ATTACH_RATIO: '2' }).attachRatio, 2);
        assert.equal(cfg.loadRetrainConfig({ RETRAIN_STUCK_LAPSES: '1' }).stuckLapses, 1);
        assert.equal(cfg.loadRetrainConfig({ RETRAIN_MASTERY_STREAK: '1' }).masteryStreak, 1);
    });

    const BAD = {
        RETRAIN_STEP_DAYS: ['abc', '1,,7', '1,7,-14', '1.5,7', '1,7,366', '1,2,3,4,5,6,7,8,9,10', ','],
        RETRAIN_MASTERY_STREAK: ['0', '10', '-1', '3.0', 'three', '3a'],
        RETRAIN_STUCK_LAPSES: ['0', '100', '-3', '2.5', 'x'],
        RETRAIN_ATTACH_RATIO: ['-0.1', '2.01', 'abc', '.5', '3e-1', '30%', 'NaN', 'Infinity']
    };
    const DEFAULT_OF = {
        RETRAIN_STEP_DAYS: c => assert.deepEqual([...c.stepDays], [1, 7, 14]),
        RETRAIN_MASTERY_STREAK: c => assert.equal(c.masteryStreak, 3),
        RETRAIN_STUCK_LAPSES: c => assert.equal(c.stuckLapses, 3),
        RETRAIN_ATTACH_RATIO: c => assert.equal(c.attachRatio, 0.3)
    };
    for (const [key, values] of Object.entries(BAD)) {
        test(`${key} 非法值退回預設並警告（同一個值只警告一次）`, (t) => {
            const warns = captureWarn(t);
            for (const bad of values) {
                const before = warns.length;
                DEFAULT_OF[key](cfg.loadRetrainConfig({ [key]: bad }));
                DEFAULT_OF[key](cfg.loadRetrainConfig({ [key]: bad }));   // 第二次讀同一個值不再警告
                assert.equal(warns.length, before + 1, `${key}=${bad} 應該剛好警告一次`);
                assert.ok(warns[warns.length - 1].includes(key) && warns[warns.length - 1].includes(bad.trim()), warns[warns.length - 1]);
            }
        });
    }

    test('一個變數非法不影響其他變數', (t) => {
        captureWarn(t);
        const c = cfg.loadRetrainConfig({ RETRAIN_STEP_DAYS: 'oops', RETRAIN_STUCK_LAPSES: '4', RETRAIN_ATTACH_RATIO: '0.25' });
        assert.deepEqual([...c.stepDays], [1, 7, 14]);
        assert.equal(c.stuckLapses, 4);
        assert.equal(c.attachRatio, 0.25);
    });
});

describe('config/retrain — getter 即時讀 process.env', () => {
    const KEYS = ['RETRAIN_STEP_DAYS', 'RETRAIN_MASTERY_STREAK', 'RETRAIN_STUCK_LAPSES', 'RETRAIN_ATTACH_RATIO'];

    test('改了 process.env 之後讀 getter 就是新值；刪掉就回到預設', () => {
        const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
        try {
            for (const k of KEYS) delete process.env[k];
            assert.deepEqual([...cfg.STEP_DAYS], [1, 7, 14]);
            assert.equal(cfg.MASTERY_STREAK, 3);
            assert.equal(cfg.STUCK_LAPSES, 3);
            assert.equal(cfg.ATTACH_RATIO, 0.3);

            process.env.RETRAIN_STEP_DAYS = '2,10,21';
            process.env.RETRAIN_STUCK_LAPSES = '2';
            process.env.RETRAIN_ATTACH_RATIO = '0.4';
            assert.deepEqual([...cfg.STEP_DAYS], [2, 10, 21]);
            assert.equal(cfg.STUCK_LAPSES, 2);
            assert.equal(cfg.ATTACH_RATIO, 0.4);

            delete process.env.RETRAIN_STEP_DAYS;
            assert.deepEqual([...cfg.STEP_DAYS], [1, 7, 14]);
        } finally {
            for (const k of KEYS) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        }
    });
});
