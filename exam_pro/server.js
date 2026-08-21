require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 家教題庫後端系統已成功安全啟動：http://localhost:${PORT}`);
});

// 階段 2：管線 worker（docs/interfaces-stage2.md 第 7.2 條）
//   JOB_RUNNER=inline（預設）→ 與 API 同一個行程起 runner
//   JOB_RUNNER=off           → 不啟動（測試、純 API 部署，或開發時另開視窗 node workers/jobRunner.js）
// 開發時用 nodemon 熱重載會殺掉跑到一半的節點；租約過期後那一列會被重新認領，
// 已記進 job_events 的用量不會遺失（規劃 §3.9 的風險表第 1 列）。
const { startInlineRunner } = require('./workers/jobRunner');
startInlineRunner();
