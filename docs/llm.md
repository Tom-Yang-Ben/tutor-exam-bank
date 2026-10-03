# docs/llm.md — LLM 層操作手冊（`services/llm/`）

> 擁有者：WS-B（階段 2，A-T3／A-T8／A-T9）。
> 契約：`docs/interfaces-stage2.md` 第 3、5 條與 `docs/interfaces-stage1.md` 第 4 條。**這兩份是凍結介面，本檔不覆蓋它們**；有出入時以介面文件為準，並把問題寫進 `docs/archive/questions2-wsB.md`。

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
- embedding 是另一組旗標（`EMBED_MODE = live | record | fixture`），兩者互不影響（`docs/interfaces-stage1.md` 第 4 條）。

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
    thinkingBudget,    // 選用；thinkingConfig.thinkingBudget（0=關閉、-1=自動）。thinking 模型的
                       // 思考 token 計入 maxOutputTokens 額度，兩者要一起調（見下方第 6 點）
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
5. 供應商有 `gemini` 與 `ollama`（〔修訂 2026-09-26〕本機模式，2026-09-25 起為預設；轉接層 `services/llm/ollama.js`，回傳形狀與 `gemini.js` 相同，契約與裁決見 [`docs/local-mode.md`](local-mode.md) 第 3 條與 LM-1、LM-10）。`anthropic` / `openai` 給 A-T17 預留，現在傳進去會直接丟錯（不是靜默改用 gemini）。
6. **`maxOutputTokens` 的額度包含思考 token**。對 thinking 模型（Pro 系列）只設 `maxOutputTokens`
   而不設 `thinkingBudget`，難題的思考會把額度吃光，JSON 寫到一半被截斷——症狀是
   「Unterminated string in JSON」被歸類成 `schema_invalid`，退避重試把整份任務拖慢數倍
   （2026-08-27 job #4 實測：verify 節點 37 次錯誤、平均 93 秒）。`agents/verify.js` 因此
   固定成對設定 `maxOutputTokens: 8192` + `thinkingBudget: 1024`。`thinkingBudget` **不進**
   cassette 鍵（第 3 節的 `cacheKeyParts` 不含它），調整它不會讓既有 cassette 失效。

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

介面第 5.2 條要求 `promptTemplateHash = sha256(模板原文)`，但 `generateJson` 的簽名裡只有一個「模板識別名」`template`，沒有欄位可以傳原文。**裁決 S2-5**：走 `services/llm/templates.js` 這張註冊表，簽名不動。

```js
const { registerTemplate, getTemplate } = require('../services/llm/templates');

const TEMPLATE = 'extract.v2';   // 2026-09-15 起（v1→v2 新增【表格】規範）
const PROMPT_TEMPLATE = `請細心閱讀這份 PDF …{{CHAPTER_WHITELIST}}…`;   // 可變欄位挖空後的字串
registerTemplate(TEMPLATE, PROMPT_TEMPLATE);      // 模組載入時就註冊
getTemplate(TEMPLATE);                            // 取回原文；沒註冊過回 null
```

- 有註冊 → 用原文雜湊：**模板改一個字，cassette 就失效**，正是第 5.2 條要的。
- 沒註冊 → 退回 `sha256(識別名)` 並印一次警告。那條路較弱（改模板不會自動失效），所以識別名要帶版號，改寫模板時把 `v1` 進到 `v2`。

> **四個 LLM 節點（`extract`／`classify`／`lint`／`verify`）都必須 `registerTemplate`**（S2-5）。
> 2026-08-22 現況：`extract`／`classify`（WS-B）已註冊；`lint`／`verify`（WS-C）尚未——
> 它們目前走的是弱雜湊那條路。WS-C 補上之後，四個節點的 cassette 都必須重錄一次（鍵會變）。

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
  〔2026-09-27，`dec/r8-b1-abandon`〕前綴不變，之後改成依模式指向正確的重錄方式（原本寫的 `npm run eval:record` 只錄向量）：本機模式指向 Owner 電腦上的 `scripts\windows\record_local.bat <suite>`（＝`npm run cassettes:rerecord -- --suites <suite>`，重錄步驟見 `docs/local-mode.md` 的重錄計畫一節），Gemini 模式指向 `npm run cassettes:rerecord -- --suites <suite>`（要金鑰、會產生費用；〔`dec/r8-b1-abandon-fix`〕它照 ci.yml 的模型錄，所以訊息註明「ci.yml 的模型要是 Gemini」）。完整字句與比對標記見 `docs/interfaces-stage2.md` 第 5.2 條。
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
| `extract` | `eval/fixtures/sample_exam.pdf` —— **WS-D 的樣卷**（10 題，`node eval/fixtures/make_sample_pdf.js` 從 `questions.public.json` 挑題排版）。裁決 S2-15 定它為唯一的樣卷，WS-B 原本的 `scripts/make_sample_exam_pdf.js` 已退場 |
| `classify` | `eval/fixtures/questions.public.json`（62 題公開 fixture） |

