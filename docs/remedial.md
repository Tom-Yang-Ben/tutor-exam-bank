# docs/remedial.md — 出題閉環：依弱點出補救卷、跨章配額、知識點弱點、題庫覆蓋率

> 產出者：WS-D（階段 5，分支 `stage5/ws-d`）。缺口 G04、G10；需求 DEC-016（待 Owner 簽核）。
> 介面以 `docs/interfaces-stage5.md` 第 4.4 條為準（凍結）；本檔寫的是實作的選題規則、設計取捨與給老師的操作說明，
> 整合階段據此回填 api_spec、openapi、srs 等共用文件（契約第 1.7 條）。
> 工程取捨的決策紀錄：[ADR-014](../engineering_docs/03_architecture/adr/ADR-014-remedial-paper-wilson-quota.md)。

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
  標「承上 #x」、把刪除鈕改成「刪這組」並整組刪——`confirm-paper` 照給的題出卷、**不重驗組是否完整**，
  只刪前題就會出一張有「承上題卻沒有前題」、學生寫不了的卷。
- `target.type` 是 `'kc'` 或 `'chapter'`；`chapter` 基底時 `name` 就是章名、沒有 `code`。
- `blueprint` 每個目標一列；`difficulty_min`／`difficulty_max`／`rationale` 是契約之外**多給**的鍵（前端要顯示「為什麼選這個單位」）。
- `shortfalls` 只列 `got < wanted` 的目標；`reason` 是 `insufficient_stock`（可用題數本來就不夠）或 `follow_up_group`（夠，但承上題組塞不進剩下的名額）。
- 錯誤：`:id` 不合法或學生不存在 → 404；body 不合法 → 400 `{ message }`。
- 該生在此科、時間窗內**完全沒有批改**：200、空草稿，`notes` 說明原因（這不是錯誤，是「還不知道弱點」）。
- 確認：前端把 `question_ids`（刪題、加題後的版本）交給既有的 `POST /api/confirm-paper { student_id, question_ids }`。
  卷名沿用 confirm-paper 的規則（`<姓名>-<第一題的章節>特訓卷(日期)`）；手動加的題由 confirm-paper 驗「還在、沒封存」，
  已寫過的題會回 409（`UNIQUE(student_id, question_id)` 硬閘門，DEC-003 不變）。

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
- 承上題湊不滿的政策與單章路徑是**同一個開關** `FOLLOW_UP_SHORTFALL_POLICY`（`controllers/examController.js`，待 owner 決定）：
  預設 `'note'` 即上一條；切成 `'error'` 時，`reason = follow_up_group` 的列會讓整個請求回 400
  `承上題須與前題整組出題，blueprint 第 N 列「章」無法剛好湊滿…`（同樣帶 `blueprint`／`shortfalls`）。
  「庫存不足」的列不受這個開關影響（同單章路徑）。
- 補救卷草稿（2.2）不看這個開關：它本來就不出卷，不足量一律逐目標回報，由老師在草稿裡補。
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

- **沒有新增 migration、沒有新的環境變數。** 讀的表全是 `stage5/base` 已建好的：
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

---

## 6. 與契約不同之處

