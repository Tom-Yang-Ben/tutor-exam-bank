# docs/interfaces-stage2.md — 階段 2 凍結介面（I0'）

> 產出者：S0（介面凍結與基礎），分支 `s0/stage2`，2026-08-21。
> 對應規劃：`docs/roadmap-plan.md` §3（階段 2 Agent 管線）全章、§4.3.1（併入的階段 3 欄位）、§5.3.2–3.3（golden、record/replay）。
> 分工：`docs/stage2-parallel-prompts.md`。

**這份文件是四條平行 workstream（WS-A/B/C/D）之間的不可變契約，優先於規劃文件。**

- `docs/interfaces.md`（階段 1，裁決 1–27）**仍然有效**，本檔不覆蓋它；兩邊衝突時以本檔為準並在本檔明講（目前只有第 5 條的 `generateJson` 擴充與第 9 條的 `EVAL_CASSETTE_DIR`）。
- 任何 workstream **不得修改本檔**。實作時發現介面有問題：停下來，寫進 `docs/questions2-ws<X>.md`，並在回報中明講，**不要自行改介面繞過**。
- 只有開發者本人可以改本檔；改動後必須通知四條 WS「第 N 條已更新為 …，請 rebase 後對齊」。
- 「凍結」＝**簽名與形狀**凍結（參數名、回傳鍵名、SQL 欄名、HTTP 狀態碼與訊息字串、enum 的字串值）。內部實作怎麼寫是各 WS 的自由。

---

## 0. A-T0 Spike 結論（2026-08-21 實測）

環境：`@google/genai` **2.4.0**、Node **v24.15.0**、Gemini Developer API、免費層金鑰。
重驗方式：`node scripts/spike_genai.js [models|schema|pdf|inline-limit|verify|all]`（S0 擁有，日後換模型時重跑）。

### 0.1 structured output 對長中文 enum 的支援：**可以用，enum 照放**

| 案例 | 設定 | 模型 | 結果 |
|---|---|---|---|
| A1 | `responseJsonSchema` + `chapter` 66 個中文 enum + `question_type` 5 個 enum + `additionalProperties:false` | `gemini-3.5-flash` / `gemini-3.7-flash` | ✅ 回 `向量內積`／`填空`，兩者都在白名單內 |
| A2 | `responseSchema`（舊欄位）+ 同一組 enum | `gemini-3.5-flash` / `gemini-2.5-flash` | ✅ 同上 |
| A3 | `responseJsonSchema` **不含 enum**，白名單只寫在 prompt | `gemini-3.5-flash` / `gemini-3.7-flash` | ⚠ 回 `平面向量`／`計算題`、`填充題`——**全部不在白名單內** |

**裁決 S0-1**：`agents/schemas/*.json` 的 `chapter`／`subject`／`question_type`／`answer_form` **一律含 enum**，並用 `responseJsonSchema`（不是 `responseSchema`）。
理由：A3 三次都回了白名單外的值，證明「prompt 列舉」這條退路的品質明顯較差；enum 放進 schema 幾乎零成本（66 個中文詞約 300 token）。

**裁決 S0-2**：`additionalProperties:false` 可用，照寫。注意 SDK 的 `responseSchema` 轉換器會**默默丟掉** `additionalProperties`（`_transformers.ts`），這是選 `responseJsonSchema` 的另一個理由。

**退路（仍然要實作，但預設不啟用）**：`services/llm/gemini.js` 若收到 400 且訊息含 `enum`／`schema`，改送「不含 enum 的 schema + prompt 列舉白名單」重試一次，並在 `job_events.detail` 記 `{schema_fallback:true}`。**伺服器端的 `ajv` 是最終閘門，任何情況都不可略過**——A3 的結果就是理由。

### 0.2 inlineData 的 PDF 大小門檻與切塊

| 量到的事 | 數字 |
|---|---|
| PDF 每頁的 prompt token（`promptTokensDetails` 的 `IMAGE` modality） | **532 token／頁**（A4，3 頁測得 1596，1 頁測得 532，完全線性） |
| inlineData 實際被接受的大小 | 原始 15 MB（base64 20 MB）✅、原始 20 MB（base64 26.7 MB）✅、原始 50 MB（base64 66.7 MB）✅ |
| 被拒絕的門檻 | **測到 50 MB 都沒有被拒絕**；官方文件仍建議大檔走 Files API |
| SDK 是否自動改走 Files API | 否（bundle 內只有 `files.upload` 的 8 MB 分塊常數，`generateContent` 不自動轉） |

**裁決 S0-3**：`JOB_PDF_CHUNK_PAGES=20` **合理，維持**。但理由要改寫：20 頁 ≈ 10.6k 輸入 token，離 1 048 576 的上下文上限與 65 536 的輸出上限都很遠，**切塊的真正理由是「失敗重試的粒度」與「輸出不被截斷」**，不是輸入塞不下。80 頁的考卷一次送也塞得下，但一次 schema_invalid 就要重付 80 頁的錢。

**裁決 S0-4**：`GEMINI_INLINE_MAX_BYTES=15728640`（15 MB，**base64 前的原始位元組**），對齊 `routes/index.js` 既有的 multer 上限。因此 Files API 這條路在階段 2 **不會被觸發**：`agents/extract.js` 仍要留 `{fileUri}` 的分支（`generateJson` 的 parts 已支援），但超過門檻時**回 `{kind:'fail', reason:'provider_error', feedback:'PDF 超過 inlineData 門檻，Files API 路徑尚未啟用'}`，不得 throw**（裁決 S2-9：確定性失敗不該退避重試；`extract` 的 `maxRetries` 為 0，會直接進 `needs_review('provider_error')`），並在 `docs/llm.md` 註明。真的要支援 >15 MB 的 PDF 時，同時放寬 multer 與實作 `ai.files.upload`。

### 0.3 當日可用的模型 ID

`ai.models.list()` 當日回 50 個模型、28 個支援 `generateContent`。與本專案相關的：

| 類別 | ID | 狀態 |
|---|---|---|
| Flash 穩定版 | `gemini-2.5-flash`、`gemini-3.5-flash`、`gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-flash-latest` | 全部可用；`gemini-3.7-flash` 當日**頻繁回 503「high demand」**（連續 5 次），退避後才成功 |
| Pro | `gemini-2.5-pro` | ❌ 404：`This model is no longer available to new users` |
| Pro | `gemini-3.1-pro-preview`、`gemini-pro-latest`（＝3.1 Pro） | ❌ 429：`free_tier_requests, limit: 0`——**免費層配額為零，要開通付費才能用** |

**裁決 S0-5**：
- `MODEL_EXTRACT=gemini:gemini-3.5-flash` —— 穩定、當日沒遇到 503，拆題是「一次送 20 頁、失敗要重付」的節點，可用性優先。
- `MODEL_VERIFY=gemini:gemini-3.7-flash` —— 更新的模型、每題只呼叫一次，品質優先；503 由 `provider_error` 的退避重試吸收。
- **規劃 §3.3.8 的「MODEL_VERIFY 用 Pro 系列」在本專案的金鑰上做不到**（見上表）。開通付費後改成 `MODEL_VERIFY=gemini:gemini-3.1-pro-preview`，那時才是真正的異級驗證；`report:jobs` 目前一律標「同家同級驗證」。
- `config/models.js` 啟動時若 `MODEL_VERIFY` 與 `MODEL_EXTRACT` 是**同一個 ID** 印警告（同模型自驗幾乎無效），不同 ID 不警告。

### 0.4 `usageMetadata` 的欄位名

實測回傳的鍵（`gemini-3.5-flash` / `gemini-3.7-flash` 皆同）：

```
promptTokenCount, candidatesTokenCount, totalTokenCount,
promptTokensDetails: [{ modality:'TEXT'|'IMAGE', tokenCount }],
thoughtsTokenCount, serviceTier
```

**裁決 S0-6**：
1. `thoughtsTokenCount` **一定有**，而且**經常大於 `candidatesTokenCount`**（實測 464 vs 129、691 vs 86、677 vs 324）。漏算就會系統性低估成本兩到五倍——`jobs.token_out` 與計費**必須**是 `candidatesTokenCount + thoughtsTokenCount`。
2. `cachedContentTokenCount` **在沒有快取命中時整個鍵不存在**（不是 0）。所有讀取一律 `?? 0`，`job_events.token_cached` 記 0。
3. `totalTokenCount = prompt + candidates + thoughts`，可用來做加總的自我檢查。
4. `promptTokensDetails` 可分出 PDF 頁數的 IMAGE token 與文字 token，`job_events.detail` 建議原樣存一份（`report:jobs` 要算「每頁成本」）。

### 0.5 由 spike 決定的環境變數預設值

| 變數 | 值 | 來自哪一條 |
|---|---|---|
| `MODEL_EXTRACT` | `gemini:gemini-3.5-flash` | S0-5 |
| `MODEL_VERIFY` | `gemini:gemini-3.7-flash` | S0-5 |
| `JOB_PDF_CHUNK_PAGES` | `20` | S0-3 |
| `GEMINI_INLINE_MAX_BYTES` | `15728640` | S0-4 |
| `JOB_NODE_TIMEOUT_MS` | `120000` | 規劃 §3.3.5；實測單次呼叫 2–20 秒，含退避留 6 倍餘裕 |
| `JOB_LEASE_MS` | `180000` | ≥ `JOB_NODE_TIMEOUT_MS` + 退避總和（120 + 1 + 2 + 4 = 127 秒）再留餘裕 |

