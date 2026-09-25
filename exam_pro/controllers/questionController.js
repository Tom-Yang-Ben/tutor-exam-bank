const { query, pool } = require('../config/db');
const { CHAPTERS, isValidSubject, isValidChapter, isValidQuestionType, isValidSourceType, normalizeSourceDetail, normalizeDifficulty, QUESTION_TYPES, SOURCE_DETAIL_MAX, subjectChoiceText } = require('../config/chapters');
const { parseBool } = require('../config/features');

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

/**
 * 〔stage5 審查修正 S5-42〕題目改科或改章之後，清掉已經不適用的知識點標註（與題目 UPDATE 同一筆交易）。
 *
 *   - 改科：與新科目不同科的標註全部刪（含 human）。「知識點必須與題目同科」是 PUT /kcs 守的不變量，
 *     留著的話知識點弱點、補救卷與 AI 家教都會拿別科的知識點來算這一題。
 *   - 改科或改章：src = 'ai' 的標註全部刪。AI 是從**舊章**的知識點清單裡挑的，換章之後多半不對；
 *     刪光之後這題沒有標註，下次 npm run kc:backfill 會依新章節重標。
 *   - 同科改章時 human 的標註保留：PUT /kcs 本來就允許標到同科別章的知識點，那是老師自己的判斷。
 *
 * @param {{query:Function}} client 交易中的連線
 * @param {number} id
 * @param {{subject:string, chapter:string}} prev 改動前的科目與章節
 * @param {{subject:string, chapter:string}} next 改動後的科目與章節
 * @returns {Promise<number>} 刪掉的標註數
 */
async function pruneQuestionKcsAfterMove(client, id, prev, next) {
    const subjectChanged = prev.subject !== next.subject;
    const chapterChanged = prev.chapter !== next.chapter;
    if (!subjectChanged && !chapterChanged) return 0;
    const { rowCount } = await client.query(
        `DELETE FROM question_kcs qk
          USING knowledge_components kc
          WHERE qk.question_id = $1 AND kc.id = qk.kc_id
            AND (qk.src = 'ai' OR kc.subject <> $2)`,
        [id, next.subject]);
    return rowCount || 0;
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

// ─────────────────────────────────────────────────────────────
// 文字詳解（階段 5 WS-A；docs/interfaces-stage5.md 第 4.1 條第 5 項；DEC-017、缺口 G05）
//
// questions.solution_text／solution_src（migrations/0011）兩欄同 NULL 或同非 NULL：
//   verify   管線驗答時獨立解出、且與答案比對一致的 steps_summary（save 節點或回填腳本寫入）
//   teacher  老師在這裡（POST／PUT）寫入或修改
//   ai       保留給之後的 AI 另外生成
// 老師送的 solution_text 與現值**逐字相同**時保留原來源——在編輯視窗改了別的欄位按儲存，
// 不該讓一段 AI 產生的詳解被標成「老師寫的」。
// ─────────────────────────────────────────────────────────────

/** 詳解字數上限（migrations/0011 的 CHECK）。 */
const SOLUTION_MAX_LEN = 4000;

/**
 * 驗證並正規化 body.solution_text。trim 後空字串視為 null（清空）。
 * 字數以 code point 計，與 PG 的 char_length 同一把尺。
 *
 * @param {any} raw
 * @returns {{ ok:true, value:string|null } | { ok:false, error:string }}
 */
function normalizeSolutionText(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, error: '詳解必須是文字或 null。' };
    const v = raw.trim();
    if (v === '') return { ok: true, value: null };
    if ([...v].length > SOLUTION_MAX_LEN) return { ok: false, error: `詳解最多 ${SOLUTION_MAX_LEN} 字。` };
    return { ok: true, value: v };
}

// 共用：驗證並正規化題目欄位（手動新增與編輯共用）
// A-T12 起管線的 save 節點與 POST /api/review/:jqId/approve 也要跑同一道閘門，
// 因此本函式已搬到 utils/questionValidation.js，這裡只留 require（行為完全不變）。
const { validateQuestionFields } = require('../utils/questionValidation');

