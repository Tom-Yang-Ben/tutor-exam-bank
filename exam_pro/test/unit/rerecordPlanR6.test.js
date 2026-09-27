// ─────────────────────────────────────────────────────────────
// rerecordPlanR6.test.js — docs/local-mode.md 10.21「重錄計畫（2026-09-27，第五輪之後）」與工具對得上
//（〔整合 2026-09-27 dec/integration-r6〕）
//
// 10.21 叫 Owner 在自己的電腦上依序跑：
//   ① record_local.bat classify,nlq  ② （條件）O-5 選 2 時 lint.v3 先進來  ③ record_local.bat variant
//   ④ record_local.bat pipeline,e2e  ⑤ 重錄後的 perf:local、embed:thresholds、O-4 抽查、cassettes:prune（只列）
//   另有 C-e 的量測（ollama ps、server.log、local:bench-text --agent verify）。
// 這裡釘住：record_local.bat／rerecord_all.js 真的照這個順序、這些 LLM_MODE／EMBED_MODE 錄；要錄的模板版號就是文件寫的；
// 文件寫到的指令都存在；文件裡每一步的模式與工具相同（工具改了、文件沒跟著改就會紅）。
// 只讀檔與純函式，不連 DB、不呼叫模型。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');

const rerecord = require('../../eval/tools/rerecord_all');
const local = require('../../eval/lib/localMode');
const { readCiModels } = require('../../eval/lib/suiteProcess');

const stepsOf = (suites) => rerecord.recordSteps(rerecord.parseArgs(['--suites', suites]))
    .map(s => ({ name: s.name, llm: s.llmMode, embed: s.embedMode }));

/** 10.21 的三個錄製步驟：record_local.bat 的參數與 rerecord_all 實際跑的步驟（名稱、LLM_MODE、EMBED_MODE） */
const PLAN = [
    ['classify,nlq', [
        { name: 'embeddings', llm: 'replay', embed: 'live' },
        { name: 'classify', llm: 'record', embed: 'fixture' },
        { name: 'nlq', llm: 'record', embed: 'record' }
    ]],
    ['variant', [
        { name: 'embeddings', llm: 'replay', embed: 'live' },
        { name: 'variant', llm: 'record', embed: 'record' }
    ]],
    ['pipeline,e2e', [
        { name: 'pipeline', llm: 'record', embed: 'fixture' },
        { name: 'e2e-similar', llm: 'replay', embed: 'record' }
    ]]
];

describe('record_local.bat／rerecord_all.js 支援 10.21 的步驟與順序', () => {
    for (const [suites, want] of PLAN) {
        test(`record_local.bat ${suites} → ${want.map(s => s.name).join(' → ')}`, () => {
            assert.deepEqual(stepsOf(suites), want);
        });
    }

    test('一次全錄（或參數順序寫亂）時也是 classify → nlq → variant → pipeline → e2e（與 10.21 的順序相同）', () => {
        const order = (suites) => stepsOf(suites).map(s => s.name).filter(n => n !== 'embeddings');
        assert.deepEqual(order('classify,nlq,variant,pipeline,e2e'), ['classify', 'nlq', 'variant', 'pipeline', 'e2e-similar']);
        assert.deepEqual(order('e2e,pipeline,variant,nlq,classify'), ['classify', 'nlq', 'variant', 'pipeline', 'e2e-similar']);
    });

    test('record_local.bat 把命令列原樣接成 --suites（逗號分隔的清單原樣傳下去）', () => {
        const bat = fs.readFileSync(path.join(APP_DIR, 'scripts', 'windows', 'record_local.bat'), 'utf8');
        assert.ok(bat.split('\r\n').includes('if not "%~1"=="" set "SUITES=-- --suites %*"'));
        assert.ok(bat.includes('echo yes| %TEE% npm run cassettes:rerecord %SUITES%'));
    });

    test('pipeline 與 e2e 兩步用長逾時（看圖／OCR 整理一次可能超過 30 分），其餘步驟不用', () => {
        const plan = local.recordingPlan({ models: readCiModels(), suites: ['pipeline', 'e2e'] });
        for (const name of ['pipeline', 'e2e-similar']) {
            const env = rerecord.stepExtraEnv({ name }, plan, {});
            assert.ok(Number(env.OLLAMA_TIMEOUT_MS) >= 3 * 3600 * 1000, name);
            assert.ok(Number(env.JOB_NODE_TIMEOUT_MS) >= 3 * 3600 * 1000, name);
        }
        const env = rerecord.stepExtraEnv({ name: 'variant' }, plan, {});
        assert.equal(env.OLLAMA_TIMEOUT_MS, undefined);
    });

    test('〔D × 重錄〕.env 明寫舊範本的門檻（0.80／0.90／0.97）也不會帶進錄製子行程：錄的是程式預設（本機 0.72／0.87／0.99），與 CI 回放相同', () => {
        const { ciEnv } = require('../../eval/lib/suiteProcess');
        const { resolveSimilarityThresholds } = require('../../config/similarityThresholds');
        const old = { VARIANT_RETRIEVE_SIM_MIN: '0.80', VARIANT_OFFTOPIC_SIM_MIN: '0.90', DEDUP_DUP_THRESHOLD: '0.97', VARIANT_SIM_MIN: '0.80' };
        for (const [llmMode, embedMode] of [['record', 'record'], ['record', 'fixture'], ['replay', 'fixture']]) {
            const env = ciEnv({ llmMode, embedMode, base: { ...old }, envFileKeys: Object.keys(old), models: readCiModels() });
            for (const k of Object.keys(old)) assert.equal(env[k], '', `${llmMode}/${embedMode} ${k}`);
            const t = resolveSimilarityThresholds(env);
            assert.equal(t.mode, 'local');
            assert.deepEqual([t.variantRetrieveSimMin, t.variantOfftopicSimMin, t.dedupDup], [0.72, 0.87, 0.99]);
        }
    });

    test('ci.yml 是 OCR 為主：pipeline／e2e 錄 ocr＋extract_ocr，不需要看圖模型，要 PaddleOCR', () => {
        const models = readCiModels();
        assert.equal(models.LOCAL_EXTRACT_MODE, 'ocr');
        const plan = local.recordingPlan({ models, suites: ['pipeline', 'e2e'] });
        assert.equal(plan.extractMode, 'ocr');
        assert.equal(plan.needOcr, true);
        assert.equal(plan.configError, null);
        assert.ok(!plan.ollama.some(m => /-vl/.test(m)), plan.ollama.join(','));
    });
});

