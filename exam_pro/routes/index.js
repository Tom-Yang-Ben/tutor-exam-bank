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
// 六支 jobs／review API（docs/interfaces-stage2.md 第 6 條，A-T12）。
// 沿用上方既有的 upload（15 MB 上限）與 aiRateLimit（每分鐘 10 次），不另建一份。
const jobController = require('../controllers/jobController');
const reviewController = require('../controllers/reviewController');

// upload.single 後面那支四參數中介軟體是「這條路由專屬」的錯誤處理：
// multer 的 LIMIT_FILE_SIZE 預設會落到 app.js 的全域中樞變成 500，
// 這裡把它轉成第 6.1 條凍結的 413。/analyze-pdf 的既有行為完全不動。
router.post('/jobs', aiRateLimit, upload.single('pdf'), jobController.handleUploadError, jobController.createJob);
router.get('/jobs/:id', jobController.getJob);
router.get('/jobs/:id/questions', jobController.listJobQuestions);
router.post('/jobs/:id/retry', jobController.retryJob);

router.get('/review', reviewController.listReview);
router.get('/review/:jqId', reviewController.getReviewItem);
router.post('/review/:jqId/approve', reviewController.approve);
router.post('/review/:jqId/reject', reviewController.reject);
// ===== [/WS2-A: jobs] =====

// ===== [WS2-B: llm] =====
// ===== [/WS2-B: llm] =====

// ===== [WS2-C: gates] =====
// ===== [/WS2-C: gates] =====

// ===== [WS2-D: eval] =====
// ===== [/WS2-D: eval] =====

// ─────────────────────────────────────────────────────────────
// 階段 3（產品面與 RAG 三落點）的 append-only 區塊
// 名稱凍結於 docs/interfaces-stage3.md 第 10.2 條；規則與前兩階段相同：
// 各 workstream 只在自己的區塊內加行，不重排既有路由，rebase 衝突兩邊都保留。
// 五支學生／試卷 API、變式題、自然語言查題全部掛在 apiKeyAuth 之後
// （app.js 已對 /api 全域套用）；三個 FEATURE_* 關閉時「不掛載」對應路由，
// 請求落到 Express 預設 404（與 FEATURE_SIMILAR 同一種做法）。
// ─────────────────────────────────────────────────────────────

// ===== [WS3-A: students] =====
// 五支學生／試卷／批改／弱點 API（docs/interfaces-stage3.md 第 1 條，P-04）。
// FEATURE_STUDENTS 未開啟時「不掛載」這五條路由，請求會落到 Express 的預設 404
// （與上方 FEATURE_SIMILAR 同一種做法）。
//
// 變數名帶 Ws3A 前綴是為了 rebase：四個階段 3 區塊都可能要 require config/features，
// 用同一個 const 名稱會在合併後變成「已宣告」的語法錯誤，而衝突只落在相鄰行時
// 兩邊都保留正是本檔的合併規則。
const featuresWs3A = require('../config/features');
if (featuresWs3A.FEATURE_STUDENTS) {
    const studentController = require('../controllers/studentController');
    const paperController = require('../controllers/paperController');

    router.get('/students', studentController.listStudents);
    router.get('/students/:id/papers', studentController.listStudentPapers);
    router.get('/students/:id/weakness', studentController.getWeakness);
    router.get('/papers/:id', paperController.getPaper);
    router.patch('/papers/:id/results', paperController.patchResults);
}
// ===== [/WS3-A: students] =====

// ===== [WS3-B: variants] =====
// ===== [/WS3-B: variants] =====

// ===== [WS3-C: nlq] =====
// ===== [/WS3-C: nlq] =====

// ===== [WS3-D: frontend] =====
// ===== [/WS3-D: frontend] =====

module.exports = router;