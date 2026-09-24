// ─────────────────────────────────────────────────────────────
// public/js/remedial.js 的前端測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 5 項）
//
// 三層（沿用 stage3Ui／stage3Render 的做法）：
//   1. 檔案層級契約：旗標從 <meta name="feature-remedial"> 讀、parseBool 與後端逐字相同、
//      科目不寫死、不自己複製橋接函式。
//   2. 純函式：配比、題數、題目 ID 解析、草稿增刪與分組、承上組（整組刪、整組加、缺前題）、
//      掌握度與熱度的顯示。
//   3. 用 test/unit/lib/miniDom.js 真的把 module 跑起來：旗標關閉整段不渲染、產生草稿、
//      刪題／加題（含承上題「刪這組」與整組加入、不混科）、remedial:add 事件、確認出卷、覆蓋率熱度表；
//      以及「找相似」結果上的〔stage5 WS-D〕「加入補救卷」掛鉤（public/js/variants.js）。
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

/**
 * 假題庫（給 GET /api/students/:id/remedial-paper/items 用）：
 *   4 ← 5（承上組）、40（他寫過）← 41、8 封存、60 物理、77／78 單題、55 物理（李小華的草稿用）
 */
const CATALOG = {
    4: { subject: '數學', chapter: '向量內積', difficulty: 2, follows: null, group: [4, 5] },
    5: { subject: '數學', chapter: '向量內積', difficulty: 3, follows: 4, group: [4, 5] },
    40: { subject: '數學', chapter: '向量內積', difficulty: 2, follows: null, group: [40, 41], answered: true },
    41: { subject: '數學', chapter: '向量內積', difficulty: 2, follows: 40, group: [40, 41] },
    8: { subject: '數學', chapter: '向量內積', difficulty: 1, follows: null, group: [8], archived: true },
    60: { subject: '物理', chapter: '靜電學', difficulty: 2, follows: null, group: [60] },
    77: { subject: '數學', chapter: '向量內積', difficulty: 2, follows: null, group: [77] },
    78: { subject: '數學', chapter: '向量內積', difficulty: 4, follows: null, group: [78] },
    55: { subject: '物理', chapter: '靜電學', difficulty: 3, follows: null, group: [55] }
};

/** 模擬 remedialService.lookupItems：每個要求的 id 後面接同組成員，不重複；查不到的進 missing。 */
function lookupBody(url) {
    const ids = new URL(url, 'http://x').searchParams.get('ids').split(',').map(Number);
    const items = [];
    const missing = [];
    const seen = new Set();
    for (const id of ids) {
        if (!CATALOG[id]) { missing.push(id); continue; }
        for (const m of CATALOG[id].group) {
            if (seen.has(m)) continue;
            seen.add(m);
            const c = CATALOG[m];
            items.push({ question_id: m, subject: c.subject, chapter: c.chapter, difficulty: c.difficulty,
                question_text_preview: `自製題 ${m}`, follows_question_id: c.follows, group_ids: c.group,
                archived: Boolean(c.archived), answered: Boolean(c.answered) });
        }
    }
    return { items, missing };
}

/** 假 API 的 JSON 回應。 */
const respond = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

