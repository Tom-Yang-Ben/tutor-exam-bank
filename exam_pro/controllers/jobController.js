// ─────────────────────────────────────────────────────────────
// controllers/jobController.js — jobs 的四支 API（A-T12，擁有者：WS-A）
//
// 形狀與錯誤訊息**逐字**凍結於 docs/interfaces-stage2.md 第 6.1～6.3、6.7 條。
// 全部掛在 apiKeyAuth 之後（app.js:63 已對 /api 全域套用）。
//
//   POST /api/jobs                     202 {job_id, existing}
//   GET  /api/jobs/:id                 進度與成本
//   GET  /api/jobs/:id/questions       每列只回 state / review_reason / 題幹前 80 字
//   POST /api/jobs/:id/retry           退回 provider_error / budget_exceeded 的列
//
// 這一層只負責「排隊與查詢」，一行 LLM 都不呼叫；真正花錢的是 workers/jobRunner.js。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { query, pool } = require('../config/db');
const { NODE_FOR_STATE } = require('../pipeline/stateMachine');

const APP_DIR = path.resolve(__dirname, '..');
/** PDF 一律存這裡，不放 uploads/：app.js:13-27 每小時清一次，會刪掉排隊中的 PDF（第 1.3 條）。 */
const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
/** 存進 jobs.pdf_path 的是相對於 exam_pro/ 的路徑，worker 自己 resolve（搬 repo 也不會壞）。 */
const JOBS_DIR_REL = path.posix.join('data', 'jobs');

const RETRYABLE_REASONS = ['provider_error', 'budget_exceeded'];
/** node → 該節點對應的 state（NODE_FOR_STATE 的反查表），retry 要把列退回前一個狀態時用。 */
const STATE_FOR_NODE = Object.fromEntries(Object.entries(NODE_FOR_STATE).map(([s, n]) => [n, s]));
/** 管線順序（retry 的狀態反推靠它，不靠 JSON 的鍵順序）。 */
const NODE_ORDER = ['dedup0', 'classify', 'lint', 'verify', 'dedup1', 'save'];

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 題幹前 80 字（第 6.3 條）：先把連續空白換成單一空白，**不加省略號**。
 * 取值優先序 payload.lint.question_text → payload.extract.question_text。
 */
function stemPreview(payload) {
    const p = payload || {};
    const text = p.lint?.question_text ?? p.extract?.question_text ?? '';
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 盡力而為地數 PDF 頁數，只用來決定 extract 要切幾塊。
 * 數不出來就回 null（`jobs.page_count` 可為 NULL，runner 會退成單一塊）。
 *
 * 刻意不引入 pdf-lib：它是 WS-B 的相依（第 10.1 條），而這裡只需要一個數字，
 * 錯了最多是多切或少切一塊，不影響正確性。
 */
function countPdfPages(buffer) {
    const text = buffer.toString('latin1');
    // 優先讀頁面樹根的 /Count（最可靠）；線性化 PDF 會有多個，取最大的那個
    const counts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)].map(m => Number(m[1]));
    if (counts.length > 0) return Math.max(...counts);
    // 退路：數 /Type /Page 物件
    const pages = text.match(/\/Type\s*\/Page[^s]/g);
    return pages ? pages.length : null;
}

/**
 * 由 payload 反推「進 needs_review 之前停在哪一格」（retry 要用）。
 *
 * 每個節點跑完都會在 payload 留下自己那個鍵（pass／fail／預算跳過都會），
 * 所以**管線順序上最後一個有鍵的節點**就是失敗的那一個，它對應的 state
 * 就是要退回去的狀態。這條推論只對 needs_review 的列成立——推進中的列
 * 已經前進到下一格了。
 */
function stateBeforeReview(payload) {
    const p = payload || {};
    let last = null;
    for (const node of NODE_ORDER) {
        if (Object.prototype.hasOwnProperty.call(p, node)) last = node;
    }
    return last ? STATE_FOR_NODE[last] : 'extracted';
}

/** 清掉某節點的兩個重試計數（retry 要讓它從頭來過）。 */
function clearRetries(retries, node) {
    const next = { ...(retries || {}) };
    delete next[node];
    delete next[`${node}:error`];
    return next;
}

/** 分頁參數：page 預設 1、limit 預設 20 最大 100（第 6.3 條）。 */
function parsePaging(reqQuery, { defaultLimit = 20, maxLimit = 100 } = {}) {
    const rawPage = reqQuery.page === undefined ? String(1) : String(reqQuery.page);
    const rawLimit = reqQuery.limit === undefined ? String(defaultLimit) : String(reqQuery.limit);
    if (!/^\d+$/.test(rawPage) || !/^\d+$/.test(rawLimit) || Number(rawPage) < 1 || Number(rawLimit) < 1) {
        return { error: 'page 與 limit 必須是正整數。' };
    }
    if (Number(rawLimit) > maxLimit) return { error: `limit 最大 ${maxLimit}。` };
    return { page: Number(rawPage), limit: Number(rawLimit) };
}

