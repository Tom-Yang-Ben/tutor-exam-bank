// ─────────────────────────────────────────────────────────────
// public/js/kc.js — 知識點瀏覽、審定與人工標註（階段 5，擁有者：WS-C）
//
// 契約：docs/interfaces-stage5.md 第 4.3 條第 4 點（前端）、第 1.5 條（前端共通規則）。
// 操作說明寫在 docs/knowledge-components.md 第 6 節「給老師的操作說明」。
//
// 這一頁做三件事：
//   1. 依「科目 → 冊 → 章」瀏覽知識點；名稱、說明、口語版、課綱代碼可以就地編輯，
//      並切換 draft／approved（審定）。每張卡片顯示先備與「已標幾題」。
//   2. 口語版旁的「朗讀」：瀏覽器 speechSynthesis（zh-TW）。不支援時按鈕**不出現**。
//      Owner 審口語版的方式是「聽起來順不順」，所以朗讀是審定流程的一部分，不是裝飾。
//   3. 「題目 → 知識點」小工具：輸入題號、勾選知識點（同科、最多 5 個），存成人工標註。
//
// 慣例沿用階段 3／4 的 module：
//   - FEATURE_KC 從 <meta name="feature-kc"> 讀，parseBool 與後端 config/features.js 逐字相同；
//     旗標關閉時**整段不渲染**（不是隱藏）。`?kc=1` 是本機驗收用的手動開關。
//   - 透過 window.ExamApp 橋接 apiFetch／showToast／renderMath；橋接不存在就停手並印一行錯誤。
//   - 伺服器回來的文字一律 textContent（或表單欄位的 value），不進 innerHTML。
//   - 科目清單不寫死：讀 GET /api/chapter-volumes（第 1.5 條）。
// ─────────────────────────────────────────────────────────────

/** 與 utils/kcSeed.js 的 LIMITS 相同（第 3.4 條）；前端先擋一次，伺服器端才是最終閘門 */
export const LIMITS = { nameMax: 30, descriptionMax: 200, spokenMin: 40, spokenMax: 300, curriculumCodeMax: 40 };
/** 與 utils/kcSeed.js 的 LATEX_RE 逐字相同 */
const LATEX_RE = /\$|\\[a-zA-Z]+/;
/** 卡片上可以就地編輯的四個欄位（status 由「審定」按鈕切換） */
const EDITABLE = ['name', 'description', 'spoken_text', 'curriculum_code'];
/** PUT /api/questions/:id/kcs 一題最多幾個（第 4.3 條第 2 點） */
export const MAX_QUESTION_KCS = 5;

const STATUS_LABEL = { draft: '草稿', approved: '已審定' };
const SRC_LABEL = { ai: 'AI', human: '人工' };

// ───────────────────────── 橋接與旗標 ─────────────────────────

