const express = require('express');
const router = express.Router();
const multer = require('multer');

// 設定檔案上傳暫存目錄
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 15 * 1024 * 1024 }
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
router.post('/analyze-pdf', upload.single('pdf'), aiController.analyzePdf);
router.post('/download-word', wordController.downloadWord);

module.exports = router;