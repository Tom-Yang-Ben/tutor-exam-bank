// ─────────────────────────────────────────────────────────────
// test/unit/evalPipelineVerifyAgree.test.js — pipeline eval 的 verify_agree_rate 門檻（Owner 2026-10-02 A 案；docs/local-mode.md 10.25 第 6 點）
//
//   拆題改成「題目頁沒答案就不編」之後，樣卷 10 題都是 no_claim，answer_agree_rate 沒有分母。
//   ① verify_agree_rate＝no_claim 題：驗算模型的答案對答案卷 answer_text 的一致率，進 SUITE_METRICS、measured，門檻 0.87
//      （首次實測 0.9000 − 0.03）。
//   ② answer_agree_rate 定義與門檻不變；只在「全部題目都是 no_claim」時 n/a、不算失敗，有任何一題不是 no_claim 就照舊比 0.87。
//   ③ verify_agree_rate 在「沒有任何一題是 no_claim」時 n/a、不算失敗（兩個條件互斥，有題時至少一個照比）。
// 不連 DB、不呼叫模型（pipelineDriver.runPipeline 換成假的，答案卷用 repo 裡真的樣卷答案卷）。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const th = require('../../eval/lib/thresholds');
const driver = require('../../eval/lib/pipelineDriver');
const suite = require('../../eval/lib/suitePipeline');
const report2 = require('../../eval/lib/report2');
const { thresholdRows } = require('../../eval/lib/cassettePlan');

const THRESHOLDS_FILE = path.resolve(__dirname, '..', '..', 'eval', 'thresholds.json');
const FILE = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));

