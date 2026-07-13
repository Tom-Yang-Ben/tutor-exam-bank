const fs = require('fs');
const aiService = require('../services/aiService');

exports.analyzePdf = async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ message: "沒有上傳檔案" });
        const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');

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