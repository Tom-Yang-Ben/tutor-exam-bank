// ─────────────────────────────────────────────────────────────
// test/unit/cassetteProbe.test.js — 回放探針（eval/lib/cassetteProbe.js）
//
// 兩件事：
//   1. 探針以 --require 掛上去之後，記下的命中／miss 與實際回放一致；
//   2. 被包住的函式**行為完全不變**：命中照樣回 cassette 的 data，miss 照樣丟凍結的訊息
//      （第 5.2 條、裁決 S2-14），embedding 查不到照樣丟錯（不得回退成假向量）。
// 子行程只讀暫存目錄（EVAL_CASSETTE_DIR、EMBED_FIXTURE_DIR 都指過去），不碰 repo 的 eval/cassettes/。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const probe = require('../../eval/lib/cassetteProbe');
const { cassetteKey } = require('../../services/llm/cassette');
const { registerTemplate } = require('../../services/llm/templates');
const { sha256Hex } = require('../../services/llm/fixture');
const { REPLAY_MISS_PREFIX } = require('../../eval/lib/replayMiss');

const APP_DIR = path.resolve(__dirname, '..', '..');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cassette-probe-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('cassetteProbe', () => {
    test('沒設 EVAL_PROBE_DIR 時 require 本檔不會包任何東西（工具讀紀錄時不影響自己的行程）', () => {
        const fake = require('../../services/llm/fake');
        assert.equal(fake.generateJson.__probed, undefined);
        assert.equal(fake.generateText.__probed, undefined);
        assert.equal(typeof probe.readProbeDir, 'function');
        assert.deepEqual(probe.readProbeDir(path.join(tmp, '不存在')), []);
    });

    test('子行程以 --require 掛上探針：命中、miss、generateText、embedding 都記下來，回傳與錯誤不變', () => {
        const cassettes = path.join(tmp, 'cassettes');
        const emb = path.join(tmp, 'emb');
        const probeDir = path.join(tmp, 'probe');
        fs.mkdirSync(emb, { recursive: true });

        // 一支命中用的 cassette（鍵照 services/llm 的公式算；模板與子行程註冊同一份原文）
        registerTemplate('probe_test.v1', '探針測試用模板');
        const hitParts = { template: 'probe_test.v1', n: 1 };
        const hitKey = cassetteKey({ agent: 'probe_test', modelId: 'gemini-3.5-flash', template: 'probe_test.v1', schema: SCHEMA, cacheKeyParts: hitParts });
        fs.mkdirSync(path.join(cassettes, 'probe_test'), { recursive: true });
        fs.writeFileSync(path.join(cassettes, 'probe_test', `${hitKey}.json`), JSON.stringify({
            meta: { agent: 'probe_test', model: 'gemini-3.5-flash' },
            request: { parts: [], cacheKeyParts: hitParts },
            response: { data: { ok: true }, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 } }
        }), 'utf8');
        // 向量檔：「甲」有、「乙」沒有
        fs.writeFileSync(path.join(emb, 'embeddings.probe-model.2.json'), JSON.stringify({ [sha256Hex('甲')]: [0.6, 0.8] }), 'utf8');

        const child = path.join(tmp, 'child.js');
        fs.writeFileSync(child, `
            const path = require('path');
            const APP = ${JSON.stringify(APP_DIR)};
            require(path.join(APP, 'services', 'llm', 'templates')).registerTemplate('probe_test.v1', '探針測試用模板');
            const llm = require(path.join(APP, 'services', 'llm'));
            const { loadEmbeddings } = require(path.join(APP, 'eval', 'lib', 'embeddings'));
            const SCHEMA = ${JSON.stringify(SCHEMA)};
            const base = { model: 'gemini:gemini-3.5-flash', agent: 'probe_test', template: 'probe_test.v1', schema: SCHEMA, parts: [{ text: 'x' }] };
            (async () => {
                const out = {};
                out.hit = (await llm.generateJson({ ...base, cacheKeyParts: { template: 'probe_test.v1', n: 1 } })).data;
                try { await llm.generateJson({ ...base, cacheKeyParts: { template: 'probe_test.v1', n: 2 } }); } catch (e) { out.missErr = e.message; }
                try { await llm.generateText({ ...base, schema: undefined, cacheKeyParts: { template: 'probe_test.v1', n: 3 } }); } catch (e) { out.textErr = e.message; }
                try { await llm.embed({ texts: ['甲', '乙'], model: 'probe-model', dim: 2 }); } catch (e) { out.embedErr = e.message; }
                const q = { id: 999, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 1, question_text: '探針測試：不存在的題' };
                out.loadMissing = loadEmbeddings({ questions: [q], optional: true }).missing;
                out.noFile = loadEmbeddings({ questions: [q], model: '不存在的模型', optional: true }).available;
                process.stdout.write(JSON.stringify(out));
            })().catch(e => { console.error(e); process.exit(2); });
        `, 'utf8');

        const res = spawnSync(process.execPath, ['--require', probe.PROBE_PATH, child], {
            cwd: APP_DIR, encoding: 'utf8',
            env: {
                ...process.env, LLM_MODE: 'replay', EMBED_MODE: 'fixture',
                EVAL_CASSETTE_DIR: cassettes, EMBED_FIXTURE_DIR: emb,
                EVAL_PROBE_DIR: probeDir, EVAL_PROBE_SUITE: 'unit'
            }
        });
        assert.equal(res.status, 0, res.stderr);
        const out = JSON.parse(res.stdout);

        // 行為不變
        assert.deepEqual(out.hit, { ok: true });
        assert.ok(out.missErr.startsWith(REPLAY_MISS_PREFIX), out.missErr);
        assert.ok(out.textErr.startsWith(REPLAY_MISS_PREFIX), out.textErr);
        assert.match(out.embedErr, /查無此文本/, '查不到向量照樣丟錯，不回退成假向量');
        assert.deepEqual(out.loadMissing, [999]);
        assert.equal(out.noFile, false);

        // 紀錄
        const events = probe.readProbeDir(probeDir);
        assert.ok(events.every(e => e.suite === 'unit'));
        assert.ok(events.some(e => e.kind === 'start'));
        assert.ok(events.some(e => e.kind === 'exit' && e.code === 0));
        const llmEvents = events.filter(e => e.kind === 'llm');
        assert.equal(llmEvents.length, 3);
        assert.deepEqual(llmEvents.map(e => [e.method, e.hit]), [['generateJson', true], ['generateJson', false], ['generateText', false]]);
        assert.equal(llmEvents[0].key, hitKey);
        assert.equal(llmEvents[0].model, 'gemini-3.5-flash', '記的是裸模型 ID（與 cassette 的鍵同一個）');
        assert.match(llmEvents[1].key, /^[0-9a-f]{64}$/);
        assert.deepEqual(llmEvents[1].cacheKeyParts, { template: 'probe_test.v1', n: 2 }, 'miss 要留 cacheKeyParts，工具才找得到舊版估費用');
        const embeds = events.filter(e => e.kind === 'embed' && e.via === 'services/llm/fixture.js');
        assert.deepEqual(embeds.map(e => [e.hash, e.hit]), [[sha256Hex('甲'), true], [sha256Hex('乙'), false]]);
        const loaded = events.filter(e => e.kind === 'embed' && e.via === 'eval/lib/embeddings.js');
        assert.deepEqual(loaded.map(e => [e.questionId, e.hit]), [[999, false]]);
        assert.ok(events.some(e => e.kind === 'embed-file-missing'));
    });

    test('readProbeDir 略過壞行並標成 corrupt（不讓一行壞資料讓整個盤點失敗）', () => {
        const dir = path.join(tmp, 'corrupt');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1.jsonl'), '{"kind":"start","suite":"a"}\n{壞掉\n\n', 'utf8');
        const events = probe.readProbeDir(dir);
        assert.deepEqual(events.map(e => e.kind), ['start', 'corrupt']);
    });
});
