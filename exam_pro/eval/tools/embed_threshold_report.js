// ─────────────────────────────────────────────────────────────
// eval/tools/embed_threshold_report.js — 三個餘弦門檻的分布報告（npm run embed:thresholds；說明在 docs/local-mode.md 10.12）
//
// 〔Owner 決策單 2026-09-26 第四輪 V5〕換成本機 embedding 之後，照 docs/variants.md 第 3 節「當初依 Gemini 分布定門檻」
// 的同一套方法重算一次，給 Owner 決定 VARIANT_RETRIEVE_SIM_MIN、VARIANT_OFFTOPIC_SIM_MIN、DEDUP_DUP_THRESHOLD
// （另附 DEDUP_VARIANT_THRESHOLD）要不要改。**本工具不改任何門檻**：只讀檔、印 Markdown。
//
//   npm run embed:thresholds                                  本機向量（EMBED_MODEL，沒設時是 ollama:qwen3-embedding:0.6b）對照 Gemini
//   npm run embed:thresholds -- --out data/local_ai/embed_thresholds.md
//   npm run embed:thresholds -- --compare none                只看本機、不對照
//
// 只讀既有檔案：不呼叫任何模型、不連網、不碰資料庫、不改 .env 或任何設定。
//
// 資料來源（全部是 repo 裡已錄好的）：
//   - eval/fixtures/questions.public.json（自製 62 題）與 eval/fixtures/embeddings.<model>.768.json（兩個模型各一份）
//   - eval/golden/variant.json（30 個藍本）、eval/golden/dedup.json（30 組去重題對，Owner 已定案的 expect_l1）
//   - eval/cassettes/variant/*.json：已錄的生成題。把回應餵回 agents/generateVariant.js 的 run()（跑題門檻設成 -1，
//     所以每一題都算得出餘弦），向量一律查向量檔——與 CI 回放時跑題檢查算的是同一個數字。
//
// 限制（報告開頭也會印）：
//   - Gemini 的向量檔少了 5 題（#51、#53、#54、#55、#62：2026-09-25 CR-8 改標與新增之後沒有用 Gemini 重錄），
//     兩個模型並排比較時只用兩邊都有的題（「共同題」）。
//   - 生成題與 fixture 的最近餘弦（去重那一段）用的是跑題檢查那一段文字的向量；suite 的 dedup1 用的是
//     classify／lint 之後的文字，classify 換章或 lint 改寫的少數幾題會略有不同。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const T = require('../lib/embedThresholds');
const { loadFixture } = require('../lib/fixtures');
const { loadEmbeddings } = require('../lib/embeddings');
const { loadVariantGolden, retrieveInMemory } = require('../lib/suiteVariant');
const localMode = require('../lib/localMode');

const APP_DIR = path.resolve(__dirname, '..', '..');
const DEDUP_GOLDEN = path.join(APP_DIR, 'eval', 'golden', 'dedup.json');
const DEFAULT_COMPARE = 'gemini-embedding-001';
const DEFAULT_COMPARE_LLM = 'gemini-3.1-pro-preview';

/**
 * 程式裡的現行預設值（直接讀程式，不讀 .env：本報告分析的是「沒寫 .env 時」的行為）。
 * @returns {{retrieve:number, offtopic:number, dedupDup:number, dedupVariant:number}}
 */
function currentDefaults() {
    const dedup = require('../../agents/dedup');
    return {
        retrieve: require('../../services/variantService').simMin({}),
        offtopic: require('../../agents/generateVariant').DEFAULT_OFFTOPIC_SIM_MIN,
        dedupDup: dedup.DEFAULT_DUP,
        dedupVariant: dedup.DEFAULT_VARIANT
    };
}

/** 各段掃描用的門檻格點 */
const GRIDS = Object.freeze({
    pairs: [0.60, 0.65, 0.70, 0.72, 0.74, 0.76, 0.78, 0.80, 0.82, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.92, 0.94, 0.96, 0.97, 0.98, 0.99],
    retrieve: [...T.thresholdGrid(0.50, 0.58, 0.01), ...T.thresholdGrid(0.60, 0.90, 0.02)],
    retrieveFine: T.thresholdGrid(0.50, 0.95, 0.01),
    offtopic: T.thresholdGrid(0.72, 0.94, 0.01),
    dedup: [0.95, 0.96, 0.97, 0.975, 0.98, 0.985, 0.99, 0.995, 0.999]
});

const HELP = `用法：npm run embed:thresholds -- [選項]

  --model <EMBED_MODEL>    主要分析的向量檔（預設：EMBED_MODEL，沒設時 ollama:qwen3-embedding:0.6b）
  --compare <模型|none>     對照的向量檔（預設 ${DEFAULT_COMPARE}；none＝不對照）
  --llm <模型 ID>           主要分析的變式 cassette 是哪個模型錄的（預設 MODEL_VARIANT／MODEL_VERIFY 的裸 ID）
  --compare-llm <模型 ID>   對照的變式 cassette（預設 ${DEFAULT_COMPARE_LLM}）
  --cassettes <資料夾>      cassette 根目錄（預設 EVAL_CASSETTE_DIR 或 eval/cassettes）
  --out <檔案>             報告另存成 Markdown 檔（畫面上照樣印）
  --help                   顯示本說明

只讀檔案：不呼叫模型、不連網、不碰資料庫、不改任何設定或門檻。`;

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{cwd?:string, env?:object}} [opts]
 */
