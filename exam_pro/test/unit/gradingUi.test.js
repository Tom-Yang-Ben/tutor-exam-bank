// ─────────────────────────────────────────────────────────────
// 批改卡、錯因分布與學生檔案的前端測試（階段 5 WS-A；docs/interfaces-stage5.md 第 4.1 條第 7 項）
//
// 兩層：
//   1. public/js/students.js 新匯出的純函式（diffResults 的四個新鍵、錯因依科目過濾、
//      部分給分的百分比換算、學生檔案摘要與差異）。
//   2. 用 test/unit/lib/miniDom.js 真的把學生分頁跑起來，餵一組假 API（不走 ?mock=1，
//      才看得到「實際送出去的 PATCH body」），驗錯因 chip、部分給分、註記、答案與詳解、
//      錯因分布表與學生檔案表單。
//
// 既有的 test/unit/stage3Ui.test.js、stage3Render.test.js 一個字都沒改：
// 它們釘住的行為（三顆對錯鈕、只送改過的題、沒改動不送）在這裡照樣成立。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');
const { ERROR_TYPES, MAX_ERROR_TYPES } = require('../../config/errorTypes');
const { profileOptions } = require('../../config/studentProfile');

const JS_FILE = path.resolve(__dirname, '..', '..', 'public', 'js', 'students.js');
let seq = 0;
/** 每次拿一份新的 module 實例（模組層有錯因白名單的快取）。 */
function loadFresh() {
    const src = fs.readFileSync(JS_FILE, 'utf8') + `\n// gradingUi instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

// ═════════════ 1. 純函式 ═════════════

describe('students.js 的〔stage5 WS-A〕純函式', () => {
    test('diffResults：列上有新鍵時，只送改過的鍵（連同目前的 result）', async () => {
        const { diffResults } = await loadFresh();
        const before = [
            { question_id: 1, result: 0, score: null, error_types: ['calc'], response: null, note: null },
            { question_id: 2, result: 1, score: null, error_types: [], response: null, note: null },
            { question_id: 3, result: 0, score: 0.5, error_types: [], response: '8', note: null }
        ];
        const after = [
            { question_id: 1, result: 0, score: null, error_types: ['calc', 'blank'], response: null, note: null },
            { question_id: 2, result: 1, score: null, error_types: [], response: null, note: null },   // 沒改
            { question_id: 3, result: 0, score: 0.5, error_types: [], response: '8', note: '看錯方向' }
        ];
        assert.deepEqual(diffResults(before, after), [
            { question_id: 1, result: 0, error_types: ['calc', 'blank'] },
            { question_id: 3, result: 0, note: '看錯方向' }
        ]);
    });

    test('diffResults：錯 → 對時錯因清空也要送（[] 與原本的 [calc] 不同）', async () => {
        const { diffResults } = await loadFresh();
        assert.deepEqual(diffResults(
            [{ question_id: 1, result: 0, score: 0.3, error_types: ['calc'] }],
            [{ question_id: 1, result: null, score: null, error_types: [] }]
        ), [{ question_id: 1, result: null, score: null, error_types: [] }]);
    });

    test('diffResults：舊的呼叫方式（列上只有 result）輸出與階段 3 逐位元相同', async () => {
        const { diffResults } = await loadFresh();
        assert.deepEqual(diffResults([{ question_id: 8, result: null }], [{ question_id: 8, result: 0 }]),
            [{ question_id: 8, result: 0 }]);
        const out = diffResults([{ question_id: 8, result: null }], [{ question_id: 8, result: 0 }]);
        assert.deepEqual(Object.keys(out[0]), ['question_id', 'result']);
    });

    test('applicableErrorTypes：chem_equation 只給化學題', async () => {
        const { applicableErrorTypes } = await loadFresh();
        const codes = subject => applicableErrorTypes(ERROR_TYPES, subject).map(t => t.code);
        assert.ok(!codes('數學').includes('chem_equation'));
        assert.ok(!codes('物理').includes('chem_equation'));
        assert.ok(codes('化學').includes('chem_equation'));
        assert.equal(codes('數學').length, ERROR_TYPES.length - 1);
        assert.deepEqual(applicableErrorTypes(null, '數學'), []);
    });

    test('scoreFromPercent／percentOfScore：0～100 的整數 ↔ 0～1', async () => {
        const { scoreFromPercent, percentOfScore } = await loadFresh();
        assert.equal(scoreFromPercent('60'), 0.6);
        assert.equal(scoreFromPercent(' 0 '), 0);
        assert.equal(scoreFromPercent('100'), 1);
        assert.equal(scoreFromPercent(''), null);
        for (const bad of ['101', '-1', '12.5', 'abc', '1e2']) assert.equal(scoreFromPercent(bad), undefined, bad);
        assert.equal(percentOfScore(0.29), '29');
        assert.equal(percentOfScore(null), '');
        assert.equal(percentOfScore(undefined), '');
    });

    test('profileSummary 與 diffProfile', async () => {
        const { profileSummary, diffProfile } = await loadFresh();
        assert.equal(profileSummary({ grade: 11, track: '自然組', target_exams: ['學測', '分科'], school: '示範高中', textbook_version: '龍騰' }),
            '高二・自然組・學測／分科・示範高中・龍騰版');
        assert.equal(profileSummary({ grade: null, track: null, target_exams: [] }), '');
        const st = { grade: 10, track: null, target_exams: ['學測'], school: null, textbook_version: null, note: null };
        assert.deepEqual(diffProfile(st, { ...st }), {});
        assert.deepEqual(diffProfile(st, { ...st, grade: 11, target_exams: ['學測', '分科'], note: null }),
            { grade: 11, target_exams: ['學測', '分科'] });
    });
});

// ═════════════ 2. 真的渲染起來 ═════════════

const META = { 'feature-students': 'true', 'feature-similar': 'false', 'feature-variants': 'false' };

const PAPER = {
    id: 41, title: '示範卷', student_id: 3, created_at: '2026-09-01T00:00:00.000Z',
    questions: [
        {
            question_id: 11, question_text: '數學計算題', question_type: '計算', difficulty: 3, result: 0,
            subject: '數學', chapter: '向量內積', answer_text: '$5$', solution_text: '由 $\\sqrt{25}$ 得 5', solution_src: 'verify',
            score: 0.5, error_types: ['calc'], response: '4', teacher_note: null
        },
        {
            question_id: 12, question_text: '化學填空題', question_type: '填空', difficulty: 2, result: null,
            subject: '化學', chapter: '化學計量', answer_text: '2 mol', solution_text: null, solution_src: null,
            score: null, error_types: [], response: null, teacher_note: null
        },
        {
            question_id: 13, question_text: '數學填空題', question_type: '填空', difficulty: 1, result: 1,
            subject: '數學', chapter: '向量內積', answer_text: '$2$', solution_text: null, solution_src: null,
            score: null, error_types: [], response: null, teacher_note: null
        }
    ]
};

const STUDENT = { id: 3, name: '示範學生', papers: 1, graded_ratio: 0.6667, grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null };

/** 假 API：記下每一次呼叫（含解析過的 body），依「方法 路徑」回 fixture。 */
function fakeApi(overrides = {}) {
    const calls = [];
    const fixtures = {
        'GET /api/students': { items: [STUDENT] },
        'GET /api/students/3/papers': { items: [{ paper_id: 41, title: '示範卷', created_at: '2026-09-01T00:00:00.000Z', total: 3, graded: 2 }] },
        'GET /api/students/3/weakness': {
            by_chapter: [], by_type: [], by_difficulty: [], trend_weekly: [],
            recent_wrong: [{ question_id: 11, chapter: '向量內積', question_text: '數學計算題', assigned_at: '2026-09-01', error_types: ['calc', 'mystery'], score: 0.5 }],
            by_error_type: [
                { error_type: 'calc', label: '計算錯誤', count: 3, share: 0.75 },
                { error_type: 'mystery', label: null, count: 1, share: 0.25 }
            ]
        },
        'GET /api/error-types': { items: ERROR_TYPES, max_per_attempt: MAX_ERROR_TYPES },
        'GET /api/papers/41': PAPER,
        'PATCH /api/papers/41/results': body => [200, { updated: body.results.length }],
        'GET /api/student-profile-options': profileOptions(),
        'PATCH /api/students/3': body => [200, { ...STUDENT, ...body }],
        ...overrides
    };
    const apiFetch = (url, options = {}) => {
        const method = options.method || 'GET';
        const p = url.split('?')[0];
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
        calls.push({ method, path: p, body });
        const hit = fixtures[`${method} ${p}`];
        if (hit === undefined) return Promise.resolve(new Response(JSON.stringify({ message: 'no fixture' }), { status: 404 }));
        const [status, payload] = typeof hit === 'function' ? hit(body) : [200, hit];
        return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    };
    return { apiFetch, calls };
}

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

async function mount(api = fakeApi()) {
    env = install({ meta: META, sections: ['students'], search: '', examApp: fakeBridge({ apiFetch: api.apiFetch }) });
    const mod = await loadFresh();
    await mod.init();
    await flush();
    return { mod, api };
}

async function openPaper() {
    const card = env.document.querySelectorAll('[data-paper-id="41"]')[0];
    card.children[0].click();
    for (let i = 0; i < 4; i++) await flush();
    return card;
}

const chipsOf = (card, qid) => card.querySelectorAll(`[data-error-chips="${qid}"]`)[0];
const pressed = box => box.querySelectorAll('button').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-error-type'));
const resultBtn = (card, i, label) => card.querySelectorAll('[role="radiogroup"]')[i].children.find(b => b.textContent === label);
const saveBtn = card => card.querySelectorAll('button').find(b => b.textContent === '儲存批改');
const toasts = () => env.window.ExamApp.calls.toasts.map(t => t.message);

describe('批改卡（第 4.1 條第 7 項）', () => {
    test('錯因 chip 只在「錯」時出現、反映既有錯因；chem_equation 只出現在化學題', async () => {
        await mount();
        const card = await openPaper();
        assert.equal(card.querySelectorAll('[role="radiogroup"]').length, 3, '三顆對錯鈕的結構不變');

        const math = chipsOf(card, 11), chem = chipsOf(card, 12), right = chipsOf(card, 13);
        assert.ok(!math.classList.contains('hidden'), '答錯的題要展開錯因');
        assert.ok(chem.classList.contains('hidden'), '未批的題不顯示錯因');
        assert.ok(right.classList.contains('hidden'), '答對的題不顯示錯因');
        assert.deepEqual(pressed(math), ['calc']);
        assert.equal(math.querySelectorAll('[data-error-type="chem_equation"]').length, 0, '數學題不得出現化學式錯因');
        assert.equal(chem.querySelectorAll('[data-error-type="chem_equation"]').length, 1, '化學題要有化學式錯因');
        assert.equal(math.getAttribute('role'), 'group', 'chip 容器不得冒充 radiogroup');
    });

    test('按「錯」→ 點錯因 → 儲存：PATCH 只送改過的題與鍵', async () => {
        const { api } = await mount();
        const card = await openPaper();
        resultBtn(card, 1, '錯').click();
        const chem = chipsOf(card, 12);
        assert.ok(!chem.classList.contains('hidden'));
        chem.querySelectorAll('[data-error-type="chem_equation"]')[0].click();
        chem.querySelectorAll('[data-error-type="concept"]')[0].click();
        assert.deepEqual(pressed(chem), ['concept', 'chem_equation'], '存成白名單的順序');

        saveBtn(card).click();
        for (let i = 0; i < 3; i++) await flush();
        const patch = api.calls.find(c => c.method === 'PATCH');
        assert.deepEqual(patch.body, { results: [{ question_id: 12, result: 0, error_types: ['concept', 'chem_equation'] }] });
    });

    test('錯 → 對：錯因清空並一起送出；取消批改連部分給分一起清', async () => {
        const { api } = await mount();
        const card = await openPaper();
        resultBtn(card, 0, '未批').click();
        assert.ok(chipsOf(card, 11).classList.contains('hidden'));
        saveBtn(card).click();
        for (let i = 0; i < 3; i++) await flush();
        const patch = api.calls.find(c => c.method === 'PATCH');
        assert.deepEqual(patch.body.results, [{ question_id: 11, result: null, score: null, error_types: [] }]);
    });

    test('部分給分只給計算／證明題；輸入 60 → 送 0.6；超出範圍提示並還原', async () => {
        const { api } = await mount();
        const card = await openPaper();
        assert.equal(card.querySelectorAll('[data-score-box="12"]').length, 0, '填空題沒有部分給分');
        const box = card.querySelectorAll('[data-score-box="11"]')[0];
        assert.ok(box && !box.classList.contains('hidden'));
        const input = box.querySelectorAll('input')[0];
        assert.equal(input.value, '50', '既有的 0.5 顯示成 50%');

        input.value = '150';
        input.dispatchEvent({ type: 'change', target: input });
        assert.ok(toasts().some(m => m.includes('0～100')), toasts().join('|'));
        assert.equal(input.value, '50', '不合法的值要還原');

        input.value = '60';
        input.dispatchEvent({ type: 'change', target: input });
        saveBtn(card).click();
        for (let i = 0; i < 3; i++) await flush();
        assert.deepEqual(api.calls.find(c => c.method === 'PATCH').body.results, [{ question_id: 11, result: 0, score: 0.6 }]);
    });

    test('學生答案與註記：已有內容時預設展開；改註記只送 note', async () => {
        const { api } = await mount();
        const card = await openPaper();
        const notes11 = card.querySelectorAll('[data-notes-box="11"]')[0];
        const notes12 = card.querySelectorAll('[data-notes-box="12"]')[0];
        assert.ok(!notes11.classList.contains('hidden'), '有學生答案的題要展開');
        assert.ok(notes12.classList.contains('hidden'));
        const noteTa = notes11.querySelectorAll('textarea')[0];
        noteTa.value = '  少了開根號 ';
        noteTa.dispatchEvent({ type: 'input', target: noteTa });
        saveBtn(card).click();
        for (let i = 0; i < 3; i++) await flush();
        assert.deepEqual(api.calls.find(c => c.method === 'PATCH').body.results, [{ question_id: 11, result: 0, note: '少了開根號' }]);
    });

    test('看答案與詳解：展開標準答案、詳解與來源；沒有詳解的題說明怎麼補', async () => {
        await mount();
        const card = await openPaper();
        const btn = card.querySelectorAll('button').filter(b => b.textContent === '看答案與詳解');
        assert.equal(btn.length, 3);
        const box11 = card.querySelectorAll('[data-answer-box="11"]')[0];
        assert.ok(box11.classList.contains('hidden'));
        btn[0].click();
        assert.ok(!box11.classList.contains('hidden'));
        assert.ok(box11.textContent.includes('標準答案：$5$'));
        assert.ok(box11.textContent.includes('詳解：由'));
        assert.ok(box11.textContent.includes('未經人工審閱'), '驗算來源要標示未經人工審閱');
        assert.ok(card.querySelectorAll('[data-answer-box="12"]')[0].textContent.includes('還沒有文字詳解'));
    });

    test('錯因最多 5 個：第 6 個被擋並提示', async () => {
        await mount();
        const card = await openPaper();
        const math = chipsOf(card, 11);
        for (const code of ['concept', 'method', 'reading', 'unit']) math.querySelectorAll(`[data-error-type="${code}"]`)[0].click();
        assert.equal(pressed(math).length, 5);
        math.querySelectorAll('[data-error-type="time"]')[0].click();
        assert.equal(pressed(math).length, 5);
        assert.ok(toasts().some(m => m.includes('最多標 5 個')), toasts().join('|'));
    });

    test('錯因清單載入失敗時仍能批改（只能記對錯），不會整張卡壞掉', async () => {
        const api = fakeApi({ 'GET /api/error-types': () => [500, { message: 'boom' }] });
        await mount(api);
        const card = await openPaper();
        assert.equal(card.querySelectorAll('[role="radiogroup"]').length, 3);
        assert.ok(chipsOf(card, 11).textContent.includes('錯因清單載入失敗'));
        // 已存的錯因仍畫得出來（可以取消），不會被靜默丟掉
        assert.deepEqual(pressed(chipsOf(card, 11)), ['calc']);
    });

    test('沒有任何改動 → 不送 PATCH（與階段 3 相同）', async () => {
        const { api } = await mount();
        const card = await openPaper();
        saveBtn(card).click();
        await flush();
        assert.equal(api.calls.filter(c => c.method === 'PATCH').length, 0);
        assert.ok(toasts().includes('沒有任何改動。'));
    });
});

describe('弱點面板：錯因分布與最近錯題（第 4.1 條第 3、7 項）', () => {
    test('錯因分布表：標籤、比例與題數；白名單外的代碼原樣顯示', async () => {
        await mount();
        const table = env.document.querySelectorAll('[data-weakness="by_error_type"]')[0];
        assert.ok(table, '沒有錯因分布表');
        const text = table.textContent;
        assert.ok(text.includes('錯因分布'));
        assert.ok(text.includes('計算錯誤') && text.includes('75.0%') && text.includes('(3 題)'), text);
        assert.ok(text.includes('mystery'), '不認得的代碼要看得到');
        assert.ok(text.includes('加總可能超過 100%'));
    });

    test('最近錯題列出錯因標籤與部分給分', async () => {
        await mount();
        const line = env.document.querySelectorAll('[data-recent-detail="11"]')[0];
        assert.ok(line, '最近錯題沒有批改細節');
        assert.equal(line.textContent, '錯因：計算錯誤、mystery　·　部分給分 50%');
    });

    test('舊後端沒有 by_error_type 鍵時不畫這張表（不假裝是空的）', async () => {
        const weak = { by_chapter: [], by_type: [], by_difficulty: [], trend_weekly: [], recent_wrong: [] };
        await mount(fakeApi({ 'GET /api/students/3/weakness': weak }));
        assert.equal(env.document.querySelectorAll('[data-weakness="by_error_type"]').length, 0);
        assert.ok(env.document.getElementById('stuWeakness').textContent.includes('最近錯題'), '其他區塊照常渲染');
    });
});

describe('學生管理：學生檔案（第 4.1 條第 4、7 項）', () => {
    async function openProfile(api) {
        await mount(api);
        env.document.getElementById('stuManageBtn').click();
        for (let i = 0; i < 3; i++) await flush();
        const btn = env.document.querySelectorAll('button').find(b => b.textContent === '檔案');
        assert.ok(btn, '管理面板沒有「檔案」按鈕');
        btn.click();
        for (let i = 0; i < 3; i++) await flush();
        return env.document.querySelectorAll('[data-profile-editor="3"]')[0];
    }

    test('摘要：沒填檔案時顯示「（未填檔案）」', async () => {
        await mount();
        env.document.getElementById('stuManageBtn').click();
        for (let i = 0; i < 3; i++) await flush();
        assert.equal(env.document.querySelectorAll('[data-profile-summary="3"]')[0].textContent, '（未填檔案）');
    });

    test('選項全部來自 GET /api/student-profile-options；只送改過的欄位', async () => {
        const api = fakeApi();
        const editor = await openProfile(api);
        assert.ok(!editor.classList.contains('hidden'));
        assert.ok(api.calls.some(c => c.path === '/api/student-profile-options'));
        const selects = editor.querySelectorAll('select');
        assert.equal(selects.length, 3, '年級、類組、教材版本');
        assert.deepEqual(selects[0].options.map(o => o.value), ['', '10', '11', '12']);
        assert.deepEqual(selects[1].options.map(o => o.value), ['', ...profileOptions().tracks]);

        selects[0].value = '11';
        editor.querySelectorAll('[data-exam="學測"]')[0].checked = true;
        editor.querySelectorAll('button').find(b => b.textContent === '儲存檔案').click();
        for (let i = 0; i < 3; i++) await flush();
        const patch = api.calls.find(c => c.method === 'PATCH' && c.path === '/api/students/3');
        assert.deepEqual(patch.body, { grade: 11, target_exams: ['學測'] });
    });

    test('沒有改動就儲存 → 不送 PATCH', async () => {
        const api = fakeApi();
        const editor = await openProfile(api);
        editor.querySelectorAll('button').find(b => b.textContent === '儲存檔案').click();
        await flush();
        assert.equal(api.calls.filter(c => c.method === 'PATCH').length, 0);
        assert.ok(toasts().includes('沒有任何改動。'));
    });

    test('選項載入失敗時說明原因，不畫半套表單', async () => {
        const editor = await openProfile(fakeApi({ 'GET /api/student-profile-options': () => [500, {}] }));
        assert.ok(editor.textContent.includes('學生檔案選項載入失敗'));
        assert.equal(editor.querySelectorAll('select').length, 0);
    });
});
