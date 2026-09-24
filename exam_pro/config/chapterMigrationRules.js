// ─────────────────────────────────────────────────────────────
// config/chapterMigrationRules.js — 舊題搬章的關鍵字規則（docs/chapter-restructure.md 第 3.1 條第 7 點、ADR-016）
//
// 用途：scripts/migrate_chapters.js（npm run chapters:migrate）替「被拆分」的舊章裡的每一題
// 提議一個新章。規則只負責**提議**，老師在提議檔（CSV）裡逐列確認後才會套用；這裡不呼叫 LLM。
//
// 比對方式（matchKeywordRule）：
//   1. 只考慮該舊章在 config/chapterPlan.js MIGRATION 裡的 `to`（拆分去處）。規則的去處不在 `to` 裡就跳過——
//      例如「不等式 → 多項式不等式」只對「三次函數」的題有效，不會把「絕對值」的題拉走。
//   2. 分兩輪：先比題幹，題幹一個規則都沒命中才比入庫時 AI 抽的 keywords 與 concept_summary。
//      題幹是老師看得到、最可靠的訊號；metadata 是退路（很多題幹不寫「和角公式」，但 keywords 會寫）。
//   3. 每一輪依規則的**陣列順序**比，第一條命中的規則勝出；同一條規則內依關鍵字順序取第一個命中的詞，
//      寫進提議檔的「依據」欄（keyword:<命中詞>）。
//   4. 都沒命中 → 提議 to[0]（依據 default）。
//
// 順序的原則：越專門的詞越前面。幾個刻意的先後：
//   - 疊合在和角之前：疊合題常常同時寫「利用和角公式」，但它考的是疊合。
//   - 遞迴／數學歸納在 Σ／級數之前：「用數學歸納法證明 Σk² 的公式」屬於數列與遞迴關係那一章。
//   - 克拉瑪公式拆成三條：三元／高斯消去 → 一次方程組；二元一次／克拉瑪 → 面積與行列式（108 把二階行列式
//     與克拉瑪公式放在第三冊）；剩下的「聯立」才 → 一次方程組。「以克拉瑪公式解二元一次聯立方程式」因此落在面積與行列式。
//   - 題幹常見的數學符號用 LaTeX 寫（\sum），所以「Σ」與「\sum」都收；連加符號另有一個碼位「∑」（U+2211，
//     NFKC 不會把它變成希臘字母 Σ U+03A3），也收。
//   - 三角函數的定義：先比廣義角的字眼、再比三角函數的圖形，最後才看角度（樣式規則 wideAngle）——題幹出現
//     大於 90° 或負的角度（sin 150°、cos 120^\circ、tan(-30°)）就提議廣義角與極坐標（108 的直角三角形只處理銳角）。
//     放在圖形之後：「y=sin(x+120°) 的圖形」考的是圖形。正好 90° 不算（直角三角形的題幾乎都寫 ∠C=90°）。
//
// 規則的形狀：{ to, keywords?, patterns? }。keywords 是子字串；patterns 是 { name, find(text) → 命中的原文|null }，
// 給子字串表達不了的條件（角度大小）用，命中的原文照樣寫進依據欄（keyword:150°）。兩者至少要有一個。
//
// 關鍵字全部是通用學科名詞，不取自任何考卷。
// ─────────────────────────────────────────────────────────────

const { PLAN_CHAPTERS, MIGRATION } = require('./chapterPlan');

/**
 * 角度的寫法：150°、150 °、150^\circ、150^{\circ}、150 度；負號只認「前面不是字母、數字、右括號」的
 *（sin(x-30°) 的減號不是負角）。比對前已做 NFKC（全形「－」會變成「-」；U+2212「−」另外收）。
 */
const ANGLE_RE = /(?:(?<![\p{L}\p{N})\]}])([-−]))?\s*(\d+(?:\.\d+)?)\s*(?:°|\^\s*\{?\s*\\circ\s*\}?|度)/gu;

