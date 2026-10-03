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
// 〔Owner 2026-10-02 A 案，docs/local-mode.md 10.25 第 6 點〕拆題改成「題目頁沒答案就不編」之後，樣卷 10 題都是 no_claim、
//   answer_agree_rate 沒有分母。新指標 **verify_agree_rate**＝拆題沒寫答案（verify 記 no_claim）的題：驗算模型的答案對答案卷
//   answer_text 的一致率，進 measured、比門檻（thresholds.json 0.87＝首次實測 0.9000 − 0.03）。answer_agree_rate 定義不變，
//   只在「全部題目都是 no_claim」時 n/a、不比門檻；verify_agree_rate 在「沒有任何一題是 no_claim」時 n/a、不比門檻
//   （兩個條件互斥：有題時至少一個照舊比，不會兩個都略過）。都經 thresholds.js 的白名單 NOT_APPLICABLE_ALLOWED。
//
// 〔Owner 2026-10-03 第 r14 輪 C-1，docs/local-mode.md 10.27〕章節的把關從「閘門通過率」改成「章節對不對」：
//   - **gate_pass_rate** 在 OCR 模式（與 saved_rate 的 D-2 同一個條件 isOcrOnlyRun）**只報告、不比門檻**：門檻 0.97 是照 Gemini
//     定的（閘門通過＝省一次付費呼叫），本機 classify 走 LLM 不花錢，而拆題模型自己猜的章節不可靠（樣卷 8 題過閘門、其中 2 題章節錯），
//     硬把閘門通過率推高只會讓章節更不準。Gemini（非 OCR）模式照舊比 0.97。
//   - 新指標 **chapter_acc_rate**（章節正確率）＝有 classify 結果的題：最後的章節（payload.classify.chapter）等於答案卷 chapter 的比例。
//     兩種模式都比門檻（thresholds.json 初值 0.77＝首次實測 0.8000 − 0.03；〔r15〕實測 1.0000 之後升到 0.97，docs/local-mode.md 10.28）。題目對答案卷用 eval/lib/pdfMatch.js 的配對規則；
//     配不上答案卷的題算錯（不讓配對失敗變成好分數）。
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

/** 〔Owner 2026-10-02 A 案〕全部題目都是 no_claim 時 answer_agree_rate 不比門檻的原因 */
const ALL_NO_CLAIM_NOTE = '全部題目拆題都沒寫答案（verify 記 no_claim），拆題答案對驗算答案沒有可比的題，改由 verify_agree_rate 把關（Owner 2026-10-02 A 案）';

/** 〔Owner 2026-10-02 A 案〕沒有任何一題是 no_claim 時 verify_agree_rate 不比門檻的原因 */
const NO_NO_CLAIM_NOTE = '沒有任何一題是 no_claim（拆題都寫了答案），答案由 answer_agree_rate 把關（Owner 2026-10-02 A 案）';

/** 〔Owner 2026-10-03 第 r14 輪 C-1〕OCR 模式下 gate_pass_rate 不比門檻的原因 */
const OCR_GATE_PASS_NOTE = 'OCR 模式（本機）classify 走 LLM 不花錢、拆題模型猜的章節不可靠，閘門通過率只報告、不比門檻；' +
    '章節對不對改由 chapter_acc_rate 把關（Owner 2026-10-03 第 r14 輪 C-1）';

/**
 * 〔Owner 2026-10-02 A 案〕pipeline 這一輪「設計上不比」的指標（給 thresholds.compareSuite 的 notApplicable；只會用到白名單內的四個）。
 *   saved_rate        ：OCR 模式（D-2）。
 *   gate_pass_rate    ：OCR 模式（〔Owner 2026-10-03 第 r14 輪 C-1〕；Gemini 模式照舊比 0.97）。
 *   answer_agree_rate ：有題、而且**每一題**的 verify.compare 都是 no_claim（有一題不是就照舊比 0.87）。
 *   verify_agree_rate ：沒有任何一題的 verify.compare 是 no_claim（有一題是就照比 0.87）。
 * 沒有題（total 0）時兩個答案指標都照比——量不到＝失敗，不讓「什麼都沒跑」變成綠燈。
 * @param {{ocrOnly:boolean, jq:Array<object>}} p
 * @returns {{pipeline:Record<string,string>}|undefined}
 */
