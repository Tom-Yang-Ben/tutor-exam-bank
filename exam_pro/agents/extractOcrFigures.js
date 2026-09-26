// agents/extractOcrFigures.js — 「只用 OCR 拆題」時，依 OCR 的版面位置把附圖配到題目
// （〔OCR 為主 2026-09-26〕Owner 決定這台電腦的拆題改成 OCR 為主；docs/local-mode.md 10.12）
//
// 交叉驗證模式（cross）的附圖框來自視覺模型；LOCAL_EXTRACT_MODE=ocr 不呼叫視覺模型，文字模型又看不到圖
// （extract_ocr 的模板要它不要輸出附圖欄位），所以改用 PaddleOCR PP-StructureV3 的版面偵測：
// ocr_pdf.py 回報每頁會在 markdown 變成「[圖]」的區塊與圖框（services/ocr 的 pages[].figures，依閱讀順序），
// 本檔把第 k 個「[圖]」對到第 k 個圖框，再決定它屬於哪一題。**純函式**：不讀檔、不碰 DB、不呼叫模型、不讀 process.env。
//
// ── 題目在 OCR 文字裡的範圍 ──
//   1. 把各頁 markdown 依頁序接起來（與 services/ocr 的 pagesToText 同一個形狀），先做原卷比對用的正規化
//      （utils/sourceCheck 的 normalizeSourceText：NFKC＋Symbol 字型對映）。
//   2. 每一題的題幹依序定位（utils/sourceCheck 的 locateOne：中文字 5-gram、覆蓋率 ≥ 0.8；中文字少於 12 個的題定位不到）。
//   3. 題目的起點：
//      - locateOne 已經把同一行的題號算進題幹起點（「3. 一個質量…」）→ 起點就是那裡，不再往前找；
//      - 上一個元素（模型拆出來的上一題）定位不到 → 起點就是題幹起點，不往前找（往前找到的題號行多半是那一題的）；
//      - 其餘：題幹起點往前 80 字內、不越過上一題題幹終點的最近「題號行」（「12.」「## 1 ．」「( )3、」「第 3 題」這種行首）；
//        沒有題號行就是題幹起點。
//      題目的範圍＝［這一題的起點, 下一題的起點）。附圖常在題號與題幹之間、題幹旁邊或題幹之後，都在這個範圍裡。
//      〔審查 2026-09-26〕以前一律往前找、而且只被定位到的題推進下界：上一題定位不到（中文字少於 12 個的「2. 如圖，求 ∠A。」）
//      或被模型漏拆、本題題號又與題幹同一行時，本題的起點會被拉回上一題的題號行，上一題的圖就自動配給本題。
//
// ── 配圖（配不準的寧可不配）──
//   一張圖（標籤 image／chart；印章 seal 不是附圖）屬於「起點在它之前、最後一個」定位到的題，而且要同時滿足：
//     ① 與那一題的起點在同一頁（跨頁的題、下一頁頁首的圖不配）；
//     ② 那一題與它前後的題之間沒有定位不到的題（不然說不準是誰的）：往後看＝與下一個定位到的題之間；
//        往前看由上面第 3 點保證——上一題定位不到時本題的範圍從題幹起點算，題幹之前的圖落在更前面那一題的範圍、
//        在那裡被「往後看」擋下（第一個元素就定位不到時，題號行之後的圖給那幾題標 nearby）；
//     ③ 圖框合法；
//     ④ 那一題的範圍內只有這一張（兩張以上不猜哪一張，也不把兩張框在一起——中間可能夾著題目文字）；
//     ⑤ 圖在題幹之後、這一題沒提到圖，而下一題提到圖（「如圖」「如右圖」…），或上一題提到圖卻沒有自己的圖
//        （版面閱讀順序把上一題右側的圖排到本題文字之後）→ 說不準是誰的，不配；
//     ⑥ 圖在題幹之後，而題幹終點與圖之間有一行題號行 → 圖在一題「模型沒拆到」的題裡（漏拆、輸出被截斷少了後面幾題），
//        不配、標 nearby；
//     ⑦ 這一塊的 extract_ocr 可能被截斷（呼叫端傳 truncated：粗估放不下 OLLAMA_NUM_CTX、或輸出用滿上限）→
//        整塊一張都不自動配，原本會配的都改標 nearby（模型可能少拆了題，範圍說不準）。
//   第一題起點之前的圖（校徽、卷首的圖）不屬於任何題，不配也不提示。
//   配到的題寫 figure_page（整份 PDF 的絕對頁碼，OCR 回的就是）與 figure_box（[ymin,xmin,ymax,xmax]，0–1000），
//   裁圖照舊由 workers/jobRunner.js 的 attachFigureImages（services/figureService）在 PDF 刪檔前做。
//   已知限制：題號寫成「(1)」「（2）」的卷認不出題號行（這種寫法在學測式的卷是選項、在題組是小題，當成題號會把
//   題組的圖切掉）；這種卷的圖若排在題號與題幹之間、題幹又沒寫「如圖」，會配給上一題——進人工複核，
//   複核頁有「請確認裁到的是這一題的圖」這句（docs/local-mode.md 10.12 第 4 點）。
//
// ── 提示（figure_hint，給複核頁：「疑似有圖未配到，可用 figures:backfill 補」）──
//   { reason:'multiple', count }  範圍內有 count 張圖（④）
//   { reason:'nearby', count }    範圍附近有 count 張圖但配不準（①②③⑥⑦）
//   { reason:'mentions' }         題幹提到圖（utils/figureLayout 的 hasFigureHint，或沒清掉的「[圖]」）卻沒配到圖
//   OCR 沒回報版面（舊版 ocr_pdf.py、舊 cassette）或某一頁的圖框數與「[圖]」數對不上：那一頁一張都不配，
//   只剩 mentions 這一種提示。

