// config/similarityThresholds.js（〔Owner 第五輪 V5-1～V5-5、O-2 核准 2026-09-27〕docs/local-mode.md 10.16）
//
// 五個餘弦門檻的預設依向量模型（EMBED_MODEL）決定：本機（ollama:，含沒寫）用 Owner 第五輪核准的新值，
// Gemini 維持原值；.env 明寫一律優先；舊名 VARIANT_SIM_MIN 只當兩個變式門檻的退路。
// 另外釘住「全案只有這一支決定」：runner、variantService、embed:thresholds、啟動訊息讀到的都是同一組數字。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sim = require('../../config/similarityThresholds');
const runner = require('../../workers/jobRunner');
const variantService = require('../../services/variantService');

const APP_DIR = path.resolve(__dirname, '..', '..');
const LOCAL = { variantRetrieveSimMin: 0.72, variantOfftopicSimMin: 0.87, dedupDup: 0.99, dedupVariant: 0.90, knnVoteSim: 0.90 };
const GEMINI = { variantRetrieveSimMin: 0.80, variantOfftopicSimMin: 0.90, dedupDup: 0.97, dedupVariant: 0.90, knnVoteSim: 0.90 };
const pick = (r) => ({
    variantRetrieveSimMin: r.variantRetrieveSimMin, variantOfftopicSimMin: r.variantOfftopicSimMin,
    dedupDup: r.dedupDup, dedupVariant: r.dedupVariant, knnVoteSim: r.knnVoteSim
});

describe('config/similarityThresholds — 兩組預設', () => {
    test('本機：V5-1＝0.72、V5-2＝0.87（暫定）、V5-3＝0.99、V5-4 維持 0.90、O-2 維持 0.90', () => {
        assert.deepEqual({ ...sim.LOCAL_SIMILARITY_DEFAULTS }, LOCAL);
    });

    test('Gemini：原值一個都沒改（0.80／0.90／0.97／0.90／0.90）', () => {
        assert.deepEqual({ ...sim.GEMINI_SIMILARITY_DEFAULTS }, GEMINI);
    });

    test('兩組都凍結（不會被呼叫端改掉）', () => {
        assert.ok(Object.isFrozen(sim.LOCAL_SIMILARITY_DEFAULTS));
        assert.ok(Object.isFrozen(sim.GEMINI_SIMILARITY_DEFAULTS));
    });
});

