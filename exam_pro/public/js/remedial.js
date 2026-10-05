// ─────────────────────────────────────────────────────────────
// public/js/remedial.js — 依弱點出補救卷與題庫覆蓋率（階段 5，擁有者：WS-D；docs/interfaces-stage5.md 第 4.4 條第 5 項）
//
// 兩個錨點（index.html 已預留，本檔不動 index.html）：
//
//   #remedial（學生視圖）  選學生、科目、題數、配比 → POST /api/students/:id/remedial-paper 產草稿
//                          → 依 bucket（補救／先備／延伸／手動加入）分組列出理由與不足量
//                          → 可刪題、可用題目 ID 加題 → 確認呼叫既有的 POST /api/confirm-paper
//                          → 提供既有的 Word 下載（POST /api/download-word）。
//                          承上題（follows_question_id）一律整組處理：草稿標「承上 #x」、刪除鈕變「刪這組」且整組刪；
//                          手動加題先查 GET /api/students/:id/remedial-paper/items，連同前題／承上題整組加入，
//                          組內有封存或已寫過的題就不加。confirm-paper 伺服器端也會整組檢查（〔Owner 決策單 2026-09-25 B7〕），這一端先擋、訊息貼近草稿操作。
//                          另列「知識點掌握度」（GET /api/students/:id/weakness/kc），讓老師看得到草稿為什麼這樣選。
//   #coverage（題庫視圖）  GET /api/coverage：章 × 難度的熱度表；選了學生改看「還沒寫過」的題數；
//                          另列每個知識點掛了幾題。
//
// 〔retrain PR-3〕FEATURE_RETRAIN 開啟時，配比下方多「☐ 附上到期重練 [N] 題」，草稿多一組「到期重練」
// （POST remedial-paper 的 retrain_count；確認時帶 retrain_question_ids、下載 Word 時帶 paper_id）。細節見下方〔retrain PR-3〕那一段。
//
// 〔dec/r16-remedial〕兩件事（docs/remedial.md 第 9、10 節）：
//   - 依錯因出題：草稿補救組每個目標下多一行「錯因：…」（blueprint 的 error_focus：主因、怎麼調、為什麼）。
//   - 補救成效：草稿回應的 targets（目標快照）在確認時原樣帶給 confirm-paper（kind: 'remedial'）；
//     區塊最下方「補救成效」列出這位學生的補救卷，每個補救目標「補救前 → 之後」的答對率與狀態
//     （GET /api/students/:id/remedial-effect；選學生、確認出卷後重讀）。
//   - 題庫不夠時自動補題（第 11 節；另需 FEATURE_VARIANTS）：補救目標「庫存不足」那一行多一顆「生成變式補題」，
//     POST /api/students/:id/remedial-paper/fill-shortfall 以該生的錯題出變式；草稿下方列出排了哪些生成工作，
//     「重新整理進度」讀既有的 GET /api/jobs/:id。生成好的題在「待複核」，核准後重新產生草稿才抽得到。
//
// 跨 module 的唯一通道：監聽 document 上的 `remedial:add`（detail.question_id），把題目加進目前的草稿。
// 發送端是「找相似」結果每列的「加入補救卷」按鈕（〔stage5 WS-D〕掛鉤，見 docs/remedial.md）。
//
// 慣例沿用階段 3／4 的 module：
//   - FEATURE_REMEDIAL 關閉時**整段不渲染**（不是隱藏）；旗標從 <meta name="feature-remedial"> 讀，
//     parseBool 與後端 config/features.js 逐字相同。`?remedial=1` 是本機驗收用的手動開關。
//   - 透過 window.ExamApp 橋接 apiFetch／showToast／renderMath；缺橋接就停手並印一行錯誤。
//   - 伺服器回來的文字一律 textContent。科目清單讀 GET /api/chapter-whitelist，不寫死。
// ─────────────────────────────────────────────────────────────

/** 跨 module 事件名（契約第 4.4 條第 5 項凍結）。 */
export const REMEDIAL_ADD_EVENT = 'remedial:add';

// 〔retrain PR-3〕'retrain'（到期重練）：FEATURE_RETRAIN 開啟、而且產生草稿時附了到期重練題才會出現這一組
export const BUCKET_ORDER = ['remedial', 'prerequisite', 'extension', 'retrain', 'manual'];
export const BUCKET_LABEL = { remedial: '補救', prerequisite: '先備', extension: '延伸', retrain: '到期重練', manual: '手動加入' };
const BUCKET_HINT = {
    remedial: '最弱的單位，選不超過他答錯題難度＋1 的題',
    prerequisite: '弱知識點的先備知識點，選基礎題',
    extension: '已相對掌握的單位，選難一點的題',
    retrain: '錯題重練清單裡到期的原題，依逾期天數排序、承上題整組出；學生的卷面不會標出來',
    manual: '老師自己加的題；承上題會連同前題整組加入，已封存或他寫過的題不會加入'
};
const SHORTFALL_REASON = { insufficient_stock: '庫存不足', follow_up_group: '承上題須整組出題', not_enough_due: '到期的題不夠' };

// ───────────────────────── 〔retrain PR-3〕附上到期的重練題（docs/retrain-and-review.md 第 5.2 節 API-8、第 5.3 節）─────────────────────────
//
// FEATURE_RETRAIN 開啟時，配比下方多一列「☐ 附上到期重練 [N] 題（目前到期 M 題）」（〔Owner 決策單 2026-09-26 R6 選 1〕）：
// 預設不勾；N 預設 capForAttach(題數)＝題數 × RETRAIN_ATTACH_RATIO（<meta name="retrain-attach-ratio">，預設三成）無條件捨去，
// 而且不超過 20（API-8 的上限）、題數＋N ≤ 50。勾了才在 remedial-paper 的 body 帶 retrain_count，草稿多一組「到期重練」；
// 確認時把這組的題號放進 confirm-paper 的 retrain_question_ids；下載 Word 時帶 paper_id（標準版答案區與詳解版標「（重練）」，R7）。
// 旗標關閉時這一列不渲染、送出的請求與 PR-3 之前逐字相同。

/** API-8 retrain_count 的上限（與伺服器 utils/retrainValidation.js 相同）。 */
export const MAX_RETRAIN_COUNT = 20;
/** 沒注入比例或不合法時的預設（config/retrain.js 的 DEFAULT_ATTACH_RATIO）。 */
export const DEFAULT_ATTACH_RATIO = 0.3;

/**
 * <meta name="retrain-attach-ratio"> 的內容 → 比例；不合法（含沒被替換的佔位字串）回預設 0.3（純函式）。
 * @param {any} raw
 * @returns {number}
 */
export function parseAttachRatio(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    return /^\d+(\.\d+)?$/.test(s) && n <= 2 ? n : DEFAULT_ATTACH_RATIO;
}

/**
 * 補救卷「到期重練」的題數預設（純函式）：與 services/retrainSchedule.js 的 capForAttach 同一條規則
 * （floor(題數 × 比例)、題數＋重練 ≤ 50），再夾在 API-8 的上限 20 以內。
 * @param {number} total
 * @param {number} ratio
 * @returns {number}
 */
export function retrainDefaultCount(total, ratio) {
    const n = Number.isInteger(total) && total > 0 ? total : 0;
    return Math.max(0, Math.min(Math.floor(n * ratio + 1e-9), MAX_PAPER - n, MAX_RETRAIN_COUNT));
}

/**
 * 確認出卷要多帶的鍵（純函式）：草稿裡有「到期重練」組的題才帶 retrain_question_ids（依草稿順序）。
 * @param {object|null} draft
 * @returns {{retrain_question_ids?:number[]}}
 */
export function retrainConfirmKeys(draft) {
    const ids = (draft?.items || []).filter(i => i.bucket === 'retrain').map(i => i.question_id);
    return ids.length ? { retrain_question_ids: ids } : {};
}

/** @returns {boolean} FEATURE_RETRAIN 是否開啟（與 feature-remedial 同一種讀法） */
function retrainEnabled() {
    const meta = document.querySelector('meta[name="feature-retrain"]');
    return parseBool(meta ? meta.content : '');
}

/** @returns {boolean} 〔dec/r16-remedial〕FEATURE_VARIANTS 是否開啟（「生成變式補題」要它） */
function variantsEnabled() {
    const meta = document.querySelector('meta[name="feature-variants"]');
    return parseBool(meta ? meta.content : '');
}

function retrainRatio() {
    const meta = document.querySelector('meta[name="retrain-attach-ratio"]');
    return parseAttachRatio(meta ? meta.content : '');
}

export const DAYS_OPTIONS = [30, 90, 180, 365];
export const DEFAULT_DAYS = 90;              // 與伺服器端預設相同（契約第 4.4 條第 2 項）
export const DEFAULT_TOTAL = 20;
export const MIN_TOTAL = 5;
export const MAX_TOTAL = 50;
export const MAX_PAPER = 50;                 // confirm-paper 的 question_ids 上限
const PG_INT_MAX = 2147483647;               // 題目 id 是 PostgreSQL int4，超過的一定不是合法 id
export const DEFAULT_MIX_PERCENT = { remedial: 60, prerequisite: 20, extension: 20 };
/**
 * 題源限制（著作權；0006）。〔stage5 審查修正〕與組卷頁 index.html 的 #paper_source_scope／SOURCE_SCOPE_MAP 同一組
 * 值（test/unit/remedialUi.test.js 逐字比對兩邊，不會走鐘）。補救卷正是要印給學生的卷，不能只有組卷頁有這個選項。
 * [值, 標籤, 送出的 source_types（null＝不帶＝不過濾）]
 */
export const SOURCE_SCOPES = [
    ['all', '全部來源', null],
    ['clean', '僅乾淨題源（官方／學校／自寫）', ['official', 'school', 'self']],
    ['no_publisher', '排除出版社（未標記仍可用）', ['official', 'school', 'self', 'unknown']]
];

/**
 * 產生草稿的 POST body（純函式）。題源選「全部」時不帶 source_types（伺服器不過濾）。
 * @param {{subject:string, total:number, mix:object, days:number, scope?:string}} p
 * @returns {object}
 */
