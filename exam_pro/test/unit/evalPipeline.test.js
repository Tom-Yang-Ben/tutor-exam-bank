// 管線 eval 骨架的單元測試（A-T14）：狀態機 shim、pipelineDriver、配對器、答案卷閘門。
//
// 這一支的定位很明確：**它測的是 eval 自己的零件，不是管線的品質**。
// 管線的品質要等 WS-A/B/C 合入才量得到；但如果 eval 的骨架本身有錯，
// 那時量出來的每一個數字都是錯的，而且會被抄進 README。
//
// 狀態機 shim 的部分刻意寫成「介面第 2.3 條的六條規則各一組斷言」：
// WS-A 的 pipeline/stateMachine.js 合入之後，同一支測試會自動改測真實作
// （stateMachineShim 會優先用真的），兩者行為不同就在這裡第一個轉紅。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sm = require('../../eval/lib/stateMachineShim');
const driver = require('../../eval/lib/pipelineDriver');
const { matchQuestions, scoreExtraction, jaccardSets, JACCARD_FLOOR } = require('../../eval/lib/pdfMatch');
const { loadSheet, validateSheet, sha256File } = require('../../eval/lib/pdfGolden');
const { promptHash } = require('../../eval/lib/legacyAdapter');

const SAMPLE_PDF = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'sample_exam.pdf');

