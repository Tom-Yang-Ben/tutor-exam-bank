// ─────────────────────────────────────────────────────────────
// eval/lib/suiteNlq.js — `eval/run.js --suite nlq`（docs/interfaces-stage3.md 第 8.2 條，WS-C）
//
// 三個指標，兩欄（rules / llm）：
//
//   rule_coverage   golden 50 句中「規則就抓到 ≥ 1 個章節」（confident === true）的比例。
//                   **只在 rules 欄有值，llm 欄恆為 null**——它量的是「有多少句不用花錢」，
//                   對 LLM 路徑而言這個數字沒有定義。
//   filters_exact   subject／chapters／question_types／difficulty_min+max **四欄全對**的比例
//                   （陣列先排序再比）。rules 欄只算 expect_path='rules' 的句子，
//                   llm 欄只算 expect_path='llm' 的句子——兩條路徑的正確率必須分開看，
//                   混在一起的話「規則很準但 LLM 很爛」會被平均掉。
//   recall10        對測試庫灌 fixture 後跑 hybrid，relevant 至少一題落在前 10 名的比例。
//
// ── recall10 為什麼常常是 n/a ──────────────────────────────────
// 裁決 S3-20：`semantic_text` 是**新字串**，`EMBED_MODE=fixture` 在
// eval/fixtures/embeddings.<model>.<dim>.json 裡查不到它的 sha256，`embed()` 會丟錯
// （interfaces-stage1.md 第 4 條：不得靜默回退成假向量）。那正是 nlqService 的 fallback_level 3，
// 量到的會是 LIKE 而不是 hybrid。
//
// 所以本 suite **先檢查每一句的查詢向量在不在 fixture 裡**：
//   - 全部在  → 跑真正的 hybrid，recall10 有數字；
//   - 有缺   → `recall10` 一律 n/a（不拿 LIKE 的數字冒充 hybrid 的 Recall），
//              另外報一個 `recall10_like_only`（退到 LIKE 之後）當參考值，並印出該錄哪幾句。
// 「不在缺數字時假裝通過」與 suiteClassify 的 replay miss 是同一條線。
//
// ── 這一支不改 eval/run.js ──────────────────────────────────
// eval/** 歸 WS-D（interfaces-stage2.md 第 10.1 條），本檔與 eval/golden/nlq.json、
// eval/cassettes/nlq/** 是 WS-C 的例外。golden 的載入與硬閘門因此寫在本檔裡，
// 不動 eval/lib/golden2.js。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { isValidChapter, isValidSubject, isValidQuestionType } = require('../../config/chapters');
const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
const { parseQuery } = require('../../utils/nlqHeuristics');
const { loadFixture } = require('./fixtures');
const { isPrivatePath } = require('./golden');
const metrics = require('./metrics');
const shims = require('./stage2Shims');
const replayMiss = require('./replayMiss');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_PATH = path.resolve(ROOT, 'services', 'nlqService.js');
const DEFAULT_GOLDEN = path.resolve(__dirname, '..', 'golden', 'nlq.json');
const RECALL_K = 10;

// ───────────────────────── golden 的載入與硬閘門 ─────────────────────────

/**
 * 逐句驗證，回傳「所有」問題（不是遇到第一個就停）——一次修完比修五輪省事。
 * golden 本身也要過硬閘門（規劃 §5.3.2）：期望的章節若不在白名單內，
 * filters_exact 就永遠不可能是 1，而報表上看起來只是「解析很爛」。
 * @returns {string[]}
 */
