# docs/questions3-wsC.md — WS-C（自然語言查題）在階段 3 遇到的介面問題

> 分支 `ws3-c/nlq`，對應 `docs/interfaces-stage3.md` 第 6、8.2 條與規劃 §4.3.4。
> 依第 14 條第 7 點：**發現問題就停下來寫在這裡並在回報中明講，不自行改介面繞過。**
> 三份 `interfaces*.md` 一個字都沒有動過。
>
> 每一題都寫了「我這一版怎麼做」——那是為了讓 WS-C 能交付，不是既成事實。
> 開發者本人裁決之後，如果與我的做法不同，改的是 `services/nlqService.js` 與
> `utils/nlqHeuristics.js`（都在 WS-C 的所有權範圍內），不會動到別人的檔。

---

## 1.（**最重要**）`semantic_text` 的定義：第 6.1 條的文字與第 6／8.4 條的兩個範例互相矛盾

**第 6.1 條**把 `semantic_text` 定義成：

> `semantic_text: string   // 扣掉已被規則吃掉的片段後剩下的文字（去頭尾空白）`

而同一條的 `keywords` 又寫「被規則吃掉的**實詞**（章節別名原文、題型）」——也就是說
**章節別名原文算是「被吃掉的」**。

但第 6 條開頭的回應範例與第 8.4 條的 golden 範例，對同一句話給的預期值是：

```jsonc
"query": "牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過"
"semantic_text": "牛頓第二定律 摩擦力"
```

照第 6.1 條的字面做，別名被吃掉之後剩下的是「加」「的」，`semantic_text` 會是「加 的」；
要得到範例裡的「牛頓第二定律 摩擦力」，別名原文就**必須留在** `semantic_text` 裡。
兩個獨立的範例都指向後者，只有那一行散文指向前者。

這不只是字面之爭：`semantic_text` 是第 6.5 條拿去 `embed()` 的查詢字串。
照字面做的話，**規則抓得越準，向量側能查的東西就越少**——
「牛頓第二定律加摩擦力的計算題」會用「加 的」去做向量檢索。那顯然不是這個欄位的用意。

**我這一版怎麼做**：以兩個範例為準。`utils/nlqHeuristics.js` 把每個字元標成三種之一——
概念詞（章節本名／別名）、被吃掉的條件詞（難度／題型／學生）、自由文字；
`semantic_text` ＝「概念詞原文保留 ＋ 條件詞整段拿掉 ＋ 自由文字剝掉頭尾虛詞」，
非空片段以單一空白連接。第 6 條與第 8.4 條的兩個範例都逐字重現（有單元測試釘住）。

**請裁決**：第 6.1 條那一行散文要不要改寫成與範例一致？（不用改介面檔也行，
在這裡回一句「以範例為準」我就把它寫進 `nlqHeuristics.js` 的檔頭當依據。）

---

## 2. `buildHybridQuery` 沒有 `question_type` 參數，但第 6 條的 `filters` 有 `question_types`

`interfaces.md` 第 5 條的 `buildHybridQuery(opts)` 只吃
`subject / chapter / difficultyMin / difficultyMax / excludeStudentId / excludeIds /
queryVector / queryTokens / mode / sides / limit`——**沒有題型**。
而第 6.6 條的 level 2 又寫「仍 0 筆再丟掉難度**與題型**」，顯然假設題型是有作用的。

那一段 SQL 是凍結的，我沒有改它。三個可選做法：

| 做法 | 問題 |
|---|---|
| (a) hybrid 拿回來之後再依題型過濾 | `limit` 的語意壞掉：要 20 題可能只剩 3 題 |
| (b) 把「題型不對的題」算成 `excludeIds` 傳進去 | 多一句 metadata 查詢；候選集大的時候陣列會變長 |
| (c) 幫 `buildHybridQuery` 加一個 `questionTypes` 參數 | **要改凍結介面**，不做 |