/**
 * 題幹裡第一個「大於 90° 或負的」角度，回傳命中的原文（去掉前後空白）；沒有回 null。純函式。
 * @param {string} text
 * @returns {string|null}
 */
function findWideAngle(text) {
    for (const m of String(text ?? '').matchAll(ANGLE_RE)) {
        if (m[1] || Number(m[2]) > 90) return m[0].trim();
    }
    return null;
}

/**
 * 〔章節重整整合〕底數不是 10 的對數：\log_{2}、\log_3、log_a、\log_{\frac12}… → 第三冊「指數函數與對數函數」。
 * \log_{10} 與不寫底數的 log（常用對數）不算。
 * @param {string} text
 * @returns {string|null} 命中的原文
 */
function findNonCommonLogBase(text) {
    const re = /\\?log_\s*(\{[^}]*\}|[A-Za-z0-9])/g;
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) {
        const base = m[1].replace(/^\{|\}$/g, '').trim();
        if (base && base !== '10') return m[0];
    }
    return null;
}

/**
 * 〔CR-8〕指數是變數的式子（$2^{x+1}$、$3^x$、$(\frac12)^{t}$）→ 第三冊「指數函數與對數函數」；$2^{50}$、$(x+1)^2$ 不算。
 * @param {string} text
 * @returns {string|null}
 */
function findVariableExponent(text) {
    const m = String(text ?? '').match(/[\d)}]\s*\^\s*(?:\{[^}]*[xyt][^}]*\}|[xyt])/);
    return m ? m[0] : null;
}

/**
 * 〔CR-8〕「前 $n$ 項和」「前 20 項和」→ 級數（由 S_n 求一般項也在級數）；「第 3 項和第 5 項」不算。
 * @param {string} text
 * @returns {string|null}
 */
function findFirstNTermsSum(text) {
    const m = String(text ?? '').match(/前\s*\$?[^$]{0,8}\$?\s*項和/);
    return m ? m[0] : null;
}

/**
 * 〔CR-8〕題幹有變數 z（如 $x+y+z=6$、$2x-y+3z=1$）→ 三元一次方程組。
 * @param {string} text
 * @returns {string|null}
 */
function findVariableZ(text) {
    const m = String(text ?? '').match(/[+\-=]\s*\d*\s*z\b/);
    return m ? m[0].trim() : null;
}

/**
 * 科目 → 有序的規則表。`to` 必須是 PLAN_CHAPTERS 裡的新章，而且出現在至少一個 split 舊章的 `to` 裡。
 * @type {Readonly<Record<string, ReadonlyArray<{to:string, keywords?:ReadonlyArray<string>,
 *                                              patterns?:ReadonlyArray<{name:string, find:(text:string)=>string|null}>}>>>}
 */
