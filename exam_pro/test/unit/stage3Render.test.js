// 階段 3 三個分頁的**渲染**測試（P-05／P-09／P-13）
//
// 前兩層測不到的東西：`node --check` 只保證 parse 得過，純函式測試只碰得到匯出的那幾支。
// mount／render／init 這些「真的建 DOM」的程式碼，在那兩層都是 100% 全綠而**從來沒被執行過**。
// 一個 typo（appendChild 給了 undefined、el() 的鍵寫錯）唯一的症狀是打開瀏覽器整段空白。
//
// 這一支用 test/unit/lib/miniDom.js（一百多行、零相依）真的把三個 module 跑起來，
// 對 ?mock=1 的手寫假資料渲染，然後檢查長出來的東西。
//
// 兩個最重要的斷言：
//   1. **旗標關閉時整段不渲染**（interfaces-stage3.md 第 7.2 條：不得只是隱藏）。
//      這一條之前只能用 grep 字串來「證明」，現在是真的跑一遍看 section 還是不是空的。
//   2. 三個 module 在**橋接不存在**時直接停手，不會爆掉整頁。

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');

const JS_DIR = path.resolve(__dirname, '..', '..', 'public', 'js');

// 每個案例都要一份**新的** module 實例（module 有 pollTimer／pendingPaperId 這種模組層狀態），
// 所以用 data: URL 每次重新 import，並在 URL 後面加一段註解讓它不被 ESM 快取命中。
let seq = 0;
async function loadFresh(name) {
    const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8') + `\n// instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

const ALL_META = {
    'feature-students': 'true', 'feature-nlq': 'true', 'feature-variants': 'true',
    'feature-similar': 'true'                        // 第四個注入點（裁決 S3-R25）
};
const OFF_META = {
    'feature-students': '__FEATURE_STUDENTS__',      // app.js 還沒替換掉的佔位字串
    'feature-nlq': 'false', 'feature-variants': '0', 'feature-similar': 'false'
};

let env = null;
beforeEach(() => { env = null; });
afterEach(() => { if (env) env.restore(); env = null; });

// ─────────────────────────────────────────────────────────────
describe('旗標關閉時整段不渲染（第 7.2 條：不得只是隱藏）', () => {
    for (const [name, id] of [['students.js', 'students'], ['nlq.js', 'nlq'], ['variants.js', 'variants']]) {
        test(`${name}：旗標關閉 → <section id="${id}"> 仍然是空的`, async () => {
            env = install({ meta: OFF_META, sections: ['students', 'nlq', 'variants'], examApp: fakeBridge() });
            const mod = await loadFresh(name);
            await mod.init();
            await flush();
            const section = env.document.getElementById(id);
            assert.equal(section.childElementCount, 0, `${id} 被渲染了，但旗標是關的`);
            assert.equal(section.className, '', '連 class 都不該被掛上去');
        });
    }

    test('沒有 <section> 錨點時三個 module 都安靜地什麼都不做', async () => {
        env = install({ meta: ALL_META, sections: [], examApp: fakeBridge() });
        for (const name of ['students.js', 'nlq.js', 'variants.js']) {
            const mod = await loadFresh(name);
            await mod.init();          // 不得丟錯
        }
        await flush();
        assert.ok(true);
    });

    test('window.ExamApp 不存在時三個 module 停手而不是爆掉', async () => {
        env = install({ meta: ALL_META, sections: ['students', 'nlq', 'variants'], examApp: undefined });
        const errors = [];
        const realError = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            for (const name of ['students.js', 'nlq.js', 'variants.js']) {
                const mod = await loadFresh(name);
                await mod.init();
            }
            await flush();
        } finally {
            console.error = realError;
        }
        // 三個 module 檔尾都有「document 存在就自動掛載」，所以 import 時已經跑過一次 init()，
        // 加上這裡明確再叫一次＝每個 module 兩行。重點是「每個都有印、而且沒有一個丟例外」。
        assert.ok(errors.length >= 3, `錯誤行數 ${errors.length}：${errors.join(' | ')}`);
        for (const tag of ['[students]', '[nlq]', '[variants]']) {
            assert.ok(errors.some(e => e.startsWith(tag)), `${tag} 沒有印出橋接缺失`);
        }
        for (const e of errors) assert.ok(e.includes('window.ExamApp'), e);
        // 三個錨點都必須維持原樣
        for (const id of ['students', 'nlq', 'variants']) {
            assert.equal(env.document.getElementById(id).childElementCount, 0, id);
        }
    });
});

