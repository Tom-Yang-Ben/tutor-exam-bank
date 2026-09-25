// ─────────────────────────────────────────────────────────────
// test/unit/retrainPaperUi.test.js — 錯題重練 PR-3（出卷整合）的前端掛鉤（docs/retrain-and-review.md 第 5.3 節；
// 第 6.3 節 TC-040-2 中「組卷頁附帶選項（預設不勾、題數預設三成）」那一部分）
//
// 三塊，全部用 test/unit/lib/miniDom.js 真的跑起來（不連 DB、不呼叫 LLM）：
//   1. 組卷頁（public/index.html 的 inline script）：把「〔retrain〕組卷頁掛鉤 開始」到「結束」之間的程式抽出來執行
//      ——旗標關閉不渲染、選了學生才出現、預設不勾、題數預設 capForAttach(新題數)（與 services/retrainSchedule.js 同一條規則）、
//      送出的 retrain、預覽的徽章與「移除這題」、確認時的 retrain_question_ids、伺服器文字一律 textContent。
//   2. 補救卷（public/js/remedial.js）：配比下方「附上到期重練 [N] 題」、草稿的「到期重練」組、確認與 Word 下載多帶的鍵。
//   3. 試卷列表（public/js/students.js 的最小掛鉤）：卷名旁「含重練 N 題」。
// PR-4 的 public/js/retrain.js（清單卡、批改卡勾選框、學生清單徽章）另有自己的測試（retrainUi.test.js），這裡不碰。
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');
const { capForAttach } = require('../../services/retrainSchedule');
const { DEFAULT_ATTACH_RATIO } = require('../../config/retrain');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const JS_DIR = path.join(PUBLIC_DIR, 'js');

