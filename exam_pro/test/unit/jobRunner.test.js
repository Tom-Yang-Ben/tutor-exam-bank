// ─────────────────────────────────────────────────────────────
// jobRunner.test.js — worker 的純函式部分（A-T11，擁有者：WS-A）
//
// runner 本體要連 PG，測試在 test/integration/jobs.pg.test.js；
// 這裡只測「不需要資料庫也該正確」的那幾支：設定解析、切塊、退避、
// attempt 計數、save 欄位彙整、error_class 正規化。
//
// 順帶釘住一件事：require('workers/jobRunner') 本身**不得**碰資料庫或金鑰，
// 否則 npm test 會在缺 DATABASE_URL 的機器上直接炸。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    loadConfig, planChunks, backoffMs, attemptNo, buildSaveFields, normalizeErrorClass, makeLogger,
    readFeatures, schemaFallbackOf,
    ADVANCEABLE_STATES, FREE_NODES, AGENT_MODULE_FOR_NODE, ERROR_CLASSES,
    RENEW_INTERVAL_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, EXTRACT_MAX_RETRIES
} = require('../../workers/jobRunner');

describe('jobRunner — 模組載入', () => {
    test('require 時不碰 DATABASE_URL、不建連線池', () => {
        // 這支測試能跑到這裡本身就是證明（npm test 不預載 .env）；
        // 再明確斷言一次，免得日後有人把 require('../config/db') 提到模組頂層。
        assert.equal(typeof loadConfig, 'function');
        assert.equal(process.env.DATABASE_URL, undefined);
    });

    test('六個可推進狀態與第 2 條一致', () => {
        assert.deepEqual(ADVANCEABLE_STATES,
            ['extracted', 'hashed', 'classified', 'linted', 'verified', 'deduped']);
    });

    test('零成本節點就是三個純程式節點', () => {
        assert.deepEqual([...FREE_NODES].sort(), ['dedup0', 'dedup1', 'save']);
    });

    test('node → agent 檔名：dedup0／dedup1 共用 agents/dedup.js', () => {
        assert.deepEqual(AGENT_MODULE_FOR_NODE, {
            extract: 'extract', dedup0: 'dedup', classify: 'classify',
            lint: 'lint', verify: 'verify', dedup1: 'dedup'
        });
    });

    test('error_class 就是 DDL CHECK 的九個值', () => {
        assert.deepEqual([...ERROR_CLASSES].sort(), [
            'answer_mismatch', 'budget_exceeded', 'chapter_invalid', 'duplicate', 'formula_unparsable',
            'provider_error', 'rate_limited', 'schema_invalid', 'timeout'
        ]);
    });
});

describe('jobRunner — loadConfig', () => {
    test('全空的環境用第 9 條的預設值', () => {
        const c = loadConfig({});
        assert.deepEqual(c, {
            pollMs: 2000, concurrency: 2, leaseMs: 180000, nodeTimeoutMs: 120000,
            costBudgetUsd: 0.5, dailyCostBudgetUsd: 5, pdfChunkPages: 20,
            inlineMaxBytes: 15728640, classifyMinConf: 0.8, dedupDup: 0.97, dedupVariant: 0.90
        });
    });

    test('讀得到就用環境值（字串會轉數字）', () => {
        const c = loadConfig({
            JOB_POLL_MS: '500', JOB_CONCURRENCY: '4', JOB_LEASE_MS: '9000',
            JOB_NODE_TIMEOUT_MS: '1000', JOB_COST_BUDGET_USD: '0.02',
            DAILY_COST_BUDGET_USD: '1.5', JOB_PDF_CHUNK_PAGES: '5'
        });
        assert.equal(c.pollMs, 500);
        assert.equal(c.concurrency, 4);
        assert.equal(c.leaseMs, 9000);
        assert.equal(c.nodeTimeoutMs, 1000);
        assert.equal(c.costBudgetUsd, 0.02);
        assert.equal(c.dailyCostBudgetUsd, 1.5);
        assert.equal(c.pdfChunkPages, 5);
    });

    test('亂填的值退回預設，不會變成 NaN 讓 setInterval 爆掉', () => {
        const c = loadConfig({ JOB_POLL_MS: 'abc', DAILY_COST_BUDGET_USD: '' });
        assert.equal(c.pollMs, 2000);
        assert.equal(c.dailyCostBudgetUsd, 5);
    });

    test('併發與切塊頁數至少是 1', () => {
        const c = loadConfig({ JOB_CONCURRENCY: '0', JOB_PDF_CHUNK_PAGES: '-3' });
        assert.equal(c.concurrency, 1);
        assert.equal(c.pdfChunkPages, 1);
    });

    test('JOB_LEASE_MS 的預設值 ≥ JOB_NODE_TIMEOUT_MS + 退避總和（第 0.5 條）', () => {
        const c = loadConfig({});
        const backoffTotal = backoffMs(0) + backoffMs(1) + backoffMs(2);   // 1 + 2 + 4 秒
        assert.ok(c.leaseMs >= c.nodeTimeoutMs + backoffTotal,
            `租約 ${c.leaseMs} 必須撐得過 ${c.nodeTimeoutMs} + ${backoffTotal}`);
    });
});

