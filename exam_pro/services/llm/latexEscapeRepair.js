// services/llm/latexEscapeRepair.js — 把「被 JSON 跳脫吃掉的 LaTeX 反斜線」補回去（dec/latex-escape-repair）
//
// 問題：模型在 JSON 字串裡寫 LaTeX 時常常只寫一個反斜線。JSON 的合法跳脫只有 \" \\ \/ \b \f \n \r \t \uXXXX，
// 其中五個剛好是 LaTeX 指令的開頭字母：
//   \frac → 換頁（U+000C）＋「rac」    \times、\theta、\tan、\text → 定位（U+0009）＋「imes」「heta」…
//   \beta、\bar、\boldsymbol → 退格（U+0008）＋…   \rho、\right → 歸位（U+000D）＋…   \neq、\nu、\nabla → 換行（U+000A）＋…
// JSON.parse 不會報錯，題幹裡就出現「控制字元＋rac」。Word 匯出（utils/textFormatter.js 的 stripUnsafe）把換頁、
// 退格直接刪掉、定位當空白，於是 $\frac{1}{2}$ 變成「rac12」，而且 parseLatexStrict 看不出來——
// 公式閘門（agents/lint.js 的 formulaFix＋formulaLint）照樣放行。本機 cassette（2026-09-25，qwen3:8b）實測
// variant 60 支有 49 支、classify 92 支有 10 支、verify 20 支有 1 支帶這種字元；Gemini 的 variant 87 支也有 11 支。
//
// 另一種變形（Ollama 的 JSON 文法約束造成）：模型想寫 \circ，但 \c 不是合法跳脫，文法只允許 b f n r t u " \ /，
// 模型被迫先吐一個合法字母（例如 r）再照原意寫完「circ」——解析後是「歸位字元＋circ」。這種「整個指令名都還在、
// 只是前面多了一個被換掉的字母」可以救（見下方規則 B）。剩下的字母湊不成任何指令時（實測「換頁＋dg」「歸位＋d」，
// 原意多半是度數符號）就救不回來：不猜，原樣保留並列進 unresolved。
// \u 開頭的（\underline、\uparrow、\upsilon）不在本檔範圍：\u 後面必須是四個十六進位數字，寫錯時 JSON.parse
// 直接丟錯（走 schema_invalid），寫成合法的四位數就變成一個別的字，事後分不出原意。
//
// 修在哪裡：services/llm/index.js 的 generateJson，**解析完 JSON 之後、交給 agent 之前**；live、record、replay
// 三條路都套用（Ollama 與 Gemini 都一樣）。cassette 存的是模型的原始回應（未修），鍵的算法一個字都沒動——
// 回放時照樣套用，所以既有 cassette 不必重錄就吃得到修復；修復規則之後再改，也不必重錄 LLM 那一段。
//
// ── 規則（對 data 裡每一個字串值；物件的鍵不動）──
// 找「控制字元 C（\b \f \n \r \t 之一）＋一串英文字母 W（取到最長）」。L 是 C 對應的跳脫字母（b f n r t）。
//   A. L＋W 是已知指令（\f＋rac → frac）                       → 換成「\＋L＋W」
//   B. L＋W 不是、但 W 本身是已知指令（\r＋circ → circ）       → 換成「\＋W」（被文法換掉的那個字母丟掉）
//      B 只在公式裡修，而且不用在換行上（換行後面接一個指令名但沒有反斜線，比較可能是真的換行＋漏寫反斜線）。
// 「已知指令」＝ utils/textFormatter.js 的 supportedCommandNames()（parseLatexStrict 認得的全部指令，程式產生、
// 不手抄）＋ 下面 UNSUPPORTED_LATEX_COMMANDS（確實是 LaTeX 指令、但解析器不支援的少數幾個）。
//
// 什麼時候才修（上下文）：
//   - C 是退格／換頁／歸位（\b \f \r）：模型輸出的文字裡這三個字元沒有正當用途，字元本身就是證據，規則 A 不另看上下文。
//     （Windows 換行是 \r\n，歸位後面接的是換行不是字母，碰不到。）
//   - C 是定位（\t）：在公式裡（$…$、$$…$$、\(…\)、\[…\]，或結尾沒關的 $ 之後）就修；公式外要求指令名後面緊接
//     { ( [ ^ _ \ 之一，或緊接空白且 W 至少三個字母（「定位＋an 空白」「定位＋o 空白」跟真的定位字元＋英文單字
//     an、o 分不開，所以 \tan、\to、\tau 在公式外後面接空白時不修；\times、\theta、\text 照修）。
//   - C 是換行（\n）：真的換行到處都是，所以最嚴格——只在公式裡修，而且：
//       行內公式（$…$、\(…\)）裡任何 W 都修：行內公式本來就不能跨行，裡面的換行一定是壞掉的反斜線；
//       展示公式（$$…$$、\[…\]）或沒關的 $ 裡，W 至少兩個字母才修（\neq、\nabla 可以；單一字母的 \nu、\ne、\ni
//       跟「換行＋變數 u、e、i」分不開，不修）；公式外一律不修。
//   - 控制字元前面緊接一個反斜線（例如表格換列 \\ 之後的換行）：意思不明，不修。
//
// 救不回來的（列進 unresolved，不改字）：\b \f \r 後面的字母湊不成指令、或前面緊接反斜線；\t 在公式裡、後面的字母
// 湊不成指令。換行一律不列（湊不成指令的換行就是真的換行）。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

