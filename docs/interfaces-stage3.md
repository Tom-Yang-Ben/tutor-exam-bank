# docs/interfaces-stage3.md — 階段 3 凍結介面（I0''）

> 產出者：S0（階段 3 介面凍結），分支 `s0/stage3`。
> 對應規劃：`docs/roadmap-plan.md` §4（階段 3）全章、§2.3.7–3.8（hybrid／`/similar`）、§3.3（jobs 管線）。
> 分工：`docs/stage3-parallel-prompts.md` §1 的分工總表。

**這份文件是四條平行 workstream（WS-A/B/C/D）之間的不可變契約。**

- 任何 workstream **不得修改本檔**，也不得修改 `docs/interfaces.md`（階段 1，I0）與 `docs/interfaces-stage2.md`（階段 2，I0'）——**三份都仍然有效**。
- 實作時若發現介面有問題：停下來，把問題寫進 `docs/questions3-ws<X>.md`，並在回報中明講，**不要自行改介面繞過**。
- 只有開發者本人可以改本檔；改動後必須通知全部四條 WS「第 N 條已更新為 …，請 rebase 後對齊」。
- 「凍結」的意思是**簽名與形狀**凍結（參數名、回傳鍵名、SQL 輸出欄名、HTTP 狀態碼與訊息字串）。內部實作怎麼寫是各 WS 的自由。
- 本檔只寫**階段 3 新增或延伸**的東西。既有形狀（`/similar`、`GET /api/jobs/:id`、`generateJson`、`buildHybridQuery`、狀態機、`payload` 六鍵…）一律以前兩份為準；第 11 條列出全部銜接點。

---

## 0. DDL 核對結論：**不開 `0006_`**

階段 3 需要的欄位在階段 1／2 就已經併入（`interfaces.md` 裁決 6、`interfaces-stage2.md` 第 1.1 條）。S0 於 2026-08-23 對**兩個庫**逐欄核對，結果全部存在：

| 需求（規劃 §4.3.1） | 實際位置 | 開發庫 5442 | 測試庫 5433 |
|---|---|---|---|
| `questions.origin`（`pdf/manual/seed/variant/legacy`） | `0001_init.sql` + `0004_origin_legacy.sql` | ✅ | ✅ |
| `questions.variant_of`（`REFERENCES questions(id) ON DELETE SET NULL`） | `0001_init.sql` | ✅ | ✅ |
| `questions.chapter_src`（`ai/human/knn`） | `0001_init.sql` | ✅ | ✅ |
| `questions.archived_at` | `0001_init.sql` | ✅ | ✅ |
| `attempts.result`（`SMALLINT CHECK (result IN (0,1))`，NULL = 未批改） | `0001_init.sql` | ✅ | ✅ |
| `attempts.graded_at` | `0001_init.sql` | ✅ | ✅ |
| `attempts.paper_id` | `0001_init.sql` | ✅ | ✅ |
| `exam_papers.student_id`（`NOT NULL`） | `0001_init.sql` | ✅ | ✅ |
| `jobs.kind`（`pdf/variant`）、`jobs.source_question_id`、`pdf_sha256` 可為 NULL | `0003_jobs.sql`（含 `jobs_kind_payload` CHECK） | ✅ | ✅ |
| `idx_attempts_student_date (student_id, assigned_at)` | `0001_init.sql` | ✅ | ✅ |
| `idx_attempts_question`、`idx_questions_variant_of`、`idx_questions_active` | `0001_init.sql` | ✅ | ✅ |
| `job_questions.review_reason` 含 `'awaiting_approval'` | `0003_jobs.sql` 的 CHECK（八個值） | ✅ | ✅ |
| `job_events.node` **沒有** CHECK（可加 `'generate'`） | `0003_jobs.sql` 裁決 10 | ✅ | ✅ |
| `uq_questions_text_hash_active`（部分唯一索引） | `0005_text_hash_unique.sql` | ✅ | ✅ |

兩個庫的 `schema_migrations` 都是 `0001`…`0005` 全數套用。核對指令（可重跑）：

```bash
docker exec -i exam_pg      psql -U exam -d tutor_exam_bank      -c "\d questions" -c "\d attempts" -c "\d jobs"
docker exec -i exam_pg_test psql -U exam -d tutor_exam_bank_test -c "SELECT version FROM schema_migrations ORDER BY version;"
```

**結論：階段 3 不新增 migration。** 若施工中真的發現缺欄位，寫進 `docs/questions3-ws<X>.md`，由開發者本人裁決後從 `0006_stage3.sql` 起新開一支（第 12 條），**不得**編輯 `0001`–`0005`。

**三個既有欄位的階段 3 語意（凍結）**

- `origin='legacy'` = 來源未知（從 MySQL 遷移進來的舊題）。階段 3 所有讀 `origin` 的地方都必須認得它，**不得**假設只有四個值。
- `chapter_src` 的寫入權責：`'human'` 只由「人動手改過章節」產生（`PUT /api/questions/:id` 既有的 `CASE WHEN chapter IS DISTINCT FROM …`、`POST /api/review/:jqId/approve`）；`'knn'` 只由第 5 條的短路產生；其餘一律 `'ai'`。
- `archived_at IS NULL` 的套用邊界沿用 `interfaces.md` 第 12.3 條，階段 3 補三個位置：**弱點面板（第 1.5 條）與試卷明細（第 1.3 條）不排除已封存題**（歷史就是歷史，與 `downloadWord` 同一條線）；**變式候選池（第 3 條）與 kNN few-shot（第 5 條）一律排除**。

---

## 1. 學生、試卷、批改與弱點面板 API（擁有者：WS-A）

五支全部掛在 `routes/index.js` 的 `[WS3-A: students]` 區塊，位置在 `apiKeyAuth` 之後（`app.js` 已對 `/api` 全域套用）。錯誤回應一律 `{ message }`，**訊息字串逐字凍結**。

`FEATURE_STUDENTS` 未開啟時**這五條路由不掛載**（與 `FEATURE_SIMILAR` 同一種做法，請求落到 Express 預設 404）。

### 1.1 `GET /api/students`

```jsonc
{ "items": [ { "id": 3, "name": "王小明", "papers": 4, "graded_ratio": 0.625 } ] }
```

- `papers` = 該生的 `exam_papers` 列數（number）。
- `graded_ratio` = 該生 `attempts` 中 `result IS NOT NULL` 的比例，四捨五入到小數第 4 位；該生沒有任何 `attempts` 時回 **`0`**（不是 `null`、不是 `NaN`）。
- 沒有任何試卷的學生**也要出現**（`LEFT JOIN`），`papers: 0`、`graded_ratio: 0`。
- 排序固定 `ORDER BY s.name, s.id`。
- 這一支不分 `subject`、不看 `days`：它是導覽用的清單。

### 1.2 `GET /api/students/:id/papers`

```jsonc
{ "items": [ { "paper_id": 41, "title": "王小明-向量內積特訓卷(2026_8_21)",
               "created_at": "2026-08-21T09:12:33.412Z", "total": 10, "graded": 7 } ] }
```

- `total` = `cardinality(exam_papers.question_ids)`；`graded` = 該卷 `attempts` 中 `result IS NOT NULL` 的列數。
- 排序固定 `ORDER BY created_at DESC, paper_id DESC`（最近出的卷在最上面——這是批改入口，不是歷史檔案）。
- `created_at` 是 `TIMESTAMPTZ`，JSON 序列化為 ISO 8601 字串。
- 404：`{ message: '找不到該學生' }`（`:id` 不是整數也回 404，不回 400）。

### 1.3 `GET /api/papers/:id`

```jsonc
{ "id": 41, "title": "王小明-向量內積特訓卷(2026_8_21)", "student_id": 3,
  "created_at": "2026-08-21T09:12:33.412Z",
  "questions": [ { "question_id": 12, "question_text": "…", "question_type": "計算",
                   "difficulty": 3, "result": null } ] }
```

- `questions` 的順序 = `exam_papers.question_ids` 的**陣列順序**（出題順序）。實作用 `unnest(question_ids) WITH ORDINALITY … ORDER BY ord`。
- `result` 取自 `attempts`（同 `paper_id` + `question_id`）：`0`／`1`／`null`（未批改）。查不到對應 `attempts` 列時也是 `null`。
- **不排除 `archived_at IS NOT NULL` 的題**：舊卷必須顯示得出全部題目（`interfaces.md` 第 12.3 條的同一條線）。
- 404：`{ message: '找不到該試卷' }`。

### 1.4 `PATCH /api/papers/:id/results`

```jsonc
// body
{ "results": [ { "question_id": 12, "result": 1 },
               { "question_id": 8,  "result": 0 },
               { "question_id": 30, "result": null } ] }     // null = 取消批改
// 200
{ "updated": 3 }
```

- **單一交易、全有全無**：任何一筆不合法就整包 400 並 `ROLLBACK`；`updated` 只在 200 時出現。
- 寫入語意凍結為：`result` 非 null → `result = $v, graded_at = now()`；`result` 為 null → `result = NULL, graded_at = NULL`（取消批改要把時間一起清掉，否則面板會看到「批改過但沒有結果」）。
- `updated` = 實際 `UPDATE` 到的列數（`rowCount`）；重送同樣的值也算數。
- 實作建議（不強制）：一句 `UPDATE attempts a SET … FROM unnest($2::int[], $3::smallint[]) AS r(question_id, result) WHERE a.paper_id = $1 AND a.question_id = r.question_id`。

| 狀態 | `message`（逐字凍結） |
|---|---|
| 400 | `results 必須是非空陣列。` |
| 400 | `results 最多 100 筆。` |
| 400 | `results 內有重複的 question_id。` |
| 400 | `question_id 必須是正整數。` |
| 400 | `result 只接受 0、1 或 null。` |
| 400 | `題目 ${question_id} 不在這張試卷內。`（第一個不在 `question_ids` 內的題號，`${…}` 代入該題號） |
| 404 | `找不到該試卷` |

### 1.5 `GET /api/students/:id/weakness?subject=&days=90`

```jsonc
{
  "by_chapter":    [ { "chapter": "向量內積", "assigned": 12, "graded": 9, "wrong": 5,
                       "wrong_rate": 0.5556, "low_sample": false } ],
  "by_type":       [ { "question_type": "計算", "assigned": 20, "graded": 14, "wrong": 6,
                       "wrong_rate": 0.4286, "low_sample": false } ],
  "by_difficulty": [ { "difficulty": 4, "assigned": 8, "graded": 3, "wrong": 2,
                       "wrong_rate": 0.6667, "low_sample": true } ],
  "trend_weekly":  [ { "week_start": "2026-08-17", "graded": 12, "wrong": 5 } ],
  "recent_wrong":  [ { "question_id": 87, "chapter": "向量內積", "question_text": "…",
                       "assigned_at": "2026-08-21" } ]
}
```

