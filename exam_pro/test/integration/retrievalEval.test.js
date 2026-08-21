// ─────────────────────────────────────────────────────────────
// test/integration/retrievalEval.test.js — D-R2：三欄對照與 SQL／記憶體排序器一致性
//
// 三個斷言（規劃 §2.8、§5.8）：
//   1. 三欄（LIKE / 純向量 / hybrid）都量得出數字；
//   2. hybrid 的 Recall@5 必須 ≥ LIKE——差值只報不設數字門檻，
//      因為「差多少才算贏」很容易被 baseline 的定義操弄，只有「不得更差」不可爭辯；
//   3. 同一份 fixture 下，SQL（queries/hybrid.js）與記憶體排序器的前 10 名
//      Jaccard ≥ 0.9。這一條才是真正的重點：eval 量到的必須是 prod 的查詢路徑，
//      兩邊排出不同的東西，前兩條數字就都不能拿來談 prod 的行為。
//
// 相依（任一缺席就 skip，並印出缺什麼）：
//   - TEST_DATABASE_URL（庫名以 _test 結尾）
//   - queries/hybrid.js（WS-C 的 D-R1）
//   - config/db.js 的 { pool, query } 形狀（WS-A 的 D-D3）
//   - eval/fixtures/embeddings.<model>.768.json（D-V0，由開發者本人錄）
// skip 而不是 fail，是因為這四項屬於別的 workstream 的合入時程；
// 但 skip 的訊息必須指名道姓，否則「整合測試全綠」會變成「整合測試全都沒跑」。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { loadFixture } = require('../../eval/lib/fixtures');
const { loadGolden } = require('../../eval/lib/golden');
const { loadEmbeddings } = require('../../eval/lib/embeddings');
const { buildEmbedText, embedHash } = require('../../eval/lib/embedText');
const { rankAll, queryTokensFor } = require('../../eval/lib/ranker');
const { jaccard, summarize, round4 } = require('../../eval/lib/metrics');
const pgEngine = require('../../eval/lib/pgEngine');

const JACCARD_MIN = 0.9;
const LIMIT = 10;
const SCOPE = 'subject';

const missing = [];
const URL = process.env.TEST_DATABASE_URL;
if (!URL) missing.push('TEST_DATABASE_URL 未設');
else if (!/_test(\?|$)/.test(URL)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾。');

const fixture = loadFixture();
const golden = loadGolden({ fixtureById: fixture.byId });
const emb = loadEmbeddings({ questions: fixture.questions, optional: true });
if (!emb.available) missing.push(`向量 fixture 未錄製（${require('path').basename(emb.file)}；D-V0，需開發者本人的金鑰）`);
if (!pgEngine.available()) missing.push(pgEngine.unavailableReason().split('\n')[0]);

const SKIP = missing.length > 0;
if (SKIP) console.log(`⏭️  跳過 D-R2 三欄對照：\n   - ${missing.join('\n   - ')}`);

describe('D-R2 三欄對照（對真 PG 下 queries/hybrid.js）', { skip: SKIP }, () => {
    const results = { like: [], vector: [], hybrid: [] };
    const jaccards = [];
    let fxToDb, dbToFx;

    before(async () => {
        const seeded = await pgEngine.seedFixture({
            questions: fixture.questions,
            vectorOf: emb.vectorOf,
            embedTextOf: buildEmbedText,
            hashOf: embedHash,
            model: emb.model
        });
        fxToDb = seeded.idMap;
        dbToFx = new Map([...fxToDb.entries()].map(([fx, db]) => [db, fx]));

        const efSearch = Math.max(100, fixture.questions.length * 4);
        for (const entry of golden.entries) {
            const source = fixture.byId.get(entry.query.value);
            const memory = rankAll({
                source, questions: fixture.questions, vectorOf: emb.vectorOf,
                scope: SCOPE, excludeIds: [source.id], limit: LIMIT
            });
            const common = {
                source, queryVector: emb.vectorOf(source), scope: SCOPE,
                excludeIds: [fxToDb.get(source.id)], fuseMode: 'rrf', limit: LIMIT, efSearch
            };
            // 純向量欄走 sides:['vec']（interfaces 第 5 條、裁決 18），與 /similar 的 mode=vector 同一條路
            const sqlVector = (await pgEngine.search({ ...common, sides: ['vec'], queryTokens: [] })).map(r => dbToFx.get(r.id));
            const sqlHybrid = (await pgEngine.search({ ...common, sides: ['vec', 'kw'], queryTokens: queryTokensFor(source) })).map(r => dbToFx.get(r.id));

            results.like.push({ ranked: memory.like, relevant: entry.relevant });
            results.vector.push({ ranked: sqlVector, relevant: entry.relevant });
            results.hybrid.push({ ranked: sqlHybrid, relevant: entry.relevant });
            jaccards.push({ golden: entry.id, value: jaccard(sqlHybrid, memory.hybrid), sql: sqlHybrid, memory: memory.hybrid });
        }
    });

    after(async () => {
        try { await pgEngine.requireDb().pool.end(); } catch { /* 池已關就算了 */ }
    });

    test('三欄都量得出數字', () => {
        for (const mode of ['like', 'vector', 'hybrid']) {
            const s = summarize(results[mode]);
            assert.equal(s.n, golden.entries.length);
            assert.ok(s.recall5 !== null, `${mode} 欄的 Recall@5 是 null`);
        }
    });

    test('hybrid 的 Recall@5 ≥ LIKE（差值只報不設數字門檻）', () => {
        const like = summarize(results.like);
        const hybrid = summarize(results.hybrid);
        const delta = hybrid.recall5 - like.recall5;
        console.log(`   LIKE Recall@5 = ${round4(like.recall5)}｜hybrid = ${round4(hybrid.recall5)}｜差值 ${delta >= 0 ? '+' : ''}${round4(delta)}`);
        assert.ok(delta >= -1e-9, `hybrid（${round4(hybrid.recall5)}）比 LIKE（${round4(like.recall5)}）差`);
    });

    test('SQL 與記憶體排序器的前 10 名 Jaccard ≥ 0.9（逐題）', () => {
        const worst = jaccards.reduce((a, b) => (b.value < a.value ? b : a));
        const mean = jaccards.reduce((s, j) => s + j.value, 0) / jaccards.length;
        console.log(`   Jaccard 平均 ${round4(mean)}、最差 ${round4(worst.value)}（${worst.golden}）`);
        for (const j of jaccards) {
            assert.ok(
                j.value >= JACCARD_MIN,
                `${j.golden} 的 Jaccard=${round4(j.value)} < ${JACCARD_MIN}\n` +
                `      SQL：${j.sql.join(', ')}\n      記憶體：${j.memory.join(', ')}\n` +
                '      eval 量到的必須是 prod 的查詢路徑；先懷疑 eval/lib/ranker.js 的 rankKeyword 近似。'
            );
        }
    });

    test('查詢結果不含來源題本身（--exclude-self 在 SQL 端生效）', () => {
        golden.entries.forEach((entry, i) => {
            assert.ok(!results.hybrid[i].ranked.includes(entry.query.value), `${entry.id} 的結果含來源題`);
            assert.ok(!results.vector[i].ranked.includes(entry.query.value), `${entry.id} 的結果含來源題`);
        });
    });

    test('回傳筆數不超過 limit', () => {
        for (const row of results.hybrid) assert.ok(row.ranked.length <= LIMIT);
    });
});
