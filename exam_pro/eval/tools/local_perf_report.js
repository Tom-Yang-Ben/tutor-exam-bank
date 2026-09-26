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
//   - 重錄時 JOB_NODE_TIMEOUT_MS 固定是 localMode.LOCAL_NODE_TIMEOUT_MS（不讀 .env；pipeline 與 e2e 兩步是
//     localMode.RECORD_LONG_TIMEOUT_MS）；節點建議超過它時報告會提醒。
//   - 〔看圖拆題逾時〕cassette 的 response.usage.timing（services/llm/ollama.js；新版錄的才有）是 Ollama 自己量的
//     載入／讀 prompt（含看圖）／輸出毫秒數：第 1.1 段分開列，才看得出慢在讀圖還是輸出。
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
//
// 〔dec/local-thinking-speed〕拆題以外的時間花在哪裡（docs/local-mode.md 第 10.12 條）：
//   1.2 各 agent 讀／寫 token 的分布，與 OLLAMA_NUM_CTX 降到 8192 放不放得下（加上輸出上限的最壞情況）；
//   1.3 舊回放檔沒有分段時間時推算速度：同一段 prompt 連送兩次（第二次吃到 Ollama 的 prompt 快取）→ 輸出速度與冷的讀 prompt 速度；
//       讀的 token 數差不多的組做「延遲對輸出 token」的迴歸交叉檢查（SPEED_RULES）；
//   1.4 思考占輸出多少：用不思考的回放檔擬合「字數 → token 數」，套到會思考的 agent 的回答上，輸出 token 減回答＝思考；
//   1.5 LaTeX 的反斜線被 JSON 吃掉（\frac → 換頁字元＋rac）的回放檔支數；
//   4   一份卷（預設 10 題、4 頁，--questions／--pages 可改；OCR 為主，不含看圖拆題）各步驟的低／高估計，
//       與選項 a／b／c（不思考）一份卷省多少。量不到的用 PAPER_ASSUMPTIONS，報告逐條寫依據。
//   OLLAMA_NO_THINK 錄的回放檔（request.ollamaOverrides.think=false）在第 1 段另列「（不思考）」一組，不混進第 4 段的現狀估計。
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

/** 〔dec/local-thinking-speed〕第 4 段「一份卷」的預設大小（--questions／--pages 可改） */
const PAPER_ASSUMPTIONS_DEFAULTS = Object.freeze({ QUESTIONS: 10, PAGES: 4 });

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
  --questions <N>      第 4 段「一份卷」估幾題（預設 ${PAPER_ASSUMPTIONS_DEFAULTS.QUESTIONS}）
  --pages <N>          第 4 段「一份卷」估幾頁（預設 ${PAPER_ASSUMPTIONS_DEFAULTS.PAGES}）
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
            // 〔dec/local-thinking-speed〕有給才出現在 args.paper（沒給時 args 的形狀與之前相同）
            case '--questions': case '--pages': {
                const n = Number(value(++i, a));
                if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`${a} 要是 1～200 的整數，收到「${argv[i]}」`);
                args.paper = { ...(args.paper || {}), [a === '--questions' ? 'questions' : 'pages']: n };
                break;
            }
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
    // 〔看圖拆題逾時〕Ollama 的分段時間（services/llm/ollama.js 的 usage.timing；2026-09-26 之後錄的才有）
    const rt = res.usage && res.usage.timing && typeof res.usage.timing === 'object' ? res.usage.timing : null;
    const msOrNull = (v) => { const n = Number(v); return v !== null && v !== undefined && Number.isFinite(n) && n >= 0 ? n : null; };
    const timing = rt ? {
        totalMs: msOrNull(rt.totalMs), loadMs: msOrNull(rt.loadMs), promptEvalMs: msOrNull(rt.promptEvalMs), evalMs: msOrNull(rt.evalMs)
    } : null;
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
    const shas = parts.map(p => (p && typeof p.sha256 === 'string' ? p.sha256 : null)).filter(Boolean);
    const answerValue = res.data !== undefined ? res.data : res.text;
    return {
        agent,
        model,
        vendor: vendorOfCassette({ agent, model, kind: meta.kind }),
        file,
        recordedAt,
        timeSource: hasMetaTime ? 'meta' : (recordedAt === null ? null : 'mtime'),
        latencyMs: Number.isFinite(lat) && lat > 0 ? lat : null,
        usage,
        timing: timing && (timing.promptEvalMs !== null || timing.evalMs !== null) ? timing : null,
        pages,
        pagesFrom,
        chunkRef: ckp.pdfSha256 && ckp.chunkNo != null ? `${ckp.pdfSha256}#${ckp.chunkNo}` : null,
        // 〔dec/local-thinking-speed〕推算速度與思考比例用（第 1.3～1.5 段、第 4 段）
        partsHash: shas.length ? shas.join(',') : null,                  // 同一段 prompt 連送兩次＝第二次吃到 Ollama 的 prompt 快取
        noThink: !!(req.ollamaOverrides && req.ollamaOverrides.think === false),   // OLLAMA_NO_THINK 錄的（services/llm/index.js）
        sampleNo: Number.isInteger(ckp.sampleNo) ? ckp.sampleNo : null,  // verify 的第幾次採樣（uncertain 才有第 2 次）
        answer: answerValue === undefined || answerValue === null ? null : charCounts(typeof answerValue === 'string' ? answerValue : JSON.stringify(answerValue)),
        ctrlEscapes: answerValue === undefined || answerValue === null ? false : hasCtrlEscapes(answerValue)
    };
}

/** 中日韓字元與全形標點（思考比例的換算用：一個中文字與一個英文字母佔的 token 數差很多） */
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/g;

/**
 * 字元數拆成「中日韓」與「其他」。純函式。
 * @param {string} text
 * @returns {{cjk:number, other:number}}
 */
function charCounts(text) {
    const s = String(text ?? '');
    const cjk = (s.match(CJK_RE) || []).length;
    return { cjk, other: s.length - cjk };
}

/**
 * 〔dec/local-thinking-speed〕回應的字串裡有沒有「控制字元緊接英文字母」：模型在 JSON 裡把 LaTeX 寫成單一反斜線，
 * \frac、\times、\theta、\rightarrow、\beta 的 \f、\t、\r、\b 是合法的 JSON 跳脫，解析後變成換頁、tab、歸位、退格字元，
 * 公式就壞了（\frac → 換頁＋rac）。第 1.5 段據此計數。純函式。
 * @param {any} value  response.data 或 response.text
 * @returns {boolean}
 */