const { supportedCommandNames } = require('../../utils/textFormatter');

/** 控制字元 → JSON 跳脫字母 */
const ESCAPE_LETTER = Object.freeze({ '\b': 'b', '\t': 't', '\n': 'n', '\f': 'f', '\r': 'r' });

/**
 * 確實是 LaTeX 指令、但 utils/textFormatter.js 的解析器**不支援**的名字（只收 b f n r t 開頭的）。
 * 還原它們不會讓 Word 匯出變好——還原後 parseLatexStrict 會發 unknown_command、公式閘門擋下來交給 lint 重寫；
 * 不還原的話控制字元被 stripUnsafe 吃掉，「ullet」「extbf{…}」這種壞字會**安靜地**通過閘門。
 * 前六個是 2026-09-25 本機 cassette 實際出現的（\bullet、\textbf、\big、\bigg、\norm、\root），
 * 其餘是高中數理常見、同樣開頭的寫法。解析器之後支援了其中哪一個，supportedCommandNames() 自然涵蓋，這裡不必刪。
 */
const UNSUPPORTED_LATEX_COMMANDS = Object.freeze([
    'bullet', 'textbf', 'big', 'bigg', 'norm', 'root',
    'bigl', 'bigr', 'biggl', 'biggr', 'binom', 'boxed', 'textit', 'textrm', 'not', 'nleq', 'ngeq'
]);

/** 公式外的定位字元：指令名後面緊接這些字元才算「看起來是公式」 */
const FORMULA_NEXT = new Set(['{', '(', '[', '^', '_', '\\']);

/** 退格、換頁、歸位：模型輸出的文字裡沒有正當用途 */
const NO_TEXT_USE = new Set(['\b', '\f', '\r']);

const CANDIDATE_RE = /([\x08\x09\x0A\x0C\x0D])([A-Za-z]+)/g;
const QUICK_RE = /[\x08\x09\x0A\x0C\x0D][A-Za-z]/;

let tableCache = null;

/**
 * 修復用的指令表：解析器支援的全部指令 ∪ UNSUPPORTED_LATEX_COMMANDS。
 * @returns {ReadonlySet<string>}
 */
function commandTable() {
    if (!tableCache) tableCache = new Set([...supportedCommandNames(), ...UNSUPPORTED_LATEX_COMMANDS]);
    return tableCache;
}

