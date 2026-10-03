// ─────────────────────────────────────────────────────────────
// services/remedialFillService.js — 補救卷「題庫不夠時自動補題」（〔dec/r16-remedial〕；docs/remedial.md 第 11 節）
//
//   POST /api/students/:id/remedial-paper/fill-shortfall   （FEATURE_REMEDIAL＋FEATURE_VARIANTS）
//
// 補救卷草稿某個補救單位回報 insufficient_stock 時，老師按「生成變式補題」：
//   1. 藍本＝該生在這個單位**第一次作答**（檢視 attempts，R10）答錯或部分給分的題，最近的先
//      （同一天依批改時間、再依題號）；草稿給了錯因主因（error_type）時，標了那個錯因的錯題排前面。
//      承上題、沒有向量、已封存的題不能當藍本（與 POST /api/questions/:id/variants 同一條規則），跳過並回報原因。
//   2. 每個單位要補 needed 題：平均分給前幾個藍本（一個藍本一個 job，每個 job 最多 VARIANT_MAX_PER_REQUEST 題），
//      整個請求最多生成 MAX_FILL_GENERATE 題（本機 CPU 一題要好幾分鐘）；超過的部分不生成，回報 capped。
//   3. 每個藍本**先檢索**（variantService.findRetrieved：同科、同難度、不同家族、該生沒寫過、餘弦 ≥ 檢索下限）：
//      庫裡已經有夠用的相似題就不生成，把它們回報給老師（可以直接用題目 ID 加進草稿）；不夠才生成差額。
//   4. 生成走既有的變式 job（variantService.createVariantJob；同一藍本已經在跑就合流，不重複花錢），
//      job 多記 target_student_id（migrations/0023）。job 的引擎照 .env（jobs.engine 為 NULL；變式 job 沒有逐份選引擎）。
//      VARIANT_AUTO_APPROVE=false（預設）時生成的題停在複核佇列（awaiting_approval），核准後才入庫；
//      入庫的題帶 target_student_id／target_source_question_id。
//
// 學生資料：只有 student_id 進 job（給檢索排除他寫過的題、給來源註記）；姓名不讀、不進 prompt、不寫 log。
// 變式 agent 的 input 與之前完全相同（藍本題目、鄰居、兄弟題幹），所以 cassette 的鍵不變。
//
// 純函式（parseFillBody、orderSources、allocate、buildWrongSourcesQuery）由 test/unit/remedialFill.test.js 釘住；
// I/O 的 fillShortfall 由 test/integration/remedialFill.pg.test.js 驗。
// ─────────────────────────────────────────────────────────────
const { SUBJECTS, isValidChapter } = require('../config/chapters');
const { ERROR_TYPE_CODES } = require('../config/errorTypes');

/** 一次請求最多生成幾題變式（本機 CPU 一題約 3～6 分鐘，見 docs/remedial.md 第 11.4 節）。 */
const MAX_FILL_GENERATE = 5;
/** 一次最多幾個單位（補救組最多 3 個目標）。 */
const MAX_FILL_UNITS = 3;
/** 每個單位最多要補幾題（同補救卷題數上限）。 */
const MAX_NEEDED = 50;
/** 每個單位最多看幾題錯題當藍本候選。 */
const MAX_SOURCE_CANDIDATES = 20;
const DEFAULT_DAYS = 90;
const PG_INT_MAX = 2147483647;

const BODY_KEYS = Object.freeze(['subject', 'days', 'difficulty_delta', 'units']);
const UNIT_KEYS = Object.freeze(['unit_type', 'chapter', 'kc_id', 'needed', 'error_type']);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ───────────────────────── 純函式 ─────────────────────────

/**
 * 驗證 body（純函式；只收列出的鍵）。
 *
 * body：{ subject, days?(1–365，預設 90), difficulty_delta?(-1|0|1，預設 0),
 *         units: [{ unit_type: 'chapter'|'kc', chapter, kc_id?(kc 必填), needed(1–50), error_type?(錯因代碼) }]（1–3 個） }
 *
 * @param {any} body
 * @returns {{error:string} | {value:{subject:string, days:number, difficultyDelta:number, units:object[]}}}
 */
