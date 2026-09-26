# docs/retrieval.md — 檢索零件說明（WS-C）

> 擁有者：WS-C（分支 `ws-c/retrieval`）。對應任務：D-T1、D-E3、A-T3 的 `embed()`、D-V1、D-R1。
> 介面契約在 `docs/interfaces-stage1.md` 第 2～6 條，本檔只解釋「怎麼用、為什麼這樣寫、量到什麼」，不重複契約。

檢索由五個零件串起來，寫入端與查詢端共用同一套規則：

```
utils/tokenize.js      分詞（寫入 search_tsv、查詢 to_tsquery、eval 的 LIKE 基準欄都只能用它）
utils/embedText.js     embed_text 的可重現文本（embed_hash = sha256(它) 決定該不該重算）
services/llm/*         embed()：live / record / fixture 三種模式
services/embedService  把向量與 search_tsv 寫回 questions（唯一寫入點）
queries/hybrid.js      API 與 eval 共用的同一段檢索 SQL
services/retrievalService + GET /api/questions/:id/similar
```

---

## 1. 分詞：`utils/tokenize.js`

`tokenize(text) → string[]`。實作是 `@node-rs/jieba`（napi 預編譯，Windows 不需 node-gyp），詞典三層：

1. 套件內建的 `dict.txt`
2. `config/chapters.js` 的全部章節名，外加拆出來的子詞（`摩擦力與向心力` → `摩擦力`、`向心力`）
3. 本檔內 `EXAM_TERMS` 手寫的高中數理繁體名詞（約 240 個，全部是通用學科名詞）

前處理固定為：`NFKC` 正規化（全形英數 → 半形）→ 去掉 `$` 界定符 → `\theta` → `theta` → 壓縮空白 → 轉小寫。
再濾掉純標點與單字虛詞（`的`、`了`、`是`…；`功`、`力`、`波` 這種學科單字**不**在虛詞表內）。

```
'一質量 2 kg 的物體以等速率作圓周運動，求其向心力大小'
  → ["質量","2","kg","物體","等速率","作","圓周運動","求其","向心力","大小"]
'利用克拉瑪公式解二元一次聯立方程式'
  → ["利用","克拉瑪公式","解","二元","一次","聯立方程式"]
```

**`dict.txt.big` 是選用的（裁決 17）。** `@node-rs/jieba` 並不隨附這個檔（只有簡體的 `dict.txt`），
而把 8.5 MB 詞典 commit 進 repo 或安裝時下載都有代價，因此改以「章節名 + 手寫學科詞」補足；
`JIEBA_DICT_BIG` 指到本機的 `dict.txt.big` 時才額外載入，**預設不啟用**——本機有、CI 沒有的話，
同一題在兩邊會切出不同 token，寫入與查詢就不再一致，比切錯詞更糟。

## 2. `embed_text`：`utils/embedText.js`

純函式，輸出四行（沒有的行整行不輸出、尾端不留空行）：

```
數學｜向量內積｜計算｜難度3
設 a=(1,2)、b=(3,-1)，求 a·b 與夾角 θ 的 cosθ 值。[附圖描述：座標平面上兩向量]
向量長度的計算                ← concept_summary（可選，第一版預設不產生）
向量 內積 長度                ← keywords.join(' ')（可選）
```

第 2 行由 `latexToPlain` 產生：`\frac{a}{b}` → `a/b`（分子分母含運算子才補括號：`\frac{a+b}{2}` → `(a+b)/2`）、
`\sqrt{x}` → `√x`、`\sqrt[3]{8}` → `3√8`、`\theta` → `θ`、`\times` → `×`、`\vec{a}` → `a`；
去掉 `{}`、`^`、`_`（`x^2` → `x2`、`a_{n+1}` → `an+1`）；`[附圖描述：…]` 與選項代號 `(A)` 原樣保留。
希臘字母／符號／函數名的對照表**直接重用 `utils/textFormatter.js`**（只加匯出、不改既有輸出），
避免「Word 匯出看到 θ、embedding 看到 theta」。

> ⚠️ 改這裡的規則 = 全題庫 `embed_hash` 變動 = 所有向量作廢，必須同時重產
> `eval/fixtures/embeddings.*.json` 並在 PR 說明。`test/unit/embedText.test.js` 就是拿來擋這件事的。

