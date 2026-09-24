// ─────────────────────────────────────────────────────────────
// public/js/tutor.js — AI 家教（含按住說話）（階段 5，擁有者：WS-E；docs/interfaces-stage5.md 第 4.5 條第 4 點）
//
// 這一頁的產品主張：**AI 的答案要能被檢查。**
//   - 每則回覆下方攤開「計算驗證」：模型用 code execution 跑過的程式與輸出，原樣呈現（textContent）；
//     沒有跑程式的回覆會明講「這則沒有經過程式驗算」。
//   - 每則回覆都標「AI 產生，請自行判斷」。
//   - 語音只負責「把話變成文字與公式」：逐字稿可編輯、歧義用 chip 讓老師點選，**老師按確認才送出**（ADR-013）。
//
// 慣例沿用階段 3／4 的 module：
//   - FEATURE_TUTOR 關閉時**整段不渲染**（不是隱藏）；FEATURE_VOICE 關閉時不渲染按住說話。
//   - 透過 window.ExamApp 橋接 apiFetch／showToast／renderMath。
//   - 伺服器回來的文字一律 textContent。唯一例外是家教回覆的 Markdown：
//     **先把整段 escape，再轉換受限的標記**（段落、清單、粗體、行內與區塊程式碼；標題轉成粗體段落），
//     最後交給 renderMath。沒有連結、沒有圖片、沒有任何來自文字的屬性——轉換器是純函式，XSS 案例有單元測試。
//   - 科目清單讀 GET /api/chapter-whitelist，不寫死（第 1.5 條）。
//   - 麥克風只在 localhost 或 HTTPS 可用（瀏覽器規定），本階段只支援桌機（DEC-018，D3 = a）；
//     不可用時隱藏按鈕並說明原因。
// ─────────────────────────────────────────────────────────────
const MAX_MESSAGE = 1000;            // 與 services/tutorService.js 的 MAX_MESSAGE_LEN 一致
const HISTORY_KEEP = 8;              // 與後端 MAX_HISTORY 一致
const HISTORY_TEXT_MAX = 4000;       // 與後端 MAX_HISTORY_TEXT_LEN 一致
const MAX_RECORD_MS = 60 * 1000;     // 一段最多錄 60 秒（遠低於 5 MB 上限）
const MIN_RECORD_MS = 600;           // 短於這個多半是誤觸
const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
const INT4_MAX = 2147483647;         // 與後端 services/tutorService.js 的 INT4_MAX 一致（questions.id 是 int4）

// ───────────────────────── 純函式（有單元測試）─────────────────────────

/** 與後端 config/features.js 的 parseBool 逐字相同。 */
export function parseBool(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** HTML escape（五個字元都換，屬性與內文都安全）。 */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const LIST_RE = /^\s*(?:([-*+])|(\d{1,4})[.)])\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;

/**
 * 受限 Markdown → HTML（第 4.5 條第 4 點）。
 *
 * 順序是安全性的關鍵：
 *   1. 去掉 NUL（佔位符用它當邊界，輸入不得偽造佔位符）、統一換行；
 *   2. **整段 escape**——之後的每一步都只在已 escape 的字串上加「固定的標籤」；
 *   3. 區塊程式碼、數學式（$$…$$、\[…\]、$…$、\(…\)）、行內程式碼先換成佔位符，
 *      讓粗體與清單的規則碰不到它們（數學式原樣留給 MathJax）；
 *   4. 粗體、清單、標題、段落；
 *   5. 佔位符換回——重複到沒有佔位符為止：slot 的內容本身可能又含佔位符
 *      （行內程式碼裡的 $…$ 先被當成數學式收走），只換一輪會留下 NUL 與「I0」、原本的內容不見。
 * 唯一會出現的屬性是 <ol start="數字">（只由 \d 組成）。不支援連結與圖片：[文字](網址) 原樣當文字。
 *
 * @param {string} src 伺服器回來的 Markdown
 * @returns {string} 可以安全放進 innerHTML 的 HTML
 */
