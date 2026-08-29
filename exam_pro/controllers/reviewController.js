// ─────────────────────────────────────────────────────────────
// controllers/reviewController.js — 人工複核的四支 API（A-T12，擁有者：WS-A）
//
// 形狀與錯誤訊息**逐字**凍結於 docs/interfaces-stage2.md 第 6.4～6.6 條。
//
//   GET  /api/review?reason=&limit=      跨 job 的 needs_review 佇列（先進先審）
//   GET  /api/review/:jqId               完整 payload
//   POST /api/review/:jqId/approve       修正後入庫；**人也要過閘門**
//   POST /api/review/:jqId/reject        標記不採用
//
// 「人也要過閘門」是這一章的核心（第 6.6 條）：老師改完的欄位一樣要跑
// validateQuestionFields + formulaLint，公式仍有 error 時要嘛修、要嘛明示
// accept_plain_text 接受降級——不能因為是人送的就跳過。
// ─────────────────────────────────────────────────────────────
const { query, pool } = require('../config/db');
const { validateQuestionFields } = require('../utils/questionValidation');
const jobCtl = require('./jobController');

/** DDL（0003_jobs.sql）CHECK 的八個 review_reason，順序 = 介面第 2 條。 */
const REVIEW_REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch',
    'duplicate', 'budget_exceeded', 'provider_error', 'schema_invalid', 'awaiting_approval'];

const NOT_FOUND = '找不到該待複核題目';
const ALREADY_DONE = '該題目已處理完畢，不能重複複核。';

// WS-C 的兩支閘門零件已合入（S2-17／S2-18、第 4.1／4.4 條），改成直接 require：
// 早先那兩個 MODULE_NOT_FOUND 退路是「等 WS-C」的鷹架，現在留著只會變成
// 「模組不見時默默跳過必經閘門」的暗門，而第 6.6 條要的是「人也要過閘門」。
const { formulaLint } = require('../utils/formulaLint');
const { textHash } = require('../utils/normalizeStem');

/**
 * approve 入庫時的 text_hash（裁決 S2-23）。
 *
 * **對修正後的 question_text 重算**，不沿用 `payload.dedup0.text_hash`——
 * 人既然改過題幹，L0 去重的雜湊就該跟著變，否則下一份 PDF 會拿舊雜湊誤判重複。
 *
 * @param {string} questionText 已經過 validateQuestionFields 正規化的題幹
 * @returns {string|null} sha256(normalizeStem(text)) 的小寫 hex；正規化後為空回 null
 */
function computeTextHash(questionText) {
    return textHash(questionText);
}

/**
 * 變式題核准時的 `chapter_src`（interfaces-stage3.md 第 4.7 條、裁決 S3-12，**S3-R10 改寫**）。
 *
 * - 送出的 `chapter` 與機器判定的 `payload.classify.chapter` **不同** → `'human'`（人真的改過了）；
 * - **相同** → 依 `payload.classify.source` 映射，**與 `saveNode` 同一張表**
 *   （`gate`／`llm` → `'ai'`、`knn` → `'knn'`；第 5.2 條為準）。
 *
 * 為什麼變式題與 PDF 題不同（PDF 路徑一律 `'human'`，行為不變）：
 * `VARIANT_AUTO_APPROVE=false` 時**每一題**變式都會進複核，若照 PDF 路徑一律寫 `'human'`，
 * 等於老師按一次「核准」就替系統產生一批沒人逐題驗過的人工標籤——而第 5 條的 kNN 投票
 * 只信 `'human'`，那正是規劃 §4.4 要防的自我強化。
 * 這條規則與 `PUT /api/questions/:id` 既有的 `CASE WHEN chapter IS DISTINCT FROM …` 是同一套語意。
 *
 * S3-R10 之前這一格一律寫 `'ai'`，於是「kNN 短路決定、人看過沒改」的題在庫裡與
 * 「LLM 決定的」混在一起，報表分不出來；改成查同一張表就一致了。
 *
 * @param {object} payload    job_questions.payload
 * @param {string} submitted  老師送出的章節（已過 validateQuestionFields 正規化）
 * @returns {'ai'|'human'|'knn'}
 */
function variantChapterSrc(payload, submitted) {
    const machine = payload?.classify?.chapter ?? payload?.extract?.chapter ?? null;
    if (machine === null || submitted !== machine) return 'human';
    return payload?.classify?.source === 'knn' ? 'knn' : 'ai';
}

// ─────────────────────── 6.4 GET /api/review ───────────────────────

