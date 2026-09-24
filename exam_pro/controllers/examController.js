const { pool, query } = require('../config/db');
const { pickPaperUnits, sortForPaperGrouped } = require('../utils/paperGroups');
// 〔stage5 WS-D〕pg 序列化查詢參數的同一支函式（pg 的 package.json exports 公開 ./lib/*）：
// 單章路徑用它把 chapter 轉成與抽出前 `q.chapter = $2` 相同的比對字串（見 selectPaperQuestions）
const { prepareValue } = require('pg/lib/utils');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章
const MAX_EXCLUDE = 200;  // 換一題／重抽的排除清單上限（roadmap-plan.md §6.2.2）

/**
 * 承上題整組抽取湊不到剛好 N 題時的政策（FR-019 PR2；**待 owner 決定**，單點切換）：
 *   'note'  （預設）少出題，200 回應附 shortfall＋note 說明實際題數與原因
 *   'error' 回 400，請老師調整題數
 * 例：要 5 題，抽到 4 題後剩下的組都是 2 題一組。
 * 「真的庫存不足」（可用題數 < N）不受此政策影響，照舊回 400。
 */
const FOLLOW_UP_SHORTFALL_POLICY = 'note';

// ─────────────────────────────────────────────────────────────
// 智慧組卷（D-D4 重寫；階段 4 W1-1/W1-2 改契約，docs/roadmap-plan.md §6.2.2）
//
// 與 D-D4 版的三個差異（其餘照舊）：
//   1. 裁決 S4-1：**不再自動建學生**。收 student_id（優先）或 student_name（相容），
//      查無此人一律 404——「打名字自動建學生」正是垃圾人名（小／名／華）分裂
//      不重複出題紀錄的根因，建學生從此只有 POST /api/students 一個入口。
//   2. dry_run: true → 走完全相同的選題邏輯但**整段不寫庫**（不建卷、不寫 attempts），
//      回預覽。前端的「生成」一律先走這裡，看過才確認。
//   3. exclude_ids: int[] → 候選池額外排除（「換一題」把那題加進來再叫一次；
//      「整卷重抽」同參數重叫，洗牌自然給出不同組合）。
//
// 舊有的硬閘門不變：
//   候選池   NOT EXISTS (SELECT 1 FROM attempts …)（不是 NOT IN，NULL 語意才不會咬人）
//   寫入     UNIQUE (student_id, question_id)＋rowCount 檢查——兩個請求同時抽到同一題時，
//            後者整筆交易回滾並回 409，而不是悄悄少記一題。
// ─────────────────────────────────────────────────────────────

/**
 * 考卷內的排序：題型權重 → 難度（generate 與 confirm 共用，兩邊順序才一致）。
 * 承上題組（FR-019）以組為單位、依組首題排序，組內依承接順序相鄰；
 * 題目須帶 follows_question_id。沒有綁定時與舊版逐題排序結果相同。
 */
const sortForPaper = sortForPaperGrouped;

/** 標題與 assigned_at 都用**本地時區**（toISOString 是 UTC，台灣早上 8 點前會差一天）。 */
function localDates() {
    const d = new Date();
    return {
        titleDate: `${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`,
        todayStr: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    };
}

/**
 * 解析學生（S4-1：只查、不建）。
 * @returns {Promise<{student:{id:number,name:string}|null, error:{status:number,message:string}|null}>}
 */
async function resolveStudent({ student_id, student_name }) {
    if (student_id !== undefined && student_id !== null) {
        const id = Number.parseInt(student_id, 10);
        if (!Number.isInteger(id) || id < 1) return { student: null, error: { status: 400, message: 'student_id 無效。' } };
        const { rows } = await query('SELECT id, name FROM students WHERE id = $1', [id]);
        if (rows.length === 0) return { student: null, error: { status: 404, message: '找不到該學生' } };
        return { student: rows[0], error: null };
    }
    const trimmedName = String(student_name ?? '').trim();
    if (!trimmedName) return { student: null, error: { status: 400, message: '學生姓名無效！' } };
    const { rows } = await query('SELECT id, name FROM students WHERE name = $1', [trimmedName]);
    if (rows.length === 0) {
        return { student: null, error: { status: 404, message: `查無學生「${trimmedName}」，請先新增學生。` } };
    }
    return { student: rows[0], error: null };
}

