// ─────────────────────────────────────────────────────────────
// utils/retrainValidation.js — 錯題重練 API 的參數驗證（純函式；docs/retrain-and-review.md 第 5.2 節）
//
//   API-1  GET   /api/students/:id/retrain-items?status=&subject=&as_of=   parseListQuery
//   API-2  POST  /api/students/:id/retrain-items   { question_ids }          parseAddBody
//   API-3  PATCH /api/students/:id/retrain-items/:itemId { action, note? }   parseActionBody
//   API-4  GET   /api/retrain/summary?as_of=                                 parseSummaryQuery
//   API-10 PATCH /api/papers/:id/results 的 results[i].retrain（R1 選 2）     parseRetrainFlags
//   〔PR-3〕API-5  POST /api/students/:id/retrain-paper                      parseRetrainPaperBody
//   〔PR-3〕API-6  POST /api/generate-paper 的 retrain: { count, as_of? }     parseAttachParam
//   〔PR-3〕API-7  POST /api/confirm-paper 的 retrain_question_ids            parseConfirmRetrain
//   〔PR-3〕API-8  POST /api/students/:id/remedial-paper 的 retrain_count     parseRemedialRetrain
//   〔PR-3〕API-12 POST /api/download-word 的 paper_id                        parseWordPaperId
//
// 嚴格驗證（同裁決 S5-21）：不認得的查詢參數或 body 鍵一律 400，不靜默略過——拼錯的鍵被略過，
// 老師會以為設定生效了。同名查詢參數重複（?status=a&status=b）也是 400。
// 路徑上的 :id／:itemId 不合法一律當作「不存在」回 404（同 controllers/studentController.js 的 parseId 慣例）。
//
// 純函式：不碰 DB、不讀 env、不看時鐘（「今天」由呼叫端傳入）。訊息不含學生姓名。
// ─────────────────────────────────────────────────────────────
'use strict';

const { SUBJECTS } = require('../config/chapters');
const { isValidDate } = require('../services/retrainSchedule');

/** API-1 的 status 篩選（第 5.2 節）；預設 active。 */
const LIST_STATUSES = Object.freeze(['active', 'due', 'in_flight', 'stuck', 'mastered', 'retired', 'all']);
/** API-3 的 action。 */
const ACTIONS = Object.freeze(['retire', 'mark_mastered', 'reactivate']);
/** API-2 一次最多加幾題（第 5.2 節：1–50 個）。 */
const MAX_ADD_IDS = 50;
/** retrain_items.note 的字數上限（migrations/0017 的 CHECK）。 */
const MAX_NOTE_LEN = 200;
/** PostgreSQL INT（int4）上限：students／questions 的 id 都是 INT。 */
const INT4_MAX = 2147483647;

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** 以 Unicode code point 計字數（與 PG 的 char_length 同一把尺）。 */
function charLength(s) {
    return [...s].length;
}

/**
 * 路徑上的學生 id → 正整數；不合法回 null（呼叫端回 404）。規則同 studentController 的 parseId。
 * @param {any} raw
 * @returns {number|null}
 */
function parseStudentId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > INT4_MAX || String(n) !== s) return null;
    return n;
}

/**
 * 路徑上的項目 id（retrain_items.id 是 BIGINT）→ 正整數；不合法回 null（呼叫端回 404）。
 * @param {any} raw
 * @returns {number|null}
 */
function parseItemId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 1 || String(n) !== s) return null;
    return n;
}

/**
 * 查詢參數的共同檢查：只收 allowed 裡的鍵、每個鍵只能出現一次（值必須是字串）。
 * @returns {string|null} 錯誤訊息
 */
function checkQueryKeys(q, allowed) {
    const unknown = Object.keys(q).filter(k => !allowed.includes(k));
    if (unknown.length) return `不認得的查詢參數：${unknown.join('、')}（可用：${allowed.join('、')}）。`;
    for (const k of allowed) {
        if (own(q, k) && typeof q[k] !== 'string') return `${k} 只能給一個值。`;
    }
    return null;
}

/** 空字串與沒給都算「沒給」。 */
function given(q, k) {
    return own(q, k) && q[k].trim() !== '';
}

/**
 * as_of（預計作答日）：'YYYY-MM-DD'，沒給＝today。
 * @returns {{error:string}|{value:string}}
 */
function parseAsOf(q, today) {
    if (!given(q, 'as_of')) return { value: today };
    const v = q.as_of.trim();
    if (!isValidDate(v)) return { error: 'as_of 必須是 YYYY-MM-DD 格式的日期。' };
    return { value: v };
}

/**
 * API-1 的查詢參數。
 * @param {object} query req.query
 * @param {{today:string}} opts
 * @returns {{error:string} | {status:string, subject:string|null, asOf:string}}
 */
