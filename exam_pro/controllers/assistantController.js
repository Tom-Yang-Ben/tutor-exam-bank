// ─────────────────────────────────────────────────────────────
// controllers/assistantController.js — POST /api/assistant（階段 4 A1）
//
// 薄殼：驗形狀 → services/assistantService.runAssistant → 回 { reply, steps }。
// steps 一起回給前端是刻意的：工具調用軌跡就是這個功能要展示的東西
//（主控 agent 何時叫了哪個工具、拿到什麼），藏起來就只剩一個聊天框。
//
// 只在 FEATURE_ASSISTANT 開啟時掛載（routes/index.js）。LLM_MODE=replay 且沒有
// cassette 時會回 502（replay miss 原文）——CI 不開這個旗標，所以不會炸 CI。
// ─────────────────────────────────────────────────────────────
const assistant = require('../services/assistantService');

exports.chat = async (req, res, next) => {
    const { message, history } = req.body || {};
    if (history !== undefined && !Array.isArray(history)) {
        return res.status(400).json({ message: 'history 要是陣列（[{role, text}]）。' });
    }
    try {
        const out = await assistant.runAssistant({ message, history: history || [] });
        res.status(200).json(out);
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ message: err.message });
        // LLM 供應商掛掉／replay miss：對前端來說都是「助教暫時無法回應」
        res.status(502).json({ message: `助教暫時無法回應：${err.message}` });
    }
};