export function remedialRequestBody({ subject, total, mix, days, scope, retrainCount }) {
    const body = { subject, total, mix, days };
    const row = SOURCE_SCOPES.find(r => r[0] === scope);
    if (row && row[2]) body.source_types = row[2];
    // 〔retrain PR-3〕勾了「附上到期重練」而且題數 > 0 才帶（沒帶＝回應與 PR-3 之前逐字相同）
    if (Number.isInteger(retrainCount) && retrainCount > 0) body.retrain_count = retrainCount;
    return body;
}
const KC_TABLE_LIMIT = 10;                   // 「知識點掌握度」只列最弱的 10 個

/** 模組層狀態：目前的草稿與上一次確認的卷（重整就歸零）。 */
const state = { draft: null, lastPaper: null, fill: null };

// ───────────────────────── 橋接與旗標 ─────────────────────────

/**
 * 與後端 config/features.js 的 parseBool 逐字相同：只有 '1' 與 'true' 為真。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** @returns {boolean} FEATURE_REMEDIAL 是否開啟 */
function remedialEnabled() {
    const meta = document.querySelector('meta[name="feature-remedial"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('remedial') === '1';
}

function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[remedial] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來（interfaces-stage3.md 第 7.1 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[remedial] window.ExamApp 缺少：${missing.join('、')}。補救卷與覆蓋率不會掛載。`);
        return null;
    }
    return app;
}

/** 建元素（與 students.js 的 el 同款：含 '-' 的鍵走 setAttribute，其餘直接設屬性）。 */
function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(props || {})) {
        if (k.includes('-') || k === 'role') node.setAttribute(k, String(v));
        else node[k] = v;
    }
    return node;
}

/** 讀 `{ message }`；讀不到就回狀態碼。 */
async function messageOf(res) {
    try {
        const body = await res.json();
        return body && body.message ? body.message : `HTTP ${res.status}`;
    } catch {
        return `HTTP ${res.status}`;
    }
}

async function getJson(app, url) {
    const res = await app.apiFetch(url);
    if (!res.ok) throw new Error(await messageOf(res));
    return res.json();
}

async function postJson(app, url, body) {
    return app.apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * 三個百分比欄位 → 送給伺服器的 mix。每個都要是非負數、總和 > 0，否則回 null。
 * （伺服器只看比例，所以直接送百分比數字即可。）
 * @param {{remedial:any, prerequisite:any, extension:any}} raw
 * @returns {{remedial:number, prerequisite:number, extension:number}|null}
 */
export function mixFromPercent(raw) {
    const out = {};
    for (const k of ['remedial', 'prerequisite', 'extension']) {
        const s = String(raw?.[k] ?? '').trim();
        if (s === '') return null;
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0) return null;
        out[k] = n;
    }
    // 總和也要有限（伺服器同一條規則：1e308 + 1e308 會溢位成 Infinity）
    const sum = out.remedial + out.prerequisite + out.extension;
    return Number.isFinite(sum) && sum > 0 ? out : null;
}

/**
 * 題數欄位 → 5–50 的整數；不合法回 null。
 * @param {any} raw
 * @returns {number|null}
 */
export function parseTotal(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (s === '' || !Number.isInteger(n) || n < MIN_TOTAL || n > MAX_TOTAL) return null;
    return n;
}

/**
 * 「用題目 ID 加題」的輸入：逗號、空白、頓號分隔的正整數；重複去掉。
 * @param {string} text
 * @returns {{ids:number[], invalid:string[]}}
 */
export function parseQuestionIds(text) {
    const ids = [];
    const invalid = [];
    for (const token of String(text ?? '').split(/[\s,，、]+/).filter(Boolean)) {
        const t = token.replace(/^#/, '');
        const n = Number(t);
        if (/^\d+$/.test(t) && Number.isInteger(n) && n >= 1 && n <= PG_INT_MAX) {
            if (!ids.includes(n)) ids.push(n);
        } else {
            invalid.push(token);
        }
    }
    return { ids, invalid };
}

/**
 * 空草稿（還沒產生、只打算手動加題時用）。
 * @returns {object}
 */
export function emptyDraft(studentId, studentName, subject) {
    return { student_id: studentId, student_name: studentName, subject, basis: null, items: [], blueprint: [], shortfalls: [], notes: [], targets: [] };
}

/**
 * 伺服器回的草稿 → 前端草稿（多記學生姓名，Word 下載要用）。
 * @param {object} body POST /api/students/:id/remedial-paper 的回應
 * @param {string} studentName
 * @returns {object}
 */
export function draftFromResponse(body, studentName) {
    return {
        student_id: body.student_id,
        student_name: studentName,
        subject: body.subject,
        basis: body.basis,
        items: Array.isArray(body.items) ? body.items.map(i => ({ ...i })) : [],
        blueprint: Array.isArray(body.blueprint) ? body.blueprint : [],
        shortfalls: Array.isArray(body.shortfalls) ? body.shortfalls : [],
        notes: Array.isArray(body.notes) ? body.notes : [],
        // 〔dec/r16-remedial〕目標快照：確認時原樣交給 confirm-paper（remedialConfirmKeys）
        targets: Array.isArray(body.targets) ? body.targets : []
    };
}

// ───────────────────────── 〔dec/r16-remedial〕依錯因出題、補救成效（純函式）─────────────────────────

/**
 * 確認出卷要多帶的鍵（純函式）：草稿有目標快照（伺服器產的草稿）才帶 kind: 'remedial' 與 targets；
 * 只靠「找相似」手動湊的空草稿沒有快照，照一般卷確認（不追蹤成效）。
 * @param {object|null} draft
 * @returns {{kind?:string, targets?:object[]}}
 */
export function remedialConfirmKeys(draft) {
    const targets = Array.isArray(draft?.targets) ? draft.targets : [];
    return targets.length ? { kind: 'remedial', targets } : {};
}

const ERROR_FOCUS_REASON = {
    insufficient_evidence: '有標錯因的錯題還太少',
    no_dominant: '錯因分散',
    tie: '兩種錯因一樣多',
    not_applicable: '這一科不適用'
};

/**
 * blueprint 的 error_focus → 草稿上的一行（純函式）。沒有任何錯因標記（null）回 null（不顯示）。
 * @param {object|null|undefined} f
 * @returns {string|null}
 */
export function errorFocusText(f) {
    if (!f || typeof f !== 'object') return null;
    const evidence = `有標錯因的錯題 ${f.tagged_wrong ?? '?'} 題，「${f.label ?? f.type}」${f.count} 次（${Math.round(Number(f.share) * 100)}%）`;
    if (!f.applied) {
        return `錯因：看不出主因（${ERROR_FOCUS_REASON[f.reason] || f.reason}；${evidence}），選題不依錯因調整。`;
    }
    const s = f.strategy || {};
    const fallback = f.reason === 'dominant_difficulty_fallback' ? '（降難度後題不夠，已退回原本的難度上限）' : '';
    return `錯因以「${f.label ?? f.type}」為主（${evidence}）→ ${s.summary ?? ''}${fallback}。${s.rationale ?? ''}`;
}

/** 一次最多生成幾題（與伺服器 services/remedialFillService.js 的 MAX_FILL_GENERATE 相同）。 */
export const MAX_FILL_GENERATE = 5;

/**
 * 草稿的一列 blueprint → 補題請求的一個單位（純函式）。只有補救組、而且找到的比要的少才有；
 * 知識點目標要有 kc_id（伺服器回的 blueprint 列會帶）。錯因主因有套用時一起帶，讓伺服器優先拿那種錯因的錯題當藍本。
 * @param {object} row
 * @returns {{unit_type:string, chapter:string, kc_id?:number, needed:number, error_type?:string}|null}
 */
export function fillUnitOf(row) {
    if (!row || row.bucket !== 'remedial' || !(row.got < row.wanted) || !row.target) return null;
    const isKc = row.target.type === 'kc';
    if (isKc && !Number.isInteger(row.kc_id)) return null;
    const unit = { unit_type: isKc ? 'kc' : 'chapter', chapter: row.target.chapter, needed: row.wanted - row.got };
    if (isKc) unit.kc_id = row.kc_id;
    if (row.error_focus && row.error_focus.applied && row.error_focus.type) unit.error_type = row.error_focus.type;
    return unit;
}

/**
 * 補題請求的 body（純函式）。days 用產生草稿時的時間窗（沒記到就不帶，伺服器預設 90）。
 * @param {object} draft
 * @param {object} row blueprint 的一列
 * @returns {object|null}
 */
export function fillRequestBody(draft, row) {
    const unit = fillUnitOf(row);
    if (!draft || !unit) return null;
    return { subject: draft.subject, ...(Number.isInteger(draft.days) ? { days: draft.days } : {}), units: [unit] };
}

const JOB_STATE_LABEL = { queued: '排隊中', extracting: '生成中', processing: '檢查中', done: '完成', failed: '失敗' };

/**
 * 一個補題工作的一行（純函式）。status＝GET /api/jobs/:id 的回應（還沒讀過就是 null）。
 * @param {{job_id:number, state:string, existing?:boolean, source_question_id:number, chapter?:string}} job
 * @param {object|null} status
 * @returns {string}
 */
export function fillJobLine(job, status) {
    const state = status?.state ?? job.state;
    const head = `任務 #${job.job_id}（${job.chapter ? `${job.chapter}，` : ''}藍本：錯題 #${job.source_question_id}${job.existing ? '，已在進行中' : ''}）：${JOB_STATE_LABEL[state] || state}`;
    const c = status?.counts;
    if (!c) return head;
    return `${head}　·　待複核 ${c.needs_review} 題、已入庫 ${c.saved}、不採用 ${c.rejected}、處理中 ${c.pending}`;
}

/** 補救成效的狀態標籤與顏色。 */
export const EFFECT_STATUS = {
    improved: ['進步', 'border-emerald-200 bg-emerald-50 text-emerald-700'],
    no_change: ['持平', 'border-slate-200 bg-slate-50 text-slate-600'],
    worse: ['退步', 'border-rose-200 bg-rose-50 text-rose-700'],
    insufficient_data: ['資料不足', 'border-amber-200 bg-amber-50 text-amber-800'],
    pending: ['還沒批改完', 'border-indigo-200 bg-indigo-50 text-indigo-700']
};

/**
 * 比例 → 「67%」；null → 「—」（純函式）。
 * @param {number|null|undefined} r
 * @returns {string}
 */
export function pctText(r) {
    if (r === null || r === undefined || !Number.isFinite(Number(r))) return '—';
    return `${Math.round(Number(r) * 100)}%`;
}

