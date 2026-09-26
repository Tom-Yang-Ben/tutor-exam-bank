// ─────────────────────────────────────────────────────────────
// test/unit/rerecordAll.test.js — 重錄腳本（eval/tools/rerecord_all.js）與子行程環境（eval/lib/suiteProcess.js）
//
// 不連網、不跑任何 suite：盤點（analyze）與子行程（runNode）一律注入假的，
// 只驗「步驟順序與環境變數照 repo 既有的錄製機制」「沒輸入 yes 就一次都不錄」「驗證表的判讀」。
// dry-run 的計數邏輯（以 CH-A 合入後的 schema 為準）在 test/unit/cassetteAudit.test.js。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rerecord = require('../../eval/tools/rerecord_all');
const sp = require('../../eval/lib/suiteProcess');
const audit = require('../../eval/lib/cassetteAudit');
const local = require('../../eval/lib/localMode');
const models = require('../../config/models');

/** 〔本機模式 L4〕Gemini 路徑的測試明寫 CI 的模型（repo 的 ci.yml 已改成本機預設） */
const GEMINI_CI = Object.freeze({
    MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview',
    EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:gemini-3.5-flash', source: 'test'
});
/** 本機模式的 CI 設定（與 docs/local-mode.md 第 2 條、repo 的 ci.yml 相同） */
const LOCAL_CI = Object.freeze({
    MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b',
    EMBED_MODEL: 'ollama:qwen3-embedding:0.6b', MODEL_NLQ: 'ollama:qwen3:8b', source: 'test'
});

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerecord-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('parseArgs', () => {
    test('預設：全部 suite、正式錄製、含 e2e 的 dedup1 向量、錄完驗證', () => {
        assert.deepEqual(rerecord.parseArgs([]), {
            dryRun: false, json: false, suites: ['retrieval', 'classify', 'pipeline', 'nlq', 'variant', 'e2e'],
            withSimilar: true, verify: true, help: false
        });
    });

    test('--suites 依 CI 的順序排，不存在的名字與 --json 單用都擋下', () => {
        assert.deepEqual(rerecord.parseArgs(['--suites', 'e2e,classify']).suites, ['classify', 'e2e']);
        assert.throws(() => rerecord.parseArgs(['--suites', 'bogus']), /不存在/);
        assert.throws(() => rerecord.parseArgs(['--suites', '']), /至少一個/);
        assert.throws(() => rerecord.parseArgs(['--json']), /--dry-run/);
        assert.throws(() => rerecord.parseArgs(['--yes']), /未知的參數/, '沒有跳過 yes 確認的旗標');
        assert.equal(rerecord.parseArgs(['--dry-run', '--json']).json, true);
    });
});

describe('recordSteps：照 repo 既有的錄製機制，依序', () => {
    test('向量（只補缺的）→ classify → nlq → variant → pipeline → e2e 的 dedup1 向量', () => {
        const steps = rerecord.recordSteps();
        assert.deepEqual(steps.map(s => s.name), ['embeddings', 'classify', 'nlq', 'variant', 'pipeline', 'e2e-similar']);
        const by = Object.fromEntries(steps.map(s => [s.name, s]));

        // 第 1 步就是 eval/record_embeddings.js，只補缺的；EMBED_MODE=fixture 會被那支拒絕，所以用 live
        assert.deepEqual(by.embeddings.args, ['eval/record_embeddings.js', '--only-missing']);
        assert.equal(by.embeddings.embedMode, 'live');

        // 三個 suite 與 pipeline 走的就是 npm run eval -- --suite <s> 的同一行（eval/run.js），只換 LLM_MODE／EMBED_MODE
        for (const name of ['classify', 'nlq', 'variant', 'pipeline']) {
            assert.deepEqual(by[name].args, ['--env-file=eval/.env.replay', 'eval/run.js', '--suite', name]);
            assert.equal(by[name].llmMode, 'record', name);
        }
        // 裁決 S3-20：nlq 與 variant 的 LLM_MODE=record 與 EMBED_MODE=record 必須一起開
        assert.equal(by.nlq.embedMode, 'record');
        assert.equal(by.variant.embedMode, 'record');
        assert.equal(by.classify.embedMode, 'fixture');
        assert.equal(by.pipeline.embedMode, 'fixture');

        // e2e 自己只能 replay（LLM_MODE 不是 replay 時它拒絕執行）；這一步只錄 dedup1 用的向量
        assert.deepEqual(by['e2e-similar'].args, sp.suiteArgs('e2e'));
        assert.equal(by['e2e-similar'].llmMode, 'replay');
        assert.equal(by['e2e-similar'].embedMode, 'record');
        assert.deepEqual(by['e2e-similar'].extra, { FEATURE_SIMILAR: 'true' });
    });

    test('--no-similar 拿掉最後一步；只選部分 suite 時只錄需要的', () => {
        assert.ok(!rerecord.recordSteps({ withSimilar: false }).some(s => s.name === 'e2e-similar'));
        assert.deepEqual(rerecord.recordSteps({ suites: ['classify'] }).map(s => s.name), ['classify']);
        assert.deepEqual(rerecord.recordSteps({ suites: ['e2e'] }).map(s => s.name), ['pipeline', 'e2e-similar'],
            'e2e 的 LLM 呼叫由 pipeline 那一步順帶錄');
        assert.deepEqual(rerecord.recordSteps({ suites: ['retrieval'] }).map(s => s.name), ['embeddings']);
    });
});

