// ─────────────────────────────────────────────────────────────
// test/unit/extractFixesR13Review.test.js — dec/r13-extract-fixes 的審查修正（dec/r13-extract-fixes-fix；docs/local-mode.md 10.25）
//
//   1. 題目頁「有沒有寫答案」的標記補齊：「（ 3 ）1. 下列何者…」（題號前的括號答案）、「Ans. 4」、「答 4」、「〔答案〕4」、「（答）4」；
//      「選填題答案：請依序填入」這種作答說明不算。複核頁顯示被清掉的原文，說法改成「沒有偵測到答案標記」。
//   2. 重錄時 lint／verify 的單次逾時跟著放寬後的全域走（eval/lib/localMode.js 的 agentTimeoutRecordEnv）。
//   3. eval pipeline 的 answer_agree_rate 定義照舊（no_claim 不進分母）；no_claim 題的「驗算對標準答案」另報 verify_agree_rate、不設門檻。
//   5. 解答頁回填的答案與驗算的建議答案交叉確認（workers/jobRunner.js 的 answerKeyCheck／saveStopReason）。
//   6. end_newline 的變體：「3 & 4 \⏎end{bmatrix}」（換列只剩一半）。
// 不連 DB、不呼叫模型。真 PG 的版本在 test/integration/extractAnswerKey.pg.test.js。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const answerKey = require('../../utils/answerKey');
const { repairText } = require('../../utils/extractLatexRepair');
const { formulaLint } = require('../../utils/formulaLint');
const runner = require('../../workers/jobRunner');
const tuning = require('../../services/llm/localTuning');
const local = require('../../eval/lib/localMode');
const rerecord = require('../../eval/tools/rerecord_all');
const suitePipeline = require('../../eval/lib/suitePipeline');

describe('題目頁有沒有寫答案（hasAnswerOnPage）：審查補的寫法', () => {
    test('台灣講義、教師版常見的寫法都算「有寫答案」', () => {
        for (const s of [
            '（ 3 ）1. 下列何者正確？(1) a (2) b (3) c',   // 題號前的括號答案
            '( 245 ) 6. 下列敘述哪些正確？',
            '（3）2. 設 f(x)=x+1',
            '（ B ）下列何者為真？',                         // 行首、括號裡左右留空白的作答格印上答案
            'Ans. 4', 'ANS. (2)', 'ans. $-2$',
            '答 4', '1. 求 x 的值。 答 $3$',
            '〔答案〕4', '［答案］(B)', '（答）4', '(解析) 由題意…',
            // 原本就算的照舊
            '1. 求 x。答：3', '【解答】(2)', '解析：由題意…', '答案：(B)', 'Answer: 7'
        ]) assert.equal(answerKey.hasAnswerOnPage(s), true, s);
    });

    test('作答說明、選項、小題標號不算', () => {
        for (const s of [
            '選填題答案：請依序填入答案卡',               // 原本誤判成有答案，整塊保留模型編的答案
            '答案：一律寫在答案卷上', '答案：請畫記在答案卡',
            '請將答案畫記在答案卡上', '請回答：下列何者正確',
            '（  ）1. 下列何者正確？',                      // 空的作答格
            '1. 下列何者為真？ (1) 3 (2) 4 (3) 5',          // 選項
            '(1) 3.5 (2) 4.5',                               // 小數選項不是「括號答案＋題號」
            '（1）求 x 的值 （2）求 y 的值',                // 小題標號（括號裡沒有空白）
            'Trans. 4', '回答 4 個問題', '一、單選題（每題 5 分）', '第一部分：選擇題（占 60 分）'
        ]) assert.equal(answerKey.hasAnswerOnPage(s), false, s);
    });

    test('processChunkAnswers：頁面上有「（ 3 ）1.」的寫法 → 模型照抄的答案保留，不再被清掉', () => {
        const els = [{ question_text: '1. 下列何者正確？(1) a (2) b (3) c', answer_text: '(3)', question_type: '單選' }];
        const r = answerKey.processChunkAnswers(els, [{ page: 1, markdown: '一、單選題\n（ 3 ）1. 下列何者正確？(1) a (2) b (3) c' }]);
        assert.equal(els[0].answer_text, '(3)');
        assert.equal(r.notes.size, 0);
        assert.equal(r.summary, null, '沒有解答頁、沒有清答案：不帶 answer_key');
    });

    test('processChunkAnswers：只有「選填題答案：請依序填入」→ 視為沒寫答案，模型編的清掉', () => {
        const els = [{ question_text: 'A. 求 x', answer_text: '$5$', question_type: '填空' }];
        const r = answerKey.processChunkAnswers(els, [{ page: 3, markdown: '三、選填題（選填題答案：請依序填入答案卡）\nA. 求 x = ⑨' }]);
        assert.equal(els[0].answer_text, '');
        assert.deepEqual(r.notes.get(0), { reason: 'not_on_page', text: '$5$' });
    });
});

