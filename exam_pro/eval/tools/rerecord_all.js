// ─────────────────────────────────────────────────────────────
// eval/tools/rerecord_all.js — 章節重整後一次重錄全部 cassette 與缺的向量
//                              （npm run cassettes:rerecord；docs/chapter-restructure.md 第 3.2 條第 2 點、第 5 條）
//
// 給 Owner 在 Windows 的 exam_pro/ 底下執行：
//   npm run cassettes:rerecord -- --dry-run    只回放、不連網：列出每個 suite 缺多少 cassette、預估呼叫次數與費用（本機：時間）
//   npm run cassettes:rerecord                 先印同一份盤點，輸入 yes 之後才開始錄
//                                              （CI 的模型是 Gemini 時**會產生費用**；是 ollama: 時在本機跑，不花錢但很慢）
//
// 錄製**完全沿用 repo 既有的機制**，本檔只負責依序呼叫、把環境設對：
//   1. 向量（只補缺的）   node eval/record_embeddings.js --only-missing           EMBED_MODE=live
//   2. classify          node eval/run.js --suite classify                       LLM_MODE=record
//   3. nlq               node eval/run.js --suite nlq                            LLM_MODE=record、EMBED_MODE=record（裁決 S3-20）
//   4. variant           node eval/run.js --suite variant                        LLM_MODE=record、EMBED_MODE=record（裁決 S3-20）
//   5. pipeline（＝e2e） node eval/run.js --suite pipeline                       LLM_MODE=record
//                        extract 與後續節點（classify／lint／verify）；e2e 用的是同一份樣卷、同一組呼叫
//   6. e2e 的 dedup1 向量 node --test test/e2e/…                                 LLM_MODE=replay、EMBED_MODE=record、FEATURE_SIMILAR=true
//                        CI 用不到（FEATURE_SIMILAR 沒開時 dedup1 一律 skipped）；本機 .env 開著 FEATURE_SIMILAR
//                        時 e2e 需要這幾筆向量（docs/HANDOFF.md 第 8 節）。--no-similar 可略過。
//   7. 驗證：以 CI 的設定（replay／fixture）把五個 eval 與 e2e 各跑一次，印出結果與門檻比較。
//
// 所有子行程的模型一律照 .github/workflows/ci.yml（MODEL_EXTRACT／MODEL_VERIFY，以及有寫的 EMBED_MODEL／MODEL_NLQ），
// .env 裡的 MODEL_*、FEATURE_* 不會帶進去：cassette 的鍵含模型 ID，照 .env 錄的鍵 CI 讀不到（見 eval/lib/suiteProcess.js 檔頭）。
// 金鑰讀 exam_pro/.env 的 GEMINI_API_KEY（只有模型走 Gemini 時才需要）；測試庫讀 TEST_DATABASE_URL（nlq 的 Recall@10 與 e2e 要用）。
//
// 門檻：驗證那一步若有 eval 低於 eval/thresholds.json，**不會**自動放寬——印出來，另開裁決
// （docs/chapter-restructure.md 第 5 條第 4 點）。
//
// 〔本機模式 L4，docs/local-mode.md 第 6 條第 2 點〕ci.yml 的模型是 ollama: 時：
//   - 不要求 GEMINI_API_KEY（只有真的有模型走 Gemini 才要）；
//   - 問 yes 之前先做錄前檢查，任一項沒過就停、一次都不錄：
//       ① Ollama 連得上（GET {OLLAMA_HOST}/api/tags），需要的模型都已下載（列出缺的，提示 ollama pull）；
//       ② 要錄 pipeline 且 OCR_ENGINE=paddle 時，<OCR_PYTHON> ocr_service/ocr_pdf.py --selftest 通過；
//       ③ 測試庫已套 migration（既有）；
//   - 盤點的費用欄改成「預估時間」（粗估，eval/lib/localMode.js 檔頭有依據與覆寫方式）；
//   - 錄製子行程多帶 JOB_NODE_TIMEOUT_MS／NLQ_TIMEOUT_MS 的本機值（一次呼叫可能十幾分鐘；不影響 cassette 的鍵）。
//   - 〔看圖拆題逾時〕pipeline 與 e2e 兩步（localMode.LONG_CALL_STEPS）再放寬：單次 Ollama 呼叫與節點逾時至少 3 小時
//     （RERECORD_OLLAMA_TIMEOUT_MS／RERECORD_NODE_TIMEOUT_MS 可覆寫）、每 5 分鐘印一次串流進度（localMode.longCallRecordEnv）。
//     Owner 實機上 qwen3-vl:8b 看一塊 2 頁超過 30 分鐘，被 .env 的 OLLAMA_TIMEOUT_MS 切掉、extract_vision 錄不到。
//     子行程的環境照舊經 ciEnv 的 extra 帶進去（stepExtraEnv）；不改 .env、不影響 cassette 的鍵與 CI 回放。
// Windows 上可以直接雙擊 exam_pro\scripts\windows\record_local.bat（db:up → migrate:test → 本指令，自動輸入 yes、寫 log）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_DIR = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });

const { ALL_SUITES, EVAL_SUITES, ciEnv, suiteArgs, runNode, readCiModels } = require('../lib/suiteProcess');
const { analyze, formatSummary, thresholdRows } = require('../lib/cassettePlan');
const local = require('../lib/localMode');

const USAGE = `用法：npm run cassettes:rerecord -- [選項]

  --dry-run          只回放、不連網：列出每個 suite 缺多少 cassette、預估呼叫次數與費用（本機模型：預估時間）
  --json             與 --dry-run 一起用：輸出機器可讀的 JSON（給測試與自動化）
  --suites <a,b>     只看／只錄這幾個 suite（預設全部：${ALL_SUITES.join(',')}）
  --no-similar       略過第 6 步（e2e 的 dedup1 向量；CI 用不到）
  --skip-verify      錄完不跑第 7 步的回放驗證
  -h, --help         顯示這段說明

正式執行前會印出盤點結果並做錄前檢查（本機模型：Ollama 與 OCR；Gemini：金鑰），
要求輸入 yes 才開始呼叫模型。`;

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, json:boolean, suites:string[], withSimilar:boolean, verify:boolean, help:boolean}}
 */
function parseArgs(argv) {
    const args = { dryRun: false, json: false, suites: ALL_SUITES.slice(), withSimilar: true, verify: true, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--dry-run': args.dryRun = true; break;
            case '--json': args.json = true; break;
            case '--suites': {
                const list = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
                for (const s of list) {
                    if (!ALL_SUITES.includes(s)) throw new Error(`--suites 的「${s}」不存在（可用：${ALL_SUITES.join(',')}）`);
                }
                if (!list.length) throw new Error('--suites 後面要接至少一個 suite');
                args.suites = ALL_SUITES.filter(s => list.includes(s));   // 依 CI 的順序
                break;
            }
            case '--no-similar': args.withSimilar = false; break;
            case '--skip-verify': args.verify = false; break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    if (args.json && !args.dryRun) throw new Error('--json 只能與 --dry-run 一起用（正式錄製要人工輸入 yes）');
    return args;
}

/**
 * 錄製步驟（依序）。每一步都只是既有入口加上環境變數，不另寫錄製邏輯。純函式。
 * @param {{suites?:string[], withSimilar?:boolean}} [opts]
 * @returns {Array<{name:string, label:string, args:string[], llmMode:string, embedMode:string, extra:Record<string,string>}>}
 */
function recordSteps({ suites = ALL_SUITES, withSimilar = true } = {}) {
    const want = new Set(suites);
    const steps = [];
    if (want.has('retrieval') || want.has('variant') || want.has('nlq')) {
        steps.push({ name: 'embeddings', label: 'fixture 題缺的向量（只補缺的）', args: ['eval/record_embeddings.js', '--only-missing'], llmMode: 'replay', embedMode: 'live', extra: {} });
    }
    if (want.has('classify')) steps.push({ name: 'classify', label: 'classify suite', args: suiteArgs('classify'), llmMode: 'record', embedMode: 'fixture', extra: {} });
    if (want.has('nlq')) steps.push({ name: 'nlq', label: 'nlq suite（含查詢句向量）', args: suiteArgs('nlq'), llmMode: 'record', embedMode: 'record', extra: {} });
    if (want.has('variant')) steps.push({ name: 'variant', label: 'variant suite（含生成題向量）', args: suiteArgs('variant'), llmMode: 'record', embedMode: 'record', extra: {} });
    if (want.has('pipeline') || want.has('e2e')) {
        steps.push({ name: 'pipeline', label: 'pipeline（extract 與後續節點；e2e 共用）', args: suiteArgs('pipeline'), llmMode: 'record', embedMode: 'fixture', extra: {} });
    }
    if (withSimilar && want.has('e2e')) {
        steps.push({ name: 'e2e-similar', label: 'e2e 的 dedup1 向量（FEATURE_SIMILAR=true；CI 用不到）', args: suiteArgs('e2e'), llmMode: 'replay', embedMode: 'record', extra: { FEATURE_SIMILAR: 'true' } });
    }
    return steps;
}

/**
 * 某一步錄製子行程要蓋在 CI 環境上的變數（ciEnv 的 extra）。純函式。
 * 順序：本機長呼叫（localRecordEnv）→ pipeline／e2e 的寬逾時與進度（longCallRecordEnv，只有 LONG_CALL_STEPS）→ 步驟自己的 extra。
 * @param {{name:string, extra?:Record<string,string>}} step recordSteps() 的一步
 * @param {ReturnType<typeof local.recordingPlan>} plan
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env] 讀 RERECORD_*、OLLAMA_TIMEOUT_MS、OLLAMA_PROGRESS_MS（預設 process.env，已載入 .env）
 * @returns {Record<string,string>}
 */
function stepExtraEnv(step, plan, env = process.env) {
    return {
        ...local.localRecordEnv(plan),
        ...(local.LONG_CALL_STEPS.includes(step.name) ? local.longCallRecordEnv(plan, env) : {}),
        ...(step.extra || {})
    };
}

/**
 * 盤點後、問 yes 之前印的一行：pipeline／e2e 兩步用多長的逾時（本機才印）。純函式。
 * @param {Array<{name:string}>} steps
 * @param {ReturnType<typeof local.recordingPlan>} plan
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string|null}
 */
function longCallNote(steps, plan, env = process.env) {
    const names = steps.filter(s => local.LONG_CALL_STEPS.includes(s.name)).map(s => s.name);
    if (!names.length || !plan || !plan.local) return null;
    const e = local.longCallRecordEnv(plan, env);
    const progress = Number(e.OLLAMA_PROGRESS_MS || env.OLLAMA_PROGRESS_MS || 0);
    return `${names.join('、')}：單次 Ollama 呼叫逾時 ${local.formatDuration(Number(e.OLLAMA_TIMEOUT_MS) / 1000)}、` +
        `節點逾時 ${local.formatDuration(Number(e.JOB_NODE_TIMEOUT_MS) / 1000)}（RERECORD_OLLAMA_TIMEOUT_MS／RERECORD_NODE_TIMEOUT_MS 可改；不動 .env）` +
        (progress > 0 ? `，每 ${local.formatDuration(progress / 1000)}印一次輸出進度` : '，不印輸出進度（.env 的 OLLAMA_PROGRESS_MS=0）') + '。';
}

/**
 * 只有 yes（不分大小寫、前後空白不計）才算同意。純函式。
 * @param {string|null|undefined} answer
 * @returns {boolean}
 */
function isYes(answer) {
    return String(answer ?? '').trim().toLowerCase() === 'yes';
}

/**
 * 在終端機問一次 yes。stdin 不是互動終端或直接結束時回 false（不錄）。
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function askYes(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;
        rl.question(question, (answer) => { answered = true; rl.close(); resolve(isYes(answer)); });
        rl.on('close', () => { if (!answered) resolve(false); });
    });
}

/**
 * 從 e2e 的輸出撈 node --test 的統計（# pass N / # fail M / # skipped K）。
 * @param {string[]} tail
 * @returns {{pass:number|null, fail:number|null, skipped:number|null}}
 */
function e2eCounts(tail) {
    const pick = (name) => {
        for (let i = tail.length - 1; i >= 0; i--) {
            const m = tail[i].match(new RegExp(`^# ${name} (\\d+)`));
            if (m) return Number(m[1]);
        }
        return null;
    };
    return { pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped') };
}

/**
 * 驗證那一步：逐 suite 排出「結束碼、replay miss、缺向量、門檻」。
 * @param {object} res analyze() 的回傳（replay／fixture 跑完的那一輪）
 * @returns {{lines:string[], ok:boolean, missTotal:number, thresholdFailures:string[]}}
 */
function verifyReport(res) {
    const lines = ['| suite | 結束碼 | replay miss | 缺向量 | 門檻 |', '|---|---:|---:|---:|---|'];
    let ok = true;
    let missTotal = 0;
    const thresholdFailures = [];
    for (const [name, s] of Object.entries(res.summary.suites)) {
        const run = res.runs[name] || {};
        // e2e 的缺向量是存題時的向量，查不到只記 log、不影響 e2e（eval/lib/cassetteAudit.js 的 EMBED_TOLERANT_SUITES）
        missTotal += s.misses + (s.embed.tolerated ? 0 : s.embed.misses);
        let verdict = '—';
        if (name === 'e2e') {
            const c = e2eCounts(run.tail || []);
            verdict = `pass ${c.pass ?? '?'}／fail ${c.fail ?? '?'}／skipped ${c.skipped ?? '?'}`;
        } else {
            const file = (run.reportFiles || []).slice(-1)[0];
            if (file && fs.existsSync(file)) {
                const t = thresholdRows(JSON.parse(fs.readFileSync(file, 'utf8')));
                const bad = t.rows.filter(r => !r.ok);
                verdict = t.rows.length === 0 ? '未設門檻（只報告）'
                    : bad.length === 0 ? `✅ ${t.rows.length} 項全達標`
                        : `❌ ${bad.map(r => `${r.metric} ${r.measured === null ? 'n/a' : r.measured.toFixed(4)} < ${r.threshold}`).join('；')}`;
                thresholdFailures.push(...t.failures.map(f => `${name}：${f}`));
            } else {
                verdict = '沒有報表（多半是在量測前就失敗了）';
            }
        }
        if (run.exitCode !== 0) ok = false;
        lines.push(`| ${name} | ${run.exitCode ?? '—'} | ${s.misses} | ${s.embed.misses} | ${verdict} |`);
    }
    return { lines, ok: ok && missTotal === 0, missTotal, thresholdFailures };
}

/** 印一段標題 */
/**
 * 〔CR-8〕測試庫是否已套 migration：以最早與最新兩張會用到的表為準（attempts：nlq 的 Recall@10；
 * chapter_migration_log：0014，章節重整後最新的一支）。
 * @returns {Promise<{ok:boolean, missing?:string[], error?:string}>}
 */
async function checkTestDbSchema() {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    try {
        await client.connect();
        const { rows } = await client.query(
            "SELECT to_regclass('public.attempts') AS attempts, to_regclass('public.chapter_migration_log') AS chapter_migration_log");
        const missing = Object.entries(rows[0] || {}).filter(([, v]) => !v).map(([k]) => k);
        return { ok: missing.length === 0, missing };
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        await client.end().catch(() => {});
    }
}

function banner(text) {
    console.log(`\n══ ${text} ${'═'.repeat(Math.max(0, 60 - text.length))}`);
}

/** 〔本機模式 L4〕CI 沒寫這個變數時，子行程實際用的是什麼（給「.env 的值不會用到」那段提示） */
const CI_UNSET_TEXT = Object.freeze({
    MODEL_VARIANT: '未設，退回 MODEL_VERIFY',
    MODEL_OCR_STRUCTURE: '未設，退回 MODEL_VERIFY',
    MODEL_NLQ: `未設，services/nlqService.js 的預設 ${local.NLQ_CODE_DEFAULT}`,
    EMBED_MODEL: `未設，程式預設 ${local.LOCAL_DEFAULTS.EMBED_MODEL}`,
    OCR_ENGINE: `未設，程式預設 ${local.LOCAL_DEFAULTS.OCR_ENGINE}`
});

/**
 * 〔本機模式 L4〕錄前檢查：金鑰（只有走 Gemini 才要）、測試庫、Ollama、OCR、測試庫的 migration。
 * 任一項沒過就印原因與處置、回 false（呼叫端結束碼 1，一次都不錄）。
 * @param {ReturnType<typeof local.recordingPlan>} plan
 * @param {object} deps
 * @returns {Promise<boolean>}
 */
async function preflight(plan, deps) {
    if (plan.needGeminiKey && !String(process.env.GEMINI_API_KEY || '').trim()) {
        const which = plan.gemini.map(u => `${u.key}=${u.spec}`).join('、');
        console.error(`\n❌ exam_pro/.env 沒有 GEMINI_API_KEY：${which} 走 Gemini，錄製必須真的呼叫模型。`);
        return false;
    }
    if (!String(process.env.TEST_DATABASE_URL || '').trim()) {
        console.error('\n❌ 沒有 TEST_DATABASE_URL：nlq 的查詢句向量與 e2e 都要測試庫才錄得到。');
        return false;
    }
    if (plan.ollama.length) {
        const host = local.ollamaHost(process.env);
        if (host.error) {
            console.error(`\n❌ ${host.error}`);
            return false;
        }
        if (!host.local) console.log(`⚠️ OLLAMA_HOST 指向本機以外的主機（${host.url}）：本機模式的原則是執行期不連外（docs/local-mode.md 第 1 條）。`);
        const r = await deps.checkOllama({ host: host.url, models: plan.ollama });
        if (!r.ok) {
            console.error(`\n❌ ${r.error}`);
            for (const line of local.ollamaAdvice(r, host.url)) console.error(`   ${line}`);
            return false;
        }
        console.log(`✅ Ollama（${host.url}）已就緒，需要的模型都在：${plan.ollama.join('、')}`);
    }
    if (plan.needOcr) {
        const python = local.ocrPython(process.env);
        const r = await deps.checkOcr({ python });
        if (!r.ok) {
            console.error(`\n❌ ${r.error}`);
            for (const line of r.detail || []) console.error(`   │ ${line}`);
            for (const line of local.ocrAdvice(python)) console.error(`   ${line}`);
            return false;
        }
        console.log(`✅ PaddleOCR 自我檢查通過（${r.engineVersion || '版本不明'}）`);
    }
    // 〔CR-8〕測試庫是 tmpfs，每次啟動都是空的；沒套 migration 時 nlq 的 Recall@10 會是 n/a（CR-7 ④ 實際發生過），
    // 錄了也量不齊——花錢（本機：花好幾個小時）之前先擋下來。
    const schema = await deps.checkTestDbSchema();
    if (!schema.ok) {
        const why = schema.error ? `連不上測試庫（${schema.error}）` : `測試庫缺資料表：${(schema.missing || []).join('、')}`;
        console.error(`\n❌ ${why}。請先 npm run db:up，再 npm run migrate:test，之後重跑本指令。`);
        return false;
    }
    return true;
}

/**
 * @param {string[]} [argv]
 * @param {{askYes?:Function, analyze?:Function, runNode?:Function, checkTestDbSchema?:Function,
 *          readCiModels?:Function, checkOllama?:Function, checkOcr?:Function}} [io] 測試注入點（預設就是真的那幾支）
 * @returns {Promise<number>} 結束碼
 */
async function main(argv = process.argv.slice(2), io = {}) {
    const deps = {
        askYes, analyze, runNode, checkTestDbSchema, readCiModels,
        checkOllama: local.checkOllama, checkOcr: local.checkOcr, ...io
    };
    const args = parseArgs(argv);
    if (args.help) { console.log(USAGE); return 0; }

    const models = deps.readCiModels();
    const plan = local.recordingPlan({ models, suites: args.suites, withSimilar: args.withSimilar });
    const notes = [];
    for (const k of ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_VARIANT', 'MODEL_OCR_STRUCTURE', 'MODEL_NLQ', 'EMBED_MODEL', 'OCR_ENGINE']) {
        const mine = String(process.env[k] || '').trim();
        const ci = models[k] || '';
        if (mine && mine !== ci) notes.push(`.env 的 ${k}=${mine} 不會用到：錄製與回放一律照 CI（${ci || CI_UNSET_TEXT[k] || '未設'}），否則錄出來的鍵 CI 讀不到。`);
    }
    if (!String(process.env.TEST_DATABASE_URL || '').trim()) {
        notes.push('沒有設 TEST_DATABASE_URL：retrieval 會退回記憶體引擎、nlq 量不到 Recall@10、e2e 整支跳過。請先啟動測試庫（啟動資料庫.bat）並在 .env 設好。');
    }

    if (!args.json) {
        banner(args.dryRun ? '重錄前盤點（--dry-run：只回放、不連網）' : '重錄前盤點（只回放、不連網）');
        for (const n of notes) console.log(`⚠️ ${n}`);
        console.log(`依序以回放模式跑：${args.suites.join(' → ')}（每個 suite 要幾秒到幾分鐘）`);
    }
    const before = await deps.analyze({ suites: args.suites, models, onStart: args.json ? undefined : (s) => console.log(`  · ${s} …`) });
    const time = plan.local ? local.estimateLocalTime(before.summary) : null;

    if (args.dryRun) {
        if (args.json) {
            const localInfo = plan.local ? {
                ollamaModels: plan.ollama, needGeminiKey: plan.needGeminiKey, needOcr: plan.needOcr,
                estimateSec: { lower: Math.round(time.lowerSec), upper: Math.round(time.upperSec) }
            } : null;
            console.log(JSON.stringify({ models, notes, local: localInfo, steps: recordSteps(args).map(s => s.name), summary: before.summary }, null, 2));
        } else {
            console.log('');
            console.log(formatSummary(before));
            console.log(`\n正式錄製會依序執行：${recordSteps(args).map(s => s.label).join(' → ')}，再以回放驗證。`);
            if (plan.local) {
                console.log(`錄前會檢查：Ollama 與模型（${plan.ollama.join('、')}）${plan.needOcr ? '、PaddleOCR（ocr_pdf.py --selftest）' : ''}、測試庫的 migration。`);
            }
            console.log('--dry-run 到此為止，沒有呼叫任何外部服務。');
        }
        return 0;
    }

    console.log('');
    console.log(formatSummary(before));

    if (!(await preflight(plan, deps))) return 1;

    const steps = recordSteps(args);
    const what = !plan.local ? '會呼叫 Gemini、會產生費用'
        : `本機模型，不連外、不花錢；粗估 ${local.formatDuration(time.lowerSec)}～${local.formatDuration(time.upperSec)}，期間不要讓電腦睡眠` +
          (plan.needGeminiKey ? `。⚠️ ${plan.gemini.map(u => u.key).join('、')} 仍走 Gemini，那一部分會產生費用` : '');
    console.log(`\n接下來會依序執行（${what}）：\n${steps.map((s, i) => `  ${i + 1}. ${s.label}`).join('\n')}`);
    const longNote = longCallNote(steps, plan);
    if (longNote) console.log(`  （${longNote}）`);
    const ok = await deps.askYes('\n確定要開始錄製嗎？請輸入 yes：');
    if (!ok) {
        console.log('已取消，沒有呼叫任何模型。');
        return 0;
    }

    const results = [];
    for (const [i, step] of steps.entries()) {
        banner(`${i + 1}/${steps.length} ${step.label}`);
        const env = ciEnv({ llmMode: step.llmMode, embedMode: step.embedMode, models, extra: stepExtraEnv(step, plan) });
        const r = await deps.runNode({ args: step.args, env, echo: true });
        results.push({ step: step.name, exitCode: r.exitCode, ms: r.ms });
        console.log(`  → 結束碼 ${r.exitCode}，${Math.round(r.ms / 1000)} 秒` +
            (r.exitCode === 0 ? '' : '（錄製模式下 eval 未達門檻也會回 1；以最後的回放驗證為準）'));
    }

    if (!args.verify) {
        console.log('\n已略過回放驗證（--skip-verify）。');
        return 0;
    }

    banner('回放驗證（CI 的設定：replay／fixture）');
    const after = await deps.analyze({ suites: args.suites, models, onStart: (s) => console.log(`  · ${s} …`) });
    const v = verifyReport(after);
    console.log(v.lines.join('\n'));
    if (v.thresholdFailures.length) {
        console.log(`\n門檻未達（不會自動放寬；請另開裁決，docs/chapter-restructure.md 第 5 條第 4 點` +
            `${plan.local ? '；換成本機模型後低於門檻由 Owner 另行裁決，docs/local-mode.md 第 6 條第 3 點' : ''}）：\n  - ${v.thresholdFailures.join('\n  - ')}`);
    }
    console.log('\n錄製步驟：' + results.map(r => `${r.step}=${r.exitCode}（${Math.round(r.ms / 1000)} 秒）`).join('、'));
    console.log('\n下一步：');
    console.log('  1. git add eval/cassettes eval/fixtures/embeddings.*.json，commit、push。');
    console.log('  2. npm run cassettes:prune 先看要刪哪些過期檔，確認後 npm run cassettes:prune -- --apply，再 commit。');
    console.log('     （單元測試 sourceCheckSample 要求 extract.v2 的 cassette 恰好一份：舊的那份清掉之前它會紅。）');
    return v.ok ? 0 : 1;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error(`\n❌ ${err.message}`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs, recordSteps, stepExtraEnv, longCallNote, isYes, e2eCounts, verifyReport, preflight, USAGE };