## 3. `embed()` 的三種模式

| `EMBED_MODE` | 行為 |
|---|---|
| `fixture`（預設、CI 恆為此） | 以 `sha256(embed_text)` 查 `eval/fixtures/embeddings.<model>.<dim>.json`。**查不到就丟錯**並提示 `npm run eval:record`，不會靜默回退成假向量 |
| `live` | 真的呼叫 Gemini（`EMBED_RPM` 令牌桶、429/503 指數退避 1s→60s 最多 6 次） |
| `record` | 呼叫 Gemini 並把結果（小數 6 位、鍵依字典序）併回上面那個 fixture 檔 |

L2 正規化統一在 `services/llm/index.js` 做，三種模式回來的向量都是單位向量。
`taskType` 預設 `RETRIEVAL_DOCUMENT`（寫入用）；階段 3 的自然語言查詢再傳 `RETRIEVAL_QUERY`。
`generateJson()` 只固定簽名，`LLM_MODE=replay|record` 會明確丟出「屬階段 2」的錯誤，不會偷偷呼叫 Gemini。

## 4. 回填：`services/embedService.js` 與 `scripts/backfill_embeddings.js`

**該不該重算**只看三件事（其一成立就重算）：`embedding IS NULL`、`embed_hash <> sha256(buildEmbedText(q))`、
`embedding_model <> EMBED_MODEL`。`--force` 可以蓋過。

**三段 token 的唯一產生器**（裁決 21）：

```js
const { buildTsvTokens } = require('../services/embedService');

buildTsvTokens(q) → { chapterTokens: string[], keywordTokens: string[], stemTokens: string[] }
```

`q` 可以是 `questions` 撈回來的列，也可以是 fixture 的題目物件——只讀 `chapter`、`keywords`
與 `buildEmbedText(q)` 需要的欄位，是**純函式**（無 I/O、無隨機、無時間）。
**寫入（`embedService`）、回填（`scripts/backfill_embeddings.js`）、eval 的 `eval/lib/pgEngine.js`
三處都只能呼叫它**，不得自行 `tokenize(buildEmbedText(q))`——那樣會少掉章節名拆出來的子詞，
PG 裡的 lexeme 集合就與記憶體排序器對不起來（D-R2 的 Jaccard 斷言會量到假差異）。

**`search_tsv` 的組成**（規劃 §2.3.7 的權重規則，寫入端各自組，`interfaces-stage1.md` 第 2 條明講不提供 `toTsvSql()`）：

```sql
search_tsv = setweight(to_tsvector('simple', array_to_string($chapter_tokens::text[], ' ')), 'A')
          || setweight(to_tsvector('simple', array_to_string($keyword_tokens::text[], ' ')), 'A')
          || setweight(to_tsvector('simple', array_to_string($stem_tokens::text[], ' ')), 'B')
```

- `chapter_tokens` = `tokenize(chapter)` ∪ `tokenize(章節名把括號與「與」換成空白後)`
  （只放整串的話，題幹裡的「向心力」會對不上章節段的「摩擦力與向心力」）
- `keyword_tokens` = `tokenize(keywords.join(' '))`
- `stem_tokens` = `tokenize(embed_text 的第 2 行起)`

> **WS-A 注意**：`createQuestion` / `updateQuestion` / `batchSaveQuestions` 寫入 `search_tsv` 時
> 請用上面這一段一模一樣的 SQL 與同樣三段 token，否則同一題經不同路徑寫入會得到不同的 tsv。

回填腳本：

```bash
node scripts/backfill_embeddings.js                # 全量對帳（該算的才算）
node scripts/backfill_embeddings.js --missing-only # 只補沒有向量／換過模型的
node scripts/backfill_embeddings.js --ids 12,34
node scripts/backfill_embeddings.js --subject 物理 --chapter 摩擦力與向心力 --limit 100
node scripts/backfill_embeddings.js --dry-run      # 只印要算幾題
node scripts/backfill_embeddings.js --force        # 忽略 embed_hash 全部重算
node scripts/backfill_embeddings.js --test         # 改打 TEST_DATABASE_URL（庫名須以 _test 結尾）
```

每批 `EMBED_BATCH` 筆、**每批一個交易**（中斷後重跑就是斷點續跑）；某一批失敗只記進
`eval/local/backfill_failed.json`（只有 id 與錯誤訊息，不含題目內容）並繼續跑其餘批次；
結尾印出「仍無向量的題數」，>0 或有失敗批次就以非零碼退出。

