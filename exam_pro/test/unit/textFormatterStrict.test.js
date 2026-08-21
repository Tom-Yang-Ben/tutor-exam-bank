// textFormatterStrict 單元測試（A-T4 / WS-C）
//
// 兩件事：
//   1. 對照測試——證明「埋事件」沒有改到任何既有輸出。
//      基準是 test/fixtures/textFormatter.pre-a-t4.js（動工前的逐字副本，凍結），
//      對一份混合語料逐筆比對 JSON.stringify(docx 物件樹)，必須逐位元相同。
//   2. parseLatexStrict 的六種事件各有案例，並釘住 at 的位置與 ok 的定義。
//
// 執行：npm test（不連 DB、不連 Gemini、不需 secrets）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    buildParagraphComponents, parseLatexToMath, parseLatexStrict, STRICT_EVENT_KINDS,
} = require('../../utils/textFormatter');

const before = require('../fixtures/textFormatter.pre-a-t4');
const fixture = require('../../eval/fixtures/questions.public.json');

// ───────────────────────── 測試輔助 ─────────────────────────

/** docx 物件樹只有 rootKey / root 兩種鍵，JSON.stringify 就是穩定的逐位元表示 */
const ser = (nodes) => JSON.stringify(nodes);

/** 對照語料：fixture 全部題幹與答案 + 既有 29 項測試的輸入 + fix_formulas 的型樣 + 邊界值 */
function corpus() {
    const out = [];
    for (const q of fixture.questions) {
        out.push(q.question_text);
        out.push(q.answer_text);
    }
    out.push(
        // test/unit/textFormatter.test.js 的輸入（29 項契約）
        String.raw`\frac{1}{2}`, String.raw`\dfrac{a}{b}`, String.raw`\tfrac{a}{b}`,
        'x^2', 'a_n', 'x_1^2', 'x^2_1',
        String.raw`\sqrt{2}`, String.raw`\sqrt[3]{8}`,
        String.raw`\sum_{n=1}^{5} n`, String.raw`\int_0^1 x`,
        String.raw`\lim_{x \to 0} x`, String.raw`\frac{\frac{1}{2}}{3}`,
        String.raw`\theta`, String.raw`\pi`, String.raw`\Omega`,
        String.raw`\times`, String.raw`\leq`, String.raw`\neq`, String.raw`\infty`,
        String.raw`\sin`, String.raw`\log`, String.raw`\vec{v}`, String.raw`\foobar`,
        '圓 $x^2$ 半徑', '設半徑為 $r$ 則面積為 $\\pi r^2$ 平方公分',
        '推導：$$E=mc^2$$', String.raw`值為 \(x^2\) 單位`, String.raw`值為 \[x^2\] 單位`,
        '面積 x^2 平方', '第一行\n第二行', '下列敘述何者正確？請說明理由。',
        '公式 $x^2 沒有收尾', String.raw`\frac{1}{2`, String.raw`$\sqrt{2$`, String.raw`\frac{}{}`,
        '題目😀內容結尾',
        '不等式 $|2x - 3| < 5$ 的解為下列何者？\n(A) $-1 < x < 4$　(B) $x < -1$ 或 $x > 4$',
        // fix_formulas.js 的舊轉換器殘留型樣
        '$\\frac{T}{2}$^{[SUPER:R|3}]=K',
        '[FRAC:1|2] 與 [SUPER:x|2] 與 [SUB:a|n] 與 [SQRT:2]',
        '$X$^{2}', '$X$_{n}', '$\\frac{1}{2$}',
        // 邊界
        '', null, undefined, '   ', '\r\n混了 CRLF\r\n第三行', '{}', '答案：___',
        '速度單位為 m/s$^2$', '$\\vecc{a}$', '5 \\times 3 = 15',
    );
    return out;
}

// ═════════════════════ 1. 逐位元對照 ═════════════════════