exports.listReview = async (req, res, next) => {
    const reason = req.query.reason;
    if (reason !== undefined && !REVIEW_REASONS.includes(String(reason))) {
        return res.status(400).json({ message: 'reason 不在合法的複核原因清單內。' });
    }
    const paging = jobCtl.parsePaging({ limit: req.query.limit }, { defaultLimit: 50, maxLimit: 200 });
    if (paging.error) return res.status(400).json({ message: paging.error });

    try {
        const params = [paging.limit];
        let where = `state = 'needs_review'`;
        if (reason !== undefined) { params.push(String(reason)); where += ` AND review_reason = $${params.length}`; }

        const { rows } = await query(
            `SELECT id AS jq_id, job_id, idx, state, review_reason, payload, question_id
               FROM job_questions WHERE ${where} ORDER BY id ASC LIMIT $1`, params);

        res.json({
            items: rows.map(r => ({
                jq_id: r.jq_id, job_id: r.job_id, idx: r.idx, state: r.state,
                review_reason: r.review_reason, stem_preview: jobCtl.stemPreview(r.payload),
                question_id: r.question_id
            }))
        });
    } catch (err) { next(err); }
};

// ───────────────────── 6.5 GET /api/review/:jqId ─────────────────────

exports.getReviewItem = async (req, res, next) => {
    const id = jobCtl.parseId(req.params.jqId);
    if (id === null) return res.status(404).json({ message: NOT_FOUND });
    try {
        const { rows } = await query(
            `SELECT id AS jq_id, job_id, idx, state, review_reason, retries, payload,
                    question_id, created_at, updated_at
               FROM job_questions WHERE id = $1`, [id]);
        if (rows.length === 0) return res.status(404).json({ message: NOT_FOUND });
        res.json(rows[0]);
    } catch (err) { next(err); }
};

// ────────────────── 6.6 POST /api/review/:jqId/approve ──────────────────

exports.approve = async (req, res, next) => {
    const startedAt = Date.now();
    const id = jobCtl.parseId(req.params.jqId);
    if (id === null) return res.status(404).json({ message: NOT_FOUND });

    const body = req.body || {};
    const acceptPlainText = body.accept_plain_text === true;
    const mergeInto = body.merge_into === undefined || body.merge_into === null ? null : Number(body.merge_into);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // 階段 3（interfaces-stage3.md 第 4.7 條）：多撈一欄 j.kind——變式題與拆題共用
        // 同一條複核佇列，但入庫的 origin／variant_of／chapter_src 三欄不同。
        // FOR UPDATE 只鎖 job_questions（jobs 不需要鎖，這裡只讀它的 kind）。
        const { rows } = await client.query(
            `SELECT q.id, q.job_id, q.state, q.payload, j.kind, j.source_type, j.source_detail
               FROM job_questions q JOIN jobs j ON j.id = q.job_id
              WHERE q.id = $1 FOR UPDATE OF q`, [id]);
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: NOT_FOUND });
        }
        const jq = rows[0];
        if (jq.state === 'saved' || jq.state === 'rejected') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: ALREADY_DONE });
        }

        // ── 閘門一：欄位驗證（與手動錄入完全同一支）──
        const v = validateQuestionFields(body);
        if (!v.ok) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: '欄位驗證失敗', errors: v.errors });
        }

        // ── 閘門二：公式（accept_plain_text 才放行降級）──
        if (!acceptPlainText) {
            const lint = formulaLint(`${v.value.question_text}\n${v.value.answer_text}`);
            if (!lint.ok) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: '公式仍有無法解析的問題，請修正後再送出，或勾選「接受純文字降級」。',
                    errors: lint.issues.filter(i => i.sev === 'error')
                });
            }
        }

        // ── merge_into：不入新題，只把這一列標成已處理並指向既有題目 ──
        if (mergeInto !== null) {
            const { rows: target } = await client.query(
                'SELECT id FROM questions WHERE id = $1 AND archived_at IS NULL', [mergeInto]);
            if (target.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'merge_into 指向的題目不存在。' });
            }
            const payload = {
                ...(jq.payload || {}),
                dedup1: { ...(jq.payload?.dedup1 || {}), verdict: 'variant', merge_into: mergeInto }
            };
            await client.query(
                `UPDATE job_questions SET state = 'saved', review_reason = NULL, question_id = $2,
                        payload = $3::jsonb, locked_until = NULL, updated_at = now() WHERE id = $1`,
                [id, mergeInto, JSON.stringify(payload)]);
            await jobCtl.writeHumanEvent(client, {
                jobId: jq.job_id, jqId: id, node: 'approve', startedAt,
                detail: { merged: true, merge_into: mergeInto }
            });
            await jobCtl.maybeFinishJob(client, jq.job_id);
            await client.query('COMMIT');
            return res.json({ question_id: mergeInto, merged: true });
        }

        // ── 入庫：kind='pdf' 走 origin='pdf'／chapter_src='human'（既有行為，第 6.6 條是契約）；
        //         kind='variant' 走 origin='variant'／variant_of=根節點／chapter_src 依有沒有改章節
        //         （第 4.7 條、裁決 S3-12）。text_hash 一律對修正後的題幹重算（裁決 S2-23）。
        const hash = computeTextHash(v.value.question_text);
        const { buildTsvTokens } = require('../services/embedService');
        const { chapterTokens, keywordTokens, stemTokens } =
            buildTsvTokens({ ...v.value, keywords: null, concept_summary: null });

        const isVariant = jq.kind === 'variant';
        const origin = isVariant ? 'variant' : 'pdf';
        const variantOf = isVariant ? (jq.payload?.extract?.variant_of_root ?? null) : null;
        const chapterSrc = isVariant ? variantChapterSrc(jq.payload, v.value.chapter) : 'human';

        // 題源標記（0006）：沿用該 job 上傳時的標記；舊 job 沒標的落 'unknown'
        // 來源註記（0007）：同路徑沿用（變式 job 本來就沒有註記）
        const sourceType = jq.source_type ?? 'unknown';
        const sourceDetail = jq.source_detail ?? null;
        const { rows: inserted } = await client.query(
            `INSERT INTO questions
                (subject, chapter, question_type, difficulty, question_text, question_img,
                 answer_text, solution_img, origin, chapter_src, variant_of, text_hash, source_type, source_detail, search_tsv)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                     setweight(to_tsvector('simple', array_to_string($15::text[], ' ')), 'A')
                  || setweight(to_tsvector('simple', array_to_string($16::text[], ' ')), 'A')
                  || setweight(to_tsvector('simple', array_to_string($17::text[], ' ')), 'B'))
             RETURNING id`,
            [v.value.subject, v.value.chapter, v.value.question_type, v.value.difficulty,
            v.value.question_text, body.question_img || null, v.value.answer_text || '略',
            body.solution_img || null, origin, chapterSrc, variantOf, hash, sourceType, sourceDetail,
                chapterTokens, keywordTokens, stemTokens]);
        const questionId = inserted[0].id;

        await client.query(
            `UPDATE job_questions SET state = 'saved', review_reason = NULL, question_id = $2,
                    locked_until = NULL, updated_at = now() WHERE id = $1`,
            [id, questionId]);
        await jobCtl.writeHumanEvent(client, {
            jobId: jq.job_id, jqId: id, node: 'approve', startedAt,
            detail: { question_id: questionId, accept_plain_text: acceptPlainText }
        });
        await jobCtl.maybeFinishJob(client, jq.job_id);
        await client.query('COMMIT');

        res.json({ question_id: questionId });
        scheduleEmbed(questionId);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        next(err);
    } finally {
        client.release();
    }
};

