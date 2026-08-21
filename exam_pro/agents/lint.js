// agents/lint.js — 公式檢查節點（A-T10a / WS-C）
//
// 合約：docs/interfaces-stage2.md 第 3.1／3.3 條
//   run(ctx, input) → Promise<Outcome>，**不得 throw**
//   input  = { question_text, answer_text, feedback? }
//   閘門   = 沒有 sev:'error' 的 issue（warn 放行）
//   失敗   = fail('formula_unparsable')；重試上限 2（狀態機管，不是這裡管）
//
// 三層，一層比一層貴：
//   ① utils/formulaFix.js    確定性修復，零成本
//   ② utils/formulaLint.js   硬閘門，零成本
//   ③ 仍有 error 才呼叫 LLM 重寫（MODEL_EXTRACT），改完再跑一次 ①②
//
// 為什麼第三層放最後：階段 1 的題庫健檢顯示，絕大多數壞公式都是舊轉換器的殘留標記
// 與錯位的 $——這些用規則就能修好，沒有理由為它們付錢給模型。

const { formulaFix } = require('../utils/formulaFix');
const { formulaLint } = require('../utils/formulaLint');
const { buildSchema } = require('./schemas');
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'lint.v1';
const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM = [
    '你是數學與物理題庫的 LaTeX 校對員。',
    '你唯一的工作是把壞掉的公式寫法修好，讓它能被轉換成 Word 的數學方塊。',
    '嚴禁改動題意：數字、單位、選項內容、中文敘述一個字都不准改，只准改公式的寫法。',
    '嚴禁自己解題或補上答案。',
].join('\n');

/**
 * prompt 模板（把可變欄位挖空後的原文）。
 * cassette 的鍵要用 sha256(模板原文)（介面第 5.2 條），但 generateJson 只帶得到識別名，
 * 因此模組載入時就把原文註冊進 services/llm/templates.js（裁決 S2-5），
 * generateJson 只傳識別名，由 services/llm 依識別名回查原文算雜湊。
 * 模板文字改一個字，cassette 就會失效——這是刻意的。
 */
const PROMPT_TEMPLATE = [
    '以下題目的公式寫法有問題，請修好後照 JSON schema 回覆。',
    '',
    '【題幹】',
    '{{question_text}}',
    '',
    '【答案】',
    '{{answer_text}}',
    '',
    '【硬閘門偵測到的問題】（at 是字元位置，0 起算）',
    '{{issues}}',
    '{{feedback}}',
    '',
    '要求：',
    '1. 行內公式一律用 $…$ 包起來，展示公式用 $$…$$。',
    '2. 分數用 \\frac{分子}{分母}，根號用 \\sqrt{…}，上下標用 ^{…} 與 _{…}，大括號必須成對。',
    '3. 不要使用 \\begin{…}、\\mathbb、\\overrightarrow 這類指令，本系統的轉換器不支援。',
    '4. 中文敘述、數字、單位、選項內容保持原樣。',
].join('\n');

// 模組載入時註冊（裁決 S2-5）：四個 LLM 節點都必須註冊，否則 cassette 鍵會退回 sha256(識別名)
registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

/** 把 issues 排成 prompt 用的條列 */
function issuesToText(issues) {
    if (!issues.length) return '（無）';
    return issues.map(i => `- [${i.sev}] ${i.rule} @${i.at}：${i.msg}`).join('\n');
}

