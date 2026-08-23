// ─────────────────────────────────────────────────────────────
// test/unit/lib/miniDom.js — 讓 public/js/*.js 真的跑起來的極小 DOM
//
// 為什麼需要它：`npm run check:html` 只做 `node --check`（parse 得過），
// 純函式測試只碰得到匯出的那幾支。**三個 module 的 init()／mount／render
// 從來沒有被執行過**——一個 typo（`el('div', cls, {className: …})` 寫錯鍵、
// appendChild 給了 undefined）在這兩層都是全綠，只有打開瀏覽器才看得到。
//
// 為什麼不裝 jsdom：本專案的賣點之一是「clone 即跑、沒有建置步驟」，
// devDependencies 每加一個就是所有人 `npm ci` 都要付的成本。
// 這裡真正需要的只有「建節點、掛節點、查節點、發事件」，一百多行就夠，
// 而且**刻意不完整**：模組用到本檔沒實作的 API 時會直接丟錯，
// 那正是我們想知道的事（悄悄回 undefined 才危險）。
//
// 沒有排版、沒有 CSS、沒有真的事件冒泡（只有 document 層的監聽器與直接 dispatch）。
// 它驗的是「渲染有沒有跑完、長出來的東西對不對」，不是「畫面好不好看」。
// ─────────────────────────────────────────────────────────────

/** 極簡選擇器：支援 `tag`、`#id`、`[attr]`、`[attr="v"]`、以及用空白分隔的後代組合。 */
function matchesSimple(node, sel) {
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    const attr = sel.match(/^([a-zA-Z][\w-]*)?\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
        const [, tag, name, value] = attr;
        if (tag && node.tagName !== tag.toLowerCase()) return false;
        if (!node.hasAttribute(name)) return false;
        return value === undefined || node.getAttribute(name) === value;
    }
    return node.tagName === sel.toLowerCase();
}

class MiniNode {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toLowerCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this._text = '';
        this.className = '';
        this.dataset = new Proxy({}, {
            get: (t, k) => this.getAttribute(`data-${camelToDash(String(k))}`),
            set: (t, k, v) => { this.setAttribute(`data-${camelToDash(String(k))}`, v); return true; },
            has: (t, k) => this.hasAttribute(`data-${camelToDash(String(k))}`)
        });
        this.classList = {
            add: (...c) => { this.className = [...new Set([...cls(this.className), ...c])].join(' '); },
            remove: (...c) => { this.className = cls(this.className).filter(x => !c.includes(x)).join(' '); },
            contains: (c) => cls(this.className).includes(c),
            toggle: (c, force) => {
                const want = force === undefined ? !this.classList.contains(c) : !!force;
                if (want) this.classList.add(c); else this.classList.remove(c);
                return want;
            }
        };
    }

    // ── 屬性 ──
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }

    // ── 內容 ──
    get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map(c => c.textContent).join('');
    }
    set textContent(v) { this.children = []; this._text = String(v ?? ''); }

    get innerHTML() { return this.children.map(c => c.outerText).join(''); }
    set innerHTML(v) {
        if (String(v) !== '') {
            throw new Error(`miniDom 的 innerHTML 只支援清空（收到 ${String(v).slice(0, 40)}…）。請改用 createElement／append。`);
        }
        this.children = [];
        this._text = '';
    }
    get outerText() { return this.textContent; }
    get childElementCount() { return this.children.length; }

    // ── 樹 ──
    appendChild(node) {
        if (!node || !(node instanceof MiniNode)) throw new Error(`appendChild 收到 ${node}（不是節點）`);
        if (this._text) this._text = '';
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(c => c !== this);
        this.parentNode = null;
    }
    replaceWith(node) {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        node.parentNode = this.parentNode;
        this.parentNode.children.splice(i, 1, node);
        this.parentNode = null;
    }

    *walk() {
        for (const c of this.children) { yield c; yield* c.walk(); }
    }
    querySelectorAll(selector) {
        const parts = selector.trim().split(/\s+(?![^\[]*\])/);
        let pool = [...this.walk()];
        for (const part of parts) pool = pool.filter(n => matchesSimple(n, part));
        // 後代組合：先用最後一段篩，再確認祖先鏈含前面各段
        if (parts.length > 1) {
            pool = [...this.walk()].filter(n => {
                if (!matchesSimple(n, parts[parts.length - 1])) return false;
                let p = n.parentNode, i = parts.length - 2;
                while (p && i >= 0) { if (matchesSimple(p, parts[i])) i--; p = p.parentNode; }
                return i < 0;
            });
        }
        return pool;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

    // ── 事件 ──
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    dispatchEvent(event) {
        for (const fn of this.listeners.get(event.type) || []) fn.call(this, event);
        return true;
    }
    click() { return this.dispatchEvent({ type: 'click', target: this }); }
    scrollIntoView() { }

    // ── <select> / <option> / <input> 的 value ──
    //
    // <option> 的 value 在真 DOM 裡是**反射屬性**（讀寫 value 就是讀寫 value 屬性），
    // 而 <div> 之類的 value 只是一個普通 JS 屬性。這個差別很重要：三個 module 都用
    // `el('option', '', { value: String(id) })` 建選項，如果 option 的 value 只存成
    // 普通屬性，`select.value` 就永遠讀不到東西——整個下拉會靜靜地空著。
    get options() { return this.children.filter(c => c.tagName === 'option'); }
    get value() {
        if (this.tagName === 'select') {
            const chosen = this.options.find(o => o._selected);
            if (chosen) return chosen.value;
            if (this._explicitlyCleared) return '';
            // 真 DOM：沒有任何 option 被選時，select.value 是第一個 option 的值
            return this.options[0] ? this.options[0].value : '';
        }
        if (this.tagName === 'option' || this.tagName === 'input' || this.tagName === 'textarea') {
            return this.getAttribute('value') ?? (this.tagName === 'option' ? this.textContent : '');
        }
        return this._value ?? '';
    }
    set value(v) {
        if (this.tagName === 'select') {
            // 真 DOM：設成一個不存在的值 → selectedIndex = -1、value 變成 ''
            for (const o of this.options) o._selected = o.value === String(v);
            this._explicitlyCleared = !this.options.some(o => o._selected);
            return;
        }
        if (this.tagName === 'option' || this.tagName === 'input' || this.tagName === 'textarea') {
            this.setAttribute('value', v);
            return;
        }
        this._value = String(v);
    }
    get selected() { return !!this._selected; }
    set selected(v) { this._selected = !!v; }
}

