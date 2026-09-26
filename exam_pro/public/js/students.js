// ─────────────────────────────────────────────────────────────
// public/js/students.js — 階段 3 的「學生」分頁（P-05）
//
// 契約：docs/interfaces-stage3.md 第 1 條（五支 API 的形狀、排序與錯誤字串）
//       與第 7 條（window.ExamApp 橋接、<meta> 旗標、index.html 的五個插入點）。
//
// 這一頁把家教的迴圈接起來：出卷 →（一週後）批改 → 弱點面板 → 錯題找相似／出變式。
//
// 四條界線（沿用 review.js 的做法，理由見該檔檔頭）：
//
//   1. **ES module，經 window.ExamApp 橋接**。index.html 那份 inline script 的
//      apiFetch／showToast／renderMath／escapeHtml 都是區域函式，module 抓不到。
//      橋接不存在時本檔**直接停手並印一行錯誤**，不自己複製一份。
//
//   2. **FEATURE_STUDENTS 不寫死在 JS**：從 <meta name="feature-students"> 讀，
//      parseBool 與後端 config/features.js 逐字相同。旗標關閉時**整段不渲染**
//      （第 7.2 條：不得只是隱藏），連空殼都不掛。
//
//   3. **?mock=1 的手寫假資料**。API 還沒合入時要能做版面。假資料只有 ?mock=1
//      讀得到——靜默的假資料比壞掉更難查。
//
//   4. **只呼叫、不改後端**。五支 API 的形狀是凍結的；這裡對 400／404 的訊息
//      一律原樣顯示（`{ message }`），不自己翻譯，否則老師看到的跟 log 裡的對不起來。
//
// 三個刻意的顯示決定（都來自第 1.5 條的語意，不是版面偏好）：
//
//   - `wrong_rate === null`（`graded = 0`）顯示「—」而不是 0%。沒批改不等於全對。
//   - `low_sample` 一律標「樣本不足」，包含 `graded = 0` 的那一列。
//   - `trend_weekly` **只有有資料的週**（後端不補零）。中間跳過的週在圖上畫成虛線，
//      而不是把兩個點直接連起來假裝那幾週是連續的。
//
// 〔stage5 WS-A〕docs/interfaces-stage5.md 第 4.1 條第 7 項（DEC-015、DEC-017）：
//   - 批改卡：按「錯」展開錯因 chip（可複選，清單讀 GET /api/error-types，不在前端另抄一份）；
//     計算題與證明題可填部分給分；可記學生答案與老師註記；可展開標準答案與詳解。
//   - 弱點面板多一張「錯因分布」表（by_error_type），最近錯題列出錯因與部分給分。
//   - 學生管理可編輯檔案欄位（選項讀 GET /api/student-profile-options）。
//   diffResults 仍然「只送改過的題」；四個新鍵只在真的改過時才出現在那一題裡。
//
// 〔retrain PR-4〕docs/retrain-and-review.md 第 5.3 節（FEATURE_RETRAIN；關閉時以下全部不渲染、不發任何新請求）：
//   - 批改卡：新題的對錯按鈕旁多「要重練」勾選框（預設不勾，答錯也不自動勾；依 API-9 的 retrain_flagged 顯示已勾），
//     重練題改標「重練・第 n 關」。勾選以 results[i].retrain 送出（只在改過時送），儲存後依 API-10 的 retrain 摘要提示。
//   - 學生清單（下拉選單）名字旁「【到期 N】」（GET /api/retrain/summary）。
//   - 與學生視圖的「錯題重練」卡（public/js/retrain.js）之間只有兩個 document 事件（STUDENT_VIEW_EVENT、RETRAIN_CHANGED_EVENT）。
// ─────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 365;                    // 裁決 S4-4：家教是長期視角，預設一年（伺服器端第 1.5 條的 90 不動，本檔恆帶參數）
const DAYS_OPTIONS = [30, 90, 180, 365];     // 全部落在 1~365 的合法區間
const MAX_PATCH = 100;                       // 第 1.4 條：results 最多 100 筆

// 「立即批改」帶進來、但學生清單還沒載完時暫存的 paper_id。
let pendingPaperId = null;

// students.js →（找相似／出變式）→ variants.js 的唯一通道。
// 用 CustomEvent 而不是互相 import：兩個 module 因此可以各自被 data: URL 載入做單元測試，
// 也不必在 window.ExamApp 上多掛一個第 7.1 條沒有凍結的鍵。
// 事件名與 detail 的形狀寫在 docs/archive/questions3-wsD.md 第 1 條，variants.js 是唯一的聽眾。
export const VARIANT_EVENT = 'examapp:variant-request';

// index.html 組卷結果區的「立即批改」按鈕發的事件。詳情由 ExamApp.getPaperCache() 取，
// 事件本身只是「使用者現在要批這張卷」的訊號（第 7.1 條的 getPaperCache 就是為此存在）。
export const GRADE_EVENT = 'examapp:grade-paper';

// 〔retrain PR-4〕與 public/js/retrain.js（學生視圖的「錯題重練」卡）之間的兩個事件，只在 FEATURE_RETRAIN 開啟時發與聽：
//   STUDENT_VIEW_EVENT     本檔 → retrain.js：學生視圖載入了哪位學生（detail：student_id、student_name、subject、days）
//   RETRAIN_CHANGED_EVENT  retrain.js → 本檔：清單變了 → 更新學生清單的「到期 N」；papers_changed 時連試卷列表一起重載
export const STUDENT_VIEW_EVENT = 'examapp:student-view';
export const RETRAIN_CHANGED_EVENT = 'examapp:retrain-changed';

// ───────────────────────── 橋接與旗標 ─────────────────────────

/**
 * 取得 index.html 掛上來的既有函式。
 * @returns {object|null} 缺任何一個必要函式都回 null（並在 console 指名缺哪一個）
 */
function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath', 'escapeHtml'];
    if (!app) {
        console.error('[students] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來（interfaces-stage3.md 第 7.1 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[students] window.ExamApp 缺少：${missing.join('、')}。學生分頁不會掛載。`);
        return null;
    }
    // 這兩個是階段 3 新增的橋接（第 7.1 條）；缺了只影響「立即批改」的深連結，
    // 面板本身照常可用，所以只警告不停手。
    for (const k of ['getPaperCache', 'showSection']) {
        if (typeof app[k] !== 'function') {
            console.warn(`[students] window.ExamApp 缺少 ${k}（第 7.1 條）：組卷結果區的「立即批改」深連結會失效。`);
        }
    }
    return app;
}

/**
 * 布林旗標的解讀，與後端 config/features.js 的 parseBool 逐字相同
 * （interfaces-stage1.md 第 9 條）：只有 '1' 與 'true' 為真。
 * 佔位字串沒被 app.js 替換掉時判為 false ＝「旗標關閉」的安全預設。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

// 本檔讀的三個注入點（第 7.2 條、裁決 S3-R25）。選擇器寫成字面值而不是用樣板字串組出來：
// 這是「students.js 會看哪幾個旗標」的清單，`eval/tools/check_html.js` 也靠它逐字比對
// ——組出來的選擇器在原始碼裡找不到，檢查器就只能放行。
const FEATURE_META = {
    students: 'meta[name="feature-students"]',
    similar: 'meta[name="feature-similar"]',
    variants: 'meta[name="feature-variants"]',
    // 〔retrain PR-4〕批改卡的「要重練」勾選框與徽章、學生清單的到期徽章（docs/retrain-and-review.md 第 5.3 節）
    retrain: 'meta[name="feature-retrain"]'
};

/**
 * 讀一個 `FEATURE_*` 旗標（注入點在 index.html 的 `<meta>`，第 7.2 條）。
 * `?<key>=1` 是本機驗收用的手動開關，不影響後端旗標的權威性
 * （review.js 的 `?pipeline=1` 同一條線）。
 * @param {'students'|'similar'|'variants'} key
 * @returns {boolean}
 */
function featureOn(key) {
    const meta = document.querySelector(FEATURE_META[key]);
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get(key) === '1';
}

// 裁決 S3-R25：兩顆按鈕由**兩個不同的旗標**控制。
//   「找相似」打的是階段 1 的 GET /api/questions/:id/similar → FEATURE_SIMILAR
//   「出變式」打的是階段 3 的 POST /api/questions/:id/variants → FEATURE_VARIANTS
// 之前兩顆共用 feature-variants，會讓「similar 開著、variants 關著」時
// 明明可用的「找相似」也消失——那是把兩個獨立的開關綁在一起。
/** @returns {boolean} FEATURE_STUDENTS 是否開啟（決定整個學生分頁渲不渲染） */
function studentsEnabled() { return featureOn('students'); }

/** @returns {boolean} FEATURE_SIMILAR 是否開啟（決定要不要畫「找相似」） */
function similarEnabled() { return featureOn('similar'); }

/** @returns {boolean} FEATURE_VARIANTS 是否開啟（決定要不要畫「出變式」） */
function variantsEnabled() { return featureOn('variants'); }

/** @returns {boolean} 〔retrain PR-4〕FEATURE_RETRAIN 是否開啟（關閉時本檔的畫面、請求、PATCH body 與沒有這個功能時逐字相同） */
function retrainEnabled() { return featureOn('retrain'); }

/** @returns {boolean} 是否走本檔內的手寫假資料 */
function mockEnabled() {
    return new URLSearchParams(location.search).get('mock') === '1';
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * 錯誤率的顯示。
 *
 * `null` 是第 1.5 條的「graded = 0」——**沒批改不等於全對**，所以顯示「—」而不是 0.0%。
 * 這是整個面板最容易被寫錯、而且錯了不會噴錯的一個地方。
 *
 * @param {number|null|undefined} rate
 * @returns {string}
 */
export function formatPercent(rate) {
    if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
    return `${(Number(rate) * 100).toFixed(1)}%`;
}

/**
 * 純 CSS 橫條的寬度（百分比數值，0~100）。
 * `null` 回 0：畫不出橫條，旁邊的文字會顯示「—」與「樣本不足」。
 * @param {number|null|undefined} rate
 * @returns {number}
 */
export function barPercent(rate) {
    if (rate === null || rate === undefined || Number.isNaN(rate)) return 0;
    return Math.max(0, Math.min(100, Number(rate) * 100));
}

/**
 * 三態的顯示文字。`null`／`undefined` 都是「未批」（第 1.3 條：查不到 attempts 列也是 null）。
 * @param {0|1|null|undefined} v
 * @returns {string}
 */
export function resultLabel(v) {
    if (v === 1) return '對';
    if (v === 0) return '錯';
    return '未批';
}

/** 〔stage5 WS-A〕批改細節的四個可選鍵（第 4.1 條第 1 項）。 */
export const DETAIL_KEYS = ['score', 'error_types', 'response', 'note'];

/** 兩個批改細節值是否相同：陣列逐項比、其他以 null 收斂 undefined 後嚴格相等。 */
function sameDetail(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        const x = Array.isArray(a) ? a : [];
        const y = Array.isArray(b) ? b : [];
        return x.length === y.length && x.every((v, i) => v === y[i]);
    }
    return (a ?? null) === (b ?? null);
}

/**
 * 算出要送給 `PATCH /api/papers/:id/results` 的最小 payload。
 *
 * 只送「改過的」有兩個理由：① 第 1.4 條的 100 筆上限；② `updated` 回傳的是實際
 * UPDATE 到的列數，全送會讓「我到底改了幾題」這件事對不起來。
 *
 * 〔stage5 WS-A〕列上有 score／error_types／response／note 時一起比：只有改過的鍵會出現，
 * 而且只要其中任何一個改了，那一題就要送（連同目前的 result——API 的 result 是必填）。
 * 列上**沒有**這些鍵（舊的呼叫方式）時，輸出與原本逐位元相同。
 *
 * @param {Array<{question_id:number, result:0|1|null}>} original 進來時的狀態（GET /api/papers/:id）
 * @param {Array<{question_id:number, result:0|1|null}>} current  使用者按完之後的狀態
 * @returns {Array<{question_id:number, result:0|1|null}>} 依 current 的順序
 */
