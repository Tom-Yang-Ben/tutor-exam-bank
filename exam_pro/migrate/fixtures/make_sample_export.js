// ─────────────────────────────────────────────────────────────
// migrate/fixtures/make_sample_export.js — 造一份「假裝是 export_mysql.js 倒出來的」小樣本
//
// 為什麼要有這支：
//   import_pg.js 與 verify.js 必須在碰真資料**之前**就被跑通，但 export_mysql.js
//   需要一個裝著真題庫的 MySQL。這支用自製的小樣本直接產出同樣格式的
//   questions.jsonl / exam_papers.jsonl / checksums.json，讓匯入與校驗可以離線演練。
//
// 題目來源（NOTICE：本 repo 不含任何真實考卷題目或題庫備份）：
//   - 4 題由本人自行編寫（就是下面 EXTRA_QUESTIONS 這幾題，改編自課本常見的基本題型，
//     數字與敘述都是自己寫的）。
//   - 2 題直接取自 exam_pro/seed_questions.js（同樣是本專案自製的示範題），
//     用來驗證 import_pg.js 的「題幹相同就設 origin='seed'、chapter_src='human'」。
//
// 用法（在 exam_pro 資料夾內）：
//   node migrate/fixtures/make_sample_export.js                   髒資料版（預設）
//   node migrate/fixtures/make_sample_export.js --clean           乾淨版
//   node migrate/fixtures/make_sample_export.js --out migrate/out2
//
// 髒資料版刻意塞進五種在真題庫裡真的會遇到的狀況：
//   1. history 的鍵是削過 " 的、exam_papers.student_name 是沒削過的 → 同一人兩種字串
//   2. 同一題同時有「王小明」與「王"小明」兩個鍵 → UNIQUE 只容得下一列 attempts
//   3. 「林 小美」與「林　小美」（半形／全形空白）→ 疑似同一人，但**不自動合併**
//   4. 有一個鍵是純空白 → 正規化後為空，不會產生 attempts
//   5. 有一張試卷的日期對得上、另一張對不上 → attempts.paper_id 一邊回填、一邊留 NULL
// ─────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const fs = require('fs');

const {
    DEFAULT_OUT_DIR, parseArgs, sha256, rowHash, countByChapter,
    openJsonlWriter, writeJson, writeText, localIso
} = require('../lib/util');
const { flattenHistory, buildMergeReport, renderMergeReport } = require('../lib/normalize');
const { loadSeedQuestions } = require('../lib/seedTexts');

// 自行編寫的示範題（不是任何考卷上的題目）
const EXTRA_QUESTIONS = [
    {
        subject: '數學', chapter: '指數與對數', question_type: '填空', difficulty: 2,
        question_text: '設 $a = \\log_{2} 6$，則 $2^{a}$ 之值為何？',
        answer_text: '$6$。因為 $2^{\\log_{2} 6} = 6$。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '計算', difficulty: 3,
        question_text: '直角三角形中，$\\sin \\theta = \\frac{3}{5}$ 且 $\\theta$ 為銳角，求 $\\cos \\theta$。',
        answer_text: '$\\frac{4}{5}$。由 $\\sin^2 \\theta + \\cos^2 \\theta = 1$ 得 $\\cos \\theta = \\sqrt{1 - \\frac{9}{25}} = \\frac{4}{5}$（銳角取正）。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 2,
        question_text: '質量 $2\\ \\text{kg}$ 的物體受合力 $10\\ \\text{N}$，求其加速度。',
        answer_text: '$5\\ \\text{m/s}^2$。由 $F = ma$ 得 $a = \\frac{10}{2} = 5$。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '單選', difficulty: 3,
        question_text: '兩物體正碰後黏在一起，下列何者一定守恆？\n(A) 動能　(B) 動量　(C) 兩者皆守恆　(D) 兩者皆不守恆',
        answer_text: '(B)。完全非彈性碰撞中動量守恆，但動能有一部分轉為熱能與形變能。'
    }
];

