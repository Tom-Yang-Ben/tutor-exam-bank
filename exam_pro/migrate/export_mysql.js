// ─────────────────────────────────────────────────────────────
// migrate/export_mysql.js — 從舊 MySQL 倒出 JSONL + 校驗檔（D-D5，規劃 §5.3.6 步驟 2）
//
// 這支**只讀 MySQL、完全不碰 PostgreSQL**，也不依賴 PG schema：
// 切換之夜當下 PG 出任何狀況，這份匯出檔都還在，可以重跑 import。
//
// 用法（在 exam_pro 資料夾內）：
//   node migrate/export_mysql.js                 倒到 migrate/out/
//   node migrate/export_mysql.js --out D:\匯出   指定輸出資料夾
//   node migrate/export_mysql.js --batch 500     調整每批筆數（預設 1000）
//
// 讀的環境變數：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME（.env 的舊 MySQL 區塊）
//
// 產出（全部是 UTF-8、由 Node 寫；輸出資料夾已在 .gitignore，內含真實題目不得進版控）：
//   questions.jsonl          questions 全表，一列一個 JSON
//   exam_papers.jsonl        exam_papers 全表
//   checksums.json           各表筆數、各章筆數、逐列 sha256(question_text+answer_text)、
//                            history_json 鍵數與去重後的 attempts 期望值、各檔案的 sha256
//   name_merge_report.md     姓名合併報告（給老師在 import 之前先看過）
//
// 時間欄位刻意用 DATE_FORMAT 轉成字串再倒出：mysql2 會把 DATETIME 轉成 JS Date，
// JSON.stringify 之後變成 UTC 的 ISO 字串，台灣時間早上 8 點前的資料會差一天。
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const {
    DEFAULT_OUT_DIR, parseArgs, sha256, rowHash, countByChapter,
    openJsonlWriter, writeJson, writeText, localIso
} = require('./lib/util');
const { flattenHistory, buildMergeReport, renderMergeReport } = require('./lib/normalize');