function parseArgs(argv, { cwd = process.cwd(), env = process.env } = {}) {
    const args = {
        model: localMode.embedModelFromEnv(env),
        compare: DEFAULT_COMPARE,
        // 與 runner 相同：MODEL_VARIANT 沒設退回 MODEL_VERIFY；都沒設時是本機預設（config/models.js 的 DEFAULT_VERIFY）
        llm: localMode.modelIdOf((String(env.MODEL_VARIANT || '').trim())
            || (String(env.MODEL_VERIFY || '').trim()) || localMode.LOCAL_DEFAULTS.MODEL_VERIFY),
        compareLlm: DEFAULT_COMPARE_LLM,
        cassettes: path.resolve(APP_DIR, env.EVAL_CASSETTE_DIR || path.join('eval', 'cassettes')),
        out: null,
        help: false
    };
    const value = (i, flag) => {
        const v = argv[i];
        if (v === undefined || String(v).startsWith('--')) throw new Error(`${flag} 後面要接一個值`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--model': args.model = value(++i, a); break;
            case '--compare': args.compare = value(++i, a); break;
            case '--llm': args.llm = value(++i, a); break;
            case '--compare-llm': args.compareLlm = value(++i, a); break;
            case '--cassettes': args.cassettes = path.resolve(cwd, value(++i, a)); break;
            case '--out': args.out = path.resolve(cwd, value(++i, a)); break;
            case '--help': case '-h': args.help = true; break;
            default: throw new Error(`不認得的參數：${a}（--help 看用法）`);
        }
    }
    if (String(args.compare).toLowerCase() === 'none') args.compare = null;
    return args;
}

// ───────────────────────── 讀資料 ─────────────────────────

/**
 * 變式 cassette：某個模型錄的、difficultyDelta=0 的，依「藍本 id#idx」取最新錄的一支。
 * @returns {Map<string, object>}
 */
function loadVariantCassettes(root, modelId) {
    const dir = path.join(root, 'variant');
    const out = new Map();
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
        let c;
        try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        const meta = c && c.meta || {};
        const kp = c && c.request && c.request.cacheKeyParts || {};
        if (meta.model !== modelId || (kp.difficultyDelta ?? 0) !== 0) continue;
        const key = `${kp.sourceQuestionId}#${kp.idx}`;
        const prev = out.get(key);
        if (!prev || String(prev.meta.recorded_at || '') < String(meta.recorded_at || '')) out.set(key, c);
    }
    return out;
}

/**
 * 把錄好的生成結果餵回 agents/generateVariant.js：跑題門檻設 -1（每一題都算出餘弦），向量查向量檔。
 * 回傳每一題的狀態：'sim'（有餘弦）、'text_gate'（文字閘門先擋下，系統不會算向量）、'schema_invalid'、
 * 'miss'（向量檔查不到）、'no_cassette'。
 */
async function replayGenerations({ golden, fixture, cassettes, embedModel, dim }) {
    const agent = require('../../agents/generateVariant');
    const { embedFromFixture } = require('../../services/llm/fixture');
    const { l2Normalize } = require('../../services/llm');
    const gens = [];
    for (const e of golden.entries) {
        const source = fixture.byId.get(e.source_question_id);
        for (let idx = 1; idx <= 2; idx++) {
            const c = cassettes.get(`${source.id}#${idx}`);
            const base = { entryId: e.id, idx, sourceId: source.id, sourceChapter: source.chapter, sourceText: source.question_text };
            if (!c) { gens.push({ ...base, status: 'no_cassette' }); continue; }
            base.latencyMs = Number(c.response && c.response.latencyMs);
            const data = (c.response && c.response.data) || {};
            let vector = null;
            let miss = null;
            const ctx = {
                llm: {
                    generateJson: async () => ({ data, usage: c.response.usage || {} }),
                    embed: async ({ texts }) => {
                        try {
                            const vectors = embedFromFixture({ model: embedModel, texts, dim }).vectors.map(l2Normalize);
                            vector = vectors[0];
                            return { vectors };
                        } catch (err) { miss = err.message; throw err; }
                    }
                },
                config: { thresholds: { variantOfftopicSimMin: -1 }, models: { variant: 'replay-only' } },
                job: { kind: 'variant' },
                signal: undefined
            };
            const out = await agent.run(ctx, { source, neighbors: [], difficulty_delta: 0, idx });
            const text = String(data.question_text || '');
            const row = { ...base, text, chapter: data.chapter || null, damaged: T.hasEscapeDamage(text) };
            if (miss) gens.push({ ...row, status: 'miss' });
            else if (out.kind === 'pass') gens.push({ ...row, status: 'sim', sim: out.gate.sim, chapter: out.data.chapter, vector });
            else if (out.kind === 'fail' && out.reason === 'text_gate') gens.push({ ...row, status: 'text_gate' });
            else gens.push({ ...row, status: out.reason || out.kind });
        }
    }
    return gens;
}

