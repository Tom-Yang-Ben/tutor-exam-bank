# 階段 2 Agent 管線：多開 Claude Code 的平行分工與提示詞

> 搭配 `docs/roadmap-plan.md` §3（階段 2 Agent 管線）、§5.3.2–3.3（golden、record/replay）使用；任務 ID 沿用規劃 §1 的 A-T*／E-X*。
> 流程與階段 1 相同：**S0 先凍結介面（`docs/interfaces-stage2.md`）→ 四條 workstream 各自 worktree 平行 → 試合併 → 裁決**。
> 階段 1 的 `docs/interfaces.md` 仍然有效且**不得修改**（裁決 1–27）；階段 2 的新介面全部寫在 `docs/interfaces-stage2.md`。

## 0. 開工前的機械準備（你自己做，5 分鐘）

四個 worktree 沿用，但要從 main 開**新分支**，並且每個 worktree **開新的 Claude 對話**（舊對話帶著階段 1 的假設）：

```powershell
# 主目錄（S0 用）
cd C:\Users\Administrator\Desktop\期中專案 ; git checkout main ; git pull ; git checkout -b s0/stage2

# 四個 worktree 各自執行（A/B/C/D 各換名字）
cd C:\Users\Administrator\Desktop\期中專案-wsA ; git checkout main ; git pull ; git checkout -b ws2-a/pipeline
cd C:\Users\Administrator\Desktop\期中專案-wsB ; git checkout main ; git pull ; git checkout -b ws2-b/llm-agents
cd C:\Users\Administrator\Desktop\期中專案-wsC ; git checkout main ; git pull ; git checkout -b ws2-c/gates
cd C:\Users\Administrator\Desktop\期中專案-wsD ; git checkout main ; git pull ; git checkout -b ws2-d/eval-ui
```

`.env` 與 `node_modules` 各 worktree 都已有（階段 1 留下）；S0 合入 main 後各 worktree `git merge main` 再 `cd exam_pro && npm ci`。
Docker 的 `exam_pg`／`exam_pg_test` 照舊；階段 2 多一支 `migrations/0003_jobs.sql`（S0 寫），由 S0 套到兩個庫。

## 1. 分工總表

