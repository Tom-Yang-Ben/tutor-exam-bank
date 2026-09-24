# 軟體需求規格書 (SRS) - 家教專用數理題庫系統

> **版本:** v1.4 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2（需求；量測與端點細節屬 L3，標主語域）
> **實例:** 單例（整個系統一份）
> **定位:** 本文件將 35 條功能需求（FR-001～020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕；FR-021～035〔修訂 2026-09-24〕）對應至 API 端點與 FEATURE_* 旗標，並將 NFR-001–009〔修訂 2026-09-24〕逐條可驗證化（量測值與門檻）；需求決策沿革歸 [`requirements_tracker.md`](./requirements_tracker.md)，架構取捨歸 [`../03_architecture/adr/`](../03_architecture/adr/)。〔修訂 2026-08-29〕

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：①§1 新增 FR-017 題目來源標記（PR #7）與 FR-018 附圖裁切入庫（PR #3，`docs/figures.md`）；FR-007 端點欄補 GET /api/chapter-volumes；②NFR-003 測試數 1,415／259 更新為 1,445／260（commit f7a9c41 實測）；③NFR-006 原「migrations 0001–0005 共 5 份」更新為 0001–0006 共 6 份（刪除舊計數）；④§3 資料需求補 questions.source_type 與 data/figures/ 附圖列；⑤§6 補 ACPT-017-*／018-* 對照列；⑥§7 追溯之 FR 範圍隨之更新。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15 修訂**（測試數同步）：NFR-003 測試數 1,445／260／11 更新為 1,449／262／11（main 126243a 實測，2026-09-15）。修改處以〔修訂 2026-09-15〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數同步）：NFR-003 單元測試數 1,449→1,476（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15e 修訂**（feat/follow-up-links）：①§1 新增 FR-019 承上題綁定（DEC-012）；②NFR-003 單元測試數 1,476→1,499（本分支實測）；③NFR-006 migrations 範圍更新為 0001–0008 共 8 份（原記 0006 共 6 份已過時）；④§3 資料需求補 questions.follows_question_id／follows_src；⑤§6 補 ACPT-019-* 對照列；⑥§7 追溯範圍更新。修改處以〔修訂 2026-09-15e〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 審查修正）：NFR-003 測試數更新為 1,507／290／11（本分支實跑）；§6 ACPT-019-* 狀態改為已驗證。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/source-check，DEC-013、ADR-009）：§1 新增 FR-020 拆題結果對照原卷文字層、FR-006 複核原因八種→九種；NFR-003 測試數 1,476／262／11→1,534／269／11（feat/source-check 實測）；NFR-006 migrations 範圍補 0007、0009；§3 管線資料補原卷片段；§6 補 ACPT-020-* 對照；§7 追溯同步。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：定位行功能需求數 19→20；NFR-003 測試數更新為單元 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）／整合 297／e2e 11（合併後實跑）；NFR-006 migrations 範圍合為 0001–0009 共 9 份；§7 追溯之 DEC／FR 範圍合併。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-15g 修訂**（feat/follow-up-paper-group，FR-019 PR2）：§1 FR-019 列補組卷整組抽取的模組與端點行為；§6 ACPT-019-5、019-7 改為已驗證（TC-019-8）。NFR-003 全域測試數由主線合併時統一更新，本分支不動。修改處以〔修訂 2026-09-15g〕行內標記。
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：§1 FR-019 列補端點變更；§6 ACPT-019-* 補 TC-019-6～7 與 ACPT-019-6 狀態。全域測試數未改（由主線合併時統一更新）。修改處以〔修訂 2026-09-16〕行內標記。
> 🛠 **2026-09-16b 修訂**（主線同步，PR #30–#33 合併後）：NFR-003 全域測試數同步為單元 1,613／整合 317／e2e 11（PR #30–#33 併入 main 後 CI 實測，run 35072043839 之後的主線）。修改處以〔修訂 2026-09-16b〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 教學診斷平台整合回填，分支 `stage5/int-docs`；契約 [`docs/interfaces-stage5.md`](../../docs/interfaces-stage5.md) 第 1.7、8 條）：①§1 新增 FR-021～035，逐條對應 DEC-015～019（DEC-014 為定位決策，不單獨對應 FR），並列出尚未分配 FR 的 TO-BE 項目；②§2 NFR-001／002／003／006 更新，新增 NFR-007（AI 家教／語音／知識點標註的成本上限）、NFR-008（錄音不落地與學生資料不出境）、NFR-009（既有 cassette 不失效的相容性約束）；NFR-003 測試數寫為「整合分支 stage5/integration 當下：unit 2253、integration 471、e2e 11，另有整合補測進行中」，主控合併後更新；③§3 資料需求補 migrations 0010–0012 的實體與知識點種子檔、錄音；④§4 外部介面補 Gemini code execution 與音訊輸入；⑤§5 新增使用案例 5.2（批改→診斷→補救卷）；⑥§6 補 ACPT-021-*～035-* 對照；⑦§7 追溯同步。修改處以〔修訂 2026-09-24〕行內標記。

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
| FR-019 | 承上題綁定（題幹含「承上題」者以 `questions.follows_question_id` 指向同份考卷上一題所落的題目；偵測 `utils/followUp.js`、寫入 `services/followUpLinker.js`；組卷整組抽取 `utils/paperGroups.js`〔修訂 2026-09-15g〕；刪除／封存保護已實作〔修訂 2026-09-16〕）〔修訂 2026-09-15e〕 | 無新端點：runner 於 job_question 進終態後重算（非新節點）；POST /api/review/:jqId/approve 回應加 `follows_question_id`、reject 後重算；GET /api/review/:jqId 加 `follow_up` 區塊；回填 `npm run follow:backfill`；POST /api/generate-paper 以承上組為單位抽題，少出題時回應加 `shortfall`／`note`，`questions[]` 逐題加 `follows_question_id`（confirm-paper 同排序；助教 preview_paper 共用選題）〔修訂 2026-09-15g〕；〔修訂 2026-09-16〕DELETE /api/questions/:id 加 `?group=1`、GET /api/questions 加 `follows_question_id`／`has_follow_ups`、POST /api/questions/:id/variants 對承上題回 409 | 同 FR-001 | DEC-012 | Should | ACPT-019-1 |
| FR-020 | 拆題結果對照原卷文字層（決定性比對、不呼叫 LLM；extract 階段以 mupdf 抽該 chunk 文字層並定位每題片段，lint 之後的 source_check 節點比對負號與字母／數字；權威文件 `docs/source-check.md`）〔修訂 2026-09-15f〕 | 管線節點（`agents/source_check.js`；片段由 `workers/jobRunner.js` attachSourceText → `services/sourceTextService.js` 寫入 `payload.extract.source_text`）；複核沿用 GET /api/review?reason=transcription_mismatch 與 approve | 同 FR-001；另 `SOURCE_CHECK_MODE`（off／shadow／enforce，預設 enforce，非法值退回 enforce） | DEC-013（feat/source-check） | Must | ACPT-020-1 |
| FR-021 | 批改細節：錯因（`config/errorTypes.js` 十碼白名單，可複選 ≤5、只在答錯時非空、`chem_equation` 限化學題）、部分給分（0–1、兩位小數，限已批改）、學生答案與老師註記（各 ≤500 字）；可選鍵沒送不動、送 null 清空，錯改對與取消批改自動清錯因；整批仍單一交易全有全無（權威文件 `docs/grading-and-profile.md`；ADR-015）〔修訂 2026-09-24〕 | PATCH /api/papers/:id/results（`results[i]` 多 score／error_types／response／note）、GET /api/papers/:id（`questions[]` 多 subject／chapter／answer_text／solution_text／solution_src／score／error_types／response／teacher_note）、GET /api/error-types（新增） | FEATURE_STUDENTS | DEC-015（WS-A，缺口 G03） | Must | ACPT-021-1～4 |
| FR-022 | 錯因分布：弱點回應加 `by_error_type`（count、share＝÷時間窗內錯題數，四捨五入至小數第 4 位；只計 `result = 0`），`recent_wrong[]` 加 error_types、score；SQL 在 `services/weaknessService.js` 檔尾 `buildByErrorType`，凍結的五條 SQL 不動〔修訂 2026-09-24〕 | GET /api/students/:id/weakness（擴充） | FEATURE_STUDENTS | DEC-015（WS-A，G03） | Must | ACPT-022-1～2 |
| FR-023 | 學生檔案：年級（10／11／12）、類組、目標考試（陣列）、學校、教材版本、備註；白名單 `config/studentProfile.js`；PATCH 為部分更新（沒送不動），只送 name 的舊請求行為與訊息不變〔修訂 2026-09-24〕 | GET /api/students（每列多六欄）、POST /api/students、PATCH /api/students/:id、GET /api/student-profile-options（新增） | 無（核心區） | DEC-017（WS-A，G09） | Should | ACPT-023-1～2 |
| FR-024 | 文字詳解：`questions.solution_text`＋`solution_src`（verify／teacher／ai）；管線 save 於 `payload.verify.compare = 'agree'` 且 `steps_summary` 非空時寫入（`workers/jobRunner.js` buildSolutionFields）；老師可寫、改、清空（≤4000 字，與現值相同時保留原來源）；舊題以不呼叫 LLM 的腳本回填〔修訂 2026-09-24〕 | GET /api/questions（每題多兩欄）、GET /api/questions/:id（新增；封存題也查得到）、POST /api/questions、PUT /api/questions/:id（`solution_text` 可選）；`npm run solution:backfill -- [--dry-run] [--limit N]` | 無（核心區） | DEC-017（WS-A，G05） | Should | ACPT-024-1～3 |
| FR-025 | Word 版本：`edition` = `standard`（預設，行為不變）／`student`（不附答案）／`solution`（每題答案後接詳解，詳解公式轉原生 OMML）；其他值 400〔修訂 2026-09-24〕 | POST /api/download-word（body 多 `edition`） | 無 | DEC-017（WS-A，G05） | Should | ACPT-025-1 |
| FR-026 | 化學卷拆題入庫（卷別分流）：上傳指定 `subject_group`（`math_physics` 預設／`chemistry`）；化學走 `extract_chem`／`classify_chem`／`lint_chem`／`verify_chem`／`variant_chem` 模板與 `buildSchema(name, { group: 'chemistry' })`，source_check 先經 `ceToComparable`；數學／物理的 SYSTEM、模板、schema 逐字不變；化學 44 章併入白名單（唯一真相 `config/chemistryChapters.js`，AI 草擬待 Owner 定稿）（權威文件 `docs/chemistry.md`；ADR-010）〔修訂 2026-09-24〕 | POST /api/jobs（multipart 多 `subject_group`，冪等鍵改 `(pdf_sha256, subject_group)`）、GET /api/jobs/:id（多 `subject_group`）、GET /api/chapter-whitelist／chapter-volumes（多化學）；以白名單驗科目的端點全部接受「化學」；`npm run search:reindex`（分詞詞典改變後必跑）、`npm run eval:classify-chem`（不進 CI） | 同 FR-001 | DEC-019（WS-B，G01） | Must | ACPT-026-1～4 |
| FR-027 | 化學排版與答案比對：`\ce{…}` 子集→一般 LaTeX→OMML（`utils/chemFormula.js`），`\mathrm` 在 OMML 一律正體，可逆箭頭與條件箭頭；網頁 MathJax 載入 mhchem；答案比對在兩邊都有可辨識單位時才介入（因次不同 disagree、同因次換算後比，`utils/units.js`），化學式與反應式可比對（`utils/answerCompare.js`）〔修訂 2026-09-24〕 | 無新端點：POST /api/download-word 的輸出、管線 verify 節點的比對 | 無 | DEC-019（WS-B，G01；G07 的比對部分） | Must | ACPT-027-1～2 |
| FR-028 | 知識點：`knowledge_components`（code `MATH\|PHYS\|CHEM.<章名>.<兩位序號>`、draft／approved、口語版 `spoken_text`）與先備 `kc_prerequisites`；種子檔 `config/kc/<科目>.json`（三科 637 個，AI 草擬）以 `utils/kcSeed.js` 驗證後載入（整批一交易、已審定不覆寫、DB 全體環檢查）；分頁可瀏覽、就地編輯、審定、朗讀（權威文件 `docs/knowledge-components.md`；ADR-011）〔修訂 2026-09-24〕 | GET /api/kc、PATCH /api/kc/:id；`npm run kc:validate`、`npm run kc:load -- [--file <path>] [--dry-run] [--force]` | FEATURE_KC（限流 120/min） | DEC-015（WS-C＋KC 內容組，G02） | Must | ACPT-028-1～3 |
| FR-029 | 題目—知識點標註：人工（`src='human'` 取代該題全部標註，0–5 個、須同科）＋AI 自動（agent `kc_tag`，enum＝該章 codes，1–3 個；信心 ≥ `KC_TAG_MIN_CONFIDENCE` 才寫 `src='ai'`；已有人工標註不動；管線 save COMMIT 後 fire-and-forget，失敗不影響 job）；舊題回填〔修訂 2026-09-24〕 | GET /api/questions/:id/kcs（`?detail=1` 另附題目）、PUT /api/questions/:id/kcs；`npm run kc:backfill -- [--dry-run] [--limit N] [--subject X]` | FEATURE_KC（API）；FEATURE_KC_TAGGING（管線自動標註） | DEC-015（WS-C，G02） | Must | ACPT-029-1～3 |
| FR-030 | 知識點弱點：依 `question_kcs.weight` 加權、正確度 `COALESCE(score, result)`、Wilson 下界（z＝1.96）由低到高排序、`low_sample` 沿用 `WEAKNESS_MIN_N`、回報未標註的已批改題數（`services/kcWeaknessService.js`；權威文件 `docs/remedial.md`；ADR-014）〔修訂 2026-09-24〕 | GET /api/students/:id/weakness/kc | FEATURE_REMEDIAL | DEC-015、DEC-016（WS-D，G04） | Must | ACPT-030-1 |
| FR-031 | 依弱點出補救卷（只產草稿、不寫庫）：basis 在 kc／chapter 間自動選擇；補救／先備／延伸三桶以最大餘數法分配題數；候選池與組卷共用 `buildCandidatePoolQuery`＋`pickPaperUnits`（排除已作答、封存、別科、題源外；家族互斥；承上題整組）；確認沿用既有 confirm-paper（`services/remedialService.js`）〔修訂 2026-09-24〕 | POST /api/students/:id/remedial-paper、GET /api/students/:id/remedial-paper/items（手動加題前查整組）；確認走 POST /api/confirm-paper（不改） | FEATURE_REMEDIAL | DEC-016（WS-D，G04） | Must | ACPT-031-1～3 |
| FR-032 | 跨章配額組卷：`blueprint: [{ chapter, count, difficulty_min?, difficulty_max? }]`（1–10 列、count 總和 ≤50），與 chapter／count 互斥；逐列回報 `blueprint`／`shortfalls`，承上題湊不滿沿用 `FOLLOW_UP_SHORTFALL_POLICY`（`controllers/examController.js`）〔修訂 2026-09-24〕 | POST /api/generate-paper（擴充 `blueprint`） | 無（核心區，不吃旗標） | DEC-016（WS-D，G04） | Should | ACPT-032-1～2 |
| FR-033 | 題庫覆蓋率：白名單每章 × 難度 1–5 的未封存題數、指定學生時的「還沒寫過」題數、每個知識點掛了幾題（`services/coverageService.js`）〔修訂 2026-09-24〕 | GET /api/coverage | FEATURE_REMEDIAL | DEC-016、DEC-019（WS-D，G10） | Should | ACPT-033-1 |
| FR-034 | AI 家教：direct／socratic 兩模式；Gemini code execution 驗算（`services/llm.generateText`）；脈絡＝題目（題幹、答案、詳解）＋知識點口語版（approved 優先、draft 標註）＋代號化的學生弱點摘要；每日預算與限流；獨立於助教（`services/tutorService.js`；權威文件 `docs/tutor.md`；ADR-012）〔修訂 2026-09-24〕 | POST /api/tutor | FEATURE_TUTOR（限流 `TUTOR_RATE_LIMIT_PER_MIN`，預設 10） | DEC-018（WS-E，G06、G07） | Should | ACPT-034-1～4 |
| FR-035 | 按住說話：錄音（memoryStorage、≤5 MB、五種 mime）→ `MODEL_VOICE` 轉寫為繁中逐字稿（數學式 `$…$`）、`math_segments`、`ambiguities`；前端逐字稿可編輯、歧義以 chip 點選、老師按確認才送出（`services/voiceService.js`；ADR-013）〔修訂 2026-09-24〕 | POST /api/voice/transcribe | FEATURE_VOICE 且 FEATURE_TUTOR（限流 `VOICE_RATE_LIMIT_PER_MIN`，預設 10） | DEC-018（WS-E，G08） | Should | ACPT-035-1～2 |

