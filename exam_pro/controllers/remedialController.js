// ─────────────────────────────────────────────────────────────
// controllers/remedialController.js — 出題閉環的三支 API（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條；DEC-016）
//
//   GET  /api/students/:id/weakness/kc?days=&subject=   知識點弱點（Wilson 下界排序）
//   POST /api/students/:id/remedial-paper               依弱點出補救卷草稿（只讀不寫）
//   GET  /api/students/:id/remedial-paper/items?ids=    草稿手動加題前查題目與承上組（只讀；契約之外多的一支，見 docs/remedial.md）
//   GET  /api/coverage?subject=&student_id=             題庫覆蓋率（章 × 難度、知識點題數）
//
// 全部只在 FEATURE_REMEDIAL 開啟時掛載（routes/index.js 檔尾的 WS-D 區塊；關閉時落到 Express 預設 404）。
// 都不呼叫 LLM、不寫資料庫，所以沒有套限流（契約第 1.2 條的限流要求是針對會呼叫 LLM 的端點）。
//
// 慣例沿用 controllers/studentController.js：
//   - 路徑上的 :id 不是正整數也回 404（第 1.2 條：/api/students/abc 就是「不存在的學生」）。
//   - 查詢參數與 body 驗證失敗回 400 { message }。
//   - days／subject 的規則與章節弱點面板相同（parseWeaknessQuery：subject 白名單、days 1~365、預設 90）。
// ─────────────────────────────────────────────────────────────
const { query } = require('../config/db');
const { SUBJECTS, isValidSourceType } = require('../config/chapters');
const { _internals: studentInternals } = require('./studentController');
const kcWeakness = require('../services/kcWeaknessService');
const remedial = require('../services/remedialService');
const coverage = require('../services/coverageService');
// 〔retrain PR-3〕補救卷附上到期的重練題（API-8）
const features = require('../config/features');
const retrainSelect = require('../services/retrainSelect');
const retrainValidation = require('../utils/retrainValidation');

const { parseId, parseWeaknessQuery, weaknessMinN } = studentInternals;
const STUDENT_NOT_FOUND = '找不到該學生';

// ─────────────────────────── 純函式（驗證）───────────────────────────

/**
 * 驗證補救卷的 body（純函式）。
 *
 * @param {object} body
 * @returns {{error:string} | {value:{subject:string, total:number,
 *           mix:{remedial:number, prerequisite:number, extension:number}, days:number, sourceTypes:string[]|null}}}
 */
function parseRemedialBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const { subject } = b;
    if (typeof subject !== 'string' || !SUBJECTS.includes(subject)) {
        return { error: 'subject 必填，且必須在科目白名單內。' };
    }

    let total = remedial.DEFAULT_TOTAL;
    if (b.total !== undefined && b.total !== null) {
        if (!Number.isInteger(b.total) || b.total < remedial.MIN_TOTAL || b.total > remedial.MAX_TOTAL) {
            return { error: `total 必須是 ${remedial.MIN_TOTAL}~${remedial.MAX_TOTAL} 的整數。` };
        }
        total = b.total;
    }

    let mix = { ...remedial.DEFAULT_MIX };
    if (b.mix !== undefined && b.mix !== null) {
        const m = b.mix;
        const keys = remedial.BUCKETS;
        const mixError = `mix 必須是 { ${keys.join(', ')} } 三個非負數，且總和大於 0。`;
        if (typeof m !== 'object' || Array.isArray(m)) return { error: mixError };
        const extra = Object.keys(m).filter(k => !keys.includes(k));
        if (extra.length) return { error: `mix 只接受 ${keys.join('、')}，不認得：${extra.join('、')}。` };
        if (keys.some(k => typeof m[k] !== 'number' || !Number.isFinite(m[k]) || m[k] < 0)) return { error: mixError };
        // 總和也要是有限數：每個值有限、加起來仍可能溢位成 Infinity（例：1e308 + 1e308），
        // 配額會算成 Infinity ÷ Infinity = NaN，草稿變成 0 題卻回 200
        const sum = keys.reduce((s, k) => s + m[k], 0);
        if (!Number.isFinite(sum) || sum <= 0) return { error: mixError };
        mix = Object.fromEntries(keys.map(k => [k, m[k]]));
    }

    let days = remedial.DEFAULT_DAYS;
    if (b.days !== undefined && b.days !== null) {
        if (!Number.isInteger(b.days) || b.days < 1 || b.days > 365) return { error: 'days 必須是 1~365 的整數。' };
        days = b.days;
    }

    let sourceTypes = null;
    if (b.source_types !== undefined && b.source_types !== null) {
        if (!Array.isArray(b.source_types) || b.source_types.some(v => !isValidSourceType(v))) {
            return { error: 'source_types 必須是合法題源標記的陣列。' };
        }
        if (b.source_types.length > 0) sourceTypes = [...new Set(b.source_types)];
    }
    return { value: { subject, total, mix, days, sourceTypes } };
}

/**
 * 驗證覆蓋率的查詢參數（純函式）。
 * @param {object} q req.query
 * @returns {{error:string} | {subject:string|null, studentId:number|null}}
 */
