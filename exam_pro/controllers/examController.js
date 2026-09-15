const { pool, query } = require('../config/db');
const { pickPaperUnits, sortForPaperGrouped } = require('../utils/paperGroups');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章
const MAX_EXCLUDE = 200;  // 換一題／重抽的排除清單上限（roadmap-plan.md §6.2.2）

/**
 * 承上題整組抽取湊不到剛好 N 題時的政策（FR-019 PR2；**待 owner 決定**，單點切換）：
 *   'note'  （預設）少出題，200 回應附 shortfall＋note 說明實際題數與原因
 *   'error' 回 400，請老師調整題數
 * 例：要 5 題，抽到 4 題後剩下的組都是 2 題一組。
 * 「真的庫存不足」（可用題數 < N）不受此政策影響，照舊回 400。
 */
const FOLLOW_UP_SHORTFALL_POLICY = 'note';

// ─────────────────────────────────────────────────────────────
// 智慧組卷（D-D4 重寫；階段 4 W1-1/W1-2 改契約，docs/roadmap-plan.md §6.2.2）
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

/**
 * 考卷內的排序：題型權重 → 難度（generate 與 confirm 共用，兩邊順序才一致）。
 * 承上題組（FR-019）以組為單位、依組首題排序，組內依承接順序相鄰；
 * 題目須帶 follows_question_id。沒有綁定時與舊版逐題排序結果相同。
 */
const sortForPaper = sortForPaperGrouped;

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

/**
 * 選題（**只讀不寫**）：generate-paper 與助教工具 preview_paper 共用。
 * 候選池、承上題整組、家族互斥、庫存不足訊息、排序、標題——與寫入路徑用同一段程式碼，
 * 預覽看到什麼、確認就寫什麼。
 *
 * 承上題（FR-019 PR2，utils/paperGroups.js）：選題單位是「前題＋所有承上題」一組，
 * 抽到就整組相鄰出現、整組算多題。**組內任一題不在候選池（已作答、exclude_ids、
 * 已封存、source_types 不符、科目或章節不同）時整組不抽**，避免孤兒承上題。
 *
 * @param {'note'|'error'} [shortfallPolicy] 湊不滿 N 題時的政策，預設 FOLLOW_UP_SHORTFALL_POLICY
 * @returns {Promise<{error:{status:number,message:string}}|
 *                   {sortedQuestions:object[], finalSortedIds:number[], paperTitle:string, todayStr:string,
 *                    shortfall:{requested:number,actual:number,reason:'follow_up_group'}|null, note:string|null}>}
 */
async function selectPaperQuestions({ studentId, studentName, subject, chapter, limitCount, excludeIds = [], sourceTypes = null,
    shortfallPolicy = FOLLOW_UP_SHORTFALL_POLICY }) {
    // 候選池：同學科同章、未封存、該生沒寫過、且不在排除清單內；
    // sourceTypes（0006 題源過濾）為 null 時不限制——助教工具與既有呼叫端行為不變
    const { rows: candidates } = await query(
        `SELECT q.id, q.variant_of, q.follows_question_id FROM questions q
          WHERE q.subject = $1 AND q.chapter = $2 AND q.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $3)
            AND NOT (q.id = ANY($4::int[]))
            AND ($5::text[] IS NULL OR q.source_type = ANY($5::text[]))`,
        [subject, chapter, studentId, excludeIds, sourceTypes]
    );

    // 候選題所在承上組的完整成員（含不在候選池的題，用來判斷整組是否可用）。
    // 無向走訪 follows_question_id：往下找承上題、往上找前題；UNION 去重，資料有環也會停。
    // 只回有綁定關係的列——沒有綁定的候選題已在 candidates 裡。
    let related = [];
    if (candidates.length > 0) {
        ({ rows: related } = await query(
            `WITH RECURSIVE grp(id) AS (
                 SELECT unnest($1::int[])
                 UNION
                 SELECT CASE WHEN q.id = g.id THEN q.follows_question_id ELSE q.id END
                   FROM questions q JOIN grp g
                     ON q.follows_question_id = g.id
                     OR (q.id = g.id AND q.follows_question_id IS NOT NULL)
             )
             SELECT q.id, q.follows_question_id FROM questions q JOIN grp g ON g.id = q.id
              WHERE q.follows_question_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM questions c WHERE c.follows_question_id = q.id)`,
            [candidates.map(c => c.id)]
        ));
    }

    // 家族互斥：同一 variant_of 家族在同一張卷只取一題（規劃 §4.1）。
    // pickPaperUnits 內部走 pickOnePerFamily（每組洗牌取代表 → 對代表 Fisher-Yates），單位是承上組。
    // 「庫存不足」檢查在家族互斥**之後**（裁決 S3-6），${n} 代入家族互斥後可用的題數（無綁定時＝家族數）。
    const picked = pickPaperUnits({ candidates, related, limitCount });
    if (picked.availableCount < limitCount) {
        return { error: { status: 400, message: `新題目庫存不足！該章節 [${studentName}] 沒寫過的題目僅剩 ${picked.availableCount} 題。` } };
    }

    // 庫存夠、但承上題組塞不進剩下的名額 → 依政策少出題並附註，或回 400
    let shortfall = null;
    let note = null;
    if (picked.actual < limitCount) {
        if (picked.actual === 0) {
            return { error: { status: 400, message: `承上題須與前題整組出題，可用的題組每組至少 ${picked.minUnitSize} 題，無法湊出 ${limitCount} 題，請調高題數。` } };
        }
        if (shortfallPolicy === 'error') {
            return { error: { status: 400, message: `承上題須與前題整組出題，無法剛好湊滿 ${limitCount} 題（最多可出 ${picked.actual} 題），請調整題數。` } };
        }
        shortfall = { requested: limitCount, actual: picked.actual, reason: 'follow_up_group' };
        note = `承上題須與前題整組出題，無法剛好湊滿 ${limitCount} 題，本卷實際 ${picked.actual} 題。`;
    }

    const { rows: fullQuestions } = await query(
        `SELECT id, question_text, question_type, difficulty, answer_text, source_type, source_detail, follows_question_id
           FROM questions WHERE id = ANY($1::int[])`,
        [picked.ids]
    );
    const sortedQuestions = sortForPaper(fullQuestions);
    const finalSortedIds = sortedQuestions.map(q => q.id);
    const { titleDate, todayStr } = localDates();
    return { sortedQuestions, finalSortedIds, paperTitle: `${studentName}-${chapter}特訓卷(${titleDate})`, todayStr, shortfall, note };
}
// 給助教工具（services/assistantService.js）內部共用，不是路由
exports.selectPaperQuestions = selectPaperQuestions;
exports.FOLLOW_UP_SHORTFALL_POLICY = FOLLOW_UP_SHORTFALL_POLICY;
exports.resolveStudentInternal = resolveStudent;

