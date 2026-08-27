// utils/answerCompare.js — 拆題答案 vs 驗證模型答案的確定性比對器（A-T5 / WS-C）
//
// docs/interfaces-stage2.md 第 4.2 條：
//   answerCompare({ question_type, claimed, model:{ final_answer, answer_form } })
//     → 'agree' | 'disagree' | 'uncertain'
//
// 核心取捨（介面明講）：**任何比不出來的情況都回 uncertain，不回 disagree**。
// 誤報一次 answer_mismatch 的成本（老師白看一題）遠低於漏報。
//
// 兩條與本檔直接相關的裁決（2026-08-22，interfaces-stage2.md §12）：
//   S2-11：`number` 的比法——負號**是數值的一部分**（`-1` 與 `1` → `disagree`，
//          漏掉負號是最典型的錯答）；`±` 只與 `±` 比量值，`±2` 對上單值 `2` → `uncertain`。
//   S2-12：`final_answer` 的抽取規則改成「最後一個 $…$、跳過單位上下標、含 = 或 \approx
//          取其後」。理由是 WS-D 對 fixture 45 題實測：舊規則（第一個 $…$）只抽對 4 題，
//          而且抽到的常是題目條件裡的中間值（「垂直即內積為 $0$」的那個 0），
//          那不是比不出來、是**比錯對象**，會產生系統性的假 disagree。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

const { normalizeStem } = require('./normalizeStem');

const OPTION_LETTERS = 'ABCDEFGH';
const EPSILON = 1e-9;

// ───────────────────────── 選項代號 ─────────────────────────

