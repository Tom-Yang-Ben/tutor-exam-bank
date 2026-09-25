// ─────────────────────────────────────────────────────────────
// eval/tools/local_perf_report.js — 本機效能實測報告（npm run perf:local；使用說明在 docs/local-mode.md 第 10.10 條）
//
// 給 Owner 在本機重錄 cassette（docs/local-mode.md 第 10.7 條）之後統計「實際多快」：
// 第 10.5 條的速度表是依硬體規格推的粗估，Owner 決策單 B18 定的是「上傳幾份卷後再看」拆題頁數與逾時。
//
//   npm run perf:local                                     統計 eval/cassettes 裡本機模型錄的 cassette
//   npm run perf:local -- --log data/local_ai/record_20260926_010203.log
//                                                          另外列出重錄每一步（suite）的總耗時
//   npm run perf:local -- --since 2026-09-26 --out data/local_ai/perf.md
//
// 只讀既有檔案：不呼叫任何模型、不連網、不改 .env 或任何設定（建議只是數字與理由）。
//
// 資料來源：
//   - cassette（<dir>/<agent>/<key>.json）：meta.agent／model／kind／recorded_at，request.parts（圖片張數＝頁數）
//     與 cacheKeyParts，response.latencyMs 與 response.usage（tokenIn／tokenOut／tokenThinking）。
//     services/llm/index.js 與 services/ocr/index.js 在 LLM_MODE=record 時寫的；meta.model 是裸 ID（qwen3:8b），
//     OCR 是 paddleocr@<版本>。
//   - record log（data/local_ai/record_*.log；scripts/windows/record_local.bat 經 eval/tools/tee_run.js 寫的）：
//     eval/tools/rerecord_all.js 的「══ n/N 標籤 ══」段落標頭與「  → 結束碼 x，N 秒」，
//     tee_run.js 的「[時間] > 指令」與「[時間] 結束碼 x，N 秒」。
//
// 限制（報告開頭也會印）：
//   - latencyMs 是牆鐘時間：從呼叫進入 services/llm（或 services/ocr）起算，含等併發槽（OLLAMA_CONCURRENCY）、
//     模型載入與讀 prompt；輸出速度＝(tokenOut＋tokenThinking)／秒，分母含讀 prompt，所以比純生成速度低。
//     Ollama 的 tokenOut＝eval_count（思考與回覆合計），tokenThinking 恆為 0（services/llm/ollama.js）。
//   - 逾時或失敗的呼叫不會留下 cassette：只看得到成功的呼叫（倖存者偏差）；逾時要看 log。
//   - 正式上傳（LLM_MODE=live）不寫 cassette：那一部分看 npm run report:jobs（job_events 的各節點 p50／p95）。
//   - 重錄時 JOB_NODE_TIMEOUT_MS 固定是 localMode.LOCAL_NODE_TIMEOUT_MS（不讀 .env）；節點建議超過它時報告會提醒。
//
// 建議的規則（RULES；報告裡逐條寫出依據）：
//   - 逾時安全值＝max(3 × p90, 2 × max)，無條件進位到整分鐘。
//       OLLAMA_TIMEOUT_MS：本機 LLM 各 agent 的安全值取最大；OCR_TIMEOUT_MS：ocr 的安全值；
//       JOB_NODE_TIMEOUT_MS：一個節點內依序呼叫的總和——拆題一塊＝ocr＋extract_vision＋extract_ocr
//       （各步 p90 相加、max 相加，保守），驗算最多採樣 2 次，classify／lint／variant 各一次；取最大。
//   - RERECORD_TIME_SCALE＝同一批呼叫的實測秒數合計 ÷ eval/lib/localMode.js 的 SEC_PER_CALL 合計；
//     各 agent 的倍率相差超過 2 倍時，改建議 RERECORD_SEC_PER_CALL_<AGENT>＝實測平均秒數。
//   - 每塊頁數（JOB_PDF_CHUNK_PAGES）：依每頁秒數（extract_vision 看圖片張數；ocr 看頁數；extract_ocr 對同一塊的
//     extract_vision）線性外推，在「目前的」逾時與 OLLAMA_NUM_CTX 之下，一塊的安全值都放得下的最大頁數（上限 10）。
//     固定開銷（模型載入、系統提示詞）也按頁攤：推到比錄製時多的頁數偏保守，推到比錄製時少的頁數會低估
//     （固定開銷不會跟著頁數減半）——報告在這種情況另外提醒；建議 0 頁時列出實際錄到的每塊最長時間。
//   - 「樣本少」＝少於 RULES.MIN_SAMPLES（10）支：nearest-rank 下 n ≤ 9 時 p90 就是最大值。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const local = require('../lib/localMode');
const { stamp } = require('./tee_run');

const APP_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_CASSETTE_DIR = path.join(APP_DIR, 'eval', 'cassettes');

/** 建議的規則（改這裡＝改報告的建議；單元測試釘住） */
const RULES = Object.freeze({
    P90_FACTOR: 3,              // 逾時至少是 p90 的 3 倍
    MAX_FACTOR: 2,              // 也至少是 max 的 2 倍
    ROUND_MS: 60_000,           // 無條件進位到整分鐘
    MIN_SAMPLES: 10,            // nearest-rank 下 n ≤ 9 時 ceil(0.9n)＝n，p90 就是 max；少於 10 支標「樣本少：p90 等於最大值」
    MAX_CHUNK_PAGES: 10,        // 每塊頁數的建議上限
    VERIFY_MAX_SAMPLES: 2,      // agents/verify.js 的 MAX_SAMPLES：uncertain 時同一個節點再採樣一次
    SCALE_SPREAD: 2,            // 各 agent 的「實測／粗估」相差超過這個倍數，改建議個別的 RERECORD_SEC_PER_CALL_<AGENT>
    OVERLAP_TOLERANCE_MS: 1_000 // 兩支 cassette 的呼叫時間重疊超過 1 秒才算並行
});

/** 支數少於 RULES.MIN_SAMPLES 時標在支數旁邊的字 */
const LOW_SAMPLE_LABEL = '樣本少：p90 等於最大值';

/**
 * 拆題模型是 ollama 時這幾個設定的程式預設（docs/local-mode.md 第 2 條）。
 * 來源：services/llm/ollama.js 的 DEFAULT_TIMEOUT_MS／DEFAULT_NUM_CTX、services/ocr/index.js 的 DEFAULT_TIMEOUT_MS、
 * workers/jobRunner.js 的 LOCAL_NODE_TIMEOUT_MS／LOCAL_PDF_CHUNK_PAGES（test/unit/localPerfReport.test.js 釘住兩邊一致）。
 */
const SETTING_DEFAULTS = Object.freeze({
    OLLAMA_TIMEOUT_MS: 1_800_000,
    OCR_TIMEOUT_MS: 1_800_000,
    JOB_NODE_TIMEOUT_MS: local.LOCAL_NODE_TIMEOUT_MS,
    JOB_PDF_CHUNK_PAGES: 2,
    OLLAMA_NUM_CTX: 16_384
});

const VENDOR_CHOICES = Object.freeze(['ollama', 'gemini', 'all']);
/** --vendor ollama（預設）＝本機模式：Ollama 模型，加上同一條本機拆題鏈上的 PaddleOCR */
const LOCAL_VENDORS = Object.freeze(['ollama', 'paddleocr']);
/** 表格的排列順序（本機拆題鏈在前；其他 agent 依字母排在後面） */
const AGENT_ORDER = Object.freeze(['ocr', 'extract_vision', 'extract_ocr', 'classify', 'lint', 'verify', 'variant', 'nlq']);
/** 一個拆題節點（一塊）依序呼叫的三步（agents/extract.js 的 runLocal；workers/jobRunner.js 一塊一個節點） */
const EXTRACT_CHAIN = local.LOCAL_EXTRACT_CHAIN;
/** 一次呼叫就是一個節點的 agent（驗算另計：最多採樣 RULES.VERIFY_MAX_SAMPLES 次） */
const SINGLE_CALL_NODES = Object.freeze(['classify', 'lint', 'variant']);

