const {
    Math: DocxMath, MathRun, MathFraction, MathSuperScript, MathSubScript,
    MathSubSuperScript, MathRadical, MathSum, MathIntegral, MathLimitLower, TextRun,
    MathRoundBrackets, MathSquareBrackets, MathCurlyBrackets,
    XmlComponent, ImportedXmlComponent
} = require('docx');
// 〔stage5 WS-B〕化學：\ce{…} 先轉成等價的一般 LaTeX 再交給本檔的解析器（utils/chemFormula.js）
const { ceToLatex } = require('./chemFormula');

// ───────────────────────── 對照表 ─────────────────────────
const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
    rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};

const SYMBOLS = {
    times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', pm: '±', mp: '∓',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
    equiv: '≡', sim: '∼', cong: '≅', propto: '∝', infty: '∞', partial: '∂',
    nabla: '∇', forall: '∀', exists: '∃', in: '∈', notin: '∉', ni: '∋',
    subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
    emptyset: '∅', varnothing: '∅', to: '→', rightarrow: '→', leftarrow: '←',
    Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
    mapsto: '↦', ldots: '…', dots: '…', cdots: '⋯', angle: '∠', perp: '⊥',
    parallel: '∥', circ: '∘', prime: '′', neg: '¬', wedge: '∧', vee: '∨',
    oplus: '⊕', otimes: '⊗', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋',
    lceil: '⌈', rceil: '⌉', prod: '∏', oint: '∮', sqrt: '√', because: '∵',
    therefore: '∴', degree: '°', backslash: '\\', percent: '%',
    // 2026-09-15 補：題庫實際出現過而未登錄的四個（\ell 舊題、\triangle 三角形題）
    ell: 'ℓ', hbar: 'ℏ', triangle: '△', square: '□'
};

// 〔stage5 WS-B〕化學常用的箭頭（docs/interfaces-stage5.md 第 4.2 條第 3 點）。
// 刻意**不併進 SYMBOLS**：SYMBOLS 有匯出給 utils/embedText.js 的 latexToPlain 共用，
// 併進去會讓含這些指令的既有題目 embed_text 改變、向量被判過期（embedText.js 檔頭的警告）。
// 只給 Word 匯出用，放在 parseCommand 查完 SYMBOLS 之後。
const EXTRA_SYMBOLS = {
    rightleftharpoons: '⇌', leftrightharpoons: '⇋', rightleftarrows: '⇄',
    uparrow: '↑', downarrow: '↓', updownarrow: '↕',
    longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷'
};

// \xrightarrow{上}、\xrightarrow[下]{上} 這一族：指令名 → 箭頭字元
const STRETCH_ARROWS = { xrightarrow: '→', xleftarrow: '←', xrightleftharpoons: '⇌', xleftrightarrow: '↔' };

// \mathbb{R} 之類的黑板粗體：單一拉丁字母映射到 Unicode 雙線字，其餘照字面輸出
const BLACKBOARD = {
    A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀', J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄',
    N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ', S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ'
};

/**
 * 把跨行的區塊公式（$$…$$、\[…\]）內的換行換成空白，長度不變、位置不變。
 * buildParagraphComponents 與 formulaLint 都是逐行掃描；表格類 \begin{array} 幾乎必然跨行，
 * 不先摺起來就會在第一行被判成「環境沒關」、後面幾行被當純文字印出。
 */
function foldDisplayMath(s) {
    return String(s).replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, (block) => block.replace(/\n/g, ' '));
}

const FUNCTIONS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'det', 'dim',
    'ker', 'deg', 'gcd', 'hom', 'max', 'min', 'sup', 'inf', 'arg', 'mod'
]);

const ACCENTS = {
    vec: '⃗', hat: '̂', widehat: '̂', bar: '̅',
    overline: '̅', dot: '̇', ddot: '̈', tilde: '̃',
    widetilde: '̃', check: '̌', acute: '́', grave: '̀'
};

// ───────────────────────── 矩陣（原生 OMML m:m）─────────────────────────
//
// 2026-08-27 兩步到位：同日稍早先做線性形式（欄空白、列分號）讓矩陣題不再卡
// formula_unparsable，使用者當天實測 Word 檔即反映線性形式不可讀——roadmap §6.5
// 第 3 項的觸發條件成立，改為原生二維排版。docx 9.6.1 沒有現成的矩陣元件，
// 以下三個是最小的 XmlComponent 子類，產出標準 OMML：
//   m:m（矩陣）→ m:mr（列）→ m:e（儲存格，內容是任意 Math 元件）
// Word 要求同一個 m:m 的每一列 m:e 數目相同，renderMatrixBody 會補齊空格。

class MathMatrixCell extends XmlComponent {           // m:e
    constructor(children) {
        super('m:e');
        for (const c of children) this.root.push(c);
    }
}

class MathMatrixRow extends XmlComponent {            // m:mr
    constructor(cells) {
        super('m:mr');
        for (const cell of cells) this.root.push(new MathMatrixCell(cell));
    }
}

