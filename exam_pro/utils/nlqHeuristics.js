// utils/nlqHeuristics.js — 自然語言查題的規則解析（docs/interfaces-stage3.md 第 6.1 條，P-07）
//
// **純函式**：無 I/O、無隨機、無時間、不讀 process.env。
//
// 為什麼規則是主路徑而不是輔助：這個查詢語言的詞彙極小——兩個學科、66 個白名單章節、
// 五種題型、1~5 難度、學生名（規劃 §4.3.4）。規則抓得到就不必花錢呼叫 LLM，
// 而且規則的輸出是可重現的：同一句話今天與三個月後解析結果一模一樣。
// `confident`（＝命中 ≥ 1 個章節）就是那一個決定要不要付錢的布林值。
//
// ── 掃描順序與「吃掉」的語意 ──────────────────────────────────
// 解析分四輪，每一輪都在**尚未被吃掉**的字元上比對，命中就把那一段標記起來：
//   1. 章節本名與別名（長的優先）  → 標記為 concept（概念詞）
//   2. 難度                        → 標記為 drop（條件詞）
//   3. 題型                        → 標記為 drop
//   4. 「X 沒寫過」的學生名        → 標記為 drop
// 先章節再學生是有意義的：章節先被吃掉之後，「…摩擦力小明沒寫過」的學生名
// 就不可能往前吃到章節的尾巴。
//
// semantic_text 的組法 —— **依據是裁決 S3-R17**（`docs/interfaces-stage3.md` §15）：
//
//   「`semantic_text` 以第 6 條與第 8.4 條的兩個範例為準：概念詞（章節本名／別名）原文保留、
//     條件詞整段拿掉、自由文字剝頭尾虛詞；第 6.1 條那行散文改寫。」
//
//   §15 的裁決**優先於上文對應條文**，所以第 6.1 條那一行
//   「扣掉已被規則吃掉的片段後剩下的文字」不是本檔的依據，S3-R17 才是。
//
//   落到程式碼就是：concept 段**原文保留**、drop 段整段拿掉、其餘自由文字去掉頭尾的虛詞，
//   非空的片段以單一空白連接。
//   「牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過」→「牛頓第二定律 摩擦力」，
//   與第 6 條開頭的回應範例、第 8.4 條的 golden 範例逐字相同（單元測試釘住）。
//
//   為什麼是這樣而不是照第 6.1 條的字面（原 docs/archive/questions3-wsC.md 第 1 題，已結案）：
//   semantic_text 是第 6.5 條拿去 embed() 的查詢字串。概念詞不留在裡面的話，
//   這一句的向量查詢字串會變成「加 的」——**規則抓得越準、向量側就越沒東西可查**，
//   那顯然不是這個欄位的用意。

const { CHAPTERS, QUESTION_TYPES } = require('../config/chapters');

/** 字元標記：0 = 自由文字、1 = 概念詞（章節／別名）、2 = 被規則吃掉的條件詞 */
const FREE = 0;
const CONCEPT = 1;
const DROP = 2;

/**
 * 題型的口語寫法 → 白名單題型。
 * 一律「長的優先」比對，所以「複選題」不會先被「複選」吃掉半截。
 */
const TYPE_ALIASES = {
    '單選題': '單選', '單選': '單選', '選擇題': '單選',
    '多選題': '多選', '多選': '多選', '複選題': '多選', '複選': '多選',
    '填空題': '填空', '填空': '填空', '填充題': '填空', '填充': '填空',
    '計算題': '計算', '計算': '計算',
    '證明題': '證明', '證明': '證明'
};

/**
 * 自由文字片段的頭尾虛詞。**只從頭尾剝，不動中間**——
 * 中間也剝的話「不等式」會被剝成「等式」、「有理數」會被剝成「理數」。
 */
const EDGE_FILLER = new Set(
    '的了嗎呢吧啊喔耶欸我你他她想要找給幫請有沒是跟和與及或加再還也都就那這些個出來下把被讓對從題'.split('')
);

/** 整段刪掉的口語套話（在頭尾剝虛詞之前先做，順序 = 由長到短） */
const FILLER_PHRASES = [
    '可不可以', '有沒有什麼', '是不是有', '幫我找一下', '幫我出幾題', '幫我出一些',
    '有沒有', '是不是', '幫我找', '幫我出', '幫我', '我想找', '我想要', '我想',
    '請問', '麻煩', '可以', '之類的', '之類', '類似', '相關', '有關', '關於',
    '練習題', '的題目', '題目', '考卷', '出題', '來幾題', '來一些', '幾題', '一些',
    '找一下', '查一下', '一下', '查詢', '搜尋', '複習'
];

