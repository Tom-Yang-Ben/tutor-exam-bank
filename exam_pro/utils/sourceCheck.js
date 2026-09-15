// ─────────────────────────────────────────────────────────────
// utils/sourceCheck.js — 拆題結果對照原卷文字層（roadmap §6.5 待辦 12、docs/source-check.md）
//
// 為什麼要有這一支：2026-09-15 以八份原卷核對題庫，現行管線入庫的題有 4 題把題幹或選項抄錯
// （常數多一個負號、向量分量多一個負號、解的分量正負號錯、選項分母漏字母 m）；
// verify agent 只比答案、不比題幹，抄錯的題幹會讓正確答案看起來像錯。
//
// 做法（決定性、不呼叫 LLM、不影響 cassette）：
//   1. locateSegments：以題目的中文字 5-gram 在原卷文字層定位對應段落（覆蓋率 ≥ 0.8 才算找到），
//      段落截到「換行＋題號」「題組」「答案卷」或 tailMax 字。extract 階段做，只存段落。
//   2. compareSegment：兩邊各自正規化後比對三種訊號，採用校準後的規則
//        負號比原卷多（僅在原卷段落本身有負號時才比——有些 PDF 的算式負號不在文字層）
//        ∪（原卷有的小寫字母拆題缺少 ≥ 1 ∧ 原卷有的數字拆題缺少 ≤ 1；附圖題不比字母）
//        ∪（選用，預設關閉）拆題多出的數字 ≥ 2
//
// 本檔是純函式：不讀檔、不碰 DB、不讀 process.env。原卷文字層由呼叫端提供。
// ─────────────────────────────────────────────────────────────

/**
 * 預設參數。校準（2026-09-15，eval/tools/calibrate_source_check.js；真實原卷資料不進 repo，
 * 數字與 docs/source-check.md 第 4 節同步）：
 *   樣卷 eval/fixtures/sample_exam.pdf ＋ extract.v2 cassette 10 題：可比對 5、跳過 5、誤報 0。
 *   真實原卷 8 份、現行入庫題 117 列（排除 rejected／duplicate）：
 *     可比對 63（53.8%），TP 3、FP 0、FN 2（1 題中文字太少、1 題在掃描檔上，皆為跳過而非判一致）；
 *     跳過 no_text_layer 24（20.5%）、low_anchor 17（14.5%）、not_found 11（9.4%）、locate_mismatch 2（1.7%）。
 *   與原型（tailMax 160、無 PUA 對映、同分取最早位置）比較：TP 同為 3，FP 2 → 0。三項調整各消一種誤報，
 *   缺任一項 FP 都是 1：
 *     - 同覆蓋率時優先「開頭 gram 對齊」的起點：避免段落從上一題尾巴起算、帶進別題的字母。
 *     - tailMax 160 → 600：矩陣題的文字層一格一行，160 字截掉選項後負號變少而誤報。
 *     - PUA 對映：U+F02D 在兩份 Symbol 字型原卷上是負號（負號字形 0 → 93、11 → 59）；
 *       不對映時，原卷段落只剩部分負號仍會觸發「負號比原卷多」。
 *   其餘：minCoverage 0.7 可多比 8 題但 FP 0 → 2；拆題多出數字 ≥ 2（extraDigitsRule）召回不增、FP 0 → 4，維持關閉。
 */
const DEFAULTS = Object.freeze({
    k: 5,                        // 中文字 n-gram 長度
    minCjk: 12,                  // 題目中文字少於此數不比（純算式題定位不可靠）→ low_anchor
    minCoverage: 0.8,            // 定位覆蓋率門檻；低於此數 → not_found（0.7 可多比 8 題但 FP 0 → 2）
    tailMax: 600,                // 題目最後一個中文字之後，最多再往後取的字元數（原型 160，見上）
    segmentMax: 1500,            // 存進 payload 的段落上限
    minTextLayerChars: 200,      // 整塊文字層（去空白）少於此數視為掃描檔 → no_text_layer
    puaMap: true,                // Symbol 字型的 Private Use Area 對映（U+F02D 負號、U+F030–F039 數字等）
    extraDigitsRule: false,      // 「拆題多出數字 ≥ 2」：題組題會把前導語放進每個小題而誤報，預設關閉
    extraDigitsMin: 2
});

const FUNCS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lim', 'exp', 'det', 'max', 'min'];

