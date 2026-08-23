// agents/classify.js — 章節分類節點（A-T9；docs/interfaces-stage2.md 第 3.1／3.3 條）
//
//   input  : { subject, chapter, chapter_confidence, question_text }
//   outcome: {kind:'pass', data:{chapter, confidence, rationale, source, few_shot_ids?}}
//            {kind:'fail', reason:'chapter_invalid', feedback:'…'}
//            {kind:'error', errorClass:…}
//
// 兩層：
//
//   第一層（零成本閘門）：拆題模型給的章節本來就在白名單內、而且它自己的信心 ≥ CLASSIFY_MIN_CONF
//   → 直接 pass，**一次 LLM 都不呼叫**。這一層的通過率是階段 2 最重要的成本指標
//   （report:jobs 會印；> 95% 就代表這個節點可以降為抽樣）。
//   `chapter_confidence` **缺值或 0 一律視為閘門不過**，不得當成 1.0（裁決 S2-13）。
//
//   第二層（few-shot + LLM）：只有第一層沒過的題才走到。few-shot 候選依序：
//     A. 向量最近鄰 **8** 題（`ctx.config.features.similar` 為真、且有 `ctx.db` 時；裁決 S2-8）
//     B. 題庫各章各取 2 題
//     C. config/chapterExamples.js 的自製例句（補上 A/B 取不到的章；永遠執行）
//   取材失敗一律降級，不算節點失敗。
//   輸出**再過一次** isValidChapter：schema 的 enum 是兩科合併的 66 個，
//   模型可能給出「物理題配到數學章節」這種跨科錯配，只有伺服器端擋得住。
//
//   ── 階段 3（interfaces-stage3.md 第 5 條，P-14）──
//   A 層改成「檢索式 few-shot」：k=8、排除同一份 PDF 的題、`'knn'` 也可以當範例；
//   並在 A 層與 LLM 之間插一個 **kNN 投票短路**（第 5.2 條）：最近 5 個鄰居裡
//   ≥ 4 題是**人工確認**的同一章、且最近鄰餘弦 ≥ `KNN_VOTE_SIM` → 直接 pass，
//   `source='knn'`、入庫時 `chapter_src='knn'`，**一次 LLM 都不呼叫**。
//   `'knn'` 與 `'ai'` **沒有投票權**：自動標籤餵回自動投票是閉環放大器（規劃 §4.4）。
//   題庫初期沒有人工標籤時短路率就是 0——這是誠實的起點，不是 bug。
//   第一層閘門與 `cacheKeyParts.fewShotIds` 的算法**一個字都沒改**，既有 cassette 全部不失效。
//
// ⚠ 錄 cassette 與跑 eval 時 **ctx.db 一律為 null**（裁決 S2-8）：cassette 的鍵含 fewShotIds，
//   接了資料庫錄出來的鍵帶著一串題目 id，CI 沒有那個庫、fewShotIds 會是 []，鍵對不上、全部 miss。

const { CHAPTERS, isValidChapter, isValidSubject } = require('../config/chapters');
const { getChapterExample } = require('../config/chapterExamples');
const { buildSchema } = require('./schemas');
const { chapterWhitelistText } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'classify.v1';
const DEFAULT_MIN_CONF = 0.8;
const FEW_SHOT_K = 8;              // 向量最近鄰取幾題（階段 3 第 5.1 條把 5 改成 8）
const KNN_VOTE_N = 5;              // 投票只看最近的幾個鄰居（第 5.2 條）
const KNN_VOTE_MIN_HUMAN = 4;      // 這 5 個裡至少幾題是「人工確認且同章」
const DEFAULT_KNN_VOTE_SIM = 0.90; // 最近鄰餘弦下限（ctx.config.thresholds.knnVoteSim）
const PER_CHAPTER_EXAMPLES = 2;    // 各章取幾題（規劃 §3.3.4）
const RATIONALE_MAX = 200;         // 第 3.2 條：rationale ≤ 200 字

const SYSTEM = '你是一位資深的台灣高中數學與物理家教老師，正在替題庫的題目標註精細章節。你只輸出 JSON，不輸出任何其他文字。';

