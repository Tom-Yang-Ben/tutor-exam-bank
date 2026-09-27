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
// 〔Owner 第五輪 D-2 核准（選 3），2026-09-27，dec/r6-gates〕OCR 為主（拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr）時
//   每一題都停在人工複核（ocr_only），saved_rate 設計上恆為 0：印成 n/a、不比門檻（run.js 經 thresholds.js 的白名單略過；
//   thresholds.json 不動）。交叉驗證與 Gemini 模式照舊比 0.87。另報替代指標「人工核准前的通過率」＝
//   走完全部閘門、只因「只用 OCR 拆題」停下的題（needs_review 且原因 ocr_only）÷ 全部題；**只報告、不設門檻**
//   （不進 measured，--write-baseline 寫不到它），累積幾次實測後再請 Owner 定門檻。
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

/** 〔Owner 第五輪 D-2〕OCR 模式下 saved_rate 不比門檻的原因（報表與 run.js 的「未設門檻」一行都印這句） */
const OCR_SAVED_RATE_NOTE = 'OCR 模式每題都停在人工複核，設計上恆為 0，不比門檻（Owner 第五輪 D-2）';

/**
 * 這一輪是不是「只用 OCR 拆題」：拆題模型是 ollama 而且 LOCAL_EXTRACT_MODE=ocr（與 workers/jobRunner.js 的判斷相同），
 * 或者任何一題的 payload.extract.extract_mode 是 'ocr'（agents/extract.js 的 runLocalOcrOnly 寫的）。
 * @param {object} [env]
 * @param {Array<object>} [jq]
 * @returns {boolean}
 */
function isOcrOnlyRun(env = process.env, jq = []) {
    if ((jq || []).some(r => r && r.payload && r.payload.extract && r.payload.extract.extract_mode === 'ocr')) return true;
    const models = require('../../config/models');
    const spec = String((env && env.MODEL_EXTRACT) || '').trim() || models.MODEL_EXTRACT;
    let vendor = null;
    try { vendor = models.parseModel(spec).vendor; } catch (_) { vendor = null; }
    return vendor === 'ollama' && require('../../config/localExtractMode').resolveLocalExtractMode(env) === 'ocr';
}

/**
 * 〔Owner 第五輪 D-2〕人工核准前的通過率：走完全部閘門、只因 ocr_only 停下的題 ÷ 全部題（沒有題＝null）。
 * 只報告、不設門檻。
 * @param {Array<{state:string, review_reason:string|null}>} jq
 * @returns {{passed:number, total:number, rate:number|null}}
 */
function preApprovalPassRate(jq) {
    const rows = Array.isArray(jq) ? jq : [];
    const passed = rows.filter(r => r.state === 'needs_review' && r.review_reason === 'ocr_only').length;
    return { passed, total: rows.length, rate: rows.length === 0 ? null : metrics.round4(passed / rows.length) };
}

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

    // 沒跑完時**不丟例外**：replay miss 要交給 run.js 依裁決 S2-14 判斷
    // （fork PR 降 warning、其餘紅燈），丟例外會讓那段邏輯完全繞過去，
    // 而且 fork 的外部貢獻者會看到一個他無法自救的堆疊。
    const ocrOnly = isOcrOnlyRun(process.env, res.jq);
    const notApplicable = ocrOnly ? { pipeline: { saved_rate: OCR_SAVED_RATE_NOTE } } : undefined;

    if (!res.ok) {
        const misses = res.replayMisses || [];
        return {
            suite: 'pipeline',
            measured: { pipeline: null },
            notApplicable,
            ocrOnly: ocrOnly ? { saved_rate_note: OCR_SAVED_RATE_NOTE, pre_approval: { passed: 0, total: 0, rate: null } } : null,
            nodes: {}, reviewReasons: [],
            counts: { total: 0, saved: 0, needs_review: 0, rejected: 0, pending: 0 },
            cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: res.totals.latencyMs },
            caveats: { fakeExtract: false, fakeVerify: false, anyStub: false, notes: [res.reason] },
            // failures 走 run.js 的 partitionFailures：是 replay miss 就照 S2-14 處理
            failures: misses.length ? misses.map(m => m.message) : [res.reason],
            warnings: [...warnings, res.reason],
            perQuestion: [],
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
            // 〔Owner 第五輪 D-2〕OCR 模式印 n/a、不比門檻（notApplicable）；交叉驗證與 Gemini 照舊
            saved_rate: fake || ocrOnly ? null : (total === 0 ? null : metrics.round4(summary.saved / total)),
            gate_pass_rate: fake ? null : metrics.round4(gatePassRate),
            answer_agree_rate: metrics.round4(answerAgreeRate),
            n: total
        }
    };

    if (ocrOnly && summary.saved > 0) {
        warnings.push(`OCR 模式卻有 ${summary.saved} 題自動入庫：每一題都該停在人工複核（ocr_only），請檢查 save 節點的停等。`);
    }

    return {
        suite: 'pipeline',
        measured,
        notApplicable,
        // 〔Owner 第五輪 D-2〕替代指標：只報告、不設門檻（不進 measured）
        ocrOnly: ocrOnly ? { saved_rate_note: OCR_SAVED_RATE_NOTE, pre_approval: fake ? { passed: 0, total, rate: null } : preApprovalPassRate(res.jq) } : null,
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

module.exports = { runPipelineSuite, DEFAULT_PDF, isOcrOnlyRun, preApprovalPassRate, OCR_SAVED_RATE_NOTE };
