# docs/interfaces.md — 階段 1 凍結介面（I0）

> 產出者：S0（基礎與介面凍結），分支 `s0/foundation`。
> 對應規劃：`docs/roadmap-plan.md` §1.5（跨章節裁決）、§2（階段 1 資料層）、§5.3.3–3.6。
> 分工：`docs/stage1-parallel-prompts.md`。

**這份文件是四條平行 workstream（WS-A/B/C/D）之間的不可變契約。**

- 任何 workstream **不得修改本檔**。實作時若發現介面有問題：停下來，把問題寫進 `docs/questions-ws<X>.md`，並在回報中明講，**不要自行改介面繞過**。
- 只有開發者本人可以改本檔；改動後必須通知全部四條 WS「第 N 條已更新為 …，請 rebase 後對齊」。
- 「凍結」的意思是**簽名與形狀**凍結（參數名、回傳鍵名、SQL 輸出欄名、HTTP 狀態碼與訊息字串）。內部實作怎麼寫是各 WS 的自由。

---

## 1. 最終 DDL

### 1.1 檔案與執行方式

```
exam_pro/migrations/0001_init.sql     關聯結構：questions / students / exam_papers / attempts + 索引 + 兩個 VIEW
exam_pro/migrations/0002_vector.sql   檢索欄位：extensions + questions 的 8 個檢索欄位 + HNSW/GIN/trgm 索引
exam_pro/migrate.js                   執行器（只前進，無 down）
```

```bash
npm run migrate           # → node migrate.js up          對 DATABASE_URL 套用
npm run migrate:test      # → node migrate.js up --test   對 TEST_DATABASE_URL 套用（庫名必須以 _test 結尾，否則拒絕執行）
node migrate.js status    # 列出每一支的套用狀態
```

- 套用順序 = 檔名字典序；**每一支 SQL 與它的 `schema_migrations` 紀錄在同一個交易內**，中途失敗整支回滾。
- 追蹤表由 `migrate.js` 自己 `CREATE TABLE IF NOT EXISTS` 建立（不放在 `0001_init.sql`，避免「還沒有追蹤表就要記錄追蹤表」的循環）：

```sql
schema_migrations ( version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now() )
-- version = 檔名，例如 '0001_init.sql'
```

- CI（WS-D）請用 `npm run migrate:test`，不要用 `npm run migrate`。

### 1.2 `questions`

| 欄位 | 型別 | 約束／預設 | 來源 |
|---|---|---|---|
| `id` | `INT` | `GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | 舊 `AUTO_INCREMENT` |
| `subject` | `TEXT` | `NOT NULL CHECK (subject IN ('數學','物理'))` | 舊 `ENUM` |
| `chapter` | `TEXT` | `NOT NULL`（白名單仍由 `config/chapters.js` 在後端驗證） | |
| `question_type` | `TEXT` | `NOT NULL DEFAULT '填空' CHECK (IN ('單選','多選','填空','計算','證明'))` | 舊 `ENUM` |
| `difficulty` | `SMALLINT` | `NOT NULL DEFAULT 3 CHECK (BETWEEN 1 AND 5)` | 舊 `TINYINT` |
| `question_text` | `TEXT` | 可為 NULL | |
| `question_img` | `TEXT` | 可為 NULL | 舊 `VARCHAR(255)` |
| `answer_text` | `TEXT` | `NOT NULL` | |
| `solution_img` | `TEXT` | 可為 NULL | |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | |
| `origin` | `TEXT` | `NOT NULL DEFAULT 'pdf' CHECK (IN ('pdf','manual','seed','variant','legacy'))`（`'legacy'` 由 `0004` 加入，裁決 13） | §4.3.1 |
| `variant_of` | `INT` | `REFERENCES questions(id) ON DELETE SET NULL`；永遠指向家族根節點 | §4.3.1 |
| `chapter_src` | `TEXT` | `NOT NULL DEFAULT 'ai' CHECK (IN ('ai','human','knn'))` | §4.3.1 |
| `archived_at` | `TIMESTAMPTZ` | 軟刪除標記，NULL = 未封存 | §4.3.1 |
| `concept_summary` | `TEXT` | 可選，第一版預設不產生 | 0002 |
| `keywords` | `TEXT[]` | 可選，3~8 個 | 0002 |
| `embed_text` | `TEXT` | 實際送去 embedding 的文本 | 0002 |
| `embed_hash` | `CHAR(64)` | `sha256(embed_text)` 的十六進位小寫 | 0002 |
| `embedding` | `vector(768)` | 維度 = `EMBED_DIM`，L2 正規化後寫入 | 0002 |
| `embedding_model` | `TEXT` | 產生該向量的模型 ID | 0002 |
| `embedded_at` | `TIMESTAMPTZ` | | 0002 |
| `search_tsv` | `TSVECTOR` | 由應用層 jieba 分詞後 `to_tsvector('simple', …)` | 0002 |

索引：`idx_questions_subject_chapter (subject, chapter)`、`idx_questions_variant_of (variant_of)`、`idx_questions_active (subject, chapter) WHERE archived_at IS NULL`、`idx_questions_embedding USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`、`idx_questions_tsv USING gin (search_tsv)`、`idx_questions_text_trgm USING gin (question_text gin_trgm_ops)`。

### 1.3 `students` / `exam_papers` / `attempts`

```sql
students ( id INT IDENTITY PK, name TEXT NOT NULL UNIQUE, note TEXT )

