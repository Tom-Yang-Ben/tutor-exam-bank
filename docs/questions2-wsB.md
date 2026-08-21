# docs/questions2-wsB.md — WS-B（LLM 層與前段 agents）提出的介面問題

> **狀態：十條全部結案**（2026-08-22 第一輪裁決，`docs/interfaces-stage2.md` §12 的 S2-4／5／8／9／10／13／14／15／16／19／25）。
> 分支 `ws2-b/llm-agents`。對應 `docs/interfaces-stage2.md` 第 3、5 條與 `docs/interfaces.md` 第 4 條。
>
> **`docs/interfaces.md` 與 `docs/interfaces-stage2.md` 一個字都沒有改。**
> 以下保留原本的問題陳述與「我暫時怎麼做」，並在每條末尾附上裁決與落地狀況，
> 供之後回頭查「當初為什麼這樣決定」（體例沿用階段 1 的 `docs/questions-wsB.md`）。
>
> 附帶回報的 fixture #47／#54 章節歸屬**仍待開發者本人決定**，見文末。

---

## 🔴 Q1（第 5.1／5.2 條）`generateJson` 沒有欄位可以把「模板原文」傳進來

**條文**：第 5.2 條把 cassette 的鍵定義成

```
key = sha256( agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n' + JSON.stringify(cacheKeyParts) )
```

並註明「`promptTemplateHash` = `sha256(模板原文)`；模板＝把可變欄位挖空後的字串，**由 agent 提供**」。

**問題**：第 5.1 條的簽名裡與模板有關的欄位只有一個，而且註明是識別名：

```js
template           // string，prompt 模板的識別名（記進 cassette 的 meta）
```

識別名（`'classify.v1'`）不是原文。原文沒有欄位可以傳，`services/llm` 就算不出 `sha256(模板原文)`。
另一方面 `cacheKeyParts` 的四組最小集合裡也各有一個 `template` 欄位，看起來同樣是識別名。

**暫行做法**：加一張註冊表 `services/llm/templates.js`。agent 在模組載入時
`registerTemplate('extract.v1', PROMPT_TEMPLATE)`，`services/llm` 依識別名回查原文再雜湊。

- 有註冊 → 語意與「原文直接傳進來」完全相同：模板改一個字，cassette 就失效。
- 沒註冊（例如 WS-C 的 `lint`／`verify` 還沒接上來）→ 退回 `sha256(識別名)` 並印一次警告。那條路較弱，要靠識別名帶版號。

**請裁決**：(a) 就用註冊表（那麼請通知 WS-C 的 `lint`／`verify` 也要 `registerTemplate`）；
(b) `template` 欄位改成可以吃 `{name, text}`；(c) 簽名加第四個選用欄位 `templateText`。
我建議 (a)——它不動凍結簽名，而且 agent 本來就持有模板原文。

> **裁決 S2-5**：採 (a)。模板原文一律走 `services/llm/templates.js` 註冊表，
> `generateJson` 的簽名不動；**四個 LLM 節點（extract／classify／lint／verify）都必須 `registerTemplate`**。
> 已寫進第 5.1 條。
>
> **落地**：`templates.js` 補上裁決明列的 `getTemplate(name)` 匯出（沒註冊過回 `null`）；
> `extract`／`classify` 在模組載入時就註冊，`test/unit/llmGenerateJson.test.js` 加了兩項斷言守住。
> **WS-C 的 `lint`／`verify` 目前還沒註冊**，走的是弱雜湊那條路；它們補上之後四個節點的 cassette 都要重錄一次。

---

## 🔴 Q2（第 3.3 條）classify 的 `input` 沒有 `question_id`，「來源題有向量」這條路走不到

**條文**：第 3.3 條的 classify 列寫

> 第二層：few-shot → LLM；**`FEATURE_SIMILAR` 開且來源題有向量時用 `retrievalService` 取 5 題**

同一列的 `input` 是 `{ subject, chapter, chapter_confidence, question_text }`。

