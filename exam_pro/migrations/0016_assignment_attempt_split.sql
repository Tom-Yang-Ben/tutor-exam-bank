-- 0016_assignment_attempt_split.sql — 派題與作答拆表（錯題重練第一階段 PR-1；docs/retrain-and-review.md 第 3.2、3.3、3.6、3.7 節的 M1）
--
-- 需求來源：DEC-003 例外條款（Owner 已核准選項 a：資料層拆「派題」與「作答」；新題組卷仍排除已作答，
-- 錯題重練與間隔複習可再出同一題、每次作答各自記錄）、DEC-016。兩者 2026-09-25 已核准。
-- 本檔只做拆表，不依賴設計稿第 8 節（R1～R11）的任何決定；排程項目（retrain_items）是 M2，不在本檔。
--
-- 做了什麼：
--   1. assignments（派題）：哪一題、哪一天、在哪張卷、派給誰、purpose = 'new'（第一次）或 'retrain'（重練／回測）。
--      「新題每生每題一次」（DEC-003 硬閘門，原本是 attempts 的 UNIQUE (student_id, question_id)）
--      搬到部分唯一索引 assignments_first_exposure_key，只管 purpose = 'new'；重練列不受限，同一題可以再派。
--   2. attempt_records（作答）：一筆派題一筆作答（assignment_id UNIQUE；紙本一次派題就一次作答）。
--      對錯、部分給分、錯因、學生答案、註記、批改時間都在這裡，重練的每一次作答各自一列。
--   3. 既有 attempts 的每一列 → 一筆「新題」派題＋一筆作答，id 原樣保留（舊 attempts.id = assignments.id
--      = attempt_records.id），逐欄自我檢查通過後才刪舊表；任何一步失敗整支回滾（migrate.js 一支一交易）。
--   4. 兩個唯讀檢視：
--        attempts            ＝ 新題派題 ⟕ 作答。欄位名稱與順序同舊表（0001 的七欄＋0010 的四欄），最後多 assignment_id。
--                              每生每題最多一列，與舊表同一個語意——候選池的 NOT EXISTS、弱點面板、補救卷、
--                              覆蓋率等既有讀法一個字都不用改。
--        assignment_attempts ＝ 全部派題 ⟕ 作答（含重練）。卷層讀取（試卷明細、批改、批改完成率）用這一個。
--      兩個檢視都有 LEFT JOIN，不是可自動更新的檢視：對它們 INSERT／UPDATE／DELETE／TRUNCATE 會立刻報錯，
--      寫入一律寫 assignments 與 attempt_records（test/unit/noWritesToAttemptsView.test.js 另外掃描程式碼）。
--
-- 不變量（設計稿第 3.5 節）在本檔由資料庫保證的部分：
--   I0 新題每生每題至多一次            assignments_first_exposure_key（部分唯一索引）
--   I2 一張卷上同一題至多一次          assignments_paper_question_key
--   I4 一筆派題至多一筆作答            attempt_records.assignment_id UNIQUE
--   I1（重練派題一定有同生同題的新題派題）要等 M2 的 retrain_items 複合外鍵才由資料庫保證；
--   在那之前沒有任何 API 會寫 purpose = 'retrain'，刪卷／合併學生由程式守住（examController.deletePaper、
--   studentAdminController.mergeStudent）。assignments_ref_key 是先替 M2 的複合外鍵建好的被參照鍵。
--
-- 與設計稿第 3.2、3.7 節的差異（兩處，都不影響語意）：
--   a. 索引名稱沿用舊表的三個名字：idx_attempts_student_date（設計稿寫 idx_assignments_student_date）、
--      idx_attempts_question（idx_assignments_question）、idx_attempts_error_types（idx_attempt_records_error_types）。
--      既有的 EXPLAIN 斷言（test/integration/students.pg.test.js）與 README 以這些名字指認「時間窗索引」，
--      沿用舊名讓那些斷言一個字都不用改；舊表刪除後才建，名字不會撞。
--   b. 序號接續取「舊表最大 id」與「舊表序號已發到哪裡」兩者的較大值再加一（設計稿只取最大 id）：
--      最後幾筆被刪掉時，已發出去的 id 不會被重新使用。
--
-- 冪等（照 repo 慣例：CREATE … IF NOT EXISTS、CREATE OR REPLACE）：搬資料整段只在「attempts 還是實體表」時執行；
-- 已經拆過的庫（attempts 已是檢視）再套一次整支是 no-op，資料不動。空庫（0001 剛建好的空 attempts）照樣走完。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔（M2 = 下一號的 retrain_items）。

