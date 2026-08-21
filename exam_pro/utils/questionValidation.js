// ─────────────────────────────────────────────────────────────
// utils/questionValidation.js — 題目欄位的共同閘門（擁有者：WS-A）
//
// 從 controllers/questionController.js 原封不動抽出來的 validateQuestionFields，
// **行為一字不改**：既有的 `PUT /api/questions/:id` 與整合測試是契約。
//
// 為什麼要抽出來：管線的 save 節點（interfaces-stage2.md 第 3.3 條）與
// `POST /api/review/:jqId/approve`（第 6.6 條「人也要過閘門」）都要跑同一道驗證。
// 留在 controller 裡當模組私有函式，就會變成兩份會慢慢走鐘的真相。
//
// ⚠ 回傳形狀的兩個鍵（介面衝突，已記在 docs/questions2-wsA.md 第 1 條）：
//   interfaces-stage2.md 第 4.5 條把簽名凍結成 `{ok, errors: string[], value?}`，
//   但同一條又要求「行為一字不改」，而現況回的是 `{ok, error: string}`（單數字串）。
//   在開發者裁決前，兩個鍵**同時**提供，兩邊都不會壞：
//     error  —— 現況的單數字串，questionController 的既有呼叫點原樣可用
//     errors —— 第 4.5／6.6 條要的陣列形式，approve 直接把它放進回應的 errors
//   驗證規則、判斷順序與訊息文字完全沒動，只是把同一則訊息也包成長度 1 的陣列。
// ─────────────────────────────────────────────────────────────
const {
    isValidSubject, isValidChapter, isValidQuestionType, normalizeDifficulty, QUESTION_TYPES
} = require('../config/chapters');

/**
 * 驗證並正規化題目欄位（手動新增、編輯、管線 save、人工複核 approve 共用）。
 *
 * @param {object} body 題目欄位（HTTP body 或 payload 彙整後的結果）
 * @returns {{ok:boolean, error?:string, errors:string[], value?:object}}
 *          ok=true  → { ok:true, errors:[], value:{subject, chapter, question_type,
 *                       difficulty, question_text, answer_text} }（difficulty 已轉 int、chapter 已 trim）
 *          ok=false → { ok:false, error:'…', errors:['…'] }，訊息文字與原本逐字相同
 */
function validateQuestionFields(body) {
    const subject = body.subject;
    const chapter = (body.chapter || '').trim();
    const question_text = (body.question_text || '').trim();
    const answer_text = (body.answer_text || '').trim();
    const question_type = body.question_type || '填空';
    const difficulty = normalizeDifficulty(body.difficulty ?? 3);

    if (!subject || !chapter || !question_text) return fail('學科、章節、題目內容皆為必填！');
    if (!isValidSubject(subject)) return fail('學科僅能為「數學」或「物理」！');
    if (!isValidChapter(subject, chapter)) return fail(`章節「${chapter}」不在 ${subject} 的精細章節白名單中！`);
    if (!isValidQuestionType(question_type)) return fail(`題型僅能為：${QUESTION_TYPES.join('、')}`);
    if (difficulty === null) return fail('難度必須為 1 到 5 的整數！');

    return { ok: true, errors: [], value: { subject, chapter, question_type, difficulty, question_text, answer_text } };
}

/** 單一訊息同時以 error（現況）與 errors（第 4.5 條）兩種形狀回傳。 */
function fail(message) {
    return { ok: false, error: message, errors: [message] };
}

module.exports = { validateQuestionFields };
