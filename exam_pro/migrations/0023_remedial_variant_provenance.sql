-- 0023_remedial_variant_provenance.sql — 補救卷補題的變式來源（〔dec/r16-remedial〕題庫不夠時自動補題；docs/remedial.md 第 11 節）
--
-- Owner 2026-10-03：補救卷草稿某個補救單位庫存不足時，老師可以按「生成變式補題」，系統拿該生在那個單位答錯的題當藍本，
-- 走既有的變式 job（services/variantService.js）出變式。要記住「這題是為誰、為哪一題錯題出的」：
--   - 複核佇列看得到「為 學生#3 的錯題 #41 生成」（畫面在本機顯示姓名；姓名不進 LLM、不寫 log）；
--   - 核准入庫之後題目本身也帶著這兩個來源（補救成效、日後的報表才查得到）。
--
-- 做了什麼（只新增欄位與索引，不動資料）：
--   jobs.target_student_id               補題 job 是替哪一位學生出的（NULL＝一般的變式或拆題 job）。
--                                         藍本（那一題錯題）就是既有的 jobs.source_question_id，不另存。
--   questions.target_student_id           由補題 job 入庫的題：替哪一位學生出的（NULL＝其他來源）
--   questions.target_source_question_id   由補題 job 入庫的題：拿哪一題錯題當藍本（variant_of 是家族根，不一定是這一題）
--   三個外鍵都是 ON DELETE SET NULL：刪學生、刪題不該被「來源註記」擋下，來源只是註記。
--   合併學生（studentAdminController.mergeStudent）會把來源學生的註記一起搬到目標學生。
--
-- 與 0022 分開的理由：0022 動的是 exam_papers（補救成效），這一支動的是 jobs 與 questions（補題來源），
-- 兩件功能可以各自套用、各自驗；0022 已經有它自己的測試與文件，合在一支 migration 裡反而說不清楚哪一欄屬於誰。
--
-- 寫入端只在補題 job 才帶這些欄位：一般的變式、拆題 job 建立與入庫的 SQL 與本檔之前逐字相同。
-- 可重複套用：ADD COLUMN IF NOT EXISTS、CREATE INDEX IF NOT EXISTS。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_student_id INT REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS target_student_id INT REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS target_source_question_id INT REFERENCES questions(id) ON DELETE SET NULL;

-- 補題 job 依學生找（畫面列出「這位學生的補題進度」）
CREATE INDEX IF NOT EXISTS idx_jobs_target_student ON jobs (target_student_id) WHERE target_student_id IS NOT NULL;
-- 為某生出的題；刪學生時 SET NULL 也靠它（不必掃全表）
CREATE INDEX IF NOT EXISTS idx_questions_target_student ON questions (target_student_id) WHERE target_student_id IS NOT NULL;
-- 刪題時 target_source_question_id 的 SET NULL 靠它
CREATE INDEX IF NOT EXISTS idx_questions_target_source ON questions (target_source_question_id) WHERE target_source_question_id IS NOT NULL;

COMMENT ON COLUMN jobs.target_student_id IS '補救卷補題：這個變式 job 是替哪一位學生出的（藍本＝source_question_id，該生的錯題；0023）';
COMMENT ON COLUMN questions.target_student_id IS '由補救卷補題 job 入庫：替哪一位學生出的（0023）';
COMMENT ON COLUMN questions.target_source_question_id IS '由補救卷補題 job 入庫：拿哪一題錯題當藍本（0023）';