function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[kc] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[kc] window.ExamApp 缺少：${missing.join('、')}。知識點分頁不會掛載。`);
        return null;
    }
    return app;
}

/**
 * 與後端 config/features.js 的 parseBool 逐字相同（只有 '1'／'true' 為真）。
 * 佔位字串沒被 app.js 替換掉時判為 false ＝ 旗標關閉的安全預設。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

function kcEnabled() {
    const meta = document.querySelector('meta[name="feature-kc"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('kc') === '1';
}

// ───────────────────────── 純函式（test/unit/kcUi.test.js）─────────────────────────

/**
 * 前端的欄位檢查（與伺服器端 utils/kcSeed.js 的 checkKcField 同規則）。
 * @param {object} patch 只含要送出的欄位
 * @returns {string|null} 第一個錯誤；全部合法回 null
 */
export function validateKcPatch(patch) {
    const p = patch || {};
    const len = v => String(v ?? '').trim().length;
    if ('name' in p && (len(p.name) < 1 || len(p.name) > LIMITS.nameMax)) return `名稱要 1–${LIMITS.nameMax} 字。`;
    if ('description' in p && (len(p.description) < 1 || len(p.description) > LIMITS.descriptionMax)) {
        return `說明要 1–${LIMITS.descriptionMax} 字。`;
    }
    if ('spoken_text' in p) {
        const n = len(p.spoken_text);
        if (n < LIMITS.spokenMin || n > LIMITS.spokenMax) return `口語版要 ${LIMITS.spokenMin}–${LIMITS.spokenMax} 字（目前 ${n} 字）。`;
        if (LATEX_RE.test(String(p.spoken_text))) return '口語版不能有 LaTeX（$ 或 \\ 開頭的指令）：要能直接唸出來。';
    }
    if ('curriculum_code' in p && p.curriculum_code !== null && len(p.curriculum_code) > LIMITS.curriculumCodeMax) {
        return `課綱代碼最多 ${LIMITS.curriculumCodeMax} 字；不確定就留空。`;
    }
    if ('status' in p && !['draft', 'approved'].includes(p.status)) return '狀態只能是草稿或已審定。';
    return null;
}

/**
 * 表單目前的值與原始列比對，只留改過的欄位（字串 trim；課綱代碼清空＝null）。
 * @param {object} original GET /api/kc 的一列
 * @param {object} draft { name, description, spoken_text, curriculum_code } 表單值
 * @returns {object} 要送出的 patch（沒改就是 {}）
 */
export function diffKc(original, draft) {
    const out = {};
    for (const key of EDITABLE) {
        if (!(key in (draft || {}))) continue;
        let v = String(draft[key] ?? '').trim();
        if (key === 'curriculum_code' && v === '') v = null;
        const before = original ? (original[key] ?? (key === 'curriculum_code' ? null : '')) : null;
        if (v !== before) out[key] = v;
    }
    return out;
}

/**
 * 送去朗讀前的符號轉換：只處理語音引擎常常跳過或唸錯的幾個符號，文字本身不動。
 * （口語版本來就該寫成唸得出來的樣子，第 3.5 條第 5 點；這裡只是保險。）
 * @param {string} text
 * @returns {string}
 */
export function speechText(text) {
    const SUB = '₀₁₂₃₄₅₆₇₈₉';
    return String(text ?? '')
        .replace(/[₀-₉]/g, ch => String(SUB.indexOf(ch)))
        .replace(/²/g, '平方').replace(/³/g, '立方')
        .replace(/√/g, '根號').replace(/θ/g, '西塔').replace(/π/g, '派')
        .replace(/≤/g, '小於等於').replace(/≥/g, '大於等於').replace(/≠/g, '不等於').replace(/≈/g, '約等於')
        .replace(/×/g, '乘').replace(/÷/g, '除以').replace(/→/g, '，得到');
}

/**
 * 某一科的「冊 → 章」清單。/api/chapter-volumes 沒有這一科時（例如化學還沒併入白名單），
 * 退回一個「全部章節」的冊，章節順序照 items（伺服器已依白名單排好）。
 * @param {string} subject
 * @param {Record<string, Array<{name:string, chapters:string[]}>>} volumes
 * @param {object[]} items 這一科的知識點
 * @returns {Array<{name:string, chapters:string[]}>}
 */
export function volumesFor(subject, volumes, items) {
    const list = (volumes || {})[subject];
    if (Array.isArray(list) && list.length) return list;
    const chapters = [];
    for (const it of items || []) if (!chapters.includes(it.chapter)) chapters.push(it.chapter);
    return [{ name: '全部章節', chapters }];
}

/**
 * 依冊、章、狀態篩選（items 的順序保持伺服器給的白名單順序）。
 * @param {object[]} items
 * @param {{chapters?:string[]|null, chapter?:string, status?:string}} f
 * @returns {object[]}
 */
export function filterItems(items, f = {}) {
    return (items || []).filter(it =>
        (!f.chapters || f.chapters.includes(it.chapter)) &&
        (!f.chapter || it.chapter === f.chapter) &&
        (!f.status || it.status === f.status));
}

/**
 * 依章分組，章的順序照第一次出現（＝白名單順序）。
 * @returns {Array<{chapter:string, items:object[]}>}
 */
export function groupByChapter(items) {
    const groups = [];
    const at = new Map();
    for (const it of items || []) {
        if (!at.has(it.chapter)) { at.set(it.chapter, groups.length); groups.push({ chapter: it.chapter, items: [] }); }
        groups[at.get(it.chapter)].items.push(it);
    }
    return groups;
}

/** @returns {{total:number, approved:number, tagged:number}} */
export function summarize(items) {
    const list = items || [];
    return {
        total: list.length,
        approved: list.filter(i => i.status === 'approved').length,
        tagged: list.reduce((s, i) => s + (Number(i.question_count) || 0), 0)
    };
}

/**
 * 題號輸入 → 正整數，不合法回 null（與伺服器端 parseId 同規則）。
 * @param {any} raw
 * @returns {number|null}
 */
export function parseQuestionId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || String(n) !== s) return null;
    return n;
}

/**
 * 勾選結果 → PUT body。已經有的標註沿用原本的 weight，新勾的不送 weight（伺服器預設 1）。
 * @param {number[]} checkedIds
 * @param {Array<{kc_id:number, weight:number}>} current 目前的標註
 * @returns {{items:Array<{kc_id:number, weight?:number}>}}
 */
export function buildPutBody(checkedIds, current) {
    const weightOf = new Map((current || []).map(c => [c.kc_id, c.weight]));
    return {
        items: [...new Set(checkedIds || [])].map(id => {
            const w = weightOf.get(id);
            return Number.isFinite(w) && w > 0 && w <= 1 && w !== 1 ? { kc_id: id, weight: w } : { kc_id: id };
        })
    };
}

/** 瀏覽器有沒有語音合成（沒有就不畫「朗讀」按鈕） */
export function canSpeak(win) {
    return Boolean(win && win.speechSynthesis && typeof win.speechSynthesis.speak === 'function'
        && typeof win.SpeechSynthesisUtterance === 'function');
}

/** 先備標籤：跨科時前面加科目 */
export function prereqLabel(kc, pre) {
    const cross = pre.subject !== kc.subject;
    return `${cross ? `［${pre.subject}］` : ''}${pre.chapter}：${pre.name}`;
}

// ───────────────────────── DOM 小工具 ─────────────────────────

/** 建元素（與 students.js／assistant.js 的 el 同款）。textContent 一律走 textContent。 */
function el(tag, className = '', attrs = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'textContent') node.textContent = v;
        else node.setAttribute(k, v);
    }
    return node;
}

function option(value, label, selected = false) {
    const o = el('option', '', { value: String(value), textContent: label });
    if (selected) o.selected = true;
    return o;
}

/** 呼叫 API 並把 JSON 解出來；網路錯誤轉成 { ok:false, body:{message} } */
async function fetchJson(app, url, options) {
    try {
        const res = await app.apiFetch(url, options);
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        return { ok: res.ok, status: res.status, body };
    } catch {
        return { ok: false, status: 0, body: { message: '連線失敗，請稍後再試。' } };
    }
}

function jsonOptions(method, payload) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// ───────────────────────── 狀態 ─────────────────────────

/** 這一頁的狀態（只活在頁面裡）。 */
const state = {
    volumes: {},           // /api/chapter-volumes
    subject: '',
    volume: '',            // 冊名；'' ＝ 全部
    chapter: '',           // 章名；'' ＝ 全部
    status: '',            // '' ＝ 全部
    items: [],             // 目前科目的全部知識點（GET /api/kc?subject=）
    bySubject: new Map(),  // 科目 → items（小工具取同科清單時重用）
    speaking: null         // 正在朗讀的那顆按鈕
};

// ───────────────────────── 朗讀 ─────────────────────────

function stopSpeaking() {
    const synth = window.speechSynthesis;
    if (synth && typeof synth.cancel === 'function') synth.cancel();
    if (state.speaking) state.speaking.textContent = '朗讀';
    state.speaking = null;
}

/**
 * 朗讀一段口語版（zh-TW）。同一顆按鈕再按一次＝停止。
 * @param {HTMLElement} button
 * @param {string} text
 */
function speak(button, text) {
    if (state.speaking === button) { stopSpeaking(); return; }
    stopSpeaking();
    const synth = window.speechSynthesis;
    const utter = new window.SpeechSynthesisUtterance(speechText(text));
    utter.lang = 'zh-TW';
    utter.rate = 0.95;
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    const voice = (voices || []).find(v => /^zh[-_]TW/i.test(String(v.lang || '')));
    if (voice) utter.voice = voice;
    utter.onend = () => { if (state.speaking === button) { button.textContent = '朗讀'; state.speaking = null; } };
    utter.onerror = utter.onend;
    state.speaking = button;
    button.textContent = '停止';
    synth.speak(utter);
}

// ───────────────────────── 知識點卡片 ─────────────────────────

function fieldRow(label, control, hint) {
    const wrap = el('label', 'block');
    wrap.appendChild(el('span', 'mb-1 block text-[11px] font-bold text-slate-500', { textContent: label }));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(hint);
    return wrap;
}

/**
 * 一張知識點卡片。
 * @param {object} app 橋接
 * @param {object} ui
 * @param {object} item GET /api/kc 的一列
 * @returns {HTMLElement}
 */
function kcCard(app, ui, item) {
    const card = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm', { 'data-kc-id': String(item.id) });

    const head = el('div', 'mb-3 flex flex-wrap items-center gap-2');
    head.appendChild(el('span', 'font-mono text-[11px] text-slate-400', { textContent: item.code }));
    head.appendChild(el('span', item.status === 'approved'
        ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700'
        : 'rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700', {
        textContent: STATUS_LABEL[item.status] || item.status, 'data-role': 'status'
    }));
    head.appendChild(el('span', 'text-[11px] text-slate-500', {
        textContent: `已標 ${Number(item.question_count) || 0} 題`, 'data-role': 'count'
    }));
    card.appendChild(head);

    const inputs = {
        name: el('input', 'field-control block w-full p-2 text-sm font-bold', { type: 'text', name: 'name', 'aria-label': '名稱' }),
        description: el('textarea', 'field-control block w-full p-2 text-sm', { name: 'description', rows: '2', 'aria-label': '說明' }),
        spoken_text: el('textarea', 'field-control block w-full p-2 text-sm leading-relaxed', { name: 'spoken_text', rows: '3', 'aria-label': '口語版' }),
        curriculum_code: el('input', 'field-control block w-full p-2 text-xs font-mono', {
            type: 'text', name: 'curriculum_code', placeholder: '沒把握就留空（不得編造）', 'aria-label': '課綱代碼'
        })
    };
    inputs.name.value = item.name ?? '';
    inputs.description.value = item.description ?? '';
    inputs.spoken_text.value = item.spoken_text ?? '';
    inputs.curriculum_code.value = item.curriculum_code ?? '';

    const counter = el('p', 'mt-1 text-[11px] text-slate-400', { 'data-role': 'spoken-counter' });
    card.appendChild(fieldRow('名稱', inputs.name));
    card.appendChild(fieldRow('說明（課綱式的精確敘述）', inputs.description));
    card.appendChild(fieldRow('口語版（直接對學生說、唸得出來）', inputs.spoken_text, counter));
    card.appendChild(fieldRow('108 課綱學習內容代碼', inputs.curriculum_code));

    // 先備
    const pre = el('div', 'mt-3 flex flex-wrap items-center gap-1.5');
    pre.appendChild(el('span', 'text-[11px] font-bold text-slate-500', { textContent: '先備：' }));
    const prereqs = Array.isArray(item.prereqs) ? item.prereqs : [];
    if (!prereqs.length) pre.appendChild(el('span', 'text-[11px] text-slate-400', { textContent: '（無）' }));
    for (const p of prereqs) {
        pre.appendChild(el('span', 'rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600', {
            textContent: prereqLabel(item, p), title: p.code, 'data-role': 'prereq'
        }));
    }
    card.appendChild(pre);

    const error = el('p', 'mt-2 text-xs font-bold text-rose-600', { 'data-role': 'error' });
    card.appendChild(error);

    const actions = el('div', 'mt-3 flex flex-wrap items-center gap-2');
    const btnCls = 'rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer';
    if (canSpeak(window)) {
        const read = el('button', btnCls, { type: 'button', textContent: '朗讀', 'data-role': 'speak' });
        read.addEventListener('click', () => speak(read, inputs.spoken_text.value));
        actions.appendChild(read);
    }
    const save = el('button', 'rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-indigo-700 disabled:opacity-40 cursor-pointer', {
        type: 'button', textContent: '儲存修改', 'data-role': 'save'
    });
    const toggle = el('button', item.status === 'approved'
        ? btnCls
        : 'rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-emerald-700 disabled:opacity-40 cursor-pointer', {
        type: 'button', textContent: item.status === 'approved' ? '改回草稿' : '審定通過', 'data-role': 'toggle'
    });
    actions.append(save, toggle);
    card.appendChild(actions);

    const draft = () => Object.fromEntries(EDITABLE.map(k => [k, inputs[k].value]));
    function refresh() {
        const n = String(inputs.spoken_text.value || '').trim().length;
        const latex = LATEX_RE.test(inputs.spoken_text.value || '');
        counter.textContent = `${n} 字（${LIMITS.spokenMin}–${LIMITS.spokenMax}）${latex ? '　⚠ 有 LaTeX，唸不出來' : ''}`;
        counter.className = `mt-1 text-[11px] ${n < LIMITS.spokenMin || n > LIMITS.spokenMax || latex ? 'font-bold text-rose-600' : 'text-slate-400'}`;
        save.disabled = Object.keys(diffKc(item, draft())).length === 0;
    }
    for (const k of EDITABLE) inputs[k].addEventListener('input', refresh);
    refresh();

    save.addEventListener('click', () => saveCard(app, ui, item, card, diffKc(item, draft()), error));
    toggle.addEventListener('click', () => saveCard(app, ui, item, card, {
        ...diffKc(item, draft()), status: item.status === 'approved' ? 'draft' : 'approved'
    }, error));
    return card;
}

/**
 * PATCH /api/kc/:id，成功就用伺服器回的列重畫這張卡並更新摘要。
 * 「審定通過」會連同尚未儲存的修改一起送出（改完直接審定是最常見的操作）。
 */
async function saveCard(app, ui, item, card, patch, errorNode) {
    if (Object.keys(patch).length === 0) return;
    const problem = validateKcPatch(patch);
    if (problem) { errorNode.textContent = problem; return; }
    errorNode.textContent = '';
    for (const b of card.querySelectorAll('button')) b.disabled = true;

    const res = await fetchJson(app, `/api/kc/${item.id}`, jsonOptions('PATCH', patch));
    if (!res.ok) {
        errorNode.textContent = (res.body && res.body.message) || `儲存失敗（HTTP ${res.status}）`;
        for (const b of card.querySelectorAll('button')) b.disabled = false;
        return;
    }
    const updated = res.body;
    state.items = state.items.map(i => (i.id === updated.id ? updated : i));
    state.bySubject.set(state.subject, state.items);
    card.replaceWith(kcCard(app, ui, updated));
    renderSummary(ui);
    app.showToast(patch.status === 'approved' ? `已審定：${updated.name}` : `已儲存：${updated.name}`, 'success');
}

// ───────────────────────── 瀏覽區 ─────────────────────────

function currentVolumes() {
    return volumesFor(state.subject, state.volumes, state.items);
}

function renderToolbar(ui) {
    ui.volume.innerHTML = '';
    ui.volume.appendChild(option('', '全部冊', state.volume === ''));
    for (const v of currentVolumes()) ui.volume.appendChild(option(v.name, v.name, v.name === state.volume));

    ui.chapter.innerHTML = '';
    ui.chapter.appendChild(option('', '全部章', state.chapter === ''));
    const vols = currentVolumes().filter(v => !state.volume || v.name === state.volume);
    for (const v of vols) for (const c of v.chapters) ui.chapter.appendChild(option(c, c, c === state.chapter));
}

function visibleItems() {
    const vol = state.volume ? currentVolumes().find(v => v.name === state.volume) : null;
    return filterItems(state.items, {
        chapters: vol ? vol.chapters : null, chapter: state.chapter, status: state.status
    });
}

function renderSummary(ui) {
    const all = summarize(state.items);
    const shown = visibleItems();
    ui.summary.textContent = state.items.length
        ? `${state.subject}：共 ${all.total} 個知識點，已審定 ${all.approved} 個；這裡顯示 ${shown.length} 個。`
        : `${state.subject || '這一科'}還沒有知識點（先執行 npm run kc:load 載入種子檔）。`;
}

function renderList(app, ui) {
    ui.list.innerHTML = '';
    const groups = groupByChapter(visibleItems());
    if (!groups.length && state.items.length) {
        ui.list.appendChild(el('p', 'rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400', {
            textContent: '沒有符合篩選條件的知識點。'
        }));
    }
    for (const g of groups) {
        const box = el('div', 'mb-6', { 'data-chapter': g.chapter });
        const s = summarize(g.items);
        const h = el('h3', 'mb-2 flex items-baseline gap-2 text-base font-extrabold text-slate-800');
        h.appendChild(el('span', '', { textContent: g.chapter }));
        h.appendChild(el('span', 'text-xs font-bold text-slate-400', { textContent: `已審定 ${s.approved}／${s.total}` }));
        box.appendChild(h);
        const grid = el('div', 'grid gap-3 lg:grid-cols-2');
        for (const it of g.items) grid.appendChild(kcCard(app, ui, it));
        box.appendChild(grid);
        ui.list.appendChild(box);
    }
    renderSummary(ui);
}

/** 讀一科的知識點（有快取；force 時重抓） */
async function loadSubjectItems(app, subject, force = false) {
    if (!force && state.bySubject.has(subject)) return { ok: true, items: state.bySubject.get(subject) };
    const res = await fetchJson(app, `/api/kc?subject=${encodeURIComponent(subject)}`);
    if (!res.ok) return { ok: false, message: (res.body && res.body.message) || `讀取失敗（HTTP ${res.status}）` };
    const items = Array.isArray(res.body && res.body.items) ? res.body.items : [];
    state.bySubject.set(subject, items);
    return { ok: true, items };
}

async function selectSubject(app, ui, subject, force = false) {
    state.subject = subject;
    state.volume = '';
    state.chapter = '';
    ui.list.innerHTML = '';
    ui.summary.textContent = '讀取中…';
    const r = await loadSubjectItems(app, subject, force);
    if (!r.ok) {
        state.items = [];
        ui.summary.textContent = r.message;
        app.showToast(r.message, 'error');
        return;
    }
    state.items = r.items;
    renderToolbar(ui);
    renderList(app, ui);
}

// ───────────────────────── 題目 → 知識點 ─────────────────────────

const tool = { detail: null, kcs: [] };

function renderQuestionTool(app, ui) {
    const t = ui.tool;
    t.info.innerHTML = '';
    t.current.innerHTML = '';
    t.picker.innerHTML = '';
    t.count.textContent = '';
    t.save.disabled = true;
    const d = tool.detail;
    if (!d) return;

    const q = d.question;
    t.info.appendChild(el('p', 'text-xs font-bold text-slate-500', {
        textContent: `#${q.id}｜${q.subject}｜${q.chapter}｜${q.question_type}｜難度 ${q.difficulty}${q.archived ? '｜已封存' : ''}`
    }));
    const stem = el('p', 'mt-1 whitespace-pre-line text-sm text-slate-700', { textContent: q.question_text });
    t.info.appendChild(stem);
    app.renderMath(stem);

    t.current.appendChild(el('span', 'text-[11px] font-bold text-slate-500', { textContent: '目前標註：' }));
    if (!d.items.length) t.current.appendChild(el('span', 'text-[11px] text-slate-400', { textContent: '（尚未標註）' }));
    for (const c of d.items) {
        const conf = c.confidence === null || c.confidence === undefined ? '' : ` ${Number(c.confidence).toFixed(2)}`;
        t.current.appendChild(el('span', 'rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600', {
            textContent: `${c.name}（${SRC_LABEL[c.src] || c.src}${conf}）`, title: c.code, 'data-role': 'current-kc'
        }));
    }

    if (!tool.kcs.length) {
        t.picker.appendChild(el('p', 'text-xs text-slate-400', { textContent: `${q.subject}還沒有知識點可以選。` }));
        return;
    }
    const checked = new Set(d.items.map(c => c.kc_id));
    const groups = groupByChapter(tool.kcs);
    const own = groups.filter(g => g.chapter === q.chapter);
    const others = groups.filter(g => g.chapter !== q.chapter);

    const boxOf = (g) => {
        const box = el('div', 'mb-2');
        box.appendChild(el('p', 'mb-1 text-[11px] font-bold text-slate-500', { textContent: g.chapter }));
        for (const k of g.items) {
            const row = el('label', 'flex items-start gap-2 py-0.5 text-sm text-slate-700');
            const cb = el('input', 'mt-1', { type: 'checkbox', 'data-kc-id': String(k.id) });
            cb.checked = checked.has(k.id);
            cb.addEventListener('change', () => onPick(app, ui, cb));
            row.appendChild(cb);
            row.appendChild(el('span', '', { textContent: `${k.name}${k.status === 'approved' ? '' : '（草稿）'}`, title: k.code }));
            box.appendChild(row);
        }
        return box;
    };
    if (!own.length) t.picker.appendChild(el('p', 'mb-2 text-xs text-slate-400', { textContent: `「${q.chapter}」還沒有知識點；可以從同科其他章選。` }));
    for (const g of own) t.picker.appendChild(boxOf(g));
    if (others.length) {
        const more = el('details', 'mt-2');
        more.appendChild(el('summary', 'cursor-pointer text-xs font-bold text-slate-500', { textContent: `同科其他章（${others.length} 章）` }));
        for (const g of others) more.appendChild(boxOf(g));
        // 已勾到別章的知識點時預設展開，免得老師以為標註不見了
        if (others.some(g => g.items.some(k => checked.has(k.id)))) more.setAttribute('open', '');
        t.picker.appendChild(more);
    }
    updatePickCount(ui);
}

