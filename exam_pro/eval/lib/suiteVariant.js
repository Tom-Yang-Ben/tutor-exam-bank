// ─────────────────────────────────────────────────────────────
// eval/lib/suiteVariant.js — `eval/run.js --suite variant`（P-11b，擁有者：WS-B）
//
// 介面凍結於 docs/interfaces-stage3.md 第 8.1／8.3 條：
//   SUITE_METRICS.variant = { columns: ['variant'], metrics: ['retrieved_coverage', 'gate_pass_rate'] }
//
// 兩個數字，兩種可得性，**刻意分開**：
//
//   retrieved_coverage —— 30 個藍本中「純檢索就找得到 ≥ 2 題」的比例。
//       零 LLM、零 embedding 呼叫（查詢向量直接取藍本已存的向量），所以**永遠量得到**。
//       這是決定 3B 優先度的數字：如果八成的錯題本來就有相似題可推薦，變式生成就不急。
//
//   gate_pass_rate —— 30 藍本 × 2 題 = 60 次生成中，六個閘門全過的比例。
//       需要 `eval/cassettes/variant/` 的回放（生成本身）以及 classify／lint／verify 的 cassette。
//       **cassette 還沒錄的時候一律回 `null` 並附一則 warning，不用別的數字冒充**——
//       這與 suiteClassify 對「agent 尚未合入」的處理是同一條線（規劃 §5.3.3
//       「不在缺數字時假裝通過」）。錄製方式見 docs/variants.md，
//       `LLM_MODE=record` 與 `EMBED_MODE=record` **必須一起開**（裁決 S3-20）。
//
// 檢索引擎兩種，預設 memory：
//   memory（預設）—— 用 eval/fixtures 的向量在記憶體裡算餘弦。與 SQL 算的是同一件事
//       （兩邊向量都 L2 正規化，餘弦 = 內積），所以這一欄不會因為「今天有沒有 PG」
//       而變成兩個數字——理由與 eval/lib/ranker.js 的 LIKE 欄完全相同。
//   pg（`--engine pg`）—— 把 fixture 灌進測試庫，跑 services/variantService.js 的
//       **那一段真的 SQL**。SQL 本身的正確性由 test/integration/variants.pg.test.js 保證，
//       這裡只是讓「eval 與 prod 走同一段 SQL」這件事在需要時可驗證。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { loadFixture } = require('./fixtures');
const { loadEmbeddings, assertComplete } = require('./embeddings');
const { isValidChapter, isValidSubject, isValidQuestionType, normalizeDifficulty } = require('../../config/chapters');
const { isPrivatePath } = require('./golden');
const metrics = require('./metrics');
const shims = require('./stage2Shims');
const replayMiss = require('./replayMiss');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_PATH = path.resolve(ROOT, 'agents', 'generateVariant.js');

/** 第 8.3 條：每個藍本生幾題 */
const PER_SOURCE = 2;
/** 六個閘門的名字（報表逐欄印通過數） */
const GATES = ['text_gate', 'off_topic', 'classify', 'lint', 'verify', 'dedup1'];

// ───────────────────────── eval/golden/variant.json 的載入與硬閘門 ─────────────────────────
//
// 形狀凍結於第 8.4 條。閘門放在**載入時**，理由與 eval/lib/golden2.js 一字不差：
// golden 是純檔案，沒有 DB 的 CHECK 幫忙擋。一個手滑改錯的 source_question_id 只會讓那一筆
// 永遠算成「檢索不到」，卻不會有任何錯誤訊息——症狀是 retrieved_coverage 少了 1/30，
// 看起來像檢索退步，其實是標註爛掉。
//
// 這一段寫在 suite 檔裡而不是另開 eval/lib/goldenVariant.js：`eval/**` 歸 WS-D，
// WS-B 只擁有 suiteVariant.js／golden/variant.json／cassettes/variant/**（第 10.1 條）。

