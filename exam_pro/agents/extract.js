// agents/extract.js — 拆題節點（A-T8；docs/interfaces-stage2.md 第 3.1／3.3 條）
//
//   input  : { jobId, pdfPath, chunk:{ no, fromPage, toPage } }   agent 自己讀檔切塊
//   outcome: {kind:'pass', data:{questions:[…], rejected:[…], …}}
//            {kind:'fail', reason:'schema_invalid'}     整包元素都不合格才走這裡
//            {kind:'error', errorClass:…}               供應商掛掉／逾時
//
// 三件與現況（services/aiService.js 一個巨型 prompt、一次呼叫整份 PDF）不同的事：
//
// 1. **切塊**：超過 JOB_PDF_CHUNK_PAGES 頁就用 pdf-lib 切開，一塊一次呼叫。
//    切塊的理由不是「輸入塞不下」（20 頁 ≈ 10.6k token，離上限很遠），而是
//    **失敗重試的粒度**與**輸出不被截斷**：80 頁一次送，一次 schema_invalid 就要重付 80 頁的錢
//    （裁決 S0-3）。
//
// 2. **逐元素驗證**：ajv 一題一題驗，合格的進 data.questions、不合格的只記進 data.rejected。
//    現況是「一題壞、整批 400」（根目錄 README 的「設計決策 2」自承的問題）。
//
// 3. **白名單只有一份**：章節從 config/chapters.js 經 agents/promptParts.js 產生，
//    schema 的 enum 也從同一處注入（第 3.4 條）。aiService.js 手抄的那一份已刪除。
//
// 〔stage5 WS-B〕卷別分流（docs/interfaces-stage5.md 第 4.2 條、ADR-010）：ctx.job.subject_group
// 為 'chemistry' 時改用化學的 agent 名、模板與 schema（下方 VARIANTS.chemistry）；
// 其餘情況（含 services/aiService.js 的相容包裝，它沒有 ctx.job）走原本的數學／物理路徑，逐位元不變。
//
// 〔本機模式 L2〕docs/local-mode.md 第 4 條：MODEL_EXTRACT 的 vendor 是 ollama 時改走本機路徑
// （PaddleOCR＋視覺模型交叉驗證，見下方「本機路徑」兩段與 agents/extractCrossCheck.js）；
// 其餘 vendor 走原路徑，送出的 prompt、schema、cassette 鍵逐位元不變。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');
const { PDFDocument } = require('pdf-lib');

const { buildSchema } = require('./schemas');
const { chapterWhitelistText, questionTypeText, LATEX_RULES, CHEM_LATEX_RULES, resolveSubjectGroup } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');
const { crossCheck, summarize: summarizeCrossCheck } = require('./extractCrossCheck');

const TEMPLATE = 'extract.v2';   // v2（2026-09-15）：加【表格】規範，見 docs/formulas.md §2

// 預設值與 .env.example 一致；agent 不讀 process.env（第 3.1 條），
// 這些只是 ctx.config.thresholds 沒帶到時的保底。
const DEFAULT_CHUNK_PAGES = 20;
const DEFAULT_INLINE_MAX_BYTES = 15728640;

const SYSTEM = '你是一位資深的台灣高中數學與物理家教老師，正在把一份考卷數位化進題庫。你只輸出 JSON，不輸出任何其他文字。';

// 模板原文＝把可變欄位挖空後的字串（第 5.2 條的 promptTemplateHash 就是它的 sha256）。
// {{CHAPTER_WHITELIST}} 與 {{QUESTION_TYPES}} 保持挖空狀態：章節改了會讓 schema 的 enum 改，
// schemaHash 已經會讓 cassette 失效，不需要在這裡再算一次。
const PROMPT_TEMPLATE = `請細心閱讀這份 PDF，找出裡面「所有的」題目，每一題各自拆解成一個 JSON 物件。

{{CHAPTER_WHITELIST}}
（白名單依冊別分組列出；「第一冊」「選修物理一」這類冊名只是分組標題，不是章名。）

{{QUESTION_TYPES}}

【chapter 欄位】必須「完全等於」白名單裡的某一個字串，不得自己發明新名詞、不得只寫分冊名。
【chapter_confidence 欄位】是你對該章節的把握程度（0~1）。這個數字會決定要不要再花一次錢請另一個模型重判，請誠實給分——不確定就給低分。

${LATEX_RULES}

【表格】考卷裡的資料表（例如各星球的質量與半徑、統計次數表）屬於題目文字，放在 question_text，不要寫成 figure_desc。一律寫成 LaTeX 的 array 環境，整個表格放在同一對 $$…$$ 裡，可以跨行：例如 $$\\begin{array}{|c|c|c|} \\hline & \\text{甲} & \\text{乙} \\\\ \\hline \\text{質量} & m & 4m \\\\ \\hline \\end{array}$$。列以 \\\\ 分隔、欄以 & 分隔，框線用欄位格式 {|c|c|} 與 \\hline，中文儲存格用 \\text{…} 包住。不要用 Markdown 表格、tabular 或空白對齊。

【附圖與幾何圖形】請仔細觀察考卷中的所有附圖、幾何圖形或圖表。你無法匯出圖片，所以請把該圖的「解題關鍵視覺資訊」（精確的座標點、邊長、角度、函數曲線趨勢、物體受力方向、電路連接方式等）寫成文字，放進該題的 figure_desc 欄位。**不要**寫進 question_text。同時回報附圖的位置，讓系統把圖裁下來存檔：figure_page 是附圖所在頁碼（從你收到的這份 PDF 的第 1 頁數起），figure_box 是該頁上剛好框住整張圖的 [ymin, xmin, ymax, xmax]（0–1000 正規化座標，頁面左上角為原點），不要框到題目文字。沒有附圖的題目，figure_desc、figure_page、figure_box 三個欄位都不要輸出。

【題目順序】依照題目在紙上出現的先後順序輸出，不要重排、不要合併、不要漏題。同一大題底下的 (1)(2)(3) 若各自有獨立答案，請拆成獨立的題目。`;

registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

// ───────────────────── 化學卷（〔stage5 WS-B〕DEC-019、ADR-010）─────────────────────
//
// jobs.subject_group = 'chemistry' 的卷走這一組：新的 agent 名（cassette 子目錄 extract_chem）、
// 新的模板、化學值域的 schema（subject 只能是化學、chapter 是化學 44 章）。
// 上面數學／物理的 SYSTEM、PROMPT_TEMPLATE、schema **一個字都沒動**（第 1.1 條）。
// 註冊字串 = SYSTEM + '\n---\n' + 模板（第 1.2 條）：SYSTEM 一改，cassette 鍵就跟著變。

const AGENT_CHEM = 'extract_chem';
const TEMPLATE_CHEM = 'extract_chem.v1';

const SYSTEM_CHEM = '你是一位資深的台灣高中化學家教老師，正在把一份化學考卷數位化進題庫。你只輸出 JSON，不輸出任何其他文字。';

const PROMPT_TEMPLATE_CHEM = `請細心閱讀這份化學考卷 PDF，找出裡面「所有的」題目，每一題各自拆解成一個 JSON 物件。

{{CHAPTER_WHITELIST}}

{{QUESTION_TYPES}}

【subject 欄位】這是一份化學卷，subject 一律填「化學」。
【chapter 欄位】必須「完全等於」白名單裡某一個「」內的字串（連頓號在內，例如「醇、酚、醚」是一章），不得自己發明新名詞、不得只寫分冊名。判斷依據是「解這一題需要用到哪一章的觀念」，例如用平衡常數計算濃度的題目屬於「化學平衡與平衡常數」，即使題幹在講工業製程。
【chapter_confidence 欄位】是你對該章節的把握程度（0~1）。這個數字會決定要不要再花一次錢請另一個模型重判，請誠實給分——不確定就給低分。

${CHEM_LATEX_RULES}

【表格】考卷裡的資料表（例如各物質的熔點、實驗數據、濃度與速率的對照表）屬於題目文字，放在 question_text，不要寫成 figure_desc。一律寫成 LaTeX 的 array 環境，整個表格放在同一對 $$…$$ 裡，可以跨行：例如 $$\\begin{array}{|c|c|c|} \\hline \\text{實驗} & [\\ce{A}] & \\text{初速率} \\\\ \\hline 1 & 0.10 & 2.0\\times10^{-3} \\\\ \\hline \\end{array}$$。列以 \\\\ 分隔、欄以 & 分隔，框線用欄位格式 {|c|c|} 與 \\hline，中文儲存格用 \\text{…} 包住。不要用 Markdown 表格、tabular 或空白對齊。

【附圖、結構式與實驗裝置】你無法匯出圖片，所以請把附圖的「解題關鍵視覺資訊」寫成文字，放進該題的 figure_desc 欄位：實驗裝置的連接方式與各容器內的物質、有機分子的結構（寫出主鏈、官能基與取代位置）、滴定曲線或溶解度曲線的關鍵點座標與趨勢、能量圖的各能階高低。**不要**寫進 question_text。同時回報附圖的位置，讓系統把圖裁下來存檔：figure_page 是附圖所在頁碼（從你收到的這份 PDF 的第 1 頁數起），figure_box 是該頁上剛好框住整張圖的 [ymin, xmin, ymax, xmax]（0–1000 正規化座標，頁面左上角為原點），不要框到題目文字。沒有附圖的題目，figure_desc、figure_page、figure_box 三個欄位都不要輸出。

【週期表與常數】考卷附的週期表、原子量表或常數表不是題目，不要拆成題目；題目需要的原子量若只出現在那張表上，也不必抄進題幹。

【題目順序】依照題目在紙上出現的先後順序輸出，不要重排、不要合併、不要漏題。同一大題底下的 (1)(2)(3) 若各自有獨立答案，請拆成獨立的題目。`;

registerTemplate(TEMPLATE_CHEM, `${SYSTEM_CHEM}\n---\n${PROMPT_TEMPLATE_CHEM}`);

/** 卷別 → 這一組 agent 名、模板、SYSTEM、prompt 與 schema 選項 */
const VARIANTS = {
    math_physics: { agent: 'extract', template: TEMPLATE, system: SYSTEM, promptTemplate: PROMPT_TEMPLATE, subject: null, schemaOpts: undefined },
    chemistry: { agent: AGENT_CHEM, template: TEMPLATE_CHEM, system: SYSTEM_CHEM, promptTemplate: PROMPT_TEMPLATE_CHEM, subject: '化學', schemaOpts: { group: 'chemistry' } }
};

// ───────────────────── 本機路徑（〔本機模式 L2〕docs/local-mode.md 第 4 條第 3 點）─────────────────────
//
// MODEL_EXTRACT 的 vendor 是 ollama 時，一塊考卷分三步拆（上面 Gemini 的路徑一個字都沒動）：
//   1. OCR：services/ocr 的 ocrPdf（PaddleOCR PP-StructureV3）→ 每頁 Markdown（OCR_ENGINE=none 時略過）
//   2. 視覺版：視覺模型看「本塊每頁一張 PNG」（agent extract_vision／extract_vision_chem）
//   3. OCR 版：純文字模型（MODEL_OCR_STRUCTURE，未設＝MODEL_VERIFY）把 OCR 的 Markdown 整理成同一份 schema
//      （agent extract_ocr／extract_ocr_chem）
// 再由 agents/extractCrossCheck.js 對齊、比較、合併，每題帶 cross_check。
//
// 先跑 OCR 的理由：本機最容易沒裝好的是 PaddleOCR，先跑它可以在花二十分鐘跑視覺模型之前就失敗；
// 而且視覺版直接用 ocr_pdf.py 轉好的 PNG，兩個引擎看的是同一批像素。
//
// 模板＝把 Gemini 模板的段落拿來重組：開頭改成「附上的是頁面圖片／OCR 文字」、附圖那一段改成圖片版，
// 其餘段落（白名單、題型、章節、公式規範、表格、題序；化學卷另有 subject 與週期表）逐字沿用。
// 註冊字串＝SYSTEM + '\n---\n' + 模板（與化學模板同一個慣例：SYSTEM 一改，cassette 鍵就跟著變）。
// 頁碼與 OCR 文字是可變欄位：頁碼由 cacheKeyParts 的 chunkNo 決定、OCR 文字由 ocrSha256 決定。

