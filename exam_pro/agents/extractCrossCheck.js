// agents/extractCrossCheck.js — 本機拆題的交叉驗證（docs/local-mode.md 第 4 條第 3.4 點，擁有者：L2）
//
// 同一塊考卷由兩條獨立的路各拆一次：
//   視覺版：視覺模型直接看頁面 PNG（agent extract_vision）
//   OCR 版：PaddleOCR 先辨識成 Markdown，再由純文字模型整理成同一份 schema（agent extract_ocr）
// 本檔把兩份題目清單「對齊、比較、合併」，每題標上
//   cross_check: { status, similarity, alt_question_text, picked }
//     status             'agree'｜'disagree'｜'vision_only'｜'ocr_only'
//     similarity         兩版題幹的相似度（0～1，四捨五入到小數 4 位）；只有一版時為 null
//     alt_question_text  沒被採用的那一版題幹（給複核頁對照）；只有一版時為 null
//     picked             'vision'｜'ocr'：最後採用哪一版（契約外的附加鍵，稽核與 eval 用）
// status ≠ 'agree' 的題，workers/jobRunner.js 會讓它照常走完後續節點、最後停在
// needs_review('extract_disagree')，絕不自動入庫（原則 6：誠實的品質訊號）。
//
// ── 相似度 ──
//   兩版題幹各自經 utils/normalizeStem 正規化（去附圖描述、NFKC、選項代號統一、去 $、去空白、小寫），
//   再取「字元 bigram 集合」的 Jaccard：|A∩B| / |A∪B|。正規化後不足兩個字時，相同＝1、不同＝0。
//
// ── 兩個門檻（常數）──
//   AGREE_THRESHOLD = 0.85：配成一對之後，相似度 ≥ 0.85 才算「兩版一致」（agree），否則 disagree。
//     0.85 是契約的預設值。量級上的意義：一道 100 字的題目，兩版差 3～4 個字（約 7～8 個 bigram 不同）
//     就會掉到 0.85 附近——OCR 的錯字、公式寫法不同（\dfrac 與 \frac）都會被算進去。
//     寧可多送幾題去複核，也不讓「兩個引擎讀出不同內容」的題自動入庫。
//   MATCH_MIN = 0.5：低於這個值的兩題**不配對**（視為兩道不同的題，各自變成 vision_only／ocr_only）。
//     同一份考卷的不同題目常共用「下列何者」「選項」之類的字，bigram Jaccard 大約落在 0.1～0.4；
//     同一題被兩個引擎各讀一次，就算錯字不少也多在 0.6 以上。0.5 是兩者之間的分界。
//
// ── 對齊 ──
//   依順序＋相似度：兩份清單做一次保序的動態規劃（類似 LCS），在「配對的兩題相似度 ≥ MATCH_MIN」
//   的前提下讓配對相似度總和最大；不能交叉配對（題目在紙上的順序兩版應該一樣）。
//   沒配到的題留在原本的位置：同一個空隙裡，視覺版的題排在 OCR 版前面。
//
// ── 合併（兩版都在時）──
//   1. 只有一版能通過 schema 驗證（isValid）→ 用那一版。
//   2. 兩版都合格 → 採「公式能通過 utils/textFormatter 的 parseLatexStrict」的那一版
//      （題幹與答案都要過）；兩版都過、或兩版都不過，一律採視覺版。
//   3. 採 OCR 版時，附圖欄位（figure_desc／figure_page／figure_box）仍取視覺版的：
//      只有視覺模型看得到圖，OCR 版的結構化模型被要求不要輸出這三欄。
//   4. 兩版都不合格 → 這一格沒有題目（question=null），由呼叫端記進 rejected。
//
// 純函式：無 I/O、無時間、無隨機、不讀 process.env；輸入不會被改動。

const { normalizeStem } = require('../utils/normalizeStem');
const { parseLatexStrict } = require('../utils/textFormatter');

/** 兩版一致的門檻（契約預設 0.85）——相似度 ≥ 它才是 agree */
const AGREE_THRESHOLD = 0.85;
/** 配對下限——低於它的兩題不配對（見檔頭） */
const MATCH_MIN = 0.5;
/** cross_check.status 的四個值 */
const STATUSES = Object.freeze(['agree', 'disagree', 'vision_only', 'ocr_only']);
/** 採 OCR 版時仍取視覺版的附圖欄位 */
const FIGURE_FIELDS = Object.freeze(['figure_desc', 'figure_page', 'figure_box']);

