// ─────────────────────────────────────────────────────────────
// services/retrainService.js — 錯題重練與間隔複習的 I/O 層（PR-2；docs/retrain-and-review.md 第 3.4～3.9、4.4～4.7、5.2 節）
//
// 排程本身是純函式（services/retrainSchedule.js，已凍結）；本檔負責：
//   1. 讀作答歷史（檢視 assignment_attempts）→ 呼叫 computeRetrainState 重算 → 把快取欄位寫回 retrain_items（不變量 I7）。
//      重算從不自己建立項目：項目只在老師勾「要重練」（flagged）、承上組帶入（group）、清單上手動加入（manual）時建立
//      （〔R1 選 2〕〔R11 選 3〕）。
//   2. 到期清單與排序（第 4.7 節）；「已派出未批改」「卡關」查詢時由作答歷史與 lapses 算出，不另存欄位。
//   3. 批改（API-10）、清單動作（API-2、API-3）、刪卷、刪學生、合併學生的排程處理。
//   4. 給第三、四階段（PR-3 出卷整合、PR-4 畫面）直接呼叫的介面：listDueUnits、insertRetrainAssignments、
//      listItems、getItemView、summary（簽名見各函式的 JSDoc；總表在 docs/retrain-and-review.md 第 5.6.2 節）。
//
// 交易：凡是會改變歷史或項目的函式都收一個**已經 BEGIN 的 client**，由呼叫端（controller）決定 COMMIT／ROLLBACK，
// 讓「寫入＋重算」在同一個交易內全有全無。只讀的函式收 pool、client 或 query 函式都可以。
//
// 併發：會改項目的路徑一律先 `SELECT … FOR UPDATE` 鎖住項目（依 id 排序，鎖的順序一致），再用**另一句**讀作答歷史。
// READ COMMITTED 下每一句拿新的快照，所以等鎖之後讀到的歷史一定包含先拿到鎖的那個交易已經提交的寫入——
// 兩個交易同時批改同一個項目的不同重練卷，後提交的那一個重算時看得到兩筆，結果與依序批改相同。
//
// 日期：一律 'YYYY-MM-DD' 字串。從資料庫讀出來用 to_char（不依賴 config/db.js 的型別轉換，CLI 自建連線時也一樣）；
// 「今天」用本地時區（同 examController 的 localDates：派題日也是本地日期），由呼叫端傳入或用 todayLocal()。
//
// 個資：本檔不讀、不回學生姓名，也不寫 log。不呼叫任何 LLM。
// ─────────────────────────────────────────────────────────────
'use strict';

const { loadRetrainConfig } = require('../config/retrain');
const schedule = require('./retrainSchedule');
const { buildItemLookupQuery, groupIdsById, previewText } = require('./remedialService');

/** 已派出多久沒批改要另外提醒（設計稿第 4.4 節「超過 14 天未批改另外提醒」；不開放環境變數覆寫）。 */
const IN_FLIGHT_WARN_DAYS = 14;

/** 合併學生時要延後到 COMMIT 才檢查的兩個複合外鍵（migrations/0017）。 */
const DEFERRABLE_CONSTRAINTS = Object.freeze(['assignments_retrain_item_fk', 'retrain_items_source_fk']);

/** 排序用：狀態的先後（進行中 → 練到會 → 移出）。 */
const STATUS_RANK = Object.freeze({ active: 0, mastered: 1, retired: 2 });

/** 快取欄位（retrain_items 上由重算寫入的七欄）。 */
const CACHE_FIELDS = Object.freeze(['status', 'step', 'due_on', 'streak', 'lapses', 'last_attempt_on', 'mastered_on']);

/** API-7（PR-3）確認出卷時項目狀態已改變的 409 訊息（設計稿第 5.2 節）。 */
function retrainConflictMessage(questionId) {
    return `題目 ${questionId} 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`;
}

// ───────────────────────── 小工具 ─────────────────────────

/** `db` 可以是 query 函式，也可以是 pool／client（有 .query）。 */
function runnerOf(db) {
    if (typeof db === 'function') return db;
    if (db && typeof db.query === 'function') return (text, values) => db.query(text, values);
    throw new TypeError('retrainService：db 必須是 query 函式或 pool／client。');
}

/**
 * 本地時區的今天（同 controllers/examController.js 的 localDates().todayStr：派題日也是這樣算的）。
 * @param {Date} [now]
 * @returns {string} 'YYYY-MM-DD'
 */