describe('狀態機（interfaces-stage2.md 第 2.3 條的六條規則）', () => {
    const limits = sm.tables().DEFAULT_LIMITS;

    test('規則 1：終態或未知狀態不可推進', () => {
        for (const state of ['saved', 'needs_review', 'rejected', 'unknown']) {
            assert.throws(
                () => sm.transition({ state, retries: {}, outcome: { kind: 'pass' }, limits }),
                /不可推進/,
                state
            );
        }
    });

    test('規則 2：未知的 outcome.kind 丟錯', () => {
        assert.throws(
            () => sm.transition({ state: 'extracted', retries: {}, outcome: { kind: 'maybe' }, limits }),
            /未知的 outcome.kind/
        );
    });

    test('規則 3：預算用盡 + 非 pass/skipped → needs_review(budget_exceeded)', () => {
        const r = sm.transition({
            state: 'hashed', retries: {}, outcome: { kind: 'fail', reason: 'chapter_invalid' },
            limits: { ...limits, budgetLeft: 0 }
        });
        assert.equal(r.state, 'needs_review');
        assert.equal(r.review_reason, 'budget_exceeded');
    });

    test('規則 3 的例外：預算用盡但 pass／skipped 照常前進（那筆錢已經花了）', () => {
        for (const kind of ['pass', 'skipped']) {
            const r = sm.transition({ state: 'hashed', retries: {}, outcome: { kind }, limits: { ...limits, budgetLeft: -1 } });
            assert.equal(r.state, 'classified', kind);
            assert.equal(r.review_reason, null);
        }
    });

    test('規則 4：pass／skipped 依 NEXT_STATE 前進，review_reason 是 null 不是 undefined', () => {
        const NEXT = sm.tables().NEXT_STATE;
        for (const [from, to] of Object.entries(NEXT)) {
            const r = sm.transition({ state: from, retries: {}, outcome: { kind: 'pass', data: {} }, limits });
            assert.equal(r.state, to);
            assert.strictEqual(r.review_reason, null);
        }
    });

    test('規則 5：fail 在重試上限內留在原地並讓計數 +1', () => {
        const r = sm.transition({ state: 'hashed', retries: {}, outcome: { kind: 'fail', reason: 'chapter_invalid' }, limits });
        assert.equal(r.state, 'hashed');
        assert.deepEqual(r.retries, { classify: 1 });
        assert.equal(r.review_reason, null);
    });

    test('規則 5：fail 用盡重試 → needs_review，reason 依 REVIEW_REASON_FOR_FAIL', () => {
        const r = sm.transition({ state: 'hashed', retries: { classify: 2 }, outcome: { kind: 'fail', reason: 'chapter_invalid' }, limits });
        assert.equal(r.state, 'needs_review');
        assert.equal(r.review_reason, 'chapter_invalid');
    });

    test('規則 5：不在清單內的 reason 一律落到 awaiting_approval（全函式）', () => {
        const r = sm.transition({ state: 'verified', retries: {}, outcome: { kind: 'fail', reason: 'merge_into_requested' }, limits });
        assert.equal(r.state, 'needs_review');
        // dedup1 的 maxRetries 是 0，所以直接進複核
        assert.equal(r.review_reason, 'awaiting_approval');
    });

    test('規則 5：fail 且 reason=budget_exceeded 不重試', () => {
        const r = sm.transition({ state: 'hashed', retries: {}, outcome: { kind: 'fail', reason: 'budget_exceeded' }, limits });
        assert.equal(r.state, 'needs_review');
        assert.deepEqual(r.retries, {});
    });

    test('規則 6：error 用 `${node}:error` 分開計數', () => {
        const r = sm.transition({ state: 'hashed', retries: { classify: 1 }, outcome: { kind: 'error', errorClass: 'rate_limited' }, limits });
        assert.equal(r.state, 'hashed');
        assert.deepEqual(r.retries, { classify: 1, 'classify:error': 1 });
    });

    test('規則 6：error 用盡退避 → provider_error', () => {
        const r = sm.transition({
            state: 'hashed', retries: { 'classify:error': 3 },
            outcome: { kind: 'error', errorClass: 'timeout' }, limits
        });
        assert.equal(r.state, 'needs_review');
        assert.equal(r.review_reason, 'provider_error');
    });

    test('純函式契約：回傳的 retries 是新物件，不得就地修改入參', () => {
        const retries = { classify: 0 };
        const r = sm.transition({ state: 'hashed', retries, outcome: { kind: 'fail', reason: 'chapter_invalid' }, limits });
        assert.deepEqual(retries, { classify: 0 }, '入參被就地修改了');
        assert.notEqual(r.retries, retries);
    });

    test('性質：任何 outcome 序列都在有限步內落到終態（第 2.4 條「會停」）', () => {
        // 窮舉不了無限序列，改用最壞情況：每一步都回 fail 或 error，交替出現。
        const TERMINAL = sm.tables().TERMINAL_STATES;
        for (const seedKind of ['fail', 'error']) {
            let state = 'extracted';
            let retries = {};
            let steps = 0;
            const budget = 6 + (2 + 2 + 1) + 3 * 6;   // Σ maxRetries + Σ maxErrorRetries + 6
            while (!TERMINAL.includes(state)) {
                const outcome = (steps % 2 === 0)
                    ? { kind: seedKind, reason: 'chapter_invalid', errorClass: 'rate_limited' }
                    : { kind: 'fail', reason: 'formula_unparsable' };
                const r = sm.transition({ state, retries, outcome, limits });
                state = r.state;
                retries = r.retries;
                if (++steps > budget) break;
            }
            assert.ok(TERMINAL.includes(state), `${seedKind} 起頭的序列在 ${budget} 步內沒有落到終態（停在 ${state}）`);
        }
    });

    test('性質：state 只會前進或留在原地，不會回到更早的狀態', () => {
        const ORDER = ['extracted', 'hashed', 'classified', 'linted', 'verified', 'deduped', 'saved'];
        const rank = s => ORDER.indexOf(s);
        for (const state of ORDER.slice(0, 6)) {
            for (const outcome of [
                { kind: 'pass' }, { kind: 'skipped' },
                { kind: 'fail', reason: 'chapter_invalid' },
                { kind: 'error', errorClass: 'timeout' }
            ]) {
                const r = sm.transition({ state, retries: {}, outcome, limits });
                if (rank(r.state) >= 0) {
                    assert.ok(rank(r.state) >= rank(state), `${state} → ${r.state} 是倒退`);
                }
            }
        }
    });

    test('shim 會回報自己的來源（報表 meta 要記）', () => {
        assert.equal(typeof sm.source(), 'string');
        assert.equal(sm.isShim(), sm.source().includes('暫用'));
    });
});

