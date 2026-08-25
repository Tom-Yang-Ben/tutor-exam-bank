# 階段 3 產品面與 RAG 三落點：多開 Claude Code 的平行分工與提示詞

> 搭配 `docs/roadmap-plan.md` §4（階段 3）、§2.3.7–3.8（hybrid／`/similar`）、§3.3（jobs 管線）使用；任務 ID 沿用規劃 §1 的 P-*／E-X15。
> 流程同前兩階段：**S0 凍結介面（`docs/interfaces-stage3.md`）→ 四條 workstream 平行 → 試合併 → 裁決**。
> `docs/interfaces.md`（階段 1）與 `docs/interfaces-stage2.md`（階段 2）仍然有效、不得修改；階段 3 新介面全寫在 `docs/interfaces-stage3.md`。

## 0. 開工前的機械準備（你自己做，5 分鐘）

```powershell
# 主目錄（S0 用）
cd C:\Users\Administrator\Desktop\期中專案 ; git checkout main ; git pull ; git checkout -b s0/stage3

# 四個 worktree 各自執行（分支名各不同），並各開「新的」Claude 對話
cd C:\Users\Administrator\Desktop\期中專案-wsA ; git checkout main ; git pull ; git checkout -b ws3-a/students
cd C:\Users\Administrator\Desktop\期中專案-wsB ; git checkout main ; git pull ; git checkout -b ws3-b/variants
cd C:\Users\Administrator\Desktop\期中專案-wsC ; git checkout main ; git pull ; git checkout -b ws3-c/nlq
cd C:\Users\Administrator\Desktop\期中專案-wsD ; git checkout main ; git pull ; git checkout -b ws3-d/frontend
```

S0 合入 main 後各 worktree `git merge main && cd exam_pro && npm ci`。Docker 兩個庫照舊；階段 3 預期**不需要新 migration**（`origin`／`variant_of`／`chapter_src`／`archived_at`／`graded_at`／`exam_papers.student_id`／`jobs.kind` 都已在 0001／0003），S0 要逐欄確認，真缺才開 `0006_`。

## 1. 分工總表

階段 3 拆成 **3A（不碰 LLM，可先交付）** 與 **3B（依賴階段 2 閘門）**；四條 WS 同時開，3A 的東西會先合入。

