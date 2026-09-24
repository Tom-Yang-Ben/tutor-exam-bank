// ─────────────────────────────────────────────────────────────
// utils/chemFormula.js — 化學式（mhchem \ce{…} 子集）的純函式工具（階段 5 WS-B；DEC-019、ADR-010）
//
// docs/interfaces-stage5.md 第 4.2 條第 3、4 點。三個消費端共用同一套切法，不各寫一份：
//   1. utils/textFormatter.js —— \ce{…} → 等價的一般 LaTeX（ceToLatex），再交給既有的遞迴下降解析器
//      轉成 Word OMML。這樣 Word 端不必多一個解析器，formulaLint 也自然放行。
//   2. agents/source_check.js —— \ce{…} → 可與原卷文字層比對的純文字（ceToComparable）：
//      反應箭頭 `->` 若不先拿掉，會被原卷比對器當成多出來的負號。
//   3. utils/answerCompare.js —— 化學式／反應式的結構化解析（parseChemAnswer），
//      讓「相同化學式 agree、不同 disagree」（第 4.2 條第 4 點）。
//
// 支援的 mhchem 子集（第 4.2 條第 3 點；docs/chemistry.md 第 3 節有對照表）：
//   化學式下標（H2O）、離子電荷上標（Fe^{3+}、SO4^2-、Na+、Cl-）、係數（2H2、1/2O2、0.5O2）、
//   箭頭 ->、<-、<=>、<->（可帶 [上][下] 條件）、物態 (s)(l)(g)(aq)、氣體 ^、沉澱 v、
//   水合物的 .／*（CuSO4.5H2O）、括號與錯離子（Ca(OH)2、[Cu(NH3)4]^{2+}）、同位素前標（^{14}_{6}C）。
// 子集以外的寫法不丟例外：原樣包進 \mathrm{…}，Word 端照字面印出，formulaLint 不會因此擋題。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。
// ─────────────────────────────────────────────────────────────

/** 週期表 118 個元素符號（化學式解析時用來判斷「這是不是化學式」） */
const ELEMENTS = new Set((
    'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
    + 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb '
    + 'Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr '
    + 'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og D T'
).split(' '));

/** 箭頭（長的先比，<=> 不能先被 <- 吃掉一半） */
const ARROWS = [
    { src: '<=>', latex: '\\rightleftharpoons', stretch: '\\xrightleftharpoons', kind: 'eq' },
    { src: '<->', latex: '\\leftrightarrow', stretch: null, kind: 'resonance' },
    { src: '->', latex: '\\rightarrow', stretch: '\\xrightarrow', kind: 'forward' },
    { src: '<-', latex: '\\leftarrow', stretch: '\\xleftarrow', kind: 'backward' },
    { src: '⇌', latex: '\\rightleftharpoons', stretch: '\\xrightleftharpoons', kind: 'eq' },
    { src: '→', latex: '\\rightarrow', stretch: '\\xrightarrow', kind: 'forward' },
    { src: '←', latex: '\\leftarrow', stretch: '\\xleftarrow', kind: 'backward' }
];

const STATES = ['(s)', '(l)', '(g)', '(aq)'];
const STATE_SUFFIX_RE = /\((?:s|l|g|aq)\)$/;
const CJK_RE = /[㐀-鿿豈-﫿]/;

// ───────────────────────── 找出 \ce{…} ─────────────────────────

/**
 * 找出字串裡每一個 \ce{…}（大括號可巢狀；沒關的就吃到字串結尾）。
 * @param {string} text
 * @returns {Array<{start:number, end:number, body:string, closed:boolean}>} end 為右大括號之後的位置
 */
function findCe(text) {
    const s = String(text ?? '');
    const out = [];
    const re = /\\ce\s*\{/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        const bodyStart = i;
        for (; i < s.length && depth > 0; i++) {
            if (s[i] === '\\') { i++; continue; }
            if (s[i] === '{') depth++;
            else if (s[i] === '}') depth--;
        }
        const closed = depth === 0;
        const end = closed ? i : s.length;
        out.push({ start: m.index, end, body: s.slice(bodyStart, closed ? i - 1 : s.length), closed });
        re.lastIndex = end;
    }
    return out;
}

/**
 * 把每個 \ce{…} 換成 fn(body) 的結果。沒有 \ce 時原字串原樣回傳（同一個字串值）。
 * @param {string} text
 * @param {(body:string) => string} fn
 * @returns {string}
 */
