// agents/promptParts.js — extract／classify 共用的 prompt 片段（擁有者：WS-B）
//
// 這裡最重要的一件事：**章節白名單只有 config/chapters.js 一份**。
// 現況 services/aiService.js:14-27 把 34+32 個章節名手抄進 prompt，與 config/chapters.js
// 是兩份會各自漂移的真相；A-T8 把那一份刪掉，改成呼叫本檔的 chapterWhitelistText()。
// WS-D 的單元測試會斷言「prompt 內出現的章節集合 === CHAPTERS」。
//
// 分冊標題（第一冊、選修物理二…）刻意**不寫**：config/chapters.js 只有「科 → 章節陣列」
// 這一層結構，分冊資訊在那裡不存在，硬要在 prompt 裡補一份就又是一份會漂的真相。

//
// 〔stage5 WS-B〕化學併入 config/chapters.js 之後（docs/interfaces-stage5.md 第 3.2 條）：
//   - chapterWhitelistText() 沒指定科目時**只列數學與物理**（LEGACY_SUBJECTS）——它進的是
//     extract.v2 這些既有 prompt，多列一科就不是錄 cassette 時送出去的那段文字了。
//     化學卷一律明確傳 '化學'。
//   - CHEM_LATEX_RULES：化學卷專用的化學式寫法（mhchem 的 \ce{…}），只進化學模板。
//   - resolveSubjectGroup()：各 agent 決定走數學／物理路徑還是化學路徑的唯一判準（ADR-010）。
//
// 〔章節重整 CH-A〕2026-09-25（docs/chapter-restructure.md 第 3.1 條第 5 點）：數學／物理的白名單
// 換成 config/chapterPlan.js 定案的 52＋34 章。本檔一直是從 CHAPTERS 動態產生白名單文字，所以不必改程式：
// chapterWhitelistText() 沒指定科目時就列出新的兩科清單（「共 52 章」「共 34 章」）。
// 這段文字進的是 extract.v2／classify.v1 等既有 prompt，對應的 cassette 本來就要依第 5 條重錄。

const { CHAPTERS, QUESTION_TYPES, LEGACY_SUBJECTS, subjectGroupOf, isValidSubject } = require('../config/chapters');

/**
 * 產生章節白名單的 prompt 文字。
 * @param {string|null} subject 給了就只列該科；null 列數學與物理兩科（〔stage5 WS-B〕不含化學）
 * @returns {string}
 */
function chapterWhitelistText(subject = null) {
    const subjects = subject ? [subject] : LEGACY_SUBJECTS;
    return subjects
        .filter(s => Array.isArray(CHAPTERS[s]))
        .map(s => `【${s}科精細章節白名單（共 ${CHAPTERS[s].length} 章）】\n${joinChapters(CHAPTERS[s])}`)
        .join('\n\n');
}

/**
 * 章節以頓號串接。〔stage5 WS-B〕化學有一章叫「醇、酚、醚」，章名本身含頓號，
 * 直接串接會讓模型看成三章——該科只要有任一章名含頓號，就改成每章加「」。
 * 數學與物理沒有這種章名，輸出與階段 5 之前逐字相同。
 * @param {string[]} list
 * @returns {string}
 */
function joinChapters(list) {
    return list.some(c => c.includes('、')) ? list.map(c => `「${c}」`).join('、') : list.join('、');
}

/** 題型白名單（五種，含「證明」——現況的 prompt 只列了四種，漏掉證明題） */
function questionTypeText() {
    return `【題型白名單】\n${QUESTION_TYPES.join('、')}`;
}

/**
 * LaTeX 書寫規範。逐條沿用現況 aiService.js 的敘述——它是既有題庫的實際格式，
 * 一改，新舊題目的公式風格就會分岔，utils/formulaFix 的規則也會對不上。
 */
const LATEX_RULES = `【數學公式格式規範，務必嚴格遵守】
(1) 所有數學／物理式子、變數、符號都必須用 LaTeX 撰寫，並用單一錢號 $...$ 包起來（行內公式），例如：圓方程式寫成 $x^2+y^2=r^2$、速度寫成 $v_0$、希臘字母寫成 $\\theta$、$\\alpha$。
(2) 分數一律用 $\\frac{分子}{分母}$（例如 $\\frac{\\pi}{2}$、$\\frac{16}{3}$），絕對禁止用斜線如 π/2 或 16/3。
(3) 次方用 ^、下標用 _（例如 $x^2$、$a_{n+1}$）；根號用 $\\sqrt{...}$；積分 $\\int_a^b$；級數 $\\sum_{n=1}^{\\infty}$；三角函數 $\\sin\\theta$。
(4) 請使用 LaTeX 指令而非 Unicode 符號（用 $\\times$ 而非 ×、用 $\\leq$ 而非 ≤、用 $\\theta$ 而非 θ），中文敘述文字則維持中文、不要包進 $ $。`;