class MathMatrix extends XmlComponent {               // m:m
    constructor(rows) {
        super('m:m');
        for (const r of rows) this.root.push(r);
    }
}

/** 自訂括號的 m:d（vmatrix 的 |…|、cases 的單邊 {）；標準括號用 docx 現成元件 */
function customDelimiter(beg, end, inner) {
    const d = new (class extends XmlComponent { constructor() { super('m:d'); } })();
    // fromXmlString 的回傳是「rootKey=undefined 的外殼」，要取 root[0] 才是 m:dPr 本體，
    // 直接 push 外殼會在 document.xml 產出 <undefined>，Word 判整份檔損毀
    d.root.push(ImportedXmlComponent.fromXmlString(
        `<m:dPr><m:begChr m:val="${beg}"/><m:endChr m:val="${end}"/></m:dPr>`
    ).root[0]);
    d.root.push(new MathMatrixCell([inner]));
    return d;
}

// ───────────────────────── 化學排版（〔stage5 WS-B〕）─────────────────────────
//
// 1. \mathrm{…} → OMML 正體：每個 m:r 前面補 <m:rPr><m:sty m:val="p"/></m:rPr>。
//    化學式（\ce 轉出來的 \mathrm{H_{2}O}）與單位（\mathrm{m/s}）照規範都該是正體；
//    階段 5 之前 \mathrm 與 \text 一樣只是拆殼，Word 會排成斜體的 H₂O。
// 2. \xrightarrow{上}／\xrightarrow[下]{上}：上方文字用 m:groupChr（箭頭當「組字元」放在文字下方，
//    vertJc=bot 讓箭頭落在基線上，這是 Word 內建「箭頭上方加文字」的結構）；下方文字再包一層 m:limLow。

/** 一個新的 <m:rPr><m:sty m:val="p"/></m:rPr>（每個 m:r 各給一份，不共用實例） */
function uprightRunProps() {
    // fromXmlString 回傳的是 rootKey=undefined 的外殼，root[0] 才是 m:rPr 本體（見 customDelimiter 的註解）
    return ImportedXmlComponent.fromXmlString('<m:rPr><m:sty m:val="p"/></m:rPr>').root[0];
}

/**
 * 把一串數學元件裡所有的 m:r 設成正體（遞迴走訪；已經有 m:rPr 的 run 不動）。
 * @param {Array<object>} nodes
 * @returns {Array<object>} 同一個陣列（就地修改）
 */
function makeUpright(nodes) {
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node.rootKey === 'm:r' && Array.isArray(node.root)) {
            if (!node.root.some(c => c && c.rootKey === 'm:rPr')) node.root.unshift(uprightRunProps());
            return;
        }
        if (Array.isArray(node.root)) node.root.forEach(visit);
    };
    visit(nodes);
    return nodes;
}

class MathGroupChr extends XmlComponent {             // m:groupChr（字元在下、基線對齊字元）
    constructor(chr, children) {
        super('m:groupChr');
        this.root.push(ImportedXmlComponent.fromXmlString(
            `<m:groupChrPr><m:chr m:val="${chr}"/><m:vertJc m:val="bot"/></m:groupChrPr>`
        ).root[0]);
        this.root.push(new MathMatrixCell(children));   // m:e
    }
}

class MathSlot extends XmlComponent {                 // 任意的 m:sub／m:sup／m:e 容器
    constructor(key, children) {
        super(key);
        for (const c of children) this.root.push(c);
    }
}

/**
 * 前置上下標（同位素 ¹⁴₆C）→ m:sPre。不用 docx 的 MathPreSubSuperScript：
 * 它把 m:e 排在 m:sub／m:sup 之前，ECMA-376 的 CT_SPre 規定的順序是 sPrePr、sub、sup、e。
 */
function preScript(sup, sub, body) {
    const node = new MathSlot('m:sPre', [new MathSlot('m:sub', sub), new MathSlot('m:sup', sup), new MathSlot('m:e', body)]);
    return node;
}

/**
 * 可帶上下文字的箭頭。上下都沒有 → 單一箭頭字元。
 * @param {string} chr 箭頭字元
 * @param {Array<object>|null} above
 * @param {Array<object>|null} below
 */
function arrowWithText(chr, above, below) {
    const hasAbove = Array.isArray(above) && above.length > 0;
    const hasBelow = Array.isArray(below) && below.length > 0;
    if (!hasAbove && !hasBelow) return mr(chr);
    const core = hasAbove ? new MathGroupChr(chr, above) : mr(chr);
    return hasBelow ? new MathLimitLower({ children: [core], limit: below }) : core;
}

/**
 * 解析器的 token 切片 → 原始字串（\ce{…} 的本體要先還原成字串才能交給 ceToLatex）。
 * 反斜線逸出的 \{ \} 在 tokenize 時變成 char，這裡補回反斜線，大括號結構才不會亂掉。
 */
