// ─────────────────────────────────────────────────────────────
// public/js/tutor.js 的前端測試（階段 5 WS-E；docs/interfaces-stage5.md 第 4.5 條第 4 點）
//
// 三層：
//   1. 純函式：受限 Markdown 轉換（**XSS 案例**：<img onerror>、javascript: 連結、屬性跳脫、偽造佔位符）、
//      麥克風可用性、歧義替換、request body 組裝。
//   2. 檔案層級契約：旗標從 <meta> 讀、經 window.ExamApp 橋接、innerHTML 只有 renderMarkdown 一個來源。
//   3. 用 test/unit/lib/miniDom.js 真的把 module 跑起來：旗標關閉不渲染、麥克風不可用時隱藏按鈕並說明、
//      送出後的回覆（驗算區塊用 textContent、「AI 產生，請自行判斷」）、
//      **按住說話 → 逐字稿 → 點歧義 chip → 老師按確認才送出**。
//
// miniDom 的 innerHTML 只支援清空（刻意的：其他三個 module 一律不用 innerHTML）。家教回覆是唯一例外，
// 所以本檔在 install 之後把 document.createElement 換成「innerHTML 存成字串」的子類——只在本檔生效。
// ─────────────────────────────────────────────────────────────
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, fakeBridge, flush, MiniNode } = require('./lib/miniDom');

const FILE = path.resolve(__dirname, '..', '..', 'public', 'js', 'tutor.js');
const SRC = fs.readFileSync(FILE, 'utf8');

let seq = 0;
async function loadFresh() {
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SRC + `\n// instance ${++seq}\n`));
}
let shared = null;
const load = () => (shared ||= loadFresh());

// ───────────────────────── 1. 純函式 ─────────────────────────

describe('renderMarkdown — 先整段 escape，再轉換受限標記（XSS）', () => {
    test('<img onerror> 與 <script> 一律變成文字', async () => {
        const { renderMarkdown } = await load();
        const html = renderMarkdown('看這個 <img src=x onerror=alert(1)> 還有 <script>alert(1)</script>');
        assert.ok(!/<img/i.test(html), html);
        assert.ok(!/<script/i.test(html), html);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });

    test('javascript: 連結不會變成 <a>（本轉換器不支援連結，原樣當文字）', async () => {
        const { renderMarkdown } = await load();
        for (const src of ['[點我](javascript:alert(1))', '<a href="javascript:alert(1)">x</a>', '[x](https://example.com)']) {
            const html = renderMarkdown(src);
            assert.ok(!/<a\b/i.test(html), html);
            assert.ok(!/<[^>]*href=/i.test(html), html);           // 文字裡的 href= 是安全的（< 已跳脫），標籤裡不能有
        }
    });

    test('粗體、行內程式碼、區塊程式碼裡的 HTML 也是文字；引號被跳脫（沒有屬性可以逃逸）', async () => {
        const { renderMarkdown } = await load();
        assert.equal(renderMarkdown('**<b onclick="x">粗</b>**'),
            '<p><strong>&lt;b onclick=&quot;x&quot;&gt;粗&lt;/b&gt;</strong></p>');
        assert.equal(renderMarkdown('`<svg onload=alert(1)>`'), '<p><code>&lt;svg onload=alert(1)&gt;</code></p>');
        assert.equal(renderMarkdown('```html\n<iframe src="x"></iframe>\n```'),
            '<pre><code>&lt;iframe src=&quot;x&quot;&gt;&lt;/iframe&gt;</code></pre>');
        assert.ok(renderMarkdown("it's").includes('it&#39;s'));
    });

    test('輸入裡偽造佔位符（NUL）不會把別的內容換進來', async () => {
        const { renderMarkdown } = await load();
        const html = renderMarkdown('\u0000I0\u0000 與 `<b>`');
        assert.ok(!html.includes('\u0000'));
        assert.ok(!/<b>/.test(html.replace(/<\/?(p|code|strong)>/g, '')), html);
    });

    test('唯一可能出現的屬性是 <ol start="數字">', async () => {
        const { renderMarkdown } = await load();
        const html = renderMarkdown('3. 第三步\n4. 第四步\n\n- a\n\n**b** `c`\n\n```\nd\n```');
        const attrs = [...html.matchAll(/<\w+\s+([^>]*)>/g)].map(m => m[1]);
        assert.deepEqual(attrs, ['start="3"']);
    });

    test('段落、換行、清單（有序從幾號開始）、粗體、標題轉粗體段落', async () => {
        const { renderMarkdown } = await load();
        assert.equal(renderMarkdown('第一段\n第二行\n\n第二段'), '<p>第一段<br>第二行</p>\n<p>第二段</p>');
        assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
        assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
        assert.equal(renderMarkdown('步驟如下：\n1. 列式\n2. 化簡'), '<p>步驟如下：</p>\n<ol><li>列式</li><li>化簡</li></ol>');
        assert.equal(renderMarkdown('### 驗算\n**驗算**：一致'), '<p><strong>驗算</strong></p>\n<p><strong>驗算</strong>：一致</p>');
    });

    test('數學式原樣留給 MathJax：$…$、$$…$$（可跨行）、\\(…\\)；裡面的 * 與 ` 不被當成標記', async () => {
        const { renderMarkdown } = await load();
        assert.equal(renderMarkdown('答案是 $a<b$。'), '<p>答案是 $a&lt;b$。</p>');
        assert.equal(renderMarkdown('$$\n\\frac{1}{2}\n\n+1\n$$'), '<p>$$\n\\frac{1}{2}\n\n+1\n$$</p>');
        assert.equal(renderMarkdown('$**x**$ 與 $`y`$'), '<p>$**x**$ 與 $`y`$</p>');
        assert.equal(renderMarkdown('\\(x^2\\) 與 $\\ce{H2O}$'), '<p>\\(x^2\\) 與 $\\ce{H2O}$</p>');
    });

    test('程式碼區塊裡的 $ 與 ** 不處理；沒有結尾圍欄時吃到文末', async () => {
        const { renderMarkdown } = await load();
        assert.equal(renderMarkdown('```python\nprint("**$x$**")\n```'), '<pre><code>print(&quot;**$x$**&quot;)</code></pre>');
        assert.equal(renderMarkdown('前文\n```\na = 1'), '<p>前文</p>\n<pre><code>a = 1</code></pre>');
    });

    test('空字串、null → 空字串', async () => {
        const { renderMarkdown } = await load();
        assert.equal(renderMarkdown(''), '');
        assert.equal(renderMarkdown(null), '');
    });
});

