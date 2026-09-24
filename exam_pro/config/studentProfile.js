// ─────────────────────────────────────────────────────────────
// config/studentProfile.js — 學生檔案欄位的白名單與驗證（階段 5 WS-A；DEC-017、缺口 G09）
//
// 白名單凍結於 docs/interfaces-stage5.md 第 4.1 條第 4 項；欄位來自 migrations/0010。
// DDL 只放了「長度上限」這種不會變的 CHECK，合法值由這裡驗證（與 config/chapters.js、
// config/errorTypes.js 同一個做法：白名單會長，改一次不該需要一支 migration）。
//
// 每一欄都可以是 NULL（target_exams 是空陣列）：既有學生不必回填也能照常出卷。
// ─────────────────────────────────────────────────────────────

/** 年級：高一～高三。 */
const GRADES = Object.freeze([10, 11, 12]);
/** 類組。 */
const TRACKS = Object.freeze(['自然組', '社會組', '未分組']);
/** 目標考試（可複選：同一位學生常同時準備學測與分科）。 */
const TARGET_EXAMS = Object.freeze(['學測', '分科', '統測', '段考', '其他']);
/** 使用中的教材版本。 */
const TEXTBOOK_VERSIONS = Object.freeze(['龍騰', '翰林', '南一', '泰宇', '三民', '全華', '康熹', '其他']);

const SCHOOL_MAX_LEN = 50;
const NOTE_MAX_LEN = 500;

/** 可寫入的檔案欄位（順序即 API 回應與表單的順序）。 */
const PROFILE_FIELDS = Object.freeze(['grade', 'track', 'target_exams', 'school', 'textbook_version', 'note']);

/**
 * 以 Unicode code point 計字數。
 *
 * PG 的 char_length 數的是字元（code point），JS 的 .length 數的是 UTF-16 單位——
 * 罕用字或 emoji 會被 JS 算成兩個。用 code point 才與 DDL 的 CHECK 同一把尺。
 * @param {string} s
 * @returns {number}
 */
function charLength(s) {
    return [...s].length;
}

/**
 * 可為 null 的自由文字欄：trim 後空字串視為 null（清空）。
 * @returns {{ ok:true, value:string|null } | { ok:false }}
 */
function optionalText(raw, maxLen) {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false };
    const v = raw.trim();
    if (v === '') return { ok: true, value: null };
    if (charLength(v) > maxLen) return { ok: false };
    return { ok: true, value: v };
}

/**
 * 從 body 取出**有送的**檔案欄位並驗證（POST 與 PATCH 共用）。
 *
 * 規則：
 *   - 只看 body 上真的存在的鍵（hasOwnProperty）；沒送的欄位不出現在結果裡，
 *     PATCH 因此能做到「沒送就不動」。
 *   - grade 只收數字 10／11／12 或 null（不收字串 '10'，型別轉換不替前端做）。
 *   - track、textbook_version 只收白名單字串或 null；空字串視為 null。
 *   - target_exams 收白名單的子集（不得重複），null 視為清空；存成白名單的順序。
 *   - school ≤50 字、note ≤500 字；trim 後空字串視為 null。
 *
 * @param {object} body
 * @returns {{ error:string } | { fields: object }}
 */
function parseProfile(body) {
    const src = body && typeof body === 'object' ? body : {};
    const has = k => Object.prototype.hasOwnProperty.call(src, k);
    const fields = {};

    if (has('grade')) {
        const v = src.grade;
        if (!(v === null || GRADES.includes(v))) {
            return { error: `grade 只接受 ${GRADES.join('、')} 或 null。` };
        }
        fields.grade = v;
    }
    if (has('track')) {
        const v = src.track === '' ? null : src.track;
        if (!(v === null || TRACKS.includes(v))) {
            return { error: `track 只接受 ${TRACKS.join('、')} 或 null。` };
        }
        fields.track = v;
    }
    if (has('target_exams')) {
        const v = src.target_exams === null ? [] : src.target_exams;
        if (!Array.isArray(v) || v.some(x => !TARGET_EXAMS.includes(x))) {
            return { error: `target_exams 必須是 ${TARGET_EXAMS.join('、')} 的子集。` };
        }
        if (new Set(v).size !== v.length) {
            return { error: 'target_exams 不可重複。' };
        }
        fields.target_exams = TARGET_EXAMS.filter(x => v.includes(x));
    }
    if (has('school')) {
        const r = optionalText(src.school, SCHOOL_MAX_LEN);
        if (!r.ok) return { error: `school 必須是字串或 null，且不得超過 ${SCHOOL_MAX_LEN} 字。` };
        fields.school = r.value;
    }
    if (has('textbook_version')) {
        const v = src.textbook_version === '' ? null : src.textbook_version;
        if (!(v === null || TEXTBOOK_VERSIONS.includes(v))) {
            return { error: `textbook_version 只接受 ${TEXTBOOK_VERSIONS.join('、')} 或 null。` };
        }
        fields.textbook_version = v;
    }
    if (has('note')) {
        const r = optionalText(src.note, NOTE_MAX_LEN);
        if (!r.ok) return { error: `note 必須是字串或 null，且不得超過 ${NOTE_MAX_LEN} 字。` };
        fields.note = r.value;
    }
    return { fields };
}

/**
 * 給前端表單用的選項（GET /api/student-profile-options）。
 * @returns {object}
 */
function profileOptions() {
    return {
        grades: [...GRADES],
        tracks: [...TRACKS],
        target_exams: [...TARGET_EXAMS],
        textbook_versions: [...TEXTBOOK_VERSIONS],
        school_max_length: SCHOOL_MAX_LEN,
        note_max_length: NOTE_MAX_LEN
    };
}

module.exports = {
    GRADES, TRACKS, TARGET_EXAMS, TEXTBOOK_VERSIONS, SCHOOL_MAX_LEN, NOTE_MAX_LEN, PROFILE_FIELDS,
    parseProfile, profileOptions, charLength
};
