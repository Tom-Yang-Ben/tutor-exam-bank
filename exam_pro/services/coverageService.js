// ─────────────────────────────────────────────────────────────
// services/coverageService.js — 題庫覆蓋率（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 4 項；G10）
//
//   GET /api/coverage?subject=&student_id=
//   → { rows: [{ subject, volume, chapter, total, by_difficulty: { "1":n, …, "5":n }, unseen_by_student }],
//       kc_rows: [{ code, name, chapter, total }] }
//
// 用途：一眼看出「哪一章、哪個難度還沒幾題」，決定下一批要補哪些歷屆題；
// 選了學生時看「這位學生還有幾題沒寫過」，出卷前就知道會不會庫存不足。
//
// 規則：
//   - 只算未封存題（archived_at IS NULL）。
//   - rows 列出**白名單的每一章**（沒有題也列、total = 0：覆蓋率的重點就是看見空洞），
//     順序＝科目（SUBJECTS）→ 冊（VOLUMES）→ 章；資料庫裡不在白名單的舊章節接在該科最後、volume = null。
//   - unseen_by_student：沒給 student_id 時為 null；給了＝該章未封存題中該生沒有 attempts 的題數。
//   - kc_rows：知識點掛了幾題未封存題（question_kcs），同樣列出 0 題的知識點；
//     順序＝科目 → 章節白名單順序 → sort → code。
//   - 科目一律讀 config/chapters.js 的 SUBJECTS／VOLUMES，不寫死（契約第 7 條）。
//
// SQL builder 與組裝都是純函式（test/unit/coverageService.test.js）；loadCoverage 是唯一的 I/O。
// ─────────────────────────────────────────────────────────────
const { SUBJECTS, VOLUMES } = require('../config/chapters');

const DIFFICULTIES = ['1', '2', '3', '4', '5'];

/**
 * 章 × 難度的計數（$1 subject｜NULL＝全部、$2 studentId｜NULL＝不算 unseen）。
 * @param {{subject:string|null, studentId:number|null}} opts
 * @returns {{text:string, values:any[]}}
 */
function buildChapterCoverage({ subject = null, studentId = null } = {}) {
    return {
        text: `SELECT q.subject, q.chapter,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE q.difficulty = 1)::int AS d1,
       COUNT(*) FILTER (WHERE q.difficulty = 2)::int AS d2,
       COUNT(*) FILTER (WHERE q.difficulty = 3)::int AS d3,
       COUNT(*) FILTER (WHERE q.difficulty = 4)::int AS d4,
       COUNT(*) FILTER (WHERE q.difficulty = 5)::int AS d5,
       CASE WHEN $2::int IS NULL THEN NULL
            ELSE (COUNT(*) FILTER (WHERE NOT EXISTS (
                     SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $2::int)))::int
       END AS unseen
  FROM questions q
 WHERE q.archived_at IS NULL
   AND ($1::text IS NULL OR q.subject = $1)
 GROUP BY q.subject, q.chapter`,
        values: [subject, studentId]
    };
}

/**
 * 每個知識點掛了幾題未封存題（$1 subject｜NULL＝全部）。
 * @param {{subject:string|null}} opts
 * @returns {{text:string, values:any[]}}
 */
function buildKcCoverage({ subject = null } = {}) {
    return {
        text: `SELECT k.code, k.name, k.subject, k.chapter, k.sort,
       COUNT(q.id)::int AS total
  FROM knowledge_components k
  LEFT JOIN question_kcs qk ON qk.kc_id = k.id
  LEFT JOIN questions q ON q.id = qk.question_id AND q.archived_at IS NULL
 WHERE ($1::text IS NULL OR k.subject = $1)
 GROUP BY k.id, k.code, k.name, k.subject, k.chapter, k.sort`,
        values: [subject]
    };
}

/** 要列的科目（有指定就只列那一科）。 */
function subjectsOf(subject) {
    return subject ? [subject] : [...SUBJECTS];
}

