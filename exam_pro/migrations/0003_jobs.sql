-- 0003_jobs.sql — 階段 2 Agent 管線的三張表（jobs / job_questions / job_events）
--                 與 questions.text_hash（L0 去重用，先非唯一）
--
-- 對照規劃 §3.3.2 的差異（都在 docs/interfaces-stage2.md 第 1 條有裁決紀錄）：
--   1. 併入規劃 §4.3.1 的 jobs.kind（'pdf'|'variant'）與 source_question_id，
--      不再另開一支 migration；因此 pdf_sha256 可為 NULL（kind='variant' 時），
--      由 jobs_kind_payload 這條 CHECK 保證「pdf 一定有 sha、variant 一定有來源題」。
--   2. pdf_path 可為 NULL：規劃寫 NOT NULL，但同一段又要求「拆題完成後可刪檔並清空 pdf_path」，
--      兩者矛盾；kind='variant' 也根本沒有 PDF。以可為 NULL 為準。
--   3. id 一律用 GENERATED ALWAYS AS IDENTITY（與 0001_init.sql 一致），不用 BIGSERIAL。
--   4. state / review_reason / error_class 三組字串用 CHECK 寫死：這三組是四條 workstream
--      的共同語彙（狀態機、API、報表、eval 都要對），寫在 CHECK 才有單一真相。
--      job_events.node 刻意「不」加 CHECK——之後多一個節點不該需要一支 migration。
--   5. MySQL 版不做：階段 1 已切到 PostgreSQL（interfaces.md 裁決 27），規劃 §3.3.2
--      的「兩份 migration」前提已消失。
--
-- text_hash 先建「非唯一」索引：手動錄入與 seed 的舊題從未做過去重，回填必然有碰撞。
-- scripts/backfill_text_hash.js 會印碰撞清單，由人決定合併後，才另開 migration 改 UNIQUE。
--
-- 本檔已凍結：之後任何欄位變更走新的 migration 檔（階段 2 從 0005 起，0004 已用）。

-- ─────────────────────────── jobs ───────────────────────────
-- 一份 PDF（或階段 3 的一次變式題生成）一列。

CREATE TABLE jobs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind               TEXT NOT NULL DEFAULT 'pdf'
                       CHECK (kind IN ('pdf','variant')),
    pdf_sha256         CHAR(64),                     -- kind='pdf' 時必填；冪等的依據
    pdf_path           TEXT,                         -- data/jobs/<job_id>.pdf；拆題完成後刪檔並清成 NULL
    source_question_id INT REFERENCES questions(id), -- kind='variant' 時必填（階段 3 用）
    page_count         INT,
    state              TEXT NOT NULL DEFAULT 'queued'
                       CHECK (state IN ('queued','extracting','processing','done','failed')),
    token_in           INT NOT NULL DEFAULT 0,
    token_out          INT NOT NULL DEFAULT 0,       -- 含 thinking tokens（spike 實測 thinking 常大於 candidates）
    cost_usd           NUMERIC(10,6) NOT NULL DEFAULT 0,
    budget_usd         NUMERIC(10,6) NOT NULL,       -- 建立時從 JOB_COST_BUDGET_USD 複製
    error              TEXT,
    locked_until       TIMESTAMPTZ,                  -- 認領租約（JOB_LEASE_MS）
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT jobs_kind_payload CHECK (
        (kind = 'pdf'     AND pdf_sha256 IS NOT NULL) OR
        (kind = 'variant' AND source_question_id IS NOT NULL))
);

-- worker 認領：WHERE state IN (...) AND (locked_until IS NULL OR locked_until < now())
CREATE INDEX idx_jobs_state      ON jobs (state, locked_until);
-- POST /api/jobs 的冪等查詢：同 pdf_sha256 且 state <> 'failed' 的既有 job
CREATE INDEX idx_jobs_pdf_sha256 ON jobs (pdf_sha256) WHERE pdf_sha256 IS NOT NULL;

-- ──────────────────────── job_questions ────────────────────────
-- 一題一列。payload 的六個鍵（extract/dedup0/classify/lint/verify/dedup1）
-- 由各節點各自寫，欄位定義見 docs/interfaces-stage2.md 第 3 條。

CREATE TABLE job_questions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id        BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    idx           INT    NOT NULL,                   -- chunk_no * 1000 + 題序
    state         TEXT   NOT NULL DEFAULT 'extracted'
                  CHECK (state IN ('extracted','hashed','classified','linted','verified','deduped',
                                   'saved','needs_review','rejected')),
    payload       JSONB  NOT NULL DEFAULT '{}'::jsonb,
    retries       JSONB  NOT NULL DEFAULT '{}'::jsonb,   -- {classify:1, lint:0, ...}
    review_reason TEXT   CHECK (review_reason IN ('chapter_invalid','formula_unparsable','answer_mismatch',
                                                  'duplicate','budget_exceeded','provider_error',
                                                  'schema_invalid','awaiting_approval')),
    question_id   INT    REFERENCES questions(id),  -- 入庫後回填；ON DELETE 不設，題目刪不掉時走封存
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, idx)                            -- 這條同時提供 (job_id, idx) 的索引，不必再建一支
);

CREATE INDEX idx_jq_state  ON job_questions (state, locked_until);
-- GET /api/review?reason=：跨 job 的待複核佇列，只掃 needs_review 那一小撮
CREATE INDEX idx_jq_review ON job_questions (review_reason, id) WHERE state = 'needs_review';

-- ───────────────────────── job_events ─────────────────────────
-- 每次 LLM／閘門呼叫一列，只追加不更新；report:jobs 與成本稽核的唯一事實來源。
-- node 刻意不加 CHECK（多一個節點不該需要 migration）；合法值清單在 interfaces-stage2.md 第 7 條。

CREATE TABLE job_events (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id         BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    jq_id          BIGINT REFERENCES job_questions(id) ON DELETE CASCADE,  -- 整份拆題的事件為 NULL
    node           TEXT NOT NULL,
    attempt        INT  NOT NULL DEFAULT 1,
    model          TEXT,                             -- 'gemini:gemini-3.5-flash'；純程式節點為 NULL
    token_in       INT,
    token_out      INT,
    token_thinking INT,
    token_cached   INT,
    cost_usd       NUMERIC(10,6),
    cost_estimated BOOLEAN NOT NULL DEFAULT true,    -- pricing.js 查不到該模型時為 false
    latency_ms     INT NOT NULL,
    outcome        TEXT NOT NULL CHECK (outcome IN ('pass','fail','error','skipped')),
    error_class    TEXT CHECK (error_class IN ('schema_invalid','chapter_invalid','formula_unparsable',
                                               'answer_mismatch','duplicate','provider_error',
                                               'rate_limited','timeout','budget_exceeded')),
    detail         JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_events_job  ON job_events (job_id, id);
-- report:jobs --since=7d 與 DAILY_COST_BUDGET_USD 的當日累計都走這一支
CREATE INDEX idx_job_events_time ON job_events (created_at, node);

-- ──────────────────── questions.text_hash（L0 去重）────────────────────
-- = sha256(normalizeStem(question_text))，規則見 docs/interfaces-stage2.md 第 4 條。
-- 非唯一：回填必然撞到既有重複題，先報告再由人決定。

ALTER TABLE questions ADD COLUMN text_hash CHAR(64);
CREATE INDEX idx_questions_text_hash ON questions (text_hash) WHERE text_hash IS NOT NULL;
