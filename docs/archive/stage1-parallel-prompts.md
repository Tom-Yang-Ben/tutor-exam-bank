# 階段 1 資料層：多開 Claude Code 的平行分工與提示詞

> 搭配 `docs/roadmap-plan.md`（下稱「規劃」）使用。任務 ID 沿用規劃 §1 的 D-/E-/A-/P- 前綴。
> 原則：**一個 session 一條 workstream、各自擁有不同檔案、只透過 `docs/interfaces.md` 凍結的介面溝通、各自開 branch + git worktree。**

## 0. 開工前的機械準備（你自己做，10 分鐘）

同一個資料夾同時跑多個 Claude Code 會互相踩工作樹。每條 workstream 用獨立 worktree：

```bat
cd C:\Users\Administrator\Desktop\期中專案
git worktree add ..\期中專案-wsA -b ws-a/db
git worktree add ..\期中專案-wsB -b ws-b/migrate
git worktree add ..\期中專案-wsC -b ws-c/retrieval
git worktree add ..\期中專案-wsD -b ws-d/eval
```

每個 worktree 各自 `cd exam_pro && npm ci`，各開一個 Claude Code。Docker 的 PostgreSQL 只有一份（5432 正式、5433 測試），四個 worktree 共用同一個容器——這是 Session 0 先做好的原因。

合併順序固定：**Session 0 → main**，之後四條 WS 各自 PR 進 main，合併前 `git rebase main`。`routes/index.js`、`package.json`、`.env.example` 是共用檔，規則在各提示詞裡（append-only／只在 PR 描述列出新變數）。

## 1. 分工總表

| Session                                    | 何時開                  | 任務（規劃 ID）                                                                                                                            | 擁有的檔案（別人不得改）                                                                                                                                                                                                                                                   | 交付 / 同步點                                                                                            |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **S0 基礎與介面凍結**（序列，~1 天） | Day 0                   | D-D1、A-T7、D-D2 的 DDL 定稿、`docs/interfaces.md`、E-X0 的「決定」部分                                                                  | `docker-compose.yml`、`migrations/0001_init.sql`、`0002_vector.sql`、`migrate.js`、`.env.example`、`docs/interfaces.md`、`questionController.js` 的 PR-A 改動                                                                                                | **I0 介面凍結 + I1 DB 就緒**：`docker compose up` 後 migrations 套得上；合進 main 後其他四條才開 |
| **WS-A DB 與 controller**            | I1 後                   | D-D3 → D-D4（含 P-01 軟刪、`deleteQuestion`）→ E-X9b 整合測試 → 支援 D-X1                                                             | `config/db.js`、`config/features.js`、`controllers/*`、`seed_questions.js`、`audit_formulas.js`、`fix_formulas.js`、`setup_index_views.js`（刪）、`test/integration/controllers*`、`routes/index.js` 的「DB」區塊                                        | **I2 controller 在 PG**：D-D3 合入後 WS-C 接 `/similar`、WS-D 跑 supertest                       |
| **WS-B 遷移與維運**                  | I1 後（D-D5a 可 Day 1） | D-D5a → D-D5（export→import→verify、dry-run、回滾演練）→ E-X13a（`.bat`、`backup.js`）→ D-X1 runbook                              | `migrate/*`、`scripts/backup.js`、所有 `.bat`、`docs/cutover-runbook.md`                                                                                                                                                                                           | **I3 切換之夜**的 runbook 與腳本；真資料 dry-run 由你跑                                            |
| **WS-C 檢索零件**                    | Day 1（不等 DB）        | D-T1 → D-E3 → A-T3 的`embed()` 部分（gemini/fixture/fake）→ D-V1 → D-R1（`/similar`）→ 文件                                       | `utils/tokenize.js`、`utils/embedText.js`、`services/llm/*`、`services/embedService.js`、`services/retrievalService.js`、`queries/hybrid.js`、`scripts/backfill_embeddings.js`、`routes/index.js` 的「retrieval」區塊、`utils/textFormatter.js` 只加匯出 | **I4 檢索可用**：`/similar` 合入；WS-D 的 D-R2 接上                                              |
| **WS-D 評估與 CI**                   | Day 1（不等 DB）        | D-E1 fixture 60 題草稿 → E-X2 golden schema/loader/40 筆 → D-E2`eval/run.js` → D-V0 腳本 → D-C1 CI integration job → D-R2 三欄進 CI | `eval/**`、`test/unit/`（搬既有測試）、`.github/workflows/ci.yml`、`.gitattributes`、`package.json` 的 scripts                                                                                                                                                   | **I6 eval 全綠**：三欄 Recall/MRR 有基準線，`thresholds.json` 初值寫入                           |
| **人工 lane（你）**                  | 全程                    | E-X0 決定＋拿金鑰、跑 D-V0、核對 fixture 60 題答案、D-D5 真資料 dry-run、每個 PR 的 review 與合併、D-X1 切換、D-E1b 私有 golden            | —                                                                                                                                                                                                                                                                         | 你是瓶頸：標註與審查要排進行事曆                                                                         |

