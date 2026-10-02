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
//
// 〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12：本機路徑多一個模式 LOCAL_EXTRACT_MODE（config/localExtractMode.js；
// ctx.config.localExtract.mode，沒帶時問設定檔）。'cross'（預設）＝上面那條路一個字都沒改；'ocr'＝只做 OCR → extract_ocr，
// 不呼叫視覺模型（runLocalOcrOnly）：每題 cross_check 固定是 ocr_only、帶 extract_mode:'ocr'（runner 據此停在
// needs_review('ocr_only')），附圖依 OCR 的版面位置配（agents/extractOcrFigures.js）。extract_ocr 的請求（ocrStructureRequest）
// 與交叉驗證第 3 步送出的逐位元相同（test/unit/extractOcrOnly.test.js 逐鍵比對），所以兩種模式讀同一支 cassette。
//
// 〔dec/r13-extract-fixes，Owner 2026-10-02 同意「本機的這些修改都先做了」；docs/local-mode.md 10.25〕本機路徑（cross、ocr 兩種模式）：
//   - 四個本機模板 v2 → v3：多「answer_text 與解答頁」一段（頁面上沒寫答案就留空字串、解答頁不拆成題）；數學／物理多
//     「矩陣、方程組、度數與填答格」一段。schema 換成 localExtractSchema（只換 answer_text 的說明，驗證相同）。
//   - 確定性後處理 postprocessLocal：解答頁的元素不建題（data.answer_key 記頁碼與解析出的題號→答案，runner 拆完整份後回填）、
//     題目頁沒寫答案就清掉模型編的答案（answer_dropped）、LaTeX 修復（latex_repairs）。
//   Gemini 路徑（extract.v3、extract_chem.v2）的請求、schema、cassette 鍵與輸出逐位元不變。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');
const { PDFDocument } = require('pdf-lib');

const { buildSchema } = require('./schemas');
const { chapterWhitelistText, questionTypeText, LATEX_RULES, CHEM_LATEX_RULES, resolveSubjectGroup } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');
const { crossCheck, summarize: summarizeCrossCheck, FIGURE_FIELDS } = require('./extractCrossCheck');
const { matchOcrFigures } = require('./extractOcrFigures');

// v2（2026-09-15）：加【表格】規範，見 docs/formulas.md §2
// v3（2026-09-27，〔Owner 第五輪 L-2 核准〕dec/r6-templates）：共用的 LATEX_RULES 加第 (5) 條「JSON 字串裡的反斜線寫兩個」。
//   本檔 6 個識別名（Gemini、本機看圖、本機 OCR，各分數學／物理與化學）都含這段規範（化學是 CHEM_LATEX_RULES 的第 (6) 條），
//   一起升版；對應 cassette 全部要重錄。
const TEMPLATE = 'extract.v3';

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
const TEMPLATE_CHEM = 'extract_chem.v2';   // v2：〔Owner 第五輪 L-2〕CHEM_LATEX_RULES 加第 (6) 條

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
// 〔看圖拆題逾時〕選用的 VISION_MAX_EDGE_PX（預設不縮）會在送給視覺模型之前把那幾張 PNG 的長邊縮小
//（services/ocr/render.js 的 fitLongEdge）；OCR 已經用原圖跑完，不受影響。
//
// 模板＝把 Gemini 模板的段落拿來重組：開頭改成「附上的是頁面圖片／OCR 文字」、附圖那一段改成圖片版，
// 其餘段落（白名單、題型、章節、公式規範、表格、題序；化學卷另有 subject 與週期表）逐字沿用。
// 註冊字串＝SYSTEM + '\n---\n' + 模板（與化學模板同一個慣例：SYSTEM 一改，cassette 鍵就跟著變）。
// 頁碼與 OCR 文字是可變欄位：頁碼由 cacheKeyParts 的 chunkNo 決定、OCR 文字由 ocrSha256 決定。

