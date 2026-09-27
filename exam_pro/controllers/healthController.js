// ─────────────────────────────────────────────────────────────
// controllers/healthController.js — GET /api/health（桌面啟動器 A，docs/desktop-launcher.md）
//
// 給桌面啟動器與關閉捷徑用的極輕量健康檢查：
//   200 { service:'tutor-exam-bank', status:'ok',       version, db:{ok:true},  migrations:{applied, latest, pending[], unknown[]} }
//   503 { service:'tutor-exam-bank', status:'degraded', version, db:{ok:false}, migrations:null }
//
// 為什麼掛在 apiKeyAuth **之前**（app.js）：
//   1. 啟動器要先分辨「3000 埠上跑的是不是這套系統」，才決定要開視窗、還是報「埠被其他程式佔用」。
//      .env 的 API_KEY 可能在伺服器啟動之後被改過，拿現在的金鑰去問會被 401 擋住，就分不出是誰在聽。
//   2. 回應只有「是不是這套系統、版本、資料庫連不連得上、migration 檔名」，沒有任何題目、學生、設定值、
//      錯誤訊息或路徑——連線錯誤的原文（可能含帳號）一律不回傳，只回 ok:false。
//   3. 首頁 serveIndex 本來就不經 apiKeyAuth（它把 API_KEY 注入頁面），這支不會讓「沒金鑰能拿到的東西」變多。
// 只有 GET；不寫資料庫；資料庫查詢最多等 timeoutMs（預設 2 秒），連不上時不會把請求卡住。
// ─────────────────────────────────────────────────────────────
const { listMigrationFiles, compareMigrations, readAppliedVersions } = require('../utils/migrationStatus');

/** 健康檢查回應裡的服務名稱：啟動器靠它認出「這是自己的系統」 */
const SERVICE_NAME = 'tutor-exam-bank';
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * promise 在 ms 內沒結束就以逾時失敗。原本的 promise 之後才失敗也不會變成 unhandled rejection。
 * 計時器**不 unref**：結果一出來就 clearTimeout，不會多留；unref 的話，事件迴圈裡沒有別的事時逾時永遠不會觸發。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
    let timer;
    const guarded = Promise.resolve(promise);
    guarded.catch(() => { });
    return Promise.race([
        guarded,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('health check timeout')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

/**
 * 組出健康檢查的回應本文。純邏輯（依賴全部注入），單元測試不必連資料庫。
 * @param {object} deps
 * @param {(text:string, values?:any[]) => Promise<{rows:any[]}>} deps.query
 * @param {() => string[]} deps.listFiles  程式帶的 migration 檔名
 * @param {string} deps.version            package.json 的 version
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{httpStatus:number, body:object}>}
 */
async function buildHealth({ query, listFiles, version, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    let applied = null;
    try {
        applied = await withTimeout(readAppliedVersions(query), timeoutMs);
    } catch (_) {
        applied = null;
    }
    if (applied === null) {
        return {
            httpStatus: 503,
            body: { service: SERVICE_NAME, status: 'degraded', version, db: { ok: false }, migrations: null }
        };
    }
    let migrations = null;
    try {
        const cmp = compareMigrations(listFiles(), applied);
        migrations = { applied: cmp.latestApplied, latest: cmp.latestFile, pending: cmp.pending, unknown: cmp.unknown };
    } catch (_) {
        migrations = null;
    }
    return {
        httpStatus: 200,
        body: { service: SERVICE_NAME, status: 'ok', version, db: { ok: true }, migrations }
    };
}

/**
 * Express handler 工廠。
 * @param {Parameters<typeof buildHealth>[0]} deps
 */
function createHealthHandler(deps) {
    return async function health(req, res) {
        const { httpStatus, body } = await buildHealth(deps);
        res.set('Cache-Control', 'no-store');
        res.status(httpStatus).json(body);
    };
}

let defaultHandler = null;
/**
 * app.js 掛的那一支。config/db 延到第一次請求才 require（本檔在單元測試裡可以不設 DATABASE_URL 就載入）。
 */
function health(req, res, next) {
    if (!defaultHandler) {
        const { query } = require('../config/db');
        defaultHandler = createHealthHandler({
            query,
            listFiles: () => listMigrationFiles(),
            version: require('../package.json').version
        });
    }
    return defaultHandler(req, res, next);
}

module.exports = { health, createHealthHandler, buildHealth, withTimeout, SERVICE_NAME, DEFAULT_TIMEOUT_MS };
