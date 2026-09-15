const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak, ImageRun } = require('docx');
const fetch = require('node-fetch'); // node-fetch v2 為 CommonJS，於模組載入時引入一次即可
const fs = require('fs');
const path = require('path');
const { buildParagraphComponents } = require('../utils/textFormatter');
const { FIGURES_DIR, RENDER_SCALE } = require('./figureService');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 圖片大小上限 5MB

// ── 本機附圖（docs/figures.md「Word 匯出」段）──
//
// 管線裁的圖存在 data/figures/，questions.question_img 只記相對路徑 /figures/<檔名>。
// 這種路徑不走下面的 http 下載（SSRF 白名單本來就擋），改成直接讀本機檔嵌入。
//
// 版面：docx 預設 A4 直式、左右邊界各 1440 twips → 可用寬 9026 twips ≈ 6.27 吋 ≈ 601 px（96 DPI）。
// 裁圖以 RENDER_SCALE 倍（72×2＝144 DPI）渲染，換回 96 DPI 就是「原卷上的實際大小」；
// 超過可用寬高才等比例縮小，不放大、不變形。
const FIGURE_URL_RE = /^\/figures\/([A-Za-z0-9_-]+\.(?:png|jpe?g))$/i;
const FIGURE_MAX_WIDTH_PX = 600;
const FIGURE_MAX_HEIGHT_PX = 800;
const FIGURE_SOURCE_DPI = 72 * RENDER_SCALE;
const FIGURE_MISSING_TEXT = '（附圖遺失）';
const DOCX_TYPE_BY_SHARP_FORMAT = { png: 'png', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' };

/**
 * `/figures/<檔名>` → 附圖目錄內的絕對路徑；不是本機附圖路徑或企圖跳出目錄時回 null。
 * 兩道檢查：檔名白名單（不含 / \ .. 與 URL 編碼），再確認 resolve 後仍在目錄內。
 *
 * @param {string} questionImg
 * @param {string} [figuresDir]
 * @returns {string|null}
 */
function resolveFigurePath(questionImg, figuresDir = FIGURES_DIR) {
    if (typeof questionImg !== 'string') return null;
    const m = FIGURE_URL_RE.exec(questionImg.trim());
    if (!m) return null;
    const root = path.resolve(figuresDir);
    const full = path.resolve(root, m[1]);
    if (path.dirname(full) !== root) return null;
    return full;
}

/**
 * 依原圖像素與來源 DPI 算出 Word 內的顯示尺寸（px，96 DPI），等比例夾在可用寬高內。
 *
 * @param {number} width   原圖寬（px）
 * @param {number} height  原圖高（px）
 * @param {{sourceDpi?:number, maxWidth?:number, maxHeight?:number}} [opts]
 * @returns {{width:number, height:number}}
 */
function fitFigureSize(width, height, { sourceDpi = FIGURE_SOURCE_DPI, maxWidth = FIGURE_MAX_WIDTH_PX, maxHeight = FIGURE_MAX_HEIGHT_PX } = {}) {
    const natural = 96 / sourceDpi;
    const scale = Math.min(natural, maxWidth / width, maxHeight / height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

/**
 * 讀本機附圖並做成置中的圖片段落；任何失敗（檔案不存在、不是圖、格式不支援）回 null，
 * 由呼叫端放「（附圖遺失）」——少一張圖不能讓整份考卷匯出失敗。
 */
async function buildLocalFigureParagraph(filePath, { questionId, logger }) {
    try {
        const data = await fs.promises.readFile(filePath);
        const sharp = require('sharp');
        const meta = await sharp(data).metadata();
        const type = DOCX_TYPE_BY_SHARP_FORMAT[meta.format];
        if (!type || !meta.width || !meta.height) throw new Error(`不支援的圖檔格式：${meta.format}`);
        const size = fitFigureSize(meta.width, meta.height);
        return new Paragraph({ children: [new ImageRun({ data, type, transformation: size })], alignment: AlignmentType.CENTER });
    } catch (err) {
        logger.warn?.({ msg: 'Word 匯出：附圖讀取失敗，以文字標示遺失', question_id: questionId, file: path.basename(filePath), error: err.message });
        return null;
    }
}

// docx v9 的 ImageRun 必須指定 type，否則圖片會以 word/media/<hash>.undefined 落地，
// 而 [Content_Types].xml 沒有對應的副檔名宣告，Word 會判定整份 .docx 損毀。
// 建構子不會拋錯，所以缺這個欄位是安靜地壞掉。svg 另需 fallback，故不列入支援。
const IMAGE_TYPE_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
};

// 防 SSRF：只允許 http/https，且封鎖 localhost 與內網位址
function isSafeImageUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return false;

    // 封鎖內網 / 保留 IP 範圍
    const privatePatterns = [
        /^127\./, /^10\./, /^192\.168\./,
        /^172\.(1[6-9]|2\d|3[0-1])\./,
        /^169\.254\./,           // link-local
        /^::1$/, /^fc/, /^fd/, /^fe80/ // IPv6 loopback / 私有 / link-local
    ];
    if (privatePatterns.some(re => re.test(host))) return false;

    // 若 .env 設定了白名單，則只允許名單內網域
    const allowlist = (process.env.IMAGE_HOST_ALLOWLIST || '')
        .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(host)) return false;

    return true;
}