| 查詢參數 | 型別 | 預設 | 不合法時 |
|---|---|---|---|
| `subject` | `'數學'`／`'物理'` | 無（＝不分科） | 400 `subject 不在白名單內。` |
| `days` | int 1~365 | `90` | 400 `days 必須是 1~365 的整數。` |

- 三張表的分組鍵名**逐字凍結**：`by_chapter` 用 `chapter`、`by_type` 用 `question_type`、`by_difficulty` 用 `difficulty`（number 1~5）。
- `wrong_rate` = `wrong / graded`，四捨五入到小數第 4 位；`graded = 0` 時為 **`null`**（不是 0——沒批改不等於全對）。
- `low_sample` = `graded < WEAKNESS_MIN_N`（預設 5）。**`graded = 0` 也是 `low_sample: true`**。
- 三張表的排序固定 `ORDER BY wrong_rate DESC NULLS LAST, graded DESC, <分組欄> ASC`。
- `trend_weekly`：`date_trunc('week', a.assigned_at)::date`（ISO 週，週一起算），只列**有資料的週**（不補零，斷點由前端處理），`ORDER BY week_start ASC`。`week_start` 是 `'YYYY-MM-DD'` **字串**——`config/db.js` 已把 `DATE` 的 type parser 設成回字串，不要在這裡轉成 `Date`（會差一天）。
- `recent_wrong`：`result = 0`，`ORDER BY a.assigned_at DESC, a.question_id DESC`，`LIMIT 20`（凍結）。`assigned_at` 同樣是 `'YYYY-MM-DD'` 字串。
- 時間窗一律 `a.assigned_at >= CURRENT_DATE - $2::int`；學科一律 `($3::text IS NULL OR q.subject = $3)`。
- **不排除已封存題**（同 1.3）。
- 404：`{ message: '找不到該學生' }`。

### 1.6 `services/weaknessService.js`（純函式，五支建 SQL 的函式）

```js
/**
 * 五支都是純函式：只組字串與參數陣列，不連 DB、不讀 process.env、無時間、無隨機。
 * @param {{ studentId:number, subject:string|null, days:number, limit?:number }} opts
 * @returns {{ text:string, values:any[] }}   直接餵給 config/db.js 的 query(text, values)
 */
buildByChapter(opts)      // values = [studentId, days, subject]
buildByType(opts)         // values = [studentId, days, subject]
buildByDifficulty(opts)   // values = [studentId, days, subject]
buildTrendWeekly(opts)    // values = [studentId, days, subject]
buildRecentWrong(opts)    // values = [studentId, days, subject, limit]，limit 預設 20

module.exports = { buildByChapter, buildByType, buildByDifficulty,
                   buildTrendWeekly, buildRecentWrong };
```

- **參數順序凍結為 `$1 = studentId`、`$2 = days`、`$3 = subject`、`$4 = limit`**。單元測試釘的就是這個順序——純文字單測擋不了 SQL 語法錯，只擋得住參數錯位，那是它唯一的職責。
- **三張聚合表一律用 CTE 外包一層**：

```sql
WITH agg AS (
  SELECT q.chapter,
         COUNT(*)                                     AS assigned,
         COUNT(*) FILTER (WHERE a.result IS NOT NULL) AS graded,
         COUNT(*) FILTER (WHERE a.result = 0)         AS wrong
    FROM attempts a JOIN questions q ON q.id = a.question_id
   WHERE a.student_id = $1
     AND a.assigned_at >= CURRENT_DATE - $2::int
     AND ($3::text IS NULL OR q.subject = $3)
   GROUP BY q.chapter
)
SELECT chapter, assigned, graded, wrong,
       round((wrong::numeric / NULLIF(graded, 0)), 4)::float8 AS wrong_rate
  FROM agg
 ORDER BY wrong_rate DESC NULLS LAST, graded DESC, chapter ASC;
```

  外包一層是**必要的**，不是風格：Postgres 只允許輸出別名在 `ORDER BY` 中**單獨出現**，`ORDER BY wrong::float / NULLIF(graded,0)` 會報 `column "wrong" does not exist`（規劃 §4.3.5）。這也是為什麼這組查詢的正確性必須由 `test/integration/students.pg.test.js` 保證，而不是由純文字單測保證。
- `low_sample` 由 controller 依 `WEAKNESS_MIN_N` 計算，**不寫進 SQL**（門檻是設定值，改一次不該動 SQL）。
- 整合測試必跑兩件事：① 1,000 筆 fixture `attempts` 的聚合值逐欄比對；② `EXPLAIN (FORMAT JSON)` 的計畫含 `idx_attempts_student_date`。

---

## 2. 組卷的家族互斥（擁有者：WS-A）

### 2.1 `utils/pickOnePerFamily.js`

```js
const { shuffle } = require('./shuffle');

/**
 * 每個變式家族只留一題，再對「家族代表」洗牌。純函式：無 I/O、無時間、不讀 process.env。
 *
 * 家族鍵 = row.variant_of ?? row.id（等價於 SQL 的 COALESCE(variant_of, id)）。
 * variant_of 永遠指向家族根節點（interfaces.md 第 1.2 條），所以不需要遞迴。
 *
 * @param {Array<{id:number, variant_of:number|null}>} rows  候選池；不會被修改
 * @param {(items:Array) => Array} [shuffleFn]               預設 utils/shuffle.js 的 shuffle
 * @returns {Array} 每家族一題、且已洗牌的新陣列（元素是原物件的參照）
 */
function pickOnePerFamily(rows, shuffleFn = shuffle) {}
module.exports = { pickOnePerFamily };
```

- 分組**保留第一次出現的順序**（決定性），每組以 `shuffleFn(members)[0]` 取代表，最後 `shuffleFn(representatives)` 回傳。
- 缺 `variant_of` 鍵視同 `null`；`rows` 為 `[]` 回 `[]`。
- 注入 `shuffleFn` 是為了測試：分佈測試比照 `test/unit/shuffle.test.js` 的做法但輕量（每家族等機率、家族代表順序均勻）。
- **語意的改變要在文件與測試裡明講**：抽題從「每題等機率」變成「**每家族等機率**」。

### 2.2 接進 `controllers/examController.js`

- 候選池 SQL 只多撈一欄：`SELECT q.id, q.variant_of FROM questions q WHERE …`（其餘條件不變）。
- 順序凍結為：**撈候選 → `pickOnePerFamily` → 檢查數量 → `slice(0, limitCount)` → 依題型權重排序**。
- 「庫存不足」的 400 檢查移到**家族互斥之後**，`${n}` 代入**家族數**（實際抽得到的題數）。訊息格式與 `interfaces.md` 第 7 條完全相同，一個字都不改：
  `新題目庫存不足！該章節 [${trimmedName}] 沒寫過的題目僅剩 ${n} 題。`
- `POST /api/generate-paper` 的 200 回應**完全不變**（`interfaces.md` 第 7 條，已含 `paper_id`），既有整合測試是契約。
- `utils/shuffle.js` 與 `test/unit/shuffle.test.js` 的 11 項**不得改動**。

---

## 3. 相似題／變式題 API：`POST /api/questions/:id/variants`（擁有者：WS-B）

掛在 `[WS3-B: variants]` 區塊，`apiKeyAuth` 之後，套 `createRateLimiter({ windowMs: 60000, max: 10, message: '變式題請求過於頻繁，請稍候再試（每分鐘最多 10 次）。' })`（與 `/analyze-pdf`、`POST /api/jobs` 同一個等級，但**是各自獨立的桶**）。

`FEATURE_VARIANTS` 未開啟時**路由不掛載**（落到 404）。

```jsonc
// body（全部選填，下表是預設值）
{ "count": 1, "difficulty_delta": 0, "student_id": null, "force_generate": false }

// 200 —— 庫裡就有夠用的相似題，零 LLM 費用
{ "mode": "retrieved",
  "questions": [ { "id": 87, "subject": "數學", "chapter": "向量內積", "question_type": "計算",
                   "difficulty": 3, "question_text": "…", "score": 0.9142, "cosine": 0.9142 } ] }

// 202 —— 池不足（或 force_generate）才生成
{ "mode": "generating", "job_id": 57, "state": "queued", "existing": false }
```

| 欄位 | 型別 | 預設 | 不合法時（400） |
|---|---|---|---|
| `count` | int 1~`VARIANT_MAX_PER_REQUEST`(3) | `1` | `count 必須是 1~3 的整數。` |
| `difficulty_delta` | `-1`／`0`／`1` | `0` | `difficulty_delta 只接受 -1、0、1。` |
| `student_id` | int > 0 | 無 | `student_id 必須是正整數。` |
| `force_generate` | boolean | `false` | `force_generate 必須是布林值。` |

其他狀態碼：

| 狀態 | 回應 |
|---|---|
| 400 | `{ message: '無效的題目 ID' }` |
| 404 | `{ message: '找不到該題目' }`（`:id` 不存在**或已封存**，與 `/similar` 同一條線） |
| 409 | `{ message: '該題尚未建立向量，請執行 npm run embed:backfill' }`（藍本 `embedding IS NULL`；**與 `/similar` 逐字相同**） |
| 429 | 由限流器產生，字串如上表 |

### 3.1 `retrieved` 分支的候選條件（逐條凍結）

以藍本題的 `embedding` 當查詢向量（**不呼叫 Gemini，可離線**），對 `questions` 查：

1. `subject` 與藍本相同；
2. `archived_at IS NULL`；
3. `id <> 藍本 id`；
4. 給了 `student_id` 時 `NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $n)`；
5. **排除藍本整個家族**：`COALESCE(q.variant_of, q.id) <> $root`，`$root = COALESCE(藍本.variant_of, 藍本.id)`；
6. `q.embedding IS NOT NULL`；
7. `difficulty = clamp(藍本.difficulty + difficulty_delta, 1, 5)`（**字面語意**，同 `interfaces.md` 裁決 20：給了 delta 就鎖定單一難度）；
8. `cosine = 1 - (q.embedding <=> $vec::vector) >= VARIANT_SIM_MIN`。

排序 `ORDER BY cosine DESC, id ASC`，取 `LIMIT count`。**筆數 ≥ `count` 且 `force_generate` 為 false** → 200 `mode:'retrieved'`；否則走 202。

- 回傳的每筆是 `/similar` 的 `results` 形狀（`id, subject, chapter, question_type, difficulty, question_text, score`）**再加一個 `cosine`**；本端點的 `score` **就是 `cosine`**（兩個鍵同值）。理由：`VARIANT_SIM_MIN` 是餘弦門檻，而 `/similar` 的 `score` 是 RRF 分數，拿 RRF 去比餘弦門檻是量錯東西——所以這一支自己下一段帶 `<=>` 的 SQL，不共用 `buildHybridQuery` 的融合分數。消費端必須忽略未知鍵。
- 這一步先量出「多少比例的錯題根本不需要生成」（第 8 條的 `retrieved_coverage`），是最便宜的 RAG 落點。

