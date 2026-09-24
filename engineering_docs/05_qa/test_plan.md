# 測試計畫與測試案例 (Test Plan / Test Cases) - 家教專用數理題庫系統

> **版本:** v1.4 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（策略一份；案例狀態與執行證據維護在 [`qa_tracker.md`](./qa_tracker.md)）
> **定位:** 本文件回答「測什麼、分幾層、門檻多少、CI 怎麼守」；不含個別案例的執行紀錄（歸 `qa_tracker.md` ②執行證據），也不含 eval 指標的沿革裁決（歸 `docs/interfaces*.md`）。

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：§1 測試層級數 單元 1,415→1,445、整合 259→260；§1 進入條件 migrations 0001–0005→0001–0006；§4 CI 全綠 commit 0ff47b4→f8f6574；§7 執行證據數字同步。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數同步）：執行證據 1,445／260／11→1,476／262／11；§1 測試層級 單元 1,445→1,476、整合 260→262（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 測試數同步）：測試層級與執行證據 1,476／262／11→1,507／290／11（本分支實跑）。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/source-check）：§1 範圍補 FR-017／018／020、測試層級 1,476／262／11→1,534／269／11、進入條件 migrations 補 0007、0009；§5.2 新增 TC-020-1 代表案例（公開樣卷 0 誤報）；§7 同步。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：§1 範圍補 FR-019、測試層級 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）／297／11（合併後實跑）、進入條件 migrations 合為 0001–0009；§7 上游補 FR-019、DEC-012 與執行證據同步。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-16b 修訂**（主線同步，PR #30–#33 合併後）：§測試層級與案例證據列同步為 1,613／317／11（PR #30–#33 併入 main 後 CI 實測）。修改處以〔修訂 2026-09-16b〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`）：§1 範圍延伸至 FR-021～035 與 NFR-007～009、範圍外補真 Gemini／瀏覽器／Word 實機、測試數寫為「整合分支 stage5/integration：unit 2258、integration 481、e2e 11，五個 eval 全綠」、進入條件 migrations 0001–0012；§2 補不進 CI 的化學 eval；§3 補 generateText 與新模板的 cassette 規則；§5.2 補階段 5 代表案例；§7 追溯。修改處以〔修訂 2026-09-24〕行內標記。

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
| **範圍內** | FR-001～FR-020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕全數；FR-021～FR-035〔修訂 2026-09-24〕；NFR-001（認證／CORS／SSRF）、NFR-003（純函式合約與 replay）、NFR-004（eval 門檻）、NFR-005（租約與重試）、NFR-006（同交易一致性）；NFR-007（家教／語音預算、標註預算煞車）、NFR-008（錄音不落地、姓名不出境）、NFR-009（既有 cassette 不失效）〔修訂 2026-09-24〕 |
| **範圍外** | 真實 Gemini API 的線上品質（CI 零金鑰零網路，NFR-003）；私有題庫上的檢索表現（`eval/private/` 不進版控，由開發者本機另行記錄）；瀏覽器相容性矩陣（單人使用，僅開發用瀏覽器驗證）；〔修訂 2026-09-24〕階段 5 另有下列**尚未驗證**、不在自動化測試範圍的項目：AI 家教提示效果（socratic 是否洩答、是否真的用 code execution 驗算）、`kc_tag` 標註準確率、化學拆題與分類品質（沒有化學 cassette）、Gemini 是否接受瀏覽器錄的 audio/webm、真瀏覽器下的 MediaRecorder／speechSynthesis／MathJax mhchem 顯示、Microsoft Word 開啟化學式與詳解版——前端只以 miniDom 渲染測試驗證 |
| **測試層級** | 三層：單元 **1,613** 項（`test/unit/`，node:test，無 I/O）／整合 **317** 項〔修訂 2026-09-16b〕（`test/integration/`，對 `_test` 後綴 PG）／e2e **11** 項（`test/e2e/`，經 HTTP 走真 runner）；另有五個 eval suite（§2）〔修訂 2026-08-29〕。〔修訂 2026-09-24〕以上為 main 的數字；整合分支 stage5/integration：unit 2258、integration 481、e2e 11，五個 eval 全綠（主控合併後更新數字） |
| **環境** | 測試 PG：`pgvector/pgvector:pg16`，本機 5433（tmpfs）、CI service container 5432；庫名必須以 `_test` 結尾，否則 `migrate.js` 與整合測試拒絕執行；`LLM_MODE=replay`、`EMBED_MODE=fixture` |
| **進入條件** | `npm ci` 成功、`npm run migrate:test` 套用 0001–0009〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕、0010–0012〔修訂 2026-09-24〕、`eval/cassettes/` 與 fixture 就緒〔修訂 2026-08-29〕 |
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

