// ─────────────────────────────────────────────────────────────
// errorTypes 單元測試（階段 5 WS-A；docs/interfaces-stage5.md 第 3.1 條）
//
// 錯因代碼一旦寫進 attempts.error_types 就是歷史資料：這裡把十個代碼、標籤與
// 適用科目**逐字**釘住。改名或刪除會讓舊的批改紀錄在弱點面板上變成「不認得的代碼」，
// 那種錯不會噴任何例外，只會讓錯因分布安靜地少一列。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    ERROR_TYPES, ERROR_TYPE_CODES, MAX_ERROR_TYPES, isValidErrorType, labelOf
} = require('../../config/errorTypes');

describe('config/errorTypes — 白名單逐字凍結（第 3.1 條）', () => {
    test('十個代碼、標籤與適用科目，順序即前端 chip 的顯示順序', () => {
        assert.deepEqual(ERROR_TYPES.map(t => ({ ...t, subjects: t.subjects === null ? null : [...t.subjects] })), [
            { code: 'concept', label: '觀念不清', subjects: null },
            { code: 'method', label: '方法選錯', subjects: null },
            { code: 'calc', label: '計算錯誤', subjects: null },
            { code: 'reading', label: '審題錯誤', subjects: null },
            { code: 'unit', label: '單位或有效數字', subjects: null },
            { code: 'formula', label: '公式記錯', subjects: null },
            { code: 'careless', label: '粗心抄錯', subjects: null },
            { code: 'blank', label: '未作答', subjects: null },
            { code: 'time', label: '時間不足', subjects: null },
            { code: 'chem_equation', label: '化學式或係數', subjects: ['化學'] }
        ]);
    });

    test('ERROR_TYPE_CODES 與 ERROR_TYPES 同序；一筆最多 5 個錯因', () => {
        assert.deepEqual([...ERROR_TYPE_CODES], ERROR_TYPES.map(t => t.code));
        assert.equal(new Set(ERROR_TYPE_CODES).size, ERROR_TYPE_CODES.length, '代碼不得重複');
        assert.equal(MAX_ERROR_TYPES, 5);
    });

    test('白名單是凍結的：呼叫端改不動（避免某支程式順手 push 一個代碼進去）', () => {
        assert.ok(Object.isFrozen(ERROR_TYPES));
        assert.ok(Object.isFrozen(ERROR_TYPES[0]));
        assert.ok(Object.isFrozen(ERROR_TYPE_CODES));
        assert.throws(() => { 'use strict'; ERROR_TYPES.push({ code: 'x' }); }, TypeError);
    });
});

describe('isValidErrorType(code, subject?)', () => {
    test('只檢查代碼：十個都合法，其他一律不合法', () => {
        for (const code of ERROR_TYPE_CODES) assert.equal(isValidErrorType(code), true, code);
        for (const bad of ['', 'CALC', 'calc ', 'unknown', null, undefined, 1, ['calc'], {}]) {
            assert.equal(isValidErrorType(bad), false, JSON.stringify(bad));
        }
    });

    test('給科目時：全科通用的代碼在數學、物理、化學都合法', () => {
        for (const subject of ['數學', '物理', '化學']) {
            assert.equal(isValidErrorType('calc', subject), true, subject);
            assert.equal(isValidErrorType('blank', subject), true, subject);
        }
    });

    test('chem_equation 只能用在化學題', () => {
        assert.equal(isValidErrorType('chem_equation', '化學'), true);
        assert.equal(isValidErrorType('chem_equation', '數學'), false);
        assert.equal(isValidErrorType('chem_equation', '物理'), false);
        // 沒給科目＝只檢查代碼本身（PATCH 的第一道檢查就是這樣用的）
        assert.equal(isValidErrorType('chem_equation'), true);
        assert.equal(isValidErrorType('chem_equation', null), true);
    });
});

describe('labelOf(code)', () => {
    test('回中文標籤；不認得的代碼回 null（不把代碼當標籤，免得看起來像正常錯因）', () => {
        assert.equal(labelOf('calc'), '計算錯誤');
        assert.equal(labelOf('chem_equation'), '化學式或係數');
        assert.equal(labelOf('nope'), null);
        assert.equal(labelOf(undefined), null);
    });
});