| Session                                    | 何時開                | 任務（規劃 ID）                                                                                                                                                                                                 | 擁有的檔案（別人不得改）                                                                                                                                                                                                                                                                                                 | 交付／同步點                                                                                                                                                                                               |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S0 基礎與介面凍結**（序列，~1 天） | Day 0                 | A-T0 spike、A-T1`0003_jobs.sql` + `backfill_text_hash.js`、`docs/interfaces-stage2.md`                                                                                                                    | `migrations/0003_jobs.sql`、`scripts/backfill_text_hash.js`、`docs/interfaces-stage2.md`、`.env.example`、`config/chapterExamples.js`（空殼）                                                                                                                                                                  | **I0'**：介面凍結 + `0003` 套在兩個庫；合進 main 後四條才開                                                                                                                                        |
| **WS-A 管線核心**                    | I0' 後                | A-T2 狀態機 → A-T11 jobRunner → A-T12 jobs／review API → A-T15`report:jobs`；抽出 `utils/questionValidation.js`                                                                                          | `pipeline/`、`workers/`、`controllers/jobController.js`、`controllers/reviewController.js`、`utils/questionValidation.js`（從 `questionController.js` 抽出，只加 `module.exports`）、`scripts/report_jobs.js`、`routes/index.js` 的 `[WS2-A: jobs]` 區塊、`server.js`（啟動 runner）               | **I5' jobs API 可用**：WS-D 的 review.js 接線、WS-B/C 的 agents 由 runner 驅動                                                                                                                       |
| **WS-B LLM 層與前段 agents**         | I0' 後（T3 可 Day 1） | A-T3`services/llm` 的 `generateJson` 完整版（gemini／fake(replay)／throttle／record-replay／`models.js`／`pricing.js`）→ A-T8 extract → A-T9 classify                                                 | `services/llm/*`（`embed()` 既有行為不得改）、`config/models.js`、`config/pricing.js`、`agents/extract.js`、`agents/classify.js`、`agents/schemas/extract.json`、`classify.json`、`config/chapterExamples.js`（填內容）、`eval/cassettes/**`（錄製）                                                 | **I3' LLM 層可用**：其他 WS 的 LLM 呼叫全走它                                                                                                                                                        |
| **WS-C 閘門零件與後段 agents**       | Day 1（不等 DB）      | A-T4`parseLatexStrict` 事件 + `formulaFix.js`／`formulaLint.js` + 公式 golden 150 → A-T5 `answerCompare.js`／`normalizeStem.js` → A-T10a lint → A-T10b verify → A-T10c dedup（L0 雜湊 + L1 向量） | `utils/textFormatter.js`（只加事件收集與匯出，29 項測試是契約）、`utils/formulaFix.js`、`utils/formulaLint.js`、`utils/answerCompare.js`、`utils/normalizeStem.js`、`agents/lint.js`、`agents/verify.js`、`agents/dedup.js`、`agents/schemas/verify.json`、`lint.json`、`eval/golden/formula.json` | **I4' 閘門可用**：WS-D 的公式／答案 eval、WS-A 的 save 節點                                                                                                                                          |
| **WS-D 評估與前端**                  | Day 1（不等 DB）      | A-T6 golden 草稿（章節 100／答案 50／重複 30 組；公式 golden 由 WS-C）→ E-X12a legacy 基準線腳本 → A-T14 `eval --suite classify                                                                               | pipeline`+ cassette 回放 +`compare_pipeline.js`→ A-T13 前端`public/js/review.js`（上傳→輪詢→複核分頁，mock 先行）→ CI 加 pipeline suite                                                                                                                                                                          | `eval/**`（cassettes 目錄除外）、`test/unit/`、`test/integration/`（controller 以外）、`public/index.html`、`public/js/review.js`、`.github/workflows/ci.yml`、`package.json` 的 `scripts` |
| **人工 lane（你）**                  | 全程                  | A-T0 的模型 ID／金鑰決定；golden 逐筆定案（章節 100、答案 50、重複 30、公式 150 的`expect`）；E-X12a 私有 PDF 答案卷標註；A-T16 前後對照（連外、手動）；A-T17 是否接異家模型的決定；每個 PR review 與合併     | —                                                                                                                                                                                                                                                                                                                       | 瓶頸仍是標註與審查                                                                                                                                                                                         |

**相依一句話**：S0 → {A, B, C, D 同時開}；A 的 runner 要跑真 agent 要等 B/C 合入（先用 fake agent）；D 的 `eval:pipeline` 要等 B/C 合入並錄好 cassette；D 的 review.js 接線要等 A 的 API；全部合入後才做 A-T16。

**階段 2 的設計原則提醒**（規劃 §3.4）：協調層是純函式狀態機，LLM 只在判斷節點；每個節點後面都有不可繞過的硬閘門（`ajv` schema、`isValidChapter`、`parseLatexStrict` 事件為空、`answerCompare`、雜湊／向量閾值）；重試有預算；部分入庫取代整批退回。

## 2. 每個 session 的提示詞

所有提示詞共用的開頭（貼在每一份最前面，`wsX`／分支名自行替換）：