/**
 * 把 DB 聚合列攤成白名單順序的完整列（純函式）。
 * @param {Array<{subject:string, chapter:string, total:number, d1:number, d2:number, d3:number, d4:number, d5:number, unseen:number|null}>} dbRows
 * @param {{subject:string|null, withStudent:boolean}} opts
 * @returns {Array<{subject:string, volume:string|null, chapter:string, total:number,
 *                  by_difficulty:Record<string,number>, unseen_by_student:number|null}>}
 */
function assembleChapterRows(dbRows, { subject = null, withStudent = false } = {}) {
    const byKey = new Map(dbRows.map(r => [`${r.subject}\u0000${r.chapter}`, r]));
    const used = new Set();
    const row = (subj, volume, chapter) => {
        const key = `${subj}\u0000${chapter}`;
        used.add(key);
        const r = byKey.get(key);
        const by = Object.fromEntries(DIFFICULTIES.map(d => [d, r ? Number(r[`d${d}`]) || 0 : 0]));
        return {
            subject: subj,
            volume,
            chapter,
            total: r ? Number(r.total) || 0 : 0,
            by_difficulty: by,
            unseen_by_student: withStudent ? (r ? Number(r.unseen) || 0 : 0) : null
        };
    };

    const out = [];
    for (const subj of subjectsOf(subject)) {
        for (const vol of VOLUMES[subj] || []) {
            for (const chapter of vol.chapters) out.push(row(subj, vol.name, chapter));
        }
        // 不在白名單的舊章節（例如白名單改名前入庫的題）：接在該科最後，依章名排序
        const legacy = dbRows
            .filter(r => r.subject === subj && !used.has(`${r.subject}\u0000${r.chapter}`))
            .map(r => r.chapter)
            .sort();
        for (const chapter of legacy) out.push(row(subj, null, chapter));
    }
    return out;
}

/**
 * 知識點列排序並只留契約的四個鍵（純函式）。
 * @param {Array<{code:string, name:string, subject:string, chapter:string, sort:number, total:number}>} rows
 * @returns {Array<{code:string, name:string, chapter:string, total:number}>}
 */
function orderKcRows(rows) {
    const chapterIndex = new Map();
    SUBJECTS.forEach((s, si) => {
        let ci = 0;
        for (const vol of VOLUMES[s] || []) for (const ch of vol.chapters) chapterIndex.set(`${s}\u0000${ch}`, si * 1000 + ci++);
    });
    const subjIndex = s => { const i = SUBJECTS.indexOf(s); return i < 0 ? SUBJECTS.length : i; };
    const rank = r => chapterIndex.get(`${r.subject}\u0000${r.chapter}`) ?? (subjIndex(r.subject) * 1000 + 999);
    return [...rows]
        .sort((a, b) => (rank(a) - rank(b))
            || (a.chapter < b.chapter ? -1 : a.chapter > b.chapter ? 1 : 0)
            || (Number(a.sort) - Number(b.sort))
            || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map(r => ({ code: r.code, name: r.name, chapter: r.chapter, total: Number(r.total) || 0 }));
}

/**
 * 讀出覆蓋率（I/O）。
 * @param {{subject:string|null, studentId:number|null}} opts
 * @param {{query:Function}} deps
 * @returns {Promise<{rows:object[], kc_rows:object[]}>}
 */
async function loadCoverage({ subject = null, studentId = null }, deps) {
    const a = buildChapterCoverage({ subject, studentId });
    const b = buildKcCoverage({ subject });
    const [chapters, kcs] = await Promise.all([deps.query(a.text, a.values), deps.query(b.text, b.values)]);
    return {
        rows: assembleChapterRows(chapters.rows, { subject, withStudent: studentId !== null }),
        kc_rows: orderKcRows(kcs.rows)
    };
}

module.exports = { DIFFICULTIES, buildChapterCoverage, buildKcCoverage, assembleChapterRows, orderKcRows, loadCoverage };
