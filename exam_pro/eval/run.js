// ─────────────────────────────────────────────────────────────
// eval/run.js — evaluation 的唯一入口
//
// 用法：
//   node eval/run.js --suite retrieval
//   node eval/run.js --suite retrieval --mode like            只跑 LIKE 基準欄（不需要向量、不需要 DB）
//   node eval/run.js --suite retrieval --engine pg            向量／hybrid 欄對真 PG 下 queries/hybrid.js
//   node eval/run.js --suite retrieval --golden eval/private/golden/retrieval.json
//   node eval/run.js --suite retrieval --write-baseline       第一次量測後寫 thresholds.json 初值
//
// 設計上的三個「不」：
//   1. **不靜默降級**。缺向量就把向量／hybrid 欄印成 n/a 並說明原因，不拿假向量湊數字。
//   2. **不在缺數字時假裝通過**。門檻已經存在卻量不到那一欄，一律當失敗——
//      否則「向量檔被誤刪」會表現成 CI 全綠。
//   3. **不讓私有層外流**。--golden 落在 eval/private/ 時強制切 cassette 目錄並拒絕寫公開報表。
// ─────────────────────────────────────────────────────────────

const path = require('path');

const { loadFixture } = require('./lib/fixtures');
const { loadGolden } = require('./lib/golden');
const { loadEmbeddings, assertComplete } = require('./lib/embeddings');
const { tokenizerSource, isStub: tokenizerIsStub } = require('./lib/tokenize');
const { buildEmbedText, embedTextSource, embedHash, isStub: embedTextIsStub } = require('./lib/embedText');
const { rankAll, queryTokensFor } = require('./lib/ranker');
const metrics = require('./lib/metrics');
const report = require('./lib/report');
const thresholds = require('./lib/thresholds');
const pgEngine = require('./lib/pgEngine');
const report2 = require('./lib/report2');
const replayMiss = require('./lib/replayMiss');
const { runClassifySuite } = require('./lib/suiteClassify');
const { runPipelineSuite } = require('./lib/suitePipeline');

const USAGE = `用法：node eval/run.js --suite retrieval|classify|pipeline [選項]

  --suite <name>        retrieval（階段 1）｜classify｜pipeline（階段 2，A-T14）
  --golden <path>       golden 檔（retrieval 預設 eval/golden/retrieval.json；
                        classify 預設 eval/golden/classify.json；pipeline 為答案卷目錄）
  --pdfs <path>         只有 --suite pipeline 用：PDF 路徑（預設 eval/fixtures/sample_exam.pdf）
  --mode <m>            like | vector | hybrid | all（預設 all）
  --engine <e>          memory | pg | auto（預設 auto：pg 相依齊全就用 pg，否則 memory）
  --scope <s>           chapter | subject | all（預設 subject）
  --fuse <f>            rrf | weighted（預設 rrf）
  --limit <n>           每題取前 n 名（預設 10）
  --no-exclude-self     不排除 query 題本身（預設排除）
  --write-baseline      把這次量測 −0.03 寫進 thresholds.json（只升不降）
  --reports-dir <dir>   報表輸出目錄（預設 eval/reports/）
`;

