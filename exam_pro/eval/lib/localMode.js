// ─────────────────────────────────────────────────────────────
// eval/lib/localMode.js — 本機模式（docs/local-mode.md）在 eval 這一側要用的判斷、檢查與粗估
//
// 給 eval/tools/rerecord_all.js、eval/tools/ocr_selftest.js、eval/lib/cassettePlan.js 共用。
// 這一支**不呼叫任何模型**，只做四件事：
//
//   1. 判斷「這一輪錄製會用到哪些模型、各走哪一家」：recordingPlan()。
//      模型一律照 CI（.github/workflows/ci.yml）——cassette 的鍵含模型 ID，照 .env 錄的鍵 CI 讀不到
//      （eval/lib/suiteProcess.js 檔頭）。全部是 ollama: 時就不需要 GEMINI_API_KEY（第 6 條第 2 點）。
//   2. 錄前檢查：Ollama 連得上、需要的模型都已下載（GET {OLLAMA_HOST}/api/tags）；
//      OCR_ENGINE=paddle 時 ocr_service/ocr_pdf.py --selftest 通過。兩支都可注入替身，單元測試不連網、不跑 Python。
//   3. 錄製子行程的「本機長呼叫」環境：本機 8B 模型一次呼叫可能要十幾分鐘，
//      eval 的 pipeline 驅動與 NLQ 的逾時預設（2 分、4 秒）撐不過去（原則 5）。
//   4. 預估時間：ollama 的費用一律 $0，改印「呼叫次數 × 每次秒數」的**粗估**。
//      每次秒數是依 i5-8265U 等級 CPU（無獨顯）、8B Q4 模型「每秒約 3 個 token 生成、15 個 token 讀 prompt」
//      推的保守值，**未經 Owner 本機實測**；實測後用 RERECORD_TIME_SCALE（整體倍率）或
//      RERECORD_SEC_PER_CALL_<AGENT>（單一 agent 每次秒數）覆寫。
//
// 本機預設值（LOCAL_DEFAULTS）抄自 docs/local-mode.md 第 2 條（凍結契約）；程式裡真正的預設在
// config/models.js（L1 落地）。test/unit/localMode.test.js 釘住這裡與 ci.yml 一致。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..');

/** docs/local-mode.md 第 2 條的本機預設 */
const LOCAL_DEFAULTS = Object.freeze({
    MODEL_EXTRACT: 'ollama:qwen3-vl:8b',
    MODEL_VERIFY: 'ollama:qwen3:8b',
    EMBED_MODEL: 'ollama:qwen3-embedding:0.6b',
    OLLAMA_HOST: 'http://127.0.0.1:11434',
    OCR_ENGINE: 'paddle',
    OCR_DPI: 200
});

/**
 * services/nlqService.js 的 DEFAULT_MODEL_NLQ（該檔沒有匯出這個常數）。
 * CI 沒設 MODEL_NLQ 時 nlq suite 用的就是它；單元測試掃 nlqService.js 的原始碼，兩邊不一致就紅。
 */
const NLQ_CODE_DEFAULT = 'ollama:qwen3:8b';   // 〔LM-7〕與 services/nlqService.js 的 DEFAULT_MODEL_NLQ 同步

/** 第 2 條：拆題模型是 ollama 時 JOB_NODE_TIMEOUT_MS 的預設（45 分） */
const LOCAL_NODE_TIMEOUT_MS = 2_700_000;
/** 本機錄 nlq 時 NLQ_TIMEOUT_MS 的值（＝OLLAMA_TIMEOUT_MS 的預設 30 分；預設 4 秒在 CPU 上一定逾時、錄不到 cassette） */
const LOCAL_NLQ_TIMEOUT_MS = 1_800_000;

/** 會呼叫 LLM 的 suite（retrieval 只讀向量檔） */
const LLM_SUITES = Object.freeze(['classify', 'nlq', 'variant', 'pipeline', 'e2e']);
/** 錄製時會算向量的 suite（第 1 步補 fixture 題、nlq／variant 的 EMBED_MODE=record、e2e 的 dedup1） */
const EMBED_SUITES = Object.freeze(['retrieval', 'nlq', 'variant', 'e2e']);

