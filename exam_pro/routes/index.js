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
router.post('/questions/batch-source', questionController.batchSourceTag); // 批次補標題源（0007）
router.get('/chapters', questionController.getChapters);
router.get('/chapter-whitelist', questionController.getChapterWhitelist);
router.get('/chapter-volumes', questionController.getChapterVolumes);

router.post('/generate-paper', examController.generatePaper);

// ── 階段 4（docs/roadmap-plan.md §6.2）：學生管理與出卷生命週期 ──
// 核心功能、不掛 FEATURE_* 旗標：組卷（選學生、確認、刪卷）不該被展示用旗標關掉。
// GET /students 依裁決 S4-2 從下方 [WS3-A: students] 區塊搬上來（組卷下拉恆常需要）。
const studentAdminController = require('../controllers/studentAdminController');
const studentListController = require('../controllers/studentController');
router.get('/students', studentListController.listStudents);
router.post('/students', studentAdminController.createStudent);
router.patch('/students/:id', studentAdminController.renameStudent);
router.delete('/students/:id', studentAdminController.deleteStudent);
router.post('/students/:id/merge', studentAdminController.mergeStudent);
router.post('/confirm-paper', examController.confirmPaper);
router.delete('/papers/:id', examController.deletePaper);
router.post('/analyze-pdf', aiRateLimit, upload.single('pdf'), aiController.analyzePdf);
router.post('/download-word', wordController.downloadWord);

// ─────────────────────────────────────────────────────────────
// 階段 1 平行開發用的 append-only 區塊（名稱凍結於 docs/interfaces-stage1.md 第 10.2 條）
// 各 workstream 只在自己的區塊內加行，不重排既有路由；rebase 衝突只會落在相鄰行，兩邊都保留即可。
// ─────────────────────────────────────────────────────────────

// ===== [WS-A: DB] =====
// ===== [/WS-A: DB] =====

// ===== [WS-B: ops] =====
// ===== [/WS-B: ops] =====

// ===== [WS-C: retrieval] =====
// GET /api/questions/:id/similar — 相似題（docs/interfaces-stage1.md 第 6 條）
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

    // GET /students 已依裁決 S4-2 搬到上方核心區（組卷下拉恆常需要，不該吃這個旗標）
    router.get('/students/:id/papers', studentController.listStudentPapers);
    router.get('/students/:id/weakness', studentController.getWeakness);
    router.get('/papers/:id', paperController.getPaper);
    router.patch('/papers/:id/results', paperController.patchResults);
}
// ===== [/WS3-A: students] =====

// ===== [WS3-B: variants] =====
// POST /api/questions/:id/variants — 相似題／變式題（docs/interfaces-stage3.md 第 3 條，P-10）
// FEATURE_VARIANTS 未開啟時「不掛載」這條路由，請求落到 Express 預設 404（與 FEATURE_SIMILAR 同做法）。
// 限流 10/min 與 /analyze-pdf、POST /api/jobs 同一個等級，但**是各自獨立的桶**
// （createRateLimiter 每次呼叫都是一個新的 Map，不共用計數器）。
const variantService = require('../services/variantService');
if (variantService.isVariantsEnabled()) {
    const variantRateLimit = createRateLimiter({
        windowMs: 60 * 1000,
        max: 10,
        message: '變式題請求過於頻繁，請稍候再試（每分鐘最多 10 次）。'
    });
    router.post('/questions/:id/variants', variantRateLimit, variantService.variantsHandler);
}
// ===== [/WS3-B: variants] =====

// ===== [WS3-C: nlq] =====
// POST /api/questions/search-nl — 自然語言查題（docs/interfaces-stage3.md 第 6 條，P-08）
// FEATURE_NLQ 未開啟時「不掛載」這條路由，因此請求會落到 Express 的預設 404。
// 限流 30/min（第 6 條），與 aiRateLimit 的 10/min 分開：這一支多數請求只跑規則解析，
// 不會產生費用，用同一個桶會讓查題把 PDF 拆題的額度吃光。
const nlqService = require('../services/nlqService');
if (nlqService.isNlqEnabled()) {
    const nlqRateLimit = createRateLimiter({
        windowMs: 60 * 1000,
        max: 30,
        message: '自然語言查題請求過於頻繁，請稍候再試（每分鐘最多 30 次）。'
    });
    router.post('/questions/search-nl', nlqRateLimit, nlqService.searchNlHandler);
}
// ===== [/WS3-C: nlq] =====