**相依一句話**：S0 → {A, B, C, D 同時開}；C 的 D-V1/D-R1 要等 A 的 D-D3；D 的 D-R2 要等 C 的 D-R1 與自己的 D-C1；B 的 D-X1 要等 A 的 D-D4 + 自己的 D-D5 + D 的 D-C1 綠燈。

## 2. 每個 session 的提示詞

所有提示詞共用的開頭（貼在每一份最前面）：

```
你在 C:\Users\Administrator\Desktop\期中專案-wsX（git worktree，分支 ws-x/...）工作，主要程式在 exam_pro/。
先完整讀：docs/roadmap-plan.md 的 §1.5（跨章節衝突與協調規則）、§2（階段 1 資料層）全章、§5.3.3–3.6（eval、CI、遷移）、docs/interfaces.md（凍結介面）、exam_pro/README.md。
硬規則：
1. 只改你「擁有的檔案」。共用檔：routes/index.js 只能在你的註解區塊內 append；package.json 只加你需要的 deps；.env.example 不直接改，把新變數列在 PR 描述。
2. docs/interfaces.md 是凍結介面，不得修改。若實作時發現介面有問題，停下來，把問題寫進 docs/questions-wsX.md 並在回報中明講，不要自行改介面繞過。
3. npm test 必須維持「不連 DB、不連 Gemini、不需 secrets」；需要 PG 的測試放 test/integration/，只讀 TEST_DATABASE_URL 且資料庫名必須以 _test 結尾。
4. 不得把任何真實考卷題目、PDF、題庫備份寫進 repo（見 NOTICE）；自製題要能說明是自行編寫。
5. 繁體中文註解與 commit 訊息，沿用 repo 既有風格；小步 commit，不要 push 到 main。
6. 開發機是 Windows 11：.bat 以 chcp 65001 起手；PowerShell 的 > 會寫 BOM，檔案一律由 Node 寫；路徑含中文要 path.resolve + UTF-8。
完成後回報：做了什麼（對應任務 ID）、怎麼驗證（貼測試輸出）、新環境變數、未完成與原因、給其他 workstream 的注意事項。
```

### S0 — 基礎與介面凍結（Day 0，一個 session 序列做）