/** 依網址回假資料的橋接；calls.fetches 記下每一次請求（含 body）。 */
function routedBridge(overrides = {}) {
    const bridge = fakeBridge();
    const json = respond;
    const routes = {
        'GET /api/students': () => json({ items: [{ id: 1, name: '王小明', papers: 2, graded_ratio: 1 }, { id: 2, name: '李小華', papers: 0, graded_ratio: 0 }] }),
        'GET /api/chapter-whitelist': () => json({ 數學: ['向量內積'], 物理: ['靜電學'], 化學: ['化學平衡與平衡常數'] }),
        'POST /api/students/1/remedial-paper': () => json(DRAFT),
        'GET /api/students/1/weakness/kc': () => json({ rows: [{ kc_id: 1, code: 'MATH.向量內積.01', name: '內積的意義', subject: '數學', chapter: '向量內積', graded: 3, correct: 1, correct_rate: 0.3333, mastery_lb: 0.0615, low_sample: true }], untagged_graded: 4 }),
        'GET /api/students/1/remedial-paper/items': (body, url) => json(lookupBody(url)),
        'GET /api/students/2/remedial-paper/items': (body, url) => json(lookupBody(url)),
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

    test('mixFromPercent：三個非負數、總和 > 0 且有限，否則 null', () => {
        assert.deepEqual(mod.mixFromPercent({ remedial: '60', prerequisite: '20', extension: '20' }), { remedial: 60, prerequisite: 20, extension: 20 });
        assert.deepEqual(mod.mixFromPercent({ remedial: 0, prerequisite: 0, extension: 5 }), { remedial: 0, prerequisite: 0, extension: 5 });
        for (const bad of [{ remedial: '', prerequisite: 1, extension: 1 }, { remedial: -1, prerequisite: 1, extension: 1 },
            { remedial: 'x', prerequisite: 1, extension: 1 }, { remedial: 0, prerequisite: 0, extension: 0 }, null,
            { remedial: '1e308', prerequisite: '1e308', extension: '0' }]) {
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
        assert.deepEqual(mod.parseQuestionIds('2147483647 2147483648'), { ids: [2147483647], invalid: ['2147483648'] }, '超過 int4 的不是合法 id');
    });

    test('addManualItem：沒有草稿、ID 不合法、別的學生、別的科目、重複 → 錯誤代碼；成功回新草稿（不改原物件）', () => {
        assert.deepEqual(mod.addManualItem(null, { question_id: 1 }), { error: 'no_draft' });
        const d = mod.emptyDraft(1, '王小明', '數學');
        assert.deepEqual(mod.addManualItem(d, { question_id: 0 }), { error: 'bad_id' });
        assert.deepEqual(mod.addManualItem(d, { question_id: 5, student_id: 2 }), { error: 'other_student' });
        assert.deepEqual(mod.addManualItem(d, { question_id: 5, student_id: 1, subject: '物理' }), { error: 'other_subject' }, '補救卷不混科');
        const r = mod.addManualItem(d, { question_id: 5, student_id: 1, subject: '數學', chapter: '向量內積', difficulty: 2, question_text: '  自製\n題幹 ' });
        assert.equal(d.items.length, 0, '不改原草稿');
        assert.deepEqual(r.draft.items, [{ question_id: 5, bucket: 'manual', target: null, chapter: '向量內積', difficulty: 2, question_text_preview: '自製 題幹', follows_question_id: null }]);
        assert.deepEqual(mod.addManualItem(r.draft, { question_id: 5 }), { error: 'duplicate' });
        // 沒帶 subject（例如只知道 ID）不在這裡擋，交給 planManualAdd 依查詢結果判斷
        assert.ok(mod.addManualItem(d, { question_id: 6 }).draft);
    });

    test('groupMembers／removeItem：承上組整組刪（follows_question_id 或 group_ids 相連，可多層鏈、可分岔）', () => {
        const item = (id, extra = {}) => ({ question_id: id, bucket: 'remedial', target: null, chapter: '向量內積', difficulty: 2, question_text_preview: '', ...extra });
        const d = { ...mod.emptyDraft(1, '王小明', '數學'), items: [
            item(1), item(4), item(5, { follows_question_id: 4 }), item(6, { follows_question_id: 5 }), item(7, { follows_question_id: 4 }),
            item(9, { group_ids: [9, 10] }), item(10, { group_ids: [9, 10] }), item(11, { follows_question_id: 999 })
        ] };
        assert.deepEqual(mod.groupMembers(d, 1), [1], '沒有綁定＝自己一組');
        assert.deepEqual(mod.groupMembers(d, 6), [4, 5, 6, 7], '從鏈尾也找得到整組（含分岔）');
        assert.deepEqual(mod.groupMembers(d, 10), [9, 10], 'group_ids 也算相連');
        assert.deepEqual(mod.groupMembers(d, 11), [11], '前題不在草稿：只有自己');
        assert.deepEqual(mod.groupMembers(d, 123), [], '不在草稿');
        // 刪前題 → 整組（含承上題）一起刪；刪沒有綁定的題只刪它
        assert.deepEqual(mod.draftQuestionIds(mod.removeItem(d, 4)), [1, 9, 10, 11]);
        assert.deepEqual(mod.draftQuestionIds(mod.removeItem(d, 9)), [1, 4, 5, 6, 7, 11]);
        assert.deepEqual(mod.draftQuestionIds(mod.removeItem(d, 1)), [4, 5, 6, 7, 9, 10, 11]);
        assert.equal(d.items.length, 8, '不改原草稿');
        // 確認前的最後一道：缺前題的承上題
        assert.deepEqual(mod.orphanFollowUps(d), [{ question_id: 11, follows_question_id: 999 }]);
        assert.deepEqual(mod.orphanFollowUps(mod.removeItem(d, 11)), []);
        assert.deepEqual(mod.orphanFollowUps(null), []);
    });

    test('planManualAdd：承上題連同前題整組加入；組內有題不能出就整組不加；缺題、重複、不同科、封存、已寫過各自回報', () => {
        const d = mod.draftFromResponse(DRAFT, '王小明');
        const ids = [5, 4, 77, 11, 41, 8, 60, 999];
        const lookup = lookupBody(`/x?ids=${ids.join(',')}`);
        const r = mod.planManualAdd(d, lookup, ids);
        assert.deepEqual(mod.draftQuestionIds(r.draft), [11, 12, 21, 4, 5, 77], '要 5 → 4、5 整組加在手動組；同批的 4 不再重複');
        const added = Object.fromEntries(r.draft.items.filter(i => i.bucket === 'manual').map(i => [i.question_id, i]));
        assert.deepEqual([added[4].follows_question_id, added[5].follows_question_id, added[5].group_ids], [null, 4, [4, 5]]);
        assert.equal(added[5].question_text_preview, '自製題 5');
        assert.deepEqual(r.added, [{ question_id: 5, ids: [4, 5], group: [4, 5] }, { question_id: 77, ids: [77], group: [77] }]);
        assert.deepEqual(r.errors, [
            { question_id: 11, error: 'duplicate' },
            { question_id: 41, error: 'group_unavailable', group: [40, 41], blockers: [40] },
            { question_id: 8, error: 'archived' },
            { question_id: 60, error: 'other_subject', subject: '物理' },
            { question_id: 999, error: 'missing' }
        ]);
        assert.equal(d.items.length, 3, '不改原草稿');
        // 前題本身他寫過 → answered
        assert.deepEqual(mod.planManualAdd(d, lookupBody('/x?ids=40'), [40]).errors, [{ question_id: 40, error: 'answered' }]);

        const toasts = mod.manualAddToasts(r, r.draft);
        const text = toasts.map(t => `${t.type}:${t.message}`).join('\n');
        assert.match(text, /success:#5 屬於承上題組（#4、#5），承上題要與前題整組出：已整組加入 王小明 的補救卷草稿。/);
        assert.match(text, /success:已把 #77 加入 王小明 的補救卷草稿。/);
        assert.match(text, /info:#11 已在補救卷草稿裡，略過。/);
        assert.match(text, /error:找不到題目 #999。/);
        assert.match(text, /error:#60 是物理題，這份草稿是數學；補救卷不混科，沒有加入。/);
        assert.match(text, /error:#8 已封存，沒有加入。/);
        assert.match(text, /error:#41 屬於承上題組（#40、#41），但 #40 已封存、他寫過或不同科；承上題要整組出，這一組沒有加入。/);
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
        // 用 ID 加兩題（其中 11 已在草稿裡：不必問伺服器；77 先查題目資料再加）
        $('remAddId').value = '#77, 11';
        $('remAddBtn').click();
        await settle();
        assert.ok($('remDraft').querySelector('div[data-bucket="manual"]'), '手動加入的題要自成一組');
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message.includes('#11 已在補救卷草稿裡')));
        const lookup = env.window.ExamApp.calls.fetches.filter(f => f.url.startsWith('/api/students/1/remedial-paper/items'));
        assert.deepEqual(lookup.map(f => f.url), ['/api/students/1/remedial-paper/items?ids=77'], '已在草稿裡的題不查');
        assert.ok($('remDraft').textContent.includes('自製題 77'), '手動加的題顯示查回來的題幹預覽');
        // 確認
        $('remConfirm').click();
        await settle();
        const confirm = env.window.ExamApp.calls.fetches.find(f => f.url === '/api/confirm-paper');
        assert.deepEqual(confirm.body, { student_id: 1, question_ids: [11, 21, 77] });
        assert.ok($('remResult').textContent.includes('已出卷：王小明-向量內積特訓卷(2026_9_24)（3 題）'));
        assert.ok($('remDownload'), '確認後要提供 Word 下載');
        assert.equal($('remDraft').querySelectorAll('div[data-question-id]').length, 0, '確認後草稿清空');
    });

    // 〔stage5 審查修正〕補救卷也要拿得到學生版／詳解版
    test('確認後可選 Word 版本：送出的 body 帶 edition，預設 standard', async () => {
        await mount({
            examApp: routedBridge({
                'POST /api/download-word': () => Promise.resolve(new Response(new Uint8Array([80, 75, 3, 4]), {
                    status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
                }))
            })
        });
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
        $('remConfirm').click();
        await settle();
        const sel = $('remWordEdition');
        assert.ok(sel, '要有版本選單');
        assert.deepEqual(sel.querySelectorAll('option').map(o => o.getAttribute('value')), ['standard', 'student', 'solution']);
        $('remDownload').click();
        await settle();
        sel.value = 'solution';
        $('remDownload').click();
        await settle();
        const posts = env.window.ExamApp.calls.fetches.filter(f => f.url === '/api/download-word');
        assert.deepEqual(posts.map(f => f.body.edition), ['standard', 'solution']);
        assert.deepEqual(posts[1].body.question_ids, [11, 12, 21]);
    });

    test('wordDownloadRequest：檔名加版本後綴，不認得的版本當 standard', async () => {
        const mod = await loadFresh('remedial.js');
        const paper = { paper_title: '王小明-補救卷', student_name: '王小明', question_ids: [1, 2] };
        assert.deepEqual(mod.wordDownloadRequest(paper, 'student'), {
            body: { paper_title: '王小明-補救卷', student_name: '王小明', question_ids: [1, 2], edition: 'student' },
            filename: '王小明-補救卷（學生版）.docx'
        });
        assert.equal(mod.wordDownloadRequest(paper, 'solution').filename, '王小明-補救卷（詳解版）.docx');
        assert.equal(mod.wordDownloadRequest(paper, 'bogus').body.edition, 'standard');
        assert.equal(mod.wordDownloadRequest(paper, 'bogus').filename, '王小明-補救卷.docx');
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

    // 〔stage5 審查修正〕跨學生加入時卡住：提供「捨棄草稿」
    test('草稿是別的學生的 → 提示「捨棄草稿」；按下捨棄後同一個事件就能開新草稿', async () => {
        const mod = await mount();
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 55, student_id: 2, subject: '物理' } }));
        await settle();
        const add77 = () => env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 77, student_id: 1, subject: '數學' } }));
        add77();
        await settle();
        const blocked = env.window.ExamApp.calls.toasts.find(t => t.message.includes('另一位學生'));
        assert.ok(blocked && blocked.message.includes('李小華') && blocked.message.includes('捨棄草稿'), JSON.stringify(blocked));

        $('remDiscard').click();
        await settle();
        assert.ok($('remDraft').textContent.includes('選好學生與科目後按「產生草稿」'), '捨棄後回到空白狀態');
        add77();
        await settle();
        assert.ok($('remDraft').textContent.includes('王小明　·　數學　·　草稿 1 題'), $('remDraft').textContent.slice(0, 80));
    });

    test('已有手動加入的題時重新產生草稿 → 提示哪些手動題沒有保留', async () => {
        await mount();
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
        $('remAddId').value = '77';
        $('remAddBtn').click();
        await settle();
        $('remGenerate').click();
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message.includes('#77') && t.message.includes('沒有保留')));
    });

    test('題源限制：預設不帶 source_types；選「僅乾淨題源」送出與組卷頁相同的陣列', async () => {
        await mount();
        $('remStudent').value = '1';
        $('remSourceScope').value = 'clean';
        $('remGenerate').click();
        await settle();
        const post = env.window.ExamApp.calls.fetches.find(f => f.method === 'POST' && f.url === '/api/students/1/remedial-paper');
        assert.deepEqual(post.body.source_types, ['official', 'school', 'self']);
    });

    test('SOURCE_SCOPES 與組卷頁 index.html 的選項、SOURCE_SCOPE_MAP 逐字相同（兩邊不會走鐘）', async () => {
        const mod = await loadFresh('remedial.js');
        const html = fs.readFileSync(path.resolve(JS_DIR, '..', 'index.html'), 'utf8');
        const select = html.match(/<select id="paper_source_scope"[\s\S]*?<\/select>/)[0];
        const options = [...select.matchAll(/<option value="(\w+)"[^>]*>([^<]+)<\/option>/g)].map(m => [m[1], m[2]]);
        assert.deepEqual(mod.SOURCE_SCOPES.map(r => [r[0], r[1]]), options);
        const map = html.match(/const SOURCE_SCOPE_MAP = (\{[\s\S]*?\});/)[1];
        const parsed = Function(`return (${map});`)();
        for (const [value, , types] of mod.SOURCE_SCOPES) assert.deepEqual(types, parsed[value] ?? null, value);
        assert.deepEqual(mod.remedialRequestBody({ subject: '數學', total: 10, mix: {}, days: 90, scope: 'all' }),
            { subject: '數學', total: 10, mix: {}, days: 90 });
    });

    test('remedial:add：沒有草稿也沒選學生 → 提示先選學生', async () => {
        const mod = await mount();
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 55 } }));
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.type === 'error' && t.message.includes('選學生')));
    });

    // ── 承上題整組（審查發現：刪前題會留下學生寫不了的承上題，confirm-paper 照出）──
    const target = DRAFT.items[0].target;
    const GROUPED = {
        ...DRAFT, question_ids: [4, 5, 11, 21],
        items: [
            { question_id: 4, bucket: 'remedial', target, chapter: '向量內積', difficulty: 2, question_text_preview: '前題', follows_question_id: null, group_ids: [4, 5] },
            { question_id: 5, bucket: 'remedial', target, chapter: '向量內積', difficulty: 2, question_text_preview: '承上題', follows_question_id: 4, group_ids: [4, 5] },
            { ...DRAFT.items[0], follows_question_id: null, group_ids: [11] },
            { ...DRAFT.items[2], follows_question_id: null, group_ids: [21] }
        ]
    };
    const cardsOf = root => root.querySelectorAll('div[data-question-id]');
    const idsOf = root => cardsOf(root).map(c => Number(c.getAttribute('data-question-id')));
    const cardOf = (root, id) => cardsOf(root).find(c => c.getAttribute('data-question-id') === String(id));

    async function generated(draftBody) {
        await mount({ examApp: routedBridge({ 'POST /api/students/1/remedial-paper': () => respond(draftBody) }) });
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
    }

    test('承上題組：標「承上 #x」、按鈕是「刪這組」；刪前題連承上題一起刪，確認送出的不會有半組', async () => {
        await generated(GROUPED);
        const draft = $('remDraft');
        assert.equal(cardOf(draft, 4).getAttribute('data-group'), '4,5');
        assert.ok(cardOf(draft, 5).textContent.includes('承上 #4'));
        assert.ok(cardOf(draft, 4).textContent.includes('有承上題'));
        assert.deepEqual([4, 5, 11].map(id => cardOf(draft, id).querySelector('button').textContent), ['刪這組', '刪這組', '刪除']);
        assert.equal(cardOf(draft, 4).querySelector('button').getAttribute('aria-label'), '從草稿刪除承上題組 #4、#5');
        assert.equal(cardOf(draft, 11).getAttribute('data-group'), null, '沒有綁定的題不標組');

        cardOf(draft, 4).querySelector('button').click();
        await settle();
        assert.deepEqual(idsOf($('remDraft')), [11, 21], '刪前題 → 承上題一起刪');
        $('remConfirm').click();
        await settle();
        assert.deepEqual(env.window.ExamApp.calls.fetches.find(f => f.url === '/api/confirm-paper').body.question_ids, [11, 21]);
    });

    test('刪承上題也是整組刪', async () => {
        await generated(GROUPED);
        cardOf($('remDraft'), 5).querySelector('button').click();
        await settle();
        assert.deepEqual(idsOf($('remDraft')), [11, 21]);
    });

    test('用 ID 加承上題：連同前題整組加入；組內有他寫過的題、封存、不同科、查不到 → 不加並說明', async () => {
        await generated(DRAFT);
        $('remAddId').value = '5 41 8 60 999';
        $('remAddBtn').click();
        await settle();
        const manual = $('remDraft').querySelector('div[data-bucket="manual"]');
        assert.deepEqual(idsOf(manual), [4, 5], '只有 4、5 整組加入');
        assert.ok(cardOf(manual, 5).textContent.includes('承上 #4'));
        assert.deepEqual([4, 5].map(id => cardOf(manual, id).querySelector('button').textContent), ['刪這組', '刪這組']);
        const toasts = env.window.ExamApp.calls.toasts.map(t => t.message).join('\n');
        for (const re of [/#5 屬於承上題組（#4、#5）.*已整組加入/, /#41 屬於承上題組（#40、#41），但 #40 .*這一組沒有加入/,
            /#8 已封存/, /#60 是物理題.*不混科/, /找不到題目 #999/]) {
            assert.match(toasts, re);
        }
        // 手動加入的組同樣整組刪
        cardOf(manual, 4).querySelector('button').click();
        await settle();
        assert.equal($('remDraft').querySelector('div[data-bucket="manual"]'), null);
        assert.deepEqual(idsOf($('remDraft')), [11, 12, 21]);
    });

    test('remedial:add：別的科目直接擋（不查伺服器）；承上題同樣整組加入', async () => {
        const mod = await mount();
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
        const lookups = () => env.window.ExamApp.calls.fetches.filter(f => f.url.includes('/remedial-paper/items')).length;
        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 60, student_id: 1, subject: '物理' } }));
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.type === 'error' && t.message.includes('#60 是物理題') && t.message.includes('不混科')));
        assert.equal(lookups(), 0, '科目不同在前端就擋');
        assert.deepEqual(idsOf($('remDraft')), [11, 12, 21]);

        env.document.dispatchEvent(new CustomEvent(mod.REMEDIAL_ADD_EVENT, { detail: { question_id: 5, student_id: 1, subject: '數學' } }));
        await settle();
        assert.equal(lookups(), 1);
        assert.deepEqual(idsOf($('remDraft')), [11, 12, 21, 4, 5], '承上題 #5 連同前題 #4 加入');
    });

    test('確認前的最後一道：草稿裡有缺前題的承上題 → 不送 confirm-paper', async () => {
        await generated({ ...DRAFT, items: [...DRAFT.items, { ...DRAFT.items[0], question_id: 6, follows_question_id: 999 }] });
        $('remConfirm').click();
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.type === 'error' && t.message.includes('承上題不能沒有前題：#6（承上 #999）')));
        assert.equal(env.window.ExamApp.calls.fetches.filter(f => f.url === '/api/confirm-paper').length, 0);
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
