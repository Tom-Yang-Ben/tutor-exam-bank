// 精細章節白名單（與 aiService 的 prompt 同步）。
// 後端入庫時以此驗證，避免 AI 或前端傳入未授權的章節名稱。
//
// 2026-08-27：分冊結構資料化（原本只是註解）。VOLUMES 是唯一真相，CHAPTERS 由它攤平
// 導出——**順序逐字不變**，因此 buildSchema 的 enum、schemaHash 與既有 cassette 都不受
// 影響（test/unit/agentExtract.test.js 釘住 enum 內容與 66 這個數字）。
//
// 2026-09-24（階段 5 WS-B，DEC-019；docs/interfaces-stage5.md 第 3.2 條）：化學併入 VOLUMES，
// 排在物理之後，章節表的唯一真相仍是 config/chemistryChapters.js（本檔只 require 它）。
// 之後 SUBJECTS = ['數學','物理','化學']、CHAPTERS['化學'] 有 44 章。
// 既有 LLM 呼叫（數學／物理的 prompt、schema enum、cassette 鍵）一律改讀 LEGACY_*：
//   LEGACY_SUBJECTS = ['數學','物理']、LEGACY_CHAPTERS = 兩科合併 66 章（順序與原本逐字相同）。
//   （〔章節重整 CH-A〕2026-09-25 起為重整後的 86 章，見下一段與 LEGACY_* 的註解。）
// SUBJECT_GROUPS 是上傳時的「卷別」（jobs.subject_group）→ 該卷可能出現的科目，見 ADR-010。
//
// 〔章節重整 CH-A〕2026-09-25（docs/chapter-restructure.md 第 3.1 條第 1 點、ADR-016）：
// 數學／物理的 VOLUMES 改讀 config/chapterPlan.js 的 PLAN_VOLUMES（Owner 定案的 108 龍騰目錄對照），
// 數學 34 → 52 章、物理 32 → 34 章，化學不動。這是**刻意**讓數學／物理的 schema enum 改變：
// 既有 classify／extract／variant／nlq 的 cassette 與部分 embeddings fixture 因此失效，由 Owner 一次重錄
// （第 5 條）。舊題的章節由 scripts/migrate_chapters.js（npm run chapters:migrate）提議＋老師確認後搬移。

const { CHEMISTRY_VOLUMES } = require('./chemistryChapters');
const { PLAN_VOLUMES } = require('./chapterPlan');

const VOLUMES = {
    // 〔章節重整 CH-A〕唯一真相是 config/chapterPlan.js（本檔不重抄清單）
    '數學': PLAN_VOLUMES['數學'],
    '物理': PLAN_VOLUMES['物理'],
    // 〔stage5 WS-B〕第 3.3 條凍結的 44 章（AI 草擬，待 Owner 對照教科書定稿）
    '化學': CHEMISTRY_VOLUMES
};

const CHAPTERS = Object.fromEntries(
    Object.entries(VOLUMES).map(([subject, vols]) => [subject, vols.flatMap(v => v.chapters)])
);

/**
 * 章節所屬的冊名；查不到回 null（例如舊資料裡不在白名單的章節）。
 * @param {string} subject
 * @param {string} chapter
 * @returns {string|null}
 */
function volumeOf(subject, chapter) {
    for (const v of VOLUMES[subject] || []) {
        if (v.chapters.includes(chapter)) return v.name;
    }
    return null;
}

const SUBJECTS = Object.keys(CHAPTERS);

// ── 階段 5 WS-B：舊值域與卷別（docs/interfaces-stage5.md 第 3.2 條）──────────────
//
// 為什麼要有「舊值域」：數學／物理的 extract／classify／variant／nlq schema 的 enum 與
// prompt 的白名單都進了既有 cassette 的鍵（schemaHash）或錄製當下的 prompt。
// 化學併入 SUBJECTS／CHAPTERS 之後，那些地方若繼續讀 SUBJECTS 就會多出化學、cassette 全數失效，
// 所以它們改讀下面這兩個常數。
//
// 〔章節重整 CH-A〕LEGACY 指的是「數學／物理這一組（math_physics 卷別）的 schema 值域」，
// 不是「重整之前的舊章名」：2026-09-25 起，它的值是重整後的數學 52 章＋物理 34 章（順序：數學各冊 → 物理各冊）。
// 名稱沿用，是因為 agents/schemas、promptParts、nlqService、nlqHeuristics 都以這兩個名字區分
// 「數學／物理這組」與「化學」（docs/chapter-restructure.md 第 2 條）。重整前的舊章名只留在
// config/chapterPlan.js 的 MIGRATION（舊→新對照）。
/** 數學與物理（math_physics 卷別的科目，順序不變） */
const LEGACY_SUBJECTS = Object.freeze(['數學', '物理']);
/** 數學＋物理合併的 86 章（2026-09-25 重整後；SUBJECTS 前兩科的 flatMap，順序：數學各冊 → 物理各冊） */
const LEGACY_CHAPTERS = Object.freeze(LEGACY_SUBJECTS.flatMap(subject => CHAPTERS[subject]));