/**
 * 模型字串的供應商。沒有冒號＝Gemini（第 2 條：沒有前綴的舊值如 gemini-embedding-001 一律視為 Gemini）。
 * 只切第一個冒號（'ollama:qwen3:8b' → 'ollama'），與 config/models.js 的 parseModel 同一條規則。
 * @param {string|null|undefined} spec
 * @returns {string|null} 空字串回 null
 */
function vendorOf(spec) {
    const raw = String(spec == null ? '' : spec).trim();
    if (!raw) return null;
    const i = raw.indexOf(':');
    return i === -1 ? 'gemini' : raw.slice(0, i).trim().toLowerCase();
}

/**
 * 模型字串去掉供應商前綴後的裸 ID（'ollama:qwen3:8b' → 'qwen3:8b'；'gemini-embedding-001' 原樣）。
 * @param {string|null|undefined} spec
 * @returns {string}
 */
function modelIdOf(spec) {
    const raw = String(spec == null ? '' : spec).trim();
    const i = raw.indexOf(':');
    return i === -1 ? raw : raw.slice(i + 1).trim();
}

/**
 * eval 這一側的 embedding 模型：有設 EMBED_MODEL 就用它，否則是本機預設（第 2 條）。
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string}
 */
function embedModelFromEnv(env = process.env) {
    return String(env.EMBED_MODEL || '').trim() || LOCAL_DEFAULTS.EMBED_MODEL;
}

/**
 * CI 的設定（readCiModels() 的回傳）補上「CI 沒設時程式實際生效的值」。
 * @param {Record<string,string>} [ci]
 * @returns {{MODEL_EXTRACT:string, MODEL_VERIFY:string, EMBED_MODEL:string, MODEL_NLQ:string, OCR_ENGINE:string}}
 */
function effectiveModels(ci = {}) {
    return {
        MODEL_EXTRACT: ci.MODEL_EXTRACT || LOCAL_DEFAULTS.MODEL_EXTRACT,
        MODEL_VERIFY: ci.MODEL_VERIFY || LOCAL_DEFAULTS.MODEL_VERIFY,
        EMBED_MODEL: ci.EMBED_MODEL || LOCAL_DEFAULTS.EMBED_MODEL,
        MODEL_NLQ: ci.MODEL_NLQ || NLQ_CODE_DEFAULT,
        OCR_ENGINE: String(ci.OCR_ENGINE || LOCAL_DEFAULTS.OCR_ENGINE).trim().toLowerCase()
    };
}

/**
 * 這一輪錄製會用到哪些模型、各走哪一家、要不要金鑰與 OCR。純函式。
 *
 * MODEL_VARIANT／MODEL_OCR_STRUCTURE 在子行程裡一律是空字串（suiteProcess.ciEnv 擋掉 MODEL_*），
 * 依 fallback 規則退回 MODEL_VERIFY，所以不另列。
 *
 * @param {{models?:Record<string,string>, suites:string[], withSimilar?:boolean}} opts
 *        withSimilar：rerecord 的 --no-similar 關掉時，e2e 不錄 dedup1 的向量
 * @returns {{models:object, uses:Array<{key:string, spec:string}>, gemini:Array<{key:string, spec:string}>,
 *            ollama:string[], needGeminiKey:boolean, needOcr:boolean, local:boolean}}
 */
function recordingPlan({ models = {}, suites, withSimilar = true }) {
    const eff = effectiveModels(models);
    const want = new Set(suites);
    const uses = [];
    if (LLM_SUITES.some(s => want.has(s))) {
        uses.push({ key: 'MODEL_EXTRACT', spec: eff.MODEL_EXTRACT });
        uses.push({ key: 'MODEL_VERIFY', spec: eff.MODEL_VERIFY });
    }
    if (want.has('nlq')) uses.push({ key: 'MODEL_NLQ', spec: eff.MODEL_NLQ });
    const embedSuites = EMBED_SUITES.filter(s => s !== 'e2e' || withSimilar);
    if (embedSuites.some(s => want.has(s))) uses.push({ key: 'EMBED_MODEL', spec: eff.EMBED_MODEL });

    const gemini = uses.filter(u => vendorOf(u.spec) === 'gemini');
    const ollama = [...new Set(uses.filter(u => vendorOf(u.spec) === 'ollama').map(u => modelIdOf(u.spec)))];
    // 拆題只在 pipeline（e2e 由 pipeline 那一步順帶錄）；本機路徑且 OCR_ENGINE=paddle 才需要 PaddleOCR
    const extractRuns = want.has('pipeline') || want.has('e2e');
    const needOcr = extractRuns && vendorOf(eff.MODEL_EXTRACT) === 'ollama' && eff.OCR_ENGINE === 'paddle';
    return { models: eff, uses, gemini, ollama, needGeminiKey: gemini.length > 0, needOcr, local: ollama.length > 0 };
}

