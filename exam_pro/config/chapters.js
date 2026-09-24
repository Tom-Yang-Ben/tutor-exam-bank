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
// SUBJECT_GROUPS 是上傳時的「卷別」（jobs.subject_group）→ 該卷可能出現的科目，見 ADR-010。

const { CHEMISTRY_VOLUMES } = require('./chemistryChapters');

const VOLUMES = {
    '數學': [
        { name: '第一冊', chapters: ['實數', '絕對值', '指數與對數', '直線方程式', '圓方程式', '多項式除法', '三次函數'] },
        { name: '第二冊', chapters: ['數列與級數', '排列', '組合', '古典機率', '期望值', '一維數據分析', '二維數據分析'] },
        { name: '第三冊(A/B)', chapters: ['三角函數的定義', '正弦與餘弦定理', '三角測量', '向量的加減與係數積', '向量內積', '面積與行列式'] },
        { name: '第四冊(A/B)', chapters: ['空間概念與座標系', '空間向量內積', '外積', '平面方程式', '空間直線方程式', '矩陣的加減與乘法', '克拉瑪公式'] },
        { name: '選修數學', chapters: ['數列的極限', '函數的極限', '微分導函數', '函數圖形與極值', '定積分與面積', '隨機變數', '常態分配'] }
    ],
    '物理': [
        { name: '必修物理', chapters: ['科學的態度與方法', '物質的組成（夸克與原子）', '物體的運動（速度與加速度）', '四大基本交互作用', '能量的形式與守恆', '量子現象（光電效應與波粒二象性）', '宇宙學簡介'] },
        { name: '選修物理一', chapters: ['直線運動', '平面運動', '牛頓運動定律', '摩擦力與向心力', '動量與衝量', '動量守恆與碰撞'] },
        { name: '選修物理二', chapters: ['功與動能', '位能與能量守恆', '重力場與重力位能', '剛體轉動與平衡', '簡諧運動(SHM)', '流體的壓力與浮力'] },
        { name: '選修物理三', chapters: ['波動的性質', '聲波與交互作用', '幾何光學（反射折射）', '物理光學（干涉繞射）'] },
        { name: '選修物理四', chapters: ['靜電學', '電場與電位', '電流與電路', '電流磁效應', '電磁感應', '交流電'] },
        { name: '選修物理五', chapters: ['近代物理的序幕', '原子結構與光譜', '核物理與基本粒子'] }
    ],
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
// 所以它們改讀下面這兩個常數——內容與順序和併入化學之前逐字相同。
/** 數學與物理（化學併入之前的 SUBJECTS，順序不變） */
const LEGACY_SUBJECTS = Object.freeze(['數學', '物理']);
/** 數學＋物理合併的 66 章（化學併入之前的 SUBJECTS.flatMap(s => CHAPTERS[s])，順序逐字相同） */
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