exam_papers ( id INT IDENTITY PK,
              title TEXT NOT NULL,
              student_id INT NOT NULL REFERENCES students(id),
              question_ids INT[] NOT NULL,              -- 保留出題順序
              created_at TIMESTAMPTZ NOT NULL DEFAULT now() )
              -- 索引 idx_exam_papers_student (student_id)

attempts ( id BIGINT IDENTITY PK,
           student_id INT NOT NULL REFERENCES students(id),
           question_id INT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
           paper_id INT REFERENCES exam_papers(id),      -- 遷移進來對不上的舊資料留 NULL
           assigned_at DATE NOT NULL DEFAULT CURRENT_DATE,
           result SMALLINT CHECK (result IN (0,1)),      -- NULL = 未批改；階段 3 才寫入
           graded_at TIMESTAMPTZ,
           UNIQUE (student_id, question_id) )
           -- 索引 idx_attempts_student_date (student_id, assigned_at)、idx_attempts_question (question_id)
```

### 1.4 兩個檢視表

```sql
questions_math    -- SELECT id, subject, chapter, question_type, difficulty, question_text, answer_text, created_at
questions_physics --   FROM questions WHERE subject='數學'|'物理' AND archived_at IS NULL ORDER BY chapter, id
```

### 1.5 I0 裁決紀錄（為什麼 DDL 長這樣）

1. **`attempts.question_id` 用 `ON DELETE RESTRICT`**（不是規劃 §2.3.2 初稿的 `CASCADE`）。作答紀錄是階段 3 弱點面板的基底，不能隨題目消失。配套：`deleteQuestion` 改為「有 `attempts` 紀錄就 `UPDATE archived_at = now()` 並回 `{archived:true}`，否則硬刪」（WS-A 在 D-D3 做）。
2. **`exam_papers.student_id` 是 `NOT NULL`**，不保留 `student_name`。遷移期的回填責任在 WS-B 的 `import_pg.js`。
3. **`question_ids` 是 `INT[]`**，不是 JSON/JSONB。
4. **`EMBED_DIM` 釘死 768**，DDL 直接寫 `vector(768)`。改維度＝換模型，要新開一支 migration 做 `ALTER TABLE … TYPE vector(N)` + 重建索引 + 全量重算。
5. **HNSW 與 GIN 索引直接建在 schema**，不做「回填後才建索引」。
6. **§4.3.1 的階段 3 欄位提前併入 `0001`**（`origin`／`variant_of`／`chapter_src`／`archived_at`／`graded_at`），省一次回填與驗證。
7. **兩個 VIEW 加上 `archived_at IS NULL`**：與「所有候選池一律排除已封存題」一致。
8. **不另建 `idx_attempts_student`**：它是 `idx_attempts_student_date (student_id, assigned_at)` 的前綴，重複。
9. **`id` 用 `GENERATED ALWAYS AS IDENTITY`**：WS-B 匯入舊資料保留原 `id` 時必須寫 `INSERT INTO questions (id, …) OVERRIDING SYSTEM VALUE VALUES …`，匯入後對 `questions`、`exam_papers`、`students` 各跑一次 `SELECT setval(pg_get_serial_sequence('<table>','id'), (SELECT max(id) FROM <table>))`。
10. **`schema_migrations` 由 `migrate.js` 建**，不在 `0001_init.sql` 內（與規劃 §5.3.6 的敘述略有出入，以本條為準）。
11. **開發資料庫的對外埠改為 5442**（測試庫維持 5433）。原因見第 9 條的 `DATABASE_URL`。
12. **`queries/hybrid.js` 的參數多一個 `excludeIds`**（規劃與分工文件的清單裡沒有）。`/similar` 必須排除來源題本身，eval 的 `--exclude-self` 也要同一個機制，與其讓兩邊各自在外層過濾（會讓 `limit` 的語意不一致），不如放進同一段 SQL。見第 5 條。

### 1.6 第一輪裁決（2026-08-21，回應四條 WS 的 `questions-ws*.md`）

以下由開發者本人裁決，**已寫進本檔對應條文**；各 WS 依第 12 條的「合併後小修」對齊。

13. **`origin` 加 `'legacy'`**（B-Q1）：新開 `migrations/0004_origin_legacy.sql` 把 CHECK 改為 `('pdf','manual','seed','variant','legacy')`。從 MySQL 遷移的舊題一律 `origin='legacy'`（只有題幹與 `seed_questions.js` 完全相同的 30 題寫 `'seed'` + `chapter_src='human'`）。階段 3 讀 `origin` 時必須認得 `'legacy'` = 來源未知。
14. **M1 驗收條文改寫**（B-Q2）：「`COUNT(attempts)` = Σ `history_json` 鍵數 − 姓名合併與空姓名造成的差額；差額逐筆列在 `name_merge_report.md`，經人工確認後以 `--allow-merged` 放行」。`verify.js` 預設仍把差額當失敗。
15. **姓名正規化後為空的舊試卷**（B-Q3）：遇到時走 (a) 回 MySQL 補姓名再重跑 export；`import_pg.js` 預設中止不得靜默丟資料。
16. **遷移後的 `search_tsv`／`embedding` 由 `services/embedService.js` 統一回填**（B-Q4）：`import_pg.js` 不寫這兩欄，runbook 在 import→verify 之後接「回填向量.bat」。
17. **`dict.txt.big` 改為選用**（C-1）：見第 2 條。
18. **`buildHybridQuery` 新增選用參數 `sides`**（C-2／D-Q1）：見第 5 條。
19. **`/similar` 拿掉 `scope=all`**（C-3）：跨學科相似題教學上無意義，且無法用同一段 SQL 表達；見第 6 條。
20. **`difficulty_delta` 維持字面語意**（C-4）：給了就鎖定單一難度；階段 3 依實際使用再調。
21. **`search_tsv` 的來源文字與權重**（D-Q2）：見第 2 條；eval 的 `pgEngine` 必須呼叫 `embedService` 匯出的同一支純函式，不得自行 `tokenize(buildEmbedText(q))`。
22. **`config/db.js` 的 `DB_*` 退路**（A-Q1）：D-X1 前保留但預設值為 PG（`5442`／`exam`／`exam`）；**D-X1 後刪除退路，只認 `DATABASE_URL`**。見第 8 條。
23. **`deleteQuestion` 回應、`config/features.js` 匯出形狀、`archived_at` 排除邊界**（A-Q2／Q3／Q4）：全部接受，見新增的第 12 條。
24. **`npm test` 用 glob**（A-Q5／C-8／D-Q3）：`node --test "test/unit/**/*.test.js"`；規劃裡「`node --test test/unit/`」的寫法作廢。
25. **`EVAL_CASSETTE_DIR`**（D-Q4）：階段 2 再裁，目前只由 `eval/run.js` 在行程內設定。
27. **D-X1 收尾已於 2026-08-21 執行**（跳過 14 天窗口，因切換後無任何新寫入）：`config/db.js` 只認 `DATABASE_URL`；`.env`／`.env.example` 移除 `DB_*`；`package.json` 移除 `mysql2`、`migrate:export` script；刪除 `migrate/export_mysql.js` 與 MySQL 版 `schema.sql`；`NOTICE` 移除 mysql2。回滾路徑僅剩「以 `Desktop/期中專案_資料庫備份/` 的 mysqldump 還原 MySQL + `git checkout v1-mysql`」。
26. **eval 的 pg engine 只連 `TEST_DATABASE_URL`**（第一次 push 後 CI 紅燈的根因）：`eval/lib/pgEngine.js` 原本經 `config/db.js` 連 `DATABASE_URL`，而 `seedFixture()` 會 `TRUNCATE` 四張表——本機等於對開發庫清空重灌，CI 則因沒有 5442 而以空訊息的 `AggregateError` 失敗。已改為自建 Pool、只讀 `TEST_DATABASE_URL` 且強制 `_test` 後綴（與 `test/integration/` 同規則）。**任何會寫入／清空資料表的 eval、測試、腳本，一律不得經 `config/db.js` 取連線**；`config/db.js` 只給應用程式本體用。

---

## 2. `utils/tokenize.js`（擁有者：WS-C）

```js
/**
 * 全案唯一的中文分詞器。寫入（search_tsv）、查詢（to_tsquery）、eval（LIKE 基準欄的關鍵字）
 * 三處都只能呼叫它，不得各自實作。
 * @param {string} text
 * @returns {string[]}  去空白後的 token 陣列，順序 = 出現順序
 */
