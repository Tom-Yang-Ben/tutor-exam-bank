const { pool, query } = require('../config/db');
const { pickPaperUnits, nearestReachableCounts, sortForPaperGrouped } = require('../utils/paperGroups');
// 〔Owner 決策單 2026-09-25 B7〕confirm-paper 的承上題整組檢查（純函式＋與補救卷手動加題同一段成員查詢）。
// remedialService 只在 defaultDeps() 裡才 require 本檔，載入時不成環。
const { findIncompleteFollowUpGroups, incompleteFollowUpGroupsMessage } = require('../utils/followUpPaperCheck');
const { buildItemLookupQuery } = require('../services/remedialService');
// 〔retrain PR-2〕刪卷時的排程項目處理（第 3.9 節）。retrainService 不 require 本檔，載入時不成環。
const retrainService = require('../services/retrainService');
// 〔retrain PR-3〕出卷整合（docs/retrain-and-review.md 第 5.2 節 API-6、API-7）：挑到期的重練題、參數驗證、旗標。
// retrainSelect 也不 require 本檔（排序直接用 utils/paperGroups），載入時不成環。
const retrainSelect = require('../services/retrainSelect');
const retrainValidation = require('../utils/retrainValidation');
const features = require('../config/features');
// 〔stage5 WS-D〕pg 序列化查詢參數的同一支函式（pg 的 package.json exports 公開 ./lib/*）：
// 單章路徑用它把 chapter 轉成與抽出前 `q.chapter = $2` 相同的比對字串（見 selectPaperQuestions）
const { prepareValue } = require('pg/lib/utils');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章
const MAX_EXCLUDE = 200;  // 換一題／重抽的排除清單上限（roadmap-plan.md §6.2.2）

/**
 * 承上題整組抽取湊不到剛好 N 題時的政策（FR-019 PR2；單點切換，單章路徑與 blueprint 分支都聽它）：
 *   'error'（預設；〔Owner 決策單 2026-09-25 B10〕「直接報錯，請老師改題數」）
 *           回 400，訊息具體說出哪一章（blueprint 則是哪一列）要幾題、承上題整組最多湊得到幾題、
 *           建議改成幾題（離原題數最近、剛好湊得滿的上下兩個題數，見 utils/paperGroups.js nearestReachableCounts）
 *   'note'  少出題，200 回應附 shortfall＋note 說明實際題數與原因（決策前的預設，保留可切回）
 * 例：要 5 題，抽到 4 題後剩下的組都是 2 題一組。
 * 「真的庫存不足」（可用題數 < N）不受此政策影響：單章照舊回 400，blueprint 照舊逐列附註。
 *
 * 由環境變數 FOLLOW_UP_SHORTFALL_POLICY（note／error）切換，每次組卷時才讀（測試可直接改 process.env）：
 * 未設／空白＝'error'；非法值也退回 'error'，並警告一次（同一個非法值只警告一次）——
 * 打錯字時寧可擋下請老師改題數，也不要悄悄少出題。
 */
const FOLLOW_UP_SHORTFALL_POLICIES = ['note', 'error'];
const DEFAULT_FOLLOW_UP_SHORTFALL_POLICY = 'error';
const warnedShortfallPolicy = new Set();

/**
 * 讀 FOLLOW_UP_SHORTFALL_POLICY（〔Owner 決策單 2026-09-25 B10〕）。不分大小寫、去頭尾空白。
 * @param {object} [env]
 * @returns {'note'|'error'}
 */