/**
 * 讀一個模型的全部資料並算好各段需要的數字。
 * @returns {Promise<object|null>} 向量檔不存在時回 null（只在對照模型允許）
 */
async function analyzeModel({ model, llm, fixture, golden, dedupGolden, cassetteRoot, dim, optional, questionFilter }) {
    const emb = loadEmbeddings({ questions: fixture.questions, model, dim, optional });
    if (!emb.available) return null;
    const hasVec = q => Array.isArray(emb.vectorOf(q));
    const questions = fixture.questions.filter(q => hasVec(q) && (!questionFilter || questionFilter(q)));

    // ① 題對分布
    const pairs = T.pairwise(questions, emb.vectorOf);
    const groups = T.groupByRelation(pairs);

    // ② 檢索：與 suiteVariant 的 retrieved_coverage 同一個候選條件（同科、同難度、排除自己），門檻先放到 -1
    const retrieval = golden.entries.map(e => {
        const source = fixture.byId.get(e.source_question_id);
        const hits = hasVec(source)
            ? retrieveInMemory({ source, questions, vectorOf: emb.vectorOf, simMin: -1 })
                .map(h => ({ id: h.id, cosine: h.cosine, kind: T.pickKindOf(source, fixture.byId.get(h.id)) }))
            : [];
        return { id: e.id, sourceId: source.id, chapter: source.chapter, difficulty: source.difficulty,
            minRetrieved: (e.expect && e.expect.min_retrieved) || 2, hits, sourceHasVector: hasVec(source) };
    });

    // ③ 跑題：已錄的生成題
    const cassettes = llm ? loadVariantCassettes(cassetteRoot, llm) : new Map();
    const gens = await replayGenerations({ golden, fixture, cassettes, embedModel: model, dim });

    // ④ 去重：golden 題對、生成題與 fixture 的最近餘弦、同一藍本兩題之間
    const dedupPairs = dedupGolden.entries
        .filter(d => d.kind === 'numeric_change' || d.kind === 'different')
        .map(d => {
            const a = fixture.byId.get(d.a.from), b = fixture.byId.get(d.b.from);
            const textsMatch = a && b && a.question_text === d.a.text && b.question_text === d.b.text;
            const cos = textsMatch && hasVec(a) && hasVec(b) ? T.cosine(emb.vectorOf(a), emb.vectorOf(b)) : null;
            return { id: d.id, kind: d.kind, a: d.a.from, b: d.b.from, expect: d.expect_l1, cos };
        });
    const genNearest = gens.filter(g => g.status === 'sim').map(g => {
        let best = null;
        for (const q of questions) {
            if (q.id === g.sourceId) continue;              // 排除藍本（fixture 沒有 variant_of，家族就是它自己；同 suiteVariant 的 dedup1）
            const c = T.cosine(g.vector, emb.vectorOf(q));
            if (best === null || c > best.cos) best = { cos: c, id: q.id };
        }
        const src = fixture.byId.get(g.sourceId);
        return { ...g, nearest: best, nearestRel: best ? T.relationOf(src, fixture.byId.get(best.id)) : null };
    });
    const siblings = [];
    for (const e of golden.entries) {
        const [g1, g2] = [1, 2].map(i => gens.find(g => g.entryId === e.id && g.idx === i));
        if (!g1 || !g2 || g1.status !== 'sim' || g2.status !== 'sim') continue;
        if (g1.text === g2.text) { siblings.push({ entryId: e.id, identical: true, cos: 1, numbers: 'same', t1: g1.text, t2: g2.text }); continue; }
        siblings.push({ entryId: e.id, identical: false, cos: T.cosine(g1.vector, g2.vector), numbers: T.numbersRelation(g1.text, g2.text), t1: g1.text, t2: g2.text });
    }

    return { model, llm, file: path.relative(APP_DIR, emb.file).replace(/\\/g, '/'), questions, pairs, groups,
        retrieval, gens, cassetteCount: cassettes.size, dedupPairs, genNearest, siblings };
}

// ───────────────────────── 報告 ─────────────────────────

const LABEL = T.RELATION_LABELS;
const PICK_LABEL = { same_concept: '同概念', same_chapter: '同章', lookalike: '2D／3D 對照', cross_chapter: '其他跨章', cross_subject: '跨科' };
const shortModel = m => (m === DEFAULT_COMPARE ? 'Gemini' : (String(m).startsWith('ollama:') ? '本機' : m));

function distRows(groups, name) {
    return T.RELATIONS.map(r => {
        const s = T.summarize(groups[r]);
        return [name ? `${name}｜${LABEL[r]}` : LABEL[r], s.n, T.fmt(s.min), T.fmt(s.p5), T.fmt(s.p25), T.fmt(s.p50), T.fmt(s.p75), T.fmt(s.p95), T.fmt(s.max)];
    });
}

