// ─────────────────────────────────────────────────────────────
// test/unit/evalPipelineChapterAcc.test.js — pipeline eval 的章節把關（Owner 2026-10-03 第 r14 輪 C-1；docs/local-mode.md 10.27）
//
//   ① gate_pass_rate 在 OCR 模式（與 saved_rate 的 D-2 同一個條件）只報告、不比門檻；Gemini（非 OCR）模式照舊比 0.97。
//   ② 新指標 chapter_acc_rate（章節正確率）＝有 classify 結果的題：最後章節等於答案卷 chapter 的比例；兩種模式都比，
//      門檻 0.77（首次實測 0.8000 − 0.03）。配不上答案卷的題算錯。
//   〔r15 dec/r15-chapter-acc〕對數下標與閘門證據否決（docs/local-mode.md 10.28）之後，Owner 補錄第 7 題的 classify 回放檔、
//      實測 1.0000（10／10，commit 4d10671），--write-baseline 把門檻升到 0.97（1.0000 − 0.03）。下面的門檻數字改釘 0.97；
//      報表的例子改成 r15 的實測（全對、閘門 0.70），r14 那份 8／10 的報表留著當「門檻未達」與「列出答錯的題」的例子。
// 不連 DB、不呼叫模型（pipelineDriver.runPipeline 換成假的，答案卷用 repo 裡真的樣卷答案卷）。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const th = require('../../eval/lib/thresholds');
const driver = require('../../eval/lib/pipelineDriver');
const suite = require('../../eval/lib/suitePipeline');
const report2 = require('../../eval/lib/report2');
const { loadSheet } = require('../../eval/lib/pdfGolden');
const { thresholdRows } = require('../../eval/lib/cassettePlan');

const FILE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'eval', 'thresholds.json'), 'utf8'));
const SHEET = loadSheet({ pdfPath: suite.DEFAULT_PDF });