真實考卷、私有題庫的回應一律走 `eval/private/cassettes`（`.gitignore` 內），由 `eval/run.js` 在 `--golden` 落在 `eval/private/` 時自動切換（裁決 25）。

另外兩個 suite 也會錄（WS-D 的 `eval/run.js`，同樣只吃公開素材）：

```powershell
node scripts/record_cassettes.js --agent all                       # extract 1 次 + classify 8 題
LLM_MODE=record GEMINI_RPM=5 node eval/run.js --suite classify     # 92 筆 golden，約 18 分鐘
LLM_MODE=record GEMINI_RPM=5 node eval/run.js --suite pipeline     # 樣卷 10 題走 extract/classify/lint/verify
```

（PowerShell 沒有行內 `VAR=x` 語法：請先在該視窗 `$env:LLM_MODE='record'; $env:GEMINI_RPM='5'`，或把兩個值寫進 `.env`。）
錄完 `git add eval/cassettes`，再把 `LLM_MODE` 切回 `replay` 確認三個 suite 全綠。

### 錄製時的兩個坑

1. **classify 錄製時刻意不接資料庫。** cassette 的鍵含 `fewShotIds`；接了開發庫錄出來的鍵帶著一串題目 id，而 CI 沒有那個資料庫、`fewShotIds` 會是 `[]`，鍵對不上、全部 miss。錄與放兩邊都走 `config/chapterExamples.js` 才對得起來。
2. **免費層是每分鐘 5 次**（2026-08-22 實測，`quotaId=GenerateRequestsPerMinutePerProjectPerModel-FreeTier`、`gemini-3.5-flash`）。`throttle.js` 的預設 `GEMINI_RPM=60` 對這把金鑰太高，錄製腳本會自動壓到 5；手動連續呼叫時請自己設 `GEMINI_RPM=5`。

### 什麼時候必須重錄

| 改了什麼 | 要重錄哪些 |
|---|---|
| `config/chapters.js` 的章節白名單 | **全部**（schemaHash 變） |
| `agents/schemas/*.json` | 該 agent 全部 |
| agent 的 `PROMPT_TEMPLATE` | 該 agent 全部（記得把識別名版號 +1） |
| 分類的例句（`config/chapterExamples.js`）或界線規則（`agents/classify.js` 的 `SUBJECT_RULES`，只有數學、物理有） | 數學或物理的例句／界線規則改了 → **數學＋物理**的 classify 全部（兩科共用同一個識別名 `classify.vN`：只改數學的一句，物理的 cassette 也跟著失效）；化學的例句改了 → `classify_chem` 全部（數學、物理不受影響）。鍵只含模板原文（界線規則是挖空後才填進去的）、題幹與 few-shot 的 id，不含例句與規則的文字〔整合 2026-09-26 註：「界線規則挖空後才填、鍵不含規則文字」是 `dec/r2-classify-explog2` 當時的狀態；自 `dec/r2-classify-explog3` 起規則已併進註冊的模板、會進鍵（見本格末段），現在不進鍵的只剩例句〕，所以**一定要把識別名的版號 +1**（`classify.vN` 或 `classify_chem.vN`）；不升版的話，回放拿到的是舊例句、舊規則錄的答案〔整合 2026-09-26 註：規則的部分現在是回放 miss、不會拿到舊答案，見本格末段；例句的部分照舊〕（〔CR-9〕，`docs/chapter-restructure.md` 第 8 條）。〔重練與收尾決策單 2026-09-26〕界線規則已併進註冊的模板文字（`agents/classify.js` 的 `REGISTERED_TEMPLATE`＝`PROMPT_TEMPLATE + '\n---\n' + JSON.stringify(SUBJECT_RULES)`）：改規則鍵會自己變，回放是 miss，不會拿到舊答案；仍照慣例把 `classify.vN` 的版號 +1（單元測試把規則雜湊與版號一起釘住）。例句仍不進鍵，上面的說明對例句照舊成立 |
| `MODEL_EXTRACT` / `MODEL_VERIFY` | 該模型的全部 |
| `eval/fixtures/sample_exam.pdf` | `eval/cassettes/extract/**`（`pdfSha256` 變） |
| `eval/fixtures/questions.public.json` 的題幹 | `eval/cassettes/classify/**`（`questionText` 變） |

