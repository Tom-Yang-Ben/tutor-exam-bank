// ─────────────────────────────────────────────────────────────
// eval/lib/suiteClassify.js — `eval/run.js --suite classify`（A-T14）
//
// 量的是**第二層 LLM 分類**：cassette 回放 vs golden，輸出 accuracy／macro-F1／Top-5 混淆對。
//
// 一個關鍵決定：**輸入一律把 chapter_confidence 設成 0**。
//
//   agents/classify.js 的第一層是零成本閘門（isValidChapter && confidence ≥ CLASSIFY_MIN_CONF
//   → 直接 pass，不呼叫 LLM，第 3.3 條）。如果 eval 把 golden 的正解章節連同高信心一起餵進去，
//   閘門會 100% 命中，accuracy 恆為 1.0，而第二層 LLM 一次都不會被呼叫——
//   量到的是「我把答案抄給它然後它抄回來」。
//
//   規劃 §3.8 對這一格寫得很清楚：「classify 零成本閘門通過率」與「二層 LLM 用 fixtures
//   回放 vs golden」是**兩個不同的數字**。閘門通過率在 --suite pipeline 量（那裡的信心值
//   來自真的 extract 輸出）；本 suite 只量第二層。
//
//   同理，輸入的 chapter 給的是 golden 的 decoy_chapter（「模型最可能漂到哪」）而不是正解；
//   沒有 decoy 的就給空字串。兩者都過不了 isValidChapter，第二層必定被觸發。
//
// 尚未合入 agents/classify.js 時：**所有分數印 n/a**，不用閘門的結果冒充分類正確率。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { isValidChapter } = require('../../config/chapters');
const { loadFixture } = require('./fixtures');
const { loadClassifyGolden } = require('./golden2');
const metrics = require('./metrics');
const shims = require('./stage2Shims');
const sm = require('./stateMachineShim');
const replayMiss = require('./replayMiss');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_PATH = path.resolve(ROOT, 'agents', 'classify.js');

/**
 * @param {object} args run.js 的 args
 * @returns {Promise<object>}
 */