function parseArgs(argv) {
    const args = {
        suite: null, golden: null, mode: 'all', engine: 'auto', scope: 'subject',
        fuse: 'rrf', limit: 10, excludeSelf: true, writeBaseline: false, reportsDir: null,
        pdfs: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--suite': args.suite = argv[++i]; break;
            case '--golden': args.golden = argv[++i]; break;
            case '--pdfs': args.pdfs = argv[++i]; break;
            case '--mode': args.mode = argv[++i]; break;
            case '--engine': args.engine = argv[++i]; break;
            case '--scope': args.scope = argv[++i]; break;
            case '--fuse': args.fuse = argv[++i]; break;
            case '--limit': args.limit = Number(argv[++i]); break;
            case '--no-exclude-self': args.excludeSelf = false; break;
            case '--exclude-self': args.excludeSelf = true; break;
            case '--write-baseline': args.writeBaseline = true; break;
            case '--reports-dir': args.reportsDir = argv[++i]; break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    return args;
}

/** 記憶體 engine：直接用 eval/lib/ranker.js */
function runMemory(ctx) {
    const rows = { like: [], vector: [], hybrid: [] };
    const perQuery = [];
    for (const entry of ctx.golden.entries) {
        const source = ctx.fixture.byId.get(entry.query.value);
        const ranked = rankAll({
            source,
            questions: ctx.fixture.questions,
            vectorOf: ctx.emb.available ? ctx.emb.vectorOf : null,
            scope: ctx.args.scope,
            excludeIds: ctx.args.excludeSelf ? [source.id] : [],
            fuseMode: ctx.args.fuse,
            limit: ctx.args.limit
        });
        rows.like.push({ ranked: ranked.like, relevant: entry.relevant });
        if (ranked.vector) rows.vector.push({ ranked: ranked.vector, relevant: entry.relevant });
        if (ranked.hybrid) rows.hybrid.push({ ranked: ranked.hybrid, relevant: entry.relevant });
        perQuery.push({
            golden_id: entry.id, query_id: source.id, relevant: entry.relevant,
            hard_negatives: entry.hard_negatives, like_keywords: ranked.keywords,
            candidates: ranked.candidateCount,
            ranked: { like: ranked.like, vector: ranked.vector, hybrid: ranked.hybrid }
        });
    }
    return { rows, perQuery };
}

/** pg engine：LIKE 欄仍在記憶體，向量／hybrid 欄對 PG 下 queries/hybrid.js */
async function runPg(ctx) {
    const seeded = await pgEngine.seedFixture({
        questions: ctx.fixture.questions,
        vectorOf: ctx.emb.available ? ctx.emb.vectorOf : null,
        embedTextOf: buildEmbedText,
        hashOf: embedHash,
        model: ctx.emb.model
    });
    const fxToDb = seeded.idMap;
    const dbToFx = new Map([...fxToDb.entries()].map(([fx, db]) => [db, fx]));
    console.log(`已把 ${seeded.inserted} 題 fixture 灌進測試庫（TRUNCATE 後重灌）。`);

    const rows = { like: [], vector: [], hybrid: [] };
    const perQuery = [];
    // 等效精確：ef_search 不小於 fixture 題數（規劃 §5.3.3 / interfaces 第 5 條）
    const efSearch = Math.max(100, ctx.fixture.questions.length * 4);

    for (const entry of ctx.golden.entries) {
        const source = ctx.fixture.byId.get(entry.query.value);
        const memory = rankAll({
            source, questions: ctx.fixture.questions, vectorOf: null,
            scope: ctx.args.scope, excludeIds: ctx.args.excludeSelf ? [source.id] : [],
            limit: ctx.args.limit
        });
        rows.like.push({ ranked: memory.like, relevant: entry.relevant });

        const queryVector = ctx.emb.available ? ctx.emb.vectorOf(source) : null;
        let vecIds = null, hybIds = null;
        if (queryVector) {
            const excludeIds = ctx.args.excludeSelf ? [fxToDb.get(source.id)] : [];
            const common = {
                source, queryVector, scope: ctx.args.scope, excludeIds,
                fuseMode: ctx.args.fuse, limit: ctx.args.limit, efSearch
            };
            // 純向量欄走 sides:['vec']（interfaces 第 5 條、裁決 18），與 /similar 的 mode=vector 同一條路；
            // 查詢詞則對齊 retrievalService 的規則（權重 A 的章節與 keywords 段）。
            const queryTokens = queryTokensFor(source);
            vecIds = (await pgEngine.search({ ...common, sides: ['vec'], queryTokens: [] })).map(r => dbToFx.get(r.id));
            hybIds = (await pgEngine.search({ ...common, sides: ['vec', 'kw'], queryTokens })).map(r => dbToFx.get(r.id));
            rows.vector.push({ ranked: vecIds, relevant: entry.relevant });
            rows.hybrid.push({ ranked: hybIds, relevant: entry.relevant });
        }
        perQuery.push({
            golden_id: entry.id, query_id: source.id, relevant: entry.relevant,
            hard_negatives: entry.hard_negatives, like_keywords: memory.keywords,
            candidates: memory.candidateCount,
            ranked: { like: memory.like, vector: vecIds, hybrid: hybIds }
        });
    }
    return { rows, perQuery };
}

async function runRetrieval(args) {
    const warnings = [];

    const fixture = loadFixture();
    if (fixture.needsHumanConfirm) {
        warnings.push('fixture 仍標記 needs_human_confirm：60 題的答案尚未由開發者本人逐題核對，數字只能當骨架驗證用。');
    }

    const golden = loadGolden({ file: args.golden, fixtureById: fixture.byId });
    if (golden.isPrivate) {
        // 規劃 §5.3.2 的防呆：私有層的任何產出都不得落進 repo。
        process.env.EVAL_CASSETTE_DIR = path.resolve(__dirname, 'private', 'cassettes');
        if (!args.reportsDir) args.reportsDir = path.resolve(__dirname, 'private', 'reports');
        console.log('偵測到私有 golden：cassette 與報表目錄已強制切到 eval/private/（不進版控）。');
    }
    if (golden.pendingConfirm > 0) {
        warnings.push(`golden 有 ${golden.pendingConfirm}/${golden.entries.length} 筆仍是 needs_human_confirm 的建議稿，尚未人工定案。`);
    }
    if (tokenizerIsStub()) warnings.push(`分詞器仍是 eval stub（utils/tokenize.js 尚未合入）：LIKE 欄與 hybrid 的關鍵字側都不是最終規則。`);
    if (embedTextIsStub()) warnings.push(`buildEmbedText 仍是 eval stub（utils/embedText.js 尚未合入）：embed_hash 與最終規則不同。`);

    const wantVector = args.mode === 'all' || args.mode === 'vector' || args.mode === 'hybrid';
    const emb = loadEmbeddings({ questions: fixture.questions, optional: true });
    if (wantVector && !emb.available) {
        warnings.push(`向量／hybrid 欄為 n/a：${emb.reason.split('\n')[0]}`);
    } else if (emb.available) {
        assertComplete(emb);
    }

    // engine 決策：auto = 相依齊全就用 pg
    let engine = args.engine;
    if (engine === 'auto') engine = pgEngine.available() ? 'pg' : 'memory';
    if (engine === 'pg' && !pgEngine.available()) throw new Error(pgEngine.unavailableReason());
    if (engine === 'memory' && args.engine === 'auto' && wantVector) {
        warnings.push(`engine=memory（${pgEngine.unavailableReason().split('\n')[0]}）：這一輪量的是記憶體排序器，不是 prod 的 SQL 路徑。`);
    }

    const ctx = { args, fixture, golden, emb };
    const { rows, perQuery } = engine === 'pg' ? await runPg(ctx) : runMemory(ctx);

    const measured = {
        like: (args.mode === 'all' || args.mode === 'like') && rows.like.length ? metrics.summarize(rows.like) : null,
        vector: (args.mode === 'all' || args.mode === 'vector') && rows.vector.length ? metrics.summarize(rows.vector) : null,
        hybrid: (args.mode === 'all' || args.mode === 'hybrid') && rows.hybrid.length ? metrics.summarize(rows.hybrid) : null
    };
    for (const k of Object.keys(measured)) {
        if (!measured[k]) continue;
        for (const m of ['recall5', 'recall10', 'mrr']) measured[k][m] = metrics.round4(measured[k][m]);
    }

    const meta = {
        engine, scope: args.scope, fuseMode: args.fuse, limit: args.limit, excludeSelf: args.excludeSelf,
        model: emb.model, dim: emb.dim, embeddings: emb.available ? path.basename(emb.file) : null,
        tokenizer: tokenizerSource(), embedText: embedTextSource(),
        fixture: path.relative(path.resolve(__dirname, '..'), fixture.file).replace(/\\/g, '/'),
        fixtureQuestions: fixture.questions.length, fixturePending: fixture.needsHumanConfirm,
        golden: golden.isPrivate ? '（私有層，路徑不記錄）' : path.relative(path.resolve(__dirname, '..'), golden.file).replace(/\\/g, '/'),
        goldenEntries: golden.entries.length, goldenPending: golden.pendingConfirm
    };

    const emitted = report.emit({ measured, meta, perQuery: golden.isPrivate ? [] : perQuery, warnings, dir: args.reportsDir });

    // ── 門檻 ──
    if (args.writeBaseline) {
        if (tokenizerIsStub() || embedTextIsStub()) {
            throw new Error(
                '拒絕在 stub 狀態下寫入 thresholds.json 初值：\n' +
                `   分詞器=${tokenizerSource()}、buildEmbedText=${embedTextSource()}。\n` +
                '   等 WS-C 的 utils/tokenize.js 與 utils/embedText.js 合入後再跑 --write-baseline，否則基準線一定會被推翻。'
            );
        }
        const res = thresholds.writeBaseline({ measured, allowStub: false, meta });
        console.log(res.written ? `thresholds.json 已更新：\n  - ${res.changes.join('\n  - ')}` : 'thresholds.json 無需更新。');
        if (res.kept.length) console.log(`  保持不變：\n  - ${res.kept.join('\n  - ')}`);
    }

    const cmp = thresholds.compare(thresholds.loadThresholds(), measured);
    if (cmp.skipped.length) console.log(`未設門檻（只報告不擋）：${cmp.skipped.join('、')}`);
    const hvl = report.hybridVsLike(measured);
    if (hvl && !hvl.ok) cmp.failures.push(`hybrid 必須 ≥ LIKE：${hvl.message}`);

    if (cmp.failures.length) {
        console.error(`\n❌ eval 未達門檻：\n  - ${cmp.failures.join('\n  - ')}`);
        process.exitCode = 1;
    } else {
        console.log(`\n✅ eval 通過（比對了 ${cmp.checked} 個門檻）。`);
    }
    return emitted;
}

/**
 * 階段 2 兩個 suite 的共同外殼：跑 → 報表 → 門檻（ratchet）。
 *
 * 這裡有一條與階段 1 完全一致的 guard：**stub 狀態下不得寫 thresholds 初值**。
 * 理由也一樣——基準線一定會被真實作推翻，之後的 CI 會紅得莫名其妙，
 * 而紅燈的原因跟那次改動無關（eval/lib/thresholds.js 檔頭第 1 點）。
 *
 * @param {object} args
 * @param {(args:object) => Promise<object>} runner
 */
async function runStage2Suite(args, runner) {
    const res = await runner(args);

    if (res.isPrivate && !args.reportsDir) {
        args.reportsDir = path.resolve(__dirname, 'private', 'reports');
    }
    report2.emit({ res, dir: args.reportsDir, private: res.isPrivate });

    if (res.failures && res.failures.length) {
        // 第 5.2 條把「這是不是 replay miss」與「fork PR 要不要降級」留給 WS-D 判斷
        // （「這個判斷不在 services/llm 裡」是介面的原話）；比對只到 `--suite ` 為止（裁決 S2-14）。
        const { misses, others } = replayMiss.partitionFailures(res.failures);
        const show = list => list.slice(0, 10).join('\n  - ');

        if (misses.length && replayMiss.shouldDowngradeMiss()) {
            console.warn(
                `\n⚠️ ${res.suite} suite 有 ${misses.length} 筆 replay miss，因為這是 fork PR 而降為 warning：\n  - ${show(misses)}\n` +
                '   外部貢獻者拿不到金鑰、無法自己重錄 cassette（規劃 §5.3.3）；' +
                'main 與同 repo 分支上這會是紅燈。'
            );
        } else if (misses.length) {
            console.error(
                `\n❌ ${res.suite} suite 有 ${misses.length} 筆 replay miss：\n  - ${show(misses)}\n` +
                '   請在本機執行 npm run eval:record（需要金鑰），或確認 cassette 是否因為 prompt 模板／' +
                '模型 ID／schema／few-shot id 改動而失效（第 5.2 條）。'
            );
            process.exitCode = 1;
        }
        if (others.length) {
            console.error(`\n❌ ${res.suite} suite 有 ${others.length} 筆呼叫失敗：\n  - ${show(others)}`);
            process.exitCode = 1;
        }
        if (process.exitCode) return res;
    }

    if (args.writeBaseline) {
        const blockers = [];
        const st = res.meta.sources || {};
        if (st.anyStub) blockers.push(`轉接層仍有暫用／未合入：${JSON.stringify(st)}`);
        if (res.suite === 'pipeline' && res.caveats && res.caveats.anyStub) {
            blockers.push(`agent 仍有 stub：${JSON.stringify(res.meta.agentSources)}`);
        }
        if (res.suite === 'classify' && res.meta.agent === '（未合入）') {
            blockers.push('agents/classify.js 尚未合入，這一輪沒有任何分類數字');
        }
        if (blockers.length) {
            throw new Error(
                `拒絕在 stub 狀態下寫入 ${res.suite} 的 thresholds 初值：\n  - ${blockers.join('\n  - ')}\n` +
                '   等 WS-B／WS-C 的零件合入、cassette 錄好之後再跑 --write-baseline。'
            );
        }
        const w = thresholds.writeBaselineSuite({ suite: res.suite, measured: res.measured, meta: res.meta });
        console.log(w.written ? `thresholds.json 已更新：\n  - ${w.changes.join('\n  - ')}` : 'thresholds.json 無需更新。');
        if (w.kept.length) console.log(`  保持不變：\n  - ${w.kept.join('\n  - ')}`);
    }

    const cmp = thresholds.compareSuite(thresholds.loadThresholds(), res.suite, res.measured);
    if (cmp.skipped.length) console.log(`未設門檻（只報告不擋）：${cmp.skipped.join('、')}`);
    if (cmp.failures.length) {
        console.error(`\n❌ ${res.suite} eval 未達門檻：\n  - ${cmp.failures.join('\n  - ')}`);
        process.exitCode = 1;
    } else {
        console.log(`\n✅ ${res.suite} eval 通過（比對了 ${cmp.checked} 個門檻）。`);
    }
    return res;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.suite) { console.log(USAGE); return; }

    // 階段 2 的兩個 suite：形狀與 retrieval 不同（沒有三欄對照），
    // 所以走各自的入口與報表，只共用 thresholds 的 ratchet 規則。
    if (args.suite === 'classify') return runStage2Suite(args, runClassifySuite);
    if (args.suite === 'pipeline') return runStage2Suite(args, runPipelineSuite);

    if (args.suite !== 'retrieval') {
        throw new Error(`--suite ${args.suite} 不存在（可用：retrieval｜classify｜pipeline；formula 由 WS-C 以 node --test 表格測試跑，不走本入口）`);
    }
    if (!['like', 'vector', 'hybrid', 'all'].includes(args.mode)) throw new Error(`--mode 只能是 like|vector|hybrid|all`);
    if (!['memory', 'pg', 'auto'].includes(args.engine)) throw new Error(`--engine 只能是 memory|pg|auto`);
    if (!['chapter', 'subject', 'all'].includes(args.scope)) throw new Error(`--scope 只能是 chapter|subject|all`);
    if (!['rrf', 'weighted'].includes(args.fuse)) throw new Error(`--fuse 只能是 rrf|weighted`);
    await runRetrieval(args);
}

if (require.main === module) {
    main()
        .then(() => { if (process.exitCode) process.exit(process.exitCode); process.exit(0); })
        .catch(err => { console.error(`\n❌ ${err.message}`); process.exit(1); });
}

module.exports = { runRetrieval, runStage2Suite, parseArgs };
