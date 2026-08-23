// services/variantService.js 的純函式單元測試（WS-B / P-10）
//
// 不連 DB、不連 Gemini：只測 body 解析、SQL 的參數順序與回應形狀。
// 真的下 SQL 的部分由 test/integration/variants.pg.test.js 負責——
// 純文字單測擋不了 SQL 語法錯，只擋得住參數錯位，那是它唯一的職責。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../services/variantService');

describe('parseVariantBody', () => {
    test('全部沒給 → 預設值', () => {
        const r = svc.parseVariantBody({});
        assert.equal(r.ok, true);
        assert.deepEqual(r.params, { count: 1, difficultyDelta: 0, studentId: null, forceGenerate: false });
    });

    test('body 是 undefined 也回預設值（Express 沒有 body 時不該炸）', () => {
        assert.equal(svc.parseVariantBody(undefined).ok, true);
    });

    test('count 合法範圍 1~3（上限由 VARIANT_MAX_PER_REQUEST 決定）', () => {
        assert.equal(svc.parseVariantBody({ count: 3 }, 3).params.count, 3);
        assert.deepEqual(svc.parseVariantBody({ count: 4 }, 3), { ok: false, message: 'count 必須是 1~3 的整數。' });
        assert.deepEqual(svc.parseVariantBody({ count: 0 }, 3), { ok: false, message: 'count 必須是 1~3 的整數。' });
        assert.deepEqual(svc.parseVariantBody({ count: 2.5 }, 3), { ok: false, message: 'count 必須是 1~3 的整數。' });
        assert.deepEqual(svc.parseVariantBody({ count: 'x' }, 3), { ok: false, message: 'count 必須是 1~3 的整數。' });
    });

    test('上限改了訊息字串跟著改（${max} 代入）', () => {
        assert.equal(svc.parseVariantBody({ count: 9 }, 5).message, 'count 必須是 1~5 的整數。');
    });

    test('difficulty_delta 只接受 -1／0／1', () => {
        for (const d of [-1, 0, 1]) {
            assert.equal(svc.parseVariantBody({ difficulty_delta: d }).params.difficultyDelta, d);
        }
        assert.deepEqual(svc.parseVariantBody({ difficulty_delta: 2 }),
            { ok: false, message: 'difficulty_delta 只接受 -1、0、1。' });
        assert.deepEqual(svc.parseVariantBody({ difficulty_delta: '-1' }).params.difficultyDelta, -1);
    });

    test('student_id 必須是正整數', () => {
        assert.equal(svc.parseVariantBody({ student_id: 3 }).params.studentId, 3);
        assert.deepEqual(svc.parseVariantBody({ student_id: 0 }), { ok: false, message: 'student_id 必須是正整數。' });
        assert.deepEqual(svc.parseVariantBody({ student_id: -1 }), { ok: false, message: 'student_id 必須是正整數。' });
        assert.deepEqual(svc.parseVariantBody({ student_id: 'abc' }), { ok: false, message: 'student_id 必須是正整數。' });
        assert.equal(svc.parseVariantBody({ student_id: null }).params.studentId, null);
    });

    test('force_generate 必須是真的布林值（字串 "true" 不算）', () => {
        assert.equal(svc.parseVariantBody({ force_generate: true }).params.forceGenerate, true);
        assert.deepEqual(svc.parseVariantBody({ force_generate: 'true' }),
            { ok: false, message: 'force_generate 必須是布林值。' });
        assert.deepEqual(svc.parseVariantBody({ force_generate: 1 }),
            { ok: false, message: 'force_generate 必須是布林值。' });
    });
});

