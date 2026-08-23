// utils/formulaLint.js — 入庫前的公式硬閘門（A-T4 / WS-C）
//
// docs/interfaces-stage2.md 第 4.4 條：
//   formulaLint(text) → { ok, issues:[{sev:'error'|'warn', rule, at, msg}] }
//   ok === issues.every(i => i.sev !== 'error')     ← 有 warn 仍然 ok
//
// 兩個來源，合成一份：
//   (a) audit_formulas.js:15-49 的六類規則（$ 不成對、大括號不對稱、斜線分數、
//       Unicode 數學符號、有 LaTeX 沒包 $、轉 Word 時丟例外）
//   (b) fix_formulas.js:57-72 的 isClean 判準（殘留標記、裸寫 frac/sqrt/ell、錯位的 $）
//   (c) utils/textFormatter.js 的 parseLatexStrict —— 真正跑一次解析器，
//       把「Word 匯出時會降級」的六種事件變成 issue。
//
// sev 的分級原則（介面第 4.4 條）：
//   error = 會讓 Word 匯出降級／內容失真（未知指令被吃掉、缺右括號、整串退成純文字…）
//   warn  = 只是寫法不漂亮，內容一字不差（斜線分數、Unicode 符號、填空題的底線…）
//
// 兩條已凍結的裁決（2026-08-22，interfaces-stage2.md §12 與第 4.4 條）：
//   S2-17：`$…$` **內**的裸上下標 = rule `bare_script`（`error`，Word 會排出一個空的方格）；
//          純文字裡的 `^`／`_` = rule `bare_script_text`（`warn`，填空題的 `答案：___` 就長這樣）。
//          這兩個 rule 名已凍結，不得更名。
//   S2-18：`audit_formulas.js` 原本的 `info`（如 `latex_without_dollar`）一律併進 `warn`，
//          **不加第三級**。
//
// rule 的字串值一旦定案就不能改（會進 job_events.detail 與 report:jobs），
// 新增規則只能往後加。ISSUE_RULES 是目前的全集。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

const { parseLatexStrict } = require('./textFormatter');

// audit_formulas.js:12-13 的兩份對照表，原樣搬過來
const UNICODE_MATH = /[×÷≤≥≠±√∞∑∫∏∂∇αβγδεζηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ°·∈∉⊂⊆∪∩→←⇒⇔]/;
const GREEK_OR_CMD = /\\(frac|sqrt|int|sum|prod|lim|vec|hat|bar|times|div|leq|geq|neq|approx|infty|pm|cdot|alpha|beta|gamma|delta|theta|pi|sigma|omega|lambda|mu|phi|sin|cos|tan|log|ln)\b/;

/** parseLatexStrict 的六種事件 → issue 的 rule 名與說明 */
const EVENT_RULES = {
    unknown_command: { sev: 'error', msg: '未知的 LaTeX 指令，Word 匯出時會直接印出指令名稱' },
    missing_rbrace: { sev: 'error', msg: '群組缺右大括號 }，後面的內容會被吃進同一層' },
    empty_fallback: { sev: 'error', msg: '這段公式解析不出任何數學元件，整串會退成純文字' },
    parser_error: { sev: 'error', msg: '解析器丟出例外，整串會退成去掉語法符號的純文字' },
    tokenize_error: { sev: 'error', msg: 'tokenize 丟出例外，整段會退成純文字' },
    // bare_script 依位置分兩種 rule，見 severityForBareScript()
};

/** 同一條 rule 最多回報幾筆（避免 `______` 這種輸入把 payload 撐爆） */
const MAX_PER_RULE = 5;

/** 目前的規則全集（凍結；新增只能往後加） */
const ISSUE_RULES = Object.freeze([
    // ── error ──
    'dollar_unbalanced', 'brace_unbalanced', 'legacy_marker', 'bare_frac_sqrt',
    'bare_ell', 'dollar_before_script', 'dollar_before_rbrace',
    'unknown_command', 'missing_rbrace', 'empty_fallback',
    'parser_error', 'tokenize_error', 'bare_script', 'lint_crashed',
    // ── warn ──
    'slash_fraction', 'unicode_math', 'latex_without_dollar', 'bare_script_text',
]);

/**
 * 數學區段的 [start, end) 範圍，與 buildParagraphComponents 逐行掃描的界定符一致。
 * 用來判斷一個 bare_script 事件是落在公式裡（error）還是純文字裡（warn）。
 */
function mathSpans(text) {
    const spans = [];
    const delimRe = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
    let lineBase = 0;
    for (const line of String(text).split('\n')) {
        delimRe.lastIndex = 0;
        let m;
        while ((m = delimRe.exec(line)) !== null) {
            spans.push([lineBase + m.index, lineBase + m.index + m[0].length]);
        }
        lineBase += line.length + 1;
    }
    return spans;
}

const inSpans = (spans, at) => spans.some(([s, e]) => at >= s && at < e);

/** 找出第一個「多出來」的大括號位置；配得起來時回 -1 */
function firstUnbalancedBrace(s) {
    let depth = 0;
    let firstOpen = -1;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '{') { if (depth === 0) firstOpen = i; depth++; }
        else if (s[i] === '}') { depth--; if (depth < 0) return i; }
    }
    return depth > 0 ? firstOpen : -1;
}

/**
 * @param {string} text   可含中文與多段 $…$
 * @returns {{ ok:boolean, issues: Array<{sev:'error'|'warn', rule:string, at:number, msg:string}> }}
 *          ok === issues.every(i => i.sev !== 'error')   ← 注意：有 warn 仍然 ok
 */