// ─────────────────────────────────────────────────────────────
// 候選池（〔stage5 WS-D〕從 selectPaperQuestions 抽出來的唯一真相；docs/interfaces-stage5.md 第 4.4 條）
//
// 單章組卷、跨章配額（blueprint）與補救卷（services/remedialService.js）共用同一段 SQL：
// 「未封存、該生沒寫過、不在排除清單、題源符合、同科」這五條排除規則只寫在這裡一次，
// 新路徑不另寫一套會漂移的排除邏輯。新路徑額外可以限章節清單、難度區間與知識點。
// 單章路徑呼叫時 chapters=[chapter]、其餘新條件全為 NULL，語意與抽出前的 SQL 相同。
// ─────────────────────────────────────────────────────────────

/**
 * 組出候選池 SQL（純函式，可離線單測參數順序）。
 *
 * 參數順序凍結：$1 subject、$2 chapters、$3 studentId、$4 excludeIds、$5 sourceTypes、
 * $6 difficultyMin、$7 difficultyMax、$8 kcIds。NULL 表示該條件不限制。
 *
 * @param {object} p
 * @param {string} p.subject
 * @param {number} p.studentId
 * @param {string[]|null} [p.chapters]      null＝不限章
 * @param {number[]} [p.excludeIds]
 * @param {string[]|null} [p.sourceTypes]   null＝不限題源
 * @param {number|null} [p.difficultyMin]
 * @param {number|null} [p.difficultyMax]
 * @param {number[]|null} [p.kcIds]         非 null 時只收「掛了其中任一知識點」的題（question_kcs）
 * @returns {{text:string, values:any[]}}
 */
function buildCandidatePoolQuery({ subject, studentId, chapters = null, excludeIds = [], sourceTypes = null,
    difficultyMin = null, difficultyMax = null, kcIds = null }) {
    return {
        text: `SELECT q.id, q.variant_of, q.follows_question_id, q.chapter, q.difficulty FROM questions q
          WHERE q.subject = $1 AND ($2::text[] IS NULL OR q.chapter = ANY($2::text[])) AND q.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $3)
            AND NOT (q.id = ANY($4::int[]))
            AND ($5::text[] IS NULL OR q.source_type = ANY($5::text[]))
            AND ($6::int IS NULL OR q.difficulty >= $6::int)
            AND ($7::int IS NULL OR q.difficulty <= $7::int)
            AND ($8::int[] IS NULL OR EXISTS (SELECT 1 FROM question_kcs qk
                                               WHERE qk.question_id = q.id AND qk.kc_id = ANY($8::int[])))`,
        values: [subject, chapters, studentId, excludeIds, sourceTypes, difficultyMin, difficultyMax, kcIds]
    };
}

/**
 * 候選池＋候選題所在承上組的完整成員（pickPaperUnits 的兩個輸入）。
 * @param {Parameters<typeof buildCandidatePoolQuery>[0]} opts
 * @returns {Promise<{candidates:object[], related:object[]}>}
 */
async function fetchCandidatePool(opts) {
    const { text, values } = buildCandidatePoolQuery(opts);
    const { rows: candidates } = await query(text, values);

    // 候選題所在承上組的完整成員（含不在候選池的題，用來判斷整組是否可用）。
    // 無向走訪 follows_question_id：往下找承上題、往上找前題；UNION 去重，資料有環也會停。
    // 只回有綁定關係的列——沒有綁定的候選題已在 candidates 裡。
    let related = [];
    if (candidates.length > 0) {
        ({ rows: related } = await query(
            `WITH RECURSIVE grp(id) AS (
                 SELECT unnest($1::int[])
                 UNION
                 SELECT CASE WHEN q.id = g.id THEN q.follows_question_id ELSE q.id END
                   FROM questions q JOIN grp g
                     ON q.follows_question_id = g.id
                     OR (q.id = g.id AND q.follows_question_id IS NOT NULL)
             )
             SELECT q.id, q.follows_question_id FROM questions q JOIN grp g ON g.id = q.id
              WHERE q.follows_question_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM questions c WHERE c.follows_question_id = q.id)`,
            [candidates.map(c => c.id)]
        ));
    }
    return { candidates, related };
}

