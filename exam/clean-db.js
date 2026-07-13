require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tutor_exam_bank',
    waitForConnections: true,
    connectionLimit: 5
});

// 🎯 全新升級：正統 LaTeX 還原器
function normalizeMath(rawStr) {
    if (!rawStr) return "";
    let str = rawStr;

    // 1. 清除之前加入的隱形防禦字元
    str = str.replace(/\u200B/g, '');

    // 2. 把之前我們自創的假標籤，完美還原回真正的 LaTeX
    // 處理分數 [FRAC:a|b] -> \frac{a}{b}
    str = str.replace(/\[FRAC:([^|]+)\|([^\]]+)\]/g, '\\frac{$1}{$2}');
    // 處理根號 [SQRT:a] -> \sqrt{a}
    str = str.replace(/\[SQRT:([^\]]+)\]/g, '\\sqrt{$1}');
    // 處理上標 [SUPER:a|b] -> a^{b} (底數若為空則只留 ^{b})
    str = str.replace(/\[SUPER:\s*\|([^\]]+)\]/g, '^{$1}');
    str = str.replace(/\[SUPER:([^|]+)\|([^\]]+)\]/g, '$1^{$2}');
    // 處理下標 [SUB:a|b] -> a_{b}
    str = str.replace(/\[SUB:\s*\|([^\]]+)\]/g, '_{$1}');
    str = str.replace(/\[SUB:([^|]+)\|([^\]]+)\]/g, '$1_{$2}');

    // 3. 把資料庫裡半殘的 Unicode 符號洗成標準 LaTeX
    str = str
        .replace(/π/g, '\\pi ')
        .replace(/θ/g, '\\theta ')
        .replace(/ω/g, '\\omega ')
        .replace(/∝/g, '\\propto ')
        .replace(/√\((.*?)\)/g, '\\sqrt{$1}')
        .replace(/√([a-zA-Z0-9])/g, '\\sqrt{$1}')
        .replace(/([a-zA-Z0-9])²/g, '$1^{2}')
        .replace(/([a-zA-Z0-9])³/g, '$1^{3}')
        .replace(/([a-zA-Z0-9])₁/g, '$1_{1}')
        .replace(/([a-zA-Z0-9])₂/g, '$1_{2}');

    // 4. (選用) 為了適應新版 server.js 抓取 $...$，將含有 \frac, \sqrt, ^, _ 的孤立公式包上 $
    // 注意：最完美的做法是未來要求 AI 直接輸出 $...$，此處僅做基礎防護
    str = str.replace(/(?<!\$)(\\[a-zA-Z]+\{[^}]*\}(?:\{[^}]*\})?)(?!\$)/g, '$$$1$$');
    str = str.replace(/(?<!\$)([a-zA-Z0-9]+[\^_]\{[^}]*\})(?!\$)/g, '$$$1$$');

    // 5. 清除不可見字元（不再暴力清除反斜線 \）
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").trim();

    return str;
}

async function startCleaning() {
    console.log('🚀 啟動全新 LaTeX 正規化清洗...');
    try {
        const [questions] = await pool.execute('SELECT id, question_text, answer_text FROM questions');
        console.log(`📊 偵測到共 ${questions.length} 筆題目資料。`);

        let updatedCount = 0;

        for (const q of questions) {
            const cleanedQuestion = normalizeMath(q.question_text);
            const cleanedAnswer = normalizeMath(q.answer_text);

            if (cleanedQuestion !== q.question_text || cleanedAnswer !== q.answer_text) {
                await pool.execute(
                    'UPDATE questions SET question_text = ?, answer_text = ? WHERE id = ?',
                    [cleanedQuestion, cleanedAnswer, q.id]
                );
                updatedCount++;
            }
        }
        console.log(`\n🎉 歷史資料已成功還原為標準 LaTeX！共更新了 ${updatedCount} 筆資料。`);
    } catch (error) {
        console.error('❌ 發生錯誤:', error);
    } finally {
        await pool.end();
    }
}

startCleaning();