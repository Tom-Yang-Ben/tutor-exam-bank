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

// 2. 首頁路由：把伺服器端才知道的五個值注入頁面
//    __API_KEY__          讓同源前端自動帶上 x-api-key
//    __FEATURE_PIPELINE__ 上傳區要不要改走 POST /api/jobs（裁決 S2-20）
//                         旗標**不得寫死在 JS**（interfaces-stage2.md 第 8 條），
//                         所以由這裡注入，前端從 <meta name="feature-pipeline"> 讀。
//    __FEATURE_STUDENTS__ 學生分頁（弱點面板與批改）  ┐ 階段 3 的三個同款旗標
//    __FEATURE_NLQ__      自然語言查題框              │（interfaces-stage3.md 第 7.3 條）
//    __FEATURE_VARIANTS__ 變式題分頁                  ┘ 讀法與 feature-pipeline 逐字相同
function serveIndex(req, res, next) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
        if (err) return next(err);
        const key = process.env.API_KEY || '';
        // 未設定時注入字面 'false'，而不是空字串：前端的 parseBool 對空字串與
        // 「沒被替換掉的佔位字串」會得到同樣的結果，但留 'false' 讀起來才不會像壞掉。
        const pipeline = process.env.FEATURE_PIPELINE || 'false';
        // 用 replaceAll 而不是 replace：佔位字串在 index.html 裡都不只出現一次
        // （__FEATURE_PIPELINE__ 在 <meta> 上方的說明註解裡也有一份），
        // replace 只換第一個，會換到註解而讓真正的 <meta> 留著佔位字串。
        res.type('html').send(
            html.replaceAll('__API_KEY__', key)
                .replaceAll('__FEATURE_PIPELINE__', pipeline)
                .replaceAll('__FEATURE_STUDENTS__', process.env.FEATURE_STUDENTS || 'false')
                .replaceAll('__FEATURE_NLQ__', process.env.FEATURE_NLQ || 'false')
                .replaceAll('__FEATURE_VARIANTS__', process.env.FEATURE_VARIANTS || 'false'));
    });
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// 靜態資產掛在 serveIndex **之後**。
// 順序很重要：express.static 的 `index: false` 只讓「目錄請求」（`/`）不自動吐 index.html，
// 但明確請求 `/index.html` 時它照樣會把檔案原樣送出。原本 static 掛在前面，
// 因此 `/index.html` 一直是「沒被替換過」的版本——API_KEY 沒注入（設了金鑰時前端打不了 API），
// FEATURE_PIPELINE 也不會注入。改成後掛，兩個進入點才真的走同一支 serveIndex。
app.use(express.static(PUBLIC_DIR, { index: false }));

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
