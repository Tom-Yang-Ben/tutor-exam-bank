// services/nlqService.js — 自然語言查題（docs/interfaces-stage3.md 第 6 條，P-08）
//
//   POST /api/questions/search-nl
//   body  { query: string(1~200), student_id?: int>0, limit?: int 1~50 = 20 }
//   200   { filters:{八個鍵一律出現}, parse_path, fallback_level, warnings, results }
//
// 設計原則（規劃 §4.4）：**規則優先、受限 JSON、SQL 固定**。
//
//   1. utils/nlqHeuristics.js 的 parseQuery() 先跑。抓到 ≥ 1 個章節（confident）就結束，
//      **一次 LLM 都不呼叫**——這個查詢語言的詞彙極小，規則抓得到的比例才是主要指標。
//   2. 規則抓不到章節、而剩下的文字還有實詞時才呼叫 generateJson()，schema 全是
//      enum／整數／字串陣列（agents/schemas/nlq.json）。模型只負責填空，SQL 一個字都不改。
//   3. 不論條件來自規則還是 LLM，**伺服器一律再驗一次**（第 6.4 條）：白名單、難度、
//      學生名。不合法的丟掉那一個並附警告，不是整包退回——使用者打錯一個章節名，
//      不該讓整句查詢失敗。
//   4. 檢索走 queries/hybrid.js（與 /similar、eval 同一段 SQL），四級回退階梯（第 6.6 條）
//      把「LLM 掛了」「查不到東西」「沒有 embedding 服務」三種降級誠實回報給前端，
//      不靜默假裝正常。
//
// ── 兩個必須說清楚的實作決定（介面沒有規定，屬於各 WS 的自由）──
//
//   a. buildHybridQuery **沒有 question_type 參數**（interfaces.md 第 5 條，凍結）。
//      題型條件因此以「候選排除集」表達：先用一句便宜的 metadata 查詢撈出
//      「同 subject／chapter／難度區間，但題型不對」的 id，再經 excludeIds 傳進去。
//      這樣題型是**精確**篩選，limit 的語意也不變（先取 limit 再過濾會少給結果）。
//      見 docs/archive/questions3-wsC.md 第 2 題。
//
//   b. body 的 student_id 與句子裡解析出的「某某沒寫過」都會落到同一個
//      excludeStudentId：句子裡指名的優先（那是使用者當下明確講的），
//      沒指名時才用 body 帶進來的。見 docs/archive/questions3-wsC.md 第 3 題。
//
// 這一支是 service 不是 agent，所以可以讀 process.env（agent 不得自己讀，
// interfaces-stage2.md 第 3.1 條；那條規範的是 agents/**）。

const crypto = require('crypto');

const {
    CHAPTERS, SUBJECTS,
    isValidSubject, isValidChapter, isValidQuestionType, normalizeDifficulty
} = require('../config/chapters');
const { CHAPTER_ALIASES, subjectOfChapter } = require('../config/chapterAliases');
const { parseQuery } = require('../utils/nlqHeuristics');
const { registerTemplate } = require('./llm/templates');

// ───────────────────────── 常數（第 6 條）─────────────────────────

const MAX_QUERY_LEN = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CHAPTERS = 3;          // 第 6.4 條第 4 點：多章要對 buildHybridQuery 跑多次
const CACHE_MAX = 100;           // 第 6.7 條：LRU 100 筆
const EF_SEARCH = 100;           // 與 /similar 相同（interfaces.md 第 5 條）
const DEFAULT_MODEL_NLQ = 'gemini:gemini-3.5-flash';
const DEFAULT_TIMEOUT_MS = 4000;
const LIKE_MAX_TERMS = 5;

/** 400 的訊息字串（第 6 條的表，逐字凍結） */
const MSG = {
    query: 'query 必須是非空字串。',
    queryTooLong: 'query 最多 200 字。',
    studentId: 'student_id 必須是正整數。',
    limit: 'limit 必須是 1~50 的整數。'
};

/** 回退階梯的 warning（第 6.6 條，逐字凍結） */
const WARN = {
    llmFailed: 'LLM 解析逾時或不合 schema，只用規則解析的結果。',
    relaxed: 'hybrid 檢索 0 筆，已放寬條件重查。',
    noEmbed: 'embedding 服務不可用，改用關鍵字 LIKE 檢索。'
};

