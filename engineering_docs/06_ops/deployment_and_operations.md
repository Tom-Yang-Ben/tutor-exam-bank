# 部署與運維指南 (Deployment & Operations) - 家教專用數理題庫系統

> **版本:** v1.4 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（整個系統一份）
> **定位:** 怎麼部署、怎麼啟動、怎麼備份與回滾的單一來源；故障處置歸各 runbook（同目錄），部署拓撲的架構視圖歸 sad §7。
> 🛠 **2026-09-15f 修訂**（feat/source-check，FR-020）：§2 CI 測試數 單元 1,476→1,534、整合 262→269；§3.1 與 §4 migrations 範圍補 0007、0009；§3.2 環境變數表新增 `SOURCE_CHECK_MODE`。修改處以〔修訂 2026-09-15f〕行內標記。

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：§2 CI 測試數 單元 1,415→1,445、整合 259→260；§3.1 與 §4 migrations 範圍 0001–0005→0001–0006（末支 `0006_source_type`）。本檔無 0ff47b4 字樣，無需更正 CI commit。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數與 CI 步驟同步）：§CI 單元層測試數 1,445→1,476、整合層 260→262，補列 PR #17 新增的 npm audit 門檻（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 測試數同步）：§CI 單元層 1,476→1,507、整合層 262→290（本分支實跑）。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：§CI 單元層 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）、整合層 297（合併後實跑）；§3.1 與 §4 migrations 範圍合為 0001–0009。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-16b 修訂**（主線同步，PR #30–#33 合併後）：§2 CI 測試數同步為單元 1,613、整合 317（PR #30–#33 併入 main 後 CI 實測）。修改處以〔修訂 2026-09-16b〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`）：§2 補整合分支測試數；§3.1 與 §4 migrations 範圍 0001–0012；§3.2 環境變數表補階段 5 全部新變數與旗標；新增 §3.4「階段 5 上線步驟」（migrate → kc:load → search:reindex → solution:backfill → 逐一開旗標）；§5 監控補家教／語音／知識點標註的花費觀察點；§6.1 補階段 5 的回滾方式；§7 追溯。修改處以〔修訂 2026-09-24〕行內標記。

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
| 開發用正式庫 | 題庫資料持久化 | `pgvector/pgvector:pg16` 容器 `exam_pg`，埠 **127.0.0.1:5442**（只綁本機〔修訂 2026-09-15c〕），named volume `pgdata` |
| 整合測試庫 | 整合／e2e／eval 專用 | 同映像，容器 `exam_pg_test`，埠 **127.0.0.1:5433**〔修訂 2026-09-15c〕，tmpfs（停掉即清空） |
| 外部 AI 服務 | 拆題／驗答／embedding | Google Gemini API（模型 ID 單一真相 `exam_pro/config/models.js`） |
| 前端 | 零打包器單頁 HTML + ES modules | `exam_pro/public/`，由 Express 靜態託管 |

- 開發埠刻意用 5442 而非 5432：本機另有原生 PostgreSQL 17 服務占用 5432，兩者同時 LISTEN 時症狀為「密碼驗證失敗」（`exam_pro/docker-compose.yml` 註解）。
- 本機、CI、正式環境共用同一顆 `pgvector/pgvector:pg16` 映像（內含 pg_trgm）；`./migrations` 以唯讀 bind mount 掛進容器作為 `migrate.js` 不可用時的退路。

## 2. CI/CD 流水線

| 階段 | 步驟 | 觸發 |
| :--- | :--- | :--- |
| 單元層 | `npm audit --omit=dev --audit-level=high` ＋ `npm test`（1,613 項）＋ `npm run check:html`，Node 22.x／24.x 矩陣〔修訂 2026-09-16b〕 | 每次 push 與 PR（GitHub Actions） |
| 整合層 | 起 `pgvector/pgvector:pg16` service → 整合 317 項〔修訂 2026-09-16b〕＋e2e 11 項＋五個 eval suite（ratchet 門檻）〔修訂 2026-08-29〕 | 同上，`integration` job |
| 階段 5〔修訂 2026-09-24〕 | 整合分支 stage5/integration：unit 2258、integration 481、e2e 11，五個 eval 全綠（主控合併後更新數字）；CI 步驟不變，未新增 eval suite（`eval:classify-chem` 不進 CI） | 併入 main 後由 GitHub Actions 跑 |
| 部署 | 無自動部署。本機依 §3 啟動程序手動升級 | 手動 |