```
你在 C:\Users\Administrator\Desktop\期中專案-wsX（git worktree，分支 ws2-x/...）工作，主要程式在 exam_pro/。專案目前跑在 PostgreSQL 16 + pgvector（Docker，開發 5442 / 測試 5433），階段 1 已完成（見 docs/interfaces.md 裁決 1–27）。
先完整讀：docs/roadmap-plan.md 的 §3（階段 2 Agent 管線）全章與 §5.3.2–3.3（golden、record/replay）、docs/interfaces-stage2.md（階段 2 凍結介面，最高優先）、docs/interfaces.md（階段 1 介面，仍有效）、exam_pro/README.md、docs/stage2-parallel-prompts.md 的分工總表。
硬規則：
1. 只改你「擁有的檔案」（interfaces-stage2.md §10 的所有權表）。共用檔：routes/index.js 只能在你的註解區塊內 append；package.json 只加自己需要的 deps，scripts 由 WS-D 統一；.env.example 不直接改，新變數列在 PR 描述。
2. docs/interfaces.md 與 docs/interfaces-stage2.md 是凍結介面，不得修改。發現介面有問題：停下來，寫進 docs/questions2-wsX.md 並在回報中明講，不要自行改介面繞過。
3. npm test 必須維持不連 DB、不連 Gemini、不需 secrets；LLM 一律經 services/llm 的 generateJson()，單元測試用 LLM_MODE=replay 的 fake adapter 或 ctx 注入；需要 PG 的測試放 test/integration/（只讀 TEST_DATABASE_URL、_test 後綴、npm run test:integration 有 --test-concurrency=1）。
4. 不得把真實考卷題目、PDF、LLM 對真題的回應寫進 repo；cassette 只能錄公開 fixture（eval/fixtures/questions.public.json）與自製 sample_exam.pdf 的呼叫，私有層放 eval/private/（gitignore）。
5. 繁體中文註解與 commit，小步 commit，不 push main。
6. Windows 11：.bat 以 chcp 65001 起手；檔案一律由 Node 寫；路徑含中文要 path.resolve + UTF-8；PowerShell 沒有行內 VAR=x 語法，環境變數寫 .env 或 --env-file。
完成後回報：做了什麼（對應任務 ID）、怎麼驗證（貼測試輸出）、新環境變數、未完成與原因、給其他 workstream 的注意事項。
```

### S0 — 基礎與介面凍結（Day 0，主目錄、分支 s0/stage2，一個 session 序列做）