```
你是這個專案階段 1 的「介面凍結與基礎環境」負責人。你的產出會被四個平行 workstream 當成不可變契約，所以寧可慢、不可含糊。依序完成：

A. D-D1 本機環境
- 在 exam_pro/ 新增 docker-compose.yml：pgvector/pgvector:pg16 兩個服務——postgres（5432，named volume）與 postgres_test（5433，tmpfs）；使用者/密碼/DB 名照規劃 §2.3.1。
- 第一件事實測中文路徑 bind mount：若失敗，改成 docker exec -i ... psql 的方式並在 README 註明。
- 新增 啟動資料庫.bat（先 docker info，失敗給中文提示，再 docker compose up -d --wait）。

B. D-D2 migrations（DDL 定稿）
- 新增 exam_pro/migrations/0001_init.sql、0002_vector.sql 與 migrate.js（約 60 行：schema_migrations 表、依檔名順序套用、同一交易）。
- DDL 以規劃 §2.3.2 為底，套用 §1.5 的裁決：attempts.question_id 外鍵 ON DELETE RESTRICT；questions 加 archived_at / origin / variant_of / chapter_src（§4.3.1）；exam_papers.student_id NOT NULL、question_ids INT[]；EMBED_DIM 先釘 768（vector(768)）；HNSW 與 GIN 索引直接建在 schema；兩個 VIEW 併入。
- 用 docker compose 的 postgres_test 實際跑 migrate.js 從零套用兩次（第二次應為 no-op），把輸出貼進回報。

C. A-T7 PR-A 部分入庫（半天，必須在 D-D3 之前合入）
- controllers/questionController.js 的 batchSaveQuestions：有效列 INSERT、回 {message, saved_count, rejected:[{idx, reason}]}；?strict=1 保留舊的整批 400 行為。前端 public/index.html 只做最小改動：依 rejected 標紅（不要重構其他部分）。
- 這一步仍在 MySQL 上，不要動 config/db.js。

D. docs/interfaces.md（I0 凍結清單）——每一項都要給出具體簽名或形狀，不可寫「待定」：
1. 最終 DDL（貼 migrations 內容的摘要與每張表欄位）。
2. utils/tokenize.js：tokenize(text:string) → string[]（@node-rs/jieba + dict.txt.big + config/chapters.js 的章節名當自訂詞；寫入、查詢、eval 三處都只能呼叫它）。
3. utils/embedText.js：buildEmbedText({subject, chapter, question_type, question_text, concept_summary}) → string（規則照 §2.3.6：去 $...$ 內容或換口語；純函式）。
4. services/llm/index.js：embed({model, texts, dim}) → {vectors:number[][], usage} 與 generateJson(...)（簽名照 §3.3.8）；EMBED_MODE=live|record|fixture；FixtureEmbedProvider 以 sha256(embed_text) 查 eval/fixtures/embeddings.<model>.<dim>.json。
5. queries/hybrid.js 匯出 buildHybridQuery({subject, chapter, difficultyMin, difficultyMax, excludeStudentId, queryVector, queryTokens, mode:'rrf'|'weighted', limit}) → {text, values}；API 與 eval 共用這一段 SQL。
6. GET /api/questions/:id/similar?k=&student_id= 回應形狀：{source_id, results:[{id, subject, chapter, question_type, difficulty, question_text, score}]}。
7. POST /api/generate-paper 回應新增 paper_id；400/409 訊息不變。
8. config/db.js 匯出 {pool, query(text, values) → {rows, rowCount}}；BIGINT/COUNT 以 number 回傳、DATE 以 'YYYY-MM-DD' 字串回傳（type parser 集中在這裡）。
9. 環境變數全名清單：DATABASE_URL、TEST_DATABASE_URL、DB_*、EMBED_MODEL、EMBED_DIM=768、EMBED_RPM、EMBED_BATCH、EMBED_MODE、FEATURE_SIMILAR、FEATURE_HYBRID_SEARCH、LLM_MODE。
10. 檔案所有權表（照 docs/stage1-parallel-prompts.md §1）與 routes/index.js 的四個註解區塊名稱。
11. migrations 只增不改：之後任何欄位變更走新檔。

E. 收尾：更新 .env.example（這是你唯一可以直接改它的 session）、把 docker/.bat 的使用方式寫進 exam_pro/README.md「安裝與啟動」；npm test 40 項仍全過；回報 I0 清單每一項的最終決定。不要開始做 D-D3 或任何檢索／eval 程式。
```

### WS-A — DB 與 controller（I1 後開）

