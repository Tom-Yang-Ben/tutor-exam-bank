// ─────────────────────────────────────────────────────────────
// public/js/retrain.js — 學生分頁的「錯題重練」卡（錯題重練第二階段之三 PR-4；docs/retrain-and-review.md 第 5.3 節）
//
// 錨點 #retrain（學生視圖，緊接在 #students 的弱點面板之後）。index.html 只放一個空的 <section id="retrain">
// 與一行 <script type="module">；內容全部由本檔建立。
//
// 這張卡**跟著學生分頁上方選的學生走**：students.js 每次載入學生視圖時在 document 上發
// `examapp:student-view`（detail：student_id、student_name、subject、days），本檔是唯一的聽眾。
// module 的執行順序不保證事件一定在本檔掛好監聽之後才發，所以掛載時也直接讀一次學生分頁的下拉（#stuStudent 等）。
// 本檔改了清單（加入、移出、判定已會、重新加入、出重練卷）之後發 `examapp:retrain-changed`，
// students.js 據此更新學生清單的「到期 N」徽章（出了重練卷時連試卷列表一起重載）。
//
// 卡片內容（第 5.3 節）：
//   四個數字   到期、進行中、練到會、卡關（GET /api/students/:id/retrain-items 的 counts；點一下就篩那一類）
//   清單       API-1 回來的順序就是第 4.7 節的順序（伺服器排好的），本檔**不重排**。每列：章節、題幹預覽（MathJax）、
//              關卡標籤、下次到期（逾期標紅）、連對／錯次數、徽章（到期／已派出卷 #…／卡關／已封存），
//              可展開作答歷史；動作：移出、判定已會、重新加入（API-3）、找相似（沿用既有的 examapp:variant-request）
//   手動加入題號（API-2）：開啟功能以前的錯題由這裡加（〔Owner 決策單 2026-09-26 R11 選 3〕不自動補建）
//   出一份重練卷：API-5 POST /api/students/:id/retrain-paper 產草稿（只產草稿、不寫入）→ 可刪題（承上組整組刪）→
//              確認走 API-7 POST /api/confirm-paper 帶 retrain_question_ids → 下載 Word 走 POST /api/download-word 帶 paper_id
//              （API-5、API-7、API-12 的伺服器端是 PR-3；形狀照第 5.2 節凍結的寫）。承上組整組放不下時伺服器回 400
//              （〔R12 選 2〕），訊息原樣顯示、不產生草稿。
//   重練成效   API-13 GET /api/students/:id/retrain-stats（〔R10 選 1〕弱點面板只看每題第一次作答，重練的表現看這裡）
//
// 慣例沿用階段 3～5 的 module：
//   - FEATURE_RETRAIN 關閉時**整段不渲染**（不是隱藏），也不發任何請求；旗標從 <meta name="feature-retrain"> 讀，
//     parseBool 與後端 config/features.js 逐字相同。`?retrain=1` 是本機驗收用的手動開關。
//     這張卡掛在學生分頁上，FEATURE_STUDENTS 關閉（學生分頁不存在）時也不渲染。
//   - 透過 window.ExamApp 橋接 apiFetch／showToast／renderMath；缺橋接就停手並印一行錯誤。
//   - 伺服器回來的文字（題幹、章節、關卡名稱、備註、錯誤訊息）一律 textContent，不用 innerHTML。
//   - 科目與時間窗跟著學生分頁上方的篩選（那一份科目清單讀 GET /api/chapter-whitelist，本檔不寫死任何科目）。
//   - 學生姓名只用在畫面與 Word 的抬頭（download-word 本來就要），不進 console、不送任何外部服務。
// ─────────────────────────────────────────────────────────────

/** students.js → 本檔：學生視圖載入了哪位學生（detail：student_id、student_name、subject、days）。 */
export const STUDENT_VIEW_EVENT = 'examapp:student-view';
/** 本檔 → students.js：清單變了（detail：student_id、papers_changed）。 */
export const RETRAIN_CHANGED_EVENT = 'examapp:retrain-changed';
/** 「找相似」沿用的既有事件（students.js 的 VARIANT_EVENT；variants.js 是聽眾）。 */
export const VARIANT_EVENT = 'examapp:variant-request';

export const MAX_PAPER = 50;                 // confirm-paper 的 question_ids 上限（API-5 的 count 也是 1–50）
export const DEFAULT_PAPER_COUNT = 10;       // API-5 的 count 預設（第 5.2 節）
export const MAX_ADD_IDS = 50;               // API-2 一次最多幾題
export const IN_FLIGHT_WARN_DAYS = 14;       // 已派出多久沒批改要提醒（伺服器的 in_flight_warn；文字用）
const PG_INT_MAX = 2147483647;               // 題目 id 是 PostgreSQL int4
const DEFAULT_DAYS = 90;                     // 學生分頁沒給時間窗時的預設（同 API-13 伺服器端預設）

/** API-1 的 status 篩選（第 5.2 節）。 */
export const STATUS_FILTERS = [
    ['active', '進行中'], ['due', '到期'], ['in_flight', '已派出'], ['stuck', '卡關'],
    ['mastered', '練到會'], ['retired', '已移出'], ['all', '全部']
];
/** 上方四個數字（counts 的鍵、標籤）；點一下就用同名的 status 篩選。 */
export const COUNT_TILES = [['due', '到期'], ['active', '進行中'], ['mastered', '練到會'], ['stuck', '卡關']];
/** 項目怎麼進清單的（retrain_items.reason）。 */
export const REASON_LABEL = { flagged: '批改時勾選', group: '承上組一起進', manual: '手動加入' };
/** API-2 的 skipped 原因。 */
export const SKIP_REASON = {
    not_assigned: '沒有派給這位學生過',
    already_in_schedule: '已在清單上（已移出的請在清單上按「重新加入」）',
    archived: '題目已封存',
    missing: '找不到這一題'
};
/** API-3 的三個 action 的按鈕文字。 */
export const ACTION_LABEL = { retire: '移出', mark_mastered: '判定已會', reactivate: '重新加入' };
/** 按第二次才執行的動作（重新加入會從第 1 關重來，按錯了的代價是進度歸零）。 */
const ARMED_TEXT = { retire: '再按一次確認移出', mark_mastered: '再按一次確認已會' };

/** Word 匯出版本（與組卷頁、補救卷同一組值與檔名後綴）。 */
export const WORD_EDITIONS = [
    ['standard', '標準版（卷末附答案）', ''],
    ['student', '學生版（不附答案）', '（學生版）'],
    ['solution', '詳解版（答案＋詳解）', '（詳解版）']
];

// ───────────────────────── 旗標與橋接 ─────────────────────────

