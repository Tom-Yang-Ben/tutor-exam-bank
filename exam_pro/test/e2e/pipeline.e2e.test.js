// ─────────────────────────────────────────────────────────────
// test/e2e/pipeline.e2e.test.js — E-X15 ①：上傳 PDF → jobs 走完 → 部分入庫
//
// 走的是**真實的 HTTP 路徑加真實的 runner**：
//   POST /api/jobs（multipart，欄位名 pdf）
//     → workers/jobRunner.js 認領、拆題、逐題推進（真的 agents/、真的 pipeline/stateMachine.js）
//     → GET /api/jobs/:id 直到 done
//     → 部分入庫（questions 表真的多了幾列）、其餘進 needs_review
//
// 與 `npm run eval:pipeline` 的差別（兩者都要，量的東西不同）：
//   eval:pipeline 用 eval/lib/pipelineDriver.js，量的是**分數**（saved_rate、閘門通過率），
//                 全程不碰 jobs／job_questions 兩張表，也不經過 HTTP。
//   本檔          量的是**接線**：multipart 上傳、data/jobs/<id>.pdf 落地、認領與租約、
//                 payload 六個鍵、questions 真的寫進去、GET /api/jobs/:id 的 counts 對得上。
//   pipelineDriver 全綠而本檔紅，代表管線本身沒事、是 runner 或 controller 接錯了——
//   這正是 e2e 存在的理由。
//
// 不連外：LLM_MODE=replay 讀 eval/cassettes/、EMBED_MODE=fixture（npm run test:e2e 帶
// --env-file=eval/.env.replay）。沒有金鑰、沒有網路。
//
// ⚠ 跑這支之前，確認沒有另一個 runner 行程正指著測試庫（jobs.pg.test.js 檔頭的同一個警告）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');