function tokensToSource(toks) {
    return toks.map((t) => {
        switch (t.type) {
            case 'command': return `\\${t.value}`;
            case 'lbrace': return '{';
            case 'rbrace': return '}';
            case 'sup': return '^';
            case 'sub': return '_';
            case 'space': return ' ';
            case 'char':
                if (t.value === '{' || t.value === '}' || t.value === '\\') return `\\${t.value}`;
                return t.value;
            default: return '';
        }
    }).join('');
}

// 環境名 → 把 m:m 包上對應括號。值是工廠函式：docx 的括號元件不能重複使用實例。
const MATRIX_ENVS = {
    matrix: (m) => m,
    smallmatrix: (m) => m,
    aligned: (m) => m,
    array: (m) => m,
    pmatrix: (m) => new MathRoundBrackets({ children: [m] }),
    bmatrix: (m) => new MathSquareBrackets({ children: [m] }),
    Bmatrix: (m) => new MathCurlyBrackets({ children: [m] }),
    vmatrix: (m) => customDelimiter('|', '|', m),
    Vmatrix: (m) => customDelimiter('‖', '‖', m),
    cases: (m) => customDelimiter('{', '', m)
};

const isCJK = (ch) => /[⺀-鿿　-〿＀-￯㐀-䶿]/.test(ch);

// 清掉 emoji 與控制字元（保留所有數學語法）
function stripUnsafe(str) {
    return String(str)
        .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F0FF}]|[\u{1F1E6}-\u{1F1FF}]|️/gu, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ───────────────────────── 診斷事件收集（A-T4，只加不改）─────────────────────────
//
// docs/interfaces-stage2.md 第 4.3 條：同一個 parser，事件「只收集、不改變輸出」。
// 因此本檔所有埋點都長成 `emit(diag, kind, at)`——diag 為 null（既有呼叫端）時
// 只是一次 if 判斷，parseLatexToMath / buildParagraphComponents 的輸出逐位元不變。
//
// 六個凍結的 kind：
//   unknown_command  未知指令降級成純文字（parseCommand 結尾的 `return mr(name)`）
//   missing_rbrace   群組缺右大括號（讀到字串結尾才發現）
//   empty_fallback   整段公式解析不出任何元件，整串退成 MathRun
//   parser_error     解析器丟例外，整串退成去語法的純文字
//   tokenize_error   tokenize 丟例外，整段退成 TextRun
//   bare_script      ^ / _ 沒有可用的底或參數，退成字面上的 ^ / _
//
// 埋點位置：介面第 4.3 條凍結的是**六個 kind**，位置由 WS-C 決定（裁決 S2-17）。
// `bare_script` 有兩處：renderMixedInto（純文字裡沒有底的 ^／_）與 parseScripted
// （`$…$` 內 ^／_ 後面什麼都沒有，例如 fixture #38 的 `$F^$`）——只埋前者的話，
// fixture 那 10 題壞公式只抓得到 8 題。
//
// `at` 一律是「事件發生處在被解析字串中的 0-based 字元位置」；
// 各層以 base 參數把子字串的位移一路帶下去，parseLatexStrict 再映射回原字串。
function emit(diag, kind, at) {
    if (diag) diag.push({ kind, at: Number.isFinite(at) && at >= 0 ? at : 0 });
}

// ───────────────────────── Tokenizer ─────────────────────────
// base：本段字串的第一個字元在原字串中的位置（只影響 token.at，不影響切分結果）
function tokenize(s, base = 0) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const at = base + i;
        const c = s[i];
        if (c === '\\') {
            let j = i + 1;
            if (j < s.length && /[A-Za-z]/.test(s[j])) {
                let name = '';
                while (j < s.length && /[A-Za-z]/.test(s[j])) { name += s[j]; j++; }
                toks.push({ type: 'command', value: name, at });
                i = j;
            } else {
                const ch = s[j] !== undefined ? s[j] : '';
                if (ch === ',' || ch === ';' || ch === '!' || ch === ' ' || ch === ':' || ch === '>') {
                    toks.push({ type: 'space', value: ' ', at });
                } else {
                    toks.push({ type: 'char', value: ch, at });
                }
                i = j + 1;
            }
        } else if (c === '{') { toks.push({ type: 'lbrace', at }); i++; }
        else if (c === '}') { toks.push({ type: 'rbrace', at }); i++; }
        else if (c === '^') { toks.push({ type: 'sup', at }); i++; }
        else if (c === '_') { toks.push({ type: 'sub', at }); i++; }
        else if (c === ' ' || c === '\t') { toks.push({ type: 'space', value: ' ', at }); i++; }
        else { toks.push({ type: 'char', value: c, at }); i++; }
    }
    return toks;
}

const mr = (t) => new MathRun(t && t.length ? t : ' ');

