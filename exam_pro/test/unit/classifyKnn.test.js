// agents/classify.js 的 A 層與 kNN 投票短路（WS-B / P-14；interfaces-stage3.md 第 5 條）
//
// 既有的 test/unit/agentClassify.test.js（階段 2，同樣是 WS-B 的檔）繼續釘住第一層閘門與
// 第二層的行為，本檔只加階段 3 的部分。ctx 全部注入：不連 Gemini、不連 PG。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const classify = require('../../agents/classify');

const QUESTION = '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的夾角。';

/** 五題人工確認的同章鄰居（投票會成立） */
function humanNeighbors(chapter = '向量內積', cosines = [0.95, 0.94, 0.93, 0.92, 0.91]) {
    return cosines.map((cosine, i) => ({
        id: 10 + i, chapter, chapter_src: 'human', question_text: `鄰居 ${i}`, cosine
    }));
}

function fakeCtx({ data, rows = [], features = { similar: true }, thresholds = {}, job = {} } = {}) {
    const calls = { generateJson: [], embed: [], queries: [] };
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.generateJson.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 1, tokenCached: 0 }, latencyMs: 1, raw: null };
                },
                embed: async () => ({ vectors: [new Array(768).fill(0.01)], usage: { tokenIn: 1 } })
            },
            db: {
                query: async (sql, values) => {
                    calls.queries.push({ sql, values });
                    return { rows: sql.includes('<=>') ? rows : [] };
                }
            },
            job: { id: 1, kind: 'pdf', pdf_sha256: null, budget_usd: 1, cost_usd: 0, ...job },
            jq: { id: 1, idx: 1001, payload: {}, retries: {} },
            logger: { info() { }, warn() { }, error() { } },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash' },
                thresholds: { classifyMinConf: 0.8, knnVoteSim: 0.90, ...thresholds },
                features
            },
            signal: undefined
        }
    };
}

const INPUT = { subject: '數學', chapter: '', chapter_confidence: 0, question_text: QUESTION };

// ───────────────────────── 純函式 ─────────────────────────

describe('knnVote 的三個條件（第 5.2 條、裁決 S3-15）', () => {
    test('五題人工同章 + 餘弦夠高 + 章節合法 → 短路', () => {
        const v = classify.knnVote(humanNeighbors(), '數學', 0.90);
        assert.equal(v.ok, true);
        assert.equal(v.chapter, '向量內積');
        assert.equal(v.humanVotes, 5);
        assert.equal(v.cosine, 0.95);
    });

    test('五題裡剛好 4 題人工同章 → 仍然短路（門檻是 ≥ 4）', () => {
        const rows = humanNeighbors();
        rows[4] = { ...rows[4], chapter_src: 'ai' };
        assert.equal(classify.knnVote(rows, '數學', 0.90).ok, true);
    });

    test('只有 3 題人工同章 → 不短路', () => {
        const rows = humanNeighbors();
        rows[3] = { ...rows[3], chapter_src: 'ai' };
        rows[4] = { ...rows[4], chapter_src: 'knn' };
        assert.deepEqual(classify.knnVote(rows, '數學', 0.90), { ok: false });
    });

    test('「knn」與「ai」沒有投票權——全部是自動標籤時一律不短路', () => {
        for (const src of ['ai', 'knn']) {
            const rows = humanNeighbors().map(r => ({ ...r, chapter_src: src }));
            assert.equal(classify.knnVote(rows, '數學', 0.90).ok, false, src);
        }
    });

    test('人工鄰居章節與最近鄰不同 → 不算票（投的是 rows[0].chapter）', () => {
        const rows = humanNeighbors();
        for (let i = 1; i < 5; i++) rows[i] = { ...rows[i], chapter: '空間向量內積' };
        assert.equal(classify.knnVote(rows, '數學', 0.90).ok, false);
    });

    test('最近鄰餘弦低於 KNN_VOTE_SIM → 不短路', () => {
        const rows = humanNeighbors('向量內積', [0.89, 0.88, 0.87, 0.86, 0.85]);
        assert.equal(classify.knnVote(rows, '數學', 0.90).ok, false);
        assert.equal(classify.knnVote(rows, '數學', 0.85).ok, true, '門檻放寬就成立——門檻由呼叫端傳入');
    });

    test('章節不在該科白名單（跨科）→ 不短路', () => {
        const rows = humanNeighbors('牛頓運動定律');
        assert.equal(classify.knnVote(rows, '數學', 0.90).ok, false);
        assert.equal(classify.knnVote(rows, '物理', 0.90).ok, true);
    });

    test('只看最近的 5 個：第 6~8 個鄰居不影響投票', () => {
        const rows = [...humanNeighbors(), ...humanNeighbors('空間向量內積', [0.5, 0.4, 0.3])];
        assert.equal(classify.knnVote(rows, '數學', 0.90).chapter, '向量內積');
    });

    test('鄰居不足 5 個時照樣數（4 人工票就成立），空陣列不短路', () => {
        const four = humanNeighbors('向量內積', [0.95, 0.94, 0.93, 0.92]);
        assert.equal(classify.knnVote(four, '數學', 0.90).ok, true);
        assert.equal(classify.knnVote([], '數學', 0.90).ok, false);
        assert.equal(classify.knnVote(undefined, '數學', 0.90).ok, false);
    });

    test('三個常數就是第 5.2 條寫的數字', () => {
        assert.equal(classify.FEW_SHOT_K, 8);
        assert.equal(classify.KNN_VOTE_N, 5);
        assert.equal(classify.KNN_VOTE_MIN_HUMAN, 4);
        assert.equal(classify.DEFAULT_KNN_VOTE_SIM, 0.90);
    });
});

