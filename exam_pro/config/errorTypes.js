// ─────────────────────────────────────────────────────────────
// config/errorTypes.js — 批改錯因白名單（階段 5 WS-A；DEC-015）
//
// 代碼與標籤凍結於 docs/interfaces-stage5.md 第 3.1 條：
//   代碼一旦寫進 attempts.error_types 就是歷史資料，**只能新增，不能改名或刪除**。
//   改名會讓舊的批改紀錄在弱點面板上變成「不認得的代碼」。
//
// 為什麼放 config/ 而不是 DB CHECK（migrations/0010 的設計取捨 2）：
//   做法同 config/chapters.js 的章節白名單——白名單會長，改一次不該需要一支 migration；
//   合法性由伺服器端驗證（PATCH /api/papers/:id/results），前端的 chip 清單也從
//   GET /api/error-types 讀這一份，不在前端另抄一份會走鐘的清單。
//
// subjects 為 null 表示全部科目適用；非 null 時只有列出的科目能用
// （chem_equation 只能標在化學題上）。
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ErrorType
 * @property {string} code            寫進 attempts.error_types 的代碼（凍結）
 * @property {string} label           顯示用中文標籤
 * @property {string[]|null} subjects 適用科目；null＝全部
 */

/** @type {ReadonlyArray<Readonly<ErrorType>>} 順序即前端 chip 的顯示順序 */
const ERROR_TYPES = Object.freeze([
    { code: 'concept', label: '觀念不清', subjects: null },
    { code: 'method', label: '方法選錯', subjects: null },
    { code: 'calc', label: '計算錯誤', subjects: null },
    { code: 'reading', label: '審題錯誤', subjects: null },
    { code: 'unit', label: '單位或有效數字', subjects: null },
    { code: 'formula', label: '公式記錯', subjects: null },
    { code: 'careless', label: '粗心抄錯', subjects: null },
    { code: 'blank', label: '未作答', subjects: null },
    { code: 'time', label: '時間不足', subjects: null },
    { code: 'chem_equation', label: '化學式或係數', subjects: Object.freeze(['化學']) }
].map(t => Object.freeze(t)));

/** @type {ReadonlyArray<string>} 全部代碼（順序同 ERROR_TYPES） */
const ERROR_TYPE_CODES = Object.freeze(ERROR_TYPES.map(t => t.code));

/** 一筆作答最多標幾個錯因（第 4.1 條第 1 項）。 */
const MAX_ERROR_TYPES = 5;

const BY_CODE = new Map(ERROR_TYPES.map(t => [t.code, t]));

/**
 * 代碼是否合法；有給 subject 時一併檢查「這一科能不能用」。
 *
 * @param {any} code
 * @param {string} [subject] 題目的科目；省略（undefined／null）時只檢查代碼本身
 * @returns {boolean}
 */
function isValidErrorType(code, subject) {
    if (typeof code !== 'string') return false;
    const t = BY_CODE.get(code);
    if (!t) return false;
    if (subject === undefined || subject === null) return true;
    return t.subjects === null || t.subjects.includes(subject);
}

/**
 * 代碼 → 中文標籤。不認得的代碼回 null（不猜、不把代碼本身當標籤，
 * 否則資料庫裡出現白名單外的值時，畫面上看起來會像是正常的錯因）。
 *
 * @param {string} code
 * @returns {string|null}
 */
function labelOf(code) {
    const t = BY_CODE.get(code);
    return t ? t.label : null;
}

module.exports = { ERROR_TYPES, ERROR_TYPE_CODES, MAX_ERROR_TYPES, isValidErrorType, labelOf };
