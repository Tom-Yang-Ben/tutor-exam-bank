// ─────────────────────────────────────────────────────────────
// test/unit/studentReport.test.js — 學習報告的純函式（〔dec/r16-remedial〕；docs/student-report.md）
//
//   services/studentReportService.js  建議規則（每一條的觸發與不觸發）、報告組裝、家長版拿掉內部代碼、HTML 跳脫與不連外、
//                                     批改量查詢只讀檢視 attempts（R10）
//   services/studentReportDocx.js     產出合法的 .docx、內容與讀者一致
//   controllers/reportController.js   查詢參數
//   public/js/students.js             reportUrl
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';

const R = require('../../services/studentReportService');
const { buildReportDocx } = require('../../services/studentReportDocx');
const { _internals: { parseReportQuery, reportFileName } } = require('../../controllers/reportController');
const { documentXml } = require('../e2e/lib/docx');

/** 一份典型的原始資料（可覆寫）。 */
function raw(over = {}) {
    return {
        student: { id: 3, name: '王小明' }, days: 30, today: '2026-10-03', from: '2026-09-03', minN: 5,
        summary: { assigned: 20, graded: 18, correct: 11.5, papers: 3 },
        byChapter: [
            { chapter: '向量內積', assigned: 8, graded: 8, wrong: 5, wrong_rate: 0.625 },
            { chapter: '排列', assigned: 3, graded: 3, wrong: 2, wrong_rate: 0.6667 },
            { chapter: '組合', assigned: 7, graded: 7, wrong: 1, wrong_rate: 0.1429 },
            { chapter: '實數', assigned: 2, graded: 0, wrong: 0, wrong_rate: null }
        ],
        byErrorType: [{ error_type: 'concept', count: 4, share: 0.5 }, { error_type: 'calc', count: 2, share: 0.25 }],
        trend: [{ week_start: '2026-09-07', graded: 6, wrong: 4 }, { week_start: '2026-09-14', graded: 6, wrong: 3 }, { week_start: '2026-09-21', graded: 6, wrong: 1 }],
        retrain: null, remedial: null, ...over
    };
}
const codes = r => r.suggestions.map(s => s.code);

describe('assembleReport', () => {
    test('形狀：期間、批改量（答對率）、最弱章節（只列有批改、樣本不足標記）、錯因標籤、趨勢答對率、建議', () => {
        const r = R.assembleReport(raw());
        assert.deepEqual(Object.keys(r), ['student', 'audience', 'generated_on', 'period', 'min_n', 'summary', 'weakest_chapters',
            'error_types', 'weekly_trend', 'retrain', 'remedial_effect', 'suggestions']);
        assert.deepEqual(r.period, { days: 30, from: '2026-09-03', to: '2026-10-03' });
        assert.deepEqual(r.summary, { papers: 3, assigned: 20, graded: 18, correct: 11.5, correct_rate: 0.6389 });
        assert.deepEqual(r.weakest_chapters.map(c => [c.chapter, c.low_sample]), [['向量內積', false], ['排列', true], ['組合', false]]);
        assert.deepEqual(r.error_types[0], { code: 'concept', label: '觀念不清', count: 4, share: 0.5 });
        assert.deepEqual(r.weekly_trend.map(w => w.correct_rate), [0.3333, 0.5, 0.8333]);
        assert.equal(r.retrain, null);
        assert.equal(r.remedial_effect, null);
    });

    test('同一份資料組兩次逐字相同（確定性，沒有 LLM、沒有隨機）', () => {
        assert.deepEqual(R.assembleReport(raw()), R.assembleReport(raw()));
    });
});