> 呼叫次數說明：本次 spike 共 14 次生成呼叫（規劃寫 3–5 次），多出來的是 `gemini-3.7-flash` 的 503 重試與 Pro 系列的 404/429 排除，以及 3 次 inlineData 大小探測。總成本仍在免費層內。

---

## 1. 最終 DDL（`migrations/0003_jobs.sql`）與 PDF 存放

檔案已合入且**已套用到測試庫與開發庫**（各跑兩次，第二次 no-op）。

### 1.1 三張表的欄位摘要

**`jobs`** — 一份 PDF（或階段 3 的一次變式生成）一列。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `BIGINT IDENTITY PK` | |
| `kind` | `TEXT NOT NULL DEFAULT 'pdf'` | `CHECK IN ('pdf','variant')`（併自規劃 §4.3.1） |
| `pdf_sha256` | `CHAR(64)` | `kind='pdf'` 時必填（由 `jobs_kind_payload` CHECK 保證）；冪等的依據 |
| `pdf_path` | `TEXT` | **可為 NULL**：拆題完成後刪檔並清空；`kind='variant'` 本來就沒有 |
| `source_question_id` | `INT REFERENCES questions(id)` | `kind='variant'` 時必填（階段 3 用） |
| `page_count` | `INT` | |
| `state` | `TEXT NOT NULL DEFAULT 'queued'` | `CHECK IN ('queued','extracting','processing','done','failed')` |
| `token_in` / `token_out` | `INT NOT NULL DEFAULT 0` | `token_out` **含 thinking**（第 0.4 條） |
| `cost_usd` / `budget_usd` | `NUMERIC(10,6)` | `budget_usd` 建立時從 `JOB_COST_BUDGET_USD` 複製 |
| `error` | `TEXT` | |
| `locked_until` | `TIMESTAMPTZ` | 認領租約 |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `updated_at` 由應用層更新（不設觸發器，與階段 1 一致） |

索引：`idx_jobs_state (state, locked_until)`、`idx_jobs_pdf_sha256 (pdf_sha256) WHERE pdf_sha256 IS NOT NULL`。

**`job_questions`** — 一題一列。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `BIGINT IDENTITY PK` | |
| `job_id` | `BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE` | |
| `idx` | `INT NOT NULL` | `chunk_no * 1000 + 題序`；`UNIQUE (job_id, idx)` |
| `state` | `TEXT NOT NULL DEFAULT 'extracted'` | CHECK 寫死九個值（第 2 條） |
| `payload` | `JSONB NOT NULL DEFAULT '{}'` | 六個鍵，欄位見第 3 條 |
| `retries` | `JSONB NOT NULL DEFAULT '{}'` | `{classify:1, 'classify:error':0, …}` |
| `review_reason` | `TEXT` | CHECK 寫死八個值（第 2 條） |
| `question_id` | `INT REFERENCES questions(id)` | 入庫後回填 |
| `locked_until` | `TIMESTAMPTZ` | |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

索引：`idx_jq_state (state, locked_until)`、`idx_jq_review (review_reason, id) WHERE state='needs_review'`。
`UNIQUE (job_id, idx)` 本身就是 `(job_id, idx)` 的索引，**不要再建一支**。

**`job_events`** — 只追加，是成本與報表的唯一事實來源。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `BIGINT IDENTITY PK` | |
| `job_id` | `BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE` | |
| `jq_id` | `BIGINT REFERENCES job_questions(id) ON DELETE CASCADE` | 整份拆題的事件為 NULL |
| `node` | `TEXT NOT NULL` | **刻意不加 CHECK**；合法值清單見第 7.4 條 |
| `attempt` | `INT NOT NULL DEFAULT 1` | 從 1 起算 |
| `model` | `TEXT` | `'gemini:gemini-3.5-flash'`；純程式節點為 NULL |
| `token_in` / `token_out` / `token_thinking` / `token_cached` | `INT` | 純程式節點為 NULL |
| `cost_usd` | `NUMERIC(10,6)` | |
| `cost_estimated` | `BOOLEAN NOT NULL DEFAULT true` | `pricing.js` 查不到該模型時寫 `false`（第 5.5 條） |
| `latency_ms` | `INT NOT NULL` | |
| `outcome` | `TEXT NOT NULL` | `CHECK IN ('pass','fail','error','skipped')` |
| `error_class` | `TEXT` | CHECK 寫死九個值（第 2 條） |
| `detail` | `JSONB` | 建議存 `usageMetadata` 原文、`issues`、`feedback` 摘要 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

索引：`idx_job_events_job (job_id, id)`、`idx_job_events_time (created_at, node)`。

**`questions.text_hash`**：`ALTER TABLE questions ADD COLUMN text_hash CHAR(64)` + `idx_questions_text_hash (text_hash) WHERE text_hash IS NOT NULL`，**非唯一**。

### 1.2 與規劃 §3.3.2 的四點差異（裁決）

7. **`pdf_path` 可為 NULL**：規劃寫 `NOT NULL` 又要求「完成後清空」，自相矛盾；以可為 NULL 為準。
8. **`id` 用 `GENERATED ALWAYS AS IDENTITY`**（與 `0001_init.sql` 一致），不用 `BIGSERIAL`。
9. **不做 MySQL 版**：階段 1 已切到 PostgreSQL（`interfaces.md` 裁決 27），規劃「兩份 migration」的前提消失。
10. **`job_events.node` 不加 CHECK**：多一個節點不該需要一支 migration；`state`／`review_reason`／`error_class` 是跨 WS 的共同語彙，才用 CHECK 寫死。

### 1.3 PDF 存放

- 路徑：**`exam_pro/data/jobs/<job_id>.pdf`**（不是 `uploads/`——`app.js:13-27` 每小時清空 `uploads/`，會刪掉排隊中的 PDF）。
- 目錄由 `POST /api/jobs` 以 `fs.mkdirSync(dir, {recursive:true})` 自建，不需要 `.gitkeep`。
- `.gitignore`（根層級與 `exam_pro/` 各一份）**已加 `data/`**。真實考卷絕不可進版控（NOTICE 第 4 條）。
- 生命週期：`POST /api/jobs` 寫檔 → extract 節點讀檔 → **整份 job 的所有 chunk 都拆完後**，worker 刪檔並 `UPDATE jobs SET pdf_path = NULL`。`POST /api/jobs/:id/retry` 若需要重跑 extract 而 `pdf_path IS NULL`，回 409（第 6.7 條），**不是**靜默失敗。
- 冪等：`pdf_sha256` 相同且 `state <> 'failed'` 的 job 已存在時，回既有 job 且 `existing:true`，不重寫檔；`?force=1` 才建新 job。

---

## 2. 狀態機（`pipeline/stateMachine.js`，擁有者：WS-A）

**純函式、無 I/O、無時間、無隨機**，`node --test` 可窮舉。

### 2.1 狀態與節點

```js
// 推進序列（每個非終態恰好對應一個節點）
const NODE_FOR_STATE = {
    extracted:  'dedup0',
    hashed:     'classify',
    classified: 'lint',
    linted:     'verify',
    verified:   'dedup1',
    deduped:    'save'
};

// pass / skipped 時前進到的下一個狀態
const NEXT_STATE = {
    extracted:  'hashed',
    hashed:     'classified',
    classified: 'linted',
    linted:     'verified',
    verified:   'deduped',
    deduped:    'saved'
};

const TERMINAL_STATES = ['saved', 'needs_review', 'rejected'];
```

`job_questions.state` 的九個合法值（DDL 的 CHECK 與這裡一致）：
`extracted`／`hashed`／`classified`／`linted`／`verified`／`deduped`／`saved`／`needs_review`／`rejected`。

`jobs.state` 的五個值：`queued`（剛建立）→ `extracting`（worker 認領、正在拆題）→ `processing`（`job_questions` 已建立，逐題推進）→ `done`（**所有** `job_questions` 都在終態）／`failed`（extract 用盡重試，或 job 層例外；此時 `jobs.error` 必填）。

### 2.2 型別

```js
// outcome：agent 的回傳（第 3 條）
type Outcome =
  | { kind:'pass',    data: object }                         // data 寫進 payload[node]
  | { kind:'skipped',  data?: object }                        // 例如證明題的 verify、階段 1 未就緒的 dedup1
  | { kind:'fail',    reason: string, feedback?: string, data?: object }
  | { kind:'error',   errorClass: string, message?: string };

// limits：由 runner 從 config 組出來
const DEFAULT_LIMITS = {
    maxRetries:      { classify: 2, lint: 2, verify: 1 },  // 沒列到的節點＝0，不重試
    maxErrorRetries: 3,                                     // 所有節點共用；供應商錯誤的退避重試次數
    budgetLeft:      Infinity                               // = job.budget_usd - job.cost_usd
};

transition({ state, retries, outcome, limits }) → { state, retries, review_reason }
```