function main() {
    const args = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(args.get('out', DEFAULT_OUT_DIR));
    const clean = args.has('clean');

    // 取兩題種子題，讓 import_pg.js 的 origin='seed' 標記有東西可比對
    const seeds = loadSeedQuestions().slice(0, 2);
    const base = [...EXTRA_QUESTIONS, ...seeds];

    const questions = base.map((q, i) => ({
        id: i + 1,
        subject: q.subject,
        chapter: q.chapter,
        question_type: q.question_type,
        difficulty: q.difficulty,
        question_text: q.question_text,
        question_img: null,
        answer_text: q.answer_text,
        solution_img: null,
        history_json: {},
        created_at: '2026-05-01 09:00:00'
    }));

    // ── 作答歷史（假學生，全是編出來的名字）────────────────
    if (clean) {
        questions[0].history_json = { 甲同學: '2026-06-01', 乙同學: '2026-06-02' };
        questions[1].history_json = { 甲同學: '2026-06-01' };
        questions[3].history_json = { 乙同學: '2026-06-02' };
    } else {
        // 1+2：同一題兩個鍵指向同一人（削過 " 與沒削過），只能留一列 attempts，取最早日期
        questions[0].history_json = { '王小明': '2026-06-05', '王"小明': '2026-06-01' };
        questions[1].history_json = { '王小明': '2026-06-05' };
        // 3：半形／全形空白 → 疑似同一人，不自動合併
        questions[2].history_json = { '林 小美': '2026-06-03', '林　小美': '2026-06-04' };
        // 4：正規化後為空的鍵
        questions[3].history_json = { '  ': '2026-06-06', '陳大文': '2026-06-06' };
        questions[4].history_json = { '陳大文': '2026-06-07' };
    }

    // ── 試卷 ────────────────────────────────────────────────
    const papers = clean
        ? [
            // created_at 的日期與 attempts.assigned_at 相同 → paper_id 會被回填
            { id: 1, title: '甲同學-指數與對數特訓卷(2026_6_1)', student_name: '甲同學', question_ids: [1, 2], created_at: '2026-06-01 20:10:00' },
            { id: 2, title: '乙同學-動量守恆與碰撞特訓卷(2026_6_9)', student_name: '乙同學', question_ids: [4], created_at: '2026-06-09 20:10:00' }
        ]
        : [
            // student_name 是沒削過 " 的版本，history 的鍵是削過的 → 正規化後合併成同一位學生
            { id: 1, title: '王"小明-指數與對數特訓卷(2026_6_5)', student_name: '王"小明', question_ids: [1, 2], created_at: '2026-06-05 20:10:00' },
            // 日期與任何 attempts 都對不上 → paper_id 留 NULL
            { id: 2, title: '陳大文-動量守恆與碰撞特訓卷(2026_6_30)', student_name: '陳大文', question_ids: [4, 5], created_at: '2026-06-30 20:10:00' },
            { id: 3, title: '林 小美-牛頓運動定律特訓卷(2026_6_3)', student_name: '林 小美', question_ids: [3], created_at: '2026-06-03 20:10:00' }
        ];

    // ── 產出與 export_mysql.js 完全相同格式的三個檔 ──────────
    fs.mkdirSync(outDir, { recursive: true });
    const qFile = path.join(outDir, 'questions.jsonl');
    const pFile = path.join(outDir, 'exam_papers.jsonl');
    const qw = openJsonlWriter(qFile);
    for (const q of questions) qw.write(q);
    qw.close();
    const pw = openJsonlWriter(pFile);
    for (const p of papers) pw.write(p);
    pw.close();

    const report = buildMergeReport({
        historyKeys: flattenHistory(questions),
        paperNames: papers.map(p => ({ name: p.student_name, paperId: p.id }))
    });
    writeText(path.join(outDir, 'name_merge_report.md'), renderMergeReport(report, {
        title: `姓名合併報告（樣本${clean ? '：乾淨版' : '：髒資料版'}）`,
        generatedAt: localIso()
    }));

    const rowHashes = {};
    for (const q of questions) rowHashes[String(q.id)] = rowHash(q);

    writeJson(path.join(outDir, 'checksums.json'), {
        format: 1,
        generated_at: localIso(),
        source: { host: 'fixture', port: 0, database: `sample_${clean ? 'clean' : 'messy'}` },
        counts: { questions: questions.length, exam_papers: papers.length },
        chapter_counts: countByChapter(questions),
        row_hashes: rowHashes,
        history: {
            key_total: report.totals.historyKeys,
            key_dropped: report.totals.historyKeysDropped,
            attempts_expected: report.totals.attemptsExpected,
            students_expected: report.totals.students
        },
        names: {
            merges: report.merges.length,
            suspects: report.suspects.length,
            collisions: report.collisions.length,
            papers_dropped: report.totals.papersDropped
        },
        files: {
            'questions.jsonl': fileStamp(qFile),
            'exam_papers.jsonl': fileStamp(pFile)
        }
    });

    console.log(`✅ 樣本已產生於 ${outDir}（${clean ? '乾淨版' : '髒資料版'}）`);
    console.log(`   questions ${questions.length}、exam_papers ${papers.length}`);
    console.log(`   history 鍵 ${report.totals.historyKeys} → attempts 應有 ${report.totals.attemptsExpected}、students ${report.totals.students}`);
    console.log(`   合併 ${report.merges.length} 組、疑似同一人 ${report.suspects.length} 組、同題撞鍵 ${report.collisions.length} 組`);
}

function fileStamp(file) {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    return { lines: text.split('\n').filter(l => l.trim()).length, bytes: buf.length, sha256: sha256(text) };
}

main();