describe('jobRunner — planChunks', () => {
    test('剛好整除', () => {
        assert.deepEqual(planChunks(40, 20), [
            { no: 1, fromPage: 1, toPage: 20 },
            { no: 2, fromPage: 21, toPage: 40 }
        ]);
    });

    test('除不盡時最後一塊只到總頁數', () => {
        assert.deepEqual(planChunks(45, 20), [
            { no: 1, fromPage: 1, toPage: 20 },
            { no: 2, fromPage: 21, toPage: 40 },
            { no: 3, fromPage: 41, toPage: 45 }
        ]);
    });

    test('頁數小於一塊 → 單塊', () => {
        assert.deepEqual(planChunks(3, 20), [{ no: 1, fromPage: 1, toPage: 3 }]);
    });

    test('page_count 為 NULL／0／非數字 → 單塊且 toPage 為 null（交給 agent 判整份）', () => {
        for (const v of [null, undefined, 0, -1, 'x']) {
            assert.deepEqual(planChunks(v, 20), [{ no: 1, fromPage: 1, toPage: null }], `page_count=${v}`);
        }
    });

    test('chunk 編號從 1 起算且連續，頁碼不重疊也不漏', () => {
        const chunks = planChunks(83, 20);
        assert.deepEqual(chunks.map(c => c.no), [1, 2, 3, 4, 5]);
        let expected = 1;
        for (const c of chunks) {
            assert.equal(c.fromPage, expected);
            expected = c.toPage + 1;
        }
        assert.equal(expected - 1, 83);
    });
});

describe('jobRunner — backoffMs', () => {
    test('1s → 2s → 4s（第 2.3 條規則 6）', () => {
        assert.equal(backoffMs(0), 1000);
        assert.equal(backoffMs(1), 2000);
        assert.equal(backoffMs(2), 4000);
    });

    test('封頂 60 秒', () => {
        assert.equal(backoffMs(20), BACKOFF_MAX_MS);
        assert.equal(BACKOFF_MAX_MS, 60000);
        assert.equal(BACKOFF_BASE_MS, 1000);
    });

    test('負數當成 0', () => {
        assert.equal(backoffMs(-5), 1000);
    });

    test('續租間隔是 30 秒、extract 整包只重試 1 次', () => {
        assert.equal(RENEW_INTERVAL_MS, 30000);
        assert.equal(EXTRACT_MAX_RETRIES, 1);
    });
});

describe('jobRunner — attemptNo', () => {
    test('沒跑過就是第 1 次', () => {
        assert.equal(attemptNo({}, 'classify'), 1);
        assert.equal(attemptNo(undefined, 'classify'), 1);
        assert.equal(attemptNo(null, 'classify'), 1);
    });

    test('fail 與 error 兩組計數都要算進去，否則會出現兩個 attempt=2', () => {
        assert.equal(attemptNo({ classify: 2 }, 'classify'), 3);
        assert.equal(attemptNo({ 'classify:error': 1 }, 'classify'), 2);
        assert.equal(attemptNo({ classify: 2, 'classify:error': 3 }, 'classify'), 6);
    });

    test('別的節點的計數不算', () => {
        assert.equal(attemptNo({ lint: 5, 'verify:error': 9 }, 'classify'), 1);
    });
});