describe('複核頁（public/js/review.js）：被清掉的原文看得到、不斷言原卷沒寫答案、回填與驗算不同時兩個都給看', () => {
    const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js'), 'utf8');
    let cached = null;
    const load = () => (cached = cached || import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE)));

    test('answer_dropped（not_on_page）：說明句帶原文、寫「沒偵測到答案標記」；有建議答案時接著說預填', async () => {
        const { answerSourceNote, droppedAnswerNote } = await load();
        const p = {
            extract: { question_text: 'q', answer_text: '', extract_mode: 'ocr', answer_dropped: { reason: 'not_on_page', text: '(4)' } },
            verify: { compare: 'no_claim', final_answer: '(3)', suggested_answer: '(3)' }
        };
        const note = answerSourceNote(p);
        assert.match(note, /^拆題模型原本填「\(4\)」，頁面上沒偵測到答案標記/);
        assert.match(note, /原卷若有印答案請照原卷改/);
        assert.match(note, /答案欄預填的是驗算模型算的建議答案「\(3\)」，請對照原卷核對後再核准。$/);
        assert.doesNotMatch(note, /原卷這一題沒有寫答案/);
        assert.equal(droppedAnswerNote({ reason: 'blank_marker', text: '⑮⑯' }), '拆題模型原本填「⑮⑯」，那只是填答格記號，已清掉。');
        assert.equal(droppedAnswerNote({ reason: 'not_on_page', text: '  ' }), '');
        assert.equal(droppedAnswerNote(undefined), '');
        // 沒有建議答案
        assert.match(answerSourceNote({ extract: { answer_text: '', answer_dropped: { reason: 'not_on_page', text: '$7$' } } }),
            /^拆題模型原本填「\$7\$」.*請對照原卷補上答案再核准。$/);
    });

    test('整個檔案不再出現「原卷這一題沒有寫答案」的斷言', () => {
        assert.ok(!SOURCE.includes('原卷這一題沒有寫答案'));
    });

    test('解答頁回填：與建議答案相同 → 只說來源；不同 → 兩個都列', async () => {
        const { answerSourceNote } = await load();
        const base = { extract: { answer_text: '(3)', answer_src: 'answer_key' }, lint: { answer_text: '' } };
        assert.equal(answerSourceNote({ ...base, verify: { compare: 'no_claim', suggested_answer: '(3)' } }), '答案取自這份卷的解答頁。');
        assert.equal(answerSourceNote({ ...base, verify: { compare: 'no_claim', suggested_answer: '12' } }),
            '答案取自這份卷的解答頁；驗算模型算的是「12」，兩者不同時請核對。');
        assert.equal(answerSourceNote({ ...base, verify: { compare: 'agree' } }), '答案取自這份卷的解答頁。');
    });
});

