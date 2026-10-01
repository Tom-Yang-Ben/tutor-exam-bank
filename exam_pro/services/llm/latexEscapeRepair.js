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
// 不手抄）＋ 下面 UNSUPPORTED_LATEX_COMMANDS（確實是 LaTeX 指令、但解析器不支援的，只收 b f n r t 開頭的）。
//
// 什麼時候才修（上下文）：
//   - C 是退格／換頁／歸位（\b \f \r）：模型輸出的文字裡這三個字元沒有正當用途，字元本身就是證據，規則 A 不另看上下文。
//     （Windows 換行是 \r\n，歸位後面接的是換行不是字母，碰不到。）
//   - C 是定位（\t）：在公式裡（見下方「公式區段」）就修。公式外只有一種樣子不修：W 只有一兩個字母、而且後面緊接
//     空白（或別的控制字元、字串結尾）——「定位＋an 空白」「定位＋o 空白」跟真的定位字元＋英文單字 an、o 分不開，
//     所以公式外接空白的 \tan、\to、\tau、\top 不修。其餘（W 至少三個字母，或後面緊接 { ( [ ^ _ \、數字、中文、
//     標點）都修：「夾角\theta為銳角」「3\times4=12」。
//   - C 是換行（\n）：真的換行到處都是，所以最嚴格——公式外、Windows 換行（\r\n 的 \n）一律不修；公式裡：
//       W 至少兩個字母（\neq、\nabla、\norm）：修。
//       W 只有一個字母（\nu、\ne、\ni）：跟「換行＋變數 u、e、i」分不開，只在**行內公式**裡、而且下面兩條都成立才修——
//         (1) 公式片段裡沒有 \begin、&、\\ 這種多行結構（cases、aligned、矩陣本來就會換行）；
//         (2) 換行前一個字元是空白、公式開頭的 $ 或 \(、左括號 ( [ {、或 ^ _——指令前面慣例是這些；
//             真的換行前面是一個完整的項（=、運算子、字母、數字、右括號），例如「$f(x) =＋換行＋e^{x}$」。
//         行內公式裡不合這兩條的列進 unresolved（ambiguous_newline），不修；展示公式與沒關的 $ 裡一律不修、不列
//         （展示公式本來就常換行）。
//   - 控制字元前面緊接反斜線：數連續反斜線的個數。
//       奇數個：最後一個反斜線沒有配對，意思不明，不修（\b \f \r 與公式裡的 \t 列進 unresolved：after_backslash）。
//       偶數個：前面是完整的 \\（換列），控制字元本身沒有被跳脫——\b \f \r \t 照一般規則修（cases 換列後直接接
//       壞掉的 \theta、\frac）；換行不修（「\\＋換行」是換列的標準寫法）。
//
// 公式區段（mathSpans）：$…$、$$…$$、\(…\)、\[…\]，或沒關的界定符之後。單一 $ 的配對有兩種看法，**兩種都說在公式裡
// 才算公式**（公式裡才放寬的規則——定位的短指令名、換行、規則 B——都是在「放寬」，所以取嚴的）：
//   跨行配對：$ 一路配下去，不管換行。行內公式真的寫成兩行時是對的；某一行的 $ 沒關時，會把下一行的文字配進公式
//     （「甲：$x = 1＋換行＋乙：$y$ 與\neq 無關」的「與\neq」）。
//   逐行配對：單一 $ 與 \(…\) 不跨越「一定是真的換行」——跟 formulaLint、Word 匯出的看法一樣；行內公式在真的換行處
//     還沒關，就算到那裡為止的 'open'。$ 配錯對時是對的；行內公式真的寫成兩行時，第二行的奇偶會反過來。
//     只有「可能是被吃掉的 \n」的換行（後面的字母湊得成 n 開頭的指令、前面不是反斜線或歸位）不當成斷行：要判斷的正是它。
//   $$…$$ 與 \[…\] 兩種看法都跨行。兩種看法的種類不同時取嚴的（inline 與 open 並存 → open）。
//
// 一次修完（冪等）：候選由右往左決定。「定位＋an」後面緊接的若是另一個會被修的候選（\tan\theta、\tan\frac），
// 它後面實際接的是修好之後的反斜線，不是原字串裡的控制字元——由右往左才看得到。修過的再修一次，一個字都不變
//（單元測試用固定種子的隨機字串驗證）。
//
// 救不回來的（列進 unresolved，不改字）：\b \f \r 後面的字母湊不成指令、或前面是奇數個反斜線；\t 在公式裡、後面的
// 字母湊不成指令或前面是奇數個反斜線；行內公式裡意思不明的單一字母換行（ambiguous_newline）。其餘的換行不列
//（湊不成指令的換行就是真的換行）。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

