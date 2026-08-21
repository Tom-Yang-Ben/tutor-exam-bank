// 假 dedup agent（擁有者：WS-A）——同一支檔服務 dedup0 與 dedup1（第 10.1 條只列了單數的 dedup.js）。
// 兩層靠「凍結的 input 鍵」區分：dedup0 拿 { question_text }，dedup1 拿 { embed_text, subject, chapter }。
const crypto = require('crypto');
const { makeAgent } = require('./_fake');

const level0 = makeAgent('dedup0', (ctx, input) => ({
    text_hash: crypto.createHash('sha256').update(String(input.question_text || ''), 'utf8').digest('hex'),
    normalized_len: String(input.question_text || '').length,
    hit: null
}));

const level1 = makeAgent('dedup1', () => ({ verdict: 'unique', threshold_used: 0.97, top: [] }));

module.exports = {
    run(ctx, input) {
        return Object.prototype.hasOwnProperty.call(input, 'embed_text') ? level1.run(ctx, input) : level0.run(ctx, input);
    }
};
