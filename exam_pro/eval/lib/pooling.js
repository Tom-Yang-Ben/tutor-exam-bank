// ─────────────────────────────────────────────────────────────
// eval/lib/pooling.js — LIKE 基準欄的關鍵字規則（凍結）＋ golden 候選池 pooling
//
// 兩件事都刻意放在同一支，因為它們都是「不可以在 PR 裡順手調整」的東西：
//
// 1) LIKE 欄的關鍵字規則（規劃 §5.3.3 最後一段）
//    LIKE 欄是 hybrid 的對照組。只要有人「順手把關鍵字從 3 個調成 5 個」，
//    hybrid 的相對優勢就可以被憑空製造出來——所以規則寫死在這裡，改它要改本檔並在 PR 說明。
//    規則：該題 embed_text **去章節**後 tokenize，取前 3 個長度 ≥ 2 的詞，各自 LIKE '%詞%' 取 OR，
//    對應 controllers/questionController.js 現行的 question_text LIKE '%q%' 寫法。
//
//    兩個必須寫明的判讀（原文只有一句話，實作要落地就得補死）：
//    - 「去章節」= 去掉 embed_text 的**第 1 行**。interfaces 第 3 條把第 1 行定為
//      「${subject}｜${chapter}｜${question_type}｜難度${difficulty}」的中繼行，章節就在其中；
//      只挖掉章節字串會留下學科與題型，那些同樣是中繼資料、不是題幹，留著只會讓每題的
//      前 3 個詞都變成「數學」「填空」而彼此無法區辨。
//    - 「前 3 個」在**去重後**計算。同一個詞 OR 兩次不會多召回任何一題，
//      只會白白吃掉一個關鍵字額度。
//
// 2) golden 候選池 pooling（規劃 §5.3.2）
//    每個 query 取「向量近鄰前 20 ∪ 關鍵字前 10 ∪ 同章隨機 5」再人工判定。
//    只靠單一系統建池會系統性低估其他系統的 recall，讓「hybrid 比 LIKE 好」變成自證。
//    同章隨機用固定種子的 mulberry32——沒有種子的話，重跑一次候選池就換一批，
//    人工標好的判定會對不上，golden 等於每次重來。
// ─────────────────────────────────────────────────────────────

const { tokenize } = require('./tokenize');
const { buildEmbedText } = require('./embedText');

// ───── 凍結常數：改這三個數字等於改變 LIKE 欄的定義 ─────
const LIKE_KEYWORD_COUNT = 3;   // 取幾個關鍵字
const LIKE_MIN_TOKEN_LEN = 2;   // 詞長下限
const POOL_VECTOR_TOP = 20;     // 候選池：向量近鄰
const POOL_KEYWORD_TOP = 10;    // 候選池：關鍵字
const POOL_RANDOM_SAME_CHAPTER = 5; // 候選池：同章隨機
const POOL_SEED = 20260821;     // 同章隨機的固定種子

/**
 * 去掉 embed_text 的第 1 行（學科｜章節｜題型｜難度 的中繼行）。
 * 只有一行時回空字串——沒有題幹就沒有關鍵字，不去猜。
 * @param {string} embedText
 * @returns {string}
 */
function stripMetaLine(embedText) {
    const lines = String(embedText || '').split('\n');
    return lines.length > 1 ? lines.slice(1).join('\n') : '';
}

/**
 * LIKE 欄的關鍵字（凍結規則）。
 * @param {object} question fixture 題目
 * @returns {string[]} 最多 3 個、長度 ≥ 2、已去重的詞
 */
function likeKeywords(question) {
    const body = stripMetaLine(buildEmbedText(question));
    const picked = [];
    for (const t of tokenize(body)) {
        if (!t || t.length < LIKE_MIN_TOKEN_LEN) continue;
        if (picked.includes(t)) continue;
        picked.push(t);
        if (picked.length >= LIKE_KEYWORD_COUNT) break;
    }
    return picked;
}

/**
 * mulberry32：與 utils/shuffle.js 的測試用同一支 PRNG，固定種子即可重現。
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 建候選池：向量近鄰 ∪ 關鍵字 ∪ 同章隨機。
 * 三個來源都可缺席（例如向量檔還沒錄），缺席時只是池子小一點，不報錯。
 *
 * @param {object} opts
 * @param {object} opts.query        query 題目物件
 * @param {Array<object>} opts.questions 全部候選題（含 query 本身，會被排除）
 * @param {(id:number)=>number[]|null} [opts.vectorNeighbours] 給 id 回向量近鄰 id（已排序）
 * @param {(id:number)=>number[]} [opts.keywordHits] 給 id 回關鍵字命中 id（已排序）
 * @returns {Array<{id:number, sources:string[]}>} 依 id 升冪
 */
function buildPool(opts) {
    const { query, questions } = opts;
    const sources = new Map(); // id → Set<source>
    const add = (id, src) => {
        if (id === query.id) return;                 // --exclude-self：query 題本身永不進池
        if (!sources.has(id)) sources.set(id, new Set());
        sources.get(id).add(src);
    };

    if (opts.vectorNeighbours) {
        const nb = opts.vectorNeighbours(query.id) || [];
        nb.slice(0, POOL_VECTOR_TOP).forEach(id => add(id, 'vector'));
    }
    if (opts.keywordHits) {
        const kw = opts.keywordHits(query.id) || [];
        kw.slice(0, POOL_KEYWORD_TOP).forEach(id => add(id, 'keyword'));
    }

    // 同章隨機：種子綁進 query.id，同一題永遠抽到同一批，不同題彼此獨立
    const sameChapter = questions
        .filter(q => q.id !== query.id && q.subject === query.subject && q.chapter === query.chapter)
        .map(q => q.id)
        .sort((a, b) => a - b);
    const rnd = mulberry32(POOL_SEED + query.id);
    const picked = sameChapter.slice();
    for (let i = picked.length - 1; i > 0; i--) {          // Fisher-Yates，與 utils/shuffle.js 同法
        const j = Math.floor(rnd() * (i + 1));
        [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    picked.slice(0, POOL_RANDOM_SAME_CHAPTER).forEach(id => add(id, 'same_chapter_random'));

    return [...sources.entries()]
        .map(([id, set]) => ({ id, sources: [...set].sort() }))
        .sort((a, b) => a.id - b.id);
}

module.exports = {
    likeKeywords,
    stripMetaLine,
    buildPool,
    mulberry32,
    LIKE_KEYWORD_COUNT,
    LIKE_MIN_TOKEN_LEN,
    POOL_VECTOR_TOP,
    POOL_KEYWORD_TOP,
    POOL_RANDOM_SAME_CHAPTER,
    POOL_SEED
};
