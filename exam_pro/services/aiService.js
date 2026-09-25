// services/aiService.js — 舊 /analyze-pdf 流程的相容包裝（A-T8）
//
// 這一支現在**沒有自己的 prompt、沒有自己的白名單、也不自己呼叫 SDK**：
// 全部委託給 agents/extract.js。三份會各自漂移的真相（prompt 手抄的章節、config/chapters.js、
// schema 的 enum）收斂成一份 config/chapters.js。
//
// 回應形狀不變（既有前端 public/index.html:885-919 的 createQuestionEditor 與
// batch-save-questions 是契約）：仍然是一個陣列，每筆仍然是那六個鍵，
// figure_desc 仍然以「[附圖描述：…]」併在 question_text 末端。
//
// 與舊版的行為差異（都是刻意的）：
//   1. 超過 JOB_PDF_CHUNK_PAGES 頁的 PDF 會切塊多次呼叫（舊版一次送整份，長考卷輸出會被截斷）
//   2. 每一題都過 ajv：不合格的那幾題被丟掉並記 log，其餘照常回傳（舊版整批照抄）
//   3. 模型 ID 改讀 MODEL_EXTRACT（舊版寫死 'gemini-2.5-flash'）
//   4. 〔Owner 決策單 2026-09-25 B21〕保留本流程並補裁附圖（roadmap 待決策第 20 項，Owner 選 B）：
//      extract 回了 figure_page＋figure_box 的題，用管線同一支 services/figureService.js 裁成 PNG、
//      存同一個 data/figures/，路徑以**新增**的 `question_img` 鍵回傳（就是 questions 表的欄位名；
//      前端把整筆送回 batch-save-questions 入庫）。沒有附圖的題仍然只有那六個鍵，逐位元不變。
//      裁圖失敗只記 warn：題目照回、該題沒有 question_img（docs/figures.md「舊流程 /analyze-pdf 的附圖」）。
//
// services/legacy/analyzePdf.js 是 A-T8 之前的凍結快照（eval 對照用），**不是**這支；本次沒有動它。

const crypto = require('crypto');
const llm = require('./llm');
const models = require('../config/models');
const extractAgent = require('../agents/extract');

const DEFAULT_CHUNK_PAGES = 20;
const DEFAULT_INLINE_MAX_BYTES = 15728640;

