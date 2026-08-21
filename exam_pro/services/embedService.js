// services/embedService.js — 題目向量與 search_tsv 的唯一寫入點（WS-C / D-V1）
//
// 規劃 §2.3.6 的寫入路徑表：controller 新增／更新題目後 fire-and-forget 呼叫 embedByIds()，
// scripts/backfill_embeddings.js 則是主要來源。兩邊都走這一支，寫入規則才只有一份。
//
// 「該不該重算」的唯一依據（§1.5 共用資源表）：
//   embedding IS NULL  或  embed_hash <> sha256(buildEmbedText(q))  或  embedding_model <> EMBED_MODEL
//
// search_tsv 的權重規則（規劃 §2.3.7）：章節 A、關鍵詞 A、題幹 B；
// 三段都先過 utils/tokenize.js，再以 to_tsvector('simple', array_to_string($n::text[], ' ')) 組。
// interfaces.md 第 2 條明講不提供 toTsvSql()，因此這段 SQL 在本檔與 WS-A 的 controller 各有一份，
// 規則以 docs/retrieval.md 為準，改動要同步。

const crypto = require('crypto');
const pgvector = require('pgvector');

const { buildEmbedText } = require('../utils/embedText');
const { tokenize } = require('../utils/tokenize');
const llm = require('./llm');

const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_DIM = 768;
const DEFAULT_BATCH = 32;

/** 回填時需要的欄位；順序與下面的 UPDATE 對應 */
const SELECT_COLUMNS = `id, subject, chapter, question_type, difficulty, question_text,
                        concept_summary, keywords, embed_hash, embedding_model,
                        (embedding IS NULL) AS embedding_is_null`;

const UPDATE_SQL = `
    UPDATE questions SET
        embed_text      = $2,
        embed_hash      = $3,
        embedding       = $4::vector,
        embedding_model = $5,
        embedded_at     = now(),
        search_tsv      = setweight(to_tsvector('simple', array_to_string($6::text[], ' ')), 'A')
                       || setweight(to_tsvector('simple', array_to_string($7::text[], ' ')), 'A')
                       || setweight(to_tsvector('simple', array_to_string($8::text[], ' ')), 'B')
     WHERE id = $1`;

/** sha256 十六進位小寫，與 questions.embed_hash（CHAR(64)）同一套規則 */
function sha256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * search_tsv 三段的 token（純函式，供單元測試釘住）。
 * @returns {{chapterTokens:string[], keywordTokens:string[], stemTokens:string[]}}
 */
function buildTsvTokens(row) {
    // 章節名同時收「整串」與「拆開」兩種切法：白名單裡的章節名整串在自訂詞典中，
    // 只放整串的話，題幹裡的『向心力』就對不上章節段的『摩擦力與向心力』。
    const chapterRaw = row.chapter === null || row.chapter === undefined ? '' : String(row.chapter);
    const chapterTokens = [...new Set([
        ...tokenize(chapterRaw),
        ...tokenize(chapterRaw.replace(/[（）()、，,／/與]/g, ' ')),
    ])];

    return {
        chapterTokens,
        keywordTokens: tokenize(Array.isArray(row.keywords) ? row.keywords.join(' ') : row.keywords),
        stemTokens: tokenize(buildEmbedText(row).split('\n').slice(1).join(' ')),
    };
}

/**
 * 決定每一列要不要重算（純函式，不碰 DB、不呼叫 API）。
 * @param {object[]} rows  SELECT_COLUMNS 撈回來的列
 * @param {{model:string, force?:boolean}} opts
 * @returns {{id:number, embedText:string, embedHash:string, reason:string, needsEmbed:boolean, row:object}[]}
 */
function planRows(rows, { model, force = false } = {}) {
    return rows.map((row) => {
        const embedText = buildEmbedText(row);
        const embedHash = sha256Hex(embedText);

        let reason = null;
        if (force) reason = 'force';
        else if (row.embedding_is_null) reason = 'missing';
        else if (row.embed_hash !== embedHash) reason = 'hash_changed';
        else if (row.embedding_model !== model) reason = 'model_changed';

        return { id: row.id, embedText, embedHash, reason, needsEmbed: reason !== null, row };
    });
}

/**
 * 取得 DB 存取層。interfaces.md 第 8 條：config/db.js 匯出 { pool, query }。
 * 注意 mysql2 的 pool 也有 query／pool 兩個屬性，所以要認 pg 專有的 pool.connect()，
 * 否則 D-D3 合入前會一路跑到「連不上 MySQL」那種看不懂的錯誤。
 */
function resolveDb(injected) {
    const db = injected || require('../config/db');
    if (!db || typeof db.query !== 'function' || !db.pool || typeof db.pool.connect !== 'function') {
        throw new Error('需要 pg 版的 { pool, query }（interfaces.md 第 8 條）。config/db.js 在 WS-A 的 D-D3 合入前仍是 mysql2，請以 embedByIds(ids, { db }) 注入。');
    }
    return db;
}