describe('其他純函式', () => {
    test('parseBool 與後端 config/features.js 逐字相同', async () => {
        const { parseBool } = await load();
        const { parseBool: backend } = require('../../config/features');
        for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', '', null, undefined, '__FEATURE_TUTOR__']) {
            assert.equal(parseBool(v), backend(v), String(v));
        }
    });

    test('micAvailability：非安全連線 → 說明 localhost／HTTPS；缺 API → 說明瀏覽器；非桌機 → 說明限桌機', async () => {
        const { micAvailability } = await load();
        const ok = { secureContext: true, hasGetUserMedia: true, hasMediaRecorder: true, desktop: true };
        assert.deepEqual(micAvailability(ok), { ok: true, reason: '' });
        assert.match(micAvailability({ ...ok, secureContext: false }).reason, /localhost 或 HTTPS/);
        assert.equal(micAvailability({ ...ok, secureContext: false }).ok, false);
        assert.match(micAvailability({ ...ok, hasMediaRecorder: false }).reason, /不支援錄音/);
        assert.match(micAvailability({ ...ok, hasGetUserMedia: false }).reason, /不支援錄音/);
        assert.match(micAvailability({ ...ok, desktop: false }).reason, /只支援桌機/);
    });

    test('pickRecorderMime：依序挑第一個支援的；都不支援回空字串；isTypeSupported 丟錯也不炸', async () => {
        const { pickRecorderMime, extensionFor } = await load();
        assert.equal(pickRecorderMime(m => m === 'audio/ogg'), 'audio/ogg');
        assert.equal(pickRecorderMime(() => true), 'audio/webm;codecs=opus');
        assert.equal(pickRecorderMime(() => false), '');
        assert.equal(pickRecorderMime(() => { throw new Error('x'); }), '');
        assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
        assert.equal(extensionFor('audio/mp4'), 'm4a');
        assert.equal(extensionFor(''), 'webm');
    });

    test('replaceMathChoice：先換 $from$、再換裸字串；只換第一處；找不到回 replaced=false', async () => {
        const { replaceMathChoice } = await load();
        assert.deepEqual(replaceMathChoice('算 $\\sqrt{x}+1$ 與 $\\sqrt{x}+1$', '\\sqrt{x}+1', '\\sqrt{x+1}'),
            { text: '算 $\\sqrt{x+1}$ 與 $\\sqrt{x}+1$', replaced: true });
        assert.deepEqual(replaceMathChoice('算 $$a$$', 'a', 'b'), { text: '算 $$b$$', replaced: true });
        assert.deepEqual(replaceMathChoice('裸的 x^2+1', 'x^2+1', '\\frac{1}{x^2+1}'),
            { text: '裸的 \\frac{1}{x^2+1}', replaced: true });
        assert.deepEqual(replaceMathChoice('沒有', 'y', 'z'), { text: '沒有', replaced: false });
        assert.deepEqual(replaceMathChoice('$x$', '', 'z'), { text: '$x$', replaced: false });
    });

    test('parseQuestionId 與 buildRequestBody：可選欄位沒有值就不送；歷史最多 8 輪', async () => {
        const { parseQuestionId, buildRequestBody } = await load();
        assert.equal(parseQuestionId(''), null);
        assert.equal(parseQuestionId(' 12 '), 12);
        assert.ok(Number.isNaN(parseQuestionId('0')));
        assert.ok(Number.isNaN(parseQuestionId('1.5')));
        assert.ok(Number.isNaN(parseQuestionId('abc')));

        assert.deepEqual(buildRequestBody({ message: ' 問 ', mode: 'direct', subject: null, studentId: null, questionId: null, history: [] }),
            { message: '問', mode: 'direct' });
        const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'tutor' : 'user', text: `t${i}` }));
        const body = buildRequestBody({ message: 'q', mode: 'socratic', subject: '數學', studentId: 3, questionId: 12, history });
        assert.equal(body.subject, '數學');
        assert.equal(body.student_id, 3);
        assert.equal(body.question_id, 12);
        assert.equal(body.history.length, 8);
        assert.equal(body.history[0].text, 't2');
        assert.equal(buildRequestBody({ message: 'q', mode: 'direct', history: [{ role: 'tutor', text: 'x'.repeat(5000) }] }).history[0].text.length, 4000);
    });

    test('parseQuestionId：上限是 int4（2147483647），超過當成不合法（與後端一致）', async () => {
        const { parseQuestionId } = await load();
        assert.equal(parseQuestionId('2147483647'), 2147483647);
        assert.ok(Number.isNaN(parseQuestionId('2147483648')));
        assert.ok(Number.isNaN(parseQuestionId('99999999999')));
    });

    test('outcomeLabel 與 formatUsd', async () => {
        const { outcomeLabel, formatUsd } = await load();
        assert.equal(outcomeLabel('OUTCOME_OK'), '執行成功');
        assert.equal(outcomeLabel('OUTCOME_FAILED'), '執行失敗');
        assert.equal(outcomeLabel('OUTCOME_DEADLINE_EXCEEDED'), '執行逾時');
        assert.equal(outcomeLabel(null), '沒有回報結果');
        assert.equal(formatUsd(0.012345), 'US$0.0123');
        assert.equal(formatUsd(undefined), '—');
    });
});

