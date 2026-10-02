// pipeline eval 的 OCR 模式（Owner 第五輪 D-2 核准，選 3，2026-09-27，dec/r6-gates）
//
// OCR 為主（拆題模型是 ollama、LOCAL_EXTRACT_MODE=ocr）時每一題都停在人工複核（ocr_only），saved_rate 設計上恆為 0：
//   ① saved_rate 印成 n/a、不比門檻——只有 eval/lib/thresholds.js 白名單裡的 pipeline.saved_rate 可以這樣略過；
//      交叉驗證與 Gemini 模式照舊比 0.87；thresholds.json 不動。
//   ② 替代指標「人工核准前的通過率」＝ needs_review 且原因 ocr_only 的題 ÷ 全部題，只報告、不設門檻（不進 measured）。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const th = require('../../eval/lib/thresholds');
const suite = require('../../eval/lib/suitePipeline');
const report2 = require('../../eval/lib/report2');

const TABLE = { pipeline: { pipeline: { saved_rate: 0.87, gate_pass_rate: 0.97, answer_agree_rate: 0.87 } } };

describe('thresholds.compareSuite：notApplicable 白名單', () => {
    test('OCR 模式：saved_rate 是 n/a 也不算失敗、列在「未設門檻」；其餘兩項照舊比', () => {
        const measured = { pipeline: { saved_rate: null, gate_pass_rate: 1, answer_agree_rate: 0.9 } };
        const r = th.compareSuite(TABLE, 'pipeline', measured, { notApplicable: { pipeline: { saved_rate: suite.OCR_SAVED_RATE_NOTE } } });
        assert.deepEqual(r.failures, []);
        assert.equal(r.checked, 2);
        assert.ok(r.skipped.some(x => x.startsWith('pipeline.saved_rate（OCR 模式')));

        const low = th.compareSuite(TABLE, 'pipeline', { pipeline: { saved_rate: null, gate_pass_rate: 0.5, answer_agree_rate: 0.9 } },
            { notApplicable: { pipeline: { saved_rate: 'x' } } });
        assert.equal(low.failures.length, 1);
        assert.match(low.failures[0], /gate_pass_rate/);
    });

    test('沒有 notApplicable（交叉驗證／Gemini）：saved_rate n/a 照舊是失敗、0 照舊未達', () => {
        assert.equal(th.compareSuite(TABLE, 'pipeline', { pipeline: { saved_rate: null, gate_pass_rate: 1, answer_agree_rate: 1 } }).failures.length, 1);
        assert.equal(th.compareSuite(TABLE, 'pipeline', { pipeline: { saved_rate: 0, gate_pass_rate: 1, answer_agree_rate: 1 } }).failures.length, 1);
    });

    test('白名單以外的指標不能宣告「不比」：直接丟錯', () => {
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕gate_pass_rate 進白名單（OCR 模式只報告）之後，改用不在白名單的 chapter_acc_rate 驗這條
        assert.throws(() => th.compareSuite(TABLE, 'pipeline', { pipeline: { saved_rate: 1, gate_pass_rate: 1, answer_agree_rate: 1, chapter_acc_rate: null } },
            { notApplicable: { pipeline: { chapter_acc_rate: 'x' } } }), /白名單/);
        assert.throws(() => th.compareSuite({ classify: { classify: { accuracy: 0.87 } } }, 'classify', { classify: { accuracy: null } },
            { notApplicable: { classify: { accuracy: 'x' } } }), /白名單/);
        // 〔Owner 2026-10-02 A 案〕白名單多 answer_agree_rate（全部 no_claim 時）與 verify_agree_rate（沒有 no_claim 時）；
        // 條件與比對見 test/unit/evalPipelineVerifyAgree.test.js。
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕gate_pass_rate 進白名單（只有 OCR 模式宣告；條件見 test/unit/evalPipelineChapterAcc.test.js）；
        // chapter_acc_rate 不在白名單（上面那一則照樣丟錯）。
        assert.deepEqual(th.NOT_APPLICABLE_ALLOWED, { pipeline: { pipeline: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate'] } });
    });

    test('thresholds.json 的 pipeline 門檻：原本三個數字一個都沒動', () => {
        const file = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'eval', 'thresholds.json'), 'utf8'));
        // 〔Owner 2026-10-02 A 案〕多一個鍵 verify_agree_rate 0.87（首次實測 0.9000 − 0.03）；
        // 〔Owner 2026-10-03 第 r14 輪 C-1〕再多 chapter_acc_rate 0.77（首次實測 0.8000 − 0.03）；原本三個照舊逐字釘住
        assert.deepEqual(file.pipeline.pipeline, { ...TABLE.pipeline.pipeline, verify_agree_rate: 0.87, chapter_acc_rate: 0.77 });
    });
});

