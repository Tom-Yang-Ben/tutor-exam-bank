// ─────────────────────────────────────────────────────────────
// reportJobs.test.js — scripts/report_jobs.js 的純函式（A-T15，擁有者：WS-A）
//
// 聚合 SQL 需要 PG，那部分由 test/integration/jobs.pg.test.js 產生的資料手動驗；
// 這裡測「不需要資料庫也該正確」的：--since 解析、模型字串拆解、同家／異家判定、
// Markdown 排版。require 本檔不得連 DB（report_jobs.js 的 config/db 是延遲 require）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseSince, parseArgs, splitModel, verifyRelation, renderMarkdown, table } =
    require('../../scripts/report_jobs');

describe('report_jobs — parseSince', () => {
    test('7d / 24h / 90m', () => {
        assert.deepEqual(parseSince('7d'), { ms: 7 * 86400000, label: '7d' });
        assert.deepEqual(parseSince('24h'), { ms: 24 * 3600000, label: '24h' });
        assert.deepEqual(parseSince('90m'), { ms: 90 * 60000, label: '90m' });
    });

    test('沒有單位時視為天；不給值時預設 7d', () => {
        assert.equal(parseSince('3').ms, 3 * 86400000);
        assert.equal(parseSince(undefined).label, '7d');
    });

    test('小數與大小寫都收', () => {
        assert.equal(parseSince('0.5d').ms, 43200000);
        assert.equal(parseSince('12H').ms, 12 * 3600000);
    });

    test('格式不對就丟錯，不默默用預設值算出一份錯報表', () => {
        for (const bad of ['7x', '', 'd', '-1d', 'abc', '7 d']) {
            assert.throws(() => parseSince(bad), /--since/, `「${bad}」應該被拒絕`);
        }
    });

    test('0 也要拒絕', () => {
        assert.throws(() => parseSince('0d'), /必須大於 0/);
    });
});

describe('report_jobs — parseArgs', () => {
    test('--key=value 與 --flag', () => {
        assert.deepEqual(parseArgs(['--since=7d', '--json', '--test']),
            { since: '7d', json: true, test: true });
    });

    test('不是 -- 開頭的一律忽略', () => {
        assert.deepEqual(parseArgs(['報表', '-x', '--since=1h']), { since: '1h' });
    });

    test('值裡有等號時只切第一個', () => {
        assert.deepEqual(parseArgs(['--url=postgres://a:b@h/db?x=1']), { url: 'postgres://a:b@h/db?x=1' });
    });
});

describe('report_jobs — splitModel', () => {
    test('帶 vendor 前綴', () => {
        assert.deepEqual(splitModel('gemini:gemini-3.7-flash'), { vendor: 'gemini', id: 'gemini-3.7-flash' });
        assert.deepEqual(splitModel('anthropic:claude-x'), { vendor: 'anthropic', id: 'claude-x' });
    });

    test('裸 ID 視為 gemini（第 5.1 條）', () => {
        assert.deepEqual(splitModel('gemini-3.5-flash'), { vendor: 'gemini', id: 'gemini-3.5-flash' });
    });

    test('空值', () => {
        for (const v of ['', null, undefined, '   ']) {
            assert.deepEqual(splitModel(v), { vendor: null, id: null }, String(v));
        }
    });
});

describe('report_jobs — verifyRelation', () => {
    test('同模型自驗要明講偵錯力極低（對應 config/models.js 的啟動警告）', () => {
        const r = verifyRelation('gemini:gemini-3.5-flash', 'gemini:gemini-3.5-flash');
        assert.deepEqual({ v: r.sameVendor, m: r.sameModel }, { v: true, m: true });
        assert.match(r.label, /同模型自驗/);
    });

    test('同家異級（免費層拿不到 Pro，第一版預期就是這一格）', () => {
        const r = verifyRelation('gemini:gemini-3.5-flash', 'gemini:gemini-3.7-flash');
        assert.deepEqual({ v: r.sameVendor, m: r.sameModel }, { v: true, m: false });
        assert.match(r.label, /同家異級驗證/);
    });

    test('異家', () => {
        const r = verifyRelation('gemini:gemini-3.5-flash', 'anthropic:claude-x');
        assert.deepEqual({ v: r.sameVendor, m: r.sameModel }, { v: false, m: false });
        assert.match(r.label, /異家驗證/);
    });

    test('裸 ID 與帶前綴混用時仍判得出同家', () => {
        assert.equal(verifyRelation('gemini-3.5-flash', 'gemini:gemini-3.7-flash').sameVendor, true);
    });

    test('期間內沒有 LLM 呼叫時回「資料不足」而不是亂猜', () => {
        for (const [a, b] of [[null, null], ['gemini:x', null], [null, 'gemini:y']]) {
            const r = verifyRelation(a, b);
            assert.equal(r.sameVendor, null);
            assert.match(r.label, /資料不足/);
        }
    });
});

