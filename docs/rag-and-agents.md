# RAG 與多 Agent 架構——技術決策全紀錄

> 目的：完整回答「RAG 在哪裡？用什麼技術？為什麼？優缺點？替代方案為什麼不用？」
> 與「Agent 的部分，同樣的問題」。所有檔名、行為、數字都對應本 repo 的真實程式碼與
> `eval/` 的量測輸出（量測日期 2026-08-24、main `7861a25` 前後），可以逐條驗證。
> 用途：面試準備、新協作者導讀、未來重新檢視決策時的依據。
>
> 相關文件：`docs/roadmap-plan.md`（五章規劃）、`docs/interfaces*.md`（三份凍結介面與全部裁決）、
> `docs/variants.md`（變式題專章）、`exam_pro/README.md`（「問題→決策→數字」表）。

---

## 0. 一頁總結

這是一個家教數理題庫系統（Node 24 / Express 5 / PostgreSQL 16 + pgvector / Gemini），
一人開發、跑在 Windows + Docker 上。核心日常需求是「錄題 → 對某個學生出**不重複**的卷」；
在此之上，為了體現**多 agent 協作**與 **RAG 檢索**兩項能力，把系統擴建成：

- **RAG**：pgvector（768 維）+ 應用層 jieba 全文檢索，RRF 融合；同一段 SQL 服務
  相似題、變式生成的檢索優先、kNN few-shot 分類、自然語言查題四個落點。
- **Agent**：`jobs` 狀態機 + PG 工作佇列（`FOR UPDATE SKIP LOCKED`）編排六個單一職責
  agent（extract／classify／lint／verify／dedup／generateVariant），節點之間全是
  伺服器端硬閘門，失敗逐題重試、超預算進人工複核、**部分入庫**。

兩條設計主軸貫穿全部決策：

1. **prompt 不是保證，伺服器端驗證才是**——LLM 的輸出一律過程式碼閘門才算數。
2. **協調層是程式碼**——流程（順序、重試、預算、逾時）是確定性的狀態機，
   LLM 只負責「單一步驟的智力活」；不確定性被關在單步驟裡。

再加一條方法論：**量測驅動**——每個功能都有 `eval/` 指標、golden、與只升不降（ratchet）
的門檻進 CI；每個「為什麼是這個數字」都能回答「因為量出來是這樣」。

---

## 1. RAG

### 1.1 定義與範圍

RAG（Retrieval-Augmented Generation）＝先從**自己的資料**檢索，再拿檢索結果去增強
生成或決策。本專案的「自己的資料」是題庫（`questions` 表，含向量欄），檢索層是
**同一段 SQL**（`queries/hybrid.js`），四個落點共用。

### 1.2 四個落點

| 落點 | 檢索什麼 | 增強什麼 | 程式碼 |
|---|---|---|---|
| **① 相似題** | 與指定題同科、餘弦最近的題（hybrid 融合） | 不生成，檢索結果本身就是產品（錯題→「找相似」） | `queries/hybrid.js` → `services/retrievalService.js` → `GET /api/questions/:id/similar` |
| **② 變式題「檢索優先」** | 先在題庫找餘弦 ≥ `VARIANT_RETRIEVE_SIM_MIN`(0.80) 的同難度題，池夠就**直接推薦、零生成成本**；不夠才生成，且把藍本＋前 5 題鄰居塞進 prompt 當錨點；生成後再用 `cos(embed(變式), embed(藍本)) ≥ VARIANT_OFFTOPIC_SIM_MIN`(0.90) 反向驗證跑題 | 生成不跑題、風格貼題庫；大多數請求根本不花錢 | `services/variantService.js`（retrieved 分支）、`agents/generateVariant.js`（錨點＋跑題閘門） |
| **③ 檢索式 few-shot 分類** | 從題庫取 k=8 個最近鄰當分類範例（排除同一份 PDF；`chapter_src IN ('human','ai','knn')` 可當範例，**human 排最前**）；投票短路：最近 5 鄰 ≥4 題是**人工確認**的同一章、且最近鄰餘弦 ≥ `KNN_VOTE_SIM`(0.90) → 直接採用 `source='knn'`，**一次 LLM 都不呼叫** | 範例跟著題庫長大（不再寫死在 prompt）；高信心時 LLM 呼叫被檢索整個取代 | `agents/classify.js`（P-14） |
| **④ 自然語言查題** | 規則先吃掉章節／難度／題型／學生條件，剩餘概念文字（`semantic_text`）embed 成查詢向量走 hybrid；四級回退階梯（原條件 → 丟章節 → 再丟難度題型 → 無 embedding 時退 LIKE），任一層失敗都有退路且回 `fallback_level` 讓人看得見 | 老師的口語 →（規則＋向量）→ SQL；`filters` 回寫到下拉，機器的理解可被檢視 | `utils/nlqHeuristics.js`、`services/nlqService.js`、`POST /api/search-nl` |

