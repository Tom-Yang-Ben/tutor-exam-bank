// 化學路徑的 agent 單元測試（階段 5 WS-B；docs/interfaces-stage5.md 第 1.1、1.2、4.2 條、ADR-010）
//
// 每個 agent 各測兩件事：
//   1. 化學題／化學卷走新的 agent 名、新的模板、化學值域的 schema（subject 只能是化學、chapter 是化學 44 章）；
//   2. 數學／物理題送出去的請求與階段 5 之前**逐欄相同**（agent 名、模板、SYSTEM、schema 實例）。
// 另外斷言化學模板的註冊字串 = SYSTEM + '\n---\n' + TEMPLATE（第 1.2 條）。
// ctx.llm 全部注入假物件：不連 Gemini、不讀 cassette。執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

const extract = require('../../agents/extract');
const classify = require('../../agents/classify');
const lint = require('../../agents/lint');
const verify = require('../../agents/verify');
const generateVariant = require('../../agents/generateVariant');
const sourceCheck = require('../../agents/source_check');
const { buildSchema } = require('../../agents/schemas');
const { getTemplate, templateHash, sha256Hex } = require('../../services/llm/templates');
const { CHAPTERS, LEGACY_CHAPTERS } = require('../../config/chapters');

const USAGE = { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 };

/** 通用假 ctx：generateJson 依呼叫順序回 responses[i]（不夠就重複最後一個） */
function fakeCtx({ responses = [{}], job = {}, jq = null, embedSim = 0.95 } = {}) {
    const calls = [];
    const a = new Array(8).fill(0); a[0] = 1;
    const b = new Array(8).fill(0); b[0] = embedSim; b[1] = Math.sqrt(1 - embedSim * embedSim);
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    const data = responses[Math.min(calls.length - 1, responses.length - 1)];
                    return { data, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
                },
                embed: async () => ({ vectors: [a, b], usage: { tokenIn: 1 } })
            },
            db: null,
            job: { id: 1, kind: 'pdf', budget_usd: 1, cost_usd: 0, ...job },
            jq,
            logger: { info() {}, warn() {}, error() {} },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash', verify: 'gemini:gemini-3.1-pro-preview' },
                thresholds: { pdfChunkPages: 20, inlineMaxBytes: 15728640, classifyMinConf: 0.8, variantOfftopicSimMin: 0.9, variantMinEdit: 0.08 },
                features: {},
                sourceCheck: { mode: 'enforce' }
            },
            signal: undefined
        }
    };
}

async function makePdf(pages = 1) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
    return Buffer.from(await doc.save());
}

const CHEM_Q = {
    subject: '化學',
    chapter: '化學平衡與平衡常數',
    chapter_confidence: 0.93,
    question_type: '計算',
    difficulty: 3,
    question_text: '定溫下 $\\ce{N2 + 3H2 <=> 2NH3}$ 達平衡，已知各物質濃度，求平衡常數 $K_c$。',
    answer_text: '$K_c = 0.50$'
};

// ───────────────────────── 模板註冊（第 1.2 條）─────────────────────────

describe('化學模板的註冊字串 = SYSTEM + "\\n---\\n" + TEMPLATE', () => {
    const agents = [
        ['extract', extract], ['classify', classify], ['lint', lint], ['verify', verify], ['variant', generateVariant]
    ];
    for (const [name, mod] of agents) {
        test(`${name}：${mod.TEMPLATE_CHEM}`, () => {
            assert.equal(getTemplate(mod.TEMPLATE_CHEM), `${mod.SYSTEM_CHEM}\n---\n${mod.PROMPT_TEMPLATE_CHEM}`);
            assert.equal(templateHash(mod.TEMPLATE_CHEM), sha256Hex(`${mod.SYSTEM_CHEM}\n---\n${mod.PROMPT_TEMPLATE_CHEM}`));
            assert.notEqual(mod.AGENT_CHEM, name, 'agent 名必須是新的（也是 cassette 子目錄名）');
            assert.match(mod.AGENT_CHEM, /_chem$/);
        });
    }

    test('既有模板的註冊內容不變（仍是模板原文本身，不含 SYSTEM——已知缺口，本階段不修）', () => {
        assert.equal(getTemplate(extract.TEMPLATE), extract.PROMPT_TEMPLATE);
        assert.equal(getTemplate(classify.TEMPLATE), classify.PROMPT_TEMPLATE);
        assert.equal(getTemplate(lint.TEMPLATE), lint.PROMPT_TEMPLATE);
        assert.equal(getTemplate(verify.TEMPLATE), verify.PROMPT_TEMPLATE);
        assert.equal(getTemplate(generateVariant.TEMPLATE), generateVariant.PROMPT_TEMPLATE);
    });
});

