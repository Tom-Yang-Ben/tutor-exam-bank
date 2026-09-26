// services/pdfLayout.js — 原卷 PDF 的版面（字行位置＋圖形元素）與依框裁圖（舊題補附圖，docs/figures.md「舊題補附圖」）
//
// 〔Owner 決策單 2026-09-25 B20〕scripts/backfill_figures.js 用：
//   readPdfLayout：每頁的字行（文字層，含位置）與圖形元素（向量線條／填色、點陣圖）的外框，交給
//                  utils/figureLayout.js 判斷哪裡有圖、圖屬於哪一題。
//   cropToFiles：  依框把圖裁成 PNG。渲染倍率與新管線相同（services/figureService.js 的 RENDER_SCALE＝2，≈144 DPI），
//                  Word 匯出的尺寸換算因此一致。
// **純程式步驟，不呼叫任何模型**。與新管線共用 services/mupdf.js 的 WASM 載入器。
//
// 中文路徑：mupdf 一律吃記憶體裡的位元組（呼叫端 fs.readFileSync 讀檔），裁好的 PNG 由 sharp 輸出成 Buffer、
// 再由 fs.writeFileSync 寫檔——路徑只經過 Node 的 fs，「各校考卷」這類中文資料夾在 Windows 上也讀寫得到。

const fs = require('fs');
const path = require('path');

const { loadMupdf } = require('./mupdf');
const { boxToPixels, RENDER_SCALE } = require('./figureService');

/** 線段在這個誤差內算水平／垂直（pt） */
const AXIS_EPS = 0.5;
/** 一個路徑最多記幾段水平／垂直線（表格判斷用；超過就不記，只影響「像不像表格」） */
const MAX_AXIS_SEGMENTS = 256;

