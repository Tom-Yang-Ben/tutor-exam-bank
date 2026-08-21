// agents/lint、agents/verify、agents/dedup 單元測試（A-T10a/b/c / WS-C）
//
// 契約：docs/interfaces-stage2.md 第 3.1／3.3 條。
// 全部走 ctx 注入：假的 llm、假的 db——不連 DB、不連 Gemini、不需 secrets。
// 三個 agent 都**不得 throw**，任何例外都要變成 {kind:'error', errorClass}。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const lintAgent = require('../../agents/lint');
const verifyAgent = require('../../agents/verify');
const dedupAgent = require('../../agents/dedup');
const dedup0Node = require('../../agents/dedup0');
const dedup1Node = require('../../agents/dedup1');

// ───────────────────────── 假的 ctx ─────────────────────────

const DEFAULT_CONFIG = {
    models: { extract: 'gemini:gemini-3.5-flash', verify: 'gemini:gemini-3.7-flash' },
    limits: { maxRetries: { classify: 2, lint: 2, verify: 1 }, maxErrorRetries: 3, budgetLeft: Infinity },
    thresholds: { classifyMinConf: 0.8, dedupDup: 0.97, dedupVariant: 0.90 },
};

/**
 * @param {{gen?:function, embed?:function, query?:function, config?:object, node?:string}} o
 */
function makeCtx(o = {}) {
    const calls = { gen: [], embed: [], query: [] };
    const ctx = {
        llm: {
            async generateJson(opts) {
                calls.gen.push(opts);
                if (!o.gen) throw new Error('測試沒有準備 generateJson 的回應');
                return o.gen(opts, calls.gen.length);
            },
            async embed(opts) {
                calls.embed.push(opts);
                if (!o.embed) throw new Error('測試沒有準備 embed 的回應');
                return o.embed(opts);
            },
        },
        db: {
            pool: { connect: async () => { throw new Error('單元測試不得連 DB'); } },
            async query(text, values) {
                calls.query.push({ text, values });
                if (!o.query) return { rows: [], rowCount: 0 };
                return o.query(text, values, calls.query.length);
            },
        },
        job: { id: 41, budget_usd: 0.5, cost_usd: 0 },
        jq: { id: 551, idx: 1001, payload: {}, retries: {} },
        logger: { info() {}, warn() {}, error() {} },
        config: o.config || DEFAULT_CONFIG,
        signal: undefined,
        node: o.node,
    };
    return { ctx, calls };
}

/** 讓 generateJson 丟一個特定的例外 */
const thrower = (err) => () => { throw err; };

// ═════════════════════ agents/lint.js ═════════════════════

describe('agents/lint — ①② 零成本閘門先跑，通過就不呼叫 LLM', () => {
    test('乾淨的題目直接 pass，一次 LLM 都不呼叫', async () => {
        const { ctx, calls } = makeCtx();
        const out = await lintAgent.run(ctx, {
            question_text: '已知 $\\log_{2} 8 = 3$，求 $\\log_{2} 4$。',
            answer_text: '$2$。',
        });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.rewritten, false);
        assert.deepEqual(out.data.applied, []);
        assert.equal(calls.gen.length, 0, '不該呼叫 LLM');
    });

    test('formulaFix 修得好的型樣也不必呼叫 LLM', async () => {
        const { ctx, calls } = makeCtx();
        const out = await lintAgent.run(ctx, { question_text: '$X$^{2} 的值為何？', answer_text: '' });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.question_text, '$X^{2}$ 的值為何？');
        assert.deepEqual(out.data.applied, ['dollar_script_swap']);
        assert.equal(out.data.rewritten, false);
        assert.equal(calls.gen.length, 0);
    });

    test('只有 warn 的題目照樣放行（閘門只擋 error）', async () => {
        const { ctx, calls } = makeCtx();
        const out = await lintAgent.run(ctx, { question_text: '加速度為 10 m/s。', answer_text: '' });
        assert.equal(out.kind, 'pass');
        assert.ok(out.data.issues.some(i => i.sev === 'warn'));
        assert.ok(out.data.issues.every(i => i.sev !== 'error'));
        assert.equal(calls.gen.length, 0);
    });
});