| Session                                               | 何時開             | 任務（規劃 ID）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 擁有的檔案（別人不得改）                                                                                                                                                                                                                                                                                                | 交付／同步點                                                   |
| ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **S0 介面凍結**（序列，~半天）                  | Day 0              | `docs/interfaces-stage3.md`、DDL 核對（需要才 `0006_`）、`.env.example`、routes 四個新區塊、`config/features.js` 加三個旗標 getter                                                                                                                                                                                                                                                                                                                                                                                                                                         | `docs/interfaces-stage3.md`、`.env.example`、`routes/index.js` 新區塊空殼、`config/features.js`（只加 getter）、`migrations/0006_*`（若需要）                                                                                                                                                                 | **I0''**：合進 main 後四條才接線（純函式與 mock 可先開） |
| **WS-A 學生與弱點（3A）**                       | Day 1              | P-02`weaknessService` SQL 純函式 + db-test → P-04 `GET /students*`、`GET /papers/:id`、`PATCH /papers/:id/results` → P-06 `pickOnePerFamily` 接進 `generatePaper` → `generatePaper` 回 `paper_id`（已有）與「立即批改」所需欄位                                                                                                                                                                                                                                                                                                                                 | `services/weaknessService.js`、`controllers/studentController.js`、`controllers/paperController.js`、`utils/pickOnePerFamily.js`、`controllers/examController.js`（只加家族互斥）、`test/integration/students.pg.test.js`、routes `[WS3-A: students]`                                                     | **I2'' 學生 API 可用**：WS-D 的 `students.js` 接線     |
| **WS-B 相似題／變式題 + kNN few-shot（3A+3B）** | Day 1              | P-10`POST /questions/:id/variants` 的 **200 retrieved 分支**（純檢索，3A）→ P-11a 變式 prompt／schema／只改字文字閘門／30 藍本清單 → P-12 `variantService`：`jobs(kind='variant')` 建列、`agents/generateVariant.js` 產出與 extract 同形的 `payload.extract` 後**走階段 2 同一條管線**（dedup0→classify→lint→verify→dedup1→save；`VARIANT_AUTO_APPROVE=false` 時 save 前停在 `needs_review('awaiting_approval')`）→ P-11b `VARIANT_SIM_MIN` 校準 + `eval:variant` → P-14 classify 的 kNN few-shot（human-only 投票、`chapter_src='knn'`） | `services/variantService.js`、`agents/generateVariant.js`、`agents/schemas/variant.json`、`utils/variantTextGate.js`、`workers/jobRunner.js`（只加 `kind='variant'` 分支）、`agents/classify.js`（只加 kNN 層）、`eval/lib/suiteVariant.js`、`eval/golden/variant.json`、routes `[WS3-B: variants]` | **I5'' 變式 API 可用**：WS-D 的 `variants.js` 接線     |
| **WS-C 自然語言查題（3A 規則／3B LLM）**        | Day 1（不等 DB）   | P-07`config/chapterAliases.js` + `utils/nlqHeuristics.js` 純函式 + NL golden 50 句草稿 → P-08 `POST /questions/search-nl`（規則主、LLM 輔 structured output、伺服器再驗、hybrid、四級回退階梯、LRU）→ `eval --suite nlq`（規則覆蓋率、filters 正確率、Recall@10）                                                                                                                                                                                                                                                                                                        | `utils/nlqHeuristics.js`、`config/chapterAliases.js`、`services/nlqService.js`、`agents/schemas/nlq.json`、`eval/golden/nlq.json`、`eval/lib/suiteNlq.js`、`test/unit/nlq*.test.js`、routes `[WS3-C: nlq]`                                                                                              | **I4'' NL API 可用**：WS-D 的 `nlq.js` 接線            |
| **WS-D 前端 + README + e2e**                    | Day 1（mock 先行） | P-05`public/js/students.js`（學生下拉→試卷列表批改三態→弱點三表純 CSS 橫條→≤60 行 SVG 週趨勢→最近錯題「找相似／出變式」）→ P-09 `nlq.js`（查題框、filters 回寫下拉、回退提示）→ P-13 `variants.js`（202 輪詢、狀態 chip、實際 `cost_usd`）→ 組卷結果區「立即批改」連結 → `check:html` → E-X15 `test/e2e/` 2 條 → P-15a README「問題→決策→數字」骨架（P-15b 填數字在全部 eval 有基準線後）                                                                                                                                                                 | `public/index.html`、`public/js/students.js`、`nlq.js`、`variants.js`、`test/e2e/`、`exam_pro/README.md`、`.github/workflows/ci.yml`、`package.json` 的 `scripts`、`eval/run.js`（接 WS-B/C 的 suite）                                                                                              | **I6'' 全部接線**：三個分頁都對真 API                    |
| **人工 lane（你）**                             | 全程               | NL golden 50 句（你平常會怎麼問）定案；30 題變式藍本挑選與 50 題人工品質評分（概念相同／可解／答案正確）；用新面板批改幾張真卷讓弱點面板有資料；決定`VARIANT_AUTO_APPROVE` 何時開；review 與合併                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                      | 瓶頸：標註與試用回饋                                           |

**相依一句話**：S0 → 四條同時開；D 全程 mock 先行，A/B/C 各自合入後接線；B 的 P-12 走階段 2 管線（已在 main），P-14 需要 `/similar`（已在 main）；C 的 hybrid 用 `queries/hybrid.js`（已在 main），查詢向量用 `embed()` 的 `RETRIEVAL_QUERY`。

**設計原則提醒**（規劃 §4.4）：先檢索再生成、生成也走同一組閘門；「只改字」用文字比對不用 embedding；kNN 短路只信人工標籤；NL 查題規則優先、受限 JSON、SQL 固定；弱點面板即時 SQL 聚合但正確性由 db-test 保證；批改手動三態、入口在試卷列表；前端維持 vanilla + ES module；刪題軟刪。

## 2. 每個 session 的提示詞

共用開頭（貼在每一份最前面，`wsX`／分支名自行替換）：

