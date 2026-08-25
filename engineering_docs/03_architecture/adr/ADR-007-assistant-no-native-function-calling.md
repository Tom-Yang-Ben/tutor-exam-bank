# ADR-007: 助教不用原生 Function Calling (Assistant without Native Function Calling) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「對話式助教的工具調用為何自建決策迴圈、參數與空結果如何處理」；兩種編排哲學的對照歸 [ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md)，介面呈現歸 `../../02_ux_ui/ui_spec-assistant.md`。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 階段 4 的對話式助教（`exam_pro/services/assistantService.js`，FR-016）處理形態無法預先設計的問題（「小明最弱的章節為何」「為小華預覽一張考卷」），編排交由主控 LLM 的 ReAct 迴圈，自行決定呼叫哪個工具、呼叫幾次、何時作結。
- **問題**: 工具調用機制的實作方式須決定——沿用供應商原生 function calling，或以既有 LLM 層自建；同時須解決參數傳遞與迴圈終止兩個實測問題。
- **驅動因素/約束**:
  - 全案 LLM 呼叫僅經 `services/llm` 單一出入口——record/replay、節流、成本統計都只寫一份（[ADR-006](./ADR-006-cassette-record-replay.md)）。
  - 五個工具均為唯讀；出卷僅能以 dry-run 預覽，實際出卷由使用者確認。
  - 全案底線一致：受限 JSON、工具唯讀、執行前伺服器端驗證（[ADR-005](./ADR-005-server-side-whitelist-validation.md)）。

## 2. 考量的選項

### 選項一: 供應商原生 function calling
- **描述**: 以 Gemini SDK 的 function calling 宣告工具，由供應商端管理調用格式。
- **優點**: SDK 原生支援，工具宣告即文件。
- **缺點**: 綁定單一供應商的請求格式；工具呼叫走 SDK 專屬回傳結構，既有 cassette 鍵規則與節流層無法直接沿用；A-T17 預留的跨供應商 adapter 需另建一套錄放。
- **成本/複雜度**: 中

### 選項二: responseJsonSchema 約束的決策迴圈（採用）
- **描述**: 主控每步輸出受限 JSON `{action, tool, args_json, reply}`（經 `responseJsonSchema` 約束），伺服器端解析並執行工具、把結果回填對話，直到主控作結或達步數上限。
- **優點**: record/replay、節流與未來的跨供應商 adapter 均直接沿用；每步輸出形狀固定、可被測試固定；工具白名單與參數驗證都在伺服器端。
- **缺點**: 決策迴圈、步數控制、錯誤回饋須自行實作。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項二，並附兩項配套決策。

**理由與配套**:

1. **不採用原生 function calling**——以 `responseJsonSchema` 約束的決策迴圈實作工具調用，使既有 LLM 層的全部橫切能力（cassette、節流、計費）零改動沿用；原生方案則綁定單一供應商的請求格式。
2. **參數以 `args_json` 字串傳遞**——實測 Gemini 的 structured output 對未定義 properties 的自由物件會回傳空物件，故工具參數不以巢狀物件宣告，改以 JSON 字串傳遞，由伺服器端解析並逐一驗證後才執行。
3. **「空結果亦為答案」明訂於系統提示**——初版主控會將步數配額耗費於同義詞重試；明訂「至多換一次措辭，仍為空即如實回報」後行為即符合預期。

失敗語意與拆題管線刻意不同：工具錯誤回饋給主控自行修正，達步數上限即截斷；管線側則是重試預算用盡進 needs_review。

## 4. 後果

- **正面**: 助教與拆題管線共用同一 LLM 層與測試基礎設施；工具調用軌跡完整呈現於介面；唯讀工具集使助教不具寫入權限，安全邊界明確。
- **負面**: 每步一次完整 LLM 呼叫，多步問題延遲與費用高於單次原生調用；`args_json` 雙重序列化增加一層解析失敗的可能（由伺服器端驗證吸收）。
- **影響範圍**: `exam_pro/services/assistantService.js`、`exam_pro/controllers/`（assistant）、`exam_pro/public/js/assistant.js`、`exam_pro/config/models.js`（MODEL_ASSISTANT）。
- **重新評估觸發**: 接入第二家供應商後若各家 function calling 收斂為同一開放格式，或步數／延遲成為使用瓶頸時。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-007、FR-016、NFR-001、NFR-002、NFR-003 |
| 影響範圍 | `exam_pro/services/assistantService.js`、`../../02_ux_ui/ui_spec-assistant.md`、`../engineering_tracker.md` |
| 取代關係 | 無；與 ADR-003 互為兩種編排哲學的對照 |