describe('dedup0（確定性節點，現在就是真的）', () => {
    test('庫內命中 → fail(duplicate) 且 hit.scope=db', () => {
        const dbHashes = new Map();
        const jobHashes = new Map();
        const text = '設 $\\vec{a}=(1,2)$，求長度。';
        const { textHash } = require('../../eval/lib/stage2Shims');
        dbHashes.set(textHash(text), 128);
        const r = driver.runDedup0({ questionText: text, dbHashes, jobHashes, idx: 1 });
        assert.equal(r.kind, 'fail');
        assert.equal(r.reason, 'duplicate');
        assert.deepEqual(r.data.hit, { scope: 'db', question_id: 128 });
    });

    test('同 job 內較小 idx 命中 → hit.scope=job', () => {
        const dbHashes = new Map();
        const jobHashes = new Map();
        const text = '質量 $2$ kg 的物體受合力 $10$ N，求加速度。';
        assert.equal(driver.runDedup0({ questionText: text, dbHashes, jobHashes, idx: 1 }).kind, 'pass');
        const second = driver.runDedup0({ questionText: text, dbHashes, jobHashes, idx: 5 });
        assert.equal(second.kind, 'fail');
        assert.equal(second.data.hit.scope, 'job');
        assert.equal(second.data.hit.jq_id, 1);
    });

    test('空題幹 → schema_invalid（不是 duplicate）', () => {
        const r = driver.runDedup0({ questionText: '   ', dbHashes: new Map(), jobHashes: new Map(), idx: 1 });
        assert.equal(r.kind, 'fail');
        assert.equal(r.reason, 'schema_invalid');
    });
});

describe('classify 零成本閘門', () => {
    test('章節合法且信心達標 → pass 且 source=gate（不呼叫 LLM）', () => {
        const r = driver.gateClassify({ subject: '數學', chapter: '向量內積', chapter_confidence: 0.92 }, 0.8);
        assert.equal(r.kind, 'pass');
        assert.equal(r.data.source, 'gate');
        assert.equal(r.data.chapter, '向量內積');
    });

    test('信心不足 → fail(chapter_invalid)', () => {
        const r = driver.gateClassify({ subject: '數學', chapter: '向量內積', chapter_confidence: 0.5 }, 0.8);
        assert.equal(r.kind, 'fail');
        assert.equal(r.reason, 'chapter_invalid');
    });

    test('章節不在白名單 → fail，且 feedback 提到那個值', () => {
        const r = driver.gateClassify({ subject: '數學', chapter: '純量積', chapter_confidence: 0.99 }, 0.8);
        assert.equal(r.kind, 'fail');
        assert.ok(r.feedback.includes('純量積'), r.feedback);
    });

    test('跨科錯配（物理題掛數學章節）擋得下來', () => {
        const r = driver.gateClassify({ subject: '物理', chapter: '向量內積', chapter_confidence: 0.99 }, 0.8);
        assert.equal(r.kind, 'fail');
    });
});

