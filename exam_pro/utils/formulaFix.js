// utils/formulaFix.js — 公式的確定性修復（A-T4 / WS-C）
//
// docs/interfaces-stage2.md 第 4.4 條：
//   formulaFix(text) → { text, applied }   applied = 實際套用到的規則名，順序 = 套用順序
//
// 規則整批搬自 fix_formulas.js:18-54 的 transform()，一個字都不重新發明：
// 那支腳本是對既有題庫跑過、由人逐筆看過預覽才 --apply 的，規則本身已經被驗證過。
// 差別只有三點：
//   1. 純函式——不連 DB、不寫檔、不讀 process.env（agents/lint.js 在 LLM 之前先跑它）。
//   2. 回報「套用了哪幾條」——進 job_questions.payload.lint.applied 與 job_events.detail，
//      report:jobs 才看得出「哪一條規則救回最多題」。
//   3. rule 名一旦定案就不能改（會進報表）；新增規則只能往後加。
//
// ⚠️ 這裡只做「保證不會改變語意」的修復。任何需要判斷題意的重寫都是 agents/lint.js
//    第三層（LLM）的事，不在本檔。

/** 已知毀損字串的精準修正（fix_formulas.js:12-14） */
const SPECIAL = [
    { find: '$\\frac{T}{2}$^{[SUPER:R|3}]=K', replace: '$\\frac{T^2}{R^3}=K$' },
];

const GREEK = '(pi|theta|alpha|beta|gamma|delta|omega|lambda|nu|sigma|phi|varphi|rho|tau|varepsilon|epsilon|psi|chi|mu)';
const UNICODE = { '×': '\\times', '÷': '\\div', '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '±': '\\pm', '≈': '\\approx' };

/**
 * 只對 $…$ 之外的片段套用 fn（fix_formulas.js:39-52 的作法）。
 * split 的奇數格就是 $…$ 本身，原樣保留。
 */
function outsideMath(s, fn) {
    const parts = s.split(/(\$[^$]*\$)/);
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) continue;
        parts[i] = fn(parts[i]);
    }
    return parts.join('');
}

/**
 * 規則表：每條 { name, apply(s) → string }。
 * 順序凍結——例如「還原殘留標記」必須在「錯位的 $」之前，
 * 否則 `$\frac{T}{2}$^{[SUPER:R|3}]=K` 這種混合毀損會被修成別的東西。
 */
const RULES = [
    {
        name: 'special_fix',
        apply: (s) => {
            let out = s;
            for (const sp of SPECIAL) if (out.includes(sp.find)) out = out.split(sp.find).join(sp.replace);
            return out;
        },
    },
    { name: 'legacy_frac', apply: (s) => s.replace(/\[FRAC:([^|\]]*)\|([^\]]*)\]/g, '\\frac{$1}{$2}') },
    { name: 'legacy_super', apply: (s) => s.replace(/\[SUPER:([^|\]]*)\|([^\]]*)\]/g, '$1^{$2}') },
    { name: 'legacy_sub', apply: (s) => s.replace(/\[SUB:([^|\]]*)\|([^\]]*)\]/g, '$1_{$2}') },
    { name: 'legacy_sqrt', apply: (s) => s.replace(/\[SQRT:([^\]}]*)[}\]]/g, '\\sqrt{$1}') },
    {
        // 上／下標被擠到 $ 外：$X$^{n} → $X^{n}$
        name: 'dollar_script_swap',
        apply: (s) => s.replace(/\$(\^\{[^{}]*\})/g, '$1$').replace(/\$(_\{[^{}]*\})/g, '$1$'),
    },
    {
        // 結束 $ 落在右大括號之前：…$} → …}$（可能連續多個，最多推 5 層）
        name: 'dollar_rbrace_swap',
        apply: (s) => {
            let out = s;
            for (let k = 0; k < 5; k++) out = out.replace(/\$\}/g, '}$');
            return out;
        },
    },
    {
        // $…$ 之外的 Unicode 數學符號 → LaTeX 指令並包上 $
        name: 'unicode_to_latex',
        apply: (s) => outsideMath(s, (seg) => seg.replace(/[×÷≤≥≠±≈]/g, (m) => '$' + UNICODE[m] + '$')),
    },
    {
        // $…$ 之外的裸希臘指令 → 包上 $；其後緊接 ^ 或 _ 的留給轉換器自己處理
        name: 'bare_greek',
        apply: (s) => outsideMath(s, (seg) => {
            const reGreek = new RegExp('\\\\' + GREEK + '\\b(?!\\s*[\\^_])(\\s*\\/\\s*\\d+)?', 'g');
            return seg.replace(reGreek, (m, g, frac) => {
                let inner = '\\' + g;
                if (frac) inner += frac.replace(/\s+/g, '');
                return '$' + inner + '$';
            });
        }),
    },
];

/** 規則名清單（凍結，供測試與報表對照） */
const FIX_RULES = Object.freeze(RULES.map(r => r.name));

/**
 * 確定性修復（搬 fix_formulas.js 的規則），不呼叫任何模型。
 * @param {string} text
 * @returns {{ text:string, applied:string[] }}   applied = 實際套用到的規則名，順序 = 套用順序
 */
function formulaFix(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return { text: typeof text === 'string' ? text : '', applied: [] };
    }
    let s = text;
    const applied = [];
    for (const rule of RULES) {
        const next = rule.apply(s);
        if (next !== s) {
            applied.push(rule.name);
            s = next;
        }
    }
    return { text: s, applied };
}

module.exports = { formulaFix, FIX_RULES, SPECIAL };