```
你是階段 2「介面凍結與基礎」負責人。產出會被四條平行 workstream 當成不可變契約，寧可具體、不可含糊。依序完成：

A. A-T0 Spike（半天，需要 .env 的 GEMINI_API_KEY，結論要寫進 interfaces-stage2.md 第 0 條）
- @google/genai 目前版本對 responseJsonSchema／responseSchema 的支援：34 個中文章節 enum + question_type 5 個 enum + additionalProperties:false 能不能用？不能就記「退路 = schema 不含 enum + prompt 列舉 + ajv 伺服器端閘門」。
- inlineData 上傳 PDF 的實際大小上限與 Files API 的門檻；pdf-lib 切塊每塊 20 頁是否合理。
- 當日可用的模型 ID：拆題用（Flash 系列）、驗證用（Pro 系列）各一個，以及 usageMetadata 的欄位名（promptTokenCount / candidatesTokenCount / thoughtsTokenCount / cachedContentTokenCount 是否都有）。
- 以上用 3～5 次真呼叫確認即可，不要跑大量；把呼叫用的小腳本放 scripts/spike_genai.js 供日後重驗。

B. A-T1 migrations/0003_jobs.sql + scripts/backfill_text_hash.js
- DDL 以規劃 §3.3.2 為底（jobs / job_questions / job_events + questions.text_hash 非唯一索引），PG 版；併入規劃 §4.3.1 的 jobs.kind（'pdf'|'variant'）與 source_question_id（階段 3 用，CHECK 約束照寫）；jobs.pdf_sha256 可為 NULL（kind='variant' 時）。
- job_questions.state 的合法值、review_reason 與 job_events.error_class 的 enum 都用 CHECK 寫死（字串值見 D.2）。
- backfill_text_hash.js：對 questions 用 utils/normalizeStem（尚未存在——本腳本先以「介面第 4 條定義的正規化規則」自含一份實作並標明 TODO 換成 WS-C 的 utils/normalizeStem.js）回填 text_hash，印碰撞清單，不建 UNIQUE。
- 用 npm run migrate:test 與 npm run migrate 套到測試庫與開發庫，各跑兩次（第二次 no-op），輸出貼回報。

C. config/chapterExamples.js 空殼（每個 config/chapters.js 章節一個鍵、值為空字串），由 WS-B 填內容。

D. docs/interfaces-stage2.md（I0' 凍結清單）——每條都要具體簽名／形狀，不可寫「待定」：
0. Spike 結論（A 的四點）與由此決定的環境變數預設值。
1. 最終 DDL（0003 的表與欄位摘要）與 PDF 存放：data/jobs/<job_id>.pdf（.gitignore 加 data/），拆題完成後可刪檔並清空 pdf_path。
2. 狀態機：job_questions.state 序列 extracted → hashed → classified → linted → verified → deduped → saved，終態 saved / needs_review / rejected；NODE_FOR_STATE 表；outcome 型別 {kind:'pass',data} | {kind:'skipped'} | {kind:'fail',reason,feedback} | {kind:'error',errorClass}；transition({state, retries, outcome, limits}) → {state, retries, review_reason} 的完整規則（規劃 §3.3.3）；limits 預設 {maxRetries:{classify:2,lint:2,verify:1}}；review_reason enum：chapter_invalid / formula_unparsable / answer_mismatch / duplicate / budget_exceeded / provider_error / schema_invalid / awaiting_approval；error_class enum：schema_invalid / chapter_invalid / formula_unparsable / answer_mismatch / duplicate / provider_error / rate_limited / timeout / budget_exceeded；jobs.state：queued / extracting / processing / done / failed。
3. Agent 合約：agents/<name>.js 匯出 run(ctx, input) → Promise<outcome>；ctx = { llm:{generateJson, embed}, db:{pool, query}, job:{id, budget_usd, cost_usd}, jq:{id, idx, payload, retries}, logger, config:{models, limits, thresholds} }；每個節點的 input 與 payload 鍵（payload.extract / dedup0 / classify / lint / verify / dedup1，各自的欄位照規劃 §3.3.4 表格逐欄寫出）；JSON schema 檔路徑 agents/schemas/<node>.json 與「chapter／question_type 的 enum 在啟動時由 config/chapters.js 注入」的組裝函式簽名 buildSchema(name) → object。
4. utils 純函式簽名：normalizeStem(text) → string（剝 [附圖描述：…]、所有 $、空白換行、全半形、選項代號統一成 (A)、小寫）→ text_hash = sha256 hex；answerCompare({question_type, claimed, model:{final_answer, answer_form}}) → 'agree'|'disagree'|'uncertain'；parseLatexStrict(str) → {ok, children, events:[{kind, at}]}，事件種類 unknown_command / missing_rbrace / empty_fallback / parser_error / tokenize_error / bare_script；formulaLint(text) → {ok, issues:[{sev:'error'|'warn', rule, at, msg}]}；formulaFix(text) → {text, applied:[rule]}；validateQuestionFields(q) → {ok, errors}（從 questionController.js 抽出，行為不變）。
5. services/llm：generateJson 簽名沿用 interfaces.md 第 4 條；新增 LLM_MODE=record|replay 的 cassette 規則（規劃 §5.3.3）：鍵 = sha256(agent + model + promptTemplateHash + schemaHash + JSON.stringify(cacheKeyParts))，cacheKeyParts 由 agent 傳（classify 傳 few-shot 的 id 清單而非全文）；檔案 eval/cassettes/<agent>/<key>.json，內含 {meta:{agent, model, template, recorded_at, fixtureHash}, request:{parts 摘要}, response:{data, usage, latencyMs}}；replay miss 一律丟錯並印「請在本機執行 npm run eval:record -- --suite <x>」（fork PR 降 warning 由 CI 判斷）；throttle.acquire(vendor) 令牌桶（RPM 與併發）；config/models.js 解析 'vendor:model-id'，MODEL_VERIFY 與 MODEL_EXTRACT 同 ID 時啟動印警告；config/pricing.js 形狀 {[modelId]:{input, output, cached, verified_on}}，查不到記 cost_estimated=false。
6. HTTP API（掛在 apiKeyAuth 之後、routes/index.js 的 [WS2-A: jobs] 區塊）：POST /api/jobs（multipart pdf；沿用 aiRateLimit；同 pdf_sha256 未 failed 者回既有 job；?force=1）→ 202 {job_id, existing:boolean}；GET /api/jobs/:id → {id, state, counts:{saved, needs_review, pending, rejected}, token_in, token_out, cost_usd, budget_usd, elapsed_ms}；GET /api/jobs/:id/questions?page=&limit= → {total, items:[{jq_id, idx, state, review_reason, stem_preview(80 字), question_id}]}；GET /api/review?reason=&limit= → {items:[…同上加 job_id]}；GET /api/review/:jqId → 完整 payload；POST /api/review/:jqId/approve（body 為修正後欄位 + accept_plain_text? + merge_into?）→ 200 {question_id} 或 400 {errors}；POST /api/review/:jqId/reject → 200；POST /api/jobs/:id/retry（body {budget_usd?}）→ 202；錯誤訊息字串逐字凍結。
7. Worker：workers/jobRunner.js 以 setInterval(JOB_POLL_MS) 認領（SELECT … FOR UPDATE SKIP LOCKED + locked_until 租約，呼叫中每 30 秒續租）；JOB_RUNNER=inline|off；node workers/jobRunner.js 可獨立跑；每次 LLM／閘門呼叫寫一列 job_events；預算三層（規劃 §3.3.5）與 DAILY_COST_BUDGET_USD。
8. 前端：public/js/review.js 為 ES module，由 window.ExamApp 橋接（apiFetch / showToast / renderMath / escapeHtml / createQuestionEditor）；index.html 只插一個 <section id="review"> 錨點與一行 <script type="module">；舊的 /analyze-pdf + batch-save-questions 流程保留；FEATURE_PIPELINE=true 時上傳區改走 POST /api/jobs。
9. 環境變數全名與預設：MODEL_EXTRACT、MODEL_VERIFY（由 spike 決定具體 ID，寫 'gemini:<id>' 形式）、ANTHROPIC_API_KEY（預留，未用）、LLM_MODE（既有）、EVAL_CASSETTE_DIR（裁決 25 在此定案：預設 eval/cassettes，私有 golden 時由 run.js 改為 eval/private/cassettes）、JOB_RUNNER、JOB_POLL_MS=2000、JOB_CONCURRENCY=2、JOB_LEASE_MS、JOB_NODE_TIMEOUT_MS=120000、JOB_COST_BUDGET_USD、DAILY_COST_BUDGET_USD、JOB_PDF_CHUNK_PAGES=20、GEMINI_INLINE_MAX_BYTES、CLASSIFY_MIN_CONF=0.8、DEDUP_DUP_THRESHOLD=0.97、DEDUP_VARIANT_THRESHOLD=0.90、FEATURE_PIPELINE=false；把它們寫進 .env.example（你是唯一可直接改它的 session）。
10. 檔案所有權表（照 docs/stage2-parallel-prompts.md §1）與 routes/index.js 新增四個區塊：[WS2-A: jobs]、[WS2-B: llm]、[WS2-C: gates]、[WS2-D: eval]（先建空區塊）。
11. migrations 只增不改：0003 合入後即歷史；0004 已用（origin legacy），階段 2 新欄位從 0005 起。

E. 收尾：npm test 268 項仍全綠、npm run test:integration 76 項仍全綠；回報 I0' 每條的最終決定。不要開始寫任何 agent、狀態機或 eval 程式。
```

