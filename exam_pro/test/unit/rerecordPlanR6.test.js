// ─────────────────────────────────────────────────────────────
// rerecordPlanR6.test.js — docs/local-mode.md 10.21「重錄計畫（2026-09-27，第五輪之後）」與工具對得上
//（〔整合 2026-09-27 dec/integration-r6〕）
//
// 10.21 叫 Owner 在自己的電腦上依序跑：
//   ① record_local.bat classify,nlq  ② 確認已含 lint.v3（〔Owner 2026-09-27 O-5 選 2〕已落實，dec/r6-lint-v3；不另錄）  ③ record_local.bat variant
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

    test('〔Owner 2026-09-27 O-5 選 2〕lint 是 lint.v3、lint_chem.v2；10.21 的 1a 寫成已落實（隨第 2、3 步一起錄、不另外跑），第 0 步不再要求答 O-5', () => {
        const lint = require('../../agents/lint');
        assert.equal(lint.TEMPLATE, 'lint.v3');
        assert.equal(lint.TEMPLATE_CHEM, 'lint_chem.v2');
        assert.match(src('agents/lint.js'), /const TEMPLATE = 'lint\.v3';/);   // 1a 叫 Owner 用 findstr 找的就是這一行
        const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
        const sec = doc.slice(doc.indexOf('### 10.21 '));
        const a = sec.indexOf('#### 1a. ');
        const b = sec.indexOf('#### 2. ');
        assert.ok(a > 0 && b > a);
        const s1a = sec.slice(a, b);
        assert.match(s1a, /〔Owner 2026-09-27 O-5 選 2，已落實於 `dec\/r6-lint-v3`〕/);
        assert.ok(s1a.includes(`findstr /C:"const TEMPLATE = 'lint.v3'" agents\\lint.js`));
        assert.match(s1a, /第 2 步（變式的 lint）與第 3 步（樣卷的 lint）裡一起錄到，不必另外跑指令/);
        assert.match(sec, /~~\*\*O-5 要先答\*\*~~〔Owner 2026-09-27 O-5 選 2/);
        assert.match(sec, /\| 1a \| 確認已含 lint\.v3（O-5 選 2，已落實） \|/);
        assert.match(sec.slice(sec.indexOf('#### 2. '), sec.indexOf('#### 3. ')), /lint（`lint\.v3`）/);
    });
});

