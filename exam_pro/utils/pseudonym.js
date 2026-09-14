// ─────────────────────────────────────────────────────────────
// utils/pseudonym.js — 學生姓名 ↔ 代號（「學生#<id>」）雙向替換
//
// 為什麼要有這一支：DEC-009 說「資料留本地，只有 LLM 呼叫對外」，但 NLQ 的 LLM
// 輔路徑會把老師那句話原文送進 prompt，助教的 list_students 也把姓名回給主控 LLM。
// 學生姓名是個資法第 2 條明文列舉的個資，不該跟著 prompt 出境。這一支把「送出去
// 之前換成代號、收回來之後換回姓名」做成一個純函式物件，NLQ 與助教共用。
//
// 設計上的三個決定：
//   1. 代號用 students.id（唯一、穩定、不可逆推姓名）：「學生#12」。
//   2. 沒有學生清單（eval、單元測試、db 為空）時 mask／unmask 都是恆等函式——
//      所以 cassette 的鍵與 golden 行為一個位元組都不會變。
//   3. 只遮 ≥ 2 個字的姓名。單字名在中文裡幾乎必然撞到常用字（「明」「華」），
//      誤傷會把題幹改得面目全非；實務上也不存在單字的學生姓名。
//
// 遮罩是「字串取代」不是「語意判斷」：題幹裡剛好出現同名詞彙也會被換成代號。
// 這是刻意的——寧可多遮，代號在 unmask 時會原樣還原，對使用者無感。
// ─────────────────────────────────────────────────────────────

const ALIAS_PREFIX = '學生#';
const ALIAS_RE = /學生#(\d+)/g;
const MIN_NAME_LEN = 2;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 對任意 JSON 值遞迴套用字串函式；非字串原樣回傳，物件與陣列回新實例。 */
function deep(fn) {
    return function walk(v) {
        if (typeof v === 'string') return fn(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v)) out[k] = walk(x);
            return out;
        }
        return v;
    };
}

/**
 * @param {Array<{id:number, name:string}>} [students]
 * @returns {{mask:(s:string)=>string, unmask:(s:string)=>string,
 *            maskDeep:(v:any)=>any, unmaskDeep:(v:any)=>any,
 *            aliasOf:(id:number)=>string|null, size:number}}
 */
function createPseudonymizer(students = []) {
    const byName = new Map();
    const byId = new Map();
    for (const s of Array.isArray(students) ? students : []) {
        const id = Number(s && s.id);
        const name = String((s && s.name) ?? '').trim();
        if (!Number.isInteger(id) || id <= 0 || name.length < MIN_NAME_LEN) continue;
        if (byName.has(name)) continue;              // students.name UNIQUE，這裡只是防呆
        byName.set(name, id);
        byId.set(id, name);
    }
    // 長的先比：「王小明」與「小明」同時存在時，不能先把「小明」換掉留下「王學生#3」
    const names = [...byName.keys()].sort((a, b) => b.length - a.length);
    const nameRe = names.length ? new RegExp(names.map(escapeRe).join('|'), 'g') : null;

    function mask(text) {
        if (typeof text !== 'string' || !nameRe) return text;
        return text.replace(nameRe, m => ALIAS_PREFIX + byName.get(m));
    }
    function unmask(text) {
        if (typeof text !== 'string' || byId.size === 0) return text;
        return text.replace(ALIAS_RE, (m, id) => (byId.has(Number(id)) ? byId.get(Number(id)) : m));
    }
    return {
        mask,
        unmask,
        maskDeep: deep(mask),
        unmaskDeep: deep(unmask),
        aliasOf: id => (byId.has(Number(id)) ? ALIAS_PREFIX + Number(id) : null),
        size: byId.size
    };
}

/** 恆等版本：沒有 db 的呼叫端（eval、單元測試）用它，行為與加這一層之前完全相同。 */
const IDENTITY = createPseudonymizer([]);

/**
 * 從 students 表載入姓名清單並建立替換器。
 * @param {{query:Function}} db pg 版 { query }
 */
async function loadPseudonymizer(db) {
    const { rows } = await db.query('SELECT id, name FROM students');
    return createPseudonymizer(rows);
}

module.exports = { createPseudonymizer, loadPseudonymizer, IDENTITY, ALIAS_PREFIX, MIN_NAME_LEN };
