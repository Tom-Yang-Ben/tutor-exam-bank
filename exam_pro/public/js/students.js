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
    variants: 'meta[name="feature-variants"]'
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

/**
 * 算出要送給 `PATCH /api/papers/:id/results` 的最小 payload。
 *
 * 只送「改過的」有兩個理由：① 第 1.4 條的 100 筆上限；② `updated` 回傳的是實際
 * UPDATE 到的列數，全送會讓「我到底改了幾題」這件事對不起來。
 *
 * @param {Array<{question_id:number, result:0|1|null}>} original 進來時的狀態（GET /api/papers/:id）
 * @param {Array<{question_id:number, result:0|1|null}>} current  使用者按完之後的狀態
 * @returns {Array<{question_id:number, result:0|1|null}>} 依 current 的順序
 */
export function diffResults(original, current) {
    const before = new Map((original || []).map(r => [r.question_id, r.result ?? null]));
    const out = [];
    for (const row of current || []) {
        const now = row.result ?? null;
        if ((before.get(row.question_id) ?? null) !== now) {
            out.push({ question_id: row.question_id, result: now });
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
            { id: 3, name: '示範學生 A', papers: 4, graded_ratio: 0.625 },
            { id: 4, name: '示範學生 B', papers: 1, graded_ratio: 0 },
            { id: 5, name: '示範學生 C', papers: 0, graded_ratio: 0 }
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
            questions: [
                { question_id: 12, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,k)$ 互相垂直，求 $k$。', question_type: '填空', difficulty: 3, result: 1 },
                { question_id: 87, question_text: '求 $\\vec{a}=(6,8)$ 在 $\\vec{b}=(1,0)$ 上的投影長。', question_type: '計算', difficulty: 3, result: 0 },
                { question_id: 91, question_text: '試證：$|\\vec{a}\\cdot\\vec{b}| \\leq |\\vec{a}||\\vec{b}|$。', question_type: '證明', difficulty: 5, result: null },
                { question_id: 103, question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。', question_type: '計算', difficulty: 2, result: 0 }
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
            { question_id: 87, chapter: '向量內積', question_text: '求 $\\vec{a}=(6,8)$ 在 $\\vec{b}=(1,0)$ 上的投影長。', assigned_at: '2026-08-21' },
            { question_id: 103, chapter: '向量內積', question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。', assigned_at: '2026-08-21' },
            { question_id: 131, chapter: '摩擦力與向心力', question_text: '斜面傾角 $30^\\circ$、摩擦係數 $0.2$，求加速度。', assigned_at: '2026-08-10' }
        ]
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

// ───────────────────────── 最近錯題 ─────────────────────────

/**
 * 最近錯題清單，每列兩顆按鈕：找相似（庫內既有題）／出變式（可能要生成、要花錢）。
 * 兩顆都只發 CustomEvent，實際的請求與輪詢由 variants.js 做（第 3 條）。
 * @param {object} app
 * @param {Array<object>} rows
 * @param {() => number|null} studentIdOf
 * @returns {HTMLElement}
 */
function recentWrongList(app, rows, studentIdOf) {
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
            const res = await request(app, `/api/papers/${paper.paper_id}`);
            if (!res.ok) { body.textContent = await messageOf(res); loaded = false; return; }
            body.innerHTML = '';
            body.appendChild(gradingForm(app, await res.json(), badge, onGraded));
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
 * @param {object} app
 * @param {object} detail GET /api/papers/:id 的回應
 * @param {HTMLElement} badge 卡片右上角的狀態標籤（存檔後要更新）
 * @param {() => void} onGraded
 * @returns {HTMLElement}
 */
function gradingForm(app, detail, badge, onGraded) {
    const wrap = el('div', '');
    const original = detail.questions.map(q => ({ question_id: q.question_id, result: q.result ?? null }));
    const current = original.map(r => ({ ...r }));

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
        const paint = () => {
            for (const b of buttons) {
                const on = (current[i].result ?? null) === b.__value;
                b.className = 'px-3 py-1.5 text-xs font-bold cursor-pointer transition-colors ' +
                    (on ? b.__onClass : 'bg-white text-slate-500 hover:bg-slate-50');
                b.setAttribute('aria-checked', String(on));
            }
        };
        for (const [value, onClass] of [[1, 'bg-emerald-500 text-white'], [0, 'bg-rose-500 text-white'], [null, 'bg-slate-400 text-white']]) {
            const btn = el('button', '', { type: 'button', textContent: resultLabel(value), role: 'radio' });
            btn.__value = value;
            btn.__onClass = onClass;
            btn.addEventListener('click', () => { current[i].result = value; paint(); });
            buttons.push(btn);
            group.appendChild(btn);
        }
        paint();
        repaints.push(paint);
        row.appendChild(group);
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
            if ((row.result ?? null) === null) { row.result = 1; changed += 1; }
        }
        for (const paint of repaints) paint();
        app.showToast(changed > 0 ? `已把 ${changed} 題標為「對」，記得按「儲存批改」。` : '沒有未批的題目。', changed > 0 ? 'success' : 'info');
    });

    const save = el('button', 'mt-4 w-full rounded-xl bg-emerald-600 p-3 font-extrabold text-white transition-all hover:bg-emerald-700 cursor-pointer', {
        type: 'button', textContent: '儲存批改'
    });
    const note = el('p', 'mt-2 text-xs text-slate-400', { textContent: '只會送出改過的題目（單一交易，全有全無）。' });

    save.addEventListener('click', async () => {
        const results = diffResults(original, current);
        if (results.length === 0) { app.showToast('沒有任何改動。', 'info'); return; }
        if (results.length > MAX_PATCH) {
            // 第 1.4 條的硬上限。分批送會破壞「全有全無」，所以誠實擋下來而不是偷偷切開。
            app.showToast(`一次最多儲存 ${MAX_PATCH} 筆批改，這次有 ${results.length} 筆。`, 'error');
            return;
        }
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
            for (let i = 0; i < current.length; i++) original[i].result = current[i].result;
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

        row.append(nameIn, renameBtn, mergeSel, mergeBtn, delBtn);
        rowsBox.appendChild(row);
    }
    card.appendChild(rowsBox);
    box.appendChild(card);
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
    subjectSel.append(
        el('option', '', { value: '', textContent: '不分科' }),
        el('option', '', { value: '數學', textContent: '數學' }),
        el('option', '', { value: '物理', textContent: '物理' })
    );
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

    const trendBox = el('div', 'mt-4 rounded-2xl border border-slate-200 bg-white p-4');
    trendBox.append(
        el('p', 'eyebrow text-slate-400', { textContent: '每週趨勢' }),
        el('p', 'mt-1 mb-2 text-xs text-slate-400', {
            textContent: '長條＝該週批改題數，紅線＝該週錯誤率；虛線段代表中間有沒有資料的週（不補零）。'
        }),
        trendSvg(weakness.trend_weekly)
    );
    weaknessBox.appendChild(trendBox);

    weaknessBox.appendChild(el('div', 'mt-4', {})).appendChild(
        recentWrongList(app, weakness.recent_wrong, currentStudentId)
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