let seq = 0;
async function loadFresh(name) {
    const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8') + `\n// instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };
const respond = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

// ═════════════════════════ 1. 組卷頁（index.html inline script）═════════════════════════

const BEGIN = '// 〔retrain〕組卷頁掛鉤 開始';
const END = '// 〔retrain〕組卷頁掛鉤 結束';
const BLOCK = (() => {
    const i = HTML.indexOf(BEGIN);
    const j = HTML.indexOf(END);
    assert.ok(i > 0 && j > i, 'index.html 找不到〔retrain〕組卷頁掛鉤的開始／結束標記');
    return HTML.slice(i, j);
})();
/** index.html 自己那份 featureOn（旗標讀法）：原樣抽出來用。 */
const FEATURE_ON = HTML.match(/function featureOn\(name\) \{[\s\S]*?\n {8}\}/)[0];

/**
 * 建一個「組卷頁」：學生下拉、科目、題數、插入點，然後執行抽出來的程式。
 * @returns {object} 抽出來的函式＋fetches（apiFetch 的呼叫紀錄）
 */
function mountPaperPage({ retrain = 'true', ratio, student = '3', count = '20', due = 4 } = {}) {
    const meta = { 'feature-retrain': retrain };
    if (ratio !== undefined) meta['retrain-attach-ratio'] = ratio;
    env = install({ meta });
    const doc = env.document;
    const body = doc.querySelector('body');
    const sel = doc.createElement('select');
    sel.id = 'student_select';
    for (const [v, name] of [['', '-- 請選擇學生 --'], ['3', '王小明']]) {
        const o = doc.createElement('option');
        o.value = v;
        o.textContent = name;
        if (v) o.setAttribute('data-name', name);
        sel.appendChild(o);
    }
    sel.value = student;
    const subject = doc.createElement('select');
    subject.id = 'paper_subject';
    const opt = doc.createElement('option');
    opt.value = '數學';
    subject.appendChild(opt);
    const countInput = doc.createElement('input');
    countInput.id = 'count';
    countInput.value = count;
    const slot = doc.createElement('div');
    slot.id = 'retrainAttachSlot';
    slot.hidden = true;                                  // index.html 裡是 <div id="retrainAttachSlot" hidden>
    body.append(sel, subject, countInput, slot);

    const fetches = [];
    const apiFetch = (url, options) => {
        fetches.push({ url, method: (options || {}).method || 'GET' });
        return respond({ as_of: '2026-10-12', counts: { active: 9, due, in_flight: 0, stuck: 0, mastered: 0, retired: 0 }, items: [] });
    };
    const selectedStudent = () => {
        const s = doc.getElementById('student_select');
        const o = s.options.find(x => x.value === s.value);
        return s.value && o ? { id: Number(s.value), name: o.getAttribute('data-name') } : null;
    };
    const api = new Function('selectedStudent', 'apiFetch', `${FEATURE_ON}\n${BLOCK}\nreturn { syncRetrainAttach, retrainAttachRequest,
        retrainCapForAttach, retrainAttachRatio, removeRetrainFromPreview, retrainConfirmKeys, retrainBadgeNodes, retrainSummaryNodes };`)(
        selectedStudent, apiFetch);
    return { ...api, fetches, doc, slot, countInput, sel };
}
const $ = id => env.document.getElementById(id);

describe('組卷頁〔retrain〕：附上到期的重練題（R6、R7）', () => {
    test('旗標關閉：那一列不渲染（插入點保持空的、hidden），不打任何 API、請求不帶 retrain', async () => {
        for (const retrain of ['false', '__FEATURE_RETRAIN__', '']) {
            const p = mountPaperPage({ retrain });
            p.syncRetrainAttach();
            await settle();
            assert.equal(p.slot.hidden, true, retrain);
            assert.equal(p.slot.childElementCount, 0, retrain);
            assert.equal($('retrainAttach'), null);
            assert.deepEqual(p.fetches, []);
            assert.equal(p.retrainAttachRequest(), null);
            assert.deepEqual(p.retrainConfirmKeys({ questions: [{ id: 1 }], question_ids: [1] }), {}, '回應沒有 retrain＝確認時不多帶鍵');
            env.restore(); env = null;
        }
    });

    test('旗標開啟、還沒選學生：不渲染', async () => {
        const p = mountPaperPage({ student: '' });
        p.syncRetrainAttach();
        await settle();
        assert.equal(p.slot.hidden, true);
        assert.equal(p.slot.childElementCount, 0);
    });

    test('選了學生：出現勾選框（預設不勾）、題數預設三成（capForAttach）、顯示目前到期 M 題', async () => {
        const p = mountPaperPage({ count: '20', due: 4 });
        p.syncRetrainAttach();
        await settle();
        assert.equal(p.slot.hidden, false);
        assert.equal($('retrainAttach').checked, false, '預設不勾（R6）');
        assert.equal($('retrainAttachCount').value, '6', '新題 20 題 → 6 題');
        assert.equal($('retrainAttachDue').textContent, '（目前到期 4 題）');
        assert.ok(p.slot.textContent.includes('附上到期的重練題'));
        assert.deepEqual(p.fetches, [{ url: '/api/students/3/retrain-items?status=due&subject=%E6%95%B8%E5%AD%B8', method: 'GET' }]);
        assert.equal(p.retrainAttachRequest(), null, '沒勾就不帶 retrain（請求與 PR-3 之前相同）');
        $('retrainAttach').checked = true;
        assert.deepEqual(p.retrainAttachRequest(), { count: 6 });
    });

    test('題數改變時跟著更新預設（不重讀到期數）；老師改過 N 就不再覆寫', async () => {
        const p = mountPaperPage({ count: '20' });
        p.syncRetrainAttach();
        await settle();
        for (const [n, want] of [['7', '2'], ['3', '0'], ['45', '5'], ['', '1']]) {   // 空白＝5 題（同 requestPreview）
            p.countInput.value = n;
            p.syncRetrainAttach({ refreshDue: false });
            assert.equal($('retrainAttachCount').value, want, `新題 ${n || '（空）'}`);
        }
        assert.equal(p.fetches.length, 1, '題數改變不重讀到期數');
        $('retrainAttachCount').value = '9';
        $('retrainAttachCount').dispatchEvent({ type: 'input' });
        p.countInput.value = '30';
        p.syncRetrainAttach();
        await settle();
        assert.equal($('retrainAttachCount').value, '9', '老師改過的不覆寫');
        assert.equal(p.fetches.length, 2, '換學生／科目時重讀');
        $('retrainAttach').checked = true;
        assert.deepEqual(p.retrainAttachRequest(), { count: 9 });
        $('retrainAttachCount').value = 'abc';
        assert.ok(Number.isNaN(p.retrainAttachRequest().count), '不合法的數字照送（JSON 裡是 null），由伺服器回 400');
    });

    test('比例讀 <meta name="retrain-attach-ratio">（RETRAIN_ATTACH_RATIO）；沒注入或不合法退回 0.3', async () => {
        for (const [ratio, want] of [['0.5', '10'], ['1', '20'], ['__RETRAIN_ATTACH_RATIO__', '6'], ['abc', '6'], ['3', '6'], [undefined, '6']]) {
            const p = mountPaperPage({ ratio, count: '20' });
            p.syncRetrainAttach({ refreshDue: false });
            assert.equal($('retrainAttachCount').value, want, String(ratio));
            env.restore(); env = null;
        }
    });

    test('retrainCapForAttach 與 services/retrainSchedule.js 的 capForAttach 逐一相同（前後端不會走鐘）', () => {
        const p = mountPaperPage();
        for (const ratio of [0, 0.29, DEFAULT_ATTACH_RATIO, 0.5, 1, 2]) {
            for (let n = 0; n <= 60; n++) {
                if (n > 50) continue;
                assert.equal(p.retrainCapForAttach(n, ratio), capForAttach(n, ratio), `n=${n} ratio=${ratio}`);
            }
        }
        assert.equal(p.retrainAttachRatio(), DEFAULT_ATTACH_RATIO);
    });

    test('預覽：重練題的徽章「重練・第 n 關」、摘要一行（都用 textContent）；新題沒有徽章', () => {
        const p = mountPaperPage();
        assert.deepEqual(p.retrainBadgeNodes({ id: 1, purpose: 'new' }), []);
        assert.deepEqual(p.retrainBadgeNodes({ id: 1 }), [], '旗標關閉時題目沒有 purpose');
        const [badge] = p.retrainBadgeNodes({ id: 2, purpose: 'retrain', retrain_step: 2 });
        assert.equal(badge.textContent, '重練・第 2 關');
        assert.deepEqual(p.retrainSummaryNodes({ questions: [] }), []);
        const [line] = p.retrainSummaryNodes({ retrain: { wanted: 3, got: 2, due_total: 5 } });
        assert.equal(line.textContent, '附上到期的重練題 2 題（要 3 題；目前到期 5 題）。重練題就是他以前錯過的原題，學生的卷面不會標出來。');
        assert.ok(!BLOCK.includes('innerHTML'), '這一段不用 innerHTML（伺服器文字一律 textContent）');
    });

    test('預覽上「移除這題」：承上組整組移除、got 跟著變；確認時帶剩下的重練題', () => {
        const p = mountPaperPage();
        const preview = {
            student_id: 3, question_ids: [1, 20, 21, 30],
            questions: [
                { id: 1, purpose: 'new', follows_question_id: null },
                { id: 20, purpose: 'retrain', retrain_step: 1, follows_question_id: null },
                { id: 21, purpose: 'retrain', retrain_step: 1, follows_question_id: 20 },
                { id: 30, purpose: 'retrain', retrain_step: 2, follows_question_id: null }
            ],
            retrain: { wanted: 3, got: 3, due_total: 4 }
        };
        assert.deepEqual(p.retrainConfirmKeys(preview), { retrain_question_ids: [20, 21, 30] });
        const r = p.removeRetrainFromPreview(preview, 21);
        assert.deepEqual(r.removed, [20, 21]);
        assert.deepEqual(r.preview.question_ids, [1, 30]);
        assert.deepEqual(r.preview.retrain, { wanted: 3, got: 1, due_total: 4 });
        assert.deepEqual(p.retrainConfirmKeys(r.preview), { retrain_question_ids: [30] });
        assert.equal(preview.questions.length, 4, '不改動原本的預覽');
        const r2 = p.removeRetrainFromPreview(r.preview, 30);
        assert.deepEqual(p.retrainConfirmKeys(r2.preview), { retrain_question_ids: [] }, '全部移除也照樣帶（空陣列）');
    });

    test('index.html 的最小掛鉤：插入點 hidden、送出與確認只在勾了／有附時才多帶鍵、R12 的 400 照舊顯示', () => {
        assert.ok(HTML.includes('<div id="retrainAttachSlot" hidden></div>'));
        assert.ok(HTML.includes('<meta name="retrain-attach-ratio" content="__RETRAIN_ATTACH_RATIO__">'));
        // requestPreview：沒勾（retrainAttachRequest 回 null）就不改 data
        assert.match(HTML, /const retrainReq = retrainAttachRequest\(\);\s*if \(retrainReq\) \{\s*data\.retrain = retrainReq;/);
        // confirmPaper：只在預覽有 retrain 時多 retrain_question_ids
        assert.match(HTML, /question_ids: draftPreview\.question_ids,\s*\.\.\.retrainConfirmKeys\(draftPreview\)/);
        // 預覽卡：重練題的按鈕是「移除這題／移除這組」，新題照舊「換這題／換這組」
        assert.ok(HTML.includes("isRetrain ? (inGroup.has(q.id) ? '移除這組' : '移除這題') : (inGroup.has(q.id) ? '換這組' : '換這題')"));
        // 伺服器的 400（含 R12）照舊由 requestPreview 的錯誤分支顯示 result.message（textContent）
        assert.match(HTML, /resultIds\.textContent = result\.message \|\| '未知錯誤';/);
        // 抽出來的那一段只依賴 featureOn、selectedStudent、apiFetch 與 document（可以獨立測）
        for (const outer of ['draftPreview', 'renderPreview', 'showToast', 'draftExcluded']) {
            assert.ok(!new RegExp(`\\b${outer}\\b`).test(BLOCK), `抽出來的那一段不該用到 ${outer}`);
        }
    });
});

// ═════════════════════════ 2. 補救卷（public/js/remedial.js）═════════════════════════

const DRAFT = {
    student_id: 1, subject: '數學', basis: 'chapter', question_ids: [11, 40, 41],
    items: [
        { question_id: 11, bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, chapter: '向量內積', difficulty: 2, question_text_preview: '自製題 11', group_ids: [11] },
        { question_id: 40, bucket: 'retrain', target: { type: 'retrain', name: '到期重練' }, chapter: '向量內積', difficulty: 2, question_text_preview: '以前錯過的 40', follows_question_id: null, group_ids: [40, 41], item_id: 7, step: 2, step_label: '一週回測', due_on: '2026-10-10', overdue_days: 2 },
        { question_id: 41, bucket: 'retrain', target: { type: 'retrain', name: '到期重練' }, chapter: '向量內積', difficulty: 3, question_text_preview: '以前錯過的 41', follows_question_id: 40, group_ids: [40, 41], item_id: 8, step: 1, step_label: '錯題重練', due_on: '2026-10-10', overdue_days: 2 }
    ],
    blueprint: [
        { bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 1, got: 1, difficulty_min: null, difficulty_max: 3, rationale: '掌握度下界 5%' },
        { bucket: 'retrain', target: { type: 'retrain', name: '到期重練' }, wanted: 3, got: 2, difficulty_min: null, difficulty_max: null, rationale: '到期 2 題' }
    ],
    shortfalls: [{ bucket: 'retrain', target: { type: 'retrain', name: '到期重練' }, wanted: 3, got: 2, reason: 'not_enough_due' }],
    notes: []
};

function remedialBridge() {
    const bridge = fakeBridge();
    const routes = {
        'GET /api/students': () => respond({ items: [{ id: 1, name: '王小明', papers: 2, graded_ratio: 1 }] }),
        'GET /api/chapter-whitelist': () => respond({ 數學: ['向量內積'] }),
        'POST /api/students/1/remedial-paper': () => respond(DRAFT),
        'GET /api/students/1/weakness/kc': () => respond({ rows: [], untagged_graded: 0 }),
        'GET /api/students/1/retrain-items': () => respond({ as_of: '2026-10-12', counts: { active: 5, due: 3, in_flight: 0, stuck: 0, mastered: 0, retired: 0 }, items: [] }),
        'POST /api/confirm-paper': body => respond({ message: 'ok', paper_id: 9, paper_title: '王小明-向量內積特訓卷(2026_10_12)', question_ids: body.question_ids, questions: [] }),
        'GET /api/coverage': () => respond({ rows: [], kc_rows: [] })
    };
    bridge.apiFetch = (url, options) => {
        const method = (options || {}).method || 'GET';
        const body = typeof (options || {}).body === 'string' ? JSON.parse(options.body) : null;
        bridge.calls.fetches.push({ url, method, body });
        const route = routes[`${method} ${url.split('?')[0]}`];
        return route ? route(body, url) : respond({ message: `沒有假資料：${method} ${url}` }, 501);
    };
    return bridge;
}

async function mountRemedial(meta) {
    env = install({ meta: { 'feature-remedial': 'true', ...meta }, sections: ['remedial', 'coverage'], search: '', examApp: remedialBridge() });
    const mod = await loadFresh('remedial.js');
    await mod.init();
    await settle();
    return mod;
}

describe('補救卷〔retrain PR-3〕：配比下方「附上到期重練 [N] 題」與「到期重練」組（R6、R7）', () => {
    test('純函式：比例、預設題數（三成、≤ 20、合計 ≤ 50）、確認時多帶的鍵、Word 下載的 paper_id', async () => {
        const mod = await loadFresh('remedial.js');
        assert.equal(mod.parseAttachRatio('0.5'), 0.5);
        for (const bad of ['__RETRAIN_ATTACH_RATIO__', '', 'x', '3', null, undefined, '-1']) assert.equal(mod.parseAttachRatio(bad), 0.3, String(bad));
        assert.deepEqual([20, 7, 50, 5, 45].map(n => mod.retrainDefaultCount(n, 0.3)), [6, 2, 0, 1, 5]);
        assert.equal(mod.retrainDefaultCount(50, 2), 0);
        assert.equal(mod.retrainDefaultCount(30, 1), 20, 'API-8 上限 20');
        for (let n = 5; n <= 50; n++) assert.equal(mod.retrainDefaultCount(n, 0.3), Math.min(20, capForAttach(n)), `n=${n}`);
        assert.deepEqual(mod.retrainConfirmKeys(DRAFT), { retrain_question_ids: [40, 41] });
        assert.deepEqual(mod.retrainConfirmKeys({ items: [DRAFT.items[0]] }), {});
        assert.deepEqual(mod.retrainConfirmKeys(null), {});
        const paper = { paper_title: 'T', student_name: 'S', question_ids: [1], paper_id: 9 };
        assert.deepEqual(mod.wordDownloadRequest(paper, 'standard').body, { paper_title: 'T', student_name: 'S', question_ids: [1], edition: 'standard' },
            '沒給 paperId 時與 PR-3 之前相同');
        assert.deepEqual(mod.wordDownloadRequest(paper, 'solution', { paperId: 9 }).body,
            { paper_title: 'T', student_name: 'S', question_ids: [1], edition: 'solution', paper_id: 9 });
        assert.deepEqual(mod.remedialRequestBody({ subject: '數學', total: 10, mix: {}, days: 90, scope: 'all', retrainCount: 0 }),
            { subject: '數學', total: 10, mix: {}, days: 90 }, 'retrain_count 0 不帶');
        assert.equal(mod.remedialRequestBody({ subject: '數學', total: 10, mix: {}, days: 90, retrainCount: 3 }).retrain_count, 3);
        assert.deepEqual(mod.BUCKET_ORDER, ['remedial', 'prerequisite', 'extension', 'retrain', 'manual']);
        assert.equal(mod.BUCKET_LABEL.retrain, '到期重練');
        // 到期重練的承上組照樣整組刪（group_ids 相連）
        const d = mod.draftFromResponse(DRAFT, '王小明');
        assert.deepEqual(mod.draftQuestionIds(mod.removeItem(d, 41)), [11]);
        assert.deepEqual(mod.retrainConfirmKeys(mod.removeItem(d, 40)), {}, '整組刪掉之後確認時就不帶');
    });

    test('旗標關閉：沒有那一列，產生草稿的 body 沒有 retrain_count', async () => {
        await mountRemedial({ 'feature-retrain': 'false' });
        assert.equal($('remRetrainRow'), null);
        $('remStudent').value = '1';
        $('remGenerate').click();
        await settle();
        const post = env.window.ExamApp.calls.fetches.find(f => f.method === 'POST' && f.url === '/api/students/1/remedial-paper');
        assert.ok(post && !('retrain_count' in post.body));
        assert.ok(!env.window.ExamApp.calls.fetches.some(f => f.url.includes('/retrain-items')), '不打重練的 API');
    });

    test('旗標開啟：那一列預設不勾、N 預設三成；選學生後顯示到期數；勾了才帶 retrain_count', async () => {
        await mountRemedial({ 'feature-retrain': 'true', 'retrain-attach-ratio': '0.3' });
        assert.ok($('remRetrainRow'));
        assert.equal($('remRetrainAttach').checked, false, '預設不勾');
        assert.equal($('remRetrainCount').value, '6', '題數 20 → 6');
        $('remTotal').value = '10';
        $('remTotal').dispatchEvent({ type: 'input' });
        assert.equal($('remRetrainCount').value, '3', '題數改了跟著改');
        $('remStudent').value = '1';
        $('remStudent').dispatchEvent({ type: 'change' });
        await settle();
        assert.equal($('remRetrainDue').textContent, '（目前到期 3 題）');

        $('remGenerate').click();
        await settle();
        let posts = env.window.ExamApp.calls.fetches.filter(f => f.method === 'POST' && f.url === '/api/students/1/remedial-paper');
        assert.ok(!('retrain_count' in posts[0].body), '沒勾不帶');
        $('remRetrainAttach').checked = true;
        $('remGenerate').click();
        await settle();
        posts = env.window.ExamApp.calls.fetches.filter(f => f.method === 'POST' && f.url === '/api/students/1/remedial-paper');
        assert.equal(posts[1].body.retrain_count, 3);
        $('remRetrainCount').value = '21';
        $('remGenerate').click();
        await settle();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.type === 'error' && t.message === '到期重練題數要是 0–20 的整數。'));
    });

    test('草稿的「到期重練」組：標關卡（老師看的畫面）、刪除鈕是「刪這組」；確認時帶 retrain_question_ids', async () => {
        await mountRemedial({ 'feature-retrain': 'true' });
        $('remStudent').value = '1';
        $('remRetrainAttach').checked = true;
        $('remGenerate').click();
        await settle();
        const group = env.document.querySelector('div[data-bucket="retrain"]');
        assert.ok(group, '沒有「到期重練」組');
        assert.ok(group.textContent.includes('到期重練（2 題）'), group.textContent.slice(0, 60));
        assert.ok(group.textContent.includes('重練・第 2 關') && group.textContent.includes('重練・第 1 關'));
        assert.ok(!group.textContent.includes('目標：到期重練'), '不重複標目標');
        assert.ok(group.textContent.includes('到期的題不夠'), '不足量的原因有中文標籤');
        assert.ok(group.querySelectorAll('button').every(b => b.textContent === '刪這組'), '承上組整組刪');
        $('remConfirm').click();
        await settle();
        const post = env.window.ExamApp.calls.fetches.find(f => f.url === '/api/confirm-paper');
        assert.deepEqual(post.body, { student_id: 1, question_ids: [11, 40, 41], retrain_question_ids: [40, 41] });
    });
});