/**
 * 一個目標「補救前 → 這張卷 → 之後」的一行（純函式）。
 * @param {object} t GET /api/students/:id/remedial-effect 的 papers[].targets[]
 * @returns {string}
 */
export function effectLine(t) {
    const fmt = n => (Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(1));
    const before = `補救前 ${pctText(t.before?.correct_rate)}（批改 ${fmt(t.before?.graded ?? 0)} 題）`;
    const onPaper = `這張卷 ${pctText(t.on_paper?.rate)}（${fmt(t.on_paper?.graded ?? 0)}/${fmt(t.on_paper?.assigned ?? 0)} 題已批改）`;
    const after = `之後 ${pctText(t.after?.rate)}（批改 ${fmt(t.after?.graded ?? 0)} 題）`;
    const delta = t.delta === null || t.delta === undefined ? '' : `，變化 ${t.delta > 0 ? '+' : ''}${Math.round(t.delta * 100)} 個百分點`;
    return `${before} → ${onPaper} → ${after}${delta}`;
}

/**
 * 加題前的同步檢查（純函式；不必問伺服器就知道不能加的情況）。
 * @param {object|null} draft
 * @param {{question_id:number, student_id?:number|null, subject?:string|null}} detail
 * @returns {null|'no_draft'|'bad_id'|'other_student'|'other_subject'|'duplicate'}
 */
export function precheckAdd(draft, detail) {
    if (!draft) return 'no_draft';
    const id = detail?.question_id;
    if (!Number.isInteger(id) || id < 1) return 'bad_id';
    if (detail.student_id !== undefined && detail.student_id !== null && detail.student_id !== draft.student_id) {
        return 'other_student';
    }
    // 補救卷限單科（契約：候選一律排除不同科）；confirm-paper 不驗科目，所以在這裡擋
    if (detail.subject !== undefined && detail.subject !== null && detail.subject !== '' && detail.subject !== draft.subject) {
        return 'other_subject';
    }
    if (draft.items.some(i => i.question_id === id)) return 'duplicate';
    return null;
}

/**
 * 把一題加進草稿（純函式，回新的草稿）。承上組的整組規則由 planManualAdd 負責，本函式只加一題。
 * @param {object|null} draft
 * @param {{question_id:number, student_id?:number|null, subject?:string|null, chapter?:string|null, difficulty?:number|null,
 *          question_text?:string, question_text_preview?:string, follows_question_id?:number|null, group_ids?:number[]}} detail
 * @returns {{draft:object}|{error:'no_draft'|'bad_id'|'other_student'|'other_subject'|'duplicate'}}
 */
export function addManualItem(draft, detail) {
    const error = precheckAdd(draft, detail);
    if (error) return { error };
    const text = String(detail.question_text_preview ?? detail.question_text ?? '').replace(/\s+/g, ' ').trim();
    const item = {
        question_id: detail.question_id, bucket: 'manual', target: null,
        chapter: detail.chapter ?? null, difficulty: detail.difficulty ?? null,
        question_text_preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        follows_question_id: detail.follows_question_id ?? null
    };
    if (Array.isArray(detail.group_ids) && detail.group_ids.length > 1) item.group_ids = [...detail.group_ids];
    return { draft: { ...draft, items: [...draft.items, item] } };
}

/**
 * 草稿裡與 questionId 同一個承上組的題（含自己），依草稿順序；不在草稿裡回 []。
 * 組＝以 follows_question_id 與伺服器給的 group_ids 相連的連通分量，只看草稿裡的題
 * （與組卷的 utils/paperGroups.groupFollowUps 同一個定義：可多層鏈、可分岔）。
 * @param {object|null} draft
 * @param {number} questionId
 * @returns {number[]}
 */