**我這一版怎麼做**：(b)。排除集的查詢限縮在**同一次查詢的 subject／chapter／難度區間**內，
所以它不會大到有意義的程度（`services/nlqService.js` 的 `excludedByType()`）。
題型因此是**精確**篩選，`limit` 的語意也不變。整合測試釘住了這件事。

**請裁決**：(b) 可以就不用動；若之後 WS-C 有理由要 (c)，那是階段 4 再開 `interfaces` 的事。

---

## 3. body 的 `student_id` 與句子裡解析出的「某某沒寫過」撞在一起時，誰優先？

第 6 條的參數表定義了 `student_id`（`int > 0`），第 6.5 條又說
「`excludeStudentId` = 解析出的學生 id（`exclude_student_name` 查得到時）」，
但**兩個同時存在時誰贏**沒有寫。

**我這一版怎麼做**：句子裡指名的優先（那是使用者當下明確講的），
沒指名時才用 body 帶進來的 `student_id`。
理由：前端的查題框多半會把「目前在看的學生」自動帶進 body，
如果 body 贏，使用者打「小華沒寫過」會被無聲地換成別人，而回應裡看不出來。

**請裁決**：或者兩個都排除（取聯集）？那要 `buildHybridQuery` 支援多個
`excludeStudentId`，一樣會動到凍結介面，所以我沒有走這條。

---

## 4. `--suite nlq` 的 LLM 欄在 cassette 錄好之前一定是 replay miss —— **請 WS-D 先不要接進 CI**

第 8.5 條寫「CI 不連外：nlq 的 LLM 層一律 `LLM_MODE=replay` 讀 `eval/cassettes/nlq/`」。
但那個目錄現在是空的，而錄製需要 `GEMINI_API_KEY`（WS-C 這邊沒有金鑰、也不該有）。

`eval/golden/nlq.json` 的 50 句裡有 8 句是 `expect_path='llm'`（規則一定抓不到章節），
跑起來就是 8 筆 replay miss，`eval/run.js` 的 `runStage2Suite` 會 `process.exitCode = 1`。

順帶一提：第 6.3 條要求 nlqService **逾時／schema 不合／供應商錯誤一律不 throw**。
對端點是對的，但對 eval 是致命的——一支 cassette 都沒錄的時候，
8 句會安靜地變成 `parse_path='llm_failed'`，報表上看起來是「LLM 路徑正確率 0%」，
其實是「一次都沒真的問過」。`eval/lib/suiteNlq.js` 因此用一個 `capturingLlm` 包裝把
`generateJson` 的錯誤攔下來交給 `replayMiss` 判斷，錯誤原文**原樣**推進 `failures`
（裁決 S2-14 的前綴比對）。replay miss 只讓 **llm 欄** n/a，rules 欄照常有數字。

**給 WS-D 的具體請求**：`ci.yml` 先只加 `--suite variant`，或把 `--suite nlq` 那一步
標成 `continue-on-error: true`，等開發者本人在本機同時開 `LLM_MODE=record` 與
`EMBED_MODE=record` 跑過一次、cassette 與查詢向量都錄好之後再轉成必跑（裁決 S3-20）。

---

## 5. 第 6.4 條的六個步驟照字面順序做會自相矛盾（小問題，我自行處理了）

第 6.4 條第 1 點是「`chapters` **逐一**過 `isValidChapter(subject, chapter)`」，
第 6 點是「`subject` 為 null 且 `chapters` 非空時，由第一個章節反推 `subject`」。

照 1→6 的順序做的話：`subject` 是 null 時，第 1 點會讓 `isValidChapter(null, x)` 對每一章
都回 false，全部被丟掉並各加一則 warning，第 6 點就沒有章節可以反推了。
兩點的意圖顯然是「先反推再驗」。

**我這一版怎麼做**：先反推 `subject`（第 6 點），再逐一驗章節（第 1 點）。
其餘四點照原順序。`services/nlqService.js` 的 `validateFilters()` 有註解說明。
**不需要裁決**，寫在這裡只是留紀錄。

