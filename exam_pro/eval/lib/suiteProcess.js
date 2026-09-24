// ─────────────────────────────────────────────────────────────
// eval/lib/suiteProcess.js — 以「CI 的設定」在子行程跑各 suite 的既有入口
//
// 給 eval/tools/rerecord_all.js 與 eval/tools/prune_cassettes.js 共用。
//
// 為什麼一定要「CI 的設定」：cassette 的鍵含模型 ID（services/llm/cassette.js），
// 而 Owner 本機的 .env 可能設了別的 MODEL_*、FEATURE_*——照 .env 錄，錄出來的鍵 CI 讀不到；
// 照 .env 回放，清除工具會把 CI 真正會讀的 cassette 當成「沒被用到」刪掉。
// 所以子行程的環境一律照 .github/workflows/ci.yml 的 integration job：
//   LLM_MODE／EMBED_MODE／MODEL_EXTRACT／MODEL_VERIFY 取 ci.yml 的值，
//   其餘會影響鍵或流程的變數（MODEL_*、FEATURE_*、.env 裡的其他設定）一律設成空字串——
//   設成空字串而不是刪掉，是因為 workers/jobRunner.js 會 require('dotenv').config()，
//   dotenv 不覆寫「已存在」的變數，空字串才擋得住 .env 把值補回來。
// 只放行少數「不影響鍵」而且必要的變數：TEST_DATABASE_URL（pg engine 與 e2e）、
// EVAL_CASSETTE_DIR／EMBED_FIXTURE_DIR（測試會指到暫存目錄）、錄製時的 GEMINI_API_KEY 與速率限制。
//
// 子行程跑的是**既有入口**，不另寫 suite：
//   eval：  node --env-file=eval/.env.replay eval/run.js --suite <s>     （= npm run eval -- --suite <s>）
//   e2e：   node --env-file=eval/.env.replay --test --test-concurrency=1 test/e2e/**/*.test.js（= npm run test:e2e）
// 直接呼叫 node（process.execPath）而不是 npm：Windows 上不必經過 shell，路徑有空白或中文也不必跳脫。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..');
const PROBE_PATH = path.join(__dirname, 'cassetteProbe.js');

/** 五個 eval suite（CI 的順序）＋ e2e */
const EVAL_SUITES = Object.freeze(['retrieval', 'classify', 'pipeline', 'nlq', 'variant']);
const ALL_SUITES = Object.freeze([...EVAL_SUITES, 'e2e']);

/** ci.yml 讀不到時的退路：與 config/models.js 的預設值一致（ci.yml 註解寫明兩者一致） */
const FALLBACK_CI_MODELS = Object.freeze({
    MODEL_EXTRACT: 'gemini:gemini-3.5-flash',
    MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview'
});

/** 放行到子行程的變數（不影響 cassette 的鍵，而且是跑起來必要的） */
const PASS_THROUGH = Object.freeze([
    'TEST_DATABASE_URL', 'EVAL_CASSETTE_DIR', 'EMBED_FIXTURE_DIR'
]);
/** 只在錄製時放行 */
const RECORD_PASS_THROUGH = Object.freeze(['GEMINI_API_KEY', 'GEMINI_RPM', 'EMBED_RPM', 'EMBED_BATCH']);

/**
 * 從 .github/workflows/ci.yml 讀 integration job 的 MODEL_EXTRACT／MODEL_VERIFY。
 * @param {string} [file] 預設 <repo>/.github/workflows/ci.yml
 * @returns {{MODEL_EXTRACT:string, MODEL_VERIFY:string, source:string}}
 */
