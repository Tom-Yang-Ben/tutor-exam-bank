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
//   ③ 仍有 error 才呼叫 LLM 重寫（MODEL_TEXT；Gemini 模式＝MODEL_EXTRACT，docs/local-mode.md LM-15），改完再跑一次 ①②
//
// 為什麼第三層放最後：階段 1 的題庫健檢顯示，絕大多數壞公式都是舊轉換器的殘留標記
// 與錯位的 $——這些用規則就能修好，沒有理由為它們付錢給模型。

const { formulaFix } = require('../utils/formulaFix');
const { formulaLint } = require('../utils/formulaLint');
const { buildSchema } = require('./schemas');
const { resolveSubjectGroup } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'lint.v2';   // v2（2026-09-15）：規則 3 補 array 表格、\mathbb 已支援（PR #18）
// 兩個數字成對設定，不要單獨調（同 agents/verify.js 的教訓；2026-08-27 job #5 的
// lint 節點也出現 4 次「Unterminated string in JSON」）：MODEL_EXTRACT 是 thinking
// 模型，思考 token 計入 maxOutputTokens 額度，不設 thinkingBudget 時長題的重寫
// 會被截斷、誤歸 schema_invalid。
const MAX_OUTPUT_TOKENS = 8192;
const THINKING_BUDGET = 1024;

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
    '3. 矩陣、方程組與表格可用 \\begin{bmatrix}…\\end{bmatrix}、\\begin{pmatrix}…\\end{pmatrix}、\\begin{cases}…\\end{cases}、\\matrix{…} 或 \\begin{array}{|c|c|}…\\end{array}（表格可含 \\hline，整個表格放在同一對 $$…$$ 裡、可以跨行；列以 \\\\ 分隔、欄以 & 分隔），這些本系統支援、不要改寫掉；\\mathbb{R} 也支援。\\overrightarrow 仍不支援，請改寫為 \\vec。',
    '4. 中文敘述、數字、單位、選項內容保持原樣。',
].join('\n');

// 模組載入時註冊（裁決 S2-5）：四個 LLM 節點都必須註冊，否則 cassette 鍵會退回 sha256(識別名)
registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

// ───────────────────── 化學題（〔stage5 WS-B〕DEC-019、ADR-010）─────────────────────
//
// ①② 兩層零成本閘門兩條路徑共用：utils/textFormatter.js 自階段 5 起認得 \ce{…}、
// \rightleftharpoons、\xrightarrow 等化學寫法，formulaLint 就不會把它們當未知指令擋下。
// 只有第三層（LLM 重寫）換成化學用的 SYSTEM 與模板：數學版的規則 3 叫模型「改寫掉不支援的
// 指令」，化學題照那一版重寫會把 \ce{…} 拆成一般 LaTeX。agent 名 lint_chem、模板 lint_chem.v1。
// 上面數學／物理的 SYSTEM 與模板一個字都沒動（第 1.1 條）。

const AGENT_CHEM = 'lint_chem';
const TEMPLATE_CHEM = 'lint_chem.v1';

const SYSTEM_CHEM = [
    '你是化學題庫的 LaTeX 校對員。',
    '你唯一的工作是把壞掉的公式與化學式寫法修好，讓它能被轉換成 Word 的數學方塊。',
    '嚴禁改動題意：數字、單位、化學式的元素與係數、選項內容、中文敘述一個字都不准改，只准改寫法。',
    '嚴禁自己解題或補上答案。',
].join('\n');

const PROMPT_TEMPLATE_CHEM = [
    '以下化學題目的公式或化學式寫法有問題，請修好後照 JSON schema 回覆。',
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
    '2. 化學式、離子與反應式用 mhchem 的 \\ce{…}，放在 $…$ 裡：下標直接寫數字（\\ce{H2SO4}），電荷寫成 ^{…}（\\ce{SO4^{2-}}），箭頭用 ->、<- 或 <=>，條件寫成 ->[上][下]，物態 (s)(l)(g)(aq)，氣體 ^、沉澱 v、結晶水用句點。',
    '3. \\ce{…} 以外的式子：分數用 \\frac{分子}{分母}，根號用 \\sqrt{…}，上下標用 ^{…} 與 _{…}，大括號必須成對；表格用 \\begin{array}{|c|c|}…\\end{array} 放在同一對 $$…$$ 裡；單位用 \\mathrm{…}。',
    '4. 不要把 Unicode 的上下標（H₂O、Ca²⁺）留在文字裡，一律改成 \\ce{…}。',
    '5. 中文敘述、數字、單位、選項內容保持原樣。',
].join('\n');

registerTemplate(TEMPLATE_CHEM, `${SYSTEM_CHEM}\n---\n${PROMPT_TEMPLATE_CHEM}`);

/** 卷別 → agent 名、模板、SYSTEM、模板原文與 schema 選項 */
const VARIANTS = {
    math_physics: { agent: 'lint', template: TEMPLATE, system: SYSTEM, promptTemplate: PROMPT_TEMPLATE, schemaOpts: undefined },
    chemistry: { agent: AGENT_CHEM, template: TEMPLATE_CHEM, system: SYSTEM_CHEM, promptTemplate: PROMPT_TEMPLATE_CHEM, schemaOpts: { group: 'chemistry' } }
};

/** 把 issues 排成 prompt 用的條列 */
function issuesToText(issues) {
    if (!issues.length) return '（無）';
    return issues.map(i => `- [${i.sev}] ${i.rule} @${i.at}：${i.msg}`).join('\n');
}

function renderPrompt({ questionText, answerText, issues, feedback }, promptTemplate = PROMPT_TEMPLATE) {
    return promptTemplate
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
    // 〔stage5 WS-B〕化學題換化學的 SYSTEM／模板；數學與物理的 v 與階段 5 之前寫死的值相同
    const v = VARIANTS[resolveSubjectGroup(ctx, inp)];
    let res;
    try {
        res = await ctx.llm.generateJson({
            model: ctx.config.models.text || ctx.config.models.extract,   // 〔LM-15〕重寫只看文字：MODEL_TEXT，沒給退回 extract
            system: v.system,
            parts: [{ text: renderPrompt({
                questionText: first.questionText,
                answerText: first.answerText,
                issues: blocking,
                feedback: inp.feedback,
            }, v.promptTemplate) }],
            schema: buildSchema('lint', v.schemaOpts),
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingBudget: THINKING_BUDGET,
            signal: ctx.signal,
            agent: v.agent,
            template: v.template,
            cacheKeyParts: {
                template: v.template,
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

module.exports = {
    run, PROMPT_TEMPLATE, TEMPLATE, gate,
    // 〔stage5 WS-B〕化學題
    SYSTEM, AGENT_CHEM, TEMPLATE_CHEM, SYSTEM_CHEM, PROMPT_TEMPLATE_CHEM
};