// ───────────────────────── 遞迴解析器 ─────────────────────────
function createParser(tokens, stopCJK, diag = null) {
    let pos = 0;

    /** 目前位置的 token 位置；讀到結尾時退回上一個 token 的位置（讓事件仍落在字串內） */
    function here() {
        const t = tokens[pos];
        if (t && Number.isFinite(t.at)) return t.at;
        for (let k = pos - 1; k >= 0; k--) {
            if (tokens[k] && Number.isFinite(tokens[k].at)) return tokens[k].at;
        }
        return 0;
    }

    function atMathEnd() {
        const t = tokens[pos];
        if (!t) return true;
        if (t.type === 'rbrace') return true;
        if (stopCJK && t.type === 'char' && isCJK(t.value)) return true;
        if (stopCJK && t.type === 'space') {
            let k = pos + 1;
            while (tokens[k] && tokens[k].type === 'space') k++;
            if (!tokens[k] || (tokens[k].type === 'char' && isCJK(tokens[k].value))) return true;
        }
        return false;
    }

    // 讀取一個群組或單一原子的「純文字」（給重音符號用）
    function readRawGroupText() {
        let text = '';
        if (tokens[pos] && tokens[pos].type === 'lbrace') {
            const openAt = here();
            pos++;
            while (tokens[pos] && tokens[pos].type !== 'rbrace') {
                const t = tokens[pos++];
                if (t.type === 'char') text += t.value;
                else if (t.type === 'space') text += ' ';
                else if (t.type === 'command') text += (GREEK[t.value] || SYMBOLS[t.value] || t.value);
            }
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
            else emit(diag, 'missing_rbrace', openAt);
        } else {
            const t = tokens[pos++];
            if (t) {
                if (t.type === 'char') text = t.value;
                else if (t.type === 'command') text = (GREEK[t.value] || SYMBOLS[t.value] || t.value);
            }
        }
        return text;
    }

    // ── 矩陣類環境的四個輔助（MATRIX_ENVS 的說明見檔頭）──

    /** 窺看 tokens[k] 起的 {…} 群組名稱；k 不是 lbrace 或群組沒關回 null。**不消耗、不發事件** */
    function peekGroupName(k) {
        if (!tokens[k] || tokens[k].type !== 'lbrace') return null;
        let name = '';
        k++;
        while (tokens[k] && tokens[k].type !== 'rbrace') {
            const t = tokens[k];
            name += t.type === 'char' ? t.value : (t.type === 'command' ? t.value : ' ');
            k++;
        }
        if (!tokens[k]) return null;
        return { name: name.trim(), nextPos: k + 1 };
    }

    /** 讀取一個平衡的大括號群組，回傳內容的 token 切片（呼叫端已確認 tokens[pos] 是 lbrace） */
    function readGroupTokens() {
        const openAt = here();
        pos++;
        const body = [];
        let depth = 0;
        while (tokens[pos]) {
            const t = tokens[pos];
            if (t.type === 'lbrace') depth++;
            else if (t.type === 'rbrace') {
                if (depth === 0) { pos++; return body; }
                depth--;
            }
            body.push(t);
            pos++;
        }
        emit(diag, 'missing_rbrace', openAt);
        return body;
    }

    /** \begin{env} 之後：收集到對應 \end{env} 為止的 token 切片（支援同名巢狀）。
     *  找不到 \end{env} 時發 missing_rbrace（環境沒關＝群組沒關，沿用既有 rule 全集）。 */
    function readEnvBody(envName, beginAt) {
        const body = [];
        let depth = 0;
        while (tokens[pos]) {
            const t = tokens[pos];
            if (t.type === 'command' && (t.value === 'begin' || t.value === 'end')) {
                const g = peekGroupName(pos + 1);
                if (g && g.name === envName) {
                    if (t.value === 'end') {
                        if (depth === 0) { pos = g.nextPos; return body; }
                        depth--;
                    } else {
                        depth++;
                    }
                    while (pos < g.nextPos) body.push(tokens[pos++]);
                    continue;
                }
            }
            body.push(t);
            pos++;
        }
        emit(diag, 'missing_rbrace', beginAt);
        return body;
    }

    /** 矩陣本體 → 原生 OMML 矩陣（m:m）：列以 \\ 或 \cr 分隔、欄以 & 分隔（都只認大括號
     *  深度 0 的），再依環境包括號。回傳單一元件的陣列（parseScripted 可直接接上下標）。
     *  已知限制：巢狀環境當儲存格內容時，內層的 & 也會被當外層分隔——考卷實務上沒出現過。 */
    function renderMatrixBody(bodyToks, wrap) {
        const rows = [];
        let row = [];
        let cell = [];
        let depth = 0;
        const flushCell = () => { row.push(cell); cell = []; };
        const flushRow = () => { flushCell(); rows.push(row); row = []; };
        for (const t of bodyToks) {
            if (t.type === 'command' && t.value === 'hline') continue;   // 表格橫線：OMML 矩陣無對應物，略過
            if (t.type === 'lbrace') depth++;
            else if (t.type === 'rbrace') depth = Math.max(0, depth - 1);
            if (depth === 0) {
                if ((t.type === 'char' && t.value === '\\') || (t.type === 'command' && t.value === 'cr')) { flushRow(); continue; }
                if (t.type === 'char' && t.value === '&') { flushCell(); continue; }
            }
            cell.push(t);
        }
        flushRow();

        const kept = rows.filter(r => r.some(c => c.some(t => t.type !== 'space')));   // 只剩空白（或只剩被略過的 hline）的列不算
        if (kept.length === 0) return [mr(' ')];

        // Word 要求每一列的 m:e 數目相同：短的列補空儲存格
        const width = Math.max(...kept.map(r => r.length));

        const parseCell = (cellToks) => {
            let a = 0, b = cellToks.length;
            while (a < b && cellToks[a].type === 'space') a++;      // 儲存格頭尾的空白不進輸出
            while (b > a && cellToks[b - 1].type === 'space') b--;
            const seq = createParser(cellToks.slice(a, b), false, diag).parseSequence();
            return seq.length ? seq : [mr(' ')];                    // m:e 不得為空
        };

        const matrix = new MathMatrix(kept.map((cells) => {
            const padded = cells.concat(Array.from({ length: width - cells.length }, () => []));
            return new MathMatrixRow(padded.map(parseCell));
        }));
        return [wrap(matrix)];
    }

    // 解析一個參數（群組或單一原子），回傳 MathComponent 陣列
    function parseArg() {
        const t = tokens[pos];
        if (!t) return [mr(' ')];
        if (t.type === 'lbrace') {
            const openAt = here();
            pos++;
            const seq = parseSequenceUntilBrace();
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
            else emit(diag, 'missing_rbrace', openAt);
            return seq.length ? seq : [mr(' ')];
        }
        const atom = parseAtom();
        const arr = Array.isArray(atom) ? atom : (atom ? [atom] : []);
        return arr.length ? arr : [mr(' ')];
    }

    function parseSequenceUntilBrace() {
        const out = [];
        while (tokens[pos] && tokens[pos].type !== 'rbrace') {
            if (tokens[pos].type === 'space') { pos++; out.push(mr(' ')); continue; }
            const a = parseScripted();
            if (a == null) break;
            if (Array.isArray(a)) out.push(...a); else out.push(a);
        }
        return out;
    }

    // 主序列（受 stopCJK 控制）
    function parseSequence() {
        const out = [];
        while (pos < tokens.length) {
            if (atMathEnd()) break;
            if (tokens[pos].type === 'space') { pos++; out.push(mr(' ')); continue; }
            const a = parseScripted();
            if (a == null) break;
            if (Array.isArray(a)) out.push(...a); else out.push(a);
        }
        return out;
    }

    function parseScripted() {
        const baseNode = parseAtom();
        if (baseNode == null) return null;
        const baseArr = Array.isArray(baseNode) ? baseNode : [baseNode];

        let sub = null, sup = null;
        while (tokens[pos] && (tokens[pos].type === 'sup' || tokens[pos].type === 'sub')) {
            const kind = tokens[pos].type; const scriptAt = here(); pos++;
            // ^ / _ 後面什麼都沒有（字串結尾或群組立刻收尾）＝ 空的上下標框，
            // Word 會排出一個空白方格。fixture 的 `$F^$`／`$E^$` 走的就是這條。
            if (!tokens[pos] || tokens[pos].type === 'rbrace') emit(diag, 'bare_script', scriptAt);
            const arg = parseArg();
            if (kind === 'sup') sup = arg; else sub = arg;
        }
        if (sub && sup) return new MathSubSuperScript({ children: baseArr, subScript: sub, superScript: sup });
        if (sup) return new MathSuperScript({ children: baseArr, superScript: sup });
        if (sub) return new MathSubScript({ children: baseArr, subScript: sub });
        return baseArr;
    }

    function parseAtom() {
        const t = tokens[pos];
        if (!t) return null;
        if (t.type === 'rbrace') return null;
        if (t.type === 'sup' || t.type === 'sub') { pos++; return mr(t.type === 'sup' ? '^' : '_'); }
        if (t.type === 'lbrace') {
            const openAt = here();
            pos++;
            const seq = parseSequenceUntilBrace();
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
            else emit(diag, 'missing_rbrace', openAt);
            return seq;
        }
        if (t.type === 'space') { pos++; return mr(' '); }
        if (t.type === 'char') { pos++; return mr(t.value); }
        if (t.type === 'command') { const at = here(); pos++; return parseCommand(t.value, at); }
        pos++; return null;
    }

    function parseCommand(name, at = 0) {
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
            const num = parseArg();
            const den = parseArg();
            return new MathFraction({ numerator: num, denominator: den });
        }
        if (name === 'sqrt') {
            let degree = null;
            if (tokens[pos] && tokens[pos].type === 'char' && tokens[pos].value === '[') {
                pos++;
                const degToks = [];
                while (tokens[pos] && !(tokens[pos].type === 'char' && tokens[pos].value === ']')) {
                    degToks.push(tokens[pos++]);
                }
                if (tokens[pos]) pos++; // skip ]
                const dp = createParser(degToks, false, diag);
                degree = dp.parseSequence();
            }
            const body = parseArg();
            return degree && degree.length
                ? new MathRadical({ children: body, degree })
                : new MathRadical({ children: body });
        }
        if (name === 'sum' || name === 'int') {
            let sub = null, sup = null;
            while (tokens[pos] && (tokens[pos].type === 'sup' || tokens[pos].type === 'sub')) {
                const kind = tokens[pos].type; pos++;
                const arg = parseArg();
                if (kind === 'sup') sup = arg; else sub = arg;
            }
            while (tokens[pos] && tokens[pos].type === "space") pos++; // skip space before operand
            const bodyNode = parseScripted();
            const body = bodyNode == null ? [mr(" ")] : (Array.isArray(bodyNode) ? bodyNode : [bodyNode]);
            const opts = { children: body };
            if (sub) opts.subScript = sub;
            if (sup) opts.superScript = sup;
            return name === 'sum' ? new MathSum(opts) : new MathIntegral(opts);
        }
        if (name === 'lim') {
            if (tokens[pos] && tokens[pos].type === 'sub') {
                pos++;
                const limit = parseArg();
                return new MathLimitLower({ children: [mr('lim')], limit });
            }
            return mr('lim');
        }
        if (ACCENTS[name]) {
            const text = readRawGroupText();
            const marked = text.split('').map((ch) => ch + ACCENTS[name]).join('');
            return mr(marked || ' ');
        }
        if (name === 'left' || name === 'right') {
            // 取下一個字元當作括號符號（. 代表無）
            if (tokens[pos] && tokens[pos].type === 'char') {
                const ch = tokens[pos++].value;
                return ch === '.' ? null : mr(ch);
            }
            return null;
        }
        // 〔stage5 WS-B〕\mathrm 在 OMML 輸出為正體（docs/interfaces-stage5.md 第 4.2 條第 3 點）
        if (name === 'mathrm') return makeUpright(parseArg());
        if (name === 'text' || name === 'mathbf' ||
            name === 'mathit' || name === 'operatorname' || name === 'mbox') {
            return parseArg();
        }
        // 〔stage5 WS-B〕mhchem 的 \ce{…}：本體還原成字串 → ceToLatex 轉成一般 LaTeX → 同一個解析器。
        // 子解析器的事件一律記在 \ce 這個指令的位置（使用者看得到的是 \ce，不是轉出來的中間字串）。
        if (name === 'ce' && tokens[pos] && tokens[pos].type === 'lbrace') {
            const body = tokensToSource(readGroupTokens());
            const sub = diag ? [] : null;
            const children = createParser(tokenize(ceToLatex(body)), false, sub).parseSequence();
            if (sub) for (const e of sub) emit(diag, e.kind, at);
            return children.length ? children : [mr(' ')];
        }
        // 〔stage5 WS-B〕\xrightarrow[下]{上} 一族
        if (STRETCH_ARROWS[name]) {
            let below = null;
            if (tokens[pos] && tokens[pos].type === 'char' && tokens[pos].value === '[') {
                pos++;
                const belowToks = [];
                let depth = 0;
                while (tokens[pos] && !(depth === 0 && tokens[pos].type === 'char' && tokens[pos].value === ']')) {
                    if (tokens[pos].type === 'lbrace') depth++;
                    else if (tokens[pos].type === 'rbrace') depth--;
                    belowToks.push(tokens[pos++]);
                }
                if (tokens[pos]) pos++;   // skip ]
                below = createParser(belowToks, false, diag).parseSequence();
            }
            let above = null;
            if (tokens[pos] && tokens[pos].type === 'lbrace') {
                // 空群組 {} ＝沒有上方文字（parseArg 會回一個空白 run，這裡要分辨出來）
                const empty = tokens[pos + 1] && tokens[pos + 1].type === 'rbrace';
                const arg = parseArg();
                above = empty ? null : arg;
            }
            return arrowWithText(STRETCH_ARROWS[name], above, below);
        }
        // 〔stage5 WS-B〕同位素前標：\prescript{上}{下}{本體}（ceToLatex 的 ^{14}_{6}C 會轉成這個）
        if (name === 'prescript') {
            // 空的上／下標群組（^{235}U 沒有原子序）給空的 m:sub，不留一個空白字元
            const emptyAt = (k) => tokens[k] && tokens[k].type === 'lbrace' && tokens[k + 1] && tokens[k + 1].type === 'rbrace';
            const supEmpty = emptyAt(pos);
            const sup = parseArg();
            const subEmpty = emptyAt(pos);
            const sub = parseArg();
            const body = parseArg();
            return preScript(supEmpty ? [] : sup, subEmpty ? [] : sub, body);
        }
        if (name === 'mathbb' || name === 'mathcal' || name === 'mathfrak' || name === 'boldsymbol') {
            // 黑板粗體只對單一拉丁字母有 Unicode 對應（ℝ、ℕ…）；其餘（含 \mathcal 等）照字面輸出
            const text = readRawGroupText();
            const mapped = name === 'mathbb' ? text.split('').map((ch) => BLACKBOARD[ch] || ch).join('') : text;
            return mr(mapped || ' ');
        }
        if (name === 'hline') return mr(' ');   // 表格橫線落在矩陣環境外：不破版、不算未知指令
        if (name === 'begin') {
            // \begin{env}：矩陣類環境以線性形式呈現（MATRIX_ENVS 的說明見檔頭）。
            // 不認得的環境維持既有的 unknown_command 路徑（peekGroupName 只窺看不消耗，
            // 群組會照舊被當一般群組解析，輸出與改動前逐位元相同）。
            const g = peekGroupName(pos);
            const wrap = g ? MATRIX_ENVS[g.name] : undefined;
            if (wrap) {
                pos = g.nextPos;
                // array 環境緊接的群組是欄位格式（{ccc}），不是內容
                if (g.name === 'array' && tokens[pos] && tokens[pos].type === 'lbrace') readGroupTokens();
                return renderMatrixBody(readEnvBody(g.name, at), wrap);
            }
            emit(diag, 'unknown_command', at);
            return mr(name);
        }
        if (name === 'end') {
            // 落單的 \end{…}（缺 \begin 或環境名不成對）：維持未知指令的既有語意
            emit(diag, 'unknown_command', at);
            return mr(name);
        }
        if ((name === 'matrix' || name === 'pmatrix' || name === 'bmatrix' || name === 'cases')
            && tokens[pos] && tokens[pos].type === 'lbrace') {
            // 舊式 plain TeX 寫法 \matrix{…}／\cases{…}——考卷數位化的模型輸出常見
            //（job #5 實測；分隔符常搭 \left[ \right]，所以 \matrix 本身不帶括號）
            return renderMatrixBody(readGroupTokens(), MATRIX_ENVS[name]);
        }
        if (name === 'cr') return mr('; ');   // 矩陣列分隔落在環境外時的可讀退路
        if (FUNCTIONS.has(name)) return mr(name);
        if (GREEK[name]) return mr(GREEK[name]);
        if (SYMBOLS[name]) return mr(SYMBOLS[name]);
        if (EXTRA_SYMBOLS[name]) return mr(EXTRA_SYMBOLS[name]);   // 〔stage5 WS-B〕
        // 未知指令：去掉反斜線輸出名稱，避免破版
        emit(diag, 'unknown_command', at);
        return mr(name);
    }

    return { parseSequence, getPos: () => pos };
}