// ─────────────────────────── 共用小工具 ───────────────────────────

/** 人工動作也要留痕（第 7.4 條）：model 為 NULL、outcome='pass'、latency_ms 記 API 處理時間。 */
async function writeHumanEvent(executor, { jobId, jqId, node, startedAt, detail }) {
    await executor.query(
        `INSERT INTO job_events (job_id, jq_id, node, attempt, latency_ms, outcome, detail)
         VALUES ($1, $2, $3, 1, $4, 'pass', $5::jsonb)`,
        [jobId, jqId ?? null, node, Date.now() - startedAt, JSON.stringify(detail ?? {})]
    );
}

/** 所有 job_questions 都在終態時把 job 收成 done（approve／reject 之後也要檢查一次）。 */
async function maybeFinishJob(executor, jobId) {
    await executor.query(
        `UPDATE jobs SET state = 'done', updated_at = now()
          WHERE id = $1 AND state = 'processing'
            AND NOT EXISTS (SELECT 1 FROM job_questions
                             WHERE job_id = $1 AND state NOT IN ('saved','needs_review','rejected'))`,
        [jobId]);
}

function parseId(value) {
    return /^\d+$/.test(String(value)) ? Number(value) : null;
}

// ─────────────────────────── 6.1 POST /api/jobs ───────────────────────────

exports.createJob = async (req, res, next) => {
    // 訊息字串與 aiController 保持一致（第 6.1 條）
    if (!req.file) return res.status(400).json({ message: '沒有上傳檔案' });

    const tmpPath = req.file.path;
    try {
        const isPdf = req.file.mimetype === 'application/pdf'
            || path.extname(req.file.originalname || '').toLowerCase() === '.pdf';
        if (!isPdf) return res.status(400).json({ message: '只接受 PDF 檔案！' });

        const buffer = fs.readFileSync(tmpPath);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const force = req.query.force === '1';

        // 冪等（第 1.3 條）：同一份 PDF 已經有未失敗的 job 就回既有那一筆，不重寫檔、不重付費
        if (!force) {
            const { rows } = await query(
                `SELECT id FROM jobs WHERE pdf_sha256 = $1 AND state <> 'failed' ORDER BY id DESC LIMIT 1`,
                [sha256]);
            if (rows.length > 0) return res.status(202).json({ job_id: rows[0].id, existing: true });
        }

        const budget = Number.parseFloat(process.env.JOB_COST_BUDGET_USD);
        const pageCount = countPdfPages(buffer);
        // 題源標記（0006）：這份考卷入庫的所有題沿用同一個標記；非法或未帶存 NULL（入庫時落 'unknown'）
        const { isValidSourceType } = require('../config/chapters');
        const sourceType = isValidSourceType(req.body?.source_type) ? req.body.source_type : null;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `INSERT INTO jobs (kind, pdf_sha256, page_count, state, budget_usd, source_type)
                 VALUES ('pdf', $1, $2, 'queued', $3, $4) RETURNING id`,
                [sha256, pageCount, Number.isFinite(budget) ? budget : 0.5, sourceType]);
            const jobId = rows[0].id;

            // 目錄自建，不需要 .gitkeep（第 1.3 條）；檔名用 job id，天然不會撞名
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            const relPath = path.posix.join(JOBS_DIR_REL, `${jobId}.pdf`);
            fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), buffer);

            await client.query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, relPath]);
            await client.query('COMMIT');
            return res.status(202).json({ job_id: jobId, existing: false });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        next(err);
    } finally {
        // multer 的暫存檔一定要刪：uploads/ 的清理是「一小時後」，中途崩潰會堆積
        try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }
    }
};

/**
 * 只給 POST /api/jobs 用的 multer 錯誤轉換（第 6.1 條的 413）。
 * 不動 app.js 的全域錯誤中樞，也不動 /analyze-pdf 的既有行為（見 docs/archive/questions2-wsA.md 第 4 條）。
 */
exports.handleUploadError = (err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'PDF 檔案過大，單次最多 15 MB。' });
    }
    return next(err);
};

// ─────────────────────────── 6.2 GET /api/jobs/:id ───────────────────────────

exports.getJob = async (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ message: '找不到該任務' });
    try {
        const { rows } = await query(
            `SELECT id, state, token_in, token_out, cost_usd, budget_usd,
                    ROUND(EXTRACT(EPOCH FROM (
                        (CASE WHEN state IN ('done','failed') THEN updated_at ELSE now() END) - created_at
                    )) * 1000)::bigint AS elapsed_ms
               FROM jobs WHERE id = $1`, [id]);
        if (rows.length === 0) return res.status(404).json({ message: '找不到該任務' });
        const job = rows[0];

        const { rows: byState } = await query(
            `SELECT state, COUNT(*)::int AS n FROM job_questions WHERE job_id = $1 GROUP BY state`, [id]);

        // pending = 非終態的列數；四個 counts 相加 = 該 job 的 job_questions 總數（第 6.2 條）
        const counts = { saved: 0, needs_review: 0, pending: 0, rejected: 0 };
        for (const r of byState) {
            if (r.state === 'saved' || r.state === 'needs_review' || r.state === 'rejected') counts[r.state] += r.n;
            else counts.pending += r.n;
        }

        res.json({
            id: job.id,
            state: job.state,
            counts,
            token_in: job.token_in,
            token_out: job.token_out,
            // NUMERIC 經 pg 回的是字串（config/db.js 只轉了 INT8 與 DATE），這裡要自己 Number()
            cost_usd: Number(job.cost_usd),
            budget_usd: Number(job.budget_usd),
            elapsed_ms: Number(job.elapsed_ms)
        });
    } catch (err) { next(err); }
};

