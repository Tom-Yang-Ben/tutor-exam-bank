// ─────────────────────────────────────────────────────────────
// config/remedialErrorStrategy.js — 補救卷「依錯因出題」的對照表與判斷（純函式；docs/remedial.md 第 9 節）
//
// 補救卷原本只看「哪個單位弱」（Wilson 下界），不看「錯在哪裡」。批改時老師標的錯因
// （attempts.error_types，白名單 config/errorTypes.js）其實說明了該怎麼補：觀念不清該先回到基本題，
// 計算錯誤該多算幾題，審題錯誤該多讀長題目。本檔把「錯因 → 補救組的選題調整」寫成一張表。
//
// 〔預設，待 Owner 確認〕下表每一列的策略與理由都是工程端提的預設值，Owner 看過才算定案；
// 改的時候只改這張表（與 docs/remedial.md 第 9.2 節的表），選題程式不必動。
//
// 用法（services/remedialService.js）：
//   1. 只看補救組（remedial bucket）的每個目標單位。數的是該生在這個單位、同一個時間窗裡
//      **第一次作答**（檢視 attempts，R10）且答錯或部分給分（正確度 COALESCE(score, result) < 1）的題。
//   2. 證據夠才用主因（dominantErrorType）：有標錯因的錯題 ≥ MIN_TAGGED_WRONG，而且最多的那一種錯因
//      占全部錯因標記 ≥ MIN_DOMINANT_SHARE；同票第一名不算有主因。證據不夠時選題與沒有這個功能時完全相同。
//   3. 策略只有三種旋鈕：
//        difficulty_ceiling_delta  難度上限調幾級（-1 或 0；下限 1）。這是**硬條件**，但抽不滿時退回原本的上限
//                                  （由 examController.pickByQuotas 的 fallbackPool 處理，草稿 notes 會說明）。
//        prefer_types              優先的題型（排在前面，**不是**篩選：沒有這種題型照樣抽別的）。
//        prefer_order              同題型內的偏好順序：'text_length_desc'（題幹長的先）、'difficulty_asc'（簡單的先）、
//                                  'chem_equation'（題幹有反應式的先）；null＝不排（照原本的隨機）。
//      「偏好」一律做成候選池內的排序（preferenceKey），抽不到偏好的題就抽別的，不會因此少出題。
//
// 純函式：無 I/O、無時間、無隨機、不讀 process.env。由 test/unit/remedialErrorStrategy.test.js 釘住。
// ─────────────────────────────────────────────────────────────
const { ERROR_TYPE_CODES, labelOf } = require('./errorTypes');

/** 主因至少要有幾筆「有標錯因的錯題」才算數（一筆不夠判斷習慣）。 */
const MIN_TAGGED_WRONG = 2;
/** 主因的錯因標記至少要占全部標記的比例。 */
const MIN_DOMINANT_SHARE = 0.4;

/** 題型偏好的兩組（題型名稱同 config/chapters.js 的 QUESTION_TYPES）。 */
const CONCEPT_CHECK_TYPES = Object.freeze(['單選', '多選', '填空']);
const PRACTICE_TYPES = Object.freeze(['計算', '填空']);

/** prefer_order 的合法值。 */
const PREFER_ORDERS = Object.freeze(['text_length_desc', 'difficulty_asc', 'chem_equation']);

/**
 * 題幹裡「有化學反應式」的判斷：箭頭（→、⟶、⇌）、LaTeX 箭頭（\rightarrow、\longrightarrow、\xrightarrow、
 * \rightleftharpoons）、mhchem 的 \ce{… -> …}，或題幹直接寫「反應式」。
 */
const CHEM_EQUATION_RE = /→|⟶|⇌|\\(?:long|x)?rightarrow|\\rightleftharpoons|\\ce\{[^}]*->|反應式/;