### WS-A — 管線核心（I0' 後開）

```
你負責階段 2 的 WS-A：狀態機、worker、jobs／review API、報表。S0 已合入 main（0003_jobs.sql、interfaces-stage2.md）。請先 git merge main && npm ci。

任務順序與驗收：
1. A-T2（1 人日）pipeline/stateMachine.js：純函式 transition()，完全照 interfaces-stage2.md 第 2 條；test/unit/stateMachine.test.js 窮舉 (state × outcome.kind × retries) 並加性質測試「任意 outcome 序列在 Σ maxRetries + 6 步內達終態、不迴圈」；100% 分支覆蓋。
2. utils/questionValidation.js（0.25）：從 controllers/questionController.js 抽出 validateQuestionFields 並 module.exports，controller 改 require 它，行為一字不改（既有整合測試是契約）。
3. A-T11（1.5）workers/jobRunner.js：依第 7 條——認領（同一交易兩句 + SKIP LOCKED + locked_until）、續租、JOB_CONCURRENCY、節點逾時（AbortController）、三層預算 + DAILY_COST_BUDGET_USD、每次呼叫寫 job_events、error 退避（1s→60s 最多 3 次後 provider_error）。節點實作從 agents/<name>.js 動態 require；在 B/C 合入前用 test/fixtures/fakeAgents/ 的假 agent 測 runner 行為。server.js 在 JOB_RUNNER=inline 時啟動；node workers/jobRunner.js 可獨立跑。
4. A-T12（1）controllers/jobController.js + reviewController.js + routes [WS2-A: jobs] 區塊：六支 API 形狀與錯誤字串照第 6 條；POST /api/jobs 存檔到 data/jobs/、算 sha256、冪等；approve 要重跑 validateQuestionFields + formulaLint（WS-C 的，合入前先只跑前者並留 TODO）並在同一交易 INSERT questions（origin='pdf'、chapter_src='ai'、text_hash、search_tsv/embedding 交給 embedService.embedByIds，失敗只記 log）。
5. A-T15（0.5）scripts/report_jobs.js（npm script 由 WS-D 加 report:jobs）：--since=7d，每節點 p50/p95 延遲、token、cost、error_class 與 review_reason 分佈、每份 PDF 平均成本、classify 零成本閘門通過率、verify 同家／異家標示；程序日誌一行一個 JSON。
6. 整合測試 test/integration/jobs.pg.test.js：runner 對假 agent 的完整流程（部分入庫 + needs_review + 預算超線 + 租約不重認領）、六支 API 的形狀與錯誤字串；只讀 TEST_DATABASE_URL。
7. 回報新環境變數與 routes 區塊變更。

不要做：agents/*、services/llm/*、公式／答案閘門、前端、eval（分屬 B、C、D）。
```

