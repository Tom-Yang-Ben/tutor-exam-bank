-- 0010_attempt_detail_student_profile.sql — 批改細節與學生檔案（階段 5A；DEC-015、DEC-017；介面見 docs/interfaces-stage5.md 第 2 條）
--
-- 動機：批改只記 0/1，答不出「為什麼錯」；學生檔案只有姓名，無法界定應學範圍。
--
-- 設計取捨：
--   1. attempts 只「加欄」不改既有欄：result（0/1/NULL）語意不變，舊的查詢與弱點 SQL 全數相容。
--      score 是部分給分（0~1，兩位小數）；NULL 表示沒給分，由 result 決定對錯。
--   2. error_types 是 TEXT[]，合法值不寫 CHECK，由 config/errorTypes.js 的白名單在伺服器端驗證
--      （做法同 config/chapters.js：白名單會長，改一次不該需要一支 migration）。
--      「未作答」以 result=0 且 error_types 含 'blank' 表示，不另開狀態欄。
--   3. response（學生實際寫的答案或選的選項）與 teacher_note 各限 500 字，避免把整份作答塞進 DB。
--   4. students 的檔案欄位全部可為 NULL：既有學生不必回填也能照常出卷。
--      target_exams 是陣列（同一位學生常同時準備學測與分科）；合法值由 controller 驗證。

ALTER TABLE attempts
    ADD COLUMN IF NOT EXISTS score NUMERIC(3,2)
        CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    ADD COLUMN IF NOT EXISTS error_types TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS response TEXT
        CHECK (response IS NULL OR char_length(response) <= 500),
    ADD COLUMN IF NOT EXISTS teacher_note TEXT
        CHECK (teacher_note IS NULL OR char_length(teacher_note) <= 500);

-- 錯因聚合（弱點面板 by_error_type）只看有標錯因的列
CREATE INDEX IF NOT EXISTS idx_attempts_error_types
    ON attempts USING GIN (error_types) WHERE cardinality(error_types) > 0;

ALTER TABLE students
    ADD COLUMN IF NOT EXISTS grade SMALLINT
        CHECK (grade IS NULL OR grade IN (10, 11, 12)),
    ADD COLUMN IF NOT EXISTS track TEXT
        CHECK (track IS NULL OR char_length(track) <= 20),
    ADD COLUMN IF NOT EXISTS target_exams TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS school TEXT
        CHECK (school IS NULL OR char_length(school) <= 50),
    ADD COLUMN IF NOT EXISTS textbook_version TEXT
        CHECK (textbook_version IS NULL OR char_length(textbook_version) <= 20);