const BRACKET_OPTION_RE = /[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g;
const LABELLED_OPTION_RE = /(^|[\s，,、；;和或與])([A-Ha-h])[.、．:：]/g;
// 行首的連續括號代號（「(A)(C)。…」「(B)、(D) …」）——extract 的 schema 要求答案
// 「以選項代號開頭」，所以開頭那一串就是答案本體
const LEADING_OPTION_RUN_RE = /^\s*(?:[（(［[【]\s*[A-Ha-h]\s*[）)］\]】]\s*[、，,]?\s*)+/;

/**
 * 從一段文字抽出選項代號集合。四層由強到弱，抽到就停：
 *   0. 行首連續括號型 ——「(A)(C)。(A) 正確因為…，(B) 錯誤因為…」只取開頭的 {A,C}。
 *      整段掃括號會把解說裡逐一點評的 (B)(D) 也抽進來，變成假 disagree
 *      （2026-08-27 重錄 pipeline cassette 時在樣卷第 10 題實際發生）。
 *   1. 括號型 (A)（Ａ）[A]【A】
 *   2. 標號型 行首／分隔後的「A.」「A、」「A：」
 *   3. 裸字母 —— 只有在「整串除了 A–H 與標點空白之外什麼都沒有」時才算
 *      （「答案：AB」算，「設 A 為集合」不算）
 * 「甲乙丙」不算代號（介面第 4.2 條）。
 *
 * @param {string} text
 * @returns {Set<string>}  大寫代號；抽不到時是空集合
 */
function extractOptionCodes(text) {
    const out = new Set();
    if (typeof text !== 'string' || text.trim() === '') return out;
    const s = text.normalize('NFKC');

    const lead = LEADING_OPTION_RUN_RE.exec(s);
    if (lead) {
        for (const m of lead[0].matchAll(BRACKET_OPTION_RE)) out.add(m[1].toUpperCase());
        if (out.size) return out;
    }

    for (const m of s.matchAll(BRACKET_OPTION_RE)) out.add(m[1].toUpperCase());
    if (out.size) return out;

    for (const m of s.matchAll(LABELLED_OPTION_RE)) out.add(m[2].toUpperCase());
    if (out.size) return out;

    // 只剩字母與標點時才敢把裸字母當代號
    const stripped = s.replace(/[\s.,、，；;：:。和或與]|答案|選|項|是|為/g, '');
    if (stripped.length > 0 && [...stripped].every(ch => OPTION_LETTERS.includes(ch.toUpperCase()))) {
        for (const ch of stripped) out.add(ch.toUpperCase());
    }
    return out;
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// ───────────────────────── final_answer 抽取 ─────────────────────────

/**
 * 只含上下標的片段（單位的 `$^2$`、`$_{max}$`）——它是前面那個單位的一部分，不是答案。
 * 例：「$a = \frac{10}{2} = 5$ m/s$^2$」的最後一個 $…$ 是 `^2`，答案在前一段。
 */
const SCRIPT_ONLY_RE = /^(?:[\^_](?:\{[^{}]*\}|\\[A-Za-z]+|[A-Za-z0-9]))+$/;

/** `=` 或 `\approx`：中文數學答案的寫法幾乎一定是「過程 = 結論」 */
function lastRelationIndex(s) {
    const eq = s.lastIndexOf('=');
    const ap = s.lastIndexOf('\\approx');
    if (ap > eq) return { at: ap, len: '\\approx'.length };
    if (eq >= 0) return { at: eq, len: 1 };
    return null;
}

/**
 * 從 claimed（可能含說明與計算過程）抽出最終答案。
 *
 * 規則凍結（介面第 4.2 條，裁決 S2-12 改寫）：
 *   1. 取**最後一個** `$…$`；只含上下標的片段（單位的 `$^2$`）視為單位的一部分，往前找上一段。
 *   2. 該段含 `=` 或 `\approx` 就再取**最後一個** `=`／`\approx` 之後的片段。
 *   3. 完全沒有 `$…$`（或全被跳過）就對整段文字做第 2 步。
 *   4. 抽不到回 null（呼叫端一律回 uncertain）。
 *
 * 為什麼從「第一個」改成「最後一個」：WS-D 對 fixture 的 45 題填空／計算實測，
 * 舊規則只抽對 4 題（多半抽到題目條件裡的中間值，例如「垂直即內積為 $0$」的那個 0，
 * 那不是比不出來，是**比錯對象**，會產生系統性的假 disagree）；本規則抽對 39 題。
 *
 * @returns {string|null}  抽不到回 null
 */
function extractFinalAnswer(claimed) {
    if (typeof claimed !== 'string' || claimed.trim() === '') return null;

    const segments = [...claimed.matchAll(/\$([^$]+)\$/g)].map(m => m[1]);

    // 由後往前找第一個「不是純單位上下標」的 $…$
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].trim();
        if (seg === '') continue;
        if (SCRIPT_ONLY_RE.test(seg.replace(/\s+/g, ''))) continue;   // 單位的一部分，跳過

        const rel = lastRelationIndex(seg);
        const piece = (rel ? seg.slice(rel.at + rel.len) : seg).trim();
        if (piece !== '') return piece;
        // 切完是空的（例如 `$x =$`）：往前再找一段
    }

    // 整段都沒有可用的 $…$：對原文做同一件事
    const rel = lastRelationIndex(claimed);
    if (rel) {
        const tail = claimed.slice(rel.at + rel.len).trim();
        if (tail !== '') return tail;
    }
    return null;
}

// ───────────────────────── 數值正規化 ─────────────────────────

/**
 * 把常見的「不是數字但不影響數值」的東西清掉。
 * 裁決 S2-26：`\mathrm{…}`、`\text{…}`、`\,`、`\ ` 與其後的單位整段視為單位去掉。
 */
function stripDecoration(str) {
    return String(str)
        .normalize('NFKC')
        .replace(/\$/g, '')
        // 單位巨集連內容一起去掉（\mathrm{m/s^2}、\text{公尺}），**連同緊接在後面的指數**：
        // `5\text{ m/s}^2` 的 ^2 屬於單位，不是 5 的平方——漏掉會把 5 算成 25 而誤報 answer_mismatch
        //（2026-08-23 FEATURE_PIPELINE 冒煙時在真實管線抓到的假警報）。
        .replace(/\\(?:text|mathrm|mathit|mathbf|operatorname|mbox|rm)\s*\{[^{}]*\}(?:\s*\^(?:\{[^{}]*\}|\\circ|[0-9]+))?/g, '')
        // LaTeX 的間距指令：\, \; \! \: \quad \qquad，以及「反斜線 + 空白」
        .replace(/\\(?:qquad|quad|left|right|[,;!:])/g, '')
        .replace(/\\(?=\s|$)/g, '')
        // 角度：$45^\circ$ 與 $45^{\circ}$ 的 ^\circ 是單位，不是指數
        //（第 4.2 條「單位後綴一律去掉再比」；Unicode 的 45° 由下面的單位後綴規則處理）
        .replace(/\^\s*\{?\s*\\(?:circ|degree)\s*\}?/g, '')
        .replace(/[，。、；;]+$/g, '')
        .trim();
}