function tokenize(text) {}
module.exports = { tokenize };
```

- 實作：`@node-rs/jieba`（win32 有預編譯 napi，不需 node-gyp）內建詞典 + `config/chapters.js` 的全部章節名（含拆出的子詞）+ `utils/tokenize.js` 內手寫的高中數理繁體名詞表作為自訂詞。**`dict.txt.big` 為選用**（裁決 17）：npm 套件不隨附、不進版控、不 postinstall 下載；環境變數 `JIEBA_DICT_BIG` 指到本機檔案時才額外載入，**預設不啟用**——本機有、CI 沒有會讓同一題兩邊切出不同 token，比切錯詞更糟。
- **`search_tsv` 的來源文字與權重**（裁決 21）：由 `services/embedService.js` 統一組裝——章節名 token 權重 `A`、`keywords` token 權重 `A`、`embed_text` 第 2 行起（題幹口語化文字 + concept_summary）token 權重 `B`；三段 token 的產生是 `embedService` 匯出的純函式，**寫入、回填、eval 的 `pgEngine` 三處都只能呼叫它**。
- `tokenize(null)`／`tokenize('')` 回 `[]`，**不得拋出例外**。
- 輸出可能含 `f(x)`、`a:b`、`x2` 這類殘留符號——這是刻意的。呼叫端一律以 `text[]` 參數傳進 SQL，在 SQL 端用 `quote_literal` 組裝（見第 5 條），**不得**在 JS 端把 token 字串拼接成 `to_tsquery` 的輸入。
- `search_tsv` 的組裝不另外提供 `toTsvSql()`：寫入端（WS-A 的 controller、WS-C 的 `embedService`）自己以 `to_tsvector('simple', array_to_string($n::text[], ' '))` 組，權重規則見規劃 §2.3.7。
- 這一條同時是 §1.5 裁決 3 的落地：**不使用 `Intl.Segmenter`**，規劃 §5.3.3 的 `Intl.Segmenter` 敘述作廢。

---

## 3. `utils/embedText.js`（擁有者：WS-C）

```js
/**
 * 產生送去 embedding 的可重現文本（純函式，無 I/O、無隨機、無時間）。
 * @param {{subject:string, chapter:string, question_type:string, difficulty:number,
 *          question_text:string, concept_summary?:string, keywords?:string[]}} q
 * @returns {string}
 */
