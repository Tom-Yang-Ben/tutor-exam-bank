// formulaFix / formulaLint 單元測試（A-T4 / WS-C）
//
// 契約：docs/interfaces-stage2.md 第 4.4 條
//   formulaFix(text)  → { text, applied }   applied 是套用順序
//   formulaLint(text) → { ok, issues }      ok === issues.every(i => i.sev !== 'error')
//
// 這裡刻意「不」require fix_formulas.js：那支在載入時就 require('./config/db')，
// 缺 DATABASE_URL 會直接丟錯（config/db.js:27），npm test 必須不連 DB。
// 兩者輸出相同這件事改用「逐條規則的期望值表」釘住——期望值是拿真的 transform()
// 對同一份語料跑出來的（140 筆，0 差異），寫死在下面。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formulaFix, FIX_RULES } = require('../../utils/formulaFix');
const { formulaLint, ISSUE_RULES } = require('../../utils/formulaLint');
const fixture = require('../../eval/fixtures/questions.public.json');

// ═════════════════════ formulaFix ═════════════════════

describe('formulaFix — 逐條確定性規則（與 fix_formulas.js 的 transform 同結果）', () => {
    const table = [
        { name: 'special_fix：已知毀損字串的精準修正',
          input: String.raw`$\frac{T}{2}$^{[SUPER:R|3}]=K`,
          expect: String.raw`$\frac{T^2}{R^3}=K$`, applied: ['special_fix'] },
        { name: 'legacy_frac：[FRAC:a|b] → \\frac{a}{b}',
          input: '[FRAC:1|2]', expect: String.raw`\frac{1}{2}`, applied: ['legacy_frac'] },
        { name: 'legacy_super：[SUPER:a|b] → a^{b}',
          input: '[SUPER:x|2]', expect: 'x^{2}', applied: ['legacy_super'] },
        { name: 'legacy_sub：[SUB:a|b] → a_{b}',
          input: '[SUB:a|n]', expect: 'a_{n}', applied: ['legacy_sub'] },
        { name: 'legacy_sqrt：[SQRT:a] → \\sqrt{a}（右界可能是 ] 或 }）',
          input: '[SQRT:2]', expect: String.raw`\sqrt{2}`, applied: ['legacy_sqrt'] },
        { name: 'legacy_sqrt：右界是 } 的變體',
          input: '[SQRT:2}', expect: String.raw`\sqrt{2}`, applied: ['legacy_sqrt'] },
        { name: 'dollar_script_swap：$X$^{n} → $X^{n}$',
          input: '$X$^{2}', expect: '$X^{2}$', applied: ['dollar_script_swap'] },
        { name: 'dollar_script_swap：下標同理',
          input: '$X$_{n}', expect: '$X_{n}$', applied: ['dollar_script_swap'] },
        { name: 'dollar_rbrace_swap：…$} → …}$',
          input: String.raw`\frac{1}{2$}`, expect: String.raw`\frac{1}{2}$`, applied: ['dollar_rbrace_swap'] },
        { name: 'unicode_to_latex：$…$ 之外的 Unicode 數學符號',
          input: '速度 5 × 3 ≤ 20', expect: String.raw`速度 5 $\times$ 3 $\leq$ 20`, applied: ['unicode_to_latex'] },
        { name: 'bare_greek：$…$ 之外的裸希臘指令',
          input: String.raw`角度 \theta 與 \pi/2`, expect: String.raw`角度 $\theta$ 與 $\pi/2$`, applied: ['bare_greek'] },
        { name: 'bare_greek：其後緊接 ^ 的不包（留給轉換器處理）',
          input: String.raw`設 \alpha 為銳角，且 \beta^2 = 1`,
          expect: String.raw`設 $\alpha$ 為銳角，且 \beta^2 = 1`, applied: ['bare_greek'] },
        { name: '已在 $…$ 內的希臘字母不會被再包一層',
          input: String.raw`$\theta$ 已在公式內 × 外面的乘號`,
          expect: String.raw`$\theta$ 已在公式內 $\times$ 外面的乘號`, applied: ['unicode_to_latex'] },
    ];

    for (const c of table) {
        test(c.name, () => {
            const r = formulaFix(c.input);
            assert.equal(r.text, c.expect);
            assert.deepEqual(r.applied, c.applied);
        });
    }

    test('沒有可修的東西時 applied 為空、text 一字不動', () => {
        const clean = String.raw`已知 $\log_{2} 8 = 3$，求 $\log_{2} 4$。`;
        assert.deepEqual(formulaFix(clean), { text: clean, applied: [] });
    });

    test('非字串／空字串不得拋例外', () => {
        assert.deepEqual(formulaFix(null), { text: '', applied: [] });
        assert.deepEqual(formulaFix(undefined), { text: '', applied: [] });
        assert.deepEqual(formulaFix(''), { text: '', applied: [] });
        assert.deepEqual(formulaFix(123), { text: '', applied: [] });
    });

    test('冪等：修過一次之後再修不會再變（規則不互相打架）', () => {
        for (const q of fixture.questions) {
            for (const field of ['question_text', 'answer_text']) {
                const once = formulaFix(q[field]);
                const twice = formulaFix(once.text);
                assert.equal(twice.text, once.text, `#${q.id} ${field} 修第二次又變了`);
            }
        }
    });

    test('對公開 fixture 不會誤改（60 題全部零套用）', () => {
        for (const q of fixture.questions) {
            assert.deepEqual(formulaFix(q.question_text).applied, [], `#${q.id} 題幹被動到了`);
        }
    });

    test('FIX_RULES 是凍結的規則名清單，順序即套用順序', () => {
        assert.deepEqual([...FIX_RULES], [
            'special_fix', 'legacy_frac', 'legacy_super', 'legacy_sub', 'legacy_sqrt',
            'dollar_script_swap', 'dollar_rbrace_swap', 'unicode_to_latex', 'bare_greek',
        ]);
    });
});