function readCiModels(file = path.resolve(APP_DIR, '..', '.github', 'workflows', 'ci.yml')) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { text = null; }
    if (!text) return { ...FALLBACK_CI_MODELS, source: 'config/models.js 的預設值（找不到 ci.yml）' };
    const pick = (name) => {
        const m = text.match(new RegExp(`^\\s*${name}:\\s*([^\\s#]+)\\s*$`, 'm'));
        return m ? m[1].replace(/^['"]|['"]$/g, '') : FALLBACK_CI_MODELS[name];
    };
    return { MODEL_EXTRACT: pick('MODEL_EXTRACT'), MODEL_VERIFY: pick('MODEL_VERIFY'), source: path.relative(path.resolve(APP_DIR, '..'), file).split(path.sep).join('/') };
}

/**
 * exam_pro/.env 裡出現的變數名（不讀值；檔案不存在回空陣列）。
 * @param {string} [file]
 * @returns {string[]}
 */
function dotenvKeys(file = path.join(APP_DIR, '.env')) {
    try {
        const dotenv = require('dotenv');
        return Object.keys(dotenv.parse(fs.readFileSync(file)));
    } catch (err) {
        return [];
    }
}

/**
 * 組子行程的環境。
 * @param {object} opts
 * @param {'replay'|'record'} [opts.llmMode='replay']
 * @param {'fixture'|'record'|'live'} [opts.embedMode='fixture']
 * @param {Record<string,string>} [opts.extra]  最後再蓋上去的變數（例如 FEATURE_SIMILAR=true、EVAL_PROBE_DIR）
 * @param {NodeJS.ProcessEnv} [opts.base=process.env]
 * @param {string[]} [opts.envFileKeys] .env 裡的變數名（預設讀 exam_pro/.env）
 * @param {{MODEL_EXTRACT:string, MODEL_VERIFY:string}} [opts.models] 預設讀 ci.yml
 * @returns {Record<string,string>}
 */
function ciEnv(opts = {}) {
    const base = opts.base || process.env;
    const llmMode = opts.llmMode || 'replay';
    const embedMode = opts.embedMode || 'fixture';
    const models = opts.models || readCiModels();
    const recording = llmMode !== 'replay' || embedMode !== 'fixture';
    const allow = new Set([...PASS_THROUGH, ...(recording ? RECORD_PASS_THROUGH : [])]);

    const env = { ...base };
    const shield = new Set(opts.envFileKeys || dotenvKeys());
    for (const k of Object.keys(base)) {
        if (/^(MODEL_|FEATURE_)/.test(k)) shield.add(k);
    }
    // 其他已知會改變流程或鍵、而 CI 沒有設的變數
    for (const k of ['JIEBA_DICT_BIG', 'EMBED_MODEL', 'EMBED_DIM', 'EVAL_FORK_PR', 'GEMINI_API_KEY', 'DATABASE_URL',
        'CLASSIFY_MIN_CONF', 'KNN_VOTE_SIM', 'VARIANT_SIM_MIN', 'VARIANT_RETRIEVE_SIM_MIN', 'VARIANT_OFFTOPIC_SIM_MIN',
        'DEDUP_DUP_THRESHOLD', 'DEDUP_VARIANT_THRESHOLD', 'JOB_PDF_CHUNK_PAGES', 'GEMINI_INLINE_MAX_BYTES']) {
        shield.add(k);
    }
    for (const k of shield) {
        if (!allow.has(k)) env[k] = '';
    }
    env.LLM_MODE = llmMode;
    env.EMBED_MODE = embedMode;
    env.MODEL_EXTRACT = models.MODEL_EXTRACT;
    env.MODEL_VERIFY = models.MODEL_VERIFY;
    // 本工具若是在 node --test 底下被呼叫（整合測試），這個變數會讓子行程裡的 node --test 改用
    // 「子測試回報」模式、不照一般方式跑測試檔——e2e 就一筆回放都不會發生。子行程一律從乾淨的狀態開始。
    delete env.NODE_TEST_CONTEXT;
    return { ...env, ...(opts.extra || {}) };
}

/**
 * suite 名 → node 的參數（不含 --require）。
 * @param {string} suite
 * @returns {string[]}
 */
function suiteArgs(suite) {
    if (suite === 'e2e') {
        return ['--env-file=eval/.env.replay', '--test', '--test-concurrency=1', 'test/e2e/**/*.test.js'];
    }
    if (!EVAL_SUITES.includes(suite)) throw new Error(`未知的 suite「${suite}」（可用：${ALL_SUITES.join('｜')}）`);
    return ['--env-file=eval/.env.replay', 'eval/run.js', '--suite', suite];
}

/**
 * 跑一個子行程，輸出同時轉印（可關）並保留最後 200 行。
 * @param {object} opts
 * @param {string[]} opts.args      node 的參數
 * @param {Record<string,string>} opts.env
 * @param {boolean} [opts.echo=true]  是否把子行程的輸出印到本行程
 * @param {string} [opts.prefix]    轉印時每行加的前綴
 * @returns {Promise<{exitCode:number|null, signal:string|null, ms:number, tail:string[], reportFiles:string[]}>}
 */
function runNode({ args, env, echo = true, prefix = '' }) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, args, { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const tail = [];
        const reportFiles = [];
        let buf = { stdout: '', stderr: '' };
        const onData = (stream, target) => (chunk) => {
            buf[stream] += chunk.toString('utf8');
            let idx;
            while ((idx = buf[stream].indexOf('\n')) !== -1) {
                const line = buf[stream].slice(0, idx).replace(/\r$/, '');
                buf[stream] = buf[stream].slice(idx + 1);
                tail.push(line);
                if (tail.length > 200) tail.shift();
                const m = line.match(/報表已寫入 (.+\.json)\s*$/);
                if (m) reportFiles.push(m[1].trim());
                if (echo) target.write(`${prefix}${line}\n`);
            }
        };
        child.stdout.on('data', onData('stdout', process.stdout));
        child.stderr.on('data', onData('stderr', process.stderr));
        child.on('close', (code, signal) => {
            for (const s of ['stdout', 'stderr']) if (buf[s]) { tail.push(buf[s]); if (echo) process.stdout.write(`${prefix}${buf[s]}\n`); }
            resolve({ exitCode: code, signal, ms: Date.now() - t0, tail, reportFiles });
        });
        child.on('error', (err) => resolve({ exitCode: null, signal: null, ms: Date.now() - t0, tail: [String(err.message)], reportFiles }));
    });
}

