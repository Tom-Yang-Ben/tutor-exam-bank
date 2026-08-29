-- 0007_source_detail.sql — 題目來源註記（2026-08-29 使用者核准）
--
-- 動機：source_type（0006）只到粗分類；使用者的題目多來自學校考卷，需要記下
-- 「哪間學校、哪一年」才有管理價值。採單一自由文字欄（例：「北一女 2024 段考」），
-- 官方年度、出版社書名同樣適用；不拆學校／年份兩欄——年份精確篩選目前沒有需求，
-- 找的時候用題庫管理的關鍵字搜尋即可。
--
-- 寫入規則（程式側 normalizeSourceDetail 是唯一真相）：trim 後空字串落 NULL，
-- 上限 100 字。questions.source_detail 人工補標；jobs.source_detail 於上傳考卷時
-- 標一次，該 job 入庫的所有題沿用（與 source_type 同路徑）。
-- 變式題**不**繼承藍本的註記：改寫後的題已不是那份考卷的原題，年份／校名照抄會誤導。

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS source_detail TEXT
        CHECK (source_detail IS NULL OR char_length(source_detail) <= 100);

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS source_detail TEXT
        CHECK (source_detail IS NULL OR char_length(source_detail) <= 100);