describe('buildSuggestions（規則）', () => {
    test('沒有批改：只有 no_data', () => {
        const r = R.assembleReport(raw({ summary: { assigned: 3, graded: 0, correct: 0, papers: 1 }, byChapter: [], byErrorType: [], trend: [] }));
        assert.deepEqual(codes(r), ['no_data']);
    });

    test('典型資料：弱章節（樣本夠、錯誤率 ≥ 0.4）→ 錯因主因 → 趨勢進步 → 樣本不足；排列（3 題）不算弱章節', () => {
        const r = R.assembleReport(raw());
        assert.deepEqual(codes(r), ['weak_chapter', 'error_focus:concept', 'trend_up', 'need_more_data']);
        assert.match(r.suggestions[0].text, /「向量內積」錯誤率 63%（批改 8 題、錯 5 題）/);
        assert.match(r.suggestions[1].text, /觀念不清.*先用短的觀念檢查題/);
        assert.equal(r.suggestions[1].parent_text, R.PARENT_ERROR_TEXT.concept);
        assert.equal(r.suggestions[3].parent_text, null, '樣本不足不寫給家長');
    });

    test('錯因主因：同票或次數不夠不提；趨勢退步', () => {
        const tie = R.assembleReport(raw({ byErrorType: [{ error_type: 'concept', count: 2, share: 0.4 }, { error_type: 'calc', count: 2, share: 0.4 }] }));
        assert.ok(!codes(tie).some(c => c.startsWith('error_focus')));
        const one = R.assembleReport(raw({ byErrorType: [{ error_type: 'calc', count: 1, share: 1 }] }));
        assert.ok(!codes(one).some(c => c.startsWith('error_focus')));
        const down = R.assembleReport(raw({ trend: [{ week_start: 'a', graded: 5, wrong: 1 }, { week_start: 'b', graded: 5, wrong: 4 }] }));
        assert.ok(codes(down).includes('trend_down'));
        const flat = R.assembleReport(raw({ trend: [{ week_start: 'a', graded: 5, wrong: 2 }, { week_start: 'b', graded: 2, wrong: 2 }] }));
        assert.ok(!codes(flat).some(c => c.startsWith('trend')), '批改不到 3 題的週不算');
    });

    test('重練卡關與到期、補救成效的進步與退步；最多 6 條', () => {
        const r = R.assembleReport(raw({
            retrain: { active: 4, mastered: 2, stuck: 1, first_retrain: { graded: 3, correct: 2, rate: 0.6667 }, spaced: { graded: 0, correct: 0, rate: null }, backlog: { due_now: 2 } },
            remedial: { papers: [{ targets: [
                { unit_type: 'chapter', chapter: '向量內積', name: '向量內積', status: 'improved', before: { correct_rate: 0.2 }, after: { rate: 0.8, graded: 4 }, low_sample: true },
                { unit_type: 'chapter', chapter: '排列', name: '排列', status: 'worse', before: { correct_rate: 0.6 }, after: { rate: 0.2, graded: 5 }, low_sample: false }
            ] }] }
        }));
        assert.equal(r.suggestions.length, R.MAX_SUGGESTIONS);
        assert.deepEqual(codes(r), ['weak_chapter', 'error_focus:concept', 'trend_up', 'retrain_stuck', 'retrain_due', 'remedial_improved']);
        assert.deepEqual(r.retrain, { active: 4, mastered: 2, stuck: 1, first_retrain: { graded: 3, correct: 2, rate: 0.6667 }, spaced: { graded: 0, correct: 0, rate: null }, due_now: 2 });
        assert.deepEqual(r.remedial_effect.counts, { improved: 1, no_change: 0, worse: 1, insufficient_data: 0, pending: 0 });
        const noTrend = R.assembleReport(raw({ trend: [], byErrorType: [], remedial: { papers: [{ targets: [
            { unit_type: 'chapter', chapter: '排列', name: '排列', status: 'worse', before: {}, after: {} }] }] } }));
        assert.ok(codes(noTrend).includes('remedial_worse'));
    });

    test('補救成效摘要：同一個單位只看最新的一份補救卷', () => {
        const s = R.summarizeEffect({ papers: [
            { targets: [{ unit_type: 'chapter', chapter: '排列', name: '排列', status: 'pending', before: {}, after: {} }] },
            { targets: [{ unit_type: 'chapter', chapter: '排列', name: '排列', status: 'improved', before: {}, after: {} }] }
        ] });
        assert.deepEqual(s.units.map(u => u.status), ['pending']);
        assert.equal(s.papers, 2);
    });
});

