// ─────────────────────────────────────────────────────────────
// services/remedialEffectService.js — 補救成效追蹤（〔dec/r16-remedial〕；docs/remedial.md 第 10 節）
//
//   GET /api/students/:id/remedial-effect?limit=&days=
//
// 補救卷確認時存了目標快照（exam_papers.kind = 'remedial'、targets，migrations/0022）。這裡對每一份補救卷的
// 每個**補救組**目標單位，比較三段：
//
//   before    快照裡的基準（出卷當下的批改量、答錯量、錯誤率）；答對率＝1 − 錯誤率。事後不重算——
//             弱點面板的數字會隨新的批改一直變，重算出來的不是「補救前」。
//   on_paper  這張補救卷上、這個單位的題的作答（答對率）。只看參考，不進 status。
//   after     **之後**的其他卷上、這個單位的作答：卷的建立時間晚於「補救卷批改完的時間」
//             （補救卷上每一題都批改了＝最後一題的 graded_at；還沒批改完時改用補救卷的建立時間），
//             可用 days 限制只看那之後幾天內建立的卷。沒有卷號的歷史作答（階段 1 匯入）不算。
//
// 規則（與弱點面板、補救卷選題同一條線）：
//   - 只算每題**第一次**作答（檢視 attempts，R10）：重練、回測的作答不進成效，那是「重練成效」的事。
//   - 正確度＝COALESCE(score, result)（部分給分優先）；已批改＝result IS NOT NULL。
//   - 知識點單位依 question_kcs.weight 加權、只算同科標註（同 kcWeaknessService）；章節單位每題權重 1。
//   - delta＝after 答對率 − before 答對率（四捨五入到小數第 4 位）；任一邊沒有資料時為 null。
//   - low_sample：after 的批改量 < WEAKNESS_MIN_N（與弱點面板同一個設定）。
//   - status（依序判斷）：
//       pending            補救卷還沒批改完
//       insufficient_data  補救前沒有批改資料，或 after 的批改量 < MIN_AFTER_GRADED
//       improved           delta ≥ IMPROVED_DELTA
//       worse              delta ≤ WORSE_DELTA
//       no_change          其餘
//
// 本檔的 SQL builder 與判斷都是純函式（test/unit/remedialEffect.test.js 釘住）；loadRemedialEffect 是 I/O，
// 由 test/integration/remedialEffect.pg.test.js 真的送進 Postgres 驗。不呼叫 LLM、不寫資料庫、log 不含學生姓名。
// ─────────────────────────────────────────────────────────────
const { round4 } = require('./kcWeaknessService');
const { labelOf } = require('../config/errorTypes');

/** 答對率至少進步這麼多（比例）才算「進步」。 */
const IMPROVED_DELTA = 0.10;
/** 答對率至少退步這麼多（負數）才算「退步」。 */
const WORSE_DELTA = -0.10;
/** after 至少要批改這麼多題（知識點單位為加權題數）才判斷進步或退步；更少時是 insufficient_data。 */
const MIN_AFTER_GRADED = 2;
/** limit 的預設與上限。 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 浮點比較的容許誤差（0.1 − 0.0000001 這種邊界算達標）。 */
const EPS = 1e-9;

// ───────────────────────── 純函式 ─────────────────────────

/**
 * 某生的補救卷（新到舊）＋每張卷的批改進度（$1 studentId、$2 limit）。
 * 批改進度看這張卷上**全部**派題（含重練題，assignment_attempts）：卷上每一題都批改了才算批改完。
 * @returns {{text:string, values:any[]}}
 */
function buildPapersQuery({ studentId, limit }) {
    return {
        text: `SELECT p.id, p.title, p.created_at, p.targets,
       (SELECT COUNT(*) FROM assignment_attempts aa WHERE aa.paper_id = p.id)::int AS assigned,
       (SELECT COUNT(*) FROM assignment_attempts aa WHERE aa.paper_id = p.id AND aa.result IS NOT NULL)::int AS graded,
       (SELECT MAX(aa.graded_at) FROM assignment_attempts aa WHERE aa.paper_id = p.id) AS last_graded_at
  FROM exam_papers p
 WHERE p.student_id = $1 AND p.kind = 'remedial'
 ORDER BY p.created_at DESC, p.id DESC
 LIMIT $2`,
        values: [studentId, limit]
    };
}

