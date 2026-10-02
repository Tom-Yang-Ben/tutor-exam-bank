// utils/answerKey.js — 本機拆題的「答案從哪裡來」：解答頁偵測與解析、題目頁有沒有寫答案、回填（docs/local-mode.md 10.25）
//
// 〔Owner 2026-10-02 同意「本機的這些修改都先做了」，dec/r13-extract-fixes〕起因是 114-2 興大附中高二期末考數學 A 的交叉驗證
// （Ben 的 Project 文件 crosscheck-114-2-math-A.md）：
//   (a) 第 5 頁的解答表被本機拆題（extract_ocr）拆成 8 題垃圾，每題題幹都是「整頁頁首＋解答表文字」；
//   (b) 題目頁沒有寫答案，拆題模型卻每題都填了 answer_text（自己編的，單選、多選幾乎全錯；選填題把 ⑮⑯ 這種填答格抄成答案）。
// 本檔是三件事的純函式：
//   1. 解答頁偵測（isAnswerKeyPage）與解析（parseAnswerKey）：頁面文字裡有「解答／答案」標題、而且有「1. 2. 3. 4. 5.」這種
//      連號的題號串，後面跟著答案。解析得出「題號 → 答案」才回填；**解析不確定（答案個數與題號個數對不上、出現 7-9、17'7 這種
//      分數被 OCR 拆成上下兩個數字的樣子）就不回填**，只記錄。
//   2. 拆出來的元素是不是解答表（isAnswerKeyElement）：整塊都是解答頁、題幹裡有連號題號串、或題幹的字幾乎都出自解答頁。
//   3. 題目頁上有沒有寫出答案（hasAnswerOnPage）：有「答：」「答案：」「【解答】」「解析：」這種標記才算；
//      「請將答案畫記在答案卡上」這種作答說明不算。沒有標記時，拆題模型給的 answer_text 一律視為自己編的、清掉。
// 回填（mapAnswerKey）只在「解答表的題號總數＝這份卷存活的題數」而且題幹開頭的題號（有寫的話）對得上時才做，
// 依題型轉寫：單選 3 → (3)、多選 245 → (2)(4)(5)、填空 -2 → $-2$；題型與答案的樣子對不上（單選卻是 245）的那一題不回填。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。

/** 題號：1～2 位數字或 A～H，後面接 . ． 、 */
const LABEL_TOKEN_RE = /^(\d{1,2}|[A-Ha-h])[.．、]$/;
/** 一個「簡單」的答案值：整數、小數、負號、或寫成一個 token 的分數 a/b */
const SIMPLE_VALUE_RE = /^[-−]?\d+(?:\.\d+)?(?:\/\d+)?$/;
/** 解答頁的標題字 */
const KEY_HEADING_RE = /(?:參考答案|答案|解答)/;
/** 作答說明（不是標題）：答案卡、答案卷… */
const KEY_HEADING_EXCLUDE_RE = /答案(?:卡|卷|紙|欄|區|格|請|須|需|務必|一律|寫|畫|劃|填)|將答案|作答/g;

/**
 * 題目頁上「寫出了答案或解析」的標記。要有冒號或【】括號，作答說明（「請將答案寫在答案卷上」）不算。
 */
const ANSWER_MARKERS = [
    // 「回答：」「作答：」「請將答案…」是作答說明，不是答案
    /(?<![回作請將])(?:答案|解答|正解|[Aa]ns(?:wer)?|ANS|答)\s*[:：]/,
    /【\s*(?:答案?|解答|詳解|解析)\s*】/,
    /(?:^|\n)\s*(?:解析|詳解|解)\s*[:：]/
];

/** OCR 的 Markdown／HTML 表格 → 純文字（標籤、表格線、$ 換成空白） */
function plainText(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-:\s]{3,}$/gm, ' ')
        .replace(/\$/g, ' ');
}

/** 題號的序號：'3' → 3、'C' → 103（數字與字母各自一組，只有同一組裡差 1 才算連號） */
function labelOrdinal(label) {
    const s = String(label).toUpperCase();
    if (/^\d+$/.test(s)) return Number(s);
    return 100 + (s.charCodeAt(0) - 64);
}

function tokensOf(text) {
    return plainText(text).split(/\s+/).map(t => t.trim()).filter(Boolean);
}

/**
 * 依序找出「連號題號串」與跟在後面的值。
 * @param {string} text
 * @returns {Array<{labels:string[], values:string[]}>}
 */
