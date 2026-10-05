# docs/remedial.md — 出題閉環：依弱點出補救卷、跨章配額、知識點弱點、題庫覆蓋率

> 產出者：WS-D（階段 5，分支 `stage5/ws-d`）。缺口 G04、G10；需求 DEC-016（待 Owner 簽核）。
> 介面以 `docs/interfaces-stage5.md` 第 4.4 條為準（凍結）；本檔寫的是實作的選題規則、設計取捨與給老師的操作說明，
> 整合階段據此回填 api_spec、openapi、srs 等共用文件（契約第 1.7 條）。
> 工程取捨的決策紀錄：ADR-014。

---

## 1. 一句話

**弱點面板看完，按一下就有下一份卷的草稿；草稿看得懂為什麼選這些題，確認前一個位元組都不寫。**

- 弱點以 **Wilson 下界**排序：1 題對 1 題不等於精熟，樣本少的單位會被當成「還不確定」優先處理。
- 單位優先用**知識點**；有知識點標註的已批改題不夠時，自動退回**章節**。
- 選題與組卷**同一段程式碼**：候選池 SQL、家族互斥、承上題整組全部沿用 `generate-paper`，不另寫一套。
- 老師確認沿用既有的 `POST /api/confirm-paper`，Word 下載沿用既有的 `POST /api/download-word`。

---

## 2. API

五支。2.1、2.2、2.4、2.5 掛在 `FEATURE_REMEDIAL` 之後（關閉時不掛載，請求落到 Express 預設 404）；
2.3 的 `blueprint` 是既有 `POST /api/generate-paper` 的擴充，**不吃旗標**（它不呼叫 LLM，是組卷核心功能的延伸）。
五支都不呼叫 LLM，掛在旗標後的四支不寫資料庫，所以沒有套限流（契約第 1.2 條的限流針對會花錢的端點）。
2.5 是契約之外多的一支（理由見第 6 節）。
〔dec/r16-remedial〕2.2 的回應多了錯因（補救組 `blueprint` 列的 `error_focus`，第 9 節）與目標快照（`targets`，第 10.2 節）；
另有第六支 `GET /api/students/:id/remedial-effect`（補救成效，第 10.3 節），同樣在 `FEATURE_REMEDIAL` 之後、只讀、不呼叫 LLM。
第七支 `POST /api/students/:id/remedial-paper/fill-shortfall`（題庫不夠時自動補題，第 11 節）另需 `FEATURE_VARIANTS`，會建變式 job，所以有限流。

### 2.1 `GET /api/students/:id/weakness/kc?days=&subject=`

```json
{
  "rows": [
    { "kc_id": 12, "code": "MATH.向量內積.02", "name": "內積的坐標算法", "subject": "數學", "chapter": "向量內積",
      "graded": 1.5, "correct": 1.25, "correct_rate": 0.8333, "mastery_lb": 0.1969, "low_sample": true }
  ],
  "untagged_graded": 4
}
```

| 欄位 | 定義 |
|---|---|
| `graded` | 時間窗內、已批改（`result IS NOT NULL`）且掛了這個知識點的題，**依 `question_kcs.weight` 加權**的總和；可能是小數 |
| `correct` | 同上，每題乘上正確度 `COALESCE(score, result)`（部分給分優先） |
| `correct_rate` | `correct ÷ graded`，四捨五入到小數第 4 位；`graded = 0` 時為 `null` |
| `mastery_lb` | 正確率的 Wilson 下界（z = 1.96），第 4 位；`graded = 0` 時為 `null`（沒資料不等於 0 分） |
| `low_sample` | `graded < WEAKNESS_MIN_N`（沿用章節弱點面板的設定，預設 5；含 `graded = 0`） |
| `untagged_graded` | 時間窗內已批改、但該題**沒有任何**知識點標註的題數 |

- 排序：`mastery_lb` 由低到高（`null` 排最後）→ `graded` 由多到少 → `code`。
- 列出的是「時間窗內至少有一筆作答（含未批改）掛到它」的知識點。
- 時間窗、科目篩選、參數規則與 `GET /api/students/:id/weakness` 相同：`days` 1–365（預設 90）、`subject` 在白名單內；
  不排除已封存題（歷史紀錄不因封存消失，裁決 S3-2）。
- 錯誤：`:id` 不是正整數或學生不存在 → 404 `找不到該學生`；`subject`／`days` 不合法 → 400。

### 2.2 `POST /api/students/:id/remedial-paper`（只產草稿、不寫入）

body：

| 鍵 | 必填 | 規則 | 預設 |
|---|---|---|---|
| `subject` | ✅ | 在科目白名單內 | — |
| `total` | | 5–50 的整數 | 20 |
| `mix` | | `{ remedial, prerequisite, extension }` 三個非負的有限數、總和 > 0 且總和也是有限數（`1e308 + 1e308` 溢位成 Infinity → 400）；只看比例（送 60／20／20 或 0.6／0.2／0.2 相同）；缺鍵或多鍵都 400 | 0.6／0.2／0.2 |
| `days` | | 1–365 的整數 | 90 |
| `source_types` | | 合法題源標記的陣列；空陣列＝不限制（同 `generate-paper`） | 不限制 |

回應：

```json
{
  "student_id": 3, "subject": "數學", "basis": "kc",
  "question_ids": [41, 17, 52, 8],
  "items": [
    { "question_id": 17, "bucket": "remedial",
      "target": { "type": "kc", "code": "MATH.向量內積.02", "chapter": "向量內積", "name": "內積的坐標算法" },
      "chapter": "向量內積", "difficulty": 2, "question_text_preview": "設 $\\vec{a}=(1,2)$ …",
      "follows_question_id": null, "group_ids": [17, 18] }
  ],
  "blueprint": [
    { "bucket": "remedial", "target": { "type": "kc", "code": "MATH.向量內積.02", "chapter": "向量內積", "name": "內積的坐標算法" },
      "wanted": 12, "got": 9, "difficulty_min": null, "difficulty_max": 3,
      "rationale": "掌握度下界 3%（批改 6 題、答對 1）；選難度 ≤ 3 的題" }
  ],
  "shortfalls": [
    { "bucket": "remedial", "target": { "type": "kc", "code": "MATH.向量內積.02", "chapter": "向量內積", "name": "內積的坐標算法" },
      "wanted": 12, "got": 9, "reason": "insufficient_stock" }
  ],
  "notes": ["本草稿實際 17 題（要求 20 題）。不足的部分可以用題目 ID 手動加題，或到「題庫覆蓋率」看哪一章該補題。"]
}
```

- `question_ids` 是**確認後的出題順序**（與 `confirm-paper` 同一個排序函式：題型權重 → 難度，承上題組相鄰）。
- `items` 依 bucket 分組（remedial → prerequisite → extension），同一目標內保持抽出順序（承上組相鄰、依承接順序）。
- `items[].follows_question_id`（前題 id，沒有就 `null`）與 `items[].group_ids`（同一承上組在草稿裡的**全部**成員，
  承接順序；沒有綁定就是 `[自己]`）是契約之外多給的鍵。抽題是整組抽，所以草稿裡的組一定完整；前端靠這兩個鍵
  標「承上 #x」、把刪除鈕改成「刪這組」並整組刪——~~`confirm-paper` 照給的題出卷、**不重驗組是否完整**，
  只刪前題就會出一張有「承上題卻沒有前題」、學生寫不了的卷。~~
  〔修訂 2026-09-26 合併回填 B7〕`confirm-paper` 現在由伺服器檢查承上題是否整組（Owner 決策單 2026-09-25 B7，
  已合入 `local/integration` `7dc14a0`）：卷裡有某組的任何一題、整組卻沒有全部在卷裡時回 400＋`incomplete_groups`（見下方「確認」）。
  前端的整組刪、整組加與確認前擋缺前題的承上題照舊是第一道，訊息貼近草稿操作；伺服器那一道擋的是直接呼叫 API 自行拼題。