const KEYWORD_RULES = deepFreeze({
    '數學': [
        // 正弦與餘弦定理 → 正弦與餘弦定理／和角與差角公式／三角函數的疊合
        { to: '三角函數的疊合', keywords: ['疊合'] },
        { to: '和角與差角公式', keywords: ['和角', '差角', '倍角', '半角'] },
        // 古典機率 → 古典機率／條件機率與貝氏定理
        { to: '條件機率與貝氏定理', keywords: ['條件機率', '貝氏', '獨立事件', '相互獨立', '互相獨立', '彼此獨立'] },
        // 組合 → 組合／二項式定理
        // 〔CR-8〕巴斯卡公式的知識點在「組合」（組合.02），不再以「巴斯卡」搬到二項式定理
        { to: '二項式定理', keywords: ['二項式', '二項展開'] },
        // 數列與級數 → 數列與遞迴關係／級數
        { to: '數列與遞迴關係', keywords: ['遞迴', '數學歸納'] },
        { to: '級數', keywords: ['Σ', '∑', '\\sum', '級數', '項的和', '項之和', '總和', 'S_n'] },
        { to: '級數', patterns: [{ name: 'firstNTermsSum', find: findFirstNTermsSum }] },
        // 三次函數 → 多項式函數的圖形／多項式不等式／複數與多項式方程式
        { to: '複數與多項式方程式', keywords: ['複數', '虛數', '虛根', '代數基本定理', '根與係數', '共軛'] },
        { to: '多項式不等式', keywords: ['不等式'] },
        // 排列 → 排列／集合與計數原理
        { to: '集合與計數原理', keywords: ['集合', '排容', '文氏圖', '取捨原理', '加法原理', '樹狀圖'] },
        // 矩陣的加減與乘法 → 矩陣的運算／矩陣的應用
        { to: '矩陣的應用', keywords: ['轉移矩陣', '線性變換', '旋轉', '鏡射', '馬可夫', '解聯立', '伸縮', '推移', '穩定狀態'] },
        // 克拉瑪公式 → 一次方程組／面積與行列式（先後見檔頭說明）
        { to: '一次方程組', keywords: ['三元', '高斯消去'] },
        // 〔CR-8〕題幹出現變數 z（三元）時，即使寫「克拉瑪」也歸一次方程組
        { to: '一次方程組', patterns: [{ name: 'hasZ', find: findVariableZ }] },
        { to: '面積與行列式', keywords: ['二元一次', '克拉瑪'] },
        { to: '一次方程組', keywords: ['聯立'] },
        // 三角函數的定義 → 直角三角形的邊角關係／廣義角與極坐標／三角函數的圖形
        { to: '廣義角與極坐標', keywords: ['廣義角', '標準位置', '極坐標', '極座標', '象限', '終邊', '同界角', '參考角'] },
        { to: '三角函數的圖形', keywords: ['圖形', '週期', '振幅', '弧度', '方程式', '扇形', '弧長', '\\pi'] },
        { to: '廣義角與極坐標', patterns: [{ name: 'wideAngle', find: findWideAngle }] },
        // 隨機變數 → 隨機變數／二項分布與幾何分布
        { to: '二項分布與幾何分布', keywords: ['二項分布', '二項分佈', '二項分配', '幾何分布', '幾何分佈', '幾何分配', '伯努利'] },
        // 指數與對數 → 指數與對數／指數函數與對數函數
        // 〔章節重整整合〕CH-C 把一般底數的對數、換底公式、指數／對數方程式與不等式放在第三冊（常用對數留第一冊）
        { to: '指數函數與對數函數', keywords: ['指數函數', '對數函數', '換底', '指數方程式', '對數方程式', '指數不等式', '對數不等式'] },
        { to: '指數函數與對數函數', keywords: ['複利', '半衰期'] },
        { to: '指數函數與對數函數', patterns: [{ name: 'nonCommonLogBase', find: findNonCommonLogBase }, { name: 'variableExponent', find: findVariableExponent }] },
        // 〔CR-8〕直線方程式 → 直線方程式／線性規劃（二元一次不等式的圖形已搬到線性規劃）
        { to: '線性規劃', keywords: ['二元一次不等式', '半平面', '可行解', '目標函數', '線性規劃'] }
    ],
    '物理': [
        // 動量與衝量／動量守恆與碰撞／剛體轉動與平衡 → 各自原章／質心與角動量
        { to: '質心與角動量', keywords: ['質心', '角動量'] }
    ]
});

function deepFreeze(node) {
    if (node && typeof node === 'object' && !Object.isFrozen(node)) {
        Object.freeze(node);
        for (const v of Object.values(node)) deepFreeze(v);
    }
    return node;
}

/**
 * 比對用的正規化：NFKC（全形英數、全形括號 → 半形），其餘不動。純函式。
 * @param {unknown} text
 * @returns {string}
 */
function normalizeForMatch(text) {
    return String(text ?? '').normalize('NFKC');
}

