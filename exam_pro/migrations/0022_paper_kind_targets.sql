-- 0022_paper_kind_targets.sql — 試卷的種類與補救卷的目標快照（〔dec/r16-remedial〕補救成效追蹤；docs/remedial.md 第 10 節）
--
-- Owner 2026-10-03：補救卷出了之後，要看得到「補完有沒有變好」。要比較就得記住出卷當下補的是哪些單位、
-- 當時錯得多嚴重——弱點面板的數字會隨新的批改一直變，事後重算不出「補救前」。
--
-- exam_papers 加兩欄：
--   kind          'normal'（一般組卷，既有的卷全部是它）｜'remedial'（補救卷：confirm-paper 帶 kind = 'remedial'）｜
--                 'retrain'（純錯題重練卷：confirm-paper 的每一題都是 retrain_question_ids）
--   targets       補救卷的目標快照（JSONB 陣列；其餘種類為 NULL）。每個元素：
--                   { unit_type: 'chapter'|'kc', subject, chapter, kc_id?（kc 才有）,
--                     bucket: 'remedial'|'prerequisite'|'extension',
--                     baseline: { graded, wrong, wrong_rate, low_sample },
--                     error_focus?: { type, count, share, applied } }
--                 形狀由 confirm-paper 嚴格驗證（utils/remedialTargets.js），這裡只擋「不是陣列」。
-- 快照的時間就是既有的 created_at（確認出卷的時間）；草稿產生的時間不另存（草稿不寫庫，確認前可能重產很多次）。
--
-- 規則：
--   - 既有的卷一律是 'normal'（ADD COLUMN … NOT NULL DEFAULT 'normal'）；不回頭猜哪些舊卷是補救卷——
--     舊卷沒有目標快照，猜出來也比不了「補救前」。
--   - targets 只有 'remedial' 能有（exam_papers_targets_kind_check）；'remedial' 也可以沒有（直接呼叫 API 自行拼的卷）。
--   - 寫入端：controllers/examController.js 的 writePaper 只有 kind ≠ 'normal' 時才在 INSERT 帶這幾欄，
--     一般組卷的 INSERT 與本檔之前逐字相同。
--
-- 可重複套用：ADD COLUMN IF NOT EXISTS；約束 DROP IF EXISTS 再 ADD（約束名固定），已經套過的庫再套一次得到同樣的約束、資料不動。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE exam_papers ADD COLUMN IF NOT EXISTS targets JSONB;

ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS exam_papers_kind_check;
ALTER TABLE exam_papers
    ADD CONSTRAINT exam_papers_kind_check CHECK (kind IN ('normal', 'remedial', 'retrain'));

ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS exam_papers_targets_kind_check;
ALTER TABLE exam_papers
    ADD CONSTRAINT exam_papers_targets_kind_check CHECK (
        targets IS NULL OR (kind = 'remedial' AND jsonb_typeof(targets) = 'array'));

-- 補救成效：某生的補救卷由新到舊
CREATE INDEX IF NOT EXISTS idx_exam_papers_student_kind ON exam_papers (student_id, kind, created_at DESC);

COMMENT ON COLUMN exam_papers.kind IS '試卷種類：normal 一般組卷、remedial 補救卷、retrain 純錯題重練卷（0022）';
COMMENT ON COLUMN exam_papers.targets IS '補救卷的目標快照（出卷當下的單位、桶、批改／答錯基準、錯因主因）；補救成效用（0022）';