/**
 * 多段配額選題（**只讀不寫**；〔stage5 WS-D〕跨章 blueprint 與補救卷共用）。
 *
 * 依 quotas 的順序逐段抽：每段各跑一次候選池，再走同一個 pickPaperUnits（家族互斥＋承上題整組）。
 * 跨段仍維持整張卷的規則：
 *   - 前面段已抽中的題，後面段不再抽（同一題可能同時符合兩段，例如同章不同難度區間、或掛兩個知識點）。
 *   - 前面段已占用的變式家族，後面段整組跳過——同一 variant_of 家族在一張卷至多一題。
 * 承上組內任一題被前面段占用或家族相撞時，該組在 candidates 裡就少了那一題，
 * pickPaperUnits 會依「組內任一題不可用，整組不抽」把它丟掉（不會出孤兒承上題）。
 *
 * 不足量不在這裡判斷對錯，只回報每段的 got 與 availableCount，由呼叫端決定要 400 還是附註。
 *
 * @param {object} p
 * @param {number} p.studentId
 * @param {string} p.subject
 * @param {Array<{count:number, pool:{chapters?:string[]|null, kcIds?:number[]|null,
 *                difficultyMin?:number|null, difficultyMax?:number|null}}>} p.quotas
 * @param {number[]} [p.excludeIds]
 * @param {string[]|null} [p.sourceTypes]
 * @param {(items:Array)=>Array} [p.shuffleFn]
 * @returns {Promise<Array<{ids:number[], got:number, availableCount:number}>>} 與 quotas 一一對應
 */
async function pickByQuotas({ studentId, subject, quotas, excludeIds = [], sourceTypes = null, shuffleFn }) {
    const usedIds = new Set();
    const usedFamilies = new Set();
    const results = [];
    for (const quota of quotas) {
        if (!(quota.count > 0)) { results.push({ ids: [], got: 0, availableCount: 0 }); continue; }
        const { candidates, related } = await fetchCandidatePool({
            subject, studentId, excludeIds, sourceTypes,
            chapters: quota.pool.chapters ?? null,
            kcIds: quota.pool.kcIds ?? null,
            difficultyMin: quota.pool.difficultyMin ?? null,
            difficultyMax: quota.pool.difficultyMax ?? null
        });
        const free = candidates.filter(c => !usedIds.has(c.id) && !usedFamilies.has(c.variant_of ?? c.id));
        const picked = pickPaperUnits({
            candidates: free, related, limitCount: quota.count, ...(shuffleFn ? { shuffleFn } : {})
        });
        const byId = new Map(free.map(c => [c.id, c]));
        for (const id of picked.ids) {
            usedIds.add(id);
            usedFamilies.add(byId.get(id).variant_of ?? id);
        }
        results.push({ ids: picked.ids, got: picked.actual, availableCount: picked.availableCount });
    }
    return results;
}

/**
 * 選題（**只讀不寫**）：generate-paper 與助教工具 preview_paper 共用。
 * 候選池、承上題整組、家族互斥、庫存不足訊息、排序、標題——與寫入路徑用同一段程式碼，
 * 預覽看到什麼、確認就寫什麼。
 *
 * 承上題（FR-019 PR2，utils/paperGroups.js）：選題單位是「前題＋所有承上題」一組，
 * 抽到就整組相鄰出現、整組算多題。**組內任一題不在候選池（已作答、exclude_ids、
 * 已封存、source_types 不符、科目或章節不同）時整組不抽**，避免孤兒承上題。
 *
 * @param {'note'|'error'} [shortfallPolicy] 湊不滿 N 題時的政策，預設 FOLLOW_UP_SHORTFALL_POLICY
 * @returns {Promise<{error:{status:number,message:string}}|
 *                   {sortedQuestions:object[], finalSortedIds:number[], paperTitle:string, todayStr:string,
 *                    shortfall:{requested:number,actual:number,reason:'follow_up_group'}|null, note:string|null}>}
 */
