const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak, ImageRun } = require('docx');
const fetch = require('node-fetch'); // node-fetch v2 為 CommonJS，於模組載入時引入一次即可
const { buildParagraphComponents } = require('../utils/textFormatter');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 圖片大小上限 5MB

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

exports.generateExamPaperDocx = async (paperTitle, studentName, sortedQuestions) => {
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

        if (q.question_img && isSafeImageUrl(q.question_img)) {
            try {
                const imgResponse = await fetch(q.question_img, { timeout: 8000, size: MAX_IMAGE_BYTES });
                const contentType = imgResponse.headers.get('content-type') || '';
                if (imgResponse.ok && contentType.startsWith('image/')) {
                    const arrayBuffer = await imgResponse.arrayBuffer();
                    const imageBuffer = Buffer.from(arrayBuffer);
                    childrenElements.push(new Paragraph({ children: [new ImageRun({ data: imageBuffer, transformation: { width: 300, height: 200 } })], alignment: AlignmentType.CENTER }));
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