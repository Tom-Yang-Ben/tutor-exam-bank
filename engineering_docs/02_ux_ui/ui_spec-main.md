# UI 規格書：主頁 (UI Spec – Main) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍
> 🛠 **2026-08-29 修訂**（PR #3/#6/#7 程式碼同步）：§2 版面配置整節重寫為 5 個 `.app-view` 視圖＋hash 路由（原「Topbar＋Hero」「右欄 #paper lg:sticky」ASCII 圖已刪除——Hero 區塊於 commit 995f444 自程式碼移除）；§1 入口／出口改為視圖切換語意（「先切視圖再捲動」）；§3 章節欄位改科目→冊→單元三層選單並新增 #volume／#paper_volume 列；§3 新增 source_type 三欄位（#source_type／#pdf_source_type／#paper_source_scope）與題庫卡片來源徽章；§4 編輯 Modal 補題目來源改標；§8 刪除「導覽列 md 以下隱藏」與「組卷卡 lg:sticky」，改橫向捲動與獨立視圖；§10 補 FR-017。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（`ui_spec-<page>.md`）
> 本文件定義主頁（`exam_pro/public/index.html` inline script）的區塊、狀態與互動：手動建題、PDF 上傳拆題入口、題庫管理與組卷（草稿→確認）。複核佇列見 [ui_spec-review.md](./ui_spec-review.md)；學生分頁見 [ui_spec-students.md](./ui_spec-students.md)。

## 目錄

- [1. 頁面目的 (Page Purpose)](#1-頁面目的-page-purpose)
- [2. 版面配置 (Layout)](#2-版面配置-layout)
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

視圖切換動效（2026-08-29）：切換時新視圖以 GSAP 淡入＋上移歸位（`autoAlpha` 0→1、`y` 28→0，0.45s `power2.out`），舊視圖即時隱藏；首次載入、同視圖內子錨點不觸發動效。守門條件 `motionOn()`：`prefers-reduced-motion: reduce` 或 GSAP CDN（jsdelivr，釘 3.13.0）載入失敗時退回硬切，功能不依賴動畫；動畫結束 `clearProps` 歸還 inline style，快速連切由 `overwrite: 'auto'` 處理。

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
| 學科（#subject／#paper_subject／#mgr_subject） | select | 固定值：數學／物理 | 切換時連動冊別與單元下拉（三層選單）〔修訂 2026-08-29〕 |
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
| 組卷預覽（#resultBox） | panel | `POST /api/generate-paper`（`dry_run:true`） | 每題含題號、題型、★難度、`#id`、題幹、參考答案、「換這題」 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 儲存題目 | #questionForm submit | `POST /api/questions`；成功後表單 reset、章節重載 | 單人系統，`x-api-key` 由 `<meta name="api-key">` 注入 |
| AI 解析 PDF | #uploadPdfBtn | `POST /api/analyze-pdf` → 預覽卡（每題就地編輯）；FEATURE_PIPELINE 開啟時被 review.js 以 capture 攔截改送 `POST /api/jobs` | 同上 |
| 批量入庫 | #batchSaveBtn | `POST /api/batch-save-questions`；`rejected[]` 標紅留在預覽、已入庫題移除 | 同上 |
| 新增學生 | ＋ 新增 → 建立 | `POST /api/students`；成功後選單重載並選中新學生 | 同上 |
| 生成試卷（草稿） | 生成專屬特訓試卷 | `dry_run:true`，整段不寫庫；渲染預覽卡 | 同上 |
| 換這題／整卷重抽 | 預覽卡按鈕 | 加入 `exclude_ids` 重新 dry_run／排除清單歸零重抽；皆不「燒題」 | 同上 |
| 確認出卷 | ✔ 確認出卷 | `POST /api/confirm-paper` 建卷並寫 attempts；成功後顯示下載與「立即批改」 | 同上 |
| 下載 Word | 下載 Word 考卷 | `POST /api/download-word` → Blob 下載 `.docx` | 同上 |
| 編輯／刪除題目 | 題卡 ✏️／🗑️ | Modal 內 `PUT /api/questions/:id`；`confirm()` 後 `DELETE`；Modal 於共用編輯器外額外掛「題目來源」改標列（:908-917，不動 `createQuestionEditor`，FR-017）〔修訂 2026-08-29〕 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | 章節下拉「-- 載入中 --」；學生下拉「-- 載入學生中… --」；#pdfStatus 靛藍字 | 「⏳ 正在分析整份 PDF 所有題目，AI 計算答案中...」 |
| Empty | 題庫列表虛線框空狀態卡；學生下拉引導文案 | 「沒有符合條件的題目」＋「調整上方篩選條件後再試一次」；「-- 還沒有學生，先按『＋ 新增』 --」 |
| Error | #pdfStatus 轉紅；組卷失敗顯示於 #resultBox；其餘走 toast（error 色調） | 「❌ 分析失敗：{message}」「❌ 出題失敗原因：{message}」「連線失敗，請確認伺服器狀態」 |
| 進行中（草稿） | #resultBox 琥珀色提示列 | 「尚未寫入——換題、重抽都不會扣掉題庫池；按『確認出卷』才會建卷並記入不重複紀錄。」 |
| 部分失敗 | 未通過題卡加 `ring-rose` 標紅、前置原因列；通過題自清單移除 | 「⚠ 未寫入：{reason}」 |
| Success | toast（success 色調）；確認出卷後標題「✨ {paper_title}」 | 「題目已成功儲存」「🎉 所有題目已成功寫入資料庫！」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 上傳／入庫／儲存／確認按鈕 | 色階加深 | 請求期間 `disabled = true`（防重複點擊），`finally` 復原 | 文案不變，狀態列顯示進度 | toast＋狀態列轉紅 |
| 換這題 | 底色變化 | — | 失敗（多為庫存不足 400）時把排除退回、預覽維持原狀 | 沿用 dry_run 失敗顯示 |
| 確認出卷 | — | 請求期間 disabled | — | 409（預覽過期）自動重新 dry_run 一份新預覽 |
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
| Design Tokens | 同檔 `:root` CSS 變數（--ink／--brand／--mint 等）＋Tailwind CDN |
| 元件對照 | `createQuestionEditor`／`showToast`／`apiFetch` 等經 `window.ExamApp` 供各分頁 module 共用 |
| 已知限制 | Tailwind 與 MathJax 走 CDN，離線環境無樣式與公式渲染 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-001（上傳入口）、FR-007、FR-008、FR-009、FR-014（新增學生入口）、FR-017（source_type 題源標記，PR #7）〔修訂 2026-08-29〕；NFR-001 |
| 對應決策 | DEC-001、DEC-002、DEC-003、DEC-007 |
| 對應 ADR | [ADR-004](../03_architecture/adr/ADR-004-custom-latex-ooxml-over-pandoc.md)、[ADR-005](../03_architecture/adr/ADR-005-server-side-whitelist-validation.md) |
| 對應情境 | SCN-009、SCN-010（UAT 主流程：組卷→匯出、避免重複出題，[uat_plan](../05_qa/uat_plan.md) §2.3） |
