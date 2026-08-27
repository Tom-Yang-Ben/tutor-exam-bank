// ─────────────────────────────────────────────────────────────
// public/js/review.js — 階段 2 的上傳／輪詢／複核分頁（A-T13）
//
// 契約：docs/interfaces-stage2.md 第 6 條（六支 API 的形狀與錯誤字串）與第 8 條（前端）。
//
// 設計上的四條界線：
//
//   1. **ES module，經 window.ExamApp 橋接**（第 8 條）。index.html 那份 inline script 是
//      一般 <script>，它的 apiFetch／showToast／renderMath／escapeHtml／createQuestionEditor
//      都是區域函式，module 抓不到。因此 index.html 只加一段「把這五個掛上 window.ExamApp」，
//      既有程式一行都不改。橋接不存在時本檔**直接停手並印一行錯誤**，不自己複製一份
//      createQuestionEditor——複製出來的那份會在別人改 index.html 之後悄悄不同步。
//
//   2. **FEATURE_PIPELINE 不寫死在 JS**（第 8 條）。從 index.html 既有的注入點讀
//      （<meta name="feature-pipeline">，語意與 <meta name="api-key"> 完全一致）。
//      注入點沒被後端替換掉時內容仍是佔位字串，parseBool 會判為 false——
//      也就是「後端沒開這個旗標」的安全預設。
//      注入由 **WS-A** 在 `app.js` 的 `serveIndex()` 補上（裁決 S2-20：`app.js` 歸 WS-A）。
//      本檔的讀法不變；在注入合入之前佔位字串會被 parseBool 判成 false（＝旗標關閉、走舊流程），
//      本機驗收可用 ?pipeline=1 手動開啟。
//
//   3. **舊流程完全不動**（第 8 條：「舊流程 /analyze-pdf + batch-save-questions 保留可用，
//      既有測試是契約」）。旗標關閉時本檔只掛複核分頁的空狀態，不碰上傳按鈕；
//      旗標開啟時用 capture 階段的監聽器攔下 uploadPdfBtn 的點擊並 stopImmediatePropagation()，
//      讓 inline script 那個既有 handler 不被觸發——**而不是**去改它。
//
//   4. **API 還沒合入時要能做事**。?mock=1 會讓所有 fetch 走本檔內的手寫假資料，
//      涵蓋六種 review_reason 各一張卡片。假資料只在 ?mock=1 時被讀到，
//      正常路徑不可能誤用（第 3 條的教訓：靜默的假資料比壞掉更難查）。
// ─────────────────────────────────────────────────────────────

const POLL_MS = 3000;              // 第 8 條：每 3 秒輪詢一次
const REVIEW_LIMIT = 50;           // GET /api/review 的 limit 預設

// 第 2 條凍結的八個 review_reason，加上給人看的一句話。
// 「原因列」要具體到 30 秒內能決定（規劃 §3.9 的風險表），所以每一種都自己帶一句模板。
const REASON_LABEL = {
    chapter_invalid: '章節不在白名單',
    formula_unparsable: '公式無法解析',
    answer_mismatch: '答案對不上',
    duplicate: '與既有題目重複',
    schema_invalid: '欄位不合格',
    budget_exceeded: '超出成本上限',
    provider_error: '供應商錯誤',
    awaiting_approval: '等待人工確認'
};

const REASON_TONE = {
    chapter_invalid: 'amber',
    formula_unparsable: 'amber',
    answer_mismatch: 'rose',
    duplicate: 'indigo',
    schema_invalid: 'rose',
    budget_exceeded: 'slate',
    provider_error: 'slate',
    awaiting_approval: 'indigo'
};

const TONE_CLASS = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    slate: 'border-slate-200 bg-slate-50 text-slate-700'
};

// ───────────────────────── 橋接與旗標 ─────────────────────────

/**
 * 取得 index.html 掛上來的五個既有函式。
 * @returns {object|null} 缺任何一個都回 null（並在 console 指名缺哪一個）
 */
function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath', 'escapeHtml', 'createQuestionEditor'];
    if (!app) {
        console.error('[review] window.ExamApp 不存在：index.html 的 inline script 需要把五個既有函式掛上來（interfaces-stage2.md 第 8 條）。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[review] window.ExamApp 缺少：${missing.join('、')}。複核分頁不會掛載。`);
        return null;
    }
    return app;
}

