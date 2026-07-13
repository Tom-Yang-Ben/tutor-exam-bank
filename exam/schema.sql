CREATE DATABASE IF NOT EXISTS tutor_exam_bank;
USE tutor_exam_bank;

-- 1. 題目表
CREATE TABLE IF NOT EXISTS questions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject VARCHAR(20) NOT NULL,        -- '數學' 或 '物理'
    chapter VARCHAR(50) NOT NULL,        -- 例如: '三角函數', '牛頓運動定律'
    question_type VARCHAR(20) NOT NULL,  -- '單選', '多選', '填空', '計算'
    difficulty INT NOT NULL,              -- 1 到 5 星
    question_text TEXT,                  -- 題目文字 (支援 LaTeX)
    question_img VARCHAR(255),           -- 題目圖片網址 (家教快攻法必備)
    answer_text TEXT NOT NULL,           -- 答案
    solution_img VARCHAR(255),           -- 詳解圖片網址
    -- 關鍵欄位：儲存寫過這題的學生與時間，格式為 JSON, 預設為空物件 {}
    history_json JSON NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 試卷表
CREATE TABLE IF NOT EXISTS exam_papers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,         -- 試卷名稱 (如: 小明高二段考複習卷)
    student_name VARCHAR(50) NOT NULL,   -- 學生姓名 (如: 小明)
    -- 關鍵欄位：儲存這份考卷包含哪些題目 ID，例如 [1, 5, 23, 42]
    question_ids JSON NOT NULL,          
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);