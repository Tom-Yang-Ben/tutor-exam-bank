# docs/retrieval.md — 檢索零件說明（WS-C）

> 擁有者：WS-C（分支 `ws-c/retrieval`）。對應任務：D-T1、D-E3、A-T3 的 `embed()`、D-V1、D-R1。
> 介面契約在 `docs/interfaces.md` 第 2～6 條，本檔只解釋「怎麼用、為什麼這樣寫、量到什麼」，不重複契約。

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

**沒有用 `dict.txt.big`。** `docs/interfaces.md` 第 2 條寫的是 jieba + `dict.txt.big`（繁體詞典），但
`@node-rs/jieba` 並不隨附這個檔（只有簡體的 `dict.txt`），要嘛把 8.5 MB 的詞典 commit 進 repo、
要嘛安裝時下載——兩條路都有代價，因此第一版改以「章節名 + 手寫學科詞」補足，
並留 `JIEBA_DICT_BIG` 環境變數當實驗開關（**預設不啟用**：本機有、CI 沒有的話，
同一題在兩邊會切出不同 token，寫入與查詢就不再一致）。裁決請見 `docs/questions-wsC.md` 第 1 題。

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

**`search_tsv` 的組成**（規劃 §2.3.7 的權重規則，寫入端各自組，`interfaces.md` 第 2 條明講不提供 `toTsvSql()`）：

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
讓三種模式共用同一段 SQL 而不是各寫一份。詳見 `docs/questions-wsC.md` 第 2 題。

呼叫端要在**同一個交易**內設 `SET LOCAL hnsw.ef_search = 100`；eval 為求等效精確，設為不小於 fixture 題數。

## 6. `GET /api/questions/:id/similar`

掛在 `routes/index.js` 的 `WS-C: retrieval` 區塊，`apiKeyAuth` 之後、每分鐘 60 次的 rate limit。
`FEATURE_SIMILAR` 未開啟時**路由不掛載**（請求落到預設 404）。

| 參數 | 預設 | 說明 |
|---|---|---|
| `k`（別名 `limit`） | 10 | 1~20；超出範圍會夾進區間，不回 400 |
| `student_id` | 無 | 排除該生已作答的題；查無此人 = 空排除集，仍回 200 |
| `mode` | `hybrid` | `hybrid` / `vector` / `keyword`；給別的值回 **400**（默默換成 hybrid 會讓 eval 量錯東西）|
| `scope` | `chapter` | `chapter` / `subject` / `all`；給別的值回 400 |
| `difficulty_delta` | 無 | 給了就**鎖定**「來源難度 + delta」（夾在 1~5）；未給則 ±1 |

- 查詢向量**直接取來源題的 `embedding`，不呼叫 Gemini** → 可離線、可進 CI。
- 關鍵字側的查詢詞取來源題 `search_tsv` 裡權重 A 的詞（＝寫入時的章節與 keywords，已經過 `tokenize`）；
  沒有就退回 `tokenize(章節 + keywords)`，再沒有就退回 `tokenize(題幹)`。
- `404` = `:id` 不存在**或已封存**；`409` = 來源題還沒有向量（`mode=keyword` 例外，那條路不需要向量）。
- `results` 每筆多帶 `vec_rank` / `kw_rank` 兩個除錯欄位，消費端請忽略未知鍵。
- `scope=all` 會逐學科各跑一次同一段 SQL 再依 `score` 合併（`buildHybridQuery` 的 `subject` 是必填），
  見 `docs/questions-wsC.md` 第 3 題。

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
| `scope=all`、`mode=hybrid` | 183 ms | 276 ms |

- 規劃 §2.8 的「萬題 p95 < 100 ms」對**預設路徑（同章）達成**。
- `scope=subject` 慢的是**關鍵字側**而不是向量側（兩側 292 ms vs 只向量側 70 ms）。這份合成資料只有
  4 種題型模板重複 2,500 次，幾乎每一列都命中 `to_tsquery`（GIN 掃出 8,610 列再排 `ts_rank_cd`），
  是刻意的最壞情況；真題庫的命中列數會少一個數量級。
- **HNSW 在這個規模不會被規劃器選用**：候選 CTE 與 `questions` join 之後走 Bitmap Heap Scan + top-N 排序。
  把條件內聯到向量側（讓 `ORDER BY … LIMIT` 有機會走索引）、甚至加上 pgvector 0.8 的
  `hnsw.iterative_scan = relaxed_order` 實測都**沒有變快**（同章 19 ms vs 17 ms、同科 97 ms vs 70 ms），
  因此不改 `interfaces.md` 第 5 條的 SQL 形狀。這與規劃 §2.3.7「萬級以下常走 seq scan，屬正常」一致。

**檢索品質**：CI 層的 Recall@5／Recall@10／MRR 三欄對照由 WS-D 的 `eval/run.js` 產出（D-R2），
本 WS 只保證「eval 與 API 走同一段 SQL」。

## 8. 測試

```bash
npm test                                              # 138 項，不連 DB、不呼叫 Gemini、不需 secrets
node --env-file=.env --test "test/integration/*.test.js"   # 38 項，需要 postgres_test（5433）
```

- 單元：`test/unit/tokenize.test.js`(21)、`embedText.test.js`(23)、`llmEmbed.test.js`(11)、
  `embedService.test.js`(18)、`hybridQuery.test.js`(25)
- 整合：`test/integration/hybrid.pg.test.js`(38)——**沒設 `TEST_DATABASE_URL` 就整組 skip**，
  所以 `npm test` 永遠不會連到資料庫。跑之前要先 `npm run migrate:test`。