/**
 * 以回放探針跑一組 suite（CI 的設定），回傳各 suite 的結束碼與探針目錄。
 * @param {object} opts
 * @param {string[]} opts.suites
 * @param {string} opts.probeDir  探針紀錄目錄（呼叫端負責建立與清除）
 * @param {boolean} [opts.echo=false]
 * @param {Record<string,string>} [opts.extraEnv]
 * @param {(suite:string)=>void} [opts.onStart]
 * @returns {Promise<Record<string,{exitCode:number|null, ms:number, tail:string[], reportFiles:string[]}>>}
 */
async function probeSuites({ suites, probeDir, echo = false, extraEnv = {}, onStart }) {
    const runs = {};
    for (const suite of suites) {
        if (onStart) onStart(suite);
        const env = ciEnv({
            llmMode: 'replay', embedMode: 'fixture',
            extra: { ...extraEnv, EVAL_PROBE_DIR: probeDir, EVAL_PROBE_SUITE: suite }
        });
        runs[suite] = await runNode({ args: ['--require', PROBE_PATH, ...suiteArgs(suite)], env, echo, prefix: echo ? `[${suite}] ` : '' });
    }
    return runs;
}

module.exports = {
    EVAL_SUITES, ALL_SUITES, PASS_THROUGH, RECORD_PASS_THROUGH, FALLBACK_CI_MODELS, APP_DIR, PROBE_PATH,
    readCiModels, dotenvKeys, ciEnv, suiteArgs, runNode, probeSuites
};
