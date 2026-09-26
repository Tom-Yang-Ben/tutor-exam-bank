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
//   3. 題目的起點＝題幹起點往前 80 字內最近的「題號行」（「12.」「## 1 ．」「( )3、」這種行首）；沒有題號行就是題幹起點。
//      題目的範圍＝［這一題的起點, 下一題的起點）。附圖常在題號與題幹之間、題幹旁邊或題幹之後，都在這個範圍裡。
//
// ── 配圖（配不準的寧可不配）──
//   一張圖（標籤 image／chart；印章 seal 不是附圖）屬於「起點在它之前、最後一個」定位到的題，而且要同時滿足：
//     ① 與那一題的起點在同一頁（跨頁的題、下一頁頁首的圖不配）；
//     ② 那一題與下一個定位到的題之間沒有定位不到的題（不然說不準是誰的）；
//     ③ 圖框合法；
//     ④ 那一題的範圍內只有這一張（兩張以上不猜哪一張，也不把兩張框在一起——中間可能夾著題目文字）；
//     ⑤ 圖在題幹之後、這一題沒提到圖、下一題卻提到圖（「如圖」「如右圖」…）→ 多半是下一題的圖，不配。
//   第一題起點之前的圖（校徽、卷首的圖）不屬於任何題，不配也不提示。
//   配到的題寫 figure_page（整份 PDF 的絕對頁碼，OCR 回的就是）與 figure_box（[ymin,xmin,ymax,xmax]，0–1000），
//   裁圖照舊由 workers/jobRunner.js 的 attachFigureImages（services/figureService）在 PDF 刪檔前做。
//
// ── 提示（figure_hint，給複核頁：「疑似有圖未配到，可用 figures:backfill 補」）──
//   { reason:'multiple', count }  範圍內有 count 張圖（④）
//   { reason:'nearby', count }    範圍附近有 count 張圖但配不準（①②③）
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
/** 題號行：行首的「12.」「12、」「## 1 ．」「( )3.」（markdown 標題記號、題前的作答括號都容許；1.5 這種小數不算） */
const NUMBER_LINE_RE = /^[ \t]*#{0,6}[ \t]*(?:[(（][ \t]*[)）][ \t]*)?[(（]?[ \t]*\d{1,2}[ \t]*[.、．](?!\d)/;
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
 * 依序定位每一題：{ from（題幹起點）, end（題幹最後一個中文字之後）, anchor（題目起點）}；定位不到回 null。
 * @param {Array<{question_text?:string}>} elements
 * @param {string} raw
 */
function locateAll(elements, raw) {
    const o = { ...DEFAULTS };
    const index = cjkIndex(raw);
    let cursor = 0;
    let lower = 0;
    return elements.map((el) => {
        const text = el && typeof el.question_text === 'string' ? el.question_text : '';
        const r = locateOne(text, raw, index, cursor, o);
        if (!r || r.status !== 'located') return null;
        cursor = r.cjkStart + 1;
        const q = (text.match(CJK_ALL) || []).length;
        const lastCjk = Math.min(index.seq.length - 1, r.cjkStart + q - 1);
        const end = index.pos[lastCjk] + 1;
        const anchor = numberLineBefore(raw, r.from, lower);
        lower = Math.max(lower, end);
        return { from: r.from, end, anchor };
    });
}

/**
 * 依 OCR 版面把附圖配到題目。
 *
 * @param {Array<{question_text?:string}>} elements 模型拆出來的題（**全部**，含 schema 不合格的——
 *        它們在卷面上也佔一個位置，拿來切範圍；結果照位置一一對應，呼叫端只用合格的那幾題）
 * @param {Array<{page:number, markdown:string, figures?:Array}>} pages 這一塊的 OCR 頁（services/ocr 的 pages）
 * @returns {{results:Array<{figure_page?:number, figure_box?:number[], figure_hint?:{reason:string, count?:number}}>,
 *            summary:{layout:'ok'|'none'|'mismatch'|'partial', detected:number, assigned:number, hinted:number}}}
 */
function matchOcrFigures(elements, pages) {
    const els = Array.isArray(elements) ? elements : [];
    const pgs = (Array.isArray(pages) ? pages : []).filter(p => p && Number.isInteger(p.page));
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
        if (owner < 0) continue;                         // 第一題之前：卷首、校徽
        const next = nextLocated(owner);
        if (next > owner + 1) {                          // ② 中間有定位不到的題
            for (let k = owner; k < next; k++) nearby[k] += 1;
            continue;
        }
        if (pageOf(loc[owner].anchor) !== fig.page || !fig.box) {   // ① 跨頁、③ 框壞掉
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
            const ambiguous = f.pos > loc[i].end && !mentions[i] && next < n && mentions[next];   // ⑤
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
        summary: { layout, detected, assigned, hinted: results.filter(r => r.figure_hint).length }
    };
}

module.exports = {
    matchOcrFigures, mentionsFigure,
    FIGURE_TOKEN, ASSIGNABLE_LABELS, NUMBER_LINE_BACK, NUMBER_LINE_RE
};
