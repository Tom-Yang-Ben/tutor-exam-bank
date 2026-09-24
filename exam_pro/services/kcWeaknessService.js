// ─────────────────────────────────────────────────────────────
// services/kcWeaknessService.js — 知識點弱點（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 1 項；DEC-016）
//
//   GET /api/students/:id/weakness/kc?days=&subject=
//   → { rows: [{ kc_id, code, name, subject, chapter, graded, correct, correct_rate, mastery_lb, low_sample }],
//       untagged_graded }
//
// 語意（契約凍結）：
//   - 以 question_kcs.weight 加權：一題掛兩個知識點、權重 0.5／1，這一題的批改對兩個知識點
//     各貢獻 0.5 題與 1 題的「樣本量」。graded、correct 因此可能是小數。
//   - 正確度 = COALESCE(score, result)：部分給分（WS-A 的 attempts.score）優先，沒給分才看 0／1。
//     「已批改」＝ result IS NOT NULL（score 只能搭配 result 0／1，見契約第 4.1 條）。
//   - mastery_lb 是正確率的 Wilson 下界（z = 1.96），排序依它由低到高：
//     **樣本少的知識點下界自然偏低**，排在前面等於「還不確定會不會」也要優先看，
//     比單看正確率誠實（1 題對 1 題不等於精熟）。
//   - low_sample 門檻沿用 WEAKNESS_MIN_N（與章節弱點面板同一個設定，比較的是加權後的 graded）。
//   - 時間窗、學科篩選與參數順序沿用 services/weaknessService.js 的凍結規則：
//     $1 = studentId、$2 = days、$3 = subject；不排除已封存題（歷史紀錄不因封存消失，裁決 S3-2）。
//
// 本檔 SQL builder 是純函式（組字串與參數陣列，不連 DB）；Wilson 下界與後處理也是純函式，
// 由 test/unit/kcWeakness.test.js 釘住。正確性由 test/integration/remedial.pg.test.js 真的送進 Postgres 驗。
// ─────────────────────────────────────────────────────────────

/** Wilson 區間的 z 值（95% 雙尾；契約凍結 1.96）。 */
const WILSON_Z = 1.96;

/**
 * 正確率的 Wilson 下界。
 *
 * 公式：(p + z²/2n − z·√(p(1−p)/n + z²/4n²)) / (1 + z²/n)。
 * n 可以是小數（知識點加權後的樣本量），公式照樣成立。
 *
 * 邊界：
 *   - n ≤ 0（沒有任何批改）→ **null**：沒有資料不等於掌握度 0（與 wrong_rate 在 graded=0 時為 null 同一條線，裁決 S3-3）。
 *   - 全錯（correct = 0）→ 0。
 *   - 全對 → 小於 1 的下界（n=10 時約 0.7225），樣本越多越接近 1。
 *   - correct 超出 [0, n] 時先夾回區間；浮點誤差造成的極小負值夾成 0。
 *
 * @param {number} correct 加權答對量
 * @param {number} n       加權批改量
 * @param {number} [z]
 * @returns {number|null} 0~1；n ≤ 0 時為 null
 */
function wilsonLowerBound(correct, n, z = WILSON_Z) {
    const total = Number(n);
    if (!Number.isFinite(total) || total <= 0) return null;
    const c = Math.min(Math.max(Number(correct) || 0, 0), total);
    const p = c / total;
    const z2 = z * z;
    const center = p + z2 / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
    const lb = (center - margin) / (1 + z2 / total);
    return Math.min(Math.max(lb, 0), 1);
}

/**
 * 四捨五入到小數第 4 位（null／NaN 原樣回 null）。
 * @param {number|null|undefined} x
 * @returns {number|null}
 */
function round4(x) {
    if (x === null || x === undefined) return null;
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
}

/** 參數正規化（同 weaknessService.baseValues）：空字串／undefined 的 subject 視為不分科。 */
function baseValues(opts) {
    const { studentId, subject, days } = opts || {};
    const normalizedSubject = (subject === undefined || subject === null || subject === '') ? null : subject;
    return [studentId, days, normalizedSubject];
}