export function diffResults(original, current) {
    const before = new Map((original || []).map(r => [r.question_id, r]));
    const out = [];
    for (const row of current || []) {
        const prev = before.get(row.question_id) || {};
        const now = row.result ?? null;
        const entry = { question_id: row.question_id, result: now };
        let changed = (prev.result ?? null) !== now;
        for (const k of DETAIL_KEYS) {
            if (!(k in row)) continue;
            if (!sameDetail(prev[k], row[k])) {
                entry[k] = Array.isArray(row[k]) ? [...row[k]] : (row[k] ?? null);
                changed = true;
            }
        }
        // 〔retrain PR-4〕「要重練」勾選（API-10 的 results[i].retrain，R1 選 2）：只有列上有這個鍵（旗標開啟而且是新題）
        // 而且與進來時不同才送——伺服器「沒送＝不動」。旗標關閉時列上沒有這個鍵，輸出與原本逐位元相同。
        if ('retrain' in row && Boolean(prev.retrain) !== Boolean(row.retrain)) {
            entry.retrain = Boolean(row.retrain);
            changed = true;
        }
        if (changed) out.push(entry);
    }
    return out;
}

/**
 * 〔retrain PR-4〕批改儲存後的提示（API-10 回應的 retrain 摘要，第 5.3 節）：
 * 「3 題進入重練清單、1 題練到會。」；這次改成「錯」卻沒勾「要重練」、而且**儲存後確實不在清單上**的新題另外提醒
 * （第 7.1 節風險 R-12）。沒有任何變化時回空字串（不提示）。
 *
 * 〔retrain 審查修正〕opts：
 *   unverified   true＝沒能確認清單（儲存後讀 API-1 失敗）：只說「答錯但沒勾」，不斷言「不會進清單」
 *                （承上組同組題被勾時、或這一題本來就有手動加入的項目時，它其實在清單上）。
 *   masteredKept 這次改成「錯」的重練題裡，老師「判定已會」的題數：override 優先，答錯不改狀態（仍是練到會；
 *                設計稿第 4.4 節兩列規則的衝突待 Owner 裁決，第 5.6.6 節），另外說一句，免得老師以為會回第 1 關。
 * @param {{entered?:number, advanced?:number, mastered?:number, reset?:number}|null|undefined} summary
 * @param {number} [wrongUnflagged] 這次改成「錯」、沒勾「要重練」、而且不在清單上的新題數
 * @param {{unverified?:boolean, masteredKept?:number}} [opts]
 * @returns {string}
 */
export function retrainSaveMessage(summary, wrongUnflagged = 0, { unverified = false, masteredKept = 0 } = {}) {
    const s = summary || {};
    const parts = [];
    if (s.entered > 0) parts.push(`${s.entered} 題進入重練清單`);
    if (s.advanced > 0) parts.push(`${s.advanced} 題升一關`);
    if (s.mastered > 0) parts.push(`${s.mastered} 題練到會`);
    if (s.reset > 0) parts.push(`${s.reset} 題答錯回到第 1 關`);
    const out = [];
    if (parts.length) out.push(`${parts.join('、')}。`);
    if (wrongUnflagged > 0) {
        out.push(unverified
            ? `這次有 ${wrongUnflagged} 題答錯但沒勾「要重練」。`
            : `這次有 ${wrongUnflagged} 題答錯但沒勾「要重練」，不會進清單。`);
    }
    if (masteredKept > 0) out.push(`有 ${masteredKept} 題重練題已「判定已會」，答錯不改狀態（仍是練到會；要再練請到錯題重練卡按「重新加入」）。`);
    return out.join('');
}

/**
 * 〔retrain 審查修正〕儲存後的兩個補充提示要看清單現況（純函式；items＝API-1 `status=all` 的 items）：
 *   wrongUnflagged  答錯沒勾的新題裡，**不在清單上**的（沒有項目，或項目已移出）。承上組同組題被勾時整組進清單
 *                   （reason = group）、之前手動加入過的題（manual）都在清單上，不算。
 *   masteredKept    答錯的重練題裡，項目是老師「判定已會」（teacher_override = mastered）的。
 * @param {Array<{question_id:number, status:string, teacher_override:string|null}>} items
 * @param {{wrongUnflagged?:number[], wrongRetrain?:number[]}} candidates 題號
 * @returns {{wrongUnflagged:number, masteredKept:number}}
 */
export function retrainHintCounts(items, { wrongUnflagged = [], wrongRetrain = [] } = {}) {
    const byQ = new Map((items || []).map(it => [Number(it.question_id), it]));
    const inList = q => { const it = byQ.get(Number(q)); return Boolean(it) && it.status !== 'retired'; };
    return {
        wrongUnflagged: wrongUnflagged.filter(q => !inList(q)).length,
        masteredKept: wrongRetrain.filter(q => { const it = byQ.get(Number(q)); return Boolean(it) && it.teacher_override === 'mastered'; }).length
    };
}

/**
 * 〔retrain PR-4〕學生清單（下拉選單）上的「到期 N」徽章（API-4）：接在名字後面；沒有到期的題就維持原文字。
 * @param {string} base 原本的選項文字（以姓名開頭）
 * @param {string} name 姓名
 * @param {number} due 到期題數
 * @returns {string}
 */
export function retrainOptionLabel(base, name, due) {
    if (!(due > 0) || !String(base).startsWith(name)) return base;
    return `${name}【到期 ${due}】${String(base).slice(name.length)}`;
}

/**
 * 〔stage5 WS-A〕這一科能用的錯因（subjects 為 null＝全部科目；chem_equation 只給化學）。
 * @param {Array<{code:string, label:string, subjects:string[]|null}>} types GET /api/error-types 的 items
 * @param {string} subject 題目的科目
 * @returns {Array<{code:string, label:string, subjects:string[]|null}>}
 */
export function applicableErrorTypes(types, subject) {
    return (types || []).filter(t => t && (t.subjects === null || t.subjects === undefined
        || (Array.isArray(t.subjects) && t.subjects.includes(subject))));
}

/** 〔stage5 WS-A〕哪些題型可以部分給分（第 4.1 條第 7 項：計算題與證明題）。 */
export const PARTIAL_SCORE_TYPES = ['計算', '證明'];

/**
 * 〔stage5 WS-A〕部分給分的輸入框是百分比（0～100 的整數），API 存的是 0～1、兩位小數。
 * @param {any} raw 輸入框的字串
 * @returns {number|null|undefined} 空字串＝null（不給分）；不合法＝undefined
 */
export function scoreFromPercent(raw) {
    const s = String(raw ?? '').trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 100 || String(n) !== s) return undefined;
    return n / 100;
}

/**
 * 〔stage5 WS-A〕API 的 score（0～1）→ 輸入框顯示的百分比字串；null 顯示空白。
 * @param {number|null|undefined} score
 * @returns {string}
 */
export function percentOfScore(score) {
    if (score === null || score === undefined || Number.isNaN(Number(score))) return '';
    return String(Math.round(Number(score) * 100));
}

/**
 * 〔stage5 WS-A〕學生檔案的一行摘要（管理面板用）。沒填的欄位略過；全部沒填回空字串。
 * @param {{grade?:number|null, track?:string|null, target_exams?:string[], school?:string|null, textbook_version?:string|null}} st
 * @returns {string}
 */
export function profileSummary(st) {
    const GRADE_LABEL = { 10: '高一', 11: '高二', 12: '高三' };
    const parts = [];
    if (st && GRADE_LABEL[st.grade]) parts.push(GRADE_LABEL[st.grade]);
    if (st && st.track) parts.push(st.track);
    if (st && Array.isArray(st.target_exams) && st.target_exams.length) parts.push(st.target_exams.join('／'));
    if (st && st.school) parts.push(st.school);
    if (st && st.textbook_version) parts.push(`${st.textbook_version}版`);
    return parts.join('・');
}

/**
 * 〔stage5 WS-A〕學生檔案表單：只送改過的欄位（PATCH 沒送的欄位不動）。
 * @param {object} original GET /api/students 的一列
 * @param {object} edited   表單目前的值（六個檔案欄位）
 * @returns {object} 改過的欄位；沒有改動時是空物件
 */
export function diffProfile(original, edited) {
    const out = {};
    for (const k of ['grade', 'track', 'target_exams', 'school', 'textbook_version', 'note']) {
        if (!(k in (edited || {}))) continue;
        if (!sameDetail((original || {})[k], edited[k])) {
            out[k] = Array.isArray(edited[k]) ? [...edited[k]] : (edited[k] ?? null);
        }
    }
    return out;
}

/**
 * 把 `trend_weekly` 攤成畫圖用的點。
 *
 * `week_start` 是 `'YYYY-MM-DD'` **字串**（第 1.5 條明說不要轉成 Date，會差一天）；
 * 這裡只用 `Date.parse` 算「距離第一週幾週」當 x 座標，不把它變成本地時間顯示。
 *
 * 後端只回**有資料的週**、不補零。所以 `gapBefore` 標出「這個點與前一個點之間隔了一週以上」，
 * 讓圖上那一段畫成虛線——把它們直接連起來等於宣稱中間那幾週是連續的，那是假的。
 *
 * @param {Array<{week_start:string, graded:number, wrong:number}>} trend
 * @returns {{points:Array<{week_start:string, x:number, graded:number, wrong:number, rate:number|null, gapBefore:boolean}>, spanWeeks:number, maxGraded:number}}
 */
export function weekPoints(trend) {
    const rows = (trend || []).filter(r => r && typeof r.week_start === 'string');
    if (rows.length === 0) return { points: [], spanWeeks: 0, maxGraded: 0 };

    const base = Date.parse(`${rows[0].week_start}T00:00:00Z`);
    const points = rows.map((r, i) => {
        const x = Math.round((Date.parse(`${r.week_start}T00:00:00Z`) - base) / (7 * 86400000));
        const graded = Number(r.graded) || 0;
        const wrong = Number(r.wrong) || 0;
        return {
            week_start: r.week_start,
            x,
            graded,
            wrong,
            rate: graded > 0 ? wrong / graded : null,
            gapBefore: false,
            _i: i
        };
    });
    for (let i = 1; i < points.length; i++) {
        points[i].gapBefore = points[i].x - points[i - 1].x > 1;
    }
    return {
        points,
        spanWeeks: points[points.length - 1].x,
        maxGraded: points.reduce((m, p) => Math.max(m, p.graded), 0)
    };
}

// ───────────────────────── 手寫 mock（只有 ?mock=1 讀得到）─────────────────────────

