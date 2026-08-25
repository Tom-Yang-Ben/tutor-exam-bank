// ─────────────────────────────────────────────────────────────
// migrate/verify.js — 匯入後的獨立校驗（D-D5，規劃 §5.3.6 步驟 4）
//
// 用法（在 exam_pro 資料夾內）：
//   node migrate/verify.js                       比對 migrate/out 的匯出檔與 DATABASE_URL
//   node migrate/verify.js --test                改比對 TEST_DATABASE_URL
//   node migrate/verify.js --sample=50           Word 產物逐位元比對的抽樣題數（預設 20）
//   node migrate/verify.js --sample-ids=3,7,12   指定要比對哪幾題（重現前一次的抽樣）
//   node migrate/verify.js --allow-merged        接受「因姓名合併／同題撞鍵而少掉的 attempts」
//
// 檢查項目（任一不等就以非零碼退出）：
//   1. questions / exam_papers 筆數
//   2. 各章（subject｜chapter）筆數
//   3. 逐列 sha256(question_text + answer_text) 全等
//   4. attempts 守恆（interfaces-stage1.md 裁決 14 的條文）：
//        COUNT(attempts) = Σ history_json 鍵數 − 姓名合併與空姓名造成的差額
//      差額**逐筆列在 name_merge_report.md**，經人工確認後以 --allow-merged 放行。
//      為什麼等式本身不會成立：UNIQUE(student_id, question_id) 只容得下一列，
//      同一題有兩個鍵指向同一人時必然少一列；姓名正規化後為空的鍵則建不出 students。
//      這不是 bug，但**必須被看到**——所以預設仍然算失敗，不加旗標不會過。
//   5. 隨機 N 題的 buildParagraphComponents 產物逐位元比對（MySQL 端文字 vs PG 端文字）
//   6. students 筆數、attempts 沒有孤兒、序列（setval）有對齊
//
// 這支刻意在 Node 端自己算雜湊與 Word 產物，與 import_pg.js 交易內用 PG 的 sha256()
// 算的是兩份獨立實作；兩邊都過才算數。
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const path = require('path');
const { Client } = require('pg');