/**
 * 與後端 config/features.js 的 parseBool 逐字相同：只有 '1' 與 'true' 為真。
 * 佔位字串沒被 app.js 替換掉時判為 false ＝「旗標關閉」的安全預設。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** @returns {boolean} FEATURE_RETRAIN 是否開啟 */
function retrainEnabled() {
    const meta = document.querySelector('meta[name="feature-retrain"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('retrain') === '1';
}

/** @returns {boolean} FEATURE_STUDENTS 是否開啟（這張卡掛在學生分頁上） */
function studentsEnabled() {
    const meta = document.querySelector('meta[name="feature-students"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('students') === '1';
}

/** @returns {boolean} FEATURE_SIMILAR 是否開啟（決定要不要畫「找相似」，同 students.js 的裁決 S3-R25） */
function similarEnabled() {
    const meta = document.querySelector('meta[name="feature-similar"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('similar') === '1';
}

function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[retrain] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來（interfaces-stage3.md 第 7.1 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[retrain] window.ExamApp 缺少：${missing.join('、')}。錯題重練卡不會掛載。`);
        return null;
    }
    return app;
}

/** 建元素（與 students.js 的 el 同款：含 '-' 的鍵與 role 走 setAttribute，其餘直接設屬性）。 */
function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(props || {})) {
        if (k.includes('-') || k === 'role') node.setAttribute(k, String(v));
        else node[k] = v;
    }
    return node;
}

/** 讀 `{ message }`；讀不到就回狀態碼。伺服器的訊息原樣顯示，不自己翻譯。 */
async function messageOf(res) {
    try {
        const body = await res.json();
        return body && body.message ? body.message : `HTTP ${res.status}`;
    } catch {
        return `HTTP ${res.status}`;
    }
}

function sendJson(app, url, method, body) {
    return app.apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * 一列的徽章（第 5.3 節：到期／已派出卷 #…／卡關／已封存）。已派出超過 14 天沒批改另加一個提醒。
 * @param {object} item API-1 的一筆
 * @returns {Array<{kind:string, text:string}>}
 */
export function itemBadges(item) {
    const out = [];
    if (item.due) out.push({ kind: 'due', text: '到期' });
    if (item.status === 'active' && item.in_flight) {
        out.push({ kind: 'in_flight', text: item.in_flight_paper_id ? `已派出卷 #${item.in_flight_paper_id}` : '已派出' });
        if (item.in_flight_warn) out.push({ kind: 'in_flight_warn', text: `派出超過 ${IN_FLIGHT_WARN_DAYS} 天還沒批改` });
    }
    if (item.stuck) out.push({ kind: 'stuck', text: '卡關' });
    if (item.archived) out.push({ kind: 'archived', text: '已封存' });
    return out;
}

/**
 * 關卡標籤：進行中顯示「第 n 關・名稱」；練到會、已移出顯示狀態與日期。
 * @param {object} item
 * @returns {string}
 */
export function stageText(item) {
    if (item.status === 'mastered') return item.mastered_on ? `練到會（${item.mastered_on}）` : '練到會';
    if (item.status === 'retired') return item.override_on ? `已移出（${item.override_on}）` : '已移出';
    return `第 ${item.step} 關・${item.step_label}`;
}

/**
 * 下次到期的文字；逾期（伺服器算的 overdue_days > 0）標紅。
 * @param {object} item
 * @returns {{text:string, overdue:boolean}}
 */
export function dueText(item) {
    if (item.status !== 'active' || !item.due_on) return { text: '不再到期', overdue: false };
    if (item.due && item.overdue_days > 0) return { text: `逾期 ${item.overdue_days} 天（${item.due_on} 到期）`, overdue: true };
    if (item.due) return { text: `到期（${item.due_on}）`, overdue: false };
    if (item.in_flight) return { text: `下次到期 ${item.due_on}（已派出，批改後重算）`, overdue: false };
    return { text: `下次到期 ${item.due_on}`, overdue: false };
}

/** @returns {string} 「連對 1 次・錯 2 次」 */
export function streakText(item) {
    return `連對 ${item.streak} 次・錯 ${item.lapses} 次`;
}

/**
 * 一筆作答的對錯文字。部分給分沒滿分的重練題依 R2（全對才算對）標「算錯」。
 * @param {{purpose:string, result:0|1|null, score:number|null}} h
 * @returns {string}
 */
export function resultText(h) {
    if (h.result !== 0 && h.result !== 1) return '未批';
    if (h.score === null || h.score === undefined) return h.result === 1 ? '對' : '錯';
    const pct = Math.round(Number(h.score) * 100);
    if (pct >= 100) return '給分 100%';
    return h.purpose === 'retrain' ? `給分 ${pct}%（未滿分，算錯）` : `給分 ${pct}%`;
}

/**
 * 作答歷史的一行：派題日・卷・第一次或重練第幾關・對錯・錯因。
 * @param {object} h API-1 history 的一筆
 * @param {(code:string) => string} [labelOf] 錯因代碼 → 標籤
 * @returns {string}
 */
export function historyLine(h, labelOf = c => c) {
    const kind = h.purpose === 'retrain' ? `重練・第 ${h.retrain_step} 關` : '第一次（新題）';
    const paper = h.paper_id ? `卷 #${h.paper_id}` : '（沒有對應的卷）';
    const parts = [h.assigned_at, paper, kind, resultText(h)];
    const tags = Array.isArray(h.error_types) ? h.error_types : [];
    if (tags.length) parts.push(`錯因：${tags.map(labelOf).join('、')}`);
    return parts.join('　·　');
}

/**
 * 一列可以按的動作：進行中 → 移出、判定已會；練到會 → 重新加入、移出；已移出 → 重新加入；另加找相似。
 * @param {object} item
 * @param {{similar?:boolean}} [opts]
 * @returns {string[]} 'retire'｜'mark_mastered'｜'reactivate'｜'similar'
 */
export function actionsFor(item, { similar = false } = {}) {
    const out = [];
    if (item.status === 'active') out.push('retire', 'mark_mastered');
    else if (item.status === 'mastered') out.push('reactivate', 'retire');
    else out.push('reactivate');
    if (similar) out.push('similar');
    return out;
}

/** API-3 的 body（note 不從這張卡改）。 */
export function actionBody(action) {
    return { action };
}

/**
 * 動作成功後的提示。retire／reactivate 作用在整個承上組，group_changed 列出一起變動的題。
 * @param {string} action
 * @param {{question_id:number}} item
 * @param {{group_changed?:Array<{question_id:number}>}} body API-3 的回應
 * @returns {string}
 */
export function actionToast(action, item, body) {
    const others = ((body && body.group_changed) || []).map(g => `#${g.question_id}`);
    const base = {
        retire: `已把 #${item.question_id} 移出清單`,
        mark_mastered: `已把 #${item.question_id} 判定為已會`,
        reactivate: `已重新加入 #${item.question_id}，從第 1 關重來（錯的次數保留）`
    }[action] || `已更新 #${item.question_id}`;
    if (!others.length) return `${base}。`;
    return `${base}；同組的 ${others.join('、')} 一起${action === 'retire' ? '移出' : '重新加入'}。`;
}

/**
 * 題號輸入框（逗號、空白、頓號分隔；可帶 #）→ 不重複的正整數。
 * @param {string} text
 * @returns {{ids:number[], invalid:string[]}}
 */
export function parseQuestionIds(text) {
    const ids = [];
    const invalid = [];
    for (const raw of String(text ?? '').split(/[\s,，、]+/).filter(Boolean)) {
        const tok = raw.replace(/^#/, '');
        const n = Number(tok);
        if (/^\d+$/.test(tok) && Number.isInteger(n) && n >= 1 && n <= PG_INT_MAX) {
            if (!ids.includes(n)) ids.push(n);
        } else {
            invalid.push(raw);
        }
    }
    return { ids, invalid };
}

/**
 * API-2 回應 → 提示。added 裡 reason = group 的是承上組一起帶進來的題；skipped 依原因分組。
 * @param {{added?:Array<{question_id:number, reason?:string}>, skipped?:Array<{question_id:number, reason:string}>}} body
 * @returns {Array<{message:string, type:string}>}
 */
export function addResultMessages(body) {
    const added = (body && body.added) || [];
    const skipped = (body && body.skipped) || [];
    const out = [];
    const primary = added.filter(a => a.reason !== 'group');
    const group = added.filter(a => a.reason === 'group');
    if (added.length) {
        out.push({
            type: 'success',
            message: `已加入 ${primary.map(a => `#${a.question_id}`).join('、') || '（無）'}，從第 1 關開始排程`
                + (group.length ? `；承上組的 ${group.map(a => `#${a.question_id}`).join('、')} 一起加入` : '') + '。'
        });
    }
    if (skipped.length) {
        const byReason = new Map();
        for (const s of skipped) {
            if (!byReason.has(s.reason)) byReason.set(s.reason, []);
            byReason.get(s.reason).push(`#${s.question_id}`);
        }
        const parts = [...byReason].map(([r, ids]) => `${ids.join('、')}：${SKIP_REASON[r] || r}`);
        out.push({ type: added.length ? 'info' : 'error', message: `沒有加入 ${parts.join('；')}。` });
    }
    if (!out.length) out.push({ type: 'info', message: '沒有任何變動。' });
    return out;
}

/**
 * 答對率的顯示：null（沒有批改過的作答）顯示「—」，不是 0%——沒批改不等於全錯。
 * @param {number|null|undefined} rate
 * @returns {string}
 */
export function formatRate(rate) {
    if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return '—';
    return `${(Number(rate) * 100).toFixed(1)}%`;
}

/**
 * 「66.7%（12／18）」；還沒有批改過的作答時說清楚。
 * @param {{graded:number, correct:number, rate:number|null}|undefined} block
 * @returns {string}
 */
export function rateText(block) {
    if (!block || !block.graded) return '—（這段期間還沒有批改過的）';
    return `${formatRate(block.rate)}（${block.correct}／${block.graded}）`;
}

/**
 * 重練卷題數輸入框 → 1～50 的整數；不合法回 null。
 * @param {any} raw
 * @returns {number|null}
 */
export function parseCount(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < 1 || n > MAX_PAPER) return null;
    return n;
}

/**
 * API-5 的 body：count 一定帶；科目、預計作答日有選才帶；「也放還沒到期的題」有勾才帶（伺服器預設 false）。
 * @param {{count:number, subject?:string, asOf?:string, includeNotDue?:boolean}} p
 * @returns {object}
 */
export function retrainPaperBody({ count, subject, asOf, includeNotDue }) {
    const body = { count };
    if (subject) body.subject = subject;
    if (asOf) body.as_of = asOf;
    if (includeNotDue) body.include_not_due = true;
    return body;
}

/**
 * API-5 的回應 → 草稿（記下是哪位學生的）。
 * @param {object} body
 * @param {{id:number, name:string}} student
 * @returns {object}
 */
export function draftFromResponse(body, student) {
    return {
        student_id: student.id,
        student_name: student.name,
        subject: body.subject ?? null,
        as_of: body.as_of ?? null,
        due_total: Number(body.due_total) || 0,
        notes: Array.isArray(body.notes) ? [...body.notes] : [],
        items: (Array.isArray(body.items) ? body.items : []).map(i => ({ ...i, group_ids: Array.isArray(i.group_ids) && i.group_ids.length ? [...i.group_ids] : [i.question_id] }))
    };
}

/**
 * 草稿依承上組分組（相鄰、同一組 group_ids 的題放一起；草稿的順序不變）。
 * @param {object} draft
 * @returns {Array<{group_ids:number[], items:object[]}>}
 */
export function draftGroups(draft) {
    const out = [];
    for (const item of (draft && draft.items) || []) {
        const key = item.group_ids.join(',');
        const last = out[out.length - 1];
        if (last && last.group_ids.join(',') === key) last.items.push(item);
        else out.push({ group_ids: item.group_ids, items: [item] });
    }
    return out;
}

/**
 * 從草稿刪掉一題所在的整個承上組（承上組不拆：confirm-paper 的整組檢查也會擋半組）。
 * @param {object} draft
 * @param {number} questionId
 * @returns {object} 新的草稿
 */
export function removeGroup(draft, questionId) {
    const item = draft.items.find(i => i.question_id === questionId);
    if (!item) return draft;
    const drop = new Set(item.group_ids);
    return { ...draft, items: draft.items.filter(i => !drop.has(i.question_id)) };
}

/**
 * API-7 的 body：純重練卷，全部題目都是重練題（第 5.2 節 API-5 的「確認走 API-7」）。
 * @param {object} draft
 * @returns {{student_id:number, question_ids:number[], retrain_question_ids:number[]}}
 */
export function confirmBody(draft) {
    const ids = draft.items.map(i => i.question_id);
    return { student_id: draft.student_id, question_ids: ids, retrain_question_ids: [...ids] };
}

/**
 * 下載請求的 body 與檔名。帶 paper_id：伺服器依 R7 選 1 在標準版答案區與詳解版標「（重練）」（API-12）。
 * @param {{paper_id:number, paper_title:string, student_name:string, question_ids:number[]}} paper
 * @param {string} edition
 * @returns {{body:object, filename:string}}
 */
export function wordDownloadRequest(paper, edition) {
    const row = WORD_EDITIONS.find(e => e[0] === edition) || WORD_EDITIONS[0];
    return {
        body: {
            paper_title: paper.paper_title, student_name: paper.student_name, question_ids: paper.question_ids,
            edition: row[0], paper_id: paper.paper_id
        },
        filename: `${paper.paper_title}${row[2]}.docx`
    };
}

// ───────────────────────── 模組狀態 ─────────────────────────

const state = {
    student: null,          // { id, name }
    subject: '',
    days: DEFAULT_DAYS,
    filter: 'active',
    asOf: '',
    list: null,             // API-1 的回應
    draft: null,            // 重練卷草稿（API-5）
    lastPaper: null,        // 確認後的卷（下載 Word 用）
    token: 0                // 最新一次載入的序號：舊的回應晚到就丟掉
};

let errorTypesPromise = null;

/** GET /api/error-types（錯因標籤；作答歷史第一次展開時才打，有快取，失敗就顯示代碼）。 */
function loadErrorLabels(app) {
    if (!errorTypesPromise) {
        errorTypesPromise = app.apiFetch('/api/error-types')
            .then(res => (res.ok ? res.json() : null))
            .catch(() => null)
            .then(body => {
                if (!body) { errorTypesPromise = null; return code => code; }
                const map = new Map((body.items || []).map(t => [t.code, t.label]));
                return code => map.get(code) || code;
            });
    }
    return errorTypesPromise;
}

/** 通知 students.js：清單變了（更新到期徽章；出了卷就連試卷列表一起重載）。 */
function notifyChanged(papersChanged = false) {
    if (!state.student) return;
    document.dispatchEvent(new CustomEvent(RETRAIN_CHANGED_EVENT, {
        detail: { student_id: state.student.id, papers_changed: papersChanged }
    }));
}

// ───────────────────────── 骨架 ─────────────────────────

const BTN = 'text-xs font-bold px-3 py-2 rounded-lg border bg-white cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const SMALL_BTN = 'text-[11px] font-bold px-2.5 py-1 rounded-lg border bg-white cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const BADGE_CLASS = {
    due: 'border-rose-200 bg-rose-50 text-rose-700',
    in_flight: 'border-sky-200 bg-sky-50 text-sky-700',
    in_flight_warn: 'border-amber-300 bg-amber-50 text-amber-800',
    stuck: 'border-orange-300 bg-orange-50 text-orange-700',
    archived: 'border-slate-300 bg-slate-100 text-slate-600'
};

function labeled(label, control) {
    const wrap = el('label', 'flex flex-col gap-1 text-[11px] font-bold text-slate-500');
    wrap.append(el('span', '', { textContent: label }), control);
    return wrap;
}

/**
 * 建立 <section id="retrain"> 的骨架。
 * @returns {object} ui
 */
function mountSkeleton(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.textContent = '';

    const head = el('div', 'mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4');
    const title = el('div', 'flex items-start gap-3');
    const titleBox = el('div');
    titleBox.append(
        el('p', 'eyebrow text-violet-600', { textContent: 'Retrain' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '錯題重練' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '批改時勾「要重練」的題會進這份清單：下一份卷重做、隔 1 週、再隔 2 週，連對 3 次就算練到會（全對才算對）。'
        })
    );
    title.append(el('span', 'section-icon bg-violet-50 text-violet-700', { textContent: '練' }), titleBox);

    const controls = el('div', 'flex flex-wrap items-end gap-2');
    const ui = {
        status: el('select', 'field-control min-h-0 p-2 text-sm', { id: 'rtStatus', 'aria-label': '篩選重練清單' }),
        asOf: el('input', 'field-control min-h-0 p-2 text-sm', { id: 'rtAsOf', type: 'date', value: '', 'aria-label': '預計作答日（空白＝今天）' })
    };
    for (const [value, label] of STATUS_FILTERS) ui.status.appendChild(el('option', '', { value, textContent: label }));
    ui.status.value = state.filter;
    controls.append(labeled('顯示', ui.status), labeled('預計作答日（空白＝今天）', ui.asOf));
    head.append(title, controls);

    ui.tiles = el('div', 'grid grid-cols-2 gap-2 sm:grid-cols-4', { id: 'rtCounts' });
    ui.tileButtons = {};
    for (const [key, label] of COUNT_TILES) {
        const btn = el('button', 'rounded-2xl border border-slate-200 bg-white p-3 text-left cursor-pointer transition-colors hover:border-violet-200', {
            type: 'button', 'data-retrain-count': key, 'aria-pressed': 'false'
        });
        btn.append(
            el('span', 'block text-2xl font-extrabold text-slate-800', { textContent: '—', 'data-count-value': key }),
            el('span', 'block text-[11px] font-bold text-slate-500', { textContent: label })
        );
        btn.addEventListener('click', () => {
            state.filter = key;
            ui.status.value = key;
            refresh(app, ui).catch(err => console.error('[retrain] 載入失敗', err));
        });
        ui.tileButtons[key] = btn;
        ui.tiles.appendChild(btn);
    }

    // 工具列：手動加入題號、出一份重練卷
    const tools = el('div', 'mt-4 flex flex-wrap items-end gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-3');
    const addBox = el('div', 'flex flex-wrap items-end gap-2');
    ui.addInput = el('input', 'field-control min-h-0 p-2 text-sm w-56', {
        id: 'rtAddIds', type: 'text', placeholder: '題號（可多個，逗號分隔）', 'aria-label': '要手動加入錯題重練清單的題號'
    });
    ui.addBtn = el('button', `${BTN} border-violet-200 text-violet-700 hover:bg-violet-50`, {
        id: 'rtAddBtn', type: 'button', textContent: '手動加入題號'
    });
    addBox.append(labeled('以前的錯題（曾派給他的題）', ui.addInput), ui.addBtn);

    const paperBox = el('div', 'flex flex-wrap items-end gap-2');
    ui.count = el('input', 'field-control min-h-0 p-2 text-sm w-20', {
        id: 'rtPaperCount', type: 'number', min: 1, max: MAX_PAPER, step: 1, value: String(DEFAULT_PAPER_COUNT), 'aria-label': '重練卷題數（1–50）'
    });
    ui.includeNotDue = el('input', 'accent-violet-600', { id: 'rtIncludeNotDue', type: 'checkbox', checked: false });
    const notDueLabel = el('label', 'inline-flex items-center gap-1 pb-2 text-xs text-slate-600');
    notDueLabel.append(ui.includeNotDue, el('span', '', { textContent: '也放還沒到期的題' }));
    ui.paperBtn = el('button', 'text-xs font-extrabold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', {
        id: 'rtPaperBtn', type: 'button', textContent: '出一份重練卷'
    });
    paperBox.append(labeled('題數（1–50）', ui.count), notDueLabel, ui.paperBtn);
    tools.append(addBox, paperBox);

    ui.draft = el('div', 'mt-4', { id: 'rtDraft' });
    ui.result = el('div', 'mt-4', { id: 'rtResult' });
    ui.message = el('p', 'mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500', {
        id: 'rtMessage', textContent: '在上方選一位學生，這裡會列出他的錯題重練清單。'
    });
    ui.list = el('div', 'mt-4 space-y-2', { id: 'rtList' });
    ui.stats = el('div', 'mt-6', { id: 'rtStats' });

    section.append(head, ui.tiles, tools, ui.draft, ui.result, ui.message, ui.list, ui.stats);

    ui.status.addEventListener('change', () => {
        state.filter = ui.status.value || 'active';
        refresh(app, ui).catch(err => console.error('[retrain] 載入失敗', err));
    });
    ui.asOf.addEventListener('change', () => {
        state.asOf = ui.asOf.value || '';
        refresh(app, ui).catch(err => console.error('[retrain] 載入失敗', err));
    });
    ui.addBtn.addEventListener('click', () => { addManual(app, ui).catch(err => console.error('[retrain] 手動加入失敗', err)); });
    ui.paperBtn.addEventListener('click', () => { generatePaper(app, ui).catch(err => console.error('[retrain] 產生草稿失敗', err)); });
    return ui;
}

// ───────────────────────── 載入與渲染 ─────────────────────────

/** 四個數字（counts 依科目篩選、不依 status 篩選）。 */
function renderCounts(ui, counts) {
    for (const [key] of COUNT_TILES) {
        const btn = ui.tileButtons[key];
        const value = btn.querySelector(`[data-count-value="${key}"]`);
        value.textContent = counts ? String(counts[key] ?? 0) : '—';
        const on = state.filter === key;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('border-violet-300', on);
        btn.classList.toggle('bg-violet-50', on);
    }
}

/**
 * 載入目前學生的清單與重練成效（兩支一起打；舊的回應晚到就丟掉）。
 * @param {object} app
 * @param {object} ui
 */
async function refresh(app, ui) {
    const st = state.student;
    if (!st) return;
    const token = ++state.token;
    ui.message.classList.remove('hidden');
    ui.message.textContent = '載入中…';
    renderCounts(ui, state.list && state.list.counts);

    const listParams = new URLSearchParams({ status: state.filter });
    if (state.subject) listParams.set('subject', state.subject);
    if (state.asOf) listParams.set('as_of', state.asOf);
    const statsParams = new URLSearchParams({ days: String(state.days) });
    if (state.subject) statsParams.set('subject', state.subject);

    let listRes, statsRes;
    try {
        [listRes, statsRes] = await Promise.all([
            app.apiFetch(`/api/students/${st.id}/retrain-items?${listParams.toString()}`),
            app.apiFetch(`/api/students/${st.id}/retrain-stats?${statsParams.toString()}`)
        ]);
    } catch {
        if (token === state.token) ui.message.textContent = '連線失敗，請稍後再試。';
        return;
    }
    if (token !== state.token) return;

    if (listRes.ok) {
        state.list = await listRes.json();
        if (token !== state.token) return;
        renderCounts(ui, state.list.counts);
        renderList(app, ui);
    } else {
        state.list = null;
        renderCounts(ui, null);
        ui.list.textContent = '';
        ui.message.textContent = await messageOf(listRes);
    }
    if (statsRes.ok) {
        const stats = await statsRes.json();
        if (token === state.token) renderStats(ui, stats);
    } else {
        const msg = await messageOf(statsRes);
        if (token === state.token) {
            ui.stats.textContent = '';
            ui.stats.appendChild(el('p', 'text-xs text-rose-500', { textContent: `重練成效載入失敗：${msg}` }));
        }
    }
}

/** 清單是空的時要講的話（依篩選）。 */
function emptyText(counts) {
    const total = counts ? ['active', 'mastered', 'retired'].reduce((s, k) => s + (Number(counts[k]) || 0), 0) : 0;
    if (total === 0) {
        return '清單是空的。批改時在題目旁勾「要重練」，或用上方「手動加入題號」加入以前的錯題'
            + '（開啟功能以前的錯題不會自動補進來）。';
    }
    return '這個篩選沒有題目。';
}

function renderList(app, ui) {
    ui.list.textContent = '';
    const items = (state.list && Array.isArray(state.list.items)) ? state.list.items : [];
    if (items.length === 0) {
        ui.message.classList.remove('hidden');
        ui.message.textContent = emptyText(state.list && state.list.counts);
        return;
    }
    ui.message.classList.add('hidden');
    for (const item of items) ui.list.appendChild(itemRow(app, ui, item));
}

/**
 * 清單的一列。
 * @param {object} app
 * @param {object} ui
 * @param {object} item API-1 的一筆
 * @returns {HTMLElement}
 */
function itemRow(app, ui, item) {
    const inGroup = Array.isArray(item.group_ids) && item.group_ids.length > 1;
    const card = el('div', `rounded-xl border border-slate-200 bg-white p-3${inGroup ? ' border-l-4 border-l-violet-300' : ''}`, {
        'data-retrain-item': String(item.item_id), 'data-question-id': String(item.question_id),
        ...(inGroup ? { 'data-group': item.group_ids.join(',') } : {})
    });

    const head = el('div', 'flex flex-wrap items-center gap-1.5');
    const meta = [
        `#${item.question_id}`,
        item.follows_question_id ? `承上 #${item.follows_question_id}` : (inGroup ? '有承上題' : ''),
        [item.subject, item.chapter].filter(Boolean).join('／') || '（未分類）',
        item.difficulty ? '★'.repeat(item.difficulty) : '',
        REASON_LABEL[item.reason] || ''
    ].filter(Boolean).join('　·　');
    head.appendChild(el('span', 'text-[11px] font-bold text-slate-400', { textContent: meta }));
    for (const b of itemBadges(item)) {
        head.appendChild(el('span', `rounded-full border px-2 py-0.5 text-[11px] font-extrabold ${BADGE_CLASS[b.kind] || ''}`, {
            textContent: b.text, 'data-badge': b.kind
        }));
    }
    card.appendChild(head);

    const stem = el('p', 'mt-1 text-sm text-slate-700', { 'data-retrain-stem': String(item.question_id) });
    stem.textContent = item.question_text_preview || '';
    card.appendChild(stem);
    app.renderMath(stem);

    const info = el('p', 'mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-bold');
    const due = dueText(item);
    info.append(
        el('span', 'text-violet-700', { textContent: stageText(item), 'data-retrain-stage': String(item.question_id) }),
        el('span', due.overdue ? 'text-rose-600' : 'text-slate-500', {
            textContent: due.text, 'data-retrain-due': String(item.question_id), 'data-overdue': String(due.overdue)
        }),
        el('span', 'text-slate-500', { textContent: streakText(item), 'data-retrain-streak': String(item.question_id) })
    );
    card.appendChild(info);
    if (item.note) card.appendChild(el('p', 'mt-1 text-[11px] text-slate-500', { textContent: `備註：${item.note}` }));

    const actions = el('div', 'mt-2 flex flex-wrap gap-2');
    for (const action of actionsFor(item, { similar: similarEnabled() })) {
        if (action === 'similar') {
            const btn = el('button', `${SMALL_BTN} border-indigo-200 text-indigo-700 hover:bg-indigo-50`, {
                type: 'button', textContent: '找相似', 'data-retrain-action': 'similar', 'data-variant-action': 'similar'
            });
            btn.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent(VARIANT_EVENT, {
                    detail: {
                        action: 'similar',
                        question_id: item.question_id,
                        student_id: state.student ? state.student.id : null,
                        chapter: item.chapter ?? null,
                        question_text: item.question_text_preview || ''
                    }
                }));
            });
            actions.appendChild(btn);
            continue;
        }
        const tone = action === 'reactivate' ? 'border-violet-200 text-violet-700 hover:bg-violet-50'
            : action === 'mark_mastered' ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50';
        const btn = el('button', `${SMALL_BTN} ${tone}`, {
            type: 'button', textContent: ACTION_LABEL[action], 'data-retrain-action': action
        });
        const run = () => { runAction(app, ui, item, action, btn).catch(err => console.error('[retrain] 動作失敗', err)); };
        if (ARMED_TEXT[action]) armTwice(btn, ARMED_TEXT[action], run);
        else btn.addEventListener('click', run);
        actions.appendChild(btn);
    }

    // 作答歷史（展開才畫）
    const history = Array.isArray(item.history) ? item.history : [];
    const histBtn = el('button', `${SMALL_BTN} border-slate-200 text-slate-600 hover:bg-slate-50`, {
        type: 'button', textContent: `作答歷史（${history.length} 筆）`, 'aria-expanded': 'false', 'data-retrain-history-toggle': String(item.question_id)
    });
    const histBox = el('div', 'mt-2 hidden rounded-lg border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-600 space-y-0.5', {
        'data-retrain-history': String(item.question_id)
    });
    let drawn = false;
    histBtn.addEventListener('click', async () => {
        const open = histBox.classList.contains('hidden');
        histBox.classList.toggle('hidden', !open);
        histBtn.setAttribute('aria-expanded', String(open));
        if (!open || drawn) return;
        drawn = true;
        const labelOf = await loadErrorLabels(app);
        histBox.textContent = '';
        if (history.length === 0) histBox.appendChild(el('p', '', { textContent: '沒有作答紀錄。' }));
        for (const h of history) histBox.appendChild(el('p', '', { textContent: historyLine(h, labelOf) }));
    });
    actions.appendChild(histBtn);
    card.append(actions, histBox);
    return card;
}

