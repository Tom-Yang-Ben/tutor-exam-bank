// 錄→放的往返測試：用 repo 內已錄好的 eval/cassettes 把 extract／classify 整條跑一遍（WS-B）
//
// 這是整個 WS-B 唯一一項「端到端」的單元測試：真的走 services/llm 的 replay 路徑、
// 真的讀 eval/fixtures/sample_exam.pdf、真的過 ajv 與 isValidChapter，
// 但**不連 Gemini、不連 PG、不需要金鑰**——CI 跑得起來的原因就是 cassette。
//
// cassette 若尚未錄（例如剛 clone 而 eval/cassettes 是空的），整組測試 skip 而不是紅燈：
// 錄製需要金鑰，不是每個人都有。
//
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');

const llm = require('../../services/llm');
const extractAgent = require('../../agents/extract');
const classifyAgent = require('../../agents/classify');
const { buildSchema } = require('../../agents/schemas');
const { cassetteKey, cassettePath } = require('../../services/llm/cassette');
const models = require('../../config/models');

const SAMPLE_PDF = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'sample_exam.pdf');
const CASSETTE_DIR = path.resolve(__dirname, '..', '..', 'eval', 'cassettes');
const FIXTURE = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json');

function hasCassettes(agent) {
    try {
        return fs.readdirSync(path.join(CASSETTE_DIR, agent)).some(f => f.endsWith('.json'));
    } catch (err) {
        return false;
    }
}

/**
 * 現行樣卷（eval/fixtures/sample_exam.pdf）第 1 塊的 extract cassette 在不在。
 *
 * 為什麼要算到這麼細：cassette 的鍵含 pdfSha256（第 5.2 條），樣卷一換鍵就全變。
 * 只檢查「extract/ 目錄底下有沒有檔案」會在換樣卷後給出一個假的綠燈條件，
 * 然後測試才在斷言那一行紅掉，訊息還是「找不到 cassette」——那樣很難看懂發生什麼事。
 */
function extractCassetteReady() {
    if (!fs.existsSync(SAMPLE_PDF)) return false;
    const pdfSha256 = crypto.createHash('sha256').update(fs.readFileSync(SAMPLE_PDF)).digest('hex');
    const key = cassetteKey({
        agent: 'extract',
        modelId: models.parseModel(models.MODEL_EXTRACT).id,
        template: extractAgent.TEMPLATE,
        schema: buildSchema('extract'),
        cacheKeyParts: { template: extractAgent.TEMPLATE, chunkNo: 1, pdfSha256 }
    });
    return fs.existsSync(cassettePath('extract', key));
}

const READY = extractCassetteReady();

const envBackup = {};
const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'MODEL_EXTRACT'];

before(() => {
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
    process.env.LLM_MODE = 'replay';
    delete process.env.EVAL_CASSETTE_DIR;       // 用預設的 eval/cassettes
    delete process.env.MODEL_EXTRACT;           // 用 config/models.js 的預設（＝錄製時用的那一個）
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});

/** 真的走 services/llm（replay），只有 db 是 null */
function replayCtx() {
    return {
        llm,
        db: null,
        job: { id: 0, budget_usd: 1, cost_usd: 0 },
        jq: null,
        logger: { info() {}, warn() {}, error() {} },
        config: {
            models: {},
            thresholds: { classifyMinConf: 0.8, pdfChunkPages: 20, inlineMaxBytes: 15728640 },
            features: {}
        },
        signal: undefined
    };
}

const SKIP_REASON = '現行樣卷還沒有對應的 extract cassette——樣卷換過（裁決 S2-15 改用 WS-D 的 '
    + 'eval/fixtures/make_sample_pdf.js 產出，pdfSha256 變了）或還沒錄。'
    + '等 WS-C 的 registerTemplate／buildSchema 合入後，跑 node scripts/record_cassettes.js --agent all 重錄。';