> **2026-08-22 現況**：樣卷已依裁決 S2-15 換成 WS-D 的版本（`sha256 f1a15d77…`），
> 原本對 WS-B 舊樣卷錄的那支 extract cassette 已成孤兒並刪除。
> `test/unit/cassetteReplay.test.js` 的 extract 那一組會**自動 skip 並印出原因**——
> 它會依現行樣卷算出預期的鍵再檢查檔案在不在，所以重錄完就自動恢復執行，不必改測試。
> 重錄的時機：**等 WS-C 的 `registerTemplate`（S2-5）與 `buildSchema` 切換（S2-24）合入**——
> 模板原文與 schema 任何一個變動都會換鍵，先錄會白錄一次。

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

〔dec/r13-engine-choice〕上傳考卷、AI 家教、助教可以逐次選「本機／Gemini」：選的與 `.env` 不同時，模型改由 `config/engines.js` 的 `modelsForEngine` 決定（`GEMINI_MODEL_EXTRACT`／`GEMINI_MODEL_VERIFY`、`LOCAL_MODEL_*`，沒寫就是 `GEMINI_DEFAULTS`／本機預設）；`EMBED_MODEL` 一律不換。沒選或相同時照上面的 getter，cassette 的鍵不變。說明見 [`local-mode.md`](local-mode.md) 的「拆題與助教可選本機或 Gemini」一節。

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
   - **不得 throw**：例外一律包成 `{kind:'error', errorClass}`；
   - 旗標只能從 `ctx.config.features`（`{similar, pipeline}`）讀，runner 會組好（裁決 S2-8）。
3. 單元測試注入假的 `ctx.llm`，或走 `LLM_MODE=replay` + cassette。
4. 需要真呼叫時，把素材加進 `scripts/record_cassettes.js`，確認它是公開的。

---

## 9. `services/legacy/analyzePdf.js` —— 舊流程的凍結快照

`eval/compare_pipeline.js --method legacy` 要量的是「A-T8 之前的舊流程」。但 `services/aiService.js`
在 A-T8 之後已經是新 extract agent 的相容包裝——直接呼叫它，`legacy` 那一欄量到的其實是新管線，
而且**兩欄數字會神奇地靠攏，沒有任何東西會報錯**。

因此裁決 S2-19：把舊版原封快照成 `services/legacy/analyzePdf.js`（`git show e1740ca:exam_pro/services/aiService.js`），
歸 WS-B。`eval/lib/legacyAdapter.js` 會優先找它，找不到才退回 `aiService.js` 並大聲警告。

**不要改它。** 它刻意保留了三個舊版特徵，那些正是對照實驗要呈現的差異：

| 舊版特徵 | 現行 `aiService.js` |
|---|---|
| 模型 ID 寫死 `gemini-2.5-flash` | 讀 `MODEL_EXTRACT` |
| prompt 裡手抄一份章節白名單（指紋「【數學科精細章節白名單】」） | 由 `config/chapters.js` 產生，只有一份真相 |
| 只設 `responseMimeType`、沒有 schema，結尾直接 `JSON.parse` | `responseJsonSchema` + 伺服器端 `ajv` 逐元素驗證 |

改 prompt 會連帶改掉 `legacyAdapter` 算出來的 `prompt_hash`，之前跑過的基準線就對不起來了。

---

