// ─────────────────────────────────────────────────────────────
// public/js/remedial.js 的前端測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 5 項）
//
// 三層（沿用 stage3Ui／stage3Render 的做法）：
//   1. 檔案層級契約：旗標從 <meta name="feature-remedial"> 讀、parseBool 與後端逐字相同、
//      科目不寫死、不自己複製橋接函式。
//   2. 純函式：配比、題數、題目 ID 解析、草稿增刪與分組、掌握度與熱度的顯示。
//   3. 用 test/unit/lib/miniDom.js 真的把 module 跑起來：旗標關閉整段不渲染、產生草稿、
//      刪題／加題、remedial:add 事件、確認出卷、覆蓋率熱度表；以及「找相似」結果上的
//      〔stage5 WS-D〕「加入補救卷」掛鉤（public/js/variants.js）。
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');

const JS_DIR = path.resolve(__dirname, '..', '..', 'public', 'js');
const source = name => fs.readFileSync(path.join(JS_DIR, name), 'utf8');

let seq = 0;
async function loadFresh(name) {
    const src = source(name) + `\n// instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

// ───────────────────────── 假 API ─────────────────────────

const DRAFT = {
    student_id: 1, subject: '數學', basis: 'chapter',
    question_ids: [12, 11, 21],
    items: [
        { question_id: 11, bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, chapter: '向量內積', difficulty: 2, question_text_preview: '自製題 11' },
        { question_id: 12, bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, chapter: '向量內積', difficulty: 3, question_text_preview: '自製題 12' },
        { question_id: 21, bucket: 'extension', target: { type: 'chapter', chapter: '排列', name: '排列' }, chapter: '排列', difficulty: 4, question_text_preview: '自製題 21' }
    ],
    blueprint: [
        { bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 4, got: 2, difficulty_min: null, difficulty_max: 3, rationale: '掌握度下界 5%' },
        { bucket: 'extension', target: { type: 'chapter', chapter: '排列', name: '排列' }, wanted: 1, got: 1, difficulty_min: 3, difficulty_max: null, rationale: '已相對掌握' }
    ],
    shortfalls: [{ bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 4, got: 2, reason: 'insufficient_stock' }],
    notes: ['以章節為單位時沒有先備資料：先備配額 1 題併入補救。']
};
const COVERAGE = {
    rows: [
        { subject: '數學', volume: '第三冊(A/B)', chapter: '向量內積', total: 3, by_difficulty: { 1: 2, 2: 0, 3: 1, 4: 0, 5: 0 }, unseen_by_student: null },
        { subject: '數學', volume: '第三冊(A/B)', chapter: '面積與行列式', total: 0, by_difficulty: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, unseen_by_student: null }
    ],
    kc_rows: [{ code: 'MATH.向量內積.01', name: '內積的意義', chapter: '向量內積', total: 0 }]
};

/** 依網址回假資料的橋接；calls.fetches 記下每一次請求（含 body）。 */
function routedBridge(overrides = {}) {
    const bridge = fakeBridge();
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    const routes = {
        'GET /api/students': () => json({ items: [{ id: 1, name: '王小明', papers: 2, graded_ratio: 1 }, { id: 2, name: '李小華', papers: 0, graded_ratio: 0 }] }),
        'GET /api/chapter-whitelist': () => json({ 數學: ['向量內積'], 物理: ['靜電學'], 化學: ['化學平衡與平衡常數'] }),
        'POST /api/students/1/remedial-paper': () => json(DRAFT),
        'GET /api/students/1/weakness/kc': () => json({ rows: [{ kc_id: 1, code: 'MATH.向量內積.01', name: '內積的意義', subject: '數學', chapter: '向量內積', graded: 3, correct: 1, correct_rate: 0.3333, mastery_lb: 0.0615, low_sample: true }], untagged_graded: 4 }),
        'POST /api/confirm-paper': (body) => json({ message: 'ok', paper_id: 9, paper_title: '王小明-向量內積特訓卷(2026_9_24)', question_ids: body.question_ids, questions: [] }),
        'GET /api/coverage': () => json(COVERAGE),
        ...overrides
    };
    bridge.apiFetch = (url, options) => {
        const method = (options || {}).method || 'GET';
        let body = null;
        if (typeof (options || {}).body === 'string') body = JSON.parse(options.body);
        bridge.calls.fetches.push({ url, method, body });
        const key = `${method} ${url.split('?')[0]}`;
        const route = routes[key];
        return route ? route(body, url) : json({ message: `沒有假資料：${key}` }, 501);
    };
    return bridge;
}

const ON = { 'feature-remedial': 'true' };
const OFF = { 'feature-remedial': '__FEATURE_REMEDIAL__' };

async function mount(opts = {}) {
    env = install({ meta: opts.meta || ON, sections: opts.sections || ['remedial', 'coverage'], search: '', examApp: opts.examApp || routedBridge() });
    const mod = await loadFresh('remedial.js');
    await mod.init();
    await settle();
    return mod;
}
const $ = id => env.document.getElementById(id);

// ───────────────────────── 1. 檔案層級契約 ─────────────────────────
describe('remedial.js 的檔案層級契約', () => {
    const src = source('remedial.js');

    test('parseBool 與後端 config/features.js 逐字相同', async () => {
        const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src + '\n// pure\n'));
        const { parseBool: backend } = require('../../config/features');
        for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', 'off', '', null, undefined, '__FEATURE_REMEDIAL__']) {
            assert.equal(mod.parseBool(v), backend(v), `「${v}」兩邊解讀不同`);
        }
    });

    test('旗標從 <meta name="feature-remedial"> 讀、旗標關閉時整段不渲染', () => {
        assert.ok(src.includes('meta[name="feature-remedial"]'));
        assert.ok(src.includes("v === '1' || v === 'true'"));
        assert.ok(src.includes('整段不渲染'));
    });

    test('科目不寫死（讀 /api/chapter-whitelist）；不自己複製橋接函式', () => {
        assert.ok(src.includes('/api/chapter-whitelist'));
        for (const s of ["'數學'", "'物理'", "'化學'"]) assert.ok(!src.includes(s), `寫死了科目 ${s}`);
        assert.ok(src.includes('window.ExamApp'));
        for (const fn of ['apiFetch', 'showToast', 'renderMath']) assert.ok(!new RegExp(`function\\s+${fn}\\b`).test(src), fn);
    });

    test('伺服器回來的文字不進 innerHTML（只允許清空）', () => {
        const assigns = src.match(/innerHTML\s*=\s*[^;]+/g) || [];
        for (const a of assigns) assert.match(a, /innerHTML\s*=\s*''/, a);
    });

    test('事件名凍結為 remedial:add', async () => {
        const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src + '\n// evt\n'));
        assert.equal(mod.REMEDIAL_ADD_EVENT, 'remedial:add');
    });
});

// ───────────────────────── 2. 純函式 ─────────────────────────
describe('remedial.js 的純函式', () => {
    let mod;
    beforeEach(async () => { mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source('remedial.js') + `\n// p${++seq}\n`)); });

    test('mixFromPercent：三個非負數、總和 > 0，否則 null', () => {
        assert.deepEqual(mod.mixFromPercent({ remedial: '60', prerequisite: '20', extension: '20' }), { remedial: 60, prerequisite: 20, extension: 20 });
        assert.deepEqual(mod.mixFromPercent({ remedial: 0, prerequisite: 0, extension: 5 }), { remedial: 0, prerequisite: 0, extension: 5 });
        for (const bad of [{ remedial: '', prerequisite: 1, extension: 1 }, { remedial: -1, prerequisite: 1, extension: 1 },
            { remedial: 'x', prerequisite: 1, extension: 1 }, { remedial: 0, prerequisite: 0, extension: 0 }, null]) {
            assert.equal(mod.mixFromPercent(bad), null, JSON.stringify(bad));
        }
    });

    test('parseTotal：5–50 的整數', () => {
        assert.equal(mod.parseTotal('20'), 20);
        assert.equal(mod.parseTotal(5), 5);
        for (const bad of ['4', '51', '', '7.5', 'abc', null]) assert.equal(mod.parseTotal(bad), null, String(bad));
    });

    test('parseQuestionIds：逗號、空白、頓號分隔，# 前綴可省，去重；看不懂的回報', () => {
        assert.deepEqual(mod.parseQuestionIds('12, 34 #56、12，7'), { ids: [12, 34, 56, 7], invalid: [] });
        assert.deepEqual(mod.parseQuestionIds('3 x 0 -2 4.5'), { ids: [3], invalid: ['x', '0', '-2', '4.5'] });
        assert.deepEqual(mod.parseQuestionIds(''), { ids: [], invalid: [] });
    });

    test('addManualItem：沒有草稿、ID 不合法、別的學生、重複 → 錯誤代碼；成功回新草稿（不改原物件）', () => {
        assert.deepEqual(mod.addManualItem(null, { question_id: 1 }), { error: 'no_draft' });
        const d = mod.emptyDraft(1, '王小明', '數學');
        assert.deepEqual(mod.addManualItem(d, { question_id: 0 }), { error: 'bad_id' });
        assert.deepEqual(mod.addManualItem(d, { question_id: 5, student_id: 2 }), { error: 'other_student' });
        const r = mod.addManualItem(d, { question_id: 5, student_id: 1, chapter: '向量內積', difficulty: 2, question_text: '  自製\n題幹 ' });
        assert.equal(d.items.length, 0, '不改原草稿');
        assert.deepEqual(r.draft.items, [{ question_id: 5, bucket: 'manual', target: null, chapter: '向量內積', difficulty: 2, question_text_preview: '自製 題幹' }]);
        assert.deepEqual(mod.addManualItem(r.draft, { question_id: 5 }), { error: 'duplicate' });
    });

    test('removeItem／draftQuestionIds／groupDraft（固定順序：補救 → 先備 → 延伸 → 手動加入）', () => {
        let d = mod.draftFromResponse(DRAFT, '王小明');
        d = mod.addManualItem(d, { question_id: 99 }).draft;
        assert.deepEqual(mod.draftQuestionIds(d), [11, 12, 21, 99]);
        const groups = mod.groupDraft(d);
        assert.deepEqual(groups.map(g => [g.bucket, g.label, g.items.length, g.blueprint.length]),
            [['remedial', '補救', 2, 1], ['extension', '延伸', 1, 1], ['manual', '手動加入', 1, 0]]);
        d = mod.removeItem(d, 12);
        assert.deepEqual(mod.draftQuestionIds(d), [11, 21, 99]);
        assert.deepEqual(mod.draftQuestionIds(null), []);
    });

    test('shortfallText／formatMastery／heatLevel', () => {
        assert.equal(mod.shortfallText(DRAFT.shortfalls[0]), '向量內積：要 4 題，只找到 2 題（庫存不足）');
        assert.equal(mod.formatMastery(null), '—', '沒批改不等於 0%');
        assert.equal(mod.formatMastery(0.0615), '6%');
        assert.deepEqual([0, 1, 2, 3, 5, 6, 9, 10, 40].map(mod.heatLevel), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
    });
});