```
你在 C:\Users\Administrator\Desktop\期中專案-wsX（git worktree，分支 ws3-x/...）工作，主要程式在 exam_pro/。專案跑在 PostgreSQL 16 + pgvector（Docker，開發 5442 / 測試 5433）；階段 1（資料層）與階段 2（jobs 管線、五個 agent、eval 體系）都已上線，FEATURE_PIPELINE=true。
先完整讀：docs/roadmap-plan.md 的 §4（階段 3）全章與 §2.3.7–3.8、docs/interfaces-stage3.md（階段 3 凍結介面，最高優先）、docs/interfaces.md 與 docs/interfaces-stage2.md（仍有效）、exam_pro/README.md、docs/stage3-parallel-prompts.md 的分工總表。
硬規則：
1. 只改你「擁有的檔案」（interfaces-stage3.md 的所有權表）。routes/index.js 只能在自己的 [WS3-*] 區塊 append；package.json deps 只加自己需要的、scripts 由 WS-D 統一；.env.example 不直接改，新變數列在 PR 描述。各 WS 可在 test/unit|integration 新增自己的測試檔，不得改別人的。
2. 三份 interfaces*.md 都是凍結介面，不得修改；發現問題寫 docs/questions3-wsX.md 並在回報中明講，不要自行改介面繞過。
3. npm test 不連 DB、不連 Gemini；LLM 一律經 services/llm 的 generateJson()（cassette record/replay 機制已在），embedding 經 embed()；需要 PG 的測試放 test/integration/（TEST_DATABASE_URL、_test 後綴、npm run test:integration 有 --test-concurrency=1）。
4. 不得把真實考卷題目、學生姓名寫進 repo；golden 與 fixture 只能用 eval/fixtures/questions.public.json 的自製題與自編句子；cassette 只錄公開素材。
5. 繁體中文註解與 commit，小步 commit，不 push main。
6. Windows 11：檔案一律由 Node 寫；路徑含中文要 path.resolve + UTF-8；PowerShell 沒有行內 VAR=x。
完成後回報：做了什麼（對應任務 ID）、怎麼驗證（貼測試輸出）、新環境變數、未完成與原因、給其他 workstream 的注意事項。
```

### S0 — 介面凍結（Day 0，主目錄、分支 s0/stage3，一個 session，約半天）