describe('agents/lint — ③ 仍有 error 才呼叫 LLM 重寫', () => {
    const broken = { question_text: '$\\vecc{a}$ 與 $\\vec{b}$ 的內積為 $0$。', answer_text: '互相垂直。' };

    test('模型改好了 → pass 且 rewritten=true', async () => {
        const { ctx, calls } = makeCtx({
            gen: () => ({
                data: { question_text: '$\\vec{a}$ 與 $\\vec{b}$ 的內積為 $0$。', answer_text: '互相垂直。', notes: '把 \\vecc 改成 \\vec' },
                usage: { tokenIn: 100, tokenOut: 20, tokenThinking: 5, tokenCached: 0 }, latencyMs: 10, raw: {},
            }),
        });
        const out = await lintAgent.run(ctx, broken);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.rewritten, true);
        assert.ok(!out.data.question_text.includes('vecc'));
        assert.equal(calls.gen.length, 1);
    });

    test('LLM 的呼叫參數符合第 5 條（agent / template / cacheKeyParts / schema / signal）', async () => {
        const { ctx, calls } = makeCtx({
            gen: () => ({ data: { question_text: '$\\vec{a}$。', answer_text: '', notes: '' }, usage: {}, latencyMs: 1, raw: {} }),
        });
        await lintAgent.run(ctx, broken);
        const opts = calls.gen[0];
        assert.equal(opts.agent, 'lint');
        assert.equal(opts.template, 'lint.v1');
        assert.equal(opts.model, DEFAULT_CONFIG.models.extract, 'lint 的第三層用 MODEL_EXTRACT');
        assert.equal(opts.cacheKeyParts.template, 'lint.v1');
        assert.ok(Array.isArray(opts.cacheKeyParts.issues));
        assert.deepEqual(opts.cacheKeyParts.issues, [...opts.cacheKeyParts.issues].sort(), 'issues 必須排序過才可重現');
        assert.ok(opts.schema && opts.schema.type === 'object');
        assert.ok(Object.isFrozen(opts.schema), 'schema 應該是深凍結的');
    });

    test('prompt 帶上偵測到的 issues 與上一輪的 feedback', async () => {
        const { ctx, calls } = makeCtx({
            gen: () => ({ data: { question_text: '$\\vec{a}$。', answer_text: '', notes: '' }, usage: {}, latencyMs: 1, raw: {} }),
        });
        await lintAgent.run(ctx, { ...broken, feedback: '上一次把數字改掉了' });
        const prompt = calls.gen[0].parts[0].text;
        assert.ok(prompt.includes('unknown_command'), 'issues 應該進 prompt');
        assert.ok(prompt.includes('上一次把數字改掉了'), 'feedback 應該進 prompt');
    });

    test('模型改完仍有 error → fail(formula_unparsable) 並附具體理由', async () => {
        const { ctx } = makeCtx({
            gen: () => ({ data: { question_text: '$\\vecc{a}$ 還是壞的', answer_text: '', notes: '' }, usage: {}, latencyMs: 1, raw: {} }),
        });
        const out = await lintAgent.run(ctx, broken);
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'formula_unparsable');
        assert.ok(out.feedback.includes('unknown_command'));
        assert.equal(out.data.rewritten, true);
    });

    test('模型沒回 question_text → fail 而不是把空字串寫進題庫', async () => {
        const { ctx } = makeCtx({ gen: () => ({ data: {}, usage: {}, latencyMs: 1, raw: {} }) });
        const out = await lintAgent.run(ctx, broken);
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'formula_unparsable');
        assert.equal(out.data.question_text, broken.question_text, '原文要留著給人看');
    });

    test('供應商例外分類成 errorClass 而不是往上丟', async () => {
        const cases = [
            [Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'timeout'],
            [new Error('429 Too Many Requests: rate limit'), 'rate_limited'],
            [new Error('500 internal error'), 'provider_error'],
        ];
        for (const [err, expected] of cases) {
            const { ctx } = makeCtx({ gen: thrower(err) });
            const out = await lintAgent.run(ctx, broken);
            assert.equal(out.kind, 'error', err.message);
            assert.equal(out.errorClass, expected, err.message);
        }
    });
});