function parseListQuery(query, { today }) {
    const q = query && typeof query === 'object' ? query : {};
    const keyError = checkQueryKeys(q, ['status', 'subject', 'as_of']);
    if (keyError) return { error: keyError };

    const status = given(q, 'status') ? q.status.trim() : 'active';
    if (!LIST_STATUSES.includes(status)) return { error: `status 只接受 ${LIST_STATUSES.join('、')}。` };

    const subject = given(q, 'subject') ? q.subject.trim() : null;
    if (subject !== null && !SUBJECTS.includes(subject)) return { error: 'subject 不在白名單內。' };

    const asOf = parseAsOf(q, today);
    if (asOf.error) return { error: asOf.error };
    return { status, subject, asOf: asOf.value };
}

/**
 * API-4 的查詢參數。
 * @returns {{error:string} | {asOf:string}}
 */
function parseSummaryQuery(query, { today }) {
    const q = query && typeof query === 'object' ? query : {};
    const keyError = checkQueryKeys(q, ['as_of']);
    if (keyError) return { error: keyError };
    const asOf = parseAsOf(q, today);
    if (asOf.error) return { error: asOf.error };
    return { asOf: asOf.value };
}

/** body 必須是 JSON 物件，而且只收 allowed 裡的鍵。 */
function checkBodyKeys(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body 必須是 JSON 物件。';
    const unknown = Object.keys(body).filter(k => !allowed.includes(k));
    if (unknown.length) return `不接受的欄位：${unknown.join('、')}（可用的欄位：${allowed.join('、')}）。`;
    return null;
}

/**
 * API-2 的 body：{ question_ids: [正整數, …] }（1–50 個、不重複）。
 * @returns {{error:string} | {questionIds:number[]}}
 */
function parseAddBody(body) {
    const keyError = checkBodyKeys(body, ['question_ids']);
    if (keyError) return { error: keyError };
    const ids = body.question_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ADD_IDS ||
        ids.some(v => !Number.isInteger(v) || v < 1 || v > INT4_MAX)) {
        return { error: `question_ids 必須是 1~${MAX_ADD_IDS} 個正整數。` };
    }
    if (new Set(ids).size !== ids.length) return { error: 'question_ids 不得重複。' };
    return { questionIds: [...ids] };
}

/**
 * API-3 的 body：{ action: 'retire'|'mark_mastered'|'reactivate', note? }。
 * note：字串（trim 後空字串＝清空）或 null，≤200 字；沒送＝不動。
 * @returns {{error:string} | {action:string, hasNote:boolean, note:string|null}}
 */
function parseActionBody(body) {
    const keyError = checkBodyKeys(body, ['action', 'note']);
    if (keyError) return { error: keyError };
    if (!own(body, 'action') || !ACTIONS.includes(body.action)) {
        return { error: `action 必填，只接受 ${ACTIONS.join('、')}。` };
    }
    const hasNote = own(body, 'note');
    let note = null;
    if (hasNote && body.note !== null) {
        if (typeof body.note !== 'string') return { error: `note 必須是字串或 null，且不得超過 ${MAX_NOTE_LEN} 字。` };
        const v = body.note.trim();
        if (charLength(v) > MAX_NOTE_LEN) return { error: `note 必須是字串或 null，且不得超過 ${MAX_NOTE_LEN} 字。` };
        note = v === '' ? null : v;
    }
    return { action: body.action, hasNote, note };
}

/**
 * API-10：results[i].retrain（批改卡的「要重練」勾選，R1 選 2）。
 *
 * 只在 paperController.parseResultsBody 通過之後呼叫（results 已確認是非空陣列、每列都是帶合法 question_id 的物件）。
 * 回傳的錯誤由呼叫端排在既有的全部檢查（含卷不存在、題目不在卷上、錯因科目限制）之後才回報。
 *
 * @param {object} body
 * @param {{enabled:boolean}} opts enabled＝FEATURE_RETRAIN
 * @returns {{error:string} | {flags:Array<{question_id:number, retrain:boolean}>}}
 *   flags 只含有送 retrain 鍵的列（沒送＝不動）
 */
function parseRetrainFlags(body, { enabled }) {
    const results = body && Array.isArray(body.results) ? body.results : [];
    const flags = [];
    for (const row of results) {
        if (!row || typeof row !== 'object' || !own(row, 'retrain')) continue;
        if (!enabled) return { error: 'retrain 需要開啟 FEATURE_RETRAIN。' };
        if (typeof row.retrain !== 'boolean') return { error: 'retrain 只接受 true 或 false。' };
        flags.push({ question_id: row.question_id, retrain: row.retrain });
    }
    return { flags };
}