describe('A-T4 對照測試 — 埋事件後既有輸出逐位元不變', () => {
    test('buildParagraphComponents 對整份語料的輸出與動工前完全相同', () => {
        const cases = corpus();
        let checked = 0;
        for (const input of cases) {
            const expected = ser(before.buildParagraphComponents(input));
            const actual = ser(buildParagraphComponents(input));
            assert.equal(actual, expected, `輸入 ${JSON.stringify(input)} 的輸出與動工前不同`);
            checked++;
        }
        assert.ok(checked >= 100, `語料至少要有 100 筆，實際 ${checked}`);
    });

    test('buildParagraphComponents 帶 textOptions 時同樣不變', () => {
        const opts = { bold: true, size: 24 };
        for (const input of corpus()) {
            assert.equal(
                ser(buildParagraphComponents(input, opts)),
                ser(before.buildParagraphComponents(input, opts)),
                `輸入 ${JSON.stringify(input)}（帶 textOptions）的輸出與動工前不同`
            );
        }
    });

    test('parseLatexToMath 對整份語料的輸出與動工前完全相同', () => {
        for (const input of corpus()) {
            if (typeof input !== 'string') continue;   // 舊版對 null 會丟例外，不在契約內
            assert.equal(
                ser(parseLatexToMath(input)),
                ser(before.parseLatexToMath(input)),
                `輸入 ${JSON.stringify(input)} 的 parseLatexToMath 輸出與動工前不同`
            );
        }
    });

    test('傳了 diag 也不會改變輸出（事件只收集）', () => {
        for (const input of corpus()) {
            const withDiag = ser(buildParagraphComponents(input, {}, []));
            assert.equal(withDiag, ser(before.buildParagraphComponents(input, {})),
                `輸入 ${JSON.stringify(input)} 在收集事件時輸出被改動了`);
        }
    });

    test('parseLatexStrict().children 與 buildParagraphComponents() 是同一份輸出', () => {
        for (const input of corpus()) {
            assert.equal(
                ser(parseLatexStrict(input).children),
                ser(buildParagraphComponents(input)),
                `輸入 ${JSON.stringify(input)} 的 children 與主函式不一致`
            );
        }
    });
});

// ═════════════════════ 2. 六種事件 ═════════════════════

/** 只取 kind，方便斷言 */
const kindsOf = (str) => parseLatexStrict(str).events.map(e => e.kind);

describe('parseLatexStrict — 六種事件各有案例', () => {
    test('unknown_command：未知指令降級成純文字', () => {
        const r = parseLatexStrict('$\\vecc{a}$');
        assert.deepEqual(r.events.map(e => e.kind), ['unknown_command']);
        assert.equal(r.events[0].at, 1, 'at 應指向反斜線的位置');
        assert.equal(r.ok, false);
    });

    test('missing_rbrace：群組缺右大括號', () => {
        const r = parseLatexStrict('$\\frac{1}{2$');
        assert.ok(r.events.some(e => e.kind === 'missing_rbrace'));
        assert.equal(r.ok, false);
    });

    test('bare_script：^ 後面沒有參數', () => {
        const r = parseLatexStrict('$F^$');
        assert.deepEqual(r.events.map(e => e.kind), ['bare_script']);
        assert.equal(r.events[0].at, 2, "at 應指向 ^ 的位置");
    });

    test('bare_script：純文字裡沒有底的底線（填空題的 ___）', () => {
        const r = parseLatexStrict('答案：___');
        assert.deepEqual(r.events.map(e => e.kind), ['bare_script', 'bare_script', 'bare_script']);
        assert.deepEqual(r.events.map(e => e.at), [3, 4, 5]);
    });

    test('empty_fallback：$…$ 內解析不出任何元件', () => {
        // 只有一個右大括號：parseSequence 立刻停在 rbrace，回傳空陣列
        assert.deepEqual(kindsOf('$}$'), ['empty_fallback']);
    });

    test('parser_error / tokenize_error 是 catch 分支，正常輸入不會出現', () => {
        // 這兩個 kind 對應解析器丟例外的路徑；本專案的 parser 不主動 throw，
        // 因此這裡只釘住「它們仍在凍結清單內」，行為由 formulaLint 的 catch 兜底。
        assert.ok(STRICT_EVENT_KINDS.includes('parser_error'));
        assert.ok(STRICT_EVENT_KINDS.includes('tokenize_error'));
    });

    test('STRICT_EVENT_KINDS 就是介面凍結的六個值', () => {
        assert.deepEqual([...STRICT_EVENT_KINDS].sort(), [
            'bare_script', 'empty_fallback', 'missing_rbrace',
            'parser_error', 'tokenize_error', 'unknown_command',
        ]);
    });
});

