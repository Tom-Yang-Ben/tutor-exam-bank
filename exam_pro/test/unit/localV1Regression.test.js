// 2026-09-25 本機模型（qwen3:8b）原始回應的回歸（dec/local-classify-nlq-prep；docs/local-mode.md 10.15）
//
// 資料：eval/fixtures/local_raw_2026-09-25.json——commit f77d1a3 的 classify.v1（92 支）與 nlq.v1（8 支）cassette 的
// response.data 逐字照抄（cassette 本身不動、不搬）。classify.v2／nlq.v2 還沒錄過，replay 一律 miss；這裡把
// 「模型的回答」固定成當時的原始回應，跑**現行**的 agents/classify.js 與 services/nlqService.js，
// 斷言程式那一層（章節後處理、名稱容錯、nlq 的證據檢查）在同一份輸出上補到哪裡——每一題都釘住。
//
// 這些數字**不是**重錄後的分數：模板改了，重錄後模型的回答一定會變。它們證明的是
//   ① 2026-09-25 的失敗照原樣重現得出來（15/92、nlq llm 欄 3/8）；
//   ② 後處理把哪幾題改對、沒有把任何原本對的題改錯；
//   ③ 剩下的錯是哪幾題（要靠模板與模型，見決策草稿 LC-1、LC-2、LC-4）。
// 規則是看過這批錯題之後寫的，在同一批題上的改善會高估對新題的效果（反例另見 chapterPostRules.test.js）。
//
// 執行：npm test（不連 DB、不呼叫模型）。要連 recall10 一起看：node eval/tools/local_v1_counterfactual.js（要測試庫）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const classify = require('../../agents/classify');
const nlq = require('../../services/nlqService');
const { parseQuery } = require('../../utils/nlqHeuristics');
const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
const metrics = require('../../eval/lib/metrics');
const { filtersExact } = require('../../eval/lib/suiteNlq');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fixtures', 'local_raw_2026-09-25.json'), 'utf8'));
const CLASSIFY_GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'golden', 'classify.json'), 'utf8')).entries;
const NLQ_GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'golden', 'nlq.json'), 'utf8')).entries;

const clone = (v) => JSON.parse(JSON.stringify(v));

// 2026-09-25 重現的 15 題（f77d1a3 以 replay 跑 eval/lib/suiteClassify.js 逐題得到，docs/local-mode.md 10.15 的表）
const RAW_WRONG = [
    'cls-fx-001', 'cls-fx-002', 'cls-fx-003', 'cls-fx-004', 'cls-fx-007', 'cls-fx-022', 'cls-fx-046', 'cls-fx-050',
    'cls-fx-052', 'cls-dr-001', 'cls-dr-002', 'cls-dr-007', 'cls-dr-008', 'cls-dr-020', 'cls-dr-030'
];

// 現行程式把哪幾題改了章（規則 id）；13 題全部改成 golden 的章
const EXPECTED_ADJUSTED = {
    'cls-fx-001': 'exp_log_third', 'cls-fx-002': 'exp_log_third', 'cls-fx-003': 'exp_log_third',
    'cls-fx-004': 'exp_log_third', 'cls-fx-007': 'exp_log_third', 'cls-dr-001': 'exp_log_third',
    'cls-dr-002': 'exp_log_third', 'cls-dr-020': 'exp_log_third',
    'cls-fx-022': 'dimension_space', 'cls-dr-007': 'dimension_space',
    'cls-dr-030': 'field_potential',
    'cls-fx-052': 'relative_1d',
    'cls-fx-050': 'free_fall_computation'
};

// 程式補不到、留給模板與模型的兩題（圓周運動的運動學／受力、K3 的平方關係；決策草稿 LC-2）
const STILL_WRONG = ['cls-dr-008', 'cls-fx-046'];

