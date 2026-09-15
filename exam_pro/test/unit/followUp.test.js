// test/unit/followUp.test.js — 承上題純函式（DEC-012／FR-019）
// 題幹全為自製內容（repo 公開，NOTICE 規定不得放真實考卷文字）。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    isFollowUp, findPredecessorRow, resolveQuestionId, buildChunkInfo, MAX_RESOLVE_DEPTH
} = require('../../utils/followUp');

describe('isFollowUp', () => {
    test('題幹開頭「承上題」', () => {
        assert.equal(isFollowUp('承上題，若把小球質量加倍，加速度變為多少？'), true);
    });
    test('題幹中間出現也算', () => {
        assert.equal(isFollowUp('（3）承上題所求之向量，其長度為何？'), true);
    });
    test('「承上一題」', () => {
        assert.equal(isFollowUp('承上一題，求 $x$ 的最小值。'), true);
    });
    test('簡體「承上题」', () => {
        assert.equal(isFollowUp('承上题，求面积。'), true);
    });
    test('字間夾空白仍算', () => {
        assert.equal(isFollowUp('承 上 一 題，求周長。'), true);
    });
    test('「承第 3 題」不算', () => {
        assert.equal(isFollowUp('承第 3 題，求 $y$。'), false);
    });
    test('一般題與非字串為假', () => {
        assert.equal(isFollowUp('設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。'), false);
        assert.equal(isFollowUp(null), false);
        assert.equal(isFollowUp(undefined), false);
        assert.equal(isFollowUp(123), false);
    });
});

describe('findPredecessorRow', () => {
    const rows = [
        { id: 11, idx: 1001 }, { id: 12, idx: 1002 }, { id: 14, idx: 1004 },
        { id: 21, idx: 2001 }, { id: 22, idx: 2002 }
    ];

    test('同塊連號 → idx - 1', () => {
        assert.equal(findPredecessorRow(rows, { idx: 1002 }).row.id, 11);
        assert.equal(findPredecessorRow(rows, { idx: 2002 }).row.id, 21);
    });
    test('同塊空號 → extract_gap（中間元素被 schema 驗證丟掉，不猜）', () => {
        assert.deepEqual(findPredecessorRow(rows, { idx: 1004 }), { unresolved: 'extract_gap' });
    });
    test('跨塊：某塊第一題取上一塊最後一題', () => {
        assert.equal(findPredecessorRow(rows, { idx: 2001 }).row.id, 14);
    });
    test('上一塊整塊沒有題時往更前面找', () => {
        const sparse = [{ id: 1, idx: 1003 }, { id: 3, idx: 3001 }];
        assert.equal(findPredecessorRow(sparse, { idx: 3001 }).row.id, 1);
    });
    test('第一塊第一題 → first_in_job', () => {
        assert.deepEqual(findPredecessorRow(rows, { idx: 1001 }), { unresolved: 'first_in_job' });
    });
    test('rows 不是陣列時不丟錯', () => {
        assert.deepEqual(findPredecessorRow(null, { idx: 1001 }), { unresolved: 'first_in_job' });
        assert.deepEqual(findPredecessorRow(undefined, { idx: 1002 }), { unresolved: 'extract_gap' });
    });
});

