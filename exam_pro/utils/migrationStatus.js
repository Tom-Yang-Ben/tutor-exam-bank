// ─────────────────────────────────────────────────────────────
// utils/migrationStatus.js — 「程式帶的 migration」與「資料庫已套的 migration」對照（桌面啟動器 A）
//
// 兩個地方共用同一套比法，不各寫一份：
//   1. GET /api/health（controllers/healthController.js）回報 migration 版本；
//   2. 桌面啟動器（scripts/desktop/launch.js）開機前檢查有沒有沒套的 migration——**只提示、不自動升級**
//      （升級要走「停服務 → 備份 → migrate → 快照比對」，docs/ops/deployment_and_operations.md §3.6）。
//
// 規則與 migrate.js 相同：migrations/*.sql 依檔名排序；schema_migrations.version 存的就是檔名。
// 本檔只讀，不寫資料庫，也不建 schema_migrations（那是 migrate.js 的事）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/** exam_pro/migrations 的絕對路徑 */
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/**
 * migrations/ 底下的 .sql 檔名（排序後）。與 migrate.js 的 readdirSync(...).filter(.sql).sort() 同一條規則。
 * @param {string} [dir]
 * @param {{readdirSync: Function}} [fsImpl] 測試注入
 * @returns {string[]}
 */
function listMigrationFiles(dir = MIGRATIONS_DIR, fsImpl = fs) {
    return fsImpl.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
}

/**
 * 對照兩份清單。純函式。
 * @param {string[]} files    程式帶的 migration 檔名
 * @param {string[]} applied  schema_migrations 裡的 version
 * @returns {{latestFile:string|null, latestApplied:string|null, pending:string[], unknown:string[]}}
 *   pending：程式有、資料庫還沒套（依檔名排序）；unknown：資料庫套過、程式卻沒有（通常是切回了舊版程式）
 */
function compareMigrations(files, applied) {
    const fileList = [...new Set((files || []).map(String))].sort();
    const appliedList = [...new Set((applied || []).map(String))].sort();
    const appliedSet = new Set(appliedList);
    const fileSet = new Set(fileList);
    return {
        latestFile: fileList.length ? fileList[fileList.length - 1] : null,
        latestApplied: appliedList.length ? appliedList[appliedList.length - 1] : null,
        pending: fileList.filter(f => !appliedSet.has(f)),
        unknown: appliedList.filter(v => !fileSet.has(v))
    };
}

/**
 * 讀資料庫已套的 version。schema_migrations 不存在（全新的空庫、從沒跑過 migrate）時回空陣列，不丟錯。
 * @param {(text:string, values?:any[]) => Promise<{rows:any[]}>} query
 * @returns {Promise<string[]>}
 */
async function readAppliedVersions(query) {
    try {
        const { rows } = await query('SELECT version FROM schema_migrations ORDER BY version');
        return rows.map(r => r.version);
    } catch (err) {
        // 42P01 = undefined_table：還沒跑過 migrate
        if (err && err.code === '42P01') return [];
        throw err;
    }
}

module.exports = { MIGRATIONS_DIR, listMigrationFiles, compareMigrations, readAppliedVersions };