describe('jobRunner — normalizeErrorClass', () => {
    for (const ok of [...ERROR_CLASSES]) {
        test(`${ok} 原樣寫進 job_events.error_class`, () => {
            assert.equal(normalizeErrorClass(ok), ok);
        });
    }

    test('不在九個值內的一律回 null（DDL 的 CHECK 不會炸）', () => {
        for (const bad of ['awaiting_approval', 'weird', '', null, undefined]) {
            assert.equal(normalizeErrorClass(bad), null, String(bad));
        }
    });
});

describe('jobRunner — buildSaveFields', () => {
    const base = {
        extract: {
            subject: '數學', chapter: '向量的加減與係數積', question_type: '計算', difficulty: 3,
            question_text: '原始題幹', answer_text: '原始答案'
        }
    };

    test('沒跑過 classify／lint 時用 extract 的原始值', () => {
        assert.deepEqual(buildSaveFields(base), {
            subject: '數學', chapter: '向量的加減與係數積', question_type: '計算', difficulty: 3,
            question_text: '原始題幹', answer_text: '原始答案'
        });
    });

    test('章節用 classify 的最終值（第 3.2 條：save 用 classify.chapter 不用 extract.chapter）', () => {
        const r = buildSaveFields({ ...base, classify: { chapter: '向量內積', confidence: 0.95 } });
        assert.equal(r.chapter, '向量內積');
    });

    test('題幹與答案用 lint 修正後的版本', () => {
        const r = buildSaveFields({ ...base, lint: { question_text: '修好的題幹', answer_text: '修好的答案' } });
        assert.equal(r.question_text, '修好的題幹');
        assert.equal(r.answer_text, '修好的答案');
    });

    test('figure_desc 以 [附圖描述：…] 併回題幹末端（格式與 aiService 一致）', () => {
        const r = buildSaveFields({ extract: { ...base.extract, figure_desc: '一個直角三角形' } });
        assert.equal(r.question_text, '原始題幹\n[附圖描述：一個直角三角形]');
    });

    test('lint 改過的題幹一樣要接上附圖描述', () => {
        const r = buildSaveFields({
            extract: { ...base.extract, figure_desc: '示意圖' },
            lint: { question_text: '修好的題幹' }
        });
        assert.equal(r.question_text, '修好的題幹\n[附圖描述：示意圖]');
    });

    test('題幹裡已經有附圖描述就不重複接（重試時會走到這條）', () => {
        const r = buildSaveFields({
            extract: { ...base.extract, question_text: '題幹\n[附圖描述：圖]', figure_desc: '圖' }
        });
        assert.equal(r.question_text, '題幹\n[附圖描述：圖]');
    });

    test('figure_desc 是空字串或空白時不接', () => {
        for (const v of ['', '   ', null, undefined]) {
            const r = buildSaveFields({ extract: { ...base.extract, figure_desc: v } });
            assert.equal(r.question_text, '原始題幹', `figure_desc=${JSON.stringify(v)}`);
        }
    });

    test('payload 完全是空的也不丟例外（後面交給 validateQuestionFields 擋）', () => {
        assert.deepEqual(buildSaveFields({}), {
            subject: undefined, chapter: undefined, question_type: undefined,
            difficulty: undefined, question_text: '', answer_text: ''
        });
        assert.equal(buildSaveFields(null).question_text, '');
        assert.equal(buildSaveFields(undefined).answer_text, '');
    });
});