**問題**：`retrievalService.findSimilar(sourceId)` 吃的是 `questions.id`（`interfaces.md` 第 6 條：查詢向量**直接取來源題的 `embedding`**）。
但 classify 跑的時候那一題還在 `job_questions` 裡、還沒進 `questions`，**沒有 id、也沒有向量**。
照字面實作的話這條路永遠不會觸發。

規劃 §4.3.3 講的其實是另一件事：「以**待分類題的 `embed_text`** 查 k=8 最近鄰」——那需要先把新題幹送去 embedding，是一次額外的 API 呼叫，不是讀既有向量。

**暫行做法**：三層 few-shot，取材失敗一律降級不算失敗。

| 層 | 條件 | `few_shot_ids` |
|---|---|---|
| A 向量最近鄰 | `ctx.config.features.FEATURE_SIMILAR` 為真 **且** 有 `ctx.db` → 用 `ctx.llm.embed` 把題幹轉成向量，再對 `questions` 做 `ORDER BY embedding <=> $1` 取 5 題 | 鄰居的 id |
| B 各章取例 | 有 `ctx.db` → 一句 SQL，每章取 2 題（`chapter_src IN ('human','ai')`，不取 `'knn'`） | 例題的 id |
| C 自製例句 | 永遠執行，補上 A/B 沒涵蓋到的章 | 無（不進清單） |

**兩個附帶問題**：

1. **`ctx` 裡沒有旗標。** 第 3.1 條的 `ctx.config` 只有 `models` / `limits` / `thresholds`，而 agent「不得自己讀 `process.env`」。
   我暫時讀 `ctx.config.features.FEATURE_SIMILAR`（沒有這個鍵時當成關閉，直接走 B/C）。**請 WS-A 的 runner 把 `features` 放進 `ctx.config`**，或裁決改用別的方式。
2. **A 層與 cassette 天生不相容。** 鍵含 `fewShotIds`；在有開發庫的機器上錄出來的鍵帶著一串 id，CI 沒有那個庫、`fewShotIds` 會是 `[]`，鍵對不上、全部 miss。
   所以 `scripts/record_cassettes.js` **刻意不接資料庫**。真的要讓 A 層進 eval，需要 WS-D 在 CI 裡把 fixture 題灌進測試庫並保證 id 穩定。

> **裁決 S2-8**：三層 few-shot 的設計照收；`ctx.config.features = { similar, pipeline }` 由 runner
> 從 `config/features.js` 組出來，agent 只能從這裡讀旗標。**錄 cassette 與跑 eval 一律 `ctx.db = null`**
> （`fewShotIds` 才可重現）。已寫進第 3.1、3.3 條。
>
> **落地**：`fewShotByVector` 的判斷由 `features.FEATURE_SIMILAR` 改成 **`features.similar === true`**（凍結的鍵名）；
> 舊的大寫鍵名不再算數，`test/unit/agentClassify.test.js` 兩項新測試分別守住「旗標關閉不下向量查詢」
> 與「旗標開啟時 `few_shot_ids` 是鄰居 id」。`input` 仍然沒有 `question_id`，所以 A 層走的是
> 「`ctx.llm.embed` 把題幹轉向量再查 `questions`」，不是 `retrievalService.findSimilar`。

---

## Q3（第 3.1 條 vs 裁決 S0-4）「超過 inlineData 門檻要丟 Error」與「agent 不得 throw」衝突

**條文**：

- 裁決 S0-4：`agents/extract.js` 「可以只寫『超過門檻就丟 `Error('PDF 超過 inlineData 門檻，Files API 路徑尚未啟用')`』」。
- 第 3.1 條：agent「**不得 throw**（例外由 runner 包成 `{kind:'error', errorClass:'provider_error'}`，但 agent 自己應該先分類成更精確的 errorClass）」。

**問題**：照 S0-4 丟 Error 的話，runner 會把它當成供應商錯誤，退避重試三次（1s→2s→4s）才進複核。
但「PDF 太大」是**確定性**的：重試三次結果一定一樣，只是白白多花 7 秒與三列 `job_events`。