/**
 * rerecord_all.js 的錄製步驟標籤（recordSteps() 的 label）開頭 → 步驟名。
 * 單元測試逐一比對 recordSteps() 的每一步，改了標籤這裡沒跟上就紅。
 */
const STEP_LABEL_PREFIXES = Object.freeze([
    ['embeddings', 'fixture 題缺的向量'],
    ['classify', 'classify suite'],
    ['nlq', 'nlq suite'],
    ['variant', 'variant suite'],
    ['pipeline', 'pipeline'],
    ['e2e-similar', 'e2e 的 dedup1 向量']
]);

const USAGE = `用法：npm run perf:local -- [選項]

  --cassettes <目錄>   cassette 目錄（預設 eval/cassettes）
  --log <檔案>         record_local.bat 寫的 log（data/local_ai/record_*.log）；可以給好幾次
  --since <時間>       只算這之後錄的 cassette（meta.recorded_at，沒有就用檔案修改時間）。
                       例：2026-09-26（當天 0 點，本機時區）或 2026-09-26T08:00
  --vendor <名稱>      ollama（預設：本機模式＝Ollama 模型＋PaddleOCR）、gemini、all
  --out <檔案>         報告另存成 Markdown 檔（畫面上照樣印）
  -h, --help           顯示這段說明

只讀檔案、不呼叫任何模型、不改任何設定；最後的建議只是數字與理由，要不要改 .env 由你決定。`;

// ───────────────────────── 參數 ─────────────────────────

/**
 * --since 的值 → Date。只寫日期時是當天 0 點（本機時區）；其餘交給 Date（不帶時區的日期時間也是本機時區）。
 * @param {string} text
 * @returns {Date}
 */