## 10. LaTeX 反斜線被 JSON 跳脫吃掉的修復（`services/llm/latexEscapeRepair.js`，2026-09-26，`dec/latex-escape-repair`）

### 症狀

模型在 JSON 字串裡寫 LaTeX 時常常只寫一個反斜線。JSON 的合法跳脫 `\b \f \n \r \t` 剛好是五個 LaTeX 指令的開頭字母，
`JSON.parse` 不會報錯，而是把它們變成控制字元：

| 模型寫的 | `JSON.parse` 之後 | Word 匯出（`stripUnsafe`）看到的 |
|---|---|---|
| `\frac{1}{2}` | 換頁（U+000C）＋`rac{1}{2}` | 換頁被刪掉 → `rac12` |
| `\times`、`\theta`、`\tan`、`\text` | 定位（U+0009）＋`imes`… | 定位當空白 → ` imes` |
| `\beta`、`\bar`、`\boldsymbol`、`\bullet` | 退格（U+0008）＋`eta`… | 退格被刪掉 → `eta` |
| `\rho`、`\right`、`\rightarrow` | 歸位（U+000D）＋`ho`… | 歸位變成換行，公式被切成兩行 |
| `\neq`、`\nu`、`\nabla` | 換行＋`eq`… | 公式被切成兩行 |

`parseLatexStrict` 看不出「`rac`」是壞掉的 `\frac`，公式閘門（`agents/lint.js` 的 `formulaFix`＋`formulaLint`）照樣放行：
2026-09-25 的本機 cassette 裡，variant 60 支有 49 支帶這種字元，其中 **38 支帶著壞公式通過了公式閘門**。

另一種變形是 Ollama 的 JSON 文法約束造成的：模型想寫 `\circ`，但 `\c` 不是合法跳脫，文法只允許 `b f n r t u " \ /`，
模型被迫先吐一個合法字母再照原意寫完——解析後是「歸位＋`circ`」。

### 修在哪裡

`services/llm/index.js` 的 `generateJson`，**解析完 JSON 之後、交給 agent 之前**。三個模式、兩個供應商都套用：

| 模式 | 行為 |
|---|---|
| `live` | Ollama／Gemini 回來的 `data` 修過才交給 agent |
| `record` | agent 拿到修過的；**cassette 存模型的原始回應（修復前）**，`raw` 也不動 |
| `replay` | 讀出來的原始回應修過才交給 agent——既有 cassette 不必重錄就吃得到修復 |

- cassette 的鍵公式一個字都沒動（第 3 節）；修復只動回傳的 `data`，不動請求。
- 有修到或有救不回來的時候，回傳物件多一個 `latexRepair: { repaired, commands: {frac: 3, …}, unresolved: [{path, at, char, letters, reason}] }`；什麼都沒碰時回傳物件與之前逐位元相同（沒有這個鍵）。
- `generateText` 不經 `JSON.parse`，不套用。

### 規則

對 `data` 裡每一個字串值（物件的鍵不動），找「控制字元 C（`\b \f \n \r \t`）＋一串英文字母 W（取到最長）」，L 是 C 的跳脫字母：