/**
 * 化學式書寫規範（〔stage5 WS-B〕只進化學模板；DEC-019、ADR-010）。
 *
 * 寫法以 MathJax 的 mhchem 擴充為準——網頁端 index.html 明確載入 mhchem，
 * Word 端由 utils/textFormatter.js 把 \ce{…} 的子集轉成 OMML（docs/chemistry.md 第 3 節）。
 * 這裡列的語法就是那個子集，**不要**在 prompt 裡要求模型用子集以外的寫法。
 */
const CHEM_LATEX_RULES = `【化學式與方程式格式規範，務必嚴格遵守】
(1) 化學式、離子與反應式一律用 mhchem 的 \\ce{…} 撰寫，並用 $…$ 包起來，例如 $\\ce{H2SO4}$、$\\ce{Fe^{3+}}$、$\\ce{SO4^{2-}}$、$\\ce{2H2 + O2 -> 2H2O}$。
(2) 下標直接寫數字（\\ce{H2O}、\\ce{Ca(OH)2}）；離子電荷一律用 ^ 寫在右上並加大括號（\\ce{Ca^{2+}}、\\ce{NO3^-}）；絕對禁止用 Unicode 上下標（H₂O、Ca²⁺）。
(3) 反應箭頭：單向用 ->、可逆用 <=>；箭頭上下的反應條件寫成 ->[上方][下方]（例如 \\ce{->[\\Delta]}、\\ce{->[MnO2]}）。物態緊接在化學式後面寫 (s)、(l)、(g)、(aq)；生成氣體寫 ^、生成沉澱寫 v（前後各留一個空白）；結晶水用句點（\\ce{CuSO4.5H2O}）。
(4) 數值計算、分數、次方與科學記號用 LaTeX 並包在 $…$ 裡（$\\frac{1}{2}$、$6.02\\times10^{23}$、$K_c$），分數一律用 \\frac，不要用斜線；單位用 \\mathrm{…}（$0.10\\ \\mathrm{M}$、$22.4\\ \\mathrm{L}$）。
(5) 請使用 LaTeX 指令而非 Unicode 符號（用 $\\times$ 而非 ×、用 $\\Delta$ 而非 Δ、用 $\\leq$ 而非 ≤）；中文敘述維持中文，不要包進 $ $；也不要用 Markdown 或 HTML。`;

/**
 * 決定這一次呼叫走數學／物理路徑還是化學路徑（〔stage5 WS-B〕ADR-010）。
 *
 * 判準由強到弱，第一個有答案的就用：
 *   1. input.subject 是合法科目 → 由科目決定（化學 → chemistry；數學、物理 → math_physics）。
 *      科目是題目本身的屬性，比卷別精準：化學題的變式（variant job）不必另外標卷別也走化學路徑。
 *   2. ctx.jq.payload.extract.subject（逐題節點：lint、verify 的 input 沒有 subject）。
 *   3. ctx.job.subject_group（上傳時老師選的卷別；extract 只有這一個訊號）。
 *   4. 都沒有 → math_physics（既有呼叫端與 cassette 走的路徑）。
 *
 * @param {object} ctx   第 3.1 條的 Ctx
 * @param {object} [input]
 * @returns {'math_physics'|'chemistry'}
 */
function resolveSubjectGroup(ctx, input) {
    const own = input && input.subject;
    if (isValidSubject(own)) return subjectGroupOf(own);
    const extracted = ctx && ctx.jq && ctx.jq.payload && ctx.jq.payload.extract && ctx.jq.payload.extract.subject;
    if (isValidSubject(extracted)) return subjectGroupOf(extracted);
    const group = ctx && ctx.job && ctx.job.subject_group;
    return group === 'chemistry' ? 'chemistry' : 'math_physics';
}

module.exports = { chapterWhitelistText, questionTypeText, LATEX_RULES, CHEM_LATEX_RULES, resolveSubjectGroup };