const TEMPLATE = 'nlq.v1';

const SYSTEM = '你是一位台灣高中數學與物理家教老師的題庫助理。你的工作是把老師隨口說的一句查題需求，翻成題庫看得懂的檢索條件。你只輸出 JSON，不輸出任何其他文字。';

const PROMPT_TEMPLATE = `老師想在題庫裡找題目，他說的是下面這一句話。請把它翻成檢索條件。

{{CHAPTER_WHITELIST}}

【規則】
1. chapter 必須「完全等於」白名單裡的某一個字串，一個字都不能差，也不得自創新詞。
2. 判斷依據是「解這一題需要用到哪一章的觀念」，不是句子裡出現了哪些名詞。
3. 想不到任何一章就回空陣列。硬填一章會讓候選集整個跑錯地方，比誠實回空陣列糟得多。
4. 老師沒提到的條件（學科、難度、題型、學生）就整個欄位不要輸出，不要猜。
5. semantic_text 只留概念詞與名詞，把「幫我」「有沒有」「題目」這類贅字拿掉。

【老師說的話】
{{QUERY}}`;

registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

/** 白名單區塊（不共用 agents/promptParts.js：那是 WS-B 的檔，這裡只需要兩行） */
function chapterWhitelistText() {
    const lines = SUBJECTS.map(subject => `${subject}：${CHAPTERS[subject].join('、')}`);
    return `【精細章節白名單（chapters 只能從這裡面挑）】\n${lines.join('\n')}`;
}

// ───────────────────────── 小工具 ─────────────────────────

