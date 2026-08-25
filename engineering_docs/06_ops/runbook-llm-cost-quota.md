# Runbook - LLM 成本與配額異常 (LLM Cost / Quota) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每故障症狀一份（`runbook-<symptom>.md`）。本文件僅處理「Gemini 費用暴增、429 配額、成本上限觸發」；job 停滯的一般排查見 [runbook-job-stuck.md](./runbook-job-stuck.md)。

## 目錄

- [1. Symptoms（症狀）](#1-symptoms症狀)
- [2. Impact（影響）](#2-impact影響)
- [3. Possible Causes（可能原因）](#3-possible-causes可能原因)
- [4. Diagnosis（診斷步驟）](#4-diagnosis診斷步驟)
- [5. Mitigation（短期緩解）](#5-mitigation短期緩解)
- [6. Recovery（恢復確認）](#6-recovery恢復確認)
- [7. Escalation（升級條件）](#7-escalation升級條件)
- [8. 追溯](#8-追溯)

## 1. Symptoms（症狀）

- server log 出現「當日成本已達 DAILY_COST_BUDGET_USD=…，停止認領需要付費的工作」。
- `job_events.error_class = 'rate_limited'`（供應商 429）反覆出現，節點退避重試拉長。
- 題目停在 `needs_review('budget_exceeded')`；或 Google 帳單費用高於預期。

## 2. Impact（影響）

| 項目 | 內容 |
| :--- | :--- |
| **受影響功能** | 所有付費 LLM 節點（extract／classify／lint／verify／generate）與 embedding；零成本節點（dedup0／dedup1／save）照常推進 |
| **嚴重程度判定** | 429 屬暫時性、退避可自癒；費用異常暴增（單日遠超 5 USD 預設上限仍在增加）＝立即停 worker 查因 |

## 3. Possible Causes（可能原因）

1. 單日用量確實偏高（多份 PDF、大量變式）——正常觸發 `DAILY_COST_BUDGET_USD`（預設 5）。
2. `GEMINI_RPM`（預設 60）高於帳戶實際配額，出口節流無法阻止超額請求 → 429。
3. 單 job 預算 `JOB_COST_BUDGET_USD`（預設 0.5）太低，題多的考卷中途 `budget_exceeded`。
4. 節點反覆 fail 重試（feedback 迴圈）放大呼叫次數——看 `job_events.attempt` 是否偏高。
5. `config/pricing.js` 價目過期，`cost_usd` 低估實際費用（帳單與紀錄對不上）。

## 4. Diagnosis（診斷步驟）

```sql
-- 1. 當日成本（與 runner 的止血判斷同一句）
SELECT COALESCE(SUM(cost_usd),0)::float8 AS spent
  FROM job_events WHERE created_at >= date_trunc('day', now());

-- 2. 成本流向：成本集中於哪個 job、節點與模型
SELECT job_id, node, model, COUNT(*) AS calls,
       SUM(token_in) AS tin, SUM(token_out) AS tout, SUM(cost_usd)::numeric(10,4) AS usd
  FROM job_events WHERE created_at >= date_trunc('day', now())
 GROUP BY job_id, node, model ORDER BY usd DESC;

-- 3. 429 的分佈與最近時間
SELECT node, COUNT(*), max(created_at)
  FROM job_events WHERE error_class = 'rate_limited' GROUP BY node;

-- 4. 各 job 的預算餘額
SELECT id, kind, state, cost_usd, budget_usd FROM jobs ORDER BY updated_at DESC LIMIT 20;
```

設定核對：`.env` 的 `GEMINI_RPM`、`JOB_CONCURRENCY`（預設 2，兼併發桶上限）、`JOB_COST_BUDGET_USD`、`DAILY_COST_BUDGET_USD`；價目在 `exam_pro/config/pricing.js`，模型 ID 在 `exam_pro/config/models.js`。

## 5. Mitigation（短期緩解）

1. 429 持續：調低 `.env` 的 `GEMINI_RPM`（如 60→30）並重啟——出口節流在 `exam_pro/services/llm/throttle.js`（滑動 60 秒視窗＋併發桶）。
2. 費用不明暴增：停止 `npm start`（inline runner 一併停止），先執行 §4 第 2 句定位來源再決定重啟。
3. 正常觸頂但當日仍須繼續處理：確認金額可接受後調高 `DAILY_COST_BUDGET_USD` 重啟；否則等隔日視窗重置（在途 job 仍會走完免費節點）。
4. `budget_exceeded` 的題目：於人工複核佇列處理，或調高 `JOB_COST_BUDGET_USD` 後重送該 PDF。

## 6. Recovery（恢復確認）

- `error_class='rate_limited'` 不再新增；卡住的 job 依 [runbook-job-stuck.md](./runbook-job-stuck.md) §6 確認結案。
- 隔日 `dailySpentUsd` 歸零後 runner 自動恢復認領付費工作（無需重啟）。

## 7. Escalation（升級條件）

| 情況 | 處置 |
| :--- | :--- |
| 調低 RPM 後 429 仍持續 | 至 Google AI Studio 檢視帳戶配額與帳單；必要時暫停所有拆題，僅保留組卷／匯出（不需 LLM） |
| 帳單與 `job_events.cost_usd` 總和明顯不符 | 核對並更新 `exam_pro/config/pricing.js` 價目；`cost_estimated=true` 的列僅為估值 |

## 8. 追溯

| 項目 | ID／來源 |
| :--- | :--- |
| 上游需求 | DEC-008、NFR-002（限流、RPM 節流、逐 token 計費、單 job／每日上限） |
| 對應模組 | `exam_pro/services/llm/throttle.js`、`exam_pro/config/pricing.js`、`exam_pro/workers/jobRunner.js`（dailySpentUsd／chargeJob） |
| 下游文件 | [runbook-job-stuck.md](./runbook-job-stuck.md)；事故覆盤紀錄：尚無事故（發生時於此登錄） |
