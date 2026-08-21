// services/embedService.js 單元測試（WS-C / D-V1）
//
// 不連 DB：用一個假的 { pool, query } 注入（interfaces.md 第 8 條的形狀），
// embedding 走 EMBED_MODE=fixture。真的打 PG 的驗證在 test/integration/hybrid.pg.test.js。
//
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const embedService = require('../../services/embedService');
const { buildEmbedText } = require('../../utils/embedText');
const { saveToFixture, sha256Hex } = require('../../services/llm/fixture');

const MODEL = 'test-embed-model';
const DIM = 4;

const ROW = {
    id: 1, subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
    question_text: '半徑 $r$ 的等速圓周運動，求向心加速度。',
    concept_summary: null, keywords: ['圓周運動', '向心加速度'],
    embed_hash: null, embedding_model: null, embedding_is_null: true,
};

/** 假的 { pool, query }：只認得 embedService 會下的兩種 SQL */
function makeFakeDb(rows) {
    const calls = { selects: [], updates: [], tx: [] };
    const client = {
        query: async (text, values) => {
            if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) { calls.tx.push(text.trim()); return { rows: [], rowCount: 0 }; }
            calls.updates.push({ text, values });
            return { rows: [], rowCount: 1 };
        },
        release: () => {},
    };
    return {
        calls,
        pool: { connect: async () => client },
        query: async (text, values) => {
            calls.selects.push({ text, values });
            if (/FROM questions WHERE id = ANY/.test(text)) {
                const ids = values[0];
                return { rows: rows.filter(r => ids.includes(r.id)), rowCount: 0 };
            }
            if (/count\(\*\)/.test(text)) return { rows: [{ n: 0 }], rowCount: 1 };
            return { rows: rows.map(r => ({ id: r.id })), rowCount: rows.length };
        },
    };
}