/** 與 eval/lib/suiteClassify.js 相同的 ctx：db=null、features.similar=false、閘門刻意不過 */
function suiteCtx(llm) {
    return {
        llm,
        db: null,
        job: { id: 0, budget_usd: Infinity, cost_usd: 0 },
        jq: { id: 0, idx: 0, payload: {}, retries: {} },
        logger: { info() {}, warn() {}, error() {} },
        config: {
            models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' },
            thresholds: { classifyMinConf: 0.8 },
            features: { similar: false, pipeline: true }
        },
        signal: undefined
    };
}

function rawLlm(calls) {
    const byQuestion = new Map(RAW.classify.map(r => [r.questionText, r.data]));
    return {
        generateJson: async (opts) => {
            calls.push(opts);
            const data = byQuestion.get(opts.cacheKeyParts.questionText);
            assert.ok(data !== undefined, `原始回應裡沒有這一題：${opts.cacheKeyParts.questionText.slice(0, 20)}`);
            return { data: clone(data), usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 }, latencyMs: 0, raw: null };
        },
        embed: async () => { throw new Error('不該呼叫 embed'); }
    };
}

async function runClassifyOnRaw() {
    const calls = [];
    const llm = rawLlm(calls);
    const rows = [];
    for (const e of CLASSIFY_GOLDEN) {
        const outcome = await classify.run(suiteCtx(llm), {
            subject: e.subject, chapter: e.decoy_chapter || '', chapter_confidence: 0, question_text: e.question_text
        });
        rows.push({ id: e.id, gold: e.chapter, pred: outcome.kind === 'pass' ? outcome.data.chapter : null, outcome });
    }
    return { rows, calls };
}

describe('原始回應檔的完整性', () => {
    test('92 題 classify、8 句 nlq；逐題對得上 golden（題號與題幹）', () => {
        assert.equal(RAW.source.commit, 'f77d1a3');
        assert.equal(RAW.source.model, 'qwen3:8b');
        assert.deepEqual(RAW.source.templates, { classify: 'classify.v1', nlq: 'nlq.v1' });
        assert.equal(RAW.classify.length, 92);
        assert.deepEqual(RAW.classify.map(r => r.id), CLASSIFY_GOLDEN.map(e => e.id), 'classify 的題號與 golden 同序');
        for (const r of RAW.classify) {
            const g = CLASSIFY_GOLDEN.find(e => e.id === r.id);
            assert.equal(r.questionText, String(g.question_text).trim(), `${r.id} 的題幹與 golden 不同（golden 改過就要重錄，這份回歸也要跟著看）`);
        }
        const llmSentences = NLQ_GOLDEN.filter(e => e.expect_path === 'llm');
        assert.deepEqual(RAW.nlq.map(r => r.id), llmSentences.map(e => e.id));
        assert.deepEqual(RAW.nlq.map(r => r.query), llmSentences.map(e => e.query));
    });

    test('與 eval/cassettes 裡還在的那幾支逐字相同（cassette 被 prune 之後以本檔為準）', () => {
        let present = 0;
        for (const r of [...RAW.classify, ...RAW.nlq]) {
            const file = path.join(ROOT, 'eval', 'cassettes', r.cassette);
            if (!fs.existsSync(file)) continue;
            present += 1;
            const c = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.equal(c.meta.model, 'qwen3:8b', r.cassette);
            assert.ok(['classify.v1', 'nlq.v1'].includes(c.meta.template), r.cassette);
            assert.deepEqual(c.response.data, r.data, `${r.cassette} 的 response.data 與原始回應檔不同`);
        }
        // 本分支建立時 100 支都在；之後 cassettes:prune --apply 刪掉也不算錯（本檔就是為了那時候留的）
        assert.ok(present === 0 || present === 100, `只剩部分 cassette（${present}/100）：確認是不是被手動刪改過`);
    });

    test('原始回應裡的控制字元是被 JSON 跳脫吃掉的 LaTeX 反斜線，只出現在 rationale（10/92），不在章節欄', () => {
        const ctrl = /[\x08\x09\x0C\x0D]/;
        const hit = RAW.classify.filter(r => ctrl.test(r.data.rationale || ''));
        assert.equal(hit.length, 10);
        assert.ok(RAW.classify.every(r => !ctrl.test(r.data.chapter)), '章節欄沒有控制字元（schema 的 enum 約束）');
        const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
        assert.ok(RAW.nlq.every(r => strings(r.data).every(s => !ctrl.test(s))), 'nlq 8 句都沒有');
        assert.ok(strings(RAW.classify[0].data).length >= 2, '量尺自我檢查：走得到字串值');
    });
});