describe('buildRetrievedQuery（第 3.1 條的八個條件）', () => {
    const opts = {
        vectorLiteral: '[0.1,0.2]', subject: '數學', sourceId: 12, familyRoot: 12,
        difficulty: 3, studentId: 7, simMin: 0.8, limit: 2
    };

    test('參數順序凍結為 vec／subject／sourceId／familyRoot／difficulty／studentId／simMin／limit', () => {
        const { values } = svc.buildRetrievedQuery(opts);
        assert.deepEqual(values, ['[0.1,0.2]', '數學', 12, 12, 3, 7, 0.8, 2]);
    });

    test('八個條件逐條出現在 SQL 裡', () => {
        const { text } = svc.buildRetrievedQuery(opts);
        assert.ok(text.includes('q.subject = $2'), '① 同學科');
        assert.ok(text.includes('q.archived_at IS NULL'), '② 未封存');
        assert.ok(text.includes('q.id <> $3'), '③ 排除藍本自己');
        assert.ok(text.includes('a.student_id = $6'), '④ 該生沒寫過');
        assert.ok(text.includes('COALESCE(q.variant_of, q.id) <> $4'), '⑤ 排除藍本整個家族');
        assert.ok(text.includes('q.embedding IS NOT NULL'), '⑥ 有向量');
        assert.ok(text.includes('q.difficulty = $5'), '⑦ 鎖定單一難度（字面語意）');
        assert.ok(text.includes('>= $7::float8'), '⑧ 餘弦門檻');
    });

    test('排序與筆數：ORDER BY cosine DESC, id ASC + LIMIT count', () => {
        const { text } = svc.buildRetrievedQuery(opts);
        assert.ok(/ORDER BY cosine DESC, id ASC/.test(text));
        assert.ok(/LIMIT \$8/.test(text));
    });

    test('用的是餘弦而不是 RRF（裁決 S3-7）', () => {
        const { text } = svc.buildRetrievedQuery(opts);
        assert.ok(text.includes('1 - (q.embedding <=> $1::vector)'));
        assert.ok(!/rrf|row_number|rank/i.test(text), 'retrieved 分支不共用 buildHybridQuery 的融合分數');
    });

    test('student_id 為 null 時整個 NOT EXISTS 被 $6::int IS NULL 短路掉', () => {
        const { text, values } = svc.buildRetrievedQuery({ ...opts, studentId: null });
        assert.equal(values[5], null);
        assert.ok(text.includes('$6::int IS NULL OR NOT EXISTS'));
    });
});

describe('toResultRow', () => {
    test('score 就是 cosine（兩個鍵同值），形狀是 /similar 的 results 加一個 cosine', () => {
        const row = svc.toResultRow({
            id: 87, subject: '數學', chapter: '向量內積', question_type: '計算',
            difficulty: 3, question_text: '…', cosine: '0.9142'
        });
        assert.deepEqual(Object.keys(row).sort(),
            ['chapter', 'cosine', 'difficulty', 'id', 'question_text', 'question_type', 'score', 'subject']);
        assert.equal(row.score, 0.9142);
        assert.equal(row.cosine, 0.9142);
        assert.equal(typeof row.score, 'number', 'NUMERIC 回字串，必須 Number() 過');
    });
});

describe('設定與旗標', () => {
    test('三個門檻都有預設值，缺 .env 也跑得起來', () => {
        assert.equal(typeof svc.maxPerRequest({}), 'number');
        assert.equal(svc.maxPerRequest({}), 3);
        assert.equal(svc.simMin({}), 0.8);
        assert.equal(svc.tokenBudgetUsd({}), 0.3);
    });

    test('環境變數讀得到，壞值退回預設', () => {
        assert.equal(svc.maxPerRequest({ VARIANT_MAX_PER_REQUEST: '5' }), 5);
        assert.equal(svc.simMin({ VARIANT_SIM_MIN: '0.85' }), 0.85);
        assert.equal(svc.simMin({ VARIANT_SIM_MIN: 'abc' }), 0.8);
    });

    test('FEATURE_VARIANTS 經 config/features.js 的凍結布林規則', () => {
        const original = process.env.FEATURE_VARIANTS;
        try {
            process.env.FEATURE_VARIANTS = 'false';
            assert.equal(svc.isVariantsEnabled(), false);
            process.env.FEATURE_VARIANTS = 'TRUE';
            assert.equal(svc.isVariantsEnabled(), true);
            process.env.FEATURE_VARIANTS = '1';
            assert.equal(svc.isVariantsEnabled(), true);
            process.env.FEATURE_VARIANTS = 'yes';
            assert.equal(svc.isVariantsEnabled(), false, '「只要有值就是真」正是第 9 條要防的');
        } finally {
            if (original === undefined) delete process.env.FEATURE_VARIANTS;
            else process.env.FEATURE_VARIANTS = original;
        }
    });
});

describe('requestVariants 的參數防呆（不連 DB 也走得到的分支）', () => {
    test(':id 不是正整數 → 400 無效的題目 ID', async () => {
        for (const bad of [0, -3, 1.5, NaN, 'x']) {
            const r = await svc.requestVariants(bad, {});
            assert.deepEqual(r, { status: 400, body: { message: '無效的題目 ID' } });
        }
    });

    test('body 不合法 → 400，且不會去碰資料庫', async () => {
        const db = { query: async () => { throw new Error('不該連到 DB'); }, pool: {} };
        const r = await svc.requestVariants(12, { count: 99 }, { db });
        assert.equal(r.status, 400);
        assert.equal(r.body.message, 'count 必須是 1~3 的整數。');
    });
});

