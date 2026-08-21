// services/llm/* 單元測試（WS-C / A-T3 的 embed 部分）
//
// 只測 EMBED_MODE=fixture 這條路：CI 不連 Gemini、不需要金鑰。
// 重點在「查不到就丟錯」——靜默回退成假向量會讓 eval 量到一個不存在的系統。
//
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { embed, l2Normalize } = require('../../services/llm');
const { sha256Hex, saveToFixture, fixturePath } = require('../../services/llm/fixture');

const MODEL = 'test-embed-model';
const DIM = 4;
const TEXT = '數學｜向量內積｜計算｜難度3\n設 a=(1,2)，求 |a|。';

let tmpDir;
const envBackup = {};

before(() => {
    // fixture 一律寫到系統暫存目錄，不碰 repo 內的 eval/fixtures
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-embed-fixture-'));
    for (const k of ['EMBED_FIXTURE_DIR', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM']) envBackup[k] = process.env[k];
    process.env.EMBED_FIXTURE_DIR = tmpDir;
    process.env.EMBED_MODE = 'fixture';

    // 造一份最小 fixture：值刻意不是單位向量，用來驗證讀回來會被 L2 正規化
    saveToFixture({ model: MODEL, dim: DIM, entries: [[sha256Hex(TEXT), [3, 4, 0, 0]]] });
});

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('l2Normalize', () => {
    test('回傳單位向量', () => {
        const v = l2Normalize([3, 4]);
        assert.deepEqual(v, [0.6, 0.8]);
        const norm = Math.hypot(...v);
        assert.ok(Math.abs(norm - 1) < 1e-12);
    });

    test('零向量丟錯（代表上游回了空向量，不能當成正常結果）', () => {
        assert.throws(() => l2Normalize([0, 0, 0]), /L2 範數/);
    });
});

describe('embed — EMBED_MODE=fixture', () => {
    test('命中：以 sha256(embed_text) 查表，回傳 dim 維且已 L2 正規化的向量', async () => {
        const { vectors, usage } = await embed({ model: MODEL, texts: [TEXT], dim: DIM });
        assert.equal(vectors.length, 1);
        assert.equal(vectors[0].length, DIM);
        assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-9);
        assert.equal(usage.tokenIn, 0);   // fixture 不產生費用
    });

    test('texts 為空陣列 → 直接回空結果，不讀檔', async () => {
        const { vectors } = await embed({ model: MODEL, texts: [], dim: DIM });
        assert.deepEqual(vectors, []);
    });

    test('查不到 → 丟錯並提示 npm run eval:record（不得回退成假向量）', async () => {
        await assert.rejects(
            () => embed({ model: MODEL, texts: ['這段文本沒有錄過'], dim: DIM }),
            (err) => {
                assert.match(err.message, /查無此文本/);
                assert.match(err.message, /npm run eval:record/);
                return true;
            }
        );
    });

    test('fixture 檔不存在 → 錯誤訊息要指出缺哪一個檔', async () => {
        await assert.rejects(
            () => embed({ model: 'no-such-model', texts: [TEXT], dim: DIM }),
            /找不到 embedding fixture[\s\S]*embeddings\.no-such-model\.4\.json/
        );
    });

    test('維度不符 → 丟錯（改 EMBED_DIM 等同換模型，必須全量重算）', async () => {
        await assert.rejects(
            () => embed({ model: MODEL, texts: [TEXT], dim: 768 }),
            /找不到 embedding fixture|維度不符/
        );
    });

    test('texts 不是陣列 → 丟錯', async () => {
        await assert.rejects(() => embed({ model: MODEL, texts: '一段文字', dim: DIM }), /必須是字串陣列/);
    });
});

describe('fixture 檔格式', () => {
    test('鍵是 sha256 hex 小寫、值是小數 6 位的數字陣列、鍵依字典序', () => {
        const file = fixturePath(MODEL, DIM);
        saveToFixture({ model: MODEL, dim: DIM, entries: [['ff'.repeat(32), [0.1234567, -0.7654321, 0, 1]]] });
        const table = JSON.parse(fs.readFileSync(file, 'utf8'));

        const keys = Object.keys(table);
        assert.deepEqual(keys, [...keys].sort());
        for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
        assert.deepEqual(table['ff'.repeat(32)], [0.123457, -0.765432, 0, 1]);
    });
});

describe('模式旗標', () => {
    test('EMBED_MODE 不合法 → 丟錯而不是默默走 live', async () => {
        const old = process.env.EMBED_MODE;
        process.env.EMBED_MODE = 'yolo';
        try {
            await assert.rejects(() => embed({ model: MODEL, texts: [TEXT], dim: DIM }), /EMBED_MODE 只能是/);
        } finally {
            process.env.EMBED_MODE = old;
        }
    });

    // 階段 2（A-T3）把 generateJson 實作完之後，這一項的斷言由「屬階段 2、尚未實作」
    // 改成「replay 模式下缺 agent 就丟錯」——測試的本意（不會偷偷呼叫 Gemini）不變。
    // record／replay 下 agent 是必填（interfaces-stage2.md 第 5.1 條），沒有 agent 就算不出 cassette 鍵。
    test('LLM_MODE=replay 時 generateJson 不會偷偷呼叫 Gemini（缺 agent 直接丟錯）', async () => {
        const { generateJson } = require('../../services/llm');
        const old = process.env.LLM_MODE;
        process.env.LLM_MODE = 'replay';
        try {
            await assert.rejects(() => generateJson({ parts: [{ text: 'hi' }] }), /agent 是必填/);
        } finally {
            if (old === undefined) delete process.env.LLM_MODE; else process.env.LLM_MODE = old;
        }
    });
});