const {
    DEFAULT_OUT_DIR, parseArgs, resolvePgUrl, rowHash, countByChapter,
    readJsonl, readJson, stableSerialize, chunk
} = require('./lib/util');
const { flattenHistory, buildMergeReport } = require('./lib/normalize');
const { buildParagraphComponents } = require('../utils/textFormatter');

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const inDir = path.resolve(args.get('in', DEFAULT_OUT_DIR));
    const useTest = args.has('test');
    const sampleSize = Math.max(0, parseInt(args.get('sample', '20'), 10) || 0);
    const sampleIds = args.has('sample-ids')
        ? String(args.get('sample-ids', '')).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
        : null;
    const allowMerged = args.has('allow-merged');

    const checksums = readJson(path.join(inDir, 'checksums.json'));
    const questions = readJsonl(path.join(inDir, 'questions.jsonl'));
    const papers = readJsonl(path.join(inDir, 'exam_papers.jsonl'));
    const byId = new Map(questions.map(q => [q.id, q]));

    const report = buildMergeReport({
        historyKeys: flattenHistory(questions),
        paperNames: papers.map(p => ({ name: p.student_name, paperId: p.id }))
    });

    const client = new Client({ connectionString: resolvePgUrl({ test: useTest }) });
    await client.connect();

    const problems = [];
    const notes = [];
    const ok = msg => console.log(`   ✅ ${msg}`);
    const bad = msg => { problems.push(msg); console.log(`   ❌ ${msg}`); };

    try {
        console.log(`🔍 校驗：${inDir}  ↔  ${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'}`);
        console.log('');

        // ── 1. 筆數 ─────────────────────────────────────────
        const cnt = (await client.query(`
            SELECT (SELECT count(*) FROM questions)   AS questions,
                   (SELECT count(*) FROM exam_papers) AS exam_papers,
                   (SELECT count(*) FROM students)    AS students,
                   (SELECT count(*) FROM attempts)    AS attempts`)).rows[0];
        console.log('1. 筆數');
        check(Number(cnt.questions) === checksums.counts.questions,
            `questions ${cnt.questions} = ${checksums.counts.questions}`,
            `questions 筆數 ${cnt.questions} ≠ 匯出的 ${checksums.counts.questions}`);
        check(Number(cnt.exam_papers) === checksums.counts.exam_papers,
            `exam_papers ${cnt.exam_papers} = ${checksums.counts.exam_papers}`,
            `exam_papers 筆數 ${cnt.exam_papers} ≠ 匯出的 ${checksums.counts.exam_papers}`);
        // students 允許多一位「未知學生」（import 的 --unknown-student）
        const stuDiff = Number(cnt.students) - report.totals.students;
        check(stuDiff === 0 || (stuDiff === 1 && report.totals.papersDropped > 0),
            `students ${cnt.students}（姓名報告推得 ${report.totals.students}）`,
            `students 筆數 ${cnt.students} ≠ 姓名報告推得的 ${report.totals.students}`);
        console.log('');

        // ── 2. 各章筆數 ─────────────────────────────────────
        console.log('2. 各章筆數');
        const want = checksums.chapter_counts || countByChapter(questions);
        const got = {};
        for (const r of (await client.query('SELECT subject, chapter, count(*)::int AS n FROM questions GROUP BY 1,2')).rows) {
            got[`${r.subject}｜${r.chapter}`] = r.n;
        }
        let chapterBad = 0;
        for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
            if ((want[k] || 0) !== (got[k] || 0)) { bad(`章節「${k}」筆數 ${got[k] || 0} ≠ 匯出的 ${want[k] || 0}`); chapterBad++; }
        }
        if (chapterBad === 0) ok(`${Object.keys(want).length} 個章節的筆數全等`);
        console.log('');

        // ── 3. 逐列雜湊 ─────────────────────────────────────
        console.log('3. 逐列 sha256(question_text + answer_text)');
        const ids = Object.keys(checksums.row_hashes || {}).map(Number).sort((a, b) => a - b);
        let hashBad = 0;
        for (const part of chunk(ids, 1000)) {
            const { rows } = await client.query(
                `SELECT e.id, q.question_text, q.answer_text
                   FROM unnest($1::int[]) AS e(id) LEFT JOIN questions q ON q.id = e.id`, [part]);
            for (const row of rows) {
                if (row.question_text === null && row.answer_text === null) {
                    const src = byId.get(row.id);
                    if (!src || (src.question_text === null && src.answer_text === null)) {
                        // 兩邊都是空的，正常
                    } else { bad(`questions.id=${row.id} 在 PG 找不到`); hashBad++; continue; }
                }
                const h = rowHash(row);
                if (h !== checksums.row_hashes[String(row.id)]) {
                    bad(`questions.id=${row.id} 的逐列雜湊不符（PG ${h.slice(0, 12)}… ≠ 匯出 ${String(checksums.row_hashes[String(row.id)]).slice(0, 12)}…）`);
                    hashBad++;
                }
            }
        }
        if (hashBad === 0) ok(`${ids.length} 列的雜湊全等`);
        console.log('');

        // ── 4. attempts 守恆（裁決 14）──────────────────────
        console.log('4. attempts 守恆：COUNT(attempts) = Σ history_json 鍵數 − 合併與空姓名的差額');
        const keyTotal = report.totals.historyKeys;
        const actual = Number(cnt.attempts);
        const shrink = keyTotal - report.totals.attemptsExpected;
        if (actual === keyTotal && shrink === 0) {
            ok(`attempts ${actual} = history_json 鍵總數 ${keyTotal}，差額 0`);
        } else {
            const detail =
                `attempts ${actual} = history_json 鍵總數 ${keyTotal} − 差額 ${shrink}` +
                `（姓名正規化後為空 ${report.totals.historyKeysDropped} 筆、同題撞鍵 ${report.collisions.length} 組）`;
            if (actual === report.totals.attemptsExpected && allowMerged) {
                notes.push(detail);
                ok(`${detail}；差額逐筆列在 name_merge_report.md，已用 --allow-merged 放行`);
            } else if (actual === report.totals.attemptsExpected) {
                bad(
                    `${detail}。差額逐筆列在 name_merge_report.md（「正規化後合併的姓名」與` +
                    '「同一題出現多個鍵指向同一位學生」兩節）。逐條確認沒有誤判後，加 --allow-merged 放行'
                );
            } else {
                bad(`${detail}，但實際筆數 ${actual} 與差額推得的 ${report.totals.attemptsExpected} 也不符——這才是真的有問題`);
            }
        }
        console.log('');

        // ── 5. Word 產物逐位元比對 ──────────────────────────
        console.log('5. buildParagraphComponents 產物逐位元比對');
        const pool = ids.length > 0 ? ids : questions.map(q => q.id);
        const picked = sampleIds && sampleIds.length > 0 ? sampleIds : pickSample(pool, sampleSize);
        if (picked.length === 0) {
            ok('題庫是空的，略過');
        } else {
            const { rows } = await client.query(
                'SELECT id, question_text, answer_text FROM questions WHERE id = ANY($1::int[]) ORDER BY id', [picked]);
            const pgById = new Map(rows.map(r => [r.id, r]));
            let diffCount = 0;
            for (const id of picked) {
                const src = byId.get(id);
                const dst = pgById.get(id);
                if (!src) { bad(`抽樣的 questions.id=${id} 不在匯出檔裡`); diffCount++; continue; }
                if (!dst) { bad(`抽樣的 questions.id=${id} 不在 PG 裡`); diffCount++; continue; }
                for (const field of ['question_text', 'answer_text']) {
                    const a = stableSerialize(buildParagraphComponents(text(src[field])));
                    const b = stableSerialize(buildParagraphComponents(text(dst[field])));
                    if (a !== b) {
                        bad(`questions.id=${id} 的 ${field} Word 產物在第 ${firstDiff(a, b)} 個字元起不同`);
                        diffCount++;
                    }
                }
            }
            if (diffCount === 0) ok(`抽樣 ${picked.length} 題（id: ${picked.join(', ')}）的題幹與答案 Word 產物完全相同`);
        }
        console.log('');

        // ── 6. 參照完整性與序列 ─────────────────────────────
        console.log('6. 參照完整性與序列');
        const orphan = (await client.query(`
            SELECT (SELECT count(*) FROM attempts a LEFT JOIN students s ON s.id = a.student_id WHERE s.id IS NULL) AS no_student,
                   (SELECT count(*) FROM attempts a LEFT JOIN questions q ON q.id = a.question_id WHERE q.id IS NULL) AS no_question,
                   (SELECT count(*) FROM exam_papers p LEFT JOIN students s ON s.id = p.student_id WHERE s.id IS NULL) AS paper_no_student,
                   (SELECT count(*) FROM attempts WHERE paper_id IS NULL) AS attempts_no_paper`)).rows[0];
        check(Number(orphan.no_student) === 0 && Number(orphan.no_question) === 0 && Number(orphan.paper_no_student) === 0,
            '沒有孤兒列（attempts 與 exam_papers 的外鍵都對得上）',
            `孤兒列：attempts 缺學生 ${orphan.no_student}、缺題目 ${orphan.no_question}、exam_papers 缺學生 ${orphan.paper_no_student}`);
        notes.push(`attempts.paper_id 為 NULL 的有 ${orphan.attempts_no_paper} 筆（舊資料對不上試卷屬預期，見 interfaces-stage1.md §1.3）`);
        console.log(`   ℹ️  attempts.paper_id 為 NULL：${orphan.attempts_no_paper} 筆（屬預期）`);

        for (const table of ['questions', 'exam_papers', 'students']) {
            const r = (await client.query(
                `SELECT COALESCE((SELECT max(id) FROM ${table}), 0) AS max_id,
                        COALESCE(last_value, 0) AS last_value
                   FROM pg_sequences
                  WHERE schemaname || '.' || sequencename = pg_get_serial_sequence($1, 'id')`, [table])).rows[0];
            if (!r) { bad(`找不到 ${table}.id 的序列`); continue; }
            check(Number(r.last_value) >= Number(r.max_id),
                `${table} 序列 ${r.last_value} ≥ max(id) ${r.max_id}`,
                `${table} 的序列 last_value=${r.last_value} < max(id)=${r.max_id}，上線後第一筆 INSERT 會主鍵衝突（漏了 setval）`);
        }
        console.log('');

        // ── 7. 尚未回填的檢索欄位（提醒，不算失敗）───────────
        const pending = (await client.query(
            `SELECT count(*)::int AS n FROM questions WHERE embedding IS NULL`)).rows[0].n;
        const pendingTsv = (await client.query(
            `SELECT count(*)::int AS n FROM questions WHERE search_tsv IS NULL`)).rows[0].n;
        console.log('7. 檢索欄位（本階段由 WS-C 的回填腳本負責，這裡只提醒）');
        console.log(`   ℹ️  embedding IS NULL：${pending} 筆、search_tsv IS NULL：${pendingTsv} 筆 → 請執行「回填向量.bat」`);
        console.log('');

    } finally {
        await client.end();
    }

    if (problems.length > 0) {
        console.log(`❌ 校驗失敗：${problems.length} 項不符。切換之夜的規則是「任一不等即 ROLLBACK、留在 MySQL」。`);
        process.exit(1);
    }
    console.log('✅ 校驗全部通過。');
    if (notes.length > 0) {
        console.log('');
        console.log('備註：');
        for (const n of notes) console.log(`   - ${n}`);
    }

    function check(cond, okMsg, badMsg) {
        if (cond) ok(okMsg); else bad(badMsg);
    }
}

function text(v) {
    return v === null || v === undefined ? '' : String(v);
}

/** 第一個不同的字元位置（1-based）；相同回 0。 */
function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i + 1;
    return a.length === b.length ? 0 : n + 1;
}

/**
 * 隨機抽樣（不重複）。抽到哪幾題會印出來，要重現就用 --sample-ids。
 * @param {number[]} pool
 * @param {number} n
 * @returns {number[]} 由小到大
 */
function pickSample(pool, n) {
    const arr = pool.slice();
    const take = Math.min(n, arr.length);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, take).sort((a, b) => a - b);
}

main().catch(err => {
    console.error('');
    console.error('❌ 校驗過程出錯：' + err.message);
    process.exit(1);
});
