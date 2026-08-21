const express = require('express');
const router = express.Router();
const multer = require('multer');
const createRateLimiter = require('../middleware/rateLimit');

// 設定檔案上傳暫存目錄
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 15 * 1024 * 1024 }
});

// AI 解析屬於高成本操作（呼叫 Gemini），限制每來源每分鐘最多 10 次
const aiRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'AI 解析請求過於頻繁，請稍候再試（每分鐘最多 10 次）。'
});

// 載入 Controllers
const questionController = require('../controllers/questionController');
const examController = require('../controllers/examController');
const aiController = require('../controllers/aiController');
const wordController = require('../controllers/wordController');

// 定義路由
router.get('/questions', questionController.listQuestions);
router.post('/questions', questionController.createQuestion);
router.put('/questions/:id', questionController.updateQuestion);
router.delete('/questions/:id', questionController.deleteQuestion);
router.post('/batch-save-questions', questionController.batchSaveQuestions);
router.get('/chapters', questionController.getChapters);
router.get('/chapter-whitelist', questionController.getChapterWhitelist);

router.post('/generate-paper', examController.generatePaper);
router.post('/analyze-pdf', aiRateLimit, upload.single('pdf'), aiController.analyzePdf);
router.post('/download-word', wordController.downloadWord);

// ─────────────────────────────────────────────────────────────
// 階段 1 平行開發用的 append-only 區塊（名稱凍結於 docs/interfaces.md 第 10.2 條）
// 各 workstream 只在自己的區塊內加行，不重排既有路由；rebase 衝突只會落在相鄰行，兩邊都保留即可。
// ─────────────────────────────────────────────────────────────

// ===== [WS-A: DB] =====
// ===== [/WS-A: DB] =====

// ===== [WS-B: ops] =====
// ===== [/WS-B: ops] =====

// ===== [WS-C: retrieval] =====
// GET /api/questions/:id/similar — 相似題（docs/interfaces.md 第 6 條）
// FEATURE_SIMILAR 未開啟時「不掛載」這條路由，因此請求會落到 Express 的預設 404。
// 查詢向量直接取來源題的 embedding，不呼叫 Gemini，所以本端點可離線、可進 CI。
const retrievalService = require('../services/retrievalService');
if (retrievalService.isSimilarEnabled()) {
    const similarRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
    router.get('/questions/:id/similar', similarRateLimit, retrievalService.similarQuestionsHandler);
}
// ===== [/WS-C: retrieval] =====

// ===== [WS-D: eval] =====
// ===== [/WS-D: eval] =====

// ─────────────────────────────────────────────────────────────
// 階段 2（Agent 管線）的 append-only 區塊
// 名稱凍結於 docs/interfaces-stage2.md 第 10 條；規則與階段 1 相同：
// 各 workstream 只在自己的區塊內加行，不重排既有路由，rebase 衝突兩邊都保留。
// 六支 jobs／review API 一律掛在 apiKeyAuth 之後（app.js 已對 /api 全域套用）。
// ─────────────────────────────────────────────────────────────

// ===== [WS2-A: jobs] =====
// ===== [/WS2-A: jobs] =====

// ===== [WS2-B: llm] =====
// ===== [/WS2-B: llm] =====

// ===== [WS2-C: gates] =====
// ===== [/WS2-C: gates] =====

// ===== [WS2-D: eval] =====
// ===== [/WS2-D: eval] =====

module.exports = router;