// config/chapterExamples.js — 每個章節一句「自製」例題（classify agent 的 few-shot 退路）
//
// 為什麼需要它（規劃 §3.3.4 classify 節點）：分類 agent 的第二層 few-shot 候選，
// 第一順位是題庫既有題（階段 1 的 /similar 或 SELECT ... WHERE subject=? AND chapter=?），
// 但**題庫沒有那一章的題時就取不到例子**——新開的章、剛建的庫都會遇到。
// 這個檔就是那個保證存在的退路：每章一句話，讓 prompt 永遠有東西可舉例。
//
// 規則（docs/interfaces-stage2.md 第 3 條）：
//   1. 鍵 = config/chapters.js 的 CHAPTERS，逐章一個鍵，一個都不能少也不能多
//      （test/unit 會斷言兩邊的鍵集合完全相同）。
//   2. 值 = 一句「自己寫的」代表性題目或概念句，**不得抄任何真實考卷**（NOTICE 第 4 條）。
//      建議 15~40 字、含該章的關鍵名詞，數學式用 $...$ 包起來。
//   3. 值為空字串 = 尚未填寫；classify 會略過空字串的章節，不會把空字串送進 prompt。
//
// 擁有者：S0 建空殼，**內容由 WS-B（A-T9 classify）填**。填完把本行註記刪掉。

const { CHAPTERS } = require('./chapters');

const CHAPTER_EXAMPLES = {
    '數學': {
        '實數': '',
        '絕對值': '',
        '指數與對數': '',
        '直線方程式': '',
        '圓方程式': '',
        '多項式除法': '',
        '三次函數': '',
        '數列與級數': '',
        '排列': '',
        '組合': '',
        '古典機率': '',
        '期望值': '',
        '一維數據分析': '',
        '二維數據分析': '',
        '三角函數的定義': '',
        '正弦與餘弦定理': '',
        '三角測量': '',
        '向量的加減與係數積': '',
        '向量內積': '',
        '面積與行列式': '',
        '空間概念與座標系': '',
        '空間向量內積': '',
        '外積': '',
        '平面方程式': '',
        '空間直線方程式': '',
        '矩陣的加減與乘法': '',
        '克拉瑪公式': '',
        '數列的極限': '',
        '函數的極限': '',
        '微分導函數': '',
        '函數圖形與極值': '',
        '定積分與面積': '',
        '隨機變數': '',
        '常態分配': '',
    },
    '物理': {
        '科學的態度與方法': '',
        '物質的組成（夸克與原子）': '',
        '物體的運動（速度與加速度）': '',
        '四大基本交互作用': '',
        '能量的形式與守恆': '',
        '量子現象（光電效應與波粒二象性）': '',
        '宇宙學簡介': '',
        '直線運動': '',
        '平面運動': '',
        '牛頓運動定律': '',
        '摩擦力與向心力': '',
        '動量與衝量': '',
        '動量守恆與碰撞': '',
        '功與動能': '',
        '位能與能量守恆': '',
        '重力場與重力位能': '',
        '剛體轉動與平衡': '',
        '簡諧運動(SHM)': '',
        '流體的壓力與浮力': '',
        '波動的性質': '',
        '聲波與交互作用': '',
        '幾何光學（反射折射）': '',
        '物理光學（干涉繞射）': '',
        '靜電學': '',
        '電場與電位': '',
        '電流與電路': '',
        '電流磁效應': '',
        '電磁感應': '',
        '交流電': '',
        '近代物理的序幕': '',
        '原子結構與光譜': '',
        '核物理與基本粒子': '',
    },
};

/**
 * 取某一章的例句。
 * @param {string} subject
 * @param {string} chapter
 * @returns {string} 沒填或查無此章時回空字串（呼叫端據此略過，不得拋例外）
 */
function getChapterExample(subject, chapter) {
    const bySubject = CHAPTER_EXAMPLES[subject];
    if (!bySubject) return '';
    const example = bySubject[chapter];
    return typeof example === 'string' ? example : '';
}

/**
 * 還沒填內容的章節清單（給 WS-B 的填寫進度與單元測試用）。
 * @returns {Array<{subject:string, chapter:string}>}
 */
function missingExamples() {
    const missing = [];
    for (const [subject, chapters] of Object.entries(CHAPTERS)) {
        for (const chapter of chapters) {
            if (getChapterExample(subject, chapter).trim() === '') missing.push({ subject, chapter });
        }
    }
    return missing;
}

module.exports = { CHAPTER_EXAMPLES, getChapterExample, missingExamples };