### 1.3 技術選型與理由

**組合**：PostgreSQL 16 + pgvector extension；`gemini-embedding-001`、768 維、L2 正規化
（餘弦＝內積）；應用層 `@node-rs/jieba` 分詞（`dict.txt.big` + 章節自訂詞）做全文側；
向量側與全文側用 **RRF（Reciprocal Rank Fusion，k=60）** 融合。

逐項的「為什麼」：

1. **pgvector 而不是獨立向量庫**
   - 題庫是百～千題級，不是百萬級。這個量級 pgvector 暴力掃描（exact search）就夠快，
     連 ANN 索引（HNSW／IVFFlat）都還不需要。
   - 決定性理由：**關聯條件與向量檢索必須在同一句 SQL**。「排除這個學生做過的題
     （`NOT EXISTS attempts`）、排除同一變式家族（`COALESCE(variant_of,id)`）、鎖定難度、
     只看某章、排除已封存」全是關聯條件。向量庫放外面，就得 over-fetch 回來自己過濾，
     或把 metadata 同步成兩份真相；放同一個 PG，一句 SQL 完事，交易一致性免費拿到。
   - 一人開發、Windows + Docker：不加任何新服務。PG 本來就要（students／attempts／jobs），
     向量能力只是一個 extension。

2. **768 維、模型 ID 全案釘死（E-X0，全案第一個決策點）**
   - 不同模型或不同維度的向量混進同一欄位＝整個庫報廢還**不會噴錯**（餘弦照算、數字全錯）。
     所以 `MODEL_EMBED`／`EMBED_DIM` 開案第一天凍結，`config/models.js` 是單一真相，
     eval 的 cassette 鍵含模型 ID——換模型，快取全失效，強迫重錄。

3. **應用層 jieba 而不是 PG 端中文分詞**
   - PG 原生沒有堪用的中文分詞；`zhparser`／`pg_jieba` 是 C extension，在 Windows／
     自組 Docker image 上維運成本高。
   - 應用層分詞的代價是「SQL 端不能獨立重建語意」，所以專案凍結**全案唯一分詞器**
     （`utils/tokenize.js`，D-T1）：寫入端與查詢端保證同一套詞表，否則全文索引悄悄失準。

4. **hybrid（全文＋向量）而不是單邊**
   - 量出來的：Recall@5 純 `LIKE` 0.875 → hybrid **1.000**。
   - 互補性：中文題目「換個數字的同一題」關鍵字對不上，向量抓語意；反過來
     專有名詞、公式符號、罕見詞是全文檢索的強項，向量在這裡會糊。

5. **RRF 而不是加權分數融合**
   - 兩路分數量綱不可比（餘弦 0~1 vs 全文 rank score），加權融合要先做分數正規化、
     再調一個權重超參。RRF 只看**名次**：`score = Σ 1/(60+rank)`，零校準、對分數分佈
     魯棒、是業界慣用做法。加權模式保留為備案（`queries/hybrid.js` 的 `mode:'weighted'`）。

6. **embedding 的第二用途：不只搜尋**
   - 去重第二段（dedup1）：餘弦 ≥ `DEDUP_DUP_THRESHOLD`(0.97) 判重複、≥ 0.90 標變式候選。
   - 變式跑題閘門：`cos(變式, 藍本)` 低於閾值就退回重生。
   - 檢索、去重、跑題三件事共用同一個向量空間與同一支 `utils/embedText.js`
     （送 embed 的文本組法是單一真相——量的才是同一個東西）。

### 1.4 量測（RAG 側）

| 指標 | LIKE | 純向量 | hybrid |
|---|---:|---:|---:|
| Recall@5 | 0.875 | 0.97 | **1.000** |
| Recall@10 | 0.92 | 0.97 | 1.000 |
| MRR | 0.738 | **0.9575** | 0.824 |