CI 零金鑰零網路（NFR-003）：`LLM_MODE=replay` 讀 `eval/cassettes/`、`EMBED_MODE=fixture`；eval 低於 ratchet 門檻或 main 上 replay miss 即轉紅（NFR-004）。

## 3. 部署檢查清單

### 3.1 標準啟動程序

| # | 指令 | 說明 |
| :--- | :--- | :--- |
| 1 | `npm run db:up`（＝`docker compose up -d --wait`；或雙擊 `啟動資料庫.bat`） | 拉起 5442／5433 兩容器並等 healthcheck |
| 2 | `npm run migrate` | 對 `DATABASE_URL` 套用 `migrations/0001`–`0009`〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕、`0010`–`0012`〔修訂 2026-09-24〕；只前進不 down，重跑為 no-op（依檔名排序逐支判斷，編號缺口不影響套用） |
| 3 | `npm start`（開發改 `npm run dev`） | 啟動後開 `http://localhost:3000` |

輔助指令：`node migrate.js status`（逐支套用狀態）、`npm run migrate:test`（測試庫）、`npm run db:down`（停止；加 `-v` 才刪 `pgdata`）、`node seed_questions.js --apply`（空庫灌 30 題示範題）。

### 3.2 環境變數（`.env`，由 `.env.example` 複製）

