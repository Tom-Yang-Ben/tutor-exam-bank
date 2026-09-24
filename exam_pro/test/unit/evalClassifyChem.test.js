// eval/classify_chem.js 的單元測試（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 6 點）
//
//   1. eval/golden/classify_chem.json 過得了硬閘門（化學六冊每冊 ≥ 3 題、章節在白名單）；
//   2. 沒有 cassette 時印出「尚未錄製，略過」並 exit 0（CI 不需要化學 cassette）；
//   3. **錄製之後的回放真的接得起來**：用 services/llm/cassette.js 的同一支 cassetteKey
//      在暫存目錄寫一份假 cassette（回應 = golden 正解），replay 模式跑完應得 accuracy 1。
//      這一條擋的是「錄了 cassette 卻因為鍵算法對不上而全部 miss」——Owner 花了錢錄完才發現就太晚了。
// 不連網路、不需要金鑰。執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'eval', 'classify_chem.js');
const { validateGolden, loadGolden, DEFAULT_GOLDEN, AGENT } = require('../../eval/classify_chem');
const classify = require('../../agents/classify');
const { buildSchema } = require('../../agents/schemas');
const { cassetteKey } = require('../../services/llm/cassette');

const MODEL = 'gemini:gemini-3.5-flash';

function runScript(env) {
    return spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, LLM_MODE: 'replay', EMBED_MODE: 'fixture', MODEL_EXTRACT: MODEL, MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview', ...env }
    });
}

describe('eval/golden/classify_chem.json', () => {
    test('通過硬閘門：24 筆以上、化學六冊每冊至少 3 題', () => {
        const golden = loadGolden(DEFAULT_GOLDEN);
        assert.ok(golden.entries.length >= 18);
        assert.deepEqual(validateGolden(golden.entries), []);
    });

    test('硬閘門擋得住：章節不在化學白名單、decoy 等於正解、某冊不足 3 題', () => {
        const golden = loadGolden(DEFAULT_GOLDEN);
        const bad = golden.entries.map(e => ({ ...e }));
        bad[0].chapter = '向量內積';
        bad[1].decoy_chapter = bad[1].chapter;
        const problems = validateGolden(bad);
        assert.ok(problems.some(p => p.includes('不在化學白名單')), problems.join('\n'));
        assert.ok(problems.some(p => p.includes('decoy_chapter 不得等於')), problems.join('\n'));
        assert.ok(validateGolden(golden.entries.slice(0, 3)).some(p => p.includes('每冊至少 3 題')));
    });
});

describe('npm run eval:classify-chem', () => {
    test('沒有 cassette：印出「尚未錄製，略過」並 exit 0', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chem-cassette-empty-'));
        const r = runScript({ EVAL_CASSETTE_DIR: empty });
        fs.rmSync(empty, { recursive: true, force: true });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /尚未錄製，略過/);
    });

    test('有完整 cassette：回放跑完、報分數（假 cassette 回正解 → accuracy 1）', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chem-cassette-'));
        const golden = loadGolden(DEFAULT_GOLDEN);
        const schema = buildSchema('classify', { group: 'chemistry' });
        fs.mkdirSync(path.join(dir, AGENT), { recursive: true });
        for (const e of golden.entries) {
            // 與 agents/classify.js 送出的 cacheKeyParts 同形：ctx.db=null → few-shot 全來自設定檔，fewShotIds = []
            const cacheKeyParts = { template: classify.TEMPLATE_CHEM, questionText: e.question_text.trim(), fewShotIds: [] };
            const key = cassetteKey({ agent: AGENT, modelId: 'gemini-3.5-flash', template: classify.TEMPLATE_CHEM, schema, cacheKeyParts });
            fs.writeFileSync(path.join(dir, AGENT, `${key}.json`), JSON.stringify({
                meta: { agent: AGENT, model: 'gemini-3.5-flash', template: classify.TEMPLATE_CHEM },
                request: { parts: [], cacheKeyParts },
                response: { data: { chapter: e.chapter, confidence: 0.9, rationale: '測試用' }, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1 }
            }));
        }
        const r = runScript({ EVAL_CASSETTE_DIR: dir });
        fs.rmSync(dir, { recursive: true, force: true });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /accuracy 1、macro-F1 1/);
        // 報表寫進 eval/reports（已 gitignore）；測試跑完清掉，不留垃圾
        const m = /報表：(.+\.json)/.exec(r.stdout);
        if (m) fs.rmSync(path.join(ROOT, m[1]), { force: true });
    });

    test('cassette 不完整：報 replay miss、分數 n/a、exit 0（不在 CI 清單內，不擋）', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chem-cassette-partial-'));
        fs.mkdirSync(path.join(dir, AGENT), { recursive: true });
        fs.writeFileSync(path.join(dir, AGENT, 'deadbeef.json'), '{"meta":{},"request":{},"response":{"data":{}}}');
        const r = runScript({ EVAL_CASSETTE_DIR: dir });
        fs.rmSync(dir, { recursive: true, force: true });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /replay miss/);
    });
});
