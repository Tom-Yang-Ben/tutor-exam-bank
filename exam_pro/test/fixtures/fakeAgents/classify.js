// 假 classify agent（擁有者：WS-A）——閘門與 payload 欄位照第 3.2／3.3 條，但不呼叫 LLM。
const { makeAgent } = require('./_fake');

module.exports = makeAgent('classify', (ctx, input) => ({
    chapter: input.chapter,
    confidence: input.chapter_confidence ?? 1,
    rationale: '假 agent：直接沿用拆題給的章節',
    source: 'gate'
}));