/** 按第二次才執行（同 students.js 管理面板的做法；4 秒沒按第二次就退回原文字）。 */
function armTwice(btn, armedText, run) {
    btn.addEventListener('click', () => {
        if (btn.dataset.armed === '1') { btn.dataset.armed = ''; run(); return; }
        btn.dataset.armed = '1';
        const original = btn.textContent;
        btn.textContent = armedText;
        setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = original; } }, 4000);
    });
}

/** API-3：移出、判定已會、重新加入。 */
async function runAction(app, ui, item, action, btn) {
    const st = state.student;
    if (!st) return;
    btn.disabled = true;
    try {
        const res = await sendJson(app, `/api/students/${st.id}/retrain-items/${item.item_id}`, 'PATCH', actionBody(action));
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const body = await res.json();
        app.showToast(actionToast(action, item, body), 'success');
        notifyChanged(false);
        await refresh(app, ui);
    } catch {
        app.showToast('連線失敗，請稍後再試', 'error');
    } finally {
        btn.disabled = false;
    }
}

/** API-2：手動加入題號。 */
async function addManual(app, ui) {
    const st = state.student;
    if (!st) { app.showToast('請先在上方選一位學生。', 'error'); return; }
    const { ids, invalid } = parseQuestionIds(ui.addInput.value);
    if (invalid.length) { app.showToast(`看不懂的題號：${invalid.join('、')}`, 'error'); return; }
    if (ids.length === 0) { app.showToast('請輸入要加入的題號。', 'error'); return; }
    if (ids.length > MAX_ADD_IDS) { app.showToast(`一次最多加入 ${MAX_ADD_IDS} 題，這次有 ${ids.length} 題。`, 'error'); return; }
    ui.addBtn.disabled = true;
    try {
        const res = await sendJson(app, `/api/students/${st.id}/retrain-items`, 'POST', { question_ids: ids });
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const body = await res.json();
        for (const m of addResultMessages(body)) app.showToast(m.message, m.type);
        ui.addInput.value = '';
        if ((body.added || []).length) notifyChanged(false);
        await refresh(app, ui);
    } catch {
        app.showToast('連線失敗，請稍後再試', 'error');
    } finally {
        ui.addBtn.disabled = false;
    }
}