function resolveFollowUpShortfallPolicy(env = process.env) {
    const raw = String(env.FOLLOW_UP_SHORTFALL_POLICY ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_FOLLOW_UP_SHORTFALL_POLICY;
    if (FOLLOW_UP_SHORTFALL_POLICIES.includes(raw)) return raw;
    if (!warnedShortfallPolicy.has(raw)) {
        warnedShortfallPolicy.add(raw);
        console.warn(`[exam] FOLLOW_UP_SHORTFALL_POLICY 只接受 note／error，收到「${env.FOLLOW_UP_SHORTFALL_POLICY}」，`
            + '改用 error（承上題整組湊不滿題數時回 400，請老師改題數）。');
    }
    return DEFAULT_FOLLOW_UP_SHORTFALL_POLICY;
}

/** 測試用：清掉「非法值已警告過」的記憶 */
function _resetShortfallPolicyWarningForTest() {
    warnedShortfallPolicy.clear();
}

/**
 * 承上題整組湊不滿時給老師的一句話（純函式；單章路徑與 blueprint 各列共用，不含句尾標點）。
 * 〔Owner 決策單 2026-09-25 B10〕要說清楚：哪一章（或哪一列）要幾題、承上題整組最多湊得到幾題、題數改成多少。
 * 不帶學生姓名（訊息可能被助教工具轉述、也可能進 log）。
 *
 * @param {object} p
 * @param {string} p.label  例：'「向量內積」'、'第 2 列「實數」'
 * @param {number} p.wanted 要求題數
 * @param {number} p.got    不超過 wanted 的最大可達題數（＝'note' 政策下實際會出的題數）
 * @param {{below:number|null, above:number|null}|null} [p.suggest] nearestReachableCounts 的結果
 * @param {number|null} [p.minUnitSize] got 為 0 時用來說明原因（可用的題組每組至少幾題）
 * @returns {string}
 */
function followUpShortfallText({ label, wanted, got, suggest = null, minUnitSize = null }) {
    const why = got > 0
        ? `${wanted} 題以內最多只能湊到 ${got} 題`
        : (minUnitSize ? `可用的題組每組至少 ${minUnitSize} 題，一題都湊不出來` : '一題都湊不出來');
    const options = suggest ? [suggest.below, suggest.above].filter(n => Number.isInteger(n) && n > 0) : [];
    const advice = options.length ? `請把題數改成 ${options.map(n => `${n} 題`).join('或 ')}` : '請調整題數';
    return `${label}要 ${wanted} 題無法剛好湊滿（${why}），${advice}`;
}

// ─────────────────────────────────────────────────────────────
// 智慧組卷（D-D4 重寫；階段 4 W1-1/W1-2 改契約，docs/roadmap-plan.md §6.2.2）
//
// 與 D-D4 版的三個差異（其餘照舊）：
//   1. 裁決 S4-1：**不再自動建學生**。收 student_id（優先）或 student_name（相容），
//      查無此人一律 404——「打名字自動建學生」正是垃圾人名（小／名／華）分裂
//      不重複出題紀錄的根因，建學生從此只有 POST /api/students 一個入口。
//   2. dry_run: true → 走完全相同的選題邏輯但**整段不寫庫**（不建卷、不寫派題與作答），
//      回預覽。前端的「生成」一律先走這裡，看過才確認。
//   3. exclude_ids: int[] → 候選池額外排除（「換一題」把那題加進來再叫一次；
//      「整卷重抽」同參數重叫，洗牌自然給出不同組合）。
//
// 舊有的硬閘門不變：
//   候選池   NOT EXISTS (SELECT 1 FROM attempts …)（不是 NOT IN，NULL 語意才不會咬人）
//   寫入     「新題每生每題一次」＋rowCount 檢查——兩個請求同時抽到同一題時，
//            後者整筆交易回滾並回 409，而不是悄悄少記一題。
//
// 〔retrain PR-1〕migrations/0016 把 attempts 拆成 assignments（派題）與 attempt_records（作答），
// attempts 改成唯讀相容檢視（只含「新題」派題，每生每題最多一列＝舊表的語意），所以候選池的
// NOT EXISTS 一個字都不用改，新題組卷照舊排除該生寫過的題。寫入的閘門搬到 assignments 的部分唯一索引
// assignments_first_exposure_key（只管 purpose = 'new'），見 buildInsertNewAssignmentsSql。
//
// 〔retrain PR-3〕docs/retrain-and-review.md 第 5.2 節 API-6：單章與 blueprint 兩條路徑都接受 retrain: { count, as_of? }
// （附上到期的重練題，〔Owner 決策單 2026-09-26 R6 選 1〕）。新題題數的語意不變，重練題另外加（合計 ≤ 50）；
// 重練題不經候選池、不佔家族名額（R8），合併後用 sortForPaper 一起排（R7），承上組整組放不下 → 400（R12）。
// 旗標關閉卻帶了 retrain → 400；沒帶 retrain 時回應逐字不變。見 attachRetrain。
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
 * unitSizes（該段家族互斥後每個可用組的題數）給 blueprint 在承上組湊不滿時算「改成幾題湊得滿」
 * （〔Owner 決策單 2026-09-25 B10〕）；補救卷不讀它。
 *
 * @param {object} p
 * @param {number} p.studentId
 * @param {string} p.subject
 * @param {Array<{count:number, pool:{chapters?:string[]|null, kcIds?:number[]|null,
 *                difficultyMin?:number|null, difficultyMax?:number|null}}>} p.quotas
 * @param {number[]} [p.excludeIds]
 * @param {string[]|null} [p.sourceTypes]
 * @param {(items:Array)=>Array} [p.shuffleFn]
 * @returns {Promise<Array<{ids:number[], got:number, availableCount:number, unitSizes:number[]}>>} 與 quotas 一一對應
 */
async function pickByQuotas({ studentId, subject, quotas, excludeIds = [], sourceTypes = null, shuffleFn }) {
    const usedIds = new Set();
    const usedFamilies = new Set();
    const results = [];
    for (const quota of quotas) {
        if (!(quota.count > 0)) { results.push({ ids: [], got: 0, availableCount: 0, unitSizes: [] }); continue; }
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
        results.push({ ids: picked.ids, got: picked.actual, availableCount: picked.availableCount, unitSizes: picked.unitSizes });
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
 * @param {'note'|'error'} [shortfallPolicy] 湊不滿 N 題時的政策；不帶＝呼叫當下的環境變數
 *        FOLLOW_UP_SHORTFALL_POLICY（預設 'error'，〔Owner 決策單 2026-09-25 B10〕）。'note' 以外一律當 'error'。
 * @returns {Promise<{error:{status:number,message:string}}|
 *                   {sortedQuestions:object[], finalSortedIds:number[], paperTitle:string, todayStr:string,
 *                    shortfall:{requested:number,actual:number,reason:'follow_up_group'}|null, note:string|null}>}
 */
async function selectPaperQuestions({ studentId, studentName, subject, chapter, limitCount, excludeIds = [], sourceTypes = null,
    shortfallPolicy = resolveFollowUpShortfallPolicy() }) {
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

    // 庫存夠、但承上題組塞不進剩下的名額 → 依政策回 400（預設）或少出題並附註
    let shortfall = null;
    let note = null;
    if (picked.actual < limitCount) {
        if (picked.actual === 0) {
            return { error: { status: 400, message: `承上題須與前題整組出題，可用的題組每組至少 ${picked.minUnitSize} 題，無法湊出 ${limitCount} 題，請調高題數。` } };
        }
        if (shortfallPolicy !== 'note') {
            // 〔Owner 決策單 2026-09-25 B10〕直接報錯：說出哪一章要幾題、最多湊到幾題、改成幾題湊得滿
            const suggest = nearestReachableCounts(picked.unitSizes, limitCount, MAX_QUESTIONS);
            const text = followUpShortfallText({ label: `「${chapter}」`, wanted: limitCount, got: picked.actual, suggest });
            return { error: { status: 400, message: `承上題須與前題整組出題，${text}。` } };
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
// 〔Owner 決策單 2026-09-25 B10〕舊的常數改成讀環境變數：保留同名唯讀屬性（讀的是「當下」生效的政策），
// 另外公開解析函式與預設值給測試
Object.defineProperty(exports, 'FOLLOW_UP_SHORTFALL_POLICY', {
    enumerable: true,
    get: () => resolveFollowUpShortfallPolicy()
});
exports.DEFAULT_FOLLOW_UP_SHORTFALL_POLICY = DEFAULT_FOLLOW_UP_SHORTFALL_POLICY;
exports.resolveFollowUpShortfallPolicy = resolveFollowUpShortfallPolicy;
exports._resetShortfallPolicyWarningForTest = _resetShortfallPolicyWarningForTest;
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

    // 〔retrain PR-3〕API-6 retrain: { count, as_of? }（排在既有參數檢查之後；沒帶＝null，以下與 PR-3 之前逐字相同）
    const attach = retrainValidation.parseAttachParam(req.body.retrain, {
        enabled: features.FEATURE_RETRAIN, newCount: limitCount, today: localDates().todayStr
    });
    if (attach.error) return res.status(400).json({ message: attach.error });

    try {
        const { student, error } = await resolveStudent({ student_id, student_name });
        if (error) return res.status(error.status).json({ message: error.message });

        const picked = await selectPaperQuestions({
            studentId: student.id, studentName: student.name, subject, chapter, limitCount, excludeIds, sourceTypes
        });
        if (picked.error) return res.status(picked.error.status).json({ message: picked.error.message });
        let { sortedQuestions, finalSortedIds } = picked;
        const { paperTitle, todayStr } = picked;
        // 少出題附註（FR-019 PR2）：只在真的少出時才帶 shortfall／note 兩鍵，其餘回應形狀不變
        const shortfallKeys = picked.shortfall ? { shortfall: picked.shortfall, note: picked.note } : {};

        // 〔retrain PR-3〕附上到期的重練題：新題照上面的流程抽，重練題另外挑、合併後一起排（R6、R7、R8、R12）
        const withRetrain = await attachRetrain(attach.value, {
            studentId: student.id, subject, newCount: limitCount, excludeIds, today: todayStr, sortedQuestions
        });
        if (withRetrain.error) return res.status(400).json({ message: withRetrain.error.message });
        if (withRetrain.questions) {
            sortedQuestions = withRetrain.questions;
            finalSortedIds = sortedQuestions.map(q => q.id);
        }
        const retrainKeys = withRetrain.keys;

        // ── dry_run：到此為止，一個位元組都沒寫（W1-2 的「草稿」）──
        if (dry_run) {
            return res.status(200).json({
                dry_run: true,
                message: '預覽（尚未寫入）：確認後才會建卷並記入作答歷史。',
                student_id: student.id,
                paper_title_preview: paperTitle,
                question_ids: finalSortedIds,
                questions: sortedQuestions,
                ...shortfallKeys,
                ...retrainKeys
            });
        }

        // ── 真出卷：建卷＋派題＋作答同一交易 ──
        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr,
            retrainQuestionIds: withRetrain.ids
        });
        if (outcome.retrainConflict) {
            return res.status(409).json({ message: retrainService.retrainConflictMessage(outcome.retrainConflict.question_id) });
        }
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被同時指派給該學生，請重試。' });
        }
        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions,
            ...shortfallKeys,
            ...retrainKeys
        });
    } catch (err) {
        next(err);
    }
};