function pipelineNotApplicable({ ocrOnly, jq }) {
    const rows = Array.isArray(jq) ? jq : [];
    const noClaim = rows.filter(r => r && r.payload && r.payload.verify && r.payload.verify.compare === 'no_claim').length;
    const na = {};
    if (ocrOnly) na.saved_rate = OCR_SAVED_RATE_NOTE;
    if (ocrOnly) na.gate_pass_rate = OCR_GATE_PASS_NOTE;   // 〔Owner 2026-10-03 第 r14 輪 C-1〕
    if (rows.length > 0 && noClaim === rows.length) na.answer_agree_rate = ALL_NO_CLAIM_NOTE;
    if (rows.length > 0 && noClaim === 0) na.verify_agree_rate = NO_NO_CLAIM_NOTE;
    return Object.keys(na).length ? { pipeline: na } : undefined;
}

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
 * 〔dec/r13-extract-fixes〕verify 記 compare='no_claim'（拆題沒有答案）的題：用 eval/lib/pdfMatch.js 的配對規則對上答案卷，
 * 拿答案卷的 answer_text（標準答案的完整寫法；沒有才用 final_answer）當 claimed、驗算模型的 final_answer 當 model，
 * 照 utils/answerCompare.js 比——等於「拆題照抄到正確答案時」原本會比出的結果。
 * 配不到答案卷、或答案卷那一題沒有答案 → 'uncertain'（不回 agree，不讓配對失敗變成好分數）。
 * 〔Owner 2026-10-02 A 案〕這個比法**不算進 answer_agree_rate**，另成指標 verify_agree_rate（verifyAgreeReport），
 * 門檻比的是 field='answer_text' 那一個（答案卷 eval/lib/pdfGolden.js 規定 answer_text 不可為空，所以實際上不會退回 final_answer）。
 * opts.field：'answer_text'（預設；沒有才退回 final_answer）或 'final_answer'（只用 final_answer）。兩種都報，
 * 因為選 answer_text 是看過模擬數字（0.90 對 0.50）之後才定的，Owner 要看得到兩個數字；final_answer 那一個只報告。
 * @param {Array<object>} jq
 * @param {{doc:{questions:Array<object>}}} sheet
 * @param {{field?:'answer_text'|'final_answer'}} [opts]
 * @returns {Map<object,'agree'|'disagree'|'uncertain'>} jq 列 → 比對結果（只有 no_claim 的列）
 */
function noClaimCompares(jq, sheet, { field = 'answer_text' } = {}) {
    const out = new Map();
    const rows = (jq || []).filter(r => r && r.payload && r.payload.verify && r.payload.verify.compare === 'no_claim');
    if (!rows.length) return out;
    const { matchQuestions } = require('./pdfMatch');
    const { answerCompare } = require('../../utils/answerCompare');
    const expected = (sheet && sheet.doc && Array.isArray(sheet.doc.questions)) ? sheet.doc.questions : [];
    const extracted = rows.map(r => ({ question_text: (r.payload.lint && r.payload.lint.question_text) || r.payload.extract.question_text }));
    const match = matchQuestions(expected, extracted);
    const byExtracted = new Map(match.pairs.map(p => [p.extractedIdx, p.expectedIdx]));
    rows.forEach((r, j) => {
        const e = byExtracted.has(j) ? expected[byExtracted.get(j)] : null;
        const v = r.payload.verify;
        // 答案卷的 answer_text 是「拆題照抄到正確答案」時的樣子（含 $…$ 與等號，比對器抽得到最終答案）；沒有才退回 final_answer
        const claimed = (field === 'final_answer' ? [e && e.final_answer] : [e && e.answer_text, e && e.final_answer])
            .find(x => typeof x === 'string' && x.trim());
        if (!e || !claimed) { out.set(r, 'uncertain'); return; }
        out.set(r, answerCompare({
            question_type: e.question_type || r.payload.extract.question_type,
            claimed,
            model: { final_answer: v.final_answer, answer_form: v.answer_form },
            question_text: extracted[j].question_text
        }));
    });
    return out;
}

/**
 * no_claim 題的「驗算答案對標準答案」一致率。〔Owner 2026-10-02 A 案〕by_answer_text.rate 進 measured.pipeline.verify_agree_rate、
 * 比門檻；by_final_answer 只報告。沒有 no_claim 的題回 null。
 * @param {Array<object>} jq
 * @param {{doc:{questions:Array<object>}}} sheet
 * @returns {{n:number, by_answer_text:{agree:number, rate:number|null}, by_final_answer:{agree:number, rate:number|null}, note:string}|null}
 */