function parseSince(text) {
    const s = String(text ?? '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
    if (!s || Number.isNaN(d.getTime())) {
        throw new Error(`--since 的「${text}」不是合法的時間（例：2026-09-26 或 2026-09-26T08:00）`);
    }
    return d;
}

/**
 * @param {string[]} argv
 * @param {{cwd?:string}} [opts] 相對路徑的基準（預設 process.cwd()；npm run 時就是 exam_pro/）
 * @returns {{cassettes:string, logs:string[], since:Date|null, vendor:string, out:string|null, help:boolean}}
 */
function parseArgs(argv, { cwd = process.cwd() } = {}) {
    const args = { cassettes: DEFAULT_CASSETTE_DIR, logs: [], since: null, vendor: 'ollama', out: null, help: false };
    const value = (i, flag) => {
        const v = argv[i];
        if (v === undefined || v === '' || /^--?[a-z]/i.test(v)) throw new Error(`${flag} 後面要接一個值\n\n${USAGE}`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--cassettes': args.cassettes = path.resolve(cwd, value(++i, a)); break;
            case '--log': args.logs.push(path.resolve(cwd, value(++i, a))); break;
            case '--since': args.since = parseSince(value(++i, a)); break;
            case '--vendor': {
                const v = String(value(++i, a)).trim().toLowerCase();
                if (!VENDOR_CHOICES.includes(v)) throw new Error(`--vendor 只能是 ${VENDOR_CHOICES.join('／')}，收到「${v}」`);
                args.vendor = v;
                break;
            }
            case '--out': args.out = path.resolve(cwd, value(++i, a)); break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    return args;
}

// ───────────────────────── 讀 cassette ─────────────────────────

/**
 * cassette 的供應商。meta.model 是裸 ID（services/llm/index.js），所以看 ID 的樣子：
 *   OCR（meta.kind='ocr'、agent ocr 或 paddleocr@版本）→ paddleocr；
 *   gemini-*／gemma-*／learnlm-*（Gemini API 的命名）→ gemini；
 *   其餘 → ollama（services/llm 只有 gemini 與 ollama 兩個 adapter 會寫 cassette）；沒有模型 → unknown。純函式。
 * @param {{agent?:string, model?:string|null, kind?:string}} meta
 * @returns {'paddleocr'|'gemini'|'ollama'|'unknown'}
 */
function vendorOfCassette({ agent, model, kind } = {}) {
    const m = String(model ?? '').trim();
    if (kind === 'ocr' || agent === 'ocr' || /^paddleocr@/i.test(m)) return 'paddleocr';
    if (!m) return 'unknown';
    if (/^(models\/)?(gemini|gemma-|learnlm)/i.test(m)) return 'gemini';
    return 'ollama';
}

/**
 * 一支 cassette 的內容 → 統計要用的欄位。純函式。
 * 頁數：OCR 看 response.pages（或 cacheKeyParts 的 fromPage～toPage）；LLM 看 request.parts 裡的圖片張數
 * （本機拆題一頁一張，agents/extract.js 的 runLocal）。extract_ocr 沒有圖片，之後由 fillChunkPages 對同一塊補上。
 * @param {object} doc
 * @param {{file?:string|null, dirAgent?:string|null, mtimeMs?:number|null}} [where]
 */
function toEntry(doc, { file = null, dirAgent = null, mtimeMs = null } = {}) {
    const meta = (doc && doc.meta) || {};
    const req = (doc && doc.request) || {};
    const res = (doc && doc.response) || {};
    const agent = String(meta.agent || dirAgent || 'unknown');
    const model = meta.model == null ? null : String(meta.model);
    const t = Date.parse(meta.recorded_at);
    const hasMetaTime = Number.isFinite(t);
    const recordedAt = hasMetaTime ? t : (Number.isFinite(mtimeMs) ? mtimeMs : null);
    const lat = Number(res.latencyMs);
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const usage = res.usage && typeof res.usage === 'object'
        ? { tokenIn: num(res.usage.tokenIn), tokenOut: num(res.usage.tokenOut), tokenThinking: num(res.usage.tokenThinking) }
        : null;
    const parts = Array.isArray(req.parts) ? req.parts : [];
    const images = parts.filter(p => p && p.kind === 'image').length;
    const ckp = (req.cacheKeyParts && typeof req.cacheKeyParts === 'object') ? req.cacheKeyParts : {};
    let pages = null;
    let pagesFrom = null;
    if (Array.isArray(res.pages) && res.pages.length > 0) {
        pages = res.pages.length; pagesFrom = 'ocr';
    } else if (Number.isInteger(ckp.fromPage) && Number.isInteger(ckp.toPage) && ckp.toPage >= ckp.fromPage) {
        pages = ckp.toPage - ckp.fromPage + 1; pagesFrom = 'ocr';
    } else if (images > 0) {
        pages = images; pagesFrom = 'images';
    }
    return {
        agent,
        model,
        vendor: vendorOfCassette({ agent, model, kind: meta.kind }),
        file,
        recordedAt,
        timeSource: hasMetaTime ? 'meta' : (recordedAt === null ? null : 'mtime'),
        latencyMs: Number.isFinite(lat) && lat > 0 ? lat : null,
        usage,
        pages,
        pagesFrom,
        chunkRef: ckp.pdfSha256 && ckp.chunkNo != null ? `${ckp.pdfSha256}#${ckp.chunkNo}` : null
    };
}

/**
 * extract_ocr（化學版 extract_ocr_chem 同理）沒有圖片：對同一塊（pdfSha256＋chunkNo）的 extract_vision 取頁數。會改 entries。
 * @param {ReturnType<typeof toEntry>[]} entries
 */
function fillChunkPages(entries) {
    const byChunk = new Map();
    for (const e of entries) {
        if (e.pagesFrom === 'images' && e.chunkRef && /^extract_vision/.test(e.agent)) byChunk.set(e.chunkRef, e.pages);
    }
    for (const e of entries) {
        if (e.pages === null && e.chunkRef && /^extract_ocr/.test(e.agent) && byChunk.has(e.chunkRef)) {
            e.pages = byChunk.get(e.chunkRef);
            e.pagesFrom = 'chunk';
        }
    }
    return entries;
}

/**
 * 讀整個 cassette 目錄（<dir>/<agent>/*.json；化學、tutor 等目錄也讀——速度就是速度）。
 * @param {string} dir
 * @returns {{dir:string, entries:ReturnType<typeof toEntry>[], broken:Array<{file:string, error:string}>}}
 */
function readCassettes(dir) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`找不到 cassette 目錄：${root}`);
    const entries = [];
    const broken = [];
    for (const name of fs.readdirSync(root).sort()) {
        const agentDir = path.join(root, name);
        let st;
        try { st = fs.statSync(agentDir); } catch (err) { continue; }
        if (!st.isDirectory()) continue;
        for (const f of fs.readdirSync(agentDir).filter(x => x.endsWith('.json')).sort()) {
            const file = path.join(agentDir, f);
            let doc;
            try {
                doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (err) {
                broken.push({ file, error: String(err.message).split('\n')[0] });
                continue;
            }
            entries.push(toEntry(doc, { file, dirAgent: name, mtimeMs: fs.statSync(file).mtimeMs }));
        }
    }
    fillChunkPages(entries);
    return { dir: root, entries, broken };
}

/** @param {string} vendor @param {string} want */
function vendorMatches(vendor, want) {
    if (want === 'all') return true;
    if (want === 'ollama') return LOCAL_VENDORS.includes(vendor);
    return vendor === want;
}

/**
 * 依 --vendor、--since 篩選；沒有 latencyMs 的不進統計。純函式。
 * @param {ReturnType<typeof toEntry>[]} entries
 * @param {{vendor?:string, since?:Date|null}} [opts]
 */
function selectEntries(entries, { vendor = 'ollama', since = null } = {}) {
    const skipped = { vendor: 0, byVendor: {}, since: 0, noLatency: 0 };
    const selected = [];
    const sinceMs = since ? since.getTime() : null;
    for (const e of entries) {
        if (!vendorMatches(e.vendor, vendor)) {
            skipped.vendor++;
            skipped.byVendor[e.vendor] = (skipped.byVendor[e.vendor] || 0) + 1;
            continue;
        }
        if (sinceMs !== null && !(e.recordedAt !== null && e.recordedAt >= sinceMs)) { skipped.since++; continue; }
        if (e.latencyMs === null) { skipped.noLatency++; continue; }
        selected.push(e);
    }
    return { selected, skipped };
}

// ───────────────────────── 統計 ─────────────────────────

/**
 * 百分位數（nearest-rank：排序後第 ceil(p/100 × n) 個）。回傳的一定是實際量到的某一個值：
 * 「至少 p% 的呼叫不超過它」。空陣列回 null。純函式。
 * @param {number[]} values
 * @param {number} p 0～100
 * @returns {number|null}
 */
function percentile(values, p) {
    const xs = (values || []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const rank = Math.ceil((p / 100) * xs.length);
    return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * 一組 cassette（同一個 agent，或同一個 agent＋模型）的統計。純函式。
 * 輸出速度＝Σ(tokenOut＋tokenThinking) ÷ Σ秒數（以時間加權；只算有 usage 的呼叫）。
 * 每頁秒數＝Σ秒數 ÷ Σ頁數（只算知道頁數的呼叫）；p90 用「每次呼叫的秒數 ÷ 該次頁數」。
 * maxCallPages＝最慢的那一次（maxMs）處理了幾頁（不知道頁數時 null）：報告的「實際錄到的每塊最長」。
 * @param {{agent:string, model:string|null, vendor:string, items:ReturnType<typeof toEntry>[]}} group
 */
function statsOf({ agent, model, vendor, items }) {
    const lat = items.map(e => e.latencyMs);
    const totalMs = sum(lat);
    const slowest = items.reduce((w, e) => (!w || e.latencyMs > w.latencyMs ? e : w), null);
    const withUsage = items.filter(e => e.usage);
    const outTokens = sum(withUsage.map(e => e.usage.tokenOut + e.usage.tokenThinking));
    const usageMs = sum(withUsage.map(e => e.latencyMs));
    const withPages = items.filter(e => Number.isInteger(e.pages) && e.pages > 0);
    let pages = null;
    if (withPages.length) {
        const pageCount = sum(withPages.map(e => e.pages));
        const perPage = withPages.map(e => e.latencyMs / e.pages);
        const tokenPages = withPages.filter(e => e.usage);
        const tokenPageCount = sum(tokenPages.map(e => e.pages));
        pages = {
            calls: withPages.length,
            pages: pageCount,
            avgPages: pageCount / withPages.length,
            secPerPage: sum(withPages.map(e => e.latencyMs)) / pageCount / 1000,
            p90SecPerPage: percentile(perPage, 90) / 1000,
            maxSecPerPage: Math.max(...perPage) / 1000,
            // 每頁 token（輸入＋輸出；含固定的 system／白名單，所以偏保守）：OLLAMA_NUM_CTX 放不放得下
            tokensPerPage: tokenPageCount > 0
                ? sum(tokenPages.map(e => e.usage.tokenIn + e.usage.tokenOut + e.usage.tokenThinking)) / tokenPageCount
                : null
        };
    }
    return {
        agent,
        model,
        vendor,
        n: items.length,
        p50Ms: percentile(lat, 50),
        p90Ms: percentile(lat, 90),
        maxMs: Math.max(...lat),
        maxCallPages: slowest && Number.isInteger(slowest.pages) && slowest.pages > 0 ? slowest.pages : null,
        meanMs: totalMs / items.length,
        totalMs,
        tokensPerSec: withUsage.length && usageMs > 0 && outTokens > 0 ? outTokens / (usageMs / 1000) : null,
        avgTokenIn: withUsage.length ? sum(withUsage.map(e => e.usage.tokenIn)) / withUsage.length : null,
        avgTokenOut: withUsage.length ? outTokens / withUsage.length : null,
        pages
    };
}

function agentRank(agent) {
    const i = AGENT_ORDER.indexOf(agent);
    return i === -1 ? AGENT_ORDER.length : i;
}

/**
 * 依 agent（byModel=true 時再依模型）分組並統計。純函式。
 * @param {ReturnType<typeof toEntry>[]} entries 已篩選、都有 latencyMs
 * @param {{byModel?:boolean}} [opts]
 * @returns {ReturnType<typeof statsOf>[]}
 */
function summarizeGroups(entries, { byModel = true } = {}) {
    const map = new Map();
    for (const e of entries) {
        const k = byModel ? `${e.agent}\u0000${e.model ?? ''}` : e.agent;
        if (!map.has(k)) map.set(k, { agent: e.agent, model: byModel ? e.model : null, vendor: e.vendor, items: [], models: new Set() });
        const g = map.get(k);
        g.items.push(e);
        g.models.add(e.model ?? '');
    }
    return [...map.values()]
        .map(g => ({ ...statsOf(g), models: [...g.models].filter(Boolean).sort() }))
        .sort((a, b) => agentRank(a.agent) - agentRank(b.agent) || a.agent.localeCompare(b.agent) || String(a.model).localeCompare(String(b.model)));
}

/**
 * 呼叫時間（recorded_at 往前推 latencyMs）互相重疊的 cassette 支數。
 * 錄製時 OLLAMA_CONCURRENCY=1、suite 依序跑，正常情況是 0；不是 0 代表有並行呼叫，latency 含排隊時間。純函式。
 * @param {ReturnType<typeof toEntry>[]} entries
 * @param {number} [toleranceMs]
 * @returns {number}
 */
function countOverlaps(entries, toleranceMs = RULES.OVERLAP_TOLERANCE_MS) {
    const iv = entries
        .filter(e => e.timeSource === 'meta' && e.latencyMs)
        .map(e => ({ start: e.recordedAt - e.latencyMs, end: e.recordedAt }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    let maxEnd = -Infinity;
    let n = 0;
    for (const x of iv) {
        if (x.start < maxEnd - toleranceMs) n++;
        maxEnd = Math.max(maxEnd, x.end);
    }
    return n;
}

// ───────────────────────── record log ─────────────────────────

const BANNER_RE = /^══ (\d+)\/(\d+) (.*?)\s*═*\s*$/;
const STEP_END_RE = /^\s*→ 結束碼 (-?\d+)，(\d+) 秒/;
const SUMMARY_RE = /^錄製步驟：(.*)$/;
const SUMMARY_ITEM_RE = /([A-Za-z0-9_-]+)=(-?\d+)（(\d+) 秒）/g;
const CMD_START_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] > (.*)$/;
const CMD_END_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] 結束碼 (-?\d+)(?:（(.*?)）)?，(\d+) 秒\s*$/;
/** 逾時的錯誤訊息（services/llm/ollama.js、services/ocr/index.js、workers/jobRunner.js 的原文） */
const TIMEOUT_RES = Object.freeze([/超過 OLLAMA_TIMEOUT_MS/, /已中止（OCR_TIMEOUT_MS）/, /超過 \d+ ms 未回應/]);

/**
 * 錄製步驟的標籤 → 步驟名（embeddings／classify／nlq／variant／pipeline／e2e-similar）；認不得回 null。純函式。
 * @param {string} label
 * @returns {string|null}
 */
function stepNameOf(label) {
    const s = String(label ?? '').trim();
    for (const [name, prefix] of STEP_LABEL_PREFIXES) if (s.startsWith(prefix)) return name;
    return null;
}

/**
 * 解析 record log。純函式。
 * 一份 log 可以有好幾輪（tee_run.js 是附加寫入）：「n/N」的 n 沒有往前走就當成新的一輪。
 * @param {string} text
 * @returns {{runs:Array<{steps:Array<{index:number,total:number,label:string,name:string|null,exitCode:number|null,sec:number|null}>}>,
 *            commands:Array<{cmd:string, startedAt:string, exitCode:number|null, sec:number|null, why:string|null}>,
 *            timeoutLines:number}}
 */
function parseRecordLog(text) {
    const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const runs = [];
    const commands = [];
    let run = null;
    let timeoutLines = 0;
    for (const line of lines) {
        let m;
        if ((m = line.match(CMD_START_RE))) {
            commands.push({ cmd: m[2].trim(), startedAt: m[1], exitCode: null, sec: null, why: null });
            continue;
        }
        if ((m = line.match(CMD_END_RE))) {
            const open = [...commands].reverse().find(c => c.sec === null);
            if (open) Object.assign(open, { exitCode: Number(m[2]), why: m[3] || null, sec: Number(m[4]) });
            continue;
        }
        if ((m = line.match(BANNER_RE))) {
            const index = Number(m[1]);
            const last = run && run.steps[run.steps.length - 1];
            if (!run || (last && index <= last.index)) { run = { steps: [] }; runs.push(run); }
            run.steps.push({ index, total: Number(m[2]), label: m[3].trim(), name: stepNameOf(m[3]), exitCode: null, sec: null });
            continue;
        }
        if ((m = line.match(STEP_END_RE))) {
            const step = run && [...run.steps].reverse().find(s => s.sec === null);
            if (step) Object.assign(step, { exitCode: Number(m[1]), sec: Number(m[2]) });
            continue;
        }
        if ((m = line.match(SUMMARY_RE)) && run) {
            // 「錄製步驟：embeddings=0（12 秒）、classify=0（3456 秒）」：與段落標頭同一個順序，用來補認不得的名字
            const items = [...m[1].matchAll(SUMMARY_ITEM_RE)];
            items.forEach((it, i) => {
                const step = run.steps[i];
                if (!step) return;
                if (!step.name) step.name = it[1];
                if (step.sec === null) Object.assign(step, { exitCode: Number(it[2]), sec: Number(it[3]) });
            });
            continue;
        }
        if (TIMEOUT_RES.some(re => re.test(line))) timeoutLines++;
    }
    return { runs, commands, timeoutLines };
}

// ───────────────────────── 建議 ─────────────────────────

/**
 * 逾時的安全值：max(P90_FACTOR × p90, MAX_FACTOR × max)，無條件進位到整分鐘。純函式。
 * @param {number} p90Ms
 * @param {number} maxMs
 * @returns {number}
 */
function safeMs(p90Ms, maxMs) {
    const raw = Math.max(RULES.P90_FACTOR * (p90Ms || 0), RULES.MAX_FACTOR * (maxMs || 0));
    return Math.ceil(raw / RULES.ROUND_MS) * RULES.ROUND_MS;
}

/**
 * 目前生效的設定：環境變數（main 會先疊上 exam_pro/.env）明寫的正整數優先，否則是本機預設。純函式。
 * @param {Record<string,string|undefined>} [env]
 * @returns {Record<string, {value:number, source:'.env'|'本機預設'}>}
 */
function currentSettings(env = {}) {
    const out = {};
    for (const [k, def] of Object.entries(SETTING_DEFAULTS)) {
        const n = Number.parseInt(env[k], 10);
        out[k] = Number.isFinite(n) && n > 0 ? { value: n, source: '.env' } : { value: def, source: '本機預設' };
    }
    return out;
}

/**
 * 依各 agent 的統計算建議。只用本機（ollama／paddleocr）的組。純函式。
 * @param {ReturnType<typeof summarizeGroups>} agentStats 本機呼叫的 summarizeGroups(entries, {byModel:false})
 * @param {ReturnType<typeof currentSettings>} settings
 */
function recommend(agentStats, settings) {
    const localStats = agentStats.filter(s => LOCAL_VENDORS.includes(s.vendor));
    const by = new Map(localStats.map(s => [s.agent, s]));
    const lowSample = localStats.filter(s => s.n < RULES.MIN_SAMPLES).map(s => s.agent);

    // 1. OLLAMA_TIMEOUT_MS：本機 LLM 最慢的那個 agent
    let ollamaTimeout = null;
    for (const s of localStats.filter(x => x.vendor === 'ollama')) {
        const need = safeMs(s.p90Ms, s.maxMs);
        if (!ollamaTimeout || need > ollamaTimeout.needMs) ollamaTimeout = { needMs: need, agent: s.agent, p90Ms: s.p90Ms, maxMs: s.maxMs, n: s.n };
    }

    // 2. OCR_TIMEOUT_MS
    const ocr = by.get('ocr');
    const ocrTimeout = ocr ? { needMs: safeMs(ocr.p90Ms, ocr.maxMs), agent: 'ocr', p90Ms: ocr.p90Ms, maxMs: ocr.maxMs, n: ocr.n } : null;

    // 3. JOB_NODE_TIMEOUT_MS：一個節點內依序呼叫的總和，取最大
    const candidates = [];
    const chain = EXTRACT_CHAIN.filter(a => by.has(a));
    if (chain.length) {
        const p90 = sum(chain.map(a => by.get(a).p90Ms));
        const max = sum(chain.map(a => by.get(a).maxMs));
        const missing = EXTRACT_CHAIN.filter(a => !by.has(a));
        candidates.push({
            node: `拆題一塊（${chain.join('＋')}）`,
            p90Ms: p90, maxMs: max, needMs: safeMs(p90, max),
            note: missing.length ? `沒有 ${missing.join('、')} 的資料，這一項偏低` : '各步的 p90、max 分別相加（保守）'
        });
    }
    if (by.has('verify')) {
        const v = by.get('verify');
        const k = RULES.VERIFY_MAX_SAMPLES;
        candidates.push({ node: `驗算（最多採樣 ${k} 次）`, p90Ms: k * v.p90Ms, maxMs: k * v.maxMs, needMs: safeMs(k * v.p90Ms, k * v.maxMs), note: `verify 的 p90、max 各乘 ${k}` });
    }
    for (const a of SINGLE_CALL_NODES) {
        if (!by.has(a)) continue;
        const s = by.get(a);
        candidates.push({ node: a, p90Ms: s.p90Ms, maxMs: s.maxMs, needMs: safeMs(s.p90Ms, s.maxMs), note: '一次呼叫' });
    }
    const worst = candidates.reduce((w, c) => (!w || c.needMs > w.needMs ? c : w), null);
    const nodeTimeout = worst ? { needMs: worst.needMs, node: worst.node, candidates } : null;

    // 4. RERECORD_TIME_SCALE：只算 SEC_PER_CALL 表上有的 agent（rerecord 的預估只估這些）
    let timeScale = null;
    const scaleRows = localStats
        .filter(s => Object.prototype.hasOwnProperty.call(local.SEC_PER_CALL, s.agent))
        .map(s => {
            const estSec = local.SEC_PER_CALL[s.agent];
            return { agent: s.agent, n: s.n, meanSec: s.meanMs / 1000, estSec, ratio: s.meanMs / 1000 / estSec };
        });
    if (scaleRows.length) {
        const measured = sum(scaleRows.map(r => r.meanSec * r.n));
        const estimated = sum(scaleRows.map(r => r.estSec * r.n));
        const ratios = scaleRows.map(r => r.ratio);
        const spread = Math.max(...ratios) / Math.min(...ratios);
        timeScale = {
            scale: Math.max(0.01, Math.round((measured / estimated) * 100) / 100),
            measuredSec: measured,
            estimatedSec: estimated,
            rows: scaleRows,
            spread,
            perAgent: spread > RULES.SCALE_SPREAD
                ? scaleRows.map(r => ({ agent: r.agent, env: `RERECORD_SEC_PER_CALL_${r.agent.toUpperCase()}`, value: Math.max(1, Math.round(r.meanSec)) }))
                : [],
            excluded: localStats.filter(s => !Object.prototype.hasOwnProperty.call(local.SEC_PER_CALL, s.agent)).map(s => s.agent)
        };
    }

    // 5. 每塊頁數：線性外推每頁秒數，在目前的逾時與 num_ctx 下放得下的最大頁數。
    //    固定開銷也按頁攤，所以只有「推到不少於錄製時的頁數」才偏保守；推到比錄製時少的頁數會低估（belowRecorded）。
    let chunkPages = null;
    const vision = by.get('extract_vision');
    if (vision && vision.pages) {
        const perPage = {};   // agent → { safeSec, p90Sec, maxSec, from }
        for (const a of EXTRACT_CHAIN) {
            const s = by.get(a);
            if (!s) continue;
            if (s.pages) {
                perPage[a] = { p90Sec: s.pages.p90SecPerPage, maxSec: s.pages.maxSecPerPage, meanSec: s.pages.secPerPage, from: '實際頁數' };
            } else {
                // 不知道頁數：以 extract_vision 的平均頁數換算（同一批塊）
                const k = vision.pages.avgPages;
                perPage[a] = { p90Sec: s.p90Ms / 1000 / k, maxSec: s.maxMs / 1000 / k, meanSec: s.meanMs / 1000 / k, from: `以 extract_vision 的平均 ${round1(k)} 頁換算` };
            }
            perPage[a].safeSec = Math.max(RULES.P90_FACTOR * perPage[a].p90Sec, RULES.MAX_FACTOR * perPage[a].maxSec);
        }
        const limits = [];
        const cap = (name, limit, per, why) => {
            if (!(per > 0)) return;
            limits.push({ name, maxPages: Math.floor(limit / per), why });
        };
        const chainSafe = sum(Object.values(perPage).map(p => p.safeSec));
        cap('JOB_NODE_TIMEOUT_MS', settings.JOB_NODE_TIMEOUT_MS.value / 1000, chainSafe,
            `一塊（${Object.keys(perPage).join('＋')}）每頁的安全秒數合計 ${round1(chainSafe)} 秒`);
        for (const a of ['extract_vision', 'extract_ocr']) {
            if (perPage[a]) cap('OLLAMA_TIMEOUT_MS', settings.OLLAMA_TIMEOUT_MS.value / 1000, perPage[a].safeSec, `${a} 每頁的安全秒數 ${round1(perPage[a].safeSec)} 秒`);
        }
        if (perPage.ocr) cap('OCR_TIMEOUT_MS', settings.OCR_TIMEOUT_MS.value / 1000, perPage.ocr.safeSec, `ocr 每頁的安全秒數 ${round1(perPage.ocr.safeSec)} 秒`);
        for (const a of ['extract_vision', 'extract_ocr']) {
            const s = by.get(a);
            const tpp = s && s.pages && s.pages.tokensPerPage;
            if (tpp) cap('OLLAMA_NUM_CTX', settings.OLLAMA_NUM_CTX.value, tpp, `${a} 每頁約 ${fmtInt(tpp)} token（輸入＋輸出；固定的提示詞也按頁攤）`);
        }
        const binding = limits.reduce((w, l) => (!w || l.maxPages < w.maxPages ? l : w), null);
        const pages = Math.max(0, Math.min(RULES.MAX_CHUNK_PAGES, binding ? binding.maxPages : RULES.MAX_CHUNK_PAGES));
        const current = settings.JOB_PDF_CHUNK_PAGES.value;
        const recordedAvgPages = vision.pages.avgPages;
        // 實際錄到的每塊最長：各步最慢的那一次（一次呼叫處理一塊）與它的頁數。
        // 各步相加是上限：同一塊不一定每步都最慢（ocr 的 cassette 沒有塊號，無法逐塊對齊）。
        const recordedSteps = EXTRACT_CHAIN.filter(a => by.has(a)).map(a => {
            const s = by.get(a);
            return { agent: a, maxMs: s.maxMs, pages: Number.isInteger(s.maxCallPages) ? s.maxCallPages : null };
        });
        // 報告下結論用到的最少頁數：建議 0 頁時是「1 頁」；調小時是建議值；維持時是目前值
        const lowest = pages === 0 ? 1 : Math.min(pages, current);
        chunkPages = {
            pages, current, perPage, limits, binding, recordedAvgPages,
            recorded: { steps: recordedSteps, sumMaxMs: sum(recordedSteps.map(r => r.maxMs)) },
            belowRecorded: lowest < recordedAvgPages ? { pages: lowest, recordedAvgPages } : null
        };
    }

    return { ollamaTimeout, ocrTimeout, nodeTimeout, timeScale, chunkPages, lowSample };
}

// ───────────────────────── 輸出 ─────────────────────────

function round1(n) { return Math.round(n * 10) / 10; }

/** 整數加千分位；null → — */
function fmtInt(n) {
    return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');
}

/**
 * 毫秒 → 「12.3 秒」「20 分 34 秒」「3 小時 5 分」。純函式。
 * @param {number|null} ms
 * @returns {string}
 */
function fmtDur(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)} 秒`;
    const total = Math.round(s);
    if (total < 60) return `${total} 秒`;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h) return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
    return sec ? `${m} 分 ${sec} 秒` : `${m} 分`;
}

/** 設定值（毫秒）→「1800000（30 分）」 */
function fmtSetting(ms) { return `${ms}（${fmtDur(ms)}）`; }

/** 顯示用路徑：在 exam_pro/ 底下用相對路徑（正斜線） */
function displayPath(p) {
    const rel = path.relative(APP_DIR, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

/** Markdown 表格（格子裡的 | 跳脫掉，才不會把表格切壞） */
function table(header, rows) {
    const cell = (v) => String(v).replace(/\|/g, '\\|');
    return [
        `| ${header.map(cell).join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`,
        ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)
    ].join('\n');
}

/**
 * 組整份報告。
 * @param {{cassettes:string, logs:string[], since:Date|null, vendor:string}} args
 * @param {{env?:object, now?:Date, readFile?:(p:string)=>string}} [opts]
 * @returns {{markdown:string, data:object}}
 */
function buildReport(args, { env = {}, now = new Date(), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
    const inv = readCassettes(args.cassettes);
    const { selected, skipped } = selectEntries(inv.entries, { vendor: args.vendor, since: args.since });
    const groups = summarizeGroups(selected, { byModel: true });
    // 建議只看本機的呼叫（--vendor all 時同一個 agent 可能也有 Gemini 錄的，不能混在一起算）
    const agentStats = summarizeGroups(selected.filter(e => LOCAL_VENDORS.includes(e.vendor)), { byModel: false });
    const settings = currentSettings(env);
    const rec = recommend(agentStats, settings);
    const overlaps = countOverlaps(selected);
    const mtimeCount = selected.filter(e => e.timeSource === 'mtime').length;
    const logs = args.logs.map(file => {
        try {
            return { file, ...parseRecordLog(readFile(file)) };
        } catch (err) {
            return { file, error: err.code === 'ENOENT' ? '找不到這個檔案' : String(err.message).split('\n')[0] };
        }
    });

    const L = [];
    L.push('# 本機效能實測');
    L.push('');
    L.push(`- 產生時間：${stamp(now)}（本機時間）`);
    L.push(`- cassette：\`${displayPath(inv.dir)}\`，共 ${inv.entries.length + inv.broken.length} 支；納入統計 ${selected.length} 支`);
    const vendorText = args.vendor === 'ollama' ? 'ollama（本機模式：Ollama 模型＋PaddleOCR）' : args.vendor;
    L.push(`- 供應商：${vendorText}`);
    const skippedText = [
        skipped.vendor ? `供應商不符 ${skipped.vendor} 支（${Object.entries(skipped.byVendor).map(([k, v]) => `${k} ${v}`).join('、')}）` : null,
        skipped.since ? `--since（${stamp(args.since)}）之前錄的 ${skipped.since} 支` : null,
        skipped.noLatency ? `沒有 latencyMs 的 ${skipped.noLatency} 支` : null,
        inv.broken.length ? `壞掉的 JSON ${inv.broken.length} 支（${inv.broken.slice(0, 3).map(b => displayPath(b.file)).join('、')}${inv.broken.length > 3 ? '…' : ''}）` : null
    ].filter(Boolean);
    if (skippedText.length) L.push(`- 沒算進來：${skippedText.join('；')}`);
    const times = selected.map(e => e.recordedAt).filter(Number.isFinite);
    if (times.length) {
        L.push(`- 錄製時間：${stamp(new Date(Math.min(...times)))} ～ ${stamp(new Date(Math.max(...times)))}` +
            (mtimeCount ? `（其中 ${mtimeCount} 支沒有 recorded_at，用檔案修改時間）` : ''));
    }
    if (args.logs.length) L.push(`- record log：${args.logs.map(f => `\`${displayPath(f)}\``).join('、')}`);
    L.push('');
    L.push('> 怎麼讀：延遲是牆鐘時間（從呼叫進入 `services/llm`／`services/ocr` 到拿到回應，含排隊、模型載入、讀 prompt）。' +
        '輸出速度＝(tokenOut＋tokenThinking)÷秒，分母含讀 prompt 的時間，所以比「純生成速度」低；Ollama 的 tokenOut 已含思考。' +
        '逾時或失敗的呼叫不會留下 cassette，這裡只看得到成功的呼叫。百分位數用 nearest-rank（一定是實際量到的某一次）。');
    if (overlaps > 0) {
        L.push('');
        L.push(`> 注意：有 ${overlaps} 支 cassette 的呼叫時間與別支重疊，錄製時有並行呼叫：它們的延遲含排隊等待，p50／p90 會偏大。`);
    }
    L.push('');

    // 1. 各 agent
    L.push('## 1. 各 agent 的延遲與速度');
    L.push('');
    if (!groups.length) {
        L.push(args.vendor === 'ollama'
            ? '沒有本機模型錄的 cassette。先照 docs/local-mode.md 第 10.7 條以本機模型重錄（`record_local.bat`），或用 `--vendor all` 看全部。'
            : '沒有符合條件的 cassette。');
    } else {
        L.push(table(
            ['agent', '模型', '支數', 'p50', 'p90', 'max', '平均', '輸出 token/秒', '平均輸入 token', '平均輸出 token', '每頁秒數'],
            groups.map(g => [
                `\`${g.agent}\``,
                g.model ? `\`${g.model}\`` : '—',
                `${g.n}${g.n < RULES.MIN_SAMPLES ? `（${LOW_SAMPLE_LABEL}）` : ''}`,
                fmtDur(g.p50Ms), fmtDur(g.p90Ms), fmtDur(g.maxMs), fmtDur(g.meanMs),
                g.tokensPerSec == null ? '—' : g.tokensPerSec.toFixed(1),
                fmtInt(g.avgTokenIn), fmtInt(g.avgTokenOut),
                g.pages ? `${fmtDur(g.pages.secPerPage * 1000)}（${fmtInt(g.pages.pages)} 頁）` : '—'
            ])
        ));
        L.push('');
        L.push(`合計 ${selected.length} 次呼叫、延遲加總 ${fmtDur(sum(selected.map(e => e.latencyMs)))}。` +
            `「${LOW_SAMPLE_LABEL}」＝少於 ${RULES.MIN_SAMPLES} 支：百分位數用 nearest-rank，` +
            `n ≤ ${RULES.MIN_SAMPLES - 1} 時第 ceil(0.9 × n) 支就是最慢的那一支，p90 沒有比 max 多出資訊，只能參考。`);
    }
    L.push('');

    // 2. record log
    L.push('## 2. 重錄各步驟的總耗時（record log）');
    L.push('');
    if (!logs.length) {
        L.push('沒有給 `--log`。要看每個 suite 花了多久，加上 `--log data/local_ai/record_<時間>.log`（`record_local.bat` 寫的）。');
        L.push('');
    }
    for (const log of logs) {
        L.push(`### \`${displayPath(log.file)}\``);
        L.push('');
        if (log.error) { L.push(`讀不到：${log.error}`); L.push(''); continue; }
        if (log.commands.length) {
            L.push(table(['指令', '結束碼', '耗時'], log.commands.map(c => [
                `\`${c.cmd}\``,
                c.exitCode == null ? '（沒有結束紀錄）' : `${c.exitCode}${c.why ? `（${c.why}）` : ''}`,
                c.sec == null ? '—' : fmtDur(c.sec * 1000)
            ])));
            L.push('');
        }
        if (!log.runs.length) {
            L.push('這份 log 裡沒有「══ n/N …」的錄製段落（不是 `npm run cassettes:rerecord` 的輸出，或錄前檢查就停了）。');
            L.push('');
        }
        log.runs.forEach((run, i) => {
            if (log.runs.length > 1) { L.push(`第 ${i + 1} 輪：`); L.push(''); }
            L.push(table(['步驟', 'suite', '結束碼', '耗時'], run.steps.map(s => [
                `${s.index}/${s.total} ${s.label}`,
                s.name || '—',
                s.exitCode == null ? '（沒有結束紀錄：中斷或還在跑）' : String(s.exitCode),
                s.sec == null ? '—' : fmtDur(s.sec * 1000)
            ])));
            const done = run.steps.filter(s => s.sec != null);
            L.push('');
            L.push(`已結束的 ${done.length} 步合計 ${fmtDur(sum(done.map(s => s.sec)) * 1000)}（不含錄前盤點與最後的回放驗證）。`);
            L.push('');
        });
        L.push(log.timeoutLines
            ? `log 裡有 ${log.timeoutLines} 行逾時訊息（OLLAMA_TIMEOUT_MS／OCR_TIMEOUT_MS／節點逾時）：那幾次呼叫沒有 cassette，上面的延遲看不到它們，請一併參考。`
            : 'log 裡沒有找到逾時訊息（OLLAMA_TIMEOUT_MS／OCR_TIMEOUT_MS／節點逾時）；不保證沒有逾時：不是每個 suite 都把錯誤原文印進 log。');
        L.push('');
    }

    // 3. 建議
    L.push('## 3. 建議（只是數字與理由，不會自動改任何設定）');
    L.push('');
    if (!agentStats.length) {
        L.push('沒有本機模型（Ollama／PaddleOCR）的資料，無法建議逾時、倍率與頁數。');
        L.push('');
    } else {
        if (rec.lowSample.length) {
            L.push(`樣本少於 ${RULES.MIN_SAMPLES} 支的 agent（p90 等於最大值，逾時的安全值因此就是 ${Math.max(RULES.P90_FACTOR, RULES.MAX_FACTOR)} × max）：` +
                `${rec.lowSample.map(a => `\`${a}\``).join('、')}——相關的數字只能參考，多錄幾份卷再看。`);
            L.push('');
        }
        L.push('### 3.1 逾時');
        L.push('');
        L.push(`規則：安全值＝max(${RULES.P90_FACTOR} × p90, ${RULES.MAX_FACTOR} × max)，無條件進位到整分鐘。目前值＝環境變數或 \`exam_pro/.env\` 明寫的值，沒寫就是本機預設。`);
        L.push('');
        const verdict = (need, cur) => (need <= cur ? '夠用（不必調小：調小只會讓偶發的慢呼叫被判逾時）' : `**不夠**，建議調到 ${need} 以上`);
        const rows = [];
        if (rec.ollamaTimeout) {
            const o = rec.ollamaTimeout;
            const cur = settings.OLLAMA_TIMEOUT_MS;
            rows.push(['`OLLAMA_TIMEOUT_MS`（單次 Ollama 呼叫）', `${fmtSetting(cur.value)}，${cur.source}`, fmtSetting(o.needMs),
                `最慢的是 \`${o.agent}\`：p90 ${fmtDur(o.p90Ms)}、max ${fmtDur(o.maxMs)}（${o.n} 支）→ ${verdict(o.needMs, cur.value)}`]);
        }
        if (rec.ocrTimeout) {
            const o = rec.ocrTimeout;
            const cur = settings.OCR_TIMEOUT_MS;
            rows.push(['`OCR_TIMEOUT_MS`（單次 PaddleOCR）', `${fmtSetting(cur.value)}，${cur.source}`, fmtSetting(o.needMs),
                `\`ocr\`：p90 ${fmtDur(o.p90Ms)}、max ${fmtDur(o.maxMs)}（${o.n} 支）→ ${verdict(o.needMs, cur.value)}`]);
        }
        if (rec.nodeTimeout) {
            const o = rec.nodeTimeout;
            const cur = settings.JOB_NODE_TIMEOUT_MS;
            rows.push(['`JOB_NODE_TIMEOUT_MS`（一個節點）', `${fmtSetting(cur.value)}，${cur.source}`, fmtSetting(o.needMs),
                `最久的節點是「${o.node}」（見下表）→ ${verdict(o.needMs, cur.value)}`]);
        }
        if (rows.length) {
            L.push(table(['設定', '目前', '建議至少', '依據'], rows));
            L.push('');
        }
        if (rec.nodeTimeout) {
            L.push('各節點的估計（節點內的呼叫是依序跑的，所以相加）：');
            L.push('');
            L.push(table(['節點', 'p90', 'max', '安全值', '說明'], rec.nodeTimeout.candidates.map(c => [
                c.node, fmtDur(c.p90Ms), fmtDur(c.maxMs), fmtDur(c.needMs), c.note
            ])));
            L.push('');
            L.push('拆題一塊的時間大致隨每塊頁數增減：若照 3.3 改了 `JOB_PDF_CHUNK_PAGES`，這一列要照新頁數重估。' +
                '頁數調小時不能直接按比例縮小——模型載入、系統提示詞等固定開銷不會跟著頁數減少。');
            L.push('');
            if (rec.nodeTimeout.needMs > local.LOCAL_NODE_TIMEOUT_MS) {
                L.push(`注意：\`.env\` 的 \`JOB_NODE_TIMEOUT_MS\` 只影響正式上傳。重錄（\`cassettes:rerecord\`）時固定帶 ${local.LOCAL_NODE_TIMEOUT_MS}` +
                    '（`eval/lib/localMode.js` 的 `LOCAL_NODE_TIMEOUT_MS`），不讀 `.env`；上面的建議超過它，代表重錄 pipeline 時也可能逾時，要改那個常數（第 2 條的契約值，需另行裁決）。' +
                    '`OLLAMA_TIMEOUT_MS`、`OCR_TIMEOUT_MS` 則會從 `.env` 帶進重錄。');
                L.push('');
            }
        }

        L.push('### 3.2 重錄預估的倍率（`RERECORD_TIME_SCALE`）');
        L.push('');
        if (!rec.timeScale) {
            L.push('沒有 `eval/lib/localMode.js` 的 `SEC_PER_CALL` 表上的 agent，算不出倍率。');
        } else {
            const t = rec.timeScale;
            L.push(`規則：同一批呼叫的實測秒數合計 ÷ \`SEC_PER_CALL\`（粗估）合計 = ${fmtInt(t.measuredSec)} ÷ ${fmtInt(t.estimatedSec)}。`);
            L.push('');
            L.push(table(['agent', '支數', '實測平均', '粗估（SEC_PER_CALL）', '實測÷粗估'], t.rows.map(r => [
                `\`${r.agent}\``, String(r.n), fmtDur(r.meanSec * 1000), fmtDur(r.estSec * 1000), r.ratio.toFixed(2)
            ])));
            L.push('');
            L.push(`建議：\`.env\` 設 \`RERECORD_TIME_SCALE=${t.scale}\`，下次 \`npm run cassettes:rerecord -- --dry-run\` 的預估時間就會照實測縮放。`);
            if (t.perAgent.length) {
                L.push('');
                L.push(`各 agent 的倍率相差 ${t.spread.toFixed(1)} 倍（超過 ${RULES.SCALE_SPREAD} 倍），單一倍率不準；改設個別的每次秒數（設了個別值的 agent 不再乘倍率）：`);
                L.push('');
                L.push('```dotenv');
                for (const p of t.perAgent) L.push(`${p.env}=${p.value}`);
                L.push('```');
            }
            if (t.excluded.length) {
                L.push('');
                L.push(`不在粗估表上、沒算進倍率：${t.excluded.map(a => `\`${a}\``).join('、')}。`);
            }
            L.push('');
            L.push('向量（`RERECORD_SEC_PER_EMBED`）不寫 cassette，這裡量不到；可以參考 log 裡 embeddings 那一步的耗時。');
        }
        L.push('');

        L.push('### 3.3 每塊頁數（`JOB_PDF_CHUNK_PAGES`）');
        L.push('');
        if (!rec.chunkPages) {
            L.push('沒有 `extract_vision` 的 cassette（或看不出頁數），無法建議每塊頁數。');
        } else {
            const c = rec.chunkPages;
            const avg = round1(c.recordedAvgPages);
            L.push(`規則：每頁秒數線性外推（錄製時平均每塊 ${avg} 頁），` +
                `每頁的安全秒數＝max(${RULES.P90_FACTOR} × 每頁 p90, ${RULES.MAX_FACTOR} × 每頁 max)；在目前的逾時與 \`OLLAMA_NUM_CTX\` 之下，一塊都放得下的最大頁數（上限 ${RULES.MAX_CHUNK_PAGES}）。` +
                `模型載入、系統提示詞等固定開銷也按頁攤：推到比 ${avg} 頁多時估得偏保守；**推到比 ${avg} 頁少時會低估**（固定開銷不會跟著頁數減半）。`);
            L.push('');
            const recordedBy = new Map(c.recorded.steps.map(r => [r.agent, r]));
            const longest = (r) => (r ? `${fmtDur(r.maxMs)}（${r.pages == null ? '頁數不明' : `${r.pages} 頁`}）` : '—');
            L.push(table(['步驟', '每頁平均', '每頁 p90', '每頁安全秒數', '頁數來源', '錄到的每塊最長'], Object.entries(c.perPage).map(([a, p]) => [
                `\`${a}\``, fmtDur(p.meanSec * 1000), fmtDur(p.p90Sec * 1000), fmtDur(p.safeSec * 1000), p.from, longest(recordedBy.get(a))
            ])));
            L.push('');
            if (c.limits.length) {
                L.push(table(['限制', '最多幾頁', '依據'], c.limits.map(l => [
                    `\`${l.name}\`＝${fmtInt(settings[l.name].value)}`, String(l.maxPages), l.why
                ])));
                L.push('');
            }
            if (c.pages === 0) {
                const b = c.binding;
                const limitText = `\`${b.name}\`＝${b.name === 'OLLAMA_NUM_CTX' ? fmtInt(settings[b.name].value) : fmtSetting(settings[b.name].value)}`;
                L.push(b.name === 'OLLAMA_NUM_CTX'
                    ? `建議：**每塊 1 頁，估計的 token 數也超過 ${limitText}**。${b.why}。請先調高 \`OLLAMA_NUM_CTX\`（記憶體要夠），再重跑本工具。`
                    : `建議：**每塊 1 頁也達不到 max(${RULES.P90_FACTOR} × p90, ${RULES.MAX_FACTOR} × max) 的安全餘裕**。` +
                      `受限於 ${limitText}：${b.why}。請先照 3.1 調高逾時，再重跑本工具。`);
                const steps = c.recorded.steps;
                if (steps.length) {
                    L.push('');
                    L.push(`實際錄到的每塊最長（成功留下回放檔的呼叫）：${steps.map(r => `\`${r.agent}\` ${longest(r)}`).join('、')}` +
                        (steps.length > 1 ? `；各步最長相加 ${fmtDur(c.recorded.sumMaxMs)}（同一塊不一定每步都最慢，所以是上限）` : '') + '。');
                }
            } else if (c.pages < c.current) {
                L.push(`建議：\`JOB_PDF_CHUNK_PAGES=${c.pages}\`（目前 ${c.current} 頁，受限於 \`${c.binding.name}\`）；或照 3.1 調高逾時後維持 ${c.current} 頁。`);
            } else {
                L.push(`建議：目前的 ${c.current} 頁在安全範圍內；在目前的設定下最多可到 ${c.pages} 頁` +
                    `${c.binding ? `（受限於 \`${c.binding.name}\`）` : ''}。頁數多，跨頁的題比較不會被切開（LM-12 ①），` +
                    `但一塊更久、失敗時要重跑的也多；不確定就維持 ${c.current} 頁。`);
            }
            if (c.belowRecorded) {
                L.push('');
                L.push(`注意：上面的結論推到每塊 ${c.belowRecorded.pages} 頁，少於錄製時平均的 ${avg} 頁。線性外推在這個方向會**低估**一塊的時間與 token` +
                    '（模型載入、系統提示詞等固定開銷不會跟著頁數減半），實際的安全餘裕比上表算的小。' +
                    '改了頁數之後，上傳幾份卷再用 `npm run report:jobs -- --since=7d` 看 extract 節點實際花多久。');
            }
            L.push('');
            L.push('這個設定只影響正式上傳（`exam_pro/.env`）；重錄 CI 回放檔時一律照 CI 的設定（本機 2 頁），不受影響。');
        }
        L.push('');
    }

    return {
        markdown: `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
        data: { inventory: { dir: inv.dir, total: inv.entries.length, broken: inv.broken }, skipped, groups, agentStats, settings, recommendations: rec, overlaps, logs }
    };
}