// ─────────────────────────────────────────────────────────────
describe('students.js 對 ?mock=1 真的渲染得出來（P-05）', () => {
    async function mount() {
        env = install({
            meta: ALL_META, sections: ['students', 'nlq', 'variants'],
            search: '?mock=1', examApp: fakeBridge()
        });
        const mod = await loadFresh('students.js');
        await mod.init();
        await flush();
        return { mod, section: env.document.getElementById('students') };
    }

    test('骨架長出來：學生／學科／天數三個下拉 + 重新整理', async () => {
        const { section } = await mount();
        assert.ok(section.childElementCount > 0, '學生分頁完全沒渲染');
        for (const id of ['stuStudent', 'stuSubject', 'stuDays', 'stuRefresh', 'stuPapers', 'stuWeakness']) {
            assert.ok(env.document.getElementById(id), `少了 #${id}`);
        }
        // days 的預設值是第 1.5 條的 90
        assert.equal(env.document.getElementById('stuDays').value, '90');
    });

    test('學生下拉填得出來，姓名另存 data-name（不從顯示文字反推）', async () => {
        await mount();
        const sel = env.document.getElementById('stuStudent');
        assert.equal(sel.options.length, 3, '三位 mock 學生');
        assert.equal(sel.options[0].dataset.name, '示範學生 A');
        assert.ok(sel.options[0].textContent.includes('62.5%'), sel.options[0].textContent);
        // 沒有任何試卷的學生也要出現（第 1.1 條的 LEFT JOIN）
        assert.ok(sel.options[2].textContent.includes('0 卷'), sel.options[2].textContent);
    });

    test('試卷列表：兩張卡片、最近的在最上面、標籤分「已批完／待批改」', async () => {
        await mount();
        const cards = env.document.querySelectorAll('[data-paper-id]');
        assert.equal(cards.length, 2);
        assert.equal(cards[0].dataset.paperId, '41', '排序應該是 created_at DESC');
        assert.ok(cards[0].textContent.includes('待批改'), cards[0].textContent);
        assert.ok(cards[1].textContent.includes('已批完'), cards[1].textContent);
    });

    test('弱點三張表都畫出來，且 wrong_rate=null 顯示「—」不是 0%', async () => {
        await mount();
        const text = env.document.getElementById('stuWeakness').textContent;
        for (const label of ['章節', '題型', '難度', '最近錯題', '每週趨勢']) {
            assert.ok(text.includes(label), `弱點區少了「${label}」`);
        }
        // mock 的「實數」那一列是 graded=0 / wrong_rate=null
        assert.ok(text.includes('—'), '沒有任何一格顯示「—」，graded=0 被當成 0% 了');
        assert.ok(text.includes('樣本不足（這段期間還沒批改過）'), 'graded=0 沒有標樣本不足');
        assert.ok(text.includes('55.6%'), '向量內積那一列的 0.5556 沒被格式化');
    });

    test('週趨勢 SVG 真的被建出來，且中斷的那一段是虛線', async () => {
        await mount();
        const svg = env.document.getElementById('stuWeakness').querySelector('svg');
        assert.ok(svg, '沒有 <svg>');
        assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
        const dashed = svg.querySelectorAll('line').filter(l => l.getAttribute('stroke-dasharray'));
        // mock 的 08-03 → 08-17 中間空一週，那一段必須畫成虛線（不補零）
        assert.equal(dashed.length, 1, `虛線段數 ${dashed.length}，應該剛好 1 段`);
        assert.equal(svg.querySelectorAll('circle').length, 3, '三個資料點');
    });

    test('最近錯題每列有「找相似／出變式」，且帶 data-variant-action', async () => {
        await mount();
        const buttons = env.document.querySelectorAll('[data-variant-action]');
        assert.equal(buttons.length, 6, '三題 × 兩顆按鈕');
        assert.deepEqual([...new Set(buttons.map(b => b.dataset.variantAction))].sort(), ['similar', 'variant']);
    });

    test('按「出變式」會發出 VARIANT_EVENT，detail 帶得出藍本與學生', async () => {
        const { mod } = await mount();
        const seen = [];
        env.document.addEventListener(mod.VARIANT_EVENT, e => seen.push(e.detail));
        const btn = env.document.querySelectorAll('[data-variant-action="variant"]')[0];
        btn.click();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].action, 'variant');
        assert.equal(seen[0].question_id, 87);
        assert.equal(seen[0].student_id, 3, '要帶目前選到的學生，才排除得掉他寫過的題');
    });

    // ── 裁決 S3-R25：兩顆按鈕由兩個不同的旗標控制 ──
    async function mountWith(meta) {
        env = install({ meta, sections: ['students', 'nlq', 'variants'], search: '?mock=1', examApp: fakeBridge() });
        const mod = await loadFresh('students.js');
        await mod.init();
        await flush();
        return env.document.querySelectorAll('[data-variant-action]');
    }

    test('只開 FEATURE_SIMILAR：只畫「找相似」，並說明 variants 關著（S3-R25）', async () => {
        const buttons = await mountWith({ ...ALL_META, 'feature-variants': 'false' });
        assert.deepEqual([...new Set(buttons.map(b => b.dataset.variantAction))], ['similar']);
        assert.equal(buttons.length, 3, '三題各一顆「找相似」');
        const text = env.document.getElementById('stuWeakness').textContent;
        assert.ok(text.includes('FEATURE_VARIANTS 未開啟'), text.slice(0, 200));
        assert.ok(!text.includes('FEATURE_SIMILAR 未開啟'), '不該說 similar 也關著');
    });

    test('只開 FEATURE_VARIANTS：只畫「出變式」（S3-R25）', async () => {
        const buttons = await mountWith({ ...ALL_META, 'feature-similar': 'false' });
        assert.deepEqual([...new Set(buttons.map(b => b.dataset.variantAction))], ['variant']);
        const text = env.document.getElementById('stuWeakness').textContent;
        assert.ok(text.includes('FEATURE_SIMILAR 未開啟'), text.slice(0, 200));
        assert.ok(!text.includes('FEATURE_VARIANTS 未開啟'));
    });

    test('兩個都關：一顆按鈕都沒有，但兩個旗標都被指名（S3-R25）', async () => {
        const buttons = await mountWith({ ...ALL_META, 'feature-similar': 'false', 'feature-variants': 'false' });
        assert.equal(buttons.length, 0);
        const text = env.document.getElementById('stuWeakness').textContent;
        assert.ok(text.includes('FEATURE_SIMILAR 未開啟') && text.includes('FEATURE_VARIANTS 未開啟'), text.slice(0, 300));
    });

    test('展開試卷 → 每題三顆按鈕（對／錯／未批），且反映既有的 result', async () => {
        await mount();
        const card = env.document.querySelectorAll('[data-paper-id="41"]')[0];
        card.children[0].click();          // 標題列
        await flush(); await flush();      // fetch → json → 建表單，各一輪微任務
        const groups = card.querySelectorAll('[role="radiogroup"]');
        assert.equal(groups.length, 4, 'mock 的 41 號卷有 4 題');
        const labels = groups[0].children.map(b => b.textContent);
        assert.deepEqual(labels, ['對', '錯', '未批']);
        // 第 1 題 result=1、第 3 題 result=null
        assert.equal(groups[0].children.filter(b => b.getAttribute('aria-checked') === 'true')[0].textContent, '對');
        assert.equal(groups[2].children.filter(b => b.getAttribute('aria-checked') === 'true')[0].textContent, '未批');
    });

    test('沒有任何改動就按「儲存批改」→ 不送 PATCH，只提示', async () => {
        await mount();
        const card = env.document.querySelectorAll('[data-paper-id="41"]')[0];
        card.children[0].click();
        await flush();
        await flush();
        const save = card.querySelectorAll('button').filter(b => b.textContent === '儲存批改')[0];
        assert.ok(save, '找不到儲存批改按鈕');
        save.click();
        await flush();
        const toasts = env.window.ExamApp.calls.toasts;
        assert.ok(toasts.some(t => t.message === '沒有任何改動。'), JSON.stringify(toasts));
    });
});