function buildEmbedText(q) {}
module.exports = { buildEmbedText };
```

輸出格式（規劃 §2.3.6），以換行連接、**尾端不留空行**：

```
行 1  ${subject}｜${chapter}｜${question_type}｜難度${difficulty}
行 2  latexToPlain(question_text)
行 3  concept_summary            （沒有就整行不輸出）
行 4  keywords.join(' ')         （沒有就整行不輸出）
```

- `latexToPlain`：`$…$` 內的 `\frac{a}{b}` → `a/b`、`\sqrt{x}` → `√x`、`\theta` → `θ`、`\times` → `×`，去掉 `{}`、`^`、`_`，保留數字與字母；`[附圖描述：…]` 保留；選項代號保留。對照表重用 `utils/textFormatter.js` 的 `GREEK`／`SYMBOLS`／`FUNCTIONS`——**只新增 `module.exports` 的匯出，不改既有輸出**，`test/textFormatter.test.js` 的 29 項是契約。
- `embed_hash = sha256(buildEmbedText(q))`（hex 小寫）。**規則一改，全部向量作廢**，必須同時重產 `eval/fixtures/embeddings.*.json` 並在 PR 說明。
- 缺 `question_text` 時第 2 行輸出空字串，不得拋出例外。

---

## 4. `services/llm/index.js`（階段 1 擁有者：WS-C）

```js
embed({ model, texts, dim })
  → Promise<{ vectors: number[][], usage: { tokenIn: number } }>
  // vectors[i] 對應 texts[i]，長度 = dim，已做 L2 正規化

generateJson({ model, system, parts /* [{text}|{pdfBase64}|{fileUri}] */, schema, maxOutputTokens, signal })
  → Promise<{ data: object, usage: { tokenIn, tokenOut, tokenThinking, tokenCached }, latencyMs: number, raw: any }>