// ═════════════════════ agents/verify.js ═════════════════════

const okSample = (final_answer, answer_form = 'option') => () => ({
    data: { final_answer, answer_form, steps_summary: '略。' },
    usage: {}, latencyMs: 1, raw: {},
});

describe('agents/verify — 證明題與基本流程', () => {
    test('證明題直接 skipped，不呼叫模型', async () => {
        const { ctx, calls } = makeCtx();
        const out = await verifyAgent.run(ctx, {
            question_text: '試證：等腰三角形兩底角相等。', question_type: '證明', claimed_answer: '略',
        });
        assert.equal(out.kind, 'skipped');
        assert.deepEqual(out.data, { skipped: true });
        assert.equal(calls.gen.length, 0);
    });

    test('agree → pass，samples=1', async () => {
        const { ctx, calls } = makeCtx({ gen: okSample('(A)') });
        const out = await verifyAgent.run(ctx, {
            question_text: '下列何者正確？', question_type: '單選',
            claimed_answer: '(A)。因為兩者相等。',
        });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.compare, 'agree');
        assert.equal(out.data.samples, 1);
        assert.equal(calls.gen.length, 1);
    });

    test('claimed_answer 絕不進 prompt', async () => {
        const secret = '(C)。這是拆題模型抄下來的答案。';
        const { ctx, calls } = makeCtx({ gen: okSample('(A)') });
        await verifyAgent.run(ctx, {
            question_text: '下列何者正確？', question_type: '單選', claimed_answer: secret,
        });
        const sent = JSON.stringify({ system: calls.gen[0].system, parts: calls.gen[0].parts, keys: calls.gen[0].cacheKeyParts });
        assert.ok(!sent.includes('(C)'), 'claimed_answer 洩漏到 prompt 或 cacheKeyParts 了');
        assert.ok(!sent.includes('拆題模型抄下來'), 'claimed_answer 洩漏到 prompt 了');
    });

    test('disagree → fail(answer_mismatch)，payload 存兩個答案', async () => {
        const { ctx, calls } = makeCtx({ gen: okSample('(B)') });
        const out = await verifyAgent.run(ctx, {
            question_text: '下列何者正確？', question_type: '單選', claimed_answer: '(C)',
        });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'answer_mismatch');
        assert.equal(out.data.final_answer, '(B)');
        assert.equal(out.data.claimed_answer, '(C)');
        assert.equal(out.data.compare, 'disagree');
        assert.equal(out.data.samples, 1, 'disagree 不必再採樣');
        assert.equal(calls.gen.length, 1);
        assert.ok(out.feedback.includes('(B)') && out.feedback.includes('(C)'));
    });
});

