// 〔Owner 決策單 2026-09-26 第四輪〕本機模式的兩個程式改動（docs/local-mode.md 10.11 表 #4、#6）
//
//   V3 選 2：拆題模型是 ollama（本機模式）時，拆題一塊的錯誤類別是 timeout 的只重試 1 次（共跑 2 次）；
//            其他錯誤類別、Gemini 模式的重試次數（DEFAULT_LIMITS.maxErrorRetries＝3）完全不變。
//            workers/jobRunner.js 的 runExtractChunk、常數 LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES。
//   V4 選 1：舊流程 /analyze-pdf 在本機模式且 .env 沒明寫 JOB_PDF_CHUNK_PAGES 時，每塊頁數與新流程相同
//            （workers/jobRunner.js 的 LOCAL_PDF_CHUNK_PAGES，同一個常數）；Gemini 模式照舊 20 頁。
//            services/aiService.js 的 buildCtx。
//
// 不連 DB、不呼叫模型：V3 用假 db＋當場寫的假 extract agent 跑 runExtractJob；V4 用假 llm 跑 analyzePdfContent。
// 需要 PostgreSQL 的 V3 驗收在 test/integration/localExtract.pg.test.js。
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const runner = require('../../workers/jobRunner');
const { createRunner } = runner;
const { DEFAULT_LIMITS } = require('../../pipeline/stateMachine');

const QUIET = { info() { }, warn() { }, error() { } };
const OLLAMA = 'ollama:qwen3-vl:8b';
const GEMINI = 'gemini:gemini-3.5-flash';

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    };
    let result;
    try {
        result = fn();
    } catch (err) {
        restore();
        throw err;
    }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
}

// ───────────────────────── V3：本機逾時只重試 1 次 ─────────────────────────

