// services/retrievalService.js 的純函式單元測試（WS-C）
//
// /similar 的參數規則寫在 docs/interfaces-stage1.md 第 6 條，其中 scope 在裁決 19 之後
// 只剩 chapter / subject——這支測試就是拿來釘住「給 all 要回 400，不悄悄降級」。
// 不連 DB（parseSimilarQuery / sidesForMode / isSimilarEnabled 都不碰資料庫）。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseSimilarQuery, sidesForMode, isSimilarEnabled, DEFAULT_K, MAX_K } = require('../../services/retrievalService');

describe('parseSimilarQuery — k 與 limit', () => {
    test('沒給時用預設值', () => {
        assert.equal(parseSimilarQuery({}).params.k, DEFAULT_K);
    });

    test('limit 是 k 的別名；k 優先', () => {
        assert.equal(parseSimilarQuery({ limit: 5 }).params.k, 5);
        assert.equal(parseSimilarQuery({ k: 3, limit: 5 }).params.k, 3);
    });

    test('超出 1~20 會夾進區間，不回 400', () => {
        assert.equal(parseSimilarQuery({ k: 0 }).params.k, 1);
        assert.equal(parseSimilarQuery({ k: 999 }).params.k, MAX_K);
        assert.equal(parseSimilarQuery({ k: '7.9' }).params.k, 7);
    });

    test('非數字視同沒給', () => {
        assert.equal(parseSimilarQuery({ k: 'abc' }).params.k, DEFAULT_K);
        assert.equal(parseSimilarQuery({ k: '' }).params.k, DEFAULT_K);
    });
});

describe('parseSimilarQuery — mode 與 scope（列舉給錯要 400）', () => {
    test('mode 預設 hybrid，三個合法值都收', () => {
        assert.equal(parseSimilarQuery({}).params.mode, 'hybrid');
        for (const m of ['hybrid', 'vector', 'keyword']) {
            assert.equal(parseSimilarQuery({ mode: m }).params.mode, m);
        }
    });

    test('mode 給錯 → ok:false（呼叫端回 400）', () => {
        const r = parseSimilarQuery({ mode: 'magic' });
        assert.equal(r.ok, false);
        assert.match(r.message, /mode 只接受 hybrid \/ vector \/ keyword/);
    });

    test('scope 預設 chapter，只收 chapter / subject（裁決 19 拿掉 all）', () => {
        assert.equal(parseSimilarQuery({}).params.scope, 'chapter');
        assert.equal(parseSimilarQuery({ scope: 'subject' }).params.scope, 'subject');
    });

    test('scope=all → ok:false，訊息逐字為「scope 只接受 chapter / subject。」', () => {
        const r = parseSimilarQuery({ scope: 'all' });
        assert.equal(r.ok, false);
        assert.equal(r.message, 'scope 只接受 chapter / subject。');
    });
});

describe('parseSimilarQuery — difficulty_delta 與 student_id', () => {
    test('沒給時是 null（＝來源難度 ±1）', () => {
        assert.equal(parseSimilarQuery({}).params.difficultyDelta, null);
        assert.equal(parseSimilarQuery({ difficulty_delta: '' }).params.difficultyDelta, null);
    });

    test('給了就取整並夾在 -4~4', () => {
        assert.equal(parseSimilarQuery({ difficulty_delta: '1' }).params.difficultyDelta, 1);
        assert.equal(parseSimilarQuery({ difficulty_delta: -9 }).params.difficultyDelta, -4);
        assert.equal(parseSimilarQuery({ difficulty_delta: 9 }).params.difficultyDelta, 4);
        assert.equal(parseSimilarQuery({ difficulty_delta: 0 }).params.difficultyDelta, 0);
    });

    test('非數字 → ok:false', () => {
        assert.equal(parseSimilarQuery({ difficulty_delta: 'x' }).ok, false);
    });

    test('student_id 只認整數，其餘視同沒給（查無此人不是錯誤）', () => {
        assert.equal(parseSimilarQuery({ student_id: '7' }).params.studentId, 7);
        assert.equal(parseSimilarQuery({ student_id: 'abc' }).params.studentId, null);
        assert.equal(parseSimilarQuery({}).params.studentId, null);
    });
});

describe('sidesForMode — /similar 的 mode 對應 buildHybridQuery 的 sides', () => {
    test('hybrid 兩側、vector 只向量側、keyword 只關鍵字側', () => {
        assert.deepEqual(sidesForMode('hybrid'), ['vec', 'kw']);
        assert.deepEqual(sidesForMode('vector'), ['vec']);
        assert.deepEqual(sidesForMode('keyword'), ['kw']);
    });
});

describe('isSimilarEnabled — 布林值解讀（interfaces-stage1.md 第 9 條）', () => {
    const backup = process.env.FEATURE_SIMILAR;
    const withFlag = (value, fn) => {
        if (value === undefined) delete process.env.FEATURE_SIMILAR; else process.env.FEATURE_SIMILAR = value;
        try { fn(); } finally {
            if (backup === undefined) delete process.env.FEATURE_SIMILAR; else process.env.FEATURE_SIMILAR = backup;
        }
    };

    test('1 / true（不分大小寫）為真', () => {
        withFlag('1', () => assert.equal(isSimilarEnabled(), true));
        withFlag('TRUE', () => assert.equal(isSimilarEnabled(), true));
    });

    test('其餘皆為假（含未設定、yes、0）', () => {
        withFlag(undefined, () => assert.equal(isSimilarEnabled(), false));
        withFlag('yes', () => assert.equal(isSimilarEnabled(), false));
        withFlag('0', () => assert.equal(isSimilarEnabled(), false));
    });
});