function formulaLint(text) {
    const issues = [];
    const counts = Object.create(null);

    const push = (sev, rule, at, msg) => {
        counts[rule] = (counts[rule] || 0) + 1;
        if (counts[rule] > MAX_PER_RULE) return;
        issues.push({ sev, rule, at: Number.isInteger(at) && at >= 0 ? at : 0, msg });
    };

    if (typeof text !== 'string' || text.trim() === '') {
        // 空字串由呼叫端另外判斷（audit_formulas.js:17 同樣的取捨）
        return { ok: true, issues: [] };
    }
    const s = text;

    // ── 1. $ 不成對（audit 規則 1）──
    const dollarIdx = [];
    for (let i = 0; i < s.length; i++) if (s[i] === '$') dollarIdx.push(i);
    if (dollarIdx.length % 2 !== 0) {
        push('error', 'dollar_unbalanced', dollarIdx[dollarIdx.length - 1],
            '錢號 $ 不成對（公式分隔符未閉合）');
    }

    // ── 2. 大括號不對稱（audit 規則 2）──
    const open = (s.match(/\{/g) || []).length;
    const close = (s.match(/\}/g) || []).length;
    if (open !== close) {
        push('error', 'brace_unbalanced', firstUnbalancedBrace(s),
            `大括號不對稱（{ 有 ${open} 個、} 有 ${close} 個）`);
    }

    // ── 3. 舊轉換器的殘留標記（isClean 判準 1）──
    for (const m of s.matchAll(/\[(FRAC|SUPER|SUB|SQRT):/g)) {
        push('error', 'legacy_marker', m.index,
            `殘留舊轉換器標記 [${m[1]}:…]，請改寫成 LaTeX`);
    }

    // ── 4. 裸寫 frac / sqrt / ell（isClean 判準 2、3）──
    for (const m of s.matchAll(/(^|[^\\A-Za-z])(frac|sqrt)(?![A-Za-z])/g)) {
        push('error', 'bare_frac_sqrt', m.index + m[1].length,
            `「${m[2]}」少了反斜線，Word 會把它當成三、四個變數`);
    }
    for (const m of s.matchAll(/(^|[^A-Za-z\\])ell(?![A-Za-z])/g)) {
        push('error', 'bare_ell', m.index + m[1].length, '「ell」少了反斜線（應為 \\ell）');
    }

    // ── 5. 錯位的 $（isClean 判準 4；只抓 formulaFix 真的會修的兩種型樣）──
    for (const m of s.matchAll(/\$[\^_]\{/g)) {
        push('error', 'dollar_before_script', m.index,
            '上／下標被擠到 $ 之外（應為 $X^{n}$ 而非 $X$^{n}）');
    }
    for (const m of s.matchAll(/\$\}/g)) {
        push('error', 'dollar_before_rbrace', m.index, '結束的 $ 落在右大括號之前（應為 }$）');
    }

    // ── 6. 斜線當分數（audit 規則 3，warn）──
    if (!/https?:\/\//.test(s)) {
        for (const m of s.matchAll(/(?:\d|[a-zA-Zπ])\s*\/\s*(?:\d|[a-zA-Zπ])/g)) {
            push('warn', 'slash_fraction', m.index, '疑似用斜線表示分數（建議改成 \\frac{}{}）');
        }
    }

    // ── 7. Unicode 數學符號（audit 規則 4，warn）──
    if (UNICODE_MATH.test(s)) {
        push('warn', 'unicode_math', s.search(UNICODE_MATH),
            '含 Unicode 數學符號（建議改用 LaTeX 指令，如 \\theta、\\leq）');
    }

    // ── 8. 有 LaTeX 但沒包 $（audit 規則 5；原本是 info，介面只有 error/warn 兩級）──
    if (dollarIdx.length < 2 && (GREEK_OR_CMD.test(s) || /[\^_]/.test(s))) {
        push('warn', 'latex_without_dollar', 0,
            '含 LaTeX 或上下標但未用 $…$ 包覆（仍會自動轉換，建議補上以求精準）');
    }

    // ── 9. 真的跑一次解析器（audit 規則 6 + 介面第 4.3 條的六種事件）──
    let strict;
    try {
        strict = parseLatexStrict(s);
    } catch (e) {
        push('error', 'lint_crashed', 0, '轉換 Word 時發生例外：' + (e && e.message ? e.message : e));
        strict = null;
    }
    if (strict) {
        const spans = mathSpans(s);
        for (const ev of strict.events) {
            if (ev.kind === 'bare_script') {
                // 落在 $…$ 內＝空的上下標框（Word 會排出一個空格子）→ error
                // 落在純文字裡＝作者本來就想要字面上的 ^ / _（填空題的 ___）→ warn
                if (inSpans(spans, ev.at)) {
                    push('error', 'bare_script', ev.at, '上／下標沒有內容（^ 或 _ 後面是空的）');
                } else {
                    push('warn', 'bare_script_text', ev.at,
                        '純文字裡出現裸露的 ^ 或 _（若不是要當上下標可忽略）');
                }
                continue;
            }
            const meta = EVENT_RULES[ev.kind];
            if (meta) push(meta.sev, ev.kind, ev.at, meta.msg);
        }
    }

    issues.sort((a, b) => a.at - b.at || a.rule.localeCompare(b.rule));
    return { ok: issues.every(i => i.sev !== 'error'), issues };
}

module.exports = { formulaLint, ISSUE_RULES, EVENT_RULES, MAX_PER_RULE };
