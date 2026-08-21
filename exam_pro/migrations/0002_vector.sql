-- 0002_vector.sql — 檢索欄位與索引（embedding / 全文 / trigram）
--
-- EMBED_DIM 在 I0 釘死為 768（Gemini Embedding 的 MRL 建議值之一，且在 pgvector 的
-- vector 型別 HNSW 2000 維上限內）。改維度等同換模型：要新開一支 migration 做
-- ALTER TABLE ... TYPE vector(N) + 重建索引 + 全量重算，不改這一支。
--
-- HNSW 索引直接建在空表上：萬題內逐筆插入的維護成本可忽略，不做「回填後才建索引」。

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE questions
    ADD COLUMN concept_summary TEXT,          -- 可選，第一版預設關閉（SUMMARY 相關流程屬階段 2）
    ADD COLUMN keywords        TEXT[],        -- 可選，3~8 個關鍵詞
    ADD COLUMN embed_text      TEXT,          -- 實際送去 embedding 的文本，可重現
    ADD COLUMN embed_hash      CHAR(64),      -- sha256(embed_text)；內容變了就重算
    ADD COLUMN embedding       vector(768),   -- = EMBED_DIM
    ADD COLUMN embedding_model TEXT,          -- 產生該向量的模型 ID
    ADD COLUMN embedded_at     TIMESTAMPTZ,
    ADD COLUMN search_tsv      TSVECTOR;      -- 由應用層 jieba 分詞後 to_tsvector('simple', ...)

CREATE INDEX idx_questions_embedding ON questions
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_questions_tsv       ON questions USING gin (search_tsv);
CREATE INDEX idx_questions_text_trgm ON questions USING gin (question_text gin_trgm_ops);