function parseFillBody(body) {
    const b = isPlainObject(body) ? body : {};
    const extra = Object.keys(b).filter(k => !BODY_KEYS.includes(k));
    if (extra.length) return { error: `不認得的鍵：${extra.join('、')}。` };
    if (typeof b.subject !== 'string' || !SUBJECTS.includes(b.subject)) return { error: 'subject 必填，且必須在科目白名單內。' };
    let days = DEFAULT_DAYS;
    if (b.days !== undefined && b.days !== null) {
        if (!Number.isInteger(b.days) || b.days < 1 || b.days > 365) return { error: 'days 必須是 1~365 的整數。' };
        days = b.days;
    }
    let difficultyDelta = 0;
    if (b.difficulty_delta !== undefined && b.difficulty_delta !== null) {
        if (![-1, 0, 1].includes(b.difficulty_delta)) return { error: 'difficulty_delta 只接受 -1、0、1。' };
        difficultyDelta = b.difficulty_delta;
    }
    if (!Array.isArray(b.units) || b.units.length < 1 || b.units.length > MAX_FILL_UNITS) {
        return { error: `units 必須是 1~${MAX_FILL_UNITS} 個單位的陣列。` };
    }
    const units = [];
    const seen = new Set();
    for (let i = 0; i < b.units.length; i++) {
        const u = b.units[i];
        const where = `units 第 ${i + 1} 項`;
        if (!isPlainObject(u)) return { error: `${where} 必須是物件。` };
        const bad = Object.keys(u).filter(k => !UNIT_KEYS.includes(k));
        if (bad.length) return { error: `${where} 不認得的鍵：${bad.join('、')}。` };
        if (!['chapter', 'kc'].includes(u.unit_type)) return { error: `${where} 的 unit_type 必須是 chapter 或 kc。` };
        if (typeof u.chapter !== 'string' || !isValidChapter(b.subject, u.chapter)) return { error: `${where} 的 chapter 不在「${b.subject}」的章節白名單內。` };
        if (u.unit_type === 'kc') {
            if (!Number.isInteger(u.kc_id) || u.kc_id < 1 || u.kc_id > PG_INT_MAX) return { error: `${where} 是知識點單位，kc_id 必須是正整數。` };
        } else if (u.kc_id !== undefined && u.kc_id !== null) {
            return { error: `${where} 是章節單位，不可帶 kc_id。` };
        }
        if (!Number.isInteger(u.needed) || u.needed < 1 || u.needed > MAX_NEEDED) return { error: `${where} 的 needed 必須是 1~${MAX_NEEDED} 的整數。` };
        if (u.error_type !== undefined && u.error_type !== null && !ERROR_TYPE_CODES.includes(u.error_type)) {
            return { error: `${where} 的 error_type 不在錯因白名單內。` };
        }
        const key = u.unit_type === 'kc' ? `kc|${u.kc_id}` : `chapter|${u.chapter}`;
        if (seen.has(key)) return { error: `${where} 與前面的單位重複。` };
        seen.add(key);
        units.push({
            unit_type: u.unit_type, chapter: u.chapter, ...(u.unit_type === 'kc' ? { kc_id: u.kc_id } : {}),
            needed: u.needed, error_type: u.error_type ?? null
        });
    }
    return { value: { subject: b.subject, days, difficultyDelta, units } };
}

/**
 * 藍本候選的順序（純函式）：標了 errorType 的錯題在前（有給時），其餘維持 SQL 的「最近的先」；同一題只留一次。
 * @param {Array<{question_id:number, error_types:string[]|null}>} rows buildWrongSourcesQuery 的結果（已依最近的先排）
 * @param {string|null} errorType
 * @returns {number[]} 題目 id
 */
function orderSources(rows, errorType) {
    const seen = new Set();
    const uniq = [];
    for (const r of rows || []) {
        if (seen.has(r.question_id)) continue;
        seen.add(r.question_id);
        uniq.push(r);
    }
    if (!errorType) return uniq.map(r => r.question_id);
    const tagged = uniq.filter(r => Array.isArray(r.error_types) && r.error_types.includes(errorType));
    const rest = uniq.filter(r => !(Array.isArray(r.error_types) && r.error_types.includes(errorType)));
    return [...tagged, ...rest].map(r => r.question_id);
}

/**
 * 把 needed 題分給藍本（純函式）：一個藍本一份，平均分、餘數給前面的；每份最多 perSource 題；
 * 總數不超過 budget（整個請求剩下的生成額度）。藍本不夠分時，分不完的題數回報在 unassigned。
 * @param {number} needed
 * @param {number} sourceCount 可用的藍本數
 * @param {number} perSource VARIANT_MAX_PER_REQUEST
 * @param {number} budget 剩下的生成額度
 * @returns {{counts:number[], unassigned:number, capped:boolean}}
 */
