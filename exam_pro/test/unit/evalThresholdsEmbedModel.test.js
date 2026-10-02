// ─────────────────────────────────────────────────────────────
// test/unit/evalThresholdsEmbedModel.test.js — 依向量模型的門檻覆寫（Owner 2026-10-03 第 r14 輪 C-2；docs/local-mode.md 10.27）
//
//   variant 的 retrieved_coverage 門檻 0.8367 是用 gemini-embedding-001 的向量校準的。CI 用本機向量
//   （EMBED_MODEL=ollama:qwen3-embedding:0.6b、相似度下限 0.72）實測 0.5000；Owner 選維持 0.72（精準度優先），
//   本機向量的門檻另設 0.47（0.5000 − 0.03）。
//   ① eval/thresholds.json 的 variant.by_embed_model：依 suite 實際用的向量模型挑門檻組（eval/lib/thresholds.js 的 resolveSuiteThresholds）。
//      本機模型 → 0.47；gemini-embedding-001 → 0.8367；對不上的模型 → 基準門檻。gate_pass_rate（0.22）兩種都一樣。
//   ② run.js／回放驗證表／報表都說明套用哪一組、為什麼；--write-baseline 的 ratchet 寫回那一組，不動另一種向量的門檻。
// 不連 DB、不呼叫模型。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const th = require('../../eval/lib/thresholds');
const report2 = require('../../eval/lib/report2');
const { thresholdRows } = require('../../eval/lib/cassettePlan');
const { embedModelFromEnv } = require('../../eval/lib/localMode');
const sim = require('../../config/similarityThresholds');

const APP = path.resolve(__dirname, '..', '..');
const THRESHOLDS_FILE = path.join(APP, 'eval', 'thresholds.json');
const FILE = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));

const LOCAL = 'ollama:qwen3-embedding:0.6b';
const GEMINI = 'gemini-embedding-001';

const variantMeasured = (coverage, gate = 0.45) => ({ variant: { retrieved_coverage: coverage, gate_pass_rate: gate } });

