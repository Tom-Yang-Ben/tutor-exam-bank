// 假 extract agent（擁有者：WS-A）——不呼叫 LLM，改「讀 pdfPath 那個檔」。
//
// 整合測試寫進 data/jobs/<id>.pdf 的其實是一份 JSON 劇本，格式：
//   {
//     "chunks": { "1": [ …題目… ], "2": [ … ] },     // 選填；沒給就全部算 chunk 1
//     "questions": [ …題目… ],                        // chunks 沒給時用這個
//     "perChunk": { "1": { "kind":"error", "errorClass":"rate_limited", "times":2 } }
//   }
// 這樣做的好處是連「拆完刪檔、pdf_path 清成 NULL」的生命週期都一起測到了：
// 檔案被 runner 刪掉之後，重跑 extract 就會像真實情況一樣讀不到檔。

const fs = require('fs');

/** 每個 (jobId, chunk) 已經被叫過幾次，供 perChunk 的 times 倒數 */
const callCounts = new Map();

function resetCounts() { callCounts.clear(); }

async function run(ctx, input) {
    const key = `${input.jobId}|${input.chunk.no}`;
    const seen = callCounts.get(key) ?? 0;
    callCounts.set(key, seen + 1);

    let plan;
    try {
        plan = JSON.parse(fs.readFileSync(input.pdfPath, 'utf8'));
    } catch (err) {
        return { kind: 'error', errorClass: 'provider_error', message: `假 extract 讀不到劇本：${err.message}` };
    }

    const spec = (plan.perChunk || {})[String(input.chunk.no)];
    if (spec && (spec.times === undefined || seen < spec.times)) {
        if (spec.kind === 'fail') return { kind: 'fail', reason: spec.reason || 'schema_invalid' };
        if (spec.kind === 'error') return { kind: 'error', errorClass: spec.errorClass || 'provider_error', message: '假 extract 供應商錯誤' };
        if (spec.kind === 'spend') {
            await ctx.llm.generateJson({
                model: ctx.config.models.extract, agent: 'extract',
                parts: [{ text: '假拆題' }], schema: {}, cacheKeyParts: { chunk: input.chunk.no }
            });
        }
    }

    const questions = plan.chunks
        ? (plan.chunks[String(input.chunk.no)] || [])
        : (input.chunk.no === 1 ? (plan.questions || []) : []);

    // 逐元素驗證的形狀（第 3.3 條）：合格的進 questions，不合格的進 rejected
    const rejected = (plan.rejected || []).filter(r => (r.chunk ?? 1) === input.chunk.no);
    return { kind: 'pass', data: { questions, rejected } };
}

module.exports = { run, resetCounts };
