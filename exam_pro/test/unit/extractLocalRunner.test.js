// workers/jobRunner.js 的本機模式部分（〔本機模式 L2〕docs/local-mode.md 第 2 條、第 4 條第 4 點）
//
//   - loadLocalModeConfig：拆題模型是 ollama 時的長節點預設（逾時 45 分、每塊 2 頁、1 個槽），.env 明寫優先
//   - renewIntervalFor：續租間隔（租約到期前至少續兩次）
//   - crossCheckStopReason：cross_check 不是 agree → needs_review('extract_disagree')
//   - runner 本體（假 db、不連 PG）：save 那一格的政策停等、長節點執行中持續續租、ctx.config 帶 OCR 設定
// 需要 PostgreSQL 的整條管線驗收在 test/integration/localExtract.pg.test.js。
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('../../workers/jobRunner');
const models = require('../../config/models');
const { loadConfig, loadLocalModeConfig, renewIntervalFor, crossCheckStopReason, createRunner } = runner;

const ORIGINAL_PARSE = models.parseModel;
function parseWithOllama(spec) {
    const raw = String(spec ?? '').trim();
    if (raw.toLowerCase().startsWith('ollama:')) {
        const id = raw.slice(raw.indexOf(':') + 1).trim();
        return { vendor: 'ollama', id, spec: `ollama:${id}` };
    }
    return ORIGINAL_PARSE(spec);
}

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

const OLLAMA = 'ollama:qwen3-vl:8b';
const GEMINI = 'gemini:gemini-3.5-flash';

describe('jobRunner 本機模式 — 設定', () => {
    before(() => { models.parseModel = parseWithOllama; });
    after(() => { models.parseModel = ORIGINAL_PARSE; });

    test('常數：逾時 45 分、每塊 2 頁、1 個槽（第 2 條）', () => {
        assert.equal(runner.LOCAL_NODE_TIMEOUT_MS, 2700000);
        assert.equal(runner.LOCAL_PDF_CHUNK_PAGES, 2);
        assert.equal(runner.LOCAL_CONCURRENCY, 1);
    });

    test('拆題模型是 Gemini → 沒有任何覆寫（Gemini 路徑的預設不變）', () => {
        const c = loadLocalModeConfig({ MODEL_EXTRACT: GEMINI });
        assert.deepEqual(c, { localExtract: false, ocrEngine: 'paddle' });
    });

    test('拆題模型是 ollama、.env 沒寫 → 補三個長節點預設', () => {
        const c = loadLocalModeConfig({ MODEL_EXTRACT: OLLAMA });
        assert.deepEqual(c, {
            localExtract: true, ocrEngine: 'paddle',
            nodeTimeoutMs: 2700000, pdfChunkPages: 2, concurrency: 1
        });
    });

    test('.env 明寫的值一律優先（那幾個鍵不覆寫）；亂填的值視同沒寫', () => {
        const c = loadLocalModeConfig({ MODEL_EXTRACT: OLLAMA, JOB_NODE_TIMEOUT_MS: '600000', JOB_PDF_CHUNK_PAGES: '5', JOB_CONCURRENCY: '2' });
        assert.deepEqual(c, { localExtract: true, ocrEngine: 'paddle' });
        const d = loadLocalModeConfig({ MODEL_EXTRACT: OLLAMA, JOB_NODE_TIMEOUT_MS: 'abc' });
        assert.equal(d.nodeTimeoutMs, 2700000);
    });

    test('opts.extractModel 優先於 env；解析失敗視為非本機', () => {
        assert.equal(loadLocalModeConfig({ MODEL_EXTRACT: GEMINI }, { extractModel: OLLAMA }).localExtract, true);
        assert.equal(loadLocalModeConfig({ MODEL_EXTRACT: 'weird:x' }).localExtract, false);
    });

    test('env 沒有 MODEL_EXTRACT → 看 config/models.js 的 MODEL_EXTRACT', () => {
        withEnv({ MODEL_EXTRACT: OLLAMA }, () => {
            assert.equal(loadLocalModeConfig({}).localExtract, true);
        });
        withEnv({ MODEL_EXTRACT: GEMINI }, () => {
            assert.equal(loadLocalModeConfig({}).localExtract, false);
        });
    });

    test('OCR_ENGINE 一併解析（ctx.config.ocr.engine 的來源）', () => {
        assert.equal(loadLocalModeConfig({ MODEL_EXTRACT: OLLAMA, OCR_ENGINE: 'none' }).ocrEngine, 'none');
        assert.equal(loadLocalModeConfig({ MODEL_EXTRACT: GEMINI, OCR_ENGINE: 'NONE' }).ocrEngine, 'none');
    });

    test('loadConfig 本身的回傳不受影響（第 9 條的預設仍是 120 秒、20 頁、2 槽）', () => {
        const c = withEnv({ MODEL_EXTRACT: OLLAMA }, () => loadConfig({}));
        assert.equal(c.nodeTimeoutMs, 120000);
        assert.equal(c.pdfChunkPages, 20);
        assert.equal(c.concurrency, 2);
        assert.equal('localExtract' in c, false);
    });

    test('createRunner 疊上本機預設；opts.config 仍然最優先', () => {
        const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }), pool: {} };
        const env = {
            MODEL_EXTRACT: OLLAMA, JOB_NODE_TIMEOUT_MS: undefined, JOB_PDF_CHUNK_PAGES: undefined,
            JOB_CONCURRENCY: undefined, JOB_LEASE_MS: undefined
        };
        withEnv(env, () => {
            const r = createRunner({ db: fakeDb, llm: {}, logger: { info() { }, warn() { }, error() { } } });
            assert.equal(r.config.nodeTimeoutMs, 2700000);
            assert.equal(r.config.pdfChunkPages, 2);
            assert.equal(r.config.concurrency, 1);
            assert.equal(r.config.leaseMs, 180000, '租約不跟著放大（靠續租撐長節點）');
            assert.equal(r.config.renewIntervalMs, 30000);
            const o = createRunner({ db: fakeDb, llm: {}, config: { nodeTimeoutMs: 5, concurrency: 3 } });
            assert.equal(o.config.nodeTimeoutMs, 5);
            assert.equal(o.config.concurrency, 3);
        });
        withEnv({ ...env, MODEL_EXTRACT: GEMINI }, () => {
            const r = createRunner({ db: fakeDb, llm: {} });
            assert.equal(r.config.nodeTimeoutMs, 120000);
            assert.equal(r.config.pdfChunkPages, 20);
            assert.equal(r.config.concurrency, 2);
        });
    });
});