- `target.type` 是 `'kc'` 或 `'chapter'`；`chapter` 基底時 `name` 就是章名、沒有 `code`。
- `blueprint` 每個目標一列；`difficulty_min`／`difficulty_max`／`rationale` 是契約之外**多給**的鍵（前端要顯示「為什麼選這個單位」）。
- `shortfalls` 只列 `got < wanted` 的目標；`reason` 是 `insufficient_stock`（可用題數本來就不夠）或 `follow_up_group`（夠，但承上題組塞不進剩下的名額）。
- 錯誤：`:id` 不合法或學生不存在 → 404；body 不合法 → 400 `{ message }`。
- 該生在此科、時間窗內**完全沒有批改**：200、空草稿，`notes` 說明原因（這不是錯誤，是「還不知道弱點」）。
- 確認：前端把 `question_ids`（刪題、加題後的版本）交給既有的 `POST /api/confirm-paper { student_id, question_ids }`。
  卷名沿用 confirm-paper 的規則（`<姓名>-<第一題的章節>特訓卷(日期)`）；手動加的題由 confirm-paper 驗「還在、沒封存」，
  已寫過的題會回 409（`UNIQUE(student_id, question_id)` 硬閘門，DEC-003 不變）。
  〔修訂 2026-09-26 合併回填 B7〕「還在、沒封存」之後，confirm-paper 另驗**承上題整組**（`utils/followUpPaperCheck.js`；成員查詢與
  2.5 的加題查詢同一段 `remedialService.buildItemLookupQuery`）：半組 → 400，不寫卷、不寫 attempts，回應
  `{ message, incomplete_groups: [{ group_ids, missing: [{ question_id, reason }] }] }`，`reason` 為 `not_in_paper`（加回來就好）、
  `archived`（已封存）或 `answered`（該生已寫過）——後兩種加不回來，那一組只能整組刪。訊息逐組列出，例
  `承上題必須與前題整組出卷，以下題組不完整：承上題組（#40、#41、#42）缺 #42。請把缺的題加回卷裡，或把整組刪掉後再確認。`，
  不含學生姓名。順序不擋：伺服器一律重排成整組相鄰、依承接順序。沒有綁定的題（含題幹寫「承上題」但沒綁定的舊題）不受影響。

### 2.3 `POST /api/generate-paper` 的 `blueprint`（跨章配額）

在既有 body 之外接受 `blueprint: [{ chapter, count, difficulty_min?, difficulty_max? }]`：

- 1–10 列；`chapter` 在該科章節白名單內；`count` 正整數，總和 ≤ 50；難度 1–5 的整數且 `min ≤ max`。
  同一章可以出現多列（例如「向量內積 基礎 3 題＋進階 2 題」）。
- 與 `chapter`／`count` **互斥**：兩者都送 → 400 `blueprint 與 chapter／count 不可同時使用…`。
- `student_id`／`student_name`、`subject`、`dry_run`、`exclude_ids`、`source_types` 的語意與訊息同單章路徑。
- 回應形狀同單章路徑（`dry_run` 與真出卷兩種），另外多：
  - `blueprint: [{ chapter, difficulty_min, difficulty_max, wanted, got }]`（逐列）
  - `shortfalls: [{ row, chapter, difficulty_min, difficulty_max, wanted, got, reason }]`（只列不足的列；`row` 從 1 起）
  - `note`：有不足時的一句話摘要（與單章路徑的 `note` 同一個鍵，既有前端會顯示它）
- **不足量不回 400**：照抽到的題出（dry_run 預覽或真出卷），逐列回報；**全部列都抽不到任何一題**才回 400
  `新題目庫存不足！blueprint 每一列都抽不到…`（回應同時帶 `blueprint`／`shortfalls`）。
- 承上題湊不滿的政策與單章路徑是**同一個開關** `FOLLOW_UP_SHORTFALL_POLICY`（`controllers/examController.js`，~~待 owner 決定~~）：
  ~~預設 `'note'` 即上一條；切成 `'error'` 時，`reason = follow_up_group` 的列會讓整個請求回 400
  `承上題須與前題整組出題，blueprint 第 N 列「章」無法剛好湊滿…`（同樣帶 `blueprint`／`shortfalls`）。~~
  〔修訂 2026-09-26 合併回填 B10〕Owner 決策單 2026-09-25 B10 選「直接報錯，請老師改題數」，已合入 `local/integration`（`7dc14a0`）。
  開關改成環境變數，每次組卷時讀（改了要重啟伺服器）：
  - **預設 `error`**（未設、空白或打錯字都當 `error`，打錯字時伺服器 log 警告一次）：`reason = follow_up_group` 的列讓整個請求回 400，
    逐列說出要幾題、承上題整組最多湊得到幾題、建議改成幾題（離原題數最近、剛好湊得滿的上下兩個；往上的建議不讓整張卷超過 50 題），
    例 `承上題須與前題整組出題，blueprint 第 2 列「向量內積」要 3 題無法剛好湊滿（3 題以內最多只能湊到 2 題），請把題數改成 2 題或 4 題。`
    （多列以「；」分隔；同樣帶 `blueprint`／`shortfalls`；dry_run 與真出卷都不寫庫）。這個檢查排在「全部列都抽不到」之前：
    承上組塞不進才一題都抽不到時，回的是改題數的建議，不是「庫存不足」。
  - `FOLLOW_UP_SHORTFALL_POLICY=note`：決策前的行為（上一條：照抽到的題出並附 `note`），逐字不變，可隨時切回。
  「庫存不足」的列不受這個開關影響（同單章路徑）。
- 補救卷草稿（2.2）不看這個開關：它本來就不出卷，不足量一律逐目標回報，由老師在草稿裡補。〔修訂 2026-09-26 合併回填 B10〕B10 的預設報錯不影響補救卷草稿。
- 卷名：1 章同單章路徑；2–3 章列出（`小明-向量內積、排列特訓卷(…)`）；4 章以上 `小明-向量內積等4章特訓卷(…)`。
- **沒帶 `blueprint`（或為 `null`）時，單章路徑的行為與回應逐字不變**（既有整合測試與 e2e 驗）。
  候選池抽成共用的 `buildCandidatePoolQuery`（`q.chapter = ANY($2::text[])`）後，單章路徑把 `chapter` 先過 pg 的
  `prepareValue` 再包成一元素陣列：字串原樣通過；非字串（陣列、物件、數字）和抽出前的 `q.chapter = $2` 一樣被序列化成
  **一個**字串去比，比不到任何章 → 400 庫存不足。直接包 `[chapter]` 的話，陣列會被 `= ANY` 攤平成多章卷（200），
  參差陣列會丟 500；改用 `String(chapter)` 則 `['向量內積']` 會變成 `'向量內積'` 而比中（抽出前是 400），兩者都不是原本的行為。

### 2.4 `GET /api/coverage?subject=&student_id=`

```json
{
  "rows": [
    { "subject": "數學", "volume": "第三冊(A/B)", "chapter": "向量內積", "total": 3,
      "by_difficulty": { "1": 2, "2": 0, "3": 1, "4": 0, "5": 0 }, "unseen_by_student": 2 }
  ],
  "kc_rows": [ { "code": "MATH.向量內積.01", "name": "內積的意義", "chapter": "向量內積", "total": 0 } ]
}
```

- 只算未封存題。**白名單的每一章都列**（沒有題也列、`total = 0`：覆蓋率的重點是看見空洞）；
  資料庫裡不在白名單的舊章節接在該科最後、`volume = null`。
- 順序：科目（`SUBJECTS`）→ 冊（`VOLUMES`）→ 章。`subject` 省略＝全部科目。
- `unseen_by_student`：沒給 `student_id` 時為 `null`；給了＝該章未封存題中該生沒有 `attempts` 的題數。
- `kc_rows`：每個知識點掛了幾題未封存題（`question_kcs`），0 題的也列；順序＝科目 → 章節白名單順序 → `sort` → `code`。
- 錯誤：`subject` 不在白名單、`student_id` 不是正整數 → 400；學生不存在 → 404。

### 2.5 `GET /api/students/:id/remedial-paper/items?ids=`（草稿手動加題前的查詢；只讀）

草稿「用題目 ID 加題」與「找相似 → 加入補救卷」加題前，前端先問這支：題目資料，以及它所在**承上組的全部成員**。

```json
{
  "items": [
    { "question_id": 40, "subject": "數學", "chapter": "向量內積", "difficulty": 2, "question_text_preview": "…",
      "follows_question_id": null, "group_ids": [40, 41], "archived": false, "answered": false },
    { "question_id": 41, "subject": "數學", "chapter": "向量內積", "difficulty": 3, "question_text_preview": "承上題，…",
      "follows_question_id": 40, "group_ids": [40, 41], "archived": false, "answered": false }
  ],
  "missing": [999]
}
```

