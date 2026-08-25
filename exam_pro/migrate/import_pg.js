// ─────────────────────────────────────────────────────────────
// migrate/import_pg.js — 把 export_mysql.js 的 JSONL 匯入 PostgreSQL（D-D5，規劃 §5.3.6 步驟 3）
//
// 用法（在 exam_pro 資料夾內）：
//   node migrate/import_pg.js                    ← 預設 --dry-run：全部跑完但 ROLLBACK
//   node migrate/import_pg.js --apply            ← 真的寫入（COMMIT）
//   node migrate/import_pg.js --test --apply     ← 打 TEST_DATABASE_URL（庫名須以 _test 結尾）
//   node migrate/import_pg.js --in D:\匯出       ← 指定匯出資料夾（預設 migrate/out）
//
// 其他旗標：
//   --force                  目標表已有資料時仍繼續（預設拒絕，避免把匯入疊在既有資料上）
//   --unknown-student=<姓名>  student_name 正規化後為空的試卷改掛到這個學生。
//                            **裁決 15 明定不走這條**：正解是回舊 MySQL 把姓名補好再重跑 export。
//                            旗標留著只為了「真的查不出是誰」的例外，用了要在報告裡說明是誰決定的。
//   --skip-bad-dates         history_json 的日期不是 YYYY-MM-DD 時略過該筆（預設直接中止）
//   --tz=Asia/Taipei         MySQL 的 DATETIME 沒有時區，用這個時區解讀成 TIMESTAMPTZ
//
// 設計要點（來自 §1.5 的裁決與 interfaces-stage1.md）：
//   1. **單一交易**。任何一項檢查不過就 ROLLBACK，資料庫回到匯入前的樣子。
//   2. **保留原 id**：0001_init.sql 用 GENERATED ALWAYS AS IDENTITY，必須寫
//      `OVERRIDING SYSTEM VALUE`；最後對 questions / exam_papers / students 各跑一次 setval，
//      否則上線後第一筆 INSERT 就主鍵衝突（interfaces-stage1.md §1.5 第 9 條）。
//   3. **history_json 在 PG 端展開**：JSONL 先批次灌進 TEMP 表，再用一條
//      `jsonb_each_text` 的 INSERT … SELECT 展成 students + attempts，
//      不在 Node 迴圈裡逐筆 INSERT（規劃 §2.3.5 步驟 3）。
//   4. **question_ids 是 INT[]**（不是 JSON），**exam_papers.student_id 是 NOT NULL**，
//      **attempts.question_id 是 ON DELETE RESTRICT**（interfaces-stage1.md §1.5 第 1~3 條）。
//   5. **姓名正規化只有一條規則**，JS 與 SQL 兩份實作在匯入前先逐筆對過（自我檢查）。
//   6. **舊題一律 `origin='legacy'`**（裁決 13，需先套用 `0004_origin_legacy.sql`）；
//      只有題幹與 `seed_questions.js` 完全相同的 30 題寫 `'seed'` + `chapter_src='human'`。
//
// 不寫 search_tsv / embedding：那是 WS-C 的 backfill_embeddings.js 的責任
// （規劃 §2.3.6 的寫入路徑表：migrate 這一列的 embedding 欄是「不做，交給回填」）。
// 匯入後請執行「回填向量.bat」。
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

const {
    DEFAULT_OUT_DIR, parseArgs, resolvePgUrl, sha256, countByChapter,
    readJsonl, readJson, writeJson, writeText, localIso, chunk
} = require('./lib/util');
const {
    normalizeName, pgNormalizeSql, parseHistory, flattenHistory,
    buildMergeReport, renderMergeReport
} = require('./lib/normalize');
const { loadSeedTexts } = require('./lib/seedTexts');