function transformPoint(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** ctm 的長度縮放倍率（線寬換算成頁面座標用） */
function ctmScale(m) {
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** 顏色是不是白色（灰階、RGB、CMYK 都認）；拿不到就當不是白色 */
function isWhite(color) {
    if (!Array.isArray(color) && !(color && typeof color.length === 'number')) return false;
    const c = Array.from(color);
    if (c.length === 1 || c.length === 3) return c.every(v => v >= 0.97);
    if (c.length === 4) return c.every(v => v <= 0.03);
    return false;
}

/**
 * 走一遍路徑：頁面座標的外框、是否全部是水平／垂直線段、各段水平／垂直線。
 * @returns {{bbox:number[]|null, axis:boolean, hLines:Array<{y:number,len:number}>, vLines:Array<{x:number,len:number}>}}
 */
function walkPath(pathObj, ctm) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    let axis = true;
    const hLines = [];
    const vLines = [];
    let cur = null;
    let start = null;
    const add = ([x, y]) => {
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    };
    const segment = (a, b) => {
        const dx = Math.abs(b[0] - a[0]);
        const dy = Math.abs(b[1] - a[1]);
        if (dx < AXIS_EPS && dy < AXIS_EPS) return;
        if (dy < AXIS_EPS) { if (hLines.length < MAX_AXIS_SEGMENTS) hLines.push({ y: (a[1] + b[1]) / 2, len: dx }); }
        else if (dx < AXIS_EPS) { if (vLines.length < MAX_AXIS_SEGMENTS) vLines.push({ x: (a[0] + b[0]) / 2, len: dy }); }
        else axis = false;
    };
    pathObj.walk({
        moveTo(x, y) { cur = transformPoint(ctm, x, y); start = cur; add(cur); },
        lineTo(x, y) {
            const p = transformPoint(ctm, x, y);
            if (cur) segment(cur, p);
            cur = p; add(p);
        },
        curveTo(ax, ay, bx, by, cx, cy) {
            axis = false;
            add(transformPoint(ctm, ax, ay));
            add(transformPoint(ctm, bx, by));
            cur = transformPoint(ctm, cx, cy);
            add(cur);
        },
        closePath() { if (cur && start) segment(cur, start); cur = start; }
    });
    const bbox = Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
    return { bbox, axis, hLines, vLines };
}

/** 細長的填色矩形（Word 轉 PDF 的表格框線常是這種）當成一條線 */
function thinFillAsLine(bbox) {
    const w = bbox[2] - bbox[0];
    const h = bbox[3] - bbox[1];
    if (h <= 2.5 && w > h) return { hLines: [{ y: (bbox[1] + bbox[3]) / 2, len: w }], vLines: [] };
    if (w <= 2.5 && h > w) return { hLines: [], vLines: [{ x: (bbox[0] + bbox[2]) / 2, len: h }] };
    return null;
}

function intersectRect(a, b) {
    if (!b) return a;
    const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return r[2] >= r[0] && r[3] >= r[1] ? r : null;
}

/**
 * 一頁的圖形元素：跑一遍 mupdf 的 Device，記下每個向量路徑、點陣圖的外框（已與目前的裁切範圍取交集）。
 * 遮罩（soft mask）與拼貼圖樣（tiling pattern）內的內容不算；文字交給 structured text。
 */
function collectGraphics(mupdf, page, origin) {
    const graphics = [];
    const clips = [];            // 目前的裁切外框堆疊（null＝不限）
    let maskDepth = 0;
    let tileDepth = 0;
    const clip = () => (clips.length ? clips[clips.length - 1] : null);
    const shift = (r) => [r[0] - origin[0], r[1] - origin[1], r[2] - origin[0], r[3] - origin[1]];
    const pushClip = (r) => clips.push(r === undefined ? clip() : (r ? intersectRect(r, clip()) || [0, 0, 0, 0] : clip()));
    const record = (bbox, extra) => {
        if (maskDepth > 0 || tileDepth > 0 || !bbox) return;
        const visible = intersectRect(bbox, clip());
        if (!visible) return;
        graphics.push({ bbox: shift(visible), ...extra });
    };
    const imageBox = (ctm) => {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transformPoint(ctm, x, y));
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };

    const device = new mupdf.Device({
        fillPath(p, evenOdd, ctm, colorspace, color, alpha) {
            if (alpha < 0.05) return;
            const w = walkPath(p, ctm);
            if (!w.bbox) return;
            const thin = w.axis ? thinFillAsLine(w.bbox) : null;
            record(w.bbox, {
                kind: 'fill', axis: w.axis, white: isWhite(color),
                hLines: thin ? thin.hLines : w.hLines, vLines: thin ? thin.vLines : w.vLines
            });
        },
        strokePath(p, stroke, ctm, colorspace, color, alpha) {
            if (alpha < 0.05) return;
            const w = walkPath(p, ctm);
            if (!w.bbox) return;
            const half = (Number(stroke?.getLineWidth?.()) || 1) * ctmScale(ctm) / 2;
            const b = [w.bbox[0] - half, w.bbox[1] - half, w.bbox[2] + half, w.bbox[3] + half];
            record(b, { kind: 'stroke', axis: w.axis, white: isWhite(color), hLines: w.hLines, vLines: w.vLines });
        },
        fillImage(image, ctm, alpha) {
            if (alpha < 0.05) return;
            record(imageBox(ctm), { kind: 'image', axis: false, white: false });
        },
        fillImageMask(image, ctm, colorspace, color, alpha) {
            if (alpha < 0.05) return;
            record(imageBox(ctm), { kind: 'image', axis: false, white: isWhite(color) });
        },
        clipPath(p, evenOdd, ctm) { pushClip(walkPath(p, ctm).bbox); },
        clipStrokePath(p, stroke, ctm) { pushClip(walkPath(p, ctm).bbox); },
        clipText() { pushClip(undefined); },
        clipStrokeText() { pushClip(undefined); },
        clipImageMask(image, ctm) { pushClip(imageBox(ctm)); },
        popClip() { clips.pop(); },
        beginMask(area) { maskDepth += 1; pushClip(area && area.length === 4 ? area : undefined); },
        endMask() { maskDepth = Math.max(0, maskDepth - 1); },
        beginTile() { tileDepth += 1; return 0; },
        endTile() { tileDepth = Math.max(0, tileDepth - 1); }
    });
    try {
        page.run(device, mupdf.Matrix.identity);
        device.close();
    } finally {
        device.destroy?.();
    }
    return graphics;
}

