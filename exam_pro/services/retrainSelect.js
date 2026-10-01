// ─────────────────────────────────────────────────────────────
// services/retrainSelect.js — 出卷時挑到期的重練題（PR-3 出卷整合；docs/retrain-and-review.md 第 4.7、5.2 節）
//
// 三條產生草稿的路共用這一支（只讀，不寫庫）：
//   API-5  POST /api/students/:id/retrain-paper           一份純重練卷（buildRetrainDraft）
//   API-6  POST /api/generate-paper 的 retrain: { count }  附在新卷（selectForAttach＋mergeForPaper）
//   API-8  POST /api/students/:id/remedial-paper 的 retrain_count  補救卷多一組 bucket = 'retrain'（appendRetrainBucket）
// 寫入（確認出卷）走 controllers/examController.js 的 writePaper → services/retrainService.js 的 insertRetrainAssignments。
//
// 規則（〔R*〕＝Owner 決策單 2026-09-26 第三輪的題號）：
//   - 到期清單與排序用 PR-2 的 retrainService.listDueUnits（第 4.7 節：逾期多的先 → 關卡小的先 → 錯次數多的先 → 題號小的先；
//     承上組以組為單位、依組內最急的一題排）。整組不能出（組內有題移出、封存、已派出、不在清單）的組在 blocked，不會挑到。
//   - 〔R12 選 2〕依排序逐組放入，承上組不拆開；放到某一組時剩下的名額不夠整組 → 整個請求 400、不產生草稿，
//     訊息列出那一組的題號，並提示可以改成的題數（放到前一組為止的題數，或含這一組的題數；pickUnits）。
//     剩下的名額剛好是 0 就停（沒挑到的留在到期清單，下次優先）。
//   - 〔R8 選 1〕重練題不佔變式家族名額：這裡完全不看 variant_of，新題照既有流程抽（家族互斥只在新題之間），
//     兩者合併後用 sortForPaper 一起依題型、難度排（〔R7 選 1〕卷面不另分區）。
//   - 〔R9 選 1〕重練題就是原題。
//   - 老師在組卷預覽上「移除這題」的重練題會放進 exclude_ids；含這些題的組整組略過（不報錯、不算數）。
//
// 純函式（pickUnits、r12Message、unitsFromViews、mergeForPaper、draftNotes…）不碰 DB，由 test/unit/retrainSelect.test.js 釘住
// （TC-039-1）；I/O（selectRetrain、buildRetrainDraft、appendRetrainBucket）由 test/integration/retrainPaper.pg.test.js 驗。
// 個資：本檔不讀、不回學生姓名（純重練卷的卷名在確認時由 examController 產生），不寫 log，不呼叫任何 LLM。
// ─────────────────────────────────────────────────────────────
'use strict';

const { MAX_PAPER_QUESTIONS } = require('../config/retrain');
const retrainService = require('./retrainService');
const { previewText } = require('./remedialService');
const { sortForPaperGrouped } = require('../utils/paperGroups');

/** API-5 的題數預設（第 5.2 節：count 1–50，預設 10）。 */
const DEFAULT_PAPER_COUNT = 10;
/** API-8 的 retrain_count 上限（第 5.2 節：0–20）。 */
const MAX_REMEDIAL_RETRAIN = 20;

/** 補救卷裡「到期重練」那一組的 target（blueprint、shortfalls、items 共用）。 */
const RETRAIN_TARGET = Object.freeze({ type: 'retrain', name: '到期重練' });

/** blocked 的原因 → 草稿附註裡的說明。 */
const BLOCKED_REASON_LABEL = Object.freeze({
    not_in_schedule: '組內有題不在重練清單',
    retired: '組內有題已移出清單',
    archived: '組內有題已封存',
    in_flight: '組內有題已派到還沒批改的卷'
});

// ───────────────────────── 純函式 ─────────────────────────

/**
 * 〔R12 選 2〕承上組放不下時的 400 訊息（第 4.7 節的例子）。
 *   「到期的承上題組（題 812、813、814）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 5 或 8。」
 * 建議題數：放到前一組為止的題數（placed，> 0 才列）、含這一組的題數（placed＋size，≤ maxCount 才列）；
 * 兩個都不能用時只說「請調整重練題數」。
 *
 * @param {{groupIds:number[], placed:number, remaining:number, maxCount:number}} p
 * @returns {{message:string, suggest:number[]}}
 */