註：POST /api/analyze-pdf（單段拆題舊路徑）保留於核心區，與 FR-001 並存；FEATURE_PIPELINE 開啟時前端上傳改走 POST /api/jobs。

註（階段 5）〔修訂 2026-09-24〕：

- FR-021～035 的編號由整合階段分配（契約第 8 條；裁決 S5-39），各條驗收的 Given/When/Then 見 [`prd.md`](./prd.md) §3.1，可觀察判準與驗證狀態見本文件 §6。
- DEC-014（產品定位轉為教學診斷平台）不單獨對應 FR：它由 FR-021～035 具體化，撤銷的兩條「不交付」條款落在 prd §4。
- **尚未分配 FR（TO-BE，本階段未實作）**：DEC-003 例外條款的錯題重練（缺口 G11）、DEC-016 的間隔複習回測（G13）、DEC-017 的訂正卷、學習路徑與學習報告（G14、G17），以及 DEC-019 的「三科章節表經 Owner 定稿」（屬 Owner 業務驗收，非程式功能）。實作時自 FR-036 起分配。

## 2. 非功能需求 (NFR)

量化指標與驗證方法以本表為準；架構層對應見 [`../03_architecture/sad.md`](../03_architecture/sad.md)。量測值出自 `exam_pro/eval/` 與 CI（全綠 @ f8f6574〔修訂 2026-08-29〕）。

