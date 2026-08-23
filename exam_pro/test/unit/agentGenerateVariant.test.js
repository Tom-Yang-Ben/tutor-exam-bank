// agents/generateVariant.js 的單元測試（WS-B / P-11a）
//
// ctx.llm 全部注入：不連 Gemini、不連 PG、不讀 process.env。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const agent = require('../../agents/generateVariant');
const { buildSchema } = require('../../agents/schemas');

const SOURCE = {
    id: 12,
    subject: '數學',
    chapter: '向量內積',
    question_type: '計算',
    difficulty: 3,
    question_text: '設 $\\vec{a}=(3,4)$、$\\vec{b}=(1,2)$，求兩向量的夾角餘弦值。',
    answer_text: '$\\frac{11}{5\\sqrt{5}}$',
    variant_of: null
};

const NEIGHBORS = [
    { id: 91, chapter: '向量內積', question_text: '設 $\\vec{u}=(2,1)$、$\\vec{v}=(-1,3)$，求 $\\vec{u}\\cdot\\vec{v}$。' },
    { id: 87, chapter: '向量內積', question_text: '若 $\\vec{a}\\perp\\vec{b}$，求 $k$。' }
];

/** 一個看起來合格的模型輸出（情境與數字都換過） */
const GOOD = {
    chapter: '向量內積',
    chapter_confidence: 0.95,
    question_type: '計算',
    difficulty: 3,
    question_text: '在平面上，甲船的位移為 $\\vec{p}=(6,8)$ 公里，乙船的位移為 $\\vec{q}=(5,-12)$ 公里。試求兩船位移方向之間夾角的餘弦值為何？',
    answer_text: '$-\\frac{54}{130}$，化簡後為 $-\\frac{27}{65}$。'
};

/**
 * 假 ctx：embed 依「文本是否相同」給出可控的餘弦。
 * 預設兩個向量夾角很小（餘弦 0.96），跑題檢查會過。
 */
function fakeCtx({ data = GOOD, sim = 0.96, thresholds = {}, models = {}, embedThrows = false } = {}) {
    const calls = { generateJson: [], embed: [] };
    // 兩個 768 維的單位向量，內積剛好是 sim
    const a = new Array(768).fill(0); a[0] = 1;
    const b = new Array(768).fill(0); b[0] = sim; b[1] = Math.sqrt(Math.max(0, 1 - sim * sim));
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.generateJson.push(opts);
                    return { data, usage: { tokenIn: 10, tokenOut: 5, tokenThinking: 3, tokenCached: 0 }, latencyMs: 7, raw: null, schemaFallback: false };
                },
                embed: async (opts) => {
                    calls.embed.push(opts);
                    if (embedThrows) throw new Error('embedding 服務掛了');
                    return { vectors: [a, b], usage: { tokenIn: 4 } };
                }
            },
            db: null,
            job: { id: 41, kind: 'variant', pdf_sha256: null, budget_usd: 0.3, cost_usd: 0 },
            jq: null,
            logger: { info() { }, warn() { }, error() { } },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash', verify: 'gemini:gemini-3.1-pro-preview', ...models },
                limits: {},
                thresholds: { variantSimMin: 0.80, variantMinEdit: 0.08, ...thresholds }
            },
            signal: undefined
        }
    };
}

const INPUT = { source: SOURCE, neighbors: NEIGHBORS, difficulty_delta: 0, idx: 1 };

// ───────────────────────── 純函式 ─────────────────────────

