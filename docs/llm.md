# docs/llm.md — LLM 層操作手冊（`services/llm/`）

> 擁有者：WS-B（階段 2，A-T3／A-T8／A-T9）。
> 契約：`docs/interfaces-stage2.md` 第 3、5 條與 `docs/interfaces.md` 第 4 條。**這兩份是凍結介面，本檔不覆蓋它們**；有出入時以介面文件為準，並把問題寫進 `docs/questions2-wsB.md`。

全案所有的 LLM 呼叫都只經過一個出入口：

```js
const { generateJson, embed } = require('./services/llm');
```

`aiService`、五個 sub-agent、eval、腳本都不得自己 `new GoogleGenAI(...)`。理由很實際：**模式切換、令牌桶、退避、cassette、成本統計都只寫一份**；只要有第二條路，CI 就會在某天偷偷連外。

---

## 1. 三個模式（`LLM_MODE`）

| 值 | 行為 | 誰用 |
|---|---|---|
| `replay` | **只讀 cassette**。找不到就丟錯，不會呼叫模型、也不會回假資料 | CI、`npm test`、`npm run test:integration`、eval（**預設值**） |
| `record` | 真的呼叫模型 → 把回應寫成 cassette → 回傳 | 只在本機、只對公開素材（見第 4 節） |
| `live` | 真的呼叫模型，不留 cassette | 本機開發、`/analyze-pdf` 實際使用 |

- 沒設 `LLM_MODE` 時預設 `replay`——最安全的那一個（不花錢、不需要金鑰）。
- 值不是這三個之一時**啟動就丟錯**，不會默默走 `live`。
- embedding 是另一組旗標（`EMBED_MODE = live | record | fixture`），兩者互不影響（`docs/interfaces.md` 第 4 條）。

PowerShell 沒有行內 `VAR=x cmd` 語法。要臨時換模式，用 `--env-file` 或改 `.env`：

```powershell
# 用既有的 eval/.env.replay（只有 LLM_MODE=replay 與 EMBED_MODE=fixture，沒有任何金鑰）
node --env-file=eval/.env.replay scripts/some_script.js
```

---

## 2. `generateJson` 的簽名

```js
const res = await generateJson({
    model,             // 'gemini:gemini-3.5-flash' 或裸 ID（沒有冒號時 vendor 視為 gemini）
    system,            // 選用，systemInstruction
    parts,             // [{text} | {pdfBase64} | {fileUri}]
    schema,            // buildSchema('extract') 的輸出；送進 responseJsonSchema
    maxOutputTokens,   // 選用；不給就是模型的預設上限（避免長考卷被截斷）
    signal,            // AbortSignal（節點逾時），一路傳進 SDK
    // ── record／replay 才需要 ──
    agent,             // 'extract' | 'classify' | …；cassette 的第一段鍵與子目錄名，**必填**
    template,          // 模板識別名，例如 'extract.v1'
    cacheKeyParts      // 逐節點的最小集合，見第 3 節
});
// → { data, usage:{tokenIn, tokenOut, tokenThinking, tokenCached}, latencyMs, raw, schemaFallback }
```

幾件必須知道的事：

1. **計費是 `tokenOut + tokenThinking`**，不是只有 `tokenOut`。實測（2026-08-22 錄 `sample_exam.pdf`）：
   `tokenIn=1534 / tokenOut=1161 / tokenThinking=1856`——thinking 比 candidates 還多 60%。
   只算 `tokenOut` 會系統性低估成本兩到五倍（裁決 S0-6）。
2. `tokenCached` 在沒有快取命中時**整個鍵不存在**（不是 0），這一層一律 `?? 0` 補上。
3. `raw` 在 `replay` 模式是 `null`。**agent 不得依賴 `raw`**。
4. `schemaFallback` 是額外多出來的鍵（介面第 5.1 條的回傳形狀之外），`true` 代表這次走了「不含 enum 的 schema + prompt 列舉」的退路，runner 應該把它記進 `job_events.detail`。
5. 供應商目前只有 `gemini`。`anthropic` / `openai` 給 A-T17 預留，現在傳進去會直接丟錯（不是靜默改用 gemini）。

