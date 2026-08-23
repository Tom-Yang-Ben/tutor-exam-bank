// ─────────────────────────────────────────────────────────────
// public/js/nlq.js — 階段 3 的自然語言查題框（P-09）
//
// 契約：docs/interfaces-stage3.md 第 6 條（`POST /api/questions/search-nl` 的形狀、
//       `parse_path` 三值、`fallback_level` 四級與逐字凍結的 warning）
//       與第 7 條（橋接、旗標、插入點）。
//
// 這一頁只有一個產品主張：**老師要看得見機器把句子理解成什麼，並且能接手改。**
//
//   - 回來的 `filters` 一律回寫到題庫管理的三個下拉（`mgr_subject`／`mgr_chapter`／`mgr_type`），
//     所以「系統理解錯了」是一眼看得出來、而且兩秒就能手動修正的。
//   - `parse_path === 'llm_failed'` 或 `fallback_level >= 1` 時顯示**淡黃提示**，
//     而且提示裡要寫清楚「系統理解成什麼」與「為什麼退了一級」——
//     只說「查詢已降級」對老師沒有用，她還是不知道要不要重打一次。
//   - `score` 在 `fallback_level === 3`（LIKE 回退）時是 `null`。那不是 0 分，
//     是「這一輪沒有分數這回事」，所以顯示「—」而不是 0.0000。
//
// 回寫下拉時**不觸發 mgr_subject 的 change**：那條 handler 會 fillMgrChapters() 之後
// 立刻 fetchQuestions(1)，三個下拉各觸發一次就是三次查詢。改成自己用
// `ExamApp.getChapterWhitelist()` 重建章節選項（第 7.1 條的 getter 正是為此存在），
// 最後只觸發一次 change 讓題庫列表重查一次。
// ─────────────────────────────────────────────────────────────

const MAX_QUERY = 200;      // 第 6 條：query 最多 200 字
const LIMIT = 20;           // 第 6 條的 limit 預設

// 第 6.6 條的四級回退階梯。文字是「這一級代表什麼」的白話說明；
// 伺服器回來的 `warnings` 是**逐字凍結的原文**，兩者都要顯示（原文在前，說明在後）。
export const FALLBACK_NOTE = {
    0: null,
    1: 'LLM 沒有回應或回了不合 schema 的東西，這一輪只用規則解析的結果——條件可能比你講的少。',
    2: '照原本的條件一題都沒查到，系統已經自己放寬條件重查（先丟章節，再丟難度與題型）。',
    3: 'embedding 服務不可用，這一輪是純關鍵字比對（沒有語意檢索），相關度分數不適用。'
};

// 第 6 條的 parse_path 三值。
export const PARSE_PATH_LABEL = {
    rules: '規則解析（沒有花錢呼叫 LLM）',
    llm: 'LLM 輔助解析',
    llm_failed: 'LLM 解析失敗，只用規則'
};

// ───────────────────────── 橋接與旗標 ─────────────────────────

/**
 * 取得 index.html 掛上來的既有函式。
 * @returns {object|null}
 */
