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
// 〔stage5 WS-B〕單位與化學式（docs/interfaces-stage5.md 第 4.2 條第 4 點）
const { parseUnit, sameDims, toBase, unitTextOfAnswer, trailingUnitText } = require('./units');
const { findCe, parseChemAnswer } = require('./chemFormula');

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

    // 只剩字母與標點時才敢把裸字母當代號
    const stripped = s.replace(/[\s.,、，；;：:。和或與]|答案|選|項|是|為/g, '');
    const bareApplies = stripped.length > 0
        && [...stripped].every(ch => OPTION_LETTERS.includes(ch.toUpperCase()));

    // 裁決 Q6（docs/archive/questions2-wsD.md，2026-08-27 落地）：「B、D」「B.D.」會被
    // 標號型匹配到「B、」就提早定案成 {B}，變成 disagree 誤報。整串去標點後全是 A–H
    // 字母時，裸字母層讀到的才是完整集合——它是標號層結果的超集就改用它
    //（超集條件保證只會補漏、不會翻案；「A. 互相垂直」這種帶敘述的不受影響）。
    if (bareApplies) {
        const bare = new Set([...stripped].map(ch => ch.toUpperCase()));
        if ([...out].every(x => bare.has(x))) return bare;
    }
    if (out.size) return out;

    if (bareApplies) for (const ch of stripped) out.add(ch.toUpperCase());
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
    const loc = locateFinalAnswer(claimed);
    return loc ? loc.answer : null;
}

/**
 * extractFinalAnswer 的本體，另外回傳「答案那一段 $…$ 在原文的結束位置」。
 * 〔stage5 WS-B〕單位常寫在 $…$ 外面（「…＝ 25$ m。」），比對單位時要讀 end 之後的文字；
 * 抽取規則本身（上面凍結的四步）一個字都沒改，extractFinalAnswer 的輸出逐字不變。
 * @returns {{answer:string, end:number}|null}  end = 該段右 $ 之後的位置；走「整段等號」規則時為原文長度
 */
