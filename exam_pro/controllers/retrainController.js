// ─────────────────────────────────────────────────────────────
// controllers/retrainController.js — 錯題重練清單的四支 API（PR-2；docs/retrain-and-review.md 第 5.2 節）
//
//   API-1  GET   /api/students/:id/retrain-items?status=&subject=&as_of=   清單（排序同第 4.7 節）
//   API-2  POST  /api/students/:id/retrain-items                            以題號手動加入
//   API-3  PATCH /api/students/:id/retrain-items/:itemId                    移出／判定已會／重新加入
//   API-4  GET   /api/retrain/summary?as_of=                                學生清單的到期徽章
//   API-5  POST  /api/students/:id/retrain-paper                            〔PR-3〕出一份重練卷的草稿（只讀）
//   API-13 GET   /api/students/:id/retrain-stats?days=&subject=             重練成效（〔retrain PR-4〕）
//
// 只在 FEATURE_RETRAIN 開啟時掛載（routes/index.js 檔尾的錯題重練區塊；關閉時落到 Express 預設 404）。
// 全部不呼叫 LLM，不套限流（同裁決 S5-25 對 WS-D 四支端點的處理）。回應不含學生姓名（API-4 以 id 對應既有學生清單）。
//
// 慣例：路徑上的 :id／:itemId 不合法一律 404（同 studentController）；參數與 body 嚴格驗證、不認得的鍵 400
// （同裁決 S5-21；驗證是純函式，在 utils/retrainValidation.js）；會寫入的兩支在單一交易內寫入＋重算，全有全無。
// ─────────────────────────────────────────────────────────────
const v = require('../utils/retrainValidation');
const retrain = require('../services/retrainService');
// 〔retrain PR-3〕API-5 出一份重練卷的草稿
const retrainSelect = require('../services/retrainSelect');
const retrainStats = require('../services/retrainStatsService');   // 〔retrain PR-4〕API-13

// config/db 缺 DATABASE_URL 就在 require 當下丟錯；延遲到第一次查詢才載入（同 kcController 的做法）
const db = {
    query: (...args) => require('../config/db').query(...args),
    get pool() { return require('../config/db').pool; }
};

const STUDENT_NOT_FOUND = '找不到該學生';
const ITEM_NOT_FOUND = '找不到該重練項目';

/** 在單一交易內執行 fn(client)；fn 回 { commit:false } 時回滾。 */
async function inTransaction(fn) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query(out && out.commit === false ? 'ROLLBACK' : 'COMMIT');
        return out;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        throw err;
    } finally {
        client.release();
    }
}

async function studentExists(run, id) {
    const { rows } = await run.query('SELECT 1 FROM students WHERE id = $1', [id]);
    return rows.length > 0;
}

/** API-1 */
exports.listItems = async (req, res, next) => {
    const studentId = v.parseStudentId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const today = retrain.todayLocal();
    const parsed = v.parseListQuery(req.query, { today });
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await retrain.listItems(db.query, studentId,
            { status: parsed.status, subject: parsed.subject, asOf: parsed.asOf, today });
        if (!out) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        res.status(200).json(out);
    } catch (err) {
        next(err);
    }
};

/** API-2 */
exports.addItems = async (req, res, next) => {
    const studentId = v.parseStudentId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = v.parseAddBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await inTransaction(async client => {
            if (!(await studentExists(client, studentId))) return { commit: false, notFound: true };
            return retrain.addManual(client, studentId, parsed.questionIds, { today: retrain.todayLocal() });
        });
        if (out.notFound) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        res.status(200).json({ added: out.added, skipped: out.skipped });
    } catch (err) {
        next(err);
    }
};

/** API-3 */
exports.patchItem = async (req, res, next) => {
    const studentId = v.parseStudentId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const itemId = v.parseItemId(req.params.itemId);
    if (itemId === null) return res.status(404).json({ message: ITEM_NOT_FOUND });
    const parsed = v.parseActionBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await inTransaction(async client => {
            if (!(await studentExists(client, studentId))) return { commit: false, status: 404, message: STUDENT_NOT_FOUND };
            const r = await retrain.applyAction(client, studentId, itemId, parsed, { today: retrain.todayLocal() });
            if (r.status === 404) return { commit: false, status: 404, message: ITEM_NOT_FOUND };
            if (r.status !== 200) return { commit: false, ...r };
            return r;
        });
        if (out.status !== 200) return res.status(out.status).json({ message: out.message });
        res.status(200).json({ ...out.item, group_changed: out.group_changed });
    } catch (err) {
        next(err);
    }
};

/**
 * 〔retrain PR-3〕API-5 POST /api/students/:id/retrain-paper — 一份純重練卷的草稿（只讀、不寫庫；第 5.2 節）。
 * body { subject?, count?(1–50，預設 10), as_of?, include_not_due?(預設 false) }。
 * 挑法見 services/retrainSelect.js：第 4.7 節的排序、承上組整組放不下 → 400 不產生草稿（R12 選 2）。
 * 確認走 API-7：confirm-paper { student_id, question_ids, retrain_question_ids: question_ids }，
 * 卷名「<姓名>-錯題重練卷(日期)」在確認時產生（這裡不讀學生姓名）。
 */
exports.retrainPaper = async (req, res, next) => {
    const studentId = v.parseStudentId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const today = retrain.todayLocal();
    const parsed = v.parseRetrainPaperBody(req.body, { today });
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        if (!(await studentExists(db, studentId))) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        const out = await retrainSelect.buildRetrainDraft(db.query, {
            studentId, subject: parsed.subject, count: parsed.count, asOf: parsed.asOf,
            includeNotDue: parsed.includeNotDue, today
        });
        if (out.error) return res.status(400).json({ message: out.error.message });
        res.status(200).json(out.draft);
    } catch (err) {
        next(err);
    }
};

/** API-4 */
exports.summary = async (req, res, next) => {
    const today = retrain.todayLocal();
    const parsed = v.parseSummaryQuery(req.query, { today });
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        res.status(200).json(await retrain.summary(db.query, { asOf: parsed.asOf, today }));
    } catch (err) {
        next(err);
    }
};

/**
 * 〔retrain PR-4〕API-13 GET /api/students/:id/retrain-stats?days=&subject=（重練成效；R10 選 1）。
 * 回應形狀與各欄的語意在 services/retrainStatsService.js 檔頭。只讀、不寫庫。
 */
exports.stats = async (req, res, next) => {
    const studentId = v.parseStudentId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = v.parseStatsQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await retrainStats.stats(db.query, studentId,
            { days: parsed.days, subject: parsed.subject, today: retrain.todayLocal() });
        if (!out) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        res.status(200).json(out);
    } catch (err) {
        next(err);
    }
};
