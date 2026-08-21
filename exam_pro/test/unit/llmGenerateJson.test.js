// services/llm 的 generateJson／cassette／throttle／models／pricing 單元測試（WS-B / A-T3）
//
// 全部走 LLM_MODE=replay 或直接呼叫純函式：不連 Gemini、不需要金鑰、不碰 repo 內的 eval/cassettes。
//
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cassette = require('../../services/llm/cassette');
const templates = require('../../services/llm/templates');
const fake = require('../../services/llm/fake');
const throttle = require('../../services/llm/throttle');
const models = require('../../config/models');
const pricing = require('../../config/pricing');
const llm = require('../../services/llm');

let tmpDir;
const envBackup = {};
const ENV_KEYS = ['EVAL_CASSETTE_DIR', 'LLM_MODE', 'MODEL_EXTRACT', 'MODEL_VERIFY', 'GEMINI_RPM', 'JOB_CONCURRENCY'];

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-cassette-'));
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
    process.env.EVAL_CASSETTE_DIR = tmpDir;   // 絕對路徑，不會落回 repo 的 eval/cassettes
    process.env.LLM_MODE = 'replay';
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    fake._resetForTest();
    throttle._resetForTest();
});

// ───────────────────────── config/models.js ─────────────────────────

describe('config/models.js — parseModel', () => {
    test('帶 vendor 前綴：拆成 vendor 與裸 ID', () => {
        assert.deepEqual(models.parseModel('gemini:gemini-3.5-flash'), {
            vendor: 'gemini', id: 'gemini-3.5-flash', spec: 'gemini:gemini-3.5-flash'
        });
    });

    test('沒有冒號時 vendor 預設 gemini', () => {
        assert.deepEqual(models.parseModel('gemini-3.7-flash'), {
            vendor: 'gemini', id: 'gemini-3.7-flash', spec: 'gemini:gemini-3.7-flash'
        });
    });

    test('未知 vendor 丟錯', () => {
        assert.throws(() => models.parseModel('cohere:command-r'), /未知的供應商/);
    });

    test('空字串與只有 vendor 都丟錯', () => {
        assert.throws(() => models.parseModel(''), /空的/);
        assert.throws(() => models.parseModel('gemini:'), /缺少模型 ID/);
    });

    test('MODEL_EXTRACT／MODEL_VERIFY 是即時讀 env 的 getter', () => {
        process.env.MODEL_EXTRACT = 'gemini:custom-a';
        assert.equal(models.MODEL_EXTRACT, 'gemini:custom-a');
        delete process.env.MODEL_EXTRACT;
        assert.equal(models.MODEL_EXTRACT, 'gemini:gemini-3.5-flash');   // 裁決 S0-5 的預設
    });
});

describe('config/models.js — warnIfSameModel', () => {
    test('同一個裸 ID 才警告，訊息逐字凍結', () => {
        const seen = [];
        const original = console.warn;
        console.warn = (msg) => seen.push(String(msg));
        try {
            process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
            process.env.MODEL_VERIFY = 'gemini-3.5-flash';       // 同 ID、不同寫法
            assert.equal(models.warnIfSameModel(), true);
            assert.equal(seen[0], '[models] MODEL_VERIFY 與 MODEL_EXTRACT 是同一個模型（gemini-3.5-flash），驗證幾乎無效');

            seen.length = 0;
            process.env.MODEL_VERIFY = 'gemini:gemini-3.7-flash';
            assert.equal(models.warnIfSameModel(), false);
            assert.equal(seen.length, 0);
        } finally {
            console.warn = original;
            delete process.env.MODEL_EXTRACT;
            delete process.env.MODEL_VERIFY;
        }
    });
});

// ───────────────────────── config/pricing.js ─────────────────────────