describe('ciEnv：子行程一律照 CI 的設定', () => {
    const ciModels = { MODEL_EXTRACT: 'gemini:ci-extract', MODEL_VERIFY: 'gemini:ci-verify' };
    const base = {
        PATH: '/bin', TEST_DATABASE_URL: 'postgres://x/y_test', GEMINI_API_KEY: 'secret',
        MODEL_EXTRACT: 'gemini:local', MODEL_VARIANT: 'gemini:local-variant', FEATURE_SIMILAR: 'true',
        JIEBA_DICT_BIG: '/x/dict.txt.big', API_KEY: 'k', EVAL_CASSETTE_DIR: '/tmp/c', NODE_TEST_CONTEXT: 'child-v8'
    };

    test('回放：模型照 ci.yml、.env 與 MODEL_*／FEATURE_* 一律設成空字串（擋住 dotenv 補值），金鑰不帶', () => {
        const env = sp.ciEnv({ base, models: ciModels, envFileKeys: ['API_KEY', 'TEST_DATABASE_URL'] });
        assert.equal(env.LLM_MODE, 'replay');
        assert.equal(env.EMBED_MODE, 'fixture');
        assert.equal(env.MODEL_EXTRACT, 'gemini:ci-extract');
        assert.equal(env.MODEL_VERIFY, 'gemini:ci-verify');
        assert.equal(env.MODEL_VARIANT, '', '沒設＝退回 MODEL_VERIFY，與 CI 相同');
        assert.equal(env.FEATURE_SIMILAR, '');
        assert.equal(env.JIEBA_DICT_BIG, '');
        assert.equal(env.API_KEY, '', '.env 裡的其他設定不帶進去');
        assert.equal(env.GEMINI_API_KEY, '', '回放不需要金鑰');
        assert.equal(env.TEST_DATABASE_URL, 'postgres://x/y_test');
        assert.equal(env.EVAL_CASSETTE_DIR, '/tmp/c');
        assert.equal(env.PATH, '/bin');
        assert.ok(!('NODE_TEST_CONTEXT' in env), '在 node --test 底下呼叫時，子行程的 node --test 不得進入子測試回報模式');
    });

    test('錄製：金鑰與速率限制放行，其餘照舊；extra 最後蓋上去', () => {
        const env = sp.ciEnv({ base: { ...base, GEMINI_RPM: '30' }, models: ciModels, envFileKeys: [], llmMode: 'record', embedMode: 'record', extra: { FEATURE_SIMILAR: 'true' } });
        assert.equal(env.LLM_MODE, 'record');
        assert.equal(env.EMBED_MODE, 'record');
        assert.equal(env.GEMINI_API_KEY, 'secret');
        assert.equal(env.GEMINI_RPM, '30');
        assert.equal(env.MODEL_EXTRACT, 'gemini:ci-extract', '錄製也照 CI 的模型，否則錄出來的鍵 CI 讀不到');
        assert.equal(env.FEATURE_SIMILAR, 'true');
    });

    test('〔章節重整 CH-B〕.env 照 .env.example 填好時，子行程裡 pipeline 的預算仍與 CI（變數沒設）相同', () => {
        const { resolveBudgetUsd } = require('../../eval/lib/pipelineDriver');
        const exampleFile = path.join(sp.APP_DIR, '.env.example');
        const keys = sp.dotenvKeys(exampleFile);
        assert.ok(keys.includes('JOB_COST_BUDGET_USD'), '.env.example 應該有 JOB_COST_BUDGET_USD（前提不成立時這一則要重寫）');
        // rerecord_all.js 開頭會 dotenv.config() 把 .env 載進自己的 process.env，所以 base 也帶著這些值
        const example = require('dotenv').parse(fs.readFileSync(exampleFile));
        const ci = resolveBudgetUsd(undefined, {});
        assert.equal(ci, 0.5, 'CI 沒設 JOB_COST_BUDGET_USD，pipelineDriver 退回 0.5');
        for (const [llmMode, embedMode] of [['replay', 'fixture'], ['record', 'fixture'], ['record', 'record']]) {
            const env = sp.ciEnv({ base: { ...base, ...example }, models: ciModels, envFileKeys: keys, llmMode, embedMode });
            assert.equal(resolveBudgetUsd(undefined, env), ci, `${llmMode}/${embedMode}：子行程的預算必須與 CI 相同`);
            assert.notEqual(env.JOB_COST_BUDGET_USD, '', '設成空字串會讓 `??` 讀到 0');
        }
        // 對照組：照舊設成空字串時預算是 0——這就是要擋的情況
        assert.equal(resolveBudgetUsd(undefined, { JOB_COST_BUDGET_USD: '' }), 0);
        // 不在 .env、只在 Owner 的 shell 設了別的值：同樣照 CI
        const shellOnly = sp.ciEnv({ base: { ...base, JOB_COST_BUDGET_USD: '0.02' }, models: ciModels, envFileKeys: [] });
        assert.equal(resolveBudgetUsd(undefined, shellOnly), ci);
    });

    test('〔章節重整 CH-B〕程式裡以 `??` 讀環境變數、預設值不是空字串的，全都登錄在 CI_EFFECTIVE_DEFAULTS', () => {
        // `'' ?? x` 是 `''`：ciEnv 若把這種變數設成空字串，子行程的行為就與 CI（變數沒設）不同。
        // 新增這種讀法時要一併登錄；`?? ''` 與 `||` 的讀法不受影響，不必登錄。
        const DIRS = ['agents', 'config', 'controllers', 'eval', 'middleware', 'pipeline', 'queries', 'routes', 'services', 'utils', 'workers'];
        const SKIP = new Set(['node_modules', 'cassettes', 'reports', 'private', 'fixtures', 'golden']);
        const files = fs.readdirSync(sp.APP_DIR).filter(f => f.endsWith('.js')).map(f => path.join(sp.APP_DIR, f));
        const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.isDirectory()) { if (!SKIP.has(ent.name)) walk(path.join(dir, ent.name)); }
                else if (ent.name.endsWith('.js')) files.push(path.join(dir, ent.name));
            }
        };
        for (const d of DIRS) if (fs.existsSync(path.join(sp.APP_DIR, d))) walk(path.join(sp.APP_DIR, d));
        const re = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]*)\s*\?\?(?!\s*(?:''|""))/g;
        const found = new Map();
        for (const f of files) {
            for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
                found.set(m[1], path.relative(sp.APP_DIR, f).split(path.sep).join('/'));
            }
        }
        assert.ok(found.has('JOB_COST_BUDGET_USD'), '掃描要找得到已知的那一處（證明掃描本身有效）');
        const unlisted = [...found].filter(([k]) => !Object.prototype.hasOwnProperty.call(sp.CI_EFFECTIVE_DEFAULTS, k));
        assert.deepEqual(unlisted, [], '這些變數以 `??` 讀取，請在 eval/lib/suiteProcess.js 的 CI_EFFECTIVE_DEFAULTS 登錄 CI 生效的值');
        // 登錄的值就是讀取端「沒設」時的預設值
        const { resolveBudgetUsd } = require('../../eval/lib/pipelineDriver');
        assert.equal(Number(sp.CI_EFFECTIVE_DEFAULTS.JOB_COST_BUDGET_USD), resolveBudgetUsd(undefined, {}));
    });

    test('readCiModels：repo 的 ci.yml 是本機預設（docs/local-mode.md 第 2 條）；讀不到就退回預設；選填的鍵有寫才出現', () => {
        const ci = sp.readCiModels();
        assert.equal(ci.MODEL_EXTRACT, local.LOCAL_DEFAULTS.MODEL_EXTRACT);
        assert.equal(ci.MODEL_VERIFY, local.LOCAL_DEFAULTS.MODEL_VERIFY);
        assert.equal(ci.EMBED_MODEL, local.LOCAL_DEFAULTS.EMBED_MODEL);
        assert.deepEqual({ MODEL_EXTRACT: sp.FALLBACK_CI_MODELS.MODEL_EXTRACT, MODEL_VERIFY: sp.FALLBACK_CI_MODELS.MODEL_VERIFY },
            { MODEL_EXTRACT: local.LOCAL_DEFAULTS.MODEL_EXTRACT, MODEL_VERIFY: local.LOCAL_DEFAULTS.MODEL_VERIFY });

        const yml = path.join(tmp, 'ci.yml');
        fs.writeFileSync(yml, 'env:\n  MODEL_EXTRACT: gemini:abc\n  MODEL_VERIFY: "gemini:def"   \n', 'utf8');
        assert.deepEqual({ ...sp.readCiModels(yml), source: null }, { MODEL_EXTRACT: 'gemini:abc', MODEL_VERIFY: 'gemini:def', source: null },
            '沒寫 EMBED_MODEL／MODEL_NLQ 就不出現（子行程設成空字串＝程式預設）');
        const yml2 = path.join(tmp, 'ci2.yml');
        fs.writeFileSync(yml2, 'env:\n  MODEL_EXTRACT: ollama:qwen3-vl:8b\n  MODEL_VERIFY: ollama:qwen3:8b\n' +
            '  # EMBED_MODEL: 註解裡的不算\n  EMBED_MODEL: ollama:qwen3-embedding:0.6b\n  MODEL_NLQ: \'ollama:qwen3:8b\'\n', 'utf8');
        const two = sp.readCiModels(yml2);
        assert.equal(two.EMBED_MODEL, 'ollama:qwen3-embedding:0.6b', '只切第一段、保留模型 ID 裡的冒號');
        assert.equal(two.MODEL_NLQ, 'ollama:qwen3:8b');
        assert.ok(!('OCR_ENGINE' in two));
        const fallback = sp.readCiModels(path.join(tmp, '沒有這個檔.yml'));
        assert.equal(fallback.MODEL_EXTRACT, sp.FALLBACK_CI_MODELS.MODEL_EXTRACT);
        assert.match(fallback.source, /預設值/);
    });

    test('readCiModels：repo 的 ci.yml 與 config/models.js 的預設一致', {
        skip: models.VENDORS.includes('ollama') ? false : 'config/models.js 還沒有 ollama 供應商（本機模式 L1 尚未合入）；合入後這一則自動恢復執行'
    }, () => {
        const ci = sp.readCiModels();
        const saved = { e: process.env.MODEL_EXTRACT, v: process.env.MODEL_VERIFY };
        delete process.env.MODEL_EXTRACT; delete process.env.MODEL_VERIFY;
        try {
            assert.equal(ci.MODEL_EXTRACT, models.MODEL_EXTRACT);
            assert.equal(ci.MODEL_VERIFY, models.MODEL_VERIFY);
        } finally {
            if (saved.e !== undefined) process.env.MODEL_EXTRACT = saved.e;
            if (saved.v !== undefined) process.env.MODEL_VERIFY = saved.v;
        }
    });

    test('〔本機模式 L4〕回放：ci.yml 的 EMBED_MODEL／MODEL_NLQ 照 CI；.env 的 OCR_*／OLLAMA_*／長逾時一律設成空字串', () => {
        const ciLocal = { MODEL_EXTRACT: 'ollama:ci-vl', MODEL_VERIFY: 'ollama:ci-text', EMBED_MODEL: 'ollama:ci-embed', MODEL_NLQ: 'ollama:ci-nlq' };
        const dotenv = {
            EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:x', OCR_ENGINE: 'none', OCR_DPI: '300', OCR_PYTHON: 'C:/py.exe',
            OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_NUM_CTX: '8192', JOB_NODE_TIMEOUT_MS: '999', NLQ_TIMEOUT_MS: '5'
        };
        const env = sp.ciEnv({ base: { ...base, ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv) });
        assert.equal(env.EMBED_MODEL, 'ollama:ci-embed');
        assert.equal(env.MODEL_NLQ, 'ollama:ci-nlq');
        for (const k of ['OCR_ENGINE', 'OCR_DPI', 'OCR_PYTHON', 'OLLAMA_HOST', 'OLLAMA_NUM_CTX', 'JOB_NODE_TIMEOUT_MS', 'NLQ_TIMEOUT_MS']) {
            assert.equal(env[k], '', `${k} 回放時不得照 .env`);
        }
        // shell 裡設的（不在 .env）也一樣擋
        const shell = sp.ciEnv({ base: { ...base, OCR_ENGINE: 'none', OLLAMA_HOST: 'x' }, models: ciLocal, envFileKeys: [] });
        assert.equal(shell.OCR_ENGINE, '');
        assert.equal(shell.OLLAMA_HOST, '');
    });

    test('〔本機模式 L4〕錄製：放行 OLLAMA_* 與 OCR_PYTHON／OCR_TIMEOUT_MS（不進鍵）；OCR_ENGINE／OCR_DPI 仍照 CI（會改鍵或流程）', () => {
        const ciLocal = { MODEL_EXTRACT: 'ollama:ci-vl', MODEL_VERIFY: 'ollama:ci-text', OCR_DPI: '200' };
        const dotenv = {
            OLLAMA_HOST: 'http://127.0.0.1:11500', OLLAMA_CONCURRENCY: '1', OLLAMA_TIMEOUT_MS: '60000', OLLAMA_NUM_CTX: '8192',
            OLLAMA_KEEP_ALIVE: '5m', OLLAMA_RPM: '10', OCR_PYTHON: 'C:/venv/python.exe', OCR_TIMEOUT_MS: '1000', OCR_ENGINE: 'none', OCR_DPI: '300'
        };
        const env = sp.ciEnv({ base: { ...base, ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv), llmMode: 'record', embedMode: 'record' });
        for (const k of ['OLLAMA_HOST', 'OLLAMA_CONCURRENCY', 'OLLAMA_TIMEOUT_MS', 'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_RPM', 'OCR_PYTHON', 'OCR_TIMEOUT_MS']) {
            assert.equal(env[k], dotenv[k], `${k} 錄製時要放行`);
        }
        assert.equal(env.OCR_ENGINE, '', 'OCR_ENGINE 照 CI（沒寫＝程式預設 paddle），不照 .env 的 none');
        assert.equal(env.OCR_DPI, '200', 'OCR_DPI 照 ci.yml 的值');
    });

    test('suiteArgs：與 package.json 的 npm run eval／test:e2e 同一行', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(sp.APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts.eval, 'node --env-file=eval/.env.replay eval/run.js');
        assert.deepEqual(sp.suiteArgs('classify'), ['--env-file=eval/.env.replay', 'eval/run.js', '--suite', 'classify']);
        assert.equal(pkg.scripts['test:e2e'], `node ${sp.suiteArgs('e2e').map(a => (a.includes('*') ? `"${a}"` : a)).join(' ')}`);
        assert.throws(() => sp.suiteArgs('bogus'), /未知的 suite/);
        assert.equal(pkg.scripts['cassettes:rerecord'], 'node eval/tools/rerecord_all.js');
        assert.equal(pkg.scripts['cassettes:prune'], 'node eval/tools/prune_cassettes.js');
    });
});