const AGENT_VISION = 'extract_vision';
const AGENT_VISION_CHEM = 'extract_vision_chem';
// 〔Owner 第五輪 L-2〕本機模板由上面兩份模板組成，公式規範跟著變：四個識別名都 v1 → v2
// 〔dec/r13-extract-fixes，Owner 2026-10-02 同意〕四個本機模板都多「answer_text 與解答頁」一段（不准自己編答案、解答頁不拆），
// 數學／物理的兩個另多「矩陣、方程組、度數與填答格」一段（docs/local-mode.md 10.25）：四個識別名都 v2 → v3，對應 cassette 要重錄。
// Gemini 路徑（extract.v3、extract_chem.v2）一個字都沒動。
const TEMPLATE_VISION = 'extract_vision.v3';
const TEMPLATE_VISION_CHEM = 'extract_vision_chem.v3';
const AGENT_OCR = 'extract_ocr';
const AGENT_OCR_CHEM = 'extract_ocr_chem';
const TEMPLATE_OCR = 'extract_ocr.v3';
// 契約只寫了 'extract_ocr.v1'（〔Owner 第五輪 L-2〕v2；〔dec/r13-extract-fixes〕v3）；化學卷的模板內容不同（化學白名單與化學式規範），
// 同一個識別名不能註冊兩種內容（services/llm/templates.js 會丟錯），所以化學另取 'extract_ocr_chem.v1'（現為 v3）。
const TEMPLATE_OCR_CHEM = 'extract_ocr_chem.v3';

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
 * 〔dec/r13-extract-fixes，Owner 2026-10-02 同意〕本機拆題不准自己編答案（114-2 興大附中高二期末考數學 A：題目頁沒有答案，
 * qwen3:8b 每題都填了 answer_text，單選、多選幾乎全錯；第 5 頁的解答表被拆成 8 題）。四個本機模板都有這一段。
 * 程式另有確定性的後處理（utils/answerKey.js：題目頁沒寫答案就清掉、解答頁的元素不建題），這一段是從源頭要求。
 */
const LOCAL_ANSWER_RULE = '【answer_text 欄位與解答頁】answer_text 只抄頁面上這一題「印出來的」答案或解析（例如題目後面寫的「答：」「【解答】」）。頁面上沒有寫出這一題的答案時，answer_text 一律填空字串 ""：不要自己解題、不要推算、不要猜；選填題的填答格（⑨⑩⑪ 這類圈起來的數字）不是答案。只有題號與答案的解答頁（答案表）不是題目，不要拆成題目。';

/**
 * 〔dec/r13-extract-fixes〕矩陣、聯立方程組、度數、填答格的明確寫法（同一份卷實測的壞法：換列的 \\ 只剩一個反斜線、
 * \end{bmatrix} 斷成換行＋end{bmatrix}、\begin{cases} 用 \right. 收尾、度數寫成 \textcircled{\circ}、填答格寫成 \textcircled{m}、
 * a,b 寫成上標 $^{a,b}$）。只進數學／物理的兩個本機模板；寫的是 LaTeX 本身（與上面的規範 (1)～(4) 同一個寫法），
 * 寫進 JSON 的反斜線照規範 (5)。程式另有確定性修復（utils/extractLatexRepair.js）。
 */
const LOCAL_MATRIX_RULE = String.raw`【矩陣、聯立方程組、度數與填答格】(1) 矩陣寫成 $\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$：欄以 & 分隔，換列一律寫兩個反斜線 \\（寫進 JSON 是 "\\\\"），最後一定要寫 \end{bmatrix}，反斜線不能少。(2) 聯立方程組寫成 $\begin{cases} x+y=3 \\ x-y=1 \end{cases}$，一律用 \end{cases} 收尾，不要用 \left\{ … \right.。(3) 度數寫成 $84^\circ$，不要寫成 \textcircled{\circ}。(4) 選填題的填答格（⑨⑩⑪ 這類圈起來的數字）一律寫成「＿＿＿＿」，不要寫成 \textcircled{…}。(5) 變數照原卷寫，例如「$a,b$ 為實數」不要寫成上標 $^{a,b}$。`;

/**
 * 由 Gemini 模板組出本機模板。
 * @param {string} geminiTemplate  PROMPT_TEMPLATE 或 PROMPT_TEMPLATE_CHEM
 * @param {'vision'|'ocr'} kind
 * @param {string} paperWord       '考卷' 或 '化學考卷'
 * @param {string[]} [extraRules]  〔dec/r13-extract-fixes〕接在最後的段落（answer_text 規則；數學／物理另加矩陣等寫法）
 */
