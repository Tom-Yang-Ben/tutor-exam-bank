// ─────────────────────────────────────────────────────────────
// db.js — PostgreSQL 連線池（階段 1 D-D3 由 mysql2 換底）
//
// 介面凍結於 docs/interfaces-stage1.md 第 8 條：
//   module.exports = { pool, query }
//   query(text, values) → Promise<{ rows, rowCount }>
//   需要交易時用 pool.connect() 取 client，自行 BEGIN / COMMIT / ROLLBACK / release()
//
// ⚠️ 型別轉換一律集中在這一支，其他檔案不得再各自 setTypeParser——
//    pg 的 type parser 是「行程全域」的，散在各處會變成看誰先被 require 的競態。
// ─────────────────────────────────────────────────────────────
const { Pool, types } = require('pg');

// INT8（OID 20）：pg 預設回字串，因為 BIGINT 可能超出 Number.MAX_SAFE_INTEGER。
// 但本專案的 BIGINT 只有 attempts.id 與各種 COUNT(*)，都遠在安全範圍內；
// 不轉的話 listQuestions 的 total 會變成 "30" 這種字串，前端算分頁就會出錯。
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
// DATE（OID 1082）：預設會轉成「本地午夜」的 Date 物件，序列化成 JSON 時變 UTC，
// 台灣早上 8 點前會整個差一天。直接回 'YYYY-MM-DD' 字串最不會出事。
types.setTypeParser(1082, v => v);

// 連線來源：只認 DATABASE_URL（docs/interfaces-stage1.md 第 8 條、裁決 22／27）。
// D-X1 收尾（2026-08-21）已移除 DB_* 退路：舊 MySQL 的 DB_* 變數已從 .env 刪除，
// 缺 DATABASE_URL 直接丟錯，不再猜連線參數。
if (!process.env.DATABASE_URL) {
    throw new Error(
        '缺少 DATABASE_URL。請在 exam_pro/.env 設定，例如 ' +
        'DATABASE_URL=postgres://exam:exam@localhost:5442/tutor_exam_bank（埠是 5442，見 docs/interfaces-stage1.md 第 9 條）。'
    );
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// 閒置連線被資料庫端切斷時，pg 會在 pool 上丟 error；沒有監聽器會直接讓整個行程崩潰。
pool.on('error', err => console.error('【PostgreSQL 連線池】閒置連線錯誤:', err.message));

/**
 * 單句查詢（自動借還連線）。需要交易請改用 pool.connect()。
 * @param {string} text   SQL，占位符為 $1、$2…
 * @param {any[]} [values]
 * @returns {Promise<{ rows: object[], rowCount: number }>}
 */
function query(text, values) {
    return pool.query(text, values);
}

module.exports = { pool, query };