export function renderMarkdown(src) {
    let text = String(src ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    text = escapeHtml(text);

    const slots = [];
    const holdBlock = (html) => `\n\n\u0000B${slots.push(html) - 1}\u0000\n\n`;
    const holdInline = (html) => `\u0000I${slots.push(html) - 1}\u0000`;

    // 區塊程式碼：```lang\n…```（沒有結尾圍欄時吃到文末）
    text = text.replace(/```[^\n`]*\n([\s\S]*?)(?:```|$)/g, (m, code) =>
        holdBlock(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`));
    // 數學式：原樣保留給 MathJax（內容已 escape；MathJax 讀的是文字節點，&lt; 會還原成 <）
    // 可跨行的兩種不得跨過區塊程式碼的佔位符（\u0000B）：LaTeX 裡不會有 ```，跨過去只會把程式碼區塊塞進段落裡
    text = text.replace(/\$\$(?:(?!\u0000B)[\s\S])+?\$\$/g, m => holdInline(m));
    text = text.replace(/\\\[(?:(?!\u0000B)[\s\S])+?\\\]/g, m => holdInline(m));
    text = text.replace(/\\\([^\n]+?\\\)/g, m => holdInline(m));
    text = text.replace(/\$[^$\n]+?\$/g, m => holdInline(m));
    // 行內程式碼
    text = text.replace(/`([^`\n]+)`/g, (m, code) => holdInline(`<code>${code}</code>`));
    // 粗體
    text = text.replace(/\*\*([^\n]+?)\*\*/g, (m, inner) => `<strong>${inner}</strong>`);

    const html = [];
    for (const block of text.split(/\n{2,}/)) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        if (/^\u0000B\d+\u0000$/.test(trimmed)) { html.push(trimmed); continue; }
        html.push(renderBlock(trimmed));
    }

    // 佔位符換回。slot i 只可能包含編號比它小的佔位符（內層先被收走），不會成環，最多 slots.length 輪就換完；
    // 每個 slot 都是「已 escape 的字串＋固定標籤」，巢狀換回不會引入新的 HTML。
    let out = html.join('\n');
    for (let round = 0; round <= slots.length && /\u0000[BI]\d+\u0000/.test(out); round++) {
        out = out.replace(/\u0000[BI](\d+)\u0000/g, (m, i) => slots[Number(i)] ?? '');
    }
    return out;
}

/** 一個區塊（不含空行）→ 段落、清單、標題的組合；段落內換行轉 <br>。 */
function renderBlock(block) {
    const out = [];
    let para = [];
    let list = null;                    // { ordered, start, items: [] }
    const flushPara = () => {
        if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
        para = [];
    };
    const flushList = () => {
        if (!list) return;
        const items = list.items.map(i => `<li>${i}</li>`).join('');
        out.push(list.ordered
            ? `<ol${list.start !== 1 ? ` start="${list.start}"` : ''}>${items}</ol>`
            : `<ul>${items}</ul>`);
        list = null;
    };
    for (const line of block.split('\n')) {
        const li = line.match(LIST_RE);
        if (li) {
            flushPara();
            const ordered = li[2] !== undefined;
            if (!list || list.ordered !== ordered) {
                flushList();
                list = { ordered, start: ordered ? Number(li[2]) : 1, items: [] };
            }
            list.items.push(li[3]);
            continue;
        }
        const h = line.match(HEADING_RE);
        if (h) {
            flushPara(); flushList();
            out.push(`<p><strong>${h[1]}</strong></p>`);
            continue;
        }
        if (list && /^\s{2,}\S/.test(line)) {       // 清單項目的續行
            list.items[list.items.length - 1] += `<br>${line.trim()}`;
            continue;
        }
        flushList();
        if (line.trim()) para.push(line.trim());
    }
    flushPara(); flushList();
    return out.join('\n');
}

/**
 * 麥克風能不能用（第 4.5 條第 4 點：只在 localhost 或 HTTPS；本階段限桌機）。
 * @param {{secureContext:boolean, hasGetUserMedia:boolean, hasMediaRecorder:boolean, desktop:boolean}} env
 * @returns {{ok:boolean, reason:string}}
 */
export function micAvailability({ secureContext, hasGetUserMedia, hasMediaRecorder, desktop }) {
    if (!secureContext) {
        return { ok: false, reason: '按住說話只能在 localhost 或 HTTPS 網址下使用（瀏覽器只在安全連線開放麥克風），目前的網址不符合，所以隱藏了按鈕。' };
    }
    if (!hasGetUserMedia || !hasMediaRecorder) {
        return { ok: false, reason: '這個瀏覽器不支援錄音（getUserMedia／MediaRecorder），請改用新版 Chrome、Edge 或 Firefox。' };
    }
    if (!desktop) {
        return { ok: false, reason: '按住說話本階段只支援桌機（手機與平板之後再開放）。' };
    }
    return { ok: true, reason: '' };
}

/**
 * 挑 MediaRecorder 支援、而且後端收的格式（第 4.5 條的五種 mime）。
 * @param {(mime:string) => boolean} isTypeSupported
 * @returns {string} 都不支援時回 ''（交給瀏覽器預設）
 */
export function pickRecorderMime(isTypeSupported) {
    for (const m of RECORDER_MIMES) {
        try { if (isTypeSupported(m)) return m; } catch { /* 某些瀏覽器對未知字串丟錯 */ }
    }
    return '';
}

/** 'audio/webm;codecs=opus' → 'webm'（上傳檔名用；後端只看 mime） */
export function extensionFor(mime) {
    const base = String(mime || '').split(';')[0].trim().toLowerCase();
    return { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }[base] || 'webm';
}

/**
 * 歧義 chip：把逐字稿裡目前的那一段公式換成老師點選的那一個（只換第一處）。
 * 先找 `$from$`，找不到再找裸的 from；兩者都沒有就原樣回傳（replaced=false，由 UI 提示老師手動改）。
 * @returns {{text:string, replaced:boolean}}
 */
export function replaceMathChoice(text, from, to) {
    const src = String(text ?? '');
    for (const needle of [`$${from}$`, String(from)]) {
        if (!needle || needle === '$$') continue;
        const i = src.indexOf(needle);
        if (i >= 0) {
            const repl = needle.startsWith('$') ? `$${to}$` : String(to);
            return { text: src.slice(0, i) + repl + src.slice(i + needle.length), replaced: true };
        }
    }
    return { text: src, replaced: false };
}

/**
 * 題目 ID 欄位的解讀：空白 → null；1–2147483647 的整數 → 數字；其他 → NaN（UI 擋下並提示）。
 */
export function parseQuestionId(value) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return /^\d+$/.test(s) && Number(s) > 0 && Number(s) <= INT4_MAX ? Number(s) : NaN;
}

/**
 * 組 POST /api/tutor 的 body：可選欄位沒有值就不送；歷史只送最近 8 輪、每輪截到 4000 字。
 */
export function buildRequestBody({ message, mode, subject, studentId, questionId, history }) {
    const body = { message: String(message ?? '').trim(), mode };
    if (subject) body.subject = subject;
    if (Number.isInteger(studentId) && studentId > 0) body.student_id = studentId;
    if (Number.isInteger(questionId) && questionId > 0) body.question_id = questionId;
    const turns = (history || []).slice(-HISTORY_KEEP).map(t => ({
        role: t.role === 'tutor' ? 'tutor' : 'user',
        text: String(t.text ?? '').slice(0, HISTORY_TEXT_MAX)
    })).filter(t => t.text.trim());
    if (turns.length) body.history = turns;
    return body;
}

/** code execution 的 outcome → 中文 */
export function outcomeLabel(outcome) {
    return {
        OUTCOME_OK: '執行成功',
        OUTCOME_FAILED: '執行失敗',
        OUTCOME_DEADLINE_EXCEEDED: '執行逾時'
    }[outcome] || '沒有回報結果';
}

/** 0.01234 → 'US$0.0123'；非數字 → '—' */
export function formatUsd(n) {
    const v = Number(n);
    return Number.isFinite(v) ? `US$${v.toFixed(4)}` : '—';
}

// ───────────────────────── 環境與橋接 ─────────────────────────

function featureOn(name) {
    const meta = document.querySelector(`meta[name="feature-${name}"]`);
    return parseBool(meta ? meta.content : '');
}

function bridge() {
    const app = window.ExamApp;
    const needed = ['apiFetch', 'showToast', 'renderMath'];
    if (!app) {
        console.error('[tutor] window.ExamApp 不存在：index.html 的 inline script 需要把既有函式掛上來。');
        return null;
    }
    const missing = needed.filter(k => typeof app[k] !== 'function');
    if (missing.length) {
        console.error(`[tutor] window.ExamApp 缺少：${missing.join('、')}。AI 家教分頁不會掛載。`);
        return null;
    }
    return app;
}

/** 讀瀏覽器環境交給 micAvailability（有精準指標＝桌機；matchMedia 不存在時不擋） */
function detectMic() {
    const w = typeof window !== 'undefined' ? window : {};
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    let desktop = true;
    if (typeof w.matchMedia === 'function') {
        try { desktop = w.matchMedia('(any-pointer: fine)').matches; } catch { desktop = true; }
    }
    return micAvailability({
        secureContext: w.isSecureContext === true,
        hasGetUserMedia: !!(nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function'),
        hasMediaRecorder: typeof MediaRecorder !== 'undefined',
        desktop
    });
}

/** 建元素的小工具（與 assistant.js 的 el 同款）。 */
function el(tag, className = '', attrs = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'textContent') node.textContent = v;
        else node.setAttribute(k, v);
    }
    return node;
}

async function readJson(res) {
    try { return await res.json(); } catch { return {}; }
}

// ───────────────────────── 狀態 ─────────────────────────

/** 對話狀態只活在頁面裡；重整就歸零（家教沒有長期記憶，這是誠實的呈現）。 */
const state = {
    mode: 'direct',
    history: [],
    busy: false,
    rec: null            // { stream, recorder, chunks, startedAt, timer, stopRequested }
};

// ───────────────────────── 渲染：訊息 ─────────────────────────

const BUBBLE_USER = 'max-w-[85%] rounded-2xl rounded-br-sm bg-teal-600 px-4 py-2.5 text-sm text-white whitespace-pre-line';
const BUBBLE_TUTOR = 'max-w-[92%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-700';
// Markdown 的樣式用 Tailwind 的任意變體掛在外層，轉換器本身不產生任何 class 屬性
const MD_CLASS = '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 '
    + '[&_li]:my-0.5 [&_strong]:font-extrabold [&_strong]:text-slate-900 '
    + '[&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:text-[12px] '
    + '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-900 [&_pre]:p-3 [&_pre]:text-slate-100 '
    + '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-slate-100';

function userBubble(text) {
    const row = el('div', 'flex justify-end');
    row.appendChild(el('div', BUBBLE_USER, { textContent: text }));
    return row;
}

function noticeBubble(text) {
    const row = el('div', 'flex justify-start');
    row.appendChild(el('div', 'max-w-[85%] rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800', { textContent: text }));
    return row;
}

/** 「計算驗證」：程式碼與輸出一律 textContent（第 4.5 條第 4 點） */
function verificationBlock(verification) {
    const runs = (verification && Array.isArray(verification.runs)) ? verification.runs : [];
    if (!verification || !verification.used || runs.length === 0) {
        return el('p', 'mt-1.5 text-[11px] font-bold text-amber-600', {
            textContent: '⚠ 這則回覆沒有執行程式驗算，數值請自行核對。'
        });
    }
    const wrap = el('details', 'mt-1.5 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2');
    const failed = runs.filter(r => r.outcome !== 'OUTCOME_OK').length;
    wrap.appendChild(el('summary', 'cursor-pointer text-[11px] font-bold text-emerald-700', {
        textContent: `計算驗證：執行了 ${runs.length} 段程式${failed ? `（${failed} 段未成功）` : ''}，點開看程式與輸出`
    }));
    runs.forEach((r, i) => {
        const box = el('div', 'mt-2');
        box.appendChild(el('p', `text-[11px] font-bold ${r.outcome === 'OUTCOME_OK' ? 'text-slate-600' : 'text-rose-600'}`, {
            textContent: `第 ${i + 1} 段（${outcomeLabel(r.outcome)}）`
        }));
        box.appendChild(el('pre', 'mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100', {
            textContent: String(r.code ?? '')
        }));
        const out = String(r.output ?? '');
        box.appendChild(el('pre', 'mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-white p-2 text-[11px] text-slate-600', {
            textContent: out ? `輸出：\n${out}` : '（沒有輸出）'
        }));
        wrap.appendChild(box);
    });
    return wrap;
}

/** 這次回覆用了哪些脈絡（讓老師知道 AI 看到了什麼） */
function contextLine(context) {
    const c = context || {};
    const parts = [];
    if (c.question_id) parts.push(`題目 #${c.question_id}`);
    if (Array.isArray(c.kc_codes) && c.kc_codes.length) parts.push(`知識點 ${c.kc_codes.join('、')}`);
    parts.push(c.student_context ? '已帶入學生弱點摘要（代號化）' : '沒有帶入學生資料');
    return `依據：${parts.join('｜')}`;
}