### 3.2 `generating` 分支

- 建 `jobs(kind='variant', source_question_id=:id, pdf_sha256=NULL, pdf_path=NULL, page_count=NULL, state='queued', budget_usd=VARIANT_TOKEN_BUDGET_USD)`，**不建 `job_questions`**（那是 `generate` 節點的事，第 4 條）。
- `count` 與 `difficulty_delta` 存在 `jobs` 之外的哪裡？**存進 `job_events` 不夠可靠**——凍結為：`services/variantService.js` 在建 job 的同一個交易內插一列 `job_events(job_id, jq_id=NULL, node='generate', attempt=1, outcome='skipped', latency_ms=0, detail={"requested":{"count":n,"difficulty_delta":d,"student_id":s}})`，`generate` 節點認領時從**該 job 最早一列 `node='generate'` 的 `detail.requested`** 讀回參數。這樣不必動 `0003` 的 DDL，也不必把參數塞進 `pdf_path` 這種語意不符的欄位。
- **同一藍本的重複請求要合流**：已存在 `kind='variant' AND source_question_id = :id AND state IN ('queued','extracting','processing')` 的 job 時，直接回 202 `{ mode:'generating', job_id: <既有>, state: <該 job 的 state>, existing: true }`，不建新 job（比照 `POST /api/jobs` 的冪等，避免雙擊付兩次錢）。`force_generate` **不**繞過這一條。
- 前端拿到 202 後每 2 秒輪詢 `GET /api/jobs/:id`（形狀不變，第 11 條），最多 60 秒。

---

## 4. 變式 job 合約（擁有者：WS-B）

**核心原則：變式題與拆題走同一條狀態機、同一組閘門，不另開通道。** `generate` 只是把 `extract` 換掉的**job 層節點**，之後 `job_questions` 走完全相同的 `extracted → hashed → classified → linted → verified → deduped → saved` 六個節點。

### 4.1 job 層：`generate` 節點

- `workers/jobRunner.js` 的 `tick()` **加第二條認領分支**（只加，不改既有那條）：
  `claim('jobs', "kind = 'variant' AND state IN ('queued','extracting')", [], ", state = 'extracting'")` → `runGenerateJob(jobId)`。
- `runGenerateJob` 對 `idx = 1 … count` 逐題呼叫 `agents/generateVariant.js`：成功的建一列 `job_questions(state='extracted')`，失敗的記進 `job_events.detail.rejected` 並跳過。全部跑完後 `UPDATE jobs SET state='processing', locked_until=NULL`。
- **`idx` 的算法**：變式 job 沒有 chunk，凍結為 `chunk_no = 0`、`idx = i`（1-based，即 `0 * 1000 + i`）。與 `interfaces-stage2.md` 裁決 S2-10 的公式一致，`UNIQUE (job_id, idx)` 照樣成立。
- 每次呼叫寫一列 `job_events(node='generate', jq_id=NULL, attempt, model=MODEL_VARIANT, token_*, cost_usd, outcome, detail)`。`'generate'` 是 `interfaces-stage2.md` 第 7.4 條清單的**新增值**（該條明說 `node` 刻意不進 DB CHECK 就是為了這種情況）；階段 3 後的合法清單為：
  `extract`／**`generate`**／`dedup0`／`classify`／`lint`／`verify`／`dedup1`／`save`／`approve`／`reject`／`retry`／`claim`。
- 失敗重試比照 `extract`：同一個 `idx` 的 `fail` 重試 1 次、`error` 依 `maxErrorRetries` 退避（1s→2s→4s）。
- **一列都沒建出來**時 `jobs.state='failed'`，`jobs.error` 凍結為 `變式生成全部未通過文字閘門或跑題檢查。`（其他 job 層例外沿用既有訊息）。

### 4.2 `agents/generateVariant.js`

```js
/**
 * @param {Ctx} ctx   interfaces-stage2.md 第 3.1 條的 Ctx（見 4.5 條的兩個新增欄位）
 * @param {{ source:   {id, subject, chapter, question_type, difficulty, question_text, answer_text},
 *           neighbors: Array<{id, chapter, question_text}>,   // 風格錨點，最多 5 題
 *           difficulty_delta: -1|0|1,
 *           idx: number }} input
 * @returns {Promise<Outcome>}   第 2.2 條的四種形狀之一；不得 throw
 */
module.exports = { run };
```

`outcome.data` **與 `payload.extract` 同形**（`interfaces-stage2.md` 第 3.2 條）再加兩個鍵：

```jsonc
{
  "idx": 1, "subject": "數學", "chapter": "向量內積",
  "chapter_confidence": 0.9,          // 繼承藍本時固定 0.9；模型自己給不同章節時用模型的值
  "question_type": "計算", "difficulty": 3,
  "question_text": "…", "answer_text": "…",
  "figure_desc": "…",                 // 沒有附圖時整個鍵不存在
  "chunk_no": 0, "page_range": null,  // 變式沒有頁碼，但鍵要在（同形）
  "variant_of_root": 12,              // 家族根節點：COALESCE(藍本.variant_of, 藍本.id)
  "anchor_ids": [87, 91, 103]         // 這次用到的鄰居 id，由小到大
}
```

- **模型**：`MODEL_VARIANT`（未設退回 `MODEL_VERIFY`）。`schema` = `buildSchema('variant')`（`agents/schemas/variant.json`，`chapter`／`question_type` 用 `x-enum` 佔位、`difficulty` 是 1–5 的整數）。
- **模板**：`registerTemplate('variant.v1', PROMPT_TEMPLATE)`（`interfaces-stage2.md` 裁決 S2-5，四個 LLM 節點都要註冊，`generate` 是第五個）。
- **cassette 鍵**：`agent = 'variant'`、`cacheKeyParts = { template, sourceQuestionId, difficultyDelta, idx, anchorIds }`（`anchorIds` 已排序）。**不放題幹全文**，理由同 `classify` 的 `fewShotIds`。
- **錨點**：藍本 + 前 5 題鄰居，鄰居查詢**排除藍本整個家族**（避免近親繁殖），排除已封存題。
- **章節閘門**：`chapter` 預設繼承藍本；模型回不同章節時要過 `isValidChapter(subject, chapter)` 才接受，否則改用藍本章節並在 `outcome.data` 加 `"chapter_overridden": true`。
- 節點內部依序做兩道自己的閘門（見 4.3、4.4）；任一不過就 `{kind:'fail', reason:'text_gate'|'off_topic'}`，`feedback` 寫清楚是哪一道、數值多少（下一次重試會餵回 prompt）。

### 4.3 只改字閘門：`utils/variantTextGate.js`

```js
/**
 * 純函式：無 I/O、無隨機、無時間、**不讀 process.env**（門檻由呼叫端傳入）。
 * @param {{ source_text:string, variant_text:string, minEdit?:number }} opts  minEdit 預設 0.08
 * @returns {{ ok:boolean, reason:'identical'|'numbers_only'|'too_close'|null, edit_ratio:number }}
 */
function textGate({ source_text, variant_text, minEdit = 0.08 }) {}
module.exports = { textGate };
```

依序判斷，第一個命中就回傳（兩邊都先過 `utils/normalizeStem.js` 的 `normalizeStem`）：

| # | 條件 | `reason` |
|---|---|---|
| 1 | 正規化後**完全相同** | `identical`（`edit_ratio: 0`） |
| 2 | **數字多重集合相同**且**數字遮罩後文字相同**（把每段連續數字換成 `#`） | `numbers_only` |
| 3 | `edit_ratio < minEdit` | `too_close` |
| 4 | 其餘 | `null`，`ok: true` |

- `edit_ratio = levenshtein(a, b) / max(a.length, b.length)`，兩邊都是**正規化後**的字串；`max` 為 0 時回 `0`。
- **這一道刻意不用 embedding**：`utils/embedText.js` 的設計目的就是讓「換數字的同一題」在向量空間碰撞（規劃 §2.3.6），拿它判「變式是否太像藍本」會把所有合格的數值變式退回。**向量管概念、文字管字面**，兩個工具各自對齊它被設計的用途。
- 「只換數字」的題會被規則 3 攔下（正規化後的編輯距離極小）；「數字對調」的題會被規則 2 攔下。

### 4.4 跑題閾值

`cos(embed(variant_text), embed(source_text)) >= VARIANT_SIM_MIN`，在 `generate` 節點內做（此時還沒有 `question_id`，dedup1 也還沒跑）。

- 兩邊都經 `utils/embedText.js` 的 `buildEmbedText()` 組文本後呼叫 `ctx.llm.embed({ texts, taskType: 'RETRIEVAL_DOCUMENT' })`；向量已 L2 正規化，餘弦 = 內積。
- 不過門 → `fail('off_topic')`，`feedback` 含實際餘弦值。
- 藍本本身沒有向量時（`embedding IS NULL`）根本進不到這裡——第 3 條的 409 已經擋掉。

### 4.5 `payload` 的第七個鍵與 `Ctx` 的兩個新增欄位

`job_questions.payload` 在階段 2 有六個鍵（`interfaces-stage2.md` 第 3.2 條）。變式 job 多一個 **`variant`**（只由 `generate` 節點寫，其餘節點不碰）：

```jsonc
"variant": {
  "source_question_id": 12,
  "difficulty_delta": 0,
  "anchor_ids": [87, 91, 103],
  "text_gate": { "ok": true, "reason": null, "edit_ratio": 0.2413 },
  "sim": 0.8817,                 // 與藍本的餘弦
  "attempt": 1                   // 這一列是第幾次生成才過關的
}
```

`Ctx`（`interfaces-stage2.md` 第 3.1 條）加兩處，**都是附加，不改既有鍵**：

- `ctx.job` 加 `kind: 'pdf'|'variant'` 與 `pdf_sha256: string|null`（第 5 條的同 PDF 排除要用）。
- `ctx.config.thresholds` 加 `variantSimMin`、`variantMinEdit`、`knnVoteSim` 三個數字（由 runner 從環境變數組出來；**agent 一律不得自己讀 `process.env`**）。

### 4.6 之後的六個節點：與 PDF job 完全相同，只有三處分支

| 節點 | 變式 job 的差異 |
|---|---|
| `dedup0` | 無差異（`normalizeStem` → `sha256` → 撞 `questions.text_hash` 或同 job 內較小 `idx` 就 `fail('duplicate')`） |
| `classify` | 無差異（第 5 條的 kNN 層對兩種 job 都生效） |
| `lint` | 只有重試上限不同：`limits.maxRetries.lint = VARIANT_LINT_RETRIES`（預設 2，與階段 2 的預設同值，改這個變數只影響變式 job） |
| `verify` | 無差異 |
| `dedup1` | **排除藍本整個家族**：`input` 多一個**選用**鍵 `exclude_family_root: number|null`；`agents/dedup.js` 的 `runDedup1` 在該鍵非 null 時於候選 SQL 加 `AND COALESCE(q.variant_of, q.id) <> $root`。沒給這個鍵時行為與階段 2 逐位元相同（PDF job 不受影響） |
| `save` | 見 4.7 |

