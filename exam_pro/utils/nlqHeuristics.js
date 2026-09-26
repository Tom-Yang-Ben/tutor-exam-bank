// utils/nlqHeuristics.js — 自然語言查題的規則解析（docs/interfaces-stage3.md 第 6.1 條，P-07）
//
// **純函式**：無 I/O、無隨機、無時間、不讀 process.env。
//
// 為什麼規則是主路徑而不是輔助：這個查詢語言的詞彙極小——兩個學科、66 個白名單章節（〔章節重整 CH-A〕
// 2026-09-25 起數學／物理為 86 章，另加化學 44 章）、
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

const { CHAPTERS, QUESTION_TYPES, LEGACY_SUBJECTS } = require('../config/chapters');

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

// ───────────────────────── 化學的科目線索（〔stage5 WS-B〕）─────────────────────────

/**
 * 「一看就是在問化學」的詞（docs/interfaces-stage5.md 第 4.2 條第 2 點）。
 *
 * 用途只有一個：規則一章都沒抓到（confident === false）時，推定這句是不是在問化學。
 * 〔stage5 WS-B〕原本拿來決定**要不要跳過 LLM 輔路徑**（nlq.v1 凍結為數學／物理兩科）。
 * 〔Owner 決策單 2026-09-25 B5〕LLM 輔路徑（nlq.v2）加上化學之後不再跳過 LLM；推定改當退路——
 * LLM 失敗、或 LLM 科目與章節都沒給時，subject 補成化學（見 chemistrySubjectPrior 與 nlqService.parseOnly）。
 * 句子裡有這些詞、**而且沒有任何數理線索**（mentionsMathPhysics）時才推定為化學。
 *
 * 挑選原則：只收數學／物理題幾乎不會出現的詞。「平衡」（受力平衡）、「反應」（反應時間）、
 * 「離子」、「元素」（集合的元素）、「電位」這類跨科詞一律不收。
 * 章節本名與別名不必列在這裡——它們會讓 confident 為真，本來就不會走 LLM。
 * 「幾乎不會」不是「不會」（數學的藥物濃度、物理的核反應式、化學能），所以單靠這張表不能決定科目，
 * 見下方 isChemistryOnlyQuery。
 */
const CHEMISTRY_HINTS = Object.freeze([
    '化學', '化合物', '反應式', '莫耳', '溶液', '濃度', '酸鹼', '氧化', '還原', '沉澱', '有機物', '週期表'
]);

/**
 * 句子裡有沒有化學的科目線索。純函式。
 * @param {string} text
 * @returns {boolean}
 */
function mentionsChemistry(text) {
    const s = String(text ?? '');
    return CHEMISTRY_HINTS.some(w => s.includes(w));
}

/**
 * 點名數學／物理的寫法：LEGACY_SUBJECTS（數學、物理）加上考科的簡稱。
 * 規則層本身從不讀科目名（subject 只由章節反推），所以老師寫了「物理」「數學」，
 * 只有這裡看得到——看到了就不能再把句子當成化學。
 */
const MATH_PHYSICS_SUBJECT_NAMES = Object.freeze([...LEGACY_SUBJECTS, '數甲', '數乙', '數A', '數B']);

/**
 * 含化學線索字、但其實是數理用語的詞（直接視為數理線索）：
 *   化學能（物理「能量的形式與守恆」）、核反應（物理「核物理與基本粒子」，「核反應式」含「反應式」）、
 *   衰減（數學指數衰減的「藥物濃度衰減」、物理的振幅衰減；化學講半生期、衰變）。
 */
const MATH_PHYSICS_COMPOUNDS = Object.freeze(['化學能', '核反應', '衰減']);

/**
 * 句子裡有沒有數學／物理的線索。純函式。
 *   1. 點名數學或物理（MATH_PHYSICS_SUBJECT_NAMES）；
 *   2. 含化學線索字的數理用語（MATH_PHYSICS_COMPOUNDS）；
 *   3. opts.terms（呼叫端注入；nlqService 傳 utils/tokenize.js 的 MATH_PHYSICS_TERMS，
 *      即階段 5 之前的數理自訂詞典）——比對前先把化學線索詞挖掉，「週期表」才不會被「週期」算成物理。
 * 注入而不直接 require：utils/tokenize.js 一載入就會讀 jieba 詞典，本檔維持純函式、不帶這個負擔
 *（同 parseQuery 的 opts.aliases）。
 * @param {string} text
 * @param {{ terms?: readonly string[] }} [opts]
 * @returns {boolean}
 */
