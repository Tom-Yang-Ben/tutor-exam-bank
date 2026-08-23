// 變式 job 接進階段 2 管線的「只加分支」單元測試（WS-B / P-12）
//
// 這一支釘的是三件事：
//   1. 新增的分支**做對了**（generate 節點找得到、三個門檻進得了 ctx、入庫欄位對）；
//   2. 既有路徑**逐位元不變**（PDF job 的 dedup1 SQL、chapter_src、AGENT_MODULE_FOR_NODE、
//      loadConfig 的回傳形狀）——介面第 10.1 條要求「改動要附一支釘住舊行為的測試」；
//   3. 政策停等的那條路徑之後 state 仍是合法終態（第 4.7 條要求 WS-B 自己釘）。
//
// 不連 DB、不連 Gemini。執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const runner = require('../../workers/jobRunner');
const dedup = require('../../agents/dedup');
const { TERMINAL_STATES } = require('../../pipeline/stateMachine');

describe('loadStage3Config（第 9 條的五個新變數）', () => {
    test('全空的環境用預設值（裁決 S3-R9：兩個門檻分家，預設不同）', () => {
        assert.deepEqual(runner.loadStage3Config({}), {
            variantRetrieveSimMin: 0.80, variantOfftopicSimMin: 0.92,
            variantMinEdit: 0.08, knnVoteSim: 0.90,
            variantLintRetries: 2, variantAutoApprove: false
        });
    });

    test('讀得到就用環境值', () => {
        const c = runner.loadStage3Config({
            VARIANT_RETRIEVE_SIM_MIN: '0.78', VARIANT_OFFTOPIC_SIM_MIN: '0.94',
            VARIANT_MIN_EDIT: '0.12', KNN_VOTE_SIM: '0.93',
            VARIANT_LINT_RETRIES: '4', VARIANT_AUTO_APPROVE: 'true'
        });
        assert.deepEqual(c, {
            variantRetrieveSimMin: 0.78, variantOfftopicSimMin: 0.94,
            variantMinEdit: 0.12, knnVoteSim: 0.93,
            variantLintRetries: 4, variantAutoApprove: true
        });
    });

    test('舊名 VARIANT_SIM_MIN 是退路：兩個新變數都沒設時，兩處都吃它', () => {
        const c = runner.loadStage3Config({ VARIANT_SIM_MIN: '0.85' });
        assert.equal(c.variantRetrieveSimMin, 0.85);
        assert.equal(c.variantOfftopicSimMin, 0.85, '還沒更新 .env 的環境行為要與 S3-R9 之前相同');
    });

    test('新變數蓋過舊名（只蓋自己那一個）', () => {
        const c = runner.loadStage3Config({ VARIANT_SIM_MIN: '0.85', VARIANT_OFFTOPIC_SIM_MIN: '0.92' });
        assert.equal(c.variantRetrieveSimMin, 0.85, 'RETRIEVE 沒設，仍吃舊名');
        assert.equal(c.variantOfftopicSimMin, 0.92);
    });

    test('VARIANT_AUTO_APPROVE 走凍結的布林規則：只有 1／true 為真', () => {
        for (const raw of ['1', 'true', 'TRUE', 'True']) {
            assert.equal(runner.loadStage3Config({ VARIANT_AUTO_APPROVE: raw }).variantAutoApprove, true, raw);
        }
        for (const raw of ['false', '0', 'off', 'no', 'yes']) {
            assert.equal(runner.loadStage3Config({ VARIANT_AUTO_APPROVE: raw }).variantAutoApprove, false, raw);
        }
        // 沒設定 → 預設 false（首輪一律等人核准）
        assert.equal(runner.loadStage3Config({}).variantAutoApprove, false);
    });

    test('亂填的數字退回預設，不會變成 NaN', () => {
        const c = runner.loadStage3Config({ VARIANT_RETRIEVE_SIM_MIN: 'abc', VARIANT_SIM_MIN: 'x', KNN_VOTE_SIM: '' });
        assert.equal(c.variantRetrieveSimMin, 0.80);
        assert.equal(c.variantOfftopicSimMin, 0.92);
        assert.equal(c.knnVoteSim, 0.90);
    });

    test('既有的 loadConfig 形狀一個鍵都沒變（階段 2 的契約）', () => {
        assert.deepEqual(Object.keys(runner.loadConfig({})).sort(), [
            'classifyMinConf', 'concurrency', 'costBudgetUsd', 'dailyCostBudgetUsd', 'dedupDup',
            'dedupVariant', 'inlineMaxBytes', 'leaseMs', 'nodeTimeoutMs', 'pdfChunkPages', 'pollMs'
        ]);
    });
});