```

- 階段 1 只要求 `embed()` 可用；`generateJson()` 先留簽名與 gemini adapter 骨架（階段 2 才填）。
- **模式旗標**：`EMBED_MODE = live | record | fixture`；`LLM_MODE = live | record | replay`。CI 永遠是 `EMBED_MODE=fixture`、`LLM_MODE=replay`。
- adapters：`services/llm/gemini.js`（`@google/genai`；`taskType` 寫入用 `RETRIEVAL_DOCUMENT`、查詢用 `RETRIEVAL_QUERY`；`EMBED_RPM` 令牌桶；429/503 指數退避 1s→60s 最多 6 次）、`services/llm/fixture.js`。
- `FixtureEmbedProvider` 以 **`sha256(embed_text)`（hex 小寫）** 查 `eval/fixtures/embeddings.<model>.<dim>.json`；查不到就 **丟錯**並印「請在本機執行 `npm run eval:record`」，**不得靜默回退成假向量**。
- fixture 檔格式凍結為：`{ "<sha256>": [ … dim 個小數 6 位的數字 … ], … }`。

---

## 5. `queries/hybrid.js`（擁有者：WS-C）

**API 與 eval 共用這一段 SQL**，兩邊都不得自己再寫一份。

```js
/**
 * @param {{
 *   subject: string,                 // 必填
 *   chapter: string|null,            // null = 不限章
 *   difficultyMin: number,           // 1..5
 *   difficultyMax: number,           // 1..5
 *   excludeStudentId: number|null,   // 非 null 時排除該生已在 attempts 的題
 *   excludeIds: number[],            // 排除的題目 id（來源題本身、eval 的 --exclude-self）；預設 []
 *   queryVector: number[],           // 長度必須 = EMBED_DIM(768)
 *   queryTokens: string[],           // tokenize() 的輸出
 *   mode: 'rrf'|'weighted',
 *   sides?: ('vec'|'kw')[],          // 選用（裁決 18）；預設 ['vec','kw']；/similar 的 mode=vector 傳 ['vec']、mode=keyword 傳 ['kw']；
 *                                    // 只含 'kw' 時 queryVector 可為 null
 *   limit: number                    // 1..50
 * }} opts
 * @returns {{ text: string, values: any[] }}   直接餵給 config/db.js 的 query(text, values)
 */
function buildHybridQuery(opts) {}
module.exports = { buildHybridQuery };
```

**執行後的結果集欄位凍結為**（順序 = `ORDER BY score DESC, id ASC`）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | number | 題目 id |
| `score` | number | `mode='rrf'` 時 = `1/(60+vec_rank) + 1/(60+kw_rank)`（缺席側以 0 計）；`mode='weighted'` 時 = `0.7×向量側 + 0.3×關鍵字側`（兩側各自在候選集內 min-max 正規化到 0~1） |
| `vec_rank` | number 或 null | 向量側名次；未進向量側前 50 名為 `null` |
| `kw_rank` | number 或 null | 關鍵字側名次；未命中為 `null` |

必須遵守的實作約束（否則 eval 與 API 會量到不同東西）：

- 候選 CTE 一律含 `archived_at IS NULL`；`excludeStudentId` 用 `NOT EXISTS (SELECT 1 FROM attempts …)`，不是 `NOT IN`。
- 向量側與關鍵字側各自 `ORDER BY r LIMIT 50` 之後才 `FULL OUTER JOIN`（不 `ORDER BY` 就 `LIMIT`，取到的不保證是前 50 名）。
- 關鍵字側查詢詞在 **SQL 端**組裝：`SELECT to_tsquery('simple', string_agg(quote_literal(t), ' | ')) FROM unnest($n::text[]) t`。
- 向量參數以 `pgvector` npm 套件的 `pgvector.toSql(arr)` 轉換後傳入，不把 JS 陣列直接丟給 `pg`。
- `queryTokens` 為空陣列時，關鍵字側必須安全地回空集合（不得讓 `to_tsquery` 收到空字串而報錯）。
- 呼叫端在同一交易內以 `SET LOCAL hnsw.ef_search = 100` 調整召回；eval 為求等效精確，改設為不小於 fixture 題數。

---

## 6. `GET /api/questions/:id/similar`（擁有者：WS-C）

掛在 `routes/index.js` 的 `WS-C: retrieval` 區塊，位置在 `apiKeyAuth` 之後，並套 `middleware/rateLimit.js` 的 `createRateLimiter({ windowMs: 60000, max: 60 })`。

| 查詢參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `k` | int 1~20 | `10` | 回傳筆數；亦接受 `limit` 作為別名 |
| `student_id` | int | 無 | 給了就排除該生已作答（`attempts`）的題；查無此人＝空排除集，正常回結果，**不回 404** |
| `mode` | `hybrid` / `vector` / `keyword` | `hybrid` | 給 eval 與除錯用 |
| `scope` | `chapter` / `subject` | `chapter` | 候選範圍（裁決 19：**沒有 `all`**，給 `all` 回 400） |
| `difficulty_delta` | int -4~4 | 無 | 給了則目標難度 = 來源難度 + delta（夾在 1~5）；未給則 ±1 |

**200 回應形狀（凍結）**：

```jsonc
{
  "source_id": 12,
  "mode": "hybrid",
  "results": [
    { "id": 87, "subject": "數學", "chapter": "向量內積", "question_type": "計算",
      "difficulty": 3, "question_text": "…", "score": 0.0325 }
  ]
}
```

- `results` 依 `score` 由大到小；`score` 的定義同第 5 條的 `score` 欄。
- 每筆**可以**多帶 `vec_rank`／`kw_rank` 作為除錯欄位；消費端（前端、eval、WS-D）必須忽略未知鍵，不得因多欄而失敗。
- 狀態碼：`404` = `:id` 不存在或已封存；`409 {message:'該題尚未建立向量，請執行 npm run embed:backfill'}` = 來源題 `embedding IS NULL`；`FEATURE_SIMILAR` 未開啟時路由不掛載（回 404）。
- 查詢向量**直接取來源題的 `embedding`，不呼叫 Gemini**，因此本端點可離線、可進 CI。
- 本條取代規劃 §2.3.8 的 `{source:{…}, mode, results:[…]}` 舊形狀。

---

## 7. `POST /api/generate-paper`（擁有者：WS-A）

**200 回應（凍結）**——相對現況只多一個 `paper_id`，其餘鍵名與型別不變，`public/index.html` 因此不需改：

```jsonc
{
  "message": "智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。",
  "paper_id": 41,                        // 新增：exam_papers.id
  "paper_title": "王小明-向量內積特訓卷(2026_8_21)",
  "question_ids": [12, 8, 30],           // 已依題型權重排序的最終順序
  "questions": [ { "id": 12, "question_text": "…", "question_type": "計算",
                   "difficulty": 3, "answer_text": "…" } ]
}
```

**錯誤訊息（逐字不變）**：

| 狀態 | `message` |
|---|---|
| 400 | `所有篩選欄位皆為必填！` |
| 400 | `抽題數量必須為大於 0 的整數！` |
| 400 | `抽題數量過大，單次最多 50 題。` |
| 400 | `學生姓名無效！` |
| 400 | `新題目庫存不足！該章節 [${name}] 沒寫過的題目僅剩 ${n} 題。` |
| 409 | `部分題目已被同時指派給該學生，請重試。` |

- `${name}` 的值改為 **`trimmedName`**（只 `trim`）：新設計不再削除 `"` 與 `\`，`examController.js` 現行的 `safeStudentName` 邏輯連同 `JSON_SET` 一起刪除。訊息「格式」不變。
- 409 是新增路徑：`INSERT INTO attempts … ON CONFLICT DO NOTHING` 的 `rowCount` 少於預期題數時 `ROLLBACK` 並回 409。
- 抽題仍用 `utils/shuffle.js`（Fisher-Yates），**不得改動它與 `test/shuffle.test.js` 的 11 項測試**。
- 候選池條件：`subject`、`chapter`、`archived_at IS NULL`、`NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $n)`。

