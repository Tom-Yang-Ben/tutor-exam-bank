// ─────────────────────────────────────────────────────────────
// chapterMigration.pg.test.js — scripts/migrate_chapters.js（npm run chapters:migrate）的整合測試
// （章節重整 CH-A；docs/chapter-restructure.md 第 3.1 條第 7 點、migrations/0014）
//
// 釘住契約列的每一項：
//   ① --dry-run：rename 自動提議、split 的關鍵字命中（題幹與 metadata）與預設、removed 提議 to[0]／沒有 to 留空；
//      same、純新增章、化學不列；已封存的題照列並加註；對照表外的髒資料只回報；**資料庫一個位元組都不動**；
//      時間截點：沿用舊名的章裡 0014 之後入庫的題只計數不列（--include-new 照列）。
//   ② --apply 的驗證與交易：題號不存在、科目對不上 → 整批不寫；中途丟例外 → 全部回滾；
//   ③ 換章的題 chapter_src='human'、embed_hash 清空、search_tsv 依新章重算；src='ai' 的知識點標註刪除，human 的保留；
//      老師確認留在原章的題不動；
//   ④ 重跑冪等：同一份 CSV 再套一次不改任何東西；之後的 --dry-run 不再列出處理過的題；
//      產生提議檔之後被老師改過章的題略過（以題庫現值為準）；已套用過的題一律不再改——同一天的第二份提議檔、
//      搬完之後老師又改回沿用舊名的章，都略過並回報「已於先前套用」；
//   ⑤ CLI：子行程跑 --dry-run 與 --apply（--test 打測試庫），不合法的 CSV exit 1、資料庫不動，
//      成功時印出 embed:backfill 與 search:reindex。
// 不呼叫 LLM（整支沒有注入 LLM，也沒有 cassette）。
//
// 三道防線與其他整合測試相同：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、
// 在 require config/db.js 之前覆寫 DATABASE_URL。題目全部是為測試自行編寫（NOTICE）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('章節重整遷移整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { buildTsvTokens } = require(path.join(APP_DIR, 'services', 'embedService'));
    const mig = require(path.join(APP_DIR, 'scripts', 'migrate_chapters'));
    const { TSV_EXPR, lexemesOf } = require(path.join(APP_DIR, 'scripts', 'reindex_search_tsv'));
    const db = { pool, query };

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-migration-'));
    const FAKE_HASH = 'a'.repeat(64);

    /** 重整前入庫的時間（早於 migrations/0014 套用的時間，也就是 --dry-run 的時間截點） */
    const BEFORE_RESTRUCTURE = '2025-06-01T00:00:00Z';

    /**
     * 以「舊章」入庫：search_tsv 用當時的章名算好、embed_hash 填一個假值（驗證會被清空）。
     * created_at 預設是重整前（BEFORE_RESTRUCTURE）；傳 createdAt: null 表示「現在」（0014 之後入庫的新題）。
     */
    async function insertQ(q) {
        const row = { question_type: '計算', difficulty: 3, keywords: null, concept_summary: null, createdAt: BEFORE_RESTRUCTURE, ...q };
        const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    keywords, concept_summary, origin, chapter_src, archived_at, embed_hash, search_tsv, created_at)
             VALUES ($4, $5, $6, $7, $8, '自製答案', $9, $10, 'pdf', $11, $12, $13,
                     setweight(to_tsvector('simple', array_to_string($1::text[], ' ')), 'A')
                  || setweight(to_tsvector('simple', array_to_string($2::text[], ' ')), 'A')
                  || setweight(to_tsvector('simple', array_to_string($3::text[], ' ')), 'B'),
                     COALESCE($14::timestamptz, now()))
             RETURNING id`,
            [chapterTokens, keywordTokens, stemTokens,
                row.subject, row.chapter, row.question_type, row.difficulty, row.question_text,
                row.keywords, row.concept_summary, row.chapter_src || 'ai', row.archived ? new Date() : null, FAKE_HASH,
                row.createdAt]);
        return rows[0].id;
    }

    /** scripts/reindex_search_tsv.js 的 TSV_EXPR（$2～$4）改成 $1～$3，單獨算出一段 search_tsv 的文字形式 */
    async function expectedTsv(row) {
        const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);
        const expr = TSV_EXPR.replace(/\$(\d)/g, (_, d) => `$${Number(d) - 1}`);
        return (await query(`SELECT (${expr})::text AS t`, [chapterTokens, keywordTokens, stemTokens])).rows[0].t;
    }

    async function insertKc(subject, chapter, code) {
        const { rows } = await query(
            `INSERT INTO knowledge_components (code, subject, chapter, name, sort) VALUES ($1, $2, $3, $4, 1) RETURNING id`,
            [code, subject, chapter, `自製知識點 ${code}`]);
        return rows[0].id;
    }
    const tag = (qid, kcId, src) => query('INSERT INTO question_kcs (question_id, kc_id, src) VALUES ($1, $2, $3)', [qid, kcId, src]);

    /** 題目的關鍵欄位快照（比對「資料庫有沒有被動過」） */
    async function snapshot() {
        const qs = (await query(
            'SELECT id, subject, chapter, chapter_src, embed_hash, search_tsv::text AS tsv FROM questions ORDER BY id')).rows;
        const kcs = (await query('SELECT question_id, kc_id, src FROM question_kcs ORDER BY 1, 2')).rows;
        const log = (await query('SELECT question_id, plan, from_chapter, to_chapter, basis FROM chapter_migration_log ORDER BY 1')).rows;
        return { qs, kcs, log };
    }
    const qRow = async (id) => (await query('SELECT * FROM questions WHERE id = $1', [id])).rows[0];
    const readCsv = (file) => mig.readApplyRows(mig.decodeCsvBuffer(fs.readFileSync(file)).text);

    /** 把 dry-run 的提議檔當成老師的輸入：overrides = { 題號: 新章 }，drop = 要刪掉的題號 */
    function teacherEdits(file, overrides = {}, drop = []) {
        const table = mig.parseCsv(mig.decodeCsvBuffer(fs.readFileSync(file)).text);
        const out = [table[0].cells];
        for (const { cells } of table.slice(1)) {
            const id = Number(cells[0]);
            if (drop.includes(id)) continue;
            const next = cells.slice();
            if (Object.prototype.hasOwnProperty.call(overrides, id)) next[3] = overrides[id];
            out.push(next);
        }
        const edited = path.join(TMP, `edited-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
        fs.writeFileSync(edited, '﻿' + out.map(r => r.map(c => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n');
        return { edited };
    }

    const ids = {};

    async function seed() {
        await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
        await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        ids.rename = await insertQ({ subject: '數學', chapter: '多項式除法', question_text: '自製題：以綜合除法求 $x^3+2x-1$ 除以 $x-1$ 的餘式。' });
        ids.fold = await insertQ({ subject: '數學', chapter: '正弦與餘弦定理', question_text: '自製題：把 $\\sin x+\\cos x$ 疊合成單一個正弦函數。' });
        ids.stay = await insertQ({ subject: '數學', chapter: '正弦與餘弦定理', question_text: '自製題：三角形兩邊長 $3$、$5$，夾角 $60^\\circ$，求第三邊長。' });
        ids.meta = await insertQ({ subject: '數學', chapter: '組合', question_text: '自製題：求展開式中 $x^2$ 項的係數。', keywords: ['二項式定理', '係數'] });
        ids.fluid = await insertQ({ subject: '物理', chapter: '流體的壓力與浮力', question_text: '自製題：木塊浮在水面，求沒入水中的體積比。' });
        ids.cosmo = await insertQ({ subject: '物理', chapter: '宇宙學簡介', question_text: '自製題：說明星系退行速度與距離的關係。' });
        ids.archived = await insertQ({ subject: '數學', chapter: '多項式除法', question_text: '自製題：已封存的長除法練習。', archived: true });
        ids.same = await insertQ({ subject: '數學', chapter: '向量內積', question_text: '自製題：求兩向量的內積。' });
        ids.pureNew = await insertQ({ subject: '數學', chapter: '拋物線', question_text: '自製題：求拋物線的焦點。' });
        ids.chem = await insertQ({ subject: '化學', chapter: '溶解度', question_text: '自製題：由溶解度曲線求析出量。' });
        ids.orphan = await insertQ({ subject: '數學', chapter: '舊系統亂填的章', question_text: '自製題：髒資料。' });
        ids.cm = await insertQ({ subject: '物理', chapter: '剛體轉動與平衡', question_text: '自製題：求兩質點系統的質心位置。' });

        const kcOld = await insertKc('數學', '多項式除法', 'MATH.多項式除法.01');
        const kcOld2 = await insertKc('數學', '多項式除法', 'MATH.多項式除法.02');
        const kcSine = await insertKc('數學', '正弦與餘弦定理', 'MATH.正弦與餘弦定理.01');
        await tag(ids.rename, kcOld, 'ai');
        await tag(ids.rename, kcOld2, 'human');
        await tag(ids.stay, kcSine, 'ai');
    }

    before(async () => {
        const { rows } = await query(`SELECT to_regclass('public.chapter_migration_log') IS NOT NULL AS ok`);
        assert.ok(rows[0].ok, 'migrations/0014 沒有套用');
    });

    after(async () => {
        await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
        await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        fs.rmSync(TMP, { recursive: true, force: true });
        await pool.end();
    });

    describe('--dry-run：只提議、不寫入', () => {
        beforeEach(seed);

        test('rename／split（題幹、metadata、預設）／removed 的提議與依據；same、新章、化學不列', async () => {
            const before = await snapshot();
            const out = path.join(TMP, 'dry.csv');
            const r = await mig.dryRun({ db, outPath: out });

            assert.equal(r.outPath, out);
            const got = r.proposals.map(p => [p.id, p.oldChapter, p.newChapter, p.basis]);
            assert.deepEqual(got, [
                [ids.rename, '多項式除法', '多項式的運算與應用', 'rename'],
                [ids.archived, '多項式除法', '多項式的運算與應用', 'rename'],
                [ids.meta, '組合', '二項式定理', 'keyword:二項式'],
                [ids.fold, '正弦與餘弦定理', '三角函數的疊合', 'keyword:疊合'],
                [ids.stay, '正弦與餘弦定理', '正弦與餘弦定理', 'default'],
                [ids.cosmo, '宇宙學簡介', '物質的組成（夸克與原子）', 'removed'],
                [ids.cm, '剛體轉動與平衡', '質心與角動量', 'keyword:質心'],
                [ids.fluid, '流體的壓力與浮力', '', 'removed']
            ]);
            assert.ok(r.proposals.find(p => p.id === ids.archived).stem.startsWith('（已封存）'));
            assert.deepEqual(r.orphans, [{ id: ids.orphan, subject: '數學', chapter: '舊系統亂填的章' }]);
            assert.deepEqual(r.stats.byBasis, { rename: 2, keyword: 3, default: 1, removed: 2 });
            assert.equal(r.stats.removedBlank, 1);

            // 提議檔：表頭凍結、逐列與 proposals 相同；留空的 removed 列讀回來是錯誤（必須由老師填）
            const table = mig.parseCsv(mig.decodeCsvBuffer(fs.readFileSync(out)).text);
            assert.deepEqual(table[0].cells, ['id', 'subject', '舊章', '提議新章', '依據', '題幹前60字']);
            assert.equal(table.length, 1 + r.proposals.length);
            const { rows, errors } = readCsv(out);
            assert.equal(rows.length, r.proposals.length - 1);
            assert.equal(errors.length, 1);
            assert.match(errors[0], new RegExp(`題號 ${ids.fluid}.*「提議新章」是空的`));

            assert.deepEqual(await snapshot(), before, 'dry-run 不得改動資料庫');
        });

        test('時間截點：沿用舊名的章裡 0014 之後入庫的題只計數、不列（--include-new 照列）；舊名不在白名單的章不看時間', async () => {
            const { rows: m } = await query('SELECT applied_at FROM schema_migrations WHERE version = $1', [mig.LOG_MIGRATION]);
            assert.equal(m.length, 1, `${mig.LOG_MIGRATION} 沒有記在 schema_migrations`);
            assert.deepEqual(await mig.migrationCutoff(db), m[0].applied_at);

            // 重整後 AI 用新白名單分到「排列」的新題（排列在新白名單裡仍然有效）：題幹含「集合」，沒有截點會被提議搬走
            const fresh = await insertQ({ subject: '數學', chapter: '排列', createdAt: null,
                question_text: '自製題：從集合 {1,2,3,4} 中取三個相異數字排成三位數，共有幾種？' });
            // 舊名已不在新白名單的章：就算是之後才入庫（例如舊程式還在跑），也一定要處理
            const lateOld = await insertQ({ subject: '數學', chapter: '多項式除法', createdAt: null, question_text: '自製題：求餘式。' });

            const r = await mig.dryRun({ db, outPath: path.join(TMP, 'cutoff.csv') });
            assert.equal(r.excludedNew, 1);
            assert.deepEqual(r.cutoff, m[0].applied_at);
            assert.ok(!r.proposals.some(p => p.id === fresh), '截點之後入庫、沿用舊名章的題不列');
            assert.ok(r.proposals.some(p => p.id === lateOld && p.newChapter === '多項式的運算與應用'));
            assert.equal(r.stats.total, 9);

            const all = await mig.dryRun({ db, outPath: path.join(TMP, 'cutoff-all.csv'), includeNew: true });
            assert.equal(all.excludedNew, 0);
            assert.deepEqual(all.proposals.filter(p => p.id === fresh).map(p => [p.newChapter, p.basis]),
                [['集合與計數原理', 'keyword:集合']]);
            assert.equal(all.stats.total, 10);
        });

        test('沒有需要處理的題：不寫提議檔', async () => {
            await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
            await insertQ({ subject: '數學', chapter: '向量內積', question_text: '自製題：內積。' });
            const out = path.join(TMP, 'empty.csv');
            const r = await mig.dryRun({ db, outPath: out });
            assert.equal(r.proposals.length, 0);
            assert.equal(r.outPath, null);
            assert.equal(fs.existsSync(out), false);
        });
    });

    describe('--apply', () => {
        let dryFile;
        beforeEach(async () => {
            await seed();
            dryFile = path.join(TMP, `apply-${Date.now()}.csv`);
            await mig.dryRun({ db, outPath: dryFile });
        });

        test('題號不存在、科目與題庫不符 → 整批不寫（已回滾）', async () => {
            const before = await snapshot();
            const { rows } = readCsv(dryFile);
            const bad = [...rows, { line: 99, id: 999999, subject: '數學', oldChapter: '三次函數', newChapter: '多項式不等式', basis: 'default' }];
            const r1 = await mig.applyRows({ db, rows: bad });
            assert.equal(r1.ok, false);
            assert.deepEqual(r1.errors, ['第 99 行：題號 999999 不存在']);
            assert.deepEqual(await snapshot(), before);

            const wrongSubject = rows.map(r => (r.id === ids.rename ? { ...r, subject: '物理', newChapter: '靜電學' } : r));
            const r2 = await mig.applyRows({ db, rows: wrongSubject });
            assert.equal(r2.ok, false);
            assert.match(r2.errors[0], /在題庫裡是數學，CSV 寫的是物理/);
            assert.deepEqual(await snapshot(), before);
        });

        test('單一交易：寫到一半丟例外 → 前面寫過的列也全部回滾', async () => {
            const before = await snapshot();
            const { rows } = readCsv(dryFile);
            let n = 0;
            await assert.rejects(
                mig.applyRows({ db, rows, onRow: () => { n += 1; if (n === 3) throw new Error('模擬中途失敗'); } }),
                /模擬中途失敗/);
            assert.equal(n, 3);
            assert.deepEqual(await snapshot(), before, '中途失敗必須整批回滾');
        });

        test('換章：chapter_src=human、embed_hash 清空、search_tsv 依新章重算、只刪 AI 知識點標註；確認留在原章的題不動', async () => {
            const before = await snapshot();
            // 老師：流體那題改到牛頓運動定律；組合那題不同意搬、留在組合
            const { edited } = teacherEdits(dryFile, { [ids.fluid]: '牛頓運動定律', [ids.meta]: '組合' });
            const { rows, errors } = readCsv(edited);
            assert.deepEqual(errors, []);

            const r = await mig.applyRows({ db, rows });
            assert.equal(r.ok, true);
            assert.equal(r.moved, 6);                    // rename×2、疊合、宇宙學、質心、流體
            assert.equal(r.confirmed, 2);                // 正弦定理那題（default 同名）、組合那題（老師改回原章）
            assert.equal(r.alreadyApplied, 0);
            assert.deepEqual(r.stale, []);
            assert.equal(r.kcsRemoved, 1);

            const a = await qRow(ids.rename);
            assert.equal(a.chapter, '多項式的運算與應用');
            assert.equal(a.chapter_src, 'human');
            assert.equal(a.embed_hash, null, 'embed_text 第一行含章名，換章要讓 embed:backfill 撿得到');
            const lex = lexemesOf((await query('SELECT search_tsv::text AS t FROM questions WHERE id = $1', [ids.rename])).rows[0].t);
            assert.ok(lex.includes('多項式的運算與應用'), lex.join(' '));
            assert.ok(!lex.includes('多項式除法'), lex.join(' '));
            // 與 PUT／search:reindex 同一套組法算出來的值逐字相同
            assert.equal((await query('SELECT search_tsv::text AS t FROM questions WHERE id = $1', [ids.rename])).rows[0].t,
                await expectedTsv(a));

            const kcs = (await query('SELECT src FROM question_kcs WHERE question_id = $1 ORDER BY src', [ids.rename])).rows.map(x => x.src);
            assert.deepEqual(kcs, ['human'], 'src=ai 的標註刪除、human 的保留');

            assert.equal((await qRow(ids.fold)).chapter, '三角函數的疊合');
            assert.equal((await qRow(ids.fluid)).chapter, '牛頓運動定律');
            assert.equal((await qRow(ids.cosmo)).chapter, '物質的組成（夸克與原子）');
            assert.equal((await qRow(ids.cm)).chapter, '質心與角動量');
            const arch = await qRow(ids.archived);
            assert.equal(arch.chapter, '多項式的運算與應用');
            assert.ok(arch.archived_at, '已封存的題照樣搬章，但仍是封存狀態');

            // 確認留在原章的題：題目一個欄位都不動、AI 標註保留
            const pick = (snap, id) => snap.qs.find(x => x.id === id);
            const after1 = await snapshot();
            for (const id of [ids.stay, ids.meta, ids.same, ids.pureNew, ids.chem, ids.orphan]) {
                assert.deepEqual(pick(after1, id), pick(before, id), `題號 ${id} 不該被動到`);
            }
            assert.deepEqual((await query('SELECT src FROM question_kcs WHERE question_id = $1', [ids.stay])).rows, [{ src: 'ai' }]);

            // 遷移紀錄：每一列（含確認留在原章的）各一筆
            const log = after1.log;
            assert.equal(log.length, 8);
            assert.ok(log.every(l => l.plan === mig.PLAN_ID));
            assert.deepEqual(log.find(l => l.question_id === ids.meta),
                { question_id: ids.meta, plan: mig.PLAN_ID, from_chapter: '組合', to_chapter: '組合', basis: 'keyword:二項式' });
            assert.equal(log.find(l => l.question_id === ids.fluid).to_chapter, '牛頓運動定律');
        });

        test('重跑冪等：同一份 CSV 再套一次不改任何東西；之後的 dry-run 不再列出處理過的題', async () => {
            const { edited } = teacherEdits(dryFile, { [ids.fluid]: '牛頓運動定律' });
            const { rows } = readCsv(edited);
            assert.equal((await mig.applyRows({ db, rows })).moved, 7);
            const once = await snapshot();

            const again = await mig.applyRows({ db, rows });
            assert.equal(again.ok, true);
            assert.equal(again.moved, 0);
            assert.equal(again.confirmed, 0);
            assert.equal(again.alreadyApplied, rows.length);
            assert.equal(again.kcsRemoved, 0);
            assert.deepEqual(await snapshot(), once, '第二次套用不得改動任何列');

            const out = path.join(TMP, 'after.csv');
            const r = await mig.dryRun({ db, outPath: out });
            assert.equal(r.proposals.length, 0, JSON.stringify(r.proposals));
            assert.equal(r.alreadyLogged, rows.length);
            assert.equal(r.outPath, null);
        });

        test('同一天產生兩份提議檔：套用改過的那份之後再套另一份，已套用的題一律略過、紀錄不變', async () => {
            // 「排列」沿用舊名：題幹含「集合」→ 提議去集合與計數原理，老師改回排列（確認留在原章）
            const perm = await insertQ({ subject: '數學', chapter: '排列',
                question_text: '自製題：從集合 {1,2,3,4} 中取三個相異數字排成三位數，共有幾種？' });
            const dir = fs.mkdtempSync(path.join(TMP, 'same-day-'));
            const fileA = mig.defaultOutPath(dir, '2026-09-25');
            await mig.dryRun({ db, outPath: fileA });
            const fileB = mig.defaultOutPath(dir, '2026-09-25');
            assert.equal(path.basename(fileB), 'chapter-migration-2026-09-25-2.csv');
            await mig.dryRun({ db, outPath: fileB });
            assert.ok(readCsv(fileB).rows.some(r => r.id === perm && r.newChapter === '集合與計數原理'));

            const a = teacherEdits(fileA, { [perm]: '排列', [ids.fluid]: '牛頓運動定律' });
            const r1 = await mig.applyRows({ db, rows: readCsv(a.edited).rows });
            assert.equal(r1.moved, 7);
            assert.equal(r1.confirmed, 2);                // 正弦定理那題（default 同名）、排列那題（老師改回原章）
            const once = await snapshot();

            // 另一份（流體那題老師在這份填了別的章）
            const b = teacherEdits(fileB, { [ids.fluid]: '位能與能量守恆' });
            const r2 = await mig.applyRows({ db, rows: readCsv(b.edited).rows });
            assert.equal(r2.ok, true);
            assert.equal(r2.moved, 0);
            assert.equal(r2.confirmed, 0);
            assert.equal(r2.kcsRemoved, 0);
            assert.equal(r2.alreadyApplied, 7);
            assert.deepEqual(r2.stale.map(s => [s.id, s.reason, s.csvNew, s.dbChapter, s.loggedTo]).sort((x, y) => x[0] - y[0]), [
                [ids.fluid, 'logged', '位能與能量守恆', '牛頓運動定律', '牛頓運動定律'],
                [perm, 'logged', '集合與計數原理', '排列', '排列']
            ].sort((x, y) => x[0] - y[0]));
            assert.deepEqual(await snapshot(), once, '已套用的題不得再搬、遷移紀錄不得改');
            assert.equal((await qRow(perm)).chapter, '排列');
        });

        test('搬完之後老師在題庫頁改回沿用舊名的章：同一份 CSV 再套一次不會再搬，以老師後來改的為準', async () => {
            const { edited } = teacherEdits(dryFile, { [ids.fluid]: '牛頓運動定律' });
            const { rows } = readCsv(edited);
            assert.equal((await mig.applyRows({ db, rows })).moved, 7);
            assert.equal((await qRow(ids.fold)).chapter, '三角函數的疊合');

            // 老師覺得疊合那題還是放正弦與餘弦定理（新白名單裡仍有效）：題庫頁 PUT 的效果
            await query(`UPDATE questions SET chapter = '正弦與餘弦定理', chapter_src = 'human' WHERE id = $1`, [ids.fold]);
            const reverted = await snapshot();

            const again = await mig.applyRows({ db, rows });
            assert.equal(again.ok, true);
            assert.equal(again.moved, 0);
            assert.equal(again.alreadyApplied, rows.length - 1);
            assert.deepEqual(again.stale.map(s => [s.id, s.reason, s.csvOld, s.csvNew, s.dbChapter, s.loggedFrom, s.loggedTo]),
                [[ids.fold, 'logged', '正弦與餘弦定理', '三角函數的疊合', '正弦與餘弦定理', '正弦與餘弦定理', '三角函數的疊合']]);
            assert.deepEqual(await snapshot(), reverted, '改回舊名章的題不得被再搬一次');

            const r = await mig.dryRun({ db, outPath: path.join(TMP, 'after-revert.csv') });
            assert.equal(r.proposals.length, 0, '記錄過的題之後的 dry-run 也不再列出');
        });

        test('暫緩的題（整列刪掉）不記錄，下次 dry-run 再列出來', async () => {
            const { edited } = teacherEdits(dryFile, {}, [ids.fluid, ids.stay]);
            const { rows, errors } = readCsv(edited);
            assert.deepEqual(errors, []);
            await mig.applyRows({ db, rows });
            const r = await mig.dryRun({ db, outPath: path.join(TMP, 'later.csv') });
            assert.deepEqual(r.proposals.map(p => p.id).sort((x, y) => x - y), [ids.stay, ids.fluid].sort((x, y) => x - y));
        });

        test('產生提議檔之後被老師改過章的題：略過並回報，以題庫現值為準', async () => {
            await query(`UPDATE questions SET chapter = '三角測量', chapter_src = 'human' WHERE id = $1`, [ids.stay]);
            const { edited } = teacherEdits(dryFile, { [ids.fluid]: '牛頓運動定律' });
            const r = await mig.applyRows({ db, rows: readCsv(edited).rows });
            assert.equal(r.ok, true);
            assert.deepEqual(r.stale.map(s => [s.id, s.reason, s.csvOld, s.csvNew, s.dbChapter]),
                [[ids.stay, 'changed', '正弦與餘弦定理', '正弦與餘弦定理', '三角測量']]);
            assert.equal((await qRow(ids.stay)).chapter, '三角測量');
            assert.equal((await query('SELECT 1 FROM chapter_migration_log WHERE question_id = $1', [ids.stay])).rowCount, 0);
        });
    });

    describe('CLI（子行程，--test 打測試庫）', () => {
        beforeEach(seed);

        const run = (args) => spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'migrate_chapters.js'), ...args, '--test'], {
            cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL }
        });

        test('--dry-run 寫提議檔、印統計；--apply 套用後印出 embed:backfill 與 search:reindex', async () => {
            const out = path.join(TMP, 'cli.csv');
            const dry = run(['--out', out]);
            assert.equal(dry.status, 0, dry.stderr + dry.stdout);
            assert.ok(fs.existsSync(out));
            assert.match(dry.stdout, /需要老師確認的題：8 題/);
            assert.match(dry.stdout, /removed 的 2 題/);
            assert.match(dry.stdout, /1 題的章名既不在新白名單、也不在對照表/);

            const { edited } = teacherEdits(out, { [ids.fluid]: '牛頓運動定律' });
            const apply = run(['--apply', edited]);
            assert.equal(apply.status, 0, apply.stderr + apply.stdout);
            assert.match(apply.stdout, /搬到新章 7 題/);
            assert.match(apply.stdout, /npm run embed:backfill/);
            assert.match(apply.stdout, /npm run search:reindex/);
            assert.equal((await qRow(ids.rename)).chapter, '多項式的運算與應用');

            // 搬完之後老師改回沿用舊名的章，再套一次：不搬、印出「已於先前套用，略過」
            await query(`UPDATE questions SET chapter = '正弦與餘弦定理', chapter_src = 'human' WHERE id = $1`, [ids.fold]);
            const again = run(['--apply', edited]);
            assert.equal(again.status, 0, again.stderr + again.stdout);
            assert.match(again.stdout, /搬到新章 0 題/);
            assert.match(again.stdout, /1 題已於先前套用，略過/);
            assert.match(again.stdout, new RegExp(`題號 ${ids.fold}：此題已於 \\d{4}-\\d{2}-\\d{2} 套用（正弦與餘弦定理 → 三角函數的疊合）`));
            assert.equal((await qRow(ids.fold)).chapter, '正弦與餘弦定理');
        });

        test('不合法的 CSV（留空、不在白名單）→ exit 1，資料庫不動', async () => {
            const out = path.join(TMP, 'cli-bad.csv');
            assert.equal(run(['--out', out]).status, 0);
            const before = await snapshot();

            const blank = run(['--apply', out]);                  // 流體那列「提議新章」留空
            assert.equal(blank.status, 1);
            assert.match(blank.stdout, /整批不寫入/);
            assert.match(blank.stdout, /「提議新章」是空的/);

            const { edited } = teacherEdits(out, { [ids.fluid]: '流體的壓力與浮力' });
            const gone = run(['--apply', edited]);
            assert.equal(gone.status, 1);
            assert.match(gone.stdout, /「流體的壓力與浮力」不在物理的新章節白名單內/);

            assert.deepEqual(await snapshot(), before);
        });
    });
}
