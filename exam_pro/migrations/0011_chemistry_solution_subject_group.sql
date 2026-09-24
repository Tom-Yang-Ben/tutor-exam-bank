-- 0011_chemistry_solution_subject_group.sql — 化學入庫、文字詳解、上傳科別（階段 5A/5B；DEC-017、DEC-019）
--
-- 1. questions.subject 的 CHECK 加入「化學」。0001 以欄位內 CHECK 建立，約束名為 questions_subject_check，
--    因此 DROP 再 ADD（完整值域重建）。章節白名單仍由 config/chapters.js 在後端驗證。
-- 2. questions.solution_text：文字版逐步詳解。來源三種：verify（管線驗答時獨立解出的 steps_summary）、
--    teacher（老師手寫或修改）、ai（之後由 AI 另外生成）。兩欄同為 NULL 或同為非 NULL。
--    舊欄 solution_img 保留不動（原型時代的詳解圖，前端未使用）。
-- 3. jobs.subject_group：上傳考卷時由老師指定這份卷是「數學／物理」還是「化學」。
--    數學／物理沿用凍結的 prompt 與 schema（既有 cassette 不失效）；化學走新的 prompt 與 schema。
--    預設 math_physics，既有 job 與既有上傳流程行為不變。

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_subject_check;
ALTER TABLE questions
    ADD CONSTRAINT questions_subject_check CHECK (subject IN ('數學', '物理', '化學'));

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS solution_text TEXT
        CHECK (solution_text IS NULL OR char_length(solution_text) <= 4000),
    ADD COLUMN IF NOT EXISTS solution_src TEXT
        CHECK (solution_src IS NULL OR solution_src IN ('verify', 'teacher', 'ai'));

ALTER TABLE questions
    ADD CONSTRAINT questions_solution_pair_check
        CHECK ((solution_text IS NULL) = (solution_src IS NULL));

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS subject_group TEXT NOT NULL DEFAULT 'math_physics'
        CHECK (subject_group IN ('math_physics', 'chemistry'));
