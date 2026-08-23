const { pool } = require('../config/db');
const { pickOnePerFamily } = require('../utils/pickOnePerFamily');

const MAX_QUESTIONS = 50; // 單次抽題上限，避免一次撈整章

// ─────────────────────────────────────────────────────────────
// 智慧組卷（D-D4 重寫）
//
// 舊版把整章的 history_json 撈回 Node 逐列 JSON.parse 過濾，寫回時每題一條 JSON_SET。
// 新版全部交給資料庫：
//   候選池   NOT EXISTS (SELECT 1 FROM attempts …)（不是 NOT IN，NULL 語意才不會咬人）
//   學生     INSERT … ON CONFLICT (name) DO UPDATE … RETURNING id（要 DO UPDATE 才拿得到 id）
//   作答紀錄 一條 INSERT … SELECT unnest(…) ON CONFLICT DO NOTHING
//
// UNIQUE (student_id, question_id) 是伺服器端的硬閘門：兩個請求同時抽到同一題時，
// 後者的 rowCount 會少於題數，此時整筆交易回滾並回 409，而不是悄悄少記一題。
//
// 姓名只做 trim：新設計不再需要削掉 " 與 \（那是 JSON 路徑的限制），
// students.name 直接存 trimmedName，訊息裡也一律用 trimmedName。
// ─────────────────────────────────────────────────────────────
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

    const trimmedName = String(student_name).trim();
    if (!trimmedName) {
        return res.status(400).json({ message: "學生姓名無效！" });
    }

    const client = await pool.connect();
    try {
        // 整段（建學生 → 選候選 → 建卷 → 寫 attempts）在同一個交易內：
        // 任何一步失敗都不該留下半張卷或一個沒用到的學生列。
        await client.query('BEGIN');

        // ON CONFLICT 必須是 DO UPDATE 才會走 RETURNING（DO NOTHING 在衝突時回 0 列）
        const { rows: [student] } = await client.query(
            `INSERT INTO students (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [trimmedName]
        );

        // 候選池：同學科同章、未封存、且該生沒寫過
        // 階段 3 只多撈一欄 variant_of（interfaces-stage3.md 第 2.2 條），其餘條件不變。
        const { rows: candidates } = await client.query(
            `SELECT q.id, q.variant_of FROM questions q
              WHERE q.subject = $1 AND q.chapter = $2 AND q.archived_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $3)`,
            [subject, chapter, student.id]
        );

        // 家族互斥：同一 variant_of 家族在同一張卷只取一題（規劃 §4.1）。
        // pickOnePerFamily 內部已經做完「每組洗牌取代表 → 對代表 Fisher-Yates」，
        // 所以這裡不再另外呼叫 shuffle——重複洗牌不會更隨機，只會多一層看不懂的間接。
        //
        // ⚠️ 抽題的公平性單位因此從「每題等機率」變成「**每家族等機率**」
        //    （見 utils/pickOnePerFamily.js 的檔頭與 test/unit/pickOnePerFamily.test.js）。
        const familyPicked = pickOnePerFamily(candidates);

        // 「庫存不足」的檢查移到家族互斥**之後**（裁決 S3-6）：
        // 先檢查再收斂會讓「通過檢查卻抽不滿」——候選池有 8 題但全屬同一家族時，
        // 舊順序會放行然後只抽得到 1 題。${n} 因此代入**家族數**（實際抽得到的題數）。
        // 訊息格式與 interfaces.md 第 7 條完全相同，一個字都不改。
        if (familyPicked.length < limitCount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `新題目庫存不足！該章節 [${trimmedName}] 沒寫過的題目僅剩 ${familyPicked.length} 題。` });
        }

        const rawSelectedIds = familyPicked.slice(0, limitCount).map(q => q.id);

        const { rows: fullQuestions } = await client.query(
            `SELECT id, question_text, question_type, difficulty, answer_text
               FROM questions WHERE id = ANY($1::int[])`,
            [rawSelectedIds]
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
        // 用本地時區組日期（與試卷標題一致）；toISOString() 是 UTC，台灣早上 8 點前會差一天
        const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const { rows: [paper] } = await client.query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
            [paperTitle, student.id, finalSortedIds]
        );

        const ins = await client.query(
            `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at)
             SELECT $1::int, x, $3::int, $4::date FROM unnest($2::int[]) AS x
             ON CONFLICT (student_id, question_id) DO NOTHING`,
            [student.id, finalSortedIds, paper.id, todayStr]
        );

        // 寫入筆數少於題數 ⇒ 有題目在我們選完之後被別的請求指派給同一位學生了
        if (ins.rowCount !== finalSortedIds.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: '部分題目已被同時指派給該學生，請重試。' });
        }

        await client.query('COMMIT');

        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_id: paper.id,
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 回滾失敗不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};