const QUESTION_COLUMNS = [
    'id', 'subject', 'chapter', 'question_type', 'difficulty',
    'question_text', 'question_img', 'answer_text', 'solution_img', 'history_json'
];
const PAPER_COLUMNS = ['id', 'title', 'student_name', 'question_ids'];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(args.get('out', DEFAULT_OUT_DIR));
    const batch = Math.max(1, parseInt(args.get('batch', '1000'), 10) || 1000);

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'tutor_exam_bank',
        charset: 'utf8mb4',
        // 讓 DATETIME 以字串回來，不經過 JS Date 的時區轉換
        dateStrings: true
    });

    fs.mkdirSync(outDir, { recursive: true });
    console.log(`📤 匯出來源：mysql://${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'tutor_exam_bank'}`);
    console.log(`   輸出資料夾：${outDir}`);

    try {
        // ── questions ────────────────────────────────────────
        const qFile = path.join(outDir, 'questions.jsonl');
        const qw = openJsonlWriter(qFile);
        const rowHashes = {};
        const chapterRows = [];
        const historyKeys = [];
        let lastId = 0;
        for (;;) {
            const [rows] = await conn.query(
                `SELECT ${QUESTION_COLUMNS.join(', ')},
                        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
                   FROM questions WHERE id > ? ORDER BY id LIMIT ?`,
                [lastId, batch]
            );
            if (rows.length === 0) break;
            for (const row of rows) {
                // history_json 欄位在 MySQL 是 JSON 型別（mysql2 直接給物件），
                // 更舊的資料庫可能是 TEXT（給字串）；原樣倒出，解析交給 normalize.parseHistory。
                qw.write(row);
                rowHashes[String(row.id)] = rowHash(row);
                chapterRows.push({ subject: row.subject, chapter: row.chapter });
                lastId = row.id;
            }
            historyKeys.push(...flattenHistory(rows));
            process.stdout.write(`\r   questions … ${qw.count} 筆`);
        }
        qw.close();
        console.log(`\r   questions … ${qw.count} 筆  ✅`);

        // ── exam_papers ──────────────────────────────────────
        const pFile = path.join(outDir, 'exam_papers.jsonl');
        const pw = openJsonlWriter(pFile);
        const paperNames = [];
        lastId = 0;
        for (;;) {
            const [rows] = await conn.query(
                `SELECT ${PAPER_COLUMNS.join(', ')},
                        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
                   FROM exam_papers WHERE id > ? ORDER BY id LIMIT ?`,
                [lastId, batch]
            );
            if (rows.length === 0) break;
            for (const row of rows) {
                pw.write(row);
                paperNames.push({ name: row.student_name, paperId: row.id });
                lastId = row.id;
            }
            process.stdout.write(`\r   exam_papers … ${pw.count} 筆`);
        }
        pw.close();
        console.log(`\r   exam_papers … ${pw.count} 筆  ✅`);

        // ── 姓名合併報告（import 之前先讓老師看過）────────────
        const nameReport = buildMergeReport({ historyKeys, paperNames });
        const reportFile = path.join(outDir, 'name_merge_report.md');
        writeText(reportFile, renderMergeReport(nameReport, {
            title: '姓名合併報告（MySQL → PostgreSQL）',
            generatedAt: localIso()
        }));

        // ── 校驗檔 ───────────────────────────────────────────
        const checksums = {
            format: 1,
            generated_at: localIso(),
            source: {
                host: process.env.DB_HOST || 'localhost',
                port: parseInt(process.env.DB_PORT || '3306', 10),
                database: process.env.DB_NAME || 'tutor_exam_bank'
            },
            counts: { questions: qw.count, exam_papers: pw.count },
            chapter_counts: countByChapter(chapterRows),
            // 逐列 sha256(question_text + answer_text)，NULL 當空字串（定義見 lib/util.js 的 rowHash）
            row_hashes: rowHashes,
            history: {
                key_total: nameReport.totals.historyKeys,
                key_dropped: nameReport.totals.historyKeysDropped,
                // 去重後的「學生×題目」配對數 = attempts 應有筆數
                attempts_expected: nameReport.totals.attemptsExpected,
                students_expected: nameReport.totals.students
            },
            names: {
                merges: nameReport.merges.length,
                suspects: nameReport.suspects.length,
                collisions: nameReport.collisions.length,
                papers_dropped: nameReport.totals.papersDropped
            },
            files: {
                'questions.jsonl': fileStamp(qFile),
                'exam_papers.jsonl': fileStamp(pFile)
            }
        };
        writeJson(path.join(outDir, 'checksums.json'), checksums);

        console.log('');
        console.log('📊 摘要');
        console.log(`   questions            ${checksums.counts.questions} 筆`);
        console.log(`   exam_papers          ${checksums.counts.exam_papers} 筆`);
        console.log(`   章節數               ${Object.keys(checksums.chapter_counts).length}`);
        console.log(`   history_json 鍵      ${checksums.history.key_total} 個`);
        console.log(`   → attempts 應有      ${checksums.history.attempts_expected} 筆`);
        console.log(`   → students 應有      ${checksums.history.students_expected} 筆`);
        console.log(`   姓名合併             ${checksums.names.merges} 組`);
        console.log(`   疑似同一人（不自動合併） ${checksums.names.suspects} 組`);
        console.log(`   同題撞鍵             ${checksums.names.collisions} 組`);
        if (checksums.names.papers_dropped > 0) {
            console.log(`   ⚠️ 姓名為空的試卷     ${checksums.names.papers_dropped} 筆（import 會擋下來，先處理）`);
        }
        console.log('');
        console.log(`✅ 匯出完成。請先看過 ${reportFile}，確認姓名合併沒有誤判，再執行 import_pg.js。`);
    } finally {
        await conn.end();
    }
}

/**
 * 檔案指紋：行數與整檔 sha256，讓 import／verify 能確認讀到的是同一份匯出。
 * @param {string} file
 * @returns {{lines: number, bytes: number, sha256: string}}
 */
function fileStamp(file) {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    return {
        lines: text.split('\n').filter(l => l.trim()).length,
        bytes: buf.length,
        sha256: sha256(text)
    };
}

main().catch(err => {
    console.error('❌ 匯出失敗：' + err.message);
    if (err.code === 'ECONNREFUSED') console.error('   （連不上 MySQL，確認服務有起來、.env 的 DB_HOST/DB_PORT 正確）');
    if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('   （帳密錯誤，確認 .env 的 DB_USER/DB_PASSWORD）');
    process.exit(1);
});