- `ids`：逗號分隔的正整數（int4 範圍內），去重後 1–50 個；同名參數重複（`?ids=1&ids=2`）視同串接。不合法 → 400。
- `items`：依要求的順序，每題後面緊接同組其他成員（組內承接順序），不重複。承上組的走訪與組卷候選池同一段遞迴
  （`follows_question_id` 無向連通分量），**不排除**封存題與該生寫過的題，改用 `archived`／`answered` 回報。
- `missing`：資料庫裡沒有的 id。
- 錯誤：`:id` 不合法或學生不存在 → 404。

前端的規則（`public/js/remedial.js` 的 `planManualAdd`，與組卷「承上題整組」同一個原則：寧可不加，也不出寫不了的題）：

| 情況 | 結果 |
|---|---|
| 題目屬於承上組，組內每一題都能出（同科、沒封存、他沒寫過） | **整組**加進「手動加入」組（例：加承上題 #41，前題 #40 一起進來），提示「已整組加入」 |
| 組內有任何一題封存、他寫過或不同科 | 整組不加，提示是哪一題擋住 |
| 題目本身不同科／封存／他寫過／查不到／已在草稿 | 不加，逐項提示 |

確認前還有最後一道：草稿裡若有「前題不在草稿」的承上題，不送 `confirm-paper`。
〔修訂 2026-09-26 合併回填 B7〕送出之後伺服器也會再檢查一次承上題整組（2.2「確認」）；前端這一道先擋，提示貼近草稿操作。

---

## 3. 補救卷的選題規則

實作：`services/remedialService.js`（純函式 `buildPlan` 決定「每個目標要幾題、什麼難度」，I/O 的 `planRemedialPaper` 抽題）。

### 3.1 單位與 basis

1. 讀該生在此科、時間窗內的知識點弱點（同 2.1 的計算）。
2. **有知識點標註的已批改題 ≥ `WEAKNESS_MIN_N`（且至少 1 題）→ `basis = 'kc'`**；否則 `basis = 'chapter'`，
   改以章節聚合（正確度同樣是 `COALESCE(score, result)`），同樣用 Wilson 下界由弱到強排序。
   有標註但不夠時，`notes` 第一句說明「只有 N 題，先以章節為單位」。
   〔最終審查修正 S5-42〕「有標註」只算標在**與題目同科**的知識點上（知識點弱點的聚合同樣只算同科標註）：
   題目改科後殘留的別科標註若也算數，會判成 `kc` 基底卻排不出任何單位（0 題）。題目改科時 `PUT /api/questions/:id`
   已會刪掉別科標註，這裡是第二道。
3. 只有 `graded > 0` 的單位參與挑選：沒有批改＝不知道，不當弱點也不當強項。

### 3.2 配額

`total × mix` 以**最大餘數法**分成三桶：先各取整數部分，剩下的題依小數部分由大到小補，同分時 remedial → prerequisite → extension。
三桶總和恰為 `total`。例：20 題預設配比 → 12／4／4；7 題 → 4／2／1。

### 3.3 三個桶的目標與難度

設有批改的單位共 n 個（已依 `mastery_lb` 由低到高排序）：

| 桶 | 目標單位 | 難度 | 候選題 |
|---|---|---|---|
| remedial | 最弱的 k 個，**k = min(3, ⌈n/2⌉)** | ≤ ⌊該生在此單位**答錯題**（正確度 < 1）的平均難度 + 1⌋；沒有答錯題時改用已批改題的平均難度；夾在 1–5 | kc：掛了該知識點的題；chapter：該章的題 |
| prerequisite | kc 基底：remedial 知識點的**直接先備**（`kc_prerequisites`），依 remedial 的弱→強、再依 `strength` 高→低；排除本身已是 remedial 的、重複的、**不同科的**；最多 3 個 | ≤ 3（基礎題） | 掛了該先備知識點的題 |
| extension | remedial 以外、`mastery_lb` 最高的最多 3 個 | ≥ ⌊已批改題平均難度⌋ + 1（上限 5）：比他在這個單位寫過的難一點 | 同 remedial |

- 一桶的題數**平均分給**該桶的目標，餘數給排前面的（remedial 給最弱的、extension 給最強的）；分到 0 題的目標不列。
- **併桶**（一律寫進 `notes`，不悄悄少出）：
  - `chapter` 基底沒有先備資料 → 先備配額併入 remedial（契約規定）。
  - `kc` 基底但最弱的知識點沒有登錄同科先備 → 同樣併入 remedial。
  - 只有 1 個單位有批改（沒有「其他單位」可延伸）→ 延伸配額併入 remedial。
- 跨科先備（例：物理知識點的先備是數學）**不納入**：補救卷限單科（契約「候選一律排除不同科」），`notes` 會點名是哪一個。
- 加權：kc 基底的 `graded`、`correct`、平均難度都依 `question_kcs.weight` 加權。

### 3.4 抽題（與 generate-paper 同一段程式碼）

全部目標依 remedial → prerequisite → extension 的順序交給 `examController.pickByQuotas`：

- 候選池：`buildCandidatePoolQuery`——**與單章組卷同一段 SQL**：同科、未封存、該生沒寫過（`NOT EXISTS attempts`）、
  `source_types` 以內；再加上本目標的知識點或章節、難度區間。
- 每個目標各走一次 `pickPaperUnits`：**家族互斥**（同一 `variant_of` 家族一張卷至多一題）與
  **承上題整組**（組內任一題不可用就整組不抽；抽到就整組相鄰）。
- 跨目標：前面目標已抽中的題、已占用的家族，後面目標不再抽（同一題可能同時掛兩個知識點）。
- 不足量逐目標回報在 `shortfalls`，**不自動拿別的單位補**：補哪裡、補多少由老師決定（草稿裡可以用題目 ID 加題）。
  總題數少於 `total` 時，`notes` 最後一句說明實際題數。

---

## 4. 資料

- **階段 5 沒有新增 migration、沒有新的環境變數。**〔dec/r16-remedial〕補救成效另加 `migrations/0022_paper_kind_targets.sql`（第 10.1 節），仍沒有新的環境變數。階段 5 讀的表全是 `stage5/base` 已建好的：
  `attempts`（`result`、`score`）、`questions`、`question_kcs`、`kc_prerequisites`、`knowledge_components`。
- 門檻沿用 `WEAKNESS_MIN_N`（預設 5）；旗標 `FEATURE_REMEDIAL`（`.env.example` 已有說明，預設關）。
- 知識點資料可能是空的（WS-C 的載入與標註還沒跑）：那時一切自動退回章節基底，覆蓋率的 `kc_rows` 是空陣列。
- 程式位置：

| 檔案 | 職責 |
|---|---|
| `services/kcWeaknessService.js` | Wilson 下界（純函式）、知識點聚合 SQL builder、排序 |
| `services/remedialService.js` | 配額、目標、難度區間（純函式 `buildPlan`）與草稿組裝；手動加題查詢 `lookupItems` |
| `services/coverageService.js` | 覆蓋率 SQL builder 與白名單順序組裝 |
| `controllers/remedialController.js` | 四支 API（2.1、2.2、2.4、2.5）的驗證與回應 |
| `controllers/examController.js` | 〔擴充〕候選池抽成 `buildCandidatePoolQuery`／`fetchCandidatePool`、多段配額 `pickByQuotas`、`blueprint` 分支 |
| `routes/index.js` | 〔擴充〕檔尾 WS-D 區塊 |
| `public/js/remedial.js` | `#remedial`、`#coverage` |
| `public/js/variants.js` | 〔擴充〕「找相似」結果的「加入補救卷」按鈕（見第 6 節） |
| `config/remedialErrorStrategy.js` | 〔dec/r16-remedial〕錯因 → 選題策略的對照表與判斷（純函式，第 9 節） |
| `utils/remedialTargets.js` | 〔dec/r16-remedial〕`confirm-paper` 的 `kind`／`targets` 驗證（純函式，第 10.2 節） |
| `services/remedialEffectService.js` | 〔dec/r16-remedial〕補救成效的聚合 SQL 與狀態判斷（第 10.3、10.4 節） |
| `migrations/0022_paper_kind_targets.sql` | 〔dec/r16-remedial〕`exam_papers.kind`、`targets`（第 10.1 節） |
| `services/remedialFillService.js` | 〔dec/r16-remedial〕題庫不夠時自動補題：藍本挑選、分配與上限、先檢索、建變式 job（第 11 節） |
| `services/remedialProvenance.js` | 〔dec/r16-remedial〕補題來源註記：入庫時抄到題目、複核畫面的 `remedial_for`、合併學生（第 11.3 節） |
| `services/assistantService.js` | 〔擴充〕〔dec/r16-remedial〕助教的 `plan_remedial_paper`、`get_remedial_effect`（`FEATURE_REMEDIAL` 開啟才有；第 12 節） |
| `migrations/0023_remedial_variant_provenance.sql` | 〔dec/r16-remedial〕`jobs.target_student_id`、`questions.target_student_id`／`target_source_question_id`（第 11.3 節） |

