// ─────────────────────────────────────────────────────────────
// 文字詳解的單元測試（階段 5 WS-A；docs/interfaces-stage5.md 第 4.1 條第 5、6 項；DEC-017、缺口 G05）
//
// 四塊，全部不連 DB、不呼叫 LLM：
//   1. workers/jobRunner.buildSolutionFields —— save 節點與回填腳本共用的判定：
//      verify 判定一致（payload.verify.compare = 'agree'）且 steps_summary 非空才寫。
//   2. controllers/questionController 的 normalizeSolutionText —— POST／PUT 的閘門。
//   3. scripts/backfill_solutions.js 的 planBackfill／parseArgs —— 不覆寫已有詳解、
//      題幹或答案被改過的題不回填、--limit。
//   4. services/wordService 的 edition —— 學生版不附答案、詳解版把詳解轉成 Word 原生方程式。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildSolutionFields, buildSaveFields } = require('../../workers/jobRunner');
const { planBackfill, parseArgs, unusableReason, isEditedSinceSave } = require('../../scripts/backfill_solutions');
const wordService = require('../../services/wordService');
const { documentXml } = require('../e2e/lib/docx');

const originalUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x_test';
const { normalizeSolutionText, SOLUTION_MAX_LEN } = require('../../controllers/questionController')._internals;
if (originalUrl === undefined) delete process.env.DATABASE_URL;

/** agents/verify.js pass 時 runner 存進 payload.verify 的形狀（mergePayload 原樣存 data）。 */
function verified(extra = {}) {
    return {
        skipped: false, final_answer: '5', answer_form: 'number',
        steps_summary: '由畢氏定理 $\\sqrt{3^2+4^2}=5$。', claimed_answer: '5', compare: 'agree', samples: 1, ...extra
    };
}

// ═════════════ 1. buildSolutionFields ═════════════

describe('jobRunner.buildSolutionFields（save 節點寫詳解的條件）', () => {
    test('一致且摘要非空 → solution_src = verify，摘要 trim 後寫入', () => {
        assert.deepEqual(buildSolutionFields({ verify: verified({ steps_summary: '  步驟一\n步驟二  ' }) }),
            { solution_text: '步驟一\n步驟二', solution_src: 'verify' });
    });

    test('其他情況一律兩欄 NULL', () => {
        const none = { solution_text: null, solution_src: null };
        const cases = {
            '沒跑過 verify': {},
            'payload 是 null': null,
            '證明題 skipped': { verify: { skipped: true } },
            'uncertain': { verify: verified({ compare: 'uncertain' }) },
            'disagree': { verify: verified({ compare: 'disagree' }) },
            '摘要空白': { verify: verified({ steps_summary: '   ' }) },
            '摘要不是字串': { verify: verified({ steps_summary: null }) },
            '超過 4000 字（不截斷）': { verify: verified({ steps_summary: '解'.repeat(4001) }) }
        };
        for (const [label, payload] of Object.entries(cases)) {
            assert.deepEqual(buildSolutionFields(payload), none, label);
        }
    });

    test('剛好 4000 字（code point）合法', () => {
        assert.equal(buildSolutionFields({ verify: verified({ steps_summary: '解'.repeat(4000) }) }).solution_src, 'verify');
        assert.equal(buildSolutionFields({ verify: verified({ steps_summary: '𠮷'.repeat(4000) }) }).solution_src, 'verify');
    });

    test('判定看 compare 不看 kind：fail 後併進 payload 的 feedback 不影響', () => {
        const p = { verify: { ...verified({ compare: 'disagree' }), feedback: '驗證模型算出 6' } };
        assert.equal(buildSolutionFields(p).solution_text, null);
    });
});

// ═════════════ 2. normalizeSolutionText ═════════════

describe('questionController.normalizeSolutionText（POST／PUT 的詳解閘門）', () => {
    test('null／undefined／空白 → null；字串 trim', () => {
        assert.deepEqual(normalizeSolutionText(null), { ok: true, value: null });
        assert.deepEqual(normalizeSolutionText(undefined), { ok: true, value: null });
        assert.deepEqual(normalizeSolutionText('  \n '), { ok: true, value: null });
        assert.deepEqual(normalizeSolutionText('  $x=1$ \n'), { ok: true, value: '$x=1$' });
    });

    test('非字串與超過 4000 字回錯誤訊息', () => {
        assert.equal(SOLUTION_MAX_LEN, 4000);
        assert.deepEqual(normalizeSolutionText(5), { ok: false, error: '詳解必須是文字或 null。' });
        assert.deepEqual(normalizeSolutionText(['x']), { ok: false, error: '詳解必須是文字或 null。' });
        assert.deepEqual(normalizeSolutionText('解'.repeat(4001)), { ok: false, error: '詳解最多 4000 字。' });
        assert.equal(normalizeSolutionText('解'.repeat(4000)).ok, true);
    });
});