function renderPrompt({ questionText, answerText, issues, feedback }) {
    return PROMPT_TEMPLATE
        .replace('{{question_text}}', questionText || '（空）')
        .replace('{{answer_text}}', answerText || '（空）')
        .replace('{{issues}}', issuesToText(issues))
        .replace('{{feedback}}', feedback ? `\n【上一次重寫仍未通過的原因】\n${feedback}` : '');
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

/** 跑一輪 ①② —— 回傳修過的文字、套用的規則、剩下的 issues */
function gate(questionText, answerText) {
    const fq = formulaFix(questionText);
    const fa = formulaFix(answerText);
    const applied = [...new Set([...fq.applied, ...fa.applied])];

    // issues 的形狀凍結成四個鍵，沒有 field 欄位，因此把欄位寫進 msg 前綴
    const lq = formulaLint(fq.text);
    const la = formulaLint(fa.text);
    const issues = [
        ...lq.issues.map(i => ({ ...i, msg: `題目：${i.msg}` })),
        ...la.issues.map(i => ({ ...i, msg: `答案：${i.msg}` })),
    ];
    return { questionText: fq.text, answerText: fa.text, applied, issues, ok: lq.ok && la.ok };
}

const errorsOf = (issues) => issues.filter(i => i.sev === 'error');

/**
 * @param {object} ctx     介面第 3.1 條的 Ctx
 * @param {{question_text:string, answer_text:string, feedback?:string}} input
 * @returns {Promise<object>}  Outcome
 */
async function run(ctx, input) {
    const inp = input || {};
    const questionText = typeof inp.question_text === 'string' ? inp.question_text : '';
    const answerText = typeof inp.answer_text === 'string' ? inp.answer_text : '';

    // ── ①② 零成本閘門 ──
    const first = gate(questionText, answerText);
    if (first.ok) {
        return {
            kind: 'pass',
            data: {
                question_text: first.questionText,
                answer_text: first.answerText,
                applied: first.applied,
                issues: first.issues,     // 只剩 warn
                rewritten: false,
            },
        };
    }

    // ── ③ 還有 error 才付錢請模型重寫 ──
    const blocking = errorsOf(first.issues);
    let res;
    try {
        res = await ctx.llm.generateJson({
            model: ctx.config.models.extract,
            system: SYSTEM,
            parts: [{ text: renderPrompt({
                questionText: first.questionText,
                answerText: first.answerText,
                issues: blocking,
                feedback: inp.feedback,
            }) }],
            schema: buildSchema('lint'),
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            signal: ctx.signal,
            agent: 'lint',
            template: TEMPLATE,
            cacheKeyParts: {
                template: TEMPLATE,
                questionText: first.questionText,
                answerText: first.answerText,
                issues: blocking.map(i => i.rule).sort(),
            },
        });
    } catch (err) {
        const errorClass = classifyError(err);
        if (ctx.logger && ctx.logger.warn) {
            ctx.logger.warn({ node: 'lint', errorClass, message: String((err && err.message) || err) });
        }
        return { kind: 'error', errorClass, message: String((err && err.message) || err) };
    }

    const data = (res && res.data) || {};
    if (typeof data.question_text !== 'string' || data.question_text.trim() === '') {
        return {
            kind: 'fail',
            reason: 'formula_unparsable',
            feedback: '重寫模型沒有回傳可用的 question_text。',
            data: {
                question_text: first.questionText,
                answer_text: first.answerText,
                applied: first.applied,
                issues: first.issues,
                rewritten: true,
            },
        };
    }

    // 重寫過的文字再跑一次 ①②——模型改完仍可能不合格，閘門不因為它出手就放水
    const second = gate(data.question_text, typeof data.answer_text === 'string' ? data.answer_text : answerText);
    const merged = [...new Set([...first.applied, ...second.applied])];

    if (second.ok) {
        return {
            kind: 'pass',
            data: {
                question_text: second.questionText,
                answer_text: second.answerText,
                applied: merged,
                issues: second.issues,
                rewritten: true,
                notes: typeof data.notes === 'string' ? data.notes : undefined,
            },
        };
    }

    const still = errorsOf(second.issues);
    return {
        kind: 'fail',
        reason: 'formula_unparsable',
        feedback: '重寫後仍有無法解析的公式：'
            + still.slice(0, 3).map(i => `${i.rule}（${i.msg}）`).join('；'),
        data: {
            question_text: second.questionText,
            answer_text: second.answerText,
            applied: merged,
            issues: second.issues,
            rewritten: true,
        },
    };
}

module.exports = { run, PROMPT_TEMPLATE, TEMPLATE, gate };