---

## 5. 給老師的操作說明

先在 `.env` 設 `FEATURE_REMEDIAL=true` 並重啟。學生分頁與題庫管理分頁會各多一個區塊。

這兩個區塊掛在既有的分頁裡，所以還要看那些分頁本身的開關：

| 想用的功能 | 需要同時開啟的旗標 | 為什麼 |
|---|---|---|
| 題庫覆蓋率（題庫管理分頁） | `FEATURE_REMEDIAL` | 題庫管理分頁本身沒有旗標 |
| 依弱點出補救卷（學生分頁） | `FEATURE_REMEDIAL`＋`FEATURE_STUDENTS` | 補救卷區塊在「學生」分頁裡；`FEATURE_STUDENTS` 關閉時導覽列不顯示「學生」，整個區塊到不了 |
| 「找相似」結果上的「加入補救卷」 | `FEATURE_REMEDIAL`＋`FEATURE_STUDENTS`＋`FEATURE_VARIANTS`＋`FEATURE_SIMILAR` | 「找相似」按鈕在學生分頁的最近錯題上（`FEATURE_STUDENTS`、`FEATURE_SIMILAR`）；結果由變式模組畫，`FEATURE_VARIANTS` 關閉時它不掛載、不會回應「找相似」，按鈕也就不會出現 |

用題目 ID 手動加題只需要前兩個旗標。

### 5.1 出一份補救卷（學生分頁 →「依弱點出補救卷」）
入口在學生分頁的「重練與補救」分頁。在「弱點」分頁按右上角的「依弱點出補救卷 →」也會切過來，學生與科目會帶成面板目前選的那一位（已有草稿在編時不動）。

1. **選學生、科目**。題數預設 20；「看哪段批改」預設最近 90 天。
2. **配比**預設補救 60%、先備 20%、延伸 20%。只看比例，填 3／1／1 也一樣。想要一份純補救卷就把先備、延伸填 0。
   **題源限制**（著作權）與組卷頁同一組選項：全部來源／僅乾淨題源（官方、學校、自寫）／排除出版社（未標記仍可用）。
   補救卷要印給學生，題源有顧慮時記得選。〔最終審查修正：原本補救卷沒有這個選項〕
3. 按「**產生草稿**」。這一步**不會出卷、不會記錄**，可以放心按很多次（每次題目會隨機換一批）。
   **但每按一次都會整份換掉**：先前手動加入的題不會保留，系統會提示哪幾題沒保留，需要的話再加一次。
   不要這份草稿了（例如想改替另一位學生加「找相似」的題）就按草稿右上角的「**捨棄草稿**」。
4. 看草稿：
   - 最上面的標籤告訴你這次是「以知識點判斷」還是「以章節判斷」。題目標好知識點、批改過的題夠多，才會用知識點。
   - 黃色框是系統的說明：例如「先備配額併入補救」「只有 1 個章節有批改紀錄」。
   - 每一組（補救／先備／延伸）下面列出目標單位、為什麼選它（掌握度下界、答對幾題）、要幾題、找到幾題。
     **紅字**表示題庫不夠——到題庫管理的「題庫覆蓋率」看那一章缺什麼難度，補題後再產生一次。
   - 展開「知識點掌握度」可以看到這位學生最弱的 10 個知識點。「樣本不足」表示批改的題還太少，數字只供參考。
5. **調整**：每題右上角「刪除」；下方輸入題目 ID（可一次多個，用逗號分隔）按「加題」。
   也可以在「找相似」的結果上直接按「**加入補救卷**」，題目會進到這份草稿的「手動加入」組。
   - **承上題整組處理**：題號旁標「承上 #x」的是承上題，左邊有紫色邊線的是同一組。它們的按鈕是「**刪這組**」，
     按了會把前題和承上題一起刪掉——只留承上題的話，學生拿到的是沒有前情、寫不了的題。
   - 加題時若加的是承上題（或有承上題的前題），系統會**連同同組的題一起加入**，並跳出提示。
     組裡有題已封存或這位學生寫過，整組都不會加，提示會說是哪一題擋住。
   - 別科的題、已封存的題、他寫過的題、查不到的題號都不會加入，會各自提示原因。
6. 按「**確認出卷**」：這時才建卷、記入作答歷史（之後不會再出給同一位學生）。成功後先在下載鈕旁選版本——
   **標準版**（卷末附答案）、**學生版**（不附答案，直接印給學生）、**詳解版**（答案＋文字詳解）——再按「下載 Word 考卷」，
   檔名會加註版本（例如「王小明-向量內積特訓卷(2026_9_24)（學生版）.docx」）。〔最終審查修正：原本只拿得到標準版〕
   若出現「部分題目已被指派給該學生」，表示草稿產生之後他又被出了其中某題（例如另一張卷先確認了），重新產生草稿即可。
   〔修訂 2026-09-26 合併回填 B7〕若出現「承上題必須與前題整組出卷，以下題組不完整：…」，照提示把缺的題加回草稿，
   或按「刪這組」整組刪掉再確認；提示標「已封存」或「該生已寫過」的題加不回來，那一組只能整組刪。

> 掌握度為什麼不是答對率？答對率 100% 可能只是「1 題對 1 題」。系統用的是「在 95% 信心下，他的答對率至少有多少」
> （Wilson 下界）：1 題對 1 題只有 21%，10 題對 8 題是 49%。所以批改越多，判斷越準；剛開始上課的學生，
> 系統會比較保守地把還沒把握的單位也當成要補的。

### 5.2 看題庫覆蓋率（題庫管理分頁 →「題庫覆蓋率」）

- 每一列是一章，五欄是難度 1–5 各有幾題（只算沒封存的題）。**紅色＝0 題**，黃色＝1–2 題，綠色越深越多。
- 選一位學生，會多一欄「還沒寫過」：出卷前先看這一章還剩幾題能出給他。
- 下方可展開每一章的知識點各掛了幾題；紅字的知識點一題都沒有，補救卷抽不到它。

### 5.3 跨章組卷（API）

`POST /api/generate-paper` 可以改送 `blueprint`（見 2.3），一次指定多章、每章幾題、難度範圍。
本階段只開放 API（補救卷畫面就是它的主要使用者）；組卷分頁的單章流程不變。
〔修訂 2026-09-26 合併回填 B10〕某一列因為承上題要整組出而湊不滿題數時，預設整份擋下，訊息會說是第幾列、改成幾題湊得滿；
照建議改題數再送一次即可（想恢復「少出題並附註」，在 `.env` 設 `FOLLOW_UP_SHORTFALL_POLICY=note` 並重啟）。

---

## 6. 與契約不同之處