---

## 8. `config/db.js`（擁有者：WS-A）

```js
const { pool, query } = require('../config/db');

query(text /* string */, values /* any[] */) → Promise<{ rows: object[], rowCount: number }>
pool  // 需要交易時用：const client = await pool.connect(); client.query('BEGIN') … client.release()
```

- **匯出形狀從現況的 `module.exports = pool` 改為 `module.exports = { pool, query }`**；所有既有 `require('../config/db')` 的呼叫點都要跟著改（WS-A 在 D-D3 一次做完）。
- **型別轉換集中在這裡**，其他檔案不得再各自 `setTypeParser`：

```js
types.setTypeParser(20, v => parseInt(v, 10));  // INT8 / COUNT(*)：預設回字串，會讓 listQuestions 的 total 變 "30"
types.setTypeParser(1082, v => v);              // DATE：回 'YYYY-MM-DD' 字串，不轉成本地午夜的 Date（時區差一天）
```

- 連線來源：**只認 `DATABASE_URL`**，缺少時啟動即丟錯（裁決 22 的「D-X1 後刪退路」已於 2026-08-21 執行，裁決 27）。`max: 10`。
- `vector` 欄位讀回來是字串；寫入一律用 `pgvector` npm 的 `toSql()`。
- `audit_formulas.js`、`fix_formulas.js`、`seed_questions.js` **不得再自建連線**，一律走這一支。
- `listQuestions` 的 `total` 必須是 `number`（由 `setTypeParser(20)` 保證），WS-D 的整合測試會斷言型別。

---

## 9. 環境變數（全名清單）

`.env.example` 只由 S0 直接編輯；各 WS 需要新變數時**寫在 PR 描述**，由開發者本人合入。