只放「越高越好」的指標：needs_review 比率、每題 cost_usd 只在報表呈現、不設門檻（設了會變成反向門檻）。

〔修訂 2026-09-24〕階段 5 的 eval 政策：需要真 LLM 才能量的新功能一律做成「沒有 cassette 就印出略過並 exit 0」的獨立 suite，**不加進 CI 清單**（契約 `docs/interfaces-stage5.md` 第 1.2 條）。目前只有 `npm run eval:classify-chem`（24 筆自撰 golden，尚未錄製）；家教與知識點標註的 eval 尚未建立，建議指標見 `docs/tutor.md` §6、`docs/knowledge-components.md` §9。每支報表寫入 `eval/reports/<suite>-<日期>-<sha>.json`，內含模型 ID、cassette 目錄、golden 筆數與轉接層是否含 stub。

## 3. Cassette replay 政策

| 規則 | 內容 |
| :--- | :--- |
| 鍵組成 | 模型 ID＋prompt 模板版本＋輸入雜湊（[ADR-006](../03_architecture/adr/ADR-006-cassette-record-replay.md)）；換模型＝重錄 cassette 並同步改 `ci.yml` 的 `MODEL_EXTRACT`／`MODEL_VERIFY` |
| 錄製 | 開發者本機以真金鑰錄製，存入 `exam_pro/eval/cassettes/`（nlq、variant 各有子目錄）並進版控 |
| 回放 | CI 與整合／e2e 測試一律 `LLM_MODE=replay`＋`EMBED_MODE=fixture`：零金鑰、零網路、零成本、結果確定（NFR-003） |
| replay miss | main 與同 repo 分支視為錯誤、該步直接失敗（凍結訊息，interfaces-stage2.md 第 5.2 條）；fork PR 降為 warning（`EVAL_FORK_PR` 由 workflow 傳入，判斷在 `exam_pro/eval/lib/replayMiss.js`） |
| 模型固定 | CI 無 `.env`，錄製模型明寫於 workflow：`gemini:gemini-3.5-flash`（extract）／`gemini:gemini-3.1-pro-preview`（verify），與 `exam_pro/config/models.js` 預設一致 |
| 階段 5 新模板〔修訂 2026-09-24〕 | 新 LLM 呼叫點（`*_chem`、`kc_tag`、`tutor.direct`／`tutor.socratic`、語音）的模板註冊字串＝SYSTEM＋`'\n---\n'`＋PROMPT_TEMPLATE，SYSTEM 一改鍵就變；既有 agent 的「SYSTEM 不在鍵內」缺口照契約只記錄、不修（修了全部 cassette 失效）。階段 5 **沒有新增任何 cassette**：單元測試注入假 LLM，家教整合測試在 `os.tmpdir()` 寫暫存 cassette 走 replay |
| generateText〔修訂 2026-09-24〕 | 鍵公式同 `generateJson`（schema 欄為空）；`tools` 不在鍵內，會影響輸出的因素由呼叫端放進 `cacheKeyParts`（家教：`{mode, prompt: sha256}`；語音：`{audio_sha256, mime, subject}`）；response 存 `{text, codeRuns, finishReason, usage, latencyMs}`；音訊／圖片 part 在 request 摘要只存 `{kind, mimeType, bytes, sha256}` |

## 4. CI 流程