exports.createQuestion = async (req, res, next) => {
    const { subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img } = req.body;
    // 題源標記（0006）：未帶或非法值一律落 'unknown'，不擋錄入——它是管理標記，不是內容閘門
    const sourceType = isValidSourceType(req.body.source_type) ? req.body.source_type : 'unknown';
    // 來源註記（0007）：超長是唯一會擋的情況（默默截斷會騙人）
    const sourceDetail = normalizeSourceDetail(req.body.source_detail);
    if (sourceDetail === undefined) {
        return res.status(400).json({ message: `來源註記最多 ${SOURCE_DETAIL_MAX} 字。` });
    }
    // 〔stage5 WS-A〕文字詳解（可選）：老師寫入 → solution_src='teacher'；沒送或空白 → 兩欄 NULL
    const solution = normalizeSolutionText(req.body.solution_text);
    if (!solution.ok) return res.status(400).json({ message: solution.error });
    if (!subject || !chapter || !question_text || !answer_text) {
        return res.status(400).json({ message: '學科、章節、題目內容與答案皆為必填欄位！' });
    }
    if (!isValidSubject(subject)) {
        return res.status(400).json({ message: `學科僅能為${subjectChoiceText()}！` });   // 〔stage5 WS-B〕
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
                         origin, chapter_src, source_type, source_detail, search_tsv, solution_text, solution_src)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'human', $9, $10,
                             setweight(to_tsvector('simple', array_to_string($11::text[], ' ')), 'A')
                          || setweight(to_tsvector('simple', array_to_string($12::text[], ' ')), 'A')
                          || setweight(to_tsvector('simple', array_to_string($13::text[], ' ')), 'B'),
                             $14, $15)
                     RETURNING id`;
        const { rows } = await query(sql, [
            row.subject, row.chapter, row.question_type, row.difficulty, row.question_text,
            question_img || null, answer_text.trim(), solution_img || null, sourceType, sourceDetail,
            chapterTokens, keywordTokens, stemTokens,
            solution.value, solution.value === null ? null : 'teacher'
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
    const cols = { subject: [], chapter: [], question_type: [], difficulty: [], question_text: [], answer_text: [], source_type: [], source_detail: [], question_img: [] };
    // 〔Owner 決策單 2026-09-25 B21〕/analyze-pdf 補裁附圖後，每題可能多帶一個 question_img（/figures/<檔名>），
    // 入庫到管線同一個欄位（docs/figures.md「舊流程 /analyze-pdf 的附圖」）。只收附圖目錄內的本機路徑
    // （與 Word 匯出同一個判斷 resolveFigurePath）；其他值照補裁圖之前的行為忽略、落 NULL，不整題退回。
    const { resolveFigurePath } = require('../services/wordService');
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
        cols.source_type.push(isValidSourceType(q.source_type) ? q.source_type : 'unknown');
        // 註記超長在此路徑不整題退回（值來自上傳區單一欄位、UI 已限長）；落 NULL 而非截斷
        cols.source_detail.push(normalizeSourceDetail(q.source_detail) ?? null);
        cols.question_img.push(resolveFigurePath(q.question_img) ? q.question_img.trim() : null);
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
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, source_type, source_detail, question_img)
                     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])`;
        await query(sql, [cols.subject, cols.chapter, cols.question_type, cols.difficulty, cols.question_text, cols.answer_text, cols.source_type, cols.source_detail, cols.question_img]);
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
        const { subject, chapter, question_type, q, source_type } = req.query;
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
        if (source_type && isValidSourceType(source_type)) { params.push(source_type); where.push(`source_type = ${ph()}`); }
        // PG 的 LIKE 區分大小寫，改用 ILIKE 才與舊 MySQL（預設 ci collation）的行為一致
        if (q) { params.push('%' + q + '%'); where.push(`(question_text ILIKE ${ph()} OR answer_text ILIKE ${ph()})`); }
        const whereSql = 'WHERE ' + where.join(' AND ');

        // COUNT(*) 的型別是 INT8：沒有 config/db.js 的 setTypeParser(20)，total 會變成字串 "30"
        const { rows: countRows } = await query(`SELECT COUNT(*) AS total FROM questions ${whereSql}`, params);
        const total = countRows[0].total;

        const { rows } = await query(
            `SELECT id, subject, chapter, question_type, difficulty, question_text, question_img, answer_text, source_type, source_detail, created_at,
                    follows_question_id, solution_text, solution_src,
                    EXISTS (SELECT 1 FROM questions c
                             WHERE c.follows_question_id = questions.id AND c.archived_at IS NULL) AS has_follow_ups
             FROM questions ${whereSql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json({ total, page, limit, totalPages: Math.ceil(total / limit) || 1, questions: rows });
    } catch (err) { next(err); }
};

// 〔stage5 WS-A〕單題詳情：GET /api/questions/:id（第 4.1 條第 5 項的「題目詳情」）
//
// 與列表不同，**已封存的題也查得到**（回 archived_at）：試卷明細、批改卡與 AI 家教拿到的題號
// 可能指向事後被封存的題，那一題的內容與詳解仍然要讀得到（裁決 S3-2 的同一條線）。
exports.getQuestion = async (req, res, next) => {
    const raw = String(req.params.id ?? '').trim();
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1 || String(id) !== raw) {
        return res.status(400).json({ message: '無效的題目 ID' });
    }
    // 〔stage5 審查修正〕格式正確但超過 int4 上限：不可能存在的題，回 404（交給 PG 會是 out of range 的 500）
    if (id > INT4_MAX) return res.status(404).json({ message: '找不到該題目' });
    try {
        const { rows } = await query(
            `SELECT id, subject, chapter, question_type, difficulty, question_text, question_img, answer_text,
                    solution_text, solution_src, source_type, source_detail, origin, chapter_src,
                    variant_of, follows_question_id, created_at, archived_at
               FROM questions WHERE id = $1`,
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ message: '找不到該題目' });
        res.status(200).json(rows[0]);
    } catch (err) { next(err); }
};

// 更新單一題目
exports.updateQuestion = async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });
    if (id < 1 || id > INT4_MAX) return res.status(404).json({ message: '找不到該題目' });
    const v = validateQuestionFields(req.body);
    if (!v.ok) return res.status(400).json({ message: v.error });
    // 來源註記（0007）：COALESCE 分不出「沒帶」與「清空」，因此帶欄位與否用 $9 布林傳；
    // 帶了空字串＝清成 NULL（使用者在編輯視窗刪光註記就是要清掉）。
    // 驗證必須在 pool.connect / BEGIN 之前——交易內 return 會把開著交易的連線還回 pool。
    const hasDetail = Object.prototype.hasOwnProperty.call(req.body, 'source_detail');
    const sourceDetail = normalizeSourceDetail(req.body.source_detail);
    if (hasDetail && sourceDetail === undefined) {
        return res.status(400).json({ message: `來源註記最多 ${SOURCE_DETAIL_MAX} 字。` });
    }
    // 〔stage5 WS-A〕文字詳解：沒帶這個鍵＝不動（舊前端與其他呼叫端不受影響）；帶 null 或空白＝清空
    const hasSolution = Object.prototype.hasOwnProperty.call(req.body, 'solution_text');
    const solution = normalizeSolutionText(hasSolution ? req.body.solution_text : null);
    if (hasSolution && !solution.ok) return res.status(400).json({ message: solution.error });
    const client = await pool.connect();
    try {
        const { subject, chapter, question_type, difficulty, question_text, answer_text } = v.value;
        await client.query('BEGIN');

        // 〔stage5 審查修正 S5-42〕先鎖列讀舊的科目與章節：改科／改章時要一併處理知識點標註（見下方）。
        // 與 PUT /api/questions/:id/kcs、自動標註用同一把鎖（題目列 FOR UPDATE），三者排隊寫。
        const { rows: before } = await client.query(
            'SELECT subject, chapter FROM questions WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]);
        if (before.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該題目' });
        }

        // UPDATE 的 SET 運算式一律看**舊值**，所以兩個 CASE 裡的 chapter 與五個比較欄
        // 都是改動前的內容：
        //   chapter_src  老師手動改過章節 ⇒ 章節來源不再是 AI，標記 'human'（規劃 §4.3.1）
        //   embed_hash   embed_text 的來源欄位有變 ⇒ 設 NULL，讓 backfill 的 --missing-only
        //                一定撿得到（interfaces-stage1.md 12.4）。embedding 刻意留著不清空，
        //                否則向量補上之前這題會直接從 /similar 消失。
        //   solution_*   〔stage5 整合〕沒帶 solution_text、現有詳解來源是 verify，而題幹或答案真的改了
        //                ⇒ 兩欄一併清成 NULL：那份驗算摘要解的是改之前的題目（與回填腳本略過 edited
        //                同一個理由，docs/grading-and-profile.md 第 3.6 條）。老師寫的（teacher）不動。
        //   solution_cleared_at 〔stage5 審查修正 S5-41〕老師明確清空**既有**詳解 ⇒ 記下時間，回填腳本
        //                看到就不再把驗算摘要寫回來；老師又寫了新詳解 ⇒ 清回 NULL。上一點的自動清空不記
        //                （回填會以「入庫後被改過」略過那一題）。
        // 題源標記（0006）：body 有帶合法值才更新，沒帶維持原值（COALESCE(NULL, …)）
        const sourceType = isValidSourceType(req.body.source_type) ? req.body.source_type : null;
        const { rows } = await client.query(
            `UPDATE questions
                SET subject=$1, chapter=$2, question_type=$3, difficulty=$4, question_text=$5, answer_text=$6,
                    source_type = COALESCE($8, source_type),
                    source_detail = CASE WHEN $9 THEN $10 ELSE source_detail END,
                    solution_text = CASE WHEN $11 THEN $12::text
                                         WHEN solution_src = 'verify'
                                              AND (question_text, answer_text) IS DISTINCT FROM ($5, $6) THEN NULL
                                         ELSE solution_text END,
                    solution_src  = CASE WHEN NOT $11 AND solution_src = 'verify'
                                              AND (question_text, answer_text) IS DISTINCT FROM ($5, $6) THEN NULL
                                         WHEN NOT $11 THEN solution_src
                                         WHEN $12::text IS NULL THEN NULL
                                         WHEN $12::text = solution_text THEN solution_src
                                         ELSE 'teacher' END,
                    solution_cleared_at = CASE WHEN $11 AND $12::text IS NULL AND solution_text IS NOT NULL THEN now()
                                               WHEN $11 AND $12::text IS NOT NULL THEN NULL
                                               ELSE solution_cleared_at END,
                    chapter_src = CASE WHEN chapter IS DISTINCT FROM $2 THEN 'human' ELSE chapter_src END,
                    embed_hash  = CASE WHEN (subject, chapter, question_type, difficulty, question_text)
                                       IS DISTINCT FROM ($1, $2, $3, $4::smallint, $5)
                                  THEN NULL ELSE embed_hash END
              WHERE id=$7 AND archived_at IS NULL
          RETURNING id, subject, chapter, question_type, difficulty, question_text, keywords, concept_summary`,
            [subject, chapter, question_type, difficulty, question_text, answer_text || '略', id, sourceType, hasDetail, sourceDetail,
                hasSolution, hasSolution ? solution.value : null]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該題目' });
        }

        // 用 RETURNING 回來的權威值重算 search_tsv（keywords／concept_summary 只有 DB 知道），
        // 與題目本體同一筆交易：不會出現「內容已改、tsv 還是舊的」的中間狀態。
        await writeSearchTsv(client, rows[0]);
        const kcsRemoved = await pruneQuestionKcsAfterMove(client, id, before[0], { subject, chapter });
        await client.query('COMMIT');

        res.json({ message: '題目已更新！', id, ...(kcsRemoved > 0 ? { kcs_removed: kcsRemoved } : {}) });
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
//
// 承上題保護（FR-019 PR3）：
//   - 帶 ?group=1 → deleteQuestionGroup：此題與其後所有承上題（多層鏈）整組處理，單一交易。
//   - 未帶 group 而此題仍有**在庫**（未封存）的承上題：鎖列後先查、硬刪與封存都預先擋下，
//     回同一個 409（列出承上題）；只剩已封存的承上題時才由 FK 擋硬刪（同形狀 409）。封存也擋，是因為單封前題會讓承上題在題庫與組卷裡
//     失去前情——與硬刪要防的是同一件事；要一起收掉就改帶 ?group=1。
exports.deleteQuestion = async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: '無效的題目 ID' });
    if (id < 1 || id > INT4_MAX) return res.status(404).json({ message: '找不到該題目' });
    if (parseBool(req.query.group)) return deleteQuestionGroup(id, res, next);

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

        // 在庫承上題先查、硬刪與封存都擋：不能只靠 FK 錯誤判斷——匯入任務產生的前題同時被
        // job_questions 參照，PG 依觸發器建立順序先檢查 0003 的 FK，會回「請改用封存」而漏掉 children。
        // 前題的 FOR UPDATE 已與「新綁一個承上題」（FK 檢查取 FOR KEY SHARE）互斥，這裡讀到的清單不會過期。
        const { rows: kids } = await client.query(
            'SELECT id FROM questions WHERE follows_question_id = $1 AND archived_at IS NULL ORDER BY id', [id]);
        if (kids.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json(followUpConflictBody(kids.map(r => r.id)));
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
        // 23503 foreign_key_violation：交易已回滾，再以一般連線查資料、回 409（以前直接落到 500）
        if (err.code === FOREIGN_KEY_VIOLATION && err.constraint === 'questions_follows_question_id_fkey') {
            // FR-019：此題是承上題的前題（0008 的 FK 為 NO ACTION，於 DELETE 語句結束時擋下）
            try {
                const { rows: kids } = await pool.query(
                    'SELECT id FROM questions WHERE follows_question_id = $1 ORDER BY id', [id]);
                return res.status(409).json(followUpConflictBody(kids.map(r => r.id)));
            } catch (e) { return next(e); }
        }
        if (err.code === FOREIGN_KEY_VIOLATION && err.constraint === 'job_questions_question_id_fkey') {
            // 管線／複核入庫的題被 job_questions.question_id 參照（0003 不設 ON DELETE）
            return res.status(409).json({ message: '此題由匯入任務產生，無法直接刪除，請改用封存。' });
        }
        if (err.code === FOREIGN_KEY_VIOLATION && err.constraint === 'jobs_source_question_id_fkey') {
            // 變式 job 的藍本（jobs.source_question_id，0003 不設 ON DELETE；2026-09-16 前此情境直接落 500）
            try {
                const { rows: jobs } = await pool.query(
                    'SELECT id FROM jobs WHERE source_question_id = $1 ORDER BY id', [id]);
                return res.status(409).json({
                    message: '此題是變式題藍本，請改用封存。',
                    job_ids: jobs.map(r => Number(r.id))
                });
            } catch (e) { return next(e); }
        }
        next(err);
    } finally {
        client.release();
    }
};

/** PostgreSQL INT（int4）上限：questions.id 是 INT，超過的 id 不可能存在 */
const INT4_MAX = 2147483647;

/** PG foreign_key_violation */
const FOREIGN_KEY_VIOLATION = '23503';

/** 整組沿 follows_question_id 往後走的深度上限（linker 已擋成環，這裡只是保險） */
const GROUP_MAX_DEPTH = 20;

/** 刪除／封存被承接的前題時的 409 回應（訊息與 PR #28 逐字相同） */
function followUpConflictBody(children) {
    return {
        message: `此題是承上題 ${children.map(c => `#${c}`).join('、')} 的前題，請先刪除或解除綁定該承上題。`,
        children
    };
}

/**
 * DELETE /api/questions/:id?group=1：此題與其後所有承上題整組處理（單一交易）。
 *
 * - 組員＝此題（必須在庫）＋沿 follows_question_id 反查的所有後代，**含已封存的後代**：
 *   已封存的承上題仍以 FK 指著前題，不一起刪就硬刪不掉。只往後走、不往前走——
 *   從中間題開始時，它的前題本來就不缺前情，不必動。
 * - 組內任一題有 attempts、job_questions 或 jobs.source_question_id 引用 → 整組改封存
 *   （沿用「有作答紀錄改封存」的語意；已封存的組員維持原封存時間）。
 * - 否則一句 DELETE 刪整組（0008 的 FK 是 NO ACTION，同一句內前題與子題一起刪不會被擋）。
 *
 * 鎖：逐層「先鎖、再查下一層」，查到的組員不會漏掉並行新綁的承上題（見函式內註解）。
 * 仍撞 FK 的極端情況（例如深度超過上限）回 409 請使用者重試，不會刪出孤兒。
 */
async function deleteQuestionGroup(id, res, next) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'SELECT id FROM questions WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]);
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該題目' });
        }

        // 逐層走：每一層的題在 FOR UPDATE 鎖住之後才查它的承上題。新綁承上題的 FK 檢查要取前題的
        // FOR KEY SHARE，與 FOR UPDATE 互斥——所以某層鎖上之前已提交的綁定一定查得到，鎖上之後的
        // 綁定要等本交易結束。若先一次查完整棵樹再鎖，中間綁到較深組員的題會漏掉，封存分支又
        // 不會撞 FK，便留下缺前題的在庫承上題。
        const ids = [id];
        const seen = new Set(ids);
        let frontier = [id];
        for (let depth = 0; frontier.length > 0 && depth < GROUP_MAX_DEPTH; depth++) {
            const { rows: next } = await client.query(
                'SELECT id FROM questions WHERE follows_question_id = ANY($1::int[]) ORDER BY id FOR UPDATE', [frontier]);
            frontier = next.map(r => r.id).filter(v => !seen.has(v));
            for (const v of frontier) { seen.add(v); ids.push(v); }
        }

        const { rows: refs } = await client.query(
            `SELECT EXISTS (SELECT 1 FROM attempts      WHERE question_id        = ANY($1::int[]))
                 OR EXISTS (SELECT 1 FROM job_questions WHERE question_id        = ANY($1::int[]))
                 OR EXISTS (SELECT 1 FROM jobs          WHERE source_question_id = ANY($1::int[])) AS referenced`,
            [ids]);
        const list = ids.map(v => `#${v}`).join('、');

        if (refs[0].referenced) {
            await client.query(
                'UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[]) AND archived_at IS NULL', [ids]);
            await client.query('COMMIT');
            return res.json({
                message: `組內有題目已有作答紀錄或被匯入／變式任務引用，整組 ${ids.length} 題改為封存（${list}）。`,
                id, ids, archived: true
            });
        }

        await client.query('DELETE FROM questions WHERE id = ANY($1::int[])', [ids]);
        await client.query('COMMIT');
        res.json({ message: `已刪除整組 ${ids.length} 題（${list}）。`, id, ids, archived: false });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 回滾失敗不覆蓋原始錯誤 */ }
        if (err.code === FOREIGN_KEY_VIOLATION) {
            return res.status(409).json({ message: '整組處理期間題目關聯有變動，請重新整理後再試。' });
        }
        next(err);
    } finally {
        client.release();
    }
}

