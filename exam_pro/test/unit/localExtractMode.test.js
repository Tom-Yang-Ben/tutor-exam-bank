// LOCAL_EXTRACT_MODE（〔OCR 為主 2026-09-26〕Owner 決定這台電腦的拆題改成 OCR 為主；docs/local-mode.md 10.12）
//
//   - config/localExtractMode.js：cross（預設）｜ocr；未設或空字串＝預設、非法值退回預設並警告一次；
//     OCR_ENGINE=none 與 LOCAL_EXTRACT_MODE=ocr 同時設是矛盾設定：拆題模型是 ollama 時啟動就報錯
//   - workers/jobRunner.js：設定疊進 runner、ctx.config.localExtract 帶給 agent、只用 OCR 拆的題停在 needs_review('ocr_only')
//   - 0019 與 reviewController 的複核原因白名單
//   - CI 設定（ci.yml、eval/.env.replay）與重錄工具（suiteProcess／localMode）
// 需要 PostgreSQL 的部分在 test/integration/localExtractOcr.pg.test.js。
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const modeCfg = require('../../config/localExtractMode');
const runner = require('../../workers/jobRunner');
const models = require('../../config/models');
const sp = require('../../eval/lib/suiteProcess');
const local = require('../../eval/lib/localMode');

const ORIGINAL_PARSE = models.parseModel;
function parseWithOllama(spec) {
    const raw = String(spec ?? '').trim();
    if (raw.toLowerCase().startsWith('ollama:')) {
        const id = raw.slice(raw.indexOf(':') + 1).trim();
        return { vendor: 'ollama', id, spec: `ollama:${id}` };
    }
    return ORIGINAL_PARSE(spec);
}

function captureWarn(fn) {
    const saved = console.warn;
    const lines = [];
    console.warn = (...a) => { lines.push(a.join(' ')); };
    try { fn(); } finally { console.warn = saved; }
    return lines;
}

const QUIET = { info() { }, warn() { }, error() { } };

describe('config/localExtractMode — 解析', () => {
    beforeEach(() => modeCfg._resetForTest());

    test('兩個值、預設 cross', () => {
        assert.deepEqual(modeCfg.LOCAL_EXTRACT_MODES, ['cross', 'ocr']);
        assert.equal(modeCfg.DEFAULT_LOCAL_EXTRACT_MODE, 'cross');
    });

    test('未設、空字串、空白 → cross（不警告）', () => {
        const warns = captureWarn(() => {
            assert.equal(modeCfg.resolveLocalExtractMode({}), 'cross');
            assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: '' }), 'cross');
            assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: '   ' }), 'cross');
        });
        assert.deepEqual(warns, []);
    });

    test('ocr／cross 照用（不分大小寫、前後空白）', () => {
        assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: 'ocr' }), 'ocr');
        assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: ' OCR ' }), 'ocr');
        assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: 'Cross' }), 'cross');
    });

    test('非法值 → cross，同一個值只警告一次（訊息指名變數與可用值）', () => {
        const warns = captureWarn(() => {
            assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: 'vision' }), 'cross');
            assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: 'vision' }), 'cross');
            assert.equal(modeCfg.resolveLocalExtractMode({ LOCAL_EXTRACT_MODE: 'ocr_only' }), 'cross');
        });
        assert.equal(warns.length, 2);
        assert.match(warns[0], /LOCAL_EXTRACT_MODE/);
        assert.match(warns[0], /cross／ocr/);
        assert.match(warns[0], /vision/);
    });

    test('沒給 env → 讀 process.env', () => {
        const saved = process.env.LOCAL_EXTRACT_MODE;
        try {
            process.env.LOCAL_EXTRACT_MODE = 'ocr';
            assert.equal(modeCfg.resolveLocalExtractMode(), 'ocr');
            delete process.env.LOCAL_EXTRACT_MODE;
            assert.equal(modeCfg.resolveLocalExtractMode(), 'cross');
        } finally {
            if (saved === undefined) delete process.env.LOCAL_EXTRACT_MODE; else process.env.LOCAL_EXTRACT_MODE = saved;
        }
    });

    test('矛盾設定：拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr、OCR_ENGINE=none → 回一句說清楚怎麼改的話', () => {
        const msg = modeCfg.localExtractConflict({ localExtract: true, mode: 'ocr', ocrEngine: 'none' });
        assert.match(msg, /LOCAL_EXTRACT_MODE=ocr/);
        assert.match(msg, /OCR_ENGINE=none/);
        assert.match(msg, /\.env/);
        assert.throws(() => modeCfg.assertLocalExtractConfig({ localExtract: true, mode: 'ocr', ocrEngine: 'none' }),
            (err) => err.code === 'LOCAL_EXTRACT_CONFLICT' && err.message === msg);
    });

    test('其餘組合都不是矛盾（Gemini 模式完全不受影響）', () => {
        for (const c of [
            { localExtract: false, mode: 'ocr', ocrEngine: 'none' },
            { localExtract: true, mode: 'cross', ocrEngine: 'none' },
            { localExtract: true, mode: 'ocr', ocrEngine: 'paddle' },
            { localExtract: true, mode: 'cross', ocrEngine: 'paddle' }
        ]) {
            assert.equal(modeCfg.localExtractConflict(c), null, JSON.stringify(c));
            assert.doesNotThrow(() => modeCfg.assertLocalExtractConfig(c));
        }
    });
});

