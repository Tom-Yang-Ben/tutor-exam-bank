// ─────────────────────────────────────────────────────────────
// eval/lib/pgEngine.js — 對真 PostgreSQL 跑向量／hybrid 欄
//
// 分工要求：「向量與 hybrid 欄直接對 PG 下 WS-C 的 queries/hybrid.js，不經 HTTP」。
// 理由（規劃 §5.3.4 末段）：eval 與 prod 走同一段 SQL，只調 ef_search，
// 量到的就是 prod 的查詢路徑；繞 HTTP 只會多量到 Express 與 JSON 序列化。
//
// **向量欄也用 buildHybridQuery**，傳 sides: ['vec']（interfaces 第 5 條、裁決 18）。
// 這樣「向量欄」與「hybrid 欄」共用同一段 SQL 與同一組候選條件，兩欄的差異只剩融合本身；
// 另寫一句 ORDER BY embedding <=> $1 的話，量到的差異裡會混進候選集不同造成的假差異。
//
// 舊做法是傳 queryTokens: []「讓關鍵字側自然回空集合」。裁決 18 給了 sides 之後就不該再這樣：
// 空 queryTokens 只保證關鍵字側是空的，並沒有保證整段 SQL 會走成純向量路徑，
// 而 /similar 的 mode=vector 走的是 sides:['vec']——eval 要量的是 prod 走的那一條。
//
// LIKE 欄不在這裡：對 fixture 這種短字串，JS 的 includes 與 SQL 的 LIKE '%詞%'
// 是同一件事（見 eval/lib/ranker.js 的說明），沒有理由讓它多一個「今天有沒有 DB」的變數。
// ─────────────────────────────────────────────────────────────

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// 裁決 21：eval 灌 fixture 時的 search_tsv 必須用 embedService 匯出的同一支純函式
const { buildTsvTokens } = require('../../services/embedService');

/**
 * 取得 eval 專用的 { pool, query }——**只連 TEST_DATABASE_URL，絕不連 DATABASE_URL**。
 *
 * 裁決 26（2026-08-21）：seedFixture() 會 TRUNCATE 四張表，所以這裡不能走 config/db.js
 * （它連的是 DATABASE_URL＝開發／正式庫；CI 沒有 5442 時則是 ECONNREFUSED 的空訊息 AggregateError）。
 * 與 test/integration/ 同一條規則：只讀 TEST_DATABASE_URL，且庫名必須以 _test 結尾。
 * 型別轉換與 config/db.js 第 8 條一致（INT8→number、DATE→'YYYY-MM-DD' 字串）。
 * @returns {{pool:object, query:Function}}
 */
let _db = null;
function requireDb() {
    if (_db) return _db;
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
        throw new Error(
            'TEST_DATABASE_URL 未設。eval 的 pg engine 只對測試庫跑（docs/interfaces.md 第 9 條），不會碰 DATABASE_URL；\n' +
            '   本機請 node --env-file=.env --env-file=eval/.env.replay eval/run.js …，或改用 --engine memory。'
        );
    }
    if (!/_test(\?|$)/.test(url)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾（eval 會 TRUNCATE，防止打到正式庫）。');
    }
    const { Pool, types } = require('pg');
    types.setTypeParser(20, v => parseInt(v, 10));
    types.setTypeParser(1082, v => v);
    const pool = new Pool({ connectionString: url, max: 4 });
    _db = { pool, query: (text, values) => pool.query(text, values) };
    return _db;
}

/**
 * 取得 queries/hybrid.js 的 buildHybridQuery。
 * @returns {Function}
 */
function requireHybrid() {
    let mod;
    try {
        mod = require(path.join(ROOT, 'queries', 'hybrid.js'));
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            throw new Error(
                'queries/hybrid.js（WS-C 的 D-R1）尚未合入，pg engine 無法運作。\n' +
                '   在那之前請用 --engine memory；D-R2 的三欄對照與 Jaccard 斷言要等它合入才有意義。'
            );
        }
        throw err;
    }
    if (typeof mod.buildHybridQuery !== 'function') {
        throw new Error('queries/hybrid.js 沒有匯出 buildHybridQuery（docs/interfaces.md 第 5 條）。');
    }
    return mod.buildHybridQuery;
}

/** pg engine 是否已經可用（兩個相依都在） */
function available() {
    try { requireDb(); requireHybrid(); return true; } catch { return false; }
}

/** 為什麼不可用（給報表與 CI log 用） */
function unavailableReason() {
    try { requireDb(); } catch (e) { return e.message; }
    try { requireHybrid(); } catch (e) { return e.message; }
    return null;
}

/**
 * 向量陣列 → PG 可讀的字面值。
 * 有 pgvector 套件就用官方的 toSql（interfaces 第 8 條要求寫入一律走它）；
 * 沒有（階段 1 初期 package.json 還沒加）就退回同格式的字串，格式與 toSql 相同。
 * @param {number[]} v
 * @returns {string}
 */
function toVectorLiteral(v) {
    try {
        return require('pgvector').toSql(v);
    } catch {
        return `[${v.join(',')}]`;
    }
}

