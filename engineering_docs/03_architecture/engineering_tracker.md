# 工程追蹤簿 (Engineering Tracker) - 家教專用數理題庫系統

> **版本:** v1.3 | **更新:** 2026-09-15 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（本檔為發布快照；`engineering_tracker.xlsx` 由本檔轉出，人工維護欄位以本檔為準）
> **定位:** 本文件回答「每條 FR/NFR 落在哪個模組、對應哪個 ADR、以何種方式驗證」；需求決策與 Gate 見 [requirements_tracker](../01_requirements/requirements_tracker.md)，測試執行證據見 [qa_tracker](../05_qa/qa_tracker.md)。
> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：CI 證據 commit 更新（0ff47b4→f8f6574）、測試數更新（單元 1,415→1,445）、migrations 範圍更新（0001–0006）、FR-009 摘要補矩陣 OMML、新增 FR-017（source_type）與 FR-018（附圖裁切）兩列、§4 追溯範圍更新、**新增 §5 相依與平行開發（活的相依層）**。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15 修訂**（測試數同步）：NFR-003 單元測試數 1,445→1,449（main 126243a 實測，2026-09-15）。修改處以〔修訂 2026-09-15〕行內標記。
> 🛠 **2026-09-15b 修訂**（feat/pseudonymize-student-names 程式碼同步）：FR-016 補姓名代號化模組路徑。修改處以〔修訂 2026-09-15b〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數同步）：NFR-003 單元測試數 1,449→1,476（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15e 修訂**（feat/follow-up-links）：新增 FR-019 承上題綁定一列（首個 PR：綁定、複核重算、回填；整組抽題與刪除保護待後續 PR）；NFR-003 單元測試數 1,476→1,499（本分支實測）；NFR-006 migrations 範圍 0001–0008；§4 追溯與 §5.1 熱點表同步。修改處以〔修訂 2026-09-15e〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 審查修正）：NFR-003 單元 1,499→1,507；FR-019 列補 questionController 與實跑證據。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/source-check）：新增 FR-020 列（原卷文字層比對）與 ADR-009 索引；FR-006 複核原因八種→九種；NFR-003 單元測試數 1,476→1,534（feat/source-check 實測）；NFR-006 migrations 範圍補 0007、0009；§4 追溯與 §5.1 熱點同步。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：NFR-003 單元測試數更新為 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）（合併後實跑）；NFR-006 migrations 範圍合為 0001–0009；§4 追溯與 §5.1 熱點表合併兩分支新增。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-15g 修訂**（feat/follow-up-paper-group，FR-019 PR2）：FR-019 列狀態補 PR2 組卷整組抽取、模組路徑補 utils/paperGroups.js 等、驗證補 paperGroups 單元與整合測試。NFR-003 全域測試數由主線合併時統一更新，本分支不動。修改處以〔修訂 2026-09-15g〕行內標記。
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：FR-019 列狀態補 PR3 已實作範圍。修改處以〔修訂 2026-09-16〕行內標記。

## 目錄