function validateNlqGolden(entries, fixtureById) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['nlq golden 的 entries 必須是非空陣列'];

    const seen = new Set();
    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (typeof e.id !== 'string' || e.id === '') { problems.push('id 必須是非空字串'); continue; }
        if (seen.has(e.id)) problems.push(`id「${e.id}」重複`);
        seen.add(e.id);

        if (typeof e.query !== 'string' || e.query.trim() === '') problems.push(`${at}：query 不可為空`);
        else if (e.query.length > 200) problems.push(`${at}：query 超過 200 字，端點會回 400`);

        if (e.expect_path !== 'rules' && e.expect_path !== 'llm') {
            problems.push(`${at}：expect_path 只能是 'rules' 或 'llm'（收到「${e.expect_path}」）`);
        }

        const x = e.expect;
        if (!x || typeof x !== 'object') { problems.push(`${at}：缺少 expect`); continue; }

        if (x.subject !== null && !isValidSubject(x.subject)) {
            problems.push(`${at}：expect.subject「${x.subject}」不在白名單`);
        }
        if (!Array.isArray(x.chapters)) problems.push(`${at}：expect.chapters 必須是陣列`);
        else {
            for (const c of x.chapters) {
                if (!x.subject || !isValidChapter(x.subject, c)) {
                    problems.push(`${at}：expect.chapters 的「${c}」不在「${x.subject}」的白名單`);
                }
            }
            if (x.chapters.length > 3) problems.push(`${at}：expect.chapters 超過 3 個（第 6.4 條會截斷，永遠對不上）`);
        }
        if (!Array.isArray(x.question_types)) problems.push(`${at}：expect.question_types 必須是陣列`);
        else for (const t of x.question_types) {
            if (!isValidQuestionType(t)) problems.push(`${at}：expect.question_types 的「${t}」不在白名單`);
        }
        for (const key of ['difficulty_min', 'difficulty_max']) {
            const v = x[key];
            if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) {
                problems.push(`${at}：expect.${key} 必須是 1~5 的整數或 null`);
            }
        }
        if (x.difficulty_min !== null && x.difficulty_max !== null && x.difficulty_min > x.difficulty_max) {
            problems.push(`${at}：expect.difficulty_min 大於 difficulty_max`);
        }
        if (typeof x.semantic_text !== 'string') problems.push(`${at}：expect.semantic_text 必須是字串`);

        if (!Array.isArray(e.relevant) || e.relevant.length === 0) {
            problems.push(`${at}：relevant 必須是非空的 fixture 題 id 陣列（沒有正樣本就量不了 Recall@10）`);
        } else if (fixtureById) {
            for (const id of e.relevant) {
                if (!fixtureById.has(id)) problems.push(`${at}：relevant 的 ${id} 不是 fixture 裡的題目`);
            }
        }
        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林`);
    }
    return problems;
}

/**
 * @param {{file?:string, fixtureById?:Map<number,object>}} [opts]
 * @returns {{file:string, isPrivate:boolean, version:number, entries:Array<object>, pendingConfirm:number}}
 */
function loadNlqGolden(opts = {}) {
    const target = path.resolve(opts.file || DEFAULT_GOLDEN);
    if (!fs.existsSync(target)) throw new Error(`找不到 nlq golden：${target}`);
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const problems = validateNlqGolden(raw.entries, opts.fixtureById);
    if (problems.length > 0) {
        throw new Error(`nlq golden 未通過硬閘門（${target}）：\n  - ${problems.join('\n  - ')}`);
    }
    return {
        file: target,
        isPrivate: isPrivatePath(target),
        version: raw.version,
        entries: raw.entries,
        pendingConfirm: raw.entries.filter(e => e.needs_human_confirm).length
    };
}

// ───────────────────────── 比對 ─────────────────────────

const sortedCopy = (a) => (Array.isArray(a) ? a.slice().sort() : []);

/**
 * 四欄 exact match：subject／chapters／question_types／difficulty_min+max。
 * 陣列先排序再比——「計算、單選」與「單選、計算」是同一組條件，
 * 讓語序影響分數只會製造噪音。
 * @returns {{ok:boolean, diff:string[]}}
 */
function filtersExact(expect, got) {
    const diff = [];
    if (expect.subject !== got.subject) diff.push(`subject: 期望 ${expect.subject} 得到 ${got.subject}`);
    if (JSON.stringify(sortedCopy(expect.chapters)) !== JSON.stringify(sortedCopy(got.chapters))) {
        diff.push(`chapters: 期望 [${expect.chapters}] 得到 [${got.chapters}]`);
    }
    if (JSON.stringify(sortedCopy(expect.question_types)) !== JSON.stringify(sortedCopy(got.question_types))) {
        diff.push(`question_types: 期望 [${expect.question_types}] 得到 [${got.question_types}]`);
    }
    if (expect.difficulty_min !== got.difficulty_min || expect.difficulty_max !== got.difficulty_max) {
        diff.push(`difficulty: 期望 ${expect.difficulty_min}~${expect.difficulty_max} 得到 ${got.difficulty_min}~${got.difficulty_max}`);
    }
    return { ok: diff.length === 0, diff };
}

/** rows 裡 ok 為 true 的比例；rows 為空回 null（沒有樣本不等於 0 分） */
function rate(rows, field = 'exact') {
    if (!rows.length) return null;
    return rows.filter(r => r[field]).length / rows.length;
}

// ───────────────────────── 檢索側 ─────────────────────────

/**
 * 查詢向量在不在 fixture 裡（裁決 S3-20）。
 * @returns {{available:boolean, missing:Array<{id:string, text:string}>}}
 */
function queryVectorsAvailable(rows) {
    const { fixturePath, sha256Hex } = require('../../services/llm/fixture');
    const model = process.env.EMBED_MODEL || 'gemini-embedding-001';
    const dim = Number(process.env.EMBED_DIM || 768);
    const file = fixturePath(model, dim);
    if (!fs.existsSync(file)) return { available: false, missing: rows.map(r => ({ id: r.id, text: r.queryText })) };

    const table = JSON.parse(fs.readFileSync(file, 'utf8'));
    const missing = rows.filter(r => !table[sha256Hex(r.queryText)]).map(r => ({ id: r.id, text: r.queryText }));
    return { available: missing.length === 0, missing };
}

/**
 * 把 fixture 灌進測試庫，對每一句跑一次 nlqService.retrieve()，量 Recall@10。
 *
 * 走的是 **prod 的那一支 retrieve()**，不是 suite 自己另寫一段 SQL：
 * eval 量到的必須就是端點真正跑的路徑（interfaces-stage1.md 第 5 條的精神）。
 *
 * @returns {Promise<{rows:Array<object>|null, warnings:string[], reason:string|null}>}
 */
async function measureRecall(rows, opts) {
    const warnings = [];
    const pgEngine = require('./pgEngine');
    if (!pgEngine.available()) {
        return { rows: null, warnings, reason: pgEngine.unavailableReason() };
    }

    const fixture = opts.fixture;
    const evalEmbedText = require('./embedText');
    const embeddings = require('./embeddings').loadEmbeddings({ questions: fixture.questions, optional: true });
    if (!embeddings.available) {
        return { rows: null, warnings, reason: embeddings.reason };
    }
    if (embeddings.missing.length) {
        return {
            rows: null, warnings,
            reason: `fixture 有 ${embeddings.missing.length} 題沒有向量（id=${embeddings.missing.slice(0, 5).join('、')}）：請在本機執行 npm run eval:record`
        };
    }

    // EMBED_MODE=record 時先把缺的查詢向量錄進 fixture（裁決 S3-R20：「同時開 record 跑一次」就該補齊）。
    // 沒有這一段，record 模式會在下面那一行短路（先檢查、查不到就 n/a），查詢向量永遠錄不進去。
    if (String(process.env.EMBED_MODE || '').toLowerCase() === 'record') {
        const pre = queryVectorsAvailable(rows);
        if (pre.missing.length) {
            const llm = require('../../services/llm');
            await llm.embed({ texts: pre.missing.map(m => m.text), taskType: 'RETRIEVAL_QUERY' });
            warnings.push(`[record] 已為 ${pre.missing.length} 句查詢補錄向量進 eval/fixtures/embeddings.*.json。`);
        }
    }

    // 查詢向量在不在？沒有的話 embed() 會丟錯，retrieve() 會退到 LIKE（fallback_level 3），
    // 量到的就不是 hybrid 的 Recall——寧可 n/a，也不要一個名不副實的數字。
    const check = queryVectorsAvailable(rows);
    const kwOnly = !check.available;
    if (kwOnly) {
        warnings.push(
            `${check.missing.length}/${rows.length} 句的查詢向量不在 eval/fixtures/embeddings.*.json 裡` +
            `（${check.missing.slice(0, 3).map(m => m.id).join('、')}${check.missing.length > 3 ? ' …' : ''}）：` +
            'recall10 這一輪一律 n/a，改報「退到 LIKE 之後」的 recall10_like_only 當參考值（那正是 fallback_level 3 的實際表現）。' +
            '要有真數字請在本機同時開 LLM_MODE=record 與 EMBED_MODE=record 跑一次（裁決 S3-20）。'
        );
    }

    await pgEngine.seedFixture({
        questions: fixture.questions,
        vectorOf: embeddings.vectorOf,
        embedTextOf: (q) => evalEmbedText.buildEmbedText(q),
        hashOf: (t) => evalEmbedText.embedHash(t),
        model: embeddings.model
    });

    const nlqService = require(SERVICE_PATH);
    const { requireDb } = pgEngine;
    const db = requireDb();

    // fixture id === questions.id（seedFixture 有 RESTART IDENTITY），但還是照 idMap 走比較安全
    for (const row of rows) {
        try {
            const res = await nlqService.retrieve(db, {
                filters: row.got,
                // 裁決 S3-21：解析漂移時改用 golden 的 expect.semantic_text 去 embed()，
                // 讓 recall10 量的是「檢索本身」而不是「這一輪解析剛好漂掉」。
                semanticText: row.queryText,
                rawQuery: row.query,
                limit: RECALL_K,
                excludeStudentId: null,
                llm: kwOnly ? likeOnlyLlm() : require('../../services/llm'),
                logger: { warn() {}, info() {}, error() {} }
            });
            const ranked = res.results.map(r => r.id);
            row.recallHit = row.relevant.some(id => ranked.includes(id));
            row.fallbackLevel = res.fallbackLevel;
            row.ranked = ranked;
        } catch (err) {
            row.recallHit = false;
            row.recallError = err.message;
        }
    }

    return { rows, warnings, reason: null, kwOnly };
}

/**
 * 讓 retrieve() 退到 LIKE 的假 llm：embed() 直接丟錯 → fallback_level 3。
 * 這條路的數字**只當參考值**，不會寫進 measured.recall10。
 */
function likeOnlyLlm() {
    return {
        async embed() { throw new Error('suiteNlq：查詢向量不在 fixture 裡，改量 fallback_level 3 的 LIKE'); },
        async generateJson() { throw new Error('suiteNlq：不該在這裡呼叫 generateJson'); }
    };
}

/**
 * 攔得到 generateJson 錯誤的 llm 包裝。
 *
 * 為什麼需要它：第 6.3 條要求 nlqService **逾時／schema 不合／供應商錯誤一律不 throw**，
 * 改走 fallback_level 1。這對端點是對的，但對 eval 是致命的——
 * 一支 cassette 都沒錄的時候，50 句會全部安靜地變成 parse_path='llm_failed'，
 * 報表上看起來是「LLM 路徑正確率 0%」，其實是「一次都沒真的問過」。
 * 所以這裡把錯誤原文攔下來，交給 replayMiss 判斷（與 suiteClassify 同一條線）。
 *
 * @param {(err:Error)=>void} onError
 */
function capturingLlm(onError) {
    const real = require('../../services/llm');
    return {
        embed: (...a) => real.embed(...a),
        async generateJson(...a) {
            try {
                return await real.generateJson(...a);
            } catch (err) {
                onError(err);
                throw err;
            }
        }
    };
}

// ───────────────────────── 主體 ─────────────────────────

/**
 * @param {object} args run.js 的 args（--golden 會被讀）
 * @returns {Promise<object>} 第 8.1 條的形狀
 */
async function runNlqSuite(args = {}) {
    const warnings = [];
    const failures = [];
    const misses = [];
    const missIds = new Set();

    const fixture = loadFixture();
    const golden = loadNlqGolden({ file: args.golden || undefined, fixtureById: fixture.byId });
    if (golden.pendingConfirm > 0) {
        warnings.push(`nlq golden 有 ${golden.pendingConfirm}/${golden.entries.length} 筆仍是 needs_human_confirm 的草稿，尚未人工定案。`);
    }

    const serviceExists = fs.existsSync(SERVICE_PATH);
    if (!serviceExists) {
        warnings.push('services/nlqService.js 尚未合入：filters_exact 與 recall10 全部印 n/a，本輪只驗證 golden 過得了硬閘門。');
    }
    const nlqService = serviceExists ? require(SERVICE_PATH) : null;

    // ── 解析每一句 ─────────────────────────────────────────
    const rows = [];
    for (const e of golden.entries) {
        // rule_coverage 一律直接問純函式：它不需要 nlqService，也不受 LLM 影響
        const rules = parseQuery(e.query, { aliases: CHAPTER_ALIASES });

        const row = {
            id: e.id,
            query: e.query,
            expect_path: e.expect_path,
            relevant: e.relevant.slice(),
            confident: rules.confident,
            // 裁決 S3-21：向量側用 golden 的 expect.semantic_text，不是這一輪解析出來的
            queryText: e.expect.semantic_text || e.query,
            got: null,
            parse_path: null,
            exact: false,
            diff: [],
            drifted: false
        };

        if (nlqService) {
            let parsed;
            const captured = [];
            try {
                parsed = await nlqService.parseOnly({
                    query: e.query,
                    noCache: true,                       // 快取會讓「同一句只問一次」變成量測噪音
                    llm: capturingLlm(err => captured.push(err)),
                    logger: { warn() {}, info() {}, error() {} }
                });
            } catch (err) {
                parsed = null;
                failures.push(`${e.id}：解析丟出例外——${err.message}`);
            }

            // nlqService 依第 6.3 條不會 throw，replay miss 只能從攔下來的錯誤看出來。
            // 原文要**原樣**放進 failures（run.js 的 partitionFailures 是用 startsWith
            // 比對凍結前綴的，裁決 S2-14），不加 `${e.id}：` 前綴。
            for (const err of captured) {
                if (replayMiss.isReplayMiss(err.message)) { misses.push(err.message); missIds.add(e.id); }
                else { failures.push(`${e.id}：generateJson 失敗——${err.message}`); }
            }

            if (parsed) {
                row.got = parsed.filters;
                row.parse_path = parsed.parse_path;
                const cmp = filtersExact(e.expect, parsed.filters);
                row.exact = cmp.ok;
                row.diff = cmp.diff;
                // parse_path='llm_failed' 時 semantic_text 只是規則的輸出，
                // 拿它跟 golden 比是在量一件沒發生的事——不報漂移。
                row.drifted = parsed.parse_path !== 'llm_failed' && parsed.semantic_text !== e.expect.semantic_text;
                if (row.drifted) {
                    warnings.push(
                        `${e.id}：semantic_text 與 golden 不同（golden「${e.expect.semantic_text}」／` +
                        `這一輪「${parsed.semantic_text}」）——recall10 已改用 golden 的值去 embed()（裁決 S3-21）。`
                    );
                }
                if (e.expect_path === 'llm' && parsed.parse_path === 'rules') {
                    warnings.push(`${e.id}：golden 標成 expect_path='llm'，但規則就抓到章節了（沒有呼叫 LLM）。`);
                }
            }
        }
        rows.push(row);
    }

    // parse_path 的實際分布（成本指標：走 rules 的那些句子是零成本的）
    const pathCounts = { rules: 0, llm: 0, llm_failed: 0, unknown: 0 };
    for (const r of rows) pathCounts[r.parse_path || 'unknown'] += 1;

    // ── Recall@10 ────────────────────────────────────────
    // replay miss **不擋** recall10：miss 只發生在 8 句 LLM 路徑的解析上，
    // 檢索本身照樣跑得起來，而 rules 欄那 42 句根本沒碰過 LLM。
    // （llm 欄的 recall10 另外在下面被強制 n/a。）
    let recallReady = false;
    let kwOnly = false;
    if (nlqService) {
        try {
            const res = await measureRecall(rows, { fixture });
            warnings.push(...res.warnings);
            if (res.rows) { recallReady = true; kwOnly = Boolean(res.kwOnly); }
            else warnings.push(`recall10 這一輪是 n/a：${res.reason}`);
        } catch (err) {
            warnings.push(`recall10 這一輪是 n/a：${err.message.split('\n')[0]}`);
        }
    }

    // ── 分欄 ─────────────────────────────────────────────
    const byColumn = {
        rules: rows.filter(r => r.expect_path === 'rules'),
        llm: rows.filter(r => r.expect_path === 'llm')
    };

    // rules 欄的句子**一次 LLM 都不會呼叫**（規則就抓到章節了），所以 cassette 沒錄
    // 不影響它的數字；llm 欄只要有一句 replay miss，整欄就得 n/a——
    // 部分回放的分數只反映「哪幾句剛好錄過」。
    const llmMeasurable = nlqService && !missIds.size;
    const recallRate = (list) => {
        if (!recallReady || kwOnly) return null;
        const sub = list.filter(r => r.recallHit !== undefined);
        return sub.length ? sub.filter(r => r.recallHit).length / sub.length : null;
    };

    const measured = {
        rules: nlqService ? {
            // 第 8.2 條：rule_coverage 只在 rules 欄有值
            rule_coverage: metrics.round4(rows.filter(r => r.confident).length / rows.length),
            filters_exact: metrics.round4(rate(byColumn.rules)),
            recall10: metrics.round4(recallRate(byColumn.rules))
        } : null,
        llm: llmMeasurable ? {
            rule_coverage: null,
            filters_exact: metrics.round4(rate(byColumn.llm)),
            recall10: metrics.round4(recallRate(byColumn.llm))
        } : null
    };

    // 參考值：退到 LIKE（fallback_level 3）之後的 Recall@10。
    // **不進 measured**，因此不會被 ratchet 寫成門檻——它量的不是 hybrid。
    const recall10LikeOnly = recallReady && kwOnly
        ? metrics.round4(rows.filter(r => r.recallHit).length / rows.length)
        : null;

    if (misses.length) {
        warnings.push(
            `${misses.length} 句是 replay miss（${[...missIds].slice(0, 5).join('、')}${missIds.size > 5 ? ' …' : ''}）：` +
            'eval/cassettes/nlq/ 尚未涵蓋這份 golden。llm 欄這一輪一律 n/a——' +
            '部分回放的分數只反映「哪幾句剛好錄過」。rules 欄不受影響（那些句子本來就不呼叫 LLM）。'
        );
    }

    return {
        suite: 'nlq',
        measured,
        failures: [...misses, ...failures],
        warnings,
        pathCounts,
        recall10LikeOnly,
        drifted: rows.filter(r => r.drifted).map(r => r.id),
        meta: {
            service: serviceExists ? 'services/nlqService.js' : '（未合入）',
            llmMode: process.env.LLM_MODE || 'replay',
            embedMode: process.env.EMBED_MODE || 'fixture',
            cassetteDir: process.env.EVAL_CASSETTE_DIR || 'eval/cassettes',
            golden: golden.isPrivate ? '（私有層，路徑不記錄）'
                : path.relative(ROOT, golden.file).replace(/\\/g, '/'),
            goldenEntries: golden.entries.length,
            goldenPending: golden.pendingConfirm,
            fixture: path.relative(ROOT, fixture.file).replace(/\\/g, '/'),
            sources: shims.sources()
        },
        perEntry: golden.isPrivate ? [] : rows.map(r => ({
            id: r.id,
            expect_path: r.expect_path,
            parse_path: r.parse_path,
            confident: r.confident,
            exact: r.exact,
            diff: r.diff,
            drifted: r.drifted,
            recall_hit: r.recallHit ?? null,
            fallback_level: r.fallbackLevel ?? null
        })),
        isPrivate: golden.isPrivate
    };
}

module.exports = {
    runNlqSuite,
    // 給單元測試用（不是第 8.1 條凍結形狀的一部分）
    loadNlqGolden, validateNlqGolden, filtersExact, queryVectorsAvailable,
    SERVICE_PATH, DEFAULT_GOLDEN, RECALL_K
};
