// agents/source_check.js — 拆題結果對照原卷文字層（docs/source-check.md、ADR-009）
//
// 合約：docs/interfaces-stage2.md 第 3.1／3.3 條
//   run(ctx, input) → Promise<Outcome>，**不得 throw**、不讀 env、不碰 DB、不呼叫 LLM
//   input  = { question_text, source_text, has_figure }
//            question_text = payload.lint.question_text ?? payload.extract.question_text
//            （lint 的 LLM 重寫若改壞數字也抓得到）
//            source_text   = payload.extract.source_text（extract 階段抽好的原卷片段）
//   模式   = ctx.config.sourceCheck.mode（runner 由 SOURCE_CHECK_MODE 組，預設 enforce）
//     off     → skipped('disabled')
//     shadow  → mismatch 也 pass，data.verdict='mismatch'、shadow:true（只記錄、不攔）
//     enforce → mismatch 回 fail('transcription_mismatch')，不重試，直接進 needs_review
//   其餘     → 沒有片段、未定位、題目中文字太少、段落對不上 → skipped(原因)
//
// 零成本節點（pipeline/stateMachine.js 的 FREE_NODES）：當日預算止血時仍可跑；
// job 預算用盡時回 fail 也保留 transcription_mismatch，不被改寫成 budget_exceeded。

const { compareSegment, describeMismatch } = require('../utils/sourceCheck');
const { replaceCe, ceToComparable } = require('../utils/chemFormula');
const { resolveSubjectGroup } = require('./promptParts');

const MODES = ['off', 'shadow', 'enforce'];

/**
 * 〔stage5 WS-B〕化學題的題幹先把 \ce{…} 換成可比對的純文字（utils/chemFormula.js 的 ceToComparable）。
 * 反應箭頭 `->`、`<=>` 在原卷文字層是 → ⇌，不先拿掉就會被「負號比原卷多」這條規則當成抄錯
 * （docs/source-check.md 的規則 1）。數學／物理題不經過這一步，比對器的輸入逐字不變。
 * @param {string} text
 * @returns {string}
 */
function chemistryComparable(text) {
    return replaceCe(text, body => ` ${ceToComparable(body)} `);
}

function modeOf(ctx) {
    const m = ctx && ctx.config && ctx.config.sourceCheck && ctx.config.sourceCheck.mode;
    return MODES.includes(m) ? m : 'enforce';
}

function skipped(reason, extra) {
    return { kind: 'skipped', data: { reason, ...(extra || {}) } };
}

/**
 * @param {object} ctx
 * @param {{question_text:string, source_text?:object, has_figure?:boolean}} input
 * @returns {Promise<object>} Outcome
 */
async function run(ctx, input) {
    try {
        const mode = modeOf(ctx);
        if (mode === 'off') return skipped('disabled', { mode });

        const inp = input || {};
        const st = inp.source_text;
        if (!st || typeof st !== 'object') return skipped('no_source_text', { mode });
        if (st.status !== 'located' || typeof st.segment !== 'string') {
            return skipped(String(st.status || 'no_source_text'), { mode });
        }

        const rawQuestion = typeof inp.question_text === 'string' ? inp.question_text : '';
        const result = compareSegment({
            questionText: resolveSubjectGroup(ctx, inp) === 'chemistry' ? chemistryComparable(rawQuestion) : rawQuestion,
            segment: st.segment,
            hasFigure: inp.has_figure === true
        }, ctx && ctx.config && ctx.config.sourceCheck && ctx.config.sourceCheck.options);

        if (result.verdict === 'skipped') {
            return skipped(result.reason, { mode, ...(result.coverage !== undefined ? { coverage: result.coverage } : {}) });
        }

        const data = {
            verdict: result.verdict,
            mode,
            rules: result.rules,
            signals: result.signals,
            detail: result.detail,
            coverage: result.coverage,
            locate_score: st.locate_score ?? null,
            ...(st.shared ? { shared: true } : {})
        };
        if (result.verdict === 'match') return { kind: 'pass', data };

        const message = describeMismatch(result);
        data.message = message;
        if (mode === 'shadow') return { kind: 'pass', data: { ...data, shadow: true } };
        return { kind: 'fail', reason: 'transcription_mismatch', feedback: message, data };
    } catch (err) {
        // 合約：不得 throw。比對器本身壞掉只該少一個檢查，不該讓題目卡住。
        if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn({ node: 'source_check', msg: '原卷比對內部例外，本題略過', error: String((err && err.message) || err) });
        }
        return skipped('internal_error');
    }
}

module.exports = { run, MODES, chemistryComparable };
