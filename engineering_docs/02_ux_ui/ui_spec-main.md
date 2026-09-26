# UI 規格書：主頁 (UI Spec – Main) - 家教專用數理題庫系統

> **版本:** v1.2 | **更新:** 2026-09-24 | **狀態:** 活躍
> 🛠 **2026-08-29 修訂**（PR #3/#6/#7 程式碼同步）：§2 版面配置整節重寫為 5 個 `.app-view` 視圖＋hash 路由（原「Topbar＋Hero」「右欄 #paper lg:sticky」ASCII 圖已刪除——Hero 區塊於 commit 995f444 自程式碼移除）；§1 入口／出口改為視圖切換語意（「先切視圖再捲動」）；§3 章節欄位改科目→冊→單元三層選單並新增 #volume／#paper_volume 列；§3 新增 source_type 三欄位（#source_type／#pdf_source_type／#paper_source_scope）與題庫卡片來源徽章；§4 編輯 Modal 補題目來源改標；§8 刪除「導覽列 md 以下隱藏」與「組卷卡 lg:sticky」，改橫向捲動與獨立視圖；§10 補 FR-017。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15g 修訂**（feat/follow-up-paper-group，FR-019 PR2）：§3 組卷預覽列補「承上 #id」標示、「換這組」按鈕與少出題附註。修改處以〔修訂 2026-09-15g〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`）：只補階段 5 在本頁的最小掛鉤（WS-A、WS-B，標〔stage5 WS-X〕）——科目下拉改讀 API（含化學）、上傳區「卷別」選單、題目編輯 modal 的「文字詳解」欄、題庫卡片「有詳解」徽章、Word 匯出版本選單、MathJax 載入 mhchem。其餘內容未重掃。修改處以〔修訂 2026-09-24〕行內標記。
> 🛠 **2026-09-26 合併回填**（分支 `dec/docs-backfill-round1-merged`；Owner 決策單 2026-09-25 B7、B10 已合入 `local/integration` `7dc14a0`）：§3 組卷預覽、§4 確認出卷、§5 Error、§6 換這題／確認出卷補上「承上組湊不滿預設 400」與「確認出卷擋半組承上題」。前端程式沒有改（既有的錯誤顯示路徑已涵蓋）。修改處以〔修訂 2026-09-26 合併回填〕行內標記。
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（`ui_spec-<page>.md`）
> 本文件定義主頁（`exam_pro/public/index.html` inline script）的區塊、狀態與互動：手動建題、PDF 上傳拆題入口、題庫管理與組卷（草稿→確認）。複核佇列見 [ui_spec-review.md](./ui_spec-review.md)；學生分頁見 [ui_spec-students.md](./ui_spec-students.md)。

## 目錄

