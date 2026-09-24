// ─────────────────────────────────────────────────────────────
// kcUi.test.js — public/js/kc.js（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 4 點、第 1.5 條）
//
// 三層，與 stage3Ui／stage3Render 同一套做法：
//   1. 純函式：前端欄位檢查與伺服器端同規則、diff 只送改過的欄位、朗讀前的符號轉換、
//      冊／章篩選與分組、PUT body 的組法。
//   2. 檔案層級契約：旗標從 <meta name="feature-kc"> 讀、parseBool 與後端逐字相同、
//      「整段不渲染」、innerHTML 只拿來清空（伺服器文字一律 textContent）、科目不寫死。
//   3. miniDom 真的把它跑起來：旗標關閉不渲染；開啟時卡片、先備、已標題數、就地編輯、
//      審定、朗讀（有／沒有 speechSynthesis）、題目 → 知識點小工具。
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush } = require('./lib/miniDom');

const JS = path.resolve(__dirname, '..', '..', 'public', 'js', 'kc.js');
const SRC = fs.readFileSync(JS, 'utf8');

let seq = 0;
async function loadFresh() {
    const src = SRC + `\n// instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

const SPOKEN = '有坐標就不用管角度：x 跟 x 乘、y 跟 y 乘，全部加起來。三維就多加一個 z 乘 z。記得算出來是一個數字，不是向量。';

// ─────────────────────────────────────────────────────────────
describe('純函式', () => {
    test('parseBool 與後端 config/features.js 逐字相同', async () => {
        const mod = await loadFresh();
        const { parseBool } = require('../../config/features');
        for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', '', null, undefined, '__FEATURE_KC__', 'yes']) {
            assert.equal(mod.parseBool(v), parseBool(v), String(v));
        }
    });

    test('LIMITS 與 utils/kcSeed.js 的 LIMITS 相同（前後端同一份第 3.4 條）', async () => {
        const mod = await loadFresh();
        const { LIMITS } = require('../../utils/kcSeed');
        for (const k of Object.keys(mod.LIMITS)) assert.equal(mod.LIMITS[k], LIMITS[k], k);
        assert.equal(mod.MAX_QUESTION_KCS, require('../../services/kcService').MAX_QUESTION_KCS);
    });

    test('validateKcPatch 與伺服器端 validateKcPatch 對同一組樣本判定一致', async () => {
        const mod = await loadFresh();
        const server = require('../../services/kcService');
        const samples = [
            { name: '內積' }, { name: '' }, { name: 'x'.repeat(31) },
            { description: '說明' }, { description: 'x'.repeat(201) },
            { spoken_text: SPOKEN }, { spoken_text: '太短' }, { spoken_text: `${SPOKEN}$x$` }, { spoken_text: `${SPOKEN}\\cdot` },
            { curriculum_code: null }, { curriculum_code: 'N-10-3' }, { curriculum_code: 'x'.repeat(41) },
            { status: 'approved' }, { status: 'published' }
        ];
        for (const s of samples) {
            assert.equal(mod.validateKcPatch(s) === null, !server.validateKcPatch(s).error, JSON.stringify(s).slice(0, 60));
        }
    });

    test('diffKc：只留改過的欄位，trim 後比較，課綱代碼清空＝null', async () => {
        const { diffKc } = await loadFresh();
        const orig = { name: '正射影', description: '說明', spoken_text: SPOKEN, curriculum_code: null };
        assert.deepEqual(diffKc(orig, { name: ' 正射影 ', description: '說明', spoken_text: SPOKEN, curriculum_code: '' }), {});
        assert.deepEqual(diffKc(orig, { name: '正射影（向量）', description: '說明', spoken_text: SPOKEN, curriculum_code: 'N-11A-2' }),
            { name: '正射影（向量）', curriculum_code: 'N-11A-2' });
        assert.deepEqual(diffKc({ ...orig, curriculum_code: 'N-11A-2' }, { curriculum_code: '  ' }), { curriculum_code: null });
    });

    test('speechText：上下標、根號、希臘字母、不等號轉成唸得出來的字；其他文字不動', async () => {
        const { speechText } = await loadFresh();
        assert.equal(speechText('x²＋y³'), 'x平方＋y立方');
        assert.equal(speechText('H₂O 與 CO₂'), 'H2O 與 CO2');
        assert.equal(speechText('√2、cosθ、2π'), '根號2、cos西塔、2派');
        assert.equal(speechText('a ≤ b ≥ c ≠ d ≈ e'), 'a 小於等於 b 大於等於 c 不等於 d 約等於 e');
        assert.equal(speechText(SPOKEN), SPOKEN);
        assert.equal(speechText(null), '');
    });

    test('volumesFor：/api/chapter-volumes 沒有這一科時退回「全部章節」（化學併入白名單前）', async () => {
        const { volumesFor } = await loadFresh();
        const vols = { '數學': [{ name: '第三冊(A/B)', chapters: ['向量的加減與係數積', '向量內積'] }] };
        assert.deepEqual(volumesFor('數學', vols, []), vols['數學']);
        assert.deepEqual(volumesFor('化學', vols, [{ chapter: '化學計量' }, { chapter: '化學計量' }, { chapter: '酸鹼反應' }]),
            [{ name: '全部章節', chapters: ['化學計量', '酸鹼反應'] }]);
    });

    test('filterItems／groupByChapter／summarize', async () => {
        const { filterItems, groupByChapter, summarize } = await loadFresh();
        const items = [
            { id: 1, chapter: 'A', status: 'draft', question_count: 2 },
            { id: 2, chapter: 'A', status: 'approved', question_count: 0 },
            { id: 3, chapter: 'B', status: 'approved', question_count: 5 }
        ];
        assert.deepEqual(filterItems(items, { status: 'approved' }).map(i => i.id), [2, 3]);
        assert.deepEqual(filterItems(items, { chapters: ['B'] }).map(i => i.id), [3]);
        assert.deepEqual(filterItems(items, { chapter: 'A', status: 'draft' }).map(i => i.id), [1]);
        assert.deepEqual(groupByChapter(items).map(g => [g.chapter, g.items.length]), [['A', 2], ['B', 1]]);
        assert.deepEqual(summarize(items), { total: 3, approved: 2, tagged: 7 });
    });

    test('parseQuestionId 與伺服器端 parseId 同規則', async () => {
        const { parseQuestionId } = await loadFresh();
        const { parseId } = require('../../services/kcService');
        for (const v of ['5', ' 5', '05', '0', '-2', '1.5', 'abc', '', '12']) {
            assert.equal(parseQuestionId(v), parseId(v), `「${v}」`);
        }
    });

    test('buildPutBody：已有標註沿用原本的 weight（1 就省略），新勾的不送 weight', async () => {
        const { buildPutBody } = await loadFresh();
        assert.deepEqual(buildPutBody([3, 5, 5, 9], [{ kc_id: 3, weight: 0.5 }, { kc_id: 5, weight: 1 }]),
            { items: [{ kc_id: 3, weight: 0.5 }, { kc_id: 5 }, { kc_id: 9 }] });
        assert.deepEqual(buildPutBody([], []), { items: [] });
    });

    test('canSpeak：要有 speechSynthesis.speak 與 SpeechSynthesisUtterance 才算支援', async () => {
        const { canSpeak } = await loadFresh();
        assert.equal(canSpeak({}), false);
        assert.equal(canSpeak(null), false);
        assert.equal(canSpeak({ speechSynthesis: { speak() { } } }), false);
        assert.equal(canSpeak({ speechSynthesis: { speak() { } }, SpeechSynthesisUtterance: function () { } }), true);
    });

    test('prereqLabel：跨科的先備前面標科目', async () => {
        const { prereqLabel } = await loadFresh();
        assert.equal(prereqLabel({ subject: '物理' }, { subject: '數學', chapter: '向量內積', name: '內積的意義' }), '［數學］向量內積：內積的意義');
        assert.equal(prereqLabel({ subject: '數學' }, { subject: '數學', chapter: '向量內積', name: '內積的意義' }), '向量內積：內積的意義');
    });
});

// ─────────────────────────────────────────────────────────────
describe('檔案層級契約（第 1.5 條）', () => {
    test('旗標從 <meta name="feature-kc"> 讀，parseBool 規則逐字相同，沒有寫死', () => {
        assert.ok(SRC.includes('meta[name="feature-kc"]'));
        assert.ok(SRC.includes("v === '1' || v === 'true'"));
        assert.ok(!/FEATURE_KC\s*=\s*true/i.test(SRC));
        assert.ok(SRC.includes('整段不渲染'));
    });

    test('innerHTML 只拿來清空；伺服器文字一律 textContent', () => {
        const assigns = SRC.match(/innerHTML\s*=\s*[^;]+;/g) || [];
        assert.ok(assigns.length > 0);
        for (const a of assigns) assert.match(a, /innerHTML\s*=\s*'';/, a);
        assert.ok(!/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(SRC));
    });

    test('科目清單不寫死：讀 /api/chapter-volumes', () => {
        assert.ok(SRC.includes("'/api/chapter-volumes'"));
        assert.ok(!/\[\s*'數學'\s*,\s*'物理'/.test(SRC), '科目清單被寫死了');
    });

    test('index.html：#kc 路由到 view-kc（〔stage5 WS-C〕最小掛鉤），module 與錨點都在', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.ok(html.includes("VIEW_FOR_ANCHOR.kc = 'view-kc';"));
        assert.ok(html.includes("TOP_ANCHORS.push('kc');"));
        assert.ok(html.includes('〔stage5 WS-C〕'));
        assert.ok(html.includes('<section id="kc"></section>'));
        assert.ok(html.includes('<script type="module" src="/js/kc.js"></script>'));
        assert.ok(html.includes('<meta name="feature-kc" content="__FEATURE_KC__">'));
    });
});

// ─────────────────────────────────────────────────────────────
// miniDom 渲染
// ─────────────────────────────────────────────────────────────

const VOLUMES = {
    '數學': [{ name: '第三冊(A/B)', chapters: ['向量的加減與係數積', '向量內積'] }, { name: '第一冊', chapters: ['實數'] }],
    '物理': [{ name: '選修物理二', chapters: ['功與動能'] }]
};

function kcItem(id, code, name, status, extra = {}) {
    const [, chapter, nn] = code.split('.');
    const subject = code.startsWith('MATH') ? '數學' : '物理';
    return {
        id, code, subject, chapter, name, curriculum_code: null, description: `${name}的說明`,
        spoken_text: SPOKEN, status, sort: Number(nn), prereqs: [], question_count: 0, ...extra
    };
}

const MATH_ITEMS = [
    kcItem(7, 'MATH.向量的加減與係數積.01', '向量的加法與減法', 'draft'),
    kcItem(1, 'MATH.向量內積.01', '內積的意義', 'draft', {
        prereqs: [{ id: 7, code: 'MATH.向量的加減與係數積.01', name: '向量的加法與減法', subject: '數學', chapter: '向量的加減與係數積' }],
        question_count: 3
    }),
    kcItem(2, 'MATH.向量內積.02', '內積的坐標算法', 'approved', { question_count: 1 }),
    kcItem(4, 'MATH.向量內積.04', '<img src=x onerror=alert(1)>', 'approved')
];
const PHYS_ITEMS = [
    kcItem(20, 'PHYS.功與動能.01', '功的定義', 'draft', {
        prereqs: [{ id: 1, code: 'MATH.向量內積.01', name: '內積的意義', subject: '數學', chapter: '向量內積' }]
    })
];

/** 依 method + 網址 regex 回應的假 apiFetch；每次都回新的 Response（body 只能讀一次） */
function kcBridge(overrides = {}) {
    const routes = [
        ['GET', /^\/api\/chapter-volumes$/, () => [200, VOLUMES]],
        ['GET', /^\/api\/kc\?subject=/, (url) => {
            const s = decodeURIComponent(url.split('subject=')[1]);
            return [200, { items: s === '數學' ? MATH_ITEMS : s === '物理' ? PHYS_ITEMS : [] }];
        }],
        ['PATCH', /^\/api\/kc\/(\d+)$/, (url, body) => {
            const id = Number(url.split('/').pop());
            const cur = [...MATH_ITEMS, ...PHYS_ITEMS].find(i => i.id === id);
            return [200, { ...cur, ...body }];
        }],
        ['GET', /^\/api\/questions\/5\/kcs\?detail=1$/, () => [200, {
            question: { id: 5, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '求 $\\vec a\\cdot\\vec b$。', archived: false },
            items: [{ kc_id: 2, code: 'MATH.向量內積.02', name: '內積的坐標算法', weight: 1, src: 'ai', confidence: 0.82 }]
        }]],
        ['GET', /^\/api\/questions\/404\/kcs\?detail=1$/, () => [404, { message: '找不到該題目。' }]],
        ['PUT', /^\/api\/questions\/5\/kcs$/, (url, body) => [200, body.items.map(i => ({
            kc_id: i.kc_id, code: 'x', name: `知識點${i.kc_id}`, weight: i.weight ?? 1, src: 'human', confidence: null
        }))]]
    ];
    const b = fakeBridge({
        apiFetch(url, options = {}) {
            const method = options.method || 'GET';
            const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
            b.calls.fetches.push({ url, method, body });
            for (const [m, re, handler] of [...(overrides.routes || []), ...routes]) {
                if (m === method && re.test(url)) {
                    const [status, payload] = handler(url, body);
                    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
                }
            }
            return Promise.resolve(new Response(JSON.stringify({ message: `沒有這條假路由：${method} ${url}` }), { status: 404 }));
        }
    });
    return b;
}

let env = null;
beforeEach(() => { env = null; });
afterEach(() => {
    if (env) env.restore();
    env = null;
    delete globalThis.SpeechSynthesisUtterance;
});

async function mount(opts = {}) {
    const { meta = { 'feature-kc': 'true' }, speech = null } = opts;
    // 明確傳 bridge: undefined 代表「沒有橋接」，不能被預設值吃掉
    const bridge = 'bridge' in opts ? opts.bridge : kcBridge();
    env = install({ meta, sections: ['kc'], examApp: bridge });
    if (speech) {
        env.window.speechSynthesis = speech;
        env.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    }
    const mod = await loadFresh();
    await mod.init();
    await flush();
    return { mod, bridge, section: env.document.getElementById('kc') };
}

const cards = () => env.document.getElementById('kcList').querySelectorAll('article');
const card = (id) => env.document.querySelector(`[data-kc-id="${id}"]`);

describe('旗標與橋接', () => {
    test('旗標關閉（佔位字串／false）→ <section id="kc"> 維持空的，連 class 都不掛', async () => {
        for (const v of ['__FEATURE_KC__', 'false', '0']) {
            const { section } = await mount({ meta: { 'feature-kc': v } });
            assert.equal(section.childElementCount, 0, v);
            assert.equal(section.className, '');
            env.restore(); env = null;
        }
    });

    test('window.ExamApp 不存在 → 印一行 [kc] 錯誤並停手', async () => {
        const errors = [];
        const real = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            const { section } = await mount({ bridge: undefined });
            assert.equal(section.childElementCount, 0);
        } finally { console.error = real; }
        assert.ok(errors.some(e => e.startsWith('[kc]') && e.includes('window.ExamApp')));
    });
});

describe('瀏覽', () => {
    test('科目選單來自 /api/chapter-volumes；預設第一科；卡片依白名單章序分組', async () => {
        await mount();
        const subj = env.document.getElementById('kcSubject');
        assert.deepEqual(subj.options.map(o => o.value), ['數學', '物理']);
        assert.equal(cards().length, MATH_ITEMS.length);
        const chapters = env.document.getElementById('kcList').querySelectorAll('[data-chapter]').map(n => n.getAttribute('data-chapter'));
        assert.deepEqual(chapters, ['向量的加減與係數積', '向量內積']);
        assert.ok(env.document.getElementById('kcSummary').textContent.includes('共 4 個知識點，已審定 2 個'));
    });

    test('卡片：code、狀態、已標題數、先備都在；伺服器文字走 textContent／value', async () => {
        await mount();
        const c = card(1);
        assert.ok(c.textContent.includes('MATH.向量內積.01'));
        assert.equal(c.querySelector('[data-role="status"]').textContent, '草稿');
        assert.equal(c.querySelector('[data-role="count"]').textContent, '已標 3 題');
        assert.equal(c.querySelector('[data-role="prereq"]').textContent, '向量的加減與係數積：向量的加法與減法');
        assert.equal(c.querySelector('textarea[name="spoken_text"]').value, SPOKEN);
        // 名稱裡的 HTML 只是文字：在 input 的 value 裡原樣出現，沒有長出 <img>
        const evil = card(4);
        assert.equal(evil.querySelector('input[name="name"]').value, '<img src=x onerror=alert(1)>');
        assert.equal(evil.querySelectorAll('img').length, 0);
    });

    test('冊、章、狀態篩選', async () => {
        await mount();
        const status = env.document.getElementById('kcStatus');
        status.value = 'approved';
        status.dispatchEvent({ type: 'change' });
        assert.deepEqual(cards().map(c => c.getAttribute('data-kc-id')), ['2', '4']);
        status.value = '';
        status.dispatchEvent({ type: 'change' });
        const vol = env.document.getElementById('kcVolume');
        assert.deepEqual(vol.options.map(o => o.value), ['', '第三冊(A/B)', '第一冊']);
        vol.value = '第一冊';
        vol.dispatchEvent({ type: 'change' });
        assert.equal(cards().length, 0);
        assert.ok(env.document.getElementById('kcList').textContent.includes('沒有符合篩選條件'));
        vol.value = '第三冊(A/B)';
        vol.dispatchEvent({ type: 'change' });
        const ch = env.document.getElementById('kcChapter');
        assert.deepEqual(ch.options.map(o => o.value), ['', '向量的加減與係數積', '向量內積']);
        ch.value = '向量的加減與係數積';
        ch.dispatchEvent({ type: 'change' });
        assert.deepEqual(cards().map(c => c.getAttribute('data-kc-id')), ['7']);
    });

    test('換科：跨科的先備標出科目', async () => {
        await mount();
        const subj = env.document.getElementById('kcSubject');
        subj.value = '物理';
        subj.dispatchEvent({ type: 'change' });
        await flush();
        assert.equal(cards().length, 1);
        assert.equal(card(20).querySelector('[data-role="prereq"]').textContent, '［數學］向量內積：內積的意義');
    });
});

describe('就地編輯與審定', () => {
    test('沒改東西時「儲存修改」是停用的；改了名稱 → PATCH 只送 name；成功後重畫卡片', async () => {
        const { bridge } = await mount();
        const c = card(1);
        const save = c.querySelector('[data-role="save"]');
        assert.equal(save.disabled, true);
        const name = c.querySelector('input[name="name"]');
        name.value = '內積的定義';
        name.dispatchEvent({ type: 'input' });
        assert.equal(save.disabled, false);
        save.click();
        await flush();
        const patch = bridge.calls.fetches.filter(f => f.method === 'PATCH');
        assert.equal(patch.length, 1);
        assert.equal(patch[0].url, '/api/kc/1');
        assert.deepEqual(patch[0].body, { name: '內積的定義' });
        assert.equal(card(1).querySelector('input[name="name"]').value, '內積的定義');
        assert.ok(bridge.calls.toasts.some(t => t.type === 'success'));
    });

    test('「審定通過」送 status=approved（連同尚未儲存的修改）；已審定的卡片顯示「改回草稿」', async () => {
        const { bridge } = await mount();
        const c = card(1);
        const sp = c.querySelector('textarea[name="spoken_text"]');
        sp.value = `${SPOKEN}（老師改過）`;
        sp.dispatchEvent({ type: 'input' });
        const toggle = c.querySelector('[data-role="toggle"]');
        assert.equal(toggle.textContent, '審定通過');
        toggle.click();
        await flush();
        const patch = bridge.calls.fetches.find(f => f.method === 'PATCH');
        assert.deepEqual(patch.body, { spoken_text: `${SPOKEN}（老師改過）`, status: 'approved' });
        assert.equal(card(1).querySelector('[data-role="status"]').textContent, '已審定');
        assert.equal(card(1).querySelector('[data-role="toggle"]').textContent, '改回草稿');
        assert.equal(card(2).querySelector('[data-role="toggle"]').textContent, '改回草稿');
    });

    test('口語版有 LaTeX → 計數器標紅、按儲存不送出，卡片上顯示原因', async () => {
        const { bridge } = await mount();
        const c = card(1);
        const sp = c.querySelector('textarea[name="spoken_text"]');
        sp.value = `${SPOKEN}，也就是 $\\vec a\\cdot\\vec b$`;
        sp.dispatchEvent({ type: 'input' });
        assert.ok(c.querySelector('[data-role="spoken-counter"]').textContent.includes('LaTeX'));
        c.querySelector('[data-role="save"]').click();
        await flush();
        assert.equal(bridge.calls.fetches.filter(f => f.method === 'PATCH').length, 0);
        assert.ok(c.querySelector('[data-role="error"]').textContent.includes('LaTeX'));
    });

    test('伺服器回 400 → 原樣顯示 message，按鈕恢復可按', async () => {
        const bridge = kcBridge({ routes: [['PATCH', /^\/api\/kc\/1$/, () => [400, { message: '同一章已經有同名的知識點。' }]]] });
        await mount({ bridge });
        const c = card(1);
        const name = c.querySelector('input[name="name"]');
        name.value = '內積的坐標算法';
        name.dispatchEvent({ type: 'input' });
        c.querySelector('[data-role="save"]').click();
        await flush();
        assert.equal(c.querySelector('[data-role="error"]').textContent, '同一章已經有同名的知識點。');
        assert.equal(c.querySelector('[data-role="save"]').disabled, false);
    });
});

describe('朗讀（speechSynthesis，zh-TW）', () => {
    test('瀏覽器不支援 → 不畫「朗讀」按鈕', async () => {
        await mount();
        assert.equal(card(1).querySelector('[data-role="speak"]'), null);
    });

    test('支援 → 有按鈕；按下以 zh-TW 唸目前輸入框的口語版（經 speechText 轉換），再按一次停止', async () => {
        const spoken = [];
        let cancelled = 0;
        const speech = {
            speak(u) { spoken.push(u); }, cancel() { cancelled++; },
            getVoices() { return [{ lang: 'en-US', name: 'en' }, { lang: 'zh-TW', name: '美佳' }]; }
        };
        await mount({ speech });
        const c = card(1);
        const sp = c.querySelector('textarea[name="spoken_text"]');
        sp.value = '長度的平方是 x²＋y²，這句話要夠長才行，所以再多寫幾個字湊到四十個字以上。';
        const btn = c.querySelector('[data-role="speak"]');
        btn.click();
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].lang, 'zh-TW');
        assert.equal(spoken[0].voice.name, '美佳');
        assert.ok(spoken[0].text.includes('x平方＋y平方'));
        assert.equal(btn.textContent, '停止');
        btn.click();
        assert.equal(btn.textContent, '朗讀');
        assert.ok(cancelled >= 1);
    });
});

describe('題目 → 知識點', () => {
    async function openQuestion(id = '5') {
        const ctx = await mount();
        const qid = env.document.getElementById('kcQid');
        qid.value = id;
        env.document.getElementById('kcQLoad').click();
        await flush();
        await flush();
        return ctx;
    }

    test('載入題目：顯示題目資訊與目前標註；同章的知識點直接列出、目前的標註已勾', async () => {
        const { bridge } = await openQuestion();
        assert.ok(bridge.calls.fetches.some(f => f.url === '/api/questions/5/kcs?detail=1'));
        assert.ok(env.document.getElementById('kcQInfo').textContent.includes('#5｜數學｜向量內積'));
        assert.ok(env.document.getElementById('kcQCurrent').textContent.includes('內積的坐標算法（AI 0.82）'));
        const boxes = env.document.getElementById('kcQPicker').querySelectorAll('input');
        assert.equal(boxes.length, MATH_ITEMS.length);
        assert.deepEqual(boxes.filter(b => b.checked).map(b => b.dataset.kcId), ['2']);
        assert.equal(env.document.getElementById('kcQCount').textContent, '已選 1／5');
    });

    test('勾選後儲存 → PUT { items }（新勾的不送 weight），成功後顯示為人工標註', async () => {
        const { bridge } = await openQuestion();
        const boxes = env.document.getElementById('kcQPicker').querySelectorAll('input');
        const b1 = boxes.find(b => b.dataset.kcId === '1');
        b1.checked = true;
        b1.dispatchEvent({ type: 'change' });
        env.document.getElementById('kcQSave').click();
        await flush();
        await flush();
        const put = bridge.calls.fetches.find(f => f.method === 'PUT');
        assert.equal(put.url, '/api/questions/5/kcs');
        assert.deepEqual(put.body, { items: [{ kc_id: 1 }, { kc_id: 2 }] });
        assert.ok(env.document.getElementById('kcQCurrent').textContent.includes('人工'));
    });

    test('題號不合法 → 不打 API；題目不存在 → 顯示伺服器的 message', async () => {
        const { bridge } = await mount();
        const qid = env.document.getElementById('kcQid');
        qid.value = 'abc';
        env.document.getElementById('kcQLoad').click();
        await flush();
        assert.ok(!bridge.calls.fetches.some(f => f.url.includes('/kcs')));
        qid.value = '404';
        env.document.getElementById('kcQLoad').click();
        await flush();
        assert.ok(bridge.calls.toasts.some(t => t.message === '找不到該題目。' && t.type === 'error'));
    });
});