function tutorReply(app, body) {
    const row = el('div', 'flex flex-col items-start');
    const bubble = el('div', `${BUBBLE_TUTOR} ${MD_CLASS}`);
    // 唯一的 innerHTML：renderMarkdown 先整段 escape 再加固定標籤（見函式註解與單元測試）
    bubble.innerHTML = renderMarkdown(body.reply);
    row.appendChild(bubble);
    app.renderMath(bubble);

    const meta = el('div', 'mt-1 ml-1 w-full max-w-[92%]');
    meta.appendChild(verificationBlock(body.verification));
    meta.appendChild(el('p', 'mt-1 text-[11px] text-slate-400', { textContent: contextLine(body.context) }));
    const usage = body.usage || {};
    meta.appendChild(el('p', 'mt-0.5 text-[11px] font-bold text-slate-400', {
        textContent: `AI 產生，請自行判斷。　本次約 ${formatUsd(usage.costUsd)}`
    }));
    row.appendChild(meta);
    return row;
}

// ───────────────────────── 送出 ─────────────────────────

function readSettings(ui) {
    const studentId = Number(ui.student.value);
    return {
        mode: state.mode,
        subject: ui.subject.value || null,
        studentId: Number.isInteger(studentId) && studentId > 0 ? studentId : null,
        questionId: parseQuestionId(ui.questionId.value)
    };
}

