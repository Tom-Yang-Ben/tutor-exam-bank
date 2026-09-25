// ─────────────────────────────────────────────────────────────
// test/integration/retrainMigration.pg.test.js — migrations/0017_retrain_items.sql（M2，錯題重練排程項目）的套用測試
// （〔retrain PR-2〕docs/retrain-and-review.md 第 3.4、3.5 節）
//
// 比照 assignmentSplit.pg.test.js：在同一顆測試庫裡另開暫用 schema（search_path = <暫用 schema>, public），
// 照 migrate.js 一支一交易地套 migrations/，不動其他整合測試共用的 public schema。
//
// 驗什麼：
//   1. 空庫：從 0001 一路套到 0017 → retrain_items 的欄位與約束、assignments 新增的兩欄與兩個約束、索引、
//      檢視 assignment_attempts 往後加兩欄（前 13 欄的名稱與順序不變）。
//   2. 資料庫保證的不變量：I1（重練派題 → 同生同題的項目 → 同生同題的「新題」派題）、I3、I5、override 成對、
//      assignments_retrain_link_check、retrain_items.question_id 是 RESTRICT；兩個複合外鍵可以延後到 COMMIT 檢查。
//   3. 重複套用：再套一次 0017 是 no-op（約束與索引數量不變、資料不動）。
//   4. 有資料的 0016 庫：套 0017 不動既有派題；若已有沒有項目的重練派題 → RAISE、整支回滾。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
const M2 = '0017_retrain_items.sql';

