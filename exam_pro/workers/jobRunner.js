// ─────────────────────────────────────────────────────────────
// workers/jobRunner.js — DB-polling worker（A-T11，擁有者：WS-A）
//
// 介面凍結於 docs/interfaces-stage2.md 第 7 條（認領／啟動／預算／事件）、
// 第 3 條（agent 合約與 ctx）、第 2 條（狀態機）。
//
// 一句話：**這支是唯一會改 job_questions.state 與寫 job_events 的地方**。
// agent 只回 outcome，狀態機只算下一格，錢與租約與事件都在這裡結算。
//
// 兩種工作單位：
//   A. `jobs` 列（state queued／extracting）→ 逐 chunk 跑 extract → 建 job_questions → processing
//   B. `job_questions` 列（六個可推進狀態）→ 跑一個節點 → transition() → 寫回
//
// 為什麼認領要「同一交易兩句」而不是 UPDATE … RETURNING：
//   規劃 §3.3.1 的原始理由是要相容 MySQL；階段 1 已切 PG（interfaces-stage1.md 裁決 27），
//   但介面第 7.1 條把這個形狀凍結了，照寫。SKIP LOCKED 讓兩個槽不會搶到同一列。
//
// 崩潰／nodemon 重啟的重跑保證＝租約過期後該列會被重新認領；extract 重跑靠
// job_questions 的 UNIQUE (job_id, idx) + ON CONFLICT DO NOTHING 保證不會重複建列。
// 〔dec/desktop-launcher-fix2〕重跑的粒度看工作單位：B 一次只跑一個節點、跑完就寫回狀態，所以從中斷的那一格重跑那一個節點。
// 〔Owner 第六輪 DA-13＝2，dec/r7-checkpoints〕A（runExtractJob）與 C（變式生成，runGenerateJob）改成逐塊／逐題的檢查點：
// 重新認領（租約到期、當機、關機、按「重試」）時，A 跳過已經拆完的塊（這份 job 的 extract 事件裡 pass／skipped 的那幾塊，
// planResumeChunks），A 從被中斷的那一塊接著拆；C 跳過 job_questions 已經有那個 idx 的題，只生成還沒建成的 idx
// （被中斷的那一題與之後的，以及中斷點之前沒過閘門、預算用盡而沒建成的題）。
// 拆完一塊時「建題目列」與「寫那一塊的 extract 事件（檢查點）」在同一個交易，所以被中斷的那一塊一列題目都不會留下，
// 重拆時不會和上一輪的半套結果混在一起；C 建好一題時的「建列＋寫 generate pass 事件」也在同一個交易（dec/r7-checkpoints-fix）。
// 檢查點不是從第 1 頁起連續的一串（正常流程到不了）時不自動重拆，job 直接 failed（planResumeChunks 的 inconsistent）。
// 原本（整份從第 1 塊／第 1 題重跑）的行為到 dec/desktop-launcher-fix2 為止。
// 被打斷的那一次呼叫沒有寫事件、也沒記用量（writeEvent／chargeJob 都在 invokeNode 回來之後）。
//
// 〔Owner 決策單 2026-09-26 第四輪 V3〕選 2「本機模式逾時只重試 1 次」：拆題模型是 ollama 時，
// 拆題一塊（runExtractChunk）的錯誤類別是 timeout 的只重試 LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES（1）次、共跑 2 次；
// 其他錯誤類別與 Gemini 模式的重試次數（DEFAULT_LIMITS.maxErrorRetries）完全不變（docs/local-mode.md 10.11 表 #4）。
//
// 〔OCR 為主 2026-09-26〕Owner 決定這台電腦的拆題改成 OCR 為主（docs/local-mode.md 10.12）：LOCAL_EXTRACT_MODE
// （loadLocalExtractModeConfig）經 ctx.config.localExtract 帶給 extract；只用 OCR 拆的題在 save 停在 needs_review('ocr_only')
// （crossCheckStopReason）；拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr、OCR_ENGINE=none 是矛盾設定，createRunner 直接丟錯。
// 〔審查 2026-09-26〕ocr 模式的資料庫還沒套 0019（review_reason 不接受 ocr_only）時，tick 不認領任何工作、印一次
// 「先 npm run migrate」（ocrOnlySchemaProblem），不會每題每輪撞 CHECK、無限重試。
//
// 〔Owner 第五輪 C-f 核准，dec/r6-local-tuning〕本機模式被截斷的回應不重試：題目節點（classify／lint／verify）回
// error 且 outcome.finishReason='MAX_TOKENS'（Ollama 的 done_reason=length），而這一次呼叫的模型是 ollama 時，
// transition 的 limits 帶 retryTruncated:false → 直接 needs_review('output_truncated')（migration 0020）。
// Gemini 模式照舊重試 maxErrorRetries（3）次。資料庫還沒套 0020 時退回原本的複核原因（schema_invalid），
// 並印一次「先 npm run migrate」——不會撞 CHECK、也不會卡住佇列（outputTruncatedAccepted）。
//
// 〔Owner 第七輪 R7-1＝4 核准，dec/r10-variant-cap〕C-f 納入變式生成（runGenerateOne）：agents/generateVariant.js 的 error
// 帶 finishReason，本機截斷（isLocalTruncation，同一個判準）時不重試、直接放棄那一題，job_events 的 generate 事件記
// finish_reason、truncated、max_output_tokens（這一次實際送出的 num_predict，appliedNumPredictOf；replay 記 null）與說明；job 繼續下一題、不 failed（一題都沒建成時照舊
// 是第 4.1 條那句）。其他 error（含 Gemini 的截斷、本機的逾時）照舊退避重試 maxErrorRetries 次（docs/local-mode.md 10.24）。
//
// 〔dec/r13-extract-fixes，Owner 2026-10-02 同意「本機的這些修改都先做了」；docs/local-mode.md 10.25〕
//   - 本機模型的 lint／verify 逾時不重試（isLocalTimeout → 狀態機規則 6b → needs_review('provider_error')），比照 C-f 與 R7-1；
//     單次逾時的本機預設是 30 分鐘（services/llm/localTuning.js 的 OLLAMA_TIMEOUT_MS_<AGENT>）。Gemini 照舊重試。
//   - 答案是空的題（本機拆題在題目頁沒寫答案時留空）不自動入庫：save 前停在 needs_review('awaiting_approval')（saveStopReason）。
//   - 解答頁：extract 事件記 answer_key／skipped_answer_key；拆完整份後 applyAnswerKey 把解析得出的答案回填到題目
//     （payload.extract.answer_src='answer_key'），runJobQuestion 寫回 payload 時保留回填。
//
// 〔dec/r8-b1-abandon，設計稿 docs/desktop-app-design.md 2.3 節第 4 點、第 3 條第 2 項〕shutdown({ abandon: true })：
// 桌面版從系統匣選「現在放棄」、或關閉的時限到了還有在途工作時用。先停止認領，再中止在途的節點（AbortController；
// OCR 的 python 會被殺掉），被放棄的工作單位**不寫 outcome、不動 retries、不寫 job_events、迴圈不重試**（被中止的那一次呼叫不記用量），
// 只放掉**自己的**租約（UPDATE … WHERE locked_until = 自己最後寫的值），下次開啟立刻被重新認領，不必等 JOB_LEASE_MS。
// 陷阱（2.3 節第 3 點）：一般的 abort 會被 classifyError 歸成 timeout、寫進事件表並累加重試次數，拆題迴圈還會立刻重試；
// 所以 invokeNode 另外記「這一次是被放棄的」，回 { abandoned: true }，三種工作單位看到就只放租約、直接結束。
// 重跑點與當機相同（上面 DA-13 那一段）：單題從被放棄的那個節點、拆題從被中斷的那一塊、變式只補還沒建成的題。
// 已經跑完的節點（結果在放棄之前就回來了）照常寫回——那是真的結果，不是被中止造成的；save 一旦開始就讓它做完
// （它開交易寫題庫，只要幾毫秒；中途放掉租約會讓重跑再入庫一次）。
// 多個後端同時連同一個庫（桌面版與網頁版 npm start 都開著）時不會放掉別人的租約：只清值等於自己認領／續租時寫的那一個，
// 而且續租曾經中斷超過一個租約長度（可能已被別人接手、又被自己的續租蓋過）就不放，留給租約到期（leaseLost）。
// 「中斷多久」同時用單調時鐘（performance.now）與系統時間（Date.now）量、取大的：〔推論〕Linux 的單調時鐘（CLOCK_MONOTONIC）
// 不含系統睡眠的時間，Windows 上 performance.now（QueryPerformanceCounter）算不算睡眠時間沒有查證；系統時間含睡眠，
// 但可能被校時往前調。兩者取大，筆電睡眠超過一個租約長度時一定判成 lost（最壞是誤判：不放租約、退回等到期，不會放掉別人的）。
// 〔審查 dec/r8-b1-abandon-fix〕shutdown 開始時 tick 可能正卡在 claim 的交易裡：shutdown 先等那一輪 tick 結束（最多 waitMs），
// tick 看到「正在關閉」就不開始剛認領到的那一列、用這一次的租約憑證把租約放掉（returnClaim），所以 shutdown 回傳之後
// 在途數不會再變多（呼叫的人接著就關連線池）。被放棄的節點裡，放棄之前就已經回來的模型呼叫照記進 jobs 的 token 與 cost_usd
// （chargeAbandoned）；不寫 job_events，所以每日預算（加總 job_events）不含這一段，被中止的那一次呼叫本身沒回來、無從記起。
// 沒有呼叫 shutdown 時（npm start、npm run dev、node workers/jobRunner.js）功能上與 dec/r8-b1-abandon 之前相同；實作上的差別
// （〔審查 dec/r8-b1-abandon-fix〕原本檔頭寫「行為不變」，嚴格說不成立，逐項列出）：
//   ① 認領與續租的 UPDATE 多回傳一欄（租約憑證），多記兩個時間戳；
//   ② 續租：上一次續租還沒回來時不再疊一次（放租約時值才對得上；續租間隔 30 秒，只有資料庫卡住超過 30 秒時才會跳過一次）；
//   ③ 退避睡眠改走 pause，沒有放棄時等同 sleep(ms)：每次自己登記一個喚醒函式、睡完就移除。〔審查 dec/r8-b1-abandon-fix〕
//      dec/r8-b1-abandon 原本讓每次退避 race 一個常駐的 promise，沒有 shutdown 時那個 promise 永遠不 settle，每次退避都在它身上
//      留下一個永遠不釋放的 reaction（每次約 300 位元組），長時間開著的伺服器記憶體會緩慢增加；現在不會。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const { transition, NODE_FOR_STATE, DEFAULT_LIMITS, TERMINAL_STATES, FREE_NODES: SM_FREE_NODES, REVIEW_REASON_FOR_ERROR } = require('../pipeline/stateMachine');
const { findControlChars } = require('../utils/formulaLint');

/** exam_pro/ 的絕對路徑：jobs.pdf_path 存的是相對路徑，一律對這裡 resolve，不看 process.cwd()。 */
const APP_DIR = path.resolve(__dirname, '..');

/** @param {string} p jobs.pdf_path（相對於 exam_pro/，或絕對路徑） */
function resolveJobPath(p) {
    return path.isAbsolute(p) ? p : path.resolve(APP_DIR, p);
}

/** 六個可推進狀態（= 認領 SQL 的 WHERE state IN (...)）。終止上界見裁決 S2-3。 */
const ADVANCEABLE_STATES = Object.keys(NODE_FOR_STATE);

/**
 * 零成本節點：不呼叫生成模型（dedup1 例外會叫一次 embedding，金額極小），因此 DAILY_COST_BUDGET_USD 觸發後仍可繼續跑，
 * 讓已經在途的 job 至少把免費的那幾格走完，而不是整份卡死到隔天。
 * 〔修訂 2026-09-16〕清單本身移到 pipeline/stateMachine.js（規則 3 也要用），這裡只包成 Set。
 */
const FREE_NODES = new Set(SM_FREE_NODES);

/**
 * node → agent 檔名（裁決 S2-6，第 3.1 條）。
 *
 * `dedup0`／`dedup1` 兩個節點由 `agents/dedup.js` 一支服務，另有兩支三行的轉接檔
 * `agents/dedup0.js`／`dedup1.js`。因此 loadAgent 的解析順序是
 * ①`agents/<node>.js` → ②這張表，兩種寫法都接得上。
 * 層級只能靠凍結的 input 鍵判斷（見 buildInput），不看 state 或 payload。
 */
const AGENT_MODULE_FOR_NODE = {
    extract: 'extract', dedup0: 'dedup', classify: 'classify',
    lint: 'lint', verify: 'verify', dedup1: 'dedup'
};
// 階段 3 的 `generate` 節點（interfaces-stage3.md 第 4.1 條）**刻意不進這張表**：
// 它走 loadAgent 的第一順位 `agents/generate.js`（一支轉接到 generateVariant.js 的三行檔），
// 與 dedup0／dedup1 同一個做法。這樣本表維持階段 2 的六個鍵，WS-A 的既有斷言不受影響。

/** job_events.error_class 的十個合法值（DDL CHECK；0009 加 transcription_mismatch）；不在其中的一律不寫進該欄。 */
const ERROR_CLASSES = new Set(['schema_invalid', 'chapter_invalid', 'formula_unparsable',
    'answer_mismatch', 'duplicate', 'provider_error', 'rate_limited', 'timeout', 'budget_exceeded',
    'transcription_mismatch']);

/** SOURCE_CHECK_MODE 的三個合法值（docs/source-check.md）；非法值一律退回 enforce。 */
const SOURCE_CHECK_MODES = ['off', 'shadow', 'enforce'];

const RENEW_INTERVAL_MS = 30_000;   // 第 7.1 條：呼叫進行中每 30 秒續租
const BACKOFF_BASE_MS = 1_000;      // 第 2.3 條：1s → 2s → 4s…
const BACKOFF_MAX_MS = 60_000;      // 封頂 60 秒（與階段 1 gemini adapter 的退避上限一致）
const EXTRACT_MAX_RETRIES = 1;      // 規劃 §3.3.4：extract 整包重試 1 次

/** 〔dec/r8-b1-abandon〕變式逐題生成（runGenerateOne）回這個值＝被放棄了（不是 0／1 題） */
const ABANDONED = Symbol('abandoned');
/** 〔dec/r8-b1-abandon〕被放棄時 AbortController 的 reason（agent 與 services 只看得到 signal.aborted） */
const ABANDON_REASON = '放棄在途工作（shutdown({ abandon: true })）';

/** 單調時鐘（毫秒）：租約是否一直握在手上用它量（系統時間被調整也不受影響） */
function monoNow() {
    return performance.now();
}

/**
 * 〔審查 dec/r8-b1-abandon-fix〕相鄰兩次成功寫入租約之間隔了多久：單調時鐘與系統時間取大的（見檔頭：單調時鐘可能不含系統睡眠）。
 * 沒有記下系統時間（舊的憑證、測試自己組的）時只看單調時鐘，與原本相同。
 * @param {{okSentAt:number|null, okSentWall?:number|null}} lease
 */
function leaseGapMs(lease) {
    const mono = lease.okSentAt !== null && lease.okSentAt !== undefined ? monoNow() - lease.okSentAt : 0;
    const wall = Number.isFinite(lease.okSentWall) ? Date.now() - lease.okSentWall : 0;
    return Math.max(mono, wall);
}

// ─────────────────────────── 純函式（可單元測試，不連 DB）───────────────────────────

/**
 * 讀環境變數組出 runner 的設定。全部給預設值，缺 .env 也跑得起來。
 * @param {object} [env] 預設 process.env
 */
function loadConfig(env = process.env) {
    const int = (name, dflt) => {
        const n = Number.parseInt(env[name], 10);
        return Number.isFinite(n) ? n : dflt;
    };
    const num = (name, dflt) => {
        const n = Number.parseFloat(env[name]);
        return Number.isFinite(n) ? n : dflt;
    };
    // 〔Owner 第五輪 V5-3、V5-4、V5-5 核准 2026-09-27〕去重兩個門檻的預設依向量模型決定（config/similarityThresholds.js：
    // 本機 0.99／0.90、Gemini 0.97／0.90）；.env 明寫仍優先。回傳形狀不變（鍵一個都沒加）。
    const sim = require('../config/similarityThresholds').resolveSimilarityThresholds(env);
    return {
        pollMs: int('JOB_POLL_MS', 2000),
        concurrency: Math.max(1, int('JOB_CONCURRENCY', 2)),
        leaseMs: int('JOB_LEASE_MS', 180000),
        nodeTimeoutMs: int('JOB_NODE_TIMEOUT_MS', 120000),
        costBudgetUsd: num('JOB_COST_BUDGET_USD', 0.5),
        dailyCostBudgetUsd: num('DAILY_COST_BUDGET_USD', 5),
        pdfChunkPages: Math.max(1, int('JOB_PDF_CHUNK_PAGES', 20)),
        inlineMaxBytes: int('GEMINI_INLINE_MAX_BYTES', 15728640),
        classifyMinConf: num('CLASSIFY_MIN_CONF', 0.8),
        dedupDup: sim.dedupDup,
        dedupVariant: sim.dedupVariant
    };
}

/**
 * 階段 3 新增的五個設定（interfaces-stage3.md 第 4.5、4.6、4.7、9 條）。
 *
 * 為什麼另開一支而不是往 `loadConfig()` 裡加鍵：`loadConfig()` 的回傳形狀被
 * `test/unit/jobRunner.test.js`（WS-A 的檔，本 WS 不得修改）用 deepEqual 逐鍵釘住了。
 * 「只加分支」的意思是既有路徑逐位元不變——那也包含既有純函式的回傳形狀。
 * `createRunner()` 把兩份設定合起來用，行為與寫在同一支裡完全相同。
 *
 * @param {object} [env] 預設 process.env
 * @returns {{variantRetrieveSimMin:number, variantOfftopicSimMin:number, variantMinEdit:number,
 *           knnVoteSim:number, variantLintRetries:number, variantAutoApprove:boolean}}
 */
function loadStage3Config(env = process.env) {
    const int = (name, dflt) => {
        const n = Number.parseInt(env[name], 10);
        return Number.isFinite(n) ? n : dflt;
    };
    const num = (name, dflt) => {
        const n = Number.parseFloat(env[name]);
        return Number.isFinite(n) ? n : dflt;
    };
    // 布林一律經 config/features.js 的凍結規則（interfaces-stage1.md 第 9 條：只有 '1'／'true' 為真），
    // 不自己寫一份「有值就是真」——.env 寫 VARIANT_AUTO_APPROVE=false 反而會把它打開。
    const bool = (name, dflt) => {
        const raw = env[name];
        if (raw === undefined || String(raw).trim() === '') return dflt;
        return require('../config/features').parseBool(raw);
    };
    // 裁決 S3-R9：`VARIANT_SIM_MIN` 拆成兩個，因為同一個數字兼任「檢索下限」與「跑題閾值」時
    // 最佳值方向相反（docs/variants.md 第 3 節）。舊名仍是**退路**（只在新變數沒設時生效），
    // 讓還沒更新 .env 的環境行為不變；.env.example 註明過渡期後移除。
    // 〔Owner 第五輪 V5-1、V5-2、O-2、V5-5 核准 2026-09-27〕三個餘弦門檻的預設依向量模型決定
    // （config/similarityThresholds.js：本機 0.72／0.87（暫定）／0.90、Gemini 0.80／0.90／0.90）；
    // 優先順序不變：.env 明寫 > 舊名 VARIANT_SIM_MIN（只給兩個變式門檻）> 預設。
    const sim = require('../config/similarityThresholds').resolveSimilarityThresholds(env);
    return {
        // 四個門檻會進 ctx.config.thresholds（agent 一律不得自己讀 process.env）
        variantRetrieveSimMin: sim.variantRetrieveSimMin,
        variantOfftopicSimMin: sim.variantOfftopicSimMin,   // S3-R29：0.92 → 0.90（Gemini）；Owner 第五輪 V5-2：本機 0.87（暫定）
        variantMinEdit: num('VARIANT_MIN_EDIT', 0.08),
        knnVoteSim: sim.knnVoteSim,
        // 只影響變式 job 的 lint 重試上限（第 4.6 條），預設與階段 2 同值
        variantLintRetries: int('VARIANT_LINT_RETRIES', DEFAULT_LIMITS.maxRetries.lint),
        // false（首輪預設）＝ 全部閘門過了仍停在 needs_review('awaiting_approval') 等人核准
        variantAutoApprove: bool('VARIANT_AUTO_APPROVE', false)
    };
}

/**
 * 原卷文字層比對的模式（docs/source-check.md、ADR-009）。
 *
 * 與 loadStage3Config 同一個理由另開一支：`loadConfig()` 的回傳形狀被單元測試 deepEqual 釘住。
 * 預設 **enforce**（owner 要的是真的攔下抄錯的題）；空字串、大小寫不同以外的非法值一律退回 enforce——
 * 打錯字不該讓閘門悄悄關掉。
 *
 * @param {object} [env] 預設 process.env
 * @returns {{sourceCheckMode:'off'|'shadow'|'enforce'}}
 */
function loadSourceCheckConfig(env = process.env) {
    const raw = String(env.SOURCE_CHECK_MODE ?? '').trim().toLowerCase();
    return { sourceCheckMode: SOURCE_CHECK_MODES.includes(raw) ? raw : 'enforce' };
}

// ─────────────── 〔本機模式 L2〕長節點預設（docs/local-mode.md 第 2、4 條）───────────────

