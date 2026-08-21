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
// ===== [/WS-C: retrieval] =====

// ===== [WS-D: eval] =====
// ===== [/WS-D: eval] =====

module.exports = router;