| 契約 | 實作 | 理由 |
|---|---|---|
| 第 4.4 條第 5 項：「`public/js/students.js` 唯一的掛鉤：最近錯題的『找相似』結果每列加一顆『加入補救卷』按鈕」 | 按鈕掛在 **`public/js/variants.js`** 的 `findSimilar`（加註〔stage5 WS-D〕），`students.js` 完全沒改 | 「找相似」的結果是 `variants.js` 畫的：`students.js` 只在最近錯題列上發 `examapp:variant-request` 事件，自己沒有結果列可以掛按鈕。掛在 students.js 只能把按鈕放在「錯題本身」上，而錯題學生已經寫過、confirm-paper 必定 409。掛鉤同樣只 dispatch `remedial:add`、`FEATURE_REMEDIAL` 關閉時不顯示 |
| 回應欄位 | `remedial-paper` 的 `blueprint[]` 多 `difficulty_min`、`difficulty_max`、`rationale`；`generate-paper` 的 blueprint 回應多 `note`（有不足時） | 前端要顯示「為什麼選這個單位」；`note` 讓既有組卷畫面不用改就能顯示不足量。契約列出的鍵全部照給 |
| 補救卷的限流 | 四支新端點沒有套 `createRateLimiter` | 契約第 1.2 條的限流要求是針對會呼叫 LLM 的端點；這四支只讀資料庫 |
| 第 4.4 條第 2 項的 `items` 形狀 | 多 `follows_question_id`、`group_ids` | 契約要求候選「套用承上題整組規則」，但草稿交到前端後老師可以刪題、加題，`confirm-paper`（契約：不改）又不重驗組是否完整；前端要知道誰跟誰一組才能整組刪。契約列出的鍵全部照給。〔修訂 2026-09-26 合併回填 B7〕Owner 決策單 B7 之後 `confirm-paper` 也會整組檢查（裁決 S5-28 改判）；這兩個鍵仍是草稿整組刪、整組加的依據 |
| 第 4.4 條只列三支 API | 多一支 `GET /api/students/:id/remedial-paper/items`（2.5），同樣在 `FEATURE_REMEDIAL` 後、只讀 | 「用題目 ID 加題」只有 ID，前端不知道那題是不是承上題、前題在不在草稿、是不是別科或已封存；既有 API 沒有「依 ID 查題目」的端點（`GET /api/questions` 沒有 id 篩選、`/similar` 不回 `follows_question_id`，兩者都不屬 WS-D）。沒有這支就只能在確認時才發現、或根本發現不了 |
| 第 4.4 條第 3 項：單章路徑「逐字不變」 | `FOLLOW_UP_SHORTFALL_POLICY` 的效果延伸到 blueprint 分支（2.3） | 那個常數是「承上題湊不滿怎麼辦」的單點切換；只有單章路徑聽它的話，owner 切成 `'error'` 時兩條組卷路徑的行為會不一致。預設 `'note'` 時 blueprint 行為不變。〔修訂 2026-09-26 合併回填 B10〕Owner 決策單 B10 之後預設是 `error`（環境變數，兩條路徑一起擋）；切回 `note` 時 blueprint 行為與原本相同 |
| ADR 編號 | 新增 ADR-014（契約第 6 條只分配到 ADR-013） | 任務要求 WS-D 交付 ADR；整合時若要改號，改檔名與本檔連結即可 |

契約沒有寫、由本實作決定的細節（都寫在第 3 節）：k = min(3, ⌈n/2⌉)、先備難度 ≤ 3、延伸難度 ≥ ⌊平均⌋+1、
跨科先備不納入、`WEAKNESS_MIN_N = 0` 時仍至少要 1 題有標註才用知識點基底、完全沒批改時回 200 空草稿。

---

## 7. 測試

| 層 | 檔案 | 驗什麼 |
|---|---|---|
| 單元 | `test/unit/kcWeakness.test.js` | Wilson 下界（n=0、全對、全錯、小數樣本）、SQL 參數順序、排序與 low_sample |
| 單元 | `test/unit/remedialService.test.js` | 最大餘數配額、目標挑選、難度區間、併桶 notes、草稿組裝（注入假依賴）、items 的承上組資訊、`lookupItems` |
| 單元 | `test/unit/coverageService.test.js` | 白名單每章都列、舊章節、unseen 的 null／數字、知識點排序 |
| 單元 | `test/unit/remedialValidation.test.js` | 補救卷 body（含 mix 總和溢位）、覆蓋率 query、加題查詢的 `ids`、blueprint 驗證與承上題政策開關、候選池 SQL 的參數順序；〔修訂 2026-09-26 合併回填 B10〕blueprint 逐列建議題數（`blueprintPolicyError`、`blueprintShortfallHints`、`followUpShortfallText`） |
| 單元 | `test/unit/remedialUi.test.js` | 前端檔案契約、純函式、miniDom 渲染（旗標關閉不渲染、草稿、刪題加題、`remedial:add`、確認、覆蓋率）、承上題整組（「承上 #x」、「刪這組」、整組加入或拒絕、不混科、確認前擋缺前題的承上題）、variants.js 掛鉤 |
| 整合 | `test/integration/remedial.pg.test.js` | 旗標關閉 404；kc 加權與 Wilson 排序；kc 基底／chapter 退回；各 bucket 配額；不足量；已作答、封存、跨科、題源排除；家族互斥；承上題整組與 items 的組資訊；不寫庫並接 confirm-paper；加題查詢（承上組成員、封存與已寫過旗標、missing、400／404）；blueprint 的互斥 400、逐列不足、跨列家族互斥與不重複、真出卷；單章路徑收到非字串 chapter 仍是 400 庫存不足；覆蓋率 |
| 單元 | `test/unit/remedialErrorStrategy.test.js` | 〔dec/r16-remedial〕錯因對照表（每個代碼一列、標籤同白名單、預設策略）、錯因統計、主因門檻（2 筆、40% 邊界、同票、別科不適用）、難度上限、偏好鍵與反應式偵測；偏好排序交給真的 `pickPaperUnits`（偏好先抽、題數不少、同鍵仍隨機、承上組與家族互斥）；`buildPlan`／`buildTargets`／`planRemedialPaper` 的套用、退回與沒標錯因時逐字不變 |
| 單元 | `test/unit/remedialEffect.test.js` | 〔dec/r16-remedial〕`confirm-paper` 的 `targets` 驗證（逐項的 400）、狀態門檻邊界、起算時間、目標成效組裝、SQL 參數順序與 R10、查詢參數、0022 檔案層級 |
| 整合 | `test/integration/remedialErrorFocus.pg.test.js` | 〔dec/r16-remedial〕依錯因出題：套用（降上限＋偏好，連抽 6 次）、同票、沒標錯因、R10、退回上限、退回也不夠、知識點基底、草稿不寫庫 |
| 單元 | `test/unit/remedialFill.test.js` | 〔dec/r16-remedial〕補題 body 驗證、藍本順序、分配與上限、錯題查詢（R10）、`fillShortfall` 組裝（先檢索、合流、上限、跳過）、前端與複核畫面的純函式 |
| 整合 | `test/integration/remedialFill.pg.test.js` | 〔dec/r16-remedial〕0023、藍本挑選與 R10、建 job 帶來源、先檢索、合流、上限 5 題、跳過、400／404／旗標；假 agent 跑完生成：input 不含學生資料、複核的 `remedial_for`、approve 與自動入庫抄來源、一般變式不抄；刪除與合併學生 |
| 單元 | `test/unit/assistantRemedialTools.test.js` | 〔dec/r16-remedial〕旗標關閉時助教的 SYSTEM 與模板雜湊逐字不變（釘值）、開啟時多兩個工具與另一個識別名、參數驗證、代號、摘要不含卷名 |
| 整合 | `test/integration/studentReport.pg.test.js` | 〔dec/r16-remedial〕助教的兩個工具接真的資料庫（假 LLM）：只預覽不寫庫、prompt 與鍵沒有姓名；學習報告（見 `docs/student-report.md`） |
| 整合 | `test/integration/remedialEffect.pg.test.js` | 〔dec/r16-remedial〕0022（預設、CHECK、再套一次）；`confirm-paper` 存 `kind`／`targets`、不合法 400 不寫、一般卷 normal、純重練卷 retrain；補救成效（improved／worse／insufficient_data／pending、只算批改完之後建立的卷、R10、知識點加權、days、新到舊、limit、從草稿一路到成效、404／400、旗標關閉） |

整合測試自己插入知識點、`question_kcs`、`kc_prerequisites`、`attempts` fixture，不依賴 WS-C 的種子檔。

〔修訂 2026-09-26 合併回填〕B7、B10 的測試不在上表的檔案裡：`confirm-paper` 承上題整組檢查在 `test/unit/followUpPaperCheck.test.js`
與 `test/integration/paperGroups.pg.test.js`（「confirm-paper 整組檢查」6 項）；`FOLLOW_UP_SHORTFALL_POLICY` 的預設與讀法在
`test/unit/followUpShortfallPolicy.test.js`，blueprint 預設報錯與建議題數上限在 `paperGroups.pg.test.js`。

---

## 8. 之後可以做的（不在本階段）

