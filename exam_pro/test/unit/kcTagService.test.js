// ─────────────────────────────────────────────────────────────
// kcTagService.test.js — services/kcTagService.js（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 3 點）
//
// DB 用腳本化的假物件（依 SQL 片段回預先準備好的列），LLM 用注入的假依賴；不連 PG、不打網路。
// 真的 SQL 在 test/integration/kcTagging.pg.test.js 對 PostgreSQL 跑一次。
//
// 釘住的規則：
//   - 已有 human 標註 → 不動（連 LLM 都不叫）
//   - 該章沒有知識點 → 略過（不叫 LLM）
//   - 信心 ≥ 門檻才寫入 src='ai'；一個都沒達標 → 不開交易、不改既有標註
//   - agent 失敗 → failed，不寫任何東西
//   - LLM 回來前老師剛好手動標了 → 交易內再查一次，人工優先
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../services/kcTagService');

const QUESTION = { id: 5, subject: '數學', chapter: '向量內積', question_text: '設 $\\vec a=(3,4)$，求 $|\\vec a|$。', answer_text: '$5$' };
const KCS = [
    { id: 11, code: 'MATH.向量內積.01', name: '內積的意義', description: '定義' },
    { id: 12, code: 'MATH.向量內積.05', name: '長度平方與展開', description: '自身內積為長度平方' }
];

/**
 * 腳本化的假 DB。
 * @param {{question?:object|null, human?:boolean, humanInTx?:boolean, kcs?:object[]}} opts
 */
function fakeDb({ question = QUESTION, human = false, humanInTx = false, kcs = KCS } = {}) {
    const log = [];
    const tx = [];
    const answer = (sql) => {
        if (/FROM questions WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: question ? [{ id: question.id }] : [] };
        if (/FROM questions WHERE id = \$1/.test(sql)) return { rows: question ? [question] : [] };
        if (/FROM question_kcs WHERE question_id = \$1 AND src = 'human'/.test(sql)) return { rows: human ? [{ '?column?': 1 }] : [] };
        if (/FROM knowledge_components/.test(sql)) return { rows: kcs };
        return { rows: [], rowCount: 0 };
    };
    return {
        log, tx,
        query: async (sql, params) => { log.push({ sql, params }); return answer(sql); },
        pool: {
            connect: async () => ({
                query: async (sql, params) => {
                    tx.push({ sql, params });
                    if (/FROM question_kcs WHERE question_id = \$1 AND src = 'human'/.test(sql)) {
                        return { rows: humanInTx ? [{ '?column?': 1 }] : [] };
                    }
                    return answer(sql);
                },
                release() { tx.push({ sql: 'RELEASE' }); }
            })
        }
    };
}

/** 假 agent：直接回指定的 outcome，記下收到的 ctx 與 input */
function fakeAgent(outcome) {
    const calls = [];
    return { calls, async run(ctx, input) { calls.push({ ctx, input }); return typeof outcome === 'function' ? outcome(ctx, input) : outcome; } };
}

const PASS = {
    kind: 'pass',
    data: { kc_codes: [{ code: 'MATH.向量內積.05', confidence: 0.91 }, { code: 'MATH.向量內積.01', confidence: 0.3 }], rationale: '自身內積' }
};

describe('loadTagConfig', () => {
    test('KC_TAG_MIN_CONFIDENCE 預設 0.6；合法值照用；非法值退回預設', () => {
        assert.equal(svc.loadTagConfig({}).minConfidence, 0.6);
        assert.equal(svc.DEFAULT_MIN_CONFIDENCE, 0.6);
        assert.equal(svc.loadTagConfig({ KC_TAG_MIN_CONFIDENCE: '0.75' }).minConfidence, 0.75);
        assert.equal(svc.loadTagConfig({ KC_TAG_MIN_CONFIDENCE: '0' }).minConfidence, 0);
        assert.equal(svc.loadTagConfig({ KC_TAG_MIN_CONFIDENCE: '1' }).minConfidence, 1);
        for (const bad of ['1.5', '-0.1', 'abc', '']) {
            assert.equal(svc.loadTagConfig({ KC_TAG_MIN_CONFIDENCE: bad }).minConfidence, 0.6, bad);
        }
    });

    test('MODEL_KC_TAG 有設就用；沒設沿用 MODEL_EXTRACT（第 5.2 條）', () => {
        assert.equal(svc.loadTagConfig({ MODEL_KC_TAG: ' gemini:gemini-2.5-flash ' }).model, 'gemini:gemini-2.5-flash');
        const models = require('../../config/models');
        assert.equal(svc.loadTagConfig({}).model, models.MODEL_KC_TAG || models.MODEL_EXTRACT);
    });
});