function labelGroups(text) {
    const tokens = tokensOf(text);
    const groups = [];
    let cur = null;
    let inLabels = false;
    for (const t of tokens) {
        const m = LABEL_TOKEN_RE.exec(t);
        if (m) {
            const label = m[1].toUpperCase();
            const prev = cur && inLabels ? cur.labels[cur.labels.length - 1] : null;
            if (prev !== null && labelOrdinal(label) === labelOrdinal(prev) + 1) {
                cur.labels.push(label);
            } else {
                cur = { labels: [label], values: [] };
                groups.push(cur);
            }
            inLabels = true;
        } else {
            if (cur) cur.values.push(t);
            inLabels = false;
        }
    }
    return groups;
}

/**
 * 文字裡有沒有至少 minRun 個連號、中間只隔空白的題號（「1. 2. 3.」「F. G. H.」）。
 * 一般題目的題幹不會這樣寫（選項是 (1)(2)(3)，有括號，不算）。
 * @param {string} text
 * @param {number} [minRun=3]
 * @returns {boolean}
 */
function hasLabelRun(text, minRun = 3) {
    return labelGroups(text).some(g => g.labels.length >= minRun);
}

/**
 * 一頁 OCR 文字是不是解答頁（答案表）。
 * 條件：有「解答／答案」字樣（作答說明的「答案卡」「將答案」不算），而且
 *   ① 至少兩串 ≥ 3 個連號的題號；或 ② 至少 5 個題號、每個題號後面恰好一個簡單值（「1. 3 2. 4 3. 1 …」的排法）。
 * @param {string} pageText
 * @returns {boolean}
 */
function isAnswerKeyPage(pageText) {
    const raw = String(pageText ?? '');
    if (!KEY_HEADING_RE.test(raw.replace(KEY_HEADING_EXCLUDE_RE, ''))) return false;
    const groups = labelGroups(raw);
    if (groups.filter(g => g.labels.length >= 3).length >= 2) return true;
    const singles = groups.filter(g => g.labels.length === 1 && g.values.length === 1 && SIMPLE_VALUE_RE.test(g.values[0]));
    return singles.length >= 5 && singles.length >= groups.length * 0.8;
}

/**
 * 解析一頁解答表。每一串題號是一列：值的個數與題號個數相同、而且每個值都是簡單值，這一列才「確定」；
 * 否則整列的值都不採用（分數被 OCR 拆成上下兩個數字時個數會多出來，或出現 7-9、17'7 這種樣子）。
 * 第一串題號之前的字（頁首、標題）不算。
 * @param {string} pageText
 * @param {number|null} [page]
 * @returns {{entries:Array<{label:string, value:string|null, certain:boolean, page:number|null}>, rows:Array<{labels:string[], values:string[], certain:boolean}>}}
 */
function parseAnswerKey(pageText, page = null) {
    const rows = [];
    const entries = [];
    for (const g of labelGroups(pageText)) {
        const certain = g.values.length === g.labels.length && g.values.every(v => SIMPLE_VALUE_RE.test(v));
        rows.push({ labels: g.labels.slice(), values: g.values.slice(), certain });
        g.labels.forEach((label, i) => {
            entries.push({ label, value: certain ? g.values[i].replace(/−/g, '-') : null, certain, page });
        });
    }
    return { entries, rows };
}

/**
 * Dice 係數（字元雙連，去空白、$ 與標點）。只拿來判斷「這段字是不是出自解答頁」。
 */
function bigrams(text) {
    const s = String(text ?? '').normalize('NFKC').replace(/[\s$\\{}]+/g, '');
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
        const b = s.slice(i, i + 2);
        out.set(b, (out.get(b) || 0) + 1);
    }
    return out;
}

/** a 的雙連有幾成出現在 b 裡（包含度，不是相似度） */
function containment(a, b) {
    const ba = bigrams(a);
    const bb = bigrams(b);
    let total = 0;
    let hit = 0;
    for (const [k, n] of ba) {
        total += n;
        hit += Math.min(n, bb.get(k) || 0);
    }
    return total === 0 ? 0 : hit / total;
}

/**
 * 拆出來的一題是不是解答表（不該建成題目）。
 * @param {string} questionText
 * @param {{allPagesAreKeys?:boolean, keyPageTexts?:string[], otherPageTexts?:string[]}} ctx
 * @returns {string|null} 原因（'key_chunk'｜'label_run'｜'key_text'）；不是就 null
 */
function isAnswerKeyElement(questionText, { allPagesAreKeys = false, keyPageTexts = [], otherPageTexts = [] } = {}) {
    if (allPagesAreKeys) return 'key_chunk';
    if (!keyPageTexts.length) return null;
    if (hasLabelRun(questionText, 3)) return 'label_run';
    const keyText = keyPageTexts.join('\n');
    const inKey = containment(questionText, keyText);
    const inOther = otherPageTexts.length ? containment(questionText, otherPageTexts.join('\n')) : 0;
    return inKey >= 0.8 && inOther < 0.5 ? 'key_text' : null;
}

