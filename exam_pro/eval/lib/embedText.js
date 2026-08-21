// ─────────────────────────────────────────────────────────────
// eval/lib/embedText.js — 轉接 WS-C 的 utils/embedText.js
//
// docs/interfaces.md 第 3 條凍結了 buildEmbedText() 的輸出格式，而
// `embed_hash = sha256(buildEmbedText(q))` 是 fixture 向量檔的鍵。
// 也就是說：**這一支只要和 WS-C 的實作差一個字元，整份 embeddings.*.json 就查不到。**
//
// 因此本檔的 stub 有一條硬規則：只能用在「還沒有向量、只跑 LIKE 欄」的骨架階段。
//   - eval/record_embeddings.js（D-V0）在 stub 狀態下**拒絕執行**；
//   - eval/lib/thresholds.js 在 stub 狀態下**拒絕寫入初值**。
// 這樣不會有人拿 stub 產出的 hash 去錄一份永遠對不上的向量檔。
// ─────────────────────────────────────────────────────────────

const path = require('path');
const crypto = require('crypto');

const REAL_PATH = path.resolve(__dirname, '..', '..', 'utils', 'embedText.js');

let impl = null;
let source = null;

/**
 * 暫用的 latexToPlain：只做 interfaces 第 3 條列出的最小集合。
 * 真正的對照表（GREEK / SYMBOLS / FUNCTIONS）在 utils/textFormatter.js，
 * 由 WS-C 在 D-E3 匯出後重用——stub 不去碰它，免得先寫死一份會漂掉的副本。
 * @param {string} s
 * @returns {string}
 */
function stubLatexToPlain(s) {
    if (!s) return '';
    return String(s)
        .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
        .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
        .replace(/\\theta/g, 'θ')
        .replace(/\\times/g, '×')
        .replace(/\\cdot/g, '·')
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/[{}^_$]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/**
 * 暫用的 buildEmbedText：形狀照 interfaces 第 3 條，內容不保證與 WS-C 逐字相同。
 * @param {{subject:string, chapter:string, question_type:string, difficulty:number,
 *          question_text:string, concept_summary?:string, keywords?:string[]}} q
 * @returns {string}
 */
function stubBuildEmbedText(q) {
    const lines = [
        `${q.subject}｜${q.chapter}｜${q.question_type}｜難度${q.difficulty}`,
        stubLatexToPlain(q.question_text || '')
    ];
    if (q.concept_summary) lines.push(q.concept_summary);
    if (q.keywords && q.keywords.length) lines.push(q.keywords.join(' '));
    return lines.join('\n');
}

function load() {
    if (impl) return impl;
    let real = null;
    try {
        real = require(REAL_PATH);
    } catch (err) {
        if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
    if (real && typeof real.buildEmbedText === 'function') {
        impl = real.buildEmbedText;
        source = 'utils/embedText.js';
    } else {
        impl = stubBuildEmbedText;
        source = 'eval-stub';
    }
    return impl;
}

/**
 * 與 docs/interfaces.md 第 3 條同簽名。
 * @param {object} q
 * @returns {string}
 */
function buildEmbedText(q) {
    return load()(q);
}

/** @returns {'utils/embedText.js'|'eval-stub'} */
function embedTextSource() {
    load();
    return source;
}

/** @returns {boolean} */
function isStub() {
    return embedTextSource() === 'eval-stub';
}

/**
 * embed_hash：sha256(embed_text) 的十六進位小寫，是 fixture 向量檔的鍵。
 * @param {string} embedText
 * @returns {string}
 */
function embedHash(embedText) {
    return crypto.createHash('sha256').update(String(embedText), 'utf8').digest('hex');
}

module.exports = { buildEmbedText, embedTextSource, isStub, embedHash, stubBuildEmbedText };