const PROMPT_TEMPLATE = `請判斷下面這道題目屬於哪一個精細章節。

{{CHAPTER_WHITELIST}}

【規則】
1. chapter 必須「完全等於」白名單裡的某一個字串，一個字都不能差，也不得自創新詞。
2. 判斷依據是「解這一題需要用到哪一章的觀念」，不是題目裡出現了哪些名詞。例如用到向量夾角公式的題目屬於向量內積，即使題幹在講風力或斜面。
3. 若題目橫跨兩章，選「非用不可」的那一章；只是順帶用到的計算工具不算。
4. confidence 請誠實給分：低於門檻的題目會被送去人工複核，這比標錯章節便宜得多。

{{FEW_SHOT}}

{{FEEDBACK}}

【要分類的題目】
{{QUESTION}}`;

registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

// ───────────────────────── 純函式 ─────────────────────────

/** 字串切成相鄰字元的 bigram 集合（中文沒有空白可切，用 bigram 當粗略的「詞」） */
function bigrams(text) {
    const s = String(text || '');
    const set = new Set();
    if (s.length === 1) set.add(s);
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
}

/** Dice 係數：兩個集合的重疊程度，0~1 */
function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const g of a) if (b.has(g)) common += 1;
    return (2 * common) / (a.size + b.size);
}

/** 單字元集合（bigram 完全不重疊時的第二把尺：「電磁學」與「靜電學」共用「電」「學」） */
function chars(text) {
    return new Set(String(text || ''));
}

/**
 * 找出白名單內與 value 最像的幾章（給失敗 feedback 用）。
 * 分數 = 0.7×bigram Dice + 0.3×單字元 Dice：只用 bigram 的話，
 * 「電磁學」對每一章都是 0 分，回出來的兩個候選會是宣告順序的前兩章（毫無幫助）。
 * 同分時依 config/chapters.js 的宣告順序——確定性，同一個輸入永遠回同一組候選。
 * @returns {string[]}
 */
function nearestChapters(subject, value, k = 2) {
    const list = isValidSubject(subject) ? CHAPTERS[subject] : Object.values(CHAPTERS).flat();
    const targetBi = bigrams(value);
    const targetCh = chars(value);
    return list
        .map((chapter, order) => ({
            chapter,
            order,
            score: 0.7 * dice(targetBi, bigrams(chapter)) + 0.3 * dice(targetCh, chars(chapter))
        }))
        .sort((a, b) => (b.score - a.score) || (a.order - b.order))
        .slice(0, k)
        .map(x => x.chapter);
}

/**
 * 失敗時的 feedback，格式凍結（第 3.3 條）：
 *   「${回傳值}」不在白名單內，最接近的是「${候選1}」「${候選2}」
 */
function invalidChapterFeedback(subject, value) {
    const near = nearestChapters(subject, value, 2);
    return `「${value}」不在白名單內，最接近的是${near.map(c => `「${c}」`).join('')}`;
}

/** rationale 太長就截斷（schema 不設 maxLength：那會讓「話多」變成整題失敗，代價不成比例） */
function clampRationale(text) {
    const s = String(text ?? '').trim();
    return s.length > RATIONALE_MAX ? `${s.slice(0, RATIONALE_MAX - 1)}…` : s;
}

/** few-shot 例句 → prompt 區塊 */
function fewShotText(examples) {
    if (!examples.length) return '';
    const lines = examples.map(e => `- 題目：${oneLine(e.question_text)}\n  章節：${e.chapter}`);
    return `【已標註好的範例（章節都是正確的，請照這個粒度判斷）】\n${lines.join('\n')}`;
}

function oneLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function thresholdOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    const v = Number(t.classifyMinConf);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MIN_CONF;
}

/** kNN 投票短路的最近鄰餘弦下限（第 4.5 條：由 runner 從 KNN_VOTE_SIM 組進 thresholds） */
function knnVoteSimOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    const v = Number(t.knnVoteSim);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_KNN_VOTE_SIM;
}

// ───────────────────────── few-shot 取材 ─────────────────────────

