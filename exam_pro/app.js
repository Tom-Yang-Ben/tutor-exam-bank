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

// 本機模式 L3（docs/local-mode.md 第 1 條第 1 點、第 5 條第 1、2 點）：前端用到的第三方程式庫與字型
// 一律由本機的 npm 套件供應，執行期不連任何 CDN。每一項只公開套件裡瀏覽器真正要讀的那個目錄，
// 不把整個 node_modules 掛出去。版本由 package-lock.json 固定。
//   /vendor/mathjax            mathjax@3 的 es5/。tex-mml-chtml.js 用自己的網址推出根目錄
//                              （document.currentScript，退回 #MathJax-script），所以 [tex]/mhchem、ui/safe、
//                              CHTML 字型（output/chtml/fonts/woff-v2）、無障礙選單的 SRE 規則（sre/mathmaps）
//                              都會從這個目錄相對載入——index.html 的 window.MathJax 設定一個字都不用改。
//   /vendor/gsap               gsap 的 dist/（index.html 只讀 gsap.min.js）
//   /vendor/tailwindcss        @tailwindcss/browser 的 dist/（瀏覽器端即時產生 Tailwind CSS）
//   /vendor/fonts/manrope      @fontsource-variable/manrope（index.css ＋ files/*.woff2）
//   /vendor/fonts/noto-sans-tc @fontsource-variable/noto-sans-tc（同上；依 unicode-range 分成約一百個切片，
//                              瀏覽器只抓頁面上真的用到的字所在的切片）
const VENDOR_ASSETS = [
    { route: '/vendor/mathjax', pkg: 'mathjax', dir: 'es5' },
    { route: '/vendor/gsap', pkg: 'gsap', dir: 'dist' },
    { route: '/vendor/tailwindcss', pkg: '@tailwindcss/browser', dir: 'dist' },
    { route: '/vendor/fonts/manrope', pkg: '@fontsource-variable/manrope', dir: '' },
    { route: '/vendor/fonts/noto-sans-tc', pkg: '@fontsource-variable/noto-sans-tc', dir: '' }
];

/**
 * 找 npm 套件的安裝目錄。不用 require.resolve(`${pkg}/package.json`)：
 * @fontsource 的 exports 會把 './package.json' 對應成 './package.json.css' 而解析失敗。
 * @param {string} pkg
 * @returns {string|null}
 */
function packageDir(pkg) {
    for (const base of require.resolve.paths(pkg) || []) {
        const dir = path.join(base, pkg);
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    }
    return null;
}

/**
 * 路由表裡有沒有這一條（Express 的 Router 把每條 router.post(...) 記成 stack 裡帶 route 的 layer）。
 * @param {Function & {stack?: any[]}} router
 * @param {string} method 小寫，例如 'post'
 * @param {string} routePath 例如 '/voice/transcribe'
 * @returns {boolean}
 */
function hasRoute(router, method, routePath) {
    const stack = router && Array.isArray(router.stack) ? router.stack : [];
    return stack.some(layer => Boolean(layer && layer.route && layer.route.path === routePath
        && layer.route.methods && layer.route.methods[method]));
}

// 本機模式 L3（docs/local-mode.md 第 3 條第 9 點、第 5 條第 4 點）：語音轉寫路由有沒有真的掛上。
// 直接看路由表，而不是在這裡重算「MODEL_VOICE 是不是 Gemini」——要不要掛載只由 routes/index.js 決定（L1），
// 這裡照實轉告前端，兩邊不會各算各的。routes/index.js 在 require 當下讀旗標，所以結果在啟動時就固定。
// 'mounted'＝有掛；'none'＝沒掛（FEATURE_TUTOR／FEATURE_VOICE 關閉，或本機模式不提供語音）。
// 前端只在 feature-voice 開著、這裡卻是 'none' 時顯示「本機模式不提供語音」（public/js/tutor.js）。
const VOICE_ROUTE = hasRoute(routes, 'post', '/voice/transcribe') ? 'mounted' : 'none';

