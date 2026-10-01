// ─────────────────────────────────────────────────────────────
// eval/lib/chapterGate.js — eval 素材硬閘門的章節白名單來源（〔章節重整 CH-B〕）
//
// 預設就是 config/chapters.js 的 isValidSubject／isValidChapter：規劃 §5.3.2 的硬閘門
// 「載入時逐題過 isValidChapter（config/chapters.js）」**一個字都沒改**，eval/run.js 永遠走預設。
//
// 多這一層只為了「注入」。docs/chapter-restructure.md 第 3.2 條：改標後的 fixture／golden
// 要以 config/chapterPlan.js 的定案清單驗證，而 config/chapters.js 要等 CH-A 合入才換成新清單。
// 所以各支 validate*() 多收一個選用的 { chapters }（{ 科目: 章節[] }），測試可以用**同一套閘門規則**
// 驗證「CH-A 合入之後」的狀態——不必在測試裡另抄一份閘門，也不必放寬既有的閘門。
// ─────────────────────────────────────────────────────────────

const chapters = require('../../config/chapters');
const { PLAN_CHAPTERS } = require('../../config/chapterPlan');

/**
 * 取得章節閘門。
 * @param {Record<string, string[]>|null|undefined} injected 注入的 { 科目: 章節[] }；未給時用 config/chapters.js
 * @returns {{isValidSubject:(s:string)=>boolean, isValidChapter:(s:string,c:string)=>boolean, source:string}}
 * @throws 注入的不是「科目 → 字串陣列」時丟錯（打錯形狀不該靜默變成「全部不合法」或「全部合法」）
 */
function chapterGate(injected) {
    if (injected === undefined || injected === null) {
        return {
            isValidSubject: chapters.isValidSubject,
            isValidChapter: chapters.isValidChapter,
            source: 'config/chapters.js'
        };
    }
    if (typeof injected !== 'object' || Array.isArray(injected)) {
        throw new Error('chapterGate：注入的 chapters 必須是 { 科目: 章節[] } 物件。');
    }
    for (const [subject, list] of Object.entries(injected)) {
        if (!Array.isArray(list) || list.some(c => typeof c !== 'string')) {
            throw new Error(`chapterGate：注入的 chapters「${subject}」必須是字串陣列。`);
        }
    }
    const has = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(injected, s);
    return {
        isValidSubject: (s) => has(s),
        isValidChapter: (s, c) => has(s) && injected[s].includes(c),
        source: '注入'
    };
}

/**
 * 「CH-A 合入之後」的三科章節：數學、物理取 config/chapterPlan.js 的 PLAN_CHAPTERS，
 * 化學取 config/chapters.js（化學不在這次重整範圍內，docs/chapter-restructure.md 第 1 條）。
 * CH-A 合入後這份清單會與 config/chapters.js 的 CHAPTERS 逐字相同。
 * @returns {Record<string, string[]>} 新陣列，呼叫端可以自由修改
 */
function plannedChapters() {
    return {
        '數學': PLAN_CHAPTERS['數學'].slice(),
        '物理': PLAN_CHAPTERS['物理'].slice(),
        '化學': (chapters.CHAPTERS['化學'] || []).slice()
    };
}

module.exports = { chapterGate, plannedChapters };
