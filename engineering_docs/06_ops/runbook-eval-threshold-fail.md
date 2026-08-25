# Runbook - Eval 門檻失敗 (Eval Threshold Fail) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每故障症狀一份（`runbook-<symptom>.md`）。本文件僅處理「CI eval 低於 ratchet 門檻與 replay miss」；單元／整合測試紅燈屬一般除錯，門檻值本身的權威在 `exam_pro/eval/thresholds.json`。

## 目錄

- [1. Symptoms（症狀）](#1-symptoms症狀)
- [2. Impact（影響）](#2-impact影響)
- [3. Possible Causes（可能原因）](#3-possible-causes可能原因)
- [4. Diagnosis（診斷步驟）](#4-diagnosis診斷步驟)
- [5. Mitigation（處置）](#5-mitigation處置)
- [6. Recovery（恢復確認）](#6-recovery恢復確認)
- [7. Escalation（升級條件）](#7-escalation升級條件)
- [8. 追溯](#8-追溯)

## 1. Symptoms（症狀）

- CI 的 eval 步驟轉紅：某 suite（retrieval／classify／pipeline／nlq／variant）指標低於 `eval/thresholds.json` 門檻。
- 失敗訊息含「`LLM_MODE=replay 找不到 cassette`」＝ replay miss（main 與同 repo 分支為紅燈；fork PR 經 `EVAL_FORK_PR` 降為 warning）。

## 2. Impact（影響）

| 項目 | 內容 |
| :--- | :--- |
| **受影響範圍** | 該 PR／commit 不得合入；線上功能不受影響（eval 全程 replay，零金鑰零網路） |
| **嚴重程度判定** | 指標真回退＝品質回歸，改動需修正；replay miss＝cassette 缺錄，屬工作流程問題 |

## 3. Possible Causes（可能原因）

1. 改動確實使指標回退（檢索、分類、管線、NLQ、變式任一 suite 低於門檻）。
2. 改了 prompt 模板或模型 ID 但沒重錄 cassette——cassette 鍵含模型 ID＋模板版本＋輸入雜湊，鍵變即 miss。
3. cassette 檔被誤刪或未 commit（`eval/cassettes/`）。
4. golden／fixture 被改動而基準未同步（fixture 60 題、golden 各 suite 30–90 筆，見 thresholds.json 的 `_measured_with` 區塊）。

## 4. Diagnosis（診斷步驟）

```bat
cd /d "C:\Users\Administrator\Desktop\期中專案\exam_pro"

REM 1. 本機重現（與 CI 同為 replay 模式；本機 miss 一律紅燈不降級）
npm run eval

REM 2. 只跑失敗的 suite（retrieval / classify / pipeline / nlq / variant 擇一）
npm run eval:classify

REM 3. 看指標趨勢，判斷是驟降還是緩降
npm run eval:trend
```

- 門檻現值（`eval/thresholds.json`，2026-08-22 定基準）：retrieval hybrid recall5 0.97；classify accuracy 0.87／macro_f1 0.8956；pipeline saved_rate 0.87／gate_pass_rate 0.97；nlq rules rule_coverage 0.81；variant retrieved_coverage 0.8367／gate_pass_rate 0.22。
- replay miss 訊息會標出 `agent=… key=…`；辨識邏輯在 `exam_pro/eval/lib/replayMiss.js`（只比凍結前綴）。注意：訊息內建議的 `npm run eval:record` 實為 fixture 向量錄製（`eval/record_embeddings.js`），cassette 重錄指令見 §5.1。

## 5. Mitigation（處置）

1. **replay miss**：確認是刻意改了 prompt／模型後，以真金鑰重錄再 commit cassette——extract／classify 用 `node scripts/record_cassettes.js --agent extract|classify`；nlq／variant 於本機以 `LLM_MODE=record`＋`EMBED_MODE=record` 跑該 suite 錄製。若是誤刪，從 git 還原 `eval/cassettes/` 即可，不必重錄。
2. **指標真回退**：修正改動本身，不調整門檻。ratchet 規則（thresholds.json `_rule`）：初值＝首測 −0.03，之後只升不降；任何調整必須改該檔並在 PR 說明。
3. **fork PR 的 miss warning**：合入前仍須由有金鑰的維護者補錄——main 上同一 miss 是紅燈。
4. 刻意的行為變更（如 S3-R29 將變式跑題閾值 0.92→0.90）：同 PR 內更新 thresholds.json 與對應 `_measured_with`，並附量測依據。

## 6. Recovery（恢復確認）

- 本機 `npm run eval` 五個 suite 全過、無 miss；push 後 CI eval 步驟轉綠。
- 重錄過 cassette 時，確認 `git status` 無未追蹤的 `eval/cassettes/` 檔案殘留。

## 7. Escalation（升級條件）

| 情況 | 處置 |
| :--- | :--- |
| 重錄後指標仍低於門檻且改動無明顯回歸點 | 以 `npm run eval:trend` 對照歷史，逐 commit 二分定位；必要時 revert 改動 |
| 調降門檻放行的請求 | 不允許以調降門檻消除紅燈；唯一例外是有量測依據的刻意行為變更（見 §5.4），須在 PR 記錄裁決 |

## 8. 追溯

| 項目 | ID／來源 |
| :--- | :--- |
| 上游需求 | NFR-003（cassette record/replay、CI 零金鑰零網路）、NFR-004（golden＋ratchet、replay miss 於 main 視為錯誤） |
| 對應模組 | `exam_pro/eval/run.js`、`exam_pro/eval/thresholds.json`、`exam_pro/eval/lib/replayMiss.js`、`exam_pro/eval/cassettes/` |
| 下游文件 | [../05_qa/qa_tracker.md](../05_qa/qa_tracker.md)（五個 eval suite 執行證據）；事故覆盤紀錄（待補） |
