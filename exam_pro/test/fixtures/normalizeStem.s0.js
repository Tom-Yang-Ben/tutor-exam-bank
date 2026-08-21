// test/fixtures/normalizeStem.s0.js —— S0 在 scripts/backfill_text_hash.js 裡寫的
// 自含正規化實作（commit e1740ca）的逐字副本，凍結，永不編輯。
//
// 用途：test/unit/normalizeStem.test.js 的等價測試——證明 A-T5 的
// utils/normalizeStem.js 與 S0 版對同一輸入產出逐位元相同的雜湊，
// 因此開發庫已回填的 text_hash 不需要重算。
// ⚠️ 這份副本是契約的一部分：任何人都不該為了讓測試變綠而修改它。

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// 正規化規則（docs/interfaces-stage2.md 第 4 條的逐條落地）
//
//   1. 非字串／空值 → ''（不拋例外）
//   2. 剝掉所有 [附圖描述：…] 區塊（含中括號本身，全半形冒號都吃，可跨行）
//   3. NFKC：全形英數與全形括號 → 半形
//   4. 選項代號統一成 (A)：先吃 (A)（A）[A]【A】，再吃行首／空白後的 A. A、A：
//   5. 去掉所有 $（行內公式的界定符，$ 的有無不該影響「是不是同一題」）
//   6. 去掉所有空白與換行
//   7. 轉小寫
//
// 順序不可調換：4 需要空白還在（才認得出「行首的 A.」），5 之後才輪得到 6、7。
// ─────────────────────────────────────────────────────────────

const FIGURE_DESC_RE = /\[附圖描述[：:][\s\S]*?\]/g;
const BRACKET_OPTION_RE = /[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g;
const BARE_OPTION_RE = /(^|[\s\n])([A-Ha-h])[.、．:：]/gm;

/**
 * 題幹正規化（純函式，無 I/O、無隨機、無時間）。
 * @param {string} text
 * @returns {string}
 */
function normalizeStem(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let s = text;
    s = s.replace(FIGURE_DESC_RE, '');                       // 2
    s = s.normalize('NFKC');                                 // 3
    s = s.replace(BRACKET_OPTION_RE, (m, ch) => `(${ch.toUpperCase()})`);   // 4a
    s = s.replace(BARE_OPTION_RE, (m, pre, ch) => `${pre}(${ch.toUpperCase()})`); // 4b
    s = s.replace(/\$/g, '');                                // 5
    s = s.replace(/\s+/g, '');                               // 6
    return s.toLowerCase();                                  // 7
}

/** text_hash = sha256(normalizeStem(text)) 的小寫 hex；空題幹回 null（不寫入雜湊）。 */
function textHash(text) {
    const norm = normalizeStem(text);
    if (norm === '') return null;
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

module.exports = { normalizeStem, textHash };