```
你是階段 3「介面凍結」負責人。產出 docs/interfaces-stage3.md，每條都要具體簽名／形狀，不可寫「待定」。依序：

A. DDL 核對（不寫新 migration 除非真缺）：逐欄確認 questions.origin/variant_of/chapter_src/archived_at、attempts.graded_at/result、exam_papers.student_id、jobs.kind/source_question_id、idx_attempts_student_date 都已存在（migrations/0001、0003）；缺的才開 0006_stage3.sql 並套到兩個庫。

B. docs/interfaces-stage3.md 第 1–12 條：
1. 學生與試卷 API（擁有者 WS-A）：GET /api/students → {items:[{id, name, papers, graded_ratio}]}；GET /api/students/:id/papers → {items:[{paper_id, title, created_at, total, graded}]}；GET /api/papers/:id → {id, title, student_id, created_at, questions:[{question_id, question_text, question_type, difficulty, result}]}；PATCH /api/papers/:id/results body {results:[{question_id, result:0|1|null}]} → 200 {updated}，question_id 不在該卷回 400（訊息字串凍結）；GET /api/students/:id/weakness?subject=&days=90 → {by_chapter:[{chapter, assigned, graded, wrong, wrong_rate, low_sample}], by_type:[…], by_difficulty:[…], trend_weekly:[{week_start, graded, wrong}], recent_wrong:[{question_id, chapter, question_text, assigned_at}]}；WEAKNESS_MIN_N=5 的 low_sample 規則；SQL 用 CTE 外包一層（PG 的 ORDER BY 別名限制，規劃 §4.3.5）；全部在 apiKeyAuth 之後。
2. 組卷家族互斥（WS-A）：utils/pickOnePerFamily.js 的 pickOnePerFamily(rows, shuffle) → rows（每個 COALESCE(variant_of,id) 家族取一題，再對代表 Fisher-Yates）；generatePaper 回應不變（已含 paper_id）。
3. 相似題／變式題 API（WS-B）：POST /api/questions/:id/variants body {count:1..3=1, difficulty_delta:-1|0|1=0, student_id?, force_generate?=false} → 200 {mode:'retrieved', questions:[…同 /similar 的 results 形狀]} 或 202 {mode:'generating', job_id, state:'queued'}；限流 10/min；404／409 字串凍結；retrieved 條件（同 subject、archived_at IS NULL、該生無 attempts、排除藍本家族、cosine ≥ VARIANT_SIM_MIN、數量 ≥ count）。
4. 變式 job 合約（WS-B）：jobs(kind='variant', source_question_id, pdf_sha256 NULL)；agents/generateVariant.js run(ctx, {source, neighbors, difficulty_delta, idx}) → outcome.data 與 payload.extract 同形（interfaces-stage2 第 3.2 條）加 {variant_of_root, anchor_ids}；之後與 PDF job 走同一條狀態機（extracted→hashed→classified→linted→verified→deduped→saved）；新增閘門 utils/variantTextGate.js：textGate({source_text, variant_text}) → {ok, reason:'identical'|'numbers_only'|'too_close'|null, edit_ratio}（normalize 完全相同／數字集合相同且遮罩後相同／Levenshtein ratio < VARIANT_MIN_EDIT → 退回）；跑題閾值 cos(embed(variant), embed(source)) ≥ VARIANT_SIM_MIN；dedup1 排除藍本家族；VARIANT_AUTO_APPROVE=false 時 save 改成 needs_review('awaiting_approval')，approve 時 INSERT questions(origin='variant', variant_of=根節點, chapter_src='ai')；review_reason enum 已有 awaiting_approval，不加新值；job_events.node 加 'generate'（第 7.4 條清單允許新增）。
5. kNN few-shot（WS-B，改 agents/classify.js 的 A 層）：k=8 最近鄰（同 subject、archived_at IS NULL、chapter_src='human' 優先，排除同 pdf_sha256 的題，LEFT JOIN + IS DISTINCT FROM）；短路：前 5 鄰居 ≥4 題 human 且同章、最近鄰 cosine ≥ KNN_VOTE_SIM(0.90) → pass 且 payload.classify.source='knn'、入庫時 chapter_src='knn'；'knn'／'ai' 不得當投票來源；cassette 鍵的 cacheKeyParts.fewShotIds 照舊。
6. 自然語言查題（WS-C）：POST /api/questions/search-nl body {query≤200, student_id?, limit:1..50=20} → 200 {filters:{subject, chapters[], question_types[], difficulty_min, difficulty_max, exclude_student_name, semantic_text, keywords[]}, parse_path:'rules'|'llm'|'llm_failed', fallback_level:0|1|2|3, warnings:[], results:[{id, subject, chapter, question_type, difficulty, question_text, score}]}；utils/nlqHeuristics.js parseQuery(text, {aliases}) → {filters, confident:boolean, semantic_text}；config/chapterAliases.js 形狀 {[alias]: chapter}；LLM 層 agents/schemas/nlq.json 全 enum／整數、MODEL_NLQ、NLQ_TIMEOUT_MS=4000；伺服器再驗（isValidChapter 逐一丟不合法、normalizeDifficulty、students.name 查不到進 warnings）；hybrid 用 queries/hybrid.js（查詢向量 embed() taskType RETRIEVAL_QUERY，queryTokens tokenize(semantic_text)）；回退階梯 0/1/2/3 的定義逐字凍結；sha1(query) LRU 100；限流 30/min。
7. 前端橋接（WS-D）：window.ExamApp 再加 {currentPaperCache, chapters, showSection}（WS-D 決定要哪些，S0 列清單）；index.html 只插三個 <section id="students|nlq|variants"> 錨點與三行 <script type="module">；導覽列加「學生」；組卷結果區「立即批改」連結；FEATURE_STUDENTS／FEATURE_NLQ／FEATURE_VARIANTS 三個旗標經 <meta> 注入（同 FEATURE_PIPELINE 的做法，app.js 由 WS-A 加三個 replaceAll）。
8. eval（WS-B／WS-C 各自寫 suite，WS-D 接進 run.js 與 CI）：--suite nlq（規則覆蓋率、filters 四欄 exact match、Recall@10）、--suite variant（30 藍本：純檢索覆蓋率、各閘門通過率、cost）；golden 檔 eval/golden/nlq.json、variant.json 形狀；thresholds 規則同前（第一次量測 −0.03、只升不降）；CI 不連外：nlq 的 LLM 層與 variant 生成走 cassette replay。
9. 環境變數全名與預設：MODEL_VARIANT（未設退回 MODEL_VERIFY）、MODEL_NLQ（預設 gemini:gemini-3.5-flash）、VARIANT_MAX_PER_REQUEST=3、VARIANT_SIM_MIN=0.80、VARIANT_MIN_EDIT=0.08、VARIANT_LINT_RETRIES=2、VARIANT_TOKEN_BUDGET_USD=0.30、VARIANT_AUTO_APPROVE=false、KNN_VOTE_SIM=0.90、NLQ_TIMEOUT_MS=4000、WEAKNESS_MIN_N=5、FEATURE_STUDENTS=false、FEATURE_NLQ=false、FEATURE_VARIANTS=false；寫進 .env.example（你是唯一可直接改它的 session）；config/features.js 加三個 getter。
10. 檔案所有權表（照 docs/stage3-parallel-prompts.md §1）與 routes/index.js 新區塊 [WS3-A: students]、[WS3-B: variants]、[WS3-C: nlq]、[WS3-D: frontend]（空殼）。
11. 與階段 1／2 介面的銜接：/similar 的 student_id 參數已存在（interfaces.md 第 6 條）；jobs API 形狀不變（interfaces-stage2 第 6 條），前端 variants.js 輪詢 GET /api/jobs/:id；review approve 對 kind='variant' 的 job 多寫 origin='variant'／variant_of。
12. 只增不改：0001–0005 凍結；階段 3 若需欄位從 0006 起。

C. 收尾：npm test 與 npm run test:integration 仍全綠；回報每條的最終決定。不要開始寫任何功能程式。
```