const { supportedCommandNames } = require('../../utils/textFormatter');

/** 控制字元 → JSON 跳脫字母 */
const ESCAPE_LETTER = Object.freeze({ '\b': 'b', '\t': 't', '\n': 'n', '\f': 'f', '\r': 'r' });

/**
 * 確實是 LaTeX（或 amssymb、KaTeX）指令、但 utils/textFormatter.js 的解析器**不支援**的名字（只收 b f n r t 開頭的）。
 * 還原它們不會讓 Word 匯出變好——還原後 parseLatexStrict 會發 unknown_command、公式閘門擋下來交給 lint 重寫；
 * 不還原的話控制字元被 stripUnsafe 吃掉，「ullet」「extbf{…}」「ot」「igcup」這種壞字會**安靜地**通過閘門。
 * 第一列是 2026-09-25 本機 cassette 實際出現的（\big、\bigg、\norm、\root；原本還有 \bullet、\textbf，L-3 之後解析器支援）；其餘是高中數理
 * 常見、同樣開頭的寫法（dec/latex-escape-repair-fix 依審查意見補齊：\bot \bm \bigcup \nsubseteq \textdegree…）。
 * 解析器之後支援了其中哪一個，supportedCommandNames() 自然涵蓋，這裡不必刪。
 */
const UNSUPPORTED_LATEX_COMMANDS = Object.freeze([
    // 〔Owner 第五輪 L-3 核准，2026-09-27〕\bullet、\textbf 解析器已支援（EXTRA_SYMBOLS、parseCommand），移出本清單；
    // 修復表照樣認得它們（supportedCommandNames() 涵蓋）。
    'big', 'bigg', 'norm', 'root',
    // b：字型、大型運算子、符號
    'bigl', 'bigr', 'biggl', 'biggr', 'binom', 'boxed', 'bot', 'bm', 'bf', 'bold', 'bmod',
    'bigcup', 'bigcap', 'bigvee', 'bigwedge', 'bigcirc', 'bigstar', 'breve',
    'blacksquare', 'blacktriangle', 'boxplus', 'boxtimes',
    // f
    'fbox',
    // n：否定關係與箭頭
    'not', 'nleq', 'ngeq', 'nleqslant', 'ngeqslant', 'nleqq', 'ngeqq', 'nless', 'ngtr',
    'nmid', 'nparallel', 'ncong', 'nsim', 'nexists',
    'nsubseteq', 'nsupseteq', 'nsubset', 'nsupset',
    'nrightarrow', 'nleftarrow', 'nleftrightarrow', 'nRightarrow', 'nLeftarrow', 'nLeftrightarrow',
    'nearrow', 'nwarrow', 'newline', 'nonumber', 'nolimits',
    // r：右側定界符、箭頭、字型
    'rbrace', 'rbrack', 'rvert', 'rVert', 'rm', 'rightharpoonup', 'rightharpoondown',
    // t：文字模式、三角形、箭頭
    'textit', 'textrm', 'textsf', 'texttt', 'textnormal', 'textup', 'textsl', 'textstyle',
    'textdegree', 'textcircled', 'tbinom', 'top', 'tag',
    'triangleq', 'triangleleft', 'triangleright', 'triangledown', 'twoheadrightarrow',
    'thicksim', 'thickapprox'
]);

/** 退格、換頁、歸位：模型輸出的文字裡沒有正當用途 */
const NO_TEXT_USE = new Set(['\b', '\f', '\r']);