/**
 * A. 向量最近鄰（需要 FEATURE_SIMILAR、DB、以及可用的 embedding）。
 *
 * 階段 3（interfaces-stage3.md 第 5.1 條）改了三件事，SQL 逐字凍結在那一條：
 *   1. `k = 8`（原本 5）；
 *   2. `chapter_src` 三種都可以當**範例**（`'human'`／`'ai'`／`'knn'`），
 *      但排序上 human 先——階段 2 這裡是 `IN ('human','ai')`，把 `'knn'` 排除在範例之外；
 *      第 5.2 條把「不得當範例」收窄成「**不得有投票權**」，範例仍可用。
 *   3. **排除同一份 PDF 的題**：`LEFT JOIN job_questions/jobs` + `IS DISTINCT FROM`。
 *      用 `LEFT JOIN` 而不是 `JOIN`、用 `IS DISTINCT FROM` 而不是 `<>`，是因為
 *      `seed`／`manual`／`variant` 這些題沒有 job 列，`j.pdf_sha256` 是 NULL：
 *      `NULL <> 'abc…'` 是 NULL（假），會把它們**整批**排掉；
 *      `NULL IS DISTINCT FROM 'abc…'` 才是真。這條 join 存在的唯一理由就是這個。
 *      `ctx.job.pdf_sha256` 為 NULL（變式 job）時所有題都留著。
 *
 * @returns {Promise<Array<{id, chapter, chapter_src, question_text, cosine}>|null>}
 *          **依距離排序**的原始列（kNN 投票要用這個順序，不是 examples 的順序）
 */
async function fewShotByVector(ctx, { subject, chapter, question_text }) {
    // 旗標只能從 ctx.config.features 讀（裁決 S2-8：runner 從 config/features.js 組成
    // { similar, pipeline }）——agent 不得自己讀 process.env。
    const features = (ctx.config && ctx.config.features) || {};
    if (features.similar !== true || !ctx.db || typeof ctx.db.query !== 'function') return null;
    if (!ctx.llm || typeof ctx.llm.embed !== 'function') return null;

    const { buildEmbedText } = require('../utils/embedText');
    const pgvector = require('pgvector');

    const text = buildEmbedText({
        subject,
        chapter: chapter || '',
        question_type: '計算',
        difficulty: 3,
        question_text
    });
    const { vectors } = await ctx.llm.embed({ texts: [text] });
    if (!vectors || !vectors[0]) return null;

    const { rows } = await ctx.db.query(
        `SELECT q.id, q.chapter, q.chapter_src, q.question_text,
                1 - (q.embedding <=> $2::vector) AS cosine
           FROM questions q
           LEFT JOIN job_questions jq ON jq.question_id = q.id
           LEFT JOIN jobs j           ON j.id = jq.job_id
          WHERE q.subject = $1
            AND q.archived_at IS NULL
            AND q.embedding IS NOT NULL
            AND q.chapter_src IN ('human','ai','knn')
            AND (j.pdf_sha256 IS DISTINCT FROM $3)
          ORDER BY q.embedding <=> $2::vector, q.id
          LIMIT ${FEW_SHOT_K}`,
        [subject, pgvector.toSql(vectors[0]), (ctx.job && ctx.job.pdf_sha256) || null]
    );
    if (!rows.length) return null;
    return rows.map(r => ({
        id: r.id, chapter: r.chapter, chapter_src: r.chapter_src,
        question_text: r.question_text, cosine: Number(r.cosine)
    }));
}

/**
 * few-shot 範例的排序（第 5.1 條凍結）：**先 `human`（依距離），再 `ai`／`knn`（依距離）**。
 *
 * 只重排，不篩掉任何一題——`fewShotIds` 是「examples 裡的整數 id 由小到大」，
 * 與順序無關，所以 cassette 的鍵不受影響（第 5.1 條末句）。
 *
 * @param {Array<{chapter_src?:string}>} rows 依距離排序的原始列
 * @returns {Array<object>} 新陣列
 */
function orderExamples(rows) {
    const human = [];
    const rest = [];
    for (const r of rows || []) (r.chapter_src === 'human' ? human : rest).push(r);
    return [...human, ...rest];
}

/**
 * kNN 投票短路（第 5.2 條、裁決 S3-15）。
 *
 * 三個條件同時成立才短路：
 *   1. 最近的 5 個鄰居裡**至少 4 個**滿足 `chapter_src === 'human' && chapter === top`；
 *   2. `rows[0].cosine >= KNN_VOTE_SIM`；
 *   3. `isValidChapter(subject, top)`。
 *
 * **`'knn'` 與 `'ai'` 沒有投票權**：條件 1 只數 `'human'`。自動標籤餵回自動投票是閉環放大器，
 * 錯一題會自我強化成一串同錯題（規劃 §4.4）。題庫初期沒有人工標籤時短路率就是 0，
 * **這是誠實的起點，不是 bug**。
 *
 * @param {Array<{chapter, chapter_src, cosine}>} rows 依距離排序的原始列
 * @param {string} subject
 * @param {number} minSim
 * @returns {{ok:true, chapter:string, cosine:number, humanVotes:number}|{ok:false}}
 */
