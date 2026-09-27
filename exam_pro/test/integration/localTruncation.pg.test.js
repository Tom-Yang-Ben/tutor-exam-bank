// ─────────────────────────────────────────────────────────────
// test/integration/localTruncation.pg.test.js — 本機被截斷的回應不重試（〔Owner 第五輪 C-f＝2 核准〕dec/r6-local-tuning）
//
// 真的 PostgreSQL：
//   1. 0020：review_reason 的 CHECK 在 0019 為止拒絕 'output_truncated'、套上 0020 之後接受；既有十一個值都在、
//      亂寫的值仍拒絕、再套一次約束定義與資料都不變；runner 的前置查詢（outputTruncatedAccepted）在兩種庫上各回 false／true。
//   2. runner＋真的 verify agent＋真的狀態機：驗算模型是 ollama、回應被截斷（finishReason='MAX_TOKENS'）→
//      一次就 needs_review('output_truncated')、retries 不動、job_events 記 schema_invalid＋detail.finish_reason；
//      驗算模型是 Gemini → 照舊留在 source_checked、verify:error＝1（會重試）。
// 需要 TEST_DATABASE_URL（庫名以 _test 結尾）；沒設時整檔跳過。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
const M20 = '0020_output_truncated_review.sql';

if (!TEST_DATABASE_URL) {
    test('本機截斷不重試整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JOB_RUNNER = 'off';
    const savedModels = { MODEL_VERIFY: process.env.MODEL_VERIFY, MODEL_EXTRACT: process.env.MODEL_EXTRACT };

    const { Client } = require('pg');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const jobRunner = require(path.join(APP_DIR, 'workers', 'jobRunner'));

    const QUIET = { info() { }, warn() { }, error() { } };
    const ALL = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const OLD_REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate', 'budget_exceeded',
        'provider_error', 'schema_invalid', 'awaiting_approval', 'transcription_mismatch', 'extract_disagree', 'ocr_only'];
    const jobIds = [];

    after(async () => {
        for (const [k, v] of Object.entries(savedModels)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        if (jobIds.length) await query('DELETE FROM jobs WHERE id = ANY($1::bigint[])', [jobIds]);
        await pool.end();
    });

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

    describe('0020：review_reason 加 output_truncated', () => {
        test('0019 為止拒絕；套 0020 之後接受、亂寫的值仍拒絕、既有十一個值都在；再套一次是 no-op；前置查詢兩邊各回 false／true', async () => {
            await withScratchSchema('m20_output_truncated', async (client) => {
                for (const f of ALL.filter(f => f < M20)) await applySql(client, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
                const db = { query: (text, params) => client.query(text, params) };
                assert.equal(await jobRunner.outputTruncatedAccepted(db), false, '0019 的庫：不接受');

                const { rows: [job] } = await client.query(
                    `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`,
                    [crypto.randomBytes(32).toString('hex')]);
                const { rows: [jq] } = await client.query(
                    `INSERT INTO job_questions (job_id, idx, state, review_reason, payload)
                     VALUES ($1, 1001, 'needs_review', 'schema_invalid', '{}'::jsonb) RETURNING id`, [job.id]);
                await reject(client.query(`UPDATE job_questions SET review_reason = 'output_truncated' WHERE id = $1`, [jq.id]));

                const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, M20), 'utf8');
                await applySql(client, sql);
                assert.equal(await jobRunner.outputTruncatedAccepted(db), true, '套 0020 之後接受');
                await client.query(`UPDATE job_questions SET review_reason = 'output_truncated' WHERE id = $1`, [jq.id]);
                await reject(client.query(`UPDATE job_questions SET review_reason = 'output-truncated' WHERE id = $1`, [jq.id]));
                for (const r of OLD_REASONS) await client.query('UPDATE job_questions SET review_reason = $2 WHERE id = $1', [jq.id, r]);
                await client.query(`UPDATE job_questions SET review_reason = 'output_truncated' WHERE id = $1`, [jq.id]);

                const defOf = async () => (await client.query(
                    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                       JOIN pg_namespace n ON n.oid = t.relnamespace
                      WHERE n.nspname = 'm20_output_truncated' AND t.relname = 'job_questions' AND c.conname = 'job_questions_review_reason_check'`)).rows;
                const before = await defOf();
                assert.equal(before.length, 1);
                await applySql(client, sql);
                assert.deepEqual(await defOf(), before, '再套一次：約束定義不變');
                const { rows: [kept] } = await client.query('SELECT review_reason FROM job_questions WHERE id = $1', [jq.id]);
                assert.equal(kept.review_reason, 'output_truncated', '再套一次不動資料');
            });
        });

        test('測試庫（migrate:test 已套到最新）有 0020、接受 output_truncated', async () => {
            const { rows } = await query('SELECT 1 FROM schema_migrations WHERE version = $1', [M20]);
            assert.equal(rows.length, 1, 'migrate:test 要套到 0020');
            assert.equal(await jobRunner.outputTruncatedAccepted({ query }), true);
        });
    });

    describe('runner＋真的 verify agent：本機截斷不重試、Gemini 照舊重試', () => {
        async function seed() {
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            jobIds.push(job.id);
            const payload = { extract: { subject: '數學', chapter: '向量', question_text: '求 1+1 的值。', answer_text: '2', question_type: '計算' } };
            const { rows: [jq] } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1001, 'source_checked', $2::jsonb) RETURNING id`,
                [job.id, JSON.stringify(payload)]);
            return { jobId: job.id, jqId: jq.id };
        }

        async function runWith(model) {
            process.env.MODEL_VERIFY = model;
            process.env.MODEL_EXTRACT = model.startsWith('ollama:') ? 'ollama:qwen3-vl:8b' : 'gemini:gemini-3.5-flash';
            const { jobId, jqId } = await seed();
            const calls = [];
            const llm = {
                async generateJson(args) {
                    calls.push(args);
                    throw Object.assign(new SyntaxError('Unterminated string in JSON at position 3071'), { errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' });
                },
                async embed() { throw new Error('不該算向量'); }
            };
            const r = jobRunner.createRunner({ llm, logger: QUIET, sleep: async () => { }, config: { renewIntervalMs: 60000 } });
            await r.runJobQuestion(jqId);
            const { rows: [jq] } = await query('SELECT state, review_reason, retries FROM job_questions WHERE id = $1', [jqId]);
            const { rows: events } = await query('SELECT node, outcome, error_class, detail FROM job_events WHERE job_id = $1 ORDER BY id', [jobId]);
            return { jq, events, calls };
        }

        before(async () => { await query('SELECT 1'); });

        test('本機（ollama:qwen3:8b）：一次就 needs_review(output_truncated)、retries 不動、事件記 finish_reason', async () => {
            const { jq, events, calls } = await runWith('ollama:qwen3:8b');
            assert.equal(calls.length, 1, '只呼叫一次（第一次採樣就截斷）');
            assert.equal(calls[0].model, 'ollama:qwen3:8b');
            assert.deepEqual([jq.state, jq.review_reason, jq.retries], ['needs_review', 'output_truncated', {}]);
            assert.equal(events.length, 1);
            assert.deepEqual([events[0].node, events[0].outcome, events[0].error_class], ['verify', 'error', 'schema_invalid']);
            assert.equal(events[0].detail.finish_reason, 'MAX_TOKENS');
            assert.equal(events[0].detail.review_reason, 'output_truncated');
        });

        test('Gemini：照舊留在 source_checked、verify:error＝1（之後會重試），不是 output_truncated', async () => {
            const { jq, events } = await runWith('gemini:gemini-3.1-pro-preview');
            assert.deepEqual([jq.state, jq.review_reason, jq.retries], ['source_checked', null, { 'verify:error': 1 }]);
            assert.equal(events[0].detail.finish_reason, 'MAX_TOKENS');
        });
    });
}
