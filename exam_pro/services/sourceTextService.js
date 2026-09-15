// services/sourceTextService.js — 在 extract 階段抽原卷文字層片段（docs/source-check.md）
//
// PDF 在全部 chunk 拆完後就刪檔（workers/jobRunner.js 的 runExtractJob），所以原卷文字層
// 必須在 extract 階段、PDF 還在磁碟上時抽。每題只存定位到的**片段**（≤ 1500 字），不存整頁：
//
//   payload.extract.source_text = { v:1, status, pages:[from,to], locate_score, segment?, shared? }
//   status ∈ 'located' | 'no_text_layer' | 'not_found' | 'low_anchor' | 'error'
//
// 紀律與附圖裁切相同：抽不出來只該少一個比對，不該少一道題——任何例外都收成 status='error'。
// **純程式步驟，不呼叫任何模型**；比對本身在 source_check 節點（agents/source_check.js）做。

const { loadMupdf } = require('./mupdf');
const { locateSegments } = require('../utils/sourceCheck');

const SOURCE_TEXT_VERSION = 1;

/**
 * 讀出 PDF 指定頁範圍的文字層（依頁序串接，頁與頁之間一個換行）。
 *
 * @param {Buffer} pdfBytes
 * @param {number} fromPage  1-based，含
 * @param {number|null} toPage  1-based，含；null 表示到最後一頁
 * @returns {Promise<{text:string, pages:[number,number]}>}
 */
async function readPagesText(pdfBytes, fromPage, toPage) {
    const mupdf = await loadMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    try {
        const count = doc.countPages();
        const from = Math.max(1, Number.isInteger(fromPage) ? fromPage : 1);
        const to = Math.min(count, Number.isInteger(toPage) ? toPage : count);
        let text = '';
        for (let i = from; i <= to; i++) {
            const page = doc.loadPage(i - 1);
            try {
                const st = page.toStructuredText('preserve-whitespace');
                try {
                    text += st.asText() + '\n';
                } finally {
                    st.destroy();
                }
            } finally {
                page.destroy();
            }
        }
        return { text, pages: [from, to] };
    } finally {
        doc.destroy();
    }
}

/**
 * 替一塊（chunk）的題目**就地**寫上 `source_text`。
 *
 * @param {{pdfBytes:Buffer, questions:Array<object>, fromPage:number, toPage:number|null,
 *          options?:object, logger?:object, jobId?:number}} opts
 * @returns {Promise<{located:number, total:number}>}
 */
async function attachSourceText({ pdfBytes, questions, fromPage, toPage, options, logger = console, jobId = null }) {
    const list = Array.isArray(questions) ? questions : [];
    if (list.length === 0) return { located: 0, total: 0 };
    let pages = [fromPage ?? 1, toPage ?? null];
    try {
        const read = await readPagesText(pdfBytes, fromPage, toPage);
        pages = read.pages;
        const results = locateSegments(list, read.text, options);
        let located = 0;
        list.forEach((q, i) => {
            const r = results[i];
            if (r.status === 'located') located += 1;
            q.source_text = { v: SOURCE_TEXT_VERSION, ...r, pages };
        });
        return { located, total: list.length };
    } catch (err) {
        logger.warn?.({ msg: '原卷文字層抽取失敗（題目照常入列，僅不做原卷比對）', job_id: jobId, error: err.message });
        for (const q of list) {
            q.source_text = { v: SOURCE_TEXT_VERSION, status: 'error', pages, locate_score: null };
        }
        return { located: 0, total: list.length };
    }
}

module.exports = { readPagesText, attachSourceText, SOURCE_TEXT_VERSION };
