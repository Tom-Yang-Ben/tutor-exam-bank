# 工程文件索引 (Engineering Docs Index) - 家教專用數理題庫系統

> **版本:** v1.3 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **定位:** 本資料夾是專案的正式工程文件**實例**；產出所依據的模板庫 `VibeCoding_Workflow_Templates/` 現位於本 repo 根目錄，僅供本機參考（owner 2026-08-29 裁定不納入版控，已列入 `.gitignore`〔修訂 2026-08-29〕）。本檔回答「哪份文件在哪裡、回答什麼問題、ID 如何互相追溯」，不重述各文件內容。
> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：模板庫位置描述更新、「九層分類」更正為六層資料夾分類、ID 骨幹擴充（DEC-010/011、FR-017/018）、engineering_tracker 定位補「相依與平行開發」章節。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 教學診斷平台整合回填，分支 `stage5/int-docs`）：02_ux_ui 補三份新 ui_spec（知識點、AI 家教、補救卷與覆蓋率）；03_architecture 補 ADR-010～015；01、04 各文件的一句話定位與 migrations 範圍同步；§2 ID 骨幹延伸至 DEC-014～019、FR-021～035、NFR-007～009、ADR-010～015；新增 §4 階段 5 的權威功能文件（`docs/`）對照。修改處以〔修訂 2026-09-24〕行內標記。

## 1. 目錄結構

資料夾編號沿用模板庫的六層資料夾分類（`01_requirements`–`06_ops`，對應 Word 指南第 15 章；「九層」是模板生態系 artifact-map 的文件分類，非資料夾編號〔修訂 2026-08-29〕）；每資料夾內文件如下。

### 01_requirements／需求

| 文件 | 一句話定位 |
| :--- | :--- |
| [brd.md](./01_requirements/brd.md) | 商業脈絡與九條需求決策（DEC-001～009）的業務論證 |
| [prd.md](./01_requirements/prd.md) | 功能需求（FR-001～035〔修訂 2026-09-24〕）、驗收條件（ACPT）與 AI 邊界場景（SCN-011～016）；範圍與不做什麼（含 DEC-014 撤銷的兩條） |
| [srs.md](./01_requirements/srs.md) | FR/NFR 的可驗證化規格（FR-001～035、NFR-001～009〔修訂 2026-09-24〕）、資料需求、外部介面、使用案例與 ACPT 可觀察判準 |
| [requirements_tracker.md](./01_requirements/requirements_tracker.md) | 需求追蹤簿：①需求決策全列、②決策沿革、③Gate 簽核 |

### 02_ux_ui／使用者體驗與介面

| 文件 | 一句話定位 |
| :--- | :--- |
| [ux_research_and_journey.md](./02_ux_ui/ux_research_and_journey.md) | 使用者（一對一家教老師）痛點、旅程與 User Flow |
| [information_architecture.md](./02_ux_ui/information_architecture.md) | 頁面與導覽結構、功能落點（FR→頁面對照） |
| [ui_spec-main.md](./02_ux_ui/ui_spec-main.md) | 主頁規格：題庫管理＋組卷＋上傳拆題（public/index.html） |
| [ui_spec-review.md](./02_ux_ui/ui_spec-review.md) | 人工複核佇列頁規格（public/js/review.js） |
| [ui_spec-students.md](./02_ux_ui/ui_spec-students.md) | 學生管理＋弱點面板＋批改頁規格（public/js/students.js） |
| [ui_spec-nlq.md](./02_ux_ui/ui_spec-nlq.md) | 自然語言查題頁規格（public/js/nlq.js） |
| [ui_spec-variants.md](./02_ux_ui/ui_spec-variants.md) | 變式題頁規格（public/js/variants.js） |
| [ui_spec-assistant.md](./02_ux_ui/ui_spec-assistant.md) | 對話式助教頁規格（public/js/assistant.js） |
| [ui_spec-kc.md](./02_ux_ui/ui_spec-kc.md)〔修訂 2026-09-24〕 | 知識點分頁規格：瀏覽、審定口語版、朗讀、題目→知識點（public/js/kc.js） |
| [ui_spec-tutor.md](./02_ux_ui/ui_spec-tutor.md)〔修訂 2026-09-24〕 | AI 家教分頁規格：兩種講解模式、計算驗證、按住說話（public/js/tutor.js） |
| [ui_spec-remedial.md](./02_ux_ui/ui_spec-remedial.md)〔修訂 2026-09-24〕 | 補救卷（學生視圖子區塊）與題庫覆蓋率（題庫視圖子區塊）規格（public/js/remedial.js） |

### 03_architecture／架構