function allocate(needed, sourceCount, perSource, budget) {
    const capacity = Math.min(needed, Math.max(0, budget), sourceCount * perSource);
    const k = Math.min(sourceCount, capacity);
    const counts = [];
    if (k > 0) {
        const base = Math.floor(capacity / k);
        const rem = capacity - base * k;
        for (let i = 0; i < k; i++) counts.push(base + (i < rem ? 1 : 0));
    }
    const assigned = counts.reduce((s, n) => s + n, 0);
    return { counts, unassigned: needed - assigned, capped: budget < Math.min(needed, sourceCount * perSource) };
}

/**
 * 某生在某個單位的錯題（$1 studentId、$2 days、$3 subject、$4 章名、$5 kc_id 或 NULL、$6 上限）。
 * 只讀檢視 attempts（第一次作答，R10）；已批改且正確度 COALESCE(score, result) < 1；最近的先。
 * kc 單位：掛了該知識點的同科題（同 kcWeaknessService 的 S5-42）；章節單位：該章的題。
 * @returns {{text:string, values:any[]}}
 */
function buildWrongSourcesQuery({ studentId, days, subject, chapter, kcId, limit = MAX_SOURCE_CANDIDATES }) {
    return {
        text: `SELECT a.question_id, a.error_types, a.assigned_at, a.graded_at
  FROM attempts a JOIN questions q ON q.id = a.question_id
 WHERE a.student_id = $1
   AND a.assigned_at >= CURRENT_DATE - $2::int
   AND q.subject = $3
   AND a.result IS NOT NULL
   AND COALESCE(a.score::float8, a.result::float8) < 1
   AND (CASE WHEN $5::int IS NULL THEN q.chapter = $4
             ELSE EXISTS (SELECT 1 FROM question_kcs qk JOIN knowledge_components kx ON kx.id = qk.kc_id
                           WHERE qk.question_id = q.id AND qk.kc_id = $5::int AND kx.subject = q.subject) END)
 ORDER BY a.assigned_at DESC, a.graded_at DESC NULLS LAST, a.question_id DESC
 LIMIT $6`,
        values: [studentId, days, subject, chapter, kcId ?? null, limit]
    };
}

/** 藍本不能用的原因（與 POST /api/questions/:id/variants 的 404／409 同一條規則）。 */
function sourceProblem(source) {
    if (!source) return 'not_found';
    if (source.follows_question_id !== null && source.follows_question_id !== undefined) return 'follow_up';
    if (!source.embedding) return 'no_vector';
    return null;
}

const SKIP_TEXT = {
    not_found: '題目已封存或不存在',
    follow_up: '是承上題，不能單獨當藍本',
    no_vector: '還沒有向量（npm run embed:backfill）'
};

// ───────────────────────── I/O ─────────────────────────

function defaultDeps() {
    return { db: require('../config/db'), variants: require('./variantService') };
}

/**
 * 補題（會建變式 job，但本身不呼叫 LLM；生成由 runner 背景跑）。
 *
 * @param {{studentId:number, subject:string, days:number, difficultyDelta:number, units:object[]}} p parseFillBody 的 value
 * @param {{db:{query:Function, pool:object}, variants:object}} [deps]
 * @returns {Promise<{student_id:number, subject:string, max_generate:number, generating:number,
 *                    units:object[], jobs:object[], retrieved_ids:number[], capped:boolean, notes:string[]}>}
 */
