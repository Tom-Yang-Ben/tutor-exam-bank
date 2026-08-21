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

// ─────────────────────────────────────────────────────────────
// 階段 2 新增：分類指標（A-T14 的 --suite classify）
//
// 三個指標刻意分工，缺一個就會看漏一整類問題：
//   accuracy       整體對幾題——最直覺，但 90 題裡有 60 題來自同 8 個章節，
//                  只看它會被「猜最大類」的策略騙過去。
//   macro-F1       每個章節先各自算 F1 再取平均，稀有章節與大宗章節等重——
//                  「只有『向量內積』准、別章全爛」在 accuracy 上看不出來，在這裡會塌下去。
//   Top-N 混淆對   (正解, 預測) 出現最多次的組合。它不是分數，是**修 prompt 的清單**：
//                  「向量內積 → 空間向量內積 出現 7 次」直接告訴你該補哪一句。
// 三者都是純函式，吃的是 [{gold, pred}] 這種最小形狀，不認識章節也不認識模型。
// ─────────────────────────────────────────────────────────────

/**
 * 整體正確率。
 * @param {Array<{gold:string, pred:string|null}>} rows
 * @returns {{accuracy:number|null, n:number, correct:number}}
 *          rows 為空時 accuracy 回 null（不是 0）——與 recallAtK 的理由相同：
 *          「沒有題目」與「一題都沒對」是兩件事。
 */
function accuracy(rows) {
    const list = rows || [];
    if (list.length === 0) return { accuracy: null, n: 0, correct: 0 };
    const correct = list.filter(r => r.pred !== null && r.pred !== undefined && r.pred === r.gold).length;
    return { accuracy: correct / list.length, n: list.length, correct };
}

/**
 * macro-F1：每個「出現在 gold 裡」的類別各算一次 P/R/F1 再取算術平均。
 *
 * 只在 pred 出現、gold 從未出現的類別（模型幻想出來的章節）**不列入平均的分母**，
 * 但它造成的 false positive 會壓低對應 gold 類別的 recall——這正是我們要的行為：
 * 幻想出一個白名單外的章節，該扣的是「本來該答對的那一章」的分。
 *
 * @param {Array<{gold:string, pred:string|null}>} rows
 * @returns {{macroF1:number|null, perClass:Object<string,{precision:number, recall:number, f1:number, support:number}>}}
 */
function macroF1(rows) {
    const list = rows || [];
    if (list.length === 0) return { macroF1: null, perClass: {} };

    const labels = [...new Set(list.map(r => r.gold))].sort();
    const perClass = {};
    let sum = 0;
    for (const label of labels) {
        let tp = 0, fp = 0, fn = 0;
        for (const r of list) {
            const pred = (r.pred === null || r.pred === undefined) ? null : r.pred;
            if (r.gold === label && pred === label) tp++;
            else if (r.gold !== label && pred === label) fp++;
            else if (r.gold === label && pred !== label) fn++;
        }
        const precision = (tp + fp) === 0 ? 0 : tp / (tp + fp);
        const recall = (tp + fn) === 0 ? 0 : tp / (tp + fn);
        const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);
        perClass[label] = { precision, recall, f1, support: tp + fn };
        sum += f1;
    }
    return { macroF1: sum / labels.length, perClass };
}

/**
 * 混淆對：(gold, pred) 不相等的組合，依次數由多到少。
 * @param {Array<{gold:string, pred:string|null}>} rows
 * @param {number} [topN=5]
 * @returns {Array<{gold:string, pred:string, count:number}>}
 *          同次數時以 gold、再以 pred 的字典序排——報表不能每次跑出不同順序。
 */
function confusionPairs(rows, topN = 5) {
    const counts = new Map();
    for (const r of rows || []) {
        const pred = (r.pred === null || r.pred === undefined) ? '（無回應）' : r.pred;
        if (pred === r.gold) continue;
        const key = `${r.gold} ${pred}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([key, count]) => {
            const [gold, pred] = key.split(' ');
            return { gold, pred, count };
        })
        .sort((a, b) => b.count - a.count || a.gold.localeCompare(b.gold) || a.pred.localeCompare(b.pred))
        .slice(0, topN);
}

/**
 * 百分位數（線性內插，與 PostgreSQL 的 percentile_cont 同義）。
 * 用途：pipeline suite 與 report:jobs 的 p50／p95 延遲。
 * @param {number[]} values 不必先排序（本函式會複製後排序，不改動入參）
 * @param {number} p 0~1
 * @returns {number|null} values 為空時回 null
 */
function percentile(values, p) {
    const list = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
    if (list.length === 0) return null;
    if (!(p >= 0 && p <= 1)) throw new Error('p 必須介於 0 與 1 之間');
    const pos = (list.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return list[lo];
    return list[lo] + (list[hi] - list[lo]) * (pos - lo);
}

/**
 * 依鍵分組計數，並回「鍵 → 次數」由多到少的陣列。
 * 用途：needs_review 原因分佈、error_class 分佈。
 * @param {Array<string|null>} keys
 * @returns {Array<{key:string, count:number}>}
 */
function distribution(keys) {
    const counts = new Map();
    for (const k of keys || []) {
        const key = (k === null || k === undefined) ? '（無）' : String(k);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

module.exports = {
    recallAtK, reciprocalRank, jaccard, scoreOne, mean, summarize, round4,
    accuracy, macroF1, confusionPairs, percentile, distribution
};