/**
 * @typedef {object} ErrorStrategy
 * @property {string} code                     錯因代碼（同 config/errorTypes.js）
 * @property {string} label                    中文標籤（同 config/errorTypes.js 的 labelOf，不另抄一份）
 * @property {-1|0} difficulty_ceiling_delta   難度上限調幾級
 * @property {string[]|null} prefer_types      優先的題型；null＝不偏好題型
 * @property {string|null} prefer_order        同題型內的偏好順序（PREFER_ORDERS 之一）；null＝不排
 * @property {string[]|null} subjects          適用科目；null＝全部（chem_equation 只對化學）
 * @property {string} summary                  給老師看的一句「怎麼調」（草稿上顯示）
 * @property {string} rationale                給老師看的一句「為什麼」（草稿上顯示）
 */

/** 〔預設，待 Owner 確認〕錯因 → 補救組選題策略。順序同 config/errorTypes.js 的 ERROR_TYPES。 */
const RAW = [
    { code: 'concept', difficulty_ceiling_delta: -1, prefer_types: CONCEPT_CHECK_TYPES, prefer_order: null,
        summary: '難度上限降一級，優先單選／多選／填空',
        rationale: '觀念還沒建立時，先用短的觀念檢查題確認他懂了，再回到難題。' },
    { code: 'method', difficulty_ceiling_delta: 0, prefer_types: Object.freeze(['計算']), prefer_order: null,
        summary: '難度不變，優先計算題',
        rationale: '方法選錯要在完整的解題過程裡練「該用哪一招」，計算題最看得出來。' },
    { code: 'calc', difficulty_ceiling_delta: 0, prefer_types: PRACTICE_TYPES, prefer_order: null,
        summary: '難度不變，優先計算／填空題',
        rationale: '計算錯誤靠練習量改善，多給要算到底的題。' },
    { code: 'reading', difficulty_ceiling_delta: 0, prefer_types: null, prefer_order: 'text_length_desc',
        summary: '難度不變，優先題幹較長的題',
        rationale: '審題錯誤要練讀長題目、抓條件，題幹長的題先出。' },
    { code: 'unit', difficulty_ceiling_delta: 0, prefer_types: PRACTICE_TYPES, prefer_order: null,
        summary: '難度不變，優先計算／填空題',
        rationale: '單位與有效數字要在實際算出數值的題裡練。' },
    { code: 'formula', difficulty_ceiling_delta: -1, prefer_types: CONCEPT_CHECK_TYPES, prefer_order: null,
        summary: '難度上限降一級，優先單選／多選／填空',
        rationale: '公式記錯先用直接套公式的基本題把公式記牢。' },
    { code: 'careless', difficulty_ceiling_delta: 0, prefer_types: PRACTICE_TYPES, prefer_order: null,
        summary: '難度不變，優先計算／填空題',
        rationale: '粗心靠練習量與檢查習慣改善，多給要寫出答案的題。' },
    { code: 'blank', difficulty_ceiling_delta: -1, prefer_types: null, prefer_order: 'difficulty_asc',
        summary: '難度上限降一級，簡單的題先出',
        rationale: '空白通常是不知道從哪裡下手，先給做得出來的題建立信心與起手式。' },
    { code: 'time', difficulty_ceiling_delta: -1, prefer_types: null, prefer_order: 'difficulty_asc',
        summary: '難度上限降一級，簡單的題先出',
        rationale: '時間不夠先練基本題的速度，再拉難度。' },
    { code: 'chem_equation', difficulty_ceiling_delta: 0, prefer_types: null, prefer_order: 'chem_equation',
        subjects: Object.freeze(['化學']),
        summary: '難度不變，優先題幹有反應式的化學題',
        rationale: '化學式或係數出錯，要多寫、多配平反應式。' }
];

/** @type {Readonly<Record<string, Readonly<ErrorStrategy>>>} */
const ERROR_STRATEGIES = Object.freeze(Object.fromEntries(RAW.map(s => [s.code, Object.freeze({
    code: s.code,
    label: labelOf(s.code),
    difficulty_ceiling_delta: s.difficulty_ceiling_delta,
    prefer_types: s.prefer_types,
    prefer_order: s.prefer_order,
    subjects: s.subjects || null,
    summary: s.summary,
    rationale: s.rationale
})])));

