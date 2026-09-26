// ─────────────────────────────────────────────────────────────
// eval/tools/local_bench_vision.js — 看圖拆題的本機量測（npm run local:bench-vision；docs/local-mode.md 第 10.11 條）
//
// 給 Owner 在自己的電腦上先量「視覺模型看一頁要多久」，再決定逾時與加速選項——不必等一整輪重錄或上傳一份卷才知道。
//
//   npm run local:bench-vision                                   預設：eval/fixtures/sample_exam.pdf 第 1 頁、200 DPI
//   npm run local:bench-vision -- --pdf 考卷.pdf --pages 1 --dpi 200
//   npm run local:bench-vision -- --max-edge 1600                比較選項 b（送出前縮圖）
//
// 做的事（只有這些）：
//   1. 用 mupdf 把 PDF 的第 from～from+pages-1 頁轉成 PNG（與本機拆題沒有 OCR 圖時同一支 services/ocr/render.js）；
//   2. 先請 Ollama 卸載視覺模型（--warm 可略過）：量到的時間才含模型載入、也不會吃到上一次的快取——
//      正式拆題時每一塊都要重新載入 qwen3-vl（中間換過 qwen3:8b 整理 OCR 結果）；
//   3. **只呼叫一次** qwen3-vl：送出的系統提示詞、提示詞、schema、輸出上限與 agents/extract.js 的 extract_vision 一模一樣；
//      串流、每隔 --progress-sec 秒印一次「已輸出 N token」；
//   4. 印出 Ollama 自己量的分段時間（載入、讀 prompt〔含看圖〕、輸出）、token 數、速度，
//      並依這些數字推估「一塊 1 頁／一塊 N 頁（目前的 JOB_PDF_CHUNK_PAGES）／一份 4 頁卷」的看圖拆題要多久、對照目前的逾時。
//   --baseline 另外多一次「只有文字、輸出 1 個 token」的短呼叫（前後各卸載一次），把讀 prompt 拆成「固定的文字」與「每頁圖片」，
//   推估就不必把固定的提示詞也按頁乘上去（預設不做：線性外推，偏保守）。
//
// 不寫 cassette（直接呼叫 services/llm/ollama.js，不經 services/llm 的 record／replay）、不碰資料庫、不改 .env。
// 逾時用 --timeout-min（預設 180 分）取代 OLLAMA_TIMEOUT_MS，只在這一次量測有效——量測本身不該被 30 分切掉。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');

/** 一份卷的頁數（推估用；Owner 的考卷多半 4 頁） */
const PAPER_PAGES = 4;
/** 最多量幾頁（一次呼叫；再多就等於直接拆一塊了） */
const MAX_PAGES = 4;
/** 建議逾時的倍數：與 npm run perf:local 的「2 × max」同一條規則（只有一次量測，它就是 max） */
const TIMEOUT_FACTOR = 2;
const ROUND_MS = 60_000;

const USAGE = `用法：npm run local:bench-vision -- [選項]

  --pdf <路徑>          要量的 PDF（預設 eval/fixtures/sample_exam.pdf）
  --from <頁>           從第幾頁開始（預設 1）
  --pages <N>           送幾頁（預設 1，最多 ${MAX_PAGES}）；一次呼叫，與拆題一塊同樣的送法
  --dpi <DPI>           頁面轉圖片的解析度（預設 .env 的 OCR_DPI，沒寫是 200）
  --max-edge <像素>     送出前把圖片長邊縮到這個像素（預設 .env 的 VISION_MAX_EDGE_PX，沒寫不縮；0＝不縮）
  --model <模型>        預設 .env 的 MODEL_EXTRACT（必須是 ollama:…）
  --baseline            另外量一次「只有文字」，把讀 prompt 拆成固定文字與每頁圖片（多 2～5 分鐘）
  --warm                不先卸載模型（量到的時間不含載入；預設會先卸載）
  --timeout-min <分>    這一次量測的逾時（預設 180；不改 .env 的 OLLAMA_TIMEOUT_MS）
  --progress-sec <秒>   每隔幾秒印一次輸出進度（預設 60；0＝不印）
  -h, --help            顯示這段說明

只呼叫視覺模型（--baseline 時多一次短呼叫）：不寫 cassette、不碰資料庫、不改 .env。
Ollama 要開著；量測期間電腦會很忙，一頁可能要半小時以上。`;