/**
 * @param {string} paperTitle
 * @param {string} studentName
 * @param {Array<object>} sortedQuestions
 * @param {{figuresDir?:string, logger?:object}} [options]  測試可注入附圖目錄與 logger
 */
exports.generateExamPaperDocx = async (paperTitle, studentName, sortedQuestions, options = {}) => {
    const { figuresDir = FIGURES_DIR, logger = console } = options;
    const childrenElements = [];

    childrenElements.push(new Paragraph({ text: paperTitle, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
    childrenElements.push(new Paragraph({ text: `學生姓名：${studentName}     |     得分：__________     |     列印日期：${new Date().toLocaleDateString('zh-TW')}` }));
    childrenElements.push(new Paragraph({ text: "=".repeat(60) }));
    childrenElements.push(new Paragraph({ text: "一、 精選特訓試題區", heading: HeadingLevel.HEADING_1 }));

    for (let i = 0; i < sortedQuestions.length; i++) {
        const q = sortedQuestions[i];

        const paragraphComponents = [
            new TextRun({ text: `第 ${i + 1} 題. [${q.question_type}] (難度: ${'★'.repeat(q.difficulty)})\n`, bold: true, color: "2B6CB0" }),
            ...buildParagraphComponents(q.question_text)
        ];

        childrenElements.push(new Paragraph({ children: paragraphComponents }));

        if (typeof q.question_img === 'string' && q.question_img.trim().startsWith('/figures/')) {
            const filePath = resolveFigurePath(q.question_img, figuresDir);
            const figure = filePath
                ? await buildLocalFigureParagraph(filePath, { questionId: q.id, logger })
                : null;
            if (!filePath) {
                logger.warn?.({ msg: 'Word 匯出：附圖路徑不合法（不在附圖目錄內），不讀檔', question_id: q.id });
            }
            childrenElements.push(figure || new Paragraph({ text: FIGURE_MISSING_TEXT, alignment: AlignmentType.CENTER }));
            childrenElements.push(new Paragraph({ text: "" }));
        } else if (q.question_img && isSafeImageUrl(q.question_img)) {
            try {
                const imgResponse = await fetch(q.question_img, { timeout: 8000, size: MAX_IMAGE_BYTES });
                const contentType = (imgResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
                const imageType = IMAGE_TYPE_BY_MIME[contentType];
                if (imgResponse.ok && imageType) {
                    const arrayBuffer = await imgResponse.arrayBuffer();
                    const imageBuffer = Buffer.from(arrayBuffer);
                    childrenElements.push(new Paragraph({ children: [new ImageRun({ data: imageBuffer, type: imageType, transformation: { width: 300, height: 200 } })], alignment: AlignmentType.CENTER }));
                    childrenElements.push(new Paragraph({ text: "" }));
                }
            } catch (imgError) { console.error(`圖片下載失敗`, imgError.message); }
        }
        if (q.question_type === '計算' || q.question_type === '證明') {
            childrenElements.push(new Paragraph({ text: "" }), new Paragraph({ text: "" }));
        }
    }

    childrenElements.push(new Paragraph({ children: [new PageBreak()] }));
    childrenElements.push(new Paragraph({ text: "🎯 參考答案區（解答邊界）", heading: HeadingLevel.HEADING_1 }));

    sortedQuestions.forEach((q, index) => {
        childrenElements.push(new Paragraph({
            children: [
                new TextRun({ text: `第 ${index + 1} 題答案：`, bold: true }),
                new TextRun({ text: "  " }),
                ...buildParagraphComponents(q.answer_text, { color: "E53E3E", bold: true }),
                new TextRun({ text: "  " })
            ]
        }));
    });

    const doc = new Document({ sections: [{ children: childrenElements }] });
    return await Packer.toBuffer(doc);
};

// 純函式與常數匯出給單元測試（test/unit/wordFigures.test.js）
exports.resolveFigurePath = resolveFigurePath;
exports.fitFigureSize = fitFigureSize;
exports.FIGURE_MISSING_TEXT = FIGURE_MISSING_TEXT;
exports.FIGURE_MAX_WIDTH_PX = FIGURE_MAX_WIDTH_PX;