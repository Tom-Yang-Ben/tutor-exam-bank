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

/**
 * 從一段文字抽出選項代號集合。三層由強到弱，抽到就停：
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

/** 把常見的「不是數字但不影響數值」的東西清掉 */
function stripDecoration(str) {
    return String(str)
        .normalize('NFKC')
        .replace(/\$/g, '')
        .replace(/\\(left|right|,|;|!|:|quad|qquad)/g, '')
        .replace(/\\text\{[^{}]*\}/g, '')        // \text{公尺} 這種單位
        .replace(/\\mathrm\{[^{}]*\}/g, '')
        // 角度：$45^\circ$ 與 $45^{\circ}$ 的 ^\circ 是單位，不是指數
        //（第 4.2 條「單位後綴一律去掉再比」；Unicode 的 45° 由下面的單位後綴規則處理）
        .replace(/\^\s*\{?\s*\\(?:circ|degree)\s*\}?/g, '')
        .replace(/[，。、；;]+$/g, '')
        .trim();
}

/** \frac{a}{b} / \dfrac / \tfrac → (a)/(b) */
function expandFrac(str) {
    let s = str;
    for (let k = 0; k < 5; k++) {
        const next = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
        if (next === s) break;
        s = next;
    }
    return s;
}

/**
 * 單一數值 → number。支援 12、-3.5、1/2、(1)/(2)、\frac{1}{2}、50%、1.2e3。
 * 認不出來回 null。單位後綴（公尺、m/s、度…）會被剝掉。
 */
function toNumber(raw) {
    if (raw === null || raw === undefined) return null;
    let s = expandFrac(stripDecoration(raw));

    s = s.replace(/[−–—]/g, '-')          // 各種破折號當負號
        .replace(/\s+/g, '')
        .replace(/^\+/, '');

    // 百分比
    let percent = false;
    if (/%$/.test(s)) { percent = true; s = s.slice(0, -1); }

    // 剝單位後綴：數字（或右括號）之後的字母／中文一律不參與數值
    s = s.replace(/^(\(?-?[\d./eE()+\-*^]*?)(?:[A-Za-z一-鿿°′″][A-Za-z一-鿿°′″/\s^\d]*)$/, '$1');

    // 分數 a/b（含 \frac 展開後的 (a)/(b)，以及整個分數前面的負號：
    // -\frac{1}{2} → -(1)/(2)。漏掉這個外層負號，「-1/2 vs 1/2」就會回 uncertain 而不是
    // disagree——而漏掉負號正是最典型的錯答，裁決 S2-11 特別點名的就是它。）
    const frac = s.match(/^(-?)\(?(-?\d+(?:\.\d+)?)\)?\/\(?(-?\d+(?:\.\d+)?)\)?$/);
    if (frac) {
        const den = Number(frac[3]);
        if (den === 0) return null;
        const v = (frac[1] === '-' ? -1 : 1) * (Number(frac[2]) / den);
        return percent ? v / 100 : v;
    }

    // 單純數字（含科學記號）
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
        const v = Number(s);
        return percent ? v / 100 : v;
    }
    return null;
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

function compareExpression(claimedAnswer, modelAnswer) {
    const norm = (s) => stripDecoration(s).replace(/\s+/g, '').replace(/\\(left|right)/g, '');
    const a = norm(claimedAnswer);
    const b = norm(modelAnswer);
    if (a === '' || b === '') return 'uncertain';
    if (a === b) return 'agree';
    // 寫法不同但數值相同（$\frac{1}{2}$ vs 0.5）仍算 agree
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== null && nb !== null) return nearlyEqual(na, nb) ? 'agree' : 'disagree';
    return 'disagree';
}

function compareText(claimedAnswer, modelAnswer) {
    const a = normalizeStem(String(claimedAnswer ?? ''));
    const b = normalizeStem(String(modelAnswer ?? ''));
    if (a === '' || b === '') return 'uncertain';
    return a === b ? 'agree' : 'disagree';
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
