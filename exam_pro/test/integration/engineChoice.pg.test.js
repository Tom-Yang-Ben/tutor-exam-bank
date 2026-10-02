// ─────────────────────────────────────────────────────────────
// engineChoice.pg.test.js — 拆題與助教可選本機或 Gemini（〔dec/r13-engine-choice〕docs/local-mode.md 10.25）
//
// 真 PostgreSQL（同其他整合測試的三道防線：只讀 TEST_DATABASE_URL、庫名 _test 結尾、先覆寫 DATABASE_URL）：
//   1. migration 0021：jobs.engine 欄位與 CHECK；再套一次不動。
//   2. GET /api/engines：預設本機、沒有金鑰時 Gemini 停用；回應裡沒有金鑰本身。
//   3. POST /api/jobs 的 engine：不合法 400、選 Gemini 沒金鑰 400、有（假的）金鑰 202 並寫進 jobs.engine；GET /api/jobs/:id 回 engine；
//      冪等鍵含引擎；資料庫還沒套 0021 時選了引擎回 503、沒選照常（runner 讀不到欄位當 NULL）。
//   4. runner 端到端（假 agent 照真 agent 讀 ctx.config.models 的鍵呼叫假 LLM）：engine＝gemini 的卷每個節點都是 Gemini、
//      engine＝local 與 NULL 都是 .env 的本機模型；向量呼叫一律不帶 model（＝EMBED_MODEL）。
//   5. POST /api/tutor、POST /api/assistant：engine＝gemini 沒有金鑰 400；engine 不合法 400。
// 不連 Ollama、不連 Gemini；金鑰只是一串假字，從來沒有送出去。
// ─────────────────────────────────────────────────────────────
// 本檔以 Owner 目前的設定（本機預設）為準，與 ci.yml 相同；每個測試檔是獨立行程，不會外溢。
process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
process.env.MODEL_VERIFY = 'ollama:qwen3:8b';
process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL_EXTRACT;
delete process.env.GEMINI_MODEL_VERIFY;
delete process.env.MODEL_TUTOR;
delete process.env.MODEL_TEXT;
delete process.env.MODEL_ASSISTANT;
delete process.env.OCR_ENGINE;
process.env.FEATURE_TUTOR = 'true';
process.env.FEATURE_ASSISTANT = 'true';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const FAKE_KEY = 'fake-key-for-tests-only';