const AGENT_VISION = 'extract_vision';
const AGENT_VISION_CHEM = 'extract_vision_chem';
const TEMPLATE_VISION = 'extract_vision.v1';
const TEMPLATE_VISION_CHEM = 'extract_vision_chem.v1';
const AGENT_OCR = 'extract_ocr';
const AGENT_OCR_CHEM = 'extract_ocr_chem';
const TEMPLATE_OCR = 'extract_ocr.v1';
// 契約只寫了 'extract_ocr.v1'；化學卷的模板內容不同（化學白名單與化學式規範），
// 同一個識別名不能註冊兩種內容（services/llm/templates.js 會丟錯），所以化學另取 'extract_ocr_chem.v1'。
const TEMPLATE_OCR_CHEM = 'extract_ocr_chem.v1';

/** 本機模型一次輸出的 token 上限：CPU 上一旦陷入重複輸出，沒有上限會一路寫到 num_ctx 用完（一兩個小時） */
const LOCAL_MAX_OUTPUT_TOKENS = 8192;

/** Gemini 模板切成段落（以空行分隔）；要改寫的段落找不到時 buildLocalTemplate 會在載入時丟錯，模板改版時立刻知道 */
function paragraphsOf(template) {
    return template.split('\n\n');
}

function mustReplace(text, from, to) {
    if (!text.includes(from)) throw new Error(`agents/extract.js：本機模板要改寫的字串「${from}」不在 Gemini 模板裡（模板改版了？）。`);
    return text.replace(from, to);
}

/** 附圖段落的圖片版：頁碼改成「第幾張圖片」、提醒 figure_box 先 y 後 x（Qwen 系列慣用 x 在前） */
function figureRuleForImages(paragraph) {
    let s = mustReplace(paragraph, '從你收到的這份 PDF 的第 1 頁數起', '從你收到的第 1 張圖片數起');
    s = mustReplace(s, '[ymin, xmin, ymax, xmax]（0–1000 正規化座標', '[ymin, xmin, ymax, xmax]（注意先 y 後 x；0–1000 正規化座標');
    return s.replace('該頁上剛好框住', '該張圖片上剛好框住');
}

const LOCAL_FIGURE_RULE_OCR = '【附圖】你看不到原卷的圖片，文字裡的「[圖]」只表示那裡有一張圖。figure_desc、figure_page、figure_box 三個欄位一律不要輸出（附圖由另一個看得到圖片的流程處理），也不要把「[圖]」抄進 question_text。';

const LOCAL_BOUNDARY_RULE = '【頁面邊界】最前面若有從上一頁延續過來、看不到題號開頭的殘段，不要輸出；最後一題若在最後一頁的底部被截斷，照樣輸出看得到的部分。';

const LOCAL_FIDELITY_VISION = '【照抄原卷】題目與選項一律照頁面上印的內容抄寫，不要自己補字、不要改寫題意；看不清楚的字依字形照抄，不要猜成別的內容。';

const LOCAL_FIDELITY_OCR = '【修正 OCR 錯誤】OCR 可能有錯字、漏字、公式辨識錯誤或把一個字拆成兩個：只依上下文修正「明顯的」辨識錯誤，不要補出原卷沒有的內容、不要改寫題意。數學式請整理成上面規範的 $…$ LaTeX；OCR 給的 HTML 表格請改寫成上面規範的 array。';

/**
 * 由 Gemini 模板組出本機模板。
 * @param {string} geminiTemplate  PROMPT_TEMPLATE 或 PROMPT_TEMPLATE_CHEM
 * @param {'vision'|'ocr'} kind
 * @param {string} paperWord       '考卷' 或 '化學考卷'
 */
function buildLocalTemplate(geminiTemplate, kind, paperWord) {
    const intro = kind === 'vision'
        ? `以下依序附上一份${paperWord}第 {{FROM_PAGE}}～{{TO_PAGE}} 頁的頁面圖片，每頁一張、共 {{PAGE_COUNT}} 張。請細心閱讀，找出這幾頁裡「所有的」題目，每一題各自拆解成一個 JSON 物件。`
        : `最後面附上一份${paperWord}第 {{FROM_PAGE}}～{{TO_PAGE}} 頁經 OCR 辨識出來的文字（Markdown；數學式已盡量轉成 $…$ 或 $$…$$ 的 LaTeX，表格可能是 HTML，「<!-- 第 N 頁 -->」是分頁標記）。請依這段文字找出「所有的」題目，每一題各自拆解成一個 JSON 物件。`;
    let sawIntro = false;
    let sawFigure = false;
    const body = paragraphsOf(geminiTemplate).map((p) => {
        if (p.startsWith('請細心閱讀')) { sawIntro = true; return intro; }
        if (p.startsWith('【附圖')) { sawFigure = true; return kind === 'vision' ? figureRuleForImages(p) : LOCAL_FIGURE_RULE_OCR; }
        return p;
    });
    if (!sawIntro || !sawFigure) throw new Error('agents/extract.js：Gemini 模板找不到開頭段或附圖段，無法組出本機模板。');
    body.push(LOCAL_BOUNDARY_RULE, kind === 'vision' ? LOCAL_FIDELITY_VISION : LOCAL_FIDELITY_OCR);
    return body.join('\n\n');
}

