// ─────────────────────────────────────────────────────────────
// jobAbandon.pg.test.js — 〔dec/r8-b1-abandon〕jobRunner 的 shutdown({ abandon: true })（真的 PostgreSQL）
//
// 桌面版從系統匣選「現在放棄」時，後端走這一條（docs/desktop-app-design.md 2.3 節第 4 點、第 3 條第 2 項、R-17）。
// 三種工作單位各一則，都是「runner A 的節點卡住（等 signal）→ A.shutdown({ abandon: true }) → 另一個 runner B 馬上 tick」：
//   ① 題目層（runJobQuestion）：classify 卡住；
//   ② 拆題（runExtractJob，真的 agents/extract.js、假 OCR 與假模型）：3 頁、每塊 1 頁，第 2 塊的模型呼叫卡住；
//   ③ 變式（runGenerateJob）：第 2 題的模型呼叫卡住。
// 每一則都斷言：
//   - 放棄時：卡住的呼叫收到 abort（OCR 的 python、模型呼叫會停下來）；沒有新的 job_events（特別是沒有 timeout）、
//     job_questions.retries 不變、job 沒有 failed、狀態停在原處；自己的租約（locked_until）已清空；
//   - 重開：**不動租約**（不像當機的測試要手動讓租約到期），B 的第一輪 tick 就認領，照 DA-13 的重跑點接著做，最後收尾；
//     整份 job 的事件裡一筆 timeout 都沒有。
// ④ 多個後端（桌面版與網頁版 npm start 同時開著）：放棄只放自己的租約——別的 runner 手上的列不動；
//   自己手上的列若已被別人接手（租約的值不是自己寫的），也清不到。
// 續租間隔設得很短（100 毫秒），放棄前已經續過幾次：放租約用的是最後一次續租寫的值（租約憑證跟著換）。
// ⑤〔審查 dec/r8-b1-abandon-fix〕shutdown 時 tick 正卡在認領的交易裡：shutdown 先等那一輪 tick，剛認領到的 job 不開始、
//   用這次的憑證放掉租約（原本會在 shutdown 回傳、連線池關掉之後才開始，租約要等到期）。
//
// 防線與 extractCheckpoints.pg.test.js 相同：只讀 TEST_DATABASE_URL、庫名必須 _test 結尾。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('放棄在途工作整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner, ABANDON_REASON } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const extract = require(path.join(APP_DIR, 'agents', 'extract'));
    const variantService = require(path.join(APP_DIR, 'services', 'variantService'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));
    const fakeGenerate = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeVariantAgents', 'generate.js'));
    const { FIGURES_DIR } = require(path.join(APP_DIR, 'services', 'figureService'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const FAKE_VARIANT_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeVariantAgents');
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
    const ADVANCEABLE = `('extracted','hashed','classified','linted','source_checked','verified','deduped')`;
    const DIM = 768;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const aborted = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    /** 卡住直到 signal 被 abort（真的 Ollama／OCR 呼叫也是這樣停下來的）；abort 時記下 reason */
    function hangUntilAbort(signal, seen) {
        return new Promise((_, reject) => {
            const onAbort = () => { seen.push(signal.reason); reject(aborted()); };
            if (!signal) return;   // 沒有 signal 就永遠卡著（不該發生：runner 一定給）
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function capture() {
        const warns = [];
        return { warns, logger: { info() { }, warn: o => warns.push(o), error() { } } };
    }

    function makeRunner({ agentsDir, llm, logger, config = {} }) {
        return createRunner({
            db: { pool, query }, llm, agentsDir, logger: logger || capture().logger,
            sleep: async () => { }, estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            // 續租 100 毫秒一次：放棄之前已經續過幾次（租約憑證要跟著換值）；節點逾時很長，卡住的呼叫不會自己逾時
            config: { nodeTimeoutMs: 600000, renewIntervalMs: 100, leaseMs: 60000, concurrency: 1, ...config }
        });
    }

    /** tick 到這份 job 收尾、沒有可推進的題為止 */
    async function drain(runner, jobId, maxRounds = 200) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await sleep(10);
            const { rows } = await query(
                `SELECT (SELECT COUNT(*)::int FROM job_questions WHERE job_id = $1 AND state IN ${ADVANCEABLE}) AS running,
                        (SELECT state FROM jobs WHERE id = $1) AS job_state`, [jobId]);
            if (rows[0].running === 0 && ['done', 'failed'].includes(rows[0].job_state)) return rows[0].job_state;
        }
        throw new Error('drain：超過上限仍有未推進的列');
    }

    async function waitFor(pred, ms = 5000) {
        const started = Date.now();
        while (!(await pred())) {
            if (Date.now() - started > ms) throw new Error('waitFor 逾時');
            await sleep(10);
        }
    }

    async function leaseOf(table, id) {
        const { rows } = await query(`SELECT locked_until::text AS v FROM ${table} WHERE id = $1`, [id]);
        return rows[0].v;
    }

    async function timeoutEvents(jobId) {
        const { rows } = await query(
            `SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1 AND error_class = 'timeout'`, [jobId]);
        return rows[0].n;
    }

    async function truncateAll() {
        for (let attempt = 0; ; attempt++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs, attempt_records, assignments, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if (err.code !== '40P01' || attempt >= 4) throw err;
                await sleep(50 * (attempt + 1));
            }
        }
    }

    const cleanup = [];
    const jobIds = [];

    describe('放棄在途工作（shutdown({ abandon: true })，PostgreSQL）', () => {
        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            await truncateAll();
        });
        beforeEach(async () => { await truncateAll(); fakeCommon.resetCounts(); fakeGenerate.resetCounts(); });
        after(async () => {
            extract._setLocalDepsForTest({});
            for (const f of cleanup) fs.rmSync(f, { recursive: true, force: true });
            const figs = fs.existsSync(FIGURES_DIR) ? fs.readdirSync(FIGURES_DIR) : [];
            for (const id of jobIds) {
                for (const f of figs.filter(n => new RegExp(`^${id}-\\d+\\.png$`).test(n))) fs.rmSync(path.join(FIGURES_DIR, f), { force: true });
            }
            await truncateAll();
            await pool.end();
        });

        // ───────────────────────── ① 題目層 ─────────────────────────
        test('① 題目層：classify 執行中放棄 → 不寫事件、retries 不變、租約已清；重開第一輪就認領、從 classify 重跑，沒有 timeout', async () => {
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            jobIds.push(job.id);
            const payload = {
                extract: {
                    idx: 1001, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
                    question_text: '自製測試題：設 $\\vec{a}=(3,4)$，求 $|\\vec{a}|$ 的值為多少。', answer_text: '$5$',
                    chunk_no: 1, page_range: [1, 1],
                    __fake: { classify: { kind: 'hang', times: 1 } }   // 第一次卡住等 signal（被 abort 時回 timeout，照真 agent 的習慣）
                },
                dedup0: { text_hash: 'abandon-test-hash', hit: null }
            };
            const retries = { 'classify:error': 1, 'lint:fail': 1 };
            const { rows: [jq] } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload, retries) VALUES ($1, 1001, 'hashed', $2::jsonb, $3::jsonb) RETURNING id`,
                [job.id, JSON.stringify(payload), JSON.stringify(retries)]);

            const a = capture();
            const A = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {}, logger: a.logger });
            await A.tick();
            await waitFor(async () => A.inFlight === 1);
            const claimed = await leaseOf('job_questions', jq.id);
            await sleep(350);
            const renewed = await leaseOf('job_questions', jq.id);
            assert.notEqual(renewed, claimed, '前提：放棄之前已經續租過（租約的值換過）');

            // 對照：只 stop()（等於當機、A 的舊做法）的話，租約還在，別的 runner 接不到
            const probe = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {} });
            await probe.tick();
            assert.equal(probe.inFlight, 0, '租約還在時別的 runner 接不到');

            const r = await A.shutdown({ abandon: true, waitMs: 5000 });
            assert.deepEqual(r, { left: 0, abandoned: 1, released: 1, kept: 0 });
            const { rows: [after1] } = await query('SELECT state, retries, review_reason, locked_until FROM job_questions WHERE id = $1', [jq.id]);
            assert.deepEqual(after1, { state: 'hashed', retries, review_reason: null, locked_until: null },
                '停在原狀態、retries 一個字都沒動、租約已清');
            const { rows: ev1 } = await query('SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1', [job.id]);
            assert.equal(ev1[0].n, 0, '被放棄的節點沒有寫事件（沒有假的 timeout）');
            const { rows: [j1] } = await query('SELECT state, error FROM jobs WHERE id = $1', [job.id]);
            assert.deepEqual(j1, { state: 'processing', error: null });
            assert.equal(a.warns.find(w => w.unit === 'job_question').lease, 'released');

            // 重開：不動租約，第一輪 tick 就認領
            // 只有這一題可以推進：B 的第一輪 tick 一定是認領它（A 的租約 60 秒、剛續過，還沒到期）
            const B = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {} });
            await B.tick();
            while (B.inFlight > 0) await sleep(10);
            const { rows: cls } = await query(
                `SELECT outcome, attempt, error_class FROM job_events WHERE jq_id = $1 AND node = 'classify' ORDER BY id`, [jq.id]);
            assert.deepEqual(cls, [{ outcome: 'pass', attempt: 2, error_class: null }],
                '第一輪 tick 就認領（不必等租約到期），從 classify 重跑一次就過；attempt 照原本的 retries 算（被放棄的那一次不算）');
            assert.equal(await drain(B, job.id), 'done');
            assert.equal(await timeoutEvents(job.id), 0, '整份 job 一筆 timeout 都沒有');
        });

        // ───────────────────────── ② 拆題 ─────────────────────────
        test('② 拆題：第 2 塊的模型呼叫中放棄 → 呼叫被中止、沒有事件、job 停在 extracting、租約已清；重開第一輪就認領、從第 2 塊接著拆', async () => {
            const Q = (subject, chapter, text, answer) => ({ subject, chapter, chapter_confidence: 0.9, question_type: '計算', difficulty: 3, question_text: text, answer_text: answer });
            const BY_CHUNK = {
                1: [Q('數學', '向量內積', '設平面向量 $\\vec{a}=(3,4)$ 與 $\\vec{b}=(1,2)$，求兩個向量的內積等於多少。', '$11$'),
                    Q('數學', '向量內積', '設平面向量 $\\vec{a}=(2,5)$ 與 $\\vec{b}=(4,1)$，求兩個向量的內積等於多少。', '$13$')],
                2: [Q('物理', '牛頓運動定律', '一個質量為 $2$ 公斤的木塊放在光滑水平面上，受水平力拉動，求木塊加速度的大小。', '$5$')],
                3: [Q('物理', '牛頓運動定律', '兩個木塊以輕繩相連放在光滑水平面上，以固定拉力拉動，求繩子張力的大小為多少。', '$3$')]
            };
            const plain = q => q.question_text.replace(/\$/g, '').replace(/\\vec\{(\w)\}/g, '$1');
            const PAGES = [1, 2, 3].map(p => ({ page: p, markdown: BY_CHUNK[p].map((q, i) => `## ${p}.${i + 1}\n\n${plain(q)}`).join('\n\n'), imagePath: null, figures: [] }));

            let phase = 'none';
            let hangChunk = null;
            const abortReasons = [];
            const llmCalls = [];
            const ocrCalls = [];
            const llm = {
                async generateJson(opts) {
                    const chunkNo = opts.cacheKeyParts && opts.cacheKeyParts.chunkNo;
                    llmCalls.push({ phase, chunkNo, at: Date.now() });
                    if (chunkNo === hangChunk) return hangUntilAbort(opts.signal, abortReasons);
                    return { data: { questions: BY_CHUNK[chunkNo] }, latencyMs: 3, usage: { tokenIn: 100, tokenOut: 10, tokenThinking: 0, tokenCached: 0 }, raw: null };
                },
                async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
            };
            extract._setLocalDepsForTest({
                ocrPdf: async ({ fromPage, toPage }) => {
                    ocrCalls.push({ phase, fromPage });
                    return { engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, replayed: false, dispose() { }, pages: PAGES.filter(p => p.page >= fromPage && p.page <= toPage) };
                },
                renderPages: async () => { throw new Error('ocr 模式不該轉圖給視覺模型'); },
                llmMode: () => 'live',
                ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
                numCtx: () => 16384
            });
            const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-extract-agents-'));
            cleanup.push(agentsDir);
            fs.writeFileSync(path.join(agentsDir, 'extract.js'), `module.exports = require(${JSON.stringify(path.join(APP_DIR, 'agents', 'extract.js'))});`);
            for (const name of ['dedup', 'classify', 'lint', 'source_check', 'verify']) {
                fs.writeFileSync(path.join(agentsDir, `${name}.js`), `module.exports = require(${JSON.stringify(path.join(FAKE_AGENTS_DIR, `${name}.js`))});`);
            }
            const cfg = { localExtract: true, localExtractMode: 'ocr', ocrEngine: 'paddle', pdfChunkPages: 1 };

            const doc = await PDFDocument.create();
            for (let i = 0; i < 3; i++) doc.addPage([595, 842]);
            const pdfBytes = Buffer.from(await doc.save());
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, 3) RETURNING id`,
                [crypto.createHash('sha256').update(pdfBytes).digest('hex')]);
            jobIds.push(job.id);
            const pdfFile = path.join(JOBS_DIR, `${job.id}.pdf`);
            fs.writeFileSync(pdfFile, pdfBytes);
            cleanup.push(pdfFile);
            await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [job.id, path.posix.join('data', 'jobs', `${job.id}.pdf`)]);

            // runner A：第 1 塊拆完，第 2 塊的模型呼叫卡住
            phase = 'abandoned';
            hangChunk = 2;
            const a = capture();
            const A = makeRunner({ agentsDir, llm, logger: a.logger, config: cfg });
            await A.tick();
            await waitFor(async () => llmCalls.some(c => c.phase === 'abandoned' && c.chunkNo === 2));
            await sleep(350);
            const abandonedAt = Date.now();
            const r = await A.shutdown({ abandon: true, waitMs: 5000 });
            assert.deepEqual(r, { left: 0, abandoned: 1, released: 1, kept: 0 });
            assert.deepEqual(abortReasons, [ABANDON_REASON], '卡住的模型呼叫收到 abort（放棄的那一種）');

            const { rows: [mid] } = await query(
                `SELECT j.state, j.error, j.locked_until, j.pdf_path IS NOT NULL AS has_pdf,
                        (SELECT array_agg(idx ORDER BY idx) FROM job_questions WHERE job_id = j.id) AS idx,
                        (SELECT array_agg(outcome || ':' || (detail->>'chunk') ORDER BY id) FROM job_events WHERE job_id = j.id AND node = 'extract') AS events
                   FROM jobs j WHERE j.id = $1`, [job.id]);
            assert.deepEqual(mid, { state: 'extracting', error: null, locked_until: null, has_pdf: true, idx: [1001, 1002], events: ['pass:1'] },
                '第 1 塊的題目與檢查點在；第 2 塊什麼都沒留下（沒有 timeout 事件）；沒有 failed；租約已清');
            assert.equal(a.warns.find(w => w.unit === 'extract').lease, 'released');
            assert.equal(a.warns.find(w => w.unit === 'extract').chunk, 2);

            // 重開（不動租約）：第一輪 tick 就認領這份卷，從第 2 塊接著拆
            phase = 'reopen';
            hangChunk = null;
            // （認領順序是先清單題、再開卷：第一輪 tick 的槽可能先被第 1 塊的題占滿，所以用「租約還沒到期就接手」來證明）
            const B = makeRunner({ agentsDir, llm, config: { ...cfg, concurrency: 3 } });
            assert.equal(await drain(B, job.id), 'done');
            const reopen = llmCalls.filter(c => c.phase === 'reopen');
            assert.deepEqual(reopen.map(c => c.chunkNo), [2, 3], '從第 2 塊接著拆，第 1 塊不再呼叫模型');
            assert.ok(reopen[0].at - abandonedAt < 10_000,
                `A 的租約（60 秒、剛續過）還沒到期，B 就接手了（${reopen[0].at - abandonedAt} 毫秒）：不必等 JOB_LEASE_MS`);
            assert.deepEqual(ocrCalls.filter(c => c.phase === 'reopen').map(c => c.fromPage), [2, 3], '第 1 頁不再 OCR');
            const { rows: ev } = await query(
                `SELECT outcome, attempt, detail->'chunk' AS chunk, detail->'created' AS created FROM job_events
                  WHERE job_id = $1 AND node = 'extract' ORDER BY id`, [job.id]);
            assert.deepEqual(ev, [
                { outcome: 'pass', attempt: 1, chunk: 1, created: 2 },
                { outcome: 'pass', attempt: 1, chunk: 2, created: 1 },
                { outcome: 'pass', attempt: 1, chunk: 3, created: 1 }
            ], '每塊一列 pass；第 2 塊的 attempt 還是 1（被放棄的那一次不算一次重試）');
            const { rows: jqs } = await query(`SELECT idx, state, review_reason FROM job_questions WHERE job_id = $1 ORDER BY idx`, [job.id]);
            assert.deepEqual(jqs.map(q => [q.idx, q.state, q.review_reason]),
                [[1001, 'needs_review', 'ocr_only'], [1002, 'needs_review', 'ocr_only'], [2001, 'needs_review', 'ocr_only'], [3001, 'needs_review', 'ocr_only']]);
            assert.equal(await timeoutEvents(job.id), 0);
            extract._setLocalDepsForTest({});
        });

        // ───────────────────────── ③ 變式 ─────────────────────────
        test('③ 變式：第 2 題的模型呼叫中放棄 → 呼叫被中止、沒有事件、job 沒有 failed、租約已清；重開第一輪就認領、只補第 2、3 題', async () => {
            const vec = new Array(DIM).fill(0); vec[0] = 1;
            const { rows: [src] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin, chapter_src, embedding)
                 VALUES ('數學','向量內積','計算',3,'自製藍本：設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。','$\\sqrt{5}$','seed','human',$1::vector) RETURNING id`,
                [`[${vec.join(',')}]`]);
            const created = await variantService.createVariantJob({ pool, query }, src.id, { count: 3, difficultyDelta: 0, studentId: null }, 0.3);
            const jobId = created.job_id;
            jobIds.push(jobId);

            let phase = 'none';
            let hangIdx = null;
            const abortReasons = [];
            const llmCalls = [];
            const llm = {
                async generateJson(args) {
                    const idx = args.cacheKeyParts && args.cacheKeyParts.idx;
                    llmCalls.push({ phase, idx, at: Date.now() });
                    if (idx === hangIdx) return hangUntilAbort(args.signal, abortReasons);
                    return { data: {}, latencyMs: 5, usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 0, tokenCached: 0 }, raw: {}, schemaFallback: false };
                },
                async embed() { return { vectors: [vec], usage: { tokenIn: 10 } }; }
            };
            const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-variant-agents-'));
            cleanup.push(agentsDir);
            fs.writeFileSync(path.join(agentsDir, 'generate.js'), 'module.exports = { run: (ctx, input) => globalThis.__abandonVariantRun(ctx, input) };');
            for (const name of ['dedup', 'classify', 'lint', 'source_check', 'verify']) {
                fs.writeFileSync(path.join(agentsDir, `${name}.js`), `module.exports = require(${JSON.stringify(path.join(FAKE_VARIANT_DIR, `${name}.js`))});`);
            }
            // 假 generate：先經 ctx.llm 呼叫一次（帶 ctx.signal，與真 agent 相同），再交給 fakeVariantAgents/generate.js
            globalThis.__abandonVariantRun = async (ctx, input) => {
                await ctx.llm.generateJson({ model: ctx.config.models.variant, agent: 'variant', parts: [{ text: '假變式' }], schema: {}, cacheKeyParts: { idx: input.idx }, signal: ctx.signal });
                return fakeGenerate.run(ctx, input);
            };
            try {
                phase = 'abandoned';
                hangIdx = 2;
                const a = capture();
                const A = makeRunner({ agentsDir, llm, logger: a.logger });
                await A.tick();
                await waitFor(async () => llmCalls.some(c => c.phase === 'abandoned' && c.idx === 2));
                await sleep(350);
                const abandonedAt = Date.now();
                const r = await A.shutdown({ abandon: true, waitMs: 5000 });
                assert.deepEqual(r, { left: 0, abandoned: 1, released: 1, kept: 0 });
                assert.deepEqual(abortReasons, [ABANDON_REASON]);

                const { rows: [mid] } = await query(
                    `SELECT j.state, j.error, j.locked_until,
                            (SELECT array_agg(idx ORDER BY idx) FROM job_questions WHERE job_id = j.id) AS idx,
                            (SELECT array_agg(outcome || ':' || (detail->>'idx') ORDER BY id) FROM job_events WHERE job_id = j.id AND node = 'generate' AND outcome <> 'skipped') AS events
                       FROM jobs j WHERE j.id = $1`, [jobId]);
                assert.deepEqual(mid, { state: 'extracting', error: null, locked_until: null, idx: [1], events: ['pass:1'] },
                    '第 1 題在；第 2 題沒有列、沒有事件；沒有 failed；租約已清');
                assert.equal(a.warns.find(w => w.unit === 'variant').lease, 'released');
                assert.equal(a.warns.find(w => w.unit === 'variant').idx, 2);

                phase = 'reopen';
                hangIdx = null;
                const B = makeRunner({ agentsDir, llm, config: { concurrency: 3 } });
                assert.equal(await drain(B, jobId), 'done');
                const reopen = llmCalls.filter(c => c.phase === 'reopen');
                assert.deepEqual(reopen.map(c => c.idx), [2, 3], '只補第 2、3 題，第 1 題不再呼叫模型');
                assert.ok(reopen[0].at - abandonedAt < 10_000,
                    `A 的租約（60 秒、剛續過）還沒到期，B 就接手了（${reopen[0].at - abandonedAt} 毫秒）：不必等 JOB_LEASE_MS`);
                const { rows: ev } = await query(
                    `SELECT outcome, attempt, (detail->>'idx')::int AS idx FROM job_events
                      WHERE job_id = $1 AND node = 'generate' AND outcome <> 'skipped' ORDER BY id`, [jobId]);
                assert.deepEqual(ev, [{ outcome: 'pass', attempt: 1, idx: 1 }, { outcome: 'pass', attempt: 1, idx: 2 }, { outcome: 'pass', attempt: 1, idx: 3 }],
                    '每題一列 pass；第 2 題的 attempt 還是 1');
                const { rows: jqs } = await query('SELECT idx FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
                assert.deepEqual(jqs.map(q => q.idx), [1, 2, 3]);
                assert.equal(await timeoutEvents(jobId), 0);
            } finally {
                delete globalThis.__abandonVariantRun;
            }
        });

        // ───────────────────────── ④ 多個後端 ─────────────────────────
        test('④ 多個後端同時連同一個庫：放棄只放自己的租約；別的 runner 手上的列不動，已被別人接手的列也清不到', async () => {
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            jobIds.push(job.id);
            const ids = [];
            for (const i of [1, 2, 3]) {
                const payload = {
                    extract: {
                        idx: 1000 + i, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
                        question_text: `自製測試題 ${i}：設 $\\vec{a}=(1,${i})$，求 $|\\vec{a}|$。`, answer_text: `$\\sqrt{${1 + i * i}}$`,
                        chunk_no: 1, page_range: [1, 1], __fake: { classify: { kind: 'hang', times: 2 } }   // D 與 D2 各卡一次
                    },
                    dedup0: { text_hash: `abandon-multi-${i}`, hit: null }
                };
                const { rows: [jq] } = await query(
                    `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, $2, 'hashed', $3::jsonb) RETURNING id`,
                    [job.id, 1000 + i, JSON.stringify(payload)]);
                ids.push(jq.id);
            }
            // 桌面版 D 認領第 1 題、網頁版 W 認領第 2 題（ORDER BY id；各一個槽）；D 的續租設得很長（下面要模擬「被別人接手」）
            const d = capture();
            const D = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {}, logger: d.logger, config: { renewIntervalMs: 600000 } });
            await D.tick();
            await waitFor(async () => D.inFlight === 1);
            const W = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {} });
            await W.tick();
            await waitFor(async () => W.inFlight === 1);
            const wLease = await leaseOf('job_questions', ids[1]);
            assert.ok(wLease, '前提：W 握著第 2 題的租約');

            const r = await D.shutdown({ abandon: true, waitMs: 5000 });
            assert.deepEqual(r, { left: 0, abandoned: 1, released: 1, kept: 0 });
            assert.equal(await leaseOf('job_questions', ids[0]), null, 'D 自己的租約已清');
            assert.equal(await leaseOf('job_questions', ids[1]), wLease, 'W 手上的租約一個字都沒動');
            assert.equal(W.inFlight, 1, 'W 的工作照常在跑');

            // 模擬「D 的租約到期、被 W 接手」：列上的值換成別人寫的；D2 放棄時清不到
            const D2 = makeRunner({ agentsDir: FAKE_AGENTS_DIR, llm: {}, logger: d.logger, config: { renewIntervalMs: 600000 } });
            await D2.tick();
            await waitFor(async () => D2.inFlight === 1);
            const taken = await query(
                `UPDATE job_questions SET locked_until = now() + interval '7 minutes' WHERE id = $1 RETURNING locked_until::text AS v`, [ids[0]]);
            const r2 = await D2.shutdown({ abandon: true, waitMs: 5000 });
            assert.deepEqual(r2, { left: 0, abandoned: 1, released: 0, kept: 1 });
            assert.equal(await leaseOf('job_questions', ids[0]), taken.rows[0].v, '別人接手後寫的租約清不到');
            assert.equal(d.warns.filter(w => w.unit === 'job_question').map(w => w.lease).join(','), 'released,not-ours');

            await W.shutdown({ abandon: true, waitMs: 5000 });
            const { rows: ev } = await query('SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1', [job.id]);
            assert.equal(ev[0].n, 0, '三個 runner 放棄的都沒有寫事件');
            const { rows: rt } = await query('SELECT DISTINCT retries::text AS r FROM job_questions WHERE job_id = $1', [job.id]);
            assert.deepEqual(rt.map(x => x.r), ['{}'], 'retries 都沒動');
        });

        // ───────────────────────── ⑤ shutdown 時 tick 正在認領 ─────────────────────────
        // 〔審查 dec/r8-b1-abandon-fix〕原本 shutdown 不等正在跑的 tick：tick 卡在 claim 的交易裡時 shutdown 先回 left=0，
        // launcherControl 接著關連線池；之後那一列才被 spawn，放租約時連線池已關，要等 JOB_LEASE_MS 才會被重新認領。
        test('⑤ shutdown 時 tick 正卡在認領的交易裡：shutdown 先等它；剛認領到的 job 不開始、用這次的憑證放掉租約，馬上認領得到', async () => {
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, 1) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            jobIds.push(job.id);
            // 認領用的連線：SELECT … FOR UPDATE SKIP LOCKED 拿到列（已經鎖住）之後先卡在 gate，放行後才照常 UPDATE、COMMIT
            let openGate;
            const gate = new Promise(res => { openGate = res; });
            let held = 0;
            const gatedPool = {
                async connect() {
                    const client = await pool.connect();
                    return {
                        async query(text, params) {
                            const res = await client.query(text, params);
                            if (/FOR UPDATE SKIP LOCKED/.test(text) && res.rows.length > 0) { held += 1; await gate; }
                            return res;
                        },
                        release: (...args) => client.release(...args)
                    };
                }
            };
            const a = capture();
            const A = createRunner({
                db: { pool: gatedPool, query }, llm: {}, agentsDir: FAKE_AGENTS_DIR, logger: a.logger,
                sleep: async () => { }, estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { nodeTimeoutMs: 600000, renewIntervalMs: 100, leaseMs: 60000, concurrency: 1 }
            });
            const t = A.tick();
            let r;
            try {
                await waitFor(async () => held === 1);
                let done = false;
                const s = A.shutdown({ abandon: true, waitMs: 5000 }).then(v => { done = true; return v; });
                await sleep(50);
                assert.equal(done, false, 'shutdown 要先等正在認領的那一輪 tick');
                openGate();
                r = await s;
            } finally {
                // 斷言失敗時也要放行：認領的交易握著列鎖，不放行的話 after() 的 TRUNCATE 會一直等
                openGate();
                await t;
                while (A.inFlight > 0) await sleep(10);
            }
            assert.deepEqual(r, { left: 0, abandoned: 0, released: 0, kept: 0 }, '沒有工作單位開始，也就沒有被放棄的');
            assert.equal(A.inFlight, 0);
            const { rows: [j] } = await query('SELECT state, locked_until, error FROM jobs WHERE id = $1', [job.id]);
            assert.deepEqual(j, { state: 'extracting', locked_until: null, error: null },
                '認領時已改成 extracting（與當機後的樣子相同）；租約用這次的憑證放掉了');
            const { rows: ev } = await query('SELECT COUNT(*)::int AS n FROM job_events WHERE job_id = $1', [job.id]);
            assert.equal(ev[0].n, 0, '拆題沒有開始，沒有任何事件');
            const w = a.warns.find(x => /關閉中：剛認領到的工作不開始/.test(x.msg));
            assert.ok(w, JSON.stringify(a.warns));
            assert.deepEqual([w.unit, w.id, w.lease], ['extract', job.id, 'released']);
            // 認領條件（jobRunner 的 claim）現在就對得上：不必等 60 秒的租約
            const { rows: claimable } = await query(
                `SELECT id FROM jobs WHERE id = $1 AND kind = 'pdf' AND state IN ('queued','extracting')
                   AND (locked_until IS NULL OR locked_until < now())`, [job.id]);
            assert.equal(claimable.length, 1);
        });
    });
}
