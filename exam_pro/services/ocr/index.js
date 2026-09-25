// services/ocr/index.js — 本機 OCR 的唯一出入口（docs/local-mode.md 第 4 條第 2 點，擁有者：L2）
//
//   ocrPdf({ pdfBytes, pdfSha256, fromPage, toPage, signal })
//     → { engine:'paddleocr', engineVersion, dpi, pages:[{ page, markdown, imagePath|null }], dispose(), replayed }
//
// 模式跟著 LLM_MODE（services/llm 的 llmMode()）：
//   live   —— spawn ocr_service/ocr_pdf.py（child_process.spawn、不經 shell），不留 cassette
//   record —— 同上，再把結果寫成 cassette（**只存 markdown，不存圖片**）
//   replay —— 只讀 cassette；miss 的訊息與 LLM 的 replay miss 同一個格式（eval/lib/replayMiss.js 認得），
//             imagePath 一律 null。CI 永遠是這個模式，因此 **CI 不需要 Python**。
//
// cassette 鍵（與 LLM 同一條公式，services/llm/cassette.js）：
//   cassetteKey({ agent:'ocr', modelId:'paddleocr@<版本>', template:'ocr.v1',
//                 cacheKeyParts:{ pdfSha256, fromPage, toPage, dpi } })
//   <版本> 取 ocr_service/requirements.txt 釘死的 paddleocr 版本——replay 時沒有 Python 可問，
//   只能以「應該裝著的那一版」為準。record 時 ocr_pdf.py 回報的版本若與它不同就拒錄
//   （cassette 會掛在錯的鍵上）；live 時只警告一次。
//
// 暫存：PDF 與頁面 PNG 放在系統暫存目錄的 exam-ocr-XXXXXX/ 底下。成功時由呼叫端用完圖片後呼叫
// dispose() 刪除（agents/extract.js 在 finally 裡呼叫）；失敗時本檔自己刪。
//
// 設定（預設值寫在這裡；.env.example 由 L4 補）：
//   OCR_ENGINE      paddle（預設）｜none   none＝不做 OCR（由 agent 決定略過；本檔只負責解析）
//   OCR_PYTHON      跑 ocr_pdf.py 的 Python；預設 Windows：ocr_service\.venv\Scripts\python.exe、
//                   其他：ocr_service/.venv/bin/python（相對路徑以 exam_pro/ 為基準）
//   OCR_DPI         200（72～600）
//   OCR_TIMEOUT_MS  1800000（單次 OCR 逾時；逾時或被 signal 中止 → errorClass 'timeout'）

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { registerTemplate } = require('../llm/templates');
const cassette = require('../llm/cassette');

const APP_DIR = path.resolve(__dirname, '..', '..');
const OCR_DIR = path.join(APP_DIR, 'ocr_service');
const SCRIPT_PATH = path.join(OCR_DIR, 'ocr_pdf.py');
const REQUIREMENTS_PATH = path.join(OCR_DIR, 'requirements.txt');

const ENGINE = 'paddleocr';
const AGENT = 'ocr';
const TEMPLATE = 'ocr.v1';
const ENGINES = Object.freeze(['paddle', 'none']);
const DEFAULT_DPI = 200;
const MIN_DPI = 72;
const MAX_DPI = 600;
const DEFAULT_TIMEOUT_MS = 1800000;
/** SIGTERM 之後等多久才 SIGKILL（Windows 上 kill 本來就是強制結束，這段只對 POSIX 有意義） */
const KILL_GRACE_MS = 5000;
/** 錯誤訊息只帶 stderr 的最後這麼多字（PaddleOCR 的 log 很長） */
const STDERR_TAIL_CHARS = 2000;
/** ocr_pdf.py 的結束碼（與 ocr_pdf.py 的 EXIT_* 一致） */
const EXIT_NOT_READY = 3;
const EXIT_INPUT = 4;

