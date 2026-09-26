-- 0019_ocr_only_review.sql — 只用 OCR 拆題的複核原因（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
--
-- Owner 2026-09-26 決定這台電腦的拆題改成 OCR 為主（LOCAL_EXTRACT_MODE=ocr）：只跑 PaddleOCR 與文字模型整理，
-- 不呼叫視覺模型。沒有第二版可以交叉比對，所以每一題走完後續節點後都停在 needs_review('ocr_only')，不自動入庫；
-- 原因與「兩版不一致」（0015 的 extract_disagree）分開，複核頁的說明才不會混在一起。
--
-- job_questions.review_reason 的 CHECK 多一個值 'ocr_only'。
-- 依 0009／0015 的規則：以「完整值域」重建約束（0015 之後的十個值＋本檔的一個），不能只加一個值。
-- 可重複套用：DROP CONSTRAINT IF EXISTS 再 ADD，已經套過的庫再套一次得到同一個約束、資料不動。
-- job_events.error_class 不變：政策停等寫的是 outcome='skipped'、error_class=NULL（與 extract_disagree 相同）。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_review_reason_check;
ALTER TABLE job_questions
    ADD CONSTRAINT job_questions_review_reason_check
    CHECK (review_reason IN ('chapter_invalid','formula_unparsable','answer_mismatch',
                             'duplicate','budget_exceeded','provider_error',
                             'schema_invalid','awaiting_approval','transcription_mismatch',
                             'extract_disagree','ocr_only'));