const GOLDEN_DEFAULT_PATH = path.resolve(__dirname, '..', 'golden', 'variant.json');

/**
 * 逐筆驗證，回傳「所有」問題（不是遇到第一個就停）——一次修完比修五輪省事。
 * @param {Array<object>} entries
 * @param {Map<number,object>} [fixtureById]
 * @returns {string[]}
 */
function validateGoldenEntries(entries, fixtureById) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) {
        return ['variant golden 的 entries 必須是非空陣列'];
    }

    const seenIds = new Set();
    const seenSources = new Set();
    for (const e of entries) {
        const at = `id=${e && e.id}`;
        if (typeof e.id !== 'string' || !/^var-\d{3}$/.test(e.id)) problems.push(`${at}：id 必須是 var-NNN 格式`);
        else if (seenIds.has(e.id)) problems.push(`${at}：id 重複`);
        else seenIds.add(e.id);

        if (!Number.isInteger(e.source_question_id)) {
            problems.push(`${at}：source_question_id 必須是整數`);
        } else if (fixtureById && !fixtureById.has(e.source_question_id)) {
            problems.push(`${at}：source_question_id=${e.source_question_id} 不在 fixture 內（藍本只能取自公開 fixture）`);
        } else if (seenSources.has(e.source_question_id)) {
            problems.push(`${at}：source_question_id=${e.source_question_id} 重複——同一題當兩次藍本量不出新東西`);
        } else {
            seenSources.add(e.source_question_id);
        }

        if (!isValidSubject(e.subject)) problems.push(`${at}：subject「${e.subject}」不在白名單`);
        else if (!isValidChapter(e.subject, e.chapter)) problems.push(`${at}：chapter「${e.chapter}」不在「${e.subject}」的白名單`);

        if (e.question_type !== undefined && !isValidQuestionType(e.question_type)) {
            problems.push(`${at}：question_type「${e.question_type}」不在白名單`);
        }
        if (normalizeDifficulty(e.difficulty) === null) problems.push(`${at}：difficulty 必須是 1~5 的整數`);

        const min = e.expect && e.expect.min_retrieved;
        if (!Number.isInteger(min) || min < 1) problems.push(`${at}：expect.min_retrieved 必須是正整數`);

        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林值`);

        // fixture 是唯一真相：golden 抄下來的欄位必須與它一致，否則報表會對不上
        const src = fixtureById && fixtureById.get(e.source_question_id);
        if (src) {
            if (src.subject !== e.subject) problems.push(`${at}：subject 與 fixture 不符（fixture 是「${src.subject}」）`);
            if (src.chapter !== e.chapter) problems.push(`${at}：chapter 與 fixture 不符（fixture 是「${src.chapter}」）`);
            if (src.difficulty !== e.difficulty) problems.push(`${at}：difficulty 與 fixture 不符（fixture 是 ${src.difficulty}）`);
            if (e.question_type !== undefined && src.question_type !== e.question_type) {
                problems.push(`${at}：question_type 與 fixture 不符（fixture 是「${src.question_type}」）`);
            }
        }
    }
    return problems;
}

/**
 * @param {{file?:string, fixtureById?:Map<number,object>}} [opts]
 * @returns {{file:string, isPrivate:boolean, version:number, entries:Array<object>, pendingConfirm:number}}
 */
function loadVariantGolden(opts = {}) {
    const target = path.resolve(opts.file || GOLDEN_DEFAULT_PATH);
    if (!fs.existsSync(target)) throw new Error(`找不到 variant golden：${target}`);

    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const problems = validateGoldenEntries(raw.entries, opts.fixtureById);
    if (problems.length > 0) {
        throw new Error(`variant golden 未通過硬閘門（${target}）：\n  - ${problems.join('\n  - ')}`);
    }
    return {
        file: target,
        isPrivate: isPrivatePath(target),
        version: raw.version,
        entries: raw.entries,
        pendingConfirm: raw.entries.filter(e => e.needs_human_confirm).length
    };
}

// ───────────────────────── 純函式：記憶體版的 retrieved 分支 ─────────────────────────

/** 兩個向量的餘弦（fixture 的向量未必已正規化，所以這裡自己除一次範數） */
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 讀環境變數的浮點數；缺值或壞值退回預設 */
function numFromEnv(name, dflt) {
    const n = Number.parseFloat(process.env[name]);
    return Number.isFinite(n) ? n : dflt;
}

/**
 * 記憶體版的第 3.1 條候選條件。fixture 沒有 `archived_at`／`attempts`／`variant_of`，
 * 所以那三條在這裡分別是「恆真」「恆真」「家族鍵 = id」——與 pgEngine.seedFixture 灌進去的
 * 那份資料完全一致（它寫的是 origin='seed'、variant_of 為 NULL），兩個引擎才可比。
 *
 * @param {object} opts
 * @param {object} opts.source
 * @param {Array<object>} opts.questions
 * @param {(q:object)=>number[]} opts.vectorOf
 * @param {number} opts.simMin
 * @param {number} [opts.difficultyDelta=0]
 * @returns {Array<{id:number, cosine:number}>} 依 cosine 由大到小、id 由小到大
 */
function retrieveInMemory(opts) {
    const { source, questions, vectorOf, simMin } = opts;
    const delta = opts.difficultyDelta || 0;
    const wantDifficulty = clamp(Number(source.difficulty) + delta, 1, 5);
    const sourceVec = vectorOf(source);
    if (!sourceVec) return [];

    return questions
        .filter(q => q.id !== source.id)
        .filter(q => q.subject === source.subject)
        .filter(q => q.difficulty === wantDifficulty)
        .map(q => ({ id: q.id, cosine: cosine(sourceVec, vectorOf(q)) }))
        .filter(r => r.cosine >= simMin)
        .sort((a, b) => (b.cosine - a.cosine) || (a.id - b.id));
}

/** eval/cassettes/variant/ 有沒有東西可回放 */
function cassetteDirFor(agent) {
    const base = process.env.EVAL_CASSETTE_DIR || path.join('eval', 'cassettes');
    return path.resolve(ROOT, base, agent);
}

function hasCassettes(agent) {
    const dir = cassetteDirFor(agent);
    try {
        return fs.readdirSync(dir).some(f => f.endsWith('.json'));
    } catch {
        return false;
    }
}

// ───────────────────────── 六個閘門的驅動 ─────────────────────────

/**
 * 對一題生成出來的變式跑完六個閘門。
 *
 * 節點順序與 workers/jobRunner.js **完全相同**（dedup0 → classify → lint → verify → dedup1），
 * 只是把「寫 DB」換成「在記憶體裡比對 fixture」。前兩個閘門（text_gate、跑題）在
 * agents/generateVariant.js 裡面，所以 outcome 是 fail 的時候就已經知道卡在哪一道。
 *
 * @returns {Promise<{gates:Object, passedAll:boolean, stoppedAt:string|null, misses:string[]}>}
 */
async function runGates(ctx, deps, variant, source, seenHashes) {
    const gates = {};
    const misses = [];        // cassette replay miss（原文要原樣往上傳，run.js 靠凍結前綴辨識）
    const embedMisses = [];   // embedding fixture 查無此鍵（同樣不得靜默回退成假向量）
    let stoppedAt = null;

    const mark = (name, ok) => { gates[name] = ok; if (!ok && stoppedAt === null) stoppedAt = name; };

    // 前兩道在 agent 內部，由呼叫端把結果傳進來
    mark('text_gate', variant.text_gate_ok);
    mark('off_topic', variant.off_topic_ok);
    if (stoppedAt) return { gates, passedAll: false, stoppedAt, misses, embedMisses };

    // dedup0：normalizeStem → sha256，撞 fixture 或前面已生成的題就算重複
    const hash = deps.textHash(variant.data.question_text);
    const dup0 = hash === null || seenHashes.has(hash);
    mark('dedup0_ok', !dup0);
    delete gates.dedup0_ok;               // dedup0 不在第 8.3 條的六道裡，只借它擋重複
    if (dup0) {
        gates.classify = false;
        return { gates, passedAll: false, stoppedAt: 'dedup0', misses, embedMisses };
    }
    seenHashes.add(hash);

    // classify（第一層閘門就會過：generateVariant 繼承藍本章節時 confidence = 0.9）
    const classifyOutcome = await callAgent(deps.agents.classify, ctx, {
        subject: variant.data.subject,
        chapter: variant.data.chapter,
        chapter_confidence: variant.data.chapter_confidence,
        question_text: variant.data.question_text
    }, misses);
    mark('classify', classifyOutcome.kind === 'pass');
    if (stoppedAt) return { gates, passedAll: false, stoppedAt, misses, embedMisses };

    const chapter = classifyOutcome.data?.chapter ?? variant.data.chapter;

    // lint
    const lintOutcome = await callAgent(deps.agents.lint, ctx, {
        question_text: variant.data.question_text,
        answer_text: variant.data.answer_text
    }, misses);
    mark('lint', lintOutcome.kind === 'pass' || lintOutcome.kind === 'skipped');
    if (stoppedAt) return { gates, passedAll: false, stoppedAt, misses, embedMisses };

    const questionText = lintOutcome.data?.question_text ?? variant.data.question_text;
    const answerText = lintOutcome.data?.answer_text ?? variant.data.answer_text;

    // verify（證明題會 skipped，那也算過）
    const verifyOutcome = await callAgent(deps.agents.verify, ctx, {
        question_text: questionText,
        question_type: variant.data.question_type,
        claimed_answer: answerText
    }, misses);
    mark('verify', verifyOutcome.kind === 'pass' || verifyOutcome.kind === 'skipped');
    if (stoppedAt) return { gates, passedAll: false, stoppedAt, misses, embedMisses };

    // dedup1：與 fixture 比餘弦，**排除藍本整個家族**（裁決 S3-14）
    const dedup1 = deps.dedup1({ source, chapter, question_text: questionText, answer_text: answerText, difficulty: variant.data.difficulty, question_type: variant.data.question_type, subject: variant.data.subject });
    mark('dedup1', dedup1.ok);
    if (dedup1.miss) embedMisses.push(dedup1.miss);

    return { gates, passedAll: GATES.every(g => gates[g] === true), stoppedAt, misses, embedMisses };
}

/** agent 依合約不得 throw；replay miss 會以 {kind:'error'} 回來，這裡把它分出去（同 suiteClassify） */
async function callAgent(agent, ctx, input, misses) {
    if (!agent) return { kind: 'skipped', data: {} };
    let outcome;
    try {
        outcome = await agent.run(ctx, input);
    } catch (err) {
        outcome = { kind: 'error', errorClass: 'provider_error', message: err.message };
    }
    if (outcome && outcome.kind === 'error' && replayMiss.isReplayMiss(outcome.message)) {
        misses.push(outcome.message);       // **原樣**推進去：run.js 靠凍結前綴辨識（裁決 S2-14）
    }
    return outcome;
}

// ───────────────────────── suite 主體 ─────────────────────────

/**
 * @param {object} args run.js 的 args（用到 --golden、--engine）
 * @returns {Promise<object>} 第 8.1 條的形狀
 */
async function runVariantSuite(args = {}) {
    const warnings = [];
    const failures = [];

    const fixture = loadFixture();
    const golden = loadVariantGolden({ file: args.golden || undefined, fixtureById: fixture.byId });
    if (golden.pendingConfirm > 0) {
        warnings.push(`variant golden 有 ${golden.pendingConfirm}/${golden.entries.length} 筆仍是 needs_human_confirm 的草稿，尚未人工定案。`);
    }

    const emb = loadEmbeddings({ questions: fixture.questions });
    assertComplete(emb);

    // 裁決 S3-R9：兩個門檻分家。retrieved_coverage 量的是「檢索側」，用 RETRIEVE；
    // 生成後的跑題檢查（gate_pass_rate 的第二道）用 OFFTOPIC。舊名 VARIANT_SIM_MIN 是退路。
    const legacySimMin = Number.parseFloat(process.env.VARIANT_SIM_MIN);
    const legacy = Number.isFinite(legacySimMin) ? legacySimMin : null;
    const retrieveSimMin = numFromEnv('VARIANT_RETRIEVE_SIM_MIN', legacy ?? 0.80);
    const offtopicSimMin = numFromEnv('VARIANT_OFFTOPIC_SIM_MIN', legacy ?? 0.92);
    const engine = args.engine === 'pg' ? 'pg' : 'memory';

    // ── ① retrieved_coverage（零 LLM、零 embedding 呼叫）──
    const perEntry = [];
    let covered = 0;
    for (const e of golden.entries) {
        const source = fixture.byId.get(e.source_question_id);
        const hits = retrieveInMemory({
            source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: retrieveSimMin
        });
        const enough = hits.length >= (e.expect?.min_retrieved ?? 2);
        if (enough) covered += 1;
        perEntry.push({
            id: e.id, source_question_id: e.source_question_id,
            subject: e.subject, chapter: e.chapter, difficulty: e.difficulty,
            retrieved: hits.length,
            top_cosine: hits.length ? metrics.round4(hits[0].cosine) : null,
            enough
        });
    }
    const retrievedCoverage = golden.entries.length === 0 ? null : covered / golden.entries.length;

    // 校準用的旁欄：換一個門檻會怎樣（只報告，不進 thresholds）
    const sweep = {};
    for (const t of [0.80, 0.84, 0.88, 0.90, 0.92]) {
        let n = 0;
        for (const e of golden.entries) {
            const source = fixture.byId.get(e.source_question_id);
            const hits = retrieveInMemory({ source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: t });
            if (hits.length >= (e.expect?.min_retrieved ?? 2)) n += 1;
        }
        sweep[t.toFixed(2)] = metrics.round4(n / golden.entries.length);
    }

    if (engine === 'pg') {
        warnings.push('--engine pg 目前只用來驗證 services/variantService.js 那段 SQL 跑得起來；' +
            'retrieved_coverage 的數字仍以 memory 引擎為準（兩邊算的是同一個餘弦）。' +
            'SQL 的正確性由 test/integration/variants.pg.test.js 逐條斷言。');
    }

    // ── ② gate_pass_rate（需要 cassette）──
    const agentExists = fs.existsSync(AGENT_PATH);
    const generateFn = args.generateFn || null;
    // LLM_MODE=record 時 cassette 目錄本來就是空的（第一次錄製就是為了把它填起來）——
    // 只看 hasCassettes 會讓錄製永遠短路成 n/a（與 suiteNlq 的 S3-R20 補錄同一個道理）。
    const recording = String(process.env.LLM_MODE || '').toLowerCase() === 'record';
    const canGenerate = agentExists && (generateFn !== null || recording || hasCassettes('variant'));

    let gatePassRate = null;
    let gateCounts = null;
    let costUsd = null;
    let generations = 0;

    if (!agentExists) {
        warnings.push('agents/generateVariant.js 尚未合入：gate_pass_rate 與每題成本印 n/a。');
    } else if (!canGenerate) {
        warnings.push(
            `eval/cassettes/variant/ 沒有任何 cassette，gate_pass_rate 與每題成本這一輪一律 n/a。` +
            '錄製方式見 docs/variants.md：**LLM_MODE=record 與 EMBED_MODE=record 必須一起開**（裁決 S3-20）——' +
            '變式題幹是新字串，只錄 LLM 不錄向量的話，CI 會在 embedding fixture 查不到鍵而硬失敗。'
        );
    } else {
        const driver = await runGeneration({
            golden, fixture, emb, offtopicSimMin, generateFn, failures, warnings,
            agentOverrides: args.agents || {}
        });
        gatePassRate = driver.rate;
        gateCounts = driver.counts;
        costUsd = driver.costUsd;
        generations = driver.generations;
        for (const row of perEntry) {
            const g = driver.byEntry.get(row.id);
            if (g) Object.assign(row, { generated: g.generated, gate_passed: g.passed, stopped_at: g.stoppedAt });
        }
    }

    const measured = {
        variant: {
            retrieved_coverage: metrics.round4(retrievedCoverage),
            gate_pass_rate: metrics.round4(gatePassRate)
        }
    };

    return {
        suite: 'variant',
        measured,
        // 第 8.3 條：各閘門通過數與成本**只報告不設門檻**
        // （成本越低越好，放進 ratchet 會變成反向門檻）
        gateCounts,
        costUsd,
        generations,
        retrieveSimMin,
        offtopicSimMin,
        coverageSweep: sweep,
        engine,
        failures,
        warnings,
        perEntry: golden.isPrivate ? [] : perEntry,
        meta: {
            agent: agentExists ? 'agents/generateVariant.js' : '（未合入）',
            llmMode: process.env.LLM_MODE || 'replay',
            embedMode: process.env.EMBED_MODE || 'fixture',
            cassetteDir: process.env.EVAL_CASSETTE_DIR || 'eval/cassettes',
            golden: golden.isPrivate ? '（私有層，路徑不記錄）'
                : path.relative(ROOT, golden.file).replace(/\\/g, '/'),
            goldenEntries: golden.entries.length,
            goldenPending: golden.pendingConfirm,
            fixture: path.relative(ROOT, fixture.file).replace(/\\/g, '/'),
            embeddings: path.relative(ROOT, emb.file).replace(/\\/g, '/'),
            perSource: PER_SOURCE,
            variantRetrieveSimMin: retrieveSimMin,
            variantOfftopicSimMin: offtopicSimMin,
            engine,
            sources: shims.sources()
        },
        isPrivate: golden.isPrivate
    };
}

/**
 * 30 藍本 × 2 題，逐題跑完六個閘門。
 * @returns {Promise<{rate:number|null, counts:object, costUsd:number|null, generations:number, byEntry:Map}>}
 */
async function runGeneration({ golden, fixture, emb, offtopicSimMin, generateFn, failures, warnings, agentOverrides }) {
    const llm = require('../../services/llm');
    const models = require('../../config/models');
    const { textHash } = require('../../utils/normalizeStem');
    const { buildEmbedText } = require('../../utils/embedText');
    const variantAgent = require(AGENT_PATH);

    // 三個閘門 agent 由磁碟載入；args.agents 可以逐支覆寫——單元測試靠它把「需要 cassette
    // 的那一支」換掉，六個閘門與 gate_pass_rate 的算法才有東西可以真的跑過一遍。
    const agents = {
        classify: safeRequire(path.resolve(ROOT, 'agents', 'classify.js')),
        lint: safeRequire(path.resolve(ROOT, 'agents', 'lint.js')),
        verify: safeRequire(path.resolve(ROOT, 'agents', 'verify.js')),
        ...(agentOverrides || {})
    };

    const counts = Object.fromEntries(GATES.map(g => [g, 0]));
    const byEntry = new Map();
    const seenHashes = new Set();
    let passed = 0;
    let generations = 0;
    let costUsd = 0;
    let anyCost = false;
    const misses = [];
    const embedMisses = [];

    // fixture 的題也算「庫裡已有的題」：dedup0 撞到它們就是重複
    for (const q of fixture.questions) {
        const h = textHash(q.question_text);
        if (h) seenHashes.add(h);
    }

    for (const e of golden.entries) {
        const source = fixture.byId.get(e.source_question_id);
        // 錨點鄰居：與藍本同科、最近的 5 題，**排除藍本家族**（fixture 沒有 variant_of，家族鍵就是 id）
        const neighbors = retrieveInMemory({
            source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0
        }).slice(0, 5).map(r => {
            const q = fixture.byId.get(r.id);
            return { id: q.id, chapter: q.chapter, question_text: q.question_text };
        });

        let entryPassed = 0;
        let stoppedAt = null;
        for (let idx = 1; idx <= PER_SOURCE; idx++) {
            generations += 1;
            const ctx = makeCtx({ llm, models, offtopicSimMin });
            let outcome;
            try {
                outcome = generateFn
                    ? await generateFn(ctx, { source, neighbors, difficulty_delta: 0, idx })
                    : await variantAgent.run(ctx, { source, neighbors, difficulty_delta: 0, idx });
            } catch (err) {
                outcome = { kind: 'error', errorClass: 'provider_error', message: err.message };
            }

            if (outcome.kind === 'error') {
                if (replayMiss.isReplayMiss(outcome.message)) misses.push(outcome.message);
                else failures.push(`${e.id}#${idx}：${outcome.message}`);
                continue;
            }

            const variant = {
                data: outcome.data || {},
                text_gate_ok: !(outcome.kind === 'fail' && outcome.reason === 'text_gate'),
                off_topic_ok: !(outcome.kind === 'fail' && outcome.reason === 'off_topic')
            };
            if (outcome.kind === 'fail' && !['text_gate', 'off_topic'].includes(outcome.reason)) {
                // schema_invalid／chapter_invalid：連題目都沒生出來，六道閘門一道都沒到
                failures.push(`${e.id}#${idx}：生成失敗（${outcome.reason}）`);
                continue;
            }

            const res = await runGates(ctx, {
                agents, textHash,
                dedup1: (fields) => dedup1InMemory({ fields, source, fixture, emb, buildEmbedText })
            }, variant, source, seenHashes);

            for (const g of GATES) if (res.gates[g] === true) counts[g] += 1;
            if (res.passedAll) { passed += 1; entryPassed += 1; }
            else if (stoppedAt === null) stoppedAt = res.stoppedAt;
            misses.push(...res.misses);
            embedMisses.push(...res.embedMisses);

            const usage = ctx.__usage;
            if (usage.calls > 0) {
                anyCost = true;
                costUsd += usage.costUsd;
            }
        }
        byEntry.set(e.id, { generated: PER_SOURCE, passed: entryPassed, stoppedAt });
    }

    // 有任何一種 miss 就不報分數（同 suiteClassify）：部分回放出來的比例只反映
    // 「哪幾題剛好錄過」，拿它跟完整的一輪比較沒有意義（規劃 §5.3.3）。
    if (misses.length) {
        warnings.push(
            `${misses.length} 次呼叫是 cassette replay miss：cassette 尚未涵蓋這份 golden，` +
            'gate_pass_rate 這一輪 n/a。'
        );
        failures.push(...misses);       // **原樣**，run.js 的 partitionFailures 靠凍結前綴辨識
    }
    if (embedMisses.length) {
        warnings.push(
            `${embedMisses.length} 次在 embedding fixture 查不到變式題的向量：` +
            '**錄製時 LLM_MODE=record 與 EMBED_MODE=record 必須一起開**（裁決 S3-20）——' +
            '變式題幹是新字串，只錄 LLM 不錄向量的話跑題檢查與 dedup1 這兩道永遠量不到。' +
            'gate_pass_rate 這一輪 n/a。'
        );
        failures.push(...embedMisses);
    }
    if (misses.length || embedMisses.length) {
        return { rate: null, counts, costUsd: null, generations, byEntry };
    }

    return {
        rate: generations === 0 ? null : passed / generations,
        counts,
        costUsd: anyCost ? metrics.round4(costUsd) : null,
        generations,
        byEntry
    };
}