| 變數 | 說明 | 預設 |
| :--- | :--- | :--- |
| `PORT` | 服務埠 | `3000` |
| `GEMINI_API_KEY` | Gemini 金鑰（必填；live／record 模式才實際使用） | — |
| `DATABASE_URL` | 正式庫連線 | `postgres://exam:exam@localhost:5442/tutor_exam_bank` |
| `TEST_DATABASE_URL` | 測試庫連線；庫名必須以 `_test` 結尾，否則 `migrate.js` 拒絕執行 | `postgres://exam:exam@localhost:5433/tutor_exam_bank_test` |
| `PG_PASSWORD` | compose 容器密碼（選填，預設 `exam`）；只在 volume 初始化時生效，改動須同步兩條連線字串〔修訂 2026-09-15c〕 | `exam` |
| `LLM_MODE` | `live`／`record`／`replay`；CI 恆為 `replay` | `replay` |
| `EMBED_MODEL`／`EMBED_DIM`／`EMBED_RPM`／`EMBED_BATCH`／`EMBED_MODE` | embedding 模型與限速；`EMBED_DIM` 釘死 768 | `gemini-embedding-001`／768／60／32／`fixture` |
| `FEATURE_*` | 功能旗標（PIPELINE／SIMILAR／NLQ／VARIANTS／STUDENTS／ASSISTANT 等），控制 `routes/index.js` 掛載；階段 5 的五個旗標見下方〔修訂 2026-09-24〕 | 全關（`config/features.js`） |
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
| `SOURCE_CHECK_MODE`〔修訂 2026-09-15f〕 | 拆題結果對照原卷文字層（FR-020，`docs/source-check.md`）：`off` 不比對／`shadow` 只記錄不攔（`payload.source_check.verdict` 仍會寫 mismatch）／`enforce` 題幹與原卷不符即進 `needs_review('transcription_mismatch')`；未設定、空字串或非法值一律 `enforce`；runner 建立時讀取，改動須重啟 | `enforce` |
| `WEAKNESS_MIN_N` | 弱點面板 `low_sample` 標記門檻（graded 低於此值）；〔修訂 2026-09-24〕階段 5 另用於知識點弱點的 `low_sample`（比加權後的 graded）與補救卷 basis 門檻（有標註的已批改題 ≥ 此值且 ≥1 才以知識點為單位） | `5` |
| `FEATURE_KC`〔修訂 2026-09-24〕 | 知識點四支 API（`/api/kc*`、`/api/questions/:id/kcs`）與「知識點」分頁；不呼叫 LLM | `false` |
| `FEATURE_KC_TAGGING`〔修訂 2026-09-24〕 | 管線入庫後自動為新題標知識點（**呼叫 LLM＝花錢**）；不控制路由。標註費用只記在 worker log，不計入 `DAILY_COST_BUDGET_USD` 與 job 的 `budget_usd`，但管線已觸頂時會略過標註 | `false` |
| `KC_TAG_MIN_CONFIDENCE`〔修訂 2026-09-24〕 | 自動標註的信心門檻（0–1）；以 `parseFloat` 解析，超出 0–1 或讀不出數字退回 0.6（注意 `0.8x` 會被讀成 0.8） | `0.6` |
| `MODEL_KC_TAG`〔修訂 2026-09-24〕 | 自動標註模型（`kc:backfill` 與入庫掛鉤共用） | 未設沿用 `MODEL_EXTRACT` |
| `FEATURE_REMEDIAL`〔修訂 2026-09-24〕 | 知識點弱點、補救卷草稿、補救卷加題查詢、題庫覆蓋率四支 API 與兩個子區塊；補救卷區塊在學生分頁，需同時開 `FEATURE_STUDENTS`；「找相似→加入補救卷」另需 `FEATURE_VARIANTS`＋`FEATURE_SIMILAR`；`generate-paper` 的 `blueprint` 不受此旗標影響 | `false` |
| `FEATURE_TUTOR`〔修訂 2026-09-24〕 | `POST /api/tutor` 與「AI 家教」分頁（**呼叫 LLM＝花錢**；需 `LLM_MODE=live` 與 `GEMINI_API_KEY`，replay 模式下沒錄過的問題一律 502） | `false` |
| `FEATURE_VOICE`〔修訂 2026-09-24〕 | `POST /api/voice/transcribe` 與按住說話；**需同時開 `FEATURE_TUTOR`**；瀏覽器端只在 localhost 或 HTTPS、桌機可用 | `false` |
| `MODEL_TUTOR`〔修訂 2026-09-24〕 | 家教模型（要能自己解題、寫 Python 驗算） | 未設沿用 `MODEL_VERIFY`（gemini-3.1-pro-preview） |
| `MODEL_VOICE`〔修訂 2026-09-24〕 | 語音轉寫模型（音訊 → 繁中逐字稿＋LaTeX） | 未設沿用 `MODEL_EXTRACT`（gemini-3.5-flash） |
| `TUTOR_DAILY_BUDGET_USD`〔修訂 2026-09-24〕 | 家教＋語音**合計**的每日花費上限（美元）；依 `config/pricing.js` 估算、程序內按本地日期累計，超過回 429 到隔天；**伺服器重啟歸零**；`0` ＝不准花錢；非數字或負數退回 1.0 | `1.0` |
| `TUTOR_RATE_LIMIT_PER_MIN`〔修訂 2026-09-24〕 | `POST /api/tutor` 每來源每分鐘上限；非正整數退回 10；路由掛載時讀一次（改動須重啟） | `10` |
| `VOICE_RATE_LIMIT_PER_MIN`〔修訂 2026-09-24〕 | `POST /api/voice/transcribe` 每來源每分鐘上限；同上 | `10` |

〔修訂 2026-09-24〕階段 5 的 WS-A（批改細節、學生檔案、文字詳解、Word 版本）與 WS-B（化學）沒有新環境變數，也不掛新旗標：批改細節跟著既有 `FEATURE_STUDENTS`，化學卷上傳跟著既有 `FEATURE_PIPELINE`。所有旗標與 `*_RATE_LIMIT_PER_MIN` 都在啟動時讀取，改動後須重啟。