/** 時間窗內該生的作答（含未批改），$1 studentId、$2 days、$3 subject。 */
const WINDOW_WHERE = `WHERE a.student_id = $1
     AND a.assigned_at >= CURRENT_DATE - $2::int
     AND ($3::text IS NULL OR q.subject = $3)`;

/**
 * 每個知識點的加權聚合（原始值，未四捨五入）。
 *
 * 輸出欄：kc_id, code, name, subject, chapter, sort, graded, correct,
 *         avg_wrong_difficulty（答錯題＝正確度 < 1 的加權平均難度；沒有答錯題時為 NULL）,
 *         avg_graded_difficulty（已批改題的加權平均難度）。
 * 後兩欄給補救卷定難度區間用（services/remedialService.js），API 不輸出。
 *
 * 只列「時間窗內至少有一筆作答（含未批改）掛到它」的知識點；只指派未批改的知識點 graded = 0。
 * 只算與題目**同科**的標註（〔stage5 審查修正 S5-42〕，理由見 SAME_SUBJECT_TAG）。
 * weight 是 REAL，先轉 float8 再算，避免 SUM(real) 的單精度誤差。
 *
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildKcAggregate(opts) {
    const text = `WITH w AS (
  SELECT a.question_id, q.subject AS q_subject, q.difficulty::float8 AS difficulty,
         (a.result IS NOT NULL) AS is_graded,
         COALESCE(a.score::float8, a.result::float8) AS correctness
    FROM attempts a JOIN questions q ON q.id = a.question_id
   ${WINDOW_WHERE}
), agg AS (
  SELECT qk.kc_id,
         COALESCE(SUM(qk.weight::float8) FILTER (WHERE w.is_graded), 0)                 AS graded,
         COALESCE(SUM(qk.weight::float8 * w.correctness) FILTER (WHERE w.is_graded), 0) AS correct,
         SUM(qk.weight::float8 * w.difficulty) FILTER (WHERE w.is_graded AND w.correctness < 1)
           / NULLIF(SUM(qk.weight::float8) FILTER (WHERE w.is_graded AND w.correctness < 1), 0) AS avg_wrong_difficulty,
         SUM(qk.weight::float8 * w.difficulty) FILTER (WHERE w.is_graded)
           / NULLIF(SUM(qk.weight::float8) FILTER (WHERE w.is_graded), 0)                   AS avg_graded_difficulty
    FROM w JOIN question_kcs qk ON qk.question_id = w.question_id
           JOIN knowledge_components kx ON kx.id = qk.kc_id AND kx.subject = w.q_subject
   GROUP BY qk.kc_id
)
SELECT k.id AS kc_id, k.code, k.name, k.subject, k.chapter, k.sort,
       agg.graded, agg.correct, agg.avg_wrong_difficulty, agg.avg_graded_difficulty
  FROM agg JOIN knowledge_components k ON k.id = agg.kc_id`;
    return { text, values: baseValues(opts) };
}

/**
 * 「這一題有標到**同科**知識點」的子查詢（a、q 來自外層）。
 * 〔stage5 審查修正 S5-42〕題目改科時 PUT /api/questions/:id 會刪掉別科的標註；這裡再守一道，
 * 別科的標註（例如直接改 DB 寫進去的）不算數——否則 basis 會判成 kc，卻一個同科的知識點都排不出來。
 */
const SAME_SUBJECT_TAG = `SELECT 1 FROM question_kcs qk JOIN knowledge_components kx ON kx.id = qk.kc_id
                  WHERE qk.question_id = a.question_id AND kx.subject = q.subject`;

/**
 * 已批改題依「有沒有任何（同科的）知識點標註」分兩堆計數。
 * tagged_graded 決定補救卷的 basis（≥ WEAKNESS_MIN_N 用 kc），untagged_graded 直接進 API 回應。
 *
 * @param {{ studentId:number, subject:string|null, days:number }} opts
 * @returns {{ text:string, values:any[] }} values = [studentId, days, subject]
 */