**暫行做法**：回 `{ kind:'fail', reason:'provider_error', feedback:'PDF 超過 inlineData 門檻，Files API 路徑尚未啟用' }`。
`extract` 的 `maxRetries` 是 0，所以會直接落到 `needs_review('provider_error')`——沒有無謂的退避，凍結的那句話原封不動留在 `feedback` 裡。

**請裁決**：可以的話請把 S0-4 的「丟 Error」改寫成「回 `fail('provider_error')`」，或指定另一個 `reason`。

> **裁決 S2-9**：接受。S0-4 的「丟 `Error`」改寫成「回 `fail('provider_error')`」，agent 不 throw 的規則優先。
>
> **落地**：實作本來就是這樣，這一輪只確認措辭；凍結的那句
> 「PDF 超過 inlineData 門檻，Files API 路徑尚未啟用」原封留在 `outcome.feedback` 裡。

---

## Q4（第 3.2／3.3 條）`payload.extract.idx` 到底是誰算的

**條文**：第 3.2 條的 `payload.extract.idx` 是「`chunk_no * 1000 + 題序`」；規劃 §3.3.4 的 extract 輸出範例裡，`idx` 是**模型回的欄位**之一。

**問題**：模型編的題號會跳號（考卷本來就有「第 1 題、第 2 題…」以外的編法）、會重號（同一大題的 (1)(2)(3)），
而 `job_questions` 有 `UNIQUE (job_id, idx)`——一撞就整批進不去。

**暫行做法**：`idx = chunk_no * 1000 + 元素在陣列中的位置 + 1`，**由 agent 算，不用模型給的**。
`agents/schemas/extract.json` 仍留一個**選用**的 `idx` 欄位（`additionalProperties: false` 之下，模型若自願輸出 `idx` 而 schema 沒有這個鍵，整筆會被 ajv 打掉——留著比較安全），但系統不採用它的值。
`outcome.data.rejected[].idx` 用同一套算法，所以被丟掉的那一題也有穩定的編號可以回報。

> **裁決 S2-10**：`idx` 由 agent 算，`chunk_no * 1000 + 元素在陣列中的位置 + 1`，不用模型給的題號；
> `outcome.data.rejected[].idx` 同一套算法。已寫進第 3.1 條。
>
> **落地**：實作與測試都已符合。`agents/schemas/extract.json` 保留選用的 `idx` 欄位
> （`additionalProperties: false` 之下，模型自願輸出而 schema 沒有這個鍵的話整筆會被 ajv 打掉）。

---

## Q5（第 5.1 條）回傳物件多了一個 `schemaFallback` 鍵

第 0.1 條要求「schema 退路啟用時在 `job_events.detail` 記 `{schema_fallback:true}`」，但寫 `job_events` 的是 runner，
而知道「這次有沒有走退路」的是 `services/llm`。第 5.1 條的回傳形狀 `{data, usage, latencyMs, raw}` 裡沒有這個資訊。

**暫行做法**：回傳物件多帶一個布林 `schemaFallback`（純新增，既有解構寫法不受影響）。
`extract` 會把它放進 `outcome.data.schema_fallback` 傳給 runner。**請 WS-A 在寫 `job_events` 時讀這個欄位。**

> **裁決 S2-4**：接受。`generateJson` 的回傳形狀正式加上 `schemaFallback`（第 5.1 條），
> runner 寫進 `job_events.detail.schema_fallback`。
>
> **落地**：`extract` 已把它放進 `outcome.data.schema_fallback`；WS-A 的 runner 依此讀取。

---

## Q6（第 5.2 條）replay miss 的訊息裡 `<suite>` 沒有值可以填

凍結的訊息是：

```
LLM_MODE=replay 找不到 cassette（agent=<agent> key=<key>）。請在本機執行 npm run eval:record -- --suite <suite>
```

`<agent>` 與 `<key>` 顯然是要代換的，但 `<suite>`（eval 的 suite 名）`services/llm` 不知道——簽名裡沒有這個資訊，
而且同一個 agent 可能出現在多個 suite 裡。