- `retries` 的鍵：一般失敗用節點名（`classify`），供應商錯誤用 **`${node}:error`**（`classify:error`）。兩者分開計數。
- **回傳的 `retries` 必須是新物件**，不得就地修改入參（純函式契約，WS-A 的測試會斷言）。
- `review_reason` 在不進 `needs_review` 時一律回 **`null`**（不是 `undefined`）。

### 2.3 完整規則（依序判斷，第一個命中就回傳）

1. `state` 不在 `NODE_FOR_STATE` 的鍵裡（含三個終態）→ **丟 `Error('transition：狀態 <state> 不可推進')`**。runner 不會認領終態的列，所以這是程式錯誤，不是資料狀態。
2. `outcome.kind` 不是四種之一 → 丟 `Error('transition：未知的 outcome.kind <kind>')`。
3. **預算已用盡**（`limits.budgetLeft <= 0`）且 `outcome.kind` 不是 `pass`／`skipped` → `{ state:'needs_review', retries, review_reason:'budget_exceeded' }`。
   （`pass`／`skipped` 照常前進：那次呼叫的錢已經花掉了，把成果丟掉只是浪費。）
4. `kind === 'pass'` 或 `'skipped'` → `{ state: NEXT_STATE[state], retries, review_reason:null }`。
5. `kind === 'fail'`：
   - `outcome.reason === 'budget_exceeded'` → 直接 `needs_review('budget_exceeded')`，**不重試**。
   - 否則 `node = NODE_FOR_STATE[state]`、`max = limits.maxRetries[node] ?? 0`、`used = retries[node] ?? 0`：
     - `used < max` → `{ state（不變）, retries:{…retries, [node]: used+1}, review_reason:null }`；
       `outcome.feedback` 由 **runner** 寫進 `payload[node].feedback` 供下次 prompt 使用（狀態機不碰 payload）。
     - `used >= max` → `{ state:'needs_review', retries（不變）, review_reason: REVIEW_REASON_FOR_FAIL(outcome.reason) }`。
6. `kind === 'error'`：
   - `outcome.errorClass === 'budget_exceeded'` → 直接 `needs_review('budget_exceeded')`，不退避。
   - 否則 `key = `${node}:error``、`used = retries[key] ?? 0`：
     - `used < limits.maxErrorRetries` → `{ state（不變）, retries:{…retries, [key]: used+1}, review_reason:null }`；
       **退避的睡眠由 runner 做**（1s → 2s → 4s），狀態機只負責計數。
     - 否則 → `{ state:'needs_review', retries（不變）, review_reason: REVIEW_REASON_FOR_ERROR(outcome.errorClass) }`。

```js
// fail 的 reason → review_reason（全函式，查不到一律落到 awaiting_approval）
function REVIEW_REASON_FOR_FAIL(reason) {
    const known = ['chapter_invalid','formula_unparsable','answer_mismatch',
                   'duplicate','schema_invalid','budget_exceeded','provider_error'];
    return known.includes(reason) ? reason : 'awaiting_approval';
}

// error 的 errorClass → review_reason
function REVIEW_REASON_FOR_ERROR(errorClass) {
    if (['rate_limited','timeout','provider_error'].includes(errorClass)) return 'provider_error';
    return REVIEW_REASON_FOR_FAIL(errorClass);
}
```

**`awaiting_approval` 的語意（凍結）**：「沒有任何閘門判定它壞掉，但流程需要人點頭」的那一格。第一版唯一的來源就是上面的 fallback——節點回了一個不在清單內的 `reason`（例如未來的 dedup1 想讓人決定 `merge_into`）。它保證 `transition()` 是**全函式**：任何 `reason` 都對應得到一個合法的 `review_reason`，DDL 的 CHECK 不會炸。

### 2.4 兩個必測的性質（WS-A 的 A-T2）

- **會停**：任何 `outcome` 序列從 `extracted` 出發，最多 `Σ maxRetries + Σ maxErrorRetries + 6` 步一定落到終態。
- **不迴圈**：`state` 只會「前進」或「留在原地並讓某個 retries 計數 +1」，不存在回到更早狀態的轉移。

---

## 3. Agent 合約（`agents/<name>.js`）

### 3.1 簽名與 ctx

```js
/**
 * @param {Ctx} ctx
 * @param {object} input   由 runner 依節點組出來（第 3.3 條逐節點列）
 * @returns {Promise<Outcome>}   第 2.2 條的四種形狀之一；**不得 throw**（例外由 runner
 *                               包成 {kind:'error', errorClass:'provider_error'}，但 agent
 *                               自己應該先分類成更精確的 errorClass）
 */
module.exports = { run };
```

```js
type Ctx = {
    llm: {
        generateJson(opts) → Promise<{data, usage, latencyMs, raw}>,   // 第 5 條
        embed(opts)        → Promise<{vectors, usage}>                  // interfaces.md 第 4 條
    },
    db: { pool, query },                       // interfaces.md 第 8 條的形狀
    job: { id, budget_usd, cost_usd },         // 數字；cost_usd 是「進入本節點前」的累計
    jq:  { id, idx, payload, retries } | null, // job 層節點（extract）為 null
    logger: { info(obj), warn(obj), error(obj) },   // 一行一個 JSON（規劃 §3.3.9）
    config: {
        models:     { extract:'gemini:gemini-3.5-flash', verify:'gemini:gemini-3.7-flash' },
        limits:     DEFAULT_LIMITS,                                    // 第 2.2 條
        thresholds: { classifyMinConf:0.8, dedupDup:0.97, dedupVariant:0.90,
                      pdfChunkPages:20, inlineMaxBytes:15728640, nodeTimeoutMs:120000 }
    },
    signal: AbortSignal                        // 節點逾時；一律往下傳給 generateJson
};
```

- **agent 不得自己 `require('../config/db')`、不得自己讀 `process.env`**：全部經 `ctx`。這是單元測試能離線跑的唯一原因。
- agent 不寫 `job_events`、不改 `job_questions.state`——那是 runner 的事。
- **`ctx.config.features = { similar: boolean, pipeline: boolean }`**（裁決 S2-8）：由 runner 從 `config/features.js` 組出來；agent 要知道旗標只能從這裡讀（dedup1 的 `skipped` 條件、classify 的 A 層 few-shot 都靠它）。
- **節點名與檔名的對應**（裁決 S2-6）：`dedup0`／`dedup1` 兩個節點由 `agents/dedup.js` 一支服務（匯出 `{ run, runDedup0, runDedup1 }`），另有三行的轉接檔 `agents/dedup0.js`／`agents/dedup1.js`；runner 的解析順序是 ①`agents/<node>.js` → ②`AGENT_MODULE_FOR_NODE[node]`（`dedup0|dedup1 → dedup`）。層級**只能靠凍結的 input 鍵**判斷（`dedup0` 拿 `{question_text}`、`dedup1` 拿 `{question_id, embed_text, subject, chapter}`），不得看 `ctx.jq.state` 或 payload。
- **`save` 節點不在 `agents/` 裡**（裁決 S2-7）：由 `workers/jobRunner.js` 的 `saveNode` 實作（要開交易、寫 `job_events`、回填 `question_id`，本來就不符合 agent 合約）；`job_events.node` 仍寫 `'save'`。
- **`idx` 由 agent 算**（裁決 S2-10）：`payload.extract.idx = chunk_no * 1000 + 元素在陣列中的位置 + 1`，不用模型給的題號（會跳號、重號而撞 `UNIQUE (job_id, idx)`）；`outcome.data.rejected[].idx` 同一套算法。

### 3.2 `payload` 的六個鍵（逐欄凍結）

`job_questions.payload` 是一個 JSONB 物件，每個節點只寫自己那一個鍵；**沒跑過的節點沒有鍵**（不是 `null`）。

```jsonc
{
  "extract": {                       // 由 extract 節點建立整列時寫入
    "idx": 1001,                     // = chunk_no * 1000 + 題序
    "subject": "數學",
    "chapter": "向量內積",            // 模型給的原始值（可能被 classify 覆寫）
    "chapter_confidence": 0.92,      // 0~1
    "question_type": "計算",
    "difficulty": 3,                 // 1~5
    "question_text": "…",            // **不含** [附圖描述：…]
    "answer_text": "…",
    "figure_desc": "…",              // 沒有附圖時整個鍵不存在
    "chunk_no": 1,
    "page_range": [1, 20]
  },
  "dedup0": {
    "text_hash": "<sha256 hex>",
    "normalized_len": 128,
    "hit": null                      // 或 {scope:'db', question_id:128} / {scope:'job', jq_id:55}
  },
  "classify": {
    "chapter": "向量內積",            // 最終採用的章節（save 用這個，不用 extract 的）
    "confidence": 0.92,
    "rationale": "…",                // ≤ 200 字
    "source": "gate",                // 'gate'（零成本閘門通過）| 'llm'（第二層）
    "few_shot_ids": [12, 87],        // source='llm' 才有；cassette 的 cacheKeyParts 用它
    "feedback": "…"                  // 只有重試時才有：上一次失敗的具體理由
  },
  "lint": {
    "question_text": "…",            // 修正後的文字（save 用這個）
    "answer_text": "…",
    "applied": ["frac_slash", "missing_rbrace"],       // formulaFix 套用的規則
    "issues": [{ "sev":"warn", "rule":"bare_script", "at":12, "msg":"…" }],  // 修完後仍存在的
    "rewritten": false,              // 是否動用了第三層 LLM 重寫
    "feedback": "…"
  },
  "verify": {
    "skipped": false,                // 證明題為 true，其餘欄位不存在
    "final_answer": "$1$",
    "answer_form": "number",         // 'option'|'number'|'expression'|'text'
    "steps_summary": "…",            // ≤ 400 字
    "claimed_answer": "$1$",         // 拆題模型給的答案（**不進 prompt**，只給比對器）
    "compare": "agree",              // 'agree'|'disagree'|'uncertain'
    "samples": 1                     // uncertain 再採樣一次時為 2
  },
  "dedup1": {
    "verdict": "unique",             // 'unique'|'variant'|'duplicate'|'skipped'
    "threshold_used": 0.97,
    "top": [{ "question_id": 87, "cosine": 0.9312 }]    // 最多 5 筆，由大到小
  }
}
```

