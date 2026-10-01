// ─────────────────────────────────────────────────────────────
// test/unit/retrainContract.test.js — 錯題重練第二階段：前端送出的 body × 伺服器的參數驗證（不連 DB）
//
// PR-3（伺服器端 API-5～8、API-12）與 PR-4（public/js/retrain.js、students.js 的批改卡）是平行開發的：
// PR-4 的單元測試用 mock 回應，PR-3 的單元測試直接餵手寫的 body。這裡把兩邊接起來——
// **請求的 body 一律由前端自己的程式產生**，再交給伺服器真正用的那一支驗證函式（utils/retrainValidation.js），
// 確認沒有被 400 擋下、解析出來的值就是前端想送的值；上下限兩邊一致（前端擋掉的，伺服器也會擋）。
// 真的打進伺服器、走完資料庫的全流程在 test/integration/retrainFlow.pg.test.js。
//
// 前端的來源：
//   public/js/retrain.js     錯題重練卡（API-1 查詢、API-2、API-3、API-5、API-7、API-12、API-13 查詢）
//   public/js/students.js    批改卡（API-10 的 results[i].retrain）
//   public/js/remedial.js    補救卷（API-8 的 retrain_count、API-7）
//   public/index.html        組卷頁〔retrain〕掛鉤（API-6 的 retrain、API-7）；抽法同 test/unit/retrainPaperUi.test.js
// ─────────────────────────────────────────────────────────────
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const v = require('../../utils/retrainValidation');
const { capForAttach } = require('../../services/retrainSchedule');
const { DEFAULT_ATTACH_RATIO } = require('../../config/retrain');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const TODAY = '2026-10-12';

let seq = 0;
async function loadModule(name) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8') + `\n// retrainContract instance ${++seq}\n`;
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}

/** 組卷頁〔retrain〕掛鉤的純函式（勾選框狀態由 attach 決定：null＝沒勾）。 */
function paperPageHooks(attach) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const begin = html.indexOf('// 〔retrain〕組卷頁掛鉤 開始');
    const end = html.indexOf('// 〔retrain〕組卷頁掛鉤 結束');
    assert.ok(begin > 0 && end > begin, 'index.html 找不到〔retrain〕組卷頁掛鉤的開始／結束標記');
    const featureOn = html.match(/function featureOn\(name\) \{[\s\S]*?\n {8}\}/)[0];
    const nodes = {
        retrainAttach: { checked: attach !== null },
        retrainAttachCount: { value: attach === null ? '' : String(attach) }
    };
    const metas = { 'meta[name="feature-retrain"]': { content: 'true' }, 'meta[name="retrain-attach-ratio"]': { content: String(DEFAULT_ATTACH_RATIO) } };
    const document = {
        getElementById: id => nodes[id] || { value: '', addEventListener() { } },
        querySelector: sel => metas[sel] || null
    };
    return new Function('document', 'selectedStudent', 'apiFetch',
        `${featureOn}\n${html.slice(begin, end)}\nreturn { retrainCapForAttach, retrainAttachRatio, retrainAttachRequest, retrainConfirmKeys };`)(
        document, () => null, () => Promise.reject(new Error('not used')));
}

/** URLSearchParams → 伺服器 req.query 的形狀（Express 的 query parser：同名一個就是字串）。 */
const toQuery = params => Object.fromEntries(new URLSearchParams(params).entries());

let retrainUi, studentsUi, remedialUi;
before(async () => {
    retrainUi = await loadModule('retrain.js');
    studentsUi = await loadModule('students.js');
    remedialUi = await loadModule('remedial.js');
});

