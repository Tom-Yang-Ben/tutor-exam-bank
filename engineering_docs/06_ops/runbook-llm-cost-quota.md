# Runbook - LLM 成本與配額異常 (LLM Cost / Quota) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每故障症狀一份（`runbook-<symptom>.md`）。本文件僅處理「Gemini 費用暴增、429 配額、成本上限觸發」；job 停滯的一般排查見 [runbook-job-stuck.md](./runbook-job-stuck.md)。
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`）：§1 症狀補家教預算 429；§3 可能原因補階段 5 的三個新花費來源；新增 §8 階段 5 的成本煞車（家教＋語音每日預算、知識點標註的預算煞車、`kc:backfill` 先估價、thinking 預算、診斷與緩解）；原 §8 追溯改為 §9 並補 NFR-007。修改處以〔修訂 2026-09-24〕行內標記。

## 目錄

- [1. Symptoms（症狀）](#1-symptoms症狀)
- [2. Impact（影響）](#2-impact影響)
- [3. Possible Causes（可能原因）](#3-possible-causes可能原因)
- [4. Diagnosis（診斷步驟）](#4-diagnosis診斷步驟)
- [5. Mitigation（短期緩解）](#5-mitigation短期緩解)
- [6. Recovery（恢復確認）](#6-recovery恢復確認)
- [7. Escalation（升級條件）](#7-escalation升級條件)
- [8. 階段 5 的成本煞車（AI 家教、語音、知識點標註）](#8-階段-5-的成本煞車ai-家教語音知識點標註)〔修訂 2026-09-24〕
- [9. 追溯](#9-追溯)

## 1. Symptoms（症狀）

- server log 出現「當日成本已達 DAILY_COST_BUDGET_USD=…，停止認領需要付費的工作」。
- `job_events.error_class = 'rate_limited'`（供應商 429）反覆出現，節點退避重試拉長。
- 題目停在 `needs_review('budget_exceeded')`；或 Google 帳單費用高於預期。
- 〔修訂 2026-09-24〕AI 家教或按住說話回 429「今天的 AI 家教預算已用完（已用 US$…／上限 US$…），明天會…」；或 worker log 出現知識點自動標註 `status: skipped`、`reason: daily_budget`／`job_budget`。

## 2. Impact（影響）

| 項目 | 內容 |
| :--- | :--- |
| **受影響功能** | 所有付費 LLM 節點（extract／classify／lint／verify／generate）與 embedding；零成本節點（dedup0／source_check／dedup1／save）照常推進；單 job 預算用盡時其判定原因（`duplicate`、`transcription_mismatch`）照常保留，不改寫成 `budget_exceeded`〔修訂 2026-09-16〕 |
| **嚴重程度判定** | 429 屬暫時性、退避可自癒；費用異常暴增（單日遠超 5 USD 預設上限仍在增加）＝立即停 worker 查因 |

## 3. Possible Causes（可能原因）

1. 單日用量確實偏高（多份 PDF、大量變式）——正常觸發 `DAILY_COST_BUDGET_USD`（預設 5）。
2. `GEMINI_RPM`（預設 60）高於帳戶實際配額，出口節流無法阻止超額請求 → 429。
3. 單 job 預算 `JOB_COST_BUDGET_USD`（預設 0.5）太低，題多的考卷中途 `budget_exceeded`。
4. 節點反覆 fail 重試（feedback 迴圈）放大呼叫次數——看 `job_events.attempt` 是否偏高。
5. `config/pricing.js` 價目過期，`cost_usd` 低估實際費用（帳單與紀錄對不上）。
6. 〔修訂 2026-09-24〕階段 5 的三個新花費來源**不記入 `job_events`**：AI 家教與語音（程序內累計）、知識點自動標註與 `kc:backfill`（只在 log）。帳單高於 `job_events` 總和時先查這三處（§8）。

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

## 8. 階段 5 的成本煞車（AI 家教、語音、知識點標註）

〔修訂 2026-09-24〕三個新花費來源各有自己的煞車，**都不經 `job_events`**，所以 §4 的 SQL 看不到它們、`DAILY_COST_BUDGET_USD` 也不累計它們（NFR-007；權威文件 `docs/tutor.md` §2.5、`docs/knowledge-components.md` §5.3–5.4）。

| 來源 | 煞車 | 觸發時的行為 | 花費在哪裡看 |
| :--- | :--- | :--- | :--- |
| AI 家教 `POST /api/tutor` | `TUTOR_DAILY_BUDGET_USD`（預設 1.0，與語音**合計**）＋`TUTOR_RATE_LIMIT_PER_MIN`（預設 10） | 呼叫前檢查當日累計，達上限回 429 到隔天（伺服器所在時區午夜重置）；每分鐘超過上限回 429＋`Retry-After` | 每則回覆的 `usage.costUsd`（前端「本次約 US$…」）；當日累計只在程序記憶體 |
| 語音 `POST /api/voice/transcribe` | 同上的每日預算＋`VOICE_RATE_LIMIT_PER_MIN`（預設 10）；單檔 ≤5 MB | 同上；>5 MB 回 413 | 回應的 `usage`（前端目前未顯示） |
| 知識點自動標註（`FEATURE_KC_TAGGING`） | 管線 save 後的掛鉤先查：該 job `budget_usd` 用盡 → 不標（`job_budget`）；當日 `job_events` 花費 ≥ `DAILY_COST_BUDGET_USD` → 不標（`daily_budget`）；查帳失敗也不標 | 入庫照常，只是不標；之後以 `kc:backfill` 補 | worker info log `msg: 知識點自動標註`（`status`、`kc_codes`、`cost_usd`） |
| `npm run kc:backfill` | 無自動煞車（老師手動下的指令）；執行前**一定**先印題數與預估費用；`--limit N` 控量 | —— | 指令結尾印各狀態題數與實際費用 |

**thinking 預算**：家教（`MODEL_TUTOR` → Pro 級）`thinkingBudget 2048`／`maxOutputTokens 8192`、語音 1024／4096、`kc_tag` 512／4096，思考 token 以 output 單價計費。這三組數字都**沒有對真 Gemini 實測過**；家教回覆出現「⚠ 回覆因長度上限被截斷」時表示輸出額度不夠（照樣計費）。

**診斷**

```bash
# 知識點標註的花費與略過原因（worker 與 server 同一個行程時看 server log）
grep '知識點自動標註' <server log> | tail -50
# 補標前一定先估價（不呼叫 LLM）
cd exam_pro && npm run kc:backfill -- --dry-run
```

- 家教每日累計不入庫：想知道今天花了多少，看各則回覆的「本次約 US$…」加總，或直接觸發一次看 429 訊息裡的「已用 US$…」。
- 價目表查不到的模型，預算估算改用表上**最貴**的單價（寧可高估）。已知低估：`config/pricing.js` 沒有音訊輸入的分開單價，語音成本可能偏低——請查證 `MODEL_VOICE` 的音訊單價後補進價目表。

**緩解**

1. 家教花費太快：調低 `TUTOR_DAILY_BUDGET_USD`（設 `0` ＝完全不准花錢）或把 `MODEL_TUTOR` 改成較便宜的模型（代價是解題與寫驗算程式的能力較弱），重啟生效。
2. 誤觸或連按：調低 `TUTOR_RATE_LIMIT_PER_MIN`／`VOICE_RATE_LIMIT_PER_MIN`，重啟生效。
3. 標註花費超出預期：關 `FEATURE_KC_TAGGING` 重啟；已入庫但沒標的題之後用 `kc:backfill -- --limit N` 分批補。
4. 需要立即止血：關 `FEATURE_TUTOR`／`FEATURE_VOICE`／`FEATURE_KC_TAGGING` 並重啟（路由不掛載、掛鉤不呼叫）；家教的當日累計重啟會歸零，所以**重啟本身不是止血手段**，要搭配關旗標或調低預算。

**已知限制**：每日預算只在程序內（重啟歸零、多實例不共享）；預算在呼叫前檢查、花費在呼叫後才知道，最後一次可能略超過上限；標註費用不計入 `DAILY_COST_BUDGET_USD`，那道煞車只會在管線本身觸頂後擋下標註。

## 9. 追溯

| 項目 | ID／來源 |
| :--- | :--- |
| 上游需求 | DEC-008、NFR-002（限流、RPM 節流、逐 token 計費、單 job／每日上限）；NFR-007（階段 5 新 LLM 呼叫點的成本上限）〔修訂 2026-09-24〕 |
| 對應模組 | `exam_pro/services/llm/throttle.js`、`exam_pro/config/pricing.js`、`exam_pro/workers/jobRunner.js`（dailySpentUsd／chargeJob）；〔修訂 2026-09-24〕`exam_pro/services/tutorService.js`（每日預算）、`exam_pro/services/voiceService.js`、`exam_pro/workers/jobRunner.js`（runKcTagHook 的 budgetCheck）、`exam_pro/scripts/backfill_kc.js`（估價） |
| 下游文件 | [runbook-job-stuck.md](./runbook-job-stuck.md)；事故覆盤紀錄：尚無事故（發生時於此登錄） |