describe('workers/jobRunner — LOCAL_EXTRACT_MODE', () => {
    before(() => { models.parseModel = parseWithOllama; });
    after(() => { models.parseModel = ORIGINAL_PARSE; });

    test('loadLocalExtractModeConfig 另開一支（loadLocalModeConfig 的回傳形狀不變）', () => {
        assert.deepEqual(runner.loadLocalExtractModeConfig({ LOCAL_EXTRACT_MODE: 'ocr' }), { localExtractMode: 'ocr' });
        assert.deepEqual(runner.loadLocalExtractModeConfig({}), { localExtractMode: 'cross' });
        assert.ok(!('localExtractMode' in runner.loadLocalModeConfig({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'ocr' })));
    });

    test('createRunner：拆題模型是 ollama 且 ocr＋OCR_ENGINE=none → 建立時就丟錯（啟動時報錯）', () => {
        const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }), pool: {} };
        assert.throws(() => runner.createRunner({
            db: fakeDb, llm: {}, logger: QUIET,
            config: { localExtract: true, localExtractMode: 'ocr', ocrEngine: 'none' }
        }), (err) => err.code === 'LOCAL_EXTRACT_CONFLICT' && /OCR_ENGINE=none/.test(err.message));
        // Gemini 模式、或 cross 模式：照常建立
        assert.doesNotThrow(() => runner.createRunner({ db: fakeDb, llm: {}, logger: QUIET, config: { localExtract: false, localExtractMode: 'ocr', ocrEngine: 'none' } }));
        assert.doesNotThrow(() => runner.createRunner({ db: fakeDb, llm: {}, logger: QUIET, config: { localExtract: true, localExtractMode: 'cross', ocrEngine: 'none' } }));
    });

    test('createRunner 從 env 讀：LOCAL_EXTRACT_MODE=ocr 疊進 config；opts.config 仍最優先', () => {
        const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }), pool: {} };
        const saved = { m: process.env.LOCAL_EXTRACT_MODE, e: process.env.MODEL_EXTRACT, o: process.env.OCR_ENGINE };
        try {
            process.env.LOCAL_EXTRACT_MODE = 'ocr';
            process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
            delete process.env.OCR_ENGINE;
            assert.equal(runner.createRunner({ db: fakeDb, llm: {}, logger: QUIET }).config.localExtractMode, 'ocr');
            assert.equal(runner.createRunner({ db: fakeDb, llm: {}, logger: QUIET, config: { localExtractMode: 'cross' } }).config.localExtractMode, 'cross');
            process.env.OCR_ENGINE = 'none';
            assert.throws(() => runner.createRunner({ db: fakeDb, llm: {}, logger: QUIET }), /LOCAL_EXTRACT_MODE=ocr/);
        } finally {
            for (const [k, v] of [['LOCAL_EXTRACT_MODE', saved.m], ['MODEL_EXTRACT', saved.e], ['OCR_ENGINE', saved.o]]) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
    });

    describe('ctx.config.localExtract 帶給 agent（agent 不讀 process.env）', () => {
        let agentsDir;
        before(() => {
            agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-agents-'));
            fs.writeFileSync(path.join(agentsDir, 'dedup0.js'), `
                module.exports = { async run(ctx) { globalThis.__modeCtxConfig = ctx.config; return { kind: 'pass', data: { text_hash: 'x' } }; } };`);
        });
        after(() => {
            fs.rmSync(agentsDir, { recursive: true, force: true });
            delete globalThis.__modeCtxConfig;
        });

        for (const mode of ['ocr', 'cross']) {
            test(`localExtractMode=${mode} → ctx.config.localExtract = { mode: '${mode}' }；ctx.config.ocr 形狀不變`, async () => {
                const row = {
                    id: 5, job_id: 2, idx: 1001, state: 'extracted', payload: { extract: { question_text: 'x' } }, retries: {},
                    kind: 'pdf', pdf_sha256: null, source_type: 'unknown', source_detail: null, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0
                };
                const db = { pool: {}, query: async (text) => (/FROM job_questions q JOIN jobs j/.test(text) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }) };
                const r = runner.createRunner({ db, llm: {}, logger: QUIET, agentsDir, config: { localExtractMode: mode, ocrEngine: 'paddle' } });
                await r.runJobQuestion(5);
                assert.deepEqual(globalThis.__modeCtxConfig.localExtract, { mode });
                assert.deepEqual(globalThis.__modeCtxConfig.ocr, { engine: 'paddle' });
            });
        }
    });
});