describe('resolveSuiteThresholds：依向量模型挑門檻組', () => {
    test('本機模型 → retrieved_coverage 0.47；gate_pass_rate 照基準 0.22；說明套用哪一組、為什麼', () => {
        const r = th.resolveSuiteThresholds(FILE, 'variant', { embedModel: LOCAL });
        assert.deepEqual(r.table.variant.variant, { retrieved_coverage: 0.47, gate_pass_rate: 0.22 });
        assert.equal(r.profile.applied, true);
        assert.equal(r.profile.key, LOCAL);
        assert.equal(r.profile.embedModel, LOCAL);
        assert.deepEqual(r.profile.overrides, [{ metric: 'variant.retrieved_coverage', base: 0.8367, value: 0.47 }]);
        assert.match(r.profile.reason, /^向量模型 ollama:qwen3-embedding:0\.6b 套用專屬門檻（thresholds\.json 的 variant\.by_embed_model\["ollama:qwen3-embedding:0\.6b"\]）：variant\.retrieved_coverage 0\.8367 → 0\.47；其餘指標照基準門檻；Owner 2026-10-03 第 r14 輪 C-2/);
        // 不改到傳進來的那一份
        assert.equal(FILE.variant.variant.retrieved_coverage, 0.8367);
    });

    test('gemini-embedding-001 → 基準門檻 0.8367（不變）', () => {
        const r = th.resolveSuiteThresholds(FILE, 'variant', { embedModel: GEMINI });
        assert.deepEqual(r.table.variant.variant, { retrieved_coverage: 0.8367, gate_pass_rate: 0.22 });
        assert.equal(r.profile.applied, false);
        assert.equal(r.profile.key, null);
        assert.match(r.profile.reason, /^向量模型 gemini-embedding-001 沒有專屬門檻，套用基準門檻（thresholds\.json 的 variant\.variant）/);
    });

    test('對不上的模型 → 基準門檻；沒記錄向量模型 → 基準門檻並說明', () => {
        for (const m of ['ollama:nomic-embed-text', 'ollama:qwen3-embedding:4b', 'gemini:gemini-embedding-001']) {
            const r = th.resolveSuiteThresholds(FILE, 'variant', { embedModel: m });
            assert.equal(r.table.variant.variant.retrieved_coverage, 0.8367, m);
            assert.equal(r.profile.applied, false, m);
        }
        for (const ctx of [{}, { embedModel: null }, { embedModel: '   ' }, undefined]) {
            const r = th.resolveSuiteThresholds(FILE, 'variant', ctx);
            assert.equal(r.table.variant.variant.retrieved_coverage, 0.8367);
            assert.equal(r.profile.embedModel, null);
            assert.match(r.profile.reason, /^這一輪沒有記錄向量模型，套用基準門檻/);
        }
    });

    test('模型字串比對：前後空白不算、大小寫不分', () => {
        const r = th.resolveSuiteThresholds(FILE, 'variant', { embedModel: '  OLLAMA:Qwen3-Embedding:0.6B ' });
        assert.equal(r.table.variant.variant.retrieved_coverage, 0.47);
        assert.equal(r.profile.key, LOCAL);
    });

    test('沒有 by_embed_model 的 suite：profile 是 null、門檻表原封不動（與改版前相同）', () => {
        for (const suite of ['retrieval', 'classify', 'pipeline', 'nlq']) {
            const r = th.resolveSuiteThresholds(FILE, suite, { embedModel: LOCAL });
            assert.equal(r.profile, null, suite);
            assert.equal(r.table, FILE, suite);
        }
        assert.throws(() => th.resolveSuiteThresholds(FILE, 'nope', {}), /未知的 suite/);
    });

    test('覆寫拼錯（欄、指標、值）直接丟錯，不讓一組打錯字的覆寫靜默失效', () => {
        const withBy = (by) => ({ variant: { variant: { retrieved_coverage: 0.8, gate_pass_rate: 0.2 }, by_embed_model: by } });
        assert.throws(() => th.resolveSuiteThresholds(withBy({ [LOCAL]: { variant: { retrieved_coverag: 0.4 } } }), 'variant', { embedModel: LOCAL }), /不在 SUITE_METRICS\.variant\.metrics/);
        assert.throws(() => th.resolveSuiteThresholds(withBy({ [LOCAL]: { varient: { retrieved_coverage: 0.4 } } }), 'variant', { embedModel: LOCAL }), /不在 SUITE_METRICS\.variant\.columns/);
        assert.throws(() => th.resolveSuiteThresholds(withBy({ [LOCAL]: { variant: { retrieved_coverage: '0.4' } } }), 'variant', { embedModel: LOCAL }), /必須是數字或 null/);
        assert.throws(() => th.resolveSuiteThresholds(withBy([]), 'variant', { embedModel: LOCAL }), /必須是物件/);
        // 底線開頭的鍵是說明，不算模型
        const ok = th.resolveSuiteThresholds(withBy({ _note: 'x', [LOCAL]: { _note: 'y', variant: { retrieved_coverage: 0.4 } } }), 'variant', { embedModel: '_note' });
        assert.equal(ok.profile.applied, false);
    });
});