function hasCtrlEscapes(value) {
    const re = /[\t\f\r\b\v](?=[A-Za-z])/;
    const walk = (v) => {
        if (typeof v === 'string') return re.test(v);
        if (Array.isArray(v)) return v.some(walk);
        if (v && typeof v === 'object') return Object.values(v).some(walk);
        return false;
    };
    return walk(value);
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
            // 每頁 token（輸入＋輸出；含固定的 system／白名單，只有推到比錄製時多的頁數才偏保守，推到較少頁數會低估）：OLLAMA_NUM_CTX 放不放得下
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
        timing: timingStatsOf(items),
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

/**
 * 〔看圖拆題逾時〕分段時間的統計（只算 cassette 帶了 usage.timing 的呼叫；舊 cassette 沒有就回 null）。純函式。
 *   讀 prompt（prompt eval）：視覺模型的圖片也在這一段——「讀圖」的秒數與每頁秒數看這裡；
 *   輸出（eval）：tokenOut ÷ evalMs＝純生成速度（不含讀 prompt，比第 1 段表格的「輸出 token/秒」準）；
 *   其他＝latencyMs − totalMs：排隊等併發槽與傳輸（Ollama 沒算到的時間）。
 * @param {ReturnType<typeof toEntry>[]} items
 */
function timingStatsOf(items) {
    const withT = items.filter(e => e.timing && e.usage);
    if (!withT.length) return null;
    const pick = (k) => withT.filter(e => e.timing[k] !== null);
    const mean = (xs, k) => (xs.length ? sum(xs.map(e => e.timing[k])) / xs.length : null);
    const pe = pick('promptEvalMs');
    const ev = pick('evalMs');
    const ld = pick('loadMs');
    const tot = pick('totalMs');
    const peMs = sum(pe.map(e => e.timing.promptEvalMs));
    const evMs = sum(ev.map(e => e.timing.evalMs));
    const pePages = pe.filter(e => Number.isInteger(e.pages) && e.pages > 0);
    const evPages = ev.filter(e => Number.isInteger(e.pages) && e.pages > 0);
    const perPage = (xs, k) => {
        const pages = sum(xs.map(e => e.pages));
        return pages > 0 ? sum(xs.map(e => e.timing[k])) / pages / 1000 : null;
    };
    return {
        n: withT.length,
        meanLoadMs: mean(ld, 'loadMs'),
        meanPromptEvalMs: mean(pe, 'promptEvalMs'),
        maxPromptEvalMs: pe.length ? Math.max(...pe.map(e => e.timing.promptEvalMs)) : null,
        promptTokensPerSec: peMs > 0 ? sum(pe.map(e => e.usage.tokenIn)) / (peMs / 1000) : null,
        meanEvalMs: mean(ev, 'evalMs'),
        maxEvalMs: ev.length ? Math.max(...ev.map(e => e.timing.evalMs)) : null,
        evalTokensPerSec: evMs > 0 ? sum(ev.map(e => e.usage.tokenOut + e.usage.tokenThinking)) / (evMs / 1000) : null,
        promptEvalSecPerPage: perPage(pePages, 'promptEvalMs'),
        evalSecPerPage: perPage(evPages, 'evalMs'),
        meanOtherMs: tot.length ? sum(tot.map(e => Math.max(0, e.latencyMs - e.timing.totalMs))) / tot.length : null
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
        // 〔dec/local-thinking-speed〕byModel 時「不思考」錄的（OLLAMA_NO_THINK）另成一組；沒有這種 cassette 時分組與之前相同
        const k = byModel ? `${e.agent}\u0000${e.model ?? ''}\u0000${e.noThink ? 1 : 0}` : e.agent;
        if (!map.has(k)) map.set(k, { agent: e.agent, model: byModel ? e.model : null, vendor: e.vendor, noThink: byModel && !!e.noThink, items: [], models: new Set() });
        const g = map.get(k);
        g.items.push(e);
        g.models.add(e.model ?? '');
    }
    return [...map.values()]
        .map(g => ({ ...statsOf(g), noThink: g.noThink, models: [...g.models].filter(Boolean).sort() }))
        .sort((a, b) => agentRank(a.agent) - agentRank(b.agent) || a.agent.localeCompare(b.agent) || String(a.model).localeCompare(String(b.model))
            || Number(a.noThink) - Number(b.noThink));
}

/** 表格裡的 agent 欄：不思考錄的加註 */
function agentCell(g) {
    return `\`${g.agent}\`${g.noThink ? '（不思考）' : ''}`;
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

// ───────────────────────── 〔dec/local-thinking-speed〕token 分布、速度、思考比例、一份卷的估計 ─────────────────────────

/** 本分支加的推算用規則（單元測試釘住；改這裡＝改報告的推算） */
const SPEED_RULES = Object.freeze({
    PAIR_MAX_GAP_MS: 60_000,     // 同一段 prompt 連送兩次、中間隔不超過 1 分鐘，第二次才算「吃到 prompt 快取」
    PAIR_MIN_PROMPT_TOKENS: 1000, // 推「冷的讀 prompt 速度」只用讀得夠多的那幾對（prompt 短時差值被雜訊蓋過）
    REGRESS_MIN_N: 5,            // 延遲對輸出 token 的迴歸至少幾支
    REGRESS_MAX_IN_CV: 0.15,     // 讀的 token 數差不多（變異係數 ≤ 0.15）才做迴歸：斜率＝每個輸出 token 的秒數
    REGRESS_MIN_R2: 0.5,         // r² 低於這個的迴歸不列（延遲主要不是輸出決定的，斜率沒有意義）
    CALIB_MIN_N: 10,             // 「字數 → token 數」的換算至少要幾支不思考的回放檔
    SMALL_CTX: 8192              // 選項 d 比較的 num_ctx
});

/**
 * 一份卷的時間估計用的假設（第 4 段逐條印出來；數字的依據寫在旁邊）。
 * 只有回放檔量不到的東西才用假設；量得到的（每次呼叫的秒數、token 數、速度）一律用回放檔。
 */
const PAPER_ASSUMPTIONS = Object.freeze({
    QUESTIONS: PAPER_ASSUMPTIONS_DEFAULTS.QUESTIONS,
    PAGES: PAPER_ASSUMPTIONS_DEFAULTS.PAGES,
    // 分類：拆題模型給的章節在白名單內、信心 ≥ 0.8 就不呼叫 LLM（agents/classify.js 第一層）。本機拆題還沒有資料，只能給 0%～100%
    CLASSIFY_LLM_RATE: Object.freeze({ low: 0, high: 1 }),
    // lint 第三層（LLM 重寫）：①② 兩層規則修不好才呼叫。2026-09-26 對既有資料跑 agents/lint.js 的 gate()：
    // Gemini 拆的 10 題 1 題（10%）、fixture 62 題 10 題（16%）、qwen3:8b 出的變式 60 題 11 題（18%）
    LINT_LLM_RATE: Object.freeze({ low: 0.1, high: 0.2 }),
    // 驗算判定不一致（answer_mismatch）時狀態機原地重跑一次（pipeline/stateMachine.js maxRetries.verify=1），
    // 本機沒有資料：0%～30%
    VERIFY_FAIL_RATE: Object.freeze({ low: 0, high: 0.3 }),
    // 回放檔沒有 sampleNo 時 uncertain（再採樣一次）的比例
    VERIFY_UNCERTAIN_RATE_FALLBACK: 0.1,
    // 沒有本機 extract_ocr 回放檔時的 token 估計：
    //   固定的提示詞＝本機 OCR 模板（章節白名單、規範）＋ schema 說明＋系統提示詞，2026-09-26 以字數換算約 2,450 token；
    //   OCR 文字每頁約 550 token（repo 裡唯一一支 ocr 回放檔：954 字）；輸出每題約 150 token（Gemini 拆 10 題的輸出約 1,530 token）
    EXTRACT_OCR_FIXED_TOKENS: 2450,
    OCR_TOKENS_PER_PAGE: 550,
    EXTRACT_OUT_TOKENS_PER_QUESTION: 150,
    // 知識點標註（沒有本機回放檔）：讀約 1,600 token（services/kcTagService.js 的 EST_TOKENS_PER_QUESTION）、回答約 130 token
    KC_TAG_IN_TOKENS: 1600,
    KC_TAG_ANSWER_TOKENS: 130
});

/**
 * qwen3:8b 的 KV cache 每個 token 幾個位元組（f16）：2（K、V）× 36 層 × 8 個 KV 頭 × 128 維 × 2 位元組＝147,456。
 * qwen3-vl:8b 的語言模型同一個規格。Ollama 預設 KV cache 是 f16（OLLAMA_KV_CACHE_TYPE）。選項 d 的記憶體估計用。
 */
const KV_BYTES_PER_TOKEN_8B = 2 * 36 * 8 * 128 * 2;

function median(xs) {
    const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 每個 agent 的輸出上限（num_predict）：會思考的看 localTuning.THINKING_AGENTS；本機拆題 8192；其餘不送（null） */
function maxOutputOf(agent) {
    const t = require('../../services/llm/localTuning').THINKING_AGENTS[agent];
    if (t) return t.maxOutputTokens;
    if (/^extract_(vision|ocr)(_chem)?$/.test(agent)) return require('../../agents/extract').LOCAL_MAX_OUTPUT_TOKENS;
    return null;
}

/** 這個 agent 程式裡會不會要求思考（localTuning.THINKING_AGENTS） */
function thinksByDefault(agent) {
    return Object.prototype.hasOwnProperty.call(require('../../services/llm/localTuning').THINKING_AGENTS, agent);
}

/**
 * 1.2 段：各組讀／寫 token 的分布，與 num_ctx 降到 8192 放不放得下。純函式。
 * @param {ReturnType<typeof summarizeGroups>} groups
 * @param {ReturnType<typeof toEntry>[]} entries 同一批（依 agent＋模型＋是否思考對回各組）
 */
function tokenDistribution(groups, entries, { smallCtx = SPEED_RULES.SMALL_CTX } = {}) {
    const rows = [];
    for (const g of groups) {
        const items = entries.filter(e => e.agent === g.agent && (e.model ?? null) === (g.model ?? null) && !!e.noThink === !!g.noThink && e.usage);
        if (!items.length) continue;
        const tin = items.map(e => e.usage.tokenIn);
        const tout = items.map(e => e.usage.tokenOut + e.usage.tokenThinking);
        const q = (xs) => ({ min: Math.min(...xs), p50: percentile(xs, 50), p90: percentile(xs, 90), max: Math.max(...xs) });
        const totalMax = Math.max(...items.map(e => e.usage.tokenIn + e.usage.tokenOut + e.usage.tokenThinking));
        const maxOut = maxOutputOf(g.agent);
        const worst = maxOut === null ? null : Math.max(...tin) + maxOut;
        rows.push({
            agent: g.agent, model: g.model, noThink: g.noThink, n: items.length, in: q(tin), out: q(tout), totalMax,
            maxOutputTokens: maxOut, worst,
            fitsObserved: totalMax <= smallCtx,
            fitsWorst: worst === null ? null : worst <= smallCtx
        });
    }
    return rows;
}

/**
 * 1.3 段：沒有分段時間（舊回放檔）時推算「讀 prompt」與「輸出」的速度。純函式。
 *
 * 做法一（同一段 prompt 連送兩次）：Ollama 會留著上一次的 prompt 快取，第二次幾乎不必再讀 prompt，
 *   第二次的「輸出 token ÷ 延遲」≈ 純輸出速度（延遲裡還有一點點讀 prompt 的尾巴，所以略為低估）；
 *   第一次的延遲減掉「輸出 token ÷ 那個速度」＝讀 prompt 的時間 → 冷的讀 prompt 速度。
 *   認法：同一個模型、同一個 agent、request.parts 的 sha256 相同、tokenIn 相同，而且第二次在第一次結束後
 *   SPEED_RULES.PAIR_MAX_GAP_MS 內開始。例：變式題 idx 1、2 送的是同一段 prompt。
 * 做法二（迴歸）：同一組裡讀的 token 數差不多時，延遲 ≈ 截距 ＋ 斜率 × 輸出 token；1 ÷ 斜率＝輸出速度（含思考）。
 * 有分段時間（新回放檔）時，以第 1.1 段 Ollama 自己量的為準，這裡只是交叉檢查。
 * @param {ReturnType<typeof toEntry>[]} entries 已篩選
 * @returns {{byModel:Array<{model:string, pairs:number, outTps:number|null, coldPromptTps:number|null,
 *            examples:Array<object>, timing:{outTps:number|null, promptTps:number|null}}>,
 *            regressions:Array<{agent:string, model:string, n:number, secPerOutToken:number, interceptSec:number, r2:number, outTps:number}>}}
 */
function estimateSpeeds(entries) {
    const models = [...new Set(entries.filter(e => e.vendor === 'ollama' && e.usage).map(e => e.model))].sort();
    const byModel = [];
    for (const model of models) {
        const xs = entries
            .filter(e => e.model === model && e.usage && e.timeSource === 'meta' && e.latencyMs)
            .map(e => ({ e, start: e.recordedAt - e.latencyMs, end: e.recordedAt }))
            .sort((a, b) => a.start - b.start);
        const pairs = [];
        for (let i = 0; i + 1 < xs.length; i++) {
            const a = xs[i].e;
            const b = xs[i + 1].e;
            const gap = xs[i + 1].start - xs[i].end;
            if (a.agent !== b.agent || !a.partsHash || a.partsHash !== b.partsHash) continue;
            if (a.usage.tokenIn !== b.usage.tokenIn || !(b.usage.tokenOut > 0) || gap > SPEED_RULES.PAIR_MAX_GAP_MS || gap < -SPEED_RULES.PAIR_MAX_GAP_MS) continue;
            const outTps = b.usage.tokenOut / (b.latencyMs / 1000);
            const promptSec = a.latencyMs / 1000 - a.usage.tokenOut / outTps;
            pairs.push({
                agent: a.agent, tokenIn: a.usage.tokenIn, firstMs: a.latencyMs, secondMs: b.latencyMs,
                firstOut: a.usage.tokenOut, secondOut: b.usage.tokenOut, outTps,
                coldPromptTps: promptSec > 0 && a.usage.tokenIn >= SPEED_RULES.PAIR_MIN_PROMPT_TOKENS ? a.usage.tokenIn / promptSec : null
            });
        }
        const timed = entries.filter(e => e.model === model && e.timing && e.usage);
        const sumT = (k) => sum(timed.filter(e => e.timing[k] > 0).map(e => e.timing[k]));
        const evMs = sumT('evalMs');
        const peMs = sumT('promptEvalMs');
        byModel.push({
            model,
            pairs: pairs.length,
            outTps: median(pairs.map(p => p.outTps)),
            coldPromptTps: median(pairs.map(p => p.coldPromptTps).filter(v => v !== null)),
            examples: pairs,
            timing: {
                outTps: evMs > 0 ? sum(timed.filter(e => e.timing.evalMs > 0).map(e => e.usage.tokenOut + e.usage.tokenThinking)) / (evMs / 1000) : null,
                promptTps: peMs > 0 ? sum(timed.filter(e => e.timing.promptEvalMs > 0).map(e => e.usage.tokenIn)) / (peMs / 1000) : null
            }
        });
    }

    const regressions = [];
    const groups = new Map();
    for (const e of entries) {
        if (e.vendor !== 'ollama' || !e.usage || !e.latencyMs) continue;
        const k = `${e.agent}\u0000${e.model}\u0000${e.noThink ? 1 : 0}`;
        if (!groups.has(k)) groups.set(k, { agent: e.agent, model: e.model, noThink: !!e.noThink, items: [] });
        groups.get(k).items.push(e);
    }
    for (const g of groups.values()) {
        if (g.items.length < SPEED_RULES.REGRESS_MIN_N) continue;
        const tin = g.items.map(e => e.usage.tokenIn);
        const mIn = sum(tin) / tin.length;
        const cv = mIn > 0 ? Math.sqrt(sum(tin.map(v => (v - mIn) ** 2)) / tin.length) / mIn : Infinity;
        if (!(cv <= SPEED_RULES.REGRESS_MAX_IN_CV)) continue;
        const x = g.items.map(e => e.usage.tokenOut + e.usage.tokenThinking);
        const y = g.items.map(e => e.latencyMs / 1000);
        const mx = sum(x) / x.length;
        const my = sum(y) / y.length;
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
        if (!(sxx > 0) || !(syy > 0)) continue;
        const slope = sxy / sxx;
        if (!(slope > 0) || (sxy * sxy) / (sxx * syy) < SPEED_RULES.REGRESS_MIN_R2) continue;
        regressions.push({
            agent: g.agent, model: g.model, noThink: g.noThink, n: g.items.length, secPerOutToken: slope, interceptSec: my - slope * mx,
            r2: (sxy * sxy) / (sxx * syy), outTps: 1 / slope
        });
    }
    regressions.sort((a, b) => agentRank(a.agent) - agentRank(b.agent) || a.agent.localeCompare(b.agent));
    return { byModel, regressions };
}

/**
 * 一個模型要拿來推估的速度：有分段時間就用 Ollama 量的；沒有就用做法一（連送兩次）；再沒有就用迴歸裡 r² 最高的輸出速度。
 * @returns {{outTps:number|null, promptTps:number|null, source:string}}
 */
function speedFor(speeds, model) {
    const m = speeds.byModel.find(x => x.model === model);
    if (m && m.timing.outTps && m.timing.promptTps) return { outTps: m.timing.outTps, promptTps: m.timing.promptTps, source: 'Ollama 的分段時間' };
    if (m && m.outTps && m.coldPromptTps) return { outTps: m.outTps, promptTps: m.coldPromptTps, source: `同一段 prompt 連送兩次（${m.pairs} 對）` };
    const r = speeds.regressions.filter(x => x.model === model).sort((a, b) => b.r2 - a.r2)[0];
    if (r) return { outTps: r.outTps, promptTps: m ? m.coldPromptTps : null, source: `\`${r.agent}\` 的迴歸（r² ${r.r2.toFixed(2)}）` };
    return { outTps: null, promptTps: null, source: '沒有資料' };
}

/**
 * 1.4 段：會思考的 agent，輸出 token 裡有多少是思考（Ollama 把思考與回答算在同一個 eval_count 裡，回放檔也只存回答）。
 * 做法：同一個模型「不思考」的回放檔（分類、變式、查題…，或 OLLAMA_NO_THINK 錄的）輸出 token 就是回答本身，
 * 以最小平方擬合「token ≈ a × 中文字數 ＋ b × 其他字數」（回答＝JSON.stringify(response.data)），
 * 再拿它估會思考的 agent 的回答有幾個 token，其餘就是思考。純函式。
 * @param {ReturnType<typeof toEntry>[]} entries 已篩選
 */
function estimateThinking(entries) {
    const out = [];
    const models = [...new Set(entries.filter(e => e.vendor === 'ollama').map(e => e.model))].sort();
    for (const model of models) {
        const ok = (e) => e.model === model && e.usage && e.answer && e.usage.tokenOut > 0;
        const calib = entries.filter(e => ok(e) && (!thinksByDefault(e.agent) || e.noThink));
        if (calib.length < SPEED_RULES.CALIB_MIN_N) continue;
        let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0;
        for (const e of calib) {
            const { cjk, other } = e.answer;
            const y = e.usage.tokenOut;
            s11 += cjk * cjk; s12 += cjk * other; s22 += other * other; s1y += cjk * y; s2y += other * y;
        }
        const det = s11 * s22 - s12 * s12;
        if (!(Math.abs(det) > 0)) continue;
        const a = (s1y * s22 - s2y * s12) / det;
        const b = (s2y * s11 - s1y * s12) / det;
        const est = (e) => a * e.answer.cjk + b * e.answer.other;
        const err = sum(calib.map(e => Math.abs(est(e) - e.usage.tokenOut) / e.usage.tokenOut)) / calib.length;
        const agents = [];
        const thinkers = [...new Set(entries.filter(e => ok(e) && thinksByDefault(e.agent) && !e.noThink).map(e => e.agent))].sort();
        for (const agent of thinkers) {
            const items = entries.filter(e => ok(e) && e.agent === agent && !e.noThink);
            const outs = sum(items.map(e => e.usage.tokenOut));
            const answers = sum(items.map(e => Math.min(est(e), e.usage.tokenOut)));
            agents.push({
                agent, n: items.length,
                meanOut: outs / items.length,
                meanAnswer: answers / items.length,
                meanThinking: (outs - answers) / items.length,
                share: outs > 0 ? (outs - answers) / outs : null
            });
        }
        out.push({ model, coef: { a, b }, calibN: calib.length, calibAgents: [...new Set(calib.map(e => e.agent))].sort(), calibErr: err, agents });
    }
    return out;
}

/**
 * verify 的 uncertain 比例：cacheKeyParts.sampleNo＝2 的支數 ÷ sampleNo＝1 的支數（uncertain 才會有第二次採樣）。純函式。
 * @returns {{rate:number, first:number, second:number}|null}
 */
function verifyUncertainRate(entries) {
    const v = entries.filter(e => /^verify(_chem)?$/.test(e.agent) && !e.noThink && e.sampleNo !== null);
    const first = v.filter(e => e.sampleNo === 1).length;
    const second = v.filter(e => e.sampleNo === 2).length;
    return first > 0 ? { rate: second / first, first, second } : null;
}

/**
 * 第 4 段：一份卷（預設 10 題、4 頁、OCR 為主）在各步驟的時間，低／高兩個估計。純函式。
 * 量得到的用回放檔（p50 當低、p90 當高）；量不到的用 PAPER_ASSUMPTIONS 與推算的速度，逐列寫依據。
 * 看圖拆題（extract_vision）不算進來：Owner 已決定本機拆題改成 OCR 為主（另一條分支）；它的時間看 npm run local:bench-vision。
 * @param {{stats:Map<string,object>, speeds:ReturnType<typeof estimateSpeeds>, thinking:ReturnType<typeof estimateThinking>,
 *          entries:ReturnType<typeof toEntry>[], settings:ReturnType<typeof currentSettings>, paper:{questions:number, pages:number},
 *          textModel?:string}} input
 */
function estimatePaper({ stats, speeds, thinking, entries, settings, paper, textModel = 'qwen3:8b' }) {
    const A = PAPER_ASSUMPTIONS;
    const Q = paper.questions;
    const P = paper.pages;
    const chunkPages = settings.JOB_PDF_CHUNK_PAGES.value;
    const chunks = Math.ceil(P / chunkPages);
    const sp = speedFor(speeds, textModel);
    const tokSec = (tin, tout) => (sp.outTps && sp.promptTps ? tin / sp.promptTps + tout / sp.outTps : null);
    const rows = [];
    const row = (r) => {
        const total = {
            low: r.perCallMs.low === null ? null : r.calls.low * r.perCallMs.low,
            high: r.perCallMs.high === null ? null : r.calls.high * r.perCallMs.high
        };
        rows.push({ inTotal: true, ...r, total });
    };

    const ocr = stats.get('ocr');
    if (ocr && ocr.pages) {
        row({
            key: 'ocr', label: 'PaddleOCR（每塊一次）', calls: { low: chunks, high: chunks },
            perCallMs: { low: ocr.pages.secPerPage * chunkPages * 1000, high: ocr.pages.p90SecPerPage * chunkPages * 1000 },
            basis: `ocr 回放檔 ${ocr.n} 支，每頁平均 ${fmtDur(ocr.pages.secPerPage * 1000)}、p90 ${fmtDur(ocr.pages.p90SecPerPage * 1000)}，× 每塊 ${chunkPages} 頁` +
                (ocr.n < RULES.MIN_SAMPLES ? `（${LOW_SAMPLE_LABEL}；含每次啟動 Python 與載入 OCR 模型）` : '')
        });
    }

    const exo = stats.get('extract_ocr');
    if (exo) {
        row({
            key: 'extract_ocr', label: 'OCR 結果整理成題目（qwen3:8b，每塊一次）', calls: { low: chunks, high: chunks },
            perCallMs: { low: exo.p50Ms, high: exo.p90Ms }, basis: `extract_ocr 回放檔 ${exo.n} 支（p50／p90）`
        });
    } else {
        const tin = A.EXTRACT_OCR_FIXED_TOKENS + A.OCR_TOKENS_PER_PAGE * chunkPages;
        const tout = A.EXTRACT_OUT_TOKENS_PER_QUESTION * Q / chunks;
        const ms = tokSec(tin, tout);
        row({
            key: 'extract_ocr', label: 'OCR 結果整理成題目（qwen3:8b，每塊一次）', calls: { low: chunks, high: chunks },
            perCallMs: { low: ms === null ? null : ms * 1000, high: ms === null ? null : ms * 1000 },
            basis: `**估計**（沒有本機 extract_ocr 回放檔）：每塊讀約 ${fmtInt(tin)} token、寫約 ${fmtInt(tout)} token，照 1.3 段的速度換算`
        });
    }

    const cls = stats.get('classify');
    if (cls) {
        const cold = cls.avgTokenIn !== null ? tokSec(cls.avgTokenIn, cls.avgTokenOut) : null;
        row({
            key: 'classify', label: '分類（第一層閘門沒過才呼叫 LLM）',
            calls: { low: Q * A.CLASSIFY_LLM_RATE.low, high: Q * A.CLASSIFY_LLM_RATE.high },
            perCallMs: { low: cls.p50Ms, high: cold !== null ? Math.max(cold * 1000, cls.p90Ms) : cls.p90Ms },
            basis: `每次：低＝回放檔 p50 ${fmtDur(cls.p50Ms)}（錄製時一支接一支，prompt 快取是熱的）；` +
                `高＝${cold !== null ? `冷的 prompt（讀 ${fmtInt(cls.avgTokenIn)}、寫 ${fmtInt(cls.avgTokenOut)} token）約 ${fmtDur(cold * 1000)}` : `p90 ${fmtDur(cls.p90Ms)}`}` +
                `——正式上傳時每題之間夾著 lint、驗算與向量，快取多半已被換掉。呼叫比例 ${pct(A.CLASSIFY_LLM_RATE.low)}～${pct(A.CLASSIFY_LLM_RATE.high)}（本機拆題的信心分數還沒有資料）`
        });
    }

    const lint = stats.get('lint');
    if (lint) {
        row({
            key: 'lint', label: 'lint 第三層（LLM 重寫；規則修不好才呼叫）',
            calls: { low: Q * A.LINT_LLM_RATE.low, high: Q * A.LINT_LLM_RATE.high },
            perCallMs: { low: lint.p50Ms, high: lint.p90Ms },
            basis: `lint 回放檔 ${lint.n} 支（p50／p90${lint.n < RULES.MIN_SAMPLES ? `；${LOW_SAMPLE_LABEL}` : ''}）；觸發比例 ${pct(A.LINT_LLM_RATE.low)}～${pct(A.LINT_LLM_RATE.high)}（見假設）`
        });
    }

    const ver = stats.get('verify');
    const unc = verifyUncertainRate(entries);
    const uncRate = unc ? unc.rate : A.VERIFY_UNCERTAIN_RATE_FALLBACK;
    if (ver) {
        row({
            key: 'verify', label: '驗算（證明題以外每題；uncertain 再採樣、不一致原地重跑一次）',
            calls: { low: Q, high: Q * (1 + uncRate) * (1 + A.VERIFY_FAIL_RATE.high) },
            perCallMs: { low: ver.p50Ms, high: ver.p90Ms },
            basis: `verify 回放檔 ${ver.n} 支（p50／p90）；uncertain 再採樣 ${pct(uncRate)}` +
                (unc ? `（第 2 次採樣 ${unc.second} 支 ÷ 第 1 次 ${unc.first} 支）` : '（沒有 sampleNo，用預設）') +
                `；判定不一致 ${pct(A.VERIFY_FAIL_RATE.low)}～${pct(A.VERIFY_FAIL_RATE.high)} 時整個節點再跑一次（本機沒有資料）`
        });
    }

    // 知識點標註：FEATURE_KC_TAGGING 預設關，不算進合計
    const kcs = stats.get('kc_tag');
    const shares = thinking.flatMap(t => t.agents).filter(a => a.share !== null && /^(lint|verify)(_chem)?$/.test(a.agent));
    const meanShare = shares.length ? sum(shares.map(a => a.share)) / shares.length : null;
    let kcThinkTokens = null;
    if (kcs) {
        rows.push({
            inTotal: false, key: 'kc_tag', label: '知識點標註（FEATURE_KC_TAGGING 開啟時、kc:backfill；預設關，不算進合計）',
            calls: { low: Q, high: Q }, perCallMs: { low: kcs.p50Ms, high: kcs.p90Ms },
            total: { low: Q * kcs.p50Ms, high: Q * kcs.p90Ms }, basis: `kc_tag 回放檔 ${kcs.n} 支`
        });
    } else {
        kcThinkTokens = meanShare !== null && meanShare < 1 ? A.KC_TAG_ANSWER_TOKENS * meanShare / (1 - meanShare) : null;
        const ms = kcThinkTokens !== null ? tokSec(A.KC_TAG_IN_TOKENS, A.KC_TAG_ANSWER_TOKENS + kcThinkTokens) : null;
        rows.push({
            inTotal: false, key: 'kc_tag', label: '知識點標註（FEATURE_KC_TAGGING 開啟時、kc:backfill；預設關，不算進合計）',
            calls: { low: Q, high: Q }, perCallMs: { low: ms === null ? null : ms * 1000, high: ms === null ? null : ms * 1000 },
            total: { low: ms === null ? null : Q * ms * 1000, high: ms === null ? null : Q * ms * 1000 },
            basis: `**估計**（沒有本機 kc_tag 回放檔）：讀約 ${fmtInt(A.KC_TAG_IN_TOKENS)}、回答約 ${fmtInt(A.KC_TAG_ANSWER_TOKENS)} token，` +
                `思考照 lint／verify 的平均比例${meanShare !== null ? ` ${pct(meanShare)}` : ''}推＝約 ${fmtInt(kcThinkTokens)} token`
        });
    }

    const counted = rows.filter(r => r.inTotal);
    const total = {
        low: sum(counted.map(r => r.total.low || 0)),
        high: sum(counted.map(r => r.total.high || 0)),
        missing: counted.filter(r => r.total.low === null || r.total.high === null).map(r => r.key)
    };

    // 選項 a／b／c 省下的時間。與上面的列同一個口徑（低＝p50 那一次、高＝p90 那一次）：
    //   每次省＝思考比例 ×（那一次的延遲 − 讀 prompt 的時間）；讀 prompt＝平均讀的 token ÷ 冷的讀 prompt 速度（不知道時當 0）。
    //   沒有回放檔的（知識點標註）＝估計的思考 token ÷ 輸出速度。
    const thinkOf = (agent) => {
        for (const t of thinking) {
            if (t.model !== textModel) continue;
            const a = t.agents.find(x => x.agent === agent);
            if (a) return a;
        }
        return null;
    };
    const savings = [];
    const byKey = new Map(rows.map(r => [r.key, r]));
    const addSaving = (option, agent, key) => {
        const r = byKey.get(key);
        const s = stats.get(agent);
        if (agent === 'kc_tag' && !kcs) {
            if (!r || kcThinkTokens === null || !sp.outTps) {
                savings.push({ option, agent, perCallMs: null, total: null, note: '資料不足' });
                return;
            }
            const ms = kcThinkTokens / sp.outTps * 1000;
            savings.push({
                option, agent, thinkingTokens: kcThinkTokens, perCallMs: { low: ms, high: ms },
                total: { low: r.calls.low * ms, high: r.calls.high * ms }, inTotal: r.inTotal, note: '估計（沒有本機回放檔）'
            });
            return;
        }
        const th = thinkOf(agent);
        if (!r || !s || !th || th.share === null) {
            savings.push({ option, agent, perCallMs: null, total: null, note: '資料不足' });
            return;
        }
        const promptMs = Number.isFinite(s.avgTokenIn) && sp.promptTps ? s.avgTokenIn / sp.promptTps * 1000 : 0;
        const perCallMs = { low: th.share * Math.max(0, s.p50Ms - promptMs), high: th.share * Math.max(0, s.p90Ms - promptMs) };
        savings.push({
            option, agent, thinkingTokens: th.meanThinking, share: th.share, perCallMs,
            total: { low: r.calls.low * perCallMs.low, high: r.calls.high * perCallMs.high }, inTotal: r.inTotal,
            note: `${th.n} 支回放檔：思考約占輸出 ${pct(th.share)}，× 每次延遲（p50／p90）扣掉讀 prompt 約 ${fmtDur(promptMs)}`
        });
    };
    addSaving('a', 'lint', 'lint');
    addSaving('b', 'kc_tag', 'kc_tag');
    addSaving('c', 'verify', 'verify');

    return { questions: Q, pages: P, chunkPages, chunks, speed: sp, rows, total, savings, uncertain: unc, uncRate, meanShare };
}

function pct(x) { return `${Math.round(x * 100)}%`; }

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
    // 〔dec/local-thinking-speed〕推算速度、思考比例、一份卷（第 1.3～1.5 段、第 4 段）只看本機的呼叫
    const localSelected = selected.filter(e => LOCAL_VENDORS.includes(e.vendor));
    const speeds = estimateSpeeds(localSelected);
    const thinking = estimateThinking(localSelected);
    const paperSize = {
        questions: (args.paper && args.paper.questions) || PAPER_ASSUMPTIONS.QUESTIONS,
        pages: (args.paper && args.paper.pages) || PAPER_ASSUMPTIONS.PAGES
    };
    // 一份卷的估計用「現狀」（程式預設會思考）的呼叫；OLLAMA_NO_THINK 錄的另外在第 1 段看
    const defaultStats = new Map(summarizeGroups(localSelected.filter(e => !e.noThink), { byModel: false }).map(s => [s.agent, s]));
    const paper = defaultStats.size
        ? estimatePaper({ stats: defaultStats, speeds, thinking, entries: localSelected, settings, paper: paperSize })
        : null;
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
                agentCell(g),
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
        L.push('');
        // 〔看圖拆題逾時〕Ollama 自己量的分段時間：讀 prompt（含看圖）與輸出分開看，才知道慢在哪一段
        L.push('### 1.1 讀 prompt（含看圖）與輸出各花多久（Ollama 自己量的分段時間）');
        L.push('');
        const timed = groups.filter(g => g.timing);
        if (!timed.length) {
            L.push('這批 cassette 沒有分段時間（`usage.timing`；2026-09-26 之前的版本錄的不會有）。用新版重錄之後，這裡會分開列出' +
                '讀 prompt（視覺模型看圖也在這一段）與輸出各花多久；也可以先用 `npm run local:bench-vision` 量一頁（docs/local-mode.md 第 10.11 條）。');
        } else {
            L.push(table(
                ['agent', '模型', '有分段時間的支數', '載入模型（平均）', '讀 prompt（平均／最長）', '讀 prompt token/秒', '每頁讀圖',
                    '輸出（平均／最長）', '純輸出 token/秒', '每頁輸出', '其他（排隊、傳輸；平均）'],
                timed.map(g => {
                    const t = g.timing;
                    return [
                        agentCell(g), g.model ? `\`${g.model}\`` : '—', String(t.n),
                        fmtDur(t.meanLoadMs),
                        `${fmtDur(t.meanPromptEvalMs)}／${fmtDur(t.maxPromptEvalMs)}`,
                        t.promptTokensPerSec == null ? '—' : t.promptTokensPerSec.toFixed(1),
                        t.promptEvalSecPerPage == null ? '—' : fmtDur(t.promptEvalSecPerPage * 1000),
                        `${fmtDur(t.meanEvalMs)}／${fmtDur(t.maxEvalMs)}`,
                        t.evalTokensPerSec == null ? '—' : t.evalTokensPerSec.toFixed(1),
                        t.evalSecPerPage == null ? '—' : fmtDur(t.evalSecPerPage * 1000),
                        fmtDur(t.meanOtherMs)
                    ];
                })
            ));
            L.push('');
            L.push('「讀 prompt」含系統提示詞、章節白名單與題目文字，視覺模型的頁面圖片也在這一段（Ollama 不再細分），所以「每頁讀圖」把固定的提示詞也按頁攤了；' +
                '「純輸出 token/秒」的分母只有生成的時間，比第 1 段含讀 prompt 的速度準。讀 prompt 占大半時，縮小送給視覺模型的圖片（`VISION_MAX_EDGE_PX`）最有效；' +
                '輸出占大半時，一塊少放幾頁（`JOB_PDF_CHUNK_PAGES`）比較有用（docs/local-mode.md 第 10.11 條）。');
        }
        // 〔dec/local-thinking-speed〕1.2～1.5
        L.push('');
        L.push(...tokenSection(tokenDistribution(groups.filter(g => g.vendor === 'ollama'), selected)));
        L.push(...speedSection(speeds));
        L.push(...thinkingSection(thinking, speeds));
        L.push(...ctrlEscapeSection(groups, selected));
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
                // 〔看圖拆題逾時〕pipeline 與 e2e 兩步另帶 3 小時（localMode.longCallRecordEnv）；eval 的 suite 不對節點計時
                L.push(`注意：\`.env\` 的 \`JOB_NODE_TIMEOUT_MS\` 只影響正式上傳。重錄（\`cassettes:rerecord\`）時固定帶 ${local.LOCAL_NODE_TIMEOUT_MS}` +
                    '（`eval/lib/localMode.js` 的 `LOCAL_NODE_TIMEOUT_MS`；classify、nlq、variant 三步），' +
                    `pipeline 與 e2e 兩步帶 ${local.RECORD_LONG_TIMEOUT_MS}（${fmtDur(local.RECORD_LONG_TIMEOUT_MS)}；\`RERECORD_NODE_TIMEOUT_MS\` 可改），都不讀 \`.env\`。` +
                    'eval 的 suite 只把節點逾時記在報表、不真的計時（只有 e2e 的 runner 會），所以重錄時真正會切斷呼叫的是 `OLLAMA_TIMEOUT_MS` 與 `OCR_TIMEOUT_MS`：' +
                    `pipeline 與 e2e 兩步的 \`OLLAMA_TIMEOUT_MS\` 至少 ${fmtDur(local.RECORD_LONG_TIMEOUT_MS)}（\`RERECORD_OLLAMA_TIMEOUT_MS\` 可改；\`.env\` 更長就照 \`.env\`），` +
                    '其餘步驟與 `OCR_TIMEOUT_MS` 照 `.env`。');
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

    // 〔dec/local-thinking-speed〕4. 一份卷的時間與加速選項
    L.push(...paperSection(paper, settings));

    return {
        markdown: `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
        data: {
            inventory: { dir: inv.dir, total: inv.entries.length, broken: inv.broken }, skipped, groups, agentStats, settings, recommendations: rec, overlaps, logs,
            speeds, thinking, paper
        }
    };
}

// ───────────────────────── 〔dec/local-thinking-speed〕第 1.2～1.5 段、第 4 段的文字 ─────────────────────────

/** 1.2 段 */
function tokenSection(rows) {
    const L = ['### 1.2 各 agent 讀／寫多少 token（要不要把 `OLLAMA_NUM_CTX` 降到 8192 看這裡）', ''];
    if (!rows.length) {
        L.push('沒有帶 token 數的本機回放檔。', '');
        return L;
    }
    const q = (x) => `${fmtInt(x.min)}／${fmtInt(x.p50)}／${fmtInt(x.p90)}／${fmtInt(x.max)}`;
    const verdict = (r) => {
        if (!r.fitsObserved) return `**放不下**：實測最多 ${fmtInt(r.totalMax)} token`;
        if (r.fitsWorst === null) return '實測放得下（這個 agent 不設輸出上限）';
        if (r.fitsWorst) return '放得下';
        return `實測放得下；寫到輸出上限（${fmtInt(r.maxOutputTokens)}）時會超過`;
    };
    L.push(table(['agent', '模型', '支數', '讀（最少／p50／p90／最多）', '寫（含思考；最少／p50／p90／最多）', '讀＋寫最多', '最多的讀＋輸出上限', `num_ctx ${SPEED_RULES.SMALL_CTX}`],
        rows.map(r => [agentCell(r), r.model ? `\`${r.model}\`` : '—', String(r.n), q(r.in), q(r.out), fmtInt(r.totalMax),
            r.worst === null ? '不設上限' : fmtInt(r.worst), verdict(r)])));
    L.push('');
    L.push(`讀＋寫超過 num_ctx 時 Ollama 會截掉前面的內容或提早停筆。「寫到輸出上限時會超過」只在模型寫得異常長（例如思考繞圈）時才會發生，那種呼叫本來就會失敗。` +
        '這裡沒有本機拆題（`extract_vision`／`extract_ocr`）的回放檔時要另外看：Owner 實測看 1 頁就讀 6,248、寫 1,786 token（合計約 8,000），' +
        '一塊 2 頁一定超過 8192，所以降 num_ctx 時要讓拆題的 agent 保留 16384（`OLLAMA_NUM_CTX_EXTRACT_VISION`、`OLLAMA_NUM_CTX_EXTRACT_OCR`，docs/local-mode.md 第 10.12 條）。');
    L.push('');
    return L;
}