// ───────────────────────── 重練卷：草稿 → 確認 → Word ─────────────────────────

/** API-5：產生草稿（不寫入）。 */
async function generatePaper(app, ui) {
    const st = state.student;
    if (!st) { app.showToast('請先在上方選一位學生。', 'error'); return; }
    const count = parseCount(ui.count.value);
    if (count === null) { app.showToast(`題數要是 1–${MAX_PAPER} 的整數。`, 'error'); return; }
    const body = retrainPaperBody({ count, subject: state.subject, asOf: state.asOf, includeNotDue: Boolean(ui.includeNotDue.checked) });
    ui.paperBtn.disabled = true;
    try {
        const res = await sendJson(app, `/api/students/${st.id}/retrain-paper`, 'POST', body);
        // 〔R12 選 2〕承上組整組放不下 → 400，訊息列出那一組與可以改成的題數；原樣顯示、不產生草稿
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const draft = draftFromResponse(await res.json(), st);
        if (!state.student || state.student.id !== draft.student_id) return;   // 等回應的期間換了學生
        state.draft = draft;
        state.lastPaper = null;
        renderResult(app, ui);
        renderDraft(app, ui);
        if (draft.items.length === 0) app.showToast('目前沒有可以出的重練題。', 'info');
    } catch {
        app.showToast('連線失敗，請稍後再試', 'error');
    } finally {
        ui.paperBtn.disabled = false;
    }
}