describe('classify：2026-09-25 的原始回應', () => {
    test('原始的章節重現 15/92 題錯（accuracy 0.837、macro-F1 0.7419）', () => {
        const rows = RAW.classify.map(r => ({ id: r.id, gold: CLASSIFY_GOLDEN.find(e => e.id === r.id).chapter, pred: r.data.chapter }));
        assert.deepEqual(rows.filter(r => r.gold !== r.pred).map(r => r.id), RAW_WRONG);
        assert.equal(metrics.round4(metrics.accuracy(rows).accuracy), 0.837);
        assert.equal(metrics.round4(metrics.macroF1(rows).macroF1), 0.7419);
        // 15 題全是 schema 內的合法章名、confidence 都是 0.95～1——模型很篤定地答錯，信心分不出對錯
        for (const id of RAW_WRONG) {
            const r = RAW.classify.find(x => x.id === id);
            assert.ok(r.data.confidence >= 0.95, `${id} 的信心 ${r.data.confidence}`);
        }
    });

    test('現行 agent（v2 模板＋程式後處理）跑同一份回答：90/92，改了 13 題、全部改對，沒有把對的改錯', async () => {
        const { rows, calls } = await runClassifyOnRaw();
        assert.equal(calls.length, 92, '每題都走第二層（閘門刻意不過）');
        assert.ok(calls.every(c => c.template === 'classify.v2' && c.agent === 'classify'));

        const wrong = rows.filter(r => r.pred !== r.gold).map(r => r.id).sort();
        assert.deepEqual(wrong, STILL_WRONG);
        assert.equal(metrics.round4(metrics.accuracy(rows).accuracy), 0.9783);
        assert.equal(metrics.round4(metrics.macroF1(rows).macroF1), 0.908);

        const adjusted = {};
        for (const r of rows) {
            const adj = r.outcome.data.adjustments;
            if (!adj) continue;
            assert.equal(adj.length, 1, `${r.id}：只有一條界線規則，沒有名稱容錯`);
            adjusted[r.id] = adj[0].rule;
            assert.equal(adj[0].to, r.gold, `${r.id} 改完要等於 golden`);
            assert.equal(adj[0].from, RAW.classify.find(x => x.id === r.id).data.chapter, `${r.id} 記下模型原本的章`);
            assert.ok(r.outcome.data.rationale.startsWith(`〔界線規則：模型選「${adj[0].from}」`), r.outcome.data.rationale);
        }
        assert.deepEqual(adjusted, EXPECTED_ADJUSTED);

        const rawRight = new Set(RAW.classify.filter(r => r.data.chapter === CLASSIFY_GOLDEN.find(e => e.id === r.id).chapter).map(r => r.id));
        for (const r of rows) {
            if (rawRight.has(r.id)) assert.equal(r.pred, r.gold, `${r.id} 原本對、被改錯了`);
        }
    });

    test('門檻（eval/thresholds.json 的 classify，不動）：原始回答兩項都未達；現行程式同一份回答兩項都達到', async () => {
        const th = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'thresholds.json'), 'utf8')).classify.classify;
        const { rows } = await runClassifyOnRaw();
        assert.ok(metrics.accuracy(rows).accuracy >= th.accuracy);
        assert.ok(metrics.macroF1(rows).macroF1 >= th.macro_f1);
        // 餘裕很小：再錯一題「只有一兩題」的章，macro-F1 就可能掉到門檻下（docs/local-mode.md 10.15 的風險）
        assert.ok(metrics.macroF1(rows).macroF1 - th.macro_f1 < 0.02);
    });
});