const MOCK = {
    students: {
        items: [
            // 〔stage5 WS-A〕後六欄是學生檔案（第 4.1 條第 4 項）；B、C 示範「還沒填檔案」
            { id: 3, name: '示範學生 A', papers: 4, graded_ratio: 0.625, grade: 11, track: '自然組', target_exams: ['學測', '分科'], school: '示範高中', textbook_version: '龍騰', note: null },
            { id: 4, name: '示範學生 B', papers: 1, graded_ratio: 0, grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null },
            { id: 5, name: '示範學生 C', papers: 0, graded_ratio: 0, grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null }
        ]
    },
    papers: {
        items: [
            { paper_id: 41, title: '示範學生 A-向量內積特訓卷(2026_8_21)', created_at: '2026-08-21T09:12:33.412Z', total: 4, graded: 3 },
            { paper_id: 38, title: '示範學生 A-牛頓運動定律複習卷(2026_8_10)', created_at: '2026-08-10T02:41:07.000Z', total: 3, graded: 3 }
        ]
    },
    paper: {
        41: {
            id: 41, title: '示範學生 A-向量內積特訓卷(2026_8_21)', student_id: 3,
            created_at: '2026-08-21T09:12:33.412Z',
            // 〔stage5 WS-A〕第 4.1 條第 2 項多帶的欄位：科目、章節、標準答案、詳解與批改細節
            questions: [
                { question_id: 12, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。', question_type: '填空', difficulty: 3, result: 1,
                    subject: '數學', chapter: '向量內積', answer_text: '$k=-\\frac{3}{2}$', solution_text: '垂直則內積為 0：$3+2k=0$，得 $k=-\\frac{3}{2}$。（示範文字）', solution_src: 'verify',
                    score: null, error_types: [], response: null, teacher_note: null },
                { question_id: 87, question_text: '求 $\\vec{a}=(6,8)$ 在 $\\vec{b}=(1,0)$ 上的投影長。', question_type: '計算', difficulty: 3, result: 0,
                    subject: '數學', chapter: '向量內積', answer_text: '$6$', solution_text: null, solution_src: null,
                    score: 0.5, error_types: ['calc'], response: '8', teacher_note: '方向看反了' },
                { question_id: 91, question_text: '試證：$|\\vec{a}\\cdot\\vec{b}| \\leq |\\vec{a}||\\vec{b}|$。', question_type: '證明', difficulty: 5, result: null,
                    subject: '數學', chapter: '向量內積', answer_text: '（證明題）', solution_text: null, solution_src: null,
                    score: null, error_types: [], response: null, teacher_note: null },
                { question_id: 103, question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。', question_type: '計算', difficulty: 2, result: 0,
                    subject: '數學', chapter: '向量內積', answer_text: '$3$', solution_text: null, solution_src: null,
                    score: null, error_types: [], response: null, teacher_note: null }
            ]
        },
        38: {
            id: 38, title: '示範學生 A-牛頓運動定律複習卷(2026_8_10)', student_id: 3,
            created_at: '2026-08-10T02:41:07.000Z',
            questions: [
                { question_id: 128, question_text: '質量 $2$ kg 的物體受合力 $10$ N，求加速度。', question_type: '計算', difficulty: 2, result: 1 },
                { question_id: 131, question_text: '斜面傾角 $30^\\circ$、摩擦係數 $0.2$，求加速度。', question_type: '計算', difficulty: 4, result: 0 },
                { question_id: 140, question_text: '說明作用力與反作用力為何不互相抵消。', question_type: '證明', difficulty: 3, result: 1 }
            ]
        }
    },
    weakness: {
        by_chapter: [
            { chapter: '向量內積', assigned: 12, graded: 9, wrong: 5, wrong_rate: 0.5556, low_sample: false },
            { chapter: '摩擦力與向心力', assigned: 6, graded: 4, wrong: 2, wrong_rate: 0.5, low_sample: true },
            { chapter: '牛頓運動定律', assigned: 20, graded: 18, wrong: 4, wrong_rate: 0.2222, low_sample: false },
            { chapter: '實數', assigned: 3, graded: 0, wrong: 0, wrong_rate: null, low_sample: true }
        ],
        by_type: [
            { question_type: '計算', assigned: 20, graded: 14, wrong: 6, wrong_rate: 0.4286, low_sample: false },
            { question_type: '證明', assigned: 5, graded: 3, wrong: 1, wrong_rate: 0.3333, low_sample: true },
            { question_type: '填空', assigned: 16, graded: 14, wrong: 4, wrong_rate: 0.2857, low_sample: false }
        ],
        by_difficulty: [
            { difficulty: 4, assigned: 8, graded: 3, wrong: 2, wrong_rate: 0.6667, low_sample: true },
            { difficulty: 3, assigned: 18, graded: 16, wrong: 6, wrong_rate: 0.375, low_sample: false },
            { difficulty: 2, assigned: 15, graded: 12, wrong: 3, wrong_rate: 0.25, low_sample: false }
        ],
        // 刻意在 08-03 與 08-17 之間留一個空週：那一段必須畫成虛線（不補零）。
        trend_weekly: [
            { week_start: '2026-07-27', graded: 6, wrong: 3 },
            { week_start: '2026-08-03', graded: 10, wrong: 2 },
            { week_start: '2026-08-17', graded: 12, wrong: 5 }
        ],
        recent_wrong: [
            { question_id: 87, chapter: '向量內積', question_text: '求 $\\vec{a}=(6,8)$ 在 $\\vec{b}=(1,0)$ 上的投影長。', assigned_at: '2026-08-21', error_types: ['calc'], score: 0.5 },
            { question_id: 103, chapter: '向量內積', question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。', assigned_at: '2026-08-21', error_types: [], score: null },
            { question_id: 131, chapter: '摩擦力與向心力', question_text: '斜面傾角 $30^\\circ$、摩擦係數 $0.2$，求加速度。', assigned_at: '2026-08-10', error_types: ['concept', 'calc'], score: null }
        ],
        // 〔stage5 WS-A〕錯因分布（share 的分母是錯題數，一題可多選，所以加總可能超過 100%）
        by_error_type: [
            { error_type: 'calc', label: '計算錯誤', count: 2, share: 0.6667 },
            { error_type: 'concept', label: '觀念不清', count: 1, share: 0.3333 }
        ]
    },
    // 〔stage5 WS-A〕只給 ?mock=1 排版用的**節錄**：正式路徑一律讀 GET /api/error-types 與
    // GET /api/student-profile-options（唯一真相在 config/errorTypes.js、config/studentProfile.js）
    errorTypes: {
        items: [
            { code: 'concept', label: '觀念不清', subjects: null },
            { code: 'calc', label: '計算錯誤', subjects: null },
            { code: 'blank', label: '未作答', subjects: null },
            { code: 'chem_equation', label: '化學式或係數', subjects: ['化學'] }
        ],
        max_per_attempt: 5
    },
    profileOptions: {
        grades: [10, 11, 12], tracks: ['自然組', '社會組'], target_exams: ['學測', '分科'],
        textbook_versions: ['龍騰', '翰林'], school_max_length: 50, note_max_length: 500
    }
};

/**
 * 把假資料包成 Response 的樣子，讓上層完全不必知道自己在 mock。
 * @param {any} body
 * @param {number} [status]
 * @returns {Promise<Response>}
 */
function mockResponse(body, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    }));
}

/**
 * 唯一的 fetch 出口：?mock=1 時攔截，否則原樣走 ExamApp.apiFetch。
 * @param {object} app
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<Response>}
 */
function request(app, url, options) {
    if (!mockEnabled()) return app.apiFetch(url, options);

    const method = (options && options.method) || 'GET';
    const path = url.split('?')[0];
    if (method === 'GET' && path === '/api/students') return mockResponse(MOCK.students);
    if (method === 'GET' && /^\/api\/students\/\d+\/papers$/.test(path)) return mockResponse(MOCK.papers);
    if (method === 'GET' && /^\/api\/students\/\d+\/weakness$/.test(path)) return mockResponse(MOCK.weakness);
    if (method === 'GET' && /^\/api\/papers\/\d+$/.test(path)) {
        const doc = MOCK.paper[Number(path.split('/').pop())];
        return doc ? mockResponse(doc) : mockResponse({ message: '找不到該試卷' }, 404);
    }
    if (method === 'PATCH' && /^\/api\/papers\/\d+\/results$/.test(path)) {
        const sent = JSON.parse((options && options.body) || '{"results":[]}');
        return mockResponse({ updated: sent.results.length });
    }
    // 〔stage5 WS-A〕
    if (method === 'GET' && path === '/api/error-types') return mockResponse(MOCK.errorTypes);
    if (method === 'GET' && path === '/api/student-profile-options') return mockResponse(MOCK.profileOptions);
    if (method === 'PATCH' && /^\/api\/students\/\d+$/.test(path)) {
        const sent = JSON.parse((options && options.body) || '{}');
        const base = MOCK.students.items.find(st => st.id === Number(path.split('/').pop())) || {};
        return mockResponse({ ...base, ...sent });
    }
    return mockResponse({ message: `mock 沒有覆蓋 ${method} ${url}` }, 501);
}

// ───────────────────────── DOM 小工具 ─────────────────────────

/**
 * 建元素。含連字號的鍵（aria-label、data-*）與 role 一律走 setAttribute——
 * Object.assign 對 aria-* 只會在物件上多掛一個屬性、畫面上什麼都不會發生；
 * role 雖然在新版瀏覽器有屬性反射，但寫成 attribute 才是各家都吃得到的那一種。
 * @param {string} tag
 * @param {string} [cls]
 * @param {object} [props]
 * @returns {HTMLElement}
 */
function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(props || {})) {
        if (k.includes('-') || k === 'role') node.setAttribute(k, String(v));
        else node[k] = v;
    }
    return node;
}

function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
}

/**
 * 讀回應的 message。API 的錯誤字串是凍結的，一律原樣顯示。
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function messageOf(res) {
    const body = await res.json().catch(() => ({}));
    return body.message || `HTTP ${res.status}`;
}

// ───────────────────────── ≤60 行的 inline SVG 週趨勢 ─────────────────────────

/**
 * 週趨勢圖：灰色長條 = 該週批改題數，折線 = 該週錯誤率。
 * 沒有圖表函式庫（規劃 §4.1 的 Non-goal），整支就是下面這些 <rect>／<polyline>。
 *
 * @param {Array<{week_start:string, graded:number, wrong:number}>} trend
 * @returns {SVGElement}
 */
export function trendSvg(trend) {
    const W = 640, H = 160, PAD_L = 34, PAD_R = 12, PAD_T = 12, PAD_B = 26;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'w-full h-40', role: 'img', 'aria-label': '每週批改題數與錯誤率趨勢' });
    const { points, spanWeeks, maxGraded } = weekPoints(trend);
    if (points.length === 0) {
        svg.appendChild(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 13 }))
            .textContent = '這段時間窗內沒有任何批改紀錄——出卷後記得回來批改，趨勢圖才有東西畫。';
        return svg;
    }
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const xOf = p => PAD_L + (spanWeeks === 0 ? plotW / 2 : (p.x / spanWeeks) * plotW);
    const yOf = rate => PAD_T + plotH * (1 - rate);
    const barW = Math.max(4, Math.min(26, plotW / Math.max(1, spanWeeks + 1) * 0.5));

    for (const g of [0, 0.5, 1]) {                       // 0%／50%／100% 三條底線與刻度
        svg.appendChild(svgEl('line', { x1: PAD_L, y1: yOf(g), x2: W - PAD_R, y2: yOf(g), stroke: '#e2e8f0', 'stroke-width': 1 }));
        const t = svgEl('text', { x: PAD_L - 6, y: yOf(g) + 4, 'text-anchor': 'end', fill: '#94a3b8', 'font-size': 10 });
        t.textContent = `${Math.round(g * 100)}%`;
        svg.appendChild(t);
    }
    for (const p of points) {                             // 批改題數：灰底長條（右軸沒有刻度，只看相對高低）
        const h = maxGraded === 0 ? 0 : (p.graded / maxGraded) * plotH * 0.9;
        svg.appendChild(svgEl('rect', {
            x: xOf(p) - barW / 2, y: PAD_T + plotH - h, width: barW, height: h,
            fill: '#e0e7ff', rx: 2
        })).appendChild(svgEl('title', {})).textContent = `${p.week_start}　批改 ${p.graded} 題、錯 ${p.wrong} 題`;
    }
    // 錯誤率折線：graded=0 的週沒有錯誤率（rate 為 null），該點與相鄰段一律斷開；
    // 中間跳過的週（gapBefore）畫成虛線，不假裝那幾週是連續的（第 1.5 條：不補零）。
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.rate === null || b.rate === null) continue;
        svg.appendChild(svgEl('line', {
            x1: xOf(a), y1: yOf(a.rate), x2: xOf(b), y2: yOf(b.rate),
            stroke: '#e11d48', 'stroke-width': 2, 'stroke-linecap': 'round',
            ...(b.gapBefore ? { 'stroke-dasharray': '4 4', opacity: 0.65 } : {})
        }));
    }
    for (const p of points) {
        if (p.rate === null) continue;
        svg.appendChild(svgEl('circle', { cx: xOf(p), cy: yOf(p.rate), r: 3.5, fill: '#e11d48' }))
            .appendChild(svgEl('title', {})).textContent = `${p.week_start}　錯誤率 ${formatPercent(p.rate)}`;
    }
    for (const p of points) {                             // x 軸只標頭尾兩週，避免擠成一團
        if (p !== points[0] && p !== points[points.length - 1]) continue;
        const t = svgEl('text', { x: xOf(p), y: H - 8, 'text-anchor': p === points[0] ? 'start' : 'end', fill: '#94a3b8', 'font-size': 10 });
        t.textContent = p.week_start;
        svg.appendChild(t);
    }
    return svg;
}

// ───────────────────────── 弱點三張表 ─────────────────────────

const TABLE_SPECS = [
    { key: 'by_chapter', field: 'chapter', title: '章節', hint: '錯誤率由高到低；同率時批改多的在前。' },
    { key: 'by_type', field: 'question_type', title: '題型', hint: '五種題型的相對表現。' },
    { key: 'by_difficulty', field: 'difficulty', title: '難度', hint: '難度 1~5（★ 數）。' }
];

/**
 * 一張弱點表：純 CSS 橫條，沒有任何圖表函式庫。
 * @param {object} app
 * @param {{key:string, field:string, title:string, hint:string}} spec
 * @param {Array<object>} rows
 * @returns {HTMLElement}
 */
