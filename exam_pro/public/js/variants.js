// ─────────────────────────────────────────────────────────────
// public/js/variants.js — 階段 3 的相似題／變式題分頁（P-13）
//
// 契約：docs/interfaces-stage3.md 第 3 條（`POST /api/questions/:id/variants` 的
//       200 `retrieved`／202 `generating` 兩個分支、錯誤字串、合流的 `existing`）、
//       第 7 條（橋接、旗標、插入點）、第 11 條（`GET /api/jobs/:id` 形狀不變）
//       與 docs/interfaces.md 第 6 條（`GET /api/questions/:id/similar`）。
//
// 這一頁要說清楚的三件事（規劃 §4.4「先檢索、再生成、生成也走同一組閘門」）：
//
//   1. **有沒有花錢**。200 `mode:'retrieved'` 是庫裡就有、零 LLM 費用；
//      202 `mode:'generating'` 才是真的在付錢生成。兩者的版面刻意長得不一樣。
//   2. **每一題現在卡在哪一關**。變式題與拆題走**同一條狀態機**，所以每題的 chip
//      直接對應 `job_questions.state`（interfaces-stage2.md 第 2.1 條的九個值）：
//      生成中 → 檢查中 → 已入庫／待核准／失敗。
//   3. **實際花了多少**。完成時顯示 `GET /api/jobs/:id` 回來的 `cost_usd`（第 6.2 條），
//      不是預估值、不是預算值。
//
// 兩個刻意的行為：
//
//   - **輪詢期間按鈕停用**。同一藍本的重複請求後端會合流（裁決 S3-8，回 `existing:true`），
//     但那是後端的最後一道保險；前端本來就不該讓人連按五次。
//   - **待核准不自動入庫**。`VARIANT_AUTO_APPROVE=false` 時全部閘門過了仍停在
//     `needs_review('awaiting_approval')`（第 4.7 條）。這裡只提示「去複核分頁核准」，
//     不在這一頁做核准——複核有既有的完整介面（review.js），複製一份只會走味。
// ─────────────────────────────────────────────────────────────

const POLL_MS = 2000;        // 第 3.2 條：每 2 秒輪詢一次
const POLL_MAX_MS = 60000;   // 第 3.2 條：最多 60 秒
const SIMILAR_K = 5;         // 「找相似」一次看 5 題就夠了（interfaces.md 第 6 條的 k）

// students.js 發的事件（兩邊各自宣告同一個字串，避免互相 import——
// 兩個 module 因此都能被 data: URL 載入做單元測試）。
export const VARIANT_EVENT = 'examapp:variant-request';

// `job_questions.state` 的九個值（interfaces-stage2.md 第 2.1 條）→ chip。
// 六個中間狀態刻意**不逐一顯示節點名**：老師要知道的是「還在跑」還是「停下來了」，
// 「這題卡在 dedup1」對她沒有意義（那是 job 詳情頁的事）。
export const STATE_CHIP = {
    extracted: { label: '生成中', tone: 'indigo' },
    hashed: { label: '檢查中', tone: 'indigo' },
    classified: { label: '檢查中', tone: 'indigo' },
    linted: { label: '檢查中', tone: 'indigo' },
    verified: { label: '檢查中', tone: 'indigo' },
    deduped: { label: '檢查中', tone: 'indigo' },
    saved: { label: '已入庫', tone: 'emerald' },
    needs_review: { label: '待核准', tone: 'amber' },
    rejected: { label: '失敗', tone: 'rose' }
};

// 第 2 條的八個 review_reason → 一句話。與 review.js 的 REASON_LABEL 同一組字，
// 這裡只需要標籤（詳細的那一句由複核分頁負責，不在這裡重講一次）。
export const REASON_LABEL = {
    chapter_invalid: '章節不在白名單',
    formula_unparsable: '公式無法解析',
    answer_mismatch: '答案對不上',
    duplicate: '與既有題目重複',
    schema_invalid: '欄位不合格',
    budget_exceeded: '超出成本上限',
    provider_error: '供應商錯誤',
    awaiting_approval: '等待人工確認'
};

