// 階段 3 兩個新 suite 的接線測試（interfaces-stage3.md 第 8 條，WS-D）
//
// WS-D 在第 8 條的職責只有「接線」：run.js 的兩個分支、thresholds 的兩節、
// package.json 的兩個 script、ci.yml 的兩步。suite 的內容是 WS-B／WS-C 的事。
//
// 這一支要擋的是接線特有的兩種失敗，兩種都不會噴例外：
//   ① suite 檔還沒合入時整個 eval 入口爆掉（檔頭 require 一個不存在的模組）——
//      那會讓「跑 retrieval」也一起紅，而且紅的原因跟那次改動無關。
//   ② 用「尚未合入」的替身寫出 thresholds 初值——那條基準線一定會被真實作推翻。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const run = require('../../eval/run');
const thresholds = require('../../eval/lib/thresholds');
const report2 = require('../../eval/lib/report2');

describe('SUITE_METRICS 的兩節（第 8.2、8.3 條）', () => {
    test('nlq：兩欄三指標，欄與指標名逐字凍結', () => {
        assert.deepEqual(thresholds.SUITE_METRICS.nlq, {
            columns: ['rules', 'llm'],
            metrics: ['rule_coverage', 'filters_exact', 'recall10']
        });
    });

    test('variant：一欄兩指標；cost 與各閘門通過數不在門檻裡（第 8.3 條）', () => {
        assert.deepEqual(thresholds.SUITE_METRICS.variant, {
            columns: ['variant'],
            metrics: ['retrieved_coverage', 'gate_pass_rate']
        });
        // 成本越低越好，放進 ratchet 會變成反向門檻——只准更貴。
        assert.ok(!thresholds.SUITE_METRICS.variant.metrics.includes('cost_usd'));
    });

    test('階段 1／2 的三節一個字都沒被動到（既有基準線是契約）', () => {
        assert.deepEqual(thresholds.SUITE_METRICS.retrieval.metrics, ['recall5', 'recall10', 'mrr']);
        assert.deepEqual(thresholds.SUITE_METRICS.classify.columns, ['classify']);
        assert.deepEqual(thresholds.SUITE_METRICS.pipeline.metrics,
            ['saved_rate', 'gate_pass_rate', 'answer_agree_rate']);
    });
});

describe('thresholds.json 的兩節', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'thresholds.json'), 'utf8'));

    test('nlq／variant 都在，且欄與 SUITE_METRICS 對得起來', () => {
        for (const suite of ['nlq', 'variant']) {
            assert.ok(doc[suite], `thresholds.json 少了 ${suite} 節`);
            for (const col of thresholds.SUITE_METRICS[suite].columns) {
                assert.ok(doc[suite][col], `${suite} 少了 ${col} 欄`);
                for (const m of thresholds.SUITE_METRICS[suite].metrics) {
                    assert.ok(m in doc[suite][col], `${suite}.${col} 少了 ${m}`);
                }
            }
        }
    });

    test('目前全是 null＝尚未建立基準線，compareSuite 只報告不擋', () => {
        for (const suite of ['nlq', 'variant']) {
            const measured = Object.fromEntries(
                thresholds.SUITE_METRICS[suite].columns.map(c => [c, null]));
            const cmp = thresholds.compareSuite(doc, suite, measured);
            assert.deepEqual(cmp.failures, [], `${suite} 在骨架階段就擋人了`);
            assert.equal(cmp.checked, 0);
            assert.equal(cmp.skipped.length, thresholds.SUITE_METRICS[suite].columns.length);
        }
    });

    test('一旦寫入數字就變硬門檻：量不到那一欄算失敗', () => {
        // 這一條在驗「null 不擋、有值就擋」的分界還在——少了它，
        // 「cassette 被誤刪」會表現成 CI 全綠（thresholds.js 檔頭第 2 點）。
        const withNumbers = { ...doc, variant: { variant: { retrieved_coverage: 0.5, gate_pass_rate: 0.7 } } };
        const cmp = thresholds.compareSuite(withNumbers, 'variant', { variant: null });
        assert.equal(cmp.failures.length, 1, cmp.failures.join('；'));
        assert.ok(cmp.failures[0].includes('沒有量到'), cmp.failures[0]);
    });

    test('階段 1／2 的既有門檻數字沒被動到', () => {
        assert.equal(doc.retrieval.hybrid.recall5, 0.97);
        assert.equal(doc.classify.classify.accuracy, 0.87);
        assert.equal(doc.pipeline.pipeline.saved_rate, 0.87);
    });
});

