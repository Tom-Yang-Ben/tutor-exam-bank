const {
    Math: DocxMath, MathRun, MathFraction, MathSuperScript, MathSubScript,
    MathSubSuperScript, MathRadical, MathSum, MathIntegral, MathLimitLower, TextRun
} = require('docx');

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
    therefore: '∴', degree: '°', backslash: '\\', percent: '%'
};

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

const isCJK = (ch) => /[⺀-鿿　-〿＀-￯㐀-䶿]/.test(ch);

// 清掉 emoji 與控制字元（保留所有數學語法）
function stripUnsafe(str) {
    return String(str)
        .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F0FF}]|[\u{1F1E6}-\u{1F1FF}]|️/gu, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ───────────────────────── Tokenizer ─────────────────────────
function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') {
            let j = i + 1;
            if (j < s.length && /[A-Za-z]/.test(s[j])) {
                let name = '';
                while (j < s.length && /[A-Za-z]/.test(s[j])) { name += s[j]; j++; }
                toks.push({ type: 'command', value: name });
                i = j;
            } else {
                const ch = s[j] !== undefined ? s[j] : '';
                if (ch === ',' || ch === ';' || ch === '!' || ch === ' ' || ch === ':' || ch === '>') {
                    toks.push({ type: 'space', value: ' ' });
                } else {
                    toks.push({ type: 'char', value: ch });
                }
                i = j + 1;
            }
        } else if (c === '{') { toks.push({ type: 'lbrace' }); i++; }
        else if (c === '}') { toks.push({ type: 'rbrace' }); i++; }
        else if (c === '^') { toks.push({ type: 'sup' }); i++; }
        else if (c === '_') { toks.push({ type: 'sub' }); i++; }
        else if (c === ' ' || c === '\t') { toks.push({ type: 'space', value: ' ' }); i++; }
        else { toks.push({ type: 'char', value: c }); i++; }
    }
    return toks;
}

const mr = (t) => new MathRun(t && t.length ? t : ' ');

// ───────────────────────── 遞迴解析器 ─────────────────────────
function createParser(tokens, stopCJK) {
    let pos = 0;

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
            pos++;
            while (tokens[pos] && tokens[pos].type !== 'rbrace') {
                const t = tokens[pos++];
                if (t.type === 'char') text += t.value;
                else if (t.type === 'space') text += ' ';
                else if (t.type === 'command') text += (GREEK[t.value] || SYMBOLS[t.value] || t.value);
            }
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
        } else {
            const t = tokens[pos++];
            if (t) {
                if (t.type === 'char') text = t.value;
                else if (t.type === 'command') text = (GREEK[t.value] || SYMBOLS[t.value] || t.value);
            }
        }
        return text;
    }

    // 解析一個參數（群組或單一原子），回傳 MathComponent 陣列
    function parseArg() {
        const t = tokens[pos];
        if (!t) return [mr(' ')];
        if (t.type === 'lbrace') {
            pos++;
            const seq = parseSequenceUntilBrace();
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
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
            const kind = tokens[pos].type; pos++;
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
            pos++;
            const seq = parseSequenceUntilBrace();
            if (tokens[pos] && tokens[pos].type === 'rbrace') pos++;
            return seq;
        }
        if (t.type === 'space') { pos++; return mr(' '); }
        if (t.type === 'char') { pos++; return mr(t.value); }
        if (t.type === 'command') { pos++; return parseCommand(t.value); }
        pos++; return null;
    }

    function parseCommand(name) {
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
                const dp = createParser(degToks, false);
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
        if (name === 'text' || name === 'mathrm' || name === 'mathbf' ||
            name === 'mathit' || name === 'operatorname' || name === 'mbox') {
            return parseArg();
        }
        if (FUNCTIONS.has(name)) return mr(name);
        if (GREEK[name]) return mr(GREEK[name]);
        if (SYMBOLS[name]) return mr(SYMBOLS[name]);
        // 未知指令：去掉反斜線輸出名稱，避免破版
        return mr(name);
    }

    return { parseSequence, getPos: () => pos };
}

// 解析一段「純數學」字串 → MathComponent 陣列
function parseLatexToMath(str) {
    try {
        const parser = createParser(tokenize(str), false);
        const children = parser.parseSequence();
        return children.length ? children : [mr(stripUnsafe(str))];
    } catch (e) {
        return [mr(stripUnsafe(str).replace(/[\\{}^_$]/g, ''))];
    }
}

// 中英混排：把一段文字拆成 TextRun(純文字) 與 Math(公式)
function renderMixedInto(out, text, opts) {
    let tokens;
    try { tokens = tokenize(text); } catch (e) { out.push(new TextRun({ text, ...opts })); return; }
    let i = 0;
    let buf = '';
    const flush = () => { if (buf) { out.push(new TextRun({ text: buf, ...opts })); buf = ''; } };
    const tokenToText = (t) => t.type === 'char' ? t.value : (t.type === 'space' ? ' ' : (t.value || ''));

    const spanFrom = (startIdx, seedChar) => {
        const slice = seedChar != null
            ? [{ type: 'char', value: seedChar }, ...tokens.slice(startIdx)]
            : tokens.slice(startIdx);
        const p = createParser(slice, true);
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
            else { buf += tokenToText(t); i++; }
        } else if (t.type === 'sup' || t.type === 'sub') {
            const mb = buf.match(/([A-Za-z0-9\)\]\}])\s*$/);
            if (mb) {
                const base = mb[1];
                buf = buf.slice(0, mb.index);
                flush();
                const { children, endIdx } = spanFrom(i, base);
                if (children.length && endIdx > i) { out.push(new DocxMath({ children })); i = endIdx; }
                else { buf += base + tokenToText(t); i++; }
            } else { buf += (t.type === 'sup' ? '^' : '_'); i++; }
        } else if (t.type === 'rbrace') { buf += '}'; i++; }
        else { buf += tokenToText(t); i++; }
    }
    flush();
}

// 對外主函式：相容舊簽名 buildParagraphComponents(text, textOptions)
function buildParagraphComponents(textStr, textOptions = {}) {
    if (!textStr) return [];
    let s = stripUnsafe(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = s.split('\n');
    const comps = [];

    const delimRe = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

    lines.forEach((line, idx) => {
        delimRe.lastIndex = 0;
        let last = 0, m;
        while ((m = delimRe.exec(line)) !== null) {
            if (m.index > last) renderMixedInto(comps, line.slice(last, m.index), textOptions);
            const inner = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
            const children = parseLatexToMath(inner);
            if (children.length) comps.push(new DocxMath({ children }));
            last = m.index + m[0].length;
        }
        if (last < line.length) renderMixedInto(comps, line.slice(last), textOptions);
        if (idx < lines.length - 1) comps.push(new TextRun({ text: '', break: 1 }));
    });

    return comps;
}

// 舊版相容（少數地方可能引用）
function xmlSafeClean(rawStr) {
    return stripUnsafe(rawStr || '');
}

// 對照表對外匯出（WS-C / D-E3）：utils/embedText.js 的 latexToPlain 重用同一份表，
// 才不會出現「Word 匯出看到 θ、embedding 看到 theta」這種兩套規則。
// ⚠️ 只加匯出，不改上面任何既有輸出——test/textFormatter.test.js 的 29 項是契約。
module.exports = { buildParagraphComponents, xmlSafeClean, parseLatexToMath, GREEK, SYMBOLS, FUNCTIONS, ACCENTS };