describe('重錄時 lint／verify 的單次逾時跟著放寬（eval/lib/localMode.js 的 agentTimeoutRecordEnv）', () => {
    const LOCAL_CI = { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', EMBED_MODEL: 'ollama:qwen3-embedding:0.6b', MODEL_NLQ: 'ollama:qwen3:8b' };
    const plan = (m = LOCAL_CI) => local.recordingPlan({ models: m, suites: ['classify', 'nlq', 'variant', 'pipeline', 'e2e'] });
    const H3 = String(3 * 60 * 60 * 1000);
    const M90 = String(90 * 60 * 1000);

    test('全域比本機預設（30 分）長、.env 沒寫 _LINT／_VERIFY → 兩個都設成全域的值；resolveTimeout 因此不再降回 30 分', () => {
        const out = local.agentTimeoutRecordEnv(plan(), H3, {});
        assert.deepEqual(out, { OLLAMA_TIMEOUT_MS_LINT: H3, OLLAMA_TIMEOUT_MS_VERIFY: H3 });
        const childEnv = { OLLAMA_TIMEOUT_MS: H3, ...out };
        for (const agent of ['lint', 'verify', 'lint_chem', 'verify_chem']) {
            assert.equal(tuning.resolveTimeout(agent, childEnv).timeoutMs, Number(H3), agent);
        }
        // 對照：沒有這一步時，錄製子行程的 lint／verify 會被降回 30 分（審查指出的問題）
        assert.equal(tuning.resolveTimeout('verify', { OLLAMA_TIMEOUT_MS: H3 }).timeoutMs, 1_800_000);
    });

    test('.env 寫了就照寫的（含只寫其中一個）；全域不比預設長、不是本機模型、全域不是正整數 → 不帶', () => {
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), H3, { OLLAMA_TIMEOUT_MS_VERIFY: '600000' }), { OLLAMA_TIMEOUT_MS_LINT: H3 });
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), H3, { OLLAMA_TIMEOUT_MS_LINT: '1', OLLAMA_TIMEOUT_MS_VERIFY: '2' }), {});
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), H3, { OLLAMA_TIMEOUT_MS_VERIFY: 'abc' }), { OLLAMA_TIMEOUT_MS_LINT: H3, OLLAMA_TIMEOUT_MS_VERIFY: H3 }, '寫錯＝沒寫');
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), '1800000', {}), {});
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), undefined, {}), {});
        assert.deepEqual(local.agentTimeoutRecordEnv(plan(), 'x', {}), {});
        const gemini = plan({ MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:c' });
        assert.deepEqual(local.agentTimeoutRecordEnv(gemini, H3, {}), {});
    });

    test('stepExtraEnv：pipeline／e2e 跟著 3 小時；其他步驟跟著 .env 的全域（Owner 的 90 分）；.env 的全域是 30 分時與之前相同', () => {
        const steps = rerecord.recordSteps();
        const by = (env) => Object.fromEntries(steps.map(s => [s.name, rerecord.stepExtraEnv(s, plan(), env)]));
        const owner = by({ OLLAMA_TIMEOUT_MS: M90 });
        for (const n of ['pipeline', 'e2e-similar']) {
            assert.equal(owner[n].OLLAMA_TIMEOUT_MS_LINT, H3, n);
            assert.equal(owner[n].OLLAMA_TIMEOUT_MS_VERIFY, H3, n);
        }
        for (const n of ['classify', 'variant']) {
            assert.equal(owner[n].OLLAMA_TIMEOUT_MS_LINT, M90, n);
            assert.equal(owner[n].OLLAMA_TIMEOUT_MS_VERIFY, M90, n);
        }
        const base = by({ OLLAMA_TIMEOUT_MS: '1800000' });
        for (const n of ['classify', 'variant']) assert.equal('OLLAMA_TIMEOUT_MS_VERIFY' in base[n], false, n);
    });

    test('錄製子行程放行、回放擋掉（不在 cassette 的鍵裡）', () => {
        const sp = require('../../eval/lib/suiteProcess');
        for (const k of ['OLLAMA_TIMEOUT_MS_LINT', 'OLLAMA_TIMEOUT_MS_VERIFY']) assert.ok(sp.LOCAL_TUNING_PATTERN.test(k), k);
        const ciLocal = { MODEL_EXTRACT: 'ollama:ci-vl', MODEL_VERIFY: 'ollama:ci-text' };
        const replay = sp.ciEnv({ base: { PATH: '/bin' }, models: ciLocal, envFileKeys: [], extra: {} });
        assert.equal(replay.OLLAMA_TIMEOUT_MS_VERIFY, undefined);
        const rec = sp.ciEnv({ base: { PATH: '/bin', OLLAMA_TIMEOUT_MS_VERIFY: H3 }, models: ciLocal, envFileKeys: [], llmMode: 'record' });
        assert.equal(rec.OLLAMA_TIMEOUT_MS_VERIFY, H3, '錄製放行');
        const rep2 = sp.ciEnv({ base: { PATH: '/bin', OLLAMA_TIMEOUT_MS_VERIFY: H3 }, models: ciLocal, envFileKeys: [] });
        assert.equal(rep2.OLLAMA_TIMEOUT_MS_VERIFY, '', '回放擋成空字串');
    });
});

