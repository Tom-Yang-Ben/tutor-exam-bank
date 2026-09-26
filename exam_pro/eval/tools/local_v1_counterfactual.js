// ─────────────────────────────────────────────────────────────
// eval/tools/local_v1_counterfactual.js — 以 2026-09-25 本機模型的原始回應回放「現行程式」（反事實量測）
//
//   node eval/tools/local_v1_counterfactual.js                 classify 與 nlq 兩個 suite
//   node eval/tools/local_v1_counterfactual.js --suite classify
//   node eval/tools/local_v1_counterfactual.js --raw-merge     nlq 另印一欄「不帶原句」的合併（＝nlq.v1 當時的伺服器端行為）的 filters_exact
//   node eval/tools/local_v1_counterfactual.js --no-post       classify 關掉程式後處理（＝重現 2026-09-25 的原始分數）
//   設了 TEST_DATABASE_URL 時 nlq 另量 recall10（會清空並灌測試庫，與 npm run eval:nlq 相同）。
//
// 問題：classify.v2／nlq.v2 的模板與 schema 還沒錄過任何 cassette（docs/local-mode.md 10.12），
//   replay 一律 miss，現行程式在本機模型上表現如何量不到。這支工具把 eval/fixtures/local_raw_2026-09-25.json
//  （f77d1a3 的 qwen3:8b classify.v1／nlq.v1 cassette 的 response.data 逐字照抄）當成「模型的回答」，
//   跑**現行**的 eval/lib/suiteClassify.js、suiteNlq.js：agent、後處理、證據檢查、計分都是現行程式，
//   只有模型那一步被換成「同一題 2026-09-25 的回答」。
//
// 這**不是**重錄後的分數：模板在 v1 → v2 之間改了（界線規則、nlq 的範例與提示），重錄後模型的回答一定會變。
// 它量的是「模型回答不變時，程式那一層單獨補得到哪裡」。原始回應裡找不到的題（golden 之後新增的）以
// replay miss 的凍結訊息丟錯，兩個 suite 照原本的規則把整欄印成 n/a。
//
// 不呼叫任何模型、不讀寫 cassette、不寫報表檔；只在自己的行程裡把 services/llm 的 generateJson 換掉。
// ─────────────────────────────────────────────────────────────

const path = require('path');

const RAW_FILE = path.resolve(__dirname, '..', 'fixtures', 'local_raw_2026-09-25.json');

function parseArgs(argv) {
    const args = { suites: ['classify', 'nlq'], rawMerge: false, noPost: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--suite') args.suites = [argv[++i]];
        else if (argv[i] === '--raw-merge') args.rawMerge = true;
        else if (argv[i] === '--no-post') args.noPost = true;
        else throw new Error(`不認得的參數：${argv[i]}`);
    }
    return args;
}

/**
 * 以原始回應取代 generateJson 的 llm 模組替身（就地換掉 services/llm 的 generateJson，只影響本行程）。
 * @param {object} raw local_raw_2026-09-25.json 的內容
 * @returns {() => void} 還原函式
 */
function installRawLlm(raw) {
    const llm = require('../../services/llm');
    const byQuestion = new Map(raw.classify.map(r => [r.questionText, r.data]));
    const byQuery = new Map(raw.nlq.map(r => [r.query, r.data]));
    const original = llm.generateJson;
    llm.generateJson = async (opts = {}) => {
        const parts = opts.cacheKeyParts || {};
        const data = opts.agent === 'classify' ? byQuestion.get(parts.questionText)
            : opts.agent === 'nlq' ? byQuery.get(parts.query) : undefined;
        if (data === undefined) {
            // 與 services/llm/fake.js 同一個凍結前綴：suite 會把它算成 replay miss，不當成模型答錯
            throw new Error(`LLM_MODE=replay 找不到 cassette（agent=${opts.agent} key=反事實回放：原始回應裡沒有這一題）。請在本機執行 npm run eval:record -- --suite <suite>`);
        }
        return {
            data: JSON.parse(JSON.stringify(data)),
            usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 },
            latencyMs: 0,
            raw: null
        };
    };
    return () => { llm.generateJson = original; };
}

/** --no-post：把 classify 的後處理換成恆等（重現 2026-09-25 當時的程式行為） */
function disableClassifyPostRules() {
    const rules = require('../../utils/chapterPostRules');
    const original = rules.boundaryTarget;
    rules.boundaryTarget = () => null;
    // agents/classify.js 在載入時解構了 boundaryTarget：先清掉它的快取，讓它重新載入時拿到恆等版
    delete require.cache[require.resolve('../../agents/classify.js')];
    return () => { rules.boundaryTarget = original; delete require.cache[require.resolve('../../agents/classify.js')]; };
}