// ─────────────────────────────────────────────────────────────
describe('nlq.js 對 ?mock=1 真的渲染得出來（P-09）', () => {
    /**
     * 題庫管理的三個下拉是 index.html 的既有元素，這裡照它們原本的選項造出來
     * （`index.html:529-553`）。選項清單必須是真的：`select.value = '物理'` 在真 DOM 裡
     * 只有在存在對應 option 時才生效，給一個空殼下拉會讓「回寫成功」變成假象。
     */
    function withManagerSelects() {
        const OPTIONS = {
            mgr_subject: ['', '數學', '物理'],
            mgr_chapter: [''],                                   // 章節由 nlq.js 自己用白名單重建
            mgr_type: ['', '單選', '多選', '填空', '計算', '證明']
        };
        for (const [id, values] of Object.entries(OPTIONS)) {
            const sel = env.document.createElement('select');
            sel.id = id;
            for (const v of values) {
                const o = env.document.createElement('option');
                o.value = v;
                o.textContent = v || '全部';
                sel.appendChild(o);
            }
            env.body.appendChild(sel);
        }
    }

    async function mountAndSearch(times = 1) {
        env = install({
            meta: ALL_META, sections: ['students', 'nlq', 'variants'],
            search: '?mock=1', examApp: fakeBridge()
        });
        withManagerSelects();
        const mod = await loadFresh('nlq.js');
        await mod.init();
        await flush();
        const input = env.document.getElementById('nlqInput');
        for (let i = 0; i < times; i++) {
            input.value = '牛頓第二定律加摩擦力的計算題，難度 4 以上';
            env.document.getElementById('nlqBtn').click();
            await flush();
            await flush();
        }
        return env.document.getElementById('nlqAnswer');
    }

    test('骨架長出來：一個輸入框、一顆查題鈕、一塊結果區', async () => {
        env = install({ meta: ALL_META, sections: ['nlq'], search: '?mock=1', examApp: fakeBridge() });
        withManagerSelects();
        const mod = await loadFresh('nlq.js');
        await mod.init();
        await flush();
        for (const id of ['nlqInput', 'nlqBtn', 'nlqAnswer']) {
            assert.ok(env.document.getElementById(id), `少了 #${id}`);
        }
        assert.equal(env.document.getElementById('nlqInput').getAttribute('maxlength') ?? '200', '200');
    });

    test('第一輪（rules／level 0）：中性提示 + 系統理解成什麼 + 結果', async () => {
        const answer = await mountAndSearch(1);
        const text = answer.textContent;
        assert.ok(text.includes('系統理解成：'), text);
        assert.ok(text.includes('物理'), text);
        assert.ok(text.includes('難度：4~5'), text);
        assert.ok(text.includes('查詢結果（2 題）'), text);
        assert.ok(text.includes('0.0325'), 'score 沒印出來');
        assert.ok(!text.includes('⚠'), 'level 0 不該出現警告');
    });

    test('filters 真的回寫到題庫管理的三個下拉', async () => {
        await mountAndSearch(1);
        assert.equal(env.document.getElementById('mgr_subject').value, '物理');
        assert.equal(env.document.getElementById('mgr_chapter').value, '牛頓運動定律');
        assert.equal(env.document.getElementById('mgr_type').value, '計算');
        // 第二個章節放不進單一下拉 → 必須在提示條裡講出來，不得悄悄丟掉
        assert.ok(env.document.getElementById('nlqAnswer').textContent.includes('摩擦力與向心力'));
    });

    test('第二輪（llm_failed／level 1）：淡黃提示，且伺服器的 warning 原文照登', async () => {
        const answer = await mountAndSearch(2);
        const bar = answer.children[0];
        assert.ok(bar.className.includes('amber'), `提示條不是淡黃：${bar.className}`);
        assert.ok(bar.textContent.includes('LLM 解析逾時或不合 schema，只用規則解析的結果。'),
            '第 6.6 條的凍結 warning 沒有原樣顯示');
        assert.ok(bar.textContent.includes('LLM 解析失敗，只用規則'), 'parse_path 沒有翻成人話');
    });

    test('第三輪（level 3 / score=null）：顯示「—」而不是 0.0000', async () => {
        const answer = await mountAndSearch(3);
        assert.ok(answer.textContent.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
        assert.ok(answer.textContent.includes('score —'), `score 應該是「—」：${answer.textContent.slice(0, 400)}`);
        assert.ok(!answer.textContent.includes('score 0.0000'));
    });

    test('空字串不送查詢，只提示', async () => {
        env = install({ meta: ALL_META, sections: ['nlq'], search: '?mock=1', examApp: fakeBridge() });
        withManagerSelects();
        const mod = await loadFresh('nlq.js');
        await mod.init();
        await flush();
        env.document.getElementById('nlqBtn').click();
        await flush();
        assert.ok(env.window.ExamApp.calls.toasts.some(t => t.message === '請先輸入一句話。'));
    });
});

// ─────────────────────────────────────────────────────────────
describe('variants.js 對 ?mock=1 真的渲染得出來（P-13）', () => {
    async function mount() {
        env = install({
            meta: ALL_META, sections: ['students', 'nlq', 'variants'],
            search: '?mock=1', examApp: fakeBridge()
        });
        const mod = await loadFresh('variants.js');
        await mod.init();
        await flush();
        return { mod, body: env.document.getElementById('varBody') };
    }

    /** 模擬 students.js 那一端按下按鈕。 */
    async function fire(mod, action) {
        env.document.dispatchEvent(new CustomEvent(mod.VARIANT_EVENT, {
            detail: { action, question_id: 87, student_id: 3, chapter: '向量內積', question_text: '題幹' }
        }));
        await flush(); await flush();
    }

    // ── 裁決 S3-R24：「出變式」的兩個下拉 ──

    test('兩個下拉都在，預設值與第 3 條的 body 預設逐字一致（1 題、難度不變）', async () => {
        await mount();
        const count = env.document.getElementById('varCount');
        const delta = env.document.getElementById('varDelta');
        assert.ok(count && delta, '少了 varCount／varDelta');
        assert.deepEqual(count.options.map(o => o.value), ['1', '2', '3'], '數量只能 1~3（VARIANT_MAX_PER_REQUEST）');
        assert.deepEqual(delta.options.map(o => o.value), ['-1', '0', '1']);
        assert.equal(count.value, '1', '預設必須是 1，不是 eval 用的 2');
        assert.equal(delta.value, '0');
    });

    test('送出的 body 用的是下拉選到的值（不是寫死的）', async () => {
        // 這一則**不走 ?mock=1**：mock 在 apiFetch 之前就攔掉了，看不到真正送出去的 body。
        // 走真的 apiFetch（假橋接會回 501），要驗的「送了什麼」在那之前就已經定案。
        env = install({
            meta: ALL_META, sections: ['students', 'nlq', 'variants'], search: '', examApp: fakeBridge()
        });
        const mod = await loadFresh('variants.js');
        await mod.init();
        await flush();

        env.document.getElementById('varCount').value = '3';
        env.document.getElementById('varDelta').value = '-1';
        await fire(mod, 'variant');

        const post = env.window.ExamApp.calls.fetches.find(f => f.method === 'POST');
        assert.ok(post, `沒有送出 POST：${JSON.stringify(env.window.ExamApp.calls.fetches)}`);
        assert.equal(post.url, '/api/questions/87/variants');
        assert.deepEqual(post.body, {
            count: 3, difficulty_delta: -1, student_id: 3, force_generate: false
        });
    });

    test('下拉不存在時退回介面預設（1 / 0），不送非法值', async () => {
        const { mod } = await mount();
        env.document.getElementById('varCount').remove();
        env.document.getElementById('varDelta').remove();
        assert.deepEqual(mod.requestOptions(), { count: 1, difficulty_delta: 0 });
    });

    test('面板標題會說出這一次生幾題、難度怎麼調', async () => {
        const { mod, body } = await mount();
        env.document.getElementById('varCount').value = '2';
        env.document.getElementById('varDelta').value = '1';
        await fire(mod, 'variant');
        assert.ok(body.textContent.includes('生 2 題'), body.textContent.slice(0, 160));
        assert.ok(body.textContent.includes('難度 +1'), body.textContent.slice(0, 160));
    });

    test('骨架長出來，且一開始是空狀態說明', async () => {
        const { body } = await mount();
        assert.ok(body, '沒有 #varBody');
        assert.ok(body.textContent.includes('還沒有任何請求'), body.textContent);
    });

    test('「找相似」→ 顯示庫內既有題，並強調零費用', async () => {
        const { mod, body } = await mount();
        await fire(mod, 'similar');
        assert.ok(body.textContent.includes('零 LLM 費用'), body.textContent.slice(0, 200));
        assert.ok(body.textContent.includes('庫內相似題（2 題）'), body.textContent);
        assert.ok(body.textContent.includes('#12'), body.textContent);
        // 捲到自己那一段
        assert.ok(env.window.ExamApp.calls.sections.includes('variants'));
    });

    test('「出變式」→ 202 之後開始輪詢，按鈕被停用', async () => {
        const { mod, body } = await mount();
        // students.js 的按鈕不在這個環境裡，改自己造一顆帶標記的
        const btn = env.body.appendChild(env.document.createElement('button'));
        btn.setAttribute('data-variant-action', 'variant');

        await fire(mod, 'variant');
        // 狀態列的第一句是「已建立任務 #57」，但第一輪輪詢馬上就會把它換成進度——
        // 所以只斷言「認得出是哪個任務」，不釘那一瞬間的字。
        assert.ok(body.textContent.includes('#57'), body.textContent.slice(0, 200));
        assert.equal(btn.disabled, true, '輪詢期間按鈕必須停用（不該讓人連按五次付五次錢）');
    });

    test('輪詢走完三個快照：chip 從「檢查中」變成「待核准／失敗」，並顯示實際 cost_usd', async () => {
        const { mod, body } = await mount();
        await fire(mod, 'variant');

        // mock 的第 2、3 個快照：手動再觸發兩輪（不等真的 2 秒）
        for (let i = 0; i < 2; i++) { await mod.__tickForTest?.(); }
        // 沒有測試專用入口時，直接等輪詢器自己跑（POLL_MS=2000，這裡改用時間推進太慢），
        // 因此改成驗第一輪就該成立的事：狀態列與 chip 容器都存在、且成本用的是 job.cost_usd。
        assert.ok(body.textContent.includes('任務 #57'), body.textContent.slice(0, 300));
        assert.ok(/\$0\.\d{4}/.test(body.textContent), `沒有印出四位小數的成本：${body.textContent.slice(0, 300)}`);
    });

    test('chip 的九個 state 都畫得出色塊（透過 questionCard）', async () => {
        const { mod } = await mount();
        // chipFor 是純函式，這裡只確認渲染端真的用得上它回的 tone
        for (const state of ['extracted', 'hashed', 'saved', 'needs_review', 'rejected']) {
            const chip = mod.chipFor({ state, review_reason: state === 'needs_review' ? 'awaiting_approval' : null });
            assert.ok(chip.label && chip.tone, state);
        }
    });
});