```
你負責階段 1 的 WS-A：把應用程式從 mysql2 切到 pg，並以 students/attempts 取代 history_json。S0 已合入 main：migrations、docker-compose、docs/interfaces.md、PR-A 部分入庫。請先 git rebase main。

任務順序與驗收：
1. D-D3（2 人日）config/db.js 改 pg（依 interfaces.md 第 8 條：集中 type parser，BIGINT→number、DATE→字串）；questionController.js、wordController.js、seed_questions.js、audit_formulas.js、fix_formulas.js 改走 config/db.js 與 PG 語法。已知要改的不只 ?→$n：VALUES ? 批次插入改 unnest 或多列 VALUES；insertId→RETURNING id；affectedRows→rowCount；const [rows]→const {rows}；IN (${placeholders})→= ANY($1::int[])；所有候選池加 archived_at IS NULL；deleteQuestion 改「有 attempts 紀錄就 UPDATE archived_at 回 {archived:true}，否則硬刪」；updateQuestion 改章節時寫 chapter_src='human'。setup_index_views.js 與 建立索引與檢視表.bat 刪除（功能已在 migrations）。listQuestions 的 total 必須是 number。
2. D-D4（1 人日）examController.generatePaper 重寫：候選用 NOT EXISTS (SELECT 1 FROM attempts WHERE student_id=? AND question_id=?)；students 用 INSERT ... ON CONFLICT (name) DO UPDATE RETURNING id；同一交易內 INSERT exam_papers(student_id, question_ids INT[]) 與 INSERT attempts ... ON CONFLICT DO NOTHING；回應多帶 paper_id；抽題仍用 utils/shuffle.js（不要改它與它的測試）。config/features.js 集中 FEATURE_* 旗標（預設關）。
3. E-X9b（1 人日）test/integration/：用 TEST_DATABASE_URL（5433、_test 後綴防呆）跑 migrate 後，以 supertest 打 app：generate-paper 兩次不重疊、第二次 409/400 訊息不變、交易失敗會回滾（故意讓第二句 INSERT 失敗）、listQuestions total 型別為 number、刪出過的題回 archived:true。npm test 本身不得連 DB。
4. 回報 routes/index.js「DB」區塊的變更、package.json 新增 pg、移除 mysql2 的時機（D-X1 前保留，給 WS-B 的 export 用）。

不要做：embedding／tokenize／hybrid／eval／遷移腳本／.bat（分別屬 WS-C、WS-D、WS-B）。前端 public/index.html 除 generate-paper 回應相容外不動。
```

### WS-B — 遷移與維運（D-D5a 可 Day 1 開；D-D5 需 I1）

```
你負責階段 1 的 WS-B：MySQL → PostgreSQL 的一次性資料遷移、切換 runbook、備份與 .bat 維運殼。規劃 §2.3.5 與 §5.3.6 是你的規格；§1.5 的裁決（question_ids INT[]、student_id NOT NULL、RESTRICT）要反映在匯入。

任務：
1. D-D5a（1 人日，不需 PG）migrate/lib/normalize.js：姓名正規化 trim + 去 " 與 \，對 history_json 的 key 與 exam_papers.student_name 同一規則；重名／正規化後相同的合併報告（純函式 + node --test）。
2. D-D5（2 人日）三支腳本：migrate/export_mysql.js（沿用 mysql2，倒 JSONL + 校驗檔：各表筆數、各章筆數、逐列 sha256(question_text+answer_text)）；migrate/import_pg.js（保留原 id；history_json 在 PG 端以 jsonb_each_text 展開成 students + attempts(assigned_at)，不要在 Node 迴圈逐筆 INSERT；question_ids JSON → INT[]；seed 30 題比對題幹設 origin='seed'、chapter_src='human'；最後對三張表 setval；單一交易、--dry-run 預設、--apply 才寫）；migrate/verify.js（筆數、各章筆數、逐列雜湊全等；COUNT(attempts) = Σ history_json 鍵數；隨機 20 題 buildParagraphComponents 產物逐位元比對；任一不等非零退出）。用你自己造的小型 MySQL 樣本（可用 seed_questions.js 灌一個本機 MySQL，或用 JSONL fixture 跳過 export）把 import/verify 跑通；真資料 dry-run 由開發者本人執行。
3. migrate/export_pg_delta.js（約 80 行）：倒出 cutover 後新增列並把 attempts 摺回 history_json，供 14 天內回滾用。
4. E-X13a（0.5）scripts/backup.js（先 docker info，再 docker compose exec -T postgres pg_dump -Fc，失敗寫 backups/LAST_FAILED.txt）、備份資料庫.bat、回填向量.bat（殼而已，呼叫 WS-C 的 scripts/backfill_embeddings.js）；既有三支公式 .bat 改包 node scripts/formulas.js（等 WS-C 的 textFormatter 匯出就緒前先保留舊行為）。
5. docs/cutover-runbook.md：凍結→備份→export→import→verify→.env 切 DATABASE_URL→tag v1-mysql→MySQL 唯讀保留 14 天→回滾界線（當晚 vs 14 天內）逐條指令。

不要改 controllers、config/db.js、migrations/*.sql（屬 S0／WS-A）；需要新欄位就寫進 docs/questions-wsB.md。
```

