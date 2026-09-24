// ─────────────────────────────────────────────────────────────
// kcTagAgent.test.js — agents/tagKc.js（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 3 點）
//
// ctx.llm 全部注入：不連 Gemini、不連 PG、不讀 process.env（第 1.2 條：單元測試不得打網路）。
// 釘住的事：
//   1. 模板註冊字串 = SYSTEM + '\n---\n' + PROMPT_TEMPLATE（第 1.2 條：SYSTEM 改了 cassette 鍵要跟著變）。
//   2. schema 的 enum 就是「該章」的 codes（動態 schema），kc_codes 1–3 個。
//   3. 伺服器端 ajv 再驗一次：模型給了清單外的 code、太多、太少都是 fail，不會被寫進 DB。
//   4. 模型走 ctx.config.models.kcTag，沒給退回 extract；agent 自己不讀 env。
//   5. thinkingBudget 與 maxOutputTokens 成對設定（同 lint／verify 的教訓）：thinking 模型的思考 token
//      計入 maxOutputTokens，不限思考時 JSON 會被截斷、誤歸 schema_invalid。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const agent = require('../../agents/tagKc');
const { getTemplate, templateHash, sha256Hex } = require('../../services/llm/templates');
const { cassetteKey } = require('../../services/llm/cassette');

const KCS = [
    { code: 'MATH.向量內積.01', name: '內積的意義', description: '兩向量的內積定義為長度與夾角餘弦的乘積。' },
    { code: 'MATH.向量內積.02', name: '內積的坐標算法', description: '已知坐標時，內積等於對應分量乘積的和。' },
    { code: 'MATH.向量內積.04', name: '正射影', description: 'a 在 b 上的正射影長度為內積除以 b 的長度。' }
];

const INPUT = {
    subject: '數學',
    chapter: '向量內積',
    question_text: '設 $\\vec{a}=(3,4)$、$\\vec{b}=(1,2)$，求 $\\vec{a}\\cdot\\vec{b}$。',
    answer_text: '$11$',
    kcs: KCS
};

const GOOD = {
    kc_codes: [{ code: 'MATH.向量內積.02', confidence: 0.93 }],
    rationale: '題目給坐標求內積，用對應分量乘積的和。'
};

function fakeCtx({ data = GOOD, models = { kcTag: 'gemini:gemini-3.5-flash' }, throws = null } = {}) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                async generateJson(opts) {
                    calls.push(opts);
                    if (throws) throw throws;
                    return { data, usage: { tokenIn: 900, tokenOut: 60, tokenThinking: 0, tokenCached: 0 }, latencyMs: 5, raw: null };
                }
            },
            config: { models },
            logger: { info() { }, warn() { }, error() { } },
            signal: undefined
        }
    };
}

describe('模板與 schema', () => {
    test('註冊字串 = SYSTEM + "\\n---\\n" + PROMPT_TEMPLATE（第 1.2 條）', () => {
        assert.equal(getTemplate(agent.TEMPLATE), `${agent.SYSTEM}\n---\n${agent.PROMPT_TEMPLATE}`);
        assert.equal(templateHash(agent.TEMPLATE), sha256Hex(`${agent.SYSTEM}\n---\n${agent.PROMPT_TEMPLATE}`));
        assert.equal(agent.TEMPLATE, 'kc_tag.v1');
        assert.equal(agent.AGENT, 'kc_tag');
    });

    test('SYSTEM 改一個字，cassette 鍵就不同（模板雜湊涵蓋 SYSTEM）', () => {
        // 同一個識別名註冊不同內容會丟錯（撞名保護），所以用兩個臨時識別名模擬「改了 SYSTEM」
        const { registerTemplate } = require('../../services/llm/templates');
        registerTemplate('kc_tag.test-a', `${agent.SYSTEM}\n---\n${agent.PROMPT_TEMPLATE}`);
        registerTemplate('kc_tag.test-b', `${agent.SYSTEM}！\n---\n${agent.PROMPT_TEMPLATE}`);
        const base = { agent: 'kc_tag', modelId: 'gemini-3.5-flash', schema: {}, cacheKeyParts: {} };
        assert.notEqual(cassetteKey({ ...base, template: 'kc_tag.test-a' }), cassetteKey({ ...base, template: 'kc_tag.test-b' }));
    });

    test('schema 的 enum 就是該章的 codes，kc_codes 1–3 個，深凍結', () => {
        const s = agent.buildTagSchema(KCS.map(k => k.code));
        assert.deepEqual(s.properties.kc_codes.items.properties.code.enum, KCS.map(k => k.code));
        assert.equal(s.properties.kc_codes.minItems, 1);
        assert.equal(s.properties.kc_codes.maxItems, 3);
        assert.deepEqual(s.required, ['kc_codes', 'rationale']);
        assert.ok(Object.isFrozen(s));
        assert.ok(Object.isFrozen(s.properties.kc_codes.items.properties.code.enum));
    });

    test('同一組 codes 回同一個物件（schemaHash 在同一行程內不漂）；不同章回不同 schema', () => {
        const a = agent.buildTagSchema(['A.x.01', 'A.x.02']);
        assert.equal(agent.buildTagSchema(['A.x.01', 'A.x.02']), a);
        assert.notEqual(agent.buildTagSchema(['A.x.01', 'A.x.03']), a);
    });
});

