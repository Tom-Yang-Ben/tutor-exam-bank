// ─────────────────────────────────────────────────────────────
// localExtractOcr.pg.test.js — LOCAL_EXTRACT_MODE=ocr 的管線整合測試（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
// 在真的 PostgreSQL 上成立的三件事：
//   1. 0019：review_reason 的 CHECK 接受 'ocr_only'（0018 為止不接受）、仍拒絕亂寫的值、既有十個值都在；
//      再套一次是 no-op（約束定義與資料都不變）。在暫用 schema 上從 0001 一路套，不動共用的 public。
//   2. runner 用**真的** agents/extract.js（ocr 模式）拆一份 2 頁的 PDF：OCR 與模型都是假的
//      （extract._setLocalDepsForTest、注入的 llm），其餘節點用 test/fixtures/fakeAgents。
//      → 不呼叫視覺模型；每題走完後續節點、最後一律停在 needs_review('ocr_only')，一題都不自動入庫；
//        cross_check 沿用既有形狀；依版面配到的附圖照舊在 PDF 刪檔前裁成 PNG；配不到的留 figure_hint。
//   3. 複核 API：reason=ocr_only 可以篩、單題看得到 cross_check 與提示；人工核准照舊入庫（帶裁好的圖）。
//
// 防線與 localExtract.pg.test.js 相同：只讀 TEST_DATABASE_URL、庫名必須 _test 結尾。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
const M19 = '0019_ocr_only_review.sql';