/** 1.3 段 */
function speedSection(speeds) {
    const L = ['### 1.3 推算的讀 prompt 與輸出速度（舊回放檔沒有分段時間時）', ''];
    if (!speeds.byModel.length) {
        L.push('沒有本機模型的回放檔。', '');
        return L;
    }
    L.push(table(['模型', 'Ollama 量的（1.1 段）讀／輸出 token/秒', '連送兩次的對數', '推算：輸出 token/秒', '推算：冷的讀 prompt token/秒'],
        speeds.byModel.map(m => [
            `\`${m.model}\``,
            m.timing.promptTps || m.timing.outTps ? `${m.timing.promptTps ? m.timing.promptTps.toFixed(1) : '—'}／${m.timing.outTps ? m.timing.outTps.toFixed(2) : '—'}` : '沒有分段時間',
            String(m.pairs),
            m.outTps ? m.outTps.toFixed(2) : '—',
            m.coldPromptTps ? m.coldPromptTps.toFixed(1) : '—'
        ])));
    L.push('');
    L.push('「連送兩次」：同一段 prompt 緊接著再送一次（例如變式題 idx 1、2），Ollama 留著上一次的 prompt 快取，第二次幾乎只剩輸出——' +
        '第二次的「輸出 token ÷ 延遲」≈ 輸出速度（略為低估），第一次多出來的時間 ≈ 冷的讀 prompt。取各對的中位數。');
    if (speeds.regressions.length) {
        L.push('');
        L.push(`交叉檢查（讀的 token 數差不多的組，延遲對輸出 token 做迴歸：斜率＝每個輸出 token 幾秒；r² 低於 ${SPEED_RULES.REGRESS_MIN_R2} 的不列）：`);
        L.push('');
        L.push(table(['agent', '模型', '支數', '每個輸出 token', '→ 輸出 token/秒', '截距', 'r²'],
            speeds.regressions.map(r => [agentCell(r), `\`${r.model}\``, String(r.n), `${r.secPerOutToken.toFixed(3)} 秒`, r.outTps.toFixed(2),
                `${Math.round(r.interceptSec)} 秒`, r.r2.toFixed(2)])));
    }
    L.push('');
    L.push('為什麼要分開看：輸出（含思考）一個 token 要半秒上下，讀 prompt 一個 token 只要幾十毫秒；**同一段 prompt 剛讀過時幾乎不花時間**。' +
        '所以回放檔的延遲是「錄製時一支接一支、快取是熱的」的數字，正式上傳時每題之間夾著別的呼叫，分類這種讀很多的步驟會比回放檔慢（第 4 段的「高」）。');
    L.push('');
    return L;
}