// ═════════════════════ formulaLint ═════════════════════

/** 只取某個 sev 的 rule 名 */
const rulesOf = (text, sev) => formulaLint(text).issues.filter(i => !sev || i.sev === sev).map(i => i.rule);

describe('formulaLint — error 級規則（會讓 Word 匯出降級或內容失真）', () => {
    test('dollar_unbalanced：$ 數量是奇數', () => {
        const r = formulaLint('公式 $x^2 沒有收尾');
        assert.ok(r.issues.some(i => i.rule === 'dollar_unbalanced' && i.sev === 'error'));
        assert.equal(r.ok, false);
    });

    test('brace_unbalanced：{ 與 } 數量不同', () => {
        assert.ok(rulesOf(String.raw`$\frac{1}{2$`, 'error').includes('brace_unbalanced'));
    });

    test('legacy_marker：舊轉換器殘留標記', () => {
        assert.ok(rulesOf('[FRAC:1|2] 之值', 'error').includes('legacy_marker'));
    });

    test('bare_frac_sqrt：frac / sqrt 少了反斜線', () => {
        assert.ok(rulesOf('求 frac{1}{2} 之值', 'error').includes('bare_frac_sqrt'));
        assert.ok(rulesOf('求 sqrt{2} 之值', 'error').includes('bare_frac_sqrt'));
        assert.ok(!rulesOf(String.raw`求 $\frac{1}{2}$ 之值`, 'error').includes('bare_frac_sqrt'));
    });

    test('bare_ell：ell 少了反斜線', () => {
        assert.ok(rulesOf('長度 ell 為何', 'error').includes('bare_ell'));
    });

    test('dollar_before_script：$X$^{n} 這種錯位', () => {
        assert.ok(rulesOf('$X$^{2}', 'error').includes('dollar_before_script'));
    });

    test('dollar_before_rbrace：$} 這種錯位', () => {
        assert.ok(rulesOf(String.raw`\frac{1}{2$}`, 'error').includes('dollar_before_rbrace'));
    });

    test('parseLatexStrict 的事件：unknown_command / missing_rbrace / bare_script', () => {
        assert.ok(rulesOf(String.raw`$\vecc{a}$ 與 $\vec{b}$`, 'error').includes('unknown_command'));
        assert.ok(rulesOf(String.raw`$\frac{10}{2$`, 'error').includes('missing_rbrace'));
        assert.ok(rulesOf('$F^$ 的大小', 'error').includes('bare_script'));
    });

    test('每個 issue 都有 sev / rule / at / msg 四個鍵，且 rule 在凍結清單內', () => {
        const r = formulaLint(String.raw`$\vecc{a}$ 與 frac{1}{2} 與 [SUB:a|n] 與 $X$^{2}`);
        assert.ok(r.issues.length > 0);
        for (const i of r.issues) {
            assert.deepEqual(Object.keys(i).sort(), ['at', 'msg', 'rule', 'sev']);
            assert.ok(['error', 'warn'].includes(i.sev));
            assert.ok(ISSUE_RULES.includes(i.rule), `未登記的 rule：${i.rule}`);
            assert.ok(Number.isInteger(i.at) && i.at >= 0);
            assert.ok(typeof i.msg === 'string' && i.msg.length > 0);
        }
    });

    test('issues 依 at 排序', () => {
        const r = formulaLint(String.raw`frac{1}{2} 再來 $\vecc{a}$`);
        const ats = r.issues.map(i => i.at);
        assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
    });
});