/**
 * exam_pro/.env 疊在 process.env 底下（不改 process.env；已存在的環境變數優先，與 dotenv 相同）。
 * @returns {Record<string,string>}
 */
function loadEnv(file = path.join(APP_DIR, '.env')) {
    let parsed = {};
    try { parsed = require('dotenv').parse(fs.readFileSync(file)); } catch (err) { parsed = {}; }
    return { ...parsed, ...process.env };
}

/**
 * @param {string[]} [argv]
 * @param {{stdout?:{write:Function}, cwd?:string, env?:object, now?:Date}} [io] 測試注入點
 * @returns {number} 結束碼
 */
function main(argv = process.argv.slice(2), io = {}) {
    const out = io.stdout || process.stdout;
    const args = parseArgs(argv, { cwd: io.cwd || process.cwd() });
    if (args.help) { out.write(`${USAGE}\n`); return 0; }
    const { markdown } = buildReport(args, { env: io.env || loadEnv(), now: io.now || new Date() });
    out.write(markdown);
    if (args.out) {
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, markdown, 'utf8');
        out.write(`\n已另存：${args.out}\n`);
    }
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (err) {
        console.error(`\n❌ ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    main, parseArgs, parseSince, buildReport, loadEnv,
    vendorOfCassette, toEntry, fillChunkPages, readCassettes, selectEntries,
    percentile, statsOf, summarizeGroups, countOverlaps,
    stepNameOf, parseRecordLog,
    safeMs, currentSettings, recommend,
    fmtDur,
    RULES, LOW_SAMPLE_LABEL, SETTING_DEFAULTS, STEP_LABEL_PREFIXES, LOCAL_VENDORS, VENDOR_CHOICES, DEFAULT_CASSETTE_DIR, USAGE
};