### 3.3 每個節點的 `input` 與閘門

| 節點 | `input` | 通過條件（閘門） | 失敗時的 `reason` | 模型 |
|---|---|---|---|---|
| `extract` | `{ jobId, pdfPath, chunk:{ no, fromPage, toPage } }`；agent 自己讀檔切塊 | `ajv` **逐元素**驗證：合格元素進 `outcome.data.questions`，不合格元素記進 `outcome.data.rejected:[{idx, errors}]`；**整包都不合格**才 `fail` | `schema_invalid` | `MODEL_EXTRACT` |
| `dedup0` | `{ question_text }` | `normalizeStem` → `sha256`；命中 `questions.text_hash` 或同 job 內較小 `idx` 的列 → `fail('duplicate')`。**在任何 LLM 呼叫之前** | `duplicate` | 無 |
| `classify` | `{ subject, chapter, chapter_confidence, question_text }` | 第一層：`isValidChapter(subject, chapter)` 且 `chapter_confidence >= CLASSIFY_MIN_CONF` → `pass`（`source:'gate'`，**不呼叫 LLM**）；**`chapter_confidence` 缺值或 `0` 一律視為閘門不過，不得當成 1.0**（裁決 S2-13）。第二層 few-shot 三層取材（裁決 S2-8）：A 向量最近鄰（`ctx.config.features.similar` 且有 `ctx.db`：以 `ctx.llm.embed` 把題幹轉向量查 `questions`）→ B 各章取例（有 `ctx.db`）→ C `config/chapterExamples.js` 自製例句（永遠執行）；取材失敗一律降級不算失敗。LLM 輸出必須再過 `isValidChapter`。**eval 的 `--suite classify` 固定餵 `{subject, chapter: decoy 或 '', chapter_confidence: 0, question_text}` 且 `ctx.db = null`**，保證量到的是第二層；錄製 cassette 時同樣 `ctx.db = null`（`fewShotIds` 才可重現） | `chapter_invalid`，`feedback` 格式凍結為 `「${回傳值}」不在白名單內，最接近的是「${候選1}」「${候選2}」` | `MODEL_EXTRACT` |
| `lint` | `{ question_text, answer_text, feedback? }` | ① `formulaFix` ② `formulaLint` ③ 仍有 `sev:'error'` 才 LLM 重寫。閘門＝**沒有 `sev:'error'` 的 issue**（`warn` 放行） | `formula_unparsable` | ③ 才用 `MODEL_EXTRACT` |
| `verify` | `{ question_text, question_type }`（`figure_desc` 已併入題幹）**＋ `claimed_answer` 只放在 input，不得進 prompt** | `question_type === '證明'` → `skipped`。其餘：`answerCompare` 回 `agree` → `pass`；`uncertain` → 再採樣一次，仍 `uncertain` → `fail`；`disagree` → `fail` | `answer_mismatch` | `MODEL_VERIFY` |
| `dedup1` | `{ question_id:null, embed_text, subject, chapter }` | 餘弦 ≥ `DEDUP_DUP_THRESHOLD` → `fail('duplicate')`；≥ `DEDUP_VARIANT_THRESHOLD` → `pass`（`verdict:'variant'`，照常入庫）；來源題無向量或 `FEATURE_SIMILAR=false` → `skipped` | `duplicate` | 無 |
| `save` | 整個 `payload` | `validateQuestionFields` 最後一道；同一交易 `INSERT questions`（`origin='pdf'`、`chapter_src='ai'`、`text_hash`）+ 回填 `job_questions.question_id` | `schema_invalid` | — |

- `save` 節點把 `figure_desc` 以 **`[附圖描述：…]`** 併回 `question_text` 末端（與 `aiService.js` 現行格式一致，`wordService` 與前端不用改）。
- `save` 成功後由 runner 呼叫 `embedService.embedByIds([question_id])`（fire-and-forget，失敗只記 log，比照 `interfaces.md` 第 12.4 條）。

### 3.4 JSON schema 與 enum 注入

- 檔案：**`agents/schemas/<node>.json`**，只有 `extract`／`classify`／`verify`／`lint` 四支（純程式節點沒有）。
- 檔案裡**不寫 enum 的值**，改寫佔位符：

```jsonc
// agents/schemas/extract.json（片段）
"chapter":       { "type": "string", "x-enum": "chapter" },
"subject":       { "type": "string", "x-enum": "subject" },
"question_type": { "type": "string", "x-enum": "question_type" }
```

```js
/**
 * 讀 agents/schemas/<name>.json，把每個帶 x-enum 的節點換成 {type:'string', enum:[…]}
 * 並刪掉 x-enum；同一個 name 只組一次（模組內快取），回傳的物件已 Object.freeze（深凍結）。
 * 同一份結果同時餵給模型的 structured output 與伺服器端的 ajv——沒有第二份真相。
 * @param {'extract'|'classify'|'verify'|'lint'} name
 * @returns {object}   JSON Schema draft-07
 */
function buildSchema(name) {}

// x-enum 的合法值 → 來源（全部來自 config/chapters.js，不得手抄）
const ENUM_SOURCES = {
    subject:       SUBJECTS,                              // ['數學','物理']
    chapter:       [...CHAPTERS['數學'], ...CHAPTERS['物理']],   // 66 個，順序 = CHAPTERS 的宣告順序
    question_type: QUESTION_TYPES,                        // 五個，含「證明」
    answer_form:   ['option', 'number', 'expression', 'text']
};

module.exports = { buildSchema, ENUM_SOURCES };   // 檔案位置：agents/schemas/index.js（擁有者：WS-B）
```

- **`chapter` 的 enum 是兩科合併的 66 個**（不分科）：Gemini 的 schema 不支援「依 subject 切換 enum」；跨科的錯配由 `isValidChapter(subject, chapter)` 在伺服器端擋。
- `aiService.js` 裡手抄的那份白名單（`:14-27`）在 A-T8 **刪除**，prompt 的白名單改由 `CHAPTERS` 產生。WS-D 的單元測試會斷言「prompt 內出現的章節集合 === `CHAPTERS`」。

---

## 4. `utils/` 純函式簽名（擁有者：WS-C）

全部是純函式：無 I/O、無隨機、無時間、不讀 `process.env`。

### 4.1 `utils/normalizeStem.js`

```js
/**
 * 題幹正規化：讓「同一題的不同抄寫」收斂成同一個字串。
 * @param {string} text
 * @returns {string}   非字串／空字串一律回 ''，**不得拋例外**
 */
function normalizeStem(text) {}

/**
 * @param {string} text
 * @returns {string|null}   sha256(normalizeStem(text)) 的小寫 hex；正規化後為空回 null
 */
function textHash(text) {}

module.exports = { normalizeStem, textHash };
```

**七個步驟，順序凍結**（`scripts/backfill_text_hash.js` 已先實作一份，WS-C 的版本必須產出**逐位元相同**的雜湊）：

1. 非字串或空字串 → 回 `''`。
2. 剝掉所有 `[附圖描述：…]` 區塊（含中括號本身）：`/\[附圖描述[：:][\s\S]*?\]/g`。
3. `String.prototype.normalize('NFKC')`：全形英數、全形括號、全形問號逗號 → 半形。
4. 選項代號統一成 `(A)`：
   - 4a `/[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g` → `(大寫字母)`
   - 4b `/(^|[\s\n])([A-Ha-h])[.、．:：]/gm` → `$1(大寫字母)`
5. 去掉所有 `$`：`/\$/g`。
6. 去掉所有空白與換行：`/\s+/g`。
7. `toLowerCase()`。

> 步驟 4 必須在 6 之前（要靠空白認出「行首的 A.」）；步驟 3 必須在 4 之前（全形括號要先變半形）。
> 已知效果：`「正確？」`與`「正確?」`、`(A)` 與 `（Ａ）`、`A.` 與 `(A)`、`$x$=$1$` 與 `x=1` 都會收斂到同一個雜湊——2026-08-21 對開發庫 70 題回填時，正是靠這幾條抓出 2 組真重複（#2/#3、#5/#38）。
> **規則一改，全庫的 `text_hash` 作廢**，必須 `node scripts/backfill_text_hash.js --force` 重算並在 PR 說明。

### 4.2 `utils/answerCompare.js`