function verifyAgreeReport(jq, sheet) {
    const a = noClaimCompares(jq, sheet, { field: 'answer_text' });
    if (!a.size) return null;
    const f = noClaimCompares(jq, sheet, { field: 'final_answer' });
    const tally = (m) => {
        const agree = [...m.values()].filter(c => c === 'agree').length;
        return { agree, rate: metrics.round4(agree / m.size) };
    };
    return {
        n: a.size,
        by_answer_text: tally(a),
        by_final_answer: tally(f),
        note: VERIFY_AGREE_NOTE
    };
}

/** 報表上 verify_agree_rate 那一行的說明 */
const VERIFY_AGREE_NOTE = '拆題沒寫答案（verify 記 no_claim）的題：驗算模型算的答案對答案卷的標準答案。' +
    '門檻比的是對 answer_text 那一個（Owner 2026-10-02 A 案，docs/local-mode.md 10.25 第 6 點）；對 final_answer 只報告；' +
    '不算進 answer_agree_rate。';

/**
 * 〔Owner 2026-10-03 第 r14 輪 C-1〕章節正確率：有 classify 結果（payload.classify.chapter 有值）的題，
 * 最後的章節等於答案卷 chapter 的比例。題目對答案卷用 eval/lib/pdfMatch.js 的配對規則（與 noClaimCompares 同一套：
 * 題幹取 lint 之後的、沒有才用 extract 的；全部題目一起配，一對一）；**配不上答案卷的題算錯**（不讓配對失敗變成好分數）。
 * 沒有任何一題有 classify 結果時 rate 是 null（門檻有數字＝失敗）。
 * @param {Array<object>} jq
 * @param {{doc:{questions:Array<object>}}} sheet
 * @returns {{n:number, correct:number, rate:number|null,
 *            wrong:Array<{idx:number, no:number|null, expect:string|null, got:string, source:string|null}>}}
 *          wrong[].no：答案卷上的題號（配不上答案卷＝null）；idx 是管線裡的題 idx
 */
