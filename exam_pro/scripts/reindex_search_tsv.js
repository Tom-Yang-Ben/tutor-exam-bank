// scripts/reindex_search_tsv.js — 以目前的分詞詞典重算全部題目的 search_tsv（階段 5 WS-B；docs/chemistry.md 第 4.3 節）
//
// 用法：
//   npm run search:reindex                     對 DATABASE_URL 全量重切，只寫回有變的題
//   npm run search:reindex -- --dry-run        只算、只印「會變幾題」與例子，不寫 DB
//   npm run search:reindex -- --test           改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//   npm run search:reindex -- --limit 100      只處理前 N 題（除錯用）
//
// 為什麼要有這一支：search_tsv 是**寫入當下**用 utils/tokenize.js 切好存進 DB 的，查詢端則每次用
// 當下的詞典切（queries/hybrid.js 以 to_tsquery 把查詢 token OR 起來）。詞典一改——EXAM_TERMS 或
// 章節白名單（章節名會經 expandChapterWords 進詞典）——同一段文字兩邊就切得不一樣：
// 例如階段 5 併入化學後，「質量數為 238」由「質量／數為」變成「質量數」，新的查詢「質量數」
// 就對不上舊題的 search_tsv，hybrid 的關鍵字側從此查不到這些舊題。
// 既有的 scripts/backfill_embeddings.js 只在 embed_hash 變了才重寫 search_tsv（分詞改了 embed_hash 不會變），
// 而且會呼叫 embedding API，所以另立這一支。
//
// 行為：
//   - **不呼叫 LLM、不需金鑰**，不動 embedding／embed_text／embed_hash（向量的輸入文字與分詞無關）。
//   - token 一律由 services/embedService.js 的 buildTsvTokens() 產生（裁決 21：寫入端不得自行 tokenize）；
//     SQL 與 controllers/questionController.js 的 SEARCH_TSV_ASSIGN 是同一段（interfaces-stage1.md 第 2 條
//     不提供 toTsvSql()，寫入端各自組），等價性由 test/integration/searchReindex.pg.test.js 對
//     「POST /api/questions 寫進去的值」釘住。
//   - 已封存的題一起重算（取消封存後要馬上查得到）。
//   - 每批一個交易＝天然斷點續跑；只 UPDATE 真的有變的列（IS DISTINCT FROM），重跑第二次寫入 0 題。

require('dotenv').config();
const fs = require('fs');

// ───────────────────────── SQL ─────────────────────────

/** search_tsv 的組法（章節 A、關鍵詞 A、題幹 B；$2／$3／$4 = buildTsvTokens 的三段） */
const TSV_EXPR = `setweight(to_tsvector('simple', array_to_string($2::text[], ' ')), 'A')
               || setweight(to_tsvector('simple', array_to_string($3::text[], ' ')), 'A')
               || setweight(to_tsvector('simple', array_to_string($4::text[], ' ')), 'B')`;

/** 比對：這一題重切後會不會變；順便取新舊兩版給報告用 */
const DIFF_SQL = `SELECT (search_tsv IS DISTINCT FROM (${TSV_EXPR})) AS changed,
                         search_tsv::text AS old_tsv, (${TSV_EXPR})::text AS new_tsv
                    FROM questions WHERE id = $1`;

const UPDATE_SQL = `UPDATE questions SET search_tsv = ${TSV_EXPR}
                     WHERE id = $1 AND search_tsv IS DISTINCT FROM (${TSV_EXPR})`;

/** buildTsvTokens／buildEmbedText 用得到的欄位（同 services/embedService.js 的 SELECT_COLUMNS） */
const ROW_COLUMNS = 'id, subject, chapter, question_type, difficulty, question_text, concept_summary, keywords';

const BATCH = 200;
const SAMPLE_MAX = 5;

// ───────────────────────── 參數 ─────────────────────────