// 樣卷答案卷（eval/golden/pdf_sample/<sha>.json）裡的三題，題幹逐字照抄，pdfMatch 才配得上
const Q1 = { text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $12$', type: '單選', form: 'option' };     // 標準答案 (A)
const Q5 = { text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', type: '計算', form: 'number' };                                      // 標準答案 5 m/s^2
const Q6 = { text: '長 $1$ m 的輕繩繫住質量 $2$ kg 的小球，在光滑水平面上以 $3$ m/s 的速率作等速圓周運動，求繩的張力。', type: '計算', form: 'number' }; // 18 N

/** 一題走完管線的樣子（driver.runPipeline 的 jq 列） */
function row(idx, q, compare, verifyAnswer) {
    return {
        idx, state: 'needs_review', review_reason: 'ocr_only', retries: 0,
        payload: {
            extract: { question_text: q.text, question_type: q.type, chapter: 'x' },
            classify: { source: 'gate', chapter: 'x' },
            verify: { compare, final_answer: verifyAnswer, answer_form: q.form }
        }
    };
}

/** 用假的 driver.runPipeline 跑 runPipelineSuite（其餘照真的：答案卷、answerCompare、pdfMatch） */
async function runWith(jq) {
    const orig = driver.runPipeline;
    driver.runPipeline = async () => ({
        ok: true, jq, events: [], warnings: [],
        totals: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, costUsd: 0, latencyMs: 0 },
        agentSources: { extract: 'agents/extract.js', classify: 'agents/classify.js', verify: 'agents/verify.js' },
        stateMachine: 'pipeline/stateMachine.js', db: null, thresholds: {}
    });
    try { return await suite.runPipelineSuite({}); } finally { driver.runPipeline = orig; }
}

describe('契約：SUITE_METRICS、白名單、thresholds.json', () => {
    test('SUITE_METRICS.pipeline 多 verify_agree_rate（排在原本三個之後）', () => {
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕之後再多 chapter_acc_rate（排在最後；test/unit/evalPipelineChapterAcc.test.js）
        assert.deepEqual(th.SUITE_METRICS.pipeline,
            { columns: ['pipeline'], metrics: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate', 'chapter_acc_rate'] });
    });

    test('NOT_APPLICABLE_ALLOWED 多 answer_agree_rate 與 verify_agree_rate（chapter_acc_rate 不能宣告不比）', () => {
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕gate_pass_rate 也進白名單（只有 OCR 模式宣告）；不在白名單的改用 chapter_acc_rate 驗
        assert.deepEqual(th.NOT_APPLICABLE_ALLOWED, { pipeline: { pipeline: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate'] } });
        assert.throws(() => th.compareSuite(FILE, 'pipeline', { pipeline: { chapter_acc_rate: null } },
            { notApplicable: { pipeline: { chapter_acc_rate: 'x' } } }), /白名單/);
    });

    test('thresholds.json：verify_agree_rate 0.87（首次實測 0.9000 − 0.03），原本三個數字不動，來源照慣例記在 pipeline 節', () => {
        assert.deepEqual(FILE.pipeline.pipeline,
            // 〔Owner 2026-10-03 第 r14 輪 C-1〕多 chapter_acc_rate（evalPipelineChapterAcc.test.js），其餘不動；
            // 〔r15 dec/r15-chapter-acc〕chapter_acc_rate 實測 1.0000 之後 ratchet 0.77 → 0.97
            { saved_rate: 0.87, gate_pass_rate: 0.97, answer_agree_rate: 0.87, verify_agree_rate: 0.87, chapter_acc_rate: 0.97 });
        assert.equal(Math.round((0.9 - th.BASELINE_MARGIN) * 10000) / 10000, FILE.pipeline.pipeline.verify_agree_rate);
        const note = FILE.pipeline._note_verify_agree_rate;
        assert.ok(typeof note === 'string', 'pipeline 節要有 _note_verify_agree_rate');
        for (const s of ['Owner 2026-10-02', 'A 案', '0.9000', '− 0.03', 'answer_text', '只升不降']) assert.ok(note.includes(s), `來源說明沒寫到 ${s}`);
        // 其他 suite 的門檻一個數字都沒動
        assert.deepEqual(FILE.classify.classify, { accuracy: 0.87, macro_f1: 0.8956 });
        assert.deepEqual(FILE.variant.variant, { retrieved_coverage: 0.8367, gate_pass_rate: 0.22 });
    });
});

describe('verify_agree_rate 的計算（runPipelineSuite，假 driver）', () => {
    test('全部題目都是 no_claim：verify_agree_rate＝對答案卷 answer_text 的一致率；answer_agree_rate n/a、宣告不比', async () => {
        const res = await runWith([row(0, Q1, 'no_claim', '(A)'), row(1, Q5, 'no_claim', '5'), row(2, Q6, 'no_claim', '20')]);
        const m = res.measured.pipeline;
        assert.equal(m.answer_agree_rate, null);
        // Q1 (A) 對、Q5 5 對（答案卷 answer_text 有 a = … = 5）、Q6 20 對 18 不一致
        assert.equal(m.verify_agree_rate, 0.6667);
        assert.equal(m.verify_agree_rate, res.verifyAgree.by_answer_text.rate, '門檻比的是 answer_text 那一個，不是 final_answer');
        assert.notEqual(res.verifyAgree.by_final_answer.rate, m.verify_agree_rate);
        assert.equal(res.notApplicable.pipeline.answer_agree_rate, suite.ALL_NO_CLAIM_NOTE);
        assert.equal('verify_agree_rate' in res.notApplicable.pipeline, false);
    });

    test('有任何一題不是 no_claim：兩個指標都量、都不宣告不比', async () => {
        const res = await runWith([row(0, Q1, 'agree', '(A)'), row(1, Q5, 'no_claim', '5')]);
        const m = res.measured.pipeline;
        assert.equal(m.answer_agree_rate, 1);
        assert.equal(m.verify_agree_rate, 1);
        const na = (res.notApplicable && res.notApplicable.pipeline) || {};
        assert.equal('answer_agree_rate' in na, false);
        assert.equal('verify_agree_rate' in na, false);
    });

    test('沒有任何一題是 no_claim：verify_agree_rate n/a、宣告不比；answer_agree_rate 照舊量', async () => {
        const res = await runWith([row(0, Q1, 'agree', '(A)'), row(1, Q5, 'disagree', '7')]);
        const m = res.measured.pipeline;
        assert.equal(m.answer_agree_rate, 0.5);
        assert.equal(m.verify_agree_rate, null);
        assert.equal(res.verifyAgree, undefined);
        assert.equal(res.notApplicable.pipeline.verify_agree_rate, suite.NO_NO_CLAIM_NOTE);
        assert.equal('answer_agree_rate' in res.notApplicable.pipeline, false);
    });
});

describe('pipelineNotApplicable：條件', () => {
    const jq = (...compares) => compares.map(c => ({ payload: { verify: c === undefined ? undefined : { compare: c } } }));

    test('全部 no_claim → 只略過 answer_agree_rate；OCR 模式另加 saved_rate', () => {
        assert.deepEqual(suite.pipelineNotApplicable({ ocrOnly: false, jq: jq('no_claim', 'no_claim') }),
            { pipeline: { answer_agree_rate: suite.ALL_NO_CLAIM_NOTE } });
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕OCR 模式另加 gate_pass_rate
        assert.deepEqual(suite.pipelineNotApplicable({ ocrOnly: true, jq: jq('no_claim') }),
            { pipeline: { saved_rate: suite.OCR_SAVED_RATE_NOTE, gate_pass_rate: suite.OCR_GATE_PASS_NOTE, answer_agree_rate: suite.ALL_NO_CLAIM_NOTE } });
    });

    test('有一題不是 no_claim（含 verify 沒跑出結果的題）→ answer_agree_rate 照比', () => {
        for (const other of ['agree', 'disagree', 'uncertain', undefined]) {
            const na = suite.pipelineNotApplicable({ ocrOnly: false, jq: jq('no_claim', other) });
            assert.equal(na, undefined, String(other));
        }
    });

    test('沒有任何 no_claim → 只略過 verify_agree_rate；沒有題 → 兩個都照比（量不到＝失敗）', () => {
        assert.deepEqual(suite.pipelineNotApplicable({ ocrOnly: false, jq: jq('agree', undefined) }),
            { pipeline: { verify_agree_rate: suite.NO_NO_CLAIM_NOTE } });
        assert.equal(suite.pipelineNotApplicable({ ocrOnly: false, jq: [] }), undefined);
        assert.deepEqual(suite.pipelineNotApplicable({ ocrOnly: true, jq: [] }),
            { pipeline: { saved_rate: suite.OCR_SAVED_RATE_NOTE, gate_pass_rate: suite.OCR_GATE_PASS_NOTE } });
    });
});

describe('門檻比對（eval/thresholds.json 本身）', () => {
    // 〔Owner 2026-10-03 第 r14 輪 C-1〕thresholds.json 多了 chapter_acc_rate 門檻：量測照新契約帶一個達標的值，這一節只看答案指標
    //（〔r15〕門檻 0.77 → 0.97，帶的值 0.8 → r15 實測的 1）
    const OCR = { saved_rate: suite.OCR_SAVED_RATE_NOTE };

    test('全部 no_claim：answer_agree_rate n/a 不算失敗、列在「未設門檻」；verify_agree_rate 0.90 ≥ 0.87 過', () => {
        const r = th.compareSuite(FILE, 'pipeline',
            { pipeline: { saved_rate: null, gate_pass_rate: 0.97, answer_agree_rate: null, verify_agree_rate: 0.9, chapter_acc_rate: 1, n: 10 } },
            { notApplicable: { pipeline: { ...OCR, answer_agree_rate: suite.ALL_NO_CLAIM_NOTE } } });
        assert.deepEqual(r.failures, []);
        assert.equal(r.checked, 3);   // gate_pass_rate、verify_agree_rate、chapter_acc_rate（〔r14 C-1〕）
        assert.ok(r.skipped.some(s => s.startsWith('pipeline.answer_agree_rate（全部題目拆題都沒寫答案')), r.skipped.join('、'));
    });

    test('全部 no_claim：verify_agree_rate 低於 0.87 或量不到都是失敗', () => {
        const na = { notApplicable: { pipeline: { answer_agree_rate: suite.ALL_NO_CLAIM_NOTE } } };
        const low = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: null, verify_agree_rate: 0.86, chapter_acc_rate: 1 } }, na);
        assert.deepEqual(low.failures, ['pipeline.verify_agree_rate：0.8600 < 門檻 0.87']);
        const gone = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: null, verify_agree_rate: null, chapter_acc_rate: 1 } }, na);
        assert.deepEqual(gone.failures, ['pipeline.verify_agree_rate：門檻 0.87 但這次是 n/a']);
        const edge = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: null, verify_agree_rate: 0.87, chapter_acc_rate: 1 } }, na);
        assert.deepEqual(edge.failures, []);
    });

    test('有非 no_claim 的題（沒宣告不比）：answer_agree_rate 照舊比 0.87——n/a 與 0.80 都是失敗', () => {
        const base = { saved_rate: 0.9, gate_pass_rate: 1, verify_agree_rate: 0.9, chapter_acc_rate: 1 };
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, answer_agree_rate: null } }).failures,
            ['pipeline.answer_agree_rate：門檻 0.87 但這次是 n/a']);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, answer_agree_rate: 0.8 } }).failures,
            ['pipeline.answer_agree_rate：0.8000 < 門檻 0.87']);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, answer_agree_rate: 0.9 } }).failures, []);
    });

    test('沒有 no_claim 的題（Gemini／交叉驗證）：verify_agree_rate n/a 不算失敗，answer_agree_rate 照比', () => {
        const na = { notApplicable: { pipeline: { verify_agree_rate: suite.NO_NO_CLAIM_NOTE } } };
        const ok = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.9, verify_agree_rate: null, chapter_acc_rate: 1 } }, na);
        assert.deepEqual(ok.failures, []);
        assert.equal(ok.checked, 4);   // 〔r14 C-1〕多 chapter_acc_rate
        const bad = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.5, verify_agree_rate: null, chapter_acc_rate: 1 } }, na);
        assert.deepEqual(bad.failures, ['pipeline.answer_agree_rate：0.5000 < 門檻 0.87']);
    });

    test('沒宣告不比時 verify_agree_rate n/a 是失敗（舊報表、cassette 被誤刪不會變綠）', () => {
        const r = th.compareSuite(FILE, 'pipeline', { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.9, chapter_acc_rate: 1 } });
        assert.deepEqual(r.failures, ['pipeline.verify_agree_rate：門檻 0.87 但這次是 n/a']);
    });
});