| 文件 | 一句話定位 |
| :--- | :--- |
| [sad.md](./03_architecture/sad.md) | 架構契約：模組視圖、資料流、部署視圖與 NFR 的架構對應 |
| [adr/ADR-001](./03_architecture/adr/ADR-001-pgvector-over-dedicated-vector-db.md) | 選 pgvector 而非專用向量庫：關聯條件與向量檢索同一查詢 |
| [adr/ADR-002](./03_architecture/adr/ADR-002-hybrid-retrieval-rrf.md) | hybrid 檢索（jieba 分詞＋RRF k=60），MRR 稀釋為已知代價 |
| [adr/ADR-003](./03_architecture/adr/ADR-003-code-orchestrated-agent-pipeline.md) | 程式碼編排的多 Agent 管線，拒 LLM 編排與框架 |
| [adr/ADR-004](./03_architecture/adr/ADR-004-custom-latex-ooxml-over-pandoc.md) | 自製 LaTeX→OOXML 轉換而非 Pandoc，docx 原生 Math 物件 |
| [adr/ADR-005](./03_architecture/adr/ADR-005-server-side-whitelist-validation.md) | 伺服器端白名單硬驗證：prompt 不是保證、兩層防線 |
| [adr/ADR-006](./03_architecture/adr/ADR-006-cassette-record-replay.md) | LLM cassette record/replay，CI 零金鑰零網路確定性重播 |
| [adr/ADR-007](./03_architecture/adr/ADR-007-assistant-no-native-function-calling.md) | 助教不用原生 function calling，改受限 JSON 決策迴圈 |
| [adr/ADR-008](./03_architecture/adr/ADR-008-app-layer-chinese-tokenizer.md) | 應用層中文分詞凍結為全案唯一分詞（utils/tokenize.js） |
| [adr/ADR-009](./03_architecture/adr/ADR-009-deterministic-source-text-check.md) | 決定性原卷文字層比對攔抄錯題幹，不用 LLM 複驗；預設 enforce、可切 shadow〔修訂 2026-09-15f〕 |
| [adr/ADR-010](./03_architecture/adr/ADR-010-subject-group-routing-for-chemistry.md)〔修訂 2026-09-24〕 | 化學走「卷別分流」：數學／物理凍結舊模板與 schema，化學另立模板與 schema |
| [adr/ADR-011](./03_architecture/adr/ADR-011-knowledge-component-model.md)〔修訂 2026-09-24〕 | 知識點模型：code 穩定識別、口語版、AI 標註與人工標註分權 |
| [adr/ADR-012](./03_architecture/adr/ADR-012-tutor-code-execution-spoken-text.md)〔修訂 2026-09-24〕 | AI 家教獨立於助教、以 code execution 驗算、以口語版為講法依據 |
| [adr/ADR-013](./03_architecture/adr/ADR-013-push-to-talk-teacher-confirm.md)〔修訂 2026-09-24〕 | 語音輸入：按住說話、老師確認才送出、音訊不落地 |
| [adr/ADR-014](./03_architecture/adr/ADR-014-remedial-paper-wilson-quota.md)〔修訂 2026-09-24〕 | 補救卷以 Wilson 下界排序弱點、依配額重用既有選題閘門 |
| [adr/ADR-015](./03_architecture/adr/ADR-015-grading-detail-and-solution-provenance.md)〔修訂 2026-09-24〕 | 批改細節以 attempts 加欄＋伺服器端白名單記錄；文字詳解分來源、以 verify 摘要零成本回填（整合時由 014 改號，裁決 S5-1） |
| [engineering_tracker.md](./03_architecture/engineering_tracker.md) | 工程追蹤簿：FR/NFR→模組路徑→ADR→驗證方式；§5 相依與平行開發（活的相依層）〔修訂 2026-08-29〕 |

### 04_design／技術設計

| 文件 | 一句話定位 |
| :--- | :--- |
| [api_spec.md](./04_design/api_spec.md) | API 約定（認證、限流、錯誤格式）與端點總表 |
| [openapi-exam-pro-v1.yaml](./04_design/openapi-exam-pro-v1.yaml) | API 契約 SSOT（OpenAPI） |
| [db_design.md](./04_design/db_design.md) | 資料庫設計：資料表、索引、migrations（0001–0012〔修訂 2026-09-15f〕〔修訂 2026-09-24〕）與 enum |
| [lld.md](./04_design/lld.md) | 低階設計：jobs／job_questions 狀態機與助教決策迴圈；階段 5 的卷別分流、知識點載入與標註、補救卷選題、AI 家教〔修訂 2026-09-24〕 |

### 05_qa／測試與驗收

| 文件 | 一句話定位 |
| :--- | :--- |
| [test_plan.md](./05_qa/test_plan.md) | 測試策略：四層測試（單元／整合／e2e／eval）與代表案例 |
| [uat_plan.md](./05_qa/uat_plan.md) | 驗收計畫與紀錄：UAT 場景 SCN-001～010、歷史驗收證據 |
| [qa_tracker.md](./05_qa/qa_tracker.md) | 測試追蹤簿：TC 骨架（依 FR 分組）與執行證據、eval 門檻 |

### 06_ops／部署與維運