### 4.7 `save`：`VARIANT_AUTO_APPROVE` 與入庫欄位

- **`VARIANT_AUTO_APPROVE=false`（首輪預設）**：`job_questions` 走到 `deduped` 之後，runner **不呼叫 `saveNode`**，直接寫 `state='needs_review'`、`review_reason='awaiting_approval'`，並寫一列 `job_events(node='save', outcome='skipped', error_class=NULL, detail={"reason":"awaiting_approval","auto_approve":false})`。
  - 這是**整條管線唯一一處不經 `transition()` 的狀態變更**，因為它是「政策停等」而不是節點結果：`transition()` 的四種 outcome 沒有一種能從 `deduped` 走到 `needs_review` 而不謊報失敗（`fail` 會讓 `job_events.error_class` 寫進一個不在九個合法值內的字串，撞 `job_events_error_class_check`）。
  - `pipeline/stateMachine.js` **一個字都不准改**；WS-B 要寫一支單元測試釘住「這條路徑之後 `state` 仍是合法終態」。
- **`VARIANT_AUTO_APPROVE=true`**：照常呼叫 `saveNode`。
- `saveNode` 對 `kind='variant'` 的 job 寫入：
  - `origin = 'variant'`
  - `variant_of = payload.extract.variant_of_root`
  - `chapter_src` 依 `payload.classify.source`：`'gate'`／`'llm'` → `'ai'`，`'knn'` → `'knn'`（第 5 條）
  - 其餘欄位（`text_hash`、`search_tsv`、入庫後 `embedByIds`）與 PDF job 完全相同。
- **人工核准路徑**（`POST /api/review/:jqId/approve`，`controllers/reviewController.js`，WS-B 只加分支）：該 `jq` 所屬 job 的 `kind='variant'` 時，`INSERT questions` 改寫三欄——
  - `origin = 'variant'`、`variant_of = payload.extract.variant_of_root`；
  - `chapter_src`：**送出的 `chapter` 與 `payload.classify.chapter`（機器的章節）相同時寫 `'ai'`，不同時寫 `'human'`**。
    理由：`VARIANT_AUTO_APPROVE=false` 時**每一題**變式都會進複核，若照 PDF 路徑一律寫 `'human'`，等於老師按一次「核准」就替系統產生一批沒人逐題驗過的人工標籤，而第 5 條的 kNN 投票只信 `'human'`——那正是規劃 §4.4 要防的自我強化。這條規則與 `PUT /api/questions/:id` 既有的 `CASE WHEN chapter IS DISTINCT FROM …` 是同一套語意。
  - `kind='pdf'` 的 approve 行為**完全不變**（`interfaces-stage2.md` 第 6.6 條是契約）。
- `review_reason` 的八個合法值**不新增**（`awaiting_approval` 已經在裡面，語意也正好是「沒有任何閘門判定它壞掉，但流程需要人點頭」）。

---

## 5. 檢索式 few-shot 分類（擁有者：WS-B，只改 `agents/classify.js` 的 A 層）

**簽名不變**：`run(ctx, { subject, chapter, chapter_confidence, question_text, feedback? })` → `Outcome`。第一層零成本閘門（`isValidChapter` + `chapter_confidence >= CLASSIFY_MIN_CONF`，裁決 S2-13）**一個字都不改**。改的只有第二層的 A 取材與新增的短路。

### 5.1 A 層的最近鄰查詢（凍結）

```sql
SELECT q.id, q.chapter, q.chapter_src, q.question_text,
       1 - (q.embedding <=> $2::vector) AS cosine
  FROM questions q
  LEFT JOIN job_questions jq ON jq.question_id = q.id
  LEFT JOIN jobs j           ON j.id = jq.job_id
 WHERE q.subject = $1
   AND q.archived_at IS NULL
   AND q.embedding IS NOT NULL
   AND q.chapter_src IN ('human','ai','knn')
   AND (j.pdf_sha256 IS DISTINCT FROM $3)      -- $3 = ctx.job.pdf_sha256，可為 NULL
 ORDER BY q.embedding <=> $2::vector, q.id
 LIMIT 8;
```

- **`k = 8`**（`FEW_SHOT_K` 由 5 改成 8）。
- **同一份 PDF 的題要排掉**，join 路徑用 `LEFT JOIN` + `IS DISTINCT FROM`：`seed`／`manual`／`variant` 這些沒有 job 列的題，`j.pdf_sha256` 是 NULL，`NULL IS DISTINCT FROM 'abc…'` 為真，所以**不會**被整批排掉（用 `<>` 就會，這是這條 join 存在的唯一理由）。`ctx.job.pdf_sha256` 為 NULL（變式 job）時所有題都留著。
- `chapter_src` 三種都可以當**範例**（`'human'` 優先、`'ai'`／`'knn'` 同一層級），但排序上 human 先：`examples` 的順序凍結為「先 `human`（依距離），再 `ai`／`knn`（依距離）」。
- `ctx.db` 為 null（錄 cassette 與 `--suite classify`，裁決 S2-8）時 A 層照舊直接跳過 → B 層 → C 層。**`cacheKeyParts.fewShotIds` 的算法完全不變**（`examples` 裡的整數 id 由小到大），所以既有 cassette 全部不失效。

### 5.2 kNN 投票短路（新增）

取最近的 5 個鄰居（`rows.slice(0, 5)`），令 `top = rows[0].chapter`。**三個條件同時成立**才短路：

1. 這 5 個裡面**至少 4 個**滿足 `chapter_src === 'human' && chapter === top`；
2. `rows[0].cosine >= KNN_VOTE_SIM`（預設 `0.90`，經 `ctx.config.thresholds.knnVoteSim`）；
3. `isValidChapter(subject, top)`。

成立時**不呼叫 LLM**，直接回：

```jsonc
{ "kind": "pass",
  "data": { "chapter": "<top>", "confidence": <rows[0].cosine>,
            "rationale": "最近 5 個鄰居中有 N 題人工確認的「<top>」，最近鄰餘弦 0.9xxx ≥ 0.90，採用 kNN 投票。",
            "source": "knn", "few_shot_ids": [ …8 個 id 由小到大… ] } }
```

- `payload.classify.source` 的合法值因此變成三個：`'gate'`／`'llm'`／**`'knn'`**。
- 入庫時 `chapter_src` 依 `source`：`gate`→`'ai'`、`llm`→`'ai'`、`knn`→**`'knn'`**（`saveNode` 與 approve 都照這張表）。
- **`'knn'` 與 `'ai'` 沒有投票權**：條件 1 只數 `chapter_src === 'human'` 的鄰居。自動標籤餵回自動投票是閉環放大器，錯一題會自我強化成一串同錯題（規劃 §4.4）。題庫初期沒有人工標籤時短路率就是 0，**這是誠實的起點，不是 bug**。
- `job_events`：`node='classify'`、`model=NULL`、`token_* = NULL`、`cost_usd = 0`、`outcome='pass'`、`detail.source='knn'`——短路沒有花錢，報表要看得出來。
- 短路率與短路正確率由 `--suite classify` 多印兩欄（不設門檻，只報告）。

---

## 6. 自然語言查題：`POST /api/questions/search-nl`（擁有者：WS-C）

掛在 `[WS3-C: nlq]` 區塊，`apiKeyAuth` 之後，套 `createRateLimiter({ windowMs: 60000, max: 30, message: '自然語言查題請求過於頻繁，請稍候再試（每分鐘最多 30 次）。' })`。`FEATURE_NLQ` 未開啟時**路由不掛載**。

```jsonc
// body
{ "query": "牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過", "student_id": null, "limit": 20 }

// 200
{ "filters": { "subject": "物理", "chapters": ["牛頓運動定律", "摩擦力與向心力"],
               "question_types": ["計算"], "difficulty_min": 4, "difficulty_max": 5,
               "exclude_student_name": "小明", "semantic_text": "牛頓第二定律 摩擦力",
               "keywords": ["牛頓第二定律", "摩擦力"] },
  "parse_path": "rules", "fallback_level": 0, "warnings": [],
  "results": [ { "id": 87, "subject": "物理", "chapter": "牛頓運動定律", "question_type": "計算",
                 "difficulty": 4, "question_text": "…", "score": 0.0325 } ] }
```

| 欄位 | 型別 | 預設 | 不合法時（400） |
|---|---|---|---|
| `query` | string，1~200 字 | 必填 | `query 必須是非空字串。`／`query 最多 200 字。` |
| `student_id` | int > 0 | 無 | `student_id 必須是正整數。` |
| `limit` | int 1~50 | `20` | `limit 必須是 1~50 的整數。` |

- `filters` 的**八個鍵一律出現**（沒抓到的填 `null`／`[]`／`''`），前端要用它回寫下拉。
- `parse_path`：`'rules'`（沒呼叫 LLM）／`'llm'`（呼叫且成功）／`'llm_failed'`（呼叫了但逾時或不合 schema）。
- `results` 的形狀與 `/similar` 的 `results` 相同（`score` 的定義依 `fallback_level` 而不同，見 6.5）。

### 6.1 `utils/nlqHeuristics.js`（純函式）

```js
/**
 * 規則解析。純函式：無 I/O、無隨機、無時間、不讀 process.env。
 * @param {string} text
 * @param {{ aliases: Record<string,string> }} opts   aliases = config/chapterAliases.js
 * @returns {{
 *   filters: { subject:string|null, chapters:string[], question_types:string[],
 *              difficulty_min:number|null, difficulty_max:number|null,
 *              exclude_student_name:string|null, keywords:string[] },
 *   confident: boolean,        // === filters.chapters.length >= 1
 *   semantic_text: string      // 扣掉已被規則吃掉的片段後剩下的文字（去頭尾空白）
 * }} */
function parseQuery(text, opts) {}
module.exports = { parseQuery };
```

- **`confident` 的定義凍結**：命中 ≥ 1 個章節即為 `true`。這一個布林值決定要不要花錢呼叫 LLM。
- 規則涵蓋範圍（最低要求，WS-C 可以多做）：章節本名與別名的**子字串比對**（長的別名優先）、難度（`N 以上`／`N 以下`／`N~M`／`N～M`／`N 星`）、五種題型、`X 沒寫過`／`X 沒做過`／`X 沒寫`。
- `subject` 由命中的章節反推（章節名在兩科白名單內是唯一的）；沒命中章節時為 `null`。
- `keywords` = 被規則吃掉的實詞（章節別名原文、題型），供除錯與前端顯示。