| ID | 類別 | 可驗證化描述 | 量測值／門檻 | 驗證方式 |
| :--- | :--- | :--- | :--- | :--- |
| NFR-001 | 安全 | 所有 /api 路由經 x-api-key 驗證（timing-safe 比對）；CORS 僅允許 ALLOWED_ORIGINS 白名單；圖片抓取經 isSafeImageUrl 防 SSRF；NODE_ENV=production 時不回傳錯誤細節；階段 5：AI 家教回覆的 Markdown 先整段 escape 再轉換受限標記、伺服器文字一律 textContent（`public/js/tutor.js`），錄音不落地見 NFR-008〔修訂 2026-09-24〕 | 未帶或錯誤金鑰一律 401；非白名單來源被拒；私有網段 URL 被拒；受限 Markdown 的 XSS 案例（`<img onerror>`、`javascript:` 連結、偽造佔位符）不產生可執行內容〔修訂 2026-09-24〕 | 單元＋整合測試（CI）；`test/unit/tutorUi.test.js`〔修訂 2026-09-24〕 |
| NFR-002 | 成本 | 高成本端點限流（獨立計數桶）：/analyze-pdf、POST /api/jobs、variants、assistant 各 10/min，search-nl 30/min，similar 60/min；階段 5：POST /api/tutor、POST /api/voice/transcribe 各 10/min（`TUTOR_RATE_LIMIT_PER_MIN`／`VOICE_RATE_LIMIT_PER_MIN` 可調）、知識點四支 API 120/min（不呼叫 LLM，僅防呆）〔修訂 2026-09-24〕；上傳上限 15 MB（逾限回 413）；逐 token 計費紀錄（config/pricing.js）；單 job 與每日成本上限（`workers/jobRunner.js`：`JOB_COST_BUDGET_USD` 預設 0.5、`DAILY_COST_BUDGET_USD` 預設 5）；階段 5 新 LLM 呼叫點的成本上限見 NFR-007〔修訂 2026-09-24〕 | 第 11 次請求於 60 秒窗內被拒（429）；15 MB 逾限回 413 | 整合測試（CI） |
| NFR-003 | 可測試性 | agent 為純函式合約（不碰 DB、不讀 env、ctx 注入）；LLM 呼叫走 cassette record/replay；CI 零金鑰、零網路、零成本；階段 5 的新 LLM 呼叫點（`kc_tag`、`tutor.*`、語音）單元測試一律注入假 LLM，CI 不需要任何新 cassette〔修訂 2026-09-24〕 | 整合分支 stage5/integration 當下：unit 2253、integration 471、e2e 11，另有整合補測進行中（主控合併後更新數字）〔修訂 2026-09-24〕；CI 無 GEMINI_API_KEY | node:test＋cassette 重播（CI） |
| NFR-004 | 品質門檻 | 五個 eval suite 採 golden＋ratchet（首測 −0.03、只升不降）；低於門檻 CI 轉紅；replay miss 於 main 視為錯誤 | pipeline saved_rate 0.90（門檻 ≥0.87）、gate_pass_rate 1.00；classify accuracy 0.9000／macro-F1 0.9256；檢索 Recall@5 hybrid(RRF) 1.000（LIKE 基線 0.875）；NLQ 規則路徑 coverage 0.84；variant retrieved_coverage 0.8667、偏題閘門 ≥0.90（0.92→0.90，裁決 S3-R29） | eval suite（CI 門檻檢查） |
| NFR-005 | 可靠性 | job 認領採 FOR UPDATE SKIP LOCKED＋租約，worker 中斷後租約到期由他機續跑（斷點續跑）；各節點逾時、退避重試、重試預算，預算用盡轉 needs_review | 節點逾時 120 秒（`JOB_NODE_TIMEOUT_MS`）；租約 180 秒（`JOB_LEASE_MS`）；fail 重試預算 classify 2／lint 2／verify 1／extract 整包 1；error 獨立計數上限 3，退避 1s→2s→4s 封頂 60s（詳 [lld §4.1](../04_design/lld.md)） | 整合測試（jobRunner；CI） |
| NFR-006 | 資料一致性 | confirm-paper 之組卷與作答歷史（attempts）寫入同一交易；migrations 只增不改；階段 5：批改細節 PATCH 整批單一交易、知識點載入與人工標註各為單一交易〔修訂 2026-09-24〕 | migrations 0001_init–0012_knowledge_components，共 12 份，無修改既有檔（0010–0012 為階段 5 base 預建，各 WS 未再新增 0013–0017）〔修訂 2026-09-24〕 | 整合測試＋migration 檔案稽核 |
| NFR-007 | 成本（階段 5 新 LLM 呼叫點）〔修訂 2026-09-24〕 | AI 家教＋語音共用每日上限 `TUTOR_DAILY_BUDGET_USD`（預設 1.0 美元；依 `config/pricing.js` 估算，程序內按本地日期累計，伺服器重啟歸零；查不到價目的模型以表上最貴單價估；0＝不准花錢）；知識點自動標註在管線當日成本達 `DAILY_COST_BUDGET_USD` 或該 job 預算用盡時不呼叫 LLM（標註費用本身不記入 `job_events`）；`kc:backfill` 執行前印出題數與預估費用；thinking 模型的 `thinkingBudget` 與 `maxOutputTokens` 成對設定（家教 2048／8192、語音 1024／4096、`kc_tag` 512／4096） | 當日累計達上限後，家教與語音回 429 至隔日；預算於呼叫前檢查，最後一次可能略超過上限（已知）；價目為估算，語音的音訊輸入單價尚未分開計價（可能低估） | 單元（`tutorService.test.js`、`voiceService.test.js`、`kcRunnerHook.test.js`）＋整合（`tutor.pg.test.js` 預算 429、`kcTagging.pg.test.js` 當日預算觸頂不標） |
| NFR-008 | 隱私（錄音與學生資料）〔修訂 2026-09-24〕 | 錄音以 `multer.memoryStorage()` 接收、只在該次請求記憶體內處理，不寫入 `uploads/` 或任何磁碟，≤5 MB、mime 限 webm／ogg／mp4／mpeg／wav；cassette 只存音訊的 `{kind, mimeType, bytes, sha256}`；家教 prompt 組好後整段以 `utils/pseudonym.js` 代號化，學生姓名不出現在 system、parts 與 cacheKeyParts（DEC-009 延伸） | 錄音上傳後 `uploads/` 無新檔；超過 5 MB 回 413；姓名斷言不出現在送出的請求內。已知限制：錄音本身原樣送 Gemini 轉寫，姓名遮罩只作用在文字（操作說明提醒勿在錄音講學生全名） | 整合（`tutor.pg.test.js`「錄音不寫進 uploads/」、DB 組出的 prompt 無姓名）＋單元（`tutorService.test.js`、`voiceService.test.js`） |
| NFR-009 | 相容性（既有錄放帶不失效）〔修訂 2026-09-24〕 | 數學／物理既有 agent（extract、classify、lint、verify、source_check、generateVariant、nlq、assistant）的 SYSTEM、PROMPT_TEMPLATE、schema 逐字不變；`buildSchema(name)` 行為與 schemaHash 不變；新 LLM 呼叫點的模板註冊字串＝SYSTEM＋`'\n---\n'`＋PROMPT_TEMPLATE（SYSTEM 一改鍵就變） | 不重錄任何 cassette，五個 eval suite 全綠且量測值與 `stage5/base` 相同（WS-B 回報）；化學以卷別分流另立模板（ADR-010） | 單元（`chemistryAgents.test.js` 逐 agent 斷言數學／物理請求不變、`agentExtract.test.js` 釘 66 章）＋CI 五個 eval（replay） |

