# docs/questions-wsD.md —— WS-D（評估與 CI）對凍結介面的提問

> 規則：`docs/interfaces.md` 不得由各 workstream 修改。實作時發現介面有問題就寫在這裡，
> 由開發者本人裁決後統一改 `interfaces.md` 並通知四條 WS。
>
> **狀態：四則全部已裁決並結案（2026-08-21 第一輪裁決）。**
> 裁決內容見 `docs/interfaces.md` §1.6 第 18、21、24、25 條；本檔保留提問全文，
> 是為了讓「為什麼介面長這樣」有跡可循——只看結論會看不出當初的岔路在哪裡。

---

## Q1（會影響 D-R2）第 5 條：`buildHybridQuery` 的 `queryTokens` 傳空陣列時，回的是「純向量結果」還是「空結果」？

**背景。** 分工文件要求「向量與 hybrid 欄直接對 `queries/hybrid.js` 下，不經 HTTP」，
但第 5 條的 `mode` 只有 `'rrf'|'weighted'`，**沒有 vector-only 模式**。

**WS-D 當時的做法。** 把 `queryTokens: []` 傳進去當作純向量欄，
靠「關鍵字側回空集合 → `rrf` 分數退化成 `1/(60+vec_rank)`」得到純向量順序。

**風險。** 如果實作把「`queryTokens` 為空」理解成「整個查詢回空集合」，
純向量欄會全部變成 0，而且**不會報錯**——報表上只會看到向量欄突然很難看。

> **裁決（interfaces §1.6 第 18 條，落地於第 5 條）：**
> `buildHybridQuery` 新增選用參數 `sides?: ('vec'|'kw')[]`，預設 `['vec','kw']`；
> `/similar` 的 `mode=vector` 傳 `['vec']`、`mode=keyword` 傳 `['kw']`，
> 只含 `'kw'` 時 `queryVector` 可為 `null`。
>
> **WS-D 已照辦**：`eval/lib/pgEngine.js` 的 `search()` 接受 `sides` 並原樣轉給
> `buildHybridQuery`；`eval/run.js` 與 `test/integration/retrievalEval.test.js` 的純向量欄
> 改傳 `sides:['vec']`，不再靠空 `queryTokens`。理由寫進了 `pgEngine.js` 的檔頭：
> 空 `queryTokens` 只保證關鍵字側是空的，並沒有保證整段 SQL 走成純向量路徑，
> 而 `/similar` 的 `mode=vector` 走的是 `sides:['vec']`——eval 要量的是 prod 走的那一條。

---

## Q2（會影響 D-R2 的 Jaccard 斷言）第 2 條：`search_tsv` 到底是從哪一段文字分詞來的？

**背景。** 第 2 條說「寫入端自己以 `to_tsvector('simple', array_to_string($n::text[], ' '))` 組」，
但**沒有說 `$n` 那個 `text[]` 是對哪一段文字 `tokenize()` 的結果**——
是 `question_text`，還是 `embed_text`（含第 1 行的「學科｜章節｜題型｜難度」）？

**風險。** 兩邊對同一句規格理解不同時，`retrievalEval.test.js` 的 Jaccard 會掉到 0.9 以下轉紅，
而紅燈的原因會看起來像「排序器寫錯」。

> **裁決（interfaces §1.6 第 21 條，落地於第 2 條）：**
> `search_tsv` 由 `services/embedService.js` 統一組裝，分三段加權——
> **章節名 `A`、`keywords` `A`、`embed_text` 第 2 行起（題幹 + concept_summary）`B`**；
> 三段 token 的產生是 `embedService` 匯出的純函式 `buildTsvTokens()`，
> **寫入、回填、eval 的 `pgEngine` 三處都只能呼叫它**。
>
> **WS-D 已照辦**，而且範圍比裁決字面更大一點——`pgEngine` 與記憶體排序器**兩邊**都改：
> - `eval/lib/pgEngine.js` 的 `seedFixture()` 改呼叫 `buildTsvTokens()`，
>   並照 `embedService.UPDATE_SQL` 用 `setweight(...,'A') || setweight(...,'A') || setweight(...,'B')` 寫入；
>   `tokenizeFn` 這個參數一併移除，免得留一條「自己分詞」的後門。
> - `eval/lib/ranker.js` 的 `rankKeyword()` 也改用 `buildTsvTokens()`，
>   並套上 `ts_rank` 的預設權重（`A=1.0`、`B=0.4`）。只改 `pgEngine` 而不改記憶體排序器的話，
>   Jaccard 斷言就會因為「對照組沒跟上」而假性轉紅——**對照組落後於被測方，是最難查的那種紅燈**。
> - 另外把 eval 的**查詢詞**也對齊 `services/retrievalService.js` 的 `queryTokensForSource()`：
>   取權重 `A` 的兩段（章節 + `keywords`），沒有才退回題幹（`ranker.queryTokensFor()`）。
>   這一點裁決沒有明講，是 WS-D 依「eval 必須量 prod 的查詢路徑」自行推的——
>   若與 WS-C 的意圖不同請指正，這是本輪唯一的自由心證。
>
> 驗證：三者到位後，40 筆 golden 的 **SQL 對記憶體排序器 Jaccard 全部 = 1.0000**。

---

## Q3（不影響正確性，只是規劃文字與現實不符）`npm test` 的 `node --test test/unit/`

規劃 §1.5 裁決 5 與分工文件都寫 `npm test` = `node --test test/unit/`。
實測 Node 24.15 傳目錄會 `MODULE_NOT_FOUND`：Node 22/24 的 `--test` 位置參數是
**glob pattern**，不是目錄（官方文件的跨平台建議寫法是加引號的 glob）。

> **裁決（interfaces §1.6 第 24 條）：**
> `npm test` 用 `node --test "test/unit/**/*.test.js"`；規劃裡「`node --test test/unit/`」的寫法作廢。
> WS-A 的 A-Q5、WS-C 的 C-8 提的是同一件事，一併併入本條。
>
> **WS-D 已照辦**（第一個 PR 就是這樣寫的，無須再改）。

---

## Q4（知會）階段 2 才會用到的 `EVAL_CASSETTE_DIR`

私有層防呆（規劃 §5.3.2）要求「`--golden` 落在 `eval/private/` 時強制
`--cassette-dir eval/private/cassettes`」。`eval/run.js` 以 `process.env.EVAL_CASSETTE_DIR` 傳遞這個決定。
階段 1 的 retrieval suite 不呼叫 LLM，所以還沒有人讀它。

> **裁決（interfaces §1.6 第 25 條）：**
> 階段 2 再裁；目前**只由 `eval/run.js` 在行程內設定**，不進 `.env.example`。
>
> **WS-D 已照辦**（維持現狀）。階段 2 接上 classify／formula suite 時，
> `services/llm/` 的 replay adapter 需要讀它，屆時再決定要不要外顯成環境變數。

---

## 本輪之後 WS-D 這邊沒有新的介面疑問

第一輪合併後的四項小修（interfaces §12.5 的 D 列）已全數完成，明細見 PR 說明。