```js
/**
 * 比對「拆題模型抄下來的答案」與「驗證模型自己算出來的答案」。
 * @param {{
 *   question_type: '單選'|'多選'|'填空'|'計算'|'證明',
 *   claimed: string,                        // 原始 answer_text，可能含說明與計算過程
 *   model: { final_answer: string, answer_form: 'option'|'number'|'expression'|'text' }
 * }} opts
 * @returns {'agree'|'disagree'|'uncertain'}
 */
function answerCompare(opts) {}
module.exports = { answerCompare };
```

規則（凍結；裁決 S2-11／S2-12 改寫）：
- `單選`／`多選`：兩邊各抽出**選項代號集合**（`(A)`、`A`、`A.`、`甲` 不算），集合相等 → `agree`；任一邊抽不到代號 → `uncertain`。
- `填空`／`計算`：先從 `claimed` 抽 `final_answer`——**取最後一個 `$…$`**；該段含 `=` 或 `\approx` 就再取**最後一個 `=`／`\approx` 之後**的片段；只含上下標的片段（例如單位的 `$^2$`）視為單位的一部分**跳過**，往前找上一段 `$…$`；沒有任何 `$…$` 就取整段文字最後一個 `=`／`\approx` 之後；抽不到 → `uncertain`。（WS-D 對 fixture 45 題實測：舊規則「第一個 `$…$`」只抽對 4 題，本規則抽對 39 題。）
- 抽出後依 `answer_form` 比：`number`——`\frac{a}{b}`、小數、`a/b`、百分比三種寫法先化成同一個有理數，單位後綴去掉，**負號視為數值的一部分**（`-1` 與 `1` → `disagree`），`±` 只與 `±` 比量值、`±2` 對上單值 `2` → `uncertain`，容差 `1e-9`；`option` 同單選；`expression` 比去空白、去 `$`、去 `\left\right` 後的字串；`text` 比 `normalizeStem` 後的字串。
- `證明` 一律 `uncertain`（實務上 verify 節點會先 `skipped`，不會呼叫到）。
- **任何比不出來的情況都回 `uncertain`，不回 `disagree`**：誤報一次 `answer_mismatch` 的成本（老師白看一題）遠低於漏報。

### 4.3 `utils/textFormatter.js`（**只加不改**）

```js
/**
 * 嚴格模式解析：同一個 parser，事件只收集、不改變輸出。
 * 既有的 parseLatexToMath / buildParagraphComponents 行為必須逐位元不變
 * （test/textFormatter.test.js 的 29 項是契約）。
 * @param {string} str
 * @returns {{ ok: boolean, children: object[], events: Array<{kind:string, at:number}> }}
 *          ok === (events.length === 0)；at = 事件發生處在 str 中的 0-based 字元位置
 */
function parseLatexStrict(str) {}
```

`kind` 的六個值（凍結）：`unknown_command`／`missing_rbrace`／`empty_fallback`／`parser_error`／`tokenize_error`／`bare_script`。**凍結的是六個 kind，埋點位置由 WS-C 決定**（裁決 S2-17）：`bare_script` 除了 `renderMixedInto` 的純文字 `^`／`_`，也要在 `parseScripted` 對 `$…$` 內「`^`／`_` 後面什麼都沒有」發事件，fixture 的 10 題壞公式才抓得全。

### 4.4 `utils/formulaLint.js` / `utils/formulaFix.js`

```js
/**
 * @param {string} text   可含中文與多段 $…$
 * @returns {{ ok:boolean, issues: Array<{sev:'error'|'warn', rule:string, at:number, msg:string}> }}
 *          ok === issues.every(i => i.sev !== 'error')   ← 注意：有 warn 仍然 ok
 */
function formulaLint(text) {}

/**
 * 確定性修復（搬 fix_formulas.js:18-40 的規則），不呼叫任何模型。
 * @param {string} text
 * @returns {{ text:string, applied:string[] }}   applied = 實際套用到的規則名，順序 = 套用順序
 */
function formulaFix(text) {}
```

- `rule` 的字串值由 WS-C 定，但**必須穩定**（會進 `job_events.detail` 與報表）；新增規則不得改既有規則名。已凍結的兩條：`$…$` 內的裸上下標 = `bare_script`（`error`）、純文字裡的 `^`／`_` = `bare_script_text`（`warn`，填空題的 `答案：___` 就長這樣）。
- `formulaLint` 的 `sev` 分級原則：**會讓 Word 匯出降級成純文字的 → `error`**（`parseLatexStrict` 有事件）；只是寫法不漂亮的 → `warn`；`audit_formulas.js` 原本的 `info`（如 `latex_without_dollar`）一律併進 `warn`（裁決 S2-18，不加第三級）。

### 4.5 `utils/questionValidation.js`（擁有者：WS-A）

```js
/**
 * 從 controllers/questionController.js:10-25 原封不動抽出來，**行為一字不改**
 * （既有整合測試與 batch-save-questions 的回應形狀是契約）。
 * @param {object} q   HTTP body 或 payload 彙整後的欄位
 * @returns {{ ok: boolean, error?: string, errors: string[], value?: object }}
 *          不通過：{ ok:false, error:'<原訊息>', errors:['<原訊息>'] }（errors 恆為 error 的長度 1 陣列；
 *                  本函式一次只回一則訊息）；通過：{ ok:true, errors:[], value:{…} }
 *          ok=true 時 value 是正規化後的欄位（difficulty 轉 int、chapter trim 過）
 */
function validateQuestionFields(q) {}
module.exports = { validateQuestionFields };
```

`questionController.js` 改成 `require` 它，自己不再留一份（既有呼叫點讀 `error`、approve 讀 `errors`——裁決 S2-1 的「兩鍵並存」是最終形狀）。

---

## 5. `services/llm/`（擁有者：WS-B）

### 5.1 `generateJson` 簽名（沿用 `interfaces.md` 第 4 條，只加三個選用欄位）

```js
generateJson({
    model,             // 'gemini:gemini-3.5-flash'（帶 vendor 前綴）或裸 ID（視為 gemini）
    system,            // 選用
    parts,             // [{text}|{pdfBase64}|{fileUri}]
    schema,            // buildSchema(name) 的輸出；送進 responseJsonSchema
    maxOutputTokens,
    signal,            // AbortSignal（節點逾時）
    // ── 階段 2 新增（三個都是選用，舊呼叫端不受影響）──
    agent,             // string，cassette 的第一段鍵；record/replay 模式下**必填**
    cacheKeyParts,     // object，見 5.2
    template           // string，prompt 模板的識別名（記進 cassette 的 meta）；原文經 templates.js 註冊表回查
})
  → Promise<{ data, usage:{tokenIn, tokenOut, tokenThinking, tokenCached}, latencyMs, raw, schemaFallback }>
```

- `usage.tokenOut` = `candidatesTokenCount`；`usage.tokenThinking` = `thoughtsTokenCount`；**計費用 `tokenOut + tokenThinking`**（第 0.4 條）。
- `tokenCached` 在沒有快取命中時回 `0`（來源鍵不存在）。
- **模板註冊表**（裁決 S2-5）：`services/llm/templates.js` 匯出 `registerTemplate(name, text)`／`getTemplate(name)`；每個 agent 在模組載入時 `registerTemplate('<agent>.v1', PROMPT_TEMPLATE)`，`services/llm` 依 `template` 識別名回查原文算 `promptTemplateHash`。沒註冊的識別名退回 `sha256(識別名)` 並印一次警告（弱，識別名要帶版號）。**四個 LLM 節點（extract／classify／lint／verify）都必須註冊**。
- **`schemaFallback`**（裁決 S2-4）：布林，`true` = 這次走了「schema 不含 enum + prompt 列舉」的退路（第 0.1 條）；runner 把它寫進 `job_events.detail.schema_fallback`。

### 5.2 cassette 的鍵與檔案格式（`LLM_MODE=record|replay`）

```js
key = sha256( agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n'
            + JSON.stringify(cacheKeyParts) )
```

- `modelId` = **去掉 vendor 前綴後**的裸 ID（`gemini-3.5-flash`）。
- `promptTemplateHash` = `sha256(模板原文)`；模板＝把可變欄位挖空後的字串，由 agent 提供。
- `schemaHash` = `sha256(JSON.stringify(buildSchema(name)))`——**章節白名單改了，cassette 就該失效**，這是刻意的。
- `cacheKeyParts` 由 agent 傳，**必須是可重現的最小集合**：
  - `extract`：`{ template, chunkNo, pdfSha256 }`（**不含** PDF 內容）
  - `classify`：`{ template, questionText, fewShotIds:[…].sort((a,b)=>a-b) }`（**是 id 清單不是全文**，規劃 §5.3.3）
  - `lint`：`{ template, questionText, answerText, issues:[…rule].sort() }`
  - `verify`：`{ template, questionText, questionType, sampleNo }`（`sampleNo` 讓 uncertain 的第二次採樣有自己的 cassette）
- 檔案：**`<EVAL_CASSETTE_DIR>/<agent>/<key>.json`**（預設 `eval/cassettes/`）。

