-- 0006_source_type.sql — 題目來源標記（著作權管理；2026-08-28 使用者核准）
--
-- 動機：試題的著作權狀態依來源而異——官方歷屆試題（著作權法第 9 條）與自寫題乾淨、
-- 出版社題本有權利疑慮。source_type 讓組卷能過濾「只用乾淨題源」、題庫列表一目了然。
--
-- 五個值（config/chapters.js 的 SOURCE_TYPES 是程式側唯一真相，兩邊必須一致）：
--   official  官方歷屆試題（學測／分科／會考／統測——無著作權）
--   school    學校考卷（段考／期中期末；依智財局函釋傾向不受保護，使用者查證中）
--   publisher 出版社／參考書／補習班題本（有著作權，組卷可過濾排除）
--   self      自行編寫（含確認改寫充分的變式）
--   unknown   未標記（既有資料的預設；變式題預設繼承藍本的標記）
--
-- jobs.source_type：上傳考卷時標一次，該 job 入庫的所有題沿用；變式 job 建立時
-- 複製藍本題的標記。可為 NULL（舊 job、未標記），入庫時以 'unknown' 落地。

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown'
        CHECK (source_type IN ('official', 'school', 'publisher', 'self', 'unknown'));

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS source_type TEXT
        CHECK (source_type IN ('official', 'school', 'publisher', 'self', 'unknown'));