// 'ocr.v1' 的「模板原文」＝辨識設定的描述。cassette 鍵的 promptTemplateHash 取它的 sha256：
// ocr_pdf.py 的 PIPELINE_OPTIONS 或 markdown 後處理改了，就要改這段文字（例如 v1 → v2），
// 既有 ocr cassette 才會失效。
const PIPELINE_DESCRIPTION = [
    'ocr_service/ocr_pdf.py v1',
    'pipeline=PP-StructureV3 lang=chinese_cht device=cpu',
    'use_doc_orientation_classify=False use_doc_unwarping=False use_textline_orientation=False',
    'use_seal_recognition=False use_chart_recognition=False use_table_recognition=True',
    'use_formula_recognition=True use_region_detection=True formula_recognition_model_name=PP-FormulaNet_plus-M',
    'render=PyMuPDF get_pixmap(dpi, alpha=False) → BGR ndarray',
    'markdown=_to_markdown(pretty=False)；圖片→[圖]；去 <div>；三個以上空行壓成兩個'
].join('\n');

registerTemplate(TEMPLATE, PIPELINE_DESCRIPTION);

const warnedOnce = new Set();
function warnOnce(key, message) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    console.warn(message);
}

// ───────────────────────── 設定解析（純函式，可單元測試）─────────────────────────

/**
 * OCR_ENGINE → 'paddle' | 'none'。空白＝paddle；非法值也退回 paddle 並警告一次——
 * 打錯字不該讓交叉驗證悄悄關掉（與 SOURCE_CHECK_MODE 非法值退回 enforce 同一個方向）。
 * @param {object} [env]
 * @returns {'paddle'|'none'}
 */
function resolveEngine(env = process.env) {
    const raw = String(env.OCR_ENGINE ?? '').trim().toLowerCase();
    if (!raw) return 'paddle';
    if (ENGINES.includes(raw)) return raw;
    warnOnce(`engine:${raw}`, `[ocr] OCR_ENGINE 只接受 paddle／none，收到「${env.OCR_ENGINE}」，改用 paddle。`);
    return 'paddle';
}

/**
 * OCR_PYTHON 未設時的預設路徑（第 2 條）。
 * @param {string} [platform] 預設 process.platform
 * @returns {string} 絕對路徑
 */
function defaultPython(platform = process.platform) {
    return platform === 'win32'
        ? path.win32.join(OCR_DIR, '.venv', 'Scripts', 'python.exe')
        : path.join(OCR_DIR, '.venv', 'bin', 'python');
}

/**
 * OCR_PYTHON 的解讀：
 *   - 未設／空白 → defaultPython()
 *   - 不含路徑分隔字元（例如 python、py）→ 原樣交給 spawn 在 PATH 裡找
 *   - 相對路徑 → 以 exam_pro/ 為基準（與 jobs.pdf_path 同一個規則，不看 process.cwd()）
 * @param {string|undefined} raw
 * @param {string} [platform]
 */
function resolvePython(raw, platform = process.platform) {
    const value = String(raw ?? '').trim();
    if (!value) return defaultPython(platform);
    if (!/[\\/]/.test(value)) return value;
    const p = platform === 'win32' ? path.win32 : path;
    return p.isAbsolute(value) ? value : p.resolve(APP_DIR, value);
}

