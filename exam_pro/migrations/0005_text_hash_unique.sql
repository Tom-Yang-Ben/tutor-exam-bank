-- 0005_text_hash_unique.sql — questions.text_hash 對「未封存的題」唯一（interfaces-stage2.md §11、裁決 S2-30）
--
-- 前提：scripts/backfill_text_hash.js 的碰撞清單已由開發者逐組確認（2026-08-23：#2/#3、#5/#38 為真重複，
-- 已把重複題的 attempts 併到保留題並將 #3、#38 封存 archived_at）。
-- 用部分唯一索引：封存的題不受限（它們本來就是被 dedup 淘汰的那一份），NULL 不受限（尚未回填）。
-- 之後 save／approve／createQuestion 寫入同一 text_hash 會直接撞索引——這是 dedup0 之外的最後一道硬閘門。
--
-- 本檔已凍結：之後任何變更走新的 migration 檔。

CREATE UNIQUE INDEX IF NOT EXISTS uq_questions_text_hash_active
    ON questions (text_hash)
    WHERE text_hash IS NOT NULL AND archived_at IS NULL;