/**
 * 拆題或驗算走本機（決定盤點表印時間還是費用）。
 * @param {Record<string,string>} [models] readCiModels() 的回傳
 * @returns {boolean}
 */
function isLocalRun(models = {}) {
    const eff = effectiveModels(models);
    return vendorOf(eff.MODEL_EXTRACT) === 'ollama' || vendorOf(eff.MODEL_VERIFY) === 'ollama';
}

/**
 * 錄製子行程要多帶的環境（本機長呼叫）。只影響逾時，不影響 cassette 的鍵。純函式。
 * @param {ReturnType<typeof recordingPlan>} plan
 * @returns {Record<string,string>}
 */
function localRecordEnv(plan) {
    const out = {};
    if (!plan || !plan.local) return out;
    const m = plan.models;
    if (vendorOf(m.MODEL_EXTRACT) === 'ollama' || vendorOf(m.MODEL_VERIFY) === 'ollama') {
        out.JOB_NODE_TIMEOUT_MS = String(LOCAL_NODE_TIMEOUT_MS);
    }
    if (vendorOf(m.MODEL_NLQ) === 'ollama') out.NLQ_TIMEOUT_MS = String(LOCAL_NLQ_TIMEOUT_MS);
    return out;
}

// ───────────────────────── Ollama ─────────────────────────

/**
 * OLLAMA_HOST → 用戶端要連的網址。沒寫 scheme 補 http://、沒寫埠補 11434（Ollama 自己的慣例）；
 * 伺服器端常見的 0.0.0.0（聽全部介面）在用戶端改連 127.0.0.1。
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {{url:string, local:boolean, error?:string}}
 */
function ollamaHost(env = process.env) {
    let raw = String(env.OLLAMA_HOST || '').trim() || LOCAL_DEFAULTS.OLLAMA_HOST;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
    let url;
    try {
        url = new URL(raw);
    } catch (err) {
        return { url: raw, local: false, error: `OLLAMA_HOST 不是合法的網址：${raw}` };
    }
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    if (!url.port) url.port = '11434';
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    return { url: url.origin, local };
}

/**
 * 已安裝的模型名單裡有沒有這個 ID（沒寫 tag 的 ID 視同 :latest；不分大小寫）。
 * @param {string[]} installed
 * @param {string} id
 * @returns {boolean}
 */
function hasModel(installed, id) {
    const want = String(id).toLowerCase();
    const names = installed.map(n => String(n).toLowerCase());
    return names.includes(want) || (!want.includes(':') && names.includes(`${want}:latest`));
}

/**
 * 錄前檢查：Ollama 連得上、需要的模型都已下載。
 * @param {object} opts
 * @param {string} opts.host         ollamaHost().url
 * @param {string[]} opts.models     需要的裸 ID（recordingPlan().ollama）
 * @param {Function} [opts.fetchImpl] 預設 globalThis.fetch（測試注入）
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<{ok:boolean, reachable:boolean, installed:string[], missing:string[], error:string|null}>}
 */