describe('workers/jobRunner — 只用 OCR 拆的題停在 ocr_only', () => {
    const p = (extra) => ({ extract: { question_text: 'x', ...extra } });
    const OCR_CC = { status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' };

    test('extract_mode=ocr → ocr_only（與「兩版不一致」分開）', () => {
        assert.equal(runner.crossCheckStopReason(p({ cross_check: OCR_CC, extract_mode: 'ocr' })), 'ocr_only');
    });

    test('extract_mode=ocr 但 cross_check 缺或壞掉 → 仍是 ocr_only（往安全的方向錯，絕不自動入庫）', () => {
        for (const cc of [undefined, null, {}, { status: 'agree' }, 'agree']) {
            const payload = p({ extract_mode: 'ocr', ...(cc === undefined ? {} : { cross_check: cc }) });
            assert.equal(runner.crossCheckStopReason(payload), 'ocr_only', JSON.stringify(cc));
        }
    });

    test('交叉驗證模式下「只有 OCR 版拆到」的題仍是 extract_disagree（沒有 extract_mode）', () => {
        assert.equal(runner.crossCheckStopReason(p({ cross_check: OCR_CC })), 'extract_disagree');
        assert.equal(runner.crossCheckStopReason(p({ cross_check: OCR_CC, extract_mode: 'cross' })), 'extract_disagree');
    });

    test('ocr_only 不是 error_class（job_events 寫 NULL，不撞 CHECK）', () => {
        assert.equal(runner.normalizeErrorClass('ocr_only'), null);
    });

    test('save 那一格（假 db）：needs_review(ocr_only)、事件 skipped、error_class NULL、不入庫；提示原樣留在 detail', async () => {
        const log = [];
        const row = {
            id: 88, job_id: 9, idx: 1001, state: 'deduped', retries: {},
            payload: p({ cross_check: OCR_CC, extract_mode: 'ocr', figure_hint: { reason: 'mentions' } }),
            kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0
        };
        const db = {
            pool: { connect: async () => { throw new Error('不該開交易（save 沒被執行）'); } },
            async query(text, params) {
                log.push({ text, params });
                if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: [row], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }
        };
        await runner.createRunner({ db, llm: {}, logger: QUIET, config: { renewIntervalMs: 60000 } }).runJobQuestion(88);
        const ev = log.find(q => /INSERT INTO job_events/.test(q.text));
        assert.equal(ev.params[2], 'save');
        assert.equal(ev.params[12], 'skipped');
        assert.equal(ev.params[13], null);
        assert.deepEqual(JSON.parse(ev.params[14]), {
            reason: 'ocr_only', review_reason: 'ocr_only',
            cross_check: { status: 'ocr_only', similarity: null, picked: 'ocr' },
            figure_hint: { reason: 'mentions' }
        });
        const upd = log.find(q => /UPDATE job_questions SET state = 'needs_review'/.test(q.text));
        assert.deepEqual(upd.params, [88, 'ocr_only']);
        assert.ok(!log.some(q => /INSERT INTO questions/.test(q.text)), '不得入庫');
    });
});

describe('複核原因白名單與 0019', () => {
    const SQL = fs.readFileSync(path.join(APP_DIR, 'migrations', '0019_ocr_only_review.sql'), 'utf8');
    function reasons() {
        const original = process.env.DATABASE_URL;
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
        const { REVIEW_REASONS } = require('../../controllers/reviewController');
        if (original === undefined) delete process.env.DATABASE_URL;
        return REVIEW_REASONS;
    }

    test('reviewController：ocr_only 接在 extract_disagree 之後（第 11 個）', () => {
        const R = reasons();
        assert.equal(R.length, 11);
        assert.equal(R[9], 'extract_disagree');
        assert.equal(R[10], 'ocr_only');
    });

    test('0019 以完整值域重建 CHECK（白名單每個值都在），可重複套用（DROP … IF EXISTS 再 ADD）', () => {
        for (const r of reasons()) assert.ok(SQL.includes(`'${r}'`), `0019 的 CHECK 少了 ${r}`);
        const body = SQL.replace(/--.*$/gm, '');
        assert.match(body, /ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_review_reason_check;/);
        assert.match(body, /ADD CONSTRAINT job_questions_review_reason_check\s+CHECK \(review_reason IN \(/);
        assert.ok(!/job_events/.test(body), 'job_events.error_class 不變（政策停等寫 NULL）');
    });

    test('0019 是最新的一支；0015 沒被改（凍結）', () => {
        const files = fs.readdirSync(path.join(APP_DIR, 'migrations')).filter(f => f.endsWith('.sql')).sort();
        assert.equal(files[files.length - 1], '0019_ocr_only_review.sql');
        const f15 = fs.readFileSync(path.join(APP_DIR, 'migrations', '0015_extract_disagree.sql'), 'utf8');
        assert.ok(!f15.includes('ocr_only'));
    });
});

describe('CI 設定：LOCAL_EXTRACT_MODE=ocr（CI 回放與 Owner 實際用的路徑一致）', () => {
    const CI_YML = path.resolve(APP_DIR, '..', '.github', 'workflows', 'ci.yml');

    test('ci.yml 的 integration job 寫 LOCAL_EXTRACT_MODE: ocr；readCiModels 讀得到', () => {
        const yml = fs.readFileSync(CI_YML, 'utf8');
        assert.match(yml, /^\s+LOCAL_EXTRACT_MODE: ocr\s*$/m);
        assert.equal(sp.readCiModels().LOCAL_EXTRACT_MODE, 'ocr');
    });

    test('eval/.env.replay 也寫同一個值（npm run test:e2e／eval 手動跑、主控的 ci.sh 與 CI 一致）', () => {
        const dotenv = require('dotenv');
        const replay = dotenv.parse(fs.readFileSync(path.join(APP_DIR, 'eval', '.env.replay')));
        assert.equal(replay.LOCAL_EXTRACT_MODE, sp.readCiModels().LOCAL_EXTRACT_MODE, 'ci.yml 與 eval/.env.replay 要一起改');
    });

    test('suiteProcess：CI_OPTIONAL_KEYS 有它（照 ci.yml）、LOCAL_SHIELD 有它（.env 的值不帶進子行程）', () => {
        assert.ok(sp.CI_OPTIONAL_KEYS.includes('LOCAL_EXTRACT_MODE'));
        assert.ok(sp.LOCAL_SHIELD.includes('LOCAL_EXTRACT_MODE'));
        const ci = { MODEL_EXTRACT: 'ollama:a', MODEL_VERIFY: 'ollama:b', LOCAL_EXTRACT_MODE: 'ocr' };
        const env = sp.ciEnv({ base: { PATH: '/bin', LOCAL_EXTRACT_MODE: 'cross' }, models: ci, envFileKeys: ['LOCAL_EXTRACT_MODE'] });
        assert.equal(env.LOCAL_EXTRACT_MODE, 'ocr', '照 ci.yml，不照 .env');
        const rec = sp.ciEnv({ base: { PATH: '/bin', LOCAL_EXTRACT_MODE: 'cross' }, models: ci, envFileKeys: ['LOCAL_EXTRACT_MODE'], llmMode: 'record' });
        assert.equal(rec.LOCAL_EXTRACT_MODE, 'ocr', '錄製也照 ci.yml');
        const none = sp.ciEnv({ base: { PATH: '/bin', LOCAL_EXTRACT_MODE: 'ocr' }, models: { MODEL_EXTRACT: 'ollama:a', MODEL_VERIFY: 'ollama:b' }, envFileKeys: [] });
        assert.equal(none.LOCAL_EXTRACT_MODE, '', 'ci.yml 沒寫 → 空字串＝程式預設 cross（shell 裡設的也擋）');
    });

    test('.env.example 說明 LOCAL_EXTRACT_MODE（兩個值、Owner 要設 ocr）', () => {
        const ex = fs.readFileSync(path.join(APP_DIR, '.env.example'), 'utf8');
        assert.match(ex, /^#?\s*LOCAL_EXTRACT_MODE=/m);
        assert.match(ex, /cross/);
        assert.match(ex, /ocr/);
    });
});

describe('eval/lib/localMode：ocr 模式的錄製計畫與時間粗估', () => {
    const LOCAL_CI = { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', EMBED_MODEL: 'ollama:qwen3-embedding:0.6b', MODEL_NLQ: 'ollama:qwen3:8b' };
    const ALL = ['retrieval', 'classify', 'pipeline', 'nlq', 'variant', 'e2e'];

    test('拆題鏈：cross＝ocr→extract_vision→extract_ocr；ocr＝ocr→extract_ocr', () => {
        assert.deepEqual(local.extractChainFor('cross'), ['ocr', 'extract_vision', 'extract_ocr']);
        assert.deepEqual(local.extractChainFor('ocr'), ['ocr', 'extract_ocr']);
        assert.deepEqual(local.extractChainFor(undefined), local.LOCAL_EXTRACT_CHAIN);
    });

    test('effectiveModels 帶出 LOCAL_EXTRACT_MODE（沒寫＝cross）', () => {
        assert.equal(local.effectiveModels(LOCAL_CI).LOCAL_EXTRACT_MODE, 'cross');
        assert.equal(local.effectiveModels({ ...LOCAL_CI, LOCAL_EXTRACT_MODE: 'OCR' }).LOCAL_EXTRACT_MODE, 'ocr');
        assert.equal(local.effectiveModels({ ...LOCAL_CI, LOCAL_EXTRACT_MODE: 'weird' }).LOCAL_EXTRACT_MODE, 'cross');
    });

    test('ocr 模式：不需要看圖模型（qwen3-vl 不在要下載的清單），仍需要 OCR', () => {
        const p = local.recordingPlan({ models: { ...LOCAL_CI, LOCAL_EXTRACT_MODE: 'ocr' }, suites: ALL });
        assert.deepEqual(p.ollama, ['qwen3:8b', 'qwen3-embedding:0.6b']);
        assert.equal(p.needOcr, true);
        assert.equal(p.extractMode, 'ocr');
        assert.equal(p.configError, null);
        assert.ok(!p.uses.some(u => u.key === 'MODEL_EXTRACT'));
    });

    test('cross 模式（沒寫）與之前完全相同', () => {
        const p = local.recordingPlan({ models: LOCAL_CI, suites: ALL });
        assert.deepEqual(p.ollama, ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b']);
        assert.equal(p.extractMode, 'cross');
    });

    test('ci.yml 寫了 ocr＋OCR_ENGINE=none → configError（重錄工具據此停下）', () => {
        const p = local.recordingPlan({ models: { ...LOCAL_CI, LOCAL_EXTRACT_MODE: 'ocr', OCR_ENGINE: 'none' }, suites: ALL });
        assert.match(p.configError, /OCR_ENGINE=none/);
    });

    test('estimateLocalTime：ocr 模式下 OCR miss 之後只多算 extract_ocr（不算看圖）；沒被讀到的 extract_vision 不算進上限', () => {
        const summary = {
            suites: { pipeline: { byAgent: { ocr: { hits: 0, misses: 1 } }, missKeys: ['ocr/k1'], embed: null } },
            unhit: [{ agent: 'extract_vision', key: 'v1', previousVersion: false }, { agent: 'classify', key: 'c1', previousVersion: false }],
            embeddings: { missing: 0 }
        };
        const env = {};
        const cross = local.estimateLocalTime(summary, { env });
        const ocr = local.estimateLocalTime(summary, { env, mode: 'ocr' });
        const s = (a) => local.secPerCall(a, env);
        assert.equal(cross.upperSec - cross.lowerSec, s('extract_vision') + s('extract_ocr') + s('extract_vision') + s('classify'));
        assert.equal(ocr.upperSec - ocr.lowerSec, s('extract_ocr') + s('classify'));
        assert.equal(ocr.lowerSec, cross.lowerSec);
    });
});
