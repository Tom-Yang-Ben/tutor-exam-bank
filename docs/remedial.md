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

四支，前三支掛在 `FEATURE_REMEDIAL` 之後（關閉時不掛載，請求落到 Express 預設 404）；
`blueprint` 是既有 `POST /api/generate-paper` 的擴充，**不吃旗標**（它不呼叫 LLM，是組卷核心功能的延伸）。
四支都不呼叫 LLM，前三支不寫資料庫，所以沒有套限流（契約第 1.2 條的限流針對會花錢的端點）。

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
| `mix` | | `{ remedial, prerequisite, extension }` 三個非負數、總和 > 0；只看比例（送 60／20／20 或 0.6／0.2／0.2 相同）；缺鍵或多鍵都 400 | 0.6／0.2／0.2 |
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
      "chapter": "向量內積", "difficulty": 2, "question_text_preview": "設 $\\vec{a}=(1,2)$ …" }
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
- `items` 依 bucket 分組（remedial → prerequisite → extension），同一目標內保持抽出順序。
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
- 卷名：1 章同單章路徑；2–3 章列出（`小明-向量內積、排列特訓卷(…)`）；4 章以上 `小明-向量內積等4章特訓卷(…)`。
- **沒帶 `blueprint`（或為 `null`）時，單章路徑的行為與回應逐字不變**（既有整合測試與 e2e 驗）。

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

---

## 3. 補救卷的選題規則

實作：`services/remedialService.js`（純函式 `buildPlan` 決定「每個目標要幾題、什麼難度」，I/O 的 `planRemedialPaper` 抽題）。

### 3.1 單位與 basis

1. 讀該生在此科、時間窗內的知識點弱點（同 2.1 的計算）。
2. **有知識點標註的已批改題 ≥ `WEAKNESS_MIN_N`（且至少 1 題）→ `basis = 'kc'`**；否則 `basis = 'chapter'`，
   改以章節聚合（正確度同樣是 `COALESCE(score, result)`），同樣用 Wilson 下界由弱到強排序。
   有標註但不夠時，`notes` 第一句說明「只有 N 題，先以章節為單位」。
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
| `services/remedialService.js` | 配額、目標、難度區間（純函式 `buildPlan`）與草稿組裝 |
| `services/coverageService.js` | 覆蓋率 SQL builder 與白名單順序組裝 |
| `controllers/remedialController.js` | 三支 API 的驗證與回應 |
| `controllers/examController.js` | 〔擴充〕候選池抽成 `buildCandidatePoolQuery`／`fetchCandidatePool`、多段配額 `pickByQuotas`、`blueprint` 分支 |
| `routes/index.js` | 〔擴充〕檔尾 WS-D 區塊 |
| `public/js/remedial.js` | `#remedial`、`#coverage` |
| `public/js/variants.js` | 〔擴充〕「找相似」結果的「加入補救卷」按鈕（見第 6 節） |

---

## 5. 給老師的操作說明

先在 `.env` 設 `FEATURE_REMEDIAL=true` 並重啟。學生分頁與題庫管理分頁會各多一個區塊。

### 5.1 出一份補救卷（學生分頁 →「依弱點出補救卷」）

1. **選學生、科目**。題數預設 20；「看哪段批改」預設最近 90 天。
2. **配比**預設補救 60%、先備 20%、延伸 20%。只看比例，填 3／1／1 也一樣。想要一份純補救卷就把先備、延伸填 0。
3. 按「**產生草稿**」。這一步**不會出卷、不會記錄**，可以放心按很多次（每次題目會隨機換一批）。
4. 看草稿：
   - 最上面的標籤告訴你這次是「以知識點判斷」還是「以章節判斷」。題目標好知識點、批改過的題夠多，才會用知識點。
   - 黃色框是系統的說明：例如「先備配額併入補救」「只有 1 個章節有批改紀錄」。
   - 每一組（補救／先備／延伸）下面列出目標單位、為什麼選它（掌握度下界、答對幾題）、要幾題、找到幾題。
     **紅字**表示題庫不夠——到題庫管理的「題庫覆蓋率」看那一章缺什麼難度，補題後再產生一次。
   - 展開「知識點掌握度」可以看到這位學生最弱的 10 個知識點。「樣本不足」表示批改的題還太少，數字只供參考。
5. **調整**：每題右上角「刪除」；下方輸入題目 ID（可一次多個，用逗號分隔）按「加題」。
   也可以在題庫管理分頁「找相似」的結果上直接按「**加入補救卷**」，題目會進到這份草稿的「手動加入」組。
6. 按「**確認出卷**」：這時才建卷、記入作答歷史（之後不會再出給同一位學生）。成功後按「下載 Word 考卷」。
   若出現「部分題目已被指派給該學生」，表示手動加的題他寫過了，刪掉那題再確認。

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
| 補救卷的限流 | 三支新端點沒有套 `createRateLimiter` | 契約第 1.2 條的限流要求是針對會呼叫 LLM 的端點；這三支只讀資料庫 |
| ADR 編號 | 新增 ADR-014（契約第 6 條只分配到 ADR-013） | 任務要求 WS-D 交付 ADR；整合時若要改號，改檔名與本檔連結即可 |

契約沒有寫、由本實作決定的細節（都寫在第 3 節）：k = min(3, ⌈n/2⌉)、先備難度 ≤ 3、延伸難度 ≥ ⌊平均⌋+1、
跨科先備不納入、`WEAKNESS_MIN_N = 0` 時仍至少要 1 題有標註才用知識點基底、完全沒批改時回 200 空草稿。

---

## 7. 測試

| 層 | 檔案 | 驗什麼 |
|---|---|---|
| 單元 | `test/unit/kcWeakness.test.js` | Wilson 下界（n=0、全對、全錯、小數樣本）、SQL 參數順序、排序與 low_sample |
| 單元 | `test/unit/remedialService.test.js` | 最大餘數配額、目標挑選、難度區間、併桶 notes、草稿組裝（注入假依賴） |
| 單元 | `test/unit/coverageService.test.js` | 白名單每章都列、舊章節、unseen 的 null／數字、知識點排序 |
| 單元 | `test/unit/remedialValidation.test.js` | 補救卷 body、覆蓋率 query、blueprint 驗證、候選池 SQL 的參數順序 |
| 單元 | `test/unit/remedialUi.test.js` | 前端檔案契約、純函式、miniDom 渲染（旗標關閉不渲染、草稿、刪題加題、`remedial:add`、確認、覆蓋率）、variants.js 掛鉤 |
| 整合 | `test/integration/remedial.pg.test.js` | 旗標關閉 404；kc 加權與 Wilson 排序；kc 基底／chapter 退回；各 bucket 配額；不足量；已作答、封存、跨科、題源排除；家族互斥；承上題整組；不寫庫並接 confirm-paper；blueprint 的互斥 400、逐列不足、跨列家族互斥與不重複、真出卷；覆蓋率 |

整合測試自己插入知識點、`question_kcs`、`kc_prerequisites`、`attempts` fixture，不依賴 WS-C 的種子檔。

---

## 8. 之後可以做的（不在本階段）

- 錯題重練與間隔複習（G11、G13）：需要 DEC-003 的例外條款與新表，本階段新題組卷仍不重複。
- 掌握度模型（G12 第二步）：資料量夠了再上固定參數 BKT，取代 Wilson 下界排序。
- 題庫不足時自動退回鄰近章節或觸發變式生成（G22）：目前只回報不足量，由老師決定。
- 組卷分頁的跨章配額 UI；助教的 `plan_remedial_paper` 只讀工具。
