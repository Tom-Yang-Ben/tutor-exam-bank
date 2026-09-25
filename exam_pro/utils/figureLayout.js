// ─────────────────────────────────────────────────────────────
// utils/figureLayout.js — 舊題補附圖：原卷版面分析與比對（純函式）
//
// 〔Owner 決策單 2026-09-25 B20〕roadmap 待決策第 19 項選「做舊題補附圖」：2026-08-27 前入庫的題沒有附圖，
// 用原卷 PDF 重跑裁圖並比對題目，寫入正式庫前每題都要老師確認（scripts/backfill_figures.js、
// docs/figures.md「舊題補附圖」）。本檔是其中「哪張圖屬於哪一題」的判斷，**不讀檔、不碰 DB、不呼叫 LLM**。
//
// 為什麼不照新管線的做法：新管線的題圖對應靠 extract 模型在拆題時順便回框（docs/figures.md 第 2 環節），
// 舊題沒有那一次呼叫可以搭。這裡預設改用確定性的版面規則（要用模型框圖得明確加 --use-llm，見腳本）：
//
//   1. 找圖（detectFigures）：PDF 內容流裡的向量線條與點陣圖，相距 mergeGap 內併成一張。下列不算圖：
//      太小（寬或高 < minFigure：底線、分隔線、單一符號）、太大（蓋住 maxPageAreaRatio 以上的頁面：底圖、外框、
//      掃描頁）、白色填色（遮罩、底色）、表格（只有水平／垂直線、橫豎各有兩條以上貫穿全寬／全高、框內有兩行以上的字——
//      表格依 docs/figures.md 是題目文字，不是附圖）、行內算式（圖框被一般文字行蓋住 inlineTextRatio 以上）。
//      圖旁 labelGap 內的標註併進裁切範圍——幾何圖的頂點標註、座標軸刻度常在線條外面：短字（A、B、O、x、y、(A)）
//      與刻度列（沒有中文字、落在圖的寬度內的一行）；題號行不併。
//   2. 定位題目（locateInDoc）：與原卷比對（utils/sourceCheck.js）同一套中文字 5-gram，題幹的 gram 在原卷
//      文字層的覆蓋率 ≥ minCoverage（0.8，同一個校準門檻）才算找到。題幹末尾的「[附圖描述：…]」先去掉。
//   3. 分題（buildBoundaries → assignFigure）：題號行（「12.」「12、」「( )12.」）、大題標題（「二、」）、
//      題組說明與定位到的題目起點把卷面切成一段一段；圖屬於「垂直方向重疊最多」的那一段（雙欄卷分左右欄）；
//      頁首（該欄第一個分段之前）的圖接續上一欄／上一頁最後一段。段落的主人是定位在那裡的候選題；
//      沒有主人的段落（題庫裡沒有、已經有附圖、或定位不到的題）上的圖不提議。
//
// 座標一律是 PDF 點（1/72 吋），頁面左上角為原點，矩形 [x0, y0, x1, y1]。
// ─────────────────────────────────────────────────────────────

const {
    DEFAULTS: SOURCE_DEFAULTS, normalizeSourceText, latexToComparable, stripNumbering, tally
} = require('./sourceCheck');

const LAYOUT_DEFAULTS = Object.freeze({
    mergeGap: 6,              // pt：圖形元素相距在此以內併成同一張圖
    minFigure: 24,            // pt：圖的寬與高都至少這麼大
    maxPageAreaRatio: 0.6,    // 單一元素蓋住頁面這個比例以上 → 底圖／外框／掃描頁，不算圖
    labelGap: 10,             // pt：圖旁這個距離內的短字併進裁切範圍
    labelMaxChars: 6,         // 「短字」：去空白後不超過這個字數
    labelMaxWidth: 60,        // pt：「短字」行的寬度上限
    tableSpanRatio: 0.8,      // 表格：貫穿（合計長度 ≥ 此比例的圖框寬／高）的橫線、豎線各至少兩條
    tableMinLines: 2,         // 表格：框內至少這麼多行字
    inlineTextRatio: 0.3,     // 圖框被一般文字行蓋住這個比例以上 → 行內算式，不算圖
    claimMaxGap: 40,          // pt：定位到的題目起點在題號行下方這個距離內 → 屬於那個題號
    ambiguousOverlap: 0.6,    // 圖與所屬段落的垂直重疊比例低於此數 → 圖跨兩題，分數打折
    carryFactor: 0.9,         // 頁首的圖接續上一頁最後一題：分數打的折扣
    flatAspect: 5,            // 寬高比超過此數且高 < flatMaxHeight → 提醒「可能是算式圖片」
    flatMaxHeight: 40,
    k: SOURCE_DEFAULTS.k,                     // 與原卷比對相同：中文字 5-gram
    minCjk: SOURCE_DEFAULTS.minCjk,           // 題幹中文字少於此數不比（定位不可靠）
    minCoverage: SOURCE_DEFAULTS.minCoverage  // 定位覆蓋率門檻（0.8）
});

