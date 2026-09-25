# 錯題重練與間隔複習：設計草案

> **狀態：草案，待 Owner 決定第 8 節後凍結。**
> 版本 0.1（2026-09-26）｜分支 `dec/design-retrain-spaced`（基準 `7b7065c`，`local/integration`）｜本檔只寫設計，沒有改任何程式。
> **需求來源**：DEC-003 例外條款（錯題重練與間隔複習可再出同一題、每次作答各自記錄；資料層拆「派題」與「作答」，Owner 選 a：拆表）、DEC-016（錯過的題要練到會為止、依間隔複習排程回測）；兩者 2026-09-25 已核准。開發順序依 Owner 決策單 B22（錯題重練 → 間隔複習 → 診斷報告 → …）。缺口編號 G11、G13（`docs/HANDOFF.md` 第 0.2 節 G 段）。
> **編號**：功能需求自 FR-036 起、驗收自 ACPT-036 起，本檔的編號是**草案**，正式分配由整合階段決定。migration 寫成「0016 之後的下一號」（0016 可能被同一輪的其他分支用掉），本檔以 **M1**、**M2** 代稱，預計是 0017、0018。
> **不呼叫任何 LLM**：這個功能全是資料庫與純函式，本機模式與 Gemini 模式的行為相同，不需要任何 cassette。
> 共用文件（`engineering_docs/**`、`docs/HANDOFF.md`、`docs/roadmap-plan.md`、`docs/interfaces-stage5.md`）由文件整合任務依本檔回填，本分支沒有動。

## 目錄