/** 全形／半形空白與標點（用來把自由文字切成片段） */
const SPLIT_RE = /[\s，,。.、；;：:！!？?（）()「」『』【】《》～~\-—_/|]+/;

/**
 * 依「長的優先、同長依字典序」排序的比對表，順序完全確定。
 * @param {Record<string,string>} table
 * @returns {Array<[string,string]>}
 */
function sortedEntries(table) {
    return Object.entries(table).sort((a, b) => (b[0].length - a[0].length) || (a[0] < b[0] ? -1 : 1));
}

/**
 * 章節本名 → 章節本名（章節名彼此也有子字串關係，例如「向量內積」⊂「空間向量內積」，
 * 靠同一套「長的優先」處理）。
 */
const CHAPTER_SELF = {};
for (const list of Object.values(CHAPTERS)) {
    for (const chapter of list) CHAPTER_SELF[chapter] = chapter;
}

/** 章節名 → 學科（章節名在兩科白名單內是唯一的，第 6.1 條） */
const SUBJECT_OF_CHAPTER = new Map();
for (const [subject, list] of Object.entries(CHAPTERS)) {
    for (const chapter of list) SUBJECT_OF_CHAPTER.set(chapter, subject);
}

/** 夾在 1~5 */
const clampLevel = (n) => Math.min(5, Math.max(1, n));

/**
 * 在 marks 全是 FREE 的區段裡找 needle 的第一個位置。
 * 已經被吃掉的字元不得再參與比對，否則「摩擦力」會在「靜摩擦力」被吃掉之後又命中一次。
 * @returns {number} 起始索引；找不到回 -1
 */
function findFree(text, marks, needle) {
    if (!needle) return -1;
    let from = 0;
    while (from + needle.length <= text.length) {
        const at = text.indexOf(needle, from);
        if (at === -1) return -1;
        let clean = true;
        for (let i = at; i < at + needle.length; i++) {
            if (marks[i] !== FREE) { clean = false; break; }
        }
        if (clean) return at;
        from = at + 1;
    }
    return -1;
}

/** 把 [start, start+len) 標成 mark */
function mark(marks, start, len, value) {
    for (let i = start; i < start + len; i++) marks[i] = value;
}

/**
 * 把 marks 為 FREE 的字元換成 '\u0000'，其餘保留原字元。
 * 難度／題型／學生名的正規表達式只能在這個「遮罩過的」字串上跑：
 * `\u0000` 不會被任何一個中文字元類別匹配到，天然阻斷跨越已吃片段的比對。
 */
function freeOnly(text, marks) {
    let out = '';
    for (let i = 0; i < text.length; i++) out += marks[i] === FREE ? text[i] : '\u0000';
    return out;
}

// ───────────────────────── 難度 ─────────────────────────

/**
 * 難度規則（依序，第一個命中就停）。第 6.1 條的最低要求：
 * `N 以上`／`N 以下`／`N~M`／`N～M`／`N 星`。
 * 每一條都必須連「難度」「星」這些詞一起吃掉，否則它們會留在 semantic_text 裡。
 */
const DIFFICULTY_RULES = [
    // N ~ M（含「難度 3 到 5」「3~5 星」）
    {
        re: /(?:難度\s*)?([1-5])\s*(?:分|星|級)?\s*(?:到|至|~|～|-|－|—)\s*([1-5])\s*(?:分|星|級)?/,
        pick: (m) => ({ min: Number(m[1]), max: Number(m[2]) }),
        needsAnchor: true
    },
    // N 以上（含「難度 4 以上」「4 星以上」「難度大於等於 4」）
    {
        re: /(?:難度\s*(?:大於等於|不低於|至少)?\s*|(?=[1-5]\s*(?:分|星|級)))([1-5])\s*(?:分|星|級)?\s*(?:以上|(?:或|及)以上|之上)/,
        pick: (m) => ({ min: Number(m[1]), max: 5 })
    },
    // N 以下
    {
        re: /(?:難度\s*(?:小於等於|不高於|最多)?\s*|(?=[1-5]\s*(?:分|星|級)))([1-5])\s*(?:分|星|級)?\s*(?:以下|(?:或|及)以下|之下)/,
        pick: (m) => ({ min: 1, max: Number(m[1]) })
    },
    // N 星（沒有以上／以下就是剛好那一級）
    {
        re: /([1-5])\s*(?:顆)?\s*(?:星|級)/,
        pick: (m) => ({ min: Number(m[1]), max: Number(m[1]) })
    },
    // 難度 N
    {
        re: /難度\s*(?:是|為|等於|＝|=)?\s*([1-5])\s*(?:分)?/,
        pick: (m) => ({ min: Number(m[1]), max: Number(m[1]) })
    }
];

