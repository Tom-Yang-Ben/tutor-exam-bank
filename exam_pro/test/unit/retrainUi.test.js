// ─────────────────────────────────────────────────────────────
// 錯題重練的畫面（錯題重練第二階段之三 PR-4；docs/retrain-and-review.md 第 5.3 節，TC-040-2）
//
// 三層（沿用 gradingUi／remedialUi 的做法）：
//   1. 檔案層級契約：旗標從 <meta name="feature-retrain"> 讀、parseBool 與後端逐字相同、index.html 的三個接點、
//      兩支 module 的事件名一致、retrain.js 不用 innerHTML 塞字串。
//   2. 純函式：徽章、到期文字、題號解析、API-2／3／5／7／12 的 body、答對率、批改提示、學生清單徽章、diffResults 的 retrain 鍵。
//   3. 用 test/unit/lib/miniDom.js 把 students.js 與 retrain.js 一起跑起來，餵一組假 API（記下每一次請求的網址與 body）：
//      旗標關閉不渲染、不發任何新請求；清單照伺服器的順序（第 4.7 節）與徽章；動作按鈕送出的 body；手動加入；
//      出一份重練卷（草稿 → 刪整組 → 確認帶 retrain_question_ids → Word 帶 paper_id；R12 的 400 原樣顯示）；
//      重練成效表；批改卡「要重練」勾選框（預設不勾）與「重練・第 n 關」徽章、儲存送出的 body 與提示；
//      學生清單的「到期 N」；伺服器文字一律 textContent。
//
// API-5、API-7、API-12 的伺服器端由 PR-3 實作；這裡照第 5.2 節凍結的形狀 mock。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');
const { ERROR_TYPES, MAX_ERROR_TYPES } = require('../../config/errorTypes');
const check = require('../../eval/tools/check_html');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const source = name => fs.readFileSync(path.join(JS_DIR, name), 'utf8');