function todayLocal(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const D = col => `to_char(${col}, 'YYYY-MM-DD')`;

/** 項目的欄位（日期轉字串、id 轉數字在 toItemRow）。 */
const ITEM_COLUMNS = `i.id, i.student_id, i.question_id, i.source_assignment_id, i.reason,
       ${D('i.entered_on')} AS entered_on, i.status, i.step, ${D('i.due_on')} AS due_on, i.streak, i.lapses,
       ${D('i.last_attempt_on')} AS last_attempt_on, ${D('i.mastered_on')} AS mastered_on,
       i.teacher_override, ${D('i.override_on')} AS override_on, i.note, i.entered_after_assignment_id`;

function toItemRow(r) {
    return {
        ...r,
        id: Number(r.id),
        student_id: Number(r.student_id),
        question_id: Number(r.question_id),
        source_assignment_id: Number(r.source_assignment_id),
        entered_after_assignment_id: r.entered_after_assignment_id === null || r.entered_after_assignment_id === undefined
            ? null : Number(r.entered_after_assignment_id),
        step: Number(r.step),
        streak: Number(r.streak),
        lapses: Number(r.lapses)
    };
}

/** 一筆項目的排程快取（重算前後比較用）。 */
function cacheOf(row) {
    const out = {};
    for (const k of CACHE_FIELDS) out[k] = row[k] === undefined ? null : row[k];
    return out;
}

function sameCache(a, b) {
    return CACHE_FIELDS.every(k => (a[k] ?? null) === (b[k] ?? null));
}

const pairKey = (studentId, questionId) => `${studentId}:${questionId}`;

// ───────────────────────── 純函式 ─────────────────────────

/**
 * 「已派出、還沒批改」的派題（依派題日、派題編號排序的歷史中，還沒批改而且 countsAsInFlight 為真的）。
 * 純函式 retrainSchedule.countsAsInFlight 是這條規則的唯一實作（設計稿第 4.4 節）；
 * API-1 的 in_flight／in_flight_paper_id、14 天提醒、API-4 的 in_flight、出卷時的 409 檢查都經這裡。
 * @param {object[]} history 已排序
 * @param {string} enteredOn
 * @returns {object[]}
 */
function pendingOf(history, enteredOn) {
    return (history || []).filter(h => !schedule.isGraded(h) && schedule.countsAsInFlight(h, enteredOn));
}

const WEEK_WORDS = ['', '一', '兩', '三', '四', '五', '六', '七', '八'];

/**
 * 關卡的名稱：第 1 關＝「錯題重練」，之後依間隔天數叫「一週回測」「兩週回測」……（設計稿第 4.3、9.1 節）。
 * 間隔不是整週時叫「隔 N 天回測」（Owner 改了 RETRAIN_STEP_DAYS 時）。
 * @param {number} step 1～9
 * @param {ReadonlyArray<number>} stepDays
 * @returns {string}
 */
function stepLabel(step, stepDays) {
    if (step === 1) return '錯題重練';
    const d = stepDays[step - 1];
    if (!Number.isInteger(d)) return `第 ${step} 關`;
    if (d > 0 && d % 7 === 0 && d / 7 < WEEK_WORDS.length) return `${WEEK_WORDS[d / 7]}週回測`;
    return `隔 ${d} 天回測`;
}

/**
 * 排序鍵（第 4.7 節）：到期的在前 → 逾期天數多的先 → 關卡小的先 → 錯次數多的先 → 題號小的先。
 * 沒到期的排在後面：進行中 → 練到會 → 移出，進行中的依到期日早的先。
 * @param {{due:boolean, overdue_days:number, status:string, due_on:string|null, step:number, lapses:number, question_id:number}} v
 * @returns {Array<number|string>}
 */
function priorityKey(v) {
    return [v.due ? 0 : 1, -v.overdue_days, STATUS_RANK[v.status] ?? 9, v.due_on || '9999-12-31',
        v.step, -v.lapses, v.question_id];
}

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

/**
 * 把項目依承上組分成「單位」並排序（第 4.7 節：承上組以組為單位、依組內最急的一題排序）。
 * 組內依承接順序（group_ids 的順序）；沒有綁定的題自成一個單位。
 *
 * @param {Array<object>} views buildItemView 的輸出（要有 group_ids、question_id 與 priorityKey 用到的欄位）
 * @returns {Array<{group_ids:number[], items:object[]}>}
 */
function orderUnits(views) {
    const byKey = new Map();
    for (const v of views) {
        const g = Array.isArray(v.group_ids) && v.group_ids.length ? v.group_ids : [v.question_id];
        const key = g.join(',');
        if (!byKey.has(key)) byKey.set(key, { group_ids: g, items: [] });
        byKey.get(key).items.push(v);
    }
    const units = [...byKey.values()].map(u => {
        u.items.sort((a, b) => u.group_ids.indexOf(a.question_id) - u.group_ids.indexOf(b.question_id));
        const best = u.items.map(priorityKey).sort(compareKeys)[0];
        return { ...u, _key: best };
    });
    units.sort((a, b) => compareKeys(a._key, b._key) || a.group_ids[0] - b.group_ids[0]);
    return units.map(({ _key, ...u }) => u);
}

/** API-1 的 status 篩選（第 5.2 節）。 */
const LIST_FILTERS = Object.freeze({
    active: v => v.status === 'active',
    due: v => v.due,
    in_flight: v => v.status === 'active' && v.in_flight,
    stuck: v => v.stuck,
    mastered: v => v.status === 'mastered',
    retired: v => v.status === 'retired',
    all: () => true
});

/**
 * API-1 的 counts（依科目篩選，不依 status 篩選）。
 * @param {object[]} views
 */
function countViews(views) {
    const c = { active: 0, due: 0, in_flight: 0, stuck: 0, mastered: 0, retired: 0 };
    for (const v of views) {
        if (v.status === 'active') c.active += 1;
        if (v.due) c.due += 1;
        if (v.status === 'active' && v.in_flight) c.in_flight += 1;
        if (v.stuck) c.stuck += 1;
        if (v.status === 'mastered') c.mastered += 1;
        if (v.status === 'retired') c.retired += 1;
    }
    return c;
}

/**
 * 一個項目的完整畫面資料（API-1 的一筆；API-3 回傳同一個形狀）。
 *
 * 排程欄位讀快取（retrain_items）；「已派出未批改」由作答歷史算（有任何一筆派題還沒批改，含取消批改）；
 * 到期＝進行中、沒有已派出、到期日 ≤ as_of，而且題目沒封存（第 4.7 節）；卡關＝進行中而且 lapses ≥ 卡關次數。
 *
 * @param {object} row 項目（toItemRow）＋題目欄位（subject、chapter、difficulty、question_type、question_text、
 *                     follows_question_id、archived）
 * @param {{history:object[], groupIds:number[]|null, params:object, asOf:string, today:string}} ctx
 * @returns {object}
 */
function buildItemView(row, { history, groupIds, params, asOf, today }) {
    const hist = history || [];
    // 「已派出、還沒批改」只看 countsAsInFlight 為真的派題（重練派題一律算；新題派題派題日 ≥ 起算日才算）
    const pending = pendingOf(hist, row.entered_on);
    const inFlight = pending.length > 0;
    const state = { status: row.status, due_on: row.due_on, in_flight: inFlight };
    const due = !row.archived && schedule.isDue(state, asOf);
    const inFlightSince = inFlight ? pending[0].assigned_at : null;
    return {
        item_id: row.id,
        question_id: row.question_id,
        subject: row.subject,
        chapter: row.chapter,
        difficulty: row.difficulty,
        question_type: row.question_type,
        question_text_preview: previewText(row.question_text),
        archived: Boolean(row.archived),
        reason: row.reason,
        entered_on: row.entered_on,
        status: row.status,
        step: row.step,
        step_label: stepLabel(row.step, params.stepDays),
        due_on: row.due_on,
        due,
        overdue_days: due ? schedule.overdueDays(state, asOf) : 0,
        in_flight: inFlight,
        in_flight_paper_id: inFlight ? pending[0].paper_id : null,
        in_flight_since: inFlightSince,
        in_flight_warn: inFlight && schedule.diffDays(inFlightSince, today) > IN_FLIGHT_WARN_DAYS,
        streak: row.streak,
        lapses: row.lapses,
        stuck: row.status === 'active' && row.lapses >= params.stuckLapses,
        last_attempt_on: row.last_attempt_on,
        mastered_on: row.mastered_on,
        teacher_override: row.teacher_override,
        override_on: row.override_on,
        note: row.note,
        group_ids: groupIds && groupIds.length ? groupIds : [row.question_id],
        follows_question_id: row.follows_question_id ?? null,
        history: hist.map(h => ({
            assignment_id: h.assignment_id,
            paper_id: h.paper_id,
            assigned_at: h.assigned_at,
            purpose: h.purpose,
            retrain_step: h.retrain_step,
            result: h.result,
            score: h.score,
            error_types: h.error_types
        }))
    };
}

/**
 * 批改（API-10）回應的 retrain 摘要：這次讓幾題進清單、升關、練到會、回第一關（第 5.2 節）。
 *   entered   這次建立或重新加入的項目（勾「要重練」，含承上組一起進的）
 *   advanced  進行中、關卡往上升（不含練到會）
 *   mastered  這次變成練到會
 *   reset     這次多了一次「錯」（重練或回測答錯 → 回第一關）
 * 這次才進清單的項目只算 entered。
 *
 * @param {Array<{item_id:number, before:object, after:object}>} changes recompute 的結果
 * @param {Set<number>} entered
 * @returns {{entered:number, advanced:number, mastered:number, reset:number}}
 */
function summarizeChanges(changes, entered) {
    const out = { entered: entered.size, advanced: 0, mastered: 0, reset: 0 };
    for (const c of changes) {
        if (entered.has(c.item_id)) continue;
        const { before: b, after: a } = c;
        if (b.status !== 'mastered' && a.status === 'mastered') out.mastered += 1;
        else if (a.status === 'active' && a.lapses > b.lapses) out.reset += 1;
        else if (b.status === 'active' && a.status === 'active' && a.step > b.step) out.advanced += 1;
    }
    return out;
}

// ───────────────────────── 讀取 ─────────────────────────

/**
 * 作答歷史：這些 (學生, 題目) 的全部派題與作答，依 (派題日, 派題編號) 排序。
 * @param {Function} run
 * @param {Array<[number, number]>} pairs [studentId, questionId]
 * @returns {Promise<Map<string, object[]>>} key＝`${studentId}:${questionId}`
 */
async function fetchHistories(run, pairs) {
    const out = new Map();
    const uniq = [...new Map(pairs.map(p => [pairKey(p[0], p[1]), p])).values()];
    if (!uniq.length) return out;
    pairs = uniq;
    const { rows } = await run(
        `SELECT a.student_id, a.question_id, a.assignment_id, a.paper_id, ${D('a.assigned_at')} AS assigned_at,
                a.purpose, a.retrain_step, a.result, a.score::float8 AS score, a.error_types
           FROM assignment_attempts a
           JOIN unnest($1::int[], $2::int[]) AS p(sid, qid) ON a.student_id = p.sid AND a.question_id = p.qid
          ORDER BY a.student_id, a.question_id, a.assigned_at, a.assignment_id`,
        [pairs.map(p => p[0]), pairs.map(p => p[1])]);
    for (const r of rows) {
        const key = pairKey(r.student_id, r.question_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({
            assignment_id: Number(r.assignment_id),
            paper_id: r.paper_id,
            assigned_at: r.assigned_at,
            purpose: r.purpose,
            retrain_step: r.retrain_step,
            result: r.result,
            score: r.score,
            error_types: r.error_types
        });
    }
    return out;
}

/**
 * 題目的承上組成員（無向連通分量，與組卷、B7 的整組檢查同一段查詢：remedialService.buildItemLookupQuery）。
 * @returns {Promise<{rows:object[], groupOf:Map<number, number[]>}>}
 *   rows 含 id、subject、chapter、difficulty、question_text、follows_question_id、archived、
 *   answered（該生有這一題的「新題」派題＝曾經派給他）
 */
async function lookupGroups(run, questionIds, studentId) {
    if (!questionIds.length) return { rows: [], groupOf: new Map() };
    const q = buildItemLookupQuery([...new Set(questionIds)], studentId);
    const { rows } = await run(q.text, q.values);
    return { rows, groupOf: groupIdsById(rows) };
}

/**
 * 某生的項目＋題目欄位（可依科目、項目 id 篩）。
 * @returns {Promise<object[]>}
 */
async function fetchItemRows(run, studentId, { subject = null, itemIds = null } = {}) {
    const { rows } = await run(
        `SELECT ${ITEM_COLUMNS}, q.subject, q.chapter, q.difficulty, q.question_type, q.question_text,
                q.follows_question_id, (q.archived_at IS NOT NULL) AS archived
           FROM retrain_items i JOIN questions q ON q.id = i.question_id
          WHERE i.student_id = $1
            AND ($2::text IS NULL OR q.subject = $2)
            AND ($3::bigint[] IS NULL OR i.id = ANY($3::bigint[]))
          ORDER BY i.id`,
        [studentId, subject, itemIds]);
    return rows.map(toItemRow);
}

async function studentExists(run, studentId) {
    const { rows } = await run('SELECT 1 FROM students WHERE id = $1', [studentId]);
    return rows.length > 0;
}

/** 把一批項目列組成畫面資料（讀歷史與承上組）。 */
async function viewsOf(run, studentId, itemRows, { params, asOf, today }) {
    const qids = itemRows.map(r => r.question_id);
    const histories = await fetchHistories(run, qids.map(q => [studentId, q]));
    const { groupOf } = await lookupGroups(run, qids, studentId);
    return itemRows.map(r => buildItemView(r, {
        history: histories.get(pairKey(studentId, r.question_id)),
        groupIds: groupOf.get(r.question_id) || null,
        params, asOf, today
    }));
}

/**
 * API-1：某生的錯題重練清單。
 *
 * @param {Function|{query:Function}} db
 * @param {number} studentId
 * @param {{status?:string, subject?:string|null, asOf?:string, today?:string, params?:object}} [opts]
 *   status：utils/retrainValidation.js 的 LIST_STATUSES（預設 active）；asOf 預設 today
 * @returns {Promise<null | {as_of:string, counts:object, items:object[]}>} 學生不存在回 null
 */
async function listItems(db, studentId, { status = 'active', subject = null, asOf, today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(db);
    const asOfDate = asOf || today;
    if (!(await studentExists(run, studentId))) return null;
    const rows = await fetchItemRows(run, studentId, { subject });
    const views = await viewsOf(run, studentId, rows, { params, asOf: asOfDate, today });
    const filter = LIST_FILTERS[status] || LIST_FILTERS.active;
    const items = orderUnits(views.filter(filter)).flatMap(u => u.items);
    return { as_of: asOfDate, counts: countViews(views), items };
}

/**
 * 一個項目的畫面資料（API-1 的一筆的形狀）。
 * @returns {Promise<object|null>} 項目不存在或不屬於該生回 null
 */
async function getItemView(db, studentId, itemId, { asOf, today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(db);
    const rows = await fetchItemRows(run, studentId, { itemIds: [itemId] });
    if (!rows.length) return null;
    const [view] = await viewsOf(run, studentId, rows, { params, asOf: asOf || today, today });
    return view;
}

/**
 * API-4：每位學生的到期、已派出、卡關、進行中題數（學生清單的徽章用；不回姓名）。
 * 只列有進行中項目的學生，依學生 id 排序。規則與 API-1 的 counts 相同（同一個 isDue）。
 *
 * @returns {Promise<{as_of:string, items:Array<{student_id:number, due:number, in_flight:number, stuck:number, active:number}>}>}
 */
async function summary(db, { asOf, today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(db);
    const asOfDate = asOf || today;
    const { rows } = await run(
        `SELECT i.student_id, i.question_id, i.lapses, ${D('i.entered_on')} AS entered_on, ${D('i.due_on')} AS due_on,
                (q.archived_at IS NOT NULL) AS archived
           FROM retrain_items i JOIN questions q ON q.id = i.question_id
          WHERE i.status = 'active'
          ORDER BY i.student_id, i.id`);
    // 還沒批改的派題（只取進行中項目的），已派出與否照 countsAsInFlight 判斷（與 API-1 同一條規則）
    const { rows: ungraded } = await run(
        `SELECT a.student_id, a.question_id, a.purpose, ${D('a.assigned_at')} AS assigned_at
           FROM assignment_attempts a
           JOIN retrain_items i ON i.student_id = a.student_id AND i.question_id = a.question_id AND i.status = 'active'
          WHERE a.result IS NULL`);
    const pendingByPair = new Map();
    for (const u of ungraded) {
        const key = pairKey(u.student_id, u.question_id);
        if (!pendingByPair.has(key)) pendingByPair.set(key, []);
        pendingByPair.get(key).push(u);
    }
    const byStudent = new Map();
    for (const r of rows) {
        const sid = Number(r.student_id);
        if (!byStudent.has(sid)) byStudent.set(sid, { student_id: sid, due: 0, in_flight: 0, stuck: 0, active: 0 });
        const s = byStudent.get(sid);
        const inFlight = (pendingByPair.get(pairKey(sid, r.question_id)) || [])
            .some(u => schedule.countsAsInFlight(u, r.entered_on));
        s.active += 1;
        if (inFlight) s.in_flight += 1;
        if (Number(r.lapses) >= params.stuckLapses) s.stuck += 1;
        if (!r.archived && schedule.isDue({ status: 'active', due_on: r.due_on, in_flight: inFlight }, asOfDate)) s.due += 1;
    }
    return { as_of: asOfDate, items: [...byStudent.values()] };
}

/**
 * 〔給 PR-3 出卷整合〕某生到期的重練題，依第 4.7 節排好、以承上組為單位（只讀）。
 *
 * 一個單位＝一個承上組（沒有綁定的題自成一組）。組內任一題到期（進行中、沒有已派出、到期日 ≤ asOf、沒封存）
 * 就整組列入；整組能不能出另外檢查，不能出的放 blocked（不會出現在 units）：
 *   not_in_schedule  組內有題目沒有排程項目（沒派給他過，或還沒加入清單）
 *   retired          組內有題目已移出清單
 *   archived         組內有題目已封存
 *   in_flight        組內有題目已派到還沒批改的卷
 * 已練到會的組員照常帶著出（設計稿第 4.4 節：答對維持練到會、答錯重新進行中）。
 *
 * 這裡**不**決定出幾題：上限（capForAttach、count）與「整組放不下就 400」（R12 選 2）由 PR-3 依 units 的順序逐組放入。
 *
 * @param {Function|{query:Function}} db
 * @param {number} studentId
 * @param {{asOf?:string, subject?:string|null, today?:string, params?:object}} [opts]
 * @returns {Promise<{as_of:string, due_total:number,
 *   units:Array<{group_ids:number[], size:number, due_count:number, overdue_days:number,
 *                items:Array<object>}>,
 *   blocked:Array<{group_ids:number[], reasons:Array<{question_id:number, reason:string}>}>}>}
 *   items 是組內每一題的畫面資料（API-1 一筆的形狀：item_id、step、step_label、due_on、overdue_days、chapter……）；
 *   due_total＝到期題數（逐題算，含 blocked 裡到期的題）
 */
async function listDueUnits(db, studentId, { asOf, subject = null, today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(db);
    const asOfDate = asOf || today;
    const rows = await fetchItemRows(run, studentId, { subject });
    const views = await viewsOf(run, studentId, rows, { params, asOf: asOfDate, today });
    const byQid = new Map(views.map(v => [v.question_id, v]));
    const units = [];
    const blocked = [];
    let dueTotal = 0;
    for (const u of orderUnits(views)) {
        const due = u.items.filter(v => v.due);
        dueTotal += due.length;
        if (!due.length) continue;
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
            overdue_days: Math.max(...due.map(v => v.overdue_days)),
            items: members
        });
    }
    return { as_of: asOfDate, due_total: dueTotal, units, blocked };
}

// ───────────────────────── 重算 ─────────────────────────

/**
 * 鎖住並重算符合條件的項目；只 UPDATE 快取真的有變的列。
 * @param {Function} run
 * @param {string} where  以 i 為別名的條件（參數從 $1 起）
 * @param {any[]} values
 * @param {object} params loadRetrainConfig()
 * @returns {Promise<Array<{item_id:number, student_id:number, question_id:number, before:object, after:object}>>}
 */
async function recomputeWhere(run, where, values, params) {
    const { rows: raw } = await run(
        `SELECT ${ITEM_COLUMNS} FROM retrain_items i WHERE ${where} ORDER BY i.id FOR UPDATE`, values);
    if (!raw.length) return [];
    const items = raw.map(toItemRow);
    // 另一句讀歷史：等鎖之後才取快照（見檔頭「併發」）
    const histories = await fetchHistories(run, items.map(it => [it.student_id, it.question_id]));
    const changes = [];
    const updates = [];
    for (const it of items) {
        const after = schedule.computeRetrainState({
            entered_on: it.entered_on,
            teacher_override: it.teacher_override,
            override_on: it.override_on,
            entered_after_assignment_id: it.entered_after_assignment_id,
            history: histories.get(pairKey(it.student_id, it.question_id)) || []
        }, params);
        const before = cacheOf(it);
        changes.push({ item_id: it.id, student_id: it.student_id, question_id: it.question_id, before, after });
        if (!sameCache(before, after)) updates.push({ id: it.id, ...cacheOf(after) });
    }
    if (updates.length) {
        await run(
            `UPDATE retrain_items i
                SET status = u.status, step = u.step, due_on = u.due_on, streak = u.streak, lapses = u.lapses,
                    last_attempt_on = u.last_attempt_on, mastered_on = u.mastered_on, updated_at = now()
               FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, status text, step smallint, due_on date,
                    streak smallint, lapses smallint, last_attempt_on date, mastered_on date)
              WHERE i.id = u.id`,
            [JSON.stringify(updates)]);
    }
    return changes;
}

/**
 * 重算某生的項目（questionIds 為 null 時重算他的全部項目）。呼叫端必須在交易內，與觸發它的寫入同一個交易。
 * @param {object} client 已 BEGIN 的 client
 * @param {number} studentId
 * @param {number[]|null} [questionIds]
 * @param {{params?:object}} [opts]
 * @returns {Promise<Array<{item_id, student_id, question_id, before, after}>>}
 */
async function recompute(client, studentId, questionIds = null, { params = loadRetrainConfig() } = {}) {
    if (Array.isArray(questionIds) && questionIds.length === 0) return [];
    return recomputeWhere(runnerOf(client), 'i.student_id = $1 AND ($2::int[] IS NULL OR i.question_id = ANY($2::int[]))',
        [studentId, questionIds ? [...new Set(questionIds)] : null], params);
}

/**
 * 重算一批 (學生, 題目) 的項目（刪卷時受影響的可能不只一位學生的資料列）。
 * @param {object} client
 * @param {Array<{student_id:number, question_id:number}>} pairs
 */
async function recomputePairs(client, pairs, { params = loadRetrainConfig() } = {}) {
    if (!pairs.length) return [];
    return recomputeWhere(runnerOf(client),
        '(i.student_id, i.question_id) IN (SELECT * FROM unnest($1::int[], $2::int[]))',
        [pairs.map(p => p.student_id), pairs.map(p => p.question_id)], params);
}

/**
 * 重算全部項目（或某位學生的全部項目）：npm run retrain:recompute 用。只重算、不建立任何項目（R11 選 3）。
 * @param {object} client
 * @param {{studentId?:number|null, params?:object}} [opts]
 */
async function recomputeAll(client, { studentId = null, params = loadRetrainConfig() } = {}) {
    return recomputeWhere(runnerOf(client), '($1::int IS NULL OR i.student_id = $1)', [studentId], params);
}

/** 鎖住某生這些題目的項目（依 id 排序），回 question_id → 項目。 */
async function lockItems(run, studentId, questionIds) {
    if (!questionIds.length) return new Map();
    const { rows } = await run(
        `SELECT ${ITEM_COLUMNS} FROM retrain_items i
          WHERE i.student_id = $1 AND i.question_id = ANY($2::int[]) ORDER BY i.id FOR UPDATE`,
        [studentId, [...new Set(questionIds)]]);
    return new Map(rows.map(r => [Number(r.question_id), toItemRow(r)]));
}

/** 這些項目裡「重練過」（有任何重練派題）的 id。 */
async function retrainedItemIds(run, itemIds) {
    if (!itemIds.length) return new Set();
    const { rows } = await run(
        'SELECT DISTINCT retrain_item_id FROM assignments WHERE retrain_item_id = ANY($1::bigint[])', [itemIds]);
    return new Set(rows.map(r => Number(r.retrain_item_id)));
}

/** 該生這些題目的「新題」派題（項目的 source）。回 question_id → { id, assigned_at }。 */
async function newAssignmentsOf(run, studentId, questionIds) {
    if (!questionIds.length) return new Map();
    const { rows } = await run(
        `SELECT id, question_id, ${D('assigned_at')} AS assigned_at FROM assignments
          WHERE student_id = $1 AND purpose = 'new' AND question_id = ANY($2::int[])`,
        [studentId, [...new Set(questionIds)]]);
    return new Map(rows.map(r => [Number(r.question_id), { id: Number(r.id), assigned_at: r.assigned_at }]));
}

/**
 * 建立項目（ON CONFLICT DO NOTHING：同時有別的交易建了同一題時不報錯，由呼叫端當成「已經有了」）。
 * 快取先填第 1 關的初值（滿足 retrain_items_due_check），呼叫端之後一定會重算。
 * @param {Array<{question_id:number, source_assignment_id:number, reason:string, entered_on:string}>} rows
 * @returns {Promise<Map<number, number>>} 實際建立的 question_id → item_id
 */
async function insertItems(run, studentId, rows, params) {
    if (!rows.length) return new Map();
    const payload = rows.map(r => ({ ...r, due_on: schedule.addDays(r.entered_on, params.stepDays[0]) }));
    const { rows: ins } = await run(
        `INSERT INTO retrain_items (student_id, question_id, source_assignment_id, reason, entered_on, due_on)
         SELECT $1::int, r.question_id, r.source_assignment_id, r.reason, r.entered_on, r.due_on
           FROM jsonb_to_recordset($2::jsonb) AS r(question_id int, source_assignment_id bigint, reason text,
                entered_on date, due_on date)
         ON CONFLICT (student_id, question_id) DO NOTHING
         RETURNING id, question_id`,
        [studentId, JSON.stringify(payload)]);
    return new Map(ins.map(r => [Number(r.question_id), Number(r.id)]));
}

/**
 * 重新加入：清掉 override、起算日改成 today（錯的次數不歸零，由重算從歷史算出）。
 * 同時記下這一刻這位學生這一題已有的最大派題編號（entered_after_assignment_id；沒有派題時 0）：
 * 純函式把「派題日＝起算日、編號 ≤ 它」的重練派題算成前一輪（services/retrainSchedule.js 規則 8），
 * 同一天先批改當天的重練、再按重新加入，也是從第 1 關、連對 0 開始（設計稿第 4.4 節的已知邊界）。
 */
async function reactivateItems(run, itemIds, today) {
    if (!itemIds.length) return;
    await run(
        `UPDATE retrain_items i
            SET teacher_override = NULL, override_on = NULL, entered_on = $2::date,
                entered_after_assignment_id = (SELECT COALESCE(MAX(a.id), 0) FROM assignments a
                                                WHERE a.student_id = i.student_id AND a.question_id = i.question_id),
                updated_at = now()
          WHERE i.id = ANY($1::bigint[])`,
        [itemIds, today]);
}

/** 移出：teacher_override = retired（已經移出的不動，保留原本的日期）。 */
async function retireItems(run, itemIds, today) {
    if (!itemIds.length) return;
    await run(
        `UPDATE retrain_items SET teacher_override = 'retired', override_on = $2::date, updated_at = now()
          WHERE id = ANY($1::bigint[]) AND teacher_override IS DISTINCT FROM 'retired'`,
        [itemIds, today]);
}

// ───────────────────────── 批改（API-10）─────────────────────────

/**
 * 批改卡「要重練」勾選的準備（只讀、在寫入之前呼叫）：找出勾選的題所在的承上組，以及組內曾以新題派給該生的題。
 *
 * @param {object} client
 * @param {{studentId:number, flags:Array<{question_id:number, retrain:boolean, assigned_at:string}>}} p
 *   flags 的每一題都已確認是這張卷上的「新題」派題（assigned_at＝那一筆的派題日）
 * @returns {Promise<{plan:{studentId:number, groups:Array<{group_ids:number[], members:number[],
 *           flags:Array<{question_id:number, retrain:boolean, assigned_at:string}>}>, questionIds:number[]}}>}
 *   members＝組內曾以新題派給該生的題（只有這些題能有項目，不變量 I1）；questionIds＝全部 members
 */
async function planGradingFlags(client, { studentId, flags }) {
    const run = runnerOf(client);
    if (!flags.length) return { plan: { studentId, groups: [], questionIds: [] } };
    const { rows, groupOf } = await lookupGroups(run, flags.map(f => f.question_id), studentId);
    const answered = new Set(rows.filter(r => r.answered).map(r => r.id));
    const byKey = new Map();
    for (const f of flags) {
        const g = groupOf.get(f.question_id) || [f.question_id];
        const key = g.join(',');
        if (!byKey.has(key)) byKey.set(key, { group_ids: g, members: g.filter(id => answered.has(id)), flags: [] });
        byKey.get(key).flags.push(f);
    }
    const groups = [...byKey.values()];
    return { plan: { studentId, groups, questionIds: [...new Set(groups.flatMap(g => g.members))] } };
}

/** 項目在清單上（沒被移出）而且是老師勾的。 */
const isActiveFlag = it => it && it.reason === 'flagged' && it.teacher_override !== 'retired';

/**
 * 套用批改卡的勾選並重算（與批改的 UPDATE 同一個交易，放在 UPDATE 之後）。
 *
 * 規則（R1 選 2；承上組以組為單位進出清單，retrain_flagged 只反映老師親手勾的題）：
 *   勾（true）：這一題沒有項目 → 建立 reason = flagged（起算日＝這一筆新題派題的派題日）；已有項目 → 改成 flagged，
 *               已移出的等同重新加入（起算日＝today）。同組其他題（曾以新題派給他的）沒有項目 → 建立 reason = group
 *               （起算日同勾選的那一題）；已移出的一起重新加入；其餘不動。
 *   取消（false）：只作用在 reason = flagged 而且沒移出的項目（manual、group 的項目不受批改卡影響）：
 *               同組還有別題維持勾選 → 這一題改成 group（整組仍在清單上）；
 *               同組已經沒有任何勾選 → 這一題與同組 reason = group 的項目一起離開清單：
 *               還沒重練過就刪掉，重練過就移出（retired，保留紀錄）。手動加入（manual）的不動。
 *   最後重算 questionIds（這張卷上這位學生被批改的題）與組內動到的題。
 *
 * @param {object} client 已 BEGIN
 * @param {{studentId:number, questionIds:number[], plan?:object|null, today?:string, params?:object}} p
 * @returns {Promise<{entered:number, advanced:number, mastered:number, reset:number}>}
 */
async function applyGrading(client, { studentId, questionIds, plan = null, today = todayLocal(), params = loadRetrainConfig() }) {
    const run = runnerOf(client);
    const entered = new Set();
    const touched = new Set(questionIds);
    for (const g of (plan ? plan.groups : [])) {
        g.members.forEach(q => touched.add(q));
        const memberSet = new Set(g.members);
        const flagsIn = g.flags.filter(f => memberSet.has(f.question_id));
        const on = flagsIn.filter(f => f.retrain);
        const off = new Set(flagsIn.filter(f => !f.retrain).map(f => f.question_id));
        const sources = await newAssignmentsOf(run, studentId, g.members);

        // ① 勾選：這一題 flagged、同組其他題 group
        if (on.length) {
            const onIds = new Set(on.map(f => f.question_id));
            const groupEnteredOn = on.map(f => f.assigned_at).sort()[0];
            const existing = await lockItems(run, studentId, g.members);
            const toInsert = [];
            const toReactivate = [];
            const toFlag = [];
            for (const q of g.members) {
                const it = existing.get(q);
                if (!it) {
                    if (!sources.has(q)) continue;
                    toInsert.push({ question_id: q, source_assignment_id: sources.get(q).id,
                        reason: onIds.has(q) ? 'flagged' : 'group',
                        entered_on: onIds.has(q) ? on.find(f => f.question_id === q).assigned_at : groupEnteredOn });
                    continue;
                }
                if (it.teacher_override === 'retired') toReactivate.push(it.id);
                if (onIds.has(q) && it.reason !== 'flagged') toFlag.push(it.id);
            }
            const inserted = await insertItems(run, studentId, toInsert, params);
            inserted.forEach(id => entered.add(id));
            // 同時有別的交易先建好了同一題（ON CONFLICT 沒寫進去）：當成「已經有了」
            const missed = toInsert.filter(r => !inserted.has(r.question_id));
            if (missed.length) {
                const now = await lockItems(run, studentId, missed.map(r => r.question_id));
                for (const r of missed) {
                    const it = now.get(r.question_id);
                    if (!it) continue;
                    if (it.teacher_override === 'retired') toReactivate.push(it.id);
                    if (r.reason === 'flagged' && it.reason !== 'flagged') toFlag.push(it.id);
                }
            }
            if (toFlag.length) {
                await run(`UPDATE retrain_items SET reason = 'flagged', updated_at = now() WHERE id = ANY($1::bigint[])`, [toFlag]);
            }
            await reactivateItems(run, toReactivate, today);
            toReactivate.forEach(id => entered.add(id));
        }

        // ② 取消勾選：只動老師勾過、還在清單上的項目
        if (off.size) {
            const current = await lockItems(run, studentId, g.members);
            const targets = [...off].map(q => current.get(q)).filter(isActiveFlag);
            if (targets.length) {
                const stillFlagged = g.members.some(q => !off.has(q) && isActiveFlag(current.get(q)));
                if (stillFlagged) {
                    await run(`UPDATE retrain_items SET reason = 'group', updated_at = now() WHERE id = ANY($1::bigint[])`,
                        [targets.map(it => it.id)]);
                } else {
                    const leaving = [
                        ...targets,
                        ...g.members.map(q => current.get(q))
                            .filter(it => it && it.reason === 'group' && it.teacher_override !== 'retired')
                    ].map(it => it.id);
                    const retrained = await retrainedItemIds(run, leaving);
                    await retireItems(run, leaving.filter(id => retrained.has(id)), today);
                    const toDelete = leaving.filter(id => !retrained.has(id));
                    if (toDelete.length) await run('DELETE FROM retrain_items WHERE id = ANY($1::bigint[])', [toDelete]);
                }
            }
        }
    }
    const changes = await recompute(client, studentId, [...touched], { params });
    return summarizeChanges(changes, entered);
}

/**
 * 批改前先鎖住這張卷上這位學生的項目（在 UPDATE 作答之前）：與刪卷、出卷一致地「先鎖項目、再動派題與作答」，
 * 避免兩邊各拿一半的鎖而死結。
 */
async function lockForGrading(client, studentId, questionIds) {
    await lockItems(runnerOf(client), studentId, questionIds);
}

// ───────────────────────── 清單動作（API-2、API-3）─────────────────────────

/**
 * API-2：以題號手動加入（reason = manual，起算日＝today；承上組同組題以 group 一起加）。
 * 只收曾經以新題派給他的題（I1）。開啟功能以前的錯題也從這裡加（R11 選 3）。不改動已經存在的項目。
 *
 * @param {object} client 已 BEGIN
 * @param {number} studentId（呼叫端已確認學生存在）
 * @param {number[]} questionIds 不重複
 * @returns {Promise<{added:Array<{question_id:number, item_id:number, reason:'manual'|'group'}>,
 *                    skipped:Array<{question_id:number, reason:'not_assigned'|'already_in_schedule'|'archived'|'missing'}>}>}
 */
async function addManual(client, studentId, questionIds, { today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(client);
    const { rows, groupOf } = await lookupGroups(run, questionIds, studentId);
    const byId = new Map(rows.map(r => [r.id, r]));
    const allIds = [...new Set(rows.map(r => r.id))];
    const existing = await lockItems(run, studentId, allIds);
    const sources = await newAssignmentsOf(run, studentId, allIds);

    const skipped = [];
    const primaries = [];
    for (const q of questionIds) {
        const r = byId.get(q);
        if (!r) skipped.push({ question_id: q, reason: 'missing' });
        else if (r.archived) skipped.push({ question_id: q, reason: 'archived' });
        else if (!sources.has(q)) skipped.push({ question_id: q, reason: 'not_assigned' });
        else if (existing.has(q)) skipped.push({ question_id: q, reason: 'already_in_schedule' });
        else primaries.push(q);
    }
    const primarySet = new Set(primaries);
    const groupMembers = [];
    for (const q of primaries) {
        for (const m of groupOf.get(q) || [q]) {
            if (primarySet.has(m) || groupMembers.includes(m) || existing.has(m) || !sources.has(m)) continue;
            groupMembers.push(m);
        }
    }
    const toInsert = [
        ...primaries.map(q => ({ question_id: q, source_assignment_id: sources.get(q).id, reason: 'manual', entered_on: today })),
        ...groupMembers.map(q => ({ question_id: q, source_assignment_id: sources.get(q).id, reason: 'group', entered_on: today }))
    ];
    const inserted = await insertItems(run, studentId, toInsert, params);
    const added = [];
    for (const r of toInsert) {
        if (inserted.has(r.question_id)) added.push({ question_id: r.question_id, item_id: inserted.get(r.question_id), reason: r.reason });
        else if (r.reason === 'manual') skipped.push({ question_id: r.question_id, reason: 'already_in_schedule' });
    }
    // skipped 依請求順序
    const order = new Map(questionIds.map((q, i) => [q, i]));
    skipped.sort((a, b) => order.get(a.question_id) - order.get(b.question_id));
    await recompute(client, studentId, added.map(a => a.question_id), { params });
    return { added, skipped };
}

/**
 * API-3：移出、判定已會、重新加入。
 *
 *   retire         移出（teacher_override = retired、override_on = today）；承上組整組一起移出。
 *   mark_mastered  判定已會（teacher_override = mastered）；只動這一題（已會的組員照樣會被帶著出）。
 *   reactivate     重新加入：清掉 override、起算日改成 today，從第 1 關重來，錯的次數不歸零；
 *                  同組已移出的題一起重新加入。已經在進行中、沒有 override 的題回 409（不必重新加入）。
 *   note           有送就改這一題的備註（null＝清空）。
 *
 * @param {object} client 已 BEGIN
 * @param {number} studentId
 * @param {number} itemId
 * @param {{action:string, hasNote?:boolean, note?:string|null}} body utils/retrainValidation.parseActionBody 的結果
 * @returns {Promise<{status:404} | {status:409, message:string} |
 *                   {status:200, item:object, group_changed:Array<{item_id:number, question_id:number}>}>}
 */
async function applyAction(client, studentId, itemId, { action, hasNote = false, note = null }, { today = todayLocal(), params = loadRetrainConfig() } = {}) {
    const run = runnerOf(client);
    const { rows: [raw] } = await run(
        `SELECT ${ITEM_COLUMNS} FROM retrain_items i WHERE i.id = $1 AND i.student_id = $2 FOR UPDATE`, [itemId, studentId]);
    if (!raw) return { status: 404 };
    const item = toItemRow(raw);

    let groupItems = [];
    if (action !== 'mark_mastered') {
        const { groupOf } = await lookupGroups(run, [item.question_id], studentId);
        const others = (groupOf.get(item.question_id) || [item.question_id]).filter(q => q !== item.question_id);
        groupItems = [...(await lockItems(run, studentId, others)).values()];
    }

    const changed = [];
    if (action === 'retire') {
        const targets = [item, ...groupItems].filter(it => it.teacher_override !== 'retired');
        await retireItems(run, targets.map(it => it.id), today);
        changed.push(...targets.filter(it => it.id !== item.id));
    } else if (action === 'mark_mastered') {
        if (item.teacher_override !== 'mastered') {
            await run(
                `UPDATE retrain_items SET teacher_override = 'mastered', override_on = $2::date, updated_at = now()
                  WHERE id = $1`, [item.id, today]);
        }
    } else if (action === 'reactivate') {
        if (item.status === 'active' && item.teacher_override === null) {
            return { status: 409, message: '這一題正在重練中，不需要重新加入。' };
        }
        const others = groupItems.filter(it => it.teacher_override === 'retired');
        await reactivateItems(run, [item.id, ...others.map(it => it.id)], today);
        changed.push(...others);
    }
    if (hasNote) {
        await run('UPDATE retrain_items SET note = $2, updated_at = now() WHERE id = $1', [item.id, note]);
    }
    await recompute(client, studentId, [item.question_id, ...changed.map(it => it.question_id)], { params });
    const view = await getItemView(client, studentId, item.id, { today, params });
    return {
        status: 200,
        item: view,
        group_changed: changed.map(it => ({ item_id: it.id, question_id: it.question_id }))
    };
}

// ───────────────────────── 出卷（給 PR-3）─────────────────────────

/**
 * 〔給 PR-3 的 API-6／API-7〕在出卷交易內寫重練派題（purpose = retrain、retrain_item_id、retrain_step＝當下關卡），
 * 每一筆派題同時建一筆空白作答，最後重算這些項目。
 *
 * 先 `SELECT … FOR UPDATE` 鎖住項目，再逐題檢查（不變量 I6：同一個項目不會同時派到兩張還沒批改的卷）：
 *   屬於這位學生、狀態是進行中或已練到會（被承上組帶著出）、沒有任何一筆還沒批改的派題。
 * 不符合就回 conflict，**不寫任何東西**；呼叫端應 ROLLBACK 並回 409 retrainConflictMessage(question_id)。
 * 兩個出卷交易同時搶同一個項目時，後拿到鎖的那一個會看到前一個已提交的派題（還沒批改）而回 conflict。
 *
 * 呼叫前 exam_papers 那一列必須已經寫好（assignments.paper_id 的外鍵）；新題派題照舊走
 * examController.buildInsertNewAssignmentsSql。這裡不檢查承上組完整性（confirm-paper 的 B7 檢查負責）。
 *
 * @param {object} client 已 BEGIN
 * @param {{studentId:number, paperId:number, assignedAt:string, questionIds:number[], params?:object}} p
 * @returns {Promise<{conflict:{question_id:number, reason:'not_in_schedule'|'retired'|'in_flight'}} |
 *                   {conflict:null, rows:Array<{question_id:number, item_id:number, assignment_id:number, retrain_step:number}>}>}
 */
async function insertRetrainAssignments(client, { studentId, paperId, assignedAt, questionIds, params = loadRetrainConfig() }) {
    const run = runnerOf(client);
    if (!questionIds.length) return { conflict: null, rows: [] };
    const items = await lockItems(run, studentId, questionIds);
    // 另一句讀歷史（等鎖之後才取快照）：已派出與否照 countsAsInFlight 判斷（與 API-1 同一條規則）
    const histories = await fetchHistories(run, [...items.values()].map(it => [studentId, it.question_id]));
    for (const q of questionIds) {
        const it = items.get(q);
        if (!it) return { conflict: { question_id: q, reason: 'not_in_schedule' } };
        if (it.status === 'retired') return { conflict: { question_id: q, reason: 'retired' } };
        if (pendingOf(histories.get(pairKey(studentId, q)), it.entered_on).length > 0) {
            return { conflict: { question_id: q, reason: 'in_flight' } };
        }
    }
    const payload = questionIds.map(q => ({ question_id: q, item_id: items.get(q).id, step: items.get(q).step }));
    const { rows: ins } = await run(
        `WITH ins AS (
             INSERT INTO assignments (student_id, question_id, paper_id, assigned_at, purpose, retrain_item_id, retrain_step)
             SELECT $1::int, r.question_id, $2::int, $3::date, 'retrain', r.item_id, r.step
               FROM jsonb_to_recordset($4::jsonb) AS r(question_id int, item_id bigint, step smallint)
             RETURNING id, question_id, retrain_item_id, retrain_step
         ), rec AS (
             INSERT INTO attempt_records (assignment_id) SELECT id FROM ins
         )
         SELECT id, question_id, retrain_item_id, retrain_step FROM ins`,
        [studentId, paperId, assignedAt, JSON.stringify(payload)]);
    await recompute(client, studentId, questionIds, { params });
    return {
        conflict: null,
        rows: ins.map(r => ({
            question_id: Number(r.question_id), item_id: Number(r.retrain_item_id),
            assignment_id: Number(r.id), retrain_step: Number(r.retrain_step)
        }))
    };
}

// ───────────────────────── 刪卷、刪學生、合併（第 3.9 節）─────────────────────────

/**
 * 刪卷前先鎖住這張卷相關的項目（以卷上新題派題為來源的、卷上重練派題所屬的），再查擋路的重練派題：
 * 等鎖之後的查詢看得到別的交易剛提交的重練派題，不會刪掉一個剛被重練的項目。
 */
async function lockItemsForPaper(client, paperId) {
    await runnerOf(client)(
        `SELECT i.id FROM retrain_items i
          WHERE i.source_assignment_id IN (SELECT id FROM assignments WHERE paper_id = $1 AND purpose = 'new')
             OR i.id IN (SELECT retrain_item_id FROM assignments WHERE paper_id = $1 AND purpose = 'retrain')
          ORDER BY i.id FOR UPDATE`, [paperId]);
}

/**
 * 刪掉一張卷的全部派題（作答跟著 CASCADE）與以卷上新題派題為來源的項目，並重算受影響的項目。
 * 呼叫前必須已經確認沒有擋路的重練派題（examController 的 buildRetrainBlockersSql），所以這些項目都還沒重練過
 * （老師的勾選跟著那張卷一起消失）。刪的是重練卷時，受影響的項目依剩下的作答歷史重算（等於那次重練沒發生過）。
 *
 * @param {object} client 已 BEGIN
 * @param {number} paperId
 * @returns {Promise<{deleted:number}>} 刪掉幾筆派題（deleted_attempts 的語意）
 */
async function deletePaperAssignments(client, paperId, { params = loadRetrainConfig() } = {}) {
    const run = runnerOf(client);
    const retrain = await run(
        `DELETE FROM assignments WHERE paper_id = $1 AND purpose = 'retrain' RETURNING student_id, question_id`, [paperId]);
    await run(
        `DELETE FROM retrain_items
          WHERE source_assignment_id IN (SELECT id FROM assignments WHERE paper_id = $1 AND purpose = 'new')`, [paperId]);
    const rest = await run('DELETE FROM assignments WHERE paper_id = $1', [paperId]);
    await recomputePairs(client, retrain.rows.map(r => ({ student_id: r.student_id, question_id: r.question_id })), { params });
    return { deleted: retrain.rowCount + rest.rowCount };
}

/**
 * 刪學生的前半（第 3.9 節）：依序刪重練派題 → 排程項目。其餘派題、卷、學生由呼叫端照舊刪。
 * @returns {Promise<number>} 刪掉的重練派題筆數（計入 deleted.attempts）
 */
async function deleteStudentRetrainData(client, studentId) {
    const run = runnerOf(client);
    const r = await run(`DELETE FROM assignments WHERE student_id = $1 AND purpose = 'retrain'`, [studentId]);
    await run('DELETE FROM retrain_items WHERE student_id = $1', [studentId]);
    return r.rowCount;
}

/** 合併學生：交易內把兩個複合外鍵延後到 COMMIT 才檢查（要同時改 assignments 與 retrain_items 的 student_id）。 */
async function deferRetrainConstraints(client) {
    await runnerOf(client)(`SET CONSTRAINTS ${DEFERRABLE_CONSTRAINTS.join(', ')} DEFERRED`);
}

/**
 * 合併學生的排程項目（同一交易，已呼叫 deferRetrainConstraints）：
 *   衝突題（目標已有這一題的新題派題）→ 來源側的項目刪掉；其餘項目搬到目標學生。
 *
 * **呼叫時機**：刪掉來源側衝突題的派題之後、把其餘派題搬到目標學生**之前**——「目標有沒有這一題的新題派題」
 * 必須只看目標原本的派題；搬完再判斷，來源側搬過去的新題派題也會被當成衝突。
 * 派題搬完之後，呼叫端再以回傳的題號呼叫 recompute(client, intoId, questionIds)（最後重算目標學生受影響的項目）。
 *
 * @returns {Promise<number[]>} 搬到目標學生的項目的題號
 */
async function mergeRetrainItems(client, fromId, intoId) {
    const run = runnerOf(client);
    await run(
        `DELETE FROM retrain_items i
          WHERE i.student_id = $1
            AND EXISTS (SELECT 1 FROM assignments b
                         WHERE b.student_id = $2 AND b.question_id = i.question_id AND b.purpose = 'new')`,
        [fromId, intoId]);
    const { rows } = await run(
        'UPDATE retrain_items SET student_id = $2, updated_at = now() WHERE student_id = $1 RETURNING question_id',
        [fromId, intoId]);
    return rows.map(r => Number(r.question_id));
}

module.exports = {
    IN_FLIGHT_WARN_DAYS,
    DEFERRABLE_CONSTRAINTS,
    retrainConflictMessage,
    todayLocal,
    // 純函式
    pendingOf,
    stepLabel,
    priorityKey,
    orderUnits,
    countViews,
    buildItemView,
    summarizeChanges,
    LIST_FILTERS,
    // 讀取（API-1、API-4；PR-3／PR-4）
    listItems,
    getItemView,
    summary,
    listDueUnits,
    fetchHistories,
    // 重算
    recompute,
    recomputePairs,
    recomputeAll,
    // 批改（API-10）
    planGradingFlags,
    lockForGrading,
    applyGrading,
    // 清單動作（API-2、API-3）
    addManual,
    applyAction,
    // 出卷（PR-3）
    insertRetrainAssignments,
    // 刪卷、刪學生、合併
    lockItemsForPaper,
    deletePaperAssignments,
    deleteStudentRetrainData,
    deferRetrainConstraints,
    mergeRetrainItems
};
