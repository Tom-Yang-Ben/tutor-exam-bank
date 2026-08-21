// ─────────────────────────────────────────────────────────────
// eval/lib/metrics.js — 檢索指標（純函式：無 I/O、無隨機、無時間）
//
// 規劃 §5.3.3：「指標（eval/lib/metrics.js，純函式、有單元測試）：Recall@5/10、MRR」。
// 這一支不認識題目、不認識資料庫，只吃「排名後的 id 陣列」與「人工判定的相關 id 陣列」，
// 因此可以在 test/unit/ 裡完全離線地把它釘死——它是三欄對照數字的唯一來源，
// 算錯了整張表都是錯的，卻不會有任何症狀。
// ─────────────────────────────────────────────────────────────

/**
 * 把陣列轉成 Set，順便把 id 正規化為數字（golden 可能寫成字串）。
 * @param {Array<number|string>} ids
 * @returns {Set<number>}
 */
function toIdSet(ids) {
    return new Set((ids || []).map(Number));
}

/**
 * Recall@K：前 K 名命中的相關題數 ÷ 相關題總數。
 *
 * relevant 為空時回 null（不是 0）——「沒有正確答案」與「一題都沒找到」是兩件事，
 * 前者必須被排除在平均之外，否則會把平均值稀釋成無意義的數字。
 *
 * @param {Array<number|string>} ranked   依名次排列的 id（第 1 名在前）
 * @param {Array<number|string>} relevant 人工判定為相關的 id
 * @param {number} k
 * @returns {number|null} 0~1，或 null
 */
function recallAtK(ranked, relevant, k) {
    const rel = toIdSet(relevant);
    if (rel.size === 0) return null;
    if (!Number.isInteger(k) || k <= 0) throw new Error('k 必須是正整數');
    const topK = (ranked || []).slice(0, k).map(Number);
    let hit = 0;
    const seen = new Set();
    for (const id of topK) {
        if (seen.has(id)) continue;   // 排名裡若出現重複 id，只算一次
        seen.add(id);
        if (rel.has(id)) hit++;
    }
    return hit / rel.size;
}

/**
 * Reciprocal Rank：第一個相關題的名次倒數；前面完全沒命中則為 0。
 * @param {Array<number|string>} ranked
 * @param {Array<number|string>} relevant
 * @returns {number|null} 0~1，relevant 為空時 null
 */
function reciprocalRank(ranked, relevant) {
    const rel = toIdSet(relevant);
    if (rel.size === 0) return null;
    const list = (ranked || []).map(Number);
    for (let i = 0; i < list.length; i++) {
        if (rel.has(list[i])) return 1 / (i + 1);
    }
    return 0;
}

/**
 * Jaccard 相似度 |A ∩ B| / |A ∪ B|。
 * 用途：D-R2 斷言「SQL 排序器與記憶體排序器前 10 名的集合 Jaccard ≥ 0.9」。
 * 兩邊都空時定義為 1（沒有候選＝完全一致），避免 0/0。
 * @param {Array<number|string>} a
 * @param {Array<number|string>} b
 * @returns {number} 0~1
 */
function jaccard(a, b) {
    const sa = toIdSet(a);
    const sb = toIdSet(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    return inter / (sa.size + sb.size - inter);
}

/**
 * 逐題指標。
 * @param {{ranked: Array<number|string>, relevant: Array<number|string>}} row
 * @returns {{recall5:number|null, recall10:number|null, rr:number|null}}
 */
function scoreOne(row) {
    return {
        recall5: recallAtK(row.ranked, row.relevant, 5),
        recall10: recallAtK(row.ranked, row.relevant, 10),
        rr: reciprocalRank(row.ranked, row.relevant)
    };
}

/**
 * 平均：只把非 null 的值納入分母，並回報實際納入的題數。
 * @param {Array<number|null>} values
 * @returns {number|null}
 */
function mean(values) {
    const usable = (values || []).filter(v => v !== null && v !== undefined);
    if (usable.length === 0) return null;
    return usable.reduce((s, v) => s + v, 0) / usable.length;
}

/**
 * 彙總一整份 golden 的結果。
 * @param {Array<{ranked:Array, relevant:Array}>} rows
 * @returns {{n:number, scored:number, recall5:number|null, recall10:number|null, mrr:number|null}}
 *          n = 送進來的題數；scored = 實際有相關題、被納入平均的題數
 */
function summarize(rows) {
    const per = (rows || []).map(scoreOne);
    return {
        n: per.length,
        scored: per.filter(p => p.rr !== null).length,
        recall5: mean(per.map(p => p.recall5)),
        recall10: mean(per.map(p => p.recall10)),
        mrr: mean(per.map(p => p.rr))
    };
}

/**
 * 報表用的四捨五入：一律四位小數，避免浮點尾數讓 diff 每次都變。
 * @param {number|null} v
 * @returns {number|null}
 */
function round4(v) {
    if (v === null || v === undefined) return null;
    return Math.round(v * 10000) / 10000;
}

module.exports = { recallAtK, reciprocalRank, jaccard, scoreOne, mean, summarize, round4 };