describe('prompt', () => {
    test('含科目、章節、每個知識點的 code 與名稱、題目、答案', () => {
        const p = agent.buildPrompt(INPUT);
        for (const k of KCS) {
            assert.ok(p.includes(k.code), k.code);
            assert.ok(p.includes(k.name), k.name);
        }
        assert.ok(p.includes('【科目】數學'));
        assert.ok(p.includes('【章節】向量內積'));
        assert.ok(p.includes(INPUT.question_text));
        assert.ok(p.includes('$11$'));
        assert.ok(!p.includes('{{'), '還有沒替換的佔位字串');
    });

    test('題幹裡的 $$…$$ 與 $\' 原樣保留（不被 String.replace 當成特殊樣式）', () => {
        const q = '求 $$\\int_0^1 x\\,dx$$ 與 $f\'(x)$ 的值。';
        const p = agent.buildPrompt({ ...INPUT, question_text: q, answer_text: '$$\\frac12$$' });
        assert.ok(p.includes(q), p);
        assert.ok(p.includes('$$\\frac12$$'));
    });

    test('沒有答案時寫「（未提供）」；說明太長會截斷', () => {
        const p = agent.buildPrompt({ ...INPUT, answer_text: '', kcs: [{ ...KCS[0], description: '長'.repeat(500) }] });
        assert.ok(p.includes('（未提供）'));
        assert.ok(!p.includes('長'.repeat(200)));
    });

    test('清單雜湊：知識點說明改了，雜湊就變（cassette 鍵跟著變）', () => {
        const h1 = agent.kcListHash(KCS);
        const h2 = agent.kcListHash([{ ...KCS[0], description: '改過的說明' }, ...KCS.slice(1)]);
        assert.notEqual(h1, h2);
        assert.equal(h1, agent.kcListHash(KCS.map(k => ({ ...k }))));
    });
});

