require('dotenv').config();
const app = require('./app');
const { listenFailureText, exitAfterFlush } = require('./utils/listenFailure');

const PORT = process.env.PORT || 3000;

// Express 5 的 app.listen 把 listen 的錯誤（EADDRINUSE、EACCES…）交給這個 callback，不會丟出來。
// 不檢查的話，後端會照印「成功啟動」、不聽任何埠，卻繼續跑背景拆題（審查 dec/desktop-launcher 第 2 件；utils/listenFailure.js）。
const server = app.listen(PORT, err => {
    if (err) {
        exitAfterFlush(listenFailureText(err, PORT), 1);
        return;
    }
    console.log(`🚀 家教題庫後端系統已成功安全啟動：http://localhost:${PORT}`);
});

// 階段 2：管線 worker（docs/interfaces-stage2.md 第 7.2 條）
//   JOB_RUNNER=inline（預設）→ 與 API 同一個行程起 runner
//   JOB_RUNNER=off           → 不啟動（測試、純 API 部署，或開發時另開視窗 node workers/jobRunner.js）
// 開發時用 nodemon 熱重載會殺掉跑到一半的節點；租約過期後那一列會被重新認領，
// 已記進 job_events 的用量不會遺失（規劃 §3.9 的風險表第 1 列）。
const { startInlineRunner } = require('./workers/jobRunner');
const runner = startInlineRunner();

// 桌面啟動器（docs/desktop-launcher.md）：把 server 與 runner 交給「優雅關閉」通道。
// 只是記住參照；關閉路由只有在環境有 LAUNCHER_CONTROL_TOKEN（由啟動器開的後端）時才掛（app.js 3b），
// npm start／npm run dev 的行為不變。
require('./services/launcherControl').attach({ server, runner });