| 文件 | 一句話定位 |
| :--- | :--- |
| [deployment_and_operations.md](./06_ops/deployment_and_operations.md) | 部署程序、環境設定、備份與日常維運；§3.4 階段 5 上線步驟〔修訂 2026-09-24〕 |
| [runbook-job-stuck.md](./06_ops/runbook-job-stuck.md) | 故障排除：job 卡在 processing／租約未釋放／worker 中斷 |
| [runbook-llm-cost-quota.md](./06_ops/runbook-llm-cost-quota.md) | 故障排除：LLM 費用暴增／配額 429／成本上限觸發；§8 AI 家教、語音、知識點標註的成本煞車〔修訂 2026-09-24〕 |
| [runbook-pg-down.md](./06_ops/runbook-pg-down.md) | 故障排除：PG 容器起不來／連線失敗／回滾與備份還原 |
| [runbook-eval-threshold-fail.md](./06_ops/runbook-eval-threshold-fail.md) | 故障排除：CI eval 低於 ratchet 門檻／replay miss |

## 2. ID 骨幹（追溯鏈）

- 主鏈：**DEC-001～011、DEC-013**（需求決策，brd／requirements_tracker；DEC-010 題源標記、DEC-011 附圖裁切為 2026-08-29 補登錄〔修訂 2026-08-29〕；DEC-013 原卷文字層比對，核准待簽〔修訂 2026-09-15f〕）→ **FR-001～018、FR-020／NFR-001～006**（prd／srs；FR-017 source_type、FR-018 附圖裁切〔修訂 2026-08-29〕；FR-020 原卷文字層比對〔修訂 2026-09-15f〕）→ **TC-\<FR 號\>-\<序\>**（qa_tracker）。DEC-012／FR-019 由承上題綁定分支使用〔修訂 2026-09-15f〕。
- 階段 5〔修訂 2026-09-24〕：**DEC-014～019**（教學診斷平台；核准欄待 Owner 簽核）→ **FR-021～035／NFR-007～009**（DEC-014 為定位決策、不單獨對應 FR；對照表見 [requirements_tracker §4](./01_requirements/requirements_tracker.md)）→ **TC-021-1～TC-035-2**（qa_tracker）。尚未實作的驗收項（錯題重練、間隔複習、訂正卷、學習路徑、學習報告）尚未分配 FR。
- 衍生：驗收條件 **ACPT-\<FR 號\>-\<序\>**（prd §3）；場景 **SCN-\<序\>**——SCN-001～010 為 UAT 場景（uat_plan），SCN-011～016 為 AI 邊界場景（prd §3.2）。
- 架構決策 **ADR-001～009**〔修訂 2026-09-15f〕、**ADR-010～015**〔修訂 2026-09-24〕由 DEC 引出，於 engineering_tracker 與各文件以穩定 ID 指涉；文件間追溯一律用 ID，不用標題文字。

## 3. 與模板庫的關係

- `VibeCoding_Workflow_Templates/` 是可裁剪的作業格式（模板；不在本 repo 版控內，見文件頂部定位說明）；本資料夾是依其結構產出的**專案實例**，多實例模板依穩定錨點展開（ADR 每決策一檔、ui_spec 每頁一份、runbook 每症狀一份）。
- 三本追蹤簿（requirements／engineering／qa）以本資料夾的 Markdown 為發布快照，`*_tracker.xlsx` 由 md 轉出；人工維護欄位以 md 為準。
- 專案事實以原始碼與 `exam_pro/` README 為準；本資料夾不另立第二真相源。

## 4. 階段 5 的權威功能文件（`docs/`）〔修訂 2026-09-24〕

階段 5 各功能的 API 細節、錯誤訊息、設計取捨與給老師的操作說明，以下列功能文件為權威；本資料夾各文件只寫摘要並連結，不重述。

| 文件 | 範圍 | 對應 |
| :--- | :--- | :--- |
| [interfaces-stage5.md](../docs/interfaces-stage5.md) | 階段 5 介面凍結（契約）與裁決紀錄 S5-1～S5-39 | 全部 WS |
| [grading-and-profile.md](../docs/grading-and-profile.md) | 批改細節、錯因分布、學生檔案、文字詳解、Word 版本 | FR-021～025、ADR-015 |
| [chemistry.md](../docs/chemistry.md) | 化學卷別分流、排版子集、答案比對、化學 eval、`search:reindex` | FR-026～027、ADR-010 |
| [knowledge-components.md](../docs/knowledge-components.md) | 知識點資料、載入、API、自動標註、審定流程 | FR-028～029、ADR-011 |
| [remedial.md](../docs/remedial.md) | 知識點弱點、補救卷、跨章配額、題庫覆蓋率 | FR-030～033、ADR-014 |
| [tutor.md](../docs/tutor.md) | AI 家教、`generateText`、按住說話、成本 | FR-034～035、ADR-012、ADR-013 |
| [kc-review-數學.md](../docs/kc-review-數學.md)、[kc-review-物理.md](../docs/kc-review-物理.md)、[kc-review-化學.md](../docs/kc-review-化學.md) | 三科知識點種子檔的抽查紀錄與待 Owner 決定的章節切法 | FR-028 |
