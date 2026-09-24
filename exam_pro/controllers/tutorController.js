// ─────────────────────────────────────────────────────────────
// controllers/tutorController.js — POST /api/tutor、POST /api/voice/transcribe（階段 5 WS-E）
//
// 契約：docs/interfaces-stage5.md 第 4.5 條第 2、3 點。
//
// 薄殼：驗證與流程都在 services/tutorService.js、services/voiceService.js（可注入、可單元測試），
// 這裡只做 HTTP 轉譯：
//   400 參數不合法（{ message }）       404 題目或學生不存在
//   413 錄音超過 5 MB                   429 今日預算用完（每分鐘限流的 429 由 middleware/rateLimit 回）
//   502 LLM 端失敗（供應商錯誤、replay miss、逾時、模型輸出格式不符）——「家教暫時無法回應」
//   其餘（DB 錯誤等）交給 app.js 的全域錯誤中樞（500），不冒充成供應商的問題
//
// 兩條路由只在旗標開啟時掛載（routes/index.js 檔尾的 WS-E 區塊）：
//   FEATURE_TUTOR                     → POST /api/tutor
//   FEATURE_TUTOR 且 FEATURE_VOICE    → POST /api/voice/transcribe
// ─────────────────────────────────────────────────────────────
const tutorService = require('../services/tutorService');
const voiceService = require('../services/voiceService');

/** service 層以 httpError 標好的狀態碼；其餘錯誤沒有這個標記 */
const PASS_THROUGH = new Set([400, 404, 413, 429, 502]);

function sendError(req, res, next, err) {
    if (err && PASS_THROUGH.has(err.status)) return res.status(err.status).json({ message: err.message });
    return next(err);
}

/**
 * 每分鐘限流的上限（TUTOR_RATE_LIMIT_PER_MIN、VOICE_RATE_LIMIT_PER_MIN；第 4.5 條預設 10）。
 * routes/index.js 掛載時讀一次；非正整數一律退回預設。
 * @param {string} name 環境變數名
 * @param {number} [fallback=10]
 * @param {object} [env=process.env]
 * @returns {number}
 */
function rateLimitPerMin(name, fallback = 10, env = process.env) {
    const raw = String(env[name] ?? '').trim();
    if (!/^\d+$/.test(raw)) return fallback;
    const n = Number(raw);
    return n > 0 ? n : fallback;
}

/** POST /api/tutor */
exports.chat = async (req, res, next) => {
    try {
        const out = await tutorService.runTutor(req.body || {});
        res.status(200).json(out);
    } catch (err) {
        sendError(req, res, next, err);
    }
};

/** POST /api/voice/transcribe（multer memoryStorage 之後；req.file.buffer 只活在這一次請求） */
exports.transcribe = async (req, res, next) => {
    try {
        const out = await voiceService.transcribe({ file: req.file, subject: (req.body || {}).subject });
        res.status(200).json(out);
    } catch (err) {
        sendError(req, res, next, err);
    } finally {
        // 音訊不落地，也不要比這個請求活得更久（ADR-013）
        if (req.file) req.file.buffer = null;
    }
};

/**
 * multer 的錯誤轉成 413／400（預設會落到 app.js 的全域中樞變成 500）。
 * 四參數：Express 依參數個數判定它是錯誤處理中介軟體。
 */
exports.handleVoiceUploadError = (err, req, res, next) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: '錄音檔過大，單次最多 5 MB（約數分鐘），請分段說。' });
    }
    if (err.code && String(err.code).startsWith('LIMIT_')) {
        // LIMIT_UNEXPECTED_FILE（欄位名不是 audio）、LIMIT_FILE_COUNT、LIMIT_FIELD_* 等
        return res.status(400).json({ message: `上傳格式不符（${err.code}）：請以 multipart 欄位 audio 上傳單一錄音檔。` });
    }
    return next(err);
};

exports.rateLimitPerMin = rateLimitPerMin;