- **規則 A**：L＋W 是已知指令（換頁＋`rac` → `frac`）→ 換成 `\`＋L＋W。
- **規則 B**：L＋W 不是、但 W 本身是已知指令（歸位＋`circ` → `circ`，Ollama 文法換掉字母的情形）→ 換成 `\`＋W。只在公式裡、不用在換行上。

什麼時候才修（真的換行、真的定位不能誤改）：

| 控制字元 | 在公式裡（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`、結尾沒關的 `$` 之後） | 公式外 |
|---|---|---|
| 退格、換頁、歸位 | 修 | 規則 A 照修：這三個字元在模型輸出的文字裡沒有正當用途（Windows 換行是 `\r\n`，歸位後面接的是換行不是字母，碰不到） |
| 定位 | 修 | 只有一種樣子不修：W 只有一兩個字母、而且後面緊接空白、另一個沒被修的控制字元或字串結尾（「定位＋`an` 空白」「定位＋`o` 空白」跟真的定位＋英文單字分不開，所以公式外接空白的 `\tan`、`\to`、`\tau`、`\top` 不修）。其餘都修：W 至少三個字母，或後面緊接 `{ ( [ ^ _ \`、數字、中文、標點（「夾角`\theta`為銳角」「`3\times4=12`」「`\tan45°`」） |
| 換行 | W 至少兩個字母（`\neq`、`\nabla`、`\norm`）修。W 只有一個字母（`\nu`、`\ne`、`\ni`）跟「換行＋變數 u、e、i」分不開，只在**行內公式**裡、而且 (1) 公式片段裡沒有 `\begin`、`&`、`\\` 這種多行結構，(2) 換行前一個字元是空白、公式開頭的 `$` 或 `\(`、左括號 `( [ {`、或 `^ _`，兩條都成立才修；行內公式裡不合的列進 `unresolved`（`ambiguous_newline`），展示公式與沒關的 `$` 裡不修也不列 | **一律不修** |

- 控制字元前面緊接反斜線：**數連續反斜線的個數**。奇數個＝最後一個反斜線沒有配對，意思不明，不修（退格／換頁／歸位與公式裡的定位列 `after_backslash`）。偶數個＝前面是完整的換列 `\\`，控制字元本身沒有被跳脫：退格／換頁／歸位／定位照一般規則修（`cases`、`aligned`、矩陣換列後直接接壞掉的 `\theta`、`\frac`）；換行不修（「`\\`＋換行」是換列的標準寫法）。
- Windows 換行 `\r\n` 的換行後面接字母：真的換行，不修。
- **公式區段的配對有兩種看法，兩種都說在公式裡才算公式**（公式裡才放寬的規則——定位的短指令名、換行、規則 B——都是在放寬，所以取嚴的）：
  - 跨行配對：`$` 一路配下去。行內公式真的寫成兩行時是對的；某一行的 `$` 沒關時，會把下一行的文字配進公式（「甲：`$x = 1`＋換行＋乙：`$y$` 與`\neq` 無關」的「與`\neq`」）。
  - 逐行配對：單一 `$` 與 `\(…\)` 不跨越「一定是真的換行」，跟 `formulaLint`、Word 匯出的看法一樣；只有「可能是被吃掉的 `\n`」的換行（後面的字母湊得成 `n` 開頭的指令）不算斷行——要判斷的正是它。`$` 配錯對時是對的；行內公式真的寫成兩行時，第二行的奇偶會反過來。
  - `$$…$$`、`\[…\]` 兩種看法都跨行。種類不同時取嚴的（一個說行內、一個說沒關 → 算沒關）。
- **一次修完（冪等）**：候選由右往左決定。「定位＋`an`」後面緊接的若是另一個會被修的候選（`\tan\theta`、`\tan\frac`），它後面實際接的是修好之後的反斜線、不是原字串裡的控制字元，由右往左才看得到。修過的再修一次一個字都不變：單元測試除了 cassette 之外，還用固定種子的隨機字串 10 萬筆驗證（連在一起的候選超過 2 萬筆），並確認修復只動「控制字元＋字母」那一段。
- **已知的殘留風險**（規則分不開，選擇接受）：行內公式真的在空白之後換行、下一行以 u、e、i 開頭（「`$f(x) = `＋換行＋`e^{x}$`」，等號後面多一個空白）仍會被修成 `\ne`；公式外「定位＋`an`／`o`＋空白」仍不修也不列。前者要「行內公式真的跨行」＋「行尾多一個空白」＋「下一行是單一字母變數」三件事同時發生，錄到的資料裡一次都沒有；要完全避開只能連 `$\nu = 0.2$` 這種真的壞掉的也不修（審查的另一個建議：單一字母一律不修），代價是 `\nu`、`\ne`、`\ni` 永遠留著換行。

### 指令表從哪裡來

**從解析器產生，不手抄**：`utils/textFormatter.js` 新匯出 `supportedCommandNames()`＝對照表（`GREEK`、`SYMBOLS`、`FUNCTIONS`、`ACCENTS`、`EXTRA_SYMBOLS`、`STRETCH_ARROWS`）的鍵＋`PARSER_COMMANDS`（`parseCommand` 以 `name === '…'` 特判的名字）。
`test/unit/latexEscapeRepair.test.js` 掃 `parseCommand` 的原始碼：新增一個 `name === '…'` 特判或一張新的對照表卻沒進清單，測試就紅燈；清單裡每個名字也都真的解析一次，確認不發 `unknown_command`。
解析器之後多認得一個指令，修復的指令表自動跟上。

另外加了一份 `UNSUPPORTED_LATEX_COMMANDS`（`\bullet`、`\textbf`、`\big`、`\bigg`、`\norm`、`\root`——本機 cassette 實際出現的——與 `\binom`、`\boxed`、`\not`、`\textit` 等同樣開頭的常見寫法）：
這些是真的 LaTeX（或 amssymb、KaTeX）指令、但解析器不支援。還原它們不會讓 Word 變好，但會讓公式閘門**看得到**（`unknown_command`，交給 lint 重寫）；不還原的話，`ullet`、`extbf{…}` 這種壞字會安靜地通過閘門。

漏列一個名字的後果（`dec/latex-escape-repair-fix` 審查時實測）：退格／換頁／歸位開頭的只會列進 `unresolved`，控制字元被 `stripUnsafe` 刪掉後留下「`ot`」「`m{a}`」「`igcup`」，**安靜地通過閘門**；換行開頭的（`\nsubseteq`）在行內公式裡不修也不列。
所以依審查意見補齊了 b f n r t 開頭、高中數理會用到的寫法：`\bot` `\top` `\bm` `\bf` `\rm` `\bmod` `\bigcup` `\bigcap` `\breve` `\nmid` `\nsubseteq` `\ncong` `\nexists` `\nparallel` `\triangleq` `\textdegree` `\textcircled` `\texttt` `\textsf` `\rbrace` `\rvert` `\tbinom` `\newline`，
以及同類的否定關係與箭頭（`\nless` `\nsupseteq` `\nRightarrow`…）、大型運算子（`\bigvee` `\bigwedge`…）、文字模式（`\textnormal` `\textup`…）、三角形（`\triangleleft`…）。全部清單見程式碼；測試逐一確認它們還原後會發 `unknown_command`。
清單之外的名字仍會安靜通過——這是下面「沒有做」第 1 項要處理的。

### 救不回來的

後面的字母湊不成任何指令時不猜，原樣保留、列進 `latexRepair.unresolved`：

- 本機：換頁＋`dg`（`$240^\fdg$`，variant 3 支共 29 處、classify 1 處）；Gemini：歸位＋`d`（`$850^\rd$`，variant 1 支 13 處）。原意多半是度數 `^\circ`，但被文法換掉的字母與剩下的字母對不上任何指令，補一個 `\circ` 是猜的。
- `\u` 開頭的（`\underline`、`\uparrow`、`\upsilon`）：`\u` 後面必須是四個十六進位數字，寫錯時 `JSON.parse` 直接丟錯（走 `schema_invalid`），寫成合法的四位數就變成別的字，事後分不出原意。
- 行內公式裡意思不明的單一字母換行（`ambiguous_newline`）：「`$f(x) =`＋換行＋`e^{x}$`」「`\begin{vmatrix}`＋換行＋`i & j & k`」——可能是 `\ne`、`\ni`，也可能是真的換行＋變數，不猜。

`unresolved` 的 `reason`：`no_command`（湊不成指令）、`after_backslash`（前面是奇數個反斜線）、`ambiguous_newline`（上一條）。

### 回歸：repo 內的 cassette 修回後怎麼變

`test/unit/latexEscapeRepair.test.js` 逐支釘住（這一批 cassette 重錄或清除後該組自動略過）。「帶控制字元」＝字串裡有換行以外的 C0 控制字元。

| cassette | 支數 | 帶控制字元：修前 → 修後 | 修了幾處 | 剩下的 |
|---|---:|---|---:|---|
| 本機 variant（qwen3:8b，f77d1a3） | 60 | 49 → 3 | 386 | 換頁＋`dg` |
| 本機 classify | 92 | 10 → 1 | 30（全在 `rationale`，章節不受影響） | 換頁＋`dg` |
| 本機 verify | 20 | 1 → 0 | 5 | — |
| Gemini variant（gemini-3.1-pro-preview） | 87 | 11 → 1 | 35 | 歸位＋`d` |
| Gemini verify | 58 | 1 → 0 | 2 | — |
| Gemini extract（gemini-3.5-flash） | 1 | 1 → 0 | 3 | — |

真的換行一個都沒少：本機這一批只修了 7 處「換行＋指令」（`\neq` 4、`\norm` 2、`\nu` 1，全在行內公式裡）；Gemini 那一批的換行修前修後相同。
**這個數字守不到誤改的風險**：repo 裡全部 529 支 cassette 的真換行（215 處）都在公式外、後面都不是英文字母，公式裡的換行只有修掉的這 7 處——
「多行的行內公式」「`$` 配錯對」在錄到的資料裡一次都沒出現，所以這兩種誤改只有合成的單元測試在守（第 6 組）。

`dec/latex-escape-repair-fix`（依審查意見修正）之後，上面兩張表與下面的 eval 數字**一個都沒變**：新舊規則對 repo 內全部 529 支 cassette 的輸出逐字相同（修復處數、`unresolved` 也相同）。
審查指出的四類問題（公式外連在一起的指令、換列後的控制字元、多行行內公式與 `$` 配錯對、漏列的指令與公式外定位）在錄到的資料裡都沒有出現。

**公式閘門**（variant 的題幹＋答案走 `agents/lint.js` 的 `gate`）：

| | 通過／擋下 | 帶壞公式卻通過 |
|---|---|---|
| 本機 variant 修前 | 49／11 | 38 |
| 本機 variant 修後 | 47／13 | 3（就是剩下「換頁＋`dg`」那 3 支） |
| Gemini variant 修前 → 修後 | 86／1 → 86／1 | 10 → 0 |

- 4 支由通過變擋下（`288f5abc`、`42633f8b`、`578ea572`、`fc040873`）：還原出來的 `\bullet`／`\textbf` 解析器不支援，閘門第一次看得到它們（之前 Word 會印出「ullet」「extbf」）。實際跑的時候會進 lint 的第三層請模型重寫。
- 2 支由擋下變通過（`8144b7b7`、`f241efa6`）：歸位＋`circ` 還原成 `\circ`，原本被切斷的公式恢復正常。

**只改字閘門**（`utils/variantTextGate.js`）：壞掉的 `\times`／`\theta` 讓 5 支本機變式看起來跟藍本差很多，其實是「只換數字」或「只改一個字」；修回後正確擋下（`numbers_only` 2 支、`too_close` 3 支）。

### 對 eval 回放的影響（2026-09-26 實測，CI 的本機模型設定）

| suite | 修前 | 修後 | 原因 |
|---|---|---|---|
| `eval:variant` | `retrieved_coverage` 0.2333、`gate_pass_rate` n/a（replay miss 2、缺向量 1） | `retrieved_coverage` 0.2333、`gate_pass_rate` n/a（replay miss 2、**缺向量 29**） | 變式題幹修好之後是新字串：向量檔以 `sha256(embed_text)` 查，錄的時候算的是壞字串，29 次生成在跑題檢查就查不到向量而停下。下游的 verify／lint cassette 鍵也含題幹，同樣對不上。replay miss 的 2 次與本修正無關（那 2 次生成本來就沒有 cassette）。另有 2 題（var-016、var-029）改停在只改字閘門——就是上面那 5 支「只換數字」的變式被正確擋下 |
| `eval:classify` | 92／92 replay miss，n/a | 相同 | golden 走 `classify.v2`，本機 cassette 是 `classify.v1`，一支都讀不到；修復碰不到它（而且 classify 修到的只有 `rationale`） |
| `eval:pipeline`、`eval:nlq`、e2e | 缺 `extract_vision`／nlq 的 cassette | 相同 | 修復碰不到 |
| `eval:retrieval` | 通過 | 相同 | 不呼叫 LLM |

也就是：**分數欄都沒有變**（紅的照紅、n/a 照 n/a），但 variant 這一輪能量到的部分變少了。這不是修復的副作用可以避開的：
下游的向量與 cassette 是對著壞字串錄的，題幹一修好就對不上。要讓 variant 重新量得到，照 `docs/local-mode.md` 10.7 **整步重錄 variant**
（`scripts\windows\record_local.bat variant`，上次 17292 秒）。只補向量（10.7 第 8 點的 `LLM_MODE=replay`、`EMBED_MODE=record`）不夠：
verify 與 lint 的 cassette 鍵含題幹，還是會 replay miss。重錄時 cassette 照樣存模型的原始回應，回放時由本層修。

### 沒有做、留給之後決定的

1. **公式閘門擋下殘留的控制字元**（`dec/latex-escape-repair-fix` 依審查意見提到第一順位）：「換頁＋`dg`」這種救不回來的，以及**指令表漏列的任何名字**（審查實測：補齊之前的 `\bot`、`\bm`、`\bigcup`），現在仍會安靜地通過 `formulaLint`（`stripUnsafe` 把控制字元刪掉，解析器看不出來）。
   補指令表只能一個一個補，這一條才是兜底：不管修復層認不認得，只要題幹裡還有換行以外的控制字元就擋下交給 lint 重寫。
   要擋就是在 `formulaLint` 的 `ISSUE_RULES` 後面加一條新規則。以 repo 內的 cassette 估：本機 variant 修後 47／13 → 44／16（剩下「換頁＋`dg`」那 3 支改成擋下）；Gemini variant 86／1 不變（剩下那支本來就被擋）。
   沒有在修正分支裡直接做：這是閘門的政策（新 rule 名一旦定案就會進 `job_events.detail` 與 `report:jobs`、不能再改；本機模式下每擋一支就多一次 lint 重寫的時間），由老師決定。
   〔Owner 2026-09-27 選 L-1＝1〕已落實於 `dec/r6-gates`：rule 名 `control_char`；實測本機 47／13 → 44／16、Gemini 86／1 不變（與 L-3 一起是 50／10）；詳見 [`local-mode.md`](local-mode.md) 10.18 第 1 點。
2. **prompt 要求模型在 JSON 裡把反斜線寫兩次**：從源頭減少（尤其 `\circ`、`\cdot`、`\sqrt` 這種會被文法換字母、事後救不回來的）。改 prompt ＝ 模板雜湊變 ＝ 對應 agent 的 cassette 全部重錄。
   〔Owner 第五輪 L-2，2026-09-27 選 1〕已落實於 `dec/r6-templates`：`agents/promptParts.js` 的 `LATEX_RULES` 加第 (5) 條、`CHEM_LATEX_RULES` 加第 (6) 條（同一段，附正反例）；用到它們的 8 個模板全部升版（`extract.v3`、`extract_chem.v2`、`extract_vision.v2`、`extract_vision_chem.v2`、`extract_ocr.v2`、`extract_ocr_chem.v2`、`variant.v2`、`variant_chem.v2`）。本層的修復保留當第二道防線；模型照做（JSON 原文兩個反斜線、解析後一個）時修復是 no-op，`test/unit/r6Templates.test.js` 以規則裡的正例、假 Ollama／Gemini 回應與 repo 內全部 cassette 驗證。見 [`local-mode.md`](local-mode.md)「第五輪 A 模板與 schema（2026-09-27）」一節。
3. **解析器支援 `\bullet`、`\textbf`**：上面 4 支由通過變擋下的就會回到通過（`\bullet` 的原意多半是內積的點或度數，不一定該照字面排）。要加在 `EXTRA_SYMBOLS` 這類只給 Word 匯出用的表，不要加進 `SYMBOLS`（會改到既有題目的 `embed_text`）。
   〔Owner 2026-09-27 選 L-3＝1〕已落實於 `dec/r6-gates`：`\bullet` 進 `EXTRA_SYMBOLS`（U+2219）、`\textbf` 是 `parseCommand` 特判，`UNSUPPORTED_LATEX_COMMANDS` 移出這兩個；既有題目的 `embed_text` 不變（有測試）。實測回到通過的是 6 支（上面 4 支，加上修復前就被擋的 `7bdc13c6`、`c55a3ee6`）；詳見 [`local-mode.md`](local-mode.md) 10.18 第 2 點。
4. **`latexRepair` 摘要還沒進 `job_events`**：現在只在 `generateJson` 的回傳物件上，runner 沒有記。要追蹤「哪個模型、哪個節點最常被修」時再接。