/**
 * @returns {{min:number, max:number, matched:string}|null}
 */
function parseDifficulty(text, marks) {
    const masked = freeOnly(text, marks);
    for (const rule of DIFFICULTY_RULES) {
        const m = rule.re.exec(masked);
        if (!m) continue;
        // 「N~M」這一條若沒有「難度／星／級」當錨點，會把「(A) 3~5」這種數字區間也吃掉。
        if (rule.needsAnchor && !/難度|星|級|分/.test(m[0])) continue;
        const { min, max } = rule.pick(m);
        mark(marks, m.index, m[0].length, DROP);
        const lo = clampLevel(Math.min(min, max));
        const hi = clampLevel(Math.max(min, max));
        return { min: lo, max: hi, matched: m[0] };
    }
    return null;
}

// ───────────────────────── 題型 ─────────────────────────

/**
 * @returns {{types:string[], matched:string[]}}
 */
function parseQuestionTypes(text, marks) {
    const types = [];
    const matched = [];
    for (const [alias, canonical] of sortedEntries(TYPE_ALIASES)) {
        const at = findFree(text, marks, alias);
        if (at === -1) continue;
        mark(marks, at, alias.length, DROP);
        if (!types.includes(canonical)) {
            types.push(canonical);
            matched.push(canonical);
        }
    }
    // 順序固定為 config/chapters.js 的 QUESTION_TYPES 宣告順序：
    // 「計算題或單選」與「單選或計算題」必須解析成同一組 filters，
    // 否則 eval 的 filters_exact 會因為語序而抖動。
    types.sort((a, b) => QUESTION_TYPES.indexOf(a) - QUESTION_TYPES.indexOf(b));
    matched.sort((a, b) => QUESTION_TYPES.indexOf(a) - QUESTION_TYPES.indexOf(b));
    return { types, matched };
}

// ───────────────────────── 學生「沒寫過」 ─────────────────────────

/**
 * 「X 沒寫過／沒做過／沒寫」（第 6.1 條）。
 * 名字取 2~4 個連續漢字或一段英文；遮罩過的字串保證它不會跨越已被吃掉的片段。
 */
const STUDENT_RE = /([一-鿿]{2,5}|[A-Za-z][A-Za-z]{1,15})\s*(?:同學)?\s*沒(?:有)?\s*(?:寫過|做過|練過|考過|答過|寫|做)/;

/**
 * 名字尾巴的副詞。漢字類別是貪婪的，「小明還沒寫過」會把「還」一起吃進名字裡，
 * 而把副詞寫成 `(?:都|還)?` 也救不了——選擇性群組讓給前面的貪婪量詞是正規表達式的預設行為。
 * 與其把 regex 寫得更繞，不如比對完之後把這幾個字從名字尾巴剝掉（比對到的**區段**照樣整段吃掉）。
 */
const NAME_TAIL_ADVERB = /(?:同學|老師|學生|都|還|也|就|才|又|一直|從來|根本|完全)+$/;

/**
 * @returns {{name:string, matched:string}|null}
 */
function parseExcludedStudent(text, marks) {
    const masked = freeOnly(text, marks);
    const m = STUDENT_RE.exec(masked);
    if (!m) return null;
    const name = /^[A-Za-z]/.test(m[1]) ? m[1] : m[1].replace(NAME_TAIL_ADVERB, '');
    // 剝完只剩一個字（「他還沒寫過」的「他」）就不算學生名——寧可不抓，也不要抓錯人
    if (name.length < 2) return null;
    mark(marks, m.index, m[0].length, DROP);
    return { name, matched: m[0] };
}

// ───────────────────────── semantic_text ─────────────────────────

/** 先刪整段套話，再從頭尾剝虛詞 */
function trimFiller(piece) {
    let s = piece;
    for (const phrase of FILLER_PHRASES) {
        while (s.includes(phrase)) s = s.replace(phrase, '');
    }
    let start = 0;
    let end = s.length;
    while (start < end && EDGE_FILLER.has(s[start])) start += 1;
    while (end > start && EDGE_FILLER.has(s[end - 1])) end -= 1;
    return s.slice(start, end).trim();
}

/**
 * 依 marks 把原文組成 semantic_text。
 * concept 段原文保留、drop 段整段拿掉、自由文字剝掉頭尾虛詞；非空片段以單一空白連接。
 */