describe('eval pipeline：answer_agree_rate 定義照舊；no_claim 題另報 verify_agree_rate（只報告）', () => {
    const SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'eval', 'lib', 'suitePipeline.js'), 'utf8');
    const sheet = { doc: { questions: [
        { question_text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？(A) $5$ (B) $6$', question_type: '單選', final_answer: '(A)' },
        { question_text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', question_type: '計算', answer_text: '$a = \\frac{10}{2} = 5$ m/s$^2$', final_answer: '5' }
    ] } };
    const row = (question_text, final_answer, question_type) => ({
        payload: { extract: { question_text, question_type }, verify: { compare: 'no_claim', final_answer, answer_form: question_type === '單選' ? 'option' : 'number' } }
    });

    test('verifyAgreeReport：answer_text 與 final_answer 兩種比法都報；沒有 no_claim 的題 → null', () => {
        const a = row('$\\log_{2} 8 + \\log_{2} 4$ 之值為何？(A) $5$ (B) $6$', '(A)', '單選');
        const b = row('質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', '5', '計算');
        const r = suitePipeline.verifyAgreeReport([a, b], sheet);
        assert.equal(r.n, 2);
        assert.deepEqual(r.by_answer_text, { agree: 2, rate: 1 });
        // 答案卷的 final_answer 是裸的「5」：比對器抽不到，那一題 uncertain
        assert.deepEqual(r.by_final_answer, { agree: 1, rate: 0.5 });
        assert.match(r.note, /只報告、不設門檻、不算進 answer_agree_rate/);
        assert.equal(suitePipeline.verifyAgreeReport([{ payload: { extract: {}, verify: { compare: 'agree' } } }], sheet), null);
    });

    test('answer_agree_rate 的分母只有 agree／disagree／uncertain（no_claim 不進、也不換成答案卷的比法）', () => {
        const start = SRC.indexOf('const compares = res.jq.map');
        const block = SRC.slice(start, SRC.indexOf('const answerAgreeRate', start));
        assert.ok(start > 0);
        assert.doesNotMatch(block, /no_claim|noClaim/, '分母的算法不碰 no_claim');
        assert.match(block, /\['agree', 'disagree', 'uncertain'\]\.includes\(c\)/);
        // measured.pipeline 只有原本的三個指標＋n（verify_agree_rate 不進門檻）
        assert.doesNotMatch(SRC.slice(SRC.indexOf('const measured = {'), SRC.indexOf('const measured = {') + 600), /verify/);
    });

    test('報表：有 verifyAgree 才印那一行', () => {
        const { markdownPipeline } = require('../../eval/lib/report2');
        if (typeof markdownPipeline !== 'function') return;   // 沒有匯出就跳過（報表格式另有測試）
        const res = {
            measured: { pipeline: { saved_rate: null, gate_pass_rate: 0.8, answer_agree_rate: null, n: 10 } },
            counts: { total: 10, saved: 0, needs_review: 10, rejected: 0, pending: 0 }, nodes: {}, reviewReasons: [],
            cost: { token_in: 0, token_out: 0, token_thinking: 0, token_out_billed: 0, cost_usd: 0, latency_ms: 0 },
            meta: { pdf: 'x.pdf', questionsExpected: 10, llmMode: 'replay', agentSources: {}, stateMachine: 's', db: 'd' },
            verifyAgree: { n: 10, by_answer_text: { agree: 9, rate: 0.9 }, by_final_answer: { agree: 5, rate: 0.5 }, note: suitePipeline.VERIFY_AGREE_NOTE }
        };
        assert.match(markdownPipeline(res), /verify_agree_rate（10 題 no_claim）：對答案卷 answer_text 0\.9.*對 final_answer 0\.5/);
        assert.doesNotMatch(markdownPipeline({ ...res, verifyAgree: undefined }), /verify_agree_rate/);
    });
});