/** 假 db：jobs 那兩句 SELECT 回固定的列，其餘記下來。PDF 每次重寫一份（拆完 runner 會刪檔） */
function fakeDb(pdfPath) {
    fs.writeFileSync(pdfPath, 'x');
    const log = [];
    return {
        log,
        pool: { connect: async () => { throw new Error('拆題不該開交易'); } },
        async query(text, params) {
            log.push({ text, params });
            if (/SELECT id, pdf_path, pdf_sha256, page_count/.test(text)) {
                return {
                    rows: [{ id: 5, pdf_path: pdfPath, pdf_sha256: 'b'.repeat(64), page_count: 2, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0 }],
                    rowCount: 1
                };
            }
            if (/SELECT cost_usd::float8 AS cost_usd FROM jobs/.test(text)) return { rows: [{ cost_usd: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        }
    };
}

/** 拆題事件：[attempt, outcome, error_class] */
function extractEvents(db) {
    return db.log.filter(q => /INSERT INTO job_events/.test(q.text) && q.params[2] === 'extract')
        .map(q => [q.params[3], q.params[12], q.params[13]]);
}

function failedWith(db) {
    const q = db.log.find(x => /UPDATE jobs SET state = 'failed'/.test(x.text));
    return q ? q.params[1] : null;
}

describe('〔第四輪 V3〕本機模式拆題逾時只重試 1 次（假 db）', () => {
    let agentsDir;
    let tmpDir;
    let pdfPath;
    let sleeps;

    before(() => {
        agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-v3-agents-'));
        // 依 globalThis.__r4Script 依序回 outcome；用完之後一律 pass（拆出 0 題）
        fs.writeFileSync(path.join(agentsDir, 'extract.js'), `
            module.exports = {
                async run(ctx, input) {
                    globalThis.__r4Calls = (globalThis.__r4Calls || 0) + 1;
                    const next = (globalThis.__r4Script || []).shift();
                    if (next === 'pass' || next === undefined) return { kind: 'pass', data: { questions: [], rejected: [] } };
                    return { kind: 'error', errorClass: next, message: '假 extract：' + next };
                }
            };`);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-v3-pdf-'));
    });
    after(() => {
        fs.rmSync(agentsDir, { recursive: true, force: true });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete globalThis.__r4Calls;
        delete globalThis.__r4Script;
    });
    beforeEach(() => {
        pdfPath = path.join(tmpDir, `job-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
        fs.writeFileSync(pdfPath, 'x');
        globalThis.__r4Calls = 0;
        sleeps = [];
    });

    /** 跑一次 runExtractJob；script 是依序回的錯誤類別（'pass' 或用完＝成功）；永遠錯就給 repeat */
    async function run({ localExtract, script = [], repeat = null }) {
        globalThis.__r4Script = repeat ? Array(50).fill(repeat) : [...script];
        const db = fakeDb(pdfPath);
        const r = createRunner({
            db, llm: {}, logger: QUIET, agentsDir,
            sleep: async (ms) => { sleeps.push(ms); },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { localExtract, pdfChunkPages: 2, nodeTimeoutMs: 5000, renewIntervalMs: 60000 }
        });
        await r.runExtractJob(5);
        return { db, calls: globalThis.__r4Calls };
    }

    test('常數：本機逾時只重試 1 次；錯誤重試的總上限仍是 DEFAULT_LIMITS.maxErrorRetries（3）', () => {
        assert.equal(runner.LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES, 1);
        assert.equal(DEFAULT_LIMITS.maxErrorRetries, 3);
    });

    test('本機模式、每次都逾時 → 共跑 2 次（重試 1 次）就讓整份卷 failed，錯誤訊息說明只重試 1 次', async () => {
        const { db, calls } = await run({ localExtract: true, repeat: 'timeout' });
        assert.equal(calls, 2);
        assert.deepEqual(extractEvents(db), [[1, 'error', 'timeout'], [2, 'error', 'timeout']]);
        assert.equal(sleeps.length, 1, '只退避一次');
        const err = failedWith(db);
        assert.match(err, /^拆題連續失敗（chunk 1）：假 extract：timeout/);
        assert.match(err, /本機模式逾時只重試 1 次/);
        assert.ok(fs.existsSync(pdfPath), '失敗時不刪 PDF（與原本相同）');
    });

    test('本機模式、逾時 1 次後成功 → 照常拆完（第 2 次就是那 1 次重試）', async () => {
        const { db, calls } = await run({ localExtract: true, script: ['timeout', 'pass'] });
        assert.equal(calls, 2);
        assert.deepEqual(extractEvents(db), [[1, 'error', 'timeout'], [2, 'pass', null]]);
        assert.equal(failedWith(db), null);
        assert.ok(db.log.some(q => /UPDATE jobs SET pdf_path = NULL, state = 'processing'/.test(q.text)));
    });

    test('本機模式的其他錯誤類別不變：provider_error／rate_limited 仍重試 3 次（共 4 次）', async () => {
        for (const cls of ['provider_error', 'rate_limited', 'schema_invalid']) {
            globalThis.__r4Calls = 0;
            sleeps = [];
            const { db, calls } = await run({ localExtract: true, repeat: cls });
            assert.equal(calls, 4, cls);
            assert.deepEqual(extractEvents(db).map(e => e[0]), [1, 2, 3, 4], cls);
            assert.equal(sleeps.length, 3, cls);
            const err = failedWith(db);
            assert.match(err, new RegExp(`^拆題連續失敗（chunk 1）：假 extract：${cls}$`), cls);
        }
    });

    test('本機模式混合：其他錯誤不吃掉逾時的那 1 次；逾時用過 1 次後再逾時就停（總上限仍是 3）', async () => {
        // provider_error、provider_error、timeout（第 1 次逾時 → 重試）、pass
        let r = await run({ localExtract: true, script: ['provider_error', 'provider_error', 'timeout', 'pass'] });
        assert.equal(r.calls, 4);
        assert.equal(failedWith(r.db), null);
        // timeout（重試）、provider_error（重試）、timeout（第 2 次逾時 → 停）
        globalThis.__r4Calls = 0;
        r = await run({ localExtract: true, script: ['timeout', 'provider_error', 'timeout', 'pass'] });
        assert.equal(r.calls, 3);
        assert.deepEqual(extractEvents(r.db).map(e => e[2]), ['timeout', 'provider_error', 'timeout']);
        assert.match(failedWith(r.db), /本機模式逾時只重試 1 次/);
        // 總上限不變：rate_limited ×3 之後的第 1 次逾時也不能再重試（已用完 3 次）
        globalThis.__r4Calls = 0;
        r = await run({ localExtract: true, script: ['rate_limited', 'rate_limited', 'rate_limited', 'timeout', 'pass'] });
        assert.equal(r.calls, 4);
        assert.match(failedWith(r.db), /^拆題連續失敗（chunk 1）：假 extract：timeout$/);
    });

    test('Gemini 模式完全不變：逾時照舊重試 3 次（共 4 次），訊息與原本逐字相同', async () => {
        const { db, calls } = await run({ localExtract: false, repeat: 'timeout' });
        assert.equal(calls, 4);
        assert.deepEqual(extractEvents(db), [[1, 'error', 'timeout'], [2, 'error', 'timeout'], [3, 'error', 'timeout'], [4, 'error', 'timeout']]);
        assert.deepEqual(sleeps, [1000, 2000, 4000]);
        assert.equal(failedWith(db), '拆題連續失敗（chunk 1）：假 extract：timeout');

        globalThis.__r4Calls = 0;
        const mixed = await run({ localExtract: false, script: ['timeout', 'provider_error', 'timeout', 'pass'] });
        assert.equal(mixed.calls, 4, 'Gemini 模式的第 2 次逾時照樣重試');
        assert.equal(failedWith(mixed.db), null);
    });

    test('本機模式由拆題模型決定：.env 的 MODEL_EXTRACT 是 ollama → 逾時只重試 1 次；是 Gemini → 3 次', async () => {
        const runWithEnv = (model) => withEnv({ MODEL_EXTRACT: model }, async () => {
            globalThis.__r4Script = Array(50).fill('timeout');
            globalThis.__r4Calls = 0;
            const db = fakeDb(pdfPath);
            const r = createRunner({
                db, llm: {}, logger: QUIET, agentsDir, sleep: async () => { },
                estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { nodeTimeoutMs: 5000, renewIntervalMs: 60000 }
            });
            assert.equal(r.config.localExtract, model === OLLAMA);
            await r.runExtractJob(5);
            return globalThis.__r4Calls;
        });
        assert.equal(await runWithEnv(OLLAMA), 2);
        assert.equal(await runWithEnv(GEMINI), 4);
    });

    test('節點逾時（invokeNode 的 JOB_NODE_TIMEOUT_MS）產生的 timeout 也適用', async () => {
        const slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-v3-slow-'));
        try {
            fs.writeFileSync(path.join(slowDir, 'extract.js'), `
                module.exports = {
                    async run(ctx) {
                        globalThis.__r4Calls = (globalThis.__r4Calls || 0) + 1;
                        await new Promise(r => setTimeout(r, 300));
                        return { kind: 'pass', data: { questions: [], rejected: [] } };
                    }
                };`);
            const db = fakeDb(pdfPath);
            const r = createRunner({
                db, llm: {}, logger: QUIET, agentsDir: slowDir, sleep: async () => { },
                estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { localExtract: true, nodeTimeoutMs: 20, renewIntervalMs: 60000 }
            });
            await r.runExtractJob(5);
            assert.equal(globalThis.__r4Calls, 2);
            assert.deepEqual(extractEvents(db).map(e => e[2]), ['timeout', 'timeout']);
            assert.match(failedWith(db), /超過 20 ms 未回應.*本機模式逾時只重試 1 次/);
        } finally {
            fs.rmSync(slowDir, { recursive: true, force: true });
        }
    });

    test('extract 的 fail（schema_invalid 等未通過）重試規則不變：整包重試 1 次（EXTRACT_MAX_RETRIES）', async () => {
        const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-v3-fail-'));
        try {
            fs.writeFileSync(path.join(failDir, 'extract.js'), `
                module.exports = {
                    async run() {
                        globalThis.__r4Calls = (globalThis.__r4Calls || 0) + 1;
                        return { kind: 'fail', reason: 'schema_invalid' };
                    }
                };`);
            for (const localExtract of [true, false]) {
                globalThis.__r4Calls = 0;
                const db = fakeDb(pdfPath);
                await createRunner({
                    db, llm: {}, logger: QUIET, agentsDir: failDir, sleep: async () => { },
                    estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                    config: { localExtract, renewIntervalMs: 60000 }
                }).runExtractJob(5);
                assert.equal(globalThis.__r4Calls, 1 + runner.EXTRACT_MAX_RETRIES, String(localExtract));
                assert.equal(failedWith(db), '拆題失敗（chunk 1）：schema_invalid');
            }
        } finally {
            fs.rmSync(failDir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────── V4：舊流程 /analyze-pdf 本機預設每塊 2 頁 ─────────────────────────

describe('〔第四輪 V4〕舊流程 /analyze-pdf：本機模式沒寫 JOB_PDF_CHUNK_PAGES 時每塊頁數＝LOCAL_PDF_CHUNK_PAGES', () => {
    const aiService = require('../../services/aiService');
    const extract = require('../../agents/extract');
    const SAMPLE_PDF = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'sample_exam.pdf');
    const LOCAL_MODELS = { extract: OLLAMA, verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' };
    const GEMINI_MODELS = { extract: GEMINI, verify: 'gemini:gemini-3.1-pro-preview', text: GEMINI };
    const USAGE = { tokenIn: 1, tokenOut: 2, tokenThinking: 0, tokenCached: 0 };

    /** n 頁的 PDF（每頁都是公開樣卷的第 1 頁） */
    async function pdfOfPages(n) {
        const src = await PDFDocument.load(fs.readFileSync(SAMPLE_PDF));
        const doc = await PDFDocument.create();
        for (const p of await doc.copyPages(src, Array(n).fill(0))) doc.addPage(p);
        return Buffer.from(await doc.save()).toString('base64');
    }

    /** 假 llm：記下每一次呼叫的 agent 與塊號、頁碼範圍；一律回 0 題 */
    function fakeLlm() {
        const calls = [];
        return {
            calls,
            generateJson: async (opts) => {
                calls.push({ agent: opts.agent, chunkNo: opts.cacheKeyParts.chunkNo });
                return { data: { questions: [] }, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
            }
        };
    }

    let ocrRanges;
    beforeEach(() => {
        ocrRanges = [];
        // 本機路徑：OCR 換成假的（記下每一塊的頁碼範圍），replay 模式不渲染圖片
        extract._setLocalDepsForTest({
            ocrPdf: async ({ fromPage, toPage }) => {
                ocrRanges.push([fromPage, toPage]);
                return {
                    engine: 'paddleocr', engineVersion: 'test', dpi: 200, replayed: true, dispose() { },
                    pages: Array.from({ length: toPage - fromPage + 1 }, (_, i) => ({ page: fromPage + i, markdown: '假 OCR 文字', imagePath: null }))
                };
            },
            renderPages: async () => { throw new Error('replay 不送圖片，不該渲染'); },
            llmMode: () => 'replay',
            ocrConfig: () => ({ engine: 'paddle', dpi: 200 })
        });
    });
    afterEach(() => {
        aiService._setDepsForTest();
        extract._setLocalDepsForTest({});
    });

    const QUIET_LOGGER = { info() { }, warn() { }, error() { } };
    async function analyze(models, pages) {
        const llm = fakeLlm();
        aiService._setDepsForTest({ llm, models, logger: QUIET_LOGGER, cropFigures: async () => 0 });
        await aiService.analyzePdfContent(await pdfOfPages(pages));
        return [...new Set(llm.calls.map(c => c.chunkNo))];
    }

    test('本機模式、.env 沒寫：4 頁卷切成 2 塊（每塊 2 頁，與新流程相同），不是一次送 4 頁', async () => {
        assert.equal(runner.LOCAL_PDF_CHUNK_PAGES, 2);
        await withEnv({ JOB_PDF_CHUNK_PAGES: undefined }, async () => {
            assert.deepEqual(await analyze(LOCAL_MODELS, 4), [1, 2]);
            assert.deepEqual(ocrRanges, [[1, 2], [3, 4]]);
        });
    });

    test('本機模式、.env 亂填（非正整數）視同沒寫 → 同樣 2 頁一塊', async () => {
        for (const bad of ['', 'abc', '0', '-3']) {
            ocrRanges = [];
            await withEnv({ JOB_PDF_CHUNK_PAGES: bad }, async () => {
                assert.deepEqual(await analyze(LOCAL_MODELS, 4), [1, 2], JSON.stringify(bad));
                assert.deepEqual(ocrRanges, [[1, 2], [3, 4]], JSON.stringify(bad));
            });
        }
    });

    test('本機模式、.env 明寫 → 明寫的值優先（1 頁 → 4 塊；20 頁 → 1 塊）', async () => {
        await withEnv({ JOB_PDF_CHUNK_PAGES: '1' }, async () => {
            assert.deepEqual(await analyze(LOCAL_MODELS, 4), [1, 2, 3, 4]);
        });
        ocrRanges = [];
        await withEnv({ JOB_PDF_CHUNK_PAGES: '20' }, async () => {
            assert.deepEqual(await analyze(LOCAL_MODELS, 4), [1]);
            assert.deepEqual(ocrRanges, [[1, 4]]);
        });
    });

    test('共用同一個常數：改 workers/jobRunner 匯出的 LOCAL_PDF_CHUNK_PAGES，舊流程跟著變（不是第二份數字）', async () => {
        const original = runner.LOCAL_PDF_CHUNK_PAGES;
        runner.LOCAL_PDF_CHUNK_PAGES = 1;
        try {
            await withEnv({ JOB_PDF_CHUNK_PAGES: undefined }, async () => {
                assert.deepEqual(await analyze(LOCAL_MODELS, 3), [1, 2, 3]);
            });
        } finally {
            runner.LOCAL_PDF_CHUNK_PAGES = original;
        }
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'services', 'aiService.js'), 'utf8');
        assert.match(src, /require\('\.\.\/workers\/jobRunner'\)\.LOCAL_PDF_CHUNK_PAGES/);
    });

    test('Gemini 模式完全不變：沒寫時仍是 20 頁一塊（4 頁卷一次送）；明寫照舊優先', async () => {
        await withEnv({ JOB_PDF_CHUNK_PAGES: undefined }, async () => {
            assert.deepEqual(await analyze(GEMINI_MODELS, 4), [1]);
        });
        await withEnv({ JOB_PDF_CHUNK_PAGES: 'abc' }, async () => {
            assert.deepEqual(await analyze(GEMINI_MODELS, 4), [1]);
        });
        await withEnv({ JOB_PDF_CHUNK_PAGES: '1' }, async () => {
            assert.deepEqual(await analyze(GEMINI_MODELS, 4), [1, 2, 3, 4]);
        });
        assert.deepEqual(ocrRanges, [], 'Gemini 路徑不跑 OCR');
    });

    test('沒注入模型時看 MODEL_EXTRACT（與拆題 agent 判斷走哪條路徑的依據相同）', async () => {
        await withEnv({ JOB_PDF_CHUNK_PAGES: undefined, MODEL_EXTRACT: OLLAMA }, async () => {
            assert.deepEqual(await analyze(null, 4), [1, 2]);
        });
        await withEnv({ JOB_PDF_CHUNK_PAGES: undefined, MODEL_EXTRACT: GEMINI }, async () => {
            assert.deepEqual(await analyze(null, 4), [1]);
        });
    });
});