async function sendMessage(app, ui, text) {
    const message = String(text ?? '').trim();
    if (!message) return false;
    if (message.length > MAX_MESSAGE) { app.showToast(`一次最多 ${MAX_MESSAGE} 字（目前 ${message.length} 字）。`, 'error'); return false; }
    if (state.busy) { app.showToast('上一則還在等家教回覆，回覆之後再送出。', 'info'); return false; }
    const settings = readSettings(ui);
    if (Number.isNaN(settings.questionId)) { app.showToast('題目 ID 要是正整數（或留空）。', 'error'); return false; }

    state.busy = true;
    ui.send.disabled = true;
    ui.log.appendChild(userBubble(message));
    const thinking = el('p', 'ml-1 text-[11px] text-slate-400', {
        textContent: state.mode === 'socratic' ? '家教正在想下一步要怎麼引導…' : '家教正在解題並用程式驗算（可能需要十幾秒）…'
    });
    ui.log.appendChild(thinking);
    ui.log.scrollTop = ui.log.scrollHeight;

    const body = buildRequestBody({ message, ...settings, history: state.history });
    try {
        const res = await app.apiFetch('/api/tutor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await readJson(res);
        thinking.remove();
        if (!res.ok) {
            ui.log.appendChild(noticeBubble(`⚠ ${data.message || `AI 家教暫時無法回應（${res.status}）`}`));
            return false;
        }
        ui.log.appendChild(tutorReply(app, data));
        state.history.push({ role: 'user', text: message }, { role: 'tutor', text: String(data.reply ?? '').slice(0, HISTORY_TEXT_MAX) });
        state.history = state.history.slice(-HISTORY_KEEP);
        return true;
    } catch {
        thinking.remove();
        ui.log.appendChild(noticeBubble('⚠ 連線失敗，請稍後再試。'));
        return false;
    } finally {
        state.busy = false;
        ui.send.disabled = false;
        ui.log.scrollTop = ui.log.scrollHeight;
    }
}

// ───────────────────────── 語音：錄音、上傳、確認 ─────────────────────────

function setRecordingUi(ui, on, label) {
    ui.mic.textContent = label || (on ? '● 錄音中…放開結束' : '🎙 按住說話');
    ui.mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.mic.className = on ? MIC_CLASS_ON : MIC_CLASS_OFF;
}

async function startRecording(app, ui) {
    if (state.rec || state.busy) return;
    const rec = { stream: null, recorder: null, chunks: [], startedAt: Date.now(), timer: null, stopRequested: false };
    state.rec = rec;
    setRecordingUi(ui, true, '…取得麥克風中');
    try {
        rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        state.rec = null;
        setRecordingUi(ui, false);
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        app.showToast(denied ? '麥克風權限被拒絕：請在網址列左側的網站設定允許麥克風。' : `無法使用麥克風：${err && err.message ? err.message : err}`, 'error');
        return;
    }
    if (rec.stopRequested) {                 // 取得權限的對話框期間就放開了：當作沒錄
        rec.stream.getTracks().forEach(t => t.stop());
        state.rec = null;
        setRecordingUi(ui, false);
        app.showToast('按住按鈕說話，說完再放開。', 'info');
        return;
    }
    const mime = pickRecorderMime(t => MediaRecorder.isTypeSupported(t));
    rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
    rec.recorder.addEventListener('dataavailable', e => { if (e.data && e.data.size) rec.chunks.push(e.data); });
    rec.recorder.addEventListener('stop', () => finishRecording(app, ui, rec, mime));
    rec.startedAt = Date.now();
    rec.recorder.start();
    setRecordingUi(ui, true);
    rec.timer = setTimeout(() => stopRecording(), MAX_RECORD_MS);
}

function stopRecording() {
    const rec = state.rec;
    if (!rec) return;
    rec.stopRequested = true;
    if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.stop();
}

async function finishRecording(app, ui, rec, mime) {
    clearTimeout(rec.timer);
    rec.stream.getTracks().forEach(t => t.stop());
    state.rec = null;
    setRecordingUi(ui, false);

    const type = (rec.recorder && rec.recorder.mimeType) || mime || 'audio/webm';
    const blob = new Blob(rec.chunks, { type });
    rec.chunks = [];
    if (Date.now() - rec.startedAt < MIN_RECORD_MS || blob.size === 0) {
        app.showToast('錄音太短了：按住按鈕說話，說完再放開。', 'info');
        return;
    }

    ui.micNote.textContent = '轉寫中…';
    const form = new FormData();
    form.append('audio', blob, `speech.${extensionFor(type)}`);
    if (ui.subject.value) form.append('subject', ui.subject.value);
    try {
        const res = await app.apiFetch('/api/voice/transcribe', { method: 'POST', body: form });
        const data = await readJson(res);
        if (!res.ok) {
            app.showToast(data.message || `語音轉寫失敗（${res.status}）`, 'error');
            return;
        }
        if (!String(data.text || '').trim()) {
            app.showToast('沒有聽到內容，請再錄一次。', 'info');
            return;
        }
        openReview(app, ui, data);
    } catch {
        app.showToast('連線失敗，語音沒有送出。', 'error');
    } finally {
        ui.micNote.textContent = '';
    }
}

/** 顯示可編輯的逐字稿、公式預覽與歧義 chip；老師按「確認送出」才送給家教 */
function openReview(app, ui, data) {
    const r = ui.review;
    r.panel.classList.remove('hidden');
    r.text.value = String(data.text || '');
    refreshPreview(app, r.text, r.preview);

    r.chips.innerHTML = '';
    const ambiguities = Array.isArray(data.ambiguities) ? data.ambiguities : [];
    r.chipsBox.classList.toggle('hidden', ambiguities.length === 0);
    for (const amb of ambiguities) {
        const group = el('div', 'flex flex-wrap items-center gap-1.5');
        group.appendChild(el('span', 'text-xs font-bold text-slate-500', { textContent: `「${amb.spoken}」是指：` }));
        let current = amb.options[0];
        const buttons = [];
        for (const opt of amb.options) {
            const b = el('button', CHIP_CLASS, { type: 'button', textContent: `$${opt}$` });
            b.setAttribute('aria-pressed', opt === current ? 'true' : 'false');
            b.addEventListener('click', () => {
                if (opt === current) return;
                const out = replaceMathChoice(r.text.value, current, opt);
                if (!out.replaced) {
                    app.showToast('逐字稿裡找不到這段公式（可能已經改過），請直接在上面的文字框修改。', 'info');
                    return;
                }
                r.text.value = out.text;
                current = opt;
                for (const x of buttons) x.btn.setAttribute('aria-pressed', x.opt === current ? 'true' : 'false');
                refreshPreview(app, r.text, r.preview);
            });
            buttons.push({ btn: b, opt });
            group.appendChild(b);
        }
        r.chips.appendChild(group);
        app.renderMath(group);
    }

    r.segments.innerHTML = '';
    const segs = Array.isArray(data.math_segments) ? data.math_segments : [];
    r.segmentsBox.classList.toggle('hidden', segs.length === 0);
    for (const s of segs) {
        const li = el('li', 'text-xs text-slate-600');
        li.appendChild(el('span', 'text-slate-400', { textContent: `「${s.spoken}」→ ` }));
        li.appendChild(el('span', '', { textContent: `$${s.latex}$` }));
        r.segments.appendChild(li);
    }
    app.renderMath(r.segments);
    r.text.focus?.();
}

function closeReview(ui) {
    ui.review.panel.classList.add('hidden');
    ui.review.text.value = '';
}

// ───────────────────────── 輸入框的 LaTeX 即時預覽 ─────────────────────────

function refreshPreview(app, input, preview) {
    const v = String(input.value || '');
    const hasMath = /\$|\\\(|\\\[/.test(v);
    preview.classList.toggle('hidden', !hasMath);
    if (!hasMath) { preview.textContent = ''; return; }
    preview.textContent = v;
    app.renderMath(preview);
}

// ───────────────────────── 版面 ─────────────────────────

const MODE_BTN_ON = 'rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-extrabold text-white cursor-pointer';
const MODE_BTN_OFF = 'rounded-lg px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 cursor-pointer';
const MIC_CLASS_OFF = 'shrink-0 select-none rounded-xl border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm font-extrabold text-teal-700 transition-colors hover:bg-teal-100 cursor-pointer';
const MIC_CLASS_ON = 'shrink-0 select-none rounded-xl border border-rose-300 bg-rose-500 px-4 py-2.5 text-sm font-extrabold text-white animate-pulse cursor-pointer';
const CHIP_CLASS = 'rounded-full border border-slate-200 bg-white px-3 py-1 text-sm hover:border-teal-400 aria-pressed:border-teal-500 aria-pressed:bg-teal-50 cursor-pointer';

function labeled(text, control) {
    const wrap = el('label', 'flex flex-col gap-1 text-xs font-bold text-slate-500');
    wrap.appendChild(el('span', '', { textContent: text }));
    wrap.appendChild(control);
    return wrap;
}

function buildSettings(ui) {
    const row = el('div', 'grid grid-cols-1 gap-3 sm:grid-cols-4');

    const modeBox = el('div', 'flex flex-col gap-1 text-xs font-bold text-slate-500');
    modeBox.appendChild(el('span', '', { textContent: '講解方式' }));
    const seg = el('div', 'flex gap-1 rounded-xl border border-slate-200 bg-white p-1', { role: 'group', 'aria-label': '講解方式' });
    const modes = [['direct', '直接講解'], ['socratic', '引導式']];
    ui.modeButtons = modes.map(([mode, label]) => {
        const b = el('button', mode === state.mode ? MODE_BTN_ON : MODE_BTN_OFF, {
            type: 'button', textContent: label, 'data-mode': mode, 'aria-pressed': mode === state.mode ? 'true' : 'false',
            title: mode === 'direct' ? '完整講解並給出答案' : '一次只給一步，學生試過才給答案'
        });
        b.addEventListener('click', () => {
            state.mode = mode;
            for (const x of ui.modeButtons) {
                const on = x.getAttribute('data-mode') === mode;
                x.className = on ? MODE_BTN_ON : MODE_BTN_OFF;
                x.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        });
        seg.appendChild(b);
        return b;
    });
    modeBox.appendChild(seg);

    ui.subject = el('select', 'field-control block w-full p-2 text-sm', { id: 'tutorSubject', 'aria-label': '科目' });
    ui.subject.appendChild(el('option', '', { value: '', textContent: '（不指定）' }));
    ui.student = el('select', 'field-control block w-full p-2 text-sm', { id: 'tutorStudent', 'aria-label': '學生' });
    ui.student.appendChild(el('option', '', { value: '', textContent: '（不指定）' }));
    ui.questionId = el('input', 'field-control block w-full p-2 text-sm', {
        id: 'tutorQuestionId', type: 'text', inputmode: 'numeric', placeholder: '例如 12（留空＝不指定）', 'aria-label': '題目 ID'
    });

    row.append(modeBox, labeled('科目', ui.subject), labeled('學生（弱點會代號化後帶入）', ui.student), labeled('題目 ID', ui.questionId));
    return row;
}

function buildReviewPanel(ui) {
    const panel = el('div', 'mt-3 hidden rounded-2xl border border-teal-200 bg-teal-50/40 p-4', { id: 'tutorVoiceReview' });
    panel.appendChild(el('p', 'text-sm font-extrabold text-teal-800', { textContent: '語音逐字稿（可以修改；按「確認送出」才會送給家教）' }));
    const text = el('textarea', 'field-control mt-2 block w-full p-3 text-sm', {
        id: 'tutorVoiceText', rows: '3', maxlength: String(MAX_MESSAGE), 'aria-label': '語音逐字稿'
    });
    const preview = el('div', 'mt-2 hidden rounded-xl border border-slate-100 bg-white p-3 text-sm text-slate-700', { 'aria-live': 'polite' });
    const chipsBox = el('div', 'mt-3 hidden');
    chipsBox.appendChild(el('p', 'mb-1 text-xs font-bold text-amber-700', { textContent: '有幾段公式聽起來有兩種寫法，請點選正確的那一個：' }));
    const chips = el('div', 'space-y-1.5');
    chipsBox.appendChild(chips);
    const segmentsBox = el('div', 'mt-3 hidden');
    segmentsBox.appendChild(el('p', 'mb-1 text-xs font-bold text-slate-500', { textContent: '辨識出的公式：' }));
    const segments = el('ul', 'space-y-0.5');
    segmentsBox.appendChild(segments);

    const actions = el('div', 'mt-3 flex gap-2');
    const confirm = el('button', 'rounded-xl bg-teal-600 px-4 py-2 text-sm font-extrabold text-white hover:bg-teal-700 disabled:opacity-40 cursor-pointer', {
        type: 'button', id: 'tutorVoiceConfirm', textContent: '確認送出'
    });
    const cancel = el('button', 'rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 cursor-pointer', {
        type: 'button', id: 'tutorVoiceCancel', textContent: '取消'
    });
    actions.append(confirm, cancel);

    panel.append(text, preview, chipsBox, segmentsBox, actions);
    ui.review = { panel, text, preview, chips, chipsBox, segments, segmentsBox, confirm, cancel };
    return panel;
}

function mountTutorSection(app, section, { voice }) {
    section.className = 'manager-shell mt-7 rounded-[1.65rem] p-5 sm:p-7 scroll-mt-24';
    section.innerHTML = '';

    const head = el('div', 'mb-5 flex items-start gap-3 border-b border-slate-100 pb-5');
    const titleBox = el('div');
    titleBox.append(
        el('p', 'eyebrow text-teal-600', { textContent: 'AI Tutor' }),
        el('h2', 'mt-1 text-xl font-extrabold tracking-tight text-slate-900', { textContent: 'AI 家教' }),
        el('p', 'mt-1 text-xs sm:text-sm text-slate-500', {
            textContent: '問高中數學、物理、化學的題目或觀念。填了題目 ID 會帶入題幹、答案與詳解；選了學生會帶入他的弱點（姓名不送出）。數值與代數結果由程式驗算，但仍請自行判斷。'
        })
    );
    head.append(el('span', 'section-icon bg-teal-50 text-teal-700', { textContent: '教' }), titleBox);

    const ui = {};
    const settings = buildSettings(ui);

    ui.log = el('div', 'mt-4 space-y-3 max-h-[32rem] overflow-y-auto rounded-2xl border border-slate-100 bg-slate-50/50 p-4', {
        id: 'tutorLog', 'aria-live': 'polite'
    });
    ui.log.appendChild(el('p', 'text-center text-xs text-slate-400', {
        textContent: '「直接講解」會完整解題；「引導式」一次只給一步，讓學生自己先試。'
    }));

    ui.input = el('textarea', 'field-control block w-full p-3 text-sm', {
        id: 'tutorInput', rows: '3', maxlength: String(MAX_MESSAGE),
        placeholder: '例如：已知 $\\vec a=(1,2)$、$\\vec b=(3,4)$，怎麼求 $\\vec a\\cdot\\vec b$？（Ctrl＋Enter 送出）',
        'aria-label': '問 AI 家教'
    });
    ui.preview = el('div', 'mt-2 hidden rounded-xl border border-slate-100 bg-white p-3 text-sm text-slate-700', {
        id: 'tutorPreview', 'aria-live': 'polite'
    });
    ui.counter = el('span', 'text-[11px] text-slate-400', { textContent: `0／${MAX_MESSAGE}` });

    const actions = el('div', 'mt-2 flex flex-wrap items-center gap-2');
    ui.mic = el('button', MIC_CLASS_OFF, { id: 'tutorMic', type: 'button', 'aria-pressed': 'false', textContent: '🎙 按住說話' });
    ui.micNote = el('p', 'text-[11px] text-slate-400', { id: 'tutorMicNote' });
    ui.clear = el('button', 'rounded-xl px-3 py-2 text-xs font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer', {
        type: 'button', textContent: '清除對話'
    });
    ui.send = el('button', 'ml-auto shrink-0 rounded-xl bg-teal-600 px-5 py-2.5 font-extrabold text-white transition-colors hover:bg-teal-700 disabled:opacity-40 cursor-pointer', {
        id: 'tutorSend', type: 'button', textContent: '送出'
    });
    if (voice) actions.append(ui.mic, ui.micNote);
    actions.append(ui.clear, ui.counter, ui.send);

    section.append(head, settings, ui.log, el('div', 'mt-4'), ui.input, ui.preview, actions);
    if (voice) section.appendChild(buildReviewPanel(ui));

    // ── 事件 ──
    let previewTimer = null;
    ui.input.addEventListener('input', () => {
        ui.counter.textContent = `${String(ui.input.value || '').length}／${MAX_MESSAGE}`;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => refreshPreview(app, ui.input, ui.preview), 250);
    });
    const submit = async () => {
        const ok = await sendMessage(app, ui, ui.input.value);
        if (ok) {
            ui.input.value = '';
            ui.counter.textContent = `0／${MAX_MESSAGE}`;
            refreshPreview(app, ui.input, ui.preview);
        }
    };
    ui.send.addEventListener('click', submit);
    ui.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault?.(); submit(); }
    });
    ui.clear.addEventListener('click', () => {
        state.history = [];
        while (ui.log.children.length > 1) ui.log.children[ui.log.children.length - 1].remove();
        app.showToast('已清除對話（家教不會記得之前說過的內容）。', 'info');
    });

    if (voice) mountVoice(app, ui);
    return ui;
}