/** 拆題模型是 ollama 時的節點逾時預設：CPU 上一塊考卷要跑 OCR＋兩次 8B 模型，四十五分鐘 */
const LOCAL_NODE_TIMEOUT_MS = 2700000;
/** 拆題模型是 ollama 時一次送給視覺模型的頁數 */
const LOCAL_PDF_CHUNK_PAGES = 2;
/** 拆題模型是 ollama 時的工作槽數：CPU 一次只跑得動一個模型，兩個槽只會讓 PaddleOCR 與 Ollama 搶記憶體 */
const LOCAL_CONCURRENCY = 1;
/**
 * 〔Owner 決策單 2026-09-26 第四輪 V3〕拆題模型是 ollama 時，拆題一塊逾時（error_class='timeout'）最多重試幾次。
 * 本機逾時多半是這台電腦就是跑不完，重試只會再等同樣久（45 分節點逾時 × 4 次＝最壞白跑 3 小時才知道失敗）；
 * Owner 選「只重試 1 次」（共跑 2 次）。只管 runExtractChunk 的 timeout：其他錯誤類別仍是 DEFAULT_LIMITS.maxErrorRetries，
 * 而且逾時的重試也算進那個總數（總上限不變）；Gemini 模式完全不受影響。
 * 沒有開放 .env 覆寫：原本的錯誤重試次數（DEFAULT_LIMITS.maxErrorRetries）就沒有覆寫設定，照同一個慣例寫成常數。
 */
const LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES = 1;
/** 續租間隔的下限（租約設得再短，也不要每幾毫秒打一次 DB） */
const RENEW_MIN_INTERVAL_MS = 1000;

/**
 * 本機模式的長節點預設（第 2 條）。**只補「.env 沒有明寫」的那幾個鍵**——明寫的值一律優先
 * （「明寫」＝解析得出整數；亂填的值與沒填一樣，交給這裡的預設）。
 *
 * 為什麼另開一支而不是改 `loadConfig()`：它的回傳形狀與預設值被單元測試 deepEqual 釘住（Gemini 路徑的預設不變）。
 * `createRunner()` 把它疊在 `loadConfig()` 之後，只有拆題模型是 ollama 時才有覆寫。
 *
 * 租約（JOB_LEASE_MS）刻意**不**跟著放大：runner 在節點執行中每 renewIntervalMs 續租一次
 * （startRenew），長節點不會因租約過期被別的槽重跑；租約維持短的，行程當掉時別的槽才接得回來。
 * test/unit/extractLocalRunner.test.js 與 test/integration/localExtract.pg.test.js 證明這一點
 * （後者含對照組：不續租時同一個長節點真的會被另一個槽重跑）。
 *
 * @param {object} [env] 預設 process.env
 * @param {{extractModel?:string}} [opts] 拆題模型；沒給就讀 env.MODEL_EXTRACT，再沒有就用 config/models.js 的預設
 * @returns {{localExtract:boolean, ocrEngine:'paddle'|'none', nodeTimeoutMs?:number, pdfChunkPages?:number, concurrency?:number}}
 */
function loadLocalModeConfig(env = process.env, opts = {}) {
    const models = require('../config/models');
    const spec = (opts && opts.extractModel) || String(env.MODEL_EXTRACT || '').trim() || models.MODEL_EXTRACT;
    let localExtract = false;
    try { localExtract = models.parseModel(spec).vendor === 'ollama'; } catch (_) { localExtract = false; }
    const explicit = (name) => Number.isFinite(Number.parseInt(env[name], 10));
    return {
        localExtract,
        ocrEngine: require('../services/ocr').resolveEngine(env),
        ...(localExtract && !explicit('JOB_NODE_TIMEOUT_MS') ? { nodeTimeoutMs: LOCAL_NODE_TIMEOUT_MS } : {}),
        ...(localExtract && !explicit('JOB_PDF_CHUNK_PAGES') ? { pdfChunkPages: LOCAL_PDF_CHUNK_PAGES } : {}),
        ...(localExtract && !explicit('JOB_CONCURRENCY') ? { concurrency: LOCAL_CONCURRENCY } : {})
    };
}

/**
 * 〔OCR 為主 2026-09-26〕本機拆題的模式 LOCAL_EXTRACT_MODE（config/localExtractMode.js；docs/local-mode.md 10.12）：
 * 'ocr'（預設；〔Owner 第五輪 D-3 核准 2026-09-27〕原本預設是 cross，只用 OCR 拆題，每題停在 needs_review('ocr_only')）｜
 * 'cross'（交叉驗證，要明寫）。
 *
 * 與 loadLocalModeConfig 分開另一支的理由相同：那一支的回傳形狀被 test/unit/extractLocalRunner.test.js 用 deepEqual 釘住。
 * `createRunner()` 把它疊在 loadLocalModeConfig 之後，經 ctx.config.localExtract 帶給 agent（agent 不讀 process.env）。
 * 只在拆題模型是 ollama 時有作用（agents/extract.js 的本機路徑才讀它）；Gemini 模式完全不受影響。
 *
 * @param {object} [env] 預設 process.env
 * @returns {{localExtractMode:'cross'|'ocr'}}
 */
function loadLocalExtractModeConfig(env = process.env) {
    return { localExtractMode: require('../config/localExtractMode').resolveLocalExtractMode(env) };
}

/**
 * 〔Owner 第五輪 D-3 2026-09-27〕啟動訊息裡的拆題方式（只在拆題模型是 ollama 時印）。
 * @param {'cross'|'ocr'} mode
 * @returns {string}
 */
function startupExtractModeText(mode, explicit = false) {
    if (mode === 'cross') return 'cross（PaddleOCR＋看圖模型交叉驗證；.env 明寫 LOCAL_EXTRACT_MODE=cross）';
    // 〔審查 dec/r6-defaults〕.env 明寫 ocr 時不再說「程式預設」（值相同，但來源要講對）
    return explicit
        ? 'ocr（只用 PaddleOCR＋文字模型拆題，每題停在人工複核；明寫 LOCAL_EXTRACT_MODE=ocr，與程式預設相同；要交叉驗證就改成 LOCAL_EXTRACT_MODE=cross）'
        : 'ocr（只用 PaddleOCR＋文字模型拆題，每題停在人工複核；程式預設，要交叉驗證就在 .env 明寫 LOCAL_EXTRACT_MODE=cross）';
}

/**
 * 〔審查 dec/r6-defaults 2026-09-27〕啟動訊息的門檻＝runner **實際用的** config，不是 process.env 重新解析一次：
 * createRunner({config}) 覆寫了 dedupDup 等值（測試、嵌入式呼叫）時，印出來的要跟實際判斷用的一樣，並標成「（createRunner 設定）」。
 * 正式啟動（server.js、node workers/jobRunner.js）不帶 opts.config 的這幾個鍵，結果與直接解析 process.env 相同。
 * @param {object} config createRunner 疊出來的 config
 * @param {object} [env]
 * @returns {ReturnType<typeof import('../config/similarityThresholds').resolveSimilarityThresholds>}
 */
function effectiveSimilarityThresholds(config, env = process.env) {
    const simCfg = require('../config/similarityThresholds');
    const r = simCfg.resolveSimilarityThresholds(env);
    const out = { ...r, source: { ...r.source } };
    for (const key of Object.keys(simCfg.ENV_NAMES)) {
        const v = config && config[key];
        if (typeof v === 'number' && Number.isFinite(v) && v !== r[key]) {
            out[key] = v;
            out.source[key] = 'config';
        }
    }
    return out;
}

/** 〔審查 2026-09-26〕沒套 0019 就開 LOCAL_EXTRACT_MODE=ocr 時，runner 印的那一句（只印一次） */
const OCR_ONLY_SCHEMA_MESSAGE =
    'LOCAL_EXTRACT_MODE=ocr（只用 OCR 拆題）需要資料庫套到 migrations/0019_ocr_only_review.sql（複核原因 ocr_only），' +
    '這個資料庫還沒套：請在 exam_pro 執行 npm run migrate（套完之後佇列自己恢復，不必重啟）。' +
    '在那之前工作佇列暫停、不認領任何工作（上傳的卷會排隊，不會開始拆題）。';

/**
 * 〔審查 2026-09-26〕LOCAL_EXTRACT_MODE=ocr 的前置條件：job_questions.review_reason 的 CHECK 接受 'ocr_only'（migration 0019）。
 * 沒套就開 ocr 模式時，每一題走到 save 寫 review_reason='ocr_only' 會撞 CHECK，例外被 spawn 吃掉、租約放掉、
 * 下一輪又認領同一列——每題每輪多一筆事件、一行錯誤，沒有上限。所以 runner 在認領之前先查一次（tick）。
 *
 * 查的是約束本身（pg_get_constraintdef），不是 schema_migrations：約束才是真正會擋下寫入的東西。
 * 約束不存在（有人手動拿掉）時寫 'ocr_only' 不會被擋，當作可以跑。
 *
 * @param {{query:Function}} db
 * @returns {Promise<string|null>} null＝可以跑；字串＝還沒套 0019（給 Owner 看的訊息）
 */
async function ocrOnlySchemaProblem(db) {
    const { rows } = await db.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'job_questions' AND c.conname = 'job_questions_review_reason_check'
            AND pg_table_is_visible(t.oid)`);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.some(r => String((r && r.def) || '').includes("'ocr_only'")) ? null : OCR_ONLY_SCHEMA_MESSAGE;
}

/** 〔Owner 第五輪 C-f〕資料庫還沒套 0020 時印一次的訊息 */
const OUTPUT_TRUNCATED_SCHEMA_MESSAGE =
    '本機模型的回應被截斷（寫到輸出上限），照 Owner 第五輪 C-f 不重試、直接進人工複核；但資料庫還沒套 ' +
    'migrations/0020_output_truncated_review.sql（複核原因 output_truncated），這次先以原本的原因（schema_invalid）進複核。' +
    '請在 exam_pro 執行 npm run migrate（不必重啟）。注意：這段期間以 schema_invalid 進複核的本機題其實是被截斷、一次都沒重試，' +
    '複核頁「重試已用盡、重跑通常就會過」的說明對它們不成立（重跑多半還是會截斷），請當成被截斷的題處理。';

/**
 * 〔Owner 第五輪 C-f〕job_questions.review_reason 的 CHECK 接不接受 'output_truncated'（migration 0020）。
 * 與 ocrOnlySchemaProblem 同一個查法（查約束本身）；約束不存在＝不會被擋＝接受。
 * @param {{query:Function}} db
 * @returns {Promise<boolean>}
 */
async function outputTruncatedAccepted(db) {
    const { rows } = await db.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'job_questions' AND c.conname = 'job_questions_review_reason_check'
            AND pg_table_is_visible(t.oid)`);
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows.some(r => String((r && r.def) || '').includes("'output_truncated'"));
}

/**
 * 〔Owner 第五輪 C-f〕這一次呼叫的模型是不是本機（ollama）。spec 沒給＝services/llm 的預設（MODEL_EXTRACT）。
 * @param {string|null|undefined} spec 'ollama:qwen3:8b'、'gemini:…' 或裸 ID（裸 ID＝Gemini）
 * @returns {boolean}
 */
function isLocalModelSpec(spec) {
    const models = require('../config/models');
    try { return models.parseModel(String(spec || models.MODEL_EXTRACT)).vendor === 'ollama'; } catch (_) { return false; }
}

/**
 * 〔Owner 第五輪 C-f〕這個 outcome 是不是「本機模型的回應被截斷」：error、finishReason='MAX_TOKENS'、呼叫的模型是 ollama。
 * @param {object} outcome
 * @param {string|null|undefined} modelSpec  這個節點最後一次呼叫的模型（meter.lastModel）
 * @returns {boolean}
 */
function isLocalTruncation(outcome, modelSpec) {
    return Boolean(outcome && outcome.kind === 'error' && outcome.finishReason === 'MAX_TOKENS' && isLocalModelSpec(modelSpec));
}

/**
 * 〔dec/r13-extract-fixes〕extract 事件 detail 裡的解答頁欄位（agents/extract.js 本機路徑的 data.answer_key、data.latex_repaired）。
 * 沒有就回空物件（Gemini 路徑的事件與之前逐鍵相同）。純函式。
 * @param {object} data extract outcome 的 data
 * @returns {object}
 */
function answerKeyDetail(data) {
    const out = {};
    const ak = data && data.answer_key;
    if (ak && typeof ak === 'object') {
        out.answer_key = ak;
        const skipped = Array.isArray(ak.skipped) ? ak.skipped : [];
        if (skipped.length) out.skipped_answer_key = { pages: Array.isArray(ak.pages) ? ak.pages : [], count: skipped.length };
    }
    if (data && Number.isInteger(data.latex_repaired) && data.latex_repaired > 0) out.latex_repaired = data.latex_repaired;
    return out;
}

/**
 * 〔dec/r13-extract-fixes〕各塊 extract 事件的 answer_key → 依塊序攤平的解答表項目。同一塊有多筆事件（舊版整份重拆）時取最後一筆。純函式。
 * @param {Array<{chunk:number, answer_key:object}>} rows 依事件 id 排序
 * @returns {Array<{label:string, value:string|null, certain:boolean}>}
 */
function collectAnswerKeyEntries(rows) {
    const byChunk = new Map();
    for (const r of rows || []) {
        const ak = r && r.answer_key;
        if (!ak || !Array.isArray(ak.entries)) continue;
        byChunk.set(Number(r.chunk) || 0, ak.entries);
    }
    return [...byChunk.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, list]) => list);
}

/** 〔dec/r13-extract-fixes〕逾時不重試的題目節點（本機模式；docs/local-mode.md 10.25 第 5 點） */
const LOCAL_TIMEOUT_NO_RETRY_NODES = Object.freeze(['lint', 'verify']);

/** 〔dec/r13-extract-fixes〕本機逾時不重試時寫進 job_events.detail 的說明 */
const LOCAL_TIMEOUT_NOTE = '本機模型這一步逾時：不重試，直接交給老師複核（Owner 2026-10-02 同意；docs/local-mode.md 10.25）。' +
    '單次逾時是 OLLAMA_TIMEOUT_MS_LINT／OLLAMA_TIMEOUT_MS_VERIFY（本機預設 30 分鐘）。';

/**
 * 〔dec/r13-extract-fixes，Owner 2026-10-02 同意〕這個 outcome 是不是「本機模型的 lint／verify 逾時」：
 * error、errorClass='timeout'、節點是 lint 或 verify、這一次呼叫的模型是 ollama。是的話 runner 給狀態機 retryTimeout:false，
 * 不重試、直接 needs_review('provider_error')（比照 C-f 的截斷不重試與第七輪 R7-1 的變式截斷）。Gemini 照舊重試。
 * 節點層的逾時（JOB_NODE_TIMEOUT_MS）也算：那同樣是本機模型跑太久。
 * @param {string} node
 * @param {object} outcome
 * @param {string|null|undefined} modelSpec meter.lastModel；這個節點沒有呼叫模型（lint 只跑了零成本那兩層）時是 null
 * @returns {boolean}
 */
function isLocalTimeout(node, outcome, modelSpec) {
    if (!outcome || outcome.kind !== 'error' || outcome.errorClass !== 'timeout') return false;
    if (!LOCAL_TIMEOUT_NO_RETRY_NODES.includes(node)) return false;
    // modelSpec 是 null（還沒呼叫到模型就逾時）時不判成本機：isLocalModelSpec(null) 會退回 MODEL_EXTRACT，那不是這一步的模型
    return Boolean(modelSpec) && isLocalModelSpec(modelSpec);
}

/**
 * 〔Owner 第七輪 R7-1；審查 dec/r10-variant-cap〕這一次本機呼叫**實際送出的**輸出上限（Ollama 的 num_predict）：
 * 讀 services/llm 掛在錯誤物件上的 appliedNumPredict（services/llm/index.js 的 markAppliedNumPredict），不依事件當下的 env 重算。
 * 沒送 num_predict（取消了預設）、replay（沒有送出任何請求，錯誤物件不帶這個鍵）、或不是 services/llm 丟的錯時回 null。
 * 只給事件與 log 看，不影響流程。純函式。
 * @param {unknown} err  llm.generateJson 丟出的錯
 * @returns {number|null}
 */
