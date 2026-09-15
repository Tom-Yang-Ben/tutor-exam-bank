-- 0009_source_check.sql — 拆題結果對照原卷文字層（docs/source-check.md、ADR-009、DEC-013）
--
-- 新節點 source_check 插在 lint 與 verify 之間：linted → source_check → source_checked → verify。
-- 三組 CHECK 各加一個值：
--   job_questions.state         + 'source_checked'
--   job_questions.review_reason + 'transcription_mismatch'（enforce 模式判定題幹與原卷不符）
--   job_events.error_class      + 'transcription_mismatch'
--
-- 0003_jobs.sql 已凍結不可改，因此 DROP 再 ADD。約束名稱是 0003 以欄位內 CHECK 建立時
-- PostgreSQL 自動命名的結果，已在 2026-09-15 以 pg_constraint 查證：
--   job_questions_state_check、job_questions_review_reason_check、job_events_error_class_check
-- job_events.node 本來就刻意不加 CHECK（0003 第 4 點），新節點名不需要 migration。
--
-- 注意：本檔以「完整值域」重建三條 CHECK。之後若有其他 migration 也改這三條約束，
-- 必須以「本檔之後的完整值域」重建，否則會把本檔加的值洗掉（反之亦然）。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_state_check;
ALTER TABLE job_questions
    ADD CONSTRAINT job_questions_state_check
    CHECK (state IN ('extracted','hashed','classified','linted','source_checked','verified','deduped',
                     'saved','needs_review','rejected'));

ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_review_reason_check;
ALTER TABLE job_questions
    ADD CONSTRAINT job_questions_review_reason_check
    CHECK (review_reason IN ('chapter_invalid','formula_unparsable','answer_mismatch',
                             'duplicate','budget_exceeded','provider_error',
                             'schema_invalid','awaiting_approval','transcription_mismatch'));

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_error_class_check;
ALTER TABLE job_events
    ADD CONSTRAINT job_events_error_class_check
    CHECK (error_class IN ('schema_invalid','chapter_invalid','formula_unparsable',
                           'answer_mismatch','duplicate','provider_error',
                           'rate_limited','timeout','budget_exceeded','transcription_mismatch'));
