// ─────────────────────────────────────────────────────────────
// figureBackfill.pg.test.js — scripts/backfill_figures.js（npm run figures:backfill）的整合測試
// （〔Owner 決策單 2026-09-25 B20〕roadmap 待決策第 19 項、docs/figures.md「舊題補附圖」）
//
// 以自製小 PDF（公開樣卷＋pdf-lib 畫的圖，放在中文資料夾）與測試庫走一遍 dry-run → apply → 再 apply：
//   ① --dry-run：候選題＝question_img 空、不是變式題；提議第 5 題（向量圖）、已封存的同題（第 5 題重複）、
//      第 9 題（點陣圖，入庫紀錄 jobs.pdf_sha256 與這份 PDF 相符 → 依據寫出 job 編號）；
//      已經有附圖的第 10 題、變式題、同文異數的題都不提議；**資料庫一個位元組都不動**。
//   ② --apply：老師刪掉的列不套用；套用的題 question_img＝/figures/backfill-<題號>-<雜湊>.png、圖檔進附圖目錄；
//      其餘題不動。
//   ③ 冪等：同一份 CSV 再套一次什麼都不改（回報「先前已套用」）；之後的 --dry-run 不再列出補過的題，
//      刪掉的列下次照列。已經有別的附圖的題略過並回報。
//   ④ 交易：題號不存在 → 整批不寫；中途丟例外 → 全部回滾、這次新放的圖檔也刪掉。
//   ⑤ CLI：子行程跑 --dry-run（--test 打測試庫）exit 0；不合法的提議檔、--apply 配 --use-llm 都 exit 1、資料庫不動。
//   ⑥ 〔審查修正 2026-09-26〕--apply 核對題幹：產生提議檔之後題目被改過、或提議檔是對另一個資料庫產生的（同題號是
//      別的題）→ 那一題略過並回報、不貼圖；提議檔少了「題幹前60字」欄 → CLI exit 1、整批不寫。
// 不呼叫 LLM（沒有注入 LLM、沒有 cassette；--use-llm 的行為由單元測試以假的拆題 agent 驗證）。
//
// 三道防線與其他整合測試相同：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、在 require config/db.js 之前覆寫
// DATABASE_URL。附圖寫到暫存資料夾（figuresDir 注入），不碰 exam_pro/data/figures。題目全部取自本專案自製的公開樣卷。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('舊題補附圖整合測試（需要 PostgreSQL）', {
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
    const bf = require(path.join(APP_DIR, 'scripts', 'backfill_figures'));
    const { parseCsv, decodeCsvBuffer } = require(path.join(APP_DIR, 'scripts', 'migrate_chapters'));
    const fx = require(path.join(APP_DIR, 'test', 'fixtures', 'figureBackfillPdf'));
    const db = { pool, query };

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'figure-backfill-pg-'));
    const DIR = path.join(TMP, '各校考卷');
    const FIGDIR = path.join(TMP, 'figures');
    const quiet = { warn() { } };
    let figSha;
    let outSeq = 0;
    const nextOut = () => path.join(TMP, `提議-${++outSeq}`);

    const ids = {};

    async function insertQ(q) {
        const { rows } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, question_img, answer_text,
                                    origin, variant_of, archived_at)
             VALUES ('物理', $1, '計算', 3, $2, $3, '自製答案', $4, $5, $6) RETURNING id`,
            [q.chapter || '牛頓運動定律', q.text, q.img || null, q.origin || 'pdf', q.variantOf || null, q.archived ? new Date() : null]);
        return rows[0].id;
    }

    async function seed() {
        await query('TRUNCATE jobs RESTART IDENTITY CASCADE');
        await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        fs.rmSync(FIGDIR, { recursive: true, force: true });
        ids.q5 = await insertQ({ text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。' });
        ids.q5dup = await insertQ({ text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', archived: true });
        ids.q5twin = await insertQ({ text: '質量 $3$ kg 的物體受到合力 $12$ N，求其加速度。' });
        ids.q9 = await insertQ({ text: '馬拉車前進時，馬對車的作用力 $F$ 與車對馬的反作用力，兩者的關係為何？\n[附圖描述：馬拉著車]' });
        ids.q7 = await insertQ({ chapter: '直線運動', text: '物體由靜止出發，以 $2\\ \\text{m/s}^2$ 的等加速度直線前進，求 $5$ 秒後的位移。\n[附圖描述：v-t 圖]' });
        ids.q10 = await insertQ({ chapter: '圓周運動', text: '關於等速圓周運動，下列敘述何者正確？（複選）', img: '/figures/1-1001.png' });
        ids.variant = await insertQ({ text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', origin: 'variant', variantOf: ids.q5 });
        // 第 9 題當初由這份 PDF 拆出（jobs.pdf_sha256）
        const { rows: j } = await query(
            `INSERT INTO jobs (kind, pdf_sha256, budget_usd, state) VALUES ('pdf', $1, 0.5, 'done') RETURNING id`, [figSha]);
        ids.job = Number(j[0].id);
        await query(`INSERT INTO job_questions (job_id, idx, state, payload, question_id) VALUES ($1, 1001, 'saved', '{}', $2)`, [ids.job, ids.q9]);
    }

    async function snapshot() {
        return (await query('SELECT id, question_img, (archived_at IS NOT NULL) AS archived FROM questions ORDER BY id')).rows;
    }
    const imgOf = async (id) => (await query('SELECT question_img FROM questions WHERE id = $1', [id])).rows[0].question_img;
    const figFiles = () => (fs.existsSync(FIGDIR) ? fs.readdirSync(FIGDIR).sort() : []);

    /** 讀提議檔 → 套用用的列（含圖檔檢查） */
    async function loadApply(file) {
        const { rows, errors } = bf.readApplyRows(decodeCsvBuffer(fs.readFileSync(file)).text);
        assert.deepEqual(errors, []);
        const imageErrors = await bf.checkImages(rows, path.dirname(file));
        assert.deepEqual(imageErrors, []);
        return rows;
    }

    /** 老師的操作：刪掉 drop 裡的題號，另存成同資料夾的新檔（圖檔必須與提議檔同資料夾） */
    function teacherEdits(file, { drop = [], retarget = null } = {}) {
        const table = parseCsv(decodeCsvBuffer(fs.readFileSync(file)).text);
        const out = [table[0].cells];
        for (const { cells } of table.slice(1)) {
            const id = Number(cells[0]);
            if (drop.includes(id)) continue;
            const next = cells.slice();
            if (retarget && retarget.from === id) next[0] = String(retarget.to);
            out.push(next);
        }
        const edited = path.join(path.dirname(file), `edited-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
        fs.writeFileSync(edited, '\uFEFF' + out.map(r => r.map(c => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n');
        return edited;
    }

    before(async () => {
        const bytes = await fx.makeFigurePdf();
        figSha = crypto.createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(path.join(DIR, '高一 段考'), { recursive: true });
        fs.mkdirSync(path.join(DIR, '其他'), { recursive: true });
        fs.writeFileSync(path.join(DIR, '高一 段考', '自製附圖卷（測試）.pdf'), bytes);
        fs.copyFileSync(fx.SAMPLE_PDF, path.join(DIR, '其他', '樣卷（無附圖）.pdf'));
    });

    after(async () => {
        await query('TRUNCATE jobs RESTART IDENTITY CASCADE');
        await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        fs.rmSync(TMP, { recursive: true, force: true });
        await pool.end();
    });

    describe('dry-run → apply → 再 apply', () => {
        beforeEach(seed);

        test('① dry-run：候選題篩選、提議與依據；資料庫不動', async () => {
            const cands = await bf.selectCandidates(db);
            assert.deepEqual(cands.map(c => c.id), [ids.q5, ids.q5dup, ids.q5twin, ids.q9, ids.q7], '不含已有附圖的題與變式題');
            assert.deepEqual(cands.find(c => c.id === ids.q9).pdfShas, [figSha]);
            assert.deepEqual(cands.find(c => c.id === ids.q9).jobIds, [ids.job]);

            const before = await snapshot();
            const out = nextOut();
            const r = await bf.dryRun({ db, dir: DIR, outDir: out, logger: quiet });
            assert.deepEqual(r.proposals.map(p => p.id), [ids.q5, ids.q5dup, ids.q9]);
            assert.equal(r.stats.pdfs, 2);
            assert.equal(r.stats.tieLost, 2, '同文異數的題在兩份卷各讓位一次');
            assert.deepEqual(r.stats.hintedWithoutFigure, [ids.q7]);
            assert.equal(r.csvPath, path.join(out, 'proposals.csv'));

            const table = parseCsv(decodeCsvBuffer(fs.readFileSync(r.csvPath)).text);
            assert.deepEqual(table[0].cells, ['題號', '科目', '章', '題幹前60字', '來源PDF', '頁碼', '圖檔暫存路徑', '比對分數', '依據']);
            const q9 = table.find(t => t.cells[0] === String(ids.q9)).cells;
            assert.equal(q9[4], path.join('高一 段考', '自製附圖卷（測試）.pdf'));
            assert.equal(q9[5], '1');
            assert.equal(q9[6], path.join(out, `q${ids.q9}.png`));
            assert.equal(q9[7], '1.00');
            assert.match(q9[8], new RegExp(`原卷與入庫紀錄相符（job #${ids.job}）`));
            assert.match(table.find(t => t.cells[0] === String(ids.q5dup)).cells[3], /^（已封存）/);
            assert.ok(fs.existsSync(path.join(out, `q${ids.q5}.png`)) && fs.existsSync(r.previewPath));

            assert.deepEqual(await snapshot(), before, 'dry-run 不得改動資料庫');
            assert.deepEqual(figFiles(), [], 'dry-run 不得寫進附圖目錄');
        });

        test('② apply：刪掉的列不套用；③ 再 apply 冪等；之後的 dry-run 不再列出補過的題', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            const edited = teacherEdits(r.csvPath, { drop: [ids.q5dup] });
            const rows = await loadApply(edited);
            assert.deepEqual(rows.map(x => x.id), [ids.q5, ids.q9]);

            const a = await bf.applyRows({ db, rows, figuresDir: FIGDIR });
            assert.equal(a.ok, true);
            assert.equal(a.applied, 2);
            assert.deepEqual(a.appliedIds, [ids.q5, ids.q9]);
            const want5 = bf.figureUrl(ids.q5, rows[0].sha8);
            const want9 = bf.figureUrl(ids.q9, rows[1].sha8);
            assert.equal(await imgOf(ids.q5), want5);
            assert.equal(await imgOf(ids.q9), want9);
            assert.equal(await imgOf(ids.q5dup), null, '刪掉的列不套用');
            assert.equal(await imgOf(ids.q10), '/figures/1-1001.png');
            assert.deepEqual(figFiles(), [bf.figureFileName(ids.q5, rows[0].sha8), bf.figureFileName(ids.q9, rows[1].sha8)].sort());
            assert.ok(fs.readFileSync(path.join(FIGDIR, bf.figureFileName(ids.q9, rows[1].sha8))).equals(rows[1].bytes));

            // ③ 同一份 CSV 再套一次
            const snap = await snapshot();
            const again = await bf.applyRows({ db, rows: await loadApply(edited), figuresDir: FIGDIR });
            assert.equal(again.ok, true);
            assert.equal(again.applied, 0);
            assert.equal(again.alreadyApplied, 2);
            assert.deepEqual(again.hasOther, []);
            assert.deepEqual(await snapshot(), snap, '重跑不改任何東西');

            // 之後的 dry-run：補過的題不再列出；刪掉的列（第 5 題的已封存重複題）照列
            const next = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            assert.deepEqual(next.proposals.map(p => p.id), [ids.q5dup]);
        });

        test('已經有別的附圖的題略過並回報（以題庫現值為準）', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            const edited = teacherEdits(r.csvPath, { drop: [ids.q5dup, ids.q9], retarget: { from: ids.q5, to: ids.q10 } });
            const a = await bf.applyRows({ db, rows: await loadApply(edited), figuresDir: FIGDIR });
            assert.equal(a.ok, true);
            assert.equal(a.applied, 0);
            assert.deepEqual(a.hasOther.map(h => [h.id, h.current]), [[ids.q10, '/figures/1-1001.png']]);
            assert.equal(await imgOf(ids.q10), '/figures/1-1001.png');
            assert.deepEqual(figFiles(), []);
        });

        test('④ 題號不存在 → 整批不寫；中途丟例外 → 全部回滾、這次新放的圖檔也刪掉', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            const before = await snapshot();

            const ghost = teacherEdits(r.csvPath, { retarget: { from: ids.q5dup, to: 999999 } });
            const bad = await bf.applyRows({ db, rows: await loadApply(ghost), figuresDir: FIGDIR });
            assert.equal(bad.ok, false);
            assert.match(bad.errors[0], /題號 999999 不存在/);
            assert.deepEqual(await snapshot(), before);
            assert.deepEqual(figFiles(), []);

            let n = 0;
            await assert.rejects(bf.applyRows({
                db, rows: await loadApply(r.csvPath), figuresDir: FIGDIR,
                onRow: async () => { n += 1; if (n === 2) throw new Error('模擬中途失敗'); }
            }), /模擬中途失敗/);
            assert.deepEqual(await snapshot(), before, '中途失敗整批回滾');
            assert.deepEqual(figFiles(), [], '這次新放的圖檔一併刪掉');
        });
    });

    describe('⑤ CLI', () => {
        before(seed);
        const run = (args) => spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'backfill_figures.js'), ...args], {
            cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL }
        });

        test('--dry-run --test：exit 0、印出提議檔與下一步；資料庫不動', async () => {
            const before = await snapshot();
            const out = nextOut();
            const res = run(['--test', '--dir', DIR, '--out-dir', out]);
            assert.equal(res.status, 0, res.stderr);
            assert.match(res.stdout, /不呼叫 LLM/);
            assert.match(res.stdout, /提議補圖：3 題/);
            assert.match(res.stdout, new RegExp(`提議檔：.*proposals\\.csv`));
            assert.match(res.stdout, /npm run figures:backfill -- --apply/);
            assert.match(res.stdout, new RegExp(`題幹提到圖、原卷也找到了，卻沒有偵測到圖的題.*：#${ids.q7}$`, 'm'));
            assert.ok(fs.existsSync(path.join(out, 'proposals.csv')));
            assert.deepEqual(await snapshot(), before);

            // 同一個 --out-dir 再跑一次：拒絕，不蓋掉提議檔
            const again = run(['--test', '--dir', DIR, '--out-dir', out]);
            assert.equal(again.status, 1);
            assert.match(again.stderr, /已經存在/);
        });

        test('不合法的提議檔 exit 1、整批不寫；--apply 配 --use-llm 直接拒絕', async () => {
            const before = await snapshot();
            const dir = path.join(TMP, 'bad-cli');
            fs.mkdirSync(dir, { recursive: true });
            const bad = path.join(dir, 'proposals.csv');
            fs.writeFileSync(bad, '\uFEFF題號,圖檔暫存路徑\r\n1,q1.png\r\nabc,q2.png\r\n');
            const res = run(['--test', '--apply', bad]);
            assert.equal(res.status, 1);
            assert.match(res.stdout, /整批不寫入/);
            assert.match(res.stdout, /題號「abc」不是正整數/);

            const mixed = run(['--test', '--apply', bad, '--use-llm']);
            assert.equal(mixed.status, 1);
            assert.match(mixed.stderr, /--use-llm 只用在 --dry-run/);
            assert.deepEqual(await snapshot(), before);
        });
    });

    // 〔審查修正 2026-09-26〕--apply 比照 migrate_chapters.js 的過期檢查：提議檔的「題幹前60字」與題庫現值不同 → 略過並警告
    describe('⑥ --apply 核對題幹（題庫現值與提議檔不同就略過）', () => {
        beforeEach(seed);

        test('產生提議檔之後題目在題庫頁被改過 → 那一題略過並回報，其餘照套', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            const rows = await loadApply(r.csvPath);
            assert.deepEqual(rows.map(x => x.id), [ids.q5, ids.q5dup, ids.q9]);
            await query('UPDATE questions SET question_text = $2 WHERE id = $1',
                [ids.q9, '馬拉車前進時，馬對車的作用力 $F$ 與車對馬的反作用力，兩者的大小關係為何？（老師改過題目）']);

            const a = await bf.applyRows({ db, rows, figuresDir: FIGDIR });
            assert.equal(a.ok, true);
            assert.deepEqual(a.appliedIds, [ids.q5, ids.q5dup], '已封存的重複題：提議檔的「（已封存）」前綴不算不同');
            assert.deepEqual(a.stale.map(s => [s.id, s.line]), [[ids.q9, 4]]);
            assert.match(a.stale[0].csvStem, /兩者的關係為何/);
            assert.match(a.stale[0].dbStem, /兩者的大小關係為何/);
            assert.equal(await imgOf(ids.q9), null, '改過的題不貼圖');
            assert.ok(!figFiles().some(f => f.startsWith(`backfill-${ids.q9}-`)), '也不放圖檔');
        });

        test('提議檔是對另一個資料庫產生的（同一個題號在這裡是別的題）→ 略過並回報，不把圖貼到不相干的題', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            // 另一台電腦的第 ids.q5 題，在這個資料庫裡的同一個題號是第 7 題（直線運動）：以改題號模擬
            const edited = teacherEdits(r.csvPath, { drop: [ids.q5dup, ids.q9], retarget: { from: ids.q5, to: ids.q7 } });
            const before = await snapshot();
            const a = await bf.applyRows({ db, rows: await loadApply(edited), figuresDir: FIGDIR });
            assert.equal(a.ok, true);
            assert.equal(a.applied, 0);
            assert.deepEqual(a.stale.map(s => s.id), [ids.q7]);
            assert.match(a.stale[0].csvStem, /^質量 \$2\$ kg/);
            assert.match(a.stale[0].dbStem, /^物體由靜止出發/);
            assert.deepEqual(await snapshot(), before);
            assert.deepEqual(figFiles(), []);
        });

        test('CLI：提議檔少了「題幹前60字」欄 → exit 1、整批不寫（無法核對就不套用）', async () => {
            const r = await bf.dryRun({ db, dir: DIR, outDir: nextOut(), logger: quiet });
            const table = parseCsv(decodeCsvBuffer(fs.readFileSync(r.csvPath)).text);
            const stemCol = table[0].cells.indexOf('題幹前60字');
            assert.ok(stemCol >= 0);
            const noStem = path.join(path.dirname(r.csvPath), 'no-stem.csv');
            fs.writeFileSync(noStem, '﻿' + table.map(t => t.cells.filter((c, i) => i !== stemCol)
                .map(c => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n');
            const before = await snapshot();
            const res = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'backfill_figures.js'), '--test', '--apply', noStem], {
                cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL }
            });
            assert.equal(res.status, 1, res.stderr);
            assert.match(res.stdout, /整批不寫入/);
            assert.match(res.stdout, /表頭缺少「題幹前60字」欄/);
            assert.deepEqual(await snapshot(), before);
        });
    });
}