describe('orderExamples（第 5.1 條：human 先，再 ai／knn，都依距離）', () => {
    test('只重排不篩掉，human 之間與 ai/knn 之間都保持原本的距離順序', () => {
        const rows = [
            { id: 1, chapter_src: 'ai' }, { id: 2, chapter_src: 'human' },
            { id: 3, chapter_src: 'knn' }, { id: 4, chapter_src: 'human' }
        ];
        assert.deepEqual(classify.orderExamples(rows).map(r => r.id), [2, 4, 1, 3]);
        assert.equal(classify.orderExamples(rows).length, rows.length, '一題都不能少');
    });

    test('沒有 chapter_src 的列（B／C 層）一律當成非 human', () => {
        const rows = [{ id: 1 }, { id: 2, chapter_src: 'human' }];
        assert.deepEqual(classify.orderExamples(rows).map(r => r.id), [2, 1]);
    });
});

// ───────────────────────── 節點主體 ─────────────────────────

describe('A 層的最近鄰查詢（第 5.1 條逐句凍結）', () => {
    test('k = 8、chapter_src 三種都可以當範例、排除同一份 PDF', async () => {
        const f = fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows: [{ id: 87, chapter: '向量內積', chapter_src: 'ai', question_text: '鄰居', cosine: 0.5 }],
            job: { pdf_sha256: 'abc123' }
        });
        await classify.run(f.ctx, INPUT);
        const sql = f.calls.queries[0].sql;

        assert.ok(sql.includes('LIMIT 8'), 'FEW_SHOT_K 由 5 改成 8');
        assert.ok(sql.includes(`chapter_src IN ('human','ai','knn')`), 'knn 可以當範例，只是沒有投票權');
        assert.ok(sql.includes('LEFT JOIN job_questions'), '用 LEFT JOIN 才不會把 seed／manual／variant 整批排掉');
        assert.ok(sql.includes('LEFT JOIN jobs'));
        assert.ok(sql.includes('IS DISTINCT FROM $3'), '用 IS DISTINCT FROM 而不是 <>：NULL <> x 是假');
        assert.ok(sql.includes('archived_at IS NULL'));
        assert.equal(f.calls.queries[0].values[2], 'abc123', 'ctx.job.pdf_sha256 要當第三個參數');
    });

    test('變式 job（pdf_sha256 為 NULL）→ 所有題都留著', async () => {
        const f = fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows: [{ id: 87, chapter: '向量內積', chapter_src: 'ai', question_text: '鄰居', cosine: 0.5 }],
            job: { kind: 'variant', pdf_sha256: null }
        });
        await classify.run(f.ctx, INPUT);
        assert.equal(f.calls.queries[0].values[2], null);
    });

    test('ctx.job 不存在時也不炸（eval 的 ctx 沒有 pdf_sha256）', async () => {
        const f = fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows: [{ id: 87, chapter: '向量內積', chapter_src: 'ai', question_text: '鄰居', cosine: 0.5 }]
        });
        delete f.ctx.job;
        const outcome = await classify.run(f.ctx, INPUT);
        assert.equal(outcome.kind, 'pass');
    });
});