function checkedIds(ui) {
    return Array.from(ui.tool.picker.querySelectorAll('input'))
        .filter(i => i.checked)
        .map(i => Number(i.dataset.kcId));
}

function updatePickCount(ui) {
    const n = checkedIds(ui).length;
    ui.tool.count.textContent = `已選 ${n}／${MAX_QUESTION_KCS}`;
    ui.tool.save.disabled = !tool.detail;
}

function onPick(app, ui, cb) {
    if (cb.checked && checkedIds(ui).length > MAX_QUESTION_KCS) {
        cb.checked = false;
        app.showToast(`一題最多標 ${MAX_QUESTION_KCS} 個知識點。`, 'error');
    }
    updatePickCount(ui);
}

async function loadQuestion(app, ui) {
    const id = parseQuestionId(ui.tool.qid.value);
    if (id === null) { app.showToast('請輸入正整數題號。', 'error'); return; }
    ui.tool.load.disabled = true;
    try {
        const res = await fetchJson(app, `/api/questions/${id}/kcs?detail=1`);
        if (!res.ok) {
            tool.detail = null;
            renderQuestionTool(app, ui);
            app.showToast((res.body && res.body.message) || `讀取失敗（HTTP ${res.status}）`, 'error');
            return;
        }
        tool.detail = res.body;
        const r = await loadSubjectItems(app, res.body.question.subject);
        tool.kcs = r.ok ? r.items : [];
        if (!r.ok) app.showToast(r.message, 'error');
        renderQuestionTool(app, ui);
    } finally {
        ui.tool.load.disabled = false;
    }
}

