// ─────────────────────────────────────────────────────────────
// eval/compare_pipeline.js — 新舊對照實驗（E-X12a，規劃 §5.3.5）
//
// 用法：
//   node eval/compare_pipeline.js --method legacy                       對自製樣卷跑舊流程（會連 Gemini）
//   node eval/compare_pipeline.js --method legacy --pdfs eval/private/pdf/ --golden eval/private/pdf_golden/
//   node eval/compare_pipeline.js --method pipeline                     對自製樣卷跑新管線（LLM_MODE=replay 可離線）
//   node eval/compare_pipeline.js --method legacy --dry-run             只做配對與載入檢查，不呼叫任何模型
//   node eval/compare_pipeline.js --method pipeline --repeat 3          跑三次取中位數
//
// 欄位（規劃 §5.3.5 逐字）：
//   q_expected | q_extracted | extract_recall | chapter_acc | formula_strict_rate
//   | token_in | token_out | cost_usd | latency_ms | model | prompt_hash
//   --method pipeline 另加：answer_agree_rate | dedup_hits | saved | needs_review
//
// 三條紅線：
//   1. **這支不進 CI。** --method legacy 一定會呼叫 Gemini；--method pipeline 在 replay 下
//      雖然不連外，但它的價值是跟 legacy 對照，單獨跑沒有意義。CI 跑的是 eval/run.js。
//   2. **私有輸入 → 私有輸出。** --pdfs 或 --golden 落在 eval/private/ 時，報表目錄強制切到
//      eval/private/reports/，而且**逐題明細不寫進報表**（規劃 §5.3.2 的防呆）。
//   3. **legacy 一定要是 legacy。** 見 eval/lib/legacyAdapter.js 的檔頭：
//      aiService 被 A-T8 換成新包裝之後，這一欄會悄悄變成量新管線。腳本會警告，請不要忽略。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { loadSheet, listPdfs, PRIVATE_DIR: PDF_PRIVATE_DIR } = require('./lib/pdfGolden');
const { matchQuestions, scoreExtraction } = require('./lib/pdfMatch');
const { resolveLegacy } = require('./lib/legacyAdapter');
const pipelineDriver = require('./lib/pipelineDriver');
const shims = require('./lib/stage2Shims');
const metrics = require('./lib/metrics');
const { isPrivatePath } = require('./lib/golden');

const EVAL_DIR = __dirname;
const DEFAULT_PDFS = path.join(EVAL_DIR, 'fixtures', 'sample_exam.pdf');

const USAGE = `用法：node eval/compare_pipeline.js --method legacy|pipeline [選項]

  --method <m>        legacy | pipeline（必填）
  --pdfs <path>       PDF 檔或目錄（預設 eval/fixtures/sample_exam.pdf）
  --golden <dir>      答案卷目錄（預設先找 eval/golden/pdf_sample/ 再找 eval/private/pdf_golden/）
  --repeat <n>        每份 PDF 跑 n 次取中位數（預設 1）
  --out <path>        CSV 輸出路徑（預設 <reports-dir>/compare-<method>-<日期>-<sha>.csv）
  --reports-dir <dir> 報表目錄（私有輸入時強制 eval/private/reports/）
  --dry-run           只做載入與配對檢查，不呼叫任何模型
`;