async function selectPaperQuestions({ studentId, studentName, subject, chapter, limitCount, excludeIds = [], sourceTypes = null,
    shortfallPolicy = FOLLOW_UP_SHORTFALL_POLICY }) {
    // 候選池：同學科同章、未封存、該生沒寫過、且不在排除清單內；
    // sourceTypes（0006 題源過濾）為 null 時不限制——助教工具與既有呼叫端行為不變。
    // 〔stage5 WS-D〕SQL 與承上組查詢抽到 fetchCandidatePool（與 blueprint／補救卷共用），
    // 單章路徑只帶 chapters=[chapter]，其餘新條件為 NULL，候選池與抽出前相同。
    // chapter 先過 pg 自己的 prepareValue：抽出前是 `q.chapter = $2`，pg 把非字串的 chapter
    // （陣列、物件、數字）序列化成**一個**字串去比（比不到任何章 → 400 庫存不足）。直接包成
    // [chapter] 的話，陣列會變成二維 text[]、被 `= ANY` 攤平成多章（或參差陣列丟 500），行為就變了。
    // 字串原樣通過，所以正常請求的參數與抽出前逐位元組相同。
    const { candidates, related } = await fetchCandidatePool({
        subject, chapters: [prepareValue(chapter)], studentId, excludeIds, sourceTypes
    });

    // 家族互斥：同一 variant_of 家族在同一張卷只取一題（規劃 §4.1）。
    // pickPaperUnits 內部走 pickOnePerFamily（每組洗牌取代表 → 對代表 Fisher-Yates），單位是承上組。
    // 「庫存不足」檢查在家族互斥**之後**（裁決 S3-6），${n} 代入家族互斥後可用的題數（無綁定時＝家族數）。
    const picked = pickPaperUnits({ candidates, related, limitCount });
    if (picked.availableCount < limitCount) {
        return { error: { status: 400, message: `新題目庫存不足！該章節 [${studentName}] 沒寫過的題目僅剩 ${picked.availableCount} 題。` } };
    }

    // 庫存夠、但承上題組塞不進剩下的名額 → 依政策少出題並附註，或回 400
    let shortfall = null;
    let note = null;
    if (picked.actual < limitCount) {
        if (picked.actual === 0) {
            return { error: { status: 400, message: `承上題須與前題整組出題，可用的題組每組至少 ${picked.minUnitSize} 題，無法湊出 ${limitCount} 題，請調高題數。` } };
        }
        if (shortfallPolicy === 'error') {
            return { error: { status: 400, message: `承上題須與前題整組出題，無法剛好湊滿 ${limitCount} 題（最多可出 ${picked.actual} 題），請調整題數。` } };
        }
        shortfall = { requested: limitCount, actual: picked.actual, reason: 'follow_up_group' };
        note = `承上題須與前題整組出題，無法剛好湊滿 ${limitCount} 題，本卷實際 ${picked.actual} 題。`;
    }

    const { rows: fullQuestions } = await query(
        `SELECT id, question_text, question_type, difficulty, answer_text, source_type, source_detail, follows_question_id
           FROM questions WHERE id = ANY($1::int[])`,
        [picked.ids]
    );
    const sortedQuestions = sortForPaper(fullQuestions);
    const finalSortedIds = sortedQuestions.map(q => q.id);
    const { titleDate, todayStr } = localDates();
    return { sortedQuestions, finalSortedIds, paperTitle: `${studentName}-${chapter}特訓卷(${titleDate})`, todayStr, shortfall, note };
}
// 給助教工具（services/assistantService.js）內部共用，不是路由
exports.selectPaperQuestions = selectPaperQuestions;
exports.FOLLOW_UP_SHORTFALL_POLICY = FOLLOW_UP_SHORTFALL_POLICY;
exports.resolveStudentInternal = resolveStudent;
// 〔stage5 WS-D〕給補救卷（services/remedialService.js）與單元測試共用，不是路由
exports.buildCandidatePoolQuery = buildCandidatePoolQuery;
exports.fetchCandidatePool = fetchCandidatePool;
exports.pickByQuotas = pickByQuotas;
exports.sortForPaper = sortForPaper;
exports.MAX_QUESTIONS = MAX_QUESTIONS;

