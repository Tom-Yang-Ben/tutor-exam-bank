// utils/extractLatexRepair.js — 本機拆題（extract_ocr／extract_vision）輸出的 LaTeX 確定性修復（docs/local-mode.md 10.25 第 3 點）
//
// 〔Owner 2026-10-02 同意「本機的這些修改都先做了」，dec/r13-extract-fixes〕114-2 興大附中高二期末考數學 A 的交叉驗證裡，
// qwen3:8b 拆題時矩陣與聯立方程組幾乎每題壞（Ben 的 Project 文件 crosscheck-114-2-math-A.md 第 3 節）。
// 壞法很固定，用規則就修得好，不必等 lint 的 LLM 重寫（那一步在 CPU 上一次 5～20 分鐘，而且大多修不好）：
//
//   end_newline       「換行＋end{bmatrix}」→「\end{bmatrix}」。模型在 JSON 裡要寫 \\end，Ollama 的 JSON 文法只允許
//                     \b \f \n \r \t \u \" \\ \/，模型被迫把 \e 寫成 \n，解析後就是換行＋end。services/llm/latexEscapeRepair.js
//                     的規則 B 刻意不修換行（換行後接指令名比較可能是真的換行），這裡只修「後面緊接 end{已知環境}」這一種，不會誤傷。
//                     〔審查〕換行前是一或兩個反斜線（「3 & 4 \⏎end{bmatrix}」，換列的 \\ 只剩一半）→「\\ \end{bmatrix}」。
//   cases_right       \begin{cases} 用 \right. 收尾（沒有 \end{cases}）→ 換成 \end{cases}；前面若有配對用的 \left\{ 一併拿掉。
//   row_break         矩陣／方程組／array 環境裡，換列的 \\ 只剩一個反斜線（後面接空白）→ 補回 \\。只在這些環境裡修
//                     （環境外的「\ 」是 LaTeX 的控制空白）。
//   degree_circled    \textcircled{\circ}（度數被寫成圈圈）→ ^\circ（前面已經有 ^ 就不再加）。
//   blank_boxes       連續兩個以上的 \textcircled{…}（選填題的填答格 ⑨⑩⑪ 被寫成 \textcircled{m}\textcircled{q}…）→「＿＿＿＿」。
//                     只在單選／多選以外的題型修：單選、多選的選項常寫成「(A) ①②」，那是敘述代號的組合，不是填答格。
//   leading_superscript $^{a,b}$（整段公式只有一個沒有底數的上標，內容是逗號隔開的單一字母）→ $a,b$。
//                     前面緊接英數或右括號時不修（10$^{2}$、x$^{a,b}$ 那是真的上標）。
//
// 每一條規則只在「確定」時修；修了什麼記在 repairs（{field, rule, count}），拆題把它寫進 payload.extract.latex_repairs，
// 複核時查得到。冪等：修過的再修一次一個字都不變。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

/** 會換列（\\）的環境 */
const ENVS = ['bmatrix', 'pmatrix', 'vmatrix', 'Vmatrix', 'Bmatrix', 'matrix', 'smallmatrix', 'cases', 'array', 'aligned', 'align', 'gathered', 'split'];
const ENV_ALT = ENVS.join('|');

const END_NEWLINE_RE = new RegExp(`(?<!\\\\)\\r?\\n[ \\t]*end\\{(${ENV_ALT})\\}`, 'g');
/**
 * 〔審查 dec/r13-extract-fixes〕同一種壞法的變體：換行前面是一或兩個反斜線（「3 & 4 \⏎end{bmatrix}」）。
 * 模型在 JSON 裡寫的是「4 \\ \end」——前面的 \\ 被 JSON 解成一個反斜線（換列只剩一半），\e 被文法逼成 \n。
 * 修成「\\ \end{env}」：最後一列後面的換列 KaTeX 不會多畫一列（已實測），所以補回 \\ 不改變版面。
 * 前面有三個以上反斜線的不修（分不出原意）。
 */