/** 一頁的字行（mupdf structured text 的每一行：外框＋文字） */
function collectLines(page, origin) {
    const lines = [];
    const st = page.toStructuredText('preserve-whitespace');
    try {
        st.walk({
            beginLine(bbox) {
                lines.push({ bbox: [bbox[0] - origin[0], bbox[1] - origin[1], bbox[2] - origin[0], bbox[3] - origin[1]], text: '' });
            },
            onChar(c) { if (lines.length) lines[lines.length - 1].text += c; }
        });
    } finally {
        st.destroy();
    }
    return lines.filter(l => l.text.trim() !== '');
}

/**
 * 讀整份 PDF 的版面。
 * @param {Buffer|Uint8Array} pdfBytes
 * @returns {Promise<{pageCount:number, pages:Array<{page:number, width:number, height:number,
 *            lines:Array<{bbox:number[], text:string}>, graphics:Array<object>}>}>}
 */
async function readPdfLayout(pdfBytes) {
    const mupdf = await loadMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    try {
        const pageCount = doc.countPages();
        const pages = [];
        for (let i = 0; i < pageCount; i++) {
            const page = doc.loadPage(i);
            try {
                const b = page.getBounds();
                const origin = [b[0], b[1]];
                pages.push({
                    page: i + 1,
                    width: b[2] - b[0],
                    height: b[3] - b[1],
                    lines: collectLines(page, origin),
                    graphics: collectGraphics(mupdf, page, origin)
                });
            } finally {
                page.destroy();
            }
        }
        return { pageCount, pages };
    } finally {
        doc.destroy();
    }
}

/**
 * 頁面座標（pt）的框 → 整頁點陣圖上的像素矩形（四周多留 marginPt，夾在頁面內）。
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
function rectToPixels(rect, imgWidth, imgHeight, scale = RENDER_SCALE, marginPt = 4) {
    const left = Math.max(0, Math.floor((rect[0] - marginPt) * scale));
    const top = Math.max(0, Math.floor((rect[1] - marginPt) * scale));
    const right = Math.min(imgWidth, Math.ceil((rect[2] + marginPt) * scale));
    const bottom = Math.min(imgHeight, Math.ceil((rect[3] + marginPt) * scale));
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) return null;
    return { left, top, width, height };
}

/**
 * 依框裁圖、寫成 PNG。同一頁只渲染一次。每一張各自 try/catch：裁不出來只少這一張。
 *
 * @param {{pdfBytes:Buffer, items:Array<{page:number, file:string, rect?:number[], box?:number[]}>, logger?:object}} opts
 *   rect：頁面座標（pt，左上角為原點）；box：0–1000 正規化 [ymin,xmin,ymax,xmax]（模型框，與新管線相同的換算與邊距）
 * @returns {Promise<Array<{file:string, ok:boolean, error?:string}>>}
 */
async function cropToFiles({ pdfBytes, items, logger = console }) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];
    const sharp = require('sharp');
    const mupdf = await loadMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    const cache = new Map();
    const results = [];
    try {
        for (const it of list) {
            try {
                let rendered = cache.get(it.page);
                if (!rendered) {
                    const page = doc.loadPage(it.page - 1);
                    try {
                        const pixmap = page.toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
                        const png = Buffer.from(pixmap.asPNG());
                        pixmap.destroy();
                        const meta = await sharp(png).metadata();
                        rendered = { png, width: meta.width, height: meta.height };
                        cache.set(it.page, rendered);
                    } finally {
                        page.destroy();
                    }
                }
                const px = Array.isArray(it.box)
                    ? boxToPixels(it.box, rendered.width, rendered.height)
                    : rectToPixels(it.rect, rendered.width, rendered.height);
                if (!px) throw new Error('框退化（寬或高不足 1px）');
                const out = await sharp(rendered.png).extract(px).png().toBuffer();
                fs.mkdirSync(path.dirname(it.file), { recursive: true });
                fs.writeFileSync(it.file, out);
                results.push({ file: it.file, ok: true });
            } catch (err) {
                logger.warn?.({ msg: '補附圖：裁圖失敗，該題不提議', page: it.page, file: path.basename(it.file), error: err.message });
                results.push({ file: it.file, ok: false, error: err.message });
            }
        }
    } finally {
        doc.destroy();
    }
    return results;
}

module.exports = { readPdfLayout, cropToFiles, rectToPixels, walkPath, isWhite, thinFillAsLine };