function intInRange(raw, min, max, dflt) {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/**
 * 讀環境變數組出 OCR 的設定。
 * @param {object} [env]
 * @param {string} [platform]
 * @returns {{engine:'paddle'|'none', python:string, script:string, dpi:number, timeoutMs:number}}
 */
function resolveOcrConfig(env = process.env, platform = process.platform) {
    return {
        engine: resolveEngine(env),
        python: resolvePython(env.OCR_PYTHON, platform),
        script: SCRIPT_PATH,
        dpi: intInRange(env.OCR_DPI, MIN_DPI, MAX_DPI, DEFAULT_DPI),
        timeoutMs: intInRange(env.OCR_TIMEOUT_MS, 1, Number.MAX_SAFE_INTEGER, DEFAULT_TIMEOUT_MS)
    };
}

let pinnedCache = null;
/**
 * requirements.txt 釘死的 paddleocr 版本（cassette 鍵的一部分）。
 * @param {string} [file] 測試用
 * @returns {string}
 */
function pinnedEngineVersion(file = REQUIREMENTS_PATH) {
    if (file === REQUIREMENTS_PATH && pinnedCache) return pinnedCache;
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*paddleocr(?:\[[^\]]*\])?\s*==\s*([0-9A-Za-z.+-]+)\s*(?:[#;].*)?$/m);
    if (!m) throw new Error(`${file} 沒有以 == 釘死 paddleocr 的版本（cassette 鍵需要它）。`);
    if (file === REQUIREMENTS_PATH) pinnedCache = m[1];
    return m[1];
}

/**
 * OCR cassette 鍵。cacheKeyParts 的鍵順序凍結為 { pdfSha256, fromPage, toPage, dpi }（第 4 條第 2 點）。
 */
function ocrCassetteKey({ engineVersion, pdfSha256, fromPage, toPage, dpi }) {
    return cassette.cassetteKey({
        agent: AGENT,
        modelId: `${ENGINE}@${engineVersion}`,
        template: TEMPLATE,
        schema: undefined,
        cacheKeyParts: { pdfSha256, fromPage, toPage, dpi }
    });
}

/** replay miss：與 services/llm/fake.js 同一串（前綴與 --suite 標記一字不差，eval/lib/replayMiss.js 靠它辨識） */
function replayMissError(key) {
    const err = new Error(
        `LLM_MODE=replay 找不到 cassette（agent=${AGENT} key=${key}）。請在本機執行 npm run eval:record -- --suite <suite>` +
        `\n（預期路徑：${cassette.cassettePath(AGENT, key)}）`
    );
    err.errorClass = 'provider_error';
    return err;
}

function tagged(message, errorClass) {
    return Object.assign(new Error(message), { errorClass });
}

function tail(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    return s.length > STDERR_TAIL_CHARS ? `…${s.slice(-STDERR_TAIL_CHARS)}` : s;
}

// ───────────────────────── 子行程 ─────────────────────────

/**
 * spawn 一個子行程（不經 shell），收 stdout／stderr，處理逾時與中止。
 *
 * @param {{command:string, args:string[], timeoutMs:number, signal?:AbortSignal,
 *          spawnImpl?:Function, env?:object, label?:string}} opts
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 *   非 0 結束、找不到執行檔、逾時、中止一律 reject；Error 帶 errorClass 與 exitCode（有的話）
 */
function runProcess({ command, args, timeoutMs, signal, spawnImpl = spawn, env, label = 'ocr_pdf.py', onStderr }) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(tagged(`${label} 尚未開始就被中止。`, 'timeout'));
            return;
        }
        let child;
        try {
            child = spawnImpl(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                shell: false,
                env: env || process.env
            });
        } catch (err) {
            reject(spawnFailure(err, command));
            return;
        }

        const chunks = [];
        let stderr = '';
        let settled = false;
        let killedFor = null;
        let killTimer = null;

        const kill = (why) => {
            if (killedFor) return;
            killedFor = why;
            try { child.kill('SIGTERM'); } catch (_) { /* 已經結束 */ }
            killTimer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (_) { /* 已經結束 */ }
            }, KILL_GRACE_MS);
            if (typeof killTimer.unref === 'function') killTimer.unref();
        };
        const timer = setTimeout(() => kill('timeout'), timeoutMs);
        const onAbort = () => kill('abort');
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn();
        };

        if (child.stdout) child.stdout.on('data', (c) => chunks.push(Buffer.from(c)));
        if (child.stderr) {
            child.stderr.on('data', (c) => {
                const text = Buffer.from(c).toString('utf8');
                stderr = (stderr + text).slice(-STDERR_TAIL_CHARS * 2);
                if (typeof onStderr === 'function') {
                    try { onStderr(text); } catch (_) { /* 顯示進度失敗不影響結果 */ }
                }
            });
        }
        child.on('error', (err) => finish(() => reject(spawnFailure(err, command))));
        child.on('close', (code, sig) => finish(() => {
            if (killedFor === 'timeout') {
                reject(tagged(`${label} 超過 ${timeoutMs} ms 沒有完成，已中止（OCR_TIMEOUT_MS）。${tail(stderr) ? `\n${tail(stderr)}` : ''}`, 'timeout'));
                return;
            }
            if (killedFor === 'abort') {
                reject(tagged(`${label} 被中止（節點逾時或工作取消）。`, 'timeout'));
                return;
            }
            if (code !== 0) {
                reject(exitFailure(code, sig, stderr, label));
                return;
            }
            resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr, code });
        }));
    });
}

function spawnFailure(err, command) {
    if (err && err.code === 'ENOENT') {
        return tagged(
            `找不到 OCR 用的 Python：${command}。請先建立 ocr_service 的虛擬環境並安裝 requirements.txt` +
            '（Windows 可執行 scripts\\windows\\setup_local_ai.bat），或在 .env 設定 OCR_PYTHON；不想做 OCR 可設 OCR_ENGINE=none。',
            'provider_error');
    }
    return tagged(`無法啟動 OCR 子行程（${command}）：${err && err.message}`, 'provider_error');
}