/** 單一字母的換行指令（\nu、\ne、\ni）前面慣例出現的字元：空白、公式開頭、左括號、上下標（控制字元不算空白） */
const COMMAND_PREV = /^[ \u00A0\u3000$([{^_]$/;

/** 公式片段裡的多行結構：\begin（含被吃成「退格＋egin」的）、欄分隔 &、換列 \\ */
const MULTILINE_RE = /\\begin|\x08egin|&|\\\\/;

/** 空白或控制字元（定位後面接這些＝像英文單字；另一個控制字元＝沒被修的候選） */
const SPACE_LIKE = /^[\s\x00-\x1F\x7F]$/;

const CANDIDATE_RE = /([\x08\x09\x0A\x0C\x0D])([A-Za-z]+)/g;
const QUICK_RE = /[\x08\x09\x0A\x0C\x0D][A-Za-z]/;
const LETTERS_AT = /[A-Za-z]+/y;

let tableCache = null;

/**
 * 修復用的指令表：解析器支援的全部指令 ∪ UNSUPPORTED_LATEX_COMMANDS。
 * @returns {ReadonlySet<string>}
 */
function commandTable() {
    if (!tableCache) tableCache = new Set([...supportedCommandNames(), ...UNSUPPORTED_LATEX_COMMANDS]);
    return tableCache;
}

/** pos 前面連續幾個反斜線 */
function backslashesBefore(s, pos) {
    let n = 0;
    while (pos - n - 1 >= 0 && s[pos - n - 1] === '\\') n += 1;
    return n;
}

/**
 * s[i] 是換行時：它「可能是被吃掉的 \n」嗎？——後面緊接的字母湊得成 n 開頭的已知指令，而且前面不是反斜線、
 * 也不是歸位（反斜線後面的換行、Windows 換行 \r\n 一律不修，見 decide）。不是的就一定是真的換行。
 */
function mayBeEatenNewline(s, i) {
    if (s[i - 1] === '\\' || s[i - 1] === '\r') return false;
    LETTERS_AT.lastIndex = i + 1;
    const m = LETTERS_AT.exec(s);
    return !!m && commandTable().has(`n${m[0]}`);
}

/**
 * 字串裡的公式區段，與 utils/textFormatter.js 認得的四種界定符相同：$…$、$$…$$、\(…\)、\[…\]。
 * 反斜線後面的字元一律跳過（\$ 是字面上的錢號、\\ 是表格換列）。最後一個沒關的界定符，從它到字串結尾算 'open'。
 * 預設**跨行配對**（lineAware: false）。lineAware: true 時單一 $ 與 \(…\) 不跨越真的換行（與 formulaLint、Word 匯出
 * 逐行配對一致；$$…$$ 與 \[…\] 照樣跨行）：只有「可能是被吃掉的 \n」的換行不算斷行（mayBeEatenNewline）；
 * 行內公式在真的換行處還沒關，從它到斷行處算 'open'；反斜線後面是換行時，換行照樣當斷行。
 * repairString 兩種都算，兩種都說在公式裡才算（見檔頭）。
 * @param {string} s
 * @param {{lineAware?:boolean}} [opts]
 * @returns {Array<{start:number, end:number, kind:'inline'|'display'|'open'}>}  [start, end)
 */
function mathSpans(s, { lineAware = false } = {}) {
    const spans = [];
    let open = null;    // { start, kind, close }
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\n' && lineAware) {
            if (open && (open.close === '$' || open.close === ')') && !mayBeEatenNewline(s, i)) {
                spans.push({ start: open.start, end: i, kind: 'open' });
                open = null;
            }
            i += 1;
            continue;
        }
        if (c === '\\') {
            const n = s[i + 1];
            if (!open && (n === '(' || n === '[')) {
                open = { start: i, kind: n === '(' ? 'inline' : 'display', close: n === '(' ? ')' : ']' };
            } else if (open && (open.close === ')' || open.close === ']') && n === open.close) {
                spans.push({ start: open.start, end: i + 2, kind: open.kind });
                open = null;
            } else if (n === '\n' && lineAware) {
                i += 1;         // 反斜線＋換行：換行在下一輪當斷行處理
                continue;
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

/** pos 落在哪一個公式區段裡；不在任何區段裡回 null */
function spanAt(spans, pos) {
    for (const sp of spans) if (pos > sp.start && pos < sp.end) return sp;
    return null;
}

/**
 * 一個字串的「公式上下文」查詢器：跨行、逐行兩種配對都說在公式裡才算（見檔頭）。
 * @param {string} s
 * @returns {(pos:number) => {math:null|'inline'|'display'|'open', multiline:boolean}}
 */
function mathContext(s) {
    const cross = mathSpans(s);
    const local = mathSpans(s, { lineAware: true });
    const multilineOf = new Map();
    const hasStructure = (sp) => {
        if (!multilineOf.has(sp)) multilineOf.set(sp, MULTILINE_RE.test(s.slice(sp.start, sp.end)));
        return multilineOf.get(sp);
    };
    return (pos) => {
        const a = spanAt(cross, pos);
        const b = spanAt(local, pos);
        if (!a || !b) return { math: null, multiline: false };
        let math;
        if (a.kind === 'inline' && b.kind === 'inline') math = 'inline';
        else if (a.kind === 'open' || b.kind === 'open') math = 'open';
        else math = 'display';
        return { math, multiline: hasStructure(a) || hasStructure(b) };
    };
}

/**
 * 一個「控制字元＋字母」要怎麼處理（純邏輯，單元測試直接測它）。
 * @param {{ch:string, word:string, prev?:string, next?:string, math:null|'inline'|'display'|'open',
 *          backslashes?:number, multiline?:boolean}} m
 *        prev／next：控制字元前一個字元、字母後一個字元（next 是**修好之後**的：後面緊接一個會被修的候選時是 '\\'）
 *        backslashes：控制字元前面連續幾個反斜線（省略時由 prev 推：prev 是反斜線算 1 個）
 *        multiline：所在的公式片段有沒有 \begin、&、\\（只有行內公式的單一字母換行看它）
 * @returns {{action:'repair', name:string, rule:'escape'|'substituted'}
 *          |{action:'keep'}
 *          |{action:'unresolved', reason:'no_command'|'after_backslash'|'ambiguous_newline'}}
 */
function decide({ ch, word, prev, next, math, backslashes, multiline = false }) {
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

    const bs = backslashes ?? (prev === '\\' ? 1 : 0);
    if (bs % 2 === 1) return suspicious ? { action: 'unresolved', reason: 'after_backslash' } : { action: 'keep' };
    if (bs > 0 && ch === '\n') return { action: 'keep' };        // 「\\＋換行」是換列的標準寫法

    const repair = { action: 'repair', name, rule };
    if (rule === 'substituted') return repair;                    // 已要求 math !== null
    if (NO_TEXT_USE.has(ch)) return repair;
    if (ch === '\t') {
        if (math !== null) return repair;
        const wordLike = word.length <= 2 && (next === undefined || SPACE_LIKE.test(next));
        return wordLike ? { action: 'keep' } : repair;
    }
    // '\n'
    if (math === null || prev === '\r') return { action: 'keep' };   // 公式外、Windows 換行（\r\n）：真的換行
    if (word.length >= 2) return repair;
    if (math !== 'inline') return { action: 'keep' };
    if (!multiline && prev !== undefined && COMMAND_PREV.test(prev)) return repair;
    return { action: 'unresolved', reason: 'ambiguous_newline' };
}

/**
 * 修一個字串。候選由右往左決定（next 看得到後面那個候選修好之後的樣子），所以一次就修到不再改變。
 * @param {string} s
 * @returns {{text:string, repairs:Array<{at:number, from:string, to:string, rule:string}>,
 *            unresolved:Array<{at:number, char:string, letters:string, reason:string}>}}
 *          at＝控制字元在**原字串**中的位置；from／char 用 JSON 跳脫寫法（'\\f'）方便印 log
 */
function repairString(s) {
    const repairs = [];
    const unresolved = [];
    if (typeof s !== 'string' || !QUICK_RE.test(s)) return { text: s, repairs, unresolved };
    const contextAt = mathContext(s);
    const found = [...s.matchAll(CANDIDATE_RE)];
    const decisions = new Array(found.length);
    for (let k = found.length - 1; k >= 0; k--) {
        const m = found[k];
        const end = m.index + m[0].length;
        const following = found[k + 1];
        const next = following && following.index === end && decisions[k + 1].action === 'repair' ? '\\' : s[end];
        const { math, multiline } = contextAt(m.index);
        decisions[k] = decide({
            ch: m[1], word: m[2], prev: s[m.index - 1], next, math,
            backslashes: backslashesBefore(s, m.index),
            multiline
        });
    }
    let text = '';
    let last = 0;
    found.forEach((m, k) => {
        const d = decisions[k];
        const esc = `\\${ESCAPE_LETTER[m[1]]}`;
        text += s.slice(last, m.index);
        if (d.action === 'repair') {
            repairs.push({ at: m.index, from: esc + m[2], to: `\\${d.name}`, rule: d.rule });
            text += `\\${d.name}`;
        } else {
            if (d.action === 'unresolved') unresolved.push({ at: m.index, char: esc, letters: m[2], reason: d.reason });
            text += m[0];
        }
        last = m.index + m[0].length;
    });
    text += s.slice(last);
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