function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[nlq] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來（interfaces-stage3.md 第 7.1 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[nlq] window.ExamApp 缺少：${missing.join('、')}。查題框不會掛載。`);
        return null;
    }
    if (typeof app.getChapterWhitelist !== 'function') {
        console.warn('[nlq] window.ExamApp 缺少 getChapterWhitelist（第 7.1 條）：章節下拉的回寫會退化成「只設值不補選項」。');
    }
    return app;
}

/**
 * 布林旗標的解讀，與後端 config/features.js 的 parseBool 逐字相同（interfaces.md 第 9 條）。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** @returns {boolean} FEATURE_NLQ 是否開啟 */
function nlqEnabled() {
    const meta = document.querySelector('meta[name="feature-nlq"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('nlq') === '1';
}

/** @returns {boolean} 是否走本檔內的手寫假資料 */
function mockEnabled() {
    return new URLSearchParams(location.search).get('mock') === '1';
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * 把 `filters` 講成一句人話：「系統理解成什麼」。
 *
 * 八個鍵**一律出現**（第 6 條），沒抓到的是 `null`／`[]`／`''`。這裡刻意把
 * 「沒抓到」也講出來（「不分科」「不限章節」），因為老師需要知道的是
 * **系統少理解了什麼**，而不只是它理解到了什麼。
 *
 * @param {object} filters
 * @returns {string}
 */
export function explainFilters(filters) {
    const f = filters || {};
    const parts = [];
    parts.push(f.subject ? `學科：${f.subject}` : '學科：不分科');
    parts.push(Array.isArray(f.chapters) && f.chapters.length
        ? `章節：${f.chapters.join('、')}` : '章節：不限');
    parts.push(Array.isArray(f.question_types) && f.question_types.length
        ? `題型：${f.question_types.join('、')}` : '題型：不限');

    const lo = f.difficulty_min, hi = f.difficulty_max;
    if (lo === null || lo === undefined) {
        parts.push('難度：不限');
    } else if (lo === hi) {
        parts.push(`難度：${lo}`);
    } else {
        parts.push(`難度：${lo}~${hi}`);
    }

    if (f.exclude_student_name) parts.push(`排除「${f.exclude_student_name}」寫過的題`);
    if (f.semantic_text) parts.push(`語意查詢：「${f.semantic_text}」`);
    return parts.join('；');
}

/**
 * 決定提示條的樣式與內容。
 *
 * 觸發條件是第 7 條交派的原話：**`parse_path === 'llm_failed'` 或 `fallback_level >= 1`**
 * 就要顯示淡黃提示。`fallback_level === 0` 且 `parse_path` 正常時是中性的灰底說明條
 * （仍然要顯示「理解成什麼」——那是這個功能的重點，不是異常時才需要的東西）。
 *
 * @param {{parse_path:string, fallback_level:number, warnings:string[]}} body
 * @returns {{tone:'amber'|'slate', lines:string[]}}
 */
export function fallbackNotice(body) {
    const level = Number(body && body.fallback_level) || 0;
    const path = (body && body.parse_path) || 'rules';
    const warnings = (body && Array.isArray(body.warnings)) ? body.warnings : [];
    const amber = path === 'llm_failed' || level >= 1;

    const lines = [];
    // 伺服器的 warning 字串是逐字凍結的（第 6.6 條），原樣顯示，不重寫、不翻譯。
    for (const w of warnings) lines.push(w);
    if (FALLBACK_NOTE[level]) lines.push(FALLBACK_NOTE[level]);
    if (path === 'llm_failed' && level < 1) {
        // 理論上 llm_failed 一定伴隨 level 1；真的落在這裡代表後端有 bug，講出來別吞掉。
        lines.push(FALLBACK_NOTE[1]);
    }
    return { tone: amber ? 'amber' : 'slate', lines };
}

/**
 * `score` 的顯示。`fallback_level === 3` 時後端一律回 `null`——
 * 那是「這一輪沒有分數這回事」，不是 0 分。
 * @param {number|null|undefined} score
 * @returns {string}
 */
export function formatScore(score) {
    if (score === null || score === undefined || Number.isNaN(score)) return '—';
    return Number(score).toFixed(4);
}

/**
 * 決定三個下拉要被寫成什麼。
 *
 * 題庫管理只有**單一**章節與**單一**題型的下拉，而 `filters.chapters`／`question_types`
 * 是陣列（第 6.4 條最多 3 章）。凍結為「取第一個」，其餘的在提示條裡列出來——
 * 悄悄丟掉條件比顯示不完整更糟。
 *
 * @param {object} filters
 * @returns {{subject:string, chapter:string, question_type:string, dropped:string[]}}
 */
export function dropdownWriteback(filters) {
    const f = filters || {};
    const chapters = Array.isArray(f.chapters) ? f.chapters : [];
    const types = Array.isArray(f.question_types) ? f.question_types : [];
    const dropped = [];
    if (chapters.length > 1) dropped.push(`章節只回寫第一個「${chapters[0]}」，另外 ${chapters.length - 1} 個（${chapters.slice(1).join('、')}）下拉放不下`);
    if (types.length > 1) dropped.push(`題型只回寫第一個「${types[0]}」，另外 ${types.length - 1} 個（${types.slice(1).join('、')}）下拉放不下`);
    if (f.difficulty_min !== null && f.difficulty_min !== undefined) dropped.push('題庫管理沒有難度下拉，難度條件只在這條提示裡');
    if (f.exclude_student_name) dropped.push(`題庫管理沒有「排除某生寫過」的下拉，這個條件只作用在下面的查詢結果`);
    return {
        subject: f.subject || '',
        chapter: chapters[0] || '',
        question_type: types[0] || '',
        dropped
    };
}

// ───────────────────────── 手寫 mock（只有 ?mock=1 讀得到）─────────────────────────

const MOCK = {
    // 三種情境輪流回（規則命中／LLM 失敗＋回退 1／embedding 掛掉＋回退 3），
    // 讓三條提示路徑都做得出版面。
    rounds: [
        {
            filters: {
                subject: '物理', chapters: ['牛頓運動定律', '摩擦力與向心力'], question_types: ['計算'],
                difficulty_min: 4, difficulty_max: 5, exclude_student_name: null,
                semantic_text: '牛頓第二定律 摩擦力', keywords: ['牛頓第二定律', '摩擦力']
            },
            parse_path: 'rules', fallback_level: 0, warnings: [],
            results: [
                { id: 87, subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 4, question_text: '質量 $3$ kg 的物體在動摩擦係數 $0.2$ 的水平面上受 $12$ N 水平力，求加速度。', score: 0.0325 },
                { id: 91, subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 5, question_text: '半徑 $2$ m 的圓周上，靜摩擦係數 $0.4$，求不打滑的最大速率。', score: 0.0298 }
            ]
        },
        {
            filters: {
                subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null,
                exclude_student_name: null, semantic_text: '有點難的能量守恆題', keywords: []
            },
            parse_path: 'llm_failed', fallback_level: 1,
            warnings: ['LLM 解析逾時或不合 schema，只用規則解析的結果。'],
            results: [
                { id: 112, subject: '物理', chapter: '功與能量', question_type: '計算', difficulty: 4, question_text: '光滑軌道上，物體自 $h=1.8$ m 滑下，求底端速率。', score: 0.0244 }
            ]
        },
        {
            filters: {
                subject: '數學', chapters: ['向量內積'], question_types: [], difficulty_min: null, difficulty_max: null,
                exclude_student_name: '示範學生 A', semantic_text: '內積', keywords: ['內積']
            },
            parse_path: 'rules', fallback_level: 3,
            warnings: ['embedding 服務不可用，改用關鍵字 LIKE 檢索。'],
            results: [
                { id: 12, subject: '數學', chapter: '向量內積', question_type: '填空', difficulty: 3, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。', score: null }
            ]
        }
    ],
    at: 0
};

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
    if (url === '/api/questions/search-nl') {
        const body = MOCK.rounds[MOCK.at % MOCK.rounds.length];
        MOCK.at += 1;
        return mockResponse(body);
    }
    return mockResponse({ message: `mock 沒有覆蓋 ${url}` }, 501);
}

// ───────────────────────── DOM 小工具 ─────────────────────────

function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(props || {})) {
        if (k.includes('-')) node.setAttribute(k, String(v));
        else node[k] = v;
    }
    return node;
}

// ───────────────────────── 回寫三個下拉 ─────────────────────────

/**
 * 把 `filters` 回寫到題庫管理的三個下拉。
 *
 * 章節選項由 `ExamApp.getChapterWhitelist()` 自己重建（與 index.html 的 fillMgrChapters
 * 同一份資料來源），因此**不必**觸發 `mgr_subject` 的 change——那條 handler 會順便
 * fetchQuestions(1)，三個下拉各觸發一次就是三次查詢。最後只對 `mgr_type` 觸發一次 change，
 * 讓題庫列表照使用者看得見的新條件重查一次。
 *
 * @param {object} app
 * @param {object} filters
 */
function writeBackDropdowns(app, filters) {
    const want = dropdownWriteback(filters);
    const subjectSel = document.getElementById('mgr_subject');
    const chapterSel = document.getElementById('mgr_chapter');
    const typeSel = document.getElementById('mgr_type');
    if (!subjectSel || !chapterSel || !typeSel) return want;

    subjectSel.value = want.subject;

    const whitelist = typeof app.getChapterWhitelist === 'function' ? (app.getChapterWhitelist() || {}) : {};
    const list = want.subject
        ? (whitelist[want.subject] || [])
        : [...(whitelist['數學'] || []), ...(whitelist['物理'] || [])];
    chapterSel.innerHTML = '';
    chapterSel.appendChild(el('option', '', { value: '', textContent: '全部章節' }));
    for (const c of list) chapterSel.appendChild(el('option', '', { value: c, textContent: c }));
    // 白名單還沒載進來（loadChapterWhitelist 失敗）時仍要能選到伺服器給的章節，
    // 否則回寫會靜默失效——補一個 option 比什麼都不做誠實。
    if (want.chapter && !list.includes(want.chapter)) {
        chapterSel.appendChild(el('option', '', { value: want.chapter, textContent: `${want.chapter}（白名單未載入）` }));
    }
    chapterSel.value = want.chapter;
    typeSel.value = want.question_type;

    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    return want;
}

// ───────────────────────── 版面 ─────────────────────────

const TONE_CLASS = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-600'
};

/**
 * 渲染一次查詢的結果（提示條 + 結果清單）。
 * @param {object} app
 * @param {HTMLElement} host
 * @param {object} body   POST /api/questions/search-nl 的 200 回應
 * @param {object} writeback dropdownWriteback 的回傳
 */
function renderAnswer(app, host, body, writeback) {
    host.innerHTML = '';

    const notice = fallbackNotice(body);
    const bar = el('div', `rounded-xl border px-3 py-2.5 text-xs leading-5 ${TONE_CLASS[notice.tone]}`);
    bar.appendChild(el('p', 'font-extrabold', {
        textContent: `系統理解成：${explainFilters(body.filters)}`
    }));
    bar.appendChild(el('p', 'mt-1 opacity-80', {
        textContent: `解析路徑：${PARSE_PATH_LABEL[body.parse_path] || body.parse_path}　·　回退等級 ${body.fallback_level}`
    }));
    for (const line of notice.lines) {
        bar.appendChild(el('p', 'mt-1 font-bold', { textContent: `⚠ ${line}` }));
    }
    for (const line of (writeback && writeback.dropped) || []) {
        bar.appendChild(el('p', 'mt-1 opacity-70', { textContent: `· ${line}` }));
    }
    bar.appendChild(el('p', 'mt-1 opacity-70', {
        textContent: '理解錯了就直接改上面題庫管理的下拉，或換個講法再問一次。'
    }));
    host.appendChild(bar);

    const results = Array.isArray(body.results) ? body.results : [];
    const head = el('p', 'mt-3 mb-2 eyebrow text-indigo-400', {
        textContent: `查詢結果（${results.length} 題）`
    });
    host.appendChild(head);
    if (results.length === 0) {
        host.appendChild(el('p', 'rounded-xl border border-slate-200 bg-white px-3 py-5 text-center text-sm text-slate-500', {
            textContent: '沒有查到題目。可以把條件講寬一點，或直接用上面的下拉手動篩選。'
        }));
        return;
    }
    const list = el('div', 'space-y-2');
    for (const r of results) {
        const card = el('div', 'rounded-xl border border-slate-100 bg-white p-3');
        card.appendChild(el('p', 'text-[11px] font-bold text-slate-400', {
            textContent: `#${r.id}　·　${r.subject}／${r.chapter}　·　${r.question_type}　·　${'★'.repeat(r.difficulty || 0)}　·　score ${formatScore(r.score)}`
        }));
        const stem = el('p', 'mt-1 text-sm text-slate-700');
        stem.textContent = r.question_text || '';
        card.appendChild(stem);
        app.renderMath(stem);
        list.appendChild(card);
    }
    host.appendChild(list);
}