/** 草稿（沿用補救卷的樣式：分組列出、可刪題、確認）。 */
function renderDraft(app, ui) {
    ui.draft.textContent = '';
    const draft = state.draft;
    if (!draft) return;

    const box = el('div', 'rounded-2xl border border-violet-100 bg-white p-4');
    const head = el('div', 'flex flex-wrap items-center gap-2');
    head.appendChild(el('p', 'text-sm font-extrabold text-slate-800', {
        textContent: `重練卷草稿（尚未出卷）　·　${draft.items.length} 題　·　到期共 ${draft.due_total} 題`
    }));
    const discard = el('button', `ml-auto ${SMALL_BTN} border-slate-200 text-slate-500 hover:bg-slate-50`, {
        id: 'rtDiscard', type: 'button', textContent: '捨棄草稿'
    });
    discard.addEventListener('click', () => {
        state.draft = null;
        renderDraft(app, ui);
        app.showToast('已捨棄重練卷草稿（沒有出卷、沒有記錄）。', 'info');
    });
    head.appendChild(discard);
    box.appendChild(head);

    if (draft.notes.length) {
        const notes = el('ul', 'mt-2 space-y-1 rounded-xl border border-amber-100 bg-amber-50/60 p-3 text-xs text-amber-800', { id: 'rtNotes' });
        for (const n of draft.notes) notes.appendChild(el('li', '', { textContent: n }));
        box.appendChild(notes);
    }

    const list = el('div', 'mt-3 space-y-2');
    for (const group of draftGroups(draft)) {
        const inGroup = group.group_ids.length > 1;
        for (const item of group.items) {
            const card = el('div', `rounded-xl border border-slate-100 bg-slate-50/60 p-3${inGroup ? ' border-l-4 border-l-violet-300' : ''}`,
                { 'data-question-id': String(item.question_id), ...(inGroup ? { 'data-group': group.group_ids.join(',') } : {}) });
            const row = el('div', 'flex items-start justify-between gap-2');
            const meta = [
                `#${item.question_id}`,
                item.follows_question_id ? `承上 #${item.follows_question_id}` : (inGroup ? '有承上題' : ''),
                item.chapter || '',
                item.difficulty ? '★'.repeat(item.difficulty) : '',
                item.step_label || '',
                item.overdue_days > 0 ? `逾期 ${item.overdue_days} 天` : ''
            ].filter(Boolean).join('　·　');
            row.appendChild(el('p', 'text-[11px] font-bold text-slate-400', { textContent: meta }));
            const del = el('button', `${SMALL_BTN} border-rose-200 text-rose-600 hover:bg-rose-50`, {
                type: 'button', textContent: inGroup ? '刪這組' : '刪除',
                'aria-label': inGroup ? `從草稿刪除承上題組 ${group.group_ids.map(i => `#${i}`).join('、')}` : `從草稿刪除 #${item.question_id}`
            });
            del.addEventListener('click', () => {
                state.draft = removeGroup(state.draft, item.question_id);
                renderDraft(app, ui);
            });
            row.appendChild(del);
            card.appendChild(row);
            const stem = el('p', 'mt-1 text-sm text-slate-700');
            stem.textContent = item.question_text_preview || '';
            card.appendChild(stem);
            app.renderMath(stem);
            list.appendChild(card);
        }
    }
    box.appendChild(list);

    const confirm = el('button', 'mt-4 w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-extrabold py-2.5 px-5 rounded-xl cursor-pointer disabled:opacity-40', {
        id: 'rtConfirm', type: 'button', textContent: `確認出卷（${draft.items.length} 題）`
    });
    confirm.disabled = draft.items.length === 0;
    confirm.addEventListener('click', () => { confirmDraft(app, ui, confirm).catch(err => console.error('[retrain] 確認失敗', err)); });
    box.appendChild(confirm);
    box.appendChild(el('p', 'mt-2 text-[11px] text-slate-400', {
        textContent: '確認後這些題標成「已派出」，批改完才重新排程。學生的卷面不標哪幾題是重練；標準版答案區與詳解版會標「（重練）」。'
    }));
    ui.draft.appendChild(box);
}