describe('generate 節點的載入（第 4.1 條）', () => {
    test('agents/generate.js 是轉接檔，run 就是 generateVariant 的 run', () => {
        const shim = require('../../agents/generate');
        const real = require('../../agents/generateVariant');
        assert.equal(shim.run, real.run);
    });

    test('AGENT_MODULE_FOR_NODE 維持階段 2 的六個鍵（generate 走第一順位的檔名解析）', () => {
        assert.deepEqual(runner.AGENT_MODULE_FOR_NODE, {
            extract: 'extract', dedup0: 'dedup', classify: 'classify',
            lint: 'lint', verify: 'verify', dedup1: 'dedup'
        });
    });

    test('agents/ 下真的有 generate.js（loadAgent 的第一順位靠它）', () => {
        const file = path.resolve(__dirname, '..', '..', 'agents', 'generate.js');
        assert.ok(require('node:fs').existsSync(file));
    });
});

describe('chapterSrcFor（第 4.7、5.2 條的對照表）', () => {
    test('gate／llm → ai，knn → knn', () => {
        assert.equal(runner.chapterSrcFor({ classify: { source: 'gate' } }), 'ai');
        assert.equal(runner.chapterSrcFor({ classify: { source: 'llm' } }), 'ai');
        assert.equal(runner.chapterSrcFor({ classify: { source: 'knn' } }), 'knn');
    });

    test('沒跑過 classify → 保守回 ai（絕不會自己產生 human）', () => {
        assert.equal(runner.chapterSrcFor({}), 'ai');
        assert.equal(runner.chapterSrcFor(null), 'ai');
        assert.equal(runner.chapterSrcFor({ classify: {} }), 'ai');
        assert.notEqual(runner.chapterSrcFor({ classify: { source: 'human' } }), 'human',
            'human 只能由人動手改章節產生，saveNode 不得寫出這個值');
    });
});

describe('reviewController.variantChapterSrc（裁決 S3-12）', () => {
    // 只 require 純函式：這一支的其他部分要 config/db.js，而 npm test 不連 DB。
    // controllers/reviewController.js 在模組頂層 require('../config/db')，
    // 所以先塞一個假的 DATABASE_URL 讓 pg 只建物件、不連線。
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
    const { variantChapterSrc } = require('../../controllers/reviewController');
    if (original === undefined) delete process.env.DATABASE_URL;

    test('章節沒被改過 → 依 source 映射，與 saveNode 同一張表（裁決 S3-R10）', () => {
        assert.equal(variantChapterSrc({ classify: { chapter: '向量內積', source: 'gate' } }, '向量內積'), 'ai');
        assert.equal(variantChapterSrc({ classify: { chapter: '向量內積', source: 'llm' } }, '向量內積'), 'ai');
        assert.equal(variantChapterSrc({ classify: { chapter: '向量內積', source: 'knn' } }, '向量內積'), 'knn');
    });

    test('章節被改過 → human，不管 source 是什麼（真的有人逐題看過並改了）', () => {
        for (const source of ['gate', 'llm', 'knn']) {
            assert.equal(variantChapterSrc({ classify: { chapter: '向量內積', source } }, '空間向量內積'), 'human', source);
        }
    });

    test('沒有 source 時保守回 ai（絕不會自己產生 human）', () => {
        assert.equal(variantChapterSrc({ classify: { chapter: '向量內積' } }, '向量內積'), 'ai');
    });

    test('classify 沒跑過就退回 extract 的章節比對', () => {
        assert.equal(variantChapterSrc({ extract: { chapter: '直線運動' } }, '直線運動'), 'ai');
        assert.equal(variantChapterSrc({ extract: { chapter: '直線運動' } }, '平面運動'), 'human');
    });

    test('兩邊都沒有機器章節 → human（無從比對時給人比較保守的那一邊）', () => {
        assert.equal(variantChapterSrc({}, '向量內積'), 'human');
    });
});