function appliedNumPredictOf(err) {
    if (!err || typeof err !== 'object') return null;
    const n = err.appliedNumPredict;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 〔Owner 第七輪 R7-1＝4〕變式生成本機截斷時寫進 job_events.detail 的說明（給人看；放棄這一題、不重試）。
 * @param {number|null} cap  這一次實際送出的輸出上限（appliedNumPredictOf；不知道時 null）
 * @returns {string}
 */
function variantTruncationNote(cap) {
    return `本機模型的回應寫到輸出上限${cap ? `（${cap} token）` : ''}被截斷：不重試，放棄這一題（Owner 第七輪 R7-1＝4；docs/local-mode.md 10.24）。`;
}

/**
 * 節點執行中續租的間隔：預設每 30 秒（第 7.1 條），但租約短於 90 秒時縮成租約的三分之一，
 * 保證租約到期前至少續過兩次。
 * @param {number} leaseMs
 */
function renewIntervalFor(leaseMs) {
    const third = Math.floor(Number(leaseMs) / 3);
    if (!Number.isFinite(third) || third <= 0) return RENEW_INTERVAL_MS;
    return Math.max(RENEW_MIN_INTERVAL_MS, Math.min(RENEW_INTERVAL_MS, third));
}

/**
 * 〔本機模式 L2〕交叉驗證的政策停等（docs/local-mode.md 第 4 條第 4 點）：
 * payload.extract 帶 cross_check、而且 status 不是 'agree' 的題，走到 save 時一律停在
 * needs_review('extract_disagree')，絕不自動入庫。沒有 cross_check 的題（Gemini 路徑、變式題）回 null，照常入庫。
 *
 * 〔OCR 為主 2026-09-26〕只用 OCR 拆的題（payload.extract.extract_mode === 'ocr'，agents/extract.js 的 runLocalOcrOnly 寫的）
 * 沒有第二版可以比對：一律停在 needs_review('ocr_only')——與「兩版不一致」分開（複核頁的說明不同），
 * 不看 cross_check 長什麼樣（缺了、壞了都一樣停，往安全的方向錯）。
 *
 * 只看得到 save 這一格：前面任何節點先判了更嚴重的原因（重複、章節不合法、答案對不上…），
 * 那一列早就停在 needs_review，不會走到這裡。
 * cross_check 形狀壞掉（不是物件、沒有 status）一律當作「不一致」——往安全的方向錯。
 *
 * @param {object} payload job_questions.payload
 * @returns {'extract_disagree'|'ocr_only'|null}
 */
function crossCheckStopReason(payload) {
    const ex = payload && payload.extract;
    if (ex && typeof ex === 'object' && ex.extract_mode === 'ocr') return 'ocr_only';
    if (!ex || typeof ex !== 'object' || !Object.prototype.hasOwnProperty.call(ex, 'cross_check')) return null;
    const cc = ex.cross_check;
    if (cc === null || cc === undefined) return null;
    return typeof cc === 'object' && cc.status === 'agree' ? null : 'extract_disagree';
}

/**
 * 依總頁數與每塊頁數切出 chunk 清單（第 0.2 條：切塊是為了「失敗重試的粒度」）。
 * @param {number|null} pageCount 為 null／0 時退成單一塊、toPage 給 null（交給 agent 自己判斷整份）
 * @param {number} chunkPages
 * @returns {Array<{no:number, fromPage:number, toPage:number|null}>}
 */
function planChunks(pageCount, chunkPages) {
    const total = Number.parseInt(pageCount, 10);
    const size = Math.max(1, Number.parseInt(chunkPages, 10) || 1);
    if (!Number.isFinite(total) || total <= 0) return [{ no: 1, fromPage: 1, toPage: null }];

    const chunks = [];
    for (let from = 1, no = 1; from <= total; from += size, no += 1) {
        chunks.push({ no, fromPage: from, toPage: Math.min(from + size - 1, total) });
    }
    return chunks;
}

/** 頁碼範圍的比對鍵（toPage 為 null＝頁數不明、整份一塊） */
function pageRangeKey(fromPage, toPage) {
    return `${fromPage}-${toPage === null || toPage === undefined ? '' : toPage}`;
}

/**
 * 一列 extract 檢查點（job_events.detail 的 chunk／page_range／created）整理成 {no, fromPage, toPage, created}；
 * 形狀不對的回 null（不當成檢查點——寧可重拆，也不要把沒拆完的塊當成拆完）。
 */
function normalizeCheckpoint(c) {
    const no = Number(c?.chunk);
    const range = c?.page_range;
    if (!Number.isInteger(no) || no <= 0 || !Array.isArray(range) || range.length !== 2) return null;
    const fromPage = Number(range[0]);
    const toPage = range[1] === null ? null : Number(range[1]);
    if (!Number.isInteger(fromPage) || fromPage <= 0) return null;
    if (toPage !== null && (!Number.isInteger(toPage) || toPage < fromPage)) return null;
    const created = Number(c?.created);
    return { no, fromPage, toPage, created: Number.isInteger(created) && created >= 0 ? created : 0 };
}

/**
 * 〔Owner 第六輪 DA-13＝2，dec/r7-checkpoints〕拆題的逐塊檢查點：重新認領時哪幾塊已經拆完、哪幾塊要跑。
 *
 * 檢查點＝這份 job 的 extract 事件裡 outcome 是 pass／skipped 的那幾列（`detail.chunk`、`detail.page_range`、
 * `detail.created`；依 id 遞增傳進來），不另開欄位、不需要 migration。runExtractChunk 把「建這一塊的題目列」與
 * 「寫這一列事件」放在同一個交易，所以有檢查點的塊題目一定都建好了，沒有檢查點的塊一列題目都沒有。
 *
 * 四種情形（mode）：
 *   - 'fresh'：沒有檢查點，照 planChunks 從第 1 塊跑。
 *   - 'resume'：檢查點的（塊號, 頁碼範圍）全都對得上這次的 planChunks（切法沒變，最常見）→ 跳過頁碼範圍相同的塊，
 *     其餘照原本的塊號跑。塊號不變，題號（塊號 × 1000 ＋ 塊內位置，agents/extract.js）就和一次跑完完全一樣。
 *   - 'replanned'：對不上＝切法變了（本機 2 頁／Gemini 20 頁之間換了模式、改了 JOB_PDF_CHUNK_PAGES）。設計稿第 36 項說
 *     比對頁碼範圍、不比塊號；但直接照新切法從第 1 塊重拆，新的第 1 塊題號也是 1001 起，會和舊第 1 塊的列撞號
 *     （ON CONFLICT 丟掉新結果、多出來的又建成新列＝重複列）。所以改成：舊檢查點從第 1 頁起**連續**涵蓋到第 P 頁的
 *     那幾塊算拆完；第 P+1 頁起用這次的頁數切，塊號接在舊檢查點最大的塊號之後。題號不撞，塊的先後順序也不變
 *     （承上題找「前一塊」照舊成立，utils/followUp.js）。
 *   - 'inconsistent'：檢查點對不上這次的切法，又不是從第 1 頁起連續、塊號遞增的一串（中間有洞、或有不在那一串上的
 *     檢查點；塊依序跑、page_count 建立後不變，所以正常流程到不了，只有舊資料或人工改過才會）→ **不排任何塊**
 *     （todo 為空），呼叫端直接 failJob（jobs.error 寫「拆題檢查點對不上」），不自動重拆、按重試也一樣。
 *     〔dec/r7-checkpoints-fix，依審查〕原本退回「只跳過頁碼範圍相同的塊、其餘照這次的塊號跑」，會撞號也會重拆：
 *       · 40 頁、每塊 20 頁、只有「第 2 塊＝第 3～4 頁」的檢查點 → 排出第 1 塊（1～20 頁）與第 2 塊（21～40 頁）：新第 2 塊的
 *         題號 2001 起，和舊第 2 塊已建好的列同號（ON CONFLICT 悄悄丟掉）；第 3～4 頁又拆一次，建成內容重複的列。
 *       · 6 頁、「第 1 塊＝1～2 頁」＋「第 3 塊＝5～6 頁」→ 排出第 4 塊（3～6 頁）：第 5～6 頁重拆，4001 起和既有的 3001 內容重複。
 *     審查的另一個做法（塊號一律接在最大塊號之後、跳過檢查點涵蓋的頁）也不行：第一例會把第 1～2 頁編成第 3 塊，
 *     排在第 2 塊（第 3～4 頁）之後，塊號和頁碼順序對不上，承上題找「前一塊」（utils/followUp.js）會找錯。
 *     「題號不撞、不重拆、塊號照頁碼順序」三者沒辦法同時做到，所以停下來請人處理。
 *
 * 同一個頁碼範圍有多列檢查點（舊版整份重拆留下的）只算一次，created 取最大的那一列；同一個頁碼範圍卻記成不同的塊號
 * 也算 inconsistent（〔dec/r7-checkpoints-fix〕）。
 *
 * @param {number|null} pageCount jobs.page_count
 * @param {number} chunkPages 這次的每塊頁數（config.pdfChunkPages）
 * @param {Array<{chunk:any, page_range:any, created:any}>} checkpoints
 * @returns {{todo:Array<{no:number, fromPage:number, toPage:number|null}>,
 *            done:Array<{no:number, fromPage:number, toPage:number|null, created:number}>,
 *            doneCreated:number, mode:'fresh'|'resume'|'replanned'|'inconsistent'}}
 */
function planResumeChunks(pageCount, chunkPages, checkpoints) {
    const planned = planChunks(pageCount, chunkPages);
    const inconsistent = { todo: [], done: [], doneCreated: 0, mode: 'inconsistent' };
    const list = [];
    const byKey = new Map();
    let sameRangeTwoNos = false;
    for (const raw of Array.isArray(checkpoints) ? checkpoints : []) {
        const c = normalizeCheckpoint(raw);
        if (!c) continue;
        const key = pageRangeKey(c.fromPage, c.toPage);
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, c); list.push(c); continue; }
        // 〔dec/r7-checkpoints-fix〕同一個頁碼範圍記成兩個塊號：兩組題號（塊號 × 1000 起）都可能已經建了列，
        // 只認其中一個的話，另一個塊號之後可能又被排給別的頁而撞號。正常流程到不了，當成 inconsistent。
        if (c.no !== prev.no) sameRangeTwoNos = true;
        if (c.created > prev.created) prev.created = c.created;
    }
    const sumCreated = (arr) => arr.reduce((s, c) => s + c.created, 0);
    if (list.length === 0) return { todo: planned, done: [], doneCreated: 0, mode: 'fresh' };
    if (sameRangeTwoNos) return inconsistent;

    const plannedByKey = new Map(planned.map(p => [pageRangeKey(p.fromPage, p.toPage), p]));
    const sameCut = list.every(c => {
        const p = plannedByKey.get(pageRangeKey(c.fromPage, c.toPage));
        return p !== undefined && p.no === c.no;
    });
    if (sameCut) {
        // 每個檢查點都正好是這次切法的某一塊（頁碼範圍與塊號都相同）：跳過它們，其餘照原本的塊號跑，題號不會撞
        const todo = [];
        const done = [];
        for (const p of planned) {
            const c = byKey.get(pageRangeKey(p.fromPage, p.toPage));
            if (c) done.push({ ...p, created: c.created }); else todo.push(p);
        }
        return { todo, done, doneCreated: sumCreated(done), mode: 'resume' };
    }

    const total = Number.parseInt(pageCount, 10);
    if (Number.isFinite(total) && total > 0) {
        const chain = [];
        let next = 1;
        for (; ;) {
            const c = list.find(x => x.fromPage === next);
            if (!c) break;
            chain.push(c);
            if (c.toPage === null || c.toPage >= total) { next = total + 1; break; }
            next = c.toPage + 1;
        }
        // 〔dec/r7-checkpoints-fix，依審查〕每個檢查點都要在這一串上：不在串上的檢查點（例如同一個起頁有兩種頁數、
        // 或串斷掉之後還有）涵蓋的頁會落進下面重新切的塊，已建好的題會再建一次（重複列），所以也當成 inconsistent。
        // 串上的塊號也要照頁碼順序遞增，否則題號的先後和頁碼對不上（承上題找前一塊會找錯）。
        const ordered = chain.every((c, i) => i === 0 || c.no > chain[i - 1].no);
        if (chain.length > 0 && chain.length === list.length && ordered) {
            const maxNo = Math.max(...list.map(c => c.no));
            const rest = next > total ? [] : planChunks(total - next + 1, chunkPages).map((p, i) => ({
                no: maxNo + i + 1, fromPage: p.fromPage + next - 1, toPage: p.toPage + next - 1
            }));
            const done = chain.map(c => ({ no: c.no, fromPage: c.fromPage, toPage: c.toPage, created: c.created }));
            return { todo: rest, done, doneCreated: sumCreated(done), mode: 'replanned' };
        }
    }
    return inconsistent;
}

/** 〔dec/r7-checkpoints-fix〕planResumeChunks 回 inconsistent 時 jobs.error 的那句話（不自動重拆、請人處理）。 */
const EXTRACT_CHECKPOINT_INCONSISTENT_MSG =
    '拆題檢查點對不上：已拆完的塊不是從第 1 頁起連續的一串（正常流程不會發生）。為了不讓題號衝突或建出重複的題，' +
    '沒有自動接著拆，按重試也會停在這裡。處理方式見 engineering_docs/06_ops/runbook-job-stuck.md 的「拆題檢查點對不上」。';

/**
 * 供應商錯誤的退避毫秒數（第 2.3 條：睡眠由 runner 做，狀態機只計數）。
 * @param {number} attempt 這是第幾次退避（0 起算）
 */
function backoffMs(attempt) {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)), BACKOFF_MAX_MS);
}

/**
 * job_events.attempt：從 1 起算，等於「這個節點已經跑過幾次」+ 1。
 * fail 與 error 兩組計數器都要算進去，否則同一列會出現兩個 attempt=2 的事件。
 */
function attemptNo(retries, node) {
    const r = retries || {};
    return (r[node] ?? 0) + (r[`${node}:error`] ?? 0) + 1;
}

/**
 * 這次節點呼叫有沒有走 schema 退路（裁決 S2-4，第 5.1 條）。
 *
 * 兩個來源取 OR，任一為真就記：
 *   1. `generateJson` 的回傳（runner 的計量器直接看到，最權威——agent 忘了轉手也不會漏）
 *   2. `outcome.data.schema_fallback`（agent 自己記的，例如 `agents/extract.js`）
 *
 * 回 false 時呼叫端**不寫這個鍵**：絕大多數呼叫都沒走退路，
 * 逐列存一個 `false` 只是讓 job_events.detail 白白變大。
 *
 * @param {{schemaFallback?:boolean}} meter
 * @param {{data?:object}} outcome
 * @returns {boolean}
 */
function schemaFallbackOf(meter, outcome) {
    return meter?.schemaFallback === true || outcome?.data?.schema_fallback === true;
}

/** 不在 DDL 九個值內的 error_class 一律不寫（欄位可為 NULL），避免 CHECK 炸掉。 */
function normalizeErrorClass(value) {
    return ERROR_CLASSES.has(value) ? value : null;
}

/**
 * 由 payload 組出要寫進 questions 的欄位（save 節點，第 3.3 條表格最後一列）。
 *
 * 取值優先序（凍結）：章節用 classify 的最終值、題幹與答案用 lint 的修正後版本，
 * 兩者都沒跑過才回頭用 extract 的原始值；figure_desc 以 `[附圖描述：…]` 併回題幹末端，
 * 格式與 aiService.js 現行一致，wordService 與前端因此不用改。
 *
 * @param {object} payload job_questions.payload
 * @returns {{subject, chapter, question_type, difficulty, question_text, answer_text}}
 */
function buildSaveFields(payload) {
    const p = payload || {};
    const ex = p.extract || {};
    const lint = p.lint || {};
    const cls = p.classify || {};

    let question_text = lint.question_text ?? ex.question_text ?? '';
    const figure = ex.figure_desc;
    if (figure && String(figure).trim() && !question_text.includes('[附圖描述：')) {
        question_text = `${question_text}\n[附圖描述：${String(figure).trim()}]`;
    }

    // 〔dec/r13-extract-fixes〕lint 的答案是空的（拆題時沒有答案、lint 照樣留空）而 extract 的答案後來有了
    // （解答頁回填，payload.extract.answer_src='answer_key'）時用 extract 的；其餘與原本相同（lint 優先）
    const lintAnswer = typeof lint.answer_text === 'string' && lint.answer_text.trim() === '' ? undefined : lint.answer_text;
    return {
        subject: ex.subject,
        chapter: cls.chapter ?? ex.chapter,
        question_type: ex.question_type,
        difficulty: ex.difficulty,
        question_text,
        answer_text: lintAnswer ?? ex.answer_text ?? lint.answer_text ?? ''
    };
}

/**
 * 〔dec/r13-extract-fixes，Owner 2026-10-02 同意；docs/local-mode.md 10.25 第 1 點〕答案是空的題不自動入庫：
 * 本機拆題在題目頁沒寫答案時留空、解答頁也沒回填到，verify 只能給建議答案（payload.verify.suggested_answer）。
 * 走到 save 時停在 needs_review('awaiting_approval')（沒有閘門判它壞掉，只是要人補答案；不新增 review_reason）。
 * 原本這種題會以「略」入庫（saveNode 的 answer_text || '略'）。只看 PDF 拆出來的題（變式題一定有答案）。
 * @param {object} payload
 * @returns {'awaiting_approval'|null}
 */
function answerMissingStopReason(payload) {
    if (!payload || typeof payload !== 'object' || !payload.extract) return null;
    return String(buildSaveFields(payload).answer_text ?? '').trim() === '' ? 'awaiting_approval' : null;
}

/**
 * 〔審查 dec/r13-extract-fixes〕解答頁回填的答案與驗算的交叉確認。
 * applyAnswerKey 要等整份拆完才跑，前幾塊的題可能已經以 no_claim 跑完 verify——回填的答案就沒有跟驗算比過。
 * 這種題（payload.extract.answer_src === 'answer_key' 而且 payload.verify.compare === 'no_claim'）在 save 前補比一次：
 * 用 utils/answerCompare.js 比「要入庫的答案」（buildSaveFields）與驗算的建議答案（suggested_answer）。
 * 不是 agree（含沒有建議答案）就不自動入庫——解答表與題目的對位只靠「題號總數＝題數」，丟一題又多一題時會整份錯開。
 * 其餘情形（不是回填的、verify 比過的）回 null。純函式。
 * @param {object} payload
 * @returns {{compare:'agree'|'disagree'|'uncertain', key_answer:string, suggested_answer:string|null}|null}
 */
function answerKeyCheck(payload) {
    const ex = payload && payload.extract;
    const v = payload && payload.verify;
    if (!ex || typeof ex !== 'object' || ex.answer_src !== 'answer_key') return null;
    if (!v || typeof v !== 'object' || v.compare !== 'no_claim') return null;
    const keyAnswer = String(buildSaveFields(payload).answer_text ?? '').trim();
    if (!keyAnswer) return null;   // 答案是空的另由 answerMissingStopReason 處理
    const suggested = [v.suggested_answer, v.final_answer].find(x => typeof x === 'string' && x.trim());
    if (!suggested) return { compare: 'uncertain', key_answer: keyAnswer, suggested_answer: null };
    const { answerCompare } = require('../utils/answerCompare');
    const lint = payload.lint || {};
    const compare = answerCompare({
        question_type: ex.question_type,
        claimed: keyAnswer,
        model: { final_answer: suggested, answer_form: v.answer_form },
        ...(ex.subject === '化學' ? { subject: ex.subject } : {}),
        question_text: lint.question_text || ex.question_text || ''
    });
    return { compare, key_answer: keyAnswer, suggested_answer: suggested.trim() };
}

/**
 * save 之前的政策停等（runner 與 eval/lib/pipelineDriver.js 共用）：先看拆題的交叉驗證（crossCheckStopReason），
 * 再看答案是不是空的（answerMissingStopReason），最後看解答頁回填的答案與驗算對不對得上（answerKeyCheck；
 * 〔審查 dec/r13-extract-fixes〕不是 agree 就停在 awaiting_approval，不新增 review_reason）。
 * @param {object} payload
 * @returns {{reason:string, kind:'cross_check'|'no_answer'|'answer_key_unverified', check?:object}|null}
 */
function saveStopReason(payload) {
    const cc = crossCheckStopReason(payload);
    if (cc) return { reason: cc, kind: 'cross_check' };
    const na = answerMissingStopReason(payload);
    if (na) return { reason: na, kind: 'no_answer' };
    const check = answerKeyCheck(payload);
    if (check && check.compare !== 'agree') return { reason: 'awaiting_approval', kind: 'answer_key_unverified', check };
    return null;
}

/** questions.solution_text 的字數上限（migrations/0011 的 CHECK）。 */
const SOLUTION_MAX_LEN = 4000;

/**
 * 〔stage5 WS-A〕由 payload 的 verify 結果決定入庫時要不要一併寫文字詳解
 * （docs/interfaces-stage5.md 第 4.1 條第 5 項；DEC-017、缺口 G05）。
 *
 * verify 節點（agents/verify.js）pass 時，runner 的 mergePayload 把它的 data 原樣存成
 * `payload.verify = { skipped:false, final_answer, answer_form, steps_summary, claimed_answer, compare, samples }`。
 * 「判定一致」看的是 `compare === 'agree'`（answerCompare 的結論），不是 outcome 的 kind——
 * payload 裡只留得下 data。證明題走 skipped（`{ skipped: true }`，沒有 steps_summary）。
 *
 * 只有「一致且 steps_summary 非空」才寫；其他情況（沒跑、跳過、uncertain／disagree、空白、
 * 超過 4000 字、含換行以外的控制字元〔Owner 第五輪 L-1〕）一律兩欄 NULL。超長**不截斷**：截一半的詳解比沒有詳解更會誤導學生。
 *
 * scripts/backfill_solutions.js 回填既有題目時也呼叫這一支，兩條路徑的判定因此不會走鐘。
 *
 * @param {object} payload job_questions.payload
 * @returns {{ solution_text:string|null, solution_src:'verify'|null }}
 */
function buildSolutionFields(payload) {
    const none = { solution_text: null, solution_src: null };
    const v = payload && payload.verify;
    if (!v || typeof v !== 'object' || v.skipped === true || v.compare !== 'agree') return none;
    const text = typeof v.steps_summary === 'string' ? v.steps_summary.trim() : '';
    if (text === '' || [...text].length > SOLUTION_MAX_LEN) return none;
    // 〔Owner 第五輪 L-1 核准，2026-09-27〕詳解不經公式閘門（verify 在 lint 之後才跑，沒有公式重寫可送），
    // 還有換行以外的控制字元（LaTeX 反斜線被 JSON 吃掉、修復層救不回來的）就不寫——同 formulaLint 的 control_char 判準。
    if (findControlChars(text).length > 0) return none;
    return { solution_text: text, solution_src: 'verify' };
}

/**
 * 入庫時的 `chapter_src`，依 `payload.classify.source` 決定
 * （interfaces-stage3.md 第 4.7、5.2 條的對照表）：
 *
 *   'gate' → 'ai'  ｜ 'llm' → 'ai'  ｜ **'knn' → 'knn'**
 *
 * `'human'` 不會出現在這裡：它只由「人動手改過章節」產生（`PUT /api/questions/:id`
 * 與 `POST /api/review/:jqId/approve`），這是 kNN 投票只信人工標籤的前提（規劃 §4.4）。
 * 沒跑過 classify（理論上不會發生）時保守回 `'ai'`。
 *
 * @param {object} payload job_questions.payload
 * @returns {'ai'|'knn'}
 */
function chapterSrcFor(payload) {
    return payload?.classify?.source === 'knn' ? 'knn' : 'ai';
}

/**
 * 組 `ctx.config.features`（裁決 S2-8，第 3.1 條）。
 *
 * 鍵名凍結為**小寫短名** `{ similar, pipeline }`，不是環境變數全名；
 * 值一律經 `config/features.js`（布林解讀規則凍結於 interfaces-stage1.md 第 9 條：
 * 只有字串 `1`／`true` 為真）。每次組 ctx 都重讀一次，`.env` 改了不必重啟 worker。
 *
 * @returns {{similar:boolean, pipeline:boolean}}
 */
function readFeatures() {
    const features = require('../config/features');
    return {
        similar: features.isEnabled('FEATURE_SIMILAR'),
        pipeline: features.isEnabled('FEATURE_PIPELINE')
    };
}

/**
 * 〔stage5 WS-C〕入庫後的知識點自動標註掛鉤（docs/interfaces-stage5.md 第 4.3 條第 3 點）。
 *
 * 規則：
 *   - `enabled`（= FEATURE_KC_TAGGING）為假時**完全不呼叫** tagger，回 null。
 *   - 開啟時先問 `budgetCheck()`：回傳非空字串（略過原因）就**不呼叫** tagger，記一行 info、回 null。
 *     理由：save 在 FREE_NODES 內，當日成本觸頂（DAILY_COST_BUDGET_USD）或該 job 的 budget_usd 用盡時
 *     仍會照跑；標註卻要付錢給 LLM，不在這裡擋就會繞過兩道煞車。budgetCheck 自己丟錯時同樣不呼叫
 *     （查不到帳就不花錢），只記 warn。略過的題之後可用 `npm run kc:backfill` 補標。
 *   - 呼叫 tagger(questionId)；它同步丟錯、回傳 rejected promise 都一樣只記 warn，
 *     回傳的 promise **永遠 resolve**——呼叫端不 await 也不會冒出 unhandledRejection，
 *     job 的狀態推進完全不受影響（與 scheduleEmbed 同一個原則）。
 *   - 標註的費用**不寫進** jobs／job_events（那是拆題管線的帳），只留在 info log 的 cost_usd。
 *     所以它不會讓當日花費變多、提早觸發煞車；煞車只會在管線本身觸頂後擋下後續的標註。
 *
 * @param {{questionId:number, enabled:boolean, tagger:(id:number)=>any, logger:{info:Function, warn:Function},
 *          budgetCheck?:()=>(string|null|Promise<string|null>)}} opts
 * @returns {Promise<object|null>} tagger 的結果；沒呼叫、被預算擋下或失敗時為 null
 */
function runKcTagHook({ questionId, enabled, tagger, logger, budgetCheck }) {
    if (!enabled) return Promise.resolve(null);
    const log = logger || makeLogger();
    return Promise.resolve()
        .then(() => (typeof budgetCheck === 'function' ? budgetCheck() : null))
        .then((blocked) => {
            if (blocked) {
                log.info({ msg: '知識點自動標註略過（預算已用盡，不呼叫 LLM）', question_id: questionId, status: 'skipped', reason: blocked });
                return null;
            }
            return Promise.resolve(tagger(questionId)).then((r) => {
                log.info({
                    msg: '知識點自動標註', question_id: questionId, status: r && r.status,
                    ...(r && r.reason ? { reason: r.reason } : {}),
                    ...(r && Array.isArray(r.written) && r.written.length ? { kc_codes: r.written.map(w => w.code) } : {}),
                    // 標註的費用不進 jobs／job_events（那是拆題管線的帳），只留在這一行 log
                    ...(r && r.usage && r.usage.calls ? { cost_usd: r.usage.costUsd } : {})
                });
                return r ?? null;
            });
        })
        .catch((err) => {
            log.warn({ msg: '知識點自動標註失敗（不影響入庫）', question_id: questionId, error: String((err && err.message) || err).split('\n')[0] });
            return null;
        });
}

