// 加速 + 整理：確保 (subject,chapter) 索引存在，並建立數學/物理檢視表（不動原始資料）
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
    const db = process.env.DB_NAME || 'tutor_exam_bank';
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', database: db
    });

    // 1) 索引（真正的加速關鍵）
    const [idx] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema=? AND table_name='questions' AND index_name='idx_subject_chapter'",
        [db]
    );
    if (idx[0].c === 0) {
        await conn.query('CREATE INDEX idx_subject_chapter ON questions (subject, chapter)');
        console.log('✅ 已建立索引 idx_subject_chapter (subject, chapter)');
    } else {
        console.log('ℹ️  索引 idx_subject_chapter 已存在，略過');
    }

    // 2) 數學 / 物理 檢視表（依章節、ID 排好）
    const cols = 'id, subject, chapter, question_type, difficulty, question_text, answer_text, created_at';
    await conn.query(`CREATE OR REPLACE VIEW questions_math AS SELECT ${cols} FROM questions WHERE subject='數學' ORDER BY chapter, id`);
    await conn.query(`CREATE OR REPLACE VIEW questions_physics AS SELECT ${cols} FROM questions WHERE subject='物理' ORDER BY chapter, id`);
    console.log('✅ 已建立/更新檢視表：questions_math、questions_physics');

    const [m] = await conn.query("SELECT COUNT(*) c FROM questions WHERE subject='數學'");
    const [p] = await conn.query("SELECT COUNT(*) c FROM questions WHERE subject='物理'");
    const [o] = await conn.query("SELECT COUNT(*) c FROM questions WHERE subject NOT IN ('數學','物理') OR subject IS NULL");
    console.log(`目前題數 → 數學：${m[0].c}　物理：${p[0].c}　其他/未分類：${o[0].c}`);
    console.log('用法：在 Workbench 直接 SELECT * FROM questions_math; 或 questions_physics;');

    await conn.end();
}
main().catch(e => { console.error('執行失敗：', e.message); process.exit(1); });