let seq = 0;
/** 每次拿一份新的 module 實例（模組層有狀態與快取）。 */
async function loadFresh(name) {
    const src = source(name) + `\n// retrainUi instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await flush(); };
const clone = v => JSON.parse(JSON.stringify(v));

// ═════════════ 假資料 ═════════════

const STUDENTS = {
    items: [
        { id: 3, name: '示範學生', papers: 2, graded_ratio: 0.5, grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null },
        { id: 4, name: '第二位', papers: 1, graded_ratio: 0, grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null }
    ]
};
const WEAKNESS = { by_chapter: [], by_type: [], by_difficulty: [], trend_weekly: [], recent_wrong: [], by_error_type: [] };
const PAPERS = { items: [{ paper_id: 41, title: '示範卷', created_at: '2026-10-01T00:00:00.000Z', total: 4, graded: 1 }] };
const SUMMARY = { as_of: '2026-10-12', items: [{ student_id: 3, due: 3, in_flight: 1, stuck: 1, active: 5 }] };

/** API-1 一筆（第 5.2 節的形狀＋PR-2 多的鍵）。 */
function item(over) {
    return {
        item_id: 1, question_id: 1, subject: '數學', chapter: '向量內積', difficulty: 3, question_type: '計算',
        question_text_preview: '題幹', archived: false, reason: 'flagged', entered_on: '2026-10-01',
        status: 'active', step: 1, step_label: '錯題重練', due_on: '2026-10-02', due: false, overdue_days: 0,
        in_flight: false, in_flight_paper_id: null, in_flight_since: null, in_flight_warn: false,
        streak: 0, lapses: 0, stuck: false, last_attempt_on: null, mastered_on: null,
        teacher_override: null, override_on: null, note: null, group_ids: [over.question_id || 1], follows_question_id: null,
        history: [],
        ...over
    };
}

// 刻意不照題號排：驗畫面照伺服器排好的順序（第 4.7 節：逾期多 → 關卡小 → 錯次數多 → 題號小；沒到期的在後）
const LIST = {
    as_of: '2026-10-12',
    counts: { active: 5, due: 3, in_flight: 1, stuck: 1, mastered: 2, retired: 1 },
    items: [
        item({
            item_id: 31, question_id: 812, question_text_preview: '設 $\\vec a=(1,2)$，求 $|\\vec a|$。', due: true, due_on: '2026-10-07',
            overdue_days: 5, lapses: 3, stuck: true, reason: 'flagged',
            history: [
                { assignment_id: 5501, paper_id: 88, assigned_at: '2026-10-01', purpose: 'new', retrain_step: null, result: 0, score: null, error_types: ['calc'] },
                { assignment_id: 5630, paper_id: 91, assigned_at: '2026-10-05', purpose: 'retrain', retrain_step: 1, result: 1, score: 0.8, error_types: [] }
            ]
        }),
        item({ item_id: 40, question_id: 640, step: 2, step_label: '一週回測', due: true, due_on: '2026-10-10', overdue_days: 2, streak: 1,
            group_ids: [640, 641], reason: 'group' }),
        item({ item_id: 41, question_id: 641, step: 1, due: false, due_on: '2026-10-20', group_ids: [640, 641], follows_question_id: 640 }),
        item({ item_id: 50, question_id: 700, in_flight: true, in_flight_paper_id: 91, in_flight_since: '2026-09-20', in_flight_warn: true,
            due_on: '2026-09-21' }),
        item({ item_id: 60, question_id: 705, archived: true, due_on: '2026-10-01', reason: 'manual', note: '課本例題' })
    ]
};
const LIST_ALL_EXTRA = [
    item({ item_id: 70, question_id: 900, status: 'mastered', step: 3, due_on: null, streak: 3, mastered_on: '2026-10-05' }),
    item({ item_id: 80, question_id: 901, status: 'retired', due_on: null, teacher_override: 'retired', override_on: '2026-10-06' })
];

const STATS = {
    entered: 25, active: 14, mastered: 9, retired: 2, stuck: 1,
    first_retrain: { graded: 18, correct: 12, rate: 0.6667 },
    spaced: { graded: 20, correct: 17, rate: 0.85 },
    backlog: { due_now: 6, overdue_7d: 2 },
    by_chapter: [{ chapter: '向量內積', entered: 5, mastered: 2, active: 3, stuck: 0 }, { chapter: null, entered: 1, mastered: 0, active: 1, stuck: 1 }],
    since: '2025-10-12'
};

const DRAFT = {
    student_id: 3, subject: null, as_of: '2026-10-12',
    question_ids: [812, 640, 641],
    items: [
        { question_id: 812, item_id: 31, step: 1, step_label: '錯題重練', due_on: '2026-10-07', overdue_days: 5, chapter: '向量內積', difficulty: 3, question_text_preview: '題 812', follows_question_id: null, group_ids: [812] },
        { question_id: 640, item_id: 40, step: 2, step_label: '一週回測', due_on: '2026-10-10', overdue_days: 2, chapter: '向量內積', difficulty: 2, question_text_preview: '題 640', follows_question_id: null, group_ids: [640, 641] },
        { question_id: 641, item_id: 41, step: 1, step_label: '錯題重練', due_on: '2026-10-20', overdue_days: 0, chapter: '向量內積', difficulty: 2, question_text_preview: '題 641', follows_question_id: 640, group_ids: [640, 641] }
    ],
    due_total: 6,
    notes: ['到期 6 題，本草稿放 3 題（題數上限）；其餘留在清單，下次優先。']
};

/** API-9（旗標開啟）：每題多 purpose、retrain_step、retrain_flagged。 */
const PAPER = {
    id: 41, title: '示範卷', student_id: 3, created_at: '2026-10-01T00:00:00.000Z',
    questions: [
        { question_id: 11, question_text: '新題答錯', question_type: '填空', difficulty: 2, result: 0, subject: '數學', chapter: '向量內積',
            answer_text: '1', solution_text: null, solution_src: null, score: null, error_types: [], response: null, teacher_note: null,
            purpose: 'new', retrain_step: null, retrain_flagged: false },
        { question_id: 12, question_text: '之前勾過的新題', question_type: '填空', difficulty: 2, result: null, subject: '數學', chapter: '向量內積',
            answer_text: '2', solution_text: null, solution_src: null, score: null, error_types: [], response: null, teacher_note: null,
            purpose: 'new', retrain_step: null, retrain_flagged: true },
        { question_id: 13, question_text: '重練題', question_type: '填空', difficulty: 2, result: null, subject: '數學', chapter: '向量內積',
            answer_text: '3', solution_text: null, solution_src: null, score: null, error_types: [], response: null, teacher_note: null,
            purpose: 'retrain', retrain_step: 2, retrain_flagged: null },
        { question_id: 14, question_text: '還沒批的新題', question_type: '填空', difficulty: 2, result: null, subject: '數學', chapter: '向量內積',
            answer_text: '4', solution_text: null, solution_src: null, score: null, error_types: [], response: null, teacher_note: null,
            purpose: 'new', retrain_step: null, retrain_flagged: false }
    ]
};

const DOCX = () => new Response(new Uint8Array([80, 75, 3, 4]), {
    status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
});

/**
 * 假 API：記下每一次呼叫（網址、方法、解析過的 body），依「方法 路徑」回 fixture。
 * fixture 可以是值（200）、[status, body]、或 (body, url) => [status, body] | Response。
 */
function fakeApi(overrides = {}) {
    const calls = [];
    const fixtures = {
        'GET /api/students': STUDENTS,
        'GET /api/students/3/papers': PAPERS,
        'GET /api/students/4/papers': { items: [] },
        'GET /api/students/3/weakness': WEAKNESS,
        'GET /api/students/4/weakness': WEAKNESS,
        'GET /api/error-types': { items: ERROR_TYPES, max_per_attempt: MAX_ERROR_TYPES },
        'GET /api/papers/41': PAPER,
        'PATCH /api/papers/41/results': body => [200, { updated: body.results.length, retrain: { entered: 0, advanced: 0, mastered: 0, reset: 0 } }],
        'GET /api/retrain/summary': SUMMARY,
        'GET /api/students/3/retrain-items': (body, url) => {
            const status = new URL(url, 'http://x').searchParams.get('status');
            if (status === 'all') return [200, { ...LIST, items: [...LIST.items, ...LIST_ALL_EXTRA] }];
            if (status === 'retired') return [200, { ...LIST, items: [LIST_ALL_EXTRA[1]] }];
            return [200, LIST];
        },
        'GET /api/students/4/retrain-items': { as_of: '2026-10-12', counts: { active: 0, due: 0, in_flight: 0, stuck: 0, mastered: 0, retired: 0 }, items: [] },
        'GET /api/students/3/retrain-stats': STATS,
        'GET /api/students/4/retrain-stats': { ...STATS, entered: 0, active: 0, mastered: 0, retired: 0, stuck: 0, first_retrain: { graded: 0, correct: 0, rate: null }, spaced: { graded: 0, correct: 0, rate: null }, backlog: { due_now: 0, overdue_7d: 0 }, by_chapter: [] },
        'POST /api/students/3/retrain-items': { added: [], skipped: [] },
        'POST /api/students/3/retrain-paper': DRAFT,
        'POST /api/confirm-paper': body => [200, { message: '出卷完成！', paper_id: 95, paper_title: '示範學生-錯題重練卷(2026_10_12)', question_ids: body.question_ids, questions: [], retrain_question_ids: body.retrain_question_ids }],
        'POST /api/download-word': () => DOCX(),
        ...overrides
    };
    const apiFetch = (url, options = {}) => {
        const method = options.method || 'GET';
        const p = url.split('?')[0];
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
        calls.push({ method, path: p, url, body });
        let hit = fixtures[`${method} ${p}`];
        if (hit === undefined && method === 'PATCH' && /^\/api\/students\/3\/retrain-items\/\d+$/.test(p)) {
            const id = Number(p.split('/').pop());
            const found = [...LIST.items, ...LIST_ALL_EXTRA].find(i => i.item_id === id);
            hit = [200, { ...found, group_changed: [] }];
        }
        if (hit === undefined) return Promise.resolve(new Response(JSON.stringify({ message: 'no fixture' }), { status: 404 }));
        const out = typeof hit === 'function' ? hit(body, url) : (Array.isArray(hit) ? hit : [200, hit]);
        if (out instanceof Response) return Promise.resolve(out);
        const [status, payload] = Array.isArray(out) ? out : [200, out];
        return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    };
    return { apiFetch, calls };
}

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

const META = (over = {}) => ({
    'feature-students': 'true', 'feature-similar': 'true', 'feature-variants': 'false', 'feature-retrain': 'true', ...over
});

/**
 * 把學生分頁與錯題重練卡一起掛起來（兩支都在 import 當下自動掛載，同瀏覽器裡的 <script type="module">）。
 * @param {{meta?:object, api?:object, before?:(env)=>void}} [opts]
 */
async function mount({ meta = {}, api = fakeApi(), before } = {}) {
    env = install({ meta: META(meta), sections: ['students', 'retrain'], search: '', examApp: fakeBridge({ apiFetch: api.apiFetch }) });
    if (before) before(env);
    const students = await loadFresh('students.js');
    const retrain = await loadFresh('retrain.js');
    await settle();
    return { students, retrain, api };
}

const $ = id => env.document.getElementById(id);
const toasts = () => env.window.ExamApp.calls.toasts.map(t => t.message);
const rows = () => env.document.querySelectorAll('[data-retrain-item]');
const rowOf = qid => rows().find(r => r.getAttribute('data-question-id') === String(qid));
const badgesOf = qid => rowOf(qid).querySelectorAll('[data-badge]').map(b => [b.getAttribute('data-badge'), b.textContent]);
const actionBtn = (qid, action) => rowOf(qid).querySelectorAll('[data-retrain-action]').find(b => b.getAttribute('data-retrain-action') === action);
const lastCall = (api, method, pathRe) => api.calls.filter(c => c.method === method && pathRe.test(c.path)).pop();

async function openPaper() {
    const card = env.document.querySelectorAll('[data-paper-id="41"]')[0];
    card.children[0].click();
    await settle(6);
    return card;
}
const saveBtn = card => card.querySelectorAll('button').find(b => b.textContent === '儲存批改');
const resultBtn = (card, i, label) => card.querySelectorAll('[role="radiogroup"]')[i].children.find(b => b.textContent === label);

// ═════════════ 1. 檔案層級契約 ═════════════

describe('契約：旗標、接點與事件名', () => {
    test('retrain.js 從 <meta name="feature-retrain"> 讀旗標，parseBool 與後端逐字相同；不用 innerHTML 塞字串', async () => {
        const src = source('retrain.js');
        assert.ok(src.includes('meta[name="feature-retrain"]'));
        assert.ok(src.includes("v === '1' || v === 'true'"));
        assert.ok(src.includes('整段不渲染'));
        assert.ok(!/\.innerHTML\s*=/.test(src), 'retrain.js 一律用 textContent／createElement，不寫 innerHTML');
        assert.ok(!/insertAdjacentHTML|outerHTML\s*=/.test(src));
        const { parseBool } = await loadFresh('retrain.js');
        const { parseBool: backend } = require('../../config/features');
        for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', 'off', '', null, undefined, '__FEATURE_RETRAIN__']) {
            assert.equal(parseBool(v), backend(v), `「${v}」兩邊解讀不同`);
        }
    });

    test('index.html：<section id="retrain"> 在學生視圖、緊接在 #students 之後；module 排在 students.js 之後；#retrain 對應學生視圖', () => {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        const view = html.slice(html.indexOf('<div id="view-students"'), html.indexOf('<!-- /view-students -->'));
        assert.ok(view.includes('<section id="retrain"></section>'), '錯題重練卡的錨點要在學生視圖裡');
        assert.ok(view.indexOf('<section id="students">') < view.indexOf('<section id="retrain">'), '放在弱點面板（#students）之後');
        assert.ok(html.indexOf('src="/js/students.js"') < html.indexOf('<script type="module" src="/js/retrain.js">'));
        assert.ok(html.includes("VIEW_FOR_ANCHOR.retrain = 'view-students';"));
        assert.ok(html.includes('<meta name="feature-retrain" content="__FEATURE_RETRAIN__">'));
        // npm run check:html 的逐頁契約涵蓋 retrain.js，且 students.js 必須讀同一個 meta
        assert.deepEqual(check.RETRAIN_PAGES.map(p => p.id), ['retrain']);
        assert.deepEqual(check.RETRAIN_EXTRA_METAS.map(m => [m.meta, m.reader]), [['feature-retrain', 'public/js/students.js']]);
        assert.deepEqual(check.checkContracts(), []);
    });

    test('兩支 module 的事件名一致；「找相似」沿用 students.js 的 VARIANT_EVENT', async () => {
        const s = await loadFresh('students.js');
        const r = await loadFresh('retrain.js');
        assert.equal(r.STUDENT_VIEW_EVENT, s.STUDENT_VIEW_EVENT);
        assert.equal(r.RETRAIN_CHANGED_EVENT, s.RETRAIN_CHANGED_EVENT);
        assert.equal(r.VARIANT_EVENT, s.VARIANT_EVENT);
    });
});

// ═════════════ 2. 純函式 ═════════════

describe('retrain.js 的純函式', () => {
    test('itemBadges：到期／已派出卷 #…（超過 14 天另提醒）／卡關／已封存', async () => {
        const { itemBadges } = await loadFresh('retrain.js');
        assert.deepEqual(itemBadges(LIST.items[0]).map(b => b.text), ['到期', '卡關']);
        assert.deepEqual(itemBadges(LIST.items[3]).map(b => [b.kind, b.text]),
            [['in_flight', '已派出卷 #91'], ['in_flight_warn', '派出超過 14 天還沒批改']]);
        assert.deepEqual(itemBadges({ ...LIST.items[3], in_flight_paper_id: null, in_flight_warn: false }).map(b => b.text), ['已派出'],
            'MySQL 時期的舊紀錄沒有卷號');
        assert.deepEqual(itemBadges(LIST.items[4]).map(b => b.kind), ['archived']);
        assert.deepEqual(itemBadges(LIST.items[2]), []);
    });

    test('stageText／dueText／streakText：逾期才標紅；練到會與移出不再到期', async () => {
        const { stageText, dueText, streakText } = await loadFresh('retrain.js');
        assert.equal(stageText(LIST.items[1]), '第 2 關・一週回測');
        assert.equal(stageText(LIST_ALL_EXTRA[0]), '練到會（2026-10-05）');
        assert.equal(stageText(LIST_ALL_EXTRA[1]), '已移出（2026-10-06）');
        assert.deepEqual(dueText(LIST.items[0]), { text: '逾期 5 天（2026-10-07 到期）', overdue: true });
        assert.deepEqual(dueText({ ...LIST.items[0], overdue_days: 0, due_on: '2026-10-12' }), { text: '到期（2026-10-12）', overdue: false });
        assert.deepEqual(dueText(LIST.items[2]), { text: '下次到期 2026-10-20', overdue: false });
        assert.deepEqual(dueText(LIST.items[3]), { text: '下次到期 2026-09-21（已派出，批改後重算）', overdue: false },
            '已派出的題不算逾期（伺服器的 overdue_days 是 0）');
        assert.deepEqual(dueText(LIST_ALL_EXTRA[0]), { text: '不再到期', overdue: false });
        assert.equal(streakText(LIST.items[0]), '連對 0 次・錯 3 次');
    });

    test('historyLine／resultText：部分給分沒滿分的重練題標「算錯」（R2）；錯因用標籤', async () => {
        const { historyLine, resultText } = await loadFresh('retrain.js');
        const [first, again] = LIST.items[0].history;
        assert.equal(historyLine(first, c => (c === 'calc' ? '計算錯誤' : c)), '2026-10-01　·　卷 #88　·　第一次（新題）　·　錯　·　錯因：計算錯誤');
        assert.equal(historyLine(again), '2026-10-05　·　卷 #91　·　重練・第 1 關　·　給分 80%（未滿分，算錯）');
        assert.equal(resultText({ purpose: 'retrain', result: 1, score: 1 }), '給分 100%');
        assert.equal(resultText({ purpose: 'new', result: 0, score: 0.5 }), '給分 50%');
        assert.equal(resultText({ purpose: 'retrain', result: null, score: null }), '未批');
        assert.ok(historyLine({ ...first, paper_id: null }).includes('（沒有對應的卷）'));
    });

    test('actionsFor／actionBody／actionToast', async () => {
        const { actionsFor, actionBody, actionToast } = await loadFresh('retrain.js');
        assert.deepEqual(actionsFor(LIST.items[0], { similar: true }), ['retire', 'mark_mastered', 'similar']);
        assert.deepEqual(actionsFor(LIST_ALL_EXTRA[0]), ['reactivate', 'retire']);
        assert.deepEqual(actionsFor(LIST_ALL_EXTRA[1]), ['reactivate']);
        assert.deepEqual(actionBody('retire'), { action: 'retire' });
        assert.equal(actionToast('retire', { question_id: 640 }, { group_changed: [{ item_id: 41, question_id: 641 }] }),
            '已把 #640 移出清單；同組的 #641 一起移出。');
        assert.equal(actionToast('reactivate', { question_id: 901 }, { group_changed: [] }),
            '已重新加入 #901，從第 1 關重來（錯的次數保留）。');
    });

    test('parseQuestionIds／addResultMessages', async () => {
        const { parseQuestionIds, addResultMessages } = await loadFresh('retrain.js');
        assert.deepEqual(parseQuestionIds('#812, 640 640、641，abc 0 2147483648'),
            { ids: [812, 640, 641], invalid: ['abc', '0', '2147483648'] });
        assert.deepEqual(parseQuestionIds(''), { ids: [], invalid: [] });
        assert.deepEqual(addResultMessages({
            added: [{ question_id: 812, item_id: 90, reason: 'manual' }, { question_id: 813, item_id: 91, reason: 'group' }],
            skipped: [{ question_id: 640, reason: 'already_in_schedule' }, { question_id: 5, reason: 'not_assigned' }, { question_id: 6, reason: 'not_assigned' }]
        }), [
            { type: 'success', message: '已加入 #812，從第 1 關開始排程；承上組的 #813 一起加入。' },
            { type: 'info', message: '沒有加入 #640：已在清單上（已移出的請在清單上按「重新加入」）；#5、#6：沒有派給這位學生過。' }
        ]);
        assert.deepEqual(addResultMessages({ added: [], skipped: [{ question_id: 9, reason: 'archived' }] }),
            [{ type: 'error', message: '沒有加入 #9：題目已封存。' }]);
    });

    test('formatRate／rateText：null（沒有批改過的）顯示「—」不是 0%', async () => {
        const { formatRate, rateText } = await loadFresh('retrain.js');
        assert.equal(formatRate(0.6667), '66.7%');
        assert.equal(formatRate(1), '100.0%');
        assert.equal(formatRate(null), '—');
        assert.equal(rateText(STATS.first_retrain), '66.7%（12／18）');
        assert.equal(rateText({ graded: 0, correct: 0, rate: null }), '—（這段期間還沒有批改過的）');
    });

    test('API-5／API-7／API-12 的 body：題數 1–50、科目與預計作答日有選才帶；確認帶 retrain_question_ids；Word 帶 paper_id', async () => {
        const m = await loadFresh('retrain.js');
        assert.equal(m.parseCount('10'), 10);
        for (const bad of ['0', '51', '1.5', '', 'x', '-3']) assert.equal(m.parseCount(bad), null, bad);
        assert.deepEqual(m.retrainPaperBody({ count: 10, subject: '', asOf: '', includeNotDue: false }), { count: 10 });
        assert.deepEqual(m.retrainPaperBody({ count: 8, subject: '數學', asOf: '2026-10-15', includeNotDue: true }),
            { count: 8, subject: '數學', as_of: '2026-10-15', include_not_due: true });

        const draft = m.draftFromResponse(DRAFT, { id: 3, name: '示範學生' });
        assert.deepEqual(m.draftGroups(draft).map(g => g.items.map(i => i.question_id)), [[812], [640, 641]]);
        const cut = m.removeGroup(draft, 641);
        assert.deepEqual(cut.items.map(i => i.question_id), [812], '承上組整組刪');
        assert.deepEqual(m.confirmBody(draft), { student_id: 3, question_ids: [812, 640, 641], retrain_question_ids: [812, 640, 641] });

        const paper = { paper_id: 95, paper_title: '示範學生-錯題重練卷(2026_10_12)', student_name: '示範學生', question_ids: [812] };
        assert.deepEqual(m.wordDownloadRequest(paper, 'solution'), {
            body: { paper_title: paper.paper_title, student_name: '示範學生', question_ids: [812], edition: 'solution', paper_id: 95 },
            filename: '示範學生-錯題重練卷(2026_10_12)（詳解版）.docx'
        });
        assert.equal(m.wordDownloadRequest(paper, 'bogus').body.edition, 'standard');
    });
});

describe('students.js 的〔retrain PR-4〕純函式', () => {
    test('diffResults：retrain 只在改過時送；旗標關閉（列上沒有這個鍵）輸出逐位元不變', async () => {
        const { diffResults } = await loadFresh('students.js');
        const before = [
            { question_id: 1, result: 0, retrain: false },
            { question_id: 2, result: null, retrain: true },
            { question_id: 3, result: 1, retrain: false }
        ];
        const after = [
            { question_id: 1, result: 0, retrain: true },     // 勾
            { question_id: 2, result: null, retrain: false }, // 取消
            { question_id: 3, result: 1, retrain: false }     // 沒改
        ];
        assert.deepEqual(diffResults(before, after), [
            { question_id: 1, result: 0, retrain: true },
            { question_id: 2, result: null, retrain: false }
        ]);
        const plain = diffResults([{ question_id: 8, result: null }], [{ question_id: 8, result: 0 }]);
        assert.deepEqual(plain, [{ question_id: 8, result: 0 }]);
        assert.deepEqual(Object.keys(plain[0]), ['question_id', 'result']);
    });

    test('retrainSaveMessage：「3 題進入重練清單、1 題練到會。」；答錯沒勾另外提醒；沒有變化回空字串', async () => {
        const { retrainSaveMessage } = await loadFresh('students.js');
        assert.equal(retrainSaveMessage({ entered: 3, advanced: 0, mastered: 1, reset: 0 }), '3 題進入重練清單、1 題練到會。');
        assert.equal(retrainSaveMessage({ entered: 0, advanced: 2, mastered: 0, reset: 1 }), '2 題升一關、1 題答錯回到第 1 關。');
        assert.equal(retrainSaveMessage({ entered: 0, advanced: 0, mastered: 0, reset: 0 }, 2), '這次有 2 題答錯但沒勾「要重練」，不會進清單。');
        assert.equal(retrainSaveMessage({ entered: 0, advanced: 0, mastered: 0, reset: 0 }), '');
        assert.equal(retrainSaveMessage(undefined), '');
    });

    test('retrainOptionLabel：到期徽章接在名字後面；沒有到期維持原文字', async () => {
        const { retrainOptionLabel } = await loadFresh('students.js');
        assert.equal(retrainOptionLabel('示範學生（2 卷，已批 50.0%）', '示範學生', 3), '示範學生【到期 3】（2 卷，已批 50.0%）');
        assert.equal(retrainOptionLabel('示範學生（2 卷，已批 50.0%）', '示範學生', 0), '示範學生（2 卷，已批 50.0%）');
    });
});

// ═════════════ 3. 真的渲染起來 ═════════════

describe('旗標關閉：以上全部不渲染、不發任何新請求', () => {
    test('#retrain 是空的；沒有任何 retrain 請求與事件；批改卡沒有勾選框與徽章，PATCH 不帶 retrain；學生清單沒有徽章', async () => {
        let viewEvents = 0;
        const api = fakeApi();
        await mount({
            meta: { 'feature-retrain': 'false' }, api,
            before: e => e.document.addEventListener('examapp:student-view', () => { viewEvents += 1; })
        });
        assert.equal($('retrain').children.length, 0, '整段不渲染（連空殼都不掛）');
        assert.equal($('retrain').textContent, '');
        assert.deepEqual(api.calls.filter(c => /retrain/.test(c.path)).map(c => c.url), [], '不發任何新請求');
        assert.equal(viewEvents, 0, '不發 examapp:student-view');
        assert.deepEqual($('stuStudent').options.map(o => o.textContent), ['示範學生（2 卷，已批 50.0%）', '第二位（1 卷，已批 0.0%）']);

        // 就算伺服器帶了 purpose（兩邊旗標不一致），畫面也不畫新元件、PATCH 也不送 retrain
        const card = await openPaper();
        assert.equal(card.querySelectorAll('[data-retrain-flag]').length, 0);
        assert.equal(card.querySelectorAll('[data-retrain-badge]').length, 0);
        assert.equal(card.querySelectorAll('input').filter(i => i.getAttribute('type') === 'checkbox' || i.type === 'checkbox').length, 0);
        resultBtn(card, 3, '錯').click();
        saveBtn(card).click();
        await settle(4);
        assert.deepEqual(lastCall(api, 'PATCH', /results$/).body, { results: [{ question_id: 14, result: 0 }] });
        assert.equal(toasts().filter(t => t.includes('重練')).length, 0);
        assert.deepEqual(api.calls.filter(c => /retrain/.test(c.path)), []);
    });

    test('FEATURE_STUDENTS 關閉（學生分頁不存在）時錯題重練卡也不渲染', async () => {
        const api = fakeApi();
        await mount({ meta: { 'feature-students': 'false' }, api });
        assert.equal($('retrain').children.length, 0);
        assert.deepEqual(api.calls, []);
    });
});

describe('錯題重練卡：清單、徽章與四個數字', () => {
    test('跟著學生分頁選的學生載入；清單照伺服器的順序（第 4.7 節，不重排）；四個數字；逾期標紅', async () => {
        const { api } = await mount();
        assert.deepEqual(rows().map(r => Number(r.getAttribute('data-question-id'))), [812, 640, 641, 700, 705]);
        const count = key => env.document.querySelectorAll(`[data-count-value="${key}"]`)[0].textContent;
        assert.deepEqual(['due', 'active', 'mastered', 'stuck'].map(count), ['3', '5', '2', '1']);

        const listCall = lastCall(api, 'GET', /\/retrain-items$/);
        assert.equal(listCall.url, '/api/students/3/retrain-items?status=active', '不分科時不帶 subject；預計作答日空白時不帶 as_of');
        assert.equal(lastCall(api, 'GET', /\/retrain-stats$/).url, '/api/students/3/retrain-stats?days=365', '時間窗跟著學生分頁（預設 365 天）');

        assert.deepEqual(badgesOf(812), [['due', '到期'], ['stuck', '卡關']]);
        assert.deepEqual(badgesOf(700), [['in_flight', '已派出卷 #91'], ['in_flight_warn', '派出超過 14 天還沒批改']]);
        assert.deepEqual(badgesOf(705), [['archived', '已封存']]);
        assert.deepEqual(badgesOf(641), []);

        const due812 = rowOf(812).querySelectorAll('[data-retrain-due="812"]')[0];
        assert.equal(due812.textContent, '逾期 5 天（2026-10-07 到期）');
        assert.equal(due812.getAttribute('data-overdue'), 'true');
        assert.ok(due812.className.includes('text-rose-600'), '逾期標紅');
        assert.ok(!rowOf(641).querySelectorAll('[data-retrain-due="641"]')[0].className.includes('rose'));
        assert.equal(rowOf(640).querySelectorAll('[data-retrain-stage="640"]')[0].textContent, '第 2 關・一週回測');
        assert.equal(rowOf(812).querySelectorAll('[data-retrain-streak="812"]')[0].textContent, '連對 0 次・錯 3 次');
        assert.equal(rowOf(641).getAttribute('data-group'), '640,641', '承上組標出來');
        assert.ok(rowOf(641).textContent.includes('承上 #640'));
        assert.ok(rowOf(705).textContent.includes('備註：課本例題'));
        assert.ok(rowOf(705).textContent.includes('手動加入'));
        // 統計與清單都只打給目前的學生
        assert.ok(api.calls.filter(c => /retrain-(items|stats)/.test(c.path)).every(c => c.path.startsWith('/api/students/3/')));
    });

    test('展開作答歷史：第一次（新題）與重練第 n 關、錯因標籤（GET /api/error-types）', async () => {
        const { api } = await mount();
        const toggle = rowOf(812).querySelectorAll('[data-retrain-history-toggle="812"]')[0];
        assert.equal(toggle.textContent, '作答歷史（2 筆）');
        const box = rowOf(812).querySelectorAll('[data-retrain-history="812"]')[0];
        assert.ok(box.classList.contains('hidden'));
        toggle.click();
        await settle(4);
        assert.ok(!box.classList.contains('hidden'));
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.deepEqual(box.children.map(p => p.textContent), [
            '2026-10-01　·　卷 #88　·　第一次（新題）　·　錯　·　錯因：計算錯誤',
            '2026-10-05　·　卷 #91　·　重練・第 1 關　·　給分 80%（未滿分，算錯）'
        ]);
        assert.ok(api.calls.some(c => c.path === '/api/error-types'));
    });

    test('篩選：下拉選「全部」、點「到期」數字 → 帶對應的 status；科目與預計作答日跟著帶', async () => {
        const { api } = await mount();
        $('rtStatus').value = 'all';
        $('rtStatus').dispatchEvent({ type: 'change' });
        await settle();
        assert.equal(lastCall(api, 'GET', /\/retrain-items$/).url, '/api/students/3/retrain-items?status=all');
        assert.deepEqual(rows().map(r => Number(r.getAttribute('data-question-id'))), [812, 640, 641, 700, 705, 900, 901]);

        env.document.querySelectorAll('[data-retrain-count="due"]')[0].click();
        await settle();
        assert.equal(lastCall(api, 'GET', /\/retrain-items$/).url, '/api/students/3/retrain-items?status=due');
        assert.equal($('rtStatus').value, 'due');
        assert.equal(env.document.querySelectorAll('[data-retrain-count="due"]')[0].getAttribute('aria-pressed'), 'true');

        $('rtAsOf').value = '2026-10-15';
        $('rtAsOf').dispatchEvent({ type: 'change' });
        await settle();
        assert.equal(lastCall(api, 'GET', /\/retrain-items$/).url, '/api/students/3/retrain-items?status=due&as_of=2026-10-15');

        // 學生分頁上方換科目 → 學生視圖重載 → 卡片跟著帶 subject
        $('stuSubject').value = '數學';
        $('stuSubject').dispatchEvent({ type: 'change' });
        await settle();
        assert.equal(lastCall(api, 'GET', /\/retrain-items$/).url, '/api/students/3/retrain-items?status=due&subject=%E6%95%B8%E5%AD%B8&as_of=2026-10-15');
        assert.equal(lastCall(api, 'GET', /\/retrain-stats$/).url, '/api/students/3/retrain-stats?days=365&subject=%E6%95%B8%E5%AD%B8');
    });

    test('換學生：清單與統計改打那位學生；空清單說明怎麼加（不會自動補建）', async () => {
        const { api } = await mount();
        $('stuStudent').value = '4';
        $('stuStudent').dispatchEvent({ type: 'change' });
        await settle();
        assert.equal(lastCall(api, 'GET', /\/retrain-items$/).path, '/api/students/4/retrain-items');
        assert.equal(rows().length, 0);
        assert.ok($('rtMessage').textContent.includes('勾「要重練」'));
        assert.ok($('rtMessage').textContent.includes('不會自動補進來'));
        assert.equal($('rtStats').querySelectorAll('[data-stat="first_retrain"]')[0].textContent,
            '第一次重練答對率（第 1 關）—（這段期間還沒有批改過的）');
    });
});

describe('錯題重練卡：動作按鈕送出的 body', () => {
    test('移出：按第二次才送 PATCH { action: "retire" }；同組一起移出的提示；之後重載清單並更新到期徽章', async () => {
        const api = fakeApi({
            'PATCH /api/students/3/retrain-items/40': body => [200, { ...LIST.items[1], status: 'retired', group_changed: [{ item_id: 41, question_id: 641 }] }]
        });
        await mount({ api });
        const before = api.calls.length;
        const btn = actionBtn(640, 'retire');
        btn.click();
        await settle(2);
        assert.equal(api.calls.filter(c => c.method === 'PATCH').length, 0, '第一次只是準備');
        assert.equal(btn.textContent, '再按一次確認移出');
        btn.click();
        await settle();
        const patch = lastCall(api, 'PATCH', /retrain-items\/40$/);
        assert.deepEqual([patch.url, patch.body], ['/api/students/3/retrain-items/40', { action: 'retire' }]);
        assert.ok(toasts().includes('已把 #640 移出清單；同組的 #641 一起移出。'), toasts().join('|'));
        const after = api.calls.slice(before);
        assert.ok(after.some(c => c.method === 'GET' && c.path === '/api/students/3/retrain-items'), '重載清單');
        assert.ok(after.some(c => c.method === 'GET' && c.path === '/api/retrain/summary'), 'students.js 更新到期徽章');
    });

    test('判定已會：PATCH { action: "mark_mastered" }；重新加入（已移出的題）一按就送 { action: "reactivate" }；409 原樣顯示', async () => {
        const api = fakeApi({
            'PATCH /api/students/3/retrain-items/80': [409, { message: '這一題正在重練中，不需要重新加入。' }]
        });
        await mount({ api });
        const m = actionBtn(812, 'mark_mastered');
        m.click(); m.click();
        await settle();
        assert.deepEqual(lastCall(api, 'PATCH', /retrain-items\/31$/).body, { action: 'mark_mastered' });

        $('rtStatus').value = 'retired';
        $('rtStatus').dispatchEvent({ type: 'change' });
        await settle();
        assert.deepEqual(actionsOf(901), ['reactivate', 'similar'], '已移出的題只有「重新加入」（與找相似）');
        actionBtn(901, 'reactivate').click();
        await settle();
        assert.deepEqual(lastCall(api, 'PATCH', /retrain-items\/80$/).body, { action: 'reactivate' });
        assert.ok(toasts().includes('這一題正在重練中，不需要重新加入。'));
    });

    test('找相似：發既有的 examapp:variant-request（action = similar）；FEATURE_SIMILAR 關閉時不畫', async () => {
        const seen = [];
        await mount({ before: e => e.document.addEventListener('examapp:variant-request', ev => seen.push(ev.detail)) });
        actionBtn(812, 'similar').click();
        assert.deepEqual(seen, [{
            action: 'similar', question_id: 812, student_id: 3, chapter: '向量內積',
            question_text: '設 $\\vec a=(1,2)$，求 $|\\vec a|$。'
        }]);
        env.restore();
        env = null;
        await mount({ meta: { 'feature-similar': 'false' } });
        assert.equal(actionBtn(812, 'similar'), undefined);
    });
});

function actionsOf(qid) {
    return rowOf(qid).querySelectorAll('[data-retrain-action]').map(b => b.getAttribute('data-retrain-action'));
}

describe('錯題重練卡：手動加入題號（API-2）', () => {
    test('看不懂的題號不送；合法的去重後送 { question_ids }，提示加入與略過的原因，清空輸入框', async () => {
        const api = fakeApi({
            'POST /api/students/3/retrain-items': {
                added: [{ question_id: 812, item_id: 90, reason: 'manual' }, { question_id: 813, item_id: 91, reason: 'group' }],
                skipped: [{ question_id: 640, reason: 'already_in_schedule' }]
            }
        });
        await mount({ api });
        $('rtAddIds').value = 'abc, 12';
        $('rtAddBtn').click();
        await settle(3);
        assert.ok(toasts().includes('看不懂的題號：abc'));
        assert.equal(api.calls.filter(c => c.method === 'POST').length, 0);

        $('rtAddIds').value = '#812, 640 640';
        $('rtAddBtn').click();
        await settle();
        const post = lastCall(api, 'POST', /retrain-items$/);
        assert.deepEqual([post.path, post.body], ['/api/students/3/retrain-items', { question_ids: [812, 640] }]);
        assert.ok(toasts().includes('已加入 #812，從第 1 關開始排程；承上組的 #813 一起加入。'), toasts().join('|'));
        assert.ok(toasts().includes('沒有加入 #640：已在清單上（已移出的請在清單上按「重新加入」）。'));
        assert.equal($('rtAddIds').value, '');
    });
});

describe('錯題重練卡：出一份重練卷（API-5 → API-7 → API-12）', () => {
    test('草稿 → 刪整組 → 確認帶 retrain_question_ids → 下載 Word 帶 paper_id；試卷列表跟著重載', async () => {
        const api = fakeApi();
        await mount({ api });
        $('rtPaperBtn').click();
        await settle();
        const gen = lastCall(api, 'POST', /retrain-paper$/);
        assert.deepEqual([gen.path, gen.body], ['/api/students/3/retrain-paper', { count: 10 }], '預設 10 題、不分科不帶 subject');

        const draft = $('rtDraft');
        assert.deepEqual(draft.querySelectorAll('div[data-question-id]').map(d => Number(d.getAttribute('data-question-id'))), [812, 640, 641]);
        assert.ok(draft.textContent.includes('重練卷草稿（尚未出卷）　·　3 題　·　到期共 6 題'));
        assert.equal($('rtNotes').children[0].textContent, DRAFT.notes[0]);
        const del641 = draft.querySelectorAll('div[data-question-id="641"]')[0].querySelectorAll('button')[0];
        assert.equal(del641.textContent, '刪這組', '承上組的刪除鈕是整組刪');
        del641.click();
        assert.deepEqual($('rtDraft').querySelectorAll('div[data-question-id]').map(d => Number(d.getAttribute('data-question-id'))), [812]);

        const papersBefore = api.calls.filter(c => c.path === '/api/students/3/papers').length;
        $('rtConfirm').click();
        await settle();
        const confirm = lastCall(api, 'POST', /confirm-paper$/);
        assert.deepEqual(confirm.body, { student_id: 3, question_ids: [812], retrain_question_ids: [812] });
        assert.ok($('rtResult').textContent.includes('已出卷：示範學生-錯題重練卷(2026_10_12)（1 題）'));
        assert.equal($('rtDraft').children.length, 0, '確認後草稿清空');
        assert.ok(api.calls.filter(c => c.path === '/api/students/3/papers').length > papersBefore, '新卷要出現在試卷列表（可以批改）');

        assert.deepEqual($('rtWordEdition').querySelectorAll('option').map(o => o.getAttribute('value')), ['standard', 'student', 'solution']);
        $('rtDownload').click();
        await settle(4);
        $('rtWordEdition').value = 'solution';
        $('rtDownload').click();
        await settle(4);
        const words = api.calls.filter(c => c.path === '/api/download-word');
        assert.deepEqual(words.map(w => w.body), [
            { paper_title: '示範學生-錯題重練卷(2026_10_12)', student_name: '示範學生', question_ids: [812], edition: 'standard', paper_id: 95 },
            { paper_title: '示範學生-錯題重練卷(2026_10_12)', student_name: '示範學生', question_ids: [812], edition: 'solution', paper_id: 95 }
        ]);
    });

    test('題數、科目、預計作答日、也放還沒到期的題都照畫面送；題數不合法不送', async () => {
        const api = fakeApi();
        await mount({ api });
        $('rtPaperCount').value = '0';
        $('rtPaperBtn').click();
        await settle(3);
        assert.ok(toasts().includes('題數要是 1–50 的整數。'));
        assert.equal(api.calls.filter(c => /retrain-paper/.test(c.path)).length, 0);

        $('stuSubject').value = '數學';
        $('stuSubject').dispatchEvent({ type: 'change' });
        await settle();
        $('rtAsOf').value = '2026-10-15';
        $('rtAsOf').dispatchEvent({ type: 'change' });
        await settle();
        $('rtPaperCount').value = '8';
        $('rtIncludeNotDue').checked = true;
        $('rtPaperBtn').click();
        await settle();
        assert.deepEqual(lastCall(api, 'POST', /retrain-paper$/).body,
            { count: 8, subject: '數學', as_of: '2026-10-15', include_not_due: true });
    });

    test('R12：承上組整組放不下 → 伺服器 400 的訊息原樣顯示，不產生草稿', async () => {
        const msg = '到期的承上題組（題 812、813、814）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 5 或 8。';
        await mount({ api: fakeApi({ 'POST /api/students/3/retrain-paper': [400, { message: msg }] }) });
        $('rtPaperBtn').click();
        await settle();
        assert.ok(toasts().includes(msg));
        assert.equal($('rtDraft').children.length, 0);
    });

    test('確認時 409（項目狀態已改變）原樣顯示，草稿保留', async () => {
        const msg = '題目 812 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。';
        await mount({ api: fakeApi({ 'POST /api/confirm-paper': [409, { message: msg }] }) });
        $('rtPaperBtn').click();
        await settle();
        $('rtConfirm').click();
        await settle();
        assert.ok(toasts().includes(msg));
        assert.equal($('rtDraft').querySelectorAll('div[data-question-id]').length, 3);
        assert.equal($('rtResult').children.length, 0);
    });
});

describe('錯題重練卡：重練成效（API-13）', () => {
    test('第一次重練與隔週回測答對率、題數、到期與逾期、依章節', async () => {
        await mount();
        const stat = key => $('rtStats').querySelectorAll(`[data-stat="${key}"]`)[0];
        assert.equal(stat('first_retrain').children[1].textContent, '66.7%（12／18）');
        assert.equal(stat('spaced').children[1].textContent, '85.0%（17／20）');
        assert.equal(stat('entered').children[1].textContent, '25 題（進行中 14・練到會 9・已移出 2）');
        assert.equal(stat('stuck').children[1].textContent, '1 題');
        assert.equal(stat('backlog').children[1].textContent, '6 題（逾期 7 天以上 2 題）');
        const chapterRows = stat('by_chapter').querySelectorAll('tbody tr').map(tr => tr.children.map(td => td.textContent));
        assert.deepEqual(chapterRows, [['向量內積', '5', '3', '2', '0'], ['（未分類）', '1', '1', '0', '1']]);
        assert.ok($('rtStats').textContent.includes('近 365 天'));
    });

    test('API-13 失敗時說明原因，清單照常', async () => {
        await mount({ api: fakeApi({ 'GET /api/students/3/retrain-stats': [400, { message: 'days 必須是 1~365 的整數。' }] }) });
        assert.ok($('rtStats').textContent.includes('重練成效載入失敗：days 必須是 1~365 的整數。'));
        assert.equal(rows().length, 5);
    });
});

describe('批改卡（students.js 最小掛鉤）', () => {
    test('新題有「要重練」勾選框，預設不勾（答錯也不自動勾），之前勾過的依 retrain_flagged 顯示已勾；重練題改標徽章', async () => {
        await mount();
        const card = await openPaper();
        const flag = qid => card.querySelectorAll(`[data-retrain-flag="${qid}"]`)[0];
        assert.equal(flag(11).checked, false, '答錯也不自動勾');
        assert.equal(flag(12).checked, true, '之前勾過的顯示已勾');
        assert.equal(flag(14).checked, false);
        assert.equal(flag(13), undefined, '重練題不給勾選框');
        assert.equal(card.querySelectorAll('[data-retrain-badge="13"]')[0].textContent, '重練・第 2 關');
        assert.equal(card.querySelectorAll('[data-retrain-badge]').length, 1);
        assert.equal(card.querySelectorAll('[role="radiogroup"]').length, 4, '對錯按鈕的結構不變');
        assert.equal(flag(11).parentNode.textContent, '要重練');
    });

    test('只送改過的勾選：勾 → retrain: true；取消 → retrain: false；勾了又取消 → 不送', async () => {
        const api = fakeApi();
        await mount({ api });
        let card = await openPaper();
        const toggle = (qid, v) => {
            const box = card.querySelectorAll(`[data-retrain-flag="${qid}"]`)[0];
            box.checked = v;
            box.dispatchEvent({ type: 'change', target: box });
        };
        toggle(11, true);
        toggle(12, false);
        toggle(14, true);
        toggle(14, false);
        saveBtn(card).click();
        await settle(4);
        assert.deepEqual(lastCall(api, 'PATCH', /results$/).body, {
            results: [{ question_id: 11, result: 0, retrain: true }, { question_id: 12, result: null, retrain: false }]
        });
    });

    test('儲存後依 API-10 的 retrain 摘要提示；這次改成錯卻沒勾的另外提醒', async () => {
        const api = fakeApi({
            'PATCH /api/papers/41/results': body => [200, { updated: body.results.length, retrain: { entered: 3, advanced: 0, mastered: 1, reset: 0 } }]
        });
        await mount({ api });
        const card = await openPaper();
        resultBtn(card, 3, '錯').click();   // 第 14 題改成錯、沒勾
        saveBtn(card).click();
        await settle(4);
        assert.deepEqual(lastCall(api, 'PATCH', /results$/).body, { results: [{ question_id: 14, result: 0 }] }, '沒動勾選就不送 retrain');
        assert.ok(toasts().includes('已儲存 1 題的批改結果。'), '既有提示不變');
        assert.ok(toasts().includes('3 題進入重練清單、1 題練到會。這次有 1 題答錯但沒勾「要重練」，不會進清單。'), toasts().join('|'));
    });
});

describe('學生清單的「到期 N」（API-4）', () => {
    test('名字旁顯示到期題數；沒有到期的不加；清單變了（retrain-changed）就更新、不疊字', async () => {
        let summary = clone(SUMMARY);
        await mount({ api: fakeApi({ 'GET /api/retrain/summary': () => [200, summary] }) });
        const labels = () => $('stuStudent').options.map(o => o.textContent);
        assert.deepEqual(labels(), ['示範學生【到期 3】（2 卷，已批 50.0%）', '第二位（1 卷，已批 0.0%）']);
        assert.deepEqual($('stuStudent').options.map(o => o.getAttribute('data-name')), ['示範學生', '第二位'], 'data-name 不變（立即批改靠它比對）');

        summary = { as_of: '2026-10-12', items: [{ student_id: 3, due: 1, in_flight: 0, stuck: 0, active: 1 }, { student_id: 4, due: 2, in_flight: 0, stuck: 0, active: 2 }] };
        env.document.dispatchEvent(new CustomEvent('examapp:retrain-changed', { detail: { student_id: 3, papers_changed: false } }));
        await settle();
        assert.deepEqual(labels(), ['示範學生【到期 1】（2 卷，已批 50.0%）', '第二位【到期 2】（1 卷，已批 0.0%）']);
        summary = { as_of: '2026-10-12', items: [] };
        env.document.dispatchEvent(new CustomEvent('examapp:retrain-changed', { detail: { student_id: 3, papers_changed: false } }));
        await settle();
        assert.deepEqual(labels(), ['示範學生（2 卷，已批 50.0%）', '第二位（1 卷，已批 0.0%）']);
    });
});

describe('伺服器文字一律 textContent', () => {
    test('章節、題幹、關卡名稱、備註、草稿、錯誤訊息裡的 HTML 原樣顯示成文字，不會長出元素', async () => {
        const evil = '<img src=x onerror=alert(1)>';
        const list = clone(LIST);
        Object.assign(list.items[0], { chapter: evil, question_text_preview: '<b>粗體</b>', step_label: '<i>x</i>', note: '<script>alert(1)</script>' });
        list.items[0].history[0].error_types = ['<u>zz</u>'];
        const draft = clone(DRAFT);
        draft.items[0].question_text_preview = evil;
        draft.notes = ['<b>注意</b>'];
        const api = fakeApi({
            'GET /api/students/3/retrain-items': list,
            'POST /api/students/3/retrain-paper': draft,
            'POST /api/students/3/retrain-items': [400, { message: '<b>壞掉</b>' }]
        });
        await mount({ api });
        const row = rowOf(812);
        assert.equal(row.querySelectorAll('[data-retrain-stem="812"]')[0].textContent, '<b>粗體</b>');
        assert.ok(row.textContent.includes(evil));
        assert.ok(row.textContent.includes('備註：<script>alert(1)</script>'));
        row.querySelectorAll('[data-retrain-history-toggle="812"]')[0].click();
        await settle(4);
        assert.ok(row.textContent.includes('錯因：<u>zz</u>'));
        $('rtPaperBtn').click();
        await settle();
        assert.ok($('rtDraft').textContent.includes(evil));
        $('rtAddIds').value = '5';
        $('rtAddBtn').click();
        await settle();
        assert.ok(toasts().includes('<b>壞掉</b>'));
        for (const tag of ['img', 'b', 'i', 'u', 'script']) {
            assert.equal($('retrain').querySelectorAll(tag).length, 0, `不該長出 <${tag}>`);
        }
    });
});
