-- 0012_knowledge_components.sql — 知識點、題目—知識點關聯、先備關係（階段 5B；DEC-015）
--
-- 設計取捨：
--   1. 知識點是比章節更細的診斷單位（每章 3–8 個）。內容由 AI 依 108 課綱草擬、Owner 逐章審定：
--      status = draft（AI 草稿）／approved（Owner 已審定）。審定過的列，載入腳本不得覆寫內容。
--   2. spoken_text 是「口語版」：老師上課講給學生聽、方便理解的說法（Owner 2026-09-24 追加）。
--      AI 家教與詳解版會優先沿用這段說法，讓 AI 的講法與上課講法一致。
--   3. code 是穩定識別碼（格式 MATH|PHYS|CHEM.<章名>.<兩位序號>），種子檔、先備關係、
--      AI 標註都以 code 對照，不以自增 id 對照（id 會因載入順序而不同）。
--   4. question_kcs 一題可掛多個知識點（weight 表示比重）；src 記來源 ai／human，
--      人工標註的列自動流程一律不覆寫。
--   5. kc_prerequisites 允許跨科（例：物理「簡諧運動」的先備可以是數學「三角函數的定義」下的知識點）。
--      環狀相依由載入腳本與 API 在應用層擋（遞迴 CHECK 無法用約束表達）。

CREATE TABLE IF NOT EXISTS knowledge_components (
    id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE CHECK (char_length(code) <= 80),
    subject         TEXT NOT NULL CHECK (subject IN ('數學', '物理', '化學')),
    chapter         TEXT NOT NULL,
    name            TEXT NOT NULL CHECK (char_length(name) <= 60),
    curriculum_code TEXT CHECK (curriculum_code IS NULL OR char_length(curriculum_code) <= 40),
    description     TEXT CHECK (description IS NULL OR char_length(description) <= 400),
    spoken_text     TEXT CHECK (spoken_text IS NULL OR char_length(spoken_text) <= 600),
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
    sort            SMALLINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject, chapter, name)
);
CREATE INDEX IF NOT EXISTS idx_kc_subject_chapter ON knowledge_components (subject, chapter, sort);

CREATE TABLE IF NOT EXISTS question_kcs (
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    kc_id       INT NOT NULL REFERENCES knowledge_components(id) ON DELETE CASCADE,
    weight      REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 1),
    src         TEXT NOT NULL DEFAULT 'ai' CHECK (src IN ('ai', 'human')),
    confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (question_id, kc_id)
);
CREATE INDEX IF NOT EXISTS idx_question_kcs_kc ON question_kcs (kc_id);

CREATE TABLE IF NOT EXISTS kc_prerequisites (
    kc_id        INT NOT NULL REFERENCES knowledge_components(id) ON DELETE CASCADE,
    prereq_kc_id INT NOT NULL REFERENCES knowledge_components(id) ON DELETE CASCADE,
    strength     REAL NOT NULL DEFAULT 1 CHECK (strength > 0 AND strength <= 1),
    src          TEXT NOT NULL DEFAULT 'ai' CHECK (src IN ('ai', 'human', 'curriculum')),
    PRIMARY KEY (kc_id, prereq_kc_id),
    CHECK (kc_id <> prereq_kc_id)
);
CREATE INDEX IF NOT EXISTS idx_kc_prereq_prereq ON kc_prerequisites (prereq_kc_id);