exports.generatePaper = async (req, res, next) => {
    // 〔stage5 WS-D〕跨章配額（docs/interfaces-stage5.md 第 4.4 條第 3 項）：body 帶 blueprint 才走新分支；
    // 沒帶（或為 null）時以下的單章路徑一個位元組都不變。
    if (req.body && req.body.blueprint !== undefined && req.body.blueprint !== null) {
        return generateBlueprintPaper(req, res, next);
    }
    const { student_id, student_name, subject, chapter, count, dry_run, exclude_ids, source_types } = req.body;

    const hasStudent = (student_id !== undefined && student_id !== null) || student_name;
    if (!hasStudent || !subject || !chapter || count === undefined || count === null) {
        return res.status(400).json({ message: "所有篩選欄位皆為必填！" });
    }

    const limitCount = parseInt(count, 10);
    if (!Number.isInteger(limitCount) || limitCount < 1) {
        return res.status(400).json({ message: "抽題數量必須為大於 0 的整數！" });
    }
    if (limitCount > MAX_QUESTIONS) {
        return res.status(400).json({ message: `抽題數量過大，單次最多 ${MAX_QUESTIONS} 題。` });
    }

    let excludeIds = [];
    if (exclude_ids !== undefined && exclude_ids !== null) {
        if (!Array.isArray(exclude_ids) || exclude_ids.some(v => !Number.isInteger(v) || v < 1)) {
            return res.status(400).json({ message: 'exclude_ids 必須是正整數陣列。' });
        }
        if (exclude_ids.length > MAX_EXCLUDE) {
            return res.status(400).json({ message: `exclude_ids 最多 ${MAX_EXCLUDE} 個。` });
        }
        excludeIds = [...new Set(exclude_ids)];
    }

    // 題源過濾（0006）：選用；空陣列視為不限制，非法值直接 400（打錯字靜默放行會讓過濾形同虛設）
    let sourceTypes = null;
    if (source_types !== undefined && source_types !== null) {
        const { isValidSourceType } = require('../config/chapters');
        if (!Array.isArray(source_types) || source_types.some(v => !isValidSourceType(v))) {
            return res.status(400).json({ message: 'source_types 必須是合法題源標記的陣列。' });
        }
        if (source_types.length > 0) sourceTypes = [...new Set(source_types)];
    }

    try {
        const { student, error } = await resolveStudent({ student_id, student_name });
        if (error) return res.status(error.status).json({ message: error.message });

        const picked = await selectPaperQuestions({
            studentId: student.id, studentName: student.name, subject, chapter, limitCount, excludeIds, sourceTypes
        });
        if (picked.error) return res.status(picked.error.status).json({ message: picked.error.message });
        const { sortedQuestions, finalSortedIds, paperTitle, todayStr } = picked;
        // 少出題附註（FR-019 PR2）：只在真的少出時才帶 shortfall／note 兩鍵，其餘回應形狀不變
        const shortfallKeys = picked.shortfall ? { shortfall: picked.shortfall, note: picked.note } : {};

        // ── dry_run：到此為止，一個位元組都沒寫（W1-2 的「草稿」）──
        if (dry_run) {
            return res.status(200).json({
                dry_run: true,
                message: '預覽（尚未寫入）：確認後才會建卷並記入作答歷史。',
                student_id: student.id,
                paper_title_preview: paperTitle,
                question_ids: finalSortedIds,
                questions: sortedQuestions,
                ...shortfallKeys
            });
        }

        // ── 真出卷：建卷＋attempts 同一交易 ──
        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr
        });
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被同時指派給該學生，請重試。' });
        }
        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions,
            ...shortfallKeys
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// 〔stage5 WS-D〕跨章配額組卷（docs/interfaces-stage5.md 第 4.4 條第 3 項；DEC-016）
//
// body：既有欄位（student_id／student_name、subject、dry_run、exclude_ids、source_types）
//       ＋ blueprint: [{ chapter, count, difficulty_min?, difficulty_max? }]（1–10 列、count 總和 ≤ 50），
//       與 chapter／count 互斥。
// 選題：逐列跑 pickByQuotas（同一段候選池 SQL、同一個 pickPaperUnits），跨列維持家族互斥與不重複。
// 不足量：**不回 400**，逐列回報 wanted／got，照抽到的題出卷並附 note；
//         全部列都抽不到任何一題時才回 400（出一張空卷沒有意義）。
//         例外：FOLLOW_UP_SHORTFALL_POLICY 切成 'error' 時，承上題湊不滿的列同單章路徑回 400（blueprintPolicyError）。
// 回應形狀同單章路徑，另外多 blueprint（逐列 wanted／got）與 shortfalls（只列不足的列）。
// ─────────────────────────────────────────────────────────────

/** blueprint 最多幾列（契約第 4.4 條第 3 項）。 */
const MAX_BLUEPRINT_ROWS = 10;

/**
 * 驗證 exclude_ids（與單章路徑同規則、同訊息）。
 * @param {any} raw
 * @returns {{error:string}|{value:number[]}}
 */
function parseExcludeIds(raw) {
    if (raw === undefined || raw === null) return { value: [] };
    if (!Array.isArray(raw) || raw.some(v => !Number.isInteger(v) || v < 1)) {
        return { error: 'exclude_ids 必須是正整數陣列。' };
    }
    if (raw.length > MAX_EXCLUDE) return { error: `exclude_ids 最多 ${MAX_EXCLUDE} 個。` };
    return { value: [...new Set(raw)] };
}

/**
 * 驗證 source_types（與單章路徑同規則、同訊息；空陣列＝不限制）。
 * @param {any} raw
 * @returns {{error:string}|{value:string[]|null}}
 */
function parseSourceTypes(raw) {
    if (raw === undefined || raw === null) return { value: null };
    const { isValidSourceType } = require('../config/chapters');
    if (!Array.isArray(raw) || raw.some(v => !isValidSourceType(v))) {
        return { error: 'source_types 必須是合法題源標記的陣列。' };
    }
    return { value: raw.length > 0 ? [...new Set(raw)] : null };
}

