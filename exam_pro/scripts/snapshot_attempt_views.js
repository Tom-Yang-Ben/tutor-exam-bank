// ─────────────────────────────────────────────────────────────
// scripts/snapshot_attempt_views.js — 派題與作答拆表（migrations/0016）前後的比對快照
// （〔retrain PR-1〕docs/retrain-and-review.md 第 3.6 節第 5 點、第 7.1 節 R-8）
//
// 0016 把 attempts 拆成 assignments（派題）＋attempt_records（作答），舊名字留成唯讀相容檢視。
// 設計上既有的讀法一個字都不用改、數字也不變；這支讓 Owner 在正式庫上**親眼確認**這件事：
// 套 0016 之前與之後各拍一張快照，再比對，逐欄相同才回 0。只讀不寫，不呼叫任何 LLM。
//
// 用法（在 exam_pro 資料夾內）：
//   1. npm run db:backup                                            先備份（上線流程第一步）
//   2. node scripts/snapshot_attempt_views.js --out=before.json     套 0016 之前拍一張
//   3. npm run migrate                                              套 0016
//   4. node scripts/snapshot_attempt_views.js --out=after.json      套 0016 之後再拍一張
//   5. node scripts/snapshot_attempt_views.js --compare before.json after.json
//      → 「完全相同」回 0；有差異時列出前 50 處、回 1（這時先別用系統，把輸出與兩個檔案留給開發者）。
//   --test  改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）。
//
// 快照的內容（都是既有程式實際在用的 SQL builder，同一份資料在 0016 前後必須得到同樣的結果）：
//   - 作答紀錄逐列摘要：attempts 的筆數與全部欄位的 md5（0016 之前讀表、之後讀檢視）
//   - 每位學生：弱點面板六支（預設 90 天與 365 天）、知識點掌握度兩支、補救卷的章節基底（各科）、
//     題庫覆蓋率的「還沒寫過」、新題候選池（各科）、最近錯題的批改細節、每張卷的題數與已批改數
// 快照只記學生 id，不記姓名。
// 注意：比對只在「套 0016 前後、還沒有任何重練資料」時有意義（重練派題會讓卷層數字變多，那是正確的）。
// ─────────────────────────────────────────────────────────────
'use strict';
require('dotenv').config();
const fs = require('fs');

/** 極簡參數解析：`--key=value`、`--flag`，其餘是位置參數。 */
function parseArgs(argv) {
    const out = { _: [] };
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
        else out._.push(arg);
    }
    return out;
}

/**
 * 兩份快照的差異（純函式）。忽略 meta（拍攝時間、attempts 是表還是檢視）。
 * @param {any} a
 * @param {any} b
 * @param {number} [limit=50] 最多回幾處
 * @returns {string[]} 差異路徑與兩邊的值；空陣列＝完全相同
 */
