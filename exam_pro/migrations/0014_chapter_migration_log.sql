-- 0014_chapter_migration_log.sql — 章節重整的遷移紀錄（docs/chapter-restructure.md 第 3.1 條第 7 點、ADR-016）
--
-- scripts/migrate_chapters.js（npm run chapters:migrate）的 --apply 每處理一題（搬到新章，或老師確認留在原章）
-- 就在這裡記一列，--dry-run 產生提議檔時略過已記錄的題。
--
-- 為什麼需要這張表：被拆分的舊章裡，有 9 章的新章沿用舊名（例：「排列」拆成 排列／集合與計數原理）。
-- 老師確認「這題留在排列」之後，題目的章節字串與遷移前一模一樣——只看 questions.chapter 分不出
-- 「還沒處理」與「老師確認過」，重跑 --dry-run 就會把確認過的題再提議一次（關鍵字命中的還會被提議搬走）。
-- questions.chapter_src 也分不出來：手動錄入與種子題在遷移前就是 'human'。
-- 這張表同時是稽核紀錄：哪一題在哪一天從哪一章搬到哪一章、依據是什麼（rename／keyword:<詞>／default／removed）。
--
-- plan：這一次重整的代號（scripts/migrate_chapters.js 的 PLAN_ID）。之後若再重整一次，用新代號，舊紀錄不影響。
-- 題目刪除時紀錄跟著刪（CASCADE）；題目有作答紀錄時只會被封存、不會被刪，紀錄會留著。

CREATE TABLE IF NOT EXISTS chapter_migration_log (
    question_id  INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    plan         TEXT NOT NULL CHECK (char_length(plan) BETWEEN 1 AND 40),
    subject      TEXT NOT NULL,
    from_chapter TEXT NOT NULL,
    to_chapter   TEXT NOT NULL,
    basis        TEXT CHECK (basis IS NULL OR char_length(basis) <= 80),
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (question_id, plan)
);