function sweepRows(groups, grid) {
    return grid.map(t => [T.fmt(t, 2),
        T.fmt(T.rateAtOrAbove(groups.same_concept, t)),
        T.pct(T.rateAtOrAbove(groups.same_chapter, t)),
        T.pct(T.rateAtOrAbove(groups.cross_chapter, t)),
        T.pct(T.rateAtOrAbove(groups.different_chapter, t), 2),
        T.pct(T.rateAtOrAbove(groups.cross_subject, t))]);
}

function equivDescribe(eq) {
    if (eq.threshold === null) return `高於 ${T.fmt(eq.aboveMax)}（參考模型 ${eq.refCount}/${eq.refN} 對 ≥ 門檻，目標同比例是 0 對）`;
    return `${T.fmt(eq.threshold)}（參考 ${eq.refCount}/${eq.refN}＝${T.pct(eq.refRate)}；目標 ${eq.targetCount}/${eq.n}）`;
}

/**
 * 組出整份報告（純函式：吃 analyzeModel 的結果）。
 * @param {{primary:object, compare:object|null, primaryCommon:object|null, compareCommon:object|null,
 *          current:object, fixtureCount:number, commonIds:number[], missingInCompare:number[]}} a
 * @returns {{lines:string[], candidates:object}}
 */
