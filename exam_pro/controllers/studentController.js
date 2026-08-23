// ─────────────────────────────────────────────────────────────
// controllers/studentController.js — 學生清單、試卷清單與弱點面板（P-04，擁有者：WS-A）
//
// 形狀與錯誤訊息**逐字**凍結於 docs/interfaces-stage3.md 第 1.1、1.2、1.5 條。
//
//   GET /api/students                              導覽用清單
//   GET /api/students/:id/papers                   批改入口（最近出的卷在最上面）
//   GET /api/students/:id/weakness?subject=&days=  五張表的即時聚合
//
// 三支全部掛在 apiKeyAuth 之後（app.js 已對 /api 全域套用），
// 且只在 FEATURE_STUDENTS 開啟時掛載（routes/index.js 的 [WS3-A: students] 區塊）。
//
// SQL 分兩處：弱點面板的五條在 services/weaknessService.js（純函式，可離線單測）；
// 前兩支的兩條 SQL 很短、且形狀就是回應本身，留在這裡讀起來比拆出去清楚。
// ─────────────────────────────────────────────────────────────
const { query } = require('../config/db');
const { SUBJECTS } = require('../config/chapters');
const weakness = require('../services/weaknessService');

/** 第 1.5 條的預設時間窗。 */
const DEFAULT_DAYS = 90;
/** days 的合法區間（第 1.5 條凍結）。 */
const MIN_DAYS = 1;
const MAX_DAYS = 365;
/** WEAKNESS_MIN_N 沒設或設壞時的預設值（第 9 條）。 */
const DEFAULT_WEAKNESS_MIN_N = 5;

const STUDENT_NOT_FOUND = '找不到該學生';

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 路徑上的 `:id` → 正整數，不合法回 null。
 *
 * 第 1.2 條：`:id` **不是整數也回 404，不回 400**。理由是「/api/students/abc/papers」
 * 在使用者眼中就是一個不存在的資源，回 400 反而像是我們接受了這個 id 但嫌它格式不好。
 * 用 String(Number(x)) 比對可以擋掉 '3abc'／'3.5'／' 3'（parseInt 會放行前兩個）。
 *
 * @param {any} raw
 * @returns {number|null}
 */
function parseId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || String(n) !== s) return null;
    return n;
}

/**
 * `graded < WEAKNESS_MIN_N` 的門檻。每次請求即時讀，不在 require 當下固定住
 * （與 config/features.js 同一個理由：require 的時機早於某些測試設定環境變數）。
 *
 * @returns {number}
 */
function weaknessMinN() {
    const n = parseInt(process.env.WEAKNESS_MIN_N, 10);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WEAKNESS_MIN_N;
}

/**
 * 解析並驗證 weakness 的兩個查詢參數。
 *
 * @param {object} q req.query
 * @returns {{ error:string } | { subject:string|null, days:number }}
 */
function parseWeaknessQuery(q) {
    const rawSubject = q.subject;
    // 空字串（?subject=）視為「不分科」——第 1.5 條的範例網址就是這樣寫的
    const subject = (rawSubject === undefined || rawSubject === null || String(rawSubject) === '')
        ? null : String(rawSubject);
    if (subject !== null && !SUBJECTS.includes(subject)) {
        return { error: 'subject 不在白名單內。' };
    }

    const rawDays = q.days;
    if (rawDays === undefined || rawDays === null || String(rawDays) === '') {
        return { subject, days: DEFAULT_DAYS };
    }
    const s = String(rawDays).trim();
    const days = Number(s);
    if (!Number.isInteger(days) || String(days) !== s || days < MIN_DAYS || days > MAX_DAYS) {
        return { error: `days 必須是 ${MIN_DAYS}~${MAX_DAYS} 的整數。` };
    }
    return { subject, days };
}

/**
 * 三張聚合表共用的後處理：加上 low_sample。
 *
 * 門檻刻意留在這一層而不寫進 SQL（第 1.6 條）：它是設定值，
 * 改一次不該動 SQL。`graded = 0` 也是 low_sample（裁決 S3-3）——
 * 沒批改不等於全對，面板要能誠實地說「不知道」。
 *
 * @param {object[]} rows
 * @param {number} minN
 * @returns {object[]}
 */
function withLowSample(rows, minN) {
    return rows.map(row => ({ ...row, low_sample: Number(row.graded) < minN }));
}

// ─────────────────── 1.1 GET /api/students ───────────────────