來源：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)，觸發於 push（main）與所有 pull request；現況 CI 全綠 @ f8f6574（PR #7 merge）〔修訂 2026-08-29〕。

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
| TC-009-2 | 組卷 → download-word → 解開 `.docx` | e2e（`exam_pro/test/e2e/paperWord.e2e.test.js`） | 公式為 `<m:oMath>`／`<m:f>`／`<m:sSup>`／`<m:rad>` 原生物件，非純文字；附圖題（`question_img`＝`/figures/…`）的圖嵌入 `word/media`＋`<w:drawing>`〔修訂 2026-09-16〕 | FR-009、FR-018、DEC-002 |
| TC-010-1 | 相似題 hybrid 檢索品質 | eval retrieval | 三欄不低於 §2 門檻；hybrid R@5 ≥ LIKE | FR-010 |
| TC-011-1 | 變式題檢索優先與偏題閘門 | eval:variant | retrieved_coverage ≥ 0.8367、gate_pass_rate ≥ 0.22 | FR-011 |
| TC-012-1 | 自然語言查題規則路徑 | eval:nlq | rules 欄 filters_exact ≥ 0.97、recall10 ≥ 0.97 | FR-012 |
| TC-015-1 | 批改結果回填 | 整合 | `PATCH /api/papers/:id/results` 單一交易全有全無，三態含 `null` | FR-015、NFR-006 |
| TC-016-1 | 助教出卷僅 dry-run | 整合 | `POST /api/assistant` 出卷工具只回預覽、不寫入 | FR-016 |
| TC-021-2〔修訂 2026-09-24〕 | 批改細節：錯因、部分給分、錯改對、取消批改、全有全無 | 整合（`exam_pro/test/integration/grading.pg.test.js`） | 違規 → 400 且整批 ROLLBACK；錯改對後 `error_types = '{}'`；取消批改保留 response／teacher_note | FR-021、NFR-006 |
| TC-026-5〔修訂 2026-09-24〕 | 化學併入後數學／物理行為不變 | 單元（`chemistryAgents.test.js`）＋CI 五個 eval | 數學／物理請求與 base 逐字相同；不重錄 cassette 五個 suite 全綠 | FR-026、NFR-009 |
| TC-031-2〔修訂 2026-09-24〕 | 補救卷草稿：basis 切換、三桶配額、排除規則、承上組、不寫庫 | 整合（`exam_pro/test/integration/remedial.pg.test.js`） | 草稿不寫庫；確認後走 confirm-paper 寫 attempts | FR-031、DEC-003 |
| TC-034-4〔修訂 2026-09-24〕 | AI 家教經正式程式路徑（routes→controller→service→llm→fake）以暫存 cassette 回放一輪 | 整合（`exam_pro/test/integration/tutor.pg.test.js`） | 回應恰為五鍵；prompt 無學生姓名；預算用完 429；replay miss 502 | FR-034、NFR-007、NFR-008 |
| TC-035-2〔修訂 2026-09-24〕 | 語音上傳的邊界與不落地 | 整合（同上） | 壞 multipart 400、>5 MB 413；`uploads/` 無新檔 | FR-035、NFR-008 |
| TC-020-1 | 公開樣卷的原卷文字層比對不誤報；漏一個字母即判不符 | 單元（`exam_pro/test/unit/sourceCheckSample.test.js`，mupdf 讀 `eval/fixtures/sample_exam.pdf`＋extract.v2 cassette） | 10 題中可比對 5、跳過 5、mismatch 0；改動一題後 `missing_lower` 命中。真實原卷的校準不進 CI（`eval/tools/calibrate_source_check.js`，結果只寫 `eval/local/`） | FR-020〔修訂 2026-09-15f〕 |

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
| 上游 | FR-001～FR-020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕、FR-021～FR-035〔修訂 2026-09-24〕、NFR-001／003／004／005／006、NFR-007～009〔修訂 2026-09-24〕；DEC-002、DEC-003、DEC-008、DEC-012、DEC-013、DEC-015～019〔修訂 2026-09-24〕；ADR-005、ADR-006、ADR-009、ADR-010～015〔修訂 2026-09-24〕 |
| 案例與證據 | TC-* 維護於 [`qa_tracker.md`](./qa_tracker.md) ①測試設計；執行證據（1,613／317／11〔修訂 2026-09-16b〕、五個 suite、CI badge）於 ②執行證據〔修訂 2026-08-29〕 |
| 下游 | [`../06_ops/runbook-eval-threshold-fail.md`](../06_ops/runbook-eval-threshold-fail.md)、`03_architecture/engineering_tracker.md` 驗證方式欄 |