## 3. 資料需求 (Data Requirements)

| 資料實體 | 來源系統 | 保留政策 | 敏感等級 |
| :--- | :--- | :--- | :--- |
| questions（含 768 維 embedding、text_hash 唯一鍵、source_type 五值 CHECK——0006，NOT NULL DEFAULT 'unknown'；jobs.source_type 可 NULL〔修訂 2026-08-29〕；承上題自我參照 follows_question_id＋follows_src——0008，FK NO ACTION〔修訂 2026-09-15e〕） | 本系統（拆題管線／手動建立） | 本地 PG 長期保留；repo 不含題庫內容（DEC-009） | 私有資產（題庫） |
| data/figures/（附圖 PNG，檔名 `<jobId>-<idx>.png`；questions.question_img 存相對路徑 `/figures/<jobId>-<idx>.png`）〔修訂 2026-08-29〕 | 本系統（管線裁圖，`services/figureService.js`） | 本地檔案系統保留；GET /figures 靜態供圖 | 中（原始考卷衍生圖） |
| students／papers／attempts | 本系統 | 本地 PG 長期保留 | 含個資（學生姓名） |
| jobs／job_questions／job_events | 本系統（管線） | 本地 PG 保留（含逐步成本紀錄）；`payload.extract.source_text` 只存每題定位到的原卷片段（≤1500 字），PDF 原檔拆完即刪〔修訂 2026-09-15f〕 | 低（含上傳檔衍生內容；原卷片段屬考卷衍生文字，隨題庫留本地） |
| uploads/（PDF 暫存） | 使用者上傳 | 暫存目錄 | 中（原始考卷） |
| attempts 批改細節（score、error_types、response、teacher_note——0010）〔修訂 2026-09-24〕 | 本系統（批改，FR-021） | 本地 PG 長期保留 | 個資（學習紀錄；學生答案與老師註記屬學習歷程） |
| students 檔案欄位（grade、track、target_exams、school、textbook_version——0010；note 為 0001 既有欄）〔修訂 2026-09-24〕 | 本系統（學生管理，FR-023） | 本地 PG 長期保留；全部可為 NULL，既有學生不必回填 | 個資（學校、年級） |
| questions.solution_text／solution_src（0011）；questions.subject 加「化學」；jobs.subject_group（0011）〔修訂 2026-09-24〕 | 本系統（管線 verify 摘要、老師撰寫、回填腳本；上傳時指定卷別） | 本地 PG 長期保留 | 私有資產（題庫）；verify 摘要為模型產生、未經人工審閱 |
| knowledge_components／question_kcs／kc_prerequisites（0012）與種子檔 `exam_pro/config/kc/<科目>.json`〔修訂 2026-09-24〕 | 種子檔由 AI 依 108 課綱草擬（進版控，非題庫內容）；標註由 AI 或老師寫入 | 本地 PG 長期保留；已審定內容受載入腳本保護 | 一般（教學內容，非題目） |
| 語音錄音〔修訂 2026-09-24〕 | 老師按住說話 | **不落地**：只在單次請求記憶體內，轉寫後即丟棄（NFR-008） | 中（可能含人聲與學生姓名） |