exports.listStudents = async (req, res, next) => {
    try {
        // 兩個子查詢先各自聚合再 LEFT JOIN，不直接把 exam_papers 與 attempts
        // 一起 JOIN 上來——那會變成笛卡兒積，papers 會被 attempts 的列數乘大。
        //
        // 沒有任何試卷的學生也要出現（第 1.1 條），所以外層是 students LEFT JOIN。
        // graded_ratio 在 SQL 裡算：round(numeric, 4) 是精確的，
        // 在 JS 端 Math.round(x*10000)/10000 會踩到浮點數的邊界。
        // 該生沒有任何 attempts 時 COALESCE 回 0（不是 null、不是 NaN）。
        const { rows } = await query(
            `SELECT s.id, s.name,
                    COALESCE(p.papers, 0)::int AS papers,
                    COALESCE(round(a.graded::numeric / NULLIF(a.total, 0), 4), 0)::float8 AS graded_ratio
               FROM students s
               LEFT JOIN (SELECT student_id, COUNT(*) AS papers
                            FROM exam_papers GROUP BY student_id) p ON p.student_id = s.id
               LEFT JOIN (SELECT student_id,
                                 COUNT(*)                                   AS total,
                                 COUNT(*) FILTER (WHERE result IS NOT NULL) AS graded
                            FROM attempts GROUP BY student_id) a ON a.student_id = s.id
              ORDER BY s.name, s.id`
        );
        res.status(200).json({ items: rows });
    } catch (err) {
        next(err);
    }
};

// ───────────── 1.2 GET /api/students/:id/papers ─────────────

exports.listStudentPapers = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });

    try {
        const { rowCount } = await query('SELECT 1 FROM students WHERE id = $1', [studentId]);
        if (rowCount === 0) return res.status(404).json({ message: STUDENT_NOT_FOUND });

        // total 直接數 question_ids 陣列（cardinality），不從 attempts 反推：
        // 兩者理論上相同，但 question_ids 才是「這張卷上有幾題」的定義來源。
        // 排序：最近出的卷在最上面——這是批改入口，不是歷史檔案（第 1.2 條）。
        const { rows } = await query(
            `SELECT p.id AS paper_id, p.title, p.created_at,
                    cardinality(p.question_ids) AS total,
                    COALESCE(g.graded, 0)::int  AS graded
               FROM exam_papers p
               LEFT JOIN (SELECT paper_id, COUNT(*) FILTER (WHERE result IS NOT NULL) AS graded
                            FROM attempts WHERE paper_id IS NOT NULL GROUP BY paper_id) g
                      ON g.paper_id = p.id
              WHERE p.student_id = $1
              ORDER BY p.created_at DESC, p.id DESC`,
            [studentId]
        );
        res.status(200).json({ items: rows });
    } catch (err) {
        next(err);
    }
};

// ────────── 1.5 GET /api/students/:id/weakness ──────────

exports.getWeakness = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });

    const parsed = parseWeaknessQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const { subject, days } = parsed;

    try {
        const { rowCount } = await query('SELECT 1 FROM students WHERE id = $1', [studentId]);
        if (rowCount === 0) return res.status(404).json({ message: STUDENT_NOT_FOUND });

        const opts = { studentId, subject, days };
        // 五條互不相依，一起發出去；同一個 pool，五條各借一條連線。
        const [chapter, type, difficulty, trend, recent] = await Promise.all([
            weakness.buildByChapter(opts),
            weakness.buildByType(opts),
            weakness.buildByDifficulty(opts),
            weakness.buildTrendWeekly(opts),
            weakness.buildRecentWrong(opts)
        ].map(({ text, values }) => query(text, values)));

        const minN = weaknessMinN();
        res.status(200).json({
            by_chapter: withLowSample(chapter.rows, minN),
            by_type: withLowSample(type.rows, minN),
            by_difficulty: withLowSample(difficulty.rows, minN),
            // trend_weekly 沒有 low_sample：它是「這週批了幾題、錯幾題」的原始計數，
            // 不是比率，沒有樣本不足的問題（第 1.5 條的形狀只有三個鍵）。
            trend_weekly: trend.rows,
            recent_wrong: recent.rows
        });
    } catch (err) {
        next(err);
    }
};

// 給整合測試與同 WS 的 paperController 共用（不對外掛成路由）
exports._internals = { parseId, parseWeaknessQuery, weaknessMinN, withLowSample };
