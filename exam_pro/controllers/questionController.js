const pool = require('../config/db');
const { CHAPTERS, isValidSubject, isValidChapter, isValidQuestionType, normalizeDifficulty, QUESTION_TYPES } = require('../config/chapters');

// 提供前端手動錄入時的章節下拉選單來源
exports.getChapterWhitelist = (req, res) => {
    res.json(CHAPTERS);
};

// 共用：驗證並正規化題目欄位（手動新增與編輯共用）
function validateQuestionFields(body) {
    const subject = body.subject;
    const chapter = (body.chapter || '').trim();
    const question_text = (body.question_text || '').trim();
    const answer_text = (body.answer_text || '').trim();
    const question_type = body.question_type || '填空';
    const difficulty = normalizeDifficulty(body.difficulty ?? 3);

    if (!subject || !chapter || !question_text) return { ok: false, error: '學科、章節、題目內容皆為必填！' };
    if (!isValidSubject(subject)) return { ok: false, error: '學科僅能為「數學」或「物理」！' };
    if (!isValidChapter(subject, chapter)) return { ok: false, error: `章節「${chapter}」不在 ${subject} 的精細章節白名單中！` };
    if (!isValidQuestionType(question_type)) return { ok: false, error: `題型僅能為：${QUESTION_TYPES.join('、')}` };
    if (difficulty === null) return { ok: false, error: '難度必須為 1 到 5 的整數！' };

    return { ok: true, value: { subject, chapter, question_type, difficulty, question_text, answer_text } };
}

exports.createQuestion = async (req, res, next) => {
    const { subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img } = req.body;
    if (!subject || !chapter || !question_text || !answer_text) {
        return res.status(400).json({ message: '學科、章節、題目內容與答案皆為必填欄位！' });
    }
    if (!isValidSubject(subject)) {
        return res.status(400).json({ message: '學科僅能為「數學」或「物理」！' });
    }
    if (!isValidChapter(subject, chapter.trim())) {
        return res.status(400).json({ message: `章節「${chapter.trim()}」不在 ${subject} 的精細章節白名單中！` });
    }
    const qType = question_type || '填空';
    if (!isValidQuestionType(qType)) {
        return res.status(400).json({ message: `題型僅能為：${QUESTION_TYPES.join('、')}` });
    }
    const diff = normalizeDifficulty(difficulty ?? 3);
    if (diff === null) {
        return res.status(400).json({ message: '難度必須為 1 到 5 的整數！' });
    }
    try {
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img, history_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`;
        const [result] = await pool.execute(sql, [subject, chapter.trim(), qType, diff, question_text.trim(), question_img || null, answer_text.trim(), solution_img || null]);
        res.status(201).json({ message: '題目錄入成功！', questionId: result.insertId });
    } catch (err) { next(err); }
};

exports.batchSaveQuestions = async (req, res, next) => {
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ message: "資料格式不正確或陣列為空" });
    }

    // ?strict=1 保留舊行為：只要有一題不合格就整批退回，不寫入任何一筆
    const strict = req.query.strict === '1';

    // 後端逐題驗證，攔截 AI 產生的非法 subject / chapter / 題型 / 難度
    // 通過的題目照樣入庫，未通過的以 rejected 回報（idx 為請求陣列中 0 起始的索引）
    const rejected = [];
    const values = [];
    questions.forEach((q, idx) => {
        const subject = q.subject;
        const chapter = (q.chapter || '').trim();
        const qType = q.question_type || '填空';
        const diff = normalizeDifficulty(q.difficulty ?? 3);

        if (!isValidSubject(subject)) { rejected.push({ idx, reason: `學科「${subject}」無效` }); return; }
        if (!isValidChapter(subject, chapter)) { rejected.push({ idx, reason: `章節「${chapter}」不在白名單` }); return; }
        if (!isValidQuestionType(qType)) { rejected.push({ idx, reason: `題型「${qType}」無效` }); return; }
        if (diff === null) { rejected.push({ idx, reason: '難度無效' }); return; }
        if (!q.question_text || !String(q.question_text).trim()) { rejected.push({ idx, reason: '缺少題目內容' }); return; }

        values.push([subject, chapter, qType, diff, String(q.question_text).trim(), (q.answer_text || '略'), '{}']);
    });

    if (strict && rejected.length > 0) {
        const errors = rejected.map(r => `第 ${r.idx + 1} 題：${r.reason}`);
        return res.status(400).json({ message: `有 ${errors.length} 題未通過驗證，請重新分析：\n` + errors.join('\n') });
    }

    // 全軍覆沒時沒有任何一筆寫入，回 400 但維持同一個回應形狀
    if (values.length === 0) {
        return res.status(400).json({
            message: `${rejected.length} 題全部未通過驗證，沒有任何題目寫入題庫。`,
            saved_count: 0,
            rejected
        });
    }

    try {
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, history_json) VALUES ?`;
        await pool.query(sql, [values]);
        const message = rejected.length === 0
            ? `🎉 成功！已將共 ${values.length} 題自動錄入資料庫！`
            : `已寫入 ${values.length} 題；另有 ${rejected.length} 題未通過驗證（已在下方標紅），修正後可再次送出。`;
        res.json({ message, saved_count: values.length, rejected });
    } catch (err) { next(err); }
};

exports.getChapters = async (req, res, next) => {
    try {
        const [rows] = await pool.execute('SELECT DISTINCT subject, chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ""');
        res.json(rows);
    } catch (err) { next(err); }
};

// 題庫列表（支援篩選與分頁）
exports.listQuestions = async (req, res, next) => {
    try {
        const { subject, chapter, question_type, q } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const where = [];
        const params = [];
        if (subject) { where.push('subject = ?'); params.push(subject); }
        if (chapter) { where.push('chapter = ?'); params.push(chapter); }
        if (question_type) { where.push('question_type = ?'); params.push(question_type); }
        if (q) { where.push('(question_text LIKE ? OR answer_text LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM questions ${whereSql}`, params);
        const total = countRows[0].total;

        const [rows] = await pool.query(
            `SELECT id, subject, chapter, question_type, difficulty, question_text, answer_text, created_at
             FROM questions ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        res.json({ total, page, limit, totalPages: Math.ceil(total / limit) || 1, questions: rows });
    } catch (err) { next(err); }
};

// 更新單一題目
exports.updateQuestion = async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });
    const v = validateQuestionFields(req.body);
    if (!v.ok) return res.status(400).json({ message: v.error });
    try {
        const { subject, chapter, question_type, difficulty, question_text, answer_text } = v.value;
        const [result] = await pool.execute(
            `UPDATE questions SET subject=?, chapter=?, question_type=?, difficulty=?, question_text=?, answer_text=? WHERE id=?`,
            [subject, chapter, question_type, difficulty, question_text, answer_text || '略', id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: '找不到該題目' });
        res.json({ message: '題目已更新！', id });
    } catch (err) { next(err); }
};

// 刪除單一題目
exports.deleteQuestion = async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });
    try {
        const [result] = await pool.execute('DELETE FROM questions WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: '找不到該題目' });
        res.json({ message: '題目已刪除！', id });
    } catch (err) { next(err); }
};