/**
 * 布林旗標的解讀，與後端 config/features.js 的 parseBool 逐字相同
 * （interfaces-stage1.md 第 9 條）：只有 '1' 與 'true' 為真。
 * @param {any} value
 * @returns {boolean}
 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/**
 * @returns {boolean} FEATURE_PIPELINE 是否開啟
 */
function pipelineEnabled() {
    const meta = document.querySelector('meta[name="feature-pipeline"]');
    const injected = meta ? meta.content : '';
    // 佔位字串沒被後端替換掉時（app.js 還沒加那一行），parseBool 判為 false = 關閉。
    if (parseBool(injected)) return true;
    // 本機驗收用的手動開關；不影響後端旗標的權威性。
    return new URLSearchParams(location.search).get('pipeline') === '1';
}

/** @returns {boolean} 是否走本檔內的手寫假資料 */
function mockEnabled() {
    return new URLSearchParams(location.search).get('mock') === '1';
}

// ───────────────────────── 手寫 mock（只有 ?mock=1 讀得到）─────────────────────────

const MOCK = {
    job: {
        id: 41, state: 'processing',
        counts: { saved: 12, needs_review: 3, pending: 15, rejected: 0 },
        token_in: 21440, token_out: 8231, cost_usd: 0.0412, budget_usd: 0.5,
        elapsed_ms: 83120
    },
    review: {
        items: [
            { jq_id: 551, job_id: 41, idx: 1001, state: 'needs_review', review_reason: 'answer_mismatch',
              stem_preview: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。', question_id: null },
            { jq_id: 552, job_id: 41, idx: 1002, state: 'needs_review', review_reason: 'formula_unparsable',
              stem_preview: '求 $\\frac{1}{2$ 與 $\\frac{1}{3}$ 之和。', question_id: null },
            { jq_id: 553, job_id: 41, idx: 1004, state: 'needs_review', review_reason: 'chapter_invalid',
              stem_preview: '試求平面向量 $\\vec{a}=(6,8)$ 與 $\\vec{b}=(1,2)$ 的點積。', question_id: null },
            { jq_id: 554, job_id: 41, idx: 1007, state: 'needs_review', review_reason: 'duplicate',
              stem_preview: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', question_id: null },
            { jq_id: 555, job_id: 41, idx: 1009, state: 'needs_review', review_reason: 'provider_error',
              stem_preview: '兩點電荷相距 $0.3$ m，求靜電力。', question_id: null },
            { jq_id: 556, job_id: 41, idx: 1011, state: 'needs_review', review_reason: 'awaiting_approval',
              stem_preview: '試證：對任意平面向量恆有 $|\\vec{a}\\cdot\\vec{b}| \\leq |\\vec{a}||\\vec{b}|$。', question_id: null }
        ]
    },
    detail: {
        551: {
            jq_id: 551, job_id: 41, idx: 1001, state: 'needs_review', review_reason: 'answer_mismatch',
            retries: { verify: 1 },
            payload: {
                extract: { subject: '數學', chapter: '向量內積', question_type: '填空', difficulty: 3,
                    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。',
                    answer_text: '$k = -\\frac{3}{2}$' },
                verify: { skipped: false, final_answer: '$-\\frac{3}{2}$', answer_form: 'number',
                    claimed_answer: '$-\\frac{2}{3}$', compare: 'disagree', samples: 1,
                    steps_summary: '垂直即內積為 0：$3 + 2k = 0$，得 $k = -\\frac{3}{2}$。' }
            },
            question_id: null
        },
        552: {
            jq_id: 552, job_id: 41, idx: 1002, state: 'needs_review', review_reason: 'formula_unparsable',
            retries: { lint: 2 },
            payload: {
                extract: { subject: '數學', chapter: '實數', question_type: '計算', difficulty: 1,
                    question_text: '求 $\\frac{1}{2$ 與 $\\frac{1}{3}$ 之和。', answer_text: '$\\frac{5}{6}$' },
                lint: { question_text: '求 $\\frac{1}{2$ 與 $\\frac{1}{3}$ 之和。', answer_text: '$\\frac{5}{6}$',
                    applied: ['frac_slash'], rewritten: true,
                    issues: [{ sev: 'error', rule: 'missing_rbrace', at: 8, msg: '\\frac{1}{2 缺右大括號' }] }
            },
            question_id: null
        },
        553: {
            jq_id: 553, job_id: 41, idx: 1004, state: 'needs_review', review_reason: 'chapter_invalid',
            retries: { classify: 2 },
            payload: {
                extract: { subject: '數學', chapter: '純量積', question_type: '計算', difficulty: 2,
                    question_text: '試求平面向量 $\\vec{a}=(6,8)$ 與 $\\vec{b}=(1,2)$ 的點積。',
                    answer_text: '$6 \\times 1 + 8 \\times 2 = 22$' },
                classify: { chapter: '純量積', confidence: 0.61, source: 'llm', few_shot_ids: [12, 87],
                    rationale: '題幹提到「點積」，與內積同義。',
                    feedback: '「純量積」不在白名單內，最接近的是「向量內積」「空間向量內積」' }
            },
            question_id: null
        },
        554: {
            jq_id: 554, job_id: 41, idx: 1007, state: 'needs_review', review_reason: 'duplicate',
            retries: {},
            payload: {
                extract: { subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 2,
                    question_text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。',
                    answer_text: '$a = \\frac{10}{2} = 5$ m/s$^2$' },
                dedup0: { text_hash: 'c1f0…9ab2', normalized_len: 31, hit: { scope: 'db', question_id: 128 } }
            },
            question_id: null
        },
        555: {
            jq_id: 555, job_id: 41, idx: 1009, state: 'needs_review', review_reason: 'provider_error',
            retries: { 'verify:error': 3 },
            payload: {
                extract: { subject: '物理', chapter: '電場與電位', question_type: '計算', difficulty: 3,
                    question_text: '兩點電荷相距 $0.3$ m，求靜電力。', answer_text: '$0.6$ N' }
            },
            question_id: null
        },
        556: {
            jq_id: 556, job_id: 41, idx: 1011, state: 'needs_review', review_reason: 'awaiting_approval',
            retries: {},
            payload: {
                extract: { subject: '數學', chapter: '向量內積', question_type: '證明', difficulty: 5,
                    question_text: '試證：對任意平面向量恆有 $|\\vec{a}\\cdot\\vec{b}| \\leq |\\vec{a}||\\vec{b}|$。',
                    answer_text: '設夾角為 $\\theta$，由 $|\\cos\\theta| \\leq 1$ 即得。' },
                verify: { skipped: true }
            },
            question_id: null
        }
    }
};

/**
 * 把假資料包成 Response 的樣子，讓上層完全不必知道自己在 mock。
 * @param {any} body
 * @returns {Promise<Response>}
 */
function mockResponse(body) {
    return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' }
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
    if (method === 'GET' && /^\/api\/jobs\/\d+$/.test(url)) return mockResponse(MOCK.job);
    if (method === 'GET' && url.startsWith('/api/review/')) {
        const id = Number(url.split('/').pop());
        const doc = MOCK.detail[id];
        return doc ? mockResponse(doc)
            : Promise.resolve(new Response(JSON.stringify({ message: '找不到該待複核題目' }), { status: 404 }));
    }
    if (method === 'GET' && url.startsWith('/api/review')) return mockResponse(MOCK.review);
    if (method === 'POST' && url === '/api/jobs') return mockResponse({ job_id: 41, existing: false });
    if (method === 'POST' && /\/approve$/.test(url)) return mockResponse({ question_id: 131 });
    if (method === 'POST' && /\/reject$/.test(url)) {
        return mockResponse({ message: '已標記為不採用。', jq_id: Number(url.split('/')[3]) });
    }
    return Promise.resolve(new Response(JSON.stringify({ message: `mock 沒有覆蓋 ${method} ${url}` }), { status: 501 }));
}

// ───────────────────────── DOM 小工具 ─────────────────────────

function el(tag, cls, props) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (props) Object.assign(node, props);
    return node;
}

/**
 * 從 payload 產生「機器產生的具體原因」那一句。
 *
 * 規劃 §3.6 舉的三個例子就是這裡要生出來的東西：
 *   「驗證模型算出 (B)，拆題模型說 (C)」「公式 \frac{1}{2 缺右括號」「與 #128 重複」。
 * 泛泛的「答案對不上」對老師沒有用——她還是得自己打開題目查。
 *
 * @param {string} reason  第 2 條的八個 review_reason 之一
 * @param {object} payload 第 3.2 條的 payload
 * @returns {string}
 */
export function reasonSentence(reason, payload) {
    const p = payload || {};
    switch (reason) {
        case 'answer_mismatch': {
            const v = p.verify || {};
            if (v.final_answer || v.claimed_answer) {
                return `驗證模型算出 ${v.final_answer ?? '（無）'}，拆題模型抄的是 ${v.claimed_answer ?? '（無）'}` +
                    (v.compare ? `（比對結果：${v.compare}）` : '');
            }
            return '驗證模型與拆題模型的答案不一致。';
        }
        case 'formula_unparsable': {
            const issues = (p.lint && p.lint.issues) || [];
            const errors = issues.filter(i => i.sev === 'error');
            if (errors.length) {
                const first = errors[0];
                return `公式仍有 ${errors.length} 處無法解析：${first.msg}（規則 ${first.rule}，位置 ${first.at}）` +
                    ((p.lint && p.lint.rewritten) ? '；已試過 LLM 重寫仍未修好。' : '。');
            }
            return '公式無法解析，Word 匯出會降級成純文字。';
        }
        case 'chapter_invalid': {
            const c = p.classify || {};
            if (c.feedback) return c.feedback;
            if (c.chapter) return `分類模型回了「${c.chapter}」（信心 ${c.confidence ?? '—'}），不在章節白名單內。`;
            return '章節不在白名單內。';
        }
        case 'duplicate': {
            const hit = (p.dedup0 && p.dedup0.hit) || null;
            if (hit && hit.scope === 'db') return `題幹雜湊與題庫的 #${hit.question_id} 完全相同。`;
            if (hit && hit.scope === 'job') return `題幹雜湊與這份 PDF 裡較前面的一題（jq #${hit.jq_id}）相同。`;
            const top = (p.dedup1 && p.dedup1.top) || [];
            if (top.length) {
                return `向量相似度 ${Number(top[0].cosine).toFixed(4)} ≥ 門檻 ${p.dedup1.threshold_used}，` +
                    `最接近的是 #${top[0].question_id}。`;
            }
            return '與既有題目重複。';
        }
        case 'schema_invalid': {
            const errs = (p.save && p.save.errors) || (p.extract && p.extract.errors) || [];
            if (errs.length) return `欄位驗證未通過：${errs.join('；')}`;
            // 沒有任何 errors 清單＝不是欄位問題：是某個節點的模型輸出 JSON 損壞（多半是被截斷），
            // 被歸類成 schema_invalid（error 路徑不寫 payload，所以這裡拿不到細節）。
            return '模型回傳的 JSON 損壞或被截斷（不是題目欄位的問題），重試已用盡。重跑這一題通常就會過。';
        }
        case 'budget_exceeded':
            return '這份 PDF 的成本已達上限，剩下的節點沒有執行。可在任務頁按「提高預算並重跑」。';
        case 'provider_error':
            return '供應商連續錯誤（逾時或配額），重試次數已用盡。這一題沒有被判定為壞題，重跑通常就會過。';
        case 'awaiting_approval':
            return '沒有任何閘門判定它壞掉，但流程需要人點頭。';
        default:
            return `複核原因：${reason}`;
    }
}

/**
 * 把 payload 攤平成 createQuestionEditor 吃的欄位。
 * lint 修過的文字優先於 extract 的原文、classify 的章節優先於 extract 的章節
 * （第 3.2 條：save 用的就是這兩個）。
 * @param {object} payload
 * @returns {object}
 */
export function payloadToQuestion(payload) {
    const p = payload || {};
    const ex = p.extract || {};
    return {
        subject: ex.subject || '數學',
        chapter: (p.classify && p.classify.chapter) || ex.chapter || '',
        question_type: ex.question_type || '填空',
        difficulty: ex.difficulty || 3,
        question_text: (p.lint && p.lint.question_text) || ex.question_text || '',
        answer_text: (p.lint && p.lint.answer_text) || ex.answer_text || ''
    };
}

// ───────────────────────── 上傳 + 輪詢 ─────────────────────────

/**
 * 建立上傳區的狀態列（「已入庫 N／待複核 M／處理中 K」）。
 * @returns {HTMLElement}
 */
function jobStatusLine() {
    let node = document.getElementById('jobStatusLine');
    if (node) return node;
    node = el('div', 'mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-bold text-indigo-800 hidden', { id: 'jobStatusLine' });
    const status = document.getElementById('pdfStatus');
    if (status && status.parentNode) status.parentNode.insertBefore(node, status.nextSibling);
    return node;
}

// jobs.state 的五個值（第 2.1 條）→ 給人看的一句話。
// 裁決 S2-22：**queued／extracting 期間 counts 一定全是 0**——job_questions 還沒被建出來。
// 那不是「一題都沒過」，而是「還沒開始逐題推進」。把它顯示成「已入庫 0／待複核 0」
// 會讓老師以為出事了，所以這兩個狀態改成只顯示進度文字，不顯示計數。
export const JOB_STATE_LABEL = {
    queued: '排隊中',
    extracting: '拆題中',
    processing: '逐題處理中',
    done: '已完成',
    failed: '失敗'
};

/** @param {string} state @returns {boolean} counts 在這個狀態下有沒有意義 */
export function countsMeaningful(state) {
    return state !== 'queued' && state !== 'extracting';
}

function renderJobStatus(job) {
    const node = jobStatusLine();
    node.classList.remove('hidden');
    const c = job.counts || {};
    const cost = typeof job.cost_usd === 'number' ? job.cost_usd.toFixed(4) : '—';
    const secs = Math.round((job.elapsed_ms || 0) / 1000);
    const label = JOB_STATE_LABEL[job.state] || job.state;

    const head = `任務 #${job.id}（${label}）：`;
    const body = countsMeaningful(job.state)
        ? `已入庫 ${c.saved ?? 0}／待複核 ${c.needs_review ?? 0}／處理中 ${c.pending ?? 0}` +
          `${c.rejected ? `／不採用 ${c.rejected}` : ''}`
        // queued／extracting：counts 全 0 是正常的，不要印出來嚇人（裁決 S2-22）
        : (job.state === 'queued' ? '已排隊，等待 worker 認領' : '正在拆題，尚未逐題處理');
    const tail = `　·　${secs} 秒　·　$${cost} / $${job.budget_usd}`;

    node.textContent = head + body + tail;
    node.classList.toggle('border-amber-200', !countsMeaningful(job.state));
    node.classList.toggle('bg-amber-50', !countsMeaningful(job.state));
    node.classList.toggle('text-amber-800', !countsMeaningful(job.state));
    node.classList.toggle('border-indigo-200', countsMeaningful(job.state));
    node.classList.toggle('bg-indigo-50', countsMeaningful(job.state));
    node.classList.toggle('text-indigo-800', countsMeaningful(job.state));
}

let pollTimer = null;

/**
 * 每 POLL_MS 輪詢一次 GET /api/jobs/:id，直到 done／failed。
 * @param {object} app
 * @param {number} jobId
 */
function startPolling(app, jobId) {
    if (pollTimer) clearInterval(pollTimer);

    const tick = async () => {
        let res;
        try {
            res = await request(app, `/api/jobs/${jobId}`);
        } catch {
            // 網路抖一下不該讓輪詢整個停掉——下一輪還會再試。
            return;
        }
        if (!res.ok) {
            clearInterval(pollTimer);
            pollTimer = null;
            const body = await res.json().catch(() => ({}));
            app.showToast(body.message || '查詢任務進度失敗', 'error');
            return;
        }
        const job = await res.json();
        renderJobStatus(job);

        if (job.state === 'done' || job.state === 'failed') {
            clearInterval(pollTimer);
            pollTimer = null;
            const btn = document.getElementById('uploadPdfBtn');
            if (btn) btn.disabled = false;
            if (job.state === 'failed') {
                app.showToast('任務失敗，請看任務狀態列的說明。', 'error');
            } else {
                const c = job.counts || {};
                app.showToast(`拆題完成：已入庫 ${c.saved ?? 0} 題，待複核 ${c.needs_review ?? 0} 題。`, 'success');
            }
            // 完成時把複核佇列刷新一次——老師要看的東西就在那裡。
            loadReviewQueue(app).catch(() => {});
        }
    };

    tick();
    pollTimer = setInterval(tick, POLL_MS);
}

/**
 * 接管上傳按鈕：改送 POST /api/jobs。
 * 用 capture 階段 + stopImmediatePropagation，讓 index.html 既有的 handler 不被觸發，
 * 而不必去改它（第 8 條：舊流程保留可用）。
 * @param {object} app
 */
function takeOverUpload(app) {
    const btn = document.getElementById('uploadPdfBtn');
    const fileInput = document.getElementById('pdfFile');
    if (!btn || !fileInput) return;

    btn.addEventListener('click', async (event) => {
        event.stopImmediatePropagation();
        event.preventDefault();

        if (!fileInput.files || fileInput.files.length === 0) {
            app.showToast('請先選取 PDF 檔案', 'error');
            return;
        }
        btn.disabled = true;
        const status = document.getElementById('pdfStatus');
        if (status) {
            status.className = 'text-sm font-medium text-indigo-600 mt-3';
            status.textContent = '⏳ 已送出，正在排隊拆題…';
        }

        const formData = new FormData();
        formData.append('pdf', fileInput.files[0]);   // 第 6.1 條：欄位名固定是 pdf

        try {
            const res = await request(app, '/api/jobs', { method: 'POST', body: formData });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                btn.disabled = false;
                if (status) { status.className = 'text-sm font-bold text-rose-600 mt-3'; status.textContent = `❌ ${body.message || '上傳失敗'}`; }
                app.showToast(body.message || '上傳失敗', 'error');
                return;
            }
            if (body.existing) {
                // 冪等命中（第 6.1 條）：同一份 PDF 傳第二次不會重複付費，要讓老師知道。
                app.showToast(`這份 PDF 之前已經傳過，接回任務 #${body.job_id}（沒有重複付費）。`, 'info');
            }
            if (status) { status.className = 'text-sm font-bold text-emerald-600 mt-3'; status.textContent = `✅ 已建立任務 #${body.job_id}，每 3 秒更新一次進度。`; }
            startPolling(app, body.job_id);
        } catch (err) {
            btn.disabled = false;
            if (status) { status.className = 'text-sm font-bold text-rose-600 mt-3'; status.textContent = '❌ 連線失敗。'; }
            app.showToast('連線失敗，請稍後再試', 'error');
        }
    }, true);   // ← capture
}