（2026-08-22 基準、2026-08-24 replay 複驗；`gemini-embedding-001`／768 維；
golden 40 筆人工定案；門檻＝首測 −0.03 寫入 `eval/thresholds.json`，只升不降。）

注意 MRR 一列：**純向量 > hybrid**。RRF 只看名次，會稀釋單邊的極強信號——這是
recall 換 MRR 的 trade-off。本場景（出卷前找候選、老師自己挑）要的是 recall，可接受；
若場景變成「只回第一名」，這個決策要重開。

NLQ（50 句 golden，2026-08-24 定案）：rules 路徑（42 句）rule_coverage 0.84、
filters_exact 1.000、recall@10 1.000；LLM 路徑（8 句）filters_exact 0.75、recall@10 0.875。

### 1.5 替代方案比較（RAG）

| 方案 | 優點 | 缺點 | 為什麼不用 |
|---|---|---|---|
| **專用向量庫**（Pinecone／Milvus／Qdrant／Weaviate） | 億級向量、ANN 成熟、託管免維運 | 多一個服務（或月費）；關聯過濾要 metadata filter 或 over-fetch；與 PG **兩份真相**要同步 | 量級差三個數量級；「排除做過的題」這種 join 是核心需求，拆兩個庫自找麻煩 |
| **FAISS／記憶體內索引** | 最快、零外部服務 | 無持久化、無過濾語意、重啟重建、與資料庫脫節 | 一人專案要「開機就能用」；過濾需求同上 |
| **Elasticsearch／OpenSearch** | 全文檢索最強、也有 kNN | JVM 重、維運重、中文仍要分詞插件 | 為了全文檢索抬一頭大象進來，不成比例 |
| **純向量、不做 hybrid** | 少一路、簡單 | 專有名詞／符號的精確匹配會漏 | 量測說 hybrid 的 recall 更好（0.97→1.000），加一路 SQL 的成本近零 |
| **Cross-encoder rerank**（兩段式重排） | 精度上限更高 | 每對 query-doc 一次模型呼叫：延遲＋成本 | Recall@5 已 1.000，沒有留給 reranker 的空間；規模大了再加，架構上隨時插得進（檢索層是獨立一段 SQL） |
| **微調（fine-tune）取代檢索** | 知識內化、推理時免檢索 | 資料量遠不夠；新題要重訓；無法溯源「為什麼推這題」 | 題庫天天在長，RAG 新題入庫即刻可檢索；回傳餘弦與命中側，可解釋 |
| **LangChain／LlamaIndex 的 retriever 抽象** | 起步快、換組件容易 | 抽象層藏住 SQL 與錯誤；版本翻新快；行為難被測試釘住 | 「協調層是程式碼」：一段手寫 SQL 同時服務 API 與 eval，CI 能釘死它的行為 |

### 1.6 已知限制與擴展路線

- 千萬向量級要上 pgvector 的 HNSW／IVFFlat 並調參；再上去才考慮專用向量庫。
- RRF 的 MRR 稀釋（見 1.4）；場景改變時的第一個重開點。
- 應用層分詞：換分詞器＝全文側全部重建；`utils/tokenize.js` 單一真相是護欄不是解藥。
- embedding 模型升級＝向量全欄重灌＋cassette 全重錄（`scripts/backfill_embeddings.js` 就是為此存在）。

---

## 2. 多 Agent 協作

### 2.1 改造前的問題（這是本 repo 的 git 歷史，不是假想敵）

舊 `services/aiService.js`：**一個巨型 prompt** 拆整份 PDF——無 schema、無重試、
`JSON.parse` 完就回，一題壞掉**整批 400**（`questionController.js:77-79` 的舊行為，
實際發生過）。章節白名單在 prompt 裡手抄一份，與 `config/chapters.js` 兩份真相。
答案是拆題模型自己抄的，抄錯了沒有第二來源能發現。

### 2.2 架構總覽

