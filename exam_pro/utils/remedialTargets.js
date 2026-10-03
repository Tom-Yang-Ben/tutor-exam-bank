// ─────────────────────────────────────────────────────────────
// utils/remedialTargets.js — confirm-paper 的 kind／targets 驗證（純函式；〔dec/r16-remedial〕補救成效追蹤，docs/remedial.md 第 10 節）
//
// 補救卷草稿（POST /api/students/:id/remedial-paper）回應裡的 targets 是出卷當下的目標快照，
// 前端確認時原樣交給 POST /api/confirm-paper { kind: 'remedial', targets }，存進 exam_papers.targets（migrations/0022）。
// 之後的補救成效（GET /api/students/:id/remedial-effect）拿它當「補救前」——所以這裡驗得很嚴：
//   - 每一層都只收列出的鍵，多一個鍵就 400（打錯字不會靜默存成看不懂的資料）。
//   - 章節在 config/chapters.js 的白名單內、科目全部相同（補救卷限單科）、錯因代碼在 config/errorTypes.js 的白名單內。
//   - 數字在合理範圍：批改量 0–MAX_GRADED、答錯量 ≤ 批改量、比例 0–1；kc_id 是 int4 範圍內的正整數。
//   - 同一個桶裡同一個單位不得重複。
// 沒帶 kind 也沒帶 targets 時回 { value: null }，confirm-paper 的行為與回應與之前逐字相同。
//
// 純函式：不連 DB、不讀 process.env。由 test/unit/remedialTargets.test.js 釘住。
// ─────────────────────────────────────────────────────────────
const { SUBJECTS, isValidChapter } = require('../config/chapters');
const { ERROR_TYPE_CODES } = require('../config/errorTypes');

/** 一份補救卷最多幾個目標（補救 3＋先備 3＋延伸 3，留一點餘裕）。 */
const MAX_TARGETS = 12;
/** 批改量的上限（加權後可能是小數；一位家教學生一年也到不了）。 */
const MAX_GRADED = 10000;
/** PostgreSQL int4 上限。 */
const PG_INT_MAX = 2147483647;
/** confirm-paper 能接受的 kind（retrain 由伺服器自己判斷，不收前端的）。 */
const CLIENT_KINDS = Object.freeze(['remedial']);
const TARGET_BUCKETS = Object.freeze(['remedial', 'prerequisite', 'extension']);
const UNIT_TYPES = Object.freeze(['chapter', 'kc']);

const TARGET_KEYS = Object.freeze(['unit_type', 'subject', 'chapter', 'kc_id', 'bucket', 'baseline', 'error_focus']);
const BASELINE_KEYS = Object.freeze(['graded', 'wrong', 'wrong_rate', 'low_sample']);
const FOCUS_KEYS = Object.freeze(['type', 'count', 'share', 'applied']);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * 物件只能有列出的鍵、必要的鍵都要在。
 * @returns {string|null} 錯誤訊息
 */
function keysError(obj, allowed, required, where) {
    const extra = Object.keys(obj).filter(k => !allowed.includes(k));
    if (extra.length) return `${where} 不認得的鍵：${extra.join('、')}。`;
    const missing = required.filter(k => !(k in obj));
    if (missing.length) return `${where} 缺少：${missing.join('、')}。`;
    return null;
}

/**
 * 驗一個目標。
 * @param {any} t
 * @param {number} i 從 0 起
 * @returns {string|null}
 */