// ───────────────────────── extract ─────────────────────────

describe('extract：化學卷（ctx.job.subject_group = chemistry）', () => {
    test('走 extract_chem：化學模板、化學 SYSTEM、化學值域的 schema', async () => {
        const { ctx, calls } = fakeCtx({ responses: [{ questions: [CHEM_Q] }], job: { subject_group: 'chemistry' } });
        const outcome = await extract.run(ctx, { pdfBytes: await makePdf(), chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.questions[0].subject, '化學');
        assert.equal(calls[0].agent, 'extract_chem');
        assert.equal(calls[0].template, 'extract_chem.v1');
        assert.equal(calls[0].system, extract.SYSTEM_CHEM);
        assert.equal(calls[0].schema, buildSchema('extract', { group: 'chemistry' }));
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'chunkNo', 'pdfSha256']);
        assert.equal(calls[0].cacheKeyParts.template, 'extract_chem.v1');
    });

    test('化學卷的 prompt 列化學 44 章、不列任何數學／物理章節，並帶化學式規範', () => {
        const prompt = extract.buildPrompt('chemistry');
        for (const c of CHAPTERS['化學']) assert.ok(prompt.includes(`「${c}」`), `少了「${c}」`);
        for (const c of LEGACY_CHAPTERS) assert.ok(!prompt.includes(c), `不該出現數學／物理章節「${c}」`);
        assert.ok(prompt.includes('\\ce{'));
    });

    test('數學／物理卷的 prompt 不含任何化學章節', () => {
        const prompt = extract.buildPrompt();
        for (const c of CHAPTERS['化學']) assert.ok(!prompt.includes(c), `數學／物理卷不該出現「${c}」`);
    });

    test('化學卷拆出數學題（subject 不是化學）→ 該題被 ajv 退件', async () => {
        const math = { ...CHEM_Q, subject: '數學', chapter: '向量內積' };
        const { ctx } = fakeCtx({ responses: [{ questions: [CHEM_Q, math] }], job: { subject_group: 'chemistry' } });
        const outcome = await extract.run(ctx, { pdfBytes: await makePdf(), chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.data.questions.length, 1);
        assert.equal(outcome.data.rejected.length, 1);
    });

    test('沒有卷別（舊呼叫端、services/aiService.js）與 math_physics：請求與階段 5 之前相同', async () => {
        for (const job of [{}, { subject_group: 'math_physics' }]) {
            const { ctx, calls } = fakeCtx({ responses: [{ questions: [] }], job });
            await extract.run(ctx, { pdfBytes: await makePdf(), chunk: { no: 1, fromPage: 1, toPage: 1 } });
            assert.equal(calls[0].agent, 'extract');
            assert.equal(calls[0].template, 'extract.v2');
            assert.equal(calls[0].system, extract.SYSTEM);
            assert.equal(calls[0].schema, buildSchema('extract'));
            assert.equal(calls[0].parts[1].text, extract.buildPrompt());
        }
    });
});

// ───────────────────────── classify ─────────────────────────

describe('classify：化學題', () => {
    test('零成本閘門：化學章節＋高信心 → 直接 pass，不呼叫 LLM', async () => {
        const { ctx, calls } = fakeCtx();
        const outcome = await classify.run(ctx, { subject: '化學', chapter: '勒沙特列原理', chapter_confidence: 0.95, question_text: CHEM_Q.question_text });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
        assert.equal(calls.length, 0);
    });

    test('第二層：走 classify_chem，few-shot 用化學例句、schema 是化學值域', async () => {
        const { ctx, calls } = fakeCtx({ responses: [{ chapter: '化學平衡與平衡常數', confidence: 0.9, rationale: '求平衡常數' }] });
        const outcome = await classify.run(ctx, { subject: '化學', chapter: '亂寫', chapter_confidence: 0.3, question_text: CHEM_Q.question_text });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.chapter, '化學平衡與平衡常數');
        assert.equal(calls[0].agent, 'classify_chem');
        assert.equal(calls[0].template, 'classify_chem.v1');
        assert.equal(calls[0].system, classify.SYSTEM_CHEM);
        assert.equal(calls[0].schema, buildSchema('classify', { group: 'chemistry' }));
        assert.deepEqual(calls[0].schema.properties.chapter.enum, CHAPTERS['化學']);
        const prompt = calls[0].parts[0].text;
        assert.ok(prompt.includes('章節：勒沙特列原理'), '化學例句（config/chapterExamples.js）要進 few-shot');
        assert.ok(!prompt.includes('章節：向量內積'), '數學例句不該出現在化學題的 prompt');
    });

    test('模型回數學章節 → fail(chapter_invalid)，feedback 列最接近的化學章節', async () => {
        const { ctx } = fakeCtx({ responses: [{ chapter: '向量內積', confidence: 0.9, rationale: 'x' }] });
        const outcome = await classify.run(ctx, { subject: '化學', question_text: CHEM_Q.question_text });
        assert.equal(outcome.reason, 'chapter_invalid');
        assert.match(outcome.feedback, /不在白名單內，最接近的是「[^」]+」「[^」]+」/);
    });

    test('學科訊息列出三科（化學現在合法）', async () => {
        const { ctx } = fakeCtx();
        const outcome = await classify.run(ctx, { subject: '生物', question_text: 'x' });
        assert.match(outcome.feedback, /只接受「數學」「物理」「化學」/);
    });

    test('數學題即使在化學卷裡也走數學路徑（科目比卷別精準）', async () => {
        const { ctx, calls } = fakeCtx({ responses: [{ chapter: '向量內積', confidence: 0.9, rationale: 'x' }], job: { subject_group: 'chemistry' } });
        await classify.run(ctx, { subject: '數學', question_text: '求向量夾角' });
        assert.equal(calls[0].agent, 'classify');
        assert.equal(calls[0].template, 'classify.v1');
        assert.equal(calls[0].system, classify.SYSTEM);
        assert.equal(calls[0].schema, buildSchema('classify'));
    });
});