-- ── 派題 ──
CREATE TABLE IF NOT EXISTS assignments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id   INT  NOT NULL REFERENCES students(id),
    question_id  INT  NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,  -- 作答紀錄不隨題目消失（0001 裁決 1）
    paper_id     INT  REFERENCES exam_papers(id),                            -- 階段 1 從 MySQL 匯入的歷史紀錄為 NULL（同 0001）
    assigned_at  DATE NOT NULL DEFAULT CURRENT_DATE,
    purpose      TEXT NOT NULL DEFAULT 'new' CHECK (purpose IN ('new', 'retrain')),
    CONSTRAINT assignments_paper_question_key UNIQUE (paper_id, question_id),     -- I2：一張卷同一題至多一次
    CONSTRAINT assignments_ref_key UNIQUE (id, student_id, question_id, purpose)  -- 給 M2 的複合外鍵參照
);

-- ── 作答 ──
CREATE TABLE IF NOT EXISTS attempt_records (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assignment_id BIGINT NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,  -- I4
    result        SMALLINT CHECK (result IN (0, 1)),                    -- NULL = 未批改（同 0001）
    graded_at     TIMESTAMPTZ,
    score         NUMERIC(3,2) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),   -- 以下四欄同 0010
    error_types   TEXT[] NOT NULL DEFAULT '{}',
    response      TEXT CHECK (response IS NULL OR char_length(response) <= 500),
    teacher_note  TEXT CHECK (teacher_note IS NULL OR char_length(teacher_note) <= 500)
);

-- ── 搬資料＋自我檢查＋刪舊表（只在 attempts 還是實體表時）──
DO $$
DECLARE
    old_rel  regclass := to_regclass('attempts');
    old_seq  BIGINT;
    next_id  BIGINT;
BEGIN
    IF old_rel IS NULL OR (SELECT c.relkind FROM pg_class c WHERE c.oid = old_rel) <> 'r' THEN
        RETURN;   -- 已經拆過（attempts 是檢視）：不動任何資料
    END IF;

    -- id 原樣保留：舊 attempts.id = assignments.id = attempt_records.id
    INSERT INTO assignments (id, student_id, question_id, paper_id, assigned_at, purpose)
        OVERRIDING SYSTEM VALUE
        SELECT id, student_id, question_id, paper_id, assigned_at, 'new' FROM attempts;
    INSERT INTO attempt_records (id, assignment_id, result, graded_at, score, error_types, response, teacher_note)
        OVERRIDING SYSTEM VALUE
        SELECT id, id, result, graded_at, score, error_types, response, teacher_note FROM attempts;

    -- 序號接續（差異 b）：pg_sequence_last_value 在序號從沒發過號時回 NULL
    old_seq := pg_sequence_last_value(pg_get_serial_sequence('attempts', 'id')::regclass);
    SELECT GREATEST(COALESCE(MAX(id), 0), COALESCE(old_seq, 0)) + 1 INTO next_id FROM attempts;
    PERFORM setval(pg_get_serial_sequence('assignments', 'id'), next_id, false);
    PERFORM setval(pg_get_serial_sequence('attempt_records', 'id'), next_id, false);

    -- 自我檢查：筆數與逐欄內容不一致就 RAISE，整支 migration 回滾、資料庫維持原狀
    IF EXISTS (
        SELECT 1 FROM attempts o
          LEFT JOIN assignments s     ON s.id = o.id
          LEFT JOIN attempt_records r ON r.assignment_id = o.id
         WHERE s.id IS NULL OR r.id IS NULL
            OR s.purpose IS DISTINCT FROM 'new'
            OR (o.student_id, o.question_id, o.paper_id, o.assigned_at)
               IS DISTINCT FROM (s.student_id, s.question_id, s.paper_id, s.assigned_at)
            OR (o.result, o.graded_at, o.score, o.error_types, o.response, o.teacher_note)
               IS DISTINCT FROM (r.result, r.graded_at, r.score, r.error_types, r.response, r.teacher_note))
       OR (SELECT count(*) FROM attempts) <> (SELECT count(*) FROM assignments)
       OR (SELECT count(*) FROM attempts) <> (SELECT count(*) FROM attempt_records) THEN
        RAISE EXCEPTION '派題／作答拆表：新舊資料不一致，已回滾';
    END IF;

    DROP TABLE attempts;   -- 連同舊表的三個索引；有意料外的相依物件時這裡會失敗並整支回滾