async function checkOllama({ host, models = [], fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
    const fail = (reachable, error, installed = []) => ({ ok: false, reachable, installed, missing: models.slice(), error });
    let res;
    try {
        res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        const why = (err && err.cause && err.cause.code) || (err && err.name === 'TimeoutError' ? '逾時' : (err && err.message) || String(err));
        return fail(false, `連不上 Ollama（${host}，${why}）`);
    }
    if (!res.ok) return fail(true, `Ollama 的 /api/tags 回 HTTP ${res.status}`);
    let body;
    try {
        body = await res.json();
    } catch (err) {
        return fail(true, `Ollama 的 /api/tags 回傳的不是 JSON（${host} 上跑的真的是 Ollama 嗎？）`);
    }
    const installed = (Array.isArray(body && body.models) ? body.models : []).map(m => m && (m.name || m.model)).filter(Boolean);
    const missing = models.filter(id => !hasModel(installed, id));
    return {
        ok: missing.length === 0,
        reachable: true,
        installed,
        missing,
        error: missing.length ? `Ollama 還沒有這 ${missing.length} 個模型：${missing.join('、')}` : null
    };
}

/**
 * checkOllama() 沒過時給 Owner 看的處置步驟。純函式。
 * @param {{reachable:boolean, missing:string[]}} result
 * @param {string} host
 * @returns {string[]}
 */
function ollamaAdvice(result, host) {
    if (!result.reachable) {
        return [
            `Ollama 沒有在執行，或不在 ${host}。請先開啟 Ollama（Windows：開始選單 → Ollama，工作列右下角出現羊駝圖示），`,
            '  還沒安裝的話：到 https://ollama.com/download 下載安裝，再雙擊 exam_pro\\scripts\\windows\\setup_local_ai.bat。',
            '  .env 若設了 OLLAMA_HOST，確認它指向 Ollama 實際的位址（本機模式只該是 127.0.0.1／localhost）。'
        ];
    }
    return [
        '請先下載缺的模型（開發期要連網，之後執行期不再連外）：',
        ...result.missing.map(id => `  ollama pull ${id}`),
        '  或直接雙擊 exam_pro\\scripts\\windows\\setup_local_ai.bat（會一次下載三個模型並安裝 OCR）。'
    ];
}

// ───────────────────────── PaddleOCR ─────────────────────────

/** ocr_service/ocr_pdf.py 的絕對路徑（L2 的 CLI） */
const OCR_SCRIPT = path.join(APP_DIR, 'ocr_service', 'ocr_pdf.py');

/**
 * 跑 ocr_pdf.py 的 Python（第 2 條 OCR_PYTHON）。沒設時是 ocr_service/.venv 裡的那一支；
 * 設了相對路徑以 exam_pro/ 為基準；只寫指令名（例如 python）時原樣交給作業系統找。
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @param {string} [platform]
 * @returns {string}
 */
function ocrPython(env = process.env, platform = process.platform) {
    const raw = String(env.OCR_PYTHON || '').trim();
    if (raw) {
        if (!/[\\/]/.test(raw)) return raw;
        return path.isAbsolute(raw) ? raw : path.resolve(APP_DIR, raw);
    }
    return platform === 'win32'
        ? path.join(APP_DIR, 'ocr_service', '.venv', 'Scripts', 'python.exe')
        : path.join(APP_DIR, 'ocr_service', '.venv', 'bin', 'python');
}

/**
 * 從 --selftest 的 stdout 撈出 JSON（取最後一行像 JSON 的；整段是多行 JSON 也接受）。純函式。
 * @param {string} stdout
 * @returns {object|null}
 */
function parseSelftest(stdout) {
    const text = String(stdout || '');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].startsWith('{')) continue;
        try { return JSON.parse(lines[i]); } catch (err) { /* 多行 JSON 的最後一行，往下試整段 */ }
    }
    try { return JSON.parse(text.trim()); } catch (err) { return null; }
}

/** 最後幾行（錯誤訊息用） */
function tailLines(text, n = 15) {
    return String(text || '').split(/\r?\n/).filter(l => l.trim()).slice(-n);
}

/**
 * 錄前檢查：`<OCR_PYTHON> ocr_service/ocr_pdf.py --selftest` 通過（套件與模型都已就緒，執行期不下載）。
 * @param {object} opts
 * @param {string} opts.python              ocrPython()
 * @param {string} [opts.script]            預設 ocr_service/ocr_pdf.py
 * @param {Function} [opts.execFileImpl]    預設 child_process.execFile（測試注入）
 * @param {(p:string)=>boolean} [opts.existsImpl]
 * @param {number} [opts.timeoutMs=600000]  第一次載入 PaddleOCR 模型在 CPU 上要一段時間
 * @returns {Promise<{ok:boolean, engineVersion?:string|null, error?:string, detail?:string[]}>}
 */