// ───────────────────────── lint ─────────────────────────

describe('lint：化學題', () => {
    test('\\ce{…} 與化學箭頭過得了零成本閘門，不呼叫 LLM', async () => {
        const { ctx, calls } = fakeCtx({ jq: { payload: { extract: { subject: '化學' } } } });
        const outcome = await lint.run(ctx, { question_text: CHEM_Q.question_text, answer_text: '$\\ce{CaCO3 ->[\\Delta] CaO + CO2 ^}$' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.rewritten, false);
        assert.equal(calls.length, 0);
    });

    test('閘門擋下時走 lint_chem（化學 SYSTEM／模板）', async () => {
        const { ctx, calls } = fakeCtx({
            responses: [{ question_text: '$\\ce{H2O}$ 的莫耳質量', answer_text: '$18$', notes: '補右括號' }],
            jq: { payload: { extract: { subject: '化學' } } }
        });
        const outcome = await lint.run(ctx, { question_text: '$\\ce{H2O$ 的莫耳質量', answer_text: '$18$' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(calls[0].agent, 'lint_chem');
        assert.equal(calls[0].template, 'lint_chem.v1');
        assert.equal(calls[0].system, lint.SYSTEM_CHEM);
        assert.ok(calls[0].parts[0].text.includes('\\ce{'));
    });

    test('數學題照舊走 lint（agent、模板、SYSTEM、schema 同一個實例）', async () => {
        const { ctx, calls } = fakeCtx({
            responses: [{ question_text: '$\\frac{1}{2}$', answer_text: '', notes: 'x' }],
            jq: { payload: { extract: { subject: '數學' } } }
        });
        await lint.run(ctx, { question_text: '$\\frac{1}{2$', answer_text: '' });
        assert.equal(calls[0].agent, 'lint');
        assert.equal(calls[0].template, 'lint.v2');
        assert.equal(calls[0].system, lint.SYSTEM);
        assert.equal(calls[0].schema, buildSchema('lint'));
    });
});

// ───────────────────────── verify ─────────────────────────

describe('verify：化學題', () => {
    test('走 verify_chem；化學式答案用化學式比對（相同 → pass）', async () => {
        const { ctx, calls } = fakeCtx({
            responses: [{ final_answer: '$\\ce{CO2}$', answer_form: 'expression', steps_summary: '碳完全燃燒' }],
            jq: { payload: { extract: { subject: '化學' } } }
        });
        const outcome = await verify.run(ctx, { question_text: '碳完全燃燒的產物？', question_type: '填空', claimed_answer: '$\\mathrm{CO_2}$' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.compare, 'agree');
        assert.equal(calls[0].agent, 'verify_chem');
        assert.equal(calls[0].template, 'verify_chem.v1');
        assert.equal(calls[0].system, verify.SYSTEM_CHEM);
        assert.ok(!calls[0].parts[0].text.includes('CO_2'), 'claimed_answer 不得進 prompt');
    });

    test('化學式不同 → disagree → fail(answer_mismatch)，只採樣一次', async () => {
        const { ctx, calls } = fakeCtx({
            responses: [{ final_answer: '$\\ce{CO}$', answer_form: 'expression', steps_summary: 'x' }],
            jq: { payload: { extract: { subject: '化學' } } }
        });
        const outcome = await verify.run(ctx, { question_text: 'q', question_type: '填空', claimed_answer: '$\\ce{CO2}$' });
        assert.equal(outcome.reason, 'answer_mismatch');
        assert.equal(outcome.data.compare, 'disagree');
        assert.equal(calls.length, 1);
    });

    test('單位不一致 → disagree（0.10 mol 對 0.10 M）', async () => {
        const { ctx } = fakeCtx({
            responses: [{ final_answer: '0.10 mol', answer_form: 'number', steps_summary: 'x' }],
            jq: { payload: { extract: { subject: '化學' } } }
        });
        const outcome = await verify.run(ctx, { question_text: 'q', question_type: '計算', claimed_answer: '$C = 0.10$ M' });
        assert.equal(outcome.data.compare, 'disagree');
    });

    test('數學題照舊走 verify', async () => {
        const { ctx, calls } = fakeCtx({
            responses: [{ final_answer: '3', answer_form: 'number', steps_summary: 'x' }],
            jq: { payload: { extract: { subject: '數學' } } }
        });
        await verify.run(ctx, { question_text: 'q', question_type: '計算', claimed_answer: '$3$' });
        assert.equal(calls[0].agent, 'verify');
        assert.equal(calls[0].template, 'verify.v1');
        assert.equal(calls[0].schema, buildSchema('verify'));
    });
});

// ───────────────────────── generateVariant ─────────────────────────

describe('generateVariant：化學藍本', () => {
    const SOURCE = { id: 77, ...CHEM_Q, variant_of: null };
    const GOOD = {
        chapter: '化學平衡與平衡常數', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
        question_text: '在密閉容器中 $\\ce{H2 + I2 <=> 2HI}$ 於某溫度達平衡，測得三者濃度分別為已知值，試求該溫度下的平衡常數。',
        answer_text: '$K_c = 49$'
    };

    test('走 variant_chem：化學模板、化學值域的 schema', async () => {
        const { ctx, calls } = fakeCtx({ responses: [GOOD], job: { kind: 'variant' } });
        const outcome = await generateVariant.run(ctx, { source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 1 });
        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome));
        assert.equal(outcome.data.subject, '化學');
        assert.equal(calls[0].agent, 'variant_chem');
        assert.equal(calls[0].template, 'variant_chem.v1');
        assert.equal(calls[0].schema, buildSchema('variant', { group: 'chemistry' }));
        assert.equal(calls[0].cacheKeyParts.template, 'variant_chem.v1');
        assert.ok(calls[0].parts[0].text.includes('「勒沙特列原理」'));
    });

    test('模型回數學章節 → schema_invalid（化學 schema 的 enum 擋下）', async () => {
        const { ctx } = fakeCtx({ responses: [{ ...GOOD, chapter: '向量內積' }], job: { kind: 'variant' } });
        const outcome = await generateVariant.run(ctx, { source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 1 });
        assert.equal(outcome.reason, 'schema_invalid');
    });

    test('數學藍本的 prompt 與階段 5 之前相同（不含化學章節與化學式規範）', () => {
        const math = { ...SOURCE, subject: '數學', chapter: '向量內積', question_text: '設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。', answer_text: '$\\sqrt{5}$' };
        const prompt = generateVariant.buildPrompt({ source: math, neighbors: [], difficulty_delta: 0 });
        assert.ok(prompt.startsWith('請以下面這道「藍本題」為範本，改寫出**一道**同概念的新題目。'));
        assert.ok(!prompt.includes('\\ce{'));
    });
});

// ───────────────────────── source_check ─────────────────────────

describe('source_check：化學題的反應箭頭不算負號', () => {
    const segment = '1. 在定溫下，將一氧化碳與氧氣混合點燃，發生反應 2CO + O2 → 2CO2，並測量反應前後氣體的總體積變化量，試問反應後容器內的氣體總體積減少多少毫升？';
    const questionText = '在定溫下，將一氧化碳與氧氣混合點燃，發生反應 $\\ce{2CO + O2 -> 2CO2}$，並測量反應前後氣體的總體積變化量，試問反應後容器內的氣體總體積減少多少毫升？';
    const input = { question_text: questionText, source_text: { status: 'located', segment, locate_score: 1 }, has_figure: false };

    test('化學題：先把 \\ce 換成可比對文字，不會因為 -> 的「-」誤判抄錯', async () => {
        const { ctx } = fakeCtx({ jq: { payload: { extract: { subject: '化學' } } } });
        const outcome = await sourceCheck.run(ctx, input);
        assert.notEqual(outcome.reason, 'transcription_mismatch', JSON.stringify(outcome));
    });

    test('chemistryComparable 只換 \\ce{…}，其餘文字不動', () => {
        assert.equal(sourceCheck.chemistryComparable('反應 $\\ce{A -> B}$ 完成'), '反應 $ A B $ 完成');
    });
});