### WS-A — 學生與弱點（3A；Day 1 開，P-02 不等 S0）

```
你負責階段 3 的 WS-A：學生／試卷／批改 API 與弱點面板的 SQL，以及組卷的家族互斥。interfaces-stage3.md 第 1、2、7（app.js 三個 replaceAll）條是契約。

任務順序：
1. P-02（1.5）services/weaknessService.js：建查詢的純函式回 {text, values}（by_chapter／by_type／by_difficulty／trend_weekly／recent_wrong 五條），CTE 外包一層（PG 的 ORDER BY 不能在運算式用輸出別名）；WEAKNESS_MIN_N 標 low_sample；單元測試釘參數順序；test/integration/students.pg.test.js 用 1,000 筆 fixture attempts 比對期望聚合、EXPLAIN (FORMAT JSON) 斷言計畫含 idx_attempts_student_date。
2. P-04（1.5）controllers/studentController.js、paperController.js：第 1 條的五支 API；PATCH results 單一交易 UPDATE attempts SET result, graded_at；question_id 不在該卷回 400（字串逐字）；全部在 apiKeyAuth 之後、routes [WS3-A: students]。app.js 的 serveIndex 加 FEATURE_STUDENTS／FEATURE_NLQ／FEATURE_VARIANTS 三個 replaceAll（第 7 條）。
3. P-06（0.5）utils/pickOnePerFamily.js 純函式 + 單測（每家族等機率，分佈測試比照 utils/shuffle.js 的做法但輕量）；接進 controllers/examController.js 的候選池（候選撈回後分組→每組 shuffle 取一→再 Fisher-Yates）；generatePaper 回應不變、既有整合測試是契約。
4. 整合測試：五支 API 形狀與錯誤字串、PATCH 交易、weakness 聚合正確性。
不要做前端、變式、NL（分屬 D、B、C）。
```

### WS-B — 相似題／變式題 + kNN few-shot（Day 1 開，P-10/P-11a 不等 S0）