> 真的要打 Gemini 必須在 `.env` 設 `EMBED_MODE=live`（預設是 `fixture`）。

## 5. hybrid 檢索：`queries/hybrid.js`

`buildHybridQuery(opts) → { text, values }`，API 與 eval 共用同一段 SQL。結果集凍結為
`id / score / vec_rank / kw_rank`，排序 `score DESC, id ASC`。

- 候選 CTE：`subject`、`chapter`（null = 不限章）、`difficulty BETWEEN`、`archived_at IS NULL`、
  `NOT (id = ANY(excludeIds))`、`excludeStudentId` 用 `NOT EXISTS`（不是 `NOT IN`）
- 向量側與關鍵字側各自 `ORDER BY … LIMIT 50` 之後才 `FULL OUTER JOIN`
- 查詢詞在 SQL 端組裝：`to_tsquery('simple', string_agg(quote_literal(t), ' | '))`；
  `queryTokens` 為空陣列時 `to_tsquery` 得到 NULL，關鍵字側自然是空集合（不會報錯）
- 向量參數一律 `pgvector.toSql()`；rank 轉 `int`、score 轉 `float8`（避免 pg 把 int8/numeric 回成字串）

| `mode` | `score` |
|---|---|
| `rrf`（預設） | `1/(60+vec_rank) + 1/(60+kw_rank)`，缺席側以 0 計 |
| `weighted` | `0.7 × 向量側 + 0.3 × 關鍵字側`，兩側各自在自己那 50 名內 min-max 正規化到 0~1（整側同分時給 1） |

**選用參數 `sides`**（預設 `['vec','kw']`）：`/similar` 的 `mode=vector` 傳 `['vec']`、`mode=keyword` 傳 `['kw']`，
讓三種模式共用同一段 SQL 而不是各寫一份。詳見 `docs/archive/questions-wsC.md` 第 2 題。

呼叫端要在**同一個交易**內設 `SET LOCAL hnsw.ef_search = 100`；eval 為求等效精確，設為不小於 fixture 題數。

## 6. `GET /api/questions/:id/similar`

掛在 `routes/index.js` 的 `WS-C: retrieval` 區塊，`apiKeyAuth` 之後、每分鐘 60 次的 rate limit。
`FEATURE_SIMILAR` 未開啟時**路由不掛載**（請求落到預設 404）。

| 參數 | 預設 | 說明 |
|---|---|---|
| `k`（別名 `limit`） | 10 | 1~20；超出範圍會夾進區間，不回 400 |
| `student_id` | 無 | 排除該生已作答的題；查無此人 = 空排除集，仍回 200 |
| `mode` | `hybrid` | `hybrid` / `vector` / `keyword`；給別的值回 **400**（默默換成 hybrid 會讓 eval 量錯東西）|
| `scope` | `chapter` | `chapter` / `subject`（裁決 19 已移除 `all`）；給別的值（含 `all`）回 **400** |
| `difficulty_delta` | 無 | 給了就**鎖定**「來源難度 + delta」（夾在 1~5）；未給則 ±1 |

- 查詢向量**直接取來源題的 `embedding`，不呼叫 Gemini** → 可離線、可進 CI。
- 關鍵字側的查詢詞取來源題 `search_tsv` 裡權重 A 的詞（＝寫入時的章節與 keywords，已經過 `tokenize`）；
  沒有就退回 `tokenize(章節 + keywords)`，再沒有就退回 `tokenize(題幹)`。
- `404` = `:id` 不存在**或已封存**；`409` = 來源題還沒有向量（`mode=keyword` 例外，那條路不需要向量）。
- `results` 每筆多帶 `vec_rank` / `kw_rank` 兩個除錯欄位，消費端請忽略未知鍵。
- **沒有跨學科這條路**：候選一律限定在來源題的學科內，因此永遠是同一段 SQL 跑一次，SQL 回來的順序就是最終順序。
  `scope=all` 回 `400 {message:'scope 只接受 chapter / subject。'}`，不悄悄降級成 `subject`（裁決 19）。

## 7. 量到的數字