async function saveQuestionKcs(app, ui) {
    const d = tool.detail;
    if (!d) return;
    const body = buildPutBody(checkedIds(ui), d.items);
    ui.tool.save.disabled = true;
    const res = await fetchJson(app, `/api/questions/${d.question.id}/kcs`, jsonOptions('PUT', body));
    if (!res.ok) {
        ui.tool.save.disabled = false;
        app.showToast((res.body && res.body.message) || `儲存失敗（HTTP ${res.status}）`, 'error');
        return;
    }
    tool.detail = { question: d.question, items: Array.isArray(res.body) ? res.body : [] };
    // 已標題數變了：這一科的清單下次要重抓
    state.bySubject.delete(d.question.subject);
    if (state.subject === d.question.subject) {
        const r = await loadSubjectItems(app, state.subject, true);
        if (r.ok) { state.items = r.items; renderList(app, ui); }
    }
    renderQuestionTool(app, ui);
    app.showToast(`已儲存題目 #${d.question.id} 的知識點（人工標註）。`, 'success');
}

// ───────────────────────── 版面 ─────────────────────────

function mountKcSection(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-5 flex items-start gap-3 border-b border-slate-100 pb-5');
    const titleBox = el('div');
    titleBox.append(
        el('p', 'eyebrow text-emerald-600', { textContent: 'Knowledge Components' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '知識點' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '比章節更細的診斷單位。逐張讀口語版（可按「朗讀」聽聽看），改到順口再按「審定通過」；審定過的內容，重新載入種子檔也不會被蓋掉。'
        })
    );
    head.append(el('span', 'section-icon bg-emerald-50 text-emerald-700', { textContent: '點' }), titleBox);

    const bar = el('div', 'mb-3 flex flex-wrap items-end gap-2');
    const sel = (id, label) => {
        const wrap = el('label', 'flex flex-col');
        wrap.appendChild(el('span', 'mb-1 text-[11px] font-bold text-slate-500', { textContent: label }));
        const s = el('select', 'field-control p-2 text-sm', { id, 'aria-label': label });
        wrap.appendChild(s);
        bar.appendChild(wrap);
        return s;
    };
    const ui = {
        subject: sel('kcSubject', '科目'),
        volume: sel('kcVolume', '冊'),
        chapter: sel('kcChapter', '章'),
        status: sel('kcStatus', '狀態')
    };
    ui.status.append(option('', '全部'), option('draft', '草稿'), option('approved', '已審定'));
    ui.refresh = el('button', 'rounded-xl border border-slate-200 px-4 py-2 text-sm font-extrabold text-slate-700 hover:bg-slate-50 cursor-pointer', {
        id: 'kcRefresh', type: 'button', textContent: '重新整理'
    });
    bar.appendChild(ui.refresh);

    ui.summary = el('p', 'mb-4 text-xs font-bold text-slate-500', { id: 'kcSummary' });
    ui.list = el('div', '', { id: 'kcList' });

    // 題目 → 知識點
    const toolBox = el('div', 'mt-8 rounded-2xl border border-slate-200 bg-slate-50/60 p-4', { id: 'kcTool' });
    toolBox.appendChild(el('h3', 'text-base font-extrabold text-slate-800', { textContent: '題目 → 知識點' }));
    toolBox.appendChild(el('p', 'mt-1 text-xs text-slate-500', {
        textContent: `輸入題號，勾選這一題考的知識點（同科、最多 ${MAX_QUESTION_KCS} 個）。存檔後是人工標註：之前的 AI 標註會被取代，之後的自動標註也不會再動它。`
    }));
    const row = el('div', 'mt-3 flex gap-2');
    const qid = el('input', 'field-control w-32 p-2 text-sm', { id: 'kcQid', type: 'text', inputmode: 'numeric', placeholder: '題號', 'aria-label': '題號' });
    const load = el('button', 'rounded-xl border border-slate-200 bg-white px-4 text-sm font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer', {
        id: 'kcQLoad', type: 'button', textContent: '載入'
    });
    row.append(qid, load);
    ui.tool = {
        qid, load,
        info: el('div', 'mt-3', { id: 'kcQInfo' }),
        current: el('div', 'mt-2 flex flex-wrap items-center gap-1.5', { id: 'kcQCurrent' }),
        picker: el('div', 'mt-3', { id: 'kcQPicker' }),
        count: el('p', 'mt-2 text-[11px] font-bold text-slate-500', { id: 'kcQCount' }),
        save: el('button', 'mt-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-extrabold text-white hover:bg-indigo-700 disabled:opacity-40 cursor-pointer', {
            id: 'kcQSave', type: 'button', textContent: '儲存標註'
        })
    };
    ui.tool.save.disabled = true;
    toolBox.append(row, ui.tool.info, ui.tool.current, ui.tool.picker, ui.tool.count, ui.tool.save);

    section.append(head, bar, ui.summary, ui.list, toolBox);

    ui.subject.addEventListener('change', () => selectSubject(app, ui, ui.subject.value));
    ui.volume.addEventListener('change', () => { state.volume = ui.volume.value; state.chapter = ''; renderToolbar(ui); renderList(app, ui); });
    ui.chapter.addEventListener('change', () => { state.chapter = ui.chapter.value; renderList(app, ui); });
    ui.status.addEventListener('change', () => { state.status = ui.status.value; renderList(app, ui); });
    ui.refresh.addEventListener('click', () => selectSubject(app, ui, state.subject, true));
    load.addEventListener('click', () => loadQuestion(app, ui));
    qid.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) loadQuestion(app, ui); });
    ui.tool.save.addEventListener('click', () => saveQuestionKcs(app, ui));
    return ui;
}

// ───────────────────────── 進入點 ─────────────────────────

/** 掛載。旗標關閉時**整段不渲染**（與階段 3／4 的分頁同一條規則）。 */
export async function init() {
    const section = document.getElementById('kc');
    if (!section) return;
    if (!kcEnabled()) {
        console.info('[kc] FEATURE_KC 未開啟：知識點分頁不渲染。');
        return;
    }
    const app = bridge();
    if (!app) return;
    const ui = mountKcSection(app, section);

    const res = await fetchJson(app, '/api/chapter-volumes');
    state.volumes = res.ok && res.body && typeof res.body === 'object' ? res.body : {};
    const subjects = Object.keys(state.volumes);
    ui.subject.innerHTML = '';
    for (const s of subjects) ui.subject.appendChild(option(s, s));
    if (!subjects.length) {
        ui.summary.textContent = '讀不到科目清單（/api/chapter-volumes），請重新整理頁面。';
        return;
    }
    await selectSubject(app, ui, subjects[0]);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}