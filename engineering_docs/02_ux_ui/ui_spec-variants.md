# UI 規格書 (UI Spec) - 相似題與變式題 - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（本篇對應 `<section id="variants">`，實作 `exam_pro/public/js/variants.js`）
> **定位:** 本文件定義相似題／變式題面板的區塊、狀態與「檢索命中 vs 生成」兩種呈現差異；入口按鈕歸 `ui_spec-students.md`，核准操作歸 `ui_spec-review.md`，檢索與閘門機制歸 `../03_architecture/`。

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

老師從學生分頁的「最近錯題」對某一題「找相似」（庫內既有題，零 LLM 費用）或「出變式」（檢索優先、池不足才生成）。面板要說清楚三件事：這次有沒有花錢、每一題卡在哪一關、實際花了多少（`cost_usd` 為實際值，非預估）。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 學生分頁按鈕，經 `examapp:variant-request` 事件抵達（`students.js` 與本 module 不互相 import，僅以事件通訊） |
| 出口 | 待複核分頁（存在待核准／待複核題時提供「前往複核分頁」按鈕，見 `ui_spec-review.md`） |

## 2. 版面配置 (Layout)

```text
標題列（eyebrow + h2「相似題與變式題」+ 說明文）
出變式設定列（生 N 題下拉 #varCount ＋ 難度調整下拉 #varDelta ＋ 說明）
面板本體 #varBody（藍本題摘要 → 結果區：狀態條／題目卡清單／收尾提示）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 生成題數 | select | 送出為 body `count` | 選項 1／2／3（上限＝`VARIANT_MAX_PER_REQUEST` 預設）；預設 1，與 API body 預設逐字一致 |
| 難度調整 | select | 送出為 body `difficulty_delta` | −1／0／+1；預設 0 |
| 藍本題摘要 | 卡片 | 事件 `detail`（question_id、chapter、question_text） | 面板頂端固定顯示 |
| 題目卡 | 卡片（相似題與變式題共用） | `results[]` 或 `items[]` | `#id`（或 `jq #jq_id`）／學科／章節／題型／★難度／score；題幹經 `renderMath` |
| 逐題狀態 chip | 徽章 | `job_questions.state` 九值＋`review_reason` 八值 | 六個中間狀態合併為「生成中／檢查中」；saved＝已入庫（emerald）、needs_review＝待核准／待複核（amber／rose）、rejected＝失敗（rose） |
| 任務狀態條 | 文字條 | `GET /api/jobs/:id`（state、counts、elapsed_ms、cost_usd、budget_usd） | `jobSummary()` 彙整；成本以 `formatCost()` 顯示為 `$0.0000` 格式（0 亦顯示金額，null 顯「—」） |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 找相似 | 學生分頁按鈕（`action:'similar'`） | `GET /api/questions/:id/similar?k=5`（可帶 student_id）；只讀庫內既有題 | 單一使用者（x-api-key） |
| 出變式 | 學生分頁按鈕（`action:'variant'`） | `POST /api/questions/:id/variants`（count、difficulty_delta、student_id、`force_generate:false`）；依 200/202 分流 | 同上 |
| 前往複核分頁 | 終態存在待核准／待複核題 | `app.showSection('review')` 或捲動至 `#review` | 同上 |

**檢索命中 vs 生成的呈現差異（本頁核心）：**

| 分支 | 回應 | 呈現 |
| :--- | :--- | :--- |
| 檢索命中 | 200 `mode:'retrieved'` | emerald 提示「庫裡就有 N 題夠像的，沒有生成、沒有花錢」＋題目卡清單，立即結束 |
| 進入生成 | 202 `mode:'generating'` | indigo 狀態條（任務編號＋輪詢節奏）→ 每 2 秒同時輪詢 `GET /api/jobs/:id` 與 `GET /api/jobs/:id/questions?limit=20`，逐題畫 chip，最多 60 秒 |
| 請求合流 | 202 `existing:true` | 「這題已經在生成中了，接回任務 #id（沒有重複付費）。」（裁決 S3-8） |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| 初始 Empty | 灰底置中提示 | 「還沒有任何請求。到上面的『學生』分頁…按『找相似』或『出變式』。」 |
| Loading | slot 文字 | 「查詢中…」／「請求中…」 |
| 相似題 Empty | 白底置中提示 | 「庫裡沒有夠像的題目。可以改用『出變式』讓系統生成（會花錢）。」 |
| 生成終態（全入庫） | emerald 狀態條 | 「任務 #id 已完成：入庫 X 題…實際花費 $…（預算 $…）。」＋「全部題目都已入庫，可以直接組卷了。」 |
| 生成終態（有停等） | amber 狀態條 | 待核准（awaiting_approval＝六閘門全過、政策停等）與待複核（其餘七種 reason）分開計數，附前往複核按鈕 |
| 輪詢逾時 | amber 狀態條 | 「已經等了 60 秒還沒跑完，先不等了。任務 #id 仍在背景執行…」（逾時不等於失敗） |
| Error（404） | amber 提示 | 「找不到這一題，或 FEATURE_SIMILAR／FEATURE_VARIANTS 未開啟（路由不掛載時同樣回 404）。」 |
| 旗標關閉 | 整段不渲染（非隱藏） | console info 提示 `FEATURE_VARIANTS` 未開啟 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| `[data-variant-action]` 按鈕群 | 依所在分頁樣式 | 輪詢期間一律停用（後端合流是最後保險，前端不允許連按） | 狀態條逐輪更新 | 終態／逾時／HTTP 錯誤時解鎖 |
| 輪詢 | — | — | 單輪網路失敗靜默略過，下一輪重試 | `GET /api/jobs/:id` 非 2xx 即以 rose 收尾 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| count／difficulty_delta | 僅由下拉產生；下拉缺失時回預設值（1／0），前端不產生非法值也不攔非法值（400 為伺服器職責） | 伺服器 `message` 原樣顯示 | 送出時讀取 |
| 事件 detail | `question_id` 必須為整數，否則忽略事件 | 無（靜默） | 事件抵達 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 設定列 `flex-wrap`；卡片單欄堆疊。
- **鍵盤操作:** 下拉與按鈕皆原生元件；「前往複核分頁」為 `<button>`。
- **ARIA / 對比:** 兩個下拉具 `aria-label`（「一次生成幾題」「難度調整」）；chip 一律附文字標籤與 detail 說明，不以顏色單獨傳達；伺服器文字一律 `textContent`。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| 設計稿 | 無獨立設計稿；實作即 SSOT（`exam_pro/public/js/variants.js`） |
| Mock 預覽 | `?mock=1`：相似題一組、出變式 202 後依三個快照走完 queued→processing→done（含 awaiting_approval 與 duplicate 兩種結局） |
| 已知限制 | 待核准不在本頁核准，一律導向複核分頁；中間六狀態不逐一顯示節點名（詳情屬 job 頁） |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-010、FR-011（上游決策 DEC-006、DEC-008；NFR-002、NFR-004） |
| 對應情境 | SCN-014（變式題池不足才生成、偏題閘門攔截，[prd §3.2](../01_requirements/prd.md)） |
| 契約來源 | `docs/interfaces-stage3.md` 第 3、7、11 條、`docs/interfaces-stage1.md` 第 6 條、裁決 S3-8／S3-R24（repo 內文件） |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-010／FR-011 列）、`../05_qa/qa_tracker.md`（TC-010-*、TC-011-*） |
