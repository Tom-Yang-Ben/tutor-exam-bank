// agents/promptParts.js — extract／classify 共用的 prompt 片段（擁有者：WS-B）
//
// 這裡最重要的一件事：**章節白名單只有 config/chapters.js 一份**。
// 現況 services/aiService.js:14-27 把 34+32 個章節名手抄進 prompt，與 config/chapters.js
// 是兩份會各自漂移的真相；A-T8 把那一份刪掉，改成呼叫本檔的 chapterWhitelistText()。
// WS-D 的單元測試會斷言「prompt 內出現的章節集合 === CHAPTERS」。
//
// 分冊標題（第一冊、選修物理二…）刻意**不寫**：config/chapters.js 只有「科 → 章節陣列」
// 這一層結構，分冊資訊在那裡不存在，硬要在 prompt 裡補一份就又是一份會漂的真相。

const { CHAPTERS, SUBJECTS, QUESTION_TYPES } = require('../config/chapters');

/**
 * 產生章節白名單的 prompt 文字。
 * @param {string|null} subject 給了就只列該科；null 列兩科
 * @returns {string}
 */
function chapterWhitelistText(subject = null) {
    const subjects = subject ? [subject] : SUBJECTS;
    return subjects
        .filter(s => Array.isArray(CHAPTERS[s]))
        .map(s => `【${s}科精細章節白名單（共 ${CHAPTERS[s].length} 章）】\n${CHAPTERS[s].join('、')}`)
        .join('\n\n');
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

module.exports = { chapterWhitelistText, questionTypeText, LATEX_RULES };