describe('findPredecessorRow — 塊尾被 extract 丟掉（M1：不猜）', () => {
    const withElements = (idx, n) => ({ id: idx, idx, payload: { extract: { chunk_elements: n } } });

    test('上一塊塊尾被丟（存活最大位置 < chunk_elements）→ extract_gap，不綁到上一塊倒數第二題', () => {
        const rows = [withElements(1001, 3), withElements(1002, 3), withElements(2001, 1)];
        const info = buildChunkInfo(rows);
        assert.deepEqual(findPredecessorRow(rows, { idx: 2001 }, info), { unresolved: 'extract_gap' });
    });
    test('上一塊元素全數存活 → 取上一塊最後一題', () => {
        const rows = [withElements(1001, 2), withElements(1002, 2), withElements(2001, 1)];
        assert.equal(findPredecessorRow(rows, { idx: 2001 }, buildChunkInfo(rows)).row.id, 1002);
    });
    test('上一塊整塊被丟（沒有存活列、chunk_elements 由事件補不到）且有 rejected → extract_gap', () => {
        const rows = [withElements(1001, 1), withElements(3001, 1)];
        const info = buildChunkInfo(rows, [{ chunk: '2', rejected: '2' }]);
        assert.deepEqual(findPredecessorRow(rows, { idx: 3001 }, info), { unresolved: 'extract_gap' });
    });
    test('上一塊是空塊（chunk_elements 未知、rejected = 0）→ 往更前一塊找', () => {
        const rows = [withElements(1001, 1), withElements(3001, 1)];
        const info = buildChunkInfo(rows, [{ chunk: '2', rejected: '0' }]);
        assert.equal(findPredecessorRow(rows, { idx: 3001 }, info).row.id, 1001);
    });
    test('整份第一題但位置 > 1（位置 1 的元素被丟）→ extract_gap；位置 = 1 才是 first_in_job', () => {
        const rows = [withElements(1002, 2), withElements(1003, 2)];
        assert.deepEqual(findPredecessorRow(rows, { idx: 1002 }, buildChunkInfo(rows)), { unresolved: 'extract_gap' });
        const first = [withElements(1001, 1)];
        assert.deepEqual(findPredecessorRow(first, { idx: 1001 }, buildChunkInfo(first)), { unresolved: 'first_in_job' });
    });
    test('舊資料（無 chunk_elements）fallback：上一塊 extract 事件 rejected > 0 → extract_gap', () => {
        const rows = [{ id: 1, idx: 1001 }, { id: 2, idx: 1002 }, { id: 3, idx: 2001 }];
        const info = buildChunkInfo(rows, [{ chunk: '1', rejected: '1' }, { chunk: '2', rejected: '0' }]);
        assert.deepEqual(findPredecessorRow(rows, { idx: 2001 }, info), { unresolved: 'extract_gap' });
    });
    test('舊資料 fallback：rejected = 0 或查無事件 → 照原邏輯取上一塊最後一題', () => {
        const rows = [{ id: 1, idx: 1001 }, { id: 2, idx: 1002 }, { id: 3, idx: 2001 }];
        assert.equal(findPredecessorRow(rows, { idx: 2001 }, buildChunkInfo(rows, [{ chunk: 1, rejected: 0 }])).row.id, 2);
        assert.equal(findPredecessorRow(rows, { idx: 2001 }).row.id, 2);
    });
    test('buildChunkInfo：chunk_elements 取自列、rejected 以後出現的事件為準', () => {
        const info = buildChunkInfo(
            [withElements(1001, 4), { idx: 2001, payload: {} }],
            [{ chunk: '2', rejected: '3' }, { chunk: '2', rejected: '1' }, { chunk: 'x', rejected: '1' }]);
        assert.deepEqual(info.get(1), { elements: 4, rejected: null });
        assert.deepEqual(info.get(2), { elements: null, rejected: 1 });
        assert.equal(info.size, 2);
    });
});