describe('config/pricing.js — estimateCost', () => {
    test('verified_on 是 null → 記 0 且 cost_estimated=false（不猜數字）', () => {
        const r = pricing.estimateCost({ modelId: 'gemini-3.5-flash', tokenIn: 1000, tokenOut: 500, tokenThinking: 900 });
        assert.deepEqual(r, { cost_usd: 0, cost_estimated: false });
    });

    test('查不到的模型同樣回 0 / false', () => {
        assert.deepEqual(pricing.estimateCost({ modelId: '不存在的模型' }), { cost_usd: 0, cost_estimated: false });
    });

    test('有查證日期時：thinking 與 candidates 同價、cached 從 input 扣掉', () => {
        const backup = { ...pricing.PRICING['gemini-3.5-flash'] };
        pricing.PRICING['gemini-3.5-flash'] = { input: 1, output: 10, cached: 0.5, verified_on: '2026-08-22' };
        try {
            const r = pricing.estimateCost({
                modelId: 'gemini-3.5-flash', tokenIn: 1_000_000, tokenOut: 100_000, tokenThinking: 900_000, tokenCached: 200_000
            });
            // (1_000_000-200_000)*1 + (100_000+900_000)*10 + 200_000*0.5 = 800_000 + 10_000_000 + 100_000
            assert.equal(r.cost_estimated, true);
            assert.equal(r.cost_usd, Number(((800000 + 10000000 + 100000) / 1e6).toFixed(6)));
        } finally {
            pricing.PRICING['gemini-3.5-flash'] = backup;
        }
    });

    test('價目表的每一列都有四個欄位', () => {
        for (const [id, row] of Object.entries(pricing.PRICING)) {
            assert.equal(typeof row.input, 'number', id);
            assert.equal(typeof row.output, 'number', id);
            assert.equal(typeof row.cached, 'number', id);
            assert.ok(row.verified_on === null || /^\d{4}-\d{2}-\d{2}$/.test(row.verified_on), id);
        }
    });
});

// ───────────────────────── cassette 的鍵 ─────────────────────────

describe('cassette 鍵（interfaces-stage2.md 第 5.2 條）', () => {
    const base = {
        agent: 'classify',
        modelId: 'gemini-3.5-flash',
        template: 'classify.vTest',
        schema: { type: 'object' },
        cacheKeyParts: { template: 'classify.vTest', questionText: '求 $\\vec{a}\\cdot\\vec{b}$', fewShotIds: [12, 87] }
    };

    test('同樣的輸入 → 同樣的鍵（可重現）', () => {
        assert.equal(cassette.cassetteKey(base), cassette.cassetteKey({ ...base }));
    });

    test('五個組成部分任一個變了，鍵就變', () => {
        const k0 = cassette.cassetteKey(base);
        assert.notEqual(k0, cassette.cassetteKey({ ...base, agent: 'extract' }));
        assert.notEqual(k0, cassette.cassetteKey({ ...base, modelId: 'gemini-3.7-flash' }));
        assert.notEqual(k0, cassette.cassetteKey({ ...base, template: 'classify.vOther' }));
        assert.notEqual(k0, cassette.cassetteKey({ ...base, schema: { type: 'object', additionalProperties: false } }));
        assert.notEqual(k0, cassette.cassetteKey({
            ...base, cacheKeyParts: { ...base.cacheKeyParts, fewShotIds: [12, 88] }
        }));
    });

    test('schema 的 enum 改了（＝章節白名單改了）鍵一定變——這是刻意的', () => {
        const a = cassette.cassetteKey({ ...base, schema: { enum: ['向量內積'] } });
        const b = cassette.cassetteKey({ ...base, schema: { enum: ['向量內積', '外積'] } });
        assert.notEqual(a, b);
    });

    test('沒給 agent 直接丟錯', () => {
        assert.throws(() => cassette.cassetteKey({ ...base, agent: '' }), /agent 是必填/);
    });

    test('註冊過模板原文時，改內容（識別名不變）也會換鍵', () => {
        templates.registerTemplate('t.vX', '模板原文 A');
        const k1 = cassette.cassetteKey({ ...base, template: 't.vX' });
        templates._resetForTest();
        templates.registerTemplate('t.vX', '模板原文 B');
        const k2 = cassette.cassetteKey({ ...base, template: 't.vX' });
        assert.notEqual(k1, k2);
        templates._resetForTest();
    });

    test('同一個識別名註冊成不同內容 → 丟錯（兩個 agent 撞名會汙染彼此的鍵）', () => {
        templates.registerTemplate('dup.v1', 'AAA');
        assert.throws(() => templates.registerTemplate('dup.v1', 'BBB'), /已被註冊成不同內容/);
        templates._resetForTest();
    });
});