describe('nlq：2026-09-25 的原始回應（llm 欄 8 句）', () => {
    const golden = NLQ_GOLDEN.filter(e => e.expect_path === 'llm');
    const byQuery = new Map(RAW.nlq.map(r => [r.query, r.data]));

    function fakeLlm() {
        return {
            generateJson: async (opts) => {
                assert.equal(opts.template, 'nlq.v2');
                const data = byQuery.get(opts.cacheKeyParts.query);
                assert.ok(data !== undefined);
                return { data: clone(data), usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 }, latencyMs: 0, raw: null };
            },
            embed: async () => { throw new Error('不該呼叫 embed'); }
        };
    }

    test('不帶原句的合併（nlq.v1 當時的伺服器端行為）重現 5/8（0.625）：036、040、042 錯', () => {
        const wrong = [];
        for (const e of golden) {
            const rules = parseQuery(e.query, { aliases: CHAPTER_ALIASES });
            assert.equal(rules.confident, false, `${e.id} 規則抓不到章節，才會走 LLM`);
            const merged = nlq.mergeLlm(rules.filters, rules.semantic_text, byQuery.get(e.query));
            if (!filtersExact(e.expect, nlq.validateFilters(merged.filters).filters).ok) wrong.push(e.id);
        }
        assert.deepEqual(wrong, ['nlq-036', 'nlq-040', 'nlq-042']);
    });

    test('現行 parseOnly（證據檢查＋平面／空間＋界線規則）跑同一份回答：6/8（0.75）；040 改對，042 只剩多列的一章', async () => {
        const got = {};
        for (const e of golden) {
            const parsed = await nlq.parseOnly({ query: e.query, llm: fakeLlm(), noCache: true, logger: { info() {}, warn() {}, error() {} } });
            assert.equal(parsed.parse_path, 'llm');
            const cmp = filtersExact(e.expect, parsed.filters);
            got[e.id] = { exact: cmp.ok, diff: cmp.diff, adjustments: parsed.adjustments };
        }
        assert.deepEqual(Object.keys(got).filter(id => !got[id].exact), ['nlq-036', 'nlq-042']);
        assert.deepEqual(got['nlq-040'].adjustments, ['題型 計算 不採用（句子沒有提到題型）']);
        assert.deepEqual(got['nlq-042'].adjustments, ['章節「空間向量內積」→「向量內積」（句子明講了平面或空間）', '題型 計算 不採用（句子沒有提到題型）']);
        assert.deepEqual(got['nlq-042'].diff, ['chapters: 期望 [向量內積] 得到 [向量的加減與係數積,向量內積]']);
        assert.deepEqual(got['nlq-036'].diff, ['chapters: 期望 [摩擦力與向心力,牛頓運動定律] 得到 [直線運動]']);
        // 界線規則在這 8 句上沒有觸發（它們的錯不是 A5／電學／K2 那幾組）；其餘 5 句一個條件都沒被動到
        for (const id of ['nlq-036', 'nlq-037', 'nlq-038', 'nlq-039', 'nlq-041', 'nlq-043']) {
            assert.deepEqual(got[id].adjustments, [], id);
        }
        const th = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'thresholds.json'), 'utf8')).nlq.llm;
        const rate = Object.values(got).filter(x => x.exact).length / golden.length;
        assert.equal(rate, 0.75);
        assert.ok(rate >= th.filters_exact, '同一份回答時達到門檻，但只多 1 句的餘裕（再錯 1 句就是 0.625）');
    });
});