function buildGradedTagCounts(opts) {
    const text = `SELECT
  COUNT(*) FILTER (WHERE EXISTS (${SAME_SUBJECT_TAG}))::int     AS tagged_graded,
  COUNT(*) FILTER (WHERE NOT EXISTS (${SAME_SUBJECT_TAG}))::int AS untagged_graded
  FROM attempts a JOIN questions q ON q.id = a.question_id
 ${WINDOW_WHERE}
   AND a.result IS NOT NULL`;
    return { text, values: baseValues(opts) };
}

/**
 * 聚合列 → 帶正確率、Wilson 下界、low_sample 的單位，並依 mastery_lb 由低到高排序。
 *
 * 排序：mastery_lb ASC（null＝沒有批改，排最後）→ graded DESC → key ASC。
 * 同一支給知識點與章節兩種單位共用（補救卷的章節退回路徑也走這裡）。
 *
 * @template T
 * @param {Array<T & {graded:number, correct:number}>} rows
 * @param {number} minN WEAKNESS_MIN_N
 * @param {(row:T)=>string} keyOf 同分時的穩定次序鍵（code 或 chapter）
 * @returns {Array<T & {graded:number, correct:number, correct_rate:number|null, mastery_lb:number|null, low_sample:boolean}>}
 */
function rankUnits(rows, minN, keyOf) {
    const out = rows.map(row => {
        const graded = Number(row.graded) || 0;
        const correct = Number(row.correct) || 0;
        return {
            ...row,
            graded: round4(graded),
            correct: round4(correct),
            correct_rate: graded > 0 ? round4(correct / graded) : null,
            mastery_lb: round4(wilsonLowerBound(correct, graded)),
            low_sample: graded < minN
        };
    });
    out.sort((a, b) => {
        if (a.mastery_lb === null && b.mastery_lb !== null) return 1;
        if (b.mastery_lb === null && a.mastery_lb !== null) return -1;
        if (a.mastery_lb !== b.mastery_lb) return a.mastery_lb - b.mastery_lb;
        if (a.graded !== b.graded) return b.graded - a.graded;
        const ka = keyOf(a), kb = keyOf(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return out;
}

/**
 * API 的輸出列（只留契約列出的十個鍵，順序照契約）。
 * @param {object} u rankUnits 的一列
 * @returns {object}
 */
function toApiRow(u) {
    return {
        kc_id: u.kc_id, code: u.code, name: u.name, subject: u.subject, chapter: u.chapter,
        graded: u.graded, correct: u.correct, correct_rate: u.correct_rate,
        mastery_lb: u.mastery_lb, low_sample: u.low_sample
    };
}

/**
 * 讀出該生的知識點弱點（I/O；給 controller 與補救卷共用）。
 * @param {{ studentId:number, subject:string|null, days:number, minN:number }} opts
 * @param {{ query:(text:string, values:any[])=>Promise<{rows:object[]}> }} deps
 * @returns {Promise<{ units:object[], taggedGraded:number, untaggedGraded:number }>}
 *          units＝rankUnits 後的完整列（含 avg_*_difficulty 與 sort）
 */
async function loadKcWeakness(opts, deps) {
    const agg = buildKcAggregate(opts);
    const counts = buildGradedTagCounts(opts);
    const [a, c] = await Promise.all([deps.query(agg.text, agg.values), deps.query(counts.text, counts.values)]);
    const units = rankUnits(a.rows, opts.minN, u => u.code);
    const { tagged_graded: taggedGraded = 0, untagged_graded: untaggedGraded = 0 } = c.rows[0] || {};
    return { units, taggedGraded, untaggedGraded };
}

module.exports = {
    WILSON_Z,
    wilsonLowerBound,
    round4,
    buildKcAggregate,
    buildGradedTagCounts,
    rankUnits,
    toApiRow,
    loadKcWeakness
};