### 6.2 `config/chapterAliases.js`

```js
/** 形狀凍結：{ [別名]: 白名單章節名 }。值必須通過 config/chapters.js 的 isValidChapter（任一科）。 */
const CHAPTER_ALIASES = { '牛頓第二定律': '牛頓運動定律', '摩擦力': '摩擦力與向心力', /* … */ };
module.exports = { CHAPTER_ALIASES };
```

- 每個白名單章節**至少 3 個口語別名**；別名不得重複（同一個別名不得對到兩個章節）。
- 單元測試必須釘：① 所有值都過 `isValidChapter`；② 沒有重複鍵；③ 沒有別名是另一個別名的子字串卻對到不同章節（會讓「長的優先」規則產生歧義）。

### 6.3 LLM 輔路徑

**只有在 `confident === false` 且 `semantic_text` 仍有實詞時才呼叫**。「有實詞」的判定凍結為：`semantic_text.replace(/[\s\p{P}]/gu, '').length >= 2`。

- `generateJson({ model: MODEL_NLQ, schema: buildSchema('nlq'), agent: 'nlq', template: 'nlq.v1', cacheKeyParts: { template, query }, signal })`，`signal` 由 `AbortController` 在 `NLQ_TIMEOUT_MS`（4000）後中止。
- `agents/schemas/nlq.json`：全部是 enum／整數／字串陣列——`subject`（`x-enum: subject`）、`chapters[]`（`x-enum: chapter`）、`question_types[]`（`x-enum: question_type`）、`difficulty_min`／`difficulty_max`（integer 1~5）、`exclude_student_name`（string）、`semantic_text`（string）、`keywords[]`（string）。
  `agents/schemas/index.js` 的 `buildSchema` **不需要改**（它按檔名讀檔、按 `x-enum` 注入），WS-C 只新增 `nlq.json` 這一個檔（`agents/schemas/` 按檔案分，`interfaces-stage2.md` 第 10.1 條）。
- `registerTemplate('nlq.v1', PROMPT_TEMPLATE)`（模板註冊表是 cassette 鍵的來源）。
- 逾時／`schema` 不合／供應商錯誤 → **不 throw**，`parse_path='llm_failed'`、`fallback_level=1`，只用規則的結果繼續往下走。

### 6.4 伺服器再驗一次（凍結）

不論 `filters` 來自規則還是 LLM，一律再驗：

1. `chapters` **逐一**過 `isValidChapter(subject, chapter)`，不合法的**丟掉那一個**而不是整包退回，並加 warning `章節「${x}」不在白名單內，已忽略。`；
2. `question_types` 逐一過 `isValidQuestionType`，warning `題型「${x}」不在白名單內，已忽略。`；
3. `difficulty_min`／`difficulty_max` 過 `normalizeDifficulty`；`min > max` 時對調；只有其中一邊時另一邊補 1 或 5；
4. `chapters` 超過 **3 個**時只採用前 3 個，warning `章節條件過多，只採用前 3 個：${…}`（理由見 6.5）；
5. `exclude_student_name` 查 `students.name`：查不到就**忽略**並加 warning `找不到學生「${name}」，已忽略「沒寫過」的條件。`——**不自動建學生**；
6. `subject` 為 null 且 `chapters` 非空時，由第一個章節反推 `subject`。

### 6.5 hybrid 檢索與 `queries/hybrid.js` 的接法

- 查詢向量：`embed({ texts: [semantic_text || query], taskType: 'RETRIEVAL_QUERY' })`（`interfaces.md` 第 4 條）。
- 關鍵字側：`queryTokens = tokenize(semantic_text || query)`（`utils/tokenize.js`，全案唯一分詞器）。
- **`buildHybridQuery` 只吃單一 `chapter`**（`interfaces.md` 第 5 條，凍結不可改）。所以：
  - `chapters.length === 0` → `chapter: null` 跑一次；
  - `chapters.length === 1` → 帶那一章跑一次；
  - `chapters.length >= 2` → **每章跑一次**（最多 3 次，所以 6.4 第 4 點要截斷），結果依 `score` 由大到小合併、以 `id` 去重、再取 `limit`。
  - `subject` 仍為 null（規則與 LLM 都沒抓到）時，**兩科各跑一次**再合併（`buildHybridQuery` 的 `subject` 是必填）。
  - 跨查詢合併的 `score` 是各自查詢內的 RRF 分數，**不是全域可比的**；這一點要寫在 README 的數字欄旁邊，不要假裝它是一個統一的排序分數。
- `excludeStudentId` = 解析出的學生 id（`exclude_student_name` 查得到時）；`excludeIds: []`；`mode: 'rrf'`；`limit` 取 `min(limit, 50)`。
- 呼叫端在同一交易內 `SET LOCAL hnsw.ef_search = 100`（與 `/similar` 相同）。

### 6.6 回退階梯（`fallback_level`，逐字凍結）

| level | 觸發條件 | 行為 | warning（逐字） |
|---|---|---|---|
| `0` | 正常 | — | — |
| `1` | 需要 LLM 但**逾時／schema 不合／供應商錯誤** | 只用規則解析的結果；`parse_path='llm_failed'` | `LLM 解析逾時或不合 schema，只用規則解析的結果。` |
| `2` | hybrid 回 **0 筆** | 先丟掉 `chapters` 只留 `subject` 重查；仍 0 筆再丟掉難度與題型、改純向量（`sides:['vec']`）重查 | `hybrid 檢索 0 筆，已放寬條件重查。` |
| `3` | **無 embedding 服務**（`embed()` 丟錯：沒有金鑰、fixture 查無此鍵、供應商錯誤） | 退回 `listQuestions` 的 `LIKE`：在 metadata 篩選後的候選上 `question_text ILIKE '%' \|\| $n \|\| '%'`，`score` 一律回 `null` | `embedding 服務不可用，改用關鍵字 LIKE 檢索。` |

- 兩級同時成立時 `fallback_level` 回**較高**的那一級（3 > 2 > 1 > 0），`warnings` 兩句都要有。
- level 2 走完仍是 0 筆 → 回 `results: []` 且 `fallback_level: 2`（**不是** 3；沒東西可找不等於 embedding 壞了）。
- 規劃 §4.3.4 第 5 點寫的觸發條件是「`EMBED_PROVIDER` 未設或失敗」——本專案沒有這個變數（模式旗標是 `EMBED_MODE`，金鑰是 `GEMINI_API_KEY`），因此 level 3 的判準改為**「`embed()` 丟出例外」**這個可觀測的事實。這是本檔對規劃措辭的更正，**以本條為準**。

### 6.7 解析快取

- `key = sha1(query.trim())`，**LRU 100 筆**，只快取**解析結果**：`{ filters, parse_path, semantic_text, warnings }`（解析階段產生的 warning）。
- 檢索結果、`student_id` 的解析、`limit` **不進快取**（它們與 query 無關或每次都要重算）。
- 行程內記憶體即可，不落地、不跨行程。

---

## 7. 前端橋接與旗標注入（擁有者：WS-D，`app.js` 部分由 WS-A）

### 7.1 `window.ExamApp` 再加五個（`public/index.html` 的既有 inline script，**只加不改**）

階段 2 已橋接 `apiFetch`／`showToast`／`renderMath`／`escapeHtml`／`createQuestionEditor`（`interfaces-stage2.md` 第 8 條）。階段 3 再加：

```js
window.ExamApp = Object.assign(window.ExamApp || {}, {
    apiFetch, showToast, renderMath, escapeHtml, createQuestionEditor,   // 階段 2，不動
    getPaperCache,            // () => object|null          讀 currentPaperCache
    setPaperCache,            // (patch:object) => object   淺層合併進 currentPaperCache 並回傳新值
    getChapters,              // () => Array                讀 allChapters
    getChapterWhitelist,      // () => Record<string,string[]>   讀 chapterWhitelist
    showSection               // (id:string) => void        捲到 #id（新函式，WS-D 自己實作）
});
```

- **為什麼是 getter／setter 而不是直接掛值**：`currentPaperCache`、`allChapters`、`chapterWhitelist` 都是 inline script 裡會被**重新賦值**的 `let` 變數（`index.html:585-586`、`:596`、`:1028`）。直接 `Object.assign` 掛的是當下那個值的快照，組卷之後 module 讀到的還是舊的 `null`。這是 S0 對「`window.ExamApp` 再加 `{currentPaperCache, chapters, showSection}`」這句話的落地方式，**名稱與簽名以本表為準**。
- 組卷成功時 `currentPaperCache` 多存一個 `paper_id`（`result.paper_id` 已經在回應裡，`interfaces.md` 第 7 條）。
- 橋接不存在時新 module **直接停手並印一行錯誤**，不自己複製一份（`review.js` 的既有做法，第 8 條的教訓）。

### 7.2 `public/index.html` 的插入點（只有這五處）

| # | 位置 | 內容 |
|---|---|---|
| 1 | `<head>` 的 `<meta name="feature-pipeline">` 旁 | 三行 `<meta name="feature-students\|feature-nlq\|feature-variants" content="__FEATURE_STUDENTS__\|__FEATURE_NLQ__\|__FEATURE_VARIANTS__">` |
| 2 | 導覽列（`#library` 連結旁） | `<a href="#students">學生</a>` |
| 3 | `<section id="review">` 附近 | 三個空錨點 `<section id="students"></section>`、`<section id="nlq"></section>`、`<section id="variants"></section>`，內容全部由 module 建立 |
| 4 | `</body>` 前 | 三行 `<script type="module" src="/js/students.js\|nlq.js\|variants.js"></script>` |
| 5 | 組卷結果區 | 一顆「立即批改」連結（帶 `paper_id`，跳到 `#students` 並展開該卷）；`currentPaperCache` 多存 `paper_id` |

- 旗標讀法與 `review.js` 逐字相同：`parseBool(document.querySelector('meta[name="feature-students"]')?.content)`，`parseBool` 的規則與 `config/features.js` **逐字相同**（`'1'`／`'true'` 不分大小寫為真）。佔位字串沒被替換掉時 `parseBool` 判為 `false`＝安全預設。
- 旗標關閉時**整段不渲染**（連空殼都不掛），不得只是隱藏。
- `?mock=1` 的手寫假資料沿用 `review.js` 的做法（假資料只在 `?mock=1` 時讀得到）。

### 7.3 `app.js` 的三個 `replaceAll`（WS-A，裁決 S2-20：`app.js` 歸 WS-A）

`serveIndex()` 現有兩個替換（`__API_KEY__`、`__FEATURE_PIPELINE__`），加三個同款：