function r12Message({ groupIds, placed, remaining, maxCount = MAX_PAPER_QUESTIONS }) {
    const size = groupIds.length;
    const suggest = [placed, placed + size].filter(n => Number.isInteger(n) && n > 0 && n <= maxCount);
    const advice = suggest.length ? `請把重練題數改成 ${suggest.join(' 或 ')}` : '請調整重練題數';
    return {
        message: `到期的承上題組（題 ${groupIds.join('、')}）共 ${size} 題，放不進剩下的 ${remaining} 個重練名額；${advice}。`,
        suggest
    };
}

/**
 * 依排序逐組放入（〔R12 選 2〕承上組不拆開、整組放不下就報錯；第 4.7 節）。
 *
 * @param {Array<{group_ids:number[], size?:number, items:Array<{question_id:number}>}>} units 已排序（listDueUnits 的 units）
 * @param {number} count 重練題數上限（非負整數）
 * @param {{excludeIds?:number[], maxCount?:number}} [opts]
 *   excludeIds：含其中任一題的組整組略過（老師在預覽上移除的重練題）；
 *   maxCount：R12 建議「含這一組的題數」不得超過它（新題＋重練 ≤ 50、API-8 ≤ 20）
 * @returns {{picked:object[], ids:number[], got:number} |
 *           {error:{message:string, group_ids:number[], remaining:number, suggest:number[]}}}
 *   ids 依放入順序、組內依承接順序
 */
function pickUnits(units, count, { excludeIds = [], maxCount = MAX_PAPER_QUESTIONS } = {}) {
    const excluded = new Set(excludeIds);
    const picked = [];
    let placed = 0;
    for (const u of units || []) {
        const ids = u.items.map(i => i.question_id);
        if (ids.some(id => excluded.has(id)) || u.group_ids.some(id => excluded.has(id))) continue;
        const remaining = count - placed;
        if (remaining <= 0) break;
        if (ids.length > remaining) {
            const { message, suggest } = r12Message({ groupIds: ids, placed, remaining, maxCount });
            return { error: { message, group_ids: ids, remaining, suggest } };
        }
        picked.push(u);
        placed += ids.length;
    }
    return { picked, ids: picked.flatMap(u => u.items.map(i => i.question_id)), got: placed };
}

/**
 * 從 API-1 的項目畫面資料組出「可以出的單位」（形狀同 retrainService.listDueUnits 的 units／blocked／due_total）。
 * API-5 的 include_not_due 用它：還沒到期、但進行中、沒有已派出、沒封存的題也算「想出」。
 * includeNotDue 為 false 時規則與 listDueUnits 逐條相同（整合測試比對兩者的結果）。
 *
 * @param {object[]} views retrainService.listItems(…, { status: 'all' }).items
 * @param {{includeNotDue?:boolean}} [opts]
 * @returns {{due_total:number, units:object[], blocked:object[]}}
 */
function unitsFromViews(views, { includeNotDue = false } = {}) {
    const byQid = new Map((views || []).map(v => [v.question_id, v]));
    const units = [];
    const blocked = [];
    let dueTotal = 0;
    for (const u of retrainService.orderUnits(views || [])) {
        const due = u.items.filter(v => v.due);
        dueTotal += due.length;
        const wanted = includeNotDue
            ? u.items.filter(v => v.due || (v.status === 'active' && !v.in_flight && !v.archived))
            : due;
        if (!wanted.length) continue;
        const reasons = [];
        const members = [];
        for (const qid of u.group_ids) {
            const v = byQid.get(qid);
            if (!v) { reasons.push({ question_id: qid, reason: 'not_in_schedule' }); continue; }
            if (v.status === 'retired') reasons.push({ question_id: qid, reason: 'retired' });
            else if (v.archived) reasons.push({ question_id: qid, reason: 'archived' });
            else if (v.in_flight) reasons.push({ question_id: qid, reason: 'in_flight' });
            members.push(v);
        }
        if (reasons.length) { blocked.push({ group_ids: u.group_ids, reasons }); continue; }
        units.push({
            group_ids: u.group_ids,
            size: members.length,
            due_count: due.length,
            overdue_days: due.length ? Math.max(...due.map(v => v.overdue_days)) : 0,
            items: members
        });
    }
    return { due_total: dueTotal, units, blocked };
}

