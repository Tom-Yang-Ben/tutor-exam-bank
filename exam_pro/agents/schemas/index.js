// agents/schemas/index.js — JSON Schema 的組裝（docs/interfaces-stage2.md 第 3.4 條）
//
// 「同一份 schema 同時餵給模型的 structured output 與伺服器端的 ajv——沒有第二份真相。」
//
// 檔案裡不寫 enum 的值，只寫佔位符 `"x-enum": "chapter"`；enum 的值一律由
// config/chapters.js 注入。這樣白名單只有一份（config/chapters.js），
// 不會再出現 aiService.js 手抄一份、config 一份、schema 一份的三份真相。
//
// 回傳的物件已深凍結：agent 拿到之後不小心改一個欄位，會連帶讓 cassette 的 schemaHash
// 在同一個行程內漂掉（第 5.2 條），那種 bug 很難查。

const fs = require('fs');
const path = require('path');

const { CHAPTERS, QUESTION_TYPES, LEGACY_SUBJECTS, LEGACY_CHAPTERS } = require('../../config/chapters');

/**
 * x-enum 的合法值 → 來源。全部來自 config/chapters.js，不得手抄。
 * chapter 是**兩科合併的 66 個**（不分科）：Gemini 的 schema 沒辦法「依 subject 切換 enum」，
 * 跨科的錯配由伺服器端的 isValidChapter(subject, chapter) 擋（第 3.4 條）。
 *
 * 〔stage5 WS-B〕化學併入 SUBJECTS／CHAPTERS 之後，這裡改讀 LEGACY_*（內容與順序和併入之前
 * 逐字相同）：數學／物理的 schema 進了既有 cassette 的 schemaHash，值域一變全部 cassette 失效
 * （docs/interfaces-stage5.md 第 1.1、3.2 條）。化學的值域另外放在 GROUP_ENUM_SOURCES.chemistry。
 */
const ENUM_SOURCES = {
    subject: LEGACY_SUBJECTS.slice(),
    chapter: LEGACY_CHAPTERS.slice(),
    question_type: QUESTION_TYPES,
    answer_form: ['option', 'number', 'expression', 'text']
};

/**
 * 卷別 → x-enum 值域（第 3.2 條）。math_physics 就是 ENUM_SOURCES 本身（同一個物件），
 * chemistry 只換掉 subject 與 chapter：subject＝['化學']、chapter＝化學 44 章。
 * 題型與 answer_form 各卷別共用。
 */
const GROUP_ENUM_SOURCES = {
    math_physics: ENUM_SOURCES,
    chemistry: {
        ...ENUM_SOURCES,
        subject: ['化學'],
        chapter: CHAPTERS['化學'].slice()
    }
};

const cache = new Map();

/** 遞迴把 x-enum 換成 enum；順便把 x-enum 這個非標準關鍵字拿掉（ajv 與 Gemini 都不認得） */
function injectEnums(node, where, sources = ENUM_SOURCES) {
    if (Array.isArray(node)) return node.map(v => injectEnums(v, where, sources));
    if (!node || typeof node !== 'object') return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'x-enum') {
            const values = sources[value];
            if (!values) {
                throw new Error(`buildSchema：${where} 用了未知的 x-enum「${value}」，合法值只有 ${Object.keys(sources).join('／')}。`);
            }
            out.enum = values.slice();
            continue;
        }
        out[key] = injectEnums(value, where, sources);
    }
    return out;
}

/** 深凍結：物件、陣列一路凍到底 */
function deepFreeze(node) {
    if (node && typeof node === 'object' && !Object.isFrozen(node)) {
        Object.freeze(node);
        for (const value of Object.values(node)) deepFreeze(value);
    }
    return node;
}

/**
 * 讀 agents/schemas/<name>.json，注入 enum，深凍結後回傳。同一個 name（＋卷別）只組一次。
 *
 * 〔stage5 WS-B〕第二個參數 `{ group }`（docs/interfaces-stage5.md 第 3.2 條）：
 *   - 沒給、或 group === 'math_physics' → **行為與階段 5 之前逐位元相同**：同一個快取鍵（name）、
 *     同一個深凍結實例、同一個 schemaHash（既有 cassette 不失效）。
 *   - group === 'chemistry' → subject 只能是「化學」、chapter 是化學 44 章；快取鍵是 `name@chemistry`。
 *   - 其他 group 丟錯（打錯字不該靜默退回數學／物理的值域）。
 *
 * @param {'extract'|'classify'|'verify'|'lint'|'variant'|'nlq'} name
 * @param {{group?:'math_physics'|'chemistry'}} [opts]
 * @returns {object} JSON Schema draft-07
 */
function buildSchema(name, opts = {}) {
    const group = (opts && opts.group) || 'math_physics';
    const sources = GROUP_ENUM_SOURCES[group];
    if (!sources) {
        throw new Error(`buildSchema：未知的卷別 group「${group}」，合法值只有 ${Object.keys(GROUP_ENUM_SOURCES).join('／')}。`);
    }
    const base = String(name || '');
    // math_physics 的快取鍵維持原本的 name（同一個實例，test/unit/agentExtract.test.js 釘住 a === b）
    const key = group === 'math_physics' ? base : `${base}@${group}`;
    if (cache.has(key)) return cache.get(key);

    // 路徑含中文（期中專案-wsB）時一律 path.resolve + UTF-8 讀
    const file = path.resolve(__dirname, `${base}.json`);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        throw new Error(`buildSchema：找不到 schema 檔 ${file}（name 只接受 extract／classify／verify／lint）。`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`buildSchema：${file} 不是合法 JSON——${err.message}`);
    }

    const schema = deepFreeze(injectEnums(parsed, file, sources));
    cache.set(key, schema);
    return schema;
}

/** 測試用：清掉快取（單元測試會改 CHAPTERS 之外的東西時用得上） */
function _resetForTest() {
    cache.clear();
}

module.exports = { buildSchema, ENUM_SOURCES, GROUP_ENUM_SOURCES, _resetForTest };