let tmpDir;
const envBackup = {};

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-embedservice-'));
    for (const k of ['EMBED_FIXTURE_DIR', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM', 'EMBED_BATCH']) envBackup[k] = process.env[k];
    process.env.EMBED_FIXTURE_DIR = tmpDir;
    process.env.EMBED_MODE = 'fixture';
    saveToFixture({ model: MODEL, dim: DIM, entries: [[sha256Hex(buildEmbedText(ROW)), [1, 0, 0, 0]]] });
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('planRows — 該不該重算', () => {
    const hash = embedService.sha256Hex(buildEmbedText(ROW));

    test('沒有向量 → missing', () => {
        assert.equal(embedService.planRows([ROW], { model: MODEL })[0].reason, 'missing');
    });

    test('題目內容改過（embed_hash 對不上）→ hash_changed', () => {
        const row = { ...ROW, embedding_is_null: false, embed_hash: 'a'.repeat(64), embedding_model: MODEL };
        assert.equal(embedService.planRows([row], { model: MODEL })[0].reason, 'hash_changed');
    });

    test('換模型 → model_changed', () => {
        const row = { ...ROW, embedding_is_null: false, embed_hash: hash, embedding_model: '舊模型' };
        assert.equal(embedService.planRows([row], { model: MODEL })[0].reason, 'model_changed');
    });

    test('三個條件都沒中 → 不重算', () => {
        const row = { ...ROW, embedding_is_null: false, embed_hash: hash, embedding_model: MODEL };
        const plan = embedService.planRows([row], { model: MODEL })[0];
        assert.equal(plan.needsEmbed, false);
        assert.equal(plan.reason, null);
    });

    test('force 蓋過一切', () => {
        const row = { ...ROW, embedding_is_null: false, embed_hash: hash, embedding_model: MODEL };
        assert.equal(embedService.planRows([row], { model: MODEL, force: true })[0].reason, 'force');
    });

    test('embedHash = sha256(buildEmbedText(q))，與 fixture 的查表鍵是同一個值', () => {
        assert.equal(embedService.planRows([ROW], { model: MODEL })[0].embedHash, hash);
    });
});

describe('buildTsvTokens — search_tsv 的三段', () => {
    test('章節、關鍵詞、題幹各自過 tokenize', () => {
        const t = embedService.buildTsvTokens(ROW);
        assert.ok(t.chapterTokens.includes('向心力'), JSON.stringify(t.chapterTokens));
        assert.ok(t.keywordTokens.includes('圓周運動'));
        assert.ok(t.stemTokens.includes('向心加速度'));
    });

    test('keywords 為 null 時關鍵詞段是空陣列，不丟例外', () => {
        const t = embedService.buildTsvTokens({ ...ROW, keywords: null });
        assert.deepEqual(t.keywordTokens, []);
    });
});

describe('embedByIds — 交易與略過', () => {
    test('需要重算時：一批一個交易，UPDATE 帶 8 個參數', async () => {
        const db = makeFakeDb([ROW]);
        const res = await embedService.embedByIds([1], { db, model: MODEL, dim: DIM });

        assert.equal(res.embedded, 1);
        assert.equal(res.skipped, 0);
        assert.deepEqual(res.failed, []);
        assert.deepEqual(db.calls.tx, ['BEGIN', 'COMMIT']);
        assert.equal(db.calls.updates.length, 1);
        assert.equal(db.calls.updates[0].values.length, 8);
        assert.match(db.calls.updates[0].text, /search_tsv\s+= setweight/);
        assert.match(db.calls.updates[0].values[3], /^\[/);        // pgvector.toSql 的字串形式
    });

    test('已是最新的題：不呼叫 API、不開交易', async () => {
        const upToDate = {
            ...ROW, embedding_is_null: false, embedding_model: MODEL,
            embed_hash: embedService.sha256Hex(buildEmbedText(ROW)),
        };
        const db = makeFakeDb([upToDate]);
        const res = await embedService.embedByIds([1], { db, model: MODEL, dim: DIM });

        assert.equal(res.embedded, 0);
        assert.equal(res.skipped, 1);
        assert.deepEqual(db.calls.tx, []);
    });

    test('dry-run：算得出要處理幾題，但不開交易', async () => {
        const db = makeFakeDb([ROW]);
        const res = await embedService.embedByIds([1], { db, model: MODEL, dim: DIM, dryRun: true });
        assert.equal(res.embedded, 1);
        assert.deepEqual(db.calls.tx, []);
    });

    test('embedding 失敗：記進 failed 而不是整輪中斷', async () => {
        const db = makeFakeDb([{ ...ROW, id: 2, question_text: '這一題沒有錄過向量' }]);
        const res = await embedService.embedByIds([2], { db, model: MODEL, dim: DIM });
        assert.equal(res.embedded, 0);
        assert.equal(res.failed.length, 1);
        assert.deepEqual(res.failed[0].ids, [2]);
        assert.match(res.failed[0].error, /查無此文本/);
        assert.deepEqual(db.calls.tx, []);   // 沒拿到向量就不該開交易
    });

    test('空的 id 清單 → 什麼都不做', async () => {
        const db = makeFakeDb([ROW]);
        const res = await embedService.embedByIds([], { db, model: MODEL, dim: DIM });
        assert.deepEqual(res, { requested: 0, embedded: 0, skipped: 0, failed: [] });
        assert.equal(db.calls.selects.length, 0);
    });

    test('重複 id 只算一次', async () => {
        const db = makeFakeDb([ROW]);
        const res = await embedService.embedByIds([1, 1, 1], { db, model: MODEL, dim: DIM });
        assert.equal(res.requested, 1);
        assert.equal(res.embedded, 1);
    });

    test('注入的 db 不是 pg 版的 { pool, query } → 訊息要說清楚在等誰（且不會真的連任何資料庫）', async () => {
        await assert.rejects(
            () => embedService.embedByIds([1], { db: { query: async () => ({ rows: [] }) }, model: MODEL, dim: DIM }),
            /需要 pg 版的/
        );
    });
});

describe('selectPendingIds — 候選條件', () => {
    test('一律排除已封存題', async () => {
        const db = makeFakeDb([ROW]);
        await embedService.selectPendingIds({ db, model: MODEL });
        assert.match(db.calls.selects[0].text, /archived_at IS NULL/);
    });

    test('--missing-only 才加「沒有向量／換過模型」條件', async () => {
        const db = makeFakeDb([ROW]);
        await embedService.selectPendingIds({ db, model: MODEL, missingOnly: true });
        assert.match(db.calls.selects[0].text, /embedding IS NULL OR embed_hash IS NULL OR embedding_model IS DISTINCT FROM/);
    });

    test('subject／chapter／limit 以參數化條件加上去', async () => {
        const db = makeFakeDb([ROW]);
        await embedService.selectPendingIds({ db, model: MODEL, subject: '物理', chapter: '向心力', limit: 10 });
        const call = db.calls.selects[0];
        assert.match(call.text, /subject = \$1 AND chapter = \$2/);
        assert.match(call.text, /LIMIT \$3/);
        assert.deepEqual(call.values, ['物理', '向心力', 10]);
    });
});
