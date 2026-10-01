// ─────────────────────────────────────────────────────────────
// test/unit/assignmentSplit.test.js — 派題與作答拆表的純函式與旗標（〔retrain PR-1〕docs/retrain-and-review.md）
//
//   1. examController 的兩支 SQL builder（出卷寫派題＋作答、刪卷前找擋路的重練派題）與 409 回應的組法。
//   2. FEATURE_RETRAIN（第 5.1 節）：預設關、讀法同其他旗標。
//   3. migrations/0016 的靜態檢查：搬資料只在 attempts 還是實體表時執行（冪等）、自我檢查在刪舊表之前。
//   4. test/helpers/attempts.js：不認得的欄位直接丟錯（夾具打錯字不會靜默變成 NULL）。
// 真正的資料庫行為在 test/integration/assignmentSplit.pg.test.js 與 assignmentWrites.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// examController 在模組頂層 require config/db（缺 DATABASE_URL 會直接丟錯）；這裡只借純函式，不連線。
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';
const exam = require('../../controllers/examController');
const features = require('../../config/features');
const helper = require('../helpers/attempts');

const { buildInsertNewAssignmentsSql, buildRetrainBlockersSql, retrainBlockedBody } = exam._assignmentInternals;
const M1 = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0016_assignment_attempt_split.sql'), 'utf8');

describe('出卷的寫入語句（writePaper）', () => {
    const sql = buildInsertNewAssignmentsSql();

    test('先寫派題（purpose = new），再替實際寫進去的派題建空白作答', () => {
        assert.match(sql, /INSERT INTO assignments \(student_id, question_id, paper_id, assigned_at, purpose\)/);
        assert.match(sql, /SELECT \$1::int, x, \$3::int, \$4::date, 'new' FROM unnest\(\$2::int\[\]\) AS x/);
        assert.match(sql, /RETURNING id\s*\)\s*INSERT INTO attempt_records \(assignment_id\) SELECT id FROM ins/);
    });

    test('硬閘門指名新題的部分唯一索引：同一組欄位＋WHERE purpose = new，撞到 DO NOTHING（rowCount 因此少於題數）', () => {
        assert.match(sql, /ON CONFLICT \(student_id, question_id\) WHERE purpose = 'new' DO NOTHING/);
        // 0016 的部分唯一索引就是這一組欄位與條件
        assert.match(M1, /CREATE UNIQUE INDEX IF NOT EXISTS assignments_first_exposure_key\s+ON assignments \(student_id, question_id\) WHERE purpose = 'new'/);
    });

    test('不寫檢視 attempts（寫檢視會立刻報錯）', () => {
        assert.doesNotMatch(sql, /INTO attempts\b/);
    });
});

describe('刪卷前找擋路的重練派題（第 3.9 節）', () => {
    test('只看這張卷上的新題派題、同生同題、在別張卷的重練派題', () => {
        const sql = buildRetrainBlockersSql();
        assert.match(sql, /WHERE n\.paper_id = \$1 AND n\.purpose = 'new'/);
        assert.match(sql, /r\.student_id = n\.student_id AND r\.question_id = n\.question_id/);
        assert.match(sql, /r\.purpose = 'retrain' AND r\.paper_id IS DISTINCT FROM n\.paper_id/);
    });

    test('409 訊息列出題數與重練卷（去重、依卷號排序）', () => {
        assert.deepEqual(retrainBlockedBody([
            { question_id: 7, retrain_paper_ids: [12, 9] },
            { question_id: 3, retrain_paper_ids: [9] }
        ]), {
            message: '這張卷有 2 題已經在錯題重練中（重練卷 #9、#12），請先刪除那些重練卷。',
            question_ids: [7, 3],
            retrain_paper_ids: [9, 12]
        });
    });

    test('重練派題都沒有卷號時，訊息不列卷號', () => {
        assert.deepEqual(retrainBlockedBody([{ question_id: 5, retrain_paper_ids: null }]), {
            message: '這張卷有 1 題已經在錯題重練中，請先刪除那些重練卷。',
            question_ids: [5],
            retrain_paper_ids: []
        });
    });
});

