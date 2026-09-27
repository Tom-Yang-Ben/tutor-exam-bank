-- 0020_output_truncated_review.sql — 本機模型回應被截斷的複核原因（〔Owner 第五輪 C-f＝2 核准〕docs/local-mode.md 10.17）
--
-- Owner 2026-09-27 第五輪決定 C-f 選 2：本機模式（Ollama）被截斷的回應（done_reason=length，寫到輸出上限）
-- 不重試、直接進人工複核；溫度 0 重跑多半又寫到上限，白等 3 次。Gemini 模式照舊重試 3 次。
-- 原因與「模型輸出格式錯誤」（schema_invalid）分開：複核頁與 report:jobs 才看得出是「寫到上限」（驗算上限 3072，C-c）
-- 而不是模型亂寫。
--
-- job_questions.review_reason 的 CHECK 多一個值 'output_truncated'。
-- 依 0009／0015／0019 的規則：以「完整值域」重建約束（0019 之後的十一個值＋本檔的一個），不能只加一個值。
-- 可重複套用：DROP CONSTRAINT IF EXISTS 再 ADD，已經套過的庫再套一次得到同一個約束、資料不動。
-- job_events.error_class 不變：被截斷的呼叫照實記 'schema_invalid'（JSON 不完整），截斷另記在 detail.finish_reason。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE job_questions DROP CONSTRAINT IF EXISTS job_questions_review_reason_check;
ALTER TABLE job_questions
    ADD CONSTRAINT job_questions_review_reason_check
    CHECK (review_reason IN ('chapter_invalid','formula_unparsable','answer_mismatch',
                             'duplicate','budget_exceeded','provider_error',
                             'schema_invalid','awaiting_approval','transcription_mismatch',
                             'extract_disagree','ocr_only','output_truncated'));
