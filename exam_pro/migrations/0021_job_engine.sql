-- 0021_job_engine.sql — 上傳考卷時選的辨識方式（〔dec/r13-engine-choice〕docs/local-mode.md 10.26）
--
-- Owner 2026-10-01：AI 分析考卷可以選「純本機」或「透過 Gemini 的 API」。選擇存在 job 上，這份卷的拆題與後續逐題檢查
-- （classify、lint、verify、知識點標註）都用同一種引擎；向量（EMBED_MODEL）不跟著換。
--
-- jobs.engine：
--   NULL      照 .env（MODEL_EXTRACT 是 ollama: 就是本機、gemini: 就是 Gemini）——既有的 job 與沒帶 engine 的上傳都是這個
--   'local'   本機（Ollama＋PaddleOCR，LOCAL_EXTRACT_MODE 照 .env）
--   'gemini'  Gemini（看圖拆題的原路徑；要 GEMINI_API_KEY）
--
-- 可重複套用：ADD COLUMN IF NOT EXISTS；約束 DROP IF EXISTS 再 ADD（約束名固定 jobs_engine_check），已經套過的庫再套一次得到同一個約束、資料不動。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS engine TEXT;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_engine_check;
ALTER TABLE jobs
    ADD CONSTRAINT jobs_engine_check CHECK (engine IS NULL OR engine IN ('local', 'gemini'));
