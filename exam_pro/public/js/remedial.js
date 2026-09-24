// ─────────────────────────────────────────────────────────────
// public/js/remedial.js — 依弱點出補救卷與題庫覆蓋率（階段 5，擁有者：WS-D；docs/interfaces-stage5.md 第 4.4 條第 5 項）
//
// 兩個錨點（index.html 已預留，本檔不動 index.html）：
//
//   #remedial（學生視圖）  選學生、科目、題數、配比 → POST /api/students/:id/remedial-paper 產草稿
//                          → 依 bucket（補救／先備／延伸／手動加入）分組列出理由與不足量
//                          → 可刪題、可用題目 ID 加題 → 確認呼叫既有的 POST /api/confirm-paper
//                          → 提供既有的 Word 下載（POST /api/download-word）。
//                          另列「知識點掌握度」（GET /api/students/:id/weakness/kc），讓老師看得到草稿為什麼這樣選。
//   #coverage（題庫視圖）  GET /api/coverage：章 × 難度的熱度表；選了學生改看「還沒寫過」的題數；
//                          另列每個知識點掛了幾題。
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

export const BUCKET_ORDER = ['remedial', 'prerequisite', 'extension', 'manual'];
export const BUCKET_LABEL = { remedial: '補救', prerequisite: '先備', extension: '延伸', manual: '手動加入' };
const BUCKET_HINT = {
    remedial: '最弱的單位，選不超過他答錯題難度＋1 的題',
    prerequisite: '弱知識點的先備知識點，選基礎題',
    extension: '已相對掌握的單位，選難一點的題',
    manual: '老師自己加的題（確認時由伺服器檢查是否已寫過或已封存）'
};
const SHORTFALL_REASON = { insufficient_stock: '庫存不足', follow_up_group: '承上題須整組出題' };

export const DAYS_OPTIONS = [30, 90, 180, 365];
export const DEFAULT_DAYS = 90;              // 與伺服器端預設相同（契約第 4.4 條第 2 項）
export const DEFAULT_TOTAL = 20;
export const MIN_TOTAL = 5;
export const MAX_TOTAL = 50;
export const MAX_PAPER = 50;                 // confirm-paper 的 question_ids 上限
export const DEFAULT_MIX_PERCENT = { remedial: 60, prerequisite: 20, extension: 20 };
const KC_TABLE_LIMIT = 10;                   // 「知識點掌握度」只列最弱的 10 個

/** 模組層狀態：目前的草稿與上一次確認的卷（重整就歸零）。 */
const state = { draft: null, lastPaper: null };

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
        if (/^\d+$/.test(t) && Number.isInteger(n) && n >= 1) {
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
    return { student_id: studentId, student_name: studentName, subject, basis: null, items: [], blueprint: [], shortfalls: [], notes: [] };
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
        notes: Array.isArray(body.notes) ? body.notes : []
    };
}

/**
 * 把一題加進草稿（純函式，回新的草稿）。
 * @param {object|null} draft
 * @param {{question_id:number, student_id?:number|null, chapter?:string|null, difficulty?:number|null, question_text?:string}} detail
 * @returns {{draft:object}|{error:'no_draft'|'bad_id'|'other_student'|'duplicate'}}
 */
export function addManualItem(draft, detail) {
    if (!draft) return { error: 'no_draft' };
    const id = detail?.question_id;
    if (!Number.isInteger(id) || id < 1) return { error: 'bad_id' };
    if (detail.student_id !== undefined && detail.student_id !== null && detail.student_id !== draft.student_id) {
        return { error: 'other_student' };
    }
    if (draft.items.some(i => i.question_id === id)) return { error: 'duplicate' };
    const text = String(detail.question_text ?? '').replace(/\s+/g, ' ').trim();
    const item = {
        question_id: id, bucket: 'manual', target: null,
        chapter: detail.chapter ?? null, difficulty: detail.difficulty ?? null,
        question_text_preview: text.length > 80 ? `${text.slice(0, 80)}…` : text
    };
    return { draft: { ...draft, items: [...draft.items, item] } };
}