function weaknessTable(app, spec, rows) {
    const box = el('div', 'rounded-2xl border border-slate-200 bg-white p-4');
    box.append(
        el('p', 'eyebrow text-indigo-400', { textContent: spec.title }),
        el('p', 'mt-1 mb-3 text-xs text-slate-400', { textContent: spec.hint })
    );
    if (!rows || rows.length === 0) {
        box.appendChild(el('p', 'text-sm text-slate-400', { textContent: '這段時間窗內沒有已批改的作答（沒批改不等於全對）。出卷後在下方試卷列表批改，或把右上的時間窗拉長。' }));
        return box;
    }
    const list = el('div', 'space-y-2.5');
    for (const row of rows) {
        const raw = row[spec.field];
        const name = spec.field === 'difficulty' ? '★'.repeat(Number(raw) || 0) || String(raw) : String(raw ?? '（未分類）');

        const line = el('div', '');
        const head = el('div', 'flex items-baseline justify-between gap-2 text-xs');
        const left = el('span', 'font-bold text-slate-700 truncate', { textContent: name });
        const right = el('span', 'shrink-0 font-mono text-slate-500');
        right.textContent = `${formatPercent(row.wrong_rate)}　(${row.wrong}/${row.graded}，出過 ${row.assigned})`;
        head.append(left, right);

        const track = el('div', 'mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100');
        const fill = el('div', `h-full rounded-full ${row.low_sample ? 'bg-slate-300' : 'bg-rose-400'}`);
        fill.style.width = `${barPercent(row.wrong_rate)}%`;
        track.appendChild(fill);

        line.append(head, track);
        if (row.low_sample) {
            // 第 1.5 條：low_sample 涵蓋 graded = 0。標籤要明說「不是表現好，是還不知道」。
            line.appendChild(el('p', 'mt-1 text-[11px] font-bold text-amber-600', {
                textContent: row.graded === 0 ? '樣本不足（這段期間還沒批改過）' : `樣本不足（只批改了 ${row.graded} 題）`
            }));
        }
        list.appendChild(line);
    }
    box.appendChild(list);
    return box;
}

// ───────────────────────── 〔stage5 WS-A〕錯因分布 ─────────────────────────

/**
 * 錯因分布表（by_error_type，第 4.1 條第 3 項）。與上面三張表同一種純 CSS 橫條。
 * share 的分母是「這段期間的錯題數」，一題可以標多個錯因，所以加總可能超過 100%——要寫在提示裡。
 * @param {Array<{error_type:string, label:string|null, count:number, share:number|null}>} rows
 * @returns {HTMLElement}
 */
function errorTypeTable(rows) {
    const box = el('div', 'mt-4 rounded-2xl border border-slate-200 bg-white p-4', { 'data-weakness': 'by_error_type' });
    box.append(
        el('p', 'eyebrow text-rose-400', { textContent: '錯因分布' }),
        el('p', 'mt-1 mb-3 text-xs text-slate-400', {
            textContent: '比例＝標了這個錯因的錯題 ÷ 這段期間的錯題數；一題可以標多個錯因，所以加總可能超過 100%。'
        })
    );
    if (!rows || rows.length === 0) {
        box.appendChild(el('p', 'text-sm text-slate-400', {
            textContent: '這段時間窗內的錯題還沒有標錯因。批改時按「錯」就能點選錯因，之後這裡會告訴你他最常錯在哪一類。'
        }));
        return box;
    }
    const list = el('div', 'space-y-2.5');
    for (const row of rows) {
        const line = el('div', '');
        const head = el('div', 'flex items-baseline justify-between gap-2 text-xs');
        head.append(
            // label 為 null＝資料庫裡有白名單外的代碼：原樣顯示代碼，讓老師看得到
            el('span', 'font-bold text-slate-700 truncate', { textContent: row.label || row.error_type }),
            el('span', 'shrink-0 font-mono text-slate-500', { textContent: `${formatPercent(row.share)}　(${row.count} 題)` })
        );
        const track = el('div', 'mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100');
        const fill = el('div', 'h-full rounded-full bg-amber-400');
        fill.style.width = `${barPercent(row.share)}%`;
        track.appendChild(fill);
        line.append(head, track);
        list.appendChild(line);
    }
    box.appendChild(list);
    return box;
}

// 錯因白名單與學生檔案選項：各打一次後端、快取在模組裡（兩者都是設定，不會在一次瀏覽中改變）。
// 失敗時不快取，下一次需要時再試；呼叫端拿到 null 就退回「只記對錯」「不能編輯檔案」。
let errorTypesPromise = null;
let profileOptionsPromise = null;

/**
 * GET /api/error-types（〔stage5 WS-A〕）。
 * @param {object} app
 * @returns {Promise<{items:Array<{code:string,label:string,subjects:string[]|null}>, max:number}|null>}
 */
function loadErrorTypes(app) {
    if (!errorTypesPromise) {
        errorTypesPromise = request(app, '/api/error-types')
            .then(async res => {
                if (!res.ok) return null;
                const body = await res.json();
                return {
                    items: Array.isArray(body.items) ? body.items : [],
                    max: Number.isInteger(body.max_per_attempt) ? body.max_per_attempt : 5
                };
            })
            .catch(() => null)
            .then(v => { if (v === null) errorTypesPromise = null; return v; });
    }
    return errorTypesPromise;
}

/**
 * GET /api/student-profile-options（〔stage5 WS-A〕，核心區）。
 * @param {object} app
 * @returns {Promise<object|null>}
 */
function loadProfileOptions(app) {
    if (!profileOptionsPromise) {
        profileOptionsPromise = request(app, '/api/student-profile-options')
            .then(res => (res.ok ? res.json() : null))
            .catch(() => null)
            .then(v => { if (v === null) profileOptionsPromise = null; return v; });
    }
    return profileOptionsPromise;
}

/**
 * 錯因代碼 → 標籤。先用白名單，其次用這次弱點回應裡 by_error_type 帶的標籤，都沒有就原樣顯示代碼。
 * @param {{items:Array<{code:string,label:string}>}|null} types
 * @param {Array<{error_type:string,label:string|null}>} [byErrorType]
 * @returns {(code:string) => string}
 */
function errorLabeler(types, byErrorType) {
    const map = new Map();
    for (const r of byErrorType || []) if (r && r.label) map.set(r.error_type, r.label);
    for (const t of (types && types.items) || []) map.set(t.code, t.label);
    return code => map.get(code) || code;
}

// ───────────────────────── 最近錯題 ─────────────────────────

/**
 * 最近錯題清單，每列兩顆按鈕：找相似（庫內既有題）／出變式（可能要生成、要花錢）。
 * 兩顆都只發 CustomEvent，實際的請求與輪詢由 variants.js 做（第 3 條）。
 * @param {object} app
 * @param {Array<object>} rows
 * @param {() => number|null} studentIdOf
 * @returns {HTMLElement}
 */
function recentWrongList(app, rows, studentIdOf, labelOf = code => code) {
    const box = el('div', 'rounded-2xl border border-slate-200 bg-white p-4');
    box.append(
        el('p', 'eyebrow text-rose-400', { textContent: '最近錯題' }),
        el('p', 'mt-1 mb-3 text-xs text-slate-400', { textContent: '最多 20 題，由近到遠（interfaces-stage3.md 第 1.5 條）。' })
    );
    if (!rows || rows.length === 0) {
        box.appendChild(el('p', 'text-sm text-slate-400', { textContent: '這段時間窗內沒有批改出來的錯題——可能是真的都對，也可能是還沒批改。批改過的錯題才會出現在這裡。' }));
        return box;
    }

    // 裁決 S3-R25：兩顆按鈕各自看自己的旗標，不再綁在一起。
    const buttons = [
        ['similar', '找相似', 'border-indigo-200 text-indigo-700 hover:bg-indigo-50', similarEnabled()],
        ['variant', '出變式', 'border-violet-200 text-violet-700 hover:bg-violet-50', variantsEnabled()]
    ].filter(([, , , on]) => on);
    const offNote = [
        !similarEnabled() ? 'FEATURE_SIMILAR 未開啟：「找相似」暫時不可用。' : '',
        !variantsEnabled() ? 'FEATURE_VARIANTS 未開啟：「出變式」暫時不可用。' : ''
    ].filter(Boolean).join('　');

    const list = el('div', 'space-y-2');
    for (const row of rows) {
        const card = el('div', 'rounded-xl border border-slate-100 bg-slate-50/60 p-3');
        card.appendChild(el('p', 'text-[11px] font-bold text-slate-400', {
            textContent: `#${row.question_id}　·　${row.chapter ?? '（未分類）'}　·　${row.assigned_at}`
        }));
        const stem = el('p', 'mt-1 text-sm text-slate-700');
        stem.textContent = row.question_text || '';
        card.appendChild(stem);
        app.renderMath(stem);

        // 〔stage5 WS-A〕批改時標的錯因與部分給分（第 4.1 條第 3 項：recent_wrong 多 error_types、score）
        const tags = Array.isArray(row.error_types) ? row.error_types : [];
        if (tags.length > 0 || (row.score !== null && row.score !== undefined)) {
            const bits = [];
            if (tags.length > 0) bits.push(`錯因：${tags.map(labelOf).join('、')}`);
            if (row.score !== null && row.score !== undefined) bits.push(`部分給分 ${percentOfScore(row.score)}%`);
            card.appendChild(el('p', 'mt-1 text-[11px] font-bold text-amber-700', {
                textContent: bits.join('　·　'), 'data-recent-detail': String(row.question_id)
            }));
        }

        if (buttons.length) {
            const actions = el('div', 'mt-2 flex flex-wrap gap-2');
            for (const [action, label, cls] of buttons) {
                // data-variant-action 是給 variants.js 的：輪詢期間它會把畫面上所有
                // 帶這個屬性的按鈕一起停用（第 3.2 條的 60 秒輪詢，不該讓人連按五次）。
                const btn = el('button', `text-xs px-3 py-1.5 rounded-lg border bg-white font-bold cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${cls}`, {
                    type: 'button', textContent: label, 'data-variant-action': action
                });
                btn.addEventListener('click', () => {
                    document.dispatchEvent(new CustomEvent(VARIANT_EVENT, {
                        detail: {
                            action,
                            question_id: row.question_id,
                            student_id: studentIdOf(),
                            chapter: row.chapter ?? null,
                            question_text: row.question_text || ''
                        }
                    }));
                });
                actions.appendChild(btn);
            }
            card.appendChild(actions);
        }
        if (offNote) {
            // 少掉的那顆按鈕要說出是哪個旗標關著——不然看起來就只是「功能不見了」。
            card.appendChild(el('p', 'mt-2 text-[11px] text-slate-400', { textContent: offNote }));
        }
        list.appendChild(card);
    }
    box.appendChild(list);
    return box;
}

// ───────────────────────── 試卷列表與批改 ─────────────────────────

/**
 * 一張試卷的卡片：標題列 + 可展開的批改區。
 * @param {object} app
 * @param {object} paper GET /api/students/:id/papers 的一列
 * @param {() => void} onGraded 批改成功後的回呼（用來刷新弱點面板）
 * @returns {HTMLElement}
 */
