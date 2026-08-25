# Runbook - Job 卡住 (Job Stuck) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每故障症狀一份（`runbook-<symptom>.md`）。本文件僅處理「拆題／變式 job 停滯不前」；LLM 配額與成本問題見 [runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md)，資料庫連線問題見 [runbook-pg-down.md](./runbook-pg-down.md)。

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

- `jobs.state` 長時間停在 `queued`／`extracting`／`processing`，前端進度不動。
- `job_questions` 有列停在六個可推進狀態（extracted→…→deduped）超過租約時間（`JOB_LEASE_MS` 預設 180 秒）仍無新 `job_events`。

## 2. Impact（影響）

| 項目 | 內容 |
| :--- | :--- |
| **受影響功能** | PDF 拆題入庫（FR-001）、變式生成（FR-011）；組卷／匯出不受影響 |
| **嚴重程度判定** | 單一 job 卡住＝例行處置；所有 job 均不推進＝worker 停擺，立即處理 |

## 3. Possible Causes（可能原因）

1. worker 行程中斷（nodemon 重啟、崩潰）——租約 `locked_until` 未到期前該列不會被重新認領。
2. 當日成本達 `DAILY_COST_BUDGET_USD`（預設 5）——runner 只放行零成本節點（dedup0／dedup1／save），付費節點停止認領。
3. 單 job 預算用盡——狀態機轉 `needs_review('budget_exceeded')`，實為終態非卡住。
4. `JOB_RUNNER` 未設為 `inline`（預設 inline；設成其他值則 server 不啟動 runner）。
5. LLM 供應商逾時／429 進入退避重試（1s→2s→4s，封頂 60s）。

## 4. Diagnosis（診斷步驟）

```bat
REM 1. 總覽：各 job 與逐題狀態分佈
cd /d "C:\Users\Administrator\Desktop\期中專案\exam_pro"
npm run report:jobs
```

```sql
-- 2. 找出租約中與租約已過期的列（過期者下個 tick 會被重新認領，屬正常）
SELECT id, job_id, state, review_reason, locked_until, updated_at
  FROM job_questions
 WHERE state IN ('extracted','hashed','classified','linted','verified','deduped')
 ORDER BY updated_at;

-- 3. 看最近事件：卡住的列最後一次跑了什麼、錯在哪一類
SELECT node, attempt, outcome, error_class, latency_ms, created_at
  FROM job_events WHERE jq_id = <卡住的列 id> ORDER BY id DESC LIMIT 10;

-- 4. 當日成本是否觸頂（觸頂時 server log 有「停止認領需要付費的工作」）
SELECT COALESCE(SUM(cost_usd),0) FROM job_events WHERE created_at >= date_trunc('day', now());
```

## 5. Mitigation（短期緩解）

1. worker 中斷：重啟 `npm start` 即可——租約過期後自動重新認領；extract 重跑靠 `UNIQUE (job_id, idx)` + `ON CONFLICT DO NOTHING` 不會重複建列（斷點續跑為設計保證）。
2. 租約殘留且確認無 worker 在跑：`UPDATE job_questions SET locked_until = NULL WHERE id = <id>;`（jobs 表同理）。
3. `budget_exceeded` 進 needs_review：至人工複核佇列（`public/review.html`）approve／reject，或提高 `JOB_COST_BUDGET_USD` 後重送。
4. 當日觸頂：等隔日視窗重置，或確認費用合理後調高 `.env` 的 `DAILY_COST_BUDGET_USD` 並重啟。

## 6. Recovery（恢復確認）

- `npm run report:jobs` 顯示卡住的列離開原狀態；`job_events` 有新事件寫入。
- 該 job 所有 `job_questions` 進終態（saved／needs_review／rejected）後 `jobs.state = 'done'`。

## 7. Escalation（升級條件）

| 情況 | 處置 |
| :--- | :--- |
| 清租約並重啟後同一列仍反覆卡住 | 依 `job_events.error_class` 分流：rate_limited／budget 類走 [runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md)；DB 錯誤走 [runbook-pg-down.md](./runbook-pg-down.md) |
| 狀態機出現非法轉移或事件缺漏 | 停止重送，檢視 `exam_pro/pipeline/stateMachine.js` 與 `exam_pro/workers/jobRunner.js`，單人維運由 Owner 修碼處理 |

## 8. 追溯

| 項目 | ID／來源 |
| :--- | :--- |
| 上游需求 | DEC-005、FR-001、FR-011、NFR-005（租約認領、斷點續跑、退避重試） |
| 對應模組 | `exam_pro/workers/jobRunner.js`、`exam_pro/pipeline/stateMachine.js`、`exam_pro/scripts/report_jobs.js` |
| 下游文件 | [../05_qa/qa_tracker.md](../05_qa/qa_tracker.md)（TC-001-*）；事故覆盤紀錄（待補） |
