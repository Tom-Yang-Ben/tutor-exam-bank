const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const routes = require('./routes'); // 會自動讀取 routes/index.js
const apiKeyAuth = require('./middleware/auth');

// 確保 uploads 目錄存在
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// 開機清理 uploads 殘留檔（清掉超過 1 小時的暫存檔，避免崩潰殘留堆積）
(function cleanupUploads() {
    try {
        const dir = path.join(__dirname, 'uploads');
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        for (const name of fs.readdirSync(dir)) {
            if (name === '.gitkeep') continue;
            const fp = path.join(dir, name);
            try {
                const stat = fs.statSync(fp);
                if (stat.isFile() && stat.mtimeMs < oneHourAgo) fs.unlinkSync(fp);
            } catch (e) { /* 忽略單檔錯誤 */ }
        }
    } catch (e) { console.error('uploads 清理失敗:', e.message); }
})();

const app = express();

// 1. 全域中介軟體
// CORS：只允許 .env 中 ALLOWED_ORIGINS 指定的來源，預設僅 localhost
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // 允許同源 / 無 origin 的請求（如 curl、同站 fetch）
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS 政策不允許此來源'));
    }
}));
app.use(express.json({ limit: '2mb' }));
// 只公開 public/ 目錄的前端資產，避免把後端原始碼、schema.sql、備份 JSON 一併靜態外洩。
// index: false → 不讓 static 直接吐出 index.html，改由下方路由注入 API 金鑰
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false }));

// 2. 首頁路由：把 API_KEY 注入頁面，讓同源前端能自動帶上 x-api-key
function serveIndex(req, res, next) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
        if (err) return next(err);
        const key = process.env.API_KEY || '';
        res.type('html').send(html.replace('__API_KEY__', key));
    });
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// 3. API 路由掛載（套用可選的 API Key 認證）
app.use('/api', apiKeyAuth, routes);

// 4. 全域錯誤捕捉中樞
app.use((err, req, res, next) => {
    console.error("【全域系統錯誤中樞捕捉】異常回報:", err.message);
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(err.status || 500).json({
        message: '後端伺服器內部發生未知錯誤',
        // 僅在開發環境回傳錯誤細節，避免線上資訊洩漏
        ...(isDev ? { error: err.message } : {})
    });
});

module.exports = app;