### 3.3 升級前檢查

- [ ] `npm test` 與 `npm run check:html` 全綠（本機或 CI badge）
- [ ] 需資料庫者以 `--env-file=.env --env-file=eval/.env.replay` 跑整合／e2e（只帶 replay 檔會整層 skip 且顯示為綠，裁決 S3-R7）
- [ ] `node migrate.js status` 確認新 migration 已套用
- [ ] 含新 migration 的版本：先停服務（或先 `npm run migrate`）再 `git pull`／重啟；`npm run dev` 的 nodemon 會在拉下程式時立即以新程式重啟，舊 schema 會讓新 state 撞 CHECK〔修訂 2026-09-16〕
- [ ] 交付前依 `exam_pro/README.md`「陌生人驗收」10 步走完，F12 零 error 零 warning

### 3.4 階段 5 上線步驟〔修訂 2026-09-24〕

適用於把 `stage5/integration` 併入 main 後、第一次在本機正式庫升級。步驟 2–5 皆**不呼叫 LLM、不花錢**；新功能全部預設關閉，最後一步才逐一打開。

| # | 步驟 | 指令 | 確認什麼 |
| :--- | :--- | :--- | :--- |
| 0 | 事前決定（Owner） | —— | 數學知識點的章節切法要在**第一次 `kc:load` 之前**決定（搬移知識點會改變 code，`docs/kc-review-數學.md` 第 2 節）；物理、化學的待決事項見 `docs/kc-review-物理.md`、`docs/kc-review-化學.md`。不急著用知識點可以先跳過步驟 3，其餘照做 |
| 1 | 備份＋停服務 | `npm run db:backup`；停止 `npm start`／`npm run dev` | 備份成功（`backups/LAST_FAILED.txt` 不存在）；含新 migration 的版本要先停服務或先 migrate（§3.3） |
| 2 | 套用 migrations | `git pull`（或 checkout 併入後的 main）→ `npm run migrate` → `node migrate.js status` | 0010、0011、0012 三支顯示已套用 |
| 3 | 載入知識點種子檔 | `npm run kc:validate` → `npm run kc:load -- --dry-run` → 數字合理後 `npm run kc:load` | dry-run 印出新增、更新、略過數（三科約 637 個知識點；dry-run 是整批照做後 ROLLBACK，數字與實際載入相同）；有任何 error 整批不寫 |
| 4 | 重建關鍵字索引（**必跑**） | `npm run search:reindex -- --dry-run` → `npm run search:reindex` | 化學詞典改變了分詞，既有數理題的 `search_tsv` 會過期（例「質量數」「理想氣體」「週期表」）；dry-run 印出會變的題數與前 5 題差異；可中斷重跑，之後改詞典或章節名都要再跑（`docs/chemistry.md` §4.3） |
| 5 | 回填文字詳解 | `npm run solution:backfill -- --dry-run` → `npm run solution:backfill -- --limit 20` → 抽讀幾題 → `npm run solution:backfill` | dry-run 印出掃描、會補、略過（含原因與題號）；已有詳解的題不覆寫、入庫後被改過題幹或答案的題不補；verify 摘要未經人工審閱，發給學生前先讀 |
| 6 | 啟動並驗收核心延伸 | `npm start` | 不必開新旗標即可用：批改卡錯因／部分給分／詳解（需既有 `FEATURE_STUDENTS`）、學生檔案、題目詳解欄、Word 三種版本、化學卷上傳（需既有 `FEATURE_PIPELINE`）。在瀏覽器實際走一遍（這些畫面只有 miniDom 測試） |
| 7 | 逐一開旗標（每開一個就重啟、實際操作一次再開下一個） | `.env` 設定後重啟 | ① `FEATURE_KC=true`：知識點分頁審定口語版；② `FEATURE_REMEDIAL=true`：學生分頁「依弱點出補救卷」、題庫管理「題庫覆蓋率」；③ `FEATURE_TUTOR=true`（需 `LLM_MODE=live`＋金鑰；確認 `TUTOR_DAILY_BUDGET_USD`）：先試文字家教兩種模式；④ `FEATURE_VOICE=true`：桌機 Chrome、`http://localhost:3000` 試按住說話，確認 Gemini 接受 audio/webm；⑤ 補標舊題 `npm run kc:backfill -- --dry-run`（看題數與預估費用）→ `--limit 20` 試跑 → 看結果再全跑（需 `LLM_MODE=live`）；⑥ 最後才 `FEATURE_KC_TAGGING=true` 讓新上傳的考卷自動標 |

