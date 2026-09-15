-- 0008_follow_up.sql — 承上題綁定（2026-09-15 使用者核准，DEC-012／FR-019）
--
-- 動機（owner 原話）：「在辨識時，有『承上題』這句話的題目，都要將上一題與有承上題的那一題綁在一起。」
-- 題庫沒有題組概念，承上題與上一題各自入庫；上一題若被去重判為重複而不入庫，
-- 承上題就成了缺前情的孤兒（2026-09-15 全庫解答健檢發現）。
--
-- 設計取捨：
--   1. 邊模型：子題記一欄 follows_question_id 指向前題，不開題組表。承上題只會指向「上一題」，
--      一條鏈就能表達題組；組卷整組抽題、刪除保護由後續 PR 以遞迴查詢沿鏈處理。
--   2. 偵測在伺服器端決定性完成（utils/followUp.js 的 regex），不改 extract prompt——
--      改 prompt 會讓 eval cassette 全數失效，而「承上題」四字本身就足以決定性判斷。
--   3. FK **不寫 ON DELETE**（NO ACTION，於語句結束時才檢查）：
--      RESTRICT 是逐列立即檢查，一句 DELETE 同時刪整組（或測試 TRUNCATE／清表）也會失敗；
--      NO ACTION 允許同一句把前題與子題一起刪掉，只擋「刪前題、留子題」。
--   4. follows_src 記綁定來源：pipeline（runner 終態後重算）、review（人工複核後重算）、
--      backfill（回填腳本）、human（人工指定；自動流程一律不覆寫）。
--      兩欄同為 NULL 或同為非 NULL，由具名 CHECK 保證。
--   5. 「缺前題」不另開欄位：isFollowUp(question_text) 且 follows_question_id 為 NULL 即時算，
--      避免多一個需要與題幹同步的衍生欄位。

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS follows_question_id INT REFERENCES questions(id);

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS follows_src TEXT
        CHECK (follows_src IN ('pipeline', 'review', 'backfill', 'human'));

ALTER TABLE questions
    ADD CONSTRAINT questions_follows_self_check
        CHECK (follows_question_id IS NULL OR follows_question_id <> id);

ALTER TABLE questions
    ADD CONSTRAINT questions_follows_src_pair_check
        CHECK ((follows_question_id IS NULL) = (follows_src IS NULL));

-- 反查「誰承接這一題」（刪除保護、整組抽題都要用）；只索引有綁定的少數列
CREATE INDEX IF NOT EXISTS idx_questions_follows
    ON questions (follows_question_id) WHERE follows_question_id IS NOT NULL;