function buildLocalTemplate(geminiTemplate, kind, paperWord, extraRules = []) {
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
    body.push(LOCAL_BOUNDARY_RULE, kind === 'vision' ? LOCAL_FIDELITY_VISION : LOCAL_FIDELITY_OCR, ...extraRules);
    return body.join('\n\n');
}

const LOCAL_EXTRA_MATH = [LOCAL_MATRIX_RULE, LOCAL_ANSWER_RULE];
const LOCAL_EXTRA_CHEM = [LOCAL_ANSWER_RULE];
const LOCAL_VISION_TEMPLATE = buildLocalTemplate(PROMPT_TEMPLATE, 'vision', '考卷', LOCAL_EXTRA_MATH);
const LOCAL_VISION_TEMPLATE_CHEM = buildLocalTemplate(PROMPT_TEMPLATE_CHEM, 'vision', '化學考卷', LOCAL_EXTRA_CHEM);
const LOCAL_OCR_TEMPLATE = buildLocalTemplate(PROMPT_TEMPLATE, 'ocr', '考卷', LOCAL_EXTRA_MATH);
const LOCAL_OCR_TEMPLATE_CHEM = buildLocalTemplate(PROMPT_TEMPLATE_CHEM, 'ocr', '化學考卷', LOCAL_EXTRA_CHEM);

/**
 * 〔dec/r13-extract-fixes〕本機路徑用的 extract schema：與 Gemini 的同一份（值域、必填、ajv 驗證都相同），只換 answer_text 的說明。
 * services/llm/ollama.js 會把欄位說明附在 system 後面給模型看（Ollama 的 format 只拿 schema 做文法約束），原本那句
 * 「正確答案；單選／多選必須以選項代號開頭」等於叫模型自己解題，與上面的 LOCAL_ANSWER_RULE 矛盾。
 * answer_text 本來就允許空字串（type:string、沒有 minLength），schema 的契約沒有改；Gemini 路徑的 schema 與 schemaHash 不變。
 */
const LOCAL_ANSWER_DESCRIPTION = '頁面上這一題印出來的答案或解析（數學式用 $...$ 的 LaTeX）；頁面上沒有寫答案時填空字串 ""，不要自己解題。';
const localSchemas = new Map();
function localExtractSchema(group) {
    const key = VARIANTS[group] ? group : 'math_physics';
    if (localSchemas.has(key)) return localSchemas.get(key);
    const copy = JSON.parse(JSON.stringify(buildSchema('extract', VARIANTS[key].schemaOpts)));
    copy.properties.questions.items.properties.answer_text.description = LOCAL_ANSWER_DESCRIPTION;
    const freeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
    localSchemas.set(key, freeze(copy));
    return localSchemas.get(key);
}

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
        ocrConfig: localDepsOverride.ocrConfig || (() => require('../services/ocr').resolveOcrConfig()),
        // 〔看圖拆題逾時〕選項 b：送給視覺模型前縮圖（VISION_MAX_EDGE_PX，由 services/ocr/render 自己讀；未設＝0＝不縮）
        visionMaxEdge: localDepsOverride.visionMaxEdge || (() => require('../services/ocr/render').visionMaxEdgeFromEnv()),
        fitLongEdge: localDepsOverride.fitLongEdge || ((pngs, maxEdge) => require('../services/ocr/render').fitLongEdge(pngs, maxEdge)),
        // 〔OCR 為主〕ctx 沒帶 localExtract（eval、舊的 /analyze-pdf）時的模式；由設定檔讀 LOCAL_EXTRACT_MODE（agent 不讀 process.env）
        localExtractMode: localDepsOverride.localExtractMode || (() => require('../config/localExtractMode').resolveLocalExtractMode()),
        // 〔OCR 為主〕Ollama 的 num_ctx（OLLAMA_NUM_CTX，由 services/llm/ollama 自己讀）：估 extract_ocr 放不放得下
        numCtx: localDepsOverride.numCtx || (() => require('../services/llm/ollama').numCtx()),
        // 〔整合 r5 審查〕這一次實際送給 Ollama 的逐步驟設定（OLLAMA_NUM_CTX_<AGENT>、OLLAMA_MAX_OUTPUT_<AGENT>）：
        // 與 services/llm/index.js 的 adapterOpts 用同一支 localTuning.resolveOllamaOverrides（由它自己讀環境變數）
        ollamaOverrides: localDepsOverride.ollamaOverrides || ((req) => {
            const tuning = require('../services/llm/localTuning');
            const r = tuning.resolveOllamaOverrides(req);
            const nameOf = (prefix) => (tuning.perAgentInt(prefix, req.agent) || {}).name || null;
            return {
                ...r,
                numCtxEnv: r.applied.numCtx ? nameOf('OLLAMA_NUM_CTX_') : null,
                maxOutputEnv: r.applied.numPredict ? nameOf('OLLAMA_MAX_OUTPUT_') : null
            };
        })
    };
}