// ───────────────────────── 3. 真的跑起來 ─────────────────────────
describe('remedial.js 的渲染（miniDom）', () => {
    test('旗標關閉 → 兩個錨點都是空的（整段不渲染，不是隱藏）', async () => {
        await mount({ meta: OFF });
        for (const id of ['remedial', 'coverage']) {
            assert.equal($(id).childElementCount, 0, id);
            assert.equal($(id).className, '');
        }
        assert.equal(env.window.ExamApp.calls.fetches.length, 0, '旗標關閉時不該打任何 API');
    });

    test('window.ExamApp 不存在 → 印一行錯誤並停手', async () => {
        env = install({ meta: ON, sections: ['remedial', 'coverage'], examApp: undefined });
        const errors = [];
        const real = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            const mod = await loadFresh('remedial.js');
            await mod.init();
        } finally { console.error = real; }
        assert.ok(errors.some(e => e.startsWith('[remedial]') && e.includes('window.ExamApp')));
        assert.equal($('remedial').childElementCount, 0);
    });

    test('骨架長出來：學生、科目（讀 chapter-whitelist）、題數、天數、三個配比、產生草稿', async () => {
        await mount();
        for (const id of ['remStudent', 'remSubject', 'remTotal', 'remDays', 'remMixRemedial', 'remMixPrereq', 'remMixExt', 'remGenerate', 'remDraft']) {
            assert.ok($(id), `少了 #${id}`);
        }
        assert.deepEqual($('remSubject').options.map(o => o.value), ['數學', '物理', '化學'], '科目來自 API，不是寫死的');
        assert.deepEqual($('remStudent').options.map(o => o.value), ['', '1', '2']);
        assert.equal($('remTotal').value, '20');
        assert.equal($('remDays').value, '90');
        assert.deepEqual([$('remMixRemedial').value, $('remMixPrereq').value, $('remMixExt').value], ['60', '20', '20']);
    });

    test('產生草稿：送出的 body、依 bucket 分組、notes 與不足量、知識點掌握度', async () => {
        await mount();
        $('remStudent').value = '1';
        $('remTotal').value = '10';
        $('remMixExt').value = '0';
        $('remGenerate').click();
        await settle();
        const post = env.window.ExamApp.calls.fetches.find(f => f.method === 'POST');
        assert.equal(post.url, '/api/students/1/remedial-paper');
        assert.deepEqual(post.body, { subject: '數學', total: 10, mix: { remedial: 60, prerequisite: 20, extension: 0 }, days: 90 });
        assert.ok(env.window.ExamApp.calls.fetches.some(f => f.url === '/api/students/1/weakness/kc?subject=%E6%95%B8%E5%AD%B8&days=90'));

        const draft = $('remDraft');
        const groups = draft.querySelectorAll('div[data-bucket]').map(g => g.getAttribute('data-bucket'));
        assert.deepEqual(groups, ['remedial', 'extension']);
        assert.ok(draft.textContent.includes('以章節判斷弱點'));
        assert.ok(draft.textContent.includes('先備配額 1 題併入補救'));
        assert.ok(draft.textContent.includes('要 4 題、找到 2 題（庫存不足）'));
        assert.equal(draft.querySelectorAll('div[data-question-id]').length, 3);
        assert.ok($('remKc').textContent.includes('內積的意義'));
        assert.ok($('remKc').textContent.includes('另有 4 題已批改但還沒標知識點'));
        assert.equal($('remConfirm').textContent, '確認出卷（3 題）');
    });

    test('不合法的輸入在前端就擋下（不打 API）', async () => {
        await mount();
        $('remGenerate').click();
        await settle();
        $('remStudent').value = '1';
        $('remTotal').value = '3';
        $('remGenerate').click();
        await settle();
        $('remTotal').value = '10';
        $('remMixRemedial').value = '0'; $('remMixPrereq').value = '0'; $('remMixExt').value = '0';
        $('remGenerate').click();
        await settle();
        assert.equal(env.window.ExamApp.calls.fetches.filter(f => f.method === 'POST').length, 0);
        assert.deepEqual(env.window.ExamApp.calls.toasts.map(t => t.type), ['error', 'error', 'error']);
    });

    test('刪題、用 ID 加題、確認出卷（送出草稿的 ID）→ 顯示 Word 下載', async () => {
        await mount();
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
        // 刪掉 #12
        const card = $('remDraft').querySelectorAll('div[data-question-id]').find(c => c.getAttribute('data-question-id') === '12');
        card.querySelector('button').click();
        await settle();
        assert.equal($('remDraft').querySelectorAll('div[data-question-id]').length, 2);
        // 用 ID 加兩題（其中 11 已在草稿裡）
        $('remAddId').value = '#77, 11';
        $('remAddBtn').click();
        await settle();
        assert.ok($('remDraft').querySelector('div[data-bucket="manual"]'), '手動加入的題要自成一組');
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message.includes('已在草稿裡')));
        // 確認
        $('remConfirm').click();
        await settle();
        const confirm = env.window.ExamApp.calls.fetches.find(f => f.url === '/api/confirm-paper');
        assert.deepEqual(confirm.body, { student_id: 1, question_ids: [11, 21, 77] });
        assert.ok($('remResult').textContent.includes('已出卷：王小明-向量內積特訓卷(2026_9_24)（3 題）'));
        assert.ok($('remDownload'), '確認後要提供 Word 下載');
        assert.equal($('remDraft').querySelectorAll('div[data-question-id]').length, 0, '確認後草稿清空');
    });

    test('remedial:add：沒有草稿時以事件帶的學生開一份，加進「手動加入」；重複的只提示', async () => {
        const mod = await mount();
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, {
            detail: { question_id: 55, student_id: 2, subject: '物理', chapter: '靜電學', difficulty: 3, question_text: '自製相似題' }
        }));
        await settle();
        assert.equal($('remStudent').value, '2');
        const draft = $('remDraft');
        assert.ok(draft.textContent.includes('李小華　·　物理　·　草稿 1 題'), draft.textContent.slice(0, 80));
        assert.ok(draft.querySelector('div[data-bucket="manual"]'));
        assert.ok(env.window.ExamApp.calls.sections.includes('students'), '要把老師帶到學生視圖');

        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 55 } }));
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message.includes('已在補救卷草稿裡')));
        // 別的學生的相似題不能混進這份草稿
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 56, student_id: 1 } }));
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message.includes('另一位學生')));
        assert.equal(draft.querySelectorAll('div[data-question-id]').length, 1);
    });

    test('remedial:add：沒有草稿也沒選學生 → 提示先選學生', async () => {
        const mod = await mount();
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 55 } }));
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.type === 'error' && t.message.includes('選學生')));
    });

    test('覆蓋率：預設第一個科目；章 × 難度的熱度表；0 題的知識點標紅；選學生多一欄「還沒寫過」', async () => {
        await mount();
        const first = env.window.ExamApp.calls.fetches.find(f => f.url.startsWith('/api/coverage'));
        assert.equal(first.url, '/api/coverage?subject=%E6%95%B8%E5%AD%B8');
        const table = $('covTable');
        assert.deepEqual(table.querySelectorAll('tr[data-chapter]').map(r => r.getAttribute('data-chapter')), ['向量內積', '面積與行列式']);
        assert.ok(!table.textContent.includes('還沒寫過'));
        assert.ok($('covKc').textContent.includes('1 個還沒有題'));

        $('covStudent').value = '1';
        $('covRefresh').click();
        await settle();
        const last = env.window.ExamApp.calls.fetches.filter(f => f.url.startsWith('/api/coverage')).pop();
        assert.equal(last.url, '/api/coverage?subject=%E6%95%B8%E5%AD%B8&student_id=1');
        assert.ok($('covTable').textContent.includes('還沒寫過'));
    });
});