### structured output 用 `responseJsonSchema`

裁決 S0-1／S0-2：用 `responseJsonSchema`，不用 `responseSchema`（SDK 的轉換器會默默丟掉 `additionalProperties`）。

**退路**（預設不啟用）：收到 400 且訊息含 `enum` 或 `schema` 時，`gemini.js` 會自動把 schema 裡的 enum 全部拆掉、改把白名單寫成一段 prompt，重試一次，並回 `schemaFallback: true`。
A-T0 spike 實測「白名單只寫在 prompt」三次全部回了白名單外的章節名，所以**伺服器端的 `ajv` 與 `isValidChapter` 在任何情況下都不可略過**——退路只是讓流程不中斷，不是讓閘門放水。

---

## 3. cassette 的鍵規則

```
key = sha256( agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n'
            + JSON.stringify(cacheKeyParts) )
```

| 組成 | 來源 | 什麼時候會變 |
|---|---|---|
| `agent` | 呼叫端傳的 `agent` | 換 agent |
| `modelId` | **去掉 vendor 前綴**的裸 ID | 換 `MODEL_EXTRACT` / `MODEL_VERIFY` |
| `promptTemplateHash` | `sha256(模板原文)`，見下 | 改 prompt 模板 |
| `schemaHash` | `sha256(JSON.stringify(schema))` | 改 `agents/schemas/*.json`，或**改 `config/chapters.js` 的章節白名單** |
| `cacheKeyParts` | agent 傳的最小集合 | 換題目／換 PDF／換 few-shot |

檔案落在 **`<EVAL_CASSETTE_DIR>/<agent>/<key>.json`**（預設 `eval/cassettes/`）。

### 模板原文怎麼傳進來

介面第 5.2 條要求 `promptTemplateHash = sha256(模板原文)`，但 `generateJson` 的簽名裡只有一個「模板識別名」`template`，沒有欄位可以傳原文（見 `docs/questions2-wsB.md` Q1）。在不動凍結簽名的前提下，本專案的做法是一張註冊表：

```js
const { registerTemplate } = require('../services/llm/templates');

const TEMPLATE = 'extract.v1';
const PROMPT_TEMPLATE = `請細心閱讀這份 PDF …{{CHAPTER_WHITELIST}}…`;   // 可變欄位挖空後的字串
registerTemplate(TEMPLATE, PROMPT_TEMPLATE);
```

- 有註冊 → 用原文雜湊：**模板改一個字，cassette 就失效**，正是第 5.2 條要的。
- 沒註冊 → 退回 `sha256(識別名)` 並印一次警告。那條路較弱（改模板不會自動失效），所以識別名要帶版號，改寫模板時把 `v1` 進到 `v2`。

### 每個節點的 `cacheKeyParts`（凍結，第 5.2 條）

| 節點 | `cacheKeyParts` | 說明 |
|---|---|---|
| `extract` | `{ template, chunkNo, pdfSha256 }` | **不含 PDF 內容**；`pdfSha256` 是整份原檔的雜湊 |
| `classify` | `{ template, questionText, fewShotIds }` | few-shot 是 **id 清單**（已排序）不是全文 |
| `lint` | `{ template, questionText, answerText, issues }` | WS-C |
| `verify` | `{ template, questionText, questionType, sampleNo }` | WS-C；`sampleNo` 讓 uncertain 的第二次採樣有自己的 cassette |

> `JSON.stringify` 依插入順序序列化，所以 agent 每次都要用**相同的鍵順序**組 `cacheKeyParts`（本層不排序，因為第 5.2 條的公式凍結為 `JSON.stringify` 原樣）。

### 檔案格式

```jsonc
{
  "meta":     { "agent", "model", "template", "recorded_at", "fixtureHash" },
  "request":  { "parts": [{"kind":"pdf","bytes":30017,"sha256":"…"}, {"kind":"text","chars":1375,"sha256":"…"}],
                "cacheKeyParts": { … } },
  "response": { "data": {…}, "usage": {tokenIn,tokenOut,tokenThinking,tokenCached}, "latencyMs": 11021 }
}
```