export function groupMembers(draft, questionId) {
    const items = draft?.items || [];
    const inDraft = new Set(items.map(i => i.question_id));
    if (!inDraft.has(questionId)) return [];
    const adj = new Map([...inDraft].map(id => [id, new Set()]));
    const link = (a, b) => {
        if (a === b || !inDraft.has(a) || !inDraft.has(b)) return;
        adj.get(a).add(b);
        adj.get(b).add(a);
    };
    for (const i of items) {
        if (i.follows_question_id !== undefined && i.follows_question_id !== null) link(i.question_id, i.follows_question_id);
        for (const g of Array.isArray(i.group_ids) ? i.group_ids : []) link(i.question_id, g);
    }
    const seen = new Set([questionId]);
    const stack = [questionId];
    while (stack.length) {
        for (const next of adj.get(stack.pop())) {
            if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
    }
    return items.map(i => i.question_id).filter(id => seen.has(id));
}

/**
 * 從草稿刪題（純函式）：刪的是**整個承上組**——只刪前題會留下學生寫不了的承上題，
 * confirm-paper 也會以 400 擋下半組（〔Owner 決策單 2026-09-25 B7〕）。沒有綁定的題就只刪它自己。
 * @param {object} draft
 * @param {number} questionId
 * @returns {object}
 */
export function removeItem(draft, questionId) {
    const members = new Set(groupMembers(draft, questionId));
    members.add(questionId);
    return { ...draft, items: draft.items.filter(i => !members.has(i.question_id)) };
}

/**
 * 草稿裡「前題不在草稿」的承上題（確認前的最後一道檢查；正常操作下應該是空的）。
 * @param {object|null} draft
 * @returns {Array<{question_id:number, follows_question_id:number}>}
 */
export function orphanFollowUps(draft) {
    const items = draft?.items || [];
    const ids = new Set(items.map(i => i.question_id));
    return items
        .filter(i => i.follows_question_id !== undefined && i.follows_question_id !== null && !ids.has(i.follows_question_id))
        .map(i => ({ question_id: i.question_id, follows_question_id: i.follows_question_id }));
}

/**
 * 依 GET /api/students/:id/remedial-paper/items 的查詢結果，把要加的題**整組**加進草稿（純函式）。
 *
 * 規則（與組卷的承上題整組同一個原則：寧可不加，也不出寫不了的題）：
 *   - 已在草稿 → duplicate；查不到 → missing；不同科 → other_subject；
 *     本身已封存 → archived；該生已寫過 → answered（confirm-paper 也會擋，這裡先講清楚）。
 *   - 題目屬於承上組（group_ids 超過 1 題）：組內每一題都要能出（存在、同科、沒封存、他沒寫過），
 *     就把整組還不在草稿裡的題一起加入；有任何一題不能出 → group_unavailable，整組不加。
 *   - 同一批裡同組的其他 id 已隨前面那題加入時，不再重複回報。
 *
 * @param {object} draft
 * @param {{items:object[], missing?:number[]}} lookup
 * @param {number[]} ids 老師要加的題（依輸入順序）
 * @returns {{draft:object, added:Array<{question_id:number, ids:number[], group:number[]}>,
 *            errors:Array<{question_id:number, error:string, subject?:string, group?:number[], blockers?:number[]}>}}
 */
export function planManualAdd(draft, lookup, ids) {
    const byId = new Map((lookup?.items || []).map(i => [i.question_id, i]));
    let d = draft;
    const added = [];
    const errors = [];
    const addedNow = new Set();
    for (const id of ids) {
        if (addedNow.has(id)) continue;
        if (d.items.some(i => i.question_id === id)) { errors.push({ question_id: id, error: 'duplicate' }); continue; }
        const info = byId.get(id);
        if (!info) { errors.push({ question_id: id, error: 'missing' }); continue; }
        if (info.subject !== d.subject) { errors.push({ question_id: id, error: 'other_subject', subject: info.subject }); continue; }
        if (info.archived) { errors.push({ question_id: id, error: 'archived' }); continue; }
        if (info.answered) { errors.push({ question_id: id, error: 'answered' }); continue; }
        const group = Array.isArray(info.group_ids) && info.group_ids.length ? info.group_ids : [id];
        const blockers = group.filter(g => {
            const m = byId.get(g);
            return !m || m.archived || m.answered || m.subject !== d.subject;
        });
        if (blockers.length) { errors.push({ question_id: id, error: 'group_unavailable', group, blockers }); continue; }
        const toAdd = group.filter(g => !d.items.some(i => i.question_id === g));
        for (const g of toAdd) {
            const m = byId.get(g);
            const r = addManualItem(d, {
                question_id: g, subject: m.subject, chapter: m.chapter, difficulty: m.difficulty,
                question_text_preview: m.question_text_preview, follows_question_id: m.follows_question_id, group_ids: group
            });
            if (r.draft) { d = r.draft; addedNow.add(g); }
        }
        added.push({ question_id: id, ids: toAdd, group });
    }
    return { draft: d, added, errors };
}

/** `#1、#2` */
const idList = ids => ids.map(id => `#${id}`).join('、');

/**
 * planManualAdd 的結果 → 要顯示的提示（純函式）。
 * @param {{added:object[], errors:object[]}} result
 * @param {object} draft 加完之後的草稿（取學生姓名與科目）
 * @returns {Array<{message:string, type:'success'|'info'|'error'}>}
 */
export function manualAddToasts(result, draft) {
    const out = [];
    const who = draft?.student_name ?? '';
    const singles = [];
    for (const a of result.added) {
        if (a.group.length > 1) {
            out.push({ type: 'success', message: `#${a.question_id} 屬於承上題組（${idList(a.group)}），承上題要與前題整組出：已整組加入 ${who} 的補救卷草稿。` });
        } else {
            singles.push(a.question_id);
        }
    }
    if (singles.length) out.push({ type: 'success', message: `已把 ${idList(singles)} 加入 ${who} 的補救卷草稿。` });
    const of = code => result.errors.filter(e => e.error === code);
    if (of('duplicate').length) out.push({ type: 'info', message: `${idList(of('duplicate').map(e => e.question_id))} 已在補救卷草稿裡，略過。` });
    if (of('missing').length) out.push({ type: 'error', message: `找不到題目 ${idList(of('missing').map(e => e.question_id))}。` });
    for (const e of of('other_subject')) {
        out.push({ type: 'error', message: `#${e.question_id} 是${e.subject}題，這份草稿是${draft?.subject ?? ''}；補救卷不混科，沒有加入。` });
    }
    if (of('archived').length) out.push({ type: 'error', message: `${idList(of('archived').map(e => e.question_id))} 已封存，沒有加入。` });
    if (of('answered').length) out.push({ type: 'error', message: `${idList(of('answered').map(e => e.question_id))} ${who} 已經寫過（出過卷），沒有加入。` });
    for (const e of of('group_unavailable')) {
        out.push({ type: 'error', message: `#${e.question_id} 屬於承上題組（${idList(e.group)}），但 ${idList(e.blockers)} 已封存、他寫過或不同科；承上題要整組出，這一組沒有加入。` });
    }
    return out;
}

/**
 * 依 bucket 分組（固定順序；空的組不列）。每組附上該 bucket 的 blueprint 列。
 * @param {object} draft
 * @returns {Array<{bucket:string, label:string, items:object[], blueprint:object[]}>}
 */
export function groupDraft(draft) {
    return BUCKET_ORDER
        .map(bucket => ({
            bucket,
            label: BUCKET_LABEL[bucket],
            items: draft.items.filter(i => i.bucket === bucket),
            blueprint: (draft.blueprint || []).filter(b => b.bucket === bucket)
        }))
        .filter(g => g.items.length > 0 || g.blueprint.length > 0);
}

/**
 * 重新產生草稿時會被換掉的手動加入題（純函式）。〔stage5 審查修正〕產生草稿會整份取代，老師手動加的題要提示。
 * @param {object|null} draft
 * @returns {number[]}
 */
export function manualIdsLost(draft) {
    if (!draft || !Array.isArray(draft.items)) return [];
    return draft.items.filter(i => i.bucket === 'manual').map(i => i.question_id);
}

/**
 * 送給 confirm-paper 的 question_ids（草稿裡的順序；伺服器會再依題型、難度排）。
 * @param {object} draft
 * @returns {number[]}
 */
export function draftQuestionIds(draft) {
    return draft ? draft.items.map(i => i.question_id) : [];
}

/**
 * 不足量的一句話。
 * @param {{target:{name:string}, wanted:number, got:number, reason:string}} s
 * @returns {string}
 */
export function shortfallText(s) {
    const name = s?.target?.name ?? '（未命名）';
    return `${name}：要 ${s.wanted} 題，只找到 ${s.got} 題（${SHORTFALL_REASON[s.reason] || s.reason}）`;
}

/**
 * 掌握度下界的顯示：null（沒有批改）顯示「—」，不是 0%。
 * @param {number|null|undefined} lb
 * @returns {string}
 */
export function formatMastery(lb) {
    if (lb === null || lb === undefined || !Number.isFinite(Number(lb))) return '—';
    return `${Math.round(Number(lb) * 100)}%`;
}

/**
 * 熱度等級：0 題最醒目（要補題）、越多越淡定。
 * @param {number|null|undefined} n
 * @returns {0|1|2|3|4} 0＝沒有題、1＝1–2、2＝3–5、3＝6–9、4＝10 以上
 */
export function heatLevel(n) {
    const v = Number(n) || 0;
    if (v <= 0) return 0;
    if (v <= 2) return 1;
    if (v <= 5) return 2;
    if (v <= 9) return 3;
    return 4;
}
const HEAT_CLASS = [
    'bg-rose-100 text-rose-700',
    'bg-amber-100 text-amber-800',
    'bg-emerald-50 text-emerald-700',
    'bg-emerald-100 text-emerald-800',
    'bg-emerald-200 text-emerald-900'
];

// ───────────────────────── 共用資料 ─────────────────────────

/**
 * 學生清單與科目清單（兩個錨點共用；科目一律讀 /api/chapter-whitelist，不寫死）。
 * @param {object} app
 * @returns {Promise<{students:Array<{id:number,name:string}>, subjects:string[], error:string|null}>}
 */
async function loadShared(app) {
    const out = { students: [], subjects: [], error: null };
    try {
        const [st, wl] = await Promise.all([getJson(app, '/api/students'), getJson(app, '/api/chapter-whitelist')]);
        out.students = Array.isArray(st.items) ? st.items : [];
        out.subjects = Object.keys(wl || {});
    } catch (err) {
        out.error = err.message || '載入失敗';
    }
    return out;
}

function fillSelect(select, options, placeholder) {
    select.textContent = '';
    if (placeholder !== undefined) select.appendChild(el('option', '', { value: '', textContent: placeholder }));
    for (const [value, label] of options) select.appendChild(el('option', '', { value: String(value), textContent: label }));
}

function sectionHead(icon, iconCls, eyebrow, title, desc) {
    const head = el('div', 'mb-4 flex items-start gap-3');
    const box = el('div');
    box.append(
        el('p', 'eyebrow text-indigo-500', { textContent: eyebrow }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: title }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', { textContent: desc })
    );
    head.append(el('span', `section-icon ${iconCls}`, { textContent: icon }), box);
    return head;
}

function labeled(label, control) {
    const wrap = el('label', 'flex flex-col gap-1 text-[11px] font-bold text-slate-500');
    wrap.append(el('span', '', { textContent: label }), control);
    return wrap;
}

// ───────────────────────── #remedial ─────────────────────────

/**
 * 建 #remedial 的骨架，回傳各控制項。
 * @param {HTMLElement} section
 * @returns {object} ui
 */
function mountRemedialSkeleton(section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.textContent = '';
    section.appendChild(sectionHead('補', 'bg-rose-50 text-rose-700', 'Remedial paper', '依弱點出補救卷',
        '依學生最近的批改結果，自動挑最弱的單位補救、補先備、再加一點延伸。只產草稿；確認後才出卷並記入作答歷史。'));

    const controls = el('div', 'grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-[1.2fr_.8fr_.6fr_.7fr_.6fr_.6fr_.6fr_1fr_auto] gap-3 items-end rounded-2xl border border-slate-100 bg-slate-50 p-4');
    const ui = {
        student: el('select', 'field-control p-2 text-sm', { id: 'remStudent', 'aria-label': '學生' }),
        subject: el('select', 'field-control p-2 text-sm', { id: 'remSubject', 'aria-label': '科目' }),
        total: el('input', 'field-control p-2 text-sm', { id: 'remTotal', type: 'number', min: MIN_TOTAL, max: MAX_TOTAL, 'aria-label': '題數' }),
        days: el('select', 'field-control p-2 text-sm', { id: 'remDays', 'aria-label': '看多久以內的批改' }),
        mixRemedial: el('input', 'field-control p-2 text-sm', { id: 'remMixRemedial', type: 'number', min: 0, 'aria-label': '補救配比（%）' }),
        mixPrereq: el('input', 'field-control p-2 text-sm', { id: 'remMixPrereq', type: 'number', min: 0, 'aria-label': '先備配比（%）' }),
        mixExt: el('input', 'field-control p-2 text-sm', { id: 'remMixExt', type: 'number', min: 0, 'aria-label': '延伸配比（%）' }),
        scope: el('select', 'field-control p-2 text-sm', { id: 'remSourceScope', 'aria-label': '題源限制（著作權）' }),
        generate: el('button', 'bg-rose-600 hover:bg-rose-700 text-white text-sm font-extrabold py-2 px-4 rounded-xl cursor-pointer disabled:opacity-40', {
            id: 'remGenerate', type: 'button', textContent: '產生草稿'
        })
    };
    ui.total.value = String(DEFAULT_TOTAL);
    ui.mixRemedial.value = String(DEFAULT_MIX_PERCENT.remedial);
    ui.mixPrereq.value = String(DEFAULT_MIX_PERCENT.prerequisite);
    ui.mixExt.value = String(DEFAULT_MIX_PERCENT.extension);
    fillSelect(ui.days, DAYS_OPTIONS.map(d => [d, `最近 ${d} 天`]));
    ui.days.value = String(DEFAULT_DAYS);
    fillSelect(ui.scope, SOURCE_SCOPES.map(([value, label]) => [value, label]));
    ui.scope.value = 'all';
    controls.append(
        labeled('學生', ui.student), labeled('科目', ui.subject), labeled('題數（5–50）', ui.total), labeled('看哪段批改', ui.days),
        labeled('補救 %', ui.mixRemedial), labeled('先備 %', ui.mixPrereq), labeled('延伸 %', ui.mixExt),
        labeled('題源限制', ui.scope), ui.generate
    );
    section.appendChild(controls);
    // 〔retrain PR-3〕配比下方「附上到期重練 [N] 題」（旗標關閉時不渲染）
    if (retrainEnabled()) section.appendChild(mountRetrainRow(ui));

    ui.status = el('p', 'mt-2 text-[11px] text-slate-400', { id: 'remStatus', textContent: '' });
    ui.kc = el('div', 'mt-4', { id: 'remKc' });
    ui.draft = el('div', 'mt-4', { id: 'remDraft' });
    ui.result = el('div', 'mt-4', { id: 'remResult' });
    // 〔dec/r16-remedial〕補救成效（選了學生才讀）
    ui.effect = el('div', 'mt-6', { id: 'remEffect' });
    section.append(ui.status, ui.kc, ui.draft, ui.result, ui.effect);
    return ui;
}

/**
 * 〔retrain PR-3〕「☐ 附上到期重練 [N] 題（目前到期 M 題）」那一列；ui 多 retrainAttach、retrainCount、retrainDue。
 * 預設不勾；N 預設 retrainDefaultCount(題數)，老師改過 N 之後題數再變也不覆寫。
 * @param {object} ui
 * @returns {HTMLElement}
 */
function mountRetrainRow(ui) {
    const row = el('div', 'mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs font-bold text-slate-600', {
        id: 'remRetrainRow'
    });
    ui.retrainAttach = el('input', '', { id: 'remRetrainAttach', type: 'checkbox', 'aria-label': '附上到期重練' });
    ui.retrainAttach.checked = false;                  // 預設不勾（R6）
    ui.retrainCount = el('input', 'field-control w-20 p-1.5 text-sm', {
        id: 'remRetrainCount', type: 'number', min: 0, max: MAX_RETRAIN_COUNT, 'aria-label': '到期重練題數'
    });
    ui.retrainEdited = false;
    ui.retrainCount.addEventListener('input', () => { ui.retrainEdited = true; });
    ui.retrainDue = el('span', 'font-normal text-slate-400', { id: 'remRetrainDue', textContent: '' });
    // 只有勾選框和它的文字包在 label 裡：點題數欄或到期數不會切換勾選
    const toggle = el('label', 'flex items-center gap-2 cursor-pointer');
    toggle.append(ui.retrainAttach, el('span', '', { textContent: '附上到期重練' }));
    row.append(toggle, ui.retrainCount, el('span', '', { textContent: '題' }), ui.retrainDue);
    syncRetrainCount(ui);
    ui.total.addEventListener('input', () => syncRetrainCount(ui));
    return row;
}

/** 題數改變時更新 N 的預設（老師改過就不動）。 */
function syncRetrainCount(ui) {
    if (!ui.retrainCount || ui.retrainEdited) return;
    const total = parseTotal(ui.total.value);
    ui.retrainCount.value = String(retrainDefaultCount(total ?? 0, retrainRatio()));
}

/** 讀目前到期題數（選的學生、科目）；晚到的舊回應不覆寫。 */
async function refreshRetrainDue(app, ui, studentId, subject) {
    if (!ui.retrainDue) return;
    const seq = (ui.retrainDueSeq = (ui.retrainDueSeq || 0) + 1);
    if (!studentId || !subject) { ui.retrainDue.textContent = ''; return; }
    ui.retrainDue.textContent = '（讀取目前到期題數…）';
    try {
        const params = new URLSearchParams({ status: 'due', subject });
        const res = await app.apiFetch(`/api/students/${studentId}/retrain-items?${params.toString()}`);
        const body = res.ok ? await res.json() : null;
        if (seq !== ui.retrainDueSeq) return;
        ui.retrainDue.textContent = body && body.counts ? `（目前到期 ${body.counts.due} 題）` : `（目前到期題數讀取失敗：${await messageOf(res)}）`;
    } catch {
        if (seq === ui.retrainDueSeq) ui.retrainDue.textContent = '（目前到期題數讀取失敗）';
    }
}

/**
 * 產生草稿要帶的 retrain_count：沒勾（或這一列不在）＝0＝不帶；勾了但 N 不是 0–20 的整數回 null（呼叫端提示）。
 * @returns {number|null}
 */
function retrainCountOf(ui) {
    if (!ui.retrainAttach || !ui.retrainAttach.checked) return 0;
    const s = String(ui.retrainCount.value ?? '').trim();
    const n = Number(s);
    return s !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_RETRAIN_COUNT ? n : null;
}

function selectedStudent(ui, students) {
    const id = Number(ui.student.value);
    return students.find(s => s.id === id) || null;
}

/** 知識點掌握度（最弱的 10 個）。 */
function renderKcTable(ui, body) {
    ui.kc.textContent = '';
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const box = el('details', 'rounded-2xl border border-slate-200 bg-white p-4');
    box.appendChild(el('summary', 'cursor-pointer text-xs font-extrabold text-slate-600', {
        textContent: `知識點掌握度（Wilson 下界，由弱到強；${rows.length} 個知識點有作答）`
    }));
    if (rows.length === 0) {
        box.appendChild(el('p', 'mt-2 text-xs text-slate-400', { textContent: '這段時間內沒有任何已標知識點的作答，補救卷會以章節為單位判斷弱點。' }));
    } else {
        const list = el('div', 'mt-2 space-y-1');
        for (const r of rows.slice(0, KC_TABLE_LIMIT)) {
            const line = el('div', 'flex flex-wrap items-center gap-2 text-xs text-slate-600');
            line.append(
                el('span', 'w-12 text-right font-extrabold text-slate-800', { textContent: formatMastery(r.mastery_lb) }),
                el('span', 'font-bold', { textContent: r.name }),
                el('span', 'text-slate-400', { textContent: `${r.chapter}　·　批改 ${r.graded}　·　答對率 ${formatMastery(r.correct_rate)}` })
            );
            if (r.low_sample) line.appendChild(el('span', 'rounded-full bg-amber-50 px-2 text-[10px] font-bold text-amber-700', { textContent: '樣本不足' }));
            list.appendChild(line);
        }
        box.appendChild(list);
    }
    if (Number(body?.untagged_graded) > 0) {
        box.appendChild(el('p', 'mt-2 text-[11px] text-slate-400', {
            textContent: `另有 ${body.untagged_graded} 題已批改但還沒標知識點（到「知識點」分頁標註後，診斷會更細）。`
        }));
    }
    ui.kc.appendChild(box);
}

/** 草稿（依 bucket 分組）＋手動加題＋確認。 */
function renderDraft(app, ui) {
    ui.draft.textContent = '';
    const draft = state.draft;
    if (!draft) {
        ui.draft.appendChild(el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500', {
            textContent: '選好學生與科目後按「產生草稿」。也可以從「找相似」的結果按「加入補救卷」。'
        }));
        return;
    }

    const box = el('div', 'rounded-2xl border border-rose-100 bg-white p-4');
    const head = el('div', 'flex flex-wrap items-center gap-2');
    head.appendChild(el('p', 'text-sm font-extrabold text-slate-800', {
        textContent: `${draft.student_name}　·　${draft.subject}　·　草稿 ${draft.items.length} 題`
    }));
    if (draft.basis) {
        head.appendChild(el('span', 'rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-extrabold text-indigo-700', {
            textContent: draft.basis === 'kc' ? '以知識點判斷弱點' : '以章節判斷弱點'
        }));
    }
    // 〔stage5 審查修正〕捨棄草稿：草稿是別的學生的時候，「加入補救卷」會被擋，原本沒有任何清掉它的控制項
    const discard = el('button', 'ml-auto text-[11px] font-bold px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 cursor-pointer', {
        id: 'remDiscard', type: 'button', textContent: '捨棄草稿', 'aria-label': `捨棄 ${draft.student_name} 的補救卷草稿（不會出卷）`
    });
    discard.addEventListener('click', () => {
        state.draft = null;
        renderDraft(app, ui);
        app.showToast('已捨棄補救卷草稿（沒有出卷、沒有記錄）。', 'info');
    });
    head.appendChild(discard);
    box.appendChild(head);

    if (draft.notes.length) {
        const notes = el('ul', 'mt-2 space-y-1 rounded-xl border border-amber-100 bg-amber-50/60 p-3 text-xs text-amber-800', { id: 'remNotes' });
        for (const n of draft.notes) notes.appendChild(el('li', '', { textContent: n }));
        box.appendChild(notes);
    }

    for (const group of groupDraft(draft)) {
        const g = el('div', 'mt-4', { 'data-bucket': group.bucket });
        g.appendChild(el('p', 'text-xs font-extrabold text-slate-700', { textContent: `${group.label}（${group.items.length} 題）` }));
        g.appendChild(el('p', 'text-[11px] text-slate-400', { textContent: BUCKET_HINT[group.bucket] }));
        for (const b of group.blueprint) {
            const short = b.got < b.wanted;
            g.appendChild(el('p', `mt-1 text-[11px] ${short ? 'font-bold text-rose-600' : 'text-slate-500'}`, {
                textContent: `・${b.target?.name ?? ''}：${b.rationale ?? ''}　要 ${b.wanted} 題、找到 ${b.got} 題`
                    + (short ? `（${SHORTFALL_REASON[(draft.shortfalls.find(s => s.target?.name === b.target?.name && s.bucket === b.bucket) || {}).reason] || '不足'}）` : '')
            }));
            // 〔dec/r16-remedial〕依錯因出題：補救目標的錯因主因與調整（沒有錯因標記時不顯示）
            const focus = errorFocusText(b.error_focus);
            if (focus) {
                g.appendChild(el('p', `ml-3 text-[11px] ${b.error_focus.applied ? 'font-bold text-violet-700' : 'text-slate-400'}`, {
                    textContent: focus, 'data-error-focus': b.error_focus.type
                }));
            }
            // 〔dec/r16-remedial〕庫存不足的補救目標：用他的錯題出變式補題（FEATURE_VARIANTS 關閉時不顯示）
            const reason = (draft.shortfalls.find(s => s.target?.name === b.target?.name && s.bucket === b.bucket) || {}).reason;
            const body = reason === 'insufficient_stock' && variantsEnabled() ? fillRequestBody(draft, b) : null;
            if (body) {
                const btn = el('button', 'ml-3 mt-1 text-[11px] font-bold px-2 py-1 rounded-lg border border-violet-200 bg-white text-violet-700 hover:bg-violet-50 cursor-pointer disabled:opacity-40', {
                    type: 'button', textContent: `生成變式補題（還差 ${body.units[0].needed} 題）`, 'data-fill-unit': b.target?.name ?? ''
                });
                btn.addEventListener('click', () => { requestFill(app, ui, body, btn).catch(err => console.error('[remedial] 補題失敗', err)); });
                g.appendChild(btn);
            }
        }
        const list = el('div', 'mt-2 space-y-2');
        for (const item of group.items) {
            // 承上組（同組組卷預覽的「換這組」）：標「承上 #x」、刪除鈕改「刪這組」，按下去整組刪
            const members = groupMembers(draft, item.question_id);
            const inGroup = members.length > 1;
            const card = el('div', `rounded-xl border border-slate-100 bg-slate-50/60 p-3${inGroup ? ' border-l-4 border-l-violet-300' : ''}`,
                { 'data-question-id': item.question_id, ...(inGroup ? { 'data-group': members.join(',') } : {}) });
            const meta = [
                `#${item.question_id}`,
                item.follows_question_id ? `承上 #${item.follows_question_id}` : (inGroup ? '有承上題' : ''),
                item.chapter || '',
                item.difficulty ? '★'.repeat(item.difficulty) : '',
                item.target && item.bucket !== 'manual' && item.bucket !== 'retrain' ? `目標：${item.target.name}` : '',
                // 〔retrain PR-3〕到期重練的題標關卡（R7：這是老師看的畫面；學生卷面不標）
                item.bucket === 'retrain' && item.step ? `重練・第 ${item.step} 關` : ''
            ].filter(Boolean).join('　·　');
            const row = el('div', 'flex items-start justify-between gap-2');
            row.appendChild(el('p', 'text-[11px] font-bold text-slate-400', { textContent: meta }));
            const del = el('button', 'text-[11px] font-bold px-2 py-1 rounded-lg border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 cursor-pointer', {
                type: 'button',
                textContent: inGroup ? '刪這組' : '刪除',
                'aria-label': inGroup ? `從草稿刪除承上題組 ${idList(members)}` : `從草稿刪除 #${item.question_id}`
            });
            del.addEventListener('click', () => {
                state.draft = removeItem(state.draft, item.question_id);
                renderDraft(app, ui);
            });
            row.appendChild(del);
            card.appendChild(row);
            const stem = el('p', 'mt-1 text-sm text-slate-700');
            stem.textContent = item.question_text_preview || '（手動加入：題目內容確認時由伺服器讀取）';
            card.appendChild(stem);
            app.renderMath(stem);
            list.appendChild(card);
        }
        g.appendChild(list);
        box.appendChild(g);
    }

    // 〔dec/r16-remedial〕補題進度（這位學生的）
    if (state.fill && state.fill.student_id === draft.student_id) box.appendChild(renderFill(app, ui));

    // 手動加題
    const add = el('div', 'mt-4 flex flex-wrap items-center gap-2');
    const addInput = el('input', 'field-control p-2 text-sm w-48', { id: 'remAddId', type: 'text', placeholder: '題目 ID（可多個，逗號分隔）', 'aria-label': '要加入的題目 ID' });
    const addBtn = el('button', 'text-xs font-bold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer', {
        id: 'remAddBtn', type: 'button', textContent: '加題'
    });
    addBtn.addEventListener('click', () => {
        const { ids, invalid } = parseQuestionIds(addInput.value);
        if (invalid.length) { app.showToast(`看不懂的題目 ID：${invalid.join('、')}`, 'error'); return; }
        if (ids.length === 0) return;
        addInput.value = '';
        addQuestions(app, ui, ids).catch(err => console.error('[remedial] 加題失敗', err));
    });
    add.append(addInput, addBtn);
    box.appendChild(add);

    // 確認
    const confirm = el('button', 'mt-4 w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-extrabold py-2.5 px-5 rounded-xl cursor-pointer disabled:opacity-40', {
        id: 'remConfirm', type: 'button', textContent: `確認出卷（${draft.items.length} 題）`
    });
    confirm.disabled = draft.items.length === 0;
    confirm.addEventListener('click', () => { confirmDraft(app, ui, confirm).catch(err => console.error('[remedial] 確認失敗', err)); });
    box.appendChild(confirm);
    ui.draft.appendChild(box);
}