function knnVote(rows, subject, minSim) {
    const list = Array.isArray(rows) ? rows.slice(0, KNN_VOTE_N) : [];
    if (list.length === 0) return { ok: false };

    const top = list[0].chapter;
    const humanVotes = list.filter(r => r.chapter_src === 'human' && r.chapter === top).length;
    const nearest = Number(list[0].cosine);

    if (humanVotes < KNN_VOTE_MIN_HUMAN) return { ok: false };
    if (!Number.isFinite(nearest) || nearest < minSim) return { ok: false };
    if (!isValidChapter(subject, top)) return { ok: false };

    return { ok: true, chapter: top, cosine: nearest, humanVotes };
}

/** B. 題庫各章各取 PER_CHAPTER_EXAMPLES 題（一句 SQL，順序確定） */
async function fewShotByChapter(ctx, { subject }) {
    if (!ctx.db || typeof ctx.db.query !== 'function') return [];
    const { rows } = await ctx.db.query(
        `SELECT id, chapter, question_text FROM (
             SELECT id, chapter, question_text,
                    row_number() OVER (PARTITION BY chapter ORDER BY id) AS rn
               FROM questions
              WHERE subject = $1
                AND archived_at IS NULL
                AND question_text IS NOT NULL
                AND chapter_src IN ('human','ai')
         ) t
         WHERE rn <= $2
         ORDER BY chapter, id`,
        [subject, PER_CHAPTER_EXAMPLES]
    );
    return rows.map(r => ({ id: r.id, chapter: r.chapter, question_text: r.question_text }));
}

/** C. 自製例句，補上 A/B 沒有涵蓋到的章（保證每一章都有東西可舉例） */
function fewShotFromConfig(subject, covered) {
    const list = isValidSubject(subject) ? CHAPTERS[subject] : [];
    const out = [];
    for (const chapter of list) {
        if (covered.has(chapter)) continue;
        const example = getChapterExample(subject, chapter);
        if (example && example.trim()) out.push({ id: null, chapter, question_text: example.trim() });
    }
    return out;
}

/**
 * 組出 few-shot 例句與它們的 id 清單。
 * @returns {Promise<{examples:Array<object>, ids:number[], source:'vector'|'chapter'|'config',
 *                    neighbors:Array<object>}>}
 *          `neighbors` 是 A 層**依距離排序**的原始列（kNN 投票用），取不到時是空陣列。
 */
async function gatherFewShot(ctx, input) {
    const logger = (ctx && ctx.logger) || console;
    let examples = [];
    let source = 'config';
    let neighbors = [];

    try {
        const byVector = await fewShotByVector(ctx, input);
        if (byVector && byVector.length) {
            neighbors = byVector;              // 原始距離順序，投票要用
            examples = orderExamples(byVector); // 範例順序：human 先，再 ai／knn
            source = 'vector';
        }
    } catch (err) {
        // 取不到向量不是失敗——退回題庫例句就好（EMBED_MODE=fixture 的 CI 一定會走到這裡）
        logger.warn?.({ node: 'classify', msg: `向量 few-shot 取材失敗，改用題庫各章取例：${err.message}` });
    }

    if (!examples.length) {
        try {
            const byChapter = await fewShotByChapter(ctx, input);
            if (byChapter.length) {
                examples = byChapter;
                source = 'chapter';
            }
        } catch (err) {
            logger.warn?.({ node: 'classify', msg: `題庫 few-shot 取材失敗，改用自製例句：${err.message}` });
        }
    }

    const covered = new Set(examples.map(e => e.chapter));
    examples = examples.concat(fewShotFromConfig(input.subject, covered));

    const ids = examples.map(e => e.id).filter(id => Number.isInteger(id));
    return { examples, ids, source, neighbors };
}

// ───────────────────────── 節點主體 ─────────────────────────

/**
 * @param {object} ctx
 * @param {{subject:string, chapter?:string, chapter_confidence?:number, question_text:string, feedback?:string}} input
 * @returns {Promise<object>} outcome
 */