// ───────────────────────── 〔retrain PR-3〕出卷整合（API-5～8、API-12）─────────────────────────
//
// 共同規則：
//   - 擴充既有端點（API-6、7、8、12）的新參數沒帶（undefined 或 null）＝沒有這個功能，呼叫端的行為與回應逐字不變。
//   - 旗標關閉卻帶了新參數 → 400「retrain 需要開啟 FEATURE_RETRAIN。」（讓老師知道沒生效，而不是靜默忽略；同 API-10）。
//     唯一的例外是 API-12 的 paper_id：組卷頁早就把 paper_id 一起送給 download-word（currentPaperCache），
//     旗標關閉時照舊忽略它，Word 逐位元不變。
//   - 巢狀物件（retrain: {…}）與新端點（API-5）的 body 一樣嚴格：不認得的鍵 400（同裁決 S5-21）。

/** 旗標關閉卻帶了重練參數（API-6、7、8、10 共用的訊息）。 */
const RETRAIN_DISABLED_MESSAGE = 'retrain 需要開啟 FEATURE_RETRAIN。';
/** 一份卷最多幾題（同 config/retrain.js 的 MAX_PAPER_QUESTIONS、examController 的 MAX_QUESTIONS）。 */
const MAX_PAPER = 50;
/** API-5 的 count 預設（第 5.2 節）。 */
const DEFAULT_RETRAIN_PAPER_COUNT = 10;
/** API-8 的 retrain_count 上限（第 5.2 節：0–20）。 */
const MAX_REMEDIAL_RETRAIN = 20;

const isPositiveInt4 = x => Number.isInteger(x) && x >= 1 && x <= INT4_MAX;

/**
 * 日期參數（body 裡的 as_of）：沒給、null、空字串＝today；其餘必須是真的有這一天的 'YYYY-MM-DD'。
 * @returns {{error:string}|{value:string}}
 */
function parseBodyDate(raw, today, label) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: today };
    if (typeof raw !== 'string' || !isValidDate(raw.trim())) return { error: `${label} 必須是 YYYY-MM-DD 格式的日期。` };
    return { value: raw.trim() };
}

/**
 * API-6：POST /api/generate-paper 的 retrain: { count, as_of? }（附上到期的重練題，R6 選 1）。
 *
 * count 0–50（前端預先帶入 capForAttach(新題數)，老師可改）；新題＋重練合計不得超過 50 題。
 *
 * @param {any} raw req.body.retrain
 * @param {{enabled:boolean, newCount:number, today:string}} opts newCount：新題題數（單章的 count 或 blueprint 的總和）
 * @returns {{error:string} | {value:null} | {value:{count:number, asOf:string}}}
 */
function parseAttachParam(raw, { enabled, newCount, today }) {
    if (raw === undefined || raw === null) return { value: null };
    if (!enabled) return { error: RETRAIN_DISABLED_MESSAGE };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'retrain 必須是物件：{ count, as_of? }。' };
    const allowed = ['count', 'as_of'];
    const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
    if (unknown.length) {
        return { error: `retrain 不接受的欄位：${unknown.join('、')}（可用的欄位：${allowed.join('、')}）。` };
    }
    if (!Number.isInteger(raw.count) || raw.count < 0 || raw.count > MAX_PAPER) {
        return { error: `retrain.count 必須是 0~${MAX_PAPER} 的整數。` };
    }
    const asOf = parseBodyDate(raw.as_of, today, 'retrain.as_of');
    if (asOf.error) return { error: asOf.error };
    if (newCount + raw.count > MAX_PAPER) {
        return { error: `新題加重練題最多 ${MAX_PAPER} 題（新題 ${newCount} 題＋重練 ${raw.count} 題）。` };
    }
    return { value: { count: raw.count, asOf: asOf.value } };
}

/**
 * API-7：POST /api/confirm-paper 的 retrain_question_ids（必須是 question_ids 的子集；可以是空陣列）。
 *
 * @param {object} body 已通過既有檢查（question_ids 是 1–50 個不重複的正整數）
 * @param {{enabled:boolean}} opts
 * @returns {{error:string} | {value:null} | {value:number[]}}
 */
function parseConfirmRetrain(body, { enabled }) {
    const raw = body ? body.retrain_question_ids : undefined;
    if (raw === undefined || raw === null) return { value: null };
    if (!enabled) return { error: RETRAIN_DISABLED_MESSAGE };
    if (!Array.isArray(raw) || raw.some(v => !isPositiveInt4(v))) {
        return { error: 'retrain_question_ids 必須是正整數陣列。' };
    }
    if (new Set(raw).size !== raw.length) return { error: 'retrain_question_ids 不得重複。' };
    const inPaper = new Set(Array.isArray(body.question_ids) ? body.question_ids : []);
    const outside = raw.filter(id => !inPaper.has(id));
    if (outside.length) {
        return { error: `retrain_question_ids 的每一題都必須在 question_ids 裡（不在的：${outside.join('、')}）。` };
    }
    return { value: [...raw] };
}