- [1. 頁面目的 (Page Purpose)](#1-頁面目的-page-purpose)
- [2. 版面配置 (Layout)](#2-版面配置-layout修訂-2026-08-29)
- [3. 欄位與元件 (Fields / Components)](#3-欄位與元件-fields--components)
- [4. 使用者操作 (Actions)](#4-使用者操作-actions)
- [5. UI 狀態 (States)](#5-ui-狀態-states)
- [6. 互動規格 (Interaction Spec)](#6-互動規格-interaction-spec)
- [7. 驗證規則 (Validation)](#7-驗證規則-validation)
- [8. 響應式與無障礙 (Responsive / A11y)](#8-響應式與無障礙-responsive--a11y)
- [9. 設計交付 (Design Handoff)](#9-設計交付-design-handoff)
- [10. 追溯](#10-追溯)

## 1. 頁面目的 (Page Purpose)

家教老師在單一工作區完成建題（手動或 PDF 拆題）、維護題庫、依學生組卷並匯出 Word。單頁應用，唯一路由 `/`。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 系統唯一入口頁；頂部導覽 5 個分頁連結（`data-view`）以 hash 路由切換視圖 `#create`／`#paper`／`#library`／`#students`／`#assistant`〔修訂 2026-08-29〕 |
| 出口 | 同頁各視圖（複核 `#review`、學生 `#students` 等由 ES module 掛入空 `<section>` 錨點；跨區導覽經 `showSection` **先切視圖再捲動**，index.html:1486-1495）；下載 `.docx` 為檔案出口〔修訂 2026-08-29〕 |

## 2. 版面配置 (Layout)〔修訂 2026-08-29〕

分頁式版面（PR #6）：Hero 區塊（工作流三步說明＋CTA）已整段刪除（commit 995f444）；5 個 `.app-view` 視圖容器由 inline script 的 hash 路由一次只顯示一個（`VIEW_FOR_ANCHOR`，index.html:1440-1446；`showView`／`routeFromHash`，:1449-1468）。

視圖切換動效（2026-08-29）：切換時新視圖以 GSAP 淡入＋上移歸位（`autoAlpha` 0→1、`y` 28→0，0.45s `power2.out`），舊視圖即時隱藏；首次載入、同視圖內子錨點不觸發動效。守門條件 `motionOn()`：`prefers-reduced-motion: reduce` 或 GSAP（〔修訂 2026-09-25〕改從本機 `/vendor/gsap` 載入，釘 3.13.0）載入失敗時退回硬切，功能不依賴動畫；動畫結束 `clearProps` 歸還 inline style，快速連切由 `overwrite: 'auto'` 處理。

```text
Topbar（sticky 導覽：品牌 Tutor-exam-bank＋5 個分頁連結（行動版 overflow-x-auto 橫向捲動）＋系統就緒指示）
view-create（:254） ─ #create：快速建立（左）＋AI 批量解析（右）並排（:256）；#review 空錨點（:415）折入本視圖
view-paper（:419） ─ #paper：智慧組卷（獨立視圖，max-w-3xl 置中，不再是右欄 sticky）
view-library（:522） ─ #nlq 空錨點（:523）＋#library 題庫管理（篩選列＋題目卡列表＋分頁器，:525）＋#variants 空錨點（:578）
view-students（:582） ─ #students 空錨點（:583）
view-assistant（:588） ─ #assistant 空錨點（:589）
編輯 Modal（#editModal）／Toast 區（#toastRegion）——全域層，不屬任一視圖
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 學科（#subject／#paper_subject／#mgr_subject） | select | 〔修訂 2026-09-24〕依 `GET /api/chapter-volumes` 重建（`syncSubjectSelects`，不再寫死；化學併入後有三科）；原記「固定值：數學／物理」為階段 5 前的行為 | 切換時連動冊別與單元下拉（三層選單）〔修訂 2026-08-29〕 |
| 卷別（#pdf_subject_group）〔修訂 2026-09-24〕 | select | 固定值：數學／物理（`math_physics`，預設）／化學（`chemistry`） → `POST /api/jobs` 的 `subject_group`（由 `public/js/review.js` 送出） | 在上傳區；舊版單次拆題（`/api/analyze-pdf`）選化學時直接提示「化學卷需要新版拆題管線」、不送出（FR-026） |
| 文字詳解（編輯 modal #edit_solution）〔修訂 2026-09-24〕 | textarea＋來源標示＋即時預覽 | `GET /api/questions` 的 `solution_text`、`solution_src` → `PUT /api/questions/:id` | 來源標示「管線驗算時由模型解出、與答案比對一致（未經人工審閱）」或「老師撰寫」（附註「改寫後會標為老師撰寫」）；沒有時「尚無詳解（選填，4000 字內，公式用 $...$）」；**只在老師改過這一欄時才送** `solution_text`（FR-024） |
| 「有詳解」徽章〔修訂 2026-09-24〕 | badge | `solution_text` 非空 | 題庫卡片行尾；title「這題有文字詳解，Word 詳解版會印出來」 |
| Word 版本（#wordEdition）〔修訂 2026-09-24〕 | select | → `POST /api/download-word` 的 `edition` | 標準版（預設）／學生版／詳解版；檔名加註「（學生版）」「（詳解版）」（FR-025） |
| 冊別（#volume，建題 :283） | select | `GET /api/chapter-volumes`（科→冊→單元結構，唯一真相 `config/chapters.js` 的 VOLUMES；載入 :650-659） | 選科後列該科各冊；切換時連動單元下拉〔修訂 2026-08-29〕 |
| 冊別（#paper_volume，組卷 :466） | select | 同上＋`GET /api/chapters` 庫存交集（:941-977） | 只列「該科有庫存題目」的冊；白名單外舊章節歸「其他」；無庫存顯示「(目前此科目無庫存題目)」〔修訂 2026-08-29〕 |
| 單元（#chapter／#paper_chapter／#mgr_chapter） | select | `GET /api/chapter-volumes` 依所選冊展開（組卷側再以 `GET /api/chapters` 過濾庫存；`#mgr_chapter` 依冊 optgroup 分組、跨科標籤帶科名，:794-808） | 組卷側顯示「-- 請選擇單元 (共 N 個) --」；無庫存顯示「(此冊目前無庫存題目)」〔修訂 2026-08-29〕 |
| 題目來源（#source_type，建題 :322）〔修訂 2026-08-29〕 | select | 固定值：self／official／school／publisher／unknown（與後端 `config/chapters.js` 的 SOURCE_TYPES 一致） | 預設 self（自行編寫）；隨 `POST /api/questions` 送出（FR-017） |
| 這份考卷的來源（#pdf_source_type，上傳 :377）〔修訂 2026-08-29〕 | select | 同上值域 | 預設 unknown（之後可在題庫管理補標）；該份 PDF 入庫的所有題沿用同一標記（FR-017） |
| 題源限制（#paper_source_scope，組卷 :490）〔修訂 2026-08-29〕 | select | 固定三檔：all／clean／no_publisher（`SOURCE_SCOPE_MAP`，:702-704） | all 不帶 `source_types`＝不過濾；clean＝官方／學校／自寫；no_publisher＝排除出版社（未標記仍可用）（FR-017） |
| 題型／難度 | select | 固定值：單選／多選／填空／計算（管理側另有證明）；難度 1–5 以 ★ 顯示 | — |
| 題目內容／標準答案 | textarea／input | `question_text`／`answer_text` | 支援 `$…$` LaTeX，MathJax 即時渲染 |
| 學生（#student_select） | select | `GET /api/students` → `items[]` | 顯示 `姓名（N 張卷）`；姓名另存 `dataset.name`（裁決 S4-1：學生用選的不用打的） |
| 題庫卡片 | card | `GET /api/questions?page&limit=10`（來源篩選 #mgr_source :558-566 帶 `source_type` 參數 :829） | `#id`＋學科·章節＋題型＋★難度＋**來源徽章**（`SOURCE_TYPE_LABEL`／`SOURCE_TYPE_BADGE` 對照 :693-700，渲染 :852）＋題幹＋答案；每頁 10 筆〔修訂 2026-08-29〕 |
| 組卷預覽（#resultBox） | panel | `POST /api/generate-paper`（`dry_run:true`） | 每題含題號、題型、★難度、`#id`、題幹、參考答案、「換這題」；承上題標「承上 #前題 id」，承上組成員的按鈕改為「換這組」（排除任一題＝整組換掉）；回應帶 `note`（承上組湊不滿題數而少出題）時於預覽說明下方以紅字「⚠ …」顯示，確認出卷後的結果區同樣列出〔修訂 2026-09-15g〕。〔修訂 2026-09-26 合併回填 B10〕預設政策（`FOLLOW_UP_SHORTFALL_POLICY=error`）下，承上組湊不滿題數不再少出題，而是 400：#resultBox 的出題失敗區顯示「❌ 出題失敗原因：承上題須與前題整組出題，「{章}」要 N 題無法剛好湊滿（…），請把題數改成 a 題或 b 題。」，老師改題數再生成；上述紅字 `note` 只在 `.env` 設 `note` 時出現 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 儲存題目 | #questionForm submit | `POST /api/questions`；成功後表單 reset、章節重載 | 單人系統，`x-api-key` 由 `<meta name="api-key">` 注入 |
| AI 解析 PDF | #uploadPdfBtn | `POST /api/analyze-pdf` → 預覽卡（每題就地編輯）；FEATURE_PIPELINE 開啟時被 review.js 以 capture 攔截改送 `POST /api/jobs` | 同上 |
| 批量入庫 | #batchSaveBtn | `POST /api/batch-save-questions`；`rejected[]` 標紅留在預覽、已入庫題移除 | 同上 |
| 新增學生 | ＋ 新增 → 建立 | `POST /api/students`；成功後選單重載並選中新學生 | 同上 |
| 生成試卷（草稿） | 生成專屬特訓試卷 | `dry_run:true`，整段不寫庫；渲染預覽卡 | 同上 |
| 換這題／整卷重抽 | 預覽卡按鈕 | 加入 `exclude_ids` 重新 dry_run／排除清單歸零重抽；皆不「燒題」 | 同上 |
| 確認出卷 | ✔ 確認出卷 | `POST /api/confirm-paper` 建卷並寫 attempts；成功後顯示下載與「立即批改」。〔修訂 2026-09-26 合併回填 B7〕伺服器會擋半組承上題（400，訊息逐組列出缺哪幾題）；預覽本來就整組抽，正常流程不會碰到，碰到時以 error toast 顯示訊息、不寫任何東西 | 同上 |
| 下載 Word | 下載 Word 考卷 | `POST /api/download-word` → Blob 下載 `.docx` | 同上 |
| 編輯／刪除題目 | 題卡 ✏️／🗑️ | Modal 內 `PUT /api/questions/:id`；`confirm()` 後 `DELETE`；Modal 於共用編輯器外額外掛「題目來源」改標列（:908-917，不動 `createQuestionEditor`，FR-017）〔修訂 2026-08-29〕 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | 章節下拉「-- 載入中 --」；學生下拉「-- 載入學生中… --」；#pdfStatus 靛藍字 | 「⏳ 正在分析整份 PDF 所有題目，AI 計算答案中...」 |
| Empty | 題庫列表虛線框空狀態卡；學生下拉引導文案 | 「沒有符合條件的題目」＋「調整上方篩選條件後再試一次」；「-- 還沒有學生，先按『＋ 新增』 --」 |
| Error | #pdfStatus 轉紅；組卷失敗顯示於 #resultBox；其餘走 toast（error 色調） | 「❌ 分析失敗：{message}」「❌ 出題失敗原因：{message}」「連線失敗，請確認伺服器狀態」。〔修訂 2026-09-26 合併回填 B10／B7〕承上組湊不滿題數的 400（預設政策）走「出題失敗原因」；確認出卷的承上題組不完整 400 走 toast |
| 進行中（草稿） | #resultBox 琥珀色提示列 | 「尚未寫入——換題、重抽都不會扣掉題庫池；按『確認出卷』才會建卷並記入不重複紀錄。」 |
| 部分失敗 | 未通過題卡加 `ring-rose` 標紅、前置原因列；通過題自清單移除 | 「⚠ 未寫入：{reason}」 |
| Success | toast（success 色調）；確認出卷後標題「✨ {paper_title}」 | 「題目已成功儲存」「🎉 所有題目已成功寫入資料庫！」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 上傳／入庫／儲存／確認按鈕 | 色階加深 | 請求期間 `disabled = true`（防重複點擊），`finally` 復原 | 文案不變，狀態列顯示進度 | toast＋狀態列轉紅 |
| 換這題 | 底色變化 | — | 失敗（多為庫存不足 400；〔修訂 2026-09-26 合併回填 B10〕預設政策下也可能是換掉一組後承上組湊不滿的 400）時把排除退回、預覽維持原狀 | 沿用 dry_run 失敗顯示 |
| 確認出卷 | — | 請求期間 disabled | — | 409（預覽過期）自動重新 dry_run 一份新預覽；〔修訂 2026-09-26 合併回填 B7〕400（含承上題組不完整）只顯示 toast，不自動重新預覽 |
| 立即批改 | — | FEATURE_STUDENTS 關閉或回應無 `paper_id` 時整顆隱藏 | — | 由 students.js 接手（`examapp:grade-paper` 事件） |
| 編輯器即時預覽 | — | — | 輸入 debounce 350ms 後同步並 MathJax 渲染 | — |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| 章節／題目內容／標準答案 | HTML `required` | 瀏覽器原生提示 | submit |
| PDF 檔案 | 必須先選檔 | 「請先選取 PDF 檔案」（toast） | 點擊上傳 |
| 學生／章節（組卷） | 必選 | 「請先選擇學生（或先新增）」「請選擇出題章節」 | 點擊生成 |
| 新學生姓名 | 非空（trim） | 「請輸入新學生姓名」 | 點擊建立 |
| 批量入庫內容 | 伺服器端白名單硬驗證（ADR-005），前端僅轉述 `rejected[].reason` | 「⚠ 未寫入：{reason}」 | 回應後 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 建立題目視圖 `lg` 以上左右並排（lg:grid-cols-2）；組卷為獨立視圖置中（max-w-3xl，非 sticky 右欄）；`sm` 以下單欄、篩選列縮為單欄格。導覽列不隱藏：行動版 `overflow-x-auto whitespace-nowrap` 橫向捲動（:236）。〔修訂 2026-08-29〕
- **鍵盤操作:** 題庫搜尋框 Enter 觸發查詢；Modal 可按背景或 × 關閉。
- **ARIA / 對比:** 導覽 `aria-label="主要導覽"`、篩選下拉逐一 `aria-label`、toast 區 `aria-live="polite"`；`prefers-reduced-motion` 時停用動畫。使用者輸入一律 `textContent`／`escapeHtml` 呈現。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/index.html`（無 Figma 稿，程式碼即設計權威） |
| Design Tokens | 同檔 `:root` CSS 變數（--ink／--brand／--mint 等）＋Tailwind（〔修訂 2026-09-25〕本機 `/vendor/tailwindcss`） |
| 元件對照 | `createQuestionEditor`／`showToast`／`apiFetch` 等經 `window.ExamApp` 供各分頁 module 共用 |
| 已知限制 | ~~Tailwind 與 MathJax 走 CDN，離線環境無樣式與公式渲染~~〔修訂 2026-09-25〕已改從本機載入，離線可用（`docs/local-mode.md` 第 5 條）；請用 `ALLOWED_ORIGINS` 裡的網址（預設 `http://localhost:3000`）開頁面，用 `127.0.0.1` 開會讓字型請求被 CORS 擋下；〔修訂 2026-09-24〕MathJax 設定明確載入 mhchem（`\ce{…}` 化學式），與 `ui/safe`，並關掉數學式裡的連結（裁決 S5-35，尚待瀏覽器實測）；階段 5 的掛鉤只以 miniDom 與 `check:html` 驗證 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-001（上傳入口）、FR-007、FR-008、FR-009、FR-014（新增學生入口）、FR-017（source_type 題源標記，PR #7）〔修訂 2026-08-29〕；FR-024、FR-025、FR-026、FR-027〔修訂 2026-09-24〕；NFR-001 |
| 對應決策 | DEC-001、DEC-002、DEC-003、DEC-007 |
| 對應 ADR | [ADR-004](../03_architecture/adr/ADR-004-custom-latex-ooxml-over-pandoc.md)、[ADR-005](../03_architecture/adr/ADR-005-server-side-whitelist-validation.md) |
| 對應情境 | SCN-009、SCN-010（UAT 主流程：組卷→匯出、避免重複出題，[uat_plan](../05_qa/uat_plan.md) §2.3） |