function exitFailure(code, sig, stderr, label) {
    const detail = tail(stderr);
    let head;
    if (code === EXIT_NOT_READY) {
        head = `PaddleOCR 還沒準備好（套件或模型不在本機）。請先執行 ocr_pdf.py --warmup（setup_local_ai.bat 會做），再用 --selftest 確認。`;
    } else if (code === EXIT_INPUT) {
        head = `${label} 讀不了輸入（PDF 或頁碼範圍有問題）。`;
    } else if (code === null) {
        head = `${label} 被訊號 ${sig} 結束。`;
    } else {
        head = `${label} 失敗（結束碼 ${code}）。`;
    }
    const err = tagged(detail ? `${head}\n${detail}` : head, 'provider_error');
    err.exitCode = code;
    return err;
}

// ───────────────────────── 輸出解析 ─────────────────────────

/**
 * ocr_pdf.py 的 stdout → 驗證過的結果。stdout 理應只有一個 JSON；萬一前面混了雜訊，
 * 退而取最後一個非空行再試一次。
 *
 * @param {string} stdout
 * @param {{fromPage:number, toPage:number, outDir?:string}} range outDir 給了就只接受該目錄內的圖檔路徑
 * @returns {{engine:string, engineVersion:string, dpi:number|null, pages:Array<{page:number, markdown:string, imagePath:string|null}>}}
 */
function parseOcrOutput(stdout, { fromPage, toPage, outDir } = {}) {
    const text = String(stdout || '').trim();
    let obj = null;
    try {
        obj = JSON.parse(text);
    } catch (_) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        try { obj = JSON.parse(lines[lines.length - 1] || ''); } catch (__) { obj = null; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw tagged(`ocr_pdf.py 的輸出不是 JSON：${text.slice(0, 200) || '（空白）'}`, 'provider_error');
    }
    if (obj.engine !== ENGINE) {
        throw tagged(`ocr_pdf.py 回報的 engine 是「${obj.engine}」，預期 ${ENGINE}。`, 'provider_error');
    }
    if (typeof obj.engine_version !== 'string' || !obj.engine_version.trim()) {
        throw tagged('ocr_pdf.py 的輸出缺少 engine_version。', 'provider_error');
    }
    if (!Array.isArray(obj.pages)) {
        throw tagged('ocr_pdf.py 的輸出缺少 pages 陣列。', 'provider_error');
    }

    const byPage = new Map();
    for (const p of obj.pages) {
        if (!p || !Number.isInteger(p.page) || typeof p.markdown !== 'string') {
            throw tagged(`ocr_pdf.py 的 pages 元素格式不對：${JSON.stringify(p).slice(0, 120)}`, 'provider_error');
        }
        if (byPage.has(p.page)) throw tagged(`ocr_pdf.py 重複回報第 ${p.page} 頁。`, 'provider_error');
        byPage.set(p.page, p);
    }
    const pages = [];
    for (let n = fromPage; n <= toPage; n++) {
        const p = byPage.get(n);
        if (!p) throw tagged(`ocr_pdf.py 少回了第 ${n} 頁（要求 ${fromPage}～${toPage}）。`, 'provider_error');
        pages.push({ page: n, markdown: p.markdown, imagePath: acceptImagePath(p.image, outDir) });
    }
    if (byPage.size !== pages.length) {
        throw tagged(`ocr_pdf.py 回了範圍外的頁（要求 ${fromPage}～${toPage}）。`, 'provider_error');
    }
    return {
        engine: obj.engine,
        engineVersion: obj.engine_version.trim(),
        dpi: Number.isInteger(obj.dpi) ? obj.dpi : null,
        pages
    };
}

/** 圖檔路徑只接受「在我們給的輸出目錄裡、而且真的存在」的那種；其餘一律當作沒有圖 */
function acceptImagePath(image, outDir) {
    if (typeof image !== 'string' || !image) return null;
    const abs = path.resolve(image);
    if (outDir) {
        const root = path.resolve(outDir) + path.sep;
        if (!abs.startsWith(root)) return null;
    }
    try {
        return fs.statSync(abs).isFile() ? abs : null;
    } catch (_) {
        return null;
    }
}