describe('錯題重練卡（retrain.js）× 伺服器', () => {
    test('API-5：retrainPaperBody 的每一種組合都過 parseRetrainPaperBody，解析出來就是前端選的值', () => {
        const cases = [
            [{ count: retrainUi.DEFAULT_PAPER_COUNT }, { subject: null, count: 10, asOf: TODAY, includeNotDue: false }],
            [{ count: 1, subject: '', asOf: '', includeNotDue: false }, { subject: null, count: 1, asOf: TODAY, includeNotDue: false }],
            [{ count: 50, subject: '數學', asOf: '2026-10-15', includeNotDue: true }, { subject: '數學', count: 50, asOf: '2026-10-15', includeNotDue: true }]
        ];
        for (const [input, expected] of cases) {
            const body = retrainUi.retrainPaperBody(input);
            assert.deepEqual(v.parseRetrainPaperBody(JSON.parse(JSON.stringify(body)), { today: TODAY }), expected, JSON.stringify(input));
        }
        assert.equal(retrainUi.DEFAULT_PAPER_COUNT, v.DEFAULT_RETRAIN_PAPER_COUNT, '前端的預設題數＝伺服器沒帶 count 時的預設');
    });

    test('API-5：題數輸入框的上下限與伺服器一致（前端擋掉的，伺服器也擋）', () => {
        for (const raw of ['0', '1', '10', '50', '51', '-1', '2.5', 'abc', '']) {
            const n = retrainUi.parseCount(raw);
            const asNumber = Number(raw);
            const server = v.parseRetrainPaperBody({ count: Number.isFinite(asNumber) && raw !== '' ? asNumber : raw }, { today: TODAY });
            assert.equal(n !== null, !server.error, `題數 ${JSON.stringify(raw)}：前端 ${n}、伺服器 ${JSON.stringify(server)}`);
        }
    });

    test('API-7：API-5 回應 → draftFromResponse → confirmBody（純重練卷：retrain_question_ids＝question_ids）過 parseConfirmRetrain', () => {
        const api5 = {
            student_id: 3, subject: '數學', as_of: TODAY, question_ids: [640, 641, 812],
            items: [
                { question_id: 812, item_id: 31, step: 2, step_label: '一週回測', due_on: TODAY, overdue_days: 0, chapter: '向量內積',
                    difficulty: 3, question_text_preview: '…', follows_question_id: null, group_ids: [812], status: 'active', due: true },
                { question_id: 640, item_id: 20, step: 1, step_label: '錯題重練', due_on: '2026-10-10', overdue_days: 2, chapter: '外積',
                    difficulty: 2, question_text_preview: '…', follows_question_id: null, group_ids: [640, 641], status: 'active', due: true },
                { question_id: 641, item_id: 21, step: 1, step_label: '錯題重練', due_on: '2026-10-10', overdue_days: 2, chapter: '外積',
                    difficulty: 2, question_text_preview: '…', follows_question_id: 640, group_ids: [640, 641], status: 'active', due: true }
            ],
            due_total: 3, notes: []
        };
        const draft = retrainUi.draftFromResponse(api5, { id: 3, name: '王小明' });
        const body = retrainUi.confirmBody(draft);
        assert.deepEqual(v.parseConfirmRetrain(body, { enabled: true }), { value: [812, 640, 641] });
        assert.deepEqual(new Set(body.retrain_question_ids), new Set(body.question_ids));
        // 刪掉一組之後照樣是子集
        const trimmed = retrainUi.confirmBody(retrainUi.removeGroup(draft, 641));
        assert.deepEqual(trimmed, { student_id: 3, question_ids: [812], retrain_question_ids: [812] });
        assert.deepEqual(v.parseConfirmRetrain(trimmed, { enabled: true }), { value: [812] });
        assert.deepEqual(v.parseConfirmRetrain(body, { enabled: false }), { error: v.RETRAIN_DISABLED_MESSAGE });
    });

    test('API-12：wordDownloadRequest 帶的 paper_id 過 parseWordPaperId；旗標關閉時伺服器忽略', () => {
        const paper = { paper_id: 91, paper_title: '王小明-錯題重練卷(2026_10_12)', student_name: '王小明', question_ids: [812] };
        for (const [edition] of retrainUi.WORD_EDITIONS) {
            const { body } = retrainUi.wordDownloadRequest(paper, edition);
            assert.deepEqual(v.parseWordPaperId(body, { enabled: true }), { paperId: 91 }, edition);
            assert.deepEqual(v.parseWordPaperId(body, { enabled: false }), { paperId: null }, edition);
            assert.equal(body.edition, edition);
        }
    });

    test('API-2、API-3：手動加入題號與三個動作的 body 過伺服器驗證', () => {
        const { ids } = retrainUi.parseQuestionIds('#812, 640、641 812');
        assert.deepEqual(v.parseAddBody({ question_ids: ids }), { questionIds: [812, 640, 641] });
        assert.equal(retrainUi.MAX_ADD_IDS, v.MAX_ADD_IDS);
        for (const action of ['retire', 'mark_mastered', 'reactivate']) {
            assert.deepEqual(v.parseActionBody(retrainUi.actionBody(action)), { action, hasNote: false, note: null });
        }
    });

    test('API-1、API-13 的查詢參數（retrain.js 的 refresh 組法）：學生分頁可選的時間窗全都合法', () => {
        for (const status of retrainUi.STATUS_FILTERS.map(f => f[0])) {
            const q = toQuery({ status, subject: '數學', as_of: TODAY });
            assert.deepEqual(v.parseListQuery(q, { today: TODAY }), { status, subject: '數學', asOf: TODAY }, status);
        }
        for (const days of [30, 90, 180, 365]) {       // students.js 的 DAYS_OPTIONS
            assert.deepEqual(v.parseStatsQuery(toQuery({ days: String(days), subject: '物理' })), { days, subject: '物理' });
        }
    });
});