```js
.replaceAll('__FEATURE_STUDENTS__', process.env.FEATURE_STUDENTS || 'false')
.replaceAll('__FEATURE_NLQ__',      process.env.FEATURE_NLQ      || 'false')
.replaceAll('__FEATURE_VARIANTS__', process.env.FEATURE_VARIANTS || 'false')
```

用 `replaceAll` 不是 `replace`：佔位字串在說明註解裡也會有一份（`__FEATURE_PIPELINE__` 就踩過這個坑）。

### 7.4 `npm run check:html`

`eval/tools/check_html.js`（WS-D）擴到三個新檔：`public/js/*.js` 一律以 module 模式 `node --check`；並斷言 `index.html` 含三行 `<script type="module" src="/js/students.js|nlq.js|variants.js">` 與三個 `<section id="students|nlq|variants">`（比照既有的 `review.js` 斷言）。

---

## 8. eval：兩個新 suite（WS-B／WS-C 各寫一支，WS-D 接進 `run.js` 與 CI）

### 8.1 suite 的函式形狀（照 `eval/lib/suiteClassify.js`）

```js
// eval/lib/suiteNlq.js     （WS-C）
async function runNlqSuite(args) { /* … */ }      module.exports = { runNlqSuite };
// eval/lib/suiteVariant.js （WS-B）
async function runVariantSuite(args) { /* … */ }  module.exports = { runVariantSuite };
```

回傳物件的**必要鍵**（其餘自由）：

```jsonc
{ "suite": "nlq", "measured": { "<column>": { "<metric>": number|null } | null },
  "failures": [ "…錯誤訊息字串…" ],   // replay miss 的原文要原樣放進來（run.js 靠前綴辨識）
  "warnings": [ "…" ],
  "meta": { "golden": "eval/golden/nlq.json", "goldenEntries": 50, "goldenPending": 0,
            "fixture": "eval/fixtures/questions.public.json", "llmMode": "replay",
            "cassetteDir": "eval/cassettes", "sources": { /* shims.sources() */ } },
  "perEntry": [ /* golden.isPrivate 時一律 [] */ ],
  "isPrivate": false }
```

### 8.2 `--suite nlq`（WS-C）

`SUITE_METRICS.nlq = { columns: ['rules', 'llm'], metrics: ['rule_coverage', 'filters_exact', 'recall10'] }`

| 指標 | 定義 |
|---|---|
| `rule_coverage` | golden 50 句中「規則就抓到 ≥ 1 個章節」（`confident === true`）的比例。**只在 `rules` 欄有值，`llm` 欄恆為 `null`** |
| `filters_exact` | `subject`／`chapters`／`question_types`／`difficulty_min+max` **四欄全對**的比例（陣列先排序再比）。`rules` 欄只算 `expect_path='rules'` 的句子；`llm` 欄只算 `expect_path='llm'` 的句子 |
| `recall10` | 對測試庫灌 fixture 後跑 hybrid，`relevant` 至少一題落在前 10 名的比例 |

### 8.3 `--suite variant`（WS-B）

`SUITE_METRICS.variant = { columns: ['variant'], metrics: ['retrieved_coverage', 'gate_pass_rate'] }`

| 指標 | 定義 |
|---|---|
| `retrieved_coverage` | 30 個藍本中「純檢索就找得到 ≥ 2 題」的比例（零 LLM 費用，決定 3B 的優先度） |
| `gate_pass_rate` | 30 藍本 × 2 題 = 60 次生成中，**六個閘門全過**（text_gate、跑題、classify、lint、verify、dedup1）的比例 |
| 各閘門通過數／`cost_usd` | **只報告不設門檻**（成本越低越好，放進 ratchet 會變成反向門檻，`eval/lib/thresholds.js` 的既有規矩） |

### 8.4 golden 檔（形狀凍結）

```jsonc
// eval/golden/nlq.json —— 50 句自編查詢
{ "_notice": "…全部自編，不取自任何考卷或真實對話…", "_status": "…", "_schema": "…", "version": 1,
  "entries": [ { "id": "nlq-001",
                 "query": "牛頓第二定律加摩擦力的計算題，難度 4 以上",
                 "expect": { "subject": "物理", "chapters": ["牛頓運動定律","摩擦力與向心力"],
                             "question_types": ["計算"], "difficulty_min": 4, "difficulty_max": 5,
                             "exclude_student_name": null, "semantic_text": "牛頓第二定律 摩擦力" },
                 "expect_path": "rules",          // 'rules' | 'llm'
                 "relevant": [12, 87],            // fixture 題 id
                 "needs_human_confirm": true } ] }

// eval/golden/variant.json —— 30 個藍本
{ "_notice": "…藍本全部取自 eval/fixtures/questions.public.json…", "_status": "…", "_schema": "…", "version": 1,
  "entries": [ { "id": "var-001", "source_question_id": 12,
                 "subject": "數學", "chapter": "向量內積", "difficulty": 3,
                 "expect": { "min_retrieved": 2 },
                 "needs_human_confirm": true } ] }
```

- 涵蓋面（nlq 50 句）：只有章節／章節+難度／章節+題型+學生／口語別名／完全沒章節只有概念詞／模糊句，六類都要有。
- `expect.semantic_text` 是**凍結的預期值**，兼兩個用途：① 計入 `filters_exact` 之外的漂移警告；② 解析出的 `semantic_text` 與它不同時，**向量側改用 golden 的值**去 `embed()`，讓 `recall10` 量的是「檢索本身」而不是「這一輪解析剛好漂掉」。這時 suite 必須加一則 warning 指名該 entry。
- `needs_human_confirm: true` 的 entry 只當骨架驗證用；全部清成 `false` 之前**不得** `--write-baseline`（`eval/run.js` 既有的 stub guard 同一條線）。

### 8.5 門檻與 CI

- `thresholds.json` 的規則不變：**第一次量測 −0.03，之後只升不降（ratchet）**；`_nlq_measured_with`／`_variant_measured_with` 記模型 ID、cassette 目錄、golden 檔與筆數。
- **CI 不連外**：nlq 的 LLM 層與 variant 的生成一律 `LLM_MODE=replay` 讀 `eval/cassettes/nlq/`、`eval/cassettes/variant/`；embedding 一律 `EMBED_MODE=fixture`。
- **錄製時 `LLM_MODE=record` 與 `EMBED_MODE=record` 要一起開**：`services/llm/index.js` 的 `embed()` 在 `record` 模式會把新向量寫進 `eval/fixtures/embeddings.<model>.<dim>.json`。變式題的題幹、nlq 的 `semantic_text` 都是**新字串**，不一起錄的話 CI 會在 fixture 查不到鍵而硬失敗（這是刻意的：`interfaces.md` 第 4 條「不得靜默回退成假向量」）。
- WS-D 負責：`eval/run.js` 加 `--suite nlq|variant` 兩個分支（呼叫上面兩支匯出的函式，共用既有的 `runStage2Suite` 外殼）、`thresholds.js` 的 `SUITE_METRICS` 加兩節、`package.json` 加 `eval:nlq`／`eval:variant`、`ci.yml` 的 integration job 加兩步。
- WS-B／WS-C **不得改 `eval/run.js`**（`interfaces-stage2.md` 第 10.1 條，`eval/**` 歸 WS-D；`eval/cassettes/**` 與各自的 `suiteX.js`、`golden/X.json` 除外）。

---

## 9. 環境變數（階段 3 新增，全名與預設）

`.env.example` **只由 S0 直接編輯**（下列全部已寫入）；各 WS 需要新變數時寫在 PR 描述，由開發者本人合入。

| 變數 | 預設 | 用途 | 誰讀 |
|---|---|---|---|
| `MODEL_VARIANT` | （空） | 變式生成用的模型。**未設時退回 `MODEL_VERIFY`**（推理強、與拆題不同家） | WS-B |
| `MODEL_NLQ` | `gemini:gemini-3.5-flash` | 自然語言查題的 LLM 輔路徑（便宜模型就夠） | WS-C |
| `VARIANT_MAX_PER_REQUEST` | `3` | 單次請求最多生幾題（`count` 的上限） | WS-B |
| `VARIANT_SIM_MIN` | `0.80` | ① `retrieved` 分支的餘弦下限；② 生成後的跑題閾值 | WS-B |
| `VARIANT_MIN_EDIT` | `0.08` | 只改字閘門的 Levenshtein ratio 下限 | WS-B |
| `VARIANT_LINT_RETRIES` | `2` | 變式 job 的 `lint` 節點重試上限（覆寫 `DEFAULT_LIMITS.maxRetries.lint`） | WS-B |
| `VARIANT_TOKEN_BUDGET_USD` | `0.30` | 每個變式 job 的成本上限，建立時複製進 `jobs.budget_usd` | WS-B |
| `VARIANT_AUTO_APPROVE` | `false` | `false` = 全部閘門過了仍停在 `needs_review('awaiting_approval')`，等人核准 | WS-B |
| `KNN_VOTE_SIM` | `0.90` | kNN 投票短路的最近鄰餘弦下限 | WS-B |
| `NLQ_TIMEOUT_MS` | `4000` | LLM 輔路徑的逾時（`AbortController`） | WS-C |
| `WEAKNESS_MIN_N` | `5` | `graded < N` 標 `low_sample=true` | WS-A |
| `FEATURE_STUDENTS` | `false` | 學生／試卷／批改／弱點五支 API 與前端分頁 | WS-A、WS-D |
| `FEATURE_NLQ` | `false` | `POST /api/questions/search-nl` 與前端查題框 | WS-C、WS-D |
| `FEATURE_VARIANTS` | `false` | `POST /api/questions/:id/variants` 與前端變式分頁 | WS-B、WS-D |

- 布林值的解讀沿用 `interfaces.md` 第 9 條：字串 `1` 或 `true`（不分大小寫）為真，其餘皆為假；`FEATURE_*` 一律經 `config/features.js`。
- 階段 1／2 的變數**全部不變**。
- `config/features.js` 加三個 getter（S0 已加，各 WS 不再動這個檔）：

```js
features.FEATURE_STUDENTS   // boolean getter
features.FEATURE_NLQ        // boolean getter
features.FEATURE_VARIANTS   // boolean getter
```

- **GitHub Actions 不放任何 LLM 金鑰**；`.bat` 不得出現金鑰。
- `MODEL_VARIANT` 未設時退回 `MODEL_VERIFY` 的解析在 `config/models.js` 之外做（WS-B 自己在 `variantService`／`generateVariant` 解析，`config/models.js` 是 WS-B 階段 2 的檔，可加 `MODEL_VARIANT` 匯出但不得改既有兩個的語意）。

---

## 10. 檔案所有權與 `routes/index.js` 的四個新區塊

### 10.1 誰擁有哪些檔案（別人不得改）