- 回滾：旗標關掉並重啟即回到階段 5 之前的畫面與路由；migrations 0010–0012 只增不改，舊版程式可在新 schema 上執行（additive）。注意 `search:reindex` 改寫的 `search_tsv` 是用新詞典切的：若退回階段 5 之前的程式，查詢端改用舊詞典，部分關鍵字會對不上，屆時需以舊詞典重算（舊版沒有 `search:reindex` 指令）。
- 花費：步驟 7 的 ③④⑤⑥ 會呼叫 LLM；各自的煞車與觀察方式見 [runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md) §8。

## 4. 部署策略

| 策略 | 本專案做法 |
| :--- | :--- |
| 發布 | 單行程原地重啟（Ctrl+C 停 `npm start` → `git pull`／checkout → 重啟）；無 Blue-Green／Rolling 需求。**含新 migration 的版本要先停服務或先 `npm run migrate`，再拉程式／重啟**〔修訂 2026-09-16〕：以 `npm run dev`（nodemon）執行時，`git pull` 一帶入新程式就會自動重啟，舊 schema 下寫入新 state／review_reason 會違反 CHECK（例：0009 之前的 schema 不接受 `source_checked`） |
| DB migration | 只增不改（NFR-006；`0001_init`→`0009_source_check`〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕→`0012_knowledge_components`〔修訂 2026-09-24〕），additive 先行，與 expand-contract 的 expand 段等價 |
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
| AI 成本（階段 5）〔修訂 2026-09-24〕 | 家教與語音：每則回應的 `usage.costUsd`（前端顯示「本次約 US$…」）與程序內當日累計（不入庫、重啟歸零）；知識點自動標註：worker info log（`msg: 知識點自動標註`，帶 `status`、`kc_codes`、`cost_usd`）；`kc:backfill` 結尾印實際費用。三者都**不在** `job_events`，`report:jobs` 看不到（NFR-007） | `services/tutorService.js`、`services/voiceService.js`、`workers/jobRunner.js`、`scripts/backfill_kc.js` |
| job 狀態 | `npm run report:jobs` 成本／狀態報表；卡住處置見 [runbook-job-stuck.md](./runbook-job-stuck.md) | `exam_pro/scripts/report_jobs.js` |
| 備份失敗 | 任一步失敗寫 `backups/LAST_FAILED.txt` 並非零碼退出，`.bat` 停在畫面不關視窗；成功時刪除該檔（旗標只反映最後一次）。歷史另存 `backups/backup.log`，每次執行不論成敗都 append 一行且永不刪除，用以辨識漏跑 | `exam_pro/scripts/backup.js` |
| 品質退化 | 五個 eval suite ratchet 門檻進 CI，低於門檻轉紅；處置見 [runbook-eval-threshold-fail.md](./runbook-eval-threshold-fail.md) | `exam_pro/eval/thresholds.json` |

## 6. 回滾流程

### 6.1 應用回滾

單行程無狀態（狀態全在 PG）：checkout 前一個綠燈 commit → 重啟。migrations 只增不改，舊版程式對新 schema 相容至 additive 範圍內。〔修訂 2026-09-24〕階段 5 優先用「關旗標＋重啟」回滾（§3.4）；若要退回階段 5 之前的程式：舊程式的科目白名單沒有化學，已入庫的化學題（`subject = '化學'`）預期無法透過舊版 API 編輯（推論，未實測）；`search_tsv` 的處理見 §3.4 回滾說明；家教的每日累計在程序內，重啟即清。

