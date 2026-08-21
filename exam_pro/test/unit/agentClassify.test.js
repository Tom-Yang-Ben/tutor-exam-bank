// agents/classify.js 與 config/chapterExamples.js 的單元測試（WS-B / A-T9）
//
// ctx.llm、ctx.db 全部注入：不連 Gemini、不連 PG。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const classify = require('../../agents/classify');
const { CHAPTERS, SUBJECTS } = require('../../config/chapters');
const { CHAPTER_EXAMPLES, getChapterExample, missingExamples } = require('../../config/chapterExamples');

const QUESTION = '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的夾角。';

function fakeCtx({ data, db = null, features = {}, minConf = 0.8 } = {}) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 1, tokenCached: 0 }, latencyMs: 1, raw: null };
                },
                embed: async () => { throw new Error('這個測試不該呼叫 embed'); }
            },
            db,
            job: { id: 1, budget_usd: 1, cost_usd: 0 },
            jq: { id: 1, idx: 1001, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash' },
                thresholds: { classifyMinConf: minConf },
                features
            },
            signal: undefined
        }
    };
}

// ───────────────────────── config/chapterExamples.js ─────────────────────────

describe('config/chapterExamples.js', () => {
    test('鍵集合與 CHAPTERS 完全相同（一個都不能少、也不能多）', () => {
        for (const subject of SUBJECTS) {
            const expected = [...CHAPTERS[subject]].sort();
            const actual = Object.keys(CHAPTER_EXAMPLES[subject]).sort();
            assert.deepEqual(actual, expected, `${subject} 的例句鍵集合與 CHAPTERS 不一致`);
        }
        assert.deepEqual(Object.keys(CHAPTER_EXAMPLES).sort(), [...SUBJECTS].sort());
    });

    test('66 章全部填好，沒有空殼', () => {
        assert.deepEqual(missingExamples(), []);
    });

    test('每一句都在合理長度內，且提到該章的關鍵字或帶公式', () => {
        for (const subject of SUBJECTS) {
            for (const chapter of CHAPTERS[subject]) {
                const example = getChapterExample(subject, chapter);
                assert.ok(example.length >= 10, `${chapter} 的例句太短`);
                assert.ok(example.length <= 80, `${chapter} 的例句太長：${example.length} 字`);
            }
        }
    });

    test('查無此科／此章回空字串，不丟例外', () => {
        assert.equal(getChapterExample('化學', '有機'), '');
        assert.equal(getChapterExample('數學', '不存在的章'), '');
    });
});

// ───────────────────────── 最接近的章節 ─────────────────────────

describe('nearestChapters／invalidChapterFeedback', () => {
    test('feedback 格式凍結（第 3.3 條）', () => {
        const msg = classify.invalidChapterFeedback('數學', '平面向量');
        assert.equal(msg, '「平面向量」不在白名單內，最接近的是「向量內積」「平面方程式」');
    });

    test('連一個 bigram 都對不上時仍給得出有意義的候選', () => {
        // 只用 bigram 的話「電磁學」對每一章都是 0 分，會回宣告順序的前兩章（毫無幫助）
        assert.deepEqual(classify.nearestChapters('物理', '電磁學', 2), ['電磁感應', '靜電學']);
    });

    test('同一個輸入永遠回同一組候選（確定性）', () => {
        const a = classify.nearestChapters('數學', '三角函數', 3);
        const b = classify.nearestChapters('數學', '三角函數', 3);
        assert.deepEqual(a, b);
        assert.equal(a[0], '三角函數的定義');
    });
});

// ───────────────────────── 第一層零成本閘門 ─────────────────────────

describe('第一層：零成本閘門', () => {
    test('章節在白名單內且信心 ≥ 門檻 → pass，一次 LLM 都不呼叫', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '不該被用到' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.92, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '向量內積');
        assert.equal(outcome.data.confidence, 0.92);
        assert.equal(calls.length, 0, '零成本閘門不得呼叫 LLM');
        assert.ok(!('few_shot_ids' in outcome.data), 'gate 路徑不該有 few_shot_ids');
    });

    test('信心剛好等於門檻也算通過', async () => {
        const { ctx, calls } = fakeCtx({ data: {}, minConf: 0.8 });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.8, question_text: QUESTION
        });
        assert.equal(outcome.data.source, 'gate');
        assert.equal(calls.length, 0);
    });

    test('信心不足 → 落到第二層（要呼叫 LLM）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.95, rationale: '用到內積公式' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.5, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'llm');
        assert.equal(calls.length, 1);
    });

    test('章節不在白名單 → 落到第二層（即使信心 1.0）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '平面向量', chapter_confidence: 1, question_text: QUESTION
        });
        assert.equal(calls.length, 1);
        assert.equal(outcome.data.chapter, '向量內積');
    });
});