function sha1(text) {
    return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

/** interfaces.md 第 9 條凍結的布林解讀（features.js 不在時的退路） */
function parseBool(value) {
    const s = String(value ?? '').trim().toLowerCase();
    return s === '1' || s === 'true';
}

/**
 * FEATURE_NLQ 是否開啟。關閉時 routes/index.js 不掛載這條路由，
 * 請求落到 Express 預設 404（與 FEATURE_SIMILAR 同一種做法）。
 */
function isNlqEnabled() {
    try {
        const features = require('../config/features');
        if (features && typeof features.FEATURE_NLQ === 'boolean') return features.FEATURE_NLQ;
        if (features && typeof features.isEnabled === 'function') return Boolean(features.isEnabled('FEATURE_NLQ'));
    } catch (e) { /* config/features.js 不在：退回環境變數 */ }
    return parseBool(process.env.FEATURE_NLQ);
}

/** 取得 pg 版的 { pool, query }（interfaces.md 第 8 條） */
function resolveDb(injected) {
    const db = injected || require('../config/db');
    if (!db || typeof db.query !== 'function' || !db.pool || typeof db.pool.connect !== 'function') {
        throw new Error('需要 pg 版的 { pool, query }（interfaces.md 第 8 條）。');
    }
    return db;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 深拷貝（快取只放不可變的東西，回傳的物件被呼叫端改到不影響下一次） */
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * 第 6.3 條凍結的「有實詞」判定。
 * @param {string} text
 * @returns {boolean}
 */
function hasContentWord(text) {
    return String(text ?? '').replace(/[\s\p{P}]/gu, '').length >= 2;
}

// ───────────────────────── LRU（第 6.7 條）─────────────────────────
//
// 只快取**解析結果**：{ filters, parse_path, semantic_text, warnings }。
// 檢索結果不進快取（裁決 S3-18：題庫與 student_id 會變，快取它等於發舊資料）；
// 學生名查 DB 的那一步也不進（它要看當下的 students 表）。
// 行程內記憶體即可，不落地、不跨行程。

const parseCache = new Map();

function cacheGet(key) {
    if (!parseCache.has(key)) return null;
    const value = parseCache.get(key);
    parseCache.delete(key);          // 重新 set 一次 = 移到 Map 的尾端（最近使用）
    parseCache.set(key, value);
    return clone(value);
}

function cacheSet(key, value) {
    if (parseCache.has(key)) parseCache.delete(key);
    parseCache.set(key, clone(value));
    while (parseCache.size > CACHE_MAX) {
        parseCache.delete(parseCache.keys().next().value);   // Map 的第一個 = 最久沒用的
    }
}

/** 測試用 */
function _resetCacheForTest() {
    parseCache.clear();
}

// ───────────────────────── 伺服器再驗一次（第 6.4 條）─────────────────────────

/**
 * 不論 filters 來自規則還是 LLM，一律再驗。**純函式**（學生名那一步要 DB，另外做）。
 *
 * 一個順序上的說明：第 6.4 條把「subject 反推」列在第 6 點、把「chapters 逐一過
 * isValidChapter」列在第 1 點。照字面順序做的話，subject 為 null 時第 1 點會把每一章
 * 都判成不合法（isValidChapter(null, x) 恆為 false），第 6 點就沒有章節可以反推了。
 * 因此這裡先反推 subject 再驗章節——兩點的意圖顯然是這樣，見 docs/archive/questions3-wsC.md 第 5 題。
 *
 * @param {object} filters parseQuery 或 LLM 給的七欄
 * @returns {{filters:object, warnings:string[]}}
 */
function validateFilters(filters) {
    const warnings = [];
    const out = {
        subject: isValidSubject(filters.subject) ? filters.subject : null,
        chapters: [],
        question_types: [],
        difficulty_min: null,
        difficulty_max: null,
        exclude_student_name: null,
        keywords: Array.isArray(filters.keywords) ? filters.keywords.filter(k => typeof k === 'string' && k.trim()) : []
    };

    const rawChapters = Array.isArray(filters.chapters) ? filters.chapters : [];

    // 第 6.4 條第 6 點：subject 為 null 且 chapters 非空時，由第一個章節反推 subject
    if (!out.subject) {
        for (const chapter of rawChapters) {
            const subject = subjectOfChapter(chapter);
            if (subject) { out.subject = subject; break; }
        }
    }

    // 第 6.4 條第 1 點：chapters 逐一過 isValidChapter，不合法的丟掉那一個
    for (const chapter of rawChapters) {
        if (typeof chapter === 'string' && out.subject && isValidChapter(out.subject, chapter)) {
            if (!out.chapters.includes(chapter)) out.chapters.push(chapter);
        } else {
            warnings.push(`章節「${chapter}」不在白名單內，已忽略。`);
        }
    }

    // 第 6.4 條第 4 點：超過 3 個時只採用前 3 個
    // （理由見第 6.5 條：buildHybridQuery 只吃單一 chapter，多章要跑多次）
    if (out.chapters.length > MAX_CHAPTERS) {
        const kept = out.chapters.slice(0, MAX_CHAPTERS);
        warnings.push(`章節條件過多，只採用前 3 個：${kept.join('、')}`);
        out.chapters = kept;
    }

    // 第 6.4 條第 2 點：question_types 逐一過 isValidQuestionType
    for (const type of (Array.isArray(filters.question_types) ? filters.question_types : [])) {
        if (isValidQuestionType(type)) {
            if (!out.question_types.includes(type)) out.question_types.push(type);
        } else {
            warnings.push(`題型「${type}」不在白名單內，已忽略。`);
        }
    }

    // 第 6.4 條第 3 點：難度過 normalizeDifficulty；min > max 時對調；只有一邊時另一邊補 1 或 5
    let min = filters.difficulty_min === null || filters.difficulty_min === undefined
        ? null : normalizeDifficulty(filters.difficulty_min);
    let max = filters.difficulty_max === null || filters.difficulty_max === undefined
        ? null : normalizeDifficulty(filters.difficulty_max);
    if (min !== null && max !== null && min > max) { const t = min; min = max; max = t; }
    if (min !== null && max === null) max = 5;
    if (max !== null && min === null) min = 1;
    out.difficulty_min = min;
    out.difficulty_max = max;

    // exclude_student_name 只做字串正規化；查 students 表要 DB，在 resolveStudent() 做
    if (typeof filters.exclude_student_name === 'string' && filters.exclude_student_name.trim()) {
        out.exclude_student_name = filters.exclude_student_name.trim();
    }

    return { filters: out, warnings };
}

/**
 * 第 6.4 條第 5 點：exclude_student_name 查 students.name。
 * 查不到就**忽略**並加 warning——**不自動建學生**。
 * @returns {Promise<{id:number|null, warnings:string[]}>}
 */
async function resolveStudent(db, name) {
    if (!name) return { id: null, warnings: [] };
    const { rows } = await db.query('SELECT id FROM students WHERE name = $1 ORDER BY id LIMIT 1', [name]);
    if (!rows.length) {
        return { id: null, warnings: [`找不到學生「${name}」，已忽略「沒寫過」的條件。`] };
    }
    return { id: rows[0].id, warnings: [] };
}

// ───────────────────────── LLM 輔路徑（第 6.3 條）─────────────────────────

/**
 * 規則的結果與 LLM 的結果合併。
 *
 * 規則抓到的東西優先：難度、題型、學生名都是正規表達式**精確**比對出來的，
 * 沒有理由讓一個機率模型覆寫它們。章節與 subject 則以 LLM 為準——會走到這裡
 * 就是因為規則一章都沒抓到（confident === false）。
 */
function mergeLlm(rulesFilters, rulesSemantic, data) {
    const out = Object.assign({}, rulesFilters);
    const d = data || {};

    if (Array.isArray(d.chapters) && d.chapters.length) out.chapters = d.chapters.slice();
    if (typeof d.subject === 'string' && d.subject) out.subject = d.subject;

    if (!out.question_types.length && Array.isArray(d.question_types)) {
        out.question_types = d.question_types.slice();
    }
    if (out.difficulty_min === null && out.difficulty_max === null) {
        if (Number.isFinite(d.difficulty_min)) out.difficulty_min = d.difficulty_min;
        if (Number.isFinite(d.difficulty_max)) out.difficulty_max = d.difficulty_max;
    }
    if (!out.exclude_student_name && typeof d.exclude_student_name === 'string' && d.exclude_student_name.trim()) {
        out.exclude_student_name = d.exclude_student_name.trim();
    }

    const keywords = out.keywords.slice();
    for (const k of (Array.isArray(d.keywords) ? d.keywords : [])) {
        const s = typeof k === 'string' ? k.trim() : '';
        if (s && !keywords.includes(s)) keywords.push(s);
    }
    out.keywords = keywords;

    const semantic = typeof d.semantic_text === 'string' && d.semantic_text.trim()
        ? d.semantic_text.trim()
        : rulesSemantic;

    return { filters: out, semantic_text: semantic };
}

function modelNlq() {
    return process.env.MODEL_NLQ || DEFAULT_MODEL_NLQ;
}

function timeoutMs() {
    const n = Number.parseInt(process.env.NLQ_TIMEOUT_MS || '', 10);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * 呼叫 generateJson。**逾時／schema 不合／供應商錯誤一律不 throw**（第 6.3 條末段），
 * 回 null 讓呼叫端走 fallback_level 1。
 * @returns {Promise<object|null>}
 */
async function callLlm({ llm, query, logger }) {
    const { buildSchema } = require('../agents/schemas');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
        const prompt = PROMPT_TEMPLATE
            .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText())
            .replace('{{QUERY}}', query);

        const res = await llm.generateJson({
            model: modelNlq(),
            system: SYSTEM,
            parts: [{ text: prompt }],
            schema: buildSchema('nlq'),
            signal: controller.signal,
            agent: 'nlq',
            template: TEMPLATE,
            // 第 5.2 條：可重現的最小集合。query 本身就是全部的輸入，沒有別的可變欄位。
            cacheKeyParts: { template: TEMPLATE, query }
        });
        return (res && res.data) || null;
    } catch (err) {
        logger?.warn?.({ node: 'nlq', msg: `LLM 解析失敗，改用規則的結果：${String(err.message).split('\n')[0]}` });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ───────────────────────── 解析（規則 → LLM → 再驗）─────────────────────────

/**
 * 解析一句查詢，不碰資料庫。eval 的 suiteNlq.js 也走這一支。
 *
 * @param {{query:string, llm?:object, logger?:object, noCache?:boolean}} opts
 * @returns {Promise<{filters:object, parse_path:'rules'|'llm'|'llm_failed',
 *                    semantic_text:string, warnings:string[], confident:boolean, cacheHit:boolean}>}
 */
async function parseOnly(opts = {}) {
    const query = String(opts.query ?? '').trim();
    const key = sha1(query);

    if (!opts.noCache) {
        const hit = cacheGet(key);
        if (hit) return Object.assign(hit, { cacheHit: true });
    }

    const rules = parseQuery(query, { aliases: CHAPTER_ALIASES });
    let filters = rules.filters;
    let semanticText = rules.semantic_text;
    let parsePath = 'rules';
    const warnings = [];

    // 第 6.3 條：**只有在 confident === false 且 semantic_text 仍有實詞時才呼叫**
    if (!rules.confident && hasContentWord(semanticText)) {
        const llm = opts.llm || require('./llm');
        const data = await callLlm({ llm, query, logger: opts.logger });
        if (data) {
            const merged = mergeLlm(filters, semanticText, data);
            filters = merged.filters;
            semanticText = merged.semantic_text;
            parsePath = 'llm';
        } else {
            parsePath = 'llm_failed';
            warnings.push(WARN.llmFailed);
        }
    }

    const validated = validateFilters(filters);
    const value = {
        filters: validated.filters,
        parse_path: parsePath,
        semantic_text: semanticText,
        warnings: warnings.concat(validated.warnings),
        confident: rules.confident
    };

    if (!opts.noCache) cacheSet(key, value);
    return Object.assign(clone(value), { cacheHit: false });
}

// ───────────────────────── 檢索（第 6.5、6.6 條）─────────────────────────

/**
 * 題型的候選排除集。buildHybridQuery 沒有 question_type 參數（凍結），
 * 因此把「題型不對的題」算成 excludeIds。範圍限縮在同一次查詢的 subject／chapter／
 * 難度區間內，所以這個集合不會大到有意義的程度。
 * @returns {Promise<number[]>}
 */
async function excludedByType(client, { subject, chapter, difficultyMin, difficultyMax, types }) {
    if (!types.length) return [];
    const { rows } = await client.query(
        `SELECT id FROM questions
          WHERE archived_at IS NULL
            AND subject = $1
            AND ($2::text IS NULL OR chapter = $2::text)
            AND difficulty BETWEEN $3::int AND $4::int
            AND NOT (question_type = ANY($5::text[]))`,
        [subject, chapter, difficultyMin, difficultyMax, types]
    );
    return rows.map(r => r.id);
}

/**
 * 跑一輪 hybrid。多章／兩科都在同一個交易內跑完再合併（第 6.5 條）。
 *
 * ⚠ 跨查詢合併的 score 是**各自查詢內**的 RRF 分數，不是全域可比的排序分數。
 *    這一點也寫在 README 的數字欄旁邊——把它當統一分數用會做出錯誤的比較。
 *
 * @returns {Promise<Array<{id:number, score:number}>>}
 */
async function runHybrid(db, opts) {
    const { buildHybridQuery } = require('../queries/hybrid');
    const { subjects, chapters, questionTypes, difficultyMin, difficultyMax,
        excludeStudentId, queryVector, queryTokens, sides, limit } = opts;

    const client = await db.pool.connect();
    const merged = new Map();
    try {
        await client.query('BEGIN');
        // 召回深度：與 /similar 相同，交易內設定（interfaces.md 第 5 條）
        await client.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);

        for (const subject of subjects) {
            for (const chapter of (chapters.length ? chapters : [null])) {
                // 兩科都跑時，別把 A 科的章節條件帶去 B 科（validateFilters 之後不會發生，
                // 但直接呼叫 runHybrid 的測試可能會，寧可在這裡擋掉）
                if (chapter !== null && subjectOfChapter(chapter) !== subject) continue;

                const excludeIds = await excludedByType(client, {
                    subject, chapter, difficultyMin, difficultyMax, types: questionTypes
                });

                const built = buildHybridQuery({
                    subject,
                    chapter,
                    difficultyMin,
                    difficultyMax,
                    excludeStudentId,
                    excludeIds,
                    queryVector,
                    queryTokens,
                    mode: 'rrf',
                    sides,
                    limit: Math.min(limit, MAX_LIMIT)
                });

                for (const row of (await client.query(built.text, built.values)).rows) {
                    const prev = merged.get(row.id);
                    if (!prev || row.score > prev.score) merged.set(row.id, row);
                }
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    return [...merged.values()].sort((a, b) => (b.score - a.score) || (a.id - b.id));
}

/**
 * fallback_level 3：沒有 embedding 服務時退回 LIKE（第 6.6 條）。
 * `score` 一律回 null——LIKE 沒有分數可言，回 0 會被前端當成「非常不相關」。
 *
 * 第 6.6 條寫的是單一 `question_text ILIKE '%' || $n || '%'`。semantic_text 是以空白
 * 分段的（「牛頓第二定律 摩擦力」），單一 ILIKE 會一題都比不到，所以這裡對每一段各下
 * 一個 ILIKE 再 OR 起來；只有一段時就退化成第 6.6 條寫的那一句。
 */
async function runLike(db, opts) {
    const { subjects, chapters, questionTypes, difficultyMin, difficultyMax,
        excludeStudentId, terms, limit } = opts;

    const values = [subjects, chapters, difficultyMin, difficultyMax, questionTypes, excludeStudentId];
    const likeSql = terms.length
        ? `AND (${terms.map((t) => {
            values.push(t);
            return `q.question_text ILIKE '%' || $${values.length} || '%'`;
        }).join(' OR ')})`
        : '';
    values.push(Math.min(limit, MAX_LIMIT));

    const { rows } = await db.query(
        `SELECT q.id, q.subject, q.chapter, q.question_type, q.difficulty, q.question_text
           FROM questions q
          WHERE q.archived_at IS NULL
            AND q.subject = ANY($1::text[])
            AND (cardinality($2::text[]) = 0 OR q.chapter = ANY($2::text[]))
            AND q.difficulty BETWEEN $3::int AND $4::int
            AND (cardinality($5::text[]) = 0 OR q.question_type = ANY($5::text[]))
            AND ($6::int IS NULL OR NOT EXISTS (
                    SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $6::int))
            ${likeSql}
          ORDER BY q.id DESC
          LIMIT $${values.length}`,
        values
    );
    return rows.map(r => Object.assign({}, r, { score: null }));
}

/**
 * 顯示欄位另外撈：hybrid SQL 的結果集只回 id/score/vec_rank/kw_rank（凍結）。
 * 形狀與 /similar 的 results 相同（第 6 條）。
 */
async function decorate(db, ranked) {
    if (!ranked.length) return [];
    const { rows } = await db.query(
        `SELECT id, subject, chapter, question_type, difficulty, question_text
           FROM questions WHERE id = ANY($1::int[])`,
        [ranked.map(r => r.id)]
    );
    const byId = new Map(rows.map(r => [r.id, r]));
    return ranked
        .filter(r => byId.has(r.id))
        .map(r => Object.assign({}, byId.get(r.id), {
            score: r.score,
            vec_rank: r.vec_rank ?? null,     // 除錯欄位；消費端必須忽略未知鍵
            kw_rank: r.kw_rank ?? null
        }));
}

/**
 * 檢索 + 回退階梯（第 6.5、6.6 條）。
 *
 * @returns {Promise<{results:Array<object>, fallbackLevel:number, warnings:string[]}>}
 */
async function retrieve(db, opts) {
    const { filters, semanticText, rawQuery, limit, excludeStudentId, llm, logger } = opts;

    const queryText = (semanticText && semanticText.trim()) || rawQuery;
    const subjects = filters.subject ? [filters.subject] : SUBJECTS.slice();
    const difficultyMin = filters.difficulty_min === null ? 1 : filters.difficulty_min;
    const difficultyMax = filters.difficulty_max === null ? 5 : filters.difficulty_max;

    const warnings = [];
    let fallbackLevel = 0;

    // ── 查詢向量。embed() 丟錯 = 沒有 embedding 服務（裁決 S3-17）──
    let queryVector = null;
    try {
        const { vectors } = await (llm || require('./llm')).embed({
            texts: [queryText],
            taskType: 'RETRIEVAL_QUERY'      // interfaces.md 第 4 條：查詢向量用這個
        });
        queryVector = Array.isArray(vectors) && vectors[0] ? vectors[0] : null;
        if (!queryVector) throw new Error('embed() 沒有回傳向量');
    } catch (err) {
        logger?.warn?.({ node: 'nlq', msg: `embedding 不可用，改用 LIKE：${String(err.message).split('\n')[0]}` });
        queryVector = null;
    }

    // 三級條件：原條件 → 丟掉 chapters → 再丟掉難度與題型（第 6.6 條 level 2）
    const ladder = [
        { chapters: filters.chapters, questionTypes: filters.question_types, difficultyMin, difficultyMax, sides: ['vec', 'kw'] },
        { chapters: [], questionTypes: filters.question_types, difficultyMin, difficultyMax, sides: ['vec', 'kw'] },
        { chapters: [], questionTypes: [], difficultyMin: 1, difficultyMax: 5, sides: ['vec'] }
    ];

    if (queryVector === null) {
        // ── fallback_level 3：LIKE ──
        fallbackLevel = 3;
        warnings.push(WARN.noEmbed);

        const terms = queryText.split(/\s+/).map(s => s.trim()).filter(Boolean).slice(0, LIKE_MAX_TERMS);
        if (!terms.length) terms.push(rawQuery.trim());

        // LIKE 的放寬順序**與 hybrid 不同**，這是刻意的。
        // ILIKE 比的是整段字串，而題幹幾乎不會逐字出現「牛頓第二定律」這種章節名——
        // 照 hybrid 的順序先丟章節，只會從「一題都沒有」變成「範圍更大的一題都沒有」。
        // 先丟掉 ILIKE 這個條件，留下 metadata 篩選，等於直接退回 listQuestions
        // 的那張清單（第 6.6 條的原話就是「退回 listQuestions 的 LIKE」）：
        // 至少是「這一章這個難度的題目」，而不是空白。
        const likeLadder = [
            { chapters: filters.chapters, questionTypes: filters.question_types, difficultyMin, difficultyMax, terms },
            { chapters: filters.chapters, questionTypes: filters.question_types, difficultyMin, difficultyMax, terms: [] },
            { chapters: [], questionTypes: [], difficultyMin: 1, difficultyMax: 5, terms: [] }
        ];

        let results = [];
        let step = 0;
        for (; step < likeLadder.length; step++) {
            const rung = likeLadder[step];
            results = await runLike(db, {
                subjects,
                chapters: rung.chapters,
                questionTypes: rung.questionTypes,
                difficultyMin: rung.difficultyMin,
                difficultyMax: rung.difficultyMax,
                excludeStudentId,
                terms: rung.terms,
                limit
            });
            if (results.length) break;
        }
        // 兩級同時成立時 fallback_level 回較高的那一級，warnings 兩句都要有（第 6.6 條）
        if (step > 0) warnings.push(WARN.relaxed);
        return { results: results.slice(0, limit), fallbackLevel, warnings };
    }

    // ── fallback_level 0 / 2：hybrid ──
    const { tokenize } = require('../utils/tokenize');     // 載入 jieba 詞典，延遲到真的要查才做
    const queryTokens = tokenize(queryText);

    let ranked = [];
    let step = 0;
    for (; step < ladder.length; step++) {
        const rung = ladder[step];
        ranked = await runHybrid(db, {
            subjects,
            chapters: rung.chapters,
            questionTypes: rung.questionTypes,
            difficultyMin: rung.difficultyMin,
            difficultyMax: rung.difficultyMax,
            excludeStudentId,
            queryVector,
            queryTokens,
            sides: rung.sides,
            limit
        });
        if (ranked.length) break;
    }

    if (step > 0) {
        // level 2 走完仍是 0 筆 → results:[] 且 fallback_level:2（**不是** 3；
        // 沒東西可找不等於 embedding 壞了）
        fallbackLevel = 2;
        warnings.push(WARN.relaxed);
    }

    const results = await decorate(db, ranked.slice(0, limit));
    return { results, fallbackLevel, warnings };
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 驗證並正規化 request body。訊息字串凍結於第 6 條的表。
 * @returns {{ok:true, value:{query:string, studentId:number|null, limit:number}} | {ok:false, message:string}}
 */
function parseBody(body = {}) {
    const raw = body.query;
    if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, message: MSG.query };
    const query = raw.trim();
    if (query.length > MAX_QUERY_LEN) return { ok: false, message: MSG.queryTooLong };

    let studentId = null;
    if (body.student_id !== undefined && body.student_id !== null && String(body.student_id).trim() !== '') {
        const n = Number(body.student_id);
        if (!Number.isInteger(n) || n <= 0) return { ok: false, message: MSG.studentId };
        studentId = n;
    }

    let limit = DEFAULT_LIMIT;
    if (body.limit !== undefined && body.limit !== null && String(body.limit).trim() !== '') {
        const n = Number(body.limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, message: MSG.limit };
        limit = n;
    }

    return { ok: true, value: { query, studentId, limit } };
}

/**
 * 自然語言查題。
 *
 * @param {{query:string, studentId?:number|null, limit?:number}} input  parseBody 的輸出
 * @param {{db?:object, llm?:object, logger?:object}} [deps]
 * @returns {Promise<object>} 第 6 條凍結的 200 回應主體
 */
async function searchNl(input, deps = {}) {
    const db = resolveDb(deps.db);
    const llm = deps.llm || require('./llm');
    const logger = deps.logger;
    const limit = clamp(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);

    const parsed = await parseOnly({ query: input.query, llm, logger });
    const warnings = parsed.warnings.slice();

    // 第 6.4 條第 5 點：查 students.name（要 DB，所以不進第 6.7 條的快取）
    const student = await resolveStudent(db, parsed.filters.exclude_student_name);
    warnings.push(...student.warnings);

    // 句子裡指名的優先；沒指名時才用 body 帶進來的 student_id
    const excludeStudentId = student.id !== null ? student.id : (input.studentId ?? null);

    const retrieved = await retrieve(db, {
        filters: parsed.filters,
        semanticText: parsed.semantic_text,
        rawQuery: input.query,
        limit,
        excludeStudentId,
        llm,
        logger
    });
    warnings.push(...retrieved.warnings);

    // fallback_level：兩級同時成立時回較高的那一級（第 6.6 條）
    const fallbackLevel = Math.max(
        parsed.parse_path === 'llm_failed' ? 1 : 0,
        retrieved.fallbackLevel
    );

    return {
        // 八個鍵一律出現（沒抓到的填 null／[]／''），前端要用它回寫下拉
        filters: {
            subject: parsed.filters.subject,
            chapters: parsed.filters.chapters,
            question_types: parsed.filters.question_types,
            difficulty_min: parsed.filters.difficulty_min,
            difficulty_max: parsed.filters.difficulty_max,
            exclude_student_name: parsed.filters.exclude_student_name,
            semantic_text: parsed.semantic_text,
            keywords: parsed.filters.keywords
        },
        parse_path: parsed.parse_path,
        fallback_level: fallbackLevel,
        warnings,
        results: retrieved.results
    };
}

/**
 * Express handler：POST /api/questions/search-nl
 * 掛在 routes/index.js 的 [WS3-C: nlq] 區塊，位置在 apiKeyAuth 之後並套 createRateLimiter。
 */
async function searchNlHandler(req, res, next) {
    try {
        const parsed = parseBody(req.body);
        if (!parsed.ok) return res.status(400).json({ message: parsed.message });
        const body = await searchNl(parsed.value, { db: req.app?.locals?.db });
        return res.status(200).json(body);
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    searchNl,
    searchNlHandler,
    parseBody,
    parseOnly,
    isNlqEnabled,
    // 給單元測試與 eval 用（不是第 6 條凍結簽名的一部分）
    validateFilters,
    resolveStudent,
    retrieve,
    runHybrid,
    runLike,
    decorate,
    mergeLlm,
    hasContentWord,
    chapterWhitelistText,
    _resetCacheForTest,
    MSG, WARN, TEMPLATE, SYSTEM, PROMPT_TEMPLATE,
    DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LEN, MAX_CHAPTERS, CACHE_MAX
};