### 6.2 備份與還原

- 備份：`npm run db:backup`（＝`node scripts/backup.js`；或雙擊 `備份資料庫.bat`）。本機無 pg_dump，改以容器內 `pg_dump -Fc --no-owner --no-acl` 輸出 `backups/<庫名>_<時戳>.dump`，檔頭驗證 `PGDMP` 魔術字；預設保留 14 份（`BACKUP_KEEP`），可設 `BACKUP_COPY_DIR` 異地複製。
- 異地副本：`BACKUP_COPY_DIR` 於 2026-08-31 起在開發機 `.env` 設為 OneDrive 同步資料夾。設定前備份與資料庫同處單一實體磁碟，僅能防誤刪，不能防磁碟故障、失竊或勒索軟體。dump 內含題庫與學生答題紀錄，異地位置的選擇屬資料落地決策，由 owner 拍板。
- 排程：Windows 工作排程器 `題庫每日備份`，每日 02:00 觸發 `cmd.exe /c exam_pro\備份資料庫.bat`（`StartBoundary` 2026-08-21，與 DEC-004 切換同日建立）。必要設定：`StartWhenAvailable=True`（錯過時段開機後補跑）、`DisallowStartIfOnBatteries=False`／`StopIfGoingOnBatteries=False`（開發機為筆電；一次 dump 僅數秒，電源條件不應阻擋）。三項於 2026-08-31 修正，先前為預設值。
- 排程注意：Docker Desktop 僅使用者登入後啟動，工作排程器於鎖定畫面執行時 `docker info` 會失敗——此失敗有明確訊息，不靜默。
- 漏跑偵測：工作排程器的 `LastTaskResult`／`NumberOfMissedRuns` 只描述最後一次，不足以證明每日皆有備份（2026-08-27 漏跑時兩者均為 0）。判定依據為 `backups/backup.log` 的逐日 `OK`／`FAIL` 行與 `backups/` 實際檔案，不採用排程器回報值。
- 還原：`-Fc` 格式以容器內 `pg_restore` 選擇性還原；完整步驟與 PG 容器故障處置見 [runbook-pg-down.md](./runbook-pg-down.md)。

### 6.3 資料庫切換沿革（cutover）

2026-08-21 依 DEC-004 完成 MySQL→PostgreSQL 16+pgvector 一次切換（不雙寫；凍結一晚→export→import→verify→切 `.env`，逐步指令見 `docs/archive/cutover-runbook.md`）。MySQL 停而不刪保留 14 天作回滾窗口（至 2026-09-04），最終回復手段為切換夜的 `mysqldump` 整庫備份；窗口過後 MySQL 正式退役，舊版程式見 git tag `v1-mysql`，`schema.sql` 與 `migrate/export_mysql.js` 已於 D-X1 收尾移除。

## 7. 追溯與相關文件

- 上游：DEC-004（PG 切換）、DEC-008／NFR-002（成本受控）、DEC-009（資料留本地）、NFR-001（安全邊界）、NFR-004（品質門檻）、NFR-005（可靠性）、NFR-006（migrations 只增不改）；NFR-007（階段 5 成本）、NFR-008（錄音不落地）〔修訂 2026-09-24〕；sad §7 部署視圖；階段 5 各功能文件（`docs/grading-and-profile.md`、`chemistry.md`、`knowledge-components.md`、`remedial.md`、`tutor.md`）〔修訂 2026-09-24〕
- 下游：[runbook-job-stuck.md](./runbook-job-stuck.md)、[runbook-llm-cost-quota.md](./runbook-llm-cost-quota.md)、[runbook-pg-down.md](./runbook-pg-down.md)、[runbook-eval-threshold-fail.md](./runbook-eval-threshold-fail.md)；部署與驗收證據登錄於 [`../05_qa/qa_tracker.md`](../05_qa/qa_tracker.md) ②執行證據