END $$;

-- ── 索引（設計稿第 3.7 節；名稱見上方差異 a）──
-- DEC-003 硬閘門：新題每生每題一次。候選池等 A 類的 NOT EXISTS 展開檢視後直接用它。
CREATE UNIQUE INDEX IF NOT EXISTS assignments_first_exposure_key
    ON assignments (student_id, question_id) WHERE purpose = 'new';
-- 弱點面板等 B 類查詢的時間窗（student_id 前綴也涵蓋「某生的全部派題」）
CREATE INDEX IF NOT EXISTS idx_attempts_student_date ON assignments (student_id, assigned_at);
-- 刪題保護、跨學生查某題
CREATE INDEX IF NOT EXISTS idx_attempts_question ON assignments (question_id);
-- 錯因聚合（弱點面板 by_error_type）只看有標錯因的列（沿用 0010 的設計）
CREATE INDEX IF NOT EXISTS idx_attempts_error_types
    ON attempt_records USING GIN (error_types) WHERE cardinality(error_types) > 0;
-- （試卷明細與批改以（卷, 題）找派題：assignments_paper_question_key 的唯一索引已涵蓋）

-- ── 相容檢視（設計稿第 3.3 節）──
-- LEFT JOIN 而不是 JOIN：attempt_records.assignment_id 有唯一索引，查詢沒用到作答欄位時
-- （例如候選池的 NOT EXISTS）PostgreSQL 會把這個 LEFT JOIN 整個拿掉，只剩一次部分唯一索引的查找。
-- error_types 以 COALESCE 保持舊表「NOT NULL DEFAULT '{}'」的語意。
CREATE OR REPLACE VIEW attempts AS
SELECT s.id, s.student_id, s.question_id, s.paper_id, s.assigned_at,
       r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note,
       s.id AS assignment_id
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id
 WHERE s.purpose = 'new';

CREATE OR REPLACE VIEW assignment_attempts AS
SELECT s.id AS assignment_id, s.student_id, s.question_id, s.paper_id, s.assigned_at, s.purpose,
       r.id AS attempt_id, r.result, r.graded_at, r.score, COALESCE(r.error_types, '{}'::text[]) AS error_types,
       r.response, r.teacher_note
  FROM assignments s
  LEFT JOIN attempt_records r ON r.assignment_id = s.id;

COMMENT ON TABLE assignments IS
    '派題：一題放進一位學生的一張卷。purpose=new 為第一次（每生每題至多一次），retrain 為錯題重練／間隔回測（0016）';
COMMENT ON TABLE attempt_records IS
    '作答：一筆派題的對錯、部分給分、錯因、學生答案、註記與批改時間（0016；一筆派題至多一筆）';
COMMENT ON VIEW attempts IS
    '唯讀相容檢視：只含「新題」派題（每生每題第一次），欄位同 0016 之前的 attempts 表。不含重練；寫入請寫 assignments 與 attempt_records';
COMMENT ON VIEW assignment_attempts IS
    '唯讀檢視：全部派題（含重練）與其作答。卷層讀取（試卷明細、批改、批改完成率）用這一個（0016）';

-- 大量搬資料後立刻更新統計，避免在 autoanalyze 之前，弱點面板與候選池經由檢視查新表時只能用預設估計（審查意見）
ANALYZE assignments;
ANALYZE attempt_records;
