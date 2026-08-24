# 期中專案 · 家教專用數理題庫系統（多 Agent × RAG）

[![CI](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml)

> 以 AI 協助家教老師「上傳考卷 → 多 Agent 管線自動拆題入庫 → 對學生出**不重複**的卷 → 匯出 Word 原生公式考卷」，
> 並在其上疊加 RAG 檢索（相似題／自然語言查題／檢索式分類）與對話式助教（主控 agent + 工具調用）。

本 repo 收錄專題的**完整開發歷程**：早期原型（`exam/`）、企業級重構與四個階段的演進（`exam_pro/`）、全部設計文件與裁決紀錄（`docs/`）。

> ⚖️ 本 repo 不含任何題庫或考卷內容；程式碼採 Apache-2.0，示範題與 eval 素材皆自行編寫。詳見 [`NOTICE`](./NOTICE)。

---

## 🖥️ 操作介面

![家教專用數學物理題庫系統操作頁面](./screenshots/operation-page.png)

---

## 🎯 問題背景與設計目標

**使用者**：一對一數理家教老師（高中數學／物理），手上有大量歷屆考卷 PDF，需要為每位學生客製特訓卷。

**痛點**：出卷的行政損耗遠大於教學本身。複雜公式（直式分數、根式、幾何圖）在 Word 手動排版容易跑位；題目散在各份考卷裡，哪個學生寫過哪題無從追蹤，重複出題傷害練習效果。一份特訓卷常花 **2 小時以上**。

**目標**：出一份卷從 2 小時縮短到幾分鐘，把心力留給一對一指導本身。

**第二個目標（階段 2 之後）**：在同一個真實產品上，把**多 Agent 協作**與 **RAG 檢索**兩項能力做成看得見、量得到、可被逐行檢驗的工程實作——本 README 的兩章技術選型就是為此而寫。

**關鍵約束**：

- 交付物必須是 **Word 原生方程式**的 `.docx`——學生端用紙本，公式得是直式分數而非斜線，因此自製 LaTeX → OOXML 轉換而非貼圖。
- AI 拆題的輸出格式必須可控（章節名、LaTeX 語法不能自由發揮），以白名單驗證收斂。
- AI 呼叫需限流以控制成本。

**成功標準**：上傳 PDF → 自動拆題入庫 → 選學生一鍵組卷 → 匯出可直接列印的 Word，全程零手動排版；同一學生保證不會拿到寫過的題目。

---

## 📈 系統演進：原型 → 四個階段

| 階段 | 主題 | 內容 | 狀態 |
|---|---|---|---|
| 原型 | `exam/` | 單檔 `server.js` 驗證「AI 拆題＋組卷＋匯出」核心流程 | ARCHIVED（保留當重構對照） |
| 重構 | `exam_pro/` v1 | MVC 分層、白名單硬驗證、LaTeX→OOXML 公式引擎、防 SSRF、限流、交易 | ✅ |
| 階段 1 資料層 | MySQL → **PostgreSQL 16 + pgvector** | `students`/`attempts` 正規化、embedding 回填、hybrid 檢索、eval 體系與 CI integration job；2026-08-21 切換上線 | ✅ |
| 階段 2 Agent 管線 | `jobs` 狀態機 + 六個 sub-agent | 拆題／分類／公式修復／獨立驗答／兩段去重，硬閘門、重試預算、**部分入庫**、人工複核佇列、cassette record/replay | ✅ |
| 階段 3 產品面（RAG 三落點） | 相似題、變式題生成、學生弱點面板、自然語言查題 | 檢索優先、九道閘門、kNN few-shot 分類、四級回退階梯 | ✅ |
| 階段 4 產品收斂 | 日常流程矯正＋主控 agent | 選學生出卷（草稿→確認）、批改輕量化、學生管理、**對話式助教**（主控 LLM 調度五個只讀工具） | ✅ |

四個階段由四條平行 workstream（git worktree）施工、以「凍結介面＋裁決」制度整合——全部裁決紀錄在 [`docs/interfaces*.md`](./docs)，交接紀實在 [`docs/HANDOFF.md`](./docs/HANDOFF.md)。

---

## 🗂 資料夾與檔案地圖（完整版）

### repo 根目錄

| 位置 | 內容 |
|---|---|
| **[`exam_pro/`](./exam_pro)** | 🌟 **主要成品**——可執行的系統本體（下表展開） |
| [`exam/`](./exam) | 早期原型（ARCHIVED）：單檔 `server.js`，保留當重構前後對照與 A-T16 基準 |
| [`docs/`](./docs) | 全部設計文件：規劃、凍結介面與裁決、技術選型、交接檔（下表展開） |
| [`screenshots/`](./screenshots) | README 用截圖 |
| [`期中專題報告/`](./期中專題報告) | 開發紀實簡報（HTML，請下載後用瀏覽器開啟） |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | CI：unit（Node 22/24 矩陣）＋ integration（起 pgvector service → migrations → 整合測試 → e2e → 五個 eval suite） |
| [`LICENSE`](./LICENSE) / [`NOTICE`](./NOTICE) | Apache-2.0（程式碼）／題目內容權利聲明 |

### `exam_pro/`（系統本體）

```
exam_pro/
├─ server.js / app.js         # 進入點／Express 設定（CORS、旗標注入、全域錯誤中樞）
├─ routes/index.js            # API 路由表（核心區 + 各階段 append-only 區塊，旗標控制掛載）
│
├─ config/                    # 單一真相們
│   ├─ db.js                  #   PG 連線池（只認 DATABASE_URL；型別轉換集中於此）
│   ├─ models.js              #   模型 ID 單一真相（MODEL_EXTRACT/VERIFY/VARIANT/ASSISTANT）
│   ├─ pricing.js             #   每模型單價（官方頁面查證）與成本估算（thinking 同價計）
│   ├─ features.js            #   FEATURE_* 旗標（預設全關；掛載與渲染的總開關）
│   ├─ chapters.js            #   章節白名單 + 驗證（prompt 不是保證，這裡才是）
│   └─ chapterAliases.js / chapterExamples.js  # NLQ 別名、分類 few-shot 素材
│
├─ agents/                    # 六個 sub-agent（純函式合約：不碰 DB、不讀 env、依賴 ctx 注入）
│   ├─ extract.js             #   PDF 拆題（flash）
│   ├─ classify.js            #   章節分類（零成本閘門 → kNN 投票短路 → 才叫 LLM）
│   ├─ lint.js                #   公式修復
│   ├─ verify.js              #   獨立解題驗證（pro；與拆題不同模型互相制衡）
│   ├─ dedup.js (dedup0/1)    #   兩段去重：正規化雜湊 → 向量餘弦
│   ├─ generateVariant.js     #   變式生成（藍本＋5 鄰居錨點；跑題餘弦閘門）
│   └─ schemas/               #   各 agent 輸出的 JSON Schema（ajv 硬驗證）
│
├─ workers/jobRunner.js       # 編排者＝程式碼：認領（SKIP LOCKED＋租約）、重試預算、RPM 節流、成本上限
├─ pipeline/stateMachine.js   # jobs / job_questions 兩張狀態表的合法轉移
│
├─ services/                  # 業務邏輯
│   ├─ llm/                   #   LLM 唯一出入口：gemini／fake(replay)／throttle；record/replay cassette
│   ├─ retrievalService.js    #   相似題（hybrid 檢索）
│   ├─ nlqService.js          #   自然語言查題（規則主、LLM 輔、四級回退）
│   ├─ variantService.js      #   變式題（檢索優先，池不足才生成）
│   ├─ weaknessService.js     #   弱點面板五條 SQL（純函式）
│   ├─ assistantService.js    #   對話式助教：主控 agent + 五個只讀工具（階段 4）
│   ├─ embedService.js        #   embedding 寫入
│   └─ wordService.js / aiService.js  # Word 匯出（防 SSRF）／舊版單呼叫拆題（保留對照）
│
├─ controllers/               # HTTP 薄殼：question / exam（草稿→確認）/ studentAdmin / student /
│                             # paper（批改）/ review（複核佇列）/ job / assistant / word / ai
├─ middleware/                # x-api-key（timing-safe）、記憶體限流
├─ queries/hybrid.js          # hybrid 檢索 SQL（RRF 融合）——API 與 eval 共用同一段
│
├─ utils/                     # 純函式工具
│   ├─ textFormatter.js       #   LaTeX → OOXML 解析器（自製 tokenizer+遞迴下降）
│   ├─ tokenize.js            #   全案唯一中文分詞（jieba + 章節自訂詞）
│   ├─ embedText.js           #   送 embed 的文本組法（單一真相）
│   ├─ shuffle.js / pickOnePerFamily.js  # Fisher-Yates／組卷家族互斥
│   ├─ normalizeStem.js / answerCompare.js / variantTextGate.js / nlqHeuristics.js
│   └─ formulaFix.js / formulaLint.js / questionValidation.js
│
├─ public/                    # 前端（無打包器）
│   ├─ index.html             #   單頁殼＋題庫/組卷 inline script＋各分頁錨點
│   └─ js/                    #   ES modules：review / students / nlq / variants / assistant
│
├─ migrations/ + migrate.js   # 只增不改的 SQL（0001 init → 0005）＋極簡執行器
├─ eval/                      # 量測體系
│   ├─ run.js                 #   五個 suite：retrieval / classify / pipeline / nlq / variant
│   ├─ lib/                   #   指標、golden loader、pg engine、pipeline driver、門檻 ratchet
│   ├─ golden/                #   人工定案的答案卷（自製內容）
│   ├─ cassettes/             #   LLM 回應錄放帶（只存摘要與雜湊，不存 PDF 原文）
│   ├─ fixtures/              #   60 題自製 fixture、樣卷 PDF、embedding 向量
│   └─ thresholds.json        #   門檻（首測 −0.03、只升不降）
│
├─ test/
│   ├─ unit/                  #   1,415 項：不連網、不連庫、零 secrets
│   ├─ integration/           #   259 項：對 tmpfs 測試庫（_test 後綴強制）
│   └─ e2e/                   #   11 項：HTTP 全路徑（上傳→部分入庫；組卷→Word 公式）
│
├─ scripts/                   # 維運：備份、向量回填、成本報表、公式健檢
├─ seed_questions.js          # 30 題自製種子（4 章 × 7~8 題，含單章密度自檢）
├─ docker-compose.yml         # PG16+pgvector：5442 開發（volume）／5433 測試（tmpfs）
└─ *.bat                      # Windows 雙擊工具（啟動資料庫／備份／公式健檢…）
```

### `docs/`（設計文件）

| 檔案 | 內容 |
|---|---|
| [`roadmap-plan.md`](./docs/roadmap-plan.md) | 五章總規劃：排程、資料層、Agent 管線、產品面、橫切（作法／理由／替代方案／驗收） |
| [`interfaces.md`](./docs/interfaces.md) ／ [`-stage2`](./docs/interfaces-stage2.md) ／ [`-stage3`](./docs/interfaces-stage3.md) | 三份**凍結介面**與全部裁決（階段 1 裁決 1–27、S2-1～30、S3-1～R29）——平行開發的契約 |
| [`stage4-plan.md`](./docs/stage4-plan.md) | 階段 4 產品收斂（S4-1～S4-4、對話式助教） |
| [`rag-and-agents.md`](./docs/rag-and-agents.md) | RAG 與多 Agent 技術決策全紀錄（本 README 技術選型章的完整版） |
| [`variants.md`](./docs/variants.md) ／ [`retrieval.md`](./docs/retrieval.md) ／ [`llm.md`](./docs/llm.md) | 變式題九道閘門與閾值校準／檢索設計／LLM 層 |
| [`cutover-runbook.md`](./docs/cutover-runbook.md) | MySQL→PG 切換之夜的 runbook 與回滾界線 |
| [`stage*-parallel-prompts.md`](./docs) ／ `questions*-ws*.md` ／ `ws-notices-*.md` | 四條平行 workstream 的分工提示詞、各 WS 的提問、裁決通知——**多人（多 agent）協作制度的完整紀錄** |
| [`HANDOFF.md`](./docs/HANDOFF.md) | 交接檔：角色、狀態、標準流程、踩過的坑 |

---

## 🔄 兩個子專案的關係

```
exam/  ──（重構）──▶  exam_pro/
原型：邏輯全在              企業級版：MVC 分層、
單一 server.js            白名單驗證、API 認證、
                         防 SSRF、LaTeX→Word 公式引擎
```

- **`exam`**：最初的可運作原型，驗證「AI 拆題 + 組卷 + 匯出」的核心流程。
- **`exam_pro`**：以 `exam` 為基礎重構，拆分為 `config / controllers / services / middleware / routes / utils`，並補強安全性與正確性。**若要實際執行，請使用 `exam_pro`。**

---

## 🔍 技術選型 ①：RAG——用什麼、為什麼、優缺點、為什麼不選別的

> 完整版（含檔案地圖與面試 Q&A）在 [`docs/rag-and-agents.md`](./docs/rag-and-agents.md)；本節是自足的濃縮版，所有數字皆來自 `eval/` 的實測輸出。

### RAG 在哪裡：四個落點、同一個檢索層

檢索層是**同一段 SQL**（`exam_pro/queries/hybrid.js`），四個功能共用：

| 落點 | 檢索什麼 | 增強什麼 |
|---|---|---|
| **相似題** | 與指定題同科、餘弦最近的題 | 不生成——檢索結果本身就是產品（錯題→「找相似」） |
| **變式題「檢索優先」** | 先找題庫餘弦 ≥ 0.80 的同難度題，池夠就直接推薦（**零生成成本**）；不夠才生成，且把藍本＋前 5 題鄰居塞進 prompt 當錨點；生成後再用餘弦 ≥ 0.90 反向驗證跑題 | 生成不跑題、多數請求不花錢 |
| **檢索式 few-shot 分類** | 從題庫取 k=8 最近鄰當分類範例；最近 5 鄰 ≥4 題是人工確認的同一章且餘弦 ≥0.90 → 直接採用，**一次 LLM 都不呼叫** | 範例跟著題庫長大；高信心時 LLM 被檢索整個取代 |
| **自然語言查題** | 規則抽掉章節／難度／學生條件，剩餘概念文字 embed 走 hybrid；四級回退階梯 | 老師的口語 →（規則＋向量）→ SQL；解析結果回寫下拉、可被人檢視 |

### 選了什麼

**PostgreSQL 16 + pgvector**（768 維 `gemini-embedding-001`，L2 正規化後餘弦＝內積）＋**應用層 jieba 分詞**的全文檢索，兩路以 **RRF（Reciprocal Rank Fusion，k=60）** 融合。

### 為什麼是這套（優點）

1. **量級誠實**：題庫是百～千題級。pgvector 暴力掃描就夠快，連 ANN 索引都還不用開。
2. **關聯條件與向量檢索必須在同一句 SQL**——這是決定性理由。「排除這個學生做過的題（`NOT EXISTS attempts`）、排除同一變式家族、鎖定難度、排除已封存」全是關聯條件；向量庫放外面就得 over-fetch 回來過濾或維護兩份真相，放同一個 PG 一句 SQL 完事，交易一致性免費拿到。
3. **hybrid 是量出來的**：Recall@5 純 `LIKE` 0.875 → hybrid **1.000**。向量抓「換個數字的同一題」，全文抓專有名詞與符號，互補。
4. **RRF 零校準**：兩路分數量綱不可比（餘弦 vs 全文 rank），加權融合要先正規化再調權重；RRF 只看名次，對分數分佈魯棒。
5. **一人維運**：不加任何新服務——PG 本來就要，向量能力是一個 extension。

### 缺點（誠實列）

- **規模上限**：千萬向量級要上 HNSW/IVFFlat 調參，再上去 pgvector 不如專用向量庫。
- **RRF 稀釋強信號**：實測 MRR 純向量 0.9575 > hybrid 0.824（名次融合把正確題偶爾從第 1 擠到第 2–3）。本場景要 recall（老師自己挑），可接受；若場景變成「只回第一名」，這個決策要重開。
- **中文分詞在應用層**（PG 原生沒有好用的中文分詞、`zhparser`/`pg_jieba` 在 Windows/Docker 維運痛苦）：代價是換分詞器＝全文側全部重建，所以全案凍結唯一分詞器 `utils/tokenize.js`。
- **embedding 模型升級＝向量全欄重灌**＋cassette 全部重錄（`scripts/backfill_embeddings.js` 為此存在；cassette 鍵含模型 ID 是刻意的——否則「數字是舊模型量的」會靜默混進報表）。

### 替代方案：各自的優缺點、為什麼不選

| 方案 | 它的優點 | 它的缺點 | 為什麼不選 |
|---|---|---|---|
| **專用向量庫**（Pinecone／Milvus／Qdrant／Weaviate） | 億級向量、ANN 成熟、託管免維運 | 多一個服務或月費；關聯過濾要 metadata filter 或 over-fetch；與 PG 兩份真相要同步 | 量級差三個數量級；「排除做過的題」這種 join 是**核心需求**，拆兩個庫自找麻煩 |
| **FAISS／記憶體索引** | 最快、零外部服務 | 無持久化、無過濾語意、重啟重建、與資料庫脫節 | 一人專案要「開機就能用」；過濾需求同上 |
| **Elasticsearch／OpenSearch** | 全文檢索最強、也有 kNN | JVM 重、維運重、中文仍要分詞插件 | 為了全文檢索抬一頭大象進來，不成比例 |
| **純向量、不做 hybrid** | 少一路、簡單 | 專有名詞／公式符號的精確匹配會漏 | 量測說 hybrid recall 更好（0.97→1.000），多一路 SQL 成本近零 |
| **Cross-encoder rerank** | 精度上限更高 | 每對 query-doc 一次模型呼叫：延遲＋成本 | Recall@5 已 1.000，沒有留給 reranker 的空間；檢索層是獨立 SQL，規模大了隨時插得進 |
| **微調（fine-tune）** | 知識內化、推理時免檢索 | 資料量遠不夠；新題要重訓；無法溯源「為什麼推這題」 | 題庫天天在長——RAG 新題入庫即刻可檢索，且回傳餘弦與命中側，可解釋 |
| **LangChain／LlamaIndex retriever** | 起步快、換組件容易 | 抽象層藏住 SQL 與錯誤；版本翻新快；行為難被測試釘住 | 本案原則「協調層是程式碼」：一段手寫 SQL 同時服務 API 與 eval，CI 能釘死它 |

### 量測數字（`npm run eval -- --suite retrieval`，golden 40 筆人工定案）

| 指標 | LIKE（舊基準） | 純向量 | hybrid（RRF） |
|---|---:|---:|---:|
| Recall@5 | 0.875 | 0.97 | **1.000** |
| Recall@10 | 0.92 | 0.97 | **1.000** |
| MRR | 0.738 | **0.9575** | 0.824 |

NLQ（50 句 golden）：rules 路徑 coverage 0.84／filters_exact 1.000／recall@10 1.000；LLM 路徑 filters_exact 0.75／recall@10 0.875。門檻＝首測 −0.03 寫入 `eval/thresholds.json`，只升不降（ratchet），退步 CI 就轉紅。

---

## 🤖 技術選型 ②：多 Agent 協作——用什麼、為什麼、優缺點、為什麼不選別的

### 改造前的問題（本 repo 的 git 歷史，不是假想敵）

舊版是**一個巨型 prompt** 拆整份 PDF：無 schema、無重試、`JSON.parse` 完就回，一題壞掉**整批 400**（實際發生過）；章節白名單在 prompt 手抄一份、與程式兩份真相；答案是拆題模型自己抄的，抄錯了沒有第二來源能發現。

### 選了什麼：程式碼編排的管線式多 Agent

```
POST /api/jobs (PDF)
   ▼
jobs 狀態機（PostgreSQL）：queued → extracting → processing → done/failed
每題一列 job_questions：extracted → hashed → classified → linted → verified → deduped
                        → saved ／ needs_review ／ rejected
   ▲ 認領：FOR UPDATE SKIP LOCKED + 租約（斷點續跑）；每節點逾時/退避重試/RPM 節流/成本上限
workers/jobRunner.js
   ├─ extract   拆題（flash＝便宜模型）
   ├─ classify  分類（零成本閘門 → kNN 投票短路 → 才叫 LLM）
   ├─ lint      公式修復
   ├─ verify    獨立解題驗證（pro＝強模型，與拆題不同模型互相制衡）
   └─ dedup     兩段去重（雜湊 → 向量餘弦）
   ▼ 節點之間全是伺服器端硬閘門（ajv schema、白名單、正規化、答案比對）
過不了 → 逐題重試（機器 feedback 餵回 prompt）→ 預算用盡 → needs_review（八種原因之一）
結果：部分入庫——90 題裡 3 題有問題，87 題照樣入庫，3 題帶著具體原因排隊等人
```

每個 agent 是**純函式合約**：不碰 DB、不讀環境變數、LLM 只走注入的 `ctx.llm`、輸出被 JSON Schema 鎖死——所以單元測試不用 mock 資料庫、cassette 回放鍵可重現、換編排方式不用動 agent。

### 為什麼這樣設計（優點）

1. **prompt 不是保證，伺服器端驗證才是**——每道閘門是普通程式碼，可以被 1,415 個單元測試釘住。
2. **不確定性關進單步驟**：流程（順序、重試、預算、逾時）是確定性狀態機，可重跑、可觀測（`job_events` 逐步記錄含成本）、租約到期自動被別的槽接手。
3. **協作＝互相制衡，不是開會**：verify 用**不同模型**獨立重算答案再比對（單一模型抄錯會錯得像模像樣）；kNN 投票只認**人工確認過**的標籤（自動標籤餵回自動投票是閉環放大器）。
4. **成本工程是設計的一部分**：閘門「便宜的先做」（文字比對 → embedding → 才是 LLM）；檢索命中就不生成；kNN 高信心短路整個 LLM 呼叫；模型路由（flash 拆題／pro 只用在驗證）；job／日成本上限＋逐 token 記帳。
5. **可測**：CI 以 record/replay cassette 零成本、零網路、**確定性**地跑完整條管線；replay miss 在 main 上是錯誤。

### 缺點（誠實列）

- 前期程式碼量大：狀態機、閘門、eval 基建全手寫，比套框架慢熱。
- 剛性：加一個節點要動 DDL CHECK、契約、閘門、測試。
- 逐題逐節點序列推進，吞吐靠 job 併發撐；十倍量級後 PG 佇列要重新評估。
- 模型一換 cassette 全部重錄（誠實的代價：cassette 鍵含模型 ID）。

### 替代方案：各自的優缺點、為什麼不選

| 方案 | 它的優點 | 它的缺點 | 為什麼不選 |
|---|---|---|---|
| **單一巨型 prompt**（改造前） | 最省事、一次呼叫 | 無部分成功、無法歸因哪步錯、無模型路由、context 上限；實際發生過整批 400 | 這正是要解掉的東西 |
| **LLM 當編排者**（AutoGPT 式自主迴圈） | 靈活、能處理未設想的流程 | 控制流不確定 → 不可測、成本無上界、失敗不可重現、debug 靠通靈 | 拆題流程**已知且固定**——用不確定性換一個不需要的靈活度，純虧（但見下方助教：流程未知時我們真的用了它） |
| **框架**（LangChain／LangGraph／CrewAI／AutoGen） | 起步快、生態多；LangGraph 也有圖狀態機 | 抽象層藏 prompt 藏錯誤；版本翻新快；圖狀態要另做持久化才能斷點續跑；行為難被測試釘住 | 自寫狀態機落在 PG：**持久化與併發認領（SKIP LOCKED）免費拿到**；薄的自有 LLM 層才做得了 cassette replay CI |
| **專業佇列**（BullMQ+Redis／Celery／Kafka） | 吞吐、重試機制成熟 | 多一個 broker 要維運；與業務資料不同交易 | 一人 Windows 專案；PG `FOR UPDATE SKIP LOCKED` 是同量級標準解，且認領與寫回同交易 |
| **多模型辯論／委員會** | 精度可再擠 | 成本 ×N | 只在**最值錢的一步**做雙來源（驗答案換模型重算），其餘用確定性閘門制衡，性價比更高 |
| **雲端託管 agent 平台** | 免維運 | 題庫（私有資產）出境、綁定、成本 | 資料與閘門留本地，只有 LLM 呼叫出去 |

### 兩種編排哲學並存：對話式助教（階段 4）

上面的立場是「流程已知 → 編排交給程式碼」。階段 4 補上對照組——**對話式助教**（`services/assistantService.js`）：使用者問題的形狀未知（「小明最弱的章節？」「幫小華預覽一張卷」），這裡編排交給**主控 LLM**，它自行決定叫哪個工具、叫幾次、何時收尾（ReAct 迴圈），工具調用軌跡直接攤在 UI 上。

| | 拆題管線 | 對話式助教 |
|---|---|---|
| 流程 | 已知且固定 | 未知、由問題決定 |
| 編排者 | 程式碼狀態機 | 主控 LLM |
| 每步輸出 | 各 agent 的 schema | 受限 JSON `{action, tool, args_json, reply}` |
| 寫入權 | 有（過閘門才寫、部分入庫） | **零**——五個工具全只讀；出卷只能 dry-run 預覽，真出卷仍由人按確認 |
| 失敗語意 | 重試預算 → needs_review | 工具錯誤餵回主控自行修正；步數上限截斷 |

三個實作決策（面試常被追問）：①**不用供應商原生 function calling**——用 responseJsonSchema 鎖出決策迴圈，record/replay、節流、未來異家 adapter 全部免費繼承；②**參數走 `args_json` 字串**——實測 Gemini structured output 對沒有 properties 的自由物件會吐空 `{}`；③**「空結果就是答案」寫進系統提示**——否則主控會把步數全花在同義詞重試上。三條底線不變：受限 JSON、工具只讀、執行前伺服器端驗證。

### 量測數字（Agent 側，replay 對 golden）

| 指標 | 數字 | 門檻（ratchet） |
|---|---:|---:|
| pipeline saved_rate（部分入庫成功率） | 0.90 | ≥0.87 |
| pipeline gate_pass_rate | 1.00 | ≥0.97 |
| answer_agree_rate（雙模型驗答一致率） | 0.90 | ≥0.87 |
| classify accuracy / macro-F1 | 0.9000 / 0.9256 | 已建門檻 |
| variant retrieved_coverage / gate_pass_rate | 0.8667 / 0.25 | ≥0.8367 / ≥0.22 |

> 變式 gate_pass_rate 0.25 附帶一個誠實的故事：跑題閾值最初用「現成題對」校準成 0.92，第一次真實錄製才發現校準的正類（只換數字）恰好是另一道閘門要退回的東西——依實測分佈下修 0.90 並重錄（裁決 S3-R29）。**量測驅動的意義不是數字好看，而是錯了看得見。**

---

## 🧭 設計決策（為什麼這樣做）

以下三個決策決定了專案的形狀。共同主線是：**先確認這個系統的硬約束是什麼，再看現成工具剛好不滿足哪一條。**

### 1️⃣ 為什麼自己刻 LaTeX → OOXML，而不用 pandoc？

pandoc 是文件轉換的業界標準，一行指令就能把 LaTeX 轉成 `.docx`。本專案仍在 [`exam_pro/utils/textFormatter.js`](./exam_pro/utils/textFormatter.js) 自製了 tokenizer + 遞迴下降解析器，理由是：

- **輸入不是一份 LaTeX 文件**。資料是 DB 裡一列列的題目，內容為「中文敘述混雜行內 `$...$` 片段」；`buildParagraphComponents` / `renderMixedInto` 處理的正是中英數混排，而 pandoc 的單位是整份文件。
- **交付物需要程式化組裝**。[`wordService.js`](./exam_pro/services/wordService.js) 要控制標題階層、藍色題號、`★` 難度、換頁、答案區紅字與遠端圖片插入——這些由 `docx` 的物件模型逐段建構，交給 pandoc 產檔後就無法再回頭插入。
- **pandoc 是外部二進位相依**。Node 伺服器需每次請求 `spawn` 一次，部署環境還得額外安裝執行檔；現行方案零外部相依。
- **中介方案試過並淘汰**。原型 `exam/server.js` 走 `temml`：LaTeX → MathML → 以字串包上 `<m:oMathPara>` 命名空間灌進 `MathXml`，本質是「MathML 標籤穿 OOXML 外衣」，Word 不保證接受。重構版改為直接建構 `docx` 原生數學物件（`MathFraction`、`MathRadical`、`MathSum`、`MathSubSuperScript` …），產出**可用 Word 方程式編輯器開啟編輯的真・直式分數**，正對應本專案的核心約束。
- **輸入域是受控的**。AI prompt 已將可用語法限縮為高中數理子集，因此無須覆蓋完整 LaTeX；未知指令會退化為純文字（`parseCommand` 末段），單一公式失敗不會導致整份考卷打包失敗。

> **權衡**：pandoc 的 LaTeX 覆蓋率遠勝本解析器。此處換得的是「部署零相依 + 版面完全可控 + 失敗可局部降級」，代價是僅支援語法子集。

### 2️⃣ 為什麼 AI 輸出要做白名單約束？

Gemini 已回傳 JSON，為何不直接入庫？

- **LLM 輸出是自然語言，不是型別化的 API**。同一份考卷，模型可能寫 `圓方程式`、`圓的方程式` 或 `圓與直線`。章節名一旦漂移，**組卷功能即失效**——[`examController.js`](./exam_pro/controllers/examController.js) 是以 `WHERE subject = ? AND chapter = ?` 精確比對抽題的，名稱不統一等同題庫變成撈不出來的資料。
- **兩層防線，職責不同**：

  | 層 | 位置 | 性質 |
  |---|---|---|
  | 軟約束 | [`aiService.js`](./exam_pro/services/aiService.js) prompt 內列出完整章節白名單 | 是「請求」，模型可以不照做 |
  | 硬約束 | [`config/chapters.js`](./exam_pro/config/chapters.js) + `questionController.batchSaveQuestions` 逐題驗證 | 是入庫的門，不合格即擋下 |

  關鍵論點：**prompt 不是保證，只有伺服器端驗證才是。**
- **約束不只章節**。`question_type` 限五種、`difficulty` 經 `normalizeDifficulty` 收斂為 1–5 整數、LaTeX 強制 `\frac{}{}` 而非斜線——最後這條是為了餵給第 1 點的解析器，**兩個模組的約束刻意互相對齊**。
- **安全視角**：AI 輸出屬不可信輸入，且會落地為 DB 資料、再流入 XML 產生流程，不能當受信任來源處理。

> **權衡（已於階段 2 解決）**：早期版本一題不合格即整批退回；現在是**部分入庫**——合格的照樣寫入，不合格的帶著具體原因進人工複核佇列（見下方技術選型 ②）。

### 3️⃣ exam → exam_pro 重構到底改了什麼？

兩個資料夾功能相近，差異在**行為**而非目錄長相（375 行單檔 → 約 1,400 行分層）：

| 面向 | `exam`（原型） | `exam_pro`（重構版） |
|---|---|---|
| 架構 | 全部集中於 `server.js` | `app.js`/`server.js` 分離 + `config`/`controllers`/`services`/`middleware`/`routes`/`utils` |
| 公式引擎 | temml → MathML → 字串包裝的 OMML | 自製 tokenizer + 遞迴解析器 → `docx` 原生 Math 物件 |
| 靜態檔 | `express.static(__dirname)`，**整個專案目錄對外**（含 `server.js`、`schema.sql`、`.env`） | 只公開 `public/`，且 `index: false`，由路由注入前端設定 |
| 認證 | 無 | `x-api-key` + `crypto.timingSafeEqual`（防時序攻擊） |
| CORS | 無 | `ALLOWED_ORIGINS` 白名單 |
| 資料驗證 | 僅在 prompt 中要求 | 伺服器端白名單硬驗證 |
| SSRF | 直接 fetch 題目圖片 URL | `isSafeImageUrl` 阻擋 localhost／內網／保留 IP，並限 5 MB 與 content-type |
| 成本控制 | 無 | `/analyze-pdf` 每來源每分鐘 10 次限流 |
| 交易一致性 | 無 | 組卷與作答歷史更新包於 transaction，失敗全數回滾 |
| 錯誤處理 | 無 | 全域錯誤中樞；正式環境不回傳錯誤細節 |
| 其他修正 | — | 組卷日期時區（`toISOString()` 為 UTC，台灣早上 8 點前會差一天）、題庫列表分頁、`uploads` 開機清理、選擇題答案帶選項代號 |

> **最具體的一例**：原型的 `app.use(express.static(__dirname))` 會把含 `GEMINI_API_KEY` 的 `.env` 一併當靜態檔案對外提供。
> 重構的價值不在目錄變好看，而在於把一個「會外洩金鑰、AI 額度可被無限刷、章節名各寫各的」原型，變成可以真的對外部署的系統。

---

## 🧰 技術棧

- **後端**：Node.js 24 · Express 5 · PostgreSQL 16 + pgvector（Docker；2026-08-21 由 MySQL 切換，runbook 見 [`docs/cutover-runbook.md`](./docs/cutover-runbook.md)）
- **AI**：Google Gemini（`@google/genai`）——拆題／分類／變式 `gemini-3.5-flash`、獨立驗答 `gemini-3.1-pro-preview`、embedding `gemini-embedding-001`（768 維）；模型 ID 單一真相在 [`exam_pro/config/models.js`](./exam_pro/config/models.js)
- **文件**：`docx`（自製 LaTeX → OOXML 數學公式轉換）
- **前端**：單頁 HTML + Tailwind（CDN）+ MathJax + 五個 ES module 分頁（零打包器）
- **測試／量測**：`node:test`（單元 1,415／整合 259／e2e 11）＋五個 eval suite（golden＋ratchet 門檻）＋ LLM record/replay cassette——CI 全程零金鑰、零網路、零成本

---

## 🧪 品質保證的三層（怎麼測一個 LLM 系統）

1. **合約單測**：agent 是純函式（依賴全注入），1,415 項不連網不連庫，任何人 clone 下來 `npm test` 就能看到結果。
2. **cassette record/replay**：真實呼叫錄下（鍵含模型 ID＋模板版本＋輸入雜湊），CI 以 replay **確定性**重播完整管線；replay miss 在 main 上是錯誤——「cassette 被誤刪」不准表現成綠燈。
3. **eval golden + ratchet**：五個 suite 對人工定案的 golden 量指標，門檻＝首測 −0.03、只升不降；任何改動讓指標掉到門檻下，CI 轉紅。

每個功能的「問題 → 決策 → 數字」逐條對照表（含量測日期、模型 ID、commit）在 [`exam_pro/README.md`](./exam_pro/README.md) 的「問題 → 決策 → 數字」章。

---

## 🚀 快速開始（exam_pro）

```bash
cd exam_pro
npm install
cp .env.example .env      # 填入 GEMINI_API_KEY（DATABASE_URL 預設值即可用）
npm run db:up             # Docker 起 PostgreSQL 16 + pgvector（開發 5442 / 測試 5433）
npm run migrate           # 套用 migrations/
npm start                 # http://localhost:3000
```

完整安裝步驟、環境變數表、API 一覽與維運工具說明，請見 **[`exam_pro/README.md`](./exam_pro/README.md)**。

---

## 🔐 安全注意事項

- 對外部署 `exam_pro` 時務必設定 `ALLOWED_ORIGINS` 並將 `NODE_ENV=production`。
  ⚠️ `API_KEY` 會被注入前端頁面，**不等同存取控制**，詳見 [`exam_pro/README.md`](./exam_pro/README.md#-安全注意事項)。
- 金鑰請妥善保管；若曾外流，請至 [Google AI Studio](https://aistudio.google.com/apikey) 重新產生。

---

## 📄 授權與著作權

### 程式碼
本專案**程式碼**採 **[Apache License 2.0](./LICENSE)** 釋出。
你可自由使用、修改與散布（含商用），惟須保留版權與授權聲明。

### ⚖️ 題目內容（重要）

| | 說明 |
|---|---|
| **本 repo 不含題庫資料** | 沒有任何考卷、試題或其掃描檔。開發期間用於測試的實體考卷 PDF、題庫備份 JSON、維運報告產物與含逐字試題的一次性腳本，**均未收錄、已自版本歷史完全移除，並由 `.gitignore` 持續排除**（同時排除 `.env`、`node_modules/`、`uploads/` 與大型二進位素材）。 |
| **示範題為自製** | `exam_pro/seed_questions.js` 的 30 題係為展示流程自行編寫的常見教科書型例題，不取自任何特定考卷或出版品。 |
| **使用者自負責任** | 本系統用於管理**使用者自身合法擁有或有權使用**的題目。經 PDF 解析匯入的內容，著作權仍屬原著作權人，不因匯入而移轉。匯入前請自行確認已取得合法權源（自行創作、取得授權，或符合著作權法合理使用要件）。 |

完整聲明見 **[`NOTICE`](./NOTICE)**。

© 2026 Ben Yang (楊本顥)
