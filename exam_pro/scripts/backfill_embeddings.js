// scripts/backfill_embeddings.js — 題目向量回填（WS-C / D-V1）
//
// 用法（Windows 可用 回填向量.bat 包起來雙擊執行）：
//   node scripts/backfill_embeddings.js                 對 DATABASE_URL 全量對帳並補算
//   node scripts/backfill_embeddings.js --missing-only  只補「沒有向量／換過模型」的題（快）
//   node scripts/backfill_embeddings.js --ids 12,34     只處理指定題號
//   node scripts/backfill_embeddings.js --subject 物理 --chapter 向心力 --limit 100
//   node scripts/backfill_embeddings.js --dry-run       只印出要算幾題，不呼叫 API、不寫 DB
//   node scripts/backfill_embeddings.js --force         忽略 embed_hash，全部重算
//   node scripts/backfill_embeddings.js --test          改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 行為：每批 EMBED_BATCH 筆、每批一個交易（天然斷點續跑）；EMBED_RPM 令牌桶與 429/503 退避
// 在 services/llm/gemini.js 裡；失敗批次記進 eval/local/backfill_failed.json 後繼續跑。
// 結尾印出「還有幾題沒有向量」，>0 或有失敗批次就以非零碼退出（給 .bat 與排程看）。
//
// 注意：EMBED_MODE 預設是 fixture（.env.example）。真的要打 Gemini 請在 .env 設 EMBED_MODE=live。

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const embedService = require('../services/embedService');

// ───────────────────────── 參數 ─────────────────────────

function parseArgs(argv) {
    const args = { ids: null, missingOnly: false, subject: null, chapter: null, limit: null, force: false, dryRun: false, test: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--missing-only') args.missingOnly = true;
        else if (a === '--force') args.force = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--ids') args.ids = String(argv[++i] || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
        else if (a === '--subject') args.subject = argv[++i];
        else if (a === '--chapter') args.chapter = argv[++i];
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--missing-only --ids --subject --chapter --limit --force --dry-run --test`);
    }
    return args;
}

/**
 * 取得 { pool, query }。
 * 預設走 config/db.js（interfaces-stage1.md 第 8 條）；--test 時自建連線打測試庫，
 * 並沿用 migrate.js 的防呆：庫名必須以 _test 結尾，避免回填腳本誤打真題庫。
 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');

    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 4 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 18).join('\n'));
        return 0;
    }

    const model = process.env.EMBED_MODEL || 'gemini-embedding-001';
    const dim = Number.parseInt(process.env.EMBED_DIM || '768', 10);
    const mode = process.env.EMBED_MODE || 'fixture';
    console.log(`模型 ${model}／${dim} 維，EMBED_MODE=${mode}${args.dryRun ? '（dry-run）' : ''}${args.test ? '（測試庫）' : ''}`);

    const db = resolveDb(args.test);
    let exitCode = 0;

    try {
        const ids = args.ids && args.ids.length
            ? args.ids
            : await embedService.selectPendingIds({
                db, model, missingOnly: args.missingOnly,
                subject: args.subject, chapter: args.chapter, limit: args.limit
            });

        console.log(`待處理題數：${ids.length}`);

        let done = 0;
        const res = await embedService.embedByIds(ids, {
            db, model, dim, force: args.force, dryRun: args.dryRun,
            onBatch: ({ batchIds, embedded, skipped, error }) => {
                done += batchIds.length;
                const tail = error ? `失敗：${error}` : `新算 ${embedded}、略過 ${skipped}`;
                console.log(`  [${done}/${ids.length}] ${tail}`);
            }
        });

        console.log(`\n完成：新算 ${res.embedded} 題、略過 ${res.skipped} 題（embed_hash 與模型都沒變）。`);

        if (res.failed.length) {
            const outFile = path.resolve(__dirname, '..', 'eval', 'local', 'backfill_failed.json');
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            // 一律由 Node 寫檔（PowerShell 的 > 會寫 BOM）；只記 id 與錯誤訊息，不含題目內容
            fs.writeFileSync(outFile, JSON.stringify({ model, dim, failed: res.failed }, null, 2) + '\n', 'utf8');
            console.error(`⚠ 有 ${res.failed.length} 批失敗，清單已寫入 ${outFile}`);
            exitCode = 1;
        }

        if (!args.dryRun) {
            const missing = await embedService.countMissingEmbeddings(db);
            console.log(`目前仍無向量的題數：${missing}`);
            if (missing > 0) exitCode = 1;
        }
    } finally {
        if (db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => {});
    }

    return exitCode;
}

main()
    .then(code => process.exit(code))
    .catch(err => { console.error('❌ ' + err.message); process.exit(1); });
