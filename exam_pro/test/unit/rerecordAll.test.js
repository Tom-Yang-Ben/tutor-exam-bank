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
const models = require('../../config/models');

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

    test('readCiModels：repo 的 ci.yml 與 config/models.js 的預設一致；讀不到就退回預設', () => {
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
        const yml = path.join(tmp, 'ci.yml');
        fs.writeFileSync(yml, 'env:\n  MODEL_EXTRACT: gemini:abc\n  MODEL_VERIFY: "gemini:def"   \n', 'utf8');
        assert.deepEqual({ ...sp.readCiModels(yml), source: null }, { MODEL_EXTRACT: 'gemini:abc', MODEL_VERIFY: 'gemini:def', source: null });
        const fallback = sp.readCiModels(path.join(tmp, '沒有這個檔.yml'));
        assert.equal(fallback.MODEL_EXTRACT, sp.FALLBACK_CI_MODELS.MODEL_EXTRACT);
        assert.match(fallback.source, /預設值/);
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
                analyze: async () => fakeAnalysis(),
                askYes: async () => false,
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
                analyze: async () => { analyzed += 1; return fakeAnalysis(); },
                askYes: async () => { asked += 1; return true; },
                runNode: async (opts) => { calls.push(opts); return { exitCode: 0, ms: 1, tail: [], reportFiles: [] }; }
            });
            assert.equal(code, 0);
        });
        assert.equal(asked, 1);
        assert.equal(analyzed, 2, '錄製前盤點一次、錄完回放驗證一次');
        assert.deepEqual(calls.map(c => c.args.slice(-1)[0]), ['classify', 'pipeline']);
        for (const c of calls) {
            assert.equal(c.env.LLM_MODE, 'record');
            assert.equal(c.env.MODEL_EXTRACT, sp.readCiModels().MODEL_EXTRACT, '.env 的 MODEL_EXTRACT 不得帶進錄製');
            assert.equal(c.env.GEMINI_API_KEY, 'k');
        }
    });

    test('main：沒有金鑰或測試庫時不問 yes 就停（結束碼 1）；--dry-run 不需要金鑰、不錄', async (t) => {
        t.mock.method(console, 'log', () => {});
        t.mock.method(console, 'error', () => {});
        const deps = {
            analyze: async () => fakeAnalysis(),
            askYes: async () => { throw new Error('不該問'); },
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
});