const { DEFAULTS, normalizeSourceText, locateOne, cjkIndex } = require('../utils/sourceCheck');
const { hasFigureHint } = require('../utils/figureLayout');

/** ocr_pdf.py 的 clean_markdown 把附圖換成的字樣 */
const FIGURE_TOKEN = '[圖]';
/** 可以當附圖配給題目的版面標籤（seal＝印章，會變成「[圖]」但不是題目的圖） */
const ASSIGNABLE_LABELS = Object.freeze(['image', 'chart']);
/** 題幹起點往前找題號行的距離（字元） */
const NUMBER_LINE_BACK = 80;
/**
 * 題號行：行首的「12.」「12、」「## 1 ．」「( )3.」「第 3 題」「第三題」（markdown 標題記號、題前的作答括號都容許；
 * 1.5 這種小數不算）。「(1)」「（2）」不算（學測式的卷是選項、題組是小題；見檔頭「已知限制」）。
 */
const NUMBER_LINE_RE = /^[ \t]*#{0,6}[ \t]*(?:[(（][ \t]*[)）][ \t]*)?(?:[(（]?[ \t]*\d{1,2}[ \t]*[.、．](?!\d)|第[ \t]*(?:\d{1,2}|[一二三四五六七八九十]{1,3})[ \t]*題)/;
const CJK_ALL = /[一-鿿]/g;

/**
 * 題幹提到圖（「如圖」「附圖」「下圖」「右圖」「圖中」…，或模型沒清掉的「[圖]」）。
 * @param {string} text
 * @returns {boolean}
 */
function mentionsFigure(text) {
    const s = typeof text === 'string' ? text : '';
    return s.includes(FIGURE_TOKEN) || hasFigureHint(s);
}

