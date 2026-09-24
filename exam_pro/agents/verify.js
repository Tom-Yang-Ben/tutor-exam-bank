// agents/verify.js — 解題驗證節點（A-T10b / WS-C）
//
// 合約：docs/interfaces-stage2.md 第 3.1／3.3 條
//   input  = { question_text, question_type, claimed_answer }
//            ⚠️ claimed_answer **只放在 input，不得進 prompt**——
//               把拆題模型的答案餵給驗證模型，驗證就退化成「請你同意我」。
//   閘門   = question_type === '證明' → skipped；
//            answerCompare 回 agree → pass；uncertain → 再採樣一次，仍 uncertain → fail；
//            disagree → fail('answer_mismatch')，payload 存兩個答案
//   模型   = MODEL_VERIFY（與 MODEL_EXTRACT 不同支，config/models.js 啟動時會檢查）
//
// 為什麼用確定性比對器而不是叫模型自評：「不一致率」要能變成 report:jobs 裡的一個數字，
// 才有辦法回答「該不該多付一家模型的錢」（規劃 §3.8）。

const { answerCompare } = require('../utils/answerCompare');
const { buildSchema } = require('./schemas');
const { resolveSubjectGroup } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'verify.v1';
// 兩個數字是一組的，不要單獨調（2026-08-27 job #4 的教訓）：
// MODEL_VERIFY 是 thinking 模型，思考 token 計入 maxOutputTokens 的額度。
// 舊值 2048 且不限思考時，難題的思考會把額度吃光，JSON 寫到一半被截斷
// （「Unterminated string in JSON」→ 誤歸 schema_invalid，退避重試又拖慢整份任務）。
const MAX_OUTPUT_TOKENS = 8192;
const THINKING_BUDGET = 1024;
const MAX_SAMPLES = 2;          // uncertain 時再採樣一次，就這樣（介面第 3.3 條）

const SYSTEM = [
    '你是高中數學與物理的解題老師。',
    '請自己把題目解出來，只根據題目本身作答，不要臆測出題者想要的答案。',
    '選擇題只在 final_answer 填代號（例如 (A)）；數值題只填數值與單位；',
    '需要式子的填算式；文字題填文字。steps_summary 用繁體中文，400 字以內。',
].join('\n');

/**
 * prompt 模板（把可變欄位挖空後的原文）。
 * 裡面**沒有** claimed_answer 的位置——這是刻意的，改動前請先看檔頭。
 * cassette 的鍵要用 sha256(模板原文)（介面第 5.2 條），模組載入時註冊進
 * services/llm/templates.js（裁決 S2-5），generateJson 只傳識別名。
 */
const PROMPT_TEMPLATE = [
    '請解下面這一題。',
    '',
    '【題型】{{question_type}}',
    '',
    '【題目】',
    '{{question_text}}',
].join('\n');

// 模組載入時註冊（裁決 S2-5）：四個 LLM 節點都必須註冊
registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

// ───────────────────── 化學題（〔stage5 WS-B〕DEC-019、ADR-010）─────────────────────
//
// 化學題換成化學老師的 SYSTEM 與模板（agent 名 verify_chem、模板 verify_chem.v1）：
// 最大的差別是 final_answer 的寫法——化學式與反應式要用 \ce{…}，數值要帶單位，
// utils/answerCompare.js 才比得出「化學式相同／不同」與「單位一致／不一致」（第 4.2 條第 4 點）。
// 同樣**看不到 claimed_answer**（上面檔頭的理由不變）。數學／物理的 SYSTEM 與模板一個字都沒動。

const AGENT_CHEM = 'verify_chem';
const TEMPLATE_CHEM = 'verify_chem.v1';

const SYSTEM_CHEM = [
    '你是高中化學的解題老師。',
    '請自己把題目解出來，只根據題目本身作答，不要臆測出題者想要的答案；題目沒給的原子量用常用的整數或一位小數值。',
    '選擇題只在 final_answer 填代號（例如 (A)）；數值題填數值與單位（例如 0.25 M、22.4 L）；',
    '答案是化學式、離子或反應式時用 mhchem 寫成 $\\ce{…}$（例如 $\\ce{H2SO4}$、$\\ce{SO4^{2-}}$），answer_form 填 expression；',
    '文字題填文字。steps_summary 用繁體中文，400 字以內。',
].join('\n');

const PROMPT_TEMPLATE_CHEM = [
    '請解下面這一道化學題。',
    '',
    '【題型】{{question_type}}',
    '',
    '【題目】',
    '{{question_text}}',
].join('\n');

registerTemplate(TEMPLATE_CHEM, `${SYSTEM_CHEM}\n---\n${PROMPT_TEMPLATE_CHEM}`);