/**
 * 在 `targets`（某個 split 舊章的拆分去處）範圍內，依規則表找第一條命中的規則。純函式。
 *
 * @param {string} subject
 * @param {string[]} targets           MIGRATION[subject][舊章].to
 * @param {string[][]} passes          分輪的文字，例：[[題幹], [keywords..., concept_summary]]；前一輪命中就不看後一輪
 * @param {object} [rules]             預設 KEYWORD_RULES（測試可注入）
 * @returns {{to:string, keyword:string, pass:number}|null}
 */
function matchKeywordRule(subject, targets, passes, rules = KEYWORD_RULES) {
    const list = (rules && rules[subject]) || [];
    const allowed = new Set(targets || []);
    for (let p = 0; p < passes.length; p++) {
        const texts = (passes[p] || []).map(normalizeForMatch).filter(Boolean);
        if (texts.length === 0) continue;
        for (const rule of list) {
            if (!allowed.has(rule.to)) continue;
            for (const kw of rule.keywords || []) {
                const needle = normalizeForMatch(kw);
                if (texts.some(t => t.includes(needle))) return { to: rule.to, keyword: kw, pass: p };
            }
            for (const pat of rule.patterns || []) {
                for (const t of texts) {
                    const hit = pat.find(t);
                    if (hit) return { to: rule.to, keyword: hit, pass: p };
                }
            }
        }
    }
    return null;
}

/**
 * 規則表的自我檢查（單元測試與遷移腳本共用同一支）。
 * @param {object} [rules]
 * @returns {string[]} 問題描述；空陣列 = 全數通過
 */
function validateRules(rules = KEYWORD_RULES) {
    const problems = [];
    for (const [subject, list] of Object.entries(rules)) {
        const plan = PLAN_CHAPTERS[subject];
        if (!plan) { problems.push(`規則的科目「${subject}」不在 PLAN_CHAPTERS`); continue; }
        // 這一科所有 split 舊章的拆分去處
        const splitTargets = new Set();
        for (const m of Object.values(MIGRATION[subject] || {})) {
            if (m.kind === 'split') for (const t of m.to) splitTargets.add(t);
        }
        const seen = new Map();
        for (const [i, rule] of list.entries()) {
            if (!plan.includes(rule.to)) problems.push(`${subject} 第 ${i + 1} 條規則的去處「${rule.to}」不在新白名單`);
            else if (!splitTargets.has(rule.to)) problems.push(`${subject} 第 ${i + 1} 條規則的去處「${rule.to}」不是任何拆分舊章的去處，永遠用不到`);
            const patterns = rule.patterns || [];
            if (!Array.isArray(patterns) || patterns.some(pt => !pt || typeof pt.find !== 'function' || !pt.name)) {
                problems.push(`${subject} 第 ${i + 1} 條規則（→${rule.to}）的 patterns 每一項都要有 name 與 find 函式`);
            }
            const keywords = rule.keywords === undefined ? [] : rule.keywords;
            if (!Array.isArray(keywords) || (keywords.length === 0 && patterns.length === 0)) {
                problems.push(`${subject} 第 ${i + 1} 條規則（→${rule.to}）沒有關鍵字`);
                continue;
            }
            for (const kw of keywords) {
                if (typeof kw !== 'string' || kw.trim() === '') { problems.push(`${subject} 第 ${i + 1} 條規則有空的關鍵字`); continue; }
                if (seen.has(kw) && seen.get(kw) !== rule.to) {
                    problems.push(`${subject} 的關鍵字「${kw}」同時指向「${seen.get(kw)}」與「${rule.to}」`);
                }
                seen.set(kw, rule.to);
            }
        }
    }
    return problems;
}

module.exports = { KEYWORD_RULES, matchKeywordRule, validateRules, normalizeForMatch, findWideAngle, findNonCommonLogBase, findVariableExponent, findFirstNTermsSum, findVariableZ };