| 變數 | 預設／範例 | 用途 | 誰讀 |
|---|---|---|---|
| `DATABASE_URL` | `postgres://exam:exam@localhost:5442/tutor_exam_bank` | 正式／開發 PG 連線。**埠是 5442 不是規劃裡寫的 5432**——開發機上已有一個原生的 `postgresql-x64-17` 服務占用 5432，兩者同時 LISTEN 時連線會被它接走（症狀是「密碼驗證失敗」）。日後停用該服務要改回 5432 的話，同步改 `docker-compose.yml` 與本表 | `config/db.js`、`migrate.js` |
| `TEST_DATABASE_URL` | `postgres://exam:exam@localhost:5433/tutor_exam_bank_test` | 整合測試 PG 連線，**庫名必須以 `_test` 結尾** | `migrate.js --test`、`test/integration/` |
| ~~`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`~~ | — | **已移除**（裁決 27，D-X1 收尾 2026-08-21）：舊 MySQL 變數連同 `migrate/export_mysql.js`、`mysql2` 相依一起退役 | — |
| `EMBED_MODEL` | `gemini-embedding-001` | embedding 模型 ID | WS-C |
| `EMBED_DIM` | `768` | **釘死**；改值必須連同新 migration 與全量重算 | WS-C、WS-D |
| `EMBED_RPM` | `60` | embedding 每分鐘請求上限（令牌桶） | WS-C |
| `EMBED_BATCH` | `32` | 回填每批筆數（每批一個交易 = 天然斷點續跑） | WS-C |
| `EMBED_MODE` | `fixture` | `live` / `record` / `fixture`；CI 恆為 `fixture` | WS-C、WS-D |
| `LLM_MODE` | `replay` | `live` / `record` / `replay`；CI 恆為 `replay` | WS-C（階段 2 起 WS-B） |
| `FEATURE_SIMILAR` | `false` | `/api/questions/:id/similar` 是否掛載 | WS-C |
| `FEATURE_HYBRID_SEARCH` | `false` | `listQuestions` 是否改走 hybrid 檢索 | WS-A、WS-C |
| `EMBED_FIXTURE_DIR` | `exam_pro/eval/fixtures` | fixture 向量檔目錄（單元測試把它指到暫存目錄） | WS-C、WS-D |
| `JIEBA_DICT_BIG` | 未設定 | 指到本機 `dict.txt.big` 才額外載入；CI 與預設皆不啟用 | WS-C |
| `BACKUP_DIR` | `exam_pro/backups` | `scripts/backup.js` 輸出資料夾 | WS-B |
| `BACKUP_KEEP` | `14` | 保留份數 | WS-B |
| `BACKUP_COPY_DIR` | （空） | 額外複製到雲端同步資料夾；留空不複製 | WS-B |
| `BACKUP_PG_SERVICE` | `postgres` | `docker compose exec` 的服務名 | WS-B |

- 所有 `FEATURE_*` 集中在 `config/features.js`（WS-A 建立），**預設全關**；DB 驅動層不放旗標。
- 布林值的解讀規則凍結為：字串 `1` 或 `true`（不分大小寫）為真，其餘皆為假。
- `GEMINI_API_KEY`、`API_KEY`、`ALLOWED_ORIGINS`、`IMAGE_HOST_ALLOWLIST`、`NODE_ENV`、`PORT` 沿用現況，不變。
- **GitHub Actions 不放任何 LLM 金鑰**；`.bat` 不得出現金鑰。

---

## 10. 檔案所有權與 `routes/index.js` 區塊

### 10.1 誰擁有哪些檔案（別人不得改）

| Workstream | 擁有的檔案 |
|---|---|
| **S0**（已完成） | `docker-compose.yml`、`migrations/*.sql`、`migrate.js`、`.env.example`、`docs/interfaces.md`、`啟動資料庫.bat` |
| **WS-A** DB 與 controller | `config/db.js`、`config/features.js`、`controllers/*`、`seed_questions.js`、`audit_formulas.js`、`fix_formulas.js`、`setup_index_views.js`（刪除）、`test/integration/controllers*` |
| **WS-B** 遷移與維運 | `migrate/*`、`scripts/backup.js`、所有 `.bat`（`啟動資料庫.bat` 於 S0 合併後移交 WS-B）、`docs/cutover-runbook.md` |
| **WS-C** 檢索零件 | `utils/tokenize.js`、`utils/embedText.js`、`services/llm/*`、`services/embedService.js`、`services/retrievalService.js`、`queries/hybrid.js`、`scripts/backfill_embeddings.js`、`docs/retrieval.md`；`utils/textFormatter.js` **只加匯出** |
| **WS-D** 評估與 CI | `eval/**`、`test/unit/`、`test/integration/`（controller 以外）、`.github/workflows/ci.yml`、`.gitattributes`、`package.json` 的 `scripts`、`public/index.html` |

共用檔規則：