const LOAD_BATCH = 500;          // 每批灌進 TEMP 表的筆數
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const inDir = path.resolve(args.get('in', DEFAULT_OUT_DIR));
    const apply = args.has('apply');
    const useTest = args.has('test');
    const force = args.has('force');
    const tz = args.get('tz', 'Asia/Taipei');
    const unknownStudent = args.has('unknown-student') ? normalizeName(args.get('unknown-student', '')) : null;
    const skipBadDates = args.has('skip-bad-dates');

    console.log(`📥 匯入來源資料夾：${inDir}`);
    console.log(`   模式：${apply ? '⚠️  --apply（會 COMMIT）' : '🔍 dry-run（跑完一律 ROLLBACK）'}`);

    // ── 1. 讀匯出檔並確認就是同一份 ──────────────────────────
    const checksums = readJson(path.join(inDir, 'checksums.json'));
    const questions = readJsonl(path.join(inDir, 'questions.jsonl'));
    const papers = readJsonl(path.join(inDir, 'exam_papers.jsonl'));
    assertFileStamp(inDir, 'questions.jsonl', checksums);
    assertFileStamp(inDir, 'exam_papers.jsonl', checksums);
    if (questions.length !== checksums.counts.questions) {
        throw new Error(`questions.jsonl 有 ${questions.length} 列，checksums.json 說應該是 ${checksums.counts.questions} 列`);
    }
    if (papers.length !== checksums.counts.exam_papers) {
        throw new Error(`exam_papers.jsonl 有 ${papers.length} 列，checksums.json 說應該是 ${checksums.counts.exam_papers} 列`);
    }
    console.log(`   questions ${questions.length} 筆、exam_papers ${papers.length} 筆（校驗檔相符）`);

    // ── 2. 姓名合併報告（重新算一次，不直接信 checksums）──────
    const historyKeys = flattenHistory(questions);
    const paperNames = papers.map(p => ({ name: p.student_name, paperId: p.id }));
    const report = buildMergeReport({ historyKeys, paperNames });
    console.log(`   姓名：students ${report.totals.students} 位、合併 ${report.merges.length} 組、疑似同一人 ${report.suspects.length} 組、同題撞鍵 ${report.collisions.length} 組`);

    if (report.totals.papersDropped > 0 && !unknownStudent) {
        const ids = report.dropped.paperNames.map(d => d.paperId).join(', ');
        throw new Error(
            `有 ${report.totals.papersDropped} 張試卷的 student_name 正規化後是空字串（exam_papers.id = ${ids}）。\n` +
            '   exam_papers.student_id 是 NOT NULL（interfaces-stage1.md §1.5 第 2 條），不能自己編一個學生塞進去，\n' +
            '   也不會靜默丟掉這幾張卷。\n' +
            '   → 依裁決 15：回舊 MySQL 把這幾張卷的 student_name 補好，再重跑 export_mysql.js。\n' +
            '     （--unknown-student="未知學生" 只保留給「真的查不出是誰」的例外，不建議使用；\n' +
            '      用了請在 import_report.md 註明是誰決定的。）'
        );
    }

    // ── 3. history_json 的日期先驗過 ─────────────────────────
    const badDates = [];
    for (const q of questions) {
        const h = parseHistory(q.history_json);
        for (const [k, v] of Object.entries(h)) {
            if (!DATE_RE.test(String(v == null ? '' : v))) badDates.push({ id: q.id, key: k, value: v });
        }
    }
    if (badDates.length > 0 && !skipBadDates) {
        const sample = badDates.slice(0, 10).map(b => `questions.id=${b.id} 的「${b.key}」= ${JSON.stringify(b.value)}`).join('\n     ');
        throw new Error(
            `history_json 有 ${badDates.length} 筆日期不是 YYYY-MM-DD：\n     ${sample}\n` +
            '   assigned_at 是 DATE NOT NULL，硬轉會炸在交易中間。請先修好來源資料，' +
            '或加 --skip-bad-dates 明確接受「這些作答紀錄不匯入」（會列進報告）。'
        );
    }
    if (badDates.length > 0) console.log(`   ⚠️  ${badDates.length} 筆日期格式不合，依 --skip-bad-dates 略過`);

    // ── 4. 連 PG，開交易 ────────────────────────────────────
    const client = new Client({ connectionString: resolvePgUrl({ test: useTest }) });
    await client.connect();
    let committed = false;
    const stats = {};
    try {
        await client.query('BEGIN');
        // MySQL 的 DATETIME 沒有時區，用 --tz 指定的時區把它解讀成 TIMESTAMPTZ；
        // 也讓 exam_papers.created_at::date 與 attempts.assigned_at 的比對是在同一個時區下做的。
        await client.query(`SET LOCAL TimeZone = ${quoteLiteral(tz)}`);

        await assertMigrated(client);
        await assertEmpty(client, force);

        // ── 5. JSONL → TEMP 表（批次 unnest，不逐列 INSERT）──
        await client.query(`
            CREATE TEMP TABLE mq (
                id INT PRIMARY KEY, subject TEXT, chapter TEXT, question_type TEXT, difficulty SMALLINT,
                question_text TEXT, question_img TEXT, answer_text TEXT, solution_img TEXT,
                history_json JSONB, created_at TIMESTAMP
            ) ON COMMIT DROP`);
        await client.query(`
            CREATE TEMP TABLE mp (
                id INT PRIMARY KEY, title TEXT, student_name TEXT, question_ids JSONB, created_at TIMESTAMP
            ) ON COMMIT DROP`);

        for (const part of chunk(questions, LOAD_BATCH)) {
            await client.query(
                `INSERT INTO mq SELECT * FROM unnest(
                     $1::int[], $2::text[], $3::text[], $4::text[], $5::smallint[],
                     $6::text[], $7::text[], $8::text[], $9::text[], $10::jsonb[], $11::timestamp[])`,
                [
                    part.map(r => r.id),
                    part.map(r => r.subject),
                    part.map(r => r.chapter),
                    part.map(r => r.question_type),
                    part.map(r => r.difficulty),
                    part.map(r => r.question_text),
                    part.map(r => r.question_img),
                    part.map(r => r.answer_text),
                    part.map(r => r.solution_img),
                    part.map(r => JSON.stringify(parseHistory(r.history_json))),
                    part.map(r => r.created_at)
                ]
            );
        }
        for (const part of chunk(papers, LOAD_BATCH)) {
            await client.query(
                `INSERT INTO mp SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::jsonb[], $5::timestamp[])`,
                [
                    part.map(r => r.id),
                    part.map(r => r.title),
                    part.map(r => r.student_name),
                    part.map(r => JSON.stringify(toIdArray(r.question_ids, r.id))),
                    part.map(r => r.created_at)
                ]
            );
        }
        console.log(`   TEMP 表已載入（mq ${questions.length}、mp ${papers.length}）`);

        // ── 6. 自我檢查：JS 與 SQL 的姓名正規化必須一模一樣 ──
        await assertNormalizeAgrees(client, historyKeys, paperNames);

        // ── 7. questions（保留原 id）────────────────────────
        // origin 一律寫 'legacy'（interfaces-stage1.md 裁決 13 / migrations/0004_origin_legacy.sql）：
        // 舊 schema 分不出這題是 AI 拆 PDF 進來的還是老師手動新增的，'legacy' 就是
        // 「來源未知」的誠實說法，不要拿 'pdf' 假裝知道。chapter_src 用 DDL 預設的 'ai'。
        const qIns = await client.query(`
            INSERT INTO questions (id, subject, chapter, question_type, difficulty,
                                   question_text, question_img, answer_text, solution_img, created_at,
                                   origin, chapter_src)
            OVERRIDING SYSTEM VALUE
            SELECT id, subject, chapter, question_type, difficulty,
                   question_text, question_img, answer_text, solution_img, created_at,
                   'legacy', 'ai'
              FROM mq ORDER BY id`);
        stats.questions = qIns.rowCount;

        // 種子題（自己編的 30 題示範題）是唯一的例外：題幹完全相同就標成
        // origin='seed'、chapter_src='human'（章節是人工標的，不是 AI 猜的）。
        const seedTexts = loadSeedTexts();
        const seedUpd = await client.query(
            `UPDATE questions SET origin = 'seed', chapter_src = 'human' WHERE question_text = ANY($1::text[])`,
            [seedTexts]
        );
        stats.seedMarked = seedUpd.rowCount;
        console.log(`   questions ${stats.questions} 筆（origin='legacy'）；其中 ${stats.seedMarked}/${seedTexts.length} 題比對到種子題，改標 origin='seed'、chapter_src='human'`);
        if (seedTexts.length > 0 && stats.seedMarked < seedTexts.length) {
            console.log(`   ↳ 有 ${seedTexts.length - stats.seedMarked} 題種子題沒比對到（題庫裡沒灌，或題幹被公式修正改過），維持 origin='legacy'`);
        }

        // ── 8. students：兩個來源聯集，同一條正規化規則 ──────
        const NK = pgNormalizeSql('e.key');
        const NS = pgNormalizeSql('mp.student_name');
        // 明確給 id（既有最大值 + 依姓名排序的序號），dry-run 與正式匯入才會產生一模一樣的
        // students.id——序列不受 ROLLBACK 影響，若交給 IDENTITY 自動配號，跑過一次 dry-run
        // 之後正式匯入的 id 就會整批位移，報告對不起來。
        const stuIns = await client.query(`
            INSERT INTO students (id, name)
            OVERRIDING SYSTEM VALUE
            SELECT (SELECT COALESCE(max(id), 0) FROM students) + row_number() OVER (ORDER BY name), name
              FROM (
                SELECT DISTINCT name FROM (
                    SELECT ${NK} AS name FROM mq CROSS JOIN LATERAL jsonb_each_text(mq.history_json) e
                    UNION
                    SELECT ${NS} AS name FROM mp
                ) u WHERE name <> ''
              ) s
            ON CONFLICT (name) DO NOTHING`);
        stats.students = stuIns.rowCount;
        console.log(`   students ${stats.students} 筆`);

        // ── 9. exam_papers（question_ids JSON → INT[]；student_id NOT NULL）──
        if (unknownStudent) {
            await client.query(
                `INSERT INTO students (id, name) OVERRIDING SYSTEM VALUE
                 SELECT (SELECT COALESCE(max(id), 0) FROM students) + 1, $1
                 ON CONFLICT (name) DO NOTHING`, [unknownStudent]);
        }
        const paperStudentExpr = unknownStudent
            ? `COALESCE(NULLIF(${NS}, ''), ${quoteLiteral(unknownStudent)})`
            : NS;
        const paperIns = await client.query(`
            INSERT INTO exam_papers (id, title, student_id, question_ids, created_at)
            OVERRIDING SYSTEM VALUE
            SELECT mp.id, mp.title, s.id,
                   COALESCE(ARRAY(SELECT jsonb_array_elements_text(mp.question_ids)::int), '{}'::int[]),
                   mp.created_at
              FROM mp JOIN students s ON s.name = ${paperStudentExpr}
             ORDER BY mp.id`);
        stats.papers = paperIns.rowCount;
        console.log(`   exam_papers ${stats.papers} 筆`);

        // ── 10. attempts：history_json 在 PG 端展開 ─────────
        // DISTINCT ON (student_id, question_id) + ORDER BY assigned_at：
        // 同一題若有多個鍵指向同一位學生（例如「王小明」與「王"小明」），
        // UNIQUE(student_id, question_id) 只容得下一列，取最早的日期，
        // 與 lib/normalize.js 的 collisions 報告一致。
        const attIns = await client.query(`
            INSERT INTO attempts (student_id, question_id, assigned_at)
            SELECT DISTINCT ON (s.id, mq.id) s.id, mq.id, e.value::date
              FROM mq
              CROSS JOIN LATERAL jsonb_each_text(mq.history_json) e
              JOIN students s ON s.name = ${NK}
             WHERE e.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
             ORDER BY s.id, mq.id, e.value::date ASC`);
        stats.attempts = attIns.rowCount;
        console.log(`   attempts ${stats.attempts} 筆`);

        // ── 11. 回填 paper_id：同學生、同一天、且該卷含這一題 ──
        // 對不上就留 NULL（interfaces-stage1.md §1.3 的註解已明說允許）。
        // 多張卷同時符合時取最小的 paper_id，讓結果可重現。
        const pidUpd = await client.query(`
            UPDATE attempts a SET paper_id = m.paper_id
              FROM (
                SELECT a2.id AS attempt_id, MIN(p.id) AS paper_id
                  FROM attempts a2
                  JOIN exam_papers p
                    ON p.student_id = a2.student_id
                   AND p.question_ids @> ARRAY[a2.question_id]
                   AND p.created_at::date = a2.assigned_at
                 GROUP BY a2.id
              ) m
             WHERE a.id = m.attempt_id`);
        stats.paperIdFilled = pidUpd.rowCount;
        console.log(`   attempts.paper_id 回填 ${stats.paperIdFilled} 筆（其餘留 NULL）`);

        // ── 12. setval：不做的話上線第一筆 INSERT 就主鍵衝突 ──
        for (const table of ['questions', 'exam_papers', 'students']) {
            await client.query(
                `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT max(id) FROM ${table}), 1), (SELECT count(*) FROM ${table}) > 0)`,
                [table]
            );
        }
        const seqs = {};
        for (const table of ['questions', 'exam_papers', 'students', 'attempts']) {
            const r = await client.query(
                `SELECT last_value, COALESCE((SELECT max(id) FROM ${table}), 0) AS max_id
                   FROM pg_sequences
                  WHERE schemaname || '.' || sequencename = pg_get_serial_sequence($1, 'id')`, [table]);
            seqs[table] = r.rows[0] || null;
        }
        stats.sequences = seqs;
        console.log(`   序列已對齊：questions→${fmtSeq(seqs.questions)}、exam_papers→${fmtSeq(seqs.exam_papers)}、students→${fmtSeq(seqs.students)}`);

        // ── 13. 交易內先驗一次，不過就 ROLLBACK ────────────
        const problems = await verifyInTransaction(client, { checksums, report, questions, stats, skipBadDates, badDates, unknownStudent });
        stats.problems = problems;

        // ── 14. 報告與切換標記 ─────────────────────────────
        const cutover = {
            format: 1,
            imported_at: localIso(),
            applied: apply,
            source: checksums.source,
            export_generated_at: checksums.generated_at,
            // export_pg_delta.js 用這三個界線判斷「哪些是切換之後才新增的」
            max_ids: {
                questions: maxId(questions),
                exam_papers: maxId(papers),
                students: Number((await client.query('SELECT COALESCE(max(id), 0) AS m FROM students')).rows[0].m),
                attempts: Number((await client.query('SELECT COALESCE(max(id), 0) AS m FROM attempts')).rows[0].m)
            },
            counts: {
                questions: stats.questions, exam_papers: stats.papers,
                students: stats.students, attempts: stats.attempts
            }
        };
        writeText(path.join(inDir, 'import_report.md'), renderImportReport({
            checksums, report, stats, cutover, apply, badDates, skipBadDates, unknownStudent, tz, problems
        }));
        writeText(path.join(inDir, 'name_merge_report.md'), renderMergeReport(report, {
            title: '姓名合併報告（MySQL → PostgreSQL）',
            generatedAt: localIso()
        }));

        if (problems.length > 0) {
            console.log('');
            for (const p of problems) console.log(`   ❌ ${p}`);
            await client.query('ROLLBACK');
            throw new Error(`交易內校驗有 ${problems.length} 項不符，已 ROLLBACK。詳見 ${path.join(inDir, 'import_report.md')}`);
        }

        if (apply) {
            await client.query('COMMIT');
            committed = true;
            writeJson(path.join(inDir, 'cutover.json'), cutover);
            console.log('');
            console.log(`✅ 已 COMMIT。切換界線寫入 ${path.join(inDir, 'cutover.json')}（export_pg_delta.js 會用到）。`);
            console.log('   下一步：node migrate/verify.js  → 再執行「回填向量.bat」補 embedding 與 search_tsv。');
        } else {
            await client.query('ROLLBACK');
            console.log('');
            console.log('✅ dry-run 全部通過，已 ROLLBACK（資料庫沒有被寫入）。');
            console.log(`   報告：${path.join(inDir, 'import_report.md')}`);
            console.log('   確認無誤後加 --apply 再跑一次。');
        }
    } catch (err) {
        if (!committed) { try { await client.query('ROLLBACK'); } catch (e) { /* 連線已斷就算了 */ } }
        throw err;
    } finally {
        await client.end();
    }
}

