const { query, pool } = require('../config/db');
const { CHAPTERS, isValidSubject, isValidChapter, isValidQuestionType, normalizeDifficulty, QUESTION_TYPES } = require('../config/chapters');

// ─────────────────────────────────────────────────────────────
// 檢索欄位的同步（docs/interfaces-stage1.md 第 12.4 條）
//
// 新增／修改題目後必須讓 search_tsv 與 embedding 跟上，否則新題永遠檢索不到。
// 兩者的可靠度不同，所以拆成兩條路徑：
//
//   search_tsv  只需要 jieba，純 CPU、不需金鑰 → **同步寫**，與題目本體同一筆交易，
//               任何 EMBED_MODE 下都保證寫得進去。
//   embedding   需要 Gemini 或 fixture，可能失敗 → **fire-and-forget**，失敗只記 log；
//               同時在 UPDATE 時把 embed_hash 設成 NULL，讓 backfill_embeddings.js
//               的 --missing-only 一定撿得到（新增的題 embedding 本來就是 NULL）。
//
// embedService 走延遲 require：它會載入 jieba 詞典（約 2 秒），不該進 app 的開機路徑，
// 也不該讓不碰資料庫的單元測試被迫裝 @node-rs/jieba。
// ─────────────────────────────────────────────────────────────

// interfaces-stage1.md 第 2 條：不提供 toTsvSql()，寫入端自己組這段 SQL；
// 三段 token 一律由 embedService 匯出的純函式產生（裁決 21），不得自行 tokenize。
const SEARCH_TSV_ASSIGN = `search_tsv = setweight(to_tsvector('simple', array_to_string($2::text[], ' ')), 'A')
                                     || setweight(to_tsvector('simple', array_to_string($3::text[], ' ')), 'A')
                                     || setweight(to_tsvector('simple', array_to_string($4::text[], ' ')), 'B')`;

/** 依 row 的內容重算 search_tsv 並寫回；row 需含 id 與 buildEmbedText 用得到的欄位。 */
async function writeSearchTsv(executor, row) {
    const { buildTsvTokens } = require('../services/embedService');
    const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);
    await executor.query(`UPDATE questions SET ${SEARCH_TSV_ASSIGN} WHERE id = $1`,
        [row.id, chapterTokens, keywordTokens, stemTokens]);
}

/**
 * 非同步補上 embedding（不 await：向量是輔助欄位，失敗不該影響主要回應）。
 * EMBED_MODE=fixture 查不到向量、或沒有金鑰時都會走到這裡的 log，
 * 該題的 embed_hash 仍是 NULL，之後 npm run backfill 會補。
 */
function scheduleEmbed(id) {
    Promise.resolve()
        .then(() => require('../services/embedService').embedByIds([id]))
        .then((r) => {
            if (r.failed.length > 0) {
                console.warn(`[embed] 題目 ${id} 的向量待 backfill 補：${String(r.failed[0].error).split('\n')[0]}`);
            }
        })
        .catch((err) => {
            console.warn(`[embed] 題目 ${id} 的向量寫入失敗（不影響主要回應）：${String(err.message).split('\n')[0]}`);
        });
}

// 提供前端手動錄入時的章節下拉選單來源
exports.getChapterWhitelist = (req, res) => {
    res.json(CHAPTERS);
};

// 分冊結構（科 → 冊 → 章節；config/chapters.js 的 VOLUMES 是唯一真相）。
// 前端的「科目 → 冊 → 單元」三層選單用；/chapter-whitelist 的扁平形狀維持不動。
exports.getChapterVolumes = (req, res) => {
    res.json(require('../config/chapters').VOLUMES);
};

