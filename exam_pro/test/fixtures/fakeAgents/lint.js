// 假 lint agent（擁有者：WS-A）——不呼叫公式閘門，原文照回。
const { makeAgent } = require('./_fake');

module.exports = makeAgent('lint', (ctx, input) => ({
    question_text: input.question_text,
    answer_text: input.answer_text,
    applied: [],
    issues: [],
    rewritten: false
}));