function parseCoverageQuery(q) {
    const rawSubject = q.subject;
    const subject = (rawSubject === undefined || rawSubject === null || String(rawSubject) === '') ? null : String(rawSubject);
    if (subject !== null && !SUBJECTS.includes(subject)) return { error: 'subject 不在白名單內。' };

    const rawStudent = q.student_id;
    if (rawStudent === undefined || rawStudent === null || String(rawStudent) === '') return { subject, studentId: null };
    const studentId = parseId(rawStudent);
    if (studentId === null) return { error: 'student_id 必須是正整數。' };
    return { subject, studentId };
}

/** 手動加題查詢一次最多幾題（同 confirm-paper 的 question_ids 上限）。 */
const MAX_LOOKUP_IDS = 50;
/** PostgreSQL int4 上限：超過的 id 送進 `$1::int[]` 會丟錯（500），在驗證就擋成 400。 */
const PG_INT_MAX = 2147483647;

/**
 * 驗證手動加題查詢的 `ids`（純函式）：逗號分隔的正整數，1~50 個，重複的去掉（保留第一次出現的順序）。
 * 同名參數重複（`?ids=1&ids=2`）也接受，視同逗號串接。
 * @param {object} q req.query
 * @returns {{error:string} | {ids:number[]}}
 */
function parseItemIdsQuery(q) {
    const raw = Array.isArray(q.ids) ? q.ids.join(',') : q.ids;
    const error = `ids 必須是 1~${MAX_LOOKUP_IDS} 個以逗號分隔的正整數。`;
    if (typeof raw !== 'string' || raw.trim() === '') return { error };
    const ids = [];
    for (const token of raw.split(',').map(s => s.trim())) {
        if (!/^\d+$/.test(token)) return { error };
        const n = Number(token);
        if (!Number.isSafeInteger(n) || n < 1 || n > PG_INT_MAX) return { error };
        if (!ids.includes(n)) ids.push(n);
    }
    if (ids.length > MAX_LOOKUP_IDS) return { error };
    return { ids };
}

/** 學生存在嗎。 */
async function studentExists(id) {
    const { rowCount } = await query('SELECT 1 FROM students WHERE id = $1', [id]);
    return rowCount > 0;
}

// ─────────────────── GET /api/students/:id/weakness/kc ───────────────────

exports.getKcWeakness = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = parseWeaknessQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    try {
        if (!(await studentExists(studentId))) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        const { units, untaggedGraded } = await kcWeakness.loadKcWeakness(
            { studentId, subject: parsed.subject, days: parsed.days, minN: weaknessMinN() }, { query });
        res.status(200).json({ rows: units.map(kcWeakness.toApiRow), untagged_graded: untaggedGraded });
    } catch (err) {
        next(err);
    }
};

// ─────────────────── POST /api/students/:id/remedial-paper ───────────────────

// 〔retrain PR-3〕docs/retrain-and-review.md 第 5.2 節 API-8：body 可多帶 retrain_count（0–20，預設 0；total＋retrain_count ≤ 50）。
// > 0 時草稿多一組 bucket = 'retrain'（「到期重練」；blueprint、shortfalls、notes 照既有格式回報），
// 承上組整組放不下 → 400、不產生草稿（R12 選 2）；確認時前端把這組的題號放進 confirm-paper 的 retrain_question_ids。
// 旗標關閉卻帶了 retrain_count → 400；沒帶或 0 時回應逐字不變。補救卷的 basis 與弱點排序照舊只看每題第一次作答（R10 選 1）。
// 檢查排在既有的 body 檢查之後。
exports.remedialPaper = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = parseRemedialBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const rt = retrainValidation.parseRemedialRetrain(req.body, { enabled: features.FEATURE_RETRAIN, total: parsed.value.total });
    if (rt.error) return res.status(400).json({ message: rt.error });

    try {
        if (!(await studentExists(studentId))) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        const draft = await remedial.planRemedialPaper({ studentId, ...parsed.value, minN: weaknessMinN() });
        if (rt.count > 0) {
            const out = await retrainSelect.appendRetrainBucket(query, draft, { studentId, count: rt.count });
            if (out.error) return res.status(400).json({ message: out.error.message });
            return res.status(200).json(out.draft);
        }
        res.status(200).json(draft);
    } catch (err) {
        next(err);
    }
};

// ─────────────────── GET /api/students/:id/remedial-paper/items ───────────────────
// 草稿「用題目 ID 加題」前查題目資料與所在承上組（docs/remedial.md 第 2.5 節）。只讀、不呼叫 LLM。

exports.remedialItems = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = parseItemIdsQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    try {
        if (!(await studentExists(studentId))) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        const out = await remedial.lookupItems({ studentId, ids: parsed.ids }, { query });
        res.status(200).json(out);
    } catch (err) {
        next(err);
    }
};

// ─────────────────── GET /api/coverage ───────────────────

exports.getCoverage = async (req, res, next) => {
    const parsed = parseCoverageQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        if (parsed.studentId !== null && !(await studentExists(parsed.studentId))) {
            return res.status(404).json({ message: STUDENT_NOT_FOUND });
        }
        const out = await coverage.loadCoverage({ subject: parsed.subject, studentId: parsed.studentId }, { query });
        res.status(200).json(out);
    } catch (err) {
        next(err);
    }
};

exports._internals = { parseRemedialBody, parseCoverageQuery, parseItemIdsQuery, MAX_LOOKUP_IDS };