const LOCAL_VISION_TEMPLATE = buildLocalTemplate(PROMPT_TEMPLATE, 'vision', '考卷');
const LOCAL_VISION_TEMPLATE_CHEM = buildLocalTemplate(PROMPT_TEMPLATE_CHEM, 'vision', '化學考卷');
const LOCAL_OCR_TEMPLATE = buildLocalTemplate(PROMPT_TEMPLATE, 'ocr', '考卷');
const LOCAL_OCR_TEMPLATE_CHEM = buildLocalTemplate(PROMPT_TEMPLATE_CHEM, 'ocr', '化學考卷');

registerTemplate(TEMPLATE_VISION, `${SYSTEM}\n---\n${LOCAL_VISION_TEMPLATE}`);
registerTemplate(TEMPLATE_VISION_CHEM, `${SYSTEM_CHEM}\n---\n${LOCAL_VISION_TEMPLATE_CHEM}`);
registerTemplate(TEMPLATE_OCR, `${SYSTEM}\n---\n${LOCAL_OCR_TEMPLATE}`);
registerTemplate(TEMPLATE_OCR_CHEM, `${SYSTEM_CHEM}\n---\n${LOCAL_OCR_TEMPLATE_CHEM}`);

/** 卷別 → 本機路徑的兩組 agent／模板（system、subject、schemaOpts 與 Gemini 路徑的 VARIANTS 相同） */
const LOCAL_VARIANTS = {
    math_physics: {
        vision: { agent: AGENT_VISION, template: TEMPLATE_VISION, promptTemplate: LOCAL_VISION_TEMPLATE },
        ocr: { agent: AGENT_OCR, template: TEMPLATE_OCR, promptTemplate: LOCAL_OCR_TEMPLATE }
    },
    chemistry: {
        vision: { agent: AGENT_VISION_CHEM, template: TEMPLATE_VISION_CHEM, promptTemplate: LOCAL_VISION_TEMPLATE_CHEM },
        ocr: { agent: AGENT_OCR_CHEM, template: TEMPLATE_OCR_CHEM, promptTemplate: LOCAL_OCR_TEMPLATE_CHEM }
    }
};

/**
 * 本機模板的挖空欄位填起來。
 * @param {'math_physics'|'chemistry'} group
 * @param {'vision'|'ocr'} kind
 * @param {{fromPage:number, toPage:number}} range
 */
function buildLocalPrompt(group, kind, { fromPage, toPage }) {
    const g = LOCAL_VARIANTS[group] ? group : 'math_physics';
    const t = LOCAL_VARIANTS[g][kind];
    if (!t) throw new Error(`buildLocalPrompt：kind 只能是 vision／ocr，收到「${kind}」。`);
    return t.promptTemplate
        .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText(VARIANTS[g].subject))
        .replace('{{QUESTION_TYPES}}', questionTypeText())
        .replace(/\{\{FROM_PAGE\}\}/g, String(fromPage))
        .replace(/\{\{TO_PAGE\}\}/g, String(toPage))
        .replace(/\{\{PAGE_COUNT\}\}/g, String(toPage - fromPage + 1));
}

/** OCR 文字接在模板後面的包裝（分隔線讓模型分得清楚哪裡是指示、哪裡是考卷內容） */
function wrapOcrText(ocrText) {
    return `----- OCR 辨識結果開始 -----\n${ocrText}\n----- OCR 辨識結果結束 -----`;
}

// ───────────────────────── 純函式（可單獨測試）─────────────────────────

/**
 * 把模板的挖空欄位填起來，得到真正送出去的 prompt。
 * @param {'math_physics'|'chemistry'} [group] 〔stage5 WS-B〕沒給＝數學／物理（輸出與階段 5 之前逐字相同）
 */
function buildPrompt(group = 'math_physics') {
    const v = VARIANTS[group] || VARIANTS.math_physics;
    return v.promptTemplate
        .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText(v.subject))
        .replace('{{QUESTION_TYPES}}', questionTypeText());
}

/**
 * 依頁數切塊。
 * @param {number} pageCount
 * @param {number} chunkPages
 * @returns {Array<{no:number, fromPage:number, toPage:number}>}  1-based、兩端皆含
 */
function planChunks(pageCount, chunkPages) {
    const size = Number.isInteger(chunkPages) && chunkPages > 0 ? chunkPages : DEFAULT_CHUNK_PAGES;
    const total = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
    const chunks = [];
    for (let from = 1; from <= total; from += size) {
        chunks.push({ no: chunks.length + 1, fromPage: from, toPage: Math.min(from + size - 1, total) });
    }
    return chunks;
}

const FIGURE_RE = /\[附圖描述[：:][\s\S]*?\]/g;

/**
 * 防呆正規化：模型偶爾還是會把 [附圖描述：…] 寫進 question_text（現況的 prompt 就是這樣要求的，
 * 它的訓練資料裡到處都是）。把它挪回 figure_desc，讓 payload.extract.question_text
 * 真的「不含 [附圖描述：…]」（第 3.2 條）。
 */