- 錯題重練與間隔複習（G11、G13）：需要 DEC-003 的例外條款與新表，本階段新題組卷仍不重複。
- 掌握度模型（G12 第二步）：資料量夠了再上固定參數 BKT，取代 Wilson 下界排序。
- 題庫不足時自動退回鄰近章節或觸發變式生成（G22）：目前只回報不足量，由老師決定。
- 組卷分頁的跨章配額 UI；助教的 `plan_remedial_paper` 只讀工具。

---

## 9. 依錯因出題（〔dec/r16-remedial〕補救組）

Owner 2026-10-03：補救卷原本只看「哪個單位弱」，不看「錯在哪裡」。批改時標的錯因（`attempts.error_types`，白名單
`config/errorTypes.js`）其實說明了該怎麼補，所以補救組的每個目標另看錯因、照主因調整選題。不呼叫 LLM。

### 9.1 怎麼判斷主因

- **範圍**：補救組（`bucket = 'remedial'`）的每個目標單位。先備、延伸組不看錯因。
- **算哪些作答**：該生、同一個時間窗（`days`）、**每題第一次作答**（檢視 `attempts`，R10：重練的錯因不算）、
  已批改且正確度 `COALESCE(score, result) < 1`（答錯或部分給分）。章節基底＝該章的題；知識點基底＝掛了該知識點
  （同科標註）的題。SQL：`remedialService.buildErrorProfileQuery`；聚合：`remedialErrorStrategy.errorProfileFromRows`。
- 只數白名單內的代碼；同一筆作答重複標同一個代碼只算一次。「有標錯因的錯題」＝至少有一個白名單代碼的那一筆。
- **門檻**（`config/remedialErrorStrategy.js` 的具名常數）：有標錯因的錯題 ≥ `MIN_TAGGED_WRONG = 2`，而且
  主因占全部錯因標記 ≥ `MIN_DOMINANT_SHARE = 0.4`（`share`＝主因次數 ÷ 全部錯因標記數；一題可標多個，分母是標記數）。

| 情況 | `error_focus` | 選題 |
|---|---|---|
| 這個單位的錯題完全沒標錯因 | `null` | 與沒有這個功能時逐字相同（`rationale` 不提錯因） |
| 有標錯因的錯題只有 1 筆 | `applied: false`、`reason: 'insufficient_evidence'` | 不調整，`rationale` 說「還看不出主因」 |
| 主因 < 40% | `applied: false`、`reason: 'no_dominant'` | 不調整 |
| 第一名同票（例：觀念 2、計算 2） | `applied: false`、`reason: 'tie'` | 不調整 |
| 主因的策略不適用這一科（`chem_equation` 只對化學） | `applied: false`、`reason: 'not_applicable'` | 不調整 |
| 其餘 | `applied: true`、`reason: 'dominant'` | 照 9.2 的策略調整 |

### 9.2 錯因 → 策略（預設，待 Owner 確認）

| 代碼 | 標籤 | 難度上限 | 偏好（只排先後，不篩題） | 給老師看的理由 |
|---|---|---|---|---|
| `concept` | 觀念不清 | 降一級（最低 1） | 單選／多選／填空 | 觀念還沒建立時，先用短的觀念檢查題確認他懂了，再回到難題。 |
| `formula` | 公式記錯 | 降一級 | 單選／多選／填空 | 公式記錯先用直接套公式的基本題把公式記牢。 |
| `method` | 方法選錯 | 不變 | 計算 | 方法選錯要在完整的解題過程裡練「該用哪一招」，計算題最看得出來。 |
| `calc` | 計算錯誤 | 不變 | 計算／填空 | 計算錯誤靠練習量改善，多給要算到底的題。 |
| `unit` | 單位或有效數字 | 不變 | 計算／填空 | 單位與有效數字要在實際算出數值的題裡練。 |
| `careless` | 粗心抄錯 | 不變 | 計算／填空 | 粗心靠練習量與檢查習慣改善，多給要寫出答案的題。 |
| `reading` | 審題錯誤 | 不變 | 題幹長的先（壓掉空白後的字數） | 審題錯誤要練讀長題目、抓條件，題幹長的題先出。 |
| `blank` | 未作答 | 降一級 | 簡單的先 | 空白通常是不知道從哪裡下手，先給做得出來的題建立信心與起手式。 |
| `time` | 時間不足 | 降一級 | 簡單的先 | 時間不夠先練基本題的速度，再拉難度。 |
| `chem_equation` | 化學式或係數 | 不變 | 題幹有反應式的先（→、⟶、⇌、`\rightarrow`、`\longrightarrow`、`\xrightarrow`、`\rightleftharpoons`、`\ce{… -> …}`、「反應式」） | 化學式或係數出錯，要多寫、多配平反應式。只對化學。 |

改策略只改這張表與 `ERROR_STRATEGIES`，選題程式不必動（`test/unit/remedialErrorStrategy.test.js` 釘住現在的預設，改了要一起改）。

### 9.3 套用方式

- **難度上限**是硬條件：補救目標的上限（第 3.3 節）降一級後抽。**抽不滿就退回原本的上限**再抽一次
  （`examController.pickByQuotas` 的 `fallbackPool`；兩次取抽到較多的那一次），偏好照舊；這時 `notes` 多一句
  `「向量內積」錯因以「觀念不清」為主，原本只選難度 ≤ 3 的題，但湊不到 5 題，已改回難度 ≤ 4（題型偏好照舊）。`，
  `blueprint` 的 `difficulty_max` 回報實際用的上限、`error_focus.reason` 改成 `'dominant_difficulty_fallback'`（`applied` 仍是 true）。
  退回之後還是不夠，照舊逐目標回報在 `shortfalls`。
- **偏好**一律做成候選池內的排序（`pickByQuotas` 的 `rankOf`）：把洗牌函式包一層「先洗牌、再依偏好鍵穩定排序」交給同一個
  `pickPaperUnits`。候選池 SQL、家族互斥、承上題整組、裝箱規則都不變，所以偏好**只改變抽的先後，永遠不會讓題數變少**；
  偏好鍵相同的題之間仍是隨機。一組承上題的偏好鍵取組內最好的一題。沒有偏好或沒套用時，`pickByQuotas` 收到的配額與之前逐字相同。
- `rationale` 在掌握度那一句後面接錯因：例 `掌握度下界 3%（批改 6 題、答對 1）；錯因以「觀念不清」為主（有標錯因的錯題 4 題，標了 3 次，占 75%）→ 難度上限降一級，優先單選／多選／填空；選難度 ≤ 3 的題`。
- `blueprint` 中 `bucket = 'remedial'` 的列**一律**有 `error_focus` 鍵（沒標錯因時為 `null`；先備、延伸列沒有這個鍵）：

```json
{ "type": "concept", "label": "觀念不清", "count": 3, "share": 0.75, "tagged_wrong": 4,
  "strategy": { "difficulty_ceiling_delta": -1, "prefer_types": ["單選", "多選", "填空"], "prefer_order": null,
                "summary": "難度上限降一級，優先單選／多選／填空", "rationale": "觀念還沒建立時，…" },
  "applied": true, "reason": "dominant" }
```

  沒套用時 `strategy` 為 `null`。草稿畫面在每個補救目標下多一行（主因、怎麼調、為什麼；沒套用時灰字說明看不出主因）。

---

## 10. 補救成效追蹤（〔dec/r16-remedial〕）

補救卷出了之後，看「補完有沒有變好」：每份補救卷的每個補救目標，比較出卷當下（補救前）、這張卷上、之後其他卷上的答對率。

### 10.1 資料（`migrations/0022_paper_kind_targets.sql`）

`exam_papers` 加兩欄：`kind TEXT NOT NULL DEFAULT 'normal'`（CHECK：`normal`／`remedial`／`retrain`）與 `targets JSONB`
（只有 `remedial` 能有、必須是陣列；`exam_papers_targets_kind_check`）。既有的卷一律是 `normal`，不回頭猜哪些是補救卷（沒有快照也比不了）。
索引 `idx_exam_papers_student_kind (student_id, kind, created_at DESC)`。可重複套用。

| 種類 | 什麼時候寫 |
|---|---|
| `normal` | 其餘全部（建卷的 INSERT 與之前逐字相同） |
| `remedial` | `confirm-paper` 帶 `kind: 'remedial'`＋`targets`（補救卷草稿確認） |
| `retrain` | `confirm-paper` 的每一題都在 `retrain_question_ids` 裡（純錯題重練卷，卷名「錯題重練卷」的那種） |