// ────────────────────── 6.3 GET /api/jobs/:id/questions ──────────────────────

exports.listJobQuestions = async (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ message: '找不到該任務' });

    const paging = parsePaging(req.query);
    if (paging.error) return res.status(400).json({ message: paging.error });

    try {
        const { rows: jobRows } = await query('SELECT id FROM jobs WHERE id = $1', [id]);
        if (jobRows.length === 0) return res.status(404).json({ message: '找不到該任務' });

        const { rows: countRows } = await query(
            'SELECT COUNT(*) AS total FROM job_questions WHERE job_id = $1', [id]);
        const total = countRows[0].total;

        const { rows } = await query(
            `SELECT id AS jq_id, idx, state, review_reason, payload, question_id
               FROM job_questions WHERE job_id = $1
              ORDER BY idx ASC LIMIT $2 OFFSET $3`,
            [id, paging.limit, (paging.page - 1) * paging.limit]);

        res.json({
            total, page: paging.page, limit: paging.limit,
            items: rows.map(r => ({
                jq_id: r.jq_id, idx: r.idx, state: r.state, review_reason: r.review_reason,
                stem_preview: stemPreview(r.payload), question_id: r.question_id
            }))
        });
    } catch (err) { next(err); }
};

// ────────────────────── 6.7 POST /api/jobs/:id/retry ──────────────────────

exports.retryJob = async (req, res, next) => {
    const startedAt = Date.now();
    const id = parseId(req.params.id);

    // budget_usd 選填；給了就必須是大於 0 的數字
    const hasBudget = req.body?.budget_usd !== undefined && req.body?.budget_usd !== null;
    const budget = hasBudget ? Number(req.body.budget_usd) : null;
    if (hasBudget && (!Number.isFinite(budget) || budget <= 0)) {
        return res.status(400).json({ message: 'budget_usd 必須是大於 0 的數字。' });
    }
    if (id === null) return res.status(404).json({ message: '找不到該任務' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: jobRows } = await client.query(
            'SELECT id, state, pdf_path FROM jobs WHERE id = $1 FOR UPDATE', [id]);
        if (jobRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '找不到該任務' });
        }
        const job = jobRows[0];

        // 整份拆題失敗要重跑 extract，但 PDF 已經刪了就救不回來——回 409，不靜默失敗（第 1.3 條）
        const needsExtract = job.state === 'failed';
        if (needsExtract && !job.pdf_path) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'PDF 原檔已刪除，無法重跑拆題。' });
        }

        const { rows: stuck } = await client.query(
            `SELECT id, payload, retries FROM job_questions
              WHERE job_id = $1 AND state = 'needs_review' AND review_reason = ANY($2::text[])
              ORDER BY id FOR UPDATE`,
            [id, RETRYABLE_REASONS]);

        if (stuck.length === 0 && !needsExtract) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: '這份任務沒有可重跑的題目。' });
        }

        for (const row of stuck) {
            const back = stateBeforeReview(row.payload);
            await client.query(
                `UPDATE job_questions SET state = $2, review_reason = NULL, retries = $3::jsonb,
                        locked_until = NULL, updated_at = now() WHERE id = $1`,
                [row.id, back, JSON.stringify(clearRetries(row.retries, NODE_FOR_STATE[back]))]);
        }

        if (budget !== null) {
            await client.query('UPDATE jobs SET budget_usd = $2 WHERE id = $1', [id, budget]);
        }
        await client.query(
            `UPDATE jobs SET state = $2, error = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
            [id, needsExtract ? 'queued' : 'processing']);

        await writeHumanEvent(client, {
            jobId: id, jqId: null, node: 'retry', startedAt,
            detail: { requeued: stuck.length, budget_usd: budget, extract: needsExtract }
        });
        await client.query('COMMIT');

        res.status(202).json({ job_id: id, requeued: stuck.length });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        next(err);
    } finally {
        client.release();
    }
};

module.exports.stemPreview = stemPreview;
module.exports.countPdfPages = countPdfPages;
module.exports.stateBeforeReview = stateBeforeReview;
module.exports.clearRetries = clearRetries;
module.exports.parsePaging = parsePaging;
module.exports.writeHumanEvent = writeHumanEvent;
module.exports.maybeFinishJob = maybeFinishJob;
module.exports.parseId = parseId;
module.exports.JOBS_DIR = JOBS_DIR;
module.exports.RETRYABLE_REASONS = RETRYABLE_REASONS;