/**
 * 驗證 blueprint（純函式）。
 * @param {string} subject 已驗證過的科目
 * @param {any} blueprint
 * @returns {{error:string}|{rows:Array<{chapter:string,count:number,difficulty_min:number|null,difficulty_max:number|null}>}}
 */
function parseBlueprint(subject, blueprint) {
    const { CHAPTERS } = require('../config/chapters');
    if (!Array.isArray(blueprint) || blueprint.length < 1 || blueprint.length > MAX_BLUEPRINT_ROWS) {
        return { error: `blueprint 必須是 1~${MAX_BLUEPRINT_ROWS} 列的陣列。` };
    }
    const rows = [];
    for (let i = 0; i < blueprint.length; i++) {
        const row = blueprint[i];
        const n = i + 1;
        if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: `blueprint 第 ${n} 列必須是物件。` };
        if (typeof row.chapter !== 'string' || !(CHAPTERS[subject] || []).includes(row.chapter)) {
            return { error: `blueprint 第 ${n} 列的章節「${row.chapter ?? ''}」不在${subject}的章節白名單內。` };
        }
        if (!Number.isInteger(row.count) || row.count < 1) {
            return { error: `blueprint 第 ${n} 列的 count 必須是大於 0 的整數。` };
        }
        const dMin = row.difficulty_min ?? null;
        const dMax = row.difficulty_max ?? null;
        for (const d of [dMin, dMax]) {
            if (d !== null && (!Number.isInteger(d) || d < 1 || d > 5)) {
                return { error: `blueprint 第 ${n} 列的 difficulty_min／difficulty_max 必須是 1~5 的整數。` };
            }
        }
        if (dMin !== null && dMax !== null && dMin > dMax) {
            return { error: `blueprint 第 ${n} 列的 difficulty_min 不得大於 difficulty_max。` };
        }
        rows.push({ chapter: row.chapter, count: row.count, difficulty_min: dMin, difficulty_max: dMax });
    }
    const total = rows.reduce((s, r) => s + r.count, 0);
    if (total > MAX_QUESTIONS) return { error: `blueprint 的題數總和最多 ${MAX_QUESTIONS} 題。` };
    return { rows };
}

/**
 * 不足量的原因（純函式）：可用題數本來就不夠＝庫存不足；夠但承上組塞不進＝承上題整組。
 * @param {{got:number, availableCount:number}} r
 * @param {number} wanted
 * @returns {'insufficient_stock'|'follow_up_group'}
 */
function shortfallReason(r, wanted) {
    return r.availableCount < wanted ? 'insufficient_stock' : 'follow_up_group';
}

/**
 * FOLLOW_UP_SHORTFALL_POLICY 在 blueprint 分支的效果（純函式）。
 *
 * 那個常數是「承上題整組湊不滿 N 題時怎麼辦」的**單點切換**（待 owner 決定）：切成 'error' 時，
 * 單章路徑回 400，blueprint 也必須跟著回 400，否則同一個政策在兩條組卷路徑上不一致。
 * 只看 reason 為 follow_up_group 的列——「庫存不足」在 blueprint 本來就是逐列附註、不回 400
 * （docs/remedial.md 第 2.3 節），不受這個政策影響，同單章路徑「真的庫存不足不受此政策影響」。
 *
 * @param {Array<{row:number, chapter:string, wanted:number, got:number, reason:string}>} shortfalls
 * @param {'note'|'error'} policy
 * @returns {string|null} 要回 400 的訊息；政策是 'note' 或沒有承上題不足時為 null
 */
function blueprintPolicyError(shortfalls, policy) {
    if (policy !== 'error') return null;
    const bad = shortfalls.filter(s => s.reason === 'follow_up_group');
    if (bad.length === 0) return null;
    return '承上題須與前題整組出題，blueprint '
        + bad.map(s => `第 ${s.row} 列「${s.chapter}」無法剛好湊滿 ${s.wanted} 題（最多可出 ${s.got} 題）`).join('；')
        + '，請調整題數。';
}

/**
 * 跨章卷的標題（純函式）：1 章同單章路徑；2–3 章列出；4 章以上「第一章等 N 章」。
 * @param {string} studentName
 * @param {string[]} chapters 依 blueprint 順序（可重複，會去重）
 * @param {string} titleDate
 * @returns {string}
 */
