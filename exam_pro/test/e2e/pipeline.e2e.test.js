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
// 〔審查 2026-09-26 測試契約變更，待 Owner 裁決〕LOCAL_EXTRACT_MODE=ocr（本機拆題只用 OCR；CI 與 eval/.env.replay 的設定，
// docs/local-mode.md 10.12）時，管線設計上**一題都不自動入庫**：每一題走完全部閘門後停在 needs_review('ocr_only')，
// 由老師在複核頁核准。舊的兩項「部分入庫：至少一題進 questions」「部分是真的：…saved>0」在這個模式下結構上不可能綠。
// 所以依 10.12 第 7 點的選項 ①，這兩項在 ocr 模式改成：
//   ①a 一題都不自動入庫：每一列都在終態、沒有 saved；needs_review 的原因在九個舊值＋ocr_only 之內（不會出現 extract_disagree）；
//      至少一題走完全部閘門停在 ocr_only，而且 payload 看得到六個閘門都跑過（閘門沒被跳過——原本「部分是真的」守的主張）
//   ①b 「部分入庫」改由人工核准：用複核頁送出的欄位（public/js/review.js 的 payloadToQuestion，同一支函式）
//      POST /api/review/:jqId/approve 核准一題 → 進 questions、origin=pdf、章節在白名單內、題幹與答案非空（原本那一項的四個斷言），
//      GET /api/jobs/:id 的 counts 跟著變成 saved=1
// 交叉驗證模式（cross；Gemini 模式也是）跑的仍是原本那兩項，一個字都沒改。
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
    const RUNNING = ['extracted', 'hashed', 'classified', 'linted', 'source_checked', 'verified', 'deduped'];
    // needs_review 的九個舊值（第 2 條）；ocr 模式另外多 ocr_only（見檔頭）
    const REASONS_9 = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate',
        'schema_invalid', 'budget_exceeded', 'provider_error', 'awaiting_approval', 'transcription_mismatch'];

    /**
     * 節點逾時：30 秒（回放很快，卡住就該早點失敗）。
     * 〔看圖拆題逾時〕只有 npm run cassettes:rerecord 錄 dedup1 向量那一步會帶 E2E_NODE_TIMEOUT_MS（本機 embedding 模型第一次載入可能很慢）；
     * CI 與回放驗證都沒有這個變數（eval/lib/suiteProcess.js 擋成空字串），照舊 30 秒。
     */
    const NODE_TIMEOUT_MS = (() => {
        const n = Number.parseInt(process.env.E2E_NODE_TIMEOUT_MS, 10);
        return Number.isInteger(n) && n > 0 ? n : 30000;
    })();

    /** 真 agents、真 services/llm（replay）、真狀態機；只把睡眠與 log 換掉。 */
    function makeRunner() {
        return createRunner({
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },                // 不真的睡退避的秒數
            config: { nodeTimeoutMs: NODE_TIMEOUT_MS, leaseMs: 120000, concurrency: 2 }
        });
    }

    /**
     * 〔審查 2026-09-26〕這一輪驅動的 runner 是不是「只用 OCR 拆題」：拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr
     * （createRunner 疊出來的同一份設定；CI 與 eval/.env.replay 都是 ocr）。是的話「部分入庫」兩項換成檔頭的 ①a／①b。
     */
    const OCR_MODE = (() => {
        const c = makeRunner().config;
        return c.localExtract === true && c.localExtractMode === 'ocr';
    })();
    /**
     * 只在交叉驗證（或 Gemini）模式跑的項目＝原本那兩項，內容一個字都沒改；ocr 模式跑的是 ①a／①b（檔頭）。
     * 〔r7 測試空轉清理 審查 2026-09-27〕不是這個模式的項目原本是 () => {}：根本不註冊，報表連 SKIP 都看不到。
     * 改成明確 skip 並寫原因（斷言一個字都沒動）；CI（ocr）的 e2e 因此固定多兩行 SKIP（交叉驗證那兩項）。
     */
    const testCross = OCR_MODE
        ? (name, fn) => test(name, {
            skip: 'CI 是 LOCAL_EXTRACT_MODE=ocr，不讀也不錄 extract_vision；這一項只在交叉驗證（cross）或 Gemini 拆題時跑。' +
                'cross 模式由假模型的單元／整合測試涵蓋（docs/local-mode.md 10.12 第 7 點）'
        }, fn)
        : test;
    const testOcr = OCR_MODE
        ? test
        : (name, fn) => test(name, { skip: '這一項只在 LOCAL_EXTRACT_MODE=ocr（CI 的設定）跑；目前是交叉驗證（cross）或 Gemini 拆題' }, fn);

    /**
     * public/js/review.js 的 payloadToQuestion（複核頁核准時送出的欄位就是它算的）。
     * review.js 是 ES module、本專案是 CommonJS：讀原始碼以 data: URL 載入（test/unit/publicAssets.test.js 同一個做法）。
     */
    async function reviewPayloadToQuestion(payload) {
        const src = fs.readFileSync(path.join(APP_DIR, 'public', 'js', 'review.js'), 'utf8');
        const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
        return mod.payloadToQuestion(payload);
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
                // 〔retrain PR-1〕attempts 是唯讀檢視（migrations/0016）：刪派題，作答跟著 ON DELETE CASCADE
                await query('DELETE FROM assignments WHERE question_id = ANY($1::int[])', [createdQuestionIds]);
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

        testCross('「部分入庫」：至少一題進 questions，且 origin=pdf、章節在白名單內', async () => {
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

        testCross('「部分」是真的：沒過閘門的題停在 needs_review，帶得出 review_reason', async () => {
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
            // needs_review 的每一列都必須帶原因（第 2 條的九個值之一），否則複核分頁只能顯示空白。
            const REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate',
                'schema_invalid', 'budget_exceeded', 'provider_error', 'awaiting_approval', 'transcription_mismatch'];
            for (const r of rows) {
                if (r.state !== 'needs_review') continue;
                assert.ok(REASONS.includes(r.review_reason),
                    `needs_review 的 review_reason「${r.review_reason}」不在九個合法值內`);
            }
            // 公開樣卷的原卷比對校準為 0 誤報（docs/source-check.md）：真的有一題被判不符就是比對器退步了
            const mismatched = rows.filter(r => r.review_reason === 'transcription_mismatch');
            assert.deepEqual(mismatched, [], '樣卷不該有任何 transcription_mismatch');
            assert.ok((byState.saved || 0) > 0, '沒有任何一題入庫');
        });

        testOcr('〔ocr 模式 ①a〕一題都不自動入庫：每一題停在 needs_review，走完全部閘門的停在 ocr_only（六個閘門都跑過）', async () => {
            const { rows } = await query(
                `SELECT id, state, review_reason, question_id, payload
                   FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
            assert.ok(rows.length > 0, '一題都沒被拆出來');
            const REASONS_OCR = [...REASONS_9, 'ocr_only'];
            for (const r of rows) {
                assert.ok(TERMINAL.includes(r.state), `jq #${r.id} 還停在非終態 ${r.state}`);
                assert.notEqual(r.state, 'saved', `jq #${r.id} 自動入庫了：ocr 模式每一題都要人工確認`);
                assert.equal(r.question_id, null, `jq #${r.id} 有 question_id`);
                if (r.state === 'needs_review') {
                    assert.ok(REASONS_OCR.includes(r.review_reason),
                        `needs_review 的 review_reason「${r.review_reason}」不在九個舊值＋ocr_only 之內`);
                }
            }
            // 公開樣卷的原卷比對校準為 0 誤報（docs/source-check.md）：真的有一題被判不符就是比對器退步了
            assert.deepEqual(rows.filter(r => r.review_reason === 'transcription_mismatch').map(r => r.id), [],
                '樣卷不該有任何 transcription_mismatch');
            const ocrOnly = rows.filter(r => r.review_reason === 'ocr_only');
            assert.ok(ocrOnly.length > 0, '沒有任何一題走完全部閘門（停在 ocr_only）：整條管線接上了但沒有任何產出');
            for (const r of ocrOnly) {
                assert.equal(r.payload.extract.extract_mode, 'ocr', `jq #${r.id} 的 extract_mode`);
                assert.deepEqual(r.payload.extract.cross_check,
                    { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' }, `jq #${r.id} 的 cross_check`);
                // 原本「部分是真的」守的主張：閘門真的被呼叫了，不是被跳過
                for (const k of ['dedup0', 'classify', 'lint', 'source_check', 'verify', 'dedup1']) {
                    assert.ok(r.payload[k], `jq #${r.id} 停在 ocr_only 卻沒跑 ${k}`);
                }
            }
            const res = await request(app).get(`/api/jobs/${jobId}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.counts.saved, 0, `ocr 模式不該有自動入庫：${JSON.stringify(res.body.counts)}`);
        });

        testOcr('〔ocr 模式 ①b〕「部分入庫」改由人工核准：用複核頁的欄位核准一題 → 進 questions，且 origin=pdf、章節在白名單內', async () => {
            const { rows: [jq] } = await query(
                `SELECT id, payload FROM job_questions
                  WHERE job_id = $1 AND state = 'needs_review' AND review_reason = 'ocr_only'
                  ORDER BY idx LIMIT 1`, [jobId]);
            assert.ok(jq, '沒有停在 ocr_only 的題可以核准');
            const question = await reviewPayloadToQuestion(jq.payload);
            const res = await request(app).post(`/api/review/${jq.id}/approve`)
                .send({ ...question, accept_plain_text: false, merge_into: null });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(typeof res.body.question_id, 'number');

            const { rows } = await query(
                `SELECT q.id, q.subject, q.chapter, q.origin, q.question_text, q.answer_text
                   FROM questions q JOIN job_questions jq ON jq.question_id = q.id
                  WHERE jq.job_id = $1 ORDER BY q.id`, [jobId]);
            createdQuestionIds = rows.map(r => r.id);
            assert.deepEqual(createdQuestionIds, [res.body.question_id], '只有人工核准的那一題入庫');
            const { isValidChapter } = require(path.join(APP_DIR, 'config', 'chapters'));
            for (const r of rows) {
                assert.equal(r.origin, 'pdf', `#${r.id} 的 origin 是 ${r.origin}`);
                assert.ok(isValidChapter(r.subject, r.chapter), `#${r.id} 的章節「${r.chapter}」不在白名單內`);
                assert.ok(String(r.question_text).trim().length > 0, `#${r.id} 的題幹是空的`);
                assert.ok(String(r.answer_text).trim().length > 0, `#${r.id} 的答案是空的`);
            }
            const { rows: [approved] } = await query('SELECT state, review_reason FROM job_questions WHERE id = $1', [jq.id]);
            assert.deepEqual([approved.state, approved.review_reason], ['saved', null]);

            const job = await request(app).get(`/api/jobs/${jobId}`);
            const c = job.body.counts;
            assert.equal(c.saved, 1, JSON.stringify(c));
            const { rows: [total] } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
            assert.equal(c.saved + c.needs_review + c.pending + c.rejected, total.n, `counts 相加對不上：${JSON.stringify(c)}`);
        });

        test('payload 的七個鍵：每一題至少有 extract，走到終點的有 save（第 3.2 條）', async () => {
            const { rows } = await query(
                `SELECT id, state, payload FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
            for (const r of rows) {
                assert.ok(r.payload && typeof r.payload === 'object', `jq #${r.id} 的 payload 不是物件`);
                assert.ok(r.payload.extract, `jq #${r.id} 沒有 payload.extract`);
                for (const key of Object.keys(r.payload)) {
                    assert.ok(['extract', 'dedup0', 'classify', 'lint', 'source_check', 'verify', 'dedup1', 'save', 'variant'].includes(key),
                        `jq #${r.id} 的 payload 多了非凍結的鍵「${key}」`);
                }
                // 〔修訂 2026-09-15f〕extract 階段在 PDF 刪檔前抽好原卷片段（樣卷是向量字型，有文字層）
                const st = r.payload.extract.source_text;
                assert.ok(st && st.v === 1, `jq #${r.id} 沒有 payload.extract.source_text`);
                assert.ok(['located', 'not_found', 'low_anchor'].includes(st.status), `jq #${r.id} 的 source_text.status=${st.status}`);
                if (st.status === 'located') assert.ok(st.segment.length > 0 && st.segment.length <= 1500);
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
            // 〔r7 測試空轉清理 審查 2026-09-27〕只改訊息、斷言不動：原本寫「npm run eval:record（需要金鑰）」（Gemini 時代；
            // eval:record 其實只錄向量）。本機模式的回放檔由 Owner 的電腦重錄（docs/local-mode.md 10.21 第 3 步）。
            assert.deepEqual(misses, [],
                'cassette 缺鍵：照 docs/local-mode.md 10.21 第 3 步在 Owner 的電腦重錄' +
                '（scripts\\windows\\record_local.bat pipeline,e2e，或 npm run cassettes:rerecord -- --suites pipeline,e2e；本機模型不需要金鑰），' +
                '或確認 prompt 模板／模型 ID／schema 是否改動（interfaces-stage2.md 第 5.2 條）');
        });
    });
}