const TONE_CLASS = {
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    slate: 'border-slate-200 bg-slate-50 text-slate-700'
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
        console.error('[variants] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來（interfaces-stage3.md 第 7.1 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[variants] window.ExamApp 缺少：${missing.join('、')}。變式分頁不會掛載。`);
        return null;
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

/** @returns {boolean} FEATURE_VARIANTS 是否開啟 */
function variantsEnabled() {
    const meta = document.querySelector('meta[name="feature-variants"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('variants') === '1';
}

/** @returns {boolean} 是否走本檔內的手寫假資料 */
function mockEnabled() {
    return new URLSearchParams(location.search).get('mock') === '1';
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * 一列 `job_questions` → chip 的文字與色調。
 *
 * `needs_review` 分兩種，而且**分得很重要**：
 *   - `awaiting_approval` = 六個閘門全過、只差老師點頭（第 4.7 條的政策停等）。
 *   - 其他七個 reason = 真的有東西不對，要看原因。
 * 兩者都停在同一個 state，把它們顯示成同一句話會讓「等你點頭」看起來像「壞了」。
 *
 * @param {{state:string, review_reason:string|null}} row
 * @returns {{label:string, tone:string, detail:string}}
 */
export function chipFor(row) {
    const state = (row && row.state) || '';
    const reason = (row && row.review_reason) || null;
    const base = STATE_CHIP[state];
    if (!base) return { label: state || '未知', tone: 'slate', detail: '' };

    if (state === 'needs_review') {
        if (reason === 'awaiting_approval') {
            return { label: '待核准', tone: 'amber', detail: '六個閘門都過了，等你到複核分頁點頭才入庫。' };
        }
        return {
            label: `待複核（${REASON_LABEL[reason] || reason || '原因不明'}）`,
            tone: 'rose',
            detail: '這一題有閘門判定不通過，到複核分頁看機器產生的具體原因。'
        };
    }
    if (state === 'rejected') {
        return {
            label: `失敗（${REASON_LABEL[reason] || reason || '已標記不採用'}）`,
            tone: 'rose',
            detail: '這一題不會入庫。'
        };
    }
    return { ...base, detail: '' };
}

/**
 * job 還在跑嗎。`done`／`failed` 是終態（interfaces-stage2.md 第 2.1 條）。
 * @param {string} state
 * @returns {boolean}
 */
export function jobRunning(state) {
    return state !== 'done' && state !== 'failed';
}

/**
 * `cost_usd` 的顯示。第 6.2 條保證它是 number（controller 已經 Number() 過），
 * 但 job 剛建立時可能是 0——0 要顯示成 $0.0000，不是「—」。
 * @param {number|null|undefined} cost
 * @returns {string}
 */
export function formatCost(cost) {
    if (cost === null || cost === undefined || Number.isNaN(Number(cost))) return '—';
    return `$${Number(cost).toFixed(4)}`;
}

/**
 * 把 202 之後的輪詢結果彙整成一句給人看的話。
 * @param {object} job GET /api/jobs/:id 的回應
 * @returns {string}
 */
export function jobSummary(job) {
    const c = (job && job.counts) || {};
    if (job.state === 'queued') return '已排隊，等待 worker 認領。';
    if (job.state === 'extracting') return '正在生成變式題，還沒開始逐題檢查。';
    if (job.state === 'failed') return `任務失敗：${job.error || '（沒有錯誤訊息）'}`;
    return `已入庫 ${c.saved ?? 0}／待複核 ${c.needs_review ?? 0}／處理中 ${c.pending ?? 0}` +
        (c.rejected ? `／不採用 ${c.rejected}` : '');
}

// ───────────────────────── 手寫 mock（只有 ?mock=1 讀得到）─────────────────────────

const MOCK = {
    similar: {
        source_id: 87, mode: 'hybrid',
        results: [
            { id: 12, subject: '數學', chapter: '向量內積', question_type: '填空', difficulty: 3, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。', score: 0.0325 },
            { id: 103, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 2, question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。', score: 0.0298 }
        ]
    },
    // 第一次按「出變式」回 202（示範輪詢），之後 job 會依序走完三個快照。
    variants202: { mode: 'generating', job_id: 57, state: 'queued', existing: false },
    jobs: [
        { id: 57, state: 'queued', counts: { saved: 0, needs_review: 0, pending: 0, rejected: 0 }, token_in: 0, token_out: 0, cost_usd: 0, budget_usd: 0.3, elapsed_ms: 900 },
        { id: 57, state: 'processing', counts: { saved: 0, needs_review: 0, pending: 2, rejected: 0 }, token_in: 3120, token_out: 980, cost_usd: 0.0141, budget_usd: 0.3, elapsed_ms: 6400 },
        { id: 57, state: 'done', counts: { saved: 0, needs_review: 1, pending: 0, rejected: 1 }, token_in: 6210, token_out: 2044, cost_usd: 0.0288, budget_usd: 0.3, elapsed_ms: 15800 }
    ],
    jobQuestions: [
        { total: 0, page: 1, limit: 20, items: [] },
        {
            total: 2, page: 1, limit: 20, items: [
                { jq_id: 901, idx: 1, state: 'classified', review_reason: null, stem_preview: '設 $\\vec{a}=(2,3)$、$\\vec{b}=(6,k)$ 互相垂直，求 $k$。', question_id: null },
                { jq_id: 902, idx: 2, state: 'linted', review_reason: null, stem_preview: '設 $\\vec{a}=(4,1)$、$\\vec{b}=(2,k)$ 互相垂直，求 $k$。', question_id: null }
            ]
        },
        {
            total: 2, page: 1, limit: 20, items: [
                { jq_id: 901, idx: 1, state: 'needs_review', review_reason: 'awaiting_approval', stem_preview: '設 $\\vec{a}=(2,3)$、$\\vec{b}=(6,k)$ 互相垂直，求 $k$。', question_id: null },
                { jq_id: 902, idx: 2, state: 'rejected', review_reason: 'duplicate', stem_preview: '設 $\\vec{a}=(4,1)$、$\\vec{b}=(2,k)$ 互相垂直，求 $k$。', question_id: null }
            ]
        }
    ],
    tick: 0
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

    const method = (options && options.method) || 'GET';
    const path = url.split('?')[0];
    if (method === 'GET' && /^\/api\/questions\/\d+\/similar$/.test(path)) return mockResponse(MOCK.similar);
    if (method === 'POST' && /^\/api\/questions\/\d+\/variants$/.test(path)) {
        MOCK.tick = 0;
        return mockResponse(MOCK.variants202, 202);
    }
    if (method === 'GET' && /^\/api\/jobs\/\d+\/questions$/.test(path)) {
        return mockResponse(MOCK.jobQuestions[Math.min(MOCK.tick, MOCK.jobQuestions.length - 1)]);
    }
    if (method === 'GET' && /^\/api\/jobs\/\d+$/.test(path)) {
        const snap = MOCK.jobs[Math.min(MOCK.tick, MOCK.jobs.length - 1)];
        MOCK.tick += 1;
        return mockResponse(snap);
    }
    return mockResponse({ message: `mock 沒有覆蓋 ${method} ${url}` }, 501);
}

// ───────────────────────── DOM 小工具 ─────────────────────────

function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(props || {})) {
        if (k.includes('-') || k === 'role') node.setAttribute(k, String(v));
        else node[k] = v;
    }
    return node;
}

async function messageOf(res) {
    const body = await res.json().catch(() => ({}));
    return body.message || `HTTP ${res.status}`;
}

/** 目前這一頁上所有會送出請求的按鈕（輪詢期間一律停用） */
function actionButtons() {
    return [...document.querySelectorAll('[data-variant-action]')];
}

/** @param {boolean} disabled */
function setActionsDisabled(disabled) {
    for (const b of actionButtons()) b.disabled = disabled;
}

// ───────────────────────── 版面 ─────────────────────────

/**
 * 一張題目卡（相似題與變式題共用）。
 * @param {object} app
 * @param {{id?:number, jq_id?:number, subject?:string, chapter?:string, question_type?:string,
 *          difficulty?:number, question_text?:string, stem_preview?:string, score?:number}} q
 * @param {{label:string, tone:string, detail:string}} [chip]
 * @returns {HTMLElement}
 */
function questionCard(app, q, chip) {
    const card = el('div', 'rounded-xl border border-slate-100 bg-white p-3');
    const meta = [
        q.id !== undefined && q.id !== null ? `#${q.id}` : (q.jq_id ? `jq #${q.jq_id}` : ''),
        q.chapter ? `${q.subject ? `${q.subject}／` : ''}${q.chapter}` : '',
        q.question_type || '',
        q.difficulty ? '★'.repeat(q.difficulty) : '',
        typeof q.score === 'number' ? `score ${q.score.toFixed(4)}` : ''
    ].filter(Boolean).join('　·　');

    const headRow = el('div', 'flex flex-wrap items-center justify-between gap-2');
    headRow.appendChild(el('p', 'text-[11px] font-bold text-slate-400', { textContent: meta }));
    if (chip) {
        headRow.appendChild(el('span', `rounded-full border px-2 py-0.5 text-[11px] font-extrabold ${TONE_CLASS[chip.tone] || TONE_CLASS.slate}`, {
            textContent: chip.label
        }));
    }
    card.appendChild(headRow);

    const stem = el('p', 'mt-1 text-sm text-slate-700');
    stem.textContent = q.question_text || q.stem_preview || '';
    card.appendChild(stem);
    app.renderMath(stem);

    if (chip && chip.detail) {
        card.appendChild(el('p', 'mt-1 text-[11px] text-slate-500', { textContent: chip.detail }));
    }
    return card;
}

/**
 * 建立 <section id="variants"> 裡的骨架（index.html 只放一個空的錨點）。
 * @param {HTMLElement} section
 */
function mountVariantsSection(section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-4 flex items-start gap-3');
    const box = el('div');
    box.append(
        el('p', 'eyebrow text-violet-500', { textContent: 'Similar & variants' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '相似題與變式題' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '從學生分頁的「最近錯題」按「找相似」或「出變式」。先找庫裡有的（零費用），池不足才生成，生成一律走與拆題相同的閘門。'
        })
    );
    head.append(el('span', 'section-icon bg-violet-50 text-violet-700', { textContent: '變' }), box);

    const body = el('div', '', { id: 'varBody' });
    body.appendChild(el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500', {
        textContent: '還沒有任何請求。到上面的「學生」分頁，在最近錯題那一列按「找相似」或「出變式」。'
    }));
    section.append(head, body);
}

/** @returns {HTMLElement|null} */
function bodyNode() {
    return document.getElementById('varBody');
}

/**
 * 換掉整個面板的內容並回傳新的容器。
 * @param {object} detail 事件的 detail
 * @param {string} title
 * @returns {{host:HTMLElement, slot:HTMLElement}|null}
 */
function resetPanel(detail, title) {
    const body = bodyNode();
    if (!body) return null;
    body.innerHTML = '';
    const head = el('div', 'rounded-xl border border-slate-200 bg-slate-50 p-3');
    head.append(
        el('p', 'text-xs font-extrabold text-slate-700', { textContent: title }),
        el('p', 'mt-1 text-[11px] text-slate-500', {
            textContent: `藍本 #${detail.question_id}${detail.chapter ? `　·　${detail.chapter}` : ''}`
        })
    );
    const stem = el('p', 'mt-1 text-xs text-slate-600');
    stem.textContent = detail.question_text || '';
    head.appendChild(stem);

    const slot = el('div', 'mt-3');
    body.append(head, slot);
    return { host: body, slot };
}

// ───────────────────────── 找相似（零費用）─────────────────────────

/**
 * `GET /api/questions/:id/similar`：只讀庫內既有題，不會產生任何 LLM 費用。
 * @param {object} app
 * @param {object} detail
 */
async function findSimilar(app, detail) {
    const panel = resetPanel(detail, '找相似（庫內既有題，零 LLM 費用）');
    if (!panel) return;
    panel.slot.textContent = '查詢中…';

    const params = new URLSearchParams({ k: String(SIMILAR_K) });
    if (detail.student_id) params.set('student_id', String(detail.student_id));
    let res;
    try {
        res = await request(app, `/api/questions/${detail.question_id}/similar?${params.toString()}`);
    } catch {
        panel.slot.textContent = '連線失敗，請稍後再試。';
        return;
    }
    if (!res.ok) {
        panel.slot.innerHTML = '';
        panel.slot.appendChild(el('p', `rounded-xl border px-3 py-4 text-sm ${TONE_CLASS.amber}`, {
            // 404 有兩種可能：FEATURE_SIMILAR 沒開（路由不掛載）或題目不存在／已封存。
            // 兩者對老師的下一步不同，所以講清楚是哪一種可能。
            textContent: res.status === 404
                ? '找不到這一題，或 FEATURE_SIMILAR 未開啟（路由不掛載時同樣回 404）。'
                : await messageOf(res)
        }));
        return;
    }
    const body = await res.json();
    const results = Array.isArray(body.results) ? body.results : [];
    panel.slot.innerHTML = '';
    panel.slot.appendChild(el('p', 'eyebrow mb-2 text-indigo-400', { textContent: `庫內相似題（${results.length} 題）` }));
    if (results.length === 0) {
        panel.slot.appendChild(el('p', 'rounded-xl border border-slate-200 bg-white px-3 py-5 text-center text-sm text-slate-500', {
            textContent: '庫裡沒有夠像的題目。可以改用「出變式」讓系統生成（會花錢）。'
        }));
        return;
    }
    const list = el('div', 'space-y-2');
    for (const q of results) list.appendChild(questionCard(app, q));
    panel.slot.appendChild(list);
}

// ───────────────────────── 出變式（可能要生成、可能要花錢）─────────────────────────

let pollTimer = null;

/** 停止輪詢並把按鈕解鎖。 */
function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    setActionsDisabled(false);
}

/**
 * `POST /api/questions/:id/variants`：
 *   200 `retrieved` → 庫裡就有，直接顯示，零費用。
 *   202 `generating` → 每 2 秒輪詢 `GET /api/jobs/:id`，最多 60 秒。
 * @param {object} app
 * @param {object} detail
 */
async function requestVariants(app, detail) {
    const panel = resetPanel(detail, '出變式（先檢索，池不足才生成）');
    if (!panel) return;
    panel.slot.textContent = '請求中…';
    setActionsDisabled(true);

    let res;
    try {
        res = await request(app, `/api/questions/${detail.question_id}/variants`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                count: 2,
                difficulty_delta: 0,
                student_id: detail.student_id || null,
                force_generate: false
            })
        });
    } catch {
        panel.slot.textContent = '連線失敗，請稍後再試。';
        setActionsDisabled(false);
        return;
    }

    if (!res.ok) {
        const msg = res.status === 404
            ? '找不到這一題，或 FEATURE_VARIANTS 未開啟（路由不掛載時同樣回 404）。'
            : await messageOf(res);
        panel.slot.innerHTML = '';
        panel.slot.appendChild(el('p', `rounded-xl border px-3 py-4 text-sm ${TONE_CLASS.amber}`, { textContent: msg }));
        setActionsDisabled(false);
        return;
    }

    const body = await res.json();
    if (body.mode === 'retrieved') {
        const questions = Array.isArray(body.questions) ? body.questions : [];
        panel.slot.innerHTML = '';
        panel.slot.appendChild(el('p', `rounded-xl border px-3 py-2.5 text-xs font-bold ${TONE_CLASS.emerald}`, {
            textContent: `庫裡就有 ${questions.length} 題夠像的，沒有生成、沒有花錢（mode: retrieved）。`
        }));
        const list = el('div', 'mt-2 space-y-2');
        for (const q of questions) list.appendChild(questionCard(app, q));
        panel.slot.appendChild(list);
        setActionsDisabled(false);
        return;
    }

    // 202：真的要生成了。
    panel.slot.innerHTML = '';
    const statusBar = el('div', `rounded-xl border px-3 py-2.5 text-xs font-bold ${TONE_CLASS.indigo}`);
    statusBar.textContent = body.existing
        // 裁決 S3-8：同一藍本已有未完成的 job 會合流，不會重複付費——這件事要讓人看見。
        ? `這題已經在生成中了，接回任務 #${body.job_id}（沒有重複付費）。`
        : `已建立任務 #${body.job_id}，每 ${POLL_MS / 1000} 秒更新一次進度（最多 ${POLL_MAX_MS / 1000} 秒）。`;
    const chips = el('div', 'mt-3 space-y-2');
    const tail = el('p', 'mt-3 text-[11px] text-slate-500');
    panel.slot.append(statusBar, chips, tail);

    startPolling(app, body.job_id, { statusBar, chips, tail });
}