/** 一行一個 JSON 的預設 logger（第 7.5 條）。 */
function makeLogger(sink = console) {
    const line = (level, obj) => sink.log(JSON.stringify({ ts: new Date().toISOString(), level, ...obj }));
    return {
        info: (obj) => line('info', obj),
        warn: (obj) => line('warn', obj),
        error: (obj) => line('error', obj)
    };
}

// ─────────────────────────── runner 本體 ───────────────────────────

/**
 * 建一個 runner。所有外部相依都從參數進來，整合測試才好塞假的。
 *
 * @param {object}  [opts]
 * @param {{pool, query}} [opts.db]        預設 require('../config/db')
 * @param {object}  [opts.llm]             預設 require('../services/llm')
 * @param {string}  [opts.agentsDir]       預設 <repo>/agents；測試指到 test/fixtures/fakeAgents
 * @param {object}  [opts.config]          loadConfig() 的輸出，可逐欄覆寫
 * @param {object}  [opts.logger]
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 測試可換成不真的睡
 * @param {(meter)=>{cost_usd:number, cost_estimated:boolean}} [opts.estimateCost]
 *        預設查 config/pricing.js（WS-B）；整合測試塞一個假的才測得到預算累加
 * @param {(questionId:number)=>Promise<object>} [opts.kcTagger]
 *        〔stage5 WS-C〕入庫後的知識點標註；預設 services/kcTagService.tagQuestion（FEATURE_KC_TAGGING 開啟才會被呼叫）
 * @returns {{tick, start, stop, shutdown, runJobQuestion, runExtractJob, runGenerateJob, config, inFlight:number, abandoning:boolean, pausing:number}}
 *          shutdown（〔dec/r8-b1-abandon〕）見檔頭與下方 shutdown() 的說明
 */