### WS-C — 檢索零件（Day 1 開，不等 DB）

```
你負責階段 1 的 WS-C：分詞、embedding 文本、embedding 服務與回填、hybrid 檢索與 /similar。規劃 §2.3.6–3.8 與 §3.3.8（services/llm 簽名）是規格；介面以 docs/interfaces.md 第 2–6 條為準，一字不改。

任務順序：
1. D-T1（0.5）utils/tokenize.js：@node-rs/jieba（win32 有預編譯 napi，不需 node-gyp）+ dict.txt.big + 把 config/chapters.js 所有章節名加進自訂詞；測試涵蓋 f(x)、a:b、全半形、含 $...$ 的題幹。
2. D-E3（1）utils/embedText.js 的 buildEmbedText 純函式 + 測試；utils/textFormatter.js 只新增匯出（例如 stripMath / 把 $...$ 換口語用的對照表），不改既有輸出——test/textFormatter.test.js 29 項是契約。
3. A-T3 的 embed 部分（1.5）services/llm/index.js 暴露 embed()（generateJson 先留介面與 gemini adapter 骨架即可）；adapters：gemini.js（@google/genai，taskType RETRIEVAL_DOCUMENT/QUERY、EMBED_RPM token bucket、退避）、fixture.js（sha256(embed_text) 查 eval/fixtures/embeddings.<model>.<dim>.json，找不到就丟錯並提示「請本機 npm run eval:record」）；EMBED_MODE 切換。單元測試用 fixture adapter。
4. D-V1（1.5，需 WS-A 的 D-D3 合入後才能接真 pool，之前先對 interfaces.md 第 8 條的 query() 寫）services/embedService.js（embedByIds、embed_hash 比對決定該不該重算、寫 embedding/embedding_model/embedded_at/search_tsv）與 scripts/backfill_embeddings.js（分批、限速、斷點續跑、失敗清單、結尾 count(*) WHERE embedding IS NULL 非零就非零退出）。
5. D-R1（1.5）queries/hybrid.js 的 buildHybridQuery（metadata 篩選 CTE + 排除 attempts + 向量 <=> + to_tsquery('simple') 用 tokenize 後的詞、quote_literal 組裝、RRF 預設、mode 可切加權）、services/retrievalService.js、GET /api/questions/:id/similar（routes「retrieval」區塊、FEATURE_SIMILAR 旗標、apiKeyAuth 之後）。用 docker 的 postgres_test 與手動 INSERT 的 fixture 向量驗證；記 p95 延遲。
6. 回報 package.json 新增 @node-rs/jieba、@google/genai 版本、新環境變數，並寫 docs/retrieval.md 說明 embed_text 規則與 mode 切換。

不要改 controllers、migrations、eval/（WS-D 會呼叫你的 buildHybridQuery 與 fixture adapter，所以介面凍結後不要再動簽名）。
```

### WS-D — 評估與 CI（Day 1 開，不等 DB）

