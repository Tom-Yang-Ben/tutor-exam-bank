# 部署與運維指南 (Deployment & Operations) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（整個系統一份）
> **定位:** 怎麼部署、怎麼啟動、怎麼備份與回滾的單一來源；故障處置歸各 runbook（同目錄），部署拓撲的架構視圖歸 sad §7。

---

## 目錄

- [1. 部署架構](#1-部署架構)
- [2. CI/CD 流水線](#2-cicd-流水線)
- [3. 部署檢查清單](#3-部署檢查清單)
- [4. 部署策略](#4-部署策略)
- [5. 監控與告警](#5-監控與告警)
- [6. 回滾流程](#6-回滾流程)
- [7. 追溯與相關文件](#7-追溯與相關文件)

## 1. 部署架構

單機部署：Windows 11 開發機 + Docker Desktop（WSL2 後端）。無 staging／production 分層；「正式環境」即本機 `npm start`，使用者為單人（DEC-009：資料與驗證邏輯留本地，僅 LLM 呼叫對外）。

### 1.1 基礎設施元件

| 元件 | 用途 | 技術選型與埠 |
| :--- | :--- | :--- |
| 應用伺服器 | Express 5 單行程（`exam_pro/server.js`） | Node.js 24；`http://localhost:3000` |
| 開發用正式庫 | 題庫資料持久化 | `pgvector/pgvector:pg16` 容器 `exam_pg`，埠 **5442**，named volume `pgdata` |
| 整合測試庫 | 整合／e2e／eval 專用 | 同映像，容器 `exam_pg_test`，埠 **5433**，tmpfs（停掉即清空） |
| 外部 AI 服務 | 拆題／驗答／embedding | Google Gemini API（模型 ID 單一真相 `exam_pro/config/models.js`） |
| 前端 | 零打包器單頁 HTML + ES modules | `exam_pro/public/`，由 Express 靜態託管 |

- 開發埠刻意用 5442 而非 5432：本機另有原生 PostgreSQL 17 服務占用 5432，兩者同時 LISTEN 時症狀為「密碼驗證失敗」（`exam_pro/docker-compose.yml` 註解）。
- 本機、CI、正式環境共用同一顆 `pgvector/pgvector:pg16` 映像（內含 pg_trgm）；`./migrations` 以唯讀 bind mount 掛進容器作為 `migrate.js` 不可用時的退路。

## 2. CI/CD 流水線

| 階段 | 步驟 | 觸發 |
| :--- | :--- | :--- |
| 單元層 | `npm test`（1,415 項）＋ `npm run check:html`，Node 22.x／24.x 矩陣 | 每次 push 與 PR（GitHub Actions） |
| 整合層 | 起 `pgvector/pgvector:pg16` service → 整合 259 項＋e2e 11 項＋五個 eval suite（ratchet 門檻） | 同上，`integration` job |
| 部署 | 無自動部署。本機依 §3 啟動程序手動升級 | 手動 |

CI 零金鑰零網路（NFR-003）：`LLM_MODE=replay` 讀 `eval/cassettes/`、`EMBED_MODE=fixture`；eval 低於 ratchet 門檻或 main 上 replay miss 即轉紅（NFR-004）。

## 3. 部署檢查清單

### 3.1 標準啟動程序

| # | 指令 | 說明 |
| :--- | :--- | :--- |
| 1 | `npm run db:up`（＝`docker compose up -d --wait`；或雙擊 `啟動資料庫.bat`） | 拉起 5442／5433 兩容器並等 healthcheck |
| 2 | `npm run migrate` | 對 `DATABASE_URL` 套用 `migrations/0001`–`0005`；只前進不 down，重跑為 no-op |
| 3 | `npm start`（開發改 `npm run dev`） | 啟動後開 `http://localhost:3000` |

輔助指令：`node migrate.js status`（逐支套用狀態）、`npm run migrate:test`（測試庫）、`npm run db:down`（停止；加 `-v` 才刪 `pgdata`）、`node seed_questions.js --apply`（空庫灌 30 題示範題）。

### 3.2 環境變數（`.env`，由 `.env.example` 複製）

| 變數 | 說明 | 預設 |
| :--- | :--- | :--- |
| `PORT` | 服務埠 | `3000` |
| `GEMINI_API_KEY` | Gemini 金鑰（必填；live／record 模式才實際使用） | — |
| `DATABASE_URL` | 正式庫連線 | `postgres://exam:exam@localhost:5442/tutor_exam_bank` |
| `TEST_DATABASE_URL` | 測試庫連線；庫名必須以 `_test` 結尾，否則 `migrate.js` 拒絕執行 | `postgres://exam:exam@localhost:5433/tutor_exam_bank_test` |
| `LLM_MODE` | `live`／`record`／`replay`；CI 恆為 `replay` | `replay` |
| `EMBED_MODEL`／`EMBED_DIM`／`EMBED_RPM`／`EMBED_BATCH`／`EMBED_MODE` | embedding 模型與限速；`EMBED_DIM` 釘死 768 | `gemini-embedding-001`／768／60／32／`fixture` |
| `FEATURE_*` | 功能旗標（PIPELINE／SIMILAR／NLQ／VARIANTS／STUDENTS／ASSISTANT 等），控制 `routes/index.js` 掛載 | 全關（`config/features.js`） |
| `API_KEY` | 後端存取金鑰（timing-safe 比對）；留空停用。能力邊界見 §4.1 | 空 |
| `ALLOWED_ORIGINS` | CORS 白名單（逗號分隔） | `http://localhost:3000` |
| `IMAGE_HOST_ALLOWLIST` | Word 匯圖允許的圖片網域（防 SSRF） | 空 |
| `NODE_ENV` | `production` 時錯誤不回傳細節 | `development` |
| `BACKUP_DIR`／`BACKUP_KEEP`／`BACKUP_COPY_DIR`／`BACKUP_PG_SERVICE` | 備份輸出、保留份數、異地複製、compose 服務名 | `exam_pro/backups`／14／空／`postgres` |
| `JOB_RUNNER` | `inline` 時 server 內建啟動 jobRunner；設為其他值則不啟動（`workers/jobRunner.js` startInlineRunner） | `inline` |
| `JOB_CONCURRENCY` | worker 認領槽數，**兼 LLM 併發桶上限**（`services/llm/throttle.js` 沿用同值） | `2` |
| `JOB_POLL_MS`／`JOB_LEASE_MS` | 認領輪詢間隔／租約時長（NFR-005 斷點續跑） | `2000`／`180000` |
| `JOB_NODE_TIMEOUT_MS` | 單節點逾時（Promise.race＋AbortController，逾時歸 `error:timeout`） | `120000` |
| `JOB_COST_BUDGET_USD`／`DAILY_COST_BUDGET_USD` | 單 job／每日成本上限（NFR-002；觸頂行為見 [runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md)） | `0.5`／`5` |
| `GEMINI_RPM`（通式 `<VENDOR>_RPM`） | 每供應商出口 RPM 節流（滑動 60 秒視窗） | `60` |
| `ASSISTANT_MAX_STEPS` | 助教 ReAct 迴圈每輪工具呼叫上限（1–10） | `5` |
| `VARIANT_AUTO_APPROVE` | `false` 時變式過全部閘門仍停 `awaiting_approval` 待人工核准 | `false` |
| `VARIANT_MAX_PER_REQUEST` | 單次變式請求題數上限 | `3` |
| `WEAKNESS_MIN_N` | 弱點面板 `low_sample` 標記門檻（graded 低於此值） | `5` |

### 3.3 升級前檢查

- [ ] `npm test` 與 `npm run check:html` 全綠（本機或 CI badge）
- [ ] 需資料庫者以 `--env-file=.env --env-file=eval/.env.replay` 跑整合／e2e（只帶 replay 檔會整層 skip 且顯示為綠，裁決 S3-R7）
- [ ] `node migrate.js status` 確認新 migration 已套用
- [ ] 交付前依 `exam_pro/README.md`「陌生人驗收」10 步走完，F12 零 error 零 warning

## 4. 部署策略

| 策略 | 本專案做法 |
| :--- | :--- |
| 發布 | 單行程原地重啟（Ctrl+C 停 `npm start` → `git pull`／checkout → 重啟）；無 Blue-Green／Rolling 需求 |
| DB migration | 只增不改（NFR-006；`0001_init`→`0005_text_hash_unique`），additive 先行，與 expand-contract 的 expand 段等價 |
| 風險控制 | `FEATURE_*` 旗標預設全關，逐一開啟並觀察，取代 canary（階段 2 起的新功能均走旗標掛載） |

### 4.1 對外部署前置條件

目前設計前提為單人本機自用；對外公開部署前必須完成：

1. 設定 `ALLOWED_ORIGINS` 為實際來源、`NODE_ENV=production`（錯誤細節不外洩，NFR-001）。
2. 理解 `API_KEY` 能力邊界：`app.js` 的 `serveIndex()` 會把金鑰注入首頁 HTML，任何能開啟 `/` 的人都取得金鑰——它只擋「未載入首頁就直接打 API」，不是存取控制。對外必須改為反向代理層驗證（Basic Auth／OAuth／IP 白名單）、真正的登入與 session/JWT，或金鑰不注入前端改由使用者手動輸入。
3. 資料庫改用最小權限帳號（現行 compose 帳密 `exam/exam` 僅適用本機）。

## 5. 監控與告警

無 Prometheus 類基礎設施；可觀測性靠內建記帳與失敗可見化（單人維運的取捨）：

| 類別 | 機制 | 出處 |
| :--- | :--- | :--- |
| AI 成本 | 逐 token 計費紀錄、單 job 與每日成本上限（NFR-002；`JOB_COST_BUDGET_USD` 預設 0.5、`DAILY_COST_BUDGET_USD` 預設 5） | `exam_pro/workers/jobRunner.js`、`config/pricing.js` |
| job 狀態 | `npm run report:jobs` 成本／狀態報表；卡住處置見 [runbook-job-stuck.md](./runbook-job-stuck.md) | `exam_pro/scripts/report_jobs.js` |
| 備份失敗 | 任一步失敗寫 `backups/LAST_FAILED.txt` 並非零碼退出，`.bat` 停在畫面不關視窗；成功時刪除該檔 | `exam_pro/scripts/backup.js` |
| 品質退化 | 五個 eval suite ratchet 門檻進 CI，低於門檻轉紅；處置見 [runbook-eval-threshold-fail.md](./runbook-eval-threshold-fail.md) | `exam_pro/eval/thresholds.json` |

## 6. 回滾流程

### 6.1 應用回滾

單行程無狀態（狀態全在 PG）：checkout 前一個綠燈 commit → 重啟。migrations 只增不改，舊版程式對新 schema 相容至 additive 範圍內。

### 6.2 備份與還原

- 備份：`npm run db:backup`（＝`node scripts/backup.js`；或雙擊 `備份資料庫.bat`）。本機無 pg_dump，改以容器內 `pg_dump -Fc --no-owner --no-acl` 輸出 `backups/<庫名>_<時戳>.dump`，檔頭驗證 `PGDMP` 魔術字；預設保留 14 份（`BACKUP_KEEP`），可設 `BACKUP_COPY_DIR` 異地複製。
- 排程注意：Docker Desktop 僅使用者登入後啟動，工作排程器於鎖定畫面執行時 `docker info` 會失敗——此失敗有明確訊息，不靜默。
- 還原：`-Fc` 格式以容器內 `pg_restore` 選擇性還原；完整步驟與 PG 容器故障處置見 [runbook-pg-down.md](./runbook-pg-down.md)。

### 6.3 資料庫切換沿革（cutover）

2026-08-21 依 DEC-004 完成 MySQL→PostgreSQL 16+pgvector 一次切換（不雙寫；凍結一晚→export→import→verify→切 `.env`，逐步指令見 `docs/cutover-runbook.md`）。MySQL 停而不刪保留 14 天作回滾窗口（至 2026-09-04），最終回復手段為切換夜的 `mysqldump` 整庫備份；窗口過後 MySQL 正式退役，舊版程式見 git tag `v1-mysql`，`schema.sql` 與 `migrate/export_mysql.js` 已於 D-X1 收尾移除。

## 7. 追溯與相關文件

- 上游：DEC-004（PG 切換）、DEC-008／NFR-002（成本受控）、DEC-009（資料留本地）、NFR-001（安全邊界）、NFR-004（品質門檻）、NFR-005（可靠性）、NFR-006（migrations 只增不改）；sad §7 部署視圖
- 下游：[runbook-job-stuck.md](./runbook-job-stuck.md)、[runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md)、[runbook-pg-down.md](./runbook-pg-down.md)、[runbook-eval-threshold-fail.md](./runbook-eval-threshold-fail.md)；部署與驗收證據登錄於 [`../05_qa/qa_tracker.md`](../05_qa/qa_tracker.md) ②執行證據
