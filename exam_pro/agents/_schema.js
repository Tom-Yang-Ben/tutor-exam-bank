// agents/_schema.js — buildSchema 的暫時橋接（WS-C，A-T10）
//
// docs/interfaces-stage2.md 第 3.4 條把 `buildSchema(name)` 放在
// **agents/schemas/index.js**，擁有者是 WS-B。WS-C 的 lint／verify 兩個 agent 需要它，
// 但兩條 workstream 是平行開發的，WS-B 合入前那支檔案還不存在。
//
// 因此本檔的規則是：
//   1. 先試 require('./schemas')——WS-B 合入後就一律走它，沒有第二份真相。
//   2. 還沒合入時，用同一套規則在本檔內就地組（x-enum → enum，來源一樣是
//      config/chapters.js，白名單絕不手抄）。
//
// ⚠️ WS-B 的 agents/schemas/index.js 合入 main 之後，本檔應該連同 require 一起刪除，
//    agents/lint.js 與 agents/verify.js 改成直接 require('./schemas')。
//    已列在 docs/questions2-wsC.md 的「合併注意事項」。

const path = require('path');
const { CHAPTERS, SUBJECTS, QUESTION_TYPES } = require('../config/chapters');

/** x-enum 的合法值 → 來源（全部來自 config/chapters.js，不得手抄） */
const ENUM_SOURCES = {
    subject: SUBJECTS,
    chapter: [...CHAPTERS['數學'], ...CHAPTERS['物理']],
    question_type: QUESTION_TYPES,
    answer_form: ['option', 'number', 'expression', 'text'],
};

const cache = new Map();

/** 深凍結（buildSchema 的回傳值是共用的，任何人改到就會污染其他呼叫端） */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
    return obj;
}

/** 遞迴把 { "x-enum": "chapter" } 換成 { enum: [...] } 並刪掉 x-enum */
function injectEnums(node) {
    if (Array.isArray(node)) return node.map(injectEnums);
    if (node === null || typeof node !== 'object') return node;

    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === 'x-enum') continue;
        out[k] = injectEnums(v);
    }
    if (typeof node['x-enum'] === 'string') {
        const values = ENUM_SOURCES[node['x-enum']];
        if (!values) throw new Error(`未知的 x-enum 來源「${node['x-enum']}」`);
        out.enum = [...values];
    }
    return out;
}

function buildLocally(name) {
    if (cache.has(name)) return cache.get(name);
    // path.resolve + __dirname：專案路徑含中文，相對路徑在某些 cwd 下會找不到
    const file = path.resolve(__dirname, 'schemas', `${name}.json`);
    const raw = require(file);
    const built = deepFreeze(injectEnums(raw));
    cache.set(name, built);
    return built;
}

/**
 * 讀 agents/schemas/<name>.json，把每個帶 x-enum 的節點換成 {type:'string', enum:[…]}。
 * @param {'extract'|'classify'|'verify'|'lint'} name
 * @returns {object}   JSON Schema draft-07（已深凍結）
 */
function buildSchema(name) {
    try {
        const official = require('./schemas');
        if (official && typeof official.buildSchema === 'function') return official.buildSchema(name);
    } catch (e) {
        // WS-B 的 agents/schemas/index.js 還沒合入：走本檔的就地版本
    }
    return buildLocally(name);
}

module.exports = { buildSchema, ENUM_SOURCES };