/**
 * 上傳時指定的「卷別」→ 這份卷可能出現的科目（jobs.subject_group；migrations/0011）。
 * math_physics 沿用凍結的 prompt 與 schema；chemistry 走化學專用的 prompt 與 schema（ADR-010）。
 */
const SUBJECT_GROUPS = Object.freeze({
    math_physics: Object.freeze(['數學', '物理']),
    chemistry: Object.freeze(['化學'])
});
/** 卷別的合法值（與 migrations/0011 的 CHECK 一致）；第一個是預設值 */
const SUBJECT_GROUP_KEYS = Object.freeze(Object.keys(SUBJECT_GROUPS));
const DEFAULT_SUBJECT_GROUP = 'math_physics';

function isValidSubjectGroup(group) {
    return typeof group === 'string' && SUBJECT_GROUP_KEYS.includes(group);
}

/**
 * 上傳表單的 subject_group 欄位 → 卷別（POST /api/jobs；docs/interfaces-stage5.md 第 4.2 條第 1 點）。
 * 沒帶、null 或空白字串 → 預設 'math_physics'（既有上傳流程不帶這個欄位，行為不變）。
 * @param {unknown} value
 * @returns {'math_physics'|'chemistry'|null} 不合法回 null（呼叫端回 400）
 */
function normalizeSubjectGroup(value) {
    if (value === undefined || value === null) return DEFAULT_SUBJECT_GROUP;
    const s = String(value).trim();
    if (s === '') return DEFAULT_SUBJECT_GROUP;
    return isValidSubjectGroup(s) ? s : null;
}

/**
 * 科目 → 卷別。化學 → 'chemistry'，其餘（含不合法的值）→ 'math_physics'。
 * @param {string} subject
 * @returns {'math_physics'|'chemistry'}
 */
function subjectGroupOf(subject) {
    for (const [group, subjects] of Object.entries(SUBJECT_GROUPS)) {
        if (subjects.includes(subject)) return group;
    }
    return DEFAULT_SUBJECT_GROUP;
}
const QUESTION_TYPES = ['單選', '多選', '填空', '計算', '證明'];

// 題目來源標記（著作權管理；migrations/0006 的 CHECK 與此必須一致）。
// official=官方歷屆（著作權法第 9 條，無著作權）、school=學校考卷、
// publisher=出版社／題本（有權利疑慮）、self=自行編寫、unknown=未標記（預設）。
const SOURCE_TYPES = ['official', 'school', 'publisher', 'self', 'unknown'];

function isValidSourceType(value) {
    return SOURCE_TYPES.includes(value);
}

// 題目來源註記（migrations/0007）：自由文字，例「北一女 2024 段考」。
// trim 後空值一律落 NULL；超過 100 字回 undefined（呼叫端應拒絕，而非默默截斷——
// 截斷會讓使用者以為存進去的跟打的一樣）。
const SOURCE_DETAIL_MAX = 100;

function normalizeSourceDetail(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (trimmed === '') return null;
    if (trimmed.length > SOURCE_DETAIL_MAX) return undefined;
    return trimmed;
}

function isValidSubject(subject) {
    return SUBJECTS.includes(subject);
}

/**
 * 錯誤訊息用的科目清單：「數學」、「物理」或「化學」。
 * 〔stage5 WS-B〕原本寫死成「數學」或「物理」；兩科時這個函式的輸出與原字串逐字相同。
 * @returns {string}
 */
function subjectChoiceText() {
    const quoted = SUBJECTS.map(s => `「${s}」`);
    return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join('、')}或${quoted[quoted.length - 1]}`;
}

function isValidChapter(subject, chapter) {
    return isValidSubject(subject) && CHAPTERS[subject].includes(chapter);
}

function isValidQuestionType(type) {
    return QUESTION_TYPES.includes(type);
}

function normalizeDifficulty(value) {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    return n;
}

module.exports = {
    CHAPTERS, VOLUMES, volumeOf, SUBJECTS, QUESTION_TYPES, SOURCE_TYPES, SOURCE_DETAIL_MAX,
    isValidSubject, isValidChapter, isValidQuestionType, isValidSourceType, normalizeSourceDetail, normalizeDifficulty,
    // 階段 5 WS-B（第 3.2 條）
    LEGACY_SUBJECTS, LEGACY_CHAPTERS, SUBJECT_GROUPS, SUBJECT_GROUP_KEYS, DEFAULT_SUBJECT_GROUP,
    isValidSubjectGroup, normalizeSubjectGroup, subjectGroupOf, subjectChoiceText
};