const EPS = 1e-12;

/** 字串 → 字元 bigram 集合（以 code point 切，中文與 emoji 都不會被切半） */
function bigrams(s) {
    const chars = Array.from(String(s || ''));
    const out = new Set();
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    return out;
}

/**
 * 兩段題幹的相似度（normalizeStem 後的字元 bigram Jaccard）。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0～1
 */
function stemSimilarity(a, b) {
    return similarityOf(prepare(a), prepare(b));
}

/** 題幹 → { norm, grams }（對齊時每題只正規化一次） */
function prepare(text) {
    const norm = normalizeStem(typeof text === 'string' ? text : '');
    return { norm, grams: bigrams(norm) };
}

/** 兩份 prepare() 的結果 → Jaccard。兩邊都空＝0（兩個空題幹不構成「一致」的證據） */
function similarityOf(a, b) {
    if (a.grams.size === 0 || b.grams.size === 0) return a.norm !== '' && a.norm === b.norm ? 1 : 0;
    let inter = 0;
    for (const g of a.grams) if (b.grams.has(g)) inter += 1;
    return inter / (a.grams.size + b.grams.size - inter);
}

/** 四捨五入到小數 4 位（寫進 payload 的值與判定用的值是同一個，避免 0.84996 顯示成 0.85 卻判 disagree） */
function round4(x) {
    return Math.round(x * 10000) / 10000;
}

/**
 * 保序對齊。
 * @param {string[]} visionTexts
 * @param {string[]} ocrTexts
 * @param {{matchMin?:number}} [opts]
 * @returns {Array<{v:number|null, o:number|null, similarity:number|null}>} 依紙上順序
 */
function alignQuestions(visionTexts, ocrTexts, { matchMin = MATCH_MIN } = {}) {
    const V = Array.isArray(visionTexts) ? visionTexts : [];
    const O = Array.isArray(ocrTexts) ? ocrTexts : [];
    const n = V.length;
    const m = O.length;

    const pv = V.map(prepare);
    const po = O.map(prepare);
    const sim = [];
    for (let i = 0; i < n; i++) {
        sim.push([]);
        for (let j = 0; j < m; j++) sim[i].push(round4(similarityOf(pv[i], po[j])));
    }

    // dp[i][j]：V 的前 i 題與 O 的前 j 題的最佳配對相似度總和
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            let best = Math.max(dp[i - 1][j], dp[i][j - 1]);
            const s = sim[i - 1][j - 1];
            if (s >= matchMin) best = Math.max(best, dp[i - 1][j - 1] + s);
            dp[i][j] = best;
        }
    }

    // 回溯：優先序 配對 > 略過 OCR 題 > 略過視覺題（反轉後，同一個空隙裡視覺版的題排在前面）
    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const s = sim[i - 1][j - 1];
            if (s >= matchMin && Math.abs(dp[i][j] - (dp[i - 1][j - 1] + s)) < EPS) {
                ops.push({ v: i - 1, o: j - 1, similarity: s });
                i -= 1; j -= 1;
                continue;
            }
        }
        if (j > 0 && (i === 0 || Math.abs(dp[i][j] - dp[i][j - 1]) < EPS)) {
            ops.push({ v: null, o: j - 1, similarity: null });
            j -= 1;
            continue;
        }
        ops.push({ v: i - 1, o: null, similarity: null });
        i -= 1;
    }
    return ops.reverse();
}

/** 題幹與答案的公式都能通過 parseLatexStrict */
function formulaOk(q) {
    if (!q || typeof q !== 'object') return false;
    for (const field of ['question_text', 'answer_text']) {
        const v = q[field];
        if (typeof v !== 'string') return false;
        if (!parseLatexStrict(v).ok) return false;
    }
    return true;
}

function textOf(q) {
    return q && typeof q.question_text === 'string' ? q.question_text : null;
}