// 共用：驗證並正規化題目欄位（手動新增與編輯共用）
// A-T12 起管線的 save 節點與 POST /api/review/:jqId/approve 也要跑同一道閘門，
// 因此本函式已搬到 utils/questionValidation.js，這裡只留 require（行為完全不變）。
const { validateQuestionFields } = require('../utils/questionValidation');

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
        // 新題的 keywords / concept_summary 一定是 NULL，所以 search_tsv 的三段 token
        // 直接由這裡驗證過的欄位算得出來，可以與 INSERT 併成同一句（天然原子）。
        const { buildTsvTokens } = require('../services/embedService');
        const row = {
            subject, chapter: chapter.trim(), question_type: qType, difficulty: diff,
            question_text: question_text.trim(), keywords: null, concept_summary: null
        };
        const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);

        // 手動錄入 → origin='manual'、chapter_src='human'（規劃 §4.3.1 的來源標記規則）
        const sql = `INSERT INTO questions
                        (subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img,
                         origin, chapter_src, search_tsv)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'human',
                             setweight(to_tsvector('simple', array_to_string($9::text[],  ' ')), 'A')
                          || setweight(to_tsvector('simple', array_to_string($10::text[], ' ')), 'A')
                          || setweight(to_tsvector('simple', array_to_string($11::text[], ' ')), 'B'))
                     RETURNING id`;
        const { rows } = await query(sql, [
            row.subject, row.chapter, row.question_type, row.difficulty, row.question_text,
            question_img || null, answer_text.trim(), solution_img || null,
            chapterTokens, keywordTokens, stemTokens
        ]);
        res.status(201).json({ message: '題目錄入成功！', questionId: rows[0].id });
        // 回應送出後才補向量（interfaces-stage1.md 12.4）：embedding IS NULL 本來就會被 backfill 撿到
        scheduleEmbed(rows[0].id);
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
    // PG 沒有 mysql2 的 `VALUES ?`（二維陣列）批次語法，改成「每欄一個陣列參數」餵給 unnest，
    // 因此這裡以「欄」為單位收集，而不是以「列」為單位。
    const cols = { subject: [], chapter: [], question_type: [], difficulty: [], question_text: [], answer_text: [] };
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

        cols.subject.push(subject);
        cols.chapter.push(chapter);
        cols.question_type.push(qType);
        cols.difficulty.push(diff);
        cols.question_text.push(String(q.question_text).trim());
        cols.answer_text.push(q.answer_text || '略');
    });

    const savedCount = cols.subject.length;

    if (strict && rejected.length > 0) {
        const errors = rejected.map(r => `第 ${r.idx + 1} 題：${r.reason}`);
        return res.status(400).json({ message: `有 ${errors.length} 題未通過驗證，請重新分析：\n` + errors.join('\n') });
    }

    // 全軍覆沒時沒有任何一筆寫入，回 400 但維持同一個回應形狀
    if (savedCount === 0) {
        return res.status(400).json({
            message: `${rejected.length} 題全部未通過驗證，沒有任何題目寫入題庫。`,
            saved_count: 0,
            rejected
        });
    }

    try {
        // AI 拆題入庫：origin / chapter_src 走 DDL 預設（'pdf' / 'ai'）
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[])`;
        await query(sql, [cols.subject, cols.chapter, cols.question_type, cols.difficulty, cols.question_text, cols.answer_text]);
        const message = rejected.length === 0
            ? `🎉 成功！已將共 ${savedCount} 題自動錄入資料庫！`
            : `已寫入 ${savedCount} 題；另有 ${rejected.length} 題未通過驗證（已在下方標紅），修正後可再次送出。`;
        res.json({ message, saved_count: savedCount, rejected });
    } catch (err) { next(err); }
};

exports.getChapters = async (req, res, next) => {
    try {
        // PG 的雙引號是識別字引號，舊寫法 `chapter != ""` 會報 zero-length delimited identifier，必須改 <> ''
        const { rows } = await query(
            `SELECT DISTINCT subject, chapter FROM questions
              WHERE chapter IS NOT NULL AND chapter <> '' AND archived_at IS NULL`
        );
        res.json(rows);
    } catch (err) { next(err); }
};

// 題庫列表（支援篩選與分頁）。已封存（軟刪除）的題目不出現在列表中，與兩個 VIEW 的定義一致。
exports.listQuestions = async (req, res, next) => {
    try {
        const { subject, chapter, question_type, q } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const where = ['archived_at IS NULL'];
        const params = [];
        // PG 的占位符有序（$1、$2…），因此推進參數後才取得它的編號
        const ph = () => `$${params.length}`;
        if (subject) { params.push(subject); where.push(`subject = ${ph()}`); }
        if (chapter) { params.push(chapter); where.push(`chapter = ${ph()}`); }
        if (question_type) { params.push(question_type); where.push(`question_type = ${ph()}`); }
        // PG 的 LIKE 區分大小寫，改用 ILIKE 才與舊 MySQL（預設 ci collation）的行為一致
        if (q) { params.push('%' + q + '%'); where.push(`(question_text ILIKE ${ph()} OR answer_text ILIKE ${ph()})`); }
        const whereSql = 'WHERE ' + where.join(' AND ');

        // COUNT(*) 的型別是 INT8：沒有 config/db.js 的 setTypeParser(20)，total 會變成字串 "30"
        const { rows: countRows } = await query(`SELECT COUNT(*) AS total FROM questions ${whereSql}`, params);
        const total = countRows[0].total;

        const { rows } = await query(
            `SELECT id, subject, chapter, question_type, difficulty, question_text, question_img, answer_text, created_at
             FROM questions ${whereSql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
    const client = await pool.connect();
    try {
        const { subject, chapter, question_type, difficulty, question_text, answer_text } = v.value;
        await client.query('BEGIN');

        // UPDATE 的 SET 運算式一律看**舊值**，所以兩個 CASE 裡的 chapter 與五個比較欄
        // 都是改動前的內容：
        //   chapter_src  老師手動改過章節 ⇒ 章節來源不再是 AI，標記 'human'（規劃 §4.3.1）
        //   embed_hash   embed_text 的來源欄位有變 ⇒ 設 NULL，讓 backfill 的 --missing-only
        //                一定撿得到（interfaces-stage1.md 12.4）。embedding 刻意留著不清空，
        //                否則向量補上之前這題會直接從 /similar 消失。
        const { rows } = await client.query(
            `UPDATE questions
                SET subject=$1, chapter=$2, question_type=$3, difficulty=$4, question_text=$5, answer_text=$6,
                    chapter_src = CASE WHEN chapter IS DISTINCT FROM $2 THEN 'human' ELSE chapter_src END,
                    embed_hash  = CASE WHEN (subject, chapter, question_type, difficulty, question_text)
                                       IS DISTINCT FROM ($1, $2, $3, $4::smallint, $5)
                                  THEN NULL ELSE embed_hash END
              WHERE id=$7 AND archived_at IS NULL
          RETURNING id, subject, chapter, question_type, difficulty, question_text, keywords, concept_summary`,
            [subject, chapter, question_type, difficulty, question_text, answer_text || '略', id]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該題目' });
        }

        // 用 RETURNING 回來的權威值重算 search_tsv（keywords／concept_summary 只有 DB 知道），
        // 與題目本體同一筆交易：不會出現「內容已改、tsv 還是舊的」的中間狀態。
        await writeSearchTsv(client, rows[0]);
        await client.query('COMMIT');

        res.json({ message: '題目已更新！', id });
        scheduleEmbed(id);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 回滾失敗不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};

// 刪除單一題目
//
// attempts.question_id 是 ON DELETE RESTRICT（interfaces-stage1.md §1.5 裁決 1）：作答紀錄是階段 3
// 弱點面板的基底，不能隨題目消失。因此刪題語意改為
//   有 attempts 紀錄 → 軟刪除（archived_at = now()），回 { archived: true }
//   沒有紀錄        → 照舊硬刪
// 兩步之間先 SELECT … FOR UPDATE 鎖住該列：attempts 的外鍵插入會取 FOR KEY SHARE，與
// FOR UPDATE 互斥，因此不會出現「檢查時沒紀錄、硬刪前剛好被組卷寫進一筆」的競態。
exports.deleteQuestion = async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'SELECT id FROM questions WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該題目' });
        }

        const { rows: used } = await client.query('SELECT 1 FROM attempts WHERE question_id = $1 LIMIT 1', [id]);
        if (used.length > 0) {
            await client.query('UPDATE questions SET archived_at = now() WHERE id = $1', [id]);
            await client.query('COMMIT');
            return res.json({ message: '該題已有學生作答紀錄，改為封存（不再出現在題庫與組卷候選中）。', id, archived: true });
        }

        await client.query('DELETE FROM questions WHERE id = $1', [id]);
        await client.query('COMMIT');
        res.json({ message: '題目已刪除！', id });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 回滾失敗不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};