describe('批改卡（students.js）× 伺服器', () => {
    const original = [
        { question_id: 1, result: null, score: null, error_types: [], response: null, note: null, retrain: false },
        { question_id: 2, result: null, score: null, error_types: [], response: null, note: null, retrain: true },
        { question_id: 3, result: null, score: null, error_types: [], response: null, note: null }     // 重練題：沒有 retrain 鍵
    ];

    test('API-10：diffResults 只在勾選改過時送 retrain，parseRetrainFlags 讀到的就是那幾題', () => {
        const current = original.map(r => ({ ...r, error_types: [...r.error_types] }));
        current[0].result = 0; current[0].retrain = true;       // 勾
        current[1].result = 1; current[1].retrain = false;      // 取消勾
        current[2].result = 1;                                  // 重練題：只記對錯
        const results = studentsUi.diffResults(original, current);
        assert.deepEqual(results, [
            { question_id: 1, result: 0, retrain: true },
            { question_id: 2, result: 1, retrain: false },
            { question_id: 3, result: 1 }
        ]);
        assert.deepEqual(v.parseRetrainFlags({ results }, { enabled: true }),
            { flags: [{ question_id: 1, retrain: true }, { question_id: 2, retrain: false }] });
    });

    test('API-10：沒改勾選時不送 retrain 鍵（旗標關閉時伺服器也不會 400）', () => {
        const current = original.map(r => ({ ...r, error_types: [...r.error_types] }));
        current[0].result = 1;
        const results = studentsUi.diffResults(original, current);
        assert.deepEqual(results, [{ question_id: 1, result: 1 }]);
        assert.deepEqual(v.parseRetrainFlags({ results }, { enabled: false }), { flags: [] });
    });

    test('API-10 的回應摘要 → 儲存後的提示', () => {
        assert.equal(studentsUi.retrainSaveMessage({ entered: 3, advanced: 0, mastered: 1, reset: 0 }), '3 題進入重練清單、1 題練到會。');
        assert.equal(studentsUi.retrainSaveMessage({ entered: 0, advanced: 0, mastered: 0, reset: 0 }), '');
    });
});

describe('組卷頁〔retrain〕與補救卷（remedial.js）× 伺服器', () => {
    test('API-6：勾了「附上到期的重練題」的 retrain 過 parseAttachParam；預設題數與伺服器的 capForAttach 相同', () => {
        for (const newCount of [1, 3, 7, 20, 40, 50]) {
            const n = capForAttach(newCount, DEFAULT_ATTACH_RATIO);
            const hooks = paperPageHooks(n);
            assert.equal(hooks.retrainCapForAttach(newCount, hooks.retrainAttachRatio()), n, `新題 ${newCount} 題`);
            const req = hooks.retrainAttachRequest();
            assert.deepEqual(req, { count: n });
            assert.deepEqual(v.parseAttachParam(req, { enabled: true, newCount, today: TODAY }), { value: { count: n, asOf: TODAY } });
        }
        assert.equal(paperPageHooks(null).retrainAttachRequest(), null, '沒勾＝不帶 retrain');
    });

    test('API-7（組卷頁）：預覽有附重練題才帶 retrain_question_ids，而且是 question_ids 的子集', () => {
        const hooks = paperPageHooks(2);
        const preview = {
            question_ids: [5, 812, 6], retrain: { wanted: 2, got: 1, due_total: 1 },
            questions: [{ id: 5, purpose: 'new' }, { id: 812, purpose: 'retrain', retrain_step: 2 }, { id: 6, purpose: 'new' }]
        };
        const body = { student_id: 3, question_ids: preview.question_ids, ...hooks.retrainConfirmKeys(preview) };
        assert.deepEqual(v.parseConfirmRetrain(body, { enabled: true }), { value: [812] });
        const { retrain, ...plain } = preview;
        assert.deepEqual(hooks.retrainConfirmKeys(plain), {}, '沒附重練題的預覽：確認的 body 與以前逐字相同');
    });

    test('API-8：remedialRequestBody 的 retrain_count 過 parseRemedialRetrain；上限與預設與伺服器一致', () => {
        assert.equal(remedialUi.MAX_RETRAIN_COUNT, v.MAX_REMEDIAL_RETRAIN);
        for (const total of [5, 20, 40]) {
            const n = remedialUi.retrainDefaultCount(total, DEFAULT_ATTACH_RATIO);
            assert.equal(n, Math.min(capForAttach(total, DEFAULT_ATTACH_RATIO), v.MAX_REMEDIAL_RETRAIN), `題數 ${total}`);
            const body = remedialUi.remedialRequestBody({ subject: '數學', total, mix: { remedial: 1 }, days: 90, scope: 'all', retrainCount: n });
            assert.deepEqual(v.parseRemedialRetrain(body, { enabled: true, total }), { count: n });
        }
        const none = remedialUi.remedialRequestBody({ subject: '數學', total: 10, mix: { remedial: 1 }, days: 90, scope: 'all', retrainCount: 0 });
        assert.ok(!('retrain_count' in none), '沒勾＝不帶（回應與以前逐字相同）');
        assert.deepEqual(v.parseRemedialRetrain(none, { enabled: false, total: 10 }), { count: 0 });
    });

    test('API-7（補救卷）：草稿的「到期重練」組 → retrain_question_ids 過 parseConfirmRetrain', () => {
        const draft = {
            question_ids: [11, 812, 12],
            items: [{ question_id: 11, bucket: 'remedial' }, { question_id: 812, bucket: 'retrain' }, { question_id: 12, bucket: 'extension' }]
        };
        const body = { student_id: 3, question_ids: draft.question_ids, ...remedialUi.retrainConfirmKeys(draft) };
        assert.deepEqual(v.parseConfirmRetrain(body, { enabled: true }), { value: [812] });
    });
});
