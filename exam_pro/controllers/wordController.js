const { query } = require('../config/db');
const wordService = require('../services/wordService');

exports.downloadWord = async (req, res, next) => {
    const { paper_title, student_name, question_ids } = req.body;
    if (!question_ids || !Array.isArray(question_ids) || question_ids.length === 0) {
        return res.status(400).json({ message: "無效的題目資料，無法產生 Word" });
    }

    // = ANY($1::int[]) 會把整個陣列交給 PG 做型別轉換，混進非整數會直接噴 22P02，
    // 所以先在 Node 端過濾成整數陣列（也順便擋掉前端傳來的髒值）。
    const ids = question_ids.map(v => parseInt(v, 10)).filter(Number.isInteger);
    if (ids.length === 0) {
        return res.status(400).json({ message: "無效的題目資料，無法產生 Word" });
    }

    try {
        // 這裡**刻意不加** archived_at IS NULL：下載的是「已經出過的試卷」，
        // 題目事後被封存時仍應印得出來，否則舊卷會突然少幾題。
        const { rows: questions } = await query(
            `SELECT id, question_text, question_type, difficulty, question_img, answer_text
               FROM questions WHERE id = ANY($1::int[])`,
            [ids]
        );

        const sortedQuestions = ids.map(id => questions.find(q => q.id === id)).filter(Boolean);

        const docBuffer = await wordService.generateExamPaperDocx(paper_title, student_name, sortedQuestions);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(paper_title)}.docx`);
        res.setHeader('Content-Length', docBuffer.length);

        return res.send(docBuffer);
    } catch (err) { next(err); }
};