describe('parseLatexStrict — ok 的定義與健壯性', () => {
    test('ok === (events.length === 0)', () => {
        for (const input of corpus()) {
            const r = parseLatexStrict(input);
            assert.equal(r.ok, r.events.length === 0, `輸入 ${JSON.stringify(input)}`);
        }
    });

    test('乾淨的題目沒有任何事件', () => {
        const r = parseLatexStrict('$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$');
        assert.deepEqual(r.events, []);
        assert.equal(r.ok, true);
    });

    test('非字串輸入不得拋例外', () => {
        for (const v of [null, undefined, 0, 123, {}, []]) {
            assert.doesNotThrow(() => parseLatexStrict(v));
            assert.equal(parseLatexStrict(v).ok, true);
        }
    });

    test('events 依 at 由小到大排序', () => {
        const r = parseLatexStrict('$\\vecc{a}$ 與 $\\relvel{b}$ 與 答案：__');
        const ats = r.events.map(e => e.at);
        assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
        assert.ok(r.events.length >= 4);
    });

    test('emoji 被剝掉之後，at 仍指回原字串的位置', () => {
        const src = '題目😀 $\\vecc{a}$';
        const r = parseLatexStrict(src);
        assert.deepEqual(r.events.map(e => e.kind), ['unknown_command']);
        assert.equal(src[r.events[0].at], '\\', `at=${r.events[0].at} 應落在反斜線上`);
    });

    test('CRLF 之後的行，at 仍指回原字串的位置', () => {
        const src = '第一行\r\n第二行 $\\vecc{a}$';
        const r = parseLatexStrict(src);
        assert.equal(src[r.events[0].at], '\\');
    });
});

// ═════════════════════ 3. 對公開 fixture 的整體行為 ═════════════════════

describe('parseLatexStrict — 對 eval/fixtures/questions.public.json', () => {
    const broken = fixture.questions.filter(q => q.latex_broken);
    const clean = fixture.questions.filter(q => !q.latex_broken);

    test('10 題刻意寫壞的 LaTeX 全部被抓到，且 kind 與 broken_kind 一致', () => {
        assert.equal(broken.length, 10);
        for (const q of broken) {
            const r = parseLatexStrict(q.question_text);
            assert.equal(r.ok, false, `#${q.id} 應該被判為有事件`);
            assert.ok(r.events.some(e => e.kind === q.broken_kind),
                `#${q.id} 標的是 ${q.broken_kind}，實際事件為 ${JSON.stringify(r.events)}`);
        }
    });

    test('其餘 50 題（含 m/s$^2$ 這種寫法）一個事件都不該有', () => {
        for (const q of clean) {
            const r = parseLatexStrict(q.question_text);
            assert.deepEqual(r.events, [], `#${q.id} 不該有事件：${q.question_text.slice(0, 60)}`);
        }
    });

    test('對照副本確實是動工前的版本（沒有 parseLatexStrict）', () => {
        assert.equal(typeof before.parseLatexStrict, 'undefined');
        assert.equal(path.basename(require.resolve('../fixtures/textFormatter.pre-a-t4')),
            'textFormatter.pre-a-t4.js');
    });
});