async function fillShortfall({ studentId, subject, days, difficultyDelta, units }, deps = defaultDeps()) {
    const { db, variants } = deps;
    const perSource = variants.maxPerRequest();
    let budget = MAX_FILL_GENERATE;
    let capped = false;
    const jobs = [];
    const retrievedAll = [];
    const notes = [];
    const outUnits = [];

    for (const unit of units) {
        const q = buildWrongSourcesQuery({ studentId, days, subject, chapter: unit.chapter, kcId: unit.kc_id ?? null });
        const { rows } = await db.query(q.text, q.values);
        const ordered = orderSources(rows, unit.error_type);

        // 能用的藍本（依序）；不能用的記下原因
        const usable = [];
        const skipped = [];
        for (const id of ordered) {
            const source = await variants.loadSource(db, id);
            const problem = sourceProblem(source);
            if (problem) skipped.push({ source_question_id: id, reason: problem });
            else usable.push(source);
        }

        const plan = allocate(unit.needed, usable.length, perSource, budget);
        if (plan.capped) capped = true;
        const items = [];
        let remaining = unit.needed;
        let generating = 0;
        for (let i = 0; i < plan.counts.length; i++) {
            const source = usable[i];
            const count = plan.counts[i];
            const params = { count, difficultyDelta, studentId };
            // 先檢索：庫裡已經有該生沒寫過的相似題就不生成（只生成差額）
            const found = (await variants.findRetrieved(db, source, params))
                .filter(r => !retrievedAll.includes(r.id));
            for (const r of found) retrievedAll.push(r.id);
            const retrieved = found.map(r => ({ id: r.id, chapter: r.chapter, difficulty: r.difficulty, cosine: Math.round(r.cosine * 10000) / 10000 }));
            const gap = count - found.length;
            if (gap <= 0) {
                items.push({ source_question_id: source.id, mode: 'retrieved', retrieved });
                remaining -= count;
                continue;
            }
            const active = await variants.findActiveJob(db, source.id);
            if (active) {
                items.push({ source_question_id: source.id, mode: 'generating', job_id: active.id, state: active.state, existing: true, count: gap, retrieved });
                jobs.push({ job_id: active.id, state: active.state, existing: true, source_question_id: source.id, chapter: unit.chapter });
            } else {
                const created = await variants.createVariantJob(db, source.id, { ...params, count: gap }, undefined, { targetStudentId: studentId });
                items.push({ source_question_id: source.id, mode: 'generating', job_id: created.job_id, state: created.state, existing: false, count: gap, retrieved });
                jobs.push({ job_id: created.job_id, state: created.state, existing: false, source_question_id: source.id, chapter: unit.chapter });
                budget -= gap;
                generating += gap;
            }
            remaining -= count;
        }
        for (const s of skipped) items.push({ source_question_id: s.source_question_id, mode: 'skipped', reason: s.reason });

        const label = unit.unit_type === 'kc' ? `知識點 #${unit.kc_id}（${unit.chapter}）` : `「${unit.chapter}」`;
        if (ordered.length === 0) {
            notes.push(`${label}在這段時間內沒有答錯的題可以當藍本，沒有生成。可以改用「找相似」或手動加題。`);
        } else if (usable.length === 0) {
            notes.push(`${label}的錯題都不能當藍本（${[...new Set(skipped.map(s => SKIP_TEXT[s.reason]))].join('、')}），沒有生成。`);
        }
        if (remaining > 0 && usable.length > 0) {
            notes.push(plan.capped
                ? `${label}還差 ${remaining} 題沒有生成：一次最多生成 ${MAX_FILL_GENERATE} 題（本機一題要好幾分鐘），這些題核准後再按一次。`
                : `${label}還差 ${remaining} 題沒有安排：可用的藍本只有 ${usable.length} 題、每題最多出 ${perSource} 題變式。`);
        }
        outUnits.push({
            unit_type: unit.unit_type, chapter: unit.chapter, ...(unit.unit_type === 'kc' ? { kc_id: unit.kc_id } : {}),
            needed: unit.needed, sources_found: ordered.length, generating, unplanned: Math.max(0, remaining), items
        });
    }
    const generating = outUnits.reduce((s, u) => s + u.generating, 0);
    if (retrievedAll.length) {
        notes.push(`庫裡已經有 ${retrievedAll.length} 題他沒寫過的相似題（${retrievedAll.map(id => `#${id}`).join('、')}），沒有另外生成；要用的話用題目 ID 加進草稿。`);
    }
    if (jobs.length) {
        notes.push('生成好的題會出現在「待複核」；核准之後重新產生補救卷草稿，就會抽得到。');
    }
    return { student_id: studentId, subject, max_generate: MAX_FILL_GENERATE, generating, units: outUnits, jobs, retrieved_ids: retrievedAll, capped, notes };
}

module.exports = {
    MAX_FILL_GENERATE, MAX_FILL_UNITS, MAX_NEEDED, MAX_SOURCE_CANDIDATES,
    parseFillBody, orderSources, allocate, buildWrongSourcesQuery, sourceProblem,
    fillShortfall
};