describe('formulaLint — warn 級規則（內容一字不差，只是寫法不漂亮）', () => {
    test('slash_fraction：斜線當分數（單位 m/s 也會中，所以只能是 warn）', () => {
        const r = formulaLint('加速度為 10 m/s 之值');
        assert.ok(r.issues.some(i => i.rule === 'slash_fraction' && i.sev === 'warn'));
        assert.equal(r.ok, true, 'warn 不擋閘門');
    });

    test('unicode_math：含 Unicode 數學符號', () => {
        const r = formulaLint('速度為 5 × 3');
        assert.ok(r.issues.some(i => i.rule === 'unicode_math' && i.sev === 'warn'));
        assert.equal(r.ok, true);
    });

    test('latex_without_dollar：有 LaTeX 或上下標卻沒包 $', () => {
        const r = formulaLint(String.raw`面積為 \pi r^2 平方公分`);
        assert.ok(r.issues.some(i => i.rule === 'latex_without_dollar' && i.sev === 'warn'));
    });

    test('bare_script_text：填空題的 ___ 是 warn 不是 error', () => {
        const r = formulaLint('答案：___');
        assert.ok(r.issues.some(i => i.rule === 'bare_script_text' && i.sev === 'warn'));
        assert.equal(r.ok, true, '填空題的底線不該擋住入庫');
    });

    test('$…$ 內的空上標是 error、純文字裡的底線是 warn', () => {
        assert.equal(formulaLint('$F^$').ok, false);
        assert.equal(formulaLint('求 __ 之值').ok, true);
    });
});

describe('formulaLint — ok 的定義與健壯性', () => {
    test('ok === issues 內沒有 error', () => {
        const cases = ['答案：___', '$F^$', '10 m/s', String.raw`$\vecc{a}$`, '純中文'];
        for (const c of cases) {
            const r = formulaLint(c);
            assert.equal(r.ok, r.issues.every(i => i.sev !== 'error'), c);
        }
    });

    test('空字串／非字串一律 ok 且無 issue（空題幹由 validateQuestionFields 管）', () => {
        for (const v of [null, undefined, '', '   ', 123, {}]) {
            assert.deepEqual(formulaLint(v), { ok: true, issues: [] });
        }
    });

    test('同一條規則最多回報 5 筆（避免 payload 被撐爆）', () => {
        const r = formulaLint('答案：__________');
        assert.equal(r.issues.filter(i => i.rule === 'bare_script_text').length, 5);
    });

    test('對公開 fixture：10 題壞的全被判 error、其餘 50 題零 error', () => {
        let broken = 0;
        for (const q of fixture.questions) {
            const r = formulaLint(q.question_text);
            if (q.latex_broken) {
                assert.equal(r.ok, false, `#${q.id} 應該被閘門擋下`);
                broken++;
            } else {
                assert.equal(r.ok, true,
                    `#${q.id} 不該被擋：${JSON.stringify(r.issues.filter(i => i.sev === 'error'))}`);
            }
        }
        assert.equal(broken, 10);
    });

    test('formulaFix 之後再 lint：可自動修好的型樣會從 error 變成 ok', () => {
        const dirty = '$X$^{2} 與 [FRAC:1|2]';
        assert.equal(formulaLint(dirty).ok, false);
        assert.equal(formulaLint(formulaFix(dirty).text).ok, true);
    });
});
