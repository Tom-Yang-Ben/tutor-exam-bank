// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/config.js — 桌面啟動器自己的設定（docs/desktop-launcher.md 第 6 節）
//
// 放在 exam_pro/data/launcher/config.json（data/ 不進版控）；檔案不存在就全部用預設值。
// 範本：scripts/desktop/config.example.json（鍵與預設值由 test/unit/desktopLauncherConfig.test.js 釘成與這裡一致）。
//
// 這些是「啟動器怎麼開別的程式」的設定，與系統本身的 .env 無關；系統的埠、資料庫、模型一律讀 exam_pro/.env，
// 啟動器不另存一份（PORT、DATABASE_URL、OLLAMA_HOST、API_KEY、MODEL_*）。
//
// 讀法：型別不對、超出範圍、不認得的值 → 那一項用預設值，並回一句警告（啟動畫面會列出來），不會整個啟動失敗。
// 純函式（readConfigFile 除外，它只讀一個檔）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');

/** @typedef {'no'|'containers'|'desktop'} StopDockerMode */

/**
 * 預設值。改這裡要同步改 config.example.json 與 docs/desktop-launcher.md 第 6 節的表。
 */
const DEFAULTS = Object.freeze({
    /** Docker Desktop 的主程式（docker info 失敗時啟動它） */
    dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    /** docker CLI；空字串＝PATH 上的 docker，找不到再試 Docker Desktop 旁的 resources\bin\docker.exe */
    dockerCliPath: '',
    /** 開了 Docker Desktop 之後，最多等 docker info 成功幾秒 */
    dockerReadyTimeoutSec: 240,
    /** docker compose up -d --wait 最多幾秒（第一次要下載映像） */
    composeTimeoutSec: 900,
    /** 容器起來之後，最多等資料庫接受連線幾秒 */
    dbReadyTimeoutSec: 60,
    /** Ollama 的程式；空字串＝自動找（%LOCALAPPDATA%\Programs\Ollama\ollama app.exe → ollama.exe serve → PATH 的 ollama serve） */
    ollamaAppPath: '',
    /** 開了 Ollama 之後最多等幾秒（等不到只警告、不擋開機） */
    ollamaReadyTimeoutSec: 60,
    /** node server.js 啟動後最多等健康檢查幾秒 */
    serverReadyTimeoutSec: 120,
    /** 用哪個瀏覽器開 app 視窗：auto（Edge → Chrome → 預設瀏覽器）、edge、chrome、default */
    browser: 'auto',
    /** 瀏覽器主程式的完整路徑（只在 browser 是 edge 或 chrome 時有用；空字串＝自動找） */
    browserPath: '',
    /** app 視窗獨立的瀏覽器設定檔資料夾；空字串＝%LOCALAPPDATA%\TutorExamBank\browser-profile\<edge|chrome> */
    browserProfileDir: '',
    /** 額外的瀏覽器參數（例：["--start-maximized"]） */
    browserArgs: [],
    /** 「關閉出題系統」要不要一併關 Docker：no（預設，不關）、containers（docker compose stop）、desktop（再關 Docker Desktop） */
    stopDocker: 'no',
    /** 「關閉出題系統」要不要一併關 Ollama（預設不關） */
    stopOllama: false,
    /** 關閉時最多等在途的背景工作幾秒（Owner 沒被問、或選「不等」時用這個） */
    stopGraceSec: 120,
    /** 關閉時若有背景工作正在跑，先跳視窗問要不要等它跑完 */
    askBeforeStopWithJobs: true,
    /**
     * 偵測到本機重錄正在執行時，這次開的後端要不要跑背景工作（DL-4，docs/desktop-launcher.md 第 8 節）：
     *   run  （預設，與 npm start 相同）：照跑；佇列裡已有的工作會開跑，和錄製搶 CPU 與記憶體
     *   pause：以 JOB_RUNNER=off 啟動後端；上傳的考卷先排隊，錄完後關閉再開啟才開始
     */
    jobsWhileRecording: 'run'
});

const BROWSERS = ['auto', 'edge', 'chrome', 'default'];
const STOP_DOCKER = ['no', 'containers', 'desktop'];
const JOBS_WHILE_RECORDING = ['run', 'pause'];

