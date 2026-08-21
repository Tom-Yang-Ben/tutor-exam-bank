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

const llm = require('../../services/llm');
const extractAgent = require('../../agents/extract');
const classifyAgent = require('../../agents/classify');

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

const READY = fs.existsSync(SAMPLE_PDF) && hasCassettes('extract') && hasCassettes('classify');

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

describe('cassette 回放（LLM_MODE=replay，不連外）', { skip: READY ? false : '尚未錄製 cassette（需要金鑰，見 docs/llm.md）' }, () => {
    test('extract：對自製的 sample_exam.pdf 回放出 6 題，全部通過 ajv', async () => {
        const outcome = await extractAgent.run(replayCtx(), {
            pdfPath: SAMPLE_PDF,
            chunk: { no: 1, fromPage: 1, toPage: 1 }
        });

        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        assert.equal(outcome.data.questions.length, 6);
        assert.deepEqual(outcome.data.rejected, []);
        assert.deepEqual(outcome.data.questions.map(q => q.idx), [1001, 1002, 1003, 1004, 1005, 1006]);

        // 六題涵蓋兩科、含一題證明題（verify 節點會 skipped）
        assert.ok(outcome.data.questions.some(q => q.subject === '物理'));
        assert.ok(outcome.data.questions.some(q => q.question_type === '證明'));

        // 題幹不得殘留 [附圖描述：…]（第 3.2 條）
        for (const q of outcome.data.questions) {
            assert.ok(!q.question_text.includes('[附圖描述'), `#${q.idx} 的題幹殘留附圖描述`);
        }
        // 第 5 題有附圖，figure_desc 應該有東西
        assert.ok(outcome.data.questions.some(q => typeof q.figure_desc === 'string' && q.figure_desc.length > 0));
    });

    test('extract：換一塊（chunkNo 不同）就是不同的鍵 → replay miss 且訊息凍結', async () => {
        await assert.rejects(
            () => extractAgent.run(replayCtx(), { pdfPath: SAMPLE_PDF, chunk: { no: 7, fromPage: 1, toPage: 1 } })
                .then((o) => { if (o.kind === 'error') throw new Error(o.message); return o; }),
            /LLM_MODE=replay 找不到 cassette（agent=extract key=/
        );
    });

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