describe('requestVariants 的三條主要分支（注入假 db）', () => {
    /** 只回應本檔用得到的三種查詢，其餘丟錯——避免測試在假的成功上通過 */
    function fakeDb({ source, retrieved = [], activeJob = null, onCreate }) {
        const seen = [];
        const client = {
            query: async (text, values) => {
                seen.push(text);
                if (/^\s*BEGIN|COMMIT|ROLLBACK|SET LOCAL/.test(text)) return { rows: [] };
                if (text.includes('FROM questions q')) return { rows: retrieved };
                if (text.includes('INSERT INTO jobs')) { onCreate?.(values); return { rows: [{ id: 57, state: 'queued' }] }; }
                if (text.includes('INSERT INTO job_events')) { onCreate?.(values); return { rows: [] }; }
                throw new Error(`假 db 沒有預期到這句：${text.slice(0, 60)}`);
            },
            release() { }
        };
        return {
            seen,
            db: {
                pool: { connect: async () => client },
                query: async (text, values) => {
                    seen.push(text);
                    if (text.includes('FROM questions')) return { rows: source ? [source] : [] };
                    if (text.includes('FROM jobs')) return { rows: activeJob ? [activeJob] : [] };
                    throw new Error(`假 db 沒有預期到這句：${text.slice(0, 60)}`);
                }
            }
        };
    }

    const SOURCE = {
        id: 12, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
        question_text: '…', answer_text: '…', variant_of: null, embedding: '[0.1,0.2]'
    };

    test('找不到題目（含已封存）→ 404', async () => {
        const { db } = fakeDb({ source: null });
        assert.deepEqual(await svc.requestVariants(12, {}, { db }),
            { status: 404, body: { message: '找不到該題目' } });
    });

    test('藍本沒有向量 → 409，訊息與 /similar 逐字相同', async () => {
        const { db } = fakeDb({ source: { ...SOURCE, embedding: null } });
        const r = await svc.requestVariants(12, {}, { db });
        assert.equal(r.status, 409);
        assert.equal(r.body.message, '該題尚未建立向量，請執行 npm run embed:backfill');
    });

    test('池夠用 → 200 retrieved，一次 LLM／embedding 都不呼叫', async () => {
        const { db } = fakeDb({
            source: SOURCE,
            retrieved: [{ id: 87, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: 'a', cosine: 0.92 }]
        });
        const r = await svc.requestVariants(12, { count: 1 }, { db });
        assert.equal(r.status, 200);
        assert.equal(r.body.mode, 'retrieved');
        assert.equal(r.body.questions.length, 1);
        assert.equal(r.body.questions[0].score, r.body.questions[0].cosine);
    });

    test('池不足 → 202 generating，並建了一個 kind=variant 的 job', async () => {
        let created = null;
        const { db } = fakeDb({ source: SOURCE, retrieved: [], onCreate: (v) => { created = created || v; } });
        const r = await svc.requestVariants(12, { count: 2 }, { db });
        assert.equal(r.status, 202);
        assert.deepEqual(r.body, { mode: 'generating', job_id: 57, state: 'queued', existing: false });
        assert.equal(created[0], 12, 'source_question_id 要寫進 jobs');
    });

    test('回檢索到的筆數 < count 也走 202（不回一半）', async () => {
        const { db } = fakeDb({
            source: SOURCE,
            retrieved: [{ id: 87, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: 'a', cosine: 0.92 }]
        });
        const r = await svc.requestVariants(12, { count: 2 }, { db });
        assert.equal(r.status, 202);
    });

    test('force_generate=true 跳過檢索，直接走生成', async () => {
        const { db, seen } = fakeDb({ source: SOURCE, retrieved: [] });
        const r = await svc.requestVariants(12, { force_generate: true }, { db });
        assert.equal(r.status, 202);
        assert.ok(!seen.some(s => s.includes('SET LOCAL hnsw.ef_search')), 'force_generate 不該再跑一次檢索');
    });

    test('同一藍本已有未完成的 job → 合流回既有 job_id（existing:true）', async () => {
        const { db } = fakeDb({ source: SOURCE, retrieved: [], activeJob: { id: 41, state: 'processing' } });
        const r = await svc.requestVariants(12, {}, { db });
        assert.deepEqual(r.body, { mode: 'generating', job_id: 41, state: 'processing', existing: true });
    });

    test('force_generate 不繞過合流（裁決 S3-8：雙擊不該付兩次錢）', async () => {
        const { db } = fakeDb({ source: SOURCE, retrieved: [], activeJob: { id: 41, state: 'queued' } });
        const r = await svc.requestVariants(12, { force_generate: true }, { db });
        assert.equal(r.body.existing, true);
        assert.equal(r.body.job_id, 41);
    });
});
