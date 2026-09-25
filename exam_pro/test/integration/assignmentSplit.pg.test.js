// ─────────────────────────────────────────────────────────────
// test/integration/assignmentSplit.pg.test.js — migrations/0016（派題與作答拆表）的遷移測試
// （〔retrain PR-1〕docs/retrain-and-review.md 第 3.2、3.3、3.6、3.7 節；第 6.3 節 TC-036-1～4）
//
// 在同一顆測試庫裡另開一個暫用 schema（search_path = <暫用 schema>, public），照 migrate.js 的做法
// 一支一交易地套 migrations/：先套到 0016 的前一號、灌入「舊格式」的作答資料，再套 0016。
// 這樣測得到「有資料的庫」上的遷移，而不動到其他整合測試共用的 public schema。
// pgvector／pg_trgm 擴充套件已經裝在 public（npm run migrate:test），0002 的 CREATE EXTENSION IF NOT EXISTS 是 no-op。
//
// 驗什麼：
//   1. 空庫：從 0001 套到 0016 → attempts 是檢視、兩張新表是空的、序號從 1 起；寫入路徑（writePaper 的 SQL）可用。
//   2. 有資料：每一筆舊作答 → 一筆「新題」派題＋一筆作答，id 原樣保留、逐欄相同（含 paper_id 為 NULL、
//      部分給分、錯因、學生答案、註記、已封存題）；檢視 attempts 的內容與舊表逐欄相同；序號接續
//      （最後幾筆被刪掉時不重用已發出去的 id）。
//   3. 冪等：已拆過的庫再套一次 0016 → 不報錯、資料與序號都不動。
//   4. 自我檢查：搬過去的資料被人為改動時 RAISE、整支回滾，舊表原封不動。
//   5. 黃金比對（TC-036-3）：弱點面板六支、知識點掌握度兩支、補救卷兩支、覆蓋率、候選池、最近錯題細節的
//      SQL，在同一份資料上於 0016 前後各跑一次，結果逐欄相同（這些 SQL 一個字都沒改，讀的是相容檢視）。
//   6. EXPLAIN（TC-036-4）：候選池的 NOT EXISTS 展開檢視後走 assignments_first_exposure_key，而且完全沒碰
//      attempt_records（LEFT JOIN 被拿掉）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
const M1 = '0016_assignment_attempt_split.sql';