describe('agents/verify — uncertain 再採樣一次', () => {
    test('第一次 uncertain、第二次 agree → pass 且 samples=2', async () => {
        const { ctx, calls } = makeCtx({
            gen: (opts, n) => (n === 1
                ? { data: { final_answer: '不確定', answer_form: 'text', steps_summary: '' }, usage: {}, latencyMs: 1, raw: {} }
                : { data: { final_answer: '(A)', answer_form: 'option', steps_summary: '' }, usage: {}, latencyMs: 1, raw: {} }),
        });
        const out = await verifyAgent.run(ctx, {
            question_text: '下列何者正確？', question_type: '單選', claimed_answer: '(A)',
        });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.samples, 2);
        assert.equal(calls.gen.length, 2);
        assert.equal(calls.gen[0].cacheKeyParts.sampleNo, 1);
        assert.equal(calls.gen[1].cacheKeyParts.sampleNo, 2, '第二次採樣要有自己的 cassette 鍵');
    });

    test('兩次都 uncertain → fail(answer_mismatch)，samples=2', async () => {
        const { ctx, calls } = makeCtx({ gen: okSample('無法判斷', 'text') });
        const out = await verifyAgent.run(ctx, {
            question_text: '下列何者正確？', question_type: '單選', claimed_answer: '甲',
        });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'answer_mismatch');
        assert.equal(out.data.compare, 'uncertain');
        assert.equal(out.data.samples, 2);
        assert.equal(calls.gen.length, 2, '最多就是採樣兩次');
    });

    test('計算題走 answerCompare 的數值路徑', async () => {
        const { ctx } = makeCtx({ gen: okSample('0.5', 'number') });
        const out = await verifyAgent.run(ctx, {
            question_text: '求 $\\frac{1}{2}$ 之值。', question_type: '計算',
            claimed_answer: '答案為 $\\frac{1}{2}$。',
        });
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.compare, 'agree');
    });

    test('用的是 MODEL_VERIFY 而不是 MODEL_EXTRACT', async () => {
        const { ctx, calls } = makeCtx({ gen: okSample('(A)') });
        await verifyAgent.run(ctx, { question_text: 'x', question_type: '單選', claimed_answer: '(A)' });
        assert.equal(calls.gen[0].model, DEFAULT_CONFIG.models.verify);
        assert.equal(calls.gen[0].agent, 'verify');
        assert.equal(calls.gen[0].template, 'verify.v1');
    });

    test('供應商例外變成 error 而不是往上丟', async () => {
        const { ctx } = makeCtx({ gen: thrower(new Error('503 model overloaded')) });
        const out = await verifyAgent.run(ctx, { question_text: 'x', question_type: '單選', claimed_answer: '(A)' });
        assert.equal(out.kind, 'error');
        assert.equal(out.errorClass, 'provider_error');
    });
});

// ═════════════════════ agents/dedup.js（L0） ═════════════════════

const isQuestionsHashQuery = (sql) => /FROM questions/.test(sql) && /text_hash/.test(sql);
const isJobQuery = (sql) => /FROM job_questions/.test(sql);

describe('agents/dedup — L0（雜湊），在任何 LLM 呼叫之前', () => {
    test('沒撞到就 pass，並把 text_hash 寫進 payload', async () => {
        const { ctx, calls } = makeCtx({ query: () => ({ rows: [] }) });
        const out = await dedupAgent.runDedup0(ctx, { question_text: '求 $x$ 之值。' });
        assert.equal(out.kind, 'pass');
        assert.match(out.data.text_hash, /^[0-9a-f]{64}$/);
        assert.ok(out.data.normalized_len > 0);
        assert.equal(out.data.hit, null);
        assert.equal(calls.embed.length, 0);
        assert.equal(calls.gen.length, 0, 'L0 一毛錢都不該花');
    });

    test('撞到庫內既有題 → fail(duplicate)，hit.scope = db', async () => {
        const { ctx } = makeCtx({
            query: (sql) => (isQuestionsHashQuery(sql) ? { rows: [{ id: 128 }] } : { rows: [] }),
        });
        const out = await dedupAgent.runDedup0(ctx, { question_text: '求 $x$ 之值。' });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'duplicate');
        assert.deepEqual(out.data.hit, { scope: 'db', question_id: 128 });
        assert.ok(out.feedback.includes('128'));
    });

    test('撞到同一 job 內較早的題 → fail(duplicate)，hit.scope = job', async () => {
        const { ctx, calls } = makeCtx({
            query: (sql) => (isJobQuery(sql) ? { rows: [{ id: 55, idx: 1000 }] } : { rows: [] }),
        });
        const out = await dedupAgent.runDedup0(ctx, { question_text: '求 $x$ 之值。' });
        assert.equal(out.kind, 'fail');
        assert.deepEqual(out.data.hit, { scope: 'job', jq_id: 55 });
        const jobCall = calls.query.find(c => isJobQuery(c.text));
        assert.deepEqual(jobCall.values.slice(0, 2), [41, 1001], '只比較 idx 比自己小的列');
    });

    test('題幹正規化後是空的 → fail(schema_invalid)，不默默放行', async () => {
        const { ctx } = makeCtx({ query: () => ({ rows: [] }) });
        for (const v of ['', '   ', '[附圖描述：只有一張圖]']) {
            const out = await dedupAgent.runDedup0(ctx, { question_text: v });
            assert.equal(out.kind, 'fail', JSON.stringify(v));
            assert.equal(out.reason, 'schema_invalid');
            assert.equal(out.data.text_hash, null);
        }
    });

    test('DB 例外變成 error 而不是往上丟', async () => {
        const { ctx } = makeCtx({ query: () => { throw new Error('connection terminated'); } });
        const out = await dedupAgent.runDedup0(ctx, { question_text: '求 $x$ 之值。' });
        assert.equal(out.kind, 'error');
        assert.equal(out.errorClass, 'provider_error');
    });

    test('與 utils/normalizeStem 的雜湊一致', async () => {
        const { textHash } = require('../../utils/normalizeStem');
        const { ctx } = makeCtx({ query: () => ({ rows: [] }) });
        const text = '(A) 甲　(B) 乙';
        const out = await dedupAgent.runDedup0(ctx, { question_text: text });
        assert.equal(out.data.text_hash, textHash(text));
    });
});

