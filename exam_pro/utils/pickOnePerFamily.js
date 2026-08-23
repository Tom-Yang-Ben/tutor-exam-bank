// ─────────────────────────────────────────────────────────────
// pickOnePerFamily.js — 組卷的家族互斥（P-06，擁有者：WS-A）
//
// 簽名凍結於 docs/interfaces-stage3.md 第 2.1 條。
//
// 為什麼需要它：階段 3 的變式題入庫後就是一般題（規劃 §4.1「不開專用通道」），
// generatePaper 照章節抽得到。但同一道藍本生出來的三題變式概念完全相同，
// 同時抽進一張卷等於讓學生把同一題寫三遍——不會噴錯、不會當機，
// 只會讓那張卷安靜地變窄。唯一的額外規則就是「同一 variant_of 家族在同一張卷只取一題」。
//
// **語意的改變要在文件與測試裡明講**（第 2.1 條）：
//   抽題從「每題等機率」變成「**每家族等機率**」。
//   一個有 5 題變式的家族，跟一個孤題，被選中的機率是一樣的。
//   這是刻意的——公平的單位是「概念」，不是「題目列數」，
//   否則生越多變式的章節就越容易被抽到，正好與變式題的用意相反。
//
// 家族鍵 = `row.variant_of ?? row.id`，等價於 SQL 的 COALESCE(variant_of, id)。
// variant_of 永遠指向家族**根節點**（interfaces.md 第 1.2 條），所以不需要遞迴——
// 不會有 A → B → C 這種鏈，藍本本身的 variant_of 是 NULL、鍵就是它自己的 id。
//
// 純函式：無 I/O、無時間、不讀 process.env。隨機性全部經注入的 shuffleFn 進來，
// 測試才能用固定種子的 PRNG 把分佈釘死（比照 test/unit/shuffle.test.js）。
// ─────────────────────────────────────────────────────────────
const { shuffle } = require('./shuffle');

/**
 * 每個變式家族只留一題，再對「家族代表」洗牌。
 *
 * 步驟（第 2.1 條凍結）：
 *   1. 依 `variant_of ?? id` 分組，**保留第一次出現的順序**（決定性，方便測試與除錯）
 *   2. 每組以 `shuffleFn(members)[0]` 取代表——組內每一題等機率
 *   3. 最後 `shuffleFn(representatives)` 回傳
 *
 * @param {Array<{id:number, variant_of:number|null}>} rows  候選池；**不會被修改**
 * @param {(items:Array) => Array} [shuffleFn]               預設 utils/shuffle.js 的 shuffle
 * @returns {Array} 每家族一題、且已洗牌的新陣列（元素是原物件的參照）
 */
function pickOnePerFamily(rows, shuffleFn = shuffle) {
    // Map 的迭代順序 = 插入順序，這就是「保留第一次出現的順序」的落地方式。
    // 用普通物件當字典會踩到「整數鍵被自動排序」的老坑，家族順序會變成 id 大小序。
    const families = new Map();
    for (const row of rows) {
        // 缺 variant_of 鍵視同 null（?? 對 undefined 與 null 都成立）
        const key = row.variant_of ?? row.id;
        const members = families.get(key);
        if (members) members.push(row);
        else families.set(key, [row]);
    }

    const representatives = [];
    for (const members of families.values()) {
        // 單題家族也照樣走一次 shuffleFn：省掉這次呼叫會讓「注入的 shuffleFn
        // 被呼叫幾次」隨資料而變，測試替身就沒辦法算出確定的期望值。
        representatives.push(shuffleFn(members)[0]);
    }

    // rows 為 [] 時 representatives 也是 []，shuffleFn([]) 回 []
    return shuffleFn(representatives);
}

module.exports = { pickOnePerFamily };