/**
 * 同一塊裡至少 3 題題幹幾乎相同、而且都有連號題號串：不靠頁面偵測也認得出的解答表（「拆出的題幹幾乎相同且都含頁首」）。
 * @param {string[]} texts
 * @returns {Set<number>} 這些位置是解答表
 */
function duplicateKeyStems(texts) {
    const out = new Set();
    const cand = texts.map((t, i) => ({ i, t: String(t ?? '') })).filter(x => hasLabelRun(x.t, 3));
    for (const a of cand) {
        const near = cand.filter(b => b.i !== a.i && containment(a.t, b.t) >= 0.9 && containment(b.t, a.t) >= 0.9);
        if (near.length >= 2) out.add(a.i);
    }
    return out;
}

/**
 * 題目頁上有沒有寫出答案或解析。沒有的話，拆題模型給的 answer_text 一定是它自己編的。
 * @param {string} text 題目頁（不含解答頁）的 OCR 文字
 * @returns {boolean}
 */
function hasAnswerOnPage(text) {
    const s = String(text ?? '');
    return ANSWER_MARKERS.some(re => re.test(s));
}

/**
 * 答案只是填答格的記號（⑮⑯、\textcircled{m}、底線），不是答案。
 * @param {string} answer
 * @returns {boolean}
 */
function isBlankMarkerAnswer(answer) {
    const s = String(answer ?? '');
    if (!s.trim()) return false;
    const rest = s
        .replace(/\\textcircled\s*\{[^{}]*\}/g, '')
        .replace(/[①-⑳㉑-㉟㊱-㊿⓪⓵-⓾]/g, '')
        .replace(/[＿_\s$、，,。.;；]/g, '')
        .replace(/\\(?:underline|qquad|quad)\s*(?:\{\s*\})?/g, '');
    return rest === '';
}

/** 題幹開頭的題號（「1. 設…」「A. 已知…」「(3) …」不算——那是選項或小題）；沒有寫就 null */
function leadingLabel(questionText) {
    const m = /^\s*(?:第\s*)?(\d{1,2}|[A-H])\s*[.．、]\s*(?!\d)/.exec(String(questionText ?? ''));
    return m ? m[1].toUpperCase() : null;
}

/**
 * 解答表的一個值 → 依題型寫成 answer_text。題型與值的樣子對不上回 null（不回填那一題）。
 * @param {string} value
 * @param {string} questionType
 * @returns {string|null}
 */
function formatKeyAnswer(value, questionType) {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (questionType === '單選') {
        if (/^[1-9]$/.test(v)) return `(${v})`;
        return null;
    }
    if (questionType === '多選') {
        if (!/^[1-9]{1,9}$/.test(v)) return null;
        const digits = [...v];
        // 解答表的多選寫法是由小到大、不重複（245）；不是的話（542、22）不像多選答案
        for (let i = 1; i < digits.length; i++) if (!(digits[i] > digits[i - 1])) return null;
        return digits.map(d => `(${d})`).join('');
    }
    if (questionType === '證明') return null;
    if (!SIMPLE_VALUE_RE.test(v)) return null;
    const m = /^(-?)(\d+)\/(\d+)$/.exec(v);
    if (m) return `$${m[1]}\\frac{${m[2]}}{${m[3]}}$`;
    return `$${v}$`;
}

/**
 * 解答表 → 要回填的題。
 * 條件（任一不成立就整份不回填，回 ok:false 與原因）：
 *   - 解答表的題號不重複；
 *   - 題號總數＝存活的題數（依 idx 排序後一一對應；一份卷的解答表題號就是題序）；
 *   - 題幹開頭寫了題號的題，與對應的題號相同。
 * 個別不回填（skipped）：那一列不確定、題型與值對不上、這一題已經有答案。
 * @param {Array<{label:string, value:string|null, certain:boolean}>} entries 依頁序、題號序
 * @param {Array<{id:number, idx:number, question_type:string, question_text:string, answer_text?:string}>} questions
 * @returns {{ok:boolean, reason:string|null, updates:Array<{id:number, idx:number, label:string, answer_text:string}>, skipped:Array<{idx:number|null, label:string, reason:string}>}}
 */