function mentionsMathPhysics(text, opts = {}) {
    const s = String(text ?? '');
    if (MATH_PHYSICS_SUBJECT_NAMES.some(w => s.includes(w))) return true;
    if (MATH_PHYSICS_COMPOUNDS.some(w => s.includes(w))) return true;
    let rest = s;
    for (const w of CHEMISTRY_HINTS) rest = rest.split(w).join(' ');
    return (opts.terms || []).some(w => w && rest.includes(w));
}

/**
 * 規則沒抓到章節時，這一句能不能直接當成「只查化學」。純函式。
 * （〔stage5 WS-B〕原本等於「跳過 LLM、subject 設成化學」；〔Owner 決策單 2026-09-25 B5〕起只當
 * chemistrySubjectPrior 的一半，LLM 照樣呼叫。）
 *
 * 有化學線索、**而且**沒有任何數理線索才算。拿不準就回 false——
 * 化學句子頂多查得比較散，數理句子卻不會被鎖進化學。
 * @param {string} text
 * @param {{ mathPhysicsTerms?: readonly string[] }} [opts]
 * @returns {boolean}
 */
function isChemistryOnlyQuery(text, opts = {}) {
    return mentionsChemistry(text) && !mentionsMathPhysics(text, { terms: opts.mathPhysicsTerms });
}

/**
 * 老師明確點名化學（〔Owner 決策單 2026-09-25 B5〕規則層的科目偵測認得化學）。純函式。
 *
 * 句子裡有「化學」（「化學能」不算：那是物理「能量的形式與守恆」的用語，MATH_PHYSICS_COMPOUNDS），
 * 而且**沒有**點名數學或物理（MATH_PHYSICS_SUBJECT_NAMES）。與 mentionsMathPhysics 的第 1 點對稱：
 * 點名物理的句子不會被化學線索字鎖進化學；點名化學的句子也不因為出現數理名詞（密度、速率）就失去化學推定。
 * 兩科都點名（「化學和物理的…」）→ false，交給 LLM。
 * @param {string} text
 * @returns {boolean}
 */
function namesChemistry(text) {
    const s = String(text ?? '');
    if (MATH_PHYSICS_SUBJECT_NAMES.some(w => s.includes(w))) return false;
    return s.split('化學能').join(' ').includes('化學');
}

/**
 * 規則層的化學科目推定（〔Owner 決策單 2026-09-25 B5〕）。純函式。
 *
 * isChemistryOnlyQuery（只有化學線索、沒有數理線索）或 namesChemistry（明確點名化學、沒點名數理）。
 * 用途：nlqService.parseOnly 在規則沒抓到章節時，**LLM 失敗、或 LLM 科目與章節都沒給**才把 subject 補成化學；
 * LLM 有給就以 LLM 為準。規則抓到章節的句子（confident）不看這個——subject 由章節反推（第 6.1 條）。
 * @param {string} text
 * @param {{ mathPhysicsTerms?: readonly string[] }} [opts]  同 isChemistryOnlyQuery
 * @returns {boolean}
 */
function chemistrySubjectPrior(text, opts = {}) {
    return isChemistryOnlyQuery(text, opts) || namesChemistry(text);
}

// ───────────────── LLM 輔路徑的證據檢查（〔dec/x-nlq-improve〕2026-09-26）─────────────────
//
// 用途：nlqService.mergeLlm 合併 LLM 的結果時，**句子裡找不到證據的條件不採用**（見 docs/retrieval.md 第 9 條）。
// 規則層只認得 TYPE_ALIASES 與 DIFFICULTY_RULES 的固定寫法；走到 LLM 輔路徑時，那兩欄若規則沒抓到，
// 原本一律照收 LLM 的值。2026-09-25 本機模型（qwen3:8b）重錄時，LLM 路徑 8 句裡有 2 句句子完全沒提到題型，
// 模型卻因為「求…」「…是多少」回了「計算」——題型是硬篩選，多一個題型就把老師要的填空題整批排除。
// 模板規則 4 早就要求「沒提到的條件不要輸出」，這裡是伺服器端的同一條規則：模型有沒有照做，由句子本身來驗。
//
// 這兩張表是「寬」的：多收一個字只會讓閘門少擋一次（退回原本照收 LLM 的行為），少收一個字卻會丟掉老師真的講過的條件。

