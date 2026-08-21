// ─────────────────────────────────────────────────────────────
// migrate/export_pg_delta.js — 切換之後的新增資料反向匯出（規劃 §5.3.6 步驟 6）
//
// 用途：切換之夜之後的 1～14 天內若決定退回 MySQL，這段期間在 PostgreSQL 上
//       新增的題目、試卷與作答紀錄不會自己回到 MySQL。這支把它們倒出來，
//       並把 attempts 摺回舊的 history_json 形狀。
//
// 用法（在 exam_pro 資料夾內）：
//   node migrate/export_pg_delta.js                       用 migrate/out/cutover.json 當界線
//   node migrate/export_pg_delta.js --cutover <路徑>      指定切換標記檔
//   node migrate/export_pg_delta.js --out <資料夾>        指定輸出資料夾（預設同 cutover 所在）
//   node migrate/export_pg_delta.js --test                改讀 TEST_DATABASE_URL
//
// 產出：
//   delta_questions.jsonl     切換後新增的題目（history_json 已由 attempts 摺回）
//   delta_papers.jsonl        切換後新增的試卷（student_id 已還原成 student_name）
//   delta_history_patch.jsonl 舊題目在切換後新增的作答紀錄（整份 history_json 與新增的鍵）
//   rollback_mysql.sql        可直接餵給 MySQL 的還原語句（先看過再執行）
//
// 界線的定義來自 cutover.json 的 max_ids：id 大於當時最大值的就是切換後新增的。
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const path = require('path');
const { Client } = require('pg');
const { DEFAULT_OUT_DIR, parseArgs, resolvePgUrl, readJson, openJsonlWriter, writeText, localIso } = require('./lib/util');

const HISTORY_AGG = `COALESCE(jsonb_object_agg(s.name, to_char(a.assigned_at, 'YYYY-MM-DD'))
                              FILTER (WHERE a.id IS NOT NULL), '{}'::jsonb)`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cutoverFile = path.resolve(args.get('cutover', path.join(DEFAULT_OUT_DIR, 'cutover.json')));
    const outDir = path.resolve(args.get('out', path.dirname(cutoverFile)));
    const cutover = readJson(cutoverFile);
    const max = cutover.max_ids;
    if (!max) throw new Error(`${cutoverFile} 裡沒有 max_ids，不是 import_pg.js --apply 產生的切換標記檔`);

    const client = new Client({ connectionString: resolvePgUrl({ test: args.has('test') }) });
    await client.connect();
    try {
        console.log(`↩️  反向匯出：切換界線 questions>${max.questions}、exam_papers>${max.exam_papers}、attempts>${max.attempts}`);

        // 1. 切換後新增的題目（history_json 由 attempts 摺回舊形狀）
        const newQ = (await client.query(`
            SELECT q.id, q.subject, q.chapter, q.question_type, q.difficulty, q.question_text,
                   q.question_img, q.answer_text, q.solution_img, ${HISTORY_AGG} AS history_json,
                   to_char(q.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
              FROM questions q
              LEFT JOIN attempts a ON a.question_id = q.id
              LEFT JOIN students s ON s.id = a.student_id
             WHERE q.id > $1
             GROUP BY q.id ORDER BY q.id`, [max.questions])).rows;

        // 2. 切換後新增的試卷（student_id → student_name）
        const newP = (await client.query(`
            SELECT p.id, p.title, s.name AS student_name, p.question_ids,
                   to_char(p.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
              FROM exam_papers p JOIN students s ON s.id = p.student_id
             WHERE p.id > $1 ORDER BY p.id`, [max.exam_papers])).rows;

        // 3. 舊題目在切換後多出來的作答紀錄 → 整份 history_json（MySQL 端直接覆寫最安全）
        const patch = (await client.query(`
            SELECT q.id, ${HISTORY_AGG} AS history_json,
                   COALESCE(jsonb_object_agg(s.name, to_char(a.assigned_at, 'YYYY-MM-DD'))
                            FILTER (WHERE a.id > $2), '{}'::jsonb) AS added
              FROM questions q
              LEFT JOIN attempts a ON a.question_id = q.id
              LEFT JOIN students s ON s.id = a.student_id
             WHERE q.id <= $1
               AND EXISTS (SELECT 1 FROM attempts a2 WHERE a2.question_id = q.id AND a2.id > $2)
             GROUP BY q.id ORDER BY q.id`, [max.questions, max.attempts])).rows;

        for (const [name, rows] of [['delta_questions.jsonl', newQ], ['delta_papers.jsonl', newP], ['delta_history_patch.jsonl', patch]]) {
            const w = openJsonlWriter(path.join(outDir, name));
            for (const r of rows) w.write(r);
            w.close();
            console.log(`   ${name.padEnd(26)} ${rows.length} 筆`);
        }

        // 4. 直接可用的 MySQL 還原語句（先看過再執行；不自動跑）
        const L = [
            '-- 由 migrate/export_pg_delta.js 產生：把切換後在 PostgreSQL 新增的資料還原回 MySQL',
            `-- 產生時間 ${localIso()}；切換界線 questions>${max.questions}、exam_papers>${max.exam_papers}、attempts>${max.attempts}`,
            '-- 執行前請先備份 MySQL，並確認這些 id 在 MySQL 端沒有被別的資料占用。',
            'START TRANSACTION;'
        ];
        for (const q of newQ) {
            L.push(`INSERT INTO questions (id, subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img, history_json, created_at) VALUES (` +
                [q.id, s(q.subject), s(q.chapter), s(q.question_type), q.difficulty, s(q.question_text), s(q.question_img),
                 s(q.answer_text), s(q.solution_img), s(JSON.stringify(q.history_json)), s(q.created_at)].join(', ') + ');');
        }
        for (const p of newP) {
            L.push(`INSERT INTO exam_papers (id, title, student_name, question_ids, created_at) VALUES (` +
                [p.id, s(p.title), s(p.student_name), s(JSON.stringify(p.question_ids)), s(p.created_at)].join(', ') + ');');
        }
        for (const r of patch) {
            L.push(`UPDATE questions SET history_json = ${s(JSON.stringify(r.history_json))} WHERE id = ${r.id};`);
        }
        L.push('COMMIT;', '');
        writeText(path.join(outDir, 'rollback_mysql.sql'), L.join('\n'));
        console.log(`   rollback_mysql.sql         ${L.length - 5} 條語句`);
        console.log('');
        console.log(`✅ 完成。檔案在 ${outDir}。執行 rollback_mysql.sql 前務必先備份 MySQL，並人工看過一遍。`);
    } finally {
        await client.end();
    }
}

/** MySQL 字串字面量（NULL 直接輸出 NULL）。 */
function s(v) {
    if (v === null || v === undefined) return 'NULL';
    const escaped = String(v).replace(/[\0\b\n\r\t\x1a\\'"]/g, c => ({
        '\0': '\\0', '\b': '\\b', '\n': '\\n', '\r': '\\r', '\t': '\\t',
        '\x1a': '\\Z', '\\': '\\\\', "'": "\\'", '"': '\\"'
    }[c]));
    return `'${escaped}'`;
}

main().catch(err => {
    console.error('❌ 反向匯出失敗：' + err.message);
    process.exit(1);
});