/**
 * LaTeX 片段 → 可計算的算式字串。
 * `\sqrt` 先展開再展開 `\frac`：`\frac{\sqrt{3}}{2}` 的分子本身帶大括號，
 * 順序反過來的話 `[^{}]*` 就吃不到。
 */
function latexToArith(str) {
    let s = String(str);
    for (let k = 0; k < 6; k++) {
        const before = s;
        s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
        s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
        if (s === before) break;
    }
    return s
        .replace(/\\pi(?![A-Za-z])/g, 'π')
        .replace(/\\times|\\cdot|×|·/g, '*')
        .replace(/\\div|÷/g, '/')
        .replace(/[−–—]/g, '-')          // 各種破折號當負號
        // 剩下的大括號是上下標的群組（10^{-4}），換成括號給求值器
        .replace(/\{/g, '(').replace(/\}/g, ')')
        // 隱含乘號：2\pi → 2π → 2*π、3(1+2) → 3*(1+2)、2√3 → 2*√3
        .replace(/([\d)])(?=[π√(])/g, '$1*')
        .replace(/π(?=[\d(√])/g, 'π*');
}

/**
 * 求值一段純算術字串（遞迴下降，**不用 eval／Function**）。
 * 輸入來自模型，任何「看不懂」的字元一律讓整式失敗回 null——
 * 猜錯數值會變成假的 agree／disagree，比回 uncertain 糟得多。
 *
 * 支援：數字（含 1.2e3）、+ - * / ^、括號、一元正負、√、π。
 * @returns {number|null}
 */
function evalArith(src) {
    const s = String(src).replace(/\s+/g, '');
    let i = 0;
    let failed = false;

    const fail = () => { failed = true; return NaN; };
    const peek = () => s[i];

    function parseExpr() {
        let v = parseTerm();
        while (!failed && (peek() === '+' || peek() === '-')) {
            const op = s[i++];
            const r = parseTerm();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }
    function parseTerm() {
        let v = parseFactor();
        while (!failed && (peek() === '*' || peek() === '/')) {
            const op = s[i++];
            const r = parseFactor();
            v = op === '*' ? v * r : v / r;
        }
        return v;
    }
    function parseFactor() {
        if (peek() === '-') { i++; return -parseFactor(); }
        if (peek() === '+') { i++; return parseFactor(); }
        return parsePower();
    }
    function parsePower() {
        const base = parseAtom();
        if (!failed && peek() === '^') { i++; return Math.pow(base, parseFactor()); }
        return base;
    }
    function parseAtom() {
        if (failed || i >= s.length) return fail();
        const c = peek();
        if (c === '(') {
            i++;
            const v = parseExpr();
            if (failed || peek() !== ')') return fail();
            i++;
            return v;
        }
        if (c === '√') { i++; return Math.sqrt(parseAtom()); }
        if (c === 'π') { i++; return Math.PI; }
        const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
        if (m) { i += m[0].length; return Number(m[0]); }
        return fail();
    }

    const v = parseExpr();
    if (failed || i !== s.length || !Number.isFinite(v)) return null;
    return v;
}

/**
 * 單一數值 → number。
 *
 * 支援（裁決 S2-26 補齊）：
 *   12、-3.5、1/2、\frac{1}{2}、-\frac{1}{2}、50%、1.2e3
 *   科學記號 `2.4 \times 10^{-4}`、`6.0×10^2`、`2.4e-4`
 *   可數值化的式子 `\sqrt{3}`、`\frac{\sqrt{3}}{2}`、`2\pi`
 *   單位後綴（公尺、m/s、N、`\mathrm{m/s^2}`、`^\circ`、°）一律去掉
 *
 * 認不出來一律回 null（呼叫端會落到 uncertain）。
 */
function toNumber(raw) {
    if (raw === null || raw === undefined) return null;

    let s = stripDecoration(raw);
    if (s === '') return null;

    // 百分比
    let percent = false;
    if (/%$/.test(s)) { percent = true; s = s.slice(0, -1); }

    s = latexToArith(s).replace(/\s+/g, '').replace(/^\+/, '');

    // 剝單位後綴：算式（數字、括號、運算子、√、π）之後的字母／中文一律不參與數值
    s = s.replace(/^([\d.eE()+\-*/^√π]*?)(?:[A-Za-z一-鿿°′″][A-Za-z一-鿿°′″/\s^\d]*)$/, '$1');

    // 科學記號 a*10^n → a e n：交給 Number() 以十進位字串解析，避免 a * Math.pow(10, n) 的浮點誤差
    //（Node 22 的 V8 算 2.4*10^-4 會得到 0.00023999999999999998，Node 24 得到 0.00024；CI 兩個版本都要過）。
    // 必須放在剝單位之後：先轉成 6.0e2 的話，正指數的 e2 會被上面的單位規則當成字母剝掉。
    s = s.replace(/(\d+(?:\.\d+)?)\*10\^\(?([+-]?\d+)\)?/g, '$1e$2');

    const v = evalArith(s);
    if (v === null) return null;
    return percent ? v / 100 : v;
}

/**
 * 一段答案 → 數值清單（處理「1 或 4」「x = 1, x = 4」這種多解）。
 * 每一段都要認得出來才回；有任何一段認不出來就回空陣列。
 */
function toNumberList(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return { list: [], plusMinus: false };
    let s = stripDecoration(raw);

    // ± 只留量值，另外標記
    let plusMinus = false;
    if (/\\pm|±/.test(s)) { plusMinus = true; s = s.replace(/\\pm|±/g, ''); }

    // 去掉「x =」「答案為」這類前綴，只留等號右邊
    const parts = s.split(/[,，、]|\s+或\s+|或|;|；/).map(p => p.trim()).filter(p => p !== '');
    const list = [];
    for (const p of parts) {
        const tail = p.includes('=') ? p.slice(p.lastIndexOf('=') + 1) : p;
        const v = toNumber(tail);
        if (v === null) return { list: [], plusMinus };
        list.push(v);
    }
    return { list, plusMinus };
}

const nearlyEqual = (a, b) => Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));

