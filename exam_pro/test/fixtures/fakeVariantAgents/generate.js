// 假 generate agent（擁有者：WS-B，給 test/integration/variants.pg.test.js 用）
//
// 與真的 agents/generateVariant.js 合約一致：只回 outcome，不碰 DB、不改 state。
// 指令從 input.source.__fake.generate 讀（真 agent 不會有這個鍵，只有測試塞得進來），
// 形狀比照 test/fixtures/fakeAgents/_fake.js 的做法但更簡單——
// 這一支要驗的是 runner 的 generate 分支，不是 generateVariant 內部的閘門
// （那些由 test/unit/agentGenerateVariant.test.js 負責）。

/** 每個 (job_id, idx) 已經被叫過幾次；`times` 的倒數靠它。 */
const callCounts = new Map();

function resetCounts() {
    callCounts.clear();
}

/** 把藍本改寫成一題「看起來像變式」的題目（情境與數字都換過，過得了真的文字閘門） */
function fakeVariantData(source, idx) {
    return {
        idx,
        subject: source.subject,
        chapter: source.chapter,
        chapter_confidence: 0.9,
        question_type: source.question_type,
        difficulty: source.difficulty,
        question_text: `假變式第 ${idx} 題：甲船由原點出發，位移為 $\\vec{p}=(${idx * 3},${idx * 4})$ 公里，求其位移量的大小為多少公里？`,
        answer_text: `$${idx * 5}$ 公里。`,
        chunk_no: 0,
        page_range: null,
        variant_of_root: source.variant_of ?? source.id,
        anchor_ids: []
    };
}

module.exports = {
    resetCounts,
    async run(ctx, input) {
        const source = (input && input.source) || {};
        const idx = input && Number.isInteger(input.idx) ? input.idx : 1;
        const key = `${ctx?.job?.id ?? 'job'}|${idx}`;
        const seen = callCounts.get(key) ?? 0;
        callCounts.set(key, seen + 1);

        const spec = (source.__fake || {}).generate;
        const active = spec && (spec.times === undefined || seen < spec.times);

        if (active) {
            if (spec.kind === 'fail') {
                return {
                    kind: 'fail',
                    reason: spec.reason || 'text_gate',
                    feedback: spec.feedback || `假 generate：第 ${seen + 1} 次沒過閘門`
                };
            }
            if (spec.kind === 'error') {
                return { kind: 'error', errorClass: spec.errorClass || 'provider_error', message: '假 generate：供應商錯誤' };
            }
            if (spec.kind === 'echoCtx') {
                // 讓整合測試看得到 runner 真的把第 4.5 條的兩處新欄位組進 ctx
                return {
                    kind: 'pass',
                    data: fakeVariantData(source, idx),
                    gate: {
                        text_gate: { ok: true, reason: null, edit_ratio: 0.5 },
                        sim: 0.88,
                        __job: { kind: ctx.job.kind, pdf_sha256: ctx.job.pdf_sha256 },
                        __thresholds: ctx.config.thresholds,
                        __model: ctx.config.models.variant
                    }
                };
            }
        }

        return {
            kind: 'pass',
            data: fakeVariantData(source, idx),
            gate: { text_gate: { ok: true, reason: null, edit_ratio: 0.5123 }, sim: 0.8817 }
        };
    }
};