// ───────────────────────── 參數 ─────────────────────────

function intArg(v, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} 要是 ${min}～${max} 的整數，收到「${v}」`);
    return n;
}

/**
 * @param {string[]} argv
 * @param {{cwd?:string}} [opts]
 */
function parseArgs(argv, { cwd = process.cwd() } = {}) {
    const args = {
        pdf: DEFAULT_PDF, from: 1, pages: 1, dpi: null, maxEdge: null, model: null,
        baseline: false, warm: false, timeoutMin: 180, progressSec: 60, help: false
    };
    const value = (i, flag) => {
        const v = argv[i];
        if (v === undefined || v === '' || /^--?[a-z]/i.test(v)) throw new Error(`${flag} 後面要接一個值\n\n${USAGE}`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--pdf': args.pdf = path.resolve(cwd, value(++i, a)); break;
            case '--from': args.from = intArg(value(++i, a), a, { min: 1 }); break;
            case '--pages': args.pages = intArg(value(++i, a), a, { min: 1, max: MAX_PAGES }); break;
            case '--dpi': args.dpi = intArg(value(++i, a), a, { min: 72, max: 600 }); break;
            case '--max-edge': args.maxEdge = intArg(value(++i, a), a, { min: 0, max: 10000 }); break;
            case '--model': args.model = String(value(++i, a)).trim(); break;
            case '--baseline': args.baseline = true; break;
            case '--warm': args.warm = true; break;
            case '--timeout-min': args.timeoutMin = intArg(value(++i, a), a, { min: 1, max: 24 * 60 }); break;
            case '--progress-sec': args.progressSec = intArg(value(++i, a), a, { min: 0, max: 3600 }); break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    if (args.maxEdge !== null && args.maxEdge > 0 && args.maxEdge < 512) throw new Error('--max-edge 小於 512 像素幾乎一定看不清題目；要不縮就給 0');
    return args;
}

// ───────────────────────── 設定 ─────────────────────────

function positiveInt(v) {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 目前生效的相關設定（.env 明寫的正整數優先，否則是本機預設）。純函式。
 * @param {Record<string,string|undefined>} env
 */
function currentSettings(env = {}) {
    const ollama = require('../../services/llm/ollama');
    const runner = require('../../workers/jobRunner');
    const pick = (k, dflt) => {
        const n = positiveInt(env[k]);
        return n ? { value: n, source: '.env' } : { value: dflt, source: '本機預設' };
    };
    return {
        OLLAMA_TIMEOUT_MS: pick('OLLAMA_TIMEOUT_MS', ollama.DEFAULT_TIMEOUT_MS),
        JOB_NODE_TIMEOUT_MS: pick('JOB_NODE_TIMEOUT_MS', runner.LOCAL_NODE_TIMEOUT_MS),
        JOB_PDF_CHUNK_PAGES: pick('JOB_PDF_CHUNK_PAGES', runner.LOCAL_PDF_CHUNK_PAGES),
        OLLAMA_NUM_CTX: pick('OLLAMA_NUM_CTX', ollama.DEFAULT_NUM_CTX)
    };
}

// ───────────────────────── 推估（純函式） ─────────────────────────

/**
 * 量到的一次呼叫 → 推估。
 * 模型：一塊 n 頁 ≈ 載入 + 固定文字的讀 prompt + n ×（每頁圖片的讀 prompt + 每頁輸出）。
 *   沒有 --baseline 時「固定文字」併進每頁（線性外推）：頁數越多估得越保守（偏長），頁數比量測時少會低估。
 *   輸出按頁攤：題目數大致與頁數成正比。載入每一塊都算一次（正式拆題時中間換過 qwen3:8b，視覺模型要重新載入）。
 * @param {{pages:number, loadMs:number|null, promptEvalMs:number, evalMs:number, tokenIn:number, tokenOut:number}} m
 * @param {ReturnType<typeof currentSettings>} settings
 * @param {{baseline?:{promptEvalMs:number, tokenIn:number}|null, maxOutputTokens?:number}} [opts]
 */
function estimate(m, settings, { baseline = null, maxOutputTokens = 8192 } = {}) {
    const p = m.pages;
    const useBaseline = !!(baseline && Number.isFinite(baseline.promptEvalMs) && Number.isFinite(baseline.tokenIn)
        && baseline.promptEvalMs > 0 && baseline.promptEvalMs < m.promptEvalMs && baseline.tokenIn > 0 && baseline.tokenIn < m.tokenIn);
    const fixedMs = useBaseline ? baseline.promptEvalMs : 0;
    const fixedTokens = useBaseline ? baseline.tokenIn : 0;
    const perPage = {
        promptEvalMs: (m.promptEvalMs - fixedMs) / p,
        evalMs: m.evalMs / p,
        tokenIn: (m.tokenIn - fixedTokens) / p,
        tokenOut: m.tokenOut / p
    };
    const loadMs = m.loadMs || 0;
    const chunk = (n) => {
        const ms = loadMs + fixedMs + n * (perPage.promptEvalMs + perPage.evalMs);
        const tokensIn = fixedTokens + n * perPage.tokenIn;
        const tokensOut = n * perPage.tokenOut;
        return { pages: n, ms, tokensIn, tokensOut, needTimeoutMs: Math.ceil((TIMEOUT_FACTOR * ms) / ROUND_MS) * ROUND_MS };
    };
    const c = settings.JOB_PDF_CHUNK_PAGES.value;
    const chunks = [];
    for (let from = 1; from <= PAPER_PAGES; from += c) chunks.push(chunk(Math.min(c, PAPER_PAGES - from + 1)));
    const numCtx = settings.OLLAMA_NUM_CTX.value;
    const current = chunk(c);
    return {
        method: useBaseline ? 'baseline' : 'linear',
        fixed: { promptEvalMs: fixedMs, tokenIn: fixedTokens },
        perPage,
        onePage: chunk(1),
        current,
        paper: { pages: PAPER_PAGES, chunkPages: c, chunks: chunks.length, ms: chunks.reduce((a, x) => a + x.ms, 0) },
        ctx: {
            numCtx,
            // 讀＋預期會寫的 token 超過 num_ctx：Ollama 會截掉前面的內容或輸出被截斷
            over: current.tokensIn + current.tokensOut > numCtx,
            // 讀＋輸出上限（num_predict）超過 num_ctx：模型寫得比平常長時才會出事
            overWithMax: current.tokensIn + maxOutputTokens > numCtx,
            maxOutputTokens
        }
    };
}

// ───────────────────────── 輸出 ─────────────────────────

function fmtInt(n) {
    return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');
}

function fmtRate(tokens, ms) {
    return ms > 0 && Number.isFinite(tokens) ? `${(tokens / (ms / 1000)).toFixed(1)} token/秒` : '—';
}

/**
 * 組報告（純函式）。
 * @param {object} r main() 收集的結果
 * @returns {string}
 */
function formatReport(r) {
    const { fmtDur } = require('./local_perf_report');
    const L = [];
    const s = r.settings;
    const setting = (k) => `${k}=${s[k].value}（${/_MS$/.test(k) ? `${fmtDur(s[k].value)}，` : ''}${s[k].source}）`;
    L.push('');
    L.push('══ 看圖拆題量測（npm run local:bench-vision）══════════════════════════');
    L.push(`模型：${r.model}（Ollama ${r.host}）`);
    L.push(`PDF：${r.pdfLabel} 第 ${r.from}${r.pages > 1 ? `～${r.from + r.pages - 1}` : ''} 頁（${r.pages} 頁、一次送出），${r.dpi} DPI`);
    L.push(`圖片：${r.images.map(im => `${im.width}×${im.height} px、${fmtInt(im.bytes / 1024)} KB`).join('；')}` +
        (r.maxEdge > 0 ? `（送出前長邊縮到 ${r.maxEdge} px；原圖 ${r.originals.map(im => `${im.width}×${im.height}`).join('、')}）` : '（沒有縮圖）'));
    L.push(`設定：${['OLLAMA_NUM_CTX', 'JOB_PDF_CHUNK_PAGES', 'OLLAMA_TIMEOUT_MS', 'JOB_NODE_TIMEOUT_MS'].map(setting).join('、')}`);
    L.push(`載入：${r.warm ? '沒有先卸載（--warm），載入時間可能接近 0' : '量測前先卸載模型，時間含載入（與正式拆題每一塊相同）'}`);
    L.push('');

    if (r.outcome === 'error') {
        L.push(`❌ 沒有量到：${r.error}`);
        if (r.errorClass === 'timeout') {
            L.push(`   一頁在 ${fmtDur(r.timeoutMs)} 內都沒有做完。可以：加大 --timeout-min 再量一次；或先試選項 b（--max-edge 1600）；` +
                '或看 Ollama 是不是其實卡住了（工作管理員裡 ollama 的 CPU 使用率掉到 0）。');
        }
        L.push(`   牆鐘 ${fmtDur(r.wallMs)}；中斷前輸出了多少 token 見上面最後一行進度。`);
        return `${L.join('\n')}\n`;
    }

    const t = r.timing;
    L.push(r.outcome === 'ok'
        ? `結果：拆出 ${r.questions} 題（JSON 合法）。`
        : `結果：模型輸出的 JSON 不合法${r.finishReason ? `（finishReason ${r.finishReason}${r.finishReason === 'MAX_TOKENS' ? '：寫到輸出上限被截斷' : ''}）` : ''}——下面的時間照樣有效。`);
    L.push('');
    const rows = [
        ['載入模型', fmtDur(t.loadMs), '—', '—'],
        [`讀 prompt（系統提示詞＋章節白名單＋${r.pages} 頁圖片）`, fmtDur(t.promptEvalMs), fmtInt(r.usage.tokenIn), fmtRate(r.usage.tokenIn, t.promptEvalMs)]
    ];
    const e = r.estimate;
    if (e.method === 'baseline') {
        rows.push(['　其中固定的文字（--baseline 量的）', fmtDur(e.fixed.promptEvalMs), fmtInt(e.fixed.tokenIn), fmtRate(e.fixed.tokenIn, e.fixed.promptEvalMs)]);
        rows.push(['　其中圖片（每頁）', fmtDur(e.perPage.promptEvalMs), fmtInt(e.perPage.tokenIn), fmtRate(e.perPage.tokenIn, e.perPage.promptEvalMs)]);
    }
    rows.push(['輸出（含思考）', fmtDur(t.evalMs), fmtInt(r.usage.tokenOut), fmtRate(r.usage.tokenOut, t.evalMs)]);
    rows.push(['Ollama 計時合計', fmtDur(t.totalMs), '—', '—']);
    rows.push(['牆鐘（含傳輸）', fmtDur(r.wallMs), '—', '—']);
    L.push('| 階段 | 時間 | token | 速度 |');
    L.push('|---|---:|---:|---:|');
    for (const row of rows) L.push(`| ${row.join(' | ')} |`);
    L.push('');
    L.push(`每頁：讀 prompt ${fmtDur(e.perPage.promptEvalMs)}（${fmtInt(e.perPage.tokenIn)} token）、輸出 ${fmtDur(e.perPage.evalMs)}（${fmtInt(e.perPage.tokenOut)} token）` +
        (e.method === 'baseline' ? '。' : '（沒有 --baseline：固定的提示詞也算在每頁裡，推到更多頁時偏保守）。'));
    L.push('');

    const verdict = (ms, limit) => (ms <= limit ? '在逾時之內' : `**超過**（估 ${fmtDur(ms)} > ${fmtDur(limit)}）`);
    const ollamaLimit = s.OLLAMA_TIMEOUT_MS.value;
    L.push(`推估（只算看圖拆題 extract_vision 一步；${e.method === 'baseline' ? '固定文字＋每頁圖片' : '線性外推'}，每一塊都含一次模型載入）：`);
    L.push('');
    L.push('| 情境 | 估計 | 讀／寫 token | 對照 OLLAMA_TIMEOUT_MS |');
    L.push('|---|---:|---:|---|');
    L.push(`| 一塊 1 頁（JOB_PDF_CHUNK_PAGES=1） | ${fmtDur(e.onePage.ms)} | ${fmtInt(e.onePage.tokensIn)}／${fmtInt(e.onePage.tokensOut)} | ${verdict(e.onePage.ms, ollamaLimit)} |`);
    if (e.current.pages !== 1) {
        L.push(`| 一塊 ${e.current.pages} 頁（目前的 JOB_PDF_CHUNK_PAGES） | ${fmtDur(e.current.ms)} | ${fmtInt(e.current.tokensIn)}／${fmtInt(e.current.tokensOut)} | ${verdict(e.current.ms, ollamaLimit)} |`);
    }
    L.push(`| 一份 ${e.paper.pages} 頁卷（${e.paper.chunks} 塊，只算看圖） | ${fmtDur(e.paper.ms)} | — | 每一塊各自計時 |`);
    L.push('');
    L.push('一個拆題節點（一塊）還要加上 PaddleOCR（每塊幾分鐘）與把 OCR 結果整理成題目（qwen3:8b）；一份卷還有每題的分類、lint、驗算。' +
        '整份卷實際花多久，重錄後用 `npm run perf:local`、正式上傳後用 `npm run report:jobs -- --since=7d` 看。');
    L.push('');
    L.push('建議（只是數字，要不要改 `.env` 由你決定；docs/local-mode.md 第 10.11 條）：');
    const need = e.current.needTimeoutMs;
    L.push(`- \`OLLAMA_TIMEOUT_MS\` 至少 ${need}（${fmtDur(need)}＝${TIMEOUT_FACTOR} × 一塊 ${e.current.pages} 頁的估計，進位到分）；目前 ${ollamaLimit}（${fmtDur(ollamaLimit)}）` +
        `→ ${need <= ollamaLimit ? '夠用' : '**不夠**'}。`);
    const nodeLimit = s.JOB_NODE_TIMEOUT_MS.value;
    const nodeNote = e.current.ms >= nodeLimit ? '，**光是看圖這一步的估計就超過它**'
        : need > nodeLimit ? `，看圖這一步加上 ${TIMEOUT_FACTOR} 倍餘裕就超過它` : '';
    L.push(`- \`JOB_NODE_TIMEOUT_MS\` 要比 \`OLLAMA_TIMEOUT_MS\` 再多出 OCR 與 OCR 整理的時間（一個節點三步依序跑）；目前 ${nodeLimit}（${fmtDur(nodeLimit)}）${nodeNote}。`);
    if (e.ctx.over) {
        L.push(`- ⚠️ 一塊 ${e.current.pages} 頁估計要讀 ${fmtInt(e.current.tokensIn)}、寫 ${fmtInt(e.current.tokensOut)} token，超過 \`OLLAMA_NUM_CTX\`=${e.ctx.numCtx}：` +
            '前面的內容會被截掉或輸出被截斷。先調高 `OLLAMA_NUM_CTX`（記憶體要夠）、縮圖（選項 b）或一塊 1 頁（選項 a）。');
    } else if (e.ctx.overWithMax) {
        L.push(`- 注意：一塊 ${e.current.pages} 頁估計讀 ${fmtInt(e.current.tokensIn)} token，加上輸出上限 ${e.ctx.maxOutputTokens} 會超過 \`OLLAMA_NUM_CTX\`=${e.ctx.numCtx}；` +
            '平常寫得不長時沒事，題目多、寫得長時可能被截斷。');
    }
    if (t.promptEvalMs > t.evalMs) {
        L.push('- 讀 prompt（含看圖）比輸出久：縮小送出的圖片（選項 b，`--max-edge 1600` 先量量看）通常最有效。');
    } else {
        L.push('- 輸出比讀 prompt 久：一塊少放幾頁（選項 a）讓每一次呼叫短一點，或放寬逾時（選項 c）。');
    }
    return `${L.join('\n')}\n`;
}