describe('resolveQuestionId', () => {
    const map = (...rows) => new Map(rows.map(r => [r.id, r]));

    test('saved → question_id', () => {
        const row = { id: 1, state: 'saved', question_id: 42, payload: {} };
        assert.deepEqual(resolveQuestionId(row, map(row)), { question_id: 42 });
    });
    test('saved 優先於 payload 內的舊命中（重複題被人核准成新題）', () => {
        const row = { id: 1, state: 'saved', question_id: 43, payload: { dedup0: { hit: { scope: 'db', question_id: 7 } } } };
        assert.deepEqual(resolveQuestionId(row, map(row)), { question_id: 43 });
    });
    test('dedup0 撞庫內題 → hit.question_id（needs_review 或 rejected 皆同）', () => {
        for (const state of ['needs_review', 'rejected']) {
            const row = { id: 1, state, question_id: null, payload: { dedup0: { hit: { scope: 'db', question_id: 7 } } } };
            assert.deepEqual(resolveQuestionId(row, map(row)), { question_id: 7 }, state);
        }
    });
    test('dedup0 撞同 job 題 → 對 hit.jq_id 那列遞迴', () => {
        const first = { id: 1, state: 'saved', question_id: 50, payload: {} };
        const dup = { id: 2, state: 'needs_review', question_id: null, payload: { dedup0: { hit: { scope: 'job', jq_id: 1 } } } };
        assert.deepEqual(resolveQuestionId(dup, map(first, dup)), { question_id: 50 });
    });
    test('同 job 命中的那列不在 map → predecessor_missing', () => {
        const dup = { id: 2, state: 'needs_review', payload: { dedup0: { hit: { scope: 'job', jq_id: 99 } } } };
        assert.deepEqual(resolveQuestionId(dup, map(dup)), { unresolved: 'predecessor_missing' });
    });
    test('dedup1 判重複 → top[0].question_id', () => {
        const row = {
            id: 1, state: 'needs_review', question_id: null,
            payload: { dedup1: { verdict: 'duplicate', threshold_used: 0.97, top: [{ question_id: 8, cosine: 0.99 }, { question_id: 9, cosine: 0.95 }] } }
        };
        assert.deepEqual(resolveQuestionId(row, map(row)), { question_id: 8 });
    });
    test('其餘 needs_review → predecessor_pending；仍在管線中也是 pending', () => {
        const review = { id: 1, state: 'needs_review', payload: { dedup1: { verdict: 'unique', top: [] } } };
        const inflight = { id: 2, state: 'classified', payload: { dedup0: { hit: null } } };
        assert.deepEqual(resolveQuestionId(review, map(review)), { unresolved: 'predecessor_pending' });
        assert.deepEqual(resolveQuestionId(inflight, map(inflight)), { unresolved: 'predecessor_pending' });
    });
    test('其餘 rejected → predecessor_rejected', () => {
        const row = { id: 1, state: 'rejected', payload: {} };
        assert.deepEqual(resolveQuestionId(row, map(row)), { unresolved: 'predecessor_rejected' });
    });
    test('同 job 命中鏈超過深度上限 → resolve_depth_exceeded（自我指向也不會無限遞迴）', () => {
        const loop = { id: 1, state: 'needs_review', payload: { dedup0: { hit: { scope: 'job', jq_id: 1 } } } };
        assert.deepEqual(resolveQuestionId(loop, map(loop)), { unresolved: 'resolve_depth_exceeded' });

        // 恰好 MAX_RESOLVE_DEPTH 層仍可解析
        const rows = [{ id: 0, state: 'saved', question_id: 77, payload: {} }];
        for (let i = 1; i <= MAX_RESOLVE_DEPTH; i++) {
            rows.push({ id: i, state: 'needs_review', payload: { dedup0: { hit: { scope: 'job', jq_id: i - 1 } } } });
        }
        assert.deepEqual(resolveQuestionId(rows[MAX_RESOLVE_DEPTH], map(...rows)), { question_id: 77 });
        rows.push({ id: MAX_RESOLVE_DEPTH + 1, state: 'needs_review', payload: { dedup0: { hit: { scope: 'job', jq_id: MAX_RESOLVE_DEPTH } } } });
        assert.deepEqual(resolveQuestionId(rows[MAX_RESOLVE_DEPTH + 1], map(...rows)), { unresolved: 'resolve_depth_exceeded' });
    });
    test('row 為空 → predecessor_missing', () => {
        assert.deepEqual(resolveQuestionId(null, new Map()), { unresolved: 'predecessor_missing' });
    });
});