/**
 * 〔retrain PR-3〕API-6：把到期的重練題附在新卷上（只讀；單章與 blueprint 兩條路徑共用）。
 *
 * 新題照既有流程抽完之後才呼叫：新題題數的語意不變，重練題另外加上（R6 選 1）。重練題不經候選池、
 * 不佔變式家族名額（R8 選 1），挑法見 services/retrainSelect.js（第 4.7 節的排序；承上組整組放不下 → 400，R12 選 2）。
 * 兩者合併後用 sortForPaper 一起依題型、難度排（R7 選 1：卷面不另分區），每題多 purpose、retrain_step。
 * exclude_ids 也排除重練題（整組）：組卷預覽上「移除這題」的重練題放在這裡，換題、重抽時不會再回來。
 *
 * @param {{count:number, asOf:string}|null} attach parseAttachParam 的結果；null＝沒帶 retrain
 * @param {{studentId:number, subject:string, newCount:number, excludeIds:number[], today:string, sortedQuestions:object[]}} p
 * @returns {Promise<{error:{message:string}} | {questions:object[]|null, ids:number[], keys:object}>}
 *   沒帶 retrain 時 questions 為 null、ids 為 []、keys 為 {}（回應逐字不變）
 */
async function attachRetrain(attach, { studentId, subject, newCount, excludeIds, today, sortedQuestions }) {
    if (!attach) return { questions: null, ids: [], keys: {} };
    const sel = await retrainSelect.selectForAttach(query, {
        studentId, subject, asOf: attach.asOf, today, count: attach.count, newCount, excludeIds
    });
    if (sel.error) return { error: sel.error };
    return {
        questions: retrainSelect.mergeForPaper(sortedQuestions, sel.questions, sel.stepById, sortForPaper),
        ids: sel.ids,
        keys: { retrain: sel.summary }
    };
}