function checkOcr({ python, script = OCR_SCRIPT, execFileImpl = execFile, existsImpl = fs.existsSync, timeoutMs = 600_000 }) {
    if (!existsImpl(script)) {
        return Promise.resolve({ ok: false, error: `找不到 ${path.relative(APP_DIR, script).split(path.sep).join('/')}（本機 OCR 服務還沒裝進這個分支？）` });
    }
    if (path.isAbsolute(python) && !existsImpl(python)) {
        return Promise.resolve({ ok: false, error: `找不到 OCR 用的 Python：${python}` });
    }
    return new Promise((resolve) => {
        execFileImpl(python, [script, '--selftest'], {
            cwd: APP_DIR,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        }, (err, stdout, stderr) => {
            if (err) {
                const why = err.code === 'ENOENT' ? `找不到 Python「${python}」`
                    : err.killed ? `逾時（${Math.round(timeoutMs / 1000)} 秒）`
                        : `結束碼 ${err.code}`;
                resolve({ ok: false, error: `ocr_pdf.py --selftest 失敗：${why}`, detail: tailLines(stderr || stdout) });
                return;
            }
            const parsed = parseSelftest(stdout);
            if (!parsed || parsed.ok !== true) {
                resolve({ ok: false, error: 'ocr_pdf.py --selftest 沒有印出 {"ok": true}', detail: tailLines(stdout) });
                return;
            }
            resolve({ ok: true, engineVersion: parsed.engine_version || null });
        });
    });
}

/**
 * checkOcr() 沒過時的處置步驟。純函式。
 * @param {string} python
 * @returns {string[]}
 */
function ocrAdvice(python) {
    return [
        '本機拆題要用 PaddleOCR 與視覺模型交叉驗證（docs/local-mode.md 第 0 條），錄 pipeline 之前 OCR 必須就緒：',
        '  雙擊 exam_pro\\scripts\\windows\\setup_local_ai.bat（建立 ocr_service\\.venv、安裝套件、下載 OCR 模型、自我檢查），',
        `  或確認 .env 的 OCR_PYTHON（目前用的是 ${python}）。單獨重跑檢查：npm run ocr:selftest。`,
        '  log 在 exam_pro\\data\\local_ai\\。'
    ];
}

// ───────────────────────── 預估時間 ─────────────────────────

/**
 * 每次呼叫的預設秒數（保守粗估，未經本機實測；見檔頭）。
 * 依據（i5-8265U、8B Q4：生成約 3 token/秒、讀 prompt 約 15 token/秒；token 數取既有 Gemini cassette 的平均）：
 *   classify  prompt≈1.9k、輸出≈0.1k、不思考                          ≈170 秒 → 240
 *   lint／verify  thinkingBudget>0 → think:true，思考≈1–2k token         ≈400–700 秒 → 480／720
 *   nlq       prompt≈0.6k、輸出≈50                                     ≈60 秒 → 120
 *   variant   prompt≈1.2k、輸出≈0.3k、不思考                            ≈170 秒 → 300
 *   ocr       PaddleOCR（版面＋文字＋公式）每頁約 1–2 分鐘，一塊 2 頁      → 300
 *   extract_vision  每頁圖片約 1–2.5k token（視覺編碼更慢）＋輸出≈2k token  → 1800
 *   extract_ocr     prompt≈3.5k、輸出≈2k                                → 1200
 *   extract   舊的 Gemini 拆題 agent（本機路徑不呼叫；只出現在上限的孤兒 cassette） → 1800
 */
const SEC_PER_CALL = Object.freeze({
    ocr: 300, extract_vision: 1800, extract_ocr: 1200, extract: 1800,
    classify: 240, lint: 480, verify: 720, nlq: 120, variant: 300
});
/** 沒列在上表的 agent */
const DEFAULT_SEC_PER_CALL = 600;
/** 每一段文字的向量（0.6B 模型，CPU） */
const DEFAULT_SEC_PER_EMBED = 1;
/** 本機拆題一塊的三步（第 4 條第 3 點）：前一步 miss 時，後面幾步這一輪看不到 */
const LOCAL_EXTRACT_CHAIN = Object.freeze(['ocr', 'extract_vision', 'extract_ocr']);

function positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 某個 agent 一次呼叫的秒數（含 RERECORD_TIME_SCALE 倍率）。
 * @param {string} agent
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {number}
 */
function secPerCall(agent, env = process.env) {
    const scale = positiveNumber(env.RERECORD_TIME_SCALE) || 1;
    const own = positiveNumber(env[`RERECORD_SEC_PER_CALL_${String(agent).toUpperCase()}`]);
    if (own) return own;   // 單一 agent 的實測值不再乘倍率
    return (SEC_PER_CALL[agent] || DEFAULT_SEC_PER_CALL) * scale;
}

/**
 * 每一段文字向量的秒數。
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {number}
 */