/** 四捨五入到小數第 4 位（同 kcWeaknessService.round4，這裡不 require 服務層）。 */
function round4(x) {
    return Math.round(Number(x) * 10000) / 10000;
}

/**
 * 錯題列 → 每個單位的錯因統計（純函式）。
 *
 * 輸入是「該生在時間窗內、第一次作答、答錯或部分給分」的每一筆（kc 基底時一筆作答掛幾個知識點就出現幾列）。
 * 只數白名單內的代碼；同一筆作答重複標同一個代碼只算一次；白名單外的代碼忽略（不猜）。
 * 「有標錯因的錯題」＝至少有一個白名單代碼的那一筆。
 *
 * @param {Array<{unit:string|number, error_types:string[]|null}>} rows
 * @returns {Map<string|number, {wrong:number, tagged_wrong:number, counts:Record<string, number>}>}
 */
function errorProfileFromRows(rows) {
    const out = new Map();
    for (const r of rows || []) {
        if (!out.has(r.unit)) out.set(r.unit, { wrong: 0, tagged_wrong: 0, counts: {} });
        const p = out.get(r.unit);
        p.wrong++;
        const codes = [...new Set(Array.isArray(r.error_types) ? r.error_types : [])].filter(c => ERROR_TYPE_CODES.includes(c));
        if (codes.length === 0) continue;
        p.tagged_wrong++;
        for (const c of codes) p.counts[c] = (p.counts[c] || 0) + 1;
    }
    return out;
}

/**
 * 一個單位的主因（純函式）。
 *
 * - 沒有任何有標錯因的錯題 → null（「沒標」不是「沒有主因」：草稿不提錯因，與沒有這個功能時相同）。
 * - 有標，但下列任一種 → applied:false，選題不調整：
 *     insufficient_evidence  有標錯因的錯題 < MIN_TAGGED_WRONG
 *     no_dominant            第一名占全部標記 < MIN_DOMINANT_SHARE
 *     tie                    第一名同票（例：觀念 2、計算 2）——說不出哪一個是主因
 *     not_applicable         主因的策略不適用這一科（chem_equation 只對化學）
 * - 否則 applied:true、reason 'dominant'。
 *
 * share＝第一名次數 ÷ 全部錯因標記數（一筆錯題可標多個，所以分母是標記數，不是錯題數）。
 * 同票時 type 取 config/errorTypes.js 順序在前的那個（只為了回報穩定，不會套用）。
 *
 * @param {{wrong:number, tagged_wrong:number, counts:Record<string, number>}|null|undefined} profile
 * @param {string} subject
 * @returns {null | {type:string, label:string, count:number, share:number, tagged_wrong:number,
 *                   applied:boolean, reason:string}}
 */
function dominantErrorType(profile, subject) {
    if (!profile || !(profile.tagged_wrong > 0)) return null;
    const entries = Object.entries(profile.counts || {})
        .filter(([code, n]) => ERROR_TYPE_CODES.includes(code) && n > 0)
        .sort((a, b) => (b[1] - a[1]) || (ERROR_TYPE_CODES.indexOf(a[0]) - ERROR_TYPE_CODES.indexOf(b[0])));
    if (entries.length === 0) return null;
    const totalTags = entries.reduce((s, [, n]) => s + n, 0);
    const [type, count] = entries[0];
    const share = round4(count / totalTags);
    let reason = 'dominant';
    if (profile.tagged_wrong < MIN_TAGGED_WRONG) reason = 'insufficient_evidence';
    else if (count / totalTags < MIN_DOMINANT_SHARE) reason = 'no_dominant';
    else if (entries.length > 1 && entries[1][1] === count) reason = 'tie';
    else if (!strategyApplies(type, subject)) reason = 'not_applicable';
    return { type, label: labelOf(type), count, share, tagged_wrong: profile.tagged_wrong, applied: reason === 'dominant', reason };
}