// ───────────────────────── 主流程 ─────────────────────────

/** exam_pro/.env 疊到 process.env（已存在的不覆寫；與 dotenv 相同） */
function loadDotenv() {
    try {
        require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });
    } catch (_) { /* 沒有 .env 也能跑 */ }
}

function displayPath(p) {
    const rel = path.relative(APP_DIR, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

async function imageInfo(png) {
    const meta = await require('sharp')(png).metadata();
    return { width: meta.width, height: meta.height, bytes: png.length };
}

/**
 * @param {string[]} [argv]
 * @param {{stdout?:{write:Function}, env?:object, cwd?:string, renderPages?:Function, generateJson?:Function,
 *          unloadModel?:Function, now?:()=>number}} [io] 測試注入點（預設就是真的那幾支）
 * @returns {Promise<number>} 結束碼（量到時間＝0）
 */
async function main(argv = process.argv.slice(2), io = {}) {
    const out = io.stdout || process.stdout;
    const write = (s) => out.write(s.endsWith('\n') ? s : `${s}\n`);
    const args = parseArgs(argv, { cwd: io.cwd || process.cwd() });
    if (args.help) { write(USAGE); return 0; }
    if (!io.env) loadDotenv();
    const env = io.env || process.env;
    const now = io.now || Date.now;

    const models = require('../../config/models');
    const spec = args.model || String(env.MODEL_EXTRACT || '').trim() || models.DEFAULT_EXTRACT;
    const { vendor, id } = models.parseModel(spec);
    if (vendor !== 'ollama') throw new Error(`這個量測只量本機模型：模型「${spec}」不是 ollama:…（用 --model ollama:qwen3-vl:8b 指定）`);

    const ollama = require('../../services/llm/ollama');
    const render = require('../../services/ocr/render');
    const extract = require('../../agents/extract');
    const { buildSchema } = require('../../agents/schemas');
    const generateJson = io.generateJson || ollama.generateJson;
    const unloadModel = io.unloadModel || ollama.unloadModel;
    const renderPages = io.renderPages || render.renderPages;

    if (!fs.existsSync(args.pdf)) throw new Error(`找不到 PDF：${args.pdf}`);
    const pdfBytes = fs.readFileSync(args.pdf);
    const { PDFDocument } = require('pdf-lib');
    const total = (await PDFDocument.load(pdfBytes, { ignoreEncryption: true })).getPageCount();
    const fromPage = args.from;
    const toPage = args.from + args.pages - 1;
    if (toPage > total) throw new Error(`這份 PDF 只有 ${total} 頁，要量第 ${fromPage}～${toPage} 頁（改 --from／--pages）`);

    const dpi = args.dpi || require('../../services/ocr').resolveOcrConfig(env).dpi;
    const maxEdge = args.maxEdge !== null ? args.maxEdge : render.visionMaxEdgeFromEnv(env);
    const settings = currentSettings(env);
    let host = '';
    try { host = ollama.resolveHost(env).url; } catch (err) { host = `（OLLAMA_HOST 寫錯：${err.message}）`; }

    write(`[bench] 轉圖：${displayPath(args.pdf)} 第 ${fromPage}${toPage > fromPage ? `～${toPage}` : ''} 頁，${dpi} DPI …`);
    const originals = await renderPages({ pdfBytes, fromPage, toPage, dpi });
    const images = maxEdge > 0 ? await render.fitLongEdge(originals, maxEdge) : originals;
    const report = {
        model: id, host, pdfLabel: displayPath(args.pdf), from: fromPage, pages: args.pages, dpi, maxEdge, warm: args.warm,
        settings, images: await Promise.all(images.map(imageInfo)), originals: await Promise.all(originals.map(imageInfo)),
        timeoutMs: args.timeoutMin * 60_000
    };

    const system = extract.SYSTEM;
    const prompt = extract.buildLocalPrompt('math_physics', 'vision', { fromPage, toPage });
    const schema = buildSchema('extract');
    const progressMs = args.progressSec * 1000;
    const onProgress = (line) => write(line);

    if (!args.warm) {
        write(`[bench] 先請 Ollama 卸載 ${id}（量到的時間才含載入）…`);
        await unloadModel({ model: id });
    }
    write(`[bench] 呼叫 ${id} 看 ${args.pages} 頁（這一步可能要半小時以上；逾時 ${args.timeoutMin} 分）…`);
    const startedAt = now();
    let usage = null;
    try {
        const res = await generateJson({
            model: id, system,
            parts: [{ text: prompt }, ...images.map(png => ({ imageBase64: Buffer.from(png).toString('base64'), mimeType: 'image/png' }))],
            schema, maxOutputTokens: extract.LOCAL_MAX_OUTPUT_TOKENS,
            progressMs, onProgress, timeoutMs: report.timeoutMs
        });
        usage = res.usage;
        report.outcome = 'ok';
        report.questions = Array.isArray(res.data && res.data.questions) ? res.data.questions.length : 0;
    } catch (err) {
        if (err.errorClass === 'schema_invalid' && err.usage) {
            usage = err.usage;
            report.outcome = 'invalid_json';
            report.finishReason = err.finishReason || null;
        } else {
            report.outcome = 'error';
            report.error = String(err.message || err).split('\n')[0];
            report.errorClass = err.errorClass || null;
        }
    }
    report.wallMs = now() - startedAt;
    if (report.outcome === 'error') {
        write(formatReport(report));
        return 1;
    }
    report.usage = usage;
    const tm = usage.timing || {};
    report.timing = {
        loadMs: tm.loadMs ?? null,
        promptEvalMs: tm.promptEvalMs ?? null,
        evalMs: tm.evalMs ?? null,
        totalMs: tm.totalMs ?? null
    };
    if (report.timing.promptEvalMs === null || report.timing.evalMs === null) {
        report.outcome = 'error';
        report.error = 'Ollama 的回應沒有分段時間（prompt_eval_duration／eval_duration），請把 Ollama 更新到最新版';
        write(formatReport(report));
        return 1;
    }

    let baseline = null;
    if (args.baseline) {
        write('[bench] --baseline：卸載後只送文字、輸出 1 個 token，量固定的提示詞要讀多久 …');
        await unloadModel({ model: id });
        try {
            await generateJson({ model: id, system, parts: [{ text: prompt }], schema, maxOutputTokens: 1, progressMs: 0, timeoutMs: report.timeoutMs });
        } catch (err) {
            if (err.usage && err.usage.timing) baseline = { promptEvalMs: err.usage.timing.promptEvalMs, tokenIn: err.usage.tokenIn };
            else write(`[bench] --baseline 沒量到（${String(err.message || err).split('\n')[0]}），改用線性外推。`);
        }
    }
    report.estimate = estimate({
        pages: args.pages, loadMs: report.timing.loadMs, promptEvalMs: report.timing.promptEvalMs, evalMs: report.timing.evalMs,
        tokenIn: usage.tokenIn, tokenOut: usage.tokenOut + (usage.tokenThinking || 0)
    }, settings, { baseline, maxOutputTokens: extract.LOCAL_MAX_OUTPUT_TOKENS });
    write(formatReport(report));
    return 0;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }).catch((err) => {
        console.error(`\n❌ ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    main, parseArgs, currentSettings, estimate, formatReport, USAGE,
    DEFAULT_PDF, PAPER_PAGES, MAX_PAGES, TIMEOUT_FACTOR
};