const CJK_ONE = /[一-鿿]/;
const CJK_ALL = /[一-鿿]/g;
const MINUS_ALL = /[-\u2212]/g;                 // - 與 U+2212；NFKC 已把全形 U+FF0D 轉成 -
const QUESTION_NO_PREFIX = /^\s*[（(]?\s*\d{1,2}\s*[.、．)）]\s*/;
const SCORE_NOTE = /[（(]\s*(?:每題|共|各)?\s*\d+\s*分\s*[）)]|(?:每題|每小題|共)\s*\d+\s*分/g;
const FIGURE_NOTE = /\[附圖描述[：:][\s\S]*?\]/g;

/**
 * Symbol／MathType 類字型把 ASCII 放在 U+F020–F07F（Private Use Area）。
 * 只對映在數學式裡會被比對的那幾個：負號、加號、等號、十個數字。
 * **不**對映 U+F061–F07A：Symbol 字型的那一段是希臘字母（F070 = π），當成拉丁字母會誤報。
 */
const PUA_MAP = Object.freeze({
    '\uF02D': '-', '\uF02B': '+', '\uF03D': '=',
    '\uF030': '0', '\uF031': '1', '\uF032': '2', '\uF033': '3', '\uF034': '4',
    '\uF035': '5', '\uF036': '6', '\uF037': '7', '\uF038': '8', '\uF039': '9'
});
const PUA_RE = /[\uF02B\uF02D\uF030-\uF039\uF03D]/g;

function opt(options) {
    return { ...DEFAULTS, ...(options || {}) };
}

/**
 * 原卷文字層 → 可比對字串：NFKC（全形數字與符號、相容漢字）＋ PUA 對映。
 * @param {string} text
 * @param {{puaMap?:boolean}} [options]
 */
function normalizeSourceText(text, options) {
    const o = opt(options);
    let t = String(text ?? '').normalize('NFKC');
    if (o.puaMap) t = t.replace(PUA_RE, (ch) => PUA_MAP[ch]);
    return t;
}

/**
 * 拆題的 LaTeX 題幹 → 可與原卷文字層比對的字串。
 * 去掉指令名（保留 sin／cos 等函數名）、環境名與 array 欄位格式、\left／\right、排版符號；
 * \pm／\mp 整個去掉（不算負號）；\text{…} 等保留內容。
 * @param {string} text
 */
function latexToComparable(text) {
    let t = String(text ?? '').normalize('NFKC').replace(FIGURE_NOTE, ' ');
    t = t.replace(/\\begin\s*\{[^{}]*\}(\s*\{[^{}]*\})?/g, ' ');     // 環境名與 array 欄位格式 {|c|c|}
    t = t.replace(/\\end\s*\{[^{}]*\}/g, ' ');
    t = t.replace(/\\(?:left|right)\b\s*\.?/g, ' ');
    t = t.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|mbox)\s*\{([^{}]*)\}/g, ' $1 ');
    t = t.replace(/\\([a-zA-Z]+)/g, (m, name) => (FUNCS.includes(name) ? ` ${name} ` : ' '));
    t = t.replace(/[{}$^_&\\]/g, ' ');
    return t;
}

/** 題號前綴與配分註記（兩邊都去掉，避免題號與分數的數字干擾比對） */
function stripNumbering(s) {
    return String(s ?? '').replace(QUESTION_NO_PREFIX, '').replace(SCORE_NOTE, ' ');
}

/** 數字、小寫字母多重集合與負號數量 */
function tally(s) {
    const digits = {};
    const lower = {};
    const str = String(s ?? '');
    for (const ch of str) {
        if (ch >= '0' && ch <= '9') digits[ch] = (digits[ch] || 0) + 1;
        else if (ch >= 'a' && ch <= 'z') lower[ch] = (lower[ch] || 0) + 1;
    }
    return { digits, lower, minus: (str.match(MINUS_ALL) || []).length };
}

/** a 有而 b 沒有（或較少）的部分 */
function multisetMinus(a, b) {
    const out = {};
    for (const [key, v] of Object.entries(a)) {
        const d = v - (b[key] || 0);
        if (d > 0) out[key] = d;
    }
    return out;
}
const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);

function cjkIndex(raw) {
    const pos = [];
    let seq = '';
    for (let i = 0; i < raw.length; i++) {
        if (CJK_ONE.test(raw[i])) { pos.push(i); seq += raw[i]; }
    }
    return { seq, pos };
}