/** 按住說話：可用就綁事件；不可用就隱藏按鈕並說明原因 */
function mountVoice(app, ui) {
    const mic = detectMic();
    if (!mic.ok) {
        ui.mic.classList.add('hidden');
        ui.mic.setAttribute('aria-hidden', 'true');
        ui.micNote.textContent = mic.reason;
        ui.micNote.className = 'text-[11px] font-bold text-amber-600';
        return;
    }
    ui.micNote.textContent = '按住說話，放開後會先讓你確認逐字稿。';
    const down = (e) => { e.preventDefault?.(); startRecording(app, ui); };
    const up = () => stopRecording();
    ui.mic.addEventListener('pointerdown', down);
    ui.mic.addEventListener('pointerup', up);
    ui.mic.addEventListener('pointerleave', up);
    ui.mic.addEventListener('pointercancel', up);
    ui.mic.addEventListener('contextmenu', e => e.preventDefault?.());
    ui.mic.addEventListener('keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault?.(); startRecording(app, ui); }
    });
    ui.mic.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopRecording(); });

    const r = ui.review;
    r.text.addEventListener('input', () => refreshPreview(app, r.text, r.preview));
    r.cancel.addEventListener('click', () => closeReview(ui));
    // 送出成功才收起面板、清掉逐字稿：上一則還在等回覆（busy）、題目 ID 不合法、伺服器回錯或連線失敗時，
    // 老師確認過的逐字稿都要留著，按一次就能重送——不然只能重錄，又要再花一次語音費用。
    r.confirm.addEventListener('click', async () => {
        const text = String(r.text.value || '').trim();
        if (!text) return app.showToast('逐字稿是空的。', 'error');
        if (r.confirm.disabled) return;
        r.confirm.disabled = true;
        try {
            const ok = await sendMessage(app, ui, text);
            if (ok) closeReview(ui);
        } finally {
            r.confirm.disabled = false;
        }
    });
}