describe('報表與回放驗證表', () => {
    let tmp;
    before(() => { tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'verify-agree-')); });
    after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    const res = {
        suite: 'pipeline',
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕報表照新契約帶 chapter_acc_rate（〔r15〕1 ≥ 0.97）
        measured: { pipeline: { saved_rate: null, gate_pass_rate: 0.8, answer_agree_rate: null, verify_agree_rate: 0.9, chapter_acc_rate: 1, n: 10 } },
        notApplicable: { pipeline: { saved_rate: suite.OCR_SAVED_RATE_NOTE, answer_agree_rate: suite.ALL_NO_CLAIM_NOTE } },
        ocrOnly: { saved_rate_note: suite.OCR_SAVED_RATE_NOTE, pre_approval: { passed: 10, total: 10, rate: 1 } },
        verifyAgree: { n: 10, by_answer_text: { agree: 9, rate: 0.9 }, by_final_answer: { agree: 5, rate: 0.5 }, note: suite.VERIFY_AGREE_NOTE },
        counts: { total: 10, saved: 0, needs_review: 10, rejected: 0, pending: 0 },
        nodes: {}, reviewReasons: [],
        cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: 0 },
        warnings: [],
        meta: { pdf: 'eval/fixtures/sample_exam.pdf', questionsExpected: 10, llmMode: 'replay', agentSources: {}, stateMachine: 'x', db: null, sources: {}, cassetteDir: 'eval/cassettes' }
    };

    test('Markdown：answer_agree_rate 註明不比門檻的原因；verify_agree_rate 印在同一行；兩種比法那一行照印', () => {
        const md = report2.markdownPipeline(res);
        assert.match(md, /answer_agree_rate：n\/a（不比門檻：全部題目拆題都沒寫答案（verify 記 no_claim）/);
        assert.match(md, /　verify_agree_rate：0\.9000\n/);
        assert.match(md, /verify_agree_rate（10 題 no_claim）：對答案卷 answer_text 0\.9000（9／10）、對 final_answer 0\.5000（5／10）。.*門檻比的是對 answer_text 那一個/);
    });

    test('Markdown：舊報表（measured 沒有 verify_agree_rate）那一行與改版前相同', () => {
        const md = report2.markdownPipeline({ ...res, notApplicable: undefined, verifyAgree: undefined,
            measured: { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.8, n: 10 } } });
        assert.match(md, /answer_agree_rate：0\.8000\n/);
        assert.doesNotMatch(md, /verify_agree_rate/);
    });

    test('報表 JSON → thresholdRows（重錄工具的回放驗證表）：verify_agree_rate 達標、answer_agree_rate 標 na、只剩 gate_pass_rate 未達', () => {
        const origLog = console.log;
        let emitted;
        try { console.log = () => {}; emitted = report2.emit({ res, dir: tmp }); } finally { console.log = origLog; }
        const doc = JSON.parse(fs.readFileSync(emitted.file, 'utf8'));
        assert.equal(doc.measured.pipeline.verify_agree_rate, 0.9);
        const t = thresholdRows(doc, FILE);
        assert.deepEqual(t.failures, ['pipeline.gate_pass_rate：0.8000 < 門檻 0.97']);
        const by = Object.fromEntries(t.rows.map(r => [r.metric, r]));
        assert.equal(by['pipeline.verify_agree_rate'].ok, true);
        assert.equal(by['pipeline.verify_agree_rate'].threshold, 0.87);
        assert.equal(by['pipeline.answer_agree_rate'].na, suite.ALL_NO_CLAIM_NOTE);
        assert.equal(by['pipeline.gate_pass_rate'].ok, false);
    });
});
