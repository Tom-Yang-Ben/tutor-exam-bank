// ─────────────────────────────────────────────────────────────
// followUpPaperCheck.js — 確認出卷時伺服器端檢查承上題是否整組（〔Owner 決策單 2026-09-25 B7〕）
//
// 背景：裁決 S5-28 原本只靠前端把關（組卷預覽整組抽、補救卷草稿整組刪／整組加、確認前擋缺前題的
// 承上題），POST /api/confirm-paper 照給的題出卷；直接呼叫 API 自行拼題仍可出半組。Owner 在決策單
// 選「伺服器端也要檢查」，這裡是那一道檢查的純函式部分（查詢在 controllers/examController.js）。
//
// 「整組」的定義沿用資料模型與組卷的同一條規則（utils/paperGroups.js、docs/interfaces-stage1.md 第 7 條）：
//   follows_question_id 的**無向連通分量**＝一組（前題＋所有承接它的題，可多層鏈、可分岔）；
//   沒有綁定的題自成一組，不在檢查範圍。卷裡只要有某組的任何一題，那一組的**每一題**都要在卷裡。
//
// 不在卷裡的成員依與前端相同的規則標原因（public/js/remedial.js 的 planManualAdd、
// utils/paperGroups.js 的 pickPaperUnits「組內任一題不可用，整組不抽」）：
//   archived      已封存——封存題不能出（confirm-paper 對卷內封存題本來就回 400），
//                 所以組裡有封存題的組整組都不能出，只能整組刪；與前端「組內有封存的題就不加」一致。
//   answered      該生已寫過（attempts 已有紀錄）——同理不能再出，只能整組刪。
//   not_in_paper  其他：題目可以出，只是沒放進這張卷（加回來就好）。
//   同時封存又寫過時標 archived（先講「不能出」最根本的原因）。
//
// 順序不在這裡檢查：confirm-paper 一律用 sortForPaperGrouped 重排（組內依承接順序相鄰），
// 呼叫端給的順序本來就不影響出題順序（草稿順序≠出卷順序，前端 draftQuestionIds 也是這樣說明），
// 所以「順序被拆開」的 payload 由伺服器排好、不回 400。只要整組都在，排好之後必然相鄰且依序。
//
// 「缺前題」的承上題（題幹有「承上題」但 follows_question_id 為 NULL，舊資料）沒有綁定，自成一組，
// 與 pickPaperUnits 一樣照常可出；伺服器不從題幹猜前題。
//
// 純函式：無 I/O、不讀 process.env。訊息只放題目 id，不放學生姓名（「該生」）。
// ─────────────────────────────────────────────────────────────
const { groupFollowUps } = require('./paperGroups');

/** 缺題原因 → 訊息裡的括號註記（not_in_paper 不加註記）。 */
const MISSING_REASON_LABEL = Object.freeze({ archived: '已封存', answered: '該生已寫過', not_in_paper: null });

/**
 * 一題不在卷裡的原因。
 * @param {{archived?:boolean, answered?:boolean}|undefined} row
 * @returns {'archived'|'answered'|'not_in_paper'}
 */
function missingReason(row) {
    if (row && row.archived) return 'archived';
    if (row && row.answered) return 'answered';
    return 'not_in_paper';
}

/**
 * 找出卷裡「只放了一部分」的承上題組。
 *
 * @param {number[]} paperIds 呼叫端要出的題（順序不影響結果）
 * @param {Array<{id:number, follows_question_id:number|null, archived?:boolean, answered?:boolean}>} rows
 *        卷裡的題＋它們所在承上組的**全部**成員（含封存、該生已寫過、不在卷裡的題）；
 *        examController 用 remedialService.buildItemLookupQuery 查（與前端手動加題同一段查詢）。
 *        只看 rows 裡的邊：rows 必須包含完整的連通分量，否則缺的成員會被當成不存在。
 * @returns {Array<{group_ids:number[], missing:Array<{question_id:number, reason:'archived'|'answered'|'not_in_paper'}>}>}
 *   group_ids 整組成員（承接順序：組首 → 承上題深度優先，同一前題的多個承上題依 id 由小到大）
 *   missing   不在卷裡的成員（依 group_ids 的順序）
 *   組與組之間依組首 id 由小到大（決定性，不受 SQL 回傳順序影響）；全部完整時回空陣列。
 */
function findIncompleteFollowUpGroups(paperIds, rows) {
    const inPaper = new Set(paperIds);
    const byId = new Map(rows.map(r => [r.id, r]));
    const out = [];
    for (const group of groupFollowUps(rows)) {
        if (group.length < 2) continue;                               // 沒有綁定的題自成一組，不檢查
        if (!group.some(id => inPaper.has(id))) continue;             // 這一組根本不在卷裡
        const missing = group
            .filter(id => !inPaper.has(id))
            .map(id => ({ question_id: id, reason: missingReason(byId.get(id)) }));
        if (missing.length > 0) out.push({ group_ids: group, missing });
    }
    return out.sort((a, b) => a.group_ids[0] - b.group_ids[0]);
}

/**
 * 400 的繁體中文訊息：逐組列出「哪一組缺了哪幾題」（題目 id），不含學生姓名。
 * 缺的題裡有已封存或該生已寫過的（加不回來）時，多提醒一句只能整組刪。
 *
 * @param {ReturnType<typeof findIncompleteFollowUpGroups>} groups 非空
 * @returns {string}
 */
function incompleteFollowUpGroupsMessage(groups) {
    const idList = ids => ids.map(id => `#${id}`).join('、');
    const parts = groups.map(g => `承上題組（${idList(g.group_ids)}）缺 `
        + g.missing.map(m => {
            const label = MISSING_REASON_LABEL[m.reason];
            return label ? `#${m.question_id}（${label}）` : `#${m.question_id}`;
        }).join('、'));
    const blocked = groups.some(g => g.missing.some(m => m.reason !== 'not_in_paper'));
    return `承上題必須與前題整組出卷，以下題組不完整：${parts.join('；')}。`
        + (blocked
            ? '請把缺的題加回卷裡，或把整組刪掉後再確認；已封存或該生已寫過的題不能出，含這種題的組只能整組刪。'
            : '請把缺的題加回卷裡，或把整組刪掉後再確認。');
}

module.exports = { findIncompleteFollowUpGroups, incompleteFollowUpGroupsMessage, missingReason, MISSING_REASON_LABEL };