function locateFinalAnswer(claimed) {
    if (typeof claimed !== 'string' || claimed.trim() === '') return null;

    const matches = [...claimed.matchAll(/\$([^$]+)\$/g)];

    // 由後往前找第一個「不是純單位上下標」的 $…$
    for (let i = matches.length - 1; i >= 0; i--) {
        const seg = matches[i][1].trim();
        if (seg === '') continue;
        if (SCRIPT_ONLY_RE.test(seg.replace(/\s+/g, ''))) continue;   // 單位的一部分，跳過

        const rel = lastRelationIndex(seg);
        const piece = (rel ? seg.slice(rel.at + rel.len) : seg).trim();
        if (piece !== '') return { answer: piece, end: matches[i].index + matches[i][0].length };
        // 切完是空的（例如 `$x =$`）：往前再找一段
    }

    // 整段都沒有可用的 $…$：對原文做同一件事
    const rel = lastRelationIndex(claimed);
    if (rel) {
        const tail = claimed.slice(rel.at + rel.len).trim();
        if (tail !== '') return { answer: tail, end: claimed.length };
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

// ───────────────────────── 單位（〔stage5 WS-B〕）─────────────────────────
//
// docs/interfaces-stage5.md 第 4.2 條第 4 點：數值帶單位時單位必須一致——「5 cm」對「5 m」
// 不得判 agree。單位的解析在 utils/units.js；這裡只決定「什麼時候介入」：
//   **兩邊都有認得的單位**才介入（units 參數非 null），因次不同 → disagree，因次相同 → 換算到 SI 再比。
//   任何一邊沒有單位、或單位不在 utils/units.js 的表裡 → units 為 null，走下面凍結的原規則，一個字不變。
// claimed 的單位常寫在 $…$ 外面（「…＝ 25$ m。」），所以先看抽出來的答案本身，
// 沒有再看答案那一段 $…$ 後面緊接的文字（locateFinalAnswer 的 end）。

/**
 * 兩邊都有認得的單位才回 {claimed, model}，否則 null（呼叫端照原規則比）。
 * @returns {{claimed:object, model:object}|null}
 */
function unitPair(claimedUnit, modelUnit) {
    return claimedUnit && modelUnit ? { claimed: claimedUnit, model: modelUnit } : null;
}

/** 單位介入時的數值比對：因次不同 → disagree；相同 → 換算後比 */
function compareWithUnits(na, nb, units) {
    if (!sameDims(units.claimed, units.model)) return 'disagree';
    return nearlyEqual(toBase(na, units.claimed), toBase(nb, units.model)) ? 'agree' : 'disagree';
}

// ───────────────────────── 各 answer_form 的比法 ─────────────────────────

/**
 * @param {string} claimedAnswer
 * @param {string} modelAnswer
 * @param {{claimed:object, model:object}|null} [units] 〔stage5 WS-B〕兩邊都有認得的單位時才有值
 */
function compareNumber(claimedAnswer, modelAnswer, units = null) {
    const a = toNumberList(claimedAnswer);
    const b = toNumberList(modelAnswer);
    if (a.list.length === 0 || b.list.length === 0) return 'uncertain';

    // ± 只能跟 ± 比；跟單值比不出來
    if (a.plusMinus !== b.plusMinus) return 'uncertain';

    // 多解時長度不同：可能只是其中一邊省略了，判不出來
    if (a.list.length !== b.list.length) return 'uncertain';

    // 〔stage5 WS-B〕兩邊都有認得的單位：因次不同直接 disagree，相同就換算到 SI 再比
    let la = a.list;
    let lb = b.list;
    if (units) {
        if (!sameDims(units.claimed, units.model)) return 'disagree';
        la = la.map(v => toBase(v, units.claimed));
        lb = lb.map(v => toBase(v, units.model));
    }

    const sa = [...la].sort((x, y) => x - y);
    const sb = [...lb].sort((x, y) => x - y);
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
 * 〔stage5 WS-B〕兩邊都有認得的單位時先比單位：stripDecoration 會把 `\text{ cm}` 整段剝掉，
 *   「5\text{ cm}」對「5\text{ m}」剝完都是「5」——字串相等的那一步擋不住，要在它之前判。
 */
function compareExpression(claimedAnswer, modelAnswer, units = null) {
    const norm = (s) => stripDecoration(s).replace(/\\(left|right)/g, '').replace(/\s+/g, '');
    const a = norm(claimedAnswer);
    const b = norm(modelAnswer);
    if (a === '' || b === '') return 'uncertain';

    if (units) {
        if (!sameDims(units.claimed, units.model)) return 'disagree';
        const ua = toNumber(claimedAnswer);
        const ub = toNumber(modelAnswer);
        if (ua !== null && ub !== null) return compareWithUnits(ua, ub, units);
    }

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
 * 〔stage5 WS-B〕數值那條 agree 路徑在兩邊都有認得的單位時改成「換算後相等才 agree」，
 *   單位衝突只會落到 uncertain（「text 永遠不回 disagree」的凍結取捨不變）。
 */
function compareText(claimedWhole, modelAnswer, units = null) {
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
    if (na !== null && nb !== null) {
        if (units) return compareWithUnits(na, nb, units) === 'agree' ? 'agree' : 'uncertain';
        if (nearlyEqual(na, nb)) return 'agree';
    }
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

// ───────────────────────── 化學式與反應式（〔stage5 WS-B〕）─────────────────────────
//
// 第 4.2 條第 4 點：「化學式要能比對：相同化學式判 agree，不同判 disagree，不能再一律 uncertain」。
// 解析在 utils/chemFormula.js（parseChemAnswer）。**什麼時候介入**是這裡最要緊的取捨：
//   - 任何一邊寫了 \ce{…} → 介入（數學／物理的答案不會有 \ce，既有 golden 的結果不受影響）；
//   - 或者題目是化學（subject === '化學'，verify_chem 才會傳）且 answer_form 不是 number／option；
//   - 其他一律不介入：「BC」（線段）也剛好是合法化學式（碳化硼），數學題絕不能走這條。
// 兩邊都解析得出來才判，任何一邊不像化學式 → 回 null，照原本的 answer_form 規則比。

/** 物種清單 → 「正規化式 → 係數」的 Map（同一物種出現兩次時係數相加） */
function speciesMap(items) {
    const m = new Map();
    for (const it of items) m.set(it.canonical, (m.get(it.canonical) || 0) + it.coef);
    return m;
}

function sameMap(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !nearlyEqual(v, b.get(k))) return false;
    return true;
}

/** 兩邊物種集合相同、係數成比例（4H2 + 2O2 → 4H2O 對 2H2 + O2 → 2H2O） */
function proportional(a, b) {
    if (a.size !== b.size) return false;
    let ratio = null;
    for (const [k, v] of a) {
        if (!b.has(k) || !(b.get(k) > 0)) return false;
        const r = v / b.get(k);
        if (ratio === null) ratio = r;
        else if (!nearlyEqual(ratio, r)) return false;
    }
    return true;
}

/** 元素組成＋電荷（忽略寫法順序）：CH3COOH 與 C2H4O2 相同 */
function compositionKey(sp) {
    const els = Object.entries(sp.elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([el, n]) => `${el}${n}`).join('');
    return `${els}|${sp.charge ?? 0}|${sp.coef}`;
}

/**
 * 兩個已解析的化學答案 → agree／disagree／uncertain。
 *   物種清單：正規化式與係數完全相同 → agree；只是寫法不同（元素組成相同）→ uncertain；否則 disagree。
 *   反應式：兩側的「物種→係數」都相同 → agree；左右對調或係數成比例 → uncertain；否則 disagree。
 *   一邊是反應式、一邊是物種 → uncertain（問的可能根本不是同一件事）。
 */
function compareChemStructures(a, b) {
    if (a.kind !== b.kind) return 'uncertain';
    if (a.kind === 'species') {
        if (sameMap(speciesMap(a.items), speciesMap(b.items))) return 'agree';
        const ka = a.items.map(compositionKey).sort();
        const kb = b.items.map(compositionKey).sort();
        if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) return 'uncertain';
        return 'disagree';
    }
    const [la, ra, lb, rb] = [a.left, a.right, b.left, b.right].map(speciesMap);
    if (sameMap(la, lb) && sameMap(ra, rb)) return 'agree';
    if (sameMap(la, rb) && sameMap(ra, lb)) return 'uncertain';
    if (proportional(la, lb) && proportional(ra, rb)) {
        // 左右兩側的比例也要一樣才算「整條式子乘了一個倍數」
        const r1 = [...la][0][1] / lb.get([...la][0][0]);
        const r2 = [...ra][0][1] / rb.get([...ra][0][0]);
        if (nearlyEqual(r1, r2)) return 'uncertain';
    }
    return 'disagree';
}

/**
 * claimed 裡要拿來比的那一段化學式：
 *   有 \ce{…} 時——任一段含箭頭就取最後一段含箭頭的（反應式），否則全部的 \ce 當物種清單；
 *   沒有 \ce 時——沿用 extractFinalAnswer（最後一個 $…$），抽不到用整段。
 */
function claimedChemPart(claimed) {
    const ces = findCe(claimed);
    if (ces.length) {
        const withArrow = ces.filter(c => /->|<-|<=>|→|⇌/.test(c.body));
        if (withArrow.length) return `\\ce{${withArrow[withArrow.length - 1].body}}`;
        return ces.map(c => `\\ce{${c.body}}`).join(' ');
    }
    return extractFinalAnswer(claimed) ?? claimed;
}

/**
 * @returns {'agree'|'disagree'|'uncertain'|null} null ＝ 不介入（照原規則比）
 */
function compareChemistry(claimed, finalAnswer, { subject, answerForm } = {}) {
    const hasCe = findCe(claimed).length > 0 || findCe(finalAnswer).length > 0;
    const chemQuestion = subject === '化學' && answerForm !== 'number' && answerForm !== 'option';
    if (!hasCe && !chemQuestion) return null;
    const a = parseChemAnswer(claimedChemPart(claimed));
    const b = parseChemAnswer(finalAnswer);
    if (!a || !b) return null;
    return compareChemStructures(a, b);
}

// ───────────────────────── 對外 ─────────────────────────

/**
 * 比對「拆題模型抄下來的答案」與「驗證模型自己算出來的答案」。
 *
 * @param {{
 *   question_type: '單選'|'多選'|'填空'|'計算'|'證明',
 *   claimed: string,
 *   model: { final_answer: string, answer_form: 'option'|'number'|'expression'|'text' },
 *   subject?: string
 * }} opts
 *   subject：〔stage5 WS-B〕選用。只有化學題（agents/verify.js 的化學路徑）會傳 '化學'，
 *   用來決定要不要在沒有 \ce{…} 的答案上嘗試化學式比對。數學／物理不傳，行為不變。
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

    const modelAnswer = String(finalAnswer);

    // 〔stage5 WS-B〕化學式／反應式（介入條件見 compareChemistry 上方的說明）
    const chem = compareChemistry(claimed, modelAnswer, { subject: o.subject, answerForm });
    if (chem !== null) return chem;

    // 〔stage5 WS-B〕模型答案的單位；認不得或沒有就是 null，之後所有比法照原規則
    const modelUnit = parseUnit(unitTextOfAnswer(modelAnswer));
    const loc = locateFinalAnswer(claimed);

    // text 不走 $…$ 抽取，直接比整段（裁決 S2-26；見 compareText 的說明）
    if (answerForm === 'text') {
        const claimedUnit = modelUnit ? claimedUnitOf(claimed, loc, claimed) : null;
        return compareText(claimed, modelAnswer, unitPair(claimedUnit, modelUnit));
    }

    // 填空／計算（以及任何其他型別）：先從 claimed 抽出 final_answer
    let claimedFinal = loc ? loc.answer : null;
    let claimedUnit = null;
    if (claimedFinal === null) {
        // 〔stage5 WS-B〕claimed 整段就是「數值＋認得的單位」（例：「5 cm」，沒有 $ 也沒有等號）：
        // 只在模型答案也有認得的單位時才把整段當答案——那正是第 4.2 條第 4 點要擋的情形；
        // 其餘維持原本的 uncertain。
        const whole = modelUnit ? parseUnit(unitTextOfAnswer(claimed)) : null;
        if (whole && toNumber(claimed) !== null) {
            claimedFinal = claimed.trim();
            claimedUnit = whole;
        }
    } else if (modelUnit) {
        claimedUnit = claimedUnitOf(claimed, loc, claimedFinal);
    }
    if (claimedFinal === null) return 'uncertain';

    const fn = BY_FORM[answerForm];
    if (!fn) return 'uncertain';                       // answer_form 不在四個值內
    return fn(claimedFinal, modelAnswer, unitPair(claimedUnit, modelUnit));
}

/**
 * claimed 的單位：先看答案本身（`$5\text{ cm}$`），沒有再看答案那一段 $…$ 後面緊接的文字（`$5$ cm`）。
 * @param {string} claimed 整段
 * @param {{answer:string, end:number}|null} loc locateFinalAnswer 的結果
 * @param {string} own 先看的那一段（計算題是抽出來的答案，文字題是整段）
 * @returns {object|null}
 */
function claimedUnitOf(claimed, loc, own) {
    const direct = parseUnit(unitTextOfAnswer(own));
    if (direct) return direct;
    if (!loc || loc.end >= claimed.length) return null;
    return parseUnit(trailingUnitText(claimed.slice(loc.end)));
}

module.exports = {
    answerCompare,
    // 給單元測試與 agents/verify.js 使用的零件（形狀不在凍結介面內，但保持穩定）
    extractOptionCodes, extractFinalAnswer, toNumber, toNumberList,
    // 〔stage5 WS-B〕
    locateFinalAnswer, compareChemistry, compareChemStructures
};