- [0. 一分鐘看懂](#0-一分鐘看懂)
- [1. 目標與範圍](#1-目標與範圍)
- [2. 現況：作答怎麼記、組卷怎麼排除已作答](#2-現況作答怎麼記組卷怎麼排除已作答)
- [3. 資料模型：派題與作答拆表](#3-資料模型派題與作答拆表)
- [4. 間隔複習排程演算法](#4-間隔複習排程演算法)
- [5. API 與畫面草案](#5-api-與畫面草案)
- [6. 測試計畫與驗收](#6-測試計畫與驗收)
- [7. 風險與替代方案](#7-風險與替代方案)
- [8. 需要 Owner 決定的問題](#8-需要-owner-決定的問題)
- [9. 附錄](#9-附錄)

---

## 0. 一分鐘看懂

**現在**：一題只要出給某位學生過一次，不論對錯，系統就永遠不會再出給他（DEC-003 原條文）。錯題只能靠「找相似」「出變式」間接補強。

**做完之後**，老師的日常會變成：

1. 批改時照常按「對／錯」。按「錯」的題，會自動進入這位學生的「**錯題重練**」清單。
2. 下次出卷時，勾「**附上到期的重練題**」（或按「出一份重練卷」），系統把到期的舊錯題放進卷裡；新題照舊不會重複。
3. 批改重練題：**對了升一關、錯了回第一關**。關卡的間隔是「下次出卷 → 隔 1 週 → 隔 2 週」，**連續對 3 次就算練到會**（建議值，第 8 節由 Owner 決定）。
4. 學生頁多一張「錯題重練」卡：幾題到期、幾題練到會、哪幾題一直錯（卡關）。

**資料上怎麼做到**：把現在一張 `attempts` 表拆成兩張——「**派題**」（哪一題、哪一天、在哪張卷、派給誰、這次是新題還是重練）與「**作答**」（對錯、部分給分、錯因、學生答案、註記）。「新題每生每題只能派一次」的硬閘門留在派題表上，只管「新題」；重練題另走排程清單。舊的 `attempts` 名字保留成一個唯讀檢視，內容和現在完全一樣（每生每題一列、第一次那次），所以弱點面板、補救卷、覆蓋率等既有功能的讀法與數字都不用改。

**需要 Owner 決定的 11 件事**在第 8 節，每題都附背景、選項與建議；不看其他段落也能回答。

---

## 1. 目標與範圍

### 1.1 目標（可以觀察到的結果）

| # | 目標 | 對應 |
| :--- | :--- | :--- |
| 1 | 答錯的題能再出給同一位學生重做，每次作答各自留下紀錄，看得到「第一次錯、第二次對」 | DEC-003 例外條款、G11 |
| 2 | 系統依排程決定每題「什麼時候該再考」，連續答對到門檻才算練到會，之後不再出 | DEC-016、G13 |
| 3 | 出新題的組卷**仍然**排除該生寫過的題，而且由資料庫硬擋，不只靠程式 | DEC-003 原條文 |
| 4 | 沒有使用重練功能時，所有既有 API 的回應、數字與行為與現在逐字相同 | 相容性（同 NFR-009 的精神） |
| 5 | 老師看得懂排程為什麼這樣排，也能手動加入、移出、判定已會 | DEC-014「看懂學生」 |

### 1.2 範圍

| 範圍內 | 範圍外（之後的項目，本檔不設計） |
| :--- | :--- |
| 派題與作答拆表、既有資料遷移、相容檢視 | 診斷報告（老師版、家長版，G14） |
| 錯題重練清單（自動建立、手動加入／移出／判定已會、承上題整組） | 入班診斷卷（G15）、學習路徑與提示階梯（G17、G18） |
| 間隔複習排程（到期、升關、回第一關、練到會、卡關） | 學生端登入與自助作答（G24） |
| 出卷整合：新卷附帶重練題、獨立重練卷、補救卷附帶；確認出卷；Word 標示 | Word「錯題訂正卷」版本（題後留白、詳解另頁，TEACH-11 的 correction） |
| 老師端畫面（學生頁卡片、組卷頁選項、批改卡徽章、學生清單到期數） | 依錯因專練（G16）、變式自動替換原題（第 8 節 R9 選項 2） |
| 重練成效統計（第一次重練答對率、隔週回測答對率、練到會題數） | 任何 LLM 功能；跨學生的排程最佳化；上課行事曆 |

### 1.3 設計原則

1. **DEC-003 的硬閘門不鬆**：「新題每生每題一次」仍由資料庫唯一索引保證；例外只開給「在排程清單裡的題」，也由資料庫外鍵保證（第 3.5 節）。
2. **既有讀法不動**：舊的 `attempts` 以唯讀檢視保留原本的欄位與語意（每生每題一列＝第一次派題）。凍結的弱點 SQL、候選池 SQL 一個字都不用改。
3. **排程是作答歷史的純函式**：每題的關卡、到期日、連對次數都能從「這位學生這一題的全部作答」重算出來。改判、取消批改、刪卷之後重算即可，不會留下算錯的狀態；之後要換演算法也不會丟資料。
4. **老師最後決定**：系統只提議（到期清單、卡關提醒），出不出、移不移出由老師按。
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
| **D. 寫入** | `examController.js:596`（writePaper）、`:688`（deletePaper）、`studentAdminController.js:121`（刪學生）、`:160–168`（合併學生）、`paperController.js:363`（PATCH）、`migrate/import_pg.js:259、273`（階段 1 的 MySQL 切換工具，已完成的一次性任務）、`eval/lib/pgEngine.js:130`（eval 灌 fixture 前 TRUNCATE）、測試夾具（23 個測試檔、約 46 處 INSERT／DELETE／TRUNCATE） | — |

### 2.4 卡在哪

- `UNIQUE (student_id, question_id)` 讓同一題對同一位學生只能有一列：重派必定 409。
- 批改直接覆寫那一列的 `result`：就算能重派，第二次作答也會蓋掉第一次。
- 候選池的 `NOT EXISTS attempts` 本身沒有問題——新題本來就該排除寫過的題；問題在於它和「一題只能有一列」綁在一起。

### 2.5 要改哪裡，才能「新題組卷仍排除已作答、重練卻能再出」

| # | 改動 | 為什麼 |
| :--- | :--- | :--- |
| 1 | **閘門搬家**：`UNIQUE (student_id, question_id)` 改成派題表上的部分唯一索引，只管「用途＝新題」的列 | 新題仍然每生每題一次；重練列不受限 |
| 2 | **排除規則不動**：`attempts` 改成唯讀檢視，只列「新題」那一次派題（每生每題最多一列，和現在一樣）；再加一條由外鍵保證的不變量「重練派題一定有同生同題的新題派題」 | 有了這條不變量，「有新題派題」＝「曾經派過」，A 類九處查詢不用改就是對的 |
| 3 | **重練走另一條路**：重練題不經候選池，而是從排程清單（`retrain_items`）挑到期的；確認出卷時寫成「重練」派題並連到清單項目 | 重練題本來就不是「新題」，不該和候選池混在一起 |
| 4 | **寫入點改寫**（D 類）：寫派題表與作答表，而不是寫檢視 | 檢視是唯讀的，寫錯地方會立刻報錯（不會靜默） |
| 5 | **卷層讀取改讀全部派題**（C 類四處＋助教一處）：改讀另一個檢視 `assignment_attempts` | 重練卷上的題不是「新題」，檢視 `attempts` 看不到它們 |
| 6 | **診斷讀取（B 類）不動**：預設只算每題第一次作答（第 8 節 R10 選項 1） | Owner 若選其他口徑，只要把 B 類改讀另一個檢視 |

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

檔名草案：`<下一號>_retrain_items.sql`。**欄位依第 8 節的決定可能微調**（例如 R9 選 2 時，追蹤單位要從「題」改成「家族」），所以放在 M1 之後另一支。

```sql
CREATE TABLE retrain_items (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id           INT  NOT NULL REFERENCES students(id),
    question_id          INT  NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    source_assignment_id BIGINT NOT NULL,                    -- 這一題第一次（新題）派給他的那一筆
    source_purpose       TEXT NOT NULL DEFAULT 'new' CHECK (source_purpose = 'new'),
    reason               TEXT NOT NULL CHECK (reason IN ('wrong', 'group', 'manual')),
                         -- wrong＝答錯自動進；group＝承上組的同組題一起進；manual＝老師手動加
    entered_on           DATE NOT NULL DEFAULT CURRENT_DATE, -- group／manual 的起算日；wrong 以作答歷史為準
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
    override_at          TIMESTAMPTZ,
    note                 TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT retrain_items_student_question_key UNIQUE (student_id, question_id),
    CONSTRAINT retrain_items_ref_key UNIQUE (id, student_id, question_id),
    CONSTRAINT retrain_items_due_check CHECK ((status = 'active') = (due_on IS NOT NULL)),
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
- 「已派出、還沒批改」「卡關」不另存欄位，查詢時由作答歷史與 `lapses` 算出（第 4.4 節）。
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

**I1 是這份設計的關鍵**：有了它，「這位學生有沒有這一題的新題派題」與「這一題有沒有派給過他（任何用途）」永遠相等，所以 A 類九處排除查詢繼續讀檢視 `attempts` 就是對的，不用改。

### 3.6 既有資料遷移

1. **先備份**（Owner 上線流程第一步就是備份：`npm run db:backup`，`deployment_and_operations.md` §3.4）。
2. `npm run migrate` 套 M1：搬資料、自我檢查、刪舊表、建檢視，全部在一個交易；任何一步失敗整支回滾，資料庫維持原狀。
3. 套 M2：只建新表與新欄位，不搬資料。
4. 功能旗標開啟時，執行 `npm run retrain:rebuild -- --dry-run`（印出會建立幾個項目、各幾題到期）→ 再不帶 `--dry-run` 執行。補建的範圍依 R11 的決定（建議：最近 30 天的錯題）。
5. **驗證腳本**（PR-1 交付）：migration 前後各跑一次，把每位學生的 `GET /api/students/:id/weakness`、`/weakness/kc`、`GET /api/coverage?student_id=`、補救卷的 `basis` 與 `blueprint` 存成 JSON，比對必須逐欄相同。
6. `migrate/import_pg.js`、`export_pg_delta.js`、`verify.js` 是 2026-08-21 MySQL 切換用的一次性工具，寫的是舊 `attempts` 表；M1 之後不再適用，檔頭加註「只適用於 0016 之前的 schema」，不另外改寫。

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

既有 `students.pg.test.js` 的 1,000 筆 fixture 與 EXPLAIN 斷言照跑；PR-1 另加一條 EXPLAIN，確認候選池展開檢視後走的是部分唯一索引。

### 3.8 與補救卷、弱點統計、其他功能的關係

| 功能 | 關係 |
| :--- | :--- |
| 單章／跨章組卷、補救卷的**新題**候選池 | 不變（讀檢視 `attempts`＋I1）。重練題不經候選池。 |
| 補救卷 | 可選加一個「到期重練」組（R6）。它的 `basis`、弱點排序照舊只看第一次作答（R10）。 |
| 弱點面板（章節、題型、難度、週趨勢、最近錯題、錯因分布）、知識點掌握度、家教的錯因摘要 | 預設只算第一次作答（R10 選項 1），數字與現在相同；重練的表現另看「重練成效」（FR-040）。 |
| 題庫覆蓋率的「還沒寫過」 | 不變。 |
| 找相似、NLQ、變式檢索的「排除他寫過的題」 | 不變。 |
| 承上題（FR-019、Owner 決策單 B7：確認出卷時伺服器端檢查整組） | 重練以**整組**為單位（第 4.4 節）；B7 的整組檢查要把重練題與新題一視同仁（見第 7.1 節風險 R-9）。 |
| 承上題湊不滿（決策單 B10：直接報錯） | 只作用在新題；重練題是附帶的，放不下的組寫進 `notes`、不報錯。 |
| 變式家族互斥 | 新題之間照舊；重練題與它的變式能否同卷依 R8。 |
| 知識點標註、化學、詳解 | 無關（重練題就是原題，標註與詳解照用）。 |

### 3.9 刪卷、刪學生、合併學生、刪題

| 動作 | 規則 |
| :--- | :--- |
| **刪卷**（`DELETE /api/papers/:id`） | 一般情形照舊：刪掉該卷的派題（作答跟著 CASCADE）與卷，題目回到候選池。**新規則**：若卷上某題的新題派題是某個排程項目的來源，而那個項目在**別張卷**已經有重練派題，回 409「這張卷有 N 題已經在錯題重練中（重練卷 #…），請先刪除那些重練卷」；項目還沒被重練過就連項目一起刪。刪的是重練卷時，受影響的項目依剩下的作答歷史重算（等於「那次重練沒發生過」）。沒有任何重練資料時，行為與現在完全相同。 |
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

### 4.3 建議：固定關卡（Leitner 式），間隔對齊上課節奏

| 關卡 | 名稱 | 上一次作答後隔多久到期 |
| :--- | :--- | :--- |
| 第 1 關 | 錯題重練 | 1 天（＝下一份卷就可以出） |
| 第 2 關 | 一週回測 | 7 天 |
| 第 3 關 | 兩週回測 | 14 天 |
| （第 4 關） | （四週回測） | （28 天；只有 R3 選「對 4 次」才用到） |

- **答對**：升一關，連對次數＋1；連對次數達到門檻 K（建議 3，R3）→ **練到會**，不再到期。
- **答錯**：回到第 1 關，連對歸零，錯的次數＋1；錯的次數達 3 次標「**卡關**」提醒老師（R4）。
- **答對的定義**：`COALESCE(score, result) ≥ 1`，也就是全對才算（R2）。未作答（`blank`）當然是錯。
- 參數放在 `config/retrain.js`（同 `config/errorTypes.js` 的做法：白名單與教學參數進版控、改一次不需要 migration），並在註解標〔Owner 決策單 <日期> R*〕。

選 B 的理由：①狀態就是「第幾關」，清單上一眼看得懂；②決定性、可從作答歷史重算，改判與刪卷不會留下錯的狀態；③不需要校準、不需要新依賴；④間隔以週為單位，與一週一到兩次課相符；⑤之後若 Owner 想換 SM-2 或 FSRS，排程是從作答歷史重算的，換演算法不會丟資料（R5）。

### 4.4 規則細節

| 情況 | 規則 |
| :--- | :--- |
| **進清單** | 新題派題批改為「錯」（依 R1、R2）→ 建立項目，`reason = 'wrong'`，第 1 關，到期日＝派題日＋1 天。旗標關閉時不自動建立（第 5.1 節）。 |
| **老師手動加入** | 只能加「曾經以新題派給他」的題（I1）；`reason = 'manual'`，從加入當天起算第 1 關。 |
| **承上題** | 組內任一題進清單，同組其他題一起進（`reason = 'group'`，起算日＝那題錯題的派題日）；挑到期題時以組為單位，組內任一題到期就整組出（組內各題各自記作答、各自升降關）；整組都練到會才不再出。已練到會的同組題被帶著出時又答錯，就重新進行中。 |
| **已派出、還沒批改** | 不算到期、不會被再出一次（I6）；清單標「已派出（卷 #…）」；超過 14 天未批改另外提醒。 |
| **改判、取消批改、刪卷** | 受影響的項目依剩下的作答歷史重算。`reason = 'wrong'` 的項目，若歷史裡已經沒有任何錯的作答（老師改判成對）：還沒重練過就刪掉項目；重練過就保留紀錄、設為 `retired`。 |
| **封存的題** | 不會被挑進卷；清單標「題目已封存」。 |
| **老師移出／判定已會／重新加入** | 寫在 `teacher_override`，重算時優先；重新加入＝清掉 override，從當天起算第 1 關。 |
| **派題日是起算點** | 到期日以「派題日」（`assigned_at`，確認出卷那天）起算，不以批改日：批改晚了，題目可能一批改就到期，這是對的（學生實際寫的時間比較接近派題日）。 |
| **「到期」的判斷日** | 出卷時可指定「預計作答日」（預設今天）：到期日 ≤ 那一天就算到期。週日備週三的課時，選週三。 |

### 4.5 例子

學生 A 的一題向量內積（建議參數：K＝3、間隔 1／7／14 天）：

| 日期 | 事件 | 關卡 | 連對 | 錯次數 | 下次到期 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 10/1 | 新題，批改：錯 | 第 1 關 | 0 | 0 | 10/2 |
| 10/5 | 重練卷，批改：對 | 第 2 關 | 1 | 0 | 10/12 |
| 10/12 | 附在新卷，批改：錯 | 第 1 關 | 0 | 1 | 10/13 |
| 10/15 | 附在新卷，批改：對 | 第 2 關 | 1 | 1 | 10/22 |
| 10/22 | 附在新卷，批改：對 | 第 3 關 | 2 | 1 | 11/5 |
| 11/5 | 附在新卷，批改：對 | 練到會 | 3 | 1 | — |

弱點面板在這段期間只看 10/1 那一次（錯）（R10 選項 1）。「重練成效」（第 5.2 節 API-13）把第 1 關的作答算成「重練」：10/5、10/15 兩次都對；第 2 關以後算成「隔週回測」：10/12 錯、10/22 對、11/5 對，三次對兩次。

### 4.6 從作答歷史重算（純函式）

`services/retrainSchedule.js`（純函式，不碰 DB、不讀 env、不看時鐘）：

```text
computeRetrainState({ reason, entered_on, teacher_override, history }, params) → state
  history：這位學生這一題的全部派題，依 (assigned_at, assignment_id) 排序；
           每筆 { assigned_at, purpose, graded, correctness（COALESCE(score, result)）}
  params ：{ stepDays: {1:1, 2:7, 3:14, 4:28}, masteryStreak: 3, stuckLapses: 3, correctThreshold: 1 }
  state  ：{ exists, status, step, due_on, streak, lapses, last_attempt_on, mastered_on, in_flight, stuck }

  狀態從「未進清單」開始；reason 為 group／manual 時，於 entered_on 進入第 1 關。
  逐筆看 history：
    沒批改 → 若是最後一筆且項目進行中：in_flight = true；跳過
    答錯  → 未進清單：進第 1 關；進行中／已會：回第 1 關、連對歸零、錯次數＋1
    答對  → 進行中：連對＋1；連對 ≥ K 則練到會，否則升到第「連對＋1」關
    到期日 = 這一筆的 assigned_at ＋ stepDays[目前關卡]
  最後套 teacher_override（retired／mastered 優先）；stuck = 錯次數 ≥ stuckLapses
```

- **I/O 層**（`services/retrainService.js`）：`recompute(client, studentId, questionIds, { createNew })` 讀歷史 → 呼叫純函式 → upsert／刪除項目，**與觸發它的寫入在同一交易**。
- **觸發點**：批改 PATCH（該卷被動到的題）、刪卷、合併學生、`retrain:rebuild`。
- **決定性測試**：隨機產生作答歷史，「每批改一次就重算」與「最後一次重算」的結果必須完全相同（第 6.3 節 TC-038-4）。
- 日期一律用 `'YYYY-MM-DD'` 字串做日數加減（同 `weaknessService` 對 DATE 的處理），不經 `Date` 的時區轉換。

### 4.7 到期、優先順序與上限

- **到期清單**：進行中、到期日 ≤ 預計作答日、沒有已派出待批改、題目沒封存。
- **排序**（到期太多、放不下時先出誰）：逾期天數多的先 → 關卡小的先（剛錯的比較急）→ 錯次數多的先 → 題號小的先。承上組以組為單位、依組內最急的一題排序。
- **上限**：附在新卷時預設最多為新題數的三成（R6），獨立重練卷最多 50 題（同 `confirm-paper` 上限）。放不下的組不拆開，跳過並寫進 `notes`；沒被挑到的題繼續留在到期清單（逾期天數會增加，下次優先）。

### 4.8 份量估算（給 R3、R6 參考）

一題錯題要「連續答對 K 次」才畢業。若每次重練答對的機率是 p，平均要重練 (1 − p^K) ÷ ((1 − p) × p^K) 次。假設一位學生**每週新錯 6 題**（例：每週 20 題新題、錯三成）：

| 畢業門檻 | 每次重練都對 | 重練有三成又錯（p = 0.7） |
| :--- | :--- | :--- |
| 對 2 次 | 每週約 12 題舊題 | 約 21 題 |
| 對 3 次（建議） | 約 18 題 | 約 38 題 |
| 對 4 次 | 約 24 題 | 約 63 題 |

意思是：**門檻越高、重練越常又錯，每週要分給舊題的位置就越多**，而版面有上限，多出來的會一直逾期。所以本設計另外提供：①「卡關」提醒（同一題錯三次，重做同一題的效益已經很低，應該換成講觀念或出變式）；②成效統計看得到「到期清單有沒有越堆越多」；③門檻與上限都在設定檔，用一陣子再調。

---

## 5. API 與畫面草案

### 5.1 功能旗標與設定

| 項目 | 內容 |
| :--- | :--- |
| 旗標 | **`FEATURE_RETRAIN`**（錯題重練與間隔複習；預設關；`config/features.js` 加 getter；前端 `<meta name="feature-retrain">`、`app.js` 注入 `__FEATURE_RETRAIN__`）。名稱避開 `review`：`/api/review` 與 `reviewController` 已是拆題的「人工複核佇列」（FR-006）。 |
| 旗標管什麼 | 新 API 是否掛載、畫面是否顯示、批改後是否**自動建立**新項目、出卷 API 是否接受重練參數。 |
| 旗標不管什麼 | M1 的拆表（核心資料層，旗標關也生效）；刪卷／刪學生／合併時的排程處理與既有項目的重算（資料完整性，一律執行）。 |
| 設定檔 | `config/retrain.js`：`STEP_DAYS`、`MASTERY_STREAK`、`STUCK_LAPSES`、`CORRECT_THRESHOLD`、`ATTACH_RATIO`（附帶上限比例）、`MAX_RETRAIN_PAPER`、`REBUILD_SINCE_DAYS`、`IN_FLIGHT_WARN_DAYS`、`ENTRY_RULE`（R1）、`SAME_FAMILY_ALLOWED`（R8）、`MARK_ON_PAPER`（R7）。 |
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
| API-9 | `GET /api/papers/:id` 每題加 `purpose`、`retrain_step` | 擴充 |
| API-10 | `PATCH /api/papers/:id/results` 回應加 `retrain` 摘要 | 擴充 |
| API-11 | `DELETE /api/papers/:id` 新增 409 情形 | 擴充 |
| API-12 | `POST /api/download-word` 加 `paper_id`（標示重練題，R7） | 擴充 |
| API-13 | `GET /api/students/:id/retrain-stats` | 新增 |
| CLI | `npm run retrain:rebuild -- [--dry-run] [--since-days N] [--student <id>] [--test]` | 新增 |

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
      "reason": "wrong", "status": "active", "step": 2, "step_label": "一週回測",
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

**API-2 `POST /api/students/:id/retrain-items`**：body `{ question_ids: [正整數, …] }`（1–50 個）。逐題加入（`reason = 'manual'`，承上組同組題以 `group` 一起加）。回 `{ added: [{ question_id, item_id }], skipped: [{ question_id, reason }] }`，`reason` 為 `not_assigned`（沒派給他過）、`already_in_schedule`、`archived`、`missing`。

**API-3 `PATCH /api/students/:id/retrain-items/:itemId`**：body `{ action: 'retire' | 'mark_mastered' | 'reactivate', note? }`（`note` ≤200 字）。回更新後的項目（形狀同 API-1 的一筆）。項目不屬於該生 404；不認得的鍵或 action 400（同裁決 S5-21 的嚴格驗證）。

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

確認走 API-7：`confirm-paper { student_id, question_ids, retrain_question_ids: question_ids }`。純重練卷的卷名為「`<姓名>-錯題重練卷(日期)`」。

**API-6 `POST /api/generate-paper` 加 `retrain: { count, as_of? }`**

- 單章與 blueprint 兩條路徑都接受；`count` 0–50，新題題數（既有的 `count`／blueprint）語意不變，重練題**另外加上**（R6：預設建議值是新題數的三成，由前端帶入）；新題＋重練合計不得超過 50 題（`confirm-paper` 的上限），超過 400。
- 新題照既有流程抽；重練題依第 4.7 節挑；兩者合併後用既有的 `sortForPaper` 排序（R7 選 2 時，重練題改集中放卷末）。
- 回應多 `retrain: { wanted, got, due_total }`，`questions[i]` 多 `purpose`、`retrain_step`（只有帶 `retrain` 時才多，沒帶時回應逐字不變）。
- `FEATURE_RETRAIN` 關閉卻帶了 `retrain` → 400 `retrain 需要開啟 FEATURE_RETRAIN。`（讓老師知道沒生效，而不是靜默忽略）。
- 非 `dry_run` 路徑直接寫入時，與 API-7 同一套寫入規則。

**API-7 `POST /api/confirm-paper` 加 `retrain_question_ids: int[]`**（必須是 `question_ids` 的子集）

- 交易內：對這些題的排程項目 `SELECT … FOR UPDATE`，逐題檢查「屬於這位學生、進行中或已會（被承上組帶著出）、沒有已派出待批改」；不符 → 409 `題目 <id> 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`
- 寫入：重練題寫 `purpose = 'retrain'`、`retrain_item_id`、`retrain_step`（當下關卡）；其餘題寫 `purpose = 'new'`，走原本的 `ON CONFLICT (student_id, question_id) WHERE purpose = 'new' DO NOTHING`＋筆數檢查（衝突 409，訊息不變）。每一筆派題同時建一筆空的作答。
- 承上組完整性：與決策單 B7 的伺服器端檢查共用，重練題與新題一視同仁。
- 沒帶 `retrain_question_ids` → 行為與回應逐字不變。回應多 `retrain_question_ids`（有帶才多）。

**API-8 `POST /api/students/:id/remedial-paper` 加 `retrain_count?`**（0–20，預設 0；`total`＋`retrain_count` 不得超過 50）：多一個 `bucket = 'retrain'` 的組，`blueprint`、`shortfalls`、`notes` 照既有格式回報；確認時前端把這組的題號放進 `retrain_question_ids`。預設 0 時回應逐字不變。

**API-9 `GET /api/papers/:id`**：`questions[]` 每題多 `purpose`（`new`／`retrain`）、`retrain_step`（新題為 null）。實作改讀 `assignment_attempts`，以 `(paper_id, question_id)` 對應。

**API-10 `PATCH /api/papers/:id/results`**：請求與既有的 400 訊息、檢查順序、全有全無都不變；改寫 `attempt_records`（經 `assignments` 以卷與題對應）。旗標開啟時回應多 `retrain: { entered, advanced, mastered, reset }`（這次批改讓幾題進清單、升關、練到會、回第一關），批改卡據此即時提示。

**API-11 `DELETE /api/papers/:id`**：見第 3.9 節；新的 409 只在有重練資料時出現。

**API-12 `POST /api/download-word` 加 `paper_id?`**：有帶時伺服器查這張卷每題的 `purpose`，依 R7 標示（建議：標準版與詳解版的答案區在題號後加「（重練）」，學生版不標）。沒帶 → 逐位元不變（`edition = 'standard'` 的段落序列與現在相同，同 ACPT-025-1 的比對方式）。

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

`first_retrain`＝第 1 關的作答，`spaced`＝第 2 關以後；`rate` 四捨五入到小數第 4 位，`graded = 0` 時 null。

**CLI `npm run retrain:rebuild`**：從作答歷史建立缺少的項目（範圍依 R11，預設 `--since-days 30`）並重算全部項目；`--dry-run` 在交易內跑完再 ROLLBACK，印出「新增、更新、刪除、各狀態題數」；可重複執行（冪等）。不呼叫 LLM。

### 5.3 畫面（老師端）

| 位置 | 內容 |
| :--- | :--- |
| **學生分頁 →「錯題重練」卡**（新 module `public/js/retrain.js`，錨點 `#retrain`，放在弱點面板旁） | 上方四個數字：到期、進行中、練到會、卡關。清單依第 4.7 節排序，每列：章節、題幹預覽（MathJax）、關卡標籤、下次到期（逾期標紅）、連對／錯次數、徽章（到期／已派出卷 #…／卡關／已封存）。展開看作答歷史。每列動作：移出、判定已會、重新加入、找相似（沿用既有事件）。上方按鈕：「出一份重練卷」（呼叫 API-5，草稿畫面沿用補救卷的樣式：可刪題、確認、下載 Word）、「手動加入題號」。另有「重練成效」小表（API-13）。 |
| **組卷頁**（`index.html` inline script 最小掛鉤，標〔retrain〕） | 旗標開啟且選了學生時，多一列「附上到期的重練題 [N] 題（目前到期 M 題）」，N 預設為新題數的三成；預覽卡上重練題標「重練・第 2 關」徽章，可「移除這題」。 |
| **補救卷**（`public/js/remedial.js`） | 配比下方多「到期重練 [N] 題」（R6），草稿多一組「到期重練」。 |
| **批改卡**（`public/js/students.js` 最小掛鉤） | 重練題標徽章「重練・第 n 關」；儲存後依 API-10 的摘要提示「3 題進入重練清單、1 題練到會」。 |
| **學生清單** | 名字旁小徽章「到期 3」（API-4）。 |
| **試卷列表** | 卷名旁「含重練 4 題」。 |

全部沿用既有慣例：`window.ExamApp` 橋接、伺服器文字一律 `textContent`、科目清單讀 `GET /api/chapter-whitelist`、`npm run check:html` 必須通過、旗標關閉時不渲染。

### 5.4 與 Word 匯出、出卷流程的整合

- **出卷流程不變形**：仍然是「草稿（不寫庫）→ 確認（同一交易寫卷、派題、作答）→ 下載 Word」。重練只是草稿裡多了一種來源、確認時多一個 `retrain_question_ids`。
- **Word**：重練題就是原題，`download-word` 照 `question_ids` 印，附圖、化學式、三種版本（標準／學生／詳解）全部照舊。唯一的差別是 R7 的標示（有帶 `paper_id` 才查）。題序：R7 選 1 時與新題一起依題型、難度排；選 2 時集中在卷末並加小標「錯題重練」。
- **卷名**：混合卷沿用現有規則；純重練卷為「`<姓名>-錯題重練卷(日期)`」；Word 檔名跟著卷名與版本（沿用 S5-47 的後綴規則）。
- **不做**：訂正卷（只收錯題、題後留白、詳解另頁）是另一個 Word 版本，不在本範圍。

### 5.5 給老師的操作說明（草稿，凍結後補完）

1. `.env` 設 `FEATURE_RETRAIN=true` 並重啟；第一次開啟後執行 `npm run retrain:rebuild -- --dry-run` 看會補進幾題，沒問題再去掉 `--dry-run` 執行一次。
2. 平常批改照舊。錯的題會自動進該生的「錯題重練」清單；批改卡儲存後會提示進了幾題。
3. 出卷時勾「附上到期的重練題」，預覽卡上有「重練」徽章的就是舊題；不想出的按「移除這題」。考前想集中整理，到學生頁按「出一份重練卷」。
4. 批改重練題：對了升一關，錯了回第一關；連對三次就「練到會」。清單上的「卡關」表示同一題錯了三次，建議改講觀念或出變式，而不是再重做同一題。
5. 覺得某題不必練（例如只是粗心），在清單上按「移出」；確定已經會了按「判定已會」。
6. 弱點面板的數字只看每題第一次作答，所以不會因為重練而變好看；重練的效果看「重練成效」小表。

### 5.6 施工順序與平行化

| PR | 內容 | 相依 | 可平行 |
| :--- | :--- | :--- | :--- |
| **PR-1 資料層拆表** | M1、兩個檢視、D 類寫入點與 C 類讀取點改寫、測試夾具共用 helper（`test/helpers/attempts.js`）、`schema.test.js` 三條斷言依決策改寫、`eval/lib/pgEngine.js` 的 TRUNCATE、遷移驗證腳本、禁止寫檢視的掃描測試 | 不依賴第 8 節；要在同一輪其他分支（B7、B10、B20…）合併之後開工，避免測試檔大量衝突 | 單獨一條，先做 |
| **PR-2 排程核心** | M2、`config/retrain.js`、`services/retrainSchedule.js`（純函式）、`services/retrainService.js`、批改／刪卷／合併掛鉤、API-1～4、API-10、API-11、CLI | PR-1；R1～R5、R9、R11 | PR-1 合併後可與 PR-3 平行 |
| **PR-3 出卷整合** | API-5～9、API-12、組卷頁與補救卷掛鉤、Word 標示 | PR-1；PR-2 的純函式介面（先凍結，實作可用假資料）；R6～R8 | 與 PR-2 平行 |
| **PR-4 畫面與成效** | `public/js/retrain.js`、批改卡徽章、學生清單徽章、API-13 | PR-2；R10 | PR-2 的 API 形狀凍結後即可用 mock 開工 |

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

---

## 6. 測試計畫與驗收

### 6.1 功能需求草案（FR-036 起）

| ID | 需求描述 | API 端點 | 旗標 | 來源 | 優先級 | 驗收 ID |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| FR-036 | 派題與作答分開記錄：`assignments`（用途 new／retrain）＋`attempt_records`；新題每生每題一次由部分唯一索引保證；舊 `attempts` 以唯讀檢視保留原語意（每生每題第一次）；既有資料無損遷移 | 無新端點；`GET /api/papers/:id` 每題多 `purpose`、`retrain_step` | 無（核心資料層） | DEC-003 例外條款、B22 | Must | ACPT-036-1～4 |
| FR-037 | 錯題重練清單：批改答錯自動建立排程項目（規則依 R1、R2）、承上組整組、老師手動加入／移出／判定已會／重新加入、舊資料補建 | API-1～4、`npm run retrain:rebuild` | `FEATURE_RETRAIN` | DEC-003 例外條款、DEC-016 | Must | ACPT-037-1～4 |
| FR-038 | 間隔複習排程：固定關卡（間隔與畢業門檻依 R3～R5）、答錯回第一關、卡關提醒、已派出不重複派、改判／刪卷後由作答歷史重算 | 無獨立端點（`services/retrainSchedule.js`、`config/retrain.js`）；API-10 回報排程變化 | `FEATURE_RETRAIN` | DEC-016 | Must | ACPT-038-1～4 |
| FR-039 | 出卷帶入重練題：新卷附帶、獨立重練卷、補救卷附帶；確認時寫成重練派題；承上組、家族規則（R8）、上限（R6）；Word 標示（R7） | API-5～8、API-11、API-12 | `FEATURE_RETRAIN`（沒帶新參數時既有行為逐字不變） | DEC-016 | Must | ACPT-039-1～5 |
| FR-040 | 重練成效與到期提醒：成效統計、學生清單到期數、批改卡與試卷明細標示；弱點與補救卷的口徑（R10） | API-13、API-4 | `FEATURE_RETRAIN` | DEC-016、DEC-015 | Should | ACPT-040-1～3 |

**NFR 影響（草案）**：

- NFR-006（資料一致性）補一句：派題與作答同一交易寫入；批改與排程重算同一交易；migration 只增不改（M1 刪除舊表是在新 migration 裡做，既有檔不動）。
- 新增 NFR-010（效能，草案）：單一學生 5,000 筆派題、題庫 5,000 題時，到期清單（API-1）與重練草稿（API-5）在本機 < 300 ms；新題候選池的 EXPLAIN 走部分唯一索引。

### 6.2 驗收草案（Given／When／Then）

| ACPT | 驗收 |
| :--- | :--- |
| ACPT-036-1 | Given 升級前已有作答紀錄，When 執行 M1，Then 每一筆舊紀錄變成一筆「新題」派題加一筆作答，編號、學生、題目、卷、派題日、對錯、部分給分、錯因、學生答案、註記全部相同；弱點面板、知識點掌握度、補救卷草稿的 `basis` 與目標、覆蓋率的「還沒寫過」與升級前逐欄相同。 |
| ACPT-036-2 | Given 某生寫過某題（新題或重練都算），When 以單章、跨章、補救卷、NLQ、找相似、變式檢索、覆蓋率挑「新題」，Then 那一題都不會出現。 |
| ACPT-036-3 | When 以「新題」身分把同一題第二次派給同一位學生（含兩個出卷請求同時搶同一題），Then 資料庫擋下，出卷回 409，整張卷不寫入。 |
| ACPT-036-4 | Given 沒有任何重練資料，Then 出卷、確認、批改、刪卷、刪學生、合併學生、刪題的回應與行為與升級前相同（既有整合與 e2e 測試的斷言不改）。 |
| ACPT-037-1 | Given 旗標開啟，When 批改把新題判錯（依 R1、R2），Then 同一次儲存就建立該題的重練項目（第 1 關、下一份卷即可出）；When 還沒重練前把它改判成對，Then 項目消失。 |
| ACPT-037-2 | When 老師移出、判定已會、重新加入，或以題號手動加入（只接受曾派給他的題），Then 清單立即反映；移出與已會的題不會到期、不會被挑進卷。 |
| ACPT-037-3 | Given 承上組內任一題進清單，Then 同組其他題一起進清單；出卷時整組出現、不會只出承上題。 |
| ACPT-037-4 | Given 旗標關閉，Then 相關 API 回 404、批改不建立任何項目；When 之後開啟並執行 `retrain:rebuild`，Then 建出的清單與「一直開著」時相同（限補建天數內的錯題）。 |
| ACPT-038-1 | Given 一題在第 s 關，When 這次作答答對，Then 升到第 s＋1 關、到期日＝這次派題日＋該關間隔；When 連續答對達畢業門檻，Then 狀態為「練到會」、不再到期（參數依 R3、R5）。 |
| ACPT-038-2 | When 重練或回測答錯，Then 回到第 1 關、錯的次數加一；錯的次數達門檻時標「卡關」（R4）。 |
| ACPT-038-3 | Given 某題已派到一張還沒批改的卷，Then 它不算到期，也不會被派到第二張卷（兩個確認同時送出時後者 409）。 |
| ACPT-038-4 | When 改判、取消批改或刪掉重練卷，Then 排程重新計算，結果與「從頭依序批改一次」完全相同。 |
| ACPT-039-1 | When 出卷時選「附上到期的重練題 N 題」或按「出一份重練卷」，Then 草稿只含到期、未派出、題目未封存的項目，依逾期天數排序，數量不超過 N；產生草稿不寫任何資料。 |
| ACPT-039-2 | When 確認出卷，Then 重練題寫成「重練」派題並記下所屬項目與當時關卡，新題照舊受硬閘門保護；同一張卷同一題至多一次。 |
| ACPT-039-3 | Then 承上組整組出；重練題與它的變式能否同卷依 R8；放不下的組不拆開，寫進說明。 |
| ACPT-039-4 | Given 沒帶任何重練參數，Then `generate-paper`、`confirm-paper`、`remedial-paper`、`download-word` 的回應與輸出逐字（Word 逐位元）不變。 |
| ACPT-039-5 | When 以 `paper_id` 下載 Word，Then 依 R7 標示重練題；學生版不標（R7 選 1 時）。 |
| ACPT-040-1 | 學生頁顯示：進過清單的題數、練到會、進行中、卡關、第一次重練答對率、隔週回測答對率、到期與逾期題數，可依科目與時間窗篩選。 |
| ACPT-040-2 | 學生清單顯示每位學生的到期題數；批改卡與試卷明細標出重練題與關卡。 |
| ACPT-040-3 | 弱點面板、知識點掌握度、補救卷的計算口徑依 R10（建議：只用每題第一次作答），重練不改變它們的數字。 |

### 6.3 測試計畫

全部不呼叫 LLM、不需要 cassette；CI 照舊 `LLM_MODE=replay`。

| TC | 層 | 檔案（草案） | 驗什麼 |
| :--- | :--- | :--- | :--- |
| TC-036-1 | 整合 | `test/integration/assignmentSplit.pg.test.js` | 在「只套到 M1 前一號、灌入舊資料（含 `paper_id` 為 NULL、有部分給分與錯因、已封存題）」的庫上套 M1：筆數、id、逐欄相同；序號接續；自我檢查在人為製造不一致時會 RAISE 並整支回滾 |
| TC-036-2 | 整合 | 同上 | 部分唯一索引擋重複新題（23505）、重練列不受限、`(paper_id, question_id)` 唯一、`question_id` RESTRICT、兩個檢視的欄位名稱與順序（`attempts` 與舊表相同＋`assignment_id`） |
| TC-036-3 | 整合 | `test/integration/assignmentSplitGolden.pg.test.js` | 以 `students.pg.test.js` 的 1,000 筆 fixture 在 M1 前後各取弱點、知識點掌握度、補救卷草稿（固定亂數）、覆蓋率的 JSON，逐欄相同 |
| TC-036-4 | 整合 | 同上 | EXPLAIN：候選池展開檢視後使用 `assignments_first_exposure_key`，沒有掃 `attempt_records` |
| TC-036-5 | 整合／e2e | 既有全部 | 夾具改用 helper 後，既有斷言一條不改全部通過（ACPT-036-4） |
| TC-036-6 | 單元 | `test/unit/noWritesToAttemptsView.test.js` | 掃描 `controllers/`、`services/`、`workers/`、`scripts/`、`queries/`，不得出現對 `attempts` 的 INSERT／UPDATE／DELETE／TRUNCATE |
| TC-037-1 | 整合 | `test/integration/retrain.pg.test.js` | 旗標關閉 404 且批改不建項目；答錯建項目、改判成對刪項目；手動加入（`not_assigned` 等 skipped 原因）；移出／判定已會／重新加入；承上組一起進 |
| TC-037-2 | 整合 | 同上 | `retrain:rebuild` 的 `--dry-run` 不寫入、正式執行冪等、`--since-days` 範圍、與「一直開著」逐筆比對相同 |
| TC-038-1 | 單元 | `test/unit/retrainSchedule.test.js` | 純函式表格驅動：進清單、升關、回第一關、畢業、卡關、部分給分門檻、未批改（in_flight）、override、group／manual 起算、改判後消失或 retired、日期加減不受時區影響 |
| TC-038-2 | 單元 | 同上 | 參數化：K＝2／3／4、間隔表不同時的結果（Owner 改設定不需改程式） |
| TC-038-3 | 整合 | `retrain.pg.test.js` | 批改 PATCH 同一交易建立／更新項目（PATCH 失敗時項目不變）；已派出不再被挑、兩個確認同時送出後者 409 |
| TC-038-4 | 單元 | `test/unit/retrainScheduleProperty.test.js` | 隨機作答歷史（固定種子，1,000 組）：逐筆重算＝最後重算 |
| TC-039-1 | 單元 | `test/unit/retrainSelect.test.js` | 到期挑選、排序、上限、承上組不拆、封存排除、家族規則（R8 兩種設定） |
| TC-039-2 | 單元 | `test/unit/retrainValidation.test.js` | API-1～8 的參數驗證（400 訊息）、`retrain_question_ids` 必須是子集、旗標關閉時帶 `retrain` 回 400 |
| TC-039-3 | 整合 | `retrain.pg.test.js` | 草稿不寫庫；混合卷確認後派題用途與關卡正確；純重練卷卷名；補救卷 `retrain` 組；刪重練卷後重算；刪原卷被擋 409；刪學生與合併學生的處理 |
| TC-039-4 | 單元＋e2e | `test/unit/solutionText.test.js`（擴充）、`test/e2e/paperWord.e2e.test.js`（新增一案） | Word：沒帶 `paper_id` 逐位元不變；帶了依 R7 標示；e2e 走「新卷 → 批改錯 → 重練卷 → 下載」 |
| TC-040-1 | 整合 | `retrain.pg.test.js` | API-13 的計數、答對率、分母為 0 時 null；API-4 的到期數 |
| TC-040-2 | 單元 | `test/unit/retrainUi.test.js` | miniDom：旗標關閉不渲染、清單排序與徽章、動作按鈕送出的 body、組卷頁附帶選項、批改卡徽章與提示、伺服器文字一律 `textContent` |

回歸：完整 `ci.sh`（unit、check:html、migrate、integration、e2e、五個 eval）。eval 的量測值不得因本功能改變（eval 不灌作答紀錄，只有 `pgEngine.js` 的 TRUNCATE 要改表名）。

### 6.4 既有測試會動到哪些（全部是「依 Owner 決策改變的行為」或「夾具寫法」，沒有放寬任何斷言）

| 檔案 | 變動 | 標註 |
| :--- | :--- | :--- |
| `test/integration/schema.test.js`「四張表都在」 | 改驗 `assignments`、`attempt_records` 是實體表、`attempts` 是檢視（斷言變多） | 〔Owner 決策單 2026-09-25 B22；DEC-003 例外條款〕 |
| `schema.test.js`「attempts 的 UNIQUE 擋得住重複指派」 | 改對 `assignments` 的新題部分唯一索引驗同一件事；另加「重練列可重複」 | 同上 |
| `schema.test.js`「attempts.question_id 是 ON DELETE RESTRICT」 | 改驗 `assignments.question_id`（以及 M2 的 `retrain_items.question_id`） | 同上 |
| 23 個整合／e2e 測試檔、約 46 處夾具寫入 | `INSERT INTO attempts …`、`DELETE FROM attempts …`、`TRUNCATE attempts, …` 改用 `test/helpers/attempts.js`（`insertAttempt`、`clearAttempts`），只動準備資料的程式，不動斷言 | 夾具改寫，於 helper 檔頭說明 |
| `test/e2e/paperWord.e2e.test.js` 的 `ON CONFLICT (student_id, question_id)` 夾具 | 改用 helper | 同上 |
| 讀取 `FROM attempts WHERE paper_id = …` 的斷言（`grading`、`students`、`controllers` 等） | **不動**：讀的是檢視，沒有重練資料時內容相同 | — |
| 單元測試中比對 SQL 字串的正規表示式（`remedialValidation.test.js:196`、`hybridQuery.test.js:62`） | **不動**：候選池 SQL 沒改 | — |

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
| R-3 | 到期清單越堆越多（第 4.8 節），舊題擠掉新題或永遠排不完 | 中 | 高 | 附帶上限、優先順序、卡關提醒、成效統計的逾期數；R3、R6 由 Owner 依份量決定，設定檔可調 |
| R-4 | 同一題重做多次，學生記住答案而不是學會 | 中 | 中 | 間隔拉開到週；弱點只看第一次作答（R10）；卡關提醒改教法；R9 保留日後改用變式的路 |
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
| SM-2 或 FSRS | 見第 4.2 節 | 第 4.2 節；R5 讓 Owner 決定 |
| 把排程單位設成「家族」 | 追蹤 `COALESCE(variant_of, id)`，回測時抽同家族沒寫過的題 | 工作量約多一倍、依賴變式品質（變式閘門通過率約 0.25）；R9 讓 Owner 決定是否下一輪再做 |

---

## 8. 需要 Owner 決定的問題

每一題都可以單獨回答。選完之後本檔凍結，參數寫進 `config/retrain.js` 並標〔Owner 決策單 <日期> R*〕。第 5.6 節：PR-1 不需要等這些答案；PR-2 需要 R1～R5、R9、R11；PR-3 需要 R6～R8；PR-4 需要 R10。

### R1　哪些錯題要自動進「錯題重練」清單（錯題重練）

**背景**：批改時按「錯」的題，之後要能再出給同一位學生重做，直到練會。系統要知道哪些題該進這份清單。錯因已經有「粗心抄錯」「時間不足」等選項可以標。清單越長，之後每份卷要分給舊題的位置就越多。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 答錯的題（含未作答、部分給分沒滿分）自動進清單；你可以手動移出或加入 | 不會漏題；粗心的題要自己按「移出」 |
| 2 | 只有你在批改卡上勾「要重練」的題才進 | 清單最精簡；每張卷多點一次，忘了勾就漏 |
| 3 | 自動進，但錯因只標了「粗心抄錯」或「時間不足」的不進 | 少一些不必要的重練；錯因沒標的照樣會進 |

**建議與理由**：選 1。家教最常發生的是「忘了追蹤錯題」，自動進清單比較不會漏；粗心的題不多，移出只要按一下。用一陣子覺得太多，再改成 3 只要改設定。

### R2　部分給分的題，算「對」還是「錯」（錯題重練）

**背景**：計算題可以給部分分（例如 60%）。「要不要進重練清單」和「這次重練算不算過關」都要用到這條線。補救卷現在把「沒拿滿分」當成答錯來算平均難度。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 只有全對才算對（沒給部分分，或給 100%） | 最嚴，和補救卷、知識點掌握度的算法一致；拿 80% 也要再練 |
| 2 | 拿到 80% 以上算對 | 小失誤不必再練；80% 這條線是人為訂的 |
| 3 | 只看「對／錯」按鈕，不看部分給分 | 最簡單；按了「對」但給 50% 的題也算對 |

**建議與理由**：選 1。「練到會」應該是整題做對；和系統其他地方的算法一致，老師不必記兩套規則；只差一點的題通常下一次就過關，負擔不大。

### R3　怎樣才算「練到會」（間隔複習）

**背景**：錯題重做一次就對，常常只是剛看過詳解還記得；隔一段時間再考還對，才比較像真的會。做法是「錯了之後先重做一次，之後隔一段時間再考」，連續對滿幾次才畢業。次數越多越可靠，但每週要分給舊題的位置越多：假設每週新錯 6 題，畢業要對 2／3／4 次時，每週大約要重練 12～21／18～38／24～63 題舊題（前面的數字是每次重練都對，後面是重練有三成又錯）。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| 1 | 對 2 次：重做對一次，隔 1 週再對一次（約 2 週畢業） | 負擔最輕；只驗證到「1 週後還記得」 |
| **2（建議）** | 對 3 次：重做、隔 1 週、再隔 2 週（約 3～4 週畢業） | 驗證到「2 週後還記得」；每週舊題約為新錯題的 3 倍 |
| 3 | 對 4 次：重做、隔 1、2、4 週（約 7～8 週畢業） | 最可靠、接近段考週期；舊題量最大，清單容易排不完 |

**建議與理由**：選 2。學習研究常見的建議是「隔開時間、成功回想滿三次」；兩週的間隔大約就是兩次考試之間會遇到的遺忘。更多次會讓舊題擠掉新題。數字寫在設定檔，用一陣子發現清單消化不完，改成 1 只要改一個數字。

### R4　重練或隔週回測時又錯了，怎麼辦（間隔複習）

**背景**：清單裡的題在重做或隔週回測時又錯了。可以讓它從頭來過，也可以只退一步。同一題一直錯，通常代表觀念沒懂，一再重做同一題幫助有限。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 回到第一關（下一份卷就再重做），錯的次數加一；錯滿 3 次標「卡關」提醒你（仍留在清單） | 最嚴；卡關的題由你決定改講觀念或出變式 |
| 2 | 只退一關（例如從「隔 2 週」退回「隔 1 週」） | 畢業比較快；可能半會半不會就畢業 |
| 3 | 回到第一關；錯滿 3 次自動移出清單，改由補救卷處理那個觀念 | 自動化；但你少看一眼，那一題之後不會再出 |

**建議與理由**：選 1。間隔複習的標準做法是錯了就從頭；「卡關」只提醒、不自動移出，換不換教法由你決定，系統不替你放棄一題。

### R5　排程要「固定好懂」，還是讓系統自己調整間隔（間隔複習）

**背景**：第一種是固定關卡：第 1 關下一份卷、第 2 關隔 1 週、第 3 關隔 2 週，錯了回第一關，你看得出每題為什麼今天到期。第二種（SM-2，Anki 早期的做法）是每題依過去表現算自己的間隔，常錯的題間隔變短。第三種（FSRS）是目前最準的演算法，但要加一個套件，參數要用大量作答資料校準。家教一週上一兩次課，「7 天」和「9 天」到期其實都是等下一次上課才出。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 固定關卡（間隔與次數依 R3） | 可預期、好解釋、容易測；不會因人因題調整 |
| 2 | SM-2：每題自己調間隔 | 常錯的題自動更常出現；間隔數字不直觀，要累積幾次作答才準 |
| 3 | FSRS | 理論上最省題數；要加套件，資料少時不準，你很難檢查它為什麼這樣排 |

**建議與理由**：選 1。紙本、一週一兩次課的節奏下，自動微調的好處幾乎都被「等下次上課」吃掉；固定關卡你看得懂也改得動。排程是從作答歷史重算的，之後要換成 2 或 3 不會丟資料。

### R6　到期的重練題怎麼出到卷上（出卷）

**背景**：到期的重練題要放進某一份卷，學生才會再寫到。可以附在平常出的新卷裡，也可以單獨出一份「錯題重練卷」，或兩種都有。附在新卷時要有上限，不然舊題會擠掉新題。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 兩種都有：出新卷（單章、跨章、補救卷）時可勾「附上到期的重練題」，預設最多為新題數的三成（出卷時可改）；另有「出一份重練卷」按鈕 | 最有彈性；出卷頁多一個選項 |
| 2 | 只出獨立的重練卷 | 畫面最單純；學生要多寫一份卷，你要記得出 |
| 3 | 每份新卷自動附上（不用勾），上限三成 | 不會忘；想出純新題卷時要記得關掉 |

**建議與理由**：選 1。平常上課順手附幾題最省事，考前集中整理時用獨立重練卷；三成只是預設值，每次出卷都能改。

### R7　卷面上要不要標出「重練題」（出卷）

**背景**：學生拿到卷子時，看不看得出哪幾題是以前錯過的？標出來，學生知道要特別注意，但可能先翻舊卷找答案，也可能緊張；不標，比較能看出他是不是真的會。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 學生的卷面不標；你的標準版答案區、詳解版與批改卡上標「重練」 | 測得比較真；你自己看得到 |
| 2 | 卷面也標：重練題集中放在卷末「錯題重練區」 | 學生知道在複習，比較像錯題本；比較難看出真實程度 |
| 3 | 哪裡都不標 | 最單純；批改時你要自己記哪幾題是重練 |

**建議與理由**：選 1。重練要驗的是「隔一段時間還會不會」，提示反而會干擾；你批改時需要知道，所以只在老師看的地方標。

### R8　重練題和它的「變式題」可以出在同一張卷嗎（出卷）

**背景**：目前一張卷裡，同一個變式家族（原題與它的變式）最多只出一題，避免同卷出兩道幾乎一樣的題。你先前沒選「只用變式重練」，理由之一就是這條規則擋住同一張卷集中練同一個觀念。重練題是舊題，它的變式對學生來說是新題。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 可以：重練題不佔家族名額，同家族的一題新變式可以一起出 | 同一觀念可以集中練；兩題很像，新變式那一題的「第一次作答」會比較容易，弱點統計略偏樂觀 |
| 2 | 不可以：維持一張卷同家族最多一題 | 規則不變；有重練題時，它的變式要等下一張卷 |

**建議與理由**：選 1。符合你之前的取捨（要能同卷集中練同一個觀念）；變式本來就是為了「換個數字再練一次」。

### R9　重練要用原題，還是改用同家族的變式（錯題重練）

**背景**：同一題重做好幾次，學生可能記得答案，而不是真的會。另一種做法：第一次重練用原題，之後的隔週回測改用同一家族、他還沒寫過的變式（沒有才用原題）。這樣排程要從「一題」改成「一個家族」來追蹤，工作量大約多一倍；目前自動生成變式的通過率還不高（約四分之一），很多題沒有現成的變式。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 這一輪一律用原題；想換題時用現有的「找相似／出變式」手動加 | 最快做完；背答案的風險靠「隔開時間」與「卡關提醒」降低 |
| 2 | 這一輪就做：隔週回測優先換成沒寫過的變式 | 比較能測到真的會；工作量約多一倍、交付延後，題庫沒有變式時仍用原題 |

**建議與理由**：選 1。你核准的例外條款就是「可以再出同一題」；先把原題重練做穩、看幾週資料，再決定要不要加上變式替換。

### R10　弱點面板與補救卷，要怎麼算重練與複習的作答（診斷與統計）

**背景**：以後同一題會有好幾次作答（第一次、重練、隔週回測）。章節錯誤率、錯因分布、知識點掌握度、補救卷挑弱點，都是從作答算出來的。同一題重做很多次，會讓「樣本數」灌水，也可能因為背答案看起來變好。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 弱點與補救卷只算每題「第一次」作答；重練另外有一張「重練成效」表（重練答對率、練到會題數、卡關題） | 現在的數字與報表完全不變；學生練會某題後，章節弱點不會立刻變好，要等新題也做對 |
| 2 | 每題只算「最近一次」作答 | 進步馬上看得到；重練對了可能只是記得答案，弱點會太早消失，補救卷可能太早不補 |
| 3 | 每次作答都算 | 最簡單；重練多次的題比重過高，掌握度失真 |

**建議與理由**：選 1。弱點要回答的是「他遇到沒看過的題會不會」，重練成效另外看才不會混在一起；而且這個選項上線後，既有的數字、報表與測試一個都不用改。

### R11　開啟這個功能時，以前的錯題要不要補進清單（上線）

**背景**：功能開啟之前已經批改過的錯題，系統可以一次補進重練清單。補太多，第一週的到期清單會很長，要好幾週才消化得完；太久以前的錯題，學生可能已經在學校學會了，也可能早就忘了題目本身。

| 選項 | 內容 | 影響 |
| :--- | :--- | :--- |
| **1（建議）** | 只補最近 30 天內的錯題；更早的你可以在清單上手動加 | 第一週份量可控 |
| 2 | 全部補進來 | 不漏；第一週清單可能上百題，要分好幾週出完 |
| 3 | 不補，從開啟那天起才開始記 | 最乾淨；以前的錯題都要你手動加 |

**建議與理由**：選 1。一個月內的錯題還在「該趁熱練」的時間裡，份量也消化得完；天數是補建指令的參數，想多補可以再跑一次。

---

## 9. 附錄

### 9.1 名詞與資料對照

| 白話 | 資料 | 說明 |
| :--- | :--- | :--- |
| 派題 | `assignments` 一列 | 一題放進一位學生的一張卷；`purpose` 為 `new`（第一次）或 `retrain`（重練、回測） |
| 作答 | `attempt_records` 一列 | 那一次派題的對錯、部分給分、錯因、學生答案、註記 |
| 第一次作答（舊 attempts） | 檢視 `attempts` | 每生每題最多一列；弱點面板、補救卷、候選池讀它 |
| 全部作答 | 檢視 `assignment_attempts` | 含重練；試卷明細、批改、重練功能讀它 |
| 錯題重練清單的一題 | `retrain_items` 一列 | 每生每題最多一列 |
| 關卡 | `retrain_items.step`、`assignments.retrain_step` | 1＝錯題重練、2＝一週回測、3＝兩週回測（、4＝四週回測） |
| 到期 | `status = 'active'` 且 `due_on ≤ 預計作答日` 且沒有已派出待批改 | — |
| 練到會 | `status = 'mastered'` | 連續答對達門檻，或老師判定 |
| 卡關 | `lapses ≥ STUCK_LAPSES` | 只提醒，不自動移出 |
| 已派出、待批改 | 項目最後一筆派題還沒批改 | 不算到期、不會再派 |

### 9.2 預計新增或修改的檔案（實作時）

| 類型 | 檔案 |
| :--- | :--- |
| migration | `<0016 之後的下一號>_assignment_attempt_split.sql`、`<再下一號>_retrain_items.sql` |
| 設定 | `config/retrain.js`、`config/features.js`（getter） |
| 服務 | `services/retrainSchedule.js`（純函式）、`services/retrainService.js`（I/O） |
| 控制器 | `controllers/retrainController.js`（新）；擴充 `examController.js`（writePaper、confirmPaper、deletePaper、generatePaper）、`paperController.js`（GET、PATCH）、`studentController.js`（兩處改讀全部派題）、`studentAdminController.js`（刪除、合併）、`remedialController.js`、`wordController.js` |
| 其他讀取 | `services/assistantService.js`（`list_students` 改讀全部派題）、`services/remedialService.js`（重練組）、`services/wordService.js`（R7 標示） |
| 路由與前端 | `routes/index.js` 檔尾區塊；`public/js/retrain.js`（新）；`public/index.html`、`public/js/students.js`、`public/js/remedial.js` 的最小掛鉤；`app.js` 注入 `__FEATURE_RETRAIN__` |
| 腳本 | `scripts/rebuild_retrain.js`（`npm run retrain:rebuild`）、遷移前後比對腳本 |
| eval | `eval/lib/pgEngine.js` 的 TRUNCATE 改表名（量測值不變） |
| 測試 | `test/helpers/attempts.js`（新）、第 6.3 節列出的新測試、第 6.4 節列出的既有測試 |
| 文件 | 本檔（凍結後補「給老師的操作說明」與「與契約不同之處」）；共用文件與 ADR 由文件整合任務處理（建議兩份 ADR：「派題與作答拆表並以相容檢視保留舊讀法」、「間隔複習採固定關卡」） |