async function generateDraft(app, ui, shared) {
    const student = selectedStudent(ui, shared.students);
    const subject = ui.subject.value;
    const total = parseTotal(ui.total.value);
    const mix = mixFromPercent({ remedial: ui.mixRemedial.value, prerequisite: ui.mixPrereq.value, extension: ui.mixExt.value });
    const days = Number(ui.days.value) || DEFAULT_DAYS;
    if (!student) return app.showToast('請先選學生。', 'error');
    if (!subject) return app.showToast('請先選科目。', 'error');
    if (total === null) return app.showToast(`題數要是 ${MIN_TOTAL}–${MAX_TOTAL} 的整數。`, 'error');
    if (!mix) return app.showToast('配比要是三個非負數，而且不能全是 0。', 'error');
    // 〔retrain PR-3〕勾了「附上到期重練」才帶 retrain_count（旗標關閉時這一列不存在＝0＝不帶）
    const retrainCount = retrainCountOf(ui);
    if (retrainCount === null) return app.showToast(`到期重練題數要是 0–${MAX_RETRAIN_COUNT} 的整數。`, 'error');

    ui.generate.disabled = true;
    ui.status.textContent = '產生草稿中…';
    try {
        const params = new URLSearchParams({ subject, days: String(days) });
        const [res, kcRes] = await Promise.all([
            postJson(app, `/api/students/${student.id}/remedial-paper`, remedialRequestBody({ subject, total, mix, days, scope: ui.scope.value, retrainCount })),
            app.apiFetch(`/api/students/${student.id}/weakness/kc?${params.toString()}`)
        ]);
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); ui.status.textContent = ''; return; }
        const body = await res.json();
        const droppedManual = manualIdsLost(state.draft);
        state.draft = draftFromResponse(body, student.name);
        state.draft.days = days;   // 〔dec/r16-remedial〕補題沿用同一個時間窗
        if (droppedManual.length) {
            app.showToast(`原草稿手動加入的 ${idList(droppedManual)} 沒有保留在新草稿裡；需要的話請再加一次。`, 'info');
        }
        state.lastPaper = null;
        ui.result.textContent = '';
        ui.status.textContent = `草稿已產生（尚未寫入）：${body.items.length} 題。`;
        if (kcRes.ok) renderKcTable(ui, await kcRes.json());
        renderDraft(app, ui);
    } catch {
        app.showToast('與後端連線中斷', 'error');
        ui.status.textContent = '';
    } finally {
        ui.generate.disabled = false;
    }
}

