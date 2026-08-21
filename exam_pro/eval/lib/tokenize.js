// ─────────────────────────────────────────────────────────────
// eval/lib/tokenize.js — 轉接 WS-C 的 utils/tokenize.js
//
// docs/interfaces.md 第 2 條：`utils/tokenize.js` 是**全案唯一的中文分詞器**，
// 寫入（search_tsv）、查詢（to_tsquery）、eval（LIKE 基準欄的關鍵字）三處都只能呼叫它。
// 本檔只做兩件事：
//   1. 有 utils/tokenize.js 就用它，一個字都不改；
//   2. 還沒合入時退回一個**明白標示為暫用**的 stub，讓 eval 骨架先跑得起來。
//
// stub 的分詞結果與 jieba 不同，所以 LIKE 欄的數字會不一樣。因此：
//   - stub 生效時會在 stderr 印一次警告，report 也會把 tokenizer 記進報表；
//   - thresholds.json 的初值**不得**在 stub 狀態下寫入（見 eval/lib/thresholds.js 的 guard）。
// ─────────────────────────────────────────────────────────────

const path = require('path');

const REAL_PATH = path.resolve(__dirname, '..', '..', 'utils', 'tokenize.js');

let impl = null;
let source = null;
let warned = false;

/**
 * 暫用分詞器：CJK 取相鄰二字組（bigram），非 CJK 取連續的英數序列。
 * 刻意不做詞典、不做停用詞——它的存在只是為了讓管線跑得起來，
 * 不是為了逼近 jieba；任何想把它「調好一點」的念頭都應該改成去合入 WS-C 的實作。
 * @param {string} text
 * @returns {string[]}
 */
function stubTokenize(text) {
    if (text === null || text === undefined) return [];
    const s = String(text);
    const out = [];
    const CJK = /[㐀-䶿一-鿿]/;
    let latin = '';
    const flushLatin = () => { if (latin) { out.push(latin); latin = ''; } };

    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (CJK.test(c)) {
            flushLatin();
            const next = chars[i + 1];
            if (next && CJK.test(next)) out.push(c + next);
            else out.push(c);
        } else if (/[0-9A-Za-z]/.test(c)) {
            latin += c;
        } else {
            flushLatin();
        }
    }
    flushLatin();
    return out;
}

function load() {
    if (impl) return impl;
    let real = null;
    try {
        real = require(REAL_PATH);
    } catch (err) {
        if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
    if (real && typeof real.tokenize === 'function') {
        impl = real.tokenize;
        source = 'utils/tokenize.js';
    } else {
        impl = stubTokenize;
        source = 'eval-stub';
    }
    return impl;
}

/**
 * 與 docs/interfaces.md 第 2 條同簽名。
 * @param {string} text
 * @returns {string[]} 去空白後的 token 陣列，順序 = 出現順序；null/'' 回 []
 */
function tokenize(text) {
    const fn = load();
    if (source === 'eval-stub' && !warned) {
        warned = true;
        console.warn('⚠️  utils/tokenize.js（WS-C）尚未合入，eval 暫用內建 stub 分詞器；LIKE 欄的數字不可作為基準線。');
    }
    return fn(text);
}

/** @returns {'utils/tokenize.js'|'eval-stub'} 實際用到的分詞器，會寫進報表 */
function tokenizerSource() {
    load();
    return source;
}

/** @returns {boolean} 是否還在用 stub */
function isStub() {
    return tokenizerSource() === 'eval-stub';
}

module.exports = { tokenize, tokenizerSource, isStub, stubTokenize };
