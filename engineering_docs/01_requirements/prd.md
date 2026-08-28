# 產品需求文件 (PRD) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2（功能需求與允收標準；業務決策細節歸 requirements_tracker）
> **實例:** 單例
> **定位:** 本文件回答「系統提供哪些功能（FR-001～018）、各功能以何種可觀察行為驗收（ACPT）、AI 不確定性的邊界場景（SCN）」；需求決策沿革歸 [`requirements_tracker.md`](./requirements_tracker.md)，技術實作與 ADR 歸 `../03_architecture/`。〔修訂 2026-08-29〕

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：①§3.1 新增 FR-017 題目來源標記 source_type（PR #7，merge f8f6574）與 FR-018 附圖裁切入庫（PR #3，merge bc57c23，權威文件 `docs/figures.md`）及其 ACPT-017-1～3、ACPT-018-1～2；②§5 擱置區「附圖裁切入庫」原記「已定案未動工」為事實錯誤，改註「已完成」（2026-08-27 實作合併，cassette 已重錄 @ 4af4647）——舊記載之「2026-08-25 定案」日期保留為 DEC-011 核准依據；③定位行、§4 功能範圍與 §6 追溯之 FR/ACPT 編號範圍隨之更新。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。

---

## 目錄

- [1. 專案總覽](#1-專案總覽)
- [2. 商業目標](#2-商業目標)
- [3. 功能需求與允收標準](#3-功能需求與允收標準)
- [4. 範圍與限制](#4-範圍與限制)
- [5. 待辦問題與決策](#5-待辦問題與決策)
- [6. 追溯](#6-追溯)

## 1. 專案總覽

| 項目 | 內容 |
| :--- | :--- |
| **專案名稱** | 家教專用數理題庫系統（repo：期中專案；系統本體 `exam_pro/`） |
| **狀態** | 已上線——四階段全數完成，CI 全綠 @ f8f6574〔修訂 2026-08-29〕 |
| **關鍵日期** | 2026-08-21 資料層切換上線（PostgreSQL 16 + pgvector）；2026-08-24 階段 4 凍結 |
| **核心團隊** | 單人開發與維運：Ben（楊本顥） |
| **使用者** | 一對一數理家教老師（高中數學／物理），單人使用 |

---

## 2. 商業目標

| 項目 | 內容 |
| :--- | :--- |
| **背景與痛點** | 出卷的行政損耗遠大於教學：複雜公式在 Word 手動排版易跑位；題目散在各考卷、學生作答紀錄無從追蹤，重複出題傷害練習效果；一份特訓卷常花 2 小時以上（README §問題背景） |
| **目標** | 出一份卷從 2 小時縮短到幾分鐘；上傳 PDF → 拆題入庫 → 一鍵組卷 → 匯出可直接列印的 Word，全程零手動排版 |
| **第二目標** | 在同一實際運作的產品上，將多 Agent 協作與 RAG 檢索落實為可檢視、可量測、可逐行驗證的工程實作（階段 2 起） |
| **成功指標** | 主要：同一學生保證不拿到已寫過的題目（DEC-003）／次要：pipeline saved_rate 0.90（門檻 ≥0.87）、檢索 Recall@5 hybrid 1.000（eval 實測） |

---

## 3. 功能需求與允收標準

### 3.1 功能清單與允收標準（ACPT 一律為可觀察行為）

| FR | 功能 | ACPT | 允收標準（Given / When / Then） |
| :--- | :--- | :--- | :--- |
| FR-001 | 考卷 PDF 上傳與非同步拆題 job | ACPT-001-1 | Given 考卷 PDF，When `POST /api/jobs`，Then 立即回傳 job，狀態僅沿 queued→extracting→processing→done/failed 合法轉移 |
| | | ACPT-001-2 | When worker 中斷，Then 租約到期後其他 worker 認領續跑（FOR UPDATE SKIP LOCKED），job 不永久卡住 |
| FR-002 | 章節分類 | ACPT-002-1 | Then 分類結果必屬 `exam_pro/config/chapters.js` 白名單，違者不得入庫 |
| | | ACPT-002-2 | Given 最近 5 鄰中 ≥4 題為人工確認之同一章節且最近鄰相似度 ≥0.90，Then 直接採用 kNN 結果、不呼叫 LLM |
| FR-003 | 公式修復 lint | ACPT-003-1 | Then 輸出 LaTeX 收斂為白名單語法（強制 `\frac{}{}`，禁止斜線分數），未通過者不得標記 linted |
| FR-004 | 獨立解題驗證 | ACPT-004-1 | Then verify 以 `gemini-3.1-pro-preview` 獨立重解並比對答案；與拆題結果不一致時該題轉 needs_review，不得入庫 |
| FR-005 | 兩段去重 | ACPT-005-1 | Then 先以正規化雜湊、後以向量餘弦判定重複；判為重複之題目不入庫 |
| FR-006 | 部分入庫與人工複核佇列 | ACPT-006-1 | Given 一批題目部分未過閘門，Then 合格題照常入庫，未過者附八種原因之一進入 needs_review（見 SCN-011） |
| | | ACPT-006-2 | When 複核佇列 approve／reject，Then 該題分別入庫／標記 rejected |
| FR-007 | 題庫管理 | ACPT-007-1 | Then questions CRUD 與列表分頁可用；batch-save 對章節、題型（限五種）、難度（1–5 整數）逐題白名單硬驗證，不合格者擋下 |
| FR-008 | 組卷（草稿→確認） | ACPT-008-1 | When `generate-paper` 帶 `dry_run:true`，Then 走完全相同選題邏輯但整段不寫庫；「換一題」以 `exclude_ids`（上限 200）重抽 |
| | | ACPT-008-2 | When `confirm-paper`，Then 交易內重驗後建卷＋attempts；同一學生已作答題（NOT EXISTS attempts）與同變式家族題不出現於同一卷 |
| | | ACPT-008-3 | Given `student_name` 查無此人，Then 回 404 並提示先新增學生，不自動建立（裁決 S4-1） |
| FR-009 | Word 匯出 | ACPT-009-1 | When `download-word`，Then 產出 `.docx`，公式為 Word 原生 Math 物件（直式分數，可用方程式編輯器開啟編輯） |
| | | ACPT-009-2 | Given 未知 LaTeX 指令，Then 該片段退化為純文字，單一公式失敗不使整份匯出失敗 |
| FR-010 | 相似題檢索 | ACPT-010-1 | When `GET /api/questions/:id/similar`，Then 回傳同科、hybrid（RRF）排序之相似題；golden 量測 Recall@5 1.000（ratchet 門檻保障） |
| FR-011 | 變式題 | ACPT-011-1 | Given 題庫檢索到相似度 ≥0.80 之同難度題且數量足夠，Then 直接推薦、不產生生成費用（見 SCN-014） |
| | | ACPT-011-2 | When 進入生成，Then 產物與原題相似度 <0.90 者被偏題閘門退回、不呈現給使用者 |
| FR-012 | 自然語言查題 | ACPT-012-1 | When `POST /api/questions/search-nl`，Then 規則層解析出的章節／難度／學生條件回寫至篩選介面，供使用者檢視修正 |
| | | ACPT-012-2 | Given 任一解析路徑失敗，Then 依四級回退階梯降級，最終仍回傳可用結果或明確空集，不擲未處理錯誤（見 SCN-013） |
| FR-013 | 學生弱點面板 | ACPT-013-1 | When `GET /api/students/:id/weakness`，Then 以五條純函式 SQL 回傳統計；前端時間窗預設 365 天且恆帶參數（裁決 S4-4） |
| FR-014 | 學生管理 | ACPT-014-1 | When 建立／改名，Then trim 後空回 400、重名回 409、查無回 404 |
| | | ACPT-014-2 | When merge，Then 同一交易搬移 attempts 與 papers、衝突題保留目標側批改並回報 `dropped_conflicts`；自併回 400 |
| | | ACPT-014-3 | When 刪除學生，Then 同一交易刪 attempts→exam_papers→student；操作不可逆，前端二次確認 |
| FR-015 | 批改 | ACPT-015-1 | When `PATCH /api/papers/:id/results`，Then 批改結果落庫；「未批的全部標為對」僅改前端狀態，仍走原 diff→PATCH 流程 |
| FR-016 | 對話式助教 | ACPT-016-1 | Then 主控以受限 JSON `{action, tool, args_json, reply}` 決策，僅得調用五個只讀工具，工具調用軌跡完整呈現於介面 |
| | | ACPT-016-2 | Then 助教無寫入權：出卷僅能 dry-run 預覽，實際出卷仍由使用者確認 |
| | | ACPT-016-3 | Given 達步數上限，Then 迴圈截斷並如實作結（見 SCN-015） |
| FR-017 | 題目來源標記 source_type（著作權管理）〔修訂 2026-08-29〕 | ACPT-017-1 | Then 每題之 `source_type` 必屬五值白名單（official／school／publisher／self／unknown，DDL CHECK 與 `config/chapters.js` SOURCE_TYPES 一致），未標記落地為 unknown；手動建題、batch-save、管線入庫、複核 approve 全路徑帶標記，上傳 job 標一次全批沿用 |
| | | ACPT-017-2 | When `generate-paper` 帶 `source_types` 過濾，Then 僅抽指定來源之題；含非法值回 400、空陣列不限制；dry_run 預覽逐題帶來源 |
| | | ACPT-017-3 | Then 題庫列表可依來源篩選並顯示徽章、單題可改標；變式 job 繼承藍本標記、不自動漂白——改寫是否充分由使用者確認後改標 self |
| FR-018 | 附圖裁切入庫（權威文件 `docs/figures.md`）〔修訂 2026-08-29〕 | ACPT-018-1 | Given extract 回傳 `figure_page`＋`figure_box`（0–1000 正規化 bbox），Then 於 PDF 刪檔前裁成 PNG 存 `data/figures/<jobId>-<idx>.png`，`question_img` 寫入 `/figures/<jobId>-<idx>.png` 並由靜態路由供圖 |
| | | ACPT-018-2 | Given bbox 退化（無效框），Then 該題略過裁圖並記 log，其餘照常入庫；檔名確定性，崩潰重跑覆寫同檔不堆積 |

### 3.2 邊界場景（AI 不確定性的行為界定）

| SCN | 場景 | 預期可觀察行為 |
| :--- | :--- | :--- |
| SCN-011 | 部分入庫：一批 90 題中 3 題有疑慮 | 87 題照常入庫；3 題附具體原因（八種之一）進人工複核佇列——不整批失敗、不靜默丟棄 |
| SCN-012 | 單題重試預算用盡 | 機器產生之 feedback 併回 prompt 逐題重試；預算用盡後轉 needs_review，其餘題目不受影響 |
| SCN-013 | NLQ 解析失敗 | 依四級回退階梯逐級降級（規則主、LLM 輔）；使用者始終得到結果或明確空集 |
| SCN-014 | 變式題池不足 | 檢索命中不足才進入生成，以藍本＋前 5 題鄰居為錨點；生成後偏題閘門（≥0.90）攔截跑題產物 |
| SCN-015 | 助教查詢無結果或步數耗盡 | 空結果亦為答案：至多換一次措辭重查，仍為空即如實回報；達步數上限即截斷，不無限重試 |
| SCN-016 | 助教工具調用出錯 | 工具錯誤回饋給主控 LLM 自行修正下一步，不直接以 5xx 中斷對話 |

註：SCN-001～SCN-010 為 UAT 環境與主流程場景，編號歸 [`../05_qa/uat_plan.md`](../05_qa/uat_plan.md)；本節自 SCN-011 起編。

---

## 4. 範圍與限制

| 項目 | 內容 |
| :--- | :--- |
| **功能範圍** | 拆題管線（FR-001～006）／題庫與出卷（FR-007～009）／RAG 三落點與 NLQ（FR-010～013）／產品收斂與助教（FR-014～016）／上線後增量：來源標記與附圖（FR-017～018）〔修訂 2026-08-29〕 |
| **非功能需求** | 安全 NFR-001／成本 NFR-002／可測試性 NFR-003／品質門檻 NFR-004／可靠性 NFR-005／資料一致性 NFR-006（詳 `../03_architecture/engineering_tracker.md`） |
| **不做什麼** | 多租戶與帳號系統（單人使用）；助教寫入權（工具一律只讀）；LLM 編排拆題流程（流程已知，編排歸程式碼，ADR-003）。（P-16 參數化模板原列於此，2026-08-25 核准重啟，見 §5） |
| **假設與依賴** | 假設：題庫規模數百至數千題、單人維運。依賴：Google Gemini API（模型 ID 單一真相 `exam_pro/config/models.js`）、Docker（PG16+pgvector，開發 5442／測試 5433） |
| **資料界線** | 題庫屬私有資產（DEC-009）：資料與驗證邏輯留本地，僅 LLM 呼叫對外；repo 不含題庫內容，示範題自製（`exam_pro/seed_questions.js` 30 題） |

---

## 5. 待辦問題與決策

| ID | 描述 | 狀態 | 負責人 |
| :--- | :--- | :--- | :--- |
| DEC-007（裁決 S4-1～S4-3） | 出卷改為草稿→確認：dry_run 不寫庫，confirm 才建卷與 attempts；學生改為下拉選取，`generate-paper` 不再自動建學生——人名（小／名／華）分裂之根因矯正 | 已核准 | Ben |
| DEC-006（裁決 S3-R29） | 變式偏題閾值 0.92→0.90 下修並重錄 | 已核准 | Ben |
| P-16 | 參數化模板重啟 | 已核准重啟（2026-08-25 Owner 裁示）；未動工，規劃待啟動 | Ben |
| 併名資料清理 | 已結案（2026-08-25）：前期測試學生皆為假資料，隨作答與試卷全數刪除（刪除前備份 `exam_pro/backups/tutor_exam_bank_2026-08-25_1801.dump`），併名懸案消滅；題庫 103 題不受影響 | 已結案 | Ben |
| 附圖裁切入庫 | extract 回傳 bbox＋程式裁圖存 `question_img`；2026-08-25 定案，2026-08-27 完整實作合併（PR #3，權威文件 `docs/figures.md`；cassette 已重錄 @ 4af4647），正規化為 FR-018 〔修訂 2026-08-29〕 | 已完成 | Ben |

---

## 6. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | DEC-001～DEC-011（[`requirements_tracker.md`](./requirements_tracker.md) ①需求決策）〔修訂 2026-08-29〕 |
| 本文件產出 | FR-001～FR-018、ACPT-001-1～ACPT-018-2、SCN-011～SCN-016〔修訂 2026-08-29〕 |
| 下游 | [`./srs.md`](./srs.md)（FR 細化為系統規格與 NFR）、`../03_architecture/engineering_tracker.md`（FR/NFR→模組→ADR）、`../02_ux_ui/`（ui_spec-* 以 FR 引用）、[`../05_qa/test_plan.md`](../05_qa/test_plan.md)（測試策略依 FR/ACPT 展開）、`../05_qa/qa_tracker.md`（TC-* 依 FR 分組） |