資料庫還沒套 0022 時：補救卷確認回 **503**（什麼都沒寫，請先 `npm run migrate`；沒有快照的補救卷追蹤不了成效，不悄悄出成一般卷）；
純重練卷照樣出卷、只是不記種類（伺服器視窗提醒一次）；`GET …/remedial-effect` 回 503。

### 10.2 目標快照與確認

`POST /api/students/:id/remedial-paper` 的回應最後多 `targets`：每段配額（含先備、延伸）一列，出卷當下的單位與基準。

```json
[{ "unit_type": "chapter", "subject": "數學", "chapter": "向量內積", "bucket": "remedial",
   "baseline": { "graded": 6, "wrong": 5, "wrong_rate": 0.8333, "low_sample": false },
   "error_focus": { "type": "concept", "count": 3, "share": 0.75, "applied": true } },
 { "unit_type": "kc", "subject": "數學", "chapter": "向量的加減與係數積", "kc_id": 9, "bucket": "prerequisite",
   "baseline": { "graded": 0, "wrong": 0, "wrong_rate": null, "low_sample": true } }]
```

- `baseline`：與弱點排序同一份聚合（只算第一次作答）。`wrong`＝批改量 − 答對量（部分給分按比例；知識點依權重）；
  `wrong_rate`＝`wrong ÷ graded`（`graded = 0` 時 `null`）；`low_sample` 同第 2.1 節。先備知識點在時間窗內沒有作答時是 0／`null`／`true`。
- `error_focus` 只有補救組、而且該單位有錯因標記時才有（只存代碼、次數、比例、是否套用；標籤讀的時候再查）。
- 章節不在白名單的單位（資料庫裡的舊章節）不放進快照，`notes` 說明不追蹤它們——`confirm-paper` 對章節嚴格驗白名單，伺服器自己產的快照不能被擋。
- 前端確認時把 `targets` 原樣交給 `POST /api/confirm-paper { student_id, question_ids, kind: 'remedial', targets }`；
  只靠「找相似」手動湊的空草稿沒有快照，照一般卷確認。

`confirm-paper` 的驗證（`utils/remedialTargets.js`，排在 retrain 檢查之後；不合法 → 400，什麼都不寫）：

- `targets` 只能搭配 `kind: 'remedial'`；`kind` 只接受 `'remedial'`（`retrain` 由伺服器判斷）；`kind` 有帶時 `targets` 必填，1–12 個。
- 每一層只收列出的鍵（目標：`unit_type`、`subject`、`chapter`、`kc_id`、`bucket`、`baseline`、`error_focus`；`baseline` 四個鍵全部必填；
  `error_focus`：`type`、`count`、`share`、`applied`），多一個鍵就 400。
- `subject` 在科目白名單、`chapter` 在該科章節白名單（`config/chapters.js`）、全部目標同科；`kc_id` 只有知識點單位有、是 int4 範圍內的正整數；
  `bucket` 是 `remedial`／`prerequisite`／`extension`；`graded` 0–10000、`wrong` 0–`graded`、`wrong_rate` 0–1（`graded = 0` 時必須 `null`）、
  `low_sample` 布林；`error_focus` 只有補救組能帶、代碼在錯因白名單、`count` 正整數、`share` 0–1；同一組同一個單位不得重複。
- 回應形狀不變（不多鍵）。

### 10.3 `GET /api/students/:id/remedial-effect?limit=&days=`

- `limit` 1–50（預設 10）：最多幾份補救卷，新到舊（`created_at DESC, id DESC`）。`days` 1–365（選填）：只看補救卷批改完之後幾天內建立的卷。
- 錯誤：`:id` 不合法或學生不存在 → 404；`limit`／`days` 不合法 → 400；`FEATURE_REMEDIAL` 關閉 → 404；還沒套 0022 → 503。

```json
{ "student_id": 3, "limit": 10, "days": null,
  "thresholds": { "improved_delta": 0.1, "worse_delta": -0.1, "min_after_graded": 2, "min_n": 5 },
  "papers": [{ "paper_id": 41, "title": "王小明-向量內積特訓卷(2026_10_3)", "created_at": "…", "graded": true,
               "assigned_count": 5, "graded_count": 5, "anchor_at": "…",
               "targets": [{ "unit_type": "chapter", "subject": "數學", "chapter": "向量內積", "name": "向量內積", "bucket": "remedial",
                             "error_focus": { "type": "concept", "count": 3, "share": 0.75, "applied": true, "label": "觀念不清" },
                             "before": { "graded": 6, "wrong": 5, "wrong_rate": 0.8333, "correct_rate": 0.1667, "low_sample": false },
                             "on_paper": { "assigned": 5, "graded": 5, "correct": 3, "rate": 0.6 },
                             "after": { "graded": 3, "correct": 3, "rate": 1, "papers": 1 },
                             "delta": 0.8333, "low_sample": true, "status": "improved" }] }] }
```

只列補救組的目標（先備、延伸的快照留著，但不算成效）。知識點單位多 `kc_id`、`code`，`name` 是知識點現在的名稱。

| 欄位 | 定義 |
|---|---|
| `before` | 快照（出卷當下），事後**不重算**：弱點面板的數字會隨新的批改一直變，重算出來的不是「補救前」。`correct_rate`＝1 − `wrong_rate` |
| `on_paper` | 這張補救卷上、這個單位的題：`assigned`（派了幾題）、`graded`、`correct`、`rate`。只供參考，不進 `status` |
| `graded`（卷） | 卷上**每一題**都批改了（含卷上的重練題，`assignment_attempts`） |
| `anchor_at` | 「之後」的起算時間：批改完＝最後一題的 `graded_at`；還沒批改完＝建卷時間 |
| `after` | **其他**卷上、這個單位的作答，卷的建立時間 > `anchor_at`（有 `days` 時再 ≤ `anchor_at + days`）；`papers`＝有批改的卷數。沒有卷號的歷史作答不算 |
| `delta` | `after.rate − before.correct_rate`，小數第 4 位；任一邊沒有資料時 `null` |
| `low_sample` | `after.graded < WEAKNESS_MIN_N`（同弱點面板，預設 5） |

共同規則：只算**每題第一次作答**（檢視 `attempts`，R10；重練與回測的效果看「重練成效」）；正確度＝`COALESCE(score, result)`；
已批改＝`result IS NOT NULL`；知識點單位依 `question_kcs.weight` 加權、只算同科標註；章節單位每題權重 1。

### 10.4 狀態（`services/remedialEffectService.js` 的具名常數）

依序判斷：

| `status` | 條件 |
|---|---|
| `pending` | 補救卷還沒批改完（`graded = false`） |
| `insufficient_data` | 補救前沒有批改資料（`before.correct_rate = null`），或 `after.graded < MIN_AFTER_GRADED`（**2**；知識點為加權題數） |
| `improved` | `delta ≥ IMPROVED_DELTA`（**+0.10**，即答對率高 10 個百分點以上） |
| `worse` | `delta ≤ WORSE_DELTA`（**−0.10**） |
| `no_change` | 其餘 |

`low_sample` 與 `status` 分開：2–4 題就判斷方向，但標「樣本少」；這三個門檻都待 Owner 確認。

### 10.5 畫面

學生分頁「依弱點出補救卷」區塊最下方的「補救成效」：選了學生就讀，確認出卷後重讀。每份補救卷一張卡（卷名、日期、批改進度），
每個補救目標一行：狀態標籤（進步／持平／退步／資料不足／還沒批改完）、單位名稱、`補救前 17%（批改 6 題） → 這張卷 60%（5/5 題已批改） → 之後 100%（批改 3 題），變化 +83 個百分點`，
之後批改量不到 `WEAKNESS_MIN_N` 時多一個「樣本少」標籤，依錯因出題的目標另標主因。

### 10.6 已知限制

- 「之後」以卷的**建立時間**比補救卷**最後一題的批改時間**：補救卷批改完之前就出的卷不算（學生寫那張卷時，老師還沒看過補救卷的結果）；
  補救卷之後又改批改（重新存批改卡）時，起算時間跟著往後移。
- 補救卷上某個目標的題全部被老師在草稿裡刪掉，快照仍在：`on_paper.assigned = 0`，`status` 照「之後」判斷。
- 只追蹤經由草稿確認的補救卷（0022 之前出的補救卷是 `normal`，沒有快照）。

---