- [1. 功能需求 FR](#1-功能需求-fr)
- [2. 非功能需求 NFR](#2-非功能需求-nfr)
- [3. ADR 索引](#3-adr-索引)
- [4. 追溯](#4-追溯)
- [5. 相依與平行開發](#5-相依與平行開發)〔修訂 2026-08-29〕

## 1. 功能需求 FR

全部狀態為「已實作」（四階段完成，CI 全綠 @ f8f6574〔修訂 2026-08-29〕）。模組路徑為 repo 相對路徑。

| ID | 摘要 | 狀態 | 模組路徑 | 對應 ADR | 驗證方式 |
|---|---|---|---|---|---|
| FR-001 | 考卷 PDF 上傳與非同步拆題 job（狀態機 queued→extracting→processing→done/failed） | 已實作 | exam_pro/workers/jobRunner.js、exam_pro/pipeline/stateMachine.js、exam_pro/agents/extract.js | ADR-003、ADR-006 | 單元＋整合＋e2e（上傳→部分入庫）＋eval pipeline |
| FR-002 | 章節分類（白名單→kNN 投票短路→LLM） | 已實作 | exam_pro/agents/classify.js、exam_pro/config/chapters.js、exam_pro/config/chapterExamples.js | ADR-005、ADR-002 | 單元＋eval classify（accuracy 0.9000） |
| FR-003 | 公式修復 lint（LaTeX 白名單語法收斂） | 已實作 | exam_pro/agents/lint.js、exam_pro/utils/formulaLint.js、exam_pro/utils/formulaFix.js | ADR-005 | 單元 |
| FR-004 | 獨立解題驗證（pro 與 flash 互相制衡、答案比對） | 已實作 | exam_pro/agents/verify.js、exam_pro/utils/answerCompare.js | ADR-003 | 單元＋eval pipeline（answer_agree_rate 0.90） |
| FR-005 | 兩段去重（正規化雜湊→向量餘弦） | 已實作 | exam_pro/agents/dedup.js、exam_pro/utils/normalizeStem.js | ADR-003、ADR-001 | 單元＋整合 |
| FR-006 | 部分入庫與人工複核佇列（needs_review 九種原因〔修訂 2026-09-15f〕） | 已實作 | exam_pro/controllers/reviewController.js、exam_pro/public/js/review.js | ADR-005、ADR-003 | 整合＋e2e |
| FR-007 | 題庫管理（CRUD、分頁、batch-save 白名單硬驗證） | 已實作 | exam_pro/controllers/questionController.js、exam_pro/utils/questionValidation.js | ADR-005 | 單元＋整合 |
| FR-008 | 組卷（草稿→確認；NOT EXISTS attempts 排除；家族互斥） | 已實作 | exam_pro/controllers/examController.js、exam_pro/utils/pickOnePerFamily.js、exam_pro/utils/shuffle.js | ADR-001 | 單元＋整合＋e2e（組卷→Word 公式） |
| FR-009 | Word 匯出（自製 LaTeX→OOXML，docx 原生 Math 物件；含原生 OMML 二維矩陣，10 種矩陣環境〔修訂 2026-08-29〕） | 已實作 | exam_pro/utils/textFormatter.js、exam_pro/services/wordService.js | ADR-004 | 單元＋e2e |
| FR-010 | 相似題檢索（hybrid RRF） | 已實作 | exam_pro/services/retrievalService.js、exam_pro/queries/hybrid.js | ADR-001、ADR-002、ADR-008 | eval retrieval（Recall@5 1.000） |
| FR-011 | 變式題（檢索優先 ≥0.80，池不足才生成，偏題閘門 ≥0.90） | 已實作 | exam_pro/services/variantService.js、exam_pro/agents/generateVariant.js、exam_pro/utils/variantTextGate.js | ADR-002、ADR-005、ADR-006 | eval variant（retrieved_coverage 0.8667） |
| FR-012 | 自然語言查題（規則主、LLM 輔、四級回退） | 已實作 | exam_pro/services/nlqService.js、exam_pro/utils/nlqHeuristics.js、exam_pro/config/chapterAliases.js | ADR-002、ADR-008 | eval nlq（規則 coverage 0.84） |
| FR-013 | 學生弱點面板（五條純函式 SQL） | 已實作 | exam_pro/services/weaknessService.js | ADR-001 | 單元＋整合 |
| FR-014 | 學生管理（建立／改名／合併／刪除） | 已實作 | exam_pro/controllers/studentAdminController.js | — | 整合 |
| FR-015 | 批改（GET /api/papers/:id、PATCH results） | 已實作 | exam_pro/controllers/paperController.js | — | 整合 |
| FR-016 | 對話式助教（主控 LLM ReAct 迴圈＋五個只讀工具、出卷僅 dry-run；學生姓名以代號出境〔修訂 2026-09-15b〕） | 已實作 | exam_pro/services/assistantService.js、exam_pro/utils/pseudonym.js、exam_pro/public/js/assistant.js | ADR-007 | 單元＋整合（replay） |
| FR-017 | 題目來源標記 source_type（著作權管理：五值白名單、組卷題源過濾、上傳／複核／改標全鏈帶標） | 已實作〔修訂 2026-08-29 補登錄，PR #7〕 | exam_pro/migrations/0006_source_type.sql、exam_pro/config/chapters.js（SOURCE_TYPES）、exam_pro/controllers/questionController.js、exam_pro/controllers/examController.js、exam_pro/controllers/jobController.js、exam_pro/controllers/reviewController.js、exam_pro/public/index.html | ADR-005 | 單元（chapterVolumes 釘住 CHECK）＋整合（controllers.pg.test.js source_type 端到端） |
| FR-018 | 附圖裁切入庫（extract 回 bbox＋mupdf/sharp 裁圖存 question_img；權威文件 docs/figures.md） | 已實作〔修訂 2026-08-29 補登錄，PR #3；cassette 重錄 @ 4af4647〕 | exam_pro/services/figureService.js、exam_pro/agents/extract.js（figure_page/figure_box＋框幾何驗證）、exam_pro/workers/jobRunner.js（attachFigureImages）、exam_pro/app.js（/figures 靜態掛載）、exam_pro/services/wordService.js（Word 匯出嵌入本機附圖〔修訂 2026-09-16〕） | ADR-003、ADR-006 | 單元（figureService、agentExtract、wordFigures〔修訂 2026-09-16〕）＋eval pipeline（cassette 重錄後全綠）＋e2e（組卷→Word 含附圖題〔修訂 2026-09-16〕） |
| FR-019 | 承上題綁定（伺服器端 regex 偵測、`questions.follows_question_id` 邊模型；runner 終態後與人工複核後重算、舊題回填）〔修訂 2026-09-15e〕 | 部分實作（PR1：綁定＋複核重算＋回填；PR2：組卷整組抽取與相鄰排列〔修訂 2026-09-15g〕；PR3：刪除／封存保護、`?group=1` 整組處理、承上題不當變式藍本、題庫列表徽章〔修訂 2026-09-16〕） | exam_pro/migrations/0008_follow_up.sql、exam_pro/utils/followUp.js、exam_pro/services/followUpLinker.js、exam_pro/workers/jobRunner.js（終態後 linkFollowUps）、exam_pro/controllers/reviewController.js、exam_pro/controllers/questionController.js（刪除前題 409、`?group=1` 整組處理〔修訂 2026-09-16〕）〔修訂 2026-09-15f〕、exam_pro/scripts/backfill_follow_ups.js、exam_pro/utils/paperGroups.js、exam_pro/controllers/examController.js（selectPaperQuestions／confirmPaper 排序、FOLLOW_UP_SHORTFALL_POLICY）、exam_pro/services/assistantService.js（preview_paper）、exam_pro/public/index.html（組卷預覽附註與承上標示、列表徽章〔修訂 2026-09-16〕）〔修訂 2026-09-15g〕、exam_pro/services/variantService.js（承上題不得當藍本 409）〔修訂 2026-09-16〕 | ADR-003 | 單元（followUp.test.js、paperGroups.test.js〔修訂 2026-09-15g〕、variantService.test.js〔修訂 2026-09-16〕）＋整合（followUp.pg.test.js、schema.test.js、paperGroups.pg.test.js〔修訂 2026-09-15g〕、variants.pg.test.js〔修訂 2026-09-16〕）＋e2e＋eval pipeline（PR2 分支實跑單元 1,583／整合 305／e2e 11 全綠〔修訂 2026-09-15g〕；PR3 併入 main 後 CI 實跑單元 1,594／整合 309／e2e 11 全綠〔修訂 2026-09-16〕） |
| FR-020 | 拆題結果對照原卷文字層（extract 階段抽片段、source_check 決定性比對、預設 enforce；權威文件 docs/source-check.md） | 已實作〔修訂 2026-09-15f，feat/source-check〕 | exam_pro/utils/sourceCheck.js、exam_pro/services/sourceTextService.js、exam_pro/services/mupdf.js、exam_pro/agents/source_check.js、exam_pro/workers/jobRunner.js（attachSourceText、loadSourceCheckConfig）、exam_pro/pipeline/stateMachine.js、exam_pro/controllers/reviewController.js（approve 記 source_recheck）、exam_pro/migrations/0009_source_check.sql、exam_pro/public/js/review.js、exam_pro/eval/tools/calibrate_source_check.js | ADR-009、ADR-003 | 單元（sourceCheck、sourceCheckSample：公開樣卷 0 誤報）＋整合（jobs.pg.test.js source_check 區塊）＋e2e＋eval pipeline；真實原卷校準（本機，數字見 docs/source-check.md） |

## 2. 非功能需求 NFR

| ID | 摘要 | 狀態 | 模組路徑 | 對應 ADR | 驗證方式 |
|---|---|---|---|---|---|
| NFR-001 | 安全：x-api-key（timing-safe）、CORS 白名單、防 SSRF、正式環境不回傳錯誤細節 | 已實作 | exam_pro/middleware/、exam_pro/app.js、exam_pro/services/wordService.js（isSafeImageUrl） | ADR-005 | 單元 |
| NFR-002 | 成本：限流、RPM 節流、逐 token 計費、單 job／每日成本上限 | 已實作 | exam_pro/middleware/rateLimit.js、exam_pro/services/llm/throttle.js、exam_pro/config/pricing.js | ADR-003 | 單元＋job_events 成本紀錄 |
| NFR-003 | 可測試性：agent 純函式合約、cassette record/replay、CI 零金鑰零網路 | 已實作 | exam_pro/agents/、exam_pro/services/llm/、exam_pro/eval/cassettes/ | ADR-006 | 單元 1,567 項不連網不連庫（feat/follow-up-links 併入 feat/source-check 後實測，2026-09-15〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕）；CI replay |
| NFR-004 | 品質門檻：eval golden＋ratchet（首測 −0.03、只升不降），低於門檻 CI 轉紅 | 已實作 | exam_pro/eval/run.js、exam_pro/eval/thresholds.json、exam_pro/eval/lib/ | ADR-006 | 五個 eval suite（[qa_tracker §2](../05_qa/qa_tracker.md)） |
| NFR-005 | 可靠性：SKIP LOCKED＋租約認領、斷點續跑、逾時退避重試、重試預算 | 已實作 | exam_pro/workers/jobRunner.js、exam_pro/pipeline/stateMachine.js | ADR-003 | 整合＋e2e |
| NFR-006 | 資料一致性：組卷與作答歷史同交易；migrations 只增不改（0001–0009〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕） | 已實作 | exam_pro/controllers/examController.js、exam_pro/migrations/、exam_pro/migrate.js | ADR-001 | 整合 |

## 3. ADR 索引

一決策一檔，置於 [adr/](./adr/)；決策全文與替代方案評估以各 ADR 為準，本表僅列決定性因素。

| ADR | 決定性因素 |
|---|---|
| ADR-001-pgvector-over-dedicated-vector-db | 關聯條件（NOT EXISTS attempts 等）與向量檢索必須同一查詢 |
| ADR-002-hybrid-retrieval-rrf | jieba 應用層分詞＋RRF k=60；MRR 稀釋（0.9575→0.824）為已知代價 |
| ADR-003-code-orchestrated-agent-pipeline | 流程已知且固定，拒 LLM 編排與框架；PG 佇列原生持久化 |
| ADR-004-custom-latex-ooxml-over-pandoc | docx 原生 Math 物件；受控輸入域；零外部二進位相依 |
| ADR-005-server-side-whitelist-validation | prompt 不是保證；兩層防線；部分入庫 |
| ADR-006-cassette-record-replay | 鍵含模型 ID＋模板版本＋輸入雜湊；CI 確定性重播 |
| ADR-007-assistant-no-native-function-calling | responseJsonSchema 決策迴圈；args_json 字串傳參；空結果亦為答案 |
| ADR-008-app-layer-chinese-tokenizer | utils/tokenize.js 凍結為全案唯一分詞；換分詞器須整批重建索引 |
| ADR-009-deterministic-source-text-check | 抄錯型態是字元層級（正負號、漏字母）；決定性比對零成本、cassette 不失效、樣卷 0 誤報可在 CI 釘住；LLM 複驗與抄錯同源、非確定；預設 enforce〔修訂 2026-09-15f〕 |

## 4. 追溯

- 上游：DEC-001～012（[requirements_tracker](../01_requirements/requirements_tracker.md) §1；DEC-010／011 為 2026-08-29 補登錄〔修訂 2026-08-29〕；DEC-012 為 2026-09-15 新增〔修訂 2026-09-15e〕）、DEC-013〔修訂 2026-09-15f〕；凍結介面與裁決（`docs/interfaces*.md`；原卷比對為裁決 S2-31）。
- 下游：FR-001～020 → TC-＊與五個 eval suite（[qa_tracker](../05_qa/qa_tracker.md)）〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕；FR-010～012、FR-016 → 各 ui_spec（[../02_ux_ui/](../02_ux_ui/)）；NFR-005、DEC-004 → runbook（[../06_ops/](../06_ops/)）。

## 5. 相依與平行開發〔修訂 2026-08-29 新增〕

> 目的：讓多條開發線能同時施工。`docs/roadmap-plan.md` §1 的相依圖與四條 workstream 是**凍結快照**（不滾動）；本節是**活的相依層**——後續 FR 之間「誰擋誰、誰可同時」的變更在此維護。體例與制度細節不在此重述：worktree 施工體例與 session 提示詞見 `docs/archive/stage*-parallel-prompts.md`，檔案所有權表見 `docs/interfaces-stage*.md` §10，硬閘見 `VibeCoding_Workflow_Templates/_meta/workflow_manual.md` §8。

### 5.1 共用模組熱點（動它＝一次動多條 FR，開工前必先凍結契約）

| 共用點 | 擁有者 FR | 受影響 FR | 衝突性質 |
|---|---|---|---|
| `queries/hybrid.js`＋`services/retrievalService.js` | FR-010 | FR-002（kNN）、FR-011、FR-012 | 檢索四落點共用同一條 SQL；最大單點衝突源 |
| `utils/tokenize.js`（ADR-008 凍結） | — | FR-002、FR-010～012 | 換分詞器須整批重建索引；寫入端與查詢端必須同詞表 |
| `workers/jobRunner.js`＋`pipeline/stateMachine.js` | FR-001 | FR-002～006、FR-011（variant 同管線）、FR-018、FR-019（終態後重算綁定）〔修訂 2026-09-15e〕、FR-020（source_check 節點與 extract 階段抽片段〔修訂 2026-09-15f〕） | 節點順序／預算／租約改動跨 FR；狀態或原因清單變長會連動 stateMachine／jobRunner／variantPipeline／stage3Ui／publicAssets／e2e 等測試 |
| `services/llm/`＋`config/models.js`＋cassette | — | 所有走 LLM 的 FR（001/002/004/011/012/016/018） | 改 prompt 或模型必須重錄 cassette（ADR-006），重錄是全域動作 |
| `attempts` 資料表 | FR-008（建列） | FR-013（讀）、FR-014（搬移／刪除）、FR-015（寫 result）、FR-010/011（NOT EXISTS 排除） | 所有權規則已凍結（roadmap §1.5） |
| `routes/index.js` | — | 全部 | append-only 分區塊設計，衝突落相鄰行、兩邊都留即可 |
| `public/index.html`＋`window.ExamApp` | — | FR-006/010/011/012/013/016/017 前端 | 各功能為獨立 ES module，只在殼插錨點；殼本身（視圖／nav）是單檔熱點 |
| `migrations/` | — | 任何動 schema 的 FR | 只增不改；**編號需開工前預先分配**，否則平行分支撞號（2026-09-15 分配：0008 承上題綁定、0009 原卷比對 FR-020〔修訂 2026-09-15f〕；兩支若都重建同一條 CHECK，合併時須改成含雙方新值的完整值域） |
| `config/chapters.js` | FR-002 | FR-007、FR-017（SOURCE_TYPES）、前端三層選單 | VOLUMES／SOURCE_TYPES 是值域唯一真相 |
| `eval/thresholds.json`＋五個 suite | — | 全部 | ratchet 只升不降＝全域共享 gate，分支不得各自調門檻 |

### 5.2 可平行叢集（模組零交集，可各開一條 worktree）

- **可同時施工**：FR-003 ∥ FR-007 ∥ FR-009 ∥ FR-013 ∥ FR-014 ∥ FR-015 ∥ FR-016（模組路徑互不重疊；唯一交集 `routes/index.js` 為 append-only）。
- **不可同時動檢索層**：FR-002／FR-010／FR-011／FR-012 共用 `hybrid.js`＋`tokenize.js`——必須先凍結檢索契約（I0），再各自往上長。
- **管線節點內部可平行**：FR-002／003／004／005 四個 agent 互不 require（純函式、只收 ctx），節點內邏輯可平行改；但**節點順序與管線編排**屬 FR-001 單點。

### 5.3 強制串行閘（平行度的硬上限，繞過即違反既有權威）

1. **owner 需求決策簽核**（workflow_manual §8 硬閘）——人類序列資源，多開線只是排隊。
2. **cassette 重錄**（ADR-006）——需金鑰、花錢、耗時；只在主目錄 main 上做。凡改 prompt／模型的分支，重錄一律排隊，**因此同批次最多一條線動 `agents/`＋`services/llm/`**。
3. **整合測試**——`--test-concurrency=1`，各檔共用同一 `_test` 庫並 TRUNCATE；多條線同時跑會互相清庫（test_plan §執行方式）。worktree 各自跑單元測試不受限。
4. **eval ratchet**——全域門檻，任何分支合併前以 main 的 thresholds 為準。
5. **四合一試合併**——整合者單點：試合併→全測→裁決→合 main→看 CI（體例見 `docs/HANDOFF.md` §1）。

### 5.4 擱置任務的平行性（現時點）

- **可完全平行**：A-T16（唯讀前後對照）∥ A-T17（新增 `services/llm/anthropic.js`，不動既有）∥ 私有 golden／fixture 擴充（純標註，不動 code）。
- **必須串行**：P-16（動 `agents/generateVariant.js`＋模板）——需重錄 variant cassette，與任何其他動 LLM 鏈的任務互斥（見 5.3-2）。