/**
 * 對指定的題目 id 重算 embedding 與 search_tsv。
 *
 * 每批 EMBED_BATCH 筆、每批一個交易 → 中斷後重跑就是天然的斷點續跑。
 *
 * @param {number[]} ids
 * @param {{db?:object, model?:string, dim?:number, batchSize?:number, force?:boolean,
 *          dryRun?:boolean, onBatch?:function}} opts
 * @returns {Promise<{requested:number, embedded:number, skipped:number, failed:{ids:number[], error:string}[]}>}
 */
async function embedByIds(ids, opts = {}) {
    const db = resolveDb(opts.db);
    const model = opts.model || process.env.EMBED_MODEL || DEFAULT_MODEL;
    const dim = Number.parseInt(opts.dim || process.env.EMBED_DIM || DEFAULT_DIM, 10);
    const batchSize = Number.parseInt(opts.batchSize || process.env.EMBED_BATCH || DEFAULT_BATCH, 10);
    const force = Boolean(opts.force);
    const dryRun = Boolean(opts.dryRun);

    const targetIds = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    const result = { requested: targetIds.length, embedded: 0, skipped: 0, failed: [] };
    if (targetIds.length === 0) return result;

    for (let offset = 0; offset < targetIds.length; offset += batchSize) {
        const batchIds = targetIds.slice(offset, offset + batchSize);
        const { rows } = await db.query(
            `SELECT ${SELECT_COLUMNS} FROM questions WHERE id = ANY($1::int[]) ORDER BY id`,
            [batchIds]
        );

        const plans = planRows(rows, { model, force });
        const todo = plans.filter(p => p.needsEmbed);
        result.skipped += plans.length - todo.length;
        if (todo.length === 0) {
            if (opts.onBatch) opts.onBatch({ batchIds, embedded: 0, skipped: plans.length });
            continue;
        }
        if (dryRun) {
            result.embedded += todo.length;
            if (opts.onBatch) opts.onBatch({ batchIds, embedded: todo.length, skipped: plans.length - todo.length, dryRun: true });
            continue;
        }

        try {
            const { vectors } = await llm.embed({ model, texts: todo.map(p => p.embedText), dim });

            // 一批一個交易：整批成功才 COMMIT，失敗整批留給下次重跑
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                for (let i = 0; i < todo.length; i++) {
                    const p = todo[i];
                    const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(p.row);
                    await client.query(UPDATE_SQL, [
                        p.id, p.embedText, p.embedHash, pgvector.toSql(vectors[i]), model,
                        chapterTokens, keywordTokens, stemTokens
                    ]);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }

            result.embedded += todo.length;
            if (opts.onBatch) opts.onBatch({ batchIds, embedded: todo.length, skipped: plans.length - todo.length });
        } catch (err) {
            // 單批失敗不中斷整輪：記下 id 讓腳本輸出失敗清單，其餘批次照跑
            result.failed.push({ ids: todo.map(p => p.id), error: err.message });
            if (opts.onBatch) opts.onBatch({ batchIds, embedded: 0, skipped: plans.length - todo.length, error: err.message });
        }
    }

    return result;
}

/**
 * 挑出需要處理的題目 id（回填腳本用）。
 * 預設把所有未封存的題都撈出來對帳——真正要不要呼叫 API 由 planRows() 以 embed_hash 決定；
 * --missing-only 則只看「沒有向量／換過模型」，省掉全表掃描。
 */
async function selectPendingIds({ db, model, missingOnly = false, subject = null, chapter = null, limit = null } = {}) {
    const conditions = ['archived_at IS NULL'];
    const values = [];

    if (missingOnly) {
        values.push(model);
        conditions.push(`(embedding IS NULL OR embed_hash IS NULL OR embedding_model IS DISTINCT FROM $${values.length})`);
    }
    if (subject) { values.push(subject); conditions.push(`subject = $${values.length}`); }
    if (chapter) { values.push(chapter); conditions.push(`chapter = $${values.length}`); }

    let sql = `SELECT id FROM questions WHERE ${conditions.join(' AND ')} ORDER BY id`;
    if (limit) { values.push(limit); sql += ` LIMIT $${values.length}`; }

    const { rows } = await db.query(sql, values);
    return rows.map(r => r.id);
}

/** 回填收尾用：還有幾題沒有向量 */
async function countMissingEmbeddings(db) {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM questions WHERE archived_at IS NULL AND embedding IS NULL');
    return rows[0].n;
}

module.exports = {
    embedByIds, selectPendingIds, countMissingEmbeddings,
    planRows, buildTsvTokens, sha256Hex, UPDATE_SQL, SELECT_COLUMNS
};
