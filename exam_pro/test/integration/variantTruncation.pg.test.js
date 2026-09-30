// ─────────────────────────────────────────────────────────────
// test/integration/variantTruncation.pg.test.js — 變式生成本機截斷不重試（〔Owner 第七輪 R7-1＝4〕dec/r10-variant-cap；
// docs/local-mode.md 10.24）
//
// 真的 PostgreSQL＋真的 runner（workers/jobRunner.js 的 runGenerateJob → runGenerateOne）＋真的 agents/generateVariant.js，
// llm 依 cacheKeyParts.idx 決定這一題回什麼：本機（ollama）的截斷走**真的 services/llm**（live，假的 Ollama 傳輸回
// done_reason=length），其餘（合格、逾時、Gemini 的截斷）由假 llm 直接回：
//   1. 變式模型是 ollama、第 1 題被截斷（finishReason='MAX_TOKENS'）→ 第 1 題只呼叫一次、不退避、不建列，
//      generate 事件記 finish_reason、truncated、max_output_tokens（這一次實際送給 Ollama 的 num_predict：本機預設 1024；
//      .env 覆寫時照寫的；取消預設時沒送、記 null）與說明；job 繼續第 2 題（沒有兄弟）、建成、轉 processing，不 failed。
//      〔審查 dec/r10-variant-cap〕回放（replay）時沒有送出請求：事件的 max_output_tokens 記 null，不依當下的 env 重算。
//   2. 只要 1 題、那一題被截斷 → 一題都沒建成：job failed，error 是第 4.1 條那句（與沒過閘門相同）。
//   3. 非截斷的 error（本機逾時）照舊退避重試 maxErrorRetries 次；Gemini 的截斷也照舊重試（事件不多 finish_reason）。
// 需要 TEST_DATABASE_URL（庫名以 _test 結尾）；沒設時整檔跳過。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('變式截斷不重試整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JOB_RUNNER = 'off';
    const ENV = ['MODEL_VARIANT', 'OLLAMA_MAX_OUTPUT_VARIANT', 'VARIANT_OFFTOPIC_SIM_MIN', 'VARIANT_MIN_EDIT', 'LLM_MODE', 'EVAL_CASSETTE_DIR'];
    const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const variantService = require(path.join(APP_DIR, 'services', 'variantService'));
    const { DEFAULT_LIMITS } = require(path.join(APP_DIR, 'pipeline', 'stateMachine'));
    const fs = require('node:fs');
    const os = require('node:os');
    const realLlm = require(path.join(APP_DIR, 'services', 'llm'));
    const ollama = require(path.join(APP_DIR, 'services', 'llm', 'ollama'));
    const throttle = require(path.join(APP_DIR, 'services', 'llm', 'throttle'));
    const fakeReplay = require(path.join(APP_DIR, 'services', 'llm', 'fake'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '變式截斷-'));

    const DIM = 768;
    const MAX_ERROR_RETRIES = DEFAULT_LIMITS.maxErrorRetries;
    const QUIET = { info() { }, warn() { }, error() { } };
    const jobIds = [];
    const questionIds = [];

    /** 合格的變式輸出（與 test/unit/agentGenerateVariant.test.js 的 GOOD 同形；每題換數字，文字閘門與去重都過得了） */
    const goodFor = (idx) => ({
        chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
        question_text: `在平面上，第 ${idx} 艘船的位移為 $\\vec{p}=(${6 * idx},${8 * idx})$ 公里，另一艘船的位移為 $\\vec{q}=(5,-12)$ 公里。試求兩船位移方向之間夾角的餘弦值為何？`,
        answer_text: '$-\\frac{27}{65}$'
    });
    const unit = () => { const v = new Array(DIM).fill(0); v[0] = 1; return v; };

    const truncatedError = () => Object.assign(new SyntaxError('Unterminated string in JSON at position 1023'),
        { errorClass: 'schema_invalid', finishReason: 'MAX_TOKENS' });
    const timeoutError = () => Object.assign(new Error('Ollama /api/chat 逾時'), { errorClass: 'timeout' });

    /** 假的 Ollama 傳輸：一律寫到輸出上限被截斷（done_reason=length），記下每一次送出的 options */
    function truncatingOllama() {
        const sent = [];
        ollama._setTransportForTest(async (url, payload) => {
            sent.push(JSON.parse(JSON.stringify(payload.options)));
            return {
                status: 200,
                text: JSON.stringify({
                    model: payload.model, done: true, done_reason: 'length',
                    message: { role: 'assistant', content: '{"chapter":"向量內積","question_text":"在平面上，甲船的位移為' },
                    prompt_eval_count: 900, eval_count: 1024
                })
            };
        });
        return sent;
    }

    /** 以 LLM_MODE＝mode 呼叫真的 services/llm（呼叫完還原 LLM_MODE；record 的訊息不印） */
    async function viaRealLlm(mode, args) {
        const before = process.env.LLM_MODE;
        const origLog = console.log;
        process.env.LLM_MODE = mode;
        console.log = () => { };
        try {
            return await realLlm.generateJson(args);
        } finally {
            console.log = origLog;
            if (before === undefined) delete process.env.LLM_MODE; else process.env.LLM_MODE = before;
        }
    }

    /**
     * 假 llm：behave(idx, n) 回 'truncate'｜'truncate_replay'｜'timeout'｜'pass'（n＝這一題第幾次被呼叫，1 起算）。記下每一次呼叫。
     *   'truncate'：模型是 ollama 時走真的 services/llm（live）＋假的 Ollama（被截斷；錯誤物件帶實際送出的 num_predict）；
     *               不是 ollama（Gemini）時直接丟被截斷的錯。
     *   'truncate_replay'：先以 record 錄成「被截斷」錯誤回放檔（不交給 runner），再以 replay 回放同一支，把回放丟的錯交給 runner。
     * 交給 runner 的錯記在 thrown（事件的 message 以它為準）。
     */
    function fakeLlm(behave) {
        const calls = [];
        const thrown = [];
        const seen = new Map();
        return {
            calls, thrown,
            async generateJson(args) {
                const idx = args.cacheKeyParts && args.cacheKeyParts.idx;
                const n = (seen.get(idx) || 0) + 1;
                seen.set(idx, n);
                calls.push({ idx, n, model: args.model, agent: args.agent, siblings: args.cacheKeyParts.siblings, maxOutputTokens: args.maxOutputTokens });
                const what = behave(idx, n);
                const local = String(args.model || '').startsWith('ollama:');
                if (what === 'truncate' || what === 'truncate_replay') {
                    let err = null;
                    if (what === 'truncate' && !local) {
                        err = truncatedError();
                    } else {
                        if (what === 'truncate_replay') await viaRealLlm('record', args).catch(() => { });
                        await viaRealLlm(what === 'truncate' ? 'live' : 'replay', args).catch((e) => { err = e; });
                    }
                    assert.ok(err, '應該丟出被截斷的錯');
                    thrown.push(err);
                    throw err;
                }
                if (what === 'timeout') throw timeoutError();
                return { data: goodFor(idx), usage: { tokenIn: 900, tokenOut: 180, tokenThinking: 0, tokenCached: 0 }, latencyMs: 5, raw: {}, schemaFallback: false };
            },
            async embed({ texts }) {
                return { vectors: texts.map(() => unit()), usage: { tokenIn: 10 } };
            }
        };
    }

    async function seedJob(count) {
        const { rows: [q] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin, chapter_src, embedding)
             VALUES ('數學', '向量內積', '計算', 3, $1, '$\\frac{11}{5\\sqrt{5}}$', 'seed', 'human', $2::vector) RETURNING id`,
            [`截斷測試藍本（${Math.random().toString(36).slice(2)}）：設 $\\vec{a}=(3,4)$、$\\vec{b}=(1,2)$，求兩向量的夾角餘弦值。`,
                `[${unit().join(',')}]`]);
        questionIds.push(q.id);
        const created = await variantService.createVariantJob({ pool, query }, q.id, { count, difficultyDelta: 0, studentId: null }, 0.3);
        jobIds.push(created.job_id);
        return created.job_id;
    }

    async function run(jobId, llm) {
        const sleeps = [];
        const runner = createRunner({
            db: { pool, query }, llm, logger: QUIET,
            sleep: async (ms) => { sleeps.push(ms); },
            config: { nodeTimeoutMs: 5000, leaseMs: 60000, renewIntervalMs: 60000 }
        });
        await runner.runGenerateJob(jobId);
        const { rows: [job] } = await query('SELECT state, error FROM jobs WHERE id = $1', [jobId]);
        const { rows: jqs } = await query('SELECT idx, state FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
        const { rows: events } = await query(
            `SELECT attempt, model, outcome, error_class, detail FROM job_events
              WHERE job_id = $1 AND node = 'generate' AND outcome <> 'skipped' ORDER BY id`, [jobId]);
        return { job, jqs, events, sleeps };
    }

    before(async () => { await query('SELECT 1'); });
    beforeEach(() => {
        for (const k of ENV) delete process.env[k];
        process.env.EVAL_CASSETTE_DIR = path.join(tmp, `cassettes-${Math.random().toString(36).slice(2)}`);
        ollama._resetForTest();
        throttle._resetForTest();
        fakeReplay._resetForTest();
        process.env.VARIANT_OFFTOPIC_SIM_MIN = '0.90';
        process.env.VARIANT_MIN_EDIT = '0.08';
    });
    after(async () => {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        if (jobIds.length) {
            await query('DELETE FROM job_events WHERE job_id = ANY($1::bigint[])', [jobIds]);
            await query('DELETE FROM job_questions WHERE job_id = ANY($1::bigint[])', [jobIds]);
            await query('DELETE FROM jobs WHERE id = ANY($1::bigint[])', [jobIds]);
        }
        if (questionIds.length) await query('DELETE FROM questions WHERE id = ANY($1::bigint[])', [questionIds]);
        ollama._resetForTest();
        fs.rmSync(tmp, { recursive: true, force: true });
        await pool.end();
    });

    describe('runGenerateOne：本機截斷不重試、寫事件、繼續下一題', () => {
        test('ollama：第 1 題被截斷 → 只呼叫一次、不退避、不建列、事件記原因與上限 1024；第 2 題照常建成（沒有兄弟），job 轉 processing', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            const sent = truncatingOllama();
            const jobId = await seedJob(2);
            const llm = fakeLlm((idx) => (idx === 1 ? 'truncate' : 'pass'));
            const { job, jqs, events, sleeps } = await run(jobId, llm);
            assert.deepEqual(sent.map(o => o.num_predict), [1024], '真的送給 Ollama 的是本機預設 1024');
            assert.equal(llm.thrown[0].appliedNumPredict, 1024);

            assert.deepEqual(llm.calls.map(c => [c.idx, c.n]), [[1, 1], [2, 1]], '第 1 題不重試');
            assert.equal(llm.calls[0].model, 'ollama:qwen3:8b');
            assert.equal(llm.calls[0].agent, 'variant');
            assert.equal(llm.calls[0].maxOutputTokens, undefined, 'agent 不帶上限（本機預設由 services/llm 套）');
            assert.deepEqual(llm.calls[1].siblings, [], '被放棄的第 1 題不是兄弟');
            assert.deepEqual(sleeps, [], '沒有退避');

            assert.equal(job.state, 'processing');
            assert.equal(job.error, null);
            assert.deepEqual(jqs.map(r => r.idx), [2]);

            assert.equal(events.length, 2);
            const [cut, ok] = events;
            assert.deepEqual([cut.attempt, cut.outcome, cut.error_class], [1, 'error', 'schema_invalid']);
            assert.deepEqual(cut.detail, {
                idx: 1,
                message: llm.thrown[0].message,
                finish_reason: 'MAX_TOKENS',
                truncated: true,
                max_output_tokens: 1024,
                gave_up: true,
                note: '本機模型的回應寫到輸出上限（1024 token）被截斷：不重試，放棄這一題（Owner 第七輪 R7-1＝4；docs/local-mode.md 10.24）。'
            });
            assert.deepEqual([ok.outcome, ok.detail.idx], ['pass', 2]);
            assert.equal('truncated' in ok.detail, false);
        });

        test('.env 覆寫：OLLAMA_MAX_OUTPUT_VARIANT=2048 → 送 2048、事件記 2048；寫 8192（取消預設）→ 不送 num_predict、記 null', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            for (const [v, want] of [['2048', 2048], ['8192', null]]) {
                process.env.OLLAMA_MAX_OUTPUT_VARIANT = v;
                const sent = truncatingOllama();
                const jobId = await seedJob(1);
                const { events } = await run(jobId, fakeLlm(() => 'truncate'));
                assert.deepEqual(sent.map(o => o.num_predict), [want ?? undefined], `${v}：送出的 num_predict`);
                assert.equal(events.length, 1, v);
                assert.equal(events[0].detail.max_output_tokens, want, v);
                assert.equal(events[0].detail.truncated, true);
            }
        });

        test('〔審查 dec/r10-variant-cap〕回放（replay）的截斷：照樣放棄、不重試；沒有送出請求，max_output_tokens 記 null（不依當下的 env 算成 1024）', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            const sent = truncatingOllama();
            const jobId = await seedJob(1);
            const llm = fakeLlm(() => 'truncate_replay');
            const { events, sleeps, job } = await run(jobId, llm);
            assert.deepEqual(sent.map(o => o.num_predict), [1024], '只有錄製那一次送出請求（本機預設 1024）；回放沒有');
            assert.equal(llm.calls.length, 1, '不重試');
            assert.equal(llm.thrown[0].replayed, true);
            assert.equal('appliedNumPredict' in llm.thrown[0], false, '回放丟的錯不帶實際送出的上限');
            assert.deepEqual(sleeps, []);
            assert.equal(events.length, 1);
            assert.deepEqual(events[0].detail, {
                idx: 1,
                message: llm.thrown[0].message,
                finish_reason: 'MAX_TOKENS',
                truncated: true,
                max_output_tokens: null,
                gave_up: true,
                note: '本機模型的回應寫到輸出上限被截斷：不重試，放棄這一題（Owner 第七輪 R7-1＝4；docs/local-mode.md 10.24）。'
            });
            assert.equal(job.state, 'failed');
        });

        test('只要 1 題、那一題被截斷 → 一題都沒建成：job failed，error 是第 4.1 條那句', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            truncatingOllama();
            const jobId = await seedJob(1);
            const llm = fakeLlm(() => 'truncate');
            const { job, jqs, events } = await run(jobId, llm);
            assert.equal(llm.calls.length, 1);
            assert.deepEqual([job.state, job.error], ['failed', '變式生成全部未通過文字閘門或跑題檢查。']);
            assert.deepEqual(jqs, []);
            assert.equal(events.length, 1);
        });

        test('第 1 題第 2 次才被截斷（前一次是逾時）→ 逾時照舊退避重試一次、截斷那次就放棄', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            truncatingOllama();
            const jobId = await seedJob(1);
            const llm = fakeLlm((idx, n) => (n === 1 ? 'timeout' : 'truncate'));
            const { events, sleeps, job } = await run(jobId, llm);
            assert.deepEqual(llm.calls.map(c => c.n), [1, 2]);
            assert.equal(sleeps.length, 1);
            assert.deepEqual(events.map(e => [e.attempt, e.error_class, e.detail.truncated === true]), [[1, 'timeout', false], [2, 'schema_invalid', true]]);
            assert.equal(job.state, 'failed');
        });
    });

    describe('其他 error 照舊退避重試', () => {
        test('ollama 的逾時（不是截斷）：重試 maxErrorRetries 次才放棄，事件不記 truncated', async () => {
            process.env.MODEL_VARIANT = 'ollama:qwen3:8b';
            const jobId = await seedJob(2);
            const llm = fakeLlm((idx) => (idx === 1 ? 'timeout' : 'pass'));
            const { events, sleeps, jqs } = await run(jobId, llm);
            assert.equal(llm.calls.filter(c => c.idx === 1).length, 1 + MAX_ERROR_RETRIES);
            assert.equal(sleeps.length, MAX_ERROR_RETRIES);
            const firstIdx = events.filter(e => e.detail.idx === 1);
            assert.equal(firstIdx.length, 1 + MAX_ERROR_RETRIES);
            for (const e of firstIdx) {
                assert.equal(e.error_class, 'timeout');
                assert.equal('truncated' in e.detail, false);
                assert.equal('finish_reason' in e.detail, false);
            }
            assert.deepEqual(jqs.map(r => r.idx), [2], '第 1 題重試用完放棄，第 2 題照常');
        });

        test('Gemini 的截斷：照舊重試 maxErrorRetries 次，事件不多 finish_reason（與題目節點的 C-f 一致）', async () => {
            process.env.MODEL_VARIANT = 'gemini:gemini-3.1-pro-preview';
            const jobId = await seedJob(1);
            const llm = fakeLlm(() => 'truncate');
            const { events, sleeps } = await run(jobId, llm);
            assert.equal(llm.calls.length, 1 + MAX_ERROR_RETRIES);
            assert.equal(llm.calls[0].model, 'gemini:gemini-3.1-pro-preview');
            assert.equal(sleeps.length, MAX_ERROR_RETRIES);
            for (const e of events) {
                assert.equal(e.error_class, 'schema_invalid');
                assert.equal('finish_reason' in e.detail, false);
                assert.equal('truncated' in e.detail, false);
            }
        });
    });
}
