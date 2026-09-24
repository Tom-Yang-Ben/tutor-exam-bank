// ─────────────────────────────────────────────────────────────
// controllers/kcController.js — 知識點 API（階段 5，擁有者：WS-C）
//
// 契約：docs/interfaces-stage5.md 第 4.3 條第 2 點。四支都掛在 FEATURE_KC 之後
// （routes/index.js 檔尾的 WS-C 區塊；旗標關閉時不掛載，落到 Express 預設 404）。
//
//   GET   /api/kc?subject=&chapter=&status=   → { items: [...] }
//   PATCH /api/kc/:id                          → 更新後的那一列（形狀同 items[i]）
//   GET   /api/questions/:id/kcs               → [{ kc_id, code, name, weight, src, confidence }]
//         ?detail=1                            → { question: {...}, items: [...] }（前端小工具用的附加形狀）
//   PUT   /api/questions/:id/kcs               → 以 src='human' 取代該題全部標註，回同 GET 的陣列
//
// 驗證失敗一律 400 { message }；找不到一律 404 { message }。邏輯都在 services/kcService.js，
// 這一層只做「HTTP ↔ 函式」的轉接。
// ─────────────────────────────────────────────────────────────
const kc = require('../services/kcService');

// config/db 缺 DATABASE_URL 就在 require 當下丟錯；延遲到第一次查詢才載入，
// 本檔的純函式（_wantsDetail）才能在不連 DB 的單元測試裡被 require（同 assistantService 的做法）。
const db = {
    query: (...args) => require('../config/db').query(...args),
    get pool() { return require('../config/db').pool; }
};
const { defaultChapters } = require('../utils/kcSeed');

const BAD_ID = 'id 必須是正整數。';

/** GET /api/kc */
exports.listKc = async (req, res, next) => {
    const parsed = kc.parseListQuery(req.query, defaultChapters());
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const items = await kc.listKcs(db, parsed);
        res.status(200).json({ items });
    } catch (err) {
        next(err);
    }
};

/** PATCH /api/kc/:id */
exports.patchKc = async (req, res, next) => {
    const id = kc.parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: BAD_ID });
    const parsed = kc.validateKcPatch(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await kc.patchKc(db, id, parsed.fields);
        if (out.status !== 200) return res.status(out.status).json({ message: out.message });
        res.status(200).json(out.item);
    } catch (err) {
        next(err);
    }
};

/**
 * `?detail=1`：附上題目的科目、章節與題幹，讓「題目 → 知識點」小工具不必另外查題目
 * （題庫沒有「以 id 取單題」的 API）。沒帶時回傳形狀**逐字照契約**：一個陣列。
 * @param {object} query
 */
function wantsDetail(query) {
    const v = String((query && query.detail) ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** GET /api/questions/:id/kcs */
exports.getQuestionKcs = async (req, res, next) => {
    const id = kc.parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: BAD_ID });
    try {
        const out = await kc.getQuestionKcs(db, id);
        if (!out) return res.status(404).json({ message: '找不到該題目。' });
        res.status(200).json(wantsDetail(req.query) ? out : out.items);
    } catch (err) {
        next(err);
    }
};

/** PUT /api/questions/:id/kcs */
exports.putQuestionKcs = async (req, res, next) => {
    const id = kc.parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: BAD_ID });
    const parsed = kc.parseQuestionKcsBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const out = await kc.replaceQuestionKcs(db, id, parsed.items);
        if (out.status !== 200) return res.status(out.status).json({ message: out.message });
        res.status(200).json(out.items);
    } catch (err) {
        next(err);
    }
};

// 給單元測試
exports._wantsDetail = wantsDetail;