describe('cassette 回放 — extract（LLM_MODE=replay，不連外）', { skip: READY ? false : SKIP_REASON }, () => {
    test('extract：對公開樣卷 sample_exam.pdf 回放，每一題都通過 ajv 且欄位形狀正確', async () => {
        const outcome = await extractAgent.run(replayCtx(), {
            pdfPath: SAMPLE_PDF,
            chunk: { no: 1, fromPage: 1, toPage: 1 }
        });

        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        assert.deepEqual(outcome.data.rejected, []);

        // WS-D 的樣卷挑了 10 題（eval/fixtures/make_sample_pdf.js 的 PICKED）。
        // 這裡不釘死題數：本測驗的是「回放 + ajv + 欄位形狀」，模型的抓題率是 eval 的事，
        // 不該讓模型少抓一題就把單元測試變紅。
        const qs = outcome.data.questions;
        assert.ok(qs.length >= 8, `拆出的題數只有 ${qs.length}，樣卷有 10 題，少太多了`);

        // idx = chunk_no*1000 + 位置，必須連號且唯一（UNIQUE (job_id, idx) 靠它）
        assert.deepEqual(qs.map(q => q.idx), qs.map((_, i) => 1001 + i));

        // 兩科都要有（樣卷刻意跨科挑題）
        assert.ok(qs.some(q => q.subject === '數學'));
        assert.ok(qs.some(q => q.subject === '物理'));

        for (const q of qs) {
            // 題幹不得殘留 [附圖描述：…]（第 3.2 條）
            assert.ok(!q.question_text.includes('[附圖描述'), `#${q.idx} 的題幹殘留附圖描述`);
            // payload.extract 的固定欄位
            assert.equal(q.chunk_no, 1);
            assert.deepEqual(q.page_range, [1, 1]);
            assert.ok(typeof q.answer_text === 'string' && q.answer_text.length > 0);
            // 沒有附圖時 figure_desc 這個鍵不該存在（不是空字串）
            if ('figure_desc' in q) assert.ok(q.figure_desc.trim().length > 0);
        }
    });

    test('extract：換一塊（chunkNo 不同）就是不同的鍵 → replay miss 且訊息凍結', async () => {
        await assert.rejects(
            () => extractAgent.run(replayCtx(), { pdfPath: SAMPLE_PDF, chunk: { no: 7, fromPage: 1, toPage: 1 } })
                .then((o) => { if (o.kind === 'error') throw new Error(o.message); return o; }),
            /LLM_MODE=replay 找不到 cassette（agent=extract key=/
        );
    });
});

// classify 的 cassette 與樣卷無關（鍵是 questionText + fewShotIds），
// 所以樣卷換掉時它仍然有效——兩組獨立 skip，不要互相拖累。
describe('cassette 回放 — classify（LLM_MODE=replay，不連外）', {
    skip: hasCassettes('classify') ? false : '尚未錄製 classify cassette（需要金鑰，見 docs/llm.md）'
}, () => {
    test('classify：回放公開 fixture 的題目，輸出通過 isValidChapter', async () => {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const q = fixture.questions.find(x => x.id === 1);

        const outcome = await classifyAgent.run(replayCtx(), {
            subject: q.subject,
            chapter: null,
            chapter_confidence: 0,     // 強迫走第二層（第一層不呼叫模型，也就沒有 cassette）
            question_text: q.question_text
        });

        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.chapter, q.chapter);
        assert.deepEqual(outcome.data.few_shot_ids, []);   // 錄製時刻意不接 DB，回放才對得上
        assert.ok(outcome.data.rationale.length > 0);
        assert.ok(outcome.data.rationale.length <= 200);
    });

    test('classify：零成本閘門不需要 cassette（回放時也不該打到 cassette）', async () => {
        const outcome = await classifyAgent.run(replayCtx(), {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_text: '求 $\\vec{a}\\cdot\\vec{b}$'
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
    });
});