/**
 * 這個錯因的策略適不適用這一科。
 * @param {string} code
 * @param {string} subject
 * @returns {boolean}
 */
function strategyApplies(code, subject) {
    const s = ERROR_STRATEGIES[code];
    if (!s) return false;
    return s.subjects === null || s.subjects.includes(subject);
}

/**
 * 套用策略後的難度上限（純函式）。原本不限（null）時不動；下限 1。
 * @param {number|null} difficultyMax 原本的上限
 * @param {ErrorStrategy} strategy
 * @returns {number|null}
 */
function adjustedDifficultyMax(difficultyMax, strategy) {
    if (difficultyMax === null || difficultyMax === undefined) return difficultyMax ?? null;
    const delta = strategy && strategy.difficulty_ceiling_delta ? strategy.difficulty_ceiling_delta : 0;
    return Math.max(1, difficultyMax + delta);
}

/**
 * 題幹有沒有化學反應式。
 * @param {string|null} text
 * @returns {boolean}
 */
function hasChemEquation(text) {
    return CHEM_EQUATION_RE.test(String(text ?? ''));
}

/**
 * 一題在這個策略下的偏好鍵（純函式；陣列，逐項由小到大比，小的排前面）。
 *   [0] 題型：在 prefer_types 裡為 0，否則 1（沒有 prefer_types 時恆為 0）
 *   [1] 順序：text_length_desc＝−題幹長度（壓掉空白後的字數）；difficulty_asc＝難度（缺值當 3）；
 *       chem_equation＝有反應式 0、沒有 1；沒有 prefer_order 時恆為 0
 * 相同的鍵維持原本的隨機順序（呼叫端用穩定排序）。
 *
 * @param {ErrorStrategy} strategy
 * @param {{question_type?:string|null, question_text?:string|null, difficulty?:number|null}} q
 * @returns {number[]}
 */
function preferenceKey(strategy, q) {
    const typeRank = strategy.prefer_types ? (strategy.prefer_types.includes(q.question_type) ? 0 : 1) : 0;
    let orderRank = 0;
    if (strategy.prefer_order === 'text_length_desc') {
        orderRank = -String(q.question_text ?? '').replace(/\s+/g, '').length;
    } else if (strategy.prefer_order === 'difficulty_asc') {
        const d = q.difficulty === null || q.difficulty === undefined ? NaN : Number(q.difficulty);
        orderRank = Number.isFinite(d) ? d : 3;
    } else if (strategy.prefer_order === 'chem_equation') {
        orderRank = hasChemEquation(q.question_text) ? 0 : 1;
    }
    return [typeRank, orderRank];
}

/**
 * 偏好鍵的比較（逐項；長度不同時較短的在前）。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function compareKeys(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}

/**
 * 草稿上的策略物件（error_focus.strategy；純函式）。
 * @param {ErrorStrategy} s
 * @returns {{difficulty_ceiling_delta:number, prefer_types:string[]|null, prefer_order:string|null, summary:string, rationale:string}}
 */
function strategyView(s) {
    return {
        difficulty_ceiling_delta: s.difficulty_ceiling_delta,
        prefer_types: s.prefer_types ? [...s.prefer_types] : null,
        prefer_order: s.prefer_order,
        summary: s.summary,
        rationale: s.rationale
    };
}

module.exports = {
    MIN_TAGGED_WRONG,
    MIN_DOMINANT_SHARE,
    PREFER_ORDERS,
    CHEM_EQUATION_RE,
    ERROR_STRATEGIES,
    errorProfileFromRows,
    dominantErrorType,
    strategyApplies,
    adjustedDifficultyMax,
    hasChemEquation,
    preferenceKey,
    compareKeys,
    strategyView
};
