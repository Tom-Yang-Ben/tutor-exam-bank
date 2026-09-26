-- 0017_retrain_items.sql — 錯題重練的排程項目（錯題重練第二階段 PR-2；docs/retrain-and-review.md 第 3.4 節的 M2）
--
-- 需求來源：DEC-003 例外條款、DEC-016（2026-09-25 已核准）；Owner 2026-09-26「重練與收尾決策單」第三輪：
--   〔R1 選 2〕老師在批改卡勾「要重練」才進清單 ⇒ reason 只有 flagged／group／manual
--   〔R9 選 1〕這一輪一律用原題 ⇒ 追蹤單位是「題」：每生每題最多一個項目
--   〔R11 選 3〕不補建 ⇒ 本檔只建表與欄位，不搬、不建任何資料
--
-- 做了什麼：
--   1. retrain_items（排程項目）：一位學生的一題進了「錯題重練」清單之後的排程狀態。
--      status／step／due_on／streak／lapses／last_attempt_on／mastered_on 是快取，只由 services/retrainService.js
--      從作答歷史呼叫純函式 services/retrainSchedule.js 重算後寫入（不變量 I7）；teacher_override／override_on
--      是老師的手動決定（移出、判定已會），重算時優先。
--   2. assignments 加 retrain_item_id（重練派題屬於哪個項目）、retrain_step（派題當下在第幾關）與兩個約束：
--        assignments_retrain_link_check  新題派題兩欄都是 NULL；重練派題兩欄都必填
--        assignments_retrain_item_fk     重練派題 → 同生同題的排程項目
--      加上 retrain_items_source_fk（項目 → 同生同題的「新題」派題），不變量 I1「每一筆重練派題，同生同題一定有
--      一筆新題派題」從此由資料庫保證（第 3.5 節），0016 的檢視 attempts 因此永遠等於「曾經派過」。
--   3. 檢視 assignment_attempts 在最後追加 retrain_item_id、retrain_step 兩欄（CREATE OR REPLACE VIEW 只能往後加欄）。
--
-- 兩個複合外鍵是 DEFERRABLE INITIALLY IMMEDIATE、NO ACTION：平常與 RESTRICT 一樣逐句檢查；
-- 合併學生要同時改兩張表的 student_id 時，交易內 SET CONSTRAINTS … DEFERRED，到 COMMIT 才檢查
-- （controllers/studentAdminController.js 的 mergeStudent；同 0008 承上題外鍵採 NO ACTION 的理由）。
--
-- 與設計稿第 3.4 節的差異（三處，都只多不少）：
--   a. retrain_items 多一欄 entered_after_assignment_id（見欄位註解；解決第 4.4 節「同一天先批改再重新加入」的已知邊界）。
--   b. 多一個索引 idx_retrain_items_source (source_assignment_id)：刪卷時由新題派題找項目，
--      刪派題時 retrain_items_source_fk 的參照檢查也靠它（不必掃全表）。
--   c. assignments.retrain_step 的 CHECK 以具名約束 assignments_retrain_step_check 加上（內容同設計稿），
--      與另外兩個約束一樣先判斷是否已存在，重複套用時不會多出第二個。
--
-- 冪等（照 repo 慣例）：CREATE TABLE／INDEX … IF NOT EXISTS、ADD COLUMN IF NOT EXISTS、約束用 DO 區塊判斷是否已存在、
-- CREATE OR REPLACE VIEW。已經套過的庫再套一次整支是 no-op；空庫可從 0001 一路套到本檔。
--
-- 前置檢查：第一階段（0016）沒有任何 API 會寫 purpose = 'retrain' 的派題；若庫裡已經有（例如手動寫進去的測試資料），
-- 它們沒有所屬項目、過不了 assignments_retrain_link_check，本檔直接 RAISE、整支回滾（migrate.js 一支一交易），
-- 請先刪掉那些派題再套。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

-- ── 前置檢查：還沒加上 retrain_item_id 時，庫裡不該有重練派題 ──
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'assignments'::regclass AND attname = 'retrain_item_id' AND NOT attisdropped
    ) AND EXISTS (SELECT 1 FROM assignments WHERE purpose = 'retrain') THEN
        RAISE EXCEPTION '0017 排程項目：assignments 已有 % 筆重練派題（purpose = retrain），但它們沒有所屬的排程項目；請先刪除這些派題再套用本檔',
            (SELECT count(*) FROM assignments WHERE purpose = 'retrain');
    END IF;
END $$;