/** 採 OCR 版時補上視覺版的附圖欄位（視覺版有才補；OCR 版自己的附圖欄位一併換掉） */
function withVisionFigure(ocrQ, visionQ) {
    const out = { ...ocrQ };
    const hasVisionFigure = visionQ && FIGURE_FIELDS.some(f => visionQ[f] !== undefined);
    if (!hasVisionFigure) return out;
    for (const f of FIGURE_FIELDS) delete out[f];
    if (typeof visionQ.figure_desc === 'string' && visionQ.figure_desc.trim()) out.figure_desc = visionQ.figure_desc;
    if (visionQ.figure_page !== undefined && visionQ.figure_box !== undefined) {
        out.figure_page = visionQ.figure_page;
        out.figure_box = Array.isArray(visionQ.figure_box) ? visionQ.figure_box.slice() : visionQ.figure_box;
    }
    return out;
}

/**
 * 交叉驗證並合併。
 *
 * @param {Array<object>} visionQs  視覺版的題目（已經過 agents/extract.js 的 normalizeElement）
 * @param {Array<object>|null} ocrQs OCR 版的題目；null／undefined＝OCR 沒跑（OCR_ENGINE=none），全部標 vision_only
 * @param {{isValid?:(q:object, source:'vision'|'ocr')=>boolean, agreeThreshold?:number, matchMin?:number}} [opts]
 *        isValid：該版能不能用（schema 驗證）。沒給＝一律可用。
 * @returns {Array<{status:string, similarity:number|null, picked:'vision'|'ocr'|null,
 *                  vision:object|null, ocr:object|null, question:object|null}>}
 *          依紙上順序，一格一題。question 是合併後的題目（多一個 cross_check 欄位）；
 *          兩版都不合格時 question 為 null、picked 為 null。
 */
function crossCheck(visionQs, ocrQs, opts = {}) {
    const isValid = typeof opts.isValid === 'function' ? opts.isValid : () => true;
    const agreeThreshold = Number.isFinite(opts.agreeThreshold) ? opts.agreeThreshold : AGREE_THRESHOLD;
    const matchMin = Number.isFinite(opts.matchMin) ? opts.matchMin : MATCH_MIN;
    const V = Array.isArray(visionQs) ? visionQs : [];
    const ocrOff = ocrQs === null || ocrQs === undefined;
    const O = Array.isArray(ocrQs) ? ocrQs : [];

    const ops = ocrOff
        ? V.map((_, v) => ({ v, o: null, similarity: null }))
        : alignQuestions(V.map(textOf), O.map(textOf), { matchMin });

    return ops.map(({ v, o, similarity }) => {
        const vq = v === null ? null : V[v];
        const oq = o === null ? null : O[o];
        const vOk = vq !== null && isValid(vq, 'vision');
        const oOk = oq !== null && isValid(oq, 'ocr');

        let status;
        if (vq && oq) status = similarity >= agreeThreshold ? 'agree' : 'disagree';
        else status = vq ? 'vision_only' : 'ocr_only';

        let picked = null;
        if (vOk && oOk) picked = formulaOk(vq) || !formulaOk(oq) ? 'vision' : 'ocr';
        else if (vOk) picked = 'vision';
        else if (oOk) picked = 'ocr';

        let question = null;
        if (picked) {
            const base = picked === 'vision' ? { ...vq } : withVisionFigure(oq, vq);
            const other = picked === 'vision' ? oq : vq;
            question = {
                ...base,
                cross_check: {
                    status,
                    similarity: vq && oq ? similarity : null,
                    alt_question_text: other ? textOf(other) : null,
                    picked
                }
            };
        }
        return { status, similarity: vq && oq ? similarity : null, picked, vision: vq, ocr: oq, question };
    });
}

/**
 * 各 status 的題數（給 extract 事件與 report 用）。
 * @param {Array<{status:string, question:object|null}>} slots crossCheck 的回傳
 */
function summarize(slots) {
    const counts = { agree: 0, disagree: 0, vision_only: 0, ocr_only: 0 };
    for (const s of slots || []) {
        if (s && s.question && Object.prototype.hasOwnProperty.call(counts, s.status)) counts[s.status] += 1;
    }
    return counts;
}

module.exports = {
    crossCheck, alignQuestions, stemSimilarity, formulaOk, summarize, bigrams,
    AGREE_THRESHOLD, MATCH_MIN, STATUSES, FIGURE_FIELDS
};