/**
 * 字串裡的公式區段，與 utils/textFormatter.js 認得的四種界定符相同：$…$、$$…$$、\(…\)、\[…\]。
 * 與 formulaLint 的 mathSpans 不同，這裡**跨行配對**——要找的正是「本來不該出現在行內公式裡的換行」。
 * 反斜線後面的字元一律跳過（\$ 是字面上的錢號、\\ 是表格換列）。最後一個沒關的界定符，從它到字串結尾算 'open'。
 * @param {string} s
 * @returns {Array<{start:number, end:number, kind:'inline'|'display'|'open'}>}  [start, end)
 */
function mathSpans(s) {
    const spans = [];
    let open = null;    // { start, kind, close }
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') {
            const n = s[i + 1];
            if (!open && (n === '(' || n === '[')) {
                open = { start: i, kind: n === '(' ? 'inline' : 'display', close: n === '(' ? ')' : ']' };
            } else if (open && (open.close === ')' || open.close === ']') && n === open.close) {
                spans.push({ start: open.start, end: i + 2, kind: open.kind });
                open = null;
            }
            i += 2;
            continue;
        }
        if (c === '$') {
            const dbl = s[i + 1] === '$';
            if (!open) {
                open = { start: i, kind: dbl ? 'display' : 'inline', close: dbl ? '$$' : '$' };
                i += dbl ? 2 : 1;
                continue;
            }
            if (open.close === '$$' && dbl) {
                spans.push({ start: open.start, end: i + 2, kind: 'display' });
                open = null;
                i += 2;
                continue;
            }
            if (open.close === '$') {
                spans.push({ start: open.start, end: i + 1, kind: 'inline' });
                open = null;
                i += 1;
                continue;
            }
        }
        i += 1;
    }
    if (open) spans.push({ start: open.start, end: s.length, kind: 'open' });
    return spans;
}

/** pos 落在哪一種公式區段裡；不在任何區段裡回 null */
function mathKindAt(spans, pos) {
    for (const sp of spans) if (pos > sp.start && pos < sp.end) return sp.kind;
    return null;
}

/**
 * 一個「控制字元＋字母」要怎麼處理（純邏輯，單元測試直接測它）。
 * @param {{ch:string, word:string, prev?:string, next?:string, math:null|'inline'|'display'|'open'}} m
 * @returns {{action:'repair', name:string, rule:'escape'|'substituted'}
 *          |{action:'keep'}
 *          |{action:'unresolved', reason:'no_command'|'after_backslash'}}
 */
function decide({ ch, word, prev, next, math }) {
    const letter = ESCAPE_LETTER[ch];
    if (!letter || !word) return { action: 'keep' };
    const table = commandTable();

    let name = null;
    let rule = null;
    if (table.has(letter + word)) {
        name = letter + word;
        rule = 'escape';
    } else if (ch !== '\n' && math !== null && table.has(word)) {
        name = word;
        rule = 'substituted';
    }

    // 救不回來時要不要列出來：\b \f \r 一律列；\t 在公式裡才列；換行不列（湊不成指令的換行就是真的換行）
    const suspicious = NO_TEXT_USE.has(ch) || (ch === '\t' && math !== null);
    if (!name) return suspicious ? { action: 'unresolved', reason: 'no_command' } : { action: 'keep' };
    if (prev === '\\') return suspicious ? { action: 'unresolved', reason: 'after_backslash' } : { action: 'keep' };

    let ok;
    if (rule === 'substituted') ok = true;                        // 已要求 math !== null
    else if (NO_TEXT_USE.has(ch)) ok = true;
    else if (ch === '\t') ok = math !== null || FORMULA_NEXT.has(next) || (next === ' ' && word.length >= 3);
    else ok = math === 'inline' || (math !== null && word.length >= 2);   // '\n'

    return ok ? { action: 'repair', name, rule } : { action: 'keep' };
}

/**
 * 修一個字串。
 * @param {string} s
 * @returns {{text:string, repairs:Array<{at:number, from:string, to:string, rule:string}>,
 *            unresolved:Array<{at:number, char:string, letters:string, reason:string}>}}
 *          at＝控制字元在**原字串**中的位置；from／char 用 JSON 跳脫寫法（'\\f'）方便印 log
 */