## 4. 外部介面 (External Interfaces)

| 介面 | 方向 | 協議 | 契約文件 |
| :--- | :--- | :--- | :--- |
| Google Gemini（gemini-3.5-flash 拆題／分類／變式、gemini-3.1-pro-preview 驗答、gemini-embedding-001 768 維；模型 ID 單一真相 `exam_pro/config/models.js`）；階段 5 另有 `MODEL_TUTOR`（預設沿用 MODEL_VERIFY，開 code execution 工具）、`MODEL_VOICE`（預設沿用 MODEL_EXTRACT，音訊 inline part）、`MODEL_KC_TAG`（預設沿用 MODEL_EXTRACT）〔修訂 2026-09-24〕 | 出 | REST（HTTPS） | [`../04_design/api_spec.md`](../04_design/api_spec.md)；`generateText` 合約見 `docs/interfaces-stage5.md` 第 5.1 條〔修訂 2026-09-24〕 |
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

### 5.2 批改→診斷→補救卷（階段 5；FR-021、FR-030、FR-031）〔修訂 2026-09-24〕

| 項目 | 內容 |
| :--- | :--- |
| **Actor** | 家教老師（單人使用） |
| **Preconditions** | 該生已有確認出卷的試卷（5.1）；FEATURE_STUDENTS、FEATURE_REMEDIAL 開啟；知識點已載入並標註（可無，無則退回章節） |
| **Main Flow** | 1. 批改：PATCH /api/papers/:id/results 送對錯、錯因、部分給分（FR-021） 2. 看診斷：GET /api/students/:id/weakness（錯因分布，FR-022）與 /weakness/kc（知識點掌握度下界，FR-030） 3. POST /api/students/:id/remedial-paper 取得補救卷草稿（不寫庫，FR-031） 4. 草稿內刪題／加題（加題前 GET …/remedial-paper/items 取整組） 5. POST /api/confirm-paper 確認（同交易建卷＋attempts） 6. POST /api/download-word（可選 `edition`，FR-025） |
| **Alternative Flow** | A1. 有標註的已批改題 < `WEAKNESS_MIN_N`：basis 退回 chapter 並在 `notes` 說明；A2. 完全沒有批改：200 空草稿＋`notes`；A3. 題庫不足：`shortfalls` 逐目標回報，不自動拿別的單位補，老師以題目 ID 加題或至覆蓋率（FR-033）補題 |
| **Postconditions** | 同 5.1：補救卷題目進 attempts，之後新題組卷不再出同題（DEC-003 原條文；錯題重練例外條款尚未實作） |
| **引用規則** | DEC-015、DEC-016；ADR-014、ADR-015 |

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
| ACPT-019-* | FR-019 | TC-019-1～TC-019-4：單元（isFollowUp／findPredecessorRow／resolveQuestionId）＋整合（followUp.pg.test.js：runner 綁定、複核重算、保護與補強、回填腳本；schema.test.js 0008 斷言）〔修訂 2026-09-15e〕；TC-019-6～7：整組刪除／封存、變式藍本 409、列表承上欄位、承上題不得當變式藍本〔修訂 2026-09-16〕；TC-019-8：組卷整組抽取（paperGroups.test.js＋paperGroups.pg.test.js）〔修訂 2026-09-15g〕 | ACPT-019-1～4 已驗證（本分支實跑單元 1,507／整合 290／e2e 11；複核畫面前端顯示待 PR3）〔修訂 2026-09-15f〕；ACPT-019-5、019-7 已驗證（TC-019-8，feat/follow-up-paper-group 實跑單元 1,583／整合 305／e2e 11）〔修訂 2026-09-15g〕；ACPT-019-6 已驗證（feat/follow-up-protect-badge：DELETE `?group=1` 整組處理、封存前題 409、題庫列表徽章）〔修訂 2026-09-16〕 |
| ACPT-020-* | FR-020 | TC-020-1～3：單元（正規化／定位／比對／agent 合約、公開樣卷 0 誤報）＋整合（transcription_mismatch 進複核、approve 事件、0009 CHECK）＋e2e（樣卷 source_text 落地、無誤判）＋eval pipeline〔修訂 2026-09-15f〕 | 已驗證（feat/source-check 本機全綠）；真實原卷校準見 `docs/source-check.md` 第 4 節 |