describe('jobRunner 本機模式 — 續租間隔', () => {
    test('租約 ≥ 90 秒：30 秒（第 7.1 條原值）；更短：租約的三分之一；下限 1 秒', () => {
        assert.equal(renewIntervalFor(180000), 30000);
        assert.equal(renewIntervalFor(90000), 30000);
        assert.equal(renewIntervalFor(60000), 20000);
        assert.equal(renewIntervalFor(1500), 1000);
        assert.equal(renewIntervalFor(NaN), 30000);
        assert.equal(renewIntervalFor(0), 30000);
    });

    test('合理的租約（≥ 3 秒）到期前至少續兩次', () => {
        for (const lease of [3000, 10000, 60000, 180000, 600000, 2700000]) {
            assert.ok(renewIntervalFor(lease) * 2 < lease + 1, `lease=${lease}`);
        }
    });
});

describe('jobRunner 本機模式 — crossCheckStopReason（extract_disagree 的轉移規則）', () => {
    const p = (cross_check) => ({ extract: { question_text: 'x', cross_check } });

    test('沒有 cross_check（Gemini 路徑、變式題）→ null，照常入庫', () => {
        assert.equal(crossCheckStopReason({ extract: { question_text: 'x' } }), null);
        assert.equal(crossCheckStopReason({}), null);
        assert.equal(crossCheckStopReason(null), null);
        assert.equal(crossCheckStopReason(p(null)), null);
        assert.equal(crossCheckStopReason(p(undefined)), null);
    });

    test('agree → null', () => {
        assert.equal(crossCheckStopReason(p({ status: 'agree', similarity: 0.97 })), null);
    });

    test('disagree／vision_only／ocr_only → extract_disagree', () => {
        for (const status of ['disagree', 'vision_only', 'ocr_only']) {
            assert.equal(crossCheckStopReason(p({ status, similarity: null })), 'extract_disagree', status);
        }
    });

    test('形狀壞掉一律當不一致（往安全的方向錯）', () => {
        for (const bad of ['agree', {}, { status: 'AGREE' }, { status: 'unknown' }, [], 1, true]) {
            assert.equal(crossCheckStopReason(p(bad)), 'extract_disagree', JSON.stringify(bad));
        }
    });

    test('extract_disagree 不是 error_class（job_events 寫 NULL，不撞 CHECK）', () => {
        assert.equal(runner.normalizeErrorClass('extract_disagree'), null);
    });

    test('extract_disagree 在複核原因白名單的最後一個（0015）', () => {
        const original = process.env.DATABASE_URL;
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
        const { REVIEW_REASONS } = require('../../controllers/reviewController');
        if (original === undefined) delete process.env.DATABASE_URL;
        assert.equal(REVIEW_REASONS[REVIEW_REASONS.length - 1], 'extract_disagree');
        const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'migrations', '0015_extract_disagree.sql'), 'utf8');
        for (const r of REVIEW_REASONS) assert.ok(sql.includes(`'${r}'`), `0015 的 CHECK 少了 ${r}（必須以完整值域重建）`);
    });
});

