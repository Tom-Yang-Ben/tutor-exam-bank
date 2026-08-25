# UI 規格書：主頁 (UI Spec – Main) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
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
| 入口 | 系統唯一入口頁；頂部導覽以錨點跳轉 `#create`／`#paper`／`#students`／`#assistant`／`#library` |
| 出口 | 同頁各分頁（複核 `#review`、學生 `#students` 等由 ES module 掛入空 `<section>` 錨點）；下載 `.docx` 為檔案出口 |

## 2. 版面配置 (Layout)

```text
Topbar（sticky 導覽＋系統就緒指示）＋ Hero（工作流三步說明）
#create ─ 左欄：手動建題表單＋PDF 上傳區（含預覽） │ 右欄 #paper：智慧組卷（lg:sticky）
#review / #students / #variants / #nlq / #assistant（空錨點，由各 module 掛載）
#library ─ 題庫管理（篩選列＋題目卡列表＋分頁器）
編輯 Modal（#editModal）／Toast 區（#toastRegion）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 學科（#subject／#paper_subject／#mgr_subject） | select | 固定值：數學／物理 | 切換時連動章節下拉 |
| 章節（#chapter／#paper_chapter／#mgr_chapter） | select | `GET /api/chapter-whitelist`（建題）；`GET /api/chapters`（組卷，僅有庫存章節） | 組卷側顯示「共 N 個」；無庫存顯示「(目前此科目無庫存題目)」 |
| 題型／難度 | select | 固定值：單選／多選／填空／計算（管理側另有證明）；難度 1–5 以 ★ 顯示 | — |
| 題目內容／標準答案 | textarea／input | `question_text`／`answer_text` | 支援 `$…$` LaTeX，MathJax 即時渲染 |
| 學生（#student_select） | select | `GET /api/students` → `items[]` | 顯示 `姓名（N 張卷）`；姓名另存 `dataset.name`（裁決 S4-1：學生用選的不用打的） |
| 題庫卡片 | card | `GET /api/questions?page&limit=10` | `#id`＋學科·章節＋題型＋★難度＋題幹＋答案；每頁 10 筆 |
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
| 編輯／刪除題目 | 題卡 ✏️／🗑️ | Modal 內 `PUT /api/questions/:id`；`confirm()` 後 `DELETE` | 同上 |

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

- **斷點行為:** `lg` 以上雙欄（7/5），組卷卡 `lg:sticky`；`sm` 以下單欄、篩選列縮為單欄格。導覽列 `md` 以下隱藏。
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
| 對應需求 | FR-001（上傳入口）、FR-007、FR-008、FR-009、FR-014（新增學生入口）；NFR-001 |
| 對應決策 | DEC-001、DEC-002、DEC-003、DEC-007 |
| 對應 ADR | [ADR-004](../03_architecture/adr/ADR-004-custom-latex-ooxml-over-pandoc.md)、[ADR-005](../03_architecture/adr/ADR-005-server-side-whitelist-validation.md) |
| 對應情境 | SCN-*（待補） |