// 樣卷答案卷（eval/golden/pdf_sample/<sha>.json）裡的三題，題幹逐字照抄，pdfMatch 才配得上
const Q1 = { text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $12$', type: '單選', no: 1, chapter: '指數函數與對數函數' };
const Q5 = { text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', type: '計算', no: 5, chapter: '牛頓運動定律' };
const Q6 = { text: '長 $1$ m 的輕繩繫住質量 $2$ kg 的小球，在光滑水平面上以 $3$ m/s 的速率作等速圓周運動，求繩的張力。', type: '計算', no: 6, chapter: '摩擦力與向心力' };

/**
 * 一題走完管線的樣子（driver.runPipeline 的 jq 列）
 * @param {number} idx
 * @param {object} q
 * @param {string|null} chapter classify 的最後章節（null＝沒有 classify 結果）
 * @param {'gate'|'llm'} [source]
 * @param {{ocr?:boolean}} [opts] ocr：payload.extract.extract_mode='ocr'（isOcrOnlyRun 看得到）
 */
function row(idx, q, chapter, source = 'gate', { ocr = false } = {}) {
    return {
        idx, state: 'needs_review', review_reason: ocr ? 'ocr_only' : 'answer_mismatch', retries: 0,
        payload: {
            extract: { question_text: q.text, question_type: q.type, chapter: '拆題模型猜的', ...(ocr ? { extract_mode: 'ocr' } : {}) },
            ...(chapter === null ? {} : { classify: { source, chapter } }),
            verify: { compare: 'agree', final_answer: 'x' }
        }
    };
}

/** 用假的 driver.runPipeline 跑 runPipelineSuite；env 暫時換成給定的值（跑完還原） */
async function runWith(jq, env = {}) {
    const orig = driver.runPipeline;
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    driver.runPipeline = async () => ({
        ok: true, jq, events: [], warnings: [],
        totals: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, costUsd: 0, latencyMs: 0 },
        agentSources: { extract: 'agents/extract.js', classify: 'agents/classify.js', verify: 'agents/verify.js' },
        stateMachine: 'pipeline/stateMachine.js', db: null, thresholds: {}
    });
    try {
        return await suite.runPipelineSuite({});
    } finally {
        driver.runPipeline = orig;
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

const GEMINI_ENV = { MODEL_EXTRACT: 'gemini-2.5-flash', LOCAL_EXTRACT_MODE: 'cross' };

describe('契約：SUITE_METRICS、白名單、thresholds.json', () => {
    test('SUITE_METRICS.pipeline 在最後多 chapter_acc_rate（原本四個的名稱與順序不變）', () => {
        assert.deepEqual(th.SUITE_METRICS.pipeline,
            { columns: ['pipeline'], metrics: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate', 'chapter_acc_rate'] });
    });

    test('白名單多 gate_pass_rate；chapter_acc_rate 不在白名單（兩種模式都比，不能宣告不比）', () => {
        assert.ok(th.NOT_APPLICABLE_ALLOWED.pipeline.pipeline.includes('gate_pass_rate'));
        assert.ok(!th.NOT_APPLICABLE_ALLOWED.pipeline.pipeline.includes('chapter_acc_rate'));
        assert.throws(() => th.compareSuite(FILE, 'pipeline', { pipeline: { chapter_acc_rate: null } },
            { notApplicable: { pipeline: { chapter_acc_rate: 'x' } } }), /白名單/);
    });

    // 〔r15 dec/r15-chapter-acc〕原本釘 0.77（r14 首次實測 0.8000 − 0.03）；r15 實測 1.0000 之後 ratchet 到 0.97
    test('thresholds.json：chapter_acc_rate 0.97（r15 實測 1.0000 − 0.03；r14 初值 0.77）、gate_pass_rate 仍是 0.97，來源記在 _note_chapter_acc_rate', () => {
        assert.equal(FILE.pipeline.pipeline.chapter_acc_rate, 0.97);
        assert.equal(Math.round((1 - th.BASELINE_MARGIN) * 10000) / 10000, FILE.pipeline.pipeline.chapter_acc_rate);
        assert.equal(FILE.pipeline.pipeline.gate_pass_rate, 0.97, 'Gemini 模式的閘門門檻不動');
        assert.equal(FILE.pipeline.pipeline.verify_agree_rate, 0.87, 'verify_agree_rate 不受 r15 影響');
        const note = FILE.pipeline._note_chapter_acc_rate;
        assert.ok(typeof note === 'string', 'pipeline 節要有 _note_chapter_acc_rate');
        for (const s of ['Owner 2026-10-03', '第 r14 輪 C-1', '0.8000', '− 0.03', '只升不降', 'gate_pass_rate', 'OCR 模式', '0.97', 'Gemini',
            'r15', '1.0000', '4d10671', '10.28']) {
            assert.ok(note.includes(s), `來源說明沒寫到 ${s}`);
        }
    });
});

describe('chapterAccReport：章節正確率的計算（真的樣卷答案卷）', () => {
    test('全部對＝1；一題錯＝2／3，錯的那一題列出答案卷題號、正解與預測', () => {
        const ok = suite.chapterAccReport([row(0, Q1, Q1.chapter), row(1, Q5, Q5.chapter), row(2, Q6, Q6.chapter, 'llm')], SHEET);
        assert.deepEqual(ok, { n: 3, correct: 3, rate: 1, wrong: [] });

        const r = suite.chapterAccReport([row(0, Q1, '指數與對數'), row(1, Q5, Q5.chapter), row(2, Q6, Q6.chapter, 'llm')], SHEET);
        assert.equal(r.n, 3);
        assert.equal(r.correct, 2);
        assert.equal(r.rate, 0.6667);
        assert.deepEqual(r.wrong, [{ idx: 0, no: Q1.no, expect: Q1.chapter, got: '指數與對數', source: 'gate' }]);
    });

    test('沒有 classify 結果的題不進分母；全部都沒有＝null', () => {
        const r = suite.chapterAccReport([row(0, Q1, Q1.chapter), row(1, Q5, null)], SHEET);
        assert.deepEqual(r, { n: 1, correct: 1, rate: 1, wrong: [] });
        assert.equal(suite.chapterAccReport([row(0, Q1, null)], SHEET).rate, null);
        assert.equal(suite.chapterAccReport([], SHEET).rate, null);
    });

    test('配不上答案卷的題算錯（不讓配對失敗變成好分數）', () => {
        const stray = { text: '這一題答案卷上沒有：請說明光合作用的反應式與條件。', type: '問答' };
        const r = suite.chapterAccReport([row(0, Q1, Q1.chapter), row(1, stray, '牛頓運動定律', 'llm')], SHEET);
        assert.equal(r.n, 2);
        assert.equal(r.correct, 1);
        assert.equal(r.rate, 0.5);
        assert.deepEqual(r.wrong, [{ idx: 1, no: null, expect: null, got: '牛頓運動定律', source: 'llm' }]);
    });

    test('比的是 classify 的最後章節，不是拆題模型自己猜的章節', () => {
        const r0 = row(0, Q1, Q1.chapter);
        r0.payload.extract.chapter = '向量內積';
        assert.equal(suite.chapterAccReport([r0], SHEET).rate, 1);
    });
});

describe('runPipelineSuite：OCR 模式 gate_pass_rate 只報告；chapter_acc_rate 兩種模式都量', () => {
    // 3 題：2 題過閘門（其中 1 題章節錯）、1 題走 LLM（對）→ gate 0.6667、章節 0.6667
    const jq = (ocr) => [row(0, Q1, '指數與對數', 'gate', { ocr }), row(1, Q5, Q5.chapter, 'gate', { ocr }), row(2, Q6, Q6.chapter, 'llm', { ocr })];

    test('OCR 模式：gate_pass_rate 照樣量、照樣印，但宣告不比（原因寫明）；chapter_acc_rate 進 measured', async () => {
        const res = await runWith(jq(true));
        const m = res.measured.pipeline;
        assert.equal(m.gate_pass_rate, 0.6667, '只報告，數字照樣算');
        assert.equal(m.chapter_acc_rate, 0.6667);
        assert.equal(res.notApplicable.pipeline.gate_pass_rate, suite.OCR_GATE_PASS_NOTE);
        assert.equal(res.notApplicable.pipeline.saved_rate, suite.OCR_SAVED_RATE_NOTE, '與 saved_rate 同一個條件');
        assert.equal('chapter_acc_rate' in res.notApplicable.pipeline, false);
        assert.equal(res.chapterAcc.wrong.length, 1);

        const cmp = th.compareSuite(FILE, 'pipeline', res.measured, { notApplicable: res.notApplicable });
        assert.deepEqual(cmp.failures.filter(f => f.includes('gate_pass_rate')), [], 'OCR 模式 gate_pass_rate 不算失敗');
        assert.ok(cmp.skipped.some(s => s.startsWith('pipeline.gate_pass_rate（OCR 模式（本機）')), cmp.skipped.join('、'));
        assert.deepEqual(cmp.failures.filter(f => f.includes('chapter_acc_rate')), ['pipeline.chapter_acc_rate：0.6667 < 門檻 0.97']);
    });

    test('Gemini（非 OCR）模式：gate_pass_rate 照舊比 0.97；chapter_acc_rate 同樣比', async () => {
        const res = await runWith(jq(false), GEMINI_ENV);
        assert.equal(res.ocrOnly, null);
        const na = (res.notApplicable && res.notApplicable.pipeline) || {};
        assert.equal('gate_pass_rate' in na, false);
        assert.equal(res.measured.pipeline.chapter_acc_rate, 0.6667);

        const cmp = th.compareSuite(FILE, 'pipeline', res.measured, { notApplicable: res.notApplicable });
        assert.deepEqual(cmp.failures.filter(f => f.includes('gate_pass_rate')), ['pipeline.gate_pass_rate：0.6667 < 門檻 0.97']);
        assert.deepEqual(cmp.failures.filter(f => f.includes('chapter_acc_rate')), ['pipeline.chapter_acc_rate：0.6667 < 門檻 0.97']);
    });

    test('Gemini 模式全部過閘門、章節全對：兩個都達標', async () => {
        const res = await runWith([row(0, Q1, Q1.chapter), row(1, Q5, Q5.chapter), row(2, Q6, Q6.chapter)], GEMINI_ENV);
        const cmp = th.compareSuite(FILE, 'pipeline', res.measured, { notApplicable: res.notApplicable });
        assert.deepEqual(cmp.failures.filter(f => /gate_pass_rate|chapter_acc_rate/.test(f)), []);
    });

    test('OCR 模式的判斷與 saved_rate 同一支（isOcrOnlyRun）：env 是 ollama＋ocr 也算', async () => {
        const res = await runWith(jq(false), { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'ocr' });
        assert.equal(res.notApplicable.pipeline.gate_pass_rate, suite.OCR_GATE_PASS_NOTE);
        const cross = await runWith(jq(false), { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'cross' });
        assert.equal('gate_pass_rate' in ((cross.notApplicable && cross.notApplicable.pipeline) || {}), false, '交叉驗證照舊比 0.97');
    });

    test('pipelineNotApplicable：OCR 模式（含沒有題）宣告 gate_pass_rate；非 OCR 不宣告', () => {
        assert.equal(suite.pipelineNotApplicable({ ocrOnly: true, jq: [] }).pipeline.gate_pass_rate, suite.OCR_GATE_PASS_NOTE);
        assert.equal(suite.pipelineNotApplicable({ ocrOnly: false, jq: [] }), undefined);
    });
});

describe('門檻比對：chapter_acc_rate 兩種模式都是硬門檻', () => {
    const base = { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.9, verify_agree_rate: 0.9 };

    // 〔r15〕門檻 0.97：樣卷 10 題錯 1 題（0.9）就是紅燈
    test('0.97 剛好過；0.96、0.9（樣卷錯 1 題）與 n/a 是失敗（OCR 模式的宣告也救不了它）', () => {
        const ocrNa = { notApplicable: suite.pipelineNotApplicable({ ocrOnly: true, jq: [] }) };
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, chapter_acc_rate: 0.97 } }).failures, []);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, chapter_acc_rate: 1 } }).failures, []);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, chapter_acc_rate: 0.96 } }).failures,
            ['pipeline.chapter_acc_rate：0.9600 < 門檻 0.97']);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, chapter_acc_rate: 0.9 } }).failures,
            ['pipeline.chapter_acc_rate：0.9000 < 門檻 0.97']);
        assert.deepEqual(th.compareSuite(FILE, 'pipeline', { pipeline: { ...base, chapter_acc_rate: null } }, ocrNa).failures,
            ['pipeline.chapter_acc_rate：門檻 0.97 但這次是 n/a']);
    });
});