/** 把 OCR 各頁的 markdown 串成送給結構化模型的那一段文字（agents/extract.js 的 ocrSha256 也算在它上面） */
function pagesToText(pages) {
    return (pages || [])
        .map(p => `<!-- 第 ${p.page} 頁 -->\n${String(p.markdown ?? '').trim()}`)
        .join('\n\n');
}

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function childEnv(base = process.env) {
    // Windows 的主控台編碼是 cp950：強迫 Python 的 stdio 用 UTF-8，stderr 的中文訊息才不會變亂碼
    return { ...base, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

/** 目前的 LLM_MODE（OCR 跟著它走 live／record／replay） */
function currentMode() {
    return require('../llm').llmMode();
}

// ───────────────────────── 主體 ─────────────────────────

/**
 * 對 PDF 的第 fromPage～toPage 頁做 OCR。
 *
 * @param {{pdfBytes:Buffer, pdfSha256?:string, fromPage:number, toPage:number, signal?:AbortSignal,
 *          config?:object, mode?:'live'|'record'|'replay', spawnImpl?:Function}} opts
 *        config／mode／spawnImpl 只給測試與錄製腳本用；正式呼叫只傳契約的五個欄位。
 * @returns {Promise<{engine:string, engineVersion:string, dpi:number,
 *                    pages:Array<{page:number, markdown:string, imagePath:string|null}>,
 *                    dispose:()=>void, replayed:boolean, latencyMs:number, cassetteKey:string}>}
 */
async function ocrPdf(opts = {}) {
    const cfg = { ...resolveOcrConfig(), ...(opts.config || {}) };
    const bytes = opts.pdfBytes;
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        throw new Error('ocrPdf：pdfBytes 必須是 Buffer。');
    }
    const fromPage = Number(opts.fromPage);
    const toPage = Number(opts.toPage);
    if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 1 || toPage < fromPage) {
        throw new Error(`ocrPdf：頁碼範圍不合法（fromPage=${opts.fromPage} toPage=${opts.toPage}）。`);
    }
    const pdfSha256 = opts.pdfSha256 || sha256Hex(bytes);
    const mode = opts.mode || currentMode();
    const pinned = pinnedEngineVersion();
    const key = ocrCassetteKey({ engineVersion: pinned, pdfSha256, fromPage, toPage, dpi: cfg.dpi });

    if (mode === 'replay') {
        const tape = cassette.readCassette(AGENT, key);
        if (!tape) throw replayMissError(key);
        const res = tape.response || {};
        if (!Array.isArray(res.pages)) {
            throw new Error(`OCR cassette 缺少 response.pages：${cassette.cassettePath(AGENT, key)}`);
        }
        const pages = [];
        for (let n = fromPage; n <= toPage; n++) {
            const p = res.pages.find(x => x && x.page === n);
            if (!p || typeof p.markdown !== 'string') {
                throw new Error(`OCR cassette 少了第 ${n} 頁：${cassette.cassettePath(AGENT, key)}`);
            }
            pages.push({ page: n, markdown: p.markdown, imagePath: null });
        }
        return {
            engine: ENGINE,
            engineVersion: String(res.engine_version || pinned),
            dpi: cfg.dpi,
            pages,
            dispose: () => { },
            replayed: true,
            latencyMs: 0,
            cassetteKey: key
        };
    }

    // live／record：落暫存檔、跑 ocr_pdf.py
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-ocr-'));
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* 暫存目錄刪不掉不影響結果 */ }
    };

    try {
        const pdfPath = path.join(workDir, 'input.pdf');
        const outDir = path.join(workDir, 'pages');
        fs.writeFileSync(pdfPath, bytes);
        fs.mkdirSync(outDir);

        const startedAt = Date.now();
        const { stdout } = await runProcess({
            command: cfg.python,
            args: [cfg.script, '--pdf', pdfPath, '--from', String(fromPage), '--to', String(toPage),
                '--dpi', String(cfg.dpi), '--out', outDir],
            timeoutMs: cfg.timeoutMs,
            signal: opts.signal,
            spawnImpl: opts.spawnImpl,
            env: childEnv(),
            label: 'PaddleOCR（ocr_pdf.py）'
        });
        const latencyMs = Date.now() - startedAt;
        const parsed = parseOcrOutput(stdout, { fromPage, toPage, outDir });

        if (parsed.engineVersion !== pinned) {
            const msg = `ocr_pdf.py 回報 PaddleOCR ${parsed.engineVersion}，但 ocr_service/requirements.txt 釘的是 ${pinned}。`;
            if (mode === 'record') {
                throw tagged(`${msg}錄下來的 cassette 會掛在錯的版本鍵上，請依 requirements.txt 重建虛擬環境後再錄。`, 'provider_error');
            }
            warnOnce(`version:${parsed.engineVersion}`, `[ocr] ${msg}結果照用，但請依 requirements.txt 重建虛擬環境。`);
        }

        if (mode === 'record') {
            const { file, overwritten } = cassette.writeCassette({
                agent: AGENT,
                key,
                meta: {
                    agent: AGENT,
                    model: `${ENGINE}@${pinned}`,
                    template: TEMPLATE,
                    kind: 'ocr',
                    recorded_at: new Date().toISOString(),
                    fixtureHash: null
                },
                // 只存摘要與頁面文字：PDF 本身與頁面圖片都不進版控
                request: {
                    pdf: { bytes: bytes.length, sha256: sha256Hex(bytes) },
                    cacheKeyParts: { pdfSha256, fromPage, toPage, dpi: cfg.dpi }
                },
                response: {
                    engine: ENGINE,
                    engine_version: parsed.engineVersion,
                    dpi: cfg.dpi,
                    pages: parsed.pages.map(p => ({ page: p.page, markdown: p.markdown })),
                    latencyMs
                }
            });
            console.log(`[ocr:record] ${overwritten ? '覆寫' : '寫入'} cassette → ${file}`);
        }

        return {
            engine: ENGINE,
            engineVersion: parsed.engineVersion,
            dpi: cfg.dpi,
            pages: parsed.pages,
            dispose,
            replayed: false,
            latencyMs,
            cassetteKey: key
        };
    } catch (err) {
        dispose();
        throw err;
    }
}