### WS-B — LLM 層與前段 agents（T3 可 Day 1 開）

```
你負責階段 2 的 WS-B：把 services/llm 的 generateJson 做完整（含 record/replay），再寫 extract 與 classify 兩個 agent。interfaces-stage2.md 第 3、5 條與 interfaces.md 第 4 條是契約。

任務順序：
1. A-T3（3 人日）services/llm/：gemini.js 的 generateJson 完整版（responseJsonSchema 或 spike 決定的退路、usage 四欄含 thinking、latencyMs、AbortSignal）；fake.js = replay adapter（依第 5 條 cassette 鍵與檔案格式，miss 丟錯）；record 模式呼叫真模型並寫 cassette；throttle.js 令牌桶（RPM + 併發，每供應商一個）；config/models.js、config/pricing.js（標 verified_on）；embed() 既有行為與測試不得改。單元測試全部走 replay 或注入，不連外。
2. A-T8（1）agents/extract.js + agents/schemas/extract.json：PDF 超過 JOB_PDF_CHUNK_PAGES 用 pdf-lib 切塊，每塊一次 generateJson；ajv 逐元素驗證，合格元素各建一筆 outcome 資料、不合格只記 schema_invalid；整包不合格才 fail；章節／題型 enum 由 buildSchema 注入；prompt 的白名單由 config/chapters.js 產生（刪掉 aiService.js 手抄那份，aiService.analyzePdfContent 改成呼叫本 agent 的相容包裝，/analyze-pdf 回應形狀不變——既有測試是契約）。
3. A-T9（1.5）agents/classify.js + schemas/classify.json：第一層零成本閘門（isValidChapter 且 chapter_confidence ≥ CLASSIFY_MIN_CONF → pass 不呼叫 LLM）；第二層 few-shot：FEATURE_SIMILAR 開且來源題有向量時用 retrievalService 取 5 題，否則各章取例 + config/chapterExamples.js（把空殼填滿：每章一句自製例題）；cacheKeyParts 傳 few-shot id 清單；輸出過 isValidChapter；失敗 feedback「X 不在白名單，最接近的是 …」。
4. 用 eval/fixtures/sample_exam.pdf（WS-D 會產；若尚未合入，先用 pdfkit 在 scripts/ 造一份 6 題的自製 PDF 放 eval/fixtures/）錄 extract 與 classify 的 cassette 進 eval/cassettes/（只能錄公開 fixture）。
5. docs/llm.md：模式切換、cassette 鍵規則、怎麼重錄；回報新 deps（ajv、pdf-lib）、新環境變數。

不要改 pipeline/、workers/、agents/lint|verify|dedup、utils/textFormatter、eval/run.js。
```