/**
 * 題型的證據字。TYPE_ALIASES 的寫法規則層本來就抓得到（抓到時規則的題型優先，LLM 的不看）；
 * 這裡另外收規則層不處理、但老師確實在講題型的說法：「選擇」「非選」「選項」都含「選」、「填格子」含「填」、
 * 「試證」「求證」含「證」，以及白名單以外的題型名（問答、申論、論述、簡答、是非、應用題）——
 * 後者 LLM 可能對到最接近的白名單題型，對不上的再由 validateFilters 丟掉並附警告。
 * 「演算題」「運算題」是計算題的別稱（規則層不認得、也不含「計算」兩字），「非選」已含「選」，列出來是讓表一眼看得懂。
 * 刻意不收「算」：「怎麼算」「求…」「是多少」是題目本身在問的東西，不是老師指定的題型。
 * （「運算」也會出現在「向量的運算」這類單元名稱裡；那是寬的一側——只會讓檢查少擋一次，見上方說明。）
 */
const QUESTION_TYPE_CUES = Object.freeze([
    '選', '非選', '填', '計算', '演算', '運算', '證', '問答', '申論', '論述', '簡答', '是非', '應用題', '題型'
]);

/**
 * 難度的證據字。schema 允許「難一點」「有挑戰性」這類模糊講法（nlq.json 的 difficulty_min 說明），
 * 所以收的是會出現在這類講法裡的字；「星」「級」對應規則層的「N 星」「N 級」，「深」「高階」對應「深一點」「高階一點」。
 * （「深」也會出現在「水深」，「易」在「容易」，「級」在「年級」——都是寬的一側，只會讓檢查少擋一次。）
 */
const DIFFICULTY_CUES = Object.freeze([
    '難', '易', '簡單', '基礎', '基本', '進階', '高階', '挑戰', '程度', '送分', '入門', '中等', '普通',
    '頂標', '前標', '均標', '後標', '艱深', '深', '輕鬆', '星', '級'
]);

/**
 * 句子裡有沒有講到題型。純函式。
 * @param {string} text
 * @returns {boolean}
 */
function mentionsQuestionType(text) {
    const s = String(text ?? '');
    return QUESTION_TYPE_CUES.some(w => s.includes(w));
}

/**
 * 句子裡有沒有講到難度。純函式。
 * @param {string} text
 * @returns {boolean}
 */
function mentionsDifficulty(text) {
    const s = String(text ?? '');
    return DIFFICULTY_CUES.some(w => s.includes(w));
}

/**
 * 平面／空間的線索（數學的向量與直線各有平面、空間兩章）。
 * 平面只收「明講平面坐標系」的寫法：單一個「平面」不算——「平面方程式」「過三點的平面」是空間單元的題材。
 * 空間收「空間」「三維」「立體」與第三個坐標軸。比對前去掉空白、轉小寫（「xy 平面」「Z 軸」）。
 */
const PLANE_CUES = Object.freeze(['平面上', '平面向量', '坐標平面', '座標平面', '平面坐標', '平面座標', '二維', 'xy平面']);
const SPACE_CUES = Object.freeze(['空間', '三維', '立體', 'xyz', 'z軸', 'z坐標', 'z座標']);

/**
 * 「平面」兩字指的是一個幾何物件（空間單元的題材）、不是在講二維的寫法：平面方程式、過…的平面、點到平面、
 * 平面的法向量、兩平面、平面與平面；物理的平面運動、平面鏡、平面波也在內（與數學章的維度無關）。
 * dimensionCue 判斷「有空間線索的句子是不是也講了平面」之前，先把這些拿掉。
 */
const SPATIAL_PLANE_OBJECT = /平面方程式?|過[^，。、,；;！？!?]*?的平面|(?:點|直線|線)到平面|平面的?法向量|[兩二]平面|平面[與和跟及][^，。、,；;]{0,3}平面|平面(?:運動|鏡|波)/g;

/**
 * 句子明講的是平面還是空間。純函式。
 *
 * 回 null（不換任何章）的情況：
 *   - 兩種線索都沒有；
 *   - 兩種線索都有（「空間中的平面上一點」「二維和三維的都要」）；
 *   - 有空間線索，句子**另外**還出現「平面」兩字、而且不是 SPATIAL_PLANE_OBJECT 那類空間題材——
 *     「平面和空間的都要」「平面跟空間各來幾題」是兩個維度都要。單一個「平面」不算平面線索（見 PLANE_CUES），
 *     但出現在有空間線索的句子裡時足以說明句子不是只講空間。寧可不換（退回模型自己的選擇），
 *     也不要把老師要的那一章換掉（〔dec/x-nlq-improve-fix〕審查意見）。
 * @param {string} text
 * @returns {'plane'|'space'|null}
 */