// ═════════════ 3. 回填腳本 ═════════════

describe('scripts/backfill_solutions.js — 參數', () => {
    test('--dry-run、--limit N、--test、--report', () => {
        assert.deepEqual(parseArgs([]), { dryRun: false, limit: null, test: false, report: null, help: false });
        assert.deepEqual(parseArgs(['--dry-run', '--limit', '20', '--test', '--report', 'x.json']),
            { dryRun: true, limit: 20, test: true, report: 'x.json', help: false });
    });

    test('--limit 只收正整數；未知參數直接拒絕（不猜）', () => {
        for (const bad of [['--limit'], ['--limit', '0'], ['--limit', '-3'], ['--limit', '1.5'], ['--limit', 'abc']]) {
            assert.throws(() => parseArgs(bad), /--limit 後面要接正整數/, bad.join(' '));
        }
        assert.throws(() => parseArgs(['--force']), /未知的參數/);
        assert.throws(() => parseArgs(['--report']), /--report 後面要接檔案路徑/);
    });
});

describe('scripts/backfill_solutions.js — planBackfill', () => {
    /** 一列 job_questions × questions；questions 的現值預設等於 save 節點當初寫進去的值。 */
    function row(questionId, jqId, { verify = verified(), current = {}, stem, answer } = {}) {
        const payload = {
            extract: {
                subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
                question_text: stem ?? `自製題 ${questionId}：求 $|(3,4)|$。`, answer_text: answer ?? '5'
            },
            ...(verify ? { verify } : {})
        };
        const f = buildSaveFields(payload);
        return {
            question_id: questionId, jq_id: jqId, payload,
            question_text: f.question_text.trim(), answer_text: f.answer_text.trim() || '略',
            solution_text: null, solution_src: null, ...current
        };
    }

    test('可回填的題進 updates；已有詳解的依來源分類略過（teacher 絕不覆寫）', () => {
        const plan = planBackfill([
            row(1, 10),
            row(2, 11, { current: { solution_text: '老師寫的', solution_src: 'teacher' } }),
            row(3, 12, { current: { solution_text: '驗算', solution_src: 'verify' } }),
            row(4, 13, { current: { solution_text: 'AI', solution_src: 'ai' } })
        ]);
        assert.deepEqual(plan.updates, [{ question_id: 1, jq_id: 10, solution_text: '由畢氏定理 $\\sqrt{3^2+4^2}=5$。' }]);
        assert.equal(plan.scanned, 4);
        assert.equal(plan.skipped.has_teacher, 1);
        assert.equal(plan.skipped.has_verify, 1);
        assert.equal(plan.skipped.has_ai, 1);
        assert.equal(plan.remaining, 0);
    });

    test('不可用的原因逐一分類', () => {
        const plan = planBackfill([
            row(1, 1, { verify: null }),
            row(2, 2, { verify: { skipped: true } }),
            row(3, 3, { verify: verified({ compare: 'disagree' }) }),
            row(4, 4, { verify: verified({ compare: 'uncertain' }) }),
            row(5, 5, { verify: verified({ steps_summary: '' }) }),
            row(6, 6, { verify: verified({ steps_summary: '解'.repeat(4001) }) })
        ]);
        assert.deepEqual(plan.updates, []);
        const { no_verify, verify_skipped, not_agree, empty_steps, too_long } = plan.skipped;
        assert.deepEqual({ no_verify, verify_skipped, not_agree, empty_steps, too_long },
            { no_verify: 1, verify_skipped: 1, not_agree: 2, empty_steps: 1, too_long: 1 });
    });

    // 〔stage5 審查修正 S5-41〕
    test('老師清空過詳解（solution_cleared_at 非 NULL）→ cleared，不回填', () => {
        const plan = planBackfill([
            row(1, 1, { current: { solution_cleared_at: new Date('2026-09-24T10:00:00Z') } }),
            row(2, 2, { current: { solution_cleared_at: null } }),
            row(3, 3)
        ]);
        assert.deepEqual(plan.updates.map(u => u.question_id), [2, 3]);
        assert.equal(plan.skipped.cleared, 1);
    });

    test('入庫後題幹或答案被改過 → edited，不回填（那份摘要解的是改之前的題）', () => {
        const plan = planBackfill([
            row(1, 1, { current: { question_text: '老師修正過的題幹' } }),
            row(2, 2, { current: { answer_text: '6' } }),
            row(3, 3, { current: { question_text: '  自製題 3：求 $|(3,4)|$。 ' } })   // 只差前後空白＝沒改
        ]);
        assert.deepEqual(plan.updates.map(u => u.question_id), [3]);
        assert.equal(plan.skipped.edited, 2);
    });

    test('isEditedSinceSave：空答案在入庫時落成「略」，比對也要用同一條規則', () => {
        const payload = { extract: { question_text: '題', answer_text: '' } };
        assert.equal(isEditedSinceSave(payload, { question_text: '題', answer_text: '略' }), false);
        assert.equal(isEditedSinceSave(payload, { question_text: '題', answer_text: '' }), true);
    });

    test('一題對到多列 job_questions：取 id 最小、且可用的那一列', () => {
        const plan = planBackfill([
            row(7, 30, { verify: verified({ compare: 'disagree' }) }),
            row(7, 31, { verify: verified({ steps_summary: '第二列的摘要' }) }),
            row(7, 32, { verify: verified({ steps_summary: '第三列的摘要' }) })
        ]);
        assert.deepEqual(plan.updates, [{ question_id: 7, jq_id: 31, solution_text: '第二列的摘要' }]);
        assert.equal(plan.scanned, 1);
    });

    test('--limit：只排 N 題，其餘可回填的算進 remaining（下一輪再跑）', () => {
        const rows = [1, 2, 3, 4, 5].map(i => row(i, i));
        const plan = planBackfill(rows, { limit: 2 });
        assert.deepEqual(plan.updates.map(u => u.question_id), [1, 2]);
        assert.equal(plan.remaining, 3);
    });

    test('unusableReason 與 buildSolutionFields 一致：有詳解時不該被問', () => {
        assert.equal(unusableReason({}), 'no_verify');
        assert.equal(unusableReason({ verify: { skipped: true } }), 'verify_skipped');
        assert.equal(unusableReason({ verify: verified({ compare: 'uncertain' }) }), 'not_agree');
        assert.equal(unusableReason({ verify: verified({ steps_summary: ' ' }) }), 'empty_steps');
    });

    test('腳本不 require 任何 LLM 模組（契約：不呼叫 LLM）', () => {
        const src = require('node:fs').readFileSync(require.resolve('../../scripts/backfill_solutions'), 'utf8');
        assert.ok(!/require\(['"][^'"]*services\/llm/.test(src), '不得 require services/llm');
        assert.ok(!/generateJson|generateText/.test(src), '不得呼叫 generateJson／generateText');
    });
});

// ═════════════ 4. Word 匯出版本 ═════════════

describe('wordService — edition（第 4.1 條第 6 項）', () => {
    const QUESTIONS = [
        { id: 1, question_type: '計算', difficulty: 2, question_text: '[單測] 求 $|(3,4)|$。', answer_text: '$5$',
            solution_text: '由畢氏定理 $\\sqrt{3^2+4^2}=5$。' },
        { id: 2, question_type: '填空', difficulty: 1, question_text: '[單測] 求 $1+1$。', answer_text: '$2$', solution_text: null }
    ];
    const silent = { warn() { }, error() { } };

    test('parseEdition：沒給＝standard；三個合法值；其他一律 null', () => {
        assert.deepEqual([...wordService.EDITIONS], ['standard', 'student', 'solution']);
        assert.equal(wordService.parseEdition(undefined), 'standard');
        assert.equal(wordService.parseEdition(null), 'standard');
        for (const v of ['standard', 'student', 'solution']) assert.equal(wordService.parseEdition(v), v);
        for (const v of ['', 'teacher', 'correction', 'STUDENT', 1, {}]) assert.equal(wordService.parseEdition(v), null, String(v));
    });

    test('generateExamPaperDocx 收到不支援的版本直接丟錯（controller 會先回 400，這裡是第二道）', async () => {
        await assert.rejects(wordService.generateExamPaperDocx('t', 's', QUESTIONS, { edition: 'teacher', logger: silent }),
            /不支援的 Word 匯出版本/);
    });

    test('standard（預設）：有參考答案區、沒有詳解', async () => {
        const xml = documentXml(await wordService.generateExamPaperDocx('單測卷', '學生', QUESTIONS, { logger: silent }));
        assert.ok(xml.includes('參考答案區'));
        assert.ok(!xml.includes('詳解：'));
        assert.ok(!xml.includes(wordService.NO_SOLUTION_TEXT));
    });

    test('student：沒有答案區、沒有分頁，題目仍在', async () => {
        const xml = documentXml(await wordService.generateExamPaperDocx('單測卷', '學生', QUESTIONS, { edition: 'student', logger: silent }));
        assert.ok(xml.includes('[單測] 求'), '題目要在');
        assert.ok(!xml.includes('參考答案'), '學生版不得有答案區');
        assert.ok(!xml.includes('題答案：'), '學生版不得有任何一題的答案');
        assert.ok(!xml.includes('w:type="page"'), '沒有答案區就不需要分頁');
    });

    test('solution：答案之後接詳解，詳解的公式是 <m:oMath>（根號 m:rad）；沒詳解的題標一行說明', async () => {
        const xml = documentXml(await wordService.generateExamPaperDocx('單測卷', '學生', QUESTIONS, { edition: 'solution', logger: silent }));
        assert.ok(xml.includes('參考答案與詳解'));
        assert.ok(xml.includes('詳解：'));
        assert.ok(xml.includes('由畢氏定理'));
        assert.ok(xml.includes('<m:rad>'), '詳解裡的 \\sqrt 沒有轉成 Word 原生方程式');
        assert.ok(xml.includes(wordService.NO_SOLUTION_TEXT), '沒有詳解的題要標示');
        // 第 1 題的答案在詳解之前
        assert.ok(xml.indexOf('第 1 題答案：') < xml.indexOf('詳解：'));
    });

    // 〔stage5 整合〕WS-A 審查 low：模型寫、沒人看過的詳解印出來要看得出來源
    test('solution：verify／ai 來源在「詳解：」後面加註未經老師審閱；teacher 與沒有來源的不加；其他版本不出現', async () => {
        const note = wordService.UNREVIEWED_SOLUTION_NOTE;
        assert.equal(note, '（AI 驗算摘要，未經老師審閱）');
        const qs = [
            { id: 1, question_type: '計算', difficulty: 2, question_text: '[單測] 甲', answer_text: '$5$', solution_text: '驗算摘要甲 $\\sqrt{25}$', solution_src: 'verify' },
            { id: 2, question_type: '計算', difficulty: 2, question_text: '[單測] 乙', answer_text: '$6$', solution_text: 'AI 詳解乙', solution_src: 'ai' },
            { id: 3, question_type: '計算', difficulty: 2, question_text: '[單測] 丙', answer_text: '$7$', solution_text: '老師詳解丙', solution_src: 'teacher' },
            { id: 4, question_type: '計算', difficulty: 2, question_text: '[單測] 丁', answer_text: '$8$', solution_text: '來源不明丁' }
        ];
        const xml = documentXml(await wordService.generateExamPaperDocx('單測卷', '學生', qs, { edition: 'solution', logger: silent }));
        assert.equal(xml.split(note).length - 1, 2, '只有 verify 與 ai 兩題加註');
        const at = s => xml.indexOf(s);
        assert.ok(at('第 1 題答案：') < at(note) && at(note) < at('驗算摘要甲'), '註記在「詳解：」之後、詳解內容之前');
        assert.ok(xml.slice(at('第 2 題答案：'), at('AI 詳解乙')).includes(note));
        assert.ok(!xml.slice(at('第 3 題答案：'), at('老師詳解丙')).includes(note), '老師撰寫的不加註');
        assert.ok(!xml.slice(at('第 4 題答案：'), at('來源不明丁')).includes(note));
        assert.ok(xml.includes('<m:rad>'), '加註不影響詳解裡的公式轉換');

        for (const edition of ['standard', 'student']) {
            const other = documentXml(await wordService.generateExamPaperDocx('單測卷', '學生', qs, { edition, logger: silent }));
            assert.ok(!other.includes(note), edition);
        }
    });
});
