# ADR-009: 決定性原卷文字層比對 (Deterministic Source-Text Check) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-15 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受（實作於 feat/source-check；需求側 DEC-013 待 Owner 簽核）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「拆題抄錯題幹時，為何以決定性的原卷文字層比對攔截、而非再請一個 LLM 複驗，以及為何預設 enforce」；演算法、規則與校準數字歸 [`docs/source-check.md`](../../../docs/source-check.md)，節點合約歸 `docs/interfaces-stage2.md` 第 3.3 條。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 2026-09-15 以八份原卷逐題核對題庫，現行管線入庫的題有 4 題把題幹或選項抄錯（常數多負號、向量分量多負號、解的分量正負號錯、選項分母漏字母），另在被判重複的重拆題中發現 2 筆（選項指數多負號、選項整排前移）。verify 節點只比對答案、不比對題幹（[ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md) 的閘門設計），抄錯的題幹會讓正確答案看起來像錯。
- **問題**: 入庫前如何發現「題幹與原卷不符」，且不增加 LLM 成本、不讓 cassette 失效、不在 CI 引入非確定性。
- **驅動因素/約束**:
  - 抄錯的型態集中在正負號與漏字母——這是字元層級的差異，不需要理解題意。
  - PDF 在全部 chunk 拆完後即刪檔（`workers/jobRunner.js`），比對所需的原卷資訊必須在 extract 階段保存。
  - 誤報的代價是老師多看一題；漏報的代價是錯題入庫。單人使用、複核佇列量小，owner 明確要求攔下抄錯。
  - 約三分之一題目無法可靠比對（中文字太少、掃描檔、文字層排版打散），比對器必須能誠實地「跳過」。

## 2. 考量的選項

### 選項一: 再請一個 LLM 對照 PDF 複驗題幹
- **描述**: verify 之外新增一個節點，把 PDF 頁面與拆題結果一起送模型，請它指出不一致。
- **優點**: 能處理掃描檔與版面複雜的題；可理解等價改寫。
- **缺點**: 每題多一次多模態呼叫的成本；同家族模型對同一份 PDF 容易犯同樣的錯（抄錯本身就是模型讀 PDF 的產物）；結果非確定，需要錄 cassette、門檻難以校準，誤報率無法在 CI 釘住。
- **成本/複雜度**: 高

### 選項二: 決定性文字層比對（採用）
- **描述**: extract 階段以 mupdf 讀取該 chunk 的文字層，用中文字 5-gram 定位每題段落並只保存片段；lint 之後的零成本節點 `source_check` 將題幹正規化後比對負號數量與小寫字母、數字的多重集合，依校準過的規則判定。
- **優點**: 零模型成本、不動 prompt 與 schema（cassette 不失效）；純函式，單元測試可用公開樣卷斷言 0 誤報；判定理由可以寫成具體的一句話（「負號比原卷多 1 個」「漏掉字母 m」）。
- **缺點**: 掃描檔與中文字太少的題無法比對（校準時約 46% 跳過）；只能抓字元層級的抄錯，抓不到「選項整排前移」這類結構性錯誤；文字層缺負號字形的 PDF 需要字型對映或停用負號規則。
- **成本/複雜度**: 中

### 選項三: 不做，只靠人工抽查
- **描述**: 維持現狀，由老師使用時自行發現。
- **優點**: 零實作成本。
- **缺點**: 錯題已進入題庫與試卷，學生拿到才發現；與 DEC-005「錯誤要能歸因到個別步驟」相違。
- **成本/複雜度**: 低

## 3. 決策

**選擇**: 選項二——決定性原卷文字層比對，不用 LLM 複驗；預設 `SOURCE_CHECK_MODE=enforce`，可切 `shadow`（只記錄）或 `off`。

**理由**:
- 抄錯型態是字元層級，決定性比對足以攔下已知案例（校準：現行入庫題可比對 63 題中 TP 3、FP 0；樣卷 10 題 0 誤報），且判定可被單元測試固定。
- 以 LLM 複驗會讓「抄錯」與「驗錯」出自同一類模型、同一份 PDF，獨立性不足，且成本與非確定性都違反 [ADR-006](./ADR-006-cassette-record-replay.md) 的 CI 前提。
- 預設 enforce：owner 的需求是真的攔下抄錯；誤報只多一次人工確認，漏報則錯題入庫。shadow 保留給新類型考卷上線初期觀察誤報率時使用。
- 人工 approve **不重跑**閘門：老師看著原卷修正的題幹比文字層可靠（文字層本身可能缺負號）；只把修正後的重算結果記進事件（`source_recheck`／`stem_edited`）供事後量測。

## 4. 後果

- **正面**: 抄錯的題停在複核佇列並附具體差異與原卷片段；零成本節點在當日預算止血時仍可推進；cassette、prompt、schema 皆未變動。
- **負面**: 管線多一個狀態與一個 review_reason（`migrations/0009_source_check.sql` 需重建三條 CHECK）；約一半題目跳過比對，不構成完整保證；規則針對已知錯誤型態校準，新型態需擴充規則並重新校準。
- **影響範圍**: `exam_pro/utils/sourceCheck.js`、`exam_pro/services/sourceTextService.js`、`exam_pro/services/mupdf.js`、`exam_pro/agents/source_check.js`、`exam_pro/workers/jobRunner.js`、`exam_pro/pipeline/stateMachine.js`、`exam_pro/controllers/reviewController.js`、`exam_pro/public/js/review.js`、`exam_pro/eval/lib/pipelineDriver.js`、`exam_pro/eval/tools/calibrate_source_check.js`。
- **重新評估觸發**: 真實原卷校準的誤報率超過已比對題數 2%；或掃描檔占新上傳考卷多數（屆時再評估 OCR 或選項一）；或出現字元層比對抓不到的高頻抄錯型態。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-013、FR-020、DEC-005、NFR-003、NFR-004；`docs/roadmap-plan.md` §6.5 待辦 12 |
| 影響範圍 | `docs/source-check.md`、`docs/interfaces-stage2.md`（第 2、3、7、9、11 條、裁決 S2-31）、`../engineering_tracker.md` |
| 取代關係 | 無；補強 [ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md) 的閘門序列（lint 與 verify 之間新增零成本閘門） |