**暫行做法**：`<suite>` 保持字面不代換（讀訊息的人自己填），並在後面多接一行 `（預期路徑：…）` 幫忙定位。
前半段仍與凍結字串逐字相同，WS-D 若要在 CI 比對訊息，請只比對到 `--suite ` 為止。

> **裁決 S2-14**：接受。`<suite>` 由 `services/llm` 保持字面不代換（它不知道 suite 名），
> 後面可另接一行預期路徑；**CI 比對訊息只比到 `--suite ` 為止**。已寫進第 5.2 條。

---

## Q7（第 10.1 條）三個「所有權表上沒有」但我建了的檔案

| 檔案 | 為什麼 | 建議歸屬 |
|---|---|---|
| `services/llm/cassette.js`、`templates.js` | `services/llm/*` 明列給 WS-B，這兩支在範圍內，只是介面文件沒點名 | WS-B |
| `agents/promptParts.js` | 章節／題型白名單的 prompt 片段，`extract` 與 `classify` 共用；不想在兩個 agent 裡各抄一份 | WS-B（名字刻意取得不會與 WS-C 撞） |
| `scripts/make_sample_exam_pdf.js`、`scripts/record_cassettes.js` | 分工提示詞明講「先用 pdfkit 在 `scripts/` 造一份 6 題的自製 PDF」；錄製腳本則是 `docs/llm.md` 的操作入口 | WS-B（WS-D 的 `eval/fixtures/make_sample_pdf.js` 合入後，前者退場） |


> **裁決 S2-25／S2-15**：`cassette.js`／`templates.js`／`promptParts.js`／`record_cassettes.js` 四支歸 WS-B，
> 已列進第 10.1 條的所有權表；`scripts/make_sample_exam_pdf.js` 依 S2-15 退場。
> 另依 **S2-19** 新增 `services/legacy/analyzePdf.js`（A-T8 之前的 `aiService.js` 快照）也歸 WS-B。
>
> **落地**：`scripts/make_sample_exam_pdf.js` 已刪除；`scripts/record_cassettes.js` 改讀 WS-D 的樣卷
> （`eval/fixtures/sample_exam.pdf`，`sha256 f1a15d77…`，10 題）；
> `services/legacy/analyzePdf.js` 以 `git show e1740ca:exam_pro/services/aiService.js` 逐字複製並只加檔頭註解，
> `eval/lib/legacyAdapter.js` 現在解析到 `kind: 'snapshot'`、`model: gemini-2.5-flash`、零 warning。

---

## Q8（`.gitignore`，S0 的檔案）`*.pdf` 擋住了公開 fixture PDF

根目錄 `.gitignore` 第 37 行 `*.pdf` 會把 `exam_pro/eval/fixtures/sample_exam.pdf` 一起擋掉。
這份 PDF 是**自製的公開素材**，必須進版控（CI 要靠它跑 extract 的 replay）。

**暫行做法**：`git add -f` 加進來（已在版控內，之後的修改追蹤正常）。

**請 S0 補一條放行**（`.gitignore` 是 S0 的檔案，WS-B 不直接改）：

```gitignore
# 公開的自製考卷 fixture（extract 的 cassette 要靠它；真實考卷仍被上面的 *.pdf 擋住）
!exam_pro/eval/fixtures/*.pdf
```

> **裁決 S2-15**：接受，根 `.gitignore` 已加 `!exam_pro/eval/fixtures/*.pdf`。
>
> **落地**：樣卷改以 WS-D 的版本為準（S2-15 同一條）。WS-B 舊樣卷的那支 extract cassette
> 因為 `pdfSha256` 已變成孤兒，**一併刪除**——`eval/cassettes/` 裡不該留放不出來的檔案。
> 重錄要等 WS-C 的 `registerTemplate`（S2-5）與 `buildSchema` 切換（S2-24）合入，
> 否則模板與 schema 一改鍵又全變，等於白錄一次。

---

## Q9（第 9 條）`GEMINI_RPM` 沒有列進環境變數表，而且免費層的實際上限是 5