/**
 * 一張補救卷的各目標在「這張卷上」與「之後」的作答聚合。
 * $1 studentId、$2 目標（JSON：[{ idx, unit_type, subject, chapter, kc_id }]）、$3 paperId、$4 起算時間（anchor）、$5 days（NULL＝不限）。
 *
 * 只讀檢視 attempts（每題第一次作答，R10）；after 只收有卷號、卷的建立時間在 anchor 之後（且在 days 內）的作答。
 * 輸出每列：idx、on_paper（true＝這張卷上）、assigned、graded、correct（加權）、papers（after 有批改的卷數）。
 * @returns {{text:string, values:any[]}}
 */
function buildEffectQuery({ studentId, units, paperId, anchor, days }) {
    return {
        text: `WITH t AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(idx int, unit_type text, subject text, chapter text, kc_id int)
), w AS (
  SELECT a.question_id, a.paper_id, q.subject, q.chapter,
         (a.result IS NOT NULL) AS is_graded,
         COALESCE(a.score::float8, a.result::float8) AS correctness
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    LEFT JOIN exam_papers ep ON ep.id = a.paper_id
   WHERE a.student_id = $1
     AND (a.paper_id = $3
          OR (a.paper_id <> $3 AND ep.created_at > $4::timestamptz
              AND ($5::int IS NULL OR ep.created_at <= $4::timestamptz + make_interval(days => $5::int))))
), m AS (
  SELECT t.idx, w.paper_id, w.is_graded, w.correctness, 1::float8 AS weight
    FROM t JOIN w ON t.unit_type = 'chapter' AND w.subject = t.subject AND w.chapter = t.chapter
  UNION ALL
  SELECT t.idx, w.paper_id, w.is_graded, w.correctness, qk.weight::float8
    FROM t JOIN question_kcs qk ON t.unit_type = 'kc' AND qk.kc_id = t.kc_id
           JOIN w ON w.question_id = qk.question_id
           JOIN knowledge_components kx ON kx.id = qk.kc_id AND kx.subject = w.subject
)
SELECT idx, (paper_id = $3) AS on_paper,
       COALESCE(SUM(weight), 0)::float8                                   AS assigned,
       COALESCE(SUM(weight) FILTER (WHERE is_graded), 0)::float8          AS graded,
       COALESCE(SUM(weight * correctness) FILTER (WHERE is_graded), 0)::float8 AS correct,
       (COUNT(DISTINCT paper_id) FILTER (WHERE is_graded))::int           AS papers
  FROM m
 GROUP BY idx, (paper_id = $3)`,
        values: [studentId, JSON.stringify(units), paperId, anchor, days ?? null]
    };
}

/**
 * 補救卷批改完了沒、從什麼時候起算「之後」（純函式）。
 * @param {{assigned:number, graded:number, created_at:Date|string, last_graded_at:Date|string|null}} p
 * @returns {{graded:boolean, anchor:Date|string}}
 */
function paperAnchor(p) {
    const graded = p.assigned > 0 && p.graded === p.assigned && p.last_graded_at !== null && p.last_graded_at !== undefined;
    return { graded, anchor: graded ? p.last_graded_at : p.created_at };
}

/** 聚合列 → { graded, correct, rate }（純函式）。 */
function rateOf(row) {
    const graded = row ? Number(row.graded) || 0 : 0;
    const correct = row ? Number(row.correct) || 0 : 0;
    return { graded: round4(graded), correct: round4(correct), rate: graded > 0 ? round4(correct / graded) : null };
}

/**
 * 狀態（純函式；規則見檔頭）。
 * @param {{paperGraded:boolean, beforeRate:number|null, afterGraded:number, delta:number|null}} p
 * @returns {'pending'|'insufficient_data'|'improved'|'worse'|'no_change'}
 */
function effectStatus({ paperGraded, beforeRate, afterGraded, delta }) {
    if (!paperGraded) return 'pending';
    if (beforeRate === null || delta === null || afterGraded < MIN_AFTER_GRADED) return 'insufficient_data';
    if (delta >= IMPROVED_DELTA - EPS) return 'improved';
    if (delta <= WORSE_DELTA + EPS) return 'worse';
    return 'no_change';
}

/**
 * 一個目標的成效（純函式）。
 * @param {object} target 快照的一個目標（bucket = 'remedial'）
 * @param {{onPaper:object|null, after:object|null, paperGraded:boolean, minN:number, names:Map<number,{name:string,code:string}>}} ctx
 * @returns {object}
 */