async function confirmDraft(app, ui, btn) {
    const draft = state.draft;
    const ids = draftQuestionIds(draft);
    if (ids.length === 0) return app.showToast('草稿是空的。', 'error');
    if (ids.length > MAX_PAPER) return app.showToast(`一張卷最多 ${MAX_PAPER} 題，請先刪掉一些。`, 'error');
    // 送出前先擋缺前題的承上題（學生寫不了）；confirm-paper 伺服器端也會整組檢查（〔Owner 決策單 2026-09-25 B7〕），這裡先擋、訊息較好懂
    const orphans = orphanFollowUps(draft);
    if (orphans.length) {
        return app.showToast(`承上題不能沒有前題：${orphans.map(o => `#${o.question_id}（承上 #${o.follows_question_id}）`).join('、')}。`
            + '請用題目 ID 把前題加回來，或按「刪這組」整組刪掉。', 'error');
    }
    btn.disabled = true;
    try {
        // 〔retrain PR-3〕草稿有「到期重練」組才多帶 retrain_question_ids
        // 〔dec/r16-remedial〕伺服器產的草稿多帶 kind: 'remedial' 與目標快照（補救成效用）
        const res = await postJson(app, '/api/confirm-paper', {
            student_id: draft.student_id, question_ids: ids, ...retrainConfirmKeys(draft), ...remedialConfirmKeys(draft)
        });
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const paper = await res.json();
        state.lastPaper = { paper_title: paper.paper_title, student_name: draft.student_name, question_ids: paper.question_ids, paper_id: paper.paper_id };
        state.draft = null;
        renderDraft(app, ui);
        renderResult(app, ui);
        app.showToast('補救卷已出卷，並記入作答歷史。', 'success');
        refreshEffect(app, ui, draft.student_id).catch(() => { });
    } catch {
        app.showToast('與後端連線中斷', 'error');
    } finally {
        btn.disabled = false;
    }
}

/**
 * Word 匯出版本（POST /api/download-word 的 edition；與組卷頁 index.html 的 #wordEdition 同一組值與檔名後綴）。
 * 〔stage5 審查修正〕補救卷原本只送三個鍵、拿到的永遠是標準版；補救卷正是要印給學生的卷，學生版／詳解版最用得到。
 */
export const WORD_EDITIONS = [
    ['standard', '標準版（卷末附答案）', ''],
    ['student', '學生版（不附答案）', '（學生版）'],
    ['solution', '詳解版（答案＋詳解）', '（詳解版）']
];

/**
 * 下載請求的 body 與檔名（純函式）。不認得的版本一律當 standard。
 * 〔retrain PR-3〕opts.paperId（FEATURE_RETRAIN 開啟時才給）：body 多 paper_id，伺服器依 R7 在標準版答案區與詳解版標「（重練）」。
 * @param {{paper_title:string, student_name:string, question_ids:number[]}} paper
 * @param {string} edition
 * @param {{paperId?:number|null}} [opts]
 * @returns {{body:object, filename:string}}
 */
export function wordDownloadRequest(paper, edition, { paperId = null } = {}) {
    const row = WORD_EDITIONS.find(e => e[0] === edition) || WORD_EDITIONS[0];
    return {
        body: {
            paper_title: paper.paper_title, student_name: paper.student_name, question_ids: paper.question_ids, edition: row[0],
            ...(Number.isInteger(paperId) && paperId > 0 ? { paper_id: paperId } : {})
        },
        filename: `${paper.paper_title}${row[2]}.docx`
    };
}

/** 確認後：標題＋既有的 Word 下載（可選版本）。 */
function renderResult(app, ui) {
    ui.result.textContent = '';
    const p = state.lastPaper;
    if (!p) return;
    const box = el('div', 'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4');
    box.appendChild(el('p', 'text-sm font-extrabold text-emerald-900', { textContent: `已出卷：${p.paper_title}（${p.question_ids.length} 題）` }));
    const actions = el('div', 'flex flex-wrap items-center gap-2');
    const edition = el('select', 'field-control min-h-0 py-2 px-3 text-xs font-bold', { id: 'remWordEdition', 'aria-label': 'Word 匯出版本' });
    for (const [value, label] of WORD_EDITIONS) edition.appendChild(el('option', '', { value, textContent: label }));
    edition.value = 'standard';
    const dl = el('button', 'bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold py-2.5 px-4 rounded-xl cursor-pointer', {
        id: 'remDownload', type: 'button', textContent: '下載 Word 考卷 (.docx)'
    });
    dl.addEventListener('click', () => { downloadWord(app, p, edition.value).catch(() => app.showToast('匯出 Word 失敗', 'error')); });
    actions.append(edition, dl);
    box.appendChild(actions);
    ui.result.appendChild(box);
}

