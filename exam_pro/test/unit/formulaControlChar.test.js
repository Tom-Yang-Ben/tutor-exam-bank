// 公式閘門的 control_char 規則（Owner 第五輪 L-1 核准，2026-09-27，dec/r6-gates）
//
// 題目（題幹＋選項＝question_text、答案＝answer_text）裡還有換行以外的控制字元，formulaLint 就回 error
//（rule 名 control_char，會永久進 job_events.detail 與 report:jobs），agents/lint.js 因此送第三層公式重寫。
// 詳解（verify 的 steps_summary）不經公式閘門：jobRunner.buildSolutionFields 與回填腳本改成不寫。
//
// 換行的例外：U+000A，以及 Windows 換行 \r\n 的歸位；單獨的歸位照擋（\rho 被 JSON 吃掉＝歸位＋ho）。
//
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formulaLint, ISSUE_RULES, findControlChars, MAX_PER_RULE } = require('../../utils/formulaLint');
const lintAgent = require('../../agents/lint');
const { buildSolutionFields } = require('../../workers/jobRunner');
const { unusableReason, planBackfill } = require('../../scripts/backfill_solutions');
const fixture = require('../../eval/fixtures/questions.public.json');

const rulesOf = (text) => formulaLint(text).issues.filter(i => i.sev === 'error').map(i => i.rule);

describe('formulaLint：control_char（換行以外的控制字元）', () => {
    test('規則名登記在 ISSUE_RULES 的最後（凍結清單只能往後加）', () => {
        assert.equal(ISSUE_RULES[ISSUE_RULES.length - 1], 'control_char');
        assert.equal(ISSUE_RULES.filter(r => r === 'control_char').length, 1);
    });

    test('JSON 吃掉反斜線的五種字元：退格、定位、換頁、歸位（單獨）都是 error；位置指向控制字元', () => {
        const cases = {
            '退格＋eta（\\beta）': '$\beta = 30^{\\circ}$',
            '定位＋imes（\\times）': '$3\times 4$',
            '換頁＋rac（\\frac）': '$\frac{1}{2}$',
            '歸位＋ho（\\rho）': '密度 $\rho$',
            '換頁＋dg（救不回來的度數）': '$240^\fdg$'
        };
        for (const [label, text] of Object.entries(cases)) {
            const r = formulaLint(text);
            assert.equal(r.ok, false, label);
            const cc = r.issues.filter(i => i.rule === 'control_char');
            assert.equal(cc.length, 1, label);
            assert.equal(cc[0].sev, 'error', label);
            assert.match(text[cc[0].at], /[\x00-\x1F\x7F]/, label);
        }
    });

    test('其他 C0 控制字元與 DEL 也擋（NUL、U+001B、U+007F）', () => {
        for (const ch of ['\u0000', '\u001B', '\u007F', '\u000B']) {
            assert.deepEqual(rulesOf(`甲${ch}乙`), ['control_char'], JSON.stringify(ch));
        }
    });

    test('換行不擋：\\n、Windows 換行 \\r\\n（選項分行、段落）', () => {
        for (const text of ['下列何者正確？\n(A) 1\n(B) 2', '第一段\r\n第二段\r\n', '$$\\begin{array}{c} a \\\\\n b \\end{array}$$']) {
            const r = formulaLint(text);
            assert.ok(!r.issues.some(i => i.rule === 'control_char'), JSON.stringify(text));
        }
    });

    test('同一條規則最多回報 MAX_PER_RULE 筆', () => {
        const r = formulaLint('\b'.repeat(20) + '甲');
        assert.equal(r.issues.filter(i => i.rule === 'control_char').length, MAX_PER_RULE);
    });

    test('findControlChars：與 formulaLint 同一個判準、回傳位置與字元', () => {
        assert.deepEqual(findControlChars('a\tb\r\nc\rd'), [{ at: 1, ch: '\t' }, { at: 6, ch: '\r' }]);
        assert.deepEqual(findControlChars(''), []);
        assert.deepEqual(findControlChars(null), []);
    });

    test('不誤觸：fixture 62 題的題幹與答案一題都沒有 control_char', () => {
        for (const q of fixture.questions) {
            for (const t of [q.question_text, q.answer_text]) {
                assert.ok(!formulaLint(t || '').issues.some(i => i.rule === 'control_char'), q.id);
            }
        }
    });
});