`request` **只存摘要**（字數／位元組數 + sha256）。題幹全文與 PDF base64 一律不寫進 cassette——NOTICE 第 4 條。

### miss 與過期

- **replay miss 一律丟錯**，訊息逐字凍結：
  `LLM_MODE=replay 找不到 cassette（agent=<agent> key=<key>）。請在本機執行 npm run eval:record -- --suite <suite>`
  不會靜默回退成假資料。fork PR 把 miss 降成 warning 是 **CI（WS-D）** 的判斷，不在 `services/llm` 裡。
- `meta.fixtureHash` 與現況的 `eval/fixtures/questions.public.json` 不符時：印一次 warning「few-shot 內容已變，cassette 可能過期」，**仍然回放**。few-shot 的鍵只納入 id 清單，題幹改寫不會改鍵，這個欄位是唯一的提醒管道。

---

## 4. 怎麼錄／怎麼重錄

```powershell
cd exam_pro
node scripts/record_cassettes.js --dry-run              # 先看要錄哪些，不呼叫模型
node scripts/record_cassettes.js --agent extract        # 只錄 extract（1 次呼叫）
node scripts/record_cassettes.js --agent classify --limit 8
node scripts/record_cassettes.js                        # 兩個都錄
npm test                                                # 確認回放正常
```

**只能錄公開素材**（NOTICE 第 4 條）：

| agent | 素材 |
|---|---|
| `extract` | `eval/fixtures/sample_exam.pdf`（六題全部自撰，`node scripts/make_sample_exam_pdf.js` 產生） |
| `classify` | `eval/fixtures/questions.public.json`（60 題公開 fixture） |

真實考卷、私有題庫的回應一律走 `eval/private/cassettes`（`.gitignore` 內），由 `eval/run.js` 在 `--golden` 落在 `eval/private/` 時自動切換（裁決 25）。

### 錄製時的兩個坑

1. **classify 錄製時刻意不接資料庫。** cassette 的鍵含 `fewShotIds`；接了開發庫錄出來的鍵帶著一串題目 id，而 CI 沒有那個資料庫、`fewShotIds` 會是 `[]`，鍵對不上、全部 miss。錄與放兩邊都走 `config/chapterExamples.js` 才對得起來。
2. **免費層是每分鐘 5 次**（2026-08-22 實測，`quotaId=GenerateRequestsPerMinutePerProjectPerModel-FreeTier`、`gemini-3.5-flash`）。`throttle.js` 的預設 `GEMINI_RPM=60` 對這把金鑰太高，錄製腳本會自動壓到 5；手動連續呼叫時請自己設 `GEMINI_RPM=5`。

### 什麼時候必須重錄

| 改了什麼 | 要重錄哪些 |
|---|---|
| `config/chapters.js` 的章節白名單 | **全部**（schemaHash 變） |
| `agents/schemas/*.json` | 該 agent 全部 |
| agent 的 `PROMPT_TEMPLATE` | 該 agent 全部（記得把識別名版號 +1） |
| `MODEL_EXTRACT` / `MODEL_VERIFY` | 該模型的全部 |
| `eval/fixtures/sample_exam.pdf` | `eval/cassettes/extract/**`（`pdfSha256` 變） |
| `eval/fixtures/questions.public.json` 的題幹 | `eval/cassettes/classify/**`（`questionText` 變） |

> ⚠ WS-D 的 `eval/fixtures/make_sample_pdf.js` 合入後會取代 `scripts/make_sample_exam_pdf.js`。
> 只要產出的 PDF 位元組不同，`pdfSha256` 就不同，`eval/cassettes/extract/**` 必須整批重錄。

---

## 5. 出口配額（`services/llm/throttle.js`）

```js
const release = await throttle.acquire('gemini');
try { /* 呼叫 */ } finally { release(); }
```

每個供應商兩個桶：

