# docs/questions-wsD.md —— WS-D（評估與 CI）對凍結介面的提問

> 規則：`docs/interfaces.md` 不得由各 workstream 修改。實作時發現介面有問題就寫在這裡，
> 由開發者本人裁決後統一改 `interfaces.md` 並通知四條 WS。
>
> 以下每一條我都已經在 WS-D 這邊選了一個**可以繼續往下做**的讀法，並寫進註解與測試；
> 但只要 WS-C 的實作選了另一個讀法，D-R2 的三欄對照就會量到錯的東西，
> 所以這些讀法必須被確認，不能靠默契。

---

## Q1（會影響 D-R2）第 5 條：`buildHybridQuery` 的 `queryTokens` 傳空陣列時，回的是「純向量結果」還是「空結果」？

**背景。** 分工文件要求「向量與 hybrid 欄直接對 PG 下 `queries/hybrid.js`，不經 HTTP」，
但第 5 條的 `mode` 只有 `'rrf'|'weighted'`，**沒有 vector-only 模式**。

**WS-D 目前的做法。** 把 `queryTokens: []` 傳進去當作純向量欄：
第 5 條已經規定「`queryTokens` 為空陣列時，關鍵字側必須安全地回空集合」，
此時 `rrf` 的 `score = 1/(60+vec_rank) + 0`，排序即純向量順序。
這樣「向量」與「hybrid」兩欄共用同一段 SQL 與同一組候選條件，
兩欄的差異就只剩融合本身；另寫一句 `ORDER BY embedding <=> $1`
會讓差異裡混進候選集不同造成的假差異。

**風險。** 如果 WS-C 的實作把「`queryTokens` 為空」理解成「整個查詢回空集合」
（而不是「只有關鍵字側是空集合」），純向量欄會全部變成 0，
而且**不會報錯**——報表上只會看到向量欄突然很難看。

**請裁決：** 確認第 5 條的「關鍵字側回空集合」= 只有關鍵字那一側，
`FULL OUTER JOIN` 之後仍保留向量側的全部候選。若要更明確，建議在第 5 條補一句：
> `queryTokens` 為 `[]` 時，結果等同純向量排序（`kw_rank` 全為 `null`）。

---

## Q2（會影響 D-R2 的 Jaccard 斷言）第 2 條：`search_tsv` 到底是從哪一段文字分詞來的？

**背景。** 第 2 條說「寫入端自己以 `to_tsvector('simple', array_to_string($n::text[], ' '))` 組」，
但**沒有說 `$n` 那個 `text[]` 是對哪一段文字 `tokenize()` 的結果**——
是 `question_text`，還是 `embed_text`（含第 1 行的「學科｜章節｜題型｜難度」）？

**WS-D 目前的做法。** 假設是 `embed_text`：
`eval/lib/pgEngine.js` 灌 fixture 時寫 `tokenize(buildEmbedText(q))`，
`eval/lib/ranker.js` 的記憶體關鍵字側也對 `buildEmbedText(q)` 分詞，兩邊一致。

**為什麼這個選擇有實質差別。** `embed_text` 含章節名，代表**同章的題會因為章節詞而互相命中**。
這會讓關鍵字側在同章內的區辨力下降、但跨章的排除力上升——
正好是 fixture 裡「向量內積 vs 空間向量內積」那組對照要量的東西。
換成 `question_text` 兩邊數字都會變。

**風險。** WS-C 的 `embedService` 若選了另一段文字，
`test/integration/retrievalEval.test.js` 的 Jaccard 會掉到 0.9 以下並轉紅，
而紅燈的原因會看起來像「排序器寫錯」，其實是兩邊對同一句規格的理解不同。

**請裁決：** 在第 2 條補一句寫明 `search_tsv` 的來源文字。
WS-D 建議 `embed_text`（與向量側同源，「寫入、查詢、eval 三處一致」才真的成立）。

---

## Q3（不影響正確性，只是規劃文字與現實不符）`npm test` 的 `node --test test/unit/`

規劃 §1.5 裁決 5 與分工文件都寫 `npm test` = `node --test test/unit/`。
實測 Node 24.15 傳目錄會 `MODULE_NOT_FOUND`：
Node 22/24 的 `--test` 位置參數是 **glob pattern**，不是目錄
（官方文件的跨平台建議寫法是加引號的 glob）。

WS-D 已改用 `node --test "test/unit/**/*.test.js"`，行為與原意相同（只跑單元層），
Node 22 與 24 都可用。這一條只是**知會**，不需要改 `interfaces.md`（它沒提 npm scripts）。

---

## Q4（知會）階段 2 才會用到的 `EVAL_CASSETTE_DIR`

私有層防呆（規劃 §5.3.2）要求「`--golden` 落在 `eval/private/` 時強制
`--cassette-dir eval/private/cassettes`」。`eval/run.js` 目前以
`process.env.EVAL_CASSETTE_DIR` 傳遞這個決定。

階段 1 的 retrieval suite 不呼叫 LLM，所以還沒有人讀它；
階段 2 接上 classify／formula suite 時，`services/llm/` 的 replay adapter 需要讀這個變數。
屆時要不要把它列進 `.env.example`（還是維持「只由 `run.js` 在行程內設定」），請一併裁決。
