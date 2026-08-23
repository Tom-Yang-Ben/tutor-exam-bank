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
        if (name === 'text' || name === 'mathrm' || name === 'mathbf' ||
            name === 'mathit' || name === 'operatorname' || name === 'mbox') {
            return parseArg();
        }
        if (FUNCTIONS.has(name)) return mr(name);
        if (GREEK[name]) return mr(GREEK[name]);
        if (SYMBOLS[name]) return mr(SYMBOLS[name]);
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
    let s = stripUnsafe(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    parseLatexStrict, STRICT_EVENT_KINDS,
    GREEK, SYMBOLS, FUNCTIONS, ACCENTS
};