describe('pdfMatch：拆出來的題 ↔ 答案卷的配對', () => {
    test('雜湊完全相同時一對一配上，method=hash', () => {
        const expected = [{ question_text: 'A 題', chapter: 'x' }, { question_text: 'B 題', chapter: 'y' }];
        const extracted = [{ question_text: 'B 題', chapter: 'y' }, { question_text: 'A 題', chapter: 'x' }];
        const r = matchQuestions(expected, extracted);
        assert.equal(r.pairs.length, 2);
        assert.ok(r.pairs.every(p => p.method === 'hash'));
        assert.equal(r.pairs[0].extractedIdx, 1);   // expected[0] ↔ extracted[1]
    });

    test('改了標點與空白仍靠雜湊配上（normalizeStem 的功勞）', () => {
        const expected = [{ question_text: '之值為何？\n(A) $5$　(B) $6$' }];
        const extracted = [{ question_text: '之值為何?\nA. 5  B. 6' }];
        const r = matchQuestions(expected, extracted);
        assert.equal(r.pairs.length, 1);
        assert.equal(r.pairs[0].method, 'hash');
    });

    test('差太多的題配不上，算成「沒拆到」而不是亂配', () => {
        const expected = [{ question_text: '求兩向量的內積。' }];
        const extracted = [{ question_text: '一輛汽車在彎道上轉彎，求最大速率。' }];
        const r = matchQuestions(expected, extracted);
        assert.equal(r.pairs.length, 0);
        assert.deepEqual(r.unmatchedExpected, [0]);
        assert.deepEqual(r.unmatchedExtracted, [0]);
    });

    test('一對一：同一個 extracted 不會被兩題共用', () => {
        const expected = [{ question_text: '同一題' }, { question_text: '同一題' }];
        const extracted = [{ question_text: '同一題' }];
        const r = matchQuestions(expected, extracted);
        assert.equal(r.pairs.length, 1);
        assert.equal(r.unmatchedExpected.length, 1);
    });

    test('extract_recall 的分母是答案卷題數；chapter_acc 的分母是配對成功數', () => {
        const expected = [
            { no: 1, question_text: 'A 題', chapter: '向量內積' },
            { no: 2, question_text: 'B 題', chapter: '直線運動' },
            { no: 3, question_text: 'C 題', chapter: '靜電學' }
        ];
        const extracted = [
            { question_text: 'A 題', chapter: '向量內積' },
            { question_text: 'B 題', chapter: '平面運動' }   // 章節錯
        ];
        const match = matchQuestions(expected, extracted);
        const s = scoreExtraction(expected, extracted, match);
        assert.equal(s.matched, 2);
        assert.equal(s.extract_recall, 2 / 3);
        assert.equal(s.chapter_acc, 1 / 2);
        assert.deepEqual(s.chapter_wrong, [{ no: 2, expect: '直線運動', got: '平面運動' }]);
    });

    test('答案卷為空時兩個比率都是 null（沒有答案卷就不該有分數）', () => {
        const s = scoreExtraction([], [], matchQuestions([], []));
        assert.equal(s.extract_recall, null);
        assert.equal(s.chapter_acc, null);
    });

    test('Jaccard 門檻是 0.5，且兩邊皆空時回 0（不是 1）', () => {
        assert.equal(JACCARD_FLOOR, 0.5);
        assert.equal(jaccardSets(new Set(), new Set()), 0);
        assert.equal(jaccardSets(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
        assert.equal(jaccardSets(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
    });
});

describe('答案卷（pdf_golden）的硬閘門', () => {
    test('公開樣卷載得起來，且 sha256 與 PDF 相符', () => {
        const sheet = loadSheet({ pdfPath: SAMPLE_PDF });
        assert.equal(sheet.sha256, sha256File(SAMPLE_PDF));
        assert.equal(sheet.doc.questions.length, 10);
        assert.equal(sheet.isPrivate, false);
    });

    test('sha256 對不上時擋下來（「換了 PDF 沒換答案卷」）', () => {
        const problems = validateSheet({ sha256: 'deadbeef', questions: [] }, 'cafebabe');
        assert.ok(problems.some(p => p.includes('sha256')), problems.join('；'));
    });

    test('章節不在白名單、answer_form 非法、final_answer 為空都擋得下來', () => {
        const problems = validateSheet({
            sha256: 'x', question_count: 1,
            questions: [{ no: 1, subject: '數學', chapter: '不存在', question_type: '單選', question_text: 'q', answer_text: 'a', answer_form: 'bogus', final_answer: '' }]
        }, 'x');
        assert.ok(problems.some(p => p.includes('不在')), 'chapter');
        assert.ok(problems.some(p => p.includes('answer_form')), 'answer_form');
        assert.ok(problems.some(p => p.includes('final_answer')), 'final_answer');
    });
});

describe('pipelineDriver 端到端', () => {
    // 兩段式，與 answerGolden.test.js 同一個道理。
    // agents/extract.js 合入之後，這一支會真的呼叫 LLM（replay 模式）；
    // WS-B 的 cassette 目前是對**他們自己那份 6 題樣卷**錄的，裁決 S2-15 要求改對
    // eval/fixtures/sample_exam.pdf 重錄。在重錄之前這裡一定 replay miss——
    // 那不是 driver 壞掉，硬斷言只會得到一片與本次改動無關的紅燈。
    //
    // 因此：跑得起來就硬斷言；replay miss 就印出實際的 agent／key 並 skip，
    // cassette 重錄之後自動轉回硬斷言。**其他任何失敗一律照舊紅燈。**
    /** @returns {Promise<{res:object, skip:string|null}>} */
    async function runOnce(opts) {
        const sheet = loadSheet({ pdfPath: SAMPLE_PDF });
        const res = await driver.runPipeline({ pdfPath: SAMPLE_PDF, sheet, ...opts });
        if (!res.ok && (res.replayMisses || []).length) {
            const m = res.replayMisses[0];
            return { res, skip: `replay 找不到 cassette（agent=${m.agent} key=${(m.key || '').slice(0, 12)}…）：` +
                `WS-B 的 cassette 尚未對 eval/fixtures/sample_exam.pdf 重錄（裁決 S2-15）。` };
        }
        return { res, skip: null };
    }

    test('10 題全部走到終態，事件的形狀與 job_events 一致', async (t) => {
        const { res, skip } = await runOnce();
        if (skip) { t.skip(skip); return; }
        assert.equal(res.ok, true, res.reason);
        assert.equal(res.jq.length, 10);

        const TERMINAL = sm.tables().TERMINAL_STATES;
        for (const row of res.jq) {
            assert.ok(TERMINAL.includes(row.state), `idx=${row.idx} 停在 ${row.state}`);
        }
        for (const e of res.events) {
            assert.ok(['pass', 'fail', 'error', 'skipped'].includes(e.outcome), e.outcome);
            assert.equal(typeof e.latency_ms, 'number');
            assert.ok('token_in' in e && 'cost_usd' in e && 'error_class' in e);
        }
    });

    test('stub 狀態一定被標示出來（避免 oracle 的假數字被當真）', async () => {
        const { res } = await runOnce();
        const caveats = driver.stubCaveats(res);
        // agents/ 目錄尚未存在時，extract 必為 oracle stub；WS-B 合入後這個斷言會自動變成
        // 「有真 agent 就不是 oracle」——兩種情況本測試都成立。
        assert.equal(caveats.fakeExtract, res.agentSources.extract === 'oracle-stub');
        if (caveats.fakeExtract) {
            assert.ok(caveats.notes.some(n => n.includes('n/a')), '沒有提醒要印 n/a');
        }
    });

    test('summarizePipeline 的四個計數相加 = 題數（對齊第 6.2 條的 counts）', async () => {
        const { res } = await runOnce();
        const s = driver.summarizePipeline(res);
        assert.equal(s.saved + s.needsReview + s.rejected + s.pending, res.jq.length);
    });

    test('replay miss 會被辨識出來，不會混在一般的 provider_error 裡', async () => {
        // 這一條在兩種狀態下都成立，所以不 skip：
        // 有 miss 時 replayMisses 非空且 reason 講得出是哪一支 cassette；
        // cassette 重錄之後 miss 為空、ok 為 true。
        const { res } = await runOnce();
        if (res.ok) {
            assert.deepEqual(res.replayMisses, []);
            return;
        }
        assert.ok(res.replayMisses.length > 0, `沒跑完但不是 replay miss：${res.reason}`);
        assert.ok(res.reason.includes('cassette'), res.reason);
        for (const m of res.replayMisses) {
            assert.equal(typeof m.agent, 'string');
            assert.equal(typeof m.key, 'string');
        }
    });

    test('同一份 PDF 跑第二次時，dbHashes 會讓每一題都被 dedup0 攔下', async (t) => {
        const dbHashes = new Map();
        const first = await runOnce({ dbHashes });
        if (first.skip) { t.skip(first.skip); return; }
        const { res: second } = await runOnce({ dbHashes });
        const s1 = driver.summarizePipeline(first.res);
        const s = driver.summarizePipeline(second);
        assert.equal(s.saved, 0, '重傳同一份 PDF 不該再入庫任何題');
        assert.equal(s.needsReview, 10);
        // 第一輪**已入庫**的題，第二輪全部被 dedup0 攔下（duplicate）；第一輪本來就進複核的題
        //（例如 verify 的 answer_mismatch）不在 dbHashes 裡，第二輪會重走一次並得到同樣的原因——
        // 那不是 dedup0 失效，所以只斷言 duplicate 的數量 = 第一輪入庫數。
        const dup = s.reviewReasons.filter(r => r === 'duplicate').length;
        assert.equal(dup, s1.saved, `duplicate ${dup} 筆 ≠ 第一輪入庫 ${s1.saved} 筆：${s.reviewReasons.join('、')}`);
        assert.ok(s1.saved > 0, '第一輪至少要有入庫的題，這個測試才有鑑別力');
    });
});

describe('legacyAdapter 的 prompt_hash', () => {
    test('只雜湊長樣板字串（prompt 本體），不雜湊整個檔案', () => {
        const withPrompt = 'const x = 1;\nconst p = `' + 'A'.repeat(250) + '`;\n';
        const r = promptHash(withPrompt);
        assert.equal(r.basis, 'template-literals');
        // 改動 prompt 以外的程式碼不該讓雜湊變動
        const r2 = promptHash('const y = 2;\nconst p = `' + 'A'.repeat(250) + '`;\n');
        assert.equal(r.hash, r2.hash);
        // 改動 prompt 一定要讓雜湊變動
        const r3 = promptHash('const x = 1;\nconst p = `' + 'B'.repeat(250) + '`;\n');
        assert.notEqual(r.hash, r3.hash);
    });

    test('沒有長樣板字串時退回整檔雜湊，並如實標示 basis', () => {
        const r = promptHash('const a = 1;');
        assert.equal(r.basis, 'whole-file');
    });
});

describe('thresholds 的 suite 通用比對（A-T14 的 ratchet）', () => {
    const th = require('../../eval/lib/thresholds');

    test('門檻全是 null = 尚未建立基準線 → 只報告不擋', () => {
        // 這一條是實際踩過的坑：thresholds.json 先擺好 {accuracy:null, macro_f1:null} 佔位，
        // 結果被當成「門檻已存在」，對一輪 n/a 的量測報失敗——而 n/a 在骨架階段是常態。
        const r = th.compareSuite({ classify: { classify: { accuracy: null, macro_f1: null } } }, 'classify', { classify: null });
        assert.deepEqual(r.failures, []);
        assert.equal(r.skipped.length, 1);
    });

    test('門檻有數字卻量不到 = 失敗（否則 cassette 被誤刪會表現成全綠）', () => {
        const r = th.compareSuite({ classify: { classify: { accuracy: 0.8 } } }, 'classify', { classify: null });
        assert.equal(r.failures.length, 1);
    });

    test('達標與未達標', () => {
        const table = { classify: { classify: { accuracy: 0.8, macro_f1: null } } };
        assert.equal(th.compareSuite(table, 'classify', { classify: { accuracy: 0.9 } }).failures.length, 0);
        assert.equal(th.compareSuite(table, 'classify', { classify: { accuracy: 0.7 } }).failures.length, 1);
    });

    test('pipeline 的門檻只放「越高越好」的三個指標', () => {
        // needs_review 的比率越低越好，放進 ratchet 會變成「只准更多題進複核」。
        assert.deepEqual(th.SUITE_METRICS.pipeline.metrics, ['saved_rate', 'gate_pass_rate', 'answer_agree_rate']);
    });

    test('未知的 suite 丟錯，不靜默略過', () => {
        assert.throws(() => th.compareSuite({}, 'formula', {}), /未知的 suite/);
    });
});
