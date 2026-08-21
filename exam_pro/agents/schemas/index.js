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

const { CHAPTERS, SUBJECTS, QUESTION_TYPES } = require('../../config/chapters');

/**
 * x-enum 的合法值 → 來源。全部來自 config/chapters.js，不得手抄。
 * chapter 是**兩科合併的 66 個**（不分科）：Gemini 的 schema 沒辦法「依 subject 切換 enum」，
 * 跨科的錯配由伺服器端的 isValidChapter(subject, chapter) 擋（第 3.4 條）。
 */
const ENUM_SOURCES = {
    subject: SUBJECTS,
    chapter: SUBJECTS.flatMap(subject => CHAPTERS[subject]),
    question_type: QUESTION_TYPES,
    answer_form: ['option', 'number', 'expression', 'text']
};

const cache = new Map();

/** 遞迴把 x-enum 換成 enum；順便把 x-enum 這個非標準關鍵字拿掉（ajv 與 Gemini 都不認得） */
function injectEnums(node, where) {
    if (Array.isArray(node)) return node.map(v => injectEnums(v, where));
    if (!node || typeof node !== 'object') return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'x-enum') {
            const values = ENUM_SOURCES[value];
            if (!values) {
                throw new Error(`buildSchema：${where} 用了未知的 x-enum「${value}」，合法值只有 ${Object.keys(ENUM_SOURCES).join('／')}。`);
            }
            out.enum = values.slice();
            continue;
        }
        out[key] = injectEnums(value, where);
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
 * 讀 agents/schemas/<name>.json，注入 enum，深凍結後回傳。同一個 name 只組一次。
 * @param {'extract'|'classify'|'verify'|'lint'} name
 * @returns {object} JSON Schema draft-07
 */
function buildSchema(name) {
    const key = String(name || '');
    if (cache.has(key)) return cache.get(key);

    // 路徑含中文（期中專案-wsB）時一律 path.resolve + UTF-8 讀
    const file = path.resolve(__dirname, `${key}.json`);
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

    const schema = deepFreeze(injectEnums(parsed, file));
    cache.set(key, schema);
    return schema;
}

/** 測試用：清掉快取（單元測試會改 CHAPTERS 之外的東西時用得上） */
function _resetForTest() {
    cache.clear();
}

module.exports = { buildSchema, ENUM_SOURCES, _resetForTest };