// ───────────────────────── 各 answer_form 的比法 ─────────────────────────

function compareNumber(claimedAnswer, modelAnswer) {
    const a = toNumberList(claimedAnswer);
    const b = toNumberList(modelAnswer);
    if (a.list.length === 0 || b.list.length === 0) return 'uncertain';

    // ± 只能跟 ± 比；跟單值比不出來
    if (a.plusMinus !== b.plusMinus) return 'uncertain';

    // 多解時長度不同：可能只是其中一邊省略了，判不出來
    if (a.list.length !== b.list.length) return 'uncertain';

    const sa = [...a.list].sort((x, y) => x - y);
    const sb = [...b.list].sort((x, y) => x - y);
    const same = a.plusMinus
        ? sa.every((v, i) => nearlyEqual(Math.abs(v), Math.abs(sb[i])))
        : sa.every((v, i) => nearlyEqual(v, sb[i]));
    return same ? 'agree' : 'disagree';
}

/**
 * expression（裁決 S2-26）：
 *   去空白、`$`、`\left`／`\right` 後字串相等 → agree；
 *   否則兩邊都能數值化就照 number 比（`\frac{3}{1}` 對 `3` → agree）；
 *   否則 uncertain——只有一邊算得出數值時，判 disagree 等於拿「看不懂」當「不一樣」。
 */
function compareExpression(claimedAnswer, modelAnswer) {
    const norm = (s) => stripDecoration(s).replace(/\\(left|right)/g, '').replace(/\s+/g, '');
    const a = norm(claimedAnswer);
    const b = norm(modelAnswer);
    if (a === '' || b === '') return 'uncertain';
    if (a === b) return 'agree';

    const na = toNumber(claimedAnswer);
    const nb = toNumber(modelAnswer);
    if (na !== null && nb !== null) return nearlyEqual(na, nb) ? 'agree' : 'disagree';
    return 'uncertain';
}

