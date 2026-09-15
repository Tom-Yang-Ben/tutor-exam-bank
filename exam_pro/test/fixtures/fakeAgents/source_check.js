// 假 source_check agent（擁有者：WS-A）——不讀原卷，沒有指令時一律 match。
const { makeAgent } = require('./_fake');

module.exports = makeAgent('source_check', () => ({
    verdict: 'match',
    mode: 'enforce',
    rules: [],
    signals: { extraMinus: 0, missLower: 0, missDigits: 0, extraDigits: 0 },
    detail: {},
    coverage: 1,
    locate_score: 1
}));
