// 可選的 API Key 認證中介軟體。
// 若 .env 未設定 API_KEY，則停用認證（不阻擋任何請求），方便純本機自用。
// 若有設定，則所有 /api 請求必須帶上正確的 x-api-key 標頭。

const crypto = require('crypto');

// 以定時安全比較避免時序攻擊
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = function apiKeyAuth(req, res, next) {
    const expected = process.env.API_KEY;

    // 未設定金鑰 → 停用認證
    if (!expected || expected.trim() === '') return next();

    const provided = req.get('x-api-key') || '';
    if (provided && safeEqual(provided, expected)) return next();

    return res.status(401).json({ message: '未授權：缺少或錯誤的 API 金鑰' });
};
