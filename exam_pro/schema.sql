CREATE DATABASE IF NOT EXISTS tutor_exam_bank DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tutor_exam_bank;

-- 1. 題目表
CREATE TABLE IF NOT EXISTS questions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject ENUM('數學', '物理') NOT NULL,                          -- 學科（限定值）
    chapter VARCHAR(50) NOT NULL,                                   -- 精細章節（白名單在後端驗證）
    question_type ENUM('單選', '多選', '填空', '計算', '證明') NOT NULL DEFAULT '填空', -- 題型
    difficulty TINYINT NOT NULL DEFAULT 3,                          -- 1 到 5 星
    question_text TEXT,                                             -- 題目文字 (支援 LaTeX)
    question_img VARCHAR(255),                                      -- 題目圖片網址
    answer_text TEXT NOT NULL,                                      -- 答案
    solution_img VARCHAR(255),                                      -- 詳解圖片網址
    history_json JSON NOT NULL,                                     -- 作答歷史，預設空物件 {}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_difficulty CHECK (difficulty BETWEEN 1 AND 5),
    INDEX idx_subject_chapter (subject, chapter)                    -- 加速組卷查詢
);

-- 2. 試卷表
CREATE TABLE IF NOT EXISTS exam_papers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,         -- 試卷名稱
    student_name VARCHAR(50) NOT NULL,   -- 學生姓名
    question_ids JSON NOT NULL,          -- 題目 ID 陣列，例如 [1, 5, 23, 42]
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_student_name (student_name)
);

-- ────────────────────────────────────────────────────────────────
-- 若資料表已存在（舊版），可手動執行以下遷移（需 MySQL 8.0.16+ 才支援 CHECK）：
--
-- ALTER TABLE questions
--   MODIFY subject ENUM('數學','物理') NOT NULL,
--   MODIFY question_type ENUM('單選','多選','填空','計算','證明') NOT NULL DEFAULT '填空',
--   MODIFY difficulty TINYINT NOT NULL DEFAULT 3,
--   ADD CONSTRAINT chk_difficulty CHECK (difficulty BETWEEN 1 AND 5),
--   ADD INDEX idx_subject_chapter (subject, chapter);
-- ALTER TABLE exam_papers ADD INDEX idx_student_name (student_name);
-- ────────────────────────────────────────────────────────────────