describe('jobRunner — readFeatures（裁決 S2-8）', () => {
    /** 這幾格會動 process.env，跑完一定要還原，否則會汙染同一行程的其他測試。 */
    function withEnv(vars, fn) {
        const saved = {};
        for (const [k, v] of Object.entries(vars)) {
            saved[k] = process.env[k];
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        try { fn(); } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
    }

    test('鍵名是小寫短名 similar／pipeline，不是環境變數全名', () => {
        withEnv({ FEATURE_SIMILAR: 'true', FEATURE_PIPELINE: 'true' }, () => {
            assert.deepEqual(readFeatures(), { similar: true, pipeline: true });
        });
    });

    test('未設定時兩個都是 false（旗標預設全關）', () => {
        withEnv({ FEATURE_SIMILAR: undefined, FEATURE_PIPELINE: undefined }, () => {
            assert.deepEqual(readFeatures(), { similar: false, pipeline: false });
        });
    });

    test('沿用 interfaces-stage1.md 第 9 條的布林規則：只有 1／true 為真', () => {
        for (const [raw, expected] of [['1', true], ['true', true], ['TRUE', true],
        ['false', false], ['0', false], ['off', false], ['no', false], ['', false], ['yes', false]]) {
            withEnv({ FEATURE_SIMILAR: raw }, () => {
                assert.equal(readFeatures().similar, expected, `FEATURE_SIMILAR=「${raw}」`);
            });
        }
    });

    test('兩個旗標各自獨立', () => {
        withEnv({ FEATURE_SIMILAR: 'true', FEATURE_PIPELINE: 'false' }, () => {
            assert.deepEqual(readFeatures(), { similar: true, pipeline: false });
        });
    });

    test('即時讀取：改了 env 不用重啟 worker', () => {
        withEnv({ FEATURE_PIPELINE: 'false' }, () => {
            assert.equal(readFeatures().pipeline, false);
            process.env.FEATURE_PIPELINE = 'true';
            assert.equal(readFeatures().pipeline, true);
        });
    });
});

describe('jobRunner — schemaFallbackOf（裁決 S2-4）', () => {
    test('generateJson 回 schemaFallback:true → 記', () => {
        assert.equal(schemaFallbackOf({ schemaFallback: true }, { kind: 'pass', data: {} }), true);
    });

    test('agent 自己放進 outcome.data.schema_fallback → 也記', () => {
        assert.equal(schemaFallbackOf({ schemaFallback: false }, { kind: 'pass', data: { schema_fallback: true } }), true);
    });

    test('兩個來源取 OR', () => {
        assert.equal(schemaFallbackOf({ schemaFallback: true }, { data: { schema_fallback: true } }), true);
    });

    test('都沒走退路 → false（呼叫端因此不寫這個鍵）', () => {
        assert.equal(schemaFallbackOf({ schemaFallback: false }, { kind: 'pass', data: {} }), false);
        assert.equal(schemaFallbackOf(newMeterLike(), { kind: 'fail', reason: 'duplicate' }), false);
    });

    test('缺 meter／缺 outcome／缺 data 都不丟例外', () => {
        assert.equal(schemaFallbackOf(undefined, undefined), false);
        assert.equal(schemaFallbackOf(null, null), false);
        assert.equal(schemaFallbackOf({}, {}), false);
    });

    test('只認嚴格 true，不做寬鬆真值判斷', () => {
        assert.equal(schemaFallbackOf({ schemaFallback: 'true' }, { data: { schema_fallback: 1 } }), false);
    });

    function newMeterLike() {
        return { model: null, tokenIn: 0, tokenOut: 0, calls: 0, schemaFallback: false };
    }
});

describe('jobRunner — makeLogger', () => {
    test('一行一個 JSON，必含 ts 與 level（第 7.5 條）', () => {
        const lines = [];
        const log = makeLogger({ log: (s) => lines.push(s) });
        log.info({ job_id: 1, jq_id: 2, node: 'classify', attempt: 1, outcome: 'pass', latency_ms: 12 });
        log.warn({ msg: '預算用盡' });
        log.error({ msg: '爆了' });

        assert.equal(lines.length, 3);
        const first = JSON.parse(lines[0]);
        assert.equal(first.level, 'info');
        assert.equal(typeof first.ts, 'string');
        assert.deepEqual(
            { job_id: first.job_id, jq_id: first.jq_id, node: first.node, attempt: first.attempt, outcome: first.outcome, latency_ms: first.latency_ms },
            { job_id: 1, jq_id: 2, node: 'classify', attempt: 1, outcome: 'pass', latency_ms: 12 });
        assert.equal(JSON.parse(lines[1]).level, 'warn');
        assert.equal(JSON.parse(lines[2]).level, 'error');
    });
});
