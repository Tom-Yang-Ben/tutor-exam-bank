// ─────────────────────────────────────────────────────────────
// legacyAnalyzePdfFigures.pg.test.js — 舊流程 /analyze-pdf 補裁附圖的整合測試〔Owner 決策單 2026-09-25 B21〕
//
// roadmap 待決策第 20 項 Owner 選「保留舊流程＋補裁圖」。從 HTTP 走一遍舊前端的兩步：
//   POST /api/analyze-pdf（上傳公開樣卷）→ 回傳陣列 → 原樣 POST /api/batch-save-questions → questions.question_img
// 驗三件事：有圖的題帶回附圖並入庫到管線同一個欄位；裁圖失敗不影響題目回傳；回傳形狀與舊前端相容。
//
// LLM 一律是假的（services/aiService.js 的 _setDepsForTest），不讀 cassette、不連網；
// 裁圖走真的 services/figureService.js，只把附圖目錄換成暫存目錄（不碰 data/figures/）。
// 三道防線與其他整合測試相同。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('舊流程補裁附圖整合測試（需要 PostgreSQL）', {
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

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const aiService = require(path.join(APP_DIR, 'services', 'aiService'));
    const { cropFigures } = require(path.join(APP_DIR, 'services', 'figureService'));

    const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');
    const LEGACY_KEYS = ['subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'answer_text'];
    const RUN = '20260926000000-b21b21';
    const GEMINI = { extract: 'gemini:gemini-3.5-flash', verify: 'gemini:gemini-3.1-pro-preview', text: 'gemini:gemini-3.5-flash' };

    const WITH_FIG = {
        subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
        question_text: '自製測試題：如圖，求 $\\overrightarrow{AB}\\cdot\\overrightarrow{AC}$。', answer_text: '$6$',
        figure_desc: '直角三角形 ABC', figure_page: 1, figure_box: [100, 150, 400, 850]
    };
    const NO_FIG = {
        subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_type: '填空', difficulty: 2,
        question_text: '自製測試題：設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。', answer_text: '$1$'
    };

    const fakeLlm = (questions) => ({
        generateJson: async () => ({ data: { questions }, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1, raw: null })
    });
    const quietLogger = () => {
        const warns = [];
        return { warns, logger: { info() { }, warn: (o) => warns.push(o), error() { } } };
    };

    describe('/analyze-pdf 補裁附圖 × batch-save-questions × PostgreSQL', () => {
        let figuresDir;

        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });
        beforeEach(async () => {
            figuresDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-int-figures-'));
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });
        afterEach(() => {
            aiService._setDepsForTest();
            fs.rmSync(figuresDir, { recursive: true, force: true });
        });
        after(async () => {
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
            await pool.end();
        });

        test('有圖的題帶回 question_img；原樣送回 batch-save 入庫到 questions.question_img，沒圖的題是 NULL', async () => {
            const { warns, logger } = quietLogger();
            aiService._setDepsForTest({
                llm: fakeLlm([WITH_FIG, NO_FIG]), models: GEMINI, logger, runId: () => RUN,
                cropFigures: (opts) => cropFigures({ ...opts, figuresDir })
            });

            const analyzed = await request(app).post('/api/analyze-pdf').attach('pdf', SAMPLE_PDF);
            assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
            assert.ok(Array.isArray(analyzed.body), '回應仍是一個陣列（舊前端的契約）');
            assert.equal(analyzed.body.length, 2);
            assert.deepEqual(Object.keys(analyzed.body[0]), [...LEGACY_KEYS, 'question_img']);
            assert.equal(analyzed.body[0].question_img, `/figures/legacy-${RUN}-1001.png`);
            assert.deepEqual(Object.keys(analyzed.body[1]), LEGACY_KEYS, '沒圖的題只有那六個鍵');
            assert.ok(fs.existsSync(path.join(figuresDir, `legacy-${RUN}-1001.png`)));
            assert.deepEqual(warns, []);

            // 舊前端的第二步：整筆 {...q} 加上題源送回（public/index.html 的 batchSaveBtn）
            const saved = await request(app).post('/api/batch-save-questions').send({
                questions: analyzed.body.map(q => ({ ...q, source_type: 'school', source_detail: '自製測試卷' }))
            });
            assert.equal(saved.status, 200, JSON.stringify(saved.body));
            assert.deepEqual(Object.keys(saved.body).sort(), ['message', 'rejected', 'saved_count']);
            assert.equal(saved.body.saved_count, 2);

            const { rows } = await query('SELECT question_img, origin, chapter_src, source_type FROM questions ORDER BY id');
            assert.deepEqual(rows, [
                { question_img: `/figures/legacy-${RUN}-1001.png`, origin: 'pdf', chapter_src: 'ai', source_type: 'school' },
                { question_img: null, origin: 'pdf', chapter_src: 'ai', source_type: 'school' }
            ]);

            // 題庫列表（index.html 有 question_img 就顯示圖）拿得到同一個路徑
            const list = await request(app).get('/api/questions');
            assert.equal(list.status, 200);
            const imgs = list.body.questions.map(q => q.question_img).sort();
            assert.deepEqual(imgs, [`/figures/legacy-${RUN}-1001.png`, null].sort());
        });

        test('裁圖失敗：仍回 200、題目一題不少，都沒有 question_img，伺服器記 warn', async () => {
            const { warns, logger } = quietLogger();
            aiService._setDepsForTest({
                llm: fakeLlm([WITH_FIG, NO_FIG]), models: GEMINI, logger, runId: () => RUN,
                cropFigures: async () => { throw new Error('mupdf 載入失敗'); }
            });

            const analyzed = await request(app).post('/api/analyze-pdf').attach('pdf', SAMPLE_PDF);
            assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
            assert.equal(analyzed.body.length, 2);
            for (const q of analyzed.body) assert.deepEqual(Object.keys(q), LEGACY_KEYS);
            assert.match(analyzed.body[0].question_text, /\[附圖描述：直角三角形 ABC\]$/, '文字描述的備援還在');
            assert.equal(warns.length, 1);
            assert.match(warns[0].msg, /附圖裁切失敗/);
            assert.deepEqual(fs.readdirSync(figuresDir), []);

            const saved = await request(app).post('/api/batch-save-questions').send({ questions: analyzed.body });
            assert.equal(saved.status, 200);
            const { rows } = await query('SELECT question_img FROM questions ORDER BY id');
            assert.deepEqual(rows, [{ question_img: null }, { question_img: null }]);
        });

        test('batch-save 只收附圖目錄內的本機路徑；其他值照舊忽略（落 NULL、不整題退回）', async () => {
            const base = { subject: '數學', chapter: '向量內積', question_type: '填空', difficulty: 2, answer_text: 'a' };
            const cases = [
                ['/figures/legacy-20260926000000-abcdef-1001.png', '/figures/legacy-20260926000000-abcdef-1001.png'],
                ['  /figures/7-2001.png  ', '/figures/7-2001.png'],
                ['https://example.com/a.png', null],        // 舊流程從來不產生外部網址；不在這條路徑開新的寫入口
                ['/figures/../etc/passwd.png', null],
                ['/figures/sub/x.png', null],
                ['/figures/x.gif', null],
                [123, null],
                [undefined, null]
            ];
            const res = await request(app).post('/api/batch-save-questions').send({
                questions: cases.map(([img], i) => ({ ...base, question_text: `自製測試題 ${i}`, ...(img === undefined ? {} : { question_img: img }) }))
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.saved_count, cases.length);
            assert.deepEqual(res.body.rejected, []);
            const { rows } = await query('SELECT question_img FROM questions ORDER BY id');
            assert.deepEqual(rows.map(r => r.question_img), cases.map(([, want]) => want));
        });
    });
}
