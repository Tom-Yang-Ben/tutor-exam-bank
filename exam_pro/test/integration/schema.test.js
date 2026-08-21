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
// attempts 的唯一約束擋不擋得住重複指派，都只有真 PG 會告訴你。
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

    test('四張表都在', async () => {
        const { rows } = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        const names = rows.map(r => r.table_name);
        for (const t of ['questions', 'students', 'exam_papers', 'attempts']) {
            assert.ok(names.includes(t), `缺少資料表 ${t}；實際有：${names.join(', ')}`);
        }
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
                     VALUES ('化學', '莫耳', '計算', 3, 'x', 'y')`
                ),
                /violates check constraint/i,
                'subject 的 CHECK 應該擋掉「化學」'
            );
        } finally {
            await client.query('ROLLBACK');
        }
    });

    test('attempts 的 UNIQUE(student_id, question_id) 擋得住重複指派', async () => {
        await client.query('BEGIN');
        try {
            // students.name 有 UNIQUE 約束，而同一顆測試庫上還有別的整合測試檔
            // （hybrid.pg.test.js 也建一個叫「整合測試學生」的學生，且不在交易裡）。
            // 用同一個名字直接 INSERT 會**先死在 students_name_key 上**，
            // 於是這一題真正要驗的 attempts 唯一約束根本沒測到，
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
            await client.query('INSERT INTO attempts (student_id, question_id) VALUES ($1, $2)', [s.rows[0].id, q.rows[0].id]);
            await assert.rejects(
                client.query('INSERT INTO attempts (student_id, question_id) VALUES ($1, $2)', [s.rows[0].id, q.rows[0].id]),
                /duplicate key value/i
            );
        } finally {
            await client.query('ROLLBACK');
        }
    });

    test('attempts.question_id 是 ON DELETE RESTRICT（interfaces 裁決 1，不是 CASCADE）', async () => {
        // 作答紀錄是階段 3 弱點面板的基底，不能隨題目消失。刪題改走 archived_at 軟刪。
        const { rows } = await client.query(
            `SELECT confdeltype FROM pg_constraint
             WHERE conrelid = 'attempts'::regclass AND contype = 'f'
               AND confrelid = 'questions'::regclass`
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].confdeltype, 'r', 'confdeltype 應為 r（RESTRICT）');
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
