// 假 agent 的共同機制（擁有者：WS-A）——指令從 payload.extract.__fake 讀，見同目錄 README。
//
// 這裡刻意「只回 outcome、不碰 DB、不改 state」，與真 agent 的合約完全一致：
// runner 的測試才不會因為假 agent 偷做事而失去意義。

/** 每個 (jq_id, node) 已經被叫過幾次；`times` 的倒數靠它。 */
const callCounts = new Map();

function countKey(ctx, node) {
    return `${ctx?.jq?.id ?? 'job'}|${node}`;
}

/** 測試之間要清乾淨，否則 `times` 會跨案例累積。 */
function resetCounts() {
    callCounts.clear();
}

/**
 * @param {string} node
 * @param {(ctx, input) => object} defaultPass 沒有指令時要回的 data
 */
function makeAgent(node, defaultPass) {
    return {
        async run(ctx, input) {
            const key = countKey(ctx, node);
            const seen = callCounts.get(key) ?? 0;
            callCounts.set(key, seen + 1);

            const spec = (ctx?.jq?.payload?.extract?.__fake || {})[node];
            const active = spec && (spec.times === undefined || seen < spec.times);

            if (active) {
                if (spec.kind === 'fail') {
                    return { kind: 'fail', reason: spec.reason || 'schema_invalid', feedback: spec.feedback || `假 agent：${node} 第 ${seen + 1} 次判定不通過` };
                }
                if (spec.kind === 'error') {
                    return { kind: 'error', errorClass: spec.errorClass || 'provider_error', message: `假 agent：${node} 第 ${seen + 1} 次供應商錯誤` };
                }
                if (spec.kind === 'skipped') {
                    return { kind: 'skipped', data: spec.data || {} };
                }
                if (spec.kind === 'throw') {
                    throw new Error(spec.message || `假 agent：${node} 直接丟例外`);
                }
                if (spec.kind === 'hang') {
                    // 測節點逾時：等到 signal 被 abort 為止（真 agent 也該這樣把 signal 往下傳）
                    await new Promise((resolve) => {
                        if (ctx.signal.aborted) return resolve();
                        ctx.signal.addEventListener('abort', resolve, { once: true });
                    });
                    return { kind: 'error', errorClass: 'timeout', message: '假 agent：被 abort' };
                }
                if (spec.kind === 'spendThenPass') {
                    await ctx.llm.generateJson({
                        model: ctx.config.models.extract, agent: node,
                        parts: [{ text: '假呼叫' }], schema: {}, cacheKeyParts: { node }
                    });
                    return { kind: 'pass', data: defaultPass(ctx, input) };
                }
            }
            return { kind: 'pass', data: defaultPass(ctx, input) };
        }
    };
}

module.exports = { makeAgent, resetCounts, callCounts };
