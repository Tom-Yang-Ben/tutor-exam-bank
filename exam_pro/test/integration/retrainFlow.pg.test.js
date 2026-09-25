// ─────────────────────────────────────────────────────────────
// test/integration/retrainFlow.pg.test.js — 錯題重練第二階段的全流程（PR-2 排程核心＋PR-3 出卷整合＋PR-4 畫面與成效）
//
// docs/retrain-and-review.md 第 4.4～4.7、5.2～5.4、3.9 節；第 6.2 節 ACPT-037-1、037-3、037-4、038-1～038-4、039-1～039-5、
// 040-1、040-2。前面三個 PR 各自的整合測試（retrain.pg、retrainPaper.pg、retrainStats.pg）是一支 API 一支 API 驗；
// 這裡把它們串成老師實際會走的一條路，全程只經 HTTP（不直接呼叫 service、不直接寫派題），而且**請求的 body
// 由前端自己的程式產生**——這就是 PR-3（伺服器端）與 PR-4（前端，當時用 mock）接起來的地方：
//   - public/js/retrain.js 的 retrainPaperBody／draftFromResponse／confirmBody／removeGroup／wordDownloadRequest
//     （錯題重練卡：API-5 草稿 → API-7 確認 → API-12 下載）
//   - public/js/students.js 的 diffResults／retrainSaveMessage（批改卡：API-9 的 purpose／retrain_flagged → API-10 的
//     results[i].retrain 與 retrain 摘要）
//   - public/index.html 組卷頁〔retrain〕掛鉤的 retrainCapForAttach／retrainAttachRequest／retrainConfirmKeys
//     （附帶到新卷：API-6 → API-7）；抽法同 test/unit/retrainPaperUi.test.js
//
// 時間：排程只看 JS 的「今天」（retrainService.todayLocal、examController.localDates；本功能的 SQL 不用 CURRENT_DATE），
// 所以用 node:test 的 mock.timers 只假 Date、把時鐘撥到 2026-10-01 起的固定日子，照第 4.5 節的節奏一天一天往前走
// （setTimeout 等計時器不假，資料庫連線不受影響）。固定日期也讓 Word 逐位元比對不受 docx 內的時間戳影響。
// 全程不呼叫 LLM、不需要 cassette。學生姓名只出現在測試資料裡，不進 log。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('錯題重練全流程（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.API_KEY;

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');
    const PUBLIC_DIR = path.join(APP_DIR, 'public');

    /** 依旗標載入一份 app（新路由在載入當下決定掛不掛；擴充的既有端點每次請求即時讀旗標，見 withRetrain）。 */
    function loadApp(retrainOn) {
        const keys = ['FEATURE_STUDENTS', 'FEATURE_REMEDIAL', 'FEATURE_RETRAIN'];
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        process.env.FEATURE_STUDENTS = 'true';
        process.env.FEATURE_REMEDIAL = 'true';
        if (retrainOn) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        const app = require(APP_PATH);
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        return app;
    }
    const appOff = loadApp(false);
    const appOn = loadApp(true);

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const schedule = require(path.join(APP_DIR, 'services', 'retrainSchedule'));
    const { DEFAULT_ATTACH_RATIO } = require(path.join(APP_DIR, 'config', 'retrain'));
    const { documentXml } = require(path.join(APP_DIR, 'test', 'e2e', 'lib', 'docx'));

    const DISABLED = { message: 'retrain 需要開啟 FEATURE_RETRAIN。' };
    const CONFLICT = qid => `題目 ${qid} 的重練狀態已改變（可能已派到別張卷），請重新產生草稿。`;
    const num = (a, b) => a - b;

    // ─────────── 時鐘（只假 Date）───────────

    /** 把「今天」撥到 dateStr（本地時區上午 10 點）。 */
    function travel(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        mock.timers.setTime(new Date(y, m - 1, d, 10, 0, 0).getTime());
    }
    /** 卷名的日期（examController.localDates 的 titleDate：YYYY_M_D）。 */
    const titleDate = dateStr => dateStr.split('-').map(Number).join('_');

    /** 旗標狀態（擴充的既有端點每次請求即時讀 process.env.FEATURE_RETRAIN）。 */
    async function withRetrain(on, fn) {
        const saved = process.env.FEATURE_RETRAIN;
        if (on) process.env.FEATURE_RETRAIN = 'true'; else delete process.env.FEATURE_RETRAIN;
        try { return await fn(on ? appOn : appOff); } finally {
            if (saved === undefined) delete process.env.FEATURE_RETRAIN; else process.env.FEATURE_RETRAIN = saved;
        }
    }

    // ─────────── 前端的程式（請求的 body 由它們產生）───────────

    let seq = 0;
    /** 載入 public/js 的 ES module（同 test/unit/retrainUi.test.js：Node 裡沒有 document，自動掛載不會發生）。 */
    async function loadModule(name) {
        const src = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8') + `\n// retrainFlow instance ${++seq}\n`;
        return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
    }
    let retrainUi = null;     // public/js/retrain.js
    let studentsUi = null;    // public/js/students.js

    /**
     * 組卷頁〔retrain〕掛鉤（index.html inline script 的「開始」到「結束」）：抽法同 test/unit/retrainPaperUi.test.js，
     * 這裡只用它的純函式，DOM 只給「附上到期的重練題」勾選框與題數兩個節點（老師勾了、題數 attach）。
     * @param {{attach:number|null, ratio?:string}} p attach 為 null＝沒勾
     */
    function paperPageHooks({ attach, ratio = String(DEFAULT_ATTACH_RATIO) }) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        const begin = html.indexOf('// 〔retrain〕組卷頁掛鉤 開始');
        const end = html.indexOf('// 〔retrain〕組卷頁掛鉤 結束');
        assert.ok(begin > 0 && end > begin, 'index.html 找不到〔retrain〕組卷頁掛鉤的開始／結束標記');
        const featureOn = html.match(/function featureOn\(name\) \{[\s\S]*?\n {8}\}/)[0];
        const nodes = {
            retrainAttach: { checked: attach !== null },
            retrainAttachCount: { value: attach === null ? '' : String(attach) }
        };
        const metas = { 'meta[name="feature-retrain"]': { content: 'true' }, 'meta[name="retrain-attach-ratio"]': { content: ratio } };
        const document = {
            getElementById: id => nodes[id] || { value: '', addEventListener() { } },
            querySelector: sel => metas[sel] || null
        };
        return new Function('document', 'selectedStudent', 'apiFetch',
            `${featureOn}\n${html.slice(begin, end)}\nreturn { retrainCapForAttach, retrainAttachRatio, retrainAttachRequest, retrainConfirmKeys };`)(
            document, () => null, () => Promise.reject(new Error('本測試不經組卷頁讀到期數')));
    }

    /**
     * 批改卡進來時的狀態（students.js gradingForm 的 toRow，以及旗標開啟時新題多的 retrain 鍵＝retrain_flagged）。
     * gradingForm 沒有 export，這裡照它逐行寫；送出的 body 仍由 students.js 的 diffResults 產生。
     */
    function gradingRows(detail) {
        const rows = detail.questions.map(q => ({
            question_id: q.question_id,
            result: q.result ?? null,
            score: q.score ?? null,
            error_types: Array.isArray(q.error_types) ? [...q.error_types] : [],
            response: q.response ?? null,
            note: q.teacher_note ?? null
        }));
        detail.questions.forEach((q, i) => { if (q.purpose === 'new') rows[i].retrain = q.retrain_flagged === true; });
        return rows;
    }

    /**
     * 在批改卡上按對錯、勾「要重練」後按儲存：marks 是 { [question_id]: { result, retrain? } }。
     * 回 { body（送出的）, res, message（儲存後的提示，students.js 的 retrainSaveMessage）}。
     */
    async function gradeOnCard(paperId, marks, app = appOn) {
        const detail = await request(app).get(`/api/papers/${paperId}`);
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        const original = gradingRows(detail.body);
        const current = original.map(r => ({ ...r, error_types: [...r.error_types] }));
        for (const row of current) {
            const m = marks[row.question_id];
            if (!m) continue;
            row.result = m.result;
            if ('retrain' in m) {
                assert.ok('retrain' in row, `題 ${row.question_id} 在批改卡上沒有「要重練」勾選框（重練題或旗標關閉）`);
                row.retrain = m.retrain;
            }
        }
        const results = studentsUi.diffResults(original, current);
        const res = await request(app).patch(`/api/papers/${paperId}/results`).send({ results });
        const wrongUnflagged = current.filter((r, i) => 'retrain' in r && r.result === 0 && (original[i].result ?? null) !== 0 && !r.retrain).length;
        const message = res.status === 200 && res.body.retrain ? studentsUi.retrainSaveMessage(res.body.retrain, wrongUnflagged) : null;
        return { body: { results }, res, message };
    }

    // ─────────── 夾具與查詢 ───────────

    let qseq = 0;
    async function seedQuestions(n, { chapter, type = '計算', difficulty = 3, subject = '數學' }) {
        const out = [];
        for (let i = 0; i < n; i++) {
            qseq += 1;
            const { rows: [q] } = await query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [subject, chapter, type, difficulty, `全流程測試題 ${qseq}：求 $x^${qseq}$ 的值。`, `答 ${qseq}`]);
            out.push(q.id);
        }
        return out;
    }

    /** 一組承上題：ids[0] 是前題，其後每一題承接前一題。 */
    async function seedGroup(n, opts) {
        const ids = await seedQuestions(n, opts);
        for (let i = 1; i < ids.length; i++) {
            await query(`UPDATE questions SET follows_question_id = $1, follows_src = 'human' WHERE id = $2`, [ids[i - 1], ids[i]]);
        }
        return ids;
    }

    async function createStudent(name) {
        const res = await request(appOn).post('/api/students').send({ name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    }

    /** 資料庫裡的寫入量（草稿不寫庫的檢查）。 */
    async function footprint() {
        const { rows: [c] } = await query(
            `SELECT (SELECT COUNT(*) FROM exam_papers)::int AS papers, (SELECT COUNT(*) FROM assignments)::int AS assignments,
                    (SELECT COUNT(*) FROM attempt_records)::int AS records,
                    (SELECT md5(COALESCE(string_agg(i::text, '|' ORDER BY i.id), '')) FROM retrain_items i) AS items`);
        return c;
    }

    async function assignmentsOf(paperId) {
        const { rows } = await query(
            `SELECT question_id, purpose, retrain_item_id, retrain_step, to_char(assigned_at, 'YYYY-MM-DD') AS assigned_at
               FROM assignments WHERE paper_id = $1 ORDER BY question_id`, [paperId]);
        return rows.map(r => ({ ...r, retrain_item_id: r.retrain_item_id === null ? null : Number(r.retrain_item_id) }));
    }

    /** 排程項目的快取欄位（updated_at 以外全部）。 */
    async function itemRow(studentId, questionId) {
        const { rows } = await query(
            `SELECT id, reason, source_assignment_id, to_char(entered_on, 'YYYY-MM-DD') AS entered_on, status, step,
                    to_char(due_on, 'YYYY-MM-DD') AS due_on, streak, lapses,
                    to_char(last_attempt_on, 'YYYY-MM-DD') AS last_attempt_on, to_char(mastered_on, 'YYYY-MM-DD') AS mastered_on,
                    teacher_override, to_char(override_on, 'YYYY-MM-DD') AS override_on, note
               FROM retrain_items WHERE student_id = $1 AND question_id = $2`, [studentId, questionId]);
        return rows[0] || null;
    }

    const listItems = (s, qs = '') => request(appOn).get(`/api/students/${s}/retrain-items${qs}`);
    const summaryOf = async (s) => {
        const res = await request(appOn).get('/api/retrain/summary');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.items.find(i => i.student_id === s) || null;
    };
    const statsOf = async (s, qs = '') => {
        const res = await request(appOn).get(`/api/students/${s}/retrain-stats${qs}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body;
    };
    const generate = (body, app = appOn) => request(app).post('/api/generate-paper').send(body);
    const confirm = (body, app = appOn) => request(app).post('/api/confirm-paper').send(body);

    /** POST /api/download-word → document.xml 與原始位元組。 */
    async function download(body, app = appOn) {
        const res = await request(app).post('/api/download-word').send(body).buffer(true)
            .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        assert.equal(res.status, 200, String(res.body));
        return { bytes: res.body, xml: documentXml(res.body) };
    }
    const marks = xml => xml.split('（重練）').length - 1;

    /** 錯題重練卡的「出一份重練卷」：retrain.js 產 body → API-5 → draftFromResponse。 */
    async function draftOnCard(studentId, name, opts = {}) {
        const body = retrainUi.retrainPaperBody({ count: retrainUi.DEFAULT_PAPER_COUNT, ...opts });
        const res = await request(appOn).post(`/api/students/${studentId}/retrain-paper`).send(body);
        return { body, res, draft: res.status === 200 ? retrainUi.draftFromResponse(res.body, { id: studentId, name }) : null };
    }

    /** 錯題重練卡的「確認出卷」：retrain.js 的 confirmBody → API-7；回 retrain.js 記下的 lastPaper 形狀。 */
    async function confirmOnCard(draft) {
        const body = retrainUi.confirmBody(draft);
        const res = await confirm(body);
        const paper = res.status === 200
            ? { paper_id: res.body.paper_id, paper_title: res.body.paper_title, question_ids: res.body.question_ids, student_name: draft.student_name }
            : null;
        return { body, res, paper };
    }

    describe('錯題重練第二階段全流程（PR-2＋PR-3＋PR-4）', () => {
        before(async () => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
            retrainUi = await loadModule('retrain.js');
            studentsUi = await loadModule('students.js');
            mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 10, 0, 0).getTime() });
        });
        beforeEach(async () => {
            process.env.FEATURE_RETRAIN = 'true';
            travel('2026-10-01');
            await query('TRUNCATE retrain_items, attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });
        after(async () => {
            mock.timers.reset();
            delete process.env.FEATURE_RETRAIN;
            await pool.end();
        });

        test('新卷 → 批改勾「要重練」→ 第 1 關到期 → 重練卷草稿（不寫庫）→ 確認 → Word 標示 → 答對升第 2 關 → 刪重練卷回到原狀 → 附帶到新卷 → 重練成效', async () => {
            const NAME = '流程測試生';
            const [va, vb, vc] = await seedQuestions(3, { chapter: '向量內積' });
            const [w1, w2, w3, w4] = await seedQuestions(4, { chapter: '外積', type: '單選', difficulty: 2 });
            const s = await createStudent(NAME);

            // ── 10/01 ① 出一張新卷（組卷頁：預覽 → 確認；沒勾附帶，請求與回應都沒有重練的鍵）──
            const noAttach = paperPageHooks({ attach: null });
            assert.equal(noAttach.retrainAttachRequest(), null, '沒勾「附上到期的重練題」＝不帶 retrain');
            const gen1 = await generate({ student_id: s, subject: '數學', chapter: '向量內積', count: 3, dry_run: true });
            assert.equal(gen1.status, 200, JSON.stringify(gen1.body));
            assert.deepEqual([...gen1.body.question_ids].sort(num), [va, vb, vc]);
            assert.ok(!('retrain' in gen1.body) && gen1.body.questions.every(q => !('purpose' in q)), '沒帶 retrain：回應逐字不變');
            const c1 = await confirm({ student_id: s, question_ids: gen1.body.question_ids, ...noAttach.retrainConfirmKeys(gen1.body) });
            assert.equal(c1.status, 200, JSON.stringify(c1.body));
            assert.equal(c1.body.paper_title, `${NAME}-向量內積特訓卷(${titleDate('2026-10-01')})`);
            assert.ok(!('retrain_question_ids' in c1.body));
            const P1 = c1.body.paper_id;

            // ── ② 批改卡：va 錯並勾「要重練」、vb 錯沒勾、vc 對（API-9 → students.js diffResults → API-10）──
            const d1 = await request(appOn).get(`/api/papers/${P1}`);
            for (const q of d1.body.questions) {
                assert.deepEqual([q.purpose, q.retrain_step, q.retrain_flagged], ['new', null, false], `API-9 題 ${q.question_id}`);
            }
            const g1 = await gradeOnCard(P1, { [va]: { result: 0, retrain: true }, [vb]: { result: 0 }, [vc]: { result: 1 } });
            assert.equal(g1.res.status, 200, JSON.stringify(g1.res.body));
            const sentFor = qid => g1.body.results.find(r => r.question_id === qid);
            assert.deepEqual(sentFor(va), { question_id: va, result: 0, retrain: true }, '勾了才送 retrain');
            assert.deepEqual(sentFor(vb), { question_id: vb, result: 0 }, '沒改勾選就不送 retrain（伺服器「沒送＝不動」）');
            assert.deepEqual(g1.res.body, { updated: 3, retrain: { entered: 1, advanced: 0, mastered: 0, reset: 0 } });
            assert.equal(g1.message, '1 題進入重練清單。這次有 1 題答錯但沒勾「要重練」，不會進清單。');
            const d1b = await request(appOn).get(`/api/papers/${P1}`);
            const flagged = Object.fromEntries(d1b.body.questions.map(q => [q.question_id, q.retrain_flagged]));
            assert.deepEqual(flagged, { [va]: true, [vb]: false, [vc]: false }, '批改卡重開時依 retrain_flagged 顯示已勾');

            // ── ③ 清單：只有勾的那一題（答錯沒勾的不進，R1 選 2）；第 1 關、起算日＝派題日、明天到期 ──
            let list = await listItems(s);
            assert.equal(list.status, 200, JSON.stringify(list.body));
            assert.deepEqual(list.body.counts, { active: 1, due: 0, in_flight: 0, stuck: 0, mastered: 0, retired: 0 });
            assert.deepEqual(list.body.items.map(i => i.question_id), [va]);
            const it0 = list.body.items[0];
            assert.deepEqual(
                [it0.reason, it0.status, it0.step, it0.step_label, it0.entered_on, it0.due_on, it0.due, it0.in_flight, it0.streak, it0.lapses],
                ['flagged', 'active', 1, '錯題重練', '2026-10-01', '2026-10-02', false, false, 0, 0]);
            assert.deepEqual(await summaryOf(s), { student_id: s, due: 0, in_flight: 0, stuck: 0, active: 1 });

            // ── 10/02：第 1 關到期（下一份卷即可出）──
            travel('2026-10-02');
            list = await listItems(s);
            assert.deepEqual([list.body.counts.due, list.body.items[0].due, list.body.items[0].overdue_days], [1, true, 0]);
            assert.equal((await summaryOf(s)).due, 1, '學生清單的「到期 1」');
            const listBefore = list.body;
            const rowBefore = await itemRow(s, va);
            const statsBefore = await statsOf(s);
            assert.deepEqual([statsBefore.first_retrain, statsBefore.backlog], [{ graded: 0, correct: 0, rate: null }, { due_now: 1, overdue_7d: 0 }]);

            // ── ④ 錯題重練卡「出一份重練卷」：retrain.js 的 body → API-5（只產草稿、不寫庫）──
            const fp0 = await footprint();
            const dr = await draftOnCard(s, NAME);
            assert.deepEqual(dr.body, { count: 10 }, 'retrain.js 送出的 body（科目、預計作答日沒選就不帶）');
            assert.equal(dr.res.status, 200, JSON.stringify(dr.res.body));
            assert.deepEqual([dr.res.body.student_id, dr.res.body.subject, dr.res.body.as_of, dr.res.body.question_ids, dr.res.body.due_total],
                [s, null, '2026-10-02', [va], 1]);
            const di = dr.res.body.items[0];
            assert.deepEqual(
                [di.question_id, di.item_id, di.step, di.step_label, di.due_on, di.overdue_days, di.chapter, di.group_ids, di.follows_question_id, di.status, di.due],
                [va, Number(rowBefore.id), 1, '錯題重練', '2026-10-02', 0, '向量內積', [va], null, 'active', true]);
            assert.ok(typeof di.question_text_preview === 'string' && di.question_text_preview.startsWith('全流程測試題'), 'retrain.js 草稿卡顯示的題幹預覽');
            assert.ok(Array.isArray(dr.res.body.notes));
            assert.deepEqual(retrainUi.draftGroups(dr.draft).map(g => g.group_ids), [[va]]);
            assert.deepEqual(await footprint(), fp0, '產生草稿不寫任何資料（ACPT-039-1）');

            // ── ⑤ 確認：retrain.js 的 confirmBody → API-7（retrain_question_ids）──
            const cf = await confirmOnCard(dr.draft);
            assert.deepEqual(cf.body, { student_id: s, question_ids: [va], retrain_question_ids: [va] });
            assert.equal(cf.res.status, 200, JSON.stringify(cf.res.body));
            assert.equal(cf.res.body.paper_title, `${NAME}-錯題重練卷(${titleDate('2026-10-02')})`, '純重練卷的卷名（第 5.4 節）');
            assert.deepEqual([cf.res.body.question_ids, cf.res.body.retrain_question_ids], [[va], [va]]);
            const P2 = cf.paper.paper_id;
            assert.deepEqual(await assignmentsOf(P2),
                [{ question_id: va, purpose: 'retrain', retrain_item_id: Number(rowBefore.id), retrain_step: 1, assigned_at: '2026-10-02' }]);
            list = await listItems(s);
            assert.deepEqual([list.body.items[0].in_flight, list.body.items[0].in_flight_paper_id, list.body.items[0].due, list.body.counts.in_flight],
                [true, P2, false, 1], '已派出、還沒批改：不算到期（I6）');
            // 同一份草稿再按一次確認（例如另一個分頁）：409，retrain.js 原樣顯示
            const again = await confirm(retrainUi.confirmBody(dr.draft));
            assert.deepEqual([again.status, again.body], [409, { message: CONFLICT(va) }]);
            // 原卷有題在別張卷重練中 → 刪原卷被擋（第 3.9 節）
            const delP1 = await request(appOn).delete(`/api/papers/${P1}`);
            assert.equal(delP1.status, 409);
            assert.equal(delP1.body.message, `這張卷有 1 題已經在錯題重練中（重練卷 #${P2}），請先刪除那些重練卷。`);
            // 試卷列表「含重練 N 題」（students.js 的 paperCard 讀 retrain_count）
            const papers = await request(appOn).get(`/api/students/${s}/papers`);
            assert.deepEqual(Object.fromEntries(papers.body.items.map(p => [p.paper_id, p.retrain_count])), { [P1]: 0, [P2]: 1 });

            // ── ⑥ 下載 Word：retrain.js 的 wordDownloadRequest 帶 paper_id → 標準版答案區與詳解版標「（重練）」，學生版不標 ──
            const std = retrainUi.wordDownloadRequest(cf.paper, 'standard');
            assert.deepEqual(std.body, { paper_title: cf.paper.paper_title, student_name: NAME, question_ids: [va], edition: 'standard', paper_id: P2 });
            assert.equal(std.filename, `${cf.paper.paper_title}.docx`);
            const wStd = await download(std.body);
            assert.ok(wStd.xml.includes('第 1 題（重練）答案：'));
            assert.equal(marks(wStd.xml), 1, '題目區（卷面）不標');
            const wSol = await download(retrainUi.wordDownloadRequest(cf.paper, 'solution').body);
            assert.ok(wSol.xml.includes('第 1 題（重練）答案：'), '詳解版標');
            const wStu = await download(retrainUi.wordDownloadRequest(cf.paper, 'student').body);
            assert.equal(marks(wStu.xml), 0, '學生版完全不標（R7 選 1）');
            const { paper_id: _omit, ...noPaperId } = std.body;
            assert.equal(marks((await download(noPaperId)).xml), 0, '沒帶 paper_id 不查、不標');

            // ── ⑦ 批改重練題（重練題沒有勾選框，只有「重練・第 1 關」）：答對 → 第 2 關、到期日＝派題日＋7 天 ──
            const d2 = await request(appOn).get(`/api/papers/${P2}`);
            assert.deepEqual([d2.body.questions[0].purpose, d2.body.questions[0].retrain_step, d2.body.questions[0].retrain_flagged], ['retrain', 1, null]);
            assert.ok(!('retrain' in gradingRows(d2.body)[0]), '批改卡不給重練題勾選框');
            const g2 = await gradeOnCard(P2, { [va]: { result: 1 } });
            assert.deepEqual(g2.body, { results: [{ question_id: va, result: 1 }] });
            assert.deepEqual(g2.res.body, { updated: 1, retrain: { entered: 0, advanced: 1, mastered: 0, reset: 0 } });
            assert.equal(g2.message, '1 題升一關。');
            list = await listItems(s);
            const it2 = list.body.items[0];
            assert.deepEqual([it2.step, it2.step_label, it2.due_on, it2.streak, it2.lapses, it2.due, it2.in_flight],
                [2, '一週回測', schedule.addDays('2026-10-02', 7), 1, 0, false, false]);
            assert.deepEqual(it2.history.map(h => [h.paper_id, h.purpose, h.retrain_step, h.result]), [[P1, 'new', null, 0], [P2, 'retrain', 1, 1]]);
            const statsMid = await statsOf(s);
            assert.deepEqual([statsMid.first_retrain, statsMid.spaced], [{ graded: 1, correct: 1, rate: 1 }, { graded: 0, correct: 0, rate: null }]);

            // ── ⑧ 刪掉這張重練卷 → 排程回到出這張卷之前（等於那次重練沒發生過，ACPT-038-4）──
            const delP2 = await request(appOn).delete(`/api/papers/${P2}`);
            assert.deepEqual([delP2.status, delP2.body], [200, { deleted_attempts: 1 }]);
            assert.deepEqual(await itemRow(s, va), rowBefore, '排程快取回到原狀');
            assert.deepEqual((await listItems(s)).body, listBefore, 'API-1 與出重練卷之前逐欄相同');
            assert.deepEqual(await statsOf(s), statsBefore, '重練成效也回到原狀');
            assert.equal((await request(appOn).get(`/api/papers/${P1}`)).body.questions.find(q => q.question_id === va).retrain_flagged, true);

            // ── 10/03 ⑨ 再出一張新卷，勾「附上到期的重練題」（組卷頁掛鉤 → API-6 → API-7）──
            travel('2026-10-03');
            const N = 4;
            const hooks = paperPageHooks({ attach: schedule.capForAttach(N, DEFAULT_ATTACH_RATIO) });
            assert.equal(hooks.retrainCapForAttach(N, hooks.retrainAttachRatio()), schedule.capForAttach(N, DEFAULT_ATTACH_RATIO),
                '組卷頁預設題數與伺服器同一條規則（新題 4 題 → 1 題）');
            const attachReq = hooks.retrainAttachRequest();
            assert.deepEqual(attachReq, { count: 1 });
            const fp1 = await footprint();
            const gen3 = await generate({ student_id: s, subject: '數學', chapter: '外積', count: N, dry_run: true, retrain: attachReq });
            assert.equal(gen3.status, 200, JSON.stringify(gen3.body));
            assert.deepEqual(gen3.body.retrain, { wanted: 1, got: 1, due_total: 1 });
            assert.deepEqual([...gen3.body.question_ids].sort(num), [va, w1, w2, w3, w4].sort(num), '新題照舊 4 題，重練題另外加上');
            const byId3 = Object.fromEntries(gen3.body.questions.map(q => [q.id, [q.purpose, q.retrain_step]]));
            assert.deepEqual(byId3, { [va]: ['retrain', 1], [w1]: ['new', null], [w2]: ['new', null], [w3]: ['new', null], [w4]: ['new', null] });
            assert.deepEqual(await footprint(), fp1, 'dry_run 不寫庫');
            const c3body = { student_id: s, question_ids: gen3.body.question_ids, ...hooks.retrainConfirmKeys(gen3.body) };
            assert.deepEqual(c3body.retrain_question_ids, [va]);
            const c3 = await confirm(c3body);
            assert.equal(c3.status, 200, JSON.stringify(c3.body));
            assert.equal(c3.body.paper_title, `${NAME}-外積特訓卷(${titleDate('2026-10-03')})`, '混合卷沿用既有卷名');
            assert.deepEqual(c3.body.retrain_question_ids, [va]);
            const P3 = c3.body.paper_id;
            assert.deepEqual((await assignmentsOf(P3)).map(a => [a.question_id, a.purpose, a.retrain_step]),
                [[va, 'retrain', 1], [w1, 'new', null], [w2, 'new', null], [w3, 'new', null], [w4, 'new', null]].sort((a, b) => a[0] - b[0]));
            // 組卷頁的 Word（currentPaperCache 帶 paper_id）：答案區只有重練題那一號標「（重練）」
            const w3x = (await download({ paper_title: c3.body.paper_title, student_name: NAME, question_ids: c3.body.question_ids, paper_id: P3, edition: 'standard' })).xml;
            assert.ok(w3x.includes(`第 ${c3.body.question_ids.indexOf(va) + 1} 題（重練）答案：`));
            assert.equal(marks(w3x), 1);

            // 批改：重練題 va 對（升關）；新題 w1 錯並勾、w2 錯沒勾、w3 w4 對
            const g3 = await gradeOnCard(P3, {
                [va]: { result: 1 }, [w1]: { result: 0, retrain: true }, [w2]: { result: 0 }, [w3]: { result: 1 }, [w4]: { result: 1 }
            });
            assert.deepEqual(g3.res.body, { updated: 5, retrain: { entered: 1, advanced: 1, mastered: 0, reset: 0 } });
            assert.equal(g3.message, '1 題進入重練清單、1 題升一關。這次有 1 題答錯但沒勾「要重練」，不會進清單。');
            list = await listItems(s);
            assert.deepEqual(list.body.items.map(i => [i.question_id, i.step, i.due_on]).sort((a, b) => a[0] - b[0]),
                [[va, 2, '2026-10-10'], [w1, 1, '2026-10-04']]);
            assert.deepEqual(list.body.counts, { active: 2, due: 0, in_flight: 0, stuck: 0, mastered: 0, retired: 0 });

            // ── ⑩ 重練成效（API-13）──
            const st3 = await statsOf(s);
            assert.deepEqual(st3, {
                entered: 2, active: 2, mastered: 0, retired: 0, stuck: 0,
                first_retrain: { graded: 1, correct: 1, rate: 1 },
                spaced: { graded: 0, correct: 0, rate: null },
                backlog: { due_now: 0, overdue_7d: 0 },
                by_chapter: st3.by_chapter,
                since: schedule.addDays('2026-10-03', -90)
            });
            assert.deepEqual(st3.by_chapter.map(c => [c.chapter, c.entered, c.mastered, c.active, c.stuck]).sort(),
                [['向量內積', 1, 0, 1, 0], ['外積', 1, 0, 1, 0]].sort());

            // ── 10/10：兩題都到期 → 重練卷（w1 第一次重練、va 隔週回測）→ w1 對、va 錯 ──
            travel('2026-10-10');
            list = await listItems(s);
            assert.deepEqual(list.body.items.filter(i => i.due).map(i => [i.question_id, i.overdue_days]), [[w1, 6], [va, 0]],
                '依逾期天數排序（第 4.7 節；前端不重排）');
            assert.equal((await summaryOf(s)).due, 2);
            assert.deepEqual((await statsOf(s)).backlog, { due_now: 2, overdue_7d: 0 });
            const dr4 = await draftOnCard(s, NAME);
            assert.equal(dr4.res.status, 200, JSON.stringify(dr4.res.body));
            assert.deepEqual(dr4.res.body.items.map(i => [i.question_id, i.step]), [[w1, 1], [va, 2]]);
            const cf4 = await confirmOnCard(dr4.draft);
            assert.equal(cf4.res.status, 200, JSON.stringify(cf4.res.body));
            assert.equal(cf4.res.body.paper_title, `${NAME}-錯題重練卷(${titleDate('2026-10-10')})`);
            const P4 = cf4.paper.paper_id;
            const g4 = await gradeOnCard(P4, { [w1]: { result: 1 }, [va]: { result: 0 } });
            assert.deepEqual(g4.res.body, { updated: 2, retrain: { entered: 0, advanced: 1, mastered: 0, reset: 1 } });
            assert.equal(g4.message, '1 題升一關、1 題答錯回到第 1 關。');
            const va4 = (await listItems(s)).body.items.find(i => i.question_id === va);
            assert.deepEqual([va4.step, va4.streak, va4.lapses, va4.due_on], [1, 0, 1, '2026-10-11'], '又錯：回第 1 關、錯的次數＋1（R4）');

            const st4 = await statsOf(s);
            assert.deepEqual([st4.first_retrain, st4.spaced, st4.backlog, st4.entered, st4.active],
                [{ graded: 2, correct: 2, rate: 1 }, { graded: 1, correct: 0, rate: 0 }, { due_now: 0, overdue_7d: 0 }, 2, 2],
                '第 1 關的作答算「重練」（va 10/03、w1 10/10），第 2 關以後算「隔週回測」（va 10/10）');
            const st4w = await statsOf(s, '?days=1');
            assert.deepEqual([st4w.since, st4w.first_retrain, st4w.spaced],
                ['2026-10-09', { graded: 1, correct: 1, rate: 1 }, { graded: 1, correct: 0, rate: 0 }], '時間窗只影響答對率');
            const phys = await statsOf(s, `?subject=${encodeURIComponent('物理')}`);
            assert.deepEqual([phys.entered, phys.first_retrain.graded, phys.backlog.due_now], [0, 0, 0], '依科目篩選');

            // ── 10/18：va 逾期 7 天、w1 逾期 1 天 → backlog ──
            travel('2026-10-18');
            assert.deepEqual((await statsOf(s)).backlog, { due_now: 2, overdue_7d: 1 });
        });

        test('承上組：勾一題整組進清單；重練卷與附帶都整組出，放不下 → 400（R12）；只放一部分 → 400（B7）', async () => {
            const NAME = '承上組測試生';
            const [g1, g2, g3] = await seedGroup(3, { chapter: '空間向量內積' });
            const [n1, n2, n3] = await seedQuestions(3, { chapter: '外積', type: '單選', difficulty: 2 });
            const s = await createStudent(NAME);

            // 10/01 新卷（整組抽）→ 批改：只在 g2 勾「要重練」
            const gen = await generate({ student_id: s, subject: '數學', chapter: '空間向量內積', count: 3, dry_run: true });
            assert.equal(gen.status, 200, JSON.stringify(gen.body));
            assert.deepEqual(gen.body.question_ids, [g1, g2, g3], '承上組依承接順序相鄰');
            const c1 = await confirm({ student_id: s, question_ids: gen.body.question_ids });
            assert.equal(c1.status, 200, JSON.stringify(c1.body));
            const P1 = c1.body.paper_id;
            const gr = await gradeOnCard(P1, { [g1]: { result: 1 }, [g2]: { result: 0, retrain: true }, [g3]: { result: 1 } });
            assert.deepEqual(gr.res.body, { updated: 3, retrain: { entered: 3, advanced: 0, mastered: 0, reset: 0 } }, '同組其他題一起進（ACPT-037-3）');
            assert.equal(gr.message, '3 題進入重練清單。');
            const list = await listItems(s);
            assert.deepEqual(list.body.items.map(i => [i.question_id, i.reason, i.group_ids, i.follows_question_id]).sort((a, b) => a[0] - b[0]),
                [[g1, 'group', [g1, g2, g3], null], [g2, 'flagged', [g1, g2, g3], g1], [g3, 'group', [g1, g2, g3], g2]]);
            const detail = await request(appOn).get(`/api/papers/${P1}`);
            assert.deepEqual(detail.body.questions.map(q => q.retrain_flagged), [false, true, false], '只有老師親手勾的那一題顯示已勾');

            // 10/02：重練卷題數 2 放不下整組 → 400、不產生草稿（retrain.js 原樣顯示訊息）
            travel('2026-10-02');
            const fp = await footprint();
            const small = await draftOnCard(s, NAME, { count: 2 });
            assert.deepEqual([small.res.status, small.res.body],
                [400, { message: `到期的承上題組（題 ${g1}、${g2}、${g3}）共 3 題，放不進剩下的 2 個重練名額；請把重練題數改成 3。` }]);
            assert.deepEqual(await footprint(), fp);

            const dr = await draftOnCard(s, NAME, { count: 3 });
            assert.equal(dr.res.status, 200, JSON.stringify(dr.res.body));
            assert.deepEqual(dr.res.body.question_ids, [g1, g2, g3]);
            assert.deepEqual(retrainUi.draftGroups(dr.draft).map(g => g.group_ids), [[g1, g2, g3]], '草稿卡整組顯示');
            assert.deepEqual(retrainUi.removeGroup(dr.draft, g2).items, [], '「刪這組」整組刪');

            // 只把一部分當重練題出 → 400（B7 的整組檢查與新題一視同仁；缺的題還在清單上＝加回來就好）
            const half = await confirm({ student_id: s, question_ids: [g2], retrain_question_ids: [g2] });
            assert.equal(half.status, 400);
            assert.deepEqual(half.body.incomplete_groups,
                [{ group_ids: [g1, g2, g3], missing: [{ question_id: g1, reason: 'not_in_paper' }, { question_id: g3, reason: 'not_in_paper' }] }]);

            const cf = await confirmOnCard(dr.draft);
            assert.equal(cf.res.status, 200, JSON.stringify(cf.res.body));
            assert.deepEqual([cf.res.body.question_ids, cf.res.body.retrain_question_ids], [[g1, g2, g3], [g1, g2, g3]]);
            assert.equal(cf.res.body.paper_title, `${NAME}-錯題重練卷(${titleDate('2026-10-02')})`);
            const wx = (await download(retrainUi.wordDownloadRequest(cf.paper, 'standard').body)).xml;
            assert.equal(marks(wx), 3);

            // 組內各題各自記作答、各自升降關
            const g = await gradeOnCard(cf.paper.paper_id, { [g1]: { result: 1 }, [g2]: { result: 0 }, [g3]: { result: 1 } });
            assert.deepEqual(g.res.body, { updated: 3, retrain: { entered: 0, advanced: 2, mastered: 0, reset: 1 } });
            const after = (await listItems(s)).body.items;
            assert.deepEqual(after.map(i => [i.question_id, i.step, i.due_on]).sort((a, b) => a[0] - b[0]),
                [[g1, 2, '2026-10-09'], [g2, 1, '2026-10-03'], [g3, 2, '2026-10-09']]);

            // 10/03：組內 g2 到期 → 整組出（g1、g3 還沒到期，被帶著出）
            travel('2026-10-03');
            const dr2 = await draftOnCard(s, NAME, { count: 3 });
            assert.equal(dr2.res.status, 200, JSON.stringify(dr2.res.body));
            assert.deepEqual(dr2.res.body.items.map(i => [i.question_id, i.due]), [[g1, false], [g2, true], [g3, false]]);
            assert.equal(dr2.res.body.due_total, 1);

            // 附帶到新卷：題數 2 放不下 → 400；3 → 整組附上
            const hooks = paperPageHooks({ attach: 2 });
            const tooSmall = await generate({ student_id: s, subject: '數學', chapter: '外積', count: 3, dry_run: true, retrain: hooks.retrainAttachRequest() });
            assert.deepEqual([tooSmall.status, tooSmall.body.message],
                [400, `到期的承上題組（題 ${g1}、${g2}、${g3}）共 3 題，放不進剩下的 2 個重練名額；請把重練題數改成 3。`]);
            const hooks3 = paperPageHooks({ attach: 3 });
            const gen2 = await generate({ student_id: s, subject: '數學', chapter: '外積', count: 3, dry_run: true, retrain: hooks3.retrainAttachRequest() });
            assert.equal(gen2.status, 200, JSON.stringify(gen2.body));
            assert.deepEqual(gen2.body.retrain, { wanted: 3, got: 3, due_total: 1 });
            const ids = gen2.body.question_ids;
            assert.deepEqual([...ids].sort(num), [g1, g2, g3, n1, n2, n3].sort(num));
            assert.deepEqual([ids.indexOf(g2) - ids.indexOf(g1), ids.indexOf(g3) - ids.indexOf(g2)], [1, 1], '承上組在卷上依承接順序相鄰');
            const c2 = await confirm({ student_id: s, question_ids: ids, ...hooks3.retrainConfirmKeys(gen2.body) });
            assert.equal(c2.status, 200, JSON.stringify(c2.body));
            assert.deepEqual([...c2.body.retrain_question_ids].sort(num), [g1, g2, g3]);
            assert.deepEqual((await assignmentsOf(c2.body.paper_id)).filter(a => a.purpose === 'retrain').map(a => [a.question_id, a.retrain_step]),
                [[g1, 2], [g2, 1], [g3, 2]], '各自記下當下的關卡');
        });

        test('旗標關閉：新 API 404、新參數 400；既有端點的回應只少了新鍵（有重練資料也一樣）；Word 帶 paper_id 逐位元不變', async () => {
            const NAME = '旗標關閉生';
            const [a, b] = await seedQuestions(2, { chapter: '向量內積' });
            const [n1, n2] = await seedQuestions(2, { chapter: '外積', type: '單選', difficulty: 2 });
            const s = await createStudent(NAME);
            // 旗標開啟時留下重練資料：新卷 a 錯勾、b 對 → 10/02 重練卷
            const c1 = await confirm({ student_id: s, question_ids: [a, b] });
            assert.equal(c1.status, 200, JSON.stringify(c1.body));
            const P1 = c1.body.paper_id;
            assert.equal((await gradeOnCard(P1, { [a]: { result: 0, retrain: true }, [b]: { result: 1 } })).res.status, 200);
            travel('2026-10-02');
            const cf = await confirmOnCard((await draftOnCard(s, NAME)).draft);
            assert.equal(cf.res.status, 200, JSON.stringify(cf.res.body));
            const P2 = cf.paper.paper_id;
            const item = await itemRow(s, a);

            // 旗標開啟時的回應（拿來比「關閉時只少了新鍵」）
            const onDetail = (await request(appOn).get(`/api/papers/${P2}`)).body;
            const onPapers = (await request(appOn).get(`/api/students/${s}/papers`)).body;
            const onWordNoId = (await download({ paper_title: cf.paper.paper_title, student_name: NAME, question_ids: [a], edition: 'standard' })).bytes;

            await withRetrain(false, async app => {
                const fp = await footprint();
                // 六支新 API 不掛載（Express 預設 404）
                for (const [method, url] of [
                    ['get', `/api/students/${s}/retrain-items`], ['post', `/api/students/${s}/retrain-items`],
                    ['patch', `/api/students/${s}/retrain-items/${item.id}`], ['get', '/api/retrain/summary'],
                    ['post', `/api/students/${s}/retrain-paper`], ['get', `/api/students/${s}/retrain-stats`]
                ]) {
                    const r = await request(app)[method](url).send(method === 'get' ? undefined : {});
                    assert.equal(r.status, 404, `${method} ${url}`);
                    assert.match(r.text, /Cannot (GET|POST|PATCH)/, `${method} ${url}：路由沒有掛載`);
                }
                // 擴充的既有端點帶了新參數 → 400（讓老師知道沒生效，不靜默忽略）
                const gen = await generate({ student_id: s, subject: '數學', chapter: '外積', count: 2, dry_run: true, retrain: { count: 1 } }, app);
                assert.deepEqual([gen.status, gen.body], [400, DISABLED]);
                const cfm = await confirm({ student_id: s, question_ids: [n1], retrain_question_ids: [] }, app);
                assert.deepEqual([cfm.status, cfm.body], [400, DISABLED]);
                const rem = await request(app).post(`/api/students/${s}/remedial-paper`).send({ subject: '數學', retrain_count: 1 });
                assert.deepEqual([rem.status, rem.body], [400, DISABLED]);
                const pr = await request(app).patch(`/api/papers/${P1}/results`).send({ results: [{ question_id: b, result: 1, retrain: true }] });
                assert.deepEqual([pr.status, pr.body], [400, DISABLED]);
                assert.deepEqual(await footprint(), fp, '400 時什麼都沒寫');

                // 既有端點：與開啟時相比只少了新鍵
                const offDetail = (await request(app).get(`/api/papers/${P2}`)).body;
                const strip = q => { const { purpose, retrain_step, retrain_flagged, ...rest } = q; return rest; };
                assert.deepEqual(offDetail, { ...onDetail, questions: onDetail.questions.map(strip) });
                assert.ok(offDetail.questions.every(q => !('purpose' in q) && !('retrain_flagged' in q)));
                const offPapers = (await request(app).get(`/api/students/${s}/papers`)).body;
                assert.deepEqual(offPapers, { items: onPapers.items.map(({ retrain_count, ...rest }) => rest) });
                // 批改卡：旗標關閉時列上沒有 retrain 鍵，diffResults 的輸出與回應都是原本的形狀（重練題照樣可以批改、照樣重算）
                const g = await gradeOnCard(P2, { [a]: { result: 1 } }, app);
                assert.deepEqual(g.body, { results: [{ question_id: a, result: 1 }] });
                assert.deepEqual([g.res.status, g.res.body], [200, { updated: 1 }]);
                assert.equal((await itemRow(s, a)).step, 2, '旗標不管排程重算（第 5.1 節）');
                // 組卷：沒帶 retrain 的回應形狀
                const gen2 = await generate({ student_id: s, subject: '數學', chapter: '外積', count: 2, dry_run: true }, app);
                assert.equal(gen2.status, 200, JSON.stringify(gen2.body));
                assert.deepEqual(Object.keys(gen2.body), ['dry_run', 'message', 'student_id', 'paper_title_preview', 'question_ids', 'questions']);
                assert.ok(gen2.body.questions.every(q => !('purpose' in q)));
                const c2 = await confirm({ student_id: s, question_ids: gen2.body.question_ids }, app);
                assert.deepEqual(Object.keys(c2.body), ['message', 'paper_id', 'paper_title', 'question_ids', 'questions']);
                // Word：旗標關閉時 paper_id 一律忽略，逐位元等於沒帶（也等於旗標開啟時沒帶）
                const base = { paper_title: cf.paper.paper_title, student_name: NAME, question_ids: [a], edition: 'standard' };
                const offNoId = (await download(base, app)).bytes;
                const offWithId = (await download({ ...base, paper_id: P2 }, app)).bytes;
                assert.ok(offWithId.equals(offNoId), 'paper_id 被忽略');
                assert.ok(offNoId.equals(onWordNoId), '沒帶 paper_id 時與旗標無關');
                // 首頁：meta 注入 false，#retrain 是空的 section（retrain.js 整段不渲染）
                const home = await request(app).get('/');
                assert.equal(home.status, 200);
                assert.ok(home.text.includes('<meta name="feature-retrain" content="false">'));
                assert.ok(home.text.includes('<section id="retrain"></section>'));
            });
        });
    });
}