/** 數字鍵的合法範圍（秒） */
const RANGES = Object.freeze({
    dockerReadyTimeoutSec: [10, 3600],
    composeTimeoutSec: [30, 7200],
    dbReadyTimeoutSec: [5, 600],
    ollamaReadyTimeoutSec: [5, 600],
    serverReadyTimeoutSec: [10, 1800],
    stopGraceSec: [0, 21600]
});

/**
 * 原始 JSON 物件 → 設定。純函式。
 * @param {unknown} raw  JSON.parse 的結果（null／undefined＝沒有設定檔）
 * @returns {{config: typeof DEFAULTS, warnings: string[]}}
 */
function resolveConfig(raw) {
    const warnings = [];
    /** @type {any} */
    const config = { ...DEFAULTS, browserArgs: [...DEFAULTS.browserArgs] };
    if (raw === undefined || raw === null) return { config, warnings };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push('內容不是 JSON 物件（{ … }），整個檔案不採用');
        return { config, warnings };
    }
    for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith('_') || key.startsWith('//')) continue;   // 註解用的鍵
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
            warnings.push(`不認得的設定「${key}」`);
            continue;
        }
        const dflt = DEFAULTS[key];
        if (key in RANGES) {
            const [min, max] = RANGES[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
                warnings.push(`${key} 要是 ${min}～${max} 之間的數字（收到 ${JSON.stringify(value)}）`);
                continue;
            }
            config[key] = Math.round(value);
        } else if (key === 'browser') {
            const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
            if (!BROWSERS.includes(v)) { warnings.push(`browser 只接受 ${BROWSERS.join('／')}（收到 ${JSON.stringify(value)}）`); continue; }
            config[key] = v;
        } else if (key === 'stopDocker') {
            const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
            if (!STOP_DOCKER.includes(v)) { warnings.push(`stopDocker 只接受 ${STOP_DOCKER.join('／')}（收到 ${JSON.stringify(value)}）`); continue; }
            config[key] = v;
        } else if (key === 'jobsWhileRecording') {
            const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
            if (!JOBS_WHILE_RECORDING.includes(v)) { warnings.push(`jobsWhileRecording 只接受 ${JOBS_WHILE_RECORDING.join('／')}（收到 ${JSON.stringify(value)}）`); continue; }
            config[key] = v;
        } else if (typeof dflt === 'boolean') {
            if (typeof value !== 'boolean') { warnings.push(`${key} 要是 true 或 false（收到 ${JSON.stringify(value)}）`); continue; }
            config[key] = value;
        } else if (Array.isArray(dflt)) {
            if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
                warnings.push(`${key} 要是字串陣列（例：["--start-maximized"]）`);
                continue;
            }
            config[key] = value.map(v => v.trim()).filter(Boolean);
        } else if (typeof dflt === 'string') {
            if (typeof value !== 'string') { warnings.push(`${key} 要是字串（收到 ${JSON.stringify(value)}）`); continue; }
            config[key] = value.trim() || dflt;
        }
    }
    return { config, warnings };
}

/**
 * 讀設定檔。不存在＝沒有設定檔（不是錯誤）；讀不懂回警告並用預設值。
 * 記事本另存 UTF-8 時可能帶 BOM，一併去掉。
 * @param {string} file
 * @param {{readFileSync: Function}} [fsImpl]
 * @returns {{config: typeof DEFAULTS, warnings: string[], found: boolean}}
 */
function readConfigFile(file, fsImpl = fs) {
    let text;
    try {
        text = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return { ...resolveConfig(null), found: false };
        return { ...resolveConfig(null), warnings: [`讀不到設定檔（${err.message}）`], found: false };
    }
    let raw;
    try {
        raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    } catch (err) {
        return { ...resolveConfig(null), warnings: [`不是合法的 JSON（${err.message}）`], found: true };
    }
    return { ...resolveConfig(raw), found: true };
}

module.exports = { DEFAULTS, RANGES, BROWSERS, STOP_DOCKER, JOBS_WHILE_RECORDING, resolveConfig, readConfigFile };