function targetEffect(target, { onPaper, after, paperGraded, minN, names }) {
    const b = target.baseline || {};
    const beforeRate = b.wrong_rate === null || b.wrong_rate === undefined ? null : round4(1 - Number(b.wrong_rate));
    const on = rateOf(onPaper);
    const af = rateOf(after);
    const delta = beforeRate !== null && af.rate !== null ? round4(af.rate - beforeRate) : null;
    const kcInfo = target.unit_type === 'kc' ? names.get(target.kc_id) : null;
    return {
        unit_type: target.unit_type,
        subject: target.subject,
        chapter: target.chapter,
        ...(target.unit_type === 'kc' ? { kc_id: target.kc_id, code: kcInfo ? kcInfo.code : null } : {}),
        name: target.unit_type === 'kc' ? (kcInfo ? kcInfo.name : `知識點 #${target.kc_id}`) : target.chapter,
        bucket: target.bucket,
        // 快照只存代碼；標籤以現在的白名單為準（config/errorTypes.js）
        error_focus: target.error_focus ? { ...target.error_focus, label: labelOf(target.error_focus.type) } : null,
        before: { graded: b.graded ?? 0, wrong: b.wrong ?? 0, wrong_rate: b.wrong_rate ?? null, correct_rate: beforeRate, low_sample: Boolean(b.low_sample) },
        on_paper: { assigned: onPaper ? round4(Number(onPaper.assigned) || 0) : 0, graded: on.graded, correct: on.correct, rate: on.rate },
        after: { graded: af.graded, correct: af.correct, rate: af.rate, papers: after ? Number(after.papers) || 0 : 0 },
        delta,
        low_sample: af.graded < minN,
        status: effectStatus({ paperGraded, beforeRate, afterGraded: af.graded, delta })
    };
}

// ───────────────────────── I/O ─────────────────────────

/**
 * 讀出某生的補救成效。
 * @param {{studentId:number, limit:number, days:number|null, minN:number}} opts
 * @param {{query:(text:string, values:any[])=>Promise<{rows:object[]}>}} deps
 * @returns {Promise<{papers:object[], thresholds:object}>}
 */
async function loadRemedialEffect({ studentId, limit, days, minN }, deps) {
    const pq = buildPapersQuery({ studentId, limit });
    const { rows: papers } = await deps.query(pq.text, pq.values);

    // 知識點單位的名稱（快照只存 kc_id；名稱以現在的為準）
    const kcIds = [...new Set(papers.flatMap(p => (Array.isArray(p.targets) ? p.targets : [])
        .filter(t => t.unit_type === 'kc').map(t => t.kc_id)))];
    const names = new Map();
    if (kcIds.length) {
        const { rows } = await deps.query('SELECT id, code, name FROM knowledge_components WHERE id = ANY($1::int[])', [kcIds]);
        for (const r of rows) names.set(r.id, { code: r.code, name: r.name });
    }

    const out = [];
    for (const p of papers) {
        const { graded, anchor } = paperAnchor(p);
        const targets = (Array.isArray(p.targets) ? p.targets : []).filter(t => t.bucket === 'remedial');
        let byIdx = new Map();
        if (targets.length) {
            const units = targets.map((t, idx) => ({ idx, unit_type: t.unit_type, subject: t.subject, chapter: t.chapter, kc_id: t.kc_id ?? null }));
            const q = buildEffectQuery({ studentId, units, paperId: p.id, anchor, days });
            const { rows } = await deps.query(q.text, q.values);
            byIdx = new Map();
            for (const r of rows) {
                if (!byIdx.has(r.idx)) byIdx.set(r.idx, {});
                byIdx.get(r.idx)[r.on_paper ? 'onPaper' : 'after'] = r;
            }
        }
        out.push({
            paper_id: p.id,
            title: p.title,
            created_at: p.created_at,
            graded: graded,
            assigned_count: p.assigned,
            graded_count: p.graded,
            anchor_at: anchor,
            targets: targets.map((t, idx) => {
                const r = byIdx.get(idx) || {};
                return targetEffect(t, { onPaper: r.onPaper || null, after: r.after || null, paperGraded: graded, minN, names });
            })
        });
    }
    return {
        papers: out,
        thresholds: { improved_delta: IMPROVED_DELTA, worse_delta: WORSE_DELTA, min_after_graded: MIN_AFTER_GRADED, min_n: minN }
    };
}

module.exports = {
    IMPROVED_DELTA, WORSE_DELTA, MIN_AFTER_GRADED, DEFAULT_LIMIT, MAX_LIMIT,
    buildPapersQuery,
    buildEffectQuery,
    paperAnchor,
    rateOf,
    effectStatus,
    targetEffect,
    loadRemedialEffect
};
