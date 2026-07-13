const pool = require('../config/db');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章

exports.generatePaper = async (req, res, next) => {
    const { student_name, subject, chapter, count } = req.body;

    if (!student_name || !subject || !chapter || count === undefined || count === null) {
        return res.status(400).json({ message: "所有篩選欄位皆為必填！" });
    }

    const limitCount = parseInt(count, 10);
    if (!Number.isInteger(limitCount) || limitCount < 1) {
        return res.status(400).json({ message: "抽題數量必須為大於 0 的整數！" });
    }
    if (limitCount > MAX_QUESTIONS) {
        return res.status(400).json({ message: `抽題數量過大，單次最多 ${MAX_QUESTIONS} 題。` });
    }

    // 清理學生姓名：移除可能破壞 JSON 路徑的字元（雙引號、反斜線）
    const trimmedName = String(student_name).trim();
    const safeStudentName = trimmedName.replace(/["\\]/g, '');
    if (!safeStudentName) {
        return res.status(400).json({ message: "學生姓名無效！" });
    }

    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.execute('SELECT id, history_json FROM questions WHERE subject = ? AND chapter = ?', [subject, chapter]);

        const availableQuestions = rows.filter(q => {
            let history = q.history_json;
            if (typeof history === 'string') {
                try { history = JSON.parse(history); } catch (e) { history = {}; }
            }
            history = history || {};
            return !Object.prototype.hasOwnProperty.call(history, safeStudentName);
        });

        if (availableQuestions.length < limitCount) {
            return res.status(400).json({ message: `新題目庫存不足！該章節 [${safeStudentName}] 沒寫過的題目僅剩 ${availableQuestions.length} 題。` });
        }

        const shuffled = [...availableQuestions].sort(() => 0.5 - Math.random());
        const rawSelectedIds = shuffled.slice(0, limitCount).map(q => q.id);

        const placeholders = rawSelectedIds.map(() => '?').join(',');
        const [fullQuestions] = await conn.execute(
            `SELECT id, question_text, question_type, difficulty, answer_text FROM questions WHERE id IN (${placeholders})`,
            rawSelectedIds
        );

        const typeWeights = { '單選': 1, '多選': 2, '填空': 3, '計算': 4, '證明': 5 };
        const sortedQuestions = fullQuestions.sort((a, b) => {
            const wA = typeWeights[a.question_type] || 99;
            const wB = typeWeights[b.question_type] || 99;
            if (wA !== wB) return wA - wB;
            return (a.difficulty || 3) - (b.difficulty || 3);
        });

        const finalSortedIds = sortedQuestions.map(q => q.id);
        const d = new Date();
        const safeDateStr = `${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`;
        const paperTitle = `${trimmedName}-${chapter}特訓卷(${safeDateStr})`;
        const todayStr = d.toISOString().split('T')[0];

        // 交易：建立試卷與更新作答歷史必須一起成功，否則全部回滾
        await conn.beginTransaction();

        await conn.execute(
            'INSERT INTO exam_papers (title, student_name, question_ids) VALUES (?, ?, ?)',
            [paperTitle, trimmedName, JSON.stringify(finalSortedIds)]
        );

        // JSON 路徑以參數綁定傳入（非字串拼接進 SQL），姓名已去除危險字元
        const jsonPath = `$."${safeStudentName}"`;
        for (const id of finalSortedIds) {
            await conn.execute(
                `UPDATE questions SET history_json = JSON_SET(history_json, ?, ?) WHERE id = ?`,
                [jsonPath, todayStr, id]
            );
        }

        await conn.commit();

        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions
        });
    } catch (err) {
        try { await conn.rollback(); } catch (e) { /* ignore rollback error */ }
        next(err);
    } finally {
        conn.release();
    }
};