/**
 * 把 fixture 灌進測試庫（TRUNCATE 後重灌，可重複執行）。
 * 只寫 eval 需要的欄位：檢索三欄要的是 question_text / embedding / search_tsv。
 *
 * search_tsv 的三段 token 一律呼叫 services/embedService.js 的 buildTsvTokens()
 * （interfaces 第 2 條、裁決 21：寫入、回填、eval 三處只能用同一支純函式），
 * 並照 embedService 的 UPDATE 用 setweight 組成 章節 A ‖ keywords A ‖ 題幹 B。
 * 自己在這裡 tokenize(buildEmbedText(q)) 會少掉權重與章節段的兩種切法，
 * eval 就會在一份與 prod 不同的索引上量數字。
 *
 * @param {object} opts
 * @param {Array<object>} opts.questions
 * @param {(q:object)=>number[]|null} opts.vectorOf
 * @param {(q:object)=>string} opts.embedTextOf
 * @param {(s:string)=>string} opts.hashOf
 * @returns {Promise<{inserted:number, idMap:Map<number,number>}>} idMap: fixture id → questions.id
 */
async function seedFixture(opts) {
    const { pool } = requireDb();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // attempts / exam_papers 對 questions 有 FK，一起清掉；RESTART IDENTITY 讓 id 每次相同。
        await client.query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');

        const idMap = new Map();
        for (const q of opts.questions) {
            const embedText = opts.embedTextOf(q);
            const vec = opts.vectorOf ? opts.vectorOf(q) : null;
            const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(q);

            // 參數位置隨「這題有沒有向量」而變，所以逐一 push 而不是寫死 $9/$10/$11——
            // 手動編號在有無向量兩條路徑之間最容易錯位，而錯位只會表現成「tsv 是空的」。
            const values = [q.subject, q.chapter, q.question_type, q.difficulty,
                q.question_text, q.answer_text, embedText, opts.hashOf(embedText)];
            let embeddingSql = 'NULL';
            let modelSql = 'NULL';
            let embeddedAtSql = 'NULL';
            if (vec) {
                values.push(toVectorLiteral(vec));
                embeddingSql = `$${values.length}::vector`;
                values.push(opts.model || null);
                modelSql = `$${values.length}`;
                embeddedAtSql = 'now()';
            }
            values.push(chapterTokens); const pChapter = values.length;
            values.push(keywordTokens); const pKeyword = values.length;
            values.push(stemTokens); const pStem = values.length;
            const tsvSql =
                `setweight(to_tsvector('simple', array_to_string($${pChapter}::text[], ' ')), 'A')` +
                ` || setweight(to_tsvector('simple', array_to_string($${pKeyword}::text[], ' ')), 'A')` +
                ` || setweight(to_tsvector('simple', array_to_string($${pStem}::text[], ' ')), 'B')`;

            const res = await client.query(
                `INSERT INTO questions
                   (subject, chapter, question_type, difficulty, question_text, answer_text,
                    origin, chapter_src, embed_text, embed_hash, embedding, embedding_model, embedded_at, search_tsv)
                 VALUES ($1, $2, $3, $4, $5, $6, 'seed', 'human', $7, $8,
                         ${embeddingSql}, ${modelSql}, ${embeddedAtSql}, ${tsvSql})
                 RETURNING id`,
                values
            );
            idMap.set(q.id, res.rows[0].id);
        }
        await client.query('COMMIT');
        return { inserted: idMap.size, idMap };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * 對 PG 跑一次檢索。
 *
 * @param {object} opts
 * @param {object} opts.source        來源題（fixture 物件）
 * @param {number[]} opts.queryVector
 * @param {string[]} opts.queryTokens 關鍵字側的查詢詞；sides 不含 'kw' 時可為 []
 * @param {('vec'|'kw')[]} [opts.sides] interfaces 第 5 條的選用參數（裁決 18）：純向量欄傳 ['vec']
 * @param {'chapter'|'subject'|'all'} opts.scope
 * @param {number[]} opts.excludeIds  已是 questions.id
 * @param {'rrf'|'weighted'} opts.fuseMode
 * @param {number} opts.limit
 * @param {number} opts.efSearch      SET LOCAL hnsw.ef_search，eval 設為不小於 fixture 題數以求等效精確
 * @returns {Promise<Array<{id:number, score:number, vec_rank:number|null, kw_rank:number|null}>>}
 */
async function search(opts) {
    const { pool } = requireDb();
    const buildHybridQuery = requireHybrid();

    const built = buildHybridQuery({
        subject: opts.source.subject,
        chapter: opts.scope === 'chapter' ? opts.source.chapter : null,
        difficultyMin: 1,
        difficultyMax: 5,
        excludeStudentId: null,
        excludeIds: opts.excludeIds || [],
        queryVector: opts.queryVector,
        queryTokens: opts.queryTokens || [],
        mode: opts.fuseMode || 'rrf',
        sides: opts.sides || ['vec', 'kw'],
        limit: opts.limit || 10
    });

    const client = await pool.connect();
    try {
        // 交易內設 ef_search：eval 要「等效精確」，否則 HNSW 的近似會讓同一份 fixture
        // 每次量到略微不同的前 10 名，Jaccard 斷言會變成擲骰子。
        await client.query('BEGIN');
        await client.query(`SET LOCAL hnsw.ef_search = ${Number(opts.efSearch) || 200}`);
        const res = await client.query(built.text, built.values);
        await client.query('COMMIT');
        return res.rows;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { requireDb, requireHybrid, available, unavailableReason, seedFixture, search, toVectorLiteral };