### WS-C — 閘門零件與後段 agents（Day 1 開，不等 DB）

```
你負責階段 2 的 WS-C：公式閘門、答案比對器、題幹正規化，與 lint／verify／dedup 三個 agent。interfaces-stage2.md 第 3、4 條是契約；utils/textFormatter.js 的 29 項既有測試是不可動的契約。

任務順序：
1. A-T4（2 人日）utils/textFormatter.js 只「加」：createParser／tokenize 內埋事件收集（unknown_command :265、missing_rbrace :115、empty_fallback :277、parser_error :278、tokenize_error :286、bare_script :308-318），新匯出 parseLatexStrict(str) → {ok, children, events}；既有 buildParagraphComponents 輸出逐位元不變（寫一個對照測試）。utils/formulaFix.js（搬 fix_formulas.js 的確定性規則）、utils/formulaLint.js（搬 audit_formulas.js 規則 + parseLatexStrict）；eval/golden/formula.json 150 筆草稿（既有測試案例 + fix_formulas 型樣 + 六類規則各 20 筆，expect 欄留給開發者目視定案），以 node --test 表格測試跑。
2. A-T5（0.5）utils/normalizeStem.js（規則照第 4 條，含 text_hash）與 utils/answerCompare.js（選項集合比對、填空／計算先抽 final_answer、有理數／\frac／負號／單位正規化、比不出回 uncertain）；單元測試涵蓋等價形與典型錯答。
3. A-T10a（0.5）agents/lint.js：formulaFix → formulaLint → 仍有 error 才 generateJson 重寫（輸入原文 + issues；LLM 經 ctx.llm，測試注入假的）；閘門 = 無 error；重試 2 → formula_unparsable。
4. A-T10b（0.5）agents/verify.js + schemas/verify.json：證明題 skipped；prompt 只含題幹與題型，claimed_answer 只交給 answerCompare；uncertain 再採樣一次；disagree → answer_mismatch，payload 存兩個答案。
5. A-T10c（0.5）agents/dedup.js：L0 = normalizeStem 雜湊比對庫內 text_hash 與同 job 先出現者（任何 LLM 前）；L1 = 向量餘弦（embedService/retrievalService 既有函式）≥ DEDUP_DUP_THRESHOLD → duplicate、≥ DEDUP_VARIANT_THRESHOLD → variant 照常入庫並記候選；來源題沒向量時 L1 skipped。
6. 單元測試全部純函式或注入；整合測試（dedup L1 對真 PG）放 test/integration/dedup.pg.test.js。
7. 回報：公式 golden 的 expect 哪些需要開發者開 Word 目視。

不要改 services/llm/*、agents/extract|classify、pipeline/、eval/run.js。
```

### WS-D — 評估與前端（Day 1 開，不等 DB）

