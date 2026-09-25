// controllers/wordController.js — POST /api/download-word（Word 匯出）
//
// 〔stage5 WS-A〕body 多一個可選的 edition（docs/interfaces-stage5.md 第 4.1 條第 6 項；DEC-017）：
//   沒送＝'standard'（現行行為）、'student'（不附答案）、'solution'（答案之後附詳解）；
//   其他值回 400。既有的 400 訊息與檢查順序不變，edition 的檢查排在它們之後。
// 〔stage5 整合〕多查 solution_src：詳解版對 verify／ai 來源的詳解加註「未經老師審閱」（services/wordService.js）。
// 〔retrain PR-3〕body 多一個可選的 paper_id（docs/retrain-and-review.md 第 5.2 節 API-12；〔Owner 決策單 2026-09-26 R7 選 1〕）：
//   FEATURE_RETRAIN 開啟而且帶了 paper_id 時，查這張卷上哪幾題是重練派題（purpose = 'retrain'），
//   標準版與詳解版的答案區在那幾題的題號後加「（重練）」；題目區（會印給學生的卷面）與學生版完全不標。
//   旗標關閉時照舊忽略 paper_id（組卷頁本來就會把 paper_id 一起送來），沒帶 paper_id 時 Word 逐位元不變。
//   paper_id 格式不對 → 400（排在既有檢查之後）；卷不存在或卷上沒有重練題 → 不標（不回 404：下載看的是 question_ids）。
const { query } = require('../config/db');
const wordService = require('../services/wordService');
const features = require('../config/features');
const { parseWordPaperId } = require('../utils/retrainValidation');

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

    const edition = wordService.parseEdition(req.body.edition);
    if (edition === null) {
        return res.status(400).json({ message: `edition 只接受 ${wordService.EDITIONS.join('、')}。` });
    }

    // 〔retrain PR-3〕API-12（旗標關閉時一律回 paperId: null）
    const pid = parseWordPaperId(req.body, { enabled: features.FEATURE_RETRAIN });
    if (pid.error) return res.status(400).json({ message: pid.error });

    try {
        // 這裡**刻意不加** archived_at IS NULL：下載的是「已經出過的試卷」，
        // 題目事後被封存時仍應印得出來，否則舊卷會突然少幾題。
        const { rows: questions } = await query(
            `SELECT id, question_text, question_type, difficulty, question_img, answer_text, solution_text, solution_src
               FROM questions WHERE id = ANY($1::int[])`,
            [ids]
        );

        const sortedQuestions = ids.map(id => questions.find(q => q.id === id)).filter(Boolean);

        // 〔retrain PR-3〕這張卷上的重練題（R7 選 1 的標示用）；沒帶 paper_id 時 options 與 PR-3 之前完全相同
        const options = { edition };
        if (pid.paperId !== null) {
            const { rows: retrainRows } = await query(
                `SELECT question_id FROM assignments WHERE paper_id = $1 AND purpose = 'retrain'`, [pid.paperId]);
            options.retrainQuestionIds = retrainRows.map(r => r.question_id);
        }

        const docBuffer = await wordService.generateExamPaperDocx(paper_title, student_name, sortedQuestions, options);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(paper_title)}.docx`);
        res.setHeader('Content-Length', docBuffer.length);

        return res.send(docBuffer);
    } catch (err) { next(err); }
};