describe('解答頁回填的答案與驗算交叉確認（answerKeyCheck／saveStopReason）', () => {
    const EX = { subject: '數學', question_type: '單選', question_text: '2. 求 f(2)。(1) 10 (2) 12 (3) 14', answer_text: '(3)', answer_src: 'answer_key' };

    test('回填＋no_claim：建議答案對得上 → 不停；對不上 → awaiting_approval（answer_key_unverified）；沒有建議答案 → 停', () => {
        const ok = { extract: EX, lint: { answer_text: '' }, verify: { compare: 'no_claim', suggested_answer: '14', final_answer: '14', answer_form: 'number' } };
        assert.deepEqual(runner.answerKeyCheck(ok), { compare: 'agree', key_answer: '(3)', suggested_answer: '14' });
        assert.equal(runner.saveStopReason(ok), null);

        const bad = { ...ok, verify: { compare: 'no_claim', suggested_answer: '12', final_answer: '12', answer_form: 'number' } };
        assert.deepEqual(runner.saveStopReason(bad), {
            reason: 'awaiting_approval', kind: 'answer_key_unverified', check: { compare: 'disagree', key_answer: '(3)', suggested_answer: '12' }
        });

        const none = { ...ok, verify: { compare: 'no_claim' } };
        assert.deepEqual(runner.saveStopReason(none), {
            reason: 'awaiting_approval', kind: 'answer_key_unverified', check: { compare: 'uncertain', key_answer: '(3)', suggested_answer: null }
        });
    });

    test('不適用的情形：不是回填的、verify 比過的（agree）、沒有跑 verify → 不補比', () => {
        const v = { compare: 'no_claim', suggested_answer: '12' };
        assert.equal(runner.answerKeyCheck({ extract: { ...EX, answer_src: undefined }, verify: v }), null);
        assert.equal(runner.answerKeyCheck({ extract: EX, verify: { compare: 'agree', final_answer: '14' } }), null);
        assert.equal(runner.answerKeyCheck({ extract: EX }), null);
        assert.equal(runner.saveStopReason({ extract: EX, lint: { answer_text: '' } }), null, '沒有 verify（例如證明題 skipped 以外的舊資料）照舊入庫');
        assert.equal(runner.answerKeyCheck(null), null);
    });

    test('交叉驗證與答案空的停等仍然優先', () => {
        const bad = { verify: { compare: 'no_claim', suggested_answer: '12' } };
        assert.equal(runner.saveStopReason({ ...bad, extract: { ...EX, extract_mode: 'ocr' } }).kind, 'cross_check');
        assert.equal(runner.saveStopReason({ ...bad, extract: { ...EX, answer_text: '' } }).kind, 'no_answer');
    });
});

describe('LaTeX：end_newline 的變體「單一反斜線＋換行＋end{env}」', () => {
    test('「3 & 4 \\⏎end{bmatrix}」→「3 & 4 \\\\ \\end{bmatrix}」；換列也壞的一併修；修完公式閘門過、冪等', () => {
        const r = repairText('$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\\nend{bmatrix}$');
        assert.equal(r.text, '$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\\\ \\end{bmatrix}$');
        assert.deepEqual(r.repairs, [{ rule: 'end_newline', count: 1 }]);
        assert.equal(formulaLint(r.text).ok, true, JSON.stringify(formulaLint(r.text)));
        assert.deepEqual(repairText(r.text).repairs, [], '冪等');

        const both = repairText('$\\begin{bmatrix} 1 & 2 \\ 3 & 4 \\\nend{bmatrix}$');
        assert.equal(both.text, '$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\\\ \\end{bmatrix}$');
        assert.deepEqual(both.repairs, [{ rule: 'end_newline', count: 1 }, { rule: 'row_break', count: 1 }]);

        // 兩個反斜線（換列完整、\end 斷掉）
        assert.equal(repairText('$\\begin{cases} x=1 \\\\ y=2 \\\\\nend{cases}$').text, '$\\begin{cases} x=1 \\\\ y=2 \\\\ \\end{cases}$');
    });

    test('三個以上反斜線分不出原意：不修', () => {
        const s = '$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\\\\\\nend{bmatrix}$';
        assert.deepEqual(repairText(s), { text: s, repairs: [] });
    });
});

describe('docs/local-mode.md 10.25：審查修正寫進文件', () => {
    test('第 0 點（Gemini 模式的邊界行為）、第 6 點（Owner 決定）、重錄前的逾時說明', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'local-mode.md'), 'utf8');
        const start = doc.indexOf('### 10.25 ');
        const end = doc.indexOf('\n### ', start + 10);
        const sec = doc.slice(start, end > 0 ? end : undefined);
        assert.doesNotMatch(sec, /Gemini 路徑一個字都沒動/);
        for (const s of ['Gemini 的拆題請求不變', 'verify_agree_rate', 'agentTimeoutRecordEnv', 'answerKeyCheck', '（ 3 ）1.', '沒有偵測到']) {
            assert.ok(sec.includes(s), `10.25 沒寫到 ${s}`);
        }
    });
});