// ───────────────────────── 複核分頁 ─────────────────────────

function reasonBar(reason, payload) {
    const tone = TONE_CLASS[REASON_TONE[reason]] || TONE_CLASS.slate;
    const bar = el('div', `mb-3 rounded-xl border px-3 py-2 text-xs font-bold leading-5 ${tone}`);
    bar.append(
        el('span', 'mr-2 rounded-md bg-white/70 px-1.5 py-0.5', { textContent: REASON_LABEL[reason] || reason }),
        el('span', '', { textContent: reasonSentence(reason, payload) })
    );
    return bar;
}

/**
 * 一張複核卡片。
 * @param {object} app
 * @param {object} item  GET /api/review 的一列
 * @returns {HTMLElement}
 */
function reviewCard(app, item) {
    const card = el('div', 'question-card rounded-2xl p-4 bg-white');
    card.dataset.jqId = String(item.jq_id);

    card.appendChild(el('div', 'eyebrow text-violet-500 mb-2', {
        textContent: `jq #${item.jq_id}　·　任務 #${item.job_id}　·　idx ${item.idx}`
    }));

    // 先放一條只有預覽資訊的原因列；點開詳情後會用完整 payload 換掉。
    const bar = reasonBar(item.review_reason, null);
    card.appendChild(bar);

    const preview = el('div', 'text-sm text-slate-700 mb-3');
    preview.textContent = item.stem_preview || '';
    card.appendChild(preview);
    app.renderMath(preview);

    const actions = el('div', 'flex flex-wrap gap-2');
    const openBtn = el('button', 'text-sm px-3 py-2 rounded-xl border border-indigo-200 bg-white font-bold text-indigo-700 hover:bg-indigo-50 cursor-pointer transition-colors', {
        type: 'button', textContent: '展開修正'
    });
    const rejectBtn = el('button', 'text-sm px-3 py-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-600 hover:bg-slate-50 cursor-pointer transition-colors', {
        type: 'button', textContent: '略過'
    });
    actions.append(openBtn, rejectBtn);
    card.appendChild(actions);

    const editorSlot = el('div', 'mt-3');
    card.appendChild(editorSlot);

    let question = null;
    let acceptPlainText = false;

    openBtn.addEventListener('click', async () => {
        if (editorSlot.childElementCount > 0) {   // 再按一次收起來
            editorSlot.innerHTML = '';
            openBtn.textContent = '展開修正';
            return;
        }
        openBtn.disabled = true;
        try {
            const res = await request(app, `/api/review/${item.jq_id}`);
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { app.showToast(body.message || '讀取失敗', 'error'); return; }

            // 拿到完整 payload 後，原因列換成真正具體的那一句
            bar.replaceWith(reasonBar(body.review_reason, body.payload));

            question = payloadToQuestion(body.payload);
            editorSlot.appendChild(app.createQuestionEditor(question));   // 沿用既有編輯器（第 8 條）

            const retries = body.retries && Object.keys(body.retries).length
                ? `重試紀錄：${Object.entries(body.retries).map(([k, v]) => `${k}×${v}`).join('、')}`
                : '沒有重試紀錄';
            editorSlot.appendChild(el('p', 'mt-2 text-xs text-slate-400', { textContent: retries }));

            const plainWrap = el('label', 'mt-2 flex items-center gap-2 text-xs font-bold text-slate-600');
            const plainBox = el('input', '', { type: 'checkbox' });
            plainBox.addEventListener('change', () => { acceptPlainText = plainBox.checked; });
            plainWrap.append(plainBox, el('span', '', { textContent: '接受公式降級成純文字（accept_plain_text）' }));
            editorSlot.appendChild(plainWrap);

            const saveBtn = el('button', 'mt-3 w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold p-3 rounded-xl transition-all cursor-pointer', {
                type: 'button', textContent: '修正入庫'
            });
            saveBtn.addEventListener('click', () => approve(app, card, item, question, () => acceptPlainText, saveBtn));
            editorSlot.appendChild(saveBtn);

            openBtn.textContent = '收起';
        } finally {
            openBtn.disabled = false;
        }
    });

    rejectBtn.addEventListener('click', () => reject(app, card, item, rejectBtn));
    return card;
}