// ─────────────────────────────────────────────────────────────
// 〔stage5 WS-D〕跨章配額組卷（docs/interfaces-stage5.md 第 4.4 條第 3 項；DEC-016）
//
// body：既有欄位（student_id／student_name、subject、dry_run、exclude_ids、source_types）
//       ＋ blueprint: [{ chapter, count, difficulty_min?, difficulty_max? }]（1–10 列、count 總和 ≤ 50），
//       與 chapter／count 互斥。
// 選題：逐列跑 pickByQuotas（同一段候選池 SQL、同一個 pickPaperUnits），跨列維持家族互斥與不重複。
// 不足量：**不回 400**，逐列回報 wanted／got，照抽到的題出卷並附 note；
//         全部列都抽不到任何一題時才回 400（出一張空卷沒有意義）。
//         例外：FOLLOW_UP_SHORTFALL_POLICY 為 'error'（〔Owner 決策單 2026-09-25 B10〕起的預設）時，
//         承上題湊不滿的列同單章路徑回 400（blueprintPolicyError），訊息逐列給建議題數；
//         這個檢查排在「全部列都抽不到」之前——承上組塞不進才抽不到時，告訴老師改幾題比「庫存不足」有用。
//         切回 'note' 時與決策前逐字相同。
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
 * 那個政策是「承上題整組湊不滿 N 題時怎麼辦」的**單點切換**：為 'error'（〔Owner 決策單 2026-09-25 B10〕起的預設）時，
 * 單章路徑回 400，blueprint 也必須跟著回 400，否則同一個政策在兩條組卷路徑上不一致。
 * 只看 reason 為 follow_up_group 的列——「庫存不足」在 blueprint 本來就是逐列附註、不回 400
 * （docs/remedial.md 第 2.3 節），不受這個政策影響，同單章路徑「真的庫存不足不受此政策影響」。
 * 'note' 以外的值一律當 'error'（同環境變數的非法值退回 'error'）。
 *
 * @param {Array<{row:number, chapter:string, wanted:number, got:number, reason:string}>} shortfalls
 * @param {'note'|'error'} policy
 * @param {Object<number, {below:number|null, above:number|null, minUnitSize:number|null}>} [hints]
 *        逐列（鍵＝row）的建議題數（blueprintShortfallHints）；缺的列訊息只說「請調整題數」
 * @returns {string|null} 要回 400 的訊息；政策是 'note' 或沒有承上題不足時為 null
 */
function blueprintPolicyError(shortfalls, policy, hints = {}) {
    if (policy === 'note') return null;
    const bad = shortfalls.filter(s => s.reason === 'follow_up_group');
    if (bad.length === 0) return null;
    return '承上題須與前題整組出題，blueprint '
        + bad.map(s => {
            const h = hints[s.row] || null;
            return followUpShortfallText({
                label: `第 ${s.row} 列「${s.chapter}」`, wanted: s.wanted, got: s.got,
                suggest: h, minUnitSize: h ? h.minUnitSize : null
            });
        }).join('；')
        + '。';
}

/**
 * blueprint 承上組不足列的建議題數（純函式；〔Owner 決策單 2026-09-25 B10〕）。
 * 只改這一列、其他列不動時，這一列改成幾題能剛好湊滿；往上的建議不得讓整張卷超過 MAX_QUESTIONS。
 *
 * @param {Array<{row:number, wanted:number, reason:string}>} shortfalls
 * @param {Array<{unitSizes?:number[]}>} results pickByQuotas 的結果（與 blueprint 列一一對應）
 * @param {number} requested blueprint 的題數總和
 * @returns {Object<number, {below:number|null, above:number|null, minUnitSize:number|null}>}
 */