function parseArgs(argv) {
    const args = { dryRun: false, test: false, limit: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--limit') args.limit = Number(argv[++i]);
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --test --limit`);
    }
    if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
        throw new Error('--limit 必須是大於 0 的整數');
    }
    return args;
}

/**
 * 取得 { pool, query }：與 scripts/backfill_text_hash.js 同一套規則。
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

// ───────────────────────── 核心 ─────────────────────────

/**
 * tsvector 的文字形式 → 詞位清單（'質量':1A '數為':2B → ['質量','數為']）。純函式，給報告用。
 * @param {string|null} tsvText
 * @returns {string[]}
 */
function lexemesOf(tsvText) {
    if (!tsvText) return [];
    return [...String(tsvText).matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

/**
 * 重算 search_tsv。
 *
 * @param {{db:{pool:object, query:function}, dryRun?:boolean, limit?:number|null, batchSize?:number,
 *          onBatch?:function}} opts
 * @returns {Promise<{total:number, changed:number, unchanged:number, written:number,
 *                    samples:Array<{id:number, subject:string, chapter:string, removed:string[], added:string[]}>}>}
 *   changed = 重切後與 DB 不同的題數（dry-run 也會算）；written = 實際寫回的題數（dry-run 恆為 0）
 */
async function reindexSearchTsv({ db, dryRun = false, limit = null, batchSize = BATCH, onBatch } = {}) {
    const { buildTsvTokens } = require('../services/embedService');   // 會載入 jieba 詞典

    const { rows: idRows } = await db.query(
        `SELECT id FROM questions ORDER BY id${limit ? ' LIMIT $1' : ''}`, limit ? [limit] : []);
    const ids = idRows.map(r => r.id);
    const result = { total: ids.length, changed: 0, unchanged: 0, written: 0, samples: [] };

    for (let offset = 0; offset < ids.length; offset += batchSize) {
        const batchIds = ids.slice(offset, offset + batchSize);
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `SELECT ${ROW_COLUMNS} FROM questions WHERE id = ANY($1::int[]) ORDER BY id`, [batchIds]);
            for (const row of rows) {
                const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);
                const params = [row.id, chapterTokens, keywordTokens, stemTokens];
                const diff = (await client.query(DIFF_SQL, params)).rows[0];
                if (!diff || !diff.changed) { result.unchanged += 1; continue; }

                result.changed += 1;
                if (result.samples.length < SAMPLE_MAX) {
                    const before = new Set(lexemesOf(diff.old_tsv));
                    const after = new Set(lexemesOf(diff.new_tsv));
                    result.samples.push({
                        id: row.id, subject: row.subject, chapter: row.chapter,
                        removed: [...before].filter(t => !after.has(t)),
                        added: [...after].filter(t => !before.has(t))
                    });
                }
                if (!dryRun) {
                    const upd = await client.query(UPDATE_SQL, params);
                    result.written += upd.rowCount;
                }
            }
            await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
        if (onBatch) onBatch({ done: Math.min(offset + batchSize, ids.length), total: ids.length });
    }
    return result;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 7).join('\n'));
        return 0;
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    console.log(`重算 questions.search_tsv → ${target}${args.dryRun ? '（dry-run，不寫入）' : ''}`);
    console.log('不呼叫 LLM、不動 embedding；可以中斷再重跑（每批一個交易）。');

    try {
        const r = await reindexSearchTsv({
            db, dryRun: args.dryRun, limit: args.limit,
            onBatch: ({ done, total }) => process.stdout.write(`\r  已檢查 ${done}/${total}`)
        });
        if (r.total > 0) process.stdout.write('\n');

        console.log('\n──────── 結果 ────────');
        console.log(`共 ${r.total} 題；重切後不同 ${r.changed} 題、相同 ${r.unchanged} 題；`
            + (args.dryRun ? '（dry-run 未寫入）' : `寫回 ${r.written} 題`));
        for (const s of r.samples) {
            console.log(`  #${s.id} ${s.subject}｜${s.chapter}：`
                + `少了 ${s.removed.length ? s.removed.join(' ') : '（無）'}；多了 ${s.added.length ? s.added.join(' ') : '（無）'}`);
        }
        if (r.changed > r.samples.length) console.log(`  …其餘 ${r.changed - r.samples.length} 題不逐一列出`);
        if (args.dryRun && r.changed > 0) console.log('確認無誤後，拿掉 --dry-run 再執行一次即可寫回。');
    } finally {
        // --test 時自建的 pool 要自己關；config/db.js 的 pool 也一併關掉，行程才會自己結束
        await db.pool.end();
    }
    return 0;
}

module.exports = { reindexSearchTsv, parseArgs, lexemesOf, TSV_EXPR };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