-- ── 排程項目（設計稿第 3.4 節）──
CREATE TABLE IF NOT EXISTS retrain_items (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id           INT  NOT NULL REFERENCES students(id),
    question_id          INT  NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    source_assignment_id BIGINT NOT NULL,                    -- 這一題第一次（新題）派給他的那一筆
    source_purpose       TEXT NOT NULL DEFAULT 'new' CHECK (source_purpose = 'new'),
    reason               TEXT NOT NULL CHECK (reason IN ('flagged', 'group', 'manual')),
                         -- flagged＝批改卡勾「要重練」（R1 選 2）；group＝承上組的同組題一起進；manual＝在清單上手動加
    entered_on           DATE NOT NULL DEFAULT CURRENT_DATE, -- 起算日：flagged＝勾選那一筆派題的派題日；
                                                             -- group＝同那一題；manual 與重新加入＝加入當天
    entered_after_assignment_id BIGINT CHECK (entered_after_assignment_id IS NULL OR entered_after_assignment_id >= 0),
                         -- 〔與設計稿第 3.4 節的差異〕重新加入當下這位學生這一題已有的最大派題編號（沒有派題時 0）；
                         -- 建立時為 NULL。純函式把「派題日＝起算日、編號 ≤ 它」的重練派題算成前一輪，
                         -- 解決第 4.4 節「同一天先批改再重新加入」的已知邊界（services/retrainSchedule.js 規則 8）
    -- 以下是排程快取：只由 services/retrainService.js 從作答歷史重算後寫入
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
    CONSTRAINT retrain_items_student_question_key UNIQUE (student_id, question_id),      -- I3
    CONSTRAINT retrain_items_ref_key UNIQUE (id, student_id, question_id),               -- 給 assignments 的複合外鍵參照
    CONSTRAINT retrain_items_due_check CHECK ((status = 'active') = (due_on IS NOT NULL)),  -- I5
    CONSTRAINT retrain_items_override_check CHECK ((teacher_override IS NULL) = (override_on IS NULL)),
    -- 不變量 I1 的後半：項目一定指向同生同題的「新題」派題
    CONSTRAINT retrain_items_source_fk FOREIGN KEY (source_assignment_id, student_id, question_id, source_purpose)
        REFERENCES assignments (id, student_id, question_id, purpose) DEFERRABLE INITIALLY IMMEDIATE
);
-- 到期清單、出卷挑題
CREATE INDEX IF NOT EXISTS idx_retrain_items_due ON retrain_items (student_id, due_on) WHERE status = 'active';
-- 刪卷時由新題派題找項目（retrain_items_source_fk 的參照端也靠它，刪派題時不必掃全表）
CREATE INDEX IF NOT EXISTS idx_retrain_items_source ON retrain_items (source_assignment_id);

-- ── 派題表加兩欄與兩個約束 ──
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS retrain_item_id BIGINT;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS retrain_step    SMALLINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'assignments'::regclass AND conname = 'assignments_retrain_step_check') THEN
        ALTER TABLE assignments ADD CONSTRAINT assignments_retrain_step_check
            CHECK (retrain_step IS NULL OR retrain_step BETWEEN 1 AND 9);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'assignments'::regclass AND conname = 'assignments_retrain_link_check') THEN
        ALTER TABLE assignments ADD CONSTRAINT assignments_retrain_link_check CHECK (
            (purpose = 'new'     AND retrain_item_id IS NULL     AND retrain_step IS NULL) OR
            (purpose = 'retrain' AND retrain_item_id IS NOT NULL AND retrain_step IS NOT NULL));
    END IF;
    -- 不變量 I1 的前半：重練派題一定屬於同生同題的排程項目
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'assignments'::regclass AND conname = 'assignments_retrain_item_fk') THEN
        ALTER TABLE assignments ADD CONSTRAINT assignments_retrain_item_fk
            FOREIGN KEY (retrain_item_id, student_id, question_id)
            REFERENCES retrain_items (id, student_id, question_id) DEFERRABLE INITIALLY IMMEDIATE;
    END IF;
END $$;

-- 項目的作答歷史、「已派出待批改」判斷
CREATE INDEX IF NOT EXISTS idx_assignments_retrain_item ON assignments (retrain_item_id) WHERE retrain_item_id IS NOT NULL;

-- ── 檢視 assignment_attempts 在最後追加兩欄（欄位名稱與順序：0016 的十三欄＋這兩欄）──
CREATE OR REPLACE VIEW assignment_attempts AS
SELECT s.id AS assignment_id, s.student_id, s.question_id, s.paper_id, s.assigned_at, s.purpose,
       r.id AS attempt_id, r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note,
       s.retrain_item_id, s.retrain_step
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id;

COMMENT ON TABLE retrain_items IS
    '錯題重練的排程項目：每生每題最多一個。排程欄位是作答歷史重算的快取（services/retrainService.js），teacher_override 是老師的手動決定（0017）';
COMMENT ON COLUMN assignments.retrain_item_id IS '重練派題所屬的排程項目（purpose = retrain 時必填；0017）';
COMMENT ON COLUMN assignments.retrain_step IS '派題當下這一題在第幾關（1＝錯題重練，2 以後＝間隔回測；0017）';
COMMENT ON VIEW assignment_attempts IS
    '唯讀檢視：全部派題（含重練）與其作答。卷層讀取（試卷明細、批改、批改完成率）與錯題重練用這一個（0016；0017 追加 retrain_item_id、retrain_step）';