// ───────────────────────── request 摘要不得含原文 ─────────────────────────

describe('cassette 的 request 只存摘要', () => {
    test('text 只留字數與 sha256，PDF 只留位元組數與 sha256', () => {
        const pdfBase64 = Buffer.from('%PDF-1.4 假的').toString('base64');
        const summary = cassette.summarizeParts([{ text: '一段題幹' }, { pdfBase64 }]);
        assert.deepEqual(Object.keys(summary[0]).sort(), ['chars', 'kind', 'sha256']);
        assert.equal(summary[0].chars, 4);
        assert.equal(summary[1].kind, 'pdf');
        assert.equal(summary[1].bytes, Buffer.from('%PDF-1.4 假的').length);
        // 最重要的一條：整個摘要裡不得出現原文
        assert.ok(!JSON.stringify(summary).includes('一段題幹'));
        assert.ok(!JSON.stringify(summary).includes(pdfBase64));
    });
});

// ───────────────────────── replay ─────────────────────────

describe('LLM_MODE=replay（services/llm/fake.js）', () => {
    const opts = {
        model: 'gemini-3.5-flash',
        agent: 'classify',
        template: 'classify.vReplay',
        schema: { type: 'object' },
        cacheKeyParts: { template: 'classify.vReplay', questionText: 'Q', fewShotIds: [] }
    };

    test('命中：回 data / usage 四欄 / latencyMs，raw 為 null', () => {
        const key = cassette.cassetteKey({ ...opts, modelId: opts.model });
        cassette.writeCassette({
            agent: 'classify', key,
            meta: { agent: 'classify', model: opts.model, template: opts.template, recorded_at: '2026-08-22T00:00:00.000Z', fixtureHash: null },
            request: { parts: [], cacheKeyParts: opts.cacheKeyParts },
            response: { data: { chapter: '向量內積', confidence: 0.9 }, usage: { tokenIn: 812, tokenOut: 96, tokenThinking: 240, tokenCached: 0 }, latencyMs: 1873 }
        });

        const res = fake.generateJson(opts);
        assert.deepEqual(res.data, { chapter: '向量內積', confidence: 0.9 });
        assert.deepEqual(res.usage, { tokenIn: 812, tokenOut: 96, tokenThinking: 240, tokenCached: 0 });
        assert.equal(res.latencyMs, 1873);
        assert.equal(res.raw, null);
        assert.equal(res.replayed, true);
    });

    test('miss：丟錯，訊息前半段逐字凍結，且不得回假資料', () => {
        const missOpts = { ...opts, cacheKeyParts: { template: opts.template, questionText: '沒錄過的題', fewShotIds: [] } };
        const key = cassette.cassetteKey({ ...missOpts, modelId: missOpts.model });
        assert.throws(() => fake.generateJson(missOpts), (err) => {
            assert.ok(err.message.startsWith(
                `LLM_MODE=replay 找不到 cassette（agent=classify key=${key}）。請在本機執行 npm run eval:record -- --suite <suite>`
            ), err.message);
            return true;
        });
    });

    test('meta.fixtureHash 與現況不符：印 warning 但**仍然回放**', () => {
        const staleOpts = { ...opts, cacheKeyParts: { template: opts.template, questionText: '過期的', fewShotIds: [] } };
        const key = cassette.cassetteKey({ ...staleOpts, modelId: staleOpts.model });
        cassette.writeCassette({
            agent: 'classify', key,
            meta: { agent: 'classify', model: staleOpts.model, template: staleOpts.template, recorded_at: 'x', fixtureHash: '0'.repeat(64) },
            request: { parts: [], cacheKeyParts: staleOpts.cacheKeyParts },
            response: { data: { ok: true }, usage: {}, latencyMs: 1 }
        });

        const seen = [];
        const original = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            const res = fake.generateJson(staleOpts);
            assert.deepEqual(res.data, { ok: true });
            assert.equal(res.usage.tokenIn, 0);              // 缺欄位一律補 0
            assert.ok(seen.some(m => m.includes('few-shot 內容已變')), seen.join('\n'));
        } finally {
            console.warn = original;
        }
    });

    test('經 services/llm 的 generateJson 進來也走同一支 cassette（vendor 前綴會被剝掉）', async () => {
        const res = await llm.generateJson({ ...opts, model: 'gemini:gemini-3.5-flash' });
        assert.equal(res.data.chapter, '向量內積');
    });
});