async function approve(app, card, item, question, getAcceptPlainText, btn) {
    btn.disabled = true;
    try {
        const res = await request(app, `/api/review/${item.jq_id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...question, accept_plain_text: getAcceptPlainText(), merge_into: null })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            // 第 6.6 條：400 會帶 errors（欄位驗證或公式），逐條印出來才有辦法修
            const detail = Array.isArray(body.errors)
                ? body.errors.map(e => (typeof e === 'string' ? e : `${e.rule}：${e.msg}`)).join('；')
                : '';
            app.showToast(`${body.message || '入庫失敗'}${detail ? `（${detail}）` : ''}`, 'error');
            return;
        }
        app.showToast(body.merged ? `已併入 #${body.question_id}` : `已入庫，題號 #${body.question_id}`, 'success');
        card.remove();
        bumpQueueCount(-1);
    } catch {
        app.showToast('連線失敗，請稍後再試', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function reject(app, card, item, btn) {
    btn.disabled = true;
    try {
        const res = await request(app, `/api/review/${item.jq_id}/reject`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { app.showToast(body.message || '略過失敗', 'error'); return; }
        app.showToast(body.message || '已標記為不採用。', 'success');
        card.remove();
        bumpQueueCount(-1);
    } catch {
        app.showToast('連線失敗，請稍後再試', 'error');
    } finally {
        btn.disabled = false;
    }
}

function bumpQueueCount(delta) {
    const node = document.getElementById('reviewCount');
    if (!node) return;
    const next = Math.max(0, (Number(node.textContent) || 0) + delta);
    node.textContent = String(next);
    const empty = document.getElementById('reviewEmpty');
    const list = document.getElementById('reviewList');
    if (empty && list) empty.classList.toggle('hidden', next !== 0 || list.childElementCount > 0);
}

/**
 * 載入 GET /api/review 的佇列並渲染。
 * @param {object} app
 */
async function loadReviewQueue(app) {
    const list = document.getElementById('reviewList');
    const empty = document.getElementById('reviewEmpty');
    if (!list) return;

    const reason = document.getElementById('reviewReasonFilter');
    const params = new URLSearchParams({ limit: String(REVIEW_LIMIT) });
    if (reason && reason.value) params.set('reason', reason.value);

    list.innerHTML = '';
    let res;
    try {
        res = await request(app, `/api/review?${params.toString()}`);
    } catch {
        if (empty) { empty.classList.remove('hidden'); empty.textContent = '連線失敗，請稍後再試。'; }
        return;
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (empty) {
            empty.classList.remove('hidden');
            // 404 代表這批 API 還沒合入（WS-A 的 A-T12），不是壞掉——講清楚，別讓人以為前端爛了
            empty.textContent = res.status === 404
                ? '複核 API 尚未上線（GET /api/review 回 404）。可加上 ?mock=1 用手寫假資料預覽版面。'
                : (body.message || '讀取複核佇列失敗。');
        }
        return;
    }

    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const count = document.getElementById('reviewCount');
    if (count) count.textContent = String(items.length);
    if (empty) empty.classList.toggle('hidden', items.length > 0);
    if (empty && items.length === 0) empty.textContent = '目前沒有待複核的題目。';

    for (const item of items) list.appendChild(reviewCard(app, item));
}

/**
 * 建立 <section id="review"> 裡的骨架（index.html 只放一個空的錨點）。
 * @param {object} app
 * @param {HTMLElement} section
 */
function mountReviewSection(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'flex flex-wrap items-start justify-between gap-3 mb-5 border-b border-slate-100 pb-5');
    const title = el('div', 'flex items-start gap-3');
    title.append(
        el('span', 'section-icon bg-amber-50 text-amber-700', { textContent: '審' }),
        (() => {
            const box = el('div');
            box.append(
                el('p', 'eyebrow text-amber-600', { textContent: 'Review queue' }),
                (() => {
                    const h = el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900');
                    h.append(
                        document.createTextNode('待複核（'),
                        el('span', 'text-amber-600', { id: 'reviewCount', textContent: '0' }),
                        document.createTextNode(' 題）')
                    );
                    return h;
                })(),
                el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
                    textContent: '通過所有閘門的題已自動入庫；這裡只放系統有疑慮的題，每題都附上機器產生的具體原因。'
                })
            );
            return box;
        })()
    );

    const controls = el('div', 'flex items-center gap-2');
    const filter = el('select', 'field-control min-h-0 p-2.5 text-sm', { id: 'reviewReasonFilter' });
    filter.appendChild(el('option', '', { value: '', textContent: '全部原因' }));
    for (const [value, label] of Object.entries(REASON_LABEL)) {
        filter.appendChild(el('option', '', { value, textContent: label }));
    }
    const refresh = el('button', 'text-sm px-4 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 font-bold hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 cursor-pointer transition-colors', {
        type: 'button', id: 'reviewRefresh', textContent: '重新整理'
    });
    controls.append(filter, refresh);
    head.append(title, controls);

    const empty = el('p', 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500', {
        id: 'reviewEmpty', textContent: '載入中…'
    });
    const list = el('div', 'space-y-3', { id: 'reviewList' });

    section.append(head, empty, list);

    filter.addEventListener('change', () => loadReviewQueue(app));
    refresh.addEventListener('click', () => loadReviewQueue(app));
}

// ───────────────────────── 進入點 ─────────────────────────

/**
 * 掛載。index.html 的 inline script 先跑（一般 <script>），module 後跑（defer 語意），
 * 所以 window.ExamApp 這時一定已經存在——若不存在就是 index.html 那段沒加上去。
 */
export function init() {
    const app = bridge();
    if (!app) return;

    const section = document.getElementById('review');
    if (section) mountReviewSection(app, section);

    if (!pipelineEnabled()) {
        // 旗標關閉：上傳區完全維持舊流程，複核區只留一句說明。
        const empty = document.getElementById('reviewEmpty');
        if (empty) {
            empty.textContent = 'FEATURE_PIPELINE 未開啟：上傳區仍走舊的 /analyze-pdf 流程，複核佇列不會有資料。';
        }
        return;
    }

    takeOverUpload(app);
    if (section) loadReviewQueue(app).catch(err => console.error('[review] 載入複核佇列失敗', err));
}

// 自動掛載只在瀏覽器裡發生。
// 這個 typeof 檢查不是防禦性程式碼：test/unit/reviewUi.test.js 會 `import()` 本檔來測
// reasonSentence／payloadToQuestion／parseBool 三個純函式，Node 裡沒有 document，
// 少了這一層整個測試檔會在 import 當下就爆掉。
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