function paperCard(app, paper, onGraded) {
    const card = el('div', 'rounded-2xl border border-slate-200 bg-white');
    card.dataset.paperId = String(paper.paper_id);

    const head = el('button', 'flex w-full items-center justify-between gap-3 p-4 text-left cursor-pointer', { type: 'button' });
    const left = el('div', 'min-w-0');
    left.append(
        el('p', 'truncate text-sm font-extrabold text-slate-800', { textContent: paper.title }),
        // 〔retrain PR-3〕卷名旁「含重練 N 題」（FEATURE_RETRAIN 開啟時 API 才帶 retrain_count；0 或沒有這個鍵就不渲染）
        ...(Number(paper.retrain_count) > 0 ? [el('span', 'mt-0.5 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700', {
            textContent: `含重練 ${Number(paper.retrain_count)} 題`
        })] : []),
        el('p', 'mt-0.5 text-[11px] text-slate-400', {
            textContent: `#${paper.paper_id}　·　${String(paper.created_at).slice(0, 10)}　·　已批改 ${paper.graded}／${paper.total} 題`
        })
    );
    const badge = el('span', `shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${paper.graded >= paper.total ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`, {
        textContent: paper.graded >= paper.total ? '已批完' : '待批改'
    });
    head.append(left, badge);

    const body = el('div', 'hidden border-t border-slate-100 p-4');
    card.append(head, body);

    let loaded = false;
    const toggle = async (forceOpen) => {
        const willOpen = forceOpen || body.classList.contains('hidden');
        body.classList.toggle('hidden', !willOpen);
        if (!willOpen || loaded) return;
        loaded = true;
        body.textContent = '載入中…';
        try {
            // 〔stage5 WS-A〕錯因白名單與試卷一起取（loadErrorTypes 有快取、失敗回 null 不丟錯）
            const [res, errorTypes] = await Promise.all([
                request(app, `/api/papers/${paper.paper_id}`),
                loadErrorTypes(app)
            ]);
            if (!res.ok) { body.textContent = await messageOf(res); loaded = false; return; }
            body.innerHTML = '';
            body.appendChild(gradingForm(app, await res.json(), badge, onGraded, errorTypes));
        } catch {
            body.textContent = '連線失敗，請稍後再試。';
            loaded = false;
        }
    };
    head.addEventListener('click', () => toggle(false));
    card.__open = () => toggle(true);
    return card;
}

/**
 * 批改表單：每題三顆按鈕（對／錯／未批）＋一顆「儲存批改」。
 *
 * 「未批」是真的要送出去的值（`result: null` = 取消批改，第 1.4 條），
 * 不是「不送這一題」——老師按錯之後要有辦法退回未批狀態。
 *
 * 〔stage5 WS-A〕每題另外有（docs/interfaces-stage5.md 第 4.1 條第 7 項）：
 *   - 按「錯」才出現的錯因 chip（可複選，最多 max_per_attempt 個；只列這一科能用的）
 *   - 計算題與證明題的部分給分（百分比輸入，存成 0～1）
 *   - 學生答案與老師註記（收在「學生答案與註記」裡，已有內容時預設展開）
 *   - 「看答案與詳解」：展開標準答案與文字詳解（標示詳解來源）
 *   狀態規則與伺服器同一條：改成「對」或「未批」時錯因清空；改成「未批」時部分給分也清空。
 *   〔stage5 整合〕在「對」與「錯」之間切換時，部分給分也清空（前端規則；伺服器仍是「沒送不動」）。
 *
 * @param {object} app
 * @param {object} detail GET /api/papers/:id 的回應
 * @param {HTMLElement} badge 卡片右上角的狀態標籤（存檔後要更新）
 * @param {() => void} onGraded
 * @param {{items:Array<{code:string,label:string,subjects:string[]|null}>, max:number}|null} [errorTypes]
 *        GET /api/error-types；null（載入失敗）時不畫錯因 chip，只能記對錯
 * @returns {HTMLElement}
 */
function gradingForm(app, detail, badge, onGraded, errorTypes = null) {
    const wrap = el('div', '');
    const toRow = q => ({
        question_id: q.question_id,
        result: q.result ?? null,
        score: q.score ?? null,
        error_types: Array.isArray(q.error_types) ? [...q.error_types] : [],
        response: q.response ?? null,
        note: q.teacher_note ?? null
    });
    const copyRow = r => ({ ...r, error_types: [...r.error_types] });
    const original = detail.questions.map(toRow);
    // 〔retrain PR-4〕旗標開啟而且 API-9 帶了 purpose 的新題才有 retrain 鍵（勾選狀態＝retrain_flagged；預設不勾）
    const retrainOn = retrainEnabled();
    if (retrainOn) {
        detail.questions.forEach((q, i) => { if (q.purpose === 'new') original[i].retrain = q.retrain_flagged === true; });
    }
    const current = original.map(copyRow);
    const allTypes = errorTypes && Array.isArray(errorTypes.items) ? errorTypes.items : [];
    const maxTypes = errorTypes && Number.isInteger(errorTypes.max) ? errorTypes.max : 5;

    const list = el('div', 'space-y-2');
    const repaints = [];   // W1-3：每列的重畫函式，「未批全對」批次改值後整批重畫
    detail.questions.forEach((q, i) => {
        const row = el('div', 'rounded-xl border border-slate-100 p-3');
        row.appendChild(el('p', 'text-[11px] font-bold text-slate-400', {
            textContent: `第 ${i + 1} 題　·　#${q.question_id}　·　${q.question_type}　·　${'★'.repeat(q.difficulty || 0)}`
        }));
        const stem = el('p', 'mt-1 text-sm text-slate-700');
        stem.textContent = q.question_text || '';
        row.appendChild(stem);
        app.renderMath(stem);

        const group = el('div', 'mt-2 inline-flex overflow-hidden rounded-lg border border-slate-200', {
            role: 'radiogroup', 'aria-label': `第 ${i + 1} 題的批改結果`
        });
        const buttons = [];
        const detailUi = gradingDetail(app, q, current[i], { allTypes, maxTypes });
        const paint = () => {
            for (const b of buttons) {
                const on = (current[i].result ?? null) === b.__value;
                b.className = 'px-3 py-1.5 text-xs font-bold cursor-pointer transition-colors ' +
                    (on ? b.__onClass : 'bg-white text-slate-500 hover:bg-slate-50');
                b.setAttribute('aria-checked', String(on));
            }
            detailUi.paint();
        };
        detailUi.onChange = paint;
        for (const [value, onClass] of [[1, 'bg-emerald-500 text-white'], [0, 'bg-rose-500 text-white'], [null, 'bg-slate-400 text-white']]) {
            const btn = el('button', '', { type: 'button', textContent: resultLabel(value), role: 'radio' });
            btn.__value = value;
            btn.__onClass = onClass;
            btn.addEventListener('click', () => {
                const prev = current[i].result ?? null;
                current[i].result = value;
                // 〔stage5 WS-A〕與伺服器同一條規則：只有答錯的題有錯因；取消批改連部分給分一起清
                if (value !== 0) current[i].error_types = [];
                if (value === null) current[i].score = null;
                // 〔stage5 整合〕對 ↔ 錯：部分給分是照原本的對錯填的（例如錯時填 0%），換邊之後就不成立了。
                // 留著的話 COALESCE(score, result) 會把「改成對」的題算成全錯。清掉（diffResults 會送 score: null），
                // 老師要給分就重新填，送出的是新值。
                else if (prev !== null && prev !== value && current[i].score !== null) {
                    current[i].score = null;
                    app.showToast(`第 ${i + 1} 題的結果改了，部分給分已清空；需要的話請重新填。`, 'info');
                }
                paint();
            });
            buttons.push(btn);
            group.appendChild(btn);
        }
        row.appendChild(group);
        // 〔retrain PR-4〕對錯按鈕旁：新題的「要重練」勾選框／重練題的「重練・第 n 關」徽章（旗標關閉時什麼都不畫）
        const retrainNode = retrainOn ? retrainGradingHook(q, current[i], i) : null;
        if (retrainNode) row.appendChild(retrainNode);
        row.appendChild(detailUi.node);
        paint();
        repaints.push(paint);
        list.appendChild(row);
    });

    // W1-3（docs/roadmap-plan.md §6）：家教的批改習慣是「只圈錯的」——
    // 這顆把**還沒批**的全部標為「對」，已標的（對或錯）一律不動；
    // 之後仍走同一條 diff → PATCH 路徑，「全有全無」的交易語意不變。
    const markRestCorrect = el('button', 'mt-3 w-full rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-sm font-bold text-emerald-700 transition-colors hover:bg-emerald-100 cursor-pointer', {
        type: 'button', textContent: '未批的全部標為對（只點錯的，十秒批完）'
    });
    markRestCorrect.addEventListener('click', () => {
        let changed = 0;
        for (const row of current) {
            if ((row.result ?? null) === null) { row.result = 1; row.error_types = []; changed += 1; }
        }
        for (const paint of repaints) paint();
        app.showToast(changed > 0 ? `已把 ${changed} 題標為「對」，記得按「儲存批改」。` : '沒有未批的題目。', changed > 0 ? 'success' : 'info');
    });

    const save = el('button', 'mt-4 w-full rounded-xl bg-emerald-600 p-3 font-extrabold text-white transition-all hover:bg-emerald-700 cursor-pointer', {
        type: 'button', textContent: '儲存批改'
    });
    const note = el('p', 'mt-2 text-xs text-slate-400', {
        textContent: '只會送出改過的題目（單一交易，全有全無）。學生空白沒寫的題，請按「錯」並點「未作答」，不要用上面那顆全部標對。'
    });

    save.addEventListener('click', async () => {
        const results = diffResults(original, current);
        if (results.length === 0) { app.showToast('沒有任何改動。', 'info'); return; }
        if (results.length > MAX_PATCH) {
            // 第 1.4 條的硬上限。分批送會破壞「全有全無」，所以誠實擋下來而不是偷偷切開。
            app.showToast(`一次最多儲存 ${MAX_PATCH} 筆批改，這次有 ${results.length} 筆。`, 'error');
            return;
        }
        // 〔retrain PR-4〕這次改成「錯」卻沒勾「要重練」的新題（儲存後提醒；不會自動進清單，R1 選 2）
        // 〔retrain 審查修正〕只是候選：儲存後對照清單（API-1），已在清單上的（承上組同組題被勾、手動加入過）不算；
        // 另收這次改成「錯」的重練題，用來提醒「判定已會的題答錯不改狀態」。
        const wrongUnflaggedIds = retrainOn
            ? current.filter((r, i) => 'retrain' in r && r.result === 0 && (original[i].result ?? null) !== 0 && !r.retrain).map(r => r.question_id)
            : [];
        const wrongRetrainIds = retrainOn
            ? detail.questions.filter((q, i) => q.purpose === 'retrain' && current[i].result === 0 && (original[i].result ?? null) !== 0)
                .map(q => q.question_id)
            : [];
        save.disabled = true;
        try {
            const res = await request(app, `/api/papers/${detail.id}/results`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ results })
            });
            if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
            const body = await res.json();
            app.showToast(`已儲存 ${body.updated} 題的批改結果。`, 'success');
            // 〔retrain PR-4〕API-10 的 retrain 摘要（旗標開啟時伺服器才帶這個鍵）
            if (retrainOn && body.retrain) {
                const hint = await retrainSaveHint(app, detail.student_id, wrongUnflaggedIds, wrongRetrainIds);
                const text = retrainSaveMessage(body.retrain, hint.wrongUnflagged, hint);
                if (text) app.showToast(text, 'info');
            }
            for (let i = 0; i < current.length; i++) original[i] = copyRow(current[i]);
            const graded = current.filter(r => r.result !== null).length;
            badge.textContent = graded >= current.length ? '已批完' : '待批改';
            badge.className = `shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${graded >= current.length ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`;
            onGraded();
        } catch {
            app.showToast('連線失敗，請稍後再試', 'error');
        } finally {
            save.disabled = false;
        }
    });

    wrap.append(list, markRestCorrect, save, note);
    return wrap;
}

/**
 * 〔retrain 審查修正〕批改儲存後的補充提示要對照清單現況：有候選題時讀一次 API-1（`status=all`），交給 retrainHintCounts。
 * 沒有候選題就不發請求（沒改成錯的儲存、旗標關閉都不會多打 API）。讀不到（連線失敗、非 2xx、學生 id 不明）時
 * unverified：只說「答錯但沒勾」，不斷言「不會進清單」，也不提判定已會。
 * @param {object} app
 * @param {number} studentId API-9 的 student_id
 * @param {number[]} wrongUnflaggedIds 這次改成「錯」、沒勾「要重練」的新題
 * @param {number[]} wrongRetrainIds  這次改成「錯」的重練題
 * @returns {Promise<{wrongUnflagged:number, masteredKept:number, unverified:boolean}>}
 */
async function retrainSaveHint(app, studentId, wrongUnflaggedIds, wrongRetrainIds) {
    if (!wrongUnflaggedIds.length && !wrongRetrainIds.length) return { wrongUnflagged: 0, masteredKept: 0, unverified: false };
    const sid = Number(studentId);
    try {
        if (!Number.isInteger(sid) || sid < 1) throw new Error('student_id');
        const res = await request(app, `/api/students/${sid}/retrain-items?status=all`);
        if (!res.ok) throw new Error(String(res.status));
        const list = await res.json();
        return { ...retrainHintCounts(list.items, { wrongUnflagged: wrongUnflaggedIds, wrongRetrain: wrongRetrainIds }), unverified: false };
    } catch {
        return { wrongUnflagged: wrongUnflaggedIds.length, masteredKept: 0, unverified: true };
    }
}