describe('純函式', () => {
    test('targetDifficulty 夾在 1~5', () => {
        assert.equal(agent.targetDifficulty(3, 0), 3);
        assert.equal(agent.targetDifficulty(3, 1), 4);
        assert.equal(agent.targetDifficulty(1, -1), 1);
        assert.equal(agent.targetDifficulty(5, 1), 5);
        assert.equal(agent.targetDifficulty('4', '-1'), 3);
    });

    test('familyRoot = COALESCE(variant_of, id)', () => {
        assert.equal(agent.familyRoot({ id: 12, variant_of: null }), 12);
        assert.equal(agent.familyRoot({ id: 88, variant_of: 12 }), 12);
        assert.equal(agent.familyRoot({ id: 7 }), 7);
        assert.equal(agent.familyRoot({}), null);
    });

    test('anchor_ids 由小到大、只取前 5 個鄰居、濾掉非整數', () => {
        // 先取前 5 個鄰居（第 4.2 條的「前 5 題」），再濾掉沒有 id 的，最後排序——
        // 順序反過來的話「第 6 個鄰居」會補上來，anchor_ids 就不再等於真正送進 prompt 的那幾題。
        const ids = agent.anchorIdsOf([{ id: 9 }, { id: 3 }, { id: null }, { id: 7 }, { id: 1 }, { id: 5 }, { id: 2 }]);
        assert.deepEqual(ids, [1, 3, 7, 9]);
    });

    test('沒有鄰居時 neighborsText 是空字串（題庫初期不是失敗）', () => {
        assert.equal(agent.neighborsText([]), '');
        assert.equal(agent.neighborsText(undefined), '');
    });

    test('prompt 只列該科白名單、含藍本與鄰居、佔位符全部被換掉', () => {
        const prompt = agent.buildPrompt({ ...INPUT, source: SOURCE });
        assert.ok(prompt.includes('向量內積'));
        assert.ok(!prompt.includes('牛頓運動定律'), '數學題的 prompt 不該出現物理章節');
        assert.ok(prompt.includes(SOURCE.question_text));
        assert.ok(prompt.includes('設 $\\vec{u}=(2,1)$'), '鄰居要進 prompt 當風格錨點');
        assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), `還有沒換掉的佔位符：${prompt.match(/\{\{[A-Z_]+\}\}/g)}`);
    });

    test('模板有註冊進 templates.js（cassette 的 promptTemplateHash 來源）', () => {
        const { getTemplate } = require('../../services/llm/templates');
        assert.equal(getTemplate(agent.TEMPLATE), agent.PROMPT_TEMPLATE);
    });

    test('cosine：長度不合或空陣列回 null，不丟例外', () => {
        assert.equal(agent.cosine([1, 0], [1, 0]), 1);
        assert.equal(agent.cosine([1, 0], [0, 1]), 0);
        assert.equal(agent.cosine([], []), null);
        assert.equal(agent.cosine([1, 0], [1]), null);
        assert.equal(agent.cosine(null, [1]), null);
    });
});

// ───────────────────────── 節點主體 ─────────────────────────

describe('pass 路徑', () => {
    test('outcome.data 與 payload.extract 同形，再加 variant_of_root／anchor_ids', async () => {
        const { ctx } = fakeCtx();
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'pass');

        // 第 3.2 條 payload.extract 的鍵 + 第 4.2 條的兩個新鍵
        assert.deepEqual(Object.keys(outcome.data).sort(), [
            'anchor_ids', 'answer_text', 'chapter', 'chapter_confidence', 'chunk_no',
            'difficulty', 'idx', 'page_range', 'question_text', 'question_type', 'subject', 'variant_of_root'
        ]);
        assert.equal(outcome.data.subject, '數學');
        assert.equal(outcome.data.variant_of_root, 12);
        assert.deepEqual(outcome.data.anchor_ids, [87, 91]);
        assert.equal(outcome.data.chunk_no, 0, '變式沒有 chunk（裁決 S3-10）');
        assert.equal(outcome.data.page_range, null, '變式沒有頁碼，但鍵要在');
        assert.equal(outcome.data.idx, 1);
    });

    test('章節繼承藍本時 chapter_confidence 固定 0.9', async () => {
        const { ctx } = fakeCtx();
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.data.chapter, '向量內積');
        assert.equal(outcome.data.chapter_confidence, 0.9);
    });

    test('模型換了合法的章節 → 採用它，信心用模型給的值', async () => {
        const { ctx } = fakeCtx({ data: { ...GOOD, chapter: '空間向量內積', chapter_confidence: 0.72 } });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.chapter, '空間向量內積');
        assert.equal(outcome.data.chapter_confidence, 0.72);
        assert.equal(outcome.data.chapter_overridden, undefined);
    });

    test('模型換到跨科章節（enum 是兩科合併的 66 個）→ 退回藍本章節並記 chapter_overridden', async () => {
        const { ctx } = fakeCtx({ data: { ...GOOD, chapter: '牛頓運動定律', chapter_confidence: 0.99 } });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.chapter, '向量內積');
        assert.equal(outcome.data.chapter_overridden, true);
        assert.equal(outcome.data.chapter_confidence, 0.9);
    });

    test('outcome.gate 帶著 text_gate 與 sim 交棒給 runner 寫 payload.variant', async () => {
        const { ctx } = fakeCtx({ sim: 0.91 });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.gate.text_gate.ok, true);
        assert.ok(Math.abs(outcome.gate.sim - 0.91) < 1e-9);
    });

    test('figure_desc 有內容才出現這個鍵', async () => {
        const withFig = await agent.run(fakeCtx({ data: { ...GOOD, figure_desc: '  兩向量的示意圖  ' } }).ctx, INPUT);
        assert.equal(withFig.data.figure_desc, '兩向量的示意圖');
        const blank = await agent.run(fakeCtx({ data: { ...GOOD, figure_desc: '   ' } }).ctx, INPUT);
        assert.ok(!('figure_desc' in blank.data));
    });
});

