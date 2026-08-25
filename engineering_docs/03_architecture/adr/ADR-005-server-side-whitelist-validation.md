# ADR-005: 伺服器端白名單驗證 (Server-Side Whitelist Validation) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「LLM 輸出為何不能直接入庫、防線如何分層」；管線整體結構歸 [ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md)，系統全貌歸 sad。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 拆題結果由 Gemini 以 JSON 回傳後寫入題庫；組卷（`exam_pro/controllers/examController.js`）以 `WHERE subject = ? AND chapter = ?` 精確比對抽題。
- **問題**: LLM 輸出是自然語言而非型別化 API——同一份考卷，模型可能寫「圓方程式」「圓的方程式」「圓與直線」。章節名一旦漂移，題目即成為撈不出來的資料，組卷功能失效。改造前曾實際發生單一題目格式錯誤導致整批請求以 400 失敗的事故。
- **驅動因素/約束**:
  - A-T0 spike 實測：白名單只寫在 prompt，三次全部回傳白名單外的章節名——prompt 不構成保證。
  - AI 輸出屬不可信輸入，且會落地為 DB 資料、再流入 Word 匯出的 XML 產生流程。
  - `responseJsonSchema` 的 enum 退路（收到 400 時拆掉 enum 改寫入 prompt、回 `schemaFallback: true`）只是讓流程不中斷，不能作為唯一防線。

## 2. 考量的選項

### 選項一: 僅以 prompt 約束（改造前現狀）
- **描述**: 在 prompt 內列出章節白名單與格式要求，`JSON.parse` 成功即入庫。
- **優點**: 實作最簡，無額外程式碼。
- **缺點**: 模型可以不照做（spike 三次全數違規）；白名單在 prompt 與程式各維護一份，逐漸不一致；錯誤無法歸因。
- **成本/複雜度**: 低

### 選項二: 僅依賴 structured output（schema enum）
- **描述**: 以 `responseJsonSchema` 的 enum 強制章節名，信任 SDK 層的約束。
- **優點**: 違規率低於純 prompt。
- **缺點**: schema 退路啟用時 enum 會被拆掉；`question_type`、難度收斂、LaTeX 語法等約束無法全數以 schema 表達；仍屬單點防線。
- **成本/複雜度**: 低

### 選項三: 兩層防線＋伺服器端硬驗證（軟約束 + 硬約束）
- **描述**: prompt／schema 為軟約束（「請求」）；`exam_pro/config/chapters.js` 白名單、`agents/schemas/*.json` 的 ajv 驗證與 `questionController.batchSaveQuestions` 逐題驗證為硬約束（入庫的門）。
- **優點**: 行為由一般程式碼定義並被 1,415 項單元測試固定；白名單單一真相；`schemaFallback` 情境下閘門不放水。
- **缺點**: 需維護 schema 與驗證碼；白名單變更牽動 cassette 鍵（見 [ADR-006](./ADR-006-cassette-record-replay.md)）。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項三——兩層防線，伺服器端白名單硬驗證為入庫的唯一保證。

**理由**: prompt 不是保證，只有伺服器端驗證才是。約束不只章節：`question_type` 限五種、`difficulty` 經 `normalizeDifficulty` 收斂為 1–5 整數、LaTeX 強制 `\frac{}{}` 而非斜線——最後一條與自製 OOXML 解析器（[ADR-004](./ADR-004-custom-latex-ooxml-over-pandoc.md)）的輸入域刻意對齊。早期「一題不合格即整批退回」的粒度問題於階段 2 以**部分入庫**解決：一批 90 題中若 3 題有疑慮，其餘 87 題照常入庫，3 題附具體原因（needs_review 八種原因之一）進入人工複核佇列。

## 4. 後果

- **正面**: 組卷的精確比對可靠；pipeline gate_pass_rate 1.00、saved_rate 0.90（門檻 ≥0.87）；單題失敗不再拖垮整批。
- **負面**: 新增章節須改 `config/chapters.js`，連動 schemaHash 使 classify cassette 失效需重錄；驗證碼與 schema 為持續維護成本。
- **影響範圍**: `agents/`（各節點 schema）、`controllers/questionController.js`、`config/chapters.js`、複核佇列（FR-006）。
- **重新評估觸發**: 章節白名單改為多科目動態管理、或供應商 structured output 能可靠承載全部約束時。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-005、FR-002、FR-006、FR-007、NFR-004 |
| 影響範圍 | `exam_pro/config/chapters.js`、`exam_pro/agents/schemas/`、`../engineering_tracker.md` |
| 取代關係 | 無；與 ADR-003、ADR-004、ADR-006 互相配套 |