**延遲（本機、萬題）**：`postgres_test`（Docker、tmpfs、pgvector 0.8.6 / PG 16.15），
灌 10,000 題自動產生的題目與 768 維向量，隨機抽 100~200 題當來源，每次查詢自己一個交易
（含 `SET LOCAL hnsw.ef_search = 100`），`k=10`：

| 情境 | p50 | p95 |
|---|---|---|
| `scope=chapter`、`mode=hybrid`（**預設**） | 27 ms | **38 ms** |
| `scope=chapter`、`mode=vector` | 10 ms | 17 ms |
| `scope=subject`、`mode=hybrid` | 189 ms | 292 ms |
| `scope=subject`、`mode=vector` | 46 ms | 70 ms |

- 規劃 §2.8 的「萬題 p95 < 100 ms」對**預設路徑（同章）達成**。
- `scope=subject` 慢的是**關鍵字側**而不是向量側（兩側 292 ms vs 只向量側 70 ms）。這份合成資料只有
  4 種題型模板重複 2,500 次，幾乎每一列都命中 `to_tsquery`（GIN 掃出 8,610 列再排 `ts_rank_cd`），
  是刻意的最壞情況；真題庫的命中列數會少一個數量級。
- **HNSW 在這個規模不會被規劃器選用**：候選 CTE 與 `questions` join 之後走 Bitmap Heap Scan + top-N 排序。
  把條件內聯到向量側（讓 `ORDER BY … LIMIT` 有機會走索引）、甚至加上 pgvector 0.8 的
  `hnsw.iterative_scan = relaxed_order` 實測都**沒有變快**（同章 19 ms vs 17 ms、同科 97 ms vs 70 ms），
  因此不改 `interfaces-stage1.md` 第 5 條的 SQL 形狀。這與規劃 §2.3.7「萬級以下常走 seq scan，屬正常」一致。

**檢索品質**：CI 層的 Recall@5／Recall@10／MRR 三欄對照由 WS-D 的 `eval/run.js` 產出（D-R2），
本 WS 只保證「eval 與 API 走同一段 SQL」。

## 8. 測試

```bash
npm test          # = node --test "test/unit/**/*.test.js"（裁決 24）
                  # 不連 DB、不呼叫 Gemini、不需 secrets
node --env-file=.env --test --test-concurrency=1 "test/integration/**/*.test.js"
```

- 單元（WS-C 的部分共 113 項）：`test/unit/tokenize.test.js`(21)、`embedText.test.js`(23)、
  `llmEmbed.test.js`(11)、`embedService.test.js`(18)、`hybridQuery.test.js`(25)、`similarParams.test.js`(15)
- 整合：`test/integration/hybrid.pg.test.js`(41)——**沒設 `TEST_DATABASE_URL` 就整組 skip**，
  所以 `npm test` 永遠不會連到資料庫。跑之前要先 `npm run migrate:test`。
- **整合測試必須序列化跑**（`--test-concurrency=1`）：四支整合測試檔共用同一個 `postgres_test`，
  每一支開頭都會 `TRUNCATE`，平行跑會互相清掉對方的資料。本檔跑完會把測試庫清乾淨，
  測試學生的姓名也加了 `WS-C` 前綴，避免與別支的固定測試學生撞上 `students.name` 的 UNIQUE。

## 9. 自然語言查題：LLM 輔路徑的改善（2026-09-26，分支 `dec/x-nlq-improve`）

NLQ 的契約在 `docs/interfaces-stage3.md` 第 6 條，化學支援在 `docs/chemistry.md` 第 7 條；本節只記錄 2026-09-25 以本機模型重錄後的逐句分析與這一輪改動。
**門檻不動**（Owner 決策單 A7：未達就紅燈、之後改善）；**nlq-036 的 golden 與計分方式不動**（A3：重錄後看分數再決定）。
這一輪沒有重新量分數（要本機模型重錄），下面的「預期」都不是量測值。

### 9.1 分析：2026-09-25 的 LLM 路徑 8 句

報表：`nlq-2026-09-25-7b7065c.json`（`ollama:qwen3:8b`、模板 `nlq.v1`）。rules 欄全過（rule_coverage 0.84、filters_exact 1、recall10 1）；
llm 欄 filters_exact **0.625**（門檻 0.72）、recall10 **0.75**（門檻 0.845）。