describe('eval/run.js 的兩個新分支（第 8.5 條）', () => {
    test('suite 檔尚未合入時 run.js 仍然 require 得起來', () => {
        // 檔頭 require 一個不存在的模組，會讓 --suite retrieval 也一起炸。
        assert.equal(typeof run.loadStage3Suite, 'function');
        assert.deepEqual(Object.keys(run.STAGE3_SUITES).sort(), ['nlq', 'variant']);
    });

    test('替身回的是「全部 n/a」而不是假數字', async () => {
        for (const suite of ['nlq', 'variant']) {
            const res = await run.loadStage3Suite(suite)({});
            assert.equal(res.suite, suite);
            for (const col of thresholds.SUITE_METRICS[suite].columns) {
                assert.equal(res.measured[col], null, `${suite}.${col} 不該有數字`);
            }
            assert.deepEqual(res.failures, []);
            assert.equal(res.warnings.length, 1);
            assert.ok(res.warnings[0].includes('尚未合入'), res.warnings[0]);
        }
    });

    test('替身標記 anyStub，--write-baseline 因此會被 runStage2Suite 擋下來', async () => {
        // 用替身寫出來的基準線一定會被真實作推翻，之後的 CI 會紅得莫名其妙。
        const res = await run.loadStage3Suite('nlq')({});
        assert.equal(res.meta.sources.anyStub, true);
    });

    test('替身的 meta 指得到正確的 golden 與 cassette 目錄（第 8.4、8.5 條）', async () => {
        const nlq = await run.loadStage3Suite('nlq')({});
        const variant = await run.loadStage3Suite('variant')({});
        assert.equal(nlq.meta.golden, 'eval/golden/nlq.json');
        assert.equal(variant.meta.golden, 'eval/golden/variant.json');
    });

    test('--suite 的說明字串含五個 suite', () => {
        const src = fs.readFileSync(path.join(ROOT, 'eval', 'run.js'), 'utf8');
        assert.ok(src.includes('retrieval|classify|pipeline|nlq|variant'), 'USAGE 沒更新');
        assert.ok(src.includes("STAGE3_SUITES[args.suite]"), 'main() 沒有分派兩個新 suite');
    });
});

describe('報表：nlq／variant 走通用表（第 8.1 條）', () => {
    test('markdownGeneric 把 measured 依 SUITE_METRICS 攤開，n/a 也印得出來', () => {
        const md = report2.markdownGeneric({
            suite: 'nlq',
            measured: { rules: { rule_coverage: 0.82, filters_exact: 0.74, recall10: 0.9 }, llm: null }
        });
        assert.ok(md.includes('| rule_coverage | 0.8200 | n/a |'), md);
        assert.ok(md.includes('| recall10 | 0.9000 | n/a |'), md);
    });

    test('extra 的數字只報告、不進門檻表（第 8.3 條）', () => {
        const md = report2.markdownGeneric({
            suite: 'variant',
            measured: { variant: { retrieved_coverage: 0.6, gate_pass_rate: 0.75 } },
            extra: { cost_usd: 0.0288, gates: { text_gate: 58, verify: 51 } }
        });
        assert.ok(md.includes('只報告、不設門檻'), md);
        assert.ok(md.includes('cost_usd'), md);
        assert.ok(!md.includes('| cost_usd |'), 'cost_usd 不該出現在門檻表裡');
    });

    test('classify／pipeline 仍走各自的專用表（既有輸出是契約）', () => {
        const src = fs.readFileSync(path.join(ROOT, 'eval', 'lib', 'report2.js'), 'utf8');
        assert.ok(src.includes('const RENDERER = { classify: markdownClassify, pipeline: markdownPipeline };'), src.slice(0, 200));
    });
});

describe('package.json 與 ci.yml 的接線', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    test('eval:nlq／eval:variant 兩個 script 都在，且走 eval（帶 .env.replay）', () => {
        assert.equal(pkg.scripts['eval:nlq'], 'npm run eval -- --suite nlq');
        assert.equal(pkg.scripts['eval:variant'], 'npm run eval -- --suite variant');
        // npm run eval 本身帶 --env-file=eval/.env.replay，兩個新 script 因此也不連外。
        assert.ok(pkg.scripts.eval.includes('eval/.env.replay'), pkg.scripts.eval);
    });

    test('既有的 scripts 沒被動到（scripts 由 WS-D 統一，但不代表可以改別人的）', () => {
        assert.equal(pkg.scripts.test, 'node --test "test/unit/**/*.test.js"');
        assert.equal(pkg.scripts['eval:classify'], 'npm run eval -- --suite classify');
        assert.equal(pkg.scripts['check:html'], 'node eval/tools/check_html.js');
    });

    test('ci.yml 的 integration job 有兩個新步驟，且沒有任何金鑰', () => {
        const ci = fs.readFileSync(path.resolve(ROOT, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
        assert.ok(ci.includes('npm run eval:nlq'), 'ci.yml 少了 eval:nlq');
        assert.ok(ci.includes('npm run eval:variant'), 'ci.yml 少了 eval:variant');
        // 第 9 條：GitHub Actions 不放任何 LLM 金鑰。
        assert.ok(!/GEMINI_API_KEY/.test(ci), 'ci.yml 出現了金鑰');
        assert.ok(ci.includes('LLM_MODE: replay') && ci.includes('EMBED_MODE: fixture'),
            'CI 必須恆為 replay/fixture（第 8.5 條）');
    });
});
