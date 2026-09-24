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
//
// 〔stage5 審查修正 S5-46〕AI 家教是第一條鼓勵老師用自由文字談特定學生的路徑，只比對「逐字相同的
// 完整姓名」太鬆，補上四種寫法（NLQ、助教、家教共用，同一套規則）：
//   a. 比對前把姓名做 NFKC、壓縮空白；中文字之間容許夾空白（「王 小明」）；
//   b. 兩個以上英文單字的姓名不分大小寫、字間空白可多可少、前後不能緊接英文字母（「amy chen」「Amy  Chen」）；
//      單一英文單字的姓名維持逐字比對——「Tan」「Max」不分大小寫會吃掉數學式裡的 tan、max；
//   c. 全形英數字（「Ａｍｙ」）視同半形；
//   d. 三、四個中文字的姓名，另外遮「去掉姓氏的兩字名字」（王小明 → 小明、歐陽娜娜 → 娜娜）。
//      名字剛好是另一位學生的全名時不另遮（全名優先）；兩位學生名字相同時換成「某位學生」（無法確定是誰，
//      也就不換回姓名）。
// 仍然遮不到的：單字名（「華」）與兩字姓名只叫名字（「明」）、暱稱、錯字。docs/tutor.md 第 2.2 節照實寫出，
// 家教畫面的學生欄旁也提示「用『這位學生』稱呼」。
// ─────────────────────────────────────────────────────────────

const ALIAS_PREFIX = '學生#';
const ALIAS_RE = /學生#(\d+)/g;
const MIN_NAME_LEN = 2;
/** 名字相同的兩位學生只叫名字時的遮罩（無法確定是誰，unmask 不換回） */
const AMBIGUOUS_ALIAS = '某位學生';

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CJK_RE = /^[\u3400-\u9fff\uf900-\ufaff]$/;

/** 姓名的正規形：NFKC、去頭尾空白、內部空白壓成一格 */
function normalizeName(name) {
    return String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** 一個字元的比對樣式：英數字也接受全形；caseless 時英文字母不分大小寫 */
function charPattern(ch, caseless) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
        const forms = new Set([ch]);
        if (caseless) { forms.add(ch.toLowerCase()); forms.add(ch.toUpperCase()); }
        for (const f of [...forms]) forms.add(String.fromCharCode(f.charCodeAt(0) + 0xFEE0));
        return forms.size === 1 ? escapeRe(ch) : `[${[...forms].join('')}]`;
    }
    return escapeRe(ch);
}

/**
 * 正規化後的姓名 → 正規表達式片段（不含群組）。
 * 空白 → \s+；相鄰兩個中文字之間容許 \s*；多個英文單字的姓名不分大小寫、前後不接英文字母。
 */
function namePattern(norm) {
    const tokens = norm.split(' ');
    const multiLatin = tokens.length >= 2 && tokens.every(t => /[A-Za-z]/.test(t));
    let out = '';
    const chars = [...norm];
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === ' ') { out += '\\s+'; continue; }
        if (i > 0 && CJK_RE.test(ch) && CJK_RE.test(chars[i - 1])) out += '\\s*';
        out += charPattern(ch, multiLatin);
    }
    if (multiLatin) out = `(?<![A-Za-zＡ-Ｚａ-ｚ])${out}(?![A-Za-zＡ-Ｚａ-ｚ])`;
    return out;
}

/** 三、四個中文字的姓名 → 去掉姓氏的兩字名字；其他回 null */
function givenNameOf(norm) {
    const chars = [...norm];
    if ((chars.length === 3 || chars.length === 4) && chars.every(c => CJK_RE.test(c))) return chars.slice(-2).join('');
    return null;
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
    const byName = new Map();                        // 正規化後的全名 → id
    const byId = new Map();                          // id → 原始姓名（unmask 換回的就是它）
    for (const s of Array.isArray(students) ? students : []) {
        const id = Number(s && s.id);
        const name = String((s && s.name) ?? '').trim();
        const norm = normalizeName(name);
        if (!Number.isInteger(id) || id <= 0 || [...norm].length < MIN_NAME_LEN) continue;
        if (byName.has(norm)) continue;              // students.name UNIQUE，這裡只是防呆
        byName.set(norm, id);
        byId.set(id, name);
    }

    // 比對項目：全名＋（三、四字中文姓名的）名字。名字撞到別人的全名不另遮；兩人同名 → 某位學生。
    const entries = [...byName].map(([norm, id]) => ({ norm, id }));
    const givenOwners = new Map();
    for (const [norm, id] of byName) {
        const given = givenNameOf(norm);
        if (!given || byName.has(given)) continue;
        if (!givenOwners.has(given)) givenOwners.set(given, new Set());
        givenOwners.get(given).add(id);
    }
    for (const [given, owners] of givenOwners) {
        entries.push({ norm: given, id: owners.size === 1 ? [...owners][0] : null });
    }
    // 長的先比：「王小明」與「小明」同時存在時，不能先把「小明」換掉留下「王學生#3」
    entries.sort((a, b) => [...b.norm].length - [...a.norm].length);
    const nameRe = entries.length ? new RegExp(entries.map(e => `(${namePattern(e.norm)})`).join('|'), 'g') : null;

    function mask(text) {
        if (typeof text !== 'string' || !nameRe) return text;
        return text.replace(nameRe, (...args) => {
            const groups = args.slice(1, entries.length + 1);
            const i = groups.findIndex(g => g !== undefined);
            const e = entries[i];
            return e && e.id !== null ? ALIAS_PREFIX + e.id : AMBIGUOUS_ALIAS;
        });
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

module.exports = { createPseudonymizer, loadPseudonymizer, IDENTITY, ALIAS_PREFIX, MIN_NAME_LEN, AMBIGUOUS_ALIAS, normalizeName };