function createRunner(opts = {}) {
    const db = opts.db || require('../config/db');
    const llm = opts.llm || require('../services/llm');
    const agentsDir = opts.agentsDir || path.resolve(__dirname, '..', 'agents');
    // 〔本機模式 L2〕loadLocalModeConfig 疊在 loadConfig 之後：拆題模型是 ollama 且 .env 沒明寫時，補長節點預設
    // 〔OCR 為主 2026-09-26〕再疊 LOCAL_EXTRACT_MODE（loadLocalExtractModeConfig）
    const config = {
        ...loadConfig(), ...loadStage3Config(), ...loadSourceCheckConfig(), ...loadLocalModeConfig(),
        ...loadLocalExtractModeConfig(), ...(opts.config || {})
    };
    // 〔OCR 為主〕矛盾設定（拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr、OCR_ENGINE=none）在建立 runner 時就丟錯：
    // server.js 的 startInlineRunner 與 node workers/jobRunner.js 都在啟動時停下、印出要改哪一行，不會等到上傳才失敗。
    // 〔Owner 第五輪 D-3〕預設改成 ocr 之後，只寫 OCR_ENGINE=none 也會撞到；explicit 讓訊息講清楚「沒寫＝預設 ocr、要看圖就明寫 cross」
    // LOCAL_EXTRACT_MODE 是不是明寫的：opts.config 給了就算（測試、嵌入式呼叫），否則看 process.env（正式啟動）
    const localExtractModeExplicit = Boolean(opts.config && 'localExtractMode' in opts.config)
        || require('../config/localExtractMode').isLocalExtractModeExplicit();
    require('../config/localExtractMode').assertLocalExtractConfig({
        localExtract: config.localExtract === true, mode: config.localExtractMode, ocrEngine: config.ocrEngine,
        explicit: localExtractModeExplicit
    });
    if (!Number.isFinite(config.renewIntervalMs) || config.renewIntervalMs <= 0) {
        config.renewIntervalMs = renewIntervalFor(config.leaseMs);
    }
    const logger = opts.logger || makeLogger();
    const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const estimateCost = opts.estimateCost || estimateCostFromPricing;
    // 〔stage5 WS-C〕延遲 require：旗標關閉時連 kcTagService 都不載入
    const kcTagger = opts.kcTagger
        || ((questionId) => require('../services/kcTagService').tagQuestion(questionId, { db, llm, logger }));

    const agentCache = new Map();
    // 在途的工作單位。成員是每次 spawn 各自一個的 token（'jq:12#7'），不是列 id：
    // 同一列可能在前一個單位收尾時就被下一輪認領（前一個單位寫回狀態時已放掉租約），
    // 以列 id 當鍵會讓兩個單位疊成一個，先結束的那個一 delete，inFlight 就少算一個——
    // tick 以為有空槽而多認領，drain 也會在還有單位在跑時以為已經閒下來（整合階段查到的偶發失敗）。
    const inFlight = new Set();
    let spawnSeq = 0;
    let timer = null;
    let ticking = false;
    let dailyWarned = false;
    // 〔審查 2026-09-26〕ocr 模式的前置條件（migration 0019）：通過一次就不再查；沒通過時只印一次錯
    let ocrSchemaPending = config.localExtract === true && config.localExtractMode === 'ocr';
    let ocrSchemaWarned = false;
    // 〔Owner 第五輪 C-f〕0020（output_truncated）：接受過一次就不再查；沒套時只印一次
    let truncatedSchemaOk = false;
    let truncatedSchemaWarned = false;
    // 〔dec/r8-b1-abandon〕放棄在途工作（shutdown({ abandon: true })）
    let abandoning = false;
    /** 〔審查 dec/r8-b1-abandon-fix〕呼叫過 shutdown（不論有沒有 abandon）：tick 不再認領，正在認領的那一列不開始、放掉租約 */
    let closing = false;
    /** 〔審查 dec/r8-b1-abandon-fix〕正在跑的那一輪 tick（結束時 resolve）；shutdown 要先等它，見 returnClaim */
    let currentTick = null;
    /** 執行中、可以中止的節點（invokeNode 登記；save 一旦開始就不在這裡） */
    const activeNodes = new Set();
    /**
     * 〔審查 dec/r8-b1-abandon-fix〕正在退避睡眠的喚醒函式（pause 登記、睡完自己移除）；放棄時逐一叫醒。
     * 原本是讓每次退避 race 一個 runner 存活期間都在的 promise，沒有 shutdown 時那個 promise 永遠不 settle，
     * 每次退避都在它身上多掛一個 reaction、永遠不釋放。
     */
    const pauseWakers = new Set();
    /** inFlight 歸零時要叫醒的人（shutdown 等在途工作單位收尾） */
    const idleWaiters = new Set();
    const abandonStats = { units: 0, released: 0, kept: 0 };

    // ── agent 載入 ────────────────────────────────────────────
    function loadAgent(node) {
        if (agentCache.has(node)) return agentCache.get(node);
        for (const name of [node, AGENT_MODULE_FOR_NODE[node]]) {
            if (!name) continue;
            const file = path.resolve(agentsDir, `${name}.js`);
            if (!fs.existsSync(file)) continue;
            const mod = require(file);
            if (typeof mod.run !== 'function') {
                throw new Error(`agent ${file} 沒有匯出 run(ctx, input)`);
            }
            agentCache.set(node, mod);
            return mod;
        }
        throw new Error(`找不到節點 ${node} 的 agent（找過 ${agentsDir} 下的 ${node}.js 與 ${AGENT_MODULE_FOR_NODE[node]}.js）`);
    }

    // ── 用量計量：把 ctx.llm 包一層，runner 才知道這個節點實際花了多少 ──
    function meteredLlm(meter) {
        return {
            async generateJson(args = {}) {
                // 〔Owner 第五輪 C-f〕失敗時也要知道叫的是哪一支模型（本機被截斷的不重試）；meter.model 只在成功後才寫，不動它
                meter.lastModel = args.model || null;
                // 〔Owner 第七輪 R7-1；審查 dec/r10-variant-cap〕變式被截斷時事件要記「輸出上限多少」：
                // 記下這一次呼叫實際送出的 num_predict（services/llm 掛在錯誤物件上；不依 env 重算），原本的錯照樣丟給 agent
                meter.lastNumPredict = null;
                let res;
                try {
                    res = await llm.generateJson(args);
                } catch (err) {
                    meter.lastNumPredict = appliedNumPredictOf(err);
                    throw err;
                }
                const u = res?.usage || {};
                meter.model = args.model || meter.model;
                meter.tokenIn += u.tokenIn ?? 0;
                meter.tokenOut += u.tokenOut ?? 0;
                meter.tokenThinking += u.tokenThinking ?? 0;
                meter.tokenCached += u.tokenCached ?? 0;
                meter.calls += 1;
                // 裁決 S2-4：走過「schema 不含 enum + prompt 列舉」退路的呼叫要留痕。
                // 由 runner 直接從 generateJson 的回傳讀，不倚賴 agent 有沒有轉手記下來。
                if (res?.schemaFallback === true) meter.schemaFallback = true;
                if (res?.raw?.usageMetadata) meter.usageMetadata.push(res.raw.usageMetadata);
                return res;
            },
            async embed(args = {}) {
                const res = await llm.embed(args);
                meter.tokenIn += res?.usage?.tokenIn ?? 0;
                meter.calls += 1;
                return res;
            }
        };
    }

    function newMeter() {
        return {
            model: null, tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0,
            calls: 0, usageMetadata: [], schemaFallback: false,
            lastModel: null,   // 〔Owner 第五輪 C-f〕
            lastNumPredict: null   // 〔Owner 第七輪 R7-1；審查 dec/r10-variant-cap〕
        };
    }

    /** 用 config/pricing.js 估價；WS-B 還沒合入時記 0 且 cost_estimated=false（第 5.5 條）。 */
    function estimateCostFromPricing(meter) {
        if (!meter.model || meter.calls === 0) return { cost_usd: 0, cost_estimated: false };
        try {
            const pricing = require('../config/pricing');
            if (typeof pricing.estimateCost === 'function') {
                // 〔本機模式整合〕'ollama:qwen3:8b' 的 id 是 'qwen3:8b'，不能取最後一段；Gemini 的結果不變
                let modelId;
                try { modelId = require('../config/models').parseModel(String(meter.model)).id; } catch (_) { modelId = String(meter.model); }
                const r = pricing.estimateCost({
                    modelId, tokenIn: meter.tokenIn, tokenOut: meter.tokenOut,
                    tokenThinking: meter.tokenThinking, tokenCached: meter.tokenCached
                });
                return { cost_usd: Number(r?.cost_usd ?? 0), cost_estimated: Boolean(r?.cost_estimated) };
            }
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw err;
        }
        return { cost_usd: 0, cost_estimated: false };
    }

    // ── job_events / 成本結算 ────────────────────────────────
    /** @param {{query:Function}} [executor] 預設 db；〔DA-13〕拆題的檢查點、變式的 pass 事件傳交易的 client（與建題目列同一個交易） */
    async function writeEvent(row, executor = db) {
        await executor.query(
            `INSERT INTO job_events
                (job_id, jq_id, node, attempt, model, token_in, token_out, token_thinking, token_cached,
                 cost_usd, cost_estimated, latency_ms, outcome, error_class, detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
            [row.job_id, row.jq_id ?? null, row.node, row.attempt, row.model ?? null,
            row.token_in ?? null, row.token_out ?? null, row.token_thinking ?? null, row.token_cached ?? null,
            row.cost_usd ?? null, row.cost_estimated ?? true, row.latency_ms, row.outcome,
                normalizeErrorClass(row.error_class), JSON.stringify(row.detail ?? {})]
        );
    }

    /** 把這一次呼叫的用量累加回 jobs（token_out 含 thinking，第 0.4 條）。 */
    async function chargeJob(jobId, meter, cost) {
        if (meter.calls === 0 && cost.cost_usd === 0) return;
        await db.query(
            `UPDATE jobs SET token_in = token_in + $2, token_out = token_out + $3,
                             cost_usd = cost_usd + $4, updated_at = now() WHERE id = $1`,
            [jobId, meter.tokenIn, meter.tokenOut + meter.tokenThinking, cost.cost_usd]
        );
    }

    /** 當日成本（第 7.3.4 條的全域止血）。 */
    async function dailySpentUsd() {
        const { rows } = await db.query(
            `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent FROM job_events
              WHERE created_at >= date_trunc('day', now())`
        );
        return Number(rows[0]?.spent ?? 0);
    }

    // ── 認領（第 7.1 條：同一交易兩句 + FOR UPDATE SKIP LOCKED + 租約）──
    /**
     * @returns {Promise<{id:number, lease:object}|null>}
     *          〔dec/r8-b1-abandon〕多回一個租約憑證（newLease）：放棄時只放掉自己的租約要用
     */
    async function claim(table, whereSql, params, extraSet = '') {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `SELECT id FROM ${table}
                  WHERE ${whereSql} AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, params);
            if (rows.length === 0) { await client.query('COMMIT'); return null; }
            const id = rows[0].id;
            const sent = { mono: monoNow(), wall: Date.now() };
            const upd = await client.query(
                `UPDATE ${table} SET locked_until = now() + ($1 || ' milliseconds')::interval,
                        updated_at = now()${extraSet} WHERE id = $2
                 RETURNING locked_until::text AS lease_until`,
                [String(config.leaseMs), id]);
            await client.query('COMMIT');
            const until = upd && Array.isArray(upd.rows) && upd.rows[0] ? upd.rows[0].lease_until : null;
            return { id, lease: newLease(table, id, until, sent) };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * 〔dec/r8-b1-abandon〕租約憑證：認領時寫進 locked_until 的值（原字串，含微秒與時區，比 JS 的 Date 精確），
     * 續租成功就換成新的值。放棄時用它放租約：UPDATE … WHERE id = $1 AND locked_until = <這個值>——
     * 別的後端（例如同時開著的網頁版）接手之後寫的值不同，所以清不到別人的租約。
     * okSentAt＝最後一次成功寫入（認領或續租）的送出時間（單調時鐘）；okSentWall＝同一刻的系統時間（〔審查 dec/r8-b1-abandon-fix〕
     * 單調時鐘可能不含系統睡眠，見檔頭與 leaseGapMs）。相鄰兩次成功寫入之間隔了超過一個租約長度，
     * 表示中間有一段租約可能已經到期、被別人認領，之後自己的續租（WHERE locked_until IS NOT NULL，不看是誰的）又把值蓋成自己的——
     * 這時憑證對得上也不能放（lost），留給租約到期。
     * @param {{mono:number, wall:number}|null} sent  送出認領那一句的時刻
     */
    function newLease(table, id, until, sent) {
        return {
            table, id, until: typeof until === 'string' && until ? until : null,
            okSentAt: sent ? sent.mono : null, okSentWall: sent ? sent.wall : null, lost: false, pending: null
        };
    }

    /** 續租回來了：記下新的值；兩次成功寫入之間隔太久就標成 lost（見 newLease、leaseGapMs） */
    function noteRenew(lease, res, sent) {
        const row = res && Array.isArray(res.rows) ? res.rows[0] : null;
        if (!row || typeof row.lease_until !== 'string' || !row.lease_until) return;   // 0 列：已經放掉了（或列不在）
        if (leaseGapMs(lease) >= config.leaseMs) lease.lost = true;
        lease.until = row.lease_until;
        lease.okSentAt = sent.mono;
        lease.okSentWall = sent.wall;
    }

    /**
     * 租約續期：呼叫進行中每 30 秒延一次，避免另一個槽重新認領仍在付費的列。
     * 只延「還鎖著」的列：工作單位寫回狀態時已放掉租約（locked_until = NULL），
     * 之後才觸發的續期（例如退避睡眠期間）不該把它重新鎖上——那一列會卡到租約過期才有人接手。
     * 〔本機模式 L2〕間隔改由 config.renewIntervalMs 決定（預設 renewIntervalFor(leaseMs)：租約 ≥ 90 秒時就是 30 秒，
     * 與原本相同）。本機模式的節點可以跑到四十五分鐘，靠的就是這裡一直續約，而不是把租約拉長。
     * 〔dec/r8-b1-abandon〕有租約憑證（由 tick 認領的工作單位）時：續租多回傳新的值、記進憑證；上一次續租還沒回來就不疊一次
     * （放租約之前要先等它回來，值才對得上）。回傳的 stop() 可以重複呼叫。
     */
    function startRenew(table, id, lease = null) {
        const h = setInterval(() => {
            if (lease && lease.pending) return;
            const sent = { mono: monoNow(), wall: Date.now() };
            const p = db.query(`UPDATE ${table} SET locked_until = now() + ($1 || ' milliseconds')::interval
                       WHERE id = $2 AND locked_until IS NOT NULL
                       RETURNING locked_until::text AS lease_until`,
                [String(config.leaseMs), id])
                .then(res => { if (lease) noteRenew(lease, res, sent); })
                .catch(err => logger.warn({ msg: '續租失敗', table, id, error: err.message }));
            if (lease) {
                lease.pending = p;
                p.finally(() => { if (lease.pending === p) lease.pending = null; });
            }
        }, config.renewIntervalMs);
        if (typeof h.unref === 'function') h.unref();
        return () => clearInterval(h);
    }

    /**
     * 〔dec/r8-b1-abandon〕放掉自己的租約（只清值等於憑證的那一列）。先停續租、等在途的續租回來，值才對得上。
     * 沒有憑證（直接呼叫 runJobQuestion 等、不是由 tick 認領的）或憑證已 lost → 不放，留給租約到期。
     * @returns {Promise<'released'|'no-lease'|'lost'|'not-ours'|'error'>}
     */
    async function releaseOwnLease(lease, stopRenew) {
        if (typeof stopRenew === 'function') stopRenew();
        if (!lease || !lease.until) return 'no-lease';
        if (lease.pending) await lease.pending.catch(() => { });
        if (lease.lost) return 'lost';
        try {
            const res = await db.query(
                `UPDATE ${lease.table} SET locked_until = NULL WHERE id = $1 AND locked_until = $2::timestamptz`,
                [lease.id, lease.until]);
            return res && res.rowCount > 0 ? 'released' : 'not-ours';
        } catch (err) {
            logger.warn({ msg: '放棄時放租約失敗（留給租約到期）', table: lease.table, id: lease.id, error: err.message });
            return 'error';
        }
    }

    /**
     * 〔dec/r8-b1-abandon〕工作單位被放棄了：只放掉自己的租約、記一行 log，不寫任何結果（呼叫的人接著 return）。
     * @param {object|null} lease
     * @param {Function} stopRenew
     * @param {object} info  記進 log 的欄位（unit、job_id、jq_id、node、chunk、idx…）
     */
    async function abandonUnit(lease, stopRenew, info) {
        const r = await releaseOwnLease(lease, stopRenew);
        abandonStats.units += 1;
        if (r === 'released') abandonStats.released += 1; else abandonStats.kept += 1;
        const why = {
            released: '已放掉自己的租約，下次開啟立刻重新認領',
            'no-lease': '不是由 runner 認領的（沒有租約憑證），租約留給它自己到期',
            lost: '續租曾經中斷超過一個租約長度（可能已被別的後端接手），租約不放、留給它自己到期',
            'not-ours': '租約已經不是自己寫的那一個（被別的後端接手或已放掉），不動',
            error: '放租約時資料庫出錯，留給租約到期'
        }[r];
        logger.warn({ msg: `放棄在途工作：不寫結果、不動重試次數；${why}`, lease: r, ...info });
    }

    /**
     * 〔審查 dec/r8-b1-abandon-fix〕被放棄的節點裡，放棄之前就已經回來的模型呼叫照記進 jobs（token_in／token_out／cost_usd），
     * 所以 jobs.cost_usd 與每份 job 的預算是準的。**不寫 job_events**（一列事件＝一次嘗試，寫了會被當成 attempt、也會被當成檢查點），
     * 所以每日預算（DAILY_COST_BUDGET_USD，加總 job_events）不含這一段；被中止的那一次呼叫本身沒有回來，無從記起
     * （Gemini 那一次可能已經計費）。本機模式成本是 0，只多記 token。
     * @param {number} jobId
     * @param {{meter?:object}} res  invokeNode 回的 { abandoned: true, meter }（meter 是放棄那一刻的快照）
     */
    async function chargeAbandoned(jobId, res) {
        const m = res && res.meter;
        if (!m || !(m.calls > 0)) return;
        try {
            await chargeJob(jobId, m, estimateCost(m));
        } catch (err) {
            logger.warn({ msg: '放棄時記用量失敗（jobs 少記這個節點放棄前已完成的呼叫）', job_id: jobId, error: err.message });
        }
    }

    /**
     * 〔審查 dec/r8-b1-abandon-fix〕shutdown 開始時 tick 正卡在 claim 的交易裡：認領回來的這一列不開始（不 spawn），
     * 用這一次拿到的租約憑證把租約放掉——什麼都還沒做（狀態、重試次數、事件都沒動），下次開啟立刻重新認領。
     * 拆題／變式的 job 在認領時已被改成 extracting（claim 的 extraSet），與當機後的樣子相同，下次照樣認領得到。
     * 原本這一列會被 spawn，呼叫 shutdown 的人卻已經看到在途 0 件、關掉連線池，那一列就要等租約到期。
     * @param {{id:number, lease:object}} c  claim 的回傳值
     * @param {string} unit
     */
    async function returnClaim(c, unit) {
        const r = await releaseOwnLease(c.lease, null);
        logger.warn({
            msg: `關閉中：剛認領到的工作不開始；${r === 'released' ? '已放掉租約，下次開啟立刻重新認領' : '租約留給它自己到期'}`,
            node: 'claim', unit, id: c.id, lease: r
        });
    }

    /**
     * 〔dec/r8-b1-abandon〕退避睡眠：放棄時馬上醒來（不再重試）。沒有放棄時就是 sleep(ms)。
     * 〔審查 dec/r8-b1-abandon-fix〕每次自己登記一個喚醒函式、睡完（或被叫醒）就移除，不留任何東西在 runner 上。
     */
    function pause(ms) {
        if (abandoning) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let woke = false;
            const settle = (fn, arg) => {
                if (woke) return;
                woke = true;
                pauseWakers.delete(wake);
                fn(arg);
            };
            const wake = () => settle(resolve);
            pauseWakers.add(wake);
            // sleep 失敗（只有測試注入的 sleep 會）照舊往上丟，與 sleep(ms) 相同
            let slept;
            try { slept = Promise.resolve(sleep(ms)); } catch (err) { slept = Promise.reject(err); }
            slept.then(wake, err => settle(reject, err));
        });
    }

    // ── 跑一個節點：逾時、計量、事件、狀態機 ──────────────────
    /**
     * @returns {{outcome, meter, cost, latencyMs, abandoned?:true}}
     *          〔dec/r8-b1-abandon〕abandoned＝這個節點是被 shutdown({ abandon: true }) 中止的（或放棄之後才要開始）：
     *          outcome 是 null，呼叫的人**不得**寫事件、動重試次數，只放租約。
     *          〔審查 dec/r8-b1-abandon-fix〕meter 是放棄那一刻的快照、cost 是 null：放棄之前已經回來的呼叫由呼叫的人用
     *          chargeAbandoned 記進 jobs（不寫事件）。
     */
    async function invokeNode(node, ctxBase, input) {
        const controller = new AbortController();
        const meter = newMeter();
        const startedAt = Date.now();
        let timeoutHandle = null;

        // 〔dec/r8-b1-abandon〕已經在放棄了：新的節點不開始（save 也一樣：還沒開始就不開始）
        if (abandoning) {
            return { outcome: null, meter, cost: { cost_usd: 0, cost_estimated: false }, latencyMs: 0, abandoned: true };
        }
        // 放棄時由 shutdown() 呼叫 entry.abandon()：先記下「這一次是被放棄的」，再 abort（agent 與 OCR 子行程照 signal 停下），
        // 最後讓下面的 race 立刻結束（agent 不理 signal 也不必等它）。save 不登記：一旦開始就讓它做完（見檔頭）。
        let abandonedHere = false;
        let entry = null;
        const abandonRace = node === 'save' ? null : new Promise(resolve => {
            entry = {
                node,
                abandon() {
                    if (abandonedHere) return;
                    abandonedHere = true;
                    try { controller.abort(ABANDON_REASON); } catch (_) { /* 忽略 */ }
                    resolve(null);
                }
            };
            activeNodes.add(entry);
        });

        const ctx = {
            ...ctxBase,
            llm: meteredLlm(meter),
            signal: controller.signal,
            config: {
                models: ctxBase.models,
                limits: ctxBase.limits,
                thresholds: {
                    classifyMinConf: config.classifyMinConf,
                    dedupDup: config.dedupDup,
                    dedupVariant: config.dedupVariant,
                    pdfChunkPages: config.pdfChunkPages,
                    inlineMaxBytes: config.inlineMaxBytes,
                    nodeTimeoutMs: config.nodeTimeoutMs,
                    // 階段 3（第 4.5 條 + 裁決 S3-R9）：generateVariant 的兩道閘門與 classify 的 kNN 短路。
                    // 跑題閾值走 variantOfftopicSimMin；檢索下限（variantRetrieveSimMin）不進 ctx——
                    // 那是 services/variantService.js 的事，agent 用不到。
                    variantOfftopicSimMin: config.variantOfftopicSimMin,
                    variantMinEdit: config.variantMinEdit,
                    knnVoteSim: config.knnVoteSim
                },
                // 裁決 S2-8（第 3.1 條）：agent 不得自己讀 process.env，旗標只能從這裡拿。
                // 鍵名是小寫短名 similar／pipeline，值即時由 config/features.js 讀取。
                features: readFeatures(),
                // 〔修訂 2026-09-15f〕source_check 節點的模式（SOURCE_CHECK_MODE，預設 enforce）
                sourceCheck: { mode: config.sourceCheckMode },
                // 〔本機模式 L2〕本機拆題要不要跑 PaddleOCR（OCR_ENGINE，預設 paddle）。其餘 OCR 設定
                // （OCR_PYTHON／OCR_DPI／OCR_TIMEOUT_MS）由 services/ocr 自己讀，與 services/llm 讀 LLM_MODE 同一個分工。
                ocr: { engine: config.ocrEngine },
                // 〔OCR 為主 2026-09-26〕本機拆題的模式（LOCAL_EXTRACT_MODE：cross｜ocr）；ocr 的形狀不動，另開一個鍵
                localExtract: { mode: config.localExtractMode }
            }
        };
        delete ctx.models; delete ctx.limits;

        let outcome;
        try {
            const timeout = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    controller.abort();
                    reject(Object.assign(new Error(`節點 ${node} 超過 ${config.nodeTimeoutMs} ms 未回應`), { errorClass: 'timeout' }));
                }, config.nodeTimeoutMs);
                if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
            });
            const run = node === 'save' ? saveNode(ctx, input) : loadAgent(node).run(ctx, input);
            outcome = await Promise.race(abandonRace ? [run, timeout, abandonRace] : [run, timeout]);
            if (!abandonedHere && (!outcome || typeof outcome.kind !== 'string')) {
                outcome = { kind: 'error', errorClass: 'provider_error', message: `節點 ${node} 回傳的不是合法 outcome` };
            }
        } catch (err) {
            // agent 合約寫「不得 throw」，真的丟了就由這裡分類（第 3.1 條）
            outcome = { kind: 'error', errorClass: classifyError(err), message: err.message };
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (entry) activeNodes.delete(entry);
        }

        // 〔dec/r8-b1-abandon〕被放棄的節點：不論 agent 回了什麼（被 abort 的 agent 常回 timeout／provider_error），一律不算結果
        // 〔審查 dec/r8-b1-abandon-fix〕meter 取放棄那一刻的快照：放棄之前已經回來的呼叫由呼叫的人記進 jobs（chargeAbandoned）；
        // agent 若不理 signal、之後還在背景叫模型，那些不算進來（這個工作單位已經收尾了）。cost 由 chargeAbandoned 從 meter 估。
        if (abandonedHere) {
            const snapshot = { ...meter, usageMetadata: [...meter.usageMetadata] };
            return { outcome: null, meter: snapshot, cost: null, latencyMs: Date.now() - startedAt, abandoned: true };
        }
        return { outcome, meter, cost: estimateCost(meter), latencyMs: Date.now() - startedAt };
    }

    function classifyError(err) {
        if (err?.errorClass && ERROR_CLASSES.has(err.errorClass)) return err.errorClass;
        if (err?.name === 'AbortError') return 'timeout';
        const msg = String(err?.message || '');
        if (/\b429\b|rate.?limit|quota/i.test(msg)) return 'rate_limited';
        if (/timeout|timed out|abort/i.test(msg)) return 'timeout';
        return 'provider_error';
    }

    // ── save 節點（第 3.3 條最後一列；裁決 S2-7：歸 runner，不在 agents/）──
    //    理由（§12）：它要開交易、寫 job_events、回填 question_id，
    //    這三件事第 3.1 條都明文排除在 agent 合約之外。job_events.node 仍寫 'save'。
    /**
     * 最後一道閘門 + 入庫。validateQuestionFields 與 INSERT 在同一個交易裡，
     * 因此不會出現「questions 有了、job_questions.question_id 還是 NULL」的中間狀態。
     */
    async function saveNode(ctx, input) {
        const { validateQuestionFields } = require('../utils/questionValidation');
        const fields = buildSaveFields(input);
        const v = validateQuestionFields(fields);
        if (!v.ok) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: v.errors.join('；'), data: { errors: v.errors } };
        }

        const textHash = input?.dedup0?.text_hash ?? null;
        // 附圖路徑（docs/figures.md）：validateQuestionFields 只認六個欄位，question_img
        // 不進閘門、與 approve 的 body.question_img 同一種待遇（reviewController 第 6.6 條）。
        const questionImg = typeof input?.extract?.figure_img === 'string' && input.extract.figure_img
            ? input.extract.figure_img : null;
        // 階段 3（第 4.7、5.2 條）：三個欄位改由 job.kind 與 payload.classify.source 決定。
        // kind='pdf' 的路徑逐位元不變（origin='pdf'；classify 沒短路時 chapter_src 仍是 'ai'）。
        const origin = ctx?.job?.kind === 'variant' ? 'variant' : 'pdf';
        const variantOf = ctx?.job?.kind === 'variant' ? (input?.extract?.variant_of_root ?? null) : null;
        const chapterSrc = chapterSrcFor(input);
        // 題源標記（0006）：上傳時標在 job 上，入庫沿用；變式 job 建立時已複製藍本的標記
        // 來源註記（0007）：同路徑沿用；變式 job 沒有註記（不繼承藍本——改寫後不是原卷的題）
        const sourceType = ctx?.job?.source_type ?? 'unknown';
        const sourceDetail = ctx?.job?.source_detail ?? null;
        // 〔stage5 WS-A〕文字詳解：verify 判定一致且 steps_summary 非空才寫（buildSolutionFields）
        const solution = buildSolutionFields(input);
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            // 新題的 keywords／concept_summary 一定是 NULL，所以 search_tsv 的三段 token
            // 直接由驗證過的欄位算得出來，可以與 INSERT 併成同一句（與 questionController 同一套規則）。
            const { buildTsvTokens } = require('../services/embedService');
            const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens({ ...v.value, keywords: null, concept_summary: null });

            const { rows } = await client.query(
                `INSERT INTO questions
                    (subject, chapter, question_type, difficulty, question_text, question_img, answer_text,
                     origin, chapter_src, variant_of, text_hash, source_type, source_detail, search_tsv,
                     solution_text, solution_src)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                         setweight(to_tsvector('simple', array_to_string($14::text[], ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($15::text[], ' ')), 'A')
                      || setweight(to_tsvector('simple', array_to_string($16::text[], ' ')), 'B'),
                         $17, $18)
                 RETURNING id`,
                [v.value.subject, v.value.chapter, v.value.question_type, v.value.difficulty,
                v.value.question_text, questionImg, v.value.answer_text || '略', origin, chapterSrc, variantOf, textHash,
                    sourceType, sourceDetail, chapterTokens, keywordTokens, stemTokens,
                    solution.solution_text, solution.solution_src]);

            const questionId = rows[0].id;
            await client.query('UPDATE job_questions SET question_id = $2 WHERE id = $1', [ctx.jq.id, questionId]);
            await client.query('COMMIT');

            scheduleEmbed(questionId, ctx.logger);
            // 〔stage5 WS-C〕save 成功（已 COMMIT）之後的唯一掛鉤：FEATURE_KC_TAGGING 關閉時完全不呼叫；
            // 開啟時 fire-and-forget，失敗只記 log，不影響 job 狀態（interfaces-stage5.md 第 4.3 條第 3 點）。
            // save 是零成本節點、預算用盡仍會跑，標註卻要付錢：該 job 的預算或當日預算用盡就不標。
            runKcTagHook({
                questionId, enabled: require('../config/features').FEATURE_KC_TAGGING,
                tagger: kcTagger, logger: ctx.logger || logger,
                budgetCheck: async () => {
                    const jobLeft = ctx?.config?.limits?.budgetLeft;
                    if (typeof jobLeft === 'number' && jobLeft <= 0) return 'job_budget';
                    return (await dailySpentUsd()) >= config.dailyCostBudgetUsd ? 'daily_budget' : null;
                }
            });
            return {
                kind: 'pass',
                data: { question_id: questionId, text_hash: textHash, origin, chapter_src: chapterSrc, ...(variantOf !== null ? { variant_of: variantOf } : {}) }
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    }

    /** 入庫後補向量：fire-and-forget，失敗只記 log（第 3.3 條、interfaces-stage1.md 12.4）。 */
    function scheduleEmbed(questionId, log) {
        Promise.resolve()
            .then(() => require('../services/embedService').embedByIds([questionId]))
            .then(r => {
                if (r.failed.length > 0) {
                    log.warn({ msg: '向量待 backfill 補', question_id: questionId, error: String(r.failed[0].error).split('\n')[0] });
                }
            })
            .catch(err => log.warn({ msg: '向量寫入失敗（不影響入庫）', question_id: questionId, error: String(err.message).split('\n')[0] }));
    }

    // ── 節點 input（第 3.3 條逐節點）─────────────────────────
    /**
     * @param {string} node
     * @param {object} jq   認領回來的列，階段 3 多帶了 job 的 kind
     */
    function buildInput(node, jq) {
        const p = jq.payload || {};
        const ex = p.extract || {};
        switch (node) {
            case 'dedup0':
                return { question_text: ex.question_text };
            case 'classify':
                return {
                    subject: ex.subject, chapter: ex.chapter,
                    chapter_confidence: ex.chapter_confidence, question_text: ex.question_text,
                    ...(p.classify?.feedback ? { feedback: p.classify.feedback } : {})
                };
            case 'lint':
                return {
                    question_text: p.lint?.question_text ?? ex.question_text,
                    answer_text: p.lint?.answer_text ?? ex.answer_text,
                    ...(p.lint?.feedback ? { feedback: p.lint.feedback } : {})
                };
            case 'source_check':
                // 〔修訂 2026-09-15f〕比對用 lint 修正後的題幹（lint 的 LLM 重寫若改壞數字也抓得到）；
                // 不併 figure_desc——那是模型寫的描述，原卷上沒有這段文字。
                return {
                    question_text: p.lint?.question_text ?? ex.question_text,
                    source_text: ex.source_text ?? null,
                    has_figure: Boolean(ex.figure_desc || ex.figure_img || ex.figure_box)
                };
            case 'verify': {
                const fields = buildSaveFields(p);
                return {
                    question_text: fields.question_text,       // figure_desc 已併入題幹
                    question_type: ex.question_type,
                    claimed_answer: fields.answer_text          // 只給比對器，agent 不得放進 prompt
                };
            }
            case 'dedup1': {
                const fields = buildSaveFields(p);
                return {
                    question_id: null,
                    embed_text: fields.question_text,
                    subject: fields.subject,
                    chapter: fields.chapter,
                    // 裁決 S3-14：**選用**的第五個鍵，只有變式 job 會給。
                    // 沒給這個鍵時 agents/dedup.js 的行為與階段 2 逐位元相同（PDF job 不受影響）。
                    // 給了就排除藍本整個家族——不然新生的變式一定會撞到自己的藍本而被判 duplicate。
                    ...(jq.kind === 'variant' && Number.isInteger(ex.variant_of_root)
                        ? { exclude_family_root: ex.variant_of_root } : {})
                };
            }
            case 'save':
                return p;
            default:
                throw new Error(`buildInput：未知節點 ${node}`);
        }
    }

    // ── payload 的寫回規則（第 2.3 條規則 5：feedback 由 runner 寫）──
    function mergePayload(payload, node, outcome, stayed) {
        const next = { ...(payload || {}) };
        if (outcome.kind === 'pass') {
            next[node] = { ...(outcome.data || {}) };
        } else if (outcome.kind === 'skipped') {
            next[node] = { skipped: true, ...(outcome.data || {}) };
        } else if (outcome.kind === 'fail') {
            // 留在原狀態才需要 feedback（下一次的 prompt 要用）；進複核就只留判定結果
            next[node] = {
                ...(next[node] || {}), ...(outcome.data || {}),
                ...(stayed && outcome.feedback ? { feedback: outcome.feedback } : {})
            };
        }
        return next;
    }

    // ── 工作單位 B：推進一列 job_questions ────────────────────
    /**
     * @param {number} jqId
     * @param {object|null} [lease]  〔dec/r8-b1-abandon〕tick 認領時的租約憑證（claim）；直接呼叫（測試）時沒有
     */
    async function runJobQuestion(jqId, lease = null) {
        const stopRenew = startRenew('job_questions', jqId, lease);
        // 寫回狀態的那一句 UPDATE 已經順手放掉租約（locked_until = NULL）；從那一刻起這一列
        // 就可能被下一輪（或另一個 runner）認領。finally 若再無條件清一次，會把**別人剛拿到的**
        // 租約清掉，同一列於是被兩個單位同時推進（同一節點跑兩次、多一筆事件、多付一次錢）。
        // 所以只在「還沒寫回就結束」（提早 return 或例外）時才由 finally 放租約。
        let released = false;
        try {
            const { rows } = await db.query(
                `SELECT q.id, q.job_id, q.idx, q.state, q.payload, q.retries,
                        j.kind, j.pdf_sha256, j.source_type, j.source_detail, j.subject_group,
                        j.budget_usd::float8 AS budget_usd, j.cost_usd::float8 AS cost_usd
                   FROM job_questions q JOIN jobs j ON j.id = q.job_id
                  WHERE q.id = $1`, [jqId]);
            if (rows.length === 0) return;
            const jq = rows[0];
            if (!ADVANCEABLE_STATES.includes(jq.state)) return;   // 期間被人 approve／reject 了

            const node = NODE_FOR_STATE[jq.state];
            const budgetLeft = Number(jq.budget_usd) - Number(jq.cost_usd);
            // 第 4.6 條：變式 job 的 lint 重試上限由 VARIANT_LINT_RETRIES 覆寫，其餘節點不變。
            const limits = jq.kind === 'variant'
                ? {
                    ...DEFAULT_LIMITS,
                    maxRetries: { ...DEFAULT_LIMITS.maxRetries, lint: config.variantLintRetries },
                    budgetLeft
                }
                : { ...DEFAULT_LIMITS, budgetLeft };

            // ── 第 4.7 條：VARIANT_AUTO_APPROVE=false 的「政策停等」──
            // 全部閘門都過了（state='deduped'），但首輪不自動入庫：直接寫 needs_review
            // ('awaiting_approval')，**不經 transition()**。理由（裁決 S3-11）：transition 的四種
            // outcome 沒有一種能從 deduped 走到 needs_review 而不謊報失敗——fail 會讓
            // job_events.error_class 寫進一個不在九個合法值內的字串，撞 job_events_error_class_check。
            // 這是整條管線唯一一處不經 transition 的狀態變更，pipeline/stateMachine.js 一個字都沒改。
            // 〔本機模式 L2〕之後多了第二處：下方的 extract_disagree，同一個做法。
            if (node === 'save' && jq.kind === 'variant' && !config.variantAutoApprove) {
                await writeEvent({
                    job_id: jq.job_id, jq_id: jq.id, node: 'save', attempt: attemptNo(jq.retries, 'save'),
                    cost_usd: 0, cost_estimated: false, latency_ms: 0, outcome: 'skipped', error_class: null,
                    detail: { reason: 'awaiting_approval', auto_approve: false }
                });
                await db.query(
                    `UPDATE job_questions SET state = 'needs_review', review_reason = 'awaiting_approval',
                            locked_until = NULL, updated_at = now() WHERE id = $1`, [jq.id]);
                released = true;
                logger.info({
                    job_id: jq.job_id, jq_id: jq.id, node: 'save', attempt: attemptNo(jq.retries, 'save'),
                    outcome: 'skipped', latency_ms: 0, state: 'needs_review', review_reason: 'awaiting_approval'
                });
                await maybeFinishJob(jq.job_id);
                return;
            }

            // ── 〔本機模式 L2〕交叉驗證的政策停等（docs/local-mode.md 第 4 條第 4 點）──
            // 本機拆題的兩版（視覺模型／PaddleOCR）不一致、或只有一版拆到的題：前面的節點照常跑完
            // （更嚴重的原因會先把它送進複核），走到 save 時停在 needs_review('extract_disagree')，絕不自動入庫。
            // 與上面的 awaiting_approval 同一個做法：不經 transition()（四種 outcome 都無法不謊報失敗地走到
            // needs_review），error_class 寫 NULL。cross_check（含 alt_question_text）原樣留在 payload.extract 給複核頁。
            // 〔OCR 為主 2026-09-26〕只用 OCR 拆的題走同一條路，原因是 'ocr_only'（crossCheckStopReason）；
            // 附圖沒配到的提示（figure_hint）一併記進這一筆事件的 detail。〔審查 2026-09-26〕只有停在 ocr_only 的題會記：
            // 被前面的閘門先攔下的題，提示只在 job_questions.payload.extract.figure_hint。要逐題查就直接
            // SELECT detail->'figure_hint' FROM job_events WHERE node='save'（或查 payload）；整體的配圖數
            // （配到幾張、幾題有提示）看 npm run report:jobs 的「OCR 版面配圖」一節（讀 extract 事件的 cross_check.figures）。
            // 〔dec/r13-extract-fixes〕交叉驗證沒有停下來的題，答案是空的也停（answerMissingStopReason → awaiting_approval）
            const stop = node === 'save' ? saveStopReason(jq.payload) : null;
            const disagree = stop ? stop.reason : null;
            if (disagree) {
                const cc = jq.payload.extract.cross_check;
                const brief = cc && typeof cc === 'object'
                    ? { status: cc.status ?? null, similarity: cc.similarity ?? null, picked: cc.picked ?? null }
                    : { status: null };
                const figureHint = disagree === 'ocr_only' ? jq.payload.extract.figure_hint : undefined;
                const v = jq.payload.verify;
                const noAnswer = stop.kind === 'no_answer'
                    ? { no_answer: true, ...(v && typeof v.suggested_answer === 'string' ? { suggested_answer: v.suggested_answer } : {}) }
                    // 〔審查 dec/r13-extract-fixes〕解答頁回填的答案與驗算的建議答案對不上（或沒得比）
                    : stop.kind === 'answer_key_unverified' ? { answer_key_check: stop.check }
                    : {};
                await writeEvent({
                    job_id: jq.job_id, jq_id: jq.id, node: 'save', attempt: attemptNo(jq.retries, 'save'),
                    cost_usd: 0, cost_estimated: false, latency_ms: 0, outcome: 'skipped', error_class: null,
                    detail: { reason: disagree, cross_check: brief, review_reason: disagree, ...(figureHint ? { figure_hint: figureHint } : {}), ...noAnswer }
                });
                await db.query(
                    `UPDATE job_questions SET state = 'needs_review', review_reason = $2,
                            locked_until = NULL, updated_at = now() WHERE id = $1`, [jq.id, disagree]);
                released = true;
                logger.info({
                    job_id: jq.job_id, jq_id: jq.id, node: 'save', attempt: attemptNo(jq.retries, 'save'),
                    outcome: 'skipped', latency_ms: 0, state: 'needs_review', review_reason: disagree
                });
                // 到了終態：承上題綁定與 job 收尾照一般路徑做（PDF job 才會走到這裡）
                await linkFollowUps(jq.job_id);
                await maybeFinishJob(jq.job_id);
                return;
            }

            let outcome, meter = newMeter(), cost = { cost_usd: 0, cost_estimated: false }, latencyMs = 0;

            if (budgetLeft <= 0 && !FREE_NODES.has(node)) {
                // 第 7.3.2 條：呼叫「前」就檢查，錢不夠連叫都不叫。
                // 狀態機的規則 3 會把它變成 needs_review('budget_exceeded')。
                // 零成本節點不進這一支：照常跑一次，fail 的原因由狀態機保留（規則 3 的 FREE_NODES 例外）；
                // error 仍被規則 3 收成 budget_exceeded、不退避重跑（dedup1 重跑會再叫一次 embedding）。
                outcome = { kind: 'fail', reason: 'budget_exceeded' };
                logger.warn({ msg: '預算用盡，跳過呼叫', job_id: jq.job_id, jq_id: jq.id, node, budget_left: budgetLeft });
            } else {
                const ctxBase = {
                    db,
                    // 第 4.5 條：ctx.job 加 kind 與 pdf_sha256（classify 的同 PDF 排除要用），兩個都是附加
                    job: {
                        id: jq.job_id, kind: jq.kind, pdf_sha256: jq.pdf_sha256 ?? null,
                        source_type: jq.source_type ?? null, source_detail: jq.source_detail ?? null,
                        // 〔stage5 WS-B〕上傳時的卷別（agents/promptParts.js 的 resolveSubjectGroup 讀它；附加鍵）
                        subject_group: jq.subject_group ?? 'math_physics',
                        budget_usd: Number(jq.budget_usd), cost_usd: Number(jq.cost_usd)
                    },
                    jq: { id: jq.id, idx: jq.idx, payload: jq.payload, retries: jq.retries },
                    logger, models: loadModels(), limits
                };
                const res = await invokeNode(node, ctxBase, buildInput(node, jq));
                if (res.abandoned) {
                    // 〔dec/r8-b1-abandon〕不經 transition（retries 不變）、不寫事件、不寫回狀態：這一列停在原狀態，
                    // 只放掉自己的租約，下次開啟從這個節點重跑
                    // 〔審查 dec/r8-b1-abandon-fix〕放棄之前已經回來的呼叫照記進 jobs（不寫事件）；被中止的那一次沒回來、不記
                    await chargeAbandoned(jq.job_id, res);
                    await abandonUnit(lease, stopRenew, { unit: 'job_question', job_id: jq.job_id, jq_id: jq.id, node, state: jq.state });
                    released = true;
                    return;
                }
                ({ outcome, meter, cost, latencyMs } = res);
                await chargeJob(jq.job_id, meter, cost);
            }

            // 〔Owner 第五輪 C-f〕本機模型的回應被截斷：不重試、直接進複核（Gemini 照舊重試）
            const localTruncation = isLocalTruncation(outcome, meter.lastModel);
            // 〔dec/r13-extract-fixes，Owner 2026-10-02 同意〕本機模型的 lint／verify 逾時：不重試、直接進複核（provider_error；Gemini 照舊重試）
            const localTimeout = isLocalTimeout(node, outcome, meter.lastModel);
            let next = transition({
                state: jq.state, retries: jq.retries, outcome,
                limits: localTruncation ? { ...limits, retryTruncated: false }
                    : localTimeout ? { ...limits, retryTimeout: false } : limits
            });
            if (next.review_reason === 'output_truncated') {
                let accepted = truncatedSchemaOk;
                if (!accepted) {
                    try { accepted = await outputTruncatedAccepted(db); } catch (_) { accepted = false; }
                    truncatedSchemaOk = accepted;
                }
                if (!accepted) {
                    // 還沒套 0020：退回原本會用的原因，不撞 CHECK（撞了會放掉租約、下一輪又認領同一列）
                    next = { ...next, review_reason: REVIEW_REASON_FOR_ERROR(outcome.errorClass) };
                    if (!truncatedSchemaWarned) {
                        logger.error({ msg: OUTPUT_TRUNCATED_SCHEMA_MESSAGE, node, job_id: jq.job_id, jq_id: jq.id });
                        truncatedSchemaWarned = true;
                    }
                }
            }
            const stayed = next.state === jq.state;
            const payload = mergePayload(jq.payload, node, outcome, stayed);
            // 〔dec/r13-extract-fixes〕本機逾時不重試：error 路徑本來不寫 payload，這裡記一個旗標給複核頁的說明句用
            if (localTimeout) payload[node] = { ...(payload[node] || {}), timed_out: true };

            await writeEvent({
                job_id: jq.job_id, jq_id: jq.id, node, attempt: attemptNo(jq.retries, node),
                model: meter.calls > 0 ? meter.model : null,
                token_in: meter.calls > 0 ? meter.tokenIn : null,
                token_out: meter.calls > 0 ? meter.tokenOut : null,
                token_thinking: meter.calls > 0 ? meter.tokenThinking : null,
                token_cached: meter.calls > 0 ? meter.tokenCached : null,
                cost_usd: cost.cost_usd, cost_estimated: cost.cost_estimated, latency_ms: latencyMs,
                outcome: outcome.kind === 'skipped' ? 'skipped' : outcome.kind,
                error_class: outcome.kind === 'fail' ? outcome.reason
                    : outcome.kind === 'error' ? outcome.errorClass : null,
                detail: {
                    ...(outcome.kind === 'fail' ? { reason: outcome.reason, feedback: outcome.feedback } : {}),
                    ...(outcome.kind === 'error' ? { message: outcome.message } : {}),
                    // 〔Owner 第五輪 C-f〕本機模型（ollama）的 error 記下 finish_reason（有才記）。只限本機：
                    // Gemini 的 schema_invalid 也帶 finishReason（services/llm/gemini.js），但 Gemini 路徑的事件照舊不多這一欄。
                    ...(outcome.kind === 'error' && outcome.finishReason && isLocalModelSpec(meter.lastModel)
                        ? { finish_reason: outcome.finishReason } : {}),
                    // 〔dec/r13-extract-fixes〕本機逾時不重試：事件記一筆說明（npm run report:jobs 的錯誤類別照舊算在 timeout）
                    ...(localTimeout ? { timeout_no_retry: true, note: LOCAL_TIMEOUT_NOTE } : {}),
                    ...(meter.usageMetadata.length > 0 ? { usage_metadata: meter.usageMetadata } : {}),
                    ...(schemaFallbackOf(meter, outcome) ? { schema_fallback: true } : {}),
                    // 階段 3 第 5.2 條：classify 是哪一層決定的（'gate'／'llm'／'knn'）要進事件，
                    // 「短路率與短路正確率」才報得出來。只加一個鍵，其餘欄位不動。
                    ...(node === 'classify' && outcome.data?.source ? { source: outcome.data.source } : {}),
                    review_reason: next.review_reason
                }
            });

            // 〔dec/r13-extract-fixes〕這個節點跑的期間，拆題可能剛好把解答頁的答案回填進這一列（applyAnswerKey 直接改資料庫裡的
            // payload.extract）。寫回的 payload 是開跑前讀的那一份，直接蓋掉會把回填弄丟：資料庫裡有 answer_src 而這一份沒有時，
            // 把 extract 的 answer_text／answer_src 從資料庫那一份帶過來（其餘照舊以這一份為準）。
            await db.query(
                `UPDATE job_questions SET state = $2, retries = $3::jsonb, review_reason = $4,
                        payload = CASE
                            WHEN (job_questions.payload->'extract') ? 'answer_src' AND NOT (($5::jsonb)->'extract') ? 'answer_src'
                            THEN jsonb_set(jsonb_set($5::jsonb, '{extract,answer_text}', job_questions.payload->'extract'->'answer_text'),
                                           '{extract,answer_src}', job_questions.payload->'extract'->'answer_src')
                            ELSE $5::jsonb END,
                        locked_until = NULL, updated_at = now() WHERE id = $1`,
                [jq.id, next.state, JSON.stringify(next.retries), next.review_reason, JSON.stringify(payload)]);
            released = true;

            logger.info({
                job_id: jq.job_id, jq_id: jq.id, node, attempt: attemptNo(jq.retries, node),
                outcome: outcome.kind, latency_ms: latencyMs, state: next.state, review_reason: next.review_reason
            });

            // error 的退避睡眠：狀態機只負責計數（第 2.3 條規則 6）
            // 〔dec/r8-b1-abandon〕放棄時馬上醒來（pause）；狀態已寫回、租約已放掉，這裡只是晚一點空出槽位
            if (outcome.kind === 'error' && stayed) {
                await pause(backoffMs((jq.retries?.[`${node}:error`] ?? 0)));
            }

            if (TERMINAL_STATES.includes(next.state)) {
                // 承上題綁定（DEC-012／FR-019）：任何一列到終態就對整個 job 重算一次。
                // 不是新節點、不經 transition()——綁定是衍生資料，失敗只 warn，不影響狀態推進
                // （與 scheduleEmbed 同一個原則；下一列到終態或回填腳本會再算一次）。
                // 變式政策停等分支（上方 awaiting_approval）刻意不掛：變式 job 沒有「上一題」。
                await linkFollowUps(jq.job_id);
                await maybeFinishJob(jq.job_id);
            }
        } finally {
            stopRenew();
            if (!released) {
                await db.query('UPDATE job_questions SET locked_until = NULL WHERE id = $1', [jqId]).catch(() => { });
            }
        }
    }

    /** 承上題綁定：失敗只記 log（見 services/followUpLinker.js）。 */
    async function linkFollowUps(jobId) {
        try {
            await require('../services/followUpLinker').linkJob(db, jobId, { src: 'pipeline' });
        } catch (err) {
            logger.warn({ msg: '承上題綁定失敗（不影響狀態推進）', job_id: jobId, error: String(err && err.message).split('\n')[0] });
        }
    }

    /** 所有 job_questions 都在終態 → jobs.state = 'done'。 */
    async function maybeFinishJob(jobId) {
        await db.query(
            `UPDATE jobs SET state = 'done', locked_until = NULL, updated_at = now()
              WHERE id = $1 AND state = 'processing'
                AND NOT EXISTS (SELECT 1 FROM job_questions
                                 WHERE job_id = $1 AND state NOT IN ('saved','needs_review','rejected'))`,
            [jobId]);
    }

    // ── 工作單位 A：拆題 ─────────────────────────────────────
    /**
     * @param {number} jobId
     * @param {object|null} [lease]  〔dec/r8-b1-abandon〕tick 認領時的租約憑證；直接呼叫（測試）時沒有
     */
    async function runExtractJob(jobId, lease = null) {
        const stopRenew = startRenew('jobs', jobId, lease);
        try {
            const { rows } = await db.query(
                `SELECT id, pdf_path, pdf_sha256, page_count, subject_group,
                        budget_usd::float8 AS budget_usd, cost_usd::float8 AS cost_usd
                   FROM jobs WHERE id = $1`, [jobId]);
            if (rows.length === 0) return;
            const job = rows[0];

            // 〔DA-13〕逐塊檢查點：已經拆完的塊（extract 事件 pass／skipped）跳過，只跑沒拆完的（planResumeChunks）
            const checkpoints = await readExtractCheckpoints(jobId);
            const plan = planResumeChunks(job.page_count, config.pdfChunkPages, checkpoints);
            if (plan.mode === 'inconsistent') {
                // 〔dec/r7-checkpoints-fix〕不自動重拆（題號會撞、會建出重複列，理由見 planResumeChunks），留給人處理
                logger.warn({
                    job_id: jobId, node: 'extract', mode: plan.mode, msg: '拆題檢查點對不上，不自動接著拆',
                    checkpoints: checkpoints.map(c => ({ chunk: c.chunk, page_range: c.page_range })), page_count: job.page_count
                });
                await failJob(jobId, EXTRACT_CHECKPOINT_INCONSISTENT_MSG);
                return;
            }

            // 〔dec/r7-checkpoints-fix〕PDF 的檢查移到算完檢查點之後：每一塊都已經拆完（上一輪在「刪 PDF」與
            // 「轉 processing」之間被殺）時已經用不到 PDF，直接轉 processing。原本先檢查 PDF，這種 job 會 failed，
            // 按重試也一樣 failed（PDF 已刪），但題目列與檢查點其實都在。還有塊要拆時照舊要有 PDF。
            const pdfFile = job.pdf_path ? resolveJobPath(job.pdf_path) : null;
            const pdfExists = pdfFile !== null && fs.existsSync(pdfFile);
            if (!pdfExists && plan.todo.length > 0) {
                await failJob(jobId, 'PDF 原檔不存在，無法拆題。');
                return;
            }

            if (plan.done.length > 0) {
                const skipped = plan.done.map(c => c.no).join('、');
                const msg = plan.mode === 'resume'
                    ? `從檢查點接著拆：第 ${skipped} 塊已經拆完，不再呼叫模型`
                    : `從檢查點接著拆：每塊頁數和上一輪不同，第 ${skipped} 塊（到第 ${plan.done[plan.done.length - 1].toPage ?? '最後'} 頁）已經拆完，其餘接著用這次的頁數切、塊號接在後面`;
                logger.info({
                    job_id: jobId, node: 'extract', msg, mode: plan.mode,
                    done_chunks: plan.done.length, todo_chunks: plan.todo.length
                });
            }
            let created = plan.doneCreated;

            for (const chunk of plan.todo) {
                // 〔dec/r8-b1-abandon〕放棄：不開始下一塊；被中止的那一塊沒有留下題目列與檢查點（runExtractChunk 回 abandoned），
                // job 停在 extracting、不 failed，只放掉自己的租約，下次開啟從這一塊接著拆（DA-13 的檢查點）
                const r = abandoning ? { ok: false, abandoned: true } : await runExtractChunk(job, chunk);
                if (r.abandoned) {
                    await abandonUnit(lease, stopRenew, { unit: 'extract', job_id: jobId, node: 'extract', chunk: chunk.no, page_range: [chunk.fromPage, chunk.toPage] });
                    return;
                }
                if (!r.ok) { await failJob(jobId, r.error); return; }
                created += r.created;
            }

            // 全部 chunk 都拆完才刪檔並清空 pdf_path（第 1.3 條的生命週期）
            if (pdfExists) {
                try { fs.unlinkSync(pdfFile); } catch (err) {
                    logger.warn({ msg: '刪除 PDF 失敗', job_id: jobId, error: err.message });
                }
            } else {
                logger.warn({
                    job_id: jobId, node: 'extract',
                    msg: 'PDF 已經不在，但每一塊都已經拆完（上一輪在刪檔之後、轉 processing 之前被中斷）：直接轉 processing'
                });
            }
            // 〔dec/r13-extract-fixes〕解答頁的答案回填到同一份卷的題目（拆完整份才做：要知道全部題數才對得上題號）
            await applyAnswerKey(jobId);
            await db.query(
                `UPDATE jobs SET pdf_path = NULL, state = 'processing', locked_until = NULL, updated_at = now()
                  WHERE id = $1`, [jobId]);
            logger.info({
                job_id: jobId, node: 'extract', outcome: 'pass', questions: created, chunks: plan.done.length + plan.todo.length,
                ...(plan.done.length > 0 ? { resumed_chunks: plan.done.length } : {})
            });

            // 〔DA-13〕原本只在 created === 0 時檢查。接著拆的時候，前幾塊的題目常在這一塊拆完之前就已經走到終態
            // （tick 先認領單題、再認領拆題），那時 runJobQuestion 的 maybeFinishJob 因為 job 還在 extracting 而不動；
            // 這一塊又沒建出題目的話，job 會一直停在 processing。maybeFinishJob 只在全部題目都到終態時才收尾，一律呼叫無害。
            await maybeFinishJob(jobId);
        } finally {
            stopRenew();
        }
    }

    /**
     * 〔DA-13〕這份 job 的拆題檢查點：extract 事件裡 pass／skipped 的那幾列（依 id），交給 planResumeChunks。
     * 事件表只追加，所以舊版整份重拆留下的重複列也會在這裡（planResumeChunks 會合併同一個頁碼範圍）。
     */
    async function readExtractCheckpoints(jobId) {
        const { rows } = await db.query(
            `SELECT detail->'chunk' AS chunk, detail->'page_range' AS page_range, detail->'created' AS created
               FROM job_events
              WHERE job_id = $1 AND node = 'extract' AND jq_id IS NULL AND outcome IN ('pass', 'skipped')
              ORDER BY id`, [jobId]);
        return Array.isArray(rows) ? rows : [];
    }

    /**
     * 〔dec/r13-extract-fixes，Owner 2026-10-02 同意；docs/local-mode.md 10.25 第 2 點〕解答頁的答案回填。
     * 拆完整份之後（runExtractJob 轉 processing 之前；接著拆時也會在最後再跑一次，冪等）：
     *   1. 讀這份 job 各塊 extract 事件的 detail.answer_key（agents/extract.js 本機路徑解析的「題號 → 答案」）；
     *   2. 照 utils/answerKey.js 的 mapAnswerKey 對上題目（題號總數＝題數、題幹開頭的題號對得上，否則整份不回填、只記 log）；
     *   3. 只改「答案是空的、還沒回填過」的題：payload.extract.answer_text ＝解答表的答案、answer_src ＝ 'answer_key'。
     * 前幾塊的題可能已經在跑後面的節點：這裡直接改資料庫裡的 payload，runJobQuestion 寫回時會保留這兩個欄位（見那一句 UPDATE）。
     * 已經跑過 verify 的題（compare='no_claim'）不重跑，複核頁同時看得到解答表的答案與驗算的建議答案。
     * 失敗只記 warn：回填是加分項，不影響拆題本身。
     */
    async function applyAnswerKey(jobId) {
        try {
            const { rows: evs } = await db.query(
                `SELECT detail->'chunk' AS chunk, detail->'answer_key' AS answer_key
                   FROM job_events
                  WHERE job_id = $1 AND node = 'extract' AND jq_id IS NULL AND outcome IN ('pass', 'skipped')
                    AND detail ? 'answer_key'
                  ORDER BY id`, [jobId]);
            const entries = collectAnswerKeyEntries(evs);
            if (!entries.length) return { applied: 0, reason: 'no_entries' };
            const { rows: qs } = await db.query(
                `SELECT id, idx, payload->'extract'->>'question_type' AS question_type,
                        payload->'extract'->>'question_text' AS question_text,
                        payload->'extract'->>'answer_text' AS answer_text
                   FROM job_questions WHERE job_id = $1 ORDER BY idx`, [jobId]);
            const { mapAnswerKey } = require('../utils/answerKey');
            const plan = mapAnswerKey(entries, qs);
            if (!plan.ok) {
                logger.warn({ job_id: jobId, node: 'extract', msg: '解答頁的題號對不上題目，不回填答案（只記錄）', reason: plan.reason, entries: entries.length, questions: qs.length });
                return { applied: 0, reason: plan.reason };
            }
            let applied = 0;
            for (const u of plan.updates) {
                const { rowCount } = await db.query(
                    `UPDATE job_questions
                        SET payload = jsonb_set(jsonb_set(payload, '{extract,answer_text}', to_jsonb($2::text)),
                                                '{extract,answer_src}', '"answer_key"'::jsonb),
                            updated_at = now()
                      WHERE id = $1 AND COALESCE(payload->'extract'->>'answer_text', '') = ''
                        AND NOT ((payload->'extract') ? 'answer_src')`, [u.id, u.answer_text]);
                applied += rowCount || 0;
            }
            logger.info({
                job_id: jobId, node: 'extract', msg: `解答頁回填 ${applied} 題答案（不確定、題型對不上的 ${plan.skipped.length} 題不回填）`,
                applied, skipped: plan.skipped
            });
            return { applied, reason: null, skipped: plan.skipped };
        } catch (err) {
            logger.warn({ job_id: jobId, node: 'extract', msg: '解答頁回填失敗（題目照常，只是沒有回填答案）', error: String(err && err.message).split('\n')[0] });
            return { applied: 0, reason: 'error' };
        }
    }

    /** 〔DA-13〕同一個交易跑 fn(client)：拆完一塊（變式建好一題）時，建題目列與寫那一列事件要一起成功或一起不算。 */
    async function inTransaction(fn) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * 單一 chunk 的拆題（含 fail 重試 1 次與 error 退避），成功時建 job_questions。
     * 〔第四輪 V3〕本機模式（config.localExtract）的 timeout 另有上限 LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES（見常數的說明）。
     */
    async function runExtractChunk(job, chunk) {
        let failRetries = 0;
        let errorRetries = 0;
        let timeoutRetries = 0;   // 〔第四輪 V3〕其中幾次是 timeout（只在本機模式用來設上限）

        for (; ;) {
            // 〔dec/r8-b1-abandon〕放棄了就不再（重）試：重試的次數是這個迴圈的區域變數，下次認領時從 0 算起（與當機相同）
            if (abandoning) return { ok: false, abandoned: true };
            const { rows } = await db.query('SELECT cost_usd::float8 AS cost_usd FROM jobs WHERE id = $1', [job.id]);
            const budgetLeft = Number(job.budget_usd) - Number(rows[0]?.cost_usd ?? 0);
            if (budgetLeft <= 0) {
                await writeEvent({
                    job_id: job.id, node: 'extract', attempt: failRetries + errorRetries + 1,
                    latency_ms: 0, outcome: 'fail', error_class: 'budget_exceeded', detail: { chunk: chunk.no }
                });
                return { ok: false, error: `拆題預算用盡（budget_usd=${job.budget_usd}）。` };
            }

            const ctxBase = {
                db,
                job: {
                    id: job.id, kind: 'pdf', pdf_sha256: job.pdf_sha256 ?? null,
                    // 〔stage5 WS-B〕化學卷的 extract 走化學模板與 schema（agents/extract.js 的 VARIANTS）
                    subject_group: job.subject_group ?? 'math_physics',
                    budget_usd: Number(job.budget_usd), cost_usd: Number(rows[0]?.cost_usd ?? 0)
                },
                jq: null, logger, models: loadModels(), limits: { ...DEFAULT_LIMITS, budgetLeft }
            };
            const res = await invokeNode('extract', ctxBase, { jobId: job.id, pdfPath: resolveJobPath(job.pdf_path), chunk });
            // 〔dec/r8-b1-abandon〕被放棄：不裁圖、不建題目列、不寫事件（檢查點），迴圈不重試
            // 〔審查 dec/r8-b1-abandon-fix〕放棄之前已經回來的呼叫（例如 cross 模式先回來的幾次）照記進 jobs，不寫事件
            if (res.abandoned) {
                await chargeAbandoned(job.id, res);
                return { ok: false, abandoned: true };
            }
            const { outcome, meter, cost, latencyMs } = res;
            await chargeJob(job.id, meter, cost);

            const attempt = failRetries + errorRetries + 1;
            const chunkDone = outcome.kind === 'pass' || outcome.kind === 'skipped';
            if (chunkDone) {
                // 裁圖要在 insertJobQuestions 之前：figure_img 才會跟著進 payload.extract。
                // 也必須在這裡（extract 階段）做——全部 chunk 拆完 PDF 就刪檔了（第 1.3 條）。
                if (outcome.kind === 'pass') await attachFigureImages(job, outcome.data);
                // 原卷文字層片段（docs/source-check.md）：同一個理由必須在這裡抽——PDF 之後就刪了
                if (outcome.kind === 'pass') await attachSourceText(job, chunk, outcome.data);
            }

            const eventOf = (created) => ({
                job_id: job.id, node: 'extract', attempt,
                model: meter.calls > 0 ? meter.model : null,
                token_in: meter.calls > 0 ? meter.tokenIn : null,
                token_out: meter.calls > 0 ? meter.tokenOut : null,
                token_thinking: meter.calls > 0 ? meter.tokenThinking : null,
                token_cached: meter.calls > 0 ? meter.tokenCached : null,
                cost_usd: cost.cost_usd, cost_estimated: cost.cost_estimated, latency_ms: latencyMs,
                outcome: outcome.kind === 'skipped' ? 'skipped' : outcome.kind,
                error_class: outcome.kind === 'fail' ? outcome.reason : outcome.kind === 'error' ? outcome.errorClass : null,
                detail: {
                    chunk: chunk.no, page_range: [chunk.fromPage, chunk.toPage], created,
                    rejected: (outcome.data?.rejected || []).length,
                    ...(outcome.kind === 'fail' ? { reason: outcome.reason } : {}),
                    ...(outcome.kind === 'error' ? { message: outcome.message } : {}),
                    ...(meter.usageMetadata.length > 0 ? { usage_metadata: meter.usageMetadata } : {}),
                    ...(schemaFallbackOf(meter, outcome) ? { schema_fallback: true } : {}),
                    // 〔本機模式 L2〕本機拆題的交叉驗證摘要（各 status 題數、OCR 引擎版本）；Gemini 路徑沒有這個鍵
                    ...(outcome.data?.cross_check_summary ? { cross_check: outcome.data.cross_check_summary } : {}),
                    // 〔dec/r13-extract-fixes〕解答頁（不建題的元素、解析出的題號→答案，拆完整份後 applyAnswerKey 讀它回填）、
                    // 清掉的答案數、做過 LaTeX 修復的題數；本機路徑才有，沒有就不帶
                    ...answerKeyDetail(outcome.data)
                }
            });
            // 〔DA-13〕pass／skipped 的這一列事件就是這一塊的檢查點（readExtractCheckpoints）。有題目要建時，
            // 建題目列與寫這一列在同一個交易：中途被殺（當機、關機、放棄）時兩者都不算，重新認領後這一塊整塊重拆，
            // 不會留下半塊的題目列、也不會和重拆的結果混成重複列。沒有題目要建時只有一句 INSERT，本身就是原子的。
            let created = 0;
            const toInsert = chunkDone && Array.isArray(outcome.data?.questions) && outcome.data.questions.length > 0;
            if (toInsert) {
                created = await inTransaction(async (client) => {
                    const n = await insertJobQuestions(job.id, chunk, outcome.data, client);
                    await writeEvent(eventOf(n), client);
                    return n;
                });
            } else {
                await writeEvent(eventOf(0));
            }
            logger.info({
                job_id: job.id, jq_id: null, node: 'extract', attempt, outcome: outcome.kind,
                latency_ms: latencyMs, chunk: chunk.no, created
            });

            if (outcome.kind === 'pass' || outcome.kind === 'skipped') return { ok: true, created };

            if (outcome.kind === 'fail') {
                if (failRetries < EXTRACT_MAX_RETRIES) { failRetries += 1; continue; }
                return { ok: false, error: `拆題失敗（chunk ${chunk.no}）：${outcome.reason}` };
            }
            // error：退避後重試，用盡就讓整份 job failed
            // 〔第四輪 V3〕本機模式的 timeout 用過 LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES 次就不再重試；總上限仍是 maxErrorRetries
            const localTimeoutCapped = config.localExtract === true && outcome.errorClass === 'timeout'
                && timeoutRetries >= LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES;
            if (!localTimeoutCapped && errorRetries < DEFAULT_LIMITS.maxErrorRetries) {
                await pause(backoffMs(errorRetries));   // 〔dec/r8-b1-abandon〕放棄時馬上醒來，迴圈開頭就結束
                errorRetries += 1;
                if (outcome.errorClass === 'timeout') timeoutRetries += 1;
                continue;
            }
            return {
                ok: false,
                error: `拆題連續失敗（chunk ${chunk.no}）：${outcome.message || outcome.errorClass}` +
                    (localTimeoutCapped ? `（本機模式逾時只重試 ${LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES} 次）` : '')
            };
        }
    }

    /**
     * 附圖裁切（docs/figures.md）：extract 回了 figure_page＋figure_box 的題目，
     * 在 PDF 還在磁碟上時裁成 PNG，`figure_img` 就地寫回題目物件。
     * 純程式步驟、零模型成本；任何失敗都只記 warn——圖裁不出來不該讓整塊拆題重來。
     */
    async function attachFigureImages(job, data) {
        const questions = Array.isArray(data?.questions) ? data.questions : [];
        if (!questions.some(q => Number.isInteger(q?.figure_page) && Array.isArray(q?.figure_box))) return;
        try {
            const pdfBytes = fs.readFileSync(resolveJobPath(job.pdf_path));
            const { cropFigures } = require('../services/figureService');
            const cropped = await cropFigures({ pdfBytes, jobId: job.id, questions, logger });
            if (cropped > 0) logger.info({ job_id: job.id, node: 'extract', msg: `已裁出 ${cropped} 張附圖` });
        } catch (err) {
            logger.warn({ job_id: job.id, node: 'extract', msg: '附圖裁切失敗（題目照常入列，僅缺圖）', error: err.message });
        }
    }

    /**
     * 原卷文字層（docs/source-check.md）：替這一塊的每一題寫上 `source_text`（只存定位到的片段）。
     * 純程式步驟、零模型成本；任何失敗都只記 warn、該塊題目的 status 記 'error'，題目照常入列。
     */
    async function attachSourceText(job, chunk, data) {
        const questions = Array.isArray(data?.questions) ? data.questions : [];
        if (questions.length === 0) return;
        const pageRange = Array.isArray(data?.page_range) ? data.page_range : [chunk.fromPage, chunk.toPage];
        try {
            const pdfBytes = fs.readFileSync(resolveJobPath(job.pdf_path));
            const service = require('../services/sourceTextService');
            const r = await service.attachSourceText({
                pdfBytes, questions, fromPage: pageRange[0], toPage: pageRange[1], logger, jobId: job.id
            });
            logger.info({ job_id: job.id, node: 'extract', msg: `原卷文字層定位 ${r.located}/${r.total} 題`, chunk: chunk.no });
        } catch (err) {
            logger.warn({ job_id: job.id, node: 'extract', msg: '原卷文字層抽取失敗（題目照常入列，僅不做原卷比對）', error: err.message });
            for (const q of questions) {
                q.source_text = { v: 1, status: 'error', pages: pageRange, locate_score: null };
            }
        }
    }

    /**
     * 把 extract 的結果建成 job_questions。
     * ON CONFLICT DO NOTHING：崩潰後重跑同一個 chunk 不會建出重複的列（UNIQUE (job_id, idx)）。
     * 〔DA-13〕executor＝runExtractChunk 的交易 client（與這一塊的檢查點事件同一個交易）。
     */
    async function insertJobQuestions(jobId, chunk, data, executor = db) {
        const list = Array.isArray(data.questions) ? data.questions : [];
        // FR-019：該塊模型回傳的元素總數（含被 schema 驗證丟掉的）。承上題找前題時用它判斷
        // 「上一塊的塊尾有沒有題被丟」，避免跨塊靜默綁錯。比照 figure_img 由 runner 追加，
        // 不動 extract 模板／schema／cassette。
        const chunkElements = list.length + (Array.isArray(data.rejected) ? data.rejected.length : 0);
        let created = 0;
        for (let i = 0; i < list.length; i++) {
            const q = list[i];
            const idx = Number.isInteger(q?.idx) ? q.idx : chunk.no * 1000 + (i + 1);
            const payload = {
                extract: {
                    ...q, idx,
                    chunk_no: q?.chunk_no ?? chunk.no,
                    page_range: q?.page_range ?? [chunk.fromPage, chunk.toPage],
                    chunk_elements: chunkElements
                }
            };
            const { rowCount } = await executor.query(
                `INSERT INTO job_questions (job_id, idx, state, payload)
                 VALUES ($1, $2, 'extracted', $3::jsonb)
                 ON CONFLICT (job_id, idx) DO NOTHING`,
                [jobId, idx, JSON.stringify(payload)]);
            created += rowCount;
        }
        return created;
    }

    // ── 工作單位 C：變式生成（interfaces-stage3.md 第 4.1 條）────────────────
    //
    // 與工作單位 A（拆題）是同一個形狀：job 層節點跑完 → 建 job_questions(state='extracted')
    // → jobs.state='processing'，之後**逐題走完全相同的六個節點**。變式題不另開通道，
    // 也就不會有「變式題的閘門比較鬆」這種事（規劃 §4 的核心設計）。
    //
    // 差別只有三個：
    //   1. 節點名是 'generate' 不是 'extract'（agents/generateVariant.js）；
    //   2. 沒有 PDF，所以 chunk_no = 0、idx = i（1-based，裁決 S3-10）；
    //   3. 一列都沒建出來時 jobs.error 是第 4.1 條凍結的那句話。
    /**
     * @param {number} jobId kind='variant' 的 job
     * @param {object|null} [lease]  〔dec/r8-b1-abandon〕tick 認領時的租約憑證；直接呼叫（測試）時沒有
     */
    async function runGenerateJob(jobId, lease = null) {
        const stopRenew = startRenew('jobs', jobId, lease);
        try {
            const variantService = require('../services/variantService');

            const { rows } = await db.query(
                `SELECT id, source_question_id, subject_group, budget_usd::float8 AS budget_usd, cost_usd::float8 AS cost_usd
                   FROM jobs WHERE id = $1`, [jobId]);
            if (rows.length === 0) return;
            const job = rows[0];

            // 建 job 時寫進 job_events 的請求參數（裁決 S3-9）
            const requested = await variantService.readRequested(db, jobId);

            const source = await variantService.loadSource(db, job.source_question_id);
            if (!source) {
                await failJob(jobId, '藍本題不存在或已封存，無法生成變式。', 'generate');
                return;
            }
            // 錨點鄰居由 runner 查好（agent 不得自己連 DB，第 3.1 條）
            const neighbors = await variantService.findNeighbors(db, source);

            // 〔Owner 第五輪 V5-6 核准〕依序生成（idx 1→N），每一題都把「這次已生成的兄弟題幹」與總題數傳給 agent，
            // prompt 據此要求換情境與數字（agents/generateVariant.js variant.v2）。兄弟的題幹一律從 job_questions 讀回
            // （payload.extract.question_text）：租約過期、整份 job 被重新認領時，前一輪已建好的列也算兄弟，
            // 而 ON CONFLICT 沒建成的那一題，兄弟就是 DB 裡既有的那一列，不是這一輪被丟掉的生成結果。
            // 〔Owner 第六輪 DA-13＝2，dec/r7-checkpoints〕逐題檢查點：job_questions 已經有的 idx 就是做完的題，重新認領時
            // 跳過、不再呼叫模型，只生成缺的（原本從第 1 題重來，已存在的結果撞 UNIQUE 丟掉）。已做完的題照樣算進 created，
            // 所以「全部做完才被中斷」的 job 重新認領後不會被當成一題都沒建成而 failed。兄弟題幹照舊逐題從 DB 讀，
            // 順序（idx 由小到大）與一次跑完相同。
            // 〔dec/r7-checkpoints-fix〕「只生成缺的」＝job_questions 裡沒有的 idx 都會再生成（設計稿第 36 項）：
            // 不只被中斷的那一題，中斷點之前沒建成的題（沒過閘門、預算用盡而略過）也會再跑一次
            // （沒過閘門的會再呼叫模型；預算用盡的在呼叫前就再檢查一次預算）。文件與關閉時的提示照這個說法寫。
            const doneIdx = await readVariantDoneIdx(jobId);
            let created = 0;
            let resumed = 0;
            for (let i = 1; i <= requested.count; i++) {
                if (doneIdx.has(i)) { created += 1; resumed += 1; continue; }
                // 〔dec/r8-b1-abandon〕放棄：不開始下一題；被中止的那一題沒有建列、沒有寫事件（runGenerateOne 回 ABANDONED），
                // job 停在 extracting、不 failed（就算一題都還沒建成），只放掉自己的租約，下次開啟只補還沒建成的題（DA-13）
                let n = ABANDONED;
                if (!abandoning) {
                    const siblings = await readVariantSiblings(jobId, i);
                    n = await runGenerateOne(job, source, neighbors, requested, i, siblings);
                }
                if (n === ABANDONED) {
                    await abandonUnit(lease, stopRenew, { unit: 'variant', job_id: jobId, node: 'generate', idx: i });
                    return;
                }
                created += n;
            }
            if (resumed > 0) {
                logger.info({
                    job_id: jobId, node: 'generate', msg: `從檢查點接著生成：${resumed} 題已經建好，不再呼叫模型`,
                    resumed, requested: requested.count
                });
            }

            if (created === 0) {
                // 第 4.1 條的凍結訊息（其他 job 層例外沿用既有訊息）
                await failJob(jobId, '變式生成全部未通過文字閘門或跑題檢查。', 'generate');
                return;
            }

            await db.query(
                `UPDATE jobs SET state = 'processing', locked_until = NULL, updated_at = now() WHERE id = $1`,
                [jobId]);
            logger.info({
                job_id: jobId, node: 'generate', outcome: 'pass', questions: created, requested: requested.count,
                ...(resumed > 0 ? { resumed } : {})
            });
            // 〔DA-13〕接著生成時，前一輪建好的題可能已經走到終態（tick 先認領單題、再認領 job），這一輪又一題都沒建成
            // （全部沒過閘門）的話，沒有單題會再觸發收尾（runJobQuestion 的 maybeFinishJob 在 job 還是 extracting 時不動）。
            // 與拆題同一個理由一律檢查一次：全部題目都到終態才會收尾，否則什麼都不改。
            await maybeFinishJob(jobId);
        } finally {
            stopRenew();
        }
    }

    /**
     * 〔DA-13〕變式 job 已經建好的 idx（逐題檢查點）。
     * @returns {Promise<Set<number>>}
     */
    async function readVariantDoneIdx(jobId) {
        const { rows } = await db.query('SELECT idx FROM job_questions WHERE job_id = $1', [jobId]);
        return new Set((Array.isArray(rows) ? rows : []).map(r => Number(r.idx)));
    }

    /**
     * 〔Owner 第五輪 V5-6〕同一個變式 job 裡 idx 比 beforeIdx 小、已經建出來的兄弟（依 idx 排序）。
     * @returns {Promise<Array<{idx:number, question_text:string}>>}
     */
    async function readVariantSiblings(jobId, beforeIdx) {
        const { rows } = await db.query(
            `SELECT idx, payload->'extract'->>'question_text' AS question_text
               FROM job_questions
              WHERE job_id = $1 AND idx < $2
              ORDER BY idx`,
            [jobId, beforeIdx]);
        return rows
            .filter(r => String(r.question_text ?? '').trim())
            .map(r => ({ idx: r.idx, question_text: r.question_text }));
    }

    /**
     * 生成第 i 題（含 fail 重試 1 次與 error 退避，比照 extract）。
     * 〔Owner 第五輪 V5-6〕siblings＝這次已生成的兄弟（readVariantSiblings），與 total（requested.count）一起傳給 agent。
     * @returns {Promise<number|typeof ABANDONED>} 這一題建出來的列數（0 或 1）；〔dec/r8-b1-abandon〕被放棄時回 ABANDONED
     */
    async function runGenerateOne(job, source, neighbors, requested, idx, siblings = []) {
        let failRetries = 0;
        let errorRetries = 0;
        let feedback = '';

        for (; ;) {
            // 〔dec/r8-b1-abandon〕放棄了就不再（重）試（同 runExtractChunk）
            if (abandoning) return ABANDONED;
            const { rows } = await db.query('SELECT cost_usd::float8 AS cost_usd FROM jobs WHERE id = $1', [job.id]);
            const spent = Number(rows[0]?.cost_usd ?? 0);
            const budgetLeft = Number(job.budget_usd) - spent;
            const attempt = failRetries + errorRetries + 1;

            if (budgetLeft <= 0) {
                // 第 7.3.2 條：呼叫「前」就檢查，錢不夠連叫都不叫
                await writeEvent({
                    job_id: job.id, node: 'generate', attempt, latency_ms: 0,
                    outcome: 'fail', error_class: 'budget_exceeded', detail: { idx }
                });
                logger.warn({ job_id: job.id, node: 'generate', idx, msg: '預算用盡，跳過這一題', budget_left: budgetLeft });
                return 0;
            }

            const ctxBase = {
                db,
                job: {
                    id: job.id, kind: 'variant', pdf_sha256: null,
                    // 〔stage5 WS-B〕變式 job 的卷別（建立時依藍本科目寫入；agent 另以藍本科目為準）
                    subject_group: job.subject_group ?? 'math_physics',
                    budget_usd: Number(job.budget_usd), cost_usd: spent
                },
                jq: null, logger, models: loadModels(), limits: { ...DEFAULT_LIMITS, budgetLeft }
            };
            const res = await invokeNode('generate', ctxBase, {
                source,
                neighbors,
                difficulty_delta: requested.difficulty_delta,
                idx,
                total: requested.count,
                siblings,
                ...(feedback ? { feedback } : {})
            });
            // 〔dec/r8-b1-abandon〕被放棄：不建列、不寫事件，迴圈不重試
            // 〔審查 dec/r8-b1-abandon-fix〕放棄之前已經回來的呼叫照記進 jobs，不寫事件
            if (res.abandoned) {
                await chargeAbandoned(job.id, res);
                return ABANDONED;
            }
            const { outcome, meter, cost, latencyMs } = res;
            await chargeJob(job.id, meter, cost);
            // 〔Owner 第七輪 R7-1＝4，C-f 納入變式〕本機模型的回應被截斷（isLocalTruncation，與題目節點同一個判準）：
            // 不重試（同一個 prompt、溫度 0，再跑一次多半一樣被截斷，每次又要等滿上限），直接放棄這一題、事件記下原因與上限，
            // job 繼續下一題、不 failed（除非一題都沒建成，照舊是第 4.1 條那句）。Gemini 與其他 error 照舊退避重試。
            const localTruncation = isLocalTruncation(outcome, meter.lastModel);
            // 〔審查 dec/r10-variant-cap〕上限是這一次實際送出的 num_predict；replay 沒有送出請求，記 null
            const truncationCap = localTruncation ? meter.lastNumPredict : null;

            const eventOf = (jqId) => ({
                job_id: job.id, jq_id: null, node: 'generate', attempt,
                model: meter.calls > 0 ? meter.model : null,
                token_in: meter.calls > 0 ? meter.tokenIn : null,
                token_out: meter.calls > 0 ? meter.tokenOut : null,
                token_thinking: meter.calls > 0 ? meter.tokenThinking : null,
                token_cached: meter.calls > 0 ? meter.tokenCached : null,
                cost_usd: cost.cost_usd, cost_estimated: cost.cost_estimated, latency_ms: latencyMs,
                outcome: outcome.kind === 'skipped' ? 'skipped' : outcome.kind,
                error_class: outcome.kind === 'fail' ? outcome.reason
                    : outcome.kind === 'error' ? outcome.errorClass : null,
                detail: {
                    idx,
                    ...(jqId !== null ? { jq_id: jqId } : {}),
                    ...(outcome.kind === 'pass' && outcome.gate ? { text_gate: outcome.gate.text_gate, sim: outcome.gate.sim } : {}),
                    // 沒過閘門的那幾題只留在事件裡（第 4.1 條：失敗的記進 job_events.detail.rejected）
                    ...(outcome.kind === 'fail'
                        ? { rejected: [{ idx, reason: outcome.reason, feedback: outcome.feedback }] } : {}),
                    ...(outcome.kind === 'error' ? { message: outcome.message } : {}),
                    // 〔Owner 第七輪 R7-1＝4，C-f 納入變式〕本機模型（ollama）的 error 記下 finish_reason（有才記，同 runJobQuestion）；
                    // 被截斷的另記 truncated、輸出上限（max_output_tokens）與說明（note），這一題放棄、不重試
                    ...(outcome.kind === 'error' && outcome.finishReason && isLocalModelSpec(meter.lastModel)
                        ? { finish_reason: outcome.finishReason } : {}),
                    ...(localTruncation
                        ? { truncated: true, max_output_tokens: truncationCap, gave_up: true, note: variantTruncationNote(truncationCap) } : {}),
                    ...(meter.usageMetadata.length > 0 ? { usage_metadata: meter.usageMetadata } : {}),
                    ...(schemaFallbackOf(meter, outcome) ? { schema_fallback: true } : {})
                }
            });
            // 〔dec/r7-checkpoints-fix，依審查〕比照拆題：建這一題的列與寫這一次的 generate 事件在同一個交易。
            // 原本兩句各自提交，程序剛好在兩句之間被殺時，列在、事件不在：重新認領時 readVariantDoneIdx 看到列就跳過，
            // 這一題的 pass 事件（text_gate、sim、jq_id、usage_metadata）與 cost_usd 就永遠補不回來，
            // 而每日預算止血（dailySpentUsd）讀的正是 job_events。現在兩者一起成功或一起不算（沒提交＝這一題重做）。
            // 沒過（fail／error／skipped）時沒有列要建，只有一句 INSERT 事件，本身就是原子的。
            let jqId = null;
            if (outcome.kind === 'pass') {
                jqId = await inTransaction(async (client) => {
                    const id = await insertVariantQuestion(job, source, requested, idx, outcome, attempt, client);
                    await writeEvent(eventOf(id), client);
                    return id;
                });
            } else {
                await writeEvent(eventOf(null));
            }
            logger.info({
                job_id: job.id, jq_id: jqId, node: 'generate', attempt, outcome: outcome.kind,
                latency_ms: latencyMs, idx
            });

            if (outcome.kind === 'pass') return 1;
            if (outcome.kind === 'skipped') return 0;

            if (outcome.kind === 'fail') {
                // 下一次重試把失敗理由餵回 prompt（第 4.2 條）
                feedback = outcome.feedback || feedback;
                if (failRetries < EXTRACT_MAX_RETRIES) { failRetries += 1; continue; }
                return 0;
            }
            if (localTruncation) {
                logger.warn({
                    job_id: job.id, node: 'generate', idx, attempt, finish_reason: outcome.finishReason,
                    max_output_tokens: truncationCap, msg: variantTruncationNote(truncationCap)
                });
                return 0;
            }
            if (errorRetries < DEFAULT_LIMITS.maxErrorRetries) {
                await pause(backoffMs(errorRetries));   // 〔dec/r8-b1-abandon〕放棄時馬上醒來，迴圈開頭就結束
                errorRetries += 1;
                continue;
            }
            return 0;
        }
    }

    /**
     * 把一題變式建成 job_questions。
     *
     * payload 有**七個鍵**的其中兩個：`extract`（與 PDF job 同形，之後六個節點照原樣讀）
     * 與階段 3 新增的 `variant`（第 4.5 條，只由 generate 節點寫，其餘節點不碰）。
     *
     * ON CONFLICT DO NOTHING：租約過期後整份 job 被重新認領時，同一個 idx 不會建出重複的列。
     * 〔DA-13〕重新認領時已經建好的 idx 本來就會被跳過（readVariantDoneIdx），這裡留著當第二道防線。
     * 〔dec/r7-checkpoints-fix〕executor＝runGenerateOne 的交易 client（與這一題的 generate pass 事件同一個交易）。
     *
     * @returns {Promise<number|null>} 新列的 id；撞 UNIQUE 沒建成時回 null
     */
    async function insertVariantQuestion(job, source, requested, idx, outcome, attempt, executor = db) {
        const data = outcome.data || {};
        const gate = outcome.gate || {};
        const payload = {
            extract: { ...data, idx, chunk_no: 0, page_range: null },
            variant: {
                source_question_id: source.id,
                difficulty_delta: requested.difficulty_delta,
                anchor_ids: data.anchor_ids || [],
                text_gate: gate.text_gate ?? null,
                sim: gate.sim ?? null,
                attempt
            }
        };
        const { rows } = await executor.query(
            `INSERT INTO job_questions (job_id, idx, state, payload)
             VALUES ($1, $2, 'extracted', $3::jsonb)
             ON CONFLICT (job_id, idx) DO NOTHING
             RETURNING id`,
            [job.id, idx, JSON.stringify(payload)]);
        return rows.length ? rows[0].id : null;
    }

    async function failJob(jobId, message, node = 'extract') {
        await db.query(
            `UPDATE jobs SET state = 'failed', error = $2, locked_until = NULL, updated_at = now() WHERE id = $1`,
            [jobId, message]);
        logger.error({ job_id: jobId, node, outcome: 'error', latency_ms: 0, error: message });
    }

    // ── 模型設定（config/models.js 由 WS-B 提供，還沒合入時退回 .env）──
    let modelsCache = null;
    function loadModels() {
        if (modelsCache) return modelsCache;
        try {
            const m = require('../config/models');
            if (typeof m.warnIfSameModel === 'function') m.warnIfSameModel();
            // 第三個鍵是階段 3 加的（interfaces-stage3.md 第 4.2、9 條）：
            // 「MODEL_VARIANT 未設時退回 MODEL_VERIFY」的解析放在 config/models.js **之外**，
            // 也就是這裡——agent 不得自己讀 process.env，所以退回這一步只能由 runner 做。
            modelsCache = {
                extract: m.MODEL_EXTRACT, verify: m.MODEL_VERIFY, variant: m.MODEL_VARIANT || m.MODEL_VERIFY,
                // 〔本機模式 L2〕第四個鍵（附加）：OCR 結果結構化的模型，未設＝MODEL_VERIFY（docs/local-mode.md 第 2 條）。
                // 與 MODEL_VARIANT 同一個理由在這裡退回：agent 不得自己讀 process.env，config/models.js 歸 L1。
                ocrStructure: String(process.env.MODEL_OCR_STRUCTURE || '').trim() || m.MODEL_VERIFY,
                // 〔LM-15〕第五個鍵（附加）：分類、公式重寫、知識點標註等純文字節點的模型。
                // 退回規則在 config/models.js 的 MODEL_TEXT getter（本機＝MODEL_VERIFY；Gemini＝MODEL_EXTRACT，行為不變）。
                text: m.MODEL_TEXT || m.MODEL_EXTRACT
            };
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw err;
            const verify = process.env.MODEL_VERIFY || 'ollama:qwen3:8b';   // 〔本機模式整合〕與 config/models.js 的 DEFAULT_VERIFY 一致
            const extract = process.env.MODEL_EXTRACT || 'ollama:qwen3-vl:8b';
            modelsCache = {
                extract,
                verify,
                variant: process.env.MODEL_VARIANT || verify,
                ocrStructure: String(process.env.MODEL_OCR_STRUCTURE || '').trim() || verify,
                // 〔LM-15〕與 config/models.js 的 MODEL_TEXT getter 同一條規則
                text: String(process.env.MODEL_TEXT || '').trim() || (/^ollama:/i.test(extract.trim()) ? verify : extract)
            };
        }
        return modelsCache;
    }

    // ── tick：認領到滿槽為止 ─────────────────────────────────
    async function tick() {
        if (ticking) return;
        // 〔審查 dec/r8-b1-abandon-fix〕呼叫過 shutdown 就不再開新的一輪（連 dailySpentUsd 都不查：呼叫的人接著會關連線池）
        if (closing) return;
        ticking = true;
        let tickDone = () => { };
        currentTick = new Promise(resolve => { tickDone = resolve; });
        try {
            // 〔審查 2026-09-26〕LOCAL_EXTRACT_MODE=ocr 卻沒套 0019：不認領任何工作（否則每題在 save 撞 CHECK、無限重試），
            // 伺服器視窗印一次「先 npm run migrate」。每一輪都再查一次：Owner 套完 migrate 後不必重啟也會恢復。
            // 查詢本身失敗（連不上 DB）不擋：下面的認領會照常報錯。
            if (ocrSchemaPending) {
                let problem = null;
                try { problem = await ocrOnlySchemaProblem(db); } catch (_) { problem = null; }
                if (problem) {
                    if (!ocrSchemaWarned) {
                        logger.error({ msg: problem, node: 'claim' });
                        ocrSchemaWarned = true;
                    }
                    return;
                }
                ocrSchemaPending = false;
            }

            const overDaily = await dailySpentUsd().then(s => s >= config.dailyCostBudgetUsd);
            if (overDaily && !dailyWarned) {
                logger.warn({ msg: `當日成本已達 DAILY_COST_BUDGET_USD=${config.dailyCostBudgetUsd}，停止認領需要付費的工作`, node: 'claim' });
                dailyWarned = true;
            }
            if (!overDaily) dailyWarned = false;

            // 止血時只放行零成本節點對應的狀態，讓在途的 job 至少把免費的格子走完
            const states = overDaily
                ? ADVANCEABLE_STATES.filter(s => FREE_NODES.has(NODE_FOR_STATE[s]))
                : ADVANCEABLE_STATES;

            // 〔dec/r8-b1-abandon〕放棄之後不再認領（stop() 只清計時器，已經在跑的這一輪 tick 要自己停）
            // 〔審查 dec/r8-b1-abandon-fix〕改看 closing（呼叫過 shutdown，不論有沒有 abandon）；每一次 claim 回來之後也再看一次：
            // shutdown 可能是在 claim 的交易進行中被呼叫的，剛認領到的那一列不開始、放掉租約（returnClaim）
            while (inFlight.size < config.concurrency && !closing) {
                // 先清在途的列（讓已經花過錢的 job 早點結案），再開新的 PDF
                // 〔dec/r8-b1-abandon〕claim 多回一個租約憑證，交給工作單位（放棄時只放掉自己的租約）
                const jq = await claim('job_questions', 'state = ANY($1::text[])', [states]);
                if (jq !== null) {
                    if (closing) { await returnClaim(jq, 'job_question'); break; }
                    spawn(`jq:${jq.id}`, () => runJobQuestion(jq.id, jq.lease));
                    continue;
                }

                if (overDaily || closing) break;
                const job = await claim('jobs', `kind = 'pdf' AND state IN ('queued','extracting')`, [], `, state = 'extracting'`);
                if (job !== null) {
                    if (closing) { await returnClaim(job, 'extract'); break; }
                    spawn(`job:${job.id}`, () => runExtractJob(job.id, job.lease));
                    continue;
                }

                // 第 4.1 條：**第二條認領分支，只加不改**。變式 job 也用 'extracting' 當
                // 「job 層節點正在跑」的狀態（jobs.state 的五個值沒有新增，DDL 不必動）。
                if (closing) break;
                const variantJob = await claim('jobs', `kind = 'variant' AND state IN ('queued','extracting')`, [], `, state = 'extracting'`);
                if (variantJob === null) break;
                if (closing) { await returnClaim(variantJob, 'variant'); break; }
                spawn(`job:${variantJob.id}`, () => runGenerateJob(variantJob.id, variantJob.lease));
            }
        } catch (err) {
            logger.error({ msg: 'tick 失敗', node: 'claim', error: err.message });
        } finally {
            ticking = false;
            currentTick = null;
            tickDone();
        }
    }

    function spawn(key, fn) {
        const token = `${key}#${++spawnSeq}`;
        inFlight.add(token);
        Promise.resolve()
            .then(fn)
            .catch(err => logger.error({ msg: '工作單位異常結束', unit: key, error: err.message, stack: err.stack }))
            .finally(() => {
                inFlight.delete(token);
                if (inFlight.size === 0) for (const w of [...idleWaiters]) w();
            });
    }

    /** 等在途的工作單位都結束，最多 ms 毫秒（0＝不等） */
    function waitIdle(ms) {
        if (inFlight.size === 0 || !(ms > 0)) return Promise.resolve();
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); idleWaiters.delete(done); resolve(); };
            const timer = setTimeout(done, ms);
            idleWaiters.add(done);
        });
    }

    function start() {
        if (timer) return;
        // 〔Owner 第五輪 D-3、V5-5 2026-09-27〕啟動訊息帶出實際生效的拆題方式（只在拆題模型是 ollama 時）與餘弦門檻，
        // Owner 從伺服器視窗就看得到「沒寫 .env 時用的是哪一組」，不必翻文件（docs/local-mode.md 10.19）
        // 〔審查 dec/r6-defaults〕門檻與拆題方式的來源都照 runner 實際的 config（opts.config 覆寫的也算），不另讀一次 process.env
        const simCfg = require('../config/similarityThresholds');
        const sim = effectiveSimilarityThresholds(config);
        logger.info({
            msg: 'jobRunner 啟動', poll_ms: config.pollMs, concurrency: config.concurrency,
            ...(config.localExtract === true ? { local_extract_mode: startupExtractModeText(config.localExtractMode, localExtractModeExplicit) } : {}),
            thresholds: simCfg.describeSimilarityThresholds(sim)
        });
        // 〔審查 dec/r6-defaults〕舊範本的 .env 明寫了 Gemini 舊門檻 → 本機新預設不會生效，提醒要刪哪幾行（不自動忽略）
        const legacyWarn = simCfg.legacyTemplateWarning(sim);
        if (legacyWarn) logger.warn({ msg: legacyWarn });
        timer = setInterval(() => { tick(); }, config.pollMs);
        if (typeof timer.unref === 'function') timer.unref();
        tick();
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    /**
     * 〔dec/r8-b1-abandon〕關閉（docs/desktop-app-design.md 2.3 節第 4 點、2.8 節）。
     *   - 一律先 stop()（不再認領）。
     *   - abandon: true → 放棄在途工作：標記「正在放棄」、中止每一個執行中的節點（save 除外）。被放棄的工作單位
     *     不寫 outcome、不動 retries、不寫 job_events、迴圈不重試，只放掉自己的租約（abandonUnit）；被中止的那一次呼叫不記用量，
     *     同一個節點裡放棄之前已經回來的呼叫照記進 jobs（chargeAbandoned，〔審查 dec/r8-b1-abandon-fix〕）；
     *     之後才要開始的節點一律不開始。可以重複呼叫（第二次只多等）。
     *   - waitMs：最多等在途的工作單位收尾多久（放棄時通常幾百毫秒：中止、一句 UPDATE）。等不到的就留著（呼叫的人通常接著結束行程，
     *     那幾個工作單位的租約照舊等 JOB_LEASE_MS 到期）。
     *   - 〔審查 dec/r8-b1-abandon-fix〕標記 closing：tick 不再開新的一輪；正在跑的那一輪 tick 若剛好卡在 claim 的交易裡，
     *     認領回來的那一列不開始、放掉租約（returnClaim）。waitMs > 0 時先等那一輪 tick 結束（算在 waitMs 裡），再等在途的工作單位，
     *     所以回傳的 left 之後不會再變多——呼叫的人（services/launcherControl.js）看到 left＝0 就關連線池。
     * 沒有 abandon 時只是 stop()＋等，和原本的「等在途工作收尾」相同（正在認領的那一列一樣不開始、放掉租約）。
     * @param {{abandon?:boolean, waitMs?:number}} [o]
     * @returns {Promise<{left:number, abandoned:number, released:number, kept:number}>}
     *          left＝等完之後還在途的工作單位數；abandoned／released／kept＝被放棄的工作單位數、其中放掉租約／沒放的
     */
    async function shutdown({ abandon = false, waitMs = 0 } = {}) {
        stop();
        closing = true;
        if (abandon && !abandoning) {
            abandoning = true;
            const nodes = [...activeNodes];
            logger.warn({
                msg: `放棄在途工作：中止 ${nodes.length} 個執行中的節點（在途的工作單位 ${inFlight.size} 個）；` +
                    '被放棄的不寫結果、不動重試次數，只放掉自己的租約（下次開啟立刻重新認領）',
                node: 'shutdown', in_flight: inFlight.size, nodes: nodes.map(n => n.node)
            });
            for (const w of [...pauseWakers]) w();
            for (const n of nodes) n.abandon();
        }
        const deadline = Date.now() + (waitMs > 0 ? waitMs : 0);
        if (currentTick && waitMs > 0) await waitAtMost(currentTick, waitMs);
        await waitIdle(deadline - Date.now());
        return { left: inFlight.size, abandoned: abandonStats.units, released: abandonStats.released, kept: abandonStats.kept };
    }

    /** 等 p 最多 ms 毫秒（p 本身不會 reject：tick 自己接住錯誤） */
    function waitAtMost(p, ms) {
        let t = null;
        return Promise.race([p, new Promise(resolve => { t = setTimeout(resolve, ms); })])
            .finally(() => clearTimeout(t));
    }

    return {
        tick, start, stop, shutdown, runJobQuestion, runExtractJob, runGenerateJob, config,
        get inFlight() { return inFlight.size; },
        get abandoning() { return abandoning; },
        /** 〔審查 dec/r8-b1-abandon-fix〕正在退避睡眠的數目（測試與診斷用：睡完就歸零，不會隨退避次數累積） */
        get pausing() { return pauseWakers.size; }
    };
}

