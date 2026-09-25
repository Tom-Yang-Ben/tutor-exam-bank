// ─────────────────────────────────────────────────────────────
// tutor.pg.test.js — POST /api/tutor 與 POST /api/voice/transcribe 的整合測試（階段 5 WS-E）
//
// 契約：docs/interfaces-stage5.md 第 4.5 條、第 1.6 條（每個新 API：400、旗標關閉 404、正常路徑）。
//
// 「以假 LLM 跑通一輪」選的是 **LLM_MODE=replay＋測試專用 cassette 目錄**，不是在 app 層注入 fake：
//   - 走的是正式的程式路徑：routes → controller → service → services/llm.generateText／generateJson
//     → fake.js 讀 cassette。app 與 controller 不需要為了測試多開一個注入口。
//   - cassette 寫在 os.tmpdir() 的暫存目錄（EVAL_CASSETTE_DIR），不進 repo 的 eval/cassettes，
//     CI 也不需要任何新 cassette（第 1.2 條）。
//   - 鍵怎麼來：家教用 tutorService.prepareTutorRequest（與 runTutor 同一支函式）算出實際要送的
//     llmOpts，再用 cassette.cassetteKey 算鍵——所以鍵與正式請求保證一致，而且可以順便斷言
//     「送出去的 prompt 裡沒有學生姓名」（DEC-009）。語音的鍵只含錄音雜湊、mime、科目，直接算。
//
// 三道防線同其他整合測試：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、require config/db 前先覆寫 DATABASE_URL。
// 整合測試不得假設別的 WS 已寫入資料（第 2 條）：知識點、題目—知識點、錯因都由本檔自己插 fixture。
// ─────────────────────────────────────────────────────────────
// 〔本機模式整合 LM-8〕本檔測的是 Gemini 路徑（Gemini 的模板、cassette、code execution／語音）。
// 預設模型改成本機後（docs/local-mode.md 第 2 條），在本檔的行程內明寫 Gemini；本機路徑另有
// test/integration/localExtract.pg.test.js 與 test/unit/llmOllama*.test.js 覆蓋。每個測試檔是獨立行程，不會外溢。
process.env.MODEL_EXTRACT = 'gemini:gemini-3.5-flash';
process.env.MODEL_VERIFY = 'gemini:gemini-3.1-pro-preview';
process.env.MODEL_TUTOR = 'gemini:gemini-3.1-pro-preview';
process.env.MODEL_VOICE = 'gemini:gemini-3.5-flash';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('AI 家教與語音轉寫整合測試（需要 PostgreSQL）', {
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
    // replay 模式（eval/.env.replay 已設；這裡再保險一次），cassette 只讀本檔的暫存目錄
    process.env.LLM_MODE = 'replay';
    const CASSETTE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-tutor-cassette-'));
    process.env.EVAL_CASSETTE_DIR = CASSETTE_DIR;
    delete process.env.TUTOR_DAILY_BUDGET_USD;

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

    /**
     * routes/index.js 在 require 當下讀旗標與限流設定，所以每一種組合都要清掉
     * app.js 與 routes/index.js 的快取重讀一次（config/db 的連線池不清，只有一個）。
     */
    function loadApp(env) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const keys = Object.keys(env);
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
        Object.assign(process.env, env);
        try {
            return require(APP_PATH);
        } finally {
            for (const k of keys) {
                if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
            }
        }
    }

    // 旗標組合：全關（語音單獨開也沒用）、只開家教、兩個都開（限流放寬，避免 400 案例把桶吃光）、限流很小
    const appOff = loadApp({ FEATURE_TUTOR: 'false', FEATURE_VOICE: 'true' });
    const appTutorOnly = loadApp({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'false', TUTOR_RATE_LIMIT_PER_MIN: '1000' });
    const app = loadApp({
        FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true',
        TUTOR_RATE_LIMIT_PER_MIN: '1000', VOICE_RATE_LIMIT_PER_MIN: '1000'
    });
    const appLimited = loadApp({
        FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true',
        TUTOR_RATE_LIMIT_PER_MIN: '2', VOICE_RATE_LIMIT_PER_MIN: '1'
    });

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const tutorService = require(path.join(APP_DIR, 'services', 'tutorService'));
    const voiceService = require(path.join(APP_DIR, 'services', 'voiceService'));
    const cassette = require(path.join(APP_DIR, 'services', 'llm', 'cassette'));
    const models = require(path.join(APP_DIR, 'config', 'models'));

    // ─────────────────── fixture ───────────────────

    async function seed() {
        await query(`INSERT INTO students (name) VALUES ('王小明'), ('陳大華')`);
        await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, solution_text, solution_src)
             VALUES ('數學', '向量內積', '計算', 3, '已知 $\\vec a=(1,2)$、$\\vec b=(3,4)$，求 $\\vec a\\cdot\\vec b$。', '$11$', '$1\\times3+2\\times4=11$', 'teacher'),
                    ('物理', '牛頓運動定律', '計算', 2, '質量 2 kg 的物體受 10 N 的力，加速度為何？', '$5\\,\\mathrm{m/s^2}$', NULL, NULL),
                    ('數學', '向量內積', '單選', 2, '自編測試題（同章第二題）', '(A)', NULL, NULL)`);
        await query(
            `INSERT INTO knowledge_components (code, subject, chapter, name, description, spoken_text, status, sort)
             VALUES ('MATH.向量內積.01', '數學', '向量內積', '內積的意義', '內積的幾何定義。', '這是一段草稿口語版，老師還沒審定，內容僅供測試使用而已。', 'draft', 1),
                    ('MATH.向量內積.02', '數學', '向量內積', '內積的坐標算法', '已知兩向量坐標時，內積等於對應分量乘積的和。',
                     '有坐標就不用管角度：x 跟 x 乘、y 跟 y 乘，全部加起來。三維就多加一個 z 乘 z。記得算出來是一個數字，不是向量。', 'approved', 2)`);
        // 題 1 兩個都標；題 3 不標（家教要退回同章）
        await query(`INSERT INTO question_kcs (question_id, kc_id, weight, src) VALUES (1, 1, 1, 'human'), (1, 2, 0.5, 'human')`);
        // 王小明：向量內積 2 題錯（錯因 calc、concept）、牛頓 1 題對
        await query(
            `INSERT INTO attempts (student_id, question_id, result, error_types, graded_at)
             VALUES (1, 1, 0, '{calc,concept}', now()), (1, 3, 0, '{calc}', now()), (1, 2, 1, '{}', now())`);
    }

    /** 以 prepareTutorRequest 算出正式請求會用的鍵，寫一支 cassette */
    async function recordTutorCassette(body, response) {
        const parsed = tutorService.validateTutorInput(body);
        assert.ok(parsed.value, parsed.error);
        const prepared = await tutorService.prepareTutorRequest(parsed.value);
        const key = cassette.cassetteKey({
            agent: prepared.llmOpts.agent, modelId: prepared.modelId, template: prepared.llmOpts.template,
            schema: undefined, cacheKeyParts: prepared.llmOpts.cacheKeyParts
        });
        cassette.writeCassette({
            agent: prepared.llmOpts.agent, key,
            meta: { agent: 'tutor', model: prepared.modelId, template: prepared.llmOpts.template, note: 'tutor.pg.test.js 手寫' },
            request: { parts: cassette.summarizeParts(prepared.llmOpts.parts), cacheKeyParts: prepared.llmOpts.cacheKeyParts },
            response
        });
        return prepared;
    }

    function recordVoiceCassette({ audio, mime, subject }, response) {
        const { id: modelId } = models.parseModel(models.MODEL_VOICE);
        const cacheKeyParts = {
            audio_sha256: crypto.createHash('sha256').update(audio).digest('hex'),
            mime,
            subject
        };
        const key = cassette.cassetteKey({ agent: 'voice', modelId, template: voiceService.TEMPLATE, schema: voiceService.SCHEMA, cacheKeyParts });
        cassette.writeCassette({ agent: 'voice', key, meta: { agent: 'voice', model: modelId }, request: { cacheKeyParts }, response });
    }

    function uploadsCount() {
        const dir = path.join(APP_DIR, 'uploads');
        return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    }

    const AUDIO = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), crypto.randomBytes(64)]);

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('AI 家教與語音轉寫 × PostgreSQL', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });

        beforeEach(async () => {
            await query(`TRUNCATE question_kcs, kc_prerequisites, knowledge_components, attempts, exam_papers, students, questions
                         RESTART IDENTITY CASCADE`);
            await seed();
        });

        after(async () => {
            await pool.end();
            fs.rmSync(CASSETTE_DIR, { recursive: true, force: true });
        });

        // ───────── 旗標 ─────────

        describe('旗標（第 1.3 條）', () => {
            test('FEATURE_TUTOR 關閉：兩條都不掛載（FEATURE_VOICE 單獨開也一樣），落到 Express 預設 404', async () => {
                for (const [method, url] of [['post', '/api/tutor'], ['post', '/api/voice/transcribe']]) {
                    const res = await request(appOff)[method](url).send({ message: 'a', mode: 'direct' });
                    assert.equal(res.status, 404, url);
                    assert.equal(res.body.message, undefined, `${url} 不該回我們自己的 { message }`);
                }
            });

            test('只開 FEATURE_TUTOR：家教有掛載、語音 404', async () => {
                const tutorRes = await request(appTutorOnly).post('/api/tutor').send({});
                assert.equal(tutorRes.status, 400);
                const voiceRes = await request(appTutorOnly).post('/api/voice/transcribe')
                    .attach('audio', AUDIO, { filename: 'a.wav', contentType: 'audio/wav' });
                assert.equal(voiceRes.status, 404);
                assert.equal(voiceRes.body.message, undefined);
            });
        });

        // ───────── POST /api/tutor ─────────

        describe('POST /api/tutor', () => {
            test('參數驗證 → 400 { message }', async () => {
                const cases = [
                    [{}, /message 必填/],
                    [{ message: '', mode: 'direct' }, /不可為空白/],
                    [{ message: 'x'.repeat(1001), mode: 'direct' }, /最長 1000 字/],
                    [{ message: 'a' }, /mode/],
                    [{ message: 'a', mode: 'lecture' }, /mode/],
                    [{ message: 'a', mode: 'direct', subject: '生物' }, /subject/],
                    [{ message: 'a', mode: 'direct', student_id: 'abc' }, /student_id/],
                    [{ message: 'a', mode: 'direct', question_id: -1 }, /question_id/],
                    [{ message: 'a', mode: 'direct', history: {} }, /history 要是陣列/],
                    [{ message: 'a', mode: 'direct', history: new Array(9).fill({ role: 'user', text: 'x' }) }, /最多 8 輪/],
                    [{ message: 'a', mode: 'direct', history: [{ role: 'assistant', text: 'x' }] }, /role/]
                ];
                for (const [body, re] of cases) {
                    const res = await request(app).post('/api/tutor').send(body);
                    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
                    assert.match(res.body.message, re);
                }
            });

            test('ID 超過 int4 → 400（不是 DB 的 out of range 500，也不在回應裡洩漏 DB 錯誤訊息）', async () => {
                const cases = [
                    [{ message: 'a', mode: 'direct', question_id: 99999999999 }, /question_id/],
                    [{ message: 'a', mode: 'direct', student_id: '99999999999' }, /student_id/],
                    [{ message: 'a', mode: 'direct', question_id: 1e21 }, /question_id/],
                    [{ message: 'a', mode: 'direct', question_id: 2147483648 }, /question_id/]
                ];
                for (const [body, re] of cases) {
                    const res = await request(app).post('/api/tutor').send(body);
                    assert.equal(res.status, 400, JSON.stringify(body));
                    assert.match(res.body.message, re);
                    assert.equal(res.body.error, undefined);
                }
                // 上限本身合法：查不到就是 404
                const max = await request(app).post('/api/tutor').send({ message: 'a', mode: 'direct', question_id: 2147483647 });
                assert.equal(max.status, 404);
            });

            test('題目或學生不存在 → 404 { message }', async () => {
                const q = await request(app).post('/api/tutor').send({ message: 'a', mode: 'direct', question_id: 999 });
                assert.equal(q.status, 404);
                assert.equal(q.body.message, '找不到該題目');
                const s = await request(app).post('/api/tutor').send({ message: 'a', mode: 'direct', student_id: 999 });
                assert.equal(s.status, 404);
                assert.equal(s.body.message, '找不到該學生');
            });

            test('正常路徑（replay）：脈絡從 DB 組出來、姓名不出境、驗算與用量原樣回傳', async () => {
                const body = {
                    message: '王小明說這題不會，可以一步一步帶他嗎？',
                    mode: 'socratic',
                    student_id: 1,
                    question_id: 1,
                    history: [{ role: 'user', text: '陳大華上次也問過' }, { role: 'tutor', text: '好的，我們慢慢來。' }]
                };
                const prepared = await recordTutorCassette(body, {
                    text: '學生#1 先想一想：兩個向量都有坐標時，內積怎麼算？\n\n**驗算**：以 Python 算得 11。',
                    codeRuns: [{ language: 'PYTHON', code: 'print(1*3+2*4)', outcome: 'OUTCOME_OK', output: '11\n' }],
                    usage: { tokenIn: 1200, tokenOut: 300, tokenThinking: 100, tokenCached: 0 }
                });

                // 送出去的內容（DB 組出來的脈絡）：姓名一個都不在，代號在；錯因與章節錯誤率來自 attempts
                const sent = prepared.llmOpts.system + JSON.stringify(prepared.llmOpts.parts) + JSON.stringify(prepared.llmOpts.cacheKeyParts);
                assert.ok(!sent.includes('王小明') && !sent.includes('陳大華'), '學生姓名出境了');
                const prompt = prepared.llmOpts.parts[0].text;
                assert.ok(prompt.includes('學生#1') && prompt.includes('學生#2'));
                assert.ok(prompt.includes('- 向量內積：批改 2 題、錯 2 題（100%）'), prompt);
                assert.ok(prompt.includes('- 計算錯誤：2 次'));
                assert.ok(prompt.includes('- 觀念不清：1 次'));
                assert.ok(prompt.includes('詳解（來源：老師撰寫）'));
                assert.ok(prompt.indexOf('〔老師已審定〕') < prompt.indexOf('〔草稿'), '審定的知識點要排在草稿前');
                assert.equal(prepared.llmOpts.template, 'tutor.socratic.v1');
                assert.deepEqual(prepared.llmOpts.tools, { codeExecution: true });

                const res = await request(app).post('/api/tutor').send(body);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['context', 'mode', 'reply', 'usage', 'verification']);
                assert.equal(res.body.mode, 'socratic');
                assert.ok(res.body.reply.startsWith('王小明 先想一想'), '回覆要換回姓名');
                assert.deepEqual(res.body.verification, {
                    used: true,
                    runs: [{ code: 'print(1*3+2*4)', outcome: 'OUTCOME_OK', output: '11\n' }]
                });
                assert.deepEqual(res.body.context, {
                    kc_codes: ['MATH.向量內積.02', 'MATH.向量內積.01'], student_context: true, question_id: 1
                });
                assert.equal(res.body.usage.tokenIn, 1200);
                assert.equal(res.body.usage.tokenOut, 400);
                assert.equal(res.body.usage.costUsd, tutorService.estimateUsd(prepared.modelId, { tokenIn: 1200, tokenOut: 300, tokenThinking: 100 }));
                assert.ok(res.body.usage.costUsd > 0);
            });

            test('題目沒有標註知識點 → 退回同章知識點；沒有學生 → student_context=false', async () => {
                const body = { message: '這題的觀念是什麼？', mode: 'direct', question_id: 3 };
                const prepared = await recordTutorCassette(body, { text: '這題考內積。\n\n**驗算**：本題不涉及數值計算', codeRuns: [], usage: {} });
                assert.match(prepared.llmOpts.parts[0].text, /這題還沒有標註知識點，以下是同一章的知識點/);
                const res = await request(app).post('/api/tutor').send(body);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(res.body.context, { kc_codes: ['MATH.向量內積.02', 'MATH.向量內積.01'], student_context: false, question_id: 3 });
                assert.deepEqual(res.body.verification, { used: false, runs: [] });
            });

            test('沒有題目、沒有知識點（物理題庫還沒有知識點）也能問', async () => {
                const body = { message: '牛頓第二定律怎麼用？', mode: 'direct', subject: '物理' };
                await recordTutorCassette(body, { text: '$F=ma$。', codeRuns: [], usage: { tokenIn: 10, tokenOut: 5 } });
                const res = await request(app).post('/api/tutor').send(body);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.context, { kc_codes: [], student_context: false });
            });

            test('cassette 記錄 finishReason=MAX_TOKENS（回覆被截斷）→ 200，回覆後面附上截斷提醒、仍然計費', async () => {
                const body = { message: '截斷測試：請完整推導', mode: 'direct', question_id: 1 };
                const prepared = await recordTutorCassette(body, {
                    text: '先列式：$1\\times3+2\\times4$，再來',
                    codeRuns: [],
                    finishReason: 'MAX_TOKENS',
                    usage: { tokenIn: 1000, tokenOut: 4000, tokenThinking: 2048, tokenCached: 0 }
                });
                assert.equal(prepared.llmOpts.thinkingBudget, tutorService.THINKING_BUDGET, '正式請求要帶 thinkingBudget');
                const res = await request(app).post('/api/tutor').send(body);
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(Object.keys(res.body).sort(), ['context', 'mode', 'reply', 'usage', 'verification']);
                assert.ok(res.body.reply.startsWith('先列式：'), res.body.reply);
                assert.ok(res.body.reply.endsWith(tutorService.TRUNCATED_NOTE), res.body.reply);
                assert.ok(res.body.usage.costUsd > 0);
            });

            test('沒有 cassette（replay miss）→ 502，訊息帶原因', async () => {
                const res = await request(app).post('/api/tutor').send({ message: '沒有錄過的問題', mode: 'direct' });
                assert.equal(res.status, 502);
                assert.match(res.body.message, /^AI 家教暫時無法回應：LLM_MODE=replay 找不到 cassette/);
            });

            test('每日預算用完 → 429（在呼叫 LLM 之前）；調回來就恢復', async () => {
                const body = { message: '預算測試', mode: 'direct' };
                await recordTutorCassette(body, { text: 'ok', codeRuns: [], usage: { tokenIn: 1, tokenOut: 1 } });
                process.env.TUTOR_DAILY_BUDGET_USD = '0';
                try {
                    const res = await request(app).post('/api/tutor').send(body);
                    assert.equal(res.status, 429);
                    assert.match(res.body.message, /預算已用完/);
                } finally {
                    delete process.env.TUTOR_DAILY_BUDGET_USD;
                }
                const again = await request(app).post('/api/tutor').send(body);
                assert.equal(again.status, 200);
            });

            test('限流 TUTOR_RATE_LIMIT_PER_MIN：第 3 次（上限 2）回 429', async () => {
                const statuses = [];
                for (let i = 0; i < 3; i++) statuses.push((await request(appLimited).post('/api/tutor').send({})).status);
                assert.deepEqual(statuses, [400, 400, 429]);
            });
        });

        // ───────── POST /api/voice/transcribe ─────────

        describe('POST /api/voice/transcribe', () => {
            test('參數驗證：沒有檔案、欄位名不對、mime 不對、科目不對 → 400；超過 5 MB → 413', async () => {
                const noFile = await request(app).post('/api/voice/transcribe').field('subject', '數學');
                assert.equal(noFile.status, 400);
                assert.match(noFile.body.message, /multipart 欄位 audio/);

                const wrongField = await request(app).post('/api/voice/transcribe')
                    .attach('file', AUDIO, { filename: 'a.wav', contentType: 'audio/wav' });
                assert.equal(wrongField.status, 400);
                assert.match(wrongField.body.message, /欄位 audio/);

                const wrongMime = await request(app).post('/api/voice/transcribe')
                    .attach('audio', AUDIO, { filename: 'a.png', contentType: 'image/png' });
                assert.equal(wrongMime.status, 400);
                assert.match(wrongMime.body.message, /不支援的音訊格式/);

                const wrongSubject = await request(app).post('/api/voice/transcribe')
                    .field('subject', '生物')
                    .attach('audio', AUDIO, { filename: 'a.wav', contentType: 'audio/wav' });
                assert.equal(wrongSubject.status, 400);
                assert.match(wrongSubject.body.message, /subject/);

                const big = await request(app).post('/api/voice/transcribe')
                    .attach('audio', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'big.wav', contentType: 'audio/wav' });
                assert.equal(big.status, 413);
                assert.match(big.body.message, /5 MB/);
            });

            test('multipart 本身壞掉（沒有結尾 boundary、沒有 boundary、multipart/mixed）→ 400，不是 500', async () => {
                const truncated = '--XYZ\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n'
                    + 'Content-Type: audio/wav\r\n\r\nabc';
                const cases = [
                    ['multipart/form-data; boundary=XYZ', truncated],
                    ['multipart/form-data', truncated],
                    ['multipart/mixed; boundary=XYZ', truncated]
                ];
                for (const [type, payload] of cases) {
                    const res = await request(app).post('/api/voice/transcribe').set('Content-Type', type).send(payload);
                    assert.equal(res.status, 400, `${type} → ${res.status} ${JSON.stringify(res.body)}`);
                    assert.match(res.body.message, /表單不完整或格式錯誤/);
                }
            });

            test('正常路徑（replay）：回逐字稿、數學式與歧義；音訊不落地（uploads/ 沒有多出檔案）', async () => {
                recordVoiceCassette({ audio: AUDIO, mime: 'audio/wav', subject: '數學' }, {
                    data: {
                        text: '請問 $\\frac{1}{x^2+1}$ 的積分是什麼？',
                        math_segments: [{ spoken: 'x 平方加一分之一', latex: '\\frac{1}{x^2+1}' }],
                        ambiguities: [{ spoken: 'x 平方加一分之一', options: ['\\frac{1}{x^2+1}', 'x^2+\\frac{1}{1}'] }]
                    },
                    usage: { tokenIn: 1920, tokenOut: 80 }
                });
                const before = uploadsCount();
                const res = await request(app).post('/api/voice/transcribe')
                    .field('subject', '數學')
                    .attach('audio', AUDIO, { filename: 'speech.wav', contentType: 'audio/wav' });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.text, '請問 $\\frac{1}{x^2+1}$ 的積分是什麼？');
                assert.deepEqual(res.body.math_segments, [{ spoken: 'x 平方加一分之一', latex: '\\frac{1}{x^2+1}' }]);
                assert.deepEqual(res.body.ambiguities, [{ spoken: 'x 平方加一分之一', options: ['\\frac{1}{x^2+1}', 'x^2+\\frac{1}{1}'] }]);
                assert.ok(res.body.usage.costUsd > 0);
                assert.equal(uploadsCount(), before, '錄音不得寫進 uploads/（memoryStorage）');
            });

            test('瀏覽器送的 audio/webm;codecs=opus 也收（mime 參數剝掉再比對）', async () => {
                recordVoiceCassette({ audio: AUDIO, mime: 'audio/webm', subject: null }, {
                    data: { text: '', math_segments: [], ambiguities: [] }, usage: {}
                });
                const res = await request(app).post('/api/voice/transcribe')
                    .attach('audio', AUDIO, { filename: 'speech.webm', contentType: 'audio/webm;codecs=opus' });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.equal(res.body.text, '');
            });

            test('模型輸出不合 schema → 502', async () => {
                recordVoiceCassette({ audio: AUDIO, mime: 'audio/ogg', subject: null }, { data: { transcript: '欄位名不對' }, usage: {} });
                const res = await request(app).post('/api/voice/transcribe')
                    .attach('audio', AUDIO, { filename: 'speech.ogg', contentType: 'audio/ogg' });
                assert.equal(res.status, 502);
                assert.match(res.body.message, /格式不符/);
            });

            test('限流 VOICE_RATE_LIMIT_PER_MIN：第 2 次（上限 1）回 429', async () => {
                const first = await request(appLimited).post('/api/voice/transcribe');
                const second = await request(appLimited).post('/api/voice/transcribe');
                assert.deepEqual([first.status, second.status], [400, 429]);
            });
        });
    });
}