```
POST /api/jobs (PDF)                            POST /api/questions/:id/variants
        │                                                │（先檢索，池夠直接 200 回題，不建 job）
        ▼                                                ▼
┌─ jobs（PG）────────────────────────────────────────────────────────┐
│  state: queued → extracting → processing → done / failed           │
│  每題一列 job_questions：                                           │
│  extracted → hashed → classified → linted → verified → deduped     │
│            → saved ／ needs_review ／ rejected                      │
└────────────────────────────────────────────────────────────────────┘
        ▲ 認領：同一交易 SELECT … FOR UPDATE SKIP LOCKED + 租約(locked_until)
        │ 併發 2 槽；租約到期自動被別的槽撿走（斷點續跑）
workers/jobRunner.js ──── 每節點：逾時 120s、退避重試 1s/2s/4s、
        │                 RPM 節流（令牌桶）、job 成本上限 $0.50、每日上限 $5
        ├─ agents/extract.js          拆題（MODEL_EXTRACT＝gemini-3.5-flash）
        ├─ agents/classify.js         章節分類（零成本閘門 → kNN 投票短路 → 才叫 LLM）
        ├─ agents/lint.js             公式修復（formulaFix／formulaLint）
        ├─ agents/verify.js           獨立解題驗證（MODEL_VERIFY＝gemini-3.1-pro-preview）
        ├─ agents/dedup.js            兩段去重（dedup0 雜湊 → dedup1 向量餘弦）
        └─ agents/generateVariant.js  變式生成（藍本＋5 鄰居錨點；階段 3）
        │
        ▼ 每兩節點之間：伺服器端硬閘門（ajv schema、白名單、正規化、比對）
   過不了 → 逐題重試（機器 feedback 餵回 prompt）→ 預算用盡 →
   needs_review（八種 review_reason 之一，附具體原因）→ 人工複核佇列（approve UI）
   結果：部分入庫——90 題裡 3 題有問題，87 題照樣 saved，3 題排隊等人
```

兩張狀態表都用 DDL 的 `CHECK` 寫死（`migrations/0003_jobs.sql`），
`review_reason` 八個合法值：`chapter_invalid`／`formula_unparsable`／`answer_mismatch`／
`duplicate`／`budget_exceeded`／`provider_error`／`schema_invalid`／`awaiting_approval`。
每一步（含成本、延遲、token 數）寫進 `job_events`，`npm run report:jobs` 可出帳。

### 2.3 Agent 的合約（讓「多 agent」可測的關鍵）

每個 agent 是**純函式**：

- 不得 `require('../config/db')`——資料存取由 runner 做，agent 只看輸入。
- 不得讀 `process.env`——門檻經 `ctx.config.thresholds` 注入（`loadStage3Config()` 組裝）。
- LLM 呼叫只准走注入的 `ctx.llm.generateJson()`／`ctx.embed()`。
- 輸出是判別聯集：`{kind:'ok'|'fail'|'error', reason, feedback, data}`——`fail` 是
  「內容不合格」（可重試、feedback 餵回 prompt），`error` 是「基礎設施壞了」（走 provider 退避）。
- prompt 模板有版本號（如 `variant.v1`），進 cassette 鍵。

這個合約買到三件事：單元測試不用 mock 資料庫；cassette 回放鍵可重現
（裁決 S2-8：eval 的 `ctx.db` 一律 null）；換 runner／換編排方式不用動 agent。

### 2.4 變式題的九道閘門（「多 agent 制衡」的具體樣子）

依「便宜的先做」排序（`docs/variants.md` 第 2 節）：

| # | 閘門 | 用什麼判 | 成本 |
|---|---|---|---|
| 1 | JSON schema | ajv + `agents/schemas/variant.json` | 0 |
| 2 | 章節白名單 | `isValidChapter`（退回藍本章節並記 `chapter_overridden`） | 0 |
| 3 | 只改字 | Levenshtein＋數字遮罩（`utils/variantTextGate.js`，**不用 embedding**） | 0 |
| 4 | 跑題 | `cos(embed(變式), embed(藍本)) ≥ 0.90` | 1 次 embed |
| 5 | 逐字重複 | `normalizeStem` → sha256（dedup0） | 0 |
| 6 | 章節 | 零成本閘門／kNN 短路／LLM（classify） | 0～1 次 LLM |
| 7 | 公式 | `formulaFix` + `formulaLint`（lint） | 0～1 次 LLM |
| 8 | 答案 | **另一個模型**獨立解題 + `answerCompare`（verify） | 1 次 Pro |
| 9 | 語意重複 | 向量餘弦、排除藍本整個家族（dedup1） | 0（向量已有） |