describe('報表與回放驗證表', () => {
    let tmp;
    before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-acc-')); });
    after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    const na = suite.pipelineNotApplicable({ ocrOnly: true, jq: [{ payload: { verify: { compare: 'no_claim' } } }] });
    // 〔r15〕r14 的實測（8／10，兩題過閘門猜錯）：門檻 0.97 之下是「未達」的例子，也是「列出答錯的題」的例子
    const resR14 = {
        suite: 'pipeline',
        measured: { pipeline: { saved_rate: null, gate_pass_rate: 0.8, answer_agree_rate: null, verify_agree_rate: 0.9, chapter_acc_rate: 0.8, n: 10 } },
        notApplicable: na,
        ocrOnly: { saved_rate_note: suite.OCR_SAVED_RATE_NOTE, pre_approval: { passed: 10, total: 10, rate: 1 } },
        chapterAcc: { n: 10, correct: 8, rate: 0.8, wrong: [
            { idx: 1007, no: 7, expect: '直線運動', got: '位能與能量守恆', source: 'gate' },
            { idx: 1008, no: 8, expect: '指數與對數', got: '指數函數與對數函數', source: 'gate' }
        ] },
        counts: { total: 10, saved: 0, needs_review: 10, rejected: 0, pending: 0 },
        nodes: {}, reviewReasons: [],
        cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: 0 },
        warnings: [],
        meta: { pdf: 'eval/fixtures/sample_exam.pdf', questionsExpected: 10, llmMode: 'replay', agentSources: {}, stateMachine: 'x', db: null, sources: {}, cassetteDir: 'eval/cassettes' }
    };
    // 〔r15〕r15 的實測（commit 4d10671 的回放）：章節 10／10、第 7 題被閘門否決改走 LLM → 閘門通過率 0.70（OCR 模式只報告）
    const res = {
        ...resR14,
        measured: { pipeline: { saved_rate: null, gate_pass_rate: 0.7, answer_agree_rate: null, verify_agree_rate: 0.9, chapter_acc_rate: 1, n: 10 } },
        chapterAcc: { n: 10, correct: 10, rate: 1, wrong: [] }
    };

    test('Markdown：閘門通過率照印並註明不比門檻；章節正確率一行列出答錯的題（r14 的報表）', () => {
        const md = report2.markdownPipeline(resR14);
        assert.match(md, /classify 零成本閘門通過率：0\.8000（不比門檻：OCR 模式（本機）classify 走 LLM 不花錢/);
        assert.match(md, /- 章節正確率 chapter_acc_rate：0\.8000（8／10 題有 classify 結果的題，最後章節等於答案卷；章節不對：答案卷第 7 題 直線運動 → 位能與能量守恆（gate）、答案卷第 8 題 指數與對數 → 指數函數與對數函數（gate））/);
    });

    test('Markdown：全對（r15 的報表）不印「章節不對」', () => {
        const md = report2.markdownPipeline(res);
        assert.match(md, /classify 零成本閘門通過率：0\.7000（不比門檻：OCR 模式（本機）/);
        assert.match(md, /- 章節正確率 chapter_acc_rate：1（10／10 題有 classify 結果的題，最後章節等於答案卷）/);
        assert.doesNotMatch(md, /章節不對/);
    });

    test('Markdown：舊報表（measured 沒有 chapter_acc_rate）不印那一行', () => {
        const md = report2.markdownPipeline({ ...res, chapterAcc: undefined, notApplicable: undefined,
            measured: { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.8, n: 10 } } });
        assert.doesNotMatch(md, /chapter_acc_rate|章節正確率/);
        assert.match(md, /閘門通過率：1　answer_agree_rate/);
    });

    function emitDoc(r) {
        const origLog = console.log;
        let emitted;
        try { console.log = () => {}; emitted = report2.emit({ res: r, dir: tmp }); } finally { console.log = origLog; }
        return JSON.parse(fs.readFileSync(emitted.file, 'utf8'));
    }

    test('報表 JSON → thresholdRows（r15 的報表）：OCR 模式 gate_pass_rate 標 na、chapter_acc_rate 達標，沒有門檻未達', () => {
        const doc = emitDoc(res);
        assert.equal(doc.measured.pipeline.chapter_acc_rate, 1);
        assert.equal(doc.detail.chapter_acc.correct, 10);
        const t = thresholdRows(doc, FILE);
        assert.deepEqual(t.failures, []);
        const by = Object.fromEntries(t.rows.map(r => [r.metric, r]));
        assert.equal(by['pipeline.gate_pass_rate'].na, suite.OCR_GATE_PASS_NOTE);
        assert.equal(by['pipeline.chapter_acc_rate'].ok, true);
        assert.equal(by['pipeline.chapter_acc_rate'].threshold, 0.97);
        assert.equal(by['pipeline.chapter_acc_rate'].na, undefined);
    });

    test('報表 JSON → thresholdRows（r14 的報表）：0.8000 在門檻 0.97 之下是未達', () => {
        const doc = emitDoc(resR14);
        const t = thresholdRows(doc, FILE);
        const by = Object.fromEntries(t.rows.map(r => [r.metric, r]));
        assert.equal(by['pipeline.chapter_acc_rate'].ok, false);
        assert.equal(t.failures.length, 1);
        assert.match(t.failures[0], /chapter_acc_rate/);
    });
});