/** API-7：confirm-paper 帶 retrain_question_ids。 */
async function confirmDraft(app, ui, btn) {
    const draft = state.draft;
    if (!draft || draft.items.length === 0) { app.showToast('草稿是空的。', 'error'); return; }
    if (draft.items.length > MAX_PAPER) { app.showToast(`一張卷最多 ${MAX_PAPER} 題，請先刪掉一些。`, 'error'); return; }
    btn.disabled = true;
    try {
        const res = await sendJson(app, '/api/confirm-paper', 'POST', confirmBody(draft));
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const paper = await res.json();
        state.lastPaper = {
            paper_id: paper.paper_id, paper_title: paper.paper_title,
            question_ids: Array.isArray(paper.question_ids) ? paper.question_ids : confirmBody(draft).question_ids,
            student_name: draft.student_name
        };
        state.draft = null;
        renderDraft(app, ui);
        renderResult(app, ui);
        app.showToast('重練卷已出卷；這些題目標成「已派出」，批改後才重新排程。', 'success');
        notifyChanged(true);
        await refresh(app, ui);
    } catch {
        app.showToast('與後端連線中斷', 'error');
    } finally {
        btn.disabled = false;
    }
}

/** 確認後：卷名＋Word 下載（可選版本；帶 paper_id）。 */
function renderResult(app, ui) {
    ui.result.textContent = '';
    const p = state.lastPaper;
    if (!p) return;
    const box = el('div', 'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4');
    box.appendChild(el('p', 'text-sm font-extrabold text-emerald-900', { textContent: `已出卷：${p.paper_title}（${p.question_ids.length} 題）` }));
    const actions = el('div', 'flex flex-wrap items-center gap-2');
    const edition = el('select', 'field-control min-h-0 py-2 px-3 text-xs font-bold', { id: 'rtWordEdition', 'aria-label': 'Word 匯出版本' });
    for (const [value, label] of WORD_EDITIONS) edition.appendChild(el('option', '', { value, textContent: label }));
    edition.value = 'standard';
    const dl = el('button', 'bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold py-2.5 px-4 rounded-xl cursor-pointer', {
        id: 'rtDownload', type: 'button', textContent: '下載 Word 考卷 (.docx)'
    });
    dl.addEventListener('click', () => { downloadWord(app, p, edition.value).catch(() => app.showToast('匯出 Word 失敗', 'error')); });
    actions.append(edition, dl);
    box.appendChild(actions);
    ui.result.appendChild(box);
}