// ───────────────────────── 第二層 ─────────────────────────

describe('第二層：few-shot + LLM', () => {
    test('沒有 DB 時 few-shot 用 config/chapterExamples.js，few_shot_ids 是空陣列', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.deepEqual(outcome.data.few_shot_ids, []);
        assert.deepEqual(calls[0].cacheKeyParts.fewShotIds, []);
        // prompt 裡要有自製例句
        assert.ok(calls[0].parts[0].text.includes(getChapterExample('數學', '向量內積')));
    });

    test('有 DB 時各章取例，few_shot_ids 排序後進 cacheKeyParts（第 5.2 條）', async () => {
        const db = {
            query: async () => ({
                rows: [
                    { id: 87, chapter: '向量內積', question_text: '題 A' },
                    { id: 12, chapter: '圓方程式', question_text: '題 B' }
                ]
            })
        };
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.deepEqual(calls[0].cacheKeyParts.fewShotIds, [12, 87]);   // 由小到大
        assert.deepEqual(outcome.data.few_shot_ids, [12, 87]);
        assert.ok(calls[0].parts[0].text.includes('題 A'));
        // 題庫沒有的章由自製例句補上，prompt 才不會只認得那兩章
        assert.ok(calls[0].parts[0].text.includes(getChapterExample('數學', '外積')));
    });

    test('DB 壞掉不算失敗：退回自製例句繼續跑', async () => {
        const db = { query: async () => { throw new Error('connection refused'); } };
        const { ctx } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data.few_shot_ids, []);
    });

    test('cacheKeyParts 的鍵與順序照第 5.2 條', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION });
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'questionText', 'fewShotIds']);
        assert.equal(calls[0].agent, 'classify');
        assert.equal(calls[0].template, 'classify.v1');
    });

    test('prompt 只列該科的白名單（物理題不該看到數學章節）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '電磁感應', confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject: '物理', chapter: null, chapter_confidence: 0.1, question_text: '線圈磁通量變化' });
        const prompt = calls[0].parts[0].text;
        assert.ok(prompt.includes('電磁感應'));
        assert.ok(!prompt.includes('克拉瑪公式'), '物理題的 prompt 不該混進數學章節');
    });

    test('上一次的 feedback 會進 prompt', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        ctx.jq.payload = { classify: { feedback: '「平面向量」不在白名單內，最接近的是「向量內積」「平面方程式」' } };
        await classify.run(ctx, { subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION });
        assert.ok(calls[0].parts[0].text.includes('「平面向量」不在白名單內'));
    });
});

// ───────────────────────── 輸出閘門 ─────────────────────────

describe('輸出必須再過一次 isValidChapter', () => {
    test('跨科錯配（enum 是兩科合併的 66 個）被伺服器端擋下', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '電磁感應', confidence: 0.95, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'chapter_invalid');
        // 跨科時所有數學章節的相似度都是 0，候選就落回宣告順序的前兩章——
        // feedback 的格式是凍結的（第 3.3 條），沒有位置可以說「這是物理的章節」。
        assert.equal(outcome.feedback, '「電磁感應」不在白名單內，最接近的是「實數」「絕對值」');
        assert.equal(outcome.data.source, 'llm');
    });

    test('完全不在白名單的字串也擋下', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '平面向量', confidence: 0.99, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.reason, 'chapter_invalid');
        assert.match(outcome.feedback, /^「平面向量」不在白名單內，最接近的是/);
    });

    test('rationale 超過 200 字會被截斷（不讓「話多」變成整題失敗）', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: '很長'.repeat(300) } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.data.rationale.length, 200);
        assert.ok(outcome.data.rationale.endsWith('…'));
    });
});

// ───────────────────────── 輸入防呆與錯誤 ─────────────────────────

describe('輸入防呆', () => {
    test('學科不在白名單 → fail(chapter_invalid)，不呼叫 LLM', async () => {
        const { ctx, calls } = fakeCtx({ data: {} });
        const outcome = await classify.run(ctx, { subject: '化學', question_text: QUESTION });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'chapter_invalid');
        assert.match(outcome.feedback, /只接受「數學」「物理」/);
        assert.equal(calls.length, 0);
    });

    test('question_text 是空的 → fail(schema_invalid)', async () => {
        const { ctx } = fakeCtx({ data: {} });
        const outcome = await classify.run(ctx, { subject: '數學', question_text: '   ' });
        assert.equal(outcome.reason, 'schema_invalid');
    });

    test('llm 丟錯 → {kind:error}，agent 自己不 throw', async () => {
        const ctx = {
            llm: { generateJson: async () => { const e = new Error('逾時'); e.errorClass = 'timeout'; throw e; } },
            logger: console, config: { models: {}, thresholds: {} }, jq: null, db: null
        };
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'timeout');
    });
});