- `routes/index.js` —— **append-only**，只能在自己的區塊內加行，不重排既有路由。
- `package.json` —— deps 各 WS 只加自己需要的；`scripts` 由 WS-D 統一（S0 已先放入 `migrate`、`migrate:test`、`db:up`、`db:down`，dependency 已先放入 `pg`）。新增 script 一律用 `eval:*`／`test:*`／`db:*` 前綴避免撞名。
- `.env.example` —— 不直接改，新變數列在 PR 描述。
- `public/index.html` —— 除 S0 的 PR-A 改動外，其他 WS 不得直接編輯；每次改完跑 `exam_pro/README.md` 的「截斷檔自檢」。

### 10.2 `routes/index.js` 的四個註解區塊（名稱凍結）

S0 已在 `routes/index.js` 建好四個空區塊，各 WS 只在自己的區塊內 append：

```js
// ===== [WS-A: DB] =====
// ===== [/WS-A: DB] =====

// ===== [WS-B: ops] =====
// ===== [/WS-B: ops] =====

// ===== [WS-C: retrieval] =====
// ===== [/WS-C: retrieval] =====

// ===== [WS-D: eval] =====
// ===== [/WS-D: eval] =====
```

rebase 時若兩條 WS 都動了本檔，衝突只會落在相鄰行，**兩邊都保留**即可。

---

## 11. migrations 只增不改

- `0001_init.sql`、`0002_vector.sql` 一旦合進 `main` 就是歷史，**任何人都不得再編輯其內容**（包括加註解）。
- 之後任何欄位／索引／約束變更一律新開檔案，四位數編號 + `_` + 英文小寫描述，例如 `0004_add_question_source.sql`。
- **`0003_jobs.sql` 已保留給階段 2 的 `jobs`／`job_events`**，階段 1 不得占用這個編號。
- **`0004_origin_legacy.sql`** 已由開發者本人依裁決 13 建立（`origin` CHECK 加 `'legacy'`）。
- `migrate.js` 沒有 `down`：寫錯的 migration 用「再寫一支把它改回來」修正，不做回滾腳本。
- 因此 WS-B 的匯入若發現缺欄位，**不是**改 `0001`，而是寫進 `docs/questions-wsB.md` 由開發者本人裁決後新開一支。

---

## 12. 第一輪合併後補凍結的介面（裁決 23）

### 12.1 `DELETE /api/questions/:id`（擁有者：WS-A）

| 情境 | 狀態 | 回應 |
|---|---|---|
| 有 `attempts` 紀錄 | 200 | `{ message: '該題已有學生作答紀錄，改為封存（不再出現在題庫與組卷候選中）。', id, archived: true }` |
| 沒有紀錄 | 200 | `{ message: '題目已刪除！', id }`（不帶 `archived`） |
| 找不到或已封存 | 404 | `{ message: '找不到該題目' }` |

### 12.2 `config/features.js`（擁有者：WS-A）

```js
const features = require('../config/features');
features.FEATURE_SIMILAR          // boolean getter，即時讀 process.env
features.FEATURE_HYBRID_SEARCH    // boolean getter
features.isEnabled('FEATURE_XXX') // 任意旗標
features.parseBool(value)         // '1' 或 'true'（不分大小寫）為真
```

### 12.3 `archived_at IS NULL` 的套用邊界

| 位置 | 排除已封存 |
|---|---|
| `generatePaper` 候選池、`listQuestions`、`getChapters`、`updateQuestion`（改不到回 404）、`/similar`、hybrid、few-shot、`audit_formulas`／`fix_formulas` | ✅ |
| **`wordController.downloadWord`（重印已出過的試卷）** | ❌ 不排除——舊卷必須印得出全部題目 |

### 12.4 新增／修改題目必須同步檢索欄位（A 的合併後小修）

`POST /api/questions` 與 `PUT /api/questions/:id` 成功後，WS-A 的 controller 必須呼叫 `embedService.embedByIds([id])`（`EMBED_MODE=fixture` 或無金鑰時允許失敗並記 log，不影響主要回應），或至少把該題 `embed_hash` 設為 NULL 讓 `backfill_embeddings.js` 撿到；**不得讓新題永遠沒有 `search_tsv`**。

### 12.5 各 WS 合併後的小修清單

| WS | 必修 |
|---|---|
| A | 12.4；D-X1 時刪 `DB_*` 退路 |
| B | `import_pg.js` 舊題寫 `origin='legacy'`（依 `0004`）；runbook 在 verify 後接「回填向量.bat」 |
| C | 無 |
| D | `evalRanker` 兩個測試改成對 jieba 的期望值或分詞器無關斷言；`schema.test.js` 的測試學生加清理／`ON CONFLICT`；純向量欄改傳 `sides:['vec']`；`pgEngine` 改呼叫 `embedService` 的 tsv 純函式；加 B 要的 `migrate:export`／`migrate:import`／`migrate:verify`／`db:backup` 四個 scripts |

---