```jsonc
{
  "meta": {
    "agent": "classify",
    "model": "gemini-3.5-flash",
    "template": "classify.v1",
    "recorded_at": "2026-08-21T16:30:00.000Z",
    "fixtureHash": "<sha256 of eval/fixtures/questions.public.json>"
  },
  "request": {                      // 只存摘要，**不存 PDF base64、不存真實試題全文**
    "parts": [{ "kind": "text", "chars": 812, "sha256": "…" }],
    "cacheKeyParts": { "…": "…" }
  },
  "response": {
    "data": { "…": "…" },
    "usage": { "tokenIn": 812, "tokenOut": 96, "tokenThinking": 240, "tokenCached": 0 },
    "latencyMs": 1873
  }
}
```

- **replay miss 一律丟錯**，訊息逐字凍結為：
  `LLM_MODE=replay 找不到 cassette（agent=<agent> key=<key>）。請在本機執行 npm run eval:record -- --suite <suite>`
  不得靜默退回假資料。fork PR 由 CI（WS-D）判斷後降為 warning，**這個判斷不在 `services/llm` 裡**。`<suite>` 由 `services/llm` 保持字面不代換（它不知道 suite 名），後面可另接一行預期路徑；CI 比對訊息只比到 `--suite ` 為止（裁決 S2-14）。
- `meta.fixtureHash` 與現況不符時：印 warning「few-shot 內容已變，cassette 可能過期」，**仍然回放**（規劃 §5.3.3）。
- `record` 模式：真的呼叫 → 寫檔 → 回傳。已存在同鍵檔案時**覆寫**並印一行 log。

### 5.3 `services/llm/throttle.js`

```js
/**
 * 每個供應商兩個桶：RPM（滑動 60 秒視窗）與併發數。所有 adapter 呼叫前必須 await。
 * @param {'gemini'|'anthropic'|'openai'} vendor
 * @returns {Promise<() => void>}   resolve 出來的是 release()，呼叫端 finally 一定要叫
 */
async function acquire(vendor) {}
module.exports = { acquire };
```

- 上限來源：`GEMINI_RPM`（沿用既有的 `EMBED_RPM` 概念但獨立變數，WS-B 需要時在 PR 描述提出）、併發＝`JOB_CONCURRENCY`。
- 這一層保護的是**出口配額**，`middleware/rateLimit.js` 保護的是入口，**不共用**。

### 5.4 `config/models.js`

```js
/**
 * @param {string} spec   'vendor:model-id'；沒有冒號時 vendor 預設 'gemini'
 * @returns {{ vendor:string, id:string, spec:string }}
 * @throws  vendor 不在 ('gemini','anthropic','openai') 內時丟錯
 */
function parseModel(spec) {}

/** 啟動時呼叫一次：MODEL_VERIFY 與 MODEL_EXTRACT 的 id 相同時 console.warn（不中止） */
function warnIfSameModel() {}

module.exports = { parseModel, warnIfSameModel, MODEL_EXTRACT, MODEL_VERIFY };
```

警告文字凍結：`[models] MODEL_VERIFY 與 MODEL_EXTRACT 是同一個模型（<id>），驗證幾乎無效`。

### 5.5 `config/pricing.js`

```js
module.exports = {
    'gemini-3.5-flash': { input: 0, output: 0, cached: 0, verified_on: null },
    // …每個用到的模型一列
};
// 單位：USD / 1M token。output 欄同時適用 candidates 與 thinking（第 0.4 條）。
// verified_on: 'YYYY-MM-DD'，是「人去官網查證的日期」，null = 還沒查證。
```

```js
/**
 * @returns {{ cost_usd:number, cost_estimated:boolean }}
 *          查不到模型或 verified_on 為 null → { cost_usd: 0, cost_estimated: false }
 *          （記 0 而不是猜，report:jobs 會把 cost_estimated=false 的列另外標示）
 */
function estimateCost({ modelId, tokenIn, tokenOut, tokenThinking, tokenCached }) {}
```

---

## 6. HTTP API（擁有者：WS-A，掛在 `routes/index.js` 的 `[WS2-A: jobs]` 區塊）

全部在 `apiKeyAuth` 之後（`app.js:63` 已對 `/api` 全域套用）。錯誤回應一律 `{ message }`（可另帶 `errors`），**訊息字串逐字凍結**。

### 6.1 `POST /api/jobs`

- `multipart/form-data`，欄位名 **`pdf`**；沿用 `aiRateLimit`（每分鐘 10 次）與既有 multer 的 15 MB 上限。
- 查詢參數 `?force=1`：忽略冪等，一定建新 job。

| 狀態 | 回應 |
|---|---|
| 202 | `{ job_id: 41, existing: false }`；命中冪等時 `existing: true` 且 `job_id` 是既有那一筆 |
| 400 | `{ message: '沒有上傳檔案' }`（與 `aiController` 同字串） |
| 400 | `{ message: '只接受 PDF 檔案！' }` |
| 413 | `{ message: 'PDF 檔案過大，單次最多 15 MB。' }` |
| 429 | 由 `aiRateLimit` 產生，沿用既有字串 |

### 6.2 `GET /api/jobs/:id`

```jsonc
{ "id": 41, "state": "processing",
  "counts": { "saved": 12, "needs_review": 3, "pending": 15, "rejected": 0 },
  "token_in": 21440, "token_out": 8231, "cost_usd": 0.0412, "budget_usd": 0.5,
  "elapsed_ms": 83120 }
```

- `pending` = 非終態的列數（`extracted`…`deduped`）。四個 counts 相加 = 該 job 的 `job_questions` 總數。
- `elapsed_ms` = （`state` 為 `done`／`failed` 時用 `updated_at`，否則用 `now()`）− `created_at`。
- `cost_usd`／`budget_usd` 是 **number**（`config/db.js` 的 `NUMERIC` 回字串，controller 要 `Number()`）。
- 404：`{ message: '找不到該任務' }`

### 6.3 `GET /api/jobs/:id/questions?page=&limit=`

```jsonc
{ "total": 30, "page": 1, "limit": 20,
  "items": [ { "jq_id": 551, "idx": 1001, "state": "needs_review",
               "review_reason": "answer_mismatch", "stem_preview": "設 $\\vec{a}=(1,2)$…",
               "question_id": null } ] }
```

- `page` 預設 1、`limit` 預設 20（最大 100）；排序固定 `ORDER BY idx ASC`。
- `stem_preview` = `payload.lint.question_text ?? payload.extract.question_text` 的**前 80 個字元**（先把連續空白換成單一空白），不加省略號。
- 400：`{ message: 'page 與 limit 必須是正整數。' }`／`{ message: 'limit 最大 100。' }`
- 404：`{ message: '找不到該任務' }`

### 6.4 `GET /api/review?reason=&limit=`

```jsonc
{ "items": [ { "jq_id": 551, "job_id": 41, "idx": 1001, "state": "needs_review",
               "review_reason": "answer_mismatch", "stem_preview": "…", "question_id": null } ] }
```

- 跨 job 的 `state='needs_review'` 佇列；`ORDER BY id ASC`（先進先審）。
- `reason` 選填，給了就必須在第 2 條的八個值內；`limit` 預設 50、最大 200。
- 400：`{ message: 'reason 不在合法的複核原因清單內。' }`

### 6.5 `GET /api/review/:jqId`

```jsonc
{ "jq_id": 551, "job_id": 41, "idx": 1001, "state": "needs_review",
  "review_reason": "answer_mismatch", "retries": { "verify": 1 },
  "payload": { "…第 3.2 條的完整內容…" },
  "question_id": null, "created_at": "…", "updated_at": "…" }
```

- 404：`{ message: '找不到該待複核題目' }`

### 6.6 `POST /api/review/:jqId/approve` / `POST /api/review/:jqId/reject`

**approve** body = 修正後的題目欄位（與 `POST /api/questions` 同名同義）＋兩個選用旗標：

```jsonc
{ "subject":"數學", "chapter":"向量內積", "question_type":"計算", "difficulty":3,
  "question_text":"…", "answer_text":"…", "question_img":null, "solution_img":null,
  "accept_plain_text": false,      // true = 明示接受公式降級成純文字
  "merge_into": null }             // duplicate 時給 question_id：不入新題，只在 payload 記 variant
```

**人也要過閘門**：`validateQuestionFields` + `formulaLint` 都要重跑。

| 狀態 | 回應 |
|---|---|
| 200 | `{ question_id: 131 }`；`merge_into` 路徑回 `{ question_id: <merge_into>, merged: true }` |
| 400 | `{ message: '欄位驗證失敗', errors: [ … ] }`（`errors` 原樣來自 `validateQuestionFields`） |
| 400 | `{ message: '公式仍有無法解析的問題，請修正後再送出，或勾選「接受純文字降級」。', errors: [ {sev,rule,at,msg} … ] }` |
| 400 | `{ message: 'merge_into 指向的題目不存在。' }` |
| 404 | `{ message: '找不到該待複核題目' }` |
| 409 | `{ message: '該題目已處理完畢，不能重複複核。' }`（`state` 已是 `saved`／`rejected`） |

- 成功後：`job_questions.state='saved'`、`review_reason=NULL`、回填 `question_id`；`questions.origin='pdf'`、`chapter_src='human'`（人改過的章節）、`text_hash` 一併寫入——全部同一個交易。