describe('家長版與老師版', () => {
    const full = () => R.assembleReport(raw({
        retrain: { active: 4, mastered: 2, stuck: 1, first_retrain: { rate: 0.5 }, spaced: { rate: null }, backlog: { due_now: 2 } },
        remedial: { papers: [{ targets: [{ unit_type: 'kc', kc_id: 9, chapter: '向量內積', name: '內積的意義', status: 'improved', before: { correct_rate: 0.2 }, after: { rate: 0.8, graded: 4 }, low_sample: true }] }] }
    }));

    test('家長版：沒有內部代碼與統計旗標；建議只留白話的那一句', () => {
        const p = R.forAudience(full(), 'parent');
        const json = JSON.stringify(p);
        for (const banned of ['"code"', 'low_sample', 'wrong_rate', 'concept', 'kc_id', 'error_focus', '"id"', 'parent_text', 'min_n']) {
            assert.ok(!json.includes(banned), `家長版不該有 ${banned}`);
        }
        assert.deepEqual(p.error_types[0], { label: '觀念不清', count: 4 });
        assert.deepEqual(p.remedial_effect.units, [{ name: '內積的意義', result: '進步' }]);
        assert.deepEqual(p.retrain, { practicing: 4, mastered: 2 });
        assert.ok(p.suggestions.every(s => Object.keys(s).join() === 'text'));
        assert.ok(!p.suggestions.some(s => /補救卷|重練已經到期/.test(s.text)), '給家長的不是操作指示');
    });

    test('老師版：保留代碼；建議不帶 parent_text', () => {
        const t = R.forAudience(full(), 'teacher');
        assert.equal(t.audience, 'teacher');
        assert.ok(t.suggestions.every(s => Object.keys(s).join() === 'code,text'));
        assert.equal(t.error_types[0].code, 'concept');
    });

    test('HTML：完整的可列印頁、資料一律跳脫、不連外部資源；家長版不出現錯因代碼', () => {
        const r = R.assembleReport(raw({ student: { id: 3, name: '<script>alert(1)</script>' } }));
        const html = R.renderReportHtml(R.forAudience(r, 'teacher'));
        assert.match(html, /^<!DOCTYPE html>/);
        assert.ok(!html.includes('<script>'), '姓名被跳脫');
        assert.ok(html.includes('&lt;script&gt;'));
        assert.ok(!/https?:\/\//.test(html), '本機模式：不連外');
        assert.match(html, /@media print/);
        assert.ok(html.includes('學習報告（老師版）'));
        const parentHtml = R.renderReportHtml(R.forAudience(r, 'parent'));
        assert.ok(parentHtml.includes('給家長的學習報告'));
        assert.ok(!/concept|calc/.test(parentHtml));
    });

    test('Word：合法的 .docx，內容依讀者', async () => {
        const buf = await buildReportDocx(R.forAudience(full(), 'parent'));
        assert.equal(buf.subarray(0, 2).toString(), 'PK');
        const xml = await documentXml(buf);
        assert.ok(xml.includes('給家長的學習報告－王小明'));
        assert.ok(xml.includes('需要加強的單元'));
        assert.ok(!xml.includes('concept'));
        const tXml = await documentXml(await buildReportDocx(R.forAudience(full(), 'teacher')));
        assert.ok(tXml.includes('錯因分布') && tXml.includes('concept'));
    });
});

describe('查詢參數、檔名、SQL、前端網址', () => {
    test('parseReportQuery', () => {
        assert.deepEqual(parseReportQuery({}), { days: 30, audience: 'teacher', format: 'json' });
        assert.deepEqual(parseReportQuery({ days: '90', audience: 'parent', format: 'docx' }), { days: 90, audience: 'parent', format: 'docx' });
        for (const q of [{ days: '0' }, { days: '366' }, { days: 'x' }, { audience: 'student' }, { format: 'pdf' }, { days: ['1', '2'] }]) {
            assert.ok(parseReportQuery(q).error, JSON.stringify(q));
        }
        assert.equal(reportFileName({ student: { name: '王小明' }, period: { from: '2026-09-03', to: '2026-10-03' }, audience: 'parent' }),
            '學習報告-王小明(2026-09-03_2026-10-03)（家長版）');
    });

    test('批改量只讀檢視 attempts（R10：重練不算）', () => {
        const q = R.buildSummaryQuery({ studentId: 3, days: 30 });
        assert.deepEqual(q.values, [3, 30]);
        assert.match(q.text, /FROM attempts a\b/);
        assert.ok(!/assignment_attempts|FROM assignments/.test(q.text));
    });

    test('students.js：reportUrl', async () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'students.js'), 'utf8');
        const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src + '\n// report\n'));
        assert.equal(mod.reportUrl(3, { days: '30', audience: 'parent', format: 'html' }), '/api/students/3/report?days=30&audience=parent&format=html');
        assert.deepEqual(mod.REPORT_AUDIENCES.map(a => a[0]), R.AUDIENCES);
    });
});