describe('suitePipeline：OCR 模式的判斷與替代指標', () => {
    // 〔整合 2026-09-27 dec/integration-r6〕C 組（D-2）× D 組（D-3）：D 組把 LOCAL_EXTRACT_MODE 的程式預設改成 ocr
    // （Owner 第五輪 D-3＝2 核准），isOcrOnlyRun 經 resolveLocalExtractMode 取預設，所以「ollama、沒設」現在算 OCR 模式
    //（saved_rate 印 n/a、報人工核准前的通過率）；寫錯字也落回預設 ocr。要比 0.87 的交叉驗證必須明寫 cross。
    test('isOcrOnlyRun：ollama＋ocr（含沒設＝程式預設 ocr）才算；Gemini、明寫 cross 不算；payload 帶 extract_mode=ocr 也算', () => {
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'ocr' }), true);
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'cross' }), false);
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b' }), true);
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', LOCAL_EXTRACT_MODE: 'ocrr' }), true);
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'gemini:gemini-3.5-flash', LOCAL_EXTRACT_MODE: 'ocr' }), false);
        assert.equal(suite.isOcrOnlyRun({ MODEL_EXTRACT: 'gemini:gemini-3.5-flash' }, [{ payload: { extract: { extract_mode: 'ocr' } } }]), true);
    });

    test('preApprovalPassRate：只數 needs_review 且原因 ocr_only 的題；分母是全部題；沒有題＝null', () => {
        const jq = [
            { state: 'needs_review', review_reason: 'ocr_only' },
            { state: 'needs_review', review_reason: 'ocr_only' },
            { state: 'needs_review', review_reason: 'answer_mismatch' },
            { state: 'needs_review', review_reason: 'formula_unparsable' },
            { state: 'rejected', review_reason: null }
        ];
        assert.deepEqual(suite.preApprovalPassRate(jq), { passed: 2, total: 5, rate: 0.4 });
        assert.deepEqual(suite.preApprovalPassRate([]), { passed: 0, total: 0, rate: null });
    });
});

describe('report2：pipeline 的 Markdown', () => {
    const base = {
        measured: { pipeline: { saved_rate: null, gate_pass_rate: 1, answer_agree_rate: 0.8, n: 10 } },
        counts: { total: 10, saved: 0, needs_review: 10, rejected: 0, pending: 0 },
        nodes: {}, reviewReasons: [{ key: 'ocr_only', count: 7 }],
        cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: 0 },
        meta: { pdf: 'eval/fixtures/sample_exam.pdf', questionsExpected: 10, llmMode: 'replay', agentSources: {}, stateMachine: 'x', db: null }
    };

    test('OCR 模式：saved_rate 印 n/a 並註明不比門檻；另印「人工核准前的通過率」', () => {
        const md = report2.markdownPipeline({
            ...base,
            ocrOnly: { saved_rate_note: suite.OCR_SAVED_RATE_NOTE, pre_approval: { passed: 7, total: 10, rate: 0.7 } }
        });
        assert.match(md, /saved_rate：n\/a（OCR 模式每題都停在人工複核，設計上恆為 0，不比門檻（Owner 第五輪 D-2））/);
        assert.match(md, /人工核准前的通過率（OCR 模式）：0\.7000（7／10 題走完全部閘門、只因「只用 OCR 拆題」停下；只報告、不設門檻）/);
    });

    test('非 OCR 模式：與改版前相同，沒有替代指標那一行', () => {
        const md = report2.markdownPipeline({ ...base, measured: { pipeline: { saved_rate: 0.9, gate_pass_rate: 1, answer_agree_rate: 0.8, n: 10 } } });
        assert.match(md, /- saved_rate：0\.9000　classify/);
        assert.ok(!md.includes('人工核准前的通過率'));
    });
});