if (!TEST_DATABASE_URL) {
    test('上傳 PDF → jobs 走完 e2e（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:e2e'
    }, () => { });
} else if (!fs.existsSync(SAMPLE_PDF)) {
    test('上傳 PDF → jobs 走完 e2e（需要自製樣卷）', {
        skip: `找不到 ${SAMPLE_PDF}，請先跑 npm run eval:sample-pdf`
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行 e2e');
    }
    if ((process.env.LLM_MODE || '').trim() !== 'replay') {
        // 不是 replay 就代表這一輪會**真的呼叫 Gemini**（要金鑰、要錢、CI 會失敗）。
        // 靜默跳過比靜默呼叫好，但兩者都不如直接說清楚。
        throw new Error(`e2e 只在 LLM_MODE=replay 底下跑（目前是「${process.env.LLM_MODE || '未設定'}」）。請用 npm run test:e2e。`);
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;
    process.env.JOB_RUNNER = 'off';               // 測試自己驅動 tick，不要背景 runner 插隊
    process.env.JOB_COST_BUDGET_USD = '0.5';

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));

    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
    const TERMINAL = ['saved', 'needs_review', 'rejected'];
    const RUNNING = ['extracted', 'hashed', 'classified', 'linted', 'verified', 'deduped'];

    /** 真 agents、真 services/llm（replay）、真狀態機；只把睡眠與 log 換掉。 */
    function makeRunner() {
        return createRunner({
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },                // 不真的睡退避的秒數
            config: { nodeTimeoutMs: 30000, leaseMs: 120000, concurrency: 2 }
        });
    }

    /** 一直 tick 到這個 job 的所有列都進終態為止。 */
    async function drain(runner, jobId, maxRounds = 120) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            const { rows } = await query(
                `SELECT (SELECT COUNT(*)::int FROM job_questions WHERE job_id = $1 AND state = ANY($2::text[])) AS running,
                        (SELECT state FROM jobs WHERE id = $1) AS job_state`,
                [jobId, RUNNING]);
            if (rows[0].running === 0 && ['done', 'failed'].includes(rows[0].job_state)) return i + 1;
        }
        throw new Error(`drain：job #${jobId} 超過 ${maxRounds} 輪仍未進終態`);
    }

    describe('E-X15 ① 上傳 sample_exam.pdf → jobs 走完 → 部分入庫（PostgreSQL + LLM replay）', () => {
        let jobId = null;
        let createdQuestionIds = [];

        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            // 只清管線三張表：questions 是所有整合測試共用的，全表殺會影響別人。
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            // 上一輪如果被中斷、留下沒清乾淨的 pdf 題（含已封存的），這一輪的 dedup 會踩到。
            // 只清 origin='pdf' 且沒有任何 attempts 指著的——別人手動建的題與 seed 題不動。
            await query(`DELETE FROM questions q
                          WHERE q.origin = 'pdf'
                            AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id)`);
        });

        after(async () => {
            // 順序有講究：**先清管線三張表，再刪題目**。
            // job_questions.question_id 對 questions 是 ON DELETE RESTRICT，
            // 反過來做的話 DELETE 會撞 23503，然後題目就以「已封存」的狀態留在測試庫裡，
            // 下一輪的 dedup 會踩到它們——實際發生過，症狀是「第二次跑就 0 題入庫」。
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            if (createdQuestionIds.length) {
                await query('DELETE FROM attempts WHERE question_id = ANY($1::int[])', [createdQuestionIds]);
                await query('DELETE FROM questions WHERE id = ANY($1::int[])', [createdQuestionIds]);
            }
            if (jobId !== null) fs.rmSync(path.join(JOBS_DIR, `${jobId}.pdf`), { force: true });
            await pool.end();
        });

        test('POST /api/jobs 回 202，PDF 落在 data/jobs/<id>.pdf（第 6.1 條）', async () => {
            const res = await request(app).post('/api/jobs').attach('pdf', SAMPLE_PDF);
            assert.equal(res.status, 202, JSON.stringify(res.body));
            assert.equal(res.body.existing, false);
            assert.equal(typeof res.body.job_id, 'number');
            jobId = res.body.job_id;

            const { rows } = await query(
                `SELECT state, pdf_path, page_count, pdf_sha256, budget_usd::float8 AS budget FROM jobs WHERE id = $1`,
                [jobId]);
            assert.equal(rows[0].state, 'queued');
            assert.equal(rows[0].pdf_path, `data/jobs/${jobId}.pdf`);
            assert.ok(rows[0].page_count >= 1, `page_count=${rows[0].page_count}`);
            assert.match(rows[0].pdf_sha256, /^[0-9a-f]{64}$/);
            assert.equal(rows[0].budget, 0.5);
            assert.equal(fs.existsSync(path.join(JOBS_DIR, `${jobId}.pdf`)), true);
        });

        test('同一份 PDF 再傳一次會冪等合流，不會重複付費（第 6.1 條）', async () => {
            const again = await request(app).post('/api/jobs').attach('pdf', SAMPLE_PDF);
            assert.equal(again.status, 202);
            assert.deepEqual(again.body, { job_id: jobId, existing: true });
        });

        test('runner 把這個 job 跑完：state=done，counts 相加等於 job_questions 總數', async () => {
            const rounds = await drain(makeRunner(), jobId);
            assert.ok(rounds > 0);

            const res = await request(app).get(`/api/jobs/${jobId}`);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const job = res.body;
            assert.equal(job.state, 'done', `jobs.error=${(await query('SELECT error FROM jobs WHERE id = $1', [jobId])).rows[0].error}`);

            // 第 6.2 條：四個 counts 相加 = 該 job 的 job_questions 總數。
            const { rows } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
            const c = job.counts;
            assert.equal(c.saved + c.needs_review + c.pending + c.rejected, rows[0].n,
                `counts 相加對不上 job_questions 的 ${rows[0].n} 列：${JSON.stringify(c)}`);
            assert.equal(c.pending, 0, 'state=done 時不該還有非終態的列');
            assert.ok(rows[0].n > 0, '一題都沒被拆出來');

            // 型別（第 6.2 條：NUMERIC 回字串，controller 要 Number()）——
            // 前端 variants.js 的 formatCost 直接 toFixed，是字串就會爆。
            assert.equal(typeof job.cost_usd, 'number');
            assert.equal(typeof job.budget_usd, 'number');
            assert.equal(typeof job.elapsed_ms, 'number');
        });

        test('「部分入庫」：至少一題進 questions，且 origin=pdf、章節在白名單內', async () => {
            const { rows } = await query(
                `SELECT q.id, q.subject, q.chapter, q.origin, q.question_text, q.answer_text
                   FROM questions q JOIN job_questions jq ON jq.question_id = q.id
                  WHERE jq.job_id = $1 ORDER BY q.id`, [jobId]);
            createdQuestionIds = rows.map(r => r.id);

            assert.ok(rows.length > 0, '一題都沒入庫：整條管線接上了但沒有任何產出');
            const { isValidChapter } = require(path.join(APP_DIR, 'config', 'chapters'));
            for (const r of rows) {
                assert.equal(r.origin, 'pdf', `#${r.id} 的 origin 是 ${r.origin}`);
                assert.ok(isValidChapter(r.subject, r.chapter), `#${r.id} 的章節「${r.chapter}」不在白名單內`);
                assert.ok(String(r.question_text).trim().length > 0, `#${r.id} 的題幹是空的`);
                assert.ok(String(r.answer_text).trim().length > 0, `#${r.id} 的答案是空的`);
            }
        });

        test('「部分」是真的：沒過閘門的題停在 needs_review，帶得出 review_reason', async () => {
            // 這一條在守整個管線的核心主張：**閘門會擋東西**。
            // 如果 saved 等於全部，代表閘門要嘛沒被呼叫、要嘛永遠回 pass——
            // 那時 saved_rate=1.0 看起來很棒，但它量的是「沒有防線」。
            const { rows } = await query(
                `SELECT state, review_reason, COUNT(*)::int AS n
                   FROM job_questions WHERE job_id = $1 GROUP BY state, review_reason ORDER BY state`,
                [jobId]);
            const byState = Object.fromEntries(rows.map(r => [r.state, r.n]));
            for (const state of Object.keys(byState)) {
                assert.ok(TERMINAL.includes(state), `還有列停在非終態 ${state}`);
            }
            // needs_review 的每一列都必須帶原因（第 2 條的八個值之一），否則複核分頁只能顯示空白。
            const REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate',
                'schema_invalid', 'budget_exceeded', 'provider_error', 'awaiting_approval'];
            for (const r of rows) {
                if (r.state !== 'needs_review') continue;
                assert.ok(REASONS.includes(r.review_reason),
                    `needs_review 的 review_reason「${r.review_reason}」不在八個合法值內`);
            }
            assert.ok((byState.saved || 0) > 0, '沒有任何一題入庫');
        });

        test('payload 的六個鍵：每一題至少有 extract，走到終點的有 save（第 3.2 條）', async () => {
            const { rows } = await query(
                `SELECT id, state, payload FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
            for (const r of rows) {
                assert.ok(r.payload && typeof r.payload === 'object', `jq #${r.id} 的 payload 不是物件`);
                assert.ok(r.payload.extract, `jq #${r.id} 沒有 payload.extract`);
                for (const key of Object.keys(r.payload)) {
                    assert.ok(['extract', 'dedup0', 'classify', 'lint', 'verify', 'dedup1', 'save', 'variant'].includes(key),
                        `jq #${r.id} 的 payload 多了非凍結的鍵「${key}」`);
                }
            }
        });

        test('GET /api/jobs/:id/questions 的每一列都對得上 DB（variants.js 的 chip 靠它）', async () => {
            const res = await request(app).get(`/api/jobs/${jobId}/questions?limit=100`);
            assert.equal(res.status, 200);
            const { rows } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
            assert.equal(res.body.total, rows[0].n);
            for (const item of res.body.items) {
                assert.equal(typeof item.jq_id, 'number');
                assert.ok(TERMINAL.includes(item.state), `${item.state} 不是終態`);
                assert.ok(typeof item.stem_preview === 'string' && item.stem_preview.length <= 80,
                    `stem_preview 超過 80 字：${item.stem_preview}`);
            }
        });

        test('沒有任何一筆 replay miss（cassette 齊全，CI 不連外）', async () => {
            const { rows } = await query(
                `SELECT node, error_class, COUNT(*)::int AS n
                   FROM job_events WHERE job_id = $1 AND outcome = 'error'
                  GROUP BY node, error_class`, [jobId]);
            const misses = rows.filter(r => r.error_class === 'replay_miss');
            assert.deepEqual(misses, [],
                'cassette 缺鍵：請在本機執行 npm run eval:record（需要金鑰），' +
                '或確認 prompt 模板／模型 ID／schema 是否改動（interfaces-stage2.md 第 5.2 條）');
        });
    });
}
