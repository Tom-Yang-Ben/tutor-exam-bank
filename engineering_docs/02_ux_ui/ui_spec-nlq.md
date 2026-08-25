# UI 規格書 (UI Spec) - 自然語言查題 - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（本篇對應 `<section id="nlq">`，實作 `exam_pro/public/js/nlq.js`）
> **定位:** 本文件定義自然語言查題框的區塊、狀態、文案與回寫規則；後端解析管線（規則主、LLM 輔、四級回退）歸 `../03_architecture/`，題庫管理主頁歸 `ui_spec-main.md`。

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

老師以一句話描述需求（例：「牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過」）查詢題庫。核心主張：老師必須看得見系統把句子理解成什麼，且能立即接手修正——解析結果一律回寫題庫管理的三個下拉。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 主頁 `<section id="nlq">` 錨點；`FEATURE_ASSISTANT` 之對話式助教亦可代為查題（見 `ui_spec-assistant.md`） |
| 出口 | 題庫管理列表（回寫下拉後觸發重查，見 `ui_spec-main.md`） |

## 2. 版面配置 (Layout)

```text
標題列（eyebrow + h2「用講的找題目」+ 說明文）
輸入列（單行文字框 #nlqInput ＋ 查題按鈕 #nlqBtn）
回應區 #nlqAnswer（提示條 → 結果清單）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 查詢輸入框 | text（maxLength 200） | 送出為 body `query` | placeholder 含字數上限 |
| 理解摘要 | 文字（提示條首行） | `filters` 八鍵 | `explainFilters()`：未抓到的條件也明講（「不分科」「不限章節」） |
| 解析路徑 | 文字 | `parse_path` 三值 | rules＝規則解析（未呼叫 LLM）／llm＝LLM 輔助／llm_failed＝LLM 失敗只用規則 |
| 回退等級 | 文字 | `fallback_level` 0–3 | 各級白話說明凍結於 `FALLBACK_NOTE`；伺服器 `warnings` 為逐字凍結原文，原樣顯示於說明之前 |
| 結果卡片 | 卡片清單 | `results[]` | `#id ／ 學科／章節 ／ 題型 ／ ★難度 ／ score`；題幹經 `renderMath` 渲染 |
| 相關度分數 | text | `results[].score` | `formatScore()`：`fallback_level === 3` 時為 `null`，顯示「—」而非 0.0000 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 查題 | 按鈕點擊或輸入框 Enter | `POST /api/questions/search-nl`（body `{query, limit:20}`）；成功後回寫下拉並渲染回應區 | 單一使用者（x-api-key） |
| 修正理解 | 手動改題庫管理下拉 | 依既有下拉 change 行為重查列表 | 同上 |

回寫規則（`dropdownWriteback`）：

- `filters.subject`／`chapters[0]`／`question_types[0]` 分別寫入 `mgr_subject`／`mgr_chapter`／`mgr_type`；章節選項由 `ExamApp.getChapterWhitelist()` 重建，不觸發 `mgr_subject` 的 change（避免三個下拉各觸發一次共三次查詢），最後僅對 `mgr_type` 觸發一次 change。
- 下拉容不下的條件（第 2 個以後的章節／題型、難度、排除某生）不悄悄丟棄，逐條列於提示條。
- 回寫章節不在白名單時補一個標註「（白名單未載入）」的 option，避免回寫靜默失效。

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | 回應區灰底置中文字；按鈕 disabled | 「查詢中…」 |
| 正常（level 0） | 灰底（slate）說明條＋結果清單 | 「系統理解成：…」＋解析路徑＋回退等級 |
| 降級（`llm_failed` 或 `fallback_level ≥ 1`） | 淡黃（amber）提示條 | 伺服器凍結 warning 原文＋該級白話說明（理解成什麼、為何退級） |
| Empty | 白底置中提示 | 「沒有查到題目。可以把條件講寬一點，或直接用上面的下拉手動篩選。」 |
| Error（HTTP 404） | amber 提示 | 「自然語言查題尚未上線…可加上 ?mock=1 用手寫假資料預覽版面。」 |
| Error（其他／連線失敗） | amber 提示 | 伺服器 `message` 或「連線失敗，請稍後再試。」 |
| 旗標關閉 | 整段不渲染（非隱藏） | console info 提示 `FEATURE_NLQ` 未開啟 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 查題按鈕 | bg 轉 indigo-700 | 查詢期間 disabled（opacity-40）防重複送出 | 回應區顯示「查詢中…」 | finally 解鎖按鈕 |
| 輸入框 | — | — | — | 空值／超長以 toast 提示，不送出 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| query | 必填（trim 後非空） | 「請先輸入一句話。」（toast） | submit |
| query | ≤ 200 字（`MAX_QUERY`，同時以 maxLength 前置限制） | 「query 最多 200 字。」（toast） | submit |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 輸入列 `flex-col` → `sm:flex-row`；卡片單欄堆疊。
- **鍵盤操作:** 輸入框 Enter 送出；按鈕為原生 `<button>` 可 Tab／Enter。
- **ARIA / 對比:** 提示以文字呈現、不倚賴色彩單獨傳達（amber 條同時有 ⚠ 前綴與說明文字）；伺服器文字一律 `textContent` 注入。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| 設計稿 | 無獨立設計稿；實作即 SSOT（Tailwind utility class 直寫於 `exam_pro/public/js/nlq.js`） |
| Mock 預覽 | `?mock=1` 內建三情境輪播（規則命中／LLM 失敗回退 1／embedding 失效回退 3），可離線做版面 |
| 已知限制 | 題庫管理僅單選下拉：多章節／多題型僅回寫第一個，其餘以提示條揭示 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-012（上游決策 DEC-006、DEC-008；NFR-001） |
| 對應情境 | SCN-*（待補，見 `../05_qa/qa_tracker.md`） |
| 契約來源 | `docs/interfaces-stage3.md` 第 6、7 條（repo 內文件） |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-012 列）、`../05_qa/qa_tracker.md`（TC-012-*） |