async function run(ctx, input = {}) {
    try {
        const subject = input.subject;
        const questionText = String(input.question_text ?? '').trim();

        if (!isValidSubject(subject)) {
            return {
                kind: 'fail',
                reason: 'chapter_invalid',
                feedback: `學科「${input.subject}」不在白名單內，只接受「數學」「物理」`
            };
        }
        if (!questionText) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: 'classify：question_text 是空的。' };
        }

        // ── 第一層：零成本閘門 ──
        // 裁決 S2-13：chapter_confidence **缺值或 0 一律視為閘門不過**，不得當成 1.0。
        // 這條看起來多餘（0 >= 0.8 本來就是 false），但把它寫死才擋得住兩種情況：
        // 有人把 CLASSIFY_MIN_CONF 設成 0，以及未來有人「順手」把缺值補成預設高分。
        const minConf = thresholdOf(ctx);
        const confidence = Number(input.chapter_confidence);
        const confidenceUsable = Number.isFinite(confidence) && confidence > 0;
        if (isValidChapter(subject, input.chapter) && confidenceUsable && confidence >= minConf) {
            return {
                kind: 'pass',
                data: {
                    chapter: input.chapter,
                    confidence,
                    rationale: `拆題模型給的章節在白名單內，且信心 ${confidence} ≥ ${minConf}，零成本閘門直接採用。`,
                    source: 'gate'
                }
            };
        }

        // ── 第二層：few-shot + LLM ──
        const { examples, ids, neighbors } = await gatherFewShot(ctx, { ...input, subject, question_text: questionText });
        const fewShotIds = ids.slice().sort((a, b) => a - b);

        // ── 第二層之前的 kNN 投票短路（第 5.2 條）：成立時**不呼叫 LLM** ──
        const vote = knnVote(neighbors, subject, knnVoteSimOf(ctx));
        if (vote.ok) {
            return {
                kind: 'pass',
                data: {
                    chapter: vote.chapter,
                    confidence: vote.cosine,
                    rationale: clampRationale(
                        `最近 5 個鄰居中有 ${vote.humanVotes} 題人工確認的「${vote.chapter}」，` +
                        `最近鄰餘弦 ${vote.cosine.toFixed(4)} ≥ ${knnVoteSimOf(ctx)}，採用 kNN 投票。`),
                    source: 'knn',
                    few_shot_ids: fewShotIds
                }
            };
        }

        // 上一次失敗的具體理由（runner 會把 outcome.feedback 寫進 payload.classify.feedback）
        const feedback = input.feedback
            || (ctx.jq && ctx.jq.payload && ctx.jq.payload.classify && ctx.jq.payload.classify.feedback)
            || '';

        const prompt = PROMPT_TEMPLATE
            .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText(subject))
            .replace('{{FEW_SHOT}}', fewShotText(examples))
            .replace('{{FEEDBACK}}', feedback ? `【上一次的錯誤，請不要再犯】\n${feedback}` : '')
            .replace('{{QUESTION}}', questionText);

        const res = await ctx.llm.generateJson({
            model: (ctx.config && ctx.config.models && ctx.config.models.extract) || undefined,
            system: SYSTEM,
            parts: [{ text: prompt }],
            schema: buildSchema('classify'),
            signal: ctx.signal,
            agent: 'classify',
            template: TEMPLATE,
            // 第 5.2 條：鍵納入 few-shot 的 **id 清單**而不是全文——
            // 題庫多一題、排序微動就換一份 cassette 的話，紅燈全是噪音。
            cacheKeyParts: { template: TEMPLATE, questionText, fewShotIds }
        });

        const data = res.data || {};
        if (!isValidChapter(subject, data.chapter)) {
            return {
                kind: 'fail',
                reason: 'chapter_invalid',
                feedback: invalidChapterFeedback(subject, data.chapter),
                data: {
                    chapter: data.chapter ?? null,
                    confidence: Number(data.confidence) || 0,
                    rationale: clampRationale(data.rationale),
                    source: 'llm',
                    few_shot_ids: fewShotIds
                }
            };
        }

        return {
            kind: 'pass',
            data: {
                chapter: data.chapter,
                confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
                rationale: clampRationale(data.rationale),
                source: 'llm',
                few_shot_ids: fewShotIds
            }
        };
    } catch (err) {
        return {
            kind: 'error',
            errorClass: err.errorClass || 'provider_error',
            message: err.message
        };
    }
}

module.exports = {
    run,
    // 給單元測試與 cassette 錄製腳本用
    nearestChapters, invalidChapterFeedback, gatherFewShot, fewShotText, clampRationale,
    // 階段 3（第 5 條）
    knnVote, orderExamples,
    TEMPLATE, SYSTEM, PROMPT_TEMPLATE,
    FEW_SHOT_K, KNN_VOTE_N, KNN_VOTE_MIN_HUMAN, DEFAULT_KNN_VOTE_SIM
};