if (!TEST_DATABASE_URL) {
    test('0017 排程項目的套用測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    const { Client } = require('pg');
    const ALL = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const M2_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, M2), 'utf8');

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

    async function withScratchSchema(name, fn) {
        const client = new Client({ connectionString: TEST_DATABASE_URL });
        await client.connect();
        client.on('notice', () => { });
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

    async function columns(client, schema, table) {
        const { rows } = await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`, [schema, table]);
        return rows.map(r => r.column_name);
    }

    /** 某張表上的約束：名稱 → { type, deferrable, confdeltype } */
    async function constraints(client, schema, table) {
        const { rows } = await client.query(
            `SELECT c.conname, c.contype, c.condeferrable, c.condeferred, c.confdeltype
               FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = $1 AND t.relname = $2 ORDER BY c.conname`, [schema, table]);
        return new Map(rows.map(r => [r.conname, r]));
    }

    async function indexes(client, schema) {
        const { rows } = await client.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [schema]);
        return rows.map(r => r.indexname);
    }

    /** 一位學生、兩題、一張卷、兩筆新題派題。 */
    async function seedBasics(client) {
        const { rows: st } = await client.query(`INSERT INTO students (name) VALUES ('排程遷移生甲'), ('排程遷移生乙') RETURNING id`);
        const { rows: qs } = await client.query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
             VALUES ('數學', '向量內積', '計算', 3, '排程遷移題一', '1'), ('數學', '向量內積', '計算', 3, '排程遷移題二', '2')
             RETURNING id`);
        const s = st[0].id, t = st[1].id, q1 = qs[0].id, q2 = qs[1].id;
        const { rows: [p] } = await client.query(
            `INSERT INTO exam_papers (title, student_id, question_ids) VALUES ('排程遷移卷', $1, $2::int[]) RETURNING id`, [s, [q1, q2]]);
        const { rows: a } = await client.query(
            `INSERT INTO assignments (student_id, question_id, paper_id, assigned_at) VALUES ($1, $2, $4, '2026-09-01'), ($1, $3, $4, '2026-09-01')
             RETURNING id`, [s, q1, q2, p.id]);
        const { rows: [ta] } = await client.query(
            `INSERT INTO assignments (student_id, question_id, assigned_at) VALUES ($1, $2, '2026-09-01') RETURNING id`, [t, q1]);
        return { s, t, q1, q2, paper: p.id, a1: Number(a[0].id), a2: Number(a[1].id), ta: Number(ta.id) };
    }

    const reject = (promise, code, constraint) => assert.rejects(promise,
        err => err.code === code && (constraint === undefined || err.constraint === constraint),
        `預期 ${code}${constraint ? `（${constraint}）` : ''}`);

    describe('0017 排程項目（M2）', () => {
        test('空庫：0001 一路套到 0017；表、欄位、約束、索引、檢視；資料庫保證 I1／I3／I5 與 RESTRICT；再套一次是 no-op', async () => {
            const S = 'm2retrain_empty';
            await withScratchSchema(S, async client => {
                await applyFiles(client, ALL.filter(f => f <= M2));

                assert.deepEqual(await columns(client, S, 'retrain_items'), [
                    'id', 'student_id', 'question_id', 'source_assignment_id', 'source_purpose', 'reason', 'entered_on',
                    'entered_after_assignment_id', 'status', 'step', 'due_on', 'streak', 'lapses', 'last_attempt_on',
                    'mastered_on', 'teacher_override', 'override_on', 'note', 'updated_at']);
                const asgCols = await columns(client, S, 'assignments');
                assert.deepEqual(asgCols.slice(-2), ['retrain_item_id', 'retrain_step']);
                // 檢視往後加兩欄：0016 的十三欄名稱與順序不變
                assert.deepEqual(await columns(client, S, 'assignment_attempts'), [
                    'assignment_id', 'student_id', 'question_id', 'paper_id', 'assigned_at', 'purpose',
                    'attempt_id', 'result', 'graded_at', 'score', 'error_types', 'response', 'teacher_note',
                    'retrain_item_id', 'retrain_step']);
                assert.deepEqual((await columns(client, S, 'attempts')).length, 12, '檢視 attempts 不動');

                const ri = await constraints(client, S, 'retrain_items');
                for (const n of ['retrain_items_student_question_key', 'retrain_items_ref_key', 'retrain_items_due_check',
                    'retrain_items_override_check', 'retrain_items_source_fk']) assert.ok(ri.has(n), `缺少 ${n}`);
                assert.deepEqual([ri.get('retrain_items_source_fk').condeferrable, ri.get('retrain_items_source_fk').condeferred], [true, false],
                    'DEFERRABLE INITIALLY IMMEDIATE');
                const qfk = [...ri.values()].find(c => c.contype === 'f' && c.conname !== 'retrain_items_source_fk' && c.confdeltype === 'r');
                assert.ok(qfk, 'retrain_items.question_id 是 ON DELETE RESTRICT');
                const asg = await constraints(client, S, 'assignments');
                for (const n of ['assignments_retrain_link_check', 'assignments_retrain_item_fk', 'assignments_retrain_step_check']) {
                    assert.ok(asg.has(n), `缺少 ${n}`);
                }
                assert.deepEqual([asg.get('assignments_retrain_item_fk').condeferrable, asg.get('assignments_retrain_item_fk').condeferred], [true, false]);
                const idx = await indexes(client, S);
                for (const n of ['idx_retrain_items_due', 'idx_retrain_items_source', 'idx_assignments_retrain_item']) {
                    assert.ok(idx.includes(n), `缺少索引 ${n}`);
                }

                const fx = await seedBasics(client);
                const item = async (sid, qid, src) => {
                    const { rows: [r] } = await client.query(
                        `INSERT INTO retrain_items (student_id, question_id, source_assignment_id, reason, due_on)
                         VALUES ($1, $2, $3, 'flagged', '2026-09-02') RETURNING id`, [sid, qid, src]);
                    return Number(r.id);
                };
                const sp = async fn => {
                    await client.query('SAVEPOINT t');
                    try { await fn(); } finally { await client.query('ROLLBACK TO SAVEPOINT t'); }
                };
                await client.query('BEGIN');
                try {
                    // I1 後半：項目一定指向同生同題的新題派題
                    await sp(() => reject(item(fx.s, fx.q2, fx.a1), '23503', 'retrain_items_source_fk'));   // 題目對不上
                    await sp(() => reject(item(fx.s, fx.q1, fx.ta), '23503', 'retrain_items_source_fk'));   // 學生對不上
                    const i1 = await item(fx.s, fx.q1, fx.a1);
                    // I3：每生每題至多一個項目
                    await sp(() => reject(item(fx.s, fx.q1, fx.a1), '23505', 'retrain_items_student_question_key'));
                    // I5：只有進行中有到期日；override 與日期成對；reason／status 白名單
                    await sp(() => reject(client.query(`UPDATE retrain_items SET due_on = NULL WHERE id = $1`, [i1]), '23514', 'retrain_items_due_check'));
                    await sp(() => reject(client.query(`UPDATE retrain_items SET status = 'mastered' WHERE id = $1`, [i1]), '23514', 'retrain_items_due_check'));
                    await sp(() => reject(client.query(`UPDATE retrain_items SET teacher_override = 'retired' WHERE id = $1`, [i1]), '23514', 'retrain_items_override_check'));
                    await sp(() => reject(client.query(`UPDATE retrain_items SET reason = 'wrong' WHERE id = $1`, [i1]), '23514'));
                    await sp(() => reject(client.query(`UPDATE retrain_items SET step = 10 WHERE id = $1`, [i1]), '23514'));
                    // 項目的來源只能是新題派題（source_purpose 固定 new）
                    await sp(() => reject(client.query(`UPDATE retrain_items SET source_purpose = 'retrain' WHERE id = $1`, [i1]), '23514'));

                    // assignments_retrain_link_check：重練派題兩欄必填、新題派題兩欄必空
                    await sp(() => reject(client.query(
                        `INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'retrain')`, [fx.s, fx.q1]),
                    '23514', 'assignments_retrain_link_check'));
                    await sp(() => reject(client.query(
                        `INSERT INTO assignments (student_id, question_id, purpose, retrain_item_id, retrain_step) VALUES ($1, $2, 'new', $3, 1)`,
                        [fx.t, fx.q2, i1]), '23514', 'assignments_retrain_link_check'));
                    // I1 前半：重練派題 → 同生同題的項目
                    await sp(() => reject(client.query(
                        `INSERT INTO assignments (student_id, question_id, purpose, retrain_item_id, retrain_step) VALUES ($1, $2, 'retrain', $3, 1)`,
                        [fx.s, fx.q2, i1]), '23503', 'assignments_retrain_item_fk'));
                    const { rows: [r1] } = await client.query(
                        `INSERT INTO assignments (student_id, question_id, purpose, retrain_item_id, retrain_step) VALUES ($1, $2, 'retrain', $3, 1) RETURNING id`,
                        [fx.s, fx.q1, i1]);
                    await client.query('INSERT INTO attempt_records (assignment_id, result) VALUES ($1, 1)', [r1.id]);
                    const { rows: v } = await client.query(
                        `SELECT purpose, retrain_item_id, retrain_step, result FROM assignment_attempts WHERE question_id = $1 AND student_id = $2
                          ORDER BY assignment_id`, [fx.q1, fx.s]);
                    assert.deepEqual(v.map(x => [x.purpose, x.retrain_item_id === null ? null : Number(x.retrain_item_id), x.retrain_step, x.result]),
                        [['new', null, null, null], ['retrain', i1, 1, 1]]);
                    // 有項目的新題派題、有重練派題的項目都刪不掉（NO ACTION，逐句檢查）；題目是 RESTRICT
                    await sp(() => reject(client.query('DELETE FROM assignments WHERE id = $1', [fx.a1]), '23503', 'retrain_items_source_fk'));
                    await sp(() => reject(client.query('DELETE FROM retrain_items WHERE id = $1', [i1]), '23503', 'assignments_retrain_item_fk'));
                    await sp(() => reject(client.query('DELETE FROM questions WHERE id = $1', [fx.q2]), '23503'));
                    // 延後到 COMMIT 檢查：合併學生要同時改派題與項目的 student_id（第 3.4 節）
                    const i2 = await item(fx.s, fx.q2, fx.a2);
                    const { rows: [r2] } = await client.query(
                        `INSERT INTO assignments (student_id, question_id, purpose, retrain_item_id, retrain_step) VALUES ($1, $2, 'retrain', $3, 1) RETURNING id`,
                        [fx.s, fx.q2, i2]);
                    // 不延後：改任何一邊都立刻被擋
                    await sp(() => reject(client.query('UPDATE retrain_items SET student_id = $2 WHERE id = $1', [i2, fx.t]), '23503'));
                    // 延後：兩邊都改完才檢查 → 通過
                    await client.query('SAVEPOINT d');
                    await client.query('SET CONSTRAINTS assignments_retrain_item_fk, retrain_items_source_fk DEFERRED');
                    await client.query('UPDATE retrain_items SET student_id = $2 WHERE id = $1', [i2, fx.t]);
                    await client.query('UPDATE assignments SET student_id = $2 WHERE id = ANY($1::bigint[])', [[fx.a2, r2.id], fx.t]);
                    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
                    await client.query('ROLLBACK TO SAVEPOINT d');
                    // 延後但只改了一半 → 檢查時擋下
                    await client.query('SAVEPOINT e');
                    await client.query('SET CONSTRAINTS assignments_retrain_item_fk, retrain_items_source_fk DEFERRED');
                    await client.query('UPDATE retrain_items SET student_id = $2 WHERE id = $1', [i2, fx.t]);
                    await reject(client.query('SET CONSTRAINTS ALL IMMEDIATE'), '23503');
                    await client.query('ROLLBACK TO SAVEPOINT e');
                } finally {
                    await client.query('ROLLBACK');
                }

                // 再套一次 0017：no-op
                const beforeCons = [...(await constraints(client, S, 'assignments')).keys(), ...(await constraints(client, S, 'retrain_items')).keys()];
                const beforeIdx = await indexes(client, S);
                await applySql(client, M2_SQL);
                await applySql(client, M2_SQL);
                assert.deepEqual([...(await constraints(client, S, 'assignments')).keys(), ...(await constraints(client, S, 'retrain_items')).keys()],
                    beforeCons);
                assert.deepEqual(await indexes(client, S), beforeIdx);
                assert.deepEqual((await columns(client, S, 'assignment_attempts')).length, 15);
            });
        });

        test('有資料的 0016 庫：套 0017 不動既有派題；已有沒項目的重練派題時 RAISE、整支回滾', async () => {
            const S = 'm2retrain_data';
            await withScratchSchema(S, async client => {
                await applyFiles(client, ALL.filter(f => f < M2));
                const fx = await seedBasics(client);
                await client.query(`INSERT INTO attempt_records (assignment_id, result) VALUES ($1, 0), ($2, 1)`, [fx.a1, fx.a2]);
                // 第一階段只有資料層、沒有 API 會寫重練派題；手動寫一筆
                await client.query(`INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'retrain')`, [fx.s, fx.q1]);
                await assert.rejects(applySql(client, M2_SQL), /0017 排程項目：assignments 已有 1 筆重練派題/);
                const { rows: [r] } = await client.query(`SELECT to_regclass('${S}.retrain_items') AS t`);
                assert.equal(r.t, null, '整支回滾：retrain_items 沒建');
                assert.ok(!(await columns(client, S, 'assignments')).includes('retrain_item_id'));

                await client.query(`DELETE FROM assignments WHERE purpose = 'retrain'`);
                const snap = async () => (await client.query(
                    `SELECT id, student_id, question_id, paper_id, assigned_at::text, purpose FROM assignments ORDER BY id`)).rows;
                const before = await snap();
                const firstBefore = (await client.query('SELECT * FROM attempts ORDER BY id')).rows;
                await applySql(client, M2_SQL);
                assert.deepEqual(await snap(), before);
                assert.deepEqual((await client.query('SELECT * FROM attempts ORDER BY id')).rows, firstBefore, '相容檢視 attempts 內容不變');
                const { rows: [n] } = await client.query('SELECT COUNT(*)::int AS n FROM retrain_items');
                assert.equal(n.n, 0, '不補建（R11 選 3）');
            });
        });
    });
}