describe('FEATURE_RETRAIN（第 5.1 節）', () => {
    function withEnv(value, fn) {
        const saved = process.env.FEATURE_RETRAIN;
        if (value === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = value;
        try { return fn(); } finally {
            if (saved === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = saved;
        }
    }

    test('預設關；只有 1／true（不分大小寫）是開，其餘一律關（同 parseBool）', () => {
        assert.equal(withEnv(undefined, () => features.FEATURE_RETRAIN), false);
        for (const v of ['1', 'true', 'TRUE', ' True ']) assert.equal(withEnv(v, () => features.FEATURE_RETRAIN), true, v);
        for (const v of ['0', 'false', 'off', 'no', '', '__FEATURE_RETRAIN__']) {
            assert.equal(withEnv(v, () => features.FEATURE_RETRAIN), false, v);
        }
    });

    test('前端注入點與 app.js 的 replaceAll 都在（預設 false）', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.ok(html.includes('<meta name="feature-retrain" content="__FEATURE_RETRAIN__">'));
        const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
        assert.match(app, /\.replaceAll\('__FEATURE_RETRAIN__', process\.env\.FEATURE_RETRAIN \|\| 'false'\)/);
    });
});

describe('migrations/0016 的靜態檢查', () => {
    test('搬資料只在 attempts 還是實體表時執行（已拆過的庫再套一次是 no-op）', () => {
        assert.match(M1, /IF old_rel IS NULL OR \(SELECT c\.relkind FROM pg_class c WHERE c\.oid = old_rel\) <> 'r' THEN\s+RETURN;/);
        assert.match(M1, /CREATE TABLE IF NOT EXISTS assignments/);
        assert.match(M1, /CREATE TABLE IF NOT EXISTS attempt_records/);
        assert.match(M1, /CREATE OR REPLACE VIEW attempts AS/);
        assert.match(M1, /CREATE OR REPLACE VIEW assignment_attempts AS/);
    });

    test('自我檢查（RAISE）在刪舊表之前；檢視 attempts 只含新題派題', () => {
        const raise = M1.indexOf("RAISE EXCEPTION '派題／作答拆表：新舊資料不一致，已回滾'");
        const drop = M1.indexOf('DROP TABLE attempts;');
        assert.ok(raise > 0 && drop > raise, '自我檢查必須在 DROP TABLE attempts 之前');
        const view = M1.slice(M1.indexOf('CREATE OR REPLACE VIEW attempts AS'), M1.indexOf('CREATE OR REPLACE VIEW assignment_attempts AS'));
        assert.match(view, /WHERE s\.purpose = 'new';/);
    });
});

describe('遷移驗證腳本的比對（scripts/snapshot_attempt_views.js）', () => {
    const { diffSnapshots, parseArgs } = require('../../scripts/snapshot_attempt_views');
    const base = () => ({
        meta: { taken_at: '2026-09-26T00:00:00Z', attempts_relkind: 'r' },
        attempts: { count: 3, md5: 'abc' },
        students: [{ student_id: 1, weakness: { 'buildByChapter@90': [{ chapter: '向量內積', wrong_rate: 0.5 }] }, papers: [] }]
    });

    test('完全相同 → 空陣列；meta（拍攝時間、表或檢視）不算差異', () => {
        const b = base();
        b.meta = { taken_at: '2026-09-27T00:00:00Z', attempts_relkind: 'v' };
        assert.deepEqual(diffSnapshots(base(), b), []);
    });

    test('指出差在哪一條路徑與兩邊的值', () => {
        const b = base();
        b.attempts.md5 = 'def';
        b.students[0].weakness['buildByChapter@90'][0].wrong_rate = 0.25;
        b.students[0].papers.push({ paper_id: 1 });
        assert.deepEqual(diffSnapshots(base(), b), [
            '$.attempts.md5："abc" → "def"',
            '$.students[0].papers：長度 0 → 1',
            '$.students[0].weakness.buildByChapter@90[0].wrong_rate：0.5 → 0.25'
        ]);
    });

    test('參數：--out=檔名、--test、--compare 兩個位置參數', () => {
        assert.deepEqual(parseArgs(['--out=a.json', '--test']), { _: [], out: 'a.json', test: true });
        assert.deepEqual(parseArgs(['--compare', 'a.json', 'b.json']), { _: ['a.json', 'b.json'], compare: true });
    });
});

describe('test/helpers/attempts.js', () => {
    test('不認得的欄位、缺 student_id／question_id 直接丟錯', async () => {
        const never = () => { throw new Error('不該連資料庫'); };
        await assert.rejects(helper.insertAttempts(never, [{ student_id: 1, question_id: 2, reslut: 1 }]), /不認得的欄位 reslut/);
        await assert.rejects(helper.insertAttempts(never, [{ question_id: 2 }]), /student_id 與 question_id 必填/);
        assert.deepEqual(await helper.insertAttempts(never, []), []);
    });

    test('寫入語句：派題與作答同一句，skipExisting 才加新題的 ON CONFLICT', () => {
        const plain = helper.buildInsertSql();
        assert.match(plain, /INSERT INTO assignments \(id, student_id, question_id, paper_id, assigned_at, purpose\)\s+OVERRIDING SYSTEM VALUE/);
        assert.match(plain, /INSERT INTO attempt_records \(assignment_id, result, graded_at, score, error_types, response, teacher_note\)/);
        assert.doesNotMatch(plain, /ON CONFLICT/);
        assert.match(helper.buildInsertSql({ skipExisting: true }),
            /ON CONFLICT \(student_id, question_id\) WHERE purpose = 'new' DO NOTHING/);
    });
});