/**
 * 新題與重練題合併成一張卷（〔R7 選 1〕不另分區；〔R8 選 1〕不看家族）：每題多 purpose、retrain_step，
 * 再用同一個 sortForPaper 依題型、難度排（承上組相鄰）。同分時新題在前（輸入順序）。
 *
 * @param {object[]} newQuestions 新題（已是 generate-paper 的欄位）
 * @param {object[]} retrainQuestions 重練題（同樣的欄位）
 * @param {Map<number, number>} stepById 重練題 → 當下關卡
 * @param {(qs:object[]) => object[]} [sortFn]
 * @returns {object[]}
 */
function mergeForPaper(newQuestions, retrainQuestions, stepById, sortFn = sortForPaperGrouped) {
    return sortFn([
        ...newQuestions.map(q => ({ ...q, purpose: 'new', retrain_step: null })),
        ...retrainQuestions.map(q => ({ ...q, purpose: 'retrain', retrain_step: stepById.get(q.id) ?? null }))
    ]);
}

/**
 * 純重練卷的卷名（第 5.2 節 API-5、第 5.4 節）：「<姓名>-錯題重練卷(日期)」，日期格式同既有卷名（YYYY_M_D）。
 * @param {string} studentName
 * @param {string} titleDate
 * @returns {string}
 */
function retrainPaperTitle(studentName, titleDate) {
    return `${studentName}-錯題重練卷(${titleDate})`;
}

/**
 * 這張卷是不是「純重練卷」：每一題都是重練題（至少一題）。
 * @param {number[]} questionIds
 * @param {number[]|null} retrainIds
 * @returns {boolean}
 */
function isPureRetrain(questionIds, retrainIds) {
    if (!Array.isArray(retrainIds) || retrainIds.length === 0) return false;
    const set = new Set(retrainIds);
    return questionIds.length > 0 && questionIds.every(id => set.has(id));
}

/**
 * 草稿的附註（API-5 的 notes；API-8 接在補救卷的 notes 後面）。
 *   - 一題都沒有、也沒有到期的題：「目前沒有到期的重練題。」
 *   - 能出的到期題沒有全部放進來（題數上限）：「到期 6 題，本草稿放 3 題（題數上限）；其餘留在清單，下次優先。」
 *   - 整組不能出的組（blocked）逐組說明原因。
 * @param {{dueTotal:number, got:number, pickedDue:number, dueAvailable:number, blocked?:object[], label?:string}} p
 *   dueTotal：到期題數（含 blocked 裡的）；pickedDue：放進來的題裡到期的題數；
 *   dueAvailable：能出的組（units）裡到期的題數；label：句首（補救卷用「到期重練：」）
 * @returns {string[]}
 */
function draftNotes({ dueTotal, got, pickedDue, dueAvailable, blocked = [], label = '' }) {
    const notes = [];
    if (got === 0 && dueTotal === 0) {
        notes.push(`${label}目前沒有到期的重練題。`);
    } else if (pickedDue < dueAvailable) {
        notes.push(`${label}到期 ${dueTotal} 題，本草稿放 ${got} 題（題數上限）；其餘留在清單，下次優先。`);
    }
    for (const b of blocked) {
        const why = [...new Set(b.reasons.map(r => BLOCKED_REASON_LABEL[r.reason] || r.reason))].join('、');
        notes.push(`${label}承上題組（題 ${b.group_ids.join('、')}）有題到期，但${why}，這次不能出（承上題要整組出）；請到錯題重練清單處理。`);
    }
    return notes;
}

/**
 * API-5 草稿的一題（第 5.2 節的例子，另多 status、due）。
 * @param {object} v API-1 一筆的畫面資料
 * @returns {object}
 */
function draftItemOf(v) {
    return {
        question_id: v.question_id,
        item_id: v.item_id,
        step: v.step,
        step_label: v.step_label,
        due_on: v.due_on,
        overdue_days: v.overdue_days,
        chapter: v.chapter,
        difficulty: v.difficulty,
        question_text_preview: v.question_text_preview,
        follows_question_id: v.follows_question_id ?? null,
        group_ids: v.group_ids,
        status: v.status,
        due: v.due
    };
}

// ───────────────────────── I/O ─────────────────────────

function runnerOf(db) {
    if (typeof db === 'function') return db;
    if (db && typeof db.query === 'function') return (text, values) => db.query(text, values);
    throw new TypeError('retrainSelect：db 必須是 query 函式或 pool／client。');
}

