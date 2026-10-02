// ─────────────────────────────────────────────────────────────
// controllers/engineController.js — GET /api/engines（〔dec/r13-engine-choice〕docs/local-mode.md 10.26）
//
// 上傳考卷、AI 家教、助教的「本機／Gemini」選項要知道三件事：照 .env 時是哪一種、Gemini 有沒有金鑰、選了會用哪一支模型。
// 只讀設定（config/engines.js 的 describeEngines），不連 DB、不呼叫模型；**不回傳金鑰本身**，只回能不能用與原因。
// ─────────────────────────────────────────────────────────────

exports.listEngines = (req, res) => {
    res.json(require('../config/engines').describeEngines());
};