```
你負責階段 1 的 WS-D：公開 fixture 題庫、golden set、eval 入口與指標、CI 的 integration job，以及把檢索三欄對照進 CI。規劃 §5.3.1–3.4、§5.6、§2.8 是規格。

任務順序：
1. 先把既有 test/*.test.js 搬到 test/unit/，npm test 改為 node --test test/unit/（第一個 PR，最小改動，CI 矩陣改 22/24）。
2. D-E1 草稿（3）eval/fixtures/questions.public.json：60 題自製教科書型例題、≥6 個白名單章節、含「換數字的同一題」配對、同章不同概念干擾題、跨章字面相近題、10 題故意寫壞的 LaTeX；每題 subject/chapter/question_type/difficulty/question_text/answer_text，載入時逐題過 config/chapters.js 的 isValidChapter。這些題由你起草、由開發者本人逐題核對答案後才算定稿——在檔案頂端註明「自行編寫，非取自任何考卷」。
3. E-X2（1.5）eval/golden/retrieval.json schema {id, query:{kind:'question_id', value}, relevant:[], hard_negatives:[]} + loader；先標 40 筆（候選池用 pooling：向量近鄰 ∪ 關鍵字 ∪ 同章隨機，再人工判定——你先給建議，標記為 needs_human_confirm）。
4. D-E2（1.5）eval/run.js --suite retrieval [--golden path] [--mode like|vector|hybrid|all]；eval/lib/metrics.js（Recall@5/10、MRR，純函式 + 測試）、report.js（stdout Markdown 表 + eval/reports/<日期>-<sha>.json + GITHUB_STEP_SUMMARY）、pooling.js、thresholds.json（初值 = 第一次量測 − 0.03、只升不降）、trend.js。LIKE 欄的關鍵字規則：該題 embed_text 去章節後 tokenize 取前 3 個長度 ≥ 2 的詞 OR 起來——呼叫 WS-C 的 utils/tokenize.js（介面已凍結，尚未合入前先寫 stub）。向量與 hybrid 欄直接對 PG 下 WS-C 的 queries/hybrid.js，不經 HTTP。
5. D-V0（0.5）eval/record_embeddings.js：對 fixture 呼叫一次 embed()，輸出 eval/fixtures/embeddings.<model>.768.json（小數 6 位），由開發者本人用金鑰執行；CI 永遠只讀這個檔。
6. D-C1（1）.github/workflows/ci.yml 加 integration job：services: pgvector/pgvector:pg16 + pg_isready 健康檢查、Node 24、TEST_DATABASE_URL 以 _test 結尾、npm run migrate && npm run test:integration && npm run eval -- --suite retrieval；報表 upload-artifact 30 天。unit job 維持無 DB 無 secrets。
7. D-R2（2，需 WS-C 的 D-R1 合入）三欄對照進 CI、hybrid 必須 ≥ LIKE、SQL 與記憶體排序器前 10 名 Jaccard ≥ 0.9 的斷言；寫 eval/README.md 說明公開／私有兩層與怎麼跑。

不要改 controllers、services、migrations（你只呼叫）；.env.example 不直接改。
```

## 3. 你的人工 lane 清單（按時間）

| 時機    | 你要做的事                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0   | 決定 EMBED_MODEL/EMBED_DIM（建議照規劃釘 768）、準備 Gemini 金鑰（錄 fixture 用另一個 GCP 專案較好）；review S0 的 interfaces.md 逐條拍板後合進 main |
| Day 1   | 開 4 個 worktree + 4 個 Claude；把對應提示詞貼上                                                                                                     |
| 第 1 週 | 核對 WS-D 的 60 題答案；跑 D-V0 產生 fixture 向量；review WS-A 的 D-D3 並優先合入（所有人都在等它）                                                  |
| 第 2 週 | 用真 MySQL 跑 WS-B 的 export/import/verify dry-run，確認姓名合併報告；review D-D4、D-V1、D-R1                                                        |
| 第 3 週 | 切換之夜（照 runbook）；回填正式資料向量；開始標私有 golden（D-E1b）；跑私有層 eval 把三欄數字寫進 README                                            |

## 4. 常見碰撞與處理

- 兩個 session 都想改 `routes/index.js`：各寫自己的註解區塊，rebase 時只會有相鄰行衝突，保留兩邊即可。
- WS-C 在 D-D3 合入前需要 `config/db.js`：先對 `interfaces.md` 第 8 條寫，自己本機臨時 stub，不要 commit stub。
- 任何 session 說「介面需要改」：先停、看 `docs/questions-wsX.md`，你決定後改 `interfaces.md` 並通知其他三個 session（在它們的對話貼一句「interfaces.md 第 N 條已更新為 …，請 rebase 後對齊」）。