/** dedup1 的記憶體版：與 fixture 比餘弦，排除藍本整個家族 */
function dedup1InMemory({ fields, source, fixture, emb, buildEmbedText }) {
    const dupTh = Number(process.env.DEDUP_DUP_THRESHOLD || 0.97);
    let vec;
    try {
        const { embedFromFixture } = require('../../services/llm/fixture');
        const text = buildEmbedText(fields);
        const res = embedFromFixture({
            model: process.env.EMBED_MODEL || 'gemini-embedding-001',
            texts: [text],
            dim: Number(process.env.EMBED_DIM || 768)
        });
        vec = res.vectors[0];
    } catch (err) {
        // 第 4 條：**不得靜默回退成假向量**。沒錄到向量就誠實回報。
        return { ok: false, miss: `dedup1 取不到變式題的向量（EMBED_MODE=fixture）：${err.message}` };
    }
    let best = 0;
    for (const q of fixture.questions) {
        if (q.id === source.id) continue;                 // fixture 沒有 variant_of，家族鍵就是 id
        best = Math.max(best, cosine(vec, emb.vectorOf(q)));
    }
    return { ok: best < dupTh };
}

/** eval 的 ctx：ctx.db 一律 null（裁決 S2-8，cassette 鍵才可重現） */
function makeCtx({ llm, models, offtopicSimMin }) {
    const usage = { calls: 0, costUsd: 0 };
    const pricing = safeRequire(path.resolve(ROOT, 'config', 'pricing.js'));
    return {
        __usage: usage,
        llm: {
            async generateJson(opts) {
                const res = await llm.generateJson(opts);
                usage.calls += 1;
                if (pricing && typeof pricing.estimateCost === 'function') {
                    const spec = String(opts.model || '');
                    const modelId = spec.includes(':') ? spec.split(':').pop() : spec;
                    const c = pricing.estimateCost({
                        modelId,
                        tokenIn: res.usage?.tokenIn ?? 0,
                        tokenOut: res.usage?.tokenOut ?? 0,
                        tokenThinking: res.usage?.tokenThinking ?? 0,
                        tokenCached: res.usage?.tokenCached ?? 0
                    });
                    usage.costUsd += Number(c?.cost_usd ?? 0);
                }
                return res;
            },
            embed: (opts) => llm.embed(opts)
        },
        db: null,
        job: { id: 0, kind: 'variant', pdf_sha256: null, budget_usd: Infinity, cost_usd: 0 },
        jq: null,
        logger: { info() { }, warn() { }, error() { } },
        config: {
            models: {
                extract: models.MODEL_EXTRACT,
                verify: models.MODEL_VERIFY,
                variant: models.MODEL_VARIANT || models.MODEL_VERIFY
            },
            limits: {},
            thresholds: {
                classifyMinConf: Number(process.env.CLASSIFY_MIN_CONF || 0.8),
                dedupDup: Number(process.env.DEDUP_DUP_THRESHOLD || 0.97),
                dedupVariant: Number(process.env.DEDUP_VARIANT_THRESHOLD || 0.90),
                variantOfftopicSimMin: offtopicSimMin,
                variantMinEdit: Number(process.env.VARIANT_MIN_EDIT || 0.08),
                knnVoteSim: Number(process.env.KNN_VOTE_SIM || 0.90)
            },
            features: { similar: false, pipeline: true }
        },
        signal: undefined
    };
}

function safeRequire(abs) {
    try {
        return fs.existsSync(abs) ? require(abs) : null;
    } catch {
        return null;
    }
}

module.exports = { runVariantSuite, retrieveInMemory, cosine, loadVariantGolden, validateGoldenEntries, GATES, PER_SOURCE, AGENT_PATH };
