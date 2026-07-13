require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 家教題庫後端系統已成功安全啟動：http://localhost:${PORT}`);
});