/**
 * 〔OCR 為主〕這一塊的本機拆題模式：ctx.config.localExtract.mode 優先，沒帶就問設定檔。
 * @param {object} ctx
 * @param {ReturnType<typeof localDeps>} deps
 * @returns {'cross'|'ocr'}
 */
function localExtractModeOf(ctx, deps) {
    const fromCtx = ctx && ctx.config && ctx.config.localExtract && ctx.config.localExtract.mode;
    if (fromCtx === 'ocr' || fromCtx === 'cross') return fromCtx;
    return deps.localExtractMode() === 'ocr' ? 'ocr' : 'cross';
}

/**
 * 〔OCR 為主〕「只用 OCR」模式的 OCR 版（extract_ocr／extract_ocr_chem）請求。
 * 與 runLocal（交叉驗證）第 3 步送出的請求逐位元相同——model／system／parts／schema／輸出上限／cassette 鍵都一樣，
 * 同一支 cassette 兩種模式都讀得到（test/unit/extractOcrOnly.test.js 逐鍵比對；交叉驗證那一段刻意不改寫成呼叫本函式，
 * 讓 cross 模式的程式一個字都不動）。
 * 不帶 thinkingBudget：services/llm/ollama.js 的 think 是 false（OCR 整理不需要推理，CPU 上每個思考 token 都要時間）。
 */
function ocrStructureRequest({ group, models, schema, range, ocrText, chunkNo, pdfSha256, signal }) {
    const v = VARIANTS[group];
    const lv = LOCAL_VARIANTS[group];
    const ocrSha256 = sha256Bytes(Buffer.from(ocrText, 'utf8'));
    return {
        model: models.ocrStructure || models.verify || require('../config/models').MODEL_VERIFY,
        system: v.system,
        parts: [{ text: `${buildLocalPrompt(group, 'ocr', range)}\n\n${wrapOcrText(ocrText)}` }],
        schema,
        maxOutputTokens: LOCAL_MAX_OUTPUT_TOKENS,
        signal,
        agent: lv.ocr.agent,
        template: lv.ocr.template,
        cacheKeyParts: { template: lv.ocr.template, chunkNo, pdfSha256, ocrSha256 }
    };
}

const CJK_CHARS = /[一-鿿]/g;

/**
 * 〔OCR 為主〕粗估 token 數：中文字一字一個，其餘字元（含空白、LaTeX、HTML 表格）每 3 個一個。
 * Qwen 的分詞器對常用中文多半一字一 token、英數符號 3～4 字一 token；取保守的一邊，只拿來提醒 num_ctx 可能不夠。
 * @param {string} text
 * @returns {number}
 */
function estimatePromptTokens(text) {
    const s = String(text ?? '');
    const cjk = (s.match(CJK_CHARS) || []).length;
    return cjk + Math.ceil((s.length - cjk) / 3);
}

/**
 * 〔整合 r5 審查〕extract_ocr 這一次**實際送出**的 num_ctx 與輸出上限（num_predict）。
 * 規則與 services/llm/index.js 的 adapterOpts 一致：模型的 vendor 是 ollama 時套 localTuning.resolveOllamaOverrides——
 *   num_ctx：OLLAMA_NUM_CTX_EXTRACT_OCR（化學版先找 _CHEM）有寫就用它，沒寫才是全域 OLLAMA_NUM_CTX（services/llm/ollama.numCtx）；
 *   輸出上限：OLLAMA_MAX_OUTPUT_EXTRACT_OCR 比 LOCAL_MAX_OUTPUT_TOKENS 小才換成它（只降不升）。
 * 兩個都沒寫（預設）＝與整合前相同：全域 OLLAMA_NUM_CTX、req.maxOutputTokens。
 * numCtxEnv 給警告訊息用：叫 Owner 去調的是實際生效的那一個變數。
 * @returns {{numCtx:number, maxOutputTokens:number, numCtxEnv:string, maxOutputEnv:string|null}}
 */
