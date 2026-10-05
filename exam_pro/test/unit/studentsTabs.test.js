// 學生視圖的摘要列與分頁（public/js/students.js「分頁與摘要」一段）
//
// 兩層：summaryStats／tabForAnchor 是純函式，直接測；分頁的切換、篩選器只在有作用的分頁出現、
// #retrain／#remedial 跟著「重練與補救」分頁顯示，則用 test/unit/lib/miniDom.js 對 ?mock=1 真的渲染一遍。

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');

const JS_DIR = path.resolve(__dirname, '..', '..', 'public', 'js');

// module 有模組層狀態（目前的分頁），每個案例都要一份新的實例（做法同 stage3Render.test.js）
let seq = 0;
async function loadFresh(name) {
    const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8') + `\n// tabs instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

const BASE_META = { 'feature-students': 'true', 'feature-similar': 'true', 'feature-variants': 'true' };

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

async function mount(meta = {}) {
    env = install({
        meta: { ...BASE_META, ...meta }, sections: ['students', 'retrain', 'remedial'],
        search: '?mock=1', examApp: fakeBridge()
    });
    const mod = await loadFresh('students.js');
    await mod.init();
    await flush();
    const $ = id => env.document.getElementById(id);
    const tab = name => $('stuTabs').querySelector(`button[data-tab="${name}"]`);
    const hidden = id => $(id).classList.contains('hidden');
    return { mod, $, tab, hidden };
}

describe('summaryStats（純函式）', () => {
    test('待批張數、錯誤率由 by_type 加總、最近出卷日', async () => {
        const { summaryStats } = await loadFresh('students.js');
        const stats = summaryStats(
            [
                { created_at: '2026-08-10T02:41:07.000Z', total: 3, graded: 3 },
                { created_at: '2026-08-21T09:12:33.412Z', total: 4, graded: 3 },
                { created_at: '2026-08-01T00:00:00.000Z', total: 5, graded: 0 }
            ],
            { by_type: [{ graded: 14, wrong: 6 }, { graded: 3, wrong: 1 }, { graded: 3, wrong: 1 }] }
        );
        assert.deepEqual(stats, { papers: 3, pending: 2, graded: 20, wrong: 8, wrongRate: 0.4, lastPaperDate: '2026-08-21' });
    });

    test('沒有試卷、沒有已批改的題：錯誤率是 null（不是 0），日期是 null', async () => {
        const { summaryStats } = await loadFresh('students.js');
        assert.deepEqual(summaryStats([], { by_type: [{ graded: 0, wrong: 0 }] }),
            { papers: 0, pending: 0, graded: 0, wrong: 0, wrongRate: null, lastPaperDate: null });
        assert.equal(summaryStats(undefined, undefined).wrongRate, null);
    });
});

describe('tabForAnchor（純函式）', () => {
    test('#retrain、#remedial 屬於「重練與補救」；其他錨點不理', async () => {
        const { tabForAnchor } = await loadFresh('students.js');
        assert.equal(tabForAnchor('retrain'), 'practice');
        assert.equal(tabForAnchor('#remedial'), 'practice');
        for (const other of ['students', '#review', '', undefined, null]) assert.equal(tabForAnchor(other), null);
    });
});

describe('學生視圖：摘要列與分頁（?mock=1）', () => {
    test('摘要列：待批改、錯誤率、最近出卷；旗標關閉時沒有「到期重練」', async () => {
        const { $ } = await mount();
        const text = $('stuSummary').textContent;
        assert.ok(!$('stuSummary').classList.contains('hidden'));
        assert.ok(text.includes('待批改') && text.includes('1 張') && text.includes('共 2 張試卷'), text);
        // mock 的 by_type：graded 14+3+14＝31、wrong 6+1+4＝11
        assert.ok(text.includes('35.5%') && text.includes('不分科・近 365 天・已批 31 題'), text);
        assert.ok(text.includes('最近出卷') && text.includes('2026-08-21'), text);
        assert.ok(!text.includes('到期重練'));
        assert.equal($('stuSumDue'), null);
    });

    test('預設在「批改」分頁：試卷列表顯示，弱點、報告、統計範圍收起；分頁標題帶待批數', async () => {
        const { $, tab, hidden } = await mount();
        assert.equal(tab('grade').getAttribute('aria-selected'), 'true');
        assert.equal(tab('grade').textContent, '批改（待批 1）');
        assert.equal(hidden('stuPapers'), false);
        assert.equal(hidden('stuWeakness'), true);
        assert.equal(hidden('stuReportBox'), true);
        assert.equal(hidden('stuFilters'), true);
        assert.equal($('stuPaperList').children.length, 2);
    });

    test('切到「弱點」：統計範圍出現，學科與天數下拉在裡面；切到「報告」：統計範圍收起，報告列在報告分頁', async () => {
        const { $, tab, hidden } = await mount();
        tab('weakness').click();
        assert.equal(hidden('stuWeakness'), false);
        assert.equal(hidden('stuPapers'), true);
        assert.equal(hidden('stuFilters'), false);
        assert.ok($('stuFilters').querySelector('#stuSubject') && $('stuFilters').querySelector('#stuDays'));
        assert.equal(tab('weakness').getAttribute('aria-selected'), 'true');
        assert.equal(tab('grade').getAttribute('aria-selected'), 'false');

        tab('report').click();
        assert.equal(hidden('stuReportBox'), false);
        assert.equal(hidden('stuWeakness'), true);
        assert.equal(hidden('stuFilters'), true);
        assert.ok($('stuReportBox').querySelector('#stuReport'), '學習報告那一列在報告分頁');
        assert.equal($('stuWeakness').querySelector('#stuReport'), null, '不再掛在弱點面板底下');
    });

    test('換學生、換統計範圍之後停在原本的分頁', async () => {
        const { $, hidden, tab } = await mount();
        tab('weakness').click();
        $('stuSubject').dispatchEvent({ type: 'change' });
        await flush();
        assert.equal(hidden('stuWeakness'), false);
        assert.equal(hidden('stuPapers'), true);
    });

    test('按摘要的「錯誤率」那一格 → 切到弱點分頁', async () => {
        const { $, hidden } = await mount();
        $('stuSummary').children[1].click();
        assert.equal(hidden('stuWeakness'), false);
    });

    test('重練與補救兩個旗標都關：不畫那個分頁，#retrain、#remedial 收起', async () => {
        const { $, tab } = await mount();
        assert.equal(tab('practice'), null);
        assert.deepEqual($('stuTabs').children.map(b => b.getAttribute('data-tab')), ['grade', 'weakness', 'report']);
        assert.equal($('retrain').style.display, 'none');
        assert.equal($('remedial').style.display, 'none');
    });

    test('有開旗標：#retrain、#remedial 只在「重練與補救」分頁顯示；統計範圍也在；摘要多「到期重練」', async () => {
        const { $, tab, hidden } = await mount({ 'feature-retrain': 'true', 'feature-remedial': 'true' });
        assert.equal($('retrain').style.display, 'none');
        assert.ok($('stuSummary').textContent.includes('到期重練'));
        assert.ok($('stuSumDue'));
        tab('practice').click();
        assert.equal($('retrain').style.display, '');
        assert.equal($('remedial').style.display, '');
        assert.equal(hidden('stuFilters'), false);
        assert.equal(hidden('stuPapers'), true);
        tab('grade').click();
        assert.equal($('remedial').style.display, 'none');
    });

    test('STUDENT_TAB_EVENT：anchor＝remedial 切到「重練與補救」；不認得的錨點不動', async () => {
        const { mod, $, tab } = await mount({ 'feature-remedial': 'true' });
        env.document.dispatchEvent(new CustomEvent(mod.STUDENT_TAB_EVENT, { detail: { anchor: 'students' } }));
        assert.equal(tab('grade').getAttribute('aria-selected'), 'true');
        env.document.dispatchEvent(new CustomEvent(mod.STUDENT_TAB_EVENT, { detail: { anchor: 'remedial' } }));
        assert.equal(tab('practice').getAttribute('aria-selected'), 'true');
        assert.equal($('remedial').style.display, '');
    });

    test('remedial.js 與 index.html 發的事件名與本檔一致', async () => {
        const { STUDENT_TAB_EVENT } = await loadFresh('students.js');
        const remedial = fs.readFileSync(path.join(JS_DIR, 'remedial.js'), 'utf8');
        const html = fs.readFileSync(path.join(JS_DIR, '..', 'index.html'), 'utf8');
        assert.ok(remedial.includes(`new CustomEvent('${STUDENT_TAB_EVENT}', { detail: { anchor: 'remedial' } })`));
        assert.equal(html.split(`new CustomEvent('${STUDENT_TAB_EVENT}'`).length - 1, 2, 'routeFromHash 與 showSection 各發一次');
    });
});