function repairString(s) {
    const repairs = [];
    const unresolved = [];
    if (typeof s !== 'string' || !QUICK_RE.test(s)) return { text: s, repairs, unresolved };
    const spans = mathSpans(s);
    const text = s.replace(CANDIDATE_RE, (whole, ch, word, offset) => {
        const d = decide({
            ch, word,
            prev: s[offset - 1],
            next: s[offset + whole.length],
            math: mathKindAt(spans, offset)
        });
        const esc = `\\${ESCAPE_LETTER[ch]}`;
        if (d.action === 'repair') {
            repairs.push({ at: offset, from: esc + word, to: `\\${d.name}`, rule: d.rule });
            return `\\${d.name}`;
        }
        if (d.action === 'unresolved') unresolved.push({ at: offset, char: esc, letters: word, reason: d.reason });
        return whole;
    });
    return { text, repairs, unresolved };
}

/**
 * 深度走訪 generateJson 的 data，修每一個字串值（物件的鍵不動）。**不就地修改**：有改到的那一條路徑才複製，
 * 其餘原樣共用；整份都沒改時回傳的就是同一個物件。
 * @param {any} value
 * @returns {{value:any, repairs:Array<{path:string, at:number, from:string, to:string, rule:string}>,
 *            unresolved:Array<{path:string, at:number, char:string, letters:string, reason:string}>}}
 */
function repairLatexEscapes(value) {
    const repairs = [];
    const unresolved = [];
    const walk = (v, path) => {
        if (typeof v === 'string') {
            const r = repairString(v);
            for (const x of r.repairs) repairs.push({ path, ...x });
            for (const x of r.unresolved) unresolved.push({ path, ...x });
            return r.text;
        }
        if (Array.isArray(v)) {
            let out = null;
            for (let i = 0; i < v.length; i++) {
                const next = walk(v[i], `${path}[${i}]`);
                if (next !== v[i]) {
                    if (!out) out = v.slice();
                    out[i] = next;
                }
            }
            return out || v;
        }
        if (v && typeof v === 'object') {
            let out = null;
            for (const [k, child] of Object.entries(v)) {
                const next = walk(child, path ? `${path}.${k}` : k);
                if (next !== child) {
                    if (!out) out = { ...v };
                    out[k] = next;
                }
            }
            return out || v;
        }
        return v;
    };
    const out = walk(value, '');
    return { value: out, repairs, unresolved };
}

/**
 * services/llm/index.js 用：修 generateJson 回傳物件的 data。什麼都沒改、也沒有救不回來的時候回傳**同一個物件**
 *（回傳形狀逐位元不變）；有的話回傳淺拷貝，data 換成修過的，並多一個 latexRepair 摘要：
 *   { repaired: 修了幾處, commands: { frac: 3, times: 2, … }, unresolved: [{path, at, char, letters, reason}] }
 * raw（供應商原始回應）不動。
 * @param {object} res
 * @returns {object}
 */
function applyToResult(res) {
    if (!res || typeof res !== 'object' || res.data === undefined) return res;
    const r = repairLatexEscapes(res.data);
    if (!r.repairs.length && !r.unresolved.length) return res;
    const commands = {};
    for (const x of r.repairs) {
        const name = x.to.slice(1);
        commands[name] = (commands[name] || 0) + 1;
    }
    return { ...res, data: r.value, latexRepair: { repaired: r.repairs.length, commands, unresolved: r.unresolved } };
}

/**
 * 回歸量測用：字串裡有沒有「換行以外」的 C0 控制字元（本分支用來數「帶控制字元的支數」的定義）。
 * @param {any} value
 * @returns {boolean}
 */
function hasNonNewlineControl(value) {
    let found = false;
    const walk = (v) => {
        if (found) return;
        if (typeof v === 'string') { if (/[\x00-\x09\x0B-\x1F\x7F]/.test(v)) found = true; return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(value);
    return found;
}

module.exports = {
    repairLatexEscapes, repairString, applyToResult, decide, mathSpans, commandTable, hasNonNewlineControl,
    ESCAPE_LETTER, UNSUPPORTED_LATEX_COMMANDS
};