---

## 6. `keywords` 要不要含題型？（很小，兩邊都不影響分數）

第 6.1 條散文：「`keywords` = 被規則吃掉的實詞（章節別名原文、**題型**）」。
但第 6 條開頭的範例對「…的計算題」給的是 `keywords: ["牛頓第二定律", "摩擦力"]`，
沒有「計算」。

`keywords` 不在 `filters_exact` 的四欄裡，golden 的 `expect` 也沒有這個欄位，
所以它不影響任何數字，只影響前端顯示。

**我這一版怎麼做**：照散文，含題型（`["牛頓第二定律","摩擦力","計算"]`）。
**請 WS-D 確認**前端的 chip 顯示要不要含題型；要改是 `nlqHeuristics.js` 的一行。

---

## 7. level 3 的 LIKE：第 6.6 條寫的是單一 `$n`，但 `semantic_text` 是以空白分段的

第 6.6 條 level 3：

> 退回 `listQuestions` 的 `LIKE`：在 metadata 篩選後的候選上
> `question_text ILIKE '%' || $n || '%'`

`semantic_text` 是「牛頓第二定律 摩擦力」這種以空白分段的字串，
單一 ILIKE 會一題都比不到。而且更根本的問題是：**題幹幾乎不會逐字出現章節名**，
所以對「向量內積的填空題」這種最常見的查詢，level 3 的 ILIKE 恆為 0 筆。
（`eval:nlq` 量到的 `recall10_like_only` 是 **0.04**，就是這個原因。）

**我這一版怎麼做**，兩點：

1. 對 `semantic_text` 的每一段各下一個 ILIKE 再 `OR` 起來（最多 5 段）。
   只有一段時就退化成第 6.6 條寫的那一句，所以這是它的推廣而不是取代。
2. **LIKE 的放寬順序與 hybrid 不同**：第一段 0 筆時先丟掉 ILIKE 這個條件、
   留下 metadata 篩選（＝`listQuestions` 帶著解析出來的 subject／chapter／難度／題型
   的那張清單），再不行才丟章節。照 hybrid 的順序先丟章節，只會從
   「一題都沒有」變成「範圍更大的一題都沒有」。

第 6.6 條 level 3 的原話就是「**退回 `listQuestions`**」，我認為 2. 比較接近那句話的意思，
但它確實不是逐字照做，所以寫在這裡。整合測試把兩種情形都釘住了。

**請裁決**：這樣可以嗎？

---

## 8. 前端相關（我不能改 `public/**`，寫給 WS-D）

- `results` 的 `score` 在 `fallback_level=3` 時**一律是 `null`**（第 6.6 條），
  前端不要拿它去算百分比或排序條，那一欄要顯示成「—」。
- 跨章／跨科合併的 `score` 是**各自查詢內**的 RRF 分數，**不是全域可比的**（第 6.5 條明寫）。
  兩題的 `score` 大小關係在 `chapters.length >= 2` 或 `subject` 為 null 時沒有意義。
- `warnings` 是給人看的完整句子，直接列出來即可；`fallback_level` 適合做成一個 chip
  （0 不顯示、1「AI 解析降級」、2「已放寬條件」、3「關鍵字模式」）。
- `filters` 的八個鍵一律出現，可以直接拿去回寫下拉；`keywords` 目前含題型（見第 6 題）。

---

## 9. 沒有新環境變數

第 9 條列的 `MODEL_NLQ`（預設 `gemini:gemini-3.5-flash`）、`NLQ_TIMEOUT_MS`（4000）、
`FEATURE_NLQ`（false）S0 都已經寫進 `.env.example` 了，WS-C **沒有**再需要任何新變數。
`EMBED_FIXTURE_DIR` 是階段 1 就有的，整合測試用它把向量 fixture 指到暫存目錄。