/**
 * 〔retrain PR-4〕批改卡對錯按鈕旁的掛鉤（docs/retrain-and-review.md 第 5.3 節；只在 FEATURE_RETRAIN 開啟時呼叫）。
 *   新題（purpose = new）  「要重練」勾選框：預設不勾（答錯也不自動勾，R1 選 2）；之前勾過的依 API-9 的 retrain_flagged 顯示已勾。
 *                         改勾選只改 state.retrain，儲存時由 diffResults 決定要不要送（沒改就不送）。
 *   重練題（purpose = retrain）不給勾選框，改標「重練・第 n 關」（要移出請到錯題重練清單上按）。
 *   伺服器沒帶 purpose（舊後端或旗標兩邊不一致）→ 什麼都不畫，也就不會送出伺服器不收的 retrain。
 * @param {object} q     GET /api/papers/:id 的一題
 * @param {object} state gradingForm 的 current[i]
 * @param {number} index 第幾題（0 起算）
 * @returns {HTMLElement|null}
 */
function retrainGradingHook(q, state, index) {
    if (q.purpose === 'retrain') {
        return el('span', 'ml-2 inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 align-middle text-[11px] font-extrabold text-violet-700', {
            textContent: `重練・第 ${q.retrain_step} 關`, 'data-retrain-badge': String(q.question_id)
        });
    }
    if (q.purpose !== 'new' || !('retrain' in state)) return null;
    const label = el('label', 'ml-3 inline-flex items-center gap-1 align-middle text-xs font-bold text-slate-600 cursor-pointer', {
        title: '勾了才會進這位學生的錯題重練清單；答錯不會自動進。'
    });
    const box = el('input', 'accent-violet-600', {
        type: 'checkbox', checked: state.retrain === true,
        'data-retrain-flag': String(q.question_id), 'aria-label': `第 ${index + 1} 題要重練`
    });
    box.addEventListener('change', () => { state.retrain = Boolean(box.checked); });
    label.append(box, el('span', '', { textContent: '要重練' }));
    return label;
}

/**
 * 〔retrain PR-4〕學生清單（#stuStudent 的選項）上的「到期 N」徽章：GET /api/retrain/summary（API-4，不回姓名，以 id 對應）。
 * 原本的選項文字記在節點的 JS 屬性上（不是 DOM 屬性），重複更新不會疊字。失敗就維持原文字。
 * @param {object} app
 */
async function refreshRetrainBadges(app) {
    const sel = document.getElementById('stuStudent');
    if (!sel) return;
    let body;
    try {
        const res = await request(app, '/api/retrain/summary');
        if (!res.ok) return;
        body = await res.json();
    } catch {
        return;
    }
    const dueOf = new Map(((body && body.items) || []).map(r => [String(r.student_id), Number(r.due) || 0]));
    for (const o of [...sel.options]) {
        const name = o.getAttribute('data-name');
        if (!name) continue;
        if (o.__retrainBase === undefined) o.__retrainBase = o.textContent;
        o.textContent = retrainOptionLabel(o.__retrainBase, name, dueOf.get(o.value) || 0);
    }
}

/**
 * 〔retrain PR-4〕通知錯題重練卡（retrain.js）：學生視圖載入了哪位學生，並更新到期徽章。
 * @param {object} app
 * @param {number|null} studentId
 */
function announceStudentView(app, studentId) {
    const sel = document.getElementById('stuStudent');
    const opt = sel ? [...sel.options].find(o => o.value === sel.value) : null;
    document.dispatchEvent(new CustomEvent(STUDENT_VIEW_EVENT, {
        detail: {
            student_id: studentId,
            student_name: studentId !== null && opt ? (opt.getAttribute('data-name') || '') : '',
            subject: (document.getElementById('stuSubject') || {}).value || '',
            days: Number((document.getElementById('stuDays') || {}).value) || DEFAULT_DAYS
        }
    }));
    if (studentId !== null) refreshRetrainBadges(app).catch(() => {});
}

/** 詳解來源的說明（questions.solution_src）。 */
const SOLUTION_SRC_LABEL = {
    verify: '管線驗算時由模型獨立解出、且與答案比對一致的摘要（未經人工審閱）',
    teacher: '老師撰寫',
    ai: 'AI 產生（未經人工審閱）'
};

/**
 * 〔stage5 WS-A〕一題的批改細節區塊：錯因 chip、部分給分、學生答案與註記、答案與詳解。
 *
 * 直接改傳進來的 state（gradingForm 的 current[i]），改完呼叫 `onChange` 讓整列重畫；
 * `paint()` 依 state 決定各區塊顯示與否（錯因只在「錯」時、部分給分只在已批改的計算／證明題）。
 *
 * @param {object} app
 * @param {object} q     GET /api/papers/:id 的一題
 * @param {object} state { result, score, error_types, response, note }
 * @param {{allTypes:Array<object>, maxTypes:number}} opts
 * @returns {{ node:HTMLElement, paint:() => void, onChange:() => void }}
 */
function gradingDetail(app, q, state, { allTypes, maxTypes }) {
    const ui = { node: el('div', ''), paint: () => { }, onChange: () => { } };
    const changed = () => ui.onChange();

    // ── 錯因 chip（按「錯」才出現）──
    const chipsBox = el('div', 'mt-2 hidden', {
        role: 'group', 'aria-label': `第 ${q.question_id} 題的錯因`, 'data-error-chips': String(q.question_id)
    });
    chipsBox.appendChild(el('p', 'mb-1 text-[11px] font-bold text-rose-500', {
        textContent: `錯因（可複選，最多 ${maxTypes} 個）`
    }));
    const chipRow = el('div', 'flex flex-wrap gap-1.5');
    chipsBox.appendChild(chipRow);
    const applicable = applicableErrorTypes(allTypes, q.subject);
    // 已存的代碼若不在這一科的清單內（舊資料），也畫出來讓老師能取消
    const extra = state.error_types.filter(c => !applicable.some(t => t.code === c)).map(c => ({ code: c, label: c }));
    const chipTypes = [...applicable, ...extra];
    const order = chipTypes.map(t => t.code);
    const chips = [];
    if (allTypes.length === 0) {
        chipRow.appendChild(el('span', 'text-[11px] text-slate-400', {
            textContent: '錯因清單載入失敗（GET /api/error-types），這次只能記對錯。'
        }));
    }
    for (const t of chipTypes) {
        const chip = el('button', '', {
            type: 'button', textContent: t.label, 'data-error-type': t.code, 'aria-pressed': 'false'
        });
        chip.addEventListener('click', () => {
            const on = state.error_types.includes(t.code);
            if (!on && state.error_types.length >= maxTypes) {
                app.showToast(`一題最多標 ${maxTypes} 個錯因。`, 'error');
                return;
            }
            const next = on ? state.error_types.filter(c => c !== t.code) : [...state.error_types, t.code];
            state.error_types = order.filter(c => next.includes(c));   // 固定照白名單順序
            changed();
        });
        chips.push(chip);
        chipRow.appendChild(chip);
    }
    ui.node.appendChild(chipsBox);

    // ── 部分給分（計算題與證明題）──
    let scoreBox = null, scoreInput = null;
    if (PARTIAL_SCORE_TYPES.includes(q.question_type)) {
        scoreBox = el('label', 'mt-2 hidden items-center gap-2 text-xs text-slate-600', { 'data-score-box': String(q.question_id) });
        scoreInput = el('input', 'field-control min-h-0 w-20 p-1.5 text-xs', {
            type: 'number', min: 0, max: 100, step: 5, placeholder: '—',
            value: percentOfScore(state.score), 'aria-label': `第 ${q.question_id} 題的部分給分（%）`
        });
        scoreInput.addEventListener('change', () => {
            const v = scoreFromPercent(scoreInput.value);
            if (v === undefined) {
                app.showToast('部分給分請填 0～100 的整數（%），或留空表示不給分。', 'error');
                scoreInput.value = percentOfScore(state.score);
                return;
            }
            state.score = v;
            changed();
        });
        scoreBox.append(
            el('span', 'font-bold', { textContent: '部分給分' }), scoreInput, el('span', '', { textContent: '%' }),
            el('span', 'text-[11px] text-slate-400', { textContent: '留空＝不給分，只看對錯' })
        );
        ui.node.appendChild(scoreBox);
    }

    // ── 學生答案與註記 ──
    const hasNotes = Boolean(state.response || state.note);
    const notesBtn = el('button', 'mt-2 mr-2 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 cursor-pointer', {
        type: 'button', textContent: '學生答案與註記', 'aria-expanded': String(hasNotes)
    });
    const notesBox = el('div', `mt-2 space-y-1.5 ${hasNotes ? '' : 'hidden'}`, { 'data-notes-box': String(q.question_id) });
    const responseIn = el('input', 'field-control block w-full min-h-0 p-2 text-xs', {
        type: 'text', maxLength: 500, value: state.response || '',
        placeholder: '學生實際寫的答案或選的選項（選填，500 字內）', 'aria-label': `第 ${q.question_id} 題的學生答案`
    });
    responseIn.addEventListener('input', () => { state.response = responseIn.value.trim() || null; });
    const noteIn = el('textarea', 'field-control block w-full min-h-0 p-2 text-xs resize-y', {
        rows: 2, maxLength: 500, value: state.note || '',
        placeholder: '老師註記（選填，500 字內）：例如「移項忘了變號」', 'aria-label': `第 ${q.question_id} 題的老師註記`
    });
    noteIn.addEventListener('input', () => { state.note = noteIn.value.trim() || null; });
    notesBox.append(responseIn, noteIn);
    notesBtn.addEventListener('click', () => {
        const open = notesBox.classList.contains('hidden');
        notesBox.classList.toggle('hidden', !open);
        notesBtn.setAttribute('aria-expanded', String(open));
    });

    // ── 標準答案與詳解 ──
    const answerBtn = el('button', 'mt-2 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-indigo-200 bg-white text-indigo-600 hover:bg-indigo-50 cursor-pointer', {
        type: 'button', textContent: '看答案與詳解', 'aria-expanded': 'false'
    });
    const answerBox = el('div', 'mt-2 hidden rounded-lg border border-indigo-100 bg-indigo-50/40 p-2.5 text-xs text-slate-700 space-y-1', {
        'data-answer-box': String(q.question_id)
    });
    const answerLine = el('p', 'font-bold text-emerald-700');
    answerLine.textContent = `標準答案：${q.answer_text ?? '（無）'}`;
    const solutionLine = el('p', 'whitespace-pre-line');
    solutionLine.textContent = q.solution_text ? `詳解：${q.solution_text}` : '這題還沒有文字詳解（可在題庫的編輯視窗補上）。';
    answerBox.append(answerLine, solutionLine);
    if (q.solution_text && SOLUTION_SRC_LABEL[q.solution_src]) {
        answerBox.appendChild(el('p', 'text-[11px] text-slate-400', { textContent: `詳解來源：${SOLUTION_SRC_LABEL[q.solution_src]}` }));
    }
    let typeset = false;
    answerBtn.addEventListener('click', () => {
        const open = answerBox.classList.contains('hidden');
        answerBox.classList.toggle('hidden', !open);
        answerBtn.setAttribute('aria-expanded', String(open));
        if (open && !typeset) { typeset = true; app.renderMath(answerBox); }
    });

    const actions = el('div', '');
    actions.append(notesBtn, answerBtn);
    ui.node.append(actions, notesBox, answerBox);

    ui.paint = () => {
        const wrong = state.result === 0;
        chipsBox.classList.toggle('hidden', !wrong);
        for (const chip of chips) {
            const on = state.error_types.includes(chip.getAttribute('data-error-type'));
            chip.className = 'text-[11px] font-bold px-2.5 py-1 rounded-full border cursor-pointer transition-colors ' +
                (on ? 'border-rose-400 bg-rose-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-rose-50');
            chip.setAttribute('aria-pressed', String(on));
        }
        if (scoreBox) {
            const graded = state.result !== null;
            scoreBox.classList.toggle('hidden', !graded);
            scoreBox.classList.toggle('flex', graded);
            if (scoreInput.value !== percentOfScore(state.score)) scoreInput.value = percentOfScore(state.score);
        }
    };
    return ui;
}

