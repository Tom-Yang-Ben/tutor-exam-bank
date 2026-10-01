// ─────────────────────────────────────────────────────────────
// extractCheckpoints.pg.test.js — 〔Owner 第六輪 DA-13＝2，dec/r7-checkpoints〕拆題的逐塊檢查點（真的 PostgreSQL）
//
// 一份 3 頁的真 PDF、每塊 1 頁（3 塊），runner 用**真的** agents/extract.js（LOCAL_EXTRACT_MODE=ocr）：
// OCR 與模型都是假的（extract._setLocalDepsForTest、注入的 llm，兩者都逐塊記下被叫了幾次），其餘節點用 test/fixtures/fakeAgents。
// 第 2 頁有一題「如圖」、版面上有一張圖：附圖要在 PDF 刪檔前依版面配到那一題並裁成 PNG。
//
// 四件事：
//   ① 一次跑完（對照組）：三塊各呼叫一次模型、各一列 pass 事件，每題停在 needs_review(ocr_only)。
//   ② 拆到第 2 塊時程序被殺（模型呼叫卡住、runner 不再動）→ 租約到期 → 另一個 runner 重新認領：
//      第 1 塊不再呼叫 OCR 與模型，只拆第 2、3 塊；最後的題目（題號、payload.extract、附圖配對）、
//      拆題事件、jobs 的用量都與一次跑完相同；被殺的那一次呼叫沒有留下事件。
//   ③ 寫第 2 塊檢查點時當機（題目列已 INSERT、事件寫失敗）→ 整個交易 ROLLBACK；重新認領後模型這次拆出不同的題數，
//      最後第 2 塊的題目列就是這一次的結果，沒有上一輪留下的半套（重拆不會造成重複列）。
//   ④ 「失敗後按重試」（POST /api/jobs/:id/retry）：第 2 塊一直失敗讓整份 failed，按重試後從第 2 塊接著拆，
//      第 1 塊不再呼叫模型（Owner 核准的行為變更：原本整份從第 1 塊重拆）。
//
// 防線與 localExtractOcr.pg.test.js 相同：只讀 TEST_DATABASE_URL、庫名必須 _test 結尾。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('拆題逐塊檢查點整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;
    process.env.JOB_RUNNER = 'off';
    // 本檔自己的行程：拆題模型明寫成本機（走 agents/extract.js 的本機路徑），與 CI 的設定無關
    process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
    process.env.MODEL_VERIFY = 'ollama:qwen3:8b';

    const { PDFDocument } = require('pdf-lib');
    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const extract = require(path.join(APP_DIR, 'agents', 'extract'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));
    const { FIGURES_DIR } = require(path.join(APP_DIR, 'services', 'figureService'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
    const QUIET = { info() { }, warn() { }, error() { } };
    const ADVANCEABLE = `('extracted','hashed','classified','linted','source_checked','verified','deduped')`;

    const Q = (subject, chapter, text, answer) => ({
        subject, chapter, chapter_confidence: 0.9, question_type: '計算', difficulty: 3, question_text: text, answer_text: answer
    });
    const Q1 = Q('數學', '向量內積', '設平面向量 $\\vec{a}=(3,4)$ 與 $\\vec{b}=(1,2)$，求兩個向量的內積等於多少。', '$11$');
    const Q2 = Q('數學', '向量內積', '設平面向量 $\\vec{a}=(2,5)$ 與 $\\vec{b}=(4,1)$，求兩個向量的內積等於多少。', '$13$');
    const Q3 = Q('物理', '牛頓運動定律', '如圖，一個質量為 $2$ 公斤的木塊放在光滑水平面上，受水平力拉動，求木塊加速度的大小。', '$5$');
    const Q3B = Q('物理', '牛頓運動定律', '承上題，若拉力加倍而木塊質量不變，求木塊新的加速度大小為多少公尺每平方秒。', '$10$');
    const Q4 = Q('物理', '牛頓運動定律', '兩個木塊以輕繩相連放在光滑水平面上，以固定拉力拉動，求繩子張力的大小為多少。', '$3$');
    const plain = (q) => q.question_text.replace(/\$/g, '').replace(/\\vec\{(\w)\}/g, '$1');
    const PAGES = [
        { page: 1, markdown: ['## 1. (數學·計算)', plain(Q1), '## 2. (數學·計算)', plain(Q2)].join('\n\n'), imagePath: null, figures: [] },
        { page: 2, markdown: ['## 3. (物理·計算)', plain(Q3), '[圖]'].join('\n\n'), imagePath: null, figures: [{ label: 'image', box: [300, 200, 600, 800] }] },
        { page: 3, markdown: ['## 4. (物理·計算)', plain(Q4)].join('\n\n'), imagePath: null, figures: [] }
    ];
    /** 一次跑完時每塊模型回的題目（塊號＝頁碼，每塊 1 頁） */
    const BY_CHUNK = { 1: [Q1, Q2], 2: [Q3], 3: [Q4] };

    // ── 假模型與假 OCR：逐塊記下被叫了幾次（phase 標出是哪一輪的 runner）──
    let phase = 'none';
    let script = {};         // { [chunkNo]: 'hang' | 'error' | Array<題目> }（這一輪要改的塊；沒寫的照 BY_CHUNK）
    let reached = null;      // 卡住的呼叫到了就 resolve
    const llmCalls = [];
    const ocrCalls = [];
    const llm = {
        async generateJson(opts) {
            const chunkNo = opts.cacheKeyParts && opts.cacheKeyParts.chunkNo;
            llmCalls.push({ phase, agent: opts.agent, chunkNo });
            if (opts.agent !== 'extract_ocr') throw new Error(`ocr 模式不該呼叫 ${opts.agent}`);
            const s = script[chunkNo];
            if (s === 'hang') {
                if (reached) reached();
                return new Promise(() => { });   // 程序被殺：這一次呼叫永遠不會回來
            }
            if (s === 'error') throw new Error('假模型：連線被拒');
            return {
                data: { questions: Array.isArray(s) ? s : BY_CHUNK[chunkNo] },
                latencyMs: 3, usage: { tokenIn: 100 * chunkNo, tokenOut: 10 * chunkNo, tokenThinking: 0, tokenCached: 0 }, raw: null
            };
        },
        async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
    };
    const callsOf = (list, p) => list.filter(c => c.phase === p).map(c => c.chunkNo ?? c.fromPage);

    let agentsDir;
    let pdfBytes;
    const cleanup = [];
    const jobIds = [];

    function makeRunner({ db = { pool, query }, config = {} } = {}) {
        return createRunner({
            db, llm, agentsDir, logger: QUIET, sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: {
                localExtract: true, localExtractMode: 'ocr', ocrEngine: 'paddle', pdfChunkPages: 1,
                // 被殺的那一輪：節點逾時與續租都設得很長，卡住的呼叫不會自己逾時重試、也不會替租約續期
                nodeTimeoutMs: 600000, renewIntervalMs: 600000, leaseMs: 60000, concurrency: 1, ...config
            }
        });
    }

    async function seedPdfJob() {
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, 3) RETURNING id`,
            [crypto.createHash('sha256').update(pdfBytes).digest('hex')]);
        const jobId = rows[0].id;
        fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), pdfBytes);
        cleanup.push(path.join(JOBS_DIR, `${jobId}.pdf`));
        jobIds.push(jobId);
        await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, path.posix.join('data', 'jobs', `${jobId}.pdf`)]);
        return jobId;
    }

    /** tick 到這份 job 收尾、沒有可推進的題為止 */
    async function drain(runner, jobId, maxRounds = 120) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            const { rows } = await query(
                `SELECT (SELECT COUNT(*)::int FROM job_questions WHERE job_id = $1 AND state IN ${ADVANCEABLE}) AS running,
                        (SELECT state FROM jobs WHERE id = $1) AS job_state`, [jobId]);
            if (rows[0].running === 0 && ['done', 'failed'].includes(rows[0].job_state)) return rows[0].job_state;
        }
        throw new Error('drain：超過上限仍有未推進的列');
    }

    /** 這份 job 的結果（跨 job 比對用：figure_img 的 job id 換成 <job>） */
    async function snapshot(jobId) {
        const { rows: jq } = await query(
            `SELECT idx, state, review_reason, payload->'extract' AS ex FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
        const questions = jq.map(r => ({
            idx: r.idx, state: r.state, review_reason: r.review_reason,
            extract: JSON.parse(JSON.stringify(r.ex).split(`/figures/${jobId}-`).join('/figures/<job>-'))
        }));
        const { rows: ev } = await query(
            `SELECT outcome, error_class, detail FROM job_events
              WHERE job_id = $1 AND node = 'extract' AND outcome IN ('pass','skipped') ORDER BY (detail->>'chunk')::int, id`, [jobId]);
        const { rows: [job] } = await query('SELECT state, pdf_path, token_in, token_out, error FROM jobs WHERE id = $1', [jobId]);
        return { questions, events: ev, job };
    }

    /** 把租約改成已到期（程序被殺之後過了 JOB_LEASE_MS） */
    async function expireLease(jobId) {
        const { rowCount } = await query(
            `UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1 AND locked_until IS NOT NULL`, [jobId]);
        assert.equal(rowCount, 1, '被殺的 runner 還握著租約');
    }

    let baseline;

    describe('拆題逐塊檢查點（PostgreSQL）', () => {
        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            fakeCommon.resetCounts();

            agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-extract-agents-'));
            fs.writeFileSync(path.join(agentsDir, 'extract.js'), `module.exports = require(${JSON.stringify(path.join(APP_DIR, 'agents', 'extract.js'))});`);
            for (const name of ['dedup', 'classify', 'lint', 'source_check', 'verify']) {
                fs.writeFileSync(path.join(agentsDir, `${name}.js`), `module.exports = require(${JSON.stringify(path.join(FAKE_AGENTS_DIR, `${name}.js`))});`);
            }
            extract._setLocalDepsForTest({
                ocrPdf: async ({ fromPage, toPage }) => {
                    ocrCalls.push({ phase, fromPage, toPage });
                    return {
                        engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, replayed: false, dispose() { },
                        pages: PAGES.filter(p => p.page >= fromPage && p.page <= toPage)
                    };
                },
                renderPages: async () => { throw new Error('ocr 模式不該轉圖給視覺模型'); },
                llmMode: () => 'live',
                ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
                numCtx: () => 16384
            });

            const doc = await PDFDocument.create();
            for (let i = 0; i < 3; i++) doc.addPage([595, 842]);
            pdfBytes = Buffer.from(await doc.save());
        });

        after(async () => {
            extract._setLocalDepsForTest({});
            fs.rmSync(agentsDir, { recursive: true, force: true });
            for (const f of cleanup) fs.rmSync(f, { force: true });
            // 本檔各 job 裁出的附圖（<jobId>-<idx>.png；斷言失敗時也要清掉）
            const figs = fs.existsSync(FIGURES_DIR) ? fs.readdirSync(FIGURES_DIR) : [];
            for (const id of jobIds) {
                for (const f of figs.filter(n => new RegExp(`^${id}-\\d+\\.png$`).test(n))) fs.rmSync(path.join(FIGURES_DIR, f), { force: true });
            }
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            await pool.end();
        });

        test('① 一次跑完（對照組）：三塊各呼叫一次、三列 pass 事件、第 3 題配到第 2 頁的圖', async () => {
            phase = 'oneshot';
            script = {};
            const jobId = await seedPdfJob();
            assert.equal(await drain(makeRunner(), jobId), 'done');
            baseline = await snapshot(jobId);

            assert.deepEqual(callsOf(llmCalls, 'oneshot'), [1, 2, 3]);
            assert.deepEqual(callsOf(ocrCalls, 'oneshot'), [1, 2, 3]);
            assert.deepEqual(baseline.questions.map(q => q.idx), [1001, 1002, 2001, 3001]);
            assert.ok(baseline.questions.every(q => q.state === 'needs_review' && q.review_reason === 'ocr_only'));
            assert.deepEqual(baseline.events.map(e => [e.outcome, e.detail.chunk, e.detail.page_range, e.detail.created]),
                [['pass', 1, [1, 1], 2], ['pass', 2, [2, 2], 1], ['pass', 3, [3, 3], 1]]);
            const fig = baseline.questions.find(q => q.idx === 2001).extract;
            assert.equal(fig.figure_page, 2);
            assert.deepEqual(fig.figure_box, [300, 200, 600, 800]);
            assert.equal(fig.figure_img, '/figures/<job>-2001.png');
            assert.ok(fs.existsSync(path.join(FIGURES_DIR, `${jobId}-2001.png`)), '裁好的圖在 data/figures/');
            assert.equal(baseline.job.pdf_path, null);
            assert.deepEqual([baseline.job.token_in, baseline.job.token_out], [600, 60]);
        });

        test('② 拆到第 2 塊時程序被殺 → 租約到期 → 重新認領：第 1 塊不再呼叫 OCR 與模型，結果與一次跑完相同', async () => {
            const jobId = await seedPdfJob();

            // 第一個 runner：第 1 塊拆完（題目列＋檢查點已提交），第 2 塊的模型呼叫卡住＝程序被殺
            phase = 'killed';
            script = { 2: 'hang' };
            const hung = new Promise(r => { reached = r; });
            const killed = makeRunner();
            await killed.tick();
            await hung;
            killed.stop();

            const { rows: mid } = await query(
                `SELECT j.state, j.locked_until > now() AS leased,
                        (SELECT array_agg(idx ORDER BY idx) FROM job_questions WHERE job_id = j.id) AS idx,
                        (SELECT COUNT(*)::int FROM job_events WHERE job_id = j.id AND node = 'extract') AS extract_events
                   FROM jobs j WHERE j.id = $1`, [jobId]);
            assert.deepEqual(mid[0], { state: 'extracting', leased: true, idx: [1001, 1002], extract_events: 1 },
                '被殺時：第 1 塊的題目與檢查點都在，第 2 塊什麼都沒留下');
            assert.deepEqual(callsOf(llmCalls, 'killed'), [1, 2]);

            // 租約還沒到期時，別的 runner 不會接手這份卷（只會推進第 1 塊已建好的單題）
            phase = 'reclaim';
            script = {};
            reached = null;
            const second = makeRunner();
            await second.tick();
            while (second.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            assert.deepEqual(callsOf(llmCalls, 'reclaim'), [], '租約未到期，拆題不該被重新認領');

            // 租約到期 → 重新認領，從第 2 塊接著拆
            await expireLease(jobId);
            assert.equal(await drain(second, jobId), 'done');

            assert.deepEqual(callsOf(llmCalls, 'reclaim'), [2, 3], '第 1 塊不再呼叫模型');
            assert.deepEqual(callsOf(ocrCalls, 'reclaim'), [2, 3], '第 1 頁不再 OCR');
            const all = llmCalls.filter(c => c.phase === 'killed' || c.phase === 'reclaim').map(c => c.chunkNo);
            assert.equal(all.filter(n => n === 1).length, 1, '第 1 塊從頭到尾只呼叫一次模型');

            const got = await snapshot(jobId);
            assert.deepEqual(got.questions, baseline.questions, '題號、payload.extract（含附圖配對、原卷片段）與一次跑完相同');
            assert.deepEqual(got.events, baseline.events, '三列 pass 事件（塊號、頁碼、created、摘要）與一次跑完相同');
            assert.deepEqual(got.job, baseline.job, '用量（被殺的那一次沒記）、pdf_path、state 與一次跑完相同');
            assert.ok(fs.existsSync(path.join(FIGURES_DIR, `${jobId}-2001.png`)), '第 2 塊重拆時照樣裁圖');
            const { rows: others } = await query(
                `SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1 AND node = 'extract' AND outcome NOT IN ('pass','skipped')`, [jobId]);
            assert.equal(others[0].n, 0, '被殺的那一次呼叫沒有留下事件');
        });

        test('③ 寫第 2 塊檢查點時當機 → 交易 ROLLBACK；重拆拆出不同的題數，第 2 塊的列就是重拆的結果（沒有重複列）', async () => {
            const jobId = await seedPdfJob();

            // 第一個 runner：第 2 塊模型拆出兩題、題目列 INSERT 了，寫 extract 事件時連線斷掉
            phase = 'crash';
            script = { 2: [Q3, Q3B] };
            const crashingDb = {
                query,
                pool: {
                    async connect() {
                        const client = await pool.connect();
                        return {
                            async query(text, params) {
                                if (/INSERT INTO job_events/.test(text) && JSON.parse(params[14]).chunk === 2) {
                                    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
                                    assert.equal(rows[0].n, 4, '前提：同一個交易裡第 2 塊的兩列已經 INSERT');
                                    throw new Error('模擬當機：寫檢查點時連線中斷');
                                }
                                return client.query(text, params);
                            },
                            release: (...a) => client.release(...a)
                        };
                    }
                }
            };
            const crashed = makeRunner({ db: crashingDb });
            await crashed.tick();
            while (crashed.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            assert.deepEqual(callsOf(llmCalls, 'crash'), [1, 2]);
            const { rows: mid } = await query(
                `SELECT array_agg(idx ORDER BY idx) AS idx FROM job_questions WHERE job_id = $1`, [jobId]);
            assert.deepEqual(mid[0].idx, [1001, 1002], 'ROLLBACK：第 2 塊的兩列都沒留下');

            // 重新認領：這次模型只拆出一題（本機模型不保證每次一樣）
            phase = 'recrash';
            script = {};
            await expireLease(jobId);
            assert.equal(await drain(makeRunner(), jobId), 'done');
            assert.deepEqual(callsOf(llmCalls, 'recrash'), [2, 3]);

            const got = await snapshot(jobId);
            assert.deepEqual(got.questions, baseline.questions,
                '第 2 塊只有重拆的那一題（2001），上一輪的 2002 沒有殘留；其餘與一次跑完相同');
            assert.deepEqual(got.events, baseline.events);
        });

        test('④ 失敗後按重試：第 2 塊一直失敗 → failed；POST /api/jobs/:id/retry 後從第 2 塊接著拆，第 1 塊不再呼叫模型', async () => {
            const jobId = await seedPdfJob();

            phase = 'failing';
            script = { 2: 'error' };
            assert.equal(await drain(makeRunner(), jobId), 'failed');
            // 第 2 塊：第一次＋錯誤退避重試 3 次（DEFAULT_LIMITS.maxErrorRetries）；第 3 塊沒輪到
            assert.deepEqual(callsOf(llmCalls, 'failing'), [1, 2, 2, 2, 2]);
            const { rows: [failed] } = await query('SELECT error FROM jobs WHERE id = $1', [jobId]);
            assert.match(failed.error, /拆題連續失敗（chunk 2）/);

            const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
            assert.equal(res.status, 202);

            phase = 'retried';
            script = {};
            assert.equal(await drain(makeRunner(), jobId), 'done');
            assert.deepEqual(callsOf(llmCalls, 'retried'), [2, 3], '從失敗的那一塊接著拆');

            const got = await snapshot(jobId);
            assert.deepEqual(got.questions, baseline.questions);
            assert.deepEqual(got.events, baseline.events, 'pass 事件與一次跑完相同（失敗那幾次的 error 事件照留）');
            const { rows: errs } = await query(
                `SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1 AND node = 'extract' AND outcome = 'error'`, [jobId]);
            assert.equal(errs[0].n, 4);
        });

        // 〔dec/r7-checkpoints-fix，依審查〕檢查點不是從第 1 頁起連續的一串（正常流程到不了；舊資料或人工改過）：
        // 原本退回「只跳過頁碼範圍相同的塊、其餘照這次的塊號跑」，會撞號也會重拆；改成直接 failed、寫明原因
        test('⑤ 檢查點對不上（第 2～3 頁記成第 2 塊，這次每塊 1 頁）→ failed、寫明原因；不呼叫 OCR 與模型、不建任何列、PDF 留著；按重試也停在這裡', async () => {
            const jobId = await seedPdfJob();
            await query(
                `INSERT INTO job_events (job_id, node, attempt, latency_ms, outcome, detail)
                 VALUES ($1, 'extract', 1, 5, 'pass', $2::jsonb)`,
                [jobId, JSON.stringify({ chunk: 2, page_range: [2, 3], created: 0, rejected: 0 })]);

            phase = 'inconsistent';
            script = {};
            assert.equal(await drain(makeRunner(), jobId), 'failed');
            assert.deepEqual(callsOf(llmCalls, 'inconsistent'), []);
            assert.deepEqual(callsOf(ocrCalls, 'inconsistent'), []);
            const { rows: [job] } = await query('SELECT state, error, pdf_path FROM jobs WHERE id = $1', [jobId]);
            assert.match(job.error, /拆題檢查點對不上/);
            assert.ok(job.pdf_path && fs.existsSync(path.join(APP_DIR, job.pdf_path)), 'PDF 不刪');
            const { rows: jq } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1', [jobId]);
            assert.equal(jq[0].n, 0);

            const res = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
            assert.equal(res.status, 202);
            phase = 'inconsistent-retried';
            assert.equal(await drain(makeRunner(), jobId), 'failed');
            assert.deepEqual(callsOf(llmCalls, 'inconsistent-retried'), [], '按重試也不自動重拆');
            const { rows: [again] } = await query('SELECT error FROM jobs WHERE id = $1', [jobId]);
            assert.match(again.error, /按重試也會停在這裡/);
        });

        // 〔dec/r7-checkpoints-fix〕上一輪在「刪 PDF」之後、「轉 processing」之前被殺：每一塊都有檢查點、題目列都在，只是 PDF 沒了。
        // 原本（先檢查 PDF）重新認領會 failed「PDF 原檔不存在」，按重試也一樣（PDF 已刪），但其實不缺任何東西
        test('⑥ 刪完 PDF、轉 processing 之前被殺 → 租約到期 → 重新認領：不呼叫模型、不 failed，直接轉 processing，結果與一次跑完相同', async () => {
            const jobId = await seedPdfJob();
            phase = 'unlinked';
            script = {};
            const dyingDb = {
                pool,
                async query(text, params) {
                    if (/SET pdf_path = NULL, state = 'processing'/.test(text)) throw new Error('模擬當機：刪完 PDF、還沒轉 processing');
                    return query(text, params);
                }
            };
            const dying = makeRunner({ db: dyingDb });
            await dying.tick();
            while (dying.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            assert.deepEqual(callsOf(llmCalls, 'unlinked'), [1, 2, 3]);
            const { rows: [mid] } = await query(
                `SELECT j.state, j.pdf_path, j.locked_until > now() AS leased,
                        (SELECT array_agg(idx ORDER BY idx) FROM job_questions WHERE job_id = j.id) AS idx
                   FROM jobs j WHERE j.id = $1`, [jobId]);
            assert.equal(mid.state, 'extracting');
            assert.equal(mid.leased, true);
            assert.deepEqual(mid.idx, [1001, 1002, 2001, 3001]);
            assert.ok(mid.pdf_path && !fs.existsSync(path.join(APP_DIR, mid.pdf_path)), '前提：PDF 已刪、pdf_path 還在');

            phase = 'after-unlink';
            await expireLease(jobId);
            assert.equal(await drain(makeRunner(), jobId), 'done');
            assert.deepEqual(callsOf(llmCalls, 'after-unlink'), [], '每一塊都有檢查點：不再呼叫模型');
            assert.deepEqual(callsOf(ocrCalls, 'after-unlink'), []);
            const got = await snapshot(jobId);
            assert.deepEqual(got.questions, baseline.questions);
            assert.deepEqual(got.events, baseline.events);
            assert.deepEqual(got.job, baseline.job, 'state done、pdf_path NULL、error NULL、用量與一次跑完相同');
        });
    });
}
