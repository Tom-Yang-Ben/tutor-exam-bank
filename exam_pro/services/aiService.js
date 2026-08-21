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

const llm = require('./llm');
const models = require('../config/models');
const extractAgent = require('../agents/extract');

const DEFAULT_CHUNK_PAGES = 20;
const DEFAULT_INLINE_MAX_BYTES = 15728640;

function intFromEnv(name, fallback) {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 組一個最小的 Ctx 給 agent 用（agent 自己不讀 process.env，第 3.1 條） */
function buildCtx() {
    return {
        llm,
        db: null,
        job: null,
        jq: null,
        logger: console,
        config: {
            models: { extract: models.MODEL_EXTRACT, verify: models.MODEL_VERIFY },
            thresholds: {
                pdfChunkPages: intFromEnv('JOB_PDF_CHUNK_PAGES', DEFAULT_CHUNK_PAGES),
                inlineMaxBytes: intFromEnv('GEMINI_INLINE_MAX_BYTES', DEFAULT_INLINE_MAX_BYTES)
            }
        },
        signal: undefined
    };
}

/** payload.extract 的一筆 → 舊流程前端認得的那六個鍵 */
function toLegacyShape(q) {
    const figure = String(q.figure_desc ?? '').trim();
    const text = String(q.question_text ?? '');
    return {
        subject: q.subject,
        chapter: q.chapter,
        question_type: q.question_type,
        difficulty: q.difficulty,
        question_text: figure ? `${text}\n[附圖描述：${figure}]` : text,
        answer_text: q.answer_text
    };
}

/**
 * 舊介面：吃 base64 的 PDF，回一個題目陣列。
 * @param {string} pdfBase64
 * @returns {Promise<Array<object>>}
 */
exports.analyzePdfContent = async (pdfBase64) => {
    const bytes = Buffer.from(String(pdfBase64 || ''), 'base64');
    const ctx = buildCtx();

    // 先問頁數才知道要切幾塊（pdf-lib 讀 header 很快，不需要另外呼叫模型）
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const chunks = extractAgent.planChunks(doc.getPageCount(), ctx.config.thresholds.pdfChunkPages);

    const collected = [];
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
        for (const q of outcome.data.questions) collected.push(toLegacyShape(q));
    }

    if (collected.length === 0 && rejectedTotal > 0) {
        const err = new SyntaxError(`AI 拆出 ${rejectedTotal} 題但全部沒有通過欄位驗證：${lastFailure || '章節或題型不在白名單內'}`);
        throw err;
    }

    if (rejectedTotal > 0) {
        console.warn(`[analyze-pdf] 共丟棄 ${rejectedTotal} 題（未通過 schema 驗證），回傳 ${collected.length} 題。`);
    }

    return collected;
};