describe('10.21 要錄的模板版號', () => {
    const src = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');

    test('classify.v2、nlq.v2、variant.v2、extract_ocr.v2', () => {
        assert.equal(require('../../agents/classify').TEMPLATE ?? src('agents/classify.js').match(/const TEMPLATE = '([^']+)'/)[1], 'classify.v2');
        assert.match(src('services/nlqService.js'), /const TEMPLATE = 'nlq\.v2';/);
        assert.equal(require('../../agents/generateVariant').TEMPLATE, 'variant.v2');
        assert.match(src('agents/extract.js'), /const TEMPLATE_OCR = 'extract_ocr\.v2';/);
    });

    test('lint 仍是 lint.v2（O-5 待決）；升 lint.v3 時 10.21 的條件步驟要改成必做', () => {
        const lint = src('agents/lint.js').match(/const TEMPLATE = '([^']+)'/)[1];
        assert.ok(['lint.v2', 'lint.v3'].includes(lint), lint);
        const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
        const sec = doc.slice(doc.indexOf('### 10.21 '));
        if (lint === 'lint.v2') assert.match(sec, /O-5/);
    });
});

describe('docs/local-mode.md 10.21 與工具一致', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
    const start = doc.indexOf('### 10.21 重錄計畫（2026-09-27，第五輪之後）');
    const sec = start >= 0 ? doc.slice(start) : '';

    test('10.21 是最後一節', () => {
        assert.ok(start > 0);
        assert.equal(/^### /m.test(sec.slice(4)), false, '10.21 之後不應再有節');
    });

    test('三個錄製指令依序出現，每一步寫的 LLM_MODE／EMBED_MODE 與 rerecord_all 相同', () => {
        let last = -1;
        for (const [suites, want] of PLAN) {
            const cmd = `record_local.bat ${suites}`;
            const at = sec.indexOf(cmd);
            assert.ok(at > last, `${cmd} 要在前一步之後出現`);
            last = at;
            for (const s of want) {
                const line = `\`${s.name}\`：\`LLM_MODE=${s.llm}\`、\`EMBED_MODE=${s.embed}\``;
                assert.ok(sec.includes(line), `文件少了「${line}」`);
            }
        }
    });

    test('寫到的 npm 指令都存在於 package.json；cassettes:prune 只列不刪（沒有 --apply 的指令行）', () => {
        const scripts = require('../../package.json').scripts;
        const used = [...new Set([...sec.matchAll(/npm run ([a-z:-]+)/g)].map(m => m[1]))];
        for (const name of ['perf:local', 'embed:thresholds', 'cassettes:prune', 'cassettes:rerecord', 'local:bench-text']) {
            assert.ok(used.includes(name), `10.21 要寫到 npm run ${name}`);
        }
        for (const name of used) assert.ok(scripts[name], `package.json 沒有 ${name}`);
        const cmdLines = sec.split('\n').filter(l => /^\s*npm run cassettes:prune/.test(l));
        assert.ok(cmdLines.length >= 1);
        assert.ok(cmdLines.every(l => !l.includes('--apply')), cmdLines.join('\n'));
    });

    test('C-e 量測：ollama ps、Windows 的 server.log 位置、local:bench-text --agent verify（參數真的支援）', () => {
        assert.ok(sec.includes('ollama ps'));
        assert.ok(sec.includes('%LOCALAPPDATA%\\Ollama\\server.log'));
        assert.ok(sec.includes('npm run local:bench-text -- --agent verify'));
        const bench = require('../../eval/tools/local_bench_text');
        assert.equal(bench.parseArgs(['--agent', 'verify']).agent, 'verify');
    });
});