function buildReport(a) {
    const { primary: P, compare: C, primaryCommon: PC, compareCommon: CC, current: cur } = a;
    const L = [];
    const pName = shortModel(P.model), cName = C ? shortModel(C.model) : null;
    const candidates = {};

    L.push('# 餘弦門檻分布報告（本機 embedding）', '');
    L.push('> 由 `npm run embed:thresholds` 產生（`eval/tools/embed_threshold_report.js`）。只讀檔案：不呼叫模型、不連網、不改任何設定；**本報告不改任何門檻**。');
    L.push(`> 主要：\`${P.model}\`（\`${P.file}\`，${P.questions.length} 題）；變式 cassette：\`${P.llm}\`（${P.cassetteCount} 支）。`);
    if (C) L.push(`> 對照：\`${C.model}\`（\`${C.file}\`，${C.questions.length} 題）；變式 cassette：\`${C.llm}\`（${C.cassetteCount} 支）。`);
    if (C && a.missingInCompare.length) {
        L.push(`> 對照模型的向量檔少了 ${a.missingInCompare.length} 題（#${a.missingInCompare.join('、#')}）：兩個模型並排的數字只用兩邊都有的 ${a.commonIds.length} 題（「共同題」）。`);
    }
    L.push(`> 現行預設（程式，不讀 .env）：VARIANT_RETRIEVE_SIM_MIN＝${cur.retrieve}、VARIANT_OFFTOPIC_SIM_MIN＝${cur.offtopic}、DEDUP_DUP_THRESHOLD＝${cur.dedupDup}、DEDUP_VARIANT_THRESHOLD＝${cur.dedupVariant}。`);
    L.push('> 百分位數用線性內插；「≥ 門檻」算通過／算相似（與程式相同）。', '');

    // ── 1. 題對分布 ──
    L.push('## 1. fixture 題對的餘弦分布（docs/variants.md 3.1 的四組）', '');
    L.push(`### 1.1 ${pName}，${P.questions.length} 題全部`, '');
    L.push(...T.mdTable(['關係', '對數', 'min', 'p5', 'p25', 'p50', 'p75', 'p95', 'max'], distRows(P.groups)), '');
    if (C && PC && CC) {
        L.push(`### 1.2 兩個模型並排（共同 ${a.commonIds.length} 題）`, '');
        const rows = [];
        for (const r of T.RELATIONS) {
            for (const [nm, M] of [[pName, PC], [cName, CC]]) {
                const s = T.summarize(M.groups[r]);
                rows.push([`${LABEL[r]}｜${nm}`, s.n, T.fmt(s.min), T.fmt(s.p5), T.fmt(s.p25), T.fmt(s.p50), T.fmt(s.p75), T.fmt(s.p95), T.fmt(s.max)]);
            }
        }
        L.push(...T.mdTable(['關係｜模型', '對數', 'min', 'p5', 'p25', 'p50', 'p75', 'p95', 'max'], rows), '');
    }
    const look = P.pairs.filter(p => p.lookalike).sort((x, y) => y.cos - x.cos);
    if (look.length) {
        L.push(`fixture 標的「2D／3D 內積」對照組（\`lookalike_of\`，算在跨章同科裡）${pName}：` +
            look.map(p => `#${p.a}×#${p.b} ${T.fmt(p.cos)}`).join('、') + '。', '');
    }

    // ── 2. 門檻掃描 ──
    L.push('## 2. 門檻掃描（fixture 題對；docs/variants.md 3.2 的算法）', '');
    L.push('「不同章誤收」＝跨章同科＋跨科的題對裡 ≥ 門檻的比例（3.2 表「跨章誤收率」的分母就是這樣）；另列跨章同科、跨科各自的比例。', '');
    const sweepHead = ['門檻', '同概念換數字 ≥ 門檻', '同章不同概念 ≥', '跨章同科 ≥', '不同章（3.2 算法）≥', '跨科 ≥'];
    L.push(`### 2.1 ${pName}（${P.questions.length} 題）`, '');
    L.push(...T.mdTable(sweepHead, sweepRows(P.groups, GRIDS.pairs)), '');
    if (CC) {
        L.push(`### 2.2 ${cName}（共同 ${a.commonIds.length} 題）`, '');
        L.push(...T.mdTable(sweepHead, sweepRows(CC.groups, GRIDS.pairs)), '');
    }

    // ── 2.3 等效門檻 ──
    if (PC && CC) {
        L.push(`### 2.3 「${cName} 現行門檻」在 ${pName} 上的等效值（共同 ${a.commonIds.length} 題、分位對應）`, '');
        L.push(`做法：${cName} 在現行門檻時某一組題對有 r 比例 ≥ 門檻；在 ${pName} 上找讓同一組也是 r 比例 ≥ 它的門檻（k＝round(r×對數)，取第 k 大的餘弦）。`, '');
        const eqRows = [];
        const REL_LABEL = { same_concept: '同概念換數字', same_chapter: '同章不同概念', different_chapter: '不同章（3.2 算法）', cross_chapter: '跨章同科' };
        const all = Object.keys(REL_LABEL);
        const plan = [
            ['retrieve', 'VARIANT_RETRIEVE_SIM_MIN', cur.retrieve, all],
            ['offtopic', 'VARIANT_OFFTOPIC_SIM_MIN', cur.offtopic, all],
            ['dedupDup', 'DEDUP_DUP_THRESHOLD', cur.dedupDup, ['same_concept', 'same_chapter']],
            ['dedupVariant', 'DEDUP_VARIANT_THRESHOLD', cur.dedupVariant, ['same_concept', 'same_chapter']]
        ];
        for (const [key, envName, t, rels] of plan) {
            for (const rel of rels) {
                const eq = T.equivalentThreshold(CC.groups[rel], t, PC.groups[rel]);
                eqRows.push([`${envName}（${cName} ${t}）`, REL_LABEL[rel], equivDescribe(eq)]);
                candidates[`${key}_equiv_${rel}`] = eq.threshold;
            }
        }
        L.push(...T.mdTable(['門檻', '對應哪一組', `${pName} 的等效值`], eqRows, 'lll'), '');
    }

    // ── 3. 檢索 ──
    L.push(`## 3. VARIANT_RETRIEVE_SIM_MIN（現行 ${cur.retrieve}）：變式 golden 每個藍本的最近與第 2 近`, '');
    L.push('候選條件與 `retrieved_coverage` 相同：同科、同難度、排除自己；第 2 近 ≥ 門檻才算覆蓋（`expect.min_retrieved`＝2）。類別：同概念／同章／2D／3D 對照（fixture 的 lookalike）／其他跨章。', '');
    const retRows = P.retrieval.map((r, i) => {
        const fmtHit = h => (h ? `${T.fmt(h.cosine, 3)} ${PICK_LABEL[h.kind]} #${h.id}` : '—');
        const c = C && C.retrieval[i];
        return [r.id, `#${r.sourceId}`, T.cell(r.chapter), r.difficulty, fmtHit(r.hits[0]), fmtHit(r.hits[1]),
            ...(C ? [c.sourceHasVector ? fmtHit(c.hits[0]) : '（無向量）', c.sourceHasVector ? fmtHit(c.hits[1]) : '（無向量）'] : [])];
    });
    L.push(...T.mdTable(['藍本', '題', '章節', '難度', `${pName} 最近`, `${pName} 第 2 近`, ...(C ? [`${cName} 最近`, `${cName} 第 2 近`] : [])],
        retRows, 'lllr' + 'l'.repeat(C ? 4 : 2)), '');
    L.push('### 3.1 覆蓋率與「推薦出去的前 2 題」組成', '');
    const covRows = GRIDS.retrieve.map(t => {
        const p = T.coverageAt(P.retrieval, t);
        const c = C ? T.coverageAt(C.retrieval, t) : null;
        const kinds = ['same_concept', 'same_chapter', 'lookalike', 'cross_chapter'];
        return [T.fmt(t, 2), `${p.covered}/${p.total}（${T.fmt(p.coverage)}）`, kinds.map(k => p.picks[k]).join('／'),
            ...(C ? [`${c.covered}/${c.total}`, kinds.map(k => c.picks[k]).join('／')] : [])];
    });
    L.push(...T.mdTable(['門檻', `${pName} 覆蓋`, `${pName} 推薦：同概念／同章／2D·3D 對照／其他跨章`,
        ...(C ? [`${cName} 覆蓋`, `${cName} 推薦：同概念／同章／2D·3D／其他跨章`] : [])], covRows), '');
    if (C) L.push(`${cName} 那兩欄只用它有向量的題（少的那幾題當作不存在），僅供對照。`, '');
    const clean = T.lowestCleanThreshold(P.retrieval, GRIDS.retrieveFine);
    candidates.retrieve_clean = clean ? clean.t : null;
    const nowCov = T.coverageAt(P.retrieval, cur.retrieve);
    candidates.retrieve_current_coverage = nowCov.coverage;
    L.push(`- 現行 ${cur.retrieve}：覆蓋 ${nowCov.covered}/${nowCov.total}（${T.fmt(nowCov.coverage)}）。`);
    L.push(clean
        ? `- 「推薦出去的前 2 題沒有其他跨章題」的最低門檻（0.01 格點）：**${T.fmt(clean.t, 2)}**，覆蓋 ${clean.covered}/${clean.total}（${T.fmt(clean.coverage)}）；組成 同概念 ${clean.picks.same_concept}、同章 ${clean.picks.same_chapter}、2D／3D 對照 ${clean.picks.lookalike}。`
        : '- 在 0.50～0.95 之間找不到「推薦出去的前 2 題沒有其他跨章題」的門檻。');
    L.push('');

    // ── 4. 跑題 ──
    L.push(`## 4. VARIANT_OFFTOPIC_SIM_MIN（現行 ${cur.offtopic}）：已錄生成題與藍本的餘弦`, '');
    L.push('把已錄的生成結果餵回 `agents/generateVariant.js`（跑題門檻設 -1），向量查向量檔：就是跑題檢查在 CI 回放時看到的分數。文字閘門先擋下的題系統不會算向量。', '');
    const statRow = (M, nm) => {
        const count = s => M.gens.filter(g => g.status === s).length;
        const sims = M.gens.filter(g => g.status === 'sim').map(g => g.sim);
        const s = T.summarize(sims);
        const uniq = new Set(M.gens.filter(g => g.status === 'sim').map(g => g.text)).size;
        return [nm, M.gens.length, count('sim'), uniq, count('text_gate'), M.gens.length - count('sim') - count('text_gate'),
            T.fmt(s.min), T.fmt(s.p5), T.fmt(s.p25), T.fmt(s.p50), T.fmt(s.p75), T.fmt(s.p95), T.fmt(s.max)];
    };
    L.push(...T.mdTable(['生成＋向量', '生成題', '有餘弦', '其中不同題幹', '文字閘門', '其他（schema／缺向量）', 'min', 'p5', 'p25', 'p50', 'p75', 'p95', 'max'],
        [statRow(P, `${P.llm}＋${pName}`), ...(C ? [statRow(C, `${C.llm}＋${cName}`)] : [])]), '');
    const latSec = M => M.gens.filter(g => Number.isFinite(g.latencyMs)).map(g => g.latencyMs / 1000);
    const latLine = (M) => {
        const s = T.summarize(latSec(M));
        return s.n ? `${M.llm} 生成一題（cassette 的 latencyMs，牆鐘時間）：${s.n} 支，p50 ${T.fmt(s.p50, 0)} 秒、p95 ${T.fmt(s.p95, 0)} 秒、max ${T.fmt(s.max, 0)} 秒` : null;
    };
    const lat = [latLine(P), C ? latLine(C) : null].filter(Boolean);
    if (lat.length) L.push(lat.join('；') + '。擋下一題＝重做一次生成。', '');
    const damaged = P.gens.filter(g => g.text && g.damaged).length;
    L.push(`${P.llm} 的 ${P.gens.filter(g => g.text).length} 題裡有 **${damaged}** 題題幹帶有「JSON 跳脫吃掉 LaTeX」的控制字元（\`\\times\` 變成定位字元＋\`imes\` 之類；只數得到 \\t、\\b、\\f、\\r，是下限）` +
        (C ? `；${C.llm} 是 ${C.gens.filter(g => g.text && g.damaged).length}/${C.gens.filter(g => g.text).length}` : '') + '。這些題的向量是拿壞掉的文字算的。', '');
    L.push('### 4.1 門檻掃描（每支 cassette 算一題；同一藍本兩題題幹相同也算兩題）', '');
    const offRows = GRIDS.offtopic.map(t => {
        const p = T.offtopicAt(P.gens, t);
        const c = C ? T.offtopicAt(C.gens, t) : null;
        return [T.fmt(t, 2), `${p.blocked}/${p.withSim}`, `${p.entriesNoneThrough}/${p.entries}`,
            ...(C ? [`${c.blocked}/${c.withSim}`, `${c.entriesNoneThrough}/${c.entries}`] : [])];
    });
    L.push(...T.mdTable(['門檻', `${pName} 擋下`, `${pName} 兩題都沒過的藍本`, ...(C ? [`${cName} 擋下`, `${cName} 兩題都沒過的藍本`] : [])], offRows), '');
    L.push('「兩題都沒過」含文字閘門先擋下的；Gemini 那一欄有幾題缺向量（改標後藍本的向量沒重錄），算作沒過。', '');
    L.push(`### 4.2 ${P.llm}＋${pName} 每一題（依餘弦由低到高）`, '');
    const listRows = [...P.gens].sort((x, y) => (x.status === 'sim' ? x.sim : 9) - (y.status === 'sim' ? y.sim : 9)).map(g => [
        g.status === 'sim' ? T.fmt(g.sim) : `—（${g.status}）`, `${g.entryId}#${g.idx}`, `#${g.sourceId}`,
        T.cell(g.chapter && g.chapter !== g.sourceChapter ? `${g.sourceChapter} → ${g.chapter}` : g.sourceChapter),
        T.cell(g.sourceText, 30), T.cell(g.text, 70)]);
    L.push(...T.mdTable(['餘弦', '生成', '藍本', '章節', '藍本題幹', '生成題幹'], listRows, 'rllll'), '');

    // ── 5. 去重 ──
    L.push(`## 5. DEDUP_DUP_THRESHOLD（現行 ${cur.dedupDup}）與 DEDUP_VARIANT_THRESHOLD（現行 ${cur.dedupVariant}）`, '');
    L.push('dedup1 的判定（`agents/dedup.js`）：與同科最近一題的餘弦 ≥ DEDUP_DUP_THRESHOLD → 重複、**不入庫**；≥ DEDUP_VARIANT_THRESHOLD → 標「變式」照常入庫（只是標記）；其餘 unique。', '');
    L.push('### 5.1 dedup golden（Owner 已定案的 expect_l1）', '');
    L.push('verbatim／resend 16 組：L0 雜湊已全部擋下（`npm test` 守著）；resend 的題幹改過格式，向量檔沒有錄，量不到餘弦。下表是其餘 14 組。', '');
    const dgRows = P.dedupPairs.map((d, i) => {
        const c = C ? C.dedupPairs[i] : null;
        const v = cos => (cos === null ? '—' : `${T.fmt(cos)} → ${T.dedupVerdict(cos, cur.dedupDup, cur.dedupVariant)}`);
        return [d.id, `#${d.a}×#${d.b}`, d.expect, v(d.cos), ...(C ? [v(c.cos)] : [])];
    });
    L.push(...T.mdTable(['組', '題對', 'golden 預期', `${pName}（現行門檻）`, ...(C ? [`${cName}（現行門檻）`] : [])], dgRows, 'lllll'), '');
    L.push('### 5.2 門檻掃描：換數字的現成題對被判「重複」幾對', '');
    const ddRows = GRIDS.dedup.map(t => [T.fmt(t, 3),
        `${T.countAtOrAbove(P.groups.same_concept, t)}/${P.groups.same_concept.length}`,
        `${T.countAtOrAbove(P.groups.same_chapter, t) + T.countAtOrAbove(P.groups.cross_chapter, t)}/${P.groups.same_chapter.length + P.groups.cross_chapter.length}`,
        ...(CC ? [`${T.countAtOrAbove(CC.groups.same_concept, t)}/${CC.groups.same_concept.length}`] : [])]);
    L.push(...T.mdTable(['門檻', `${pName} 同概念換數字 ≥`, `${pName} 其他同科題對 ≥`, ...(CC ? [`${cName} 同概念換數字 ≥（共同題）`] : [])], ddRows), '');
    const top = [...P.pairs].filter(p => p.relation !== 'cross_subject').sort((x, y) => y.cos - x.cos).filter(p => p.cos >= 0.95);
    L.push(`${pName} 餘弦 ≥ 0.95 的現成題對（${top.length} 對）：` + top.map(p => `#${p.a}×#${p.b} ${T.fmt(p.cos)}（${p.lookalike ? '2D／3D 對照' : LABEL[p.relation]}）`).join('、') + '。', '');
    L.push('### 5.3 生成題與 fixture 最近一題（排除藍本；近似 variant suite 的 dedup1）', '');
    const gnRow = (M, nm) => {
        const v = M.genNearest.map(g => g.nearest.cos);
        const s = T.summarize(v);
        return [nm, v.length, ...GRIDS.dedup.slice(0, 8).map(t => T.countAtOrAbove(v, t)), T.fmt(s.p50), T.fmt(s.max)];
    };
    L.push(...T.mdTable(['生成＋向量', '題數', ...GRIDS.dedup.slice(0, 8).map(t => `≥ ${t}`), 'p50', 'max'],
        [gnRow(P, `${P.llm}＋${pName}`), ...(C ? [gnRow(C, `${C.llm}＋${cName}`)] : [])]), '');
    const hiNear = P.genNearest.filter(g => g.nearest.cos >= 0.95).sort((x, y) => y.nearest.cos - x.nearest.cos);
    if (hiNear.length) {
        L.push(`${P.llm}：最近一題 ≥ 0.95 的生成題（最近那題與藍本的關係）：` +
            hiNear.map(g => `${g.entryId}#${g.idx} ${T.fmt(g.nearest.cos)} → #${g.nearest.id}（${LABEL[g.nearestRel]}）`).join('、') + '。', '');
    }
    L.push('### 5.4 同一藍本的兩題生成題之間（重複候選的實例）', '');
    L.push('兩題的數字完全相同＝多半是同一題換句話說（該被當成重複的那一種）；「無數字」是觀念題，這個標記判斷不了，要看題幹。題幹逐字相同的 L0 雜湊就會擋，這裡只列不同的。', '');
    const NUM_LABEL = { same: '相同', different: '不同', none: '無數字' };
    const sibRows = P.siblings.filter(s => !s.identical).sort((x, y) => y.cos - x.cos)
        .map(s => [s.entryId, T.fmt(s.cos), NUM_LABEL[s.numbers], T.cell(s.t1, 45), T.cell(s.t2, 45)]);
    L.push(...T.mdTable(['藍本', '餘弦', '數字', '第 1 題', '第 2 題'], sibRows, 'lrlll'), '');
    L.push(`（${P.llm} 另有 ${P.siblings.filter(s => s.identical).length} 個藍本的兩題逐字相同。）`, '');
    if (C) {
        const cs = C.siblings.filter(s => !s.identical);
        const cv = cs.map(s => s.cos);
        L.push(`對照：${C.llm}＋${cName} 同一藍本兩題（${cs.length} 組，數字相同 ${cs.filter(s => s.numbers === 'same').length} 組）餘弦 min ${T.fmt(T.summarize(cv).min)}、p50 ${T.fmt(T.summarize(cv).p50)}、max ${T.fmt(T.summarize(cv).max)}。`, '');
    }

    candidates.dedup_above_all_numeric = P.groups.same_concept.length ? T.justAbove(Math.max(...P.groups.same_concept), 0.001) : null;
    L.push('## 6. 依寫明規則算出的候選值（不是建議，Owner 裁決前一個都不改）', '');
    const cRows = [
        ['VARIANT_RETRIEVE_SIM_MIN', `推薦出去的前 2 題沒有其他跨章題的最低門檻（3.1）`, T.fmt(candidates.retrieve_clean, 2)],
        ['VARIANT_RETRIEVE_SIM_MIN', `${cName || '對照'} ${cur.retrieve} 的等效值：不同章誤收同比例（2.3）`, T.fmt(candidates.retrieve_equiv_different_chapter)],
        ['VARIANT_RETRIEVE_SIM_MIN', `${cName || '對照'} ${cur.retrieve} 的等效值：同章不同概念同比例（2.3）`, T.fmt(candidates.retrieve_equiv_same_chapter)],
        ['VARIANT_OFFTOPIC_SIM_MIN', `${cName || '對照'} ${cur.offtopic} 的等效值：不同章誤收同比例（2.3）`, T.fmt(candidates.offtopic_equiv_different_chapter)],
        ['VARIANT_OFFTOPIC_SIM_MIN', `${cName || '對照'} ${cur.offtopic} 的等效值：同章不同概念同比例（2.3）`, T.fmt(candidates.offtopic_equiv_same_chapter)],
        ['DEDUP_DUP_THRESHOLD', `${cName || '對照'} ${cur.dedupDup} 的等效值：換數字題被判重複同比例（2.3）`, T.fmt(candidates.dedupDup_equiv_same_concept)],
        ['DEDUP_DUP_THRESHOLD', '不把任何一對換數字的現成題判成重複（高於最大值的 0.001 格點）', T.fmt(candidates.dedup_above_all_numeric, 3)],
        ['DEDUP_VARIANT_THRESHOLD', `${cName || '對照'} ${cur.dedupVariant} 的等效值：換數字題標成「變式」同比例（2.3）`, T.fmt(candidates.dedupVariant_equiv_same_concept)]
    ];
    L.push(...T.mdTable(['門檻', '規則', '值'], cRows, 'llr'), '');
    return { lines: L, candidates };
}