| 句 | filters_exact | recall10 | 錯在哪 |
|---|---|---|---|
| nlq-036 | ✗ | ✗ | 章節回〔直線運動〕（運動學），期望〔摩擦力與向心力、牛頓運動定律〕（受力） |
| nlq-037～039、041、043 | ✓ | ✓ | 只有 semantic_text 被改寫成關鍵字（不計分） |
| nlq-040 | ✗ | ✓ | 句子沒講題型，模型回了「計算」（「求…」被當成計算題） |
| nlq-042 | ✗ | ✗ | 句子明寫「平面上」，模型仍回〔向量的加減與係數積、空間向量內積〕，又加了「計算」 |

原因分類（8 句）：

- **句子沒講的條件被加上**：2 句（040、042 都是題型「計算」）。難度、學生、科目 0 錯。
- **章節挑到相鄰的章**：2 句——運動學 vs 受力（036）、平面 vs 空間向量（042）；042 另外多列了一章。兩組都是章節重整後相鄰、容易混的章。
- **semantic_text 漂移**：7 句。舊 schema 要模型「只留概念詞與名詞，以空白分隔」，與 golden（也就是規則路徑，裁決 S3-R17）的「保留原話、拿掉贅字」不同。
  不影響分數：recall10 依裁決 S3-21 用 golden 的 semantic_text 去 embed。036 沒漂移，很可能是因為舊 schema 的範例就是那一句（見 9.2 第 4 點；推論，未驗證）。
- **recall 失敗的 2 句都是過濾造成的，不是檢索**：fixture 每章最多 8 題、hybrid 兩側各取前 50，只篩一章而且章節與題型對了，候選集 ≤ 8 題，相關題一定在前 10
  （篩兩章時可能超過 10 題，例如 036 的兩個期望章共 14 題，見 9.3）。
  036 的相關題（40、41）在〔摩擦力與向心力〕，被〔直線運動〕的篩選排除；042 的相關題（13、14）在〔向量內積〕而且是**填空**，
  章節錯、題型「計算」也錯，兩個篩選各自都會把它們排除。

### 9.2 改動

1. **伺服器端的證據檢查**（`services/nlqService.js` 的 `mergeLlm` 帶原句；判斷在 `utils/nlqHeuristics.js`）。規則沒抓到的條件，LLM 給的值要在句子裡找得到證據才採用：
   - 題型：句子要有題型字眼（`QUESTION_TYPE_CUES`：選、非選、填、計算、演算、運算、證、問答、申論、論述、簡答、是非、應用題、題型）。「算」刻意不收：「怎麼算」「求…」「是多少」是題目在問的東西，不是指定題型。
     「演算題」「運算題」是計算題的別稱，規則層不認得、也不含「計算」兩字，所以另外收（修正分支補上）。
   - 難度：句子要有難度字眼（`DIFFICULTY_CUES`：難、易、簡單、基礎、進階、高階、挑戰、深、星、級…；「深」「高階」對應「深一點」「高階一點」，修正分支補上）。
   - 學生：LLM 給的名字要逐字出現在句子裡（姓名代號在呼叫 `mergeLlm` 前已換回姓名）。
   - 這兩張字表刻意收得寬：多收一個字只會讓檢查少擋一次（退回原本照收 LLM 的行為），少收一個字卻會丟掉老師真的講過的條件。
   - 模板規則 4 本來就要求「沒提到的條件不要輸出」；這一層讓這條規則不必靠模型照做。規則抓到的條件照舊優先，LLM 的不看。
