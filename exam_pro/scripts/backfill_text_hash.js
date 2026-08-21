// scripts/backfill_text_hash.js — 回填 questions.text_hash（A-T1，階段 2 L0 去重的基礎）
//
// 用法：
//   node scripts/backfill_text_hash.js              對 DATABASE_URL 回填（只補 text_hash IS NULL 的題）
//   node scripts/backfill_text_hash.js --force      全部重算（正規化規則改過時用）
//   node scripts/backfill_text_hash.js --dry-run    只算、只印碰撞報告，不寫 DB
//   node scripts/backfill_text_hash.js --test       改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//   node scripts/backfill_text_hash.js --limit 100  只處理前 N 題（除錯用）
//   node scripts/backfill_text_hash.js --report eval/local/text_hash_collisions.json   另存碰撞清單
//
// 為什麼不建 UNIQUE：手動錄入的題目從未做過去重，seed_questions.js 也只對自己跳過重複，
// 所以回填「一定」會撞到既有重複題。本腳本印出碰撞清單，由人決定合併（或確認是不同題）之後，
// 才另開一支 migration 改成 UNIQUE（docs/interfaces-stage2.md 第 1 條）。
//
// ✅ 已於 A-T5（WS-C）換成正式實作：正規化規則的唯一真相是 utils/normalizeStem.js
//    （docs/interfaces-stage2.md 第 4.1 條的七個步驟，順序凍結）。
//    本檔原本的自含版已刪除；等價性由 test/unit/normalizeStem.test.js 對
//    「S0 自含版的規則」逐條釘住，兩者對同一輸入產出逐位元相同的雜湊。
//    規則一改，全庫的 text_hash 作廢，必須 `--force` 重算並在 PR 說明。

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeStem, textHash } = require('../utils/normalizeStem');

// ───────────────────────── 參數 ─────────────────────────

function parseArgs(argv) {
    const args = { force: false, dryRun: false, test: false, limit: null, report: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') args.force = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
        else if (a === '--report') args.report = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--force --dry-run --test --limit --report`);
    }
    if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
        throw new Error('--limit 必須是大於 0 的整數');
    }
    return args;
}

/**
 * 取得 { pool, query }：與 scripts/backfill_embeddings.js 同一套規則。
 * --test 時自建連線並沿用 migrate.js 的防呆（庫名必須以 _test 結尾）。
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

const BATCH = 200;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 18).join('\n'));
        return 0;
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    console.log(`回填 questions.text_hash → ${target}${args.dryRun ? '（dry-run，不寫入）' : ''}`);

    // 已封存的題也一起算：dedup0 要能認出「新拆的題和一年前封存的那題是同一題」。
    const where = args.force ? '' : 'WHERE text_hash IS NULL';
    const limit = args.limit ? ` LIMIT ${args.limit}` : '';
    const { rows } = await db.query(
        `SELECT id, subject, chapter, question_text, archived_at FROM questions ${where} ORDER BY id${limit}`
    );
    console.log(`待處理 ${rows.length} 題（${args.force ? '--force 全量重算' : '只補 text_hash IS NULL'}）。`);

    let written = 0;
    let empty = 0;
    const computed = [];   // { id, hash, subject, chapter, preview }

    for (const r of rows) {
        const hash = textHash(r.question_text);
        if (hash === null) { empty++; continue; }
        computed.push({
            id: r.id, hash, subject: r.subject, chapter: r.chapter,
            preview: String(r.question_text).replace(/\s+/g, ' ').slice(0, 60),
            archived: r.archived_at !== null
        });
    }

    if (!args.dryRun) {
        // 每批一個交易＝天然的斷點續跑；unnest 讓一批只送一次往返
        for (let i = 0; i < computed.length; i += BATCH) {
            const slice = computed.slice(i, i + BATCH);
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `UPDATE questions AS q SET text_hash = v.hash
                       FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS hash) AS v
                      WHERE q.id = v.id`,
                    [slice.map(c => c.id), slice.map(c => c.hash)]
                );
                await client.query('COMMIT');
                written += slice.length;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            process.stdout.write(`\r  已寫入 ${written}/${computed.length}`);
        }
        if (computed.length > 0) process.stdout.write('\n');
    }

    // ── 碰撞報告：以「整個 questions 表」為範圍，不只這次算的那幾題 ──
    //
    // 刻意「不」用 SQL 的 GROUP BY text_hash：--dry-run 時什麼都還沒寫進 DB，
    // 那樣查出來永遠是 0 組，報告就白做了。改成把「DB 既有的雜湊」與「這次算出來的」
    // 合併在記憶體裡分組——dry-run 與正式回填看到的是同一份結果。
    const { rows: all } = await db.query(
        'SELECT id, subject, chapter, question_text, text_hash, archived_at FROM questions ORDER BY id'
    );
    const byId = new Map(computed.map(c => [c.id, c]));
    const groups = new Map();   // hash → [{id, ...}]
    for (const r of all) {
        const c = byId.get(r.id);
        const hash = c ? c.hash : r.text_hash;
        if (!hash) continue;
        const item = c || {
            id: r.id, hash, subject: r.subject, chapter: r.chapter,
            preview: String(r.question_text || '').replace(/\s+/g, ' ').slice(0, 60),
            archived: r.archived_at !== null
        };
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push(item);
    }
    const collisions = [...groups.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([text_hash, items]) => ({ text_hash, ids: items.map(i => i.id), items }))
        .sort((a, b) => b.ids.length - a.ids.length || a.ids[0] - b.ids[0]);

    console.log('\n──────── 結果 ────────');
    console.log(`計算 ${computed.length} 題；題幹為空而跳過 ${empty} 題；${args.dryRun ? '（dry-run 未寫入）' : `寫入 ${written} 題`}`);
    console.log(`碰撞（同一 text_hash 有多題）：${collisions.length} 組，共 ${collisions.reduce((s, c) => s + c.ids.length, 0)} 題`);

    for (const c of collisions) {
        console.log(`\n  ⚠ ${c.ids.join(' / ')}（${c.ids.length} 題）`);
        for (const it of c.items) {
            console.log(`      #${it.id} ${it.subject}｜${it.chapter}${it.archived ? '（已封存）' : ''}：${it.preview}…`);
        }
    }

    if (collisions.length > 0) {
        console.log('\n請逐組判斷「是同一題還是不同題」：確認可合併後，才另開一支 migration 把 idx_questions_text_hash 改成 UNIQUE。');
    } else {
        console.log('沒有碰撞——但仍維持非唯一索引，等階段 2 拆題實際跑過一輪再談 UNIQUE。');
    }

    if (args.report) {
        const out = path.resolve(args.report);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({
            ranAt: new Date().toISOString(), target, dryRun: args.dryRun,
            counted: computed.length, empty, written, collisions
        }, null, 2), 'utf8');
        console.log(`碰撞清單已寫入 ${out}`);
    }

    // 收尾：--test 時自建的 pool 要自己關；config/db.js 的 pool 由行程結束收掉
    if (args.test) await db.pool.end();
    return 0;
}

// 給單元測試與 WS-C 對照用（正式實作以 utils/normalizeStem.js 為準）
module.exports = { normalizeStem, textHash };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
