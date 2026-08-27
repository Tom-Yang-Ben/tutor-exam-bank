// services/figureService.js — 考卷附圖裁切（docs/figures.md）
//
// extract 節點回報每題附圖的 figure_page（絕對頁碼）與 figure_box（[ymin,xmin,ymax,xmax]，
// 0–1000 正規化）；這一支在 PDF 刪檔前把圖裁成 PNG 存 data/figures/，路徑寫回題目物件的
// figure_img。**純程式步驟，不呼叫任何模型**。
//
// 兩條紀律：
//   1. 裁圖失敗只該少一張圖，不該少一道題——每一題各自 try/catch，錯誤記 log 後繼續。
//   2. 檔名 <jobId>-<idx>.png 是確定性的：崩潰後重跑同一個 chunk 會覆寫同一個檔，不會堆積。
//
// mupdf 是 ESM-only 的 WASM 套件，只能動態 import；sharp 負責從整頁 PNG 裁出框內區域。

const fs = require('fs');
const path = require('path');

const FIGURES_DIR = path.resolve(__dirname, '..', 'data', 'figures');

const RENDER_SCALE = 2;        // 2x ≈ 144 DPI，夠複核與 Word 匯出用
const MARGIN_RATIO = 0.025;    // 框四周各加 2.5% 邊距（相對於框自身的寬高）

let mupdfPromise = null;
/** mupdf 的 npm 套件是 ESM；CJS 這邊只能動態 import，且只載一次 */
function loadMupdf() {
    if (!mupdfPromise) {
        mupdfPromise = import('mupdf').then(ns => ns.default ?? ns);
    }
    return mupdfPromise;
}

/**
 * 0–1000 正規化框 → 整頁點陣圖上的像素矩形（sharp.extract 的形狀）。
 * 邊距取框自身寬高的 MARGIN_RATIO，四邊各加一次；出界一律夾回頁面內。
 *
 * @param {[number,number,number,number]} box  [ymin, xmin, ymax, xmax]，0–1000
 * @param {number} imgWidth   整頁點陣圖的寬（px）
 * @param {number} imgHeight  整頁點陣圖的高（px）
 * @param {number} [marginRatio]
 * @returns {{left:number, top:number, width:number, height:number}|null}
 *          框退化（寬或高不足 1px）時回 null
 */
function boxToPixels(box, imgWidth, imgHeight, marginRatio = MARGIN_RATIO) {
    const [ymin, xmin, ymax, xmax] = box;
    const mx = (xmax - xmin) * marginRatio;
    const my = (ymax - ymin) * marginRatio;

    const left = Math.max(0, Math.floor((xmin - mx) / 1000 * imgWidth));
    const top = Math.max(0, Math.floor((ymin - my) / 1000 * imgHeight));
    const right = Math.min(imgWidth, Math.ceil((xmax + mx) / 1000 * imgWidth));
    const bottom = Math.min(imgHeight, Math.ceil((ymax + my) / 1000 * imgHeight));

    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) return null;
    return { left, top, width, height };
}

/**
 * 把一批題目的附圖裁成 PNG，路徑（`/figures/<jobId>-<idx>.png`，可直接當 <img src>）
 * **就地**寫回各題的 `figure_img`。沒有任何一題帶框時什麼都不做。
 *
 * @param {{pdfBytes:Buffer, jobId:number,
 *          questions:Array<{idx:number, figure_page?:number, figure_box?:number[]}>,
 *          logger?:object}} opts  figure_page 是整份 PDF 的絕對頁碼（1-based）
 * @returns {Promise<number>} 成功裁出的張數
 */
async function cropFigures({ pdfBytes, jobId, questions, logger = console }) {
    const targets = (questions || []).filter(
        q => Number.isInteger(q?.figure_page) && Array.isArray(q?.figure_box)
    );
    if (targets.length === 0) return 0;

    fs.mkdirSync(FIGURES_DIR, { recursive: true });
    const sharp = require('sharp');
    const mupdf = await loadMupdf();

    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    const pageCache = new Map();   // 絕對頁碼 → {png:Buffer, width, height}；同頁多圖只渲染一次
    let cropped = 0;

    try {
        for (const q of targets) {
            try {
                let rendered = pageCache.get(q.figure_page);
                if (!rendered) {
                    const page = doc.loadPage(q.figure_page - 1);
                    const pixmap = page.toPixmap(
                        mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE),
                        mupdf.ColorSpace.DeviceRGB,
                        false,   // 不要 alpha：考卷底色就是白的，PNG 也小一點
                        true
                    );
                    const png = Buffer.from(pixmap.asPNG());
                    pixmap.destroy();
                    page.destroy();
                    const meta = await sharp(png).metadata();
                    rendered = { png, width: meta.width, height: meta.height };
                    pageCache.set(q.figure_page, rendered);
                }

                const rect = boxToPixels(q.figure_box, rendered.width, rendered.height);
                if (!rect) {
                    logger.warn?.({ msg: '附圖框退化，略過', job_id: jobId, idx: q.idx, box: q.figure_box });
                    continue;
                }

                const file = path.join(FIGURES_DIR, `${jobId}-${q.idx}.png`);
                await sharp(rendered.png).extract(rect).png().toFile(file);
                q.figure_img = `/figures/${jobId}-${q.idx}.png`;
                cropped += 1;
            } catch (err) {
                logger.warn?.({ msg: '附圖裁切失敗，該題僅缺圖', job_id: jobId, idx: q.idx, error: err.message });
            }
        }
    } finally {
        doc.destroy();
    }
    return cropped;
}

module.exports = { cropFigures, boxToPixels, FIGURES_DIR, RENDER_SCALE, MARGIN_RATIO };