function replaceCe(text, fn) {
    const s = String(text ?? '');
    const found = findCe(s);
    if (!found.length) return s;
    let out = '';
    let last = 0;
    for (const f of found) {
        out += s.slice(last, f.start) + fn(f.body);
        last = f.end;
    }
    return out + s.slice(last);
}

// ───────────────────────── 切段：箭頭與詞 ─────────────────────────

/** 讀 s[i] 起的一個 [...]（可巢狀）；不是 [ 開頭回 null */
function readBracket(s, i) {
    if (s[i] !== '[') return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '[') depth++;
        else if (s[j] === ']') {
            depth--;
            if (depth === 0) return { content: s.slice(i + 1, j), next: j + 1 };
        }
    }
    return null;   // 沒關：不當條件，讓它留在文字裡
}

/**
 * mhchem 本體 → [{type:'text', text} | {type:'arrow', arrow, above, below}]
 * 箭頭後面緊接的 [上][下] 是箭頭條件。
 */
function splitArrows(body) {
    const s = String(body ?? '');
    const segs = [];
    let buf = '';
    let depth = 0;          // 大括號內的 -> 不是箭頭（例如 ^{…} 裡）
    for (let i = 0; i < s.length;) {
        const ch = s[i];
        if (ch === '\\') { buf += s.slice(i, i + 2); i += 2; continue; }
        if (ch === '{') depth++;
        if (ch === '}') depth = Math.max(0, depth - 1);
        const arrow = depth === 0 ? ARROWS.find(a => s.startsWith(a.src, i)) : null;
        if (arrow) {
            if (buf) segs.push({ type: 'text', text: buf });
            buf = '';
            let j = i + arrow.src.length;
            const above = readBracket(s, j);
            if (above) j = above.next;
            const below = above ? readBracket(s, j) : null;
            if (below) j = below.next;
            segs.push({ type: 'arrow', arrow, above: above ? above.content : '', below: below ? below.content : '' });
            i = j;
            continue;
        }
        buf += ch;
        i++;
    }
    if (buf) segs.push({ type: 'text', text: buf });
    return segs;
}

/** 以空白切詞；大括號內的空白不切（^{2 -} 這種寫法） */
function splitWords(text) {
    const words = [];
    let buf = '';
    let depth = 0;
    for (const ch of String(text)) {
        if (ch === '{') depth++;
        if (ch === '}') depth = Math.max(0, depth - 1);
        if (/\s/.test(ch) && depth === 0) {
            if (buf) words.push(buf);
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf) words.push(buf);
    return words;
}

/** 讀 s[i] 起的 {…}（可巢狀），回傳內容與下一個位置；不是 { 開頭回 null */
function readBrace(s, i) {
    if (s[i] !== '{') return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
            depth--;
            if (depth === 0) return { content: s.slice(i + 1, j), next: j + 1 };
        }
    }
    return { content: s.slice(i + 1), next: s.length };
}

/**
 * 讀一個上標或下標的內容（^ 或 _ 之後）：{…}、電荷（2-、3+、+、-）、或連續的數字／羅馬數字。
 * @returns {{content:string, next:number}|null}
 */
function readScript(s, i) {
    const brace = readBrace(s, i);
    if (brace) return brace;
    const m = /^(?:\d*[+\-]|[+\-]\d*|\d+|[IVX]+)/.exec(s.slice(i));
    if (m && m[0]) return { content: m[0], next: i + m[0].length };
    return null;
}

// ───────────────────────── ceToLatex ─────────────────────────