2. **平面／空間對齊**（`alignChapterDimension`）：句子**只明講**平面（「平面上」「坐標平面」「二維」…）或**只明講**空間（「空間」「三維」「z 軸」…）時，
   LLM 只挑了另一個維度的章，就換成同名的那一章。對照表由 `CHAPTERS` 算（「空間＋X」而且 X 也是數學章節）：
   目前是〔空間向量內積 ↔ 向量內積〕〔空間直線方程式 ↔ 直線方程式〕。只有「平面」兩個字不算平面線索——「平面方程式」「過三點的平面」是空間單元。
   以下情況**不換**（修正分支依審查意見補上；原版會把「平面和空間的都要」判成只講空間，把 LLM 正確回的平面章換掉、再去重，老師要的那一章就不見了）：
   - **同名的另一章模型已經列了**：模型把〔向量內積〕〔空間向量內積〕都列出來時兩章都留。兩章都留最多多混進一章的題，不會丟掉相關題；換掉卻可能刪掉老師要的章。
   - **句子兩個維度都講了**：兩種線索都有（「二維和三維」），或有空間線索、又另外出現「平面」兩字而且不是空間單元的題材
     （`SPATIAL_PLANE_OBJECT`：平面方程式、過…的平面、點到平面、兩平面、平面與平面、平面的法向量；物理的平面運動、平面鏡、平面波）。
     例：「平面和空間的都要」「平面跟空間各來幾題」→ 不換；「空間中點到平面的距離」「空間中兩平面的夾角」→ 仍算只講空間。
   這一點寧可不換（退回模型自己的選擇），也不要換錯。
   第 1、2 點被擋下或換掉的項目記在 `parseOnly` 回傳的 `adjustments` 與 log（`logger.info`），**不進 warnings、不進 200 回應**（第 6 條的形狀不變）。
3. **模板**（沿用 B5 已升的 `nlq.v2`，同一個未發布版本內改，不另升版）：
   - 規則 4 補「沒講題型就回空陣列；求…／是多少／怎麼算不是題型」；
   - 規則 5 改成與規則路徑相同的 semantic_text 寫法（保留原話與語序，拿掉贅字與已放進其他欄位的條件）；
   - 新增規則 6：章節依相關性排序，通常一章，另一章也是解題主角時才多列；
   - 新增【容易混淆的章】：平面／空間向量、指數與對數（第一冊／第三冊）、直角三角形／廣義角、運動學／受力（直線運動、平面運動／牛頓運動定律、摩擦力與向心力、剛體轉動與平衡）、
     靜電學／電場與電位。界線取自 `config/kc/*.json` 的知識點（名稱與說明）與 `config/chapterAliases.js` 的別名歸屬（例如「斜面上的受力分析」是〔摩擦力與向心力〕的知識點、「斜面滑動」是它的別名）。
     **例外與更正**：原稿的「力的平衡 → 牛頓運動定律」不在 KC 與別名裡，是領域上的改寫，而且與 golden nlq-036 note 的用字（「牛頓運動定律（力的平衡）」）相同；
     修正分支改為 KC〈牛頓第一定律（慣性定律）〉說明裡的「合力為零」（該 KC 屬〔牛頓運動定律〕），其餘用字逐一對過 KC 名稱或說明
     （首數、終邊、象限、負角、電位差、連體、合力都有出處）。向量那一條另補「平面、空間兩種都要時，兩組各列對應的章」（與第 2 點一致）；
   - 新增三個【範例】（物理、數學、化學各一），題材刻意避開 golden 50 句。
4. **schema**（`agents/schemas/nlq.json`）：
   - `keywords` 移到第一個：本機模型的輸出順序由 schema 決定（llama.cpp 的 JSON Schema→文法依屬性順序、必填在前；此點依其轉換規則推論，未實測），
     原本第一個生成的就是 `chapters`，現在先寫名詞再挑章；
   - `chapters`、`question_types` 的說明同步規則 4、6；`semantic_text` 的說明同步規則 5；
   - **移除洩漏**：舊的 semantic_text 範例「斜面上物體受力平衡」就是 nlq-036 的 golden semantic_text，換成自撰的例句。單元測試釘住模板與 schema 不得含任何 golden 查詢原句。

| 改動 | 預期修正 | 依據 |
|---|---|---|
| 1 題型證據檢查 | 040 的 filters_exact；042 的「計算」 | 040、042 都沒有題型字眼；042 的相關題是填空，「計算」會把它們排除 |
| 2 平面／空間對齊 | 042 的 recall10（〔空間向量內積〕換成〔向量內積〕） | 042 明寫「平面上」 |
| 3 規則 6＋向量的提示 | 042 的 filters_exact（不再多列〔向量的加減與係數積〕） | 模型行為，無法保證 |
| 3 力學的提示 | 036 的 recall10（章節含〔摩擦力與向心力〕）；filters_exact 要兩章都回才算 | 模型行為，無法保證 |
| 3 規則 5、4 semantic_text | 7 句的漂移警告（不計分） | 與 golden／規則路徑的寫法一致 |

### 9.3 預期效果與限制（都不是量測值）