function opt(options) {
    return { ...LAYOUT_DEFAULTS, ...(options || {}) };
}

// ───────────────────────── 矩形 ─────────────────────────

const rw = (r) => r[2] - r[0];
const rh = (r) => r[3] - r[1];

function isRect(r) {
    return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] >= r[0] && r[3] >= r[1];
}
function area(r) {
    return Math.max(0, rw(r)) * Math.max(0, rh(r));
}
function union(a, b) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function expand(r, d) {
    return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}
function intersects(a, b) {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
function intersection(a, b) {
    const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return r[2] > r[0] && r[3] > r[1] ? r : null;
}
function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
/** 夾進頁面；整個在頁面外回 null（零寬／零高的線段照留，它會與旁邊的元素相連） */
function clampToPage(r, width, height) {
    const c = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(width, r[2]), Math.min(height, r[3])];
    return c[2] >= c[0] && c[3] >= c[1] ? c : null;
}

/** 去空白後的字數 */
function compactLen(text) {
    return String(text ?? '').replace(/\s/g, '').length;
}

// ───────────────────────── 題號與標題 ─────────────────────────

// 題號行：「12.」「12、」「12．」「(12.」「( )12.」「（　）12.」；後面不能緊接數字（1.5 不是題號）。
// 與 utils/sourceCheck.js 截段落用的題號規則同一型，只多認選擇題作答括號在前的寫法。
const QUESTION_NO_LINE = /^\s*(?:[(（]\s*[)）]\s*)?[(（]?\s*\d{1,2}\s*[.、．](?!\d)/;
// 大題標題：「一、」「二、選擇題」「參、」；題組說明：「第 21-23 題為題組」「題組：」
const SECTION_LINE = /^\s*(?:[一二三四五六七八九十]{1,3}|[壹貳參肆伍陸柒捌玖拾]{1,3})\s*[、.．]/;
const GROUP_LINE = /題組/;
// 題幹提到圖的字樣（只拿來寫依據與統計，不影響是否提議）
const FIGURE_HINT = /如圖|附圖|下圖|上圖|右圖|左圖|圖中|圖示|圖所示|\[附圖描述/;

/**
 * 一行字是不是分段的起點。
 * @param {string} text 已正規化的行
 * @returns {'number'|'section'|null}
 */
function lineBoundaryKind(text) {
    const t = normalizeSourceText(text);
    if (QUESTION_NO_LINE.test(t)) return 'number';
    if (SECTION_LINE.test(t)) return 'section';
    if (GROUP_LINE.test(t) && compactLen(t) <= 30) return 'section';
    return null;
}

/** 題幹是否提到圖 */
function hasFigureHint(questionText) {
    return FIGURE_HINT.test(String(questionText ?? ''));
}

// ───────────────────────── 1. 找圖 ─────────────────────────

/**
 * 一組元素依「外擴 gap 後相交」分群（連通分量）。
 * @param {Array<{bbox:number[]}>} items
 * @param {number} gap
 * @returns {number[][]} 每群的元素索引
 */
function clusterRects(items, gap) {
    const n = items.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    const order = items.map((it, i) => i).sort((a, b) => items[a].bbox[0] - items[b].bbox[0]);
    for (let a = 0; a < order.length; a++) {
        const i = order[a];
        const ri = expand(items[i].bbox, gap);
        for (let b = a + 1; b < order.length; b++) {
            const j = order[b];
            if (items[j].bbox[0] > ri[2]) break;          // 依 x0 排序：之後的都在右邊更遠處
            if (intersects(ri, items[j].bbox)) {
                const pi = find(i);
                const pj = find(j);
                if (pi !== pj) parent[pi] = pj;
            }
        }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(i);
    }
    return [...groups.values()];
}

/**
 * 一群元素是不是表格：全部是水平／垂直線段（沒有點陣圖、沒有斜線或曲線），
 * 貫穿全寬的橫線與貫穿全高的豎線各至少兩條（同一個 y／x 上的短線段合計），框內有字。
 * @param {Array<object>} parts  graphics 元素（axis、hLines、vLines）
 * @param {number[]} bbox
 * @param {Array<{bbox:number[], text:string}>} lines
 * @param {object} o
 */
function isTable(parts, bbox, lines, o) {
    if (!parts.every(p => p.kind !== 'image' && p.axis)) return false;
    const sumBy = (segs, key) => {
        const buckets = new Map();
        for (const s of segs) {
            const k = Math.round(s[key] / 1.5);
            buckets.set(k, (buckets.get(k) || 0) + s.len);
        }
        return [...buckets.values()];
    };
    const h = sumBy(parts.flatMap(p => p.hLines || []), 'y');
    const v = sumBy(parts.flatMap(p => p.vLines || []), 'x');
    const hFull = h.filter(len => len >= o.tableSpanRatio * rw(bbox)).length;
    const vFull = v.filter(len => len >= o.tableSpanRatio * rh(bbox)).length;
    if (hFull < 2 || vFull < 2) return false;
    const inside = lines.filter(l => contains(expand(bbox, 1), l.bbox) && compactLen(l.text) > 0).length;
    return inside >= o.tableMinLines;
}

/** 圖框被「一般文字行」（不是短標註）蓋住的比例 */
function textCoverRatio(bbox, lines, o) {
    const a = area(bbox);
    if (a <= 0) return 0;
    let covered = 0;
    for (const l of lines) {
        if (compactLen(l.text) <= o.labelMaxChars) continue;
        const x = intersection(bbox, l.bbox);
        if (x) covered += area(x);
    }
    return covered / a;
}

/**
 * 把圖旁的標註併進圖框，做兩輪（標註旁的標註）。算標註的有兩種：
 *   短字：去空白後不超過 labelMaxChars、寬不超過 labelMaxWidth（頂點 A、B，座標軸 x、y，選項代號 (A)）；
 *   刻度列：沒有中文字、左右都落在圖的寬度內（± labelGap）的一行（座標軸下方的「0 1 2 3 4 t(s)」）。
 * 題號行、大題標題不併。
 * @param {number[]} bbox
 * @param {Array<{bbox:number[], text:string}>} lines
 * @param {object} [options]
 * @returns {number[]}
 */
function absorbLabels(bbox, lines, options) {
    const o = opt(options);
    let r = bbox.slice();
    for (let pass = 0; pass < 2; pass++) {
        const zone = expand(r, o.labelGap);
        for (const l of lines) {
            if (contains(r, l.bbox) || !intersects(zone, l.bbox)) continue;
            const n = compactLen(l.text);
            if (n === 0 || lineBoundaryKind(l.text)) continue;
            const shortLabel = n <= o.labelMaxChars && rw(l.bbox) <= o.labelMaxWidth;
            const tickRow = !CJK_ONE.test(l.text) && l.bbox[0] >= r[0] - o.labelGap && l.bbox[2] <= r[2] + o.labelGap;
            if (!shortLabel && !tickRow) continue;
            r = union(r, l.bbox);
        }
    }
    return r;
}

/**
 * 一頁上的附圖。
 *
 * @param {{width:number, height:number, lines:Array<{bbox:number[], text:string}>,
 *          graphics:Array<{bbox:number[], kind:'image'|'stroke'|'fill', axis?:boolean, white?:boolean,
 *                          hLines?:Array<{y:number,len:number}>, vLines?:Array<{x:number,len:number}>}>}} page
 * @param {object} [options] 覆寫 LAYOUT_DEFAULTS
 * @returns {{figures:Array<{bbox:number[], kind:'image'|'vector'|'mixed', parts:number, flat:boolean}>,
 *            dropped:{large:number, white:number, small:number, table:number, inline:number}}}
 */
function detectFigures(page, options) {
    const o = opt(options);
    const width = Number(page?.width) || 0;
    const height = Number(page?.height) || 0;
    const lines = (page?.lines || []).filter(l => isRect(l.bbox));
    const dropped = { large: 0, white: 0, small: 0, table: 0, inline: 0 };
    const pageArea = width * height;

    const items = [];
    for (const g of page?.graphics || []) {
        if (!isRect(g.bbox)) continue;
        const b = clampToPage(g.bbox, width, height);
        if (!b) continue;                                                          // 整個在頁面外
        if (g.white) { dropped.white += 1; continue; }
        if (area(b) > o.maxPageAreaRatio * pageArea || (rw(b) >= 0.9 * width && rh(b) >= 0.9 * height)) {
            dropped.large += 1;
            continue;
        }
        items.push({ ...g, bbox: b });
    }

    let figures = [];
    for (const idxs of clusterRects(items, o.mergeGap)) {
        const parts = idxs.map(i => items[i]);
        const bbox = parts.map(p => p.bbox).reduce(union);
        if (rw(bbox) < o.minFigure || rh(bbox) < o.minFigure) { dropped.small += 1; continue; }
        if (isTable(parts, bbox, lines, o)) { dropped.table += 1; continue; }
        if (textCoverRatio(bbox, lines, o) > o.inlineTextRatio) { dropped.inline += 1; continue; }
        const images = parts.filter(p => p.kind === 'image').length;
        const kind = images === parts.length ? 'image' : images === 0 ? 'vector' : 'mixed';
        figures.push({ bbox: absorbLabels(bbox, lines, o), kind, parts: parts.length });
    }

    // 併標註之後可能與旁邊的圖重疊（例：四個選項圖各自併進 (A)(B)…）：重疊的再併成一張
    const merged = clusterRects(figures, 0).map(idxs => {
        const group = idxs.map(i => figures[i]);
        const bbox = group.map(f => f.bbox).reduce(union);
        const kinds = new Set(group.map(f => f.kind));
        return {
            bbox,
            kind: kinds.size === 1 ? group[0].kind : 'mixed',
            parts: group.reduce((s, f) => s + f.parts, 0)
        };
    });
    figures = merged
        .map(f => ({ ...f, flat: rw(f.bbox) / Math.max(1, rh(f.bbox)) > o.flatAspect && rh(f.bbox) < o.flatMaxHeight }))
        .sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
    return { figures, dropped };
}

// ───────────────────────── 欄位 ─────────────────────────

/**
 * 一頁是單欄還是雙欄。夠長的字行（≥ 6 字）裡，完全在左半、完全在右半的各至少 3 行，
 * 橫跨中線的不超過 15% → 雙欄。
 * @returns {1|2}
 */
function pageColumns(page) {
    const width = Number(page?.width) || 0;
    const mid = width / 2;
    const body = (page?.lines || []).filter(l => isRect(l.bbox) && compactLen(l.text) >= 6);
    if (body.length < 6) return 1;
    let left = 0;
    let right = 0;
    let span = 0;
    for (const l of body) {
        if (l.bbox[2] <= mid + 4) left += 1;
        else if (l.bbox[0] >= mid - 4) right += 1;
        else span += 1;
    }
    return left >= 3 && right >= 3 && span <= 0.15 * body.length ? 2 : 1;
}

/** 矩形在第幾欄（0 或 1；單欄一律 0） */
function columnOf(bbox, columns, width) {
    return columns === 2 && (bbox[0] + bbox[2]) / 2 >= width / 2 ? 1 : 0;
}

// ───────────────────────── 2. 文字層與定位 ─────────────────────────

const CJK_ONE = /[一-鿿]/;
const CJK_ALL = /[一-鿿]/g;
const FIGURE_NOTE = /\[附圖描述[：:][\s\S]*?\]/g;

function cjkOf(text) {
    return (String(text ?? '').match(CJK_ALL) || []).join('');
}
function grams(s, k) {
    const g = [];
    for (let i = 0; i + k <= s.length; i++) g.push(s.slice(i, i + k));
    return g;
}

/** 題幹 → 拿來定位的中文字序列（去掉「[附圖描述：…]」與 LaTeX 指令名） */
function questionCjk(questionText) {
    return cjkOf(latexToComparable(String(questionText ?? '').replace(FIGURE_NOTE, ' ')));
}

/**
 * 整份 PDF 的文字層索引（每行正規化後以換行串接；頁與頁之間也是換行）。
 * @param {Array<{page:number, width:number, height:number, lines:Array<{bbox:number[], text:string}>}>} pages
 * @returns {{text:string, lines:Array<{page:number, col:number, bbox:number[], text:string, start:number, end:number, lineNo:number}>,
 *            seq:string, pos:number[], columnsByPage:Map<number,number>, gramSet:Set<string>}}
 */
function buildDocIndex(pages, options) {
    const o = opt(options);
    const lines = [];
    const columnsByPage = new Map();
    let text = '';
    for (const p of pages || []) {
        const columns = pageColumns(p);
        columnsByPage.set(p.page, columns);
        for (const l of p.lines || []) {
            if (!isRect(l.bbox)) continue;
            const t = normalizeSourceText(l.text).replace(/\n/g, ' ');
            lines.push({
                page: p.page, col: columnOf(l.bbox, columns, p.width), bbox: l.bbox, text: t,
                start: text.length, end: text.length + t.length, lineNo: lines.length
            });
            text += t + '\n';
        }
    }
    const pos = [];
    let seq = '';
    for (let i = 0; i < text.length; i++) {
        if (CJK_ONE.test(text[i])) { pos.push(i); seq += text[i]; }
    }
    return { text, lines, seq, pos, columnsByPage, gramSet: new Set(grams(seq, o.k)) };
}

/** 文字層位移 → 所在行（二分搜尋） */
function lineAtOffset(doc, offset) {
    let lo = 0;
    let hi = doc.lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (doc.lines[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return doc.lines[lo] || null;
}

/**
 * 在整份 PDF 的文字層定位一題（與 utils/sourceCheck.js 的 locateOne 同一套：開頭 12 個 gram 找起點、
 * 覆蓋率最高者勝、同分取開頭對齊較多者）。
 *
 * @param {string} questionText
 * @param {object} doc buildDocIndex 的輸出
 * @param {object} [options]
 * @returns {{status:'located', coverage:number, from:number, to:number, startLine:object, endLine:object}
 *          |{status:'low_anchor'|'not_found', coverage:number|null}}
 */
function locateInDoc(questionText, doc, options) {
    const o = opt(options);
    const q = questionCjk(questionText);
    if (q.length < o.minCjk) return { status: 'low_anchor', coverage: null };
    const qg = grams(q, o.k);
    // 快篩：題幹的 gram 有幾成出現在這份卷裡（整份卷的 gram 集合），不到門檻就不用逐一找起點
    const present = qg.filter(g => doc.gramSet.has(g)).length / qg.length;
    if (present < o.minCoverage) return { status: 'not_found', coverage: Number(present.toFixed(2)) };

    const starts = new Set();
    qg.slice(0, 12).forEach((g, i) => {
        let s = doc.seq.indexOf(g);
        while (s >= 0) { starts.add(Math.max(0, s - i)); s = doc.seq.indexOf(g, s + 1); }
    });
    let best = null;
    for (const start of [...starts].sort((a, b) => a - b)) {
        const spanGrams = new Set(grams(doc.seq.slice(start, start + q.length + 10), o.k));
        const coverage = qg.filter(g => spanGrams.has(g)).length / qg.length;
        const aligned = qg.slice(0, 12).filter((g, i) => doc.seq.startsWith(g, start + i)).length;
        const tie = best && Math.abs(coverage - best.coverage) <= 1e-9;
        if (!best || coverage > best.coverage + 1e-9 || (tie && aligned > best.aligned)) best = { start, coverage, aligned };
    }
    if (!best) return { status: 'not_found', coverage: 0 };
    const coverage = Number(best.coverage.toFixed(2));
    if (best.coverage < o.minCoverage) return { status: 'not_found', coverage };

    const startRaw = doc.pos[best.start];
    const lastCjk = Math.min(doc.seq.length - 1, best.start + q.length - 1);
    const endRaw = doc.pos[lastCjk] + 1;
    const startLine = lineAtOffset(doc, startRaw);
    const endLine = lineAtOffset(doc, Math.max(startRaw, endRaw - 1));
    return { status: 'located', coverage, from: startRaw, to: endRaw, startLine, endLine };
}

/**
 * 題幹與原卷段落的數字、小寫字母相似度（Jaccard，0–1）。只在「兩題中文字一樣、只差數字」時拿來決勝。
 * @param {string} questionText
 * @param {string} segment 原卷段落（已正規化）
 */
function detailSimilarity(questionText, segment) {
    const a = tally(stripNumbering(latexToComparable(questionText)));
    const b = tally(stripNumbering(segment));
    let inter = 0;
    let uni = 0;
    for (const key of ['digits', 'lower']) {
        const keys = new Set([...Object.keys(a[key]), ...Object.keys(b[key])]);
        for (const c of keys) {
            const x = a[key][c] || 0;
            const y = b[key][c] || 0;
            inter += Math.min(x, y);
            uni += Math.max(x, y);
        }
    }
    return uni === 0 ? 1 : Number((inter / uni).toFixed(2));
}

/**
 * 兩段題幹的相似度：a 的中文字 5-gram 有幾成出現在 b（0–1）。--use-llm 時拿模型抄的題幹對題庫的題。
 * a 的中文字不足 minCjk 時回 null（無法可靠比對）。
 */
function textSimilarity(a, b, options) {
    const o = opt(options);
    const qa = questionCjk(a);
    if (qa.length < o.minCjk) return null;
    const gb = new Set(grams(questionCjk(b), o.k));
    const ga = grams(qa, o.k);
    return Number((ga.filter(g => gb.has(g)).length / ga.length).toFixed(2));
}

// ───────────────────────── 3. 分段與分題 ─────────────────────────

/** 閱讀順序的比較鍵：頁 → 欄 → y → x */
function readingKey(page, col, bbox) {
    return [page, col, bbox[1], bbox[0]];
}
function compareKey(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

/**
 * 分段起點：題號行、大題標題／題組說明（沒有主人），加上定位到的候選題（主人）。
 *
 * 候選題認領題號：題目起點所在的行若在某個題號行下方 claimMaxGap 內（同頁同欄、中間沒有別的分段起點），
 * 就屬於那個題號（題號與題幹常分兩行，例：「3.（單選）」下一行才是題幹）；否則題目起點自成一段。
 * 題號已經被「起點在別行」的題認領時不再共用（自成一段）；起點在同一行的（題庫裡兩題題幹相同）
 * 都算主人，由呼叫端決定。
 *
 * @param {object} doc buildDocIndex 的輸出
 * @param {Array<{key:any, startLine:object}>} located 定位到的候選題
 * @param {Map<number, Array<{bbox:number[]}>>} [figuresByPage] 圖框內的字（座標刻度等）不當題號
 * @param {object} [options]
 * @returns {Array<{page:number, col:number, y:number, x:number, kind:'number'|'section'|'question', owners:any[], lineNo:number}>}
 */
function buildBoundaries(doc, located, figuresByPage = new Map(), options) {
    const o = opt(options);
    const byLine = new Map();
    const keyOf = (b) => [b.page, b.col, b.y, b.x];
    for (const l of doc.lines) {
        const kind = lineBoundaryKind(l.text);
        if (!kind) continue;
        const figs = figuresByPage.get(l.page) || [];
        if (figs.some(f => contains(expand(f.bbox, 1), l.bbox))) continue;
        byLine.set(l.lineNo, { page: l.page, col: l.col, y: l.bbox[1], x: l.bbox[0], kind, owners: [], ownerLines: new Set(), lineNo: l.lineNo });
    }
    const sorted = () => [...byLine.values()].sort((a, b) => compareKey(keyOf(a), keyOf(b)));

    const items = (located || []).filter(it => it && it.startLine)
        .slice().sort((a, b) => compareKey(
            [a.startLine.page, a.startLine.col, a.startLine.bbox[1], a.startLine.bbox[0]],
            [b.startLine.page, b.startLine.col, b.startLine.bbox[1], b.startLine.bbox[0]]));
    for (const item of items) {
        const s = item.startLine;
        const own = byLine.get(s.lineNo);
        if (own) {
            if (own.kind === 'section') own.kind = 'question';
            own.owners.push(item.key);
            own.ownerLines.add(s.lineNo);
            continue;
        }
        const sKey = [s.page, s.col, s.bbox[1], s.bbox[0]];
        const before = sorted().filter(b => compareKey(keyOf(b), sKey) < 0);
        const prev = before[before.length - 1];
        const claimable = prev && prev.kind === 'number' && prev.page === s.page && prev.col === s.col
            && s.bbox[1] - prev.y <= o.claimMaxGap
            && (prev.ownerLines.size === 0 || prev.ownerLines.has(s.lineNo));
        if (claimable) {
            prev.owners.push(item.key);
            prev.ownerLines.add(s.lineNo);
        } else {
            byLine.set(s.lineNo, {
                page: s.page, col: s.col, y: s.bbox[1], x: s.bbox[0], kind: 'question',
                owners: [item.key], ownerLines: new Set([s.lineNo]), lineNo: s.lineNo
            });
        }
    }
    return sorted().map(({ ownerLines, ...b }) => b);
}

/**
 * 一張圖屬於哪一段。
 *
 * @param {{bbox:number[]}} figure
 * @param {{page:number, width:number}} page
 * @param {number} columns 該頁欄數
 * @param {Array<object>} boundaries buildBoundaries 的輸出（已依閱讀順序排好）
 * @param {object} [options]
 * @returns {{boundary:object|null, ratio:number, layout:'inside'|'mostly'|'ambiguous'|'carry'|'header'}}
 *   header：該欄第一個分段之前、而且前面沒有任何分段（卷首的校徽、標題裝飾）
 */
function assignFigure(figure, page, columns, boundaries, options) {
    const o = opt(options);
    const col = columnOf(figure.bbox, columns, page.width);
    const same = boundaries.filter(b => b.page === page.page && b.col === col);
    const [y0, y1] = [figure.bbox[1], figure.bbox[3]];
    const h = Math.max(1e-6, y1 - y0);
    const overlap = (a, b) => Math.max(0, Math.min(y1, b) - Math.max(y0, a));

    const firstY = same.length ? same[0].y : Infinity;
    const carryOverlap = overlap(-Infinity, firstY);
    let best = { boundary: null, overlap: carryOverlap, carry: true };
    same.forEach((b, i) => {
        const end = i + 1 < same.length ? same[i + 1].y : Infinity;
        const ov = overlap(b.y, end);
        if (ov > best.overlap + 1e-9) best = { boundary: b, overlap: ov, carry: false };
    });

    if (best.carry) {
        const key = [page.page, col, -Infinity, -Infinity];
        const prev = boundaries.filter(b => compareKey([b.page, b.col, b.y, b.x], key) < 0);
        const boundary = prev[prev.length - 1] || null;
        return { boundary, ratio: Number((carryOverlap / h).toFixed(2)), layout: boundary ? 'carry' : 'header' };
    }
    const ratio = Number((best.overlap / h).toFixed(2));
    const layout = ratio >= 0.999 ? 'inside' : ratio >= o.ambiguousOverlap ? 'mostly' : 'ambiguous';
    return { boundary: best.boundary, ratio, layout };
}

/**
 * 比對分數（0–1）＝ 題幹在原卷的覆蓋率 × 版面係數。版面係數：圖整張或大半（≥ ambiguousOverlap）在該題範圍內 1；
 * 跨兩題時＝重疊比例 ÷ ambiguousOverlap；頁首接續上一頁的圖 carryFactor（0.9）。
 * @param {{coverage:number, layout:string, ratio:number}} m
 */
function proposalScore({ coverage, layout, ratio }, options) {
    const o = opt(options);
    let factor = 1;
    if (layout === 'carry') factor = o.carryFactor;
    else if (layout === 'ambiguous') factor = Math.min(1, ratio / o.ambiguousOverlap);
    return Number((Number(coverage) * factor).toFixed(2));
}

module.exports = {
    LAYOUT_DEFAULTS, QUESTION_NO_LINE, FIGURE_HINT,
    // 矩形
    isRect, area, union, expand, intersects, intersection, contains,
    // 找圖
    clusterRects, detectFigures, absorbLabels, lineBoundaryKind, hasFigureHint,
    // 欄位與文字層
    pageColumns, columnOf, buildDocIndex, lineAtOffset, questionCjk, locateInDoc, detailSimilarity, textSimilarity,
    // 分段與分題
    buildBoundaries, assignFigure, proposalScore, compareKey
};
