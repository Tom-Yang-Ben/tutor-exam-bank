# 軟體需求規格書 (SRS) - 家教專用數理題庫系統

> **版本:** v1.3 | **更新:** 2026-09-15 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2（需求；量測與端點細節屬 L3，標主語域）
> **實例:** 單例（整個系統一份）
> **定位:** 本文件將 20 條功能需求（FR-001～020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕）對應至 API 端點與 FEATURE_* 旗標，並將 NFR-001–006 逐條可驗證化（量測值與門檻）；需求決策沿革歸 [`requirements_tracker.md`](./requirements_tracker.md)，架構取捨歸 [`../03_architecture/adr/`](../03_architecture/adr/)。〔修訂 2026-08-29〕

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：①§1 新增 FR-017 題目來源標記（PR #7）與 FR-018 附圖裁切入庫（PR #3，`docs/figures.md`）；FR-007 端點欄補 GET /api/chapter-volumes；②NFR-003 測試數 1,415／259 更新為 1,445／260（commit f7a9c41 實測）；③NFR-006 原「migrations 0001–0005 共 5 份」更新為 0001–0006 共 6 份（刪除舊計數）；④§3 資料需求補 questions.source_type 與 data/figures/ 附圖列；⑤§6 補 ACPT-017-*／018-* 對照列；⑥§7 追溯之 FR 範圍隨之更新。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15 修訂**（測試數同步）：NFR-003 測試數 1,445／260／11 更新為 1,449／262／11（main 126243a 實測，2026-09-15）。修改處以〔修訂 2026-09-15〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數同步）：NFR-003 單元測試數 1,449→1,476（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15e 修訂**（feat/follow-up-links）：①§1 新增 FR-019 承上題綁定（DEC-012）；②NFR-003 單元測試數 1,476→1,499（本分支實測）；③NFR-006 migrations 範圍更新為 0001–0008 共 8 份（原記 0006 共 6 份已過時）；④§3 資料需求補 questions.follows_question_id／follows_src；⑤§6 補 ACPT-019-* 對照列；⑥§7 追溯範圍更新。修改處以〔修訂 2026-09-15e〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 審查修正）：NFR-003 測試數更新為 1,507／290／11（本分支實跑）；§6 ACPT-019-* 狀態改為已驗證。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/source-check，DEC-013、ADR-009）：§1 新增 FR-020 拆題結果對照原卷文字層、FR-006 複核原因八種→九種；NFR-003 測試數 1,476／262／11→1,534／269／11（feat/source-check 實測）；NFR-006 migrations 範圍補 0007、0009；§3 管線資料補原卷片段；§6 補 ACPT-020-* 對照；§7 追溯同步。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：定位行功能需求數 19→20；NFR-003 測試數更新為單元 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）／整合 297／e2e 11（合併後實跑）；NFR-006 migrations 範圍合為 0001–0009 共 9 份；§7 追溯之 DEC／FR 範圍合併。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：§1 FR-019 列補端點變更；§6 ACPT-019-* 補 TC-019-6～7 與 ACPT-019-6 狀態。全域測試數未改（由主線合併時統一更新）。修改處以〔修訂 2026-09-16〕行內標記。

## 目錄