「協作」在這裡的意思不是 agent 開會，而是**互相制衡**：
verify 用不同模型重算答案（單一模型抄錯會錯得像模像樣，第二來源才查得出來——
實測 golden 10 題抓到 1 題 `answer_mismatch`）；classify 的 kNN 投票**只認人工確認過的
標籤**（`chapter_src='human'`）——自動標籤餵回自動投票是閉環放大器，錯一題會
自我強化成一串同錯題（規劃 §4.4）。

### 2.5 成本工程（設計的一部分，不是事後優化）

- 模型路由：便宜模型拆題（flash）、強模型只用在最值錢的一步（verify 用 pro）。
  `MODEL_VARIANT` 未設時退回 `MODEL_VERIFY`（變式生成也要推理強的）。
- 閘門排序「便宜的先做」：文字比對 → embedding → 才是 LLM。
- kNN 短路：檢索高信心時整個 LLM 呼叫被取代（目前開發庫 human 標籤少，短路率誠實起點 0）。
- 檢索優先：變式請求先查池，夠就 200 直接回，不建 job、不花錢。
- 預算三層：單 job `JOB_COST_BUDGET_USD=0.50`、單變式 job `VARIANT_TOKEN_BUDGET_USD=0.30`、
  每日 `DAILY_COST_BUDGET_USD=5.00`；`config/pricing.js` 逐 token 記帳
  （官方單價 2026-08-24 查證；thinking token 與 output 同價計——漏算會系統性低估二～五倍）。

### 2.6 測試與量測策略（讓 LLM 系統可回歸）

- 金字塔：`npm test` 1403 項不連網不連庫；整合測試對 tmpfs 測試庫（`--test-concurrency=1`）；
  e2e 兩條（上傳 PDF→部分入庫；組卷→Word 含 OOXML 公式）。
- **record/replay cassette**：`LLM_MODE=record` 真呼叫並把回應存檔（鍵＝agent＋模板版本＋
  模型 ID＋輸入雜湊）；CI 恆 `LLM_MODE=replay`／`EMBED_MODE=fixture`——**零成本、零網路、
  確定性**地跑完整條管線。replay miss 在 main 上是錯誤（cassette 沒錄到＝測試沒涵蓋）。
- eval golden ＋門檻 ratchet：首測 −0.03 寫入 `eval/thresholds.json`，之後只升不降；
  門檻存在後「量不到那一欄」算失敗——否則 cassette 被誤刪會表現成 CI 全綠。

### 2.7 量測（Agent 側，2026-08-24）

| 指標 | 數字 | 門檻 |
|---|---:|---:|
| pipeline saved_rate | 0.90 | ≥0.87 |
| pipeline gate_pass_rate | 1.00 | ≥0.97 |
| pipeline answer_agree_rate | 0.90 | ≥0.87 |
| classify accuracy / macro-F1 | 0.9000 / 0.9256 | 已建門檻 |
| variant retrieved_coverage | 0.8667 | ≥0.8367 |
| variant gate_pass_rate | 0.25 | ≥0.22 |

（golden：pipeline 10 題、classify 90 筆、variant 30 藍本，皆人工定案；
模型 `gemini-3.5-flash`／`gemini-3.1-pro-preview`；commit `f4a15ca`。）

### 2.8 這套的優缺點

**優點**
- 一題壞不再毀整批（部分入庫）；每步可觀測、可歸因、可出成本帳。
- 編排確定性：可重跑、租約斷點續跑、行為被 1400+ 測試與 replay CI 釘死。
- 人只看有疑慮的題，且每題附**機器寫的具體原因**（「驗證模型算出 (B)，拆題模型說 (C)」），
  不是無差別全查。

**缺點（誠實列）**
- 前期程式碼量大：狀態機、閘門、eval 基建全手寫，比套框架慢熱。
- 剛性：加一個節點要動 DDL CHECK、契約、閘門、測試。
- 逐題逐節點序列推進，吞吐靠 job 併發（=2）；十倍量級後 PG 佇列要重新評估。
- 模型一換 cassette 全部重錄（cassette 鍵含模型 ID——這是誠實的代價：
  否則「數字是舊模型量的」會靜默混進報表）。

### 2.9 替代方案比較（Agent）