/** 1.4 段 */
function thinkingSection(thinking, speeds) {
    const L = ['### 1.4 思考占了多少輸出（估計；選項 a／b／c 省多少從這裡來）', ''];
    const rows = [];
    for (const t of thinking) {
        const sp = speedFor(speeds, t.model);
        for (const a of t.agents) {
            rows.push([agentCell(a), `\`${t.model}\``, String(a.n), fmtInt(a.meanOut), fmtInt(a.meanAnswer), fmtInt(a.meanThinking),
                a.share === null ? '—' : pct(a.share), sp.outTps ? fmtDur(a.meanThinking / sp.outTps * 1000) : '—']);
        }
    }
    if (!rows.length) {
        L.push(thinking.length
            ? '沒有會思考的 agent（verify、lint、kc_tag、tutor）的本機回放檔。'
            : `不思考的本機回放檔少於 ${SPEED_RULES.CALIB_MIN_N} 支，換算不出「字數 → token 數」。`);
        L.push('');
        return L;
    }
    L.push(table(['agent', '模型', '支數', '平均輸出 token（含思考）', '其中回答（估）', '其中思考（估）', '思考比例', '每次思考花的時間（估）'], rows));
    L.push('');
    for (const t of thinking) {
        L.push(`換算（\`${t.model}\`）：用 ${t.calibN} 支不思考的回放檔（${t.calibAgents.map(a => `\`${a}\``).join('、')}）擬合「輸出 token ≈ ${t.coef.a.toFixed(2)} × 中文字數 ＋ ${t.coef.b.toFixed(2)} × 其他字數」，` +
            `平均誤差 ${pct(t.calibErr)}。會思考的 agent 的回答用同一條換算，輸出 token 減掉回答就是思考。`);
    }
    L.push('');
    L.push('關掉思考省下的是「思考」那一欄，但回答本身也可能變長或變短（例如驗算的 steps_summary）；而且思考會影響品質——' +
        '驗算是獨立檢查，不思考時算錯的題變多，判定不一致、停在複核的題也會變多。要知道實際差多少，用 `npm run local:bench-text` 開關各量一次（docs/local-mode.md 第 10.12 條）。');
    L.push('');
    return L;
}

/** 1.5 段：LaTeX 的反斜線被 JSON 吃掉 */
function ctrlEscapeSection(groups, entries) {
    const rows = [];
    for (const g of groups) {
        const items = entries.filter(e => e.agent === g.agent && (e.model ?? null) === (g.model ?? null) && !!e.noThink === !!g.noThink && e.answer);
        const bad = items.filter(e => e.ctrlEscapes).length;
        if (bad > 0) rows.push([agentCell(g), g.model ? `\`${g.model}\`` : '—', `${bad}／${items.length}`, pct(bad / items.length)]);
    }
    const L = ['### 1.5 公式的反斜線被 JSON 吃掉（輸出裡有控制字元緊接英文字母）', ''];
    if (!rows.length) {
        L.push('沒有發現。', '');
        return L;
    }
    L.push(table(['agent', '模型', '有問題的支數／有回答的支數', '比例'], rows));
    L.push('');
    L.push('模型在 JSON 字串裡把 LaTeX 寫成單一反斜線時，`\\frac`、`\\times`、`\\theta`、`\\rightarrow`、`\\beta` 的 `\\f`、`\\t`、`\\r`、`\\b` 是合法的 JSON 跳脫，' +
        '解析後變成換頁、tab、歸位、退格字元（`\\frac` → 換頁＋`rac`）。公式閘門（lint 的規則層）多半看不出來（例 `\\times` → tab＋`imes`），就帶著壞公式入庫。' +
        '這是品質問題、不是速度設定能解決的，要不要修見 docs/local-mode.md 第 10.12 條（待 Owner 決定）。');
    L.push('');
    return L;
}

