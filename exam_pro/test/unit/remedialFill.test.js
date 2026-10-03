// ─────────────────────────────────────────────────────────────
// test/unit/remedialFill.test.js — 補救卷「題庫不夠時自動補題」的純函式與組裝（〔dec/r16-remedial〕；docs/remedial.md 第 11 節）
//
//   services/remedialFillService.js  body 驗證、藍本順序（錯因優先、最近的先）、分配與上限、錯題查詢（R10）、
//                                    fillShortfall 組裝（先檢索、合流、上限、跳過、notes；注入假的 variantService）
//   public/js/remedial.js            fillUnitOf、fillRequestBody、fillJobLine
//   public/js/review.js              remedialForText
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../../services/remedialFillService');

const JS_DIR = path.resolve(__dirname, '..', '..', 'public', 'js');
let seq = 0;
async function loadModule(name) {
    const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8') + `\n// instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

const unit = (over = {}) => ({ unit_type: 'chapter', chapter: '向量內積', needed: 3, ...over });

describe('parseFillBody', () => {
    test('合法：預設 days 90、difficulty_delta 0；知識點單位帶 kc_id；error_type 選填', () => {
        assert.deepEqual(F.parseFillBody({ subject: '數學', units: [unit()] }),
            { value: { subject: '數學', days: 90, difficultyDelta: 0, units: [{ unit_type: 'chapter', chapter: '向量內積', needed: 3, error_type: null }] } });
        const out = F.parseFillBody({ subject: '數學', days: 30, difficulty_delta: -1,
            units: [unit({ unit_type: 'kc', kc_id: 7, error_type: 'concept' }), unit({ chapter: '排列', needed: 1 })] });
        assert.deepEqual(out.value.units, [
            { unit_type: 'kc', chapter: '向量內積', kc_id: 7, needed: 3, error_type: 'concept' },
            { unit_type: 'chapter', chapter: '排列', needed: 1, error_type: null }
        ]);
        assert.deepEqual([out.value.days, out.value.difficultyDelta], [30, -1]);
    });

    const bad = [
        [{ subject: '數學', units: [unit()], student_name: 'x' }, /不認得的鍵：student_name/],
        [{ subject: '生物', units: [unit()] }, /subject/],
        [{ subject: '數學', units: [] }, /1~3 個單位/],
        [{ subject: '數學', units: [unit(), unit({ chapter: '排列' }), unit({ chapter: '組合' }), unit({ chapter: '實數' })] }, /1~3 個單位/],
        [{ subject: '數學', units: [unit({ foo: 1 })] }, /不認得的鍵：foo/],
        [{ subject: '數學', units: [unit({ unit_type: 'volume' })] }, /unit_type/],
        [{ subject: '數學', units: [unit({ chapter: '靜電學' })] }, /章節白名單/],
        [{ subject: '數學', units: [unit({ unit_type: 'kc' })] }, /kc_id 必須是正整數/],
        [{ subject: '數學', units: [unit({ kc_id: 3 })] }, /不可帶 kc_id/],
        [{ subject: '數學', units: [unit({ needed: 0 })] }, /needed/],
        [{ subject: '數學', units: [unit({ needed: 2.5 })] }, /needed/],
        [{ subject: '數學', units: [unit({ error_type: 'lazy' })] }, /錯因白名單/],
        [{ subject: '數學', units: [unit(), unit()] }, /重複/],
        [{ subject: '數學', days: 0, units: [unit()] }, /days/],
        [{ subject: '數學', difficulty_delta: 2, units: [unit()] }, /difficulty_delta/]
    ];
    for (const [body, re] of bad) {
        test(`400：${re}`, () => {
            const out = F.parseFillBody(body);
            assert.ok(out.error, JSON.stringify(out));
            assert.match(out.error, re);
        });
    }
});

describe('orderSources、allocate、buildWrongSourcesQuery、sourceProblem', () => {
    test('藍本順序：標了主因的錯題在前，其餘照 SQL 的「最近的先」；重複的題只留一次', () => {
        const rows = [
            { question_id: 5, error_types: ['calc'] }, { question_id: 4, error_types: [] },
            { question_id: 3, error_types: ['concept'] }, { question_id: 5, error_types: ['calc'] }, { question_id: 2, error_types: ['concept', 'calc'] }
        ];
        assert.deepEqual(F.orderSources(rows, null), [5, 4, 3, 2]);
        assert.deepEqual(F.orderSources(rows, 'concept'), [3, 2, 5, 4]);
        assert.deepEqual(F.orderSources([], 'concept'), []);
    });

    test('分配：平均分、餘數給前面；每個藍本最多 perSource 題；不超過剩下的額度；回報沒分到的與 capped', () => {
        assert.deepEqual(F.allocate(3, 2, 3, 5), { counts: [2, 1], unassigned: 0, capped: false });
        assert.deepEqual(F.allocate(3, 5, 3, 5), { counts: [1, 1, 1], unassigned: 0, capped: false });
        assert.deepEqual(F.allocate(10, 2, 3, 5), { counts: [3, 2], unassigned: 5, capped: true }, '額度 5');
        assert.deepEqual(F.allocate(10, 2, 3, 20), { counts: [3, 3], unassigned: 4, capped: false }, '藍本不夠分');
        assert.deepEqual(F.allocate(4, 0, 3, 5), { counts: [], unassigned: 4, capped: false });
        assert.deepEqual(F.allocate(4, 3, 3, 0), { counts: [], unassigned: 4, capped: true });
        assert.equal(F.MAX_FILL_GENERATE, 5);
    });

    test('錯題查詢：參數順序、只讀檢視 attempts（R10）、答錯或部分給分、最近的先；知識點只算同科標註', () => {
        const q = F.buildWrongSourcesQuery({ studentId: 3, days: 90, subject: '數學', chapter: '向量內積', kcId: null });
        assert.deepEqual(q.values, [3, 90, '數學', '向量內積', null, F.MAX_SOURCE_CANDIDATES]);
        assert.match(q.text, /FROM attempts a JOIN questions q/);
        assert.ok(!/assignment_attempts|FROM assignments/.test(q.text), '不讀含重練的表');
        assert.match(q.text, /COALESCE\(a\.score::float8, a\.result::float8\) < 1/);
        assert.match(q.text, /ORDER BY a\.assigned_at DESC, a\.graded_at DESC NULLS LAST, a\.question_id DESC/);
        assert.match(q.text, /kx\.subject = q\.subject/);
        assert.equal(F.buildWrongSourcesQuery({ studentId: 3, days: 90, subject: '數學', chapter: '向量內積', kcId: 7 }).values[4], 7);
    });

    test('藍本不能用：查不到／封存、承上題、沒有向量', () => {
        assert.equal(F.sourceProblem(null), 'not_found');
        assert.equal(F.sourceProblem({ id: 1, follows_question_id: 9, embedding: '[1]' }), 'follow_up');
        assert.equal(F.sourceProblem({ id: 1, follows_question_id: null, embedding: null }), 'no_vector');
        assert.equal(F.sourceProblem({ id: 1, follows_question_id: null, embedding: '[1]' }), null);
    });
});

describe('fillShortfall（注入假依賴）', () => {
    /**
     * 假 DB：錯題查詢依章回固定的題；假 variantService：藍本、檢索結果、進行中的 job 由 spec 決定。
     */
    function fakeDeps({ wrong = {}, sources = {}, retrieved = {}, active = {}, perSource = 3 } = {}) {
        const created = [];
        const queries = [];
        let nextJob = 100;
        return {
            created, queries,
            db: {
                async query(text, values) {
                    queries.push(values);
                    if (/FROM attempts a JOIN questions q/.test(text)) return { rows: (wrong[values[3]] || []).map(id => ({ question_id: id, error_types: [] })) };
                    throw new Error(`沒預期的查詢：${text.slice(0, 40)}`);
                }
            },
            variants: {
                maxPerRequest: () => perSource,
                async loadSource(db, id) { return sources[id] === undefined ? { id, subject: '數學', follows_question_id: null, embedding: '[1]' } : sources[id]; },
                async findRetrieved(db, source, params) { return (retrieved[source.id] || []).slice(0, params.count); },
                async findActiveJob(db, id) { return active[id] || null; },
                async createVariantJob(db, sourceId, params, budget, opts) {
                    created.push({ sourceId, params, budget, opts });
                    return { job_id: nextJob++, state: 'queued' };
                }
            }
        };
    }
    const run = (deps, units, over = {}) => F.fillShortfall({ studentId: 3, subject: '數學', days: 90, difficultyDelta: 0, units, ...over }, deps);

    test('沒有相似題：一個藍本一個 job（平均分、帶 target_student_id 與 student_id）；回報工作與說明', async () => {
        const d = fakeDeps({ wrong: { 向量內積: [11, 12] } });
        const out = await run(d, [{ unit_type: 'chapter', chapter: '向量內積', needed: 3, error_type: null }]);
        assert.deepEqual(d.created.map(c => [c.sourceId, c.params, c.opts]), [
            [11, { count: 2, difficultyDelta: 0, studentId: 3 }, { targetStudentId: 3 }],
            [12, { count: 1, difficultyDelta: 0, studentId: 3 }, { targetStudentId: 3 }]
        ]);
        assert.equal(out.generating, 3);
        assert.deepEqual(out.jobs.map(j => [j.job_id, j.existing, j.source_question_id]), [[100, false, 11], [101, false, 12]]);
        assert.deepEqual(out.units[0].items.map(i => [i.source_question_id, i.mode, i.count]), [[11, 'generating', 2], [12, 'generating', 1]]);
        assert.equal(out.capped, false);
        assert.ok(out.notes.some(n => n.includes('待複核')));
        assert.deepEqual(d.queries[0], [3, 90, '數學', '向量內積', null, F.MAX_SOURCE_CANDIDATES]);
    });

    test('先檢索：庫裡已經有夠用的相似題就不生成；不夠只生成差額；跨藍本不重複算同一題', async () => {
        const d = fakeDeps({
            wrong: { 向量內積: [11, 12] },
            retrieved: { 11: [{ id: 50, chapter: '向量內積', difficulty: 3, cosine: 0.91234 }, { id: 51, chapter: '向量內積', difficulty: 3, cosine: 0.85 }],
                12: [{ id: 50, chapter: '向量內積', difficulty: 3, cosine: 0.9 }] }
        });
        const out = await run(d, [{ unit_type: 'chapter', chapter: '向量內積', needed: 4, error_type: null }]);
        assert.deepEqual(out.units[0].items.map(i => [i.source_question_id, i.mode]), [[11, 'retrieved'], [12, 'generating']]);
        assert.deepEqual(out.units[0].items[0].retrieved.map(r => [r.id, r.cosine]), [[50, 0.9123], [51, 0.85]]);
        assert.deepEqual(d.created.map(c => [c.sourceId, c.params.count]), [[12, 2]], '#50 已經算過，第二個藍本要的 2 題都生成');
        assert.deepEqual(out.retrieved_ids, [50, 51]);
        assert.ok(out.notes.some(n => n.includes('#50、#51')));
    });

    test('整個請求最多生成 5 題：超過的不生成、capped、notes 說明', async () => {
        const d = fakeDeps({ wrong: { 向量內積: [1, 2, 3, 4], 排列: [5, 6] } });
        const out = await run(d, [
            { unit_type: 'chapter', chapter: '向量內積', needed: 4, error_type: null },
            { unit_type: 'chapter', chapter: '排列', needed: 4, error_type: null }
        ]);
        assert.equal(out.generating, 5);
        assert.equal(d.created.reduce((s, c) => s + c.params.count, 0), 5);
        assert.deepEqual(out.units.map(u => [u.generating, u.unplanned]), [[4, 0], [1, 3]]);
        assert.equal(out.capped, true);
        assert.ok(out.notes.some(n => n.includes('一次最多生成 5 題')));
    });

    test('同一藍本已經在跑：合流（existing），不建新 job、不扣額度', async () => {
        const d = fakeDeps({ wrong: { 向量內積: [11] }, active: { 11: { id: 77, state: 'extracting' } } });
        const out = await run(d, [{ unit_type: 'chapter', chapter: '向量內積', needed: 2, error_type: null }]);
        assert.equal(d.created.length, 0);
        assert.deepEqual(out.jobs, [{ job_id: 77, state: 'extracting', existing: true, source_question_id: 11, chapter: '向量內積' }]);
        assert.equal(out.generating, 0);
    });

    test('不能用的藍本跳過並說明；沒有錯題時說明改用找相似', async () => {
        const d = fakeDeps({ wrong: { 向量內積: [11, 12] }, sources: { 11: { id: 11, follows_question_id: 10, embedding: '[1]' }, 12: { id: 12, follows_question_id: null, embedding: null } } });
        const out = await run(d, [
            { unit_type: 'chapter', chapter: '向量內積', needed: 2, error_type: null },
            { unit_type: 'chapter', chapter: '排列', needed: 1, error_type: null }
        ]);
        assert.equal(d.created.length, 0);
        assert.deepEqual(out.units[0].items, [{ source_question_id: 11, mode: 'skipped', reason: 'follow_up' }, { source_question_id: 12, mode: 'skipped', reason: 'no_vector' }]);
        assert.ok(out.notes.some(n => n.includes('「向量內積」的錯題都不能當藍本')));
        assert.ok(out.notes.some(n => n.includes('「排列」在這段時間內沒有答錯的題')));
    });

    test('回應不含學生姓名（服務層根本不讀姓名）', async () => {
        const d = fakeDeps({ wrong: { 向量內積: [11] } });
        const out = await run(d, [{ unit_type: 'chapter', chapter: '向量內積', needed: 1, error_type: null }]);
        assert.ok(!/name/.test(JSON.stringify(out)));
    });
});

describe('前端純函式', () => {
    test('remedial.js：fillUnitOf／fillRequestBody／fillJobLine', async () => {
        const mod = await loadModule('remedial.js');
        const row = { bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 5, got: 2,
            error_focus: { type: 'concept', applied: true } };
        assert.deepEqual(mod.fillUnitOf(row), { unit_type: 'chapter', chapter: '向量內積', needed: 3, error_type: 'concept' });
        assert.equal(mod.fillUnitOf({ ...row, got: 5 }), null, '沒有不足');
        assert.equal(mod.fillUnitOf({ ...row, bucket: 'extension' }), null, '只補補救組');
        assert.equal(mod.fillUnitOf({ ...row, target: { type: 'kc', chapter: '向量內積', code: 'X' } }), null, '知識點沒有 kc_id 不送');
        assert.deepEqual(mod.fillUnitOf({ ...row, target: { type: 'kc', chapter: '向量內積', code: 'X' }, kc_id: 7, error_focus: { type: 'calc', applied: false } }),
            { unit_type: 'kc', chapter: '向量內積', needed: 3, kc_id: 7 });
        assert.deepEqual(mod.fillRequestBody({ subject: '數學', days: 30 }, row), { subject: '數學', days: 30, units: [{ unit_type: 'chapter', chapter: '向量內積', needed: 3, error_type: 'concept' }] });
        assert.deepEqual(mod.fillRequestBody({ subject: '數學' }, row).days, undefined);
        assert.equal(mod.MAX_FILL_GENERATE, F.MAX_FILL_GENERATE, '與伺服器同一個上限');
        const job = { job_id: 12, state: 'queued', existing: false, source_question_id: 41, chapter: '向量內積' };
        assert.equal(mod.fillJobLine(job, null), '任務 #12（向量內積，藍本：錯題 #41）：排隊中');
        assert.equal(mod.fillJobLine({ ...job, existing: true }, { state: 'done', counts: { saved: 0, needs_review: 2, pending: 0, rejected: 1 } }),
            '任務 #12（向量內積，藍本：錯題 #41，已在進行中）：完成　·　待複核 2 題、已入庫 0、不採用 1、處理中 0');
    });

    test('review.js：remedialForText', async () => {
        const mod = await loadModule('review.js');
        assert.equal(mod.remedialForText(undefined), null);
        assert.equal(mod.remedialForText({ student_id: 3, student_name: '王小明', source_question_id: 41 }), '補救卷補題：為 王小明（學生 #3）的錯題 #41 生成');
        assert.equal(mod.remedialForText({ student_id: 3, student_name: null, source_question_id: null }), '補救卷補題：為 學生 #3 生成');
    });
});