/**
 * 每 POLL_MS 輪詢一次，直到 done／failed 或滿 POLL_MAX_MS。
 *
 * 每一輪同時讀兩支（形狀都在階段 2 凍結、都是唯讀）：
 *   `GET /api/jobs/:id`           → 整體狀態、counts 與**實際** cost_usd（第 6.2 條）
 *   `GET /api/jobs/:id/questions` → 每題的 state 與 review_reason，用來畫 chip（第 6.3 條）
 *
 * @param {object} app
 * @param {number} jobId
 * @param {{statusBar:HTMLElement, chips:HTMLElement, tail:HTMLElement}} nodes
 */
function startPolling(app, jobId, nodes) {
    stopPolling();
    setActionsDisabled(true);
    const startedAt = Date.now();

    const finish = (message, tone) => {
        stopPolling();
        nodes.statusBar.className = `rounded-xl border px-3 py-2.5 text-xs font-bold ${TONE_CLASS[tone]}`;
        nodes.statusBar.textContent = message;
    };

    const tick = async () => {
        if (Date.now() - startedAt > POLL_MAX_MS) {
            // 超時不代表任務失敗——worker 還在跑，只是這一頁不再等它（第 3.2 條的 60 秒）。
            finish(`已經等了 ${POLL_MAX_MS / 1000} 秒還沒跑完，先不等了。任務 #${jobId} 仍在背景執行，晚點到複核分頁看結果。`, 'amber');
            return;
        }
        let jobRes, listRes;
        try {
            [jobRes, listRes] = await Promise.all([
                request(app, `/api/jobs/${jobId}`),
                request(app, `/api/jobs/${jobId}/questions?limit=20`)
            ]);
        } catch {
            return;   // 網路抖一下不該讓輪詢整個停掉——下一輪還會再試。
        }
        if (!jobRes.ok) {
            finish(await messageOf(jobRes), 'rose');
            return;
        }
        const job = await jobRes.json();
        const items = listRes.ok ? ((await listRes.json()).items || []) : [];

        nodes.statusBar.textContent = `任務 #${job.id}：${jobSummary(job)}　·　${Math.round((job.elapsed_ms || 0) / 1000)} 秒　·　${formatCost(job.cost_usd)} / ${formatCost(job.budget_usd)}`;

        nodes.chips.innerHTML = '';
        if (items.length === 0 && jobRunning(job.state)) {
            nodes.chips.appendChild(el('p', 'text-xs text-slate-500', { textContent: '題目還沒被生出來，稍等一下…' }));
        }
        for (const row of items) nodes.chips.appendChild(questionCard(app, row, chipFor(row)));

        if (jobRunning(job.state)) return;

        // ── 終態 ──
        const awaiting = items.filter(r => r.state === 'needs_review' && r.review_reason === 'awaiting_approval').length;
        const otherReview = items.filter(r => r.state === 'needs_review' && r.review_reason !== 'awaiting_approval').length;
        const saved = items.filter(r => r.state === 'saved').length;
        finish(
            `任務 #${job.id} 已完成：入庫 ${saved} 題、待核准 ${awaiting} 題、待複核 ${otherReview} 題。` +
            `實際花費 ${formatCost(job.cost_usd)}（預算 ${formatCost(job.budget_usd)}）。`,
            job.state === 'failed' ? 'rose' : (awaiting || otherReview ? 'amber' : 'emerald')
        );
        if (awaiting || otherReview) {
            // VARIANT_AUTO_APPROVE=false 時「全部閘門過了」也會停在這裡（第 4.7 條）。
            // 核准本身在複核分頁做，這裡只把人帶過去。
            nodes.tail.textContent = '';
            nodes.tail.appendChild(document.createTextNode('有題目在等你點頭：到「待複核」分頁核准後才會真的入庫。'));
            const jump = el('button', 'ml-2 rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-50 cursor-pointer', {
                type: 'button', textContent: '前往複核分頁'
            });
            jump.addEventListener('click', () => {
                if (typeof app.showSection === 'function') app.showSection('review');
                else document.getElementById('review')?.scrollIntoView({ behavior: 'smooth' });
            });
            nodes.tail.appendChild(jump);
        } else {
            nodes.tail.textContent = job.state === 'failed'
                ? '這個任務沒有產出任何可用的題目。'
                : '全部題目都已入庫，可以直接組卷了。';
        }
    };

    tick();
    pollTimer = setInterval(tick, POLL_MS);
}