describe('cassette 與模型路由', () => {
    test('cacheKeyParts 的鍵照第 4.2 條，且不含題幹全文', async () => {
        const f = fakeCtx();
        await agent.run(f.ctx, { ...INPUT, difficulty_delta: -1, idx: 2 });
        const opts = f.calls.generateJson[0];
        assert.equal(opts.agent, 'variant');
        assert.equal(opts.template, 'variant.v1');
        assert.deepEqual(Object.keys(opts.cacheKeyParts), ['template', 'sourceQuestionId', 'difficultyDelta', 'idx', 'anchorIds']);
        assert.deepEqual(opts.cacheKeyParts, {
            template: 'variant.v1', sourceQuestionId: 12, difficultyDelta: -1, idx: 2, anchorIds: [87, 91]
        });
        const asText = JSON.stringify(opts.cacheKeyParts);
        assert.ok(!asText.includes('夾角'), 'cacheKeyParts 不得含題幹全文');
    });

    test('feedback 不進 cassette 鍵（重試回放同一捲帶是確定性的）', async () => {
        const a = fakeCtx(); await agent.run(a.ctx, INPUT);
        const b = fakeCtx(); await agent.run(b.ctx, { ...INPUT, feedback: '上次太像藍本' });
        assert.deepEqual(a.calls.generateJson[0].cacheKeyParts, b.calls.generateJson[0].cacheKeyParts);
        assert.ok(b.calls.generateJson[0].parts[0].text.includes('上次太像藍本'), 'feedback 要進 prompt');
    });

    test('模型用 MODEL_VARIANT；沒設時退回 MODEL_VERIFY（第 4.2 條）', async () => {
        const withVariant = fakeCtx({ models: { variant: 'gemini:gemini-3.7-flash' } });
        await agent.run(withVariant.ctx, INPUT);
        assert.equal(withVariant.calls.generateJson[0].model, 'gemini:gemini-3.7-flash');

        const fallback = fakeCtx();
        await agent.run(fallback.ctx, INPUT);
        assert.equal(fallback.calls.generateJson[0].model, 'gemini:gemini-3.1-pro-preview');
    });

    test('schema 就是 buildSchema(\'variant\')，signal 有往下傳', async () => {
        const f = fakeCtx();
        f.ctx.signal = new AbortController().signal;
        await agent.run(f.ctx, INPUT);
        assert.equal(f.calls.generateJson[0].schema, buildSchema('variant'));
        assert.equal(f.calls.generateJson[0].signal, f.ctx.signal);
    });

    test('跑題檢查用 RETRIEVAL_DOCUMENT，一次送兩段文本（第 4.4 條）', async () => {
        const f = fakeCtx();
        await agent.run(f.ctx, INPUT);
        assert.equal(f.calls.embed.length, 1);
        assert.equal(f.calls.embed[0].taskType, 'RETRIEVAL_DOCUMENT');
        assert.equal(f.calls.embed[0].texts.length, 2);
    });
});

