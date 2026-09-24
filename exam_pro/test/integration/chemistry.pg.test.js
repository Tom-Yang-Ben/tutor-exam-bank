// ─────────────────────────────────────────────────────────────
// chemistry.pg.test.js — 化學整條鏈路的整合測試（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條、ADR-010）
//
// 走真的 HTTP 路徑、真的 runner、**真的 agents/**，只有 LLM 是注入的假物件（依 agent 名回應）：
//   上傳（subject_group）→ 拆題（extract_chem）→ 六個節點 → 入庫（subject=化學）
//   → 題庫列表 → NLQ 規則路徑 → 組卷 → 批改 → 弱點面板 → Word 匯出 → 變式（variant_chem）。
// 另外驗 POST /api/jobs 的 subject_group 參數驗證（400）、預設值與冪等鍵。
//
// 三道防線與其他整合測試相同：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// 在 require config/db.js 之前覆寫 DATABASE_URL。不連 Gemini、不需金鑰、不讀 cassette。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('化學整條鏈路整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
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

    /** 清掉 app 與 routes 的快取再載入（限流器是模組層單例；FEATURE_STUDENTS 在 require 當下讀） */
    function freshApp() {
        for (const key of Object.keys(require.cache)) {
            if (key === path.join(APP_DIR, 'app.js') || key === path.join(APP_DIR, 'routes', 'index.js')) delete require.cache[key];
        }
        const saved = process.env.FEATURE_STUDENTS;
        process.env.FEATURE_STUDENTS = 'true';
        try {
            return require(path.join(APP_DIR, 'app'));
        } finally {
            if (saved === undefined) delete process.env.FEATURE_STUDENTS;
            else process.env.FEATURE_STUDENTS = saved;
        }
    }

    const app = freshApp();
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const nlq = require(path.join(APP_DIR, 'services', 'nlqService'));
    const variantService = require(path.join(APP_DIR, 'services', 'variantService'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));
    const JOBS_DIR = path.join(APP_DIR, 'data', 'jobs');

    // ─────────────────── 假 LLM：依 agent 名回應 ───────────────────

    const CHEM_QS = [
        {
            subject: '化學', chapter: '緩衝溶液', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
            question_text: '自製化學題一：將 $0.10$ 莫耳醋酸與 $0.10$ 莫耳醋酸鈉溶於水配成 $1.0$ 升緩衝溶液，已知 $K_a = 1.8\\times10^{-5}$，求此緩衝溶液的氫離子濃度。',
            answer_text: '$[\\ce{H+}] = 1.8\\times10^{-5}$ M'
        },
        {
            subject: '化學', chapter: '化學式與化學反應式', chapter_confidence: 0.9, question_type: '填空', difficulty: 2,
            question_text: '自製化學題二：碳在充足的氧氣中完全燃燒，寫出唯一生成物的化學式，並寫出平衡的反應式 $\\ce{C + O2 -> CO2}$ 中各物質的係數。',
            answer_text: '$\\ce{CO2}$'
        }
    ];

    const VARIANT = {
        chapter: '緩衝溶液', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
        question_text: '自製變式：實驗室把 $0.20$ 莫耳氨水與 $0.10$ 莫耳氯化銨混合配成 $2.0$ 升溶液，已知氨的 $K_b = 1.8\\times10^{-5}$，試求溶液中的氫氧根離子濃度。',
        answer_text: '$[\\ce{OH-}] = 3.6\\times10^{-5}$ M'
    };

    const USAGE = { tokenIn: 100, tokenOut: 10, tokenThinking: 0, tokenCached: 0 };
    const fakeLlm = {
        calls: [],
        embedOk: false,
        async generateJson(opts) {
            fakeLlm.calls.push({ agent: opts.agent, template: opts.template, schema: opts.schema, system: opts.system });
            const text = (opts.parts || []).map(p => p.text || '').join('\n');
            let data;
            if (opts.agent === 'extract_chem') data = { questions: CHEM_QS };
            else if (opts.agent === 'variant_chem') data = VARIANT;
            else if (opts.agent === 'verify_chem') {
                if (text.includes('自製化學題一')) data = { final_answer: '1.8e-5 M', answer_form: 'number', steps_summary: '緩衝溶液中 [H+] = Ka × [酸]/[鹽]。' };
                else if (text.includes('自製變式')) data = { final_answer: '3.6e-5 mol/L', answer_form: 'number', steps_summary: '[OH-] = Kb × [鹼]/[鹽]。' };
                else data = { final_answer: '$\\ce{CO2}$', answer_form: 'expression', steps_summary: '碳完全燃燒生成二氧化碳。' };
            } else {
                throw new Error(`這個測試不該呼叫 agent「${opts.agent}」`);
            }
            return { data, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
        },
        async embed({ texts }) {
            if (!fakeLlm.embedOk) throw new Error('EMBED 不可用（測試故意的）');
            const a = new Array(768).fill(0); a[0] = 1;
            const b = new Array(768).fill(0); b[0] = 0.95; b[1] = Math.sqrt(1 - 0.95 * 0.95);
            return { vectors: texts.map((_, i) => (i === 0 ? a : b)), usage: { tokenIn: 1 } };
        }
    };

    function makeRunner() {
        return createRunner({
            db: { pool, query }, llm: fakeLlm,
            logger: { info() { }, warn() { }, error() { } },
            sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { nodeTimeoutMs: 5000, leaseMs: 60000, concurrency: 2, variantAutoApprove: true }
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

    async function makePdf(label) {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        page.drawText(`chemistry ${label}`, { x: 20, y: 150, size: 12 });
        return Buffer.from(await doc.save());
    }

    async function truncateAll() {
        for (let i = 1; ; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempts, exam_papers, students, questions CASCADE');
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= 10) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
            }
        }
    }

    describe('化學整條鏈路（PostgreSQL）', () => {
        before(async () => {
            fs.mkdirSync(JOBS_DIR, { recursive: true });
            await truncateAll();
        });

        after(async () => {
            await truncateAll();
            await pool.end();
        });

        // ─────────────────── POST /api/jobs 的 subject_group ───────────────────

        describe('POST /api/jobs — subject_group（第 4.2 條第 1 點）', () => {
            beforeEach(async () => { await truncateAll(); });

            test('不合法的值 → 400，不建 job', async () => {
                for (const bad of ['biology', 'Chemistry', '化學']) {
                    const res = await request(freshApp()).post('/api/jobs')
                        .field('subject_group', bad).attach('pdf', await makePdf('bad'), 'exam.pdf');
                    assert.equal(res.status, 400, bad);
                    assert.deepEqual(res.body, { message: 'subject_group 只能是 math_physics 或 chemistry。' });
                }
                const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs');
                assert.equal(rows[0].n, 0);
            });

            test('沒帶 → 預設 math_physics；GET /api/jobs/:id 回 subject_group', async () => {
                const res = await request(freshApp()).post('/api/jobs').attach('pdf', await makePdf('default'), 'exam.pdf');
                assert.equal(res.status, 202);
                const got = await request(app).get(`/api/jobs/${res.body.job_id}`);
                assert.equal(got.status, 200);
                assert.equal(got.body.subject_group, 'math_physics');
                // 既有欄位仍在（附加鍵，不動形狀）
                for (const k of ['id', 'state', 'counts', 'token_in', 'token_out', 'cost_usd', 'budget_usd', 'elapsed_ms']) {
                    assert.ok(k in got.body, k);
                }
            });

            test('chemistry 寫進 jobs.subject_group；冪等鍵含卷別（同一份 PDF 換卷別會建新 job）', async () => {
                const api = freshApp();
                const pdf = await makePdf('idem');
                const math = await request(api).post('/api/jobs').attach('pdf', pdf, 'exam.pdf');
                const chem = await request(api).post('/api/jobs').field('subject_group', 'chemistry').attach('pdf', pdf, 'exam.pdf');
                assert.equal(chem.status, 202);
                assert.equal(chem.body.existing, false);
                assert.notEqual(chem.body.job_id, math.body.job_id);
                const again = await request(api).post('/api/jobs').field('subject_group', 'chemistry').attach('pdf', pdf, 'exam.pdf');
                assert.deepEqual(again.body, { job_id: chem.body.job_id, existing: true });
                const { rows } = await query('SELECT subject_group FROM jobs WHERE id = $1', [chem.body.job_id]);
                assert.equal(rows[0].subject_group, 'chemistry');
            });
        });

        // ─────────────────── 管線 → 題庫 → 下游功能 ───────────────────

        describe('化學卷走完管線，入庫後下游功能都能用', () => {
            let jobId;
            let ids = {};

            before(async () => {
                await truncateAll();
                fakeLlm.calls = [];
                fakeLlm.embedOk = false;
                const res = await request(freshApp()).post('/api/jobs')
                    .field('subject_group', 'chemistry').attach('pdf', await makePdf('pipeline'), 'chem.pdf');
                assert.equal(res.status, 202);
                jobId = res.body.job_id;
                await drain(makeRunner());
                const { rows } = await query(
                    `SELECT q.id, q.chapter FROM questions q JOIN job_questions jq ON jq.question_id = q.id
                      WHERE jq.job_id = $1 ORDER BY q.id`, [jobId]);
                ids = Object.fromEntries(rows.map(r => [r.chapter, r.id]));
            });

            test('extract／verify 走化學模板（extract_chem、verify_chem），classify 與 lint 的零成本閘門直接放行', () => {
                const agents = fakeLlm.calls.map(c => c.agent).sort();
                assert.deepEqual(agents, ['extract_chem', 'verify_chem', 'verify_chem']);
                const ex = fakeLlm.calls.find(c => c.agent === 'extract_chem');
                assert.equal(ex.template, 'extract_chem.v1');
                assert.deepEqual(ex.schema.properties.questions.items.properties.subject.enum, ['化學']);
                assert.equal(ex.schema.properties.questions.items.properties.chapter.enum.length, 44);
            });

            test('兩題都入庫，科目是化學；job 收成 done，GET /api/jobs/:id 回 chemistry', async () => {
                const { rows } = await query(
                    `SELECT jq.state, q.subject, q.chapter FROM job_questions jq LEFT JOIN questions q ON q.id = jq.question_id
                      WHERE jq.job_id = $1 ORDER BY jq.idx`, [jobId]);
                assert.deepEqual(rows.map(r => r.state), ['saved', 'saved'], JSON.stringify(rows));
                assert.ok(rows.every(r => r.subject === '化學'));
                const job = await request(app).get(`/api/jobs/${jobId}`);
                assert.equal(job.body.state, 'done');
                assert.equal(job.body.subject_group, 'chemistry');
                assert.deepEqual(job.body.counts, { saved: 2, needs_review: 0, pending: 0, rejected: 0 });
            });

            test('verify 的比對：數值＋單位（M）與化學式（\\ce{CO2}）都判 agree', async () => {
                const { rows } = await query(
                    `SELECT payload->'verify'->>'compare' AS compare FROM job_questions WHERE job_id = $1`, [jobId]);
                assert.deepEqual(rows.map(r => r.compare), ['agree', 'agree']);
            });

            test('題庫列表可以依化學篩選；手動新增化學題合法、生物不合法', async () => {
                const list = await request(app).get('/api/questions?subject=化學');
                assert.equal(list.status, 200);
                const items = list.body.questions || list.body.items || list.body;
                assert.ok(JSON.stringify(items).includes('自製化學題一'));

                const ok = await request(app).post('/api/questions').send({
                    subject: '化學', chapter: '溶解度', question_type: '填空', difficulty: 2,
                    question_text: '自製化學題三：由溶解度曲線判斷降溫時析出的晶體質量。', answer_text: '$12$ 克'
                });
                assert.equal(ok.status, 201, JSON.stringify(ok.body));
                const bad = await request(app).post('/api/questions').send({
                    subject: '生物', chapter: '細胞', question_type: '填空', difficulty: 2, question_text: 'x', answer_text: 'y'
                });
                assert.equal(bad.status, 400);
                assert.equal(bad.body.message, '學科僅能為「數學」、「物理」或「化學」！');
            });

            test('NLQ：化學章節名走規則路徑（不呼叫 LLM），檢索落在化學題', async () => {
                const before = fakeLlm.calls.length;
                const body = await nlq.searchNl({ query: '緩衝溶液的計算題', limit: 10 }, { db: { pool, query }, llm: fakeLlm });
                assert.equal(fakeLlm.calls.length, before, 'NLQ 不該呼叫 generateJson');
                assert.equal(body.parse_path, 'rules');
                assert.equal(body.filters.subject, '化學');
                assert.deepEqual(body.filters.chapters, ['緩衝溶液']);
                assert.ok(body.results.some(r => r.id === ids['緩衝溶液']), JSON.stringify(body));
            });

            test('組卷 → 批改 → 弱點面板（subject=化學）', async () => {
                const st = await request(app).post('/api/students').send({ name: '化學測試生' });
                assert.equal(st.status, 201);
                const paper = await request(app).post('/api/generate-paper').send({
                    student_id: st.body.id, subject: '化學', chapter: '緩衝溶液', count: 1
                });
                assert.equal(paper.status, 200, JSON.stringify(paper.body));
                assert.deepEqual(paper.body.question_ids, [ids['緩衝溶液']]);

                const graded = await request(app).patch(`/api/papers/${paper.body.paper_id}/results`)
                    .send({ results: [{ question_id: ids['緩衝溶液'], result: 0 }] });
                assert.equal(graded.status, 200, JSON.stringify(graded.body));

                const weak = await request(app).get(`/api/students/${st.body.id}/weakness?subject=化學&days=365`);
                assert.equal(weak.status, 200);
                assert.deepEqual(weak.body.by_chapter.map(r => r.chapter), ['緩衝溶液']);
                assert.ok(weak.body.recent_wrong.some(r => r.question_id === ids['緩衝溶液']));
            });

            test('Word 匯出：\\ce 轉成原生方程式、化學式是正體', async () => {
                const res = await request(app).post('/api/download-word')
                    .send({ paper_title: '化學測試卷', student_name: '化學測試生', question_ids: [ids['化學式與化學反應式']] })
                    .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
                assert.equal(res.status, 200);
                const xml = documentXml(res.body);
                assert.ok(xml.includes('<m:oMath'), '化學式沒有轉成 Word 方程式');
                assert.ok(xml.includes('<m:sty m:val="p"/>'), '化學式應為正體');
                assert.ok(xml.includes('<m:t>→</m:t>'), '反應箭頭');
            });

            test('變式：化學藍本建的 job 標 chemistry，generate 走 variant_chem，新題以化學入庫', async () => {
                fakeLlm.embedOk = true;
                const before = fakeLlm.calls.length;
                const job = await variantService.createVariantJob({ pool, query }, ids['緩衝溶液'], { count: 1, difficultyDelta: 0, studentId: null });
                const { rows: j } = await query('SELECT subject_group FROM jobs WHERE id = $1', [job.job_id]);
                assert.equal(j[0].subject_group, 'chemistry');

                await drain(makeRunner());
                const agents = fakeLlm.calls.slice(before).map(c => c.agent);
                assert.ok(agents.includes('variant_chem'), agents.join(','));
                assert.ok(agents.includes('verify_chem'), agents.join(','));

                const { rows } = await query(
                    `SELECT jq.state, q.subject, q.chapter, q.origin, q.variant_of FROM job_questions jq
                       LEFT JOIN questions q ON q.id = jq.question_id WHERE jq.job_id = $1`, [job.job_id]);
                assert.equal(rows.length, 1);
                assert.equal(rows[0].state, 'saved', JSON.stringify(rows));
                assert.equal(rows[0].subject, '化學');
                assert.equal(rows[0].origin, 'variant');
                assert.equal(rows[0].variant_of, ids['緩衝溶液']);
                fakeLlm.embedOk = false;
            });
        });
    });
}