describe('run()', () => {
    test('正常路徑：agent 名、模板、模型、schema、cacheKeyParts 都照合約', async () => {
        const { ctx, calls } = fakeCtx();
        const out = await agent.run(ctx, INPUT);
        assert.equal(out.kind, 'pass');
        assert.deepEqual(out.data, { kc_codes: [{ code: 'MATH.向量內積.02', confidence: 0.93 }], rationale: GOOD.rationale });

        assert.equal(calls.length, 1);
        const c = calls[0];
        assert.equal(c.agent, 'kc_tag');
        assert.equal(c.template, 'kc_tag.v1');
        assert.equal(c.model, 'gemini:gemini-3.5-flash');
        assert.equal(c.system, agent.SYSTEM);
        assert.deepEqual(c.schema.properties.kc_codes.items.properties.code.enum, KCS.map(k => k.code));
        assert.deepEqual(Object.keys(c.cacheKeyParts), ['template', 'subject', 'chapter', 'questionText', 'answerText', 'kcCodes', 'kcListHash']);
        assert.deepEqual(c.cacheKeyParts.kcCodes, KCS.map(k => k.code).sort());
        assert.equal(c.parts.length, 1);
        assert.ok(c.parts[0].text.includes(INPUT.question_text));
    });

    test('thinkingBudget 與 maxOutputTokens 成對送出：思考上限之外還留得下整份 JSON', async () => {
        const { ctx, calls } = fakeCtx();
        await agent.run(ctx, INPUT);
        const c = calls[0];
        assert.equal(c.thinkingBudget, agent.THINKING_BUDGET);
        assert.equal(c.maxOutputTokens, agent.MAX_OUTPUT_TOKENS);
        // services/llm/gemini.js 只在 thinkingBudget 是整數時才送 thinkingConfig
        assert.ok(Number.isInteger(c.thinkingBudget));
        // 不設 0：MODEL_KC_TAG 若改成 Pro 系列，那一支不接受關閉思考
        assert.ok(c.thinkingBudget > 0);
        // 扣掉思考上限，JSON（1–3 個 code＋100 字 rationale，約 250 token）還有十倍以上的餘裕
        assert.ok(c.maxOutputTokens - c.thinkingBudget >= 2048, `${c.maxOutputTokens} - ${c.thinkingBudget}`);
    });

    test('模型：kcTag 沒給就退回 extract；兩個都沒給就交給 services/llm 的預設', async () => {
        const a = fakeCtx({ models: { extract: 'gemini:gemini-3.5-flash' } });
        await agent.run(a.ctx, INPUT);
        assert.equal(a.calls[0].model, 'gemini:gemini-3.5-flash');
        const b = fakeCtx({ models: {} });
        await agent.run(b.ctx, INPUT);
        assert.equal(b.calls[0].model, undefined);
    });

    test('agent 不讀 process.env.MODEL_KC_TAG（env 的解析在 kcTagService）', async () => {
        const saved = process.env.MODEL_KC_TAG;
        process.env.MODEL_KC_TAG = 'gemini:不該被讀到';
        try {
            const { ctx, calls } = fakeCtx({ models: { kcTag: 'gemini:gemini-2.5-flash' } });
            await agent.run(ctx, INPUT);
            assert.equal(calls[0].model, 'gemini:gemini-2.5-flash');
        } finally {
            if (saved === undefined) delete process.env.MODEL_KC_TAG; else process.env.MODEL_KC_TAG = saved;
        }
    });

    test('該章沒有知識點 → skipped，一次 LLM 都不呼叫', async () => {
        const { ctx, calls } = fakeCtx();
        assert.deepEqual(await agent.run(ctx, { ...INPUT, kcs: [] }), { kind: 'skipped', data: { reason: 'no_kcs' } });
        assert.deepEqual(await agent.run(ctx, { ...INPUT, kcs: undefined }), { kind: 'skipped', data: { reason: 'no_kcs' } });
        assert.equal(calls.length, 0);
    });

    test('題幹是空的 → fail，不呼叫 LLM', async () => {
        const { ctx, calls } = fakeCtx();
        const out = await agent.run(ctx, { ...INPUT, question_text: '  ' });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'schema_invalid');
        assert.equal(calls.length, 0);
    });

    test('同一個 code 出現兩次只留一次（信心取大的）', async () => {
        const { ctx } = fakeCtx({
            data: {
                kc_codes: [{ code: 'MATH.向量內積.02', confidence: 0.7 }, { code: 'MATH.向量內積.02', confidence: 0.9 },
                { code: 'MATH.向量內積.01', confidence: 0.4 }],
                rationale: 'x'
            }
        });
        const out = await agent.run(ctx, INPUT);
        assert.deepEqual(out.data.kc_codes, [{ code: 'MATH.向量內積.02', confidence: 0.9 }, { code: 'MATH.向量內積.01', confidence: 0.4 }]);
    });

    test('伺服器端 ajv：清單外的 code、0 個、4 個、信心 > 1、缺 rationale、多欄位 → fail', async () => {
        const bad = [
            { kc_codes: [{ code: 'MATH.向量內積.99', confidence: 0.9 }], rationale: 'x' },
            { kc_codes: [{ code: 'PHYS.功與動能.01', confidence: 0.9 }], rationale: 'x' },
            { kc_codes: [], rationale: 'x' },
            { kc_codes: [KCS[0], KCS[1], KCS[2], KCS[0]].map(k => ({ code: k.code, confidence: 0.8 })), rationale: 'x' },
            { kc_codes: [{ code: 'MATH.向量內積.01', confidence: 1.2 }], rationale: 'x' },
            { kc_codes: [{ code: 'MATH.向量內積.01', confidence: 0.9 }] },
            { kc_codes: [{ code: 'MATH.向量內積.01', confidence: 0.9, weight: 1 }], rationale: 'x' },
            { kc_codes: [{ code: 'MATH.向量內積.01', confidence: 0.9 }], rationale: 'x', extra: true }
        ];
        for (const data of bad) {
            const { ctx } = fakeCtx({ data });
            const out = await agent.run(ctx, INPUT);
            assert.equal(out.kind, 'fail', JSON.stringify(data));
            assert.equal(out.reason, 'schema_invalid');
            assert.ok(out.feedback.includes('schema'), out.feedback);
        }
        const { ctx } = fakeCtx({ data: { kc_codes: [{ code: 'MATH.向量內積.99', confidence: 0.9 }], rationale: 'x' } });
        assert.ok((await agent.run(ctx, INPUT)).feedback.includes('MATH.向量內積.99'));
    });

    test('供應商丟錯 → error（不 throw），errorClass 沿用例外上的值', async () => {
        const { ctx } = fakeCtx({ throws: Object.assign(new Error('LLM_MODE=replay 找不到 cassette'), { errorClass: 'provider_error' }) });
        const out = await agent.run(ctx, INPUT);
        assert.equal(out.kind, 'error');
        assert.equal(out.errorClass, 'provider_error');
        assert.ok(out.message.includes('cassette'));
        const r = fakeCtx({ throws: Object.assign(new Error('429'), { errorClass: 'rate_limited' }) });
        assert.equal((await agent.run(r.ctx, INPUT)).errorClass, 'rate_limited');
    });

    test('rationale 太長截到 200 字，不讓整題失敗', async () => {
        const { ctx } = fakeCtx({ data: { ...GOOD, rationale: '長'.repeat(500) } });
        const out = await agent.run(ctx, INPUT);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.rationale.length, 200);
    });
});