// ───────────────────────── 版面組裝 ─────────────────────────

// ───────────────────────── 學生管理（階段 4 W1-1） ─────────────────────────
//
// 三個動作：改名、把 A 併入 B（清理「小」「名」「華」這種打錯字生出來的分身）、
// 刪除（連 attempts 與考卷）。全部打核心區的學生管理 API（不吃 FEATURE_STUDENTS，
// 但面板放在學生分頁——這裡本來就是看學生的地方）。
// 刪除與合併都不可逆：不用 window.confirm（會擋住整個分頁），用「按第二次才執行」。

/** 目前選在管理面板裡的動作按鈕若處於「待確認」狀態，退回原文字。 */
function armTwice(btn, armedText, run) {
    btn.addEventListener('click', () => {
        if (btn.dataset.armed === '1') { btn.dataset.armed = ''; run(); return; }
        btn.dataset.armed = '1';
        const original = btn.textContent;
        btn.textContent = armedText;
        setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = original; } }, 4000);
    });
}

async function renderManagePanel(app, box) {
    box.textContent = '';
    const card = el('div', 'rounded-2xl border border-amber-200 bg-amber-50/50 p-4');
    card.appendChild(el('p', 'eyebrow text-amber-600', { textContent: '管理學生' }));
    card.appendChild(el('p', 'mt-1 mb-3 text-xs text-slate-500', {
        textContent: '改名、合併（把打錯字生出來的分身併回本尊；同一題兩邊都寫過時保留本尊的批改）、刪除（連作答紀錄與考卷，不可逆）。'
    }));

    let items = [];
    try {
        const res = await request(app, '/api/students');
        if (!res.ok) throw new Error(String(res.status));
        items = (await res.json()).items;
    } catch {
        card.appendChild(el('p', 'text-sm text-rose-500', { textContent: '學生清單載入失敗，請重新整理。' }));
        box.appendChild(card);
        return;
    }
    if (items.length === 0) {
        card.appendChild(el('p', 'text-sm text-slate-400', { textContent: '還沒有任何學生。到「智慧自動組卷」按「＋ 新增」建立。' }));
        box.appendChild(card);
        return;
    }

    const rowsBox = el('div', 'space-y-2');
    for (const st of items) {
        const row = el('div', 'flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5');
        row.appendChild(el('span', 'min-w-24 text-sm font-bold text-slate-700', { textContent: st.name }));
        row.appendChild(el('span', 'text-[11px] text-slate-400', { textContent: `${st.papers} 張卷` }));
        // 〔stage5 WS-A〕學生檔案摘要與編輯（第 4.1 條第 4、7 項）
        row.appendChild(el('span', 'text-[11px] text-slate-500', {
            textContent: profileSummary(st) || '（未填檔案）', 'data-profile-summary': String(st.id)
        }));

        const nameIn = el('input', 'field-control min-h-0 w-32 p-1.5 text-xs', { value: st.name, 'aria-label': `${st.name} 的新名字` });
        const renameBtn = el('button', 'text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 cursor-pointer', {
            type: 'button', textContent: '改名'
        });
        renameBtn.addEventListener('click', async () => {
            const name = nameIn.value.trim();
            if (!name || name === st.name) return;
            const res = await request(app, `/api/students/${st.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
            });
            if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
            app.showToast(`已改名為「${name}」`, 'success');
            renderManagePanel(app, box);
            loadStudentView(app).catch(() => {});
        });

        const mergeSel = el('select', 'field-control min-h-0 p-1.5 text-xs', { 'aria-label': `把 ${st.name} 併入誰` });
        mergeSel.appendChild(el('option', '', { value: '', textContent: '併入…' }));
        for (const other of items) {
            if (other.id === st.id) continue;
            mergeSel.appendChild(el('option', '', { value: String(other.id), textContent: other.name }));
        }
        const mergeBtn = el('button', 'text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-white text-indigo-600 hover:bg-indigo-50 cursor-pointer', {
            type: 'button', textContent: '合併'
        });
        armTwice(mergeBtn, '再按一次確認合併', async () => {
            const into = Number(mergeSel.value);
            if (!into) { app.showToast('先選要併入哪位學生。', 'error'); return; }
            const res = await request(app, `/api/students/${st.id}/merge`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ into_id: into })
            });
            if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
            const body = await res.json();
            app.showToast(`已合併：搬 ${body.moved_attempts} 筆作答、${body.moved_papers} 張卷，衝突 ${body.dropped_conflicts} 筆以本尊為準。`, 'success');
            renderManagePanel(app, box);
            loadStudentView(app).catch(() => {});
        });

        const delBtn = el('button', 'text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 cursor-pointer', {
            type: 'button', textContent: '刪除'
        });
        armTwice(delBtn, '再按一次＝連紀錄一起刪', async () => {
            const res = await request(app, `/api/students/${st.id}`, { method: 'DELETE' });
            if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
            const body = await res.json();
            app.showToast(`已刪除「${st.name}」（連 ${body.deleted.attempts} 筆作答、${body.deleted.papers} 張卷）。`, 'success');
            renderManagePanel(app, box);
            loadStudentView(app).catch(() => {});
        });

        // 〔stage5 WS-A〕「檔案」：展開這位學生的檔案表單（年級、類組、目標考試、學校、教材版本、備註）
        const profileBtn = el('button', 'text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 cursor-pointer', {
            type: 'button', textContent: '檔案', 'aria-expanded': 'false'
        });
        const profileBox = el('div', 'hidden rounded-xl border border-emerald-100 bg-emerald-50/40 p-3', { 'data-profile-editor': String(st.id) });
        profileBtn.addEventListener('click', async () => {
            const open = profileBox.classList.contains('hidden');
            profileBox.classList.toggle('hidden', !open);
            profileBtn.setAttribute('aria-expanded', String(open));
            if (!open || profileBox.childElementCount > 0) return;
            const options = await loadProfileOptions(app);
            if (!options) {
                profileBox.appendChild(el('p', 'text-xs text-rose-500', { textContent: '學生檔案選項載入失敗（GET /api/student-profile-options），請重新整理。' }));
                return;
            }
            profileBox.appendChild(profileEditor(app, st, options, () => renderManagePanel(app, box)));
        });

        row.append(nameIn, renameBtn, mergeSel, mergeBtn, delBtn, profileBtn);
        rowsBox.appendChild(row);
        rowsBox.appendChild(profileBox);
    }
    card.appendChild(rowsBox);
    box.appendChild(card);
}

/**
 * 〔stage5 WS-A〕學生檔案表單。選項全部來自 GET /api/student-profile-options（不在前端寫死）；
 * 儲存時只送改過的欄位（diffProfile），PATCH 沒送的欄位後端不動。
 *
 * @param {object} app
 * @param {object} st       GET /api/students 的一列
 * @param {object} options  GET /api/student-profile-options
 * @param {() => void} onSaved
 * @returns {HTMLElement}
 */
function profileEditor(app, st, options, onSaved) {
    const GRADE_LABEL = { 10: '高一', 11: '高二', 12: '高三' };
    const form = el('div', 'grid gap-2 sm:grid-cols-2');
    // 單一控制項用 <label> 包起來（點標題就能聚焦）；目標考試是一組核取方塊、各自已有 <label>，
    // 外層改用 <div>——<label> 裡不能再放 <label>。
    const field = (label, control, tag = 'label') => {
        const wrap = el(tag, 'flex flex-col gap-1 text-[11px] font-bold text-slate-600');
        wrap.append(el('span', '', { textContent: label }), control);
        return wrap;
    };
    /** 下拉：第一個選項是「未填」；目前值不在選項內（白名單改過）時也保留，避免一存就被洗掉 */
    const select = (values, current, labelOf = v => String(v)) => {
        const sel = el('select', 'field-control min-h-0 p-1.5 text-xs');
        sel.appendChild(el('option', '', { value: '', textContent: '（未填）' }));
        const all = current !== null && current !== undefined && !values.includes(current) ? [...values, current] : values;
        for (const v of all) sel.appendChild(el('option', '', { value: String(v), textContent: labelOf(v) }));
        sel.value = current === null || current === undefined ? '' : String(current);
        return sel;
    };

    const gradeSel = select(options.grades || [], st.grade ?? null, v => GRADE_LABEL[v] || String(v));
    const trackSel = select(options.tracks || [], st.track ?? null);
    const bookSel = select(options.textbook_versions || [], st.textbook_version ?? null);
    const schoolIn = el('input', 'field-control min-h-0 p-1.5 text-xs', {
        type: 'text', maxLength: options.school_max_length || 50, value: st.school || '', placeholder: '學校（選填）'
    });
    const noteIn = el('textarea', 'field-control min-h-0 p-1.5 text-xs resize-y', {
        rows: 2, maxLength: options.note_max_length || 500, value: st.note || '', placeholder: '備註（選填）：例如「數A、週三上課」'
    });
    const examsBox = el('div', 'flex flex-wrap gap-2 font-normal', { role: 'group', 'aria-label': `${st.name} 的目標考試` });
    const examBoxes = [];
    const currentExams = Array.isArray(st.target_exams) ? st.target_exams : [];
    const examValues = [...(options.target_exams || [])];
    for (const v of currentExams) if (!examValues.includes(v)) examValues.push(v);
    for (const v of examValues) {
        const lab = el('label', 'inline-flex items-center gap-1 text-xs text-slate-700');
        const cb = el('input', 'accent-emerald-600', { type: 'checkbox', checked: currentExams.includes(v), 'data-exam': v });
        examBoxes.push(cb);
        lab.append(cb, el('span', '', { textContent: v }));
        examsBox.appendChild(lab);
    }

    form.append(
        field('年級', gradeSel), field('類組', trackSel),
        field('教材版本', bookSel), field('學校', schoolIn)
    );
    const examsField = field('目標考試（可複選）', examsBox, 'div');
    const noteField = field('備註', noteIn);
    const save = el('button', 'mt-2 text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer', {
        type: 'button', textContent: '儲存檔案'
    });
    save.addEventListener('click', async () => {
        const edited = {
            grade: gradeSel.value === '' ? null : Number(gradeSel.value),
            track: trackSel.value || null,
            target_exams: examBoxes.filter(cb => cb.checked).map(cb => cb.getAttribute('data-exam')),
            school: schoolIn.value.trim() || null,
            textbook_version: bookSel.value || null,
            note: noteIn.value.trim() || null
        };
        const changes = diffProfile(st, edited);
        if (Object.keys(changes).length === 0) { app.showToast('沒有任何改動。', 'info'); return; }
        save.disabled = true;
        try {
            const res = await request(app, `/api/students/${st.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes)
            });
            if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
            app.showToast(`已更新「${st.name}」的檔案。`, 'success');
            onSaved();
        } catch {
            app.showToast('連線失敗，請稍後再試', 'error');
        } finally {
            save.disabled = false;
        }
    });

    const wrap = el('div', '');
    wrap.append(form, examsField, noteField, save);
    return wrap;
}

/**
 * 〔stage5 WS-B〕弱點面板的科目選項（docs/interfaces-stage5.md 第 1.5 條：科目清單不得寫死）。
 * 先用 index.html 已載好的白名單（ExamApp.getChapterWhitelist），還沒載好就自己打 GET /api/chapter-whitelist。
 * 失敗時只剩「不分科」——弱點面板照樣能用，只是不能篩科。
 * @param {object} app
 * @param {HTMLSelectElement} sel
 */
async function fillSubjectOptions(app, sel) {
    let subjects = [];
    try {
        const cached = typeof app.getChapterWhitelist === 'function' ? (app.getChapterWhitelist() || {}) : {};
        if (Object.keys(cached).length) subjects = Object.keys(cached);
        else {
            const res = await app.apiFetch('/api/chapter-whitelist');
            if (res.ok) subjects = Object.keys(await res.json());
        }
    } catch (err) {
        console.warn('[students] 載入科目清單失敗，只保留「不分科」', err);
    }
    for (const s of subjects) sel.appendChild(el('option', '', { value: s, textContent: s }));
}

/**
 * 建立 <section id="students"> 裡的骨架（index.html 只放一個空的錨點）。
 * @param {object} app
 * @param {HTMLElement} section
 */