/** 走既有的 POST /api/download-word（與組卷分頁同一支）。 */
async function downloadWord(app, paper, edition = 'standard') {
    // 〔retrain PR-3〕旗標開啟時帶 paper_id（R7 的「（重練）」標示）；關閉時請求與 PR-3 之前相同
    const { body, filename } = wordDownloadRequest(paper, edition, { paperId: retrainEnabled() ? paper.paper_id : null });
    const res = await postJson(app, '/api/download-word', body);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('application/vnd.openxmlformats-officedocument')) throw new Error(await messageOf(res));
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const a = el('a', '', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * 〔dec/r16-remedial〕送出補題請求，把排了哪些工作記在 state.fill（同一位學生累加；換學生就換一份）。
 */
async function requestFill(app, ui, body, btn) {
    const draft = state.draft;
    if (!draft) return;
    btn.disabled = true;
    try {
        const res = await postJson(app, `/api/students/${draft.student_id}/remedial-paper/fill-shortfall`, body);
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const out = await res.json();
        if (!state.fill || state.fill.student_id !== draft.student_id) state.fill = { student_id: draft.student_id, jobs: [], notes: [], status: {} };
        for (const j of out.jobs || []) {
            if (!state.fill.jobs.some(x => x.job_id === j.job_id)) state.fill.jobs.push(j);
        }
        state.fill.notes = Array.isArray(out.notes) ? out.notes : [];
        const n = Number(out.generating) || 0;
        app.showToast(n > 0
            ? `已排 ${n} 題變式生成（本機一題約 3～6 分鐘）。生成好的題在「待複核」，核准後重新產生草稿。`
            : (out.notes && out.notes[0]) || '沒有排任何生成。', n > 0 ? 'success' : 'info');
        renderDraft(app, ui);
    } catch {
        app.showToast('與後端連線中斷', 'error');
    } finally {
        btn.disabled = false;
    }
}

/** 補題進度方塊（工作清單＋說明＋重新整理）。 */
function renderFill(app, ui) {
    const f = state.fill;
    const box = el('div', 'mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-3 text-xs text-slate-700', { id: 'remFill' });
    box.appendChild(el('p', 'font-extrabold text-violet-800', { textContent: '變式補題進度' }));
    for (const n of f.notes) box.appendChild(el('p', 'mt-1 text-[11px] text-slate-500', { textContent: n }));
    if (f.jobs.length === 0) {
        box.appendChild(el('p', 'mt-1 text-[11px] text-slate-400', { textContent: '沒有進行中的生成工作。' }));
        return box;
    }
    const list = el('ul', 'mt-2 space-y-1');
    for (const j of f.jobs) list.appendChild(el('li', '', { textContent: fillJobLine(j, f.status[j.job_id] || null), 'data-job-id': j.job_id }));
    box.appendChild(list);
    box.appendChild(el('p', 'mt-2 text-[11px] text-slate-500', {
        textContent: '生成好的題會停在「待複核」（題庫管理）；核准之後按「產生草稿」重新產生，補上的題才會出現在草稿裡。'
    }));
    const refresh = el('button', 'mt-2 text-[11px] font-bold px-2 py-1 rounded-lg border border-violet-200 bg-white text-violet-700 hover:bg-violet-50 cursor-pointer', {
        id: 'remFillRefresh', type: 'button', textContent: '重新整理進度'
    });
    refresh.addEventListener('click', () => { refreshFill(app, ui).catch(err => console.error('[remedial] 補題進度讀取失敗', err)); });
    box.appendChild(refresh);
    return box;
}

/** 讀每個補題工作的狀態（既有的 GET /api/jobs/:id），讀完重畫草稿。 */
async function refreshFill(app, ui) {
    const f = state.fill;
    if (!f) return;
    for (const j of f.jobs) {
        try {
            const res = await app.apiFetch(`/api/jobs/${j.job_id}`);
            if (res.ok) f.status[j.job_id] = await res.json();
        } catch { /* 讀不到就維持上一次的狀態 */ }
    }
    renderDraft(app, ui);
}

/**
 * 〔dec/r16-remedial〕補救成效：這位學生的補救卷（新到舊），每個補救目標一行「補救前 → 這張卷 → 之後」＋狀態。
 * @param {object} ui
 * @param {object|null} body GET /api/students/:id/remedial-effect 的回應；null＝還沒選學生
 * @param {string} [error] 讀取失敗的訊息
 */
function renderEffect(ui, body, error) {
    ui.effect.textContent = '';
    const box = el('div', 'rounded-2xl border border-slate-200 bg-white p-4');
    box.appendChild(el('p', 'text-sm font-extrabold text-slate-800', { textContent: '補救成效' }));
    box.appendChild(el('p', 'text-[11px] text-slate-400', {
        textContent: '每份補救卷的補救組單位：出卷當下的答對率（補救前）、這張卷上的答對率、補救卷批改完之後其他卷上的答對率。只算每題第一次作答。'
    }));
    if (error) {
        box.appendChild(el('p', 'mt-2 text-xs text-rose-600', { textContent: `補救成效讀取失敗：${error}` }));
    } else if (!body) {
        box.appendChild(el('p', 'mt-2 text-xs text-slate-400', { textContent: '選學生後顯示。' }));
    } else if (!Array.isArray(body.papers) || body.papers.length === 0) {
        box.appendChild(el('p', 'mt-2 text-xs text-slate-400', { textContent: '這位學生還沒有從這裡確認出卷的補救卷。' }));
    } else {
        const th = body.thresholds || {};
        box.appendChild(el('p', 'mt-1 text-[11px] text-slate-400', {
            textContent: `答對率比補救前高 ${Math.round(Number(th.improved_delta) * 100)} 個百分點以上算進步、低 ${Math.round(Math.abs(Number(th.worse_delta)) * 100)} 個百分點以上算退步；`
                + `之後批改不到 ${th.min_after_graded ?? '?'} 題算資料不足，不到 ${th.min_n ?? '?'} 題標「樣本少」。`
        }));
        for (const p of body.papers) {
            const card = el('div', 'mt-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3', { 'data-paper-id': p.paper_id });
            const when = String(p.created_at ?? '').slice(0, 10);
            card.appendChild(el('p', 'text-xs font-extrabold text-slate-700', {
                textContent: `${p.title}　·　${when}　·　${p.graded ? '已批改完' : `已批改 ${p.graded_count}/${p.assigned_count} 題`}`
            }));
            if (!Array.isArray(p.targets) || p.targets.length === 0) {
                card.appendChild(el('p', 'mt-1 text-[11px] text-slate-400', { textContent: '這份卷沒有補救組的目標可追蹤。' }));
            }
            for (const t of p.targets || []) {
                const row = el('div', 'mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600', { 'data-status': t.status });
                const [label, cls] = EFFECT_STATUS[t.status] || [t.status, 'border-slate-200 bg-white text-slate-600'];
                row.append(
                    el('span', `rounded-full border px-2 py-0.5 font-extrabold ${cls}`, { textContent: label }),
                    el('span', 'font-bold text-slate-800', { textContent: t.name }),
                    el('span', '', { textContent: effectLine(t) })
                );
                if (t.low_sample && t.status !== 'pending' && t.status !== 'insufficient_data') {
                    row.appendChild(el('span', 'rounded-full bg-amber-50 px-2 text-[10px] font-bold text-amber-700', { textContent: '樣本少' }));
                }
                if (t.error_focus && t.error_focus.applied) {
                    row.appendChild(el('span', 'text-violet-700', { textContent: `（依錯因出題：${t.error_focus.label ?? t.error_focus.type}）` }));
                }
                card.appendChild(row);
            }
            box.appendChild(card);
        }
    }
    ui.effect.appendChild(box);
}

/** 讀補救成效（晚到的舊回應不覆寫）。 */
async function refreshEffect(app, ui, studentId) {
    if (!ui.effect) return;
    const seq = (ui.effectSeq = (ui.effectSeq || 0) + 1);
    if (!studentId) { renderEffect(ui, null); return; }
    try {
        const res = await app.apiFetch(`/api/students/${studentId}/remedial-effect`);
        const body = res.ok ? await res.json() : null;
        const error = res.ok ? null : await messageOf(res);
        if (seq !== ui.effectSeq) return;
        renderEffect(ui, body, error || undefined);
    } catch {
        if (seq === ui.effectSeq) renderEffect(ui, null, '與後端連線中斷');
    }
}

/**
 * 把題目整組加進目前的草稿（「用題目 ID 加題」與 `remedial:add` 共用）。
 *
 * 先查 GET /api/students/:id/remedial-paper/items（題目資料＋所在承上組的全部成員），
 * 再交給 planManualAdd 決定整組加入或拒絕。已在草稿裡的題不必問伺服器，直接提示。
 * 查詢期間草稿若換成另一位學生或另一科（老師重新產生了草稿），就不加，請老師再加一次。
 *
 * @param {object} app
 * @param {object} ui
 * @param {number[]} ids
 * @returns {Promise<number>} 實際加入的題數（含整組帶進來的前題／承上題）
 */
async function addQuestions(app, ui, ids) {
    const draft = state.draft;
    if (!draft || ids.length === 0) return 0;
    const inDraft = new Set(draft.items.map(i => i.question_id));
    const dupes = ids.filter(id => inDraft.has(id));
    const fresh = ids.filter(id => !inDraft.has(id));
    if (dupes.length) app.showToast(`${idList(dupes)} 已在補救卷草稿裡，略過。`, 'info');
    if (fresh.length === 0) return 0;

    let lookup;
    try {
        const params = new URLSearchParams({ ids: fresh.join(',') });
        lookup = await getJson(app, `/api/students/${draft.student_id}/remedial-paper/items?${params.toString()}`);
    } catch (err) {
        app.showToast(`無法確認題目資料（${err.message || '連線失敗'}），沒有加入。`, 'error');
        return 0;
    }
    const current = state.draft;
    if (!current || current.student_id !== draft.student_id || current.subject !== draft.subject) {
        app.showToast('草稿在查詢期間換掉了，請再加一次。', 'info');
        return 0;
    }
    const result = planManualAdd(current, lookup, fresh);
    state.draft = result.draft;
    renderDraft(app, ui);
    for (const t of manualAddToasts(result, state.draft)) app.showToast(t.message, t.type);
    return result.draft.items.length - current.items.length;
}

/**
 * `remedial:add` 的處理：加進目前的草稿；還沒有草稿就以目前選的學生與科目開一份空草稿。
 * 別的學生、別的科目、已在草稿裡的題在這裡就擋（不必問伺服器）；其餘交給 addQuestions 整組加。
 * @param {object} app
 * @param {object} ui
 * @param {object} shared
 * @param {object} detail
 */
function handleAdd(app, ui, shared, detail) {
    if (!Number.isInteger(detail?.question_id)) return;
    if (!state.draft) {
        if (Number.isInteger(detail.student_id) && shared.students.some(s => s.id === detail.student_id)) {
            ui.student.value = String(detail.student_id);
        }
        const student = selectedStudent(ui, shared.students);
        if (!student) { app.showToast('請先在「依弱點出補救卷」選學生，再加入題目。', 'error'); return; }
        const subject = (detail.subject && shared.subjects.includes(detail.subject)) ? detail.subject : ui.subject.value;
        state.draft = emptyDraft(student.id, student.name, subject);
        renderDraft(app, ui);
    }
    const error = precheckAdd(state.draft, detail);
    if (error === 'other_student') {
        app.showToast(`目前的草稿是另一位學生（${state.draft.student_name}）的，請先確認出卷，或按草稿右上角的「捨棄草稿」再加。`, 'error');
        return;
    }
    if (error === 'other_subject') {
        app.showToast(`#${detail.question_id} 是${detail.subject}題，目前的草稿是${state.draft.subject}；補救卷不混科，沒有加入。`, 'error');
        return;
    }
    if (error === 'duplicate') { app.showToast(`#${detail.question_id} 已在補救卷草稿裡。`, 'info'); return; }
    if (error) return;
    addQuestions(app, ui, [detail.question_id]).then(added => {
        if (!added) return;
        if (typeof app.showSection === 'function') app.showSection('students');
        // 學生視圖分頁化之後 #remedial 在「重練與補救」分頁：先請 students.js 切過去，下面的捲動才看得到
        document.dispatchEvent(new CustomEvent('examapp:student-tab', { detail: { anchor: 'remedial' } }));
        const node = document.getElementById('remedial');
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(err => console.error('[remedial] 加入補救卷失敗', err));
}

function mountRemedial(app, section, shared) {
    const ui = mountRemedialSkeleton(section);
    fillSelect(ui.student, shared.students.map(s => [s.id, s.name]), '選學生…');
    fillSelect(ui.subject, shared.subjects.map(s => [s, s]));
    if (shared.error) ui.status.textContent = `學生或科目清單載入失敗：${shared.error}`;
    renderDraft(app, ui);
    // 〔dec/r16-remedial〕補救成效：選學生時重讀
    renderEffect(ui, null);
    ui.student.addEventListener('change', () => { refreshEffect(app, ui, Number(ui.student.value) || null).catch(() => { }); });
    // 〔retrain PR-3〕選學生、換科目時更新「目前到期 M 題」（這一列只在旗標開啟時存在）
    if (ui.retrainDue) {
        const refresh = () => { refreshRetrainDue(app, ui, Number(ui.student.value) || null, ui.subject.value).catch(() => { }); };
        ui.student.addEventListener('change', refresh);
        ui.subject.addEventListener('change', refresh);
    }
    ui.generate.addEventListener('click', () => { generateDraft(app, ui, shared).catch(err => console.error('[remedial] 產生草稿失敗', err)); });
    document.addEventListener(REMEDIAL_ADD_EVENT, (event) => handleAdd(app, ui, shared, (event && event.detail) || {}));
    // 學生面板切到「重練與補救」分頁（或在那裡換學生）時，把這裡的學生與科目帶成面板選的那一位。
    // 有草稿在編時不動：草稿綁著原本的學生與科目，換掉下拉會讓畫面與草稿對不上。
    const prefill = (detail) => {
        if (state.draft || !Number.isInteger(detail.student_id)) return;
        if (!shared.students.some(st => st.id === detail.student_id)) return;
        const subject = detail.subject && shared.subjects.includes(detail.subject) ? detail.subject : ui.subject.value;
        if (ui.student.value === String(detail.student_id) && ui.subject.value === subject) return;
        ui.student.value = String(detail.student_id);
        ui.subject.value = subject;
        ui.student.dispatchEvent(new Event('change'));
        ui.subject.dispatchEvent(new Event('change'));
    };
    document.addEventListener('examapp:remedial-prefill', (event) => prefill((event && event.detail) || {}));
    // 本檔的掛載要先等學生與科目清單，可能比 students.js 發事件晚：這一塊正顯示著（人就在那個分頁）就直接讀面板的下拉補一次
    const panelStudent = document.getElementById('stuStudent');
    if (section.style.display !== 'none' && panelStudent && panelStudent.value) {
        prefill({ student_id: Number(panelStudent.value), subject: (document.getElementById('stuSubject') || {}).value || '' });
    }
    return ui;
}

// ───────────────────────── #coverage ─────────────────────────

function mountCoverageSkeleton(section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.textContent = '';
    section.appendChild(sectionHead('覆', 'bg-emerald-50 text-emerald-700', 'Coverage', '題庫覆蓋率',
        '每一章、每個難度各有幾題（只算未封存題）。紅色＝一題都沒有，該補題了。選了學生，就改看他還有幾題沒寫過。'));
    const controls = el('div', 'flex flex-wrap items-end gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4');
    const ui = {
        subject: el('select', 'field-control p-2 text-sm', { id: 'covSubject', 'aria-label': '科目' }),
        student: el('select', 'field-control p-2 text-sm', { id: 'covStudent', 'aria-label': '學生（選填）' }),
        refresh: el('button', 'bg-slate-900 hover:bg-emerald-700 text-white text-sm font-extrabold py-2 px-4 rounded-xl cursor-pointer', {
            id: 'covRefresh', type: 'button', textContent: '重新整理'
        })
    };
    controls.append(labeled('科目', ui.subject), labeled('學生（選填）', ui.student), ui.refresh);
    section.appendChild(controls);
    ui.table = el('div', 'mt-4 overflow-x-auto', { id: 'covTable' });
    ui.kc = el('div', 'mt-4', { id: 'covKc' });
    section.append(ui.table, ui.kc);
    return ui;
}

function heatCell(n, extraCls = '') {
    return el('td', `px-2 py-1 text-center text-xs font-bold ${HEAT_CLASS[heatLevel(n)]} ${extraCls}`, { textContent: String(n ?? 0) });
}

/** 章 × 難度的熱度表。 */
function renderCoverage(ui, body, withStudent) {
    ui.table.textContent = '';
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const table = el('table', 'min-w-full border-separate border-spacing-0.5 text-left');
    const thead = el('thead');
    const hr = el('tr');
    const headers = ['章節', '難度 1', '難度 2', '難度 3', '難度 4', '難度 5', '合計'];
    if (withStudent) headers.push('還沒寫過');
    for (const h of headers) hr.appendChild(el('th', 'px-2 py-1 text-[11px] font-extrabold text-slate-500', { textContent: h }));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    let lastVolume = null;
    for (const r of rows) {
        const vol = `${r.subject}｜${r.volume ?? '白名單外的舊章節'}`;
        if (vol !== lastVolume) {
            const vr = el('tr');
            vr.appendChild(el('td', 'pt-3 pb-1 text-[11px] font-extrabold text-indigo-500', { textContent: vol, colSpan: headers.length }));
            tbody.appendChild(vr);
            lastVolume = vol;
        }
        const tr = el('tr', '', { 'data-chapter': r.chapter });
        tr.appendChild(el('td', 'px-2 py-1 text-xs font-bold text-slate-700 whitespace-nowrap', { textContent: r.chapter }));
        for (const d of ['1', '2', '3', '4', '5']) tr.appendChild(heatCell(r.by_difficulty?.[d] ?? 0, withStudent ? 'opacity-60' : ''));
        tr.appendChild(heatCell(r.total));
        if (withStudent) tr.appendChild(heatCell(r.unseen_by_student, 'ring-1 ring-slate-300'));
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    ui.table.appendChild(table);

    // 知識點題數（依章分組，可展開）
    ui.kc.textContent = '';
    const kcRows = Array.isArray(body?.kc_rows) ? body.kc_rows : [];
    if (kcRows.length === 0) {
        ui.kc.appendChild(el('p', 'text-xs text-slate-400', { textContent: '還沒有載入任何知識點（FEATURE_KC 的知識點分頁載入後，這裡會列出每個知識點掛了幾題）。' }));
        return;
    }
    const byChapter = new Map();
    for (const k of kcRows) {
        if (!byChapter.has(k.chapter)) byChapter.set(k.chapter, []);
        byChapter.get(k.chapter).push(k);
    }
    const wrap = el('div', 'space-y-1');
    for (const [chapter, list] of byChapter) {
        const zero = list.filter(k => !k.total).length;
        const det = el('details', 'rounded-xl border border-slate-200 bg-white px-3 py-2');
        det.appendChild(el('summary', 'cursor-pointer text-xs font-bold text-slate-600', {
            textContent: `${chapter}：${list.length} 個知識點${zero ? `，${zero} 個還沒有題` : ''}`
        }));
        const ul = el('ul', 'mt-1 space-y-0.5');
        for (const k of list) {
            ul.appendChild(el('li', `text-[11px] ${k.total ? 'text-slate-600' : 'font-bold text-rose-600'}`, { textContent: `${k.name}（${k.code}）：${k.total} 題` }));
        }
        det.appendChild(ul);
        wrap.appendChild(det);
    }
    ui.kc.appendChild(wrap);
}

async function refreshCoverage(app, ui) {
    const params = new URLSearchParams();
    if (ui.subject.value) params.set('subject', ui.subject.value);
    if (ui.student.value) params.set('student_id', ui.student.value);
    ui.table.textContent = '載入中…';
    try {
        const body = await getJson(app, `/api/coverage${params.toString() ? `?${params.toString()}` : ''}`);
        renderCoverage(ui, body, Boolean(ui.student.value));
    } catch (err) {
        ui.table.textContent = `覆蓋率載入失敗：${err.message || ''}`;
    }
}

function mountCoverage(app, section, shared) {
    const ui = mountCoverageSkeleton(section);
    fillSelect(ui.subject, shared.subjects.map(s => [s, s]), '全部科目');
    if (shared.subjects.length) ui.subject.value = shared.subjects[0];
    fillSelect(ui.student, shared.students.map(s => [s.id, s.name]), '不指定學生');
    const run = () => { refreshCoverage(app, ui).catch(err => console.error('[remedial] 覆蓋率失敗', err)); };
    ui.refresh.addEventListener('click', run);
    ui.subject.addEventListener('change', run);
    ui.student.addEventListener('change', run);
    return { ui, ready: refreshCoverage(app, ui) };
}

// ───────────────────────── 進入點 ─────────────────────────

let initPromise = null;

/**
 * 掛載。旗標關閉時**整段不渲染**（第 1.5 條沿用階段 3 第 7.2 條：不得只是隱藏）。
 * 重複呼叫回同一個 Promise（檔尾的自動掛載與測試的明確呼叫不會掛兩次事件）。
 * @returns {Promise<void>}
 */
export function init() {
    if (!initPromise) initPromise = doInit();
    return initPromise;
}

async function doInit() {
    const remSection = document.getElementById('remedial');
    const covSection = document.getElementById('coverage');
    if (!remSection && !covSection) return;
    if (!remedialEnabled()) {
        console.info('[remedial] FEATURE_REMEDIAL 未開啟：補救卷與題庫覆蓋率整段不渲染（interfaces-stage5.md 第 1.3 條）。');
        return;
    }
    const app = bridge();
    if (!app) return;
    const shared = await loadShared(app);
    if (remSection) mountRemedial(app, remSection, shared);
    if (covSection) await mountCoverage(app, covSection, shared).ready;
}

// 自動掛載只在瀏覽器裡發生（沒有 document 的 Node 裡 import 本檔不該爆）。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