```
你負責階段 3 的 WS-B：錯題之後「先檢索、再生成、生成走同一組閘門、首輪人工核准」，以及分類 agent 的 kNN few-shot。interfaces-stage3.md 第 3、4、5、8 條是契約；階段 2 的 jobs 管線（workers/jobRunner.js、agents/*、interfaces-stage2.md）已在 main，變式題要**重用它**，不另寫一條。

任務順序：
1. P-10（0.5）POST /api/questions/:id/variants 的 200 retrieved 分支：用 services/retrievalService 的 hybrid 查同 subject／未封存／該生無 attempts／排除藍本家族（COALESCE(variant_of,id)）／cosine ≥ VARIANT_SIM_MIN，數量 ≥ count 就回 200；不足才 202。routes [WS3-B: variants]、限流 10/min。
2. P-11a（1.5）agents/generateVariant.js + agents/schemas/variant.json（chapter／question_type enum 由 buildSchema 注入，difficulty 1–5；輸出與 payload.extract 同形）；prompt 以藍本 + 前 5 鄰居（排除同家族）為錨點；utils/variantTextGate.js 的只改字閘門（純函式 + 單測）；registerTemplate('variant.v1', …)；eval/golden/variant.json 列 30 個藍本（fixture id）。
3. P-12（3）services/variantService.js：建 jobs(kind='variant', source_question_id) + 每題一列 job_questions（state='extracted'，payload.extract 由 generateVariant 產出，payload.variant 記 variant_of_root／anchor_ids／text_gate／sim）；workers/jobRunner.js 只加 kind='variant' 的認領分支（跳過 extract 節點、從 dedup0 起走同一條狀態機；dedup1 排除藍本家族；VARIANT_AUTO_APPROVE=false 時 save 改 needs_review('awaiting_approval')）；reviewController 的 approve 對 kind='variant' 寫 origin='variant'、variant_of=根節點、chapter_src='ai'（reviewController 是 WS-A 階段 2 的檔——只加這個分支，寫進 questions3-wsB.md 知會）。跑題檢查 cos(embed(variant), embed(source)) ≥ VARIANT_SIM_MIN 在 generate 節點內做。
4. P-11b + eval（1.5）eval/lib/suiteVariant.js：30 藍本 × count 2，純檢索覆蓋率、各閘門通過率、每題 cost；LLM 走 cassette（錄製時 GEMINI_RPM 用 .env 的值）；VARIANT_SIM_MIN 在公開 fixture 上校準（找讓「同概念換數字」過、「跨章」不過的值），結果寫進 docs/variants.md。
5. P-14（1.5）agents/classify.js 的 A 層改為 kNN few-shot（第 5 條）：human-only 投票短路、source='knn'；runner 入庫時 chapter_src 依 source（gate→ai、llm→ai、knn→knn）；updateQuestion 改章節時 chapter_src='human' 已在（WS-A 階段 1）。cassette 鍵不變（fewShotIds）。
6. questions3-wsB.md 記所有介面疑問；回報新環境變數。
不要改前端、nlq、weakness。
```

### WS-C — 自然語言查題（Day 1 開，P-07 不等 S0）

```
你負責階段 3 的 WS-C：自然語言查題——規則為主、LLM 為輔、受限 JSON、SQL 固定。interfaces-stage3.md 第 6、8 條是契約；hybrid 用 queries/hybrid.js（interfaces.md 第 5 條）、查詢向量用 services/llm 的 embed()（taskType RETRIEVAL_QUERY）、分詞用 utils/tokenize.js。

任務順序：
1. P-07（2）config/chapterAliases.js（每個白名單章節至少 3 個口語別名：「牛頓第二定律」→「牛頓運動定律」、「摩擦力」→「摩擦力與向心力」…，自己從 config/chapters.js 展開）+ utils/nlqHeuristics.js parseQuery()（章節別名子字串比對、難度「N 以上／以下／N～M／N 星」、題型、「X 沒寫過／沒做過」、剩餘文字進 semantic_text；有命中 ≥1 章節即 confident）純函式 + 單測；eval/golden/nlq.json 50 句草稿（自編、涵蓋：只有章節／章節+難度／章節+題型+學生／口語別名／完全沒章節只有概念詞／模糊句），每句標期望 filters 與期望命中的 fixture 題 id。
2. P-08（2）services/nlqService.js + POST /api/questions/search-nl：規則 → 規則沒抓到章節且剩餘有實詞才呼叫 generateJson（agents/schemas/nlq.json 全 enum／整數、MODEL_NLQ、NLQ_TIMEOUT_MS、registerTemplate('nlq.v1')）→ 伺服器再驗（isValidChapter 逐一丟、normalizeDifficulty、students.name 查不到進 warnings 不自動建）→ hybrid（buildHybridQuery：metadata 篩選 + queryVector(embed) + queryTokens）→ 回退階梯 0/1/2/3 逐字照第 6 條 → sha1(query) LRU 100；限流 30/min；routes [WS3-C: nlq]。
3. eval（1）eval/lib/suiteNlq.js：規則覆蓋率（規則就抓到章節的比例）、filters 四欄 exact match（規則路徑 vs LLM 路徑分開）、Recall@10（對 fixture 灌進測試庫跑 hybrid）；LLM 路徑走 cassette；WS-D 會把 suite 接進 run.js 與 CI——你只要匯出 runSuite(ctx) 的函式形狀照 suiteClassify.js。
4. 整合測試 test/integration/nlq.pg.test.js：端點形狀、回退階梯每一級都能觸發（關掉 embed → level 3；hybrid 0 筆 → level 2；LLM 逾時 → level 1）。
5. questions3-wsC.md 記疑問；回報新環境變數。
不要改前端、students、variants。
```