/**
 * API-5：POST /api/students/:id/retrain-paper 的 body：{ subject?, count?(1–50，預設 10), as_of?, include_not_due?(預設 false) }。
 * 全部選填；沒有 body（或空物件）＝全部預設。
 *
 * @param {any} body
 * @param {{today:string}} opts
 * @returns {{error:string} | {subject:string|null, count:number, asOf:string, includeNotDue:boolean}}
 */
function parseRetrainPaperBody(body, { today }) {
    const b = body === undefined || body === null ? {} : body;
    const keyError = checkBodyKeys(b, ['subject', 'count', 'as_of', 'include_not_due']);
    if (keyError) return { error: keyError };

    let subject = null;
    if (b.subject !== undefined && b.subject !== null && !(typeof b.subject === 'string' && b.subject.trim() === '')) {
        if (typeof b.subject !== 'string' || !SUBJECTS.includes(b.subject.trim())) return { error: 'subject 不在白名單內。' };
        subject = b.subject.trim();
    }

    let count = DEFAULT_RETRAIN_PAPER_COUNT;
    if (b.count !== undefined && b.count !== null) {
        if (!Number.isInteger(b.count) || b.count < 1 || b.count > MAX_PAPER) return { error: `count 必須是 1~${MAX_PAPER} 的整數。` };
        count = b.count;
    }

    const asOf = parseBodyDate(b.as_of, today, 'as_of');
    if (asOf.error) return { error: asOf.error };

    let includeNotDue = false;
    if (b.include_not_due !== undefined && b.include_not_due !== null) {
        if (typeof b.include_not_due !== 'boolean') return { error: 'include_not_due 只接受 true 或 false。' };
        includeNotDue = b.include_not_due;
    }
    return { subject, count, asOf: asOf.value, includeNotDue };
}

/**
 * API-8：POST /api/students/:id/remedial-paper 的 retrain_count（0–20，預設 0；total＋retrain_count ≤ 50）。
 * 0（或沒帶）＝沒有「到期重練」組，回應與沒有這個參數時逐字相同。
 *
 * @param {object} body
 * @param {{enabled:boolean, total:number}} opts total：已驗證過的補救題數
 * @returns {{error:string} | {count:number}}
 */
function parseRemedialRetrain(body, { enabled, total }) {
    const raw = body && typeof body === 'object' ? body.retrain_count : undefined;
    if (raw === undefined || raw === null) return { count: 0 };
    if (!enabled) return { error: RETRAIN_DISABLED_MESSAGE };
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_REMEDIAL_RETRAIN) {
        return { error: `retrain_count 必須是 0~${MAX_REMEDIAL_RETRAIN} 的整數。` };
    }
    if (total + raw > MAX_PAPER) {
        return { error: `total 加上 retrain_count 最多 ${MAX_PAPER} 題（補救 ${total} 題＋重練 ${raw} 題）。` };
    }
    return { count: raw };
}

/**
 * API-12：POST /api/download-word 的 paper_id（有帶時依 R7 標示重練題）。
 * 旗標關閉時一律忽略（回 null）：組卷頁本來就會把 paper_id 一起送來，旗標關閉時 Word 必須逐位元不變。
 *
 * @param {object} body
 * @param {{enabled:boolean}} opts
 * @returns {{error:string} | {paperId:number|null}}
 */
function parseWordPaperId(body, { enabled }) {
    if (!enabled) return { paperId: null };
    const raw = body && typeof body === 'object' ? body.paper_id : undefined;
    if (raw === undefined || raw === null) return { paperId: null };
    if (!isPositiveInt4(raw)) return { error: 'paper_id 必須是正整數。' };
    return { paperId: raw };
}

module.exports = {
    LIST_STATUSES,
    ACTIONS,
    MAX_ADD_IDS,
    MAX_NOTE_LEN,
    parseStudentId,
    parseItemId,
    parseListQuery,
    parseSummaryQuery,
    parseAddBody,
    parseActionBody,
    parseRetrainFlags,
    // 〔retrain PR-3〕出卷整合
    RETRAIN_DISABLED_MESSAGE,
    DEFAULT_RETRAIN_PAPER_COUNT,
    MAX_REMEDIAL_RETRAIN,
    parseAttachParam,
    parseConfirmRetrain,
    parseRetrainPaperBody,
    parseRemedialRetrain,
    parseWordPaperId
};