/**
 * 從草稿刪一題（純函式）。
 * @param {object} draft
 * @param {number} questionId
 * @returns {object}
 */
export function removeItem(draft, questionId) {
    return { ...draft, items: draft.items.filter(i => i.question_id !== questionId) };
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

    const controls = el('div', 'grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-[1.2fr_.8fr_.6fr_.7fr_.6fr_.6fr_.6fr_auto] gap-3 items-end rounded-2xl border border-slate-100 bg-slate-50 p-4');
    const ui = {
        student: el('select', 'field-control p-2 text-sm', { id: 'remStudent', 'aria-label': '學生' }),
        subject: el('select', 'field-control p-2 text-sm', { id: 'remSubject', 'aria-label': '科目' }),
        total: el('input', 'field-control p-2 text-sm', { id: 'remTotal', type: 'number', min: MIN_TOTAL, max: MAX_TOTAL, 'aria-label': '題數' }),
        days: el('select', 'field-control p-2 text-sm', { id: 'remDays', 'aria-label': '看多久以內的批改' }),
        mixRemedial: el('input', 'field-control p-2 text-sm', { id: 'remMixRemedial', type: 'number', min: 0, 'aria-label': '補救配比（%）' }),
        mixPrereq: el('input', 'field-control p-2 text-sm', { id: 'remMixPrereq', type: 'number', min: 0, 'aria-label': '先備配比（%）' }),
        mixExt: el('input', 'field-control p-2 text-sm', { id: 'remMixExt', type: 'number', min: 0, 'aria-label': '延伸配比（%）' }),
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
    controls.append(
        labeled('學生', ui.student), labeled('科目', ui.subject), labeled('題數（5–50）', ui.total), labeled('看哪段批改', ui.days),
        labeled('補救 %', ui.mixRemedial), labeled('先備 %', ui.mixPrereq), labeled('延伸 %', ui.mixExt), ui.generate
    );
    section.appendChild(controls);

    ui.status = el('p', 'mt-2 text-[11px] text-slate-400', { id: 'remStatus', textContent: '' });
    ui.kc = el('div', 'mt-4', { id: 'remKc' });
    ui.draft = el('div', 'mt-4', { id: 'remDraft' });
    ui.result = el('div', 'mt-4', { id: 'remResult' });
    section.append(ui.status, ui.kc, ui.draft, ui.result);
    return ui;
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
        }
        const list = el('div', 'mt-2 space-y-2');
        for (const item of group.items) {
            const card = el('div', 'rounded-xl border border-slate-100 bg-slate-50/60 p-3', { 'data-question-id': item.question_id });
            const meta = [
                `#${item.question_id}`,
                item.chapter || '',
                item.difficulty ? '★'.repeat(item.difficulty) : '',
                item.target && item.bucket !== 'manual' ? `目標：${item.target.name}` : ''
            ].filter(Boolean).join('　·　');
            const row = el('div', 'flex items-start justify-between gap-2');
            row.appendChild(el('p', 'text-[11px] font-bold text-slate-400', { textContent: meta }));
            const del = el('button', 'text-[11px] font-bold px-2 py-1 rounded-lg border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 cursor-pointer', {
                type: 'button', textContent: '刪除', 'aria-label': `從草稿刪除 #${item.question_id}`
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

    // 手動加題
    const add = el('div', 'mt-4 flex flex-wrap items-center gap-2');
    const addInput = el('input', 'field-control p-2 text-sm w-48', { id: 'remAddId', type: 'text', placeholder: '題目 ID（可多個，逗號分隔）', 'aria-label': '要加入的題目 ID' });
    const addBtn = el('button', 'text-xs font-bold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer', {
        id: 'remAddBtn', type: 'button', textContent: '加題'
    });
    addBtn.addEventListener('click', () => {
        const { ids, invalid } = parseQuestionIds(addInput.value);
        if (invalid.length) { app.showToast(`看不懂的題目 ID：${invalid.join('、')}`, 'error'); return; }
        let added = 0;
        for (const id of ids) {
            const r = addManualItem(state.draft, { question_id: id });
            if (r.draft) { state.draft = r.draft; added++; }
        }
        addInput.value = '';
        if (added) renderDraft(app, ui);
        if (added < ids.length) app.showToast(`${ids.length - added} 題已在草稿裡，略過。`, 'info');
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

    ui.generate.disabled = true;
    ui.status.textContent = '產生草稿中…';
    try {
        const params = new URLSearchParams({ subject, days: String(days) });
        const [res, kcRes] = await Promise.all([
            postJson(app, `/api/students/${student.id}/remedial-paper`, { subject, total, mix, days }),
            app.apiFetch(`/api/students/${student.id}/weakness/kc?${params.toString()}`)
        ]);
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); ui.status.textContent = ''; return; }
        const body = await res.json();
        state.draft = draftFromResponse(body, student.name);
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
    btn.disabled = true;
    try {
        const res = await postJson(app, '/api/confirm-paper', { student_id: draft.student_id, question_ids: ids });
        if (!res.ok) { app.showToast(await messageOf(res), 'error'); return; }
        const paper = await res.json();
        state.lastPaper = { paper_title: paper.paper_title, student_name: draft.student_name, question_ids: paper.question_ids, paper_id: paper.paper_id };
        state.draft = null;
        renderDraft(app, ui);
        renderResult(app, ui);
        app.showToast('補救卷已出卷，並記入作答歷史。', 'success');
    } catch {
        app.showToast('與後端連線中斷', 'error');
    } finally {
        btn.disabled = false;
    }
}

/** 確認後：標題＋既有的 Word 下載。 */
function renderResult(app, ui) {
    ui.result.textContent = '';
    const p = state.lastPaper;
    if (!p) return;
    const box = el('div', 'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4');
    box.appendChild(el('p', 'text-sm font-extrabold text-emerald-900', { textContent: `已出卷：${p.paper_title}（${p.question_ids.length} 題）` }));
    const dl = el('button', 'bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold py-2.5 px-4 rounded-xl cursor-pointer', {
        id: 'remDownload', type: 'button', textContent: '下載 Word 考卷 (.docx)'
    });
    dl.addEventListener('click', () => { downloadWord(app, p).catch(() => app.showToast('匯出 Word 失敗', 'error')); });
    box.appendChild(dl);
    ui.result.appendChild(box);
}

/** 走既有的 POST /api/download-word（與組卷分頁同一支）。 */
async function downloadWord(app, paper) {
    const res = await postJson(app, '/api/download-word', {
        paper_title: paper.paper_title, student_name: paper.student_name, question_ids: paper.question_ids
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('application/vnd.openxmlformats-officedocument')) throw new Error(await messageOf(res));
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const a = el('a', '', { href: url, download: `${paper.paper_title}.docx` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * `remedial:add` 的處理：加進目前的草稿；還沒有草稿就以目前選的學生與科目開一份空草稿。
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
    }
    const r = addManualItem(state.draft, detail);
    if (r.error === 'other_student') { app.showToast('目前的草稿是另一位學生的，請先確認或清掉那份草稿。', 'error'); return; }
    if (r.error === 'duplicate') { app.showToast(`#${detail.question_id} 已在補救卷草稿裡。`, 'info'); return; }
    if (r.error) return;
    state.draft = r.draft;
    renderDraft(app, ui);
    app.showToast(`已把 #${detail.question_id} 加入 ${state.draft.student_name} 的補救卷草稿。`, 'success');
    if (typeof app.showSection === 'function') app.showSection('students');
    const node = document.getElementById('remedial');
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mountRemedial(app, section, shared) {
    const ui = mountRemedialSkeleton(section);
    fillSelect(ui.student, shared.students.map(s => [s.id, s.name]), '選學生…');
    fillSelect(ui.subject, shared.subjects.map(s => [s, s]));
    if (shared.error) ui.status.textContent = `學生或科目清單載入失敗：${shared.error}`;
    renderDraft(app, ui);
    ui.generate.addEventListener('click', () => { generateDraft(app, ui, shared).catch(err => console.error('[remedial] 產生草稿失敗', err)); });
    document.addEventListener(REMEDIAL_ADD_EVENT, (event) => handleAdd(app, ui, shared, (event && event.detail) || {}));
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