describe('decideWrites', () => {
    const byCode = new Map(KCS.map(k => [k.code, k]));

    test('信心 ≥ 門檻才寫（等於門檻也寫）', () => {
        const r = svc.decideWrites([
            { code: 'MATH.向量內積.05', confidence: 0.6 },
            { code: 'MATH.向量內積.01', confidence: 0.59 }
        ], byCode, 0.6);
        assert.deepEqual(r.write, [{ kc_id: 12, code: 'MATH.向量內積.05', confidence: 0.6 }]);
        assert.deepEqual(r.dropped, [{ code: 'MATH.向量內積.01', confidence: 0.59, reason: 'low_confidence' }]);
    });

    test('不在該章的 code 一律丟掉（縱深防禦）；重複只算一次', () => {
        const r = svc.decideWrites([
            { code: 'PHYS.功與動能.01', confidence: 0.99 },
            { code: 'MATH.向量內積.01', confidence: 0.9 },
            { code: 'MATH.向量內積.01', confidence: 0.95 }
        ], byCode, 0.6);
        assert.deepEqual(r.write.map(w => w.code), ['MATH.向量內積.01']);
        assert.equal(r.dropped[0].reason, 'unknown_code');
    });

    test('信心不是數字 → 當成未達標', () => {
        const r = svc.decideWrites([{ code: 'MATH.向量內積.01', confidence: 'high' }], byCode, 0.6);
        assert.equal(r.write.length, 0);
    });
});

describe('estimateTagCost（kc:backfill 執行前的預估）', () => {
    test('查得到單價：總額 = 每題 × 題數', () => {
        const e = svc.estimateTagCost(10, 'gemini:gemini-3.5-flash');
        assert.equal(e.estimated, true);
        assert.equal(e.modelId, 'gemini-3.5-flash');
        assert.ok(e.perQuestionUsd > 0);
        assert.equal(e.totalUsd, Number((e.perQuestionUsd * 10).toFixed(6)));
        assert.deepEqual(e.tokens, svc.EST_TOKENS_PER_QUESTION);
    });

    test('預估把思考 token 的上限算進去（thinking 以 output 單價計，寧可高估）', () => {
        const { THINKING_BUDGET } = require('../../agents/tagKc');
        assert.equal(svc.EST_TOKENS_PER_QUESTION.tokenThinking, THINKING_BUDGET);
        const withThinking = svc.estimateTagCost(1, 'gemini:gemini-3.5-flash');
        const without = svc.estimateTagCost(1, 'gemini:gemini-3.5-flash', { ...svc.EST_TOKENS_PER_QUESTION, tokenThinking: 0 });
        assert.ok(withThinking.perQuestionUsd > without.perQuestionUsd,
            `${withThinking.perQuestionUsd} vs ${without.perQuestionUsd}`);
    });

    test('查不到單價 → estimated=false、金額 0（不猜）', () => {
        const e = svc.estimateTagCost(10, 'gemini:沒有這個模型');
        assert.equal(e.estimated, false);
        assert.equal(e.totalUsd, 0);
    });
});