if (!TEST_DATABASE_URL) {
    test('派題與作答拆表的遷移測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    // 下面幾個 controller 在模組頂層 require config/db：先指到測試庫（本檔只借它們的純函式 SQL builder）
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { Client } = require('pg');
    const weakness = require(path.join(APP_DIR, 'services', 'weaknessService'));
    const kcWeakness = require(path.join(APP_DIR, 'services', 'kcWeaknessService'));
    const remedial = require(path.join(APP_DIR, 'services', 'remedialService'));
    const coverage = require(path.join(APP_DIR, 'services', 'coverageService'));
    const exam = require(path.join(APP_DIR, 'controllers', 'examController'));
    const studentCtl = require(path.join(APP_DIR, 'controllers', 'studentController'));
    const { pool } = require(path.join(APP_DIR, 'config', 'db'));

    const ALL = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const BEFORE_M1 = ALL.filter(f => f < M1);
    const M1_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, M1), 'utf8');

    /** 照 migrate.js：一支一交易，失敗整支回滾。 */
    async function applySql(client, sql) {
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    }
    async function applyFiles(client, files) {
        for (const f of files) await applySql(client, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }

    /** 開一條連線、建暫用 schema 並把它放在 search_path 最前面；結束時整個 schema 丟掉。 */
    async function withScratchSchema(name, fn) {
        const client = new Client({ connectionString: TEST_DATABASE_URL });
        await client.connect();
        client.on('notice', () => { /* CREATE … IF NOT EXISTS 的 NOTICE 不印 */ });
        try {
            await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            await client.query(`CREATE SCHEMA ${name}`);
            await client.query(`SET search_path TO ${name}, public`);
            await fn(client);
        } finally {
            try {
                await client.query('RESET search_path');
                await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            } finally {
                await client.end();
            }
        }
    }

    /** 暫用 schema 裡某個名字的 relkind（r＝表、v＝檢視、null＝不存在）。一律帶 schema：public 也有同名的表與檢視。 */
    async function relkind(client, schema, rel) {
        const { rows } = await client.query(
            `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2`, [schema, rel]);
        return rows.length ? rows[0].relkind : null;
    }

    // ─────────── 舊格式的 fixture（固定種子，每次相同）───────────

    function rng(seed) {   // mulberry32
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const CHAPTERS = { 數學: ['向量內積', '三角函數'], 物理: ['直線運動', '靜電學'] };
    const TYPES = ['單選', '多選', '填空', '計算', '證明'];
    const ERRORS = ['calc', 'concept', 'reading', 'blank'];

    /**
     * 在「0016 之前」的 schema 灌資料：4 位學生 × 120 題；每生約 70 筆作答（含 paper_id 為 NULL 的
     * 歷史紀錄、未批改、部分給分、錯因、學生答案與註記）；每 17 題封存一題；知識點與標註。
     * 最後刪掉 id 最大的兩筆作答，讓「最大 id」落後「序號已發到哪裡」。
     * @returns {Promise<{students:number[], questions:number[], maxIdBefore:number, seqLast:number}>}
     */
    async function seedLegacy(client) {
        const r = rng(20260926);
        const pick = arr => arr[Math.floor(r() * arr.length)];
        const { rows: st } = await client.query(
            `INSERT INTO students (name) SELECT '拆表測試生' || x FROM generate_series(1, 4) AS x RETURNING id`);
        const students = st.map(s => s.id);

        const qRows = Array.from({ length: 120 }, (_, i) => {
            const subject = i % 2 === 0 ? '數學' : '物理';
            return {
                subject, chapter: CHAPTERS[subject][(i >> 1) % 2], type: TYPES[i % 5],
                difficulty: (i % 5) + 1, text: `拆表遷移測試題 ${i}：求 $x$。`, answer: `答 ${i}`
            };
        });
        const { rows: qs } = await client.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[])
             RETURNING id`,
            [qRows.map(q => q.subject), qRows.map(q => q.chapter), qRows.map(q => q.type),
                qRows.map(q => q.difficulty), qRows.map(q => q.text), qRows.map(q => q.answer)]);
        const questions = qs.map(q => q.id);

        // 知識點：每章兩個，題目依序掛一到兩個（權重 1 或 0.5）
        const kcs = [];
        for (const [subject, chs] of Object.entries(CHAPTERS)) {
            for (const ch of chs) {
                for (let k = 1; k <= 2; k++) {
                    const { rows: [kc] } = await client.query(
                        `INSERT INTO knowledge_components (code, subject, chapter, name, status, sort)
                         VALUES ($1, $2, $3, $4, 'approved', $5) RETURNING id`,
                        [`${subject === '數學' ? 'MATH' : 'PHYS'}.${ch}.0${k}`, subject, ch, `${ch}知識點${k}`, k]);
                    kcs.push({ id: kc.id, subject, chapter: ch });
                }
            }
        }
        for (let i = 0; i < questions.length; i++) {
            const mine = kcs.filter(k => k.subject === qRows[i].subject && k.chapter === qRows[i].chapter);
            if (i % 7 === 3) continue;   // 部分題目沒有標註（untagged）
            await client.query(`INSERT INTO question_kcs (question_id, kc_id, weight, src) VALUES ($1, $2, 1, 'human')`,
                [questions[i], mine[0].id]);
            if (i % 3 === 0) {
                await client.query(`INSERT INTO question_kcs (question_id, kc_id, weight, src) VALUES ($1, $2, 0.5, 'human')`,
                    [questions[i], mine[1].id]);
            }
        }

        for (const sid of students) {
            // 每生隨機 70 題（不重複），前 45 題分成三張卷，其餘 paper_id 為 NULL（階段 1 匯入的歷史紀錄）
            const order = questions.slice().sort(() => r() - 0.5).slice(0, 70);
            const papers = [];
            for (let p = 0; p < 3; p++) {
                const ids = order.slice(p * 15, p * 15 + 15);
                const { rows: [paper] } = await client.query(
                    `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ($1, $2, $3::int[]) RETURNING id`,
                    [`拆表測試卷 ${sid}-${p}`, sid, ids]);
                papers.push({ id: paper.id, ids });
            }
            for (let k = 0; k < order.length; k++) {
                const qid = order[k];
                const paper = papers.find(p => p.ids.includes(qid));
                const roll = r();
                const result = roll < 0.2 ? null : (roll < 0.55 ? 0 : 1);
                const score = result === null ? null : (r() < 0.3 ? pick([0.25, 0.5, 0.75, 1]) : null);
                const errs = result === 0 && r() < 0.7 ? ERRORS.filter(() => r() < 0.4) : [];
                await client.query(
                    `INSERT INTO attempts (student_id, question_id, paper_id, assigned_at, result, graded_at,
                                           score, error_types, response, teacher_note)
                     VALUES ($1, $2, $3, CURRENT_DATE - $4::int, $5,
                             CASE WHEN $5::smallint IS NULL THEN NULL ELSE now() - ($4::int || ' days')::interval END,
                             $6, $7::text[], $8, $9)`,
                    [sid, qid, paper ? paper.id : null, Math.floor(r() * 200), result, score, errs,
                        r() < 0.2 ? `學生答案 ${k}` : null, r() < 0.1 ? `註記 ${k}` : null]);
            }
        }
        // 封存幾題（歷史紀錄照樣要搬）
        await client.query('UPDATE questions SET archived_at = now() WHERE id = ANY($1::int[])',
            [questions.filter((_, i) => i % 17 === 5)]);
        // 刪掉 id 最大的兩筆：序號已發到 N，但最大 id 是 N-2
        await client.query('DELETE FROM attempts WHERE id IN (SELECT id FROM attempts ORDER BY id DESC LIMIT 2)');
        const { rows: [m] } = await client.query(
            `SELECT MAX(id)::int AS max_id,
                    pg_sequence_last_value(pg_get_serial_sequence('attempts', 'id')::regclass)::int AS seq_last
               FROM attempts`);
        return { students, questions, maxIdBefore: m.max_id, seqLast: m.seq_last };
    }

    const LEGACY_COLS = `id, student_id, question_id, paper_id, assigned_at, result, graded_at,
                         score, error_types, response, teacher_note`;

    // ─────────── 黃金比對：0016 前後同一批 SQL ───────────

    /** 回 [{ name, text, values }]；全部是既有的純函式 SQL builder，一個字都沒改。 */
    function goldenQueries(fx) {
        const qs = [];
        for (const studentId of fx.students) {
            for (const subject of [null, '數學', '物理']) {
                for (const days of [30, 90, 365]) {
                    const o = { studentId, subject, days };
                    const tag = `s${studentId}/${subject || '全'}/${days}`;
                    for (const b of ['buildByChapter', 'buildByType', 'buildByDifficulty', 'buildTrendWeekly',
                        'buildRecentWrong', 'buildByErrorType']) {
                        qs.push({ name: `weakness.${b} ${tag}`, ordered: true, ...weakness[b](o) });
                    }
                    qs.push({ name: `kc.buildKcAggregate ${tag}`, ...kcWeakness.buildKcAggregate(o) });
                    qs.push({ name: `kc.buildGradedTagCounts ${tag}`, ...kcWeakness.buildGradedTagCounts(o) });
                    qs.push({ name: `remedial.buildChapterMastery ${tag}`, ...remedial.buildChapterMastery(o) });
                }
                qs.push({ name: `coverage.buildChapterCoverage s${studentId}/${subject}`,
                    ...coverage.buildChapterCoverage({ subject, studentId }) });
                if (subject) {
                    qs.push({ name: `exam.buildCandidatePoolQuery s${studentId}/${subject}`,
                        ...exam.buildCandidatePoolQuery({ subject, studentId }) });
                    qs.push({ name: `exam.buildCandidatePoolQuery(章) s${studentId}/${subject}`,
                        ...exam.buildCandidatePoolQuery({ subject, studentId, chapters: [CHAPTERS[subject][0]],
                            difficultyMin: 2, difficultyMax: 4 }) });
                }
            }
            qs.push({ name: `remedial.buildItemLookupQuery s${studentId}`,
                ...remedial.buildItemLookupQuery(fx.questions.slice(0, 60), studentId) });
            qs.push({ name: `studentController.buildRecentWrongDetail s${studentId}`,
                ...studentCtl._internals.buildRecentWrongDetail(studentId, fx.questions) });
        }
        qs.push({ name: 'coverage.buildChapterCoverage 不帶學生', ...coverage.buildChapterCoverage({}) });
        return qs;
    }

    const canon = rows => rows.map(r => JSON.stringify(r)).sort();

    async function runGolden(client, queries) {
        const out = new Map();
        for (const q of queries) {
            const { rows } = await client.query(q.text, q.values);
            out.set(q.name, { ordered: q.ordered ? JSON.stringify(rows) : null, sorted: canon(rows), n: rows.length });
        }
        return out;
    }

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('0016 派題與作答拆表（遷移）', () => {
        after(async () => { await pool.end(); });

        test('空庫：從 0001 套到 0016，attempts 是檢視、兩張新表是空的，出卷的寫入語句可用', async () => {
            await withScratchSchema('m1split_empty', async client => {
                await applyFiles(client, ALL.filter(f => f <= M1));
                assert.equal(await relkind(client, 'm1split_empty', 'attempts'), 'v');
                assert.equal(await relkind(client, 'm1split_empty', 'assignment_attempts'), 'v');
                assert.equal(await relkind(client, 'm1split_empty', 'assignments'), 'r');
                assert.equal(await relkind(client, 'm1split_empty', 'attempt_records'), 'r');
                const { rows: [c] } = await client.query(
                    `SELECT (SELECT COUNT(*) FROM assignments)::int AS a, (SELECT COUNT(*) FROM attempt_records)::int AS r,
                            (SELECT COUNT(*) FROM attempts)::int AS v`);
                assert.deepEqual(c, { a: 0, r: 0, v: 0 });

                // 檢視 attempts 的欄位名稱與順序：舊表的十一欄＋assignment_id
                const { rows: cols } = await client.query(
                    `SELECT column_name FROM information_schema.columns
                      WHERE table_schema = 'm1split_empty' AND table_name = 'attempts' ORDER BY ordinal_position`);
                assert.deepEqual(cols.map(x => x.column_name), [
                    'id', 'student_id', 'question_id', 'paper_id', 'assigned_at', 'result', 'graded_at',
                    'score', 'error_types', 'response', 'teacher_note', 'assignment_id']);
                const { rows: cols2 } = await client.query(
                    `SELECT column_name FROM information_schema.columns
                      WHERE table_schema = 'm1split_empty' AND table_name = 'assignment_attempts' ORDER BY ordinal_position`);
                assert.deepEqual(cols2.map(x => x.column_name), [
                    'assignment_id', 'student_id', 'question_id', 'paper_id', 'assigned_at', 'purpose',
                    'attempt_id', 'result', 'graded_at', 'score', 'error_types', 'response', 'teacher_note']);

                // 出卷的寫入語句（examController.writePaper）：派題與空白作答同一句寫入，序號從 1 起
                const { rows: [s] } = await client.query(`INSERT INTO students (name) VALUES ('空庫生') RETURNING id`);
                const { rows: q } = await client.query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     VALUES ('數學', '向量內積', '計算', 3, '空庫題一', '1'), ('數學', '向量內積', '計算', 3, '空庫題二', '2')
                     RETURNING id`);
                const { rows: [p] } = await client.query(
                    `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('空庫卷', $1, $2::int[]) RETURNING id`,
                    [s.id, q.map(x => x.id)]);
                const sql = exam._assignmentInternals.buildInsertNewAssignmentsSql();
                const ins = await client.query(sql, [s.id, q.map(x => x.id), p.id, '2026-09-26']);
                assert.equal(ins.rowCount, 2);
                const { rows: v } = await client.query(
                    'SELECT id, assignment_id, paper_id, assigned_at::text AS d, result, error_types FROM attempts ORDER BY id');
                assert.deepEqual(v.map(x => [Number(x.id), Number(x.assignment_id), x.paper_id, x.d, x.result, x.error_types]),
                    [[1, 1, p.id, '2026-09-26', null, []], [2, 2, p.id, '2026-09-26', null, []]]);
                // 同一位學生同一題再以新題派一次 → DO NOTHING（寫入筆數 0，呼叫端據此回 409）
                const again = await client.query(sql, [s.id, [q[0].id], null, '2026-09-27']);
                assert.equal(again.rowCount, 0);

                // TC-036-2：新題直接 INSERT 撞部分唯一索引（23505）；重練列不受限；一張卷同一題至多一次
                await assert.rejects(
                    client.query('INSERT INTO assignments (student_id, question_id) VALUES ($1, $2)', [s.id, q[0].id]),
                    err => err.code === '23505' && err.constraint === 'assignments_first_exposure_key');
                await client.query(`INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'retrain'), ($1, $2, 'retrain')`,
                    [s.id, q[0].id]);
                await assert.rejects(
                    client.query(`INSERT INTO assignments (student_id, question_id, paper_id, purpose) VALUES ($1, $2, $3, 'retrain')`,
                        [s.id, q[0].id, p.id]),
                    err => err.code === '23505' && err.constraint === 'assignments_paper_question_key');
                // 一筆派題至多一筆作答（I4）
                await assert.rejects(
                    client.query('INSERT INTO attempt_records (assignment_id) VALUES (1)'),
                    err => err.code === '23505' && err.constraint === 'attempt_records_assignment_id_key');
                const { rows: [cnt] } = await client.query(
                    `SELECT (SELECT COUNT(*) FROM attempts)::int AS first, (SELECT COUNT(*) FROM assignment_attempts)::int AS all_rows`);
                assert.deepEqual(cnt, { first: 2, all_rows: 4 }, '檢視 attempts 只含新題派題，assignment_attempts 含重練');
            });
        });

        test('有資料：每筆舊作答 → 一筆新題派題＋一筆作答，id 與逐欄內容相同，序號接續；再套一次是 no-op', async () => {
            await withScratchSchema('m1split_data', async client => {
                await applyFiles(client, BEFORE_M1);
                assert.equal(await relkind(client, 'm1split_data', 'attempts'), 'r', '0016 之前 attempts 是實體表');
                const fx = await seedLegacy(client);
                assert.ok(fx.seqLast > fx.maxIdBefore, `fixture 應讓序號領先最大 id（${fx.seqLast} vs ${fx.maxIdBefore}）`);

                const { rows: legacy } = await client.query(`SELECT ${LEGACY_COLS} FROM attempts ORDER BY id`);
                assert.ok(legacy.length > 250, `fixture 應有兩百多筆作答，實際 ${legacy.length}`);
                assert.ok(legacy.some(x => x.paper_id === null), 'fixture 應含 paper_id 為 NULL 的歷史紀錄');
                assert.ok(legacy.some(x => x.score !== null), 'fixture 應含部分給分');
                assert.ok(legacy.some(x => x.error_types.length > 1), 'fixture 應含多個錯因');
                assert.ok(legacy.some(x => x.result === null), 'fixture 應含未批改');
                const golden = goldenQueries(fx);
                const before = await runGolden(client, golden);

                await applySql(client, M1_SQL);

                // 1. 型態：attempts 成了檢視，兩張新表是實體表
                assert.equal(await relkind(client, 'm1split_data', 'attempts'), 'v');
                assert.equal(await relkind(client, 'm1split_data', 'assignments'), 'r');
                assert.equal(await relkind(client, 'm1split_data', 'attempt_records'), 'r');

                // 2. 筆數與關聯：每筆舊作答 = 一筆新題派題 + 一筆作答，id 原樣保留
                const { rows: [c] } = await client.query(
                    `SELECT (SELECT COUNT(*) FROM assignments)::int AS a,
                            (SELECT COUNT(*) FROM assignments WHERE purpose = 'new')::int AS a_new,
                            (SELECT COUNT(*) FROM attempt_records)::int AS r,
                            (SELECT COUNT(*) FROM attempt_records WHERE id <> assignment_id)::int AS r_mismatch,
                            (SELECT COUNT(*) FROM assignments s
                               WHERE NOT EXISTS (SELECT 1 FROM attempt_records r WHERE r.assignment_id = s.id))::int AS orphan,
                            (SELECT COUNT(*) FROM assignments s
                               WHERE s.paper_id IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM exam_papers p WHERE p.id = s.paper_id AND p.student_id = s.student_id))::int AS bad_paper`);
                assert.deepEqual(c, { a: legacy.length, a_new: legacy.length, r: legacy.length, r_mismatch: 0, orphan: 0, bad_paper: 0 });
                const { rows: ids } = await client.query('SELECT id FROM assignments ORDER BY id');
                assert.deepEqual(ids.map(x => Number(x.id)), legacy.map(x => Number(x.id)));

                // 3. 檢視 attempts 的內容與舊表逐欄相同（多出的 assignment_id = id）
                const { rows: view } = await client.query(`SELECT ${LEGACY_COLS}, assignment_id FROM attempts ORDER BY id`);
                assert.deepEqual(view.map(({ assignment_id, ...rest }) => rest), legacy);
                assert.ok(view.every(x => String(x.assignment_id) === String(x.id)));
                // assignment_attempts 在沒有重練資料時列數相同、全部是 new
                const { rows: [aa] } = await client.query(
                    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE purpose = 'new' AND attempt_id = assignment_id)::int AS ok
                       FROM assignment_attempts`);
                assert.deepEqual(aa, { n: legacy.length, ok: legacy.length });

                // 4. 序號接續：取「最大 id」與「舊序號已發到哪裡」的較大值 + 1
                const expectedNext = Math.max(fx.maxIdBefore, fx.seqLast) + 1;
                for (const seq of ['assignments_id_seq', 'attempt_records_id_seq']) {
                    // setval(…, false)：last_value 就是下一個 nextval 會發的號
                    const { rows: [sq] } = await client.query(`SELECT last_value, is_called FROM ${seq}`);
                    assert.deepEqual([Number(sq.last_value), sq.is_called], [expectedNext, false], seq);
                }

                // 5. 黃金比對：同一批 SQL 在 0016 前後結果逐欄相同
                const afterRes = await runGolden(client, golden);
                let compared = 0;
                for (const q of golden) {
                    const b = before.get(q.name), a = afterRes.get(q.name);
                    assert.deepEqual(a.sorted, b.sorted, `${q.name} 的結果在 0016 前後不同`);
                    if (q.ordered) assert.equal(a.ordered, b.ordered, `${q.name} 的順序在 0016 前後不同`);
                    compared++;
                }
                assert.ok(compared > 200, `黃金比對應涵蓋兩百多支查詢，實際 ${compared}`);
                assert.ok([...before.values()].filter(v => v.n > 0).length > 150, '黃金比對的查詢大多應該有結果列（不是比空對空）');

                // 6. 冪等：再套一次整支 0016 → 不報錯、資料與序號都不動
                const snap = async () => (await client.query(
                    `SELECT (SELECT json_agg(s ORDER BY s.id) FROM assignments s)::text AS a,
                            (SELECT json_agg(r ORDER BY r.id) FROM attempt_records r)::text AS r,
                            (SELECT last_value FROM assignments_id_seq)::text AS sa,
                            (SELECT last_value FROM attempt_records_id_seq)::text AS sr`)).rows[0];
                const s1 = await snap();
                await applySql(client, M1_SQL);
                assert.deepEqual(await snap(), s1);
                assert.equal(await relkind(client, 'm1split_data', 'attempts'), 'v');

                // 7. 遷移後第一筆新派題拿到 expectedNext（不重用被刪掉的 id）
                const { rows: [st] } = await client.query('SELECT MIN(id) AS id FROM students');
                const { rows: [fresh] } = await client.query(
                    `SELECT q.id FROM questions q WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $1)
                      ORDER BY q.id LIMIT 1`, [st.id]);
                await client.query(exam._assignmentInternals.buildInsertNewAssignmentsSql(), [st.id, [fresh.id], null, '2026-09-26']);
                const { rows: [last] } = await client.query(
                    'SELECT s.id AS a, r.id AS r FROM assignments s JOIN attempt_records r ON r.assignment_id = s.id WHERE s.question_id = $1 AND s.student_id = $2',
                    [fresh.id, st.id]);
                assert.equal(Number(last.a), expectedNext);
                assert.equal(Number(last.r), expectedNext);
            });
        });

        test('候選池的 NOT EXISTS 展開檢視後走 assignments_first_exposure_key，不碰 attempt_records（TC-036-4）', async () => {
            await withScratchSchema('m1split_explain', async client => {
                await applyFiles(client, BEFORE_M1);
                const fx = await seedLegacy(client);
                await applySql(client, M1_SQL);
                await client.query('ANALYZE assignments');
                await client.query('ANALYZE attempt_records');
                await client.query('ANALYZE questions');
                const { text, values } = exam.buildCandidatePoolQuery({ subject: '數學', studentId: fx.students[0] });
                const explain = async () => JSON.stringify(
                    (await client.query({ text: `EXPLAIN (FORMAT JSON) ${text}`, values })).rows[0]['QUERY PLAN']);

                // ① 預設設定：不論 planner 選哪一種掃法，檢視的 LEFT JOIN 都被拿掉，完全不碰作答表
                const plain = await explain();
                assert.ok(!plain.includes('attempt_records'), `候選池不該碰作答表（LEFT JOIN 應被拿掉）：${plain}`);
                assert.ok(plain.includes('"Relation Name":"assignments"'), `候選池應該查派題表：${plain}`);

                // ② 「走得到」部分唯一索引：同 students.pg.test.js 的做法，小表上 planner 選 Seq Scan、
                //    Hash Anti Join（整批撈該生的派題）都是**正確**的選擇，不是缺陷。這裡要驗的是
                //    「檢視的 WHERE purpose = 'new' 蘊含部分索引的條件，(student_id, question_id) 兩欄都能當索引條件」，
                //    所以關掉 seqscan／bitmapscan／hash／merge join，讓 planner 只能用逐題查找的 Nested Loop：
                //    那時兩欄都吃得到的只有 assignments_first_exposure_key。有人把檢視改成不帶 purpose 條件、
                //    或把部分索引的條件改掉，這一條就會失敗。SET LOCAL 只在這個交易內有效。
                await client.query('BEGIN');
                try {
                    for (const knob of ['enable_seqscan', 'enable_bitmapscan', 'enable_hashjoin', 'enable_mergejoin']) {
                        await client.query(`SET LOCAL ${knob} = off`);
                    }
                    const plan = await explain();
                    assert.ok(plan.includes('assignments_first_exposure_key'), `候選池沒有用到部分唯一索引：${plan}`);
                    assert.ok(!plan.includes('attempt_records'), `候選池不該碰作答表（LEFT JOIN 應被拿掉）：${plan}`);
                } finally {
                    await client.query('ROLLBACK');
                }
            });
        });

        test('遷移驗證腳本（scripts/snapshot_attempt_views.js）：0016 前後的快照完全相同；資料被改過就抓得到', async () => {
            const os = require('node:os');
            const { execFileSync, spawnSync } = require('node:child_process');
            const SCRIPT = path.join(APP_DIR, 'scripts', 'snapshot_attempt_views.js');
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1split-snap-'));
            // 子行程的連線吃 PGOPTIONS：search_path 指到這個暫用 schema（其餘設定同 --test）
            const env = { ...process.env, TEST_DATABASE_URL, PGOPTIONS: '-c search_path=m1split_snap,public' };
            const snap = out => execFileSync(process.execPath, [SCRIPT, '--test', `--out=${out}`],
                { cwd: APP_DIR, env, encoding: 'utf8' });
            const compare = (a, b) => spawnSync(process.execPath, [SCRIPT, '--compare', a, b],
                { cwd: APP_DIR, env, encoding: 'utf8' });
            try {
                await withScratchSchema('m1split_snap', async client => {
                    await applyFiles(client, BEFORE_M1);
                    await seedLegacy(client);
                    const before = path.join(tmp, 'before.json');
                    const afterFile = path.join(tmp, 'after.json');
                    assert.match(snap(before), /attempts 目前是表/);
                    await applySql(client, M1_SQL);
                    assert.match(snap(afterFile), /attempts 目前是檢視/);

                    const shot = JSON.parse(fs.readFileSync(before, 'utf8'));
                    assert.equal(shot.students.length, 4);
                    assert.ok(shot.attempts.count > 250);
                    assert.ok(shot.students.every(s => s.weakness['buildByChapter@365'].length > 0), '快照應該有真的數字');

                    const same = compare(before, afterFile);
                    assert.equal(same.status, 0, same.stdout + same.stderr);
                    assert.match(same.stdout, /完全相同/);

                    // 反向驗證：遷移後改掉一筆作答 → 比對失敗、指出差在哪
                    await client.query(`UPDATE attempt_records SET result = 1 - result
                                         WHERE id = (SELECT MIN(id) FROM attempt_records WHERE result IS NOT NULL)`);
                    const changed = path.join(tmp, 'changed.json');
                    snap(changed);
                    const diff = compare(before, changed);
                    assert.equal(diff.status, 1, diff.stdout);
                    assert.match(diff.stdout, /有差異/);
                    assert.match(diff.stdout, /\$\.attempts\.md5/);
                });
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        });

        test('自我檢查：搬過去的資料被改動 → RAISE、整支回滾，舊 attempts 原封不動（TC-036-1）', async () => {
            await withScratchSchema('m1split_bad', async client => {
                await applyFiles(client, BEFORE_M1);
                await seedLegacy(client);
                const { rows: legacy } = await client.query(`SELECT ${LEGACY_COLS} FROM attempts ORDER BY id`);

                // 先放一張同名的 assignments（0016 用 CREATE TABLE IF NOT EXISTS，會沿用它），
                // 上面掛一個把派題日往前挪一天的觸發器——模擬「搬過去的內容和舊表不一致」。
                await client.query(`CREATE TABLE assignments (
                        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                        student_id INT NOT NULL, question_id INT NOT NULL, paper_id INT,
                        assigned_at DATE NOT NULL DEFAULT CURRENT_DATE,
                        purpose TEXT NOT NULL DEFAULT 'new')`);
                await client.query(`CREATE FUNCTION m1split_bad.shift_day() RETURNS trigger LANGUAGE plpgsql AS $fn$
                        BEGIN NEW.assigned_at := NEW.assigned_at - 1; RETURN NEW; END $fn$`);
                await client.query(`CREATE TRIGGER shift_day BEFORE INSERT ON assignments
                        FOR EACH ROW EXECUTE FUNCTION m1split_bad.shift_day()`);

                await assert.rejects(applySql(client, M1_SQL), /派題／作答拆表：新舊資料不一致，已回滾/);

                // 整支回滾：attempts 還是實體表、內容不變；作答表沒建起來；預放的 assignments 沒有留下任何列
                assert.equal(await relkind(client, 'm1split_bad', 'attempts'), 'r');
                assert.equal(await relkind(client, 'm1split_bad', 'attempt_records'), null);
                assert.equal(await relkind(client, 'm1split_bad', 'assignment_attempts'), null);
                const { rows: still } = await client.query(`SELECT ${LEGACY_COLS} FROM attempts ORDER BY id`);
                assert.deepEqual(still, legacy);
                const { rows: [z] } = await client.query('SELECT COUNT(*)::int AS n FROM assignments');
                assert.equal(z.n, 0);
            });
        });
    });
}
