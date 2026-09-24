-- 0013_teacher_edit_markers.sql — 「老師動過」的兩個標記（階段 5 最終審查修正；裁決 S5-41、S5-43）
--
-- 自動流程（回填腳本、種子檔載入）原本只看「現在的值」決定能不能寫，分不出「本來就沒有」與
-- 「老師刻意改成這樣」。這支 migration 加兩個時間戳記住老師的決定，自動流程看到就不動。
--
-- 1. questions.solution_cleared_at：老師在編輯視窗把**既有的**詳解清空的時間。
--    scripts/backfill_solutions.js 看到非 NULL 就略過這題（否則下次回填會把老師刪掉的驗算摘要原樣寫回）。
--    老師之後又寫了新詳解時清回 NULL（有詳解就不需要這個標記）。
--    改題幹／答案時系統自動清掉的 verify 詳解**不**設這個標記：回填本來就會以「入庫後被改過」略過它。
-- 2. knowledge_components.edited_at：老師在「知識點」分頁（PATCH /api/kc/:id）改過名稱、說明、
--    口語版或課綱代碼的時間（只改 status 不算）。npm run kc:load 對 edited_at 非 NULL 的草稿與
--    已審定的列一樣不覆寫，要 --force 才蓋；--force 覆寫後清回 NULL（內容又回到種子檔版本）。
--
-- 兩欄都可為 NULL、沒有預設值：既有資料一律視為「老師沒動過」，行為與加欄前相同。

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS solution_cleared_at TIMESTAMPTZ;

ALTER TABLE knowledge_components
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