// ────────────────── 6.6 POST /api/review/:jqId/reject ──────────────────

exports.reject = async (req, res, next) => {
    const startedAt = Date.now();
    const id = jobCtl.parseId(req.params.jqId);
    if (id === null) return res.status(404).json({ message: NOT_FOUND });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'SELECT id, job_id, state FROM job_questions WHERE id = $1 FOR UPDATE', [id]);
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: NOT_FOUND });
        }
        if (rows[0].state === 'saved' || rows[0].state === 'rejected') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: ALREADY_DONE });
        }

        // review_reason 保留原值：報表要看得出「被略過的都是哪一類問題」
        await client.query(
            `UPDATE job_questions SET state = 'rejected', locked_until = NULL, updated_at = now() WHERE id = $1`,
            [id]);
        await jobCtl.writeHumanEvent(client, { jobId: rows[0].job_id, jqId: id, node: 'reject', startedAt, detail: {} });
        await jobCtl.maybeFinishJob(client, rows[0].job_id);
        await client.query('COMMIT');

        res.json({ message: '已標記為不採用。', jq_id: id });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        next(err);
    } finally {
        client.release();
    }
};

/** 入庫後補向量：fire-and-forget，失敗只記 log（interfaces-stage1.md 12.4）。 */
function scheduleEmbed(questionId) {
    Promise.resolve()
        .then(() => require('../services/embedService').embedByIds([questionId]))
        .then(r => {
            if (r.failed.length > 0) {
                console.warn(`[embed] 題目 ${questionId} 的向量待 backfill 補：${String(r.failed[0].error).split('\n')[0]}`);
            }
        })
        .catch(err => console.warn(`[embed] 題目 ${questionId} 的向量寫入失敗（不影響複核結果）：${String(err.message).split('\n')[0]}`));
}

module.exports.REVIEW_REASONS = REVIEW_REASONS;
// 純函式，給單元測試釘住第 4.7 條的規則（WS-B 只加這個匯出，既有匯出不動）
module.exports.variantChapterSrc = variantChapterSrc;
