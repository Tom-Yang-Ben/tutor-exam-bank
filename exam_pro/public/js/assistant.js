// ─────────────────────────────────────────────────────────────
// public/js/assistant.js — 對話式助教（階段 4 A1）
//
// 這一頁的產品主張：**工具調用軌跡是內容，不是雜訊。**
// 助教每一句回覆下面都攤開「這一輪主控 agent 叫了哪些工具、帶什麼參數、拿回什麼」
// ——這正是這個功能存在的原因（展示 LLM 主控編排），藏起來就只剩一個聊天框。
//
// 慣例全部沿用階段 3 的三個 module：
//   - FEATURE_ASSISTANT 關閉時**整段不渲染**（不是隱藏）。
//   - 透過 window.ExamApp 橋接 apiFetch／showToast／renderMath。
//   - 伺服器回的所有文字一律 textContent，不進 innerHTML。
// ─────────────────────────────────────────────────────────────
const MAX_MESSAGE = 500;          // 與 services/assistantService.js 的 MAX_MESSAGE_LEN 一致
const HISTORY_KEEP = 8;           // 送回伺服器的歷史輪數（同後端 MAX_HISTORY）

/** 對話狀態（只活在頁面裡；重整就歸零——助教沒有長期記憶，這是誠實的呈現）。 */
const history = [];

function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[assistant] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[assistant] window.ExamApp 缺少：${missing.join('、')}。助教分頁不會掛載。`);
        return null;
    }
    return app;
}

/** 與後端 config/features.js 的 parseBool 逐字相同。 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

function assistantEnabled() {
    const meta = document.querySelector('meta[name="feature-assistant"]');
    if (parseBool(meta ? meta.content : '')) return true;
    return new URLSearchParams(location.search).get('assistant') === '1';
}

/** 建元素的小工具（與 students.js 的 el 同款）。 */
function el(tag, className = '', attrs = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'textContent') node.textContent = v;
        else node.setAttribute(k, v);
    }
    return node;
}

// ───────────────────────── 渲染 ─────────────────────────

function bubble(app, role, text) {
    const row = el('div', role === 'user' ? 'flex justify-end' : 'flex justify-start');
    const b = el('div', role === 'user'
        ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white whitespace-pre-line'
        : 'max-w-[85%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700 whitespace-pre-line');
    b.textContent = text;
    row.appendChild(b);
    if (role !== 'user') app.renderMath(b);
    return row;
}

/** 工具軌跡：<details> 摺疊，預設收合但一眼看得到「叫了幾次、叫了誰」。 */
function traceBlock(steps) {
    const wrap = el('details', 'mt-1 ml-1');
    const summary = el('summary', 'cursor-pointer text-[11px] font-bold text-slate-400 hover:text-slate-600', {
        textContent: `🛠 工具調用軌跡（${steps.length} 步）：${steps.map(s => s.tool).join(' → ') || '（沒有呼叫工具）'}`
    });
    wrap.appendChild(summary);
    for (const s of steps) {
        const box = el('div', 'mt-1 rounded-lg border border-slate-100 bg-slate-50 p-2');
        box.appendChild(el('p', `text-[11px] font-bold ${s.ok ? 'text-slate-600' : 'text-rose-500'}`, {
            textContent: `▶ ${s.tool}(${JSON.stringify(s.args)})${s.ok ? '' : '　⚠ 失敗'}`
        }));
        const pre = el('pre', 'mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-500');
        pre.textContent = JSON.stringify(s.result, null, 1);
        box.appendChild(pre);
        wrap.appendChild(box);
    }
    return wrap;
}

// ───────────────────────── 送出 ─────────────────────────

async function send(app, ui) {
    const text = ui.input.value.trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE) return app.showToast(`一句最多 ${MAX_MESSAGE} 字。`, 'error');

    ui.input.value = '';
    ui.send.disabled = true;
    ui.log.appendChild(bubble(app, 'user', text));
    const thinking = el('p', 'ml-1 text-[11px] text-slate-400', { textContent: '助教思考中（主控 agent 決定要不要叫工具）…' });
    ui.log.appendChild(thinking);
    ui.log.scrollTop = ui.log.scrollHeight;

    try {
        const res = await app.apiFetch('/api/assistant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history: history.slice(-HISTORY_KEEP) })
        });
        const body = await res.json();
        thinking.remove();
        if (!res.ok) {
            ui.log.appendChild(bubble(app, 'assistant', `⚠ ${body.message || '助教暫時無法回應'}`));
            return;
        }
        ui.log.appendChild(bubble(app, 'assistant', body.reply));
        ui.log.appendChild(traceBlock(body.steps || []));
        history.push({ role: 'user', text }, { role: 'assistant', text: body.reply });
    } catch {
        thinking.remove();
        ui.log.appendChild(bubble(app, 'assistant', '⚠ 連線失敗，請稍後再試。'));
    } finally {
        ui.send.disabled = false;
        ui.log.scrollTop = ui.log.scrollHeight;
        ui.input.focus();
    }
}

// ───────────────────────── 版面 ─────────────────────────

function mountAssistantSection(app, section) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-5 flex items-start gap-3 border-b border-slate-100 pb-5');
    const titleBox = el('div');
    titleBox.append(
        el('p', 'eyebrow text-violet-600', { textContent: 'Assistant' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: '對話式助教' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '用一句話問：「小明最弱的章節？」「幫小華預覽一張向量內積 5 題的卷」。助教只能查詢與預覽——真的出卷、出變式仍由你在各分頁按確認。'
        })
    );
    head.append(el('span', 'section-icon bg-violet-50 text-violet-700', { textContent: '答' }), titleBox);

    const log = el('div', 'space-y-3 max-h-[28rem] overflow-y-auto rounded-2xl border border-slate-100 bg-slate-50/50 p-4', { id: 'asstLog' });
    log.appendChild(bubble(app, 'assistant', '你好，我是題庫助教。我可以查學生弱點、用白話搜題、找相似題、替學生試算不重複的卷（僅預覽）。想從哪裡開始？'));

    const inputRow = el('div', 'mt-4 flex gap-2');
    const input = el('input', 'field-control block w-full p-3', {
        id: 'asstInput', type: 'text', placeholder: '例如：小明最近錯的題目，幫我各找一題相似的', 'aria-label': '問助教'
    });
    const send_ = el('button', 'shrink-0 rounded-xl bg-violet-600 px-5 font-extrabold text-white transition-colors hover:bg-violet-700 disabled:opacity-40 cursor-pointer', {
        id: 'asstSend', type: 'button', textContent: '送出'
    });
    inputRow.append(input, send_);

    section.append(head, log, inputRow);

    const ui = { log, input, send: send_ };
    send_.addEventListener('click', () => send(app, ui));
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) send(app, ui); });
}

// ───────────────────────── 進入點 ─────────────────────────

/** 掛載。旗標關閉時**整段不渲染**（與階段 3 的三個分頁同一條規則）。 */
export function init() {
    const section = document.getElementById('assistant');
    if (!section) return;
    if (!assistantEnabled()) {
        console.info('[assistant] FEATURE_ASSISTANT 未開啟：助教分頁不渲染。');
        return;
    }
    const app = bridge();
    if (!app) return;
    mountAssistantSection(app, section);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