| Workstream | 擁有的檔案（階段 3） |
|---|---|
| **S0**（本次） | `docs/interfaces-stage3.md`、`.env.example`、`config/features.js`（只加三個 getter）、`routes/index.js` 的四個新區塊（空殼）、`migrations/0006_*`（本次判定不需要） |
| **WS-A** 學生與弱點 | `services/weaknessService.js`、`controllers/studentController.js`、`controllers/paperController.js`、`utils/pickOnePerFamily.js`、`controllers/examController.js`（**只加**家族互斥）、`app.js`（**只加**三個 `replaceAll`）、`test/integration/students.pg.test.js`、routes 的 `[WS3-A: students]` 區塊 |
| **WS-B** 變式與 kNN | `services/variantService.js`、`agents/generateVariant.js`、`agents/schemas/variant.json`、`utils/variantTextGate.js`、`eval/lib/suiteVariant.js`、`eval/golden/variant.json`、`eval/cassettes/variant/**`、`docs/variants.md`、routes 的 `[WS3-B: variants]` 區塊；**只加分支**：`workers/jobRunner.js`（`kind='variant'` 認領與 `generate`／`save` 分支）、`agents/classify.js`（A 層與 kNN 短路）、`agents/dedup.js`（`dedup1` 的選用鍵 `exclude_family_root`）、`controllers/reviewController.js`（approve 的 variant 分支）、`config/models.js`（加 `MODEL_VARIANT` 匯出） |
| **WS-C** 自然語言查題 | `utils/nlqHeuristics.js`、`config/chapterAliases.js`、`services/nlqService.js`、`agents/schemas/nlq.json`、`eval/lib/suiteNlq.js`、`eval/golden/nlq.json`、`eval/cassettes/nlq/**`、`test/unit/nlq*.test.js`、`test/integration/nlq.pg.test.js`、routes 的 `[WS3-C: nlq]` 區塊 |
| **WS-D** 前端／eval／CI | `public/index.html`、`public/js/students.js`、`public/js/nlq.js`、`public/js/variants.js`、`test/e2e/**`、`exam_pro/README.md`、`.github/workflows/ci.yml`、`package.json` 的 `scripts`、`eval/run.js`、`eval/lib/thresholds.js`、`eval/tools/check_html.js`、routes 的 `[WS3-D: frontend]` 區塊 |
| **測試檔** | 各 WS 可在 `test/unit/`、`test/integration/` 新增**自己擁有模組**的測試檔，**不得修改別人的檔**（裁決 S2-2）。既有 `test/unit/shuffle|textFormatter|answerGolden.test.js` 等是契約 |

共用檔規則（與前兩階段相同）：

- `routes/index.js` —— **append-only**，只在自己的區塊內加行，不重排既有路由。
- `package.json` —— deps 各 WS 只加自己需要的；`scripts` 由 **WS-D** 統一。
- `.env.example` —— **不直接改**，新變數列在 PR 描述。
- `public/index.html` —— 只有 WS-D 可改；其他 WS 要前端改動寫進 `docs/questions3-ws<X>.md`。
- 「只加分支」的意思是：**既有路徑逐位元不變**，新分支由 `job.kind`／新的選用 input 鍵／旗標決定。改動要附一支釘住舊行為的測試。

### 10.2 `routes/index.js` 的四個新區塊（名稱凍結，S0 已建空殼）

```js
// ===== [WS3-A: students] =====
// ===== [/WS3-A: students] =====

// ===== [WS3-B: variants] =====
// ===== [/WS3-B: variants] =====

// ===== [WS3-C: nlq] =====
// ===== [/WS3-C: nlq] =====

// ===== [WS3-D: frontend] =====
// ===== [/WS3-D: frontend] =====
```

階段 1 的四個區塊（`[WS-A: DB]`…`[WS-D: eval]`）與階段 2 的四個（`[WS2-A: jobs]`…`[WS2-D: eval]`）原封不動保留在上方。rebase 時若兩條 WS 都動了本檔，衝突只會落在相鄰行，**兩邊都保留**即可。

---

## 11. 與階段 1／2 介面的銜接（全部不變，只列接點）

| 接點 | 出處 | 階段 3 怎麼用 |
|---|---|---|
| `GET /api/questions/:id/similar?student_id=` | `interfaces.md` 第 6 條 | `student_id` 參數**已經存在**，不需要任何改動；弱點面板的「找相似」直接打這一支 |
| `queries/hybrid.js` 的 `buildHybridQuery` | `interfaces.md` 第 5 條 | NL 查題共用同一段 SQL（第 6.5 條）；**單一 `chapter` 的限制不改**，多章由呼叫端跑多次 |
| `embed()` 的 `taskType` | `interfaces.md` 第 4 條 | 查詢向量用 `RETRIEVAL_QUERY`，變式的跑題檢查用 `RETRIEVAL_DOCUMENT` |
| `utils/tokenize.js` | `interfaces.md` 第 2 條 | NL 查題的 `queryTokens` 只能用它 |
| `POST /api/generate-paper` 的 `paper_id` | `interfaces.md` 第 7 條 | 已在回應裡；前端「立即批改」連結直接用，**回應形狀不變** |
| `GET /api/jobs/:id` | `interfaces-stage2.md` 第 6.2 條 | 形狀**完全不變**；`variants.js` 每 2 秒輪詢它，`counts` 與 `cost_usd` 照原義解讀 |
| `GET /api/review`／`POST /api/review/:jqId/approve` | `interfaces-stage2.md` 第 6.4、6.6 條 | 變式題與拆題共用同一條複核佇列；approve 對 `kind='variant'` 多寫 `origin='variant'`／`variant_of`／`chapter_src`（第 4.7 條），其餘行為不變 |
| `pipeline/stateMachine.js` | `interfaces-stage2.md` 第 2 條 | **一個字都不改**；變式 job 走同一條狀態機（唯一例外是第 4.7 條的政策停等） |
| `payload` 六個鍵 | `interfaces-stage2.md` 第 3.2 條 | 不改；變式 job 多一個 `variant` 鍵（第 4.5 條） |
| `job_events.node` 清單 | `interfaces-stage2.md` 第 7.4 條 | 加 `'generate'`（該條明說清單可增、不進 DB CHECK） |
| `generateJson` 的 `agent`／`cacheKeyParts`／`template` | `interfaces-stage2.md` 第 5.1、5.2 條 | 新增兩個 agent 名：`'variant'`、`'nlq'`；cassette 路徑 `eval/cassettes/variant/`、`eval/cassettes/nlq/` |
| `buildSchema(name)` | `interfaces-stage2.md` 第 3.4 條 | 不改實作；新增兩個 schema 檔 `variant.json`（WS-B）、`nlq.json`（WS-C） |
| `config/features.js` | `interfaces.md` 第 12.2 條 | 只加三個 getter（S0 已加），形狀不變 |
| `deleteQuestion` 的軟刪 | `interfaces.md` 第 12.1 條 | 變式家族的清除腳本一律**封存**（`archived_at`）而非 `DELETE`；`attempts` 的 `ON DELETE RESTRICT` 是硬保證 |

---

## 12. migrations 只增不改

- `0001_init.sql`、`0002_vector.sql`、`0003_jobs.sql`、`0004_origin_legacy.sql`、`0005_text_hash_unique.sql` **全部凍結**，任何人都不得再編輯其內容（包括加註解）。
- 階段 3 經第 0 條逐欄核對後**不需要新 migration**。真的缺欄位時：寫進 `docs/questions3-ws<X>.md` → 開發者本人裁決 → 從 **`0006_stage3.sql`** 起新開一支 → 對**兩個庫**各套用一次（第二次必須是 no-op）。
- `migrate.js` 沒有 `down`：寫錯的 migration 用「再寫一支把它改回來」修正。
- WS 不得自行 `ALTER TABLE`；`psql` 手改的欄位不會出現在別人的機器上，也不會出現在 CI。

---

## 13. 階段 3 的裁決紀錄（S3-*，為什麼介面長這樣）

| # | 裁決 | 出處／理由 |
|---|---|---|
| S3-1 | **不開 `0006_`**：階段 3 的全部欄位在 `0001`／`0003` 已存在，兩個庫逐欄核對通過 | 第 0 條 |
| S3-2 | 弱點面板與試卷明細**不排除已封存題**；變式候選池與 kNN few-shot **一律排除** | 歷史紀錄不能因為題目封存就消失；候選池則不該推薦已淘汰的題 |
| S3-3 | `wrong_rate` 在 `graded = 0` 時是 `null` 不是 `0`；`low_sample` 涵蓋 `graded = 0` | 沒批改不等於全對——面板要能誠實地說「不知道」 |
| S3-4 | `weaknessService` 的參數順序凍結為 `[studentId, days, subject, limit]` | 純文字單測唯一擋得住的就是參數錯位 |
| S3-5 | `pickOnePerFamily` 吃 `{id, variant_of}` 的列、在 JS 端算家族鍵 | 等價於 `COALESCE(variant_of,id)`，但讓純函式可離線測；SQL 只多撈一欄 |
| S3-6 | 「庫存不足」的 400 檢查移到家族互斥**之後**，`${n}` 是家族數 | 先檢查再收斂會讓「通過檢查卻抽不滿」；訊息格式一字不改 |
| S3-7 | `POST /variants` 的 `retrieved` 分支**自己下 `<=>` 的 SQL**，不共用 `buildHybridQuery` 的 RRF 分數；`score === cosine` | `VARIANT_SIM_MIN` 是餘弦門檻，拿 RRF 去比是量錯東西 |
| S3-8 | 同一藍本已有未完成的變式 job 時**合流**回既有 `job_id`（`existing:true`），`force_generate` 不繞過 | 雙擊不該付兩次錢；比照 `POST /api/jobs` 的冪等 |
| S3-9 | 變式 job 的 `count`／`difficulty_delta` 存在建 job 時寫的那一列 `job_events(node='generate', outcome='skipped').detail.requested` | 不必為兩個參數改 `0003` 的 DDL，也不把參數塞進語意不符的既有欄位 |
| S3-10 | 變式的 `idx = i`（`chunk_no = 0`） | 與裁決 S2-10 的公式一致，`UNIQUE (job_id, idx)` 照樣成立 |
| S3-11 | `VARIANT_AUTO_APPROVE=false` 的停等**不經 `transition()`**，事件寫 `outcome='skipped'`、`error_class=NULL` | `fail` 會讓 `error_class` 撞 `job_events_error_class_check` 的九個合法值；這是政策停等不是節點失敗 |
| S3-12 | 變式 approve 的 `chapter_src`：章節沒被改過寫 `'ai'`，改過才寫 `'human'`（PDF 路徑維持一律 `'human'`） | 每題變式都會進複核，一律寫 `'human'` 等於量產沒人逐題驗過的人工標籤，正好餵壞第 5 條的 kNN 投票 |
| S3-13 | `textGate` **不讀 `process.env`**，門檻由呼叫端傳入；`ctx.config.thresholds` 加三個數字 | `utils/` 的純函式契約（`interfaces-stage2.md` 第 4 條）與「agent 不得自己讀 env」（第 3.1 條） |
| S3-14 | `dedup1` 的家族排除用**選用** input 鍵 `exclude_family_root`，不改既有四個鍵 | 階段 2 的 input 形狀是凍結的；沒給這個鍵時行為逐位元相同 |
| S3-15 | kNN 短路的三個條件（前 5 鄰居 ≥ 4 題 human 且與最近鄰同章、最近鄰餘弦 ≥ `KNN_VOTE_SIM`、章節過白名單）與 `source='knn'`／`chapter_src='knn'` | 規劃 §4.3.3；`'knn'`／`'ai'` 沒有投票權，題庫初期短路率為 0 是誠實的起點 |
| S3-16 | NL 查題的 `chapters` **最多 3 個**，多章對 `buildHybridQuery` 跑多次再合併；`subject` 全空時兩科各跑一次 | `buildHybridQuery` 的單一 `chapter` 是凍結介面，不為了這個功能改它 |
| S3-17 | `fallback_level=3` 的判準改為「**`embed()` 丟出例外**」 | 規劃 §4.3.4 寫的 `EMBED_PROVIDER` 在本專案不存在（模式旗標是 `EMBED_MODE`）；以可觀測的事實當判準 |
| S3-18 | LRU 只快取**解析結果**，不快取檢索結果 | 檢索結果會隨題庫與 `student_id` 變動，快取它等於發舊資料 |
| S3-19 | `window.ExamApp` 的三個新東西改成 **`getPaperCache`／`setPaperCache`／`getChapters`／`getChapterWhitelist`／`showSection`** | `currentPaperCache`／`allChapters` 是會被重新賦值的 `let`，掛值只會掛到快照 |
| S3-20 | 錄製 cassette 時 `LLM_MODE=record` 與 `EMBED_MODE=record` **必須一起開** | 變式題幹與 `semantic_text` 都是新字串，沒錄向量的話 CI 會在 fixture 查不到鍵而硬失敗（這是刻意的） |
| S3-21 | `--suite nlq` 的 `recall10` 在解析漂移時改用 golden 的 `expect.semantic_text` 去 `embed()`，並加 warning | 讓 `recall10` 量的是檢索本身；解析的對錯由 `filters_exact` 負責，兩個數字不互相汙染 |