// ===== [WS3-D: frontend] =====
// ===== [/WS3-D: frontend] =====

// ── 階段 4 A1：對話式助教（主控 agent + 只讀工具）──
// FEATURE_ASSISTANT 未開啟時不掛載（與其他旗標同一種做法：落到 Express 預設 404）。
// 這條會呼叫 LLM（花錢），所以沿用 NLQ 的節流殼——同一人狂按送出不該變成帳單。
const featuresS4 = require('../config/features');
if (featuresS4.FEATURE_ASSISTANT) {
    const assistantController = require('../controllers/assistantController');
    const assistantRateLimit = createRateLimiter({
        windowMs: 60 * 1000,
        max: 10,
        message: '助教請求過於頻繁，請稍候再試（每分鐘最多 10 次）。'
    });
    router.post('/assistant', assistantRateLimit, assistantController.chat);
}

// ── 階段 5 WS-A：資料地基——批改細節、學生檔案、文字詳解（docs/interfaces-stage5.md 第 4.1 條）──
// WS-A 不另加旗標（第 1.3 條）：擴充既有端點都改在原本的 controller（PATCH /papers/:id/results、
// /students、/questions、/download-word），這裡只掛三支新的**唯讀**端點，全部不呼叫 LLM。
//   GET /questions/:id              題目詳情（含詳解；已封存的題也查得到）——核心區
//   GET /student-profile-options    學生檔案表單的選項（config/studentProfile.js）——核心區
//   GET /error-types                錯因白名單（config/errorTypes.js）——只給批改與弱點面板用，
//                                   跟著 FEATURE_STUDENTS：旗標關閉時不掛載，落到 Express 預設 404
{
    const questionControllerWs5A = require('../controllers/questionController');
    const studentAdminControllerWs5A = require('../controllers/studentAdminController');
    router.get('/questions/:id', questionControllerWs5A.getQuestion);
    router.get('/student-profile-options', studentAdminControllerWs5A.getProfileOptions);
    if (require('../config/features').FEATURE_STUDENTS) {
        const { ERROR_TYPES, MAX_ERROR_TYPES } = require('../config/errorTypes');
        router.get('/error-types', (req, res) => {
            res.status(200).json({ items: ERROR_TYPES, max_per_attempt: MAX_ERROR_TYPES });
        });
    }
}

// ── 階段 5 WS-C：知識點（docs/interfaces-stage5.md 第 4.3 條）──
// FEATURE_KC 關閉時四條都不掛載（落到 Express 預設 404，與 FEATURE_ASSISTANT 同一種做法）。
// 這四支都不呼叫 LLM（自動標註走管線掛鉤與 npm run kc:backfill），限流只是防呆：
// 120/min 對「逐張審定口語版」的操作綽綽有餘，同時是獨立的桶，不吃其他 API 的額度。
// 變數名帶 WsC5 後綴，理由同上方 featuresWs3A：合併後不會撞到別的區塊的 const。
const featuresWsC5 = require('../config/features');
if (featuresWsC5.FEATURE_KC) {
    const kcController = require('../controllers/kcController');
    const kcRateLimit = createRateLimiter({
        windowMs: 60 * 1000,
        max: 120,
        message: '知識點請求過於頻繁，請稍候再試（每分鐘最多 120 次）。'
    });
    router.get('/kc', kcRateLimit, kcController.listKc);
    router.patch('/kc/:id', kcRateLimit, kcController.patchKc);
    router.get('/questions/:id/kcs', kcRateLimit, kcController.getQuestionKcs);
    router.put('/questions/:id/kcs', kcRateLimit, kcController.putQuestionKcs);
}

// ── 階段 5 WS-D：出題閉環（docs/interfaces-stage5.md 第 4.4 條）──
// 知識點弱點、補救卷草稿（＋手動加題前的題目查詢）、題庫覆蓋率。FEATURE_REMEDIAL 未開啟時不掛載（落到 Express 預設 404）。
// 全部都不呼叫 LLM、不寫庫，不套限流（第 1.2 條的限流針對會花錢的端點）。
// 跨章配額（blueprint）是既有 POST /generate-paper 的擴充，改在 examController，不另開路由（第 1.4 條）。
const featuresS5D = require('../config/features');
if (featuresS5D.FEATURE_REMEDIAL) {
    const remedialController = require('../controllers/remedialController');
    router.get('/students/:id/weakness/kc', remedialController.getKcWeakness);
    router.post('/students/:id/remedial-paper', remedialController.remedialPaper);
    router.get('/students/:id/remedial-paper/items', remedialController.remedialItems);
    router.get('/coverage', remedialController.getCoverage);
}