function chapterAccReport(jq, sheet) {
    const rows = (jq || []).filter(r => r && r.payload && r.payload.extract);
    const expected = (sheet && sheet.doc && Array.isArray(sheet.doc.questions)) ? sheet.doc.questions : [];
    const extracted = rows.map(r => ({ question_text: (r.payload.lint && r.payload.lint.question_text) || r.payload.extract.question_text }));
    const { matchQuestions } = require('./pdfMatch');
    const match = matchQuestions(expected, extracted);
    const byExtracted = new Map(match.pairs.map(p => [p.extractedIdx, p.expectedIdx]));
    let n = 0;
    let correct = 0;
    const wrong = [];
    rows.forEach((r, j) => {
        const c = r.payload.classify;
        const got = c && typeof c.chapter === 'string' && c.chapter.trim() ? c.chapter : null;
        if (!got) return;   // 沒有 classify 結果的題不進分母
        n += 1;
        const k = byExtracted.has(j) ? byExtracted.get(j) : null;
        const e = k === null ? null : expected[k];
        if (e && e.chapter === got) { correct += 1; return; }
        wrong.push({ idx: r.idx, no: e ? (e.no ?? k + 1) : null, expect: e ? e.chapter : null, got, source: c.source || null });
    });
    return { n, correct, rate: n === 0 ? null : metrics.round4(correct / n), wrong };
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

    if (!res.ok) {
        const misses = res.replayMisses || [];
        return {
            suite: 'pipeline',
            measured: { pipeline: null },
            // 沒跑完：只帶 OCR 模式的 saved_rate（D-2）與 gate_pass_rate（r14 C-1）（measured.pipeline 是 null，compareSuite 本來就整欄算失敗）
            notApplicable: pipelineNotApplicable({ ocrOnly, jq: [] }),
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
    // 〔審查 dec/r13-extract-fixes〕定義照舊（拆題答案對驗算答案）：verify 記 compare='no_claim'（拆題沒寫答案）的題
    // 沒有東西可比，**不進分母**。〔Owner 2026-10-02 A 案〕no_claim 題的「驗算對答案卷 answer_text」另成指標
    // verify_agree_rate（verifyAgreeReport 的 by_answer_text），進 measured、比門檻；全部題目都是 no_claim 時
    // answer_agree_rate n/a、不比門檻（pipelineNotApplicable）。
    const compares = res.jq.map(r => r.payload.verify && r.payload.verify.compare)
        .filter(c => ['agree', 'disagree', 'uncertain'].includes(c));
    const answerAgreeRate = compares.length === 0 ? null
        : compares.filter(c => c === 'agree').length / compares.length;
    const verifyAgree = verifyAgreeReport(res.jq, sheet);
    // 〔Owner 2026-10-03 第 r14 輪 C-1〕章節正確率（兩種模式都比門檻）
    const chapterAcc = chapterAccReport(res.jq, sheet);

    // oracle stub 的那一輪，saved_rate 與 gate_pass_rate 都是「答案卷抄給自己看」的產物，
    // 一律 n/a——理由見 pipelineDriver 檔頭紅線。
    const fake = caveats.fakeExtract;

    const measured = {
        pipeline: {
            // 〔Owner 第五輪 D-2〕OCR 模式印 n/a、不比門檻（notApplicable）；交叉驗證與 Gemini 照舊
            saved_rate: fake || ocrOnly ? null : (total === 0 ? null : metrics.round4(summary.saved / total)),
            gate_pass_rate: fake ? null : metrics.round4(gatePassRate),
            answer_agree_rate: metrics.round4(answerAgreeRate),
            // 〔Owner 2026-10-02 A 案〕no_claim 題：驗算答案對答案卷 answer_text 的一致率（沒有 no_claim 的題＝null）
            verify_agree_rate: verifyAgree ? verifyAgree.by_answer_text.rate : null,
            // 〔Owner 2026-10-03 第 r14 輪 C-1〕有 classify 結果的題：最後章節對答案卷 chapter 的比例。
            // oracle stub 那一輪拆題就是答案卷，章節在定義上必對，一律 n/a（理由同下面的 fake）
            chapter_acc_rate: fake ? null : chapterAcc.rate,
            n: total
        }
    };

    if (ocrOnly && summary.saved > 0) {
        warnings.push(`OCR 模式卻有 ${summary.saved} 題自動入庫：每一題都該停在人工複核（ocr_only），請檢查 save 節點的停等。`);
    }

    // 〔Owner 第五輪 D-2〕saved_rate；〔Owner 2026-10-02 A 案〕answer_agree_rate／verify_agree_rate；
    // 〔Owner 2026-10-03 第 r14 輪 C-1〕gate_pass_rate（OCR 模式）。條件見 pipelineNotApplicable
    const notApplicable = pipelineNotApplicable({ ocrOnly, jq: res.jq });

    return {
        suite: 'pipeline',
        measured,
        notApplicable,
        // 〔Owner 第五輪 D-2〕替代指標：只報告、不設門檻（不進 measured）
        ocrOnly: ocrOnly ? { saved_rate_note: OCR_SAVED_RATE_NOTE, pre_approval: fake ? { passed: 0, total, rate: null } : preApprovalPassRate(res.jq) } : null,
        // no_claim 題的驗算對標準答案的兩種比法（answer_text 那一個同時是 measured 的 verify_agree_rate）；沒有 no_claim 的題時不帶這個鍵
        ...(verifyAgree ? { verifyAgree } : {}),
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕章節正確率的明細（答錯的題列出來；oracle stub 那一輪不帶）
        ...(fake ? {} : { chapterAcc }),
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
            retries: r.retries,
            // 〔r15 dec/r15-chapter-acc〕零成本閘門的證據否決（docs/local-mode.md 10.28）：被否決的題才多這個鍵
            ...(r.payload.classify && r.payload.classify.gate_veto ? { gate_veto: r.payload.classify.gate_veto } : {})
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

module.exports = {
    runPipelineSuite, DEFAULT_PDF, isOcrOnlyRun, preApprovalPassRate, OCR_SAVED_RATE_NOTE, noClaimCompares, verifyAgreeReport, VERIFY_AGREE_NOTE,
    pipelineNotApplicable, ALL_NO_CLAIM_NOTE, NO_NO_CLAIM_NOTE,   // 〔Owner 2026-10-02 A 案〕
    chapterAccReport, OCR_GATE_PASS_NOTE                          // 〔Owner 2026-10-03 第 r14 輪 C-1〕
};