function diffSnapshots(a, b, limit = 50) {
    const out = [];
    const walk = (x, y, p) => {
        if (out.length >= limit) return;
        if (p === '$.meta') return;
        if (x === y) return;
        const tx = Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x;
        const ty = Array.isArray(y) ? 'array' : y === null ? 'null' : typeof y;
        if (tx !== ty || (tx !== 'object' && tx !== 'array')) {
            out.push(`${p}：${JSON.stringify(x)} → ${JSON.stringify(y)}`);
            return;
        }
        if (tx === 'array' && x.length !== y.length) {
            out.push(`${p}：長度 ${x.length} → ${y.length}`);
        }
        const keys = tx === 'array'
            ? Array.from({ length: Math.min(x.length, y.length) }, (_, i) => i)
            : [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
        for (const k of keys) walk(x[k], y[k], tx === 'array' ? `${p}[${k}]` : `${p}.${k}`);
    };
    walk(a, b, '$');
    return out;
}

/** 沒有 ORDER BY 保證的結果列：排成固定順序再比。 */
const canonical = rows => rows.map(r => JSON.stringify(r)).sort().map(s => JSON.parse(s));

/**
 * 拍快照（I/O）。
 * @param {{query:Function}} db config/db.js
 * @returns {Promise<object>}
 */
async function snapshot(db) {
    const { query } = db;
    const weakness = require('../services/weaknessService');
    const kcWeakness = require('../services/kcWeaknessService');
    const remedial = require('../services/remedialService');
    const coverage = require('../services/coverageService');
    const { buildCandidatePoolQuery } = require('../controllers/examController');
    const { _internals: studentInternals } = require('../controllers/studentController');
    const { SUBJECTS } = require('../config/chapters');
    const run = async ({ text, values }) => (await query(text, values)).rows;

    const { rows: [kind] } = await query(
        `SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass('attempts')`);
    const { rows: [digest] } = await query(
        `SELECT COUNT(*)::int AS count,
                md5(COALESCE(string_agg(concat_ws('|', id, student_id, question_id, paper_id, assigned_at, result,
                                                  graded_at, score, error_types, response, teacher_note),
                                        E'\\n' ORDER BY id), '')) AS md5
           FROM attempts`);

    const { rows: students } = await query('SELECT id FROM students ORDER BY id');
    const out = [];
    for (const { id: studentId } of students) {
        const s = { student_id: studentId, weakness: {}, kc: {}, remedial: {}, candidates: {} };
        for (const days of [90, 365]) {
            const o = { studentId, subject: null, days };
            for (const b of ['buildByChapter', 'buildByType', 'buildByDifficulty', 'buildTrendWeekly',
                'buildRecentWrong', 'buildByErrorType']) {
                s.weakness[`${b}@${days}`] = await run(weakness[b](o));
            }
            s.kc[`aggregate@${days}`] = canonical(await run(kcWeakness.buildKcAggregate(o)));
            s.kc[`tagCounts@${days}`] = await run(kcWeakness.buildGradedTagCounts(o));
        }
        for (const subject of SUBJECTS) {
            s.remedial[subject] = canonical(await run(remedial.buildChapterMastery(
                { studentId, subject, days: remedial.DEFAULT_DAYS })));
            s.candidates[subject] = (await run(buildCandidatePoolQuery({ subject, studentId })))
                .map(r => r.id).sort((x, y) => x - y);
        }
        s.coverage = canonical(await run(coverage.buildChapterCoverage({ subject: null, studentId })));
        const { rows: qids } = await query('SELECT question_id FROM attempts WHERE student_id = $1', [studentId]);
        s.recent_wrong_detail = canonical(await run(
            studentInternals.buildRecentWrongDetail(studentId, qids.map(r => r.question_id))));
        // 每張卷的題數與已批改數（拆表之後、還沒有重練派題時，檢視 attempts 就是全部派題）
        s.papers = await run({
            text: `SELECT p.id AS paper_id, cardinality(p.question_ids) AS total,
                          (SELECT COUNT(*) FROM attempts a WHERE a.paper_id = p.id)::int AS assigned,
                          (SELECT COUNT(*) FROM attempts a WHERE a.paper_id = p.id AND a.result IS NOT NULL)::int AS graded
                     FROM exam_papers p WHERE p.student_id = $1 ORDER BY p.id`,
            values: [studentId]
        });
        out.push(s);
    }
    return {
        meta: { taken_at: new Date().toISOString(), attempts_relkind: kind ? kind.relkind : null },
        attempts: digest,
        students: out
    };
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.compare) {
        const [fa, fb] = args._;
        if (!fa || !fb) throw new Error('用法：--compare <before.json> <after.json>');
        const a = JSON.parse(fs.readFileSync(fa, 'utf8'));
        const b = JSON.parse(fs.readFileSync(fb, 'utf8'));
        const diffs = diffSnapshots(a, b);
        if (diffs.length === 0) {
            console.log(`✅ 完全相同：${a.attempts.count} 筆作答、${a.students.length} 位學生`
                + `（attempts：${a.meta.attempts_relkind === 'r' ? '表' : '檢視'} → ${b.meta.attempts_relkind === 'r' ? '表' : '檢視'}）。`);
            return 0;
        }
        console.log(`❌ 有差異（列出前 ${diffs.length} 處）：`);
        for (const d of diffs) console.log('  ' + d);
        return 1;
    }
    if (!args.out || args.out === true) throw new Error('用法：--out=<檔名>（或 --compare <before.json> <after.json>）');

    if (args.test) {
        const url = (process.env.TEST_DATABASE_URL || '').trim();
        if (!url) throw new Error('--test 需要 TEST_DATABASE_URL。');
        if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾。');
        process.env.DATABASE_URL = url;
    }
    const db = require('../config/db');
    try {
        const snap = await snapshot(db);
        fs.writeFileSync(args.out, JSON.stringify(snap, null, 1) + '\n', 'utf8');
        console.log(`已寫入 ${args.out}：${snap.attempts.count} 筆作答、${snap.students.length} 位學生`
            + `（attempts 目前是${snap.meta.attempts_relkind === 'r' ? '表' : '檢視'}）。`);
        return 0;
    } finally {
        await db.pool.end();
    }
}

module.exports = { parseArgs, diffSnapshots, canonical, snapshot, main };

if (require.main === module) {
    main().then(code => { process.exitCode = code; })
        .catch(err => { console.error('❌ ' + err.message); process.exitCode = 1; });
}
