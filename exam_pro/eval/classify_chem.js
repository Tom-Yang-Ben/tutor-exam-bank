// ─────────────────────────────────────────────────────────────
// eval/classify_chem.js — `npm run eval:classify-chem`（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 6 點）
//
// 量化學題的**第二層 LLM 分類**（agents/classify.js 的化學路徑，agent 名 classify_chem）：
// cassette 回放 vs eval/golden/classify_chem.json，輸出 accuracy、macro-F1、各冊正確率與最常見的混淆對。
//
// 三個與 `--suite classify` 相同的取捨（理由見 eval/lib/suiteClassify.js 檔頭）：
//   1. 輸入的 chapter_confidence 一律 0、chapter 給 decoy——強迫走第二層，不量零成本閘門；
//   2. ctx.db = null、features.similar = false——few-shot 只用 config/chapterExamples.js，
//      cassette 鍵（含 fewShotIds）才可重現；
//   3. 有任何一筆 replay miss 就不報分數（部分回放的分數只反映「哪幾題剛好錄過」）。
//
// 與 CI 的關係（第 4.2 條第 6 點、第 1.2 條）：**不在 CI 清單內**。CI 沒有化學 cassette，
// 所以 replay 模式下 eval/cassettes/classify_chem/ 不存在（或是空的）時印出「尚未錄製，略過」並 exit 0。
// 錄製（要真的 Gemini 金鑰、會花錢）：
//   LLM_MODE=record node --env-file=.env eval/classify_chem.js
// 之後 `npm run eval:classify-chem` 就是純回放。詳見 docs/chemistry.md 第 6 節。
//
// 選項：
//   --golden <path>        預設 eval/golden/classify_chem.json
//   --min-accuracy <0~1>   有給才當門檻：分數低於它 exit 1（預設只報數字，不擋）
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_GOLDEN = path.join(__dirname, 'golden', 'classify_chem.json');
const AGENT = 'classify_chem';

const { CHAPTERS, VOLUMES, isValidChapter, volumeOf } = require('../config/chapters');
const metrics = require('./lib/metrics');
const replayMiss = require('./lib/replayMiss');

function parseArgs(argv) {
    const args = { golden: DEFAULT_GOLDEN, minAccuracy: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--golden') args.golden = path.resolve(argv[++i]);
        else if (argv[i] === '--min-accuracy') args.minAccuracy = Number(argv[++i]);
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
        else throw new Error(`不認得的參數：${argv[i]}`);
    }
    return args;
}

/**
 * golden 的硬閘門：標的答案不在白名單內，classify 就永遠不可能答對（規劃 §5.3.2）。
 * 另外要求化學六冊每冊至少 3 題（第 4.2 條第 6 點）。
 * @returns {string[]} 問題清單；空陣列＝通過
 */
