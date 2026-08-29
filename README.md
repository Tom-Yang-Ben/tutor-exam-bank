# tutor-exam-bank · 家教專用數理題庫系統（多 Agent × RAG）

[![CI](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml)

> 作者自用的家教出題系統：上傳考卷 PDF 後，由多 Agent 管線自動拆題入庫；
> 組卷時依作答紀錄排除學生已練習的題目，並匯出含 Word 原生方程式的 `.docx` 考卷。
> 在此基礎上另建 RAG 檢索（相似題、自然語言查題）與具備工具調用能力的對話式助教。

本儲存庫保留完整的開發歷程：早期原型（`exam/`）、重構後的系統本體與四個階段的演進（`exam_pro/`），以及全部設計文件與決策紀錄（`docs/`）。

> ⚖️ 本儲存庫為作者的個人工具與技術作品集：**保留所有權利，僅供瀏覽與技術評估，不授權使用**（見 [`LICENSE`](./LICENSE)）。儲存庫不含任何題庫或考卷內容，示範題與 eval 素材均為作者自行編寫（見 [`NOTICE`](./NOTICE)）。

---

## 🖥️ 操作介面

![家教專用數學物理題庫系統操作頁面](./screenshots/operation-page.png)

---

## 🎯 問題背景與設計目標

**使用者**：一對一數理家教老師（高中數學／物理），手上有大量歷屆考卷 PDF，需要為每位學生客製特訓卷。

**痛點**：出卷的行政損耗遠大於教學本身。複雜公式（直式分數、根式、幾何圖）在 Word 手動排版容易跑位；題目散在各份考卷裡，哪個學生寫過哪題無從追蹤，重複出題傷害練習效果。一份特訓卷常花 **2 小時以上**。

**目標**：出一份卷從 2 小時縮短到幾分鐘，把心力留給一對一指導本身。

**第二個目標（階段 2 起）**：在同一個實際運作的產品上，將**多 Agent 協作**與 **RAG 檢索**落實為可檢視、可量測、可逐行驗證的工程實作。本 README 的兩章技術選型即為此目標的完整說明。

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

四個階段由四條平行 workstream（git worktree）同步施工，以「介面凍結＋裁決」制度整合：介面於開工前凍結為契約，開發期間的疑義以編號裁決回覆並記入文件。全部裁決見 [`docs/interfaces*.md`](./docs)，交接紀錄見 [`docs/HANDOFF.md`](./docs/HANDOFF.md)。

---

## 🗂 資料夾與檔案地圖（完整版）

### repo 根目錄

| 位置 | 內容 |
|---|---|
| **[`exam_pro/`](./exam_pro)** | 🌟 **主要成品**——可執行的系統本體（下表展開） |
| [`exam/`](./exam) | 早期原型（ARCHIVED）：單檔 `server.js`，保留當重構前後對照與 A-T16 基準 |
| [`docs/`](./docs) | 全部設計文件：規劃、凍結介面與裁決、技術選型、交接檔；已結案的協調文件歸檔於 `docs/archive/`（下表展開） |
| [`screenshots/`](./screenshots) | README 用截圖 |
| [`期中專題報告/`](./期中專題報告) | 開發紀實簡報（HTML，請下載後用瀏覽器開啟） |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | CI：unit（Node 22/24 矩陣）＋ integration（起 pgvector service → migrations → 整合測試 → e2e → 五個 eval suite） |
| [`LICENSE`](./LICENSE) / [`NOTICE`](./NOTICE) | 版權所有、僅供瀏覽評估（不授權使用）／題目內容權利聲明 |

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
│   ├─ figureService.js       #   附圖裁切（extract bbox → mupdf 渲染＋sharp 裁圖；詳 docs/figures.md）
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
│   ├─ index.html             #   單頁殼＋題庫/組卷 inline script＋5 個 hash 路由視圖（分頁錨點折入視圖）
│   └─ js/                    #   ES modules：review / students / nlq / variants / assistant
│
├─ migrations/ + migrate.js   # 只增不改的 SQL（0001 init → 0007）＋極簡執行器
├─ eval/                      # 量測體系
│   ├─ run.js                 #   五個 suite：retrieval / classify / pipeline / nlq / variant
│   ├─ lib/                   #   指標、golden loader、pg engine、pipeline driver、門檻 ratchet
│   ├─ golden/                #   人工定案的答案卷（自製內容）
│   ├─ cassettes/             #   LLM 回應錄放帶（只存摘要與雜湊，不存 PDF 原文）
│   ├─ fixtures/              #   60 題自製 fixture、樣卷 PDF、embedding 向量
│   └─ thresholds.json        #   門檻（首測 −0.03、只升不降）
│
├─ test/
│   ├─ unit/                  #   1,449 項：不連網、不連庫、零 secrets
│   ├─ integration/           #   261 項：對 tmpfs 測試庫（_test 後綴強制）
│   └─ e2e/                   #   11 項：HTTP 全路徑（上傳→部分入庫；組卷→Word 公式）
│
├─ scripts/                   # 維運：備份、向量回填、成本報表、公式健檢
├─ docs/                      # README 介面截圖（題目為自編示範內容，不含真實考卷）
├─ seed_questions.js          # 30 題自製種子（4 章 × 7~8 題，含單章密度自檢）
├─ docker-compose.yml         # PG16+pgvector：5442 開發（volume）／5433 測試（tmpfs）
└─ *.bat                      # Windows 雙擊工具（啟動資料庫／備份／公式健檢…）
```

### `docs/`（設計文件）

| 檔案 | 內容 |
|---|---|
| [`roadmap-plan.md`](./docs/roadmap-plan.md) | 六章總規劃：排程、資料層、Agent 管線、產品面、橫切、階段 4 產品收斂（作法／理由／替代方案／驗收；§6 含 S4-1～S4-4 與對話式助教） |
| [`interfaces-stage1.md`](./docs/interfaces-stage1.md) ／ [`-stage2`](./docs/interfaces-stage2.md) ／ [`-stage3`](./docs/interfaces-stage3.md) | 三份**凍結介面**與全部裁決（階段 1 裁決 1–27、S2-1～30、S3-1～R29）——平行開發的契約 |
| [`rag-and-agents.md`](./docs/rag-and-agents.md) | RAG 與多 Agent 技術決策全紀錄（本 README 技術選型章的完整版） |
| [`variants.md`](./docs/variants.md) ／ [`retrieval.md`](./docs/retrieval.md) ／ [`llm.md`](./docs/llm.md) | 變式題九道閘門與閾值校準／檢索設計／LLM 層 |
| [`HANDOFF.md`](./docs/HANDOFF.md) | 交接檔：角色、狀態、標準流程、踩過的坑 |
| [`archive/`](./docs/archive) | 已結案的歷史紀錄：`cutover-runbook.md`（MySQL→PG 切換之夜，2026-08-21 已執行）、`stage*-parallel-prompts.md` ／ `questions*-ws*.md`（四條平行 workstream 的分工提示詞與提問裁決）——**多人（多 agent）協作制度的完整紀錄**，索引見該資料夾 README |

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

## 🔍 技術選型 ①：RAG——採用的技術、選型理由與替代方案評估

> 詳細版本（含檔案對照與延伸問答）見 [`docs/rag-and-agents.md`](./docs/rag-and-agents.md)。本節為可獨立閱讀的摘要；所有數據均出自 `eval/` 的實際量測。

### RAG 的落點：四個功能、同一個檢索層

檢索層為單一 SQL 模組（`exam_pro/queries/hybrid.js`），由以下四個功能共用：

| 落點 | 檢索內容 | 用途 |
|---|---|---|
| **相似題** | 與指定題目同科、餘弦相似度最高的題目 | 不經生成，檢索結果即為產品功能（錯題 →「找相似」） |
| **變式題的檢索優先策略** | 先於題庫檢索相似度 ≥ 0.80 的同難度題目，數量足夠即直接推薦，不產生生成費用；不足時才進入生成，並以藍本與前 5 題鄰居作為 prompt 錨點；生成後再以相似度 ≥ 0.90 驗證是否偏離原題主題 | 生成結果貼近題庫風格，多數請求無 LLM 費用 |
| **檢索式 few-shot 分類** | 自題庫取 k=8 最近鄰作為分類範例；最近 5 鄰中有 4 題以上為人工確認的同一章節、且最近鄰相似度 ≥ 0.90 時，直接採用該結果而不呼叫 LLM | 分類範例隨題庫成長更新；高信心情境以檢索取代 LLM 呼叫 |
| **自然語言查題** | 規則層先解析章節、難度、學生等條件，餘下的概念文字經 embedding 進入 hybrid 檢索；設有四級回退階梯 | 將口語查詢轉為結構化查詢；解析結果回寫至篩選介面，供使用者檢視與修正 |

### 採用的技術

PostgreSQL 16 + pgvector（`gemini-embedding-001`，768 維，L2 正規化後餘弦相似度等值於內積）；全文檢索於應用層以 jieba 分詞建立；兩路結果以 **RRF（Reciprocal Rank Fusion，k=60）** 融合。

### 選型理由

1. **資料規模**：題庫為數百至數千題。此規模下 pgvector 的精確搜尋已足夠快，尚無建立 ANN 索引的必要。
2. **關聯條件與向量檢索必須位於同一查詢**（本選型的決定性因素）。「排除該學生已作答的題目（`NOT EXISTS attempts`）」「排除同一變式家族」「限定難度」「排除已封存」皆為關聯式條件。向量庫若為獨立服務，須先超額撈取再於應用層過濾，並維護兩份需同步的資料；置於同一個 PostgreSQL 中，單一查詢即可完成，且自然取得交易一致性。
3. **hybrid 的效益經量測驗證**：Recall@5 由純 `LIKE` 的 0.875 提升至 1.000。向量側可召回「僅數值不同的同型題」，全文側可精確匹配專有名詞與符號，兩者互補。
4. **RRF 無需分數校準**：餘弦相似度與全文檢索排名分數的量綱不可直接比較，加權融合須先正規化再調整權重；RRF 僅依名次融合，對分數分佈不敏感。
5. **維運前提**：本專案由單人維護，不引入額外服務。PostgreSQL 為既有相依，向量能力僅需啟用 extension。

### 已知限制

- **規模上限**：向量數達千萬級時需建立 HNSW／IVFFlat 索引並調參；更大規模應重新評估專用向量庫。
- **RRF 對強信號的稀釋**：實測 MRR 純向量為 0.9575，高於 hybrid 的 0.824——名次融合使正確結果偶爾自第 1 名移至第 2–3 名。本系統的使用情境（出卷前產生候選清單、由使用者挑選）以 recall 為優先，此代價可接受；若情境改為僅取第一名，此決策應重新評估。
- **中文分詞位於應用層**：PostgreSQL 缺乏成熟的內建中文分詞，`zhparser`／`pg_jieba` 為 C extension，於 Windows／Docker 環境維運成本高。代價是更換分詞器時全文索引須整批重建，因此 `utils/tokenize.js` 被凍結為全案唯一分詞器。
- **embedding 模型升級**需重灌全部向量欄位並重錄 cassette（`scripts/backfill_embeddings.js` 即為此準備）。cassette 鍵包含模型 ID 為刻意設計，避免以舊模型量測的數據混入報表。

### 替代方案評估

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **專用向量庫**（Pinecone／Milvus／Qdrant／Weaviate） | 支撐億級向量、ANN 成熟、可託管 | 增加一項服務或訂閱成本；關聯過濾依賴 metadata filter 或超額撈取；與 PostgreSQL 形成兩份需同步的資料 | 資料規模相差三個數量級；「排除已作答題目」等 join 條件為核心需求，分離儲存顯著增加複雜度 |
| **FAISS／記憶體內索引** | 速度最快、無外部服務 | 無持久化、無過濾語意、行程重啟需重建、與資料庫脫節 | 單人專案要求開機即用；過濾需求同上 |
| **Elasticsearch／OpenSearch** | 全文檢索能力最強、亦支援 kNN | JVM 資源需求高、維運負擔重、中文仍需另裝分詞插件 | 引入成本與本專案的全文檢索需求不成比例 |
| **純向量檢索** | 架構較簡 | 專有名詞與符號的精確匹配易有遺漏 | 量測顯示 hybrid 的 recall 較佳（0.97 → 1.000），而增加一路 SQL 的成本極低 |
| **Cross-encoder 重排** | 精度上限更高 | 每組 query-document 需一次模型呼叫，增加延遲與費用 | Recall@5 已達 1.000，重排無改善空間；檢索層為獨立 SQL 模組，規模擴大時可直接加入 |
| **微調（fine-tuning）** | 知識內化、推論時無需檢索 | 訓練資料量不足；新增題目需重訓；無法解釋推薦依據 | 題庫持續成長，RAG 使新題入庫後立即可檢索，且回傳相似度與命中來源，具可解釋性 |
| **LangChain／LlamaIndex 的 retriever 抽象** | 上手快、組件可替換 | 抽象層遮蔽 SQL 與錯誤細節；版本演進快；行為難以被測試固定 | 專案原則為「協調層是程式碼」：同一段 SQL 同時服務 API 與 eval，其行為可被 CI 固定 |

### 量測結果（`npm run eval -- --suite retrieval`；golden 40 筆，人工定案）

| 指標 | LIKE（改造前基準） | 純向量 | hybrid（RRF） |
|---|---:|---:|---:|
| Recall@5 | 0.875 | 0.97 | **1.000** |
| Recall@10 | 0.92 | 0.97 | **1.000** |
| MRR | 0.738 | **0.9575** | 0.824 |

NLQ（50 句 golden）：規則路徑 coverage 0.84、filters_exact 1.000、recall@10 1.000；LLM 路徑 filters_exact 0.75、recall@10 0.875。門檻取首次量測值減 0.03 寫入 `eval/thresholds.json`，此後僅升不降（ratchet）；任何改動使指標低於門檻時 CI 即失敗。

---

## 🤖 技術選型 ②：多 Agent 協作——採用的架構、設計理由與替代方案評估

### 改造前的狀態（本儲存庫的實際歷史版本）

改造前的拆題功能為單一大型 prompt 處理整份 PDF：無 schema 驗證、無重試機制，`JSON.parse` 成功即回傳——曾實際發生單一題目格式錯誤導致整批請求以 400 失敗的事故。章節白名單在 prompt 與程式中各維護一份，兩處逐漸不一致；答案由拆題模型自行抄錄，抄錄錯誤時缺乏第二來源可供比對。

### 採用的架構：程式碼編排的管線式多 Agent

```
POST /api/jobs (PDF)
   ▼
jobs 狀態機（PostgreSQL）：queued → extracting → processing → done/failed
每題一列 job_questions：extracted → hashed → classified → linted → verified → deduped
                        → saved ／ needs_review ／ rejected
   ▲ 認領：FOR UPDATE SKIP LOCKED + 租約（可斷點續跑）；各節點設逾時、退避重試、RPM 節流、成本上限
workers/jobRunner.js
   ├─ extract   拆題（flash，成本較低的模型）
   ├─ classify  章節分類（零成本閘門 → kNN 投票短路 → 必要時才呼叫 LLM）
   ├─ lint      公式修復
   ├─ verify    獨立解題驗證（pro，與拆題不同的模型）
   └─ dedup     兩段去重（正規化雜湊 → 向量相似度）
   ▼ 節點之間均為伺服器端硬閘門（ajv schema、白名單、正規化、答案比對）
未通過 → 逐題重試（將機器產生的 feedback 併回 prompt）→ 預算用盡 → needs_review（八種原因之一）
結果：部分入庫——一批 90 題中若 3 題有疑慮，其餘 87 題照常入庫，3 題附具體原因進入人工複核佇列
```

每個 agent 均為純函式合約：不存取資料庫、不讀取環境變數、LLM 呼叫僅透過注入的 `ctx.llm`、輸出以 JSON Schema 驗證。此合約使單元測試無需 mock 資料庫、cassette 回放鍵可重現，且更換編排方式時無需修改 agent 本身。

### 設計理由

1. **prompt 不構成保證，伺服器端驗證才是**：每道閘門均為一般程式碼，其行為由 1,449 項單元測試固定。
2. **將不確定性限制在單一步驟內**：流程（節點順序、重試、預算、逾時）為確定性狀態機——可重跑、可觀測（`job_events` 逐步記錄，含成本），租約到期後由其他 worker 接手續跑。
3. **協作的形式是相互驗證，而非模型間的自由對話**：verify 節點以不同模型獨立重解題目並比對答案——單一模型抄錯答案時，錯誤內容往往格式正確、無從自行察覺；kNN 投票僅採計人工確認的標籤——若允許自動產生的標籤參與投票，錯誤分類將經由迴圈自我強化。
4. **成本控制內建於架構**：閘門依成本由低至高排序（文字比對 → embedding → LLM）；檢索命中即不進入生成；kNN 信心足夠時跳過 LLM 呼叫；模型路由（拆題用 flash、驗答用 pro）；並輔以單一 job 與每日成本上限、逐 token 計費紀錄。
5. **可測試性**：CI 以 record/replay cassette 在零費用、零網路的條件下確定性地重播完整管線；replay miss 於 main 分支視為錯誤。

### 已知限制

- 前期建置成本高：狀態機、閘門、eval 基礎設施皆為手寫，初期投入高於採用現成框架。
- 擴充彈性較低：新增節點需同步修改 DDL 的 CHECK 約束、契約、閘門與測試。
- 題目依節點順序逐步推進，吞吐量依賴 job 並行數；處理量增加十倍以上時，PostgreSQL 佇列方案應重新評估。
- 更換模型需重錄全部 cassette（cassette 鍵包含模型 ID，為刻意設計）。

### 替代方案評估

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **單一大型 prompt**（改造前） | 實作最簡、單次呼叫 | 無部分成功、錯誤無法歸因至個別步驟、無法做模型路由、受 context 上限約束；曾實際造成整批失敗 | 此即本次改造要解決的問題 |
| **以 LLM 擔任編排者**（自主代理迴圈） | 彈性高，可處理未預先設計的流程 | 控制流不確定、難以測試；成本無上界；失敗情境不可重現 | 拆題流程已知且固定，無需以不確定性換取彈性（流程未知的情境見下方「對話式助教」） |
| **框架**（LangChain／LangGraph／CrewAI／AutoGen） | 上手快、生態系完整；LangGraph 亦提供圖狀態機 | 抽象層遮蔽 prompt 與錯誤細節；版本演進快；圖狀態需另行持久化方能斷點續跑；行為難以被測試固定 | 自行實作的狀態機以 PostgreSQL 為後盾，持久化與並行認領（`FOR UPDATE SKIP LOCKED`）為原生能力；輕量的自有 LLM 層則是 cassette replay CI 的前提 |
| **專用佇列**（BullMQ + Redis／Celery／Kafka） | 吞吐與重試機制成熟 | 需維運額外的 broker；與業務資料分屬不同交易 | 單人 Windows 環境；`FOR UPDATE SKIP LOCKED` 為同規模的標準解法，且認領與寫回同屬一個交易 |
| **多模型辯論／委員會** | 可進一步提升精度 | 成本隨模型數倍增 | 僅於價值最高的環節（答案驗證）採用雙模型比對，其餘以確定性閘門把關，成本效益較佳 |
| **雲端託管 agent 平台** | 免維運 | 題庫屬私有資產，不宜外流至第三方平台；存在平台綁定 | 資料與驗證邏輯保留於本地，僅 LLM 呼叫對外 |

### 兩種編排模式並存：對話式助教（階段 4）

前述架構的立場是「流程已知時，編排交由程式碼」。階段 4 補上對照案例——**對話式助教**（`services/assistantService.js`）：使用者問題的形態無法預先設計（「小明最弱的章節為何」「為小華預覽一張考卷」），此處編排交由主控 LLM，由其自行決定呼叫哪個工具、呼叫幾次、何時作結（ReAct 迴圈），工具調用軌跡完整呈現於介面。

| | 拆題管線 | 對話式助教 |
|---|---|---|
| 流程 | 已知且固定 | 未知，由問題決定 |
| 編排者 | 程式碼狀態機 | 主控 LLM |
| 每步輸出 | 各 agent 的 JSON Schema | 受限 JSON `{action, tool, args_json, reply}` |
| 寫入權限 | 有（通過閘門後寫入、部分入庫） | 無——五個工具均為唯讀；出卷僅能以 dry-run 預覽，實際出卷仍由使用者確認 |
| 失敗語意 | 重試預算用盡 → needs_review | 工具錯誤回饋給主控自行修正；達步數上限即截斷 |

三項實作決策：

1. **不採用供應商原生 function calling**——以 responseJsonSchema 約束的決策迴圈實作工具調用，使 record/replay、節流與未來的跨供應商 adapter 均可直接沿用；原生 function calling 則綁定單一供應商的請求格式。
2. **參數以 `args_json` 字串傳遞**——實測 Gemini 的 structured output 對未定義 properties 的自由物件會回傳空物件，故參數改以 JSON 字串傳遞，由伺服器端解析並逐一驗證。
3. **「空結果亦為答案」明訂於系統提示**——初版主控會將步數配額耗費於同義詞重試；明訂「至多換一次措辭，仍為空即如實回報」後行為即符合預期。三項底線與全案一致：受限 JSON、工具唯讀、執行前伺服器端驗證。

### 量測結果（Agent 側；replay 對 golden）

| 指標 | 數值 | 門檻（ratchet） |
|---|---:|---:|
| pipeline saved_rate（部分入庫成功率） | 0.90 | ≥0.87 |
| pipeline gate_pass_rate | 1.00 | ≥0.97 |
| answer_agree_rate（雙模型驗答一致率） | 0.90 | ≥0.87 |
| classify accuracy / macro-F1 | 0.9000 / 0.9256 | 已建立 |
| variant retrieved_coverage / gate_pass_rate | 0.8667 / 0.25 | ≥0.8367 / ≥0.22 |

> 變式的 gate_pass_rate 為 0.25，其背景值得說明：偏題閾值最初以既有題目的配對校準為 0.92；第一次實際錄製後發現，校準所用的正樣本（僅替換數值的題目配對）正是文字閘門（裁決 S3-R8）設計上要退回的類型——兩道閘門對「合格」的定義相互矛盾。其後依實測分佈將閾值下修為 0.90 並重新錄製（裁決 S3-R29）。此例說明量測體系的價值：**判準本身有誤時能夠被觀察到**，而非僅產出表面良好的數據。

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

- **後端**：Node.js 24 · Express 5 · PostgreSQL 16 + pgvector（Docker；2026-08-21 由 MySQL 切換，runbook 見 [`docs/archive/cutover-runbook.md`](./docs/archive/cutover-runbook.md)）
- **AI**：Google Gemini（`@google/genai`）——拆題／分類／變式 `gemini-3.5-flash`、獨立驗答 `gemini-3.1-pro-preview`、embedding `gemini-embedding-001`（768 維）；模型 ID 單一真相在 [`exam_pro/config/models.js`](./exam_pro/config/models.js)
- **文件**：`docx`（自製 LaTeX → OOXML 數學公式轉換）
- **前端**：單頁 HTML + Tailwind（CDN）+ MathJax + 五個 ES module 分頁（零打包器）
- **測試／量測**：`node:test`（單元 1,449／整合 261／e2e 11）＋五個 eval suite（golden＋ratchet 門檻）＋ LLM record/replay cassette——CI 全程零金鑰、零網路、零成本

---

## 🧪 品質保證的三層（怎麼測一個 LLM 系統）

1. **合約層單元測試**：agent 為純函式（依賴全數注入），1,449 項測試不連網、不連庫、不需任何金鑰，clone 後執行 `npm test` 即可完整重現。
2. **cassette record/replay**：真實呼叫錄製為 cassette（鍵含模型 ID、模板版本與輸入雜湊），CI 以 replay 模式確定性地重播完整管線；replay miss 於 main 分支視為錯誤——cassette 缺漏不得以綠燈掩蓋。
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

### 程式碼：保留所有權利
本儲存庫為作者的個人工具與技術作品集，公開之目的僅在於供閱讀與技術評估。
程式碼**保留所有權利**：允許於 GitHub 線上瀏覽，但不授權執行、複製、修改、散布，
亦不得納入資料集或用於模型訓練。完整條款見 [`LICENSE`](./LICENSE)。
（2026-08-24 之前的歷史版本曾以 Apache-2.0 釋出，該授權僅及於該等歷史版本。）

### ⚖️ 題目內容（重要）

| | 說明 |
|---|---|
| **本 repo 不含題庫資料** | 沒有任何考卷、試題或其掃描檔。開發期間用於測試的實體考卷 PDF、題庫備份 JSON、維運報告產物與含逐字試題的一次性腳本，**均未收錄、已自版本歷史完全移除，並由 `.gitignore` 持續排除**（同時排除 `.env`、`node_modules/`、`uploads/` 與大型二進位素材）。 |
| **示範題為自製** | `exam_pro/seed_questions.js` 的 30 題係為展示流程自行編寫的常見教科書型例題，不取自任何特定考卷或出版品。 |
| **使用者自負責任** | 本系統用於管理**使用者自身合法擁有或有權使用**的題目。經 PDF 解析匯入的內容，著作權仍屬原著作權人，不因匯入而移轉。匯入前請自行確認已取得合法權源（自行創作、取得授權，或符合著作權法合理使用要件）。 |

完整聲明見 **[`NOTICE`](./NOTICE)**。

© 2026 Ben Yang (楊本顥)