function targetError(t, i) {
    const where = `targets 第 ${i + 1} 項`;
    if (!isPlainObject(t)) return `${where} 必須是物件。`;
    const kErr = keysError(t, TARGET_KEYS, ['unit_type', 'subject', 'chapter', 'bucket', 'baseline'], where);
    if (kErr) return kErr;
    if (!UNIT_TYPES.includes(t.unit_type)) return `${where} 的 unit_type 必須是 ${UNIT_TYPES.join(' 或 ')}。`;
    if (typeof t.subject !== 'string' || !SUBJECTS.includes(t.subject)) return `${where} 的 subject 不在科目白名單內。`;
    if (typeof t.chapter !== 'string' || !isValidChapter(t.subject, t.chapter)) return `${where} 的 chapter 不在「${t.subject}」的章節白名單內。`;
    if (t.unit_type === 'kc') {
        if (!Number.isInteger(t.kc_id) || t.kc_id < 1 || t.kc_id > PG_INT_MAX) return `${where} 是知識點單位，kc_id 必須是正整數。`;
    } else if ('kc_id' in t) {
        return `${where} 是章節單位，不可帶 kc_id。`;
    }
    if (!TARGET_BUCKETS.includes(t.bucket)) return `${where} 的 bucket 必須是 ${TARGET_BUCKETS.join('、')} 之一。`;

    const b = t.baseline;
    if (!isPlainObject(b)) return `${where} 的 baseline 必須是物件。`;
    const bErr = keysError(b, BASELINE_KEYS, BASELINE_KEYS, `${where} 的 baseline`);
    if (bErr) return bErr;
    if (!isFiniteIn(b.graded, 0, MAX_GRADED)) return `${where} 的 baseline.graded 必須是 0~${MAX_GRADED} 的數。`;
    if (!isFiniteIn(b.wrong, 0, b.graded)) return `${where} 的 baseline.wrong 必須是 0 到 graded 之間的數。`;
    if (b.graded === 0) {
        if (b.wrong_rate !== null) return `${where} 的 baseline.graded 為 0 時 wrong_rate 必須是 null。`;
    } else if (!isFiniteIn(b.wrong_rate, 0, 1)) {
        return `${where} 的 baseline.wrong_rate 必須是 0~1 的數。`;
    }
    if (typeof b.low_sample !== 'boolean') return `${where} 的 baseline.low_sample 必須是 true 或 false。`;

    if ('error_focus' in t && t.error_focus !== null) {
        const f = t.error_focus;
        if (t.bucket !== 'remedial') return `${where} 不是補救組，不可帶 error_focus。`;
        if (!isPlainObject(f)) return `${where} 的 error_focus 必須是物件或 null。`;
        const fErr = keysError(f, FOCUS_KEYS, FOCUS_KEYS, `${where} 的 error_focus`);
        if (fErr) return fErr;
        if (!ERROR_TYPE_CODES.includes(f.type)) return `${where} 的 error_focus.type 不在錯因白名單內。`;
        if (!Number.isInteger(f.count) || f.count < 1 || f.count > MAX_GRADED) return `${where} 的 error_focus.count 必須是正整數。`;
        if (!isFiniteIn(f.share, 0, 1)) return `${where} 的 error_focus.share 必須是 0~1 的數。`;
        if (typeof f.applied !== 'boolean') return `${where} 的 error_focus.applied 必須是 true 或 false。`;
    }
    return null;
}

/**
 * confirm-paper 的 kind／targets（純函式）。
 *
 * @param {object} body req.body
 * @returns {{error:string} | {value: null | {kind:'remedial', targets:object[]}}}
 *   value 為 null＝兩個鍵都沒帶（一般出卷；之後的行為逐字不變）
 */
function parseConfirmKind(body) {
    const b = isPlainObject(body) ? body : {};
    const hasKind = b.kind !== undefined && b.kind !== null;
    const hasTargets = b.targets !== undefined && b.targets !== null;
    if (!hasKind && !hasTargets) return { value: null };
    if (!hasKind) return { error: 'targets 只能搭配 kind: "remedial" 使用。' };
    if (!CLIENT_KINDS.includes(b.kind)) return { error: `kind 只接受 ${CLIENT_KINDS.map(k => `"${k}"`).join('、')}。` };
    if (!hasTargets) return { error: 'kind 為 "remedial" 時 targets 必填。' };
    const ts = b.targets;
    if (!Array.isArray(ts) || ts.length < 1 || ts.length > MAX_TARGETS) {
        return { error: `targets 必須是 1~${MAX_TARGETS} 個目標的陣列。` };
    }
    const seen = new Set();
    for (let i = 0; i < ts.length; i++) {
        const err = targetError(ts[i], i);
        if (err) return { error: err };
        const t = ts[i];
        const key = `${t.bucket}|${t.unit_type}|${t.unit_type === 'kc' ? t.kc_id : t.chapter}`;
        if (seen.has(key)) return { error: `targets 第 ${i + 1} 項與前面的目標重複（同一組同一個單位）。` };
        seen.add(key);
    }
    if (new Set(ts.map(t => t.subject)).size > 1) return { error: 'targets 的科目必須相同（補救卷限單科）。' };
    // 只留驗過的鍵（上面已經擋掉多的鍵；這裡重建是為了不把原物件的參照存進資料庫）
    const targets = ts.map(t => ({
        unit_type: t.unit_type, subject: t.subject, chapter: t.chapter,
        ...(t.unit_type === 'kc' ? { kc_id: t.kc_id } : {}),
        bucket: t.bucket,
        baseline: { graded: t.baseline.graded, wrong: t.baseline.wrong, wrong_rate: t.baseline.wrong_rate, low_sample: t.baseline.low_sample },
        ...(t.error_focus ? { error_focus: { type: t.error_focus.type, count: t.error_focus.count, share: t.error_focus.share, applied: t.error_focus.applied } } : {})
    }));
    return { value: { kind: 'remedial', targets } };
}

module.exports = { MAX_TARGETS, MAX_GRADED, CLIENT_KINDS, TARGET_BUCKETS, UNIT_TYPES, parseConfirmKind };