function fmt(v) {
    return v === null || v === undefined ? 'n/a' : String(v);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    process.env.LLM_MODE = 'replay';
    process.env.EMBED_MODE = process.env.EMBED_MODE || 'fixture';
    // 與 .github/workflows/ci.yml 相同（只影響 recall10 讀哪一份向量檔；模型那一步已被換掉）
    process.env.EMBED_MODEL = process.env.EMBED_MODEL || 'ollama:qwen3-embedding:0.6b';

    const raw = require(RAW_FILE);
    const restoreLlm = installRawLlm(raw);
    const restorePost = args.noPost ? disableClassifyPostRules() : () => {};
    try {
        console.log(`反事實回放：${path.relative(process.cwd(), RAW_FILE)}（${raw.source.model}，${raw.source.recorded}，` +
            `${raw.source.templates.classify}／${raw.source.templates.nlq}，commit ${raw.source.commit}）`);
        console.log('模型的回答固定為當時的原始回應；agent、後處理與計分是現行程式。這不是重錄後的分數。\n');

        if (args.suites.includes('classify')) {
            const { runClassifySuite } = require('../lib/suiteClassify');
            const r = await runClassifySuite({});
            const m = r.measured.classify;
            console.log(`── classify${args.noPost ? '（關掉程式後處理）' : ''} ──`);
            console.log(`accuracy ${fmt(m && m.accuracy)}（${m ? `${m.correct}/${m.n}` : 'n/a'}）  macro_f1 ${fmt(m && m.macro_f1)}`);
            for (const row of r.perEntry) {
                if (row.pred === row.gold && !row.adjustments) continue;
                console.log(`  ${row.pred === row.gold ? '✓' : '✗'} ${row.id}  golden「${row.gold}」 結果「${row.pred}」${row.adjustments ? `  〔${row.adjustments.join('、')}〕` : ''}`);
            }
            for (const w of r.warnings) console.log(`  ⚠ ${w}`);
            for (const f of r.failures.slice(0, 3)) console.log(`  ✗ ${f.split('\n')[0]}`);
            console.log('');
        }

        if (args.suites.includes('nlq')) {
            const { runNlqSuite, filtersExact } = require('../lib/suiteNlq');
            const r = await runNlqSuite({});
            console.log('── nlq ──');
            for (const col of ['rules', 'llm']) {
                const m = r.measured[col];
                console.log(`${col}：rule_coverage ${fmt(m && m.rule_coverage)}  filters_exact ${fmt(m && m.filters_exact)}  recall10 ${fmt(m && m.recall10)}`);
            }
            for (const row of r.perEntry.filter(e => e.expect_path === 'llm')) {
                console.log(`  ${row.exact ? '✓' : '✗'} ${row.id}  ${row.diff.join('；') || '四欄全對'}` +
                    `${row.adjustments && row.adjustments.length ? `  〔${row.adjustments.join('；')}〕` : ''}` +
                    `${row.recall_hit === null ? '' : `  recall ${row.recall_hit ? '✓' : '✗'}`}`);
            }
            if (args.rawMerge) {
                // 對照欄：同一份原始回應、不帶原句的合併（nlq.v1 當時的伺服器端行為）
                const nlq = require('../../services/nlqService');
                const { parseQuery } = require('../../utils/nlqHeuristics');
                const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
                const golden = require('../golden/nlq.json').entries.filter(e => e.expect_path === 'llm');
                const byQuery = new Map(raw.nlq.map(x => [x.query, x.data]));
                let ok = 0;
                for (const e of golden) {
                    const rules = parseQuery(e.query, { aliases: CHAPTER_ALIASES });
                    const merged = nlq.mergeLlm(rules.filters, rules.semantic_text, byQuery.get(e.query));
                    if (filtersExact(e.expect, nlq.validateFilters(merged.filters).filters).ok) ok++;
                }
                console.log(`  對照（不帶原句的合併）：llm 欄 filters_exact ${ok}/${golden.length}`);
            }
            for (const w of r.warnings.filter(x => !/semantic_text 與 golden 不同/.test(x))) console.log(`  ⚠ ${w.split('\n')[0]}`);
            for (const f of r.failures.slice(0, 3)) console.log(`  ✗ ${f.split('\n')[0]}`);
        }
    } finally {
        restorePost();
        restoreLlm();
    }
}

if (require.main === module) {
    main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}

module.exports = { installRawLlm, RAW_FILE };