// ───────────────────────── runner 本體（假 db）─────────────────────────

/** 記下每一句 SQL 的假 db；SELECT job_questions 那一句回 row */
function fakeDb(row) {
    const log = [];
    return {
        log,
        pool: { connect: async () => { throw new Error('這個測試不該開交易（save 沒被執行）'); } },
        async query(text, params) {
            log.push({ text, params, at: Date.now() });
            if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            return { rows: [], rowCount: 0 };
        }
    };
}

function jqRow(state, payload, extra = {}) {
    return {
        id: 77, job_id: 9, idx: 1001, state, payload, retries: {},
        kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics',
        budget_usd: 0.5, cost_usd: 0, ...extra
    };
}

const QUIET = { info() { }, warn() { }, error() { } };

describe('jobRunner 本機模式 — save 的政策停等（假 db）', () => {
    test('cross_check 不一致 → needs_review(extract_disagree)、事件 skipped、error_class NULL、不執行 save（不開交易、不寫題庫）', async () => {
        const cc = { status: 'disagree', similarity: 0.62, alt_question_text: '另一版', picked: 'vision' };
        const db = fakeDb(jqRow('deduped', { extract: { question_text: 'x', cross_check: cc } }));
        const r = createRunner({ db, llm: {}, logger: QUIET, config: { renewIntervalMs: 60000 } });
        await r.runJobQuestion(77);

        const ev = db.log.find(q => /INSERT INTO job_events/.test(q.text));
        assert.ok(ev, '要寫一筆事件');
        const [jobId, jqId, node, attempt, model, , , , , costUsd, costEstimated, latency, outcome, errorClass, detail] = ev.params;
        assert.deepEqual([jobId, jqId, node, attempt, model, costUsd, costEstimated, latency, outcome, errorClass],
            [9, 77, 'save', 1, null, 0, false, 0, 'skipped', null]);
        assert.deepEqual(JSON.parse(detail), {
            reason: 'extract_disagree', review_reason: 'extract_disagree',
            cross_check: { status: 'disagree', similarity: 0.62, picked: 'vision' }
        });

        const upd = db.log.find(q => /UPDATE job_questions SET state = 'needs_review'/.test(q.text));
        assert.ok(upd);
        assert.deepEqual(upd.params, [77, 'extract_disagree']);
        assert.match(upd.text, /locked_until = NULL/);
        assert.ok(!db.log.some(q => /INSERT INTO questions/.test(q.text)), '不得入庫');
        assert.ok(db.log.some(q => /UPDATE jobs SET state = 'done'/.test(q.text)), '到終態後照樣檢查 job 能不能收尾');
    });

    test('vision_only（OCR_ENGINE=none 時每題都是）也停在 extract_disagree', async () => {
        const db = fakeDb(jqRow('deduped', { extract: { cross_check: { status: 'vision_only', similarity: null } } }));
        await createRunner({ db, llm: {}, logger: QUIET }).runJobQuestion(77);
        const upd = db.log.find(q => /SET state = 'needs_review'/.test(q.text));
        assert.deepEqual(upd.params, [77, 'extract_disagree']);
    });

    test('只在 save 那一格停：前面的節點照常跑（cross_check 不一致的題仍走完 dedup0／classify／…）', async () => {
        const db = fakeDb(jqRow('extracted', { extract: { question_text: '設 $x=1$，求 $x$。', cross_check: { status: 'disagree' } } }));
        const agentsDir = path.resolve(__dirname, '..', 'fixtures', 'fakeAgents');
        await createRunner({ db, llm: {}, logger: QUIET, agentsDir }).runJobQuestion(77);
        const upd = db.log.find(q => /UPDATE job_questions SET state = \$2/.test(q.text));
        assert.ok(upd, '走的是一般的 transition 寫回');
        assert.equal(upd.params[1], 'hashed', 'dedup0 照常推進');
        assert.ok(!db.log.some(q => /'needs_review'/.test(q.text)));
    });

    test('變式 job 的 awaiting_approval 分支不受影響（事件 detail 逐字不變）', async () => {
        const db = fakeDb(jqRow('deduped', { extract: { question_text: 'x' } }, { kind: 'variant' }));
        await createRunner({ db, llm: {}, logger: QUIET, config: { variantAutoApprove: false } }).runJobQuestion(77);
        const ev = db.log.find(q => /INSERT INTO job_events/.test(q.text));
        assert.deepEqual(JSON.parse(ev.params[14]), { reason: 'awaiting_approval', auto_approve: false });
        assert.ok(db.log.some(q => /review_reason = 'awaiting_approval'/.test(q.text)));
    });
});