**reject**：200 `{ message: '已標記為不採用。', jq_id: 551 }`；404／409 同上。`state='rejected'`，`review_reason` 保留原值。

### 6.7 `POST /api/jobs/:id/retry`

- body：`{ "budget_usd": 1.0 }`（選填；給了就覆寫 `jobs.budget_usd`）。
- 行為：把該 job 內 `review_reason IN ('provider_error','budget_exceeded')` 的列**退回前一個狀態**（`review_reason=NULL`、清掉對應的 `retries` 鍵），`jobs.state` 改回 `processing`。

| 狀態 | 回應 |
|---|---|
| 202 | `{ job_id: 41, requeued: 7 }` |
| 400 | `{ message: 'budget_usd 必須是大於 0 的數字。' }` |
| 404 | `{ message: '找不到該任務' }` |
| 409 | `{ message: '這份任務沒有可重跑的題目。' }` |
| 409 | `{ message: 'PDF 原檔已刪除，無法重跑拆題。' }`（需要重跑 extract 但 `pdf_path IS NULL`） |

---

## 7. Worker（`workers/jobRunner.js`，擁有者：WS-A）

### 7.1 認領

- `setInterval(tick, JOB_POLL_MS)`；每個 tick 最多認領到 `JOB_CONCURRENCY` 個在跑的槽為止。
- 認領在**一個交易內兩句**（`jobs` 與 `job_questions` 各一套）：

```sql
BEGIN;
SELECT id FROM job_questions
 WHERE state IN ('extracted','hashed','classified','linted','verified','deduped')
   AND (locked_until IS NULL OR locked_until < now())
 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
UPDATE job_questions SET locked_until = now() + ($1 || ' milliseconds')::interval WHERE id = $2;
COMMIT;
```

- **呼叫進行中每 30 秒續租**（`UPDATE locked_until`），避免另一個並行槽重新認領仍在付費的列。
- 租約過期的列會被重新認領——這就是 `nodemon` 重啟／崩潰後的重跑保證。

### 7.2 啟動方式

- `JOB_RUNNER=inline`（預設）：`server.js` 起 runner。
- `JOB_RUNNER=off`：不啟動（測試、純 API 部署、開發時想用另一個視窗跑）。
- `node workers/jobRunner.js` 可獨立跑（自己 `require('dotenv').config()`）。

### 7.3 預算三層（規劃 §3.3.5）

1. 每節點重試上限（第 2.2 條的 `maxRetries`／`maxErrorRetries`）。
2. 每份 PDF：呼叫**前**檢查 `cost_usd + 估計 <= budget_usd`，不夠就不呼叫，直接對該列走 `budget_exceeded`；呼叫**後**用實際 usage 累加回 `jobs`。
3. 每節點逾時 `JOB_NODE_TIMEOUT_MS`，`AbortController` 的 signal 經 `ctx.signal` 傳進 SDK。
4. 全域止血 `DAILY_COST_BUDGET_USD`：當日（`job_events.created_at >= date_trunc('day', now())`）成本累計超過就**不再認領新 job**（API 仍可排隊），並印一行 warning。

### 7.4 `job_events` 的 `node` 合法值（清單凍結，但不進 DB CHECK）

`extract`／`dedup0`／`classify`／`lint`／`verify`／`dedup1`／`save`／`approve`／`reject`／`retry`／`claim`。
人工動作（`approve`／`reject`／`retry`）也寫一列，`model=NULL`、`outcome='pass'`、`latency_ms` 記 API 處理時間——這樣 `report:jobs` 才看得到「人花了多久、改了幾題」。

### 7.5 日誌

一行一個 JSON（`console.log(JSON.stringify({...}))`），必含 `ts, level, job_id, jq_id, node, attempt, outcome, latency_ms`。
Windows 提醒：PowerShell 5.1 的 `>` 會寫成 UTF-16LE，要用 `npm start | Out-File -Encoding utf8 logs\app.log` 或 cmd.exe。

---

## 8. 前端（擁有者：WS-D）

- **`public/js/review.js` 是 ES module**，經 `window.ExamApp` 橋接既有函式：
  `apiFetch`／`showToast`／`renderMath`／`escapeHtml`／`createQuestionEditor`。
  `index.html` 必須在既有 inline script 裡把這五個掛上 `window.ExamApp`（**只加不改**）。
- `index.html` 只插**兩處**：一個 `<section id="review"></section>` 錨點，一行 `<script type="module" src="/js/review.js"></script>`。
- 舊流程 `/analyze-pdf` + `batch-save-questions` **保留可用**（既有測試是契約）。
- `FEATURE_PIPELINE=true` 時：上傳區改送 `POST /api/jobs` → 每 3 秒輪詢 `GET /api/jobs/:id` → 顯示「已入庫 N／待複核 M／處理中 K」；複核分頁走 `GET /api/review`，每張卡片沿用 `createQuestionEditor(q)`，頂端一條原因列（機器產生的具體句子），按鈕「修正入庫／略過」對應 approve／reject。
- 旗標讀法：後端在 `GET /api/chapter-whitelist` 之外不另開端點；前端從 `index.html` 既有的注入點讀（WS-D 決定，但**不得**把 `FEATURE_PIPELINE` 寫死在 JS）。

---

## 9. 環境變數（階段 2 新增，全名與預設）

`.env.example` **只由 S0 直接編輯**（已寫入下列全部變數）；各 WS 需要新變數時寫在 PR 描述。

| 變數 | 預設 | 用途 | 誰讀 |
|---|---|---|---|
| `MODEL_EXTRACT` | `gemini:gemini-3.5-flash` | 拆題／分類／公式重寫用（第 0.3 條） | WS-B |
| `MODEL_VERIFY` | `gemini:gemini-3.7-flash` | 解題驗證用；開通付費後改 `gemini:gemini-3.1-pro-preview` | WS-B |
| `ANTHROPIC_API_KEY` | （空） | 預留給 A-T17 異家驗證，**第一版不讀** | — |
| `GEMINI_RPM` | `5` | `generateContent` 的每分鐘上限（令牌桶，與 `EMBED_RPM` 獨立）；免費層實測為 5，開通付費後放寬（裁決 S2-16） | WS-B |
| `LLM_MODE` | `replay` | 既有；`live`／`record`／`replay`，CI 恆為 `replay` | WS-B、WS-D |
| `EVAL_CASSETTE_DIR` | `eval/cassettes` | **裁決 25 在此定案**：`--golden` 落在 `eval/private/` 時，由 `eval/run.js` 在行程內改成 `eval/private/cassettes` | WS-B、WS-D |
| `JOB_RUNNER` | `inline` | `inline`／`off` | WS-A |
| `JOB_POLL_MS` | `2000` | 認領輪詢間隔 | WS-A |
| `JOB_CONCURRENCY` | `2` | 同時處理的列數 | WS-A |
| `JOB_LEASE_MS` | `180000` | 租約長度，必須 ≥ `JOB_NODE_TIMEOUT_MS` + 退避總和 | WS-A |
| `JOB_NODE_TIMEOUT_MS` | `120000` | 單節點逾時（`AbortController`） | WS-A |
| `JOB_COST_BUDGET_USD` | `0.50` | 每份 PDF 的成本上限，建立時複製進 `jobs.budget_usd` | WS-A |
| `DAILY_COST_BUDGET_USD` | `5.00` | 全域止血；超過不再認領新 job | WS-A |
| `JOB_PDF_CHUNK_PAGES` | `20` | 切塊頁數（第 0.2 條） | WS-B |
| `GEMINI_INLINE_MAX_BYTES` | `15728640` | 超過才走 Files API（base64 前的原始位元組） | WS-B |
| `CLASSIFY_MIN_CONF` | `0.8` | classify 零成本閘門的信心門檻 | WS-B |
| `DEDUP_DUP_THRESHOLD` | `0.97` | 餘弦 ≥ 此值 → `duplicate` | WS-C |
| `DEDUP_VARIANT_THRESHOLD` | `0.90` | 餘弦 ≥ 此值 → `variant`（照常入庫） | WS-C |
| `FEATURE_PIPELINE` | `false` | 前端上傳區是否改走 `POST /api/jobs` | WS-D |

- 布林值的解讀沿用 `interfaces.md` 第 9 條：字串 `1` 或 `true`（不分大小寫）為真，其餘皆為假；`FEATURE_*` 一律經 `config/features.js`。
- 階段 1 的變數全部**不變**（`DATABASE_URL`、`EMBED_*`、`FEATURE_SIMILAR`…）。
- **GitHub Actions 不放任何 LLM 金鑰**；`.bat` 不得出現金鑰。

---

## 10. 檔案所有權與 `routes/index.js` 區塊

### 10.1 誰擁有哪些檔案（別人不得改）

