// utils/normalizeStem.js — 題幹正規化與 text_hash（A-T5 / WS-C）
//
// docs/interfaces-stage2.md 第 4.1 條，七個步驟順序凍結。
// 目的：讓「同一題的不同抄寫」收斂成同一個字串，dedup0 才能在任何 LLM 呼叫之前
// 用 sha256 把重複題攔下來。
//
// ⚠️ 這一份是正式實作。scripts/backfill_text_hash.js（S0 先寫的自含版）已改成 require 它，
//    兩邊產出的雜湊必須逐位元相同——規則一改，全庫的 text_hash 作廢，
//    必須 `node scripts/backfill_text_hash.js --force` 重算並在 PR 說明。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

const crypto = require('crypto');

const FIGURE_DESC_RE = /\[附圖描述[：:][\s\S]*?\]/g;
const BRACKET_OPTION_RE = /[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g;
const BARE_OPTION_RE = /(^|[\s\n])([A-Ha-h])[.、．:：]/gm;

/**
 * 題幹正規化。
 *
 *   1. 非字串／空字串 → ''（不得拋例外）
 *   2. 剝掉所有 [附圖描述：…] 區塊（含中括號本身，全半形冒號都吃，可跨行）
 *   3. NFKC：全形英數、全形括號、全形問號逗號 → 半形
 *   4. 選項代號統一成 (A)：4a 括號型、4b 行首／空白後的「A.」
 *   5. 去掉所有 $
 *   6. 去掉所有空白與換行
 *   7. toLowerCase()
 *
 * 順序不可調換：4 需要空白還在（才認得出「行首的 A.」），3 必須在 4 之前（全形括號要先變半形）。
 *
 * @param {string} text
 * @returns {string}   非字串／空字串一律回 ''，**不得拋例外**
 */
function normalizeStem(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let s = text;
    s = s.replace(FIGURE_DESC_RE, '');                                              // 2
    s = s.normalize('NFKC');                                                        // 3
    s = s.replace(BRACKET_OPTION_RE, (m, ch) => `(${ch.toUpperCase()})`);           // 4a
    s = s.replace(BARE_OPTION_RE, (m, pre, ch) => `${pre}(${ch.toUpperCase()})`);   // 4b
    s = s.replace(/\$/g, '');                                                       // 5
    s = s.replace(/\s+/g, '');                                                      // 6
    return s.toLowerCase();                                                         // 7
}

/**
 * @param {string} text
 * @returns {string|null}   sha256(normalizeStem(text)) 的小寫 hex；正規化後為空回 null
 */
function textHash(text) {
    const norm = normalizeStem(text);
    if (norm === '') return null;
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

module.exports = { normalizeStem, textHash };
