const pool = require('../config/db');
const wordService = require('../services/wordService');

exports.downloadWord = async (req, res, next) => {
    const { paper_title, student_name, question_ids } = req.body;
    if (!question_ids || !Array.isArray(question_ids) || question_ids.length === 0) {
        return res.status(400).json({ message: "無效的題目資料，無法產生 Word" });
    }

    try {
        const placeholders = question_ids.map(() => '?').join(',');
        const [questions] = await pool.execute(`SELECT id, question_text, question_type, difficulty, question_img, answer_text FROM questions WHERE id IN (${placeholders})`, question_ids);

        const sortedQuestions = question_ids.map(id => questions.find(q => q.id === id)).filter(Boolean);

        const docBuffer = await wordService.generateExamPaperDocx(paper_title, student_name, sortedQuestions);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(paper_title)}.docx`);
        res.setHeader('Content-Length', docBuffer.length);

        return res.send(docBuffer);
    } catch (err) { next(err); }
};