| 方案 | 優點 | 缺點 | 為什麼不用 |
|---|---|---|---|
| **單一巨型 prompt**（改造前） | 最省事 | 無部分成功、無歸因、無模型路由、context 上限；實際發生過整批 400 | 這正是要解掉的東西 |
| **LLM 當編排者**（AutoGPT 式自主迴圈／讓模型決定下一步） | 靈活、能處理未設想的流程 | 控制流不確定→不可測、成本無上界、失敗不可重現 | 拆題流程**已知且固定**，用不確定性換不需要的靈活度，純虧 |
| **框架**（LangChain／LangGraph／CrewAI／AutoGen） | 起步快、生態多；LangGraph 也有圖狀態機 | 抽象層藏 prompt 藏錯誤；版本翻新快；圖狀態要另做持久化才能斷點續跑；行為難被測試釘住 | 自寫狀態機落在 PG：**持久化與併發認領（SKIP LOCKED）免費拿到**；薄的自有 `services/llm/` 層才能做 cassette replay CI |
| **專業佇列**（BullMQ+Redis／Celery／Kafka） | 吞吐與重試機制成熟 | 多一個 broker 要維運；與業務資料不同交易 | 一人 Windows 專案；PG `FOR UPDATE SKIP LOCKED` 是同量級標準解，且與資料同交易（認領與寫回原子） |
| **多 agent 辯論／委員會**（同題多模型投票） | 精度可再擠 | 成本 ×N | 只在最值錢的一步做雙來源（verify 換模型重算），其餘用確定性閘門制衡，性價比更高 |
| **Managed agent 平台**（雲端託管） | 免維運 | 題庫（私有資產）出境；綁定；成本 | 資料與閘門留本地，只有 LLM 呼叫出去 |

### 2.10 兩種編排哲學並存：對話式助教（階段 4 A1）

上面 2.1～2.9 的立場是「流程已知 → 編排交給程式碼」。2026-08-24 補上了對照組：
**對話式助教**（`services/assistantService.js`、`POST /api/assistant`）——使用者問題
的形狀未知（「小明最弱的章節？」「幫小華預覽一張卷」），這裡編排交給**主控 LLM**：
它自行決定叫哪個工具、叫幾次、何時收尾（ReAct 迴圈）。

| | 拆題管線（jobRunner） | 對話式助教 |
|---|---|---|
| 流程 | 已知且固定 | 未知、由問題決定 |
| 編排者 | 程式碼狀態機 | 主控 LLM |
| 步驟輸出 | 各 agent 的 schema | 受限 JSON `{action, tool, args_json, reply}` |
| 寫入權 | 有（部分入庫，過閘門才寫） | **零**（五個工具全只讀；出卷只能 dry-run 預覽） |
| 失敗語意 | 重試預算→needs_review | 工具錯誤餵回主控自行修正；步數上限截斷 |
| 可測性 | cassette replay＋1,400 單測 | 同一條 generateJson 路 → cassette 免費繼承；編排行為 11 項單測（llm 注入假的） |

三個實作決策（面試常被追問）：
1. **不用供應商原生 function calling**：用 responseJsonSchema 鎖出 `call_tool/final`
   的決策迴圈——record/replay、節流、未來異家 adapter 全部免費繼承；原生 FC 綁定
   gemini 請求形狀。代價是多一層 prompt 說明書（工具手冊進 system prompt）。
2. **參數走 `args_json` 字串**：實測 gemini structured output 對沒有 properties 的
   自由物件會吐空 `{}`——參數改為 JSON 字串、伺服器端 parse＋逐工具 validate。
3. **「空結果就是答案」寫進系統提示**：第一版主控會把五步全花在同義詞重試上；
   明定「最多換一次措辭、還是空就誠實收尾」之後行為正確。prompt 是行為的一部分，
   但**執行前的 validate 與只讀邊界才是保證**——與全案第一原則一致。

---

## 3. 三個好的面試故事（比「一次就對」更有說服力）

1. **S3-R29：兩道閘門用了矛盾的「合格」定義。**
   變式的跑題閾值最初校準成 0.92——方法是拿 fixture 現成題對算餘弦，「同概念換數字」
   當正類（最低 0.9298）、「跨章」當負類（p95 0.8674），中間找分界。邏輯沒錯，
   **正類選錯了**：「只換數字」恰好是只改字閘門（S3-R8）要退回的東西——合格變式必須
   改寫敘述，餘弦天然更低。第一次真實錄製 60 題才暴露：26/30 藍本被 0.92 擋掉。
   依實測分佈（合格變式多在 0.85~0.92）下修到 0.90 並重錄，gate_pass_rate 0.15→0.25。
   教訓：**代理指標的正類要跟真實分佈對齊，離線校準要儘早用真實生成物複驗**。