function ocrCallLimits(req, deps) {
    let tuned = null;
    try {
        const { vendor } = require('../config/models').parseModel(req.model);
        if (vendor === 'ollama') tuned = deps.ollamaOverrides(req);
    } catch (_) { tuned = null; }
    const applied = (tuned && tuned.applied) || {};
    return {
        numCtx: applied.numCtx ? tuned.numCtx : deps.numCtx(),
        maxOutputTokens: applied.numPredict ? tuned.maxOutputTokens : req.maxOutputTokens,
        numCtxEnv: (applied.numCtx && tuned.numCtxEnv) || 'OLLAMA_NUM_CTX',
        maxOutputEnv: (applied.numPredict && tuned.maxOutputEnv) || null
    };
}

/**
 * 〔OCR 為主〕extract_ocr 一次呼叫的 context 預算：prompt（system＋Ollama 轉接層附加的 schema 說明＋模板＋OCR 文字）
 * 加上輸出上限（num_predict）要放得進 num_ctx；放不下時 Ollama 會截掉前面的內容或截斷輸出。
 * 〔整合 r5 審查〕num_ctx 與輸出上限用這一次實際送出的值（ocrCallLimits），不是固定的全域 OLLAMA_NUM_CTX 與 8192。
 */
function ocrContextBudget(req, deps) {
    let guide = '';
    try { guide = require('../services/llm/ollama').schemaGuide(req.schema) || ''; } catch (_) { guide = ''; }
    const promptTokens = estimatePromptTokens(req.system) + estimatePromptTokens(guide)
        + req.parts.reduce((n, p) => n + estimatePromptTokens(p.text), 0);
    const lim = ocrCallLimits(req, deps);
    return {
        prompt_tokens_est: promptTokens,
        max_output_tokens: lim.maxOutputTokens,
        num_ctx: lim.numCtx,
        over: promptTokens + lim.maxOutputTokens > lim.numCtx,
        // 有逐步驟設定時才多記生效的變數名稱；都沒寫＝與整合前的摘要逐鍵相同
        ...(lim.numCtxEnv !== 'OLLAMA_NUM_CTX' ? { num_ctx_env: lim.numCtxEnv } : {}),
        ...(lim.maxOutputEnv ? { max_output_env: lim.maxOutputEnv } : {})
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

/**
 * 〔dec/r13-extract-fixes，Owner 2026-10-02 同意；docs/local-mode.md 10.25〕本機拆題一塊的確定性後處理（cross、ocr 兩種模式共用）：
 *   1. 答案（utils/answerKey.js 的 processChunkAnswers）：解答頁上拆出來的元素不建題（skip）；題目頁上沒有寫答案時，
 *      模型給的 answer_text 清成空字串（answer_dropped 記原因與原文）；只是填答格記號（⑮⑯）的答案也清掉。
 *      沒有 OCR 頁面（OCR_ENGINE=none 的 cross 模式）時這一步什麼都不做。
 *   2. LaTeX（utils/extractLatexRepair.js）：矩陣換列、斷掉的 \end、cases 配 \right.、度數圈圈、填答格、開頭上標。修了什麼記在 latex_repairs。
 * elements 會被就地改（answer_text、question_text），呼叫端再拿去做 ajv 驗證。
 * @param {Array<object>} elements 這一塊的元素（依位置；不合格的格位用空題幹佔位）
 * @param {Array<object>|null} pages 這一塊的 OCR 頁面
 * @returns {{skip:Map<number,string>, extras:(position:number)=>object, summary:object|null, repaired:number}}
 */
function postprocessLocal(elements, pages) {
    const { processChunkAnswers } = require('../utils/answerKey');
    const { repairElement } = require('../utils/extractLatexRepair');
    const answers = processChunkAnswers(elements, pages);
    const repairs = elements.map((el, i) => (answers.skip.has(i) ? [] : repairElement(el)));
    const repaired = repairs.filter(r => r.length > 0).length;
    return {
        skip: answers.skip,
        repaired,
        summary: answers.summary,
        extras: (i) => ({
            ...(answers.notes.has(i) ? { answer_dropped: answers.notes.get(i) } : {}),
            ...(repairs[i] && repairs[i].length ? { latex_repairs: repairs[i] } : {})
        })
    };
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
    // 〔dec/r13-extract-fixes〕本機版 schema（只換 answer_text 的說明；驗證與 Gemini 的同一份）
    const schema = localExtractSchema(group);
    const models = (ctx && ctx.config && ctx.config.models) || {};
    const ocrCfg = (ctx && ctx.config && ctx.config.ocr) || {};
    const engine = ocrCfg.engine || deps.ocrConfig().engine;
    const replay = deps.llmMode() === 'replay';
    const signal = ctx && ctx.signal;
    const range = { fromPage, toPage };

    // 〔OCR 為主〕LOCAL_EXTRACT_MODE=ocr：只做 OCR → extract_ocr（下面交叉驗證的程式一個字都沒動）
    if (localExtractModeOf(ctx, deps) === 'ocr') {
        return runLocalOcrOnly(ctx, { bytes, pdfSha256, chunkNo, fromPage, toPage, pageCount }, logger, {
            deps, group, schema, models, engine, signal, range
        });
    }

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
            // 〔看圖拆題逾時〕選項 b（預設關）：長邊上限 > 0 才縮；0 時連 fitLongEdge 都不呼叫，送出的位元組與之前相同。
            // 圖片不在 cassette 的鍵裡（鍵是 template／chunkNo／pdfSha256），開了也不必重錄；OCR 用的是自己的原圖。
            const maxEdge = Number.isInteger(ocrCfg.visionMaxEdge) ? ocrCfg.visionMaxEdge : deps.visionMaxEdge();
            if (maxEdge > 0) images = await deps.fitLongEdge(images, maxEdge);
        }
        const visionRes = await ctx.llm.generateJson({
            model: models.extract || undefined,
            system: v.system,
            parts: [
                { text: buildLocalPrompt(group, 'vision', range) },
                // 〔本機模式整合 LM-4〕圖片 part 用既有慣例 {imageBase64, mimeType}（gemini.js、cassette.summarizeParts 都認得），
                // cassette 的 request 摘要才會記成圖片（位元組數＋sha256），不會是 unknown；鍵不含 parts，不受影響。
                ...images.map(png => ({ imageBase64: Buffer.from(png).toString('base64'), mimeType: 'image/png' }))
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
        // 〔dec/r13-extract-fixes〕合併後的每一格先做答案處理（解答頁的元素不建題、題目頁沒寫答案就清掉）與 LaTeX 修復
        const merged = slots.map((slot) => {
            if (!slot.question) return { question_text: '', answer_text: '' };
            const { cross_check: _cc, ...fields } = slot.question;
            return fields;
        });
        const post = postprocessLocal(merged, ocr ? ocr.pages : null);
        slots.forEach((slot, position) => {
            // idx 的題序＝合併後的格位（含兩版都不合格的格），與原路徑「陣列位置」同一個語意：
            // 被丟的那一格會在 idx 上留下缺號，承上題綁定（utils/followUp.js）靠它判斷前題有沒有被丟。
            const idx = chunkNo * 1000 + position + 1;
            const source = slot.vision && slot.ocr ? 'both' : (slot.vision ? 'vision' : 'ocr');
            if (post.skip.has(position)) return;   // 解答表：不建題、不算退件（記在 data.answer_key）
            if (!slot.question) {
                rejected.push({ idx, errors: slotErrors(slot, validate), source });
                return;
            }
            const { cross_check: cc } = slot.question;
            const fields = merged[position];
            if (!validate(fields)) {
                // 合併（採 OCR 版＋視覺版的附圖欄位）後反而不合格：理論上不會發生，保守起見整格退件
                rejected.push({ idx, errors: formatErrors(validate.errors).map(e => `合併後：${e}`), source });
                return;
            }
            questions.push({ ...toPayloadQuestion(fields, idx, chunkInfo), cross_check: cc, ...post.extras(position) });
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
                cross_check_summary: summary,
                // 〔dec/r13-extract-fixes〕解答頁、清掉的答案（沒有就不帶這兩個鍵）
                ...(post.summary ? { answer_key: post.summary } : {}),
                ...(post.repaired ? { latex_repaired: post.repaired } : {})
            }
        };
    } finally {
        if (ocr && typeof ocr.dispose === 'function') {
            try { ocr.dispose(); } catch (_) { /* 暫存檔刪不掉不影響結果 */ }
        }
    }
}

// ───────────────────────── 只用 OCR（〔OCR 為主 2026-09-26〕LOCAL_EXTRACT_MODE=ocr）─────────────────────────

/** 「只用 OCR」每一題的 cross_check：沿用交叉驗證的欄位形狀（extractCrossCheck.js 檔頭），沒有第二版可以比 */
const OCR_ONLY_CROSS_CHECK = Object.freeze({ status: 'ocr_only', similarity: null, alt_question_text: null, picked: 'ocr' });

/**
 * LOCAL_EXTRACT_MODE=ocr 的一塊：OCR → extract_ocr，不呼叫視覺模型、不轉圖。
 *   - 文字模型看不到圖（模板也要它不要輸出附圖欄位）：它回的 figure_desc／figure_page／figure_box 一律拿掉，
 *     附圖改由 OCR 的版面位置配（agents/extractOcrFigures.js），配不到的題標 figure_hint。
 *   - 每題 cross_check＝OCR_ONLY_CROSS_CHECK、extract_mode:'ocr'：workers/jobRunner.js 的 crossCheckStopReason
 *     讓它走完後續節點、最後停在 needs_review('ocr_only')——與「兩版不一致」（extract_disagree）分開，絕不自動入庫。
 *   - outcome 形狀與交叉驗證相同（cross_check_summary 多 mode、figures、ctx_budget 三個鍵）。
 * @returns {Promise<object>} outcome；丟出的錯由 run() 收成 {kind:'error'}
 */
async function runLocalOcrOnly(ctx, { bytes, pdfSha256, chunkNo, fromPage, toPage, pageCount }, logger, { deps, group, schema, models, engine, signal, range }) {
    if (engine === 'none') {
        // 矛盾設定（config/localExtractMode.js）：runner 啟動時就擋下；這裡是 eval、舊的 /analyze-pdf 這些沒經過 runner 的呼叫端
        const message = require('../config/localExtractMode').localExtractConflict({ localExtract: true, mode: 'ocr', ocrEngine: 'none' });
        return { kind: 'error', errorClass: 'provider_error', message };
    }
    const summaryBase = { engine, mode: 'ocr', vision_elements: null };

    if (toPage < fromPage) {
        return {
            kind: 'pass',
            data: {
                questions: [], rejected: [], chunk_no: chunkNo, page_range: [fromPage, toPage], page_count: pageCount,
                pdf_sha256: pdfSha256, schema_fallback: false, usage: sumUsage([]), latency_ms: 0,
                cross_check_summary: { ...summaryBase, engine_version: null, counts: summarizeCrossCheck([]), ocr_elements: 0 }
            }
        };
    }

    let ocr = null;
    try {
        ocr = await deps.ocrPdf({ pdfBytes: bytes, pdfSha256, fromPage, toPage, signal });
        if (signal && signal.aborted) throw abortedError();

        const ocrText = require('../services/ocr').pagesToText(ocr.pages);
        const req = ocrStructureRequest({ group, models, schema, range, ocrText, chunkNo, pdfSha256, signal });
        const budget = ocrContextBudget(req, deps);
        if (budget.over) {
            const ctxEnv = budget.num_ctx_env || 'OLLAMA_NUM_CTX';
            logger.warn?.({
                node: 'extract', chunk_no: chunkNo,
                msg: `OCR 整理這一塊估計要讀約 ${budget.prompt_tokens_est} token，加上輸出上限 ${budget.max_output_tokens} 會超過 ${ctxEnv}=${budget.num_ctx}：` +
                    `前面的內容可能被截掉、輸出可能被截斷。可在 .env 把 JOB_PDF_CHUNK_PAGES 設成 1（一塊 1 頁），或調高 ${ctxEnv}（記憶體要夠）。`
            });
        }
        const res = await ctx.llm.generateJson(req);

        const validate = getItemValidator(group);
        const elements = (Array.isArray(res.data && res.data.questions) ? res.data.questions : []).map((el) => {
            const out = normalizeElement(el && typeof el === 'object' ? el : {});
            for (const f of FIGURE_FIELDS) delete out[f];
            return out;
        });
        // 〔審查 2026-09-26〕這一塊可能被截斷（粗估放不下 OLLAMA_NUM_CTX，或輸出用滿上限）時模型可能少拆了後面幾題，
        // 題目範圍說不準：整塊只標提示、不自動配（agents/extractOcrFigures.js 檔頭 ⑦）
        const tokenOut = Number(res.usage && res.usage.tokenOut);
        // 〔整合 r5 審查〕「用滿上限」比的是實際送出的上限（OLLAMA_MAX_OUTPUT_EXTRACT_OCR 降過就是降過的值）
        const truncated = budget.over || (Number.isFinite(tokenOut) && tokenOut >= budget.max_output_tokens);
        const fig = matchOcrFigures(elements, ocr.pages, { truncated });
        // 〔dec/r13-extract-fixes〕答案處理與 LaTeX 修復（配圖用的是修復前的題幹，與之前相同）
        const post = postprocessLocal(elements, ocr.pages);

        const questions = [];
        const rejected = [];
        const chunkInfo = { chunkNo, fromPage, toPage };
        elements.forEach((el, position) => {
            // idx 的題序＝陣列位置（含不合格的元素，留缺號），與原路徑、交叉驗證同一個語意
            const idx = chunkNo * 1000 + position + 1;
            if (post.skip.has(position)) return;   // 解答表：不建題、不算退件（記在 data.answer_key）
            if (!validate(el)) {
                rejected.push({ idx, errors: formatErrors(validate.errors).map(e => `OCR 版：${e}`), source: 'ocr' });
                return;
            }
            const f = fig.results[position] || {};
            questions.push({
                ...toPayloadQuestion(el, idx, chunkInfo),
                // 版面配到的圖：頁碼是 OCR 回的整份 PDF 絕對頁碼（不經 toPayloadQuestion 的塊內頁碼換算）
                ...(f.figure_box ? { figure_page: f.figure_page, figure_box: f.figure_box } : {}),
                cross_check: { ...OCR_ONLY_CROSS_CHECK },
                extract_mode: 'ocr',
                ...(f.figure_hint ? { figure_hint: f.figure_hint } : {}),
                ...post.extras(position)
            });
        });

        const summary = {
            ...summaryBase,
            engine_version: ocr.engineVersion ?? null,
            counts: { ...summarizeCrossCheck([]), ocr_only: questions.length },
            ocr_elements: elements.length,
            figures: fig.summary,
            ctx_budget: budget
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
            logger.warn?.({ node: 'extract', chunk_no: chunkNo, rejected: rejected.length, msg: '部分元素未通過 schema 驗證，只丟掉那幾題' });
        }
        if (questions.length) {
            logger.info?.({
                node: 'extract', chunk_no: chunkNo,
                msg: `只用 OCR 拆題：${questions.length} 題，最後都會停在人工複核（ocr_only）；附圖自動配到 ${fig.summary.assigned} 題、${fig.summary.hinted} 題標了補圖提示`,
                figures: fig.summary
            });
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
                schema_fallback: res.schemaFallback === true,
                usage: sumUsage([res.usage]),
                latency_ms: res.latencyMs || 0,
                cross_check_summary: summary,
                // 〔dec/r13-extract-fixes〕解答頁、清掉的答案（沒有就不帶這兩個鍵）
                ...(post.summary ? { answer_key: post.summary } : {}),
                ...(post.repaired ? { latex_repaired: post.repaired } : {})
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
    // 〔OCR 為主〕LOCAL_EXTRACT_MODE=ocr
    OCR_ONLY_CROSS_CHECK, estimatePromptTokens, ocrStructureRequest, ocrCallLimits,
    // 〔dec/r13-extract-fixes〕不准編答案、解答頁、LaTeX 修復
    LOCAL_ANSWER_RULE, LOCAL_MATRIX_RULE, LOCAL_ANSWER_DESCRIPTION, localExtractSchema, postprocessLocal,
    _setLocalDepsForTest
};
