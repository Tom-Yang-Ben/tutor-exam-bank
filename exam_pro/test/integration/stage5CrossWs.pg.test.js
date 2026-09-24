// ─────────────────────────────────────────────────────────────
// stage5CrossWs.pg.test.js — 階段 5 的跨 WS 整合測試（整合階段補測；docs/interfaces-stage5.md 第 7、8 條）
//
// 各 WS 的測試依第 7 條只用數學與物理的 fixture（化學在它們的分支還沒併入白名單），
// 「化學題標知識點、補救卷、家教」這些跨 WS 的化學行為由這一支補上。走真的 HTTP 路徑、真的種子檔：
//
//   1. WS-C 的載入核心（kcService.loadSeeds）把 repo 的 config/kc/{數學,物理,化學}.json 載入：
//      數量、只有 4 條 approved、先備全部解析、沒有環、再載一次冪等。
//   2. 手動新增化學題（\ce＋詳解）→ PUT /api/questions/:id/kcs（WS-C）→ GET /api/kc?subject=化學 的 question_count。
//   3. 化學學生：組卷（dry_run）→ 確認 → 批改（chem_equation，WS-A）→ 弱點面板的 by_error_type；數學題標 chem_equation → 400。
//   4. FEATURE_REMEDIAL（WS-D）：覆蓋率列出化學 44 章；化學補救卷草稿的形狀與排除規則（已作答、封存、他科）。
//   5. FEATURE_TUTOR（WS-E，LLM_MODE=replay＋暫存 cassette，同 tutor.pg.test.js）：化學題的 prompt 帶
//      該題化學知識點的口語版、錯因「化學式或係數」，不帶學生姓名。
//   6. Word 詳解版（WS-A × WS-B）：含 \ce 的化學詳解能產生 docx，\ce 轉成 Word 方程式；verify 來源加註。
//
// 案例之間**刻意共用狀態**（一條鏈）：第 1 條載入的知識點、第 2 條新增的化學題，後面每一條都要用。
// 前一條失敗時後面跟著失敗是預期的，先看第一個紅燈。
//
// 三道防線同其他 *.pg.test.js：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、require config/db 前先覆寫 DATABASE_URL。
// 結束時清掉本檔寫入的表（尤其是 637 個知識點），不留給後面的測試檔。題幹全為自製內容。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('階段 5 跨 WS 整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    // ── 旗標與環境：routes/index.js 在 require 當下讀，所以全部設好才 require app ──
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;
    process.env.JOB_RUNNER = 'off';
    process.env.FEATURE_STUDENTS = 'true';
    process.env.FEATURE_KC = 'true';
    process.env.FEATURE_REMEDIAL = 'true';
    process.env.FEATURE_TUTOR = 'true';
    process.env.TUTOR_RATE_LIMIT_PER_MIN = '1000';
    process.env.WEAKNESS_MIN_N = '5';                        // kc 基底門檻：釘成預設值，不受開發機 .env 影響
    delete process.env.TUTOR_DAILY_BUDGET_USD;
    process.env.LLM_MODE = 'replay';                         // 家教走 replay，cassette 只讀本檔的暫存目錄
    const CASSETTE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-stage5-cross-cassette-'));
    process.env.EVAL_CASSETTE_DIR = CASSETTE_DIR;

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const kcService = require(path.join(APP_DIR, 'services', 'kcService'));
    const tutorService = require(path.join(APP_DIR, 'services', 'tutorService'));
    const cassette = require(path.join(APP_DIR, 'services', 'llm', 'cassette'));
    const wordService = require(path.join(APP_DIR, 'services', 'wordService'));
    const { CHAPTERS } = require(path.join(APP_DIR, 'config', 'chapters'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));

    const SEED_DIR = path.join(APP_DIR, 'config', 'kc');
    const SUBJECT_FILES = ['數學', '物理', '化學'];
    const readSeed = s => JSON.parse(fs.readFileSync(path.join(SEED_DIR, `${s}.json`), 'utf8'));

    const CH_A = '化學式與化學反應式';
    const CH_B = '化學計量';
    const KC_A3 = `CHEM.${CH_A}.03`;                         // 化學反應式的意義與書寫
    const KC_A4 = `CHEM.${CH_A}.04`;                         // 反應式係數的平衡方法
    const STUDENT_NAME = '跨科整合測試生丙';

    /** 案例之間共用的狀態（見檔頭） */
    const S = {
        kcIdByCode: new Map(),
        spokenByCode: new Map(),
        chemQ: null,             // 第 2 條手動新增的化學題
        studentId: null,
        paperId: null,
        attempted: [],           // 該生寫過的題
        aIds: [],                // A 章（化學式與化學反應式）的 6 題，[0] 是第 2 條那一題
        archived: null,
        mathQ: null
    };

    async function count(table) {
        return (await query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
    }

    /** 直接插一題（fixture 用；手動新增的那一題走 POST /api/questions） */
    async function insertQ({ subject = '化學', chapter = CH_A, difficulty = 2, type = '填空', text, answer = '略', solution = null, src = null, archived = false }) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text,
                                    solution_text, solution_src, archived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END) RETURNING id`,
            [subject, chapter, type, difficulty, text, answer, solution, src, archived]);
        return r.id;
    }

    async function putKcs(questionId, items) {
        return request(app).put(`/api/questions/${questionId}/kcs`).send({ items });
    }

    const kcId = code => {
        const id = S.kcIdByCode.get(code);
        assert.ok(Number.isInteger(id), `找不到知識點 ${code}`);
        return id;
    };

    async function waitForIdleBackends(timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        for (; ;) {
            const { rows } = await query(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`);
            if (rows[0].n === 0 || Date.now() >= deadline) return;
            await new Promise(r => setTimeout(r, 20));
        }
    }

    /** 入庫後 fire-and-forget 的補向量可能與 TRUNCATE 搶鎖（同 jobs.pg.test.js）：死結就退避重試 */
    async function truncateAll(attempts = 10) {
        await waitForIdleBackends();
        for (let i = 1; ; i++) {
            try {
                await query(`TRUNCATE question_kcs, kc_prerequisites, knowledge_components,
                                      attempts, exam_papers, students, questions RESTART IDENTITY CASCADE`);
                return;
            } catch (err) {
                if ((err.code !== '40P01' && err.code !== '55P03') || i >= attempts) throw err;
                await new Promise(r => setTimeout(r, 50 * i));
                await waitForIdleBackends();
            }
        }
    }

    const binary = req => req.buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    // ═════════════════════════ 測試本體 ═════════════════════════

    describe('階段 5 跨 WS：化學 × 知識點 × 批改 × 補救卷 × 家教 × Word', () => {
        before(async () => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
            await truncateAll();
        });

        after(async () => {
            await truncateAll();
            await pool.end();
            fs.rmSync(CASSETTE_DIR, { recursive: true, force: true });
        });

        // ───────── 1. 真的種子檔 ─────────

        test('1. 三份真的種子檔經 loadSeeds 載入：數量、只有 4 條 approved、先備全部解析、無環；再載一次冪等', async () => {
            const seeds = SUBJECT_FILES.map(readSeed);
            const total = seeds.reduce((n, s) => n + s.components.length, 0);
            const edgesInFiles = new Set(seeds.flatMap(s => s.components.flatMap(c => (c.prereqs || []).map(p => `${c.code}>${p}`))));

            const r1 = await kcService.loadSeeds({ pool, query }, seeds);
            assert.equal(r1.ok, true, (r1.errors || []).join('\n'));
            assert.deepEqual(r1.counts, {
                inserted: total, updated: 0, unchanged: 0, protected: 0,
                prereqInserted: edgesInFiles.size, prereqRemoved: 0, orphans: 0
            });

            // 數量：每科等於檔案內 components 數
            const { rows: bySubject } = await query(
                'SELECT subject, COUNT(*)::int AS n FROM knowledge_components GROUP BY subject ORDER BY subject');
            assert.deepEqual(Object.fromEntries(bySubject.map(r => [r.subject, r.n])),
                Object.fromEntries(seeds.map(s => [s.subject, s.components.length])));

            // approved 只有 4 條，全在數學「向量內積」（第 3.5 條逐字核可的那 4 條）
            const { rows: approved } = await query(
                `SELECT code, subject, chapter FROM knowledge_components WHERE status = 'approved' ORDER BY code`);
            assert.equal(approved.length, 4, JSON.stringify(approved));
            assert.ok(approved.every(r => r.subject === '數學' && r.chapter === '向量內積'), JSON.stringify(approved));

            // 先備全部解析：DB 的邊與三份檔的邊一模一樣（跨科的也在），且都是 src='ai'
            const { rows: edges } = await query(
                `SELECT k.code AS kc, p.code AS pre, e.src, e.kc_id, e.prereq_kc_id
                   FROM kc_prerequisites e
                   JOIN knowledge_components k ON k.id = e.kc_id
                   JOIN knowledge_components p ON p.id = e.prereq_kc_id`);
            assert.deepEqual(new Set(edges.map(e => `${e.kc}>${e.pre}`)), edgesInFiles);
            assert.ok(edges.every(e => e.src === 'ai'));
            // 無環（loadSeeds 在交易內檢查過；這裡對 DB 全部的邊再驗一次）
            assert.equal(kcService.findCycle(edges.map(e => [e.kc_id, e.prereq_kc_id])), null);

            // 再載一次：全部「內容相同」，一列都不動
            const r2 = await kcService.loadSeeds({ pool, query }, SUBJECT_FILES.map(readSeed));
            assert.equal(r2.ok, true, (r2.errors || []).join('\n'));
            assert.deepEqual(r2.counts, {
                inserted: 0, updated: 0, unchanged: total, protected: 0,
                prereqInserted: 0, prereqRemoved: 0, orphans: 0
            });
            assert.equal(await count('knowledge_components'), total);
            assert.equal(await count('kc_prerequisites'), edgesInFiles.size);

            const { rows: all } = await query('SELECT id, code, spoken_text FROM knowledge_components');
            for (const r of all) {
                S.kcIdByCode.set(r.code, r.id);
                S.spokenByCode.set(r.code, r.spoken_text);
            }
        });

        // ───────── 2. 化學題標知識點 ─────────

        test('2. 手動新增含 \\ce 與詳解的化學題 → PUT 標化學知識點 → GET /api/kc?subject=化學 的 question_count', async () => {
            const created = await request(app).post('/api/questions').send({
                subject: '化學', chapter: CH_A, question_type: '計算', difficulty: 2,
                question_text: '自製跨科整合化學題：配平 $\\ce{H2 + O2 -> H2O}$，並說明為什麼不能把 $\\ce{H2O}$ 改寫成 $\\ce{H2O2}$。',
                answer_text: '$\\ce{2H2 + O2 -> 2H2O}$',
                solution_text: '氫原子左 2 右 2、氧原子左 2 右 1：先把 $\\ce{H2O}$ 的係數改成 2，再把 $\\ce{H2}$ 改成 2，得 $\\ce{2H2 + O2 -> 2H2O}$。改下標會變成另一種物質（過氧化氫）。'
            });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            S.chemQ = created.body.questionId;
            const { rows: [q] } = await query('SELECT subject, solution_src FROM questions WHERE id = $1', [S.chemQ]);
            assert.deepEqual(q, { subject: '化學', solution_src: 'teacher' });

            // 知識點必須同科：數學知識點標在化學題上 → 400，而且不寫任何一列
            const wrong = await putKcs(S.chemQ, [{ kc_id: kcId('MATH.向量內積.02') }]);
            assert.equal(wrong.status, 400);
            assert.match(wrong.body.message, /知識點必須與題目同科/);
            assert.equal(await count('question_kcs'), 0);

            const put = await putKcs(S.chemQ, [{ kc_id: kcId(KC_A3), weight: 1 }, { kc_id: kcId(KC_A4), weight: 0.5 }]);
            assert.equal(put.status, 200, JSON.stringify(put.body));
            assert.deepEqual(put.body.map(r => [r.code, r.weight, r.src]).sort(),
                [[KC_A3, 1, 'human'], [KC_A4, 0.5, 'human']]);

            const list = await request(app).get('/api/kc?subject=化學');
            assert.equal(list.status, 200);
            assert.equal(list.body.items.length, readSeed('化學').components.length);
            assert.ok(list.body.items.every(k => k.subject === '化學'));
            const counted = list.body.items.filter(k => k.question_count > 0).map(k => [k.code, k.question_count]).sort();
            assert.deepEqual(counted, [[KC_A3, 1], [KC_A4, 1]]);
            // 依白名單章節順序：第一章（必修化學第一章）排最前
            assert.equal(list.body.items[0].chapter, CHAPTERS['化學'][0]);
        });

        // ───────── 3. 化學學生：組卷 → 確認 → 批改 → 錯因分布 ─────────

        test('3. 化學學生：組卷確認 → 批改（chem_equation）→ by_error_type 有 chem_equation；數學題標 chem_equation → 400', async () => {
            // 題庫：A 章 6 題（含第 2 條那題）、B 章 3 題、一題已封存的 A 章題、一題數學題；A、B 章都標上知識點
            const aIds = [S.chemQ];
            for (let i = 1; i <= 5; i++) aIds.push(await insertQ({ text: `自製跨科化學 A${i}：寫出反應式 $\\ce{C + O2 -> CO2}$ 的係數。`, difficulty: 2 }));
            S.aIds = aIds;
            const bKc = [...S.kcIdByCode.keys()].filter(c => c.startsWith(`CHEM.${CH_B}.`)).sort()[0];
            assert.ok(bKc, `${CH_B} 應有知識點`);
            const bIds = [];
            for (let i = 1; i <= 3; i++) bIds.push(await insertQ({ chapter: CH_B, text: `自製跨科化學 B${i}：$0.5$ mol 的 $\\ce{CO2}$ 質量為何？`, difficulty: 2 }));
            S.archived = await insertQ({ text: '自製跨科化學（已封存）：平衡 $\\ce{Fe + O2 -> Fe2O3}$。', archived: true });
            for (const id of [...aIds.slice(1), S.archived]) assert.equal((await putKcs(id, [{ kc_id: kcId(KC_A3) }])).status, 200);
            for (const id of bIds) assert.equal((await putKcs(id, [{ kc_id: kcId(bKc) }])).status, 200);
            S.mathQ = await insertQ({ subject: '數學', chapter: '向量內積', text: '自製跨科數學題：求 $(1,2)\\cdot(3,4)$。', answer: '11' });

            const st = await request(app).post('/api/students').send({ name: STUDENT_NAME });
            assert.equal(st.status, 201, JSON.stringify(st.body));
            S.studentId = st.body.id;

            // 組卷（預覽不寫庫）→ 確認
            const preview = await request(app).post('/api/generate-paper')
                .send({ student_id: S.studentId, subject: '化學', chapter: CH_B, count: 2, dry_run: true });
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            assert.equal(preview.body.question_ids.length, 2);
            assert.ok(preview.body.question_ids.every(id => bIds.includes(id)), '只抽得到 B 章、未封存的化學題');
            assert.equal(await count('attempts'), 0, 'dry_run 不寫 attempts');

            const picked = [aIds[0], aIds[1], aIds[2], aIds[3], ...preview.body.question_ids];
            const confirmed = await request(app).post('/api/confirm-paper').send({ student_id: S.studentId, question_ids: picked });
            assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
            S.paperId = confirmed.body.paper_id;
            S.attempted = [...picked];

            // 批改：A0 錯（chem_equation）、A1 錯（calc）、A2 對、A3 錯（沒標錯因）、B 兩題對
            const results = [
                { question_id: aIds[0], result: 0, error_types: ['chem_equation'], response: '$\\ce{H2 + O2 -> H2O2}$', note: '改了下標' },
                { question_id: aIds[1], result: 0, error_types: ['calc'] },
                { question_id: aIds[2], result: 1 },
                { question_id: aIds[3], result: 0 },
                ...preview.body.question_ids.map(id => ({ question_id: id, result: 1 }))
            ];
            const graded = await request(app).patch(`/api/papers/${S.paperId}/results`).send({ results });
            assert.equal(graded.status, 200, JSON.stringify(graded.body));

            const weak = await request(app).get(`/api/students/${S.studentId}/weakness?subject=化學&days=365`);
            assert.equal(weak.status, 200);
            // 分母＝窗內錯題數 3；count DESC、error_type ASC
            assert.deepEqual(weak.body.by_error_type, [
                { error_type: 'calc', label: '計算錯誤', count: 1, share: 0.3333 },
                { error_type: 'chem_equation', label: '化學式或係數', count: 1, share: 0.3333 }
            ]);
            const rw = weak.body.recent_wrong.find(r => r.question_id === aIds[0]);
            assert.deepEqual(rw && rw.error_types, ['chem_equation']);

            // 數學題標 chem_equation → 400，整批不寫
            const mathPaper = await request(app).post('/api/confirm-paper').send({ student_id: S.studentId, question_ids: [S.mathQ] });
            assert.equal(mathPaper.status, 200, JSON.stringify(mathPaper.body));
            S.attempted.push(S.mathQ);
            const bad = await request(app).patch(`/api/papers/${mathPaper.body.paper_id}/results`)
                .send({ results: [{ question_id: S.mathQ, result: 0, error_types: ['chem_equation'] }] });
            assert.equal(bad.status, 400);
            assert.deepEqual(bad.body, { message: `題目 ${S.mathQ} 是數學題，不能標記「化學式或係數」（chem_equation）。` });
            const { rows: [m] } = await query('SELECT result, error_types FROM attempts WHERE student_id = $1 AND question_id = $2', [S.studentId, S.mathQ]);
            assert.deepEqual(m, { result: null, error_types: [] });
        });

        // ───────── 4. 覆蓋率與補救卷（FEATURE_REMEDIAL）─────────

        test('4a. GET /api/coverage?subject=化學：化學 44 章依白名單順序全列，題數與知識點題數對得上', async () => {
            const res = await request(app).get(`/api/coverage?subject=化學&student_id=${S.studentId}`);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.rows.length, 44);
            assert.deepEqual(res.body.rows.map(r => r.chapter), CHAPTERS['化學']);
            assert.ok(res.body.rows.every(r => r.subject === '化學'));
            const byCh = Object.fromEntries(res.body.rows.map(r => [r.chapter, r]));
            assert.equal(byCh[CH_A].total, 6, '封存題不算');
            assert.equal(byCh[CH_A].unseen_by_student, 2, 'A 章 6 題寫過 4 題');
            assert.equal(byCh[CH_B].total, 3);
            assert.equal(byCh[CH_B].unseen_by_student, 1);
            assert.equal(byCh['緩衝溶液'].total, 0, '沒有題的章也要列（看見空洞）');
            assert.deepEqual(byCh[CH_A].by_difficulty, { 1: 0, 2: 6, 3: 0, 4: 0, 5: 0 });

            assert.equal(res.body.kc_rows.length, readSeed('化學').components.length);
            const kcTotal = Object.fromEntries(res.body.kc_rows.map(r => [r.code, r.total]));
            assert.equal(kcTotal[KC_A3], 6, 'A 章 6 題都掛了 .03（封存的那題不算）');
            assert.equal(kcTotal[KC_A4], 1);
        });

        test('4b. POST /api/students/:id/remedial-paper subject=化學：kc 基底草稿；排除已作答、封存、他科；不寫庫', async () => {
            const before = { attempts: await count('attempts'), papers: await count('exam_papers') };
            // total 20：remedial 桶要的題遠多於庫存，已作答與封存的題若沒被排除就一定會被抽進來
            const res = await request(app).post(`/api/students/${S.studentId}/remedial-paper`).send({ subject: '化學', total: 20 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const body = res.body;
            assert.deepEqual(Object.keys(body).sort(),
                ['basis', 'blueprint', 'items', 'notes', 'question_ids', 'shortfalls', 'student_id', 'subject']);
            assert.equal(body.student_id, S.studentId);
            assert.equal(body.subject, '化學');
            // 有標註的已批改題 6 ≥ WEAKNESS_MIN_N(5) → kc 基底（第 4.4 條第 2 點；知識點來自第 1 條載入的化學種子檔）
            assert.equal(body.basis, 'kc');
            assert.ok(Array.isArray(body.notes) && Array.isArray(body.shortfalls) && Array.isArray(body.blueprint));

            // 形狀：items 與 question_ids 是同一批題；bucket、target 合法
            assert.deepEqual([...body.items.map(i => i.question_id)].sort((a, b) => a - b),
                [...body.question_ids].sort((a, b) => a - b));
            assert.ok(body.question_ids.length >= 1, JSON.stringify(body));
            for (const it of body.items) {
                assert.ok(['remedial', 'prerequisite', 'extension'].includes(it.bucket), it.bucket);
                assert.equal(it.target.type, 'kc');
                assert.match(it.target.code, /^CHEM\./);
                for (const k of ['chapter', 'difficulty', 'question_text_preview']) assert.ok(k in it, k);
            }
            for (const row of body.blueprint) {
                assert.ok(Number.isInteger(row.wanted) && Number.isInteger(row.got) && row.got <= row.wanted, JSON.stringify(row));
            }
            // remedial 桶：.04（只掛在寫錯的那一題上，最弱）與 .03（4 題錯 3）。.03 的候選只剩 A 章沒寫過、沒封存的兩題；
            // 掛 .03 的另外 5 題（寫過 4 題＋封存 1 題）都要被排除。.04 唯一的一題已寫過 → 0 題、列入不足量。
            const rowOf = code => body.blueprint.find(b => b.bucket === 'remedial' && b.target.code === code);
            assert.ok(rowOf(KC_A3) && rowOf(KC_A4), JSON.stringify(body.blueprint));
            assert.ok(rowOf(KC_A3).wanted > 2, JSON.stringify(rowOf(KC_A3)));
            assert.equal(rowOf(KC_A3).got, 2);
            assert.equal(rowOf(KC_A4).got, 0);
            assert.deepEqual(body.items.filter(i => i.target.code === KC_A3).map(i => i.question_id).sort((a, b) => a - b),
                [S.aIds[4], S.aIds[5]]);
            assert.ok(body.shortfalls.some(f => f.target.code === KC_A3 && f.reason === 'insufficient_stock'), JSON.stringify(body.shortfalls));

            // 排除規則：化學、未封存、該生沒寫過
            const { rows } = await query('SELECT id, subject, archived_at FROM questions WHERE id = ANY($1::int[])', [body.question_ids]);
            assert.equal(rows.length, body.question_ids.length);
            for (const r of rows) {
                assert.equal(r.subject, '化學', `他科題 ${r.id} 不得入選`);
                assert.equal(r.archived_at, null, `封存題 ${r.id} 不得入選`);
                assert.ok(!S.attempted.includes(r.id), `已作答的題 ${r.id} 不得入選`);
            }
            assert.ok(!body.question_ids.includes(S.archived));
            assert.ok(!body.question_ids.includes(S.mathQ));

            // 只產草稿、不寫入
            assert.deepEqual({ attempts: await count('attempts'), papers: await count('exam_papers') }, before);
        });

        // ───────── 5. AI 家教（FEATURE_TUTOR；replay）─────────

        test('5. 對化學題問家教：prompt 帶該題化學知識點的口語版與錯因、不帶學生姓名；回覆換回姓名', async () => {
            const body = {
                message: `${STUDENT_NAME}說他把 H2O 改成 H2O2 來湊氧，錯在哪？`,
                mode: 'direct', student_id: S.studentId, question_id: S.chemQ
            };
            const parsed = tutorService.validateTutorInput(body);
            assert.ok(parsed.value, parsed.error);
            const prepared = await tutorService.prepareTutorRequest(parsed.value);

            const sent = prepared.llmOpts.system + JSON.stringify(prepared.llmOpts.parts) + JSON.stringify(prepared.llmOpts.cacheKeyParts);
            assert.ok(!sent.includes(STUDENT_NAME), '學生姓名出境了（DEC-009）');
            const prompt = prepared.llmOpts.parts[0].text;
            assert.ok(prompt.includes(`學生#${S.studentId}`));
            assert.ok(prompt.includes('這題標註的知識點'), '要用該題的標註，不是退回同章');
            for (const code of [KC_A3, KC_A4]) {
                assert.ok(prompt.includes(`（${code}）〔草稿`), `${code} 要標成草稿`);
                assert.ok(prompt.includes(`口語版：${S.spokenByCode.get(code).trim()}`), `${code} 的口語版沒有進 prompt`);
            }
            assert.ok(prompt.includes('科目：化學'));
            assert.ok(prompt.includes('\\ce{2H2 + O2 -> 2H2O}'), '標準答案（\\ce）原樣給模型');
            assert.ok(prompt.includes('詳解（來源：老師撰寫）'));
            assert.ok(prompt.includes('- 化學式或係數：1 次'), '學生摘要要有 WS-A 的錯因');

            // 以同一份 llmOpts 算鍵寫 cassette（同 tutor.pg.test.js），再打正式 API
            const key = cassette.cassetteKey({
                agent: prepared.llmOpts.agent, modelId: prepared.modelId, template: prepared.llmOpts.template,
                schema: undefined, cacheKeyParts: prepared.llmOpts.cacheKeyParts
            });
            cassette.writeCassette({
                agent: prepared.llmOpts.agent, key,
                meta: { agent: 'tutor', model: prepared.modelId, template: prepared.llmOpts.template, note: 'stage5CrossWs.pg.test.js 手寫' },
                request: { parts: cassette.summarizeParts(prepared.llmOpts.parts), cacheKeyParts: prepared.llmOpts.cacheKeyParts },
                response: {
                    text: `學生#${S.studentId} 改的是下標：$\\ce{H2O2}$ 是過氧化氫，平衡只能改係數。\n\n**驗算**：左右氫 4、氧 2，一致。`,
                    codeRuns: [{ language: 'PYTHON', code: 'print(2*2, 2)', outcome: 'OUTCOME_OK', output: '4 2\n' }],
                    usage: { tokenIn: 900, tokenOut: 200, tokenThinking: 0, tokenCached: 0 }
                }
            });
            const res = await request(app).post('/api/tutor').send(body);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.ok(res.body.reply.startsWith(`${STUDENT_NAME} 改的是下標`), res.body.reply);
            assert.deepEqual([...res.body.context.kc_codes].sort(), [KC_A3, KC_A4]);
            assert.equal(res.body.context.student_context, true);
            assert.equal(res.body.context.question_id, S.chemQ);
            assert.equal(res.body.verification.used, true);
        });

        // ───────── 6. Word 詳解版 ─────────

        test('6. Word 匯出 edition=solution：含 \\ce 的化學詳解產生 docx，\\ce 轉成方程式；verify 來源加註、老師的不加', async () => {
            const byVerify = await insertQ({
                text: '自製跨科化學（驗算詳解）：寫出甲烷完全燃燒的反應式。', type: '填空',
                answer: '$\\ce{CH4 + 2O2 -> CO2 + 2H2O}$',
                solution: '碳 1、氫 4 先配：$\\ce{CH4 -> CO2 + 2H2O}$，右邊氧 4 個，所以 $\\ce{O2}$ 係數 2。', src: 'verify'
            });
            const res = await binary(request(app).post('/api/download-word').send({
                paper_title: '跨科整合化學卷', student_name: STUDENT_NAME, question_ids: [S.chemQ, byVerify], edition: 'solution'
            }));
            assert.equal(res.status, 200, res.body && res.body.toString('utf8').slice(0, 200));
            assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0);
            assert.equal(res.body.subarray(0, 2).toString('latin1'), 'PK', 'docx 是 zip');
            const xml = documentXml(res.body);
            assert.ok(xml.includes('參考答案與詳解'));
            assert.ok(xml.includes('氫原子左 2 右 2'), '老師的詳解文字');
            assert.ok(xml.includes('右邊氧 4 個'), '驗算詳解文字');
            assert.ok(xml.includes('<m:oMath'), '\\ce 沒有轉成 Word 方程式');
            assert.ok(xml.includes('<m:t>→</m:t>'), '反應箭頭');
            assert.ok(!xml.includes('\\ce'), '\\ce 原始碼不該漏進文件');
            const note = wordService.UNREVIEWED_SOLUTION_NOTE;
            assert.equal(xml.split(note).length - 1, 1, '只有 verify 來源那一題加註');
            assert.ok(xml.indexOf('第 2 題答案：') < xml.indexOf(note));
        });
    });
}