- **反事實模擬**：假設模型輸出與 2026-09-25 相同（由報表的 diff 還原），舊的合併邏輯剛好重現報表的 0.625／0.75（逐句一致），
  新的證據檢查＋平面／空間對齊得到 filters_exact 0.75、recall10 0.875（兩者都過門檻 0.72／0.845；recall 的 7 句都是「候選 ≤ 10 題、相關題在內」的必中）。
  **這只說明伺服器端的兩道檢查單獨能補到哪裡**：模板在 B5 與本輪都改了，重錄後模型的輸出一定會變，真正的分數要重錄才知道。
  修正分支（「同名的另一章已列時不換」「平面空間都講時不換」、補證據字）之後重跑同一個模擬，8 句逐句結果不變（0.75／0.875）：
  042 的模型輸出只列了〔空間向量內積〕、沒有同時列〔向量內積〕，句子也只講平面，所以照樣換；其餘 7 句沒有平面／空間線索，也沒有新增證據字。
- **nlq-036**：規則 6 要模型通常只挑一章。只回〔摩擦力與向心力〕→ recall 中、filters_exact 不中；只回〔牛頓運動定律〕→ 兩者都不中；
  兩章都回 → filters_exact 中；recall10 取決於 14 個候選的排序（兩章共 14 題，超過 10 題，不是必中）。
  這句的計分語意等 Owner 看重錄結果再決定（A3），本輪不動它的 golden。
  **這句直接受提示影響**：力學那一條的「合力為零 → 牛頓運動定律」與「斜面上的受力 → 摩擦力與向心力」剛好指向它的兩個期望章。
  重錄後 nlq-036 的結果是「有這條提示」時的表現，不是模型自己判斷的；Owner 依 A3 做決定時請把這點算進去。
- **過度貼合的風險**：【容易混淆的章】是看了這 8 句的錯誤之後寫的，雖然內容取自知識點與別名資料、沒有照抄 golden 句子，
  重錄後在這 8 句上的分數仍可能高估對新句子的效果。提示用字與 golden LLM 路徑句子重疊的有：036（見上）、040（「位數」）、041（「終邊」）、
  042（「平面上」「垂直」）；037、038、039、043 只有概念相關、沒有共同用字。建議之後另補幾句新的 LLM 路徑查詢當檢驗（要改 golden，屬 Owner 決定）。
- **prompt 變長**：模板本體 391 → 1,665 字，含白名單的整段 prompt 約 1,435 → 2,709 字。本機模型的 prefill 會變慢（沒有量）；
  執行期 `NLQ_TIMEOUT_MS` 預設 4000 時本機 LLM 輔路徑本來就回不來（`docs/local-mode.md` 第 10.3 節），錄製時用長逾時，不受影響。

### 9.4 重錄

模板與 schema 都變了（`nlq.v2` 的模板雜湊與 schemaHash），nlq 的 cassette 要用本機模型重錄（與 B5 的重錄是同一次）：
Windows 上 `exam_pro\scripts\windows\record_local.bat nlq`，或 `npm run cassettes:rerecord -- --suites nlq`（`docs/local-mode.md` 第 10.7 節）。
重錄後看 `eval/run.js --suite nlq` 的 llm 欄，以及 `parseOnly` 的 `adjustments`（哪幾句被證據檢查擋下或換章）。

### 9.5 測試

- `test/unit/nlqLlmMerge.test.js`（31 項；修正分支由 24 項增加）：證據字（含演算、運算、非選、深、高階）、平面／空間線索與對照表、
  「平面和空間的都要」判成兩個維度都講、空間句子裡的平面方程式／點到平面仍算空間、同名的另一章已列時不換、重複章只記一次、
  `mergeLlm` 帶原句與不帶原句（不帶時行為與改版前相同）、`parseOnly` 的 `adjustments`（不產生新 warning、快取帶回；平面空間都要的句子兩章都留）、
  【容易混淆的章】的章名都在白名單、【範例】合 schema 且規則抓不到章節、模板與 schema 不含 golden 查詢原句、`keywords` 排第一。
- `test/unit/chemAssistantNlq.test.js`「非法章名仍被擋」：原句「化學 反應進行的方向」沒有題型字眼，證據檢查會擋下假 LLM 的題型，
  改為「化學 反應進行的方向，要論述題」（規則層不認得「論述」，題型仍由 LLM 給），斷言一條都沒少。