### 6.1 階段 5（ACPT-021-*～035-*）〔修訂 2026-09-24〕

Given/When/Then 全文以 [`prd.md`](./prd.md) §3.1 為準；下表「可觀察判準」寫的是可由 API 回應、資料庫或輸出檔直接檢查的條件。狀態欄的「CI 已驗證」指整合分支 `stage5/integration`（@ `6f8e671`）完整 `ci.sh`（unit、check:html、migrate、integration、e2e、五個 eval replay）全綠，由主控實跑；前端各頁只以 miniDom 渲染測試驗證，**真瀏覽器、真 Gemini 與 Microsoft Word 實機皆未驗證**。

| ACPT ID | 對應 FR | 可觀察判準 | 驗證案例 | 狀態 |
| :--- | :--- | :--- | :--- | :--- |
| ACPT-021-1～4 | FR-021 | PATCH 的 `error_types` 含白名單外代碼、重複、超過 5 個、`result ≠ 0` 卻非空、非化學題帶 `chem_equation` → 400 且整批 ROLLBACK；只送 `result: 1` 把錯改對 → DB `error_types = '{}'`；`result: null` → `graded_at`、`score`、`error_types` 清空，`response`、`teacher_note` 保留；`score` 超出 0–1 或三位小數 → 400；GET /api/papers/:id 每題帶 `answer_text`、`solution_text`、`solution_src` 與批改細節；既有六個 400 訊息與檢查順序不變 | TC-021-1～3 | CI 已驗證；批改卡未經瀏覽器實測 |
| ACPT-022-1～2 | FR-022 | `by_error_type` 的 `share` 分母＝時間窗與科目內 `result = 0` 的作答數（含未標錯因者），分母 0 時 null；排序 count DESC、error_type ASC；只計 `result = 0`；`recent_wrong[]` 每列多 `error_types`、`score`，既有五個頂層鍵與欄位順序不變 | TC-022-1 | CI 已驗證 |
| ACPT-023-1～2 | FR-023 | POST／PATCH /api/students 接受六欄任意子集，白名單外值 400（訊息見 `docs/grading-and-profile.md` §3.5）；PATCH 空 body 400；只送 `name` 的請求與回應行為不變（回應多六欄、只增不減）；GET /api/student-profile-options 回選項 | TC-023-1 | CI 已驗證 |
| ACPT-024-1～3 | FR-024 | 管線 save：`compare = 'agree'` 且摘要非空 → `solution_src = 'verify'`，否則兩欄 NULL；PUT 沒帶 `solution_text` 不動、與現值 trim 後相同保留原來源、空白清成兩欄 NULL；`solution:backfill -- --dry-run` 印出補題數與略過原因且不寫入（交易內 ROLLBACK），重跑不覆寫既有詳解、略過入庫後題幹或答案被改過的題（`edited`） | TC-024-1 | CI 已驗證；回填未對 Owner 的正式庫執行 |
| ACPT-025-1 | FR-025 | `edition` 缺省＝`standard`，document.xml 段落序列與改版前逐位元相同；`student` 無答案區；`solution` 每題答案後接詳解且公式為 `<m:oMath>`，無詳解者印「（本題尚無文字詳解）」；其他值 400 | TC-025-1 | CI 已驗證；Word 實機未開 |
| ACPT-026-1～4 | FR-026 | `subject_group` 非兩值 → 400 不建 job；化學卷以真的 agents（replay）走完入庫、`questions.subject = '化學'`、章節在 44 章內；數學／物理的 agent 名、模板、SYSTEM、schema 實例與 prompt 與 base 相同；同 PDF 同卷別重傳回既有 job、換卷別建新 job；`search:reindex` 重算後新詞查得到舊題；`eval:classify-chem` 無 cassette 時印「尚未錄製，略過」並 exit 0 | TC-026-1～5 | CI 已驗證（ACPT-026-1～3）；ACPT-026-4 的化學分類分數**尚未錄製**，章節表待 Owner 定稿 |
| ACPT-027-1～2 | FR-027 | `\ce` 各記法打包成 .docx 後 OMML 結構正確（`m:sSub`、`m:sSubSup`、`m:groupChr`、`m:sPre`，`\mathrm` 帶 `m:sty p`）；`answer_chem.json` 90 案例、既有 `answer.json` 250 案例結果全部符合期望；`5 cm` 對 `5 m` 在 number／expression 為 disagree、text 為 uncertain（裁決 S5-11） | TC-027-1～2 | CI 已驗證；Word 實機未開 |
| ACPT-028-1～3 | FR-028 | `validate_kc_seed`（不帶參數）三科 637 個、110 章全數通過、0 error（2026-09-24 文件整合時實跑）；`kc:load -- --dry-run` 數字與實際載入相同；已審定列不被覆寫（`--force` 除外）；PATCH 口語版 <40 字、>300 字或含 LaTeX → 400；GET /api/kc 的 `question_count` 只數未封存題；FEATURE_KC 關閉 → 404 | TC-028-1～3 | CI 已驗證；口語版內容（633 條 draft）待 Owner 審定 |
| ACPT-029-1～3 | FR-029 | PUT 別科知識點或超過 5 個 → 400 且原標註不動；PUT 後該題全部列 `src = 'human'`；`tagQuestion` 遇 human 標註回 `skipped`／`has_human` 且不呼叫 LLM；信心低於門檻回 `low_confidence` 不寫；管線掛鉤丟錯時 job 狀態不受影響；當日 `job_events` 花費達上限時掛鉤不呼叫 LLM；`kc:backfill -- --dry-run` 先印題數與預估費用 | TC-029-1～3 | CI 已驗證；`kc_tag` 從未對真 Gemini 執行、標註準確率未量測 |
| ACPT-030-1 | FR-030 | `rows[]` 依 `mastery_lb` 升冪（null 最後）；`graded` 為加權和、`correct` 用 `COALESCE(score, result)`；`graded = 0` 時 `correct_rate`、`mastery_lb` 為 null；`untagged_graded` 為未標註的已批改題數 | TC-030-1 | CI 已驗證 |
| ACPT-031-1～3 | FR-031 | 產生草稿不寫任何表（整合測試斷言）；`basis` 依門檻切換並在 `notes` 說明；三桶題數和＝`total`（最大餘數法）；候選不含已作答、封存、別科、題源外；同家族至多一題；承上組完整且 `items[].group_ids` 列出同組成員；items 查詢端點回報 `archived`／`answered`／`missing`；確認走 confirm-paper 寫 attempts | TC-031-1～3 | CI 已驗證；補救卷畫面未經瀏覽器實測 |
| ACPT-032-1～2 | FR-032 | `blueprint` 與 `chapter`／`count` 同送 → 400；部分列不足 → 200 附 `blueprint`、`shortfalls`、`note`；全部列抽不到 → 400 並附兩鍵；`FOLLOW_UP_SHORTFALL_POLICY = 'error'` 時承上組不足的列 → 400；不帶 `blueprint` 時單章路徑回應逐字不變（既有 controllers／paperGroups 整合與 e2e） | TC-032-1 | CI 已驗證 |
| ACPT-033-1 | FR-033 | `rows[]` 涵蓋白名單每一章（0 題也列）、`by_difficulty` 五鍵；未給 `student_id` 時 `unseen_by_student` 為 null；`kc_rows` 含 0 題的知識點；學生不存在 404 | TC-033-1 | CI 已驗證 |
| ACPT-034-1～4 | FR-034 | 兩模式註冊不同模板（`tutor.direct.v1`／`tutor.socratic.v1`）；回應恰為五鍵 `reply, mode, verification, context, usage`；`verification.runs` 來自 SDK 的 executableCode／codeExecutionResult；姓名不出現在 system／parts／cacheKeyParts；預算用完 429；`finishReason = MAX_TOKENS` 時 reply 附截斷提醒；旗標關閉 404 | TC-034-1～4 | CI 已驗證（replay 與假 LLM）；**從未呼叫真 Gemini**：socratic 是否洩答、是否真的驗算、驗算覆蓋率皆未量測 |
| ACPT-035-1～2 | FR-035 | 無檔、欄位名錯、mime 不在白名單、multipart 壞掉 → 400；>5 MB → 413；`uploads/` 無新檔；回應 `text`／`math_segments`／`ambiguities` 經 ajv 再驗；前端流程（錄音→逐字稿→點 chip→按確認才送出、取消不送、失敗保留逐字稿）以 miniDom＋假 MediaRecorder 驗證；FEATURE_VOICE 需同時開 FEATURE_TUTOR | TC-035-1～2 | CI 已驗證；Gemini 是否接受瀏覽器錄的 audio/webm **未實機驗證** |

## 7. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | DEC-001–DEC-012（[`requirements_tracker.md`](./requirements_tracker.md)）、[`prd.md`](./prd.md) 之 FR 初稿〔修訂 2026-09-15e〕；DEC-013〔修訂 2026-09-15f〕；DEC-014–DEC-019 與階段 5 契約 [`docs/interfaces-stage5.md`](../../docs/interfaces-stage5.md)〔修訂 2026-09-24〕 |
| 本文件產出 | FR-001–FR-020〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕、FR-021–FR-035〔修訂 2026-09-24〕、NFR-001–NFR-009〔修訂 2026-09-24〕、使用案例（§5.1，對應 UAT SCN-009／SCN-010；§5.2 批改→診斷→補救卷〔修訂 2026-09-24〕）、ACPT 對照（§6）〔修訂 2026-08-29〕 |
| 下游 | [`../03_architecture/sad.md`](../03_architecture/sad.md) §4 需求摘要、[`../03_architecture/engineering_tracker.md`](../03_architecture/engineering_tracker.md)、[`../05_qa/test_plan.md`](../05_qa/test_plan.md)、[`../05_qa/qa_tracker.md`](../05_qa/qa_tracker.md) |
