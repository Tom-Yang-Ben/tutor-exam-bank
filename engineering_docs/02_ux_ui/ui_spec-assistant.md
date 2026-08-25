# UI 規格書 (UI Spec) - 對話式助教 - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（本篇對應 `<section id="assistant">`，實作 `exam_pro/public/js/assistant.js`）
> **定位:** 本文件定義對話式助教分頁的區塊、狀態與工具軌跡呈現；主控 agent 的決策迴圈與五個只讀工具歸 `../03_architecture/adr/ADR-007-assistant-no-native-function-calling.md`，正式出卷流程歸 `ui_spec-main.md`。

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

老師以自然語言向助教提問（查學生弱點、白話搜題、找相似題、替學生試算不重複的卷）。產品主張：**工具調用軌跡是內容，不是雜訊**——每句回覆下方完整攤開該輪主控 agent 叫了哪些工具、帶什麼參數、拿回什麼。助教僅能查詢與預覽（五個只讀工具）；出卷僅 dry-run 預覽，實際出卷、出變式仍由老師在各分頁按確認。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 主頁 `<section id="assistant">` 錨點（`FEATURE_ASSISTANT` 開啟時渲染） |
| 出口 | 無自動跳轉；助教以文字建議老師前往組卷／變式等分頁執行實際動作 |

## 2. 版面配置 (Layout)

```text
標題列（eyebrow + h2「對話式助教」+ 能力邊界說明文）
對話紀錄 #asstLog（max-h 28rem 可捲動：氣泡 → 每句助教回覆下附 <details> 工具軌跡）
輸入列（單行文字框 #asstInput ＋ 送出按鈕 #asstSend）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 使用者氣泡 | 靠右、indigo 底 | 本地輸入 | `whitespace-pre-line`；純 textContent |
| 助教氣泡 | 靠左、白底 | `POST /api/assistant` 回應 `reply` | textContent 注入後經 `renderMath` 渲染數學式 |
| 工具軌跡 | `<details>` 摺疊區塊 | 回應 `steps[]`（tool、args、ok、result） | summary 顯示「工具調用軌跡（N 步）：tool1 → tool2…」；零步顯示「（沒有呼叫工具）」；預設收合 |
| 單步明細 | 卡片＋`<pre>` | `steps[].args`／`result` | `tool(args JSON)` 一行；失敗步以 rose 色＋「⚠ 失敗」標記；result 以 `JSON.stringify(…, null, 1)` 呈現，`max-h-40` 可捲動 |
| 對話歷史 | 記憶體陣列 | 送出時附 `history` 末 8 輪（`HISTORY_KEEP`，同後端 `MAX_HISTORY`） | 僅存活於頁面；重整歸零（助教無長期記憶，介面如實呈現） |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 送出提問 | 按鈕點擊或輸入框 Enter（`isComposing` 時不送，避免注音選字誤觸） | `POST /api/assistant`（body `{message, history}`）；回覆氣泡＋工具軌跡追加至紀錄，自動捲至底部 | 單一使用者（x-api-key） |
| 展開／收合軌跡 | 點擊 `<details>` summary | 顯示各步參數與結果 | 同上 |
| dry-run 預覽出卷 | 以對話請求（例：「幫小華預覽一張向量內積 5 題的卷」） | 助教經只讀工具回傳試算結果（僅預覽，不建立試卷、不寫入作答紀錄）；實際出卷至主頁執行 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| 初始 | 助教開場氣泡 | 「你好，我是題庫助教。我可以查學生弱點、用白話搜題、找相似題、替學生試算不重複的卷（僅預覽）。想從哪裡開始？」 |
| Loading | 灰字思考提示（回覆後移除）；送出鈕 disabled | 「助教思考中（主控 agent 決定要不要叫工具）…」 |
| Success | 助教氣泡＋軌跡區塊 | `reply` 原文 |
| Error（HTTP 非 2xx） | 助教氣泡（⚠ 前綴） | 伺服器 `message` 或「助教暫時無法回應」 |
| Error（連線失敗） | 助教氣泡（⚠ 前綴） | 「連線失敗，請稍後再試。」 |
| 工具步失敗 | 該步 rose 標記，對話不中斷 | 「⚠ 失敗」＋該步 result 原樣攤開 |
| 旗標關閉 | 整段不渲染（非隱藏） | console info 提示 `FEATURE_ASSISTANT` 未開啟 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 送出按鈕 | bg 轉 violet-700 | 等待回覆期間 disabled（opacity-40）防重複送出 | 思考提示顯示中 | finally 解鎖並將焦點還給輸入框 |
| 對話紀錄 | — | — | 每次追加後 `scrollTop = scrollHeight` | 錯誤同樣以氣泡入列，保留上下文 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| message | 必填（trim 後非空），空值靜默不送 | 無 | submit |
| message | ≤ 500 字（`MAX_MESSAGE`，與 `exam_pro/services/assistantService.js` 的 `MAX_MESSAGE_LEN` 一致） | 「一句最多 500 字。」（toast） | submit |
| history | 前端僅送末 8 輪；成功回覆後才寫入 history（失敗輪不入歷史） | 無 | 送出時切片 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 氣泡 `max-w-[85%]` 自適應；紀錄區固定高度捲動，輸入列固定在下方。
- **鍵盤操作:** Enter 送出（組字中不送）；`<details>/<summary>` 原生鍵盤可操作。
- **ARIA / 對比:** 輸入框具 `aria-label`「問助教」；伺服器回的所有文字一律 `textContent`，不進 `innerHTML`。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| 設計稿 | 無獨立設計稿；實作即 SSOT（`exam_pro/public/js/assistant.js`） |
| Mock 預覽 | 本頁無 `?mock=1` 攔截（與階段 3 三個 module 不同），預覽需後端在線 |
| 已知限制 | 對話歷史不持久化（重整歸零）；助教不能執行寫入動作，出卷僅 dry-run 預覽 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-016（上游決策 DEC-007、DEC-008、DEC-009；NFR-001、NFR-002） |
| 對應情境 | SCN-*（待補，見 `../05_qa/qa_tracker.md`） |
| 對應架構決策 | `../03_architecture/adr/ADR-007-assistant-no-native-function-calling.md` |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-016 列）、`../05_qa/qa_tracker.md`（TC-016-*） |
