# 測試計畫與測試案例 (Test Plan / Test Cases) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（策略一份；案例狀態與執行證據維護在 [`qa_tracker.md`](./qa_tracker.md)）
> **定位:** 本文件回答「測什麼、分幾層、門檻多少、CI 怎麼守」；不含個別案例的執行紀錄（歸 `qa_tracker.md` ②執行證據），也不含 eval 指標的沿革裁決（歸 `docs/interfaces*.md`）。

## 目錄

- [1. 測試範圍與策略](#1-測試範圍與策略)
- [2. Eval suite 與 ratchet 門檻](#2-eval-suite-與-ratchet-門檻)
- [3. Cassette replay 政策](#3-cassette-replay-政策)
- [4. CI 流程](#4-ci-流程)
- [5. 測試案例](#5-測試案例)
- [6. 缺陷回報格式](#6-缺陷回報格式)
- [7. 追溯](#7-追溯)

## 1. 測試範圍與策略

| 項目 | 內容 |
| :--- | :--- |
| **範圍內** | FR-001～FR-016 全數；NFR-001（認證／CORS／SSRF）、NFR-003（純函式合約與 replay）、NFR-004（eval 門檻）、NFR-005（租約與重試）、NFR-006（同交易一致性） |
| **範圍外** | 真實 Gemini API 的線上品質（CI 零金鑰零網路，NFR-003）；私有題庫上的檢索表現（`eval/private/` 不進版控，由開發者本機另行記錄）；瀏覽器相容性矩陣（單人使用，僅開發用瀏覽器驗證） |
| **測試層級** | 三層：單元 **1,415** 項（`test/unit/`，node:test，無 I/O）／整合 **259** 項（`test/integration/`，對 `_test` 後綴 PG）／e2e **11** 項（`test/e2e/`，經 HTTP 走真 runner）；另有五個 eval suite（§2） |
| **環境** | 測試 PG：`pgvector/pgvector:pg16`，本機 5433（tmpfs）、CI service container 5432；庫名必須以 `_test` 結尾，否則 `migrate.js` 與整合測試拒絕執行；`LLM_MODE=replay`、`EMBED_MODE=fixture` |
| **進入條件** | `npm ci` 成功、`npm run migrate:test` 套用 0001–0005、`eval/cassettes/` 與 fixture 就緒 |
| **退出條件** | 三層全綠、五個 suite 均不低於 `eval/thresholds.json` 門檻、main 上零 replay miss |

分層原則：單元層不連資料庫、不呼叫 LLM、不需任何 secrets（CI unit job 刻意不設 `TEST_DATABASE_URL`，防止測試無聲越層）；整合層以 `--test-concurrency=1` 序列執行（各檔共用測試庫並 `TRUNCATE`）；e2e 量「接線有沒有斷」——與 `eval:pipeline` 不重疊，後者量分數且不經 HTTP、不碰 `jobs`／`job_questions`。

## 2. Eval suite 與 ratchet 門檻

門檻規則（`exam_pro/eval/thresholds.json`）：初值＝第一次量測 −0.03，之後**只升不降**（ratchet）；低於門檻 CI 轉紅（NFR-004）。基準線 2026-08-22 以 `npm run eval:baseline` 建立。門檻建立後「量不到那一欄就算失敗」——否則 cassette 被誤刪會表現成 CI 全綠。

| Suite | 指令 | Golden 規模 | 門檻（thresholds.json 實值） | 最近量測值（README／簡報） |
| :--- | :--- | :--- | :--- | :--- |
| retrieval | `npm run eval -- --suite retrieval` | 40 筆／fixture 60 題 | LIKE：R@5 0.845、R@10 0.92、MRR 0.7383；vector：R@5 0.97、R@10 0.97、MRR 0.9575；hybrid：R@5 0.97、R@10 0.97、MRR 0.695 | hybrid R@5 1.000（LIKE 0.875）；MRR 純向量 0.9575 vs hybrid 0.824 |
| classify | `npm run eval:classify` | 90 筆（60 fixture＋30 drift） | accuracy 0.87、macro_f1 0.8956 | accuracy 0.9000、macro-F1 0.9256 |
| pipeline | `npm run eval:pipeline` | 自製樣卷 10 題（sha256 釘住） | saved_rate 0.87、gate_pass_rate 0.97、answer_agree_rate 0.87 | saved_rate 0.90、gate_pass_rate 1.00、answer_agree_rate 0.90 |
| nlq | `npm run eval:nlq` | 50 句 | rules：rule_coverage 0.81、filters_exact 0.97、recall10 0.97；llm：filters_exact 0.72、recall10 0.845 | 規則路徑 coverage 0.84 |
| variant | `npm run eval:variant` | 30 藍本（每藍本 2 變式） | retrieved_coverage 0.8367、gate_pass_rate 0.22 | retrieved_coverage 0.8667、gate_pass_rate 0.25（偏題閾值 0.92→0.90 沿革見裁決 S3-R29） |

只放「越高越好」的指標：needs_review 比率、每題 cost_usd 只在報表呈現、不設門檻（設了會變成反向門檻）。每支報表寫入 `eval/reports/<suite>-<日期>-<sha>.json`，內含模型 ID、cassette 目錄、golden 筆數與轉接層是否含 stub。

## 3. Cassette replay 政策

| 規則 | 內容 |
| :--- | :--- |
| 鍵組成 | 模型 ID＋prompt 模板版本＋輸入雜湊（[ADR-006](../03_architecture/adr/ADR-006-cassette-record-replay.md)）；換模型＝重錄 cassette 並同步改 `ci.yml` 的 `MODEL_EXTRACT`／`MODEL_VERIFY` |
| 錄製 | 開發者本機以真金鑰錄製，存入 `exam_pro/eval/cassettes/`（nlq、variant 各有子目錄）並進版控 |
| 回放 | CI 與整合／e2e 測試一律 `LLM_MODE=replay`＋`EMBED_MODE=fixture`：零金鑰、零網路、零成本、結果確定（NFR-003） |
| replay miss | main 與同 repo 分支視為錯誤、該步直接失敗（凍結訊息，interfaces-stage2.md 第 5.2 條）；fork PR 降為 warning（`EVAL_FORK_PR` 由 workflow 傳入，判斷在 `exam_pro/eval/lib/replayMiss.js`） |
| 模型固定 | CI 無 `.env`，錄製模型明寫於 workflow：`gemini:gemini-3.5-flash`（extract）／`gemini:gemini-3.1-pro-preview`（verify），與 `exam_pro/config/models.js` 預設一致 |

## 4. CI 流程

來源：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)，觸發於 push（main）與所有 pull request；現況 CI 全綠 @ 0ff47b4。

| Job | 矩陣／服務 | 步驟 | 防呆設計 |
| :--- | :--- | :--- | :--- |
| unit | Node 22.x／24.x 矩陣，`fail-fast: false` | `npm ci` → `npm test` → `npm run check:html` | 無 `env:` 區塊——不設 `TEST_DATABASE_URL`，單元測試一連 DB 即失敗，守住「無 I/O」保證 |
| integration | Node 24.x＋`pgvector/pgvector:pg16` service（健檢 `pg_isready`，5s×20 次） | `migrate:test` → `test:integration` → `test:e2e` → 五個 eval suite → 上傳 `eval/reports/`（retention 30 天，`if: always()`） | 庫名 `_test` 後綴強制；e2e 排在整合測試之後（整合測試清空 questions，e2e 取得乾淨起點）；`migrate:test` 而非 `migrate`（後者讀 `DATABASE_URL` 且無後綴檢查） |

## 5. 測試案例

### 5.1 ID 規則

- 測試案例 `TC-<FR號>-<序>`（例 TC-008-1）；對應驗收條件 `ACPT-<FR號>-<序>`、場景 `SCN-<序>`。
- 每條 TC 必須接到 FR/NFR ID；未接需求的測試不入追蹤簿。全表依 FR 分組維護於 [`qa_tracker.md`](./qa_tracker.md) ①測試設計。

### 5.2 代表性案例

| ID | Scenario 摘要 | 層級／位置 | Expected Result | 來源 |
| :--- | :--- | :--- | :--- | :--- |
| TC-001-1 | 上傳自製樣卷 PDF → job 走完狀態機 → 部分入庫 | e2e（`exam_pro/test/e2e/`） | job 達 done，逐題狀態落在 saved／needs_review | FR-001 |
| TC-004-1 | 拆題答案與獨立驗算不一致 | eval:pipeline | 該題以 `answer_mismatch` 進複核，不自動覆蓋（10 題中 1 題實證） | FR-004 |
| TC-006-1 | 複核佇列 approve／reject | 整合 | 狀態轉移正確、reject 不入庫 | FR-006 |
| TC-008-1 | 同學生二次組卷 | 整合 | NOT EXISTS attempts 排除已作答題，零重複 | FR-008、DEC-003 |
| TC-008-3 | 家族互斥抽題 | 單元（`exam_pro/test/unit/pickOnePerFamily.test.js`） | 每 `COALESCE(variant_of, id)` 家族至多一題、家族間等機率 | FR-008 |
| TC-008-4 | 抽題隨機性突變測試 | 單元（`exam_pro/test/unit/shuffle.test.js`） | 固定種子一萬次卡方 0.5~4.0；改回舊寫法 5 項轉紅 | FR-008 |
| TC-009-2 | 組卷 → download-word → 解開 `.docx` | e2e（`exam_pro/test/e2e/paperWord.e2e.test.js`） | 公式為 `<m:oMath>`／`<m:f>`／`<m:sSup>`／`<m:rad>` 原生物件，非純文字 | FR-009、DEC-002 |
| TC-010-1 | 相似題 hybrid 檢索品質 | eval retrieval | 三欄不低於 §2 門檻；hybrid R@5 ≥ LIKE | FR-010 |
| TC-011-1 | 變式題檢索優先與偏題閘門 | eval:variant | retrieved_coverage ≥ 0.8367、gate_pass_rate ≥ 0.22 | FR-011 |
| TC-012-1 | 自然語言查題規則路徑 | eval:nlq | rules 欄 filters_exact ≥ 0.97、recall10 ≥ 0.97 | FR-012 |
| TC-015-1 | 批改結果回填 | 整合 | `PATCH /api/papers/:id/results` 單一交易全有全無，三態含 `null` | FR-015、NFR-006 |
| TC-016-1 | 助教出卷僅 dry-run | 整合 | `POST /api/assistant` 出卷工具只回預覽、不寫入 | FR-016 |

## 6. 缺陷回報格式

| 項目 | 內容 |
| :--- | :--- |
| **重現步驟** | 環境（本機 5433／CI）、`LLM_MODE`／`EMBED_MODE`、commit sha、指令與輸入 |
| **預期 vs 實際** | 附測試輸出或 `eval/reports/` 報表路徑 |
| **嚴重程度** | Blocker（CI 轉紅／門檻跌破）／Major／Minor |
| **關聯** | TC-*／FR-*；eval 類缺陷處置見 [`../06_ops/runbook-eval-threshold-fail.md`](../06_ops/runbook-eval-threshold-fail.md) |

## 7. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | FR-001～FR-016、NFR-001／003／004／005／006；DEC-002、DEC-003、DEC-008；ADR-005、ADR-006 |
| 案例與證據 | TC-* 維護於 [`qa_tracker.md`](./qa_tracker.md) ①測試設計；執行證據（1,415／259／11、五個 suite、CI badge）於 ②執行證據 |
| 下游 | [`../06_ops/runbook-eval-threshold-fail.md`](../06_ops/runbook-eval-threshold-fail.md)、`03_architecture/engineering_tracker.md` 驗證方式欄 |