describe('jobRunner 本機模式 — 長節點執行中持續續租（假 db）', () => {
    let agentsDir;
    before(() => {
        agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-agents-'));
        fs.writeFileSync(path.join(agentsDir, 'classify.js'), `
            module.exports = {
                async run(ctx) {
                    globalThis.__slowClassify = (globalThis.__slowClassify || 0) + 1;
                    globalThis.__slowCtxConfig = ctx.config;
                    await new Promise(r => setTimeout(r, Number(globalThis.__slowMs || 600)));
                    return { kind: 'pass', data: { chapter: '向量內積', confidence: 0.9, source: 'llm' } };
                }
            };`);
    });
    after(() => {
        fs.rmSync(agentsDir, { recursive: true, force: true });
        delete globalThis.__slowClassify;
        delete globalThis.__slowCtxConfig;
        delete globalThis.__slowMs;
    });

    const RENEW = /UPDATE job_questions SET locked_until = now\(\) \+ \(\$1 \|\| ' milliseconds'\)::interval\s+WHERE id = \$2 AND locked_until IS NOT NULL/;

    test('節點跑的時間遠超過租約：執行中每 renewIntervalMs 續一次，結束後就停', async () => {
        globalThis.__slowMs = 800;
        const db = fakeDb(jqRow('hashed', { extract: { question_text: 'x', subject: '數學', chapter: '向量內積', chapter_confidence: 0.9 } }));
        const r = createRunner({
            db, llm: {}, logger: QUIET, agentsDir,
            config: { leaseMs: 400, renewIntervalMs: 50, nodeTimeoutMs: 5000 }
        });
        await r.runJobQuestion(77);
        const renewals = db.log.filter(q => RENEW.test(q.text));
        assert.ok(renewals.length >= 5, `800ms 的節點（租約只有 400ms）、50ms 續一次，至少要續 5 次，實際 ${renewals.length}`);
        for (const q of renewals) assert.deepEqual(q.params, ['400', 77]);
        // 相鄰兩次續租的間隔都短於租約：租約在節點跑完前從未過期
        const times = [db.log.find(q => /FROM job_questions q JOIN jobs j/.test(q.text)).at, ...renewals.map(q => q.at)];
        for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] < 400, `第 ${i} 次續租間隔 ${times[i] - times[i - 1]}ms`);

        const after = db.log.length;
        await new Promise(res => setTimeout(res, 200));
        assert.equal(db.log.filter(q => RENEW.test(q.text)).length, renewals.length, '節點結束後不再續租');
        assert.equal(db.log.length, after);
        assert.equal(globalThis.__slowClassify, 1);
    });

    test('ctx.config 帶 OCR 引擎與 MODEL_OCR_STRUCTURE（未設＝MODEL_VERIFY）', async () => {
        globalThis.__slowMs = 1;
        await withEnv({ OCR_ENGINE: 'none', MODEL_OCR_STRUCTURE: undefined, MODEL_VERIFY: 'gemini:verify-x' }, async () => {
            const db = fakeDb(jqRow('hashed', { extract: { question_text: 'x' } }));
            await createRunner({ db, llm: {}, logger: QUIET, agentsDir }).runJobQuestion(77);
            assert.deepEqual(globalThis.__slowCtxConfig.ocr, { engine: 'none' });
            assert.equal(globalThis.__slowCtxConfig.models.ocrStructure, 'gemini:verify-x');
        });
        await withEnv({ OCR_ENGINE: undefined, MODEL_OCR_STRUCTURE: 'gemini:ocr-struct' }, async () => {
            const db = fakeDb(jqRow('hashed', { extract: { question_text: 'x' } }));
            await createRunner({ db, llm: {}, logger: QUIET, agentsDir }).runJobQuestion(77);
            assert.deepEqual(globalThis.__slowCtxConfig.ocr, { engine: 'paddle' });
            assert.equal(globalThis.__slowCtxConfig.models.ocrStructure, 'gemini:ocr-struct');
        });
    });
});
