const { pool, query } = require('../config/db');
const { pickOnePerFamily } = require('../utils/pickOnePerFamily');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章
const MAX_EXCLUDE = 200;  // 換一題／重抽的排除清單上限（stage4-plan.md §2.2）

// ─────────────────────────────────────────────────────────────
// 智慧組卷（D-D4 重寫；階段 4 W1-1/W1-2 改契約，docs/stage4-plan.md §2.2）
//
// 與 D-D4 版的三個差異（其餘照舊）：
//   1. 裁決 S4-1：**不再自動建學生**。收 student_id（優先）或 student_name（相容），
//      查無此人一律 404——「打名字自動建學生」正是垃圾人名（小／名／華）分裂
//      不重複出題紀錄的根因，建學生從此只有 POST /api/students 一個入口。
//   2. dry_run: true → 走完全相同的選題邏輯但**整段不寫庫**（不建卷、不寫 attempts），
//      回預覽。前端的「生成」一律先走這裡，看過才確認。
//   3. exclude_ids: int[] → 候選池額外排除（「換一題」把那題加進來再叫一次；
//      「整卷重抽」同參數重叫，洗牌自然給出不同組合）。
//
// 舊有的硬閘門不變：
//   候選池   NOT EXISTS (SELECT 1 FROM attempts …)（不是 NOT IN，NULL 語意才不會咬人）
//   寫入     UNIQUE (student_id, question_id)＋rowCount 檢查——兩個請求同時抽到同一題時，
//            後者整筆交易回滾並回 409，而不是悄悄少記一題。
// ─────────────────────────────────────────────────────────────

/** 考卷內的排序：題型權重 → 難度（generate 與 confirm 共用，兩邊順序才一致）。 */
function sortForPaper(questions) {
    const typeWeights = { '單選': 1, '多選': 2, '填空': 3, '計算': 4, '證明': 5 };
    return [...questions].sort((a, b) => {
        const wA = typeWeights[a.question_type] || 99;
        const wB = typeWeights[b.question_type] || 99;
        if (wA !== wB) return wA - wB;
        return (a.difficulty || 3) - (b.difficulty || 3);
    });
}

/** 標題與 assigned_at 都用**本地時區**（toISOString 是 UTC，台灣早上 8 點前會差一天）。 */
function localDates() {
    const d = new Date();
    return {
        titleDate: `${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`,
        todayStr: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    };
}

/**
 * 解析學生（S4-1：只查、不建）。
 * @returns {Promise<{student:{id:number,name:string}|null, error:{status:number,message:string}|null}>}
 */
async function resolveStudent({ student_id, student_name }) {
    if (student_id !== undefined && student_id !== null) {
        const id = Number.parseInt(student_id, 10);
        if (!Number.isInteger(id) || id < 1) return { student: null, error: { status: 400, message: 'student_id 無效。' } };
        const { rows } = await query('SELECT id, name FROM students WHERE id = $1', [id]);
        if (rows.length === 0) return { student: null, error: { status: 404, message: '找不到該學生' } };
        return { student: rows[0], error: null };
    }
    const trimmedName = String(student_name ?? '').trim();
    if (!trimmedName) return { student: null, error: { status: 400, message: '學生姓名無效！' } };
    const { rows } = await query('SELECT id, name FROM students WHERE name = $1', [trimmedName]);
    if (rows.length === 0) {
        return { student: null, error: { status: 404, message: `查無學生「${trimmedName}」，請先新增學生。` } };
    }
    return { student: rows[0], error: null };
}

exports.generatePaper = async (req, res, next) => {
    const { student_id, student_name, subject, chapter, count, dry_run, exclude_ids } = req.body;

    const hasStudent = (student_id !== undefined && student_id !== null) || student_name;
    if (!hasStudent || !subject || !chapter || count === undefined || count === null) {
        return res.status(400).json({ message: "所有篩選欄位皆為必填！" });
    }

    const limitCount = parseInt(count, 10);
    if (!Number.isInteger(limitCount) || limitCount < 1) {
        return res.status(400).json({ message: "抽題數量必須為大於 0 的整數！" });
    }
    if (limitCount > MAX_QUESTIONS) {
        return res.status(400).json({ message: `抽題數量過大，單次最多 ${MAX_QUESTIONS} 題。` });
    }

    let excludeIds = [];
    if (exclude_ids !== undefined && exclude_ids !== null) {
        if (!Array.isArray(exclude_ids) || exclude_ids.some(v => !Number.isInteger(v) || v < 1)) {
            return res.status(400).json({ message: 'exclude_ids 必須是正整數陣列。' });
        }
        if (exclude_ids.length > MAX_EXCLUDE) {
            return res.status(400).json({ message: `exclude_ids 最多 ${MAX_EXCLUDE} 個。` });
        }
        excludeIds = [...new Set(exclude_ids)];
    }

    try {
        const { student, error } = await resolveStudent({ student_id, student_name });
        if (error) return res.status(error.status).json({ message: error.message });

        // 候選池：同學科同章、未封存、該生沒寫過、且不在排除清單內
        const { rows: candidates } = await query(
            `SELECT q.id, q.variant_of FROM questions q
              WHERE q.subject = $1 AND q.chapter = $2 AND q.archived_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $3)
                AND NOT (q.id = ANY($4::int[]))`,
            [subject, chapter, student.id, excludeIds]
        );

        // 家族互斥：同一 variant_of 家族在同一張卷只取一題（規劃 §4.1）。
        // pickOnePerFamily 內部已做「每組洗牌取代表 → 對代表 Fisher-Yates」。
        // 「庫存不足」檢查在家族互斥**之後**（裁決 S3-6），${n} 代入家族數。
        const familyPicked = pickOnePerFamily(candidates);
        if (familyPicked.length < limitCount) {
            return res.status(400).json({ message: `新題目庫存不足！該章節 [${student.name}] 沒寫過的題目僅剩 ${familyPicked.length} 題。` });
        }

        const rawSelectedIds = familyPicked.slice(0, limitCount).map(q => q.id);
        const { rows: fullQuestions } = await query(
            `SELECT id, question_text, question_type, difficulty, answer_text
               FROM questions WHERE id = ANY($1::int[])`,
            [rawSelectedIds]
        );
        const sortedQuestions = sortForPaper(fullQuestions);
        const finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        const paperTitle = `${student.name}-${chapter}特訓卷(${titleDate})`;

        // ── dry_run：到此為止，一個位元組都沒寫（W1-2 的「草稿」）──
        if (dry_run) {
            return res.status(200).json({
                dry_run: true,
                message: '預覽（尚未寫入）：確認後才會建卷並記入作答歷史。',
                student_id: student.id,
                paper_title_preview: paperTitle,
                question_ids: finalSortedIds,
                questions: sortedQuestions
            });
        }

        // ── 真出卷：建卷＋attempts 同一交易 ──
        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr
        });
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被同時指派給該學生，請重試。' });
        }
        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions
        });
    } catch (err) {
        next(err);
    }
};