## 11. 題庫不夠時自動補題（〔dec/r16-remedial〕）

補救卷草稿某個補救目標回報「庫存不足」時，老師按那一行的「**生成變式補題**」：系統拿這位學生在那個單位答錯的題當藍本，
走既有的變式 job（`POST /api/questions/:id/variants` 背後的同一套：`services/variantService.js`、`agents/generateVariant.js`、
job runner）出變式。生成好的題停在「待複核」，老師核准後重新產生草稿就抽得到。需要 `FEATURE_REMEDIAL`＋`FEATURE_VARIANTS`。

### 11.1 `POST /api/students/:id/remedial-paper/fill-shortfall`

body（只收列出的鍵）：

| 鍵 | 必填 | 規則 | 預設 |
|---|---|---|---|
| `subject` | ✅ | 科目白名單 | — |
| `days` | | 1–365：錯題看多久以內的（同草稿的時間窗） | 90 |
| `difficulty_delta` | | −1／0／1（同 `variants` 端點） | 0 |
| `units` | ✅ | 1–3 個 `{ unit_type: 'chapter'\|'kc', chapter, kc_id?（kc 必填）, needed（1–50）, error_type?（錯因代碼） }`；章節在白名單、不重複 | — |

前端由草稿的 `blueprint` 列組出來：`needed`＝要的 − 找到的；錯因主因有套用時帶 `error_type`；知識點目標的 `blueprint` 列另帶 `kc_id`。

回應（有建新 job 時 202，否則 200）：

```json
{ "student_id": 3, "subject": "數學", "max_generate": 5, "generating": 3, "capped": false, "retrieved_ids": [52],
  "units": [{ "unit_type": "chapter", "chapter": "向量內積", "needed": 4, "sources_found": 3, "generating": 3, "unplanned": 0,
              "items": [ { "source_question_id": 41, "mode": "retrieved", "retrieved": [{ "id": 52, "chapter": "向量內積", "difficulty": 3, "cosine": 0.91 }] },
                         { "source_question_id": 38, "mode": "generating", "job_id": 12, "state": "queued", "existing": false, "count": 2, "retrieved": [] },
                         { "source_question_id": 30, "mode": "skipped", "reason": "follow_up" } ] }],
  "jobs": [{ "job_id": 12, "state": "queued", "existing": false, "source_question_id": 38, "chapter": "向量內積" }],
  "notes": ["…"] }
```

錯誤：`:id` 不合法或學生不存在 → 404；body 不合法 → 400；任一旗標關閉 → 404（不掛載）；還沒套 0023 → 503（沒有建任何 job）；限流 10 次／分（獨立的桶）。

### 11.2 規則（`services/remedialFillService.js`）

1. **藍本**＝該生在這個單位、時間窗內**第一次作答**（檢視 `attempts`，R10：重練才錯的不算）答錯或部分給分的題，最近的先；
   有 `error_type` 時，標了那個錯因的錯題排前面。承上題（`follow_up`）、沒有向量（`no_vector`）、已封存的題不能當藍本，跳過並回報。
2. **分配**：`needed` 平均分給前幾個藍本（一個藍本一個 job，每個最多 `VARIANT_MAX_PER_REQUEST` 題）；**整個請求最多生成
   `MAX_FILL_GENERATE = 5` 題**，超過的不生成（`capped`、`notes` 說明，核准後再按一次）。藍本不夠分時差的題數在 `unplanned`。
3. **先檢索**：每個藍本先跑 `variantService.findRetrieved`（同科、同難度、不同家族、**該生沒寫過**、餘弦 ≥ 檢索下限）。
   庫裡已經有夠用的相似題就不生成，把題號回報（`retrieved_ids`；老師用題目 ID 加進草稿）；不夠只生成差額。
4. **生成**：`variantService.createVariantJob`（同一藍本已經在跑就合流，`existing: true`，不重複花錢）；`requested.student_id`
   照舊給檢索排除他寫過的題，job 另記 `target_student_id`。變式 job 沒有逐份選引擎：`jobs.engine` 為 NULL＝照 `.env`。
   `VARIANT_AUTO_APPROVE=false`（預設）時生成的題停在複核（`awaiting_approval`）。

**學生資料不出境**：變式 agent 的 input（藍本題目、鄰居、兄弟題幹）與一般的變式完全相同，沒有學生 id 或姓名，所以 prompt 與
cassette 的鍵都不變（整合測試檢查 agent 收到的 input）。姓名只出現在本機的複核畫面。

### 11.3 來源註記（`migrations/0023_remedial_variant_provenance.sql`、`services/remedialProvenance.js`）

- `jobs.target_student_id`：補題 job 為誰出（藍本是既有的 `jobs.source_question_id`）。
- 核准入庫（`POST /api/review/:jqId/approve`）或自動入庫（runner 的 save）時，同一個交易把來源抄到 `questions.target_student_id`
  與 `questions.target_source_question_id`（`variant_of` 是家族根，不一定是那一題錯題）。一般的變式、拆題不寫這兩欄。
- `GET /api/review` 的列與 `GET /api/review/:jqId` 多 `remedial_for: { student_id, student_name, source_question_id }`（只有補題的列有），
  複核卡片顯示「補救卷補題：為 王小明（學生 #3）的錯題 #41 生成」。
- 外鍵都是 `ON DELETE SET NULL`；合併學生把註記搬到目標學生。沒套 0023 的庫讀不到這一欄＝當一般 job，不擋原本的流程。
- 與 0022 分開：0022 動 `exam_papers`（補救成效），0023 動 `jobs`、`questions`（補題來源），兩件功能各自套用、各自驗。

### 11.4 本機模式要多久

變式在本機（`qwen3:8b`，CPU）一題生成的中位數約 **2 分 41 秒**（最慢約 6 分），加上分類、lint、驗算，整條約 **5 分鐘一題**
（上次重錄 60 題整步 17,292 秒，見 `docs/local-mode.md`）。一次最多 5 題 → 大約 **20～30 分鐘**；runner 依 `JOB_CONCURRENCY` 並行，
但本機模型通常一次只跑一支，所以實際接近依序。畫面上的「重新整理進度」讀既有的 `GET /api/jobs/:id`（排隊中／生成中／檢查中／完成，
以及待複核、已入庫、不採用的題數）。Gemini 模式快得多，但每題要花 API 費用（`VARIANT_TOKEN_BUDGET_USD` 照舊是每個 job 的上限）。

---

## 12. 助教的補救卷工具（〔dec/r16-remedial〕）

`FEATURE_REMEDIAL` 開啟時，對話式助教（`services/assistantService.js`）多兩個**只讀**工具：

| 工具 | 參數 | 回傳給主控的內容 |
|---|---|---|
| `plan_remedial_paper` | `student_name`（必填）、`subject`（必填）、`total`（5–50，預設 20）、`days`（1–365，預設 90） | 跑一次 `planRemedialPaper`（與畫面上「產生草稿」同一段程式，**只預覽、不寫庫、不確認出卷**）：`basis`、題數、每個目標的桶／單位／要幾題找到幾題／理由／錯因主因與調整、不足量、notes。不含題目內容 |
| `get_remedial_effect` | `student_name`（必填）、`limit`（1–10，預設 5） | `loadRemedialEffect` 的摘要：每份補救卷的日期、批改完了沒、每個補救單位的狀態、補救前與之後的答對率、樣本少。**不放卷名**（卷名含學生姓名） |

- **旗標關閉（CI 的情況）時一切不變**：系統提示詞（含工具說明書）`SYSTEM`、模板識別名 `assistant.v2` 與它的雜湊、工具清單都與加工具之前逐字相同
  （`test/unit/assistantRemedialTools.test.js` 釘住 SYSTEM 的 sha256 與模板雜湊）。助教沒有 eval suite、`eval/cassettes` 裡也沒有 assistant 的回放檔，
  所以這兩個工具不影響任何 eval 與 cassette。
- **旗標開啟時**用另一份說明書 `SYSTEM_REMEDIAL`（多一句「補救卷同樣只能預覽」與兩個工具）與另一個模板識別名 `assistant.v2+remedial.v1`：
  說明書不同、鍵就不同，不會讀到別份說明書錄的回應。
- 學生姓名照舊不出境（DEC-009）：主控看到「學生#3」，工具參數換回姓名再查；工具結果進 prompt 前一樣經 `pseudo.mask`。