function normalizeElement(el) {
    const out = { ...el };
    const text = String(out.question_text ?? '');
    const inline = text.match(FIGURE_RE);
    if (inline && inline.length) {
        const pulled = inline
            .map(s => s.replace(/^\[附圖描述[：:]\s*/, '').replace(/\]$/, '').trim())
            .filter(Boolean)
            .join('\n');
        out.question_text = text.replace(FIGURE_RE, '').replace(/\s+$/, '').trim();
        const existing = String(out.figure_desc ?? '').trim();
        out.figure_desc = existing ? `${existing}\n${pulled}` : pulled;
    }
    if (typeof out.question_text === 'string') out.question_text = out.question_text.trim();
    if (typeof out.answer_text === 'string') out.answer_text = out.answer_text.trim();
    if (typeof out.figure_desc === 'string') {
        const trimmed = out.figure_desc.trim();
        if (trimmed) out.figure_desc = trimmed;
        else delete out.figure_desc;      // 「沒有附圖時整個鍵不存在」（第 3.2 條）
    }
    // 附圖框：頁碼與 box 必須成對且幾何上合法（ymin<ymax、xmin<xmax），否則整組拿掉。
    // 這裡拿掉而不是讓 ajv 整題退件：框壞掉只該少一張圖，不該少一道題（docs/figures.md）。
    const boxOk = Array.isArray(out.figure_box) && out.figure_box.length === 4
        && out.figure_box.every(n => Number.isInteger(n) && n >= 0 && n <= 1000)
        && out.figure_box[0] < out.figure_box[2] && out.figure_box[1] < out.figure_box[3];
    if (!Number.isInteger(out.figure_page) || out.figure_page < 1 || !boxOk) {
        delete out.figure_page;
        delete out.figure_box;
    }
    return out;
}

/** 卷別 → 已編譯的 validator（〔stage5 WS-B〕化學卷的 subject／chapter 值域不同，各編一份） */
const itemValidators = new Map();
/** 逐元素驗證用的 validator（每個卷別只編譯一次；schema 是深凍結的，複製一份再交給 ajv） */
function getItemValidator(group = 'math_physics') {
    const key = VARIANTS[group] ? group : 'math_physics';
    if (itemValidators.has(key)) return itemValidators.get(key);
    const item = buildSchema('extract', VARIANTS[key].schemaOpts).properties.questions.items;
    // verbose: true 才會在 error 物件上帶 data（錯誤訊息要印出「模型回了什麼」給人看）
    const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    const validator = ajv.compile(JSON.parse(JSON.stringify(item)));
    itemValidators.set(key, validator);
    return validator;
}

