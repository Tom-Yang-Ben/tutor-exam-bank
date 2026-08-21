// ─────────────────────────────────────────────────────────────
// migrate.js — 極簡 migration 執行器（只前進，不做 down）
//
// 用法：
//   node migrate.js up            對 DATABASE_URL 套用尚未套過的 migration
//   node migrate.js up --test     對 TEST_DATABASE_URL 套用（庫名必須以 _test 結尾）
//   node migrate.js status        列出每一支的套用狀態
//
// 規則：依檔名排序套用 migrations/*.sql；每一支 SQL 與它的 schema_migrations
//       紀錄在同一個交易裡（PG 的 DDL 可進交易），中途失敗整支回滾。
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.resolve(__dirname, 'migrations');
const cmd = process.argv[2] || 'up';
const useTest = process.argv.includes('--test');

function resolveUrl() {
    if (useTest) {
        const url = process.env.TEST_DATABASE_URL;
        if (!url) throw new Error('缺少 TEST_DATABASE_URL');
        // 防呆：整合測試絕不能打到真題庫
        if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
        return url;
    }
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('缺少 DATABASE_URL（測試庫請加 --test）');
    return url;
}

async function main() {
    const client = new Client({ connectionString: resolveUrl() });
    await client.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

        if (cmd === 'status') {
            for (const f of files) console.log(`${applied.has(f) ? '✅ 已套用' : '⬜ 未套用'}  ${f}`);
            return;
        }
        if (cmd !== 'up') throw new Error(`未知的指令「${cmd}」，可用：up、status`);

        let count = 0;
        for (const f of files) {
            if (applied.has(f)) { console.log(`⏭  ${f}（已套用，略過）`); continue; }
            const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`套用 ${f} 失敗，已回滾：${err.message}`);
            }
            console.log(`✅ ${f}`);
            count++;
        }
        console.log(count === 0 ? '沒有待套用的 migration（no-op）。' : `完成，共套用 ${count} 支。`);
    } finally {
        await client.end();
    }
}

main().catch(err => { console.error('❌ ' + err.message); process.exit(1); });