function dimensionCue(text) {
    const s = String(text ?? '').replace(/\s+/g, '').toLowerCase();
    const plane = PLANE_CUES.some(w => s.includes(w));
    const space = SPACE_CUES.some(w => s.includes(w));
    if (plane && space) return null;
    if (plane) return 'plane';
    if (!space) return null;
    return s.replace(SPATIAL_PLANE_OBJECT, '').includes('平面') ? null : 'space';
}

/**
 * 空間章 → 同名的平面章：數學白名單裡「空間 + X」而且 X 本身也是數學章節的那幾對
 * （2026-09-26 為「空間向量內積 → 向量內積」「空間直線方程式 → 直線方程式」）。
 * 由 CHAPTERS 動態算，章節改名時不必改這裡；沒有同名平面章的空間章（外積、平面方程式、空間概念與座標系）不在表內。
 */
const SPACE_TO_PLANE = Object.freeze(Object.fromEntries(
    (CHAPTERS['數學'] || [])
        .filter(c => c.startsWith('空間') && (CHAPTERS['數學'] || []).includes(c.slice(2)))
        .map(c => [c, c.slice(2)])
));
const PLANE_TO_SPACE = Object.freeze(Object.fromEntries(Object.entries(SPACE_TO_PLANE).map(([s, p]) => [p, s])));

/**
 * 依句子明講的平面／空間，把 LLM 挑錯維度的章換成同名的另一章。純函式。
 *
 * 只在句子**明講**單一維度時才換（dimensionCue 不是 null），而且只換 SPACE_TO_PLANE 表內有對應的章；
 * 其餘原樣保留、順序不變、去重。
 * **同名的另一章已經在清單裡就不換**：模型把平面、空間兩章都列出來，可能就是老師要兩個都要
 * （句子判斷漏掉的講法），換掉會把老師要的那一章刪掉、候選集少一半；兩章都留著最多只是多混進一章的題，
 * 不會丟掉相關題（〔dec/x-nlq-improve-fix〕審查意見）。所以這裡只修「模型只挑了錯的那一個維度」。
 * 為什麼需要：golden nlq-042 的原句沒講平面或空間，Owner 裁決（CR-8 之二）改寫為「平面上…」消除歧義，
 * 2026-09-25 本機模型重錄仍回了「空間向量內積」（沒有同時回「向量內積」）——句子已經講清楚的事，不該讓模型再猜一次。
 *
 * @param {string[]} chapters LLM 給的章節（尚未過白名單）
 * @param {string} text 老師的原句
 * @returns {{chapters:string[], changes:Array<{from:string, to:string}>}}
 */
function alignChapterDimension(chapters, text) {
    const list = Array.isArray(chapters) ? chapters : [];
    const cue = dimensionCue(text);
    const table = cue === 'plane' ? SPACE_TO_PLANE : cue === 'space' ? PLANE_TO_SPACE : null;
    const out = [];
    const changes = [];
    for (const chapter of list) {
        const counterpart = table && typeof chapter === 'string' && Object.prototype.hasOwnProperty.call(table, chapter)
            ? table[chapter] : null;
        const mapped = counterpart !== null && !list.includes(counterpart) ? counterpart : chapter;
        if (out.includes(mapped)) continue;   // 模型重複列同一章：只留一個、也只記一次
        out.push(mapped);
        if (mapped !== chapter) changes.push({ from: chapter, to: mapped });
    }
    return { chapters: out, changes };
}

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
    trimFiller,
    // 〔stage5 WS-B〕化學的科目線索（nlqService.parseOnly）
    CHEMISTRY_HINTS,
    MATH_PHYSICS_SUBJECT_NAMES,
    MATH_PHYSICS_COMPOUNDS,
    mentionsChemistry,
    mentionsMathPhysics,
    isChemistryOnlyQuery,
    // 〔Owner 決策單 2026-09-25 B5〕LLM 輔路徑加上化學後，規則層的化學推定改當退路
    namesChemistry,
    chemistrySubjectPrior,
    // 〔dec/x-nlq-improve〕LLM 輔路徑的證據檢查（nlqService.mergeLlm）
    QUESTION_TYPE_CUES,
    DIFFICULTY_CUES,
    PLANE_CUES,
    SPACE_CUES,
    SPATIAL_PLANE_OBJECT,
    SPACE_TO_PLANE,
    PLANE_TO_SPACE,
    mentionsQuestionType,
    mentionsDifficulty,
    dimensionCue,
    alignChapterDimension
};
