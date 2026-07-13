// 輕量、無外部相依的記憶體型速率限制器（固定時間窗）。
// 用於保護會產生費用的端點（如呼叫 Gemini 的 /analyze-pdf），避免被濫用刷爆 API 額度。
// 註：單機記憶體實作，適合單一實例部署；若未來水平擴充多實例，請改用 Redis 型方案。

function createRateLimiter({ windowMs = 60 * 1000, max = 10, message } = {}) {
    const hits = new Map(); // key(IP) -> { count, resetAt }

    return function rateLimit(req, res, next) {
        const now = Date.now();
        const key = req.ip || req.socket?.remoteAddress || 'unknown';

        let entry = hits.get(key);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;

        // 順手清掉已過期的其他 key，避免 Map 無限成長
        if (hits.size > 1000) {
            for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
        }

        const remaining = Math.max(0, max - entry.count);
        res.set('X-RateLimit-Limit', String(max));
        res.set('X-RateLimit-Remaining', String(remaining));

        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                message: message || `請求過於頻繁，請於 ${retryAfter} 秒後再試。`
            });
        }
        next();
    };
}

module.exports = createRateLimiter;