### WS-D — 前端 + README + e2e（Day 1 開，mock 先行）

```
你負責階段 3 的 WS-D：三個新分頁的前端（vanilla + ES module，經 window.ExamApp 橋接）、README 的「問題→決策→數字」骨架、e2e。interfaces-stage3.md 第 1、3、6、7、8 條是契約；public/index.html 目前 1,111 行，階段 2 已有 public/js/review.js 與 window.ExamApp 橋接可參考。

任務順序（全部先對手寫 mock JSON 做，API 合入後接線）：
1. P-05（3）public/js/students.js：學生下拉 → 試卷列表（每張可展開、每題三態「對／錯／未批」+「儲存批改」→ PATCH）→ 弱點三張表（純 CSS 橫條、low_sample 標「樣本不足」）→ ≤60 行 inline SVG 週趨勢 → 最近錯題每列「找相似／出變式」按鈕（呼叫 variants.js）；index.html 插 <section id="students"> 與 module 標籤、導覽列「學生」、組卷結果區「立即批改」連結（currentPaperCache 多存 paper_id）。
2. P-09（1）public/js/nlq.js：題庫管理搜尋框旁的 NL 查題框 → search-nl → filters 回寫 mgr_subject／mgr_chapter／mgr_type 下拉 → parse_path='llm_failed' 或 fallback_level ≥1 顯示淡黃提示（文字寫清楚系統理解成什麼）。
3. P-13（1）public/js/variants.js：POST variants → 200 直接顯示相似題 / 202 每 2 秒輪詢 GET /api/jobs/:id 最多 60 秒 → 每題狀態 chip（生成中／檢查中／待核准／已入庫／失敗+原因）、按鈕輪詢期間停用、完成後顯示實際 cost_usd；待核准項目提示去複核分頁。
4. 旗標：三個分頁各自讀 <meta name="feature-students|nlq|variants">（parseBool 與 config/features.js 逐字相同），關閉時整段不渲染；npm run check:html 擴到三個新檔。
5. eval 接線：eval/run.js 加 --suite nlq／--suite variant（呼叫 WS-C／WS-B 匯出的 runSuite），thresholds.json 加兩個 suite；ci.yml integration job 加兩個 suite（replay）。
6. E-X15（1）test/e2e/：① 上傳 sample_exam.pdf → jobs 走完 → 部分入庫（對 postgres_test、LLM replay）；② 組卷 → download-word 含 <m:oMath>。
7. P-15a（0.5）exam_pro/README.md：每個功能一列「問題（引行號）→ 決策 → 數字（eval 輸出，含日期與模型 ID）」的三欄表骨架，數字欄先留「待 eval」；P-15b 等全部 suite 有基準線再填。
8. questions3-wsD.md 記疑問。
不要改 controllers、services、agents、workers（只呼叫）。
```

## 3. 你的人工 lane（按時間）

| 時機    | 你要做的事                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0   | 看 S0 的 interfaces-stage3.md 逐條拍板、合進 main                                                                                                         |
| Day 1   | 四個 worktree 開新分支 + 新 Claude 對話，貼提示詞                                                                                                         |
| 第 1 週 | 寫／定案 NL golden 50 句（用你平常會講的話：「牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過」這種）；挑 30 題變式藍本；review 先合入 A（3A 先上） |
| 第 2 週 | 用新「學生」分頁批改幾張真卷，讓弱點面板有真資料；試幾次 NL 查題、變式生成；50 題變式人工品質評分                                                         |
| 第 3 週 | 四合一試合併與裁決（我做）；P-15b 填數字；決定 VARIANT_AUTO_APPROVE、P-16 模板是否需要                                                                    |

## 4. 常見碰撞與處理

- `agents/classify.js` 與 `workers/jobRunner.js`、`controllers/reviewController.js` 是階段 2 的檔：階段 3 只有 WS-B 可改、且只加分支；`agents/schemas/` 按檔案分。
- `eval/run.js` 歸 WS-D；WS-B／WS-C 只匯出 suite 函式，不改 run.js。
- `public/index.html` 只有 WS-D 可改；其他 WS 要前端改動寫進 questions3-wsX.md。
- 任何 session 說「介面需要改」：先停、看 `docs/questions3-wsX.md`，你決定後改 `interfaces-stage3.md` 並通知其他三個 session。