/** 係數：分數 a/b、小數、整數（在化學式前面） */
const COEF_RE = /^(\d+\/\d+|\d+(?:\.\d+)?)(?=[A-Z(\[^_]|e(?:-|\^)|$)/;

/** 係數字串 → LaTeX（1/2 → \frac{1}{2}） */
function coefLatex(coef) {
    const frac = /^(\d+)\/(\d+)$/.exec(coef);
    return frac ? `\\frac{${frac[1]}}{${frac[2]}}` : coef;
}

/**
 * 單一化學式本體（不含係數、物態）→ \mathrm{…} 內的 LaTeX。
 * 元素或右括號後的數字是下標；^ 與 _ 讀一個 script；結尾的 + / - 是電荷。
 */
function formulaBodyLatex(body) {
    const s = String(body);
    let out = '';
    let prevAtom = false;         // 前一個是元素、右括號或右方括號（後面的數字才是下標）
    for (let i = 0; i < s.length;) {
        const ch = s[i];
        if (/[A-Z]/.test(ch)) {
            const sym = /^[A-Z][a-z]?/.exec(s.slice(i))[0];
            // 兩個字母的符號不在週期表裡時只取第一個字母（例如 Co 是鈷，但 CO 本來就是兩個大寫）
            const take = sym.length === 2 && !ELEMENTS.has(sym) && ELEMENTS.has(sym[0]) ? 1 : sym.length;
            out += s.slice(i, i + take);
            i += take;
            prevAtom = true;
            continue;
        }
        if (/[a-z]/.test(ch)) { out += ch; i++; prevAtom = true; continue; }   // e（電子）與其他小寫字
        if (/\d/.test(ch)) {
            const digits = /^\d+/.exec(s.slice(i))[0];
            const rest = s.slice(i + digits.length);
            // 數字後面緊接結尾的 +／-：mhchem 把「Fe3+」讀成下標 3、電荷 +，這裡照同一個規則
            out += prevAtom ? `_{${digits}}` : digits;
            i += digits.length;
            if (!prevAtom && /^[+\-]$/.test(rest)) { out += `^{${rest}}`; i = s.length; }
            continue;
        }
        if (ch === '(' || ch === '[') { out += ch; i++; prevAtom = false; continue; }
        if (ch === ')' || ch === ']') { out += ch; i++; prevAtom = true; continue; }
        if (ch === '^' || ch === '_') {
            const script = readScript(s, i + 1);
            if (script) {
                out += `${ch}{${script.content}}`;
                i = script.next;
            } else {
                i++;              // 落單的 ^／_：丟掉，不留空的上下標框
            }
            continue;
        }
        if ((ch === '+' || ch === '-') && i === s.length - 1) { out += `^{${ch}}`; i++; continue; }
        if (ch === '=') { out += '='; i++; prevAtom = false; continue; }
        if (ch === '#') { out += '\\equiv '; i++; prevAtom = false; continue; }
        if (ch === '{' ) {
            const brace = readBrace(s, i);
            out += `{${brace.content}}`;
            i = brace.next;
            continue;
        }
        out += ch;
        i++;
        prevAtom = false;
    }
    return out;
}

/**
 * 一個化學式（可能帶水合物與物態，不含係數）→ LaTeX。
 * 水合物：. * · 後面接數字或大寫字母時視為結晶水的點（CuSO4.5H2O）。
 */
function formulaLatex(text) {
    let s = String(text);
    let state = '';
    const st = STATE_SUFFIX_RE.exec(s);
    if (st && s.length > st[0].length) { state = `\\mathrm{${st[0]}}`; s = s.slice(0, -st[0].length); }

    const parts = s.split(/[.*·•](?=\d|[A-Z(\[])/);
    const latex = parts.map((p, k) => {
        if (k === 0) return speciesLatex(p);
        const c = COEF_RE.exec(p);
        return c ? `${coefLatex(c[1])}${speciesLatex(p.slice(c[1].length))}` : speciesLatex(p);
    }).join('\\cdot ');
    return latex + state;
}

/** 同位素前標（^{14}_{6}C、^{235}U）→ \prescript；其餘 → \mathrm{…} */
function speciesLatex(p) {
    if (!p) return '';
    const pre = /^\^(\{[^{}]*\}|\d+)(?:_(\{[^{}]*\}|\d+))?(?=[A-Z])/.exec(p);
    if (pre) {
        const sup = pre[1].replace(/^\{|\}$/g, '');
        const sub = pre[2] ? pre[2].replace(/^\{|\}$/g, '') : '';
        return `\\prescript{${sup}}{${sub}}{\\mathrm{${formulaBodyLatex(p.slice(pre[0].length))}}}`;
    }
    return `\\mathrm{${formulaBodyLatex(p)}}`;
}

/** 箭頭條件（[ ] 內）→ LaTeX：有中文用 \text；$…$ 原樣；其餘當化學式轉 */
function conditionLatex(content) {
    const c = String(content ?? '').trim();
    if (!c) return '';
    if (/^\$[\s\S]*\$$/.test(c)) return c.slice(1, -1);
    if (c.startsWith('\\')) return c;                       // 已經是 LaTeX（\Delta、\text{加熱}）：原樣
    if (CJK_RE.test(c)) return `\\text{${c.replace(/[{}]/g, '')}}`;
    const unbraced = /^\{([\s\S]*)\}$/.exec(c);
    if (unbraced) return `\\text{${unbraced[1]}}`;
    return ceToLatex(c);
}

/** 一個詞（空白切出來的）→ LaTeX */
function wordLatex(word) {
    const w = String(word);
    if (w === '+') return '+';
    if (w === '^') return '\\uparrow';
    if (w === 'v') return '\\downarrow';
    if (STATES.includes(w)) return `\\mathrm{${w}}`;
    if (w.startsWith('\\')) return w;                       // 已經是 LaTeX 指令（\Delta、\text{…}）
    if (/^\$[\s\S]*\$$/.test(w)) return w.slice(1, -1);
    if (CJK_RE.test(w)) return `\\text{${w.replace(/[{}]/g, '')}}`;
    if (/^[=:,;]+$/.test(w)) return w;
    const c = COEF_RE.exec(w);
    if (c) {
        const rest = w.slice(c[1].length);
        return rest ? `${coefLatex(c[1])}${formulaLatex(rest)}` : coefLatex(c[1]);
    }
    return formulaLatex(w);
}

/**
 * mhchem 的 \ce{…} 本體 → 等價的一般 LaTeX（給 utils/textFormatter.js 用）。
 *
 *   ceToLatex('2H2 + O2 -> 2H2O')
 *     → '2\mathrm{H_{2}} + \mathrm{O_{2}} \rightarrow 2\mathrm{H_{2}O}'
 *   ceToLatex('SO4^{2-}')      → '\mathrm{SO_{4}^{2-}}'
 *   ceToLatex('A ->[\Delta][加熱] B') → '\mathrm{A} \xrightarrow[\text{加熱}]{\Delta} \mathrm{B}'
 *
 * @param {string} body
 * @returns {string}
 */
function ceToLatex(body) {
    const out = [];
    for (const seg of splitArrows(body)) {
        if (seg.type === 'arrow') {
            const above = conditionLatex(seg.above);
            const below = conditionLatex(seg.below);
            if ((above || below) && seg.arrow.stretch) {
                out.push(below ? `${seg.arrow.stretch}[${below}]{${above}}` : `${seg.arrow.stretch}{${above}}`);
            } else {
                out.push(seg.arrow.latex);
            }
            continue;
        }
        for (const w of splitWords(seg.text)) out.push(wordLatex(w));
    }
    return out.join(' ');
}

// ───────────────────────── ceToComparable（原卷比對用）─────────────────────────

/**
 * \ce{…} 本體 → 與原卷文字層比對用的純文字。
 * 箭頭、氣體／沉澱記號拿掉（原卷上是 → ↑ ↓，不是負號）；上下標的 ^ _ { } 拿掉，
 * 電荷的 + - 與數字保留（原卷文字層上的 SO₄²⁻ 經 NFKC 後同樣是 SO42-）。
 * @param {string} body
 * @returns {string}
 */
function ceToComparable(body) {
    const out = [];
    for (const seg of splitArrows(body)) {
        if (seg.type === 'arrow') {
            out.push(' ');
            // 箭頭條件（催化劑、溫度）原卷上印在箭頭上下，文字仍在
            for (const cond of [seg.above, seg.below]) {
                if (cond) out.push(String(cond).replace(/\\[A-Za-z]+/g, ' ').replace(/[{}$^_]/g, ' '));
            }
            continue;
        }
        for (const w of splitWords(seg.text)) {
            if (w === '^' || w === 'v') continue;
            out.push(w.replace(/[{}^_]/g, ''));
        }
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
}

// ───────────────────────── 結構化解析（答案比對用）─────────────────────────

const SUPERSCRIPT_MAP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };
const SUBSCRIPT_MAP = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

/** \mathrm{…}、\text{…}、\rm{…}、\mathbf{…} 拆殼（大括號可巢狀：\mathrm{SO_4^{2-}}） */
function unwrapMacros(text) {
    let s = String(text);
    const re = /\\(?:mathrm|text|rm|mathbf)\s*\{/;
    for (let guard = 0; guard < 50; guard++) {
        const m = re.exec(s);
        if (!m) break;
        const brace = readBrace(s, m.index + m[0].length - 1);
        s = s.slice(0, m.index) + brace.content + s.slice(brace.next);
    }
    return s;
}

/**
 * 答案字串 → mhchem 風格的本體。
 *   有 \ce{…}：取出本體（多個時以 ' , ' 串接，當作物種清單）；
 *   沒有：去掉 $、\mathrm{…}／\text{…} 外殼、_{n} → n、Unicode 上下標 → ^{…}／數字。
 */
function toCeBody(str) {
    let s = String(str ?? '');
    const ces = findCe(s);
    if (ces.length) return ces.map(c => c.body).join(' , ');
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (m) => `^{${[...m].map(ch => SUPERSCRIPT_MAP[ch]).join('')}}`)
        .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (ch) => SUBSCRIPT_MAP[ch]);
    s = unwrapMacros(s.replace(/\$/g, ' '));
    s = s.replace(/_\{(\d+)\}/g, '$1').replace(/_(\d)/g, '$1')
        .replace(/\\(?:rightarrow|to|longrightarrow)\b/g, ' -> ')
        .replace(/\\(?:rightleftharpoons|leftrightharpoons)\b/g, ' <=> ')
        .replace(/\\leftarrow\b/g, ' <- ')
        .replace(/\\cdot\b/g, '.')
        .replace(/\\,|\\;|\\ /g, ' ');
    return s.trim();
}

/**
 * 解析單一物種（化學式，可帶係數、水合物、電荷、物態）。
 * @returns {{coef:number, canonical:string, elements:Object<string,number>, charge:number|null}|null}
 *          不像化學式（出現週期表外的符號、多餘字元、沒有任何元素）回 null。
 */
function parseSpecies(word) {
    let w = String(word ?? '').trim();
    if (!w) return null;
    let coef = 1;
    const c = COEF_RE.exec(w);
    if (c) {
        const frac = /^(\d+)\/(\d+)$/.exec(c[1]);
        coef = frac ? Number(frac[1]) / Number(frac[2]) : Number(c[1]);
        w = w.slice(c[1].length);
        if (!w) return null;
    }
    // 電子（半反應）：沒有元素，但是合法的物種
    if (w === 'e-' || w === 'e^-' || w === 'e^{-}') return { coef, canonical: 'e^-', elements: {}, charge: -1 };
    const st = STATE_SUFFIX_RE.exec(w);
    if (st && w.length > st[0].length) w = w.slice(0, -st[0].length);

    const parts = w.split(/[.*·•](?=\d|[A-Z(\[])/);
    const elements = {};
    const canon = [];
    let charge = null;
    for (let k = 0; k < parts.length; k++) {
        let p = parts[k];
        let mult = 1;
        if (k > 0) {
            const hc = COEF_RE.exec(p);
            if (hc) { mult = Number(hc[1]); p = p.slice(hc[1].length); }
        }
        const r = parseFormulaBody(p);
        if (!r) return null;
        for (const [el, n] of Object.entries(r.elements)) elements[el] = (elements[el] || 0) + n * mult;
        if (r.charge !== null) charge = (charge || 0) + r.charge * mult;
        canon.push((k > 0 && mult !== 1 ? String(mult) : '') + r.canonical);
    }
    if (!Object.keys(elements).length) return null;
    return { coef, canonical: canon.join('·'), elements, charge };
}

/**
 * 化學式本體（無係數、無物態）→ 元素計數、電荷與正規化字串。
 * 正規化字串：去掉 _ 與 {}，電荷寫成 ^2-／^+（量值 1 省略），元素順序照原樣（不重排）。
 */
function parseFormulaBody(body) {
    const s = String(body ?? '');
    const stack = [{}];
    let canonical = '';
    let charge = null;
    let lastGroup = null;     // 最近一個可被下標乘的單位：{el} 或 {group}
    for (let i = 0; i < s.length;) {
        const ch = s[i];
        if (/[A-Z]/.test(ch)) {
            let sym = /^[A-Z][a-z]?/.exec(s.slice(i))[0];
            if (sym.length === 2 && !ELEMENTS.has(sym)) sym = sym[0];
            if (!ELEMENTS.has(sym)) return null;
            const top = stack[stack.length - 1];
            top[sym] = (top[sym] || 0) + 1;
            lastGroup = { el: sym, counts: null };
            canonical += sym;
            i += sym.length;
            continue;
        }
        if (/\d/.test(ch) || ch === '_') {
            let n;
            if (ch === '_') {
                const sc = readScript(s, i + 1);
                if (!sc || !/^\d+$/.test(sc.content)) return null;
                n = Number(sc.content);
                i = sc.next;
            } else {
                const digits = /^\d+/.exec(s.slice(i))[0];
                n = Number(digits);
                i += digits.length;
                // 「Fe3+」：結尾的 +／- 前面的數字仍是下標（mhchem 的讀法），不在這裡特判
            }
            if (!lastGroup) return null;
            const top = stack[stack.length - 1];
            if (lastGroup.el) top[lastGroup.el] += n - 1;
            else for (const [el, k] of Object.entries(lastGroup.counts)) top[el] = (top[el] || 0) + k * (n - 1);
            canonical += String(n);
            lastGroup = null;
            continue;
        }
        if (ch === '(' || ch === '[') { stack.push({}); canonical += ch; i++; lastGroup = null; continue; }
        if (ch === ')' || ch === ']') {
            if (stack.length < 2) return null;
            const inner = stack.pop();
            const top = stack[stack.length - 1];
            for (const [el, k] of Object.entries(inner)) top[el] = (top[el] || 0) + k;
            lastGroup = { el: null, counts: inner };
            canonical += ch;
            i++;
            continue;
        }
        if (ch === '^') {
            const sc = readScript(s, i + 1);
            if (!sc) return null;
            const q = parseCharge(sc.content);
            if (q === undefined) return null;
            charge = q;
            i = sc.next;
            lastGroup = null;
            continue;
        }
        if ((ch === '+' || ch === '-') && i === s.length - 1) { charge = ch === '+' ? 1 : -1; i++; continue; }
        return null;   // 其他字元（小寫字母開頭、運算子、中文）＝不像化學式
    }
    if (stack.length !== 1) return null;
    const elements = stack[0];
    const q = charge === null || charge === 0 ? '' : `^${Math.abs(charge) === 1 ? '' : Math.abs(charge)}${charge > 0 ? '+' : '-'}`;
    return { elements, charge: charge === 0 ? null : charge, canonical: canonical + q };
}

/** 電荷內容（2-、+3、-、III）→ 帶號整數；看不懂回 undefined；羅馬數字（氧化態）回 null */
function parseCharge(content) {
    const c = String(content).replace(/\s+/g, '').replace(/−/g, '-');
    if (/^[IVX]+$/.test(c)) return null;
    let m = /^(\d*)([+\-])$/.exec(c);
    if (m) return (m[2] === '+' ? 1 : -1) * (m[1] ? Number(m[1]) : 1);
    m = /^([+\-])(\d+)$/.exec(c);
    if (m) return (m[1] === '+' ? 1 : -1) * Number(m[2]);
    return undefined;
}

/**
 * 答案 → 結構：反應式 {kind:'equation', left, right} 或物種清單 {kind:'species', items}。
 * 任何一個詞不像化學式就整個回 null（呼叫端退回既有的比法，不硬判）。
 * @param {string} str
 * @returns {{kind:'equation', left:Array, right:Array}|{kind:'species', items:Array}|null}
 */
function parseChemAnswer(str) {
    const body = toCeBody(str);
    if (!body) return null;
    const segs = splitArrows(body);
    const arrows = segs.filter(s => s.type === 'arrow');
    if (arrows.length > 1) return null;

    const termsOf = (text) => {
        const items = [];
        for (const w of splitWords(text)) {
            if (w === '+' || w === ',' || w === '，' || w === '、' || w === '^' || w === 'v' || STATES.includes(w)) continue;
            // 「H2O,」這種黏著的分隔符
            for (const piece of w.split(/[,，、]/).filter(Boolean)) {
                const sp = parseSpecies(piece);
                if (!sp) return null;
                items.push(sp);
            }
        }
        return items;
    };

    if (arrows.length === 1) {
        const at = segs.indexOf(arrows[0]);
        const left = termsOf(segs.slice(0, at).filter(s => s.type === 'text').map(s => s.text).join(' '));
        const right = termsOf(segs.slice(at + 1).filter(s => s.type === 'text').map(s => s.text).join(' '));
        if (!left || !right || !left.length || !right.length) return null;
        return { kind: 'equation', left, right };
    }
    const items = termsOf(body);
    if (!items || !items.length) return null;
    return { kind: 'species', items };
}

module.exports = {
    ELEMENTS, ARROWS,
    findCe, replaceCe, splitArrows,
    ceToLatex, ceToComparable,
    parseSpecies, parseFormulaBody, parseChemAnswer, toCeBody
};