describe('tagQuestion', () => {
    const CFG = { config: { minConfidence: 0.6, model: 'gemini:gemini-3.5-flash' } };

    test('題目不存在 → not_found', async () => {
        const db = fakeDb({ question: null });
        const agent = fakeAgent(PASS);
        const r = await svc.tagQuestion(99, { db, agent, llm: {}, ...CFG });
        assert.equal(r.status, 'not_found');
        assert.equal(agent.calls.length, 0);
    });

    test('已有 human 標註 → skipped(has_human)，不呼叫 LLM、不開交易', async () => {
        const db = fakeDb({ human: true });
        const agent = fakeAgent(PASS);
        const r = await svc.tagQuestion(5, { db, agent, llm: {}, ...CFG });
        assert.equal(r.status, 'skipped');
        assert.equal(r.reason, 'has_human');
        assert.equal(agent.calls.length, 0);
        assert.equal(db.tx.length, 0);
    });

    test('該章沒有知識點 → skipped(no_kcs)，不呼叫 LLM', async () => {
        const db = fakeDb({ kcs: [] });
        const agent = fakeAgent(PASS);
        const r = await svc.tagQuestion(5, { db, agent, llm: {}, ...CFG });
        assert.deepEqual([r.status, r.reason], ['skipped', 'no_kcs']);
        assert.equal(agent.calls.length, 0);
    });

    test('agent 收到的是「該章」的清單與題目，模型由 service 解析後放進 ctx.config.models.kcTag', async () => {
        const db = fakeDb();
        const agent = fakeAgent(PASS);
        await svc.tagQuestion(5, { db, agent, llm: {}, ...CFG });
        const { ctx, input } = agent.calls[0];
        assert.equal(ctx.config.models.kcTag, 'gemini:gemini-3.5-flash');
        assert.deepEqual(input.kcs, KCS.map(k => ({ code: k.code, name: k.name, description: k.description })));
        assert.equal(input.question_text, QUESTION.question_text);
        assert.equal(input.answer_text, '$5$');
        assert.deepEqual([input.subject, input.chapter], ['數學', '向量內積']);
        // 查知識點的 SQL 以題目的科目與章節為條件
        const kcQuery = db.log.find(l => /FROM knowledge_components/.test(l.sql));
        assert.deepEqual(kcQuery.params, ['數學', '向量內積']);
    });

    test('達標的寫入 src=ai：同一個交易裡先鎖題目、再查 human、刪舊 ai、寫新 ai', async () => {
        const db = fakeDb();
        const r = await svc.tagQuestion(5, { db, agent: fakeAgent(PASS), llm: {}, ...CFG });
        assert.equal(r.status, 'tagged');
        assert.deepEqual(r.written, [{ kc_id: 12, code: 'MATH.向量內積.05', confidence: 0.91 }]);
        assert.deepEqual(r.dropped.map(d => d.code), ['MATH.向量內積.01']);
        assert.equal(r.rationale, '自身內積');

        const sqls = db.tx.map(t => t.sql.replace(/\s+/g, ' ').trim());
        assert.equal(sqls[0], 'BEGIN');
        assert.ok(/FOR UPDATE/.test(sqls[1]));
        assert.ok(/src = 'human'/.test(sqls[2]));
        assert.ok(/^DELETE FROM question_kcs WHERE question_id = \$1 AND src = 'ai'$/.test(sqls[3]), sqls[3]);
        assert.ok(/^INSERT INTO question_kcs/.test(sqls[4]) && /'ai'/.test(sqls[4]));
        assert.deepEqual(db.tx[4].params, [5, [12], [0.91]]);
        assert.equal(sqls[5], 'COMMIT');
        assert.equal(sqls[6], 'RELEASE');
    });

    test('一個都沒達標 → low_confidence，不開交易（既有標註維持原樣）', async () => {
        const db = fakeDb();
        const low = { kind: 'pass', data: { kc_codes: [{ code: 'MATH.向量內積.01', confidence: 0.2 }], rationale: 'x' } };
        const r = await svc.tagQuestion(5, { db, agent: fakeAgent(low), llm: {}, ...CFG });
        assert.equal(r.status, 'low_confidence');
        assert.equal(db.tx.length, 0);
    });

    test('門檻可以調：KC_TAG_MIN_CONFIDENCE=0.2 時 0.3 也會寫', async () => {
        const db = fakeDb();
        const r = await svc.tagQuestion(5, { db, agent: fakeAgent(PASS), llm: {}, config: { minConfidence: 0.2, model: 'x' } });
        assert.deepEqual(r.written.map(w => w.code), ['MATH.向量內積.05', 'MATH.向量內積.01']);
    });

    test('agent fail／error → failed，不寫任何東西', async () => {
        for (const outcome of [
            { kind: 'fail', reason: 'schema_invalid', feedback: '「X」不在本章的知識點清單內' },
            { kind: 'error', errorClass: 'rate_limited', message: '429' }
        ]) {
            const db = fakeDb();
            const r = await svc.tagQuestion(5, { db, agent: fakeAgent(outcome), llm: {}, ...CFG });
            assert.equal(r.status, 'failed');
            assert.equal(r.reason, outcome.reason || outcome.errorClass);
            assert.ok(r.message);
            assert.equal(db.tx.length, 0);
        }
    });

    test('LLM 回來前老師剛好手動標了 → 交易內再查一次，ROLLBACK，人工優先', async () => {
        const db = fakeDb({ humanInTx: true });
        const r = await svc.tagQuestion(5, { db, agent: fakeAgent(PASS), llm: {}, ...CFG });
        assert.deepEqual([r.status, r.reason], ['skipped', 'has_human']);
        const sqls = db.tx.map(t => t.sql.trim());
        assert.ok(sqls.includes('ROLLBACK'));
        assert.ok(!sqls.some(s => s.startsWith('DELETE') || s.startsWith('INSERT')));
    });

    test('真的 agent + 假 llm：用量與費用會被記下來', async () => {
        const db = fakeDb();
        const llm = {
            async generateJson(opts) {
                assert.equal(opts.agent, 'kc_tag');
                return {
                    data: { kc_codes: [{ code: 'MATH.向量內積.05', confidence: 0.88 }], rationale: '求長度' },
                    usage: { tokenIn: 1200, tokenOut: 80, tokenThinking: 0, tokenCached: 0 }
                };
            }
        };
        const r = await svc.tagQuestion(5, { db, llm, ...CFG });
        assert.equal(r.status, 'tagged');
        assert.equal(r.usage.calls, 1);
        assert.equal(r.usage.tokenIn, 1200);
        assert.equal(r.usage.costEstimated, true);
        assert.ok(r.usage.costUsd > 0);
    });

    // 〔stage5 審查修正 S5-45〕
    test('真的 agent + 模型回了截斷的 JSON（err.usage）→ failed，但這次的用量照樣記進 usage', async () => {
        const db = fakeDb();
        const llm = {
            async generateJson() {
                throw Object.assign(new Error('Unexpected end of JSON input'), {
                    errorClass: 'schema_invalid', usage: { tokenIn: 1600, tokenOut: 250, tokenThinking: 512, tokenCached: 0 }
                });
            }
        };
        const r = await svc.tagQuestion(5, { db, llm, ...CFG });
        assert.equal(r.status, 'failed');
        assert.equal(r.usage.calls, 1);
        assert.equal(r.usage.tokenIn, 1600);
        assert.equal(r.usage.tokenThinking, 512);
        assert.ok(r.usage.costUsd > 0, 'kc:backfill 的實際費用要算進失敗的呼叫');
    });

    test('真的 agent + 會丟錯的 llm（例如 replay miss）→ failed，不丟例外給呼叫端', async () => {
        const db = fakeDb();
        const llm = { async generateJson() { throw new Error('LLM_MODE=replay 找不到 cassette（agent=kc_tag）'); } };
        const r = await svc.tagQuestion(5, { db, llm, ...CFG });
        assert.equal(r.status, 'failed');
        assert.ok(r.message.includes('cassette'));
        assert.equal(db.tx.length, 0);
    });
});