/**
 * 到期單位＋逐組放入（只讀）。
 *
 * @param {Function|{query:Function}} db
 * @param {{studentId:number, subject?:string|null, asOf?:string, today?:string, count:number,
 *          excludeIds?:number[], includeNotDue?:boolean, maxCount?:number, params?:object}} p
 * @returns {Promise<{error:{message:string, group_ids:number[], remaining:number, suggest:number[]}} |
 *   {as_of:string, due_total:number, due_available:number, picked:object[], ids:number[], got:number, blocked:object[],
 *    views:Map<number, object>}>}
 *   views：挑到的每一題的畫面資料（item_id、step、step_label……）
 */
async function selectRetrain(db, { studentId, subject = null, asOf, today = retrainService.todayLocal(), count,
    excludeIds = [], includeNotDue = false, maxCount = MAX_PAPER_QUESTIONS, params }) {
    const run = runnerOf(db);
    const asOfDate = asOf || today;
    const opts = { asOf: asOfDate, subject, today, ...(params ? { params } : {}) };
    let due;
    if (includeNotDue) {
        const list = await retrainService.listItems(run, studentId, { status: 'all', ...opts });
        due = unitsFromViews(list ? list.items : [], { includeNotDue: true });
    } else {
        due = await retrainService.listDueUnits(run, studentId, opts);
    }
    const pick = pickUnits(due.units, count, { excludeIds, maxCount });
    if (pick.error) return { error: pick.error };
    const views = new Map(pick.picked.flatMap(u => u.items).map(v => [v.question_id, v]));
    return {
        as_of: asOfDate,
        due_total: due.due_total,
        // 能出的組裡到期的題數（附註「其餘留在清單」要用；blocked 的組不算，那不是題數上限擋下的）
        due_available: due.units.reduce((s, u) => s + u.due_count, 0),
        picked: pick.picked, ids: pick.ids, got: pick.got, blocked: due.blocked, views
    };
}

/** 出卷要的題目欄位（與 generate-paper 同一組，依 ids 的順序）。 */
async function fetchPaperQuestions(run, ids) {
    if (!ids.length) return [];
    const { rows } = await run(
        `SELECT id, question_text, question_type, difficulty, answer_text, source_type, source_detail, follows_question_id
           FROM questions WHERE id = ANY($1::int[])`,
        [ids]);
    const byId = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => byId.get(id)).filter(Boolean);
}

/**
 * 〔API-6〕附在新卷的重練題（只讀）：挑題＋題目欄位。呼叫端（examController）再用 mergeForPaper 與新題合併。
 *
 * @param {Function|{query:Function}} db
 * @param {{studentId:number, subject:string, asOf?:string, today?:string, count:number, newCount:number, excludeIds?:number[]}} p
 * @returns {Promise<{error:{message:string}} |
 *   {questions:object[], ids:number[], stepById:Map<number,number>, summary:{wanted:number, got:number, due_total:number}}>}
 */
async function selectForAttach(db, { studentId, subject, asOf, today, count, newCount, excludeIds = [] }) {
    const run = runnerOf(db);
    const sel = await selectRetrain(run, {
        studentId, subject, asOf, today, count, excludeIds, maxCount: MAX_PAPER_QUESTIONS - newCount
    });
    if (sel.error) return { error: sel.error };
    const questions = await fetchPaperQuestions(run, sel.ids);
    return {
        questions,
        ids: sel.ids,
        stepById: new Map(sel.ids.map(id => [id, sel.views.get(id).step])),
        summary: { wanted: count, got: sel.got, due_total: sel.due_total }
    };
}

/**
 * 〔API-5〕一份純重練卷的草稿（只讀，不寫庫）。確認走 API-7：
 * confirm-paper { student_id, question_ids, retrain_question_ids: question_ids }，卷名在確認時產生。
 *
 * @param {Function|{query:Function}} db
 * @param {{studentId:number, subject:string|null, count:number, asOf:string, includeNotDue:boolean, today?:string}} p
 * @returns {Promise<{error:{message:string}} | {draft:object}>}
 *   draft：{ student_id, subject, as_of, question_ids（出卷順序）, items（依優先順序）, due_total, notes }
 */
async function buildRetrainDraft(db, { studentId, subject = null, count = DEFAULT_PAPER_COUNT, asOf, includeNotDue = false, today }) {
    const run = runnerOf(db);
    const sel = await selectRetrain(run, { studentId, subject, asOf, today, count, includeNotDue, maxCount: MAX_PAPER_QUESTIONS });
    if (sel.error) return { error: sel.error };
    const rows = await fetchPaperQuestions(run, sel.ids);
    const questionIds = sortForPaperGrouped(rows).map(r => r.id);
    const items = sel.ids.map(id => draftItemOf(sel.views.get(id)));
    const pickedDue = items.filter(i => i.due).length;
    return {
        draft: {
            student_id: studentId,
            subject,
            as_of: sel.as_of,
            question_ids: questionIds,
            items,
            due_total: sel.due_total,
            notes: draftNotes({ dueTotal: sel.due_total, got: sel.got, pickedDue, dueAvailable: sel.due_available, blocked: sel.blocked })
        }
    };
}