describe('compareSuite／thresholdRows：照向量模型比', () => {
    test('本機向量 0.5000：≥ 0.47 通過；回報 profile', () => {
        const r = th.compareSuite(FILE, 'variant', variantMeasured(0.5), { embedModel: LOCAL });
        assert.deepEqual(r.failures, []);
        assert.equal(r.checked, 2);
        assert.equal(r.profile.applied, true);
    });

    test('本機向量 0.46 未達 0.47；gate_pass_rate 仍比 0.22', () => {
        assert.deepEqual(th.compareSuite(FILE, 'variant', variantMeasured(0.46), { embedModel: LOCAL }).failures,
            ['variant.retrieved_coverage：0.4600 < 門檻 0.47']);
        assert.deepEqual(th.compareSuite(FILE, 'variant', variantMeasured(0.5, 0.21), { embedModel: LOCAL }).failures,
            ['variant.gate_pass_rate：0.2100 < 門檻 0.22']);
        assert.deepEqual(th.compareSuite(FILE, 'variant', variantMeasured(null), { embedModel: LOCAL }).failures,
            ['variant.retrieved_coverage：門檻 0.47 但這次是 n/a']);
    });

    test('gemini-embedding-001、對不上的模型、沒給模型：照基準 0.8367（0.5000 未達）', () => {
        for (const opts of [{ embedModel: GEMINI }, { embedModel: 'ollama:nomic-embed-text' }, {}]) {
            assert.deepEqual(th.compareSuite(FILE, 'variant', variantMeasured(0.5), opts).failures,
                ['variant.retrieved_coverage：0.5000 < 門檻 0.8367'], JSON.stringify(opts));
        }
        assert.deepEqual(th.compareSuite(FILE, 'variant', variantMeasured(0.84), { embedModel: GEMINI }).failures, []);
    });

    test('沒有 by_embed_model 的 suite：compareSuite 的 profile 是 null', () => {
        const r = th.compareSuite(FILE, 'classify', { classify: { accuracy: 0.9, macro_f1: 0.9 } }, { embedModel: LOCAL });
        assert.equal(r.profile, null);
        assert.deepEqual(r.failures, []);
    });

    test('回放驗證表（thresholdRows）照報表 meta.embedModel 挑門檻；舊報表沒有這一欄＝基準門檻', () => {
        const doc = (meta) => ({ suite: 'variant', meta, measured: variantMeasured(0.5) });
        const local = thresholdRows(doc({ embedModel: LOCAL }), FILE);
        assert.deepEqual(local.failures, []);
        assert.equal(local.rows.find(r => r.metric === 'variant.retrieved_coverage').threshold, 0.47);
        assert.equal(local.profile.applied, true);
        const old = thresholdRows(doc({}), FILE);
        assert.deepEqual(old.failures, ['variant.retrieved_coverage：0.5000 < 門檻 0.8367']);
        assert.equal(old.rows.find(r => r.metric === 'variant.retrieved_coverage').threshold, 0.8367);
        assert.equal(old.rows.find(r => r.metric === 'variant.retrieved_coverage').ok, false);
    });
});