if (!TEST_DATABASE_URL) {
    test('LOCAL_EXTRACT_MODE=ocr 整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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

    const { Client } = require('pg');
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
    const OCR_CC = { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' };

    const ALL = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const OLD_REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate', 'budget_exceeded',
        'provider_error', 'schema_invalid', 'awaiting_approval', 'transcription_mismatch', 'extract_disagree'];

    async function applySql(client, sql) {
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    }

    async function withScratchSchema(name, fn) {
        const client = new Client({ connectionString: TEST_DATABASE_URL });
        await client.connect();
        client.on('notice', () => { });
        try {
            await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            await client.query(`CREATE SCHEMA ${name}`);
            await client.query(`SET search_path TO ${name}, public`);
            await fn(client);
        } finally {
            try {
                await client.query('RESET search_path');
                await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            } finally {
                await client.end();
            }
        }
    }

    const reject = (promise) => assert.rejects(promise,
        err => err.code === '23514' && err.constraint === 'job_questions_review_reason_check', '預期撞 job_questions_review_reason_check');

    describe('0019：review_reason 加 ocr_only', () => {
        test('0018 為止拒絕 ocr_only；套上 0019 之後接受、亂寫的值仍拒絕、既有十個值都在；再套一次是 no-op', async () => {
            await withScratchSchema('m19_ocr_only', async (client) => {
                for (const f of ALL.filter(f => f < M19)) await applySql(client, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
                const { rows: [job] } = await client.query(
                    `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 2) RETURNING id`,
                    [crypto.randomBytes(32).toString('hex')]);
                const { rows: [jq] } = await client.query(
                    `INSERT INTO job_questions (job_id, idx, state, review_reason, payload)
                     VALUES ($1, 1001, 'needs_review', 'extract_disagree', '{}'::jsonb) RETURNING id`, [job.id]);
                await reject(client.query(`UPDATE job_questions SET review_reason = 'ocr_only' WHERE id = $1`, [jq.id]));

                const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, M19), 'utf8');
                await applySql(client, sql);
                await client.query(`UPDATE job_questions SET review_reason = 'ocr_only' WHERE id = $1`, [jq.id]);
                await reject(client.query(`UPDATE job_questions SET review_reason = 'ocr-only' WHERE id = $1`, [jq.id]));
                for (const r of OLD_REASONS) await client.query('UPDATE job_questions SET review_reason = $2 WHERE id = $1', [jq.id, r]);
                await client.query(`UPDATE job_questions SET review_reason = 'ocr_only' WHERE id = $1`, [jq.id]);

                const defOf = async () => (await client.query(
                    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                       JOIN pg_namespace n ON n.oid = t.relnamespace
                      WHERE n.nspname = 'm19_ocr_only' AND t.relname = 'job_questions' AND c.conname = 'job_questions_review_reason_check'`)).rows;
                const before = await defOf();
                assert.equal(before.length, 1);
                assert.match(before[0].def, /ocr_only/);
                await applySql(client, sql);
                assert.deepEqual(await defOf(), before, '再套一次：約束定義不變');
                const { rows: [kept] } = await client.query('SELECT review_reason FROM job_questions WHERE id = $1', [jq.id]);
                assert.equal(kept.review_reason, 'ocr_only', '再套一次不動資料');
            });
        });

        test('測試庫（migrate:test 已套到最新）接受 ocr_only', async () => {
            const { rows } = await query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [M19]);
            assert.equal(rows.length, 1, 'migrate:test 要套到 0019');
        });
    });

    describe('runner × 真的 extract（LOCAL_EXTRACT_MODE=ocr）', () => {
        const Q_PLAIN = {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
            question_text: '設平面向量 $\\vec{a}=(3,4)$ 與 $\\vec{b}=(1,2)$，求兩個向量的內積等於多少。', answer_text: '$11$'
        };
        const Q_FIG = {
            subject: '物理', chapter: '牛頓運動定律', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
            question_text: '如圖，一個質量為 $2$ 公斤的木塊放在光滑水平面上，受水平力拉動，求木塊加速度的大小。', answer_text: '$5$'
        };
        const Q_NOFIG = {
            subject: '物理', chapter: '牛頓運動定律', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
            question_text: '如右圖所示，兩個木塊以輕繩相連放在光滑水平面上，求繩子張力的大小為多少。', answer_text: '$3$'
        };
        const plain = (q) => q.question_text.replace(/\$/g, '').replace(/\\vec\{(\w)\}/g, '$1');
        const PAGES = [
            { page: 1, markdown: ['## 1. (數學·計算)', plain(Q_PLAIN), '## 2. (物理·計算)', plain(Q_FIG), '[圖]'].join('\n\n'), imagePath: null, figures: [{ label: 'image', box: [300, 200, 600, 800] }] },
            { page: 2, markdown: ['## 3. (物理·計算)', plain(Q_NOFIG)].join('\n\n'), imagePath: null, figures: [] }
        ];

        let agentsDir;
        let jobId;
        let jqIds;
        const agentsSeen = [];
        const cropped = [];

        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            fakeCommon.resetCounts();

            agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mode-agents-'));
            fs.writeFileSync(path.join(agentsDir, 'extract.js'), `module.exports = require(${JSON.stringify(path.join(APP_DIR, 'agents', 'extract.js'))});`);
            for (const name of ['dedup', 'classify', 'lint', 'source_check', 'verify']) {
                fs.writeFileSync(path.join(agentsDir, `${name}.js`), `module.exports = require(${JSON.stringify(path.join(FAKE_AGENTS_DIR, `${name}.js`))});`);
            }
            extract._setLocalDepsForTest({
                ocrPdf: async ({ fromPage, toPage }) => ({
                    engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, replayed: false, dispose() { },
                    pages: PAGES.filter(p => p.page >= fromPage && p.page <= toPage)
                }),
                renderPages: async () => { throw new Error('ocr 模式不該轉圖給視覺模型'); },
                llmMode: () => 'live',
                ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
                numCtx: () => 16384
            });

            const doc = await PDFDocument.create();
            doc.addPage([595, 842]);
            doc.addPage([595, 842]);
            const bytes = Buffer.from(await doc.save());
            const { rows } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, 2) RETURNING id`,
                [crypto.createHash('sha256').update(bytes).digest('hex')]);
            jobId = rows[0].id;
            fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), bytes);
            await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, path.posix.join('data', 'jobs', `${jobId}.pdf`)]);

            const llm = {
                async generateJson(opts) {
                    agentsSeen.push(opts.agent);
                    if (opts.agent !== 'extract_ocr') throw new Error(`ocr 模式不該呼叫 ${opts.agent}`);
                    return { data: { questions: [Q_PLAIN, Q_FIG, Q_NOFIG] }, latencyMs: 3, usage: { tokenIn: 100, tokenOut: 50, tokenThinking: 0, tokenCached: 0 }, raw: null };
                },
                async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
            };
            const runner = createRunner({
                db: { pool, query }, llm, agentsDir, logger: QUIET, sleep: async () => { },
                estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { localExtract: true, localExtractMode: 'ocr', ocrEngine: 'paddle', pdfChunkPages: 2, nodeTimeoutMs: 20000, leaseMs: 60000, concurrency: 1 }
            });
            for (let i = 0; i < 80; i++) {
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
                const { rows: left } = await query(
                    `SELECT (SELECT COUNT(*)::int FROM job_questions WHERE job_id = $1
                              AND state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped')) AS running,
                            (SELECT state FROM jobs WHERE id = $1) AS job_state`, [jobId]);
                if (left[0].running === 0 && ['done', 'failed'].includes(left[0].job_state)) break;
            }
            const { rows: jq } = await query('SELECT id FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            jqIds = jq.map(r => r.id);
        });

        after(async () => {
            extract._setLocalDepsForTest({});
            fs.rmSync(agentsDir, { recursive: true, force: true });
            fs.rmSync(path.join(JOBS_DIR, `${jobId}.pdf`), { force: true });
            for (const f of cropped) fs.rmSync(f, { force: true });
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            await query(`DELETE FROM questions WHERE origin = 'pdf' AND question_text LIKE '%木塊%'`);
            await pool.end();
        });

        test('jobs 跑完（done）、PDF 刪檔；只呼叫 extract_ocr，沒有視覺模型', async () => {
            const { rows } = await query('SELECT state, error, pdf_path FROM jobs WHERE id = $1', [jobId]);
            assert.equal(rows[0].state, 'done', `jobs.error=${rows[0].error}`);
            assert.equal(rows[0].pdf_path, null);
            assert.ok(!fs.existsSync(path.join(JOBS_DIR, `${jobId}.pdf`)));
            assert.deepEqual(agentsSeen, ['extract_ocr']);
        });

        test('每一題走完後續節點、最後停在 needs_review(ocr_only)；一題都不自動入庫', async () => {
            const { rows } = await query('SELECT id, state, review_reason, question_id, payload FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            assert.equal(rows.length, 3);
            assert.deepEqual(rows.map(r => [r.state, r.review_reason, r.question_id]), [
                ['needs_review', 'ocr_only', null], ['needs_review', 'ocr_only', null], ['needs_review', 'ocr_only', null]
            ]);
            for (const r of rows) {
                assert.deepEqual(r.payload.extract.cross_check, OCR_CC);
                assert.equal(r.payload.extract.extract_mode, 'ocr');
                for (const k of ['dedup0', 'classify', 'lint', 'source_check', 'verify', 'dedup1']) assert.ok(r.payload[k], `${k} 沒跑`);
            }
            const { rows: ev } = await query(
                `SELECT node, outcome, error_class, detail FROM job_events WHERE jq_id = $1 ORDER BY id`, [rows[0].id]);
            assert.deepEqual(ev.map(e => e.node), ['dedup0', 'classify', 'lint', 'source_check', 'verify', 'dedup1', 'save']);
            const save = ev[ev.length - 1];
            assert.equal(save.outcome, 'skipped');
            assert.equal(save.error_class, null);
            assert.equal(save.detail.reason, 'ocr_only');
            const { rows: saved } = await query('SELECT COUNT(*)::int AS n FROM job_questions WHERE job_id = $1 AND question_id IS NOT NULL', [jobId]);
            assert.equal(saved[0].n, 0);
        });

        test('拆題事件：cross_check 摘要記 mode=ocr、三題 ocr_only、附圖配到 1 張', async () => {
            const { rows } = await query(`SELECT outcome, detail FROM job_events WHERE job_id = $1 AND node = 'extract'`, [jobId]);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].outcome, 'pass');
            const cc = rows[0].detail.cross_check;
            assert.equal(cc.mode, 'ocr');
            assert.deepEqual(cc.counts, { agree: 0, disagree: 0, vision_only: 0, ocr_only: 3 });
            assert.deepEqual(cc.figures, { layout: 'ok', detected: 1, assigned: 1, hinted: 1 });
        });

        test('附圖：依版面配到的那一題在 PDF 刪檔前裁好 PNG；「如右圖」但版面上沒有圖的那一題留 figure_hint', async () => {
            const { rows } = await query('SELECT payload FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            const [a, b, c] = rows.map(r => r.payload.extract);
            assert.equal(a.figure_box, undefined);
            assert.equal(a.figure_hint, undefined);
            assert.equal(b.figure_page, 1);
            assert.deepEqual(b.figure_box, [300, 200, 600, 800]);
            assert.match(b.figure_img, /^\/figures\/\d+-\d+\.png$/);
            const file = path.join(FIGURES_DIR, path.basename(b.figure_img));
            cropped.push(file);
            assert.ok(fs.existsSync(file), '裁好的圖在 data/figures/');
            assert.equal(c.figure_box, undefined);
            assert.deepEqual(c.figure_hint, { reason: 'mentions' });
        });

        test('複核 API：reason=ocr_only 可以篩；單題看得到 cross_check 與提示；亂寫的 reason 仍是 400', async () => {
            const list = await request(app).get('/api/review').query({ reason: 'ocr_only' });
            assert.equal(list.status, 200, JSON.stringify(list.body));
            assert.deepEqual(list.body.items.map(i => i.jq_id).sort((x, y) => x - y), [...jqIds].sort((x, y) => x - y));
            const one = await request(app).get(`/api/review/${jqIds[2]}`);
            assert.equal(one.status, 200);
            assert.equal(one.body.review_reason, 'ocr_only');
            assert.deepEqual(one.body.payload.extract.figure_hint, { reason: 'mentions' });
            assert.equal((await request(app).get('/api/review').query({ reason: 'ocr-only' })).status, 400);
        });

        test('人工核准照舊入庫（帶自動裁好的圖）：這就是 ocr 模式「每題都要人工確認」的出口', async () => {
            const { rows: [row] } = await query('SELECT payload FROM job_questions WHERE id = $1', [jqIds[1]]);
            const ex = row.payload.extract;
            const res = await request(app).post(`/api/review/${jqIds[1]}/approve`).send({
                subject: ex.subject, chapter: ex.chapter, question_type: ex.question_type, difficulty: ex.difficulty,
                question_text: ex.question_text, answer_text: ex.answer_text, question_img: ex.figure_img
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const { rows: q } = await query('SELECT origin, question_img FROM questions WHERE id = $1', [res.body.question_id]);
            assert.equal(q[0].origin, 'pdf');
            assert.equal(q[0].question_img, ex.figure_img);
            const { rows: [jq] } = await query('SELECT state, review_reason FROM job_questions WHERE id = $1', [jqIds[1]]);
            assert.deepEqual([jq.state, jq.review_reason], ['saved', null]);
        });
    });
}
