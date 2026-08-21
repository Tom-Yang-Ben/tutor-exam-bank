// ─────────────────────────────────────────────────────────────
// eval/lib/suitePipeline.js — `eval/run.js --suite pipeline`（A-T14）
//
// 對 eval/fixtures/sample_exam.pdf 以 LLM_MODE=replay 跑整條管線，輸出三組數字：
//   1. **各節點通過率**    每個節點 pass / fail / error / skipped 的比例與 p50／p95 延遲。
//   2. **needs_review 原因分佈**  哪一種原因把題目擋在複核佇列裡（第 2 條的八個值）。
//   3. **每份 cost**       token_in / token_out（含 thinking）/ cost_usd。
//
// 還有兩個順帶量到、但其實最有用的數字：
//   - classify 的**零成本閘門通過率**（source='gate' 的比例）。規劃 §1.6 的決策條件寫著
//     「閘門通過率 > 95% → 二層可降為抽樣」，這一格就是那個決策的依據。
//   - **saved_rate**：跑完之後真的入庫的比例。這是整條管線對使用者唯一有意義的產出，
//     也是唯一適合放進 ratchet 的指標（越高越好）。
//
// stub 狀態的處理與 compare_pipeline.js 相同：
//   agents/extract.js 未合入時走 oracle stub，**所有與拆題品質有關的欄位一律 n/a**，
//   且拒絕寫 thresholds 初值（見 run.js 的 guard）。細節見 eval/lib/pipelineDriver.js 檔頭紅線。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { loadSheet } = require('./pdfGolden');
const driver = require('./pipelineDriver');
const metrics = require('./metrics');
const shims = require('./stage2Shims');
const { isPrivatePath } = require('./golden');

const EVAL_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(EVAL_DIR, '..');
const DEFAULT_PDF = path.join(EVAL_DIR, 'fixtures', 'sample_exam.pdf');

/**
 * @param {object} args run.js 的 args（用到 --pdfs、--golden）
 * @returns {Promise<object>}
 */
async function runPipelineSuite(args) {
    const warnings = [];
    const pdfPath = path.resolve(args.pdfs || DEFAULT_PDF);
    if (!fs.existsSync(pdfPath)) {
        throw new Error(
            `找不到 ${pdfPath}。\n` +
            '  自製樣卷由 eval/fixtures/make_sample_pdf.js 產生（只在本機跑）：\n' +
            '    node eval/fixtures/make_sample_pdf.js'
        );
    }
    const isPrivate = isPrivatePath(pdfPath) || (args.golden ? isPrivatePath(path.resolve(args.golden)) : false);
    if (isPrivate) {
        process.env.EVAL_CASSETTE_DIR = path.join(EVAL_DIR, 'private', 'cassettes');
    }

    const sheet = loadSheet({ pdfPath, dir: args.golden });
    if (sheet.pendingConfirm) {
        warnings.push('答案卷仍標 needs_human_confirm：本 suite 的數字只能當骨架驗證用。');
    }

    const res = await driver.runPipeline({ pdfPath, sheet });
    warnings.push(...(res.warnings || []));
    if (!res.ok) {
        throw new Error(`pipeline 沒跑完：${res.reason}`);
    }

    const caveats = driver.stubCaveats(res);
    warnings.push(...caveats.notes);

    const summary = driver.summarizePipeline(res);
    const total = res.jq.length;

    // 各節點通過率。分母用該節點實際被呼叫的次數，不是題數——
    // 節點會因為重試被呼叫多次，用題數當分母會算出 > 1 的「通過率」。
    const nodes = {};
    for (const [node, s] of Object.entries(summary.nodePass)) {
        nodes[node] = {
            calls: s.total,
            pass: s.pass, fail: s.fail, error: s.error, skipped: s.skipped,
            // skipped 不算「沒通過」：證明題的 verify、未就緒的 dedup1 本來就該跳過。
            // 因此通過率的分母是 pass + fail + error。
            pass_rate: (s.pass + s.fail + s.error) === 0 ? null : metrics.round4(s.pass / (s.pass + s.fail + s.error)),
            p50_ms: Math.round(metrics.percentile(s.latencies, 0.5)),
            p95_ms: Math.round(metrics.percentile(s.latencies, 0.95))
        };
    }

    const reviewReasons = metrics.distribution(summary.reviewReasons);

    // classify 零成本閘門通過率：payload.classify.source === 'gate' 的比例。
    const classifySources = res.jq
        .map(r => r.payload.classify && r.payload.classify.source)
        .filter(Boolean);
    const gatePassRate = classifySources.length === 0
        ? null
        : classifySources.filter(s => s === 'gate').length / classifySources.length;

    // answer_agree_rate：只算 verify 真的跑過而且有 compare 的題（skipped 不進分母）
    const compares = res.jq.map(r => r.payload.verify && r.payload.verify.compare)
        .filter(c => ['agree', 'disagree', 'uncertain'].includes(c));
    const answerAgreeRate = compares.length === 0 ? null
        : compares.filter(c => c === 'agree').length / compares.length;

    // oracle stub 的那一輪，saved_rate 與 gate_pass_rate 都是「答案卷抄給自己看」的產物，
    // 一律 n/a——理由見 pipelineDriver 檔頭紅線。
    const fake = caveats.fakeExtract;

    const measured = {
        pipeline: {
            saved_rate: fake ? null : (total === 0 ? null : metrics.round4(summary.saved / total)),
            gate_pass_rate: fake ? null : metrics.round4(gatePassRate),
            answer_agree_rate: metrics.round4(answerAgreeRate),
            n: total
        }
    };

    return {
        suite: 'pipeline',
        measured,
        nodes,
        reviewReasons,
        counts: {
            total,
            saved: summary.saved,
            needs_review: summary.needsReview,
            rejected: summary.rejected,
            pending: summary.pending
        },
        cost: {
            token_in: res.totals.tokenIn,
            token_out: res.totals.tokenOut,
            token_thinking: res.totals.tokenThinking,
            // 第 0.4 條：計費的 out 一定是 candidates + thinking
            token_out_billed: res.totals.tokenOut + res.totals.tokenThinking,
            cost_usd: res.totals.costUsd,
            latency_ms: res.totals.latencyMs
        },
        caveats,
        warnings,
        perQuestion: isPrivate ? [] : res.jq.map(r => ({
            idx: r.idx, state: r.state, review_reason: r.review_reason,
            chapter: (r.payload.classify && r.payload.classify.chapter) || r.payload.extract.chapter,
            classify_source: r.payload.classify && r.payload.classify.source,
            retries: r.retries
        })),
        meta: {
            pdf: isPrivate ? '（私有 PDF，路徑不記錄）' : path.relative(ROOT, pdfPath).replace(/\\/g, '/'),
            pdfSha256: sheet.sha256,
            questionsExpected: sheet.doc.questions.length,
            agentSources: res.agentSources,
            stateMachine: res.stateMachine,
            db: res.db,
            llmMode: process.env.LLM_MODE || 'replay',
            cassetteDir: process.env.EVAL_CASSETTE_DIR || 'eval/cassettes',
            thresholds: res.thresholds,
            sources: shims.sources()
        },
        isPrivate
    };
}

module.exports = { runPipelineSuite, DEFAULT_PDF };