describe('report_jobs — table', () => {
    test('空集合印「（期間內沒有資料）」而不是一張空表', () => {
        assert.equal(table(['a', 'b'], []), '（期間內沒有資料）\n');
    });

    test('表頭、分隔列、資料列', () => {
        assert.equal(table(['節點', '次數'], [['classify', '3'], ['lint', '1']]),
            '| 節點 | 次數 |\n| --- | --- |\n| classify | 3 |\n| lint | 1 |\n');
    });
});

describe('report_jobs — renderMarkdown', () => {
    const REPORT = {
        since: { ms: 604800000, label: '7d', from: '2026-08-15T00:00:00.000Z' },
        totals: { events: 42, jobs: 3 },
        nodes: [{
            node: 'classify', calls: 10, p50: 1234.5, p95: 4000, token_in: 5000,
            token_out: 900, token_thinking: 3000, cost_usd: 0.012345, unpriced: 2
        }],
        outcomes: [{ node: 'classify', pass: 8, fail: 1, error: 1, skipped: 0 }],
        errorClasses: [{ error_class: 'rate_limited', n: 3 }],
        reviewReasons: [{ review_reason: 'answer_mismatch', n: 5 }],
        perJob: { jobs: 3, total_cost: 0.09, avg_cost: 0.03, p50_cost: 0.028, max_cost: 0.05, saved: 45 },
        classifyGate: { calls: 10, gate_pass: 9, llm_calls: 1, rate: 0.9 },
        verify: {
            calls: 12, skipped: 2, mismatch: 1, mismatch_rate: 0.1,
            label: '同家異級驗證（gemini：gemini-3.5-flash → gemini-3.7-flash）', sameVendor: true, sameModel: false
        }
    };

    test('每個必要區塊都在（節點、outcome、error_class、review_reason、每份 PDF、閘門、verify）', () => {
        const md = renderMarkdown(REPORT);
        for (const heading of ['每節點的延遲、用量與成本', 'outcome 分佈', 'error_class 分佈',
            'review_reason 分佈', '每份 PDF 的成本', 'classify 零成本閘門', 'verify 的驗證關係']) {
            assert.ok(md.includes(`## ${heading}`), `缺少「${heading}」`);
        }
    });

    test('延遲四捨五入到整數毫秒、成本留六位、比率是百分比', () => {
        const md = renderMarkdown(REPORT);
        assert.ok(md.includes('| classify | 10 | 1235 | 4000 |'), 'p50 1234.5 應四捨五入成 1235');
        assert.ok(md.includes('0.012345'), '成本要留六位');
        assert.ok(md.includes('90.0%'), '閘門通過率');
        assert.ok(md.includes('10.0%'), '不一致率');
    });

    test('每份 PDF 平均入庫題數算得出來', () => {
        assert.ok(renderMarkdown(REPORT).includes('45 / 15.0'));
    });

    test('verify 的同家／異家標示直接印在標題下', () => {
        assert.ok(renderMarkdown(REPORT).includes('同家異級驗證（gemini：gemini-3.5-flash → gemini-3.7-flash）'));
    });

    test('全空的報表也排得出來（不丟例外、不出現 NaN／undefined）', () => {
        const empty = {
            since: { label: '7d', from: '2026-08-15T00:00:00.000Z' },
            totals: { events: 0, jobs: 0 },
            nodes: [], outcomes: [], errorClasses: [], reviewReasons: [],
            perJob: { jobs: 0, total_cost: 0, avg_cost: 0, p50_cost: 0, max_cost: 0, saved: 0 },
            classifyGate: { calls: 0, gate_pass: 0, llm_calls: 0, rate: null },
            verify: { calls: 0, skipped: 0, mismatch: 0, mismatch_rate: null, label: '資料不足（期間內沒有 verify 或 extract 的 LLM 呼叫）' }
        };
        const md = renderMarkdown(empty);
        assert.equal(/NaN|undefined|null/.test(md), false, md);
        assert.ok(md.includes('（期間內沒有資料）'));
    });
});