describe('thresholds.json：數字與來源說明', () => {
    test('基準門檻不動；本機向量只覆寫 retrieved_coverage＝0.47（首次實測 0.5000 − 0.03）', () => {
        assert.deepEqual(FILE.variant.variant, { retrieved_coverage: 0.8367, gate_pass_rate: 0.22 });
        const by = FILE.variant.by_embed_model;
        assert.deepEqual(Object.keys(by).filter(k => !k.startsWith('_')), [LOCAL], '目前只有本機向量一組；gemini-embedding-001 用基準門檻');
        assert.deepEqual(by[LOCAL].variant, { retrieved_coverage: 0.47 });
        assert.equal(Math.round((0.5 - th.BASELINE_MARGIN) * 10000) / 10000, by[LOCAL].variant.retrieved_coverage);
        assert.equal(typeof by._note, 'string');
        assert.match(by[LOCAL]._note, /Owner 2026-10-03 第 r14 輪 C-2.*0\.72/);
    });

    test('_note_by_embed_model 寫清楚決定、量測與精準度的取捨', () => {
        const note = FILE.variant._note_by_embed_model;
        assert.equal(typeof note, 'string', 'variant 節要有 _note_by_embed_model');
        for (const s of ['Owner 2026-10-03', '第 r14 輪 C-2', 'gemini-embedding-001', '0.8367', LOCAL, '0.72', '0.5000', '− 0.03', '0.47',
            '只升不降', '精準度', '0.65→0.73／51%', '0.55→0.83／33%', '擴充題庫', 'gate_pass_rate']) {
            assert.ok(note.includes(s), `來源說明沒寫到 ${s}`);
        }
    });

    test('_variant_measured_with：基準那一份記 gemini-embedding-001；本機那一份記在 byEmbedModel 底下且與現況一致', () => {
        const mw = FILE._variant_measured_with;
        assert.equal(mw.embedModel, GEMINI);
        assert.equal(mw.embeddings, 'eval/fixtures/embeddings.gemini-embedding-001.768.json');
        assert.equal(mw.variantRetrieveSimMin, 0.8);
        const local = mw.byEmbedModel[LOCAL];
        assert.ok(local, '_variant_measured_with.byEmbedModel 要記本機向量的量測環境');
        assert.equal(local.embedModel, LOCAL);
        assert.equal(local.retrievedCoverage, 0.5);
        // 量測時的相似度下限＝現在本機的預設（config/similarityThresholds.js，Owner V5-5）；向量檔真的在 repo 裡
        const defaults = sim.similarityDefaultsFor(LOCAL);
        assert.equal(local.variantRetrieveSimMin, defaults.variantRetrieveSimMin);
        assert.equal(local.variantOfftopicSimMin, defaults.variantOfftopicSimMin);
        assert.ok(fs.existsSync(path.join(APP, local.embeddings)), local.embeddings);
    });

    test('覆寫的模型字串就是「沒設 EMBED_MODEL 時」suite 實際用的本機預設（兩支 resolver 一致）', () => {
        assert.equal(embedModelFromEnv({}), LOCAL);
        assert.equal(sim.embedModelOf({}), LOCAL);
        assert.equal(sim.isLocalEmbed(LOCAL), true);
        assert.equal(th.resolveSuiteThresholds(FILE, 'variant', { embedModel: embedModelFromEnv({}) }).profile.applied, true);
        // 其他 suite 的門檻一個數字都沒動
        assert.deepEqual(FILE.classify.classify, { accuracy: 0.87, macro_f1: 0.8956 });
        assert.deepEqual(FILE.nlq.rules, { rule_coverage: 0.81, filters_exact: 0.97, recall10: 0.97 });
        assert.deepEqual(FILE.nlq.llm, { rule_coverage: null, filters_exact: 0.72, recall10: 0.845 });
    });
});