function buildSemanticText(text, marks) {
    const parts = [];
    let buffer = '';
    let bufferMark = null;

    const flush = () => {
        if (bufferMark === CONCEPT) {
            const s = buffer.trim();
            if (s) parts.push(s);
        } else if (bufferMark === FREE) {
            for (const piece of buffer.split(SPLIT_RE)) {
                const s = trimFiller(piece);
                if (s) parts.push(s);
            }
        }
        buffer = '';
        bufferMark = null;
    };

    for (let i = 0; i < text.length; i++) {
        if (marks[i] !== bufferMark) { flush(); bufferMark = marks[i]; }
        buffer += text[i];
    }
    flush();

    return parts.join(' ').trim();
}

// ───────────────────────── 主函式 ─────────────────────────

/**
 * 規則解析。純函式：無 I/O、無隨機、無時間、不讀 process.env。
 *
 * @param {string} text
 * @param {{ aliases: Record<string,string> }} opts   aliases = config/chapterAliases.js 的 CHAPTER_ALIASES
 * @returns {{
 *   filters: { subject:string|null, chapters:string[], question_types:string[],
 *              difficulty_min:number|null, difficulty_max:number|null,
 *              exclude_student_name:string|null, keywords:string[] },
 *   confident: boolean,        // === filters.chapters.length >= 1
 *   semantic_text: string      // 扣掉已被規則吃掉的片段後剩下的文字（去頭尾空白）
 * }}
 */
function parseQuery(text, opts = {}) {
    const raw = String(text ?? '');
    const marks = new Array(raw.length).fill(FREE);

    const filters = {
        subject: null,
        chapters: [],
        question_types: [],
        difficulty_min: null,
        difficulty_max: null,
        exclude_student_name: null,
        keywords: []
    };

    if (raw.trim() === '') {
        return { filters, confident: false, semantic_text: '' };
    }

    // ── 1. 章節本名與別名（長的優先）──
    // 兩張表合併後一起排序：章節本名「向量內積」與別名「平面向量內積」必須在同一個
    // 長度序裡競爭，分兩輪掃會讓短的章節本名先吃掉長別名的一半。
    const aliasTable = Object.assign({}, CHAPTER_SELF, opts.aliases || {});
    const hits = [];   // { at, literal, chapter }
    for (const [needle, chapter] of sortedEntries(aliasTable)) {
        let guard = 0;
        for (;;) {
            const at = findFree(raw, marks, needle);
            if (at === -1) break;
            mark(marks, at, needle.length, CONCEPT);
            hits.push({ at, literal: needle, chapter });
            if (++guard > 8) break;     // 同一個詞重複出現八次以上就不再收，純防呆
        }
    }
    // 依出現順序（而非長度序）決定 chapters 與 keywords 的順序：
    // 使用者念的順序就是他心裡的優先序，第 6.4 條「超過 3 個只採前 3 個」靠它才有意義。
    hits.sort((a, b) => a.at - b.at);
    for (const hit of hits) {
        if (!filters.chapters.includes(hit.chapter)) filters.chapters.push(hit.chapter);
        if (!filters.keywords.includes(hit.literal)) filters.keywords.push(hit.literal);
    }

    // ── 2. 難度 ──
    const difficulty = parseDifficulty(raw, marks);
    if (difficulty) {
        filters.difficulty_min = difficulty.min;
        filters.difficulty_max = difficulty.max;
    }

    // ── 3. 題型 ──
    const typed = parseQuestionTypes(raw, marks);
    filters.question_types = typed.types;
    for (const t of typed.matched) {
        // 第 6.1 條：keywords = 被規則吃掉的實詞（章節別名原文、題型）
        if (!filters.keywords.includes(t)) filters.keywords.push(t);
    }

    // ── 4. 「X 沒寫過」──
    const student = parseExcludedStudent(raw, marks);
    if (student) filters.exclude_student_name = student.name;

    // ── subject 由第一個命中的章節反推（第 6.1 條）──
    if (filters.chapters.length > 0) {
        filters.subject = SUBJECT_OF_CHAPTER.get(filters.chapters[0]) || null;
    }

    return {
        filters,
        confident: filters.chapters.length >= 1,
        semantic_text: buildSemanticText(raw, marks)
    };
}

module.exports = {
    parseQuery,
    // 給單元測試與 nlqService 用（都不是第 6.1 條的凍結簽名的一部分）
    TYPE_ALIASES,
    STUDENT_RE,
    SUBJECT_OF_CHAPTER,
    trimFiller
};