// 批次補標題源（0007）：對一批題目一次套用 source_type 與（或）source_detail。
// 為既有題庫的人工補標而生——同一份考卷的題先用篩選圈出來，再一次標完。
//
// 語意刻意保守：兩個欄位都是「帶了才改」，且 source_detail 空字串在這裡＝不改
// （批次「清空一批註記」不是補標情境；要清就到單題編輯清）。不動 search_tsv 與
// embedding——題源欄位不參與檢索文本。
const BATCH_SOURCE_MAX = 200;

exports.batchSourceTag = async (req, res, next) => {
    const { question_ids, source_type, source_detail } = req.body;
    if (!Array.isArray(question_ids) || question_ids.length === 0 || question_ids.length > BATCH_SOURCE_MAX ||
        question_ids.some(v => !Number.isInteger(v) || v < 1)) {
        return res.status(400).json({ message: `question_ids 必須是 1~${BATCH_SOURCE_MAX} 個正整數。` });
    }
    const hasType = source_type !== undefined && source_type !== null && source_type !== '';
    if (hasType && !isValidSourceType(source_type)) {
        return res.status(400).json({ message: '來源標記無效。' });
    }
    const detail = normalizeSourceDetail(source_detail);
    if (detail === undefined) {
        return res.status(400).json({ message: `來源註記最多 ${SOURCE_DETAIL_MAX} 字。` });
    }
    if (!hasType && detail === null) {
        return res.status(400).json({ message: '至少要提供來源標記或來源註記其中一項。' });
    }
    try {
        const ids = [...new Set(question_ids)];
        const { rows } = await query(
            `UPDATE questions
                SET source_type   = COALESCE($2, source_type),
                    source_detail = COALESCE($3, source_detail)
              WHERE id = ANY($1::int[]) AND archived_at IS NULL
          RETURNING id`,
            [ids, hasType ? source_type : null, detail]
        );
        res.json({ message: `已更新 ${rows.length} 題的題源標記。`, updated: rows.length });
    } catch (err) { next(err); }
};

// 〔stage5 WS-A〕給單元測試用（不對外掛成路由）
exports._internals = { normalizeSolutionText, SOLUTION_MAX_LEN };