describe('docs/local-mode.md 10.21 與工具一致', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
    const start = doc.indexOf('### 10.21 重錄計畫（2026-09-27，第五輪之後）');
    // 〔Owner 2026-09-27 改答 LC-2，dec/r6-classify-rules〕10.21 之後接了 10.22：本節的檢查只看 10.21 自己（到下一個 ### 為止）
    const next = start >= 0 ? doc.indexOf('\n### ', start + 4) : -1;
    const sec = start >= 0 ? doc.slice(start, next > start ? next : undefined) : '';

    // 〔Owner 2026-09-27 改答 LC-2〕原本釘「10.21 是最後一節」；末尾新增 10.22 之後，改成逐一釘住 10.21 之後的節（不允許其他節插進來）
    test('10.21 之後只有 10.22 一節', () => {
        assert.ok(start > 0);
        const after = [...doc.slice(start + 4).matchAll(/^### (.*)$/gm)].map(m => m[1]);
        assert.deepEqual(after, ['10.22 classify 重錄後的四條界線規則（2026-09-27，改答 LC-2）']);
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

// ─────────────────────────────────────────────────────────────
// 〔整合 r6 審查修正 dec/integration-r6-fix〕10.21 的「怎麼確認成功」要與工具實際的判定一致：
//   ① eval 未達門檻 → run.js 結束碼 1 → verifyReport.ok=false → record_local.bat 印 [!]（不會印 [OK]）；
//      所以 10.21 以回放驗證表的 replay miss／缺向量為準，並寫明「只有門檻欄 ❌ 不要重跑」，variant 一定是這樣。
//   ② OCR 模式的 pipeline 報表帶 not_applicable（D-2）：重錄工具的回放驗證表不把 saved_rate 列成 ❌、不列進「門檻未達」。
// ─────────────────────────────────────────────────────────────
describe('〔r6 審查〕10.21 的成功判準與 verifyReport／thresholdRows 一致', () => {
    const os = require('node:os');
    const audit = require('../../eval/lib/cassetteAudit');
    const { thresholdRows } = require('../../eval/lib/cassettePlan');
    const report2 = require('../../eval/lib/report2');
    const suitePipeline = require('../../eval/lib/suitePipeline');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerecord-r6-'));
    const TABLE = { pipeline: { pipeline: { saved_rate: 0.87, gate_pass_rate: 0.97, answer_agree_rate: 0.87 } } };

    /** 一個 suite、零 replay miss、零缺向量的回放盤點（cassetteAudit.summarize 的形狀） */
    function analysisOf(suite, { exitCode, reportFile }) {
        const events = [{ suite, kind: 'start' }];
        const runs = { [suite]: { exitCode, tail: [], reportFiles: reportFile ? [reportFile] : [] } };
        return { runs, events, summary: audit.summarize({ events, entries: [], suites: [suite], runs }) };
    }

    test('run.js：eval 未達門檻就把結束碼設成 1（與 CI 相同；10.21 因此不能拿 [OK] 當成功判準）', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'eval', 'run.js'), 'utf8');
        assert.match(src, /if \(cmp\.failures\.length\) \{\s*console\.error\(`\\n❌ \$\{res\.suite\} eval 未達門檻[^]*?process\.exitCode = 1;/);
    });

    test('門檻紅也會讓 verifyReport.ok=false（即使 replay miss 與缺向量都是 0）：variant 的 retrieved_coverage 0.5 < 0.8367', () => {
        const file = path.join(tmp, 'variant.json');
        fs.writeFileSync(file, JSON.stringify({ suite: 'variant', measured: { variant: { retrieved_coverage: 0.5, gate_pass_rate: 0.9 } } }), 'utf8');
        // 錄完的回放：run.js 因門檻未達回 1（門檻讀 eval/thresholds.json 本身，不另造）
        const v = rerecord.verifyReport(analysisOf('variant', { exitCode: 1, reportFile: file }));
        assert.equal(v.missTotal, 0);
        assert.equal(v.ok, false, '門檻紅 → 結束碼 1 → ok=false → record_local.bat 印 [!]');
        assert.ok(v.lines.some(l => l.startsWith('| variant | 1 | 0 | 0 | ❌') && l.includes('variant.retrieved_coverage 0.5000 <')), v.lines.join('\n'));
        assert.ok(v.thresholdFailures.some(f => f.startsWith('variant：variant.retrieved_coverage')));
    });

    test('record_local.bat：rerecord 回 1 時印 [!]、走不到 [OK]；並寫明「只有門檻欄紅燈…不要重跑」', () => {
        const bat = fs.readFileSync(path.join(APP_DIR, 'scripts', 'windows', 'record_local.bat'), 'utf8');
        const lines = bat.split('\r\n');
        const rc = lines.indexOf('if "%RC%"=="0" goto :done_ok');
        const fail = lines.findIndex(l => l.includes('[!] 錄製或回放驗證沒有全過'));
        const ok = lines.findIndex(l => l.includes('[OK] 重錄與回放驗證都通過'));
        assert.ok(rc > 0 && fail > rc && ok > fail && lines.slice(rc, ok).includes('exit /b %RC%'), '結束碼不是 0 就走 [!] 那一段，走不到 [OK]');
        assert.ok(bat.includes('只有「門檻」欄紅燈、replay miss 與缺向量都是 0：錄製已經成功，不要重跑'));
    });

    test('10.21：成功以 replay miss 與缺向量為準；只有門檻欄 ❌ 不要重跑；第 2 步點名 variant 一定印 [!]', () => {
        const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
        const sec = doc.slice(doc.indexOf('### 10.21 '));
        const step = (n) => {
            const a = sec.indexOf(`#### ${n}. `);
            const b = sec.indexOf(`#### ${n + 1}. `);
            assert.ok(a >= 0, `找不到第 ${n} 步`);
            return sec.slice(a, b > a ? b : undefined);
        };
        assert.match(step(0), /錄製成功＝這次錄的每一列 replay miss 與缺向量兩欄都是 0/);
        assert.match(step(0), /只有門檻欄 ❌、replay miss 與缺向量都是 0 時，這是預期的，錄製已經成功，不要重跑/);
        for (const n of [1, 2, 3]) {
            const s = step(n);
            assert.match(s, /\*\*怎麼確認成功\*\*：以(?: log 最後的「)?回放驗證(?:」)?表為準/, `第 ${n} 步`);
            assert.match(s, /不要重跑/, `第 ${n} 步`);
            assert.ok(!s.includes('視窗最後印「[OK] 重錄與回放驗證都通過」；'), `第 ${n} 步不可以把 [OK] 當成功判準`);
        }
        assert.match(step(2), /這一步視窗一定印「\[!\] 錄製或回放驗證沒有全過」、結束碼 1，不會印 \[OK\]/);
        assert.match(step(3), /不算 ❌/);
    });

    test('pipeline OCR 模式的報表：not_applicable 寫進 JSON，thresholdRows 不產生 failures、saved_rate 那一列標 na', () => {
        const na = { pipeline: { saved_rate: suitePipeline.OCR_SAVED_RATE_NOTE } };
        const res = {
            suite: 'pipeline',
            measured: { pipeline: { saved_rate: null, gate_pass_rate: 1, answer_agree_rate: 0.9, n: 10 } },
            notApplicable: na,
            ocrOnly: { saved_rate_note: suitePipeline.OCR_SAVED_RATE_NOTE, pre_approval: { passed: 10, total: 10, rate: 1 } },
            counts: { total: 10, saved: 0, needs_review: 10, rejected: 0, pending: 0 },
            nodes: {}, reviewReasons: [],
            cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: 0 },
            warnings: [],
            meta: { pdf: 'eval/fixtures/sample_exam.pdf', questionsExpected: 10, llmMode: 'replay', agentSources: {}, stateMachine: 'x', db: null, sources: {}, cassetteDir: 'eval/cassettes' }
        };
        const origLog = console.log;
        let emitted;
        try { console.log = () => {}; emitted = report2.emit({ res, dir: tmp }); } finally { console.log = origLog; }
        const doc = JSON.parse(fs.readFileSync(emitted.file, 'utf8'));
        assert.deepEqual(doc.not_applicable, na);

        const t = thresholdRows(doc, TABLE);
        assert.deepEqual(t.failures, []);
        const saved = t.rows.find(r => r.metric === 'pipeline.saved_rate');
        assert.equal(saved.ok, true);
        assert.equal(saved.na, suitePipeline.OCR_SAVED_RATE_NOTE);
        assert.ok(t.rows.filter(r => !r.na).every(r => r.ok));

        // 回放驗證表（門檻讀 eval/thresholds.json 本身）：那一列不是 ❌、註明不比門檻，也不列進「門檻未達」
        const v = rerecord.verifyReport(analysisOf('pipeline', { exitCode: 0, reportFile: emitted.file }));
        const row = v.lines.find(l => l.startsWith('| pipeline'));
        assert.ok(!row.includes('❌'), row);
        assert.match(row, /pipeline\.saved_rate n\/a（不比門檻：OCR 模式/);
        assert.deepEqual(v.thresholdFailures, []);
        assert.equal(v.ok, true);
    });

    test('沒有 not_applicable 的報表（交叉驗證／Gemini、舊報表）：saved_rate n/a 照舊是失敗；白名單以外的宣告直接丟錯', () => {
        const measured = { pipeline: { saved_rate: null, gate_pass_rate: 1, answer_agree_rate: 0.9, n: 10 } };
        const t = thresholdRows({ suite: 'pipeline', measured }, TABLE);
        assert.deepEqual(t.failures, ['pipeline.saved_rate：門檻 0.87 但這次是 n/a']);
        assert.equal(t.rows.find(r => r.metric === 'pipeline.saved_rate').ok, false);
        assert.throws(() => thresholdRows({ suite: 'pipeline', measured, not_applicable: { pipeline: { gate_pass_rate: 'x' } } }, TABLE), /白名單/);
    });

    test('rerecord_all 錄完的「下一步」：cassettes:prune 先不要 --apply（與 10.21 第 4 步、record_local.bat 一致）', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'eval', 'tools', 'rerecord_all.js'), 'utf8');
        assert.ok(!src.includes('確認後 npm run cassettes:prune -- --apply'));
        assert.ok(src.includes('npm run cassettes:prune 只列出 CI 不再讀到的過期檔；先不要 --apply'));
    });
});
