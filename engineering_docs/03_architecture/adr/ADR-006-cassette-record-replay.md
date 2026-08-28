# ADR-006: LLM 錄放帶 record/replay (Cassette Record/Replay) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受
> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：§4 CI 證據 commit 更新（0ff47b4→f8f6574）、整合測試數更新（259→260）。修改處以〔修訂 2026-08-29〕行內標記。
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「CI 如何在零金鑰零網路下確定性重播 LLM 呼叫、鍵如何設計、miss 如何處置」；LLM 層操作細節歸 `docs/llm.md`，門檻政策歸 qa 追蹤簿。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 全案 LLM 呼叫僅經 `exam_pro/services/llm/` 單一出入口（`generateJson`／`embed`）；CI 要求零金鑰、零網路、零成本（NFR-003），且五個 eval suite 須可重複量測。
- **問題**: 真實模型呼叫不確定、要錢、要金鑰——直接進 CI 則測試不可重現且外洩風險高；以假資料 mock 則量測結果失真。
- **驅動因素/約束**:
  - 換模型或改 prompt 時，舊回應不得混入新報表。
  - cassette 不得含題幹全文或 PDF base64（NOTICE 第 4 條——repo 不含題庫內容）。
  - `LLM_MODE` 三值（`replay`／`record`／`live`），未設時預設 `replay`；非法值啟動即丟錯。

## 2. 考量的選項

### 選項一: HTTP 層攔截（nock 等泛用錄放）
- **描述**: 在 HTTP 層錄下 SDK 的請求／回應原文並重播。
- **優點**: 不需自建鍵規則，對程式碼零侵入。
- **缺點**: 鍵綁定請求原文——PDF base64 與題幹全文會整包寫入檔案，違反 NOTICE；SDK 升級改變 wire format 即全部失效；無語意可讀性。
- **成本/複雜度**: 低

### 選項二: 手寫假回應（fixture stub）
- **描述**: 對每個測試情境手寫模型回應。
- **優點**: 完全確定、可讀。
- **缺點**: 不是真實模型行為，eval 指標失去意義；維護量隨情境數線性成長。
- **成本/複雜度**: 中

### 選項三: 語意鍵 cassette（採用）
- **描述**: 以 `key = sha256(agent + modelId + promptTemplateHash + schemaHash + JSON.stringify(cacheKeyParts))` 為鍵，錄真實回應、落於 `eval/cassettes/<agent>/<key>.json`；`request` 只存摘要（字數／位元組數＋sha256）。
- **優點**: 換模型、改模板、改 schema（含 `config/chapters.js` 白名單）任一項變動即自動失效；不落地受版權保護內容；重播確定性。
- **缺點**: 需自建模板註冊表與逐節點的 `cacheKeyParts` 契約。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項三——語意鍵 cassette。

**理由**: 鍵的五段組成使「以舊模型量測的數據混入報表」在結構上不可能。模板原文經 `services/llm/templates.js` 註冊表取回並以 `sha256(模板原文)` 雜湊（裁決 S2-5）——模板改一個字 cassette 即失效；未註冊時退回 `sha256(識別名)` 弱雜湊並印警告，故識別名帶版號（`extract.v1`）。四個 LLM 節點（extract／classify／lint／verify）均須註冊。`cacheKeyParts` 逐節點凍結（介面第 5.2 條），例如 extract 為 `{ template, chunkNo, pdfSha256 }`——不含 PDF 內容。

**miss 政策**: replay miss 一律丟錯（訊息逐字凍結，指引執行 `npm run eval:record`），不靜默回退假資料；main 分支的 miss 視為 CI 錯誤（NFR-004），fork PR 降為 warning 是 CI 層的判斷，不在 `services/llm` 內。`meta.fixtureHash` 與現行 fixture 不符時印警告但仍回放——few-shot 鍵只納入已排序 id 清單，此欄位是題幹改寫的唯一提醒管道。

## 4. 後果

- **正面**: CI 全綠 @ f8f6574 且全程零金鑰零網路；整合 260 項與五個 eval suite 可確定性重播（f7a9c41 實測〔修訂 2026-08-29〕）；成本統計（`tokenOut + tokenThinking`）隨 cassette 保存。
- **負面**: 換模型或改模板須在本機重錄全部相關 cassette（刻意設計）；`JSON.stringify` 依插入順序序列化，agent 須以固定鍵順序組 `cacheKeyParts`。
- **影響範圍**: `exam_pro/services/llm/`、`exam_pro/eval/cassettes/`、`exam_pro/scripts/record_cassettes.js`、CI workflow。
- **重新評估觸發**: 接入第二家供應商（A-T17 預留）或 embedding 模型升級需重灌向量欄位時。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | NFR-002、NFR-003、NFR-004、DEC-008、DEC-009 |
| 影響範圍 | `exam_pro/services/llm/`、`exam_pro/eval/`、`../../05_qa/qa_tracker.md` |
| 取代關係 | 無；為 ADR-003 管線與 ADR-007 助教的可測試性前提 |