const END_NEWLINE_BS_RE = new RegExp(`(?<!\\\\)\\\\{1,2}[ \\t]*\\r?\\n[ \\t]*end\\{(${ENV_ALT})\\}`, 'g');
const ENV_BODY_RE = new RegExp(`\\\\begin\\{(${ENV_ALT})\\}(\\{[^{}]*\\})?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'g');
/** 環境內單一個反斜線後面接空白（不是 \\ 的一半） */
const LONE_BACKSLASH_RE = /(?<!\\)\\(?=[ \t]*(?:\r?\n|[ \t]))(?!\\)/g;

const DEGREE_BRACED_RE = /\^\s*\{\s*\\textcircled\s*\{\s*\\circ\s*\}\s*\}/g;
const DEGREE_CARET_RE = /\^\s*\\textcircled\s*\{\s*\\circ\s*\}/g;
const DEGREE_BARE_RE = /\\textcircled\s*\{\s*\\circ\s*\}/g;
const BLANK_RUN_RE = /\\textcircled\s*\{[^{}]*\}(?:\s*\\textcircled\s*\{[^{}]*\})+/g;
const LEADING_SUP_RE = /(^|[^A-Za-z0-9)\]}$])\$\s*\^\s*\{\s*([A-Za-z](?:\s*,\s*[A-Za-z])+)\s*\}\s*\$/g;

const BLANK = '＿＿＿＿';
const CHOICE_TYPES = new Set(['單選', '多選']);

function countMatches(text, re) {
    return (String(text).match(re) || []).length;
}

/** \begin{cases} … \right.（中間沒有 \end{cases}）→ \end{cases}；配對的 \left\{ 拿掉 */
function fixCasesRight(text) {
    let s = text;
    let count = 0;
    let from = 0;
    for (let guard = 0; guard < 50; guard++) {
        const begin = s.indexOf('\\begin{cases}', from);
        if (begin < 0) break;
        const afterBegin = begin + '\\begin{cases}'.length;
        const end = s.indexOf('\\end{cases}', afterBegin);
        const right = s.indexOf('\\right.', afterBegin);
        const nextBegin = s.indexOf('\\begin{cases}', afterBegin);
        const rightFirst = right >= 0 && (end < 0 || right < end) && (nextBegin < 0 || right < nextBegin);
        if (!rightFirst) { from = afterBegin; continue; }
        s = `${s.slice(0, right)}\\end{cases}${s.slice(right + '\\right.'.length)}`;
        // 配對的 \left\{（或 \left\lbrace）緊接在 \begin{cases} 前面：沒有 \right 了，留著會不成對
        const before = s.slice(0, begin);
        const m = /\\left\s*(?:\\\{|\\lbrace)\s*$/.exec(before);
        if (m) s = `${before.slice(0, m.index)}${s.slice(begin)}`;
        count += 1;
        from = (m ? m.index : begin) + 1;
    }
    return { text: s, count };
}

/** 環境內的單一反斜線換列補回 \\ */
function fixRowBreaks(text) {
    let count = 0;
    const out = text.replace(ENV_BODY_RE, (whole, env, spec, body) => {
        const n = countMatches(body, LONE_BACKSLASH_RE);
        if (!n) return whole;
        count += n;
        return `\\begin{${env}}${spec || ''}${body.replace(LONE_BACKSLASH_RE, '\\\\')}\\end{${env}}`;
    });
    return { text: out, count };
}

/**
 * 修一段文字。
 * @param {string} text
 * @param {{questionType?:string}} [opts]
 * @returns {{text:string, repairs:Array<{rule:string, count:number}>}}
 */
function repairText(text, { questionType } = {}) {
    if (typeof text !== 'string' || text === '') return { text, repairs: [] };
    let s = text;
    const repairs = [];
    const note = (rule, count) => { if (count > 0) repairs.push({ rule, count }); };

    // 先修「反斜線＋換行＋end{env}」（審查補的變體），再修只有換行的；兩種都記成 end_newline
    let n = countMatches(s, END_NEWLINE_BS_RE);
    s = s.replace(END_NEWLINE_BS_RE, (m, env) => `\\\\ \\end{${env}}`);
    n += countMatches(s, END_NEWLINE_RE);
    s = s.replace(END_NEWLINE_RE, (m, env) => `\\end{${env}}`);
    note('end_newline', n);

    const cases = fixCasesRight(s);
    s = cases.text;
    note('cases_right', cases.count);

    const rows = fixRowBreaks(s);
    s = rows.text;
    note('row_break', rows.count);

    n = countMatches(s, DEGREE_BRACED_RE) + countMatches(s, DEGREE_CARET_RE);
    s = s.replace(DEGREE_BRACED_RE, '^{\\circ}').replace(DEGREE_CARET_RE, '^\\circ');
    n += countMatches(s, DEGREE_BARE_RE);
    s = s.replace(DEGREE_BARE_RE, '^\\circ');
    note('degree_circled', n);

    if (!CHOICE_TYPES.has(questionType)) {
        n = countMatches(s, BLANK_RUN_RE);
        s = s.replace(BLANK_RUN_RE, BLANK);
        note('blank_boxes', n);
    }

    n = countMatches(s, LEADING_SUP_RE);
    s = s.replace(LEADING_SUP_RE, (m, pre, list) => `${pre}$${list.replace(/\s+/g, '')}$`);
    note('leading_superscript', n);

    return { text: s, repairs };
}

/**
 * 修一題的 question_text 與 answer_text（就地改傳入的物件，回傳修了什麼）。
 * @param {object} el normalizeElement 之後的元素
 * @returns {Array<{field:string, rule:string, count:number}>}
 */
function repairElement(el) {
    const out = [];
    if (!el || typeof el !== 'object') return out;
    for (const field of ['question_text', 'answer_text']) {
        if (typeof el[field] !== 'string') continue;
        const r = repairText(el[field], { questionType: el.question_type });
        if (r.repairs.length) {
            el[field] = r.text;
            for (const x of r.repairs) out.push({ field, ...x });
        }
    }
    return out;
}

module.exports = { repairText, repairElement, BLANK, ENVS };