/**
 * 建立 <section id="nlq"> 裡的骨架（index.html 只放一個空的錨點）。
 * @param {object} app
 * @param {HTMLElement} section
 */
function mountNlqSection(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-4 flex items-start gap-3');
    const box = el('div');
    box.append(
        el('p', 'eyebrow text-indigo-500', { textContent: 'Natural language search' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '用講的找題目' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '例：「牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過」。理解到的條件會回寫到下面題庫管理的下拉。'
        })
    );
    head.append(el('span', 'section-icon bg-indigo-50 text-indigo-700', { textContent: '問' }), box);

    const row = el('div', 'flex flex-col gap-2 sm:flex-row');
    const input = el('input', 'field-control block w-full p-3 text-sm', {
        id: 'nlqInput', type: 'text', maxLength: MAX_QUERY,
        placeholder: `用一句話描述你要的題目（最多 ${MAX_QUERY} 字）`
    });
    const btn = el('button', 'shrink-0 rounded-xl bg-slate-900 px-5 py-3 text-sm font-extrabold text-white transition-all hover:bg-indigo-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', {
        type: 'button', id: 'nlqBtn', textContent: '查題'
    });
    row.append(input, btn);

    const answer = el('div', 'mt-4', { id: 'nlqAnswer' });
    section.append(head, row, answer);

    const run = () => search(app, input, btn, answer).catch(err => console.error('[nlq] 查詢失敗', err));
    btn.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

/**
 * 送一次查詢。
 * @param {object} app
 * @param {HTMLInputElement} input
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} answer
 */
async function search(app, input, btn, answer) {
    const query = input.value.trim();
    if (!query) { app.showToast('請先輸入一句話。', 'error'); return; }
    if (query.length > MAX_QUERY) { app.showToast(`query 最多 ${MAX_QUERY} 字。`, 'error'); return; }

    btn.disabled = true;
    answer.innerHTML = '';
    answer.appendChild(el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500', {
        textContent: '查詢中…'
    }));
    try {
        const res = await request(app, '/api/questions/search-nl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: LIMIT })
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            answer.innerHTML = '';
            answer.appendChild(el('p', `rounded-xl border px-3 py-4 text-sm ${TONE_CLASS.amber}`, {
                // 404 代表 WS-C 的端點還沒合入，不是前端壞掉——講清楚。
                textContent: res.status === 404
                    ? '自然語言查題尚未上線（POST /api/questions/search-nl 回 404）。可加上 ?mock=1 用手寫假資料預覽版面。'
                    : (body.message || `查詢失敗（HTTP ${res.status}）`)
            }));
            return;
        }
        const body = await res.json();
        const writeback = writeBackDropdowns(app, body.filters);
        renderAnswer(app, answer, body, writeback);
    } catch {
        answer.innerHTML = '';
        answer.appendChild(el('p', `rounded-xl border px-3 py-4 text-sm ${TONE_CLASS.amber}`, {
            textContent: '連線失敗，請稍後再試。'
        }));
    } finally {
        btn.disabled = false;
    }
}

// ───────────────────────── 進入點 ─────────────────────────

/** 掛載。旗標關閉時**整段不渲染**（第 7.2 條）。 */
export function init() {
    const section = document.getElementById('nlq');
    if (!section) return;
    if (!nlqEnabled()) {
        console.info('[nlq] FEATURE_NLQ 未開啟：查題框不渲染（interfaces-stage3.md 第 7.2 條）。');
        return;
    }
    const app = bridge();
    if (!app) return;
    mountNlqSection(app, section);
}

// 自動掛載只在瀏覽器裡發生（沒有 document 的 Node 裡 import 本檔不該爆）。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