// ───────────────────── 〔stage5 WS-D〕variants.js 的「加入補救卷」掛鉤 ─────────────────────
describe('「找相似」結果的「加入補救卷」按鈕（variants.js 的掛鉤）', () => {
    const META = { 'feature-students': 'true', 'feature-variants': 'true', 'feature-similar': 'true' };

    async function similar(meta) {
        env = install({ meta, sections: ['students', 'nlq', 'variants'], search: '?mock=1', examApp: fakeBridge() });
        const mod = await loadFresh('variants.js');
        await mod.init();
        await flush();
        env.document.dispatchEvent(new CustomEvent(mod.VARIANT_EVENT, {
            detail: { action: 'similar', question_id: 87, student_id: 3, chapter: '向量內積', question_text: '題幹' }
        }));
        await settle();
        return env.document.getElementById('varBody');
    }

    test('FEATURE_REMEDIAL 開啟：每一列一顆，點擊 dispatch remedial:add（帶 question_id 與學生）', async () => {
        const body = await similar({ ...META, 'feature-remedial': 'true' });
        const buttons = body.querySelectorAll('button[data-remedial-add]');
        assert.deepEqual(buttons.map(b => b.getAttribute('data-remedial-add')), ['12', '103']);
        const got = [];
        env.document.addEventListener('remedial:add', e => got.push(e.detail));
        buttons[1].click();
        assert.deepEqual(got, [{ question_id: 103, student_id: 3, subject: '數學', chapter: '向量內積', difficulty: 2,
            question_text: '兩向量夾角為 $60^\\circ$，$|\\vec{a}|=2$、$|\\vec{b}|=3$，求 $\\vec{a}\\cdot\\vec{b}$。' }]);
    });

    test('FEATURE_REMEDIAL 關閉：不顯示', async () => {
        const body = await similar({ ...META, 'feature-remedial': 'false' });
        assert.ok(body.textContent.includes('庫內相似題'), '相似題本身照常顯示');
        assert.equal(body.querySelectorAll('button[data-remedial-add]').length, 0);
    });
});