if (!TEST_DATABASE_URL) {
    test('辨識方式整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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
    process.env.JOB_COST_BUDGET_USD = '0.5';

    const request = require('supertest');
    const { PDFDocument } = require('pdf-lib');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const models = require(path.join(APP_DIR, 'config', 'models'));
    const fakeExtract = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', 'extract.js'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));
    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
    const MIGRATION = fs.readFileSync(path.join(APP_DIR, 'migrations', '0021_job_engine.sql'), 'utf8');

    /** 限流器是 routes/index.js 的模組單例：每次拿一個新的 app（同 jobs.pg.test.js） */
    function freshApp() {
        for (const key of Object.keys(require.cache)) {
            if (key === path.join(APP_DIR, 'app.js') || key === path.join(APP_DIR, 'routes', 'index.js')) delete require.cache[key];
        }
        return require(path.join(APP_DIR, 'app'));
    }

    async function makePdf(label) {
        const doc = await PDFDocument.create();
        doc.addPage([300, 300]).drawText(`engine ${label}`, { x: 20, y: 150, size: 12 });
        return Buffer.from(await doc.save());
    }

    async function truncateAll() {
        for (let i = 1; ; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= 10) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
            }
        }
    }

    // ── 記錄用的假 agent：照真 agent 讀 ctx.config.models 的那個鍵呼叫 generateJson，再交給 fixtures 的假 agent ──
    let agentsDir;
    const MODEL_KEY = { extract: 'm.extract', classify: 'm.text || m.extract', lint: 'm.text || m.extract', verify: 'm.verify' };
    function writeRecordingAgents() {
        agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pg-agents-'));
        for (const node of ['extract', 'classify', 'lint', 'verify', 'source_check', 'dedup']) {
            const real = path.join(FAKE_AGENTS_DIR, `${node}.js`);
            fs.writeFileSync(path.join(agentsDir, `${node}.js`), `
const real = require(${JSON.stringify(real)});
module.exports.run = async (ctx, input) => {
    const m = ctx.config.models;
    ${MODEL_KEY[node] ? `await ctx.llm.generateJson({ model: ${MODEL_KEY[node]}, agent: ${JSON.stringify(node)}, parts: [{ text: 'x' }], schema: {} });`
        : node === 'dedup' ? 'await ctx.llm.embed({ texts: [String(input.question_text || input.embed_text || "")] });' : ''}
    return real.run(ctx, input);
};`);
        }
    }

    const llmCalls = [];
    const fakeLlm = {
        async generateJson(o) { llmCalls.push({ kind: 'json', agent: o.agent, model: o.model }); return { data: {}, usage: { tokenIn: 1, tokenOut: 1 }, latencyMs: 1 }; },
        async embed(o) { llmCalls.push({ kind: 'embed', model: o.model }); return { vectors: (o.texts || []).map(() => { const v = new Array(768).fill(0); v[0] = 1; return v; }), usage: { tokenIn: 1 } }; }
    };

    function makeRunner() {
        return createRunner({
            db: { pool, query }, llm: fakeLlm, agentsDir,
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { nodeTimeoutMs: 5000, leaseMs: 60000, concurrency: 1, variantAutoApprove: true }
        });
    }

    async function drain(runner, maxRounds = 80) {
        for (let i = 0; i < maxRounds; i++) {
            await runner.tick();
            while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
            const { rows } = await query(
                `SELECT COUNT(*)::int AS n FROM job_questions
                  WHERE state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped')`);
            const { rows: jobs } = await query(`SELECT COUNT(*)::int AS n FROM jobs WHERE state IN ('queued','extracting')`);
            if (rows[0].n === 0 && jobs[0].n === 0) return;
        }
        throw new Error('drain：超過上限仍有未推進的列');
    }

    /** 一份「假 PDF」（給 fixtures 的假 extract 讀的劇本），engine 直接寫進 jobs */
    async function seedPdfJob(engine, label) {
        const sha = require('node:crypto').randomBytes(32).toString('hex');
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count, engine)
             VALUES ('pdf', $1, 'queued', 0.5, 1, $2) RETURNING id`, [sha, engine]);
        const jobId = rows[0].id;
        const q = {
            idx: 1001, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
            question_text: `自製辨識方式測試題 ${label}：設 $\\vec{a}=(1,2)$，求 $|\\vec{a}|$。`, answer_text: '$\\sqrt{5}$',
            chunk_no: 1, page_range: [1, 1]
        };
        fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), JSON.stringify({ questions: [q] }), 'utf8');
        await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, path.posix.join('data', 'jobs', `${jobId}.pdf`)]);
        return jobId;
    }

    describe('辨識方式（本機／Gemini）——PostgreSQL', () => {
        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            writeRecordingAgents();
            await truncateAll();
        });
        beforeEach(async () => {
            delete process.env.GEMINI_API_KEY;
            llmCalls.length = 0;
            fakeExtract.resetCounts();
            fakeCommon.resetCounts();
        });
        after(async () => {
            delete process.env.GEMINI_API_KEY;
            fs.rmSync(agentsDir, { recursive: true, force: true });
            await truncateAll();
            await pool.end();
        });

        test('migration 0021：jobs.engine 可為 NULL／local／gemini，其他值被 CHECK 擋下；再套一次不動', async () => {
            const { rows } = await query(
                `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'engine' AND table_schema = current_schema()`);
            assert.deepEqual(rows, [{ data_type: 'text', is_nullable: 'YES' }]);
            await query(MIGRATION);
            await query(MIGRATION);
            const sha = 'd'.repeat(64);
            for (const e of [null, 'local', 'gemini']) {
                const r = await query(`INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, engine) VALUES ('pdf', $1, 'failed', 0.5, $2) RETURNING engine`, [sha, e]);
                assert.equal(r.rows[0].engine, e);
            }
            await assert.rejects(
                () => query(`INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, engine) VALUES ('pdf', $1, 'failed', 0.5, 'cloud')`, [sha]),
                (err) => err.code === '23514' && /jobs_engine_check/.test(err.message));
            await truncateAll();
        });

        test('GET /api/engines：預設本機；沒有金鑰時 Gemini 停用並說明；有金鑰時可用，回應裡沒有金鑰', async () => {
            let res = await request(freshApp()).get('/api/engines');
            assert.equal(res.status, 200);
            assert.equal(res.body.purposes.extract.default, 'local');
            assert.equal(res.body.purposes.extract.options.gemini.available, false);
            assert.match(res.body.purposes.extract.options.gemini.reason, /尚未設定 Gemini 金鑰/);
            assert.equal(res.body.purposes.tutor.options.local.available, true);
            process.env.GEMINI_API_KEY = FAKE_KEY;
            res = await request(freshApp()).get('/api/engines');
            assert.equal(res.body.purposes.extract.options.gemini.available, true);
            assert.equal(res.body.purposes.extract.options.gemini.model, models.GEMINI_DEFAULTS.MODEL_EXTRACT);
            assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY));
        });

        test('POST /api/jobs：engine 不合法 400；選 Gemini 沒有金鑰 400（不建 job）', async () => {
            let res = await request(freshApp()).post('/api/jobs').field('engine', 'cloud').attach('pdf', await makePdf('bad'), 'exam.pdf');
            assert.equal(res.status, 400);
            assert.match(res.body.message, /engine 只能是 local 或 gemini/);
            res = await request(freshApp()).post('/api/jobs').field('engine', 'gemini').attach('pdf', await makePdf('nokey'), 'exam.pdf');
            assert.equal(res.status, 400);
            assert.match(res.body.message, /尚未設定 Gemini 金鑰/);
            const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs');
            assert.equal(rows[0].n, 0);
        });

        test('POST /api/jobs：有金鑰時 engine＝gemini 寫進 jobs.engine、GET 回 engine；沒帶＝NULL；冪等鍵含引擎', async () => {
            process.env.GEMINI_API_KEY = FAKE_KEY;
            const pdf = await makePdf('idem');
            const g = await request(freshApp()).post('/api/jobs').field('engine', 'gemini').attach('pdf', pdf, 'exam.pdf');
            assert.equal(g.status, 202);
            assert.equal(g.body.existing, false);
            assert.equal((await query('SELECT engine FROM jobs WHERE id = $1', [g.body.job_id])).rows[0].engine, 'gemini');
            const got = await request(freshApp()).get(`/api/jobs/${g.body.job_id}`);
            assert.equal(got.body.engine, 'gemini');

            const g2 = await request(freshApp()).post('/api/jobs').field('engine', 'gemini').attach('pdf', pdf, 'exam.pdf');
            assert.deepEqual(g2.body, { job_id: g.body.job_id, existing: true }, '同一份卷、同一個引擎：接回既有的 job');
            const l = await request(freshApp()).post('/api/jobs').field('engine', 'local').attach('pdf', pdf, 'exam.pdf');
            assert.equal(l.body.existing, false, '改選本機重傳：建新 job（本機拆過的卷可以改用 Gemini 再拆，反之亦然）');
            assert.notEqual(l.body.job_id, g.body.job_id);
            const n = await request(freshApp()).post('/api/jobs').attach('pdf', pdf, 'exam.pdf');
            assert.equal(n.body.existing, true, '沒帶 engine：冪等鍵與之前相同（不看引擎）');

            const pdf2 = await makePdf('plain');
            const p = await request(freshApp()).post('/api/jobs').attach('pdf', pdf2, 'exam.pdf');
            assert.equal((await query('SELECT engine FROM jobs WHERE id = $1', [p.body.job_id])).rows[0].engine, null);
            assert.equal((await request(freshApp()).get(`/api/jobs/${p.body.job_id}`)).body.engine, null);
            // 沒選的舊 job 以 .env 的預設（本機）計：選本機重傳接回它
            const pl = await request(freshApp()).post('/api/jobs').field('engine', 'local').attach('pdf', pdf2, 'exam.pdf');
            assert.deepEqual(pl.body, { job_id: p.body.job_id, existing: true });
            await truncateAll();
        });

        test('runner：engine＝gemini 的卷拆題與逐題檢查都用 Gemini；local 與 NULL 用 .env 的本機模型；向量都不帶 model', async () => {
            const expected = {
                gemini: { extract: models.GEMINI_DEFAULTS.MODEL_EXTRACT, classify: models.GEMINI_DEFAULTS.MODEL_EXTRACT, lint: models.GEMINI_DEFAULTS.MODEL_EXTRACT, verify: models.GEMINI_DEFAULTS.MODEL_VERIFY },
                local: { extract: 'ollama:qwen3-vl:8b', classify: 'ollama:qwen3:8b', lint: 'ollama:qwen3:8b', verify: 'ollama:qwen3:8b' }
            };
            for (const [engine, want] of [['gemini', expected.gemini], ['local', expected.local], [null, expected.local]]) {
                llmCalls.length = 0;
                fakeExtract.resetCounts();
                fakeCommon.resetCounts();
                const jobId = await seedPdfJob(engine, String(engine));
                await drain(makeRunner());
                const byAgent = {};
                for (const c of llmCalls.filter(c => c.kind === 'json')) byAgent[c.agent] = c.model;
                assert.deepEqual(byAgent, want, String(engine));
                const embeds = llmCalls.filter(c => c.kind === 'embed');
                assert.ok(embeds.length >= 1, '有向量呼叫（dedup）');
                for (const e of embeds) assert.equal(e.model, undefined, '向量不帶 model：services/llm 一律用 EMBED_MODEL');
                const { rows: ev } = await query(
                    `SELECT node, model FROM job_events WHERE job_id = $1 AND model IS NOT NULL ORDER BY id`, [jobId]);
                for (const r of ev) assert.equal(models.parseModel(r.model).vendor, engine === 'gemini' ? 'gemini' : 'ollama', `${engine} ${r.node}`);
                const { rows: st } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
                assert.equal(st[0].state, 'done', String(engine));
            }
            await truncateAll();
        });

        test('還沒套 0021 的庫：選了引擎回 503（不建 job）；沒選照常建 job，runner 讀不到欄位當 NULL、照 .env 跑完', async () => {
            await query('ALTER TABLE jobs DROP COLUMN engine');
            try {
                process.env.GEMINI_API_KEY = FAKE_KEY;
                const r1 = await request(freshApp()).post('/api/jobs').field('engine', 'local').attach('pdf', await makePdf('nocol'), 'exam.pdf');
                assert.equal(r1.status, 503);
                assert.match(r1.body.message, /0021_job_engine\.sql/);
                assert.equal((await query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n, 0, '整筆回滾，沒有留下 job');
                const r2 = await request(freshApp()).post('/api/jobs').attach('pdf', await makePdf('nocol2'), 'exam.pdf');
                assert.equal(r2.status, 202);
                assert.equal((await request(freshApp()).get(`/api/jobs/${r2.body.job_id}`)).body.engine, null);
                await truncateAll();
                await query(`INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, 1)`, ['e'.repeat(64)]);
                const { rows: [j] } = await query('SELECT id FROM jobs');
                fs.writeFileSync(path.join(JOBS_DIR, `${j.id}.pdf`), JSON.stringify({ questions: [] }), 'utf8');
                await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [j.id, path.posix.join('data', 'jobs', `${j.id}.pdf`)]);
                await drain(makeRunner());
                assert.equal(llmCalls.filter(c => c.agent === 'extract')[0].model, 'ollama:qwen3-vl:8b');
            } finally {
                await query(MIGRATION);   // 把欄位套回來（其他測試檔要用）
                await truncateAll();
            }
        });

        test('POST /api/tutor、POST /api/assistant：engine＝gemini 沒有金鑰 400；engine 不合法 400', async () => {
            const app = freshApp();
            let res = await request(app).post('/api/tutor').send({ message: '1+1？', mode: 'direct', engine: 'gemini' });
            assert.equal(res.status, 400);
            assert.match(res.body.message, /尚未設定 Gemini 金鑰/);
            res = await request(app).post('/api/tutor').send({ message: '1+1？', mode: 'direct', engine: 'cloud' });
            assert.equal(res.status, 400);
            res = await request(app).post('/api/assistant').send({ message: '哈囉', engine: 'gemini' });
            assert.equal(res.status, 400);
            assert.match(res.body.message, /尚未設定 Gemini 金鑰/);
            res = await request(app).post('/api/assistant').send({ message: '哈囉', engine: 'cloud' });
            assert.equal(res.status, 400);
        });
    });
}
