# 軟體需求規格書 (SRS) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2（需求；量測與端點細節屬 L3，標主語域）
> **實例:** 單例（整個系統一份）
> **定位:** 本文件將 16 條功能需求對應至 API 端點與 FEATURE_* 旗標，並將 NFR-001–006 逐條可驗證化（量測值與門檻）；需求決策沿革歸 [`requirements_tracker.md`](./requirements_tracker.md)，架構取捨歸 [`../03_architecture/adr/`](../03_architecture/adr/)。

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
| FR-006 | 部分入庫與人工複核佇列（needs_review 八種原因） | GET /api/review、GET /api/review/:jqId、POST /api/review/:jqId/approve、POST /api/review/:jqId/reject | 無（恆掛載） | DEC-005 | Must | ACPT-006-1 |
| FR-007 | 題庫管理（CRUD、分頁、batch-save 白名單硬驗證） | GET/POST /api/questions、PUT/DELETE /api/questions/:id、POST /api/batch-save-questions、GET /api/chapters、GET /api/chapter-whitelist | 無；listQuestions 走 hybrid 由 FEATURE_HYBRID_SEARCH 控制 | DEC-001 | Must | ACPT-007-1 |
| FR-008 | 組卷（草稿→確認；NOT EXISTS attempts 排除已作答；pickOnePerFamily 家族互斥） | POST /api/generate-paper、POST /api/confirm-paper、DELETE /api/papers/:id | 無（核心功能，裁決 S4-2 不掛旗標） | DEC-001、DEC-003 | Must | ACPT-008-1 |
| FR-009 | Word 匯出（LaTeX→OOXML tokenizer＋遞迴下降，docx 原生 Math 物件） | POST /api/download-word | 無 | DEC-002 | Must | ACPT-009-1 |
| FR-010 | 相似題檢索（hybrid；查詢向量取來源題 embedding，不呼叫 Gemini） | GET /api/questions/:id/similar | FEATURE_SIMILAR | DEC-006 | Should | ACPT-010-1 |
| FR-011 | 變式題（檢索優先 ≥0.80，池不足才生成，偏題閘門 ≥0.90） | POST /api/questions/:id/variants | FEATURE_VARIANTS | DEC-006 | Should | ACPT-011-1 |
| FR-012 | 自然語言查題（規則主、LLM 輔、四級回退，解析結果回寫篩選介面） | POST /api/questions/search-nl | FEATURE_NLQ | DEC-006 | Should | ACPT-012-1 |
| FR-013 | 學生弱點面板（五條純函式 SQL） | GET /api/students/:id/weakness、GET /api/students/:id/papers | FEATURE_STUDENTS | DEC-006 | Should | ACPT-013-1 |
| FR-014 | 學生管理（建立／改名／合併／刪除） | GET/POST /api/students、PATCH/DELETE /api/students/:id、POST /api/students/:id/merge | 無（核心區，GET /students 依裁決 S4-2 恆掛載） | DEC-007 | Must | ACPT-014-1 |
| FR-015 | 批改（試卷檢視與結果回寫） | GET /api/papers/:id、PATCH /api/papers/:id/results | FEATURE_STUDENTS | DEC-007 | Should | ACPT-015-1 |
| FR-016 | 對話式助教（主控 LLM ReAct 迴圈＋五個只讀工具；出卷僅 dry-run 預覽） | POST /api/assistant | FEATURE_ASSISTANT | DEC-007 | Could | ACPT-016-1 |

註：POST /api/analyze-pdf（單段拆題舊路徑）保留於核心區，與 FR-001 並存；FEATURE_PIPELINE 開啟時前端上傳改走 POST /api/jobs。

## 2. 非功能需求 (NFR)

量化指標與驗證方法以本表為準；架構層對應見 [`../03_architecture/sad.md`](../03_architecture/sad.md)。量測值出自 `exam_pro/eval/` 與 CI（全綠 @ 0ff47b4）。

