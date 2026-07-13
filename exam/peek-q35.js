require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tutor_exam_bank',
    waitForConnections: true,
    connectionLimit: 1
});

async function peek() {
    try {
        // 直接用主鍵 id = 35 暴力撈取
        const [rows] = await pool.execute(
            "SELECT id, question_text FROM questions WHERE id = 48"
        );

        if (rows.length === 0) {
            console.log("❌ 資料庫裡居然連 id = 35 的題目都沒有！請去網頁預覽畫面上看一下這題真正的「題目 ID 清單」是多少。");
            return;
        }

        console.log("==================================================");
        console.log(`🎯 成功撈出 id = 35 的題目內容`);
        console.log("==================================================");
        console.log("【真實字串細節】：");
        console.log(rows[0].question_text);
        console.log("==================================================");
        // 加強版：印出字串內所有包含 SUPER 的片段細節
        const matches = rows[0].question_text.match(/g=10m\/s[^\s)]*/g);
        if (matches) {
            console.log("🔍 偵測到單位部分的字串特徵為：", matches);
        }
        console.log("==================================================");

    } catch (err) {
        console.error("錯誤:", err.message);
    } finally {
        await pool.end();
    }
}

peek();