async function runClassifySuite(args) {
    const warnings = [];

    const fixture = loadFixture();
    const golden = loadClassifyGolden({ file: args.golden || undefined, fixtureById: fixture.byId });
    if (golden.pendingConfirm > 0) {
        warnings.push(`classify golden 有 ${golden.pendingConfirm}/${golden.entries.length} 筆仍是 needs_human_confirm 的草稿，尚未人工定案。`);
    }

    // golden 本身的健檢（規劃 §5.3.2「golden 本身也要過硬閘門」；載入時已擋，這裡只是報數字）
    const decoyInWhitelist = golden.entries.filter(e =>
        e.decoy_chapter && isValidChapter(e.subject, e.decoy_chapter)
    ).length;
    const decoyTotal = golden.entries.filter(e => e.decoy_chapter).length;

    const agentExists = fs.existsSync(AGENT_PATH);
    let rows = null;
    let sourceCounts = { gate: 0, llm: 0 };
    const failures = [];
    const misses = [];
    const missIds = [];

    if (!agentExists) {
        warnings.push(
            'agents/classify.js 尚未合入（WS-B 的 A-T9）：accuracy／macro-F1／混淆對全部印 n/a。' +
            '本 suite 這一輪只驗證 golden 過得了硬閘門、以及骨架接得起來。'
        );
    } else {
        const llm = require('../../services/llm');
        const agent = require(AGENT_PATH);
        const minConf = Number(process.env.CLASSIFY_MIN_CONF || 0.8);
        rows = [];

        for (const e of golden.entries) {
            const ctx = {
                llm,
                // 裁決 S2-8／S2-13：**錄製與 eval 一律 ctx.db = null**。
                // classify 的 few-shot 有三層取材（A 向量最近鄰 → B 各章取例 → C 自製例句），
                // 前兩層都要 ctx.db；給 null 會讓它直接降級到第三層的 config/chapterExamples.js。
                // 這不是「少了 DB 所以將就」，而是 cassette 鍵的可重現性要求：
                // cacheKeyParts 含 fewShotIds，只要 few-shot 來自資料庫，題庫多一題、
                // 近似索引微動、同分排序變動都會讓鍵變，replay 就會 miss（規劃 §5.3.3）。
                db: null,
                job: { id: 0, budget_usd: Infinity, cost_usd: 0 },
                jq: { id: 0, idx: 0, payload: {}, retries: {} },
                logger: { info() {}, warn() {}, error() {} },
                config: {
                    models: { extract: process.env.MODEL_EXTRACT || 'gemini:gemini-3.5-flash', verify: process.env.MODEL_VERIFY || 'gemini:gemini-3.7-flash' },
                    limits: sm.tables().DEFAULT_LIMITS,
                    thresholds: { classifyMinConf: minConf },
                    // 第 3.1 條（裁決 S2-8）：features 由 runner 組。similar 關掉，
                    // 與 ctx.db=null 一致——否則 agent 會先試向量最近鄰再失敗降級，白跑一次。
                    features: { similar: false, pipeline: true }
                },
                signal: undefined
            };

            let outcome;
            try {
                outcome = await agent.run(ctx, {
                    subject: e.subject,
                    // 見檔頭：刻意讓第一層閘門過不了，強迫走第二層
                    chapter: e.decoy_chapter || '',
                    chapter_confidence: 0,
                    question_text: e.question_text
                });
            } catch (err) {
                outcome = { kind: 'error', errorClass: 'provider_error', message: err.message };
            }

            // agent 依第 3.1 條「不得 throw」，replay miss 會以 {kind:'error'} 回來。
            // 這一段把它從「模型答錯了」裡分出去——不分開的話，90 筆全是 miss 會顯示成
            // 「accuracy 0.07」，看起來像模型爛掉，其實是一支 cassette 都沒錄到。
            // 訊息比對只到 `--suite ` 為止（裁決 S2-14）。
            if (outcome && outcome.kind === 'error' && replayMiss.isReplayMiss(outcome.message)) {
                // **原樣**推進 failures，不加 `${e.id}：` 前綴——run.js 的 partitionFailures
                // 是用 startsWith 比對凍結前綴的（裁決 S2-14），加了前綴就辨識不出來，
                // 82 筆 replay miss 會被當成 82 筆一般失敗，fork PR 的降級也不會發生。
                // golden 的 id 另外收在 missIds 裡給報表用。
                misses.push(outcome.message);
                missIds.push(e.id);
                continue;
            }

            const pred = outcome && outcome.kind === 'pass' && outcome.data ? outcome.data.chapter : null;
            const src = outcome && outcome.data ? outcome.data.source : null;
            if (src === 'gate') sourceCounts.gate++;
            else if (src === 'llm') sourceCounts.llm++;

            rows.push({
                id: e.id, gold: e.chapter, pred,
                subject: e.subject, source: e.source, drift_kind: e.drift_kind,
                decoy: e.decoy_chapter,
                hit_decoy: !!(e.decoy_chapter && pred === e.decoy_chapter),
                outcome_kind: outcome ? outcome.kind : 'error'
            });
        }

        if (misses.length) {
            // 有 miss 就不報分數。部分回放出來的 accuracy 只反映「哪幾題剛好錄過」，
            // 拿它跟完整的一輪比較是沒有意義的（規劃 §5.3.3「不在缺數字時假裝通過」）。
            warnings.push(
                `${misses.length}/${golden.entries.length} 筆是 replay miss（${missIds.slice(0, 5).join('、')}${missIds.length > 5 ? ' …' : ''}）：` +
                'cassette 尚未涵蓋這份 golden。accuracy／macro-F1／混淆對這一輪一律 n/a——' +
                '部分回放的分數只反映「哪幾題剛好錄過」。'
            );
            rows = null;
        }
        if (sourceCounts.gate > 0) {
            warnings.push(
                `有 ${sourceCounts.gate} 筆是 source='gate' 走的零成本閘門——本 suite 的輸入刻意把 ` +
                'chapter_confidence 設成 0，理論上閘門不該通過。請確認 agents/classify.js 的閘門條件。'
            );
        }
    }

    const acc = rows ? metrics.accuracy(rows) : { accuracy: null, n: golden.entries.length, correct: 0 };
    const mf1 = rows ? metrics.macroF1(rows) : { macroF1: null, perClass: {} };
    const confusion = rows ? metrics.confusionPairs(rows, 5) : [];

    // 分段：漂移變體是不是特別難？這一欄比整體 accuracy 更能決定 prompt 要不要補。
    const bySource = {};
    if (rows) {
        for (const key of ['fixture', 'drift']) {
            const sub = rows.filter(r => r.source === key);
            bySource[key] = sub.length === 0 ? null : metrics.round4(metrics.accuracy(sub).accuracy);
        }
        for (const key of ['stem_rewrite', 'chapter_synonym']) {
            const sub = rows.filter(r => r.drift_kind === key);
            bySource[key] = sub.length === 0 ? null : metrics.round4(metrics.accuracy(sub).accuracy);
        }
    }

    const measured = {
        classify: rows ? {
            accuracy: metrics.round4(acc.accuracy),
            macro_f1: metrics.round4(mf1.macroF1),
            n: acc.n,
            correct: acc.correct
        } : null
    };

    return {
        suite: 'classify',
        measured,
        confusion,
        bySource,
        perClass: mf1.perClass,
        decoyHits: rows ? rows.filter(r => r.hit_decoy).length : null,
        decoyInWhitelist, decoyTotal,
        sourceCounts,
        failures: [...misses, ...failures],
        warnings,
        perEntry: golden.isPrivate ? [] : (rows || []),
        meta: {
            agent: agentExists ? 'agents/classify.js' : '（未合入）',
            llmMode: process.env.LLM_MODE || 'replay',
            cassetteDir: process.env.EVAL_CASSETTE_DIR || 'eval/cassettes',
            golden: golden.isPrivate ? '（私有層，路徑不記錄）'
                : path.relative(ROOT, golden.file).replace(/\\/g, '/'),
            goldenEntries: golden.entries.length,
            goldenPending: golden.pendingConfirm,
            fixture: path.relative(ROOT, fixture.file).replace(/\\/g, '/'),
            sources: shims.sources()
        },
        isPrivate: golden.isPrivate
    };
}

module.exports = { runClassifySuite, AGENT_PATH };
