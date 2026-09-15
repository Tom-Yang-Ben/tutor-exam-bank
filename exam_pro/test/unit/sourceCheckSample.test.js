// ─────────────────────────────────────────────────────────────
// sourceCheckSample.test.js — 公開樣卷的原卷比對（CI 的 unit job 就擋誤報）
//
// 用 mupdf 讀 eval/fixtures/sample_exam.pdf 的文字層，拿 extract.v2 cassette 的 10 題
// 走一遍與 runner 相同的「定位 → 比對」：
//   1. 0 題 mismatch（docs/source-check.md 的校準：樣卷可比對 5、跳過 5、誤報 0）；
//   2. 把其中一題的單位字母刪掉一個 → 變 mismatch（證明比對器不是永遠回 match）。
// 樣卷是本專案自製的（見 PDF 內文），不涉及任何真實考卷。
// ─────────────────────────────────────────────────────────────
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPagesText } = require('../../services/sourceTextService');
const { locateSegments, compareSegment } = require('../../utils/sourceCheck');

const APP_DIR = path.resolve(__dirname, '..', '..');
const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');
const CASSETTE_DIR = path.join(APP_DIR, 'eval', 'cassettes', 'extract');

function loadCassetteQuestions() {
    const files = fs.readdirSync(CASSETTE_DIR).filter(f => f.endsWith('.json'));
    const docs = files.map(f => JSON.parse(fs.readFileSync(path.join(CASSETTE_DIR, f), 'utf8')))
        .filter(d => d.meta && d.meta.template === 'extract.v2');
    assert.equal(docs.length, 1, 'eval/cassettes/extract/ 底下 extract.v2 的 cassette 應該恰好一份');
    return docs[0].response.data.questions;
}

function runAll(questions, text) {
    const located = locateSegments(questions, text);
    return questions.map((q, i) => {
        const loc = located[i];
        if (loc.status !== 'located') return { idx: q.idx, verdict: 'skipped', reason: loc.status };
        const r = compareSegment({ questionText: q.question_text, segment: loc.segment, hasFigure: Boolean(q.figure_desc) });
        return { idx: q.idx, ...r, segment: loc.segment };
    });
}

describe('公開樣卷 × extract.v2 cassette 的原卷比對', () => {
    let questions;
    let text;

    before(async () => {
        questions = loadCassetteQuestions();
        ({ text } = await readPagesText(fs.readFileSync(SAMPLE_PDF), 1, null));
    });

    test('10 題 0 誤報：可比對 5、跳過 5', () => {
        assert.equal(questions.length, 10);
        const results = runAll(questions, text);
        const mismatched = results.filter(r => r.verdict === 'mismatch');
        assert.deepEqual(mismatched.map(r => ({ idx: r.idx, signals: r.signals })), [], '樣卷不得有任何誤報');
        assert.equal(results.filter(r => r.verdict === 'match').length, 5);
        assert.equal(results.filter(r => r.verdict === 'skipped').length, 5);
    });

    test('把一題的單位字母漏掉一個 → mismatch', () => {
        const target = questions.find(q => /kg/.test(q.question_text));
        assert.ok(target, '樣卷應該有一題帶 kg 單位');
        const mutated = questions.map(q => (q === target ? { ...q, question_text: q.question_text.replace('kg', 'g') } : q));
        const r = runAll(mutated, text).find(x => x.idx === target.idx);
        assert.equal(r.verdict, 'mismatch', JSON.stringify(r.signals));
        assert.deepEqual(r.rules, ['missing_lower']);
        assert.deepEqual(r.detail.missing_lower, { k: 1 });
    });

    test('文字層真的抽得出來（樣卷是向量字型，不是掃描檔）', () => {
        assert.ok(text.replace(/\s/g, '').length > 200);
    });
});