// ── 輔助 ─────────────────────────────────────────────────────

/** PG 字串字面量（只給固定值用，不接使用者輸入以外的 SQL 片段）。 */
function quoteLiteral(s) {
    return `'` + String(s).replace(/'/g, `''`) + `'`;
}

function fmtSeq(s) {
    if (!s) return '(無)';
    return `last_value=${s.last_value}（max(id)=${s.max_id}）`;
}

function maxId(rows) {
    return rows.reduce((m, r) => (r.id > m ? r.id : m), 0);
}

/**
 * question_ids 可能是陣列（MySQL JSON 欄位）或字串（更舊的 TEXT 欄位）。
 * @param {any} value
 * @param {number} paperId 只用在錯誤訊息
 * @returns {number[]}
 */
function toIdArray(value, paperId) {
    let v = value;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { throw new Error(`exam_papers.id=${paperId} 的 question_ids 不是合法 JSON：${value}`); }
    }
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`exam_papers.id=${paperId} 的 question_ids 不是陣列：${JSON.stringify(value)}`);
    return v.map(x => {
        const n = Number(x);
        if (!Number.isInteger(n)) throw new Error(`exam_papers.id=${paperId} 的 question_ids 含非整數：${JSON.stringify(x)}`);
        return n;
    });
}

function assertFileStamp(dir, name, checksums) {
    const stamp = checksums.files && checksums.files[name];
    if (!stamp) return;                       // 舊格式的匯出檔沒有這一段，不強制
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const got = sha256(text);
    if (got !== stamp.sha256) {
        throw new Error(`${name} 的 sha256 與 checksums.json 不符（檔案被改過或不是同一次匯出）。\n   期望 ${stamp.sha256}\n   實際 ${got}`);
    }
}

async function assertMigrated(client) {
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    // 0004 是 origin='legacy' 的前提（裁決 13）：沒套用的話下面的 INSERT 會撞 CHECK 約束
    for (const need of ['0001_init.sql', '0002_vector.sql', '0004_origin_legacy.sql']) {
        if (!applied.has(need)) throw new Error(`目標資料庫還沒套用 ${need}，請先執行 npm run migrate（或雙擊「啟動資料庫.bat」）`);
    }
}

async function assertEmpty(client, force) {
    const { rows } = await client.query(`
        SELECT (SELECT count(*) FROM questions)   AS questions,
               (SELECT count(*) FROM students)    AS students,
               (SELECT count(*) FROM exam_papers) AS exam_papers,
               (SELECT count(*) FROM attempts)    AS attempts`);
    const r = rows[0];
    const nonEmpty = Object.entries(r).filter(([, v]) => Number(v) > 0);
    if (nonEmpty.length === 0) return;
    const desc = nonEmpty.map(([k, v]) => `${k}=${v}`).join('、');
    if (!force) {
        throw new Error(
            `目標資料庫不是空的（${desc}）。一次性遷移只能匯進空庫，否則 id 會撞、筆數校驗也失去意義。\n` +
            '   要清空請用： docker compose exec -T postgres psql -U exam -d tutor_exam_bank ' +
            '-c "TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE"\n' +
            '   確定要疊加匯入才加 --force。'
        );
    }
    console.log(`   ⚠️  目標資料庫已有資料（${desc}），依 --force 繼續`);
}

/**
 * 自我檢查：把所有原始姓名丟給 PG 用 pgNormalizeSql 算一次，跟 JS 的 normalizeName 比對。
 * 兩份實作只要有一個字元不同，attempts 就會掛到錯的學生身上——寧可在這裡中止。
 */
async function assertNormalizeAgrees(client, historyKeys, paperNames) {
    const raws = [...new Set([
        ...historyKeys.map(h => String(h.name)),
        ...paperNames.map(p => (p.name == null ? '' : String(p.name)))
    ])];
    if (raws.length === 0) return;
    const mismatches = [];
    for (const part of chunk(raws, 500)) {
        const { rows } = await client.query(
            `SELECT t AS raw, ${pgNormalizeSql('t')} AS norm FROM unnest($1::text[]) t`, [part]
        );
        for (const row of rows) {
            const js = normalizeName(row.raw);
            if (js !== row.norm) mismatches.push({ raw: row.raw, js, sql: row.norm });
        }
    }
    if (mismatches.length > 0) {
        const sample = mismatches.slice(0, 5)
            .map(m => `${JSON.stringify(m.raw)} → JS ${JSON.stringify(m.js)} / SQL ${JSON.stringify(m.sql)}`).join('\n     ');
        throw new Error(
            `姓名正規化的 JS 與 SQL 兩份實作結果不一致（${mismatches.length} 筆）：\n     ${sample}\n` +
            '   請修 migrate/lib/normalize.js 的 normalizeName 或 pgNormalizeSql，兩邊必須完全相同。'
        );
    }
    console.log(`   姓名正規化自我檢查通過（${raws.length} 種原始字串，JS 與 SQL 結果全等）`);
}

/**
 * 交易內的校驗：筆數、各章筆數、逐列雜湊、attempts 筆數。
 * 逐列雜湊在 PG 端用內建的 sha256()（PG 11+，不需 pgcrypto）算，
 * 與 verify.js 在 Node 端算的是兩份獨立實作，互為交叉驗證。
 * @returns {Promise<string[]>} 問題清單；空陣列代表全過
 */
async function verifyInTransaction(client, ctx) {
    const { checksums, report, questions, stats, skipBadDates, badDates } = ctx;
    const problems = [];

    const cnt = (await client.query(`
        SELECT (SELECT count(*) FROM questions)   AS questions,
               (SELECT count(*) FROM exam_papers) AS exam_papers,
               (SELECT count(*) FROM students)    AS students,
               (SELECT count(*) FROM attempts)    AS attempts`)).rows[0];

    if (Number(cnt.questions) !== checksums.counts.questions) {
        problems.push(`questions 筆數 ${cnt.questions} ≠ 匯出的 ${checksums.counts.questions}`);
    }
    if (Number(cnt.exam_papers) !== checksums.counts.exam_papers) {
        problems.push(`exam_papers 筆數 ${cnt.exam_papers} ≠ 匯出的 ${checksums.counts.exam_papers}`);
    }
    if (Number(cnt.students) !== report.totals.students + (ctx.unknownStudent ? 1 : 0)) {
        problems.push(`students 筆數 ${cnt.students} ≠ 姓名報告推得的 ${report.totals.students}`);
    }

    // attempts：期望值是「去重後的學生×題目配對數」，被略過的壞日期要扣掉
    let expectedAttempts = report.totals.attemptsExpected;
    if (skipBadDates) expectedAttempts = await recomputeAttemptsExpected(questions, badDates);
    if (Number(cnt.attempts) !== expectedAttempts) {
        problems.push(
            `attempts 筆數 ${cnt.attempts} ≠ 期望的 ${expectedAttempts}` +
            `（history_json 鍵總數 ${report.totals.historyKeys}、正規化後為空 ${report.totals.historyKeysDropped}、` +
            `同題撞鍵 ${report.collisions.length} 組）`
        );
    }

    // 各章筆數
    const chap = (await client.query('SELECT subject, chapter, count(*)::int AS n FROM questions GROUP BY 1,2')).rows;
    const got = {};
    for (const r of chap) got[`${r.subject}｜${r.chapter}`] = r.n;
    const want = checksums.chapter_counts || countByChapter(questions);
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
        if ((want[k] || 0) !== (got[k] || 0)) problems.push(`章節「${k}」筆數 ${got[k] || 0} ≠ 匯出的 ${want[k] || 0}`);
    }

    // 逐列 sha256(question_text + answer_text)
    const ids = Object.keys(checksums.row_hashes || {}).map(Number);
    let hashChecked = 0;
    for (const part of chunk(ids, 1000)) {
        const { rows } = await client.query(
            `SELECT e.id, encode(sha256(convert_to(coalesce(q.question_text,'') || coalesce(q.answer_text,''), 'UTF8')), 'hex') AS h
               FROM unnest($1::int[]) AS e(id)
               LEFT JOIN questions q ON q.id = e.id`, [part]
        );
        for (const row of rows) {
            hashChecked++;
            const want2 = checksums.row_hashes[String(row.id)];
            if (row.h === null) problems.push(`questions.id=${row.id} 在 PG 找不到`);
            else if (row.h !== want2) problems.push(`questions.id=${row.id} 的逐列雜湊不符`);
        }
    }
    stats.hashChecked = hashChecked;
    stats.expectedAttempts = expectedAttempts;
    return problems;
}

/** --skip-bad-dates 時重算 attempts 期望值（把壞日期的鍵剔掉後再去重）。 */
async function recomputeAttemptsExpected(questions, badDates) {
    const bad = new Set(badDates.map(b => `${b.id}\u0000${b.key}`));
    const pairs = new Set();
    for (const q of questions) {
        const h = parseHistory(q.history_json);
        for (const k of Object.keys(h)) {
            if (bad.has(`${q.id}\u0000${k}`)) continue;
            const n = normalizeName(k);
            if (!n) continue;
            pairs.add(`${n}\u0000${q.id}`);
        }
    }
    return pairs.size;
}

function renderImportReport(ctx) {
    const { checksums, report, stats, cutover, apply, badDates, skipBadDates, unknownStudent, tz, problems } = ctx;
    const L = [];
    L.push('# 匯入報告（MySQL → PostgreSQL）');
    L.push('');
    L.push(`- 執行時間：${cutover.imported_at}`);
    L.push(`- 模式：${apply ? '**--apply（已 COMMIT）**' : 'dry-run（已 ROLLBACK）'}`);
    L.push(`- 匯出檔產生時間：${checksums.generated_at}`);
    L.push(`- 來源：mysql://${checksums.source.host}:${checksums.source.port}/${checksums.source.database}`);
    L.push(`- DATETIME 解讀時區：\`${tz}\``);
    if (unknownStudent) L.push(`- 姓名為空的試卷歸屬到：\`${unknownStudent}\``);
    L.push('');
    L.push('## 筆數');
    L.push('');
    L.push('| 表 | 匯入筆數 | 期望 |');
    L.push('|---|---|---|');
    L.push(`| questions | ${stats.questions} | ${checksums.counts.questions} |`);
    L.push(`| exam_papers | ${stats.papers} | ${checksums.counts.exam_papers} |`);
    L.push(`| students | ${stats.students} | ${report.totals.students} |`);
    L.push(`| attempts | ${stats.attempts} | ${stats.expectedAttempts} |`);
    L.push('');
    L.push(`逐列雜湊已比對 ${stats.hashChecked} 列；attempts.paper_id 回填 ${stats.paperIdFilled} 筆（其餘留 NULL，屬預期）。`);
    L.push('');
    L.push(`來源標記：舊題一律 \`origin='legacy'\`（裁決 13 = 來源未知）；其中 ${stats.seedMarked} 題比對到 \`seed_questions.js\` 的題幹，改標 \`origin='seed'\` + \`chapter_src='human'\`。`);
    L.push('');
    L.push('## history_json → attempts 的筆數怎麼算出來的');
    L.push('');
    L.push('| 項目 | 數量 |');
    L.push('|---|---|');
    L.push(`| history_json 鍵總數 | ${report.totals.historyKeys} |`);
    L.push(`| 減：姓名正規化後為空 | ${report.totals.historyKeysDropped} |`);
    L.push(`| 減：同一題多個鍵指向同一人（只能留一列） | ${report.collisions.length} 組 |`);
    if (skipBadDates) L.push(`| 減：日期格式不合被略過 | ${badDates.length} |`);
    L.push(`| **= attempts 應有筆數** | **${stats.expectedAttempts}** |`);
    L.push('');
    L.push('## 序列（setval）');
    L.push('');
    L.push('| 表 | last_value |');
    L.push('|---|---|');
    for (const [t, s] of Object.entries(stats.sequences || {})) L.push(`| ${t} | ${s ? s.last_value : '(無)'} |`);
    L.push('');
    L.push('## 校驗結果');
    L.push('');
    if (!problems || problems.length === 0) L.push('全部通過。');
    else for (const p of problems) L.push(`- ❌ ${p}`);
    L.push('');
    L.push('## 尚未完成的部分');
    L.push('');
    L.push('- `search_tsv` 與 `embedding` 本腳本**不寫**（規劃 §2.3.6 的寫入路徑表）。匯入後請執行「回填向量.bat」（WS-C 的 `scripts/backfill_embeddings.js`）。');
    L.push('- 姓名合併與疑似同一人請看同資料夾的 `name_merge_report.md`，那份要老師人工確認。');
    L.push('');
    return L.join('\n');
}

main().catch(err => {
    console.error('');
    console.error('❌ 匯入失敗：' + err.message);
    process.exit(1);
});