/** 卷別 → agent 名、模板、SYSTEM、模板原文與 schema 選項 */
const VARIANTS = {
    math_physics: { agent: 'verify', template: TEMPLATE, system: SYSTEM, promptTemplate: PROMPT_TEMPLATE, schemaOpts: undefined, subject: null },
    chemistry: { agent: AGENT_CHEM, template: TEMPLATE_CHEM, system: SYSTEM_CHEM, promptTemplate: PROMPT_TEMPLATE_CHEM, schemaOpts: { group: 'chemistry' }, subject: '化學' }
};

function renderPrompt({ questionText, questionType }, promptTemplate = PROMPT_TEMPLATE) {
    return promptTemplate
        .replace('{{question_type}}', questionType || '未標註')
        .replace('{{question_text}}', questionText || '（空）');
}

/** 供應商例外 → errorClass（介面第 2 條的九個值） */
function classifyError(err) {
    const msg = String((err && err.message) || err || '');
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return 'timeout';
    if (/abort|timeout|逾時/i.test(msg)) return 'timeout';
    if (/429|rate.?limit|quota|resource_exhausted/i.test(msg)) return 'rate_limited';
    if (/schema|ajv|json/i.test(msg)) return 'schema_invalid';
    return 'provider_error';
}

/** 一次採樣：呼叫模型並取出三個欄位 */
async function sample(ctx, { questionText, questionType, sampleNo }, v = VARIANTS.math_physics) {
    const res = await ctx.llm.generateJson({
        model: ctx.config.models.verify,
        system: v.system,
        parts: [{ text: renderPrompt({ questionText, questionType }, v.promptTemplate) }],
        schema: buildSchema('verify', v.schemaOpts),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingBudget: THINKING_BUDGET,
        signal: ctx.signal,
        agent: v.agent,
        template: v.template,
        cacheKeyParts: {
            template: v.template,
            questionText,
            questionType,
            sampleNo,          // 讓 uncertain 的第二次採樣有自己的 cassette
        },
    });
    const data = (res && res.data) || {};
    return {
        final_answer: typeof data.final_answer === 'string' ? data.final_answer : '',
        answer_form: typeof data.answer_form === 'string' ? data.answer_form : '',
        steps_summary: typeof data.steps_summary === 'string' ? data.steps_summary : '',
    };
}

/**
 * @param {object} ctx
 * @param {{question_text:string, question_type:string, claimed_answer:string}} input
 * @returns {Promise<object>}  Outcome
 */
async function run(ctx, input) {
    const inp = input || {};
    const questionText = typeof inp.question_text === 'string' ? inp.question_text : '';
    const questionType = inp.question_type;
    const claimed = typeof inp.claimed_answer === 'string' ? inp.claimed_answer : '';

    // 證明題沒有可比對的「最終答案」，硬要比只會製造雜訊
    if (questionType === '證明') {
        return { kind: 'skipped', data: { skipped: true } };
    }

    let out = null;
    let compare = 'uncertain';
    let samples = 0;
    // 〔stage5 WS-B〕化學題換化學的 SYSTEM／模板；數學與物理的 v 與階段 5 之前寫死的值相同
    const v = VARIANTS[resolveSubjectGroup(ctx, inp)];

    for (let n = 1; n <= MAX_SAMPLES; n++) {
        try {
            out = await sample(ctx, { questionText, questionType, sampleNo: n }, v);
        } catch (err) {
            const errorClass = classifyError(err);
            if (ctx.logger && ctx.logger.warn) {
                ctx.logger.warn({ node: 'verify', sampleNo: n, errorClass, message: String((err && err.message) || err) });
            }
            return { kind: 'error', errorClass, message: String((err && err.message) || err) };
        }
        samples = n;

        compare = answerCompare({
            question_type: questionType,
            claimed,
            model: { final_answer: out.final_answer, answer_form: out.answer_form },
            // 〔stage5 WS-B〕化學題才帶 subject：比對器據此嘗試化學式比對（數學／物理不帶，行為不變）
            ...(v.subject ? { subject: v.subject } : {}),
        });

        // agree／disagree 都是「比出來了」，不必再採樣；只有 uncertain 值得再花一次錢
        if (compare !== 'uncertain') break;
    }

    const data = {
        skipped: false,
        final_answer: out.final_answer,
        answer_form: out.answer_form,
        steps_summary: out.steps_summary,
        claimed_answer: claimed,     // 兩個答案都留在 payload，複核時老師要對照
        compare,
        samples,
    };

    if (compare === 'agree') return { kind: 'pass', data };

    const feedback = compare === 'disagree'
        ? `驗證模型算出「${out.final_answer}」，拆題模型抄的是「${claimed}」。`
        : `驗證模型算出「${out.final_answer}」（${out.answer_form}），與拆題模型抄的「${claimed}」比不出結果（採樣 ${samples} 次）。`;

    return { kind: 'fail', reason: 'answer_mismatch', feedback, data };
}

module.exports = {
    run, PROMPT_TEMPLATE, TEMPLATE, MAX_SAMPLES,
    // 〔stage5 WS-B〕化學題
    SYSTEM, AGENT_CHEM, TEMPLATE_CHEM, SYSTEM_CHEM, PROMPT_TEMPLATE_CHEM
};