function blueprintShortfallHints(shortfalls, results, requested) {
    const hints = {};
    for (const s of shortfalls) {
        if (s.reason !== 'follow_up_group') continue;
        const sizes = (results[s.row - 1] && results[s.row - 1].unitSizes) || [];
        const cap = MAX_QUESTIONS - (requested - s.wanted);
        hints[s.row] = { ...nearestReachableCounts(sizes, s.wanted, cap), minUnitSize: sizes.length ? Math.min(...sizes) : null };
    }
    return hints;
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
    // 〔retrain PR-3〕API-6 retrain（同單章路徑；新題題數＝blueprint 的總和）
    const attach = retrainValidation.parseAttachParam(req.body.retrain, {
        enabled: features.FEATURE_RETRAIN, newCount: parsed.rows.reduce((s, r) => s + r.count, 0), today: localDates().todayStr
    });
    if (attach.error) return res.status(400).json({ message: attach.error });

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
        const requested = parsed.rows.reduce((s, r) => s + r.count, 0);
        // 承上題湊不滿的政策與單章路徑同一個開關（〔Owner 決策單 2026-09-25 B10〕預設 'error'：逐列說明並給建議題數；
        // 'note' 時 policyError 恆為 null，以下與決策前逐字相同）
        const policyError = blueprintPolicyError(shortfalls, resolveFollowUpShortfallPolicy(),
            blueprintShortfallHints(shortfalls, results, requested));
        if (policyError) return res.status(400).json({ message: policyError, blueprint: report, shortfalls });
        const ids = results.flatMap(r => r.ids);
        if (ids.length === 0) {
            return res.status(400).json({
                message: `新題目庫存不足！blueprint 每一列都抽不到 [${student.name}] 沒寫過的題目。`,
                blueprint: report, shortfalls
            });
        }

        const { rows: fullQuestions } = await query(
            `SELECT id, question_text, question_type, difficulty, answer_text, source_type, source_detail, follows_question_id
               FROM questions WHERE id = ANY($1::int[])`,
            [ids]
        );
        let sortedQuestions = sortForPaper(fullQuestions);
        let finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        const paperTitle = blueprintTitle(student.name, parsed.rows.map(r => r.chapter), titleDate);
        // 〔retrain PR-3〕附上到期的重練題（下面的不足量附註照舊只算新題）
        const newTotal = finalSortedIds.length;
        const withRetrain = await attachRetrain(attach.value, {
            studentId: student.id, subject, newCount: requested, excludeIds: ex.value, today: todayStr, sortedQuestions
        });
        if (withRetrain.error) return res.status(400).json({ message: withRetrain.error.message });
        if (withRetrain.questions) {
            sortedQuestions = withRetrain.questions;
            finalSortedIds = sortedQuestions.map(q => q.id);
        }
        const extra = {
            blueprint: report,
            shortfalls,
            ...(shortfalls.length ? {
                note: `跨章配額有 ${shortfalls.length} 列不足量：`
                    + shortfalls.map(s => `第 ${s.row} 列「${s.chapter}」要 ${s.wanted} 題只抽到 ${s.got} 題`
                        + (s.reason === 'insufficient_stock' ? '（庫存不足）' : '（承上題須整組出題）')).join('；')
                    + `。本卷實際 ${newTotal} 題（要求 ${requested} 題）。`
            } : {}),
            ...withRetrain.keys
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

        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr, retrainQuestionIds: withRetrain.ids
        });
        if (outcome.retrainConflict) {
            return res.status(409).json({ message: retrainService.retrainConflictMessage(outcome.retrainConflict.question_id) });
        }
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
exports._blueprintInternals = { parseBlueprint, parseExcludeIds, parseSourceTypes, shortfallReason, blueprintPolicyError,
    blueprintShortfallHints, followUpShortfallText, blueprintTitle, MAX_BLUEPRINT_ROWS };

/**
 * 「新題」派題＋空白作答的寫入語句（〔retrain PR-1〕migrations/0016；純函式，參數 $1 studentId、$2 questionIds、
 * $3 paperId、$4 assignedAt）。
 *
 * 先有派題、作答掛在派題下：同一句 SQL 先寫 assignments（purpose = 'new'），再替**實際寫進去的**
 * 每一筆派題建一筆空白作答（attempt_records）。DEC-003 的硬閘門從舊表的 UNIQUE (student_id, question_id)
 * 搬到部分唯一索引 assignments_first_exposure_key：ON CONFLICT 指名同一組欄位與 WHERE purpose = 'new'，
 * 撞到的題 DO NOTHING、不會建作答，外層的 rowCount（＝建了幾筆作答＝寫進幾筆派題）因此照舊少於題數 → 409。
 * @returns {string}
 */
function buildInsertNewAssignmentsSql() {
    return `WITH ins AS (
               INSERT INTO assignments (student_id, question_id, paper_id, assigned_at, purpose)
               SELECT $1::int, x, $3::int, $4::date, 'new' FROM unnest($2::int[]) AS x
               ON CONFLICT (student_id, question_id) WHERE purpose = 'new' DO NOTHING
               RETURNING id
           )
           INSERT INTO attempt_records (assignment_id) SELECT id FROM ins`;
}