第 5.3 條說「上限來源：`GEMINI_RPM`（沿用既有的 `EMBED_RPM` 概念但獨立變數，**WS-B 需要時在 PR 描述提出**）」，
但第 9 條的變數表裡沒有這一列。

**實測（2026-08-22，錄 cassette 時）**：免費層對 `gemini-3.5-flash` 的 `generateContent` 是
**每分鐘 5 次**（`quotaId=GenerateRequestsPerMinutePerProjectPerModel-FreeTier`、`quotaValue: "5"`），
不是 embedding 那邊的 60。連續錄 8 題時第 4 題就撞 429，靠退避 1s→2s→4s→8s 才過。

**暫行做法**：`throttle.js` 的預設維持 60（與 `EMBED_RPM` 的慣例一致），
但 `scripts/record_cassettes.js` 會自動把 `GEMINI_RPM` 壓到 5。

**請裁決**：把 `GEMINI_RPM=5` 寫進 `.env.example` 與第 9 條的變數表（開通付費後再放寬）。
一個「預設值就是錯的」旗標遲早會咬人——現在只是慢，之後 `JOB_CONCURRENCY` 一開大就會變成整批 429。

> **裁決 S2-16**：接受。`GEMINI_RPM=5` 已寫進 `.env.example` 與第 9 條的變數表。
>
> **落地**：`throttle.js` 的程式內建預設維持 60（與 `EMBED_RPM` 的慣例一致，且開通付費後不必改碼），
> 實際值由 `.env` 的 5 決定；`scripts/record_cassettes.js` 在沒設時仍會自己壓到 5。

---

## Q10（`test/unit/` 的所有權）我改了 WS-C／WS-D 的一項既有測試

`test/unit/llmEmbed.test.js:123` 原本斷言

```js
await assert.rejects(() => generateJson({ parts: [{ text: 'hi' }] }), /階段 2/);
```

那句「屬階段 2、尚未實作」的錯誤訊息正是 A-T3 要換掉的東西，實作完之後這一項必然紅燈。

**暫行做法**：只改斷言的正規表示式（改成 `/agent 是必填/`——replay 模式缺 `agent` 就算不出 cassette 鍵），
測試的本意「不會偷偷呼叫 Gemini」完全不變，其餘一個字沒動。
新增的四支測試檔（`llmGenerateJson`／`agentExtract`／`agentClassify`／`cassetteReplay`）都是新檔，沒有動到別人的檔案。

> **裁決 S2-25／S2-2**：接受這次改動；並定下通則——各 WS 可以在 `test/unit`／`test/integration`
> **新增自己的測試檔，但不得改別人的**（S2-2）。改別人既有斷言這種事，以後要像這次一樣先寫進 questions 再動。

---

## 附帶回報：兩題分類與公開 fixture 標註不一致（**仍待開發者本人定案**）

錄 classify 的 cassette 時，8 題裡有 2 題模型的答案與 `eval/fixtures/questions.public.json` 的標註不同。
兩題都不是模型亂答，而是**白名單本身有兩章重疊**，建議在 golden 定案時一併裁決：

| fixture | 標註 | 模型（信心） | 我的看法 |
|---|---|---|---|
| #47 | `直線運動`（選修物理一） | `物體的運動（速度與加速度）`（1.0） | 等加速直線運動在必修與選修各有一章，題幹分不出年級 |
| #54 | `電場與電位`（選修物理四） | `靜電學`（1.0） | 點電荷的庫侖力／電場題兩章都說得通 |

其餘 6 題模型與標註完全一致（含 `空間向量內積` 對 `向量內積` 這種容易混的配對）。

> **裁決（§12 末列）**：兩題的章節歸屬由開發者本人決定，**尚未定案**。
> 在定案之前，這兩題在 `--suite classify` 會一直算成錯——那是誠實的：
> 分不出來的不是模型，是白名單。定案之後若改的是 `questions.public.json` 的標註，
> `questionText` 沒動、classify 的 cassette 不受影響（鍵不含標註）；
> 若改的是題幹本身，那兩支 cassette 要重錄。