function validateGolden(entries) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['classify_chem golden 的 entries 必須是非空陣列'];
    const seen = new Set();
    const perVolume = Object.fromEntries(VOLUMES['化學'].map(v => [v.name, 0]));
    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (typeof e.id !== 'string' || !e.id) { problems.push('id 必須是非空字串'); continue; }
        if (seen.has(e.id)) problems.push(`id「${e.id}」重複`);
        seen.add(e.id);
        if (e.subject !== '化學') problems.push(`${at}：subject 必須是「化學」`);
        if (typeof e.question_text !== 'string' || !e.question_text.trim()) problems.push(`${at}：question_text 不可為空`);
        if (!isValidChapter('化學', e.chapter)) problems.push(`${at}：chapter「${e.chapter}」不在化學白名單`);
        else perVolume[volumeOf('化學', e.chapter)] += 1;
        if (e.decoy_chapter !== null && typeof e.decoy_chapter !== 'string') problems.push(`${at}：decoy_chapter 必須是字串或 null`);
        if (e.decoy_chapter === e.chapter) problems.push(`${at}：decoy_chapter 不得等於正解 chapter`);
        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林`);
    }
    for (const [vol, n] of Object.entries(perVolume)) {
        if (n < 3) problems.push(`${vol} 只有 ${n} 題，每冊至少 3 題`);
    }
    return problems;
}

function loadGolden(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = validateGolden(raw.entries);
    if (problems.length) throw new Error(`classify_chem golden 未通過硬閘門（${file}）：\n  - ${problems.join('\n  - ')}`);
    return raw;
}

/** replay 模式下有沒有任何一支化學 cassette */
function hasCassettes() {
    const { cassetteDir } = require('../services/llm/cassette');
    const dir = path.join(cassetteDir(), AGENT);
    return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'));
}

function gitSha() {
    try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'nogit'; }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('用法：node eval/classify_chem.js [--golden <path>] [--min-accuracy 0.8]');
        return 0;
    }
    const golden = loadGolden(args.golden);
    const mode = String(process.env.LLM_MODE || 'replay').trim();

    if (mode === 'replay' && !hasCassettes()) {
        console.log(`⏭️  化學 classify eval：eval/cassettes/${AGENT}/ 尚未錄製，略過（golden ${golden.entries.length} 筆已通過硬閘門）。`);
        console.log('   錄製方式見 docs/chemistry.md 第 6 節：LLM_MODE=record node --env-file=.env eval/classify_chem.js');
        return 0;
    }

    const llm = require('../services/llm');
    const agent = require('../agents/classify');
    const models = require('../config/models');
    const rows = [];
    const misses = [];
    const failures = [];

    for (const e of golden.entries) {
        const ctx = {
            llm,
            db: null,                                   // 見檔頭第 2 點
            job: { id: 0, budget_usd: Infinity, cost_usd: 0, subject_group: 'chemistry' },
            jq: { id: 0, idx: 0, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: {
                models: { extract: models.MODEL_EXTRACT, verify: models.MODEL_VERIFY, text: models.MODEL_TEXT },   // 〔LM-15〕
                thresholds: { classifyMinConf: Number(process.env.CLASSIFY_MIN_CONF || 0.8) },
                features: { similar: false, pipeline: true }
            },
            signal: undefined
        };
        let outcome;
        try {
            outcome = await agent.run(ctx, { subject: '化學', chapter: e.decoy_chapter || '', chapter_confidence: 0, question_text: e.question_text });
        } catch (err) {
            outcome = { kind: 'error', message: err.message };
        }
        if (outcome.kind === 'error' && replayMiss.isReplayMiss(outcome.message)) { misses.push(e.id); continue; }
        if (outcome.kind === 'error') { failures.push(`${e.id}：${outcome.message}`); continue; }
        const pred = outcome.data ? outcome.data.chapter : null;
        rows.push({ id: e.id, gold: e.chapter, pred, volume: volumeOf('化學', e.chapter), hit_decoy: !!(e.decoy_chapter && pred === e.decoy_chapter) });
    }

    if (failures.length) {
        console.error(`❌ 化學 classify eval 有 ${failures.length} 筆呼叫失敗：\n  - ${failures.slice(0, 10).join('\n  - ')}`);
        return 1;
    }
    if (misses.length) {
        console.log(`⚠️  化學 classify eval：${misses.length}/${golden.entries.length} 筆 replay miss（${misses.slice(0, 5).join('、')}${misses.length > 5 ? ' …' : ''}），` +
            'cassette 不完整，這一輪分數一律 n/a。請重新錄製（docs/chemistry.md 第 6 節）。');
        return 0;
    }

    const acc = metrics.accuracy(rows);
    const f1 = metrics.macroF1(rows);
    const byVolume = {};
    for (const v of VOLUMES['化學']) {
        const sub = rows.filter(r => r.volume === v.name);
        byVolume[v.name] = sub.length ? metrics.round4(metrics.accuracy(sub).accuracy) : null;
    }
    const report = {
        generated_at: new Date().toISOString(),
        suite: 'classify-chem',
        measured: { accuracy: metrics.round4(acc.accuracy), macro_f1: metrics.round4(f1.macroF1), n: acc.n, correct: acc.correct },
        byVolume,
        decoyHits: rows.filter(r => r.hit_decoy).length,
        confusion: metrics.confusionPairs(rows, 5),
        perEntry: rows,
        meta: { agent: AGENT, llmMode: mode, golden: path.relative(ROOT, args.golden).replace(/\\/g, '/'), chapters: CHAPTERS['化學'].length }
    };

    console.log(`化學 classify eval（${acc.n} 筆）：accuracy ${report.measured.accuracy}、macro-F1 ${report.measured.macro_f1}、誤判成 decoy ${report.decoyHits} 筆`);
    for (const [vol, a] of Object.entries(byVolume)) console.log(`  ${vol}：${a === null ? 'n/a' : a}`);
    for (const c of report.confusion) console.log(`  混淆：${c.gold} → ${c.pred}（${c.count}）`);

    const dir = path.join(__dirname, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `classify-chem-${report.generated_at.slice(0, 10)}-${gitSha()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`報表：${path.relative(ROOT, out)}`);

    if (Number.isFinite(args.minAccuracy) && acc.accuracy < args.minAccuracy) {
        console.error(`❌ accuracy ${report.measured.accuracy} < --min-accuracy ${args.minAccuracy}`);
        return 1;
    }
    return 0;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { validateGolden, loadGolden, hasCassettes, AGENT, DEFAULT_GOLDEN };
