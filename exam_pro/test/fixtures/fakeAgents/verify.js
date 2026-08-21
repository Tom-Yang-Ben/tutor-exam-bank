// 假 verify agent（擁有者：WS-A）——證明題照樣走 skipped，其餘一律 agree。
const { makeAgent } = require('./_fake');

const agent = makeAgent('verify', (ctx, input) => ({
    skipped: false,
    final_answer: input.claimed_answer,
    answer_form: 'text',
    steps_summary: '假 agent：不實際解題',
    claimed_answer: input.claimed_answer,
    compare: 'agree',
    samples: 1
}));

module.exports = {
    async run(ctx, input) {
        if (input.question_type === '證明') return { kind: 'skipped', data: { skipped: true } };
        return agent.run(ctx, input);
    }
};