function intFromEnv(name, fallback) {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ───────── 測試可替換的外部相依 ─────────
// 比照 agents/extract.js 的 _setLocalDepsForTest：正式執行時一律用 deps() 裡的預設實作；
// 測試注入假的 llm 與暫存附圖目錄，不呼叫任何模型、不寫進 data/figures/。
const depsOverride = {};

/** 一次 /analyze-pdf 請求的編號：UTC 時間到秒＋6 碼亂數，只含 [0-9-]＋小寫十六進位（過得了 wordService 的附圖檔名白名單） */
function newRunId() {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);   // YYYYMMDDHHMMSS
    return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function deps() {
    return {
        llm: depsOverride.llm || llm,
        models: depsOverride.models || null,
        cropFigures: depsOverride.cropFigures || ((opts) => require('./figureService').cropFigures(opts)),
        logger: depsOverride.logger || console,
        runId: depsOverride.runId || newRunId
    };
}

/** 測試用：換掉上面的外部相依；不帶參數＝全部還原成正式實作 */
function _setDepsForTest(overrides = {}) {
    for (const k of Object.keys(depsOverride)) delete depsOverride[k];
    Object.assign(depsOverride, overrides || {});
}

/** 組一個最小的 Ctx 給 agent 用（agent 自己不讀 process.env，第 3.1 條） */
function buildCtx(d = deps()) {
    return {
        llm: d.llm,
        db: null,
        job: null,
        jq: null,
        logger: d.logger,
        config: {
            models: d.models || { extract: models.MODEL_EXTRACT, verify: models.MODEL_VERIFY, text: models.MODEL_TEXT },   // 〔LM-15〕
            thresholds: {
                pdfChunkPages: intFromEnv('JOB_PDF_CHUNK_PAGES', DEFAULT_CHUNK_PAGES),
                inlineMaxBytes: intFromEnv('GEMINI_INLINE_MAX_BYTES', DEFAULT_INLINE_MAX_BYTES)
            }
        },
        signal: undefined
    };
}

/**
 * payload.extract 的一筆 → 舊流程前端認得的那六個鍵；裁出附圖的題多一個 `question_img`。
 *
 * 〔Owner 決策單 2026-09-25 B21〕附圖只「新增」一個鍵、沒有圖時鍵不存在，所以沒有附圖的題
 * 與補裁圖之前逐位元相同。鍵名刻意用 questions 表的欄位名：前端把整筆 {...q} 送回
 * batch-save-questions，入庫到管線同一個 question_img 欄位。figure_desc 併題幹的行為照舊（備援）。
 */
function toLegacyShape(q) {
    const figure = String(q.figure_desc ?? '').trim();
    const text = String(q.question_text ?? '');
    const shaped = {
        subject: q.subject,
        chapter: q.chapter,
        question_type: q.question_type,
        difficulty: q.difficulty,
        question_text: figure ? `${text}\n[附圖描述：${figure}]` : text,
        answer_text: q.answer_text
    };
    if (typeof q.figure_img === 'string' && q.figure_img) shaped.question_img = q.figure_img;
    return shaped;
}

/** 附圖檔名前綴：`legacy-<請求編號>-<idx>.png`，與管線的 `<jobId>-<idx>.png` 放同一個目錄、不會撞名 */
const LEGACY_FIGURE_PREFIX = 'legacy';

function hasFigureBox(q) {
    return Number.isInteger(q?.figure_page) && Array.isArray(q?.figure_box);
}

/**
 * 〔Owner 決策單 2026-09-25 B21〕舊流程補裁圖：委託管線的 services/figureService.js（同一套渲染＋裁切、
 * 同一個附圖目錄），`figure_img` 就地寫回各題。沒有 job 可掛，檔名前綴改用這次請求的編號：
 * 每次分析一組新檔名，重新分析同一份卷不會覆寫已入庫題目引用的圖。
 *
 * 失敗處理與管線一致——圖裁不出來只少圖、不少題：單題失敗由 cropFigures 逐題 try/catch 記 warn；
 * 整批失敗（mupdf 載不到、PDF 開不起來、目錄寫不進去）在這裡記 warn、回 0，題目照常回傳。
 * 已經寫出檔案的題（cropFigures 存檔成功後才寫 figure_img）保留它的圖。
 *
 * @param {Buffer} bytes             整份 PDF
 * @param {Array<object>} questions  payload.extract 形狀（figure_page 已是絕對頁碼）
 * @param {ReturnType<typeof deps>} d
 * @returns {Promise<number>} 裁出的張數
 */
async function attachFigures(bytes, questions, d) {
    if (!questions.some(hasFigureBox)) return 0;
    const jobId = `${LEGACY_FIGURE_PREFIX}-${d.runId()}`;
    try {
        const cropped = await d.cropFigures({ pdfBytes: bytes, jobId, questions, logger: d.logger });
        if (cropped > 0) d.logger.info?.({ msg: `[analyze-pdf] 已裁出 ${cropped} 張附圖`, run: jobId });
        return cropped;
    } catch (err) {
        d.logger.warn?.({ msg: '[analyze-pdf] 附圖裁切失敗（題目照常回傳，僅缺圖）', run: jobId, error: err.message });
        return 0;
    }
}

/**
 * 舊介面：吃 base64 的 PDF，回一個題目陣列。
 * @param {string} pdfBase64
 * @returns {Promise<Array<object>>}
 */
exports.analyzePdfContent = async (pdfBase64) => {
    const d = deps();
    const bytes = Buffer.from(String(pdfBase64 || ''), 'base64');
    const ctx = buildCtx(d);

    // 先問頁數才知道要切幾塊（pdf-lib 讀 header 很快，不需要另外呼叫模型）
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const chunks = extractAgent.planChunks(doc.getPageCount(), ctx.config.thresholds.pdfChunkPages);

    const collected = [];   // payload.extract 形狀；裁完圖才轉成舊形狀（toLegacyShape 會丟掉框）
    let rejectedTotal = 0;
    let lastFailure = null;

    for (const chunk of chunks) {
        const outcome = await extractAgent.run(ctx, { pdfBytes: bytes, chunk });

        if (outcome.kind === 'error') {
            const err = new Error(outcome.message || 'AI 拆題失敗');
            err.errorClass = outcome.errorClass;
            // JSON 壞掉沿用舊行為：aiController 認 SyntaxError 回 500「AI 回傳的 JSON 格式錯誤」
            if (outcome.errorClass === 'schema_invalid') err.name = 'SyntaxError';
            throw err;
        }

        if (outcome.kind === 'fail') {
            // 整塊都沒過驗證：記下來繼續下一塊，不要因為第 3 塊壞掉就丟掉前兩塊的成果
            rejectedTotal += (outcome.data && outcome.data.rejected ? outcome.data.rejected.length : 0);
            lastFailure = outcome.feedback || outcome.reason;
            console.warn(`[analyze-pdf] 第 ${chunk.no} 塊（第 ${chunk.fromPage}~${chunk.toPage} 頁）整塊未通過驗證：${lastFailure}`);
            continue;
        }

        rejectedTotal += (outcome.data.rejected || []).length;
        for (const q of outcome.data.questions) collected.push(q);
    }

    if (collected.length === 0 && rejectedTotal > 0) {
        const err = new SyntaxError(`AI 拆出 ${rejectedTotal} 題但全部沒有通過欄位驗證：${lastFailure || '章節或題型不在白名單內'}`);
        throw err;
    }

    if (rejectedTotal > 0) {
        console.warn(`[analyze-pdf] 共丟棄 ${rejectedTotal} 題（未通過 schema 驗證），回傳 ${collected.length} 題。`);
    }

    // 〔Owner 決策單 2026-09-25 B21〕PDF 還在記憶體裡，整份一次裁（同頁多圖只渲染一次）；attachFigures 不會 throw
    await attachFigures(bytes, collected, d);

    return collected.map(toLegacyShape);
};

exports.toLegacyShape = toLegacyShape;
exports.LEGACY_FIGURE_PREFIX = LEGACY_FIGURE_PREFIX;
exports._setDepsForTest = _setDepsForTest;