/** --selftest／--warmup 共用：跑一次、解析 {ok:true,…}，失敗回 {ok:false, message}，不丟錯 */
async function runCheck(flag, { config, spawnImpl, signal, timeoutMs, onStderr } = {}) {
    const cfg = { ...resolveOcrConfig(), ...(config || {}) };
    try {
        const { stdout } = await runProcess({
            command: cfg.python, args: [cfg.script, flag],
            timeoutMs: timeoutMs || cfg.timeoutMs, signal, spawnImpl, env: childEnv(), label: `ocr_pdf.py ${flag}`, onStderr
        });
        let obj = null;
        try { obj = JSON.parse(String(stdout).trim()); } catch (_) { obj = null; }
        if (!obj || obj.ok !== true) return { ok: false, message: `${flag} 回報失敗：${String(stdout).slice(0, 200) || '（沒有輸出）'}` };
        return { ok: true, engineVersion: obj.engine_version };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

/**
 * ocr_pdf.py --selftest：不連網確認套件與模型都在（給錄製前檢查與安裝腳本用；L4 的 rerecord_all.js 可以直接呼叫）。
 * @returns {Promise<{ok:boolean, engineVersion?:string, message?:string}>}
 */
function selftest(opts = {}) {
    return runCheck('--selftest', opts);
}

/** --warmup 的逾時：要下載數百 MB 到數 GB 的模型，給兩小時 */
const WARMUP_TIMEOUT_MS = 7200000;

/**
 * ocr_pdf.py --warmup：下載模型並試跑一次（安裝時用，**唯一需要連網的一步**）。
 * @param {{onStderr?:(text:string)=>void}} [opts] 給安裝腳本把下載進度印出來
 * @returns {Promise<{ok:boolean, engineVersion?:string, message?:string}>}
 */
function warmup(opts = {}) {
    return runCheck('--warmup', { timeoutMs: WARMUP_TIMEOUT_MS, ...opts });
}

/** 測試用 */
function _resetForTest() {
    warnedOnce.clear();
    pinnedCache = null;
}

module.exports = {
    ocrPdf, selftest, warmup,
    resolveEngine, resolveOcrConfig, resolvePython, defaultPython, pinnedEngineVersion,
    ocrCassetteKey, parseOcrOutput, runProcess, pagesToText, replayMissError,
    ENGINE, AGENT, TEMPLATE, ENGINES, DEFAULT_DPI, DEFAULT_TIMEOUT_MS, SCRIPT_PATH, REQUIREMENTS_PATH,
    PIPELINE_DESCRIPTION,
    _resetForTest
};
