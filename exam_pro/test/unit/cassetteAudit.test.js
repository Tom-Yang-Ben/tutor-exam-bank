// ─────────────────────────────────────────────────────────────
// test/unit/cassetteAudit.test.js — cassette 盤點、鍵的靜態稽核、重錄的計數與費用估計
// （eval/lib/cassetteAudit.js；docs/chapter-restructure.md 第 3.2 條第 2、3 點）
//
// 重點是 dry-run 的**計數邏輯**，而且要以「CH-A 合入後」的 schema 為準：
// 測試把兩份章節白名單都**注入**——重整前（config/chapterPlan.js 的 MIGRATION 的鍵）錄 cassette，
// 重整後（PLAN_CHAPTERS）重算鍵、產生探針紀錄——模擬章節白名單換掉之後哪些鍵會失效、哪些呼叫會變成 miss。
// 不依賴本分支的 config/chapters.js 是新是舊：CH-A 合入前後這支測試的結果都一樣。
// 全部在暫存目錄裡造 cassette，不讀也不改 repo 的 eval/cassettes/；不連網、不連 DB。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('../../eval/lib/cassetteAudit');
const { plannedChapters } = require('../../eval/lib/chapterGate');
const { MIGRATION } = require('../../config/chapterPlan');
const { cassetteKey } = require('../../services/llm/cassette');
const { buildSchema } = require('../../agents/schemas');
const { estimateCost } = require('../../config/pricing');
const { CHAPTERS } = require('../../config/chapters');
const classifyAgent = require('../../agents/classify');
const lintAgent = require('../../agents/lint');
const verifyAgent = require('../../agents/verify');
const extractAgent = require('../../agents/extract');

const PLAN = plannedChapters();
/** 重整前的數學／物理白名單＝MIGRATION 的鍵（舊章名全在這裡） */
const OLD = { 數學: Object.keys(MIGRATION['數學']), 物理: Object.keys(MIGRATION['物理']) };
const MODEL = 'gemini-3.5-flash';
const VERIFY_MODEL = 'gemini-3.1-pro-preview';
const USAGE = { tokenIn: 1000, tokenOut: 100, tokenThinking: 400, tokenCached: 0 };

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cassette-audit-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * 在 dir 底下寫一支 cassette，鍵依給定的 schema 算（與 services/llm 錄製時同一條公式）。
 * @returns {{agent:string, key:string, file:string}}
 */