/**
 * text（裁決 S2-26）：`normalizeStem` 後相等 → agree；
 * **不相等一律 uncertain，永遠不回 disagree**——文字答案的「不同」分不出是答錯
 * 還是換句話說，判 disagree 會製造假的 answer_mismatch。
 *
 * 比的是**整段 claimed**，不走 `$…$` 抽取：文字型答案本來就沒有「最後一個等號右邊」，
 * 抽出來的多半是敘述裡的某個符號（例如 `$90^\circ$`）。
 */
function compareText(claimedWhole, modelAnswer) {
    // 裁決 S2-27：claimed 是整段敘述（「…故夾角為 90°，兩者互相垂直。」），模型給的是結論短語
    // （「互相垂直」）。normalizeStem 兩邊後，claimed **包含** 模型答案 → agree；否則一律 uncertain
    // （包含關係判不出「錯」，只判得出「對」——不回 disagree）。句尾標點由 normalizeStem 之後再剝一次。
    const strip = s => normalizeStem(String(s ?? '')).replace(/[。．.,，、;；!！?？:：]+$/g, '');
    const a = strip(claimedWhole);
    const b = strip(modelAnswer);
    if (a === '' || b === '') return 'uncertain';
    if (a === b || a.includes(b)) return 'agree';

    // 兩邊都能數值化就比數值——verify 偶爾把「25 m」這種數值答案標成 answer_form='text'
    // （2026-08-27 重錄 pipeline cassette 時在樣卷第 7 題實際發生：claimed 是 `$25\text{ m}$`、
    // 模型回「25 m」，字面不等但數值相同）。只加 agree 這一邊：數值不同仍回 uncertain，
    // 「text 永遠不回 disagree」的凍結取捨（裁決 S2-26）原封不動。
    const na = toNumber(claimedWhole);
    const nb = toNumber(modelAnswer);
    if (na !== null && nb !== null && nearlyEqual(na, nb)) return 'agree';
    return 'uncertain';
}

function compareOption(claimedAnswer, modelAnswer) {
    const a = extractOptionCodes(String(claimedAnswer ?? ''));
    const b = extractOptionCodes(String(modelAnswer ?? ''));
    if (a.size === 0 || b.size === 0) return 'uncertain';
    return sameSet(a, b) ? 'agree' : 'disagree';
}

const BY_FORM = {
    option: compareOption,
    number: compareNumber,
    expression: compareExpression,
    text: compareText,
};

// ───────────────────────── 對外 ─────────────────────────

/**
 * 比對「拆題模型抄下來的答案」與「驗證模型自己算出來的答案」。
 *
 * @param {{
 *   question_type: '單選'|'多選'|'填空'|'計算'|'證明',
 *   claimed: string,
 *   model: { final_answer: string, answer_form: 'option'|'number'|'expression'|'text' }
 * }} opts
 * @returns {'agree'|'disagree'|'uncertain'}
 */
function answerCompare(opts) {
    const o = opts || {};
    const questionType = o.question_type;
    const claimed = o.claimed;
    const model = o.model || {};
    const finalAnswer = model.final_answer;
    const answerForm = model.answer_form;

    // 證明題一律 uncertain（實務上 verify 節點會先 skipped，不會呼叫到）
    if (questionType === '證明') return 'uncertain';

    if (typeof claimed !== 'string' || claimed.trim() === '') return 'uncertain';
    if (finalAnswer === null || finalAnswer === undefined || String(finalAnswer).trim() === '') return 'uncertain';

    // 單選／多選：兩邊各抽選項代號集合
    if (questionType === '單選' || questionType === '多選') {
        return compareOption(claimed, finalAnswer);
    }

    // text 不走 $…$ 抽取，直接比整段（裁決 S2-26；見 compareText 的說明）
    if (answerForm === 'text') return compareText(claimed, String(finalAnswer));

    // 填空／計算（以及任何其他型別）：先從 claimed 抽出 final_answer
    const claimedFinal = extractFinalAnswer(claimed);
    if (claimedFinal === null) return 'uncertain';

    const fn = BY_FORM[answerForm];
    if (!fn) return 'uncertain';                       // answer_form 不在四個值內
    return fn(claimedFinal, String(finalAnswer));
}

module.exports = {
    answerCompare,
    // 給單元測試與 agents/verify.js 使用的零件（形狀不在凍結介面內，但保持穩定）
    extractOptionCodes, extractFinalAnswer, toNumber, toNumberList,
};