describe('config/similarityThresholds — 依向量模型判斷', () => {
    test('EMBED_MODEL 沒寫、空白 → 本機預設模型 → 本機值', () => {
        for (const env of [{}, { EMBED_MODEL: '' }, { EMBED_MODEL: '   ' }]) {
            const r = sim.resolveSimilarityThresholds(env);
            assert.equal(r.mode, 'local', JSON.stringify(env));
            assert.equal(r.embedModel, 'ollama:qwen3-embedding:0.6b');
            assert.deepEqual(pick(r), LOCAL);
        }
    });

    test('ollama:（不分大小寫、前後空白）→ 本機值', () => {
        for (const m of ['ollama:qwen3-embedding:0.6b', ' OLLAMA:other-embed ', 'Ollama:x']) {
            assert.equal(sim.resolveSimilarityThresholds({ EMBED_MODEL: m }).mode, 'local', m);
            assert.equal(sim.isLocalEmbed(m), true, m);
        }
    });

    test('沒有前綴的舊值 gemini-embedding-001、明寫 gemini: → Gemini 值', () => {
        for (const m of ['gemini-embedding-001', 'gemini:gemini-embedding-001']) {
            const r = sim.resolveSimilarityThresholds({ EMBED_MODEL: m });
            assert.equal(r.mode, 'gemini', m);
            assert.deepEqual(pick(r), GEMINI, m);
            assert.equal(sim.isLocalEmbed({ EMBED_MODEL: m }), false);
        }
    });

    test('判斷看的是向量模型，不是拆題模型（拆題走 Gemini、向量走本機 → 本機值；反之 Gemini 值）', () => {
        assert.equal(sim.resolveSimilarityThresholds({ MODEL_EXTRACT: 'gemini:gemini-3.5-flash' }).mode, 'local');
        assert.equal(sim.resolveSimilarityThresholds({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', EMBED_MODEL: 'gemini-embedding-001' }).mode, 'gemini');
    });

    test('similarityDefaultsFor：給模型字串或 env 都可以', () => {
        assert.deepEqual(sim.similarityDefaultsFor('gemini-embedding-001'), { mode: 'gemini', ...GEMINI });
        assert.deepEqual(sim.similarityDefaultsFor({}), { mode: 'local', ...LOCAL });
        assert.deepEqual(sim.similarityDefaultsFor(''), { mode: 'local', ...LOCAL }, '空字串＝沒寫＝本機預設');
    });
});

describe('config/similarityThresholds — 優先順序：.env 明寫 > 舊名 VARIANT_SIM_MIN > 依模型的預設', () => {
    test('明寫的值兩種模式都照用（環境變數仍可覆寫）', () => {
        const env = {
            VARIANT_RETRIEVE_SIM_MIN: '0.81', VARIANT_OFFTOPIC_SIM_MIN: '0.91', DEDUP_DUP_THRESHOLD: '0.96',
            DEDUP_VARIANT_THRESHOLD: '0.88', KNN_VOTE_SIM: '0.93'
        };
        const want = { variantRetrieveSimMin: 0.81, variantOfftopicSimMin: 0.91, dedupDup: 0.96, dedupVariant: 0.88, knnVoteSim: 0.93 };
        for (const embed of [undefined, 'gemini-embedding-001']) {
            const r = sim.resolveSimilarityThresholds({ ...env, ...(embed ? { EMBED_MODEL: embed } : {}) });
            assert.deepEqual(pick(r), want, String(embed));
            assert.ok(Object.values(r.source).every(s => s === 'env'));
        }
    });

    test('舊名 VARIANT_SIM_MIN：只給兩個變式門檻、只在新名沒寫時；也蓋過依模型的預設', () => {
        const r = sim.resolveSimilarityThresholds({ VARIANT_SIM_MIN: '0.85' });
        assert.equal(r.variantRetrieveSimMin, 0.85);
        assert.equal(r.variantOfftopicSimMin, 0.85);
        assert.equal(r.dedupDup, 0.99, '去重不吃舊名');
        assert.equal(r.knnVoteSim, 0.90, 'kNN 不吃舊名');
        assert.deepEqual(r.source, {
            variantRetrieveSimMin: 'legacy', variantOfftopicSimMin: 'legacy', dedupDup: 'default', dedupVariant: 'default', knnVoteSim: 'default'
        });
        const both = sim.resolveSimilarityThresholds({ VARIANT_SIM_MIN: '0.85', VARIANT_OFFTOPIC_SIM_MIN: '0.92' });
        assert.equal(both.variantRetrieveSimMin, 0.85);
        assert.equal(both.variantOfftopicSimMin, 0.92);
    });

    test('亂填的數字與沒填一樣（退回依模型的預設，不會變成 NaN）', () => {
        const r = sim.resolveSimilarityThresholds({ VARIANT_RETRIEVE_SIM_MIN: 'abc', VARIANT_SIM_MIN: 'x', DEDUP_DUP_THRESHOLD: '', KNN_VOTE_SIM: 'NaN' });
        assert.deepEqual(pick(r), LOCAL);
        const g = sim.resolveSimilarityThresholds({ EMBED_MODEL: 'gemini-embedding-001', DEDUP_DUP_THRESHOLD: 'zz' });
        assert.deepEqual(pick(g), GEMINI);
    });

    test('沒給 env → 讀 process.env', () => {
        const saved = { e: process.env.EMBED_MODEL, d: process.env.DEDUP_DUP_THRESHOLD };
        try {
            delete process.env.DEDUP_DUP_THRESHOLD;
            process.env.EMBED_MODEL = 'gemini-embedding-001';
            assert.equal(sim.resolveSimilarityThresholds().dedupDup, 0.97);
            process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
            assert.equal(sim.resolveSimilarityThresholds().dedupDup, 0.99);
        } finally {
            for (const [k, v] of [['EMBED_MODEL', saved.e], ['DEDUP_DUP_THRESHOLD', saved.d]]) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
    });
});

describe('全案只有這一支決定：runner、variantService 讀到同一組數字（兩種模式）', () => {
    for (const [label, env, want] of [['本機（沒寫 EMBED_MODEL）', {}, LOCAL], ['Gemini', { EMBED_MODEL: 'gemini-embedding-001' }, GEMINI]]) {
        test(label, () => {
            const c = { ...runner.loadConfig(env), ...runner.loadStage3Config(env) };
            assert.equal(c.dedupDup, want.dedupDup);
            assert.equal(c.dedupVariant, want.dedupVariant);
            assert.equal(c.variantRetrieveSimMin, want.variantRetrieveSimMin);
            assert.equal(c.variantOfftopicSimMin, want.variantOfftopicSimMin);
            assert.equal(c.knnVoteSim, want.knnVoteSim);
            assert.equal(variantService.simMin(env), want.variantRetrieveSimMin);
        });
    }

    test('eval 的兩支（suiteVariant、pipelineDriver）不再寫死 0.97／0.80／0.90：一律經 resolver', () => {
        for (const f of ['eval/lib/suiteVariant.js', 'eval/lib/pipelineDriver.js', 'workers/jobRunner.js', 'services/variantService.js']) {
            const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
            assert.ok(/resolveSimilarityThresholds/.test(src), `${f} 沒有經 config/similarityThresholds.js`);
            assert.ok(!/DEDUP_DUP_THRESHOLD \|\| 0\.97|DEDUP_VARIANT_THRESHOLD \|\| 0\.90|KNN_VOTE_SIM \|\| 0\.90/.test(src), `${f} 還有寫死的預設`);
            assert.ok(!/num\('(DEDUP_DUP_THRESHOLD|DEDUP_VARIANT_THRESHOLD|KNN_VOTE_SIM|VARIANT_RETRIEVE_SIM_MIN|VARIANT_OFFTOPIC_SIM_MIN)'/.test(src), `${f} 還有自己讀門檻`);
        }
    });

    test('embed:thresholds 的「現行值」＝各模型實際的預設', () => {
        const tool = require('../../eval/tools/embed_threshold_report');
        const as = (d) => ({ retrieve: d.variantRetrieveSimMin, offtopic: d.variantOfftopicSimMin, dedupDup: d.dedupDup, dedupVariant: d.dedupVariant });
        const strip = ({ minEdit, ...rest }) => rest;
        assert.deepEqual(strip(tool.currentDefaults('ollama:qwen3-embedding:0.6b')), as(LOCAL));
        assert.deepEqual(strip(tool.currentDefaults('gemini-embedding-001')), as(GEMINI));
    });
});

describe('啟動訊息（jobRunner 啟動那一行）', () => {
    test('describeSimilarityThresholds：寫出模式、五個值，明寫／舊名的另外標出來', () => {
        const local = sim.describeSimilarityThresholds(sim.resolveSimilarityThresholds({}));
        assert.match(local, /^本機向量的門檻：/);
        assert.match(local, /VARIANT_RETRIEVE_SIM_MIN=0\.72、VARIANT_OFFTOPIC_SIM_MIN=0\.87、DEDUP_DUP_THRESHOLD=0\.99、DEDUP_VARIANT_THRESHOLD=0\.9、KNN_VOTE_SIM=0\.9$/);
        const g = sim.describeSimilarityThresholds(sim.resolveSimilarityThresholds({ EMBED_MODEL: 'gemini-embedding-001', DEDUP_DUP_THRESHOLD: '0.95', VARIANT_SIM_MIN: '0.8' }));
        assert.match(g, /^Gemini 向量的門檻：/);
        assert.match(g, /DEDUP_DUP_THRESHOLD=0\.95（\.env）/);
        assert.match(g, /VARIANT_RETRIEVE_SIM_MIN=0\.8（舊名 VARIANT_SIM_MIN）/);
    });

    test('runner.start() 印的那一行：本機拆題時帶拆題方式（預設 ocr 講明要交叉驗證就明寫 cross），並帶門檻', () => {
        const infos = [];
        const logger = { info: (o) => infos.push(o), warn() { }, error() { } };
        const db = { query: async () => ({ rows: [], rowCount: 0 }), pool: { connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() { } }) } };
        const saved = process.env.EMBED_MODEL;
        try {
            delete process.env.EMBED_MODEL;
            const r = runner.createRunner({ db, llm: {}, logger, config: { localExtract: true, localExtractMode: 'ocr', ocrEngine: 'paddle', pollMs: 60000 } });
            r.start();
            r.stop();
            const line = infos.find(o => o.msg === 'jobRunner 啟動');
            assert.ok(line, '沒有印啟動訊息');
            assert.match(line.local_extract_mode, /^ocr（/);
            assert.match(line.local_extract_mode, /LOCAL_EXTRACT_MODE=cross/);
            assert.match(line.thresholds, /^本機向量的門檻：/);

            infos.length = 0;
            const g = runner.createRunner({ db, llm: {}, logger, config: { localExtract: false, pollMs: 60000 } });
            g.start();
            g.stop();
            const gl = infos.find(o => o.msg === 'jobRunner 啟動');
            assert.ok(!('local_extract_mode' in gl), 'Gemini 拆題不印拆題方式');
        } finally {
            if (saved === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = saved;
        }
        assert.match(runner.startupExtractModeText('cross'), /^cross（/);
    });
});
