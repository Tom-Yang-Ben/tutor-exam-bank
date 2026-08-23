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
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'verify.v1';
const MAX_OUTPUT_TOKENS = 2048;
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

function renderPrompt({ questionText, questionType }) {
    return PROMPT_TEMPLATE
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
async function sample(ctx, { questionText, questionType, sampleNo }) {
    const res = await ctx.llm.generateJson({
        model: ctx.config.models.verify,
        system: SYSTEM,
        parts: [{ text: renderPrompt({ questionText, questionType }) }],
        schema: buildSchema('verify'),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal: ctx.signal,
        agent: 'verify',
        template: TEMPLATE,
        cacheKeyParts: {
            template: TEMPLATE,
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

    for (let n = 1; n <= MAX_SAMPLES; n++) {
        try {
            out = await sample(ctx, { questionText, questionType, sampleNo: n });
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

module.exports = { run, PROMPT_TEMPLATE, TEMPLATE, MAX_SAMPLES };