/**
 * 〔API-8〕補救卷多一組 bucket = 'retrain'（「到期重練」）。draft 是 remedialService.planRemedialPaper 的回應，
 * 本函式回一份新的（不改動輸入）：items 接在最後、blueprint 與 shortfalls 各多一列、notes 接在後面、
 * question_ids 依 sortForPaper 重排（既有的題在同分時保持原本的相對順序）。
 * 補救卷的 basis 與弱點排序照舊只看每題第一次作答（〔R10 選 1〕；planRemedialPaper 讀檢視 attempts，不受重練影響）。
 *
 * @param {Function|{query:Function}} db
 * @param {object} draft
 * @param {{studentId:number, count:number, today?:string}} p
 * @returns {Promise<{error:{message:string}} | {draft:object}>}
 */
async function appendRetrainBucket(db, draft, { studentId, count, today }) {
    const run = runnerOf(db);
    const newCount = draft.question_ids.length;
    const sel = await selectRetrain(run, {
        studentId, subject: draft.subject, today, count,
        maxCount: Math.min(MAX_REMEDIAL_RETRAIN, MAX_PAPER_QUESTIONS - newCount)
    });
    if (sel.error) return { error: sel.error };

    const { rows } = sel.ids.length || newCount
        ? await run(
            `SELECT id, question_text, question_type, difficulty, chapter, follows_question_id
               FROM questions WHERE id = ANY($1::int[])`,
            [[...draft.question_ids, ...sel.ids]])
        : { rows: [] };
    const byId = new Map(rows.map(r => [r.id, r]));
    // 既有的題在前、重練題在後，再排序：同分時保持補救題原本的相對順序
    const ordered = [...draft.question_ids, ...sel.ids].map(id => byId.get(id)).filter(Boolean);
    const questionIds = sortForPaperGrouped(ordered).map(r => r.id);

    const items = sel.ids.map(id => {
        const v = sel.views.get(id);
        const row = byId.get(id) || {};
        return {
            question_id: id,
            bucket: 'retrain',
            target: RETRAIN_TARGET,
            chapter: row.chapter ?? v.chapter ?? null,
            difficulty: row.difficulty ?? v.difficulty ?? null,
            question_text_preview: previewText(row.question_text),
            follows_question_id: row.follows_question_id ?? null,
            group_ids: v.group_ids,
            item_id: v.item_id,
            step: v.step,
            step_label: v.step_label,
            due_on: v.due_on,
            overdue_days: v.overdue_days
        };
    });
    const pickedDue = sel.ids.filter(id => sel.views.get(id).due).length;
    const blueprintRow = {
        bucket: 'retrain', target: RETRAIN_TARGET, wanted: count, got: sel.got,
        difficulty_min: null, difficulty_max: null,
        rationale: `到期 ${sel.due_total} 題；依逾期天數、關卡、錯的次數排序，承上題整組出`
    };
    const shortfalls = sel.got < count
        ? [{ bucket: 'retrain', target: RETRAIN_TARGET, wanted: count, got: sel.got, reason: 'not_enough_due' }]
        : [];
    return {
        draft: {
            ...draft,
            question_ids: questionIds,
            items: [...draft.items, ...items],
            blueprint: [...draft.blueprint, blueprintRow],
            shortfalls: [...draft.shortfalls, ...shortfalls],
            notes: [...draft.notes, ...draftNotes({
                dueTotal: sel.due_total, got: sel.got, pickedDue, dueAvailable: sel.due_available, blocked: sel.blocked, label: '到期重練：'
            })]
        }
    };
}

module.exports = {
    DEFAULT_PAPER_COUNT,
    MAX_REMEDIAL_RETRAIN,
    RETRAIN_TARGET,
    BLOCKED_REASON_LABEL,
    // 純函式
    r12Message,
    pickUnits,
    unitsFromViews,
    mergeForPaper,
    retrainPaperTitle,
    isPureRetrain,
    draftNotes,
    draftItemOf,
    // I/O
    selectRetrain,
    selectForAttach,
    buildRetrainDraft,
    appendRetrainBucket
};