function mapAnswerKey(entries, questions) {
    const list = Array.isArray(entries) ? entries : [];
    const qs = (Array.isArray(questions) ? questions : []).slice().sort((a, b) => a.idx - b.idx);
    const result = { ok: false, reason: null, updates: [], skipped: [] };
    if (!list.length) return { ...result, reason: 'no_entries' };
    const labels = list.map(e => e.label);
    if (new Set(labels).size !== labels.length) return { ...result, reason: 'duplicate_labels' };
    if (labels.length !== qs.length) return { ...result, reason: `count_mismatch:${labels.length}/${qs.length}` };
    for (let i = 0; i < qs.length; i++) {
        const own = leadingLabel(qs[i].question_text);
        if (own !== null && own !== labels[i]) return { ...result, reason: `label_mismatch:${qs[i].idx}:${own}/${labels[i]}` };
    }
    result.ok = true;
    qs.forEach((q, i) => {
        const e = list[i];
        if (!e.certain || e.value === null) { result.skipped.push({ idx: q.idx, label: e.label, reason: 'uncertain_row' }); return; }
        if (String(q.answer_text ?? '').trim()) { result.skipped.push({ idx: q.idx, label: e.label, reason: 'has_answer' }); return; }
        const text = formatKeyAnswer(e.value, q.question_type);
        if (text === null) { result.skipped.push({ idx: q.idx, label: e.label, reason: 'type_mismatch' }); return; }
        result.updates.push({ id: q.id, idx: q.idx, label: e.label, answer_text: text });
    });
    return result;
}

/**
 * 本機拆題一塊的答案處理（agents/extract.js 的本機路徑呼叫）：解答頁偵測、解答表元素、題目頁沒寫答案時清掉編出來的答案。
 * @param {Array<object>} elements normalizeElement 之後的元素（會就地改 answer_text，另外回傳每一個的紀錄）
 * @param {Array<{page:number, markdown:string}>|null} pages 這一塊的 OCR 頁面（沒有 OCR 時 null：什麼都不做）
 * @returns {{skip:Map<number,string>, notes:Map<number,object>, summary:object|null}}
 *   skip：位置 → 不建題的原因；notes：位置 → 寫進該題的 answer_dropped；summary：寫進 data.answer_key（沒有解答頁也沒有清答案時 null）
 */
function processChunkAnswers(elements, pages) {
    const skip = new Map();
    const notes = new Map();
    if (!Array.isArray(pages) || pages.length === 0) return { skip, notes, summary: null };
    const keyPages = pages.filter(p => isAnswerKeyPage(p.markdown));
    const otherPages = pages.filter(p => !keyPages.includes(p));
    const keyTexts = keyPages.map(p => String(p.markdown ?? ''));
    const otherTexts = otherPages.map(p => String(p.markdown ?? ''));
    const allPagesAreKeys = keyPages.length > 0 && otherPages.length === 0;

    elements.forEach((el, i) => {
        const why = isAnswerKeyElement(el.question_text, { allPagesAreKeys, keyPageTexts: keyTexts, otherPageTexts: otherTexts });
        if (why) skip.set(i, why);
    });
    for (const i of duplicateKeyStems(elements.map(e => e.question_text))) if (!skip.has(i)) skip.set(i, 'duplicate_stems');

    // 題目頁上沒有寫答案 → 拆題模型給的答案是自己編的；寫了答案但只是填答格記號 → 也不是答案
    const answered = hasAnswerOnPage(otherTexts.join('\n'));
    let dropped = 0;
    elements.forEach((el, i) => {
        if (skip.has(i)) return;
        const original = typeof el.answer_text === 'string' ? el.answer_text : '';
        if (!original.trim()) return;
        let reason = null;
        if (!answered) reason = 'not_on_page';
        else if (isBlankMarkerAnswer(original)) reason = 'blank_marker';
        if (!reason) return;
        el.answer_text = '';
        notes.set(i, { reason, text: original.length > 300 ? `${original.slice(0, 300)}…` : original });
        dropped += 1;
    });

    const parsed = keyPages.map(p => parseAnswerKey(p.markdown, p.page));
    const entries = parsed.flatMap(p => p.entries);
    if (!keyPages.length && skip.size === 0 && dropped === 0) return { skip, notes, summary: null };
    return {
        skip, notes,
        summary: {
            pages: keyPages.map(p => p.page),
            skipped: [...skip.entries()].map(([position, reason]) => ({ position: position + 1, reason })),
            entries,
            rows: parsed.flatMap(p => p.rows).map(r => ({ labels: r.labels, certain: r.certain, ...(r.certain ? {} : { values: r.values }) })),
            answers_on_page: answered,
            answers_dropped: dropped
        }
    };
}

module.exports = {
    isAnswerKeyPage, parseAnswerKey, isAnswerKeyElement, duplicateKeyStems, hasAnswerOnPage, isBlankMarkerAnswer,
    hasLabelRun, labelGroups, leadingLabel, formatKeyAnswer, mapAnswerKey, processChunkAnswers, containment
};