/** POST /api/download-word（與組卷頁、補救卷同一支；多帶 paper_id）。 */
async function downloadWord(app, paper, edition = 'standard') {
    const { body, filename } = wordDownloadRequest(paper, edition);
    const res = await sendJson(app, '/api/download-word', 'POST', body);
    const type = (res.headers && res.headers.get('content-type')) || '';
    if (!res.ok || !type.includes('application/vnd.openxmlformats-officedocument')) throw new Error(await messageOf(res));
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const a = el('a', '', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ───────────────────────── 重練成效（API-13）─────────────────────────

function renderStats(ui, stats) {
    ui.stats.textContent = '';
    const box = el('div', 'rounded-2xl border border-slate-200 bg-white p-4', { 'data-retrain-stats': 'true' });
    box.append(
        el('p', 'eyebrow text-violet-500', { textContent: '重練成效' }),
        el('p', 'mt-1 mb-3 text-xs text-slate-400', {
            textContent: `答對率只算近 ${state.days} 天派出、已批改的重練（全對才算對，部分給分沒滿分算錯）；題數是目前的清單。`
                + '弱點面板只看每題第一次作答，重練的進步看這裡。'
        })
    );
    const rows = [
        ['first_retrain', '第一次重練答對率（第 1 關）', rateText(stats.first_retrain)],
        ['spaced', '隔週回測答對率（第 2 關以後）', rateText(stats.spaced)],
        ['entered', '進過清單', `${stats.entered} 題（進行中 ${stats.active}・練到會 ${stats.mastered}・已移出 ${stats.retired}）`],
        ['stuck', '卡關（錯滿次數，建議改講觀念或出變式）', `${stats.stuck} 題`],
        ['backlog', '到期', `${stats.backlog ? stats.backlog.due_now : 0} 題（逾期 7 天以上 ${stats.backlog ? stats.backlog.overdue_7d : 0} 題）`]
    ];
    const table = el('table', 'w-full text-left text-xs');
    const tbody = el('tbody');
    for (const [key, label, value] of rows) {
        const tr = el('tr', 'border-b border-slate-100', { 'data-stat': key });
        tr.append(
            el('th', 'py-1.5 pr-3 font-bold text-slate-500', { textContent: label }),
            el('td', 'py-1.5 font-mono text-slate-800', { textContent: value })
        );
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

    const chapters = Array.isArray(stats.by_chapter) ? stats.by_chapter : [];
    if (chapters.length) {
        const t = el('table', 'mt-3 w-full text-left text-xs', { 'data-stat': 'by_chapter' });
        const thead = el('thead');
        const hr = el('tr');
        for (const h of ['章節', '進過清單', '進行中', '練到會', '卡關']) hr.appendChild(el('th', 'py-1 pr-3 font-extrabold text-slate-500', { textContent: h }));
        thead.appendChild(hr);
        const body = el('tbody');
        for (const c of chapters) {
            const tr = el('tr', 'border-t border-slate-100');
            tr.append(
                el('td', 'py-1 pr-3 font-bold text-slate-700', { textContent: c.chapter ?? '（未分類）' }),
                el('td', 'py-1 pr-3 font-mono', { textContent: String(c.entered) }),
                el('td', 'py-1 pr-3 font-mono', { textContent: String(c.active) }),
                el('td', 'py-1 pr-3 font-mono', { textContent: String(c.mastered) }),
                el('td', `py-1 pr-3 font-mono${c.stuck ? ' font-bold text-orange-700' : ''}`, { textContent: String(c.stuck) })
            );
            body.appendChild(tr);
        }
        t.append(thead, body);
        box.appendChild(t);
    }
    ui.stats.appendChild(box);
}

// ───────────────────────── 跟著學生分頁走 ─────────────────────────

/** 從學生分頁的下拉讀目前的選擇（掛載時用；之後靠事件）。 */
function selectionFromDom() {
    const sel = document.getElementById('stuStudent');
    if (!sel || !sel.value) return null;
    const opt = [...sel.options].find(o => o.value === sel.value);
    return {
        student_id: Number(sel.value),
        student_name: opt ? (opt.getAttribute('data-name') || '') : '',
        subject: (document.getElementById('stuSubject') || {}).value || '',
        days: Number((document.getElementById('stuDays') || {}).value) || DEFAULT_DAYS
    };
}

/**
 * 學生分頁載入了某位學生（或清空）。換學生時草稿與上一張卷一起清掉（草稿是某位學生的）。
 * @param {object} app
 * @param {object} ui
 * @param {{student_id:number|null, student_name?:string, subject?:string, days?:number}} detail
 */
async function onStudentView(app, ui, detail) {
    const id = Number(detail.student_id);
    if (!Number.isInteger(id) || id < 1) {
        state.token += 1;
        state.student = null;
        state.list = null;
        state.draft = null;
        state.lastPaper = null;
        ui.list.textContent = '';
        ui.stats.textContent = '';
        renderDraft(app, ui);
        renderResult(app, ui);
        renderCounts(ui, null);
        ui.message.classList.remove('hidden');
        ui.message.textContent = '在上方選一位學生，這裡會列出他的錯題重練清單。';
        return;
    }
    if (!state.student || state.student.id !== id) {
        state.draft = null;
        state.lastPaper = null;
        renderDraft(app, ui);
        renderResult(app, ui);
    }
    state.student = { id, name: typeof detail.student_name === 'string' ? detail.student_name : '' };
    state.subject = typeof detail.subject === 'string' ? detail.subject : '';
    const days = Number(detail.days);
    state.days = Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_DAYS;
    await refresh(app, ui);
}

// ───────────────────────── 進入點 ─────────────────────────

let initPromise = null;

/**
 * 掛載。旗標關閉時**整段不渲染**（沿用階段 3 第 7.2 條：不得只是隱藏），也不發任何請求。
 * 重複呼叫回同一個 Promise（檔尾的自動掛載與測試的明確呼叫不會掛兩次事件）。
 * @returns {Promise<void>}
 */
export function init() {
    if (!initPromise) initPromise = doInit();
    return initPromise;
}

async function doInit() {
    const section = document.getElementById('retrain');
    if (!section) return;
    if (!retrainEnabled()) {
        console.info('[retrain] FEATURE_RETRAIN 未開啟：錯題重練卡整段不渲染（docs/retrain-and-review.md 第 5.1、5.3 節）。');
        return;
    }
    if (!studentsEnabled()) {
        console.info('[retrain] FEATURE_STUDENTS 未開啟：學生分頁不存在，錯題重練卡也整段不渲染。');
        return;
    }
    const app = bridge();
    if (!app) return;
    const ui = mountSkeleton(app, section);
    document.addEventListener(STUDENT_VIEW_EVENT, (event) => {
        onStudentView(app, ui, (event && event.detail) || {}).catch(err => console.error('[retrain] 載入失敗', err));
    });
    const initial = selectionFromDom();
    if (initial) await onStudentView(app, ui, initial);
}

// 自動掛載只在瀏覽器裡發生（沒有 document 的 Node 裡 import 本檔不該爆）。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error('[retrain] 掛載失敗', err)); });
    } else {
        init().catch(err => console.error('[retrain] 掛載失敗', err));
    }
}
