// ─────────────────────────────────────────────────────────────
// test/integration/schema.test.js — migrations 從零套用後的結構驗收
//
// 前置：npm run migrate:test（CI 的 integration job 會先跑）。
// 環境：只讀 TEST_DATABASE_URL，且資料庫名必須以 _test 結尾——否則直接拒跑。
//       本檔會 TRUNCATE，打到真題庫的代價是不可逆的（規劃 §5.3.4 的 DB 防呆）。
//
// 測的是「pgvector/pgvector:pg16 這個映像上，0001+0002 真的能從零套起來，
// 而且套出來的結構就是 interfaces 第 1 條寫的那個」。這些在單元層完全測不到：
// 中文 CHECK 值在 Linux 上的編碼、vector(768) 的維度、HNSW 索引建不建得起來、
// 新題派題（assignments）的唯一索引擋不擋得住重複指派，都只有真 PG 會告訴你。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const URL = process.env.TEST_DATABASE_URL;
const SKIP = !URL;

if (SKIP) {
    console.log('⏭️  未設 TEST_DATABASE_URL，跳過整合測試（CI 的 integration job 會設）。');
} else if (!/_test(\?|$)/.test(URL)) {
    throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾；整合測試絕不能打到真題庫。');
}

let client;

describe('migrations 套用結果', { skip: SKIP }, () => {
    before(async () => {
        client = new Client({ connectionString: URL });
        await client.connect();
    });
    after(async () => { if (client) await client.end(); });

    test('0001 與 0002 都已套用（schema_migrations 有紀錄）', async () => {
        const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
        const versions = rows.map(r => r.version);
        assert.ok(versions.includes('0001_init.sql'), `schema_migrations：${versions.join(', ')}`);
        assert.ok(versions.includes('0002_vector.sql'), `schema_migrations：${versions.join(', ')}`);
    });

    // 〔Owner 決策單 2026-09-25 B22；DEC-003 例外條款〕依 Owner 決策改變的行為（docs/retrain-and-review.md 第 6.4 節）：
    // migrations/0016 把 attempts 拆成 assignments（派題）＋attempt_records（作答），attempts 改成唯讀相容檢視。
    // 原本驗「attempts 是實體表」，改驗兩張新實體表＋attempts 是檢視（斷言變多，沒有放寬）。
    test('四張表都在（attempts 拆成派題與作答兩張表＋相容檢視）', async () => {
        const { rows } = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        const names = rows.map(r => r.table_name);
        for (const t of ['questions', 'students', 'exam_papers', 'assignments', 'attempt_records']) {
            assert.ok(names.includes(t), `缺少資料表 ${t}；實際有：${names.join(', ')}`);
        }
        assert.ok(!names.includes('attempts'), 'attempts 應該是檢視，不是實體表');
        const { rows: views } = await client.query(
            `SELECT table_name FROM information_schema.views
              WHERE table_schema = 'public' AND table_name IN ('attempts', 'assignment_attempts')
              ORDER BY table_name`);
        assert.deepEqual(views.map(v => v.table_name), ['assignment_attempts', 'attempts']);
    });

    test('embedding 是 vector(768)——EMBED_DIM 釘死 768（interfaces 裁決 4）', async () => {
        const { rows } = await client.query(
            `SELECT format_type(a.atttypid, a.atttypmod) AS t
             FROM pg_attribute a
             WHERE a.attrelid = 'questions'::regclass AND a.attname = 'embedding'`
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].t, 'vector(768)');
    });

    test('0002 的八個檢索欄位都在', async () => {
        const { rows } = await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'questions'`
        );
        const cols = rows.map(r => r.column_name);
        for (const c of ['concept_summary', 'keywords', 'embed_text', 'embed_hash',
            'embedding', 'embedding_model', 'embedded_at', 'search_tsv']) {
            assert.ok(cols.includes(c), `questions 缺少欄位 ${c}`);
        }
    });

    test('HNSW / GIN / trgm 三個檢索索引都建起來了', async () => {
        const { rows } = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'questions'`);
        const idx = rows.map(r => r.indexname);
        for (const i of ['idx_questions_embedding', 'idx_questions_tsv', 'idx_questions_text_trgm']) {
            assert.ok(idx.includes(i), `缺少索引 ${i}；實際有：${idx.join(', ')}`);
        }
    });

    test('中文 CHECK 值在 Linux 上仍然正確（編碼沒被吃掉）', async () => {
        // cmd 下 psql 的 client encoding 不是 UTF-8 是已知的坑（規劃 §2.9），
        // 這條在 CI 的 Linux 容器上早期驗證：寫得進「數學」就代表編碼是通的。
        await client.query('BEGIN');
        try {
            await client.query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ('數學', '向量內積', '計算', 3, '編碼檢查', '通過')`
            );
            const { rows } = await client.query(`SELECT subject, chapter FROM questions WHERE question_text = '編碼檢查'`);
            assert.equal(rows[0].subject, '數學');
            assert.equal(rows[0].chapter, '向量內積');

            await assert.rejects(
                client.query(
                    `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                     VALUES ('生物', '細胞', '計算', 3, 'x', 'y')`
                ),
                /violates check constraint/i,
                'subject 的 CHECK 應該擋掉白名單外的科目（「生物」；化學自 0011 起合法）'
            );
        } finally {
            await client.query('ROLLBACK');
        }
    });

    // 〔Owner 決策單 2026-09-25 B22；DEC-003 例外條款〕依 Owner 決策改變的行為（docs/retrain-and-review.md 第 6.4 節）：
    // 「不重複出題」的硬閘門從 attempts 的 UNIQUE (student_id, question_id) 搬到 assignments 的部分唯一索引
    // assignments_first_exposure_key（只管 purpose = 'new'）。同一件事（第二次以新題派同一題會被擋）照驗；
    // 另加 Owner 核准的例外：重練派題（purpose = 'retrain'）可以重複，且每次作答各自一列。
    test('新題派題的部分唯一索引擋得住重複指派；重練派題可重複（DEC-003 例外條款）', async () => {
        await client.query('BEGIN');
        try {
            // students.name 有 UNIQUE 約束，而同一顆測試庫上還有別的整合測試檔
            // （hybrid.pg.test.js 也建一個叫「整合測試學生」的學生，且不在交易裡）。
            // 用同一個名字直接 INSERT 會**先死在 students_name_key 上**，
            // 於是這一題真正要驗的唯一約束根本沒測到，
            // 而失敗訊息指向另一個約束，看起來像 DDL 寫錯。
            // 兩層保險：名字帶檔名前綴不與別人共用，再加 ON CONFLICT 讓重跑也不受影響。
            const s = await client.query(
                `INSERT INTO students (name) VALUES ('schema.test-約束檢查學生')
                 ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`
            );
            const q = await client.query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ('物理', '直線運動', '計算', 2, '約束檢查', '通過') RETURNING id`
            );
            const sid = s.rows[0].id, qid = q.rows[0].id;
            await client.query('INSERT INTO assignments (student_id, question_id) VALUES ($1, $2)', [sid, qid]);
            await client.query('SAVEPOINT dup');
            await assert.rejects(
                client.query('INSERT INTO assignments (student_id, question_id) VALUES ($1, $2)', [sid, qid]),
                err => /duplicate key value/i.test(err.message) && err.constraint === 'assignments_first_exposure_key'
            );
            await client.query('ROLLBACK TO SAVEPOINT dup');
            // 明寫 purpose = 'new' 也一樣被擋
            await assert.rejects(
                client.query(`INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'new')`, [sid, qid]),
                /duplicate key value/i
            );
            await client.query('ROLLBACK TO SAVEPOINT dup');

            // 重練派題：同一題可以再派（兩次），每次作答各自一列
            const r1 = await client.query(
                `INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'retrain') RETURNING id`, [sid, qid]);
            const r2 = await client.query(
                `INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'retrain') RETURNING id`, [sid, qid]);
            await client.query('INSERT INTO attempt_records (assignment_id, result) VALUES ($1, 0), ($2, 1)',
                [r1.rows[0].id, r2.rows[0].id]);
            const { rows: all } = await client.query(
                'SELECT purpose, result FROM assignment_attempts WHERE student_id = $1 AND question_id = $2 ORDER BY assignment_id',
                [sid, qid]);
            assert.deepEqual(all.map(r => [r.purpose, r.result]), [['new', null], ['retrain', 0], ['retrain', 1]]);
            // 檢視 attempts 照舊每生每題一列（只含新題派題）
            const { rows: first } = await client.query(
                'SELECT COUNT(*)::int AS n FROM attempts WHERE student_id = $1 AND question_id = $2', [sid, qid]);
            assert.equal(first[0].n, 1);

            // purpose 只收 new／retrain
            await client.query('SAVEPOINT bad');
            await assert.rejects(
                client.query(`INSERT INTO assignments (student_id, question_id, purpose) VALUES ($1, $2, 'review')`, [sid, qid]),
                /violates check constraint/i
            );
            await client.query('ROLLBACK TO SAVEPOINT bad');
        } finally {
            await client.query('ROLLBACK');
        }
    });

    // 〔Owner 決策單 2026-09-25 B22；DEC-003 例外條款〕依 Owner 決策改變的行為（docs/retrain-and-review.md 第 6.4 節）：
    // 題目外鍵從 attempts 搬到 assignments；「作答紀錄不能隨題目消失」照驗（M2 的 retrain_items 之後再加）。
    test('assignments.question_id 是 ON DELETE RESTRICT（interfaces 裁決 1，不是 CASCADE）', async () => {
        // 作答紀錄是階段 3 弱點面板的基底，不能隨題目消失。刪題改走 archived_at 軟刪。
        const { rows } = await client.query(
            `SELECT confdeltype FROM pg_constraint
             WHERE conrelid = 'assignments'::regclass AND contype = 'f'
               AND confrelid = 'questions'::regclass`
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].confdeltype, 'r', 'confdeltype 應為 r（RESTRICT）');
        // 作答跟著派題走（派題刪掉，作答一起刪）
        const { rows: rec } = await client.query(
            `SELECT confdeltype FROM pg_constraint
             WHERE conrelid = 'attempt_records'::regclass AND contype = 'f'
               AND confrelid = 'assignments'::regclass`
        );
        assert.equal(rec.length, 1);
        assert.equal(rec[0].confdeltype, 'c', 'attempt_records → assignments 應為 c（CASCADE）');
    });

    test('兩個 VIEW 都在，且都帶 archived_at IS NULL（interfaces 裁決 7）', async () => {
        const { rows } = await client.query(
            `SELECT table_name, view_definition FROM information_schema.views
             WHERE table_schema = 'public' AND table_name IN ('questions_math', 'questions_physics')`
        );
        assert.equal(rows.length, 2, `只找到 ${rows.map(r => r.table_name).join(', ')}`);
        for (const v of rows) {
            assert.match(v.view_definition, /archived_at IS NULL/, `${v.table_name} 沒有排除已封存題`);
        }
    });

    test('0008：follows_question_id／follows_src 兩欄、具名約束、部分索引、FK 為 NO ACTION', async () => {
        const { rows: versions } = await client.query(`SELECT 1 FROM schema_migrations WHERE version = '0008_follow_up.sql'`);
        assert.equal(versions.length, 1, '0008_follow_up.sql 未套用');

        const { rows: cols } = await client.query(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns
              WHERE table_name = 'questions' AND column_name IN ('follows_question_id', 'follows_src')
              ORDER BY column_name`);
        assert.deepEqual(cols, [
            { column_name: 'follows_question_id', data_type: 'integer', is_nullable: 'YES' },
            { column_name: 'follows_src', data_type: 'text', is_nullable: 'YES' }
        ]);

        const { rows: cons } = await client.query(
            `SELECT conname FROM pg_constraint WHERE conrelid = 'questions'::regclass
               AND conname IN ('questions_follows_self_check', 'questions_follows_src_pair_check')
             ORDER BY conname`);
        assert.deepEqual(cons.map(c => c.conname), ['questions_follows_self_check', 'questions_follows_src_pair_check']);

        // 自我參照 FK：'a' = NO ACTION（句尾檢查，整組同句刪除與測試清表才不會失敗）
        const { rows: fk } = await client.query(
            `SELECT c.confdeltype FROM pg_constraint c
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
              WHERE c.conrelid = 'questions'::regclass AND c.contype = 'f' AND a.attname = 'follows_question_id'`);
        assert.equal(fk.length, 1);
        assert.equal(fk[0].confdeltype, 'a', 'confdeltype 應為 a（NO ACTION）');

        const { rows: idx } = await client.query(
            `SELECT indexdef FROM pg_indexes WHERE tablename = 'questions' AND indexname = 'idx_questions_follows'`);
        assert.equal(idx.length, 1, '缺少索引 idx_questions_follows');
        assert.match(idx[0].indexdef, /WHERE \(follows_question_id IS NOT NULL\)/);

        await client.query('BEGIN');
        try {
            const { rows: q } = await client.query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ('數學', '向量內積', '計算', 3, 'schema 承上題約束前題', '略'),
                        ('數學', '向量內積', '計算', 3, 'schema 承上題約束子題', '略') RETURNING id`);
            const [a, b] = q.map(r => r.id);

            await client.query('SAVEPOINT s');
            await assert.rejects(
                client.query(`UPDATE questions SET follows_question_id = id, follows_src = 'human' WHERE id = $1`, [a]),
                /questions_follows_self_check/);
            await client.query('ROLLBACK TO SAVEPOINT s');
            await assert.rejects(
                client.query('UPDATE questions SET follows_question_id = $1 WHERE id = $2', [a, b]),
                /questions_follows_src_pair_check/);
            await client.query('ROLLBACK TO SAVEPOINT s');
            await assert.rejects(
                client.query(`UPDATE questions SET follows_question_id = $1, follows_src = 'ai' WHERE id = $2`, [a, b]),
                /violates check constraint/);
            await client.query('ROLLBACK TO SAVEPOINT s');

            await client.query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [a, b]);
            await client.query('SAVEPOINT s2');
            await assert.rejects(client.query('DELETE FROM questions WHERE id = $1', [a]), /foreign key/i,
                '只刪前題、留下子題要被擋');
            await client.query('ROLLBACK TO SAVEPOINT s2');
            const del = await client.query('DELETE FROM questions WHERE id = ANY($1::int[])', [[a, b]]);
            assert.equal(del.rowCount, 2, 'NO ACTION：同一句刪整組要成功');
        } finally {
            await client.query('ROLLBACK');
        }
    });

    test('pgvector 的距離運算子可用（<=> 餘弦距離）', async () => {
        const { rows } = await client.query(`SELECT ('[1,0,0]'::vector <=> '[1,0,0]'::vector) AS d`);
        assert.ok(Math.abs(Number(rows[0].d)) < 1e-9);
    });

    test('to_tsvector(simple) + GIN 走得通（中文分詞在應用層，PG 只存 token）', async () => {
        const { rows } = await client.query(
            `SELECT to_tsvector('simple', array_to_string($1::text[], ' ')) @@ to_tsquery('simple', $2) AS hit`,
            [['向量', '內積', '計算'], `'向量' | '外積'`]
        );
        assert.equal(rows[0].hit, true);
    });
});