/** ajv 的錯誤壓成人看得懂的短句（會進 job_events.detail 與複核畫面） */
function formatErrors(errors) {
    return (errors || []).map((e) => {
        const where = e.instancePath ? e.instancePath.replace(/^\//, '') : '(整筆)';
        if (e.keyword === 'enum') {
            return `${where}：「${e.data}」不在白名單內`;
        }
        if (e.keyword === 'required') {
            return `缺少必填欄位 ${e.params.missingProperty}`;
        }
        if (e.keyword === 'additionalProperties') {
            return `多了不該有的欄位 ${e.params.additionalProperty}`;
        }
        return `${where} ${e.message}`;
    });
}

/**
 * 對模型回來的整包資料做逐元素驗證。
 * @param {object} data      generateJson 的 data
 * @param {{chunkNo:number, fromPage:number, toPage:number}} chunk
 * @param {'math_physics'|'chemistry'} [group] 〔stage5 WS-B〕化學卷用化學值域驗證
 * @returns {{questions:Array<object>, rejected:Array<{idx:number, errors:string[]}>}}
 */
function validateElements(data, { chunkNo, fromPage, toPage }, group = 'math_physics') {
    const validate = getItemValidator(group);
    const list = Array.isArray(data && data.questions) ? data.questions : [];
    const questions = [];
    const rejected = [];

    list.forEach((element, position) => {
        // idx = chunk_no * 1000 + 題序（第 3.2 條）。題序取「陣列位置」而不是模型自己編的號碼：
        // 位置是確定性的，模型編的號碼會跳號、重號，UNIQUE (job_id, idx) 會撞。
        const idx = chunkNo * 1000 + position + 1;
        const normalized = normalizeElement(element && typeof element === 'object' ? element : {});
        if (!validate(normalized)) {
            rejected.push({ idx, errors: formatErrors(validate.errors) });
            return;
        }
        questions.push(toPayloadQuestion(normalized, idx, { chunkNo, fromPage, toPage }));
    });

    return { questions, rejected };
}

/**
 * 驗證過的元素 → payload.extract 的形狀（validateElements 與本機路徑共用；〔本機模式 L2〕自 validateElements 抽出，輸出逐位元不變）。
 * @param {object} normalized normalizeElement 的結果，且已通過 schema 驗證
 * @param {number} idx
 * @param {{chunkNo:number, fromPage:number, toPage:number}} chunk
 */
function toPayloadQuestion(normalized, idx, { chunkNo, fromPage, toPage }) {
    // figure_page 是「塊內頁碼」（模型只看得到切出來的那幾頁），這裡換算成整份 PDF 的
    // 絕對頁碼再往下傳（裁圖對整份 PDF 做）。換算後超出本塊範圍＝模型數錯頁，整組丟掉。
    const absFigurePage = Number.isInteger(normalized.figure_page)
        ? fromPage + normalized.figure_page - 1 : null;
    const hasFigureBox = absFigurePage !== null && absFigurePage <= toPage
        && Array.isArray(normalized.figure_box);

    return {
        idx,
        subject: normalized.subject,
        chapter: normalized.chapter,
        chapter_confidence: normalized.chapter_confidence,
        question_type: normalized.question_type,
        difficulty: normalized.difficulty,
        question_text: normalized.question_text,
        answer_text: normalized.answer_text,
        ...(normalized.figure_desc ? { figure_desc: normalized.figure_desc } : {}),
        ...(hasFigureBox ? { figure_page: absFigurePage, figure_box: normalized.figure_box } : {}),
        chunk_no: chunkNo,
        page_range: [fromPage, toPage]
    };
}

// ───────────────────────── PDF ─────────────────────────

/** 取出 fromPage~toPage（1-based、兩端皆含）成為一份新的 PDF；整份就是這一塊時原樣回傳 */
async function slicePdf(bytes, fromPage, toPage) {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = source.getPageCount();
    const from = Math.max(1, fromPage || 1);
    const to = Math.min(pageCount, toPage || pageCount);
    if (from === 1 && to === pageCount) return { bytes, pageCount };

    const target = await PDFDocument.create();
    const indices = [];
    for (let i = from - 1; i <= to - 1; i++) indices.push(i);
    const pages = await target.copyPages(source, indices);
    for (const page of pages) target.addPage(page);
    return { bytes: Buffer.from(await target.save()), pageCount };
}

function sha256Bytes(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function thresholdsOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    return {
        pdfChunkPages: Number.isInteger(t.pdfChunkPages) && t.pdfChunkPages > 0 ? t.pdfChunkPages : DEFAULT_CHUNK_PAGES,
        inlineMaxBytes: Number.isInteger(t.inlineMaxBytes) && t.inlineMaxBytes > 0 ? t.inlineMaxBytes : DEFAULT_INLINE_MAX_BYTES
    };
}

// ───────────────────────── 節點主體 ─────────────────────────

/**
 * @param {object} ctx   第 3.1 條的 Ctx
 * @param {{jobId?:number, pdfPath?:string, pdfBytes?:Buffer, chunk?:{no,fromPage,toPage}}} input
 *        pdfBytes 是給相容包裝（services/aiService.js）用的旁路：/analyze-pdf 收到的是
 *        base64 而不是檔案路徑，不必為了呼叫本 agent 先落一份暫存檔。
 * @returns {Promise<object>} outcome
 */
async function run(ctx, input = {}) {
    const logger = (ctx && ctx.logger) || console;
    try {
        const { pdfChunkPages, inlineMaxBytes } = thresholdsOf(ctx);

        let bytes = input.pdfBytes;
        if (!bytes) {
            if (!input.pdfPath) {
                return { kind: 'fail', reason: 'schema_invalid', feedback: 'extract：input 必須有 pdfPath 或 pdfBytes。' };
            }
            // 路徑可能含中文（期中專案-wsB），一律 path.resolve 後再讀
            bytes = fs.readFileSync(path.resolve(input.pdfPath));
        }

        const pdfSha256 = sha256Bytes(bytes);
        const chunk = input.chunk || {};
        const chunkNo = Number.isInteger(chunk.no) && chunk.no > 0 ? chunk.no : 1;

        const sliced = await slicePdf(bytes, chunk.fromPage, chunk.toPage);
        const fromPage = Math.max(1, chunk.fromPage || 1);
        const toPage = Math.min(sliced.pageCount, chunk.toPage || sliced.pageCount);

        // 〔本機模式 L2〕MODEL_EXTRACT 是 ollama → 本機路徑（OCR＋視覺模型交叉驗證）；
        // 其餘情況一律走下面的原路徑，送出的請求逐位元不變。inlineData 門檻是 Gemini 的限制，本機路徑不適用。
        if (isLocalExtract(ctx)) {
            return await runLocal(ctx, input, {
                bytes, pdfSha256, chunkNo, fromPage, toPage, pageCount: sliced.pageCount
            }, logger);
        }

        if (sliced.bytes.length > inlineMaxBytes) {
            // 裁決 S0-4：Files API 這條路在階段 2 不啟用（multer 的上限是同一個數字，實務上不會走到）。
            // 第 3.1 條要求 agent 不得 throw，所以改回 fail；extract 的 maxRetries 是 0，
            // 會直接落到 needs_review('provider_error') 而不是白白退避三次。
            return {
                kind: 'fail',
                reason: 'provider_error',
                feedback: 'PDF 超過 inlineData 門檻，Files API 路徑尚未啟用'
            };
        }

        // 〔stage5 WS-B〕卷別只看 ctx.job.subject_group（extract 沒有題目可看科目）。
        // math_physics 時 v 的每個欄位都等於階段 5 之前寫死的值，送出去的請求逐位元相同。
        const group = resolveSubjectGroup(ctx, input);
        const v = VARIANTS[group];
        const schema = buildSchema('extract', v.schemaOpts);
        const res = await ctx.llm.generateJson({
            model: (ctx.config && ctx.config.models && ctx.config.models.extract) || undefined,
            system: v.system,
            parts: [
                { pdfBase64: Buffer.from(sliced.bytes).toString('base64') },
                { text: buildPrompt(group) }
            ],
            schema,
            signal: ctx.signal,
            agent: v.agent,
            template: v.template,
            // 第 5.2 條：extract 的 cacheKeyParts 是 { template, chunkNo, pdfSha256 }，**不含 PDF 內容**
            cacheKeyParts: { template: v.template, chunkNo, pdfSha256 }
        });

        const { questions, rejected } = validateElements(res.data, { chunkNo, fromPage, toPage }, group);

        // 「整包都不合格才 fail」：有東西但一題都沒過 → schema_invalid；
        // 一題都沒有（封面頁、答案卡那種塊）不是失敗，照常 pass 一個空陣列。
        if (questions.length === 0 && rejected.length > 0) {
            return {
                kind: 'fail',
                reason: 'schema_invalid',
                feedback: `這一塊拆出 ${rejected.length} 題，全部沒通過 schema 驗證：${rejected[0].errors.join('；')}`,
                data: { questions: [], rejected, chunk_no: chunkNo, page_range: [fromPage, toPage], pdf_sha256: pdfSha256 }
            };
        }

        if (rejected.length) {
            logger.warn?.({ node: 'extract', chunk_no: chunkNo, rejected: rejected.length, msg: '部分元素未通過 schema 驗證，只丟掉那幾題' });
        }

        return {
            kind: 'pass',
            data: {
                questions,
                rejected,
                chunk_no: chunkNo,
                page_range: [fromPage, toPage],
                page_count: sliced.pageCount,
                pdf_sha256: pdfSha256,
                schema_fallback: res.schemaFallback === true,
                usage: res.usage,
                latency_ms: res.latencyMs
            }
        };
    } catch (err) {
        return {
            kind: 'error',
            errorClass: err.errorClass || 'provider_error',
            message: err.message
        };
    }
}

// ───────────────────────── 本機路徑（〔本機模式 L2〕）─────────────────────────

/** 測試可替換的外部相依（OCR、渲染、模式、OCR 設定）；正式執行時一律用 services/ 的實作 */
const localDepsOverride = {};

function localDeps() {
    return {
        ocrPdf: localDepsOverride.ocrPdf || ((opts) => require('../services/ocr').ocrPdf(opts)),
        renderPages: localDepsOverride.renderPages || ((opts) => require('../services/ocr/render').renderPages(opts)),
        llmMode: localDepsOverride.llmMode || (() => require('../services/llm').llmMode()),
        ocrConfig: localDepsOverride.ocrConfig || (() => require('../services/ocr').resolveOcrConfig())
    };
}

/** 測試用：替換（或以 {} 還原）本機路徑的外部相依 */
function _setLocalDepsForTest(overrides = {}) {
    for (const k of Object.keys(localDepsOverride)) delete localDepsOverride[k];
    Object.assign(localDepsOverride, overrides || {});
}

/**
 * 這一次要不要走本機路徑：MODEL_EXTRACT（ctx.config.models.extract，沒給就是 config/models.js 的預設）
 * 的 vendor 是 ollama。解析失敗一律走原路徑——原路徑會照舊在 generateJson 丟出同一個錯。
 * @param {object} ctx
 * @returns {boolean}
 */
function isLocalExtract(ctx) {
    try {
        const models = require('../config/models');
        const spec = (ctx && ctx.config && ctx.config.models && ctx.config.models.extract) || models.MODEL_EXTRACT;
        return models.parseModel(spec).vendor === 'ollama';
    } catch (_) {
        return false;
    }
}

function abortedError() {
    return Object.assign(new Error('extract：節點已被中止（逾時），不再進行後續步驟。'), { errorClass: 'timeout' });
}

function sumUsage(list) {
    const out = { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 };
    for (const u of list) {
        if (!u) continue;
        out.tokenIn += u.tokenIn ?? 0;
        out.tokenOut += u.tokenOut ?? 0;
        out.tokenThinking += u.tokenThinking ?? 0;
        out.tokenCached += u.tokenCached ?? 0;
    }
    return out;
}

/** 兩版都不合格（或唯一的一版不合格）那一格的錯誤訊息，前面標出是哪一版 */
function slotErrors(slot, validate) {
    const errors = [];
    for (const [label, q] of [['視覺版', slot.vision], ['OCR 版', slot.ocr]]) {
        if (!q) continue;
        if (!validate(q)) errors.push(...formatErrors(validate.errors).map(e => `${label}：${e}`));
    }
    return errors;
}

/**
 * 本機路徑本體（docs/local-mode.md 第 4 條第 3 點）。
 * @returns {Promise<object>} 與原路徑同形狀的 outcome；每題多一個 cross_check
 */
async function runLocal(ctx, input, { bytes, pdfSha256, chunkNo, fromPage, toPage, pageCount }, logger) {
    const deps = localDeps();
    const group = resolveSubjectGroup(ctx, input);
    const v = VARIANTS[group];
    const lv = LOCAL_VARIANTS[group];
    const schema = buildSchema('extract', v.schemaOpts);
    const models = (ctx && ctx.config && ctx.config.models) || {};
    const ocrCfg = (ctx && ctx.config && ctx.config.ocr) || {};
    const engine = ocrCfg.engine || deps.ocrConfig().engine;
    const replay = deps.llmMode() === 'replay';
    const signal = ctx && ctx.signal;
    const range = { fromPage, toPage };

    if (toPage < fromPage) {
        // 塊的起始頁已經超過 PDF 的總頁數（理論上不會發生）：沒有頁面可拆，照原路徑「空塊不是失敗」的慣例
        return {
            kind: 'pass',
            data: {
                questions: [], rejected: [], chunk_no: chunkNo, page_range: [fromPage, toPage], page_count: pageCount,
                pdf_sha256: pdfSha256, schema_fallback: false, usage: sumUsage([]), latency_ms: 0,
                cross_check_summary: { engine, engine_version: null, counts: summarizeCrossCheck([]) }
            }
        };
    }

    let ocr = null;
    try {
        // 1. OCR（OCR_ENGINE=none 時略過；replay 時讀 cassette、不需要 Python）
        if (engine !== 'none') {
            ocr = await deps.ocrPdf({ pdfBytes: bytes, pdfSha256, fromPage, toPage, signal });
        }
        if (signal && signal.aborted) throw abortedError();

        // 2. 視覺版。replay 不送圖片（cassette 鍵本來就不含圖片，回放時也可能根本沒有 Python 轉圖）
        let images = [];
        if (!replay) {
            const fromOcr = ocr && Array.isArray(ocr.pages) && ocr.pages.length > 0 && ocr.pages.every(p => p.imagePath);
            images = fromOcr
                ? ocr.pages.map(p => fs.readFileSync(p.imagePath))
                : await deps.renderPages({ pdfBytes: bytes, fromPage, toPage, dpi: ocrCfg.dpi || deps.ocrConfig().dpi });
        }
        const visionRes = await ctx.llm.generateJson({
            model: models.extract || undefined,
            system: v.system,
            parts: [
                { text: buildLocalPrompt(group, 'vision', range) },
                ...images.map(png => ({ inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } }))
            ],
            schema,
            maxOutputTokens: LOCAL_MAX_OUTPUT_TOKENS,
            signal,
            agent: lv.vision.agent,
            template: lv.vision.template,
            cacheKeyParts: { template: lv.vision.template, chunkNo, pdfSha256 }
        });
        images = null;   // 圖片的 base64 很大，送完就放掉
        if (signal && signal.aborted) throw abortedError();

        // 3. OCR 版
        let ocrRes = null;
        if (ocr) {
            const ocrText = require('../services/ocr').pagesToText(ocr.pages);
            const ocrSha256 = sha256Bytes(Buffer.from(ocrText, 'utf8'));
            ocrRes = await ctx.llm.generateJson({
                model: models.ocrStructure || models.verify || require('../config/models').MODEL_VERIFY,
                system: v.system,
                parts: [{ text: `${buildLocalPrompt(group, 'ocr', range)}\n\n${wrapOcrText(ocrText)}` }],
                schema,
                maxOutputTokens: LOCAL_MAX_OUTPUT_TOKENS,
                signal,
                agent: lv.ocr.agent,
                template: lv.ocr.template,
                cacheKeyParts: { template: lv.ocr.template, chunkNo, pdfSha256, ocrSha256 }
            });
        }

        // 4. 交叉驗證與合併
        const validate = getItemValidator(group);
        const toElements = (data) => (Array.isArray(data && data.questions) ? data.questions : [])
            .map(el => normalizeElement(el && typeof el === 'object' ? el : {}));
        const slots = crossCheck(toElements(visionRes.data), ocrRes ? toElements(ocrRes.data) : null, {
            isValid: (q) => validate(q)
        });

        const questions = [];
        const rejected = [];
        const chunkInfo = { chunkNo, fromPage, toPage };
        slots.forEach((slot, position) => {
            // idx 的題序＝合併後的格位（含兩版都不合格的格），與原路徑「陣列位置」同一個語意：
            // 被丟的那一格會在 idx 上留下缺號，承上題綁定（utils/followUp.js）靠它判斷前題有沒有被丟。
            const idx = chunkNo * 1000 + position + 1;
            const source = slot.vision && slot.ocr ? 'both' : (slot.vision ? 'vision' : 'ocr');
            if (!slot.question) {
                rejected.push({ idx, errors: slotErrors(slot, validate), source });
                return;
            }
            const { cross_check: cc, ...fields } = slot.question;
            if (!validate(fields)) {
                // 合併（採 OCR 版＋視覺版的附圖欄位）後反而不合格：理論上不會發生，保守起見整格退件
                rejected.push({ idx, errors: formatErrors(validate.errors).map(e => `合併後：${e}`), source });
                return;
            }
            questions.push({ ...toPayloadQuestion(fields, idx, chunkInfo), cross_check: cc });
        });

        const usage = sumUsage([visionRes.usage, ocrRes && ocrRes.usage]);
        const latencyMs = (visionRes.latencyMs || 0) + ((ocrRes && ocrRes.latencyMs) || 0);
        const schemaFallback = visionRes.schemaFallback === true || (ocrRes && ocrRes.schemaFallback === true);
        const summary = {
            engine,
            engine_version: ocr ? ocr.engineVersion : null,
            counts: summarizeCrossCheck(slots),
            vision_elements: toElements(visionRes.data).length,
            ocr_elements: ocrRes ? toElements(ocrRes.data).length : null
        };

        if (questions.length === 0 && rejected.length > 0) {
            return {
                kind: 'fail',
                reason: 'schema_invalid',
                feedback: `這一塊拆出 ${rejected.length} 題，全部沒通過 schema 驗證：${(rejected[0].errors || []).join('；')}`,
                data: { questions: [], rejected, chunk_no: chunkNo, page_range: [fromPage, toPage], pdf_sha256: pdfSha256 }
            };
        }
        if (rejected.length) {
            logger.warn?.({ node: 'extract', chunk_no: chunkNo, rejected: rejected.length, msg: '部分元素兩版都未通過 schema 驗證，只丟掉那幾題' });
        }
        const notAgree = questions.filter(q => q.cross_check.status !== 'agree').length;
        if (notAgree) {
            logger.info?.({ node: 'extract', chunk_no: chunkNo, msg: `交叉驗證：${notAgree}/${questions.length} 題不一致或只有一版，最後會停在人工複核`, ...summary.counts });
        }

        return {
            kind: 'pass',
            data: {
                questions,
                rejected,
                chunk_no: chunkNo,
                page_range: [fromPage, toPage],
                page_count: pageCount,
                pdf_sha256: pdfSha256,
                schema_fallback: schemaFallback,
                usage,
                latency_ms: latencyMs,
                cross_check_summary: summary
            }
        };
    } finally {
        if (ocr && typeof ocr.dispose === 'function') {
            try { ocr.dispose(); } catch (_) { /* 暫存檔刪不掉不影響結果 */ }
        }
    }
}

module.exports = {
    run,
    // 給相容包裝、cassette 錄製腳本與單元測試用的內部零件
    buildPrompt, planChunks, validateElements, normalizeElement, slicePdf,
    TEMPLATE, SYSTEM, PROMPT_TEMPLATE,
    // 〔stage5 WS-B〕化學卷
    AGENT_CHEM, TEMPLATE_CHEM, SYSTEM_CHEM, PROMPT_TEMPLATE_CHEM,
    // 〔本機模式 L2〕本機路徑（OCR＋視覺模型交叉驗證）
    isLocalExtract, buildLocalPrompt, wrapOcrText, toPayloadQuestion,
    AGENT_VISION, AGENT_VISION_CHEM, TEMPLATE_VISION, TEMPLATE_VISION_CHEM,
    AGENT_OCR, AGENT_OCR_CHEM, TEMPLATE_OCR, TEMPLATE_OCR_CHEM,
    LOCAL_VISION_TEMPLATE, LOCAL_VISION_TEMPLATE_CHEM, LOCAL_OCR_TEMPLATE, LOCAL_OCR_TEMPLATE_CHEM,
    LOCAL_MAX_OUTPUT_TOKENS,
    _setLocalDepsForTest
};