// ───────────────────────── 下拉資料 ─────────────────────────

async function loadSubjects(app, select) {
    let subjects = [];
    try {
        const res = await app.apiFetch('/api/chapter-whitelist');
        if (res.ok) subjects = Object.keys(await res.json());
    } catch { /* 退回橋接 */ }
    if (subjects.length === 0 && typeof app.getChapterWhitelist === 'function') {
        subjects = Object.keys(app.getChapterWhitelist() || {});
    }
    for (const s of subjects) select.appendChild(el('option', '', { value: s, textContent: s }));
}

async function loadStudents(app, select) {
    try {
        const res = await app.apiFetch('/api/students');
        if (!res.ok) return;
        const body = await res.json();
        for (const s of (body.items || [])) {
            select.appendChild(el('option', '', { value: String(s.id), textContent: s.name }));
        }
    } catch { /* 學生清單拿不到就只剩「不指定」，家教照樣能用 */ }
}

// ───────────────────────── 進入點 ─────────────────────────

/** 掛載。FEATURE_TUTOR 關閉時**整段不渲染**；FEATURE_VOICE 另外決定要不要有按住說話。 */
export async function init() {
    const section = document.getElementById('tutor');
    if (!section) return;
    if (!featureOn('tutor')) {
        console.info('[tutor] FEATURE_TUTOR 未開啟：AI 家教分頁不渲染。');
        return;
    }
    const app = bridge();
    if (!app) return;
    const ui = mountTutorSection(app, section, { voice: featureOn('voice') });
    await Promise.all([loadSubjects(app, ui.subject), loadStudents(app, ui.student)]);
    return ui;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