// ═════════════════════════ 3. 試卷列表（public/js/students.js 的最小掛鉤）═════════════════════════

describe('試卷列表〔retrain PR-3〕：卷名旁「含重練 N 題」', () => {
    function studentsBridge(papers) {
        const bridge = fakeBridge();
        const routes = {
            'GET /api/students': () => respond({ items: [{ id: 3, name: '王小明', papers: papers.length, graded_ratio: 0 }] }),
            'GET /api/students/3/papers': () => respond({ items: papers }),
            'GET /api/students/3/weakness': () => respond({ by_chapter: [], by_type: [], by_difficulty: [], trend_weekly: [], recent_wrong: [] }),
            'GET /api/chapter-whitelist': () => respond({ 數學: ['向量內積'] })
        };
        bridge.apiFetch = (url, options) => {
            const method = (options || {}).method || 'GET';
            const route = routes[`${method} ${url.split('?')[0]}`];
            return route ? route() : respond({ message: '沒有假資料' }, 501);
        };
        return bridge;
    }

    test('API 帶 retrain_count > 0 才渲染；0 或沒有這個鍵（旗標關閉）就不渲染', async () => {
        const papers = [
            { paper_id: 42, title: '王小明-錯題重練卷(2026_10_12)', created_at: '2026-10-12T09:00:00Z', total: 3, graded: 0, retrain_count: 3 },
            { paper_id: 41, title: '王小明-向量內積特訓卷(2026_10_5)', created_at: '2026-10-05T09:00:00Z', total: 5, graded: 5, retrain_count: 0 },
            { paper_id: 40, title: '王小明-舊卷', created_at: '2026-10-01T09:00:00Z', total: 2, graded: 2 }
        ];
        env = install({ meta: { 'feature-students': 'true' }, sections: ['students'], search: '', examApp: studentsBridge(papers) });
        const mod = await loadFresh('students.js');
        await mod.init();
        await settle(10);
        const cards = env.document.querySelectorAll('[data-paper-id]');
        assert.equal(cards.length, 3);
        assert.ok(cards[0].textContent.includes('含重練 3 題'), cards[0].textContent);
        assert.ok(!cards[1].textContent.includes('含重練'), '0 題不標');
        assert.ok(!cards[2].textContent.includes('含重練'), '沒有這個鍵（旗標關閉）不標');
        assert.ok(cards[0].textContent.includes('王小明-錯題重練卷(2026_10_12)'), '卷名照舊');
    });
});