describe('兩道閘門', () => {
    test('只改字：與藍本完全相同 → fail(text_gate)，而且不會白花一次 embed', async () => {
        const f = fakeCtx({ data: { ...GOOD, question_text: SOURCE.question_text } });
        const outcome = await agent.run(f.ctx, INPUT);
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'text_gate');
        assert.ok(outcome.feedback.includes('identical'));
        assert.equal(f.calls.embed.length, 0, '文字閘門沒過就不該再花錢算向量');
    });

    test('只改字：數字對調（多重集合相同）→ fail(text_gate)', async () => {
        const f = fakeCtx({
            data: { ...GOOD, question_text: '設 $\\vec{a}=(4,3)$、$\\vec{b}=(2,1)$，求兩向量的夾角餘弦值。' }
        });
        const outcome = await agent.run(f.ctx, INPUT);
        assert.equal(outcome.reason, 'text_gate');
        assert.equal(outcome.data.text_gate.reason, 'numbers_only');
    });

    test('已知缺口：只換數字但位數變了、題幹又短 → 文字閘門放行（見 docs/questions3-wsB.md 第 1 條）', async () => {
        // 第 4.3 條的規則 2 要求「數字多重集合相同」，換成別的數字就不成立；
        // 規則 3 只看編輯距離比例，短題幹改四個數字就有 10% > VARIANT_MIN_EDIT=0.08。
        // 這一題會往下走到跑題檢查與 dedup（L0 雜湊擋不住、L1 餘弦會極高 → duplicate），
        // 所以不是「沒有防線」，但文字閘門本身確實漏了它。行為以凍結介面為準，缺口寫進 questions3。
        const f = fakeCtx({
            data: { ...GOOD, question_text: '設 $\\vec{a}=(6,8)$、$\\vec{b}=(2,4)$，求兩向量的夾角餘弦值。' }
        });
        const outcome = await agent.run(f.ctx, INPUT);
        assert.equal(outcome.kind, 'pass');
        assert.ok(outcome.gate.text_gate.edit_ratio >= 0.08);
    });

    test('跑題：餘弦低於門檻 → fail(off_topic)，feedback 含實際數值', async () => {
        const { ctx } = fakeCtx({ sim: 0.42 });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'off_topic');
        assert.ok(outcome.feedback.includes('0.4200'), `feedback 要帶實際餘弦：${outcome.feedback}`);
        assert.ok(Math.abs(outcome.data.sim - 0.42) < 1e-9);
    });

    test('門檻由 ctx.config.thresholds 決定（agent 不讀 process.env）', async () => {
        const strict = await agent.run(fakeCtx({ sim: 0.85, thresholds: { variantSimMin: 0.9 } }).ctx, INPUT);
        assert.equal(strict.reason, 'off_topic');
        const loose = await agent.run(fakeCtx({ sim: 0.85, thresholds: { variantSimMin: 0.5 } }).ctx, INPUT);
        assert.equal(loose.kind, 'pass');
    });
});

describe('防呆與錯誤處理', () => {
    test('模型輸出不合 schema → fail(schema_invalid)', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '向量內積', question_type: '計算' } });   // 缺必填欄位
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'schema_invalid');
        assert.ok(outcome.feedback.includes('缺少必填欄位'));
    });

    test('難度不在 1~5 也被 ajv 擋下', async () => {
        const { ctx } = fakeCtx({ data: { ...GOOD, difficulty: 9 } });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.reason, 'schema_invalid');
    });

    test('藍本學科不合法 → fail(schema_invalid)，一次 LLM 都不呼叫', async () => {
        const f = fakeCtx();
        const outcome = await agent.run(f.ctx, { ...INPUT, source: { ...SOURCE, subject: '化學' } });
        assert.equal(outcome.reason, 'schema_invalid');
        assert.equal(f.calls.generateJson.length, 0);
    });

    test('藍本題幹是空的 → fail(schema_invalid)', async () => {
        const f = fakeCtx();
        const outcome = await agent.run(f.ctx, { ...INPUT, source: { ...SOURCE, question_text: '   ' } });
        assert.equal(outcome.reason, 'schema_invalid');
        assert.equal(f.calls.generateJson.length, 0);
    });

    test('llm 丟錯 → {kind:error}，agent 自己不 throw（第 3.1 條）', async () => {
        const { ctx } = fakeCtx();
        ctx.llm.generateJson = async () => { const e = new Error('429 rate limit'); e.errorClass = 'rate_limited'; throw e; };
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'rate_limited');
    });

    test('embed 丟錯也不 throw', async () => {
        const { ctx } = fakeCtx({ embedThrows: true });
        const outcome = await agent.run(ctx, INPUT);
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'provider_error');
    });
});