function writeCassette(dir, { agent, model = MODEL, template, schema, cacheKeyParts, usage = USAGE }) {
    const key = cassetteKey({ agent, modelId: model, template, schema, cacheKeyParts });
    const file = path.join(dir, agent, `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        meta: { agent, model, template, recorded_at: '2026-09-01T00:00:00.000Z' },
        request: { parts: [], cacheKeyParts },
        response: { data: {}, usage }
    }), 'utf8');
    return { agent, key, file };
}

describe('inventory：範圍內六個 agent，化學與 tutor／voice 不碰', () => {
    test('只盤點 extract／classify／lint／verify／nlq／variant；*_chem、tutor、voice、未知目錄列在 skipped', () => {
        const dir = path.join(tmp, 'inv');
        writeCassette(dir, { agent: 'classify', template: 'classify.v1', schema: {}, cacheKeyParts: { a: 1 } });
        writeCassette(dir, { agent: 'lint', template: 'lint.v2', schema: {}, cacheKeyParts: { a: 2 } });
        for (const other of ['classify_chem', 'tutor', 'voice', 'assistant']) {
            writeCassette(dir, { agent: other, template: 'x', schema: {}, cacheKeyParts: { other } });
        }
        fs.mkdirSync(path.join(dir, 'verify'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'verify', `${'a'.repeat(64)}.json`), '{ 壞掉', 'utf8');

        const inv = audit.inventory(dir);
        assert.deepEqual(inv.entries.map(e => e.agent).sort(), ['classify', 'lint', 'verify']);
        const bad = inv.entries.find(e => e.agent === 'verify');
        assert.match(bad.error, /不是合法 JSON/);
        const skipped = Object.fromEntries(inv.skipped.map(s => [s.name, s.reason]));
        assert.match(skipped.classify_chem, /化學/);
        assert.match(skipped.tutor, /tutor／voice/);
        assert.match(skipped.voice, /tutor／voice/);
        assert.match(skipped.assistant, /一律不碰/);
        const classify = inv.entries.find(e => e.agent === 'classify');
        assert.deepEqual(classify.cacheKeyParts, { a: 1 });
        assert.deepEqual(classify.usage, USAGE);
        assert.equal(classify.model, MODEL);
    });

    test('目錄不存在時回空盤點（不是錯誤）', () => {
        const inv = audit.inventory(path.join(tmp, 'nope'));
        assert.deepEqual(inv.entries, []);
        assert.deepEqual(inv.skipped, []);
    });
});

describe('schemaFor／auditKeys：以注入的章節白名單重算鍵', () => {
    test('不注入時與 agents/schemas 的 buildSchema() 逐字相同（schemaHash 才對得上）', () => {
        for (const name of ['extract', 'classify', 'lint', 'verify', 'nlq', 'variant']) {
            assert.equal(JSON.stringify(audit.schemaFor(name)), JSON.stringify(buildSchema(name)), name);
        }
    });

    test('換白名單時只有帶章節 enum 的四個 schema 會變（extract／classify／nlq／variant），lint／verify 不變', () => {
        for (const name of ['extract', 'classify', 'nlq', 'variant']) {
            assert.notEqual(JSON.stringify(audit.schemaFor(name, PLAN)), JSON.stringify(audit.schemaFor(name, OLD)), name);
        }
        for (const name of ['lint', 'verify']) {
            assert.equal(JSON.stringify(audit.schemaFor(name, PLAN)), JSON.stringify(audit.schemaFor(name, OLD)), name);
        }
        const chapterEnum = audit.schemaFor('classify', PLAN).properties.chapter.enum;
        assert.equal(chapterEnum.length, PLAN['數學'].length + PLAN['物理'].length, '數學＋物理（CH-A 合入後 52＋34）');
        assert.ok(chapterEnum.includes('廣義角與極坐標') && !chapterEnum.includes('三角函數的定義'));
        // 注入與現行一樣的清單＝不變
        assert.equal(JSON.stringify(audit.schemaFor('classify', { 數學: CHAPTERS['數學'], 物理: CHAPTERS['物理'] })),
            JSON.stringify(buildSchema('classify')));
    });

    test('模擬 CH-A 合入後：舊白名單錄的 classify／extract 鍵全部失效，lint／verify 仍有效', () => {
        const dir = path.join(tmp, 'audit');
        writeCassette(dir, { agent: 'classify', template: classifyAgent.TEMPLATE, schema: audit.schemaFor('classify', OLD),
            cacheKeyParts: { template: classifyAgent.TEMPLATE, questionText: 'q1', fewShotIds: [] } });
        writeCassette(dir, { agent: 'extract', template: extractAgent.TEMPLATE, schema: audit.schemaFor('extract', OLD),
            cacheKeyParts: { template: extractAgent.TEMPLATE, chunkNo: 1, pdfSha256: 'f'.repeat(64) } });
        writeCassette(dir, { agent: 'lint', template: lintAgent.TEMPLATE, schema: audit.schemaFor('lint', OLD),
            cacheKeyParts: { template: lintAgent.TEMPLATE, questionText: 'q', answerText: 'a', issues: [] } });
        writeCassette(dir, { agent: 'verify', model: VERIFY_MODEL, template: verifyAgent.TEMPLATE, schema: audit.schemaFor('verify', OLD),
            cacheKeyParts: { template: verifyAgent.TEMPLATE, questionText: 'q', questionType: '計算', sampleNo: 1 } });

        const entries = audit.inventory(dir).entries;
        const now = audit.auditKeys(entries, { chapters: OLD });
        assert.ok(now.every(e => e.keyValid), '以舊白名單錄的鍵，用舊白名單重算一定相同');

        const planned = Object.fromEntries(audit.auditKeys(entries, { chapters: PLAN }).map(e => [e.agent, e.keyValid]));
        assert.deepEqual(planned, { classify: false, extract: false, lint: true, verify: true });
    });

    test('模型或模板換了，鍵同樣失效（schema 之外的兩個成分）', () => {
        const dir = path.join(tmp, 'audit2');
        const { file } = writeCassette(dir, { agent: 'lint', template: lintAgent.TEMPLATE, schema: buildSchema('lint'),
            cacheKeyParts: { template: lintAgent.TEMPLATE, questionText: 'q', answerText: 'a', issues: [] } });
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.meta.model = 'gemini-2.5-flash';   // 檔名的鍵是用 3.5 算的
        fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
        assert.equal(audit.auditKeys(audit.inventory(dir).entries)[0].keyValid, false);
    });
});

describe('summarize：每個 suite 的命中／缺／錄製時呼叫次數與費用', () => {
    /**
     * 造一個小世界：cassette 以重整前的白名單錄；探針紀錄是「CH-A 合入後」會發生的呼叫
     * （classify 的鍵用注入新清單的 schema 算）。
     */
    function world() {
        const dir = path.join(tmp, `world-${Math.random().toString(16).slice(2)}`);
        const partsQ1 = { template: classifyAgent.TEMPLATE, questionText: 'q1', fewShotIds: [] };
        const partsQ2 = { template: classifyAgent.TEMPLATE, questionText: 'q2', fewShotIds: [] };
        const oldQ1 = writeCassette(dir, { agent: 'classify', template: classifyAgent.TEMPLATE, schema: audit.schemaFor('classify', OLD), cacheKeyParts: partsQ1 });
        writeCassette(dir, { agent: 'classify', template: classifyAgent.TEMPLATE, schema: audit.schemaFor('classify', OLD), cacheKeyParts: partsQ2,
            usage: { tokenIn: 3000, tokenOut: 300, tokenThinking: 0, tokenCached: 0 } });
        const lint = writeCassette(dir, { agent: 'lint', template: lintAgent.TEMPLATE, schema: audit.schemaFor('lint', OLD),
            cacheKeyParts: { template: lintAgent.TEMPLATE, questionText: 'q', answerText: 'a', issues: [] } });
        const verifyOrphan = writeCassette(dir, { agent: 'verify', model: VERIFY_MODEL, template: verifyAgent.TEMPLATE, schema: audit.schemaFor('verify', OLD),
            cacheKeyParts: { template: verifyAgent.TEMPLATE, questionText: 'old', questionType: '計算', sampleNo: 1 } });

        const newQ1Key = cassetteKey({ agent: 'classify', modelId: MODEL, template: classifyAgent.TEMPLATE,
            schema: audit.schemaFor('classify', PLAN), cacheKeyParts: partsQ1 });
        const newQ3Key = cassetteKey({ agent: 'classify', modelId: MODEL, template: classifyAgent.TEMPLATE,
            schema: audit.schemaFor('classify', PLAN), cacheKeyParts: { ...partsQ1, questionText: 'q3（改寫後的新題）' } });
        const extractKey = 'e'.repeat(64);

        const ev = (suite, extra) => ({ suite, pid: 1, ...extra });
        const events = [
            ev('retrieval', { kind: 'start' }),
            ev('retrieval', { kind: 'embed', hash: 'h1', hit: false, chars: 30 }),
            ev('retrieval', { kind: 'embed', hash: 'h2', hit: true, chars: 30 }),
            ev('classify', { kind: 'start' }),
            // 同一個 miss 出現兩次只算一次（distinct 鍵）
            ev('classify', { kind: 'llm', agent: 'classify', model: MODEL, key: newQ1Key, hit: false, cacheKeyParts: partsQ1 }),
            ev('classify', { kind: 'llm', agent: 'classify', model: MODEL, key: newQ1Key, hit: false, cacheKeyParts: partsQ1 }),
            ev('classify', { kind: 'llm', agent: 'classify', model: MODEL, key: newQ3Key, hit: false, cacheKeyParts: { ...partsQ1, questionText: 'q3（改寫後的新題）' } }),
            ev('classify', { kind: 'llm', agent: 'classify', model: MODEL, key: null, hit: false, error: 'cassette 格式錯誤' }),
            ev('pipeline', { kind: 'start' }),
            ev('pipeline', { kind: 'llm', agent: 'extract', model: MODEL, key: extractKey, hit: false, cacheKeyParts: { chunkNo: 1 } }),
            ev('variant', { kind: 'start' }),
            ev('variant', { kind: 'embed', hash: 'h1', hit: false, chars: 30 }),
            ev('e2e', { kind: 'start' }),
            ev('e2e', { kind: 'llm', agent: 'extract', model: MODEL, key: extractKey, hit: false, cacheKeyParts: { chunkNo: 1 } }),
            ev('e2e', { kind: 'llm', agent: 'lint', model: MODEL, key: lint.key, hit: true }),
            ev('e2e', { kind: 'embed', hash: 'h9', hit: false, chars: 50 })
        ];
        const entries = audit.auditKeys(audit.inventory(dir).entries, { chapters: PLAN });
        return { dir, events, entries, oldQ1, lint, verifyOrphan, newQ1Key, newQ3Key, extractKey };
    }

    test('各 suite 的 distinct 命中／缺、下游被擋、e2e 由 pipeline 順帶錄', () => {
        const w = world();
        const s = audit.summarize({
            events: w.events, entries: w.entries,
            suites: ['retrieval', 'classify', 'pipeline', 'variant', 'e2e'],
            runs: { retrieval: { exitCode: 1 }, classify: { exitCode: 1 }, pipeline: { exitCode: 1 }, variant: { exitCode: 1 }, e2e: { exitCode: 1 } },
            extraEmbedGaps: [{ id: 'nlq-003', hash: 'q-nlq', chars: 7 }]
        });
        const c = s.suites.classify;
        assert.equal(c.misses, 2, '同一個 miss 重複出現只算一次');
        assert.equal(c.hits, 0);
        assert.equal(c.llmCalls, 2, 'LLM_MODE=record 會把 suite 的每一次呼叫都真的打一次');
        assert.equal(c.missesWithPreviousVersion, 1, 'q1 找得到同 cacheKeyParts 的舊版；q3 是新題');
        assert.equal(c.blocked, true);
        assert.deepEqual(c.errors, ['classify：cassette 格式錯誤']);

        assert.equal(s.suites.retrieval.blocked, false, 'retrieval 不呼叫 LLM，缺向量不算擋住下游');
        assert.equal(s.suites.retrieval.embed.misses, 1);
        assert.equal(s.suites.variant.blocked, true, 'variant 缺向量就在量測前停下');
        assert.equal(s.suites.variant.llmCalls, 0);
        assert.equal(s.suites.e2e.embed.tolerated, true, 'e2e 存題時的向量查不到只記 log');

        assert.deepEqual(s.e2eOnly, [`lint/${w.lint.key}`], 'pipeline 沒碰到的 e2e 鍵要列出來');

        // cassette：4 支；被讀到 1（lint）；舊版 1（q1）；下游或孤兒 2（q2、verify）
        assert.deepEqual(s.cassettes, { total: 4, hit: 1, unhit: 3, unhitKeyInvalid: 2, previousVersions: 1, downstreamOrOrphan: 2 });
        const unhit = Object.fromEntries(s.unhit.map(u => [u.key, u]));
        assert.equal(unhit[w.oldQ1.key].previousVersion, true);
        assert.equal(unhit[w.oldQ1.key].keyValid, false, '注入新清單後舊 classify 鍵失效');
        assert.equal(unhit[w.verifyOrphan.key].keyValid, true, 'verify 的鍵不含章名，仍有效——只是這一輪沒被讀到');

        // 向量：h1 在 retrieval 與 variant 都缺只算一次；e2e 的 h9 容忍不計；加上 nlq 的靜態缺口
        assert.equal(s.embeddings.missing, 2);
        assert.equal(s.embeddings.chars, 37);

        // 呼叫次數：下限＝非 e2e 的 suite 看得到的呼叫（classify 2 + pipeline 1）；上限再加下游或孤兒 2
        assert.equal(s.estimate.callsLower, 3);
        assert.equal(s.estimate.callsUpper, 5);
    });

    test('費用：有舊版就用舊版的 token 數，沒有就用同 agent 的平均（config/pricing.js）', () => {
        const w = world();
        const s = audit.summarize({ events: w.events, entries: w.entries, suites: ['classify'] });
        const avg = audit.averageUsage(w.entries, 'classify');
        assert.deepEqual(avg, { tokenIn: 2000, tokenOut: 200, tokenThinking: 200, tokenCached: 0 });
        const expected = estimateCost({ modelId: MODEL, ...USAGE }).cost_usd + estimateCost({ modelId: MODEL, ...avg }).cost_usd;
        assert.ok(Math.abs(s.suites.classify.estCostUsd - expected) < 1e-6, `${s.suites.classify.estCostUsd} vs ${expected}`);
        assert.equal(s.suites.classify.costEstimated, true);
        assert.ok(expected > 0, 'config/pricing.js 的 gemini-3.5-flash 已查證，費用不該是 0');
    });

    test('完全命中的一輪：沒有 miss、沒有被擋、下限＝上限', () => {
        const w = world();
        const events = [
            { suite: 'e2e', kind: 'start' },
            { suite: 'e2e', kind: 'llm', agent: 'lint', model: MODEL, key: w.lint.key, hit: true }
        ];
        const entries = w.entries.filter(e => e.agent === 'lint');
        const s = audit.summarize({ events, entries, suites: ['e2e'] });
        assert.equal(s.suites.e2e.misses, 0);
        assert.equal(s.suites.e2e.blocked, false);
        assert.equal(s.cassettes.unhit, 0);
        assert.equal(s.estimate.callsLower, s.estimate.callsUpper);
    });

    test('embedCost 以字元數當 token 數估，gemini-embedding-001 的單價', () => {
        assert.equal(audit.embedCost(0), 0);
        assert.ok(audit.embedCost(1_000_000) > 0);
    });
});
