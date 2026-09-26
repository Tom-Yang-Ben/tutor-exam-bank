# 錯題重練與間隔複習：設計

> **狀態：已凍結（Owner 2026-09-26 決策單第三輪）。**
> 版本 1.0（2026-09-26 凍結）｜草案分支 `dec/design-retrain-spaced`（基準 `7b7065c`，`local/integration`）；凍結與排程純函式在分支 `dec/retrain-schedule`。
> 〔修訂 2026-09-26 設計審查〕第 6.4 節改成如實列出會改動的既有斷言（含 `students.pg.test.js` 的 EXPLAIN 與 `controllers.pg.test.js` 的觸發器）；第 4.8 節、R3、R6 補上附帶上限與每週重練份量的關係；承上組放不下的處理改列為 R12 待 Owner 決定；R2、R4 選項說明與數字、出處更正。
> 〔修訂 2026-09-26 凍結〕Owner 在「重練與收尾決策單」第三輪逐題答覆了第 8 節的 R1～R12（答覆與日期寫在各題下方，總表在第 8 節開頭）。依答覆改寫的段落：第 0 節；第 1.2 節；第 2.5 節；第 3.4 節（`reason` 改成 `flagged`／`group`／`manual`，`override_at` 改成 `override_on`）；第 3.6 節（R11 不補建，取消補建步驟）；第 3.8 節；第 4.3～4.8 節（R1 由老師勾選、R2～R5 的參數、R12 報錯）；第 5.1～5.6 節（旗標管的事、設定檔、`retrain:rebuild` 改成只重算的 `retrain:recompute`、R6／R7／R12 的 API 行為、操作說明）；第 6 節（FR-036～FR-040、ACPT 定稿，測試計畫）；第 7.1 節；第 9 節。Owner 選的與原建議不同的有三題：**R1**（選 2，老師勾選才進清單）、**R11**（選 3，不補建）、**R12**（選 2，放不下就報錯）。
> 〔修訂 2026-09-26 凍結〕分支 `dec/retrain-schedule` 同時交付排程的純函式與設定：`exam_pro/config/retrain.js`、`exam_pro/services/retrainSchedule.js`，單元測試 `test/unit/retrainSchedule.test.js`、`retrainScheduleProperty.test.js`、`retrainConfig.test.js`（TC-038-1、TC-038-2、TC-038-4、TC-038-5）。沒有碰資料表、migration、API 與畫面。
> 〔修訂 2026-09-26 凍結後審查，分支 `dec/retrain-schedule-fix`〕更正「已派出、還沒批改」的範圍（第 4.4、4.6、4.7、5.2、5.5、6.2、6.3、9.1 節）：重練派題沒批改一律算；**新題派題只有派題日 ≥ 起算日才算**。原寫法「任何一筆派題還沒批改」會讓手動加入的以前的題（R11 選 3 唯一的加入方式）永遠不到期：MySQL 時期匯入的舊紀錄 `result` 全是 NULL、對不上卷的 `paper_id` 也是 NULL，批改不了。純函式與測試同步修正（新增 `countsAsInFlight`）。另外：第 4.6 節與 TC-038-4 的隨機測試說明改成如實描述（逐筆批改改驗每一個中間歷史都與參考實作相同；不變量 I7 在 I/O 層的部分由整合測試驗）；第 4.4 節補上「重新加入當天已批改的重練派題」這個邊界。Owner 的答覆與決定沒有變。
> 〔修訂 2026-09-26 第二階段審查修正，分支 `dec/retrain-phase2-fix`〕只新增第 5.6.6 節（審查意見的處理、新 migration `0018_retrain_unflag_marker.sql`、升級步驟、待 Owner 裁決的「判定已會的題被帶著出又答錯」）；其餘各節原文不動。
> **需求來源**：DEC-003 例外條款（錯題重練與間隔複習可再出同一題、每次作答各自記錄；資料層拆「派題」與「作答」，Owner 選 a：拆表）、DEC-016（錯過的題要練到會為止、依間隔複習排程回測）；兩者 2026-09-25 已核准。開發順序依 Owner 決策單 B22（錯題重練 → 間隔複習 → 診斷報告 → …；`docs/HANDOFF.md` 第 0.2 節 G 段）。缺口編號 G11、G13 出自 2026-09-24 缺口分析第 5 節「缺口總表」P1，`engineering_docs/01_requirements/srs.md` 第 1 節「尚未分配 FR」一條也以這兩個編號引用。
> **決策紀錄**：ADR-018（派題與作答拆表，以相容檢視保留既有讀法）、ADR-019（間隔複習採固定關卡、排程為作答歷史的純函式），在 `engineering_docs/03_architecture/adr/`。
> **編號**：功能需求 FR-036～FR-040、驗收 ACPT-036～ACPT-040 依 Owner 答覆**在本檔定稿**（第 6.1、6.2 節）；`engineering_docs/01_requirements/srs.md` 等共用文件的同步由其他分支辦理。migration 寫成「0016 之後的下一號」（0016 可能被同一輪的其他分支用掉），本檔以 **M1**、**M2** 代稱，預計是 0017、0018。
> **不呼叫任何 LLM**：這個功能全是資料庫與純函式，本機模式與 Gemini 模式的行為相同，不需要任何 cassette。
> 共用文件（`engineering_docs/**` 除了新增的兩份 ADR、`docs/HANDOFF.md`、`docs/roadmap-plan.md`、`docs/interfaces-stage5.md`）由文件整合任務依本檔回填，`dec/retrain-schedule` 沒有動。

## 目錄

