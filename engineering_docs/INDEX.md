# 工程文件索引 (Engineering Docs Index) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **定位:** 本資料夾是專案的正式工程文件**實例**；產出所依據的模板庫 `VibeCoding_Workflow_Templates/` 現位於本 repo 根目錄，僅供本機參考（owner 2026-08-29 裁定不納入版控，已列入 `.gitignore`〔修訂 2026-08-29〕）。本檔回答「哪份文件在哪裡、回答什麼問題、ID 如何互相追溯」，不重述各文件內容。
> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：模板庫位置描述更新、「九層分類」更正為六層資料夾分類、ID 骨幹擴充（DEC-010/011、FR-017/018）、engineering_tracker 定位補「相依與平行開發」章節。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。

## 1. 目錄結構

資料夾編號沿用模板庫的六層資料夾分類（`01_requirements`–`06_ops`，對應 Word 指南第 15 章；「九層」是模板生態系 artifact-map 的文件分類，非資料夾編號〔修訂 2026-08-29〕）；每資料夾內文件如下。

### 01_requirements／需求

| 文件 | 一句話定位 |
| :--- | :--- |
| [brd.md](./01_requirements/brd.md) | 商業脈絡與九條需求決策（DEC-001～009）的業務論證 |
| [prd.md](./01_requirements/prd.md) | 十六條功能需求（FR）、驗收條件（ACPT）與 AI 邊界場景（SCN-011～016） |
| [srs.md](./01_requirements/srs.md) | FR/NFR 的可驗證化規格、資料需求、外部介面與使用案例 |
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
| [engineering_tracker.md](./03_architecture/engineering_tracker.md) | 工程追蹤簿：FR/NFR→模組路徑→ADR→驗證方式；§5 相依與平行開發（活的相依層）〔修訂 2026-08-29〕 |

### 04_design／技術設計

| 文件 | 一句話定位 |
| :--- | :--- |
| [api_spec.md](./04_design/api_spec.md) | API 約定（認證、限流、錯誤格式）與端點總表 |
| [openapi-exam-pro-v1.yaml](./04_design/openapi-exam-pro-v1.yaml) | API 契約 SSOT（OpenAPI） |
| [db_design.md](./04_design/db_design.md) | 資料庫設計：資料表、索引、migrations（0001–0006〔修訂 2026-08-29〕）與 enum |
| [lld.md](./04_design/lld.md) | 低階設計：jobs／job_questions 狀態機與助教決策迴圈 |

### 05_qa／測試與驗收

| 文件 | 一句話定位 |
| :--- | :--- |
| [test_plan.md](./05_qa/test_plan.md) | 測試策略：四層測試（單元／整合／e2e／eval）與代表案例 |
| [uat_plan.md](./05_qa/uat_plan.md) | 驗收計畫與紀錄：UAT 場景 SCN-001～010、歷史驗收證據 |
| [qa_tracker.md](./05_qa/qa_tracker.md) | 測試追蹤簿：TC 骨架（依 FR 分組）與執行證據、eval 門檻 |

### 06_ops／部署與維運

| 文件 | 一句話定位 |
| :--- | :--- |
| [deployment_and_operations.md](./06_ops/deployment_and_operations.md) | 部署程序、環境設定、備份與日常維運 |
| [runbook-job-stuck.md](./06_ops/runbook-job-stuck.md) | 故障排除：job 卡在 processing／租約未釋放／worker 中斷 |
| [runbook-llm-cost-quota.md](./06_ops/runbook-llm-cost-quota.md) | 故障排除：LLM 費用暴增／配額 429／成本上限觸發 |
| [runbook-pg-down.md](./06_ops/runbook-pg-down.md) | 故障排除：PG 容器起不來／連線失敗／回滾與備份還原 |
| [runbook-eval-threshold-fail.md](./06_ops/runbook-eval-threshold-fail.md) | 故障排除：CI eval 低於 ratchet 門檻／replay miss |

## 2. ID 骨幹（追溯鏈）

- 主鏈：**DEC-001～011**（需求決策，brd／requirements_tracker；DEC-010 題源標記、DEC-011 附圖裁切為 2026-08-29 補登錄〔修訂 2026-08-29〕）→ **FR-001～018／NFR-001～006**（prd／srs；FR-017 source_type、FR-018 附圖裁切〔修訂 2026-08-29〕）→ **TC-\<FR 號\>-\<序\>**（qa_tracker）。
- 衍生：驗收條件 **ACPT-\<FR 號\>-\<序\>**（prd §3）；場景 **SCN-\<序\>**——SCN-001～010 為 UAT 場景（uat_plan），SCN-011～016 為 AI 邊界場景（prd §3.2）。
- 架構決策 **ADR-001～008** 由 DEC 引出，於 engineering_tracker 與各文件以穩定 ID 指涉；文件間追溯一律用 ID，不用標題文字。

## 3. 與模板庫的關係

- `VibeCoding_Workflow_Templates/` 是可裁剪的作業格式（模板；不在本 repo 版控內，見文件頂部定位說明）；本資料夾是依其結構產出的**專案實例**，多實例模板依穩定錨點展開（ADR 每決策一檔、ui_spec 每頁一份、runbook 每症狀一份）。
- 三本追蹤簿（requirements／engineering／qa）以本資料夾的 Markdown 為發布快照，`*_tracker.xlsx` 由 md 轉出；人工維護欄位以 md 為準。
- 專案事實以原始碼與 `exam_pro/` README 為準；本資料夾不另立第二真相源。