/** 0–1000 的 [ymin,xmin,ymax,xmax]，幾何上合法才回一份複本；否則 null */
function validBox(box) {
    if (!Array.isArray(box) || box.length !== 4) return null;
    if (!box.every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
    if (!(box[0] < box[2] && box[1] < box[3])) return null;
    return box.slice();
}

/**
 * 各頁接成一段正規化過的文字，記下每頁的位置、每個「[圖]」的位置與對應的圖框。
 * @param {Array<{page:number, markdown:string, figures?:Array<{label:string, box:number[]|null}>}>} pages
 */
function buildIndex(pages) {
    const parts = [];
    const out = [];
    let offset = 0;
    pages.forEach((p, i) => {
        if (i > 0) { parts.push('\n\n'); offset += 2; }
        const header = `<!-- 第 ${p.page} 頁 -->\n`;
        const content = normalizeSourceText(String((p && p.markdown) ?? '').trim());
        const start = offset;
        const contentStart = offset + header.length;
        parts.push(header, content);
        offset += header.length + content.length;

        const tokens = [];
        for (let k = content.indexOf(FIGURE_TOKEN); k >= 0; k = content.indexOf(FIGURE_TOKEN, k + FIGURE_TOKEN.length)) {
            tokens.push(contentStart + k);
        }
        let layout = 'none';
        let figures = [];
        if (Array.isArray(p.figures)) {
            if (p.figures.length === tokens.length) {
                layout = 'ok';
                figures = p.figures.map((f, j) => ({
                    page: p.page,
                    pos: tokens[j],
                    label: f && typeof f.label === 'string' ? f.label : 'unknown',
                    box: validBox(f && f.box)
                }));
            } else {
                layout = 'mismatch';
            }
        }
        out.push({ page: p.page, start, layout, figures });
    });
    return { raw: parts.join(''), pages: out };
}

/**
 * 題幹起點往前 NUMBER_LINE_BACK 字內（但不越過 lower）最近的題號行行首；沒有就是題幹起點。
 * @param {string} raw
 * @param {number} from  題幹起點
 * @param {number} lower 上一個定位到的題的題幹終點（不越過它）
 */
function numberLineBefore(raw, from, lower) {
    const lo = Math.max(0, lower, from - NUMBER_LINE_BACK);
    if (lo >= from) return from;
    const seg = raw.slice(lo, from);
    const lines = [];
    let s = 0;
    for (let i = 0; i <= seg.length; i++) {
        if (i === seg.length || seg[i] === '\n') { lines.push([s, i]); s = i + 1; }
    }
    for (let k = lines.length - 1; k >= 0; k--) {
        const [a, b] = lines[k];
        if (a === 0 && lo > 0 && raw[lo - 1] !== '\n') continue;   // 被 lo 切到一半的行不是行首
        if (NUMBER_LINE_RE.test(seg.slice(a, b))) return lo + a;
    }
    return from;
}

/**
 * (a, b) 之間有沒有一行以題號行開頭（行首在 a 之後、b 之前）。
 * 題幹終點與圖之間有題號行＝圖在另一題（模型沒拆到的題）裡（檔頭 ⑥）。
 * @param {string} raw
 * @param {number} a
 * @param {number} b
 */
function hasNumberLineBetween(raw, a, b) {
    for (let nl = raw.indexOf('\n', a); nl >= 0 && nl + 1 < b; nl = raw.indexOf('\n', nl + 1)) {
        const ls = nl + 1;
        const le = raw.indexOf('\n', ls);
        if (NUMBER_LINE_RE.test(raw.slice(ls, le < 0 ? raw.length : le))) return true;
    }
    return false;
}

/**
 * 依序定位每一題：{ from（題幹起點）, end（題幹最後一個中文字之後）, anchor（題目起點）}；定位不到回 null。
 * 起點的三條規則見檔頭「題目在 OCR 文字裡的範圍」第 3 點。
 * @param {Array<{question_text?:string}>} elements
 * @param {string} raw
 */
function locateAll(elements, raw) {
    const o = { ...DEFAULTS };
    const index = cjkIndex(raw);
    let cursor = 0;
    let lower = 0;
    let prevLocated = true;   // 第一個元素之前沒有「定位不到的上一題」
    return elements.map((el) => {
        const text = el && typeof el.question_text === 'string' ? el.question_text : '';
        const r = locateOne(text, raw, index, cursor, o);
        if (!r || r.status !== 'located') {
            prevLocated = false;
            return null;
        }
        cursor = r.cjkStart + 1;
        const q = (text.match(CJK_ALL) || []).length;
        const lastCjk = Math.min(index.seq.length - 1, r.cjkStart + q - 1);
        const end = index.pos[lastCjk] + 1;
        // locateOne 把同一行的題號算進去時，from 在題幹第一個中文字之前（「3. 一個質量」的「3」）
        const numbered = r.from < index.pos[r.cjkStart];
        const anchor = numbered || !prevLocated ? r.from : numberLineBefore(raw, r.from, lower);
        lower = Math.max(lower, end);
        prevLocated = true;
        return { from: r.from, end, anchor };
    });
}

/**
 * 依 OCR 版面把附圖配到題目。
 *
 * @param {Array<{question_text?:string}>} elements 模型拆出來的題（**全部**，含 schema 不合格的——
 *        它們在卷面上也佔一個位置，拿來切範圍；結果照位置一一對應，呼叫端只用合格的那幾題）
 * @param {Array<{page:number, markdown:string, figures?:Array}>} pages 這一塊的 OCR 頁（services/ocr 的 pages）
 * @param {{truncated?:boolean}} [opts] truncated：這一塊的 extract_ocr 可能被截斷（檔頭 ⑦），整塊只給提示、不自動配
 * @returns {{results:Array<{figure_page?:number, figure_box?:number[], figure_hint?:{reason:string, count?:number}}>,
 *            summary:{layout:'ok'|'none'|'mismatch'|'partial', detected:number, assigned:number, hinted:number, truncated?:true}}}
 */
function matchOcrFigures(elements, pages, opts = {}) {
    const els = Array.isArray(elements) ? elements : [];
    const pgs = (Array.isArray(pages) ? pages : []).filter(p => p && Number.isInteger(p.page));
    const truncated = Boolean(opts && opts.truncated);
    const n = els.length;
    const idx = buildIndex(pgs);
    const loc = locateAll(els, idx.raw);
    const mentions = els.map(el => mentionsFigure(el && el.question_text));
    const pageOf = (pos) => {
        let page = null;
        for (const p of idx.pages) if (p.start <= pos) page = p.page;
        return page;
    };
    const nextLocated = (i) => {
        let j = i + 1;
        while (j < n && !loc[j]) j += 1;
        return j;
    };
    const firstLocated = nextLocated(-1);

    const cands = els.map(() => []);
    const nearby = els.map(() => 0);
    let detected = 0;
    const figures = idx.pages.flatMap(p => p.figures).sort((a, b) => a.pos - b.pos);
    for (const fig of figures) {
        if (!ASSIGNABLE_LABELS.includes(fig.label)) continue;
        detected += 1;
        let owner = -1;
        for (let i = 0; i < n; i++) {
            if (loc[i] && loc[i].anchor <= fig.pos && (owner < 0 || loc[i].anchor >= loc[owner].anchor)) owner = i;
        }
        if (owner < 0) {
            // 第一個定位到的題之前：卷首、校徽，不配也不提示。但前面有定位不到的題、圖又在某一行題號行之後，
            // 那張圖是那幾題的（② 往前看的那一半）
            if (firstLocated > 0 && hasNumberLineBetween(idx.raw, -1, fig.pos)) {
                for (let k = 0; k < Math.min(firstLocated, n); k++) nearby[k] += 1;
            }
            continue;
        }
        const next = nextLocated(owner);
        if (next > owner + 1) {                          // ② 與下一個定位到的題之間有定位不到的題
            for (let k = owner; k < next; k++) nearby[k] += 1;
            continue;
        }
        if (pageOf(loc[owner].anchor) !== fig.page || !fig.box) {   // ① 跨頁、③ 框壞掉
            nearby[owner] += 1;
            continue;
        }
        if (fig.pos > loc[owner].end && hasNumberLineBetween(idx.raw, loc[owner].end, fig.pos)) {   // ⑥ 圖在沒拆到的題裡
            nearby[owner] += 1;
            continue;
        }
        if (truncated) {                                 // ⑦ 模型可能少拆了題：範圍說不準
            nearby[owner] += 1;
            continue;
        }
        cands[owner].push(fig);
    }

    let assigned = 0;
    const results = els.map((_, i) => {
        const out = {};
        if (cands[i].length === 1) {
            const f = cands[i][0];
            const next = nextLocated(i);
            const afterStem = f.pos > loc[i].end && !mentions[i];
            const ambiguous = afterStem && (
                (next < n && mentions[next])                                  // ⑤ 下一題提到圖
                || (i > 0 && mentions[i - 1] && cands[i - 1].length === 0)    // ⑤ 上一題提到圖、自己卻沒有圖
            );
            if (!ambiguous) {
                out.figure_page = f.page;
                out.figure_box = f.box.slice();
                assigned += 1;
            }
        } else if (cands[i].length > 1) {
            out.figure_hint = { reason: 'multiple', count: cands[i].length };   // ④
        }
        if (!out.figure_hint && nearby[i] > 0) out.figure_hint = { reason: 'nearby', count: nearby[i] };
        else if (!out.figure_hint && !out.figure_box && mentions[i]) out.figure_hint = { reason: 'mentions' };
        return out;
    });

    const layouts = idx.pages.map(p => p.layout);
    let layout;
    if (layouts.length === 0 || layouts.every(l => l === 'none')) layout = 'none';
    else if (layouts.every(l => l === 'ok')) layout = 'ok';
    else if (layouts.includes('mismatch')) layout = 'mismatch';
    else layout = 'partial';

    return {
        results,
        summary: {
            layout, detected, assigned, hinted: results.filter(r => r.figure_hint).length,
            ...(truncated ? { truncated: true } : {})
        }
    };
}

module.exports = {
    matchOcrFigures, mentionsFigure,
    FIGURE_TOKEN, ASSIGNABLE_LABELS, NUMBER_LINE_BACK, NUMBER_LINE_RE
};