function secPerEmbed(env = process.env) {
    const scale = positiveNumber(env.RERECORD_TIME_SCALE) || 1;
    return positiveNumber(env.RERECORD_SEC_PER_EMBED) || DEFAULT_SEC_PER_EMBED * scale;
}

/**
 * 盤點摘要（cassetteAudit.summarize() 的回傳）→ 本機錄製的預估時間。純函式。
 *
 * 下限＝這一輪回放看得到的呼叫（錄製模式會把每一次都真的跑一次，所以是「命中＋缺」）；
 * 上限再加上：①沒被讀到、也不是某次 miss 舊版的 cassette（被 miss 擋住的下游多半在這裡，與費用估計同一套規則）；
 *            ②本機拆題一塊的三步裡，miss 那一步之後的幾步（這一輪看不到，也沒有舊 cassette 可以對）。
 * 向量：第 1 步補 fixture 題缺的，加上 nlq／variant／e2e 在 EMBED_MODE=record 下每一段都會重算。
 *
 * @param {object} summary
 * @param {{env?:object}} [opts]
 * @returns {{lowerSec:number, upperSec:number, embedSec:number, bySuite:Record<string,number>, calls:Record<string,number>}}
 */
function estimateLocalTime(summary, { env = process.env } = {}) {
    const bySuite = {};
    const calls = {};
    let lower = 0;
    let unseen = 0;
    let embedTexts = (summary.embeddings && summary.embeddings.missing) || 0;

    for (const [name, s] of Object.entries(summary.suites || {})) {
        let sec = 0;
        if (name !== 'e2e') {
            for (const [agent, c] of Object.entries(s.byAgent || {})) {
                const n = (c.hits || 0) + (c.misses || 0);
                calls[agent] = (calls[agent] || 0) + n;
                sec += n * secPerCall(agent, env);
            }
            // 本機拆題鏈：某一步 miss，同一塊後面的步驟這一輪看不到
            for (const key of s.missKeys || []) {
                const agent = key.split('/')[0];
                const at = LOCAL_EXTRACT_CHAIN.indexOf(agent);
                if (at === -1) continue;
                for (const later of LOCAL_EXTRACT_CHAIN.slice(at + 1)) unseen += secPerCall(later, env);
            }
            lower += sec;
        }
        if (['nlq', 'variant', 'e2e'].includes(name) && s.embed) {
            const n = (s.embed.hits || 0) + (s.embed.misses || 0);
            embedTexts += n;
            sec += n * secPerEmbed(env);
        }
        bySuite[name] = sec;
    }
    let downstream = 0;
    for (const u of summary.unhit || []) if (!u.previousVersion) downstream += secPerCall(u.agent, env);

    const embedSec = embedTexts * secPerEmbed(env);
    return { lowerSec: lower + embedSec, upperSec: lower + embedSec + downstream + unseen, embedSec, bySuite, calls };
}

/**
 * 秒數 → 「約 3 小時 20 分」這種給人看的長度。純函式。
 * @param {number} sec
 * @returns {string}
 */
function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s} 秒`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h} 小時 ${mm} 分` : `${h} 小時`;
}

/**
 * 「每次秒數」一覽（印在盤點表下方，讓 Owner 知道粗估的依據、要覆寫哪個變數）。
 * @param {string[]} agents
 * @param {object} [env]
 * @returns {string}
 */
function describeRates(agents, env = process.env) {
    return agents.map(a => `${a} ${Math.round(secPerCall(a, env))}`).join('、');
}

module.exports = {
    APP_DIR, LOCAL_DEFAULTS, NLQ_CODE_DEFAULT, LOCAL_NODE_TIMEOUT_MS, LOCAL_NLQ_TIMEOUT_MS, LLM_SUITES, EMBED_SUITES,
    OCR_SCRIPT, SEC_PER_CALL, DEFAULT_SEC_PER_CALL, DEFAULT_SEC_PER_EMBED, LOCAL_EXTRACT_CHAIN,
    vendorOf, modelIdOf, embedModelFromEnv, effectiveModels, recordingPlan, isLocalRun, localRecordEnv,
    ollamaHost, hasModel, checkOllama, ollamaAdvice,
    ocrPython, parseSelftest, checkOcr, ocrAdvice,
    secPerCall, secPerEmbed, estimateLocalTime, formatDuration, describeRates
};