// 2. 首頁路由：把伺服器端才知道的六個值注入頁面
//    __API_KEY__          讓同源前端自動帶上 x-api-key
//    __FEATURE_PIPELINE__ 上傳區要不要改走 POST /api/jobs（裁決 S2-20）
//                         旗標**不得寫死在 JS**（interfaces-stage2.md 第 8 條），
//                         所以由這裡注入，前端從 <meta name="feature-pipeline"> 讀。
//    __FEATURE_STUDENTS__ 學生分頁（弱點面板與批改）  ┐ 階段 3 的三個同款旗標
//    __FEATURE_NLQ__      自然語言查題框              │（interfaces-stage3.md 第 7.3 條）
//    __FEATURE_VARIANTS__ 變式題分頁                  ┘ 讀法與 feature-pipeline 逐字相同
//    __FEATURE_ASSISTANT__ 對話式助教分頁（階段 4 A1；工具全部只讀，出卷仍要人按確認）
//    __FEATURE_SIMILAR__  最近錯題的「找相似」按鈕（裁決 S3-R25）
//                         這一個對應的是**階段 1 就有**的 FEATURE_SIMILAR：
//                         `GET /api/questions/:id/similar` 沒掛載時（routes/index.js 的
//                         [WS-C: retrieval] 區塊）「找相似」會打到 404，所以按鈕得跟著關。
//                         「找相似」歸 feature-similar、「出變式」歸 feature-variants——
//                         兩顆按鈕在同一列，但背後是兩條各自獨立的路由。
//    __VOICE_ROUTE__      POST /api/voice/transcribe 實際上有沒有掛（本機模式 L3；不是旗標，是路由表的結果）
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
                .replaceAll('__FEATURE_VARIANTS__', process.env.FEATURE_VARIANTS || 'false')
                .replaceAll('__FEATURE_SIMILAR__', process.env.FEATURE_SIMILAR || 'false')
                .replaceAll('__FEATURE_ASSISTANT__', process.env.FEATURE_ASSISTANT || 'false')
                // 階段 5（docs/interfaces-stage5.md 第 1.3 條）
                .replaceAll('__FEATURE_KC__', process.env.FEATURE_KC || 'false')
                .replaceAll('__FEATURE_REMEDIAL__', process.env.FEATURE_REMEDIAL || 'false')
                .replaceAll('__FEATURE_TUTOR__', process.env.FEATURE_TUTOR || 'false')
                .replaceAll('__FEATURE_VOICE__', process.env.FEATURE_VOICE || 'false')
                // 本機模式 L3：語音路由實際上有沒有掛（見上方 VOICE_ROUTE）
                .replaceAll('__VOICE_ROUTE__', VOICE_ROUTE));
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

// 本機的第三方前端資產（見上方 VENDOR_ASSETS）。套件不在時只警告、不中止：API 照常可用，
// 但頁面會缺樣式或數學式——警告寫明要跑 npm install，而不是讓人對著一片白的畫面猜原因。
for (const { route, pkg, dir } of VENDOR_ASSETS) {
    const root = packageDir(pkg);
    if (!root) {
        console.warn(`[vendor] 找不到前端套件 ${pkg}，${route} 無法供應（頁面會缺樣式、數學式或字型）。請在 exam_pro 執行 npm install。`);
        continue;
    }
    app.use(route, express.static(path.join(root, dir), { index: false }));
}

// 附圖靜態目錄（docs/figures.md）：只放管線從考卷 PDF 裁出的 PNG，
// questions.question_img 存的相對路徑（/figures/<jobId>-<idx>.png）由這裡供圖。
const FIGURES_DIR = path.join(__dirname, 'data', 'figures');
if (!fs.existsSync(FIGURES_DIR)) fs.mkdirSync(FIGURES_DIR, { recursive: true });
app.use('/figures', express.static(FIGURES_DIR));

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