- **RPM**：滑動 60 秒視窗，上限讀 `<VENDOR>_RPM`（`GEMINI_RPM`…），預設 60。
- **併發**：同時在飛的呼叫數，上限讀 `JOB_CONCURRENCY`，預設 2。RPM 桶只管「一分鐘幾次」，但 N 個 worker 槽可以在同一毫秒送出 N 個請求，供應商看到的是尖峰；併發桶把尖峰壓平。

這一層保護的是**出口**（供應商配額）；`middleware/rateLimit.js` 保護的是**入口**（別人打我的 API）。兩者不共用。
`embed()` 走的是 `gemini.js` 內原本那個 `EMBED_RPM` 桶，與這裡分開——階段 2 不得改動 `embed()` 的既有行為。

---

## 6. 模型與成本

```js
const models = require('./config/models');
models.parseModel('gemini:gemini-3.5-flash');   // → { vendor:'gemini', id:'gemini-3.5-flash', spec }
models.MODEL_EXTRACT;                            // getter，即時讀 process.env
models.warnIfSameModel();                        // 啟動時叫一次
```

`MODEL_VERIFY` 與 `MODEL_EXTRACT` 的**裸 ID 相同**時印警告（同一個模型自己驗自己，會用同一套先驗犯同一個錯）；同家不同級不警告——A-T0 spike 證實免費金鑰用不了 Pro 系列，那是本專案目前做得到的唯一異級驗證（裁決 S0-5）。

```js
const { estimateCost, PRICING } = require('./config/pricing');
estimateCost({ modelId: 'gemini-3.5-flash', tokenIn, tokenOut, tokenThinking, tokenCached });
// → { cost_usd, cost_estimated }
```

- `output` 這一欄同時適用 candidates 與 thinking。
- `cached` 的 token 已含在 `promptTokenCount` 內，`estimateCost` 會先扣掉再以 cached 單價計。
- **`verified_on` 是 null（還沒有人去官網查證）時一律回 `{cost_usd: 0, cost_estimated: false}`**，不猜數字。猜出來的成本會混進報表的加總，之後沒有人分得出哪些是量到的、哪些是掰的。

> 🔴 **人工待辦**：目前 `config/pricing.js` 六個模型全部 `verified_on: null`，所以成本報表現在一律是 0。
> 請到 <https://ai.google.dev/gemini-api/docs/pricing> 查證後把三個單價與查證日期一起填上，成本欄才有意義。

---

## 7. schema 與章節白名單

```js
const { buildSchema, ENUM_SOURCES } = require('./agents/schemas');
const schema = buildSchema('extract');   // 深凍結、模組內快取
```

`agents/schemas/*.json` **不寫 enum 的值**，只寫佔位符：

```jsonc
"chapter": { "type": "string", "x-enum": "chapter" }
```

`buildSchema` 在載入時把它換成 `config/chapters.js` 的實際值。同一份結果同時餵給模型的 structured output 與伺服器端的 `ajv`——**沒有第二份真相**。

- `chapter` 的 enum 是**兩科合併的 66 個**：Gemini 的 schema 不支援「依 subject 切換 enum」，跨科錯配由伺服器端的 `isValidChapter(subject, chapter)` 擋。
- `services/aiService.js` 原本手抄的那份白名單（舊碼 `:14-27`）已在 A-T8 刪除，prompt 的白名單改由 `agents/promptParts.js` 從 `CHAPTERS` 產生。

---

## 8. 新增一個 agent 的最小清單

1. `agents/schemas/<name>.json`：只寫佔位符 `x-enum`，不寫值。
2. `agents/<name>.js`：
   - `registerTemplate('<name>.v1', PROMPT_TEMPLATE)`；
   - 呼叫 `ctx.llm.generateJson({ …, agent:'<name>', template:'<name>.v1', cacheKeyParts:{…} })`；
   - **不得 `require('../config/db')`、不得讀 `process.env`**——全部經 `ctx`（介面第 3.1 條）；
   - **不得 throw**：例外一律包成 `{kind:'error', errorClass}`。
3. 單元測試注入假的 `ctx.llm`，或走 `LLM_MODE=replay` + cassette。
4. 需要真呼叫時，把素材加進 `scripts/record_cassettes.js`，確認它是公開的。