- [1. 功能需求 (Functional Requirements)](#1-功能需求-functional-requirements)
- [2. 非功能需求 (NFR)](#2-非功能需求-nfr)
- [3. 資料需求 (Data Requirements)](#3-資料需求-data-requirements)
- [4. 外部介面 (External Interfaces)](#4-外部介面-external-interfaces)
- [5. 使用案例 (Use Case Specification)](#5-使用案例-use-case-specification)
- [6. 驗收標準 (Acceptance Criteria)](#6-驗收標準-acceptance-criteria)
- [7. 追溯](#7-追溯)

## 1. 功能需求 (Functional Requirements)

端點全表維護於 `exam_pro/routes/index.js`（核心區＋各階段 append-only 區塊）；旗標定義於 `exam_pro/config/features.js`（預設全關，`'1'`／`'true'` 為真）。旗標關閉時對應路由不掛載，請求落到 Express 預設 404。

| ID | 需求描述 | API 端點 | 旗標 | 來源 | 優先級 | 驗收 ID |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| FR-001 | 考卷 PDF 上傳與非同步拆題 job（狀態機 queued→extracting→processing→done/failed） | POST /api/jobs、GET /api/jobs/:id、GET /api/jobs/:id/questions、POST /api/jobs/:id/retry | FEATURE_PIPELINE（前端上傳區切換；路由恆掛載） | DEC-001、DEC-005 | Must | ACPT-001-1 |
| FR-002 | 章節分類（chapters.js 白名單；零成本閘門→kNN 投票短路→LLM） | 管線節點，無獨立端點（`exam_pro/agents/classify.js`） | 同 FR-001 | DEC-005 | Must | ACPT-002-1 |
| FR-003 | 公式修復 lint（LaTeX 白名單語法收斂） | 管線節點，無獨立端點 | 同 FR-001 | DEC-005 | Must | ACPT-003-1 |
| FR-004 | 獨立解題驗證（pro 與 flash 互相制衡、答案比對） | 管線節點，無獨立端點 | 同 FR-001 | DEC-005 | Must | ACPT-004-1 |
| FR-005 | 兩段去重（正規化雜湊→向量餘弦） | 管線節點，無獨立端點 | 同 FR-001 | DEC-005 | Must | ACPT-005-1 |
| FR-006 | 部分入庫與人工複核佇列（needs_review 九種原因〔修訂 2026-09-15f〕） | GET /api/review、GET /api/review/:jqId、POST /api/review/:jqId/approve、POST /api/review/:jqId/reject | 無（恆掛載） | DEC-005 | Must | ACPT-006-1 |
| FR-007 | 題庫管理（CRUD、分頁、batch-save 白名單硬驗證） | GET/POST /api/questions、PUT/DELETE /api/questions/:id、POST /api/batch-save-questions、GET /api/chapters、GET /api/chapter-whitelist、GET /api/chapter-volumes〔修訂 2026-08-29〕 | 無；listQuestions 走 hybrid 由 FEATURE_HYBRID_SEARCH 控制 | DEC-001 | Must | ACPT-007-1 |
| FR-008 | 組卷（草稿→確認；NOT EXISTS attempts 排除已作答；pickOnePerFamily 家族互斥） | POST /api/generate-paper、POST /api/confirm-paper、DELETE /api/papers/:id | 無（核心功能，裁決 S4-2 不掛旗標） | DEC-001、DEC-003 | Must | ACPT-008-1 |
| FR-009 | Word 匯出（LaTeX→OOXML tokenizer＋遞迴下降，docx 原生 Math 物件） | POST /api/download-word | 無 | DEC-002 | Must | ACPT-009-1 |
| FR-010 | 相似題檢索（hybrid；查詢向量取來源題 embedding，不呼叫 Gemini） | GET /api/questions/:id/similar | FEATURE_SIMILAR | DEC-006 | Should | ACPT-010-1 |
| FR-011 | 變式題（檢索優先 ≥0.80，池不足才生成，偏題閘門 ≥0.90） | POST /api/questions/:id/variants | FEATURE_VARIANTS | DEC-006 | Should | ACPT-011-1 |
| FR-012 | 自然語言查題（規則主、LLM 輔、四級回退，解析結果回寫篩選介面） | POST /api/questions/search-nl | FEATURE_NLQ | DEC-006 | Should | ACPT-012-1 |
| FR-013 | 學生弱點面板（五條純函式 SQL） | GET /api/students/:id/weakness、GET /api/students/:id/papers | FEATURE_STUDENTS | DEC-006 | Should | ACPT-013-1 |
| FR-014 | 學生管理（建立／改名／合併／刪除） | GET/POST /api/students、PATCH/DELETE /api/students/:id、POST /api/students/:id/merge | 無（核心區，GET /students 依裁決 S4-2 恆掛載） | DEC-007 | Must | ACPT-014-1 |
| FR-015 | 批改（試卷檢視與結果回寫） | GET /api/papers/:id、PATCH /api/papers/:id/results | FEATURE_STUDENTS | DEC-007 | Should | ACPT-015-1 |
| FR-016 | 對話式助教（主控 LLM ReAct 迴圈＋五個只讀工具；出卷僅 dry-run 預覽） | POST /api/assistant | FEATURE_ASSISTANT | DEC-007 | Could | ACPT-016-1 |
| FR-017 | 題目來源標記 source_type（著作權管理；五值白名單 official／school／publisher／self／unknown，入庫路徑全覆蓋、變式繼承藍本標記）〔修訂 2026-08-29〕 | 無獨立端點，附掛既有端點：POST /api/questions、POST /api/batch-save-questions、PUT /api/questions/:id（改標）、GET /api/questions（source_type 篩選）、POST /api/generate-paper（source_types 過濾，非法值 400）、POST /api/jobs（job 帶 source_type） | 沿用各宿主端點旗標 | DEC-010（PR #7，merge f8f6574） | Must | ACPT-017-1 |
| FR-018 | 附圖裁切入庫（extract 回 bbox→`services/figureService.js` 裁 PNG→`question_img`；權威文件 `docs/figures.md`） 〔修訂 2026-08-29〕 | 管線節點（`workers/jobRunner.js` attachFigureImages）＋GET /figures 靜態路由（`app.js` 掛載，非 /api、不經 x-api-key） | 同 FR-001 | DEC-011（PR #3，merge bc57c23） | Should | ACPT-018-1～3（ACPT-018-3：POST /api/download-word 嵌入本機附圖〔修訂 2026-09-16〕） |
| FR-019 | 承上題綁定（題幹含「承上題」者以 `questions.follows_question_id` 指向同份考卷上一題所落的題目；偵測 `utils/followUp.js`、寫入 `services/followUpLinker.js`；整組抽題待後續 PR；刪除／封存保護已實作〔修訂 2026-09-16〕）〔修訂 2026-09-15e〕 | 無新端點：runner 於 job_question 進終態後重算（非新節點）；POST /api/review/:jqId/approve 回應加 `follows_question_id`、reject 後重算；GET /api/review/:jqId 加 `follow_up` 區塊；回填 `npm run follow:backfill`；〔修訂 2026-09-16〕DELETE /api/questions/:id 加 `?group=1`、GET /api/questions 加 `follows_question_id`／`has_follow_ups`、POST /api/questions/:id/variants 對承上題回 409 | 同 FR-001 | DEC-012 | Should | ACPT-019-1 |
| FR-020 | 拆題結果對照原卷文字層（決定性比對、不呼叫 LLM；extract 階段以 mupdf 抽該 chunk 文字層並定位每題片段，lint 之後的 source_check 節點比對負號與字母／數字；權威文件 `docs/source-check.md`）〔修訂 2026-09-15f〕 | 管線節點（`agents/source_check.js`；片段由 `workers/jobRunner.js` attachSourceText → `services/sourceTextService.js` 寫入 `payload.extract.source_text`）；複核沿用 GET /api/review?reason=transcription_mismatch 與 approve | 同 FR-001；另 `SOURCE_CHECK_MODE`（off／shadow／enforce，預設 enforce，非法值退回 enforce） | DEC-013（feat/source-check） | Must | ACPT-020-1 |

註：POST /api/analyze-pdf（單段拆題舊路徑）保留於核心區，與 FR-001 並存；FEATURE_PIPELINE 開啟時前端上傳改走 POST /api/jobs。

## 2. 非功能需求 (NFR)

量化指標與驗證方法以本表為準；架構層對應見 [`../03_architecture/sad.md`](../03_architecture/sad.md)。量測值出自 `exam_pro/eval/` 與 CI（全綠 @ f8f6574〔修訂 2026-08-29〕）。

| ID | 類別 | 可驗證化描述 | 量測值／門檻 | 驗證方式 |
| :--- | :--- | :--- | :--- | :--- |
| NFR-001 | 安全 | 所有 /api 路由經 x-api-key 驗證（timing-safe 比對）；CORS 僅允許 ALLOWED_ORIGINS 白名單；圖片抓取經 isSafeImageUrl 防 SSRF；NODE_ENV=production 時不回傳錯誤細節 | 未帶或錯誤金鑰一律 401；非白名單來源被拒；私有網段 URL 被拒 | 單元＋整合測試（CI） |
| NFR-002 | 成本 | 高成本端點限流（獨立計數桶）：/analyze-pdf、POST /api/jobs、variants、assistant 各 10/min，search-nl 30/min，similar 60/min；上傳上限 15 MB（逾限回 413）；逐 token 計費紀錄（config/pricing.js）；單 job 與每日成本上限（`workers/jobRunner.js`：`JOB_COST_BUDGET_USD` 預設 0.5、`DAILY_COST_BUDGET_USD` 預設 5） | 第 11 次請求於 60 秒窗內被拒（429）；15 MB 逾限回 413 | 整合測試（CI） |
| NFR-003 | 可測試性 | agent 為純函式合約（不碰 DB、不讀 env、ctx 注入）；LLM 呼叫走 cassette record/replay；CI 零金鑰、零網路、零成本 | 單元 1,567／整合 297／e2e 11 全數通過（feat/follow-up-links 併入 feat/source-check 後實測，2026-09-15）〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕；CI 無 GEMINI_API_KEY | node:test＋cassette 重播（CI） |
| NFR-004 | 品質門檻 | 五個 eval suite 採 golden＋ratchet（首測 −0.03、只升不降）；低於門檻 CI 轉紅；replay miss 於 main 視為錯誤 | pipeline saved_rate 0.90（門檻 ≥0.87）、gate_pass_rate 1.00；classify accuracy 0.9000／macro-F1 0.9256；檢索 Recall@5 hybrid(RRF) 1.000（LIKE 基線 0.875）；NLQ 規則路徑 coverage 0.84；variant retrieved_coverage 0.8667、偏題閘門 ≥0.90（0.92→0.90，裁決 S3-R29） | eval suite（CI 門檻檢查） |
| NFR-005 | 可靠性 | job 認領採 FOR UPDATE SKIP LOCKED＋租約，worker 中斷後租約到期由他機續跑（斷點續跑）；各節點逾時、退避重試、重試預算，預算用盡轉 needs_review | 節點逾時 120 秒（`JOB_NODE_TIMEOUT_MS`）；租約 180 秒（`JOB_LEASE_MS`）；fail 重試預算 classify 2／lint 2／verify 1／extract 整包 1；error 獨立計數上限 3，退避 1s→2s→4s 封頂 60s（詳 [lld §4.1](../04_design/lld.md)） | 整合測試（jobRunner；CI） |
| NFR-006 | 資料一致性 | confirm-paper 之組卷與作答歷史（attempts）寫入同一交易；migrations 只增不改 | migrations 0001_init–0009_source_check，共 9 份，無修改既有檔〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕 | 整合測試＋migration 檔案稽核 |

## 3. 資料需求 (Data Requirements)

| 資料實體 | 來源系統 | 保留政策 | 敏感等級 |
| :--- | :--- | :--- | :--- |
| questions（含 768 維 embedding、text_hash 唯一鍵、source_type 五值 CHECK——0006，NOT NULL DEFAULT 'unknown'；jobs.source_type 可 NULL〔修訂 2026-08-29〕；承上題自我參照 follows_question_id＋follows_src——0008，FK NO ACTION〔修訂 2026-09-15e〕） | 本系統（拆題管線／手動建立） | 本地 PG 長期保留；repo 不含題庫內容（DEC-009） | 私有資產（題庫） |
| data/figures/（附圖 PNG，檔名 `<jobId>-<idx>.png`；questions.question_img 存相對路徑 `/figures/<jobId>-<idx>.png`）〔修訂 2026-08-29〕 | 本系統（管線裁圖，`services/figureService.js`） | 本地檔案系統保留；GET /figures 靜態供圖 | 中（原始考卷衍生圖） |
| students／papers／attempts | 本系統 | 本地 PG 長期保留 | 含個資（學生姓名） |
| jobs／job_questions／job_events | 本系統（管線） | 本地 PG 保留（含逐步成本紀錄）；`payload.extract.source_text` 只存每題定位到的原卷片段（≤1500 字），PDF 原檔拆完即刪〔修訂 2026-09-15f〕 | 低（含上傳檔衍生內容；原卷片段屬考卷衍生文字，隨題庫留本地） |
| uploads/（PDF 暫存） | 使用者上傳 | 暫存目錄 | 中（原始考卷） |

## 4. 外部介面 (External Interfaces)

| 介面 | 方向 | 協議 | 契約文件 |
| :--- | :--- | :--- | :--- |
| Google Gemini（gemini-3.5-flash 拆題／分類／變式、gemini-3.1-pro-preview 驗答、gemini-embedding-001 768 維；模型 ID 單一真相 `exam_pro/config/models.js`） | 出 | REST（HTTPS） | [`../04_design/api_spec.md`](../04_design/api_spec.md) |
| PostgreSQL 16 + pgvector（開發 5442／測試 5433） | 出 | TCP（SQL） | [`../03_architecture/adr/ADR-001-pgvector-over-dedicated-vector-db.md`](../03_architecture/adr/ADR-001-pgvector-over-dedicated-vector-db.md) |
| 前端 SPA（零打包器單頁 HTML + ES modules） | 入 | REST（/api，x-api-key） | [`../02_ux_ui/`](../02_ux_ui/) 各 ui_spec |

## 5. 使用案例 (Use Case Specification)

### 5.1 為指定學生組卷並匯出 Word（對應 UAT 場景 SCN-009／SCN-010）

| 項目 | 內容 |
| :--- | :--- |
| **Actor** | 家教老師（單人使用） |
| **Preconditions** | 題庫已有題目；學生已建檔（FR-014） |
| **Main Flow** | 1. 選學生與篩選條件送 POST /api/generate-paper 取得草稿 2. 檢視草稿後送 POST /api/confirm-paper 確認（同交易寫入 papers 與 attempts） 3. POST /api/download-word 取得 `.docx`（Word 原生方程式） |
| **Alternative Flow** | A1. 草稿不滿意：放棄草稿重新產生（未確認即不寫作答歷史）；A2. 誤確認：DELETE /api/papers/:id 刪卷 |
| **Postconditions** | 該生 attempts 含本卷題目；後續組卷經 NOT EXISTS 排除，且同家族僅取一題（pickOnePerFamily） |
| **引用規則** | DEC-002、DEC-003 |

## 6. 驗收標準 (Acceptance Criteria)

AC 以 Given/When/Then 落在 [`prd.md`](./prd.md) ACPT 段；此處維護對照表。狀態依 CI 全綠 @ f8f6574 標記〔修訂 2026-08-29〕。

| ACPT ID | 對應 FR | 驗證案例 | 狀態 |
| :--- | :--- | :--- | :--- |
| ACPT-001-* – ACPT-006-* | FR-001–006 | TC-001-1–TC-006-1（管線：上傳→拆題→分類→lint→驗答→去重→部分入庫／複核）；邊界場景 SCN-011、SCN-012 | 已驗證 |
| ACPT-007-* – ACPT-009-* | FR-007–009 | TC-007-1–TC-009-2（題庫管理、組卷排除已作答、Word 匯出）；UAT SCN-009、SCN-010 | 已驗證 |
| ACPT-010-* – ACPT-013-* | FR-010–013 | TC-010-1–TC-013-1（相似題、變式題、NLQ、弱點面板）；邊界場景 SCN-013、SCN-014 | 已驗證 |
| ACPT-014-* – ACPT-016-* | FR-014–016 | TC-014-1–TC-016-1（學生管理、批改、對話式助教）；邊界場景 SCN-015、SCN-016 | 已驗證 |
| ACPT-017-* | FR-017 | 單元（SOURCE_TYPES 凍結＋與 0006 CHECK 一致）＋整合（建題→過濾→組卷過濾→改標端到端）〔修訂 2026-08-29〕 | 已驗證（CI 全綠 @ f7a9c41） |
| ACPT-018-* | FR-018 | 單元＋整合（cassette 已重錄 @ 4af4647，含 extract bbox 節點）〔修訂 2026-08-29〕；ACPT-018-3 為 TC-018-2（單元 `test/unit/wordFigures.test.js`）＋TC-009-2 e2e 附圖斷言〔修訂 2026-09-16〕 | 已驗證（CI）；真實考卷 bbox 準度待驗；ACPT-018-3 本機實跑通過、待 CI 與 Word 實機開檔確認〔修訂 2026-09-16〕 |
| ACPT-019-* | FR-019 | TC-019-1～TC-019-4：單元（isFollowUp／findPredecessorRow／resolveQuestionId）＋整合（followUp.pg.test.js：runner 綁定、複核重算、保護與補強、回填腳本；schema.test.js 0008 斷言）〔修訂 2026-09-15e〕；TC-019-6～7：整組刪除／封存、變式藍本 409、列表承上欄位、承上題不得當變式藍本〔修訂 2026-09-16〕 | ACPT-019-1～4 已驗證（本分支實跑單元 1,507／整合 290／e2e 11；複核畫面前端顯示待 PR3）〔修訂 2026-09-15f〕；ACPT-019-5 待 PR2；ACPT-019-6 已驗證（feat/follow-up-protect-badge：DELETE `?group=1` 整組處理、封存前題 409、題庫列表徽章）〔修訂 2026-09-16〕 |
| ACPT-020-* | FR-020 | TC-020-1～3：單元（正規化／定位／比對／agent 合約、公開樣卷 0 誤報）＋整合（transcription_mismatch 進複核、approve 事件、0009 CHECK）＋e2e（樣卷 source_text 落地、無誤判）＋eval pipeline〔修訂 2026-09-15f〕 | 已驗證（feat/source-check 本機全綠）；真實原卷校準見 `docs/source-check.md` 第 4 節 |

## 7. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | DEC-001–DEC-012（[`requirements_tracker.md`](./requirements_tracker.md)）、[`prd.md`](./prd.md) 之 FR 初稿〔修訂 2026-09-15e〕；DEC-013〔修訂 2026-09-15f〕 |
| 本文件產出 | FR-001–FR-020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕、NFR-001–NFR-006、使用案例（§5.1，對應 UAT SCN-009／SCN-010）、ACPT 對照（§6）〔修訂 2026-08-29〕 |
| 下游 | [`../03_architecture/sad.md`](../03_architecture/sad.md) §4 需求摘要、[`../03_architecture/engineering_tracker.md`](../03_architecture/engineering_tracker.md)、[`../05_qa/test_plan.md`](../05_qa/test_plan.md)、[`../05_qa/qa_tracker.md`](../05_qa/qa_tracker.md) |
