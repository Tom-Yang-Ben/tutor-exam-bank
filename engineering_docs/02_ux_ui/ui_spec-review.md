# UI 規格書：複核佇列 (UI Spec – Review) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（`ui_spec-<page>.md`）
> 本文件定義複核分頁（`exam_pro/public/js/review.js`，掛入 `index.html` 的空錨點 `<section id="review">`）的區塊、狀態與互動：拆題任務進度列與 needs_review 佇列的 approve／reject。上傳按鈕本體屬 [ui_spec-main.md](./ui_spec-main.md)；本檔涵蓋 FEATURE_PIPELINE 開啟後對它的接管行為。

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

老師處理拆題管線判定有疑慮的題目：每題附機器產生的具體原因，30 秒內能決定「修正入庫」或「略過」。通過所有閘門的題已自動入庫，不經過這裡。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 主頁捲動至 `#review`；拆題任務完成時自動刷新本佇列 |
| 出口 | 修正入庫後題目進入題庫（`#library`）；同頁其他分頁 |

## 2. 版面配置 (Layout)

```text
上傳區（主頁）追加：#jobStatusLine 任務進度列（輪詢更新）
#review section ─ 標題「待複核（N 題）」＋原因篩選下拉＋重新整理
  └ #reviewEmpty 空／錯誤狀態列
  └ #reviewList 複核卡片流（每卡：jq 標頭 → 原因列 → 題幹預覽 → 動作列 → 展開的編輯區）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 任務進度列（#jobStatusLine） | status bar | `GET /api/jobs/:id`（每 3 秒輪詢） | `任務 #id（狀態）：已入庫 N／待複核 M／處理中 K　·　秒數　·　$cost / $budget`；rejected>0 才顯示不採用數 |
| 任務狀態 | enum→文案 | `jobs.state` 五值 | queued 排隊中／extracting 拆題中／processing 逐題處理中／done 已完成／failed 失敗 |
| 原因篩選（#reviewReasonFilter） | select | `GET /api/review?reason=` | 「全部原因」＋八種 needs_review 原因 |
| 待複核數（#reviewCount） | number | `GET /api/review?limit=50` 的 `items.length` | approve／reject 成功後就地 −1 |
| 原因列 | badge＋句子 | `review_reason`＋`payload` | 短標籤（八種原因對應文案與色調：amber／rose／indigo／slate）＋`reasonSentence` 生成的具體一句（如「驗證模型算出 X，拆題模型抄的是 Y」「與 #128 重複」） |
| 題幹預覽 | text | `items[].stem_preview` | MathJax 渲染 |
| 編輯區 | editor | `GET /api/review/:jq_id` 的 `payload` 經 `payloadToQuestion` 攤平（lint 修過的文字、classify 的章節優先） | 沿用主頁 `createQuestionEditor`；附重試紀錄一行（如 `verify×1`） |

