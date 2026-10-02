// ─────────────────────────────────────────────────────────────
// extractAnswerKey.pg.test.js — 本機拆題修正的整合測試（〔dec/r13-extract-fixes〕Owner 2026-10-02 同意；docs/local-mode.md 10.25）
//
// 在真的 PostgreSQL 上成立的三件事：
//   1. runner 用**真的** agents/extract.js（ocr 模式）拆一份 5 頁的卷（每塊 2 頁 → 3 塊；第 5 頁是解答頁），結構照
//      114-2 興大附中高二期末考數學 A：單選 1～5、多選 6～8、選填 A～H。OCR 與模型是假的，其餘節點用 test/fixtures/fakeAgents。
//      → 解答頁拆出的 8 題垃圾不建題（extract 事件記 skipped_answer_key 與頁碼）；模型編的答案全部清掉（answer_dropped）；
//        拆完整份後解答頁的答案回填到第 1～8 題（answer_src='answer_key'）；A～H 的那兩列解析不確定，不回填；
//        每題照舊停在 needs_review('ocr_only')。
//   2. 節點跑的期間解答頁剛好回填了這一列：runJobQuestion 寫回 payload 時保留回填的 answer_text／answer_src。
//   3. 答案是空的題（交叉驗證沒有停下來的）走到 save：停在 needs_review('awaiting_approval')，事件記 no_answer 與建議答案，
//      不以「略」自動入庫。
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
    test('本機拆題修正整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
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
    process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
    process.env.MODEL_VERIFY = 'ollama:qwen3:8b';

    const { PDFDocument } = require('pdf-lib');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const extract = require(path.join(APP_DIR, 'agents', 'extract'));
    const fakeCommon = require(path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents', '_fake.js'));

    const FAKE_AGENTS_DIR = path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents');
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');
    const QUIET = { info() { }, warn() { }, error() { } };

    const HEADER = '臺中市立興大附中 114 學年度第 2 學期 高二 期末考 數學科 A 卷';
    const KEY_ROWS = ['1. 2. 3. 4. 5. 1 3 4 5 2', '6. 7. 8. 12 245 145', 'A. B. C. D. E. 2 -2 12 5 7-9 72', "F. G. H. 4-3 -7 31 27 17'7"];
    const PAGES = {
        1: `${HEADER}\n\n一、單選題 請將答案畫記在答案卡上。\n\n1. …\n\n2. …\n\n3. …\n\n4. …\n\n5. …`,
        2: `${HEADER}\n\n二、多選題\n\n6. …\n\n7. …\n\n8. …\n\n三、選填題\n\nA. …`,
        3: `${HEADER}\n\nB. …\n\nC. …\n\nD. …\n\nE. …`,
        4: `${HEADER}\n\nF. …\n\nG. …\n\nH. 則 a·b = ⑮⑯`,
        5: [HEADER, '## 解答', ...KEY_ROWS].join('\n\n')
    };
    const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const typeOf = (l) => (/^[1-5]$/.test(l) ? '單選' : /^[6-8]$/.test(l) ? '多選' : '填空');
    const Q = (label) => ({
        subject: '數學', chapter: '矩陣的應用', chapter_confidence: 0.6, question_type: typeOf(label), difficulty: 3,
        question_text: `${label}. 第 ${label} 題：已知矩陣 $A$ 與向量 $\\vec{v}$，求下列各式的值（題幹 ${label}）。`,
        // 拆題模型自己編的答案（題目頁上沒有答案）：單選、多選幾乎全錯；選填題抄填答格
        answer_text: typeOf(label) === '填空' ? '⑮⑯' : '(4)'
    });
    const BY_CHUNK = {
        1: LABELS.slice(0, 9).map(Q),
        2: LABELS.slice(9).map(Q),
        3: Array.from({ length: 8 }, () => ({ ...Q('A'), question_text: `${HEADER} 解答 ${KEY_ROWS.join(' ')}`, answer_text: '1' }))
    };

    async function makeJob(pages) {
        const doc = await PDFDocument.create();
        for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
        const bytes = Buffer.from(await doc.save());
        const { rows } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'queued', 0.5, $2) RETURNING id`,
            [crypto.createHash('sha256').update(bytes).update(String(Math.random())).digest('hex'), pages]);
        const jobId = rows[0].id;
        fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.pdf`), bytes);
        await query('UPDATE jobs SET pdf_path = $2 WHERE id = $1', [jobId, path.posix.join('data', 'jobs', `${jobId}.pdf`)]);
        return jobId;
    }

    function agentsDirWith(overrides = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-agents-'));
        fs.writeFileSync(path.join(dir, 'extract.js'), `module.exports = require(${JSON.stringify(path.join(APP_DIR, 'agents', 'extract.js'))});`);
        for (const name of ['dedup', 'classify', 'lint', 'source_check', 'verify']) {
            const body = overrides[name] || `module.exports = require(${JSON.stringify(path.join(FAKE_AGENTS_DIR, `${name}.js`))});`;
            fs.writeFileSync(path.join(dir, `${name}.js`), body);
        }
        return dir;
    }

    after(async () => {
        await query('TRUNCATE job_events, job_questions, jobs CASCADE');
        await pool.end();
    });

    describe('runner × 真的 extract（ocr 模式）：5 頁、第 5 頁是解答頁', () => {
        let agentsDir;
        let jobId;
        const seen = [];

        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            fakeCommon.resetCounts();
            agentsDir = agentsDirWith();
            extract._setLocalDepsForTest({
                ocrPdf: async ({ fromPage, toPage }) => {
                    const pages = [];
                    for (let p = fromPage; p <= toPage; p++) pages.push({ page: p, markdown: PAGES[p], imagePath: null, figures: [] });
                    return { engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, replayed: false, dispose() { }, pages };
                },
                renderPages: async () => { throw new Error('ocr 模式不該轉圖給視覺模型'); },
                llmMode: () => 'live',
                ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
                numCtx: () => 16384
            });
            jobId = await makeJob(5);
            const llm = {
                async generateJson(opts) {
                    seen.push([opts.agent, opts.template, opts.cacheKeyParts.chunkNo]);
                    return { data: { questions: BY_CHUNK[opts.cacheKeyParts.chunkNo] }, latencyMs: 3, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, raw: null };
                },
                async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
            };
            const runner = createRunner({
                db: { pool, query }, llm, agentsDir, logger: QUIET, sleep: async () => { },
                estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { localExtract: true, localExtractMode: 'ocr', ocrEngine: 'paddle', pdfChunkPages: 2, nodeTimeoutMs: 20000, leaseMs: 60000, concurrency: 1 }
            });
            for (let i = 0; i < 200; i++) {
                await runner.tick();
                while (runner.inFlight > 0) await new Promise(r => setTimeout(r, 10));
                const { rows } = await query(
                    `SELECT (SELECT COUNT(*)::int FROM job_questions WHERE job_id = $1
                              AND state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped')) AS running,
                            (SELECT state FROM jobs WHERE id = $1) AS job_state`, [jobId]);
                if (rows[0].running === 0 && ['done', 'failed'].includes(rows[0].job_state)) break;
            }
        });

        after(() => {
            extract._setLocalDepsForTest({});
            fs.rmSync(agentsDir, { recursive: true, force: true });
            fs.rmSync(path.join(JOBS_DIR, `${jobId}.pdf`), { force: true });
        });

        test('三塊都送 extract_ocr.v3；job 跑完（done）', async () => {
            assert.deepEqual(seen, [['extract_ocr', 'extract_ocr.v3', 1], ['extract_ocr', 'extract_ocr.v3', 2], ['extract_ocr', 'extract_ocr.v3', 3]]);
            const { rows } = await query('SELECT state, error FROM jobs WHERE id = $1', [jobId]);
            assert.equal(rows[0].state, 'done', rows[0].error);
        });

        test('解答頁的 8 題垃圾不建題：只有 16 題（1001–1009、2001–2007）；第 3 塊的事件記 skipped_answer_key', async () => {
            const { rows } = await query('SELECT idx FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            assert.deepEqual(rows.map(r => r.idx), [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 2001, 2002, 2003, 2004, 2005, 2006, 2007]);
            const { rows: ev } = await query(
                `SELECT detail FROM job_events WHERE job_id = $1 AND node = 'extract' AND outcome = 'pass' ORDER BY id`, [jobId]);
            assert.equal(ev.length, 3);
            const d3 = ev[2].detail;
            assert.deepEqual([d3.chunk, d3.created, d3.rejected], [3, 0, 0]);
            assert.deepEqual(d3.skipped_answer_key, { pages: [5], count: 8 });
            assert.equal(d3.answer_key.entries.length, 16);
            assert.deepEqual(ev[0].detail.answer_key.answers_dropped, 9, '第 1 塊 9 題的答案都是編的');
            assert.equal('skipped_answer_key' in ev[0].detail, false);
        });

        test('回填：第 1～8 題的答案取自解答頁（answer_src=answer_key）；A～H 解析不確定、不回填；編的答案記在 answer_dropped', async () => {
            const { rows } = await query('SELECT idx, payload FROM job_questions WHERE job_id = $1 ORDER BY idx', [jobId]);
            const got = rows.map(r => [r.payload.extract.answer_text, r.payload.extract.answer_src ?? null]);
            assert.deepEqual(got.slice(0, 8), [
                ['(1)', 'answer_key'], ['(3)', 'answer_key'], ['(4)', 'answer_key'], ['(5)', 'answer_key'], ['(2)', 'answer_key'],
                ['(1)(2)', 'answer_key'], ['(2)(4)(5)', 'answer_key'], ['(1)(4)(5)', 'answer_key']
            ]);
            assert.ok(got.slice(8).every(([a, src]) => a === '' && src === null), JSON.stringify(got.slice(8)));
            for (const r of rows) assert.equal(r.payload.extract.answer_dropped.reason, 'not_on_page');
        });

        test('每題照舊停在 needs_review(ocr_only)；一題都不自動入庫', async () => {
            const { rows } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE job_id = $1', [jobId]);
            assert.ok(rows.every(r => r.state === 'needs_review' && r.review_reason === 'ocr_only' && r.question_id === null), JSON.stringify(rows));
        });
    });

    describe('runJobQuestion 寫回 payload 時保留同時回填的答案；答案是空的題停在 awaiting_approval', () => {
        let agentsDir;
        let jobId;

        before(async () => {
            await query('TRUNCATE job_events, job_questions, jobs CASCADE');
            // 假 verify：跑到一半時「解答頁回填」了這一列（與 applyAnswerKey 同一句 SQL），再回 no_claim
            const verifyBody = `
const { query } = require(${JSON.stringify(path.join(APP_DIR, 'config', 'db'))});
module.exports = { async run(ctx, input) {
    await query(\`UPDATE job_questions SET payload = jsonb_set(jsonb_set(payload, '{extract,answer_text}', to_jsonb($2::text)),
        '{extract,answer_src}', '"answer_key"'::jsonb) WHERE id = $1 AND COALESCE(payload->'extract'->>'answer_text', '') = ''\`, [ctx.jq.id, '(3)']);
    return { kind: 'pass', data: { skipped: false, final_answer: '14', answer_form: 'number', steps_summary: '算出來',
        claimed_answer: input.claimed_answer, compare: 'no_claim', samples: 1, suggested_answer: '14' } };
} };`;
            agentsDir = agentsDirWith({ verify: verifyBody });
            const { rows } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            jobId = rows[0].id;
        });

        after(() => fs.rmSync(agentsDir, { recursive: true, force: true }));

        function runnerFor() {
            return createRunner({
                db: { pool, query }, llm: { async generateJson() { throw new Error('不該呼叫模型'); }, async embed() { return { vectors: [], usage: { tokenIn: 0 } }; } },
                agentsDir, logger: QUIET, sleep: async () => { }, estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { nodeTimeoutMs: 20000, leaseMs: 60000, concurrency: 1, renewIntervalMs: 60000 }
            });
        }
        const EX = { subject: '數學', chapter: '矩陣的應用', chapter_confidence: 0.9, question_type: '單選', difficulty: 3, question_text: '2. 求 f(2)。(1) 10 (2) 12 (3) 14', answer_text: '' };

        test('verify 跑的期間被回填：寫回的 payload 保留 answer_text＝(3)、answer_src＝answer_key，verify 的結果也在', async () => {
            const { rows } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1002, 'source_checked', $2::jsonb) RETURNING id`,
                [jobId, JSON.stringify({ extract: EX, lint: { question_text: EX.question_text, answer_text: '' } })]);
            await runnerFor().runJobQuestion(rows[0].id);
            const { rows: [r] } = await query('SELECT state, payload FROM job_questions WHERE id = $1', [rows[0].id]);
            assert.equal(r.state, 'verified');
            assert.deepEqual([r.payload.extract.answer_text, r.payload.extract.answer_src], ['(3)', 'answer_key']);
            assert.equal(r.payload.verify.compare, 'no_claim');
            assert.equal(r.payload.verify.suggested_answer, '14');
        });

        test('答案是空的題走到 save（沒有 cross_check）：needs_review(awaiting_approval)、不入庫；事件記 no_answer 與建議答案', async () => {
            const { rows } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1003, 'deduped', $2::jsonb) RETURNING id`,
                [jobId, JSON.stringify({ extract: EX, lint: { question_text: EX.question_text, answer_text: '' }, verify: { compare: 'no_claim', final_answer: '14', suggested_answer: '14' } })]);
            await runnerFor().runJobQuestion(rows[0].id);
            const { rows: [r] } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE id = $1', [rows[0].id]);
            assert.deepEqual([r.state, r.review_reason, r.question_id], ['needs_review', 'awaiting_approval', null]);
            const { rows: ev } = await query(`SELECT outcome, error_class, detail FROM job_events WHERE jq_id = $1 AND node = 'save'`, [rows[0].id]);
            assert.equal(ev.length, 1);
            assert.deepEqual([ev[0].outcome, ev[0].error_class], ['skipped', null]);
            assert.deepEqual([ev[0].detail.reason, ev[0].detail.no_answer, ev[0].detail.suggested_answer], ['awaiting_approval', true, '14']);
        });

        test('答案有了（解答頁回填、lint 的是空的）：照常入庫，答案是回填的那一個', async () => {
            const { rows } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1004, 'deduped', $2::jsonb) RETURNING id`,
                [jobId, JSON.stringify({ extract: { ...EX, question_text: '4. 回填後入庫的題', answer_text: '(3)', answer_src: 'answer_key' }, lint: { question_text: '4. 回填後入庫的題', answer_text: '' }, dedup0: { text_hash: null } })]);
            await runnerFor().runJobQuestion(rows[0].id);
            const { rows: [r] } = await query('SELECT state, question_id FROM job_questions WHERE id = $1', [rows[0].id]);
            assert.equal(r.state, 'saved');
            const { rows: [q] } = await query('SELECT answer_text FROM questions WHERE id = $1', [r.question_id]);
            assert.equal(q.answer_text, '(3)');
            await query('UPDATE job_questions SET question_id = NULL WHERE id = $1', [rows[0].id]);
            await query('DELETE FROM questions WHERE id = $1', [r.question_id]);
        });

        // 〔審查 dec/r13-extract-fixes〕回填的答案沒有跟驗算比過（verify 跑的時候答案還是空的、記 no_claim）：save 前補比一次
        test('回填＋verify 是 no_claim：建議答案對得上（(3) 對 14，選項 (3) 是 14）→ 照常入庫', async () => {
            const { rows } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1005, 'deduped', $2::jsonb) RETURNING id`,
                [jobId, JSON.stringify({
                    extract: { ...EX, question_text: '5. 求 g(2)。(1) 10 (2) 12 (3) 14', answer_text: '(3)', answer_src: 'answer_key' },
                    lint: { question_text: '5. 求 g(2)。(1) 10 (2) 12 (3) 14', answer_text: '' },
                    verify: { compare: 'no_claim', final_answer: '14', answer_form: 'number', suggested_answer: '14' }, dedup0: { text_hash: null }
                })]);
            await runnerFor().runJobQuestion(rows[0].id);
            const { rows: [r] } = await query('SELECT state, question_id FROM job_questions WHERE id = $1', [rows[0].id]);
            assert.equal(r.state, 'saved');
            await query('UPDATE job_questions SET question_id = NULL WHERE id = $1', [rows[0].id]);
            await query('DELETE FROM questions WHERE id = $1', [r.question_id]);
        });

        test('回填＋verify 是 no_claim：建議答案對不上（(3) 對 12）→ needs_review(awaiting_approval)、不入庫；事件記 answer_key_check', async () => {
            const { rows } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1006, 'deduped', $2::jsonb) RETURNING id`,
                [jobId, JSON.stringify({
                    extract: { ...EX, question_text: '6. 求 h(2)。(1) 10 (2) 12 (3) 14', answer_text: '(3)', answer_src: 'answer_key' },
                    lint: { question_text: '6. 求 h(2)。(1) 10 (2) 12 (3) 14', answer_text: '' },
                    verify: { compare: 'no_claim', final_answer: '12', answer_form: 'number', suggested_answer: '12' }, dedup0: { text_hash: null }
                })]);
            await runnerFor().runJobQuestion(rows[0].id);
            const { rows: [r] } = await query('SELECT state, review_reason, question_id FROM job_questions WHERE id = $1', [rows[0].id]);
            assert.deepEqual([r.state, r.review_reason, r.question_id], ['needs_review', 'awaiting_approval', null]);
            const { rows: ev } = await query(`SELECT outcome, detail FROM job_events WHERE jq_id = $1 AND node = 'save'`, [rows[0].id]);
            assert.equal(ev.length, 1);
            assert.equal(ev[0].outcome, 'skipped');
            assert.deepEqual(ev[0].detail.answer_key_check, { compare: 'disagree', key_answer: '(3)', suggested_answer: '12' });
        });
    });
}