// ───────────────────────── main ─────────────────────────

async function run(args) {
    const dim = Number(process.env.EMBED_DIM || 768);
    const fixture = loadFixture();
    const golden = loadVariantGolden({ fixtureById: fixture.byId });
    const dedupGolden = JSON.parse(fs.readFileSync(DEDUP_GOLDEN, 'utf8'));
    const common = { fixture, golden, dedupGolden, cassetteRoot: args.cassettes, dim };

    const primary = await analyzeModel({ ...common, model: args.model, llm: args.llm, optional: false });
    let compare = null, primaryCommon = null, compareCommon = null, commonIds = [], missingInCompare = [];
    if (args.compare) {
        compare = await analyzeModel({ ...common, model: args.compare, llm: args.compareLlm, optional: true });
        if (compare) {
            const inCompare = new Set(compare.questions.map(q => q.id));
            const inPrimary = new Set(primary.questions.map(q => q.id));
            commonIds = fixture.questions.map(q => q.id).filter(id => inCompare.has(id) && inPrimary.has(id));
            missingInCompare = fixture.questions.map(q => q.id).filter(id => !inCompare.has(id));
            const keep = new Set(commonIds);
            const onlyCommon = q => keep.has(q.id);
            primaryCommon = await analyzeModel({ ...common, model: args.model, llm: null, optional: false, questionFilter: onlyCommon });
            compareCommon = await analyzeModel({ ...common, model: args.compare, llm: null, optional: true, questionFilter: onlyCommon });
        }
    }
    return buildReport({ primary, compare, primaryCommon, compareCommon, current: currentDefaults(),
        fixtureCount: fixture.questions.length, commonIds, missingInCompare });
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { console.log(HELP); return 0; }
    const { lines } = await run(args);
    const text = lines.join('\n') + '\n';
    process.stdout.write(text);
    if (args.out) {
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, text, 'utf8');
        console.error(`已另存：${args.out}`);
    }
    return 0;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(err => {
        console.error(`embed:thresholds 失敗：${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, currentDefaults, loadVariantCassettes, replayGenerations, analyzeModel, buildReport, run, main, GRIDS, HELP };