function blueprintTitle(studentName, chapters, titleDate) {
    const uniq = [...new Set(chapters)];
    const label = uniq.length <= 3 ? uniq.join('、') : `${uniq[0]}等${uniq.length}章`;
    return `${studentName}-${label}特訓卷(${titleDate})`;
}

async function generateBlueprintPaper(req, res, next) {
    const { student_id, student_name, subject, chapter, count, dry_run, blueprint } = req.body;

    if ((chapter !== undefined && chapter !== null) || (count !== undefined && count !== null)) {
        return res.status(400).json({ message: 'blueprint 與 chapter／count 不可同時使用：跨章配額請只送 blueprint。' });
    }
    const hasStudent = (student_id !== undefined && student_id !== null) || student_name;
    if (!hasStudent || !subject) {
        return res.status(400).json({ message: '所有篩選欄位皆為必填！' });
    }
    const { SUBJECTS } = require('../config/chapters');
    if (!SUBJECTS.includes(subject)) return res.status(400).json({ message: 'subject 不在白名單內。' });

    const parsed = parseBlueprint(subject, blueprint);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const ex = parseExcludeIds(req.body.exclude_ids);
    if (ex.error) return res.status(400).json({ message: ex.error });
    const st = parseSourceTypes(req.body.source_types);
    if (st.error) return res.status(400).json({ message: st.error });

    try {
        const { student, error } = await resolveStudent({ student_id, student_name });
        if (error) return res.status(error.status).json({ message: error.message });

        const results = await pickByQuotas({
            studentId: student.id, subject, excludeIds: ex.value, sourceTypes: st.value,
            quotas: parsed.rows.map(r => ({
                count: r.count,
                pool: { chapters: [r.chapter], difficultyMin: r.difficulty_min, difficultyMax: r.difficulty_max }
            }))
        });

        const report = parsed.rows.map((r, i) => ({
            chapter: r.chapter, difficulty_min: r.difficulty_min, difficulty_max: r.difficulty_max,
            wanted: r.count, got: results[i].got
        }));
        const shortfalls = report
            .map((r, i) => ({ row: i + 1, ...r, reason: shortfallReason(results[i], r.wanted) }))
            .filter(r => r.got < r.wanted);
        const ids = results.flatMap(r => r.ids);
        if (ids.length === 0) {
            return res.status(400).json({
                message: `新題目庫存不足！blueprint 每一列都抽不到 [${student.name}] 沒寫過的題目。`,
                blueprint: report, shortfalls
            });
        }
        // 承上題湊不滿的政策與單章路徑同一個開關（預設 'note'：不回 400，照下面附 note）
        const policyError = blueprintPolicyError(shortfalls, FOLLOW_UP_SHORTFALL_POLICY);
        if (policyError) return res.status(400).json({ message: policyError, blueprint: report, shortfalls });

        const { rows: fullQuestions } = await query(
            `SELECT id, question_text, question_type, difficulty, answer_text, source_type, source_detail, follows_question_id
               FROM questions WHERE id = ANY($1::int[])`,
            [ids]
        );
        const sortedQuestions = sortForPaper(fullQuestions);
        const finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        const paperTitle = blueprintTitle(student.name, parsed.rows.map(r => r.chapter), titleDate);
        const requested = parsed.rows.reduce((s, r) => s + r.count, 0);
        const extra = {
            blueprint: report,
            shortfalls,
            ...(shortfalls.length ? {
                note: `跨章配額有 ${shortfalls.length} 列不足量：`
                    + shortfalls.map(s => `第 ${s.row} 列「${s.chapter}」要 ${s.wanted} 題只抽到 ${s.got} 題`
                        + (s.reason === 'insufficient_stock' ? '（庫存不足）' : '（承上題須整組出題）')).join('；')
                    + `。本卷實際 ${finalSortedIds.length} 題（要求 ${requested} 題）。`
            } : {})
        };

        if (dry_run) {
            return res.status(200).json({
                dry_run: true,
                message: '預覽（尚未寫入）：確認後才會建卷並記入作答歷史。',
                student_id: student.id,
                paper_title_preview: paperTitle,
                question_ids: finalSortedIds,
                questions: sortedQuestions,
                ...extra
            });
        }

        const outcome = await writePaper({ studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr });
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被同時指派給該學生，請重試。' });
        }
        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions,
            ...extra
        });
    } catch (err) {
        next(err);
    }
}
// 純函式給單元測試
exports._blueprintInternals = { parseBlueprint, parseExcludeIds, parseSourceTypes, shortfallReason, blueprintPolicyError, blueprintTitle, MAX_BLUEPRINT_ROWS };