// 解析一段「純數學」字串 → MathComponent 陣列
// diag / base 為 A-T4 新增的選用參數，不傳時行為與動工前完全相同。
function parseLatexToMath(str, diag = null, base = 0) {
    try {
        const parser = createParser(tokenize(str, base), false, diag);
        const children = parser.parseSequence();
        if (children.length) return children;
        emit(diag, 'empty_fallback', base);
        return [mr(stripUnsafe(str))];
    } catch (e) {
        emit(diag, 'parser_error', base);
        return [mr(stripUnsafe(str).replace(/[\\{}^_$]/g, ''))];
    }
}

// 中英混排：把一段文字拆成 TextRun(純文字) 與 Math(公式)
function renderMixedInto(out, text, opts, diag = null, base = 0) {
    let tokens;
    try { tokens = tokenize(text, base); } catch (e) { emit(diag, 'tokenize_error', base); out.push(new TextRun({ text, ...opts })); return; }
    let i = 0;
    let buf = '';
    const flush = () => { if (buf) { out.push(new TextRun({ text: buf, ...opts })); buf = ''; } };
    const tokenToText = (t) => t.type === 'char' ? t.value : (t.type === 'space' ? ' ' : (t.value || ''));

    const spanFrom = (startIdx, seedChar) => {
        const slice = seedChar != null
            ? [{ type: 'char', value: seedChar }, ...tokens.slice(startIdx)]
            : tokens.slice(startIdx);
        const p = createParser(slice, true, diag);
        const children = p.parseSequence();
        const consumed = p.getPos() - (seedChar != null ? 1 : 0);
        return { children, endIdx: startIdx + consumed };
    };

    while (i < tokens.length) {
        const t = tokens[i];
        if (t.type === 'command' || t.type === 'lbrace') {
            flush();
            const { children, endIdx } = spanFrom(i, null);
            if (children.length && endIdx > i) { out.push(new DocxMath({ children })); i = endIdx; }
            // 指令或群組解析不出任何元件（例如空群組 `{}`）：整個 token 退成字面文字
            else { emit(diag, 'bare_script', t.at); buf += tokenToText(t); i++; }
        } else if (t.type === 'sup' || t.type === 'sub') {
            const mb = buf.match(/([A-Za-z0-9\)\]\}])\s*$/);
            if (mb) {
                const base = mb[1];
                buf = buf.slice(0, mb.index);
                flush();
                const { children, endIdx } = spanFrom(i, base);
                if (children.length && endIdx > i) { out.push(new DocxMath({ children })); i = endIdx; }
                else { emit(diag, 'bare_script', t.at); buf += base + tokenToText(t); i++; }
            // 前面沒有可當底的字元（「答案：___」這種）：^ / _ 就是字面上的符號
            } else { emit(diag, 'bare_script', t.at); buf += (t.type === 'sup' ? '^' : '_'); i++; }
        } else if (t.type === 'rbrace') { buf += '}'; i++; }
        else { buf += tokenToText(t); i++; }
    }
    flush();
}