/**
 * 建卷＋寫 attempts（generate 與 confirm 共用；同一交易、rowCount 硬閘門）。
 * @returns {Promise<{paperId:number|null, conflict:boolean}>}
 */
async function writePaper({ studentId, paperTitle, questionIds, todayStr }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [paper] } = await client.query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
            [paperTitle, studentId, questionIds]
        );
        const ins = await client.query(
            `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at)
             SELECT $1::int, x, $3::int, $4::date FROM unnest($2::int[]) AS x
             ON CONFLICT (student_id, question_id) DO NOTHING`,
            [studentId, questionIds, paper.id, todayStr]
        );
        // 寫入筆數少於題數 ⇒ 有題目在選完之後被別的請求指派給同一位學生（或預覽已過期）
        if (ins.rowCount !== questionIds.length) {
            await client.query('ROLLBACK');
            return { paperId: null, conflict: true };
        }
        await client.query('COMMIT');
        return { paperId: paper.id, conflict: false };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        throw err;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────
// POST /api/confirm-paper（W1-2 的「確認」；docs/stage4-plan.md §2.3）
//
// 收 { student_id, question_ids }——題目就是 dry_run 預覽選出的那批，所以這裡
// **不重跑**家族互斥與抽題，只重驗「題目還在、沒封存」，然後走與 generate 相同的
// 寫入閘門：attempts 的 ON CONFLICT DO NOTHING + rowCount 檢查——預覽過期
// （這段時間內有人把同一題指派給同一位學生）會回 409 而不是悄悄少記。
// 回應形狀與 generate-paper 成功時一致，前端共用同一段渲染與 Word 匯出。
// ─────────────────────────────────────────────────────────────
exports.confirmPaper = async (req, res, next) => {
    const { student_id, question_ids } = req.body;
    const id = Number.parseInt(student_id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'student_id 無效。' });
    if (!Array.isArray(question_ids) || question_ids.length === 0 || question_ids.length > MAX_QUESTIONS ||
        question_ids.some(v => !Number.isInteger(v) || v < 1)) {
        return res.status(400).json({ message: `question_ids 必須是 1~${MAX_QUESTIONS} 個正整數。` });
    }
    if (new Set(question_ids).size !== question_ids.length) {
        return res.status(400).json({ message: 'question_ids 不得重複。' });
    }
    try {
        const { rows: [student] } = await query('SELECT id, name FROM students WHERE id = $1', [id]);
        if (!student) return res.status(404).json({ message: '找不到該學生' });

        const { rows: fullQuestions } = await query(
            `SELECT id, chapter, question_text, question_type, difficulty, answer_text
               FROM questions WHERE id = ANY($1::int[]) AND archived_at IS NULL`,
            [question_ids]
        );
        if (fullQuestions.length !== question_ids.length) {
            return res.status(400).json({ message: '部分題目已不存在或已封存，請重新預覽。' });
        }

        const sortedQuestions = sortForPaper(fullQuestions);
        const finalSortedIds = sortedQuestions.map(q => q.id);
        const { titleDate, todayStr } = localDates();
        // 預覽是單一章節出的；混章時取排序後第一題的章節（標題本來就只是人看的）
        const paperTitle = `${student.name}-${sortedQuestions[0].chapter}特訓卷(${titleDate})`;

        const outcome = await writePaper({
            studentId: student.id, paperTitle, questionIds: finalSortedIds, todayStr
        });
        if (outcome.conflict) {
            return res.status(409).json({ message: '部分題目已被指派給該學生（可能是預覽已過期），請重新預覽。' });
        }
        res.status(200).json({
            message: '出卷完成！已記錄作答歷史，避免下次重複。',
            paper_id: outcome.paperId,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions.map(({ chapter, ...q }) => q)
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/papers/:id（W1-2 的「後悔藥」；裁決 S4-3）
//
// 同一交易刪該卷的 attempts 與卷本身——被這張卷「燒掉」的題目回到該生的候選池。
// ⚠ 已批改的紀錄會一併消失（弱點面板的分母會變小）；前端警告文案明說，這裡不再多問。
// ─────────────────────────────────────────────────────────────
exports.deletePaper = async (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: '試卷 id 無效。' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const a = await client.query('DELETE FROM attempts WHERE paper_id = $1', [id]);
        const p = await client.query('DELETE FROM exam_papers WHERE id = $1', [id]);
        if (p.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該試卷' });
        }
        await client.query('COMMIT');
        res.status(200).json({ deleted_attempts: a.rowCount });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};
