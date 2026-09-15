const fs = require('fs');
const aiService = require('../services/aiService');
const { isPdfBuffer } = require('../utils/pdfSniff');

exports.analyzePdf = async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ message: "沒有上傳檔案" });
        const buffer = fs.readFileSync(req.file.path);
        // 與 POST /api/jobs 同一道檔頭檢查（utils/pdfSniff.js）：副檔名與 mimetype 都是客戶端說的
        if (!isPdfBuffer(buffer)) return res.status(400).json({ message: '檔案內容不是 PDF（缺少 %PDF- 檔頭）。' });
        const pdfBase64 = buffer.toString('base64');

        const questionsArray = await aiService.analyzePdfContent(pdfBase64);
        res.json(questionsArray);
    } catch (err) {
        if (err.name === 'SyntaxError') {
            return res.status(500).json({ message: 'AI 回傳的 JSON 格式錯誤，請重新分析' });
        }
        next(err);
    } finally {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
};