// ───────────────────────── 2. 檔案層級契約 ─────────────────────────

describe('tutor.js 的檔案層級契約', () => {
    test('旗標從 <meta name="feature-tutor"> 與 feature-voice 讀，沒有寫死', () => {
        assert.ok(SRC.includes("featureOn('tutor')"));
        assert.ok(SRC.includes("featureOn('voice')"));
        assert.ok(SRC.includes('meta[name="feature-${name}"]'));
        assert.ok(!/FEATURE_(TUTOR|VOICE)\s*=\s*true/i.test(SRC));
    });

    test('經 window.ExamApp 橋接，不自己定義 apiFetch／showToast／renderMath', () => {
        assert.ok(SRC.includes('window.ExamApp'));
        for (const fn of ['apiFetch', 'showToast', 'renderMath', 'createQuestionEditor']) {
            assert.ok(!new RegExp(`function\\s+${fn}\\b`).test(SRC), fn);
        }
    });

    test('innerHTML 只有兩種用法：清空，或放 renderMarkdown 的結果', () => {
        const uses = [...SRC.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(m => m[1].trim());
        assert.ok(uses.length > 0);
        for (const u of uses) assert.ok(u === "''" || u.startsWith('renderMarkdown('), u);
    });

    test('科目清單讀 /api/chapter-whitelist，不寫死科目', () => {
        assert.ok(SRC.includes("'/api/chapter-whitelist'"));
        assert.ok(!/['"]數學['"]\s*,\s*['"]物理['"]/.test(SRC));
    });

    test('index.html 的最小掛鉤：#tutor 對應到 view-tutor 並標註〔stage5 WS-E〕', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.ok(html.includes("VIEW_FOR_ANCHOR.tutor = 'view-tutor'; TOP_ANCHORS.push('tutor');"));
        assert.ok(html.includes('〔stage5 WS-E〕'));
        assert.ok(html.includes('<script type="module" src="/js/tutor.js"></script>'));
    });
});

// ───────────────────────── 3. 真的跑起來（miniDom）─────────────────────────

/** innerHTML 存成字串的節點（只在本檔用；見檔頭） */
class HtmlNode extends MiniNode {
    get innerHTML() { return this._html ?? ''; }
    set innerHTML(v) { this.children = []; this._text = ''; this._html = String(v); }
}

let env = null;
const saved = {};
function setGlobal(name, value) {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}
function restoreGlobals() {
    for (const [name, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
        delete saved[name];
    }
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 依路由回應的假 apiFetch，記下每一次呼叫 */
function routedFetch(routes) {
    const calls = [];
    const fn = async (url, options = {}) => {
        const raw = options.body;
        let body = raw;
        if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { body = raw; } }
        calls.push({ url, method: options.method || 'GET', body });
        const handler = routes[url];
        if (!handler) return jsonResponse({ message: `沒有排定 ${url}` }, 501);
        return handler(body);
    };
    fn.calls = calls;
    return fn;
}

const BASE_ROUTES = {
    '/api/chapter-whitelist': () => jsonResponse({ 數學: ['向量內積'], 物理: ['牛頓運動定律'] }),
    '/api/students': () => jsonResponse({ items: [{ id: 3, name: '王小明' }] })
};

function mount({ meta, apiFetch, secure = false, mic = false } = {}) {
    env = install({
        meta: { 'feature-tutor': 'true', 'feature-voice': 'false', ...(meta || {}) },
        sections: ['tutor'],
        examApp: fakeBridge(apiFetch ? { apiFetch } : {})
    });
    env.document.createElement = (tag) => new HtmlNode(tag, env.document);
    env.window.isSecureContext = secure;
    if (mic) {
        setGlobal('navigator', { mediaDevices: { getUserMedia: async () => mic.stream } });
        setGlobal('MediaRecorder', mic.Recorder);
    } else {
        setGlobal('navigator', {});
        setGlobal('MediaRecorder', undefined);
        delete globalThis.MediaRecorder;
    }
    return env;
}

function find(root, pred) {
    for (const n of root.walk()) if (pred(n)) return n;
    return null;
}
const byId = (id) => env.document.getElementById(id);
const allText = () => env.document.getElementById('tutor').textContent;

beforeEach(() => { env = null; });
afterEach(() => {
    if (env) env.restore();
    env = null;
    restoreGlobals();
});

describe('渲染：旗標與版面', () => {
    test('FEATURE_TUTOR 關閉 → <section id="tutor"> 維持空的（不是隱藏）', async () => {
        mount({ meta: { 'feature-tutor': '__FEATURE_TUTOR__', 'feature-voice': 'true' } });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        const section = byId('tutor');
        assert.equal(section.childElementCount, 0);
        assert.equal(section.className, '');
    });

    test('window.ExamApp 不存在 → 停手並印錯，不爆', async () => {
        env = install({ meta: { 'feature-tutor': 'true' }, sections: ['tutor'], examApp: undefined });
        const errors = [];
        const real = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            const mod = await loadFresh();
            await mod.init();
            await flush();
        } finally { console.error = real; }
        assert.ok(errors.some(e => e.startsWith('[tutor]') && e.includes('window.ExamApp')));
        assert.equal(byId('tutor').childElementCount, 0);
    });

    test('FEATURE_TUTOR 開、FEATURE_VOICE 關：有對話框、模式切換、科目（讀 API）、學生、題目 ID；沒有按住說話', async () => {
        const apiFetch = routedFetch(BASE_ROUTES);
        mount({ apiFetch });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        assert.ok(byId('tutorInput'));
        assert.ok(byId('tutorSend'));
        assert.ok(byId('tutorQuestionId'));
        assert.equal(byId('tutorMic'), null);
        assert.equal(byId('tutorVoiceReview'), null);
        assert.deepEqual(byId('tutorSubject').options.map(o => o.value), ['', '數學', '物理']);
        assert.deepEqual(byId('tutorStudent').options.map(o => o.textContent), ['（不指定）', '王小明']);
        assert.ok(find(byId('tutor'), n => n.getAttribute && n.getAttribute('data-mode') === 'socratic'));
        assert.ok(apiFetch.calls.some(c => c.url === '/api/chapter-whitelist'));
    });

    test('FEATURE_VOICE 開但不是安全連線 → 按鈕隱藏，並說明只能在 localhost 或 HTTPS 使用', async () => {
        mount({ meta: { 'feature-voice': 'true' }, apiFetch: routedFetch(BASE_ROUTES), secure: false });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        const mic = byId('tutorMic');
        assert.ok(mic, '按鈕節點存在');
        assert.ok(mic.classList.contains('hidden'), '但要隱藏');
        assert.match(byId('tutorMicNote').textContent, /localhost 或 HTTPS/);
    });

    test('安全連線但瀏覽器沒有 MediaRecorder → 隱藏並說明', async () => {
        mount({ meta: { 'feature-voice': 'true' }, apiFetch: routedFetch(BASE_ROUTES), secure: true });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        assert.ok(byId('tutorMic').classList.contains('hidden'));
        assert.match(byId('tutorMicNote').textContent, /不支援錄音/);
    });
});

describe('送出與回覆呈現', () => {
    const REPLY = {
        reply: '先算內積：$1\\times3+2\\times4$。\n\n- 第一步\n- 第二步\n\n<img src=x onerror=alert(1)>\n\n**驗算**：以 Python 算得 11。',
        mode: 'socratic',
        verification: { used: true, runs: [{ code: 'print("<b>11</b>")', outcome: 'OUTCOME_OK', output: '<i>11</i>\n' }] },
        context: { question_id: 12, kc_codes: ['MATH.向量內積.02'], student_context: true },
        usage: { tokenIn: 100, tokenOut: 50, costUsd: 0.0123 }
    };

    test('送出：body 帶模式、科目、學生、題目 ID；回覆經 renderMarkdown、驗算用 textContent、標示 AI 產生', async () => {
        const apiFetch = routedFetch({ ...BASE_ROUTES, '/api/tutor': () => jsonResponse(REPLY) });
        mount({ apiFetch });
        const mod = await loadFresh();
        await mod.init();
        await flush();

        find(byId('tutor'), n => n.getAttribute && n.getAttribute('data-mode') === 'socratic').click();
        byId('tutorSubject').value = '數學';
        byId('tutorStudent').value = '3';
        byId('tutorQuestionId').value = '12';
        byId('tutorInput').value = '  這題怎麼算？ ';
        byId('tutorSend').click();
        await flush(); await flush();

        const call = apiFetch.calls.find(c => c.url === '/api/tutor');
        assert.deepEqual(call.body, { message: '這題怎麼算？', mode: 'socratic', subject: '數學', student_id: 3, question_id: 12 });

        const bubble = find(byId('tutorLog'), n => n._html !== undefined);
        assert.ok(bubble, '回覆要經 innerHTML（renderMarkdown）');
        assert.equal(bubble.innerHTML, mod.renderMarkdown(REPLY.reply));
        assert.ok(!/<img/.test(bubble.innerHTML));
        assert.ok(bubble.innerHTML.includes('<ul><li>第一步</li><li>第二步</li></ul>'));

        const pres = [...byId('tutorLog').walk()].filter(n => n.tagName === 'pre');
        assert.equal(pres[0].textContent, 'print("<b>11</b>")', '程式碼原樣（textContent）');
        assert.equal(pres[1].textContent, '輸出：\n<i>11</i>\n');
        const text = allText();
        assert.match(text, /計算驗證：執行了 1 段程式/);
        assert.match(text, /AI 產生，請自行判斷/);
        assert.match(text, /US\$0\.0123/);
        assert.match(text, /題目 #12｜知識點 MATH\.向量內積\.02｜已帶入學生弱點摘要/);
        assert.equal(byId('tutorInput').value, '', '送出成功後清空輸入框');

        // 第二輪會帶上歷史
        byId('tutorInput').value = '第二個問題';
        byId('tutorSend').click();
        await flush(); await flush();
        const second = apiFetch.calls.filter(c => c.url === '/api/tutor')[1];
        assert.deepEqual(second.body.history, [{ role: 'user', text: '這題怎麼算？' }, { role: 'tutor', text: REPLY.reply }]);
    });

    test('沒有執行程式的回覆 → 明講「沒有執行程式驗算」', async () => {
        const apiFetch = routedFetch({ ...BASE_ROUTES, '/api/tutor': () => jsonResponse({ ...REPLY, verification: { used: false, runs: [] } }) });
        mount({ apiFetch });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        byId('tutorInput').value = '觀念題';
        byId('tutorSend').click();
        await flush(); await flush();
        assert.match(allText(), /這則回覆沒有執行程式驗算/);
    });

    test('伺服器回錯（例如 429 預算用完）→ 顯示訊息、不進歷史、不清輸入框', async () => {
        const apiFetch = routedFetch({ ...BASE_ROUTES, '/api/tutor': () => jsonResponse({ message: '今天的 AI 家教預算已用完' }, 429) });
        mount({ apiFetch });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        byId('tutorInput').value = '問題';
        byId('tutorSend').click();
        await flush(); await flush();
        assert.match(allText(), /⚠ 今天的 AI 家教預算已用完/);
        assert.equal(byId('tutorInput').value, '問題');
    });

    test('題目 ID 不是正整數 → 提示且不送出', async () => {
        const apiFetch = routedFetch(BASE_ROUTES);
        mount({ apiFetch });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        byId('tutorQuestionId').value = 'abc';
        byId('tutorInput').value = '問題';
        byId('tutorSend').click();
        await flush();
        assert.equal(apiFetch.calls.filter(c => c.url === '/api/tutor').length, 0);
        assert.ok(env.window.ExamApp.calls.toasts.some(t => /題目 ID/.test(t.message)));
    });
});

describe('按住說話：錄音 → 可編輯逐字稿 → 點歧義 chip → 老師按確認才送出', () => {
    /** 假 MediaRecorder：stop() 時先吐一段資料再發 stop 事件 */
    class FakeRecorder {
        static isTypeSupported(m) { return m === 'audio/webm;codecs=opus'; }
        constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || ''; this.state = 'inactive'; this.l = {}; }
        addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
        start() { this.state = 'recording'; }
        stop() {
            this.state = 'inactive';
            for (const fn of this.l.dataavailable || []) fn({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) });
            for (const fn of this.l.stop || []) fn({});
        }
    }
    const stream = { getTracks: () => [{ stop() { stream.stopped = (stream.stopped || 0) + 1; } }] };

    test('完整流程', async () => {
        const transcript = {
            text: '請問 $\\sqrt{x}+1$ 的導數？',
            math_segments: [{ spoken: '根號 x 加一', latex: '\\sqrt{x}+1' }],
            ambiguities: [{ spoken: '根號 x 加一', options: ['\\sqrt{x}+1', '\\sqrt{x+1}'] }],
            usage: { costUsd: 0.001 }
        };
        const apiFetch = routedFetch({
            ...BASE_ROUTES,
            '/api/voice/transcribe': () => jsonResponse(transcript),
            '/api/tutor': () => jsonResponse({ reply: '好', mode: 'direct', verification: { used: false, runs: [] }, context: { kc_codes: [], student_context: false }, usage: {} })
        });
        mount({ meta: { 'feature-voice': 'true' }, apiFetch, secure: true, mic: { stream, Recorder: FakeRecorder } });
        const mod = await loadFresh();
        await mod.init();
        await flush();

        const mic = byId('tutorMic');
        assert.ok(!mic.classList.contains('hidden'), '安全連線＋有 API → 按鈕要顯示');

        // 按下 → 取得麥克風 → 開錄；放開（時間拉長到超過最短長度）→ 上傳
        const realNow = Date.now;
        const t0 = realNow();
        Date.now = () => t0;
        try {
            mic.dispatchEvent({ type: 'pointerdown', preventDefault() { } });
            await flush();
            assert.equal(mic.getAttribute('aria-pressed'), 'true');
            Date.now = () => t0 + 2000;
            mic.dispatchEvent({ type: 'pointerup' });
            await flush(); await flush();
        } finally {
            Date.now = realNow;
        }
        assert.equal(stream.stopped, 1, '麥克風要關掉');

        const up = apiFetch.calls.find(c => c.url === '/api/voice/transcribe');
        assert.ok(up, '放開後要上傳');
        assert.ok(up.body instanceof FormData);
        assert.equal(up.body.get('audio').type, 'audio/webm;codecs=opus');
        assert.equal(up.body.get('audio').name, 'speech.webm');

        // 逐字稿面板：可編輯，**還沒有送給家教**
        const panel = byId('tutorVoiceReview');
        assert.ok(!panel.classList.contains('hidden'));
        assert.equal(byId('tutorVoiceText').value, transcript.text);
        assert.equal(apiFetch.calls.filter(c => c.url === '/api/tutor').length, 0, '沒按確認就不得送出');

        // 點另一個歧義選項 → 逐字稿裡那一段換掉
        const chip = find(panel, n => n.tagName === 'button' && n.textContent === '$\\sqrt{x+1}$');
        chip.click();
        assert.equal(byId('tutorVoiceText').value, '請問 $\\sqrt{x+1}$ 的導數？');
        assert.equal(chip.getAttribute('aria-pressed'), 'true');

        // 老師再手動改一個字，按確認才送出，送的是改過的內容
        byId('tutorVoiceText').value = '請問 $\\sqrt{x+1}$ 的導數是什麼？';
        byId('tutorVoiceConfirm').click();
        await flush(); await flush();
        const sent = apiFetch.calls.filter(c => c.url === '/api/tutor');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].body.message, '請問 $\\sqrt{x+1}$ 的導數是什麼？');
        assert.ok(panel.classList.contains('hidden'), '送出後收起面板');
    });

    test('按取消 → 什麼都不送', async () => {
        const apiFetch = routedFetch({
            ...BASE_ROUTES,
            '/api/voice/transcribe': () => jsonResponse({ text: '隨便說說', math_segments: [], ambiguities: [] })
        });
        mount({ meta: { 'feature-voice': 'true' }, apiFetch, secure: true, mic: { stream, Recorder: FakeRecorder } });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        const realNow = Date.now;
        const t0 = realNow();
        Date.now = () => t0;
        try {
            byId('tutorMic').dispatchEvent({ type: 'pointerdown', preventDefault() { } });
            await flush();
            Date.now = () => t0 + 1500;
            byId('tutorMic').dispatchEvent({ type: 'pointerup' });
            await flush(); await flush();
        } finally { Date.now = realNow; }
        assert.equal(byId('tutorVoiceText').value, '隨便說說');
        byId('tutorVoiceCancel').click();
        assert.ok(byId('tutorVoiceReview').classList.contains('hidden'));
        assert.equal(apiFetch.calls.filter(c => c.url === '/api/tutor').length, 0);
    });

    test('錄太短（誤觸）→ 不上傳，提示按住再說', async () => {
        const apiFetch = routedFetch(BASE_ROUTES);
        mount({ meta: { 'feature-voice': 'true' }, apiFetch, secure: true, mic: { stream, Recorder: FakeRecorder } });
        const mod = await loadFresh();
        await mod.init();
        await flush();
        byId('tutorMic').dispatchEvent({ type: 'pointerdown', preventDefault() { } });
        await flush();
        byId('tutorMic').dispatchEvent({ type: 'pointerup' });
        await flush(); await flush();
        assert.equal(apiFetch.calls.filter(c => c.url === '/api/voice/transcribe').length, 0);
        assert.ok(env.window.ExamApp.calls.toasts.some(t => /太短/.test(t.message)));
    });
});