/** server.js 用：JOB_RUNNER=inline（預設）才啟動。 */
function startInlineRunner(opts) {
    const mode = String(process.env.JOB_RUNNER || 'inline').toLowerCase();
    if (mode !== 'inline') return null;
    const runner = createRunner(opts);
    runner.start();
    return runner;
}

module.exports = {
    createRunner, startInlineRunner,
    // 純函式，供單元測試與 report_jobs 共用
    loadConfig, loadStage3Config, loadSourceCheckConfig, planChunks, backoffMs, attemptNo, buildSaveFields, chapterSrcFor, normalizeErrorClass, makeLogger, resolveJobPath,
    planResumeChunks,   // 〔DA-13〕
    buildSolutionFields,   // 〔stage5 WS-A〕save 與 scripts/backfill_solutions.js 共用
    readFeatures, schemaFallbackOf,
    runKcTagHook,   // 〔stage5 WS-C〕
    // 〔本機模式 L2〕
    loadLocalModeConfig, renewIntervalFor, crossCheckStopReason,
    loadLocalExtractModeConfig,   // 〔OCR 為主 2026-09-26〕
    startupExtractModeText,   // 〔Owner 第五輪 D-3〕
    effectiveSimilarityThresholds,   // 〔審查 dec/r6-defaults〕
    ocrOnlySchemaProblem, OCR_ONLY_SCHEMA_MESSAGE,   // 〔審查 2026-09-26〕
    outputTruncatedAccepted, OUTPUT_TRUNCATED_SCHEMA_MESSAGE, isLocalModelSpec, isLocalTruncation,   // 〔Owner 第五輪 C-f〕
    appliedNumPredictOf, variantTruncationNote,   // 〔Owner 第七輪 R7-1；審查 dec/r10-variant-cap〕
    // 〔dec/r13-extract-fixes〕答案為空的停等、解答頁回填、本機 lint／verify 逾時不重試
    answerMissingStopReason, saveStopReason, answerKeyCheck, answerKeyDetail, collectAnswerKeyEntries,
    isLocalTimeout, LOCAL_TIMEOUT_NO_RETRY_NODES, LOCAL_TIMEOUT_NOTE,
    LOCAL_NODE_TIMEOUT_MS, LOCAL_PDF_CHUNK_PAGES, LOCAL_CONCURRENCY, RENEW_MIN_INTERVAL_MS,
    LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES,   // 〔第四輪 V3〕
    ADVANCEABLE_STATES, FREE_NODES, AGENT_MODULE_FOR_NODE, ERROR_CLASSES, SOURCE_CHECK_MODES,
    RENEW_INTERVAL_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, EXTRACT_MAX_RETRIES,
    ABANDON_REASON   // 〔dec/r8-b1-abandon〕
};

// node workers/jobRunner.js 可獨立跑（第 7.2 條）
if (require.main === module) {
    require('dotenv').config();
    const runner = createRunner();
    runner.start();
    const shutdown = () => { runner.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