- [0. 一分鐘看懂](#0-一分鐘看懂)
- [1. 目標與範圍](#1-目標與範圍)
- [2. 現況：作答怎麼記、組卷怎麼排除已作答](#2-現況作答怎麼記組卷怎麼排除已作答)
- [3. 資料模型：派題與作答拆表](#3-資料模型派題與作答拆表)
- [4. 間隔複習排程演算法](#4-間隔複習排程演算法)
- [5. API 與畫面](#5-api-與畫面)
- [6. 測試計畫與驗收](#6-測試計畫與驗收)
- [7. 風險與替代方案](#7-風險與替代方案)
- [8. Owner 的決定](#8-owner-的決定)
- [9. 附錄](#9-附錄)

---

## 0. 一分鐘看懂

**現在**：一題只要出給某位學生過一次，不論對錯，系統就永遠不會再出給他（DEC-003 原條文）。錯題只能靠「找相似」「出變式」間接補強。

**做完之後**，老師的日常會變成（依 Owner 2026-09-26 的決定，第 8 節）：

1. 批改時照常按「對／錯」。想讓學生重練的題，在批改卡上勾「**要重練**」，這一題就進入這位學生的「**錯題重練**」清單；沒勾的題不會進（R1）。清單上也可以手動加入、移出；開啟功能以前的錯題不會自動補進來，要的話在清單上手動加（R11）。
2. 下次出卷時，勾「**附上到期的重練題**」（預設最多為新題數的三成，可改），或按「出一份重練卷」，系統把到期的舊錯題放進卷裡；新題照舊不會重複（R6）。學生的卷面不標哪幾題是重練，老師的標準版答案區、詳解版與批改卡才標（R7）。
3. 批改重練題：**全對才算對**（部分給分沒滿分算錯，R2）；**對了升一關、錯了回第一關**。關卡的間隔是「下一份卷 → 隔 1 週 → 隔 2 週」，**連續對 3 次就算練到會**（R3、R5）。同一題錯滿 3 次標「**卡關**」提醒老師，仍留在清單（R4）。
4. 學生頁多一張「錯題重練」卡：幾題到期、幾題練到會、哪幾題一直錯（卡關），另有「重練成效」表；弱點面板照舊只算每題第一次作答（R10）。

**資料上怎麼做到**：把現在一張 `attempts` 表拆成兩張——「**派題**」（哪一題、哪一天、在哪張卷、派給誰、這次是新題還是重練）與「**作答**」（對錯、部分給分、錯因、學生答案、註記）。「新題每生每題只能派一次」的硬閘門留在派題表上，只管「新題」；重練題另走排程清單。舊的 `attempts` 名字保留成一個唯讀檢視，內容和現在完全一樣（每生每題一列、第一次那次），所以弱點面板、補救卷、覆蓋率等既有功能的讀法與數字都不用改。

**Owner 已經答覆第 8 節的 12 題**（2026-09-26 決策單第三輪），答覆總表在第 8 節開頭；本檔依答覆凍結。

---

## 1. 目標與範圍

### 1.1 目標（可以觀察到的結果）

| # | 目標 | 對應 |
| :--- | :--- | :--- |
| 1 | 答錯的題能再出給同一位學生重做，每次作答各自留下紀錄，看得到「第一次錯、第二次對」 | DEC-003 例外條款、G11 |
| 2 | 系統依排程決定每題「什麼時候該再考」，連續答對到門檻才算練到會，之後不再出 | DEC-016、G13 |
| 3 | 出新題的組卷**仍然**排除該生寫過的題，而且由資料庫硬擋，不只靠程式 | DEC-003 原條文 |
| 4 | 沒有使用重練功能時，所有既有 API 的回應、數字與行為與現在逐字相同 | 相容性（同 NFR-009 的精神） |
| 5 | 哪些題要重練由老師決定（批改卡勾「要重練」，R1）；老師看得懂排程為什麼這樣排，也能手動加入、移出、判定已會 | DEC-014「看懂學生」 |

### 1.2 範圍

| 範圍內 | 範圍外（之後的項目，本檔不設計） |
| :--- | :--- |
| 派題與作答拆表、既有資料遷移、相容檢視 | 診斷報告（老師版、家長版，G14） |
| 錯題重練清單（批改卡勾「要重練」建立、手動加入／移出／判定已會／重新加入、承上題整組） | 入班診斷卷（G15）、學習路徑與提示階梯（G17、G18） |
| 間隔複習排程（到期、升關、回第一關、練到會、卡關） | 學生端登入與自助作答（G24） |
| 出卷整合：新卷附帶重練題、獨立重練卷、補救卷附帶；確認出卷；Word 標示 | Word「錯題訂正卷」版本（題後留白、詳解另頁，TEACH-11 的 correction） |
| 老師端畫面（學生頁卡片、組卷頁選項、批改卡勾選框與徽章、學生清單到期數） | 依錯因專練（G16）、變式自動替換原題（R9 選 1：這一輪一律用原題） |
| 重練成效統計（第一次重練答對率、隔週回測答對率、練到會題數、卡關題） | 任何 LLM 功能；跨學生的排程最佳化；上課行事曆 |
| — | 答錯自動進清單（R1 選 2：由老師勾選）；開啟功能前的錯題自動補建（R11 選 3：不補建，老師可手動加） |

### 1.3 設計原則

1. **DEC-003 的硬閘門不鬆**：「新題每生每題一次」仍由資料庫唯一索引保證；例外只開給「在排程清單裡的題」，也由資料庫外鍵保證（第 3.5 節）。
2. **既有讀法不動**：舊的 `attempts` 以唯讀檢視保留原本的欄位與語意（每生每題一列＝第一次派題）。凍結的弱點 SQL、候選池 SQL 一個字都不用改。
3. **排程是作答歷史的純函式**：每題的關卡、到期日、連對次數都能從「這位學生這一題的全部作答」重算出來。改判、取消批改、刪卷之後重算即可，不會留下算錯的狀態；之後要換演算法也不會丟資料。
4. **老師最後決定**：進不進清單由老師勾（R1 選 2）；系統只提議（到期清單、卡關提醒），出不出、移不移出由老師按。
5. **沿用專案慣例**：伺服器端白名單與 CHECK、純函式 SQL builder、同一交易全有全無、功能旗標預設關、路由附加在檔尾、前端 `textContent`、繁體中文註解。

---

## 2. 現況：作答怎麼記、組卷怎麼排除已作答

### 2.1 `attempts` 現在記什麼

`migrations/0001_init.sql` 建立、`0010` 加批改細節。**一列＝一位學生被派到一題**，派題與作答混在同一列：

| 欄位 | 語意 | 來源 |
| :--- | :--- | :--- |
| `id` BIGINT | 流水號 | 0001 |
| `student_id`、`question_id` | 誰、哪一題；`question_id` 外鍵 `ON DELETE RESTRICT`（作答紀錄不隨題目消失） | 0001 |
| `paper_id` | 哪張卷（可為 NULL：階段 1 從 MySQL 匯入的歷史紀錄） | 0001 |
| `assigned_at` DATE | 派題日；弱點面板的時間窗以它計算 | 0001 |
| `result` 0／1／NULL、`graded_at` | 對錯；NULL＝未批改 | 0001 |
| `score`、`error_types`、`response`、`teacher_note` | 部分給分、錯因、學生答案、老師註記 | 0010 |
| **`UNIQUE (student_id, question_id)`** | 「不重複出題」的伺服器端硬閘門 | 0001 |

### 2.2 組卷怎麼排除已作答（FR-008）

- **候選池**：`controllers/examController.js` 的 `buildCandidatePoolQuery`（第 105 行）
  `AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $3)`。
  單章組卷、跨章配額（blueprint）、補救卷共用這一段。
- **寫入閘門**：`writePaper`（第 588–615 行）在同一交易建卷並
  `INSERT INTO attempts … ON CONFLICT (student_id, question_id) DO NOTHING`，再檢查寫入筆數；少了就整筆回滾、回 409（兩個請求同時搶同一題時，後者失敗而不是悄悄少一題）。
- **確認出卷**：`confirmPaper`（第 626 行）不重跑抽題，只重驗「題目還在、沒封存」，走同一個 `writePaper`。
- **刪卷**：`deletePaper`（第 682 行）同交易刪該卷的 attempts 與卷本身——被這張卷「燒掉」的題回到候選池（批改紀錄一起消失）。
- 其他地方同樣用 `NOT EXISTS attempts` 判斷「他寫過沒」：找相似（`queries/hybrid.js:107`）、NLQ 規則路徑（`services/nlqService.js:554`）、變式的檢索優先（`services/variantService.js:168`）、覆蓋率的「還沒寫過」（`services/coverageService.js:42`）、補救卷加題查詢的 `answered`（`services/remedialService.js:377`）。

### 2.3 誰在讀寫 `attempts`

依「要的是什麼語意」分四類。這張表決定了第 3 節每一處要不要改：

| 類別 | 位置 | 要的語意 |
| :--- | :--- | :--- |
| **A. 排除（他寫過沒）** | `examController.js:105`、`hybrid.js:107`、`nlqService.js:554`、`variantService.js:168`、`coverageService.js:42`、`remedialService.js:377`、`questionController.js:462、560`（刪題保護：有作答就改封存） | 這題**曾經派給**他過沒 |
| **B. 診斷（他會不會）** | `weaknessService.js:54、126、148、196`（章節／題型／難度、週趨勢、最近錯題、錯因分布）、`kcWeaknessService.js:100、139`（知識點掌握度、basis 判斷）、`remedialService.js:329`（章節基底掌握度）、`tutorService.js:481`（家教的錯因摘要）、`studentController.js:135`（最近錯題的批改細節，以 `(student_id, question_id)` 對應） | 他第一次遇到這題的表現 |
| **C. 卷層（這張卷每一題）** | `paperController.js:284`（試卷明細）、`paperController.js:363`（批改 PATCH）、`studentController.js:185`（學生清單的批改完成率）、`studentController.js:213`（試卷列表的已批改數）、`assistantService.js:63`（助教 `list_students` 的計數） | 這張卷上**所有**派題與作答 |
| **D. 寫入** | `examController.js:596`（writePaper）、`:688`（deletePaper）、`studentAdminController.js:121`（刪學生）、`:160–168`（合併學生）、`paperController.js:363`（PATCH）、`migrate/import_pg.js:259、273`（階段 1 的 MySQL 切換工具，已完成的一次性任務）、`eval/lib/pgEngine.js:130`（eval 灌 fixture 前 TRUNCATE）、測試夾具（23 個測試檔、約 46 處 INSERT／UPDATE／DELETE／TRUNCATE；另有 `controllers.pg.test.js` 掛在 `attempts` 上的 BEFORE INSERT 觸發器） | — |

### 2.4 卡在哪

- `UNIQUE (student_id, question_id)` 讓同一題對同一位學生只能有一列：重派必定 409。
- 批改直接覆寫那一列的 `result`：就算能重派，第二次作答也會蓋掉第一次。
- 候選池的 `NOT EXISTS attempts` 本身沒有問題——新題本來就該排除寫過的題；問題在於它和「一題只能有一列」綁在一起。

### 2.5 要改哪裡，才能「新題組卷仍排除已作答、重練卻能再出」

| # | 改動 | 為什麼 |
| :--- | :--- | :--- |
| 1 | **閘門搬家**：`UNIQUE (student_id, question_id)` 改成派題表上的部分唯一索引，只管「用途＝新題」的列 | 新題仍然每生每題一次；重練列不受限 |
| 2 | **排除規則不動**：`attempts` 改成唯讀檢視，只列「新題」那一次派題（每生每題最多一列，和現在一樣）；再加一條由外鍵保證的不變量「重練派題一定有同生同題的新題派題」 | 有了這條不變量，「有新題派題」＝「曾經派過」，A 類八處查詢不用改就是對的 |
| 3 | **重練走另一條路**：重練題不經候選池，而是從排程清單（`retrain_items`）挑到期的；確認出卷時寫成「重練」派題並連到清單項目 | 重練題本來就不是「新題」，不該和候選池混在一起 |
| 4 | **寫入點改寫**（D 類）：寫派題表與作答表，而不是寫檢視 | 檢視是唯讀的，寫錯地方會立刻報錯（不會靜默） |
| 5 | **卷層讀取改讀全部派題**（C 類四處＋助教一處）：改讀另一個檢視 `assignment_attempts` | 重練卷上的題不是「新題」，檢視 `attempts` 看不到它們 |
| 6 | **診斷讀取（B 類）不動**：只算每題第一次作答（R10 選 1，Owner 2026-09-26） | 檢視 `attempts` 本來就只有第一次；日後若改口徑，只要把 B 類改讀另一個檢視 |

---

## 3. 資料模型：派題與作答拆表

### 3.1 概念

```
students ─┬─< assignments（派題）>─── questions
          │      │  purpose = 'new'（第一次）或 'retrain'（重練／回測）
          │      │  1 對 1（紙本一次派題就一次作答；日後學生端可放寬成 1 對多）
          │      ▼
          │   attempt_records（作答：對錯、部分給分、錯因、學生答案、註記、批改時間）
          │
          └─< retrain_items（排程項目：每生每題最多一個）>─── questions
                 source_assignment_id ──► 那一題的「新題」派題（資料庫保證用途是 new）
                 assignments.retrain_item_id ──► 重練派題屬於哪個項目（用途是 retrain 時必填）

唯讀檢視：
  attempts            ＝ 新題派題 ⟕ 作答（欄位與舊表相同；每生每題最多一列）
  assignment_attempts ＝ 全部派題 ⟕ 作答（含重練）
```

- **派題**（`assignments`）：老師把某一題放進某位學生的某張卷。重練一次就多一筆派題。
- **作答**（`attempt_records`）：那一筆派題的作答與批改結果。
- **排程項目**（`retrain_items`）：一位學生的一題錯題進了清單之後的排程狀態（第幾關、何時到期、連對幾次、錯過幾次、練到會沒）。內容是從作答歷史算出來的快取，加上老師的手動決定。

**命名**：Owner 決定的「作答（attempt）」實體表叫 `attempt_records`，把 `attempts` 這個名字留給相容檢視。理由：`attempts` 被 20 多處程式與測試讀取，名字不變才能讓那些讀法（含凍結的弱點 SQL）一個字都不用改；檢視的內容也正好就是舊表的語意。實體表與檢視的對照寫在第 9.1 節。

### 3.2 M1（0016 之後的下一號）：拆表

檔名草案：`<下一號>_assignment_attempt_split.sql`。**只做拆表，不依賴第 8 節的任何決定**，可以先動工。

```sql
-- 派題
CREATE TABLE assignments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id   INT  NOT NULL REFERENCES students(id),
    question_id  INT  NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    paper_id     INT  REFERENCES exam_papers(id),              -- 舊資料可為 NULL（同 0001）
    assigned_at  DATE NOT NULL DEFAULT CURRENT_DATE,
    purpose      TEXT NOT NULL DEFAULT 'new' CHECK (purpose IN ('new', 'retrain')),
    CONSTRAINT assignments_paper_question_key UNIQUE (paper_id, question_id),   -- 一張卷同一題至多一次
    CONSTRAINT assignments_ref_key UNIQUE (id, student_id, question_id, purpose) -- 給 M2 的複合外鍵用
);
-- DEC-003 硬閘門：新題每生每題一次（取代 attempts 的 UNIQUE (student_id, question_id)）
CREATE UNIQUE INDEX assignments_first_exposure_key ON assignments (student_id, question_id) WHERE purpose = 'new';
CREATE INDEX idx_assignments_student_date ON assignments (student_id, assigned_at);
CREATE INDEX idx_assignments_question     ON assignments (question_id);

-- 作答
CREATE TABLE attempt_records (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assignment_id BIGINT NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
    result        SMALLINT CHECK (result IN (0, 1)),
    graded_at     TIMESTAMPTZ,
    score         NUMERIC(3,2) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    error_types   TEXT[] NOT NULL DEFAULT '{}',
    response      TEXT CHECK (response IS NULL OR char_length(response) <= 500),
    teacher_note  TEXT CHECK (teacher_note IS NULL OR char_length(teacher_note) <= 500)
);
CREATE INDEX idx_attempt_records_error_types
    ON attempt_records USING GIN (error_types) WHERE cardinality(error_types) > 0;

-- 搬資料：id 原樣保留（舊 attempts.id = assignments.id = attempt_records.id）
INSERT INTO assignments (id, student_id, question_id, paper_id, assigned_at, purpose)
    OVERRIDING SYSTEM VALUE
    SELECT id, student_id, question_id, paper_id, assigned_at, 'new' FROM attempts;
INSERT INTO attempt_records (id, assignment_id, result, graded_at, score, error_types, response, teacher_note)
    OVERRIDING SYSTEM VALUE
    SELECT id, id, result, graded_at, score, error_types, response, teacher_note FROM attempts;
SELECT setval(pg_get_serial_sequence('assignments', 'id'),     COALESCE(MAX(id), 0) + 1, false) FROM assignments;
SELECT setval(pg_get_serial_sequence('attempt_records', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM attempt_records;

-- 自我檢查：筆數與逐欄內容不一致就 RAISE，整支 migration 回滾（migrate.js 一支一交易）
DO $$ BEGIN
  IF EXISTS (
      SELECT 1 FROM attempts o
        LEFT JOIN assignments s     ON s.id = o.id
        LEFT JOIN attempt_records r ON r.assignment_id = o.id
       WHERE s.id IS NULL OR r.id IS NULL
          OR (o.student_id, o.question_id, o.paper_id, o.assigned_at)
             IS DISTINCT FROM (s.student_id, s.question_id, s.paper_id, s.assigned_at)
          OR (o.result, o.graded_at, o.score, o.error_types, o.response, o.teacher_note)
             IS DISTINCT FROM (r.result, r.graded_at, r.score, r.error_types, r.response, r.teacher_note))
     OR (SELECT count(*) FROM attempts) <> (SELECT count(*) FROM assignments)
     OR (SELECT count(*) FROM attempts) <> (SELECT count(*) FROM attempt_records) THEN
    RAISE EXCEPTION '派題／作答拆表：新舊資料不一致，已回滾';
  END IF;
END $$;

DROP TABLE attempts;
```

接著建兩個唯讀檢視（第 3.3 節）。

### 3.3 相容檢視

```sql
-- 舊的 attempts：欄位名稱與順序與舊表相同（0001 的七欄＋0010 的四欄），最後多一欄 assignment_id。
-- 只列「新題」派題 ⇒ 每生每題最多一列，與舊表的 UNIQUE (student_id, question_id) 同一個語意。
CREATE VIEW attempts AS
SELECT s.id, s.student_id, s.question_id, s.paper_id, s.assigned_at,
       r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note,
       s.id AS assignment_id
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id
 WHERE s.purpose = 'new';

-- 全部派題（含重練）。卷層讀取、重練功能與成效統計用這一個。
CREATE VIEW assignment_attempts AS
SELECT s.id AS assignment_id, s.student_id, s.question_id, s.paper_id, s.assigned_at, s.purpose,
       r.id AS attempt_id, r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id;
```

- **用 LEFT JOIN 而不是 JOIN**：`attempt_records.assignment_id` 有唯一索引，查詢沒用到作答欄位時（例如候選池的 `NOT EXISTS`），PostgreSQL 會把這個 LEFT JOIN 整個拿掉，只剩一次部分唯一索引的查找，效能與現在相同。`error_types` 以 COALESCE 保持舊表「NOT NULL DEFAULT '{}'」的語意。
- **檢視是唯讀的**：程式或測試對 `attempts` 做 INSERT／UPDATE／DELETE／TRUNCATE 會立刻報錯。另加一支單元測試掃描 `controllers/`、`services/`、`workers/`、`scripts/`，禁止出現對 `attempts` 的寫入語句，避免日後有人改回去（第 6.3 節 TC-036-6）。

### 3.4 M2（M1 的下一號）：排程項目

檔名草案：`<下一號>_retrain_items.sql`。放在 M1 之後另一支。〔凍結〕R9 選 1（這一輪一律用原題），追蹤單位維持「題」；R1 選 2（老師勾選才進），`reason` 的 `wrong` 改成 `flagged`；老師手動決定的日期改存 `override_on DATE`，排程純函式用它當「判定已會」的日期。

```sql
CREATE TABLE retrain_items (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id           INT  NOT NULL REFERENCES students(id),
    question_id          INT  NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    source_assignment_id BIGINT NOT NULL,                    -- 這一題第一次（新題）派給他的那一筆
    source_purpose       TEXT NOT NULL DEFAULT 'new' CHECK (source_purpose = 'new'),
    reason               TEXT NOT NULL CHECK (reason IN ('flagged', 'group', 'manual')),
                         -- flagged＝批改卡勾「要重練」（R1 選 2）；group＝承上組的同組題一起進；manual＝在清單上手動加
    entered_on           DATE NOT NULL DEFAULT CURRENT_DATE, -- 起算日：flagged＝勾選那一筆派題的派題日；
                                                             -- group＝同那一題；manual 與重新加入＝加入當天
    -- 以下是排程快取：只由 services/retrainSchedule.js 從作答歷史重算後寫入
    status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'mastered', 'retired')),
    step                 SMALLINT NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 9),
    due_on               DATE,
    streak               SMALLINT NOT NULL DEFAULT 0 CHECK (streak >= 0),
    lapses               SMALLINT NOT NULL DEFAULT 0 CHECK (lapses >= 0),
    last_attempt_on      DATE,
    mastered_on          DATE,
    -- 老師的手動決定：重算時優先
    teacher_override     TEXT CHECK (teacher_override IN ('retired', 'mastered')),
    override_on          DATE,                               -- 手動決定的日期（判定已會時當作 mastered_on）
    note                 TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT retrain_items_student_question_key UNIQUE (student_id, question_id),
    CONSTRAINT retrain_items_ref_key UNIQUE (id, student_id, question_id),
    CONSTRAINT retrain_items_due_check CHECK ((status = 'active') = (due_on IS NOT NULL)),
    CONSTRAINT retrain_items_override_check CHECK ((teacher_override IS NULL) = (override_on IS NULL)),
    -- 不變量 I1 的後半：項目一定指向同生同題的「新題」派題
    CONSTRAINT retrain_items_source_fk FOREIGN KEY (source_assignment_id, student_id, question_id, source_purpose)
        REFERENCES assignments (id, student_id, question_id, purpose) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX idx_retrain_items_due ON retrain_items (student_id, due_on) WHERE status = 'active';

ALTER TABLE assignments
    ADD COLUMN retrain_item_id BIGINT,
    ADD COLUMN retrain_step    SMALLINT CHECK (retrain_step IS NULL OR retrain_step BETWEEN 1 AND 9),
    ADD CONSTRAINT assignments_retrain_link_check CHECK (
        (purpose = 'new'     AND retrain_item_id IS NULL     AND retrain_step IS NULL) OR
        (purpose = 'retrain' AND retrain_item_id IS NOT NULL AND retrain_step IS NOT NULL)),
    -- 不變量 I1 的前半：重練派題一定屬於同生同題的排程項目
    ADD CONSTRAINT assignments_retrain_item_fk FOREIGN KEY (retrain_item_id, student_id, question_id)
        REFERENCES retrain_items (id, student_id, question_id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX idx_assignments_retrain_item ON assignments (retrain_item_id) WHERE retrain_item_id IS NOT NULL;

-- assignment_attempts 檢視在最後追加兩欄（CREATE OR REPLACE VIEW 只能往後加欄）
CREATE OR REPLACE VIEW assignment_attempts AS
SELECT s.id AS assignment_id, s.student_id, s.question_id, s.paper_id, s.assigned_at, s.purpose,
       r.id AS attempt_id, r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note,
       s.retrain_item_id, s.retrain_step
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id;
```

- `retrain_step`：派題當下這題在第幾關（1＝錯題重練，2 以後＝間隔回測）。成效統計用它分開「第一次重練答對率」與「隔週回測答對率」。
- 「已派出、還沒批改」「卡關」不另存欄位，查詢時由作答歷史與 `lapses` 算出（第 4.4 節）：卡關＝`status = 'active'` 而且 `lapses ≥ STUCK_LAPSES`（預設 3，R4）。
- 兩個複合外鍵用 `DEFERRABLE INITIALLY IMMEDIATE`、`NO ACTION`：平常與 RESTRICT 一樣立刻檢查；合併學生要同時改兩張表的 `student_id` 時，交易內 `SET CONSTRAINTS … DEFERRED`，到 COMMIT 才檢查（同 0008 承上題外鍵採 NO ACTION 的理由）。

### 3.5 不變量與誰來守

| 代號 | 不變量 | 誰保證 |
| :--- | :--- | :--- |
| I0 | 新題每生每題至多一次 | 資料庫：`assignments_first_exposure_key`（部分唯一索引） |
| I1 | 每一筆重練派題，同生同題一定有一筆新題派題 | 資料庫：重練派題 → 排程項目（`assignments_retrain_item_fk`）→ 新題派題（`retrain_items_source_fk`，`source_purpose` 只能是 `new`） |
| I2 | 一張卷上同一題至多一次 | 資料庫：`assignments_paper_question_key` |
| I3 | 每位學生每題至多一個排程項目 | 資料庫：`retrain_items_student_question_key` |
| I4 | 一筆派題至多一筆作答（目前） | 資料庫：`attempt_records.assignment_id UNIQUE` |
| I5 | 只有「進行中」的項目有到期日 | 資料庫：`retrain_items_due_check` |
| I6 | 同一個排程項目不會同時被派到兩張還沒批改的卷 | 程式：確認出卷時對項目 `SELECT … FOR UPDATE` 後再檢查（第 5.2 節 API-7） |
| I7 | 排程快取＝作答歷史重算的結果 | 程式：批改、改判、刪卷、合併之後，在同一交易內重算受影響的項目（第 4.6 節） |

**I1 是這份設計的關鍵**：有了它，「這位學生有沒有這一題的新題派題」與「這一題有沒有派給過他（任何用途）」永遠相等，所以 A 類八處排除查詢繼續讀檢視 `attempts` 就是對的，不用改。

### 3.6 既有資料遷移

1. **先備份**（Owner 上線流程第一步就是備份：`npm run db:backup`，`deployment_and_operations.md` §3.4）。
2. `npm run migrate` 套 M1：搬資料、自我檢查、刪舊表、建檢視，全部在一個交易；任何一步失敗整支回滾，資料庫維持原狀。
3. 套 M2：只建新表與新欄位，不搬資料。
4. **不補建**（R11 選 3，Owner 2026-09-26）：開啟功能旗標時不從作答歷史建立任何項目，清單從開啟那天起、由老師在批改卡勾「要重練」或在清單上手動加入才開始有。以前的錯題老師可以手動加（API-2，只收曾經派給這位學生的題）。原草案的 `retrain:rebuild` 補建步驟取消；只重算既有項目的 `npm run retrain:recompute` 見第 5.2 節（改了排程參數之後用）。
5. **驗證腳本**（PR-1 交付）：migration 前後各跑一次，把每位學生的 `GET /api/students/:id/weakness`、`/weakness/kc`、`GET /api/coverage?student_id=`、補救卷的 `basis` 與 `blueprint` 存成 JSON，比對必須逐欄相同。
6. `migrate/import_pg.js`、`export_pg_delta.js`、`verify.js` 是 2026-08-21 MySQL 切換用的一次性工具，寫的是舊 `attempts` 表；M1 之後不再適用，檔頭加註「只適用於 M1 之前的 schema」（寫上 M1 實際分到的編號），不另外改寫。

### 3.7 索引

| 索引 | 服務哪些查詢 |
| :--- | :--- |
| `assignments_first_exposure_key (student_id, question_id) WHERE purpose='new'` | DEC-003 硬閘門；A 類的 `NOT EXISTS`（檢視展開後直接用它） |
| `idx_assignments_student_date (student_id, assigned_at)` | B 類的時間窗（取代舊的 `idx_attempts_student_date`） |
| `idx_assignments_question (question_id)` | 刪題保護、跨學生查某題 |
| `assignments_paper_question_key (paper_id, question_id)` | 試卷明細、批改 PATCH 以（卷, 題）找派題 |
| `idx_attempt_records_error_types`（GIN，部分） | 錯因聚合（沿用 0010 的設計） |
| `idx_retrain_items_due (student_id, due_on) WHERE status='active'` | 到期清單、出卷挑題 |
| `idx_assignments_retrain_item (retrain_item_id)`（部分） | 項目的作答歷史、「已派出待批改」判斷 |

既有 `students.pg.test.js` 的 1,000 筆 fixture 照用（寫入改走 helper）。它的 EXPLAIN 斷言**不能照跑**：斷言寫死舊索引名 `idx_attempts_student_date`，而這個索引隨拆表搬到 `assignments` 並改名；前置的 `ANALYZE attempts` 對檢視只會警告、不收統計。兩處都要改，逐條列在第 6.4 節。PR-1 另加一條 EXPLAIN，確認候選池展開檢視後走的是部分唯一索引。

### 3.8 與補救卷、弱點統計、其他功能的關係

| 功能 | 關係 |
| :--- | :--- |
| 單章／跨章組卷、補救卷的**新題**候選池 | 不變（讀檢視 `attempts`＋I1）。重練題不經候選池。 |
| 補救卷 | 可選加一個「到期重練」組（R6 選 1）。它的 `basis`、弱點排序照舊只看第一次作答（R10 選 1）。 |
| 弱點面板（章節、題型、難度、週趨勢、最近錯題、錯因分布）、知識點掌握度、家教的錯因摘要 | 只算第一次作答（R10 選 1），數字與現在相同；重練的表現另看「重練成效」（FR-040）。 |
| 題庫覆蓋率的「還沒寫過」 | 不變。 |
| 找相似、NLQ、變式檢索的「排除他寫過的題」 | 不變。 |
| 承上題（FR-019、Owner 決策單 B7：確認出卷時伺服器端檢查整組） | 重練以**整組**為單位（第 4.4 節）；B7 的整組檢查要把重練題與新題一視同仁（見第 7.1 節風險 R-9）。 |
| 承上題湊不滿（決策單 B10：直接報錯） | **R12 選 2**：重練題的承上組整組放不進卷時，跟新題一樣直接報錯（400），請老師調整題數（與 B10 一致；第 4.7 節）。 |
| 變式家族互斥 | 新題之間照舊。**R8 選 1**：重練題不佔家族名額，同家族的一題新變式可以和它同卷。 |
| 知識點標註、化學、詳解 | 無關（R9 選 1：重練題就是原題，標註與詳解照用）。 |

### 3.9 刪卷、刪學生、合併學生、刪題

| 動作 | 規則 |
| :--- | :--- |
| **刪卷**（`DELETE /api/papers/:id`） | 一般情形照舊：刪掉該卷的派題（作答跟著 CASCADE）與卷，題目回到候選池。**新規則**：若卷上某題的新題派題是某個排程項目的來源，而那個項目在**別張卷**已經有重練派題，回 409「這張卷有 N 題已經在錯題重練中（重練卷 #…），請先刪除那些重練卷」；項目還沒被重練過就連項目一起刪（老師的勾選跟著那張卷一起消失）。刪的是重練卷時，受影響的項目依剩下的作答歷史重算（等於「那次重練沒發生過」）。沒有任何重練資料時，行為與現在完全相同。 |
| **刪學生** | 同一交易依序刪：重練派題 → 排程項目 → 其餘派題（作答 CASCADE）→ 卷 → 學生。回應 `deleted.attempts` 維持「刪掉幾筆派題」的語意。 |
| **合併學生** | 衝突判斷改看「新題」派題：兩邊都寫過同一題時，**這一題**保留目標側的全部紀錄（含排程項目與重練），來源側這一題的派題、作答、項目一起刪（計入 `dropped_conflicts`）；其餘派題與項目搬到目標學生（交易內延後外鍵檢查），最後重算目標學生受影響的項目。比現在多丟的只有「衝突題在來源側的重練紀錄」，合併本來就少見（打錯名字造成的分身）。 |
| **刪題** | 照舊：有任何派題就只能封存（`questions` 被 `assignments`、`retrain_items` 以 RESTRICT 參照）。封存的題不會被挑進重練卷，清單上標「題目已封存」，由老師移出。 |

---

## 4. 間隔複習排程演算法

### 4.1 條件：家教的實際節奏

- **紙本、一週一到兩次課**：「7 天後到期」和「9 天後到期」實際上都是等下一次上課才出。排程的精度只需要「以週計」。
- **資料很少**：一位學生一週大約 20–40 題，一題錯題一輩子只會重練幾次；任何要「用大量作答資料校準參數」的演算法都會長期不準。
- **一題錯題是一整道數理題**，不是單字卡：學生會記得解法、甚至答案。隔開時間再考，才分得出「真的會」與「剛看過」。
- **老師要看得懂**：清單上每一題都要能說出「為什麼今天到期」。
- **版面有限**：每份卷能分給舊題的位置有限，排程要能在「到期太多」時排優先順序。

### 4.2 三種做法比較（另附 FSRS）

| 做法 | 怎麼排 | 優點 | 缺點 | 適不適合這裡 |
| :--- | :--- | :--- | :--- | :--- |
| **A. 固定間隔**（1／3／7／14／30 天） | 每題依第幾次複習，套同一張間隔表；錯了從頭 | 最簡單、好解釋 | 間隔表以「天」設計，3 天這一格在一週一次課時幾乎用不到；沒有「狀態」概念，錯了怎麼處理要另外定 | 中：概念對，但間隔要改成以週為單位 |
| **B. Leitner 盒** | 每題放在第 k 盒，每盒一個固定間隔；答對升一盒、答錯回第一盒（或降一盒） | 狀態清楚（第幾關）、決定性、可從歷史重算；錯的處理明確；老師一看就懂 | 不因人、因題調整間隔 | **高**：本質上就是「A 加上狀態」，間隔可以直接對齊上課節奏 |
| **C. SM-2 簡化版**（Anki 早期） | 每題有一個「難易係數」，下一次間隔＝上一次間隔×係數；答題品質（0–5）調整係數 | 常錯的題間隔自動變短 | 需要「答題品質」分數，紙本只有對錯與部分給分，要硬湊；係數要好幾次作答才穩；「為什麼是 11 天」很難解釋；對一週一次課的節奏，微調的好處被「等下次上課」吃掉 | 低 |
| （附）FSRS（ts-fsrs） | 以記憶模型預測遺忘機率，排到「快忘時」 | 目前最省複習次數 | 要新增 npm 依賴；參數要用大量作答資料訓練（原本針對單字卡）；老師無法檢查排程理由 | 低（缺口分析曾建議，本檔不採用，理由同 C） |

### 4.3 決定：固定關卡（Leitner 式），間隔對齊上課節奏

〔凍結〕Owner 2026-09-26：R5 選 1（固定關卡）、R3 選 2（對 3 次：重做、隔 1 週、再隔 2 週）、R4 選 1、R2 選 1。決策紀錄見 ADR-019。

| 關卡 | 名稱 | 上一次作答後隔多久到期 |
| :--- | :--- | :--- |
| 第 1 關 | 錯題重練 | 1 天（＝下一份卷就可以出） |
| 第 2 關 | 一週回測 | 7 天 |
| 第 3 關 | 兩週回測 | 14 天 |

- **答對**：升一關，連對次數＋1；連對次數達到門檻 K＝3（R3 選 2）→ **練到會**，不再到期。
- **答錯**：回到第 1 關，連對歸零，錯的次數＋1；錯的次數達 3 次標「**卡關**」提醒老師，仍留在清單、照樣到期，不自動移出（R4 選 1）。
- **答對的定義**：`COALESCE(score, result) ≥ 1`，也就是只有全對才算對：沒給部分分且按「對」，或部分給分給 100%（R2 選 1）。部分給分 80% 也算錯；未作答（`blank`）當然是錯。
- **錯的次數**只算重練與回測；新題（第一次）那一次不算，因為進不進清單是老師勾的（R1 選 2），不看那一次的對錯。
- 參數放在 `exam_pro/config/retrain.js`（同 `config/errorTypes.js` 的做法：教學參數進版控、改一次不需要 migration），註解標〔Owner 決策單 2026-09-26 R*〕；可以用環境變數覆寫（第 5.1 節）。原草案表上的「第 4 關（28 天）」只在把畢業次數改成 4 時才需要，要用時把 `RETRAIN_STEP_DAYS` 設成 `1,7,14,28`、`RETRAIN_MASTERY_STREAK` 設成 `4`。

選 B 的理由：①狀態就是「第幾關」，清單上一眼看得懂；②決定性、可從作答歷史重算，改判與刪卷不會留下錯的狀態；③不需要校準、不需要新依賴；④間隔以週為單位，與一週一到兩次課相符；⑤之後若 Owner 想換 SM-2 或 FSRS，排程是從作答歷史重算的，換演算法不會丟資料（R5）。

### 4.4 規則細節

| 情況 | 規則 |
| :--- | :--- |
| **進清單**（R1 選 2） | 老師在批改卡上勾「**要重練**」並儲存 → 建立項目，`reason = 'flagged'`，起算日＝那一筆派題的派題日，第 1 關，到期日＝起算日＋1 天。**答錯不會自動進清單**；勾選框預設不勾。新題（第一次）那一次的對錯不影響排程，也不算「錯的次數」。旗標關閉時批改卡不顯示勾選框，批改 API 帶勾選回 400（第 5.1 節）。 |
| **老師手動加入** | 在清單上以題號加入；只能加「曾經以新題派給他」的題（I1）；`reason = 'manual'`，從加入當天起算第 1 關。開啟功能以前的錯題也用這個方式加（R11 選 3：不自動補建）。 |
| **取消勾選** | 批改卡上把「要重練」取消並儲存：項目還沒重練過就刪掉；重練過就等同「移出」（設為 `retired`，保留紀錄）。之後再勾回來：項目已刪掉的照「進清單」重建；已移出的等同「重新加入」（起算日＝當天）。 |
| **承上題** | 組內任一題進清單，同組其他題一起進（`reason = 'group'`，起算日同那一題）；挑到期題時以組為單位，組內任一題到期就整組出（組內各題各自記作答、各自升降關）；整組都練到會才不再出。已練到會的同組題被帶著出時答對維持練到會、答錯就重新進行中（回第 1 關）。整組放不進卷時報錯（R12 選 2，第 4.7 節）。 |
| **又錯**（R4 選 1） | 回第 1 關、連對歸零、錯的次數＋1，到期日＝這一筆的派題日＋1 天。錯的次數 ≥ 3 標「卡關」：只提醒，狀態仍是進行中、照樣到期，不自動移出。 |
| **已派出、還沒批改** | 這一題有一筆「算已派出」的派題還沒批改（含取消批改）就不算到期、不會被再出一次（I6）；清單標「已派出（卷 #…）」；超過 14 天未批改另外提醒。**算已派出的**：①重練／回測派題，不論哪一輪；②新題派題，只有派題日 ≥ 起算日（批改卡勾選的那一筆就是這種：取消批改後要批改完才到期）。**起算日之前的新題派題沒批改不算**：手動加入以前的題時（R11 選 3），那一筆可能永遠批改不了——MySQL 時期匯入的舊紀錄 `result` 全是 NULL、對不上卷的 `paper_id` 也是 NULL，而批改只能經 `PATCH /api/papers/:id/results`；算進去的話項目永遠不到期、出卷 409、一加入就跳「超過 14 天未批改」。純函式 `countsAsInFlight` 是這條規則的唯一實作，I/O 層（API-1 的 `in_flight_paper_id`、API-7 的 409 檢查、14 天提醒）照它判斷。 |
| **改判、取消批改、刪卷** | 受影響的項目依剩下的作答歷史重算。進不進清單是老師勾的，所以把新題**改判成對不會讓項目消失**；要移出就取消勾選或在清單上按「移出」。 |
| **封存的題** | 不會被挑進卷；清單標「題目已封存」。 |
| **老師移出／判定已會／重新加入** | 寫在 `teacher_override`（日期寫在 `override_on`），重算時優先：移出＝`retired`；判定已會＝`mastered`（練到會日期＝判定那天；本來就練到會的保留原日期）。重新加入＝清掉 override、起算日改成當天，從第 1 關重來、連對歸零；練到會之後重新加入也一樣。**錯的次數不歸零**（卡關看的是這一題總共錯幾次）。 |
| **同一天多筆** | 依（派題日, 派題編號）排先後逐筆算，各算一次。到期機制平常不會在同一天排兩次；老師手動提早出題時由老師決定。 |
| **起算日當天的重練派題** | 純函式只收日期：派題日 ≥ 起算日的重練派題算在這一輪（手動加入當天就出重練卷時，那一筆要算進來）。**已知邊界**：同一天先批改一筆當天的重練派題、再按「重新加入」，那一筆也會算進新一輪，所以不是從第 1 關、連對 0 開始（只發生在同一天；隔天再按就沒有這個情形）。要完全照「從第 1 關重來」，PR-2 可以在項目上另記「起算時最大的派題編號」，純函式多收一個可選輸入來排除那一筆；這一輪的純函式沒有做。 |
| **派題日是起算點** | 到期日以「派題日」（`assigned_at`，確認出卷那天）起算，不以批改日：批改晚了，題目可能一批改就到期，這是對的（學生實際寫的時間比較接近派題日）。 |
| **「到期」的判斷日** | 出卷時可指定「預計作答日」（預設今天）：到期日 ≤ 那一天就算到期。週日備週三的課時，選週三。 |

### 4.5 例子

學生 A 的一題向量內積（Owner 決定的參數：K＝3、間隔 1／7／14 天；這張表逐列釘在 `test/unit/retrainSchedule.test.js`）：

| 日期 | 事件 | 關卡 | 連對 | 錯次數 | 下次到期 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 10/1 | 新題，批改：錯；老師勾「要重練」 | 第 1 關 | 0 | 0 | 10/2 |
| 10/5 | 重練卷，批改：對 | 第 2 關 | 1 | 0 | 10/12 |
| 10/12 | 附在新卷，批改：錯 | 第 1 關 | 0 | 1 | 10/13 |
| 10/15 | 附在新卷，批改：對 | 第 2 關 | 1 | 1 | 10/22 |
| 10/22 | 附在新卷，批改：對 | 第 3 關 | 2 | 1 | 11/5 |
| 11/5 | 附在新卷，批改：對 | 練到會 | 3 | 1 | — |

弱點面板在這段期間只看 10/1 那一次（錯）（R10 選 1）。「重練成效」（第 5.2 節 API-13）把第 1 關的作答算成「重練」：10/5、10/15 兩次都對；第 2 關以後算成「隔週回測」：10/12 錯、10/22 對、11/5 對，三次對兩次。

### 4.6 從作答歷史重算（純函式）

`exam_pro/services/retrainSchedule.js`（純函式，不碰 DB、不讀 env、不看時鐘；〔凍結〕已在 `dec/retrain-schedule` 交付，參數在 `exam_pro/config/retrain.js`）：

```text
computeRetrainState({ entered_on, teacher_override, override_on, history }, params) → state
  entered_on：起算日（flagged＝勾選那一筆派題的派題日；group＝同那一題；manual 與重新加入＝加入當天）
  history   ：這位學生這一題的全部派題（順序不拘，函式內依 (assigned_at, assignment_id) 排序）；
              每筆 { assignment_id, assigned_at, purpose: 'new'|'retrain', result: 0|1|null, score }
  params    ：config/retrain.js 的 loadRetrainConfig()：
              { stepDays: [1, 7, 14], masteryStreak: 3, stuckLapses: 3, correctThreshold: 1, attachRatio: 0.3 }
              （省略時用 DEFAULTS 常數，不讀 env）
  state     ：{ status, step, due_on, streak, lapses, last_attempt_on, mastered_on,
                in_flight, in_flight_since, stuck }

  從 entered_on 進入第 1 關，到期日＝entered_on＋stepDays[0]。（R1 選 2：項目存在與否由老師決定，
  本函式不判斷「進不進清單」，reason 也不影響排程。）
  逐筆看 history：
    沒批改                 → 跳過；countsAsInFlight 為真（重練派題，或派題日 ≥ entered_on 的新題派題）
                             才 in_flight = true（記最早那一筆的派題日）。起算日之前的新題派題沒批改不算
                             （手動加入以前的題，那一筆可能是批改不了的舊紀錄；第 4.4 節）
    新題（第一次）         → 跳過（對錯不影響排程）
    重練／回測，答錯       → 錯次數＋1（不論哪一輪）
    派題日 < entered_on    → 重新加入之前那一輪：只累計錯次數，不影響關卡
    答對 → 進行中：連對＋1；連對 ≥ K 則練到會（到期日清空），否則升到第「連對＋1」關
           已練到會：維持
    答錯 → 回第 1 關、連對歸零、狀態回到進行中（已練到會的同組題也一樣）
    到期日 = 這一筆的 assigned_at ＋ stepDays[目前關卡 − 1]
  最後套 teacher_override（retired／mastered 優先；mastered 的日期取 override_on，本來就練到會的保留原日期）
  stuck = 進行中 且 錯次數 ≥ stuckLapses（只是提醒，不改狀態與到期日）

isCorrect(attempt)            ：R2，只有全對才算對：已批改 且 COALESCE(score, result) ≥ 1
countsAsInFlight(entry, entered_on)：一筆還沒批改的派題算不算已派出：purpose = 'retrain'，或 assigned_at ≥ entered_on
isDue(state, asOf)            ：進行中 且 沒有已派出 且 due_on ≤ asOf（封存與否由 I/O 層排除）
overdueDays(state, asOf)      ：到期的題回 asOf − due_on，其餘 0
capForAttach(newCount, ratio) ：R6，floor(新題數 × 比例)，且新題＋重練 ≤ 50（第 4.7 節）
```

- **I/O 層**（`services/retrainService.js`，PR-2）：`recompute(client, studentId, questionIds)` 讀歷史 → 呼叫純函式 → 更新項目，**與觸發它的寫入在同一交易**。建立項目只發生在老師勾選、手動加入與承上組帶入（R1 選 2、R11 選 3），重算從不自己建立項目。
- **觸發點**：批改 PATCH（該卷被動到的題，含勾選與取消勾選）、清單上的手動加入／移出／判定已會／重新加入、刪卷、合併學生、`retrain:recompute`（改了排程參數之後）。
- **決定性測試**（第 6.3 節 TC-038-4，`test/unit/retrainScheduleProperty.test.js`，已交付）：固定種子隨機產生 1,000 組作答歷史，與另一種寫法的參考實作逐欄相同、輸入順序無關；再依隨機順序逐筆批改、改判、取消批改，**每一個中間歷史**也都與參考實作相同。純函式每次從頭重算，「逐筆重算的最後結果＝直接算最終歷史」本身必然成立，不拿它當證據；不變量 I7（排程快取＝作答歷史重算的結果）真正的風險在 I/O 層是否在同一交易內更新快取，由 PR-2 的整合測試 TC-038-3、TC-038-4（`retrain.pg.test.js`）驗。
- 日期一律用 `'YYYY-MM-DD'` 字串做日數加減（同 `weaknessService` 對 DATE 的處理），以 UTC 計算，不受伺服器時區影響。

### 4.7 到期、優先順序與上限

- **到期清單**：進行中、到期日 ≤ 預計作答日、沒有已派出待批改（範圍見第 4.4 節：起算日之前的新題派題沒批改不算）、題目沒封存。
- **排序**（到期太多、放不下時先出誰）：逾期天數多的先 → 關卡小的先（剛錯的比較急）→ 錯次數多的先 → 題號小的先。承上組以組為單位、依組內最急的一題排序。
- **上限**（R6 選 1）：附在新卷時，重練題數預設為 `capForAttach(新題數)`＝新題數的三成、無條件捨去（新題 20 題 → 6 題、7 題 → 2 題），而且新題＋重練合計不超過 50 題；這只是出卷畫面預先帶入的數字，老師每次出卷都能改。獨立重練卷最多 50 題（同 `confirm-paper` 上限）。附帶上限和每週重練份量的關係見第 4.8 節：照 Owner 選的參數，附帶只消化得了一部分，其餘靠「出一份重練卷」。
- **承上組放不下**（R12 選 2，與 B10 一致）：依排序逐組放入，承上組不拆開；放到某一組時剩下的名額不夠整組，**整個請求回 400**，不產生草稿，訊息列出那一組的題號，並提示可以改成的題數（放到前一組為止的題數，或含這一組的題數），例如「到期的承上題組（題 812、813、814）共 3 題，放不進剩下的 1 個重練名額；請把重練題數改成 5 或 8。」重練題數剛好放滿時，沒被挑到的題繼續留在到期清單（逾期天數會增加，下次優先）。

### 4.8 份量估算（給 R3、R6 參考）

〔凍結〕Owner 選 R3＝對 3 次、R6＝兩種都有（附帶預設三成＋「出一份重練卷」）。照本節的估算，附帶一週只消化得了重練量的約 1/3～1/6，其餘大約每週要出一份獨立重練卷（約 12～32 題）。R1 選 2（老師勾選才進清單）時，每週實際進清單的題數可能少於下表假設的「每週新錯 6 題」，份量會比表上輕；API-13 的 `backlog` 可以看出實際有沒有越堆越多。

一題錯題要「連續答對 K 次」才畢業。若每次重練答對的機率是 p，平均要重練 (1 − p^K) ÷ ((1 − p) × p^K) 次。假設一位學生**每週新錯 6 題**（例：每週 20 題新題、錯三成）：

| 畢業門檻 | 每次重練都對 | 重練有三成又錯（p = 0.7） |
| :--- | :--- | :--- |
| 對 2 次 | 每週約 12 題舊題 | 約 21 題 |
| 對 3 次（採用） | 約 18 題 | 約 38 題 |
| 對 4 次 | 約 24 題 | 約 63 題 |

意思是：**門檻越高、重練越常又錯，每週要分給舊題的位置就越多**，而版面有上限，多出來的會一直逾期。

**和附帶上限（R6）的關係**：同一個假設下（每週 20 題新題），附在新卷的上限若是新題數的三成（R6 的預設），一週只放得下 6 題舊題：

| 畢業門檻 | 每週要重練 | 附帶放得下 | 附帶消化得了 | 其餘靠獨立重練卷（每週） |
| :--- | :--- | :--- | :--- | :--- |
| 對 2 次 | 12～21 題 | 6 題 | 約 1/2～3/10 | 約 6～15 題 |
| 對 3 次（採用） | 18～38 題 | 6 題 | 約 1/3～1/6 | 約 12～32 題 |
| 對 4 次 | 24～63 題 | 6 題 | 約 1/4～1/10 | 約 18～57 題（上限一份 50 題，可能要兩份） |

一般來說：附帶一週放得下「附帶比例 × 新題數」，要重練的是「錯題率 × 新題數 × 每題平均重練次數」，而平均重練次數至少是畢業門檻 K。附帶比例和錯題率都是三成時，附帶只消化得了 1 ÷ 平均重練次數，最多 1/K。R3 的三個選項 K 都至少是 2，所以**光靠附在新卷，到期清單每週都會變長**。要跟上，只能每週另出一份獨立重練卷（上表最後一欄），或調高附帶比例（對 3 次時要調到新題數的九成到約兩倍，舊題會和新題一樣多甚至更多），或降低門檻。R3 和 R6 因此要一起決定。

本設計另外提供：①「卡關」提醒（同一題錯三次，重做同一題的效益已經很低，應該換成講觀念或出變式）；②成效統計看得到「到期清單有沒有越堆越多」（API-13 的 `backlog`）；③門檻與附帶比例都在設定檔，用一陣子再調。

---

## 5. API 與畫面

### 5.1 功能旗標與設定

| 項目 | 內容 |
| :--- | :--- |
| 旗標 | **`FEATURE_RETRAIN`**（錯題重練與間隔複習；預設關；`config/features.js` 加 getter；前端 `<meta name="feature-retrain">`、`app.js` 注入 `__FEATURE_RETRAIN__`）。名稱避開 `review`：`/api/review` 與 `reviewController` 已是拆題的「人工複核佇列」（FR-006）。 |
| 旗標管什麼 | 新 API 是否掛載、畫面是否顯示、批改卡是否顯示「要重練」勾選框、批改 API 是否接受勾選（R1 選 2）、出卷 API 是否接受重練參數。開啟旗標**不會**補建以前的錯題（R11 選 3）。 |
| 旗標不管什麼 | M1 的拆表（核心資料層，旗標關也生效）；刪卷／刪學生／合併時的排程處理與既有項目的重算（資料完整性，一律執行）。 |
| 設定檔 | `exam_pro/config/retrain.js`（〔凍結〕已在 `dec/retrain-schedule` 交付）。可用環境變數覆寫的四個：`RETRAIN_STEP_DAYS`（每關間隔天數，預設 `1,7,14`，R3）、`RETRAIN_MASTERY_STREAK`（連對幾次練到會，預設 3，R3）、`RETRAIN_STUCK_LAPSES`（錯幾次標卡關，預設 3，R4）、`RETRAIN_ATTACH_RATIO`（附在新卷的預設上限比例，預設 0.3，R6）。讀法同 `KC_TAG_MIN_CONFIDENCE`：未設或空字串＝預設；非法值退回預設並警告一次；間隔的關數必須 ≥ 畢業次數（較多時只用前 K 個，較少時兩者一起退回預設）。固定、不開放覆寫的：`CORRECT_THRESHOLD`＝1（R2）、`MAX_PAPER_QUESTIONS`＝50（同 `confirm-paper` 上限）。Owner 已經決定、不做成開關的行為：R1（老師勾選才進）、R7（學生版不標）、R8（重練題不佔家族名額）、R9（原題）、R10（弱點只算第一次）、R11（不補建）、R12（放不下就報錯）；日後要改是改程式與本檔，不是改設定。PR-2 另加 `IN_FLIGHT_WARN_DAYS`（已派出多久未批改要提醒，14 天）。 |
| 限流 | 不需要：全部不呼叫 LLM（同裁決 S5-25 對 WS-D 四支端點的處理）。 |
| 個資 | 回應只給老師端畫面；log 只記學生 id，不記姓名；不送任何外部服務。 |

### 5.2 API

新增的六支都在 `FEATURE_RETRAIN` 之後（關閉時不掛載、落到 Express 預設 404），附加在 `routes/index.js` 檔尾一個區塊。擴充的既有端點「沒帶新參數時逐字不變」。

| # | 端點 | 類型 |
| :--- | :--- | :--- |
| API-1 | `GET /api/students/:id/retrain-items` | 新增 |
| API-2 | `POST /api/students/:id/retrain-items` | 新增 |
| API-3 | `PATCH /api/students/:id/retrain-items/:itemId` | 新增 |
| API-4 | `GET /api/retrain/summary` | 新增 |
| API-5 | `POST /api/students/:id/retrain-paper` | 新增（只產草稿） |
| API-6 | `POST /api/generate-paper` 加 `retrain` | 擴充 |
| API-7 | `POST /api/confirm-paper` 加 `retrain_question_ids` | 擴充 |
| API-8 | `POST /api/students/:id/remedial-paper` 加 `retrain_count` | 擴充（R6） |
| API-9 | `GET /api/papers/:id` 每題加 `purpose`、`retrain_step`、`retrain_flagged` | 擴充 |
| API-10 | `PATCH /api/papers/:id/results` 每題可帶 `retrain`（「要重練」勾選，R1），回應加 `retrain` 摘要 | 擴充 |
| API-11 | `DELETE /api/papers/:id` 新增 409 情形 | 擴充 |
| API-12 | `POST /api/download-word` 加 `paper_id`（標示重練題，R7） | 擴充 |
| API-13 | `GET /api/students/:id/retrain-stats` | 新增 |
| CLI | `npm run retrain:recompute -- [--dry-run] [--student <id>] [--test]`（只重算既有項目；原草案的 `retrain:rebuild` 補建因 R11 選 3 取消） | 新增 |

**API-1 `GET /api/students/:id/retrain-items?status=&subject=&as_of=`**

- `status`：`active`（預設，進行中，含到期與未到期）｜`due`｜`in_flight`｜`stuck`｜`mastered`｜`retired`｜`all`；`as_of`：預計作答日 `YYYY-MM-DD`，預設今天；`subject` 在白名單內。
- 回應：

```json
{
  "as_of": "2026-10-12",
  "counts": { "active": 14, "due": 6, "in_flight": 2, "stuck": 1, "mastered": 9, "retired": 1 },
  "items": [
    { "item_id": 31, "question_id": 812, "subject": "數學", "chapter": "向量內積", "difficulty": 3,
      "question_type": "填空", "question_text_preview": "設 $\\vec a=(1,2)$ …", "archived": false,
      "reason": "flagged", "status": "active", "step": 2, "step_label": "一週回測",
      "due_on": "2026-10-12", "due": true, "overdue_days": 0,
      "in_flight": false, "in_flight_paper_id": null,
      "streak": 1, "lapses": 0, "stuck": false, "mastered_on": null, "teacher_override": null,
      "group_ids": [812], "follows_question_id": null,
      "history": [
        { "assignment_id": 5501, "paper_id": 88, "assigned_at": "2026-10-01", "purpose": "new",
          "retrain_step": null, "result": 0, "score": null, "error_types": ["calc"] },
        { "assignment_id": 5630, "paper_id": 91, "assigned_at": "2026-10-05", "purpose": "retrain",
          "retrain_step": 1, "result": 1, "score": null, "error_types": [] }
      ] }
  ]
}
```

- 排序同第 4.7 節。錯誤：學生不存在 404；參數不合法 400 `{ message }`。

**API-2 `POST /api/students/:id/retrain-items`**：body `{ question_ids: [正整數, …] }`（1–50 個）。逐題加入（`reason = 'manual'`，起算日＝當天；承上組同組題以 `group` 一起加）。開啟功能以前的錯題也從這裡加（R11 選 3）。回 `{ added: [{ question_id, item_id }], skipped: [{ question_id, reason }] }`，`reason` 為 `not_assigned`（沒派給他過）、`already_in_schedule`、`archived`、`missing`。那一筆新題派題有沒有批改都可以加，**沒批改也不會擋住排程**（它早於起算日，不算已派出，第 4.4 節）：加入後照常隔天到期。

**API-3 `PATCH /api/students/:id/retrain-items/:itemId`**：body `{ action: 'retire' | 'mark_mastered' | 'reactivate', note? }`（`note` ≤200 字）。`retire`、`mark_mastered` 寫 `teacher_override` 與 `override_on`（當天）；`reactivate` 清掉 override、起算日改成當天（練到會的題也可以重新加入，從第 1 關重來，錯的次數不歸零）。回更新後的項目（形狀同 API-1 的一筆）。項目不屬於該生 404；不認得的鍵或 action 400（同裁決 S5-21 的嚴格驗證）。

**API-4 `GET /api/retrain/summary?as_of=`**：學生清單的到期徽章用。回 `{ as_of, items: [{ student_id, due, in_flight, stuck, active }] }`（不回姓名，前端以 id 對應既有學生清單）。

**API-5 `POST /api/students/:id/retrain-paper`**（只產草稿、不寫入）：body `{ subject?, count?(1–50，預設 10), as_of?, include_not_due?(預設 false) }`。回：

```json
{
  "student_id": 3, "subject": "數學", "as_of": "2026-10-12",
  "question_ids": [812, 640, 641],
  "items": [
    { "question_id": 812, "item_id": 31, "step": 2, "step_label": "一週回測", "due_on": "2026-10-12",
      "overdue_days": 0, "chapter": "向量內積", "difficulty": 3, "question_text_preview": "…",
      "follows_question_id": null, "group_ids": [812] }
  ],
  "due_total": 6,
  "notes": ["到期 6 題，本草稿放 3 題（題數上限）；其餘留在清單，下次優先。"]
}
```

確認走 API-7：`confirm-paper { student_id, question_ids, retrain_question_ids: question_ids }`。純重練卷的卷名為「`<姓名>-錯題重練卷(日期)`」。承上組整組放不下 `count` 時回 400（R12 選 2，訊息見第 4.7 節），不產生草稿。

**API-6 `POST /api/generate-paper` 加 `retrain: { count, as_of? }`**

- 單章與 blueprint 兩條路徑都接受；`count` 0–50，新題題數（既有的 `count`／blueprint）語意不變，重練題**另外加上**（R6 選 1：前端預先帶入 `capForAttach(新題數)`＝新題數的三成、無條件捨去，老師可改）；新題＋重練合計不得超過 50 題（`confirm-paper` 的上限），超過 400。
- 新題照既有流程抽；重練題依第 4.7 節挑，承上組整組放不下時回 400（R12 選 2）；兩者合併後用既有的 `sortForPaper` 排序，重練題與新題一起依題型、難度排，卷面不另分區（R7 選 1）。
- 變式家族：重練題不佔家族名額，同家族的一題新變式可以同卷（R8 選 1）；新題之間的家族互斥照舊。
- 回應多 `retrain: { wanted, got, due_total }`，`questions[i]` 多 `purpose`、`retrain_step`（只有帶 `retrain` 時才多，沒帶時回應逐字不變）。
- `FEATURE_RETRAIN` 關閉卻帶了 `retrain` → 400 `retrain 需要開啟 FEATURE_RETRAIN。`（讓老師知道沒生效，而不是靜默忽略）。
- 非 `dry_run` 路徑直接寫入時，與 API-7 同一套寫入規則。

**API-7 `POST /api/confirm-paper` 加 `retrain_question_ids: int[]`**（必須是 `question_ids` 的子集）

- 交易內：對這些題的排程項目 `SELECT … FOR UPDATE`，逐題檢查「屬於這位學生、進行中或已會（被承上組帶著出）、沒有已派出待批改（以 `countsAsInFlight` 判斷，第 4.4 節）」；不符 → 409 `題目 <id> 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`
- 寫入：重練題寫 `purpose = 'retrain'`、`retrain_item_id`、`retrain_step`（當下關卡）；其餘題寫 `purpose = 'new'`，走原本的 `ON CONFLICT (student_id, question_id) WHERE purpose = 'new' DO NOTHING`＋筆數檢查（衝突 409，訊息不變）。每一筆派題同時建一筆空的作答。
- 承上組完整性：與決策單 B7 的伺服器端檢查共用，重練題與新題一視同仁。
- 沒帶 `retrain_question_ids` → 行為與回應逐字不變。回應多 `retrain_question_ids`（有帶才多）。

**API-8 `POST /api/students/:id/remedial-paper` 加 `retrain_count?`**（0–20，預設 0；`total`＋`retrain_count` 不得超過 50）：多一個 `bucket = 'retrain'` 的組，`blueprint`、`shortfalls`、`notes` 照既有格式回報；承上組整組放不下時回 400（R12 選 2）；確認時前端把這組的題號放進 `retrain_question_ids`。預設 0 時回應逐字不變。補救卷的 `basis` 與弱點排序只看每題第一次作答（R10 選 1）。

**API-9 `GET /api/papers/:id`**：`questions[]` 每題多 `purpose`（`new`／`retrain`）、`retrain_step`（新題為 null）、`retrain_flagged`（新題派題是否被勾了「要重練」，批改卡顯示勾選狀態用；重練題為 null；只有旗標開啟時才多這三個鍵）。實作改讀 `assignment_attempts`，以 `(paper_id, question_id)` 對應。

**API-10 `PATCH /api/papers/:id/results`**：既有的請求鍵、400 訊息、檢查順序、全有全無都不變；改寫 `attempt_records`（經 `assignments` 以卷與題對應）。**R1 選 2**：`results[i]` 另外接受可選的 `retrain: boolean`（批改卡的「要重練」勾選；沒送就不動；只接受新題派題，重練題帶了回 400）：`true` 且還沒有項目 → 建立 `reason = 'flagged'` 的項目（承上組同組題一起進）；`false` → 取消勾選（第 4.4 節）。新規則的檢查排在既有檢查之後；旗標關閉時帶 `retrain` → 400 `retrain 需要開啟 FEATURE_RETRAIN。`。旗標開啟時回應多 `retrain: { entered, advanced, mastered, reset }`（這次批改讓幾題進清單、升關、練到會、回第一關），批改卡據此即時提示。答錯但沒勾的題不會進清單。

**API-11 `DELETE /api/papers/:id`**：見第 3.9 節；新的 409 只在有重練資料時出現。

**API-12 `POST /api/download-word` 加 `paper_id?`**：有帶時伺服器查這張卷每題的 `purpose`，依 R7 選 1 標示：標準版的題目區（會印給學生的卷面）不標、答案區在重練題的題號後加「（重練）」；詳解版在重練題的題號後加「（重練）」；學生版完全不標。沒帶 → 逐位元不變（`edition = 'standard'` 的段落序列與現在相同，同 ACPT-025-1 的比對方式）。

**API-13 `GET /api/students/:id/retrain-stats?days=&subject=`**：

```json
{
  "entered": 25, "active": 14, "mastered": 9, "retired": 2, "stuck": 1,
  "first_retrain": { "graded": 18, "correct": 12, "rate": 0.6667 },
  "spaced":        { "graded": 20, "correct": 17, "rate": 0.85 },
  "backlog": { "due_now": 6, "overdue_7d": 2 },
  "by_chapter": [ { "chapter": "向量內積", "entered": 5, "mastered": 2, "active": 3, "stuck": 0 } ]
}
```

`first_retrain`＝第 1 關的作答，`spaced`＝第 2 關以後；對錯依 R2（全對才算對）；`rate` 四捨五入到小數第 4 位，`graded = 0` 時 null。這就是 R10 選 1 說的「重練成效」表：重練答對率、練到會題數、卡關題。

**CLI `npm run retrain:recompute`**（〔凍結〕取代原草案的 `retrain:rebuild`）：**只重算既有項目**的排程快取（例如 Owner 改了 `RETRAIN_STEP_DAYS` 等設定之後，讓到期日照新參數重排），**不建立任何項目**（R11 選 3：不補建；R1 選 2：進清單要老師勾）；`--dry-run` 在交易內跑完再 ROLLBACK，印出「更新幾個項目、各狀態題數」；可重複執行（冪等）。不呼叫 LLM。

### 5.3 畫面（老師端）

| 位置 | 內容 |
| :--- | :--- |
| **學生分頁 →「錯題重練」卡**（新 module `public/js/retrain.js`，錨點 `#retrain`，放在弱點面板旁） | 上方四個數字：到期、進行中、練到會、卡關。清單依第 4.7 節排序，每列：章節、題幹預覽（MathJax）、關卡標籤、下次到期（逾期標紅）、連對／錯次數、徽章（到期／已派出卷 #…／卡關／已封存）。展開看作答歷史。每列動作：移出、判定已會、重新加入、找相似（沿用既有事件）。上方按鈕：「出一份重練卷」（呼叫 API-5，草稿畫面沿用補救卷的樣式：可刪題、確認、下載 Word）、「手動加入題號」。另有「重練成效」小表（API-13）。 |
| **組卷頁**（`index.html` inline script 最小掛鉤，標〔retrain〕） | 旗標開啟且選了學生時，多一列勾選框「附上到期的重練題 [N] 題（目前到期 M 題）」（R6 選 1，預設不勾），N 預設為 `capForAttach(新題數)`＝新題數的三成、無條件捨去，可改；預覽卡上重練題標「重練・第 2 關」徽章（這是老師看的畫面，R7），可「移除這題」。承上組放不下時顯示伺服器的 400 訊息，請老師改題數（R12）。 |
| **補救卷**（`public/js/remedial.js`） | 配比下方多「到期重練 [N] 題」（R6），草稿多一組「到期重練」。 |
| **批改卡**（`public/js/students.js` 最小掛鉤） | 新題的對錯按鈕旁多一個「**要重練**」勾選框（R1 選 2；預設不勾，答錯也不會自動勾；之前勾過的依 API-9 的 `retrain_flagged` 顯示已勾）；重練題不顯示勾選框，改標徽章「重練・第 n 關」（R7；要移出到清單上按）；儲存後依 API-10 的摘要提示「3 題進入重練清單、1 題練到會」。 |
| **學生清單** | 名字旁小徽章「到期 3」（API-4）。 |
| **試卷列表** | 卷名旁「含重練 4 題」。 |

全部沿用既有慣例：`window.ExamApp` 橋接、伺服器文字一律 `textContent`、科目清單讀 `GET /api/chapter-whitelist`、`npm run check:html` 必須通過、旗標關閉時不渲染。

### 5.4 與 Word 匯出、出卷流程的整合

- **出卷流程不變形**：仍然是「草稿（不寫庫）→ 確認（同一交易寫卷、派題、作答）→ 下載 Word」。重練只是草稿裡多了一種來源、確認時多一個 `retrain_question_ids`。
- **Word**：重練題就是原題（R9 選 1），`download-word` 照 `question_ids` 印，附圖、化學式、三種版本（標準／學生／詳解）全部照舊。唯一的差別是 R7 選 1 的標示（有帶 `paper_id` 才查；學生版與卷面不標，標準版答案區與詳解版標「（重練）」）。題序：與新題一起依題型、難度排，不另分區。
- **卷名**：混合卷沿用現有規則；純重練卷為「`<姓名>-錯題重練卷(日期)`」；Word 檔名跟著卷名與版本（沿用 S5-47 的後綴規則）。
- **不做**：訂正卷（只收錯題、題後留白、詳解另頁）是另一個 Word 版本，不在本範圍。

### 5.5 給老師的操作說明（凍結版；功能做完後以實際畫面為準）

1. `.env` 設 `FEATURE_RETRAIN=true` 並重啟。開啟時清單是空的：以前的錯題不會自動補進來（R11），要的話到學生頁的「錯題重練」卡按「手動加入題號」；當年那張卷有沒有批改都可以加，加入後隔天就到期。
2. 平常批改照舊按對／錯。想讓學生重練的題，勾對錯按鈕旁的「**要重練**」再儲存；沒勾的題（就算答錯）不會進清單（R1）。批改卡儲存後會提示進了幾題。勾錯了，取消勾選再儲存即可。
3. 出卷時勾「附上到期的重練題」，題數預設是新題數的三成，可以改（R6）。預覽卡上有「重練」徽章的就是舊題；不想出的按「移除這題」。到期的題屬於承上題組、整組放不下時，系統會請你改題數（R12）。附帶放不完的到期題（照目前的參數大約每週都會有，第 4.8 節）或考前想集中整理時，到學生頁按「出一份重練卷」。
4. 學生拿到的卷面看不出哪幾題是重練；你的標準版答案區、詳解版與批改卡會標「重練」（R7）。
5. 批改重練題：**全對才算對**，部分給分沒滿分算錯（R2）；對了升一關，錯了回第一關；連對三次（重做、隔 1 週、再隔 2 週）就「練到會」（R3）。清單上的「卡關」表示同一題錯了三次，題目仍留在清單、照樣會到期，建議改講觀念或出變式，而不是再重做同一題（R4）。
6. 覺得某題不必再練，在清單上按「移出」；確定已經會了按「判定已會」；練到會或移出的題想再練，按「重新加入」，從第一關重來。
7. 弱點面板與補救卷的數字只看每題第一次作答，所以不會因為重練而變好看；重練的效果看「重練成效」小表（R10）。
8. 間隔天數、畢業次數、卡關次數、附帶比例可以在 `.env` 改（`RETRAIN_STEP_DAYS`、`RETRAIN_MASTERY_STREAK`、`RETRAIN_STUCK_LAPSES`、`RETRAIN_ATTACH_RATIO`，第 5.1 節）；改完重啟，再執行一次 `npm run retrain:recompute`，清單上的到期日就會照新參數重排。

### 5.6 施工順序與平行化

| PR | 內容 | 相依 | 可平行 |
| :--- | :--- | :--- | :--- |
| **PR-1 資料層拆表** | M1、兩個檢視、D 類寫入點與 C 類讀取點改寫、測試夾具共用 helper（`test/helpers/attempts.js`）、`schema.test.js` 三條斷言依決策改寫、`eval/lib/pgEngine.js` 的 TRUNCATE、遷移驗證腳本、禁止寫檢視的掃描測試 | 不依賴第 8 節；要在同一輪其他分支（B7、B10、B20…）合併之後開工，避免測試檔大量衝突 | 單獨一條，先做 |
| **PR-2 排程核心** | M2、`services/retrainService.js`（I/O）、批改（含「要重練」勾選）／刪卷／合併掛鉤、API-1～4、API-10、API-11、CLI `retrain:recompute`、`config/features.js` 的 `FEATURE_RETRAIN`。〔凍結〕`config/retrain.js` 與 `services/retrainSchedule.js`（純函式）及其單元測試已在 `dec/retrain-schedule` 先交付 | PR-1；R1～R5、R9、R11（已決定） | PR-1 合併後可與 PR-3 平行 |
| **PR-3 出卷整合** | API-5～9、API-12、組卷頁與補救卷掛鉤、Word 標示 | PR-1；PR-2 的純函式介面（已凍結：`capForAttach`、`isDue`、`overdueDays`）；R6～R8、R12（已決定） | 與 PR-2 平行 |
| **PR-4 畫面與成效** | `public/js/retrain.js`、批改卡勾選框與徽章、學生清單徽章、API-13 | PR-2；R10（已決定） | PR-2 的 API 形狀凍結後即可用 mock 開工 |

#### 5.6.1 實作狀態（第一階段：資料層）

> **PR-1 已實作**（分支 `dec/retrain-p1-data-layer`，以本設計稿分支為起點）。只做 DEC-003 例外條款（選項 a）與 DEC-016 已核准的資料層；第 8 節 R1～R11 一題都沒有預設答案，程式裡沒有任何依賴它們的政策（哪些錯題進清單、怎樣算練到會、排程演算法等全部沒做）。
>
> **Migration 編號：M1 = `0016_assignment_attempt_split.sql`**（本分支上 `migrations/` 的最大號是 0015，所以用 0016；同一輪的 `dec/b20-backfill-figures-tool` 也可能用了 0016，整合時由整合任務重新編號，檔內與程式裡提到「0016」的註解要一起改）。M2（`retrain_items`）**還沒建**，留給 PR-2。

| 項目 | 狀態 | 說明 |
| :--- | :--- | :--- |
| M1：`assignments`、`attempt_records`、兩個相容檢視、搬資料＋自我檢查、索引 | ✅ 已實作 | DDL 同第 3.2、3.3 節。冪等照 repo 慣例：`CREATE … IF NOT EXISTS`／`CREATE OR REPLACE`，搬資料整段只在 `attempts` 還是實體表時執行，已拆過的庫再套一次是 no-op；空庫照樣走完 |
| 與第 3.2、3.7 節的差異 | ⚠️ 兩處 | ①索引名沿用舊表的三個名字（`idx_attempts_student_date`、`idx_attempts_question`、`idx_attempts_error_types`，分別建在 `assignments`、`assignments`、`attempt_records` 上），讓既有的 EXPLAIN 斷言（`students.pg.test.js`）與 README 一個字都不用改；②序號接續取「最大 id」與「舊序號已發到哪裡」的較大值＋1，最後幾筆被刪掉時不重用已發出去的 id |
| D 類寫入點改寫 | ✅ 已實作 | `writePaper`（先寫派題、再替寫進去的派題建空白作答；閘門改指名 `assignments_first_exposure_key`，衝突照舊 409）、`deletePaper`、`deleteStudent`、`mergeStudent`、`PATCH /api/papers/:id/results`（改寫 `attempt_records`，經 `assignments` 以（卷, 題）對應）、`eval/lib/pgEngine.js` 的 TRUNCATE |
| C 類讀取點改讀 `assignment_attempts` | ✅ 已實作 | 試卷明細（API-9 的讀法）、學生清單的批改完成率、試卷列表的已批改數、助教 `list_students`。**回應形狀不變**：API-9 要多帶的 `purpose`、`retrain_step` 留給 PR-3（`retrain_step` 是 M2 的欄位） |
| A、B 類讀取 | ✅ 不動 | 讀相容檢視 `attempts`，SQL 一個字都沒改。唯一例外是刪題保護（`questionController.js` 兩處）改讀 `assignments`，語意是第 3.9 節的「有任何派題就只能封存」（有 I1 時兩者相同；M2 之前 I1 還沒有資料庫保證，直接讀實體表比較穩） |
| 第 3.9 節：刪卷、刪學生、合併學生、刪題 | ✅ 已實作（不含排程項目） | 刪卷：這張卷的新題派題若同生同題在別張卷已有重練派題 → 409「這張卷有 N 題已經在錯題重練中（重練卷 #…），請先刪除那些重練卷。」（M2 之前 I1 由這裡守；項目的刪除與重算留給 PR-2）。刪學生：一句刪掉全部派題，`deleted.attempts` 是派題筆數。合併：衝突看目標側的新題派題，衝突題在來源側的新題與重練一起刪（計入 `dropped_conflicts`），其餘搬家（計入 `moved_attempts`）。沒有重練資料時四者的回應與拆表前逐字相同 |
| 功能旗標 `FEATURE_RETRAIN`（第 5.1 節） | ✅ 已加，預設關 | `config/features.js` getter、`<meta name="feature-retrain">`、`app.js` 注入 `__FEATURE_RETRAIN__`。第一階段沒有任何東西讀它（拆表不受旗標管）；旗標關閉（或開啟）時系統行為與拆表前一致 |
| 重練「再出同一題」 | ✅ 只在資料層 | 部分唯一索引只管 `purpose = 'new'`，同一題可以再寫 `purpose = 'retrain'` 的派題、每次作答各自一列。沒有任何 API 會寫重練派題（API-5～8 是 PR-3），測試以 `test/helpers/attempts.js` 直接寫入 |
| 遷移驗證腳本（第 3.6 節第 5 點） | ✅ 已實作 | `node scripts/snapshot_attempt_views.js --out=before.json` → `npm run migrate` → `--out=after.json` → `--compare before.json after.json`（逐欄相同回 0）。只讀不寫；比的是作答逐列摘要與每位學生的弱點、知識點掌握度、補救卷基底、覆蓋率、新題候選池、每張卷的批改數 |
| 一次性切換工具 | ✅ 已加註 | `migrate/import_pg.js`、`export_pg_delta.js`、`verify.js` 檔頭註明只適用於 0016 之前的 schema（第 3.6 節第 6 點） |
| 測試 | ✅ 已實作 | 整合：`assignmentSplit.pg.test.js`（在暫用 schema 上套到 0015、灌舊資料再套 0016：空庫、筆數與 id 與逐欄內容、序號接續、冪等、自我檢查回滾、TC-036-3 黃金比對三百多支查詢、TC-036-4 EXPLAIN、驗證腳本）、`assignmentWrites.pg.test.js`（出卷寫入、新題組卷排除已作答、批改各自記錄、第 3.9 節四個動作、檢視唯讀）。單元：`noWritesToAttemptsView.test.js`（TC-036-6）、`assignmentSplit.test.js`。既有測試：`schema.test.js` 三條依第 6.4 節改寫並加註；夾具改用 `test/helpers/attempts.js`、清表改成 `TRUNCATE attempt_records, assignments, …`，斷言一條都沒改 |
| M2、排程、API-1～13、CLI、畫面 | ⬜ 未做 | PR-2～PR-4；需要第 8 節的答案 |

#### 5.6.2 實作狀態（第二階段之一：PR-2 排程核心）

> **PR-2 已實作**（分支 `dec/retrain-p2-core`，起點 `dec/retrain-base` ＝ `local/integration`＋第一階段資料層＋排程純函式＋排程修正 `dec/retrain-schedule-fix`）。依 Owner 2026-09-26 決策單第三輪（第 8 節）的答覆實作；第 5.6.1 節的原文不動。
>
> **Migration 編號：M2 ＝ `0017_retrain_items.sql`**（M1 已用 0016）。照 repo 慣例可重複套用（`IF NOT EXISTS`、`CREATE OR REPLACE`、DO 區塊判斷約束是否已存在），空庫可從 0001 套到 0017；0016 時期若已有沒有項目的重練派題，0017 直接 RAISE、整支回滾。
>
> **沒做**（留給 PR-3、PR-4）：API-5～8、API-12、組卷頁、補救卷、Word 標示；`public/js/retrain.js`、批改卡勾選框、學生清單徽章、API-13。

| 項目 | 狀態 | 說明 |
| :--- | :--- | :--- |
| M2：`retrain_items`、`assignments.retrain_item_id／retrain_step`、兩個約束、索引、檢視 `assignment_attempts` 往後加兩欄 | ✅ 已實作 | DDL 同第 3.4 節，差異見下表 ①② |
| `services/retrainService.js`（I/O 層） | ✅ 已實作 | 讀作答歷史（檢視 `assignment_attempts`）→ `computeRetrainState` → 只寫回有變的快取欄位；到期清單依第 4.7 節排序；「已派出」一律照純函式 `countsAsInFlight`、「卡關」由 `lapses` 算。會改變歷史或項目的寫入（批改、取消批改、改判、刪卷、刪學生、合併學生、老師的 override、手動加入）與重算在同一個交易（函式收已 BEGIN 的 client）。**鎖**：先 `SELECT … FOR UPDATE` 鎖項目（依 id 排序），再用另一句讀歷史——READ COMMITTED 下等鎖之後的那一句看得到先提交的寫入，兩個交易同時批改同一項目的兩張重練卷，後者重算時兩筆都算到；批改、刪卷、出卷一律「先鎖項目、再動派題與作答」 |
| API-10 批改（`retrain` 勾選） | ✅ 已實作 | 新規則的檢查排在既有檢查（含卷不存在、題目不在卷上、錯因科目限制）之後；旗標關閉帶 `retrain` → 400「retrain 需要開啟 FEATURE_RETRAIN。」；只收新題派題（重練題、卷上沒有派題的題帶了 → 400）；旗標開啟時回應多 `retrain: { entered, advanced, mastered, reset }`。勾選規則見下表 ⑥⑦ |
| API-9 試卷明細 | ✅ 已實作 | 旗標開啟時每題多 `purpose`、`retrain_step`、`retrain_flagged`（接在既有鍵之後）；旗標關閉時 SQL 與回應逐字不變 |
| API-1～4 | ✅ 已實作 | `controllers/retrainController.js`，掛在 `routes/index.js` 檔尾一個區塊，旗標關閉不掛載（Express 預設 404）；參數驗證是純函式 `utils/retrainValidation.js`（不認得的查詢參數與 body 鍵一律 400，同裁決 S5-21） |
| API-11 刪卷、刪學生、合併學生、刪題（第 3.9 節） | ✅ 已實作 | 刪卷的 409 改依排程項目判斷（新題派題 → 以它為來源的項目 → 屬於項目的別張卷重練派題；訊息與回應形狀同 PR-1）；沒重練過的項目隨原卷一起刪；刪重練卷後依剩下的歷史重算。刪學生依序刪重練派題 → 項目 → 其餘派題 → 卷 → 學生。合併學生交易內 `SET CONSTRAINTS assignments_retrain_item_fk, retrain_items_source_fk DEFERRED`，衝突題的來源側項目一起刪、其餘項目搬到目標、最後重算目標學生搬過來的項目。刪題照舊（有任何派題只能封存）。四者不受旗標管 |
| CLI `npm run retrain:recompute -- [--dry-run] [--student <id>] [--test]` | ✅ 已實作 | `scripts/recompute_retrain.js`：只重算既有項目、不建立任何項目；一個交易，`--dry-run` 跑完 ROLLBACK；只寫回有變的列（冪等）；只印題數與學生數 |
| `FEATURE_RETRAIN`、`.env.example` | ✅ | 旗標第一階段已加（`config/features.js`、`<meta name="feature-retrain">`、`app.js` 注入）；`.env.example` 補 `FEATURE_RETRAIN` 與四個 `RETRAIN_*` 的說明（預設值與 R 編號）。`IN_FLIGHT_WARN_DAYS = 14` 是 `services/retrainService.js` 的常數，不開放環境變數覆寫 |
| 測試 | ✅ | 整合：`retrain.pg.test.js`（TC-037-1、TC-037-2、TC-038-3、TC-039-3 的刪卷／刪學生／合併、TC-040-1 的 API-4；旗標開關兩種情形；兩個交易同時操作同一項目；每一步排程快取＝對當下歷史呼叫純函式〔I7〕；重算失敗時整筆回滾）、`retrainMigration.pg.test.js`（0017 空庫套用、約束與不變量、延後檢查、重複套用、0016 有資料時套用與 RAISE）。單元：`retrainValidation.test.js`（API-1～4、API-10 的參數驗證）、`retrainService.test.js`（排序、關卡名稱、已派出、摘要、CLI 參數、0017 靜態檢查）、`retrainScheduleCutoff.test.js`（純函式新增的可選輸入）。既有斷言一條沒改；夾具的改動見下表 ⑬ |

**與本檔（凍結版）不同、或本檔沒寫而由實作決定之處**：

| # | 項目 | 實作 |
| :--- | :--- | :--- |
| ① | `retrain_items.entered_after_assignment_id`（第 3.4 節沒有） | 重新加入（API-3 `reactivate`、批改卡再勾回已移出的題）時寫入「當下這位學生這一題最大的派題編號」（沒有派題時 0）；純函式 `computeRetrainState` 多一個**可選**輸入 `entered_after_assignment_id`（規則 8）：派題日＝起算日、編號 ≤ 它的重練派題算前一輪（只累計錯的次數）。解決第 4.4 節「同一天先批改當天的重練、再按重新加入」的已知邊界。沒給時純函式行為與之前完全相同，已交付的純函式測試一條沒改（新增 `retrainScheduleCutoff.test.js`） |
| ② | 索引與具名約束 | 多一個 `idx_retrain_items_source (source_assignment_id)`（刪卷由新題派題找項目、刪派題時外鍵檢查用）；`assignments.retrain_step` 的 CHECK 以具名約束 `assignments_retrain_step_check` 加上 |
| ③ | API-1 回應 | 每筆除了第 5.2 節例子的鍵，另有 `entered_on`、`in_flight_since`、`in_flight_warn`（已派出超過 14 天未批改；以今天算，不以 `as_of` 算）、`last_attempt_on`、`override_on`、`note`。`counts` 依 `subject` 篩選、不依 `status` 篩選；`counts.in_flight`＝進行中而且已派出。第 4.7 節只規定到期的排序：沒到期的排在後面，進行中依到期日早的先，再來練到會、移出。`step_label` 依間隔天數命名（1＝錯題重練、7 天＝一週回測、14 天＝兩週回測；不是整週時「隔 N 天回測」） |
| ④ | API-2 | `added[i]` 多一個 `reason`（`manual`／`group`）；承上組的同組題（曾以新題派給他、還沒有項目的）以 `group` 一起加，也列在 `added`。已有項目（含已移出）的題一律 `already_in_schedule`，API-2 不改動任何既有項目（已移出的用 API-3 `reactivate`）。同組題已封存也照樣建項目（整組一起進出） |
| ⑤ | API-3 | 回應是 API-1 一筆的形狀，另加 `group_changed: [{ item_id, question_id }]`。`retire` 對整個承上組（同組其他項目一起移出）；`reactivate` 把同組已移出的項目一起帶回（已練到會的組員不動，出卷時照第 4.4 節被帶著出）；`mark_mastered` 只動這一題。對「進行中、沒有 override」的項目 `reactivate` → 409「這一題正在重練中，不需要重新加入。」（避免誤按把進度歸零）；重複 `retire`／`mark_mastered` 是 no-op（保留原本的日期） |
| ⑥ | API-10 的勾選規則（第 4.4 節只寫到單題） | **勾**：這一題沒有項目 → 建 `flagged`（起算日＝這一筆新題派題日）；已有 `group`／`manual` 項目 → 改成 `flagged`（排程不動、不算 entered）；已移出 → 重新加入。同組其他題（曾以新題派給他的）沒有項目 → 建 `group`（起算日同勾選的那一題）；同組已移出的一起重新加入。**取消**：只作用在 `reason = flagged`、沒移出的項目（批改卡不動 `manual`、`group`）：同組還有別題維持勾選 → 這一題改成 `group`；同組已經沒有勾選 → 這一題與同組 `group` 項目一起離開清單（還沒重練過刪、重練過移出），`manual` 不動。答錯但沒勾的題不會進清單；改判成對不刪項目 |
| ⑦ | API-9 的 `retrain_flagged` | ＝以這一筆新題派題為來源、`reason = 'flagged'`、沒被移出的項目存在（老師親手勾的才算；承上組帶進來的與手動加入的顯示為沒勾） |
| ⑧ | API-10 的 `retrain` 摘要 | `entered`＝這次建立或重新加入的項目（含承上組一起進的）；`mastered`＝這次變成練到會；`reset`＝這次多了一次錯（重練或回測答錯，回第 1 關）；`advanced`＝仍在進行中而關卡往上升。這次才進清單的只算 `entered` |
| ⑨ | 旗標關閉時的批改 | 回應照舊只有 `{ updated }`，但既有項目照樣在同一交易內重算（第 5.1 節「旗標不管什麼」） |
| ⑩ | API-4 | 只列有進行中項目的學生，依學生 id 排序；不回姓名 |
| ⑪ | 刪卷的 409 查詢 | 改依排程項目判斷（`retrain_items.source_assignment_id` → `assignments.retrain_item_id`），SQL 另外照舊寫出同生同題、別張卷的條件（兩個複合外鍵保證本來就成立），`assignmentSplit.test.js` 對這支 SQL 的三條既有斷言照樣成立 |
| ⑫ | 合併學生的順序 | 排程項目的刪除與搬家放在「刪衝突題派題」之後、「搬其餘派題」之前：「目標有沒有這一題的新題派題」只能看目標原本的派題 |
| ⑬ | 測試夾具 | `test/helpers/attempts.js` 多收 `retrain_item_id`、`retrain_step`；`purpose = 'retrain'` 而沒給項目時自動找（或建一個 `manual`）同生同題的項目——0017 之後重練派題必須屬於項目。只有這一批有重練派題時寫入語句才多這兩欄，其餘與 0016 時逐字相同。`schema.test.js` 的重練派題夾具改成先建項目再寫（斷言不變，檔內加註） |

**給 PR-3（出卷整合）與 PR-4（畫面與成效）直接呼叫的介面**（`services/retrainService.js`；`db` 可以是 pool、client 或 query 函式；`client` 必須已 BEGIN，由呼叫端 COMMIT／ROLLBACK）：

| 函式 | 用途 |
| :--- | :--- |
| `listDueUnits(db, studentId, { asOf?, subject?, today?, params? })` → `{ as_of, due_total, units: [{ group_ids, size, due_count, overdue_days, items }], blocked: [{ group_ids, reasons: [{ question_id, reason }] }] }` | 到期的重練題，依第 4.7 節排好、以承上組為單位；整組不能出（`not_in_schedule`／`retired`／`archived`／`in_flight`）的放 `blocked`。上限與 R12 的「整組放不下就 400」由 PR-3 依 `units` 的順序逐組放入 |
| `insertRetrainAssignments(client, { studentId, paperId, assignedAt, questionIds, params? })` → `{ conflict: { question_id, reason } }` 或 `{ conflict: null, rows: [{ question_id, item_id, assignment_id, retrain_step }] }` | 在出卷交易內寫重練派題＋空白作答並重算；先鎖項目再檢查 I6（兩個確認同時送出，後者得到 `in_flight`）。有 conflict 時什麼都沒寫，呼叫端 ROLLBACK 並回 409 `retrainConflictMessage(question_id)` |
| `listItems(db, studentId, { status?, subject?, asOf?, today?, params? })`、`getItemView(db, studentId, itemId, …)`、`summary(db, { asOf?, today?, params? })` | API-1、API-3、API-4 的資料（PR-4 的清單卡與徽章） |
| `recompute(client, studentId, questionIds?)`、`recomputePairs(client, [{ student_id, question_id }])`、`recomputeAll(client, { studentId? })` | 同一交易內重算（只重算、不建立項目） |
| `fetchHistories(db, [[studentId, questionId], …])` | 作答歷史（API-13 的重練成效可以用） |
| 純函式：`pendingOf(history, enteredOn)`、`orderUnits(views)`、`priorityKey(view)`、`stepLabel(step, stepDays)`、`buildItemView(row, ctx)`、`summarizeChanges(changes, entered)`、`todayLocal()`、`retrainConflictMessage(qid)`；常數 `IN_FLIGHT_WARN_DAYS`、`DEFERRABLE_CONSTRAINTS` | 排序、關卡名稱、已派出的判斷與畫面資料形狀 |

#### 5.6.3 實作狀態（第二階段之二：PR-3 出卷整合）

> **PR-3 已實作**（分支 `dec/retrain-p3-paper`，起點 `dec/retrain-p2-core`＝`836740057a`）。依第 8 節 R6、R7、R8、R12（以及 R9、R10）實作；第 5.6.1、5.6.2 節的原文不動。
>
> **沒有新的 migration**（M2＝0017 已涵蓋出卷要的欄位）。**沒有改動凍結介面**：`config/retrain.js`、`services/retrainSchedule.js`、`services/retrainService.js`、`utils/followUpPaperCheck.js`、`test/helpers/attempts.js`、0016／0017 一個字都沒動；需要的東西都在呼叫端（controller）或新檔案裡。
>
> **沒做**（PR-4）：`public/js/retrain.js`（清單卡、「出一份重練卷」按鈕與草稿畫面）、批改卡勾選框與徽章、學生清單徽章、API-13。PR-4 的「出一份重練卷」直接呼叫本節的 API-5，確認走 API-7。

| 項目 | 狀態 | 說明 |
| :--- | :--- | :--- |
| 挑題：`services/retrainSelect.js`（新檔） | ✅ | 到期清單用 PR-2 的 `listDueUnits`（第 4.7 節的排序、承上組為單位、`blocked`）；`pickUnits` 依序逐組放入，**R12 選 2**：剩下的名額 > 0 而且不夠整組 → 400、不產生草稿，訊息同第 4.7 節的例子（「……請把重練題數改成 5 或 8。」）；剛好放滿就停。**R8 選 1**：完全不看 `variant_of`，新題照既有流程抽（家族互斥只在新題之間），`mergeForPaper` 合併後用同一個 `sortForPaper` 一起排（**R7 選 1**：卷面不另分區），每題多 `purpose`、`retrain_step` |
| API-5 `POST /api/students/:id/retrain-paper` | ✅ | `controllers/retrainController.js` 的 `retrainPaper`，掛在 `routes/index.js` 檔尾的錯題重練區塊（旗標關閉不掛載）。只產草稿、不寫庫；回應形狀同第 5.2 節（差異見下表 ⑤）；純重練卷卷名在 API-7 確認時產生 |
| API-6 `generate-paper` 的 `retrain: { count, as_of? }` | ✅ | 單章與 blueprint 兩條路徑（`examController.attachRetrain`）：新題照舊抽完才挑重練題、另外加上；新題＋重練 ≤ 50；只挑**同科目**的到期題；回應最後多 `retrain: { wanted, got, due_total }`、每題多 `purpose`、`retrain_step`。非 `dry_run` 直接寫入時與 API-7 同一套寫入。沒帶（或 `null`）逐字不變；旗標關閉卻帶了 → 400 |
| API-7 `confirm-paper` 的 `retrain_question_ids` | ✅ | `writePaper` 多收 `retrainQuestionIds`：建卷之後先交給 PR-2 的 `insertRetrainAssignments`（`SELECT … FOR UPDATE` 鎖項目再檢查，不符 → 409 `retrainConflictMessage`，整筆回滾），其餘題照舊走新題的寫入閘門（衝突 409，訊息不變）。沒有重練題時交易裡的語句與之前一模一樣（`controllers.pg.test.js` 掛在 `assignments` 上的觸發器測試照樣成立）。純重練卷卷名「`<姓名>-錯題重練卷(日期)`」（日期格式同既有卷名 `YYYY_M_D`）。回應最後多 `retrain_question_ids`（依出題順序） |
| API-7 與 B7 整組檢查（風險 R-9） | ✅ | 整組規則不變、重練題與新題一視同仁（重練卷只放承上題 → 400）。只在帶了 `retrain_question_ids` 時，把「不在卷裡、該生寫過、但還在清單上（沒移出）」的組員原因從 `answered`（只能整組刪）改標 `not_in_paper`（加回來就好）；調整在 `examController.incompleteFollowUpGroupsInPaper`，`utils/followUpPaperCheck.js` 沒動 |
| API-8 `remedial-paper` 的 `retrain_count` | ✅ | `remedialController` 在 `planRemedialPaper` 之後呼叫 `retrainSelect.appendRetrainBucket`：`items` 最後多 `bucket = 'retrain'` 的題（另帶 `item_id`、`step`、`step_label`、`due_on`、`overdue_days`），`blueprint` 多一列、到期的不夠時 `shortfalls` 多一列（`reason = 'not_enough_due'`），`notes` 接在後面，`question_ids` 重排。**R10 選 1**：`basis` 與弱點排序照舊讀檢視 `attempts`（整合測試驗：重練答對不改變）。0 或沒帶逐字不變 |
| API-12 `download-word` 的 `paper_id` | ✅ | 旗標開啟而且帶了 `paper_id` 時查這張卷的重練派題，標準版與詳解版**答案區**的題號後加「（重練）」（「第 3 題（重練）答案：」）；題目區（卷面）與學生版不標（**R7 選 1**）。沒帶（或旗標關閉）時 `.docx` 逐位元不變（單元測試固定時鐘比對整個檔案） |
| 畫面：組卷頁（`index.html` inline script，標〔retrain〕） | ✅ | 題數下方的插入點 `<div id="retrainAttachSlot" hidden>`：旗標開啟而且選了學生時才填入「☐ 附上到期的重練題 [N] 題（目前到期 M 題）」——預設不勾，N 預設 `capForAttach(新題數)`，老師改過之後題數再變也不覆寫；M 讀 API-1 的 `counts.due`（同科目）。預覽卡上重練題標「重練・第 n 關」、按鈕改成「移除這題／移除這組」；確認帶 `retrain_question_ids`；R12 的 400 照舊顯示在結果區；確認後的畫面在重練題題號後標「（重練）」 |
| 畫面：補救卷（`public/js/remedial.js`） | ✅ | 配比下方「☐ 附上到期重練 [N] 題（目前到期 M 題）」（預設不勾，N 預設 `min(20, capForAttach(題數))`）；草稿多一組「到期重練」（標關卡、承上組整組刪、不足量原因「到期的題不夠」）；確認帶 `retrain_question_ids`；下載 Word 時帶 `paper_id` |
| 畫面：試卷列表（`public/js/students.js` 最小掛鉤） | ✅ | `GET /api/students/:id/papers` 在旗標開啟時每列多 `retrain_count`（另一條查詢，原 SQL 不動）；卷名旁「含重練 N 題」（N > 0 才渲染） |
| 設定：`RETRAIN_ATTACH_RATIO` 給前端 | ✅ | `app.js` 注入 `<meta name="retrain-attach-ratio">`（`config/retrain.js` 讀、非法值退回 0.3），組卷頁與補救卷的 N 預設值跟著 `.env` 走 |
| 測試 | ✅ | 單元：`retrainSelect.test.js`（TC-039-1）、`retrainValidation.test.js` 擴充 API-5～8、API-12（TC-039-2）、`solutionText.test.js` 擴充 Word 標示與逐位元不變（TC-039-4）、`retrainPaperUi.test.js`（組卷頁附帶選項預設不勾、題數預設三成；補救卷；試卷列表）。整合：`retrainPaper.pg.test.js`（TC-039-3 的出卷部分：草稿不寫庫、混合卷派題用途與關卡、純重練卷卷名、補救卷 retrain 組、兩個確認同時送出後者 409、刪重練卷後重算；R-9、R10；API-12 整合層）。e2e：`paperWord.e2e.test.js` 新增一案（新卷 → 勾要重練 → 重練卷 → 下載），不需要 cassette。既有斷言一條沒改 |

**與本檔（凍結版）不同、或本檔沒寫而由實作決定之處**（第 8 節沒有逐條決定，列給 Owner 確認）：

| # | 項目 | 實作 |
| :--- | :--- | :--- |
| ① | R12 的建議題數（第 4.7 節只舉例） | 「放到前一組為止的題數」為 0 時不列；「含這一組的題數」超過上限（API-5／6：新題＋重練 ≤ 50；API-8：≤ 20 且合計 ≤ 50）時不列；兩個都不能用時說「請調整重練題數」 |
| ② | API-6 的 `exclude_ids` | 也排除重練題：含其中任一題的承上組整組不挑（不報錯、不佔名額）。組卷預覽上「移除這題」的重練題放在這裡，換題、重抽時才不會又回來 |
| ③ | API-6 只挑同科目 | 附在新卷的重練題限同一科（不限章節）；API-5 的 `subject` 沒給時不限科目 |
| ④ | 新參數給 `null` | API-6 的 `retrain`、API-7 的 `retrain_question_ids`、API-8 的 `retrain_count` 為 `null` 時等於沒帶（同既有的 `exclude_ids`、`blueprint`）；旗標關閉時只要帶了非 `null` 的值（`count: 0`、空陣列也算）就 400。API-7 的空陣列＝沒有重練題（回應照樣多 `retrain_question_ids: []`） |
| ⑤ | API-5 的回應 | `subject` 沒給時是 `null`；`items` 依優先順序（第 4.7 節）、`question_ids` 依出題順序；每題另多 `status`、`due`（`include_not_due` 時看得出哪幾題還沒到期、哪幾題是被承上組帶著出的已會題）；沒有到期的題回 200、空草稿、附註「目前沒有到期的重練題。」；整組不能出的組逐組寫進附註。`include_not_due` 的「想出」＝進行中、沒派出、沒封存，排在到期的後面 |
| ⑥ | 檢查順序 | API-6、API-8：新參數的檢查排在既有的參數檢查之後、查學生之前；API-7：排在學生 404 與封存 400 之後、B7 整組檢查之前；API-12：排在既有檢查（題目、版本）之後 |
| ⑦ | API-12 的 `paper_id` | 旗標關閉時一律忽略（組卷頁本來就把 `paper_id` 一起送來，Word 必須逐位元不變）；旗標開啟時格式不對 400、卷不存在或卷上沒有重練題就不標（不回 404：下載看的是 `question_ids`）。**詳解版的題目區也不標**：API-12 寫「詳解版在重練題的題號後加」，ACPT-039-5 與 TC-039-4 寫「學生版與卷面（題目區）不標」，取交集＝只標答案（與詳解）區 |
| ⑧ | API-8 的「到期重練」組 | `target` 為 `{ type: 'retrain', name: '到期重練' }`；`blueprint` 那一列的 `rationale` 寫到期題數與排序規則；`as_of` 固定今天（API-8 沒有這個參數） |
| ⑨ | 補救卷的畫面 | 第 5.3 節只寫「到期重練 [N] 題」；做成與組卷頁一樣的「勾選框（預設不勾）＋題數」，N 預設三成、不超過 20（R6「可勾」） |
| ⑩ | 試卷列表的「含重練 N 題」 | 需要後端資料：`GET /api/students/:id/papers` 在旗標開啟時多 `retrain_count`（旗標關閉時逐字不變） |
| ⑪ | 設定 | `RETRAIN_ATTACH_RATIO` 經 `<meta name="retrain-attach-ratio">` 給前端；前端的 `capForAttach` 與 `services/retrainSchedule.js` 同一條規則（單元測試逐一比對） |

**給 PR-4 的介面**：API-5 草稿的形狀見上表 ⑤；「出一份重練卷」確認時送 `confirm-paper { student_id, question_ids, retrain_question_ids: question_ids }`，409 的訊息是 `retrainConflictMessage`（草稿過期，請重新產生）；下載 Word 帶 `paper_id` 才有 R7 的標示。`services/retrainSelect.js` 的 `buildRetrainDraft`、`selectRetrain`、`unitsFromViews`、`pickUnits` 可以直接呼叫。

#### 5.6.4 實作狀態（第二階段之三：PR-4 畫面與成效）

> **PR-4 已實作**（分支 `dec/retrain-p4-ui`，起點 `dec/retrain-p2-core`＝`836740057a`）。第 5.6.3 節留給同時進行的 PR-3（出卷整合）。依 Owner 2026-09-26 決策單第三輪（第 8 節）實作；第 5.6.1、5.6.2 節的原文不動。
>
> **沒做**（PR-3）：API-5～8、API-12 的伺服器端、組卷頁、補救卷、Word 標示。本 PR 的前端照第 5.2 節凍結的形狀呼叫 API-5（產草稿）、API-7（`confirm-paper` 帶 `retrain_question_ids`）、API-12（`download-word` 帶 `paper_id`），單元測試用 mock；PR-3 合併之前按「出一份重練卷」會顯示伺服器的 404。沒有新的 migration、設定或環境變數。

| 項目 | 狀態 | 說明 |
| :--- | :--- | :--- |
| API-13 `GET /api/students/:id/retrain-stats?days=&subject=` | ✅ 已實作 | 掛在 `routes/index.js` 檔尾錯題重練區塊（旗標關閉不掛載）；`controllers/retrainController.js` 的 `stats`；參數驗證 `utils/retrainValidation.js` 的 `parseStatsQuery`（嚴格驗證，同裁決 S5-21）；計算在新檔 `services/retrainStatsService.js`（只讀；題數與到期直接用 `retrainService.listItems`，所以判斷與 API-1 完全相同）。語意見下表 ① |
| 學生分頁「錯題重練」卡（`public/js/retrain.js`，錨點 `#retrain`） | ✅ 已實作 | 放在學生視圖、緊接在 `#students`（弱點面板）之後。四個數字（到期、進行中、練到會、卡關；點一下就篩那一類）；清單照 API-1 回來的順序（伺服器依第 4.7 節排好，前端不重排）；每列章節、題幹預覽（MathJax）、關卡標籤、下次到期（逾期標紅）、連對／錯次數、徽章（到期／已派出卷 #…／卡關／已封存，另有「派出超過 14 天還沒批改」）、可展開作答歷史（錯因用 `GET /api/error-types` 的標籤）；每列動作移出、判定已會、重新加入（API-3）、找相似（沿用既有的 `examapp:variant-request`，FEATURE_SIMILAR 關閉時不畫）；上方「手動加入題號」（API-2）、「出一份重練卷」（API-5 → 草稿沿用補救卷樣式、承上組整組刪 → API-7 → 下載 Word 帶 `paper_id`，三種版本）；「重練成效」小表（API-13） |
| 批改卡（`public/js/students.js` 最小掛鉤） | ✅ 已實作 | 新題對錯按鈕旁「要重練」勾選框（預設不勾、答錯也不自動勾；依 API-9 的 `retrain_flagged` 顯示已勾）；重練題不給勾選框、改標「重練・第 n 關」；`diffResults` 只在勾選改過時送 `results[i].retrain`；儲存後依 API-10 的 `retrain` 摘要提示「3 題進入重練清單、1 題練到會。」 |
| 學生清單的到期徽章（API-4） | ✅ 已實作 | 學生分頁的學生下拉選單：`姓名【到期 N】（N 卷，已批 …）`（下表 ④）。載入學生視圖、批改後、重練卡改了清單之後更新 |
| 旗標關閉 | ✅ | `#retrain` 整段不渲染（空 `<section>`）；students.js 不畫勾選框與徽章、不改選項文字、不發事件、不打任何新 API，PATCH body 與 `diffResults` 的輸出逐位元不變（列上沒有 `retrain` 鍵）。FEATURE_STUDENTS 關閉（學生分頁不存在）時重練卡也不渲染 |
| `index.html` | ✅ | 只加三處：`<section id="retrain">`、`<script type="module" src="/js/retrain.js">`（排在 students.js 之後）、`VIEW_FOR_ANCHOR.retrain = 'view-students'`（下表 ⑨） |
| `npm run check:html` | ✅ | `eval/tools/check_html.js` 新增 `RETRAIN_PAGES`（`#retrain` 的 section、module、meta、parseBool、「整段不渲染」）與 `RETRAIN_EXTRA_METAS`（students.js 必須讀 `feature-retrain`）；既有的 `STAGE*_PAGES` 清單不動 |
| 測試 | ✅ | 單元：`test/unit/retrainUi.test.js`（TC-040-2：miniDom 同時跑 students.js 與 retrain.js；旗標關閉不渲染、不發請求；清單順序與徽章；動作按鈕送出的 body；手動加入；重練卷草稿 → 確認 → Word 的 body；R12 的 400 與確認時的 409 原樣顯示；重練成效表；批改卡勾選框預設不勾、徽章、送出的 body 與提示；學生清單徽章；伺服器文字一律 textContent）、`test/unit/retrainStats.test.js`（API-13 的純函式與參數驗證）。整合：`test/integration/retrainStats.pg.test.js`（TC-040-1 的 stats 部分：旗標、404／400、第 4.5 節的例子、題數＝API-1 的 counts、時間窗含 since 當天、R2、沒批改不算、依科目）。既有斷言一條沒改 |

**與本檔（凍結版）不同、或本檔沒寫而由實作決定之處**：

| # | 項目 | 實作 |
| :--- | :--- | :--- |
| ① | API-13 的時間窗（第 5.2 節只列參數） | `days` 只影響答對率：`first_retrain`／`spaced` 只算派題日 ≥ `since`（＝今天 − `days`，含當天；與弱點面板的 `assigned_at >= CURRENT_DATE - days` 同一種算法）而且已批改的重練派題。題數（`entered`／`active`／`mastered`／`retired`／`stuck`）、`backlog`、`by_chapter` 是**清單現況**（依科目篩選、不受 `days` 影響）：「進過清單」＝還在表上的項目（進行中＋練到會＋移出；還沒重練就取消勾選的項目已刪掉，不算）。`days` 1～365、預設 90（同 weakness API）；回應最後多一個 `since`。`backlog` 以今天為準（不收 `as_of`）：`due_now`＝API-1 的 `due`（已派出、封存的不算），`overdue_7d`＝其中逾期 ≥ 7 天。`by_chapter` 依進過清單多 → 進行中多 → 章節名排序，沒有章節的是 `null`、排最後 |
| ② | 重練卡的學生、科目、時間窗 | 跟著學生分頁上方的下拉走（students.js 每次載入學生視圖時發 `examapp:student-view`，detail 帶 `student_id`、`student_name`、`subject`、`days`；retrain.js 掛載時也直接讀一次下拉，避免事件比監聽先到）。卡片自己另有「顯示」（API-1 的 `status`）與「預計作答日」（API-1、API-5 的 `as_of`；空白＝今天）。換學生時草稿與上一張卷一起清掉 |
| ③ | 重練卡改了清單之後 | retrain.js 發 `examapp:retrain-changed`（detail `student_id`、`papers_changed`）：students.js 更新到期徽章；確認了重練卷（`papers_changed`）時重載整個學生視圖，新卷立刻出現在試卷列表、可以批改 |
| ④ | 學生清單的「到期 3」徽章 | 學生清單是 `<select>`，選項放不了樣式徽章：做成選項文字 `姓名【到期 3】（2 卷，已批 50.0%）`；沒有到期的題就維持原文字。`data-name` 不變（「立即批改」靠它比對姓名） |
| ⑤ | 動作的確認 | 「移出」「判定已會」要按第二次才送（同學生管理面板的做法；按錯了只能「重新加入」，進度會歸零）；「重新加入」一按就送。重練卡不提供改備註（API-3 的 `note` 只顯示） |
| ⑥ | 批改卡儲存後的提示 | 除了 API-10 摘要（進清單、升一關、練到會、答錯回第 1 關，都是 0 就不提示），這次改成「錯」卻沒勾「要重練」的新題另外提醒「這次有 N 題答錯但沒勾「要重練」，不會進清單。」（第 7.1 節風險 R-12 的對策） |
| ⑦ | 勾選框的條件 | 旗標開啟**而且** API-9 帶了 `purpose` 才畫（伺服器沒帶時不畫，也就不會送出伺服器不收的 `retrain`）；`purpose = 'new'` 的每一題都能勾（含答對、還沒批改的題），`purpose = 'retrain'` 不給勾選框 |
| ⑧ | 「出一份重練卷」的選項 | 題數（預設 10、1～50）、「也放還沒到期的題」（API-5 的 `include_not_due`，有勾才送）；科目與預計作答日有選才送。承上組整組放不下的 400（R12）與確認時的 409 原樣顯示；草稿刪題以承上組為單位（「刪這組」） |
| ⑨ | `index.html` | 除了第 5.3 節的 section 與 module，多一行 `VIEW_FOR_ANCHOR.retrain = 'view-students'`：沒有它，網址 `#retrain` 會落回建立題目視圖 |
| ⑩ | 找相似 | 送 `examapp:variant-request`（`action = 'similar'`），`question_text` 給的是 API-1 的題幹預覽（API-1 不回全文） |
| ⑪ | 試卷列表的「含重練 4 題」（第 5.3 節表格最後一列） | 沒做：`GET /api/students/:id/papers` 沒有這個數字，要改 API，不在這一輪 PR-4 的範圍 |

#### 5.6.5 實作狀態（第二階段最終：PR-2＋PR-3＋PR-4 整合）

> **整合分支 `dec/retrain-phase2`**：起點 `dec/retrain-p3-paper`（`a5d794e`，其下是 PR-2 `dec/retrain-p2-core`＝`836740057a`），以 `--no-ff` 併入 `dec/retrain-p4-ui`（`a499ffe`）。第 5.6.1～5.6.4 節原文不動；各節寫的「沒做（留給另一個 PR）」以本節為準（例如第 5.6.4 節 ⑪ 的「含重練 N 題」已由 PR-3 做了）。
>
> 整合時**沒有改任何功能程式**：PR-3（伺服器端）與 PR-4（前端，當時對 API-5、7、12 用 mock）照第 5.2 節凍結的形狀各自實作，逐一核對後形狀一致（下表），不需要轉接。只改了兩段註解（`routes/index.js` 錯題重練區塊的說明、`index.html` 的 `feature-retrain` meta 說明），並新增兩支測試把兩邊接起來。沒有新的 migration（M2＝`0017_retrain_items.sql`），凍結介面（`config/retrain.js`、`services/retrainSchedule.js`、0016、`test/helpers/attempts.js`、`utils/followUpPaperCheck.js`、`FOLLOW_UP_SHORTFALL_POLICY`）一個字都沒動，也沒有發現它們的 bug。

**API 與 CLI（第 5.2 節）**

| # | 狀態 | 在哪、誰做的 |
| :--- | :--- | :--- |
| API-1～4 | ✅ | `controllers/retrainController.js`、`services/retrainService.js`（PR-2） |
| API-5 出一份重練卷（草稿） | ✅ | `retrainController.retrainPaper`、`services/retrainSelect.js`（PR-3） |
| API-6 `generate-paper` 的 `retrain` | ✅ | 單章與 blueprint 兩條路徑（PR-3） |
| API-7 `confirm-paper` 的 `retrain_question_ids` | ✅ | `writePaper` → `retrainService.insertRetrainAssignments`（PR-3） |
| API-8 `remedial-paper` 的 `retrain_count` | ✅ | `retrainSelect.appendRetrainBucket`（PR-3） |
| API-9 試卷明細的 `purpose`／`retrain_step`／`retrain_flagged` | ✅ | `paperController`（PR-2） |
| API-10 批改的 `retrain` 勾選與摘要 | ✅ | `paperController`＋`retrainService.applyGrading`（PR-2） |
| API-11 刪卷、刪學生、合併、刪題 | ✅ | PR-2 |
| API-12 `download-word` 的 `paper_id` | ✅ | `wordController`、`wordService.answerHeading`（PR-3） |
| API-13 重練成效 | ✅ | `retrainController.stats`、`services/retrainStatsService.js`（PR-4） |
| CLI `npm run retrain:recompute` | ✅ | `scripts/recompute_retrain.js`（PR-2） |

**畫面（第 5.3 節）**

| 位置 | 狀態 | 說明 |
| :--- | :--- | :--- |
| 學生分頁「錯題重練」卡（`public/js/retrain.js`） | ✅ PR-4 | 整合後「出一份重練卷」接上真的 API-5 → API-7 → API-12（PR-4 當時會得到 404） |
| 組卷頁（`index.html`〔retrain〕掛鉤） | ✅ PR-3 | 只有單章表單；blueprint（跨章）沒有既有畫面，`retrain` 只能經 API 用 |
| 補救卷（`public/js/remedial.js`） | ✅ PR-3 | 「☐ 附上到期重練 [N] 題」＋草稿的「到期重練」組 |
| 批改卡（`public/js/students.js`） | ✅ PR-4 | 「要重練」勾選框、「重練・第 n 關」徽章、儲存後的提示 |
| 學生清單的到期徽章 | ✅ PR-4 | 下拉選單的選項文字「姓名【到期 N】」 |
| 試卷列表「含重練 N 題」 | ✅ PR-3 | `GET /api/students/:id/papers` 旗標開啟時多 `retrain_count`；第 5.6.4 節 ⑪ 的「沒做」是 PR-4 單獨看時的狀態 |

**前端送出的 body × 伺服器實際收的（整合時逐一核對）**

| 接點 | 前端（產生 body 的程式） | 伺服器（驗證） | 結果 |
| :--- | :--- | :--- | :--- |
| API-5 | `retrain.js` `retrainPaperBody`：`{ count, subject?, as_of?, include_not_due? }`（沒選的不帶） | `parseRetrainPaperBody`（四個鍵、不認得的 400） | 一致；題數上下限兩邊都是 1～50、預設 10 |
| API-5 回應 | `draftFromResponse`、`draftGroups`、草稿卡讀 `items[].group_ids／follows_question_id／chapter／difficulty／step_label／overdue_days／question_text_preview`、`due_total`、`notes` | `buildRetrainDraft` 都有（另多 `status`、`due`，前端不讀） | 一致 |
| API-7 | `confirmBody`：`{ student_id, question_ids, retrain_question_ids: question_ids }`；組卷頁 `retrainConfirmKeys`、補救卷 `retrainConfirmKeys` | `parseConfirmRetrain`（子集、不重複） | 一致；回應的 `paper_id／paper_title／question_ids` 就是 `retrain.js` 記下的 |
| API-12 | `wordDownloadRequest`：`{ paper_title, student_name, question_ids, edition, paper_id }`；組卷頁與補救卷的快取本來就帶 `paper_id` | `parseWordPaperId`（旗標關閉一律忽略） | 一致 |
| API-9 → API-10 | 批改卡依 `purpose = 'new'` 畫勾選框、初值＝`retrain_flagged`；`diffResults` 只在改過時送 `results[i].retrain` | `parseRetrainFlags`；重練題帶了 400 | 一致；重練題的列上沒有 `retrain` 鍵，不會送 |
| API-10 回應 | `retrainSaveMessage(body.retrain)` 讀 `entered／advanced／mastered／reset` | `summarizeChanges` | 一致 |
| API-6、API-8 | 組卷頁 `retrainAttachRequest`：`{ count }`；補救卷 `remedialRequestBody` 的 `retrain_count` | `parseAttachParam`、`parseRemedialRetrain` | 一致；預設題數兩邊都是 `capForAttach`（補救卷另夾在 20 以內） |
| API-1、API-13 查詢 | `retrain.js` 的 `status／subject／as_of`、`days／subject`（學生分頁的時間窗 30／90／180／365） | `parseListQuery`、`parseStatsQuery` | 一致 |

**整合新增的測試**

- `test/integration/retrainFlow.pg.test.js`（3 案，旗標開啟；**請求的 body 一律由前端自己的程式產生**：`retrain.js`、`students.js` 以 ES module 載入，組卷頁掛鉤依 `retrainPaperUi.test.js` 的抽法）。時間用 `node:test` 的 `mock.timers` 只假 `Date`，從 2026-10-01 一天一天往前走（排程只看 JS 的今天，本功能的 SQL 不用 `CURRENT_DATE`）：
  1. 全流程：組卷頁出新卷 → 批改卡答錯並勾「要重練」（答錯沒勾的不進）→ 清單出現、第 1 關、隔天到期、學生清單「到期 1」→ 錯題重練卡產生草稿（不寫庫）→ 確認（純重練卷卷名）→ 同一份草稿再確認 409、刪原卷 409、試卷列表 `retrain_count` → 三種版本的 Word（標準版與詳解版答案區標、學生版與題目區不標、沒帶 `paper_id` 不標）→ 重練題答對升第 2 關、到期日＝派題日＋7 天 → 刪掉重練卷，項目、API-1、API-13 與出卷之前逐欄相同 → 附帶到一張新卷（預設題數＝`capForAttach(4)`＝1）→ 重練成效（進過清單、答對率、依章節、`since`、`days` 只影響答對率、依科目）→ 隔週回測答錯回第 1 關（R4）→ 逾期 7 天以上的 backlog。
  2. 承上組：只勾一題整組進清單（批改卡只有那一題顯示已勾）；重練卷題數 2 放不下整組 → 400（R12 訊息與建議題數）、不寫庫；只放一部分 → 400（B7，缺的組員原因 `not_in_paper`）；整組確認、Word 三題都標；組內各自升降關；組內一題到期就整組出；附帶到新卷題數 2 → 400、3 → 整組附上且相鄰、各自記下當下關卡。
  3. 旗標關閉：六支新 API 都是 Express 預設 404；`retrain`／`retrain_question_ids`／`retrain_count`／`results[i].retrain` 都 400 且不寫；有重練資料時，試卷明細、試卷列表與旗標開啟時只差新鍵；批改的回應只有 `{ updated }`（排程照樣重算）；`generate-paper`、`confirm-paper` 的回應鍵與以前相同；Word 帶 `paper_id` 與不帶逐位元相同；首頁 meta 注入 `false`、`#retrain` 是空的 section。
- `test/unit/retrainContract.test.js`（13 案，不連 DB）：上表每一個接點，前端產生的 body 交給伺服器真正用的驗證函式，不被 400、解析出來的值就是前端選的；上下限、預設值兩邊一致。

**畫面冒煙（Playwright，一次性、不進 CI、截圖不 commit）**：以 `tutor_rphase2_test`、`LLM_MODE=replay` 起本機伺服器，一位「測試學生」、11 題、兩張卷（一張五天前的新卷批改並勾選、一張沒批改的重練卷）。`FEATURE_RETRAIN=true`：錯題重練卡（四個數字、清單順序與徽章、MathJax、作答歷史、承上組整組的草稿）、學生清單「【到期 2】」、試卷列表「含重練 2 題」、批改卡的勾選框（勾過的顯示已勾）與「重練・第 1 關」徽章、補救卷的附帶列（預設不勾）、組卷頁的附帶列（N 預設 1、目前到期 2 題）與預覽卡的徽章和「移除這組」都出現；另走一次閉環：卡片上出重練卷 → 確認 → 下載 Word（請求帶 `paper_id`，檔內兩題標「（重練）」）→ 學生視圖重載、新卷出現 → 批改卡按對、儲存 → 提示「2 題升一關。」、卡片上兩題變第 2 關。旗標未設：上述元件全都不存在、`#retrain` 是空的、組卷頁插入點保持空的 hidden、沒有打任何重練 API。兩次都沒有 console 錯誤與 4xx／5xx（唯一的 console 訊息是瀏覽器自己要 `/favicon.ico` 的 404，與本功能無關、旗標開關都一樣）。

**NFR-010（草案）一次性量測**（本機、同一台機器、不進 CI）：單一學生 5,250 筆派題（5,000 筆新題、250 筆重練）、1,000 個排程項目、題庫 6,000 題（其中 1,000 題沒派過，給新題候選池）。中位數：API-1 74 ms（`status=all` 82 ms）、API-5 63 ms（count 50）、API-13 61 ms、API-4 12 ms、API-6 附帶重練 63 ms，都在 300 ms 內。

**第二階段與本檔（凍結版）不同之處，彙總**（細節與理由見第 5.6.2 ①～⑬、5.6.3 ①～⑪、5.6.4 ①～⑪）：

| 主題 | 實作 | 出處 |
| :--- | :--- | :--- |
| 設計稿自己定、不是 Owner 逐條決定的三件事 | ①「要重練」勾選框每一題新題都能勾（含答對、還沒批改的題），預設不勾；②練到會或移出後重新加入，錯的次數不歸零；③R12 的訊息提示可以改成的題數 | 第 4.4、4.7 節；5.6.4 ⑦、5.6.3 ① |
| 重新加入的邊界 | 多一欄 `entered_after_assignment_id`，同一天先批改再重新加入也從第 1 關重來 | 5.6.2 ① |
| 勾選與取消的承上組規則 | 勾一題整組進；取消只作用在老師勾的（`flagged`），批改卡不動手動加入與承上組帶進的；改判成對不刪項目 | 5.6.2 ⑥⑦ |
| 清單動作 | 移出對整組；重新加入把同組已移出的一起帶回；進行中的題按重新加入 409；「移出」「判定已會」要按第二次 | 5.6.2 ⑤、5.6.4 ⑤ |
| R12 的建議題數 | 0 與超過上限的數字不列；都不能用時說「請調整重練題數」 | 5.6.3 ① |
| 附帶到新卷 | 只挑同科目；`exclude_ids` 也排除重練題（整組），「移除這題」靠它 | 5.6.3 ②③ |
| Word | 詳解版也只標答案區（題目區任何版本都不標）；旗標關閉時 `paper_id` 一律忽略；卷不存在不回 404 | 5.6.3 ⑦ |
| API 回應多的鍵 | API-1 多 `entered_on`、`in_flight_since`、`in_flight_warn` 等；API-2 多 `reason`；API-3 多 `group_changed`；API-5 每題多 `status`、`due`；API-13 多 `since` | 5.6.2 ③④⑤、5.6.3 ⑤、5.6.4 ① |
| API-13 的時間窗 | `days`（預設 90、1～365）只影響兩個答對率；題數、backlog、依章節是清單現況 | 5.6.4 ① |
| 畫面的形式 | 學生清單徽章是下拉選項文字；補救卷做成「勾選框＋題數」（N 預設三成、≤ 20）；重練卡跟著學生分頁的學生、科目、時間窗；批改後另提醒「答錯但沒勾要重練」 | 5.6.4 ②④⑥、5.6.3 ⑨ |
| 設定 | `RETRAIN_ATTACH_RATIO` 經 `<meta name="retrain-attach-ratio">` 給前端；`IN_FLIGHT_WARN_DAYS = 14` 不開放覆寫 | 5.6.3 ⑪、5.6.2 |

**還沒做**

- 組卷頁的跨章（blueprint）畫面本來就沒有，附帶重練題只接在單章；blueprint 的 `retrain` 只能經 API。
- 組卷頁與補救卷沒有「預計作答日」欄位（一律今天）；錯題重練卡有。API-6、API-5 都已接受 `as_of`，要的話加一個日期欄即可。
- 補救卷以程式改選學生（`remedial:add` 事件，沒觸發 change）時，「目前到期 M 題」不會跟著更新（產生草稿不受影響）。
- `retrain.js` 沒有 `?mock=1` 的假資料。
- `retrainService.todayLocal` 與 `examController.localDates` 是兩份同樣的「本地今天」實作，還沒合併。
- NFR-010 只有上面那一次手動量測，沒有進 CI；`srs.md`、`engineering_tracker.md`、`HANDOFF.md` 的同步照第 9.2 節由文件整合任務處理。
- 既有的紅燈不變（不是本功能造成、這一輪也不修）：e2e 缺 ocr cassette 3 敗、五個 eval 缺 cassette 與向量 fixture，失敗清單與 `dec/retrain-base` 相同。

#### 5.6.6 實作狀態（第二階段審查修正）

> **分支 `dec/retrain-phase2-fix`**，起點 `dec/retrain-phase2`（`3285213`）。依第二階段整合的審查意見（六條 minor）與主控另外要求的三件 info 修正；第 5.6.1～5.6.5 節原文不動，與它們不同之處以本節為準。
>
> **新 migration：`0018_retrain_unflag_marker.sql`**（0017 已凍結，照它檔頭的約定走新檔）：`retrain_items` 多一欄 `retired_by_unflag BOOLEAN NOT NULL DEFAULT false` 與約束 `retrain_items_unflag_check`（只有 `teacher_override = 'retired'` 的項目可以是 true；寫成 `IS NOT DISTINCT FROM`，`teacher_override` 是 NULL 時 CHECK 才不會放行）。可重複套用（`ADD COLUMN IF NOT EXISTS`、DO 區塊判斷約束），空庫可從 0001 套到 0018；不搬資料，既有項目一律 false（照舊保留）。凍結介面（`config/retrain.js`、`services/retrainSchedule.js`、0016、0017、`test/helpers/attempts.js`、`utils/followUpPaperCheck.js`、`FOLLOW_UP_SHORTFALL_POLICY`）一個字都沒動，也沒有發現它們的 bug。

**審查意見逐條**

| # | 審查意見 | 處理 | 測試（修正前確認會失敗） |
| :--- | :--- | :--- | :--- |
| 1 | API-3 加鎖順序與批改相反，同時操作會死結（40P01） | ✅ 修：`applyAction` 先**不加鎖**讀出目標的題號、用 `lookupGroups` 找同組，再用一句 `WHERE i.student_id = $1 AND (i.id = $2 OR i.question_id = ANY($3)) ORDER BY i.id FOR UPDATE` 把目標與同組一次鎖完；鎖到之後再確認目標還在、還屬於這位學生（等鎖期間被刪卷刪掉或被合併搬走 → 404）。`mark_mastered` 只鎖目標。檔頭「依 id 排序，鎖的順序一致」現在對所有路徑都成立 | `retrain.pg.test.js`「併發：API-3 與批改同時動同一個承上組」：第三條連線先卡住 id 小的項目，讓批改與 API-3 依序排隊，修正前批改回 500（deadlock detected），修正後兩邊 200、快取＝歷史重算；反過來排隊也驗 |
| 2 | 刪重練卷後，取消勾選時因「重練過」而移出的項目沒有回到「那次重練沒發生過」 | ✅ 修（需要 0018）：批改卡取消勾選（以及下一列刪卷時承上組跟著離開）而移出的項目記 `retired_by_unflag = true`；老師在清單上按「移出」（API-3）是 false。刪重練卷重算之後，**重練派題全刪光、而且 `retired_by_unflag`** 的項目刪掉（取消勾選當時就會直接刪）；清單上按的「移出」照樣保留。重新加入（批改卡勾回、API-3 `reactivate`）與「判定已會」把它清回 false | `retrain.pg.test.js`「刪重練卷＝那次重練沒發生過」（兩張重練卷逐張刪、承上組、API-3 的移出保留、之後勾回走重建：新項目、起算日＝原卷派題日、`entered_after_assignment_id` 為 NULL）、「勾選消失才移出的項目……清回 false」；`retrainMigration.pg.test.js` 0018；`retrainService.test.js` 0018 靜態檢查 |
| 3 | 刪掉被勾選題所在的卷，別張卷來源的 group 項目留在清單上 | ✅ 修：刪卷刪掉老師勾的（`flagged`、沒移出）項目之後，對它的承上組套用與取消勾選相同的規則（第 5.6.2 節 ⑥）：同組已經沒有勾選 → `group` 項目還沒重練過刪、重練過移出（記 `retired_by_unflag`）；同組還有別題勾著就不動；`manual` 不動。這些同組項目由 `lockItemsForPaper` 先不加鎖查出、與其他項目在同一句 `ORDER BY i.id FOR UPDATE` 一次鎖完（不破壞第 1 條的加鎖順序）。旗標關閉時照樣處理（資料完整性不受旗標管） | `retrain.pg.test.js`「刪掉被勾選題所在的卷：同組已經沒有勾選時……」：事後綁定的承上組（沒重練過 → 刪；重練過 → 移出，之後刪它的重練卷 → 刪）、同一張卷整組勾、對照組（同組還有勾選 → 不動）、旗標關閉 |
| 4 | 混合卷確認後的卷名變成別章重練題的章節，與預覽、API-6 直接寫入不同 | ✅ 修：`confirm-paper` 帶了 `retrain_question_ids`、又不是純重練卷時，卷名取「排序後第一個**新題**」的章節；沒帶 `retrain_question_ids` 時一個字都沒變（取排序後第一題） | `retrainPaper.pg.test.js`「混合卷的卷名跟著新題的章節」：重練題（向量內積、單選、難度 1）排第一題，預覽、確認的回應、`exam_papers` 的那一列、非 dry_run 直接寫入四處卷名相同；沒帶重練題時照舊 |
| 5 | 批改後「答錯但沒勾，不會進清單」的提示可能與伺服器結果相反（承上組同組題被勾、已有手動或 group 項目） | ✅ 修（前端）：API-10 的回應形狀不動（既有測試逐字比對整個回應，而且第 5.2 節凍結了 `retrain` 摘要的四個鍵）。批改卡先挑出「這次改成錯、沒勾」的新題當候選；儲存成功而且有候選題時，讀一次 API-1（`status=all`）對照清單現況，**在清單上（有項目而且沒移出）的不算**。讀不到清單時改說「這次有 N 題答錯但沒勾「要重練」。」，不斷言「不會進清單」。沒有候選題就不多打 API | `retrainUi.test.js`：承上組重現（審查意見的例子）、手動加入的不提醒／已移出的照樣提醒、對照失敗與不多打 API、純函式 `retrainHintCounts`；`retrainFlow.pg.test.js`「批改卡的提示與伺服器實際結果一致」用真的伺服器跑審查意見的例子（`entered = 3`，提示只算不在任何組的那一題） |
| 6 | ACPT-040-3 沒有端點層的斷言（弱點面板、知識點掌握度） | ✅ 補測試（行為本來就對） | `retrainPaper.pg.test.js`「ACPT-040-3（R10 選 1）」：有知識點標註與錯因的夾具，出重練卷前後、答對與答錯（含錯因、部分給分）之後，`/weakness` 與 `/weakness/kc`（四組查詢參數）逐欄 `deepEqual`。另以「把檢視 `attempts` 改成含重練派題」做過一次突變檢查，這條測試會失敗 |

**主控另外要求的三件**

| # | 項目 | 處理 |
| :--- | :--- | :--- |
| (1) | 組卷頁勾了「附上到期的重練題」但題數清空或不合法時，送出 `count: 0`（或 null）、靜默不附帶 | ✅ 比照補救卷那一列：新增 `retrainAttachError()`（在〔retrain〕掛鉤區塊內），勾了而題數不是 0～50 的整數（含清空）時，`requestPreview` 提示「附上的重練題數要是 0–50 的整數。」、不送出；新題＋重練 ≤ 50 仍由伺服器檢查（400 顯示在結果區）。明確填 0 照送（同補救卷允許 0）。`retrainAttachRequest()` 本身的回傳不變（既有斷言照舊成立）。測試：`retrainPaperUi.test.js` 新增一案 |
| (2) | 部署說明：新程式在旗標關閉時也要求資料庫已套 0017（現在是 0018） | ✅ 見下方「升級步驟」；`docs/HANDOFF.md` 第 0.2 節 C.7 與 `exam_pro/README.md` 第 4 節的升級注意事項同步加註 |
| (3) | 「判定已會」的題被承上組帶著出又答錯時維持練到會（第 4.4 節兩列規則衝突） | ⏸ **待 Owner 裁決**，純函式不改（見下）。批改摘要不會誤導：這一題不算 `reset`（狀態沒變）；批改卡儲存後另外提示「有 N 題重練題已「判定已會」，答錯不改狀態（仍是練到會；要再練請到錯題重練卡按「重新加入」）。」（與第 5 條同一次 API-1 對照，不改 API-10 的回應形狀）。測試：`retrainUi.test.js`、`retrainFlow.pg.test.js` |

**待 Owner 裁決：「判定已會」的題被帶著出又答錯**

第 4.4 節有兩列規則在這個情形互相衝突：「承上題」那一列寫「已練到會的同組題被帶著出時……答錯就重新進行中（回第 1 關）」；「老師移出／判定已會／重新加入」那一列寫 `teacher_override`「重算時優先」。凍結的純函式照後者：老師「判定已會」（`teacher_override = 'mastered'`）的題，被同組帶著出又答錯，**仍是練到會**（錯的次數照樣＋1）；自然練到會（沒有 override）的題答錯則回第 1 關。兩種選擇：

- 維持現狀（override 優先）：老師的判斷不會被一次答錯推翻；要再練就按「重新加入」。批改卡已提示。
- 改成答錯就重新進行中：要改凍結的純函式（例如答錯時清掉 `mastered` 的 override），並補純函式與整合測試。

**升級步驟（旗標關閉也一樣）**

新程式在 `FEATURE_RETRAIN` 關閉時也會讀寫錯題重練的資料表：批改（`PATCH /api/papers/:id/results` 先鎖 `retrain_items` 再重算）、刪卷、刪學生、合併學生都會碰 `retrain_items` 與 `retired_by_unflag`，資料庫沒套到 0018 就會 500。所以更新程式一定要連 migration 一起做（沿用 0016 的驗證流程，第 3.6 節、第 5.6.1 節）：

1. 先停服務（`npm run dev` 的 nodemon 會在拉下新程式時立刻重啟）。
2. 更新程式（`git pull`／checkout）。
3. `npm run db:backup`。
4. `node scripts/snapshot_attempt_views.js --out=before.json`（套之前拍一張）。
5. `npm run migrate`（0016 拆表、0017 排程項目、0018 移出的來源；`node migrate.js status` 應全部顯示已套用）。
6. `node scripts/snapshot_attempt_views.js --out=after.json`。
7. `node scripts/snapshot_attempt_views.js --compare before.json after.json`：回 0「完全相同」才啟動；有差異就先別用，把輸出與兩個檔案留給開發者（還原用第 3 步的備份）。
8. 啟動。要用錯題重練時再在 `.env` 設 `FEATURE_RETRAIN=true` 並重啟（清單從那天起由老師勾選，第 5.5 節）。

**與設計稿（凍結版）不同、或設計稿沒寫而由本次實作決定之處**（列給 Owner 確認）

| # | 項目 | 實作 |
| :--- | :--- | :--- |
| ① | 移出的來源 | 多一欄 `retired_by_unflag`（0018）。「勾選消失」（批改卡取消勾選、刪了勾選所在的卷）才移出的是 true，老師在清單上按的「移出」是 false；只有前者在重練卷刪光之後跟著刪。0018 之前已經因取消勾選而移出的項目分不出來源，一律當成老師的「移出」保留 |
| ② | 刪卷時承上組的 group 項目 | 第 3.9 節只寫「項目還沒被重練過就連項目一起刪」；本次比照取消勾選（5.6.2 ⑥）處理同組、別張卷來源的 `group` 項目 |
| ③ | 仍然不同的邊界 | 「勾 → 出重練卷 → 取消勾選（移出）→ 再勾回來（重新加入）→ 刪重練卷」：項目留在「重新加入」的樣子（起算日＝勾回那天），而不是「那次重練沒發生過時」的重建（起算日＝原卷派題日）。只差起算日與到期日，沒有處理 |
| ④ | 混合卷的卷名 | 取排序後第一個新題的章節（第 5.4 節「沿用現有規則」的前提是單章預覽；附帶的重練題可能是別章）。blueprint（跨章）卷的確認本來就取排序後第一題的章節，與 API-6 blueprint 直接寫入的「多章」卷名不同，這一點與重練無關、照舊 |
| ⑤ | 批改卡的補充提示 | 儲存後多讀一次 API-1（只在有「改成錯沒勾」的新題或「改成錯」的重練題時）。「在清單上」＝有項目而且沒移出（進行中或練到會）；讀不到時不斷言「不會進清單」 |
| ⑥ | 組卷頁題數的前端檢查 | 0～50 的整數（含 0；清空不再當 0）；合計上限仍交給伺服器 |

**本次新增的測試**：整合 `retrain.pg.test.js` 四案（API-3 與批改併發、刪重練卷還原、移出來源清回、刪卷時承上組）、`retrainMigration.pg.test.js` 一案（0018）、`retrainPaper.pg.test.js` 兩案（卷名、ACPT-040-3）、`retrainFlow.pg.test.js` 一案（批改提示與伺服器一致、判定已會答錯）；單元 `retrainUi.test.js` 六案、`retrainPaperUi.test.js` 一案、`retrainService.test.js` 一案。`retrainFlow.pg.test.js` 的 `gradeOnCard` 夾具改成照批改卡的新做法算提示（對照 API-1），既有斷言一條沒改。完整 CI：unit 3,025 → 3,033 案、integration 576 → 584 案，全綠；check:html、migrate（到 0018）綠。既有紅燈不變（與起點 `3285213` 逐項相同）：e2e 缺 ocr cassette 3 敗；classify 92、pipeline 1、nlq 8 筆 replay miss；retrieval 未達門檻；variant 缺向量 fixture。

---

## 6. 測試計畫與驗收

### 6.1 功能需求（FR-036～FR-040，定稿）

〔凍結〕編號與內容依 Owner 2026-09-26 答覆定稿；同步進 `engineering_docs/01_requirements/srs.md` 由其他分支辦理。

| ID | 需求描述 | API 端點 | 旗標 | 來源 | 優先級 | 驗收 ID |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| FR-036 | 派題與作答分開記錄：`assignments`（用途 new／retrain）＋`attempt_records`；新題每生每題一次由部分唯一索引保證；舊 `attempts` 以唯讀檢視保留原語意（每生每題第一次）；既有資料無損遷移 | 無新端點；`GET /api/papers/:id` 每題多 `purpose`、`retrain_step` | 無（核心資料層） | DEC-003 例外條款（選 a 拆表）、B22；ADR-018 | Must | ACPT-036-1～4 |
| FR-037 | 錯題重練清單：老師在批改卡勾「要重練」才建立排程項目，答錯不自動進（R1 選 2）；承上組整組；老師在清單上手動加入／移出／判定已會／重新加入；開啟功能時不補建以前的錯題，以前的錯題由老師手動加入（R11 選 3） | API-1～4、API-10 的 `retrain` 勾選、API-9 的 `retrain_flagged` | `FEATURE_RETRAIN` | DEC-003 例外條款、DEC-016；決策單 2026-09-26 R1、R11 | Must | ACPT-037-1～4 |
| FR-038 | 間隔複習排程：固定關卡（Leitner 式，R5 選 1）：第 1 關＝下一份卷、第 2 關隔 7 天、第 3 關隔 14 天，連續答對 3 次練到會（R3 選 2）；只有全對才算對（R2 選 1）；重練或回測又錯回第 1 關、錯的次數加一，錯滿 3 次標「卡關」、仍留在清單（R4 選 1）；一律用原題（R9 選 1）；已派出不重複派；排程是作答歷史的純函式，改判／取消批改／刪卷後重算；參數在設定檔、可用環境變數覆寫 | 無獨立端點（`services/retrainSchedule.js`、`config/retrain.js`）；API-10 回報排程變化；CLI `retrain:recompute` | `FEATURE_RETRAIN` | DEC-016；決策單 2026-09-26 R2～R5、R9；ADR-019 | Must | ACPT-038-1～4 |
| FR-039 | 出卷帶入重練題（R6 選 1）：出新卷（單章、跨章、補救卷）時可勾「附上到期的重練題」，預設上限為新題數的三成（無條件捨去，可改），另有「出一份重練卷」；確認時寫成重練派題；承上組整組出、放不下時報錯請老師調整題數（R12 選 2）；重練題不佔變式家族名額（R8 選 1）；學生卷面不標，標準版答案區、詳解版與批改卡標「重練」（R7 選 1） | API-5～8、API-11、API-12 | `FEATURE_RETRAIN`（沒帶新參數時既有行為逐字不變） | DEC-016；決策單 2026-09-26 R6～R8、R12 | Must | ACPT-039-1～5 |
| FR-040 | 重練成效與到期提醒：「重練成效」表（重練答對率、隔週回測答對率、練到會題數、卡關題、逾期量）、學生清單到期數、批改卡與試卷明細標示；弱點面板、知識點掌握度與補救卷只算每題第一次作答（R10 選 1） | API-13、API-4 | `FEATURE_RETRAIN` | DEC-016、DEC-015；決策單 2026-09-26 R10 | Should | ACPT-040-1～3 |

**NFR 影響**（同步 `srs.md` 時一併處理）：

- NFR-006（資料一致性）補一句：派題與作答同一交易寫入；批改與排程重算同一交易；migration 只增不改（M1 刪除舊表是在新 migration 裡做，既有檔不動）。
- 新增 NFR-010（效能，草案）：單一學生 5,000 筆派題、題庫 5,000 題時，到期清單（API-1）與重練草稿（API-5）在本機 < 300 ms；新題候選池的 EXPLAIN 走部分唯一索引。

### 6.2 驗收（Given／When／Then，定稿）

| ACPT | 驗收 |
| :--- | :--- |
| ACPT-036-1 | Given 升級前已有作答紀錄，When 執行 M1，Then 每一筆舊紀錄變成一筆「新題」派題加一筆作答，編號、學生、題目、卷、派題日、對錯、部分給分、錯因、學生答案、註記全部相同；弱點面板、知識點掌握度、補救卷草稿的 `basis` 與目標、覆蓋率的「還沒寫過」與升級前逐欄相同。 |
| ACPT-036-2 | Given 某生寫過某題（新題或重練都算），When 以單章、跨章、補救卷、NLQ、找相似、變式檢索、覆蓋率挑「新題」，Then 那一題都不會出現。 |
| ACPT-036-3 | When 以「新題」身分把同一題第二次派給同一位學生（含兩個出卷請求同時搶同一題），Then 資料庫擋下，出卷回 409，整張卷不寫入。 |
| ACPT-036-4 | Given 沒有任何重練資料，Then 出卷、確認、批改、刪卷、刪學生、合併學生、刪題的回應與行為與升級前相同：既有整合與 e2e 測試中驗這些行為的斷言一條不改；只有第 6.4 節列出、直接檢查資料表結構與索引名稱的斷言依 Owner 決策改寫。 |
| ACPT-037-1 | Given 旗標開啟，When 老師在批改卡把某題勾「要重練」並儲存，Then 同一次儲存就建立該題的重練項目（第 1 關，起算日＝那一筆派題日，下一份卷即可出）；When 某題批改為錯但沒勾，Then 不建立項目；When 還沒重練前取消勾選並儲存，Then 項目消失（R1 選 2）。 |
| ACPT-037-2 | When 老師移出、判定已會、重新加入（含練到會的題），或以題號手動加入（只接受曾派給他的題），Then 清單立即反映；移出與已會的題不會到期、不會被挑進卷；重新加入的題從第 1 關重來。 |
| ACPT-037-3 | Given 承上組內任一題進清單，Then 同組其他題一起進清單；出卷時整組出現、不會只出承上題。 |
| ACPT-037-4 | Given 旗標關閉，Then 相關 API 回 404、批改卡不顯示「要重練」勾選框、批改 API 帶 `retrain` 回 400、不建立任何項目；When 之後開啟，Then 清單是空的，不會補建開啟前的錯題；老師可以用題號手動加入以前派過的題（R11 選 3）。 |
| ACPT-038-1 | Given 一題在第 s 關（s＝1、2、3），When 這次作答全對（沒給部分分且按「對」，或給 100%），Then 升到第 s＋1 關、到期日＝這次派題日＋該關間隔（第 2 關 7 天、第 3 關 14 天）；When 連續全對 3 次，Then 狀態為「練到會」、不再到期（R2 選 1、R3 選 2、R5 選 1）。部分給分沒滿分算錯。 |
| ACPT-038-2 | When 重練或回測答錯，Then 回到第 1 關、連對歸零、錯的次數加一；When 錯的次數達 3，Then 標「卡關」提醒老師，題目仍留在清單、照樣到期，不自動移出（R4 選 1）。 |
| ACPT-038-3 | Given 某題已派到一張還沒批改的卷（重練派題，或起算日當天以後的新題派題），Then 它不算到期，也不會被派到第二張卷（兩個確認同時送出時後者 409）。Given 老師手動加入以前的題，而那一筆新題派題早於起算日、一直沒批改（例如 MySQL 時期匯入的舊紀錄），Then 它不算已派出，加入後照常到期、可以出卷。 |
| ACPT-038-4 | When 改判、取消批改或刪掉重練卷，Then 排程重新計算，結果與「從頭依序批改一次」完全相同。 |
| ACPT-039-1 | When 出卷時勾「附上到期的重練題 N 題」（N 預設為新題數的三成、無條件捨去，可改）或按「出一份重練卷」，Then 草稿只含到期、未派出、題目未封存的項目，依逾期天數排序，數量不超過 N；產生草稿不寫任何資料（R6 選 1）。 |
| ACPT-039-2 | When 確認出卷，Then 重練題寫成「重練」派題並記下所屬項目與當時關卡，新題照舊受硬閘門保護；同一張卷同一題至多一次。 |
| ACPT-039-3 | Then 承上組整組出、不拆開；When 到期的承上組整組放不進剩下的名額，Then 回 400、不產生草稿，訊息列出那一組並請老師調整題數（R12 選 2，與 B10 一致）。重練題不佔變式家族名額，同家族的一題新變式可以同卷（R8 選 1）。 |
| ACPT-039-4 | Given 沒帶任何重練參數，Then `generate-paper`、`confirm-paper`、`remedial-paper`、`download-word` 的回應與輸出逐字（Word 逐位元）不變。 |
| ACPT-039-5 | When 以 `paper_id` 下載 Word，Then 標準版答案區與詳解版在重練題標「（重練）」；學生版與卷面（題目區）不標（R7 選 1）。 |
| ACPT-040-1 | 學生頁顯示「重練成效」：進過清單的題數、練到會、進行中、卡關、第一次重練答對率、隔週回測答對率、到期與逾期題數，可依科目與時間窗篩選。 |
| ACPT-040-2 | 學生清單顯示每位學生的到期題數；批改卡與試卷明細標出重練題與關卡。 |
| ACPT-040-3 | 弱點面板、知識點掌握度、補救卷只用每題第一次作答（R10 選 1），重練不改變它們的數字。 |

### 6.3 測試計畫

全部不呼叫 LLM、不需要 cassette；CI 照舊 `LLM_MODE=replay`。

| TC | 層 | 檔案 | 驗什麼 |
| :--- | :--- | :--- | :--- |
| TC-036-1 | 整合 | `test/integration/assignmentSplit.pg.test.js` | 在「只套到 M1 前一號、灌入舊資料（含 `paper_id` 為 NULL、有部分給分與錯因、已封存題）」的庫上套 M1：筆數、id、逐欄相同；序號接續；自我檢查在人為製造不一致時會 RAISE 並整支回滾 |
| TC-036-2 | 整合 | 同上 | 部分唯一索引擋重複新題（23505）、重練列不受限、`(paper_id, question_id)` 唯一、`question_id` RESTRICT、兩個檢視的欄位名稱與順序（`attempts` 與舊表相同＋`assignment_id`） |
| TC-036-3 | 整合 | `test/integration/assignmentSplitGolden.pg.test.js` | 以 `students.pg.test.js` 的 1,000 筆 fixture 在 M1 前後各取弱點、知識點掌握度、補救卷草稿（固定亂數）、覆蓋率的 JSON，逐欄相同 |
| TC-036-4 | 整合 | 同上 | EXPLAIN：候選池展開檢視後使用 `assignments_first_exposure_key`，沒有掃 `attempt_records` |
| TC-036-5 | 整合／e2e | 既有全部 | 夾具改用 helper（`controllers.pg.test.js` 的觸發器改掛 `assignments`）後全部通過；除第 6.4 節列出、依 Owner 決策改寫的結構與索引名稱斷言外，既有斷言一條不改（ACPT-036-4） |
| TC-036-6 | 單元 | `test/unit/noWritesToAttemptsView.test.js` | 掃描 `controllers/`、`services/`、`workers/`、`scripts/`、`queries/`，不得出現對 `attempts` 的 INSERT／UPDATE／DELETE／TRUNCATE |
| TC-037-1 | 整合 | `test/integration/retrain.pg.test.js` | 旗標關閉 404、批改帶 `retrain` 回 400、不建項目；勾「要重練」建項目、答錯沒勾不建、取消勾選刪項目（重練過則 retired）、改判成對不刪項目；手動加入（`not_assigned` 等 skipped 原因；新題派題沒批改、`paper_id` 為 NULL 的舊紀錄加入後照常到期、出卷不 409）；移出／判定已會／重新加入；承上組一起進；開啟旗標後清單為空（不補建） |
| TC-037-2 | 整合 | 同上 | `retrain:recompute` 的 `--dry-run` 不寫入、正式執行冪等、**不建立任何項目**、改了參數後到期日照新參數重排 |
| TC-038-1 | 單元 | `test/unit/retrainSchedule.test.js`（〔凍結〕已交付） | 純函式表格驅動：第 4.5 節的例子逐列、升關、回第一關、畢業、卡關仍在清單、R2 部分給分、R1 新題那一次不影響排程、未批改與取消批改（in_flight；起算日之前沒批改的新題派題不算，`countsAsInFlight`）、override、manual 起算、練到會後重新加入、承上組帶出的已會題又錯、同日多筆、空歷史、日期加減不受時區影響、`capForAttach` |
| TC-038-2 | 單元 | 同上 | 參數化：K＝2／3／4、間隔表不同時的結果（Owner 改設定不需改程式） |
| TC-038-3 | 整合 | `retrain.pg.test.js` | 批改 PATCH 同一交易建立／更新項目（PATCH 失敗時項目不變）；逐筆批改、改判、取消批改、刪重練卷之後，表上的排程快取＝對當下作答歷史直接呼叫純函式的結果（不變量 I7 的 I/O 層部分，ACPT-038-4）；已派出不再被挑、兩個確認同時送出後者 409 |
| TC-038-4 | 單元 | `test/unit/retrainScheduleProperty.test.js`（〔凍結〕已交付） | 隨機作答歷史（固定種子，1,000 組，含手動加入以前沒批改的題）：與另一種寫法的參考實作逐欄相同、輸入順序無關、逐筆批改（含改判、取消批改）時每一個中間歷史也與參考實作相同、已派出的判斷、不變量 I5。I7 在 I/O 層的部分（快取在同一交易內更新）不在這裡，由 TC-038-3 驗 |
| TC-038-5 | 單元 | `test/unit/retrainConfig.test.js`（〔凍結〕已交付） | `config/retrain.js`：Owner 決定的預設值逐字；環境變數合法照用、空字串＝預設不警告、非法退回預設並只警告一次；關數與畢業次數的關係；getter 即時讀 env；50 題上限與 `examController` 一致 |
| TC-039-1 | 單元 | `test/unit/retrainSelect.test.js` | 到期挑選、排序、上限（`capForAttach`）、承上組不拆且整組放不下時報錯與訊息（R12 選 2）、封存排除、重練題不佔家族名額（R8 選 1） |
| TC-039-2 | 單元 | `test/unit/retrainValidation.test.js` | API-1～8 的參數驗證（400 訊息）、`retrain_question_ids` 必須是子集、旗標關閉時帶 `retrain` 回 400 |
| TC-039-3 | 整合 | `retrain.pg.test.js` | 草稿不寫庫；混合卷確認後派題用途與關卡正確；純重練卷卷名；補救卷 `retrain` 組；刪重練卷後重算；刪原卷被擋 409；刪學生與合併學生的處理 |
| TC-039-4 | 單元＋e2e | `test/unit/solutionText.test.js`（擴充）、`test/e2e/paperWord.e2e.test.js`（新增一案） | Word：沒帶 `paper_id` 逐位元不變；帶了依 R7 選 1 標示（標準版答案區與詳解版標、學生版與題目區不標）；e2e 走「新卷 → 批改錯並勾要重練 → 重練卷 → 下載」 |
| TC-040-1 | 整合 | `retrain.pg.test.js` | API-13 的計數、答對率、分母為 0 時 null；API-4 的到期數 |
| TC-040-2 | 單元 | `test/unit/retrainUi.test.js` | miniDom：旗標關閉不渲染、清單排序與徽章、動作按鈕送出的 body、組卷頁附帶選項（預設不勾、題數預設三成）、批改卡「要重練」勾選框（預設不勾）與徽章、提示、伺服器文字一律 `textContent` |

回歸：完整 `ci.sh`（unit、check:html、migrate、integration、e2e、五個 eval）。eval 的量測值不得因本功能改變（eval 不灌作答紀錄，只有 `pgEngine.js` 的 TRUNCATE 要改表名）。

### 6.4 既有測試會動到哪些

PR-1 要改的既有測試以本表為準（第 5.6 節 PR-1 那一列只舉了 `schema.test.js` 的三條）。行號是基準 `7b7065c` 的行號。分三類：

- **依 Owner 決策改變的行為**：資料表結構或索引名稱本身變了（DEC-003 例外條款選 a：拆表），斷言跟著改寫，驗的仍是同一件事或更多。檔內註明〔Owner 決策單 2026-09-25 B22；DEC-003 例外條款〕。
- **夾具寫法**：只動準備資料或測試工具的程式，斷言一條不改。
- **不動**：列出來是為了說明已經檢查過。

沒有任何一條是放寬斷言。

| 檔案與位置 | 為什麼要改 | 怎麼改 | 類別 |
| :--- | :--- | :--- | :--- |
| `test/integration/schema.test.js:43`「四張表都在」 | 只收 `table_type = 'BASE TABLE'`；`attempts` 變成檢視後不在清單裡 | 改驗 `assignments`、`attempt_records` 是實體表，`attempts`、`assignment_attempts` 是檢視（斷言變多） | 依 Owner 決策改變的行為 |
| `schema.test.js:109`「attempts 的 UNIQUE(student_id, question_id) 擋得住重複指派」 | 對檢視 INSERT 會直接報錯，驗不到唯一約束 | 改對 `assignments` 的新題部分唯一索引驗同一件事（同生同題第二筆 `purpose = 'new'` → duplicate key）；另加「重練列可重複」 | 依 Owner 決策改變的行為 |
| `schema.test.js:137`「attempts.question_id 是 ON DELETE RESTRICT」 | 檢視沒有外鍵，`conrelid = 'attempts'::regclass` 查不到任何一列 | 改驗 `assignments.question_id`（M2 之後加驗 `retrain_items.question_id`） | 依 Owner 決策改變的行為 |
| `test/integration/students.pg.test.js:987`「by_chapter 的計畫含 idx_attempts_student_date」（斷言在 1008 行） | 這個索引隨拆表搬到 `assignments`，改名為 `idx_assignments_student_date`（第 3.7 節），計畫裡不會再出現舊名 | 斷言、失敗訊息與測試名稱裡的索引名改成新名。`enable_seqscan = off` 不變，要驗的意圖也不變：時間窗條件要用得到 `(student_id, assigned_at)` 索引。檢視展開後多了 `purpose = 'new'`，新題的部分唯一索引也可能被選中。PR-1 要在真庫確認計畫仍走時間窗索引；走不到就調整索引設計（例如時間窗索引也帶 `WHERE purpose = 'new'`），不放寬斷言 | 依 Owner 決策改變的行為（索引隨拆表改名） |
| `students.pg.test.js:983`「查詢計畫」區塊 `beforeEach` 的 `ANALYZE attempts` | 對檢視做 ANALYZE 只會警告、不收統計，EXPLAIN 就失去意義 | 改成 `ANALYZE assignments, attempt_records` | 夾具寫法 |
| `test/integration/controllers.pg.test.js:78` 的 `withAttemptsTrigger`，以及 101、106 行的 `DROP TRIGGER … ON attempts` | PostgreSQL 不允許在檢視上建列層級的 BEFORE 觸發器，`CREATE TRIGGER … BEFORE INSERT ON attempts FOR EACH ROW` 直接報錯。用它的兩條 DEC-003 硬閘門測試會在準備階段就失敗：307 行「attempts 寫入筆數短少時回 409，訊息逐字不變且整筆交易回滾」、329 行「第二句 INSERT 直接拋錯時整筆交易回滾」 | 觸發器改掛 `assignments`，建立與拆除都改。409 那條必須仍然走「`INSERT INTO assignments … ON CONFLICT (student_id, question_id) WHERE purpose = 'new' DO NOTHING`＋寫入筆數檢查」這條路：觸發器讓一題寫不進去 → 筆數短少 → 409、訊息逐字不變、整筆回滾。拋錯那條改由 `assignments` 的 INSERT 拋錯。兩條的狀態碼、訊息、回滾後 `exam_papers` 與 `attempts` 為空、之後請求恢復正常等斷言都不改；回滾檢查可以另加 `assignments`、`attempt_records`（只加不減） | 夾具寫法 |
| 23 個整合／e2e 測試檔、約 46 處夾具寫入：`test/e2e/` 的 `paperWord`、`pipeline`；`test/integration/` 的 `chapterMigration`、`chemistry`、`controllers`、`dedup`、`followUp`、`grading`、`hybrid`、`jobs`、`kc`、`kcTagging`、`localExtract`、`nlq`、`paperGroups`、`remedial`、`searchReindex`、`solutions`、`stage5CrossWs`、`studentProfile`、`students`、`tutor`、`variants` | 對檢視做 INSERT、UPDATE、DELETE 或 TRUNCATE 都會報錯 | 改用 `test/helpers/attempts.js`：`insertAttempt`、`clearAttempts`，另加一個更新作答的函式，給 `grading.pg.test.js` 的四處 `UPDATE attempts` 用。`TRUNCATE … attempts, exam_papers, students, questions … CASCADE` 拿掉 `attempts` 即可，CASCADE 會帶到 `assignments`、`attempt_records`。`paperWord.e2e.test.js` 的 `ON CONFLICT (student_id, question_id)` 一併改。只動準備資料的程式 | 夾具寫法（於 helper 檔頭說明） |
| 讀取 `FROM attempts …` 的斷言（`grading`、`students`、`controllers`、`remedial`、`paperGroups`、`stage5CrossWs`、e2e 兩檔） | — | **不動**：讀的是檢視，沒有重練資料時內容相同 | 不動 |
| 回應形狀的斷言：刪學生的 `deleted.attempts`、合併的 `moved_attempts` 與 `dropped_conflicts`、刪卷的 `deleted_attempts`（`controllers.pg.test.js` 576、596、668 行） | — | **不動**：第 3.9 節保留原語意（計的是派題筆數），沒有重練資料時數字相同 | 不動 |
| `hybrid.pg.test.js:104` 的 `to_regclass('public.attempts')` | — | **不動**：檢視也查得到 | 不動 |
| 單元測試中比對 SQL 字串的正規表示式（`remedialValidation.test.js:196`、`hybridQuery.test.js:62`） | — | **不動**：候選池 SQL 沒改 | 不動 |

### 6.5 CI 與本機模式

- 不新增 cassette、不新增 npm 依賴、不呼叫網路；`ci.sh` 的本機模型環境變數與這個功能無關。
- e2e 與五個 eval 目前因缺本機 cassette 而紅；本功能不得增加新的失敗類型（例如 eval 灌 fixture 時 TRUNCATE 檢視失敗——PR-1 必須一併改 `eval/lib/pgEngine.js`）。

---

## 7. 風險與替代方案

### 7.1 風險

| # | 風險 | 可能性 | 影響 | 對策 |
| :--- | :--- | :--- | :--- | :--- |
| R-1 | PR-1 改動 23 個測試檔的夾具，與同一輪其他分支大量衝突 | 高 | 中 | 等本輪（B5、B7、B10、B20、B21…）合併後才開 PR-1；夾具集中到一個 helper，衝突只在呼叫行 |
| R-2 | 日後有人對檢視 `attempts` 寫入，或以為它包含重練 | 中 | 中 | 寫入會立刻報錯；TC-036-6 掃描禁止；`db_design.md` 與檢視上的 `COMMENT ON VIEW` 寫明「只含第一次派題」 |
| R-3 | 到期清單越堆越多（第 4.8 節），舊題擠掉新題或永遠排不完。照 Owner 選的參數（R3 對 3 次、R6 附帶三成），附帶只消化得了每週重練量的約 1/3～1/6 | 中（R1 選 2 由老師勾選，進清單的題會比「答錯全進」少） | 高 | 每週另出一份獨立重練卷（照第 4.8 節的假設約 12～32 題）；附帶上限、優先順序、卡關提醒、成效統計的逾期數；門檻與附帶比例在設定檔、可用環境變數調（第 5.1 節） |
| R-4 | 同一題重做多次，學生記住答案而不是學會 | 中 | 中 | 間隔拉開到週；弱點只看第一次作答（R10 選 1）；卡關提醒改教法；R9 選 1 這一輪用原題，日後改用變式的路保留（第 7.2 節） |
| R-12 | R1 選 2：老師忘了勾「要重練」，該練的題沒進清單 | 中 | 低 | 勾選框放在對錯按鈕旁；清單上可以用題號手動補加（API-2）；批改卡儲存後提示「這次有 N 題答錯、M 題勾了要重練」 |
| R-13 | R12 選 2：到期清單裡有大的承上組時，出卷常被 400 擋下 | 低 | 低 | 訊息直接列出那一組與可以改成的題數（第 4.7 節）；承上組通常 2～3 題 |
| R-5 | 批改拖很久，排程失真 | 中 | 低 | 以派題日起算；已派出未批改不重派並提醒（14 天） |
| R-6 | 刪原卷被擋（新的 409），老師不知道為什麼 | 低 | 低 | 訊息列出擋住的重練卷編號；只在有重練資料時發生 |
| R-7 | 合併學生時丟掉「衝突題在來源側的重練紀錄」 | 低 | 低 | 規則寫進合併確認對話框；合併本來就少見 |
| R-8 | M1 在正式庫失敗或資料不一致 | 低 | 高 | 先備份；migration 內自我檢查、一支一交易；PR-1 附前後 JSON 比對腳本；在「只套到前一號、含舊資料」的庫上演練（同階段 5 的做法） |
| R-9 | 決策單 B7（確認出卷伺服器端檢查承上組）由另一個分支實作，沒考慮重練題 | 中 | 中 | 本檔第 3.8 節與 API-7 寫明「重練題與新題一視同仁」；整合時補一條整合測試：重練卷只放承上題 → 400 |
| R-10 | 檢視帶來效能退化 | 低 | 低 | LEFT JOIN 移除＋部分唯一索引；TC-036-4 的 EXPLAIN 斷言、NFR-010 |
| R-11 | 助教 `list_students` 的數字改讀全部派題，與舊錄放帶不符 | 低 | 低 | eval 資料沒有重練紀錄，輸出逐字相同；cassette 鍵不變 |

### 7.2 替代方案

| 方案 | 內容 | 為什麼沒選 |
| :--- | :--- | :--- |
| **單表加欄** | `attempts` 保留為實體表，加 `purpose` 欄、把唯一約束改成「只管新題」的部分唯一索引、加 `(paper_id, question_id)` 唯一 | 功能上等價，夾具幾乎不用改（改動量最小）。但不符合已核准的驗收文字「資料層拆分派題與作答」，而且日後學生端若要「同一次派題作答多次」還得再拆一次；診斷若要只算第一次作答，得在十多處凍結 SQL 加條件。若 PR-1 實際成本超出預期，可以此為退路，但要先修訂 DEC-003 的驗收文字 |
| 另開重練表（DEC-003 選項 b） | 保留 `attempts` 唯一約束，重練寫另一張表 | Owner 已否決：作答紀錄分散兩處、查詢要合併 |
| 只用變式重練（選項 c） | 不重出原題，改出同家族沒寫過的變式 | Owner 已否決：家族互斥擋住同卷集中練、看不到同一題有沒有進步。手動換變式仍可用既有的「找相似／出變式」 |
| 排程不存表、每次從歷史計算 | 沒有 `retrain_items`，到期清單即時算 | 老師的手動決定（移出、已會、手動加入）與承上組的同組題仍需要地方存；跨學生的到期數要全表計算。採「存快取＋一律可重算」的折衷 |
| SM-2 或 FSRS | 見第 4.2 節 | 第 4.2 節；Owner 2026-09-26 R5 選 1（固定關卡） |
| 把排程單位設成「家族」 | 追蹤 `COALESCE(variant_of, id)`，回測時抽同家族沒寫過的題 | 工作量約多一倍、依賴變式品質（變式閘門通過率約 0.25）；Owner 2026-09-26 R9 選 1：這一輪一律用原題 |

---

## 8. Owner 的決定

〔凍結〕Owner（Ben）2026-09-26 在「重練與收尾決策單」第三輪逐題答覆如下，本檔依答覆凍結；參數寫進 `exam_pro/config/retrain.js`，註解標〔Owner 決策單 2026-09-26 R*〕。下方各題保留當時的背景、選項與建議（供日後查考），答覆寫在每題最後。R12 是設計審查後補的題，和決策單同名題一致，放在出卷一組（R8 之後）。

| 題 | 答覆（2026-09-26） | 與原建議 | 改寫的段落 |
| :--- | :--- | :--- | :--- |
| R1 | **選 2**：只有老師在批改卡上勾「要重練」的題才進清單（清單上也可以手動加入、移出） | 不同（原建議 1） | 第 0、1、3.4、4.4、4.6、5.1、5.2（API-9、API-10）、5.3、5.5、6 節 |
| R2 | **選 1**：只有全對才算對（沒給部分分，或給 100%） | 相同 | 第 4.3、4.6 節；`isCorrect` |
| R3 | **選 2**：對 3 次才算練到會：重做（下一份卷）、隔 1 週、再隔 2 週（約 3～4 週畢業） | 相同 | 第 4.3、4.8 節；`config/retrain.js` |
| R4 | **選 1**：重練或回測又錯 → 回到第一關，錯的次數加一；錯滿 3 次標「卡關」提醒老師（仍留在清單，不自動移出） | 相同 | 第 4.3、4.4 節 |
| R5 | **選 1**：固定關卡（Leitner 式），間隔與次數依 R3；排程是作答歷史的純函式 | 相同 | 第 4.3、4.6 節；ADR-019 |
| R6 | **選 1**：兩種都有：出新卷（單章、跨章、補救卷）時可勾「附上到期的重練題」，預設上限為新題數的三成（可改）；另有「出一份重練卷」按鈕 | 相同 | 第 4.7、4.8、5.2（API-6、API-8）、5.3 節；`capForAttach` |
| R7 | **選 1**：學生卷面不標；老師的標準版答案區、詳解版與批改卡標「重練」 | 相同 | 第 5.2（API-6、API-12）、5.3、5.4 節 |
| R8 | **選 1**：重練題不佔變式家族名額，同家族的一題新變式可以同卷 | 相同 | 第 3.8、5.2（API-6）節 |
| R12 | **選 2**：重練題的承上題組放不進卷時，跟新題一樣直接報錯，請老師調整題數（與 B10 一致） | 不同（原建議 1） | 第 3.8、4.7、5.2（API-5、API-6、API-8）節 |
| R9 | **選 1**：這一輪一律用原題（不做變式替換） | 相同 | 第 1.2、3.4、5.4、7.2 節 |
| R10 | **選 1**：弱點面板與補救卷只算每題「第一次」作答；另有「重練成效」表（重練答對率、練到會題數、卡關題） | 相同 | 第 2.5、3.8、5.2（API-13）節 |
| R11 | **選 3**：開啟功能時不補建以前的錯題，從開啟那天起才開始記（以前的錯題老師可以手動加進清單） | 不同（原建議 1） | 第 3.6、5.1、5.2（CLI 改成 `retrain:recompute`）、5.5、6 節 |

### R1　哪些錯題要自動進「錯題重練」清單（錯題重練）

**背景**：批改時按「錯」的題，之後要能再出給同一位學生重做，直到練會。系統要知道哪些題該進這份清單。錯因已經有「粗心抄錯」「時間不足」等選項可以標。清單越長，之後每份卷要分給舊題的位置就越多。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 答錯的題（含未作答、部分給分沒滿分）自動進清單；你可以手動移出或加入 | 不會漏題；粗心的題要自己按「移出」 |
| 2 | 只有你在批改卡上勾「要重練」的題才進 | 清單最精簡；每張卷多點一次，忘了勾就漏 |
| 3 | 自動進，但錯因只標了「粗心抄錯」或「時間不足」的不進 | 少一些不必要的重練；錯因沒標的照樣會進 |

**建議與理由**：選 1。家教最常發生的是「忘了追蹤錯題」，自動進清單比較不會漏；粗心的題不多，移出只要按一下。用一陣子覺得太多，再改成 3 只要改設定。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 2**。只有老師在批改卡上勾「要重練」的題才進清單；清單上也可以手動加入、移出。→ 批改卡每題多一個「要重練」勾選框（預設不勾）；答錯不自動進清單；新題那一次的對錯不影響排程（第 4.4、4.6 節）。原建議的 `ENTRY_RULE` 設定不做（第 5.1 節）。

### R2　部分給分的題，算「對」還是「錯」（錯題重練）

**背景**：計算題可以給部分分（例如 60%）。「要不要進重練清單」和「這次重練算不算過關」都要用到這條線。系統現在有三種算法：補救卷把「沒拿滿分」當成答錯題來算平均難度；知識點掌握度與補救卷的章節掌握度按比例計分（給 60% 算 0.6 題對）；弱點面板的錯題數只看「對／錯」按鈕。這一題只決定重練，不會改動那三處既有算法。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 只有全對才算對（沒給部分分，或給 100%） | 最嚴，和補救卷判定「答錯題」的方式一致；拿 80% 也要再練 |
| 2 | 拿到 80% 以上算對 | 小失誤不必再練；80% 這條線是人為訂的 |
| 3 | 只看「對／錯」按鈕，不看部分給分 | 最簡單，和弱點面板的錯題數一致；按了「對」但給 50% 的題也算對 |

**建議與理由**：選 1。「練到會」應該是整題做對，和補救卷判定答錯題的方式相同；只差一點的題通常下一次就過關，負擔不大。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。只有全對才算對（沒給部分分，或給 100%）。→ `isCorrect`：已批改且 `COALESCE(score, result) ≥ 1`；`CORRECT_THRESHOLD = 1` 固定、不開放覆寫。R1 選 2 之後，這條線只用在重練與回測的升降關（進不進清單由老師勾）。

### R3　怎樣才算「練到會」（間隔複習）

**背景**：錯題重做一次就對，常常只是剛看過詳解還記得；隔一段時間再考還對，才比較像真的會。做法是「錯了之後先重做一次，之後隔一段時間再考」，連續對滿幾次才畢業。次數越多越可靠，但每週要分給舊題的位置越多：假設每週新錯 6 題，畢業要對 2／3／4 次時，每週大約要重練 12～21／18～38／24～63 題舊題（前面的數字是每次重練都對，後面是重練有三成又錯）。

**要和 R6 一起看**：R6 建議的「附在新卷、上限為新題數的三成」，在每週 20 題新題時一週只放得下 6 題。其餘要靠每週另出一份獨立重練卷：選 1 約 6～15 題，選 2 約 12～32 題，選 3 約 18～57 題（一份重練卷上限 50 題，可能要兩份）。不另出重練卷的話，三個選項的清單都會越堆越多，只是選 1 堆得最慢（第 4.8 節）。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| 1 | 對 2 次：重做對一次，隔 1 週再對一次（約 2 週畢業） | 負擔最輕；只驗證到「1 週後還記得」 |
| **2（建議）** | 對 3 次：重做、隔 1 週、再隔 2 週（約 3～4 週畢業） | 驗證到「2 週後還記得」；每週舊題約為新錯題的 3 倍，附在新卷只放得下約 1/3～1/6，其餘要每週另出一份重練卷 |
| 3 | 對 4 次：重做、隔 1、2、4 週（約 7～8 週畢業） | 最可靠、接近段考週期；舊題量最大，清單容易排不完 |

**建議與理由**：選 2。學習研究常見的建議是「隔開時間、成功回想滿三次」；兩週的間隔大約就是兩次考試之間會遇到的遺忘。更多次會讓舊題擠掉新題。這個建議的前提是每週另出一份獨立重練卷（R6）。數字寫在設定檔，用一陣子發現清單消化不完，改成 1 只要改一個數字。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 2**。對 3 次才算練到會：重做（下一份卷）、隔 1 週、再隔 2 週（約 3～4 週畢業）。→ `config/retrain.js`：`STEP_DAYS = [1, 7, 14]`、`MASTERY_STREAK = 3`；要改成選 1 只要設 `RETRAIN_MASTERY_STREAK=2`（第 5.1 節）。

### R4　重練或隔週回測時又錯了，怎麼辦（間隔複習）

**背景**：清單裡的題在重做或隔週回測時又錯了。可以讓它從頭來過，也可以只退一步。同一題一直錯，通常代表觀念沒懂，一再重做同一題幫助有限。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 回到第一關（下一份卷就再重做），錯的次數加一；錯滿 3 次標「卡關」提醒你（仍留在清單） | 最嚴；卡關的題由你決定改講觀念或出變式 |
| 2 | 只退一關（例如從「隔 2 週」退回「隔 1 週」） | 畢業比較快；可能半會半不會就畢業 |
| 3 | 回到第一關；錯滿 3 次自動移出清單，改由補救卷處理那個觀念 | 自動化；但你少看一眼，那一題之後不會再出。也和已核准的 DEC-016「錯過的題要練到會為止」衝突，選這個要先修訂 DEC-016 |

**建議與理由**：選 1。間隔複習的標準做法是錯了就從頭；「卡關」只提醒、不自動移出，換不換教法由你決定，系統不替你放棄一題。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。重練或回測又錯 → 回到第一關，錯的次數加一；錯滿 3 次標「卡關」提醒老師（仍留在清單，不自動移出）。→ `STUCK_LAPSES = 3`；卡關＝進行中且錯的次數 ≥ 3，只提醒，照樣到期。錯的次數只算重練與回測，重新加入也不歸零（第 4.4 節）。

### R5　排程要「固定好懂」，還是讓系統自己調整間隔（間隔複習）

**背景**：第一種是固定關卡：第 1 關下一份卷、第 2 關隔 1 週、第 3 關隔 2 週，錯了回第一關，你看得出每題為什麼今天到期。第二種（SM-2，Anki 早期的做法）是每題依過去表現算自己的間隔，常錯的題間隔變短。第三種（FSRS）是目前最準的演算法，但要加一個套件，參數要用大量作答資料校準。家教一週上一兩次課，「7 天」和「9 天」到期其實都是等下一次上課才出。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 固定關卡（間隔與次數依 R3） | 可預期、好解釋、容易測；不會因人因題調整 |
| 2 | SM-2：每題自己調間隔 | 常錯的題自動更常出現；間隔數字不直觀，要累積幾次作答才準 |
| 3 | FSRS | 理論上最省題數；要加套件，資料少時不準，你很難檢查它為什麼這樣排 |

**建議與理由**：選 1。紙本、一週一兩次課的節奏下，自動微調的好處幾乎都被「等下次上課」吃掉；固定關卡你看得懂也改得動。排程是從作答歷史重算的，之後要換成 2 或 3 不會丟資料。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。固定關卡（Leitner 式），間隔與次數依 R3；排程是作答歷史的純函式。→ `services/retrainSchedule.js` 的 `computeRetrainState`（第 4.6 節）；決策紀錄 ADR-019。

### R6　到期的重練題怎麼出到卷上（出卷）

**背景**：到期的重練題要放進某一份卷，學生才會再寫到。可以附在平常出的新卷裡，也可以單獨出一份「錯題重練卷」，或兩種都有。附在新卷時要有上限，不然舊題會擠掉新題。

注意份量：照 R3 的建議（對 3 次才算會），一週新錯 6 題時，每週大約要重練 18～38 題舊題。附在新卷的上限若是三成、一份新卷 20 題，只放得下 6 題，其餘要靠獨立的重練卷消化，大約每週一份、12～32 題。一般來說，附帶比例和錯題率都是三成時，附帶最多只消化得了每週重練量的 1/K（K 是 R3 的畢業次數），實際上更少（第 4.8 節）。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 兩種都有：出新卷（單章、跨章、補救卷）時可勾「附上到期的重練題」，預設最多為新題數的三成（出卷時可改）；另有「出一份重練卷」按鈕 | 最有彈性；出卷頁多一個選項。照 R3 的建議，「出一份重練卷」大約每週都要用一次 |
| 2 | 只出獨立的重練卷 | 畫面最單純；學生要多寫一份卷，你要記得出；每週的重練量全在這份卷上 |
| 3 | 每份新卷自動附上（不用勾），上限三成 | 不會忘；想出純新題卷時要記得關掉；三成同樣只消化得了一部分，放不完的仍要靠獨立重練卷 |

**建議與理由**：選 1。平常上課順手附幾題，放不完的到期題用獨立重練卷消化；三成只是預設，每次出卷都能改。只靠附帶消化不完：R3 不論選哪一個，都要搭配獨立重練卷，每週大約是選 1 為 6～15 題、選 2（建議）為 12～32 題、選 3 為 18～57 題。所以照 R3 的建議，重練卷大約每週都要出一份，不是只在考前或清單變長時才出。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。兩種都有：出新卷（單章、跨章、補救卷）時可勾「附上到期的重練題」，預設上限為新題數的三成（可改）；另有「出一份重練卷」按鈕。→ `ATTACH_RATIO = 0.3`；`capForAttach(新題數)`＝新題數 × 0.3 無條件捨去、合計不超過 50 題（第 4.7 節）；勾選框預設不勾。

### R7　卷面上要不要標出「重練題」（出卷）

**背景**：學生拿到卷子時，看不看得出哪幾題是以前錯過的？標出來，學生知道要特別注意，但可能先翻舊卷找答案，也可能緊張；不標，比較能看出他是不是真的會。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 學生的卷面不標；你的標準版答案區、詳解版與批改卡上標「重練」 | 測得比較真；你自己看得到 |
| 2 | 卷面也標：重練題集中放在卷末「錯題重練區」 | 學生知道在複習，比較像錯題本；比較難看出真實程度 |
| 3 | 哪裡都不標 | 最單純；批改時你要自己記哪幾題是重練 |

**建議與理由**：選 1。重練要驗的是「隔一段時間還會不會」，提示反而會干擾；你批改時需要知道，所以只在老師看的地方標。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。學生卷面不標；老師的標準版答案區、詳解版與批改卡標「重練」。→ API-12（第 5.2 節）：標準版題目區不標、答案區標；詳解版標；學生版不標；重練題與新題一起依題型、難度排，不另分區。

### R8　重練題和它的「變式題」可以出在同一張卷嗎（出卷）

**背景**：目前一張卷裡，同一個變式家族（原題與它的變式）最多只出一題，避免同卷出兩道幾乎一樣的題。你先前沒選「只用變式重練」，理由之一就是這條規則擋住同一張卷集中練同一個觀念。重練題是舊題，它的變式對學生來說是新題。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 可以：重練題不佔家族名額，同家族的一題新變式可以一起出 | 同一觀念可以集中練；兩題很像，新變式那一題的「第一次作答」會比較容易，弱點統計略偏樂觀 |
| 2 | 不可以：維持一張卷同家族最多一題 | 規則不變；有重練題時，它的變式要等下一張卷 |

**建議與理由**：選 1。符合你之前的取捨（要能同卷集中練同一個觀念）；變式本來就是為了「換個數字再練一次」。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。重練題不佔變式家族名額，同家族的一題新變式可以同卷。→ 家族互斥只在新題之間檢查（第 3.8 節、API-6）；原建議的 `SAME_FAMILY_ALLOWED` 設定不做（第 5.1 節）。

### R12　重練題的承上題組放不進卷時怎麼辦（出卷）

**背景**：到期的重練題若屬於承上題組，要整組一起出（第 4.4 節）。你在 B10 決定：新題湊不滿題數時直接報錯、請你改題數。重練題附在卷上時，數量本來就是「最多幾題」，不是一定要湊滿。這一題只問重練題；新題的 B10 規則不受影響。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 跳過那一組，出卷結果附註「有一組重練題因為整組放不下，下次再出」 | 卷一定出得來；那一組留在到期清單，逾期天數增加，下次優先 |
| 2 | 跟新題一樣直接報錯，請你調整題數 | 規則和新題一致；到期清單裡有大組時，可能要調整題數才出得了卷 |

**建議與理由**：選 1。重練題數是上限，放不下就留到下次，不該讓整份卷出不來；新題的 B10 規則不受影響。這一題決定組卷時重練題組的處理（FR-039，PR-3）。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 2**。重練題的承上題組放不進卷時，跟新題一樣直接報錯，請老師調整題數（與 B10 一致）。→ 產生草稿的三條路（API-5、API-6、API-8）遇到整組放不下就回 400、不產生草稿，訊息列出那一組與可以改成的題數（第 4.7 節）。

### R9　重練要用原題，還是改用同家族的變式（錯題重練）

**背景**：同一題重做好幾次，學生可能記得答案，而不是真的會。另一種做法：第一次重練用原題，之後的隔週回測改用同一家族、他還沒寫過的變式（沒有才用原題）。這樣排程要從「一題」改成「一個家族」來追蹤，工作量大約多一倍；目前自動生成變式的通過率還不高（約四分之一），很多題沒有現成的變式。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 這一輪一律用原題；想換題時用現有的「找相似／出變式」手動加 | 最快做完；背答案的風險靠「隔開時間」與「卡關提醒」降低 |
| 2 | 這一輪就做：隔週回測優先換成沒寫過的變式 | 比較能測到真的會；工作量約多一倍、交付延後，題庫沒有變式時仍用原題 |

**建議與理由**：選 1。你核准的例外條款就是「可以再出同一題」；先把原題重練做穩、看幾週資料，再決定要不要加上變式替換。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。這一輪一律用原題（不做變式替換）。→ 排程單位維持「題」（第 3.4 節）；想換題時用既有的「找相似／出變式」。

### R10　弱點面板與補救卷，要怎麼算重練與複習的作答（診斷與統計）

**背景**：以後同一題會有好幾次作答（第一次、重練、隔週回測）。章節錯誤率、錯因分布、知識點掌握度、補救卷挑弱點，都是從作答算出來的。同一題重做很多次，會讓「樣本數」灌水，也可能因為背答案看起來變好。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 弱點與補救卷只算每題「第一次」作答；重練另外有一張「重練成效」表（重練答對率、練到會題數、卡關題） | 現在的數字與報表完全不變；學生練會某題後，章節弱點不會立刻變好，要等新題也做對 |
| 2 | 每題只算「最近一次」作答 | 進步馬上看得到；重練對了可能只是記得答案，弱點會太早消失，補救卷可能太早不補 |
| 3 | 每次作答都算 | 最簡單；重練多次的題比重過高，掌握度失真 |

**建議與理由**：選 1。弱點要回答的是「他遇到沒看過的題會不會」，重練成效另外看才不會混在一起；而且選這個，既有的數字與報表不變，弱點相關的測試除了拆表本身要改的那幾條（第 6.4 節）之外都不用改。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 1**。弱點面板與補救卷只算每題「第一次」作答；另有「重練成效」表（重練答對率、練到會題數、卡關題）。→ B 類讀取不動（讀檢視 `attempts`，第 2.5 節）；「重練成效」＝API-13（第 5.2 節）。

### R11　開啟這個功能時，以前的錯題要不要補進清單（上線）

**背景**：功能開啟之前已經批改過的錯題，系統可以一次補進重練清單。補太多，第一週的到期清單會很長，要好幾週才消化得完；太久以前的錯題，學生可能已經在學校學會了，也可能早就忘了題目本身。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 只補最近 30 天內的錯題；更早的你可以在清單上手動加 | 第一週份量可控 |
| 2 | 全部補進來 | 不漏；第一週清單可能上百題，要分好幾週出完 |
| 3 | 不補，從開啟那天起才開始記 | 最乾淨；以前的錯題都要你手動加 |

**建議與理由**：選 1。一個月內的錯題還在「該趁熱練」的時間裡，份量也消化得完；天數是補建指令的參數，想多補可以再跑一次。

**Owner 答覆（2026-09-26 決策單第三輪）**：**選 3**。開啟功能時不補建以前的錯題，從開啟那天起才開始記（以前的錯題老師可以手動加進清單）。→ 原草案的 `retrain:rebuild` 補建取消，改成只重算既有項目的 `retrain:recompute`（第 3.6、5.2 節）；以前的錯題用 API-2 手動加入，起算日＝加入當天。

---

## 9. 附錄

### 9.1 名詞與資料對照

| 白話 | 資料 | 說明 |
| :--- | :--- | :--- |
| 派題 | `assignments` 一列 | 一題放進一位學生的一張卷；`purpose` 為 `new`（第一次）或 `retrain`（重練、回測） |
| 作答 | `attempt_records` 一列 | 那一次派題的對錯、部分給分、錯因、學生答案、註記 |
| 第一次作答（舊 attempts） | 檢視 `attempts` | 每生每題最多一列；弱點面板、補救卷、候選池讀它 |
| 全部作答 | 檢視 `assignment_attempts` | 含重練；試卷明細、批改、重練功能讀它 |
| 錯題重練清單的一題 | `retrain_items` 一列 | 每生每題最多一列；老師勾「要重練」（`flagged`）、承上組帶入（`group`）或手動加入（`manual`）才有 |
| 要重練（勾選） | 批改卡的勾選框；API-10 的 `retrain` | R1 選 2：答錯不自動進清單 |
| 關卡 | `retrain_items.step`、`assignments.retrain_step` | 1＝錯題重練、2＝一週回測、3＝兩週回測（R3 選 2；畢業次數改成 4 時才有第 4 關） |
| 算對 | 已批改且 `COALESCE(score, result) ≥ 1` | R2 選 1：全對才算對 |
| 到期 | `status = 'active'` 且 `due_on ≤ 預計作答日` 且沒有已派出待批改 | 已派出的範圍見下一列 |
| 練到會 | `status = 'mastered'` | 連續答對 3 次（R3），或老師判定 |
| 卡關 | `status = 'active'` 且 `lapses ≥ STUCK_LAPSES`（預設 3） | R4 選 1：只提醒，仍在清單、照樣到期，不自動移出 |
| 已派出、待批改 | 這一題有一筆還沒批改（含取消批改）的重練派題，或派題日 ≥ 起算日、還沒批改的新題派題（`countsAsInFlight`） | 不算到期、不會再派。起算日之前的新題派題沒批改不算（手動加入以前的題，那一筆可能是批改不了的舊紀錄；第 4.4 節） |

### 9.2 預計新增或修改的檔案（實作時）

| 類型 | 檔案 |
| :--- | :--- |
| migration | `<0016 之後的下一號>_assignment_attempt_split.sql`、`<再下一號>_retrain_items.sql` |
| 設定 | `config/retrain.js`（〔凍結〕已交付）、`config/features.js`（getter） |
| 服務 | `services/retrainSchedule.js`（純函式，〔凍結〕已交付）、`services/retrainService.js`（I/O） |
| 控制器 | `controllers/retrainController.js`（新）；擴充 `examController.js`（writePaper、confirmPaper、deletePaper、generatePaper）、`paperController.js`（GET、PATCH）、`studentController.js`（兩處改讀全部派題）、`studentAdminController.js`（刪除、合併）、`remedialController.js`、`wordController.js` |
| 其他讀取 | `services/assistantService.js`（`list_students` 改讀全部派題）、`services/remedialService.js`（重練組）、`services/wordService.js`（R7 標示） |
| 路由與前端 | `routes/index.js` 檔尾區塊；`public/js/retrain.js`（新）；`public/index.html`、`public/js/students.js`、`public/js/remedial.js` 的最小掛鉤；`app.js` 注入 `__FEATURE_RETRAIN__` |
| 腳本 | `scripts/recompute_retrain.js`（`npm run retrain:recompute`，只重算、不建立；R11 選 3 取消補建）、遷移前後比對腳本 |
| eval | `eval/lib/pgEngine.js` 的 TRUNCATE 改表名（量測值不變） |
| 測試 | `test/helpers/attempts.js`（新）、第 6.3 節列出的新測試（其中 `retrainConfig`、`retrainSchedule`、`retrainScheduleProperty` 三支單元測試已交付）、第 6.4 節列出的既有測試 |
| 文件 | 本檔（已凍結，含給老師的操作說明；實作時補「與本檔不同之處」）；ADR-018、ADR-019（已新增）；`.env.example` 的 `FEATURE_RETRAIN` 與四個 `RETRAIN_*` 變數（PR-2 加）；其他共用文件（`srs.md`、`engineering_tracker.md` 的 ADR 索引、`HANDOFF.md` 等）由文件整合任務處理 |