describe('writeBaselineSuite：ratchet 寫回那一組，不動另一種向量的門檻', () => {
    let tmp;
    let file;
    before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-thresholds-')); });
    after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    const fresh = () => { file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.json`); fs.copyFileSync(THRESHOLDS_FILE, file); return file; };
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

    test('本機向量量到 0.60：覆寫 0.47 → 0.57，基準 0.8367 不動；meta 記在 byEmbedModel 底下', () => {
        const w = th.writeBaselineSuite({ suite: 'variant', file: fresh(), measured: variantMeasured(0.6, 0.45), meta: { embedModel: LOCAL, x: 1 }, embedModel: LOCAL });
        assert.ok(w.changes.includes('variant.by_embed_model["ollama:qwen3-embedding:0.6b"].variant.retrieved_coverage：0.47 → 0.57（ratchet 調高）'), w.changes.join('；'));
        assert.ok(w.changes.includes('variant.variant.gate_pass_rate：0.22 → 0.42（ratchet 調高）'), w.changes.join('；'));
        const doc = read();
        assert.equal(doc.variant.variant.retrieved_coverage, 0.8367);
        assert.equal(doc.variant.by_embed_model[LOCAL].variant.retrieved_coverage, 0.57);
        assert.equal(doc.variant.by_embed_model[LOCAL]._note, FILE.variant.by_embed_model[LOCAL]._note);
        assert.deepEqual(doc._variant_measured_with.byEmbedModel[LOCAL], { embedModel: LOCAL, x: 1 });
        assert.equal(doc._variant_measured_with.embedModel, GEMINI, '基準門檻的量測環境不動');
    });

    test('本機向量量到 0.40：覆寫維持 0.47（只升不降）', () => {
        const w = th.writeBaselineSuite({ suite: 'variant', file: fresh(), measured: variantMeasured(0.4, 0.1), embedModel: LOCAL });
        assert.equal(w.written, false);
        assert.ok(w.kept.some(k => k.startsWith('variant.by_embed_model["ollama:qwen3-embedding:0.6b"].variant.retrieved_coverage：維持 0.47')), w.kept.join('；'));
        assert.equal(read().variant.by_embed_model[LOCAL].variant.retrieved_coverage, 0.47);
    });

    test('Gemini 向量量到 0.90：基準 0.8367 → 0.87，本機覆寫不動；byEmbedModel 的量測環境保留', () => {
        th.writeBaselineSuite({ suite: 'variant', file: fresh(), measured: variantMeasured(0.9, 0.2), meta: { embedModel: GEMINI }, embedModel: GEMINI });
        const doc = read();
        assert.equal(doc.variant.variant.retrieved_coverage, 0.87);
        assert.equal(doc.variant.by_embed_model[LOCAL].variant.retrieved_coverage, 0.47);
        assert.equal(doc._variant_measured_with.embedModel, GEMINI);
        assert.deepEqual(doc._variant_measured_with.byEmbedModel, FILE._variant_measured_with.byEmbedModel);
    });
});

describe('報表：說明這一輪套哪一組門檻', () => {
    let tmp;
    before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-report-')); });
    after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    const res = (embedModel) => ({
        suite: 'variant', measured: variantMeasured(0.5), failures: [], warnings: [], perEntry: [],
        meta: { golden: 'eval/golden/variant.json', goldenPending: 0, sources: {}, cassetteDir: 'eval/cassettes', ...(embedModel ? { embedModel } : {}) }
    });

    test('Markdown：本機向量印「套用專屬門檻」；Gemini 印「套用基準門檻」', () => {
        assert.match(report2.markdownGeneric(res(LOCAL)), /- 門檻組：向量模型 ollama:qwen3-embedding:0\.6b 套用專屬門檻.*0\.8367 → 0\.47/);
        assert.match(report2.markdownGeneric(res(GEMINI)), /- 門檻組：向量模型 gemini-embedding-001 沒有專屬門檻，套用基準門檻/);
    });

    test('Markdown：沒有 by_embed_model 的 suite 不印門檻組（與改版前相同）', () => {
        const nlq = { suite: 'nlq', measured: { rules: null, llm: null }, meta: { embedModel: LOCAL } };
        assert.doesNotMatch(report2.markdownGeneric(nlq), /門檻組/);
    });

    test('報表 JSON：threshold_profile 記套用哪一組；thresholdRows 照它比', () => {
        const origLog = console.log;
        let emitted;
        try { console.log = () => {}; emitted = report2.emit({ res: res(LOCAL), dir: tmp }); } finally { console.log = origLog; }
        const doc = JSON.parse(fs.readFileSync(emitted.file, 'utf8'));
        assert.equal(doc.meta.embedModel, LOCAL);
        assert.equal(doc.threshold_profile.applied, true);
        assert.equal(doc.threshold_profile.key, LOCAL);
        assert.deepEqual(thresholdRows(doc, FILE).failures, []);
    });
});

describe('suite 與 run.js 的接線', () => {
    test('suiteVariant 在 meta 記實際讀的向量模型（loadEmbeddings 的 model）', () => {
        const src = fs.readFileSync(path.join(APP, 'eval', 'lib', 'suiteVariant.js'), 'utf8');
        assert.match(src, /embedModel: emb\.model,/);
    });

    test('run.js 比門檻與寫 ratchet 都帶 res.meta.embedModel，並印門檻組', () => {
        const src = fs.readFileSync(path.join(APP, 'eval', 'run.js'), 'utf8');
        assert.match(src, /writeBaselineSuite\(\{ suite: res\.suite, measured: res\.measured, meta: res\.meta, embedModel: res\.meta && res\.meta\.embedModel \}\)/);
        assert.match(src, /notApplicable: res\.notApplicable, embedModel: res\.meta && res\.meta\.embedModel \}/);
        assert.match(src, /if \(cmp\.profile\) console\.log\(`門檻組：\$\{cmp\.profile\.reason\}`\);/);
    });
});
