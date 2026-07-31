// ─────────────────────────────────────────────────────────────
// shuffle.js — Fisher-Yates 洗牌
//
// 為什麼要獨立成一支模組：智慧組卷的「隨機抽題」是這個系統的公平性核心，
// 但隨機性錯了不會噴錯、不會當機，只會讓某些題目長期抽不到——是典型的
// 靜默失效。獨立出來才能在沒有資料庫的情況下用統計方法釘住它
// （見 test/shuffle.test.js 的一萬次分佈測試）。
//
// ⚠️ 不要改回 array.sort(() => 0.5 - Math.random())：
//    那是常見寫法但**分佈並不均勻**。sort 的比較函式被假設為一致的
//    （同一組輸入必須給出同樣的大小關係），隨機比較函式違反此前提，
//    實際結果取決於引擎的排序演算法，會產生明顯偏差。
//    test/shuffle.test.js 內有一則測試專門證明舊寫法會被統計檢定抓出來。
// ─────────────────────────────────────────────────────────────

/**
 * 以 Fisher-Yates（Knuth shuffle）回傳打亂後的**新**陣列，不修改原陣列。
 * 每一種排列出現的機率相等（前提是 random() 為均勻分佈）。
 *
 * @param {Array} items  來源陣列（不會被修改）
 * @param {() => number} [random] 亂數來源，需回傳 [0, 1) 的浮點數。
 *                                預設 Math.random；測試時可注入具種子的 PRNG 以確保可重現。
 * @returns {Array} 打亂後的新陣列
 */
function shuffle(items, random = Math.random) {
    const arr = [...items];
    // 由後往前，第 i 個位置與 [0, i] 中隨機挑一個交換
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

module.exports = { shuffle };