// ───────────────────────── record ─────────────────────────

describe('LLM_MODE=record 的檔案格式', () => {
    test('寫成 <dir>/<agent>/<key>.json，同鍵覆寫', () => {
        const key = 'a'.repeat(64);
        const first = cassette.writeCassette({
            agent: 'extract', key,
            meta: { agent: 'extract', model: 'gemini-3.5-flash', template: 'extract.v1', recorded_at: 'x', fixtureHash: null },
            request: { parts: [], cacheKeyParts: {} },
            response: { data: { questions: [] }, usage: {}, latencyMs: 1 }
        });
        assert.equal(first.overwritten, false);
        assert.equal(first.file, path.join(tmpDir, 'extract', `${key}.json`));

        const second = cassette.writeCassette({
            agent: 'extract', key,
            meta: { agent: 'extract', model: 'gemini-3.5-flash', template: 'extract.v1', recorded_at: 'y', fixtureHash: null },
            request: { parts: [], cacheKeyParts: {} },
            response: { data: { questions: [1] }, usage: {}, latencyMs: 2 }
        });
        assert.equal(second.overwritten, true);
        const body = JSON.parse(fs.readFileSync(second.file, 'utf8'));
        assert.deepEqual(Object.keys(body), ['meta', 'request', 'response']);
        assert.deepEqual(body.response.data, { questions: [1] });
    });
});

// ───────────────────────── throttle ─────────────────────────

describe('services/llm/throttle.js', () => {
    test('併發桶：超過 JOB_CONCURRENCY 的呼叫要等前面的 release', async () => {
        process.env.JOB_CONCURRENCY = '2';
        process.env.GEMINI_RPM = '1000';
        throttle._resetForTest();

        const r1 = await throttle.acquire('gemini');
        const r2 = await throttle.acquire('gemini');
        let third = false;
        const p3 = throttle.acquire('gemini').then((r) => { third = true; return r; });

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(third, false, '第三個呼叫在前兩個 release 之前不該拿到許可');

        r1();
        const r3 = await p3;
        assert.equal(third, true);
        r2(); r3();
        delete process.env.JOB_CONCURRENCY;
        delete process.env.GEMINI_RPM;
    });

    test('release 重複呼叫無害（不會多還一個併發槽）', async () => {
        process.env.JOB_CONCURRENCY = '1';
        throttle._resetForTest();
        const r = await throttle.acquire('gemini');
        r(); r(); r();
        const r2 = await throttle.acquire('gemini');   // 沒有卡住就代表槽位帳沒有算錯
        r2();
        delete process.env.JOB_CONCURRENCY;
    });

    test('每個供應商一組桶，彼此不擋', async () => {
        process.env.JOB_CONCURRENCY = '1';
        throttle._resetForTest();
        const a = await throttle.acquire('gemini');
        const b = await throttle.acquire('anthropic');   // 不同 vendor，不該被 gemini 的桶擋住
        a(); b();
        delete process.env.JOB_CONCURRENCY;
    });

    test('RPM 上限依 <VENDOR>_RPM 讀取，沒設就是 60', () => {
        delete process.env.GEMINI_RPM;
        assert.equal(throttle.rpmFor('gemini'), 60);
        process.env.GEMINI_RPM = '15';
        assert.equal(throttle.rpmFor('gemini'), 15);
        delete process.env.GEMINI_RPM;
    });
});

// ───────────────────────── 模式旗標 ─────────────────────────

describe('LLM_MODE 的解讀', () => {
    test('只接受 live / record / replay', () => {
        process.env.LLM_MODE = 'nonsense';
        assert.throws(() => llm.llmMode(), /LLM_MODE 只能是/);
        process.env.LLM_MODE = 'replay';
        assert.equal(llm.llmMode(), 'replay');
    });
});