describe('dedup1 的 exclude_family_root（裁決 S3-14）', () => {
    function ctxWith(rows) {
        const seen = [];
        return {
            seen,
            ctx: {
                db: { query: async (text, values) => { seen.push({ text, values }); return { rows }; } },
                llm: { embed: async () => ({ vectors: [[1, 0, 0]], usage: { tokenIn: 1 } }) },
                config: { thresholds: { dedupDup: 0.97, dedupVariant: 0.90 }, features: { similar: true } },
                logger: { info() { }, warn() { }, error() { } }
            }
        };
    }

    const BASE_INPUT = { question_id: null, embed_text: '一段題幹', subject: '數學', chapter: '向量內積' };

    test('沒給這個鍵 → SQL 與參數陣列與階段 2 逐位元相同（PDF job 不受影響）', async () => {
        const { ctx, seen } = ctxWith([{ id: 87, cosine: 0.5 }]);
        await dedup.runDedup1(ctx, BASE_INPUT);
        const q = seen[0];
        assert.equal(q.values.length, 3, '階段 2 是三個參數');
        assert.ok(!q.text.includes('COALESCE'), '沒給鍵時不該出現家族條件');
    });

    test('給了 null 也視同沒給（形狀不變）', async () => {
        const { ctx, seen } = ctxWith([{ id: 87, cosine: 0.5 }]);
        await dedup.runDedup1(ctx, { ...BASE_INPUT, exclude_family_root: null });
        assert.equal(seen[0].values.length, 3);
        assert.ok(!seen[0].text.includes('COALESCE'));
    });

    test('給了根節點 → 多一條 COALESCE(variant_of, id) <> $4', async () => {
        const { ctx, seen } = ctxWith([{ id: 87, cosine: 0.5 }]);
        await dedup.runDedup1(ctx, { ...BASE_INPUT, exclude_family_root: 12 });
        assert.equal(seen[0].values.length, 4);
        assert.equal(seen[0].values[3], 12);
        assert.ok(seen[0].text.includes('COALESCE(variant_of, id) <> $4'));
    });

    test('排除家族之後仍照原本的門檻判定（行為只少候選，不改規則）', async () => {
        const { ctx } = ctxWith([{ id: 90, cosine: 0.985 }]);
        const outcome = await dedup.runDedup1(ctx, { ...BASE_INPUT, exclude_family_root: 12 });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'duplicate');
    });
});

describe('政策停等（第 4.7 條）', () => {
    test('needs_review 是合法終態——停等之後這一列不會再被認領', () => {
        assert.ok(TERMINAL_STATES.includes('needs_review'));
        assert.ok(!runner.ADVANCEABLE_STATES.includes('needs_review'));
    });

    test('awaiting_approval 在 review_reason 的八個合法值內（DDL CHECK 不必動）', () => {
        const original = process.env.DATABASE_URL;
        process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
        const { REVIEW_REASONS } = require('../../controllers/reviewController');
        if (original === undefined) delete process.env.DATABASE_URL;
        assert.ok(REVIEW_REASONS.includes('awaiting_approval'));
        assert.equal(REVIEW_REASONS.length, 8, '第 4.7 條：review_reason 的合法值不新增');
    });

    test('停等寫的 error_class 是 NULL（不在九個合法值內的字串會撞 CHECK）', () => {
        // 這條路徑寫的是 outcome='skipped'、error_class=NULL；normalizeErrorClass 是最後一道保險
        assert.equal(runner.normalizeErrorClass('awaiting_approval'), null);
        assert.equal(runner.normalizeErrorClass('text_gate'), null);
        assert.equal(runner.normalizeErrorClass('off_topic'), null);
        assert.equal(runner.normalizeErrorClass('duplicate'), 'duplicate');
    });
});