/**
 * 建卷＋寫派題與作答（generate 與 confirm 共用；同一交易、rowCount 硬閘門）。
 *
 * 〔retrain PR-3〕retrainQuestionIds（questionIds 的子集）寫成重練派題（API-7；docs/retrain-and-review.md 第 5.2 節）：
 * 建卷之後先交給 services/retrainService.js 的 insertRetrainAssignments——它先 `SELECT … FOR UPDATE` 鎖住這些題的
 * 排程項目，再逐題檢查「屬於這位學生、沒移出、沒有已派出待批改」（不變量 I6，已派出照 countsAsInFlight 判斷），
 * 不符就什麼都不寫、回 retrainConflict（呼叫端回 409 retrainConflictMessage）；符合就寫 purpose = 'retrain'、
 * retrain_item_id、retrain_step（當下關卡）與空白作答並重算。其餘的題照舊走新題的寫入閘門。
 * 「先鎖項目、再動派題與作答」與批改、刪卷同一個順序（retrainService 檔頭的「併發」）。
 * 沒有重練題（預設）時，這個交易裡的語句與 PR-3 之前一模一樣。
 *
 * @param {{studentId:number, paperTitle:string, questionIds:number[], todayStr:string, retrainQuestionIds?:number[]}} p
 * @returns {Promise<{paperId:number|null, conflict:boolean, retrainConflict?:{question_id:number, reason:string}}>}
 */
