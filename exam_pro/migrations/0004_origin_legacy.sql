-- 0004_origin_legacy.sql — questions.origin 增加 'legacy'（interfaces.md 裁決 13）
--
-- 背景：從 MySQL 遷移的舊題目在來源上分不出是 AI 拆 PDF 還是手動新增，
-- 原本的四個值（pdf / manual / seed / variant）沒有一個誠實。
-- 遷移腳本（migrate/import_pg.js）對舊題一律寫 'legacy'；
-- 只有題幹與 seed_questions.js 完全相同的 30 題寫 'seed' + chapter_src='human'。
-- 階段 3 讀 origin 時必須認得 'legacy' = 來源未知。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_origin_check;
ALTER TABLE questions
    ADD CONSTRAINT questions_origin_check
    CHECK (origin IN ('pdf','manual','seed','variant','legacy'));