// 對外主函式：相容舊簽名 buildParagraphComponents(text, textOptions)
// diag 為 A-T4 新增的選用診斷收集器（parseLatexStrict 用），不傳時行為與動工前完全相同。
function buildParagraphComponents(textStr, textOptions = {}, diag = null) {
    if (!textStr) return [];
    let s = foldDisplayMath(stripUnsafe(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    const lines = s.split('\n');
    const comps = [];

    const delimRe = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

    // lineBase：本行第一個字元在 s 中的位置（事件的 at 以 s 為基準）
    let lineBase = 0;
    lines.forEach((line, idx) => {
        delimRe.lastIndex = 0;
        let last = 0, m;
        while ((m = delimRe.exec(line)) !== null) {
            if (m.index > last) renderMixedInto(comps, line.slice(last, m.index), textOptions, diag, lineBase + last);
            const inner = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
            // 內文相對 m[0] 的位移＝左界定符長度（$$ / \[ / \( 是 2，$ 是 1）
            const delimLen = m[2] != null ? 1 : 2;
            const children = parseLatexToMath(inner, diag, lineBase + m.index + delimLen);
            if (children.length) comps.push(new DocxMath({ children }));
            last = m.index + m[0].length;
        }
        if (last < line.length) renderMixedInto(comps, line.slice(last), textOptions, diag, lineBase + last);
        if (idx < lines.length - 1) comps.push(new TextRun({ text: '', break: 1 }));
        lineBase += line.length + 1;   // +1 ＝ 被 split 吃掉的那個 \n
    });

    return comps;
}

// ───────────────────────── parseLatexStrict（A-T4 新匯出）─────────────────────────

/**
 * clean 是 raw 只做「刪字元」與「\r → \n」得到的字串，因此可用雙指標對齊。
 * @returns {number[]|null} map[i] = clean[i] 在 raw 中的索引；長度相同時回 null（位置即原位置）
 */
function buildOffsetMap(raw, clean) {
    if (raw.length === clean.length) return null;
    const map = new Array(clean.length);
    let r = 0;
    for (let i = 0; i < clean.length; i++) {
        while (r < raw.length && raw[r] !== clean[i] && !(clean[i] === '\n' && raw[r] === '\r')) r++;
        map[i] = r < raw.length ? r : raw.length;
        r++;
    }
    return map;
}

/**
 * 嚴格模式解析：同一個 parser，事件只收集、不改變輸出。
 * 既有的 parseLatexToMath / buildParagraphComponents 行為必須逐位元不變
 * （test/unit/textFormatter.test.js 的 29 項是契約）。
 *
 * @param {string} str
 * @returns {{ ok: boolean, children: object[], events: Array<{kind:string, at:number}> }}
 *          ok === (events.length === 0)；at = 事件發生處在 str 中的 0-based 字元位置
 */
function parseLatexStrict(str) {
    const raw = typeof str === 'string' ? str : (str == null ? '' : String(str));
    const events = [];
    const children = buildParagraphComponents(raw, {}, events);

    // 事件的 at 以「消毒後的字串」為基準（buildParagraphComponents 內的 s），映射回 str。
    const clean = stripUnsafe(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const map = buildOffsetMap(raw, clean);
    const mapped = events
        .map(e => ({ kind: e.kind, at: map ? (map[e.at] === undefined ? raw.length : map[e.at]) : e.at }))
        .sort((a, b) => a.at - b.at);

    return { ok: mapped.length === 0, children, events: mapped };
}

// 舊版相容（少數地方可能引用）
function xmlSafeClean(rawStr) {
    return stripUnsafe(rawStr || '');
}

// 對照表對外匯出（WS-C / D-E3）：utils/embedText.js 的 latexToPlain 重用同一份表，
// 才不會出現「Word 匯出看到 θ、embedding 看到 theta」這種兩套規則。
// ⚠️ 只加匯出，不改上面任何既有輸出——test/textFormatter.test.js 的 29 項是契約。
//
// A-T4（階段 2 WS-C）再加一個 parseLatexStrict：docs/interfaces-stage2.md 第 4.3 條。
// STRICT_EVENT_KINDS 是凍結的六個值，utils/formulaLint.js 與 eval 都以它為準。
const STRICT_EVENT_KINDS = Object.freeze([
    'unknown_command', 'missing_rbrace', 'empty_fallback',
    'parser_error', 'tokenize_error', 'bare_script'
]);

module.exports = {
    buildParagraphComponents, xmlSafeClean, parseLatexToMath,
    parseLatexStrict, STRICT_EVENT_KINDS, foldDisplayMath,
    GREEK, SYMBOLS, FUNCTIONS, ACCENTS, BLACKBOARD,
    // 〔stage5 WS-B〕化學排版（只給 Word 匯出與測試用；embedText 不讀這兩張表）
    EXTRA_SYMBOLS, STRETCH_ARROWS
};
