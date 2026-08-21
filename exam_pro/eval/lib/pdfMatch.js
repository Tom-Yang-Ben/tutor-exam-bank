// ─────────────────────────────────────────────────────────────
// eval/lib/pdfMatch.js — 把「模型拆出來的題」對上「答案卷上的題」（E-X12a）
//
// extract_recall 與 chapter_acc 這兩個數字，完全取決於這一步配得準不準。
// 配錯一題，recall 少一分、章節正確率也跟著錯——而報表上看起來只是「模型變差了」。
// 因此配對規則寫死在這裡，**不接受任何呼叫端傳進來的旗標**（與 eval/lib/pooling.js 的
// LIKE 關鍵字規則同一個道理：可調的參數等於可被操弄的數字）。
//
// 兩段式，先嚴後鬆：
//   1. **雜湊完全相同**（normalizeStem → sha256）：一定是同一題，直接配。
//      模型照抄題幹時走這一條，也是最常見的情形。
//   2. **分詞後的 Jaccard ≥ 0.5**：模型改寫了標點、把選項換行、或漏抄一個符號時走這一條。
//      用貪婪法由高分往低配，一對一，不重複使用。
//
// 為什麼門檻是 0.5：低於 0.5 意味著兩題有一半以上的詞不同，那多半真的是不同題；
// 把它配起來只會讓 chapter_acc 被一組亂配的資料稀釋。配不上的題寧可算「沒拆到」——
// 那是 extract_recall 本來就該反映的東西。
// ─────────────────────────────────────────────────────────────

const { tokenize } = require('./tokenize');
const { textHash } = require('./stage2Shims');

const JACCARD_FLOOR = 0.5;

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenSet(text) {
    return new Set(tokenize(String(text || '')));
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0~1；兩邊都空時回 0（不是 1）——兩段空文字不該被當成「完全相同的題」
 */
function jaccardSets(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

/**
 * 把 extracted 對上 expected。
 *
 * @param {Array<{question_text:string}>} expected  答案卷上的題（順序即題號）
 * @param {Array<{question_text:string}>} extracted 模型拆出來的題
 * @returns {{
 *   pairs: Array<{expectedIdx:number, extractedIdx:number, score:number, method:'hash'|'jaccard'}>,
 *   unmatchedExpected: number[],
 *   unmatchedExtracted: number[]
 * }}
 */
function matchQuestions(expected, extracted) {
    const exp = expected || [];
    const got = extracted || [];
    const pairs = [];
    const usedExp = new Set();
    const usedGot = new Set();

    // ── 第 1 段：雜湊完全相同 ──
    const gotHash = new Map();   // hash → [extractedIdx…]
    got.forEach((g, i) => {
        const h = textHash(g.question_text);
        if (!h) return;
        if (!gotHash.has(h)) gotHash.set(h, []);
        gotHash.get(h).push(i);
    });
    exp.forEach((e, i) => {
        const h = textHash(e.question_text);
        if (!h) return;
        const bucket = gotHash.get(h);
        if (!bucket) return;
        const j = bucket.find(idx => !usedGot.has(idx));
        if (j === undefined) return;
        usedExp.add(i);
        usedGot.add(j);
        pairs.push({ expectedIdx: i, extractedIdx: j, score: 1, method: 'hash' });
    });

    // ── 第 2 段：Jaccard 貪婪配對 ──
    const expTokens = exp.map(e => tokenSet(e.question_text));
    const gotTokens = got.map(g => tokenSet(g.question_text));
    const candidates = [];
    for (let i = 0; i < exp.length; i++) {
        if (usedExp.has(i)) continue;
        for (let j = 0; j < got.length; j++) {
            if (usedGot.has(j)) continue;
            const score = jaccardSets(expTokens[i], gotTokens[j]);
            if (score >= JACCARD_FLOOR) candidates.push({ i, j, score });
        }
    }
    // 由高分往低配；同分時以 (i, j) 排序，確保兩次執行的結果一致（報表不能有隨機性）。
    candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    for (const c of candidates) {
        if (usedExp.has(c.i) || usedGot.has(c.j)) continue;
        usedExp.add(c.i);
        usedGot.add(c.j);
        pairs.push({ expectedIdx: c.i, extractedIdx: c.j, score: c.score, method: 'jaccard' });
    }

    pairs.sort((a, b) => a.expectedIdx - b.expectedIdx);
    return {
        pairs,
        unmatchedExpected: exp.map((_, i) => i).filter(i => !usedExp.has(i)),
        unmatchedExtracted: got.map((_, i) => i).filter(i => !usedGot.has(i))
    };
}

/**
 * 由配對結果算 E-X12a 的兩個核心欄位。
 *
 * @param {Array<object>} expected
 * @param {Array<object>} extracted
 * @param {object} match matchQuestions 的回傳
 * @returns {{extract_recall:number|null, chapter_acc:number|null, matched:number,
 *            chapter_correct:number, chapter_wrong:Array<{no:number, expect:string, got:string}>}}
 *          expected 為空時兩個比率都回 null（沒有答案卷就不該有分數）。
 */
function scoreExtraction(expected, extracted, match) {
    const exp = expected || [];
    if (exp.length === 0) {
        return { extract_recall: null, chapter_acc: null, matched: 0, chapter_correct: 0, chapter_wrong: [] };
    }
    const matched = match.pairs.length;
    let chapterCorrect = 0;
    const wrong = [];
    for (const p of match.pairs) {
        const e = exp[p.expectedIdx];
        const g = extracted[p.extractedIdx];
        if (g && g.chapter === e.chapter) chapterCorrect++;
        else wrong.push({ no: e.no ?? (p.expectedIdx + 1), expect: e.chapter, got: (g && g.chapter) || null });
    }
    return {
        extract_recall: matched / exp.length,
        // 分母是「配對成功的題」而不是「答案卷全部的題」：
        // 沒拆到的題本來就沒有章節可比，把它算成「章節錯」會讓兩個欄位互相污染。
        chapter_acc: matched === 0 ? null : chapterCorrect / matched,
        matched,
        chapter_correct: chapterCorrect,
        chapter_wrong: wrong
    };
}

module.exports = { matchQuestions, scoreExtraction, jaccardSets, tokenSet, JACCARD_FLOOR };