/** 第 4 段 */
function paperSection(paper, settings) {
    const L = ['## 4. 一份卷在拆題以外的時間都花在哪裡（估計；待 Owner 決定的加速選項）', ''];
    if (!paper) {
        L.push('沒有本機模型（Ollama／PaddleOCR）的資料，估不出來。', '');
        return L;
    }
    const range = (lo, hi) => (lo === null || hi === null ? '—' : (Math.abs(lo - hi) < 500 ? fmtDur(lo) : `${fmtDur(lo)}～${fmtDur(hi)}`));
    const calls = (c) => (Math.abs(c.low - c.high) < 1e-9 ? round1(c.low) : `${round1(c.low)}～${round1(c.high)}`);
    L.push(`一份 ${paper.questions} 題、${paper.pages} 頁的卷，每塊 ${paper.chunkPages} 頁（\`JOB_PDF_CHUNK_PAGES\`＝${settings.JOB_PDF_CHUNK_PAGES.value}，${settings.JOB_PDF_CHUNK_PAGES.source}）＝${paper.chunks} 塊，` +
        `OCR 為主（看圖拆題 \`extract_vision\` 不算：Owner 已決定本機拆題改成 OCR 為主；它的時間用 \`npm run local:bench-vision\` 量）。` +
        `速度用 1.3 段的 \`qwen3:8b\`：${paper.speed.outTps ? `輸出 ${paper.speed.outTps.toFixed(2)} token/秒` : '輸出速度不明'}、` +
        `${paper.speed.promptTps ? `冷的讀 prompt ${paper.speed.promptTps.toFixed(1)} token/秒` : '讀 prompt 速度不明'}（${paper.speed.source}）。`);
    L.push('');
    L.push(table(['步驟', '呼叫次數', '每次', '合計', '依據'], paper.rows.map(r => [
        r.label, calls(r.calls), range(r.perCallMs.low, r.perCallMs.high), range(r.total.low, r.total.high), r.basis
    ])));
    L.push('');
    L.push(`**合計（拆題以外＋OCR 為主的拆題；不含知識點標註）：${range(paper.total.low, paper.total.high)}**` +
        (paper.total.missing.length ? `（${paper.total.missing.join('、')} 算不出來，沒算進去）` : '') +
        '。低＝每一步都用 p50、呼叫次數取少的；高＝p90（分類用冷的 prompt）、呼叫次數取多的。');
    L.push('');
    L.push('沒算進去的：模型載入（Ollama 換模型或 `OLLAMA_KEEP_ALIVE` 過期後每次 1～2 分鐘，見 docs/local-mode.md 第 10.12 條的「換載」）、' +
        '找相似題的向量（`qwen3-embedding:0.6b`，一次幾秒）、排隊、驗算失敗後的人工複核。');
    L.push('');
    L.push('### 4.1 加速選項能省多少（估計；預設都沒有改，待 Owner 決定）');
    L.push('');
    const optLabel = { a: '(a) lint 不思考（`OLLAMA_NO_THINK=lint`）', b: '(b) 知識點標註不思考（`OLLAMA_NO_THINK=kc_tag`）', c: '(c) 驗算不思考（`OLLAMA_NO_THINK=verify`）' };
    L.push(table(['選項', '每次省（估）', '一份卷省（估）', '依據'], paper.savings.map(s => [
        optLabel[s.option],
        s.perCallMs === null ? '—' : `${range(s.perCallMs.low, s.perCallMs.high)}（思考平均約 ${fmtInt(s.thinkingTokens)} token）`,
        s.total === null ? '—' : `${range(s.total.low, s.total.high)}${s.inTotal === false ? '（開了知識點標註才有）' : ''}`,
        s.note
    ])));
    L.push('');
    L.push('(c) 還有「只降輸出上限」（`OLLAMA_MAX_OUTPUT_VERIFY`）：平常的呼叫省不到時間（實測最多只寫一千多 token），只縮短模型思考繞圈時的最壞情況；' +
        '(d) `OLLAMA_NUM_CTX` 降到 8192、(e) Ollama 伺服器設定與關掉其他程式：只有在記憶體不夠、系統在換頁時才會變快，回放檔量不出來，' +
        '要照 docs/local-mode.md 第 10.12 條在自己的電腦上量。');
    L.push('');
    return L;
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
    RULES, LOW_SAMPLE_LABEL, SETTING_DEFAULTS, STEP_LABEL_PREFIXES, LOCAL_VENDORS, VENDOR_CHOICES, DEFAULT_CASSETTE_DIR, USAGE,
    // 〔dec/local-thinking-speed〕
    charCounts, hasCtrlEscapes, tokenDistribution, estimateSpeeds, speedFor, estimateThinking, verifyUncertainRate, estimatePaper,
    maxOutputOf, thinksByDefault, SPEED_RULES, PAPER_ASSUMPTIONS, KV_BYTES_PER_TOKEN_8B
};
