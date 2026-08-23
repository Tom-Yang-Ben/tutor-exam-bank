// ─────────────────────────────────────────────────────────────
// services/weaknessService.js — 弱點面板的五支「建查詢」純函式（P-02，擁有者：WS-A）
//
// 形狀凍結於 docs/interfaces-stage3.md 第 1.5、1.6 條：
//   buildByChapter / buildByType / buildByDifficulty / buildTrendWeekly / buildRecentWrong
//   五支都回 { text, values }，直接餵給 config/db.js 的 query(text, values)。
//
// 這一層是**純函式**：只組字串與參數陣列——不連 DB、不讀 process.env、
// 無時間、無隨機。`low_sample` 的門檻（WEAKNESS_MIN_N）刻意不寫進 SQL，
// 由 controller 依設定值算（第 1.6 條）：門檻是設定，改一次不該動 SQL。
//
// ⚠️ 兩件事在這裡是硬規則，不是風格：
//
//  1. **參數順序凍結為 $1 = studentId、$2 = days、$3 = subject、$4 = limit**（裁決 S3-4）。
//     純文字單測擋不了 SQL 語法錯（那要真的送進 Postgres 才知道），
//     它唯一擋得住的就是參數錯位——把 days 與 subject 對調不會噴錯，
//     只會讓面板安靜地回一張空表。test/unit/weaknessService.test.js 釘的就是這個。
//
//  2. **三張聚合表一律用 CTE 外包一層**。Postgres 只允許輸出欄位別名在
//     ORDER BY 中**單獨出現**；`ORDER BY wrong::float / NULLIF(graded,0)` 會報
//     `column "wrong" does not exist`（規劃 §4.3.5）。先在 CTE 裡把
//     assigned/graded/wrong 聚合出來，外層才算得出 wrong_rate 並拿它排序。
//     正確性由 test/integration/students.pg.test.js 保證，不是由純文字單測保證。
//
// 其他被凍結的語意（第 1.5 條）：
//   - 時間窗一律 `a.assigned_at >= CURRENT_DATE - $2::int`
//   - 學科一律 `($3::text IS NULL OR q.subject = $3)`
//   - **不排除已封存題**（裁決 S3-2）：歷史紀錄不該因為題目被封存就消失
//   - wrong_rate 四捨五入到小數第 4 位；graded = 0 時是 NULL（裁決 S3-3）
//   - 三張表排序固定 `ORDER BY wrong_rate DESC NULLS LAST, graded DESC, <分組欄> ASC`
// ─────────────────────────────────────────────────────────────

/** 三張聚合表共用的 WHERE：$1 = studentId、$2 = days、$3 = subject。 */
const AGG_WHERE = `WHERE a.student_id = $1
     AND a.assigned_at >= CURRENT_DATE - $2::int
     AND ($3::text IS NULL OR q.subject = $3)`;

/** recent_wrong 的預設筆數（第 1.5 條凍結為 20）。 */
const DEFAULT_RECENT_LIMIT = 20;

/**
 * 三張聚合表同形，只差「分組欄」與它的輸出名稱。
 *
 * @param {string} groupExpr  SQL 中的分組運算式，例如 'q.chapter'
 * @param {string} outName    輸出欄名（凍結：chapter／question_type／difficulty）
 * @returns {string} 完整 SQL
 */
function aggregateSql(groupExpr, outName) {
    return `WITH agg AS (
  SELECT ${groupExpr} AS ${outName},
         COUNT(*)                                     AS assigned,
         COUNT(*) FILTER (WHERE a.result IS NOT NULL) AS graded,
         COUNT(*) FILTER (WHERE a.result = 0)         AS wrong
    FROM attempts a JOIN questions q ON q.id = a.question_id
   ${AGG_WHERE}
   GROUP BY ${groupExpr}
)
SELECT ${outName}, assigned, graded, wrong,
       round((wrong::numeric / NULLIF(graded, 0)), 4)::float8 AS wrong_rate
  FROM agg
 ORDER BY wrong_rate DESC NULLS LAST, graded DESC, ${outName} ASC`;
}

/**
 * 五支共用的參數正規化。
 *
 * 這裡**不做驗證**（subject 白名單、days 1~365 由 controller 擋並回 400）；
 * 只負責把 undefined／空字串收斂成 SQL 需要的 null，讓
 * `($3::text IS NULL OR q.subject = $3)` 這一段在「不分科」時真的成立。
 *
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {[number, number, string|null]} 凍結順序的前三個參數
 */
function baseValues(opts) {
    const { studentId, subject, days } = opts || {};
    // 空字串（?subject=）與 undefined 一律視為「不分科」
    const normalizedSubject = (subject === undefined || subject === null || subject === '') ? null : subject;
    return [studentId, days, normalizedSubject];
}

/**
 * 章節錯誤率。
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildByChapter(opts) {
    return { text: aggregateSql('q.chapter', 'chapter'), values: baseValues(opts) };
}

/**
 * 題型錯誤率。
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildByType(opts) {
    return { text: aggregateSql('q.question_type', 'question_type'), values: baseValues(opts) };
}

/**
 * 難度錯誤率。
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildByDifficulty(opts) {
    return { text: aggregateSql('q.difficulty', 'difficulty'), values: baseValues(opts) };
}

/**
 * 週趨勢：只列**有資料的週**（不補零，斷點由前端處理）。
 *
 * `date_trunc('week', …)` 是 ISO 週、週一起算；`::date` 之後
 * config/db.js 已把 DATE（OID 1082）的 type parser 設成回字串，
 * 所以 week_start 是 'YYYY-MM-DD' **字串**——不要在這裡轉成 Date，
 * 那會在台灣時區早上 8 點前差一天（第 1.5 條）。
 *
 * 這一支同樣用 CTE 外包：分組鍵是運算式，外層才好用單獨的別名排序。
 *
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildTrendWeekly(opts) {
    const text = `WITH agg AS (
  SELECT date_trunc('week', a.assigned_at)::date       AS week_start,
         COUNT(*) FILTER (WHERE a.result IS NOT NULL)  AS graded,
         COUNT(*) FILTER (WHERE a.result = 0)          AS wrong
    FROM attempts a JOIN questions q ON q.id = a.question_id
   ${AGG_WHERE}
   GROUP BY date_trunc('week', a.assigned_at)::date
)
SELECT week_start, graded, wrong
  FROM agg
 ORDER BY week_start ASC`;
    return { text, values: baseValues(opts) };
}

/**
 * 最近錯題（result = 0）。
 *
 * `assigned_at` 同樣是 'YYYY-MM-DD' 字串。排序與 LIMIT 凍結：
 * `ORDER BY a.assigned_at DESC, a.question_id DESC LIMIT 20`。
 *
 * @param {{ studentId:number, subject:string|null, days:number, limit?:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject, limit]
 */
function buildRecentWrong(opts) {
    const { limit } = opts || {};
    const text = `SELECT a.question_id, q.chapter, q.question_text, a.assigned_at
  FROM attempts a JOIN questions q ON q.id = a.question_id
 ${AGG_WHERE}
   AND a.result = 0
 ORDER BY a.assigned_at DESC, a.question_id DESC
 LIMIT $4`;
    return {
        text,
        values: [...baseValues(opts), limit === undefined || limit === null ? DEFAULT_RECENT_LIMIT : limit]
    };
}

module.exports = {
    buildByChapter,
    buildByType,
    buildByDifficulty,
    buildTrendWeekly,
    buildRecentWrong,
    DEFAULT_RECENT_LIMIT
};