exports.generatePaper = async (req, res, next) => {
    const { student_id, student_name, subject, chapter, count, dry_run, exclude_ids, source_types } = req.body;

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

    // 題源過濾（0006）：選用；空陣列視為不限制，非法值直接 400（打錯字靜默放行會讓過濾形同虛設）
    let sourceTypes = null;
    if (source_types !== undefined && source_types !== null) {
        const { isValidSourceType } = require('../config/chapters');
        if (!Array.isArray(source_types) || source_types.some(v => !isValidSourceType(v))) {
            return res.status(400).json({ message: 'source_types 必須是合法題源標記的陣列。' });
        }
        if (source_types.length > 0) sourceTypes = [...new Set(source_types)];
    }

    try {
        const { student, error } = await resolveStudent({ student_id, student_name });
        if (error) return res.status(error.status).json({ message: error.message });

        const picked = await selectPaperQuestions({
            studentId: student.id, studentName: student.name, subject, chapter, limitCount, excludeIds, sourceTypes
        });
        if (picked.error) return res.status(picked.error.status).json({ message: picked.error.message });
        const { sortedQuestions, finalSortedIds, paperTitle, todayStr } = picked;
        // 少出題附註（FR-019 PR2）：只在真的少出時才帶 shortfall／note 兩鍵，其餘回應形狀不變
        const shortfallKeys = picked.shortfall ? { shortfall: picked.shortfall, note: picked.note } : {};

        // ── dry_run：到此為止，一個位元組都沒寫（W1-2 的「草稿」）──
        if (dry_run) {
            return res.status(200).json({
                dry_run: true,
                message: '預覽（尚未寫入）：確認後才會建卷並記入作答歷史。',
                student_id: student.id,
                paper_title_preview: paperTitle,
                question_ids: finalSortedIds,
                questions: sortedQuestions,
                ...shortfallKeys
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
            questions: sortedQuestions,
            ...shortfallKeys
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
// POST /api/confirm-paper（W1-2 的「確認」；docs/roadmap-plan.md §6.2.3）
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
            `SELECT id, chapter, question_text, question_type, difficulty, answer_text, follows_question_id
               FROM questions WHERE id = ANY($1::int[]) AND archived_at IS NULL`,
            [question_ids]
        );
        if (fullQuestions.length !== question_ids.length) {
            return res.status(400).json({ message: '部分題目已不存在或已封存，請重新預覽。' });
        }

        // 承上題組依承接順序相鄰（與預覽同一個排序函式）。這裡不重驗組是否完整：
        // 題目就是預覽整組抽出的那批；呼叫端自行拼湊 question_ids 時照給的題出卷。
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