// ── 階段 5 WS-E：AI 家教與按住說話（docs/interfaces-stage5.md 第 4.5 條）──
// FEATURE_TUTOR 關閉時兩條都不掛載；FEATURE_VOICE 需同時開 FEATURE_TUTOR（第 1.3 條）。
// 兩條都會呼叫 LLM（花錢），各自一個限流桶（createRateLimiter 每次呼叫都是新的 Map）。
// 錄音用 memoryStorage：音訊只活在這一次請求的記憶體裡，不落地（ADR-013）；
// 上方既有的 upload（dest: 'uploads/'）會寫暫存檔，所以不沿用。
const featuresS5E = require('../config/features');
if (featuresS5E.FEATURE_TUTOR) {
    const tutorController = require('../controllers/tutorController');
    const tutorPerMin = tutorController.rateLimitPerMin('TUTOR_RATE_LIMIT_PER_MIN', 10);
    const tutorRateLimit = createRateLimiter({
        windowMs: 60 * 1000,
        max: tutorPerMin,
        message: `AI 家教請求過於頻繁，請稍候再試（每分鐘最多 ${tutorPerMin} 次）。`
    });
    router.post('/tutor', tutorRateLimit, tutorController.chat);

    // 〔本機模式 L1，docs/local-mode.md 第 3 條第 9 點〕MODEL_VOICE 不是 gemini 時，FEATURE_VOICE=true 也不掛載
    // （本機模型不收音訊），啟動時印一行警告。判斷只有 voiceService.voiceStatus() 一份，前端的 meta 也該讀它。
    const voiceStatusS5E = require('../services/voiceService').voiceStatus();
    if (voiceStatusS5E.status === 'local') console.warn(`[voice] ${voiceStatusS5E.message}`);
    if (voiceStatusS5E.available) {
        const voicePerMin = tutorController.rateLimitPerMin('VOICE_RATE_LIMIT_PER_MIN', 10);
        const voiceRateLimit = createRateLimiter({
            windowMs: 60 * 1000,
            max: voicePerMin,
            message: `語音轉寫請求過於頻繁，請稍候再試（每分鐘最多 ${voicePerMin} 次）。`
        });
        const voiceUpload = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 }
        });
        router.post('/voice/transcribe', voiceRateLimit, voiceUpload.single('audio'),
            tutorController.handleVoiceUploadError, tutorController.transcribe);
    }
}

// ── 錯題重練與間隔複習 第二階段（docs/retrain-and-review.md 第 5.2 節 API-1～5、API-13）──
// FEATURE_RETRAIN 關閉時這六條都不掛載（落到 Express 預設 404，與其他旗標同一種做法）。
// 全部不呼叫 LLM，不套限流（同裁決 S5-25）。批改（API-10）、試卷明細（API-9）、刪卷（API-11）、
// 出卷整合（API-6～8、API-12）是既有端點的擴充，改在原本的 controller。
// 變數名帶 Retrain 後綴，理由同上方 featuresWs3A：合併後不會撞到別的區塊的 const。
const featuresRetrain = require('../config/features');
if (featuresRetrain.FEATURE_RETRAIN) {
    const retrainController = require('../controllers/retrainController');
    router.get('/students/:id/retrain-items', retrainController.listItems);
    router.post('/students/:id/retrain-items', retrainController.addItems);
    router.patch('/students/:id/retrain-items/:itemId', retrainController.patchItem);
    router.get('/retrain/summary', retrainController.summary);
    // 〔retrain PR-3〕API-5：出一份重練卷的草稿（只讀；確認走既有的 POST /confirm-paper 加 retrain_question_ids）。
    // API-6～8、API-12 是既有端點的擴充，改在原本的 controller（examController、remedialController、wordController）。
    router.post('/students/:id/retrain-paper', retrainController.retrainPaper);
    // 〔retrain PR-4〕API-13 重練成效（第 5.2 節；R10 選 1）。同一個旗標、同一種掛法。
    router.get('/students/:id/retrain-stats', retrainController.stats);
}

module.exports = router;