describe('agents/lint：control_char 送第三層公式重寫', () => {
    function makeCtx(gen) {
        const calls = [];
        return {
            calls,
            ctx: {
                llm: { async generateJson(opts) { calls.push(opts); return gen(opts); } },
                logger: { info() {}, warn() {}, error() {} },
                config: { models: { extract: 'gemini:gemini-3.5-flash' } },
                signal: undefined
            }
        };
    }

    test('答案裡的「換頁＋dg」：閘門擋下 → 呼叫 LLM，issues 與 cacheKeyParts 帶 control_char；改好就通過', async () => {
        const { ctx, calls } = makeCtx(() => ({
            data: { question_text: '求 $\\sin 240^{\\circ}$。', answer_text: '$240^{\\circ}$ 的正弦為 $-\\frac{\\sqrt{3}}{2}$', notes: '' },
            usage: {}, latencyMs: 1, raw: {}
        }));
        const out = await lintAgent.run(ctx, {
            question_text: '求 $\\sin 240^{\\circ}$。',
            answer_text: '$240^\fdg$ 的正弦為 $-\\frac{\\sqrt{3}}{2}$'
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].cacheKeyParts.issues, ['control_char']);
        assert.match(calls[0].parts[0].text, /\[error\] control_char @\d+：答案：含控制字元（換頁 U\+000C）/);
        assert.equal(out.kind, 'pass');
        assert.equal(out.data.rewritten, true);
    });

    test('重寫後仍帶控制字元 → fail(formula_unparsable)，閘門不因模型出手就放水', async () => {
        const { ctx } = makeCtx(() => ({ data: { question_text: '$3\times 4$', answer_text: '12' }, usage: {}, latencyMs: 1, raw: {} }));
        const out = await lintAgent.run(ctx, { question_text: '$3\times 4$', answer_text: '12' });
        assert.equal(out.kind, 'fail');
        assert.equal(out.reason, 'formula_unparsable');
        assert.match(out.feedback, /control_char/);
    });
});

describe('詳解（verify 的 steps_summary）：含控制字元就不寫', () => {
    const verified = (steps) => ({
        verify: { skipped: false, final_answer: '5', answer_form: 'number', steps_summary: steps, claimed_answer: '5', compare: 'agree', samples: 1 }
    });

    test('buildSolutionFields：控制字元 → 兩欄 NULL；只有換行（含 \\r\\n）照寫', () => {
        const none = { solution_text: null, solution_src: null };
        assert.deepEqual(buildSolutionFields(verified('由 $\frac{3}{4}$ 得')), none);
        assert.deepEqual(buildSolutionFields(verified('$240^\fdg$')), none);
        assert.equal(buildSolutionFields(verified('步驟一\r\n步驟二')).solution_src, 'verify');
        assert.equal(buildSolutionFields(verified('步驟一\n$\\frac{3}{4}$')).solution_src, 'verify');
    });

    test('回填腳本：原因記成 control_char，與 buildSolutionFields 一致', () => {
        assert.equal(unusableReason(verified('$3\times 4$')), 'control_char');
        const plan = planBackfill([{
            question_id: 7, jq_id: 1, payload: verified('$3\times 4$'),
            question_text: '', answer_text: '', solution_text: null, solution_src: null, solution_cleared_at: null
        }]);
        assert.equal(plan.skipped.control_char, 1);
        assert.deepEqual(plan.updates, []);
    });
});