describe('yes 確認與驗證表', () => {
    test('只有 yes（不分大小寫、前後空白）算同意', () => {
        for (const a of ['yes', 'YES', ' Yes ']) assert.equal(rerecord.isYes(a), true, a);
        for (const a of ['y', '', 'yes please', 'no', null, undefined]) assert.equal(rerecord.isYes(a), false, String(a));
    });

    /** 假的盤點結果：沿用 cassetteAudit.summarize 的形狀 */
    function fakeAnalysis({ misses = 0, embedMisses = 0, e2eEmbedMisses = 0, exitCodes = {}, reportFiles = {}, tail = {} } = {}) {
        const suites = ['classify', 'e2e'];
        const events = [
            { suite: 'classify', kind: 'start' }, { suite: 'e2e', kind: 'start' },
            ...Array.from({ length: misses }, (_, i) => ({ suite: 'classify', kind: 'llm', agent: 'classify', model: 'm', key: `k${i}`, hit: false })),
            ...Array.from({ length: embedMisses }, (_, i) => ({ suite: 'classify', kind: 'embed', hash: `h${i}`, hit: false, chars: 1 })),
            ...Array.from({ length: e2eEmbedMisses }, (_, i) => ({ suite: 'e2e', kind: 'embed', hash: `e${i}`, hit: false, chars: 1 }))
        ];
        const runs = {
            classify: { exitCode: exitCodes.classify ?? 0, tail: [], reportFiles: reportFiles.classify || [] },
            e2e: { exitCode: exitCodes.e2e ?? 0, tail: tail.e2e || ['# pass 11', '# fail 0', '# skipped 0'], reportFiles: [] }
        };
        return {
            runs, events,
            inventory: { dir: path.join(tmp, 'cassettes'), entries: [], skipped: [] },
            summary: audit.summarize({ events, entries: [], suites, runs }),
            models: { MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', source: 'test' }
        };
    }

    test('e2eCounts 撈 node --test 的統計', () => {
        assert.deepEqual(rerecord.e2eCounts(['x', '# pass 11', '# fail 2', '# skipped 0']), { pass: 11, fail: 2, skipped: 0 });
        assert.deepEqual(rerecord.e2eCounts([]), { pass: null, fail: null, skipped: null });
    });

    test('verifyReport：報表對照門檻；miss 或結束碼非 0 就不算過；e2e 存題時的缺向量不算', () => {
        const report = path.join(tmp, 'classify-report.json');
        fs.writeFileSync(report, JSON.stringify({ suite: 'classify', measured: { classify: { accuracy: 0.5, macro_f1: 0.99 } } }), 'utf8');
        const bad = rerecord.verifyReport(fakeAnalysis({ reportFiles: { classify: [report] }, exitCodes: { classify: 1 } }));
        assert.equal(bad.ok, false);
        assert.ok(bad.lines.some(l => l.includes('classify') && l.includes('accuracy 0.5000 <')), bad.lines.join('\n'));
        assert.ok(bad.thresholdFailures.some(f => f.startsWith('classify：')));

        const good = path.join(tmp, 'classify-good.json');
        fs.writeFileSync(good, JSON.stringify({ suite: 'classify', measured: { classify: { accuracy: 0.99, macro_f1: 0.99 } } }), 'utf8');
        const ok = rerecord.verifyReport(fakeAnalysis({ reportFiles: { classify: [good] }, e2eEmbedMisses: 3 }));
        assert.equal(ok.ok, true, ok.lines.join('\n'));
        assert.ok(ok.lines.some(l => l.includes('✅')));
        assert.ok(ok.lines.some(l => l.startsWith('| e2e') && l.includes('pass 11')));

        assert.equal(rerecord.verifyReport(fakeAnalysis({ reportFiles: { classify: [good] }, misses: 1 })).ok, false, '還有 replay miss');
        assert.equal(rerecord.verifyReport(fakeAnalysis({ reportFiles: { classify: [good] }, embedMisses: 1 })).ok, false, 'eval 缺向量');
    });

    /** 把 main() 會碰到的外部依賴都換掉 */
    function withEnv(vars, fn) {
        const saved = {};
        for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        return Promise.resolve().then(fn).finally(() => {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        });
    }

    test('main：沒輸入 yes 就一次都不錄，結束碼 0', async (t) => {
        t.mock.method(console, 'log', () => {});
        const calls = [];
        await withEnv({ GEMINI_API_KEY: 'k', TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            const code = await rerecord.main(['--suites', 'classify'], {
                readCiModels: () => GEMINI_CI,
                analyze: async () => fakeAnalysis(),
                askYes: async () => false,
                checkTestDbSchema: async () => ({ ok: true }),
                runNode: async (opts) => { calls.push(opts); return { exitCode: 0, ms: 1, tail: [], reportFiles: [] }; }
            });
            assert.equal(code, 0);
        });
        assert.deepEqual(calls, [], '沒有 yes 不得呼叫任何錄製步驟');
    });

    test('main：輸入 yes 後依序執行每一步，環境是 LLM_MODE=record 與 CI 的模型；最後回放驗證', async (t) => {
        t.mock.method(console, 'log', () => {});
        const calls = [];
        let analyzed = 0;
        let asked = 0;
        await withEnv({ GEMINI_API_KEY: 'k', TEST_DATABASE_URL: 'postgres://x/y_test', MODEL_EXTRACT: 'gemini:local-only' }, async () => {
            const code = await rerecord.main(['--suites', 'classify,e2e', '--no-similar'], {
                readCiModels: () => GEMINI_CI,
                analyze: async () => { analyzed += 1; return fakeAnalysis(); },
                askYes: async () => { asked += 1; return true; },
                checkTestDbSchema: async () => ({ ok: true }),
                runNode: async (opts) => { calls.push(opts); return { exitCode: 0, ms: 1, tail: [], reportFiles: [] }; }
            });
            assert.equal(code, 0);
        });
        assert.equal(asked, 1);
        assert.equal(analyzed, 2, '錄製前盤點一次、錄完回放驗證一次');
        assert.deepEqual(calls.map(c => c.args.slice(-1)[0]), ['classify', 'pipeline']);
        for (const c of calls) {
            assert.equal(c.env.LLM_MODE, 'record');
            assert.equal(c.env.MODEL_EXTRACT, GEMINI_CI.MODEL_EXTRACT, '.env 的 MODEL_EXTRACT 不得帶進錄製');
            assert.equal(c.env.GEMINI_API_KEY, 'k');
            assert.equal(c.env.JOB_NODE_TIMEOUT_MS, '', 'Gemini 路徑不帶本機長逾時（照 CI）');
        }
    });

    test('main：沒有金鑰或測試庫時不問 yes 就停（結束碼 1）；--dry-run 不需要金鑰、不錄', async (t) => {
        t.mock.method(console, 'log', () => {});
        t.mock.method(console, 'error', () => {});
        const deps = {
            readCiModels: () => GEMINI_CI,
            analyze: async () => fakeAnalysis(),
            askYes: async () => { throw new Error('不該問'); },
            checkTestDbSchema: async () => ({ ok: true }),
            runNode: async () => { throw new Error('不該錄'); }
        };
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            assert.equal(await rerecord.main(['--suites', 'classify'], deps), 1);
            assert.equal(await rerecord.main(['--dry-run', '--suites', 'classify'], deps), 0);
        });
        await withEnv({ GEMINI_API_KEY: 'k', TEST_DATABASE_URL: undefined }, async () => {
            assert.equal(await rerecord.main(['--suites', 'classify'], deps), 1);
        });
    });

    test('〔CR-8〕main：測試庫沒套 migration（或連不上）時不問 yes 就停，結束碼 1', async (t) => {
        t.mock.method(console, 'log', () => {});
        const errors = [];
        t.mock.method(console, 'error', (m) => errors.push(String(m)));
        const base = {
            readCiModels: () => GEMINI_CI,
            analyze: async () => fakeAnalysis(),
            askYes: async () => { throw new Error('不該問'); },
            runNode: async () => { throw new Error('不該錄'); }
        };
        await withEnv({ GEMINI_API_KEY: 'k', TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            assert.equal(await rerecord.main(['--suites', 'classify'], { ...base, checkTestDbSchema: async () => ({ ok: false, missing: ['attempts'] }) }), 1);
            assert.equal(await rerecord.main(['--suites', 'classify'], { ...base, checkTestDbSchema: async () => ({ ok: false, error: 'ECONNREFUSED' }) }), 1);
        });
        assert.ok(errors.some(e => e.includes('attempts') && e.includes('migrate:test')), errors.join('\n'));
        assert.ok(errors.some(e => e.includes('ECONNREFUSED')), errors.join('\n'));
    });

    // ── 〔本機模式 L4〕docs/local-mode.md 第 6 條第 2 點 ──

    /** 本機模式的注入：記下每一個錄前檢查的呼叫順序與參數 */
    function localDeps(over = {}) {
        const order = [];
        const seen = { ollama: [], ocr: [], runs: [] };
        const deps = {
            readCiModels: () => LOCAL_CI,
            analyze: async (o) => ({ ...fakeAnalysis(), models: o.models }),
            askYes: async () => { order.push('ask'); return true; },
            checkOllama: async (o) => { order.push('ollama'); seen.ollama.push(o); return { ok: true, reachable: true, installed: [], missing: [], error: null }; },
            checkOcr: async (o) => { order.push('ocr'); seen.ocr.push(o); return { ok: true, engineVersion: '3.0.0' }; },
            checkTestDbSchema: async () => { order.push('schema'); return { ok: true }; },
            runNode: async (opts) => { seen.runs.push(opts); return { exitCode: 0, ms: 1, tail: [], reportFiles: [] }; },
            ...over
        };
        return { deps, order, seen };
    }

    test('main（本機）：不需要 GEMINI_API_KEY；Ollama → OCR → migration 依序全過才問 yes；錄製帶本機逾時與連線設定', async (t) => {
        t.mock.method(console, 'log', () => {});
        const { deps, order, seen } = localDeps();
        await withEnv({
            GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test', OLLAMA_HOST: '127.0.0.1:11434',
            OCR_PYTHON: '/opt/venv/bin/python', OLLAMA_NUM_CTX: '8192'
        }, async () => {
            assert.equal(await rerecord.main(['--suites', 'classify,nlq,pipeline'], deps), 0);
        });
        assert.deepEqual(order, ['ollama', 'ocr', 'schema', 'ask']);
        assert.equal(seen.ollama[0].host, 'http://127.0.0.1:11434', '沒寫 scheme 補 http://');
        assert.deepEqual(seen.ollama[0].models, ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b'], 'MODEL_NLQ 與 MODEL_VERIFY 同一個，只列一次');
        assert.equal(seen.ocr[0].python, '/opt/venv/bin/python');
        assert.deepEqual(seen.runs.map(r => r.args.slice(-1)[0]), ['--only-missing', 'classify', 'nlq', 'pipeline']);
        for (const r of seen.runs) {
            const suite = r.args.slice(-1)[0];
            assert.equal(r.env.MODEL_EXTRACT, LOCAL_CI.MODEL_EXTRACT);
            assert.equal(r.env.EMBED_MODEL, LOCAL_CI.EMBED_MODEL, 'EMBED_MODEL 照 ci.yml');
            assert.equal(r.env.MODEL_NLQ, LOCAL_CI.MODEL_NLQ, 'MODEL_NLQ 照 ci.yml');
            // 〔看圖拆題逾時〕pipeline 那一步放寬到 3 小時（看圖拆題一塊就超過 30 分）；其餘步驟照舊 45 分
            assert.equal(r.env.JOB_NODE_TIMEOUT_MS, suite === 'pipeline' ? String(local.RECORD_LONG_TIMEOUT_MS) : String(local.LOCAL_NODE_TIMEOUT_MS),
                '一個節點可能跑二十分鐘（原則 5）；看圖拆題更久');
            assert.equal(r.env.NLQ_TIMEOUT_MS, String(local.LOCAL_NLQ_TIMEOUT_MS), 'NLQ 預設 4 秒在 CPU 上一定逾時，錄不到 cassette');
            assert.equal(r.env.OLLAMA_HOST, '127.0.0.1:11434', '錄製時放行本機連線設定');
            assert.equal(r.env.OLLAMA_NUM_CTX, '8192');
            assert.equal(r.env.OCR_PYTHON, '/opt/venv/bin/python');
        }
    });

    test('main（本機）：Ollama 連不上或缺模型 → 不問 yes、不錄，結束碼 1，提示開啟 Ollama／ollama pull', async (t) => {
        t.mock.method(console, 'log', () => {});
        const errors = [];
        t.mock.method(console, 'error', (m) => errors.push(String(m)));
        const noAsk = { askYes: async () => { throw new Error('不該問'); }, runNode: async () => { throw new Error('不該錄'); } };
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test', OLLAMA_HOST: undefined }, async () => {
            const down = localDeps({ ...noAsk, checkOllama: async () => ({ ok: false, reachable: false, installed: [], missing: ['qwen3:8b'], error: '連不上 Ollama（http://127.0.0.1:11434，ECONNREFUSED）' }) });
            assert.equal(await rerecord.main(['--suites', 'classify'], down.deps), 1);
            assert.ok(!down.order.includes('schema'), 'Ollama 沒過就不往下檢查');
            const missing = localDeps({ ...noAsk, checkOllama: async () => ({ ok: false, reachable: true, installed: ['qwen3:8b'], missing: ['qwen3-vl:8b'], error: '還沒有 qwen3-vl:8b' }) });
            assert.equal(await rerecord.main(['--suites', 'classify'], missing.deps), 1);
        });
        assert.ok(errors.some(e => e.includes('ECONNREFUSED')), errors.join('\n'));
        assert.ok(errors.some(e => e.includes('開啟 Ollama')), errors.join('\n'));
        assert.ok(errors.some(e => e.includes('ollama pull qwen3-vl:8b')), errors.join('\n'));
    });

    test('main（本機）：OCR 自我檢查沒過 → 結束碼 1，提示 setup_local_ai.bat；不錄 pipeline 或 ci.yml 設 OCR_ENGINE=none 時不檢查 OCR', async (t) => {
        t.mock.method(console, 'log', () => {});
        const errors = [];
        t.mock.method(console, 'error', (m) => errors.push(String(m)));
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            const bad = localDeps({
                askYes: async () => { throw new Error('不該問'); },
                checkOcr: async () => ({ ok: false, error: 'ocr_pdf.py --selftest 失敗：結束碼 1', detail: ['ModuleNotFoundError: paddleocr'] })
            });
            assert.equal(await rerecord.main(['--suites', 'pipeline'], bad.deps), 1);
            assert.ok(!bad.order.includes('schema'));

            const noPipeline = localDeps();
            assert.equal(await rerecord.main(['--suites', 'classify'], noPipeline.deps), 0);
            assert.ok(!noPipeline.order.includes('ocr'), '不錄 pipeline 就用不到 OCR');

            const none = localDeps({ readCiModels: () => ({ ...LOCAL_CI, OCR_ENGINE: 'none' }) });
            assert.equal(await rerecord.main(['--suites', 'pipeline'], none.deps), 0);
            assert.ok(!none.order.includes('ocr'), 'OCR_ENGINE=none：只跑視覺模型');
        });
        assert.ok(errors.some(e => e.includes('ModuleNotFoundError')), errors.join('\n'));
        assert.ok(errors.some(e => e.includes('setup_local_ai.bat')), errors.join('\n'));
    });

    test('main（混合）：MODEL_NLQ 明寫 Gemini 時要金鑰，訊息指名是哪一個', async (t) => {
        t.mock.method(console, 'log', () => {});
        const errors = [];
        t.mock.method(console, 'error', (m) => errors.push(String(m)));
        // 〔LM-7〕nlqService 沒設時的預設已改成本機；要測「混合」就明寫 Gemini 的 MODEL_NLQ
        const NLQ_GEMINI = 'gemini:gemini-3.5-flash';
        const mixed = localDeps({ readCiModels: () => ({ ...LOCAL_CI, MODEL_NLQ: NLQ_GEMINI }), askYes: async () => { throw new Error('不該問'); } });
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            assert.equal(await rerecord.main(['--suites', 'nlq'], mixed.deps), 1);
        });
        assert.ok(errors.some(e => e.includes('GEMINI_API_KEY') && e.includes(`MODEL_NLQ=${NLQ_GEMINI}`)), errors.join('\n'));
    });

    test('main --dry-run --json（本機）：印出本機區塊（要下載的模型、要不要 OCR、預估秒數），不做任何錄前檢查', async (t) => {
        const out = [];
        t.mock.method(console, 'log', (m) => out.push(String(m)));
        const { deps, order } = localDeps({ askYes: async () => { throw new Error('不該問'); } });
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            assert.equal(await rerecord.main(['--dry-run', '--json', '--suites', 'classify,pipeline'], deps), 0);
        });
        assert.deepEqual(order, [], 'dry-run 不連 Ollama、不跑 Python');
        const doc = JSON.parse(out.join('\n'));
        assert.deepEqual(doc.local.ollamaModels, ['qwen3-vl:8b', 'qwen3:8b']);
        assert.equal(doc.local.needOcr, true);
        assert.equal(doc.local.needGeminiKey, false);
        assert.ok(doc.local.estimateSec.upper >= doc.local.estimateSec.lower);
    });

    test('main（本機）：盤點表印預估時間、不印費用；確認訊息寫「不花錢」與粗估時間', async (t) => {
        const out = [];
        t.mock.method(console, 'log', (m) => out.push(String(m)));
        const { deps } = localDeps({ askYes: async () => false });
        await withEnv({ GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test' }, async () => {
            assert.equal(await rerecord.main(['--suites', 'classify'], deps), 0);
        });
        const text = out.join('\n');
        assert.match(text, /預估時間（本機，粗估）/);
        assert.match(text, /粗估/);
        assert.match(text, /不連外、不花錢/);
        assert.doesNotMatch(text, /會呼叫 Gemini、會產生費用/);
    });

    // ── 〔看圖拆題逾時〕pipeline 與 e2e 兩步的寬逾時（eval/lib/localMode.js 的 longCallRecordEnv） ──

    describe('〔看圖拆題逾時〕錄 pipeline／e2e 時的逾時與進度', () => {
        const plan = (m = LOCAL_CI, suites = ['classify', 'nlq', 'variant', 'pipeline', 'e2e']) => local.recordingPlan({ models: m, suites });
        /** Owner 實機的 .env（OLLAMA_TIMEOUT_MS＝30 分；rerecord_all.js 開頭 dotenv 已載進 process.env） */
        const OWNER_ENV = Object.freeze({ OLLAMA_TIMEOUT_MS: '1800000', OLLAMA_NUM_CTX: '16384', OCR_TIMEOUT_MS: '1800000' });
        const H3 = String(3 * 60 * 60 * 1000);

        test('常數：3 小時、進度 5 分、只有 pipeline 與 e2e-similar 兩步', () => {
            assert.equal(local.RECORD_LONG_TIMEOUT_MS, 10_800_000);
            assert.equal(local.RECORD_PROGRESS_MS, 300_000);
            assert.deepEqual(local.LONG_CALL_STEPS, ['pipeline', 'e2e-similar']);
            const names = rerecord.recordSteps().map(s => s.name);
            for (const n of local.LONG_CALL_STEPS) assert.ok(names.includes(n), `${n} 是 recordSteps() 的步驟名`);
        });

        test('stepExtraEnv：pipeline／e2e 蓋上 3 小時與進度；其餘步驟與之前相同（只有 localRecordEnv）', () => {
            const p = plan();
            const by = Object.fromEntries(rerecord.recordSteps().map(s => [s.name, rerecord.stepExtraEnv(s, p, OWNER_ENV)]));
            const base = local.localRecordEnv(p);
            for (const n of ['embeddings', 'classify', 'nlq', 'variant']) assert.deepEqual(by[n], base, n);
            assert.deepEqual(by.pipeline, {
                ...base, OLLAMA_TIMEOUT_MS: H3, JOB_NODE_TIMEOUT_MS: H3, E2E_NODE_TIMEOUT_MS: H3, OLLAMA_PROGRESS_MS: '300000'
            });
            assert.deepEqual(by['e2e-similar'], { ...by.pipeline, FEATURE_SIMILAR: 'true' }, '步驟自己的 extra 最後蓋上去');
            assert.equal(by.pipeline.NLQ_TIMEOUT_MS, String(local.LOCAL_NLQ_TIMEOUT_MS), 'localRecordEnv 的其他值照留');
        });

        test('RERECORD_* 覆寫；.env 的 OLLAMA_TIMEOUT_MS 比 3 小時長就照 .env；.env 明寫 OLLAMA_PROGRESS_MS（含 0）就不蓋', () => {
            const p = plan();
            assert.deepEqual(local.longCallRecordEnv(p, { ...OWNER_ENV, RERECORD_OLLAMA_TIMEOUT_MS: '14400000', RERECORD_NODE_TIMEOUT_MS: '21600000' }), {
                OLLAMA_TIMEOUT_MS: '14400000', JOB_NODE_TIMEOUT_MS: '21600000', E2E_NODE_TIMEOUT_MS: '21600000', OLLAMA_PROGRESS_MS: '300000'
            });
            assert.equal(local.longCallRecordEnv(p, { OLLAMA_TIMEOUT_MS: '18000000' }).OLLAMA_TIMEOUT_MS, '18000000', '.env 設 5 小時就是 5 小時，不縮短');
            assert.equal(local.longCallRecordEnv(p, {}).OLLAMA_TIMEOUT_MS, H3, '.env 沒寫：3 小時');
            for (const bad of ['abc', '0', '-1', '']) {
                assert.equal(local.longCallRecordEnv(p, { RERECORD_OLLAMA_TIMEOUT_MS: bad }).OLLAMA_TIMEOUT_MS, H3, bad);
                assert.equal(local.longCallRecordEnv(p, { RERECORD_NODE_TIMEOUT_MS: bad }).JOB_NODE_TIMEOUT_MS, H3, bad);
            }
            assert.ok(!('OLLAMA_PROGRESS_MS' in local.longCallRecordEnv(p, { OLLAMA_PROGRESS_MS: '0' })), '明寫 0＝不要進度，照 .env');
            assert.ok(!('OLLAMA_PROGRESS_MS' in local.longCallRecordEnv(p, { OLLAMA_PROGRESS_MS: '60000' })));
            assert.equal(local.longCallRecordEnv(p, { OLLAMA_PROGRESS_MS: '  ' }).OLLAMA_PROGRESS_MS, '300000', '空白＝沒寫');
        });

        test('Gemini 的 CI 模型：不帶任何本機逾時（與之前相同）', () => {
            const g = plan({ MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:c' });
            assert.deepEqual(local.longCallRecordEnv(g, OWNER_ENV), {});
            const pipe = rerecord.recordSteps().find(s => s.name === 'pipeline');
            assert.deepEqual(rerecord.stepExtraEnv(pipe, g, OWNER_ENV), {});
            assert.equal(rerecord.longCallNote(rerecord.recordSteps(), g, OWNER_ENV), null);
        });

        test('只影響逾時與進度：沒有任何一個會進 cassette 的鍵或改變流程（MODEL_*、FEATURE_*、EMBED_*、OCR_ENGINE／OCR_DPI）', () => {
            const keys = Object.keys(local.longCallRecordEnv(plan(), {}));
            assert.deepEqual(keys.sort(), ['E2E_NODE_TIMEOUT_MS', 'JOB_NODE_TIMEOUT_MS', 'OLLAMA_PROGRESS_MS', 'OLLAMA_TIMEOUT_MS']);
            for (const k of keys) {
                assert.ok(!/^(MODEL_|FEATURE_|EMBED_)/.test(k), k);
                assert.ok(!sp.CI_OPTIONAL_KEYS.includes(k), k);
                assert.ok(sp.LOCAL_SHIELD.includes(k), `${k} 回放時一律擋成空字串（CI 與錄完的驗證不受影響）`);
            }
        });

        test('ciEnv：回放時 E2E_NODE_TIMEOUT_MS／OLLAMA_PROGRESS_MS／VISION_MAX_EDGE_PX 一律空字串；錄製時後兩個放行、E2E 只由 extra 帶', () => {
            const ciLocal = { MODEL_EXTRACT: 'ollama:ci-vl', MODEL_VERIFY: 'ollama:ci-text' };
            const dotenv = { E2E_NODE_TIMEOUT_MS: '999', OLLAMA_PROGRESS_MS: '60000', VISION_MAX_EDGE_PX: '1600', OLLAMA_TIMEOUT_MS: '1800000' };
            const replay = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv) });
            for (const k of Object.keys(dotenv)) assert.equal(replay[k], '', `${k} 回放時不照 .env`);
            const rec = sp.ciEnv({ base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv), llmMode: 'record' });
            assert.equal(rec.OLLAMA_PROGRESS_MS, '60000');
            assert.equal(rec.VISION_MAX_EDGE_PX, '1600', '圖片不在鍵裡：Owner 平常開了縮圖，錄製照同一個設定');
            assert.equal(rec.E2E_NODE_TIMEOUT_MS, '', '.env 的 E2E_NODE_TIMEOUT_MS 不帶進去；只有 rerecord 錄 e2e 那一步帶');
            const withExtra = sp.ciEnv({
                base: { PATH: '/bin', ...dotenv }, models: ciLocal, envFileKeys: Object.keys(dotenv), llmMode: 'replay', embedMode: 'record',
                extra: { E2E_NODE_TIMEOUT_MS: H3 }
            });
            assert.equal(withExtra.E2E_NODE_TIMEOUT_MS, H3);
        });

        test('main（本機）：.env 的 OLLAMA_TIMEOUT_MS 是 30 分，pipeline 與 e2e 那兩步照樣拿到 3 小時；其餘步驟拿 .env 的 30 分；問 yes 前講明', async (t) => {
            const out = [];
            t.mock.method(console, 'log', (m) => out.push(String(m)));
            const { deps, seen } = localDeps();
            await withEnv({
                GEMINI_API_KEY: undefined, TEST_DATABASE_URL: 'postgres://x/y_test', OLLAMA_TIMEOUT_MS: '1800000',
                OLLAMA_PROGRESS_MS: undefined, RERECORD_OLLAMA_TIMEOUT_MS: undefined, RERECORD_NODE_TIMEOUT_MS: undefined, E2E_NODE_TIMEOUT_MS: undefined
            }, async () => {
                assert.equal(await rerecord.main(['--suites', 'classify,pipeline,e2e'], deps), 0);
            });
            const by = Object.fromEntries(seen.runs.map(r => [r.args.includes('--test') ? 'e2e-similar' : r.args.slice(-1)[0], r.env]));
            assert.deepEqual(Object.keys(by), ['classify', 'pipeline', 'e2e-similar']);
            assert.equal(by.classify.OLLAMA_TIMEOUT_MS, '1800000', 'classify 照 .env（一支幾十秒）');
            assert.equal(by.classify.E2E_NODE_TIMEOUT_MS, '');
            assert.equal(by.classify.OLLAMA_PROGRESS_MS, undefined, '沒寫就不設（不串流，與之前相同）');
            for (const n of ['pipeline', 'e2e-similar']) {
                assert.equal(by[n].OLLAMA_TIMEOUT_MS, H3, n);
                assert.equal(by[n].JOB_NODE_TIMEOUT_MS, H3, n);
                assert.equal(by[n].E2E_NODE_TIMEOUT_MS, H3, n);
                assert.equal(by[n].OLLAMA_PROGRESS_MS, '300000', n);
                assert.equal(by[n].MODEL_EXTRACT, LOCAL_CI.MODEL_EXTRACT, '模型照 CI（鍵不變）');
            }
            assert.equal(by['e2e-similar'].LLM_MODE, 'replay', 'e2e 那一步 LLM 照舊只回放');
            assert.equal(by['e2e-similar'].FEATURE_SIMILAR, 'true');
            assert.ok(out.some(l => l.includes('pipeline、e2e-similar：單次 Ollama 呼叫逾時 3 小時、節點逾時 3 小時') && l.includes('每 5 分印一次輸出進度')), out.join('\n'));
        });

        test('longCallNote：.env 明寫 OLLAMA_PROGRESS_MS=0 時講明不印進度；沒有長步驟時回 null', () => {
            const p = plan();
            assert.match(rerecord.longCallNote(rerecord.recordSteps(), p, { OLLAMA_PROGRESS_MS: '0' }), /不印輸出進度/);
            assert.equal(rerecord.longCallNote(rerecord.recordSteps({ suites: ['classify'] }), p, {}), null);
        });

        test('e2e 的 runner 節點逾時讀 E2E_NODE_TIMEOUT_MS，沒設時仍是 30 秒（CI 不變）', () => {
            const src = fs.readFileSync(path.join(sp.APP_DIR, 'test', 'e2e', 'pipeline.e2e.test.js'), 'utf8');
            assert.match(src, /process\.env\.E2E_NODE_TIMEOUT_MS/);
            assert.match(src, /: 30000;/);
            assert.match(src, /nodeTimeoutMs: NODE_TIMEOUT_MS/);
        });
    });
});