---

## 14. 施工前的提醒（給四條 WS）

1. **先讀三份介面再動手**：`docs/interfaces.md`（階段 1）、`docs/interfaces-stage2.md`（階段 2）、本檔。三份都是凍結的。
2. **`npm test` 不連 DB、不連 Gemini**；需要 PG 的測試放 `test/integration/`（`TEST_DATABASE_URL`、庫名 `_test` 結尾、`npm run test:integration` 有 `--test-concurrency=1`）。
3. **LLM 一律經 `services/llm` 的 `generateJson()`**（cassette record/replay 已在），embedding 一律經 `embed()`。agent 不得自己 `require('../config/db')`、不得自己讀 `process.env`。
4. **不得把真實考卷題目或學生姓名寫進 repo**：golden 與 fixture 只能用 `eval/fixtures/questions.public.json` 的自製題與自編句子；cassette 只錄公開素材。
5. **繁體中文註解與 commit，小步 commit，不 push `main`。**
6. **Windows 11**：檔案一律由 Node 寫；路徑含中文要 `path.resolve` + UTF-8；PowerShell 沒有行內 `VAR=x`。
7. **介面有問題就停下來**：寫 `docs/questions3-ws<X>.md` 並在回報中明講，不要自行改介面繞過。

---

## 15. 第一輪裁決（2026-08-23，回應 `questions3-ws*.md` 共 24 條；編號 S3-R*）

四條 WS 第一輪已全部合入 main。以下裁決**優先於上文對應條文**（條文不逐句回改，以本節為準）。

| # | 裁決 | 來源 |
|---|---|---|
| S3-R1 | `PATCH /papers/:id/results` 的 400 檢查優先序＝第 1.4 條表格的列順序（重複檢查在型別檢查之前；body 驗證在試卷存在性之前） | A-1 |
| S3-R2 | `/api/papers/:id`、`PATCH …/results`、`/api/students/:id/*` 的 `:id` 非整數一律 404（與第 1.2 條同） | A-2 |
| S3-R3 | `graded_ratio` 分母＝該生全部 `attempts` | A-3 |
| S3-R4 | `GET /api/papers/:id` 用 INNER JOIN；`question_ids` 裡不存在的題直接不出現（現行 DDL 下不可能發生） | A-4 |
| S3-R5 | weakness 的錯誤順序：路徑參數 → 查詢參數 → 資料存在性 | A-5 |
| S3-R6 | `EXPLAIN` 斷言在交易內 `SET LOCAL enable_seqscan = off` 後做——驗的是「謂詞走得到索引」，不是「小表會不會用索引」 | A-6 |
| S3-R7 | `npm run test:integration` 維持 CI 語意（由 workflow 提供 `TEST_DATABASE_URL`）；本機用 README 那行 `--env-file=.env`。WS-D 在 README 再標一次 | A-7 |
| S3-R8 | **只改字閘門規則 2 改為「數字遮罩後文字相同」即 `numbers_only`**（拿掉「多重集合相同」的 AND 條件）；第 4.3 條據此改寫，`VARIANT_MIN_EDIT` 不動 | B-1 |
| S3-R9 | **`VARIANT_SIM_MIN` 拆成兩個**：`VARIANT_RETRIEVE_SIM_MIN=0.80`（retrieved 分支下限）與 `VARIANT_OFFTOPIC_SIM_MIN=0.92`（生成後跑題閾值）；`.env.example`、第 3.1／4.4／9 條與 `ctx.config.thresholds`（`variantRetrieveSimMin`／`variantOfftopicSimMin`）同步 | B-2 |
| S3-R10 | approve 的 `chapter_src`：送出的 `chapter` 與 `payload.classify.chapter` **不同 → `'human'`**；**相同 → 依 `payload.classify.source` 映射（`gate`／`llm`→`'ai'`、`knn`→`'knn'`）**，與 `saveNode` 同一張表（第 5.2 條為準，第 4.7 條的「相同→'ai'」改寫） | B-3 |
| S3-R11 | kNN 短路的 `job_events`：`token_in` 記那一次 embedding 的實際 token 數（非 NULL）、`model=NULL`、`cost_usd=0`、`detail.source='knn'`——照實記比較誠實；第 5.2 條「`token_* = NULL`」改寫 | B-4 |
| S3-R12 | `generateVariant` 以 `outcome.gate = { text_gate, sim }` 交棒給 runner 組 `payload.variant`；`outcome.data` 維持第 4.2 條的形狀（第 4.2 條補一句） | B-5 |
| S3-R13 | `config/models.js` 加 `MODEL_VARIANT` getter；runner 的 `ctx.config.models.variant = MODEL_VARIANT || MODEL_VERIFY` | B-6 |
| S3-R14 | `agents/generate.js` 三行轉接檔（同 `dedup0.js` 做法）；`loadStage3Config()` 另函式合併——接受 | B-7 |
| S3-R15 | variant golden 載入器留在 `suiteVariant.js`；`retrieved_coverage` 用 memory 引擎——接受 | B-8／B-9 |
| S3-R16 | PDF job 被 kNN 短路分類時 `chapter_src='knn'`（第 5 條本意）；`dedup1` 的選用鍵 `exclude_family_root` 未給時 SQL 逐位元不變——接受 | B C-3／C-4 |
| S3-R17 | **`semantic_text` 以第 6 條與第 8.4 條的兩個範例為準**：概念詞（章節本名／別名）原文保留、條件詞整段拿掉、自由文字剝頭尾虛詞；第 6.1 條那行散文改寫 | C-1 |
| S3-R18 | `question_types` 以 `excludeIds` 實作精確篩選（做法 b），`buildHybridQuery` 簽名不動 | C-2 |
| S3-R19 | 句子裡指名的「X 沒寫過」優先於 body 的 `student_id`（不取聯集） | C-3 |
| S3-R20 | nlq 與 variant 的 cassette 由開發者在 main 統一錄（`LLM_MODE=record` + `EMBED_MODE=record` 一起開）；CI 兩個 suite 維持必跑 | C-4 |
| S3-R21 | 第 6.4 條的順序：先反推 `subject`（第 6 點）再逐一驗章節（第 1 點）；`keywords` 含題型（散文為準，前端 chip 由 WS-D 決定是否顯示） | C-5／C-6 |
| S3-R22 | level 3 的 LIKE：`semantic_text` 逐段 ILIKE 以 OR 連接（最多 5 段）；放寬順序＝先丟 ILIKE 留 metadata、再丟章節（第 6.6 條 level 3 改寫） | C-7 |
| S3-R23 | 前端兩個 `CustomEvent`（`examapp:variant-request`、`examapp:grade-paper`，detail 形狀照 questions3-wsD.md §1）寫進第 7.1 條；`#nlq` 放在 `#library` 正上方；inline script 的 `featureOn()` 與 `parseBool` 規則逐字相同（`check_html` 守）；`variants.js` 每輪同時打 `GET /api/jobs/:id` 與 `/questions` | D-1～D-4 |
| S3-R24 | **「出變式」UI 提供兩個下拉**：數量 1~3（預設 1）、難度 −1／0／+1（預設 0）——與介面預設一致；eval 用 `count=2` 是 eval 的事 | D-5 |
| S3-R25 | **加第四個注入點 `<meta name="feature-similar">`**（`app.js` 多一個 `replaceAll`，WS-A；`index.html` 加 meta，WS-D）；「找相似」由 `feature-similar` 控制、「出變式」由 `feature-variants` 控制 | D-6 |
| S3-R26 | 弱點面板 `days` 選項先用 30／90／180／365，第 2 週試用後再調 | D-7 |
| S3-R27 | `eval/run.js` 的兩個「替身」單元測試（第 8.5 條）在真 suite 合入後改為斷言「真 suite 已接上、`anyStub=false`」 | 合併測試 |
| S3-R28 | `suiteNlq.js` 在 `EMBED_MODE=record` 時先把缺的查詢向量錄進 fixture 再量（否則 record 模式被「先檢查、查不到就 n/a」短路，查詢向量永遠錄不進去）；由開發者直接落地。nlq cassette 與 50 句查詢向量已於 2026-08-23 錄好（rules：coverage 0.84、filters_exact 1.0、recall10 1.0；llm：filters_exact 0.75、recall10 0.875）。LLM 路徑的 `semantic_text` 多為關鍵詞形式（「斜面 物體受力平衡」），與 golden 的整句期望不同——只是警告，定案 golden 時由開發者決定 llm 路徑的 `semantic_text` 要不要比對 | 錄製 |
