# ADR-003: 拆題管線由程式碼編排而非 LLM 或框架 (Code-Orchestrated Agent Pipeline) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **決策狀態:** 已採納（階段 2） | **決策者:** Ben
> **定位:** 本文件回答「多 Agent 拆題管線為何以程式碼狀態機編排、以 PostgreSQL 為佇列」；輸出驗證防線見 ADR-005，cassette 見 ADR-006，流程未知情境的對照決策（助教）見 ADR-007，系統全貌歸 sad。

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：§3 理由 1 單元測試數 1,415→1,445（來源：commit f7a9c41 訊息實測）。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 改造前的拆題為單一大型 prompt 處理整份 PDF：無 schema 驗證、無重試機制，`JSON.parse` 成功即回傳；章節白名單在 prompt 與程式中各維護一份，逐漸不一致；答案由拆題模型自行抄錄，缺乏第二來源比對。
- **問題**: 曾實際發生單一題目格式錯誤導致整批請求以 400 失敗的事故；錯誤無法歸因至個別步驟，亦無法做模型路由。
- **驅動因素/約束**:
  - 拆題流程已知且固定（拆題→分類→公式修復→驗答→去重），無需以不確定性換取彈性。
  - AI 成本必須受控（DEC-008）：模型路由、RPM 節流、重試預算、成本上限。
  - CI 須零金鑰零網路確定性重播完整管線（NFR-003）；可靠性要求斷點續跑（NFR-005）。
  - 單人 Windows 環境維運，不引入額外 broker（DEC-009）。

## 2. 考量的選項

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **單一大型 prompt**（改造前） | 實作最簡、單次呼叫 | 無部分成功、錯誤無法歸因至個別步驟、無法做模型路由、受 context 上限約束 | 曾實際造成整批失敗；此即本次改造要解決的問題 |
| **以 LLM 擔任編排者**（自主代理迴圈） | 彈性高，可處理未預先設計的流程 | 控制流不確定、難以測試；成本無上界；失敗情境不可重現 | 拆題流程已知且固定（流程未知的情境見 ADR-007 對話式助教） |
| **框架**（LangChain／LangGraph／CrewAI／AutoGen） | 上手快、生態系完整；LangGraph 亦提供圖狀態機 | 抽象層遮蔽 prompt 與錯誤細節；版本演進快；圖狀態需另行持久化方能斷點續跑；行為難以被測試固定 | 自建狀態機以 PostgreSQL 為後盾，持久化與並行認領為原生能力；輕量自有 LLM 層是 cassette replay CI 的前提 |
| **專用佇列**（BullMQ + Redis／Celery／Kafka） | 吞吐與重試機制成熟 | 需維運額外 broker；與業務資料分屬不同交易 | 單人 Windows 環境；`FOR UPDATE SKIP LOCKED` 為同規模標準解法，且認領與寫回同屬一個交易 |
| **多模型辯論／委員會** | 可進一步提升精度 | 成本隨模型數倍增 | 僅於價值最高的環節（答案驗證）採雙模型比對，其餘以確定性閘門把關 |
| **雲端託管 agent 平台** | 免維運 | 題庫屬私有資產，不宜外流；平台綁定 | 資料與驗證邏輯留本地，僅 LLM 呼叫對外（DEC-009） |
| **程式碼編排的管線式多 Agent**（採納） | 控制流確定、可重跑、可觀測、成本內建受控 | 前期建置成本高（見 §4） | — |

## 3. 決策

**選擇**: 編排者＝程式碼（`exam_pro/workers/jobRunner.js`），流程為 PostgreSQL 上的確定性狀態機（`exam_pro/pipeline/stateMachine.js`）：jobs `queued→extracting→processing→done/failed`；每題一列 job_questions `extracted→hashed→classified→linted→verified→deduped→saved／needs_review／rejected`。認領以 `FOR UPDATE SKIP LOCKED`＋租約；各節點設逾時、退避重試、RPM 節流、成本上限。六個 sub-agent（`exam_pro/agents/`）均為純函式合約：不碰 DB、不讀 env、LLM 僅經注入的 `ctx.llm`、輸出以 JSON Schema（ajv）驗證。

**理由**:

1. prompt 不構成保證，伺服器端驗證才是：每道閘門為一般程式碼，行為由 1,445 項單元測試固定（commit f7a9c41 訊息實測）。〔修訂 2026-08-29〕
2. 將不確定性限制在單一步驟內：流程為確定性狀態機——可重跑、可觀測（`job_events` 逐步記錄含成本），租約到期由其他 worker 接手續跑。
3. 協作形式是相互驗證而非自由對話：verify 節點以不同模型（pro）獨立重解並比對答案；kNN 投票僅採計人工確認標籤，避免錯誤分類自我強化。
4. 成本控制內建於架構：閘門依成本低至高排序（文字比對→embedding→LLM）；模型路由（拆題 flash、驗答 pro）；單 job 與每日成本上限。
5. 失敗語意為部分入庫：一批 90 題中 3 題有疑慮，其餘 87 題照常入庫，3 題附具體原因進人工複核佇列（八種 needs_review 原因）。

## 4. 後果

- **正面**: pipeline saved_rate 0.90（門檻 ≥0.87）、gate_pass_rate 1.00（≥0.97）、answer_agree_rate 0.90（≥0.87），以 replay 對 golden 量測並受 ratchet 把關；CI 零金鑰零網路重播完整管線。
- **負面（已知限制）**:
  - 前期建置成本高：狀態機、閘門、eval 基礎設施皆為手寫，初期投入高於現成框架。
  - 擴充彈性較低：新增節點需同步修改 DDL 的 CHECK 約束、契約、閘門與測試。
  - 吞吐量依賴 job 並行數；處理量增加十倍以上時，PostgreSQL 佇列方案應重新評估。
  - 更換模型需重錄全部 cassette（cassette 鍵包含模型 ID，為刻意設計）。
- **影響範圍**: `exam_pro/workers/jobRunner.js`、`exam_pro/pipeline/stateMachine.js`、`exam_pro/agents/`、`exam_pro/services/llm/`、migration `0003_jobs`、eval pipeline suite。
- **重新評估觸發**: 處理量增加十倍以上（佇列方案）；流程由固定轉為使用者驅動（改依 ADR-007 模式）。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-005、DEC-008、DEC-009、FR-001～FR-006、NFR-002、NFR-003、NFR-005 |
| 影響範圍 | db_design（jobs／job_questions／job_events）、api_spec（POST /api/jobs、review） |
| 取代關係 | Supersedes：舊版單呼叫拆題（`exam_pro/services/aiService.js`，保留對照）；Superseded-by 無 |
| 相關 ADR | ADR-005（白名單驗證）、ADR-006（cassette）、ADR-007（對話式助教＝對照編排哲學） |