| Workstream | 擁有的檔案（階段 2） |
|---|---|
| **S0**（已完成） | `migrations/0003_jobs.sql`、`scripts/backfill_text_hash.js`、`scripts/spike_genai.js`、`config/chapterExamples.js`（空殼）、`.env.example`、`.gitignore`、`docs/interfaces-stage2.md`、`routes/index.js` 的四個新區塊（空殼） |
| **WS-A** 管線核心 | `pipeline/`、`workers/`（含 `save` 節點）、`controllers/jobController.js`、`controllers/reviewController.js`、`utils/questionValidation.js`、`scripts/report_jobs.js`、`server.js`、**`app.js`**（裁決 S2-20：`serveIndex()` 的 `__FEATURE_PIPELINE__` 注入）、`routes/index.js` 的 `[WS2-A: jobs]` 區塊 |
| **WS-B** LLM 層與前段 agents | `services/llm/*`（含 `cassette.js`、`templates.js`、`throttle.js`、`fake.js`）、`config/models.js`、`config/pricing.js`、`agents/extract.js`、`agents/classify.js`、`agents/promptParts.js`、`agents/schemas/`（含 `index.js` 的 `buildSchema`）、`config/chapterExamples.js`（**填內容**）、`eval/cassettes/**`、`scripts/record_cassettes.js`、**`services/legacy/analyzePdf.js`**（裁決 S2-19：A-T8 前的 `aiService.js` 快照，給 `compare_pipeline --method legacy` 用）、`docs/llm.md` |
| **WS-C** 閘門零件與後段 agents | `utils/textFormatter.js`（**只加**）、`utils/formulaFix.js`、`utils/formulaLint.js`、`utils/answerCompare.js`、`utils/normalizeStem.js`、`agents/lint.js`、`agents/verify.js`、`agents/dedup.js`、`agents/dedup0.js`、`agents/dedup1.js`、`agents/schemas/verify.json`、`lint.json`、`eval/golden/formula.json`、`scripts/backfill_text_hash.js`（合入後改 `require` `utils/normalizeStem`） |
| **WS-D** 評估與前端 | `eval/**`（`cassettes/` 除外）、`public/index.html`、`public/js/review.js`、`.github/workflows/ci.yml`、`package.json` 的 `scripts`、`.gitattributes` |
| **測試檔（裁決 S2-2）** | `test/unit/` 與 `test/integration/` 下，**各 WS 可新增自己擁有模組的測試檔**（例如 `stateMachine.test.js` 歸 A、`agentsGates.test.js` 歸 C），**不得修改別人的檔**；既有 `test/unit/shuffle|textFormatter.test.js` 是契約 |

共用檔規則（與階段 1 相同）：

- `routes/index.js` —— **append-only**，只在自己的區塊內加行，不重排既有路由。
- `package.json` —— deps 各 WS 只加自己需要的（WS-B：`ajv`、`pdf-lib`）；`scripts` 由 WS-D 統一。
- `.env.example` —— 不直接改，新變數列在 PR 描述。
- `agents/` 與 `agents/schemas/` 由 WS-B 與 WS-C 共用：**按檔案分**，不動對方的檔。
- `scripts/backfill_text_hash.js` 在 WS-C 的 `utils/normalizeStem.js` 合入後由 **WS-C** 改成 `require` 它（檔頭已標 TODO），並驗證雜湊逐位元相同。

### 10.2 `routes/index.js` 的四個新區塊（名稱凍結，S0 已建空殼）

```js
// ===== [WS2-A: jobs] =====
// ===== [/WS2-A: jobs] =====

// ===== [WS2-B: llm] =====
// ===== [/WS2-B: llm] =====

// ===== [WS2-C: gates] =====
// ===== [/WS2-C: gates] =====

// ===== [WS2-D: eval] =====
// ===== [/WS2-D: eval] =====
```

階段 1 的四個區塊（`[WS-A: DB]`…`[WS-D: eval]`）原封不動保留在上方。

---

## 11. migrations 只增不改

- `0001_init.sql`、`0002_vector.sql`、`0004_origin_legacy.sql` 已凍結；**`0003_jobs.sql` 一併凍結**（已套用到測試庫與開發庫）。
- 階段 2 之後任何欄位／索引／約束變更一律新開檔案，**從 `0005_` 起**（`0004` 已被階段 1 的裁決 13 用掉）。
- `migrate.js` 沒有 `down`：寫錯的 migration 用「再寫一支把它改回來」修正。
- `text_hash` 改成 UNIQUE 是**另一支 migration**，前提是 `scripts/backfill_text_hash.js` 的碰撞清單經人工逐組確認（目前開發庫有 2 組待確認：#2/#3、#5/#38）。
- WS 發現缺欄位時，**不是**改 `0003`，而是寫進 `docs/questions2-ws<X>.md` 由開發者本人裁決後新開一支。

---

## 12. 第一輪裁決（階段 2，2026-08-22，回應 `questions2-ws*.md` 共 32 條）

全部已寫進對應條文；編號 S2-*。

| # | 裁決 | 來源 |
|---|---|---|
| S2-1 | `validateQuestionFields` 回 `{ok, error, errors, value?}` 兩鍵並存（第 4.5 條） | A-1 |
| S2-2 | 各 WS 可在 `test/unit|integration` 新增自己的測試檔，不得改別人的（第 10.1 條） | A-2／C-4 |
| S2-3 | 終止上界以第 2.4 條的 `Σ maxRetries + Σ maxErrorRetries + 6 = 29` 為準；規劃 §3.8 的 11 作廢 | A-3 |
| S2-4 | `generateJson` 回傳多 `schemaFallback`，runner 寫進 `job_events.detail.schema_fallback`（第 5.1 條） | B-Q5 |
| S2-5 | 模板原文走 `services/llm/templates.js` 註冊表，四個 LLM 節點都要 `registerTemplate`（第 5.1 條） | B-Q1／C-7 |
| S2-6 | `dedup0`／`dedup1` 由 `agents/dedup.js` + 兩支轉接檔服務，runner 另有對應表；層級只看 input 鍵（第 3.1 條） | A-6／C-6 |
| S2-7 | `save` 節點歸 runner（第 3.1、10.1 條） | A-7 |
| S2-8 | `ctx.config.features = {similar, pipeline}` 由 runner 組；classify 三層 few-shot；錄製與 eval 一律 `ctx.db=null`（第 3.1、3.3 條） | B-Q2／C-3 |
| S2-9 | PDF 超門檻回 `fail('provider_error')` 不 throw（S0-4 改寫） | B-Q3 |
| S2-10 | `idx` 由 agent 算（第 3.1 條） | B-Q4 |
| S2-11 | `answerCompare` 的 `number`：負號是數值一部分、`±` 只與 `±` 比（第 4.2 條） | C-1 |
| S2-12 | `final_answer` 抽取改為「最後一個 `$…$`，含 `=`／`\approx` 取其後，純上下標片段跳過」（第 4.2 條）；D 的 answer golden 改回真實寫法 | D-Q3 |
| S2-13 | classify 的 `chapter_confidence` 缺值／0 視為閘門不過；eval 的 classify suite 輸入約定寫進第 3.3 條 | D-Q4 |
| S2-14 | replay miss 訊息的 `<suite>` 保持字面，CI 只比對前綴（第 5.2 條） | B-Q6 |
| S2-15 | 根 `.gitignore` 加 `!exam_pro/eval/fixtures/*.pdf`；樣卷以 WS-D 的 `eval/fixtures/make_sample_pdf.js` 產出為準，WS-B 的 `scripts/make_sample_exam_pdf.js` 退場，cassette 要對 D 的樣卷重錄 | B-Q7／B-Q8／D-Q5 |
| S2-16 | `GEMINI_RPM=5` 進 `.env.example` 與第 9 條 | B-Q9 |
| S2-17 | `bare_script` 埋點補 `parseScripted`；rule 分 `bare_script`／`bare_script_text`（第 4.3、4.4 條） | C-2 |
| S2-18 | `formulaLint` 的 info 併 warn（第 4.4 條） | C-8 |
| S2-19 | `services/legacy/analyzePdf.js` 由 WS-B 從 A-T8 之前的 `aiService.js` 快照建立（取 `git show e1740ca:exam_pro/services/aiService.js`），歸 WS-B（第 10.1 條） | D-Q1 |
| S2-20 | `app.js` 歸 WS-A；`serveIndex()` 補 `__FEATURE_PIPELINE__` 注入（第 10.1 條） | D-Q2 |
| S2-21 | `/api/jobs` 自己把 multer `LIMIT_FILE_SIZE` 轉成 413 凍結字串；`/analyze-pdf` 維持舊行為 | A-4 |
| S2-22 | extracting 期間 `counts` 全 0、靠 `state` 顯示「拆題中」；前端據此顯示 | A-5 |
| S2-23 | approve 入庫時 `text_hash` **對修正後的 `question_text` 重算**（`utils/normalizeStem.textHash`），不沿用 payload 的值——人改過文字，雜湊就該變；A 的整合測試據此修正 | 合併測試 |
| S2-24 | C 的 `agents/_schema.js` 橋接在 B 合入後改用 `agents/schemas/index.js` 的 `buildSchema` 並刪除 | C-5 |
| S2-25 | B 改了 `test/unit/llmEmbed.test.js` 一項斷言（接受）；新檔 `cassette.js`／`templates.js`／`promptParts.js`／`record_cassettes.js` 歸 B | B-Q10／B-Q7 |
| 人工 | fixture #47（直線運動 vs 物體的運動）、#54（電場與電位 vs 靜電學）的章節由開發者決定；開發庫 `text_hash` 碰撞 #2/#3、#5/#38 由開發者確認 | B 附帶／S0 |

---