八種 `review_reason` 與標籤：chapter_invalid 章節不在白名單／formula_unparsable 公式無法解析／answer_mismatch 答案對不上／duplicate 與既有題目重複／schema_invalid 欄位不合格／budget_exceeded 超出成本上限／provider_error 供應商錯誤／awaiting_approval 等待人工確認。

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 上傳 PDF（接管） | #uploadPdfBtn（capture＋stopImmediatePropagation，不改舊 handler） | `POST /api/jobs`（欄位名 `pdf`）→ 啟動 3 秒輪詢；`existing:true` 時提示接回既有任務、沒有重複付費 | 單人系統，`x-api-key` |
| 篩選／重新整理 | 下拉 change／按鈕 | 重載 `GET /api/review` | 同上 |
| 展開修正 | 卡片按鈕 | `GET /api/review/:jq_id`；原因列換成完整 payload 版本，展開編輯器；再按一次收起 | 同上 |
| 修正入庫（approve） | 編輯區綠色按鈕 | `POST /api/review/:jq_id/approve`（含編輯後欄位＋`accept_plain_text`＋`merge_into:null`）；成功移除卡片、計數 −1 | 同上 |
| 略過（reject） | 卡片按鈕 | `POST /api/review/:jq_id/reject`；成功移除卡片、計數 −1 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | #reviewEmpty 顯示；上傳後 #pdfStatus 靛藍字 | 「載入中…」「⏳ 已送出，正在排隊拆題…」「✅ 已建立任務 #N，每 3 秒更新一次進度。」 |
| 進行中（counts 無意義） | queued／extracting 時進度列轉琥珀色、**不顯示計數**（裁決 S2-22：此時 counts 必為 0，顯示會誤導） | 「已排隊，等待 worker 認領」「正在拆題，尚未逐題處理」 |
| Empty | #reviewEmpty | 「目前沒有待複核的題目。」 |
| Error | 輪詢非 2xx 即停止並 toast；載入佇列失敗顯示於 #reviewEmpty | 「查詢任務進度失敗」「連線失敗，請稍後再試。」 |
| API 未上線 | 404 專屬文案（區分「未合入」與「壞掉」） | 「複核 API 尚未上線（GET /api/review 回 404）。可加上 ?mock=1 用手寫假資料預覽版面。」 |
| 旗標關閉 | 上傳區維持舊 /analyze-pdf 流程；複核區只留一句說明 | 「FEATURE_PIPELINE 未開啟：上傳區仍走舊的 /analyze-pdf 流程，複核佇列不會有資料。」 |
| Success | done 時 toast＋自動刷新佇列；failed 時 toast 引導看進度列 | 「拆題完成：已入庫 N 題，待複核 M 題。」「任務失敗，請看任務狀態列的說明。」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 上傳按鈕 | — | 送出後 disabled，任務到 done／failed 或送出失敗時復原 | 進度列每 3 秒更新；網路瞬斷不中止輪詢（下一輪再試） | 狀態列轉紅＋toast |
| 展開修正 | 底色變化 | 請求期間 disabled | — | toast 顯示 `{message}` |
| 修正入庫 | 色階加深 | 請求期間 disabled（防重複入庫） | — | 400 帶 `errors[]` 時逐條列出（`rule：msg`）；merged 時顯示「已併入 #id」 |
| 略過 | 底色變化 | 請求期間 disabled | — | toast 顯示 `{message}` |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| PDF 檔案 | 必須先選檔 | 「請先選取 PDF 檔案」 | 點擊上傳 |
| 修正後欄位 | 伺服器端白名單硬驗證（ADR-005）；前端不預檢，原樣轉述 400 的 `errors[]` | 「{message}（{rule}：{msg}；…）」 | approve 回應後 |
| 公式降級 | `accept_plain_text` 勾選才允許公式降級成純文字入庫 | 未勾且公式無法解析時由後端 400 擋下 | approve 回應後 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 卡片流單欄，寬度隨容器；標題列 `flex-wrap`，窄幅時篩選控制換行。
- **鍵盤操作:** 全部為原生 `<button>`／`<select>`，Tab 順序依 DOM；展開／收起同一顆按鈕切換。
- **ARIA / 對比:** 原因列以「色調＋短標籤＋具體句子」三重編碼，不單靠顏色；toast 沿用主頁 `aria-live="polite"` 區。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/js/review.js`（骨架全由 JS 建立；`index.html` 僅一個空錨點） |
| 元件對照 | 經 `window.ExamApp` 橋接沿用主頁 `apiFetch`／`showToast`／`renderMath`／`escapeHtml`／`createQuestionEditor` |
| 本機預覽 | `?mock=1` 走檔內假資料（六種原因各一張卡）；`?pipeline=1` 本機手動開旗標 |
| 已知限制 | 佇列一次最多取 50 筆（`REVIEW_LIMIT`），無分頁器 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-001（jobs 狀態機與輪詢）、FR-006（八種原因、approve/reject）；NFR-002（成本顯示）、NFR-004 |
| 對應決策 | DEC-005、DEC-008 |
| 對應 ADR | [ADR-003](../03_architecture/adr/ADR-003-code-orchestrated-agent-pipeline.md)、[ADR-005](../03_architecture/adr/ADR-005-server-side-whitelist-validation.md) |
| 對應情境 | SCN-011（部分入庫：87 題入庫、3 題附原因進佇列）、SCN-012（重試預算用盡轉 needs_review），見 [prd §3.2](../01_requirements/prd.md) |