| ID | 類別 | 可驗證化描述 | 量測值／門檻 | 驗證方式 |
| :--- | :--- | :--- | :--- | :--- |
| NFR-001 | 安全 | 所有 /api 路由經 x-api-key 驗證（timing-safe 比對）；CORS 僅允許 ALLOWED_ORIGINS 白名單；圖片抓取經 isSafeImageUrl 防 SSRF；NODE_ENV=production 時不回傳錯誤細節 | 未帶或錯誤金鑰一律 401；非白名單來源被拒；私有網段 URL 被拒 | 單元＋整合測試（CI） |
| NFR-002 | 成本 | 高成本端點限流（獨立計數桶）：/analyze-pdf、POST /api/jobs、variants、assistant 各 10/min，search-nl 30/min，similar 60/min；上傳上限 15 MB（逾限回 413）；逐 token 計費紀錄（config/pricing.js）；單 job 與每日成本上限（`workers/jobRunner.js`；上限數值（待補）） | 第 11 次請求於 60 秒窗內被拒（429）；15 MB 逾限回 413 | 整合測試（CI） |
| NFR-003 | 可測試性 | agent 為純函式合約（不碰 DB、不讀 env、ctx 注入）；LLM 呼叫走 cassette record/replay；CI 零金鑰、零網路、零成本 | 單元 1,415／整合 259／e2e 11 全數通過；CI 無 GEMINI_API_KEY | node:test＋cassette 重播（CI） |
| NFR-004 | 品質門檻 | 五個 eval suite 採 golden＋ratchet（首測 −0.03、只升不降）；低於門檻 CI 轉紅；replay miss 於 main 視為錯誤 | pipeline saved_rate 0.90（門檻 ≥0.87）、gate_pass_rate 1.00；classify accuracy 0.9000／macro-F1 0.9256；檢索 Recall@5 hybrid(RRF) 1.000（LIKE 基線 0.875）；NLQ 規則路徑 coverage 0.84；variant retrieved_coverage 0.8667、偏題閘門 ≥0.90（0.92→0.90，裁決 S3-R29） | eval suite（CI 門檻檢查） |
| NFR-005 | 可靠性 | job 認領採 FOR UPDATE SKIP LOCKED＋租約，worker 中斷後租約到期由他機續跑（斷點續跑）；各節點逾時、退避重試、重試預算，預算用盡轉 needs_review | 逾時秒數與重試預算次數（待補） | 整合測試（jobRunner；CI） |
| NFR-006 | 資料一致性 | confirm-paper 之組卷與作答歷史（attempts）寫入同一交易；migrations 只增不改 | migrations 0001_init–0005_text_hash_unique，共 5 份，無修改既有檔 | 整合測試＋migration 檔案稽核 |

## 3. 資料需求 (Data Requirements)

| 資料實體 | 來源系統 | 保留政策 | 敏感等級 |
| :--- | :--- | :--- | :--- |
| questions（含 768 維 embedding、text_hash 唯一鍵） | 本系統（拆題管線／手動建立） | 本地 PG 長期保留；repo 不含題庫內容（DEC-009） | 私有資產（題庫） |
| students／papers／attempts | 本系統 | 本地 PG 長期保留 | 含個資（學生姓名） |
| jobs／job_questions／job_events | 本系統（管線） | 本地 PG 保留（含逐步成本紀錄） | 低（含上傳檔衍生內容） |
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

AC 以 Given/When/Then 落在 [`prd.md`](./prd.md) ACPT 段；此處維護對照表。狀態依 CI 全綠 @ 0ff47b4 標記。

| ACPT ID | 對應 FR | 驗證案例 | 狀態 |
| :--- | :--- | :--- | :--- |
| ACPT-001-* – ACPT-006-* | FR-001–006 | TC-001-1–TC-006-1（管線：上傳→拆題→分類→lint→驗答→去重→部分入庫／複核）；邊界場景 SCN-011、SCN-012 | 已驗證 |
| ACPT-007-* – ACPT-009-* | FR-007–009 | TC-007-1–TC-009-2（題庫管理、組卷排除已作答、Word 匯出）；UAT SCN-009、SCN-010 | 已驗證 |
| ACPT-010-* – ACPT-013-* | FR-010–013 | TC-010-1–TC-013-1（相似題、變式題、NLQ、弱點面板）；邊界場景 SCN-013、SCN-014 | 已驗證 |
| ACPT-014-* – ACPT-016-* | FR-014–016 | TC-014-1–TC-016-1（學生管理、批改、對話式助教）；邊界場景 SCN-015、SCN-016 | 已驗證 |

## 7. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | DEC-001–DEC-009（[`requirements_tracker.md`](./requirements_tracker.md)）、[`prd.md`](./prd.md) 之 FR 初稿 |
| 本文件產出 | FR-001–FR-016、NFR-001–NFR-006、使用案例（§5.1，對應 UAT SCN-009／SCN-010）、ACPT 對照（§6） |
| 下游 | [`../03_architecture/sad.md`](../03_architecture/sad.md) §4 需求摘要、[`../03_architecture/engineering_tracker.md`](../03_architecture/engineering_tracker.md)、[`../05_qa/test_plan.md`](../05_qa/test_plan.md)、[`../05_qa/qa_tracker.md`](../05_qa/qa_tracker.md) |