async function writePaper({ studentId, paperTitle, questionIds, todayStr, retrainQuestionIds = [] }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [paper] } = await client.query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
            [paperTitle, studentId, questionIds]
        );
        // 〔retrain PR-3〕重練題：先鎖項目再檢查、寫入（有衝突時什麼都沒寫）
        let newIds = questionIds;
        if (retrainQuestionIds.length > 0) {
            const r = await retrainService.insertRetrainAssignments(client, {
                studentId, paperId: paper.id, assignedAt: todayStr, questionIds: retrainQuestionIds
            });
            if (r.conflict) {
                await client.query('ROLLBACK');
                return { paperId: null, conflict: false, retrainConflict: r.conflict };
            }
            const retrainSet = new Set(retrainQuestionIds);
            newIds = questionIds.filter(id => !retrainSet.has(id));
        }
        // 純重練卷沒有新題：不必跑新題的寫入
        if (retrainQuestionIds.length === 0 || newIds.length > 0) {
            const ins = await client.query(
                buildInsertNewAssignmentsSql(),
                [studentId, newIds, paper.id, todayStr]
            );
            // 寫入筆數少於題數 ⇒ 有題目在選完之後被別的請求指派給同一位學生（或預覽已過期）
            if (ins.rowCount !== newIds.length) {
                await client.query('ROLLBACK');
                return { paperId: null, conflict: true };
            }
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
// **不重跑**家族互斥與抽題，只重驗「題目還在、沒封存」與「承上題整組」，然後走與 generate 相同的
// 寫入閘門：新題派題的 ON CONFLICT DO NOTHING + rowCount 檢查——預覽過期
// （這段時間內有人把同一題指派給同一位學生）會回 409 而不是悄悄少記。
// 回應形狀與 generate-paper 成功時一致，前端共用同一段渲染與 Word 匯出。
//
// 〔Owner 決策單 2026-09-25 B7〕承上題整組改由伺服器也檢查（裁決 S5-28 原本只靠前端把關）：
// 卷裡有某個承上組的任何一題，整組都要在卷裡，否則 400 並逐組列出缺哪幾題（題目 id）。
// 組內不在卷裡的成員是已封存或該生已寫過的，比照前端「組內有封存或已寫過的題就不加」＝這一組不能出；
// 規則與原因標記見 utils/followUpPaperCheck.js。順序不必由呼叫端排：底下一律用 sortForPaper 重排，
// 整組都在時必然相鄰且依承接順序。回 400 時不寫任何東西、訊息不含學生姓名。
//
// 〔retrain PR-3〕docs/retrain-and-review.md 第 5.2 節 API-7：body 可多帶 retrain_question_ids（question_ids 的子集）。
//   - 旗標關閉卻帶了 → 400「retrain 需要開啟 FEATURE_RETRAIN。」；格式不對、不是子集 → 400（都排在既有檢查之後）。
//   - 這些題寫成重練派題（writePaper → retrainService.insertRetrainAssignments：交易內 SELECT … FOR UPDATE 鎖項目再檢查，
//     狀態不符 → 409「題目 <id> 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。」）；其餘題照舊寫新題派題。
//   - B7 的整組檢查與新題共用、一視同仁（incompleteFollowUpGroupsInPaper）。
//   - 每一題都是重練題（純重練卷）時卷名是「<姓名>-錯題重練卷(日期)」。
//   - 回應多 retrain_question_ids（有帶才多，依出題順序）；沒帶時行為與回應逐字不變。
// ─────────────────────────────────────────────────────────────

/**
 * 卷裡只放了一部分的承上組（〔Owner 決策單 2026-09-25 B7〕）。
 * 承上組成員用 remedialService.buildItemLookupQuery 查——與補救卷「用題目 ID 加題」前的查詢同一段
 * （同一段無向遞迴，含封存與該生已寫過的旗標），前後端對「整組」與「能不能出」的判斷才不會漂移。
 * 在寫入交易之外查，與上面的封存檢查同一層級：查完到寫入之間恰好有人封存或重綁同組題的競態不處理
 * （單一使用者系統；綁定是 runner／複核重算的衍生資料，封存檢查本來也是這樣）。
 *
 * @param {number} studentId
 * @param {number[]} questionIds
 * @returns {Promise<ReturnType<typeof findIncompleteFollowUpGroups>>}
 */
async function incompleteFollowUpGroupsInPaper(studentId, questionIds, retrainIds = null) {
    const { text, values } = buildItemLookupQuery(questionIds, studentId);
    let { rows } = await query(text, values);
    // 〔retrain PR-3〕重練題與新題一視同仁（設計稿第 3.8 節、API-7、風險 R-9）：整組檢查的規則不變（卷裡有某組的任何一題，
    // 整組都要在卷裡），只是「缺的題能不能加回來」要把重練算進去——帶了 retrain_question_ids 時，不在卷裡、該生寫過、
    // 但還在錯題重練清單上（沒移出）的組員可以當重練題加回來，原因標 not_in_paper 而不是 answered（「只能整組刪」）。
    // 沒帶 retrain_question_ids 時一個字都不變。
    if (retrainIds !== null) {
        const inPaper = new Set(questionIds);
        const candidates = rows.filter(r => r.answered && !inPaper.has(r.id)).map(r => r.id);
        if (candidates.length > 0) {
            const { rows: live } = await query(
                `SELECT question_id FROM retrain_items
                  WHERE student_id = $1 AND question_id = ANY($2::int[]) AND status <> 'retired'`,
                [studentId, candidates]);
            const retrainable = new Set(live.map(r => r.question_id));
            rows = rows.map(r => (retrainable.has(r.id) ? { ...r, answered: false } : r));
        }
    }
    return findIncompleteFollowUpGroups(questionIds, rows);
}

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

        // 〔retrain PR-3〕API-7 retrain_question_ids（既有檢查之後；沒帶＝null，以下與 PR-3 之前逐字相同）
        const rt = retrainValidation.parseConfirmRetrain(req.body, { enabled: features.FEATURE_RETRAIN });
        if (rt.error) return res.status(400).json({ message: rt.error });
        const retrainIds = rt.value;

        // 〔Owner 決策單 2026-09-25 B7〕承上題必須整組：缺題就 400，列出哪一組缺了哪幾題
        const incomplete = await incompleteFollowUpGroupsInPaper(student.id, question_ids, retrainIds);
        if (incomplete.length > 0) {
            return res.status(400).json({
                message: incompleteFollowUpGroupsMessage(incomplete),
                incomplete_groups: incomplete
            });
        }

        // 承上題組依承接順序相鄰（與預覽同一個排序函式）；呼叫端給的順序不影響出題順序
        const sortedQuestions = sortForPaper(fullQuestions);
        const finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        // 預覽是單一章節出的；混章時取排序後第一題的章節（標題本來就只是人看的）
        // 〔retrain PR-3〕純重練卷（每一題都是重練題）的卷名是「<姓名>-錯題重練卷(日期)」（第 5.2 節 API-5、第 5.4 節）
        // 〔retrain 審查修正〕附帶重練題的混合卷：重練題只限同科、不限章節（第 5.6.3 節 ③），排序後第一題可能是別章的重練題，
        // 所以取「排序後第一個新題」的章節——與預覽（paper_title_preview）、API-6 直接寫入的卷名相同。沒帶 retrain_question_ids 時照舊。
        const titleQuestion = retrainIds === null
            ? sortedQuestions[0]
            : (sortedQuestions.find(q => !retrainIds.includes(q.id)) || sortedQuestions[0]);
        const paperTitle = retrainSelect.isPureRetrain(finalSortedIds, retrainIds)
            ? retrainSelect.retrainPaperTitle(student.name, titleDate)
            : `${student.name}-${titleQuestion.chapter}特訓卷(${titleDate})`;

        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr,
            ...(retrainIds !== null ? { retrainQuestionIds: retrainIds } : {})
        });
        if (outcome.retrainConflict) {
            // 〔retrain PR-3〕項目在草稿之後被派到別張卷、移出或還沒進清單（不變量 I6）
            return res.status(409).json({ message: retrainService.retrainConflictMessage(outcome.retrainConflict.question_id) });
        }
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被指派給該學生（可能是預覽已過期），請重新預覽。' });
        }
        const retrainSet = new Set(retrainIds || []);
        res.status(200).json({
            message: '出卷完成！已記錄作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions.map(({ chapter, ...q }) => q),
            // 〔retrain PR-3〕有帶才多，依出題順序
            ...(retrainIds !== null ? { retrain_question_ids: finalSortedIds.filter(q => retrainSet.has(q)) } : {})
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/papers/:id（W1-2 的「後悔藥」；裁決 S4-3）
//
// 同一交易刪該卷的派題（作答跟著 ON DELETE CASCADE）與卷本身——被這張卷「燒掉」的題目回到該生的候選池。
// ⚠ 已批改的紀錄會一併消失（弱點面板的分母會變小）；前端警告文案明說，這裡不再多問。
//
// 〔retrain PR-1〕docs/retrain-and-review.md 第 3.9 節：這張卷上某題的「新題」派題，若同一位學生的
// 同一題已經有重練派題（在別張卷），刪掉它會讓那些重練紀錄失去「第一次」——那一題就會重新進入
// 新題候選池（檢視 attempts 只看新題派題），違反「重練派題一定有同生同題的新題派題」（不變量 I1）。
// 這種情形回 409，請老師先刪那些重練卷。沒有任何重練資料時，檢查查不到東西，行為與拆表前逐字相同。
// deleted_attempts 維持「刪掉幾筆派題」的語意（拆表前一筆 attempts＝一筆派題）。
//
// 〔retrain PR-2〕migrations/0017 之後改依排程項目判斷（第 3.9 節）：
//   - 卷上某題的新題派題是某個排程項目的來源，而那個項目在別張卷已經有重練派題 → 409（訊息與形狀同 PR-1）；
//   - 項目還沒被重練過 → 連項目一起刪（老師的「要重練」勾選跟著那張卷一起消失）；
//   - 刪的是重練卷 → 受影響的項目依剩下的作答歷史重算（等於那次重練沒發生過）。
// 先鎖住相關項目再查擋路的重練派題（services/retrainService.js 的 lockItemsForPaper），同一交易內刪除與重算。
// 沒有任何重練資料時，查不到項目、也沒有擋路的派題，行為與回應與拆表前逐字相同。
// ─────────────────────────────────────────────────────────────

/**
 * 擋刪卷的重練派題（純函式；$1 paperId）：這張卷上每一題「新題」派題，以它為來源的排程項目
 * 在**別張卷**的重練派題。回 { question_id, retrain_paper_ids }，retrain_paper_ids 只列有卷號的
 * （依卷號排序；全部沒有卷號時為 NULL）。
 *
 * 〔retrain PR-2〕改依排程項目判斷：新題派題 n → 以它為來源的項目 i（retrain_items_source_fk）→ 屬於 i 的重練派題 r
 * （assignments_retrain_item_fk）。r 與 n 同生同題由那兩個複合外鍵保證（不變量 I1），條件照舊寫出來只是讓語意一目了然。
 * @returns {string}
 */
function buildRetrainBlockersSql() {
    return `SELECT n.question_id,
                   array_agg(DISTINCT r.paper_id ORDER BY r.paper_id) FILTER (WHERE r.paper_id IS NOT NULL) AS retrain_paper_ids
              FROM assignments n
              JOIN retrain_items i ON i.source_assignment_id = n.id
              JOIN assignments r ON r.retrain_item_id = i.id
                                AND r.student_id = n.student_id AND r.question_id = n.question_id
                                AND r.purpose = 'retrain' AND r.paper_id IS DISTINCT FROM n.paper_id
             WHERE n.paper_id = $1 AND n.purpose = 'new'
             GROUP BY n.question_id
             ORDER BY n.question_id`;
}

/**
 * 刪卷被重練擋下時的 409 回應（純函式）。
 * @param {Array<{question_id:number, retrain_paper_ids:number[]|null}>} rows buildRetrainBlockersSql 的結果（至少一列）
 * @returns {{message:string, question_ids:number[], retrain_paper_ids:number[]}}
 */
function retrainBlockedBody(rows) {
    const paperIds = [...new Set(rows.flatMap(r => r.retrain_paper_ids || []))].sort((a, b) => a - b);
    const where = paperIds.length > 0 ? `（重練卷 ${paperIds.map(p => `#${p}`).join('、')}）` : '';
    return {
        message: `這張卷有 ${rows.length} 題已經在錯題重練中${where}，請先刪除那些重練卷。`,
        question_ids: rows.map(r => r.question_id),
        retrain_paper_ids: paperIds
    };
}

exports.deletePaper = async (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: '試卷 id 無效。' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // 〔retrain PR-2〕先鎖住這張卷相關的排程項目，再查擋路的重練派題（等鎖之後的查詢看得到剛提交的重練派題）
        await retrainService.lockItemsForPaper(client, id);
        const { rows: blockers } = await client.query(buildRetrainBlockersSql(), [id]);
        if (blockers.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json(retrainBlockedBody(blockers));
        }
        // 重練派題 → 以卷上新題派題為來源的項目 → 其餘派題，最後重算受影響的項目（services/retrainService.js）
        const a = await retrainService.deletePaperAssignments(client, id);
        const p = await client.query('DELETE FROM exam_papers WHERE id = $1', [id]);
        if (p.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該試卷' });
        }
        await client.query('COMMIT');
        res.status(200).json({ deleted_attempts: a.deleted });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};

// 〔retrain PR-1〕純函式給單元測試
exports._assignmentInternals = { buildInsertNewAssignmentsSql, buildRetrainBlockersSql, retrainBlockedBody };