/**
 * 建卷＋寫 attempts（generate 與 confirm 共用；同一交易、rowCount 硬閘門）。
 * @returns {Promise<{paperId:number|null, conflict:boolean}>}
 */
async function writePaper({ studentId, paperTitle, questionIds, todayStr }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [paper] } = await client.query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
            [paperTitle, studentId, questionIds]
        );
        const ins = await client.query(
            `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at)
             SELECT $1::int, x, $3::int, $4::date FROM unnest($2::int[]) AS x
             ON CONFLICT (student_id, question_id) DO NOTHING`,
            [studentId, questionIds, paper.id, todayStr]
        );
        // 寫入筆數少於題數 ⇒ 有題目在選完之後被別的請求指派給同一位學生（或預覽已過期）
        if (ins.rowCount !== questionIds.length) {
            await client.query('ROLLBACK');
            return { paperId: null, conflict: true };
        }
        await client.query('COMMIT');
        return { paperId: paper.id, conflict: false };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        throw err;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────
// POST /api/confirm-paper（W1-2 的「確認」；docs/roadmap-plan.md §6.2.3）
//
// 收 { student_id, question_ids }——題目就是 dry_run 預覽選出的那批，所以這裡
// **不重跑**家族互斥與抽題，只重驗「題目還在、沒封存」，然後走與 generate 相同的
// 寫入閘門：attempts 的 ON CONFLICT DO NOTHING + rowCount 檢查——預覽過期
// （這段時間內有人把同一題指派給同一位學生）會回 409 而不是悄悄少記。
// 回應形狀與 generate-paper 成功時一致，前端共用同一段渲染與 Word 匯出。
// ─────────────────────────────────────────────────────────────
exports.confirmPaper = async (req, res, next) => {
    const { student_id, question_ids } = req.body;
    const id = Number.parseInt(student_id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'student_id 無效。' });
    if (!Array.isArray(question_ids) || question_ids.length === 0 || question_ids.length > MAX_QUESTIONS ||
        question_ids.some(v => !Number.isInteger(v) || v < 1)) {
        return res.status(400).json({ message: `question_ids 必須是 1~${MAX_QUESTIONS} 個正整數。` });
    }
    if (new Set(question_ids).size !== question_ids.length) {
        return res.status(400).json({ message: 'question_ids 不得重複。' });
    }
    try {
        const { rows: [student] } = await query('SELECT id, name FROM students WHERE id = $1', [id]);
        if (!student) return res.status(404).json({ message: '找不到該學生' });

        const { rows: fullQuestions } = await query(
            `SELECT id, chapter, question_text, question_type, difficulty, answer_text, follows_question_id
               FROM questions WHERE id = ANY($1::int[]) AND archived_at IS NULL`,
            [question_ids]
        );
        if (fullQuestions.length !== question_ids.length) {
            return res.status(400).json({ message: '部分題目已不存在或已封存，請重新預覽。' });
        }

        // 承上題組依承接順序相鄰（與預覽同一個排序函式）。這裡不重驗組是否完整：
        // 題目就是預覽整組抽出的那批；呼叫端自行拼湊 question_ids 時照給的題出卷。
        const sortedQuestions = sortForPaper(fullQuestions);
        const finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        // 預覽是單一章節出的；混章時取排序後第一題的章節（標題本來就只是人看的）
        const paperTitle = `${student.name}-${sortedQuestions[0].chapter}特訓卷(${titleDate})`;

        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr
        });
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被指派給該學生（可能是預覽已過期），請重新預覽。' });
        }
        res.status(200).json({
            message: '出卷完成！已記錄作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions.map(({ chapter, ...q }) => q)
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/papers/:id（W1-2 的「後悔藥」；裁決 S4-3）
//
// 同一交易刪該卷的 attempts 與卷本身——被這張卷「燒掉」的題目回到該生的候選池。
// ⚠ 已批改的紀錄會一併消失（弱點面板的分母會變小）；前端警告文案明說，這裡不再多問。
// ─────────────────────────────────────────────────────────────
exports.deletePaper = async (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: '試卷 id 無效。' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const a = await client.query('DELETE FROM attempts WHERE paper_id = $1', [id]);
        const p = await client.query('DELETE FROM exam_papers WHERE id = $1', [id]);
        if (p.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該試卷' });
        }
        await client.query('COMMIT');
        res.status(200).json({ deleted_attempts: a.rowCount });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};