| 契約 | 實作 | 理由 |
|---|---|---|
| 第 4.4 條第 5 項：「`public/js/students.js` 唯一的掛鉤：最近錯題的『找相似』結果每列加一顆『加入補救卷』按鈕」 | 按鈕掛在 **`public/js/variants.js`** 的 `findSimilar`（加註〔stage5 WS-D〕），`students.js` 完全沒改 | 「找相似」的結果是 `variants.js` 畫的：`students.js` 只在最近錯題列上發 `examapp:variant-request` 事件，自己沒有結果列可以掛按鈕。掛在 students.js 只能把按鈕放在「錯題本身」上，而錯題學生已經寫過、confirm-paper 必定 409。掛鉤同樣只 dispatch `remedial:add`、`FEATURE_REMEDIAL` 關閉時不顯示 |
| 回應欄位 | `remedial-paper` 的 `blueprint[]` 多 `difficulty_min`、`difficulty_max`、`rationale`；`generate-paper` 的 blueprint 回應多 `note`（有不足時） | 前端要顯示「為什麼選這個單位」；`note` 讓既有組卷畫面不用改就能顯示不足量。契約列出的鍵全部照給 |
| 補救卷的限流 | 四支新端點沒有套 `createRateLimiter` | 契約第 1.2 條的限流要求是針對會呼叫 LLM 的端點；這四支只讀資料庫 |
| 第 4.4 條第 2 項的 `items` 形狀 | 多 `follows_question_id`、`group_ids` | 契約要求候選「套用承上題整組規則」，但草稿交到前端後老師可以刪題、加題，`confirm-paper`（契約：不改）又不重驗組是否完整；前端要知道誰跟誰一組才能整組刪。契約列出的鍵全部照給 |
| 第 4.4 條只列三支 API | 多一支 `GET /api/students/:id/remedial-paper/items`（2.5），同樣在 `FEATURE_REMEDIAL` 後、只讀 | 「用題目 ID 加題」只有 ID，前端不知道那題是不是承上題、前題在不在草稿、是不是別科或已封存；既有 API 沒有「依 ID 查題目」的端點（`GET /api/questions` 沒有 id 篩選、`/similar` 不回 `follows_question_id`，兩者都不屬 WS-D）。沒有這支就只能在確認時才發現、或根本發現不了 |
| 第 4.4 條第 3 項：單章路徑「逐字不變」 | `FOLLOW_UP_SHORTFALL_POLICY` 的效果延伸到 blueprint 分支（2.3） | 那個常數是「承上題湊不滿怎麼辦」的單點切換；只有單章路徑聽它的話，owner 切成 `'error'` 時兩條組卷路徑的行為會不一致。預設 `'note'` 時 blueprint 行為不變 |
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
| 單元 | `test/unit/remedialValidation.test.js` | 補救卷 body（含 mix 總和溢位）、覆蓋率 query、加題查詢的 `ids`、blueprint 驗證與承上題政策開關、候選池 SQL 的參數順序 |
| 單元 | `test/unit/remedialUi.test.js` | 前端檔案契約、純函式、miniDom 渲染（旗標關閉不渲染、草稿、刪題加題、`remedial:add`、確認、覆蓋率）、承上題整組（「承上 #x」、「刪這組」、整組加入或拒絕、不混科、確認前擋缺前題的承上題）、variants.js 掛鉤 |
| 整合 | `test/integration/remedial.pg.test.js` | 旗標關閉 404；kc 加權與 Wilson 排序；kc 基底／chapter 退回；各 bucket 配額；不足量；已作答、封存、跨科、題源排除；家族互斥；承上題整組與 items 的組資訊；不寫庫並接 confirm-paper；加題查詢（承上組成員、封存與已寫過旗標、missing、400／404）；blueprint 的互斥 400、逐列不足、跨列家族互斥與不重複、真出卷；單章路徑收到非字串 chapter 仍是 400 庫存不足；覆蓋率 |

整合測試自己插入知識點、`question_kcs`、`kc_prerequisites`、`attempts` fixture，不依賴 WS-C 的種子檔。

---

## 8. 之後可以做的（不在本階段）

- 錯題重練與間隔複習（G11、G13）：需要 DEC-003 的例外條款與新表，本階段新題組卷仍不重複。
- 掌握度模型（G12 第二步）：資料量夠了再上固定參數 BKT，取代 Wilson 下界排序。
- 題庫不足時自動退回鄰近章節或觸發變式生成（G22）：目前只回報不足量，由老師決定。
- 組卷分頁的跨章配額 UI；助教的 `plan_remedial_paper` 只讀工具。
