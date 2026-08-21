-- 0001_init.sql — 階段 1 關聯結構（questions / students / exam_papers / attempts）
--
-- 對照舊的 MySQL schema.sql：
--   ENUM            → TEXT + CHECK（ENUM 加值要 ALTER TYPE、刪值做不到）
--   TINYINT         → SMALLINT
--   AUTO_INCREMENT  → GENERATED ALWAYS AS IDENTITY（匯入舊資料保留原 id 時用 OVERRIDING SYSTEM VALUE）
--   TIMESTAMP       → TIMESTAMPTZ
--   history_json    → 拆成 students + attempts
--   question_ids JSON → INT[]
--
-- 已套用 roadmap-plan §1.5 的三項裁決：
--   1. attempts.question_id 外鍵 ON DELETE RESTRICT（作答紀錄是弱點面板的基底，不可隨題目消失）
--   2. exam_papers.student_id NOT NULL（不保留 student_name）
--   3. §4.3.1 的階段 3 欄位（origin / variant_of / chapter_src / archived_at / graded_at）直接寫進本檔
--
-- 本檔已凍結：任何欄位變更走新的 migration 檔，不改這一支。

CREATE TABLE questions (
    id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject         TEXT NOT NULL CHECK (subject IN ('數學','物理')),
    chapter         TEXT NOT NULL,                       -- 精細章節白名單仍由 config/chapters.js 在後端驗證
    question_type   TEXT NOT NULL DEFAULT '填空'
                    CHECK (question_type IN ('單選','多選','填空','計算','證明')),
    difficulty      SMALLINT NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
    question_text   TEXT,
    question_img    TEXT,
    answer_text     TEXT NOT NULL,
    solution_img    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 以下四欄併自 §4.3.1（階段 3），提前建好省一次回填
    origin          TEXT NOT NULL DEFAULT 'pdf'
                    CHECK (origin IN ('pdf','manual','seed','variant')),
    variant_of      INT REFERENCES questions(id) ON DELETE SET NULL,  -- 永遠指向變式家族的根節點
    chapter_src     TEXT NOT NULL DEFAULT 'ai'
                    CHECK (chapter_src IN ('ai','human','knn')),
    archived_at     TIMESTAMPTZ                          -- 軟刪除；所有候選池一律加 archived_at IS NULL
);
CREATE INDEX idx_questions_subject_chapter ON questions (subject, chapter);
CREATE INDEX idx_questions_variant_of      ON questions (variant_of);
CREATE INDEX idx_questions_active          ON questions (subject, chapter) WHERE archived_at IS NULL;

CREATE TABLE students (
    id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,                           -- 只擋完全相同字串；同名不同人靠 note 與階段 3 的選人 UI
    note TEXT
);

CREATE TABLE exam_papers (
    id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title        TEXT NOT NULL,
    student_id   INT NOT NULL REFERENCES students(id),
    question_ids INT[] NOT NULL,                         -- 保留出題順序，與前端／Word 下載相容
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exam_papers_student ON exam_papers (student_id);

CREATE TABLE attempts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id  INT NOT NULL REFERENCES students(id),
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    paper_id    INT REFERENCES exam_papers(id),
    assigned_at DATE NOT NULL DEFAULT CURRENT_DATE,
    result      SMALLINT CHECK (result IN (0,1)),        -- NULL = 未批改；階段 3 才寫入
    graded_at   TIMESTAMPTZ,
    UNIQUE (student_id, question_id)                     -- 「不重複出題」的伺服器端硬閘門
);
-- (student_id) 的查詢由下面這支複合索引的前綴涵蓋，不另建單欄索引
CREATE INDEX idx_attempts_student_date ON attempts (student_id, assigned_at);
CREATE INDEX idx_attempts_question     ON attempts (question_id);

-- 兩個瀏覽用檢視表（取代已退役的 setup_index_views.js）
CREATE OR REPLACE VIEW questions_math AS
    SELECT id, subject, chapter, question_type, difficulty, question_text, answer_text, created_at
      FROM questions WHERE subject = '數學' AND archived_at IS NULL
     ORDER BY chapter, id;

CREATE OR REPLACE VIEW questions_physics AS
    SELECT id, subject, chapter, question_type, difficulty, question_text, answer_text, created_at
      FROM questions WHERE subject = '物理' AND archived_at IS NULL
     ORDER BY chapter, id;