describe('kNN 短路接進節點', () => {
    test('短路成立 → 不呼叫 LLM，source=knn，confidence 是最近鄰餘弦', async () => {
        const f = fakeCtx({
            data: { chapter: '不該用到', confidence: 1, rationale: 'x' },
            rows: humanNeighbors()
        });
        const outcome = await classify.run(f.ctx, INPUT);

        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'knn');
        assert.equal(outcome.data.chapter, '向量內積');
        assert.equal(outcome.data.confidence, 0.95);
        assert.equal(f.calls.generateJson.length, 0, '短路就是不花錢');
        assert.ok(outcome.data.rationale.includes('kNN 投票'));
        assert.ok(outcome.data.rationale.includes('5 題人工確認'));
    });

    test('短路時 few_shot_ids 仍是 8 個 id 由小到大（cassette 鍵的算法不變）', async () => {
        const rows = humanNeighbors().map((r, i) => ({ ...r, id: 90 - i }));
        const f = fakeCtx({ data: {}, rows });
        const outcome = await classify.run(f.ctx, INPUT);
        assert.deepEqual(outcome.data.few_shot_ids, [86, 87, 88, 89, 90]);
    });

    test('短路不成立 → 照舊走 LLM，source=llm', async () => {
        const rows = humanNeighbors().map(r => ({ ...r, chapter_src: 'ai' }));
        const f = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, rows });
        const outcome = await classify.run(f.ctx, INPUT);
        assert.equal(outcome.data.source, 'llm');
        assert.equal(f.calls.generateJson.length, 1);
    });

    test('第一層零成本閘門仍然優先（短路不會搶在它前面）', async () => {
        const f = fakeCtx({ data: {}, rows: humanNeighbors() });
        const outcome = await classify.run(f.ctx, {
            subject: '數學', chapter: '空間向量內積', chapter_confidence: 0.95, question_text: QUESTION
        });
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '空間向量內積');
        assert.equal(f.calls.queries.length, 0, '閘門過了就不該去查最近鄰');
    });

    test('KNN_VOTE_SIM 由 ctx.config.thresholds 決定（agent 不讀 process.env）', async () => {
        const rows = humanNeighbors('向量內積', [0.88, 0.87, 0.86, 0.85, 0.84]);
        const strict = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, rows });
        assert.equal((await classify.run(strict.ctx, INPUT)).data.source, 'llm');

        const loose = fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows, thresholds: { knnVoteSim: 0.80 }
        });
        assert.equal((await classify.run(loose.ctx, INPUT)).data.source, 'knn');
    });

    test('features.similar 關閉時 A 層不跑，也就不可能短路', async () => {
        const f = fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows: humanNeighbors(), features: {}
        });
        const outcome = await classify.run(f.ctx, INPUT);
        assert.equal(outcome.data.source, 'llm');
    });

    test('ctx.db 為 null（錄 cassette 與 --suite classify）→ A 層跳過，短路不可能發生', async () => {
        const f = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, rows: humanNeighbors() });
        f.ctx.db = null;
        const outcome = await classify.run(f.ctx, INPUT);
        assert.equal(outcome.data.source, 'llm');
        assert.deepEqual(outcome.data.few_shot_ids, [], 'ctx.db=null 時 fewShotIds 是空陣列（鍵才可重現）');
    });

    test('source 的三個合法值就是 gate／llm／knn', async () => {
        const seen = new Set();
        seen.add((await classify.run(fakeCtx({ data: {}, rows: humanNeighbors() }).ctx,
            { ...INPUT, chapter: '向量內積', chapter_confidence: 0.9 })).data.source);
        seen.add((await classify.run(fakeCtx({ data: {}, rows: humanNeighbors() }).ctx, INPUT)).data.source);
        seen.add((await classify.run(fakeCtx({
            data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' },
            rows: humanNeighbors().map(r => ({ ...r, chapter_src: 'ai' }))
        }).ctx, INPUT)).data.source);
        assert.deepEqual([...seen].sort(), ['gate', 'knn', 'llm']);
    });
});