function grams(s, k) {
    const g = [];
    for (let i = 0; i + k <= s.length; i++) g.push(s.slice(i, i + k));
    return g;
}

function cjkOf(text) {
    return (String(text ?? '').match(CJK_ALL) || []).join('');
}

/** 文字層（去空白）夠不夠長；不夠就當掃描檔 */
function hasTextLayer(pageText, options) {
    return String(pageText ?? '').replace(/\s/g, '').length >= opt(options).minTextLayerChars;
}

/**
 * 在（已正規化的）原卷文字層中定位一題的段落。
 * @param {string} questionText
 * @param {string} raw        normalizeSourceText 之後的文字層
 * @param {object} page       cjkIndex(raw)
 * @param {number} cursor     上一題定位到的 CJK 起點（依序定位：同分時優先取不早於它的位置）
 * @param {object} o          合併後的參數
 */
function locateOne(questionText, raw, page, cursor, o) {
    const q = cjkOf(questionText);
    if (q.length < o.minCjk) return { status: 'low_anchor', locate_score: null };
    const qg = grams(q, o.k);
    const starts = new Set();
    qg.slice(0, 12).forEach((g, i) => {
        let s = page.seq.indexOf(g);
        while (s >= 0) { starts.add(Math.max(0, s - i)); s = page.seq.indexOf(g, s + 1); }
    });
    // 同覆蓋率時的決勝：①開頭 12 個 gram 有幾個落在「剛好對齊」的位置（避免從上一題尾巴起算——
    // 上一題結尾若與本題共用詞組如「之最小值為」，往前挪幾個字覆蓋率一樣是 1）；②依序定位，不早於上一題。
    let best = null;
    for (const start of [...starts].sort((a, b) => a - b)) {
        const spanGrams = new Set(grams(page.seq.slice(start, start + q.length + 10), o.k));
        const coverage = qg.filter((g) => spanGrams.has(g)).length / qg.length;
        const aligned = qg.slice(0, 12).filter((g, i) => page.seq.startsWith(g, start + i)).length;
        const tie = best && Math.abs(coverage - best.coverage) <= 1e-9;
        const better = !best || coverage > best.coverage + 1e-9
            || (tie && aligned > best.aligned)
            || (tie && aligned === best.aligned && best.start < cursor && start >= cursor);
        if (better) best = { start, coverage, aligned };
    }
    if (!best) return { status: 'not_found', locate_score: 0 };
    const score = Number(best.coverage.toFixed(2));
    if (best.coverage < o.minCoverage) return { status: 'not_found', locate_score: score };

    const startRaw = page.pos[best.start];
    const lastCjk = Math.min(page.seq.length - 1, best.start + q.length - 1);
    const endRaw = page.pos[lastCjk] + 1;
    let from = startRaw;
    const back = raw.slice(Math.max(0, startRaw - 14), startRaw);
    const numbered = back.match(/(\d{1,2}\s*[.、．][^一-鿿]*)$/);
    if (numbered) from = startRaw - numbered[0].length;
    const tail = raw.slice(endRaw, endRaw + o.tailMax);
    const stops = [
        tail.search(/\n\s*[（(]?\s*\d{1,2}\s*[.、．]\s*\S/),
        tail.search(/題組/),
        tail.search(/答案卷|答案欄/)
    ].filter((x) => x >= 0);
    const to = endRaw + (stops.length ? Math.min(...stops) : tail.length);
    return {
        status: 'located', locate_score: score,
        segment: raw.slice(from, to).slice(0, o.segmentMax),
        from, to, cjkStart: best.start
    };
}

/**
 * 依序定位一塊（chunk）裡的所有題目。
 *
 * @param {Array<{question_text:string}>} questions  依卷面順序（extract 的輸出順序）
 * @param {string} pageText   這一塊所有頁的文字層（依頁序串接，**未**正規化）
 * @param {object} [options]  覆寫 DEFAULTS
 * @returns {Array<{status:string, locate_score:number|null, segment?:string, shared?:boolean}>}
 *          與 questions 一一對應；status ∈ located／no_text_layer／not_found／low_anchor
 *          shared=true：段落與前一題重疊（題組前導語、承上題），比對結果較不可靠
 */
function locateSegments(questions, pageText, options) {
    const o = opt(options);
    const list = Array.isArray(questions) ? questions : [];
    if (!hasTextLayer(pageText, o)) return list.map(() => ({ status: 'no_text_layer', locate_score: null }));
    const raw = normalizeSourceText(pageText, o);
    const page = cjkIndex(raw);
    let cursor = 0;
    let prev = null;
    return list.map((q) => {
        const r = locateOne(q?.question_text, raw, page, cursor, o);
        if (r.status !== 'located') return { status: r.status, locate_score: r.locate_score };
        const shared = Boolean(prev && r.from < prev.to && prev.from < r.to);
        cursor = r.cjkStart + 1;   // 下一題同分時要「嚴格晚於」本題起點（兩題題幹一字不差時才分得開）
        prev = r;
        return { status: 'located', locate_score: r.locate_score, segment: r.segment, ...(shared ? { shared: true } : {}) };
    });
}

/**
 * 比對單題：拆題題幹 vs 已定位的原卷段落。
 *
 * @param {{questionText:string, segment:string, hasFigure?:boolean}} input
 * @param {object} [options]
 * @returns {{verdict:'match'|'mismatch'|'skipped', reason?:string, signals?:object, detail?:object}}
 *          skipped 的 reason：low_anchor（題目中文字太少）／locate_mismatch（段落對不上這個題幹，
 *          例如人或 lint 大改了題幹）
 */
function compareSegment({ questionText, segment, hasFigure = false } = {}, options) {
    const o = opt(options);
    const q = cjkOf(questionText);
    if (q.length < o.minCjk) return { verdict: 'skipped', reason: 'low_anchor' };
    const seg = normalizeSourceText(segment, o);
    const segGrams = new Set(grams(cjkOf(seg), o.k));
    const qg = grams(q, o.k);
    const coverage = qg.filter((g) => segGrams.has(g)).length / qg.length;
    if (coverage < o.minCoverage) {
        return { verdict: 'skipped', reason: 'locate_mismatch', coverage: Number(coverage.toFixed(2)) };
    }

    const A = tally(stripNumbering(latexToComparable(questionText)));
    const P = tally(stripNumbering(seg));
    const missingDigits = multisetMinus(P.digits, A.digits);
    const missingLower = multisetMinus(P.lower, A.lower);
    const extraDigits = multisetMinus(A.digits, P.digits);
    const signals = {
        extraMinus: P.minus > 0 ? Math.max(0, A.minus - P.minus) : 0,
        missLower: hasFigure ? 0 : sum(missingLower),
        missDigits: sum(missingDigits),
        extraDigits: sum(extraDigits)
    };
    const rules = [];
    if (signals.extraMinus >= 1) rules.push('extra_minus');
    if (signals.missLower >= 1 && signals.missDigits <= 1) rules.push('missing_lower');
    if (o.extraDigitsRule && signals.extraDigits >= o.extraDigitsMin) rules.push('extra_digits');
    return {
        verdict: rules.length ? 'mismatch' : 'match',
        rules,
        signals,
        coverage: Number(coverage.toFixed(2)),
        detail: {
            minus_extracted: A.minus, minus_source: P.minus,
            missing_lower: hasFigure ? {} : missingLower, missing_digits: missingDigits, extra_digits: extraDigits
        }
    };
}

/**
 * 給複核頁與 job_events.detail.feedback 的一句話（繁體中文）。
 * @param {object} result compareSegment 的回傳
 * @returns {string} 不是 mismatch 時回空字串
 */
function describeMismatch(result) {
    if (!result || result.verdict !== 'mismatch') return '';
    const parts = [];
    const rules = result.rules || [];
    if (rules.includes('extra_minus')) {
        parts.push(`負號比原卷多 ${result.signals.extraMinus} 個（拆題 ${result.detail.minus_extracted}、原卷 ${result.detail.minus_source}）`);
    }
    if (rules.includes('missing_lower')) {
        parts.push(`原卷有、拆題漏掉的字母：${Object.keys(result.detail.missing_lower).join('、')}`);
    }
    if (rules.includes('extra_digits')) {
        parts.push(`拆題多出原卷沒有的數字：${Object.keys(result.detail.extra_digits).join('、')}`);
    }
    return `拆題題幹與原卷文字層不一致：${parts.join('；')}。請對照原卷確認題幹與選項。`;
}

module.exports = {
    DEFAULTS, FUNCS, PUA_MAP,
    normalizeSourceText, latexToComparable, stripNumbering, tally, hasTextLayer,
    locateSegments, compareSegment, describeMismatch
};