// ───────────────────────── 進入點 ─────────────────────────

/** 掛載。旗標關閉時**整段不渲染**（第 7.2 條）。 */
export function init() {
    const section = document.getElementById('variants');
    if (!section) return;
    if (!variantsEnabled()) {
        console.info('[variants] FEATURE_VARIANTS 未開啟：變式分頁不渲染（interfaces-stage3.md 第 7.2 條）。');
        return;
    }
    const app = bridge();
    if (!app) return;

    mountVariantsSection(section);

    // students.js 的「找相似／出變式」是唯一的入口（兩個 module 不互相 import，
    // 只靠這個事件通訊；detail 的形狀寫在 docs/questions3-wsD.md 第 1 條）。
    document.addEventListener(VARIANT_EVENT, (event) => {
        const detail = (event && event.detail) || {};
        if (!Number.isInteger(detail.question_id)) return;
        if (typeof app.showSection === 'function') app.showSection('variants');
        stopPolling();
        const run = detail.action === 'variant' ? requestVariants : findSimilar;
        run(app, detail).catch(err => {
            console.error('[variants] 請求失敗', err);
            setActionsDisabled(false);
        });
    });
}

// 自動掛載只在瀏覽器裡發生（沒有 document 的 Node 裡 import 本檔不該爆）。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
