// ─────────────────────────────────────────────────────────────
// utils/variantTextGate.js — 變式題的「只改字閘門」（docs/interfaces-stage3.md 第 4.3 條）
//
// 純函式：無 I/O、無隨機、無時間、**不讀 process.env**（門檻由呼叫端傳入，裁決 S3-13）。
//
// 這一道刻意**不用 embedding**：utils/embedText.js 的設計目的就是讓「換數字的同一題」
// 在向量空間碰撞（規劃 §2.3.6），拿它判「變式是否太像藍本」會把所有合格的數值變式退回。
// **向量管概念、文字管字面**，兩個工具各自對齊它被設計的用途：
//   - 跑題檢查（第 4.4 條）用餘弦，問的是「概念還是同一個嗎」；
//   - 本閘門用編輯距離，問的是「字面上真的改過了嗎」。
//
// 依序判斷，第一個命中就回傳（兩邊都先過 utils/normalizeStem.js 的 normalizeStem）：
//   1. 正規化後完全相同                                   → identical（edit_ratio: 0）
//   2. **數字遮罩後文字相同**（每段連續數字換成 `#`）      → numbers_only
//   3. edit_ratio < minEdit                               → too_close
//   4. 其餘                                               → ok
//
// 規則 2 的「數字多重集合相同」在**裁決 S3-R8 拿掉了**（原 docs/archive/questions3-wsB.md 第 1 條）。
// 原本的 AND 條件只擋得住「數字對調」；換成**別的**數字時多重集合就不同了，於是整條規則失效，
// 只剩規則 3 的編輯距離在擋——而短題幹改四個數字就有 ~10% > VARIANT_MIN_EDIT=0.08，會漏。
// 實測反例（40 字題幹）：
//   藍本 設 $\vec{a}=(3,4)$、$\vec{b}=(1,2)$，求兩向量的夾角餘弦值。
//   變式 設 $\vec{a}=(6,8)$、$\vec{b}=(2,4)$，求兩向量的夾角餘弦值。
// 只看遮罩後相同就抓得到它，而且不會誤傷合格變式——合格變式的敘述本來就重寫過，
// 遮罩後不可能相同。「數字對調」仍被同一條涵蓋（遮罩後當然也相同）。
// ─────────────────────────────────────────────────────────────

const { normalizeStem } = require('./normalizeStem');

/** 一段連續數字算一個「數字」；小數點與負號不併入（'3.5' → ['3','5']，兩邊規則一致即可比較）。 */
const DIGITS_RE = /\d+/g;

/**
 * 把每段連續數字換成 `#`：用來判斷「除了數字以外一模一樣」。
 * @param {string} s
 * @returns {string}
 */
function maskNumbers(s) {
    return String(s).replace(DIGITS_RE, '#');
}

/**
 * Levenshtein 編輯距離（兩列滾動，O(n·m) 時間、O(min) 空間）。
 * 正規化後的題幹通常只有數十到數百字，不需要更聰明的做法。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
    const s = String(a);
    const t = String(b);
    if (s === t) return 0;
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    let prev = new Array(t.length + 1);
    let curr = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;

    for (let i = 1; i <= s.length; i++) {
        curr[0] = i;
        const si = s[i - 1];
        for (let j = 1; j <= t.length; j++) {
            const cost = si === t[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[t.length];
}

/**
 * 編輯距離比例：`levenshtein(a,b) / max(a.length, b.length)`；max 為 0 時回 0。
 * @param {string} a 正規化後的字串
 * @param {string} b 正規化後的字串
 * @returns {number} 0~1
 */
function editRatio(a, b) {
    const max = Math.max(String(a).length, String(b).length);
    if (max === 0) return 0;
    return levenshtein(a, b) / max;
}

/**
 * 只改字閘門（第 4.3 條，簽名凍結）。
 *
 * @param {{ source_text:string, variant_text:string, minEdit?:number }} opts  minEdit 預設 0.08
 * @returns {{ ok:boolean, reason:'identical'|'numbers_only'|'too_close'|null, edit_ratio:number }}
 */
function textGate({ source_text, variant_text, minEdit = 0.08 } = {}) {
    const a = normalizeStem(source_text);
    const b = normalizeStem(variant_text);

    // 1. 完全相同
    if (a === b) return { ok: false, reason: 'identical', edit_ratio: 0 };

    const ratio = editRatio(a, b);

    // 2. 只換了數字（裁決 S3-R8：**只看遮罩後相不相同**，不再要求數字多重集合相同）。
    //    「數字對調」與「換成別的數字」都落在這一條，長題幹也擋得住。
    if (maskNumbers(a) === maskNumbers(b)) {
        return { ok: false, reason: 'numbers_only', edit_ratio: ratio };
    }

    // 3. 改得太少（規則 2 沒抓到、但字面上幾乎沒動的情況）
    const threshold = Number.isFinite(Number(minEdit)) ? Number(minEdit) : 0.08;
    if (ratio < threshold) return { ok: false, reason: 'too_close', edit_ratio: ratio };

    return { ok: true, reason: null, edit_ratio: ratio };
}

module.exports = { textGate, levenshtein, editRatio, maskNumbers };
