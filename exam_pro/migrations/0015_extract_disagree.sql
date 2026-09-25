-- 0015_extract_disagree.sql — 本機拆題交叉驗證不一致的複核原因（docs/local-mode.md 第 4 條第 4 點，〔本機模式 L2〕）
--
-- 本機模式（MODEL_EXTRACT=ollama:…）的拆題由 PaddleOCR 與視覺模型各拆一次再交叉比對；
-- 兩版不一致、或只有一版拆到的題，走完後續節點後停在 needs_review('extract_disagree')，不自動入庫。
--
-- job_questions.review_reason 的 CHECK 多一個值 'extract_disagree'。
-- 依 0009 的規則：以「完整值域」重建約束（0009 之後的九個值＋本檔的一個），不能只加一個值。
-- job_events.error_class 不變：政策停等寫的是 outcome='skipped'、error_class=NULL（與 awaiting_approval 相同）。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_review_reason_check;
ALTER TABLE job_questions
    ADD CONSTRAINT job_questions_review_reason_check
    CHECK (review_reason IN ('chapter_invalid','formula_unparsable','answer_mismatch',
                             'duplicate','budget_exceeded','provider_error',
                             'schema_invalid','awaiting_approval','transcription_mismatch',
                             'extract_disagree'));
