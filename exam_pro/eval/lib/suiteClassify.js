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
    let failures = [];

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
                // classify 的 few-shot 需要撈題庫；沒有 DB 時讓它明確失敗而不是回空集合
                db: {
                    pool: { query: async () => { throw new Error('--suite classify 沒有 DB：few-shot 查詢需要 TEST_DATABASE_URL'); } },
                    query: async () => { throw new Error('--suite classify 沒有 DB：few-shot 查詢需要 TEST_DATABASE_URL'); }
                },
                job: { id: 0, budget_usd: Infinity, cost_usd: 0 },
                jq: { id: 0, idx: 0, payload: {}, retries: {} },
                logger: { info() {}, warn() {}, error() {} },
                config: {
                    models: { extract: process.env.MODEL_EXTRACT || 'gemini:gemini-3.5-flash', verify: process.env.MODEL_VERIFY || 'gemini:gemini-3.7-flash' },
                    limits: sm.tables().DEFAULT_LIMITS,
                    thresholds: { classifyMinConf: minConf }
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
                // replay miss 的訊息是凍結的（第 5.2 條），原樣往上拋給使用者看
                failures.push(`${e.id}：${err.message}`);
                outcome = { kind: 'error', errorClass: 'provider_error' };
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
        failures,
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