```
你負責階段 2 的 WS-D：管線 golden、legacy 基準線、eval 的 classify／pipeline suite 與 cassette 回放、CI，以及前端的 jobs 上傳／輪詢／複核分頁。規劃 §5.3.2–3.5 與 interfaces-stage2.md 第 6、8 條是契約。

任務順序：
1. A-T6（1.5）golden 草稿：eval/golden/classify.json（公開 fixture 60 題 + 30 筆章節漂移變體：同一題幹改寫、章節名同義詞）、answer.json（50 題：標準答案與 3 種等價寫法、2 種典型錯答）、dedup.json（30 組：逐字重複／重傳／換數字／不同題）；schema 寫在檔頭，全部標 needs_human_confirm。公式 golden 由 WS-C。
2. E-X12a（1.5）eval/compare_pipeline.js --method legacy：對 --pdfs <dir> 的每份 PDF 跑舊的 aiService.analyzePdfContent（保留為 services/legacy/analyzePdf.js 的相容呼叫），對照 --golden 的答案卷輸出 q_expected | q_extracted | extract_recall | chapter_acc | formula_strict_rate | token_in | token_out | cost_usd | latency_ms | model | prompt_hash；私有 PDF 與答案卷放 eval/private/pdf_golden/（gitignore）；公開用自製 eval/fixtures/sample_exam.pdf（pdfkit 產、內嵌 Noto Sans TC、固定 CreationDate；產生腳本 eval/fixtures/make_sample_pdf.js 只在本機跑）。
3. A-T14（1.5）eval/run.js 加 --suite classify（cassette 回放 vs golden，accuracy／macro-F1／Top-5 混淆對）與 --suite pipeline（對 sample_exam.pdf 以 LLM_MODE=replay 跑整條管線：各節點通過率、needs_review 原因分佈、每份 cost）；thresholds.json 加兩個 suite（ratchet）；compare_pipeline.js 加 --method pipeline 欄位（answer_agree_rate | dedup_hits | saved | needs_review）。B/C 合入前先對 interfaces 的 outcome 形狀寫，用 stub。
4. A-T13（1.5）public/js/review.js（ES module，經 window.ExamApp 橋接）：FEATURE_PIPELINE 開時上傳區改 POST /api/jobs → 每 3 秒輪詢 GET /api/jobs/:id → 「已入庫 N／待複核 M／處理中」；複核分頁列 GET /api/review，每張卡片沿用 createQuestionEditor 並在頂端顯示原因列（機器產生的具體原因）、按鈕「修正入庫／略過」；先對手寫 mock JSON 做，API 合入後接線；index.html 只插一個 <section id="review"> 與一行 <script type="module">；改完跑 npm run check:html（若尚無此 script 就加：對 inline script 與 public/js/*.js 做 node --check）。
5. CI：integration job 加 npm run eval -- --suite classify 與 --suite pipeline（replay）；package.json scripts 加 report:jobs、eval:classify、eval:pipeline、check:html；unit job 不得設 TEST_DATABASE_URL。
6. 回報 golden 哪些欄位等開發者定案。

不要改 services/llm/*、agents/*、pipeline/、controllers/*（只呼叫）。
```

## 3. 你的人工 lane（按時間）

| 時機    | 你要做的事                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0   | 看 S0 的 spike 結論與`interfaces-stage2.md` 逐條拍板、合進 main；決定 `MODEL_EXTRACT`／`MODEL_VERIFY` 的具體 ID                                 |
| Day 1   | 四個 worktree 開新分支 + 新 Claude 對話，貼提示詞                                                                                                     |
| 第 1 週 | 優先 review／合入 WS-B 的 A-T3（LLM 層是所有 agent 的地基）與 WS-A 的狀態機；開始逐筆定案 golden（章節 100、答案 50、重複 30、公式 150 的`expect`） |
| 第 2 週 | 挑 10 份私有 PDF 寫答案卷（題數、每題章節、標準答案）放`eval/private/pdf_golden/`；跑 `compare_pipeline --method legacy` 得基準線                 |
| 第 3 週 | 四合一試合併（我做）；全部合入後跑 A-T16 前後對照（連外、手動）；看`answer_mismatch` 檢出率決定要不要接異家模型（A-T17）                            |
| 之後    | 決策總表裡的條件：classify 零成本閘門通過率 > 95% → LLM 層降為抽樣；`answer_mismatch` > 15% 先查 prompt                                            |

## 4. 常見碰撞與處理

- `agents/` 目錄由 WS-B（extract、classify）與 WS-C（lint、verify、dedup）共用：**按檔案**分，不要動對方的檔；`agents/schemas/` 同理。
- WS-A 的 runner 在 B/C 合入前用 `test/fixtures/fakeAgents/`；WS-D 的 eval:pipeline 在 B/C 合入前用 stub——都不要等。
- 任何 session 說「介面需要改」：先停、看 `docs/questions2-wsX.md`，你決定後改 `interfaces-stage2.md` 並通知其他三個 session。
- 四合一試合併與裁決流程同階段 1（我在 scratchpad 做，跑 unit + `npm run test:integration` + eval 三個 suite）。