function cls(s) { return String(s || '').split(/\s+/).filter(Boolean); }
function camelToDash(k) { return k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`); }

/**
 * 建立一個乾淨的環境並掛上 globalThis（document／window／location／CustomEvent…）。
 *
 * @param {object} opts
 * @param {Record<string,string>} [opts.meta]   <meta name=…> 的內容
 * @param {string[]} [opts.sections]            要先建好的空 <section id=…>
 * @param {string} [opts.search]                location.search，例如 '?mock=1'
 * @param {object} [opts.examApp]               window.ExamApp 的內容
 * @returns {{document:MiniNode, window:object, restore:() => void}}
 */
function install(opts = {}) {
    const doc = new MiniNode('#document', null);
    doc.ownerDocument = doc;
    doc.readyState = 'complete';
    doc.createElement = (tag) => new MiniNode(tag, doc);
    doc.createElementNS = (ns, tag) => { const n = new MiniNode(tag, doc); n.namespaceURI = ns; return n; };
    doc.getElementById = (id) => doc.querySelectorAll(`#${id}`)[0] || null;

    const head = doc.appendChild(new MiniNode('head', doc));
    for (const [name, content] of Object.entries(opts.meta || {})) {
        const m = head.appendChild(new MiniNode('meta', doc));
        m.setAttribute('name', name);
        m.content = content;
    }
    const body = doc.appendChild(new MiniNode('body', doc));
    for (const id of opts.sections || []) {
        const s = body.appendChild(new MiniNode('section', doc));
        s.id = id;
    }

    // meta[name="x"] 的 .content 是 HTMLMetaElement 的屬性，不是 attribute——
    // 三個 module 讀的都是 .content，所以上面直接掛在節點上。
    const saved = {
        document: globalThis.document, window: globalThis.window,
        location: globalThis.location, CustomEvent: globalThis.CustomEvent, Event: globalThis.Event,
        setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval
    };
    // variants.js 的輪詢用 setInterval，而它比測試活得久：restore() 之後那個 callback
    // 會讀到不存在的 document 而丟 unhandledRejection。這裡把 handle 記下來，restore() 時一起清。
    const timers = new Set();
    const realSetInterval = saved.setInterval;
    const realClearInterval = saved.clearInterval;
    const win = { ExamApp: opts.examApp || undefined };
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.location = { search: opts.search || '' };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } };
    globalThis.Event = class { constructor(type) { this.type = type; } };
    globalThis.setInterval = (fn, ms) => { const h = realSetInterval(fn, ms); timers.add(h); return h; };
    globalThis.clearInterval = (h) => { timers.delete(h); return realClearInterval(h); };

    return {
        document: doc, window: win, body,
        restore() {
            for (const h of timers) realClearInterval(h);
            timers.clear();
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
            }
        }
    };
}

/** 一組會被三個 module 當成 window.ExamApp 的假橋接，並記下所有呼叫。 */
function fakeBridge(extra = {}) {
    const calls = { toasts: [], sections: [], fetches: [] };
    return {
        calls,
        apiFetch(url, options) {
            // body 一起記下來：有些斷言問的是「送出去的到底是什麼」（例如
            // 「出變式」的 count／difficulty_delta 有沒有真的用下拉選到的值）。
            const raw = (options || {}).body;
            let body = null;
            if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { body = raw; } }
            calls.fetches.push({ url, method: (options || {}).method || 'GET', body });
            return Promise.resolve(new Response(JSON.stringify({ message: '這個測試不該打真的 API' }), { status: 501 }));
        },
        showToast(message, type) { calls.toasts.push({ message, type }); },
        renderMath() { },
        escapeHtml(s) { return String(s ?? ''); },
        createQuestionEditor() { return new MiniNode('div', globalThis.document); },
        getPaperCache: () => null,
        setPaperCache: (p) => p,
        getChapters: () => [],
        getChapterWhitelist: () => ({ 數學: ['向量內積', '實數'], 物理: ['牛頓運動定律', '摩擦力與向心力'] }),
        showSection(id) { calls.sections.push(id); },
        ...extra
    };
}

/** 等到所有已排入的微任務跑完（module 的 init 是 async）。 */
const flush = () => new Promise(r => setTimeout(r, 0));

module.exports = { install, fakeBridge, flush, MiniNode };