function mountStudentsSection(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-5');
    const title = el('div', 'flex items-start gap-3');
    const titleBox = el('div');
    titleBox.append(
        el('p', 'eyebrow text-emerald-600', { textContent: 'Students' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '學生與弱點面板' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '出卷 →（一週後）批改 → 看弱點 → 錯題找相似／出變式。批改入口就在試卷列表。'
        })
    );
    title.append(el('span', 'section-icon bg-emerald-50 text-emerald-700', { textContent: '生' }), titleBox);

    const controls = el('div', 'flex flex-wrap items-center gap-2');
    const studentSel = el('select', 'field-control min-h-0 p-2.5 text-sm', { id: 'stuStudent', 'aria-label': '選擇學生' });
    const subjectSel = el('select', 'field-control min-h-0 p-2.5 text-sm', { id: 'stuSubject', 'aria-label': '篩選學科' });
    subjectSel.append(el('option', '', { value: '', textContent: '不分科' }));
    fillSubjectOptions(app, subjectSel);   // 〔stage5 WS-B〕科目選項讀 API，不寫死（化學併入）
    const daysSel = el('select', 'field-control min-h-0 p-2.5 text-sm', { id: 'stuDays', 'aria-label': '統計天數' });
    for (const d of DAYS_OPTIONS) {
        const o = el('option', '', { value: String(d), textContent: `近 ${d} 天` });
        if (d === DEFAULT_DAYS) o.selected = true;
        daysSel.appendChild(o);
    }
    const refresh = el('button', 'text-sm px-4 py-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 cursor-pointer', {
        type: 'button', id: 'stuRefresh', textContent: '重新整理'
    });
    const manageBtn = el('button', 'text-sm px-4 py-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-600 transition-colors hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700 cursor-pointer', {
        type: 'button', id: 'stuManageBtn', textContent: '⚙ 管理學生'
    });
    controls.append(studentSel, subjectSel, daysSel, refresh, manageBtn);
    head.append(title, controls);

    const manageBox = el('div', 'hidden mb-4', { id: 'stuManage' });

    const status = el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500', {
        id: 'stuStatus', textContent: '載入中…'
    });
    const papersBox = el('div', 'mt-4', { id: 'stuPapers' });
    const weaknessBox = el('div', 'mt-6', { id: 'stuWeakness' });

    section.append(head, manageBox, status, papersBox, weaknessBox);

    manageBtn.addEventListener('click', () => {
        const willOpen = manageBox.classList.contains('hidden');
        manageBox.classList.toggle('hidden', !willOpen);
        if (willOpen) renderManagePanel(app, manageBox);
    });

    const reload = () => loadStudentView(app).catch(err => console.error('[students] 載入失敗', err));
    studentSel.addEventListener('change', reload);
    subjectSel.addEventListener('change', reload);
    daysSel.addEventListener('change', reload);
    refresh.addEventListener('click', reload);
}

/** @returns {number|null} 目前選到的學生 id */
function currentStudentId() {
    const sel = document.getElementById('stuStudent');
    const v = sel && sel.value ? Number(sel.value) : NaN;
    return Number.isInteger(v) ? v : null;
}

/**
 * 載入學生清單（只在初次與明確要求時做——這一支不分科、不看 days）。
 * @param {object} app
 * @returns {Promise<boolean>} 是否成功
 */
async function loadStudents(app) {
    const sel = document.getElementById('stuStudent');
    const status = document.getElementById('stuStatus');
    if (!sel) return false;
    let res;
    try {
        res = await request(app, '/api/students');
    } catch {
        if (status) status.textContent = '連線失敗，請稍後再試。';
        return false;
    }
    if (!res.ok) {
        if (status) {
            // 404 代表 WS-A 的五支 API 還沒合入，不是前端壞掉——講清楚（review.js 的教訓）。
            status.textContent = res.status === 404
                ? '學生 API 尚未上線（GET /api/students 回 404）。可加上 ?mock=1 用手寫假資料預覽版面。'
                : await messageOf(res);
        }
        return false;
    }
    const items = (await res.json()).items || [];
    const keep = sel.value;
    sel.innerHTML = '';
    if (items.length === 0) {
        sel.appendChild(el('option', '', { value: '', textContent: '（還沒有任何學生）' }));
        if (status) status.textContent = '題庫裡還沒有學生。先用「智慧組卷」出一張卷，學生就會出現在這裡。';
        return false;
    }
    for (const s of items) {
        sel.appendChild(el('option', '', {
            value: String(s.id),
            // 姓名另外存一份在 data-name：選項文字後面接了統計數字，
            // 而學生姓名本身就可能含有全形括號——從顯示文字反推姓名遲早會錯。
            'data-name': s.name,
            textContent: `${s.name}（${s.papers} 卷，已批 ${formatPercent(s.graded_ratio)}）`
        }));
    }
    if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
    return true;
}

/**
 * 依目前的下拉載入試卷列表與弱點面板。
 * @param {object} app
 */
async function loadStudentView(app) {
    const status = document.getElementById('stuStatus');
    const papersBox = document.getElementById('stuPapers');
    const weaknessBox = document.getElementById('stuWeakness');
    const studentId = currentStudentId();
    if (!papersBox || !weaknessBox) return;
    papersBox.innerHTML = '';
    weaknessBox.innerHTML = '';
    // 〔retrain PR-4〕錯題重練卡跟著這裡選的學生走；順便更新學生清單的到期徽章（旗標關閉時不發事件、不打 API）
    if (retrainEnabled()) announceStudentView(app, studentId);
    if (studentId === null) return;
    if (status) { status.classList.remove('hidden'); status.textContent = '載入中…'; }

    const subject = (document.getElementById('stuSubject') || {}).value || '';
    const days = (document.getElementById('stuDays') || {}).value || String(DEFAULT_DAYS);
    const params = new URLSearchParams({ days });
    if (subject) params.set('subject', subject);

    let papersRes, weaknessRes;
    try {
        [papersRes, weaknessRes] = await Promise.all([
            request(app, `/api/students/${studentId}/papers`),
            request(app, `/api/students/${studentId}/weakness?${params.toString()}`)
        ]);
    } catch {
        if (status) status.textContent = '連線失敗，請稍後再試。';
        return;
    }
    if (!papersRes.ok) { if (status) status.textContent = await messageOf(papersRes); return; }
    if (!weaknessRes.ok) { if (status) status.textContent = await messageOf(weaknessRes); return; }
    if (status) status.classList.add('hidden');

    // ── 試卷列表 ──
    const papers = (await papersRes.json()).items || [];
    papersBox.appendChild(el('p', 'eyebrow mb-2 text-emerald-500', { textContent: '試卷（最近出的在最上面）' }));
    if (papers.length === 0) {
        papersBox.appendChild(el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500', {
            textContent: '這位學生還沒有任何試卷。'
        }));
    } else {
        const list = el('div', 'space-y-2', { id: 'stuPaperList' });
        const onGraded = () => loadStudentView(app).catch(() => {});
        for (const p of papers) list.appendChild(paperCard(app, p, onGraded));
        papersBox.appendChild(list);
    }

    // ── 弱點面板 ──
    const weakness = await weaknessRes.json();
    const grid = el('div', 'grid gap-4 lg:grid-cols-3');
    for (const spec of TABLE_SPECS) grid.appendChild(weaknessTable(app, spec, weakness[spec.key]));
    weaknessBox.append(el('p', 'eyebrow mb-2 text-rose-400', { textContent: '弱點（錯誤率由高到低）' }), grid);
    // 〔stage5 WS-A〕錯因分布（第 4.1 條第 3、7 項）。舊後端沒有這個鍵時不畫，不假裝是空的。
    if (Array.isArray(weakness.by_error_type)) weaknessBox.appendChild(errorTypeTable(weakness.by_error_type));

    const trendBox = el('div', 'mt-4 rounded-2xl border border-slate-200 bg-white p-4');
    trendBox.append(
        el('p', 'eyebrow text-slate-400', { textContent: '每週趨勢' }),
        el('p', 'mt-1 mb-2 text-xs text-slate-400', {
            textContent: '長條＝該週批改題數，紅線＝該週錯誤率；虛線段代表中間有沒有資料的週（不補零）。'
        }),
        trendSvg(weakness.trend_weekly)
    );
    weaknessBox.appendChild(trendBox);

    // 〔stage5 WS-A〕最近錯題的錯因要顯示中文標籤：白名單（有快取）優先，其次用 by_error_type 帶的標籤
    const labelOf = errorLabeler(await loadErrorTypes(app), weakness.by_error_type);
    weaknessBox.appendChild(el('div', 'mt-4', {})).appendChild(
        recentWrongList(app, weakness.recent_wrong, currentStudentId, labelOf)
    );

    // 深連結：組卷後按「立即批改」進來時，把那一張卷直接展開。
    if (pendingPaperId !== null) {
        const target = pendingPaperId;
        pendingPaperId = null;
        openPaper(target);
    }
}

/**
 * 展開指定的試卷卡片並捲到它。
 * @param {number} paperId
 * @returns {boolean} 有沒有找到那張卡片
 */
function openPaper(paperId) {
    const card = document.querySelector(`#stuPaperList [data-paper-id="${paperId}"]`);
    if (!card || typeof card.__open !== 'function') return false;
    card.__open();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
}

/**
 * 處理組卷結果區的「立即批改」。
 *
 * 事件本身不帶資料——`paper_id` 與 `student_name` 一律從 `ExamApp.getPaperCache()` 讀
 * （第 7.1 條的 getter 存在的理由：`currentPaperCache` 是會被重新賦值的 let，
 *  掛值只會掛到組卷之前那個 null 的快照）。
 * @param {object} app
 */
async function handleGradeRequest(app) {
    const cache = typeof app.getPaperCache === 'function' ? app.getPaperCache() : null;
    if (!cache || !cache.paper_id) {
        app.showToast('這張卷還沒有 paper_id，請重新組卷一次。', 'error');
        return;
    }
    if (typeof app.showSection === 'function') app.showSection('students');

    const sel = document.getElementById('stuStudent');
    if (!sel) return;
    // 用 data-name 比對，不從顯示文字反推（姓名本身可能含全形括號）。
    const match = [...sel.options].find(o => o.dataset.name === cache.student_name);
    if (match && sel.value !== match.value) {
        sel.value = match.value;
        pendingPaperId = cache.paper_id;
        await loadStudentView(app);
        return;
    }
    if (!openPaper(cache.paper_id)) {
        // 卡片還沒渲染出來（例如剛切完學生）：重載一次，載完之後自動展開。
        pendingPaperId = cache.paper_id;
        await loadStudentView(app);
    }
}

// ───────────────────────── 進入點 ─────────────────────────

/**
 * 掛載。旗標關閉時**整段不渲染**（第 7.2 條），連空殼都不掛。
 */
export async function init() {
    const section = document.getElementById('students');
    if (!section) return;
    if (!studentsEnabled()) {
        console.info('[students] FEATURE_STUDENTS 未開啟：學生分頁不渲染（interfaces-stage3.md 第 7.2 條）。');
        return;
    }
    const app = bridge();
    if (!app) return;

    mountStudentsSection(app, section);
    document.addEventListener(GRADE_EVENT, () => { handleGradeRequest(app).catch(() => {}); });
    // 〔retrain PR-4〕錯題重練卡改了清單 → 更新到期徽章；出了重練卷 → 連試卷列表一起重載（新卷要能在這裡批改）
    if (retrainEnabled()) {
        document.addEventListener(RETRAIN_CHANGED_EVENT, (event) => {
            const detail = (event && event.detail) || {};
            if (detail.papers_changed && detail.student_id === currentStudentId()) loadStudentView(app).catch(() => {});
            else refreshRetrainBadges(app).catch(() => {});
        });
    }
    loadErrorTypes(app);   // 〔stage5 WS-A〕先暖快取：展開試卷時錯因 chip 不必再等一次來回

    if (await loadStudents(app)) await loadStudentView(app);
}

// 自動掛載只在瀏覽器裡發生。
// 這個 typeof 檢查不是防禦性程式碼：test/unit/studentsUi.test.js 會 import() 本檔來測
// 純函式，Node 裡沒有 document，少了這一層整個測試檔會在 import 當下就爆掉。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error('[students] 掛載失敗', err)); });
    } else {
        init().catch(err => console.error('[students] 掛載失敗', err));
    }
}