function parseArgs(argv) {
    const args = { method: null, pdfs: null, golden: null, repeat: 1, out: null, reportsDir: null, dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--method': args.method = argv[++i]; break;
            case '--pdfs': args.pdfs = argv[++i]; break;
            case '--golden': args.golden = argv[++i]; break;
            case '--repeat': args.repeat = Number(argv[++i]); break;
            case '--out': args.out = argv[++i]; break;
            case '--reports-dir': args.reportsDir = argv[++i]; break;
            case '--dry-run': args.dryRun = true; break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${argv[i]}」\n\n${USAGE}`);
        }
    }
    return args;
}

/** @param {number|null} v @param {number} [digits] @returns {string} */
function num(v, digits = 4) {
    if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
    return typeof v === 'number' ? v.toFixed(digits) : String(v);
}

/** 中位數（偶數筆取中間兩筆平均）；全 null 時回 null */
function median(values) {
    const list = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v));
    if (list.length === 0) return null;
    return metrics.percentile(list, 0.5);
}

// ───────────────────── legacy 一輪 ─────────────────────

/**
 * @returns {Promise<{extracted:Array<object>, tokenIn:number|null, tokenOut:number|null, latencyMs:number}>}
 */
async function runLegacyOnce({ legacy, pdfPath }) {
    // 路徑含中文時 readFileSync 也要吃絕對路徑（硬規則 6）
    const base64 = fs.readFileSync(path.resolve(pdfPath)).toString('base64');
    const started = Date.now();
    const result = await legacy.analyzePdfContent(base64);
    const latencyMs = Date.now() - started;
    if (!Array.isArray(result)) {
        throw new Error(`legacy analyzePdfContent 回的不是陣列（收到 ${typeof result}）`);
    }
    return {
        extracted: result,
        // 舊流程**完全沒有記帳**：analyzePdfContent 只回 JSON.parse 的結果，
        // usageMetadata 在函式裡就被丟掉了。這個 n/a 不是缺陷，正是 E-X12a 要呈現的差異之一
        // （規劃 §3.5「費用可控且可解釋」對照的就是這一格）。
        tokenIn: null,
        tokenOut: null,
        latencyMs
    };
}

// ───────────────────── pipeline 一輪 ─────────────────────

async function runPipelineOnce({ pdfPath, sheet }) {
    const res = await pipelineDriver.runPipeline({ pdfPath, sheet });
    if (!res.ok) throw new Error(res.reason);
    const summary = pipelineDriver.summarizePipeline(res);
    const caveats = pipelineDriver.stubCaveats(res);

    const extracted = res.jq.map(r => ({
        question_text: (r.payload.lint && r.payload.lint.question_text) || r.payload.extract.question_text,
        answer_text: (r.payload.lint && r.payload.lint.answer_text) || r.payload.extract.answer_text,
        subject: r.payload.extract.subject,
        chapter: (r.payload.classify && r.payload.classify.chapter) || r.payload.extract.chapter,
        question_type: r.payload.extract.question_type,
        _state: r.state,
        _review_reason: r.review_reason,
        _verify: r.payload.verify || null,
        _dedup0: r.payload.dedup0 || null,
        _dedup1: r.payload.dedup1 || null
    }));

    // answer_agree_rate：只算「verify 真的跑過而且有 compare 欄」的題。
    // verify 被 skipped（證明題，或 agents/verify.js 未合入）不算進分母——
    // 把 skipped 當成 agree 會讓這個比率在 agent 還沒寫好時就是 100%。
    const compares = res.jq
        .map(r => r.payload.verify && r.payload.verify.compare)
        .filter(c => c === 'agree' || c === 'disagree' || c === 'uncertain');
    const answerAgreeRate = compares.length === 0 ? null : compares.filter(c => c === 'agree').length / compares.length;

    const dedupHits = res.jq.filter(r =>
        (r.payload.dedup0 && r.payload.dedup0.hit) ||
        (r.payload.dedup1 && ['duplicate', 'variant'].includes(r.payload.dedup1.verdict))
    ).length;

    return {
        extracted,
        tokenIn: res.totals.tokenIn,
        tokenOut: res.totals.tokenOut + res.totals.tokenThinking,   // 第 0.4 條：計費用 out + thinking
        costUsd: res.totals.costUsd,
        latencyMs: res.totals.latencyMs,
        answerAgreeRate,
        dedupHits,
        saved: summary.saved,
        needsReview: summary.needsReview,
        reviewReasons: summary.reviewReasons,
        nodePass: summary.nodePass,
        agentSources: res.agentSources,
        stateMachine: res.stateMachine,
        caveats,
        driverWarnings: res.warnings
    };
}

// ───────────────────── 主流程 ─────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.method) { console.log(USAGE); return; }
    if (!['legacy', 'pipeline'].includes(args.method)) throw new Error('--method 只能是 legacy 或 pipeline');
    if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat 必須是 ≥ 1 的整數');

    const warnings = [];
    const pdfTarget = path.resolve(args.pdfs || DEFAULT_PDFS);
    const pdfs = listPdfs(pdfTarget);
    if (pdfs.length === 0) throw new Error(`${pdfTarget} 底下找不到任何 PDF`);

    // 私有判定：輸入 PDF 或答案卷任一落在 eval/private/ 就整輪視為私有。
    const isPrivate = isPrivatePath(pdfTarget) ||
        (args.golden ? isPrivatePath(path.resolve(args.golden)) : false) ||
        pdfs.some(p => isPrivatePath(p));

    let reportsDir = args.reportsDir ? path.resolve(args.reportsDir) : path.join(EVAL_DIR, 'reports');
    if (isPrivate) {
        reportsDir = args.reportsDir ? path.resolve(args.reportsDir) : path.join(EVAL_DIR, 'private', 'reports');
        process.env.EVAL_CASSETTE_DIR = path.join(EVAL_DIR, 'private', 'cassettes');
        if (!isPrivatePath(reportsDir)) {
            throw new Error(`私有輸入的報表目錄必須落在 eval/private/ 底下（收到 ${reportsDir}）`);
        }
        console.log('偵測到私有輸入：報表與 cassette 目錄已強制切到 eval/private/（不進版控），逐題明細不寫進報表。');
    }

    let legacy = null;
    if (args.method === 'legacy') {
        legacy = resolveLegacy();
        warnings.push(...legacy.warnings);
        console.log(`legacy 進入點：${legacy.rel}（模型 ${legacy.model || '未知'}，prompt_hash ${legacy.promptHash.slice(0, 12)}…／${legacy.promptBasis}）`);
    }
    warnings.push(...shims.warnings());

    const rows = [];
    for (const pdfPath of pdfs) {
        const sheet = loadSheet({ pdfPath, dir: args.golden });
        const expected = sheet.doc.questions;
        if (sheet.pendingConfirm) {
            warnings.push(`${path.basename(sheet.file)} 的答案卷仍標 needs_human_confirm：數字只能當骨架驗證用。`);
        }

        const label = isPrivate ? `<私有 PDF ${sheet.sha256.slice(0, 8)}>` : path.basename(pdfPath);

        if (args.dryRun) {
            rows.push({
                pdf: label, q_expected: expected.length, q_extracted: null,
                extract_recall: null, chapter_acc: null, formula_strict_rate: null,
                token_in: null, token_out: null, cost_usd: null, latency_ms: null,
                model: args.method === 'legacy' ? (legacy && legacy.model) : (process.env.MODEL_EXTRACT || null),
                prompt_hash: args.method === 'legacy' ? legacy.promptHash : null,
                answer_agree_rate: null, dedup_hits: null, saved: null, needs_review: null,
                note: '--dry-run：只做載入與配對檢查'
            });
            continue;
        }

        const runs = [];
        for (let i = 0; i < args.repeat; i++) {
            const once = args.method === 'legacy'
                ? await runLegacyOnce({ legacy, pdfPath })
                : await runPipelineOnce({ pdfPath, sheet });

            const match = matchQuestions(expected, once.extracted);
            const score = scoreExtraction(expected, once.extracted, match);
            const strict = shims.formulaStrictRate(once.extracted.map(q => q.question_text));

            runs.push({ once, score, strict, extractedCount: once.extracted.length });
        }

        const last = runs[runs.length - 1];
        const caveats = args.method === 'pipeline' ? last.once.caveats : { fakeExtract: false, notes: [] };
        if (caveats.notes && caveats.notes.length) warnings.push(...caveats.notes);
        if (args.method === 'pipeline') {
            warnings.push(...(last.once.driverWarnings || []));
        }

        rows.push({
            pdf: label,
            q_expected: expected.length,
            q_extracted: median(runs.map(r => r.extractedCount)),
            // oracle stub 那一輪的 recall／chapter_acc 在定義上必為 1.0，一律印 n/a（見 pipelineDriver 檔頭紅線）
            extract_recall: caveats.fakeExtract ? null : median(runs.map(r => r.score.extract_recall)),
            chapter_acc: caveats.fakeExtract ? null : median(runs.map(r => r.score.chapter_acc)),
            formula_strict_rate: median(runs.map(r => r.strict.rate)),
            token_in: median(runs.map(r => r.once.tokenIn)),
            token_out: median(runs.map(r => r.once.tokenOut)),
            cost_usd: median(runs.map(r => r.once.costUsd ?? null)),
            latency_ms: median(runs.map(r => r.once.latencyMs)),
            model: args.method === 'legacy' ? (legacy.model || null) : (process.env.MODEL_EXTRACT || 'gemini:gemini-3.5-flash'),
            prompt_hash: args.method === 'legacy' ? legacy.promptHash : null,
            answer_agree_rate: args.method === 'pipeline' ? median(runs.map(r => r.once.answerAgreeRate)) : null,
            dedup_hits: args.method === 'pipeline' ? median(runs.map(r => r.once.dedupHits)) : null,
            // legacy 的 saved 恆為 0：舊流程只把陣列回給前端，一題都沒有入庫，
            // 要老師按下「批量入庫」才會寫。這個不對稱正是規劃 §5.3.5 要呈現的結果。
            saved: args.method === 'pipeline' ? median(runs.map(r => r.once.saved)) : 0,
            needs_review: args.method === 'pipeline' ? median(runs.map(r => r.once.needsReview)) : null,
            note: args.method === 'legacy' ? 'legacy 整批回前端，saved 恆為 0' : null,
            _detail: isPrivate ? null : {
                unmatched_expected: last.score.matched === expected.length ? [] : matchQuestions(expected, last.once.extracted).unmatchedExpected,
                chapter_wrong: last.score.chapter_wrong,
                strict_events: last.strict.events,
                review_reasons: args.method === 'pipeline' ? last.once.reviewReasons : null,
                node_pass: args.method === 'pipeline' ? last.once.nodePass : null
            }
        });
    }

    emit({ args, rows, warnings, reportsDir, isPrivate, legacy });
}

const COLUMNS = [
    'pdf', 'q_expected', 'q_extracted', 'extract_recall', 'chapter_acc', 'formula_strict_rate',
    'token_in', 'token_out', 'cost_usd', 'latency_ms', 'model', 'prompt_hash'
];
const PIPELINE_COLUMNS = ['answer_agree_rate', 'dedup_hits', 'saved', 'needs_review'];

function emit({ args, rows, warnings, reportsDir, isPrivate, legacy }) {
    const cols = args.method === 'pipeline' ? [...COLUMNS, ...PIPELINE_COLUMNS] : COLUMNS;

    const header = `| ${cols.join(' | ')} |`;
    const sep = `|${cols.map(() => '---').join('|')}|`;
    const body = rows.map(r => `| ${cols.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return 'n/a';
        if (c === 'prompt_hash') return String(v).slice(0, 12);
        if (typeof v === 'number' && !Number.isInteger(v)) return num(v);
        return String(v);
    }).join(' | ')} |`).join('\n');

    const md = ['', `## 新舊對照 — --method ${args.method}`, '', header, sep, body, ''];
    for (const w of [...new Set(warnings)]) md.push(`- ⚠️ ${w}`);
    if (args.method === 'legacy' && legacy) {
        md.push(`- legacy 進入點：\`${legacy.rel}\`；prompt_hash 的計算基準：${legacy.promptBasis}（${legacy.promptChars} 字元）`);
    }
    md.push(`- 量測環境：normalizeStem \`${shims.normalizeStemSource()}\` · answerCompare \`${shims.answerCompareSource()}\` · parseLatexStrict \`${shims.parseLatexStrictSource()}\` · pricing \`${shims.pricingSource()}\``);
    console.log(md.join('\n'));

    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const csvPath = args.out ? path.resolve(args.out) : path.join(reportsDir, `compare-${args.method}-${stamp}.csv`);
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))].join('\n') + '\n';
    fs.writeFileSync(csvPath, csv, 'utf8');
    console.log(`CSV 已寫入 ${csvPath}`);

    const jsonPath = csvPath.replace(/\.csv$/, '.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
        generated_at: new Date().toISOString(),
        method: args.method,
        repeat: args.repeat,
        is_private: isPrivate,
        legacy: legacy ? { rel: legacy.rel, kind: legacy.kind, model: legacy.model, prompt_hash: legacy.promptHash, prompt_basis: legacy.promptBasis } : null,
        sources: shims.sources(),
        warnings: [...new Set(warnings)],
        rows: rows.map(r => (isPrivate ? { ...r, _detail: null } : r))
    }, null, 2) + '\n', 'utf8');
    console.log(`JSON 已寫入 ${jsonPath}`);
}

if (require.main === module) {
    main().catch(err => { console.error(`\n❌ ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, runLegacyOnce, runPipelineOnce, median, COLUMNS, PIPELINE_COLUMNS };