2. **S3-R8：閘門規則的 AND 條件讓整條規則失效。**
   只改字閘門原規則「數字多重集合相同 **且** 遮罩後相同」只擋得住「數字對調」；
   換成**別的**數字時多重集合就不同，整條規則靜默失效，只剩編輯距離在擋（短題幹
   改四個數字就漏）。拿掉 AND、只看數字遮罩後是否相同：fixture 20 對的攔截率 11/20→15/20，
   且不誤傷（合格變式重寫過敘述，遮罩後不可能相同）。教訓：**閘門要用反例集量攔截率，
   不是讀起來合理就好**。

3. **部分入庫：從一次真實事故長出來的架構**。
   舊系統一題 `JSON.parse` 失敗整批 400（真實發生）。現在 90 題裡 3 題有問題，
   87 題照樣入庫、3 題帶著機器寫的原因進複核。這不是效能優化，是**失敗語意的設計**：
   把「批次成敗」拆成「逐題狀態」，需要的正是狀態機＋逐題佇列，也就是整個 agent
   架構的起點。

## 4. 常見追問與回答要點

- **「為什麼不用 LangChain？」**——不是反框架，是這個專案的核心價值（閘門、狀態機、
  cassette CI、成本帳）框架都不提供，而框架提供的（鏈式呼叫、retriever 抽象）自己寫
  只要幾百行且可被測試釘死。規模與團隊變了，答案可以變。
- **「向量庫為什麼選 pgvector？」**——先說量級（千題 vs 百萬），再說 join 過濾需求
  （不重複出題），最後說維運（一人、Windows、已有 PG）。
- **「多 agent 的『協作』體現在哪？」**——管線分工（單一職責）＋互相制衡（異模型
  驗答案、human-only 投票）＋短路（檢索取代 LLM）。不是 agent 對話。
- **「怎麼測 LLM 系統？」**——三層：合約單測（agent 純函式）、cassette replay
  （確定性整合）、eval golden＋ratchet（品質回歸）。關鍵句：**cassette 鍵含模型 ID**。
- **「成本怎麼控？」**——路由（flash/pro 分工）、便宜優先的閘門排序、kNN 短路、
  檢索優先、三層預算上限、逐 token 記帳（thinking 同價計）。
- **「有什麼你會重做的？」**——誠實答：跑題閾值的首次校準（故事 1）；產品面
  過度服務作品集、日常主流程（選學生、草稿出卷）反而繞遠——已列為下一階段收斂目標。

## 5. 檔案地圖（速查）

| 主題 | 檔案 |
|---|---|
| hybrid 檢索 SQL（RRF/weighted） | `exam_pro/queries/hybrid.js` |
| 檢索服務／相似題 API | `exam_pro/services/retrievalService.js`、`routes/index.js` |
| 分詞（全案唯一） | `exam_pro/utils/tokenize.js` |
| embed 文本組法（單一真相） | `exam_pro/utils/embedText.js` |
| embedding 服務／回填 | `exam_pro/services/embedService.js`、`scripts/backfill_embeddings.js` |
| NLQ 規則與服務 | `exam_pro/utils/nlqHeuristics.js`、`services/nlqService.js` |
| 六個 agent | `exam_pro/agents/*.js`（合約見各檔頭） |
| 編排／佇列／預算 | `exam_pro/workers/jobRunner.js`、`migrations/0003_jobs.sql` |
| LLM 層（record/replay/節流） | `exam_pro/services/llm/` |
| 模型與價格（單一真相） | `exam_pro/config/models.js`、`config/pricing.js` |
| 只改字閘門 | `exam_pro/utils/variantTextGate.js` |
| 答案比對／題幹正規化 | `exam_pro/utils/answerCompare.js`、`utils/normalizeStem.js` |
| eval 入口／套件／門檻 | `exam_pro/eval/run.js`、`eval/lib/suite*.js`、`eval/thresholds.json` |
| 變式題專章（九道閘門、校準、S3-R8/R9/R29） | `docs/variants.md` |
| 全部裁決 | `docs/interfaces-stage1.md`、`interfaces-stage2.md`、`interfaces-stage3.md` |