// ═════════════════════ agents/dedup.js（L1） ═════════════════════

const VEC = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
const withSimilarOn = { ...DEFAULT_CONFIG, features: { similar: true } };
const withSimilarOff = { ...DEFAULT_CONFIG, features: { similar: false } };

const L1_INPUT = { question_id: null, embed_text: '數學\n向量內積\n求兩向量夾角', subject: '數學', chapter: '向量內積' };

describe('agents/dedup — L1（向量餘弦）', () => {
    test('FEATURE_SIMILAR 關掉 → skipped', async () => {
        const { ctx, calls } = makeCtx({ config: withSimilarOff });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'skipped');
        assert.equal(out.data.verdict, 'skipped');
        assert.equal(calls.embed.length, 0);
    });

    test('來源題沒有向量 → skipped', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            query: () => ({ rows: [{ embedding: null }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, { ...L1_INPUT, question_id: 7 });
        assert.equal(out.kind, 'skipped');
        assert.equal(out.data.verdict, 'skipped');
    });

    test('embed_text 是空的 → skipped', async () => {
        const { ctx, calls } = makeCtx({ config: withSimilarOn });
        const out = await dedupAgent.runDedup1(ctx, { ...L1_INPUT, embed_text: '   ' });
        assert.equal(out.kind, 'skipped');
        assert.equal(calls.embed.length, 0);
    });

    test('餘弦 ≥ DEDUP_DUP_THRESHOLD → fail(duplicate)', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            embed: () => ({ vectors: [VEC], usage: { tokenIn: 10 } }),
            query: () => ({ rows: [{ id: 87, cosine: 0.9812 }, { id: 90, cosine: 0.71 }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'duplicate');
        assert.equal(out.data.verdict, 'duplicate');
        assert.equal(out.data.threshold_used, 0.97);
        assert.deepEqual(out.data.top[0], { question_id: 87, cosine: 0.9812 });
        assert.ok(out.feedback.includes('87'));
    });

    test('餘弦 ≥ DEDUP_VARIANT_THRESHOLD → pass(variant)，照常入庫', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            embed: () => ({ vectors: [VEC], usage: {} }),
            query: () => ({ rows: [{ id: 87, cosine: 0.9312 }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.verdict, 'variant');
        assert.equal(out.data.threshold_used, 0.90);
        assert.equal(out.data.top.length, 1);
    });

    test('都不到門檻 → pass(unique)', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            embed: () => ({ vectors: [VEC], usage: {} }),
            query: () => ({ rows: [{ id: 87, cosine: 0.42 }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.verdict, 'unique');
    });

    test('候選一筆都沒有 → pass(unique)，top 為空', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            embed: () => ({ vectors: [VEC], usage: {} }),
            query: () => ({ rows: [] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.verdict, 'unique');
        assert.deepEqual(out.data.top, []);
    });

    test('top 最多 5 筆、由大到小排序', async () => {
        const { ctx, calls } = makeCtx({
            config: withSimilarOn,
            embed: () => ({ vectors: [VEC], usage: {} }),
            query: () => ({ rows: [{ id: 1, cosine: 0.5 }, { id: 2, cosine: 0.8 }, { id: 3, cosine: 0.6 }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.deepEqual(out.data.top.map(t => t.question_id), [2, 3, 1]);
        assert.match(calls.query[0].text, /LIMIT 5/);
        assert.match(calls.query[0].text, /subject = \$2/, '候選限定同一學科');
    });

    test('門檻讀 ctx.config.thresholds，不是寫死的', async () => {
        const { ctx } = makeCtx({
            config: { ...withSimilarOn, thresholds: { dedupDup: 0.80, dedupVariant: 0.50 } },
            embed: () => ({ vectors: [VEC], usage: {} }),
            query: () => ({ rows: [{ id: 87, cosine: 0.85 }] }),
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'fail');
        assert.equal(out.data.threshold_used, 0.80);
    });

    test('embed 例外變成 error', async () => {
        const { ctx } = makeCtx({
            config: withSimilarOn,
            embed: () => { throw new Error('429 quota exceeded'); },
        });
        const out = await dedupAgent.runDedup1(ctx, L1_INPUT);
        assert.equal(out.kind, 'error');
        assert.equal(out.errorClass, 'rate_limited');
    });
});

describe('agents/dedup — 節點分派', () => {
    test('ctx.node 指定時以它為準', async () => {
        const { ctx } = makeCtx({ node: 'dedup0', query: () => ({ rows: [] }) });
        const out = await dedupAgent.run(ctx, { question_text: '求 $x$ 之值。' });
        assert.equal(out.data.text_hash.length, 64);
    });

    test('沒有 ctx.node 時看 input 有沒有 embed_text', async () => {
        const { ctx: c1 } = makeCtx({ query: () => ({ rows: [] }) });
        const l0 = await dedupAgent.run(c1, { question_text: '求 $x$ 之值。' });
        assert.equal(l0.data.hit, null);

        const { ctx: c2 } = makeCtx({ config: withSimilarOff });
        const l1 = await dedupAgent.run(c2, L1_INPUT);
        assert.equal(l1.data.verdict, 'skipped');
    });

    test('agents/dedup0.js 與 dedup1.js 是轉接檔，run 對得上', async () => {
        assert.equal(dedup0Node.run, dedupAgent.runDedup0);
        assert.equal(dedup1Node.run, dedupAgent.runDedup1);
    });
});

// ═════════════════════ 三個 agent 的共同契約 ═════════════════════

describe('agent 共同契約（介面第 3.1 條）', () => {
    const AGENTS = [
        ['lint', lintAgent, { question_text: '$x$', answer_text: '' }],
        ['verify', verifyAgent, { question_text: 'x', question_type: '證明', claimed_answer: '' }],
        ['dedup0', dedup0Node, { question_text: '求 $x$ 之值。' }],
        ['dedup1', dedup1Node, L1_INPUT],
    ];

    for (const [name, mod, input] of AGENTS) {
        test(`${name}：匯出 run，回傳四種 outcome 之一`, async () => {
            assert.equal(typeof mod.run, 'function');
            const { ctx } = makeCtx({ config: withSimilarOff, query: () => ({ rows: [] }) });
            const out = await mod.run(ctx, input);
            assert.ok(['pass', 'skipped', 'fail', 'error'].includes(out.kind), JSON.stringify(out));
            if (out.kind === 'fail') assert.equal(typeof out.reason, 'string');
            if (out.kind === 'error') assert.equal(typeof out.errorClass, 'string');
        });

        test(`${name}：input 缺漏或整包是 undefined 也不得 throw`, async () => {
            const { ctx } = makeCtx({ config: withSimilarOff, query: () => ({ rows: [] }) });
            for (const bad of [undefined, null, {}, { question_text: null }]) {
                await assert.doesNotReject(() => mod.run(ctx, bad), `${name} 對 ${JSON.stringify(bad)} 丟了例外`);
            